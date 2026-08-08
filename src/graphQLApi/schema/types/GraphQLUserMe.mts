import { GraphQLBaseAddressFrag } from '@axiumine/marketplace-common/schema/types/fragments/GraphQLBaseAddressFrag'
import { GraphQLPositionFrag } from '@axiumine/marketplace-common/schema/types/fragments/GraphQLPositionFrag'
import { GraphQLID, GraphQLList, GraphQLNonNull, GraphQLObjectType, GraphQLString } from 'graphql'
import { GraphQLDateTime } from 'graphql-scalars'

/**
 * The signed-in customer's own account, as the private area renders it.
 *
 * ⚠️ **It is called `Me`, not `User`, and the name is doing work.** There is no query on this tier
 * that reads *another* account — a customer is the only thing they may look at — so a type named
 * `GraphQLUser` would invite a second resolver that takes an `_id`, and the whole tier is built on the
 * session being the only identity in play.
 *
 * ⚠️ **`login` is flattened to one `email` field, and nothing else from it is exposed.** The stored
 * sub-document also holds the bcrypt hash, and `resetPwd` / `emailVerify` sit next to it carrying the
 * secrets that let someone take the account over. None of the three has a field here, so no query
 * against this type can be written that returns them — the projection in `me` is the second layer, not
 * the only one.
 *
 * `personalData` is nullable because the collection makes it optional: registration is an email and a
 * password, and an account that never fills in a name still works.
 *
 * `defaultAddress` is an `ID` and not an address. It is a pointer into `addresses`, the client already
 * has that array, and resolving it server-side would send the same address twice and give a client two
 * places to disagree about which one is default.
 */
export const GraphQLUserMe = new GraphQLObjectType({
	name: 'GraphQLUserMe',
	fields: () => ({
		_id: { type: new GraphQLNonNull(GraphQLID) },
		email: { type: new GraphQLNonNull(GraphQLString) },
		personalData: { type: GraphQLUserPersonalData },
		// NonNull list of NonNull elements, and empty when nothing has been saved — `me` defaults it, so
		// a client never has to distinguish "no addresses" from "the field was not sent".
		addresses: { type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(GraphQLUserAddress))) },
		defaultAddress: { type: GraphQLID },
		registeredAt: { type: new GraphQLNonNull(GraphQLDateTime) }
	})
})

/**
 * ⚠️ **Only `firstName` and `lastName` are NonNull**, matching the collection. `GraphQLShopOwnerById`
 * makes every one of its equivalents NonNull because that tier collects a full record at onboarding;
 * a customer types a name into a profile page and leaves the rest.
 */
const GraphQLUserPersonalData = new GraphQLObjectType({
	name: 'GraphQLUserPersonalData',
	fields: () => ({
		firstName: { type: new GraphQLNonNull(GraphQLString) },
		lastName: { type: new GraphQLNonNull(GraphQLString) },
		birth: { type: GraphQLUserBirth },
		contacts: { type: GraphQLUserContacts }
	})
})

const GraphQLUserBirth = new GraphQLObjectType({
	name: 'GraphQLUserBirth',
	fields: () => ({
		date: { type: new GraphQLNonNull(GraphQLDateTime) }
	})
})

/** Every member optional: `login.email` is the credential, these are other ways to be reached. */
const GraphQLUserContacts = new GraphQLObjectType({
	name: 'GraphQLUserContacts',
	fields: () => ({
		mobile: { type: GraphQLString },
		landline: { type: GraphQLString },
		email: { type: GraphQLString }
	})
})

/**
 * One element of `addresses`.
 *
 * ⚠️ **`_id` is NonNull here and absent from the *input* type.** The client needs it — it is what
 * `userAddressUpdate`, `userAddressDel` and `userDefaultAddressSet` name an address by — and it must
 * never be accepted on the way in, or a client could aim `defaultAddress` at an address it does not
 * own. Read-only by construction rather than by a check.
 *
 * `position` is nullable for the same reason as on the shop owner: the point arrives when the address
 * is picked from the geocoder's autocomplete, and one typed by hand has no map until it is re-picked.
 */
const GraphQLUserAddress = new GraphQLObjectType({
	name: 'GraphQLUserAddress',
	fields: () => ({
		_id: { type: new GraphQLNonNull(GraphQLID) },
		...GraphQLBaseAddressFrag,
		label: { type: GraphQLString },
		position: { type: GraphQLUserPosition }
	})
})

const GraphQLUserPosition = new GraphQLObjectType({
	name: 'GraphQLUserPosition',
	fields: () => ({
		...GraphQLPositionFrag
	})
})
