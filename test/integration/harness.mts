import { randomUUID } from 'node:crypto'
import type { AddressInfo } from 'node:net'

import { redisClient } from '@axiumine/koa-utils/dataSources/Redis'
import { TIER } from '@thedoctorweb_agency/marketplace-common/others/Tier'
import * as dotenv from 'dotenv'
import type { Server } from 'http'
import mongoose from 'mongoose'

// The sources call dotenv.config() transitively (MongoDB/Redis datasources, handler); this is a
// belt-and-suspenders load so the REDIS_*/MONGODB_URI values are present at this file's top level.
dotenv.config()

import { ENDPOINT, start } from '../../src/index.mts'

/****************************************************************************************
 * Boot, seed and drain, shared by every integration suite in this repo.
 *
 * Three suites boot the same server, seed the same collection and tear down the same two
 * datasources, so without this the boot/drain pair and the `user` fixture would exist in
 * three byte-identical copies — a DuplicatedCode finding, and the real hazard behind it:
 * a fix to one drain order silently leaves the other two wrong.
 *
 * ⚠️ **The tracking arrays below are module state, and that is safe here precisely because
 * vitest gives each test FILE its own module registry.** Each suite therefore drains what
 * it seeded and nothing else, even though `fileParallelism: false` runs them back to back
 * against one database.
 ****************************************************************************************/

export const REDIS_KEY = process.env.REDIS_KEY as string
export const INTROSPECTION_CODE = process.env.INTROSPECTION_CODE as string

/**
 * A syntactically valid bcrypt hash for seeds where nothing ever compares a password — the
 * collection validator caps `login.password` at exactly 60 characters and cares about nothing else.
 * The password-change suite hashes a real one instead, because there the comparison is the test.
 */
export const PASSWORD_HASH = `$2y$14$${'x'.repeat(53)}`

const seededUsers: mongoose.Types.ObjectId[] = []
const seededKeys: string[] = []

/** The raw driver handle — only defined once start() has connected. */
export function db() {
	return mongoose.connection.db!
}

let base = ''

/** Boot the real server on an ephemeral port and hand back its handle plus the base URL. */
export async function bootServer() {
	const server = await start()
	if (!server) throw new Error('server failed to start against the real Redis cluster / MongoDB')

	const { httpServer } = server
	const address = httpServer.address() as AddressInfo | null
	if (!address || typeof address === 'string') throw new Error('no TCP address on the booted server')

	base = `http://127.0.0.1:${address.port}`

	return { httpServer, base }
}

/** The booted server's origin, for the handful of assertions that fetch something other than GraphQL. */
export function baseUrl() {
	return base
}

/** POST a GraphQL document to the real endpoint and return status + parsed body. */
export async function gql(query: string, headers: Record<string, string> = {}) {
	const res = await fetch(`${base}${ENDPOINT}`, {
		method: 'POST',
		headers: { 'content-type': 'application/json', ...headers },
		body: JSON.stringify({ query })
	})

	return {
		status: res.status,
		// tdwKoaErrorHandler answers rejected requests with {message, description}; Apollo answers
		// accepted ones with {data, errors}. One parse covers both shapes.
		//
		// koa-utils' throw helpers build every GraphQLError the same way: the *title* is the message
		// ('Bad Request', 'Forbidden', …) and the detail that names the offending field lives in
		// `extensions.description`, with `extensions.http.status` telling Apollo what to answer.
		json: (await res.json()) as {
			data?: Record<string, unknown>
			errors?: Array<{ message: string; extensions?: { description?: string; http?: { status: number } } }>
			message?: string
			description?: string
		}
	}
}

/**
 * Seed one customer with the **raw driver** rather than the Mongoose model, so the document is
 * checked by the collection's own validator: `additionalProperties: false`, a `login.password` of
 * exactly 60 characters, and the `$expr` half that refuses a `defaultAddress` naming nothing.
 *
 * ⚠️ `registeredAt` is here because it is one of the collection's only two required fields, and
 * `personalData` is absent because it is *not* one of them — a customer registers with an email and a
 * password and fills the rest in later, which is the divergence from `shopOwner` this seed has to
 * respect or the validator refuses the insert.
 *
 * `login.email` carries a unique index, so the address is cut from a fresh UUID: a fixed literal
 * collides on the second seed of the same run.
 */
export async function seedUser(overrides: Record<string, unknown> = {}) {
	const email = `itest-${randomUUID()}@marketplace.invalid`
	const _id = new mongoose.Types.ObjectId()

	await db()
		.collection('user')
		.insertOne({
			_id,
			login: { email, password: PASSWORD_HASH },
			registeredAt: new Date(),
			...overrides
		})
	seededUsers.push(_id)

	return { _id, email }
}

/** Read one seeded customer straight back off the collection, bypassing every model and resolver. */
export async function readUser(_id: mongoose.Types.ObjectId) {
	return db().collection('user').findOne({ _id })
}

/**
 * Seed a real access session on the cluster and hand back both the header and its cleanup.
 *
 * This is the only way in: there is no login and no cookie on this tier — the session is written by
 * public-authorization at `loginUser` and only read back here.
 *
 * The key is also remembered for the drain: `cleanup()` runs in a `finally`, which does not fire when
 * a seed throws before the `try` — that is how a namespace collects orphan sessions.
 */
export async function withSession(_id = new mongoose.Types.ObjectId(), email = 'cliente@marketplace.test') {
	const token = `access:${randomUUID()}`
	const key = `${REDIS_KEY}${token}`

	seededKeys.push(key)
	// `tier` is what a real login writes and what this service asserts on every request: the auth
	// middleware calls assertTier before ctx.state.user is set, so a tier-less seed is refused with
	// 403 and every test built on this helper fails at the guard instead of reaching its resolver.
	await redisClient.hSet(key, { _id: _id.toHexString(), email, tier: TIER.user })

	return {
		_id,
		headers: { authorization: `Bearer ${token}` },
		cleanup: () => redisClient.del(key)
	}
}

/** Seed a customer AND a session bound to them — the shape every resolver test needs. */
export async function withSignedInUser(overrides: Record<string, unknown> = {}) {
	const user = await seedUser(overrides)
	const session = await withSession(user._id, user.email)

	return { ...user, ...session }
}

/**
 * Cleanup must never abort halfway. The drain removes documents first and Redis keys second, so a
 * single failed delete — a cluster MOVED mid-resharding, a handle closed early — would otherwise
 * strand every id and key registered after it, and would skip the Redis drain entirely. Mongo residue
 * is harmless, globalSetup drops and re-migrates the database on the next run; a stranded Redis key
 * sits in the cluster for its whole TTL, which for an access session is up to 91 minutes.
 */
export async function drainSafely(what: string, remove: () => Promise<unknown>) {
	try {
		await remove()
	} catch (error) {
		console.error(`[afterAll] cleanup failed for ${what}:`, error)
	}
}

/** The tail every suite ends with: the customers seeded, then the session keys, then the three handles. */
export async function drainAndClose(httpServer: Server) {
	for (const _id of seededUsers) {
		await drainSafely(`user ${_id.toString()}`, () => db().collection('user').deleteOne({ _id }))
	}
	// One del per key — this is a cluster, so a multi-key del would CROSSSLOT.
	for (const key of seededKeys) {
		await drainSafely(key, () => redisClient.del(key))
	}

	await new Promise<void>((resolve) => httpServer.close(() => resolve()))
	await redisClient.close()
	await mongoose.disconnect()
}
