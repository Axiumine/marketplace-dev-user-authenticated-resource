# Test quality policy — 100% coverage **and** 100% mutation score, no exceptions

⚠️ **Not satisfied yet, and knowingly so.** This service was created with its harness wired and its
tests **not written**, per the standing "skip all tests" instruction — `test/` holds only
`integration/globalSetup.mts`. Every gate below is configured, executable and at 100; none of them
passes today, so a commit here needs `--no-verify` and the coverage report reads 0%. That is a debt,
not a policy change: **do not lower a threshold, delete a gate or add an exclusion to make the numbers
green.** Write the tests. Everything below describes the shape the suite must grow into, and the
paragraphs that name a test file name one that has to exist, not one that does.

This service requires **100% test coverage on every metric** — statements, branches,
functions, and lines — **and a 100% Stryker mutation score**. Both are hard gates, not targets.

They answer different questions, which is why both exist:

| Gate | Question it answers |
|---|---|
| coverage | did a test *execute* this line? |
| mutation | would a test *fail* if this line were wrong? |

100% coverage with weak assertions is the normal failure mode, and it is invisible to the
coverage number. Mutation testing is what falsifies it: Stryker rewrites `src/` one small
change at a time (`true` → `false`, a string → `""`, a block → `{}`) and re-runs the suite.
A mutant that *survives* is an edit no test noticed.

## The rule

If coverage is below 100% on any metric, the fix is one of:

1. **Add the missing tests** for the uncovered lines / branches / functions.
2. **Delete the code** if it is unreachable or dead.

If the mutation score is below 100%, the fix is one of:

1. **Strengthen the assertion** that should have caught the mutant.
2. **Delete the code** if the mutant proves the branch is dead.
3. **Document an equivalent mutant** with `// Stryker disable next-line <Mutator>: <why>` —
   only when the mutated code provably cannot behave differently on any reachable input.

**Never** lower a threshold to make a run pass. The thresholds are the specification;
red means the work is not done, not that the number is wrong.

## Where it is enforced

| Layer | File | What it does |
|---|---|---|
| Local test run | `vitest.config.mts` → `test.coverage.thresholds` | `yarn test:cov` exits non-zero if any metric < 100% |
| Local mutation run | `stryker.config.mjs` → `thresholds.break` | `yarn test:mutation` exits non-zero if the score < 100 |
| Qodana scan gate | `qodana.yaml` → `failureConditions.testCoverageThresholds` (`total`/`fresh` = 100) | `./qodana.sh` fails the scan if coverage < 100% |
| Git `pre-commit` | `.githooks/pre-commit` | blocks the commit if `yarn test:cov` **or** the Qodana scan fails |
| Git `pre-push` | `.githooks/pre-push` | blocks the push if `yarn lint:check`, `yarn test:cov`, `yarn test:mutation` **or** the Qodana scan fails |

The coverage layers read the same coverage run (vitest, v8 provider, lcov →
`coverage/lcov.info`, `all: true` over `src/**/*.mts`). Change coverage config in
`vitest.config.mts` only. Qodana has no mutation gate — `pre-push` is the only one.

Both hooks run the scan on purpose. `git merge --no-ff` never fires `pre-commit` —
git runs that hook for `git commit` only — so the merge commit, the one revision
that reaches `origin`, is the single commit no pre-commit scan ever sees. And
Qodana Cloud files each report under the branch it ran on, so a repo scanned only
at commit time never produces a `main`-tagged report to baseline against. Each hook
hands `qodana.sh` `SKIP_TESTS=1`, reusing the `coverage/lcov.info` its own coverage
step just wrote rather than letting the script regenerate it with a test run whose
failure it swallows. `SKIP_QODANA=1` skips the scan alone; the coverage and
mutation gates stay.

## Two projects, one coverage report

`vitest.config.mts` defines two projects; `yarn test:cov` runs both and aggregates coverage:

| Project | Files | Datasources | Purpose |
|---|---|---|---|
| `unit` | `test/*.test.mts` | mocked | pure logic, error paths, prod branches — fast, offline |
| `integration` | `test/integration/*.itest.mts` | **real Redis cluster + real MongoDB** | boots the server via `start()` and drives it over HTTP |

This is the **customer resource tier**: every request goes through
`authorizationAuthenticatedResourceHandler()`, which reads
`Authorization: Bearer access:<token>` and looks the session up in Redis. There is no cookie
and no Keygrip here — the refresh cookie belongs to
`marketplace-dev-user-authenticated-authorization` (4031), which is also what writes the session
this one reads.

**Two datasources, not three.** Unlike the shop-owner and admin resource services, `start()` does
not arm an antivirus: this tier accepts no uploads, so `graphql-upload`, `sharp` and `clamscan` are
absent and there is no `initClamScan()` to fail. Nothing here needs clamd listening, and no test
should mock one.

⚠️ **The tier assertion is a test target, not an implementation detail.** All nine services share one
`REDIS_KEY` prefix, so an `admin` or `shopOwner` access token is *findable* in Redis from here — the
`assertTier(redData.tier, TIER.user)` call in the auth middleware is the only thing that refuses it.
The integration suite must therefore seed at least three sessions: a `user` one that succeeds, a
foreign-tier one that must answer 403, and one with **no** `tier` field at all, which must also answer
403 (fail closed — a missing discriminator is invalid, never a wildcard). A suite that only ever mints
`user` tokens leaves the cross-tier hole untested while reporting 100%.

The integration project uses the `REDIS_*` / `MONGODB_URI` values from `.env` (loaded by the
sources' own `dotenv.config()`). It overrides only the keyspace prefix
(`REDIS_KEY=marketplaceDev:itest:userAuthenticatedResource:`, this service's own isolated,
ACL-allowed namespace — the `marketplaceDev:itest:` stem is shared because the ACL grants that
pattern, but the third segment is unique per service so every service can run its integration suite
at once) and `PORT=0` (ephemeral). Run just one side with `yarn test:unit` /
`yarn test:integration`.

Consequence: the coverage gate — and therefore `pre-push` — needs Redis and MongoDB reachable. That
is intentional: 100% here means the server was really booted and really talked to both, not that a
mock returned the expected value.

**The integration suite writes to MongoDB**, to the one collection this tier owns. It seeds a real
`user` document with the raw driver (checked by the collection's own validator, not the Mongoose
model — the two disagree by design across this platform) and drives `me` plus the six mutations for
real over HTTP, dropping every document it created and every Redis key it registered in `afterAll`.
Push each `_id` and each key into a module-level array **at creation time**: a seed that throws before
its `try` block otherwise leaks the session key. Watch `login.email`'s unique index — a fixed literal
collides on the second seed of the same run. Redis is a cluster, so one key per `del` call; a
multi-key `del` throws CROSSSLOT.

⚠️ **The `user` validator is `$and: [{$jsonSchema}, {$expr}]`, and the `$expr` half is what the
address tests are for.** `defaultAddress` is a root-level ObjectId that must be absent or present in
`addresses[]._id`; MongoDB refuses anything else. Two cases only an integration test can reach,
because only the database enforces them: setting `defaultAddress` to an id that is not in the array
must be rejected by the *write*, and `userAddressDel` on the default address must succeed **because**
`funUserAddressDel` clears the pointer in the same aggregation-pipeline update (`$$REMOVE`). Split
that into two sequential updates and the first one is rejected — assert the success, not just the
absence of an error, or a mutant that drops the `$$REMOVE` branch survives.

The unit project carries the error paths that would mean corrupting a real index or forging a driver
rejection to reach through HTTP — a failed `matchedCount`/`modifiedCount` check, an ownership
rejection from `throwIfUserDontOwnAddress`, a wrong current password in `userUpdatePwd`.
`tryCatchRethrow` is left unmocked there too, so failures really travel through it.

## A note on the `graphql` realm

`vitest.config.mts` inlines `@axiumine/marketplace-common` and `@axiumine/koa-utils`
alongside `graphql` / `@apollo/server` / `@as-integrations`. The schema embeds GraphQL objects
those two packages build (`GraphQLBaseAddressFrag`, `GraphQLPositionFrag`, `OnlyIdType`), so
they have to see the *same* transformed `graphql` copy as the sources — otherwise graphql
refuses the type with "Cannot use GraphQLObjectType … from another module or realm". The bare
`/graphql/` pattern already covers `graphql-scalars` and `graphql-depth-limit`.

The same split is why error assertions match on `.message` rather than `instanceof GraphQLError`.

## Enabling the hook

The `pre-push` hook lives in `.githooks/` (tracked in git). It is activated by:

```bash
git config core.hooksPath .githooks
```

The `prepare` script in `package.json` runs this automatically on `yarn install`, so a
fresh clone is gated after the first install. To verify:

```bash
git config --get core.hooksPath   # -> .githooks
```

## Server boot and Sentry init are covered — do not exclude them

`src/index.mts` (Koa/Apollo wiring, auth middleware, routing, shutdown) and
`src/instrument.mts` (Sentry init) reach 100% through the **integration** project, which boots
the real server and hits `/user-authenticated-resource`, `/health` and an unknown path over HTTP.
They are **not** `v8 ignore`d and must stay that way — the only `v8 ignore` block is the
entrypoint tail of `index.mts` (the `if (NODE_ENV !== 'test')` bootstrap that registers signal
handlers and calls `start()`), which cannot run under the test process without killing the
worker via `process.exit`. Every function it wires (`start`, `gracefulShutdown`,
`onUnhandledRejection`, `onUncaughtException`) is exercised directly by tests, so the ignored
block contains only the wiring, no logic.

## Mutation testing — what is mutated, and what is not

`yarn test:mutation` runs Stryker (`stryker.config.mjs`) with the **vitest** runner over
`vitest.mutation.config.mts`. One deliberate scope decision remains, plus one that turned out to
be a mistake and was reverted:

| Setting | Why |
|---|---|
| runs the **`unit` project only** | Stryker re-runs the suite once per mutant. Pointing that at `test/integration/index.itest.mts` would hammer the real Redis cluster and the real dev MongoDB hundreds of times per mutant run — this service's own isolated `marketplaceDev:itest:userAuthenticatedResource:` namespace doesn't change that, since `fileParallelism: false` still serialises everything within it. Unit tests are Redis/Mongo-mocked, so mutant runs stay hermetic and parallel. |
| `!src/index.mts` with two ranges added back, `src/index.mts:1-112` and `src/index.mts:187-226` | Unlike a file only reachable through the integration project, most of `index.mts` **is** unit-tested directly (`test/index.unit.test.mts` drives `checkRequiredEnv`, `buildValidationRules`, `healthResponse`, `logListening`, `gracefulShutdown`, `onUnhandledRejection`, `onUncaughtException` and each of `start()`'s failure paths plus its success path with every datasource mocked), so only two ranges stay out of scope: lines 113-185 (`createServer()`'s body — none of the unit tests reach it, since every mocked failure path rejects before `start()` calls it; only the integration project reaches it, by booting the real server) and lines 228-246 (the `if (NODE_ENV !== 'test')` entrypoint tail, already `/* v8 ignore */`d in the source because it cannot run under the test process without killing the worker via `process.exit`). ⚠️ **Those are line numbers, and this repo rewrote the file** — it is shorter than the 4026 copy it was cloned from. Re-check both ranges against `src/index.mts` after any edit to it; a stale range mutates the wrong half in silence. |

**`ignoreStatic` was removed, not kept.** It used to sit here on the theory that mutants in
module-load code (the `fields: () => ({...})` thunks of the GraphQL type/frag/input declarations,
`queries.mts`/`mutations.mts`) are permanently unkillable — that importing the schema once at a
test file's top level exercises every thunk before Stryker's active mutant is even switched in, so
there is nothing left for a later `it()` to catch. That reasoning was half right and half wrong.
Dropping the flag and re-running honestly surfaced real survivors — not because those mutants were
unkillable, but because of an **attribution artifact**: several mutants (blanking a `name:` field
on a `GraphQLObjectType` / `GraphQLInputObjectType`) make graphql-js throw *synchronously at
construction*, and a throw during a top-level `await import(...)` (or inside `beforeAll`) makes
Vitest mark every test in the file **"skipped"**, not "failed" — Stryker cannot attribute a skip to
any one test, so it reports Survived even though the whole file plainly broke. Moving the same
imports into `beforeEach` instead fixes this: the throw now fails only the one test about to run,
which Stryker *does* attribute as a kill. The remaining survivors were plain description-string
literals that nothing had ever asserted the exact text of. Fixing both closed every survivor with
**no new exclusions and no weakened assertions**.

`src/instrument.mts` was never excluded, static or otherwise: `Sentry.init(...)` is its only
module-load statement, and `insecureHttpsModule.request`'s function body is invoked directly by
`test/instrument.test.mts`, so its mutants (`rejectUnauthorized` flipped, the delegate call
dropped, the return value swapped) were always real and killable.

No `// Stryker disable` directive exists anywhere in `src/` — every mutant Stryker raised,
including every static one, was killable with a strong-enough assertion, not an equivalence
argument.

**No coverage or mutation figures are pinned in this file, on purpose.** The sections above describe
the shape of the gates, not a snapshot to compare against — and with the suite unwritten there is no
honest number to pin anyway. Re-run `yarn test:cov` and `yarn test:mutation` for the current
baseline.

### Writing tests that kill

The general pattern, stated because there is not yet a test file to point at: assert the *value*, not
the *call*. `expect(errorLog).toHaveBeenCalledWith('error', error)` pins the literal first argument to
`console.error`; a weaker `toHaveBeenCalled()` lets a mutant blank the `'error'` literal survive. The
same discipline applies to GraphQL type assertions — asserting a field's rendered type string (e.g.
`String(fields.defaultAddress.type)`) catches a mutant that wipes a field's `type` to `undefined`,
which a bare `Object.keys(fields)` name-list check would miss.

Three places on this tier where the weak form is especially tempting and especially wrong:

- **`matchedCount` vs `modifiedCount`.** Each `src/lib/user/fun*` function checks one or the other,
  deliberately and not interchangeably: `matchedCount` where re-saving identical data is a legitimate
  no-op (profile update, address update, default-address set), `modifiedCount` where the array must
  actually change (address add, address delete). A test that only asserts "no error" cannot tell the
  two apart, and the mutant that swaps them survives.
- **The ownership guard.** `throwIfUserDontOwnAddress` runs *before* the write in all three address
  mutations. Assert the rejection **and** that the write never happened — a mutant that deletes the
  guard call still throws on a foreign id in some code paths, purely by accident of the filter.
- **`assertTier`.** See the tier paragraph above: mint a foreign-tier session and a tier-less one, and
  assert 403 for both.

## Rules inherited from the service this was cloned from

`marketplace-dev-authenticated-resource` reached 100% before this repo existed, and the two defects
that cost the most to find there are latent in this code too, because it uses the same libraries.
Kept as rules, not as history:

- **`sanitizeFilter` is on globally.** `MongoDBConnect` (koa-utils) sets
  `mongoose.set('sanitizeFilter', true)`, so a bare `$`-admin object inside a filter is stripped
  and read as a literal value. `{ deleted: { $exists: false } }` written unwrapped answers
  `Cast to date failed for value "{ '$exists': false }" (type Object) at path "deleted"` at runtime and
  passes every unit test that mocks the model. Wrap it in mongoose's `trusted({ $exists: false })`, and
  have the unit assertion compare against `trusted(...)` so a regression fails the suite rather than
  the integration run.
- **`Model.create()` must be awaited.** `return Model.create(doc)` inside a `try` lets the promise
  escape before the `catch` can see it, so a write failure surfaces as an unhandled rejection instead
  of a GraphQL error. `return await`, always — and assert the GraphQL error, since the unhandled
  rejection is invisible to a test that only checks the happy path.

## Running it

```bash
yarn test:cov       # coverage + threshold check (the source of truth)
yarn test:mutation  # Stryker; report at reports/mutation/mutation.html
./qodana.sh         # full Qodana Ultimate scan, incl. the 100% coverage gate
```

`git push` runs the first two, in that order, and blocks on either.
