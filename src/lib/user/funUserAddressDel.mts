import { throwInternalError } from '@axiumine/koa-utils/graphQL/throw/throwInternalError'
import { User } from '@axiumine/marketplace-common/models/MongoDB/User'
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
	// ⚠️ **Mongoose casts a filter against the schema; it does not cast anything inside a pipeline
	// stage.** A pipeline is an opaque aggregation expression to it, so the two occurrences of
	// `addressId` below reach MongoDB exactly as they arrive here — and `GraphQLID` resolves to a
	// **string**, whatever `IArgs` claims. `{ $ne: ['$$this._id', '68b1…'] }` compares an ObjectId to a
	// string, which is never equal, so `$filter` kept every element and the write answered
	// `matchedCount: 1, modifiedCount: 0` — a matched document that was not touched. The filter above
	// matched only because that half *is* cast.
	//
	// Coercing here rather than at the resolver keeps the fix where the requirement is: this is the one
	// call on the platform whose argument must be a genuine instance. `new Types.ObjectId(…)` on an
	// ObjectId is a no-op copy, so a caller that already holds one loses nothing.
	const addressObjectId = new Types.ObjectId(addressId)

	const ret = await User.updateOne(
		{ _id: _id, 'addresses._id': addressObjectId },
		[
			{
				$set: {
					addresses: {
						$filter: {
							input: '$addresses',
							cond: { $ne: ['$$this._id', addressObjectId] }
						}
					}
				}
			},
			{
				$set: {
					defaultAddress: {
						$cond: [{ $eq: ['$defaultAddress', addressObjectId] }, '$$REMOVE', '$defaultAddress']
					}
				}
			}
		],
		// ⚠️ **Mongoose 9 refuses an array update unless this is set**, with
		// `Cannot pass an array to query updates unless the 'updatePipeline' option is set.` — thrown
		// before the driver is reached, so it surfaced as a 500 on every single address delete. The
		// unit suite could not see it: it mocks `User.updateOne`, and a mock accepts an array happily.
		//
		// Per query rather than `mongoose.set('updatePipeline', true)` at boot. The global would switch
		// the guard off for every model in the process, and the guard is worth keeping — an array
		// reaching an update by accident is a typo, and everywhere else on this platform it still is.
		{ updatePipeline: true }
	).exec()

	// `modifiedCount`: the filter matched an address, so the array must have shrunk. Anything else is
	// a write that did not land, and the customer must not be told an address is gone when it is not.
	if (ret.modifiedCount !== 1) {
		throwInternalError()
	}
}
