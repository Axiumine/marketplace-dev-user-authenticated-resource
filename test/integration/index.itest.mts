import { randomUUID } from 'node:crypto'

import { redisClient } from '@axiumine/koa-utils/dataSources/Redis'
import { TIER } from '@thedoctorweb_agency/marketplace-common/others/Tier'
import * as dotenv from 'dotenv'
import type { Server } from 'http'
import mongoose from 'mongoose'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

// The sources call dotenv.config() transitively (MongoDB/Redis datasources, handler); this is a
// belt-and-suspenders load so the REDIS_*/MONGODB_URI values are present at this file's top level.
dotenv.config()

import { ENDPOINT } from '../../src/index.mts'
import {
	baseUrl,
	bootServer,
	drainAndClose,
	gql,
	INTROSPECTION_CODE,
	PASSWORD_HASH,
	REDIS_KEY,
	seedUser,
	withSession,
	withSignedInUser
} from './harness.mts'

let httpServer: Server

/** The whole of `me`, so nothing in the type can be added without this selection noticing. */
const ME = `{
	me {
		_id
		email
		personalData { firstName lastName birth { date } contacts { mobile landline email } }
		addresses { _id street postalCode city province label position { type coordinates } }
		defaultAddress
		registeredAt
	}
}`

beforeAll(async () => {
	;({ httpServer } = await bootServer())
})

// Drop whatever this run created while the handles are still open: documents, then every session key.
afterAll(() => drainAndClose(httpServer))

describe('user-authenticated-resource service (integration, real MongoDB + real Redis cluster)', () => {
	// start() is what wires both datasources; asserting the live handles is what makes the rest of
	// this file an integration suite rather than an in-process schema test.
	it('has a live MongoDB connection', () => {
		expect(mongoose.connection.readyState).toBe(1)
	})

	it('has a live Redis cluster connection, round-tripping a key in the isolated namespace', async () => {
		const key = `${REDIS_KEY}ping:${randomUUID()}`

		// EX so this one cannot outlive the run. It is never registered for the drain, so without a TTL
		// a hard kill — or a throw on the assertion below — strands it on the cluster forever. 60s is
		// far longer than the round trip and short enough to be self-cleaning.
		await redisClient.set(key, 'pong', { EX: 60 })
		expect(await redisClient.get(key)).toBe('pong')

		await redisClient.del(key)
		expect(await redisClient.get(key)).toBeNull()
	})
})

describe('bearer-token gate over HTTP', () => {
	const query = '{ me { _id } }'

	it('answers 412 when the request carries no authorization header', async () => {
		const { status, json } = await gql(query)

		expect(status).toBe(412)
		expect(json.message).toBe('Precondition Failed')
	})

	it('answers 499 when the header does not use the `Bearer access:` scheme', async () => {
		const { status, json } = await gql(query, { authorization: `Bearer ${randomUUID()}` })

		expect(status).toBe(499)
		expect(json.message).toBe('Token Required')
	})

	it('answers 498 when the session is not on the cluster', async () => {
		const { status, json } = await gql(query, { authorization: `Bearer access:${randomUUID()}` })

		expect(status).toBe(498)
		expect(json.message).toBe('Invalid Token')
	})

	/*
	 * ⚠️ The cross-tier hole, closed, and this is the only place on the platform it can be proved.
	 *
	 * All nine services read Redis under one `REDIS_KEY` prefix, so the hash written below is
	 * byte-for-byte what the ShopOwner resource service mints and accepts — and until `tier` was
	 * written into the session, this service accepted it too, handing that `_id` straight to the
	 * customer resolvers. The document it names really is a `user` here, so nothing downstream would
	 * have noticed: the tier mismatch is the only thing that can reject it.
	 *
	 * A mock cannot have an opinion about this. The assertion has to run against a session that is
	 * genuinely on the cluster, found by a genuine `hGetAll` under the genuinely shared prefix.
	 */
	it('answers 403 when the live session was minted for another tier', async () => {
		const { _id } = await seedUser()
		const key = `${REDIS_KEY}access:${randomUUID()}`

		try {
			await redisClient.hSet(key, { _id: _id.toHexString(), email: 'oste@marketplace.test', tier: TIER.shopOwner })
			// Self-cleaning: the drain only knows the keys `withSession` created, and this one is
			// deliberately not one of them.
			await redisClient.expire(key, 60)

			const { status, json } = await gql(query, { authorization: `Bearer ${key.slice(REDIS_KEY.length)}` })

			expect(status).toBe(403)
			expect(json.message).toBe('Forbidden')
		} finally {
			await redisClient.del(key)
		}
	})

	/*
	 * A session that predates the discriminator: a hash with an `_id` and no `tier` at all. It is
	 * refused by the same comparison rather than by a branch of its own — fail closed, re-login. Worth
	 * its own case because "missing is not a wildcard" is the property that would quietly disappear if
	 * anyone ever added an `if (!actual) return` to assertTier.
	 */
	it('answers 403 for a live session carrying no tier at all', async () => {
		const { _id } = await seedUser()
		const key = `${REDIS_KEY}access:${randomUUID()}`

		try {
			await redisClient.hSet(key, { _id: _id.toHexString(), email: 'legacy@marketplace.test' })
			await redisClient.expire(key, 60)

			const { status, json } = await gql(query, { authorization: `Bearer ${key.slice(REDIS_KEY.length)}` })

			expect(status).toBe(403)
			expect(json.message).toBe('Forbidden')
		} finally {
			await redisClient.del(key)
		}
	})
})

describe('GraphQL over HTTP', () => {
	// Introspection stays open outside production (buildValidationRules returns no rules), and the
	// schema it reports is the one really assembled in createServer — not a copy rebuilt by a test.
	it('exposes the assembled schema to a caller carrying the introspection code', async () => {
		const { status, json } = await gql('{ __schema { queryType { name } mutationType { name } } }', {
			'x-introspectioncode': INTROSPECTION_CODE
		})

		expect(status).toBe(200)
		expect(json.errors).toBeUndefined()
		expect(json.data).toEqual({
			__schema: { queryType: { name: 'QueriesApi' }, mutationType: { name: 'MutationsApi' } }
		})
	})

	it('rejects a GET on the GraphQL endpoint (csrfPrevention / method not allowed)', async () => {
		const session = await withSession()

		try {
			const res = await fetch(`${baseUrl()}${ENDPOINT}?query=%7B__typename%7D`, { headers: session.headers })

			expect(res.status).toBeGreaterThanOrEqual(400)
		} finally {
			await session.cleanup()
		}
	})
})

/*
 * `me` against the real collection. Every assertion here is about what MongoDB actually holds and
 * what the projection actually lets out, which is precisely the pair a mocked model cannot answer:
 * a stub returns whatever the test told it to, including fields the projection excludes.
 */
describe('me (real projection over the real collection)', () => {
	it('answers the account the session names, with addresses defaulted to an empty list', async () => {
		const user = await withSignedInUser()

		try {
			const { json } = await gql(ME, user.headers)

			expect(json.errors).toBeUndefined()
			expect(json.data?.me).toMatchObject({
				_id: user._id.toHexString(),
				email: user.email,
				// Optional on this collection, unlike on `shopOwner`: registration is an email and a
				// password, so a fresh customer really has neither.
				personalData: null,
				// The collection leaves `addresses` absent, the schema declares the list NonNull — the
				// resolver's `?? []` is what stops a customer with no saved address from turning their own
				// account page into a GraphQL error.
				addresses: [],
				defaultAddress: null
			})
		} finally {
			await user.cleanup()
		}
	})

	it('round-trips a full account: personal data, addresses and the default pointer', async () => {
		const addressId = new mongoose.Types.ObjectId()
		const otherId = new mongoose.Types.ObjectId()
		const birth = new Date('1990-06-15T00:00:00.000Z')
		const registeredAt = new Date('2026-08-05T09:30:00.000Z')
		const user = await withSignedInUser({
			registeredAt,
			personalData: {
				firstName: 'Julia',
				lastName: 'Rivers',
				birth: { date: birth },
				contacts: { mobile: '3331234567', landline: '0354567890', email: 'julia@marketplace.invalid' }
			},
			addresses: [
				{
					_id: addressId,
					label: 'home',
					street: '1 Test Street',
					postalCode: '01103',
					city: 'Springfield',
					province: 'MA',
					position: { type: 'Point', coordinates: [9.57, 45.75] }
				},
				{ _id: otherId, street: '2 Test Street', postalCode: '02108', city: 'Boston', province: 'MA' }
			],
			defaultAddress: addressId
		})

		try {
			const { json } = await gql(ME, user.headers)

			expect(json.errors).toBeUndefined()
			expect(json.data?.me).toEqual({
				_id: user._id.toHexString(),
				email: user.email,
				personalData: {
					firstName: 'Julia',
					lastName: 'Rivers',
					birth: { date: birth.toISOString() },
					contacts: { mobile: '3331234567', landline: '0354567890', email: 'julia@marketplace.invalid' }
				},
				addresses: [
					{
						_id: addressId.toHexString(),
						street: '1 Test Street',
						postalCode: '01103',
						city: 'Springfield',
						province: 'MA',
						label: 'home',
						// Floats, not Decimal128: `me` is `.lean()`, so no mongoose getter runs and whatever
						// the driver deserialised reaches GraphQLFloat directly.
						position: { type: 'Point', coordinates: [9.57, 45.75] }
					},
					{
						_id: otherId.toHexString(),
						street: '2 Test Street',
						postalCode: '02108',
						city: 'Boston',
						province: 'MA',
						// Both optional on the element, and absent here rather than empty — an address typed by
						// hand has no point until it is re-picked from the geocoder.
						label: null,
						position: null
					}
				],
				// An ID, not a resolved address: the client already has the array, and sending the same
				// address twice would give it two places to disagree about which one is default.
				defaultAddress: addressId.toHexString(),
				registeredAt: registeredAt.toISOString()
			})
		} finally {
			await user.cleanup()
		}
	})

	/*
	 * The two independent layers that keep the credentials in: the projection in `me` is a POSITIVE
	 * list, and `GraphQLUserMe` has no field for any of them. Both are asserted, because either one
	 * alone would still be a service one edit away from leaking.
	 *
	 * The seed carries a real-shaped `emailVerify.hash` and a `resetPwd.resetHash` next to the bcrypt
	 * hash on purpose — each of the three is on its own enough to take the account over.
	 */
	it('never lets the login sub-document out, at either layer', async () => {
		const resetHash = 'r'.repeat(50)
		const emailHash = 'e'.repeat(50)
		const user = await withSignedInUser({
			resetPwd: { resetDateReq: new Date(), resetHash },
			emailVerify: { valid: true, hash: emailHash }
		})

		try {
			const { json } = await gql(ME, user.headers)

			expect(json.errors).toBeUndefined()
			const serialised = JSON.stringify(json.data)
			expect(serialised).not.toContain(PASSWORD_HASH)
			expect(serialised).not.toContain(resetHash)
			expect(serialised).not.toContain(emailHash)

			// The outer layer: there is no field to ask with, so this dies in validation and never
			// reaches a resolver at all.
			const denied = await gql('{ me { login { password } } }', user.headers)
			expect(denied.json.errors?.[0]?.message).toMatch(/Cannot query field "login"/)
		} finally {
			await user.cleanup()
		}
	})

	// A session that outlived its document — the account was hard-deleted while a token was still
	// live. 401 so the client re-logins, rather than a null account the private area has to render.
	it('answers 401 when the live session points at a customer MongoDB does not have', async () => {
		const session = await withSession()

		try {
			const { json } = await gql(ME, session.headers)

			expect(json.data).toBeNull()
			expect(json.errors?.[0]?.message).toBe('Unauthorized')
		} finally {
			await session.cleanup()
		}
	})
})

describe('non-GraphQL routes', () => {
	it('serves /health once the bearer gate is satisfied', async () => {
		const session = await withSession()

		try {
			const res = await fetch(`${baseUrl()}/health`, { headers: session.headers })

			expect(res.status).toBe(200)
			const json = (await res.json()) as { status: string; timestamp: string }
			expect(json.status).toBe('OK')
		} finally {
			await session.cleanup()
		}
	})

	it('falls through to 404 for an unknown path', async () => {
		const session = await withSession()

		try {
			const res = await fetch(`${baseUrl()}/nope`, { headers: session.headers })

			expect(res.status).toBe(404)
		} finally {
			await session.cleanup()
		}
	})
})
