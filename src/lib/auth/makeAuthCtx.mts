import { IRedisDataUser } from '@thedoctorweb_agency/marketplace-common/others/Redis/IRedisDataUser'
import { IRedisDataUserForNode } from '@thedoctorweb_agency/marketplace-common/others/Redis/IRedisDataUserForNode'
import { Types } from 'mongoose'

/**
 * Turns the Redis session hash into the in-process shape the resolvers read.
 *
 * Two fields and no conditional. The ShopOwner service's version of this function has an
 * `if (typeof redData.onboardingStep !== 'undefined')` branch because a shop owner's session carries
 * how far they got through onboarding. A customer has no onboarding, `IRedisDataUserCommon` has no
 * field for one, and adding a branch here to keep the two symmetrical would be inventing a flow.
 *
 * ⚠️ **`tier` is deliberately dropped.** It was asserted at the boundary in
 * `authorizationAuthenticatedResourceHandler` and has done its job; `IRedisDataUserForNode` has no
 * slot for it on purpose, so no resolver can be written that re-decides authorisation from the
 * session rather than from the ownership guard in front of it.
 */
export function makeAuthCtx(redData: IRedisDataUser): IRedisDataUserForNode {
	return {
		_id: new Types.ObjectId(redData._id),
		email: redData.email
	}
}
