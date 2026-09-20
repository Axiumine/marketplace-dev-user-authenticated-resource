import { validateUserAddress } from '@lib/validate/validateUserAddress.mts'
import { validateUserPersonalData } from '@lib/validate/validateUserPersonalData.mts'
import { GraphQLError } from 'graphql'
import { describe, expect, it } from 'vitest'

/** Same reason as in fields.test.mts: `message` is the HTTP title, the field name is in the extensions. */
function rejection(fn: () => unknown) {
	try {
		fn()
	} catch (e) {
		return (e as GraphQLError).extensions.description
	}

	return expect.unreachable('the call was expected to throw')
}

const ADDRESS = {
	street: '1 main street',
	postalCode: '02109',
	city: 'Boston',
	province: 'MA'
}

const TODAY = new Date('2026-08-07T00:00:00.000Z')

describe('validateUserAddress', () => {
	// The exact key set, not just the values: every optional field is *spread in* rather than
	// assigned `undefined`, because the BSON serialiser writes an explicit `undefined` as `null` and
	// `null` fails the element's `additionalProperties: false` shape. A `label: undefined` here would
	// look identical to this test's values and take the whole write down at runtime.
	it('answers the street block alone when nothing optional was sent', () => {
		const address = validateUserAddress({ ...ADDRESS })

		expect(address).toEqual({ street: '1 main street', postalCode: '02109', city: 'Boston', province: 'MA' })
		expect(Object.keys(address).sort()).toEqual(['city', 'postalCode', 'province', 'street'])
	})

	it('trims every text field on the way in', () => {
		const address = validateUserAddress({ ...ADDRESS, street: '  1 main street ', city: ' Boston ' })

		expect(address.street).toBe('1 main street')
		expect(address.city).toBe('Boston')
	})

	// Upper-cased server-side so `mi` and `MI` are one value in the database rather than two that
	// sort apart and compare unequal. The pattern accepts either case precisely so this can happen.
	it('upper-cases a lower-case province rather than refusing it', () => {
		expect(validateUserAddress({ ...ADDRESS, province: 'ma' }).province).toBe('MA')
	})

	it('refuses a postal code that is not 5 digits', () => {
		expect(rejection(() => validateUserAddress({ ...ADDRESS, postalCode: '2010' }))).toBe(
			'postalCode: the postal code is 5 digits'
		)
	})

	it('refuses a province that is not the 2-letter code', () => {
		expect(rejection(() => validateUserAddress({ ...ADDRESS, province: 'MIL' }))).toBe(
			'province: the province is the 2-letter code'
		)
	})

	it('refuses a missing street', () => {
		expect(rejection(() => validateUserAddress({ ...ADDRESS, street: '   ' }))).toBe('street: field required')
	})

	// 250, not the 100 the same field carries on `company`: the customer's street address is built
	// from geo.js's `address({ maxLength: 250 })`, so copying the company's number here would reject
	// an address the database accepts.
	it('accepts a 250-character street and refuses a 251-character one', () => {
		expect(validateUserAddress({ ...ADDRESS, street: 'a'.repeat(250) }).street).toHaveLength(250)
		expect(rejection(() => validateUserAddress({ ...ADDRESS, street: 'a'.repeat(251) }))).toBe('street: max 250 characters')
	})

	it('caps the city at 100 characters', () => {
		expect(rejection(() => validateUserAddress({ ...ADDRESS, city: 'a'.repeat(101) }))).toBe('city: max 100 characters')
	})

	it('keeps a label that was filled in, capped at 50 characters', () => {
		expect(validateUserAddress({ ...ADDRESS, label: '  Casa ' }).label).toBe('Casa')
		expect(rejection(() => validateUserAddress({ ...ADDRESS, label: 'a'.repeat(51) }))).toBe('label: max 50 characters')
	})

	it.each([
		['undefined', undefined],
		['null', null],
		['blank', '   ']
	])('omits the label key entirely when it is %s', (_desc, label) => {
		expect('label' in validateUserAddress({ ...ADDRESS, label })).toBe(false)
	})

	// `type` is not accepted from the client — it has exactly one legal value, so asking for it is
	// only a way to receive `point` and fail the write. It is stamped here.
	it('stamps the GeoJSON type and validates the coordinates', () => {
		const address = validateUserAddress({ ...ADDRESS, position: { coordinates: [9.19, 45.46] } })

		expect(address.position).toEqual({ type: 'Point', coordinates: [9.19, 45.46] })
	})

	// `== null` on purpose: absent and explicitly null both mean "this address has no point", and an
	// address typed by hand has none until it is re-picked from the geocoder's autocomplete. A
	// `!= null` here would hand `null.coordinates` to the coordinate check and answer a 500.
	it.each([
		['undefined', undefined],
		['null', null]
	])('omits the position key entirely when it is %s', (_desc, position) => {
		expect('position' in validateUserAddress({ ...ADDRESS, position })).toBe(false)
	})

	it('refuses a position whose coordinates are out of range', () => {
		expect(rejection(() => validateUserAddress({ ...ADDRESS, position: { coordinates: [9.19, 120] } }))).toBe(
			'position.coordinates: latitude outside -90..90'
		)
	})

	// No `_id` is read from the input even when one is sent: the element id is minted server-side and
	// is what `defaultAddress` names, so accepting one would let a client aim the pointer at an
	// address it does not own.
	it('never carries an _id across from the input', () => {
		const address = validateUserAddress({ ...ADDRESS, _id: 'ffffffffffffffffffffffff' } as never)

		expect('_id' in address).toBe(false)
	})
})

describe('validateUserPersonalData', () => {
	// Same key-set rule as the address, one level up: `$set: { personalData }` replaces the whole
	// sub-document, so a `birth: undefined` becomes a stored `null` and fails the collection.
	it('answers the two required names alone when nothing else was sent', () => {
		const personalData = validateUserPersonalData({ firstName: ' Mark ', lastName: ' Rivers ' }, TODAY)

		expect(personalData).toEqual({ firstName: 'Mark', lastName: 'Rivers' })
		expect(Object.keys(personalData).sort()).toEqual(['firstName', 'lastName'])
	})

	it('refuses a blank first name', () => {
		expect(rejection(() => validateUserPersonalData({ firstName: '  ', lastName: 'Rivers' }, TODAY))).toBe(
			'firstName: field required'
		)
	})

	it('refuses a blank last name', () => {
		expect(rejection(() => validateUserPersonalData({ firstName: 'Mark', lastName: '' }, TODAY))).toBe(
			'lastName: field required'
		)
	})

	it('caps both names at 100 characters', () => {
		expect(rejection(() => validateUserPersonalData({ firstName: 'a'.repeat(101), lastName: 'Rivers' }, TODAY))).toBe(
			'firstName: max 100 characters'
		)
		expect(rejection(() => validateUserPersonalData({ firstName: 'Mark', lastName: 'a'.repeat(101) }, TODAY))).toBe(
			'lastName: max 100 characters'
		)
	})

	it('keeps a birth date that belongs to somebody of age', () => {
		const date = new Date('2008-08-07T00:00:00.000Z')
		const personalData = validateUserPersonalData({ firstName: 'Mark', lastName: 'Rivers', birth: { date } }, TODAY)

		expect(personalData.birth).toEqual({ date })
	})

	// The majority rule is a *service*-level one: the collection constrains `birth.date` to a date
	// and nothing more, so this is the only place it is enforced.
	it('refuses a birth date belonging to a minor, against the `today` it was handed', () => {
		const date = new Date('2008-08-08T00:00:00.000Z')

		expect(rejection(() => validateUserPersonalData({ firstName: 'Mark', lastName: 'Rivers', birth: { date } }, TODAY))).toBe(
			'birth.date: you must be of age (at least 18)'
		)
	})

	// `== null`: GraphQL sends an explicitly cleared object as `null`, and absent means the same
	// thing. `!= null` would read `null.date` and answer a 500 instead of saving a profile.
	it.each([
		['undefined', undefined],
		['null', null]
	])('omits the birth key entirely when it is %s', (_desc, birth) => {
		expect('birth' in validateUserPersonalData({ firstName: 'Mark', lastName: 'Rivers', birth }, TODAY)).toBe(false)
	})

	it('keeps the three contacts that were filled in', () => {
		const personalData = validateUserPersonalData(
			{
				firstName: 'Mark',
				lastName: 'Rivers',
				contacts: { mobile: ' 3331234567 ', landline: '021234567', email: ' cliente@marketplace.test ' }
			},
			TODAY
		)

		expect(personalData.contacts).toEqual({
			mobile: '3331234567',
			landline: '021234567',
			email: 'cliente@marketplace.test'
		})
	})

	// One filled contact and two cleared ones — the case the whole spread-instead-of-assign rule
	// exists for. A cleared landline arrives as `null`; assigned rather than spread it would be
	// stored as `null` and refused by a `bsonType: 'string'` property, losing the mobile with it.
	it('drops the cleared contacts and keeps the filled one', () => {
		const personalData = validateUserPersonalData(
			{ firstName: 'Mark', lastName: 'Rivers', contacts: { mobile: '3331234567', landline: null, email: '' } },
			TODAY
		)

		expect(personalData.contacts).toEqual({ mobile: '3331234567' })
		expect(Object.keys(personalData.contacts!)).toEqual(['mobile'])
	})

	// No `contacts: {}`. The empty object is legal against the validator, but it is a stored value
	// that means nothing and makes "has this customer given us a number?" two questions.
	it.each([
		['undefined', undefined],
		['null', null],
		['an object with every field cleared', { mobile: null, landline: '', email: undefined }]
	])('omits the contacts key entirely for %s', (_desc, contacts) => {
		const personalData = validateUserPersonalData({ firstName: 'Mark', lastName: 'Rivers', contacts }, TODAY)

		expect('contacts' in personalData).toBe(false)
	})

	// 12, not the 15 an E.164 number can reach — the same number the shop owner's contacts carry,
	// read off the collection rather than assumed.
	it.each([
		['mobile', 'contacts.mobile'],
		['landline', 'contacts.landline']
	])('caps the %s at 12 characters', (field, described) => {
		expect(
			rejection(() =>
				validateUserPersonalData({ firstName: 'Mark', lastName: 'Rivers', contacts: { [field]: '1'.repeat(13) } }, TODAY)
			)
		).toBe(`${described}: max 12 characters`)
	})

	it('refuses a contact email that does not look like one', () => {
		expect(
			rejection(() =>
				validateUserPersonalData({ firstName: 'Mark', lastName: 'Rivers', contacts: { email: 'not-an-email' } }, TODAY)
			)
		).toBe('contacts.email: invalid email address')
	})

	it('does not mutate the object it was handed', () => {
		const input = { firstName: ' Mark ', lastName: 'Rivers', contacts: { mobile: ' 3331234567 ' } }

		validateUserPersonalData(input, TODAY)

		expect(input.firstName).toBe(' Mark ')
		expect(input.contacts.mobile).toBe(' 3331234567 ')
	})
})
