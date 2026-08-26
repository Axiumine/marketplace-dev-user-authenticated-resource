import { throwUnauthorizedError } from '@axiumine/koa-utils/graphQL/throw/throwUnauthorizedError'
import { User } from '@axiumine/marketplace-common/models/MongoDB/User'
import { IContextUserAuthenticatedResource } from '@lib/auth/IContextUserAuthenticatedResource.mjs'
import { GraphQLUserExport } from '@ptypes/GraphQLUserExport.mjs'
import { GraphQLNonNull } from 'graphql'

/**
 * The signed-in customer's own record, for a GDPR Art. 20 export. Like `me`, it takes no arguments,
 * and for the same reason: the session is the only identity on this tier.
 *
 * ⚠️ **Portability is self-service and single-customer, decided 2026-08-26, and the shape is load
 * bearing.** An operator-facing export — "hand me every customer's record", or worse, a search over
 * them — would need `user` to be readable across accounts, which is exactly what ADR-029 refuses and
 * what `ADR-INDEX.md` §4 lists among the decisions not to re-open. One person decrypting one document
 * that is already theirs asks nothing of the encryption scheme.
 *
 * The `select` is a **positive** list, and on this resolver that is not merely the convention it is
 * on `me` — it is the only thing standing between the export and the secrets. `decryptDocument`
 * decrypts whatever it finds as `binData` subtype 6, wherever it sits, so a document read whole would
 * arrive here with `resetPwd.resetHash` and `emailVerify.hash` in plaintext. What is not projected is
 * not read; `GraphQLUserExport` having no field for them is the second layer.
 *
 * `addresses` is defaulted to `[]` for the same reason as in `me`: the collection makes it optional
 * and the schema declares the list NonNull.
 *
 * A `null` means the session outlived the document — 401, so the client re-logins.
 */
export const userExport = {
	type: new GraphQLNonNull(GraphQLUserExport),
	description: 'the signed-in customer own record, for a GDPR Art. 20 export',
	async resolve(_: unknown, {}, ctx: IContextUserAuthenticatedResource) {
		const user = await User.findById(ctx.state.user._id)
			.select('_id login.email login.firstLogin login.lastLogin personalData addresses defaultAddress registeredAt')
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
			registeredAt: user.registeredAt,
			firstLogin: user.login.firstLogin,
			lastLogin: user.login.lastLogin
		}
	}
}
