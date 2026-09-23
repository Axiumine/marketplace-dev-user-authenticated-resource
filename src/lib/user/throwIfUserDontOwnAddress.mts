import { throwErrorWrongUserInput } from '@axiumine/koa-utils/graphQL/throw/throwErrorWrongUserInput'
import { throwForbiddenError } from '@axiumine/koa-utils/graphQL/throw/throwForbiddenError'
import { User } from '@axiumine/marketplace-common/models/MongoDB/User'
import { Types } from 'mongoose'

/**
 * Refuses the request unless `addressId` names an element of *this* customer's `addresses`.
 *
 * The same guard `throwIfShopOwnerDontOwnCompany` is on the shop-owner tier, and it exists for the
 * same reason: every mutation below takes an address id from the client, and without this the id is
 * an unauthenticated pointer into the collection. Here the ownership question is cheaper than there —
 * an address is a sub-document, so "does this customer own it?" is answered by whether the array on
 * their own document contains it, and there is no second collection to join.
 *
 * ⚠️ **It is still not redundant with the writes.** `userAddressUpdate` and `userAddressDel` both
 * filter on `{ _id: userId, 'addresses._id': addressId }`, so an address belonging to someone else
 * cannot be touched by them either — but a filter that matches nothing reports `matchedCount: 0`,
 * which is indistinguishable from "the address was deleted a moment ago" and would surface as a 500.
 * Asking first turns that into the 403 it is.
 *
 * **403 and not 404**, deliberately: the two answers together would tell a caller which address ids
 * exist on the platform, and an id that exists is one worth guessing again.
 *
 * No `deleted` filter on the *address* — an element of `addresses` is removed outright rather than
 * soft-deleted, so there is no retired state to skip. The customer's own `deleted` is not checked
 * either: `authorizationAuthenticatedResourceHandler` never sees it, and it is the login path's job.
 */
export async function throwIfUserDontOwnAddress(userId: Types.ObjectId, addressId: Types.ObjectId) {
	// `addressId` is a bare GraphQLID, so nothing upstream has confirmed it is a well-formed ObjectId.
	// Left to Mongoose, a malformed one fails the cast on the query below with a raw CastError — no
	// try/catch here or at the three call sites to route it through tryCatchRethrow/Sentry, so it would
	// reach the client verbatim, a third, distinguishable response next to the 403 above and the 404
	// this file deliberately never sends. Reject it with the platform's clean 400 before any query runs.
	if (!Types.ObjectId.isValid(addressId)) {
		throw throwErrorWrongUserInput('addressId is not a valid id')
	}

	const found = await User.countDocuments({ _id: userId, 'addresses._id': addressId }).lean()

	if (found === 0) {
		throw throwForbiddenError()
	}
}
