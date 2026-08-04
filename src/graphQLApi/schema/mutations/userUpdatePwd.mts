import { tryCatchRethrow } from '@axiumine/koa-utils/lib/tryCatchRethrow'
import { IContextUserAuthenticatedResource } from '@lib/auth/IContextUserAuthenticatedResource.mjs'
import { funUserUpdatePwd } from '@lib/user/funUserUpdatePwd.mjs'
import { GraphQLBoolean, GraphQLError, GraphQLNonNull, GraphQLString } from 'graphql'

interface IArgs {
	passwordOld: string
	passwordNew: string
}

export const userUpdatePwd = {
	type: new GraphQLNonNull(GraphQLBoolean),
	description: 'updates the password of the signed-in customer account',
	// There is deliberately no `_id` argument. The account being changed is the one the request is
	// authenticated as, taken from the Redis session below — accepting an id from the client would
	// make this "change any customer's password", since every customer authenticates against the same
	// collection and the platform has no role field to check one against.
	//
	// This is the *change* path and it requires the current password. Forgetting it is what
	// `resetPwdFlow` on the public tier is for, and that path proves ownership of the mailbox instead.
	args: {
		passwordOld: { type: new GraphQLNonNull(GraphQLString) },
		passwordNew: { type: new GraphQLNonNull(GraphQLString) }
	},
	async resolve(_: unknown, args: IArgs, ctx: IContextUserAuthenticatedResource) {
		try {
			await funUserUpdatePwd(ctx.state.user._id, args.passwordOld, args.passwordNew)
		} catch (e) {
			tryCatchRethrow(e as GraphQLError | Error)
		}

		return true
	}
}
