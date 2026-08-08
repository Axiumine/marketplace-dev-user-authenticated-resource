import { throwUnauthorizedError } from '@axiumine/koa-utils/graphQL/throw/throwUnauthorizedError'
import { User } from '@axiumine/marketplace-common/models/MongoDB/User'
import { IContextUserAuthenticatedResource } from '@lib/auth/IContextUserAuthenticatedResource.mjs'
import { GraphQLUserMe } from '@ptypes/GraphQLUserMe.mjs'
import { GraphQLNonNull } from 'graphql'

/**
 * The signed-in customer's own account. The only query on this tier, and it takes no arguments.
 *
 * ⚠️ **There is no `user(_id:)`, and adding one would be the mistake this tier is shaped to prevent.**
 * A customer may read exactly one account — theirs — so the identity comes from the session and from
 * nowhere else. An `_id` argument would need an equality check against `ctx.state.user._id` to be safe,
 * and a check that is only ever satisfied by the value it is compared against is an argument that
 * should not exist.
 *
 * The `select` is a **positive** list, not an exclusion of the secrets. `login.password`, `resetPwd`
 * and `emailVerify` are all absent from it, and so is anything added to the collection later — an
 * exclusion list would silently start leaking the next sensitive field somebody adds. `GraphQLUserMe`
 * has no fields for them either, so this is the inner of two independent layers.
 *
 * `addresses` is defaulted to `[]` because the collection makes it optional, and the schema declares
 * the list NonNull: a customer who has saved none would otherwise turn their own account page into a
 * GraphQL error.
 *
 * A `null` here means the session outlived the document — 401, so the client re-logins, rather than a
 * `null` account the private area would have to render.
 */
export const me = {
	type: new GraphQLNonNull(GraphQLUserMe),
	description: 'the signed-in customer own account',
	async resolve(_: unknown, {}, ctx: IContextUserAuthenticatedResource) {
		const user = await User.findById(ctx.state.user._id)
			.select('_id login.email personalData addresses defaultAddress registeredAt')
			.lean()

		if (user === null) {
			throwUnauthorizedError()
		}

		return {
			_id: user._id,
			email: user.login.email,
			personalData: user.personalData,
			addresses: user.addresses ?? [],
			defaultAddress: user.defaultAddress,
			registeredAt: user.registeredAt
		}
	}
}
