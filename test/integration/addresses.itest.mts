import * as dotenv from 'dotenv'
import type { Server } from 'http'
import mongoose from 'mongoose'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

dotenv.config()

import { bootServer, db, drainAndClose, gql, readUser, seedUser, withSignedInUser } from './harness.mts'

/****************************************************************************************
 * The address surface, against the real collection validator.
 *
 * This is the file the integration project exists for. The `user` collection is validated by
 * `$and: [ {$jsonSchema}, {$expr} ]`, and the `$expr` half — `defaultAddress` is missing, or
 * it is one of `addresses[]._id` — is the reason three of the four write paths below are
 * shaped the way they are:
 *
 *   - `funUserAddressDel` is an aggregation-pipeline update, because a plain `$pull` of the
 *     default address produces a document the database refuses;
 *   - `funUserAddressUpdate` writes the element `_id` back explicitly, because a fresh one
 *     would leave the pointer naming nothing;
 *   - `funUserDefaultAddressSet` needs no clear-the-others step, because the shape cannot
 *     express a second default.
 *
 * A mocked `User` model has no opinion about any of that: it accepts every one of those
 * documents and reports success. Each rule therefore gets an assertion here *and* a
 * raw-driver counter-proof that MongoDB really does refuse the alternative — without the
 * second half, a test that passes proves only that the code ran.
 ****************************************************************************************/

let httpServer: Server

const ADD = (extra = '') =>
	`mutation { userAddressAdd(address: { street: "1 Main Street", postalCode: "01103", city: "Springfield", province: "ma"${extra} }) { _id } }`

const DEL = (_id: unknown) => `mutation { userAddressDel(_id: "${String(_id)}") }`
const SET_DEFAULT = (_id: unknown) => `mutation { userDefaultAddressSet(_id: "${String(_id)}") }`

const UPDATE = (_id: unknown, body: string) => `mutation { userAddressUpdate(_id: "${String(_id)}", address: ${body}) }`

/** Add one address through the real mutation and hand back the id the database minted for it. */
async function addAddress(headers: Record<string, string>, extra = '') {
	const { json } = await gql(ADD(extra), headers)

	expect(json.errors).toBeUndefined()
	const _id = (json.data?.userAddressAdd as { _id: string })._id
	expect(mongoose.Types.ObjectId.isValid(_id)).toBe(true)

	return new mongoose.Types.ObjectId(_id)
}

beforeAll(async () => {
	;({ httpServer } = await bootServer())
})

afterAll(() => drainAndClose(httpServer))

describe('userAddressAdd', () => {
	it('appends an element carrying a server-minted _id, and answers that id', async () => {
		const user = await withSignedInUser()

		try {
			const addressId = await addAddress(user.headers)

			const stored = await readUser(user._id)
			expect(stored?.addresses).toEqual([
				{
					_id: addressId,
					street: '1 Main Street',
					postalCode: '01103',
					city: 'Springfield',
					// Upper-cased on the way in, so `bg` and `BG` are one value in the database rather than two
					// that sort apart and compare unequal.
					province: 'MA'
				}
			])
			// Not pointed at the first address automatically: the pointer is a value the customer chooses,
			// and defaulting it here would leave "why is this the default?" with no answer.
			expect(stored?.defaultAddress).toBeUndefined()
		} finally {
			await user.cleanup()
		}
	})

	it('stamps position.type server-side and stores a GeoJSON point', async () => {
		const user = await withSignedInUser()

		try {
			const addressId = await addAddress(user.headers, ', label: "home", position: { coordinates: [9.57, 45.75] }')

			const stored = await readUser(user._id)
			expect(stored?.addresses[0]).toMatchObject({
				_id: addressId,
				label: 'home',
				// The input carries coordinates only — `type` has exactly one legal value, so asking a client
				// for the constant is only a way to receive `point` and fail the write.
				position: { type: 'Point', coordinates: [9.57, 45.75] }
			})
		} finally {
			await user.cleanup()
		}
	})

	it('keeps appending rather than replacing, so two identical addresses are two elements', async () => {
		const user = await withSignedInUser()

		try {
			const first = await addAddress(user.headers)
			const second = await addAddress(user.headers)

			expect(first.equals(second)).toBe(false)

			const stored = await readUser(user._id)
			expect(stored?.addresses).toHaveLength(2)
			// The reason the mutation answers an id at all: the two elements are otherwise identical, so a
			// bare Boolean would leave the client re-reading the account and guessing which one is new.
			expect(stored?.addresses.map((a: { _id: mongoose.Types.ObjectId }) => a._id.toHexString())).toEqual([
				first.toHexString(),
				second.toHexString()
			])
		} finally {
			await user.cleanup()
		}
	})

	it('rejects a malformed address before anything is written', async () => {
		const user = await withSignedInUser()

		try {
			const cap = await gql(ADD().replace('01103', '2403'), user.headers)
			expect(cap.status).toBe(400)
			expect(cap.json.errors?.[0]?.extensions?.description).toBe('postalCode: the postal code is 5 digits')

			const province = await gql(ADD().replace('"ma"', '"massachusetts"'), user.headers)
			expect(province.json.errors?.[0]?.extensions?.description).toBe('province: the province is the 2-letter code')

			// ±90 for latitude, not the ±180 longitude gets — a single rule for both would let this reach a
			// 2dsphere index that cannot key it.
			const lat = await gql(ADD(', position: { coordinates: [9.57, 120] }'), user.headers)
			expect(lat.json.errors?.[0]?.extensions?.description).toBe('position.coordinates: latitude outside -90..90')

			expect((await readUser(user._id))?.addresses).toBeUndefined()
		} finally {
			await user.cleanup()
		}
	})
})

describe('userAddressUpdate', () => {
	it('replaces the element whole, keeping its _id and dropping cleared fields', async () => {
		const user = await withSignedInUser()

		try {
			const addressId = await addAddress(user.headers, ', label: "home", position: { coordinates: [9.57, 45.75] }')

			const { status, json } = await gql(
				UPDATE(addressId, '{ street: "2 Harbour Road", postalCode: "02108", city: "Boston", province: "MA", label: "" }'),
				user.headers
			)

			expect(status).toBe(200)
			expect(json.data).toEqual({ userAddressUpdate: true })

			const stored = await readUser(user._id)
			// Whole-element replacement: the label and the point the customer cleared are gone rather than
			// surviving under the new street. That is what an edit form means by an empty box.
			expect(stored?.addresses).toEqual([
				{ _id: addressId, street: '2 Harbour Road', postalCode: '02108', city: 'Boston', province: 'MA' }
			])
		} finally {
			await user.cleanup()
		}
	})

	/*
	 * ⚠️ The reason `funUserAddressUpdate` writes `_id` back explicitly instead of letting the `$set`
	 * of `addresses.$` mint a new one. Editing the address the pointer names must leave the pointer
	 * valid — with a fresh id it would dangle, and the `$expr` would refuse the write outright.
	 */
	it('leaves defaultAddress valid when the default address is the one edited', async () => {
		const user = await withSignedInUser()

		try {
			const addressId = await addAddress(user.headers)
			await gql(SET_DEFAULT(addressId), user.headers)

			const { json } = await gql(
				UPDATE(addressId, '{ street: "2 Harbour Road", postalCode: "02108", city: "Boston", province: "MA" }'),
				user.headers
			)
			expect(json.errors).toBeUndefined()

			const stored = await readUser(user._id)
			expect(stored?.addresses[0]._id).toEqual(addressId)
			expect(stored?.defaultAddress).toEqual(addressId)
			expect(stored?.addresses[0].street).toBe('2 Harbour Road')
		} finally {
			await user.cleanup()
		}
	})

	it('answers 200 when an address is re-saved unchanged', async () => {
		const user = await withSignedInUser()

		try {
			const addressId = await addAddress(user.headers)
			const body = '{ street: "1 Main Street", postalCode: "01103", city: "Springfield", province: "MA" }'

			await gql(UPDATE(addressId, body), user.headers)
			// MongoDB reports `modifiedCount: 0` for this one, which is why the write path checks
			// `matchedCount` — the alternative tells a customer their save broke when nothing did.
			const { status, json } = await gql(UPDATE(addressId, body), user.headers)

			expect(status).toBe(200)
			expect(json.data).toEqual({ userAddressUpdate: true })
		} finally {
			await user.cleanup()
		}
	})
})

describe('userDefaultAddressSet', () => {
	it('points the pointer at one address, and moving it needs no clear step', async () => {
		const user = await withSignedInUser()

		try {
			const home = await addAddress(user.headers)
			const office = await addAddress(user.headers)

			expect((await gql(SET_DEFAULT(home), user.headers)).json.data).toEqual({ userDefaultAddressSet: true })
			expect((await readUser(user._id))?.defaultAddress).toEqual(home)

			// One `$set`, not "clear the others, then set this one". A second default is not forbidden
			// here — it is inexpressible, so there is nothing to clear and no window to race.
			expect((await gql(SET_DEFAULT(office), user.headers)).json.data).toEqual({ userDefaultAddressSet: true })

			const stored = await readUser(user._id)
			expect(stored?.defaultAddress).toEqual(office)
			expect(stored?.addresses).toHaveLength(2)
		} finally {
			await user.cleanup()
		}
	})

	it('answers 200 when the default is re-set to what it already is', async () => {
		const user = await withSignedInUser()

		try {
			const addressId = await addAddress(user.headers)

			await gql(SET_DEFAULT(addressId), user.headers)
			// A double-clicked button. `modifiedCount` is 0 here, `matchedCount` is 1.
			const { status, json } = await gql(SET_DEFAULT(addressId), user.headers)

			expect(status).toBe(200)
			expect(json.data).toEqual({ userDefaultAddressSet: true })
		} finally {
			await user.cleanup()
		}
	})
})

describe('userAddressDel', () => {
	it('removes a non-default address and leaves the pointer alone', async () => {
		const user = await withSignedInUser()

		try {
			const home = await addAddress(user.headers)
			const office = await addAddress(user.headers)
			await gql(SET_DEFAULT(home), user.headers)

			const { status, json } = await gql(DEL(office), user.headers)

			expect(status).toBe(200)
			expect(json.data).toEqual({ userAddressDel: true })

			const stored = await readUser(user._id)
			expect(stored?.addresses).toHaveLength(1)
			expect(stored?.addresses[0]._id).toEqual(home)
			expect(stored?.defaultAddress).toEqual(home)
		} finally {
			await user.cleanup()
		}
	})

	/*
	 * ⚠️ The crown jewel, and the one assertion the unit suite structurally cannot make.
	 *
	 * The element and the pointer that names it go in ONE atomic write. Reading the document first
	 * and deciding in Node would open a window for a concurrent `userDefaultAddressSet`; two
	 * sequential `updateOne` calls would leave the document *invalid* in between, and the validator
	 * would refuse the intermediate state anyway.
	 */
	it('clears defaultAddress in the same write when the default address is deleted', async () => {
		const user = await withSignedInUser()

		try {
			const home = await addAddress(user.headers)
			const office = await addAddress(user.headers)
			await gql(SET_DEFAULT(home), user.headers)

			const { json } = await gql(DEL(home), user.headers)
			expect(json.errors).toBeUndefined()

			const stored = await readUser(user._id)
			expect(stored?.addresses).toHaveLength(1)
			expect(stored?.addresses[0]._id).toEqual(office)
			// `$$REMOVE`, so the field is absent rather than null — which is what `$unset` means and what
			// `bsonType: 'objectId'` demands.
			expect(Object.prototype.hasOwnProperty.call(stored!, 'defaultAddress')).toBe(false)
		} finally {
			await user.cleanup()
		}
	})

	it('removes the last address, pointer and all', async () => {
		const user = await withSignedInUser()

		try {
			const addressId = await addAddress(user.headers)
			await gql(SET_DEFAULT(addressId), user.headers)

			expect((await gql(DEL(addressId), user.headers)).json.errors).toBeUndefined()

			const stored = await readUser(user._id)
			expect(stored?.addresses).toEqual([])
			expect(stored?.defaultAddress).toBeUndefined()
		} finally {
			await user.cleanup()
		}
	})

	// No `deleted` state on an address, so "already gone" is not a distinguishable case: the guard
	// simply no longer finds it.
	it('answers 403 on a second delete of the same address', async () => {
		const user = await withSignedInUser()

		try {
			const addressId = await addAddress(user.headers)
			await gql(DEL(addressId), user.headers)

			const { status, json } = await gql(DEL(addressId), user.headers)

			expect(status).toBe(403)
			expect(json.errors?.[0]?.message).toBe('Forbidden')
		} finally {
			await user.cleanup()
		}
	})
})

/*
 * The ownership guard, over a real second customer. Every mutation below takes an address id from
 * the client, so without the guard that id is an unauthenticated pointer into the collection.
 *
 * 403 and not 404, deliberately: the two answers together would tell a caller which address ids
 * exist on the platform, and an id that exists is one worth guessing again.
 */
describe('throwIfUserDontOwnAddress, over the real collection', () => {
	it('refuses a stranger address with 403 on all three mutations that take one', async () => {
		const user = await withSignedInUser()
		const strangerAddressId = new mongoose.Types.ObjectId()
		const stranger = await seedUser({
			addresses: [{ _id: strangerAddressId, street: '9 Other Street', postalCode: '02108', city: 'Boston', province: 'MA' }],
			defaultAddress: strangerAddressId
		})

		try {
			const body = '{ street: "1 My Street", postalCode: "01103", city: "Springfield", province: "MA" }'

			for (const query of [DEL(strangerAddressId), SET_DEFAULT(strangerAddressId), UPDATE(strangerAddressId, body)]) {
				const { status, json } = await gql(query, user.headers)

				expect(status).toBe(403)
				expect(json.errors?.[0]?.message).toBe('Forbidden')
			}

			// Untouched, and the guard ran before any write — not after one that silently matched nothing.
			const other = await readUser(stranger._id)
			expect(other?.addresses).toHaveLength(1)
			expect(other?.addresses[0].street).toBe('9 Other Street')
			expect(other?.defaultAddress).toEqual(strangerAddressId)
		} finally {
			await user.cleanup()
		}
	})

	it('refuses an address id that names nothing at all', async () => {
		const user = await withSignedInUser()

		try {
			const { status } = await gql(DEL(new mongoose.Types.ObjectId()), user.headers)

			expect(status).toBe(403)
		} finally {
			await user.cleanup()
		}
	})
})

/*
 * The counter-proofs. Each one is a write no code path here can produce any more, sent through the
 * raw driver to establish that MongoDB is what refuses it — not a mock, and not an application
 * check somebody could delete without a test noticing.
 *
 * Error code 121 is `DocumentValidationFailure`.
 */
describe('what the collection validator refuses (raw driver)', () => {
	it('refuses a plain $pull of the default address — which is why the delete is a pipeline', async () => {
		const addressId = new mongoose.Types.ObjectId()
		const other = new mongoose.Types.ObjectId()
		const user = await seedUser({
			addresses: [
				{ _id: addressId, street: '1 Main Street', postalCode: '01103', city: 'Springfield', province: 'MA' },
				{ _id: other, street: '2 Harbour Road', postalCode: '02108', city: 'Boston', province: 'MA' }
			],
			defaultAddress: addressId
		})

		// The naive delete: remove the element, leave the pointer. Refused, and it has to be — the
		// pointer would name nothing, and nothing downstream would ever notice.
		await expect(
			db()
				.collection('user')
				.updateOne({ _id: user._id }, { $pull: { addresses: { _id: addressId } } } as never)
		).rejects.toMatchObject({ code: 121 })

		// Pulling a NON-default element is fine, which is what makes the rejection above specific to the
		// pointer rather than to `$pull`.
		await expect(
			db()
				.collection('user')
				.updateOne({ _id: user._id }, { $pull: { addresses: { _id: other } } } as never)
		).resolves.toMatchObject({ modifiedCount: 1 })

		const stored = await readUser(user._id)
		expect(stored?.addresses).toHaveLength(1)
		expect(stored?.defaultAddress).toEqual(addressId)
	})

	it('refuses a defaultAddress that names an address of somebody else', async () => {
		const addressId = new mongoose.Types.ObjectId()
		const user = await seedUser({
			addresses: [{ _id: addressId, street: '1 Main Street', postalCode: '01103', city: 'Springfield', province: 'MA' }]
		})

		await expect(
			db()
				.collection('user')
				.updateOne({ _id: user._id }, { $set: { defaultAddress: new mongoose.Types.ObjectId() } })
		).rejects.toMatchObject({ code: 121 })
	})

	/*
	 * ⚠️ The `$ifNull: ['$addresses', []]` inside the `$map` is load-bearing, and this is the document
	 * that exercises it: a pointer with no array to look into. `$map` over a missing field yields null
	 * and `$in` against null *errors* rather than answering false — so without the `$ifNull` this
	 * would not be a clean validation failure but an aggregation error out of the validator itself.
	 */
	it('refuses a defaultAddress on a customer who has no addresses at all', async () => {
		const user = await seedUser()

		await expect(
			db()
				.collection('user')
				.updateOne({ _id: user._id }, { $set: { defaultAddress: new mongoose.Types.ObjectId() } })
		).rejects.toMatchObject({ code: 121 })
	})

	// The mirror of it: no pointer and no array is a perfectly good customer, which is what a fresh
	// registration looks like. If the `$in` were reached with a null it would fail here too.
	it('accepts a customer with neither a pointer nor an addresses array', async () => {
		const user = await seedUser()

		const stored = await readUser(user._id)
		expect(stored?.addresses).toBeUndefined()
		expect(stored?.defaultAddress).toBeUndefined()
	})

	it('refuses an address element written with a null optional field', async () => {
		const user = await seedUser()

		await expect(
			db()
				.collection('user')
				.updateOne({ _id: user._id }, {
					$push: {
						addresses: {
							_id: new mongoose.Types.ObjectId(),
							street: '1 Main Street',
							postalCode: '01103',
							city: 'Springfield',
							province: 'MA',
							// What a cleared text box serialises to over GraphQL, and what `optionalText`
							// exists to turn into an absent key.
							label: null
						}
					}
				} as never)
		).rejects.toMatchObject({ code: 121 })
	})

	it('refuses an address element with no _id, which is what makes the pointer expressible', async () => {
		const user = await seedUser()

		await expect(
			db()
				.collection('user')
				.updateOne({ _id: user._id }, {
					// `updateOne` is a query, so the Mongoose sub-document default that would supply an
					// `_id` never runs — which is why `funUserAddressAdd` mints one by hand.
					$push: { addresses: { street: '1 Main Street', postalCode: '01103', city: 'Springfield', province: 'MA' } }
				} as never)
		).rejects.toMatchObject({ code: 121 })
	})
})

describe('me, after the address surface has been exercised', () => {
	it('reports the addresses and the pointer the mutations left behind', async () => {
		const user = await withSignedInUser()

		try {
			const home = await addAddress(user.headers, ', label: "home", position: { coordinates: [9.57, 45.75] }')
			const office = await addAddress(user.headers)
			await gql(SET_DEFAULT(office), user.headers)
			await gql(DEL(home), user.headers)

			const { json } = await gql('{ me { addresses { _id label position { type coordinates } } defaultAddress } }', user.headers)

			expect(json.errors).toBeUndefined()
			expect(json.data?.me).toEqual({
				addresses: [{ _id: office.toHexString(), label: null, position: null }],
				defaultAddress: office.toHexString()
			})
		} finally {
			await user.cleanup()
		}
	})
})
