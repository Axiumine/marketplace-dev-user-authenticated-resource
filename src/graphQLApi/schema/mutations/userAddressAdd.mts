import { OnlyIdType } from '@axiumine/koa-utils/graphQL/schema/types/OnlyIdType'
import { tryCatchRethrow } from '@axiumine/koa-utils/lib/tryCatchRethrow'
import { GraphQLInputUserAddress } from '@axiumine/marketplace-common/schema/GraphQLInput/GraphQLInputUserAddress'
import { IContextUserAuthenticatedResource } from '@lib/auth/IContextUserAuthenticatedResource.mjs'
import { funUserAddressAdd } from '@lib/user/funUserAddressAdd.mjs'
import { IUserAddressInput, validateUserAddress } from '@lib/validate/validateUserAddress.mjs'
import { GraphQLError, GraphQLNonNull } from 'graphql'

interface IArgs {
	address: IUserAddressInput
}

/**
 * Adds one address to the signed-in customer's list.
 *
 * Answers `OnlyIdType` rather than the `Boolean` the other address mutations return, and the asymmetry
 * is the same one `companyAdd` has on the shop-owner tier: the id is *new information* the client
 * cannot derive. It is what `userDefaultAddressSet` is then aimed at, and without it the private area
 * would have to re-read the whole account and guess which element is the one it just created — two of
 * them can be identical.
 *
 * No ownership guard, and none is possible: the address does not exist yet, and the account it lands on
 * is the session's.
 *
 * ⚠️ **It can answer 400 for a well-formed address**, which no other write on this tier does: the
 * account may already hold the six `funUserAddressAdd` allows. `validateUserAddress` cannot see that —
 * it is handed one address and knows nothing about the document it is going into — so the refusal comes
 * from the write itself, through `tryCatchRethrow` like every other rejection here.
 */
export const userAddressAdd = {
	type: new GraphQLNonNull(OnlyIdType),
	description: 'add an address to the signed-in customer',
	args: {
		address: { type: new GraphQLNonNull(GraphQLInputUserAddress) }
	},
	async resolve(_: unknown, args: IArgs, ctx: IContextUserAuthenticatedResource) {
		const address = validateUserAddress(args.address)

		// `return await`, not `return`: without the await the promise escapes the try, so the catch
		// below can never run and a validator rejection would surface as an unhandled rejection instead
		// of the error tryCatchRethrow makes of it.
		try {
			return { _id: await funUserAddressAdd(ctx.state.user._id, address) }
		} catch (e) {
			tryCatchRethrow(e as GraphQLError | Error)
		}
	}
}
