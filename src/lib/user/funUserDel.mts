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
 * the document, encrypted, until the day-30 scrub overwrites them in place. **Nothing removes the
 * document, ever** (ADR-041): `user.deleted_ttl` was dropped along with `purgeClosedUser`, because a TTL
 * index can only delete a whole document and cannot modify a field, and the record that this person once
 * held an account is not the platform's to erase. What survives is `_id`, `deleted`, `deletedBy`, the
 * `disabled*` trio, the registration date and `scrubbedAt` — enough to answer *there was an account, it
 * closed on this date, at whose instruction* and nothing more.
 *
 * So the erasure is a job now, and that is the price of the reversal: a sweeper on an interval inside
 * `marketplace-dev-admin-authenticated-resource`, under a single-key Redis `SET NX PX` lock so a
 * multi-instance deployment scrubs once. `deleted` is still one of the few paths on this collection that
 * is **not** encrypted (ADR-029) — that is what lets the sweeper's query find these documents at all.
 *
 * ⚠️ **`login.email` stays occupied until the scrub changes its value, and those thirty days are an undo
 * window (ADR-046).** `login.email_unique` is a plain unique index with no `partialFilterExpression`, so a
 * closed account keeps its address — the same trade `shopOwner.login.email_unique` and
 * `company.vatNumber_unique` already make. Two things end it. The scrub at day 30 overwrites the address
 * with `deleted-${_id}@invalid.local`, unique by construction. Or the same person registers again inside
 * the window, which **restores this document rather than replacing it**: the confirmed registration
 * `$unset`s `deleted` and `deletedBy`, takes the password just chosen and stamps `emailVerify.valid`, on
 * the same `_id` every foreign key already points at (`marketplace-dev-public-resource`, ADR-046). Closing
 * an account is therefore undone by doing the obvious thing for thirty days, and is final after them.
 *
 * ⚠️ **The undo is not a way around a suspension.** A restore leaves `disabled`, `disabledBy` and
 * `disabledReason` exactly as it found them (ADR-046, ADR-044), so an account suspended and then closed
 * comes back suspended and still cannot log in. Only an operator lifts one.
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
