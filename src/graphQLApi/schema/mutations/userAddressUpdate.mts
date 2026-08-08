import { tryCatchRethrow } from '@axiumine/koa-utils/lib/tryCatchRethrow'
import { GraphQLInputUserAddress } from '@axiumine/marketplace-common/schema/GraphQLInput/GraphQLInputUserAddress'
import { IContextUserAuthenticatedResource } from '@lib/auth/IContextUserAuthenticatedResource.mjs'
import { funUserAddressUpdate } from '@lib/user/funUserAddressUpdate.mjs'
import { throwIfUserDontOwnAddress } from '@lib/user/throwIfUserDontOwnAddress.mjs'
import { IUserAddressInput, validateUserAddress } from '@lib/validate/validateUserAddress.mjs'
import { GraphQLBoolean, GraphQLError, GraphQLID, GraphQLNonNull } from 'graphql'
import { Types } from 'mongoose'

interface IArgs {
	_id: Types.ObjectId
	address: IUserAddressInput
}

/**
 * Replaces one of the signed-in customer's addresses.
 *
 * The `_id` names the address, not the account — the account is the session's — and it is the reason
 * the ownership guard runs first: it is the one value here a client chooses.
 *
 * The stored element is replaced whole, so a field the customer cleared disappears rather than keeping
 * its old value. That is what an edit form means by an empty box.
 */
export const userAddressUpdate = {
	type: new GraphQLNonNull(GraphQLBoolean),
	description: 'update an address of the signed-in customer',
	args: {
		_id: { type: new GraphQLNonNull(GraphQLID) },
		address: { type: new GraphQLNonNull(GraphQLInputUserAddress) }
	},
	async resolve(_: unknown, args: IArgs, ctx: IContextUserAuthenticatedResource) {
		await throwIfUserDontOwnAddress(ctx.state.user._id, args._id)

		const address = validateUserAddress(args.address)

		try {
			await funUserAddressUpdate(ctx.state.user._id, args._id, address)
		} catch (e) {
			tryCatchRethrow(e as GraphQLError | Error)
		}

		return true
	}
}
