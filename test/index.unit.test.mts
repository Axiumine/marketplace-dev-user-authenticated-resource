import type { ApolloServer } from '@apollo/server'
import http from 'http'
import { Types } from 'mongoose'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const captureException = vi.fn()
const captureMessage = vi.fn()
const RedisConnect = vi.fn()
const MongoDBConnect = vi.fn()
const disconnectAllDatabases = vi.fn()
const setupFieldEncryption = vi.fn()
const hGetAll = vi.fn()
const findById = vi.fn()

vi.mock('@sentry/node', () => ({ captureException, captureMessage }))
vi.mock('@axiumine/koa-utils/dataSources/Redis', () => ({ RedisConnect, redisClient: { hGetAll } }))
vi.mock('@axiumine/koa-utils/dataSources/MongoDB', () => ({ MongoDBConnect }))
// Mocked because the real one opens a ClientEncryption against a live cluster and reads a 96-byte
// key file off disk (ADR-029) — neither exists in the unit project. What start() owes it is that it
// is awaited and that its rejection lands in the same catch as a datasource failure, and both are
// asserted below.
vi.mock('@axiumine/marketplace-common/encryption/setupFieldEncryption', () => ({ setupFieldEncryption }))
vi.mock('@lib/db/disconnectAllDatabases.mjs', () => ({ disconnectAllDatabases }))
vi.mock('@axiumine/marketplace-common/models/MongoDB/User', () => ({ User: { findById } }))

const {
	ENDPOINT,
	REQUIRED_ENV_VARS,
	checkRequiredEnv,
	buildValidationRules,
	healthResponse,
	logListening,
	gracefulShutdown,
	onUnhandledRejection,
	onUncaughtException,
	createServer,
	start
} = await import('../src/index.mts')

describe('ENDPOINT', () => {
	// logListening's test below only checks the banner *contains* ENDPOINT, which is true even if
	// the constant is mutated to '' — the string being asserted against would mutate right along
	// with it. Pin the literal directly.
	it('is the fixed mount path', () => {
		expect(ENDPOINT).toBe('/user-authenticated-resource')
	})
})

describe('checkRequiredEnv', () => {
	/*
	 * ⚠️ The whole list, by value and in order, rather than a length or a `toContain`. This array is a
	 * contract with every environment the service is deployed into, and both ways of breaking it are
	 * silent: a name dropped from here turns a fatal misconfiguration into a service that starts and
	 * fails later, at a request, somewhere that does not name the cause; a name added here and read
	 * nowhere makes every environment carry a value that does nothing. A length check passes a swap and
	 * a `toContain` passes an addition, so neither notices the change. The order is asserted too — the
	 * boot names the *first* missing variable, and that is the one an admin goes looking for.
	 */
	it('requires exactly these 15 variables, in this order', () => {
		expect(REQUIRED_ENV_VARS).toStrictEqual([
			'PORT',
			'REDIS_IS_CLUSTER',
			'REDIS_DB1_HOST',
			'REDIS_DB2_HOST',
			'REDIS_DB3_HOST',
			'REDIS_DB1_PORT',
			'REDIS_DB2_PORT',
			'REDIS_DB3_PORT',
			'REDIS_USERNAME',
			'REDIS_PASSWORD',
			'REDIS_KEY',
			'MONGODB_URI',
			'CSFLE_MASTER_KEY_PATH',
			'CSFLE_KEY_VAULT_NAMESPACE',
			'INTROSPECTION_CODE'
		])
	})

	it('passes when every required variable is set', () => {
		const env = Object.fromEntries(REQUIRED_ENV_VARS.map((k) => [k, 'x']))
		expect(() => checkRequiredEnv(env)).not.toThrow()
	})

	// A plain Error, not a GraphQLError: this runs before the server exists, so there is nobody to
	// answer — the process is meant to die with the variable name in the log.
	it('names the first missing variable', () => {
		expect(() => checkRequiredEnv({})).toThrow(`Missing required environment variable: ${REQUIRED_ENV_VARS[0]}`)
	})

	// The *last* entry, so a mutant that stops the loop short is caught and not just one that skips
	// index 0.
	it('names a variable missing further down the list', () => {
		const env = Object.fromEntries(REQUIRED_ENV_VARS.map((k) => [k, 'x']))
		delete env.INTROSPECTION_CODE

		expect(() => checkRequiredEnv(env)).toThrow('Missing required environment variable: INTROSPECTION_CODE')
	})

	// ⚠️ The list is shorter than the ShopOwner service's, and every omission is a dependency this
	// tier does not have — `checkRequiredEnv` throws on a *missing* variable, so a leftover entry
	// turns a perfectly bootable service into a startup crash. Pinned as an exact set: this is the
	// only place the shortening is written down as something a test can defend.
	it('demands the fifteen variables this tier actually reads, and no more', () => {
		expect(REQUIRED_ENV_VARS).toEqual([
			'PORT',
			'REDIS_IS_CLUSTER',
			'REDIS_DB1_HOST',
			'REDIS_DB2_HOST',
			'REDIS_DB3_HOST',
			'REDIS_DB1_PORT',
			'REDIS_DB2_PORT',
			'REDIS_DB3_PORT',
			'REDIS_USERNAME',
			'REDIS_PASSWORD',
			'REDIS_KEY',
			'MONGODB_URI',
			'CSFLE_MASTER_KEY_PATH',
			'CSFLE_KEY_VAULT_NAMESPACE',
			'INTROSPECTION_CODE'
		])
	})

	// `DSN` is absent for a different reason than the mail and cookie variables: Sentry is optional,
	// `init({ dsn: undefined })` is a no-op, and requiring it made boot fail *silently* — the throw
	// happens outside start()'s try and reaches only the top-level catch, which reports to the very
	// Sentry client the missing DSN had just disabled.
	it('does not demand a Sentry DSN, nor anything this tier does not use', () => {
		for (const absent of ['DSN', 'SAMESITE_COOKIE', 'REDIRECT_DOMAIN', 'PLATFORM_NAME', 'SOCKETLABS_SERVER_ID', 'HIT_STATS']) {
			expect(REQUIRED_ENV_VARS).not.toContain(absent)
		}
	})
})

describe('buildValidationRules', () => {
	it('is empty outside production', () => {
		expect(buildValidationRules({ NODE_ENV: 'test' })).toEqual([])
	})

	it('caps depth and blocks introspection in production', () => {
		expect(buildValidationRules({ NODE_ENV: 'production' })).toHaveLength(2)
	})
})

describe('healthResponse', () => {
	it('reports OK with a round-trippable ISO timestamp', () => {
		const res = healthResponse()
		expect(res.status).toBe('OK')
		expect(res.timestamp).toBe(new Date(res.timestamp).toISOString())
	})
})

describe('logListening', () => {
	let info: ReturnType<typeof vi.spyOn>

	beforeEach(() => {
		captureMessage.mockReset()
		info = vi.spyOn(console, 'info').mockImplementation(() => undefined)
	})
	afterEach(() => {
		info.mockRestore()
		vi.unstubAllEnvs()
	})

	it('logs to the console only, outside production', () => {
		logListening({ NODE_ENV: 'test', PORT: '4032' })
		expect(info).toHaveBeenCalledTimes(1)
		expect(captureMessage).not.toHaveBeenCalled()
	})

	// Exact string, not stringContaining: a mutant that mangles the message but keeps ENDPOINT
	// intact must still fail this test, both for what reaches the console and what is mirrored
	// to Sentry — the two calls are built from the same `message` local, so both are pinned.
	it('also mirrors the exact banner to Sentry in production', () => {
		logListening({ NODE_ENV: 'production', PORT: '80' })
		expect(captureMessage).toHaveBeenCalledExactlyOnceWith(
			'Serving http://*:80/user-authenticated-resource for production.',
			'info'
		)
		expect(info).toHaveBeenCalledExactlyOnceWith('Serving http://*:80/user-authenticated-resource for production.')
	})

	// No HOSTNAME anywhere: the server binds every interface (see start (success path) below), so
	// the banner has no single host to print — pin the exact text instead of just "contains ENDPOINT".
	it('reports a wildcard host, never a specific one', () => {
		logListening({ NODE_ENV: 'test', PORT: '4032' })
		expect(info).toHaveBeenCalledWith('Serving http://*:4032/user-authenticated-resource for test.')
	})

	// The real call site — start(), on its success path — invokes logListening() with NO arguments,
	// relying on the process.env default parameter. Every test above passes an explicit env object,
	// which is a path production never takes.
	it('falls back to process.env when called with no arguments, as start() does', () => {
		vi.stubEnv('NODE_ENV', 'test')
		vi.stubEnv('PORT', '4032')

		logListening()

		expect(info).toHaveBeenCalledExactlyOnceWith('Serving http://*:4032/user-authenticated-resource for test.')
		expect(captureMessage).not.toHaveBeenCalled()
	})

	it('also mirrors to Sentry from process.env when NODE_ENV is production and no arguments are passed', () => {
		vi.stubEnv('NODE_ENV', 'production')
		vi.stubEnv('PORT', '80')

		logListening()

		expect(captureMessage).toHaveBeenCalledExactlyOnceWith(
			'Serving http://*:80/user-authenticated-resource for production.',
			'info'
		)
		expect(info).toHaveBeenCalledExactlyOnceWith('Serving http://*:80/user-authenticated-resource for production.')
	})
})

describe('gracefulShutdown', () => {
	beforeEach(() => {
		captureMessage.mockReset()
		disconnectAllDatabases.mockReset()
	})

	it('drains Apollo, closes the server and disconnects with code 0', async () => {
		const apolloServer = { stop: vi.fn().mockResolvedValue(undefined) }
		const httpServer = { close: vi.fn((cb: () => void) => cb()) }

		await gracefulShutdown('SIGTERM', apolloServer as never, httpServer as never)

		expect(captureMessage).toHaveBeenCalledWith('SIGTERM received, shutting down gracefully...')
		expect(apolloServer.stop).toHaveBeenCalledTimes(1)
		expect(disconnectAllDatabases).toHaveBeenCalledWith(0)
	})
})

describe('process handlers', () => {
	let exit: ReturnType<typeof vi.spyOn>

	beforeEach(() => {
		captureException.mockReset()
		exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never)
	})
	afterEach(() => exit.mockRestore())

	it('onUnhandledRejection reports the reason and exits 1', () => {
		const reason = new Error('boom')
		onUnhandledRejection(reason)
		expect(captureException).toHaveBeenCalledWith(reason)
		expect(exit).toHaveBeenCalledWith(1)
	})

	it('onUncaughtException reports the error and exits 1', () => {
		const error = new Error('kaboom')
		onUncaughtException(error)
		expect(captureException).toHaveBeenCalledWith(error)
		expect(exit).toHaveBeenCalledWith(1)
	})
})

/**
 * The state every start() test needs before it can assert anything: no leftover calls, both
 * datasources and field encryption resolving, and a stub for every required variable so
 * checkRequiredEnv() is never the thing that fails. Each test then rejects exactly the one it is
 * about.
 */
function resetStartMocks() {
	captureException.mockReset()
	disconnectAllDatabases.mockReset()
	RedisConnect.mockReset().mockResolvedValue(undefined)
	MongoDBConnect.mockReset().mockResolvedValue(undefined)
	setupFieldEncryption.mockReset().mockResolvedValue(undefined)
	for (const k of REQUIRED_ENV_VARS) vi.stubEnv(k, 'x')
}

describe('start (failure path)', () => {
	let errorLog: ReturnType<typeof vi.spyOn>

	beforeEach(() => {
		resetStartMocks()
		errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined)
	})
	afterEach(() => {
		errorLog.mockRestore()
		vi.unstubAllEnvs()
	})

	it('reports to Sentry and disconnects with code 1 when MongoDB fails to connect', async () => {
		const error = new Error('mongo boom')
		MongoDBConnect.mockRejectedValueOnce(error)

		await start()

		expect(MongoDBConnect).toHaveBeenCalledTimes(1)
		expect(captureException).toHaveBeenCalledWith(error)
		expect(disconnectAllDatabases).toHaveBeenCalledWith(1)
		// The console.error call carries a literal first argument ('error') alongside the real
		// error object — assert both, or a mutant that blanks the literal survives unnoticed.
		expect(errorLog).toHaveBeenCalledWith('error', error)
	})

	// Both datasources are opened by the same Promise.all, so Redis's rejection has to be covered
	// separately — MongoDB resolving is not enough to prove the catch handles either side.
	it('reports to Sentry and disconnects with code 1 when Redis fails to connect', async () => {
		const error = new Error('redis boom')
		RedisConnect.mockRejectedValueOnce(error)

		await start()

		expect(captureException).toHaveBeenCalledWith(error)
		expect(disconnectAllDatabases).toHaveBeenCalledWith(1)
		expect(errorLog).toHaveBeenCalledWith('error', error)
	})

	// A service that came up with field encryption broken would answer queries with ciphertext and
	// write plaintext beside it, so this failure has to be as fatal as a datasource failure.
	it('reports to Sentry and disconnects with code 1 when field encryption cannot start', async () => {
		const error = new Error('CSFLE_MASTER_KEY_PATH is not set — field encryption cannot start without it')
		setupFieldEncryption.mockRejectedValueOnce(error)

		await start()

		expect(setupFieldEncryption).toHaveBeenCalledTimes(1)
		expect(captureException).toHaveBeenCalledWith(error)
		expect(disconnectAllDatabases).toHaveBeenCalledWith(1)
		expect(errorLog).toHaveBeenCalledWith('error', error)
	})

	// ⚠️ There is deliberately no ClamAV case here, and its absence is the assertion: this tier
	// mounts neither `graphqlUploadKoa` nor `initClamScan`, so clamd is not a boot dependency. A
	// customer uploads nothing, and the antivirus socket would have to be up for the service to
	// start — which is exactly what the two resource services with uploads pay.
	it('boots without an antivirus socket, because nothing here accepts a file', async () => {
		vi.stubEnv('PORT', '0') // the only stub that has to be a real value: listen() binds a socket

		const server = await start()

		expect(server).toBeDefined()
		expect(disconnectAllDatabases).not.toHaveBeenCalled()

		await server!.apolloServer.stop()
		await new Promise<void>((resolve) => server!.httpServer.close(() => resolve()))
	})
})

describe('start (success path)', () => {
	beforeEach(() => {
		resetStartMocks()
		// Real value for the one env var httpServer.listen() actually needs to bind a socket — every
		// other REQUIRED_ENV_VARS entry stays the harmless 'x' stub above. No HOSTNAME stub: the
		// listen options carry no host key at all, so a live one would go unread.
		vi.stubEnv('PORT', '0')
	})
	afterEach(() => {
		vi.unstubAllEnvs()
	})

	it('builds the real server, listens, and returns live handles', async () => {
		const info = vi.spyOn(console, 'info').mockImplementation(() => undefined)
		// spyOn keeps the real implementation (it only records calls), so the socket still binds for
		// real — this is what proves the options object handed to listen() carries no host key at
		// all, not just that some field happens to be absent from a mock's recorded call.
		const listen = vi.spyOn(http.Server.prototype, 'listen')

		const server = await start()

		expect(server).toBeDefined()
		expect(server?.httpServer.listening).toBe(true)
		expect(listen).toHaveBeenCalledExactlyOnceWith({ port: '0' }, expect.any(Function))
		// Once, with no arguments: it reads its configuration from the environment, and a caller that
		// passed it anything would be building a second source of truth for the master key path.
		expect(setupFieldEncryption).toHaveBeenCalledExactlyOnceWith()
		expect(info).toHaveBeenCalledTimes(1)
		expect(captureException).not.toHaveBeenCalled()
		expect(disconnectAllDatabases).not.toHaveBeenCalled()

		listen.mockRestore()
		info.mockRestore()
		await server!.apolloServer.stop()
		await new Promise<void>((resolve) => server?.httpServer.close(() => resolve()))
	})
})

/**
 * The three arms of the dispatch middleware, driven over a real socket.
 *
 * ⚠️ **The whole app is behind the auth middleware, `/health` included**, because
 * `authorizationAuthenticatedResourceHandler` is mounted app-wide and *before* the dispatch. That is
 * not an oversight to route around: an unauthenticated health check would be the one path on this
 * service an anonymous caller could reach, and it answers from the same process the customer data
 * lives in. A monitor calls it with the introspection code, which is exactly what that header is for.
 */
describe('request dispatch', () => {
	let httpServer: http.Server
	let apolloServer: ApolloServer
	let origin: string

	const userId = new Types.ObjectId('507f1f77bcf86cd799439011')
	const ACCESS = 'access:27119032-9043-4a9f-bd4c-9d06fd576290'
	const INTROSPECTION = { 'x-introspectioncode': 'test-introspection-code' }

	beforeAll(async () => {
		const server = await createServer()
		httpServer = server.httpServer
		apolloServer = server.apolloServer

		await new Promise<void>((resolve) => httpServer.listen({ port: 0 }, () => resolve()))
		origin = `http://127.0.0.1:${(httpServer.address() as { port: number }).port}`
	})

	afterAll(async () => {
		await apolloServer.stop()
		await new Promise<void>((resolve) => httpServer.close(() => resolve()))
	})

	beforeEach(() => {
		hGetAll.mockReset()
		findById.mockReset()
	})

	it('answers the health check on /health', async () => {
		const res = await fetch(`${origin}/health`, { headers: INTROSPECTION })

		expect(res.status).toBe(200)
		await expect(res.json()).resolves.toMatchObject({ status: 'OK' })
	})

	// The else arm: anything that is neither the GraphQL endpoint nor /health falls through to a Koa
	// 404. Nothing else is mounted, so this is the whole surface — there are no REST routes on this
	// tier, and the three that exist on the platform all live on the public service.
	it('answers 404 on any other path', async () => {
		const res = await fetch(`${origin}/anything-else`, { headers: INTROSPECTION })

		expect(res.status).toBe(404)
	})

	// Auth runs before dispatch, so even the health check needs a credential. 412 rather than 401:
	// the request carried no Authorization header at all.
	it('refuses the health check with no credential at all', async () => {
		const res = await fetch(`${origin}/health`)

		expect(res.status).toBe(412)
	})

	// The Apollo arm, end to end over HTTP with only Redis and the model stubbed: the session is read,
	// the tier asserted, the context built and the resolver run.
	it('serves the GraphQL endpoint to a customer session', async () => {
		hGetAll.mockResolvedValueOnce(
			Object.assign(Object.create(null), { _id: String(userId), email: 'cliente@marketplace.test', tier: 'user' })
		)
		findById.mockReturnValueOnce({
			select: () => ({
				lean: async () => ({
					_id: userId,
					login: { email: 'cliente@marketplace.test' },
					addresses: [],
					registeredAt: new Date('2026-08-05T10:00:00.000Z')
				})
			})
		})

		const res = await fetch(`${origin}${ENDPOINT}`, {
			method: 'POST',
			headers: { 'content-type': 'application/json', authorization: `Bearer ${ACCESS}` },
			body: JSON.stringify({ query: '{ me { _id email addresses { _id } defaultAddress } }' })
		})

		expect(res.status).toBe(200)
		await expect(res.json()).resolves.toEqual({
			data: { me: { _id: String(userId), email: 'cliente@marketplace.test', addresses: [], defaultAddress: null } }
		})
	})

	// ⚠️ The cross-tier refusal, over the wire rather than at the unit boundary: a ShopOwner access
	// token is *findable* here because all nine services share one `REDIS_KEY` prefix, and before the
	// tier discriminator existed this request was served.
	it('refuses a ShopOwner session on the GraphQL endpoint with 403', async () => {
		hGetAll.mockResolvedValueOnce(
			Object.assign(Object.create(null), { _id: String(userId), email: 'oste@marketplace.test', tier: 'shopOwner' })
		)

		const res = await fetch(`${origin}${ENDPOINT}`, {
			method: 'POST',
			headers: { 'content-type': 'application/json', authorization: `Bearer ${ACCESS}` },
			body: JSON.stringify({ query: '{ me { _id } }' })
		})

		expect(res.status).toBe(403)
		expect(findById).not.toHaveBeenCalled()
	})

	// `csrfPrevention: true`, which is why every frontend sets urql's `preferGetMethod: false`: a GET
	// carrying none of Apollo's preflight-forcing headers is refused outright.
	it('refuses a bare GET query, as csrfPrevention demands', async () => {
		hGetAll.mockResolvedValueOnce(
			Object.assign(Object.create(null), { _id: String(userId), email: 'cliente@marketplace.test', tier: 'user' })
		)

		const res = await fetch(`${origin}${ENDPOINT}?query=%7Bme%7B_id%7D%7D`, {
			headers: { authorization: `Bearer ${ACCESS}` }
		})

		expect(res.status).toBe(400)
	})
})

// ⚠️ **`app.proxy` off is load-bearing, not an unset default nobody thought about.** With it off,
// `ctx.ip` is the socket address — nginx's own — so no client address is reachable in this process
// at all, which is the design: the per-caller rate limit is the edge's (`conf.d/20-rate-limit.conf`
// keys its zones on `$binary_remote_addr` after `real_ip_header CF-Connecting-IP`), and nothing here
// can write a visitor's address to Redis, to a log line or to Sentry. Turning it on would silently
// start trusting `X-Forwarded-For` and start producing real addresses everywhere `ctx.ip` is read.
// A comment cannot prevent that; this test can, and it is the reason the setting is never assigned.
describe('app.proxy', () => {
	it('is off on the constructed Koa app', async () => {
		for (const k of REQUIRED_ENV_VARS) vi.stubEnv(k, 'x')

		const { app, apolloServer } = await createServer()

		expect(app.proxy).toBeFalsy()

		await apolloServer.stop()
		vi.unstubAllEnvs()
	})
})

/*
 * ⚠️ The boot itself, not just `checkRequiredEnv`. The check runs OUTSIDE `start()`'s try, so a missing
 * variable has to travel out of `start()` to the caller instead of being swallowed into the
 * disconnect-and-exit that handles a datasource failure — and it must get there before anything has
 * connected, because a datasource handle left half-open by a boot nobody completed is a connection
 * the pool goes on holding.
 */
describe('start (missing environment)', () => {
	afterEach(() => {
		vi.unstubAllEnvs()
	})

	it('rejects — with no datasource touched — when a required variable is missing', async () => {
		for (const k of REQUIRED_ENV_VARS) vi.stubEnv(k, 'x')
		vi.stubEnv('REDIS_KEY', '')
		RedisConnect.mockClear()
		disconnectAllDatabases.mockClear()

		await expect(start()).rejects.toThrow('Missing required environment variable: REDIS_KEY')
		expect(RedisConnect).not.toHaveBeenCalled()
		expect(disconnectAllDatabases).not.toHaveBeenCalled()
	})
})
