# marketplace-dev-user-authenticated-resource

Backend svc 9 of 9. User tier, resource concern. Port 4032, endpoint `/user-authenticated-resource`.

**Read parent first** — [`../../../CLAUDE.md`](https://github.com/Axiumine/fullstack-marketplace-blueprint/blob/main/CLAUDE.md)
Tier/concern split, port table, terminology, auth model live there. Not here.

| Need | File |
|---|---|
| what this svc is, suite shape | [`README.md`](./README.md) |
| GraphQL surface, hook internals, gate order, node selection, trap details in full | [`REPO.md`](./REPO.md) |
| GitNexus rules, this repo's registry name | [`AGENTS.md`](./AGENTS.md) |

Token lifecycle → `marketplace-dev-user-authenticated-authorization` (4031). Logout →
`marketplace-dev-authenticated-logout` (4030), all three tiers.

## ⚠️ NEVER run the mutation gate by hand

`yarn test:mutation` is **hook-only** — only `pre-push` calls it, never to check one file, never to
confirm a survivor fixed, and never `stryker` directly. To reproduce a survivor, apply the mutant by hand
in the source and run `yarn test` (seconds). Why, and the exact bypass rules: [`REPO.md`](./REPO.md).
⚠️ Since ADR-055 the script has a second caller, `.github/workflows/gates.yml`, which runs it on
every pull request — two callers, both automated, and a hand is neither.

## Traps

⚠️ **`user.defaultAddress` is a pointer, and MongoDB enforces it via `$expr`.** It must be absent or
present in `addresses[]._id`; removing the default address must unset the pointer in the *same write*,
which is why `funUserAddressDel` is a pipeline update, not a `$pull`. Two Mongoose pipeline traps pinned
in `userLib.test.mts`: [`REPO.md`](./REPO.md).

⚠️ **`userDel` is not gated on `disabled` (ADR-036), and it frees the address on a clock, not at once.**
Suspension is not erasure and is never checked here; the address unlocks via `user.deleted_ttl`, a 30-day
TTL index, not a job. Detail, including the already-closed 410 vs. token-layer 498: [`REPO.md`](./REPO.md).

⚠️ **`sanitizeFilter` is on process-wide.** A filter with `$expr` throws, and any other `$`-keyed value
not wrapped in `mongoose.trusted()` is silently rewritten to an always-false equality — a guard can turn
into "refuse everything" with no error. `funUserAddressAdd`'s cap clause depends on `trusted()`.

⚠️ **Six addresses per account, and the number lives in three repositories.** `maxItems: 6` in
`marketplace-db-setup/lib/schemas/user.js` is the rule; `MAX_ADDRESSES` here only shapes the 400. The cap
is a clause of the same `updateOne` that pushes, so two concurrent adds cannot both fit.

⚠️ **A value containing whitespace must be single-quoted in the env file.** dotenv truncates a bare value
at the first space with no error; double quotes would also expand `\n`/`\r` escapes.

## Not a rename of the ShopOwner service

Copied from `marketplace-dev-authenticated-resource` (4026): `assertTier(redData.tier, TIER.user)`
fail-closed, no uploads mounted, no `_id` argument names another account, shorter `REQUIRED_ENV_VARS`.
None of the four is an omission to "correct" back. Full comparison: [`REPO.md`](./REPO.md).

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

commit → secret guard, lint, types, coverage, Qodana. push → same + semgrep (SAST) + trivy (dependency
advisories) + mutation. All blocking. Why: [`REPO.md`](./REPO.md).

## GitNexus

⚠️ Run `impact({target, repo})` before editing a symbol; run `detect_changes()` before committing.
`repo:` is mandatory and must always be a `marketplace*` registry name (this repo:
`marketplace-dev-user-authenticated-resource`). Full rules, tools and resources: [`AGENTS.md`](./AGENTS.md)
— AGENTS.md is not auto-loaded, so read it before a GitNexus-heavy task.
