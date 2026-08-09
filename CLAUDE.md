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

## Surface

One query, six mutations. Every one acts on the account the request is authenticated as.

| Operation | Answers | Notes |
|---|---|---|
| `me` | `GraphQLUserMe!` | no args — session is the only identity |
| `userPersonalDataUpdate` | `Boolean!` | replaces whole `personalData` sub-doc |
| `userAddressAdd` | `OnlyIdType!` | new element `_id`, client needs it |
| `userAddressUpdate` | `Boolean!` | replaces one element whole |
| `userAddressDel` | `Boolean!` | hard delete + clears `defaultAddress` same write |
| `userDefaultAddressSet` | `Boolean!` | one atomic `$set` of a root-level pointer |
| `userUpdatePwd` | `Boolean!` | requires current password |

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

commit → secret guard, lint, coverage, Qodana. push → same + mutation. All blocking. Why: [`REPO.md`](./REPO.md).

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
