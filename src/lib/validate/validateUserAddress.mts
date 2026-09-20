import { IUserAddress } from '@axiumine/marketplace-common/models/MongoDBInterfaces/IUserAddress'
import {
	coordinate,
	optionalText,
	requiredText,
	SHAPE_POSTAL_CODE,
	SHAPE_PROVINCE,
	textWithFormat
} from '@lib/validate/fields.mjs'

/*
 * The bounds of one element of `user.addresses`, read off marketplace-db-setup/lib/schemas/user.js.
 *
 * ⚠️ `MAX_ADDRESS` is **250**, not the 100 the same field carries on `company` — the customer's street
 * address is built from `geo.js`'s `address({ maxLength: 250 })`, exactly like the shop owner's home
 * address, so that one street-address widget serves both frontends. Copying the company's number here
 * would reject an address the database accepts.
 *
 * ⚠️ **Since ADR-029 these three numbers are the ONLY thing enforcing them.** Every member of a saved
 * address is `binData` at rest, and a `$jsonSchema` cannot measure the length of a ciphertext — the
 * validator that used to be the backstop now only checks the BSON type. A bound relaxed or dropped
 * here is not caught one layer down any more; it is simply gone, and a client can store a megabyte
 * where a street was meant to go.
 */
const MAX_ADDRESS = 250
const MAX_CITY = 100
const MAX_LABEL = 50

/** The only value `position.type` may hold — the Mongoose model declares it as an enum of one. */
const POSITION_TYPE = 'Point'

/**
 * One saved address as it arrives from the client: the street block, an optional label, and a point
 * that is **optional and coordinates only**.
 *
 * ⚠️ **No `_id`, and none is accepted.** The element id is minted server-side and is what
 * `user.defaultAddress` names; taking one from the client would let it aim the pointer at an address
 * it does not own. An update names the address it edits with a separate `_id: ID!` argument and an
 * ownership guard in front of it.
 *
 * ⚠️ **No `default` flag.** Making an address the default is a write to a *sibling* field at the
 * document root, and it has its own mutation. Accepting a boolean here would mean two writes wearing
 * one name.
 *
 * `position` is coordinates only because `type` has exactly one legal value: asking a client for a
 * constant is only a way to receive `point` and fail the write.
 */
// `label` is named in the Omit alongside `_id` and `position`: IUserAddress itself declares
// `label?: string` (no null), and leaving it out of the Omit would intersect that with the `string |
// null` below into plain `string` — silently dropping the null this type exists to accept.
export type IUserAddressInput = Omit<IUserAddress, '_id' | 'position' | 'label'> & {
	label?: string | null
	position?: { coordinates: number[] } | null
}

/**
 * Checks and normalises one address before it is pushed into, or spliced over, `user.addresses`.
 *
 * Returns a **new** object without an `_id` — the caller mints one for an add and reuses the stored
 * one for an update. Both write paths replace the whole element (`$push`, or `$set` on
 * `addresses.$`), so the same rule as `validateUserPersonalData` applies to every optional field: it
 * is spread in rather than assigned `undefined`, because the BSON serialiser encodes an explicit
 * `undefined` as `null` and `null` fails the element's `additionalProperties: false` shape.
 */
export const validateUserAddress = (address: IUserAddressInput): Omit<IUserAddress, '_id'> => {
	const label = optionalText(address.label, 'label', MAX_LABEL)

	// `== null` on purpose: absent and explicitly null both mean "this address has no point". An
	// address typed by hand has none until it is re-picked from the geocoder's autocomplete.
	const position = address.position == null ? undefined : address.position

	return {
		street: requiredText(address.street, 'street', MAX_ADDRESS),
		postalCode: textWithFormat(address.postalCode, 'postalCode', SHAPE_POSTAL_CODE, 'the postal code is 5 digits'),
		city: requiredText(address.city, 'city', MAX_CITY),
		// Upper-cased on the way in, so `mi` and `MI` are one value in the database rather than two that
		// sort apart and compare unequal. The pattern accepts either case on purpose — refusing a
		// lower-case province code would be a validation error over something the server can simply fix.
		province: textWithFormat(address.province, 'province', SHAPE_PROVINCE, 'the province is the 2-letter code').toUpperCase(),
		...(label === undefined ? {} : { label }),
		...(position === undefined
			? {}
			: {
					position: {
						type: POSITION_TYPE,
						coordinates: coordinate(position.coordinates, 'position.coordinates')
					}
				})
	}
}
