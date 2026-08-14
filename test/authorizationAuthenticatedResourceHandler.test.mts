import type { Next } from 'koa'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { IContextUserAuthenticatedResource } from '../src/lib/auth/IContextUserAuthenticatedResource.mts'

const hGetAll = vi.fn()
vi.mock('@axiumine/koa-utils/dataSources/Redis', () => ({ redisClient: { hGetAll } }))

const { authorizationAuthenticatedResourceHandler } = await import('../src/lib/db/authorizationAuthenticatedResourceHandler.mts')

const ACCESS = 'access:27119032-9043-4a9f-bd4c-9d06fd576290'
const HASHED_KEY = 'test:6253e8d18a8aa31f98971b62f24fc89ef651d784027d967481e61f4f00a8d760'
const RAW_KEY = `test:${ACCESS}`
// A real 24-hex ObjectId: makeAuthCtx feeds redData._id straight into new Types.ObjectId().
const OID = '507f1f77bcf86cd799439011'

function makeCtx(header?: Record<string, string>) {
	return { request: { header }, state: {} } as unknown as IContextUserAuthenticatedResource
}

/** Redis returns a prototype-less object; the handler spreads it, so mimic that shape. */
function redisSession(extra: Record<string, string> = {}) {
	return Object.assign(Object.create(null), { _id: OID, email: 'cliente@marketplace.test', tier: 'user', ...extra })
}

describe('authorizationAuthenticatedResourceHandler', () => {
	let next: Next

	beforeEach(() => {
		hGetAll.mockReset()
		next = vi.fn().mockResolvedValue('next') as unknown as Next
	})

	// AB-01: a valid credential is accepted and the session it resolves reaches ctx.state.user
	it('builds state.user from the Redis session', async () => {
		hGetAll.mockResolvedValueOnce(redisSession())

		const ctx = makeCtx({ authorization: `Bearer ${ACCESS}` })

		await expect(authorizationAuthenticatedResourceHandler()(ctx, next)).resolves.toBe('next')

		// ⚠️ The key is a digest, not the token (E13-S01). 'access:' stays *inside* the hashed value — it
		// is what tells an access hash from a refresh one — and the digest is written out as a literal,
		// computed elsewhere: hashing the token here with the call the code makes would agree with it
		// about any algorithm, including a mutated one.
		expect(hGetAll).toHaveBeenCalledExactlyOnceWith(HASHED_KEY)
		expect(HASHED_KEY).not.toContain(ACCESS)
		expect(String(ctx.state.user._id)).toBe(OID)
		expect(ctx.state.user.email).toBe('cliente@marketplace.test')
		expect(next).toHaveBeenCalledTimes(1)
	})

	/*
	 * ⚠️ **The inverted E13-S02 test** (E13-S10). The fixture is the one that used to prove the cutover was
	 * survivable — a perfectly valid session sitting under the raw-token key — and the expected answer is
	 * now 498, because this handler names that key nowhere.
	 *
	 * Kept rather than deleted, because what needs asserting is not "the fallback left the source" but
	 * "the raw key is unreachable from here": one `hGetAll`, for the digest, and no second read of any
	 * shape. A reintroduced fallback fails on the call list even if it were spelled differently.
	 */
	it('refuses a session written under the raw key, and never reads that key', async () => {
		hGetAll.mockResolvedValueOnce({}).mockResolvedValueOnce(redisSession())

		const ctx = makeCtx({ authorization: `Bearer ${ACCESS}` })

		await expect(authorizationAuthenticatedResourceHandler()(ctx, next)).rejects.toThrow('Invalid Token')

		expect(hGetAll).toHaveBeenCalledExactlyOnceWith(HASHED_KEY)
		expect(hGetAll.mock.calls.flat()).not.toContain(RAW_KEY)
		expect(next).not.toHaveBeenCalled()
	})

	// ⚠️ The whole cross-tier boundary is this one assertion. All nine services read Redis under the
	// same `REDIS_KEY` prefix — deliberately, because the single logout service finds a session by
	// token content alone — so a ShopOwner access token is *findable* here and, before the tier
	// existed, was simply accepted: its `_id` reached the customer resolvers, which then read and
	// wrote whatever `user` document happened to share that id.
	// AB-02: a session minted for another tier is refused with 403, not 401
	it.each([['shopOwner'], ['admin']])('refuses a session minted for the %s tier with a 403', async (tier) => {
		hGetAll.mockResolvedValueOnce(redisSession({ tier }))

		const ctx = makeCtx({ authorization: `Bearer ${ACCESS}` })

		await expect(authorizationAuthenticatedResourceHandler()(ctx, next)).rejects.toThrow('Forbidden')
		expect(ctx.state.user).toBeUndefined()
		expect(next).not.toHaveBeenCalled()
	})

	// Fail closed. A session predating the discriminator carries no tier and is refused by
	// `actual !== expected` with no branch of its own — treating it as a wildcard would have kept the
	// hole open for the whole 90-day refresh lifetime, and costs those sessions one re-login to close.
	// AB-03: a session carrying no tier at all is refused — fail closed, never a wildcard
	it('refuses a session with no tier at all', async () => {
		const session = redisSession()
		delete session.tier
		hGetAll.mockResolvedValueOnce(session)

		const ctx = makeCtx({ authorization: `Bearer ${ACCESS}` })

		await expect(authorizationAuthenticatedResourceHandler()(ctx, next)).rejects.toThrow('Forbidden')
	})

	// 403 and not 401, and this is the assertion that pins it: the caller authenticated correctly, it
	// simply authenticated somewhere else. A 401 tells a client to refresh its way out, which it
	// cannot — the refresh would mint another token of the same wrong tier.
	it('answers 403 rather than 401 for a wrong tier, so the client does not try to refresh', async () => {
		hGetAll.mockResolvedValueOnce(redisSession({ tier: 'admin' }))

		const ctx = makeCtx({ authorization: `Bearer ${ACCESS}` })

		try {
			await authorizationAuthenticatedResourceHandler()(ctx, next)
			expect.unreachable('the wrong tier was expected to be refused')
		} catch (e) {
			expect((e as { extensions: { http: { status: number } } }).extensions.http.status).toBe(403)
		}
	})

	// AB-04: a request carrying no credential is refused
	// AB-10: no x-introspectioncode at all leaves the ordinary refusal exactly as it is
	it('answers 412 when there is no authorization header', async () => {
		const ctx = makeCtx({})

		await expect(authorizationAuthenticatedResourceHandler()(ctx, next)).rejects.toThrow('Precondition Failed')
		expect(hGetAll).not.toHaveBeenCalled()
		expect(next).not.toHaveBeenCalled()
	})

	// ctx.request.header itself can be absent (the optional-chained read yields undefined), which is
	// a different branch from "header present but carrying no authorization".
	it('answers 412 when the request has no headers at all', async () => {
		const ctx = makeCtx(undefined)

		await expect(authorizationAuthenticatedResourceHandler()(ctx, next)).rejects.toThrow('Precondition Failed')
	})

	// AB-05: a credential of the wrong shape is refused — a bad scheme, a broken signature
	it('answers 499 when the header does not use the `Bearer access:` scheme', async () => {
		const ctx = makeCtx({ authorization: `Bearer ${OID}` })

		await expect(authorizationAuthenticatedResourceHandler()(ctx, next)).rejects.toThrow('Token Required')
		expect(hGetAll).not.toHaveBeenCalled()
	})

	// AB-06: a credential whose session is gone from Redis is refused
	it('answers 498 when the session is gone from Redis', async () => {
		hGetAll.mockResolvedValueOnce({})

		const ctx = makeCtx({ authorization: `Bearer ${ACCESS}` })

		await expect(authorizationAuthenticatedResourceHandler()(ctx, next)).rejects.toThrow('Invalid Token')
		expect(next).not.toHaveBeenCalled()
	})

	it('answers 498 when Redis answers null instead of a hash', async () => {
		hGetAll.mockResolvedValueOnce(null)

		const ctx = makeCtx({ authorization: `Bearer ${ACCESS}` })

		await expect(authorizationAuthenticatedResourceHandler()(ctx, next)).rejects.toThrow('Invalid Token')
	})

	// Service-to-service calls: the code stands in for the whole bearer flow, so no Redis lookup
	// happens and state.user is never populated. Resolvers that need ctx.state.user must not be
	// called this way — introspection is what this is for.
	// AB-08: a valid x-introspectioncode is accepted with no credential at all, and reads no session
	it('lets a valid x-introspectioncode through with no authorization header', async () => {
		const ctx = makeCtx({ 'x-introspectioncode': 'test-introspection-code' })

		await expect(authorizationAuthenticatedResourceHandler()(ctx, next)).resolves.toBe('next')

		expect(hGetAll).not.toHaveBeenCalled()
		expect(ctx.state.user).toBeUndefined()
		expect(next).toHaveBeenCalledTimes(1)
	})

	// AB-09: a wrong x-introspectioncode is refused
	it('ignores a wrong x-introspectioncode', async () => {
		const ctx = makeCtx({ 'x-introspectioncode': 'wrong-code' })

		await expect(authorizationAuthenticatedResourceHandler()(ctx, next)).rejects.toThrow('Precondition Failed')
	})

	// The code is only consulted when the header is missing: a caller that sends both is
	// authenticated normally, and a bad token is still refused.
	it('does not let the introspection code rescue a bearer token whose session expired', async () => {
		hGetAll.mockResolvedValueOnce({})

		const ctx = makeCtx({ authorization: `Bearer ${ACCESS}`, 'x-introspectioncode': 'test-introspection-code' })

		await expect(authorizationAuthenticatedResourceHandler()(ctx, next)).rejects.toThrow('Invalid Token')
	})

	// Nor the reverse: the introspection bypass must not become a way around the tier assertion.
	it('does not let the introspection code rescue a bearer token from another tier', async () => {
		hGetAll.mockResolvedValueOnce(redisSession({ tier: 'admin' }))

		const ctx = makeCtx({ authorization: `Bearer ${ACCESS}`, 'x-introspectioncode': 'test-introspection-code' })

		await expect(authorizationAuthenticatedResourceHandler()(ctx, next)).rejects.toThrow('Forbidden')
	})
	/*
	 * E13-S11. The bypass is a development convenience and outside `development` and `test` it does not
	 * exist: the gate is read before the code is, so the configured value is never consulted and the
	 * header is worth exactly what a header nobody sent is worth.
	 */
	describe('outside the environment allowlist', () => {
		afterEach(() => {
			vi.unstubAllEnvs()
		})

		/** The rejection flattened to what an HTTP client actually sees. */
		const refusal = async (header?: Record<string, string>) => {
			try {
				await authorizationAuthenticatedResourceHandler()(makeCtx(header), next)
			} catch (error) {
				const { message, extensions } = error as { message: string; extensions: unknown }
				return { message, extensions }
			}
			throw new Error('expected the handler to reject, and it returned')
		}

		// Every value below is admitted by the `NODE_ENV !== 'production'` form this gate replaced, and
		// each is a shape a real deploy produces: a container runtime that exports nothing, a shell that
		// exports an empty string, a capital letter, a staging box nobody ever classified.
		// AB-11: a valid x-introspectioncode is refused outside the environment allowlist, indistinguishably from none
		it.each([['production'], ['staging'], ['Production'], [''], [undefined]])(
			'refuses a valid x-introspectioncode under NODE_ENV=%o',
			async (environment) => {
				vi.stubEnv('NODE_ENV', environment)

				const ctx = makeCtx({ 'x-introspectioncode': 'test-introspection-code' })

				await expect(authorizationAuthenticatedResourceHandler()(ctx, next)).rejects.toThrow('Precondition Failed')

				expect(hGetAll).not.toHaveBeenCalled()
				expect(ctx.state.user).toBeUndefined()
				expect(next).not.toHaveBeenCalled()
			}
		)

		// ⚠️ The refusal is the handler's own, down to the status and the description. A gate that threw
		// something of its own would tell the caller that the code was right and only the environment
		// wrong — which is the one thing the response must not distinguish.
		it('refuses it with the error a request carrying no header at all gets', async () => {
			vi.stubEnv('NODE_ENV', 'production')

			expect(await refusal({ 'x-introspectioncode': 'test-introspection-code' })).toEqual(await refusal())
		})
	})
})
