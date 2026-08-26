# marketplace-dev-user-authenticated-resource

Backend svc 9 of 9. User tier, resource concern. Port 4032, endpoint `/user-authenticated-resource`.

**Read parent first** — [`../../../CLAUDE.md`](https://github.com/Axiumine/fullstack-marketplace-blueprint/blob/main/CLAUDE.md)
Tier/concern split, port table, terminology, auth model live there. Not here.

| Need | File |
|---|---|
| what this svc is, suite shape | [`README.md`](./README.md) |
| hook internals, gate order, node selection | [`REPO.md`](./REPO.md) |

Token lifecycle → `marketplace-dev-user-authenticated-authorization` (4031). Logout →
`marketplace-dev-authenticated-logout` (4030), all three tiers.

## ⚠️ NEVER run the mutation gate by hand

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

## Traps

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

⚠️ **`userDel` is the one write here that a suspended customer may still make, and the one that keeps
an address occupied after it runs.** Two things about it that read as omissions and are not:

- **`disabled` is deliberately not a gate.** Every other write on this tier runs
  `checkUserAuthorizationDisDel` and answers 401 to a suspended account; `funUserDel` checks only that
  the document exists and is not already stamped. Suspension is a platform decision about what somebody
  may *do*; the right to erasure is not something the platform suspends. `userLib.test.mts` pins the
  absence of that call, so restoring it fails the suite rather than passing silently.
- **The address stays taken for the retention window, not forever.** `login.email_unique` carries no
  `partialFilterExpression`, so a soft-deleted document still holds its address and the same person
  cannot re-register with it. What frees it is the 30-day purge decided in `phase1/NFR.md` open
  question 6 — **which does not exist yet**: no TTL index, no scheduled job. Until it is built, closing
  an account burns its email address permanently, and that is a gap rather than a design.

The already-closed branch answers **410**, not 401, and it is reachable only through a session that
outlived the close — the ordinary second call is refused 498 by the token layer, because the first one
revoked the caller's session. 401 on this tier keeps its single meaning: a resolver read your account
and refused it.

⚠️ **`sanitizeFilter` is on process-wide, so a filter cannot use `$expr` and an operator in one needs
`mongoose.trusted()`.** koa-utils' MongoDB data source calls `mongoose.set('sanitizeFilter', true)`. Two
different failures come out of that, and only the first is loud:

- `$expr` (also `$where`, `$text`, `$jsonSchema`) **throws** — `$expr is not allowed with sanitizeFilter` —
  on every call, not only the one that should have been refused.
- any other value holding a `$` key is silently rewritten to `{$eq: <that object>}`. `{$exists: false}`
  becomes a search for an element equal to the literal object, matches nothing, and turns a guard into a
  refusal of everything. `funUserAddressAdd`'s cap clause is `mongoose.trusted({ $exists: false })` for
  exactly this, and `userLib.test.mts` deep-equals against `trusted(...)` so the symbol is pinned.

⚠️ **Six addresses per account, and the number lives in three repositories.** `maxItems: 6` on
`addresses` in `marketplace-db-setup/lib/schemas/user.js` is the rule; `MAX_ADDRESSES` in
`funUserAddressAdd.mts` only buys the shape of the refusal (a 400 naming the limit instead of a validator
failure surfacing as a 500); the third copy is the account area's. The cap is a **clause of the filter**
of the same `updateOne` that pushes — `addresses.5` absent — so counting and writing are one operation
and two concurrent adds cannot both fit through.

⚠️ **A value containing whitespace must be quoted in the environment file, in single quotes.** dotenv
terminates a bare value at the first space, hands back the truncated prefix and reports no error. Not
double quotes: dotenv expands `\n` and `\r` escapes inside those.

`INTROSPECTION_CODE` must equal the other eight services' — a mismatch breaks the service-to-service
bypass in both directions and nothing tests the pairing.

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

## Rules

- **Never commit on `main`.** Branch first: `git switch -c <type>/<slug>`. Merge = user decision alone.
- Merged → delete branch: `git branch -d <slug>`. `-d` only. `-D` never.
- **No remote.** Push-on-request: no `git push` unless the user asked for it in that message.
- **Never lower a coverage or mutation threshold, and never remove a gate.** Threshold miss → write the
  missing test. Bypasses (`SKIP_QODANA=1`, `--no-verify`) are gate removals: use only when the user says so.
- Tabs, not spaces. eslint + prettier both enforce.
- English only — identifiers, comments, fixtures. No exception.
- Domain query/mutation → **resource** svc. Token lifecycle → **authorization** svc.

## Gates

commit → secret guard, lint, coverage, Qodana. push → same + semgrep (SAST) + trivy (dependency
advisories) + mutation. All blocking. Why: [`REPO.md`](./REPO.md).

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
