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
 * ⚠️ **Erasure is the stamp, and the erasure is not finished by it.** The personal fields are still in
 * the document, encrypted, until the retention purge removes it 30 days after closure. That purge is
 * **`user.deleted_ttl`**, a TTL index over this very field
 * (`marketplace-db-setup/migrations/20260301000300-create-user.js`), so the stamp written here is the
 * decision to erase and the index is the erasure — there is no job to run and nothing to schedule.
 * Two consequences worth knowing: the sweep is a background monitor that wakes roughly every 60
 * seconds, so "30 days" is 30 days and change; and `deleted` is one of the few paths on this
 * collection that is **not** encrypted, which is the only reason a server-side index can read it at
 * all (ADR-029).
 *
 * ⚠️ **`login.email` stays occupied until the document goes, and that is now the shorter of two
 * clocks.** `login.email_unique` is a plain unique index with no `partialFilterExpression`, so a
 * closed account keeps its address — the same trade `shopOwner.login.email_unique` and
 * `company.vatNumber_unique` already make. What ends it is whichever comes first: the TTL at 30 days,
 * or the same address being registered again, which destroys this document outright and opens a new
 * account (`userRegister` on `marketplace-dev-public-resource`, ADR-011 §Amendment 2026-08-26). So
 * closing an account costs its owner nothing if they come back, and the retention rule is a ceiling
 * rather than a wait.
 *
 * ⚠️ **`disabled` is deliberately not a gate here (ADR-036), and `funUserUpdatePwd` is the only write
 * on this tier where it is one.** Suspension is enforced at the edges of a session — `loginUser`
 * refuses a suspended account outright, and `findAccountForSession` re-runs the check on every refresh
 * — so a suspended customer holding a live access token reaches this resolver for up to one
 * access-token lifetime, exactly as they reach the address and personal-data writes, which run no such
 * check either. The password write adds its own guard because re-keying an account is taking it over;
 * closing one is giving it up. Suspension is a platform decision about what somebody may do, and the
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
