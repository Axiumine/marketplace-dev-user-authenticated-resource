# marketplace-dev-user-authenticated-resource

One of the nine backend services. **Read the parent workspace's `CLAUDE.md` first** —
`/media/nvme/websites/fullstack-marketplace-blueprint/CLAUDE.md`. The tier/concern split, the port table, the terminology
mapping and the auth model live there, not here; this file carries only what is specific to this repo.

## What this service is

Domain data for the **customer** tier — `User`, the end customer who places orders. Port **4032**,
endpoint `/user-authenticated-resource`. Token lifecycle is not here; it lives in
`marketplace-dev-user-authenticated-authorization` (4031), and logout in
`marketplace-dev-authenticated-logout` (4030), which all three tiers share unchanged.

The whole surface is **one query and six mutations**, and every one of them acts on the account the
request is authenticated as:

| Operation | Answers | Notes |
|---|---|---|
| `me` | `GraphQLUserMe!` | no arguments — the session is the only identity |
| `userPersonalDataUpdate` | `Boolean!` | replaces the whole `personalData` sub-document |
| `userAddressAdd` | `OnlyIdType!` | the new element `_id`, which the client needs |
| `userAddressUpdate` | `Boolean!` | replaces one element whole |
| `userAddressDel` | `Boolean!` | hard delete, and clears `defaultAddress` in the same write |
| `userDefaultAddressSet` | `Boolean!` | one atomic `$set` of a root-level pointer |
| `userUpdatePwd` | `Boolean!` | requires the current password |

It was copied from `marketplace-dev-authenticated-resource` (4026, the ShopOwner tier) and is
deliberately **not** a straight rename. Four differences, none of which should be "corrected" back:

- **`assertTier(redData.tier, TIER.user)`** in the auth middleware. All nine services read Redis under
  the same `REDIS_KEY` prefix, so an Admin or ShopOwner access token is *findable* here; the assertion
  is the only thing that refuses it, and a session with no `tier` is refused too — fail closed.
- **No uploads.** `graphqlUploadKoa` and `initClamScan` are not mounted, and `sharp`, `clamscan`,
  `file-type` and `graphql-upload` are not dependencies. A customer uploads nothing; the middleware is
  not free to mount (it intercepts every multipart request) and the antivirus is a socket to clamd that
  would have to be up for this service to boot. They come back the day this tier accepts a file.
- **No `_id` argument names an account.** `userUpdatePwd` and `userPersonalDataUpdate` take no id at
  all, and the three address mutations take the id of an *address*, guarded by
  `throwIfUserDontOwnAddress`. There is no query that reads another customer.
- **A shorter `REQUIRED_ENV_VARS`, and a shorter `env` template to match.** The SocketLabs, email,
  redirect, cookie and upload variables are gone because nothing here reads them — `checkRequiredEnv`
  throws on a *missing* variable, so a leftover turns a bootable service into a startup crash.

⚠️ **The default address is a pointer, and MongoDB enforces it.** `user.defaultAddress` is an ObjectId
at the document root that must be absent or present in `addresses[]._id` — the `$expr` half of the
collection validator, alongside the `$jsonSchema`. Two consequences that bite at runtime rather than at
review time: setting the default is one `$set` with nothing to clear first, and **removing the default
address must unset the pointer in the same write**, which is why `funUserAddressDel` is an aggregation
pipeline with `$$REMOVE` instead of a `$pull`.

## Tests

**Sixteen files, 309 tests, 100% on all four coverage metrics and a 100.00 mutation score** — eleven unit
files (249 tests) plus five `*.itest.mts` (60 tests). The "skip all tests" instruction this repo was built
under was revoked by the user on 2026-08-06; the suite was written from the harness up and both gates pass,
so a commit here needs no `--no-verify`.

⚠️ **The integration project was configured and empty until 2026-08-07, and it found two production bugs
in its first run — both in `funUserAddressDel`, both structurally invisible to the unit suite.** It had
been green by vacancy: vitest collects zero tests for a project with no matching files and reports success,
which reads exactly like a suite that ran. What it was not proving was the whole point of this service —
`me`, the personal-data write, the address CRUD and the default-address pointer, all asserted against mocks
and never against the real `$jsonSchema` or the real `$expr` that rejects a dangling `defaultAddress`.

The two bugs, recorded because each is a class of mistake rather than a typo, and **every address delete on
the customer tier answered 500** until both were fixed:

1. **Mongoose 9 refuses an array update outright** unless `{ updatePipeline: true }` is passed —
   `Cannot pass an array to query updates unless the 'updatePipeline' option is set.`, thrown in
   `Query.prototype` before the driver is reached. `funUserAddressDel` is the only pipeline update in the
   workspace, so nothing else was exposed. The unit suite mocks `User.updateOne`, and a mock takes an array
   happily.
2. **Mongoose casts a filter against the schema and casts nothing inside a pipeline.** A pipeline is an
   opaque aggregation expression to it. `GraphQLID` resolves to a **string**, whatever `IArgs` declares, so
   `{ $ne: ['$$this._id', '68b1…'] }` compared an ObjectId to a string, was never equal, kept every element
   and answered `matchedCount: 1, modifiedCount: 0` — a matched document that was not touched. The filter
   half worked, which is what made it look like a write that had simply not landed.

Both are pinned in `userLib.test.mts` now, and the second needed a test that passes a **string** id:
`new Types.ObjectId(oid)` deep-equals its argument, so with an ObjectId fixture the missing coercion is
unobservable.

The environment that blocked it is no longer the obstacle. Until 2026-08-07 five `MONGO_TEST_*` keys
were empty here — this machine's file was a copy of an unrelated old project's — so `vitest.mongo.mts`
refused to build a URL and `missingTestMongoEnv()` named every one of them. They are filled in now and
the two database users were provisioned with the loop in `marketplace-db-setup/setup/mongodb.js`. Two
other keys in the same file were wrong rather than missing: `MONGODB_URI` pointed at `testRnApollo`, a
leftover database from that other project with no `authSource`, and `INTROSPECTION_CODE` differed from
the seven other services', which breaks the service-to-service bypass in both directions. The platform
convention still holds — `MONGO_TEST_DB`, `MONGO_TEST_AUTH_ADMIN` and the database path of
`MONGO_TEST_CONN_STRING` all carry the same name, unique to the repo (`dbMarketplaceTestUserRes` here),
since every `globalSetup` drops its own database.

⚠️ **A value containing whitespace must be quoted in that file.** dotenv terminates a bare value at the
first space, hands back the truncated prefix and reports no error. Single quotes, not double: dotenv
expands `\n` and `\r` escapes inside double quotes.

The five integration files, and what each is for:

|File|Covers|
|---|---|
|`index.itest.mts`|the bearer gate against a live Redis session (412 / 499 / 498 / **403** for another tier and for a session with no `tier` at all), the `x-introspectioncode` bypass, CSRF on GET, a full `me` selection, and a secret-non-leak check that no hash reaches the wire|
|`account.itest.mts`|`userPersonalDataUpdate` and `userUpdatePwd` against the real validator — including a raw-driver counter-proof that `contacts: { mobile: null }` is refused with `code: 121` while a real number is accepted, and real bcrypt on both sides of the password change|
|`addresses.itest.mts`|the three address mutations plus `userDefaultAddressSet`, and a block that drives the collection validator directly: `$pull` of the default rejected, `$pull` of a non-default accepted, a foreign pointer rejected, a pointer with no `addresses` rejected|
|`shutdown.itest.mts`|`gracefulShutdown`, the process-level handlers, production introspection refusal, and the 5s teardown budget lost for real against a local blackhole socket|
|`startFailure.itest.mts`|`start()`'s catch arm with a URL MongoDB genuinely refuses, and the env guard running *outside* the try|

`harness.mts` is shared by the four that need a server, and that is safe because **vitest gives each test
file its own module registry** — the tracking arrays it exports are per-file, which is what lets
`shutdown.itest.mts` destroy its connections without touching the other suites'. Seeding goes through the
raw driver, every `_id` and every Redis key is registered **at creation time** rather than in a `finally`,
and both are drained in `afterAll`.

The unit project still boots a real server of its own in `index.unit.test.mts` — `createServer()`, port 0,
`/health`, an unknown path, a `{ me { … } }` POST, a ShopOwner session refused 403 and a bare GET refused by
`csrfPrevention` — over a real socket with Mongo and Redis mocked. It is what keeps the coverage number
honest without a database, and Stryker runs the **unit project only** (`vitest.mutation.config.mts` narrows
to `test/*.test.mts`), deliberately: mutating against real infrastructure would be slow and flaky.

Two things to keep in mind when adding a test here:

- **Assert `extensions.description`, not the message, for anything text-carrying.** `throwGraphQLError`
  puts the HTTP *title* in `message` — 'Bad Request', 'Forbidden' — so `toThrow('passwordNew must differ…')`
  never matches, and two entirely different refusals share one envelope. `userLib.test.mts` has the
  `rejection()` helper for the envelope and one explicit `description` assertion where the text is the only
  thing separating two 400s.
- **`schema.test.mts` imports `queries.mts` / `mutations.mts` inside `beforeEach`**, and that is not style.
  A mutant that blanks a `GraphQLObjectType` name throws in the constructor; thrown at import time or in
  `beforeAll` it marks every test *skipped*, which Stryker cannot attribute, so a killed mutant is reported
  Survived. Inside `beforeEach` it fails the one test that was running.

## Version control

**git**, branch `main`, **no remote** — like every other repo in this workspace, and its history starts
with the commit that created it. **Never commit on `main`** — branch first
(`git switch -c <type>/<slug>`), and merging is the user's decision alone.

**Delete the local branch as soon as it is merged**: `git branch -d <slug>`, in the same breath as the
merge, not at the top of the next task. Use `-d` and never `-D` — `-d` refuses a branch whose commits
are not already reachable from where you stand, so the safe case succeeds quietly and the unsafe one
stops you before the work is unreachable. Merges land locally here and are pushed as `main`, so no
forge-side "delete branch on merge" ever fires; a merged branch stays until someone removes it, and
`git branch` is the only place in-flight work is visible in a polyrepo this size. If the branch was
pushed too, `git push origin --delete <slug>`, and only if that push was asked for in the first place.

`git push` runs `.githooks/pre-push`, a blocking **four**-step gate: `yarn lint:check` (eslint, then
`prettier --check`, both over the whole tree), then `yarn test:cov` (100% on every metric), then
`yarn test:mutation` (Stryker, `thresholds.break: 100`), then Qodana (`./qodana.sh`, gated by
`qodana.yaml`: coverage 100 total / 100 fresh, the SCA vulnerable-dependency check and the license
audit). **Never lower a threshold** to get a push through — add the missing test. Keep the hook
executable: git skips a non-executable hook with only a hint, so the gate disappears without ever
failing.

Lint is first because it is the cheapest and because it is the only one of the four that can fail on a
file the others are perfectly happy with — the next `yarn lint` would rewrite it anyway. It was
ungated for a long time, and so were `eslint.config.js`, `.prettierrc` and `.prettierignore`: none of
the three was in the hook's `RELEVANT_PATHS`, so a commit touching only them skipped every gate there
is. All three are in the filter now.

`git commit` runs `.githooks/pre-commit`, which is the secret guard *and* three of those four — lint,
coverage, Qodana. Mutation is pre-push only. Both hooks scan on purpose, and the pre-push one is not
redundant: **`git merge --no-ff` never fires `pre-commit`** — git runs that hook for `git commit`
only — so in the branch → commit → merge → push flow the merge commit, the one revision that actually
reaches origin, is the single commit no pre-commit scan ever sees. Two individually clean branches can
merge into a tree that is not.

The second reason is Qodana Cloud. It files every report under the branch it was produced on, and
pre-commit always runs on the feature branch *before* the commit exists — so a repo gated only there
can never produce a `main`-tagged report, `main` is not offered as the project's default branch, and
the "new problems" baseline has nothing stable to compare against. pre-push runs after the merge, on
main, which is the revision the baseline wants. Both scans hand `qodana.sh` `SKIP_TESTS=1` so the
coverage report the preceding gate just wrote is reused rather than regenerated with its exit code
swallowed.

Ahead of every gate the hook selects node, reading `engines.node` from `package.json` and switching via
nvm. The gates shell out to yarn and yarn's `engines` check is a hard exit 1, so without it a push from
a shell on the machine default node dies *before* the first gate, under that gate's banner — which is
how a node mismatch first read as a type error. Every repo's `pre-push` carries that block, and so now
does every `pre-commit`, since all of them run tests.

Bypasses, in order of bluntness: `SKIP_QODANA=1` (scan only, coverage and mutation still gate) ·
`git commit --no-verify` / `git push --no-verify` (the whole hook).

<!-- gitnexus:start -->
# GitNexus — Code Intelligence

This project is indexed by GitNexus as **marketplace-dev-user-authenticated-resource**. Use the GitNexus MCP tools to understand code, assess impact, and navigate safely.

> Index stale? Run `node .gitnexus/run.cjs analyze` from the project root — it auto-selects an available runner. No `.gitnexus/run.cjs` yet? `npx gitnexus analyze` (npm 11 crash → `npm i -g gitnexus`; #1939).

## Always Do

- **MUST run impact analysis before editing any symbol.** Before modifying a function, class, or method, run `impact({target: "symbolName", direction: "upstream"})` and report the blast radius (direct callers, affected processes, risk level) to the user.
- **MUST run `detect_changes()` before committing** to verify your changes only affect expected symbols and execution flows. For regression review, compare against the default branch: `detect_changes({scope: "compare", base_ref: "main"})`.
- **MUST warn the user** if impact analysis returns HIGH or CRITICAL risk before proceeding with edits.
- When exploring unfamiliar code, use `query({search_query: "concept"})` to find execution flows instead of grepping. It returns process-grouped results ranked by relevance.
- When you need full context on a specific symbol — callers, callees, which execution flows it participates in — use `context({name: "symbolName"})`.
- For security review, `explain({target: "fileOrSymbol"})` lists taint findings (source→sink flows; needs `analyze --pdg`).

## Never Do

- NEVER edit a function, class, or method without first running `impact` on it.
- NEVER ignore HIGH or CRITICAL risk warnings from impact analysis.
- NEVER rename symbols with find-and-replace — use `rename` which understands the call graph.
- NEVER commit changes without running `detect_changes()` to check affected scope.

## Resources

| Resource | Use for |
|----------|---------|
| `gitnexus://repo/marketplace-dev-user-authenticated-resource/context` | Codebase overview, check index freshness |
| `gitnexus://repo/marketplace-dev-user-authenticated-resource/clusters` | All functional areas |
| `gitnexus://repo/marketplace-dev-user-authenticated-resource/processes` | All execution flows |
| `gitnexus://repo/marketplace-dev-user-authenticated-resource/process/{name}` | Step-by-step execution trace |

## Cross-Repo Groups

This repository is listed under GitNexus **group(s): marketplace-platform** (see `~/.gitnexus/groups/`). For cross-repo analysis, use MCP tools `impact`, `query`, and `context` with `repo` set to `@<groupName>` or `@<groupName>/<memberPath>` (paths match keys in that group’s `group.yaml`). Use `group_list` / `group_sync` for membership and sync. From the project root: `node .gitnexus/run.cjs group list`, `node .gitnexus/run.cjs group sync <name>`, `node .gitnexus/run.cjs group impact <name> --target <symbol> --repo <group-path>` (the `.gitnexus/run.cjs` path is repo-root-relative).

## CLI

| Task | Read this skill file |
|------|---------------------|
| Understand architecture / "How does X work?" | `.claude/skills/gitnexus/gitnexus-exploring/SKILL.md` |
| Blast radius / "What breaks if I change X?" | `.claude/skills/gitnexus/gitnexus-impact-analysis/SKILL.md` |
| Trace bugs / "Why is X failing?" | `.claude/skills/gitnexus/gitnexus-debugging/SKILL.md` |
| Rename / extract / split / refactor | `.claude/skills/gitnexus/gitnexus-refactoring/SKILL.md` |
| Tools, resources, schema reference | `.claude/skills/gitnexus/gitnexus-guide/SKILL.md` |
| Index, status, clean, wiki CLI commands | `.claude/skills/gitnexus/gitnexus-cli/SKILL.md` |

<!-- gitnexus:end -->
