import { redisClient } from '@axiumine/koa-utils/dataSources/Redis'
import { throwAccessTokenExpiredOrDeleted } from '@axiumine/koa-utils/graphQL/throw/throwAccessTokenExpiredOrDeleted'
import { throwAccessTokenRequired } from '@axiumine/koa-utils/graphQL/throw/throwAccessTokenRequired'
import { throwPreconditionFailedNoAuthHeader } from '@axiumine/koa-utils/graphQL/throw/throwPreconditionFailedNoAuthHeader'
import { assertTier } from '@axiumine/marketplace-common/others/assertTier'
import { IRedisDataUser } from '@axiumine/marketplace-common/others/Redis/IRedisDataUser'
import { readSessionHash } from '@axiumine/marketplace-common/others/sessionKeys'
import { TIER } from '@axiumine/marketplace-common/others/Tier'
import { IContextUserAuthenticatedResource } from '@lib/auth/IContextUserAuthenticatedResource.mjs'
import { makeAuthCtx } from '@lib/auth/makeAuthCtx.mjs'
import * as dotenv from 'dotenv'
import { Next } from 'koa'

dotenv.config()

export const authorizationAuthenticatedResourceHandler = () => async (ctx: IContextUserAuthenticatedResource, next: Next) => {
	/***************************
	 * The client sends an opaque access token in `Authorization: Bearer access:<token>`.
	 * No cookie is read on this tier — the refresh cookie is minted and consumed by 4031.
	 */

	const authorization = ctx.request.header?.authorization // access
	// more detailed errors code instead of generic 401 unauthorized (tampering)
	if (typeof authorization === 'undefined') {
		throw throwPreconditionFailedNoAuthHeader()
	}

	if (!authorization.startsWith('Bearer access:')) {
		throw throwAccessTokenRequired()
	}

	// No `accessToken !== ''` guard: the startsWith check above already guarantees the token
	// keeps its `access:` prefix after the replace, so the empty case is unreachable.
	const accessToken = authorization.replace('Bearer ', '')

	// Keyed by the digest of the prefixed token, and by nothing else: there is no raw-key
	// fallback. The `access:` prefix stays part of the hashed value: it is what tells an access hash from
	// a refresh one, so it belongs inside the digest, not beside it.
	const redAccessSession = await readSessionHash(redisClient, accessToken) // 'access:' already present
	// `readSessionHash` normalises a missing or nullish reply to an empty hash, so this one test is
	// the whole "is there a session" question — the `!= null` arm it replaces is now unreachable.
	if (Object.keys(redAccessSession).length !== 0) {
		const redData = { ...redAccessSession } as unknown as IRedisDataUser // For safety, Redis return an object without the default Object.prototype  in its prototype chain.
		// The whole cross-tier boundary, in one call. All nine services read Redis under the same
		// `REDIS_KEY` prefix, so an Admin or ShopOwner access token is *findable* here; without the
		// assertion its `_id` would be handed straight to the customer resolvers, which would then
		// read and write whatever `user` document happens to share that id — or, more likely, act on
		// nothing at all while reporting success. Nothing downstream re-derives the tier:
		// `makeAuthCtx` builds the `ForNode` shape and deliberately drops it, so this call site is
		// the only place the question is asked. A session with no `tier` predates the discriminator
		// and is refused too: fail closed, re-login.
		assertTier(redData.tier, TIER.user)
		ctx.state.user = makeAuthCtx(redData)
	} else throwAccessTokenExpiredOrDeleted()

	return next()
}
