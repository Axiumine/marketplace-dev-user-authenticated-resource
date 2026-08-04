import { GraphQLObjectType } from 'graphql'

import { userAddressAdd } from './mutations/userAddressAdd.mjs'
import { userAddressDel } from './mutations/userAddressDel.mjs'
import { userAddressUpdate } from './mutations/userAddressUpdate.mjs'
import { userDefaultAddressSet } from './mutations/userDefaultAddressSet.mjs'
import { userPersonalDataUpdate } from './mutations/userPersonalDataUpdate.mjs'
import { userUpdatePwd } from './mutations/userUpdatePwd.mjs'

const MutationsApi = new GraphQLObjectType({
	name: 'MutationsApi',
	fields: {
		userAddressAdd,
		userAddressDel,
		userAddressUpdate,
		userDefaultAddressSet,
		userPersonalDataUpdate,
		userUpdatePwd
	}
})

export default MutationsApi
