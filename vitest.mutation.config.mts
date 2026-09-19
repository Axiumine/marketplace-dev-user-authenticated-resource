import { defineConfig } from 'vitest/config'

import { nodeNextResolver } from './vitest.shared.mts'

// Vitest config used by Stryker's vitest-runner (`yarn test:mutation`).
//
// It mirrors the `unit` project of vitest.config.mts and nothing else:
//   - No coverage block. Mutants deliberately break the code, so line-coverage
//     thresholds are meaningless here — the mutation score is the metric.
//   - No `integration` project. Stryker re-runs the suite once per mutant; pointing
//     that at test/integration/*.itest.mts would hammer the real Redis cluster AND the
//     real dev MongoDB hundreds of times — this service's own isolated
//     `marketplaceDev:itest:userAuthenticatedResource:` namespace does not change that, since
//     `fileParallelism: false` still serialises everything within it. Unit tests are
//     Redis/Mongo-mocked, so mutant runs stay hermetic and parallelisable.
//
// Keep plugins/resolve/inline in sync with vitest.config.mts's `unit` project — the
// `.mjs -> .mts` NodeNext rewrite and the single-graphql-realm pinning (this service also
// inlines marketplace-common and koa-utils, since the schema embeds GraphQL objects they build)
// are load bearing, not preferences.
const inlineDeps = [/graphql/, /@apollo\/server/, /@as-integrations/, /@axiumine\/koa-utils/, /@axiumine\/marketplace-common/]

export default defineConfig({
	plugins: [nodeNextResolver],
	resolve: { dedupe: ['graphql'] },
	test: {
		include: ['test/*.test.mts'],
		server: { deps: { inline: inlineDeps } },
		// Not present in the `unit` project of vitest.config.mts (which relies on the 5s
		// default) — added here only as a safety margin, since Stryker re-runs the suite
		// once per mutant through its own instrumentation and that adds overhead the plain
		// vitest run does not have.
		testTimeout: 30_000,
		// Caps how long a test's full name may be — the mutation gate selects tests by name,
		// and past a size it cannot; see vitest.testNames.mts.
		setupFiles: ['./vitest.testNames.mts'],
		// Same as the `unit` project: set before the sources call `dotenv.config()`,
		// which does not override keys already present in process.env.
		env: {
			NODE_ENV: 'test',
			REDIS_KEY: 'test:'
		}
	}
})
