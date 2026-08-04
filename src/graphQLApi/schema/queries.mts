import { GraphQLObjectType } from 'graphql'

import { me } from './queries/me.mjs'

const QueriesApi = new GraphQLObjectType({
	name: 'QueriesApi',
	fields: {
		me
	}
})

export default QueriesApi
