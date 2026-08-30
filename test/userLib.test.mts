import { GraphQLError } from 'graphql'
import { trusted, Types } from 'mongoose'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const userUpdateOne = vi.fn()
const userCountDocuments = vi.fn()
const userFindById = vi.fn()
const checkUserAuthorizationDisDel = vi.fn()
const compareHashAsync = vi.fn()
const encryptPassword = vi.fn()

// ⚠️ No `deleteOne` and no `findOneAndUpdate` on the mock, deliberately. An address is removed by an
// aggregation-pipeline `updateOne` because the pointer has to be cleared in the same write; a
// regression to either of those would pass every assertion below and fail only against a real
// collection validator.
vi.mock('@axiumine/marketplace-common/models/MongoDB/User', () => ({
	User: { updateOne: userUpdateOne, countDocuments: userCountDocuments, findById: userFindById }
}))
vi.mock('@axiumine/marketplace-common/others/checkUserAuthorizationDisDel', () => ({ checkUserAuthorizationDisDel }))
// bcrypt at SALT_ROUNDS=14 is ~1s per hash. Both sides are stubbed: what is under test here is the
// order of the checks, not the KDF.
vi.mock('@axiumine/koa-utils/lib/hash', () => ({ compareHashAsync }))
vi.mock('@axiumine/koa-utils/lib/encryptPassword', () => ({ encryptPassword }))

const { funUserAddressAdd } = await import('../src/lib/user/funUserAddressAdd.mts')
const { funUserAddressDel } = await import('../src/lib/user/funUserAddressDel.mts')
const { funUserAddressUpdate } = await import('../src/lib/user/funUserAddressUpdate.mts')
const { funUserDefaultAddressSet } = await import('../src/lib/user/funUserDefaultAddressSet.mts')
const { funUserDel } = await import('../src/lib/user/funUserDel.mts')
const { funUserPersonalDataUpdate } = await import('../src/lib/user/funUserPersonalDataUpdate.mts')
const { funUserUpdatePwd } = await import('../src/lib/user/funUserUpdatePwd.mts')
const { throwIfUserDontOwnAddress } = await import('../src/lib/user/throwIfUserDontOwnAddress.mts')

const userId = new Types.ObjectId('507f1f77bcf86cd799439011')
const addressId = new Types.ObjectId('507f1f77bcf86cd799439022')

const address = { street: '1 main street', postalCode: '02109', city: 'Boston', province: 'MA' } as never
const personalData = { firstName: 'Mark', lastName: 'Rivers' } as never

const updateExec = vi.fn()

/** `countDocuments()` answers a Query; the guard ends it with `.lean()`. */
function counting(found: number) {
	return { lean: vi.fn().mockResolvedValue(found) }
}

/** `findById()` answers a Query; `funUserUpdatePwd` and `funUserDel` end it with `.select().lean()`. */
function reading(doc: unknown) {
	return { select: vi.fn().mockReturnValue({ lean: vi.fn().mockResolvedValue(doc) }) }
}

/** The HTTP title is the thrown `message`; the human text lives in `extensions.description`. */
async function rejection(promise: Promise<unknown>) {
	try {
		await promise
	} catch (e) {
		const error = e as GraphQLError

		return { title: error.message, status: (error.extensions.http as { status: number }).status }
	}

	return expect.unreachable('the call was expected to reject')
}

beforeEach(() => {
	userUpdateOne.mockReset().mockReturnValue({ exec: updateExec })
	userCountDocuments.mockReset().mockReturnValue(counting(1))
	userFindById.mockReset()
	checkUserAuthorizationDisDel.mockReset()
	compareHashAsync.mockReset().mockResolvedValue(true)
	encryptPassword.mockReset().mockResolvedValue('hashed-new')
	updateExec.mockReset().mockResolvedValue({ matchedCount: 1, modifiedCount: 1 })
})

describe('throwIfUserDontOwnAddress', () => {
	// Both clauses, as an exact key set: dropping the `_id` half turns the guard into "does this
	// address exist anywhere on the platform", which every customer's id satisfies.
	it('passes when the address belongs to this customer', async () => {
		await expect(throwIfUserDontOwnAddress(userId, addressId)).resolves.toBeUndefined()

		expect(userCountDocuments).toHaveBeenCalledExactlyOnceWith({ _id: userId, 'addresses._id': addressId })
	})

	// 403 and not 404, deliberately: the two answers together would tell a caller which address ids
	// exist, and an id that exists is one worth guessing again.
	it('answers 403 when the address is somebody else’s or gone', async () => {
		userCountDocuments.mockReturnValueOnce(counting(0))

		expect(await rejection(throwIfUserDontOwnAddress(userId, addressId))).toEqual({ title: 'Forbidden', status: 403 })
	})
})

describe('funUserAddressAdd', () => {
	// The id is minted here rather than left to Mongoose: `updateOne` is a query, so the sub-document
	// default that would supply an `_id` never runs and the element reaches the collection without
	// one, failing its `required: ['_id']`.
	it('pushes the element with a freshly minted _id and answers it', async () => {
		const minted = await funUserAddressAdd(userId, address)

		expect(minted).toBeInstanceOf(Types.ObjectId)

		const [filter, update] = userUpdateOne.mock.calls[0]
		expect(filter).toEqual({ _id: userId, 'addresses.5': trusted({ $exists: false }) })
		expect(update).toEqual({ $push: { addresses: { ...address, _id: minted } } })
	})

	// ⚠️ The cap is a CLAUSE OF THE FILTER, so the count and the push are one operation. Read-then-push
	// is two round trips with a window between them, and two adds fired at once both see six and both
	// go. `addresses.5` and not `$expr`: `sanitizeFilter` is on process-wide and throws on `$expr`, and
	// index 5 is absent exactly when there is room for a seventh element — including when `addresses`
	// itself is absent, which is what keeps the FIRST address addable.
	it('counts and pushes in one atomic update', async () => {
		await funUserAddressAdd(userId, address)

		expect(userUpdateOne).toHaveBeenCalledOnce()
		const [filter, update] = userUpdateOne.mock.calls[0] as [Record<string, unknown>, Record<string, unknown>]
		// `trusted`, and the deep-equal is what pins it: `sanitizeFilter` rewrites an untrusted
		// `{$exists: false}` into `{$eq: {$exists: false}}`, which matches no document at all and would
		// refuse every address ever added.
		expect(filter['addresses.5']).toEqual(trusted({ $exists: false }))
		expect(update).toHaveProperty('$push')
		expect(userCountDocuments).not.toHaveBeenCalled()
	})

	// A miss on the filter is a miss on one of two clauses and the codes differ, so the failing path
	// pays for one read to find out which. Here the account is there and full: a 400 naming the limit,
	// which the private area can put in front of the customer.
	it('answers 400 when the account already holds the maximum', async () => {
		updateExec.mockResolvedValueOnce({ matchedCount: 0, modifiedCount: 0 })

		expect(await rejection(funUserAddressAdd(userId, address))).toEqual({ title: 'Bad Request', status: 400 })
		expect(userCountDocuments).toHaveBeenCalledExactlyOnceWith({ _id: userId })
	})

	// The message carries the number, because a limit the customer cannot see is a refusal they cannot
	// act on. It rides in `extensions.description`, which is what the three frontends render.
	it('names the limit in the description the client renders', async () => {
		updateExec.mockResolvedValueOnce({ matchedCount: 0, modifiedCount: 0 })

		await expect(funUserAddressAdd(userId, address)).rejects.toMatchObject({
			extensions: { description: 'addresses: at most 6 addresses can be saved' }
		})
	})

	// The other half of the same miss: no such account. The session named it a moment ago, so this is
	// not something a customer did — 500, and no message about addresses, which would be a lie.
	it('answers 500 when the account itself is gone', async () => {
		updateExec.mockResolvedValueOnce({ matchedCount: 0, modifiedCount: 0 })
		userCountDocuments.mockReturnValueOnce(counting(0))

		expect(await rejection(funUserAddressAdd(userId, address))).toEqual({ title: 'Internal Server Error', status: 500 })
	})

	it('mints a different id on every call', async () => {
		const first = await funUserAddressAdd(userId, address)
		const second = await funUserAddressAdd(userId, address)

		expect(String(first)).not.toBe(String(second))
	})

	// `defaultAddress` is deliberately untouched, not even for the first address: pointing it
	// automatically would make the default a value the customer never chose.
	it('never touches defaultAddress', async () => {
		await funUserAddressAdd(userId, address)

		expect(JSON.stringify(userUpdateOne.mock.calls[0][1])).not.toContain('defaultAddress')
	})

	// `modifiedCount`, sound here where it is wrong for a profile save: a push always changes the
	// array, so anything but 1 means the id about to be returned names nothing.
	it('answers 500 when the push did not land', async () => {
		updateExec.mockResolvedValueOnce({ matchedCount: 1, modifiedCount: 0 })

		expect(await rejection(funUserAddressAdd(userId, address))).toEqual({ title: 'Internal Server Error', status: 500 })
		// And it never reaches the second read: the cap branch hangs off `matchedCount`, not off
		// "something went wrong", so a document that matched and did not change is not reported as full.
		expect(userCountDocuments).not.toHaveBeenCalled()
	})
})

describe('funUserAddressDel', () => {
	// An aggregation pipeline and not a `$pull`, because the validator's `$expr` half refuses a
	// document whose `defaultAddress` names nothing — so removing the default address and clearing
	// the pointer have to be one operation. Both stages are pinned.
	it('filters the element out and clears the pointer in one write', async () => {
		await funUserAddressDel(userId, addressId)

		const [filter, pipeline, options] = userUpdateOne.mock.calls[0]

		// The array is named in the filter as well as in the pipeline: without it the update runs on a
		// document that may no longer hold the address, and reports success.
		expect(filter).toEqual({ _id: userId, 'addresses._id': addressId })
		expect(pipeline).toHaveLength(2)
		expect(pipeline[0]).toEqual({
			$set: { addresses: { $filter: { input: '$addresses', cond: { $ne: ['$$this._id', addressId] } } } }
		})
		// `$$REMOVE`, two dollars — one is a field path to a field called REMOVE, which evaluates to
		// missing here by coincidence and stops working the day the else-branch has a value to keep.
		expect(pipeline[1]).toEqual({
			$set: { defaultAddress: { $cond: [{ $eq: ['$defaultAddress', addressId] }, '$$REMOVE', '$defaultAddress'] } }
		})
		// ⚠️ Not decoration. Mongoose 9 refuses an array update outright — `Cannot pass an array to
		// query updates unless the 'updatePipeline' option is set.` — thrown before the driver is
		// reached, so without this every address delete answered 500. Nothing in this file could have
		// caught it: `User.updateOne` is mocked, and a mock takes an array happily.
		expect(options).toEqual({ updatePipeline: true })
	})

	/*
	 * ⚠️ The id arrives as a **string**, whatever the signature says: `GraphQLID` resolves to one, and
	 * the resolver hands it straight through. Mongoose casts a filter against the schema but treats a
	 * pipeline as an opaque aggregation expression and casts nothing inside it — so an uncoerced
	 * `{ $ne: ['$$this._id', '507f…'] }` compares an ObjectId to a string, is never equal, keeps every
	 * element and answers `matchedCount: 1, modifiedCount: 0`. A matched document that was not touched.
	 *
	 * The ObjectId case above cannot pin this: `new Types.ObjectId(oid)` deep-equals its argument, so
	 * dropping the coercion looks identical there. Passing a string is what makes the difference
	 * observable.
	 */
	it('coerces a string id, so the pipeline compares ObjectId to ObjectId', async () => {
		await funUserAddressDel(userId, addressId.toHexString() as unknown as Types.ObjectId)

		const [filter, pipeline] = userUpdateOne.mock.calls[0]

		expect(filter['addresses._id']).toBeInstanceOf(Types.ObjectId)
		expect(pipeline[0].$set.addresses.$filter.cond.$ne[1]).toBeInstanceOf(Types.ObjectId)
		expect(pipeline[1].$set.defaultAddress.$cond[0].$eq[1]).toBeInstanceOf(Types.ObjectId)
		expect(pipeline[0].$set.addresses.$filter.cond.$ne[1]).toEqual(addressId)
	})

	it('answers 500 when the delete did not land', async () => {
		updateExec.mockResolvedValueOnce({ matchedCount: 1, modifiedCount: 0 })

		expect(await rejection(funUserAddressDel(userId, addressId))).toEqual({ title: 'Internal Server Error', status: 500 })
	})
})

describe('funUserAddressUpdate', () => {
	// `_id` is written back explicitly, and it is the *same* one: `$set` on `addresses.$` replaces
	// the whole element, so omitting it fails the element schema and minting a new one would leave
	// `defaultAddress` dangling — two different rejections from the two halves of the validator.
	it('replaces the element in place, keeping its id', async () => {
		await funUserAddressUpdate(userId, addressId, address)

		const [filter, update] = userUpdateOne.mock.calls[0]

		expect(filter).toEqual({ _id: userId, 'addresses._id': addressId })
		expect(update).toEqual({ $set: { 'addresses.$': { ...address, _id: addressId } } })
	})

	// `matchedCount`, not `modifiedCount`: re-saving an address unchanged is a thing a form does, and
	// MongoDB reports it as modified 0.
	it('accepts a write that matched but changed nothing', async () => {
		updateExec.mockResolvedValueOnce({ matchedCount: 1, modifiedCount: 0 })

		await expect(funUserAddressUpdate(userId, addressId, address)).resolves.toBeUndefined()
	})

	it('answers 500 when nothing matched', async () => {
		updateExec.mockResolvedValueOnce({ matchedCount: 0, modifiedCount: 0 })

		expect(await rejection(funUserAddressUpdate(userId, addressId, address))).toEqual({
			title: 'Internal Server Error',
			status: 500
		})
	})
})

describe('funUserDefaultAddressSet', () => {
	// One `$set` of a root-level pointer, and that is the entire argument for it over a boolean on
	// each element: there is no other address to clear, so a second default is not a rule being
	// maintained but a shape that cannot be expressed.
	it('points defaultAddress at the address, with nothing to clear', async () => {
		await funUserDefaultAddressSet(userId, addressId)

		expect(userUpdateOne).toHaveBeenCalledExactlyOnceWith({ _id: userId }, { $set: { defaultAddress: addressId } })
	})

	it('accepts re-setting the default to what it already was', async () => {
		updateExec.mockResolvedValueOnce({ matchedCount: 1, modifiedCount: 0 })

		await expect(funUserDefaultAddressSet(userId, addressId)).resolves.toBeUndefined()
	})

	it('answers 500 when no account matched', async () => {
		updateExec.mockResolvedValueOnce({ matchedCount: 0, modifiedCount: 0 })

		expect(await rejection(funUserDefaultAddressSet(userId, addressId))).toEqual({
			title: 'Internal Server Error',
			status: 500
		})
	})
})

describe('funUserPersonalDataUpdate', () => {
	// The whole sub-document is replaced rather than merged, which is what makes *clearing* a
	// landline expressible: field-by-field, the absence of a key would mean "leave it" and there
	// would be nothing left to mean "remove it".
	it('replaces personalData whole', async () => {
		await funUserPersonalDataUpdate(userId, personalData)

		expect(userUpdateOne).toHaveBeenCalledExactlyOnceWith({ _id: userId }, { $set: { personalData } })
	})

	it('accepts a save that changed nothing', async () => {
		updateExec.mockResolvedValueOnce({ matchedCount: 1, modifiedCount: 0 })

		await expect(funUserPersonalDataUpdate(userId, personalData)).resolves.toBeUndefined()
	})

	it('answers 500 when no account matched', async () => {
		updateExec.mockResolvedValueOnce({ matchedCount: 0, modifiedCount: 0 })

		expect(await rejection(funUserPersonalDataUpdate(userId, personalData))).toEqual({
			title: 'Internal Server Error',
			status: 500
		})
	})
})

describe('funUserDel', () => {
	const live = { _id: userId }

	beforeEach(() => {
		userFindById.mockReturnValue(reading(live))
	})

	/*
	 * ⚠️ The stamp, and the guard is a CLAUSE OF THE FILTER rather than a read before it — the same shape
	 * `funUserAddressAdd` uses for the address cap, and for the same reason: read-then-write is two round
	 * trips with a window between them, and two closes fired at once would both see a live account and
	 * both write. The second stamp would push the day-30 scrub thirty days further out and postpone the
	 * erasure the first one promised. `trusted`, and the deep-equal is what pins it: `sanitizeFilter`
	 * rewrites an untrusted `{$exists: false}` into `{$eq: {$exists: false}}`, which matches no document
	 * and would refuse every closure.
	 *
	 * `new Date()` and not `Date.now()`, so the collection holds one spelling of the instant — the same
	 * call `funShopOwnerDel` and the admin tier's `funUserDelete` make.
	 */
	it('stamps deleted in one guarded write, and touches nothing else', async () => {
		await expect(funUserDel(userId)).resolves.toBeUndefined()

		const [filter, update] = userUpdateOne.mock.calls[0]
		expect(userUpdateOne).toHaveBeenCalledOnce()
		expect(filter).toEqual({ _id: userId, deleted: trusted({ $exists: false }) })
		expect(Object.keys(update)).toEqual(['$set'])
		expect(Object.keys(update.$set)).toEqual(['deleted'])
		expect(update.$set.deleted).toBeInstanceOf(Date)
	})

	// ⚠️ A soft delete: `updateOne`, never `deleteOne`. The mocked `User` deliberately carries no
	// `deleteOne` at all, so a regression to a hard delete fails here as a TypeError rather than
	// passing every assertion and removing a document on a real collection. And nothing is read on the
	// way in: one round trip closes an account.
	it('reads nothing when the write landed', async () => {
		await funUserDel(userId)

		expect(userFindById).not.toHaveBeenCalled()
	})

	// 401 and not 404: the session outlived the account, and the caller learns their session is no
	// good and nothing more — the same answer `me` and `funUserUpdatePwd` give.
	it('answers 401 when the session outlived the account', async () => {
		updateExec.mockResolvedValueOnce({ matchedCount: 0, modifiedCount: 0 })
		userFindById.mockReturnValueOnce(reading(null))

		expect(await rejection(funUserDel(userId))).toEqual({ title: 'Unauthorized', status: 401 })
	})

	/*
	 * ⚠️ 410 rather than the 401 every other refusal on this tier answers, deliberately: a 401 means
	 * "your session is no longer good", which is exactly what this is not. This is also the second of two
	 * closes racing each other — the filter refused the write, the clock did not move, and the document
	 * is still there to say so. In practice the branch is nearly unreachable: the first call revoked
	 * every session, and it exists for the window where the write landed and the revoke did not.
	 */
	it('answers 410 for an account already closed, without moving the retention clock', async () => {
		updateExec.mockResolvedValueOnce({ matchedCount: 0, modifiedCount: 0 })

		expect(await rejection(funUserDel(userId))).toEqual({ title: 'Oops', status: 410 })
		expect(userUpdateOne).toHaveBeenCalledOnce()
	})

	// The read that decides which refusal this is takes the one field it needs: `_id` proves the
	// document is there, and `deleted` no longer has to be read because the filter already tested it.
	it('reads only the field it needs to tell the two refusals apart', async () => {
		updateExec.mockResolvedValueOnce({ matchedCount: 0, modifiedCount: 0 })

		await rejection(funUserDel(userId))

		expect(userFindById).toHaveBeenCalledExactlyOnceWith(userId)
		expect(userFindById.mock.results[0].value.select).toHaveBeenCalledExactlyOnceWith('_id')
	})

	// The envelope of a 410 says nothing about which 410 it is, so the text carries the whole meaning.
	it('names the reason in the refusal, since the envelope does not', async () => {
		updateExec.mockResolvedValueOnce({ matchedCount: 0, modifiedCount: 0 })

		try {
			await funUserDel(userId)
			expect.unreachable('a closed account was expected to be refused')
		} catch (e) {
			expect((e as GraphQLError).extensions.description).toBe('account already closed')
		}
	})

	// ⚠️ **`disabled` is not a gate here (ADR-036).** `funUserUpdatePwd` is the only lib function on this
	// tier that gates on it, and it does so because re-keying an account is taking it over. Suspension is
	// a platform decision about what somebody may do; the right to erasure is not something the platform
	// suspends. The document and its `disabled` flag both stay where they are — the filter names
	// `deleted` and nothing else, which is what keeps this true.
	it('lets a suspended customer close their account anyway', async () => {
		await expect(funUserDel(userId)).resolves.toBeUndefined()

		expect(userUpdateOne).toHaveBeenCalledOnce()
		expect(userUpdateOne.mock.calls[0][0]).not.toHaveProperty('disabled')
		expect(checkUserAuthorizationDisDel).not.toHaveBeenCalled()
	})
})

describe('funUserUpdatePwd', () => {
	const stored = { _id: userId, login: { password: 'hashed-old' } }

	beforeEach(() => {
		userFindById.mockReturnValue(reading(stored))
	})

	it('re-authenticates, hashes the new password and writes it', async () => {
		await funUserUpdatePwd(userId, 'old-password', 'new-password')

		expect(compareHashAsync).toHaveBeenCalledExactlyOnceWith('old-password', 'hashed-old')
		expect(encryptPassword).toHaveBeenCalledExactlyOnceWith('new-password')
		expect(userUpdateOne).toHaveBeenCalledExactlyOnceWith({ _id: userId }, { $set: { 'login.password': 'hashed-new' } })
	})

	// The projection is a positive list and a short one: the same sub-document holds `resetPwd` and
	// `emailVerify`, whose hashes are each enough to take the account over.
	it('reads only the fields it compares', async () => {
		await funUserUpdatePwd(userId, 'old-password', 'new-password')

		expect(userFindById).toHaveBeenCalledExactlyOnceWith(userId)
		expect(userFindById.mock.results[0].value.select).toHaveBeenCalledExactlyOnceWith('_id disabled deleted login.password')
	})

	// Hashed here rather than through the model: `updateOne` is a query, and the `pre('save')` hook
	// that normally hashes `password` only runs for documents — left to it, this stores plaintext.
	it('never writes the plaintext it was handed', async () => {
		await funUserUpdatePwd(userId, 'old-password', 'new-password')

		expect(JSON.stringify(userUpdateOne.mock.calls[0][1])).not.toContain('new-password')
	})

	// The platform's bounds, from koa-utils Constants: 10 minimum, 72 maximum. The maximum is the one
	// that is easy to dismiss — bcrypt hashes at most 72 bytes and silently ignores the rest.
	it('refuses a new password shorter than the platform minimum, before reading anything', async () => {
		expect(await rejection(funUserUpdatePwd(userId, 'old-password', 'short'))).toEqual({ title: 'Bad Request', status: 400 })
		expect(userFindById).not.toHaveBeenCalled()
	})

	it('refuses a new password longer than bcrypt can hash', async () => {
		expect(await rejection(funUserUpdatePwd(userId, 'old-password', 'a'.repeat(73)))).toEqual({
			title: 'Bad Request',
			status: 400
		})
	})

	// Rejected because it is almost always an accident, and because letting it through spends a
	// bcrypt hash at cost factor 14 to write back a value that is already stored.
	it('refuses a new password identical to the old one', async () => {
		expect(await rejection(funUserUpdatePwd(userId, 'same-password', 'same-password'))).toEqual({
			title: 'Bad Request',
			status: 400
		})
		expect(userFindById).not.toHaveBeenCalled()
	})

	// ⚠️ The 400 alone does not identify this refusal: `checkPwdLen` throws the same title and the
	// same status a few lines above, so a client shown only the envelope cannot tell "too short" from
	// "unchanged". The text is the whole difference between the two, and naming both arguments in it
	// is what makes the message actionable rather than a bare rejection.
	it('names both arguments in the refusal, since the envelope is identical to the length one', async () => {
		try {
			await funUserUpdatePwd(userId, 'same-password', 'same-password')
			expect.unreachable('an unchanged password was expected to be refused')
		} catch (e) {
			expect((e as GraphQLError).extensions.description).toBe('passwordNew must differ from passwordOld')
		}
	})

	// 401 and not 404: the caller learns their session is no good, and nothing more.
	it('answers 401 when the session outlived the account', async () => {
		userFindById.mockReturnValueOnce(reading(null))

		expect(await rejection(funUserUpdatePwd(userId, 'old-password', 'new-password'))).toEqual({
			title: 'Unauthorized',
			status: 401
		})
		expect(compareHashAsync).not.toHaveBeenCalled()
	})

	// A disabled or soft-deleted customer keeps a live access token until it expires, and must not be
	// able to change the password on the way out.
	it('runs the disabled/deleted gate on the document it read', async () => {
		await funUserUpdatePwd(userId, 'old-password', 'new-password')

		expect(checkUserAuthorizationDisDel).toHaveBeenCalledExactlyOnceWith(stored)
	})

	it('does not re-authenticate when that gate refuses', async () => {
		checkUserAuthorizationDisDel.mockImplementationOnce(() => {
			throw new Error('disabled')
		})

		await expect(funUserUpdatePwd(userId, 'old-password', 'new-password')).rejects.toThrow('disabled')
		expect(compareHashAsync).not.toHaveBeenCalled()
	})

	// The re-authentication step, and the reason this mutation takes the old password at all: an
	// access token is a bearer credential, and proving knowledge of the current password is what
	// stops a stolen one from being upgraded into permanent ownership of the account.
	it('answers 401 — the same error as a missing account — when the old password is wrong', async () => {
		compareHashAsync.mockResolvedValueOnce(false)

		expect(await rejection(funUserUpdatePwd(userId, 'wrong-password', 'new-password'))).toEqual({
			title: 'Unauthorized',
			status: 401
		})
		expect(encryptPassword).not.toHaveBeenCalled()
		expect(userUpdateOne).not.toHaveBeenCalled()
	})

	// `modifiedCount` here, unlike the profile save: the hash is salted and the document was read a
	// moment ago, so it cannot match what is stored — anything but 1 means the write did not land.
	it('answers 500 when the write did not land', async () => {
		updateExec.mockResolvedValueOnce({ matchedCount: 1, modifiedCount: 0 })

		expect(await rejection(funUserUpdatePwd(userId, 'old-password', 'new-password'))).toEqual({
			title: 'Internal Server Error',
			status: 500
		})
	})
})
