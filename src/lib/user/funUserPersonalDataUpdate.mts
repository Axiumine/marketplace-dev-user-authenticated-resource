import { throwInternalError } from '@axiumine/koa-utils/graphQL/throw/throwInternalError'
import { User } from '@thedoctorweb_agency/marketplace-common/models/MongoDB/User'
import { IUserPersonalData } from '@thedoctorweb_agency/marketplace-common/models/MongoDBInterfaces/IUserPersonalData'
import { Types } from 'mongoose'

/**
 * Writes the customer's own `personalData`, replacing whatever was there.
 *
 * ⚠️ **The whole sub-document is replaced, not merged**, and that is what the caller's validator is
 * built for: `$set: { personalData }` with a value the validator has already stripped every blank
 * field out of. A merge — `$set: { 'personalData.firstName': … }` field by field — would make
 * *clearing* a landline impossible to express, because the absence of a key would mean "leave it" and
 * there would be nothing left to mean "remove it".
 *
 * There is no upsert and no `$setOnInsert`: `personalData` is optional on a fresh registration, so
 * this is the first write of it as often as it is the tenth, but the *document* always exists — the
 * session would not have resolved otherwise.
 *
 * `matchedCount`, not `modifiedCount`. Saving a profile unchanged is a thing a form does, and MongoDB
 * reports that as modified 0 — treating it as a failure would tell the customer their save broke when
 * the database holds exactly what they asked for.
 */
export async function funUserPersonalDataUpdate(_id: Types.ObjectId, personalData: IUserPersonalData) {
	const ret = await User.updateOne({ _id: _id }, { $set: { personalData: personalData } }).exec()

	if (ret.matchedCount !== 1) {
		throwInternalError()
	}
}
