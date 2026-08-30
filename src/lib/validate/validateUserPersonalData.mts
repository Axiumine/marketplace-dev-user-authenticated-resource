import { IUserPersonalData } from '@axiumine/marketplace-common/models/MongoDBInterfaces/IUserPersonalData'
import { birthDate, optionalEmail, optionalText, requiredText } from '@lib/validate/fields.mjs'

/*
 * The `user` collection's own bounds, read off marketplace-db-setup/lib/schemas/user.js. Named rather
 * than inlined because both phone caps are easy to assume and wrong: 12, not the 15 an E.164 number
 * can reach, and the same number the shop owner's contacts carry.
 */
const MAX_FIRST_NAME = 100
const MAX_LAST_NAME = 100
const MAX_PHONE = 12

/**
 * What the customer's `personalData` input carries.
 *
 * ⚠️ **Almost everything is optional here, where `IShopOwnerPersonalDataInput` requires the lot.** The
 * collection requires `firstName` and `lastName` and no more, and the difference is the tier: a shop
 * owner is onboarded by an admin collecting a full record, a customer types a name into a profile
 * page and leaves the rest for later. `birth` and `contacts` are nullable as well as optional, because
 * GraphQL sends an explicitly cleared object as `null`.
 *
 * ⚠️ **No `address`.** The customer's addresses are a top-level array with their own mutations —
 * `GraphQLInputUserPersonalData` has no slot for one, deliberately, so that "save my profile" cannot
 * silently overwrite an entry in that array.
 *
 * `_id` is omitted from the input: it is the phantom `_id?: boolean` flag `IUserPersonalData` carries
 * so `User.mts`'s inline `type: { _id: false, … }` type-checks, and it is not a field anybody writes.
 */
export type IUserPersonalDataInput = {
	firstName: string
	lastName: string
	birth?: { date: Date } | null
	contacts?: {
		mobile?: string | null
		landline?: string | null
		email?: string | null
	} | null
}

/**
 * Checks and normalises an incoming `personalData` before it replaces the stored one.
 *
 * Returns a **new** object rather than mutating the argument, and the caller writes that. Every
 * optional field is *spread in* rather than assigned `undefined`, and that is the part that matters
 * for the write: `$set: { personalData }` replaces the whole sub-document, the BSON serialiser encodes
 * an explicit `undefined` as `null`, and `null` is what a `bsonType: 'string'` property rejects — so a
 * cleared landline box would otherwise take an entire valid profile save down with it.
 *
 * `contacts` is spread as a whole for the same reason one level up. A customer who fills in none of
 * the three gets **no `contacts` key at all**, not an empty object: the empty object is legal against
 * the validator, but it is a stored value that means nothing, and it makes "has this customer given us
 * a number?" two questions instead of one.
 *
 * `today` is threaded in rather than read from the clock here so the majority boundary is testable
 * from both sides without freezing time.
 */
export const validateUserPersonalData = (personalData: IUserPersonalDataInput, today: Date): IUserPersonalData => {
	// `== null` on purpose: absent and explicitly null both mean "the customer did not give this", and
	// the GraphQL input makes both objects nullable, so the client can send either.
	const birth = personalData.birth == null ? undefined : { date: birthDate(personalData.birth.date, 'birth.date', today) }

	const mobile = optionalText(personalData.contacts?.mobile, 'contacts.mobile', MAX_PHONE)
	const landline = optionalText(personalData.contacts?.landline, 'contacts.landline', MAX_PHONE)
	const email = optionalEmail(personalData.contacts?.email, 'contacts.email')

	const contacts = {
		...(mobile === undefined ? {} : { mobile }),
		...(landline === undefined ? {} : { landline }),
		...(email === undefined ? {} : { email })
	}

	return {
		firstName: requiredText(personalData.firstName, 'firstName', MAX_FIRST_NAME),
		lastName: requiredText(personalData.lastName, 'lastName', MAX_LAST_NAME),
		...(birth === undefined ? {} : { birth }),
		...(Object.keys(contacts).length === 0 ? {} : { contacts })
	}
}
