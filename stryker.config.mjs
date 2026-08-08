/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
export default {
	testRunner: 'vitest',
	vitest: {
		configFile: 'vitest.mutation.config.mts'
	},
	coverageAnalysis: 'perTest',
	// ignoreStatic was here, on the theory that mutants in module-load code (schema
	// declaration thunks, top-level constants) can never be killed once the module sits in
	// the ESM registry. That theory was wrong — it was an attribution artifact, not an
	// unkillable-mutant problem. When the module under test is imported at the top of a
	// test file (or via a top-level `await import(...)`), a mutant that changes module-load
	// behaviour fires during Vitest's file-collection phase, before any test body runs;
	// Stryker cannot attribute the resulting failure to a test, so it reports the mutant as
	// Survived even though the suite plainly noticed (the whole file fails to collect). The fix
	// is to import the module under test inside `beforeEach` (or inline inside `it`) instead of
	// at module top level or inside `beforeAll` — a throw in `beforeAll` only marks the suite's
	// tests "skipped", which Stryker still can't attribute as a kill; a throw in `beforeEach`
	// marks the one test about to run "failed", which it does attribute. See
	// @axiumine/marketplace-common, which went from 45.95 to 100.00 with this flag
	// absent and the same fix applied. Static mutants are back in scope; none are excluded.
	reporters: ['clear-text', 'progress', 'html'],
	/**
	 * 28 workers on a 32-thread box. The `4` this replaces was never measured anywhere — the same literal
	 * sat in all nine Stryker configs on the platform, frontend included, where dropping it
	 * cut 59 minutes to 18.
	 *
	 * Measured here, 803 mutants, machine otherwise idle:
	 *
	 *   concurrency 4  → 99s
	 *   concurrency 28 → 45s
	 *
	 * ⚠️ "It still scored 100" is **not** what justified this, and must not justify the next change. A
	 * starved worker misses a deadline, its test fails, and Stryker records the mutant as *killed* —
	 * overload inflates the score, so 100 at any concurrency is consistent with a gate that has quietly
	 * stopped checking. At the break threshold there is no headroom for the number to show it.
	 *
	 * What was compared instead is the set of non-killed mutants, where load surfaces first: both runs
	 * ended on the same zero non-killed mutants — no survivor, no timeout, nothing to compare away.
	 * Re-measure that way before touching this.
	 */
	concurrency: 28,
	timeoutMS: 60000,
	// Mutation score is a push gate — see COVERAGE.md. `break` fails the run (exit 1)
	// below this score, which is what the pre-push hook keys off. Raise it as tests
	// improve; never lower it to make a run pass.
	thresholds: { high: 100, low: 95, break: 100 },
	/**
	 * Scan and coverage output, copied into the sandbox for no reason. Stryker's always-ignored list
	 * covers only `node_modules`, `.git`, `/reports`, `*.tsbuildinfo`, `/stryker.log` and `.stryker-tmp`
	 * — `ignorePatterns` itself defaults to empty, and `.qodana/` here runs to tens of megabytes.
	 *
	 * It is not only wasted copying. `disableTypeChecks: true` resolves to the glob
	 * `**\/*.{js,ts,jsx,tsx,html,vue,mjs,mts,cts,cjs}` matched with `dot: true`, so it descends into
	 * dotted directories, and every run logged a `ParseError` trying to strip `@ts-` directives out of
	 * Qodana's own `thirdPartySoftwareList.html`. Stryker swallows that error and carries on, so the
	 * gate stayed green while printing a stack trace nobody could act on.
	 *
	 * Neither directory is an input to any test: both are gitignored build output.
	 */
	ignorePatterns: ['.qodana', 'coverage'],
	mutate: [
		'src/**/*.mts',

		// index.mts: split, not dropped wholesale. Unlike a file only reachable through the
		// integration project, most of this one IS unit-tested directly — verified against
		// test/index.unit.test.mts, which drives checkRequiredEnv, buildValidationRules,
		// healthResponse, logListening, gracefulShutdown, onUnhandledRejection,
		// onUncaughtException and start()'s three failure paths with every datasource mocked.
		// Only two ranges are excluded, each for a distinct, verified reason:
		'!src/index.mts',
		// ⚠️ These are LINE NUMBERS in a file this repo rewrote — re-check them after any edit to
		// src/index.mts. They shifted once already: this service's index.mts is shorter than the
		// 4026 copy it started from (no graphqlUploadKoa, no initClamScan, a shorter
		// REQUIRED_ENV_VARS), and a stale range silently mutates the wrong half of the file.
		// Lines 1-112: imports through onUncaughtException. Fully reachable from the unit
		// project — kept in scope.
		'src/index.mts:1-112',
		// Lines 113-185 (createServer(), not re-included below): none of the start() failure
		// tests reach it — each mocked datasource rejects before start() calls it. Only
		// test/integration/index.itest.mts calls it, by booting the real server, and this run
		// deliberately excludes that project (see the header of vitest.mutation.config.mts).
		// Mutating it here would only produce NoCoverage noise, not signal.
		// Lines 187-226: start()'s JSDoc plus the function body, whose Promise.all/try/catch
		// IS exercised by the failure-path tests above — kept in scope.
		'src/index.mts:187-226'
		// Lines 228-246 (the `if (process.env.NODE_ENV !== 'test')` entrypoint tail, not
		// re-included): already marked `/* v8 ignore start/stop */` in the source because it
		// cannot run under the test process without killing the worker via process.exit.
		// Every function it wires is tested directly above; the wiring itself has no branch
		// a mutant could meaningfully flip under NODE_ENV=test.

		// instrument.mts is NOT excluded. Static mutants are back in scope (see above), so its
		// only module-load statement (`Sentry.init(...)`) is now a live mutated statement, not
		// one dropped before Stryker can report it. The `insecureHttpsModule.request` function
		// body is invoked directly by test/instrument.test.mts, and its mutants —
		// rejectUnauthorized flipped, the delegate call dropped, the return value swapped — are
		// real and killable alongside it. Verified by running this file through Stryker in
		// isolation (`npx stryker run --mutate "src/instrument.mts"`): 5 mutants instrumented,
		// 5 killed, 0 survived, mutation score 100.00.

		// No exclusion for src/graphQLApi/schema/{types,frag,GraphQLInput}/** or
		// queries.mts/mutations.mts — see the note above on ignoreStatic's removal for why an
		// isolated run showed they need none.
	]
}
