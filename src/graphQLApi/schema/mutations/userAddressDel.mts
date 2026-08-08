import { tryCatchRethrow } from '@axiumine/koa-utils/lib/tryCatchRethrow'
import { IContextUserAuthenticatedResource } from '@lib/auth/IContextUserAuthenticatedResource.mjs'
import { funUserAddressDel } from '@lib/user/funUserAddressDel.mjs'
import { throwIfUserDontOwnAddress } from '@lib/user/throwIfUserDontOwnAddress.mjs'
import { GraphQLBoolean, GraphQLError, GraphQLID, GraphQLNonNull } from 'graphql'
import { Types } from 'mongoose'

interface IArgs {
	_id: Types.ObjectId
}

/**
 * Removes one of the signed-in customer's addresses.
 *
 * ⚠️ **A hard delete, where `companyDel` is a soft one**, and the difference is not an inconsistency.
 * A company is a legal entity whose VAT number stays occupied after it stops trading, so the document has
 * to survive; an address is a line the customer typed and can retype, nothing references it but the
 * `defaultAddress` pointer, and keeping retired ones would mean every read path filtering an array in
 * application code.
 *
 * ⚠️ **If it was the default, the pointer is cleared by the same write** — see `funUserAddressDel`.
 * The database refuses the alternative, so this cannot be forgotten downstream, only met at runtime.
 *
 * A second call on the same address answers 403, not 200: the guard no longer finds it, and there is
 * no `deleted` state that would make "already gone" a distinguishable case.
 */
export const userAddressDel = {
	type: new GraphQLNonNull(GraphQLBoolean),
	description: 'del an address of the signed-in customer',
	args: {
		_id: { type: new GraphQLNonNull(GraphQLID) }
	},
	async resolve(_: unknown, args: IArgs, ctx: IContextUserAuthenticatedResource) {
		await throwIfUserDontOwnAddress(ctx.state.user._id, args._id)

		try {
			await funUserAddressDel(ctx.state.user._id, args._id)
		} catch (e) {
			tryCatchRethrow(e as GraphQLError | Error)
		}

		return true
	}
}
