import { Types } from 'mongoose'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { IContextUserAuthenticatedResource } from '../src/lib/auth/IContextUserAuthenticatedResource.mts'

const hKeys = vi.fn()
const del = vi.fn()

/*
 * ⚠️ Only the client is faked. `revokeAllSessionsForAccount` and `deleteSession` run for real, so what
 * this suite asserts is the Redis conversation itself — the key shapes, their order and their count —
 * rather than that two mocks were called. A mocked helper would agree with a wrong key.
 */
vi.mock('@axiumine/koa-utils/dataSources/Redis', () => ({ redisClient: { hKeys, del } }))

const { endEverySession } = await import('../src/lib/auth/endEverySession.mts')

const REDIS_KEY = 'test:'
const ACCOUNT_ID = '507f1f77bcf86cd799439011'

// Three live sessions, one of them the caller's own. The digests are arbitrary here: the index stores
// the body of each refresh session's key, and this service never sees a refresh token to derive one from.
const CALLER_REFRESH_FIELD = 'a'.repeat(64)
const FIELDS = [CALLER_REFRESH_FIELD, 'b'.repeat(64), 'c'.repeat(64)]

// The access token the mutation arrived with, and the digest of it written out as a literal — computed
// elsewhere, because a test that hashed it with the same call the implementation makes would agree with
// that call about any algorithm, including a mutated one.
const ACCESS_TOKEN = 'access:access-token-1'
const ACCESS_DIGEST = '19195cd4fbcc945be28c2decfc4a2fb1bf34f4ec333f3973d3e2522bd9dbebc1'

// ⚠️ The header is passed as the whole object, never as `ctx(undefined)`: an explicit `undefined`
// argument takes the default parameter, so the no-header case would have quietly tested the header one.
const ctx = (header: Record<string, string> = { authorization: `Bearer ${ACCESS_TOKEN}` }) =>
	({
		state: { user: { _id: new Types.ObjectId(ACCOUNT_ID) } },
		request: { header }
	}) as unknown as IContextUserAuthenticatedResource

// `request.header` is optional on the context type and genuinely absent on some requests, which is a
// different shape from a header object with no `authorization` in it and has to be built separately —
// passing `undefined` to the factory above takes the default parameter instead.
const ctxWithoutHeaders = () =>
	({ state: { user: { _id: new Types.ObjectId(ACCOUNT_ID) } }, request: {} }) as unknown as IContextUserAuthenticatedResource

beforeEach(() => {
	vi.stubEnv('REDIS_KEY', REDIS_KEY)
	hKeys.mockReset().mockResolvedValue(FIELDS)
	del.mockReset().mockResolvedValue(1)
})

afterEach(() => {
	vi.unstubAllEnvs()
})

describe('endEverySession', () => {
	/*
	 * ⚠️ **The caller's session is revoked with the rest, and the assertion says so rather than leaving it
	 * emergent** (decided 2026-08-10). Exempting the caller is friendlier and was rejected: the person
	 * changing their password because someone else is in the account cannot tell which session is theirs,
	 * and neither can the server — the exemption would be granted to whichever session sent the mutation,
	 * which is one an attacker holding the password can send.
	 */
	it('revokes every session the account holds, the caller’s included', async () => {
		await endEverySession(ctx())

		expect(hKeys).toHaveBeenCalledExactlyOnceWith(`${REDIS_KEY}idx:user:${ACCOUNT_ID}`)
		expect(del.mock.calls.map(([key]) => key)).toContain(`${REDIS_KEY}${CALLER_REFRESH_FIELD}`)
		expect(del.mock.calls.slice(0, FIELDS.length).flat()).toEqual(FIELDS.map((field) => `${REDIS_KEY}${field}`))
	})

	/*
	 * ⚠️ **Both of the caller's keys, not only the refresh one.** A revoke that dropped the refresh session
	 * alone would leave the caller — and therefore an attacker who has just been handed the new password —
	 * working until the access token expired on its own, which is exactly the window the change was made to
	 * close. Both shapes go, because a session minted before E13's cutover lives under the raw token.
	 */
	it('deletes the caller’s access session, in both key shapes', async () => {
		await endEverySession(ctx())

		const keys = del.mock.calls.map(([key]) => key)

		expect(keys).toContain(`${REDIS_KEY}${ACCESS_DIGEST}`)
		expect(keys).toContain(`${REDIS_KEY}${ACCESS_TOKEN}`)
		expect(del.mock.calls.every((call) => call.length === 1)).toBe(true)
	})

	/*
	 * ⚠️ **Refresh sessions first, the access key second.** A failure between the two must leave the smaller
	 * residue: the caller's access token alive for the minutes it has left, which every other device already
	 * carries anyway. Reversed, the refresh sessions survive — and refreshing one is how the intruder gets
	 * another access token.
	 */
	it('ends the refresh sessions before the caller’s access key', async () => {
		await endEverySession(ctx())

		const accessDeletes = del.mock.calls
			.map(([key], index) => ({ key, index }))
			.filter(({ key }) => key === `${REDIS_KEY}${ACCESS_DIGEST}` || key === `${REDIS_KEY}${ACCESS_TOKEN}`)

		expect(Math.min(...accessDeletes.map(({ index }) => index))).toBeGreaterThan(FIELDS.length - 1)
	})

	// The index key is deleted last of the account's own keys, which is what makes an interrupted revocation
	// safe to run again — the routine's own contract, asserted here because this is its first call site.
	it('deletes the account index after the sessions it names', async () => {
		await endEverySession(ctx())

		expect(del.mock.calls[FIELDS.length]).toEqual([`${REDIS_KEY}idx:user:${ACCOUNT_ID}`])
	})

	/*
	 * The introspection bypass reaches a resolver with no `Authorization` header at all, so there is no
	 * caller session to end — the account's own sessions still go. Deriving a key from a missing header
	 * would delete the digest of the empty string: a key belonging to nobody, and a delete reported as a
	 * success.
	 */
	it('deletes no access key when the request carried no Authorization header', async () => {
		await endEverySession(ctx({}))

		expect(del).toHaveBeenCalledTimes(FIELDS.length + 1)
		expect(del.mock.calls.map(([key]) => key)).not.toContain(`${REDIS_KEY}${ACCESS_DIGEST}`)
	})

	/*
	 * ⚠️ **`request.header` missing entirely, not merely empty.** The optional access is load-bearing: a
	 * context built without headers at all reaches here — the type says so and the auth middleware guards
	 * the same property the same way — and reading `.authorization` straight off `undefined` throws a
	 * `TypeError` out of a resolver that has already written the new password, turning a completed change
	 * into a 500 and skipping the revocation entirely.
	 */
	it('revokes the account’s sessions when the request carried no headers at all', async () => {
		await expect(endEverySession(ctxWithoutHeaders())).resolves.toBeUndefined()

		expect(del.mock.calls).toEqual([...FIELDS.map((field) => [`${REDIS_KEY}${field}`]), [`${REDIS_KEY}idx:user:${ACCOUNT_ID}`]])
	})

	// An account whose sessions have all expired revokes quietly: `hKeys` on a missing key answers an empty
	// array, and there is then nothing to delete but the caller's own access key.
	it('still ends the caller’s access session when the index is empty', async () => {
		hKeys.mockResolvedValueOnce([])

		await endEverySession(ctx())

		expect(del.mock.calls).toEqual([[`${REDIS_KEY}${ACCESS_DIGEST}`], [`${REDIS_KEY}${ACCESS_TOKEN}`]])
	})
})
