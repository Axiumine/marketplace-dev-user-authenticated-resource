import { redisClient } from '@axiumine/koa-utils/dataSources/Redis'
import { revokeAllSessionsForAccount } from '@axiumine/marketplace-common/others/revokeAllSessionsForAccount'
import { deleteSession } from '@axiumine/marketplace-common/others/sessionKeys'
import { TIER } from '@axiumine/marketplace-common/others/Tier'
import { IContextUserAuthenticatedResource } from '@lib/auth/IContextUserAuthenticatedResource.mjs'

/**
 * Logs the calling customer out of everything, everywhere (E15-S05). Called after a credential write
 * has landed, never before one and never instead of one.
 *
 * ⚠️ **The calling session goes with the rest — decided 2026-08-10, and it is not a rough edge to
 * smooth.** Sparing the caller is friendlier and is what a fair number of products ship; it was
 * rejected because it defeats the one scenario this exists for. Someone changing their password
 * because they believe another person is inside the account cannot tell which live session is theirs,
 * and neither can the server: an exemption is granted to *whichever session sent the mutation*, and an
 * attacker holding the password can send it. "Revoke all but me" is not a weaker "revoke all", it is a
 * rule an attacker can aim at.
 *
 * ⚠️ **Refresh sessions first, the caller's access key second, and that order is the safe residue.**
 * A process death between the two leaves the caller's access token alive for the minutes it has left —
 * exactly the residual every *other* session already carries, since an access key is the digest of a
 * string this account's index cannot name. The reverse order leaves the refresh sessions alive, which
 * is the whole attack: the intruder simply refreshes and gets another access token.
 *
 * ⚠️ **Only the caller's access key can be deleted here, and that is a limit rather than an oversight.**
 * The index files refresh sessions alone (`indexSession`), so the other devices' access tokens keep
 * working until they expire on their own — minutes, and the same residual the `disabled` flag has
 * always carried. Shortening it needs an access-token deny list, which this platform has deliberately
 * not built.
 *
 * The missing-header branch is the introspection bypass, which reaches a resolver with no session at
 * all: there is no caller to log out, so there is no key to delete.
 */
export async function endEverySession(ctx: IContextUserAuthenticatedResource) {
	await revokeAllSessionsForAccount({ store: redisClient, tier: TIER.user, accountId: `${ctx.state.user._id}` })

	const authorization = ctx.request.header?.authorization

	if (typeof authorization === 'undefined') {
		return
	}

	// `Bearer access:<token>` minus the scheme is the prefixed token every session helper takes, and the
	// `access:` half must stay: it is what tells an access hash from a refresh one inside the digest.
	await deleteSession(redisClient, authorization.replace('Bearer ', ''))
}
