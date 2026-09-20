import { makeAuthCtx } from '@lib/auth/makeAuthCtx.mts'
import { Types } from 'mongoose'
import { describe, expect, it } from 'vitest'

const OID = '507f1f77bcf86cd799439011'

describe('makeAuthCtx', () => {
	// Redis stores everything as strings; the rest of the service expects a real ObjectId, so this
	// is where the conversion has to happen — resolvers must never re-parse it.
	it('turns the Redis hash into the node-side context, rehydrating _id as an ObjectId', () => {
		// tier is required on IRedisDataUser (it's how the boundary asserts the session before this
		// function ever runs) but makeAuthCtx drops it — hence no assertion on it below.
		const user = makeAuthCtx({ _id: OID, email: 'cliente@marketplace.test', tier: 'user' })

		expect(user._id).toBeInstanceOf(Types.ObjectId)
		expect(user._id.toHexString()).toBe(OID)
		expect(user.email).toBe('cliente@marketplace.test')
	})

	// ⚠️ The tier is asserted at the boundary and then dropped, on purpose: with no slot for it in the
	// context, no resolver can be written that re-decides authorisation from the session instead of
	// from the ownership guard in front of it. This assertion is what keeps it dropped.
	it('drops the tier rather than carrying it into the resolvers', () => {
		const user = makeAuthCtx({ _id: OID, email: 'cliente@marketplace.test', tier: 'user' } as never)

		expect('tier' in user).toBe(false)
		expect(Object.keys(user).sort()).toEqual(['_id', 'email'])
	})

	// No `onboardingStep`, unlike the ShopOwner service's version of this function. A customer has no
	// onboarding and `IRedisDataUserCommon` has no field for one — a branch here to keep the two
	// symmetrical would be inventing a flow, and would copy an unrelated key out of the session.
	it('does not copy an onboardingStep across even if the session carries one', () => {
		const user = makeAuthCtx({ _id: OID, email: 'cliente@marketplace.test', onboardingStep: '2' } as never)

		expect('onboardingStep' in user).toBe(false)
	})
})
