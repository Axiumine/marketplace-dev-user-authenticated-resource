import { throwInternalError } from '@axiumine/koa-utils/graphQL/throw/throwInternalError'
import { User } from '@axiumine/marketplace-common/models/MongoDB/User'
import { IUserAddress } from '@axiumine/marketplace-common/models/MongoDBInterfaces/IUserAddress'
import { Types } from 'mongoose'

/**
 * Appends one address to the customer's `addresses` and answers its new `_id`.
 *
 * ⚠️ **The id is minted here rather than left to Mongoose.** `updateOne` is a query, so the sub-
 * document default that would otherwise supply an `_id` never runs — a `$push` of an element without
 * one reaches the collection as written and fails the element's `required: ['_id']`. Minting it also
 * gives the mutation something to return, which is the whole reason it answers `OnlyIdType`: the
 * client needs the id to aim `userDefaultAddressSet` at the address it just created, and a bare
 * `Boolean` would force a re-read of the whole account to find it.
 *
 * **`defaultAddress` is deliberately not touched, not even for the first address.** It would be a
 * convenience to point it at address number one automatically, and it would make the pointer a value
 * the customer never chose — "why is this the default?" with no answer, and a second write racing the
 * first on a client that adds two addresses at once. The private area asks.
 */
export async function funUserAddressAdd(_id: Types.ObjectId, address: Omit<IUserAddress, '_id'>): Promise<Types.ObjectId> {
	const addressId = new Types.ObjectId()

	const ret = await User.updateOne({ _id: _id }, { $push: { addresses: { ...address, _id: addressId } } }).exec()

	// `modifiedCount` is sound here where it is wrong for a profile save: a push always changes the
	// array, so anything but 1 means the write did not land and the id about to be returned names
	// nothing.
	if (ret.modifiedCount !== 1) {
		throwInternalError()
	}

	return addressId
}
