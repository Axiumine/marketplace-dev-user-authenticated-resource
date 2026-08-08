import { throwErrorWrongUserInput } from '@axiumine/koa-utils/graphQL/throw/throwErrorWrongUserInput'

/**
 * The field-level checks this tier's mutations run before touching MongoDB.
 *
 * They exist because the `user` collection's `$jsonSchema` is the only thing that would otherwise
 * enforce any of this, and a validator rejection surfaces as a raw driver error: `Document failed
 * validation`, with the offending path buried in `errInfo`. Apollo turns that into a 500 with no usable
 * message, so a customer who typed a four-digit postal code is told the server has broken. Every helper below
 * raises a 400 naming the field instead.
 *
 * They also **normalise**, and that half is not cosmetic. `additionalProperties: false` plus
 * `bsonType: 'string'` means an optional contact sent as `null` — which is exactly what a cleared text
 * box serialises to over GraphQL — fails the write. `optionalText` answers `undefined` for anything
 * blank, so the key is simply absent from the `$set` document.
 *
 * ⚠️ This is a **trimmed copy** of the admin service's `fields.mts`, not a shared module — there is no
 * shared validation library between the services. The slug, VAT number, unique-code and exact-length
 * helpers it also carries have no caller on this tier and were dropped rather than left dead: an
 * unreachable export still has to be covered, and the gate is at 100%. The bounds below are read off
 * `marketplace-db-setup/lib/schemas/user.js`, and where they coincide with the shop owner's it is
 * because the two collections declare the same number, not because one was copied.
 */

/** Every email-shaped path in `user`. NOT koa-utils' `EMAIL_MAX_LEN` of 255 — the collection caps at 250. */
export const MAX_EMAIL = 250

/**
 * Deliberately loose: one `@`, a dot in the domain, no whitespace.
 *
 * A stricter address grammar belongs nowhere near a validator whose only job is to keep obvious
 * rubbish out of the database — RFC 5322 admits addresses this would be wrong to reject, and the real
 * proof an address exists is a delivered email, which registration on 4027 already does.
 */
export const SHAPE_EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export const SHAPE_POSTAL_CODE = /^\d{5}$/
export const SHAPE_PROVINCE = /^[A-Za-z]{2}$/

/**
 * Age of majority.
 *
 * ⚠️ **A service-level rule, not a database one.** The `user` collection validator constrains
 * `personalData.birth.date` to a date and nothing more, so a document written by any other path is
 * accepted at any age. It is enforced here because a customer who orders is contracting, and it is
 * checked at the same boundary as everything else rather than being relied on further down.
 */
export const MIN_AGE = 18

/**
 * A required text field: trimmed, non-empty, within the collection's `maxLength`.
 *
 * Trimmed *before* the length test, so 250 characters of address plus a trailing space is an address
 * and not an overflow, and a box holding four spaces is empty rather than four characters long.
 */
export const requiredText = (value: string, field: string, max: number): string => {
	const clean = value.trim()

	if (clean.length === 0) throwErrorWrongUserInput(`${field}: field required`)
	if (clean.length > max) throwErrorWrongUserInput(`${field}: max ${max} characters`)

	return clean
}

/**
 * An optional text field.
 *
 * Blank comes back `undefined` — never `''` and never `null`. Both of those reach the collection as a
 * value of the wrong type for a `bsonType: 'string'` property and fail the whole write, which is how a
 * cleared landline number takes an otherwise valid save down with it.
 */
export const optionalText = (value: string | null | undefined, field: string, max: number): string | undefined => {
	const clean = (value ?? '').trim()

	if (clean.length === 0) return undefined
	if (clean.length > max) throwErrorWrongUserInput(`${field}: max ${max} characters`)

	return clean
}

/**
 * A required text field that also has to match a shape.
 *
 * No separate empty test: every `SHAPE_*` above is anchored and matches at least one character, so the
 * empty string fails the pattern and gets the same 400 with a message that says what was expected.
 */
export const textWithFormat = (value: string, field: string, shape: RegExp, expected: string): string => {
	const clean = value.trim()

	if (!shape.test(clean)) throwErrorWrongUserInput(`${field}: ${expected}`)

	return clean
}

/**
 * An optional email — `personalData.contacts.email` is the only one on this tier.
 *
 * Optional because it is a *second* address to be reached on: the credential is `login.email`, which no
 * mutation here can touch. Blank comes back `undefined`, like every other optional field.
 */
export const optionalEmail = (value: string | null | undefined, field: string): string | undefined => {
	const clean = optionalText(value, field, MAX_EMAIL)

	return clean === undefined ? undefined : textWithFormat(clean, field, SHAPE_EMAIL, 'invalid email address')
}

/**
 * The latest birth date that is already `MIN_AGE` years old on `today`.
 *
 * UTC throughout. `birth.date` arrives from graphql-scalars' `Date`, which parses `YYYY-MM-DD` to
 * midnight UTC, so reading the calendar parts locally would move the boundary by the server's offset
 * and put the birthday on the wrong side of it for half the world.
 *
 * `Date.UTC` rolls an impossible day forward — 29 February minus 18 years lands in a non-leap year and
 * becomes 1 March, which would accept someone whose eighteenth birthday is tomorrow. `setUTCDate(0)`
 * steps back to the last day of the intended month instead.
 */
const limitBirth = (today: Date): Date => {
	const month = today.getUTCMonth()
	const limit = new Date(Date.UTC(today.getUTCFullYear() - MIN_AGE, month, today.getUTCDate()))

	if (limit.getUTCMonth() !== month) limit.setUTCDate(0)

	return limit
}

/**
 * A birth date that is a real date and belongs to someone of age.
 *
 * `today` is a parameter rather than a `new Date()` inside, so the boundary can be tested on both sides
 * without freezing the clock. The boundary is inclusive: someone turning 18 today is 18 today.
 */
export const birthDate = (date: Date, field: string, today: Date): Date => {
	if (Number.isNaN(date.getTime())) throwErrorWrongUserInput(`${field}: invalid date`)

	if (date.getTime() > limitBirth(today).getTime()) {
		throwErrorWrongUserInput(`${field}: you must be of age (at least ${MIN_AGE})`)
	}

	return date
}

/**
 * A GeoJSON coordinate pair, `[longitude, latitude]` — longitude first.
 *
 * The two axes get different bounds, matching the `user` collection validator: ±180 for longitude, ±90
 * for latitude. A single ±180 rule for both would let a latitude of 120 through to a `2dsphere` index
 * that cannot key it.
 *
 * `Number.isFinite` looks redundant because `GraphQLFloat` refuses NaN and Infinity at the schema
 * boundary, and through the API it is. It stays because without it the two range tests answer `false`
 * for NaN and wave it through — this helper is exported and unit-tested on its own, and one that is
 * only correct when called from one place is worth less than the comparison costs.
 */
export const coordinate = (coordinates: readonly number[], field: string): number[] => {
	if (coordinates.length !== 2) {
		throwErrorWrongUserInput(`${field}: exactly 2 coordinates are required [longitude, latitude]`)
	}

	const [lng, lat] = coordinates as [number, number]

	if (!Number.isFinite(lng) || lng < -180 || lng > 180) throwErrorWrongUserInput(`${field}: longitude outside -180..180`)
	if (!Number.isFinite(lat) || lat < -90 || lat > 90) throwErrorWrongUserInput(`${field}: latitude outside -90..90`)

	return [lng, lat]
}
