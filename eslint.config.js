import eslintConfig from '@axiumine/eslint-config-be'
import js from '@eslint/js'
import tsParser from '@typescript-eslint/parser'
import simpleImportSort from 'eslint-plugin-simple-import-sort'

// The shared config only covers `src/**`, so the test files and the vitest configs
// (outside src/) would be left without a TS parser. Here we reuse the same rules as the shared
// TypeScript block, but without `project`: tsconfig.json only includes `src/**/*.mts`.
const sharedTsBlock = eslintConfig.find((c) => c.files?.includes('src/**/*.{d.ts,ts,cts,mts}'))

/*
 * ADR-044. Suspension is the operator's instrument end to end: the Admin tier raises it, and the Admin
 * tier is the only hand that lifts it. A customer-tier service able to write any `disabled*` field could
 * clear a sanction standing against the very account making the request — the account this service
 * exists to let that person edit — which is why the ban belongs on this tier as much as on the shop
 * owner's.
 *
 * ⚠️ **A write ban, not a ban.** Reading the flag is what `checkUserAuthorizationDisDel` does at login
 * and `findAccountForSession` does on every refresh, and `funUserUpdatePwd` reads it here too — a
 * suspended customer must not change the password on an account they cannot use. A rule refusing the
 * read would refuse the enforcement. Hence four write shapes and no read shape: the object-literal key a
 * `$set` is built from, the same key quoted, and both assignment forms (`user.disabled = false`,
 * `user['disabled'] = false`), which is the shape the E12-S04 audit actually found for
 * `rejectUnauthorized` and which a `Property`-only rule passes.
 *
 * ⚠️ **`deleted` is deliberately absent from this list.** `userDel` writes it, and must: closing your own
 * account is the data-subject right ADR-036 protects. The two fields are not siblings — `deleted` is the
 * subject giving the account up, `disabled` is the platform taking it away, and only the second is a
 * sanction a caller could lift against itself.
 *
 * `ObjectExpression >` rather than a bare `Property`, because an `ObjectPattern` is a `Property` too and
 * destructuring the flag off a document that was just read is a read. The collateral this accepts is the
 * object form of a Mongoose projection — `.select({ disabled: 1 })` is indistinguishable from a `$set`
 * at this level and is refused with it. Nothing here uses that form: every projection in this service is
 * the space-separated string, which no selector below touches.
 *
 * The three names are `user`'s real ones, from `BEs/marketplace-db-setup/lib/schemas/account.js`. There
 * is no `disabledAt` — ADR-044 names one in prose as a shape it would also cover, and the schema never
 * grew it, so banning the name would be banning nothing.
 *
 * Scoped to `src/**` where it is used below: the integration suite seeds `disabled: true` to prove a
 * suspended customer is refused, and a seed is an object literal like any other.
 */
const DISABLED_NO_WRITE = [
	{
		selector:
			'ObjectExpression > Property[key.name=/^disabled(By|Reason)?$/], ObjectExpression > Property[key.value=/^disabled(By|Reason)?$/], AssignmentExpression[left.property.name=/^disabled(By|Reason)?$/], AssignmentExpression[left.property.value=/^disabled(By|Reason)?$/]',
		message:
			"ADR-044: `disabled`, `disabledBy` and `disabledReason` are the Admin tier's to write, never this tier's — a service that could raise or clear a suspension could lift a sanction standing against itself, and the platform owner's ruling is that only an operator removes one. A self-service closure stamps `deleted` and stops. The reads stay legal: checkUserAuthorizationDisDel at login and findAccountForSession on every refresh are what enforce the flag."
	}
]

/* Hoisted so both config objects below can share it — see the note above the second one. */
const RESTRICTED_SYNTAX = [
	{
		selector: "AssignmentExpression[left.property.name='rejectUnauthorized']",
		message:
			'E12-S04: certificate verification stays on. Trust the collector CA from outside the process — NODE_EXTRA_CA_CERTS=/path/to/ca.pem — as the parent workspace SETUP.md §7 describes.'
	},
	{
		selector: "Property[key.name='rejectUnauthorized']",
		message:
			'E12-S04: certificate verification stays on. Trust the collector CA from outside the process — NODE_EXTRA_CA_CERTS=/path/to/ca.pem — as the parent workspace SETUP.md §7 describes.'
	},
	{
		selector: "Property[key.value='rejectUnauthorized']",
		message:
			'E12-S04: certificate verification stays on. Trust the collector CA from outside the process — NODE_EXTRA_CA_CERTS=/path/to/ca.pem — as the parent workspace SETUP.md §7 describes.'
	},
	{
		selector: "Property[key.name='sendDefaultPii']",
		message:
			'E12-S04: the blanket Sentry PII flag is absent by decision, not set to false. Name the individual dataCollection categories instead — the observability section of docs/architecture.md says which, and why.'
	},
	// E12-S21 / E12-S22. Two settings one word from being reversed, with nothing else that would
	// notice. `!=` rather than a positive match because the shape to refuse is *any other
	// value*, including the `'medium'` the SDK falls back to when the key is dropped entirely —
	// and the pair selector uses `:has(> …)` so that an unrelated nested object carrying a
	// `beforeSend` cannot satisfy it on the outer literal's behalf.
	{
		selector: "Property[key.name='maxIncomingRequestBodySize'][value.value!='none']",
		message:
			"E12-S21: the request body is never captured. `maxIncomingRequestBodySize: 'none'` is the only gate on it — `dataCollection.httpBodies` reaches the span attribute and not the event, which is how a plaintext password was measured on the wire."
	},
	{
		selector: "ObjectExpression:has(> Property[key.name='beforeSend']):not(:has(> Property[key.name='beforeSendTransaction']))",
		message:
			'E12-S22: `beforeSend` and `beforeSendTransaction` are wired together or not at all. The SDK routes transaction events to the second hook only, and the client address is on the transaction — one hook without the other means a `tracesSampleRate` switches the redaction off.'
	},
	{
		selector: "MemberExpression[property.name='NODE_TLS_REJECT_UNAUTHORIZED']",
		message:
			'E12-S04: certificate verification stays on. Trust the collector CA from outside the process — NODE_EXTRA_CA_CERTS=/path/to/ca.pem — as the parent workspace SETUP.md §7 describes.'
	},
	{
		selector: "Literal[value='NODE_TLS_REJECT_UNAUTHORIZED']",
		message:
			'E12-S04: certificate verification stays on. Trust the collector CA from outside the process — NODE_EXTRA_CA_CERTS=/path/to/ca.pem — as the parent workspace SETUP.md §7 describes.'
	}
]

export default [
	// `.stryker-tmp/**` and `reports/**` are build output, not sources. Stryker copies the whole
	// repo into a sandbox under .stryker-tmp and only removes it on a clean exit — an interrupted
	// run leaves one behind, and eslint then lints a second copy of every test file. Those copies
	// carry `@ts-nocheck` and sit outside every tsconfig, so the lint fails with dozens of errors
	// that point at a directory .gitignore already ignores.
	// `.qodana/**` is what `--results-dir` writes: a SARIF file and a bundled HTML report whose
	// minified browser JS is someone else's code. The root-JS block at the bottom of this file is
	// scoped tightly enough that none of it is reachable anyway — this entry is the second lock.
	{ ignores: ['dist/**', 'coverage/**', '.stryker-tmp/**', 'reports/**', '.qodana/**'] },
	...eslintConfig,
	{
		files: ['test/**/*.mts', 'vitest.*.mts'],
		languageOptions: {
			parser: tsParser,
			parserOptions: { ecmaVersion: 'latest', sourceType: 'module' }
		},
		plugins: sharedTsBlock.plugins,
		rules: sharedTsBlock.rules
	},
	// The root-level JS config files — this file and stryker.config.mjs. The shared config's JS block
	// is scoped to `src/**/*.{js,cjs,mjs}`, and a service whose sources are all .mts has no JS under
	// src/ at all, so without this block the two files that decide how everything else is linted and
	// mutated are themselves checked by nothing while `yarn lint:check` reports green.
	//
	// `marketplace-dev-public-resource` was the only repo that noticed: it carried a `.eslintrc.json`
	// declaring exactly this intent — eslint:recommended plus simple-import-sort, node, `*.mjs` as
	// module — and it never once ran. eslintrc was already inert under eslint 9's flat-config default,
	// and eslint 10 (`^10.8.0` here) dropped the format outright, so the file was decoration. It is
	// deleted; this block is what it meant to be, and it lives in all seven services and in
	// marketplace-common because the gap was never specific to the one repo that documented it.
	//
	// `*.js` in flat config matches the config file's own directory only — it is NOT expanded to
	// `**/*.js`. That is the whole reason this is safe: a repo-wide JS block would also pick up the
	// minified browser bundle Qodana writes under .qodana/ and any leftover .stryker-tmp/ sandbox,
	// which is precisely how marketplace-admin's config arrived at 1600 `no-undef` errors. Both paths are
	// in the `ignores` above as well — belt and braces, since the glob alone already excludes them.
	//
	// No `globals` entry: neither root file references a node global. Every `process` and `module`
	// that greps out of stryker.config.mjs across these repos is inside a comment. Add one here if
	// that stops being true — do not reach for a wider glob.
	{
		files: ['*.js', '*.mjs', '*.cjs'],
		languageOptions: { ecmaVersion: 'latest', sourceType: 'module' },
		plugins: { 'simple-import-sort': simpleImportSort },
		rules: {
			...js.configs.recommended.rules,
			'simple-import-sort/imports': 'error',
			'simple-import-sort/exports': 'error'
		}
	},
	// E12-S04 — neither setting this audit removed can come back by accident.
	//
	// Core `no-restricted-syntax`, in this file rather than in `@axiumine/eslint-config-be`: the shared
	// package is a repo outside these sixteen and ships to unrelated consumers, so a Sentry-specific rule
	// there would cost a publish, a version bump in ten dependents, and a rule everyone else carries for
	// nothing. One block duplicated into ten repos is the cheaper half of that trade, and it follows the
	// idiom the two blocks above already established.
	//
	// No `files` key on the first object, so the shared entries apply to every file eslint looks at
	// here; the second one narrows to src/** and adds the write ban that belongs there alone. Three selectors for
	// `rejectUnauthorized` because the defect actually in the tree was an assignment
	// (`options.rejectUnauthorized = false`), not an object literal — a `Property`-only rule passes the
	// exact code it exists to catch — and the computed form has a `key.value` where the plain one has a
	// `key.name`. Two for `NODE_TLS_REJECT_UNAUTHORIZED` for the same reason one level up:
	// `process.env.X` parses as an Identifier, `process.env['X']` as a Literal, and a rule carrying one
	// misses the other.
	{
		rules: {
			'no-restricted-syntax': ['error', ...RESTRICTED_SYNTAX]
		}
	},
	// The write ban rides on top of the shared entries rather than replacing them: a second config
	// object naming the same rule discards the first one's options for every file it matches, so
	// dropping the spread would silently un-ban every Sentry selector inside src/** — the half of the
	// repo they exist for.
	{
		files: ['src/**/*.mts'],
		rules: {
			'no-restricted-syntax': ['error', ...RESTRICTED_SYNTAX, ...DISABLED_NO_WRITE]
		}
	}
]
