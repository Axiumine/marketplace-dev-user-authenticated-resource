import { throwInternalError } from '@axiumine/koa-utils/graphQL/throw/throwInternalError'
import { User } from '@axiumine/marketplace-common/models/MongoDB/User'
import { Types } from 'mongoose'

/**
 * Points `defaultAddress` at one of the customer's addresses.
 *
 * ⚠️ **One `$set`, and that is the entire argument for the pointer over a boolean on each element.**
 * With a per-address flag this would be "clear every other address, then set this one" — two writes,
 * or one with two operators, and a window in which zero or two addresses are default if anything
 * interleaves. Here "at most one default" is not a rule being maintained, it is a shape that cannot
 * express a second default, so there is nothing to clear and nothing to race.
 *
 * The dangling case is the one thing a pointer can get wrong, and it is not checked here: the
 * collection validator's `$expr` half refuses a `defaultAddress` that is not in `addresses[]._id`, so
 * a stale id is rejected by MongoDB even if the guard in front of this were removed. The guard turns
 * that rejection into a 403 instead of a 500 — it is the message that improves, not the safety.
 *
 * `matchedCount`: re-setting the default to what it already is is a thing a client does when a button
 * is double-clicked, and MongoDB reports that as modified 0.
 */
export async function funUserDefaultAddressSet(_id: Types.ObjectId, addressId: Types.ObjectId) {
	const ret = await User.updateOne({ _id: _id }, { $set: { defaultAddress: addressId } }).exec()

	if (ret.matchedCount !== 1) {
		throwInternalError()
	}
}
