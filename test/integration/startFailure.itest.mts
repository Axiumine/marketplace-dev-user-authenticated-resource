import { redisClient } from '@axiumine/koa-utils/dataSources/Redis'
import mongoose from 'mongoose'
import { afterAll, describe, expect, it, vi } from 'vitest'

import { start } from '../../src/index.mts'

/*
 * start()'s catch arm — the boot-failure path — driven for real.
 *
 * No fault is simulated: the datasource URL is pointed at something MongoDB genuinely refuses, and
 * the real driver raises the real error. Redis still connects for real on the same Promise.all,
 * which is the point of doing it this way: the catch has to tear down a HALF-CONNECTED process, and
 * disconnectAllDatabases really closes that live Redis client on the way out.
 *
 * ⚠️ Unlike the shop-owner and admin resource services, there is nothing after the datasources to
 * fail differently — this tier mounts no `graphqlUploadKoa` and calls no `initClamScan`, because a
 * customer uploads nothing. The Promise.all is the whole of the risky part of boot.
 *
 * Its own file because it must run with nothing connected yet — the other suites boot the service in
 * their own beforeAll, and vitest gives each test file its own module registry, so this one starts
 * from a clean slate.
 */
describe('start() when MongoDB refuses the connection', () => {
	const realUri = process.env.MONGODB_URI

	afterAll(async () => {
		process.env.MONGODB_URI = realUri
		await redisClient.close().catch(() => undefined)
	})

	it('logs, tears down the datasources that did come up, and exits 1', async () => {
		// Shaped like a connection string, so both env guards pass it, and refused by the driver
		// itself, which cannot read `99999` as a port. That keeps the failure where this test wants it —
		// inside MongoDBConnect()'s real driver — and off the two guards, which the tests below own.
		process.env.MONGODB_URI = 'mongodb://127.0.0.1:99999/dbRefused'

		const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never)
		const errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined)

		try {
			// Resolves rather than throwing: the catch handles the error and (normally) exits.
			await expect(start()).resolves.toBeUndefined()

			expect(errorLog).toHaveBeenCalled()
			expect(exit).toHaveBeenCalledWith(1)

			// The teardown was real, not just attempted: mongoose never came up and the Redis client
			// that did is closed again.
			expect(mongoose.connection.readyState).toBe(0)
			expect(redisClient.isOpen).toBe(false)
		} finally {
			exit.mockRestore()
			errorLog.mockRestore()
		}
	})

	/*
	 * The env guard runs OUTSIDE start()'s try, so a missing variable is not caught, not reported to
	 * Sentry, and never reaches disconnectAllDatabases — it propagates straight out of start() and the
	 * process dies without touching a datasource. Driven through start() rather than by calling
	 * checkRequiredEnv() directly, so it is that ordering being tested and not just the guard's own
	 * loop.
	 *
	 * ⚠️ The sibling services delete `PLATFORM_NAME` here; this one has no such variable, because it
	 * sends no mail. `REDIS_DB3_PORT` is the pick instead: `vitest.config.mts` pins NODE_ENV,
	 * REDIS_KEY, PORT and MONGODB_URI for the integration project, and deleting
	 * one of those would fight the test harness itself. It is restored in the `finally` before
	 * anything reconnects — the guard throws on the first missing name it meets, and PORT (listed
	 * before it) is pinned, so nothing here ever reaches a Redis connect with the key absent.
	 */
	it('refuses to boot at all, and connects nothing, when a required variable is missing', async () => {
		const realKey = process.env.REDIS_DB3_PORT
		delete process.env.REDIS_DB3_PORT

		try {
			await expect(start()).rejects.toThrow('Missing required environment variable: REDIS_DB3_PORT')

			expect(mongoose.connection.readyState).toBe(0)
			expect(redisClient.isOpen).toBe(false)
		} finally {
			process.env.REDIS_DB3_PORT = realKey
		}
	})
})
