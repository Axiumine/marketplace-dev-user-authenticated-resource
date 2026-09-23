import type { ApolloServer } from '@apollo/server'
import type { EnvShape } from '@axiumine/marketplace-common/others/assertEnvShape'
import http from 'http'
import { Types } from 'mongoose'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const captureException = vi.fn()
const captureMessage = vi.fn()
const flush = vi.fn()
const RedisConnect = vi.fn()
const MongoDBConnect = vi.fn()
const disconnectAllDatabases = vi.fn()
const setupFieldEncryption = vi.fn()
const hGetAll = vi.fn()
const findById = vi.fn()

vi.mock('@sentry/node', () => ({ captureException, captureMessage, flush }))
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
	ENV_SHAPES,
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

/*
 * ⚠️ The shape table the cases below are driven from is written out here rather than read off
 * `ENV_SHAPES`, and the two are reconciled by one assertion. `it.each` is evaluated when vitest
 * COLLECTS the file, and in the services that import `src/index.mts` dynamically inside a `beforeAll`
 * — which is how a module-load-time mutant is made attributable to a test — the export does not exist
 * yet at that moment. A table read from the module would generate zero cases there, and zero cases is
 * a green run. Written here it generates the same cases in all nine.
 */
const EXPECTED_SHAPES: Readonly<Record<string, EnvShape>> = {
	PORT: 'port',
	REDIS_IS_CLUSTER: 'flag01',
	REDIS_URL: 'redisUrl',
	REDIS_DB1_HOST: 'hostname',
	REDIS_DB2_HOST: 'hostname',
	REDIS_DB3_HOST: 'hostname',
	REDIS_DB1_PORT: 'port',
	REDIS_DB2_PORT: 'port',
	REDIS_DB3_PORT: 'port',
	REDIS_KEY: 'keyPrefix',
	MONGODB_URI: 'mongoUri',
	CSFLE_MASTER_KEY_PATH: 'absolutePath',
	CSFLE_KEY_VAULT_NAMESPACE: 'namespace'
}

/**
 * A value of the right *kind* for every name the map above constrains, and `'x'` for every name it does
 * not. `checkRequiredEnv` runs a shape pass after the presence loop, so an environment of `'x'`
 * everywhere no longer reaches the branch a test is about — it fails on `PORT` before getting there.
 *
 * `flag01` samples `'0'`, which keeps the default environment on the single-node Redis branch the old
 * `'x'` landed on: every test below that turns on `REDIS_URL` still tests what it used to.
 */
const SHAPED: Readonly<Record<EnvShape, string>> = {
	absolutePath: '/srv/marketplace',
	email: 'noreply@shop.lan',
	flag01: '0',
	hostname: 'db1',
	keyPrefix: 'marketplaceDev:',
	mongoUri: 'mongodb://127.0.0.1:27017/dbMarketplaceDev',
	namespace: 'dbMarketplaceDev.__keyVault',
	origin: 'https://shop.lan',
	// ⚠️ `0`, not a real port: `validEnv()` reaches `start()` in the tests below and a fixed number would
	// make them bind it for real — colliding with whichever service of this fleet is running on the
	// developer's machine. `0` is the ephemeral port the integration projects bind on for the same reason.
	port: '0',
	redisUrl: 'redis://127.0.0.1:6379'
}

/** One value of the wrong kind per shape, each a mistake a real environment makes rather than nonsense. */
const MISSHAPEN: Readonly<Record<EnvShape, string>> = {
	absolutePath: 'srv/marketplace',
	email: 'noreply.shop.lan',
	flag01: 'true',
	hostname: 'redis://db1',
	keyPrefix: 'marketplaceDev',
	mongoUri: 'redis://127.0.0.1:6379',
	namespace: 'dbMarketplaceDev',
	origin: 'https://shop.lan/',
	port: '4027x',
	redisUrl: 'mongodb://127.0.0.1:27017/dbMarketplaceDev'
}

const shaped = (name: string): string => SHAPED[EXPECTED_SHAPES[name]] ?? 'x'
const validEnv = (): Record<string, string> => Object.fromEntries(REQUIRED_ENV_VARS.map((k) => [k, shaped(k)]))

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
			'CSFLE_KEY_VAULT_NAMESPACE'
		])
	})

	// ⚠️ `REDIS_URL` is set here and is deliberately NOT in the list: it is required only when
	// `REDIS_IS_CLUSTER` is not `'1'`, which is the branch `validEnv()`'s `'0'` lands on.
	it('passes when every required variable is set', () => {
		const env = { ...validEnv(), REDIS_URL: 'redis://127.0.0.1:6379' }
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
		const env = validEnv()
		delete env.CSFLE_KEY_VAULT_NAMESPACE

		expect(() => checkRequiredEnv(env)).toThrow('Missing required environment variable: CSFLE_KEY_VAULT_NAMESPACE')
	})

	// ⚠️ The list is shorter than the ShopOwner service's, and every omission is a dependency this
	// tier does not have — `checkRequiredEnv` throws on a *missing* variable, so a leftover entry
	// turns a perfectly bootable service into a startup crash. Pinned as an exact set: this is the
	// only place the shortening is written down as something a test can defend.
	it('demands the fourteen variables this tier actually reads, and no more', () => {
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
			'CSFLE_KEY_VAULT_NAMESPACE'
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

	/*
	 * ⚠️ **The single-node branch — the one `SETUP.md` puts a fresh machine on.** `REDIS_URL` is not in
	 * `REQUIRED_ENV_VARS` and must not be: the committed `env` ships it empty because this stack runs the
	 * cluster branch, where nothing reads it. So the guard is a branch of its own and gets its own tests.
	 * Unset, it is an error nowhere else — node-redis defaults the url to `redis://localhost:6379` and the
	 * service connects to whatever answers there, which is the wrong-but-populated environment
	 * `RISK_REGISTER` R04 describes.
	 */
	it('requires REDIS_URL when REDIS_IS_CLUSTER is not "1"', () => {
		const env = validEnv()
		env.REDIS_IS_CLUSTER = '0'

		expect(() => checkRequiredEnv(env)).toThrow('Missing required environment variable: REDIS_URL')
	})

	it('accepts the single-node branch once REDIS_URL names a server', () => {
		const env = validEnv()
		env.REDIS_IS_CLUSTER = '0'
		env.REDIS_URL = 'redis://127.0.0.1:6379'

		expect(() => checkRequiredEnv(env)).not.toThrow()
	})

	// ⚠️ The cluster branch builds its client from REDIS_DB1..DB3 and never reads REDIS_URL, so demanding it
	// here would refuse the boot of every machine this workspace ships configured. `'1'` exactly, as a
	// string: that is the comparison koa-utils makes, and `1` or `'true'` takes the single-node branch.
	it('does not require REDIS_URL on the cluster branch', () => {
		const env = validEnv()
		env.REDIS_IS_CLUSTER = '1'

		expect(() => checkRequiredEnv(env)).not.toThrow()
	})

	/*
	 * ⚠️ The whole map, by value, for the same reason the array above is asserted whole: both ways of
	 * breaking it are silent. A name dropped from `ENV_SHAPES` stops being checked and the boot goes back
	 * to accepting any non-empty string in that slot; a shape changed to the wrong one refuses a correct
	 * value on the next machine provisioned. Neither shows up in a run of this suite otherwise — and it is
	 * also what ties `EXPECTED_SHAPES` to the module, so the table cannot quietly drift into testing a map
	 * the service does not use.
	 */
	it('shape-checks exactly these names', () => {
		expect(ENV_SHAPES).toStrictEqual(EXPECTED_SHAPES)
	})

	/*
	 * One wrong-kind value per name, on an environment that is otherwise complete and well formed — so
	 * the only thing that can fail is the shape pass, and the message must name that one variable.
	 * `REDIS_URL` is spread in because a misshapen `REDIS_IS_CLUSTER` is not `'1'` and puts the check on
	 * the single-node branch, where an absent url is a *presence* fault that would mask the shape one.
	 */
	it.each(Object.entries(EXPECTED_SHAPES))('refuses a %s that is not a valid %s', (name, shape) => {
		const env = { ...validEnv(), REDIS_URL: SHAPED.redisUrl, [name]: MISSHAPEN[shape] }

		expect(() => checkRequiredEnv(env)).toThrow(`ENV_SHAPE_INVALID: ${name} must be `)
	})

	// Every fault at once: provisioning a machine is when this fires, and one name per restart is a queue.
	it('names every misshapen variable in one message', () => {
		const env = { ...validEnv(), REDIS_URL: SHAPED.redisUrl, PORT: MISSHAPEN.port, REDIS_KEY: MISSHAPEN.keyPrefix }

		expect(() => checkRequiredEnv(env)).toThrow(
			'ENV_SHAPE_INVALID: PORT must be a TCP port between 0 and 65535; REDIS_KEY must be a key prefix ending in ":".'
		)
	})

	/*
	 * ⚠️ Presence first, shape second, and the order is the assertion. One name is unset here *and*
	 * `PORT` is misshapen; the boot must name the missing one, because an admin told to fix a format in
	 * a variable they have not written yet goes looking for a line that is not in the file.
	 */
	it('reports a missing variable before a misshapen one', () => {
		// Spreading a `Record<string, string>` narrows to the two overridden keys, dropping the index
		// signature — the widening this line needs back so `delete` can name a key it never declared.
		const env: Record<string, string> = { ...validEnv(), REDIS_URL: SHAPED.redisUrl, PORT: MISSHAPEN.port }
		delete env.MONGODB_URI

		expect(() => checkRequiredEnv(env)).toThrow('Missing required environment variable: MONGODB_URI')
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
		flush.mockReset().mockResolvedValue(true)
		exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never)
	})
	afterEach(() => exit.mockRestore())

	// Neither handler can `await`: Node calls them synchronously and does not wait for a returned
	// promise, so process.exit() has to be reached from flush()'s own callback instead — pinned with
	// the exact timeout, or a boot-time crash is reported to the log and lost from Sentry regardless.
	it('onUnhandledRejection reports the reason, flushes Sentry, then exits 1', async () => {
		const reason = new Error('boom')
		onUnhandledRejection(reason)
		expect(captureException).toHaveBeenCalledWith(reason)

		await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(1))

		expect(flush).toHaveBeenCalledExactlyOnceWith(2000)
	})

	// The ordering itself, not just that both eventually happened: process.exit() must wait on the
	// flush promise settling, or a mutant that drops the `.finally` wiring and exits immediately would
	// pass the test above unnoticed.
	it('onUnhandledRejection does not exit until the flush settles', async () => {
		let resolveFlush: (value: boolean) => void = () => undefined
		flush.mockReturnValueOnce(new Promise<boolean>((resolve) => (resolveFlush = resolve)))

		onUnhandledRejection(new Error('boom'))
		await Promise.resolve()
		await Promise.resolve()
		expect(exit).not.toHaveBeenCalled()

		resolveFlush(true)
		await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(1))
	})

	it('onUncaughtException reports the error, flushes Sentry, then exits 1', async () => {
		const error = new Error('kaboom')
		onUncaughtException(error)
		expect(captureException).toHaveBeenCalledWith(error)

		await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(1))

		expect(flush).toHaveBeenCalledExactlyOnceWith(2000)
	})

	it('onUncaughtException does not exit until the flush settles', async () => {
		let resolveFlush: (value: boolean) => void = () => undefined
		flush.mockReturnValueOnce(new Promise<boolean>((resolve) => (resolveFlush = resolve)))

		onUncaughtException(new Error('kaboom'))
		await Promise.resolve()
		await Promise.resolve()
		expect(exit).not.toHaveBeenCalled()

		resolveFlush(true)
		await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(1))
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
	// A seeded namespace, so every test below is about the failure it arms rather than about the
	// keygrip probe start() now runs first. Only `wrapped` is read — presence, never the value.
	hGetAll.mockReset().mockResolvedValue({ wrapped: 'seeded' })
	// ⚠️ `REDIS_URL` is stubbed on top of the list because it is not in it: the guard requires it only
	// when `REDIS_IS_CLUSTER` is not `'1'`, and `validEnv()`'s `'0'` is that branch.
	for (const k of REQUIRED_ENV_VARS) vi.stubEnv(k, shaped(k))
	vi.stubEnv('REDIS_URL', 'redis://127.0.0.1:6379')
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

	/*
	 * ⚠️ **A connection that opened is not a namespace that exists.** `REDIS_KEY` is a prefix, so a value
	 * naming a namespace nobody seeded connects, answers and stays empty: before this probe the service
	 * booted clean and then missed on every session lookup, answering 401 to every customer while the
	 * fleet around it worked — `RISK_REGISTER` R04's local half. Same outcome as any other boot failure,
	 * which is the point: it dies rather than serving.
	 */
	it('reports to Sentry and disconnects with code 1 when the keygrip record is not in this namespace', async () => {
		hGetAll.mockResolvedValueOnce({})

		await start()

		expect(hGetAll).toHaveBeenCalledExactlyOnceWith(`${SHAPED.keyPrefix}keygrip`)
		expect(captureException).toHaveBeenCalledWith(
			expect.objectContaining({ message: expect.stringContaining('KEYGRIP_RECORD_MISSING') })
		)
		expect(disconnectAllDatabases).toHaveBeenCalledWith(1)
		// Before field encryption: nothing that touches data runs on a connection whose namespace the
		// service could not find.
		expect(setupFieldEncryption).not.toHaveBeenCalled()
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
		// The keygrip record read once, at `<REDIS_KEY>keygrip` — the exact key, because the whole point
		// of the probe is which namespace it looked in. `REDIS_KEY` is the 'x' stub here.
		expect(hGetAll).toHaveBeenCalledExactlyOnceWith(`${SHAPED.keyPrefix}keygrip`)
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
 * lives in. A monitor carries a session like every other caller, or reads liveness from the edge.
 */
describe('request dispatch', () => {
	let httpServer: http.Server
	let apolloServer: ApolloServer
	let origin: string

	const userId = new Types.ObjectId('507f1f77bcf86cd799439011')
	const ACCESS = 'access:27119032-9043-4a9f-bd4c-9d06fd576290'
	const AUTHENTICATED = { authorization: `Bearer ${ACCESS}` }
	/** The session the two credential-only arms below need read back out of Redis. */
	const customerSession = () =>
		Object.assign(Object.create(null), { _id: String(userId), email: 'cliente@marketplace.test', tier: 'user' })

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
		hGetAll.mockResolvedValueOnce(customerSession())

		const res = await fetch(`${origin}/health`, { headers: AUTHENTICATED })

		expect(res.status).toBe(200)
		await expect(res.json()).resolves.toMatchObject({ status: 'OK' })
	})

	// The else arm: anything that is neither the GraphQL endpoint nor /health falls through to a Koa
	// 404. Nothing else is mounted, so this is the whole surface — there are no REST routes on this
	// tier, and the three that exist on the platform all live on the public service.
	it('answers 404 on any other path', async () => {
		hGetAll.mockResolvedValueOnce(customerSession())

		const res = await fetch(`${origin}/anything-else`, { headers: AUTHENTICATED })

		expect(res.status).toBe(404)
	})

	// ⚠️ The else arm's `await next()` is the one line the test above cannot tell apart from a mutant
	// that empties that branch: nothing is mounted after it in production, so a 404 comes back either
	// way and the shared server proves nothing. This test builds its own server and mounts a marker
	// middleware AFTER the dispatch one — Koa's compose walks `app.middleware` by index at request
	// time, so a middleware pushed after createServer() still runs on the next request through the
	// same app. The marker only fires if `next()` actually hands control onward.
	it('hands control to whatever is mounted after it, on the else arm', async () => {
		const server = await createServer()
		server.app.use(async (ctx) => {
			ctx.status = 210
			ctx.body = 'reached-next'
		})
		await new Promise<void>((resolve) => server.httpServer.listen({ port: 0 }, () => resolve()))
		const localOrigin = `http://127.0.0.1:${(server.httpServer.address() as { port: number }).port}`

		hGetAll.mockResolvedValueOnce(customerSession())
		const res = await fetch(`${localOrigin}/anything-else`, { headers: AUTHENTICATED })

		expect(res.status).toBe(210)
		await expect(res.text()).resolves.toBe('reached-next')

		await server.apolloServer.stop()
		await new Promise<void>((resolve) => server.httpServer.close(() => resolve()))
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
		for (const k of REQUIRED_ENV_VARS) vi.stubEnv(k, shaped(k))
		vi.stubEnv('REDIS_URL', 'redis://127.0.0.1:6379')

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
		for (const k of REQUIRED_ENV_VARS) vi.stubEnv(k, shaped(k))
		vi.stubEnv('REDIS_URL', 'redis://127.0.0.1:6379')
		vi.stubEnv('REDIS_KEY', '')
		RedisConnect.mockClear()
		disconnectAllDatabases.mockClear()

		await expect(start()).rejects.toThrow('Missing required environment variable: REDIS_KEY')
		expect(RedisConnect).not.toHaveBeenCalled()
		expect(disconnectAllDatabases).not.toHaveBeenCalled()
	})
})
