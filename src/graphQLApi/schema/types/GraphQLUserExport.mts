import { GraphQLID, GraphQLList, GraphQLNonNull, GraphQLObjectType, GraphQLString } from 'graphql'
import { GraphQLDateTime } from 'graphql-scalars'

import { GraphQLUserAddress, GraphQLUserPersonalData } from './GraphQLUserMe.mjs'

/**
 * The signed-in customer's own record, as a GDPR Art. 20 export hands it over.
 *
 * ⚠️ **`GraphQLUserAddress` and `GraphQLUserPersonalData` are imported, not restated.** GraphQL
 * forbids two types sharing one name, so a copy here would not be a duplication to clean up later —
 * it would refuse to assemble. That is why those two are exported from `GraphQLUserMe.mts` rather
 * than being module-private as they were.
 *
 * ⚠️ **This is `Me` plus the two login timestamps, and the delta is the whole design.** An export is
 * "the data concerning them", not "everything stored about them": `login.firstLogin` and
 * `login.lastLogin` are theirs and are added; `login.onboardingStep` / `onboardingDone` are read by
 * the ShopOwner tier and mean nothing on a customer; `login.rememberMe` is a checkbox on a form, not
 * a fact about a person; and `deleted` / `disabled` are the platform's own moderation state, which a
 * data-export endpoint has no business handing back — a customer would learn from their own export
 * that somebody had flagged their account.
 *
 * ⚠️ **`login.password`, `resetPwd` and `emailVerify` have no field here and never will.** Each of
 * the three is on its own enough to take the account over. `GraphQLUserMe` makes the same refusal for
 * the same reason, and the positive `select` in `userExport` is the second, independent layer —
 * which on this type matters more than on `Me`, because `decryptDocument` decrypts every `binData`
 * subtype 6 value it meets regardless of what was projected.
 *
 * Portability is deliberately **self-service and single-customer**: one signed-in person exporting
 * their own record. That shape is what keeps ADR-029 intact — nothing here sorts, searches or lists
 * across accounts, so no field of `user` has to become deterministically encrypted to serve it.
 */
export const GraphQLUserExport = new GraphQLObjectType({
	name: 'GraphQLUserExport',
	fields: () => ({
		_id: { type: new GraphQLNonNull(GraphQLID) },
		email: { type: new GraphQLNonNull(GraphQLString) },
		personalData: { type: GraphQLUserPersonalData },
		addresses: { type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(GraphQLUserAddress))) },
		defaultAddress: { type: GraphQLID },
		registeredAt: { type: new GraphQLNonNull(GraphQLDateTime) },
		// Both nullable, and not by oversight: the collection writes them at the first and the latest
		// login, so an account that registered and never confirmed its email has neither.
		firstLogin: { type: GraphQLDateTime },
		lastLogin: { type: GraphQLDateTime }
	})
})
