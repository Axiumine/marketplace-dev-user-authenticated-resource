import { Types } from 'mongoose'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { IContextUserAuthenticatedResource } from '../src/lib/auth/IContextUserAuthenticatedResource.mts'

const hKeys = vi.fn()
const hGet = vi.fn()
const del = vi.fn()
const hDel = vi.fn()

/*
 * ⚠️ Only the client is faked. `revokeAllSessionsForAccount` and `deleteSession` run for real, so what
 * this suite asserts is the Redis conversation itself — the key shapes, their order and their count —
 * rather than that two mocks were called. A mocked helper would agree with a wrong key.
 */
vi.mock('@axiumine/koa-utils/dataSources/Redis', () => ({ redisClient: { hKeys, hGet, del, hDel } }))

const { endEverySession } = await import('../src/lib/auth/endEverySession.mts')

const REDIS_KEY = 'test:'
const ACCOUNT_ID = '507f1f77bcf86cd799439011'

// Three live sessions, one of them the caller's own. The digests are arbitrary here: the index stores
// the body of each refresh session's key, and this service never sees a refresh token to derive one from.
const CALLER_REFRESH_FIELD = 'a'.repeat(64)
const FIELDS = [CALLER_REFRESH_FIELD, 'b'.repeat(64), 'c'.repeat(64)]

/*
 * Each refresh session names the access session it minted, in its own `accessKey` field (R54). The stub
 * answers the session key upper-cased, which is not a key shape the platform ever writes and is exactly
 * why it is used here: a `del` of one of these can only have come from reading the field, never from the
 * routine deriving a key from the field it already had.
 */
const accessKeyOf = (sessionKey: string) => sessionKey.toUpperCase()
const SESSION_KEYS = FIELDS.map((field) => `${REDIS_KEY}${field}`)

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
	hGet.mockReset().mockImplementation((key: string) => Promise.resolve(accessKeyOf(key)))
	del.mockReset().mockResolvedValue(1)
	hDel.mockReset().mockResolvedValue(1)
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

		// Twice, both on the user index: the second is the revoke routine's re-read, which is what licenses
		// the delete of the index key at the end.
		expect(hKeys.mock.calls).toEqual([[`${REDIS_KEY}idx:user:${ACCOUNT_ID}`], [`${REDIS_KEY}idx:user:${ACCOUNT_ID}`]])
		expect(del.mock.calls.map(([key]) => key)).toContain(`${REDIS_KEY}${CALLER_REFRESH_FIELD}`)
		expect(del.mock.calls.slice(FIELDS.length, FIELDS.length * 2).flat()).toEqual(SESSION_KEYS)
	})

	/*
	 * ⚠️ **Every session's access token is ended, not only the caller's** (R54, 2026-08-13). This is the
	 * assertion that says the other devices stop working now rather than in up to 91 minutes: the routine
	 * reads each session's `accessKey` field and deletes the key it names, and it does so while the hash is
	 * still there — a read after the `del` would answer nothing and leave the access half orphaned.
	 */
	it('ends the access half of every session, before the session that names it', async () => {
		await endEverySession(ctx())

		expect(hGet.mock.calls).toEqual(SESSION_KEYS.map((key) => [key, 'accessKey']))
		expect(del.mock.calls.slice(0, FIELDS.length).flat()).toEqual(SESSION_KEYS.map(accessKeyOf))
	})

	/*
	 * A session hash minted before the field existed carries no `accessKey`, and one that expired between
	 * the index read and its own `del` carries nothing at all. Both answer `null`, and neither may stop the
	 * revocation: the pre-R54 behaviour is the floor here, never the outcome of a failed read.
	 */
	it('revokes sessions that name no access key, and deletes no key for them', async () => {
		hGet.mockResolvedValue(null)

		await endEverySession(ctx())

		expect(del.mock.calls.slice(0, FIELDS.length).flat()).toEqual(SESSION_KEYS)
		expect(del.mock.calls[FIELDS.length]).toEqual([`${REDIS_KEY}idx:user:${ACCOUNT_ID}`])
	})

	/*
	 * ⚠️ **Both of the caller's keys, not only the refresh one.** A revoke that dropped the refresh session
	 * alone would leave the caller — and therefore an attacker who has just been handed the new password —
	 * working until the access token expired on its own, which is exactly the window the change was made to
	 * close. One key shape, and one only: the raw-token shape this used to delete alongside the digest is
	 * unwritable and unreadable, so deleting it would be a round trip against a key that cannot exist.
	 */
	it('deletes the caller’s access session, under the digest and not under the token', async () => {
		await endEverySession(ctx())

		const keys = del.mock.calls.map(([key]) => key)

		expect(keys).toContain(`${REDIS_KEY}${ACCESS_DIGEST}`)
		expect(keys).not.toContain(`${REDIS_KEY}${ACCESS_TOKEN}`)
		expect(del.mock.calls.every((call) => call.length === 1)).toBe(true)
	})

	/*
	 * ⚠️ **Refresh sessions first, the caller's own access key second.** A failure between the two must leave
	 * the smaller residue: an access token alive for the minutes it has left. Reversed, the refresh sessions
	 * survive — and refreshing one is how the intruder gets another access token. This is the *outer* order,
	 * and deliberately the opposite of the order inside the revocation, where each session's access half is
	 * read out of the hash before that hash is deleted (R54) — afterwards the read finds nothing.
	 */
	it('ends the refresh sessions before the caller’s access key', async () => {
		await endEverySession(ctx())

		const accessDeletes = del.mock.calls
			.map(([key], index) => ({ key, index }))
			.filter(({ key }) => key === `${REDIS_KEY}${ACCESS_DIGEST}` || key === `${REDIS_KEY}${ACCESS_TOKEN}`)

		expect(Math.min(...accessDeletes.map(({ index }) => index))).toBeGreaterThan(FIELDS.length * 2 - 1)
	})

	// The index key is deleted last of the account's own keys, which is what makes an interrupted revocation
	// safe to run again — the routine's own contract, asserted here because this is its first call site.
	it('deletes the account index after the sessions it names', async () => {
		await endEverySession(ctx())

		expect(del.mock.calls[FIELDS.length * 2]).toEqual([`${REDIS_KEY}idx:user:${ACCOUNT_ID}`])
	})

	/*
	 * ⚠️ **A login landing mid-revoke does not survive the teardown**, asserted at the call site rather than
	 * left to the shared routine's own suite — this is the scenario the mutation exists for. The customer
	 * changes their password because someone else is in the account, and that someone logs in again between
	 * the index read and its delete. The routine's re-read ends the second session too, and the index key
	 * survives until it has: deleting it there would leave a live session nothing could name.
	 */
	it('revokes a session that appeared during the revoke, and keeps the index until it has', async () => {
		const NEWCOMER = 'd'.repeat(64)

		hKeys
			.mockResolvedValueOnce(FIELDS)
			.mockResolvedValueOnce([...FIELDS, NEWCOMER])
			.mockResolvedValueOnce([...FIELDS, NEWCOMER])

		await endEverySession(ctx())

		// Two rounds, each one its access halves first and its refresh keys second, then the index key: the
		// newcomer's own access token goes too, which is what makes the re-read a revocation and not a tidy-up.
		expect(del.mock.calls.slice(0, FIELDS.length * 2 + 3)).toEqual([
			...SESSION_KEYS.map((key) => [accessKeyOf(key)]),
			...SESSION_KEYS.map((key) => [key]),
			[accessKeyOf(`${REDIS_KEY}${NEWCOMER}`)],
			[`${REDIS_KEY}${NEWCOMER}`],
			[`${REDIS_KEY}idx:user:${ACCOUNT_ID}`]
		])
		expect(hDel.mock.calls).toEqual(FIELDS.map((field) => [`${REDIS_KEY}idx:user:${ACCOUNT_ID}`, field]))
	})

	/*
	 * The introspection bypass reaches a resolver with no `Authorization` header at all, so there is no
	 * caller session to end — the account's own sessions still go. Deriving a key from a missing header
	 * would delete the digest of the empty string: a key belonging to nobody, and a delete reported as a
	 * success.
	 */
	it('deletes no access key when the request carried no Authorization header', async () => {
		await endEverySession(ctx({}))

		expect(del).toHaveBeenCalledTimes(FIELDS.length * 2 + 1)
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

		expect(del.mock.calls).toEqual([
			...SESSION_KEYS.map((key) => [accessKeyOf(key)]),
			...SESSION_KEYS.map((key) => [key]),
			[`${REDIS_KEY}idx:user:${ACCOUNT_ID}`]
		])
	})

	// An account whose sessions have all expired revokes quietly: `hKeys` on a missing key answers an empty
	// array, and there is then nothing to delete but the caller's own access key — one key, under its digest,
	// and never a second one naming the raw token.
	it('still ends the caller’s access session when the index is empty', async () => {
		hKeys.mockResolvedValueOnce([])

		await endEverySession(ctx())

		expect(del).toHaveBeenCalledExactlyOnceWith(`${REDIS_KEY}${ACCESS_DIGEST}`)
	})
})
