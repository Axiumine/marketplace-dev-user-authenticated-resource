import { tryCatchRethrow } from '@axiumine/koa-utils/lib/tryCatchRethrow'
import { IContextUserAuthenticatedResource } from '@lib/auth/IContextUserAuthenticatedResource.mjs'
import { funUserPersonalDataUpdate } from '@lib/user/funUserPersonalDataUpdate.mjs'
import { IUserPersonalDataInput, validateUserPersonalData } from '@lib/validate/validateUserPersonalData.mjs'
import { GraphQLInputUserPersonalData } from '@thedoctorweb_agency/marketplace-common/schema/GraphQLInput/GraphQLInputUserPersonalData'
import { GraphQLBoolean, GraphQLError, GraphQLNonNull } from 'graphql'

interface IArgs {
	personalData: IUserPersonalDataInput
}

/**
 * Saves the signed-in customer's name and contact details.
 *
 * No `_id` argument — the session names the account, and there is no second one this could address.
 *
 * `new Date()` is read here rather than inside the validator so the age boundary is a parameter the
 * unit tests can move without freezing the clock.
 */
export const userPersonalDataUpdate = {
	type: new GraphQLNonNull(GraphQLBoolean),
	description: 'update the signed-in customer personal data',
	args: {
		personalData: { type: new GraphQLNonNull(GraphQLInputUserPersonalData) }
	},
	async resolve(_: unknown, args: IArgs, ctx: IContextUserAuthenticatedResource) {
		const personalData = validateUserPersonalData(args.personalData, new Date())

		try {
			await funUserPersonalDataUpdate(ctx.state.user._id, personalData)
		} catch (e) {
			tryCatchRethrow(e as GraphQLError | Error)
		}

		return true
	}
}
