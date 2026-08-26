import { tryCatchRethrow } from '@axiumine/koa-utils/lib/tryCatchRethrow'
import { endEverySession } from '@lib/auth/endEverySession.mjs'
import { IContextUserAuthenticatedResource } from '@lib/auth/IContextUserAuthenticatedResource.mjs'
import { funUserDel } from '@lib/user/funUserDel.mjs'
import { GraphQLBoolean, GraphQLError, GraphQLNonNull } from 'graphql'

export const userDel = {
	type: new GraphQLNonNull(GraphQLBoolean),
	description: 'closes the signed-in customer account',
	// There is deliberately no `_id` argument, and here the absence matters more than anywhere else on
	// the tier: every customer authenticates against the same collection and the platform has no role
	// field, so an id accepted from the client would make this "close any customer's account". The
	// account is the one the request is authenticated as, taken from the Redis session below.
	//
	// No ownership guard either, for the same reason `userUpdatePwd` has none: there is no client-chosen
	// id to guard. `throwIfUserDontOwnAddress` exists for the three address mutations, which do take one.
	async resolve(_: unknown, {}, ctx: IContextUserAuthenticatedResource) {
		try {
			await funUserDel(ctx.state.user._id)

			// ⚠️ **After the write and inside the try, both deliberately** — the same order `userUpdatePwd`
			// keeps, for a sharper reason. Before it, an account that then failed to close would have logged
			// the customer out of every device for nothing. Outside it, a Redis that refused would leave this
			// answering `true` with every session of a closed account still live — a closed account somebody
			// is still inside is the one outcome this mutation exists to prevent.
			//
			// The caller's own session goes with the rest, which is what a customer closing their account
			// expects, and it is also what makes a second call unreachable: the next request they send is
			// refused by the auth middleware.
			await endEverySession(ctx)
		} catch (e) {
			tryCatchRethrow(e as GraphQLError | Error)
		}

		return true
	}
}
