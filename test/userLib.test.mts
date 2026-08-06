import { GraphQLError } from 'graphql'
import { Types } from 'mongoose'
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
vi.mock('@thedoctorweb_agency/marketplace-common/models/MongoDB/User', () => ({
	User: { updateOne: userUpdateOne, countDocuments: userCountDocuments, findById: userFindById }
}))
vi.mock('@thedoctorweb_agency/marketplace-common/others/checkUserAuthorizationDisDel', () => ({ checkUserAuthorizationDisDel }))
// bcrypt at SALT_ROUNDS=14 is ~1s per hash. Both sides are stubbed: what is under test here is the
// order of the checks, not the KDF.
vi.mock('@axiumine/koa-utils/lib/hash', () => ({ compareHashAsync }))
vi.mock('@axiumine/koa-utils/lib/encryptPassword', () => ({ encryptPassword }))

const { funUserAddressAdd } = await import('../src/lib/user/funUserAddressAdd.mts')
const { funUserAddressDel } = await import('../src/lib/user/funUserAddressDel.mts')
const { funUserAddressUpdate } = await import('../src/lib/user/funUserAddressUpdate.mts')
const { funUserDefaultAddressSet } = await import('../src/lib/user/funUserDefaultAddressSet.mts')
const { funUserPersonalDataUpdate } = await import('../src/lib/user/funUserPersonalDataUpdate.mts')
const { funUserUpdatePwd } = await import('../src/lib/user/funUserUpdatePwd.mts')
const { throwIfUserDontOwnAddress } = await import('../src/lib/user/throwIfUserDontOwnAddress.mts')

const userId = new Types.ObjectId('507f1f77bcf86cd799439011')
const addressId = new Types.ObjectId('507f1f77bcf86cd799439022')

const address = { street: 'via Roma 1', postalCode: '20100', city: 'Milano', province: 'MI' } as never
const personalData = { firstName: 'Mario', lastName: 'Rossi' } as never

const updateExec = vi.fn()

/** `countDocuments()` answers a Query; the guard ends it with `.lean()`. */
function counting(found: number) {
	return { lean: vi.fn().mockResolvedValue(found) }
}

/** `findById()` answers a Query; `funUserUpdatePwd` ends it with `.select().lean()`. */
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
		expect(filter).toEqual({ _id: userId })
		expect(update).toEqual({ $push: { addresses: { ...address, _id: minted } } })
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
	})
})

describe('funUserAddressDel', () => {
	// An aggregation pipeline and not a `$pull`, because the validator's `$expr` half refuses a
	// document whose `defaultAddress` names nothing — so removing the default address and clearing
	// the pointer have to be one operation. Both stages are pinned.
	it('filters the element out and clears the pointer in one write', async () => {
		await funUserAddressDel(userId, addressId)

		const [filter, pipeline] = userUpdateOne.mock.calls[0]

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
