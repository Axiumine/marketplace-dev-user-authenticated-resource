import { throwGoneError } from '@axiumine/koa-utils/graphQL/throw/throwGoneError'
import { throwInternalError } from '@axiumine/koa-utils/graphQL/throw/throwInternalError'
import { throwUnauthorizedError } from '@axiumine/koa-utils/graphQL/throw/throwUnauthorizedError'
import { User } from '@axiumine/marketplace-common/models/MongoDB/User'
import { Types } from 'mongoose'

/**
 * Closes the authenticated customer's own account (GDPR Art. 17).
 *
 * **A soft delete, like every other delete on this platform.** The document stays and gains a
 * `deleted` instant; `checkUserAuthorization` already refuses a stamped account on the login path
 * (`marketplace-dev-public-authorization`, `tryLoginUser`), so this one write is what shuts the
 * account, and the mutation revokes the live sessions on top of it. `Date.now()` is a number and the
 * schema path is a `Date` — mongoose casts it, exactly as `funCompanyDelete` and `funShopOwnerDelete`
 * do.
 *
 * ⚠️ **Erasure is the stamp, and the erasure is not finished by it.** The personal fields are still
 * in the document, encrypted, until the retention purge removes it 30 days after closure — a purge
 * that does not exist yet (`phase1/NFR.md` open question 6). Nothing here should be read as the whole
 * of Art. 17.
 *
 * ⚠️ **`login.email` stays occupied for those 30 days.** `login.email_unique` is a plain unique index
 * with no `partialFilterExpression`, so a closed account keeps its address and the same person cannot
 * register again with it until the purge removes the document — the same trade
 * `shopOwner.login.email_unique` and `company.vatNumber_unique` already make. It is a bounded wait
 * rather than a permanent loss only *because* the purge is coming; until it ships, the wait is
 * forever, which is what makes that job load-bearing rather than tidy-up.
 *
 * ⚠️ **`disabled` is deliberately not a gate here, and this is the one write on the tier where it is
 * not.** Every other authenticated write runs `checkUserAuthorizationDisDel`, because a suspended
 * customer holding a live access token must not keep changing their account on the way out. Closing
 * the account is the exception: suspension is a platform decision about what somebody may do, and the
 * right to erasure is not something the platform suspends. A stamp on an already-suspended document
 * takes nothing away from an operator either — the document and its `disabled` flag are both still
 * there.
 *
 * A `null` document is 401, not 404: the session outlived the account, and the caller learns their
 * session is no good and nothing more — the same answer `me` and `funUserUpdatePwd` give.
 *
 * An account already stamped is 410, and that is not 401 by accident: on this tier a 401 means "your
 * session is no longer good", which is precisely what it is *not* here. In practice this branch is
 * nearly unreachable — the first call revoked every session, so the second request is refused by the
 * auth middleware before any resolver runs — and it exists for the window where the write landed and
 * the revoke did not.
 *
 * The write carries no `deleted` clause of its own: the guard above has already established the
 * document is live, and `matchedCount` — not `modifiedCount` — is what proves it landed, since a
 * re-stamp of the same instant is not a state this can reach.
 */
export async function funUserDel(_id: Types.ObjectId) {
	const user = await User.findById(_id).select('_id deleted').lean()

	if (user === null) {
		throwUnauthorizedError()
	}

	if (user.deleted) {
		throwGoneError('account already closed')
	}

	const ret = await User.updateOne({ _id: _id }, { $set: { deleted: Date.now() } }).exec()

	if (ret.matchedCount !== 1) {
		throwInternalError()
	}
}
