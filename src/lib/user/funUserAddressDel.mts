import { throwInternalError } from '@axiumine/koa-utils/graphQL/throw/throwInternalError'
import { User } from '@thedoctorweb_agency/marketplace-common/models/MongoDB/User'
import { Types } from 'mongoose'

/**
 * Removes one address, and clears `defaultAddress` in the same write if it pointed at it.
 *
 * ⚠️ **This is an aggregation-pipeline update, and it has to be one.** The `user` collection validator
 * is `$and: [ {$jsonSchema}, {$expr} ]`, and the `$expr` half refuses any document whose
 * `defaultAddress` is neither missing nor present in `addresses[]._id`. So a plain
 * `$pull` of the default address is **rejected by the database** — correctly — and the pointer has to
 * be cleared by the same operation that removes the element it names. An update document cannot do
 * that: `$unset` is unconditional, and there is no way to say "only if it equals this id".
 *
 * The two stages run in order against one document, atomically:
 *
 * 1. `$filter` rebuilds `addresses` without the element. This is `$pull` written as a pipeline —
 *    `$pull` is an update operator and is not available inside one.
 * 2. `$cond` re-writes `defaultAddress` to itself, or to `$$REMOVE` — the aggregation way to say "omit
 *    this field from the output document", which is what `$unset` means and what the validator wants.
 *    The `$eq` is against the *incoming* `addressId`, not against the array, because stage 1 has
 *    already removed the element it would be compared to.
 *
 * ⚠️ Note `'$$REMOVE'`, two dollars. One is a field path to a field called `REMOVE` and evaluates to
 * missing, which by coincidence produces the same document here — and silently stops working the day
 * anything else in the pipeline needs the same trick with a value to preserve.
 *
 * The alternatives, both rejected: reading the document first and deciding in Node opens a window
 * where a concurrent `userDefaultAddressSet` lands between the read and the write, and two sequential
 * `updateOne` calls widen that window and leave the document *invalid* in between, which the validator
 * would refuse anyway.
 *
 * `$$REMOVE` on a document whose `defaultAddress` is already absent is a no-op, so the else-branch of
 * the `$cond` never needs a missing-field case of its own.
 */
export async function funUserAddressDel(_id: Types.ObjectId, addressId: Types.ObjectId) {
	const ret = await User.updateOne({ _id: _id, 'addresses._id': addressId }, [
		{
			$set: {
				addresses: {
					$filter: {
						input: '$addresses',
						cond: { $ne: ['$$this._id', addressId] }
					}
				}
			}
		},
		{
			$set: {
				defaultAddress: {
					$cond: [{ $eq: ['$defaultAddress', addressId] }, '$$REMOVE', '$defaultAddress']
				}
			}
		}
	]).exec()

	// `modifiedCount`: the filter matched an address, so the array must have shrunk. Anything else is
	// a write that did not land, and the customer must not be told an address is gone when it is not.
	if (ret.modifiedCount !== 1) {
		throwInternalError()
	}
}
