import { GraphQLError } from 'graphql'
import { Types } from 'mongoose'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { IContextUserAuthenticatedResource } from '../src/lib/auth/IContextUserAuthenticatedResource.mts'

const findById = vi.fn()

vi.mock('@axiumine/marketplace-common/models/MongoDB/User', () => ({ User: { findById } }))

const { me } = await import('../src/graphQLApi/schema/queries/me.mts')
const { userExport } = await import('../src/graphQLApi/schema/queries/userExport.mts')

const userId = new Types.ObjectId('507f1f77bcf86cd799439011')
const addressId = new Types.ObjectId('507f1f77bcf86cd799439022')
const registeredAt = new Date('2026-08-05T10:00:00.000Z')
const firstLogin = new Date('2026-08-05T10:05:00.000Z')
const lastLogin = new Date('2026-08-24T18:20:00.000Z')

const ctx = { state: { user: { _id: userId } } } as unknown as IContextUserAuthenticatedResource

/** `findById()` answers a Query; the resolver ends it with `.select().lean()`. */
function reading(doc: unknown) {
	const lean = vi.fn().mockResolvedValue(doc)
	const select = vi.fn().mockReturnValue({ lean })

	findById.mockReturnValueOnce({ select })

	return { select, lean }
}

const STORED = {
	_id: userId,
	login: { email: 'cliente@marketplace.test', firstLogin, lastLogin },
	personalData: { firstName: 'Mark', lastName: 'Rivers' },
	addresses: [{ _id: addressId, street: '1 main street', postalCode: '02109', city: 'Boston', province: 'MA' }],
	defaultAddress: addressId,
	registeredAt
}

beforeEach(() => {
	findById.mockReset()
})

describe('me', () => {
	// ⚠️ The account is the session's and nothing else. There is no `user(_id:)` on this tier, so this
	// assertion is the whole identity story: the id reaching the database is the one the auth
	// middleware put in `ctx.state.user`, never an argument.
	it('reads the account named by the session and flattens login.email', async () => {
		reading(STORED)

		await expect(me.resolve(null, {}, ctx)).resolves.toEqual({
			_id: userId,
			email: 'cliente@marketplace.test',
			personalData: { firstName: 'Mark', lastName: 'Rivers' },
			addresses: STORED.addresses,
			defaultAddress: addressId,
			registeredAt
		})

		expect(findById).toHaveBeenCalledExactlyOnceWith(userId)
	})

	// ⚠️ A **positive** list, pinned verbatim. The same sub-document holds `login.password`,
	// `resetPwd` and `emailVerify`, each of which is enough to take the account over; an exclusion
	// list would silently start leaking whatever sensitive field is added to the collection next.
	// `GraphQLUserMe` having no fields for them is the second layer, not the only one.
	it('projects exactly the six safe paths', async () => {
		const { select } = reading(STORED)

		await me.resolve(null, {}, ctx)

		expect(select).toHaveBeenCalledExactlyOnceWith('_id login.email personalData addresses defaultAddress registeredAt')
	})

	// The collection makes `addresses` optional and the schema declares the list NonNull, so a
	// customer who has saved none would turn their own account page into a GraphQL error.
	it('answers an empty list for a customer with no addresses', async () => {
		reading({ ...STORED, addresses: undefined })

		await expect(me.resolve(null, {}, ctx)).resolves.toMatchObject({ addresses: [] })
	})

	// `personalData` and `defaultAddress` are genuinely nullable — registration is an email and a
	// password, so an account that never filled in a name still works and must still render.
	it('carries the two optional fields through as undefined rather than defaulting them', async () => {
		reading({ ...STORED, personalData: undefined, defaultAddress: undefined })

		const account = (await me.resolve(null, {}, ctx)) as { personalData?: unknown; defaultAddress?: unknown }

		expect(account.personalData).toBeUndefined()
		expect(account.defaultAddress).toBeUndefined()
	})

	// A null document means the session outlived the account — 401 so the client re-logins, rather
	// than a null account the private area would have to render.
	it('answers 401 when the session outlived the account', async () => {
		reading(null)

		try {
			await me.resolve(null, {}, ctx)
			expect.unreachable('a missing account was expected to be refused')
		} catch (e) {
			const error = e as GraphQLError

			expect(error.message).toBe('Unauthorized')
			expect((error.extensions.http as { status: number }).status).toBe(401)
		}
	})
})

describe('userExport', () => {
	// ⚠️ **Self-service and single-customer, and the resolver is where that is enforced.** The record
	// read is the session's own; there is no argument to aim at somebody else's, which is what keeps
	// ADR-029 intact — nothing here sorts, searches or lists across accounts.
	it('reads the account named by the session and adds the two login timestamps', async () => {
		reading(STORED)

		await expect(userExport.resolve(null, {}, ctx)).resolves.toEqual({
			_id: userId,
			email: 'cliente@marketplace.test',
			personalData: { firstName: 'Mark', lastName: 'Rivers' },
			addresses: STORED.addresses,
			defaultAddress: addressId,
			registeredAt,
			firstLogin,
			lastLogin
		})

		expect(findById).toHaveBeenCalledExactlyOnceWith(userId)
	})

	/*
	 * ⚠️ A **positive** list, pinned verbatim, and on this resolver it is not merely the convention `me`
	 * follows — it is the only thing standing between the export and the secrets. `decryptDocument`
	 * decrypts whatever it finds as `binData` subtype 6 wherever it sits, so a document read whole would
	 * arrive here with `resetPwd.resetHash` and `emailVerify.hash` in plaintext. What is not projected is
	 * not read.
	 */
	it('projects exactly the eight safe paths', async () => {
		const { select } = reading(STORED)

		await userExport.resolve(null, {}, ctx)

		expect(select).toHaveBeenCalledExactlyOnceWith(
			'_id login.email login.firstLogin login.lastLogin personalData addresses defaultAddress registeredAt'
		)
	})

	// Same reason as in `me`: the collection makes `addresses` optional and the schema declares the
	// list NonNull, so an export of an account with none saved would be a GraphQL error.
	it('answers an empty list for a customer with no addresses', async () => {
		reading({ ...STORED, addresses: undefined })

		await expect(userExport.resolve(null, {}, ctx)).resolves.toMatchObject({ addresses: [] })
	})

	// All four are genuinely optional, and none of them is defaulted: an account that registered and
	// never confirmed its email has no `firstLogin`, and one that never filled in a profile has no
	// `personalData`. An export says what is there, not what a placeholder would suggest.
	it('carries the optional fields through as undefined rather than defaulting them', async () => {
		reading({ ...STORED, personalData: undefined, defaultAddress: undefined, login: { email: 'cliente@marketplace.test' } })

		const record = (await userExport.resolve(null, {}, ctx)) as Record<string, unknown>

		expect(record.personalData).toBeUndefined()
		expect(record.defaultAddress).toBeUndefined()
		expect(record.firstLogin).toBeUndefined()
		expect(record.lastLogin).toBeUndefined()
	})

	// The secrets have no field on `GraphQLUserExport` either — this is the inner of the two layers.
	it('never carries a secret out of the login sub-document', async () => {
		reading({
			...STORED,
			login: { ...STORED.login, password: 'hashed' },
			resetPwd: { resetHash: 'r' },
			emailVerify: { hash: 'e' }
		})

		const record = (await userExport.resolve(null, {}, ctx)) as Record<string, unknown>

		expect(Object.keys(record)).toEqual([
			'_id',
			'email',
			'personalData',
			'addresses',
			'defaultAddress',
			'registeredAt',
			'firstLogin',
			'lastLogin'
		])
	})

	// A null document means the session outlived the account — 401, same as `me`.
	it('answers 401 when the session outlived the account', async () => {
		reading(null)

		try {
			await userExport.resolve(null, {}, ctx)
			expect.unreachable('a missing account was expected to be refused')
		} catch (e) {
			const error = e as GraphQLError

			expect(error.message).toBe('Unauthorized')
			expect((error.extensions.http as { status: number }).status).toBe(401)
		}
	})
})
