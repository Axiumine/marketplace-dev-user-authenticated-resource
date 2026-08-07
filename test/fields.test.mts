import { GraphQLError } from 'graphql'
import { describe, expect, it } from 'vitest'

import {
	birthDate,
	coordinate,
	MAX_EMAIL,
	MIN_AGE,
	optionalEmail,
	optionalText,
	requiredText,
	SHAPE_CAP,
	SHAPE_EMAIL,
	SHAPE_PROVINCE,
	textWithFormat
} from '../src/lib/validate/fields.mts'

/**
 * ⚠️ koa-utils splits an error in two, and the half that matters here is not the one `toThrow`
 * reads. `throwGraphQLError(400, 'Bad Request', message)` builds a `GraphQLError` whose `message` is
 * the HTTP *title* and whose `extensions.description` carries the text naming the field — so
 * `.toThrow('street: field required')` never matches, and `.toThrow('Bad Request')` matches every
 * rejection in this file equally, which is no assertion at all. Every one below reads the extensions.
 */
function rejection(fn: () => unknown) {
	try {
		fn()
	} catch (e) {
		const error = e as GraphQLError

		return {
			title: error.message,
			status: (error.extensions.http as { status: number }).status,
			description: error.extensions.description
		}
	}

	return expect.unreachable('the call was expected to throw')
}

describe('bounds', () => {
	// Read off marketplace-db-setup/lib/schemas/user.js, NOT off koa-utils' EMAIL_MAX_LEN of 255:
	// a 251-character address passes that constant and is then refused by the collection, which
	// surfaces as "Document failed validation" and a 500.
	it('caps every email-shaped path at the collection maximum of 250', () => {
		expect(MAX_EMAIL).toBe(250)
	})

	it('is the Italian age of majority', () => {
		expect(MIN_AGE).toBe(18)
	})
})

describe('SHAPE_EMAIL', () => {
	it.each(['a@b.it', 'first.last+tag@sub.domain.co.uk'])('accepts %s', (value) => {
		expect(SHAPE_EMAIL.test(value)).toBe(true)
	})

	// One `@`, a dot in the domain, no whitespace — nothing more. Each rejection below breaks
	// exactly one of those three, so a loosened pattern fails here rather than in the database.
	it.each(['plain', 'no@domain', 'two@@at.it', 'with space@mail.it', 'trailing@mail.it '])('rejects %s', (value) => {
		expect(SHAPE_EMAIL.test(value)).toBe(false)
	})
})

describe('SHAPE_CAP', () => {
	it('accepts exactly 5 digits', () => {
		expect(SHAPE_CAP.test('20100')).toBe(true)
	})

	// Anchored at both ends: without `^` a 4-digit CAP with a prefix would pass, without `$` a
	// 6-digit one would, and both reach a validator that refuses them.
	it.each(['2010', '201000', 'a2010', '20100 '])('rejects %s', (value) => {
		expect(SHAPE_CAP.test(value)).toBe(false)
	})
})

describe('SHAPE_PROVINCE', () => {
	// Both cases accepted on purpose — `validateUserAddress` upper-cases on the way in rather than
	// refusing a lower-case sigla, which would be a validation error over something the server fixes.
	it.each(['MI', 'mi', 'Mi'])('accepts %s', (value) => {
		expect(SHAPE_PROVINCE.test(value)).toBe(true)
	})

	it.each(['M', 'MIL', 'M1', '20'])('rejects %s', (value) => {
		expect(SHAPE_PROVINCE.test(value)).toBe(false)
	})
})

describe('requiredText', () => {
	it('trims and returns the value', () => {
		expect(requiredText('  via Roma 1  ', 'street', 250)).toBe('via Roma 1')
	})

	// The one place the whole envelope is pinned: a 400 titled 'Bad Request', with the field name in
	// the description. Every other rejection in this file asserts the description alone.
	it('refuses an empty string with a 400 naming the field', () => {
		expect(rejection(() => requiredText('', 'street', 250))).toEqual({
			title: 'Bad Request',
			status: 400,
			description: 'street: field required'
		})
	})

	// Trimmed *before* the emptiness test: a box holding four spaces is empty, not four characters
	// long, and the collection would refuse the stored value anyway.
	it('refuses whitespace only', () => {
		expect(rejection(() => requiredText('    ', 'street', 250)).description).toBe('street: field required')
	})

	it('accepts a value of exactly the maximum length', () => {
		expect(requiredText('a'.repeat(250), 'street', 250)).toHaveLength(250)
	})

	it('refuses one character past the maximum, naming the limit', () => {
		expect(rejection(() => requiredText('a'.repeat(251), 'street', 250)).description).toBe('street: max 250 characters')
	})

	// The other half of "trimmed before the length test": 250 characters plus a trailing space is a
	// 250-character address, not an overflow.
	it('does not count trimmed whitespace towards the maximum', () => {
		expect(requiredText(`${'a'.repeat(250)}  `, 'street', 250)).toHaveLength(250)
	})
})

describe('optionalText', () => {
	// All four blanks answer `undefined` — never '' and never null. Both of those reach a
	// `bsonType: 'string'` property as a value of the wrong type and take the whole write down,
	// which is how a cleared landline box loses an otherwise valid profile save.
	it.each([
		['undefined', undefined],
		['null', null],
		['an empty string', ''],
		['whitespace only', '   ']
	])('answers undefined for %s', (_desc, value) => {
		expect(optionalText(value, 'contacts.landline', 12)).toBeUndefined()
	})

	it('trims and returns a filled value', () => {
		expect(optionalText('  0212345  ', 'contacts.landline', 12)).toBe('0212345')
	})

	it('accepts a value of exactly the maximum length', () => {
		expect(optionalText('a'.repeat(12), 'contacts.landline', 12)).toHaveLength(12)
	})

	it('refuses one character past the maximum', () => {
		expect(rejection(() => optionalText('a'.repeat(13), 'contacts.landline', 12)).description).toBe(
			'contacts.landline: max 12 characters'
		)
	})
})

describe('textWithFormat', () => {
	it('trims before matching, and answers the trimmed value', () => {
		expect(textWithFormat('  20100 ', 'postalCode', SHAPE_CAP, 'the postal code is 5 digits')).toBe('20100')
	})

	it('reports what was expected rather than what was received', () => {
		expect(rejection(() => textWithFormat('2010', 'postalCode', SHAPE_CAP, 'the postal code is 5 digits')).description).toBe(
			'postalCode: the postal code is 5 digits'
		)
	})

	// No separate emptiness test in the helper, deliberately: every SHAPE_* is anchored and matches
	// at least one character, so '' fails the pattern and gets the message that says what was wanted.
	it('refuses an empty string through the pattern, with the same message', () => {
		expect(
			rejection(() => textWithFormat('', 'province', SHAPE_PROVINCE, 'the province is the 2-letter code')).description
		).toBe('province: the province is the 2-letter code')
	})
})

describe('optionalEmail', () => {
	it.each([
		['undefined', undefined],
		['null', null],
		['an empty string', '']
	])('answers undefined for %s', (_desc, value) => {
		expect(optionalEmail(value, 'contacts.email')).toBeUndefined()
	})

	it('trims and returns a valid address', () => {
		expect(optionalEmail(' cliente@marketplace.test ', 'contacts.email')).toBe('cliente@marketplace.test')
	})

	it('refuses an address that does not look like one', () => {
		expect(rejection(() => optionalEmail('cliente@marketplace', 'contacts.email')).description).toBe(
			'contacts.email: invalid email address'
		)
	})

	// Length first, shape second: a 251-character *valid* address is refused for its length, and the
	// message says so. The two checks are separate helpers and the order between them is observable.
	it('refuses an address past MAX_EMAIL before looking at its shape', () => {
		const long = `${'a'.repeat(MAX_EMAIL)}@marketplace.test`

		expect(rejection(() => optionalEmail(long, 'contacts.email')).description).toBe(
			`contacts.email: max ${MAX_EMAIL} characters`
		)
	})
})

describe('birthDate', () => {
	const TODAY = new Date('2026-08-07T00:00:00.000Z')
	const UNDERAGE = `birth.date: you must be of age (at least ${MIN_AGE})`

	it('refuses a date that is not a date', () => {
		expect(rejection(() => birthDate(new Date('not a date'), 'birth.date', TODAY)).description).toBe('birth.date: invalid date')
	})

	// The boundary is inclusive: somebody turning 18 today is 18 today. This is also what kills a
	// mutant that applies the end-of-month correction unconditionally — it would move the limit back
	// to 31 July and refuse this date.
	it('accepts somebody whose eighteenth birthday is today', () => {
		const date = new Date('2008-08-07T00:00:00.000Z')

		expect(birthDate(date, 'birth.date', TODAY)).toBe(date)
	})

	it('accepts somebody comfortably of age', () => {
		const date = new Date('1980-01-01T00:00:00.000Z')

		expect(birthDate(date, 'birth.date', TODAY)).toBe(date)
	})

	it('refuses somebody whose eighteenth birthday is tomorrow', () => {
		expect(rejection(() => birthDate(new Date('2008-08-08T00:00:00.000Z'), 'birth.date', TODAY)).description).toBe(UNDERAGE)
	})

	// The leap-day case the `setUTCDate(0)` line exists for. On 29 February 2044, `Date.UTC(2026, 1,
	// 29)` is not 29 February 2026 — that year has 28 days — and rolls forward to 1 March, which
	// would accept somebody born on 1 March 2026 whose eighteenth birthday is tomorrow. Stepping back
	// to the last day of February is what makes the limit 28 February instead.
	it('does not let a 29 February limit roll forward into March', () => {
		const leapDay = new Date('2044-02-29T00:00:00.000Z')

		expect(birthDate(new Date('2026-02-28T00:00:00.000Z'), 'birth.date', leapDay)).toBeInstanceOf(Date)
		expect(rejection(() => birthDate(new Date('2026-03-01T00:00:00.000Z'), 'birth.date', leapDay)).description).toBe(UNDERAGE)
	})

	// UTC on both sides. `birth.date` arrives from graphql-scalars' `Date` as midnight UTC, and
	// reading the calendar parts locally would move the boundary by the server's offset — putting the
	// birthday on the wrong side of it for half the world.
	it('reads the boundary in UTC, not in the server local zone', () => {
		const lateOnTheBoundary = new Date('2026-08-07T23:30:00.000Z')
		const date = new Date('2008-08-07T00:00:00.000Z')

		expect(birthDate(date, 'birth.date', lateOnTheBoundary)).toBe(date)
	})
})

describe('coordinate', () => {
	const LNG_OUT = 'position.coordinates: longitude outside -180..180'
	const LAT_OUT = 'position.coordinates: latitude outside -90..90'

	it('answers the pair, longitude first', () => {
		expect(coordinate([9.19, 45.46], 'position.coordinates')).toEqual([9.19, 45.46])
	})

	it.each([
		['one', [9.19]],
		['three', [9.19, 45.46, 120]],
		['none', []]
	])('refuses %s coordinate(s)', (_desc, value) => {
		expect(rejection(() => coordinate(value as number[], 'position.coordinates')).description).toBe(
			'position.coordinates: exactly 2 coordinates are required [longitude, latitude]'
		)
	})

	it.each([
		['the western limit', -180],
		['the eastern limit', 180]
	])('accepts %s of longitude', (_desc, lng) => {
		expect(coordinate([lng, 0], 'position.coordinates')).toEqual([lng, 0])
	})

	it.each([
		['below the western limit', -180.000001],
		['above the eastern limit', 180.000001]
	])('refuses a longitude %s', (_desc, lng) => {
		expect(rejection(() => coordinate([lng, 0], 'position.coordinates')).description).toBe(LNG_OUT)
	})

	// The two axes get *different* bounds, matching the collection: a single ±180 rule for both
	// would let a latitude of 120 reach a 2dsphere index that cannot key it.
	it.each([
		['the southern limit', -90],
		['the northern limit', 90]
	])('accepts %s of latitude', (_desc, lat) => {
		expect(coordinate([0, lat], 'position.coordinates')).toEqual([0, lat])
	})

	it.each([
		['below the southern limit', -90.000001],
		['above the northern limit', 90.000001],
		['inside the longitude range but outside its own', 120]
	])('refuses a latitude %s', (_desc, lat) => {
		expect(rejection(() => coordinate([0, lat], 'position.coordinates')).description).toBe(LAT_OUT)
	})

	// GraphQLFloat refuses these at the schema boundary, so through the API the isFinite tests look
	// redundant. Without them both range comparisons answer `false` for NaN and wave it through, and
	// this helper is exported and called directly — one that is only correct from one call site is
	// worth less than the comparison costs.
	it.each([
		['NaN', NaN],
		['Infinity', Infinity]
	])('refuses %s as a longitude', (_desc, lng) => {
		expect(rejection(() => coordinate([lng, 0], 'position.coordinates')).description).toBe(LNG_OUT)
	})

	it.each([
		['NaN', NaN],
		['-Infinity', -Infinity]
	])('refuses %s as a latitude', (_desc, lat) => {
		expect(rejection(() => coordinate([0, lat], 'position.coordinates')).description).toBe(LAT_OUT)
	})
})
