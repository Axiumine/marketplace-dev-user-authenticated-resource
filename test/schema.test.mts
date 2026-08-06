import { getIntrospectionQuery, graphql, GraphQLSchema } from 'graphql'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// The resolvers pull the models in transitively; nothing connects, but the Redis client is
// imported by the auth context type chain and needs a stub in the unit project.
vi.mock('@axiumine/koa-utils/dataSources/Redis', () => ({ redisClient: {} }))

type IntrospectedField = { name: string; description: string | null; args: Array<{ name: string }> }
type IntrospectedType = { name: string; fields: IntrospectedField[] | null; inputFields: Array<{ name: string }> | null }

let schema: GraphQLSchema
let result: Awaited<ReturnType<typeof graphql>>
let types: Map<string, IntrospectedType>

// Imported and assembled fresh inside beforeEach, not at module top level or beforeAll: several of
// the `new GraphQLObjectType({...})` calls this transitively reaches throw synchronously (graphql-js
// validates `name` in the constructor) when a mutant blanks their `name`. A throw during a top-level
// import, or inside `beforeAll`, only SKIPS every test in the file — Vitest marks the suite's tests
// "skipped", not "failed", because the hook that was supposed to prepare them never finished.
// Stryker cannot attribute a skip to any one test, so it reports the mutant Survived even though the
// whole file plainly broke. A throw inside `beforeEach` fails only the one test that was about to
// run, which Stryker does attribute correctly.
beforeEach(async () => {
	const { default: QueriesApi } = await import('../src/graphQLApi/schema/queries.mts')
	const { default: MutationsApi } = await import('../src/graphQLApi/schema/mutations.mts')

	schema = new GraphQLSchema({ query: QueriesApi, mutation: MutationsApi })

	// One real introspection run: it validates the assembled schema AND forces every
	// `fields: () => ({...})` thunk in the type files, which is what actually covers them.
	result = await graphql({ schema, source: getIntrospectionQuery() })
	const introspection = result.data?.__schema as unknown as { types: IntrospectedType[] }
	types = new Map(introspection.types.map((t) => [t.name, t]))
})

function fieldsOf(typeName: string): string[] {
	return (types.get(typeName)?.fields ?? []).map((f) => f.name)
}

function inputFieldsOf(typeName: string): string[] {
	return (types.get(typeName)?.inputFields ?? []).map((f) => f.name)
}

function argsOf(root: 'QueriesApi' | 'MutationsApi', name: string): string[] {
	const field = types.get(root)?.fields?.find((f) => f.name === name)
	return (field?.args ?? []).map((a) => a.name)
}

function descriptionOf(root: 'QueriesApi' | 'MutationsApi', name: string): string | null | undefined {
	return types.get(root)?.fields?.find((f) => f.name === name)?.description
}

/** `String(field.type)` rather than a re-rendered `ofType` chain. */
function typeOfField(typeName: string, fieldName: string): string {
	const type = schema.getType(typeName) as { getFields(): Record<string, { type: unknown }> }

	return String(type.getFields()[fieldName].type)
}

describe('schema', () => {
	it('assembles without a single validation error', () => {
		expect(result.errors).toBeUndefined()
	})

	// ⚠️ One query, and there is deliberately no `user(_id:)` beside it. A customer may read exactly
	// one account — theirs — so the identity comes from the session and from nowhere else. An `_id`
	// argument would need an equality check against `ctx.state.user._id` to be safe, and a check only
	// ever satisfied by the value it is compared against is an argument that should not exist.
	it('exposes the account query and nothing else', () => {
		expect(fieldsOf('QueriesApi')).toEqual(['me'])
	})

	it('takes no arguments, because the session is the only identity', () => {
		expect(argsOf('QueriesApi', 'me')).toEqual([])
	})

	it('carries its exact description', () => {
		expect(descriptionOf('QueriesApi', 'me')).toBe('the signed-in customer own account')
	})

	// The whole write surface of the tier. No `itemAdd`, no `company*`: a customer owns nothing but
	// their own account, and — until orders exist — cannot buy anything either.
	it('exposes the six account mutations', () => {
		expect(fieldsOf('MutationsApi')).toEqual([
			'userAddressAdd',
			'userAddressDel',
			'userAddressUpdate',
			'userDefaultAddressSet',
			'userPersonalDataUpdate',
			'userUpdatePwd'
		])
	})

	// ⚠️ There is no order, cart, delivery or payment mutation, and their absence is a fact about the
	// platform rather than an omission in this schema: none of the four has a collection, a resolver
	// or a design. A stub here would be the first half of an interface nobody has specified.
	it('exposes nothing about ordering, which does not exist yet', () => {
		for (const name of ['orderAdd', 'cartAdd', 'checkout', 'paymentIntent']) {
			expect(fieldsOf('MutationsApi')).not.toContain(name)
		}
	})
})

describe('mutation arguments', () => {
	// ⚠️ **No `_id` names an account anywhere in this list.** `userUpdatePwd` and
	// `userPersonalDataUpdate` take none at all, and the three address mutations take the id of an
	// *address*, guarded by `throwIfUserDontOwnAddress`. Every customer authenticates against the same
	// collection and the platform has no role field, so an account id here would turn each of these
	// into "do this to any customer".
	it.each([
		['userAddressAdd', ['address']],
		['userAddressDel', ['_id']],
		['userAddressUpdate', ['_id', 'address']],
		['userDefaultAddressSet', ['_id']],
		['userPersonalDataUpdate', ['personalData']],
		['userUpdatePwd', ['passwordOld', 'passwordNew']]
	])('%s takes %j', (name, expected) => {
		expect(argsOf('MutationsApi', name)).toEqual(expected)
	})

	// The current password is required, and that is what separates this from the reset flow: an
	// access token is a bearer credential, so without it a stolen one could be upgraded into
	// permanent ownership of the account. Forgetting the password is what `resetPwdFlow` on the
	// public tier is for, and that path proves ownership of the mailbox instead.
	it('demands the current password to set a new one', () => {
		expect(argsOf('MutationsApi', 'userUpdatePwd')).toContain('passwordOld')
	})

	// Literal text, nothing computes it, pin it.
	it.each([
		['userAddressAdd', 'add an address to the signed-in customer'],
		['userAddressDel', 'del an address of the signed-in customer'],
		['userAddressUpdate', 'update an address of the signed-in customer'],
		['userDefaultAddressSet', 'set the default address of the signed-in customer'],
		['userPersonalDataUpdate', 'update the signed-in customer personal data'],
		['userUpdatePwd', 'updates the password of the signed-in customer account']
	])('%s carries its exact description', (name, description) => {
		expect(descriptionOf('MutationsApi', name)).toBe(description)
	})

	// ⚠️ `userAddressAdd` answers `OnlyIdType`, its three siblings answer `Boolean` — the same
	// asymmetry `companyAdd` has on the shop-owner tier, and for the same reason: the new element id
	// is information the client cannot derive, and two saved addresses can be identical.
	it.each([
		['userAddressAdd', 'OnlyIdType!'],
		['userAddressDel', 'Boolean!'],
		['userAddressUpdate', 'Boolean!'],
		['userDefaultAddressSet', 'Boolean!'],
		['userPersonalDataUpdate', 'Boolean!'],
		['userUpdatePwd', 'Boolean!']
	])('%s answers %s', (name, type) => {
		expect(typeOfField('MutationsApi', name)).toBe(type)
	})
})

describe('object types', () => {
	// ⚠️ **`login` is flattened to one `email` field.** The stored sub-document also holds the bcrypt
	// hash, and `resetPwd` / `emailVerify` sit next to it carrying the secrets that let somebody take
	// the account over. None of the three has a field here, so no query against this type can be
	// written that returns them — the positive `select` in `me` is the second layer, not the only one.
	it('GraphQLUserMe carries the account, its addresses and nothing secret', () => {
		expect(fieldsOf('GraphQLUserMe')).toEqual(['_id', 'email', 'personalData', 'addresses', 'defaultAddress', 'registeredAt'])
	})

	it.each([['login'], ['password'], ['resetPwd'], ['emailVerify'], ['waitApprov']])('GraphQLUserMe has no %s field', (name) => {
		expect(fieldsOf('GraphQLUserMe')).not.toContain(name)
	})

	// The type is called `Me`, not `User`, and the name is doing work: a `GraphQLUser` would invite a
	// second resolver that takes an `_id`, and the whole tier is built on the session being the only
	// identity in play.
	it('names the account type after the session, not the collection', () => {
		expect(types.has('GraphQLUserMe')).toBe(true)
		expect(types.has('GraphQLUser')).toBe(false)
	})

	// `personalData` is nullable because the collection makes it optional — registration is an email
	// and a password, and an account that never fills in a name still works. `addresses` is the
	// opposite: NonNull list of NonNull elements, defaulted to `[]` by the resolver, so a client never
	// has to distinguish "none saved" from "not sent".
	it('leaves personalData and defaultAddress nullable, and nothing else', () => {
		const nullable = fieldsOf('GraphQLUserMe').filter((name) => !typeOfField('GraphQLUserMe', name).endsWith('!'))

		expect(nullable).toEqual(['personalData', 'defaultAddress'])
		expect(typeOfField('GraphQLUserMe', 'addresses')).toBe('[GraphQLUserAddress!]!')
	})

	// ⚠️ **`defaultAddress` is an `ID`, not an address.** It is a pointer into `addresses`, the client
	// already has that array, and resolving it server-side would send the same address twice and give
	// a client two places to disagree about which one is default.
	it('answers the default as a pointer rather than a second copy of the address', () => {
		expect(typeOfField('GraphQLUserMe', 'defaultAddress')).toBe('ID')
	})

	// Only the two names are NonNull, matching the collection. `GraphQLShopOwnerById` makes every one
	// of its equivalents NonNull because that tier collects a full record at onboarding; a customer
	// types a name into a profile page and leaves the rest.
	it('GraphQLUserPersonalData requires the two names and nothing more', () => {
		expect(fieldsOf('GraphQLUserPersonalData')).toEqual(['firstName', 'lastName', 'birth', 'contacts'])
		expect(
			fieldsOf('GraphQLUserPersonalData').filter((name) => !typeOfField('GraphQLUserPersonalData', name).endsWith('!'))
		).toEqual(['birth', 'contacts'])
	})

	// Every member optional: `login.email` is the credential, these are other ways to be reached.
	it('GraphQLUserContacts leaves all three optional', () => {
		expect(fieldsOf('GraphQLUserContacts')).toEqual(['mobile', 'landline', 'email'])
		expect(fieldsOf('GraphQLUserContacts').filter((name) => typeOfField('GraphQLUserContacts', name).endsWith('!'))).toEqual([])
	})

	it('GraphQLUserBirth carries the date alone', () => {
		expect(fieldsOf('GraphQLUserBirth')).toEqual(['date'])
		expect(typeOfField('GraphQLUserBirth', 'date')).toBe('DateTime!')
	})

	// `position` is nullable for the same reason as on the shop owner: the point arrives when the
	// address is picked from the geocoder's autocomplete, and one typed by hand has no map until it
	// is re-picked.
	it('GraphQLUserAddress carries the element id, the street block, its label and its point', () => {
		expect(fieldsOf('GraphQLUserAddress')).toEqual(['_id', 'street', 'postalCode', 'city', 'province', 'label', 'position'])
		expect(typeOfField('GraphQLUserAddress', '_id')).toBe('ID!')
		expect(typeOfField('GraphQLUserAddress', 'position')).toBe('GraphQLUserPosition')
	})
})

describe('input types', () => {
	// ⚠️ **`_id` is NonNull on the output type and absent from the input one.** The client needs it —
	// it is what the three address mutations name an address by — and it must never be accepted on
	// the way in, or a client could aim `defaultAddress` at an address it does not own. Read-only by
	// construction rather than by a check.
	it('mirrors the address, minus the id the server mints', () => {
		expect(inputFieldsOf('GraphQLInputUserAddress')).toEqual(fieldsOf('GraphQLUserAddress').filter((f) => f !== '_id'))
	})

	// `type` is not accepted either: it has exactly one legal value, so asking for it is only a way
	// to receive `point` and fail the write. The model stamps `'Point'` server-side. The output type
	// `GraphQLUserPosition` does carry it — the two shapes are deliberately not the same type, which
	// is also why the input is named `…UserAddressPosition` and not `…UserPosition`.
	it('takes the coordinates alone on a position, never the GeoJSON type', () => {
		expect(inputFieldsOf('GraphQLInputUserAddressPosition')).toEqual(['coordinates'])
		expect(fieldsOf('GraphQLUserPosition')).toContain('type')
	})

	it('mirrors the personal data whole', () => {
		expect(inputFieldsOf('GraphQLInputUserPersonalData')).toEqual(fieldsOf('GraphQLUserPersonalData'))
		expect(inputFieldsOf('GraphQLInputUserContacts')).toEqual(fieldsOf('GraphQLUserContacts'))
		expect(inputFieldsOf('GraphQLInputUserBirth')).toEqual(fieldsOf('GraphQLUserBirth'))
	})

	// There is no input type for the account itself: `email` is the credential and is changed by no
	// mutation here, `registeredAt` is stamped once, and `defaultAddress` moves through its own
	// mutation because it is a write to the document root rather than to an address.
	it('carries no whole-account input', () => {
		expect(types.has('GraphQLInputUserMe')).toBe(false)
		expect(types.has('GraphQLInputUser')).toBe(false)
	})
})
