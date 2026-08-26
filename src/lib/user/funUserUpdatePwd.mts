import { throwErrorWrongUserInput } from '@axiumine/koa-utils/graphQL/throw/throwErrorWrongUserInput'
import { throwInternalError } from '@axiumine/koa-utils/graphQL/throw/throwInternalError'
import { throwUnauthorizedError } from '@axiumine/koa-utils/graphQL/throw/throwUnauthorizedError'
import { checkPwdLen } from '@axiumine/koa-utils/lib/checkPwdLen'
import { encryptPassword } from '@axiumine/koa-utils/lib/encryptPassword'
import { compareHashAsync } from '@axiumine/koa-utils/lib/hash'
import { User } from '@axiumine/marketplace-common/models/MongoDB/User'
import { checkUserAuthorizationDisDel } from '@axiumine/marketplace-common/others/checkUserAuthorizationDisDel'
import { Types } from 'mongoose'

/**
 * Changes the authenticated customer's own password. A copy of `funAdminUpdatePwd`, bound to `User`,
 * and the reasoning transfers whole — it is repeated here rather than referenced because the two
 * services share no code and a reader of this one should not have to find the other.
 *
 * The `_id` is the session's, never the client's — see the mutation.
 */
export async function funUserUpdatePwd(_id: Types.ObjectId, passwordOld: string, passwordNew: string) {
	// The platform's own bounds (koa-utils Constants: 10 minimum, 72 maximum), not a local pair of
	// numbers. The maximum is the one that is easy to dismiss and must not be: bcrypt hashes at most
	// 72 bytes and silently ignores everything after them, so without an upper bound a 200-character
	// passphrase would be stored as its first 72 characters while the customer believes otherwise.
	// The OLD password is deliberately not length-checked — it is compared, not accepted, and
	// validating it would only report which guesses were the wrong shape.
	checkPwdLen(passwordNew)

	// Rejected because it is almost always an accident, and because letting it through would spend a
	// bcrypt hash at cost factor 14 to write back a value that is already there.
	if (passwordNew === passwordOld) {
		throwErrorWrongUserInput('passwordNew must differ from passwordOld')
	}

	// `login.password` is read because it has to be compared. The projection is explicit so nothing
	// else about the account is pulled into memory alongside a value this sensitive — and on this
	// collection that matters more than on `admin`, because the same sub-document holds `resetPwd`
	// and `emailVerify`, whose hashes are each enough to take the account over.
	const user = await User.findById(_id).select('_id disabled deleted login.password').lean()

	// A session whose user document no longer exists. 401, not 404: the caller learns their session is
	// no good, and nothing more.
	if (user === null) {
		throwUnauthorizedError()
	}

	// The same gate `loginUser` and every session refresh apply, applied once more here — and this is
	// the only lib function on this tier that applies it. A disabled or soft-deleted customer keeps a
	// live access token until it expires, and must not be able to re-key the account on the way out.
	// Closing it is not the same act and is deliberately ungated: see `funUserDel` and ADR-036.
	//
	// ⚠️ It does **not** check `emailVerify.valid`, and it should not: that gate belongs to `loginUser`
	// on 4028, which is the only path that mints a session in the first place. A customer holding a
	// token has already passed it.
	checkUserAuthorizationDisDel(user)

	// The re-authentication step, and the reason this mutation takes the old password at all. An
	// access token is a bearer credential: whoever holds one is already inside. Proving knowledge of
	// the current password is what stops a stolen token from being upgraded into permanent ownership
	// of the account.
	if (!(await compareHashAsync(passwordOld, user.login.password))) {
		// Deliberately the same error as the missing-document branch above, for the same reason the
		// login form does not distinguish "no such user" from "wrong password".
		throwUnauthorizedError()
	}

	// Hashed here rather than through the model: `updateOne` is a query, and the `pre('save')` hook in
	// marketplace-common's LoginSubDocSchema that normally hashes `password` only runs for documents.
	// Left to the hook, this would store the plaintext.
	const password = await encryptPassword(passwordNew)

	const ret = await User.updateOne({ _id: _id }, { $set: { 'login.password': password } }).exec()

	// The document was read a moment ago and the hash is salted, so it cannot match what is stored —
	// `modifiedCount` of anything but 1 means the write did not land, and the caller must not be told
	// their password changed when it did not.
	if (ret.modifiedCount !== 1) {
		throwInternalError()
	}
}
