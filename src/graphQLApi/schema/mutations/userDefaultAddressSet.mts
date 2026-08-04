import { tryCatchRethrow } from '@axiumine/koa-utils/lib/tryCatchRethrow'
import { IContextUserAuthenticatedResource } from '@lib/auth/IContextUserAuthenticatedResource.mjs'
import { funUserDefaultAddressSet } from '@lib/user/funUserDefaultAddressSet.mjs'
import { throwIfUserDontOwnAddress } from '@lib/user/throwIfUserDontOwnAddress.mjs'
import { GraphQLBoolean, GraphQLError, GraphQLID, GraphQLNonNull } from 'graphql'
import { Types } from 'mongoose'

interface IArgs {
	_id: Types.ObjectId
}

/**
 * Marks one of the signed-in customer's addresses as their default.
 *
 * ⚠️ **A mutation of its own, and not a flag on `userAddressAdd` / `userAddressUpdate`.** The default
 * is a field at the *document root* pointing into `addresses`, so "make this one default" is a write to
 * a different place than "save this address" — folding it into the address input would be two
 * operations wearing one name, and would mean an address save could silently move the pointer.
 *
 * There is no `userDefaultAddressClear`. Removing the default happens exactly one way — deleting the
 * address it names — and a customer with addresses who wants none of them preferred is not a state the
 * ordering flow has any use for.
 *
 * The guard is the only check needed: the collection validator refuses a pointer that names nothing,
 * and the guard has just established that this one names an address of this account.
 */
export const userDefaultAddressSet = {
	type: new GraphQLNonNull(GraphQLBoolean),
	description: 'set the default address of the signed-in customer',
	args: {
		_id: { type: new GraphQLNonNull(GraphQLID) }
	},
	async resolve(_: unknown, args: IArgs, ctx: IContextUserAuthenticatedResource) {
		await throwIfUserDontOwnAddress(ctx.state.user._id, args._id)

		try {
			await funUserDefaultAddressSet(ctx.state.user._id, args._id)
		} catch (e) {
			tryCatchRethrow(e as GraphQLError | Error)
		}

		return true
	}
}
