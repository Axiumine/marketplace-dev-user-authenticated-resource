import { ApolloServer } from '@apollo/server'
import { ApolloServerPluginDrainHttpServer } from '@apollo/server/plugin/drainHttpServer'
import { koaMiddleware as apolloServerKoa } from '@as-integrations/koa'
import { MongoDBConnect } from '@axiumine/koa-utils/dataSources/MongoDB'
import { RedisConnect } from '@axiumine/koa-utils/dataSources/Redis'
import { tdwKoaErrorHandler } from '@axiumine/koa-utils/koa/tdwKoaErrorHandler'
import { setupFieldEncryption } from '@axiumine/marketplace-common/encryption/setupFieldEncryption'
import { IContextUserAuthenticatedResource } from '@lib/auth/IContextUserAuthenticatedResource.mjs'
import { authorizationAuthenticatedResourceHandler } from '@lib/db/authorizationAuthenticatedResourceHandler.mjs'
import { disconnectAllDatabases } from '@lib/db/disconnectAllDatabases.mjs'
import * as Sentry from '@sentry/node'
import { GraphQLSchema, NoSchemaIntrospectionCustomRule, ValidationRule } from 'graphql'
import depthLimit from 'graphql-depth-limit'
import http from 'http'
import Koa, { Context, Next } from 'koa'
import bodyParserKoa from 'koa-bodyparser'

import MutationsPublic from './graphQLApi/schema/mutations.mjs'
import QueriesPublic from './graphQLApi/schema/queries.mjs'

export const ENDPOINT = '/user-authenticated-resource'

/**
 * ⚠️ **Shorter than `marketplace-dev-authenticated-resource`'s list, and every omission is a
 * dependency this tier does not have.** The check throws on a *missing* variable, so listing one the
 * code never reads turns a perfectly bootable service into a startup crash — which is how the shop
 * owner tier's copy came to demand `SOCKETLABS_SERVER_ID` on a service that sends no mail.
 *
 * Gone from that list, with the reason: the four SocketLabs/email variables and `PLATFORM_NAME`
 * (no mail is sent here — registration and verification live on 4027), `REDIRECT_DOMAIN` (nothing
 * redirects; this tier answers GraphQL only), `SAMESITE_COOKIE` (no cookie is set — the refresh cookie
 * belongs to 4031) and `HIT_STATS`.
 *
 * Three of those reasons were understated: `REDIRECT_DOMAIN`, `SAMESITE_COOKIE` and `HIT_STATS` are read
 * by nothing on this platform at all, not merely by nothing here, and E18-S13 removed them from the two
 * lists that still carried them and from all nine `env` templates.
 *
 * `INTROSPECTION_CODE` stays: `authorizationAuthenticatedResourceHandler` compares against it, and an
 * unset one would make the comparison `'undefined' === 'undefined'` for any caller sending that
 * literal string.
 *
 * `DSN` is absent too, for a different reason than the rest: Sentry is *optional*.
 * `Sentry.init({ dsn: undefined })` is a no-op, and requiring the variable made boot fail *silently* —
 * checkRequiredEnv() runs outside start()'s try, so the throw reached only the top-level `.catch`, which
 * reports to the very Sentry client the missing DSN had just disabled.
 */
export const REQUIRED_ENV_VARS = [
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
	// ADR-029. Both are read by setupFieldEncryption() below, and both belong in this list rather
	// than being left to fail later: a service that boots without them cannot read a single personal
	// field, and every query that touches one throws on its first use instead of at startup.
	'CSFLE_MASTER_KEY_PATH',
	'CSFLE_KEY_VAULT_NAMESPACE',
	'INTROSPECTION_CODE'
]

/**
 * Fail fast if any required environment variable is missing. Raises a plain Error — this runs
 * before the server exists, so there is no request to answer and no GraphQL envelope to fill.
 */
export function checkRequiredEnv(env: NodeJS.ProcessEnv = process.env): void {
	for (const envVar of REQUIRED_ENV_VARS) {
		if (!env[envVar]) {
			const mex = `Missing required environment variable: ${envVar}`
			throw new Error(mex)
		}
	}
}

/**
 * Production hardens the schema: no introspection and a query-depth cap.
 * Everywhere else the rules are empty so the playground/tooling stays usable.
 */
export function buildValidationRules(env: NodeJS.ProcessEnv = process.env): ValidationRule[] {
	return env.NODE_ENV === 'production' ? [NoSchemaIntrospectionCustomRule, depthLimit(10)] : []
}

/**
 * Body of the /health endpoint. Kept pure so it is trivially testable — it cannot
 * throw, which is why the old try/catch around it was removed as dead code.
 */
export function healthResponse(): { status: string; timestamp: string } {
	return { status: 'OK', timestamp: new Date().toISOString() }
}

/**
 * Log the listening banner; in production also mirror it to Sentry as an info event.
 */
export function logListening(env: NodeJS.ProcessEnv = process.env): void {
	// No host in the banner: the server binds every interface (see start()'s httpServer.listen()),
	// so there is no single hostname to report.
	const message = `Serving http://*:${env.PORT}${ENDPOINT} for ${env.NODE_ENV}.`
	if (env.NODE_ENV === 'production') Sentry.captureMessage(message, 'info')
	console.info(message)
}

/**
 * Drain Apollo, close the HTTP server, then disconnect the datasources and exit.
 */
export const gracefulShutdown = async (signal: string, apolloServer: ApolloServer, httpServer: http.Server) => {
	Sentry.captureMessage(`${signal} received, shutting down gracefully...`)
	await apolloServer.stop()
	httpServer.close(() => disconnectAllDatabases(0))
}

export function onUnhandledRejection(reason: unknown): void {
	Sentry.captureException(reason)
	process.exit(1)
}

export function onUncaughtException(error: unknown): void {
	Sentry.captureException(error)
	process.exit(1)
}

/**
 * Build the Koa app + Apollo + HTTP server and start Apollo, WITHOUT connecting the
 * datasources or listening. Returned handles let callers (and tests) drive the server.
 */
export async function createServer() {
	/****************
	 * KOA
	 */
	const app = new Koa()
	app.use(tdwKoaErrorHandler)

	// No cookie signing keys here: this tier authenticates with the `Authorization: Bearer access:`
	// header against Redis. The refresh cookie is minted and read by 4031.
	app.use(async (ctx: IContextUserAuthenticatedResource, next: Next) => {
		await authorizationAuthenticatedResourceHandler()(ctx, next)
	})

	// ⚠️ **No `graphqlUploadKoa` and no `initClamScan`, unlike the two shop-owner/operator resource
	// services.** A customer uploads nothing: the private area is a profile and a list of addresses.
	// The upload middleware is not free to mount — it takes over every multipart request before the
	// body parser sees it — and the antivirus is a socket to clamd that would have to be running for
	// this service to boot. They come back the day this tier accepts a file, and not before.
	app.use(
		bodyParserKoa({
			enableTypes: ['json', 'form', 'text'],
			extendTypes: {
				json: ['application/json']
			}
		})
	) // needed by Apollo too

	/****************
	 * KOA ENDPOINT
	 */
	app.use(async (ctx: Context, next: Next) => {
		if (ctx.path === ENDPOINT) {
			// @ts-expect-error TS2769: No overload matches this call.
			const middleware = apolloServerKoa(apolloServer, {
				async context() {
					return ctx
				}
			})
			return middleware(ctx, next)
		} else if (ctx.path === '/health') {
			ctx.body = healthResponse()
			ctx.status = 200
			return
		} else {
			await next()
		}
	})

	/****************
	 * APOLLO
	 */
	const httpServer = http.createServer(app.callback())

	const graphQLSchema = new GraphQLSchema({
		query: QueriesPublic,
		mutation: MutationsPublic
	})

	const apolloServer = new ApolloServer({
		schema: graphQLSchema,
		plugins: [ApolloServerPluginDrainHttpServer({ httpServer })],
		validationRules: buildValidationRules(),
		csrfPrevention: true
	})

	await apolloServer.start()

	return { app, httpServer, apolloServer }
}

/**
 * Full boot: validate env, connect the datasources, build the server and listen.
 * Returns the handles on success; on failure disconnects and exits.
 */
export async function start() {
	checkRequiredEnv()

	try {
		/****************
		 * DB
		 */
		await Promise.all([MongoDBConnect(), RedisConnect()])

		/****************
		 * Field encryption (ADR-029)
		 *
		 * After MongoDBConnect() and before anything can query: it reuses the connection mongoose has
		 * just opened, and the models refuse to read or write a personal field until it has run. It
		 * throws rather than warning if the master key is missing — a service that started without it
		 * would write plaintext into collections whose other documents are ciphertext, and nothing
		 * would show that up until someone read the data back.
		 */
		await setupFieldEncryption()

		const { httpServer, apolloServer } = await createServer()

		/****************
		 * START SERVER
		 */
		await new Promise<void>((resolve) => {
			httpServer.listen(
				{
					port: process.env.PORT
					// No host: bind every interface on purpose. This used to pass a hostname key, which is not
					// a net.Server.listen option — Node ignored it and bound the unspecified address anyway, so
					// HOSTNAME never had any effect. Binding wide is the intent; the dead key only hid it.
				},
				() => {
					logListening()
					resolve()
				}
			)
		})

		return { httpServer, apolloServer }
	} catch (error) {
		console.error('error', error)
		Sentry.captureException(error) // @fixme does not send the log — check!
		await disconnectAllDatabases(1)
	}
}

/* v8 ignore start -- entrypoint wiring: executes only as the real process, never under test (NODE_ENV=test) */
if (process.env.NODE_ENV !== 'test') {
	// Handle unhandled promise rejections / uncaught exceptions
	process.on('unhandledRejection', onUnhandledRejection)
	process.on('uncaughtException', onUncaughtException)

	start()
		.then((srv) => {
			if (srv) {
				// Handle termination signals once the server is up
				process.on('SIGTERM', () => gracefulShutdown('SIGTERM', srv.apolloServer, srv.httpServer))
				process.on('SIGINT', () => gracefulShutdown('SIGINT', srv.apolloServer, srv.httpServer))
			}
		})
		.catch((e: unknown) => {
			/*
			 * ⚠️ The exit code is the whole point, and it used to be **0**. `checkRequiredEnv()` throws
			 * outside `start()`'s own try, so a missing variable lands here rather than in the
			 * disconnect-and-exit inside it — and this handler ended with a Sentry call and nothing else.
			 * Node then ran out of work and left with a success code: a service that never bound its port
			 * reported a clean shutdown to Docker, to systemd and to any restart policy reading `$?`, so a
			 * boot that failed was indistinguishable from one that was asked to stop. Sentry cannot stand in
			 * for the code either — with no DSN configured the SDK discards the event, which is the state
			 * this platform boots in. Say it where the container's own logs are, then leave with 1.
			 */
			console.error('fatal: the service could not start', e)
			Sentry.captureException(e)
			process.exit(1)
		})
}
/* v8 ignore stop */
