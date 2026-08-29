import { TCommonHeaders } from '@axiumine/koa-utils/graphQL/schema/context/TCommonHeaders'
import { IRedisDataUserForNode } from '@axiumine/marketplace-common/others/Redis/IRedisDataUserForNode'
import { IncomingHttpHeaders } from 'http'

/**
 * ⚠️ `state.user` is the **customer**, not "the user" in the generic sense. Every tier calls this
 * slot `user` — the Admin service puts an admin in it and the ShopOwner service a shop owner —
 * because it is Koa's conventional name for "whoever this request is authenticated as". Here it
 * happens to be the `user` collection as well, which is a coincidence of naming and not a rule.
 *
 * `ForNode` and not `IRedisDataUser`: `_id` has been re-hydrated into an ObjectId by `makeAuthCtx`,
 * and the `tier` is gone. Dropping it is deliberate — it was checked once, at the boundary, and
 * carrying it further would invite a resolver to re-derive authorisation from a value it should
 * never have had to look at.
 */
type IStateApi = {
	user: IRedisDataUserForNode
}
export type IContextUserAuthenticatedResource = {
	state: IStateApi
	request: {
		header?: TCommonHeaders & IncomingHttpHeaders
	}
}
export {}
