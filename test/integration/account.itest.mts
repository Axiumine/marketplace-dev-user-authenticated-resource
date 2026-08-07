import { encryptPassword } from '@axiumine/koa-utils/lib/encryptPassword'
import { compareHashAsync } from '@axiumine/koa-utils/lib/hash'
import * as dotenv from 'dotenv'
import type { Server } from 'http'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

dotenv.config()

import {
	bootServer,
	db,
	drainAndClose,
	gql,
	PASSWORD_HASH,
	readUser,
	seedUser,
	withSession,
	withSignedInUser
} from './harness.mts'

/****************************************************************************************
 * The account surface — `userPersonalDataUpdate` and `userUpdatePwd` — against the real
 * collection validator and a real bcrypt.
 *
 * Both are things the unit suite proves against a mocked `User`, and both are places where a
 * mock has no opinion about the only question that matters:
 *
 *   - the profile save is built around fields being **absent** rather than null, and only the
 *     `$jsonSchema` can say whether a `null` landline really would take the write down;
 *   - the password change is built around bcrypt at cost factor 14, and only a real hash can
 *     say whether what was stored is what the customer typed.
 ****************************************************************************************/

let httpServer: Server

/**
 * One real bcrypt hash, shared by every password test that needs a *correct* current password.
 *
 * Hashing at `SALT_ROUNDS = 14` costs well over a second, so this is hoisted deliberately: the
 * tests below spend their hashes on the assertions that are about hashing, not on their fixtures.
 */
const CURRENT_PWD = 'vecchiaPassword1!'
let currentHash = ''

beforeAll(async () => {
	;({ httpServer } = await bootServer())
	currentHash = await encryptPassword(CURRENT_PWD)
})

afterAll(() => drainAndClose(httpServer))

describe('userPersonalDataUpdate (real $jsonSchema)', () => {
	const save = (body: string) => `mutation { userPersonalDataUpdate(personalData: ${body}) }`

	const FULL = `{
		firstName: "Giulia"
		lastName: "Rossi"
		birth: { date: "1990-06-15" }
		contacts: { mobile: "3331234567", landline: "0354567890", email: "giulia@marketplace.invalid" }
	}`

	it('writes the whole sub-document, and MongoDB accepts it', async () => {
		const user = await withSignedInUser()

		try {
			const { status, json } = await gql(save(FULL), user.headers)

			expect(status).toBe(200)
			expect(json.errors).toBeUndefined()
			expect(json.data).toEqual({ userPersonalDataUpdate: true })

			const stored = await readUser(user._id)
			expect(stored?.personalData).toEqual({
				firstName: 'Giulia',
				lastName: 'Rossi',
				// graphql-scalars' Date parses `YYYY-MM-DD` to midnight UTC, and the driver stores it as a
				// BSON date — which is what `bsonType: 'date'` demands and what a string would have failed.
				birth: { date: new Date('1990-06-15T00:00:00.000Z') },
				contacts: { mobile: '3331234567', landline: '0354567890', email: 'giulia@marketplace.invalid' }
			})
		} finally {
			await user.cleanup()
		}
	})

	/*
	 * The replacement semantics, proved by a save that follows a full one. Every optional box comes
	 * back empty and the stored sub-document is left holding two keys — not four with two nulls, and
	 * not the previous values merged under the new ones.
	 *
	 * This is the assertion the whole `...(x === undefined ? {} : { x })` idiom in the validators
	 * exists for, and it can only be made here: a mocked `updateOne` records whatever document it is
	 * handed, including one full of nulls, and reports success.
	 */
	it('drops the optional fields the customer cleared, rather than storing nulls', async () => {
		const user = await withSignedInUser()

		try {
			await gql(save(FULL), user.headers)

			const cleared = `{
				firstName: "  Giulia  "
				lastName: "Bianchi"
				birth: null
				contacts: { mobile: "", landline: null, email: "   " }
			}`
			const { json } = await gql(save(cleared), user.headers)

			expect(json.errors).toBeUndefined()

			const stored = await readUser(user._id)
			// `contacts` is absent entirely rather than `{}`: an empty object is legal against the
			// validator but means nothing, and it would make "has this customer given us a number?" two
			// questions instead of one.
			expect(stored?.personalData).toEqual({ firstName: 'Giulia', lastName: 'Bianchi' })
		} finally {
			await user.cleanup()
		}
	})

	/*
	 * ⚠️ The reason the normalisation above is not merely tidy. This is the write the service would
	 * make if `optionalText` returned `null` instead of `undefined` — sent through the raw driver
	 * because no code path here can produce it any more — and MongoDB refuses it outright.
	 *
	 * Error code 121 is `DocumentValidationFailure`, which `tryCatchRethrow` classifies as neither a
	 * duplicate key nor a `[Validator]` message: it reaches the customer as `Internal Server Error`,
	 * with the offending path buried in `errInfo`. A cleared landline box would take an otherwise
	 * perfect profile save down with it and report a broken server.
	 */
	it('is refused by the database when a cleared contact is written as null', async () => {
		const user = await seedUser()
		const write = (contacts: Record<string, unknown>) =>
			db()
				.collection('user')
				.updateOne({ _id: user._id }, { $set: { personalData: { firstName: 'Giulia', lastName: 'Rossi', contacts } } })

		// The shape the service does produce is accepted...
		await expect(write({ mobile: '3331234567' })).resolves.toMatchObject({ modifiedCount: 1 })

		// ...and the one it deliberately never produces is not.
		await expect(write({ mobile: null })).rejects.toMatchObject({ code: 121 })

		const stored = await readUser(user._id)
		expect(stored?.personalData?.contacts).toEqual({ mobile: '3331234567' })
	})

	it('answers 200 and true when the profile is re-saved unchanged', async () => {
		const user = await withSignedInUser()

		try {
			await gql(save(FULL), user.headers)
			// Byte-identical to the write above, so MongoDB really does report `modifiedCount: 0` here —
			// which is why the write path checks `matchedCount`. Reading the other counter would tell a
			// customer their save failed while the database holds exactly what they asked for.
			const { status, json } = await gql(save(FULL), user.headers)

			expect(status).toBe(200)
			expect(json.data).toEqual({ userPersonalDataUpdate: true })
		} finally {
			await user.cleanup()
		}
	})

	it('rejects an underage birth date and leaves the stored profile alone', async () => {
		const user = await withSignedInUser()

		try {
			await gql(save(FULL), user.headers)

			const today = new Date()
			const yesterday = new Date(Date.UTC(today.getUTCFullYear() - 18, today.getUTCMonth(), today.getUTCDate() + 1))
			const underage = `{ firstName: "Marco", lastName: "Verdi", birth: { date: "${yesterday.toISOString().slice(0, 10)}" } }`

			const { status, json } = await gql(save(underage), user.headers)

			expect(status).toBe(400)
			expect(json.errors?.[0]?.message).toBe('Bad Request')
			expect(json.errors?.[0]?.extensions?.description).toBe('birth.date: you must be of age (at least 18)')

			// The 400 is raised before the write, so the profile saved a moment ago is untouched.
			const stored = await readUser(user._id)
			expect(stored?.personalData?.firstName).toBe('Giulia')
		} finally {
			await user.cleanup()
		}
	})

	// A name of four spaces is empty, not four characters long — the trim runs before the length test.
	it('rejects a blank required name with the field named in the description', async () => {
		const user = await withSignedInUser()

		try {
			const { status, json } = await gql(save('{ firstName: "    ", lastName: "Rossi" }'), user.headers)

			expect(status).toBe(400)
			expect(json.errors?.[0]?.extensions?.description).toBe('firstName: field required')
			expect((await readUser(user._id))?.personalData).toBeUndefined()
		} finally {
			await user.cleanup()
		}
	})
})

describe('userUpdatePwd (real bcrypt at cost 14)', () => {
	const change = (passwordOld: string, passwordNew: string) =>
		`mutation { userUpdatePwd(passwordOld: "${passwordOld}", passwordNew: "${passwordNew}") }`

	it('replaces the stored hash with one the new password verifies against', async () => {
		const user = await withSignedInUser({ login: { email: `pwd-${Date.now()}@marketplace.invalid`, password: currentHash } })
		const passwordNew = 'nuovaPassword2!'

		try {
			const { status, json } = await gql(change(CURRENT_PWD, passwordNew), user.headers)

			expect(status).toBe(200)
			expect(json.data).toEqual({ userUpdatePwd: true })

			const stored = (await readUser(user._id))?.login.password as string
			// A bcrypt hash is salted, so this is never the same string twice even for the same input —
			// which is exactly why the write path may check `modifiedCount`.
			expect(stored).not.toBe(currentHash)
			expect(stored).toHaveLength(60)
			expect(await compareHashAsync(passwordNew, stored)).toBe(true)
			expect(await compareHashAsync(CURRENT_PWD, stored)).toBe(false)
		} finally {
			await user.cleanup()
		}
	})

	it('answers 401 for a wrong current password and leaves the hash in place', async () => {
		const user = await withSignedInUser({ login: { email: `pwd-${Date.now()}-b@marketplace.invalid`, password: currentHash } })

		try {
			const { status, json } = await gql(change('passwordSbagliata1!', 'nuovaPassword2!'), user.headers)

			expect(status).toBe(401)
			expect(json.errors?.[0]?.message).toBe('Unauthorized')

			expect((await readUser(user._id))?.login.password).toBe(currentHash)
		} finally {
			await user.cleanup()
		}
	})

	/*
	 * Rejected before anything is hashed, which is the point: a bcrypt round at cost 14 is over a
	 * second of CPU, and this request is almost always an accident. The seed carries the placeholder
	 * hash rather than the real one precisely because nothing here ever compares it.
	 */
	it('refuses a new password equal to the old one, without spending a hash', async () => {
		const user = await withSignedInUser()

		try {
			const { status, json } = await gql(change('stessaPassword1!', 'stessaPassword1!'), user.headers)

			expect(status).toBe(400)
			expect(json.errors?.[0]?.extensions?.description).toBe('passwordNew must differ from passwordOld')
			expect((await readUser(user._id))?.login.password).toBe(PASSWORD_HASH)
		} finally {
			await user.cleanup()
		}
	})

	it('enforces the platform password bounds on the new password', async () => {
		const user = await withSignedInUser()

		try {
			const short = await gql(change(CURRENT_PWD, 'corta1!'), user.headers)
			expect(short.status).toBe(400)
			expect(short.json.errors?.[0]?.extensions?.description).toBe('Password is too short')

			// 73 characters. bcrypt hashes at most 72 bytes and silently ignores the rest, so without the
			// upper bound this would be stored as a prefix of what the customer typed.
			const long = await gql(change(CURRENT_PWD, 'l'.repeat(73)), user.headers)
			expect(long.status).toBe(400)
			expect(long.json.errors?.[0]?.extensions?.description).toBe('Password is too long')

			expect((await readUser(user._id))?.login.password).toBe(PASSWORD_HASH)
		} finally {
			await user.cleanup()
		}
	})

	// A disabled customer keeps a live access token until it expires, and must not be able to change
	// the password on the way out. Checked before the comparison, so this costs no hash either.
	it('answers 401 for a disabled account', async () => {
		const user = await withSignedInUser({ disabled: true })

		try {
			const { status, json } = await gql(change(CURRENT_PWD, 'nuovaPassword2!'), user.headers)

			expect(status).toBe(401)
			expect(json.errors?.[0]?.message).toBe('Unauthorized')
			expect((await readUser(user._id))?.login.password).toBe(PASSWORD_HASH)
		} finally {
			await user.cleanup()
		}
	})

	it('answers 401 for a soft-deleted account', async () => {
		const user = await withSignedInUser({ deleted: new Date() })

		try {
			const { status } = await gql(change(CURRENT_PWD, 'nuovaPassword2!'), user.headers)

			expect(status).toBe(401)
		} finally {
			await user.cleanup()
		}
	})

	it('answers 401 when the live session names a customer MongoDB does not have', async () => {
		const session = await withSession()

		try {
			const { status, json } = await gql(change(CURRENT_PWD, 'nuovaPassword2!'), session.headers)

			expect(status).toBe(401)
			expect(json.errors?.[0]?.message).toBe('Unauthorized')
		} finally {
			await session.cleanup()
		}
	})
})
