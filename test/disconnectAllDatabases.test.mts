import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const RedisDisconnect = vi.fn()
const MongoDBDisconnect = vi.fn()
const captureMessage = vi.fn()
const captureException = vi.fn()
const flush = vi.fn()

vi.mock('@axiumine/koa-utils/dataSources/Redis', () => ({ RedisDisconnect }))
vi.mock('@axiumine/koa-utils/dataSources/MongoDB', () => ({ MongoDBDisconnect }))
vi.mock('@sentry/node', () => ({ captureMessage, captureException, flush }))

const { disconnectAllDatabases } = await import('../src/lib/db/disconnectAllDatabases.mts')

// process.exit is neutralized to a no-op: the function has a `never` return type, the no-op
// lets it carry on and the exit code is read from the spy without killing the vitest worker.
let exit: ReturnType<typeof vi.spyOn>

describe('disconnectAllDatabases', () => {
	beforeEach(() => {
		RedisDisconnect.mockReset().mockResolvedValue(undefined)
		MongoDBDisconnect.mockReset().mockResolvedValue(undefined)
		captureMessage.mockReset()
		captureException.mockReset()
		flush.mockReset().mockResolvedValue(true)
		exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never)
	})

	afterEach(() => {
		vi.restoreAllMocks()
		vi.useRealTimers()
	})

	it('disconnects both datasources and exits with 0 by default', async () => {
		await disconnectAllDatabases()

		expect(RedisDisconnect).toHaveBeenCalledTimes(1)
		expect(MongoDBDisconnect).toHaveBeenCalledTimes(1)
		expect(captureMessage).toHaveBeenCalledWith('All databases disconnected successfully', 'info')
		expect(flush).toHaveBeenCalledExactlyOnceWith(2000)
		expect(exit).toHaveBeenCalledExactlyOnceWith(0)
	})

	// This is the last stop before the process dies on every fatal path that routes through here
	// (including start()'s own catch), so process.exit() must wait on the flush settling — not just
	// happen to run after it is called. A mutant that fires exit() straight after captureMessage() and
	// lets the flush race in the background would pass every assertion above unnoticed.
	it('does not exit until the flush settles', async () => {
		let resolveFlush: (value: boolean) => void = () => undefined
		flush.mockReturnValueOnce(new Promise<boolean>((resolve) => (resolveFlush = resolve)))

		const pending = disconnectAllDatabases()
		await Promise.resolve()
		await Promise.resolve()
		await Promise.resolve()
		expect(exit).not.toHaveBeenCalled()

		resolveFlush(true)
		await pending

		expect(exit).toHaveBeenCalledExactlyOnceWith(0)
	})

	it('propagates the requested exit code', async () => {
		await disconnectAllDatabases(3)

		expect(exit).toHaveBeenCalledExactlyOnceWith(3)
	})

	it('exits with 1 and reports to Sentry if Redis fails to disconnect', async () => {
		RedisDisconnect.mockRejectedValueOnce(new Error('redis down'))

		await disconnectAllDatabases()

		expect(captureMessage).not.toHaveBeenCalled()
		expect(captureException).toHaveBeenCalledWith(expect.any(Error), {
			extra: { detail: 'Error during database disconnection' }
		})
		expect(flush).toHaveBeenCalledExactlyOnceWith(2000)
		expect(exit).toHaveBeenCalledExactlyOnceWith(1)
	})

	it('exits with 1 and reports to Sentry if MongoDB fails to disconnect', async () => {
		MongoDBDisconnect.mockRejectedValueOnce(new Error('mongo down'))

		await disconnectAllDatabases()

		expect(captureMessage).not.toHaveBeenCalled()
		expect(captureException).toHaveBeenCalledTimes(1)
		expect(flush).toHaveBeenCalledExactlyOnceWith(2000)
		expect(exit).toHaveBeenCalledExactlyOnceWith(1)
	})

	// Same ordering guarantee as the success arm, pinned separately because the catch block flushes
	// from a different call site.
	it('does not exit until the flush settles on the failure arm either', async () => {
		RedisDisconnect.mockRejectedValueOnce(new Error('redis down'))
		let resolveFlush: (value: boolean) => void = () => undefined
		flush.mockReturnValueOnce(new Promise<boolean>((resolve) => (resolveFlush = resolve)))

		const pending = disconnectAllDatabases()
		await Promise.resolve()
		await Promise.resolve()
		await Promise.resolve()
		expect(exit).not.toHaveBeenCalled()

		resolveFlush(true)
		await pending

		expect(exit).toHaveBeenCalledExactlyOnceWith(1)
	})

	// The race is what makes the shutdown bounded: a datasource that never answers would otherwise
	// hold the process open past whatever grace period the supervisor allows, and it would be killed
	// with a signal instead of exiting.
	it('exits with 1 if the disconnection exceeds the 5s timeout', async () => {
		vi.useFakeTimers()
		RedisDisconnect.mockReturnValueOnce(new Promise(() => {})) // never resolves

		const pending = disconnectAllDatabases()
		await vi.advanceTimersByTimeAsync(5000)
		await pending

		expect(captureException).toHaveBeenCalledTimes(1)
		expect(captureException.mock.calls[0][0]).toMatchObject({ message: 'Database disconnection timeout' })
		expect(flush).toHaveBeenCalledExactlyOnceWith(2000)
		expect(exit).toHaveBeenCalledExactlyOnceWith(1)
	})
})
