import type { IContextUserAuthenticatedResource } from '@lib/auth/IContextUserAuthenticatedResource.mts'
import { GraphQLError } from 'graphql'
import { Types } from 'mongoose'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const funUserAddressAdd = vi.fn()
const funUserAddressDel = vi.fn()
const funUserAddressUpdate = vi.fn()
const funUserDefaultAddressSet = vi.fn()
const funUserDel = vi.fn()
const funUserPersonalDataUpdate = vi.fn()
const funUserUpdatePwd = vi.fn()
const throwIfUserDontOwnAddress = vi.fn()
const captureException = vi.fn()
const endEverySession = vi.fn()

vi.mock('@lib/user/funUserAddressAdd.mjs', () => ({ funUserAddressAdd }))
vi.mock('@lib/user/funUserAddressDel.mjs', () => ({ funUserAddressDel }))
vi.mock('@lib/user/funUserAddressUpdate.mjs', () => ({ funUserAddressUpdate }))
vi.mock('@lib/user/funUserDefaultAddressSet.mjs', () => ({ funUserDefaultAddressSet }))
vi.mock('@lib/user/funUserDel.mjs', () => ({ funUserDel }))
vi.mock('@lib/user/funUserPersonalDataUpdate.mjs', () => ({ funUserPersonalDataUpdate }))
vi.mock('@lib/user/funUserUpdatePwd.mjs', () => ({ funUserUpdatePwd }))
vi.mock('@lib/user/throwIfUserDontOwnAddress.mjs', () => ({ throwIfUserDontOwnAddress }))
vi.mock('@lib/auth/endEverySession.mjs', () => ({ endEverySession }))
// The plain-Error arm of tryCatchRethrow reports before it rethrows; Sentry is never initialised in
// the unit project, so this is both a stub and the assertion target for that arm.
vi.mock('@sentry/node', () => ({ captureException }))

const { userAddressAdd } = await import('../src/graphQLApi/schema/mutations/userAddressAdd.mts')
const { userAddressDel } = await import('../src/graphQLApi/schema/mutations/userAddressDel.mts')
const { userAddressUpdate } = await import('../src/graphQLApi/schema/mutations/userAddressUpdate.mts')
const { userDefaultAddressSet } = await import('../src/graphQLApi/schema/mutations/userDefaultAddressSet.mts')
const { userDel } = await import('../src/graphQLApi/schema/mutations/userDel.mts')
const { userPersonalDataUpdate } = await import('../src/graphQLApi/schema/mutations/userPersonalDataUpdate.mts')
const { userUpdatePwd } = await import('../src/graphQLApi/schema/mutations/userUpdatePwd.mts')

const userId = new Types.ObjectId('507f1f77bcf86cd799439011')
const addressId = new Types.ObjectId('507f1f77bcf86cd799439022')

const ctx = { state: { user: { _id: userId } } } as unknown as IContextUserAuthenticatedResource

const ADDRESS = { street: '1 main street', postalCode: '02109', city: 'Boston', province: 'MA' }
const PERSONAL_DATA = { firstName: 'Mark', lastName: 'Rivers' }

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
	funUserAddressAdd.mockReset().mockResolvedValue(addressId)
	funUserAddressDel.mockReset().mockResolvedValue(undefined)
	funUserAddressUpdate.mockReset().mockResolvedValue(undefined)
	funUserDefaultAddressSet.mockReset().mockResolvedValue(undefined)
	funUserDel.mockReset().mockResolvedValue(undefined)
	funUserPersonalDataUpdate.mockReset().mockResolvedValue(undefined)
	funUserUpdatePwd.mockReset().mockResolvedValue(undefined)
	throwIfUserDontOwnAddress.mockReset().mockResolvedValue(undefined)
	captureException.mockReset()
	endEverySession.mockReset().mockResolvedValue(undefined)
})

describe('userAddressAdd', () => {
	// `OnlyIdType` rather than the `Boolean` its three siblings answer, and the asymmetry is
	// deliberate: the id is new information the client cannot derive. It is what
	// `userDefaultAddressSet` is aimed at next, and two saved addresses can be identical, so
	// re-reading the account and guessing which element is the new one does not work.
	it('validates, saves and answers the new element id', async () => {
		await expect(userAddressAdd.resolve(null, { address: { ...ADDRESS } }, ctx)).resolves.toEqual({ _id: addressId })

		expect(funUserAddressAdd).toHaveBeenCalledExactlyOnceWith(userId, ADDRESS)
	})

	// No ownership guard, and none is possible: the address does not exist yet and the account it
	// lands on is the session's. The absence is the assertion.
	it('never takes an account id from the caller', async () => {
		await userAddressAdd.resolve(null, { address: { ...ADDRESS } }, ctx)

		expect(throwIfUserDontOwnAddress).not.toHaveBeenCalled()
		expect(funUserAddressAdd.mock.calls[0][0]).toBe(userId)
	})

	// Validation runs *outside* the try, so a rejection surfaces as the 400 it already is instead of
	// being rewrapped — and nothing reaches the database.
	it('refuses an invalid address before writing anything', async () => {
		expect(await rejection(userAddressAdd.resolve(null, { address: { ...ADDRESS, postalCode: '1' } }, ctx))).toEqual({
			title: 'Bad Request',
			status: 400
		})
		expect(funUserAddressAdd).not.toHaveBeenCalled()
	})

	// ⚠️ `return await` inside the try, not `return`: without the await the promise escapes the try
	// and the catch can never run, so a rejection surfaces as an unhandled rejection instead of the
	// error `tryCatchRethrow` makes of it. This is the test that fails if the await is dropped.
	it('routes a database failure through tryCatchRethrow rather than letting it escape', async () => {
		funUserAddressAdd.mockRejectedValueOnce(new Error('write failed'))

		expect(await rejection(userAddressAdd.resolve(null, { address: { ...ADDRESS } }, ctx))).toEqual({
			title: 'Internal Server Error',
			status: 500
		})
		expect(captureException).toHaveBeenCalledTimes(1)
	})
})

describe('userAddressDel', () => {
	it('checks ownership, then deletes, and answers true', async () => {
		await expect(userAddressDel.resolve(null, { _id: addressId }, ctx)).resolves.toBe(true)

		expect(throwIfUserDontOwnAddress).toHaveBeenCalledExactlyOnceWith(userId, addressId)
		expect(funUserAddressDel).toHaveBeenCalledExactlyOnceWith(userId, addressId)
	})

	// ⚠️ The `_id` names an *address* and is the one value here a client chooses, so the guard is the
	// only thing between this mutation and deleting a stranger's address. Nothing may run before it.
	it('does not delete when the address belongs to somebody else', async () => {
		throwIfUserDontOwnAddress.mockRejectedValueOnce(new Error('Forbidden'))

		await expect(userAddressDel.resolve(null, { _id: addressId }, ctx)).rejects.toThrow('Forbidden')
		expect(funUserAddressDel).not.toHaveBeenCalled()
	})

	it('rewraps a database failure as a 500', async () => {
		funUserAddressDel.mockRejectedValueOnce(new Error('write failed'))

		expect(await rejection(userAddressDel.resolve(null, { _id: addressId }, ctx))).toEqual({
			title: 'Internal Server Error',
			status: 500
		})
	})
})

describe('userAddressUpdate', () => {
	it('checks ownership, validates, replaces and answers true', async () => {
		await expect(userAddressUpdate.resolve(null, { _id: addressId, address: { ...ADDRESS } }, ctx)).resolves.toBe(true)

		expect(throwIfUserDontOwnAddress).toHaveBeenCalledExactlyOnceWith(userId, addressId)
		expect(funUserAddressUpdate).toHaveBeenCalledExactlyOnceWith(userId, addressId, ADDRESS)
	})

	// The guard runs *before* validation, and the order is the point: a validation error on an
	// address the caller does not own would tell them their id named something real.
	it('refuses a foreign address before it even looks at the payload', async () => {
		throwIfUserDontOwnAddress.mockRejectedValueOnce(new Error('Forbidden'))

		await expect(
			userAddressUpdate.resolve(null, { _id: addressId, address: { ...ADDRESS, postalCode: '1' } }, ctx)
		).rejects.toThrow('Forbidden')
		expect(funUserAddressUpdate).not.toHaveBeenCalled()
	})

	it('refuses an invalid address on an owned id', async () => {
		expect(
			await rejection(userAddressUpdate.resolve(null, { _id: addressId, address: { ...ADDRESS, province: 'MIL' } }, ctx))
		).toEqual({ title: 'Bad Request', status: 400 })
		expect(funUserAddressUpdate).not.toHaveBeenCalled()
	})

	it('rewraps a database failure as a 500', async () => {
		funUserAddressUpdate.mockRejectedValueOnce(new Error('write failed'))

		expect(await rejection(userAddressUpdate.resolve(null, { _id: addressId, address: { ...ADDRESS } }, ctx))).toEqual({
			title: 'Internal Server Error',
			status: 500
		})
	})
})

describe('userDefaultAddressSet', () => {
	// ⚠️ The guard is the *whole* check, and that is sound rather than thin: the collection validator
	// refuses a `defaultAddress` that names nothing, and the guard has just established that this one
	// names an address of this account. Without it, a customer could aim the pointer at an id they do
	// not own — which the validator would happily accept only if it did not exist in their array, so
	// the failure mode is a silent 500, not a refusal.
	it('checks ownership, then points the default at the address', async () => {
		await expect(userDefaultAddressSet.resolve(null, { _id: addressId }, ctx)).resolves.toBe(true)

		expect(throwIfUserDontOwnAddress).toHaveBeenCalledExactlyOnceWith(userId, addressId)
		expect(funUserDefaultAddressSet).toHaveBeenCalledExactlyOnceWith(userId, addressId)
	})

	it('does not move the pointer when the address is not the caller’s', async () => {
		throwIfUserDontOwnAddress.mockRejectedValueOnce(new Error('Forbidden'))

		await expect(userDefaultAddressSet.resolve(null, { _id: addressId }, ctx)).rejects.toThrow('Forbidden')
		expect(funUserDefaultAddressSet).not.toHaveBeenCalled()
	})

	it('rewraps a database failure as a 500', async () => {
		funUserDefaultAddressSet.mockRejectedValueOnce(new Error('write failed'))

		expect(await rejection(userDefaultAddressSet.resolve(null, { _id: addressId }, ctx))).toEqual({
			title: 'Internal Server Error',
			status: 500
		})
	})
})

describe('userDel', () => {
	// ⚠️ No `_id` argument and no ownership guard, and on this mutation the absence is sharper than
	// anywhere else on the tier: every customer authenticates against the same collection and the
	// platform has no role field, so an account id accepted here would make this "close any customer's
	// account". The account is the session's.
	it('closes the session’s own account and answers true', async () => {
		await expect(userDel.resolve(null, {}, ctx)).resolves.toBe(true)

		expect(funUserDel).toHaveBeenCalledExactlyOnceWith(userId)
		expect(throwIfUserDontOwnAddress).not.toHaveBeenCalled()
	})

	/*
	 * ⚠️ **Every session ends, and only after the stamp landed.** Revoking first would log a customer
	 * out of every device for a closure that then failed; not revoking at all would leave a closed
	 * account with live sessions still inside it, which is the one outcome this mutation exists to
	 * prevent. The caller's own session goes with the rest — which is also what makes a second call
	 * unreachable, since the next request they send is refused by the auth middleware.
	 */
	it('ends every session the account holds, after the account was closed', async () => {
		await expect(userDel.resolve(null, {}, ctx)).resolves.toBe(true)

		expect(endEverySession).toHaveBeenCalledExactlyOnceWith(ctx)
		expect(endEverySession.mock.invocationCallOrder[0]).toBeGreaterThan(funUserDel.mock.invocationCallOrder[0])
	})

	// The revoke is not attempted when the stamp did not land. An account that is still open must keep
	// the sessions its customer is legitimately using.
	it('revokes nothing when the account was not closed', async () => {
		funUserDel.mockRejectedValueOnce(
			new GraphQLError('Oops', { extensions: { http: { status: 410 }, description: 'account already closed' } })
		)

		await rejection(userDel.resolve(null, {}, ctx))

		expect(endEverySession).not.toHaveBeenCalled()
	})

	/*
	 * ⚠️ **A revoke that fails fails the mutation.** Answering `true` here would tell a customer their
	 * account is closed while every device they were signed in on still holds a working token — and the
	 * document really is stamped, so the lie would be about the half that matters.
	 */
	it('fails loudly when the sessions cannot be ended, rather than answering true', async () => {
		endEverySession.mockRejectedValueOnce(new Error('redis down'))

		expect(await rejection(userDel.resolve(null, {}, ctx))).toEqual({ title: 'Internal Server Error', status: 500 })
	})

	// The 410 a second call answers must reach the client as a 410: flattened to a 500 it would read as
	// "we broke" instead of "this account is already closed".
	it('preserves the status of an error the lib already classified', async () => {
		funUserDel.mockRejectedValueOnce(
			new GraphQLError('Oops', { extensions: { http: { status: 410 }, description: 'account already closed' } })
		)

		expect(await rejection(userDel.resolve(null, {}, ctx))).toEqual({ title: 'Oops', status: 410 })
		expect(captureException).not.toHaveBeenCalled()
	})

	it('rewraps an unclassified failure as a 500', async () => {
		funUserDel.mockRejectedValueOnce(new Error('mongo down'))

		expect(await rejection(userDel.resolve(null, {}, ctx))).toEqual({ title: 'Internal Server Error', status: 500 })
		expect(captureException).toHaveBeenCalledTimes(1)
	})
})

describe('userPersonalDataUpdate', () => {
	it('validates against the current clock and saves', async () => {
		await expect(userPersonalDataUpdate.resolve(null, { personalData: { ...PERSONAL_DATA } }, ctx)).resolves.toBe(true)

		expect(funUserPersonalDataUpdate).toHaveBeenCalledExactlyOnceWith(userId, PERSONAL_DATA)
	})

	// `new Date()` is read here rather than inside the validator, which is what lets the age boundary
	// be a parameter the unit tests move instead of a clock they have to freeze. This is the one test
	// that pins the resolver actually passing *today* — a frozen or missing date would make every
	// birth date of age forever.
	it('hands the validator the real current date', async () => {
		const minor = new Date()
		minor.setUTCFullYear(minor.getUTCFullYear() - 17)

		expect(
			await rejection(userPersonalDataUpdate.resolve(null, { personalData: { ...PERSONAL_DATA, birth: { date: minor } } }, ctx))
		).toEqual({ title: 'Bad Request', status: 400 })
		expect(funUserPersonalDataUpdate).not.toHaveBeenCalled()
	})

	it('refuses an invalid payload before writing anything', async () => {
		expect(
			await rejection(userPersonalDataUpdate.resolve(null, { personalData: { firstName: ' ', lastName: 'Rivers' } }, ctx))
		).toEqual({ title: 'Bad Request', status: 400 })
		expect(funUserPersonalDataUpdate).not.toHaveBeenCalled()
	})

	it('rewraps a database failure as a 500', async () => {
		funUserPersonalDataUpdate.mockRejectedValueOnce(new Error('write failed'))

		expect(await rejection(userPersonalDataUpdate.resolve(null, { personalData: { ...PERSONAL_DATA } }, ctx))).toEqual({
			title: 'Internal Server Error',
			status: 500
		})
	})
})

describe('userUpdatePwd', () => {
	// ⚠️ No `_id` argument, deliberately: every customer authenticates against the same collection and
	// the platform has no role field, so accepting one would make this "change any customer's
	// password". The account is the session's, and the current password is what proves the caller is
	// more than a stolen access token.
	it('changes the password of the session’s own account', async () => {
		await expect(userUpdatePwd.resolve(null, { passwordOld: 'old-password', passwordNew: 'new-password' }, ctx)).resolves.toBe(
			true
		)

		expect(funUserUpdatePwd).toHaveBeenCalledExactlyOnceWith(userId, 'old-password', 'new-password')
	})

	/*
	 * ⚠️ **Every session ends, and only after the write landed**. A password change made because
	 * someone else is believed to be inside the account is the remedy it appears to be only if the
	 * intruder's session dies with it — and the order is the other half: revoking first would log a
	 * customer out of every device for a change that then failed validation.
	 */
	it('ends every session the account holds, after the password write', async () => {
		await expect(userUpdatePwd.resolve(null, { passwordOld: 'old-password', passwordNew: 'new-password' }, ctx)).resolves.toBe(
			true
		)

		expect(endEverySession).toHaveBeenCalledExactlyOnceWith(ctx)
		expect(endEverySession.mock.invocationCallOrder[0]).toBeGreaterThan(funUserUpdatePwd.mock.invocationCallOrder[0])
	})

	// The revoke is not attempted when the write did not happen. A wrong current password answers 401 and
	// must not, on its way out, log the customer out of the devices they are legitimately using.
	it('revokes nothing when the password write failed', async () => {
		funUserUpdatePwd.mockRejectedValueOnce(
			new GraphQLError('Unauthorized', { extensions: { http: { status: 401 }, description: 'wrong password' } })
		)

		await rejection(userUpdatePwd.resolve(null, { passwordOld: 'wrong', passwordNew: 'new-password' }, ctx))

		expect(endEverySession).not.toHaveBeenCalled()
	})

	/*
	 * ⚠️ **A revoke that fails fails the mutation.** The alternative — answering `true` and reporting the
	 * Redis error somewhere else — tells the customer their password change ended every other session when
	 * it did not, which is worse than an error they can retry.
	 */
	it('fails loudly when the sessions cannot be ended, rather than answering true', async () => {
		endEverySession.mockRejectedValueOnce(new Error('redis down'))

		expect(
			await rejection(userUpdatePwd.resolve(null, { passwordOld: 'old-password', passwordNew: 'new-password' }, ctx))
		).toEqual({
			title: 'Internal Server Error',
			status: 500
		})
	})

	// A GraphQLError keeps its own status through tryCatchRethrow — the 401 a wrong current password
	// answers must not be flattened into a 500, or the client cannot tell "you typed it wrong" from
	// "we broke".
	it('preserves the status of an error the lib already classified', async () => {
		funUserUpdatePwd.mockRejectedValueOnce(
			new GraphQLError('Unauthorized', { extensions: { http: { status: 401 }, description: 'wrong password' } })
		)

		expect(await rejection(userUpdatePwd.resolve(null, { passwordOld: 'wrong', passwordNew: 'new-password' }, ctx))).toEqual({
			title: 'Unauthorized',
			status: 401
		})
		expect(captureException).not.toHaveBeenCalled()
	})

	it('rewraps an unclassified failure as a 500', async () => {
		funUserUpdatePwd.mockRejectedValueOnce(new Error('mongo down'))

		expect(
			await rejection(userUpdatePwd.resolve(null, { passwordOld: 'old-password', passwordNew: 'new-password' }, ctx))
		).toEqual({
			title: 'Internal Server Error',
			status: 500
		})
		expect(captureException).toHaveBeenCalledTimes(1)
	})
})
