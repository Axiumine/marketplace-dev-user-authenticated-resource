import { throwErrorWrongUserInput } from '@axiumine/koa-utils/graphQL/throw/throwErrorWrongUserInput'
import { throwInternalError } from '@axiumine/koa-utils/graphQL/throw/throwInternalError'
import { User } from '@axiumine/marketplace-common/models/MongoDB/User'
import { IUserAddress } from '@axiumine/marketplace-common/models/MongoDBInterfaces/IUserAddress'
import { trusted, Types } from 'mongoose'

/**
 * The most addresses one customer may keep.
 *
 * ⚠️ **A copy, and it has to be one.** The rule is `maxItems: 6` on `addresses` in
 * `marketplace-db-setup/lib/schemas/user.js`; the third copy is `MAX_ADDRESSES` in
 * `marketplace-user/src/features/account/AddressList.tsx`. There is no module all three can import —
 * this service and the migrations repo share no library, and the frontend is a browser bundle that
 * could not require a Node one — so changing the number means changing three files in one piece of
 * work, plus a `collMod` migration for every database already built.
 *
 * **This copy is not the rule.** MongoDB refuses the seventh address whatever this file says; what
 * this number buys is the *shape of the refusal* — a 400 naming the limit instead of a validator
 * failure surfacing as a 500 with nothing in it a customer could act on.
 */
const MAX_ADDRESSES = 6

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
 * ⚠️ **The cap is a clause of the filter, not a count taken beforehand.** Reading the length and then
 * pushing is two round trips with a window between them, and a client that fires two adds at once
 * fits through it — both reads see six, both pushes go, and the document ends up with eight. Written
 * this way the count and the push are one atomic `updateOne`: the document either has room at the
 * instant it is modified or it is not modified at all, and there is nothing to interleave with.
 *
 * ⚠️ **`addresses.5` rather than `$expr: {$lt: [{$size: '$addresses'}, 6]}`, and the reason is not
 * taste.** koa-utils' MongoDB data source sets `mongoose.set('sanitizeFilter', true)` process-wide,
 * and sanitizeFilter *throws* on `$expr` in a filter — the aggregation form fails every call, not
 * only the seventh. `addresses.5` says the same thing in the plain query language: index 5 exists
 * exactly when the array already holds six elements, so requiring it absent is requiring room for one
 * more. It also needs no `$ifNull` — a missing `addresses` has no index 5 either, which is what makes
 * the *first* address addable.
 *
 * ⚠️ **`trusted()` is load-bearing.** sanitizeFilter's other half rewrites any value holding a `$` key
 * into `{$eq: <that object>}`, so an untrusted `{$exists: false}` becomes a search for an element
 * *equal to the literal object* `{$exists: false}` — which matches nothing, and turns the cap into a
 * refusal of every address including the first. It compiles, it runs, and only a test that adds one
 * address catches it.
 *
 * **`matchedCount`, not `modifiedCount`, is what says the cap bit.** The filter has two clauses and a
 * miss on either produces the same zero, so the failing path costs one extra read to find out which:
 * an account that is not there at all is a 500 — the session named it a moment ago — while an account
 * that is there and full is a 400 the private area can put in front of the customer. A 400 rather
 * than a 409, following `funUserUpdatePwd`'s "passwordNew must differ from passwordOld": the request
 * is refused for what it asks relative to the account's state, and this codebase spells that 400.
 *
 * **`defaultAddress` is deliberately not touched, not even for the first address.** It would be a
 * convenience to point it at address number one automatically, and it would make the pointer a value
 * the customer never chose — "why is this the default?" with no answer, and a second write racing the
 * first on a client that adds two addresses at once. The private area asks.
 */
export async function funUserAddressAdd(_id: Types.ObjectId, address: Omit<IUserAddress, '_id'>): Promise<Types.ObjectId> {
	const addressId = new Types.ObjectId()

	const ret = await User.updateOne(
		{ _id: _id, [`addresses.${MAX_ADDRESSES - 1}`]: trusted({ $exists: false }) },
		{ $push: { addresses: { ...address, _id: addressId } } }
	).exec()

	if (ret.matchedCount === 0) {
		// Which half of the filter missed. Paid for only here, on the path that is already failing.
		const found = await User.countDocuments({ _id: _id }).lean()

		if (found === 0) {
			throwInternalError()
		}

		throwErrorWrongUserInput(`addresses: at most ${MAX_ADDRESSES} addresses can be saved`)
	}

	// `modifiedCount` is sound here where it is wrong for a profile save: a push always changes the
	// array, so anything but 1 means the write did not land and the id about to be returned names
	// nothing.
	if (ret.modifiedCount !== 1) {
		throwInternalError()
	}

	return addressId
}
