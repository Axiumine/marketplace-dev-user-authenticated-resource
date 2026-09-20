# Repository mechanics

How this repo's git plumbing behaves, and why, plus the reference material and trap detail moved out of
[`CLAUDE.md`](./CLAUDE.md) to keep that file short — the GraphQL surface, the full ShopOwner-service
comparison, and the long form of every `⚠️` trap it only summarizes. Nothing here changes what you
write; [`CLAUDE.md`](./CLAUDE.md) carries the rules themselves.

## Hooks

`git push` runs `.githooks/pre-push`, a blocking **seven**-step gate: `yarn semgrep:ci` (Semgrep SAST over the
sources, vendored rules, pinned image, `--network none`), then trivy (dependency advisories, HIGH and
CRITICAL, production tree only), then `yarn lint:check` (eslint, then
`prettier --check`, both over the whole tree), then `yarn typecheck` (`tsc -p tsconfig.test.json`, src/ +
test/ + the vitest configs, no emit), then `yarn test:cov` (100% on every metric), then
`yarn test:mutation` (Stryker, `thresholds.break: 100`), then Qodana (`./qodana.sh`, gated by
`qodana.yaml`: coverage 100 total / 100 fresh and the license audit). Keep the hook executable: git skips
a non-executable hook with only a hint, so the gate disappears without ever failing.

⚠️ **Qodana is not what covers dependencies here, and the list above used to say it was.** The inspection
it runs is `VulnerableLibrariesLocal`, an offline heuristic that queries no advisory feed and reports zero
on every repo on this platform; the class that does query one ships in the same image and is in no
profile. The trivy step is the check that reports — it reads `yarn.lock` natively, suppresses
devDependencies, and blocks on HIGH or CRITICAL with the CVE id and the fixed version. Bypass for a Docker
or network outage, never for a finding: `SKIP_TRIVY=1 git push`.

`git commit` runs `.githooks/pre-commit`, which is the secret guard *and* four of those seven — lint,
types, coverage, Qodana. Semgrep, trivy and mutation are pre-push only.

Semgrep and trivy lead because they are the two cheap ones — about three seconds and, with the
vulnerability database already pulled, under one — against the minutes the rest take together, so a rule
violation or an advisory is reported before anything slow runs.
Lint leads the five that follow because it is the cheapest of them and the only one that can fail on a
file the others are perfectly happy with — the next `yarn lint` would rewrite it anyway. It was
ungated for a long time, and so were `eslint.config.js`, `.prettierrc` and `.prettierignore`: none of
the three was in the hook's `RELEVANT_PATHS`, so a commit touching only them skipped every gate there
is. All three are in the filter now.

## Why Qodana runs in both hooks

**`git merge --no-ff` never fires `pre-commit`** — git runs that hook for `git commit` only — so in the
branch → commit → merge → push flow the merge commit, the one revision that actually reaches origin,
is the single commit no pre-commit scan ever sees. Two individually clean branches can merge into a
tree that is not.

The second reason is Qodana Cloud. It files every report under the branch it was produced on, and
pre-commit always runs on the feature branch *before* the commit exists — so a repo gated only there
can never produce a `main`-tagged report, `main` is not offered as the project's default branch, and
the "new problems" baseline has nothing stable to compare against. pre-push runs after the merge, on
main, which is the revision the baseline wants. Both scans hand `qodana.sh` `SKIP_TESTS=1` so the
coverage report the preceding gate just wrote is reused rather than regenerated with its exit code
swallowed.

## Node selection

Ahead of every gate the hook selects node, reading `engines.node` from `package.json` and switching via
nvm. The gates shell out to yarn and yarn's `engines` check is a hard exit 1, so without it a push from
a shell on the machine default node dies *before* the first gate, under that gate's banner — which is
how a node mismatch first read as a type error. Every repo's `pre-push` carries that block, and so does
every `pre-commit`, since all of them run tests.

## Bypasses

`SKIP_QODANA=1` (scan only — coverage and mutation still gate) · `git commit --no-verify` /
`git push --no-verify` (the whole hook). Both are gate removals. See [`CLAUDE.md`](./CLAUDE.md) for when they may be
used, which is: when the user says so, and not otherwise.

## Why the mutation gate is hook-only

`yarn test:mutation` is **hook-only**. It runs when the `pre-push` hook calls it and at no other time —
not to check a change, not before a commit, not on one file, not to confirm a survivor is fixed. Do not
invoke `stryker` directly either.

This does not weaken anything: the threshold stays 100, `pre-push` still blocks, and no survivor is ever
answered by lowering a number. What changes is **who starts the run**. A full pass costs tens of minutes
and holds the whole machine at 28 workers while it lasts, so an on-demand run is time taken from the
person waiting for the work.

Go through the package script if a run is ever authorised — never `npx stryker run`, which skips whatever
the script sets up around it.

A survivor is answered by writing the test it names and letting the next push run the gate. If a mutant
has to be reproduced first, apply it by hand in the source and run `yarn test` — that is seconds, it
names the tests that should have failed, and it costs nobody the machine.

## Surface

Two queries, seven mutations. Every one acts on the account the request is authenticated as.

| Operation | Answers | Notes |
|---|---|---|
| `me` | `GraphQLUserMe!` | no args — session is the only identity |
| `userExport` | `GraphQLUserExport!` | GDPR Art. 20 — `me` plus `login.firstLogin` / `login.lastLogin` |
| `userPersonalDataUpdate` | `Boolean!` | replaces whole `personalData` sub-doc |
| `userAddressAdd` | `OnlyIdType!` | new element `_id`, client needs it — **at most 6 per account** |
| `userAddressUpdate` | `Boolean!` | replaces one element whole |
| `userAddressDel` | `Boolean!` | hard delete + clears `defaultAddress` same write |
| `userDefaultAddressSet` | `Boolean!` | one atomic `$set` of a root-level pointer |
| `userUpdatePwd` | `Boolean!` | requires current password |
| `userDel` | `Boolean!` | GDPR Art. 17 — soft-delete stamp + every session revoked |

## Not a rename of the ShopOwner service

Copied from `marketplace-dev-authenticated-resource` (4026). Four differences, none of them an omission to
"correct" back:

- **`assertTier(redData.tier, TIER.user)`** in the auth middleware. All nine svcs read Redis under the same
  `REDIS_KEY` prefix, so an Admin or ShopOwner access token is *findable* here; the assertion is the only
  thing that refuses it, and a session with no `tier` is refused too — fail closed.
- **No uploads.** `graphqlUploadKoa` and `initClamScan` are not mounted; `sharp`, `clamscan`, `file-type`
  and `graphql-upload` are not dependencies. A customer uploads nothing, the middleware is not free to
  mount (it intercepts every multipart request) and the antivirus is a socket to clamd that would have to
  be up for this svc to boot. They come back the day this tier accepts a file.
- **No `_id` argument names an account.** `userUpdatePwd` and `userPersonalDataUpdate` take no id at all;
  the three address mutations take the id of an *address*, guarded by `throwIfUserDontOwnAddress`. No query
  reads another customer.
- **Shorter `REQUIRED_ENV_VARS`, and a shorter `env` template to match.** SocketLabs, email, redirect,
  cookie and upload variables are gone because nothing here reads them — `checkRequiredEnv` throws on a
  *missing* variable, so a leftover turns a bootable svc into a startup crash.

## Trap details

Full elaboration for each `⚠️` trap summarized in [`CLAUDE.md`](./CLAUDE.md).

### The default-address pointer

⚠️ **The default address is a pointer, and MongoDB enforces it.** `user.defaultAddress` is an ObjectId at
the document root that must be absent or present in `addresses[]._id` — the `$expr` half of the collection
validator, alongside the `$jsonSchema`. Two consequences that bite at runtime rather than at review time:
setting the default is one `$set` with nothing to clear first, and **removing the default address must
unset the pointer in the same write**, which is why `funUserAddressDel` is an aggregation pipeline with
`$$REMOVE` instead of a `$pull`.

That pipeline is the only pipeline update in the workspace. Two traps in it, both pinned in
`userLib.test.mts`:

- **Mongoose 9 refuses an array update outright** unless `{ updatePipeline: true }` is passed —
  `Cannot pass an array to query updates unless the 'updatePipeline' option is set.`, thrown in
  `Query.prototype` before the driver is reached. The unit suite mocks `User.updateOne`, and a mock takes
  an array happily.
- **Mongoose casts a filter against the schema and casts nothing inside a pipeline** — a pipeline is an
  opaque aggregation expression to it. `GraphQLID` resolves to a **string**, whatever `IArgs` declares, so
  `{ $ne: ['$$this._id', '68b1…'] }` compared an ObjectId to a string, was never equal, kept every element
  and answered `matchedCount: 1, modifiedCount: 0`. The test for it must pass a **string** id:
  `new Types.ObjectId(oid)` deep-equals its argument, so with an ObjectId fixture the missing coercion is
  unobservable.

### `userDel`, `disabled`, and the erasure clock

⚠️ **`userDel` is not gated on `disabled`, and it hands the address back on a clock rather than at
once.** Two things about it that read as omissions and are not:

- **`disabled` is deliberately not a gate (ADR-036).** ⚠️ **`funUserUpdatePwd` is the only lib function
  here that calls `checkUserAuthorizationDisDel`** — one caller out of seven, which looks like rot and is
  not. Suspension otherwise reaches a live session only at its edges: `loginUser` refuses it, and
  `findAccountForSession` re-checks on every refresh, so a suspended customer with a live access token
  still reaches every write on this service for up to one access-token lifetime. `funUserDel` checks only
  that the document exists and is not already stamped. Suspension is a platform decision about what
  somebody may *do*; the right to erasure is not something the platform suspends. `userLib.test.mts` pins
  the absence of that call, so restoring it fails the suite rather than passing silently.
- **The address stays taken for the retention window, and only for it.** `login.email_unique` carries
  no `partialFilterExpression`, so a soft-deleted document still holds its address. What frees it is
  **`user.deleted_ttl`** — the 30-day purge from `phase1/NFR.md` open question 6, shipped as a TTL
  index over `deleted` in `marketplace-db-setup`, not as a job. So the stamp `funUserDel` writes *is*
  the erasure order; MongoDB's background monitor carries it out about a minute late, and nothing on
  this service runs. ⚠️ **Two indexes cover `deleted` on `user` and neither is redundant**:
  `expireAfterSeconds` is single-field only, so `tbl_active_registeredAt` cannot carry it.
  Re-registering the same address ends the wait early — `userRegister` on
  `marketplace-dev-public-resource` destroys the closed document and opens a new account
  (ADR-011 §Amendment 2026-08-26), which is the platform's one application hard delete.

The already-closed branch answers **410**, not 401, and it is reachable only through a session that
outlived the close — the ordinary second call is refused 498 by the token layer, because the first one
revoked the caller's session. 401 on this tier keeps its single meaning: a resolver read your account
and refused it.

### `sanitizeFilter` being process-wide

⚠️ **`sanitizeFilter` is on process-wide, so a filter cannot use `$expr` and an operator in one needs
`mongoose.trusted()`.** koa-utils' MongoDB data source calls `mongoose.set('sanitizeFilter', true)`. Two
different failures come out of that, and only the first is loud:

- `$expr` (also `$where`, `$text`, `$jsonSchema`) **throws** — `$expr is not allowed with sanitizeFilter` —
  on every call, not only the one that should have been refused.
- any other value holding a `$` key is silently rewritten to `{$eq: <that object>}`. `{$exists: false}`
  becomes a search for an element equal to the literal object, matches nothing, and turns a guard into a
  refusal of everything. `funUserAddressAdd`'s cap clause is `mongoose.trusted({ $exists: false })` for
  exactly this, and `userLib.test.mts` deep-equals against `trusted(...)` so the symbol is pinned.

### The six-address cap

⚠️ **Six addresses per account, and the number lives in three repositories.** `maxItems: 6` on
`addresses` in `marketplace-db-setup/lib/schemas/user.js` is the rule; `MAX_ADDRESSES` in
`funUserAddressAdd.mts` only buys the shape of the refusal (a 400 naming the limit instead of a validator
failure surfacing as a 500); the third copy is the account area's. The cap is a **clause of the filter**
of the same `updateOne` that pushes — `addresses.5` absent — so counting and writing are one operation
and two concurrent adds cannot both fit through.

### Whitespace in env values

⚠️ **A value containing whitespace must be quoted in the environment file, in single quotes.** dotenv
terminates a bare value at the first space, hands back the truncated prefix and reports no error. Not
double quotes: dotenv expands `\n` and `\r` escapes inside those.

## Tests

100% on all four coverage metrics, mutation score 100. Unit files plus `*.itest.mts` integration files.
What each integration file covers: [`README.md`](./README.md).

Stryker runs the **unit project only** (`vitest.mutation.config.mts` narrows to `test/*.test.mts`),
deliberately: mutating against real infrastructure would be slow and flaky.

Two rules when adding a test:

- **Assert `extensions.description`, not the message, for anything text-carrying.** `throwGraphQLError`
  puts the HTTP *title* in `message` — 'Bad Request', 'Forbidden' — so `toThrow('passwordNew must differ…')`
  never matches, and two entirely different refusals share one envelope. `userLib.test.mts` has the
  `rejection()` helper for the envelope, plus one explicit `description` assertion where the text is the
  only thing separating two 400s.
- **`schema.test.mts` imports `queries.mts` / `mutations.mts` inside `beforeEach`**, and that is not style.
  A mutant that blanks a `GraphQLObjectType` name throws in the constructor; thrown at import time or in
  `beforeAll` it marks every test *skipped*, which Stryker cannot attribute, so a killed mutant is reported
  Survived. Inside `beforeEach` it fails the one test that was running.
