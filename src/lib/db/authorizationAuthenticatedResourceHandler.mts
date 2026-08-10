import { redisClient } from '@axiumine/koa-utils/dataSources/Redis'
import { throwAccessTokenExpiredOrDeleted } from '@axiumine/koa-utils/graphQL/throw/throwAccessTokenExpiredOrDeleted'
import { throwAccessTokenRequired } from '@axiumine/koa-utils/graphQL/throw/throwAccessTokenRequired'
import { throwPreconditionFailedNoAuthHeader } from '@axiumine/koa-utils/graphQL/throw/throwPreconditionFailedNoAuthHeader'
import { assertTier } from '@axiumine/marketplace-common/others/assertTier'
import { isIntrospectionBypassAllowed } from '@axiumine/marketplace-common/others/isIntrospectionBypassAllowed'
import { IRedisDataUser } from '@axiumine/marketplace-common/others/Redis/IRedisDataUser'
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

	let introspection = false

	const authorization = ctx.request.header?.authorization // access
	// more detailed errors code instead of generic 401 unauthorized (tampering)
	if (typeof authorization === 'undefined') {
		// ⚠️ The environment gate is evaluated **before** the code is read (E13-S11). Outside `development`
		// and `test` the bypass does not exist at all, and a caller sending the correct header gets exactly
		// the error a caller sending nothing gets — a wrong code and a disabled feature must not be
		// distinguishable from the outside. `INTROSPECTION_CODE` stays in REQUIRED_ENV_VARS regardless:
		// unset, it stringifies to the literal `'undefined'`, and that word would be the bypass.
		if (
			isIntrospectionBypassAllowed() &&
			typeof ctx.request.header !== 'undefined' &&
			ctx.request.header['x-introspectioncode'] === `${process.env.INTROSPECTION_CODE}`
		) {
			introspection = true
		} else {
			throw throwPreconditionFailedNoAuthHeader()
		}
	}
	// `!introspection &&` is load-bearing: the branch above lets a valid x-introspectioncode through
	// with NO Authorization header at all, so dereferencing `authorization` unconditionally throws a
	// TypeError (500) and makes the bypass unusable. Guarded, the non-null assertion is sound —
	// when introspection is false the `typeof authorization === 'undefined'` branch has already thrown.
	if (!introspection && !authorization!.startsWith('Bearer access:')) {
		throw throwAccessTokenRequired()
	}

	if (!introspection) {
		// No `accessToken !== ''` guard: the startsWith check above already guarantees the token
		// keeps its `access:` prefix after the replace, so the empty case is unreachable.
		const accessToken = authorization!.replace('Bearer ', '')

		const redAccessSession = await redisClient.hGetAll(`${process.env.REDIS_KEY}${accessToken}`) // 'access:' already present
		if (redAccessSession != null && Object.keys(redAccessSession).length !== 0) {
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
	}

	return next()
}
