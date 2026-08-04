import 'dotenv/config'

import * as Sentry from '@sentry/node'
import type { ClientRequest, IncomingMessage } from 'http'
import type { RequestOptions } from 'https'
import * as https from 'https'

export const insecureHttpsModule = {
	...https,
	request: (options: RequestOptions, callback?: (res: IncomingMessage) => void): ClientRequest => {
		options.rejectUnauthorized = false
		return https.request(options, callback)
	}
}

Sentry.init({
	dsn: process.env.DSN,
	transportOptions: {
		httpModule: insecureHttpsModule
	}
})
