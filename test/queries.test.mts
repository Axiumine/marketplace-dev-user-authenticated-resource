import { GraphQLError } from 'graphql'
import { Types } from 'mongoose'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { IContextUserAuthenticatedResource } from '../src/lib/auth/IContextUserAuthenticatedResource.mts'

const findById = vi.fn()

vi.mock('@thedoctorweb_agency/marketplace-common/models/MongoDB/User', () => ({ User: { findById } }))

const { me } = await import('../src/graphQLApi/schema/queries/me.mts')

const userId = new Types.ObjectId('507f1f77bcf86cd799439011')
const addressId = new Types.ObjectId('507f1f77bcf86cd799439022')
const registeredAt = new Date('2026-08-05T10:00:00.000Z')

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
	login: { email: 'cliente@marketplace.test' },
	personalData: { firstName: 'Mario', lastName: 'Rossi' },
	addresses: [{ _id: addressId, street: 'via Roma 1', postalCode: '20100', city: 'Milano', province: 'MI' }],
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
			personalData: { firstName: 'Mario', lastName: 'Rossi' },
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
