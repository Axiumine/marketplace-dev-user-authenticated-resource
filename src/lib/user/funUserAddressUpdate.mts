import { throwInternalError } from '@axiumine/koa-utils/graphQL/throw/throwInternalError'
import { User } from '@axiumine/marketplace-common/models/MongoDB/User'
import { IUserAddress } from '@axiumine/marketplace-common/models/MongoDBInterfaces/IUserAddress'
import { Types } from 'mongoose'

/**
 * Replaces one element of `addresses` in place.
 *
 * Uses the positional `$` operator, which needs the array named in the *filter* to know which element
 * it points at — `'addresses._id': addressId` is not a redundant re-check of the guard that already
 * ran, it is what makes `addresses.$` resolvable at all.
 *
 * ⚠️ **`_id` is written back explicitly.** `$set` on `addresses.$` replaces the whole element rather
 * than merging into it, and the element schema requires an `_id`, so omitting it produces a document
 * the collection validator refuses. Re-using the *same* id rather than minting one is what keeps
 * `defaultAddress` valid: the pointer names this element, and a new id would leave it dangling — a
 * second rejection, from the `$expr` half of the validator this time.
 *
 * Fields the customer cleared are absent from `address`, which is why they disappear from the stored
 * element. That is the intended behaviour of an edit form and the reason for whole-element
 * replacement over a field-by-field merge.
 */
export async function funUserAddressUpdate(_id: Types.ObjectId, addressId: Types.ObjectId, address: Omit<IUserAddress, '_id'>) {
	const ret = await User.updateOne(
		{ _id: _id, 'addresses._id': addressId },
		{ $set: { 'addresses.$': { ...address, _id: addressId } } }
	).exec()

	// `matchedCount`, like the profile save and for the same reason: re-saving an address unchanged is
	// something a form does, and MongoDB reports it as modified 0.
	if (ret.matchedCount !== 1) {
		throwInternalError()
	}
}
