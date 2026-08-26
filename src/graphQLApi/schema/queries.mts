import { GraphQLObjectType } from 'graphql'

import { me } from './queries/me.mjs'
import { userExport } from './queries/userExport.mjs'

const QueriesApi = new GraphQLObjectType({
	name: 'QueriesApi',
	fields: {
		me,
		userExport
	}
})

export default QueriesApi
