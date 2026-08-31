# marketplace-dev-user-authenticated-resource

Domain data for the **customer** tier — `User`, the end customer who places orders. Port **4032**,
endpoint `/user-authenticated-resource`.

Token lifecycle is not here; it lives in `marketplace-dev-user-authenticated-authorization` (4031), and
logout in `marketplace-dev-authenticated-logout` (4030), which all three tiers share unchanged.

The whole surface is two queries and seven mutations — `me`, a GDPR Art. 20 export, a personal-data write,
four address operations, a password change and closing the account — and every one of them acts on the
account the request is authenticated as. The operation table, and the four ways this service deliberately
differs from its ShopOwner original, are in [`CLAUDE.md`](./CLAUDE.md).

## The suite

Twenty-one files, 419 tests, 100% on all four coverage metrics and a 100.00 mutation score — sixteen unit
files (348 tests) plus five `*.itest.mts` (71 tests). The "skip all tests" instruction this repo was built
under was revoked by the user on 2026-08-06; the suite was written from the harness up and both gates
pass, so a commit here needs no `--no-verify`.

### Green by vacancy, until 2026-08-07

The integration project was configured and empty until then, and it found two production bugs in its first
run — both in `funUserAddressDel`, both structurally invisible to the unit suite, and **every address
delete on the customer tier answered 500** until they were fixed.

It had been green by vacancy: vitest collects zero tests for a project with no matching files and reports
success, which reads exactly like a suite that ran. What it was not proving was the whole point of this
service — `me`, the personal-data write, the address CRUD and the default-address pointer, all asserted
against mocks and never against the real `$jsonSchema` or the real `$expr` that rejects a dangling
`defaultAddress`. The two bugs themselves are recorded in [`CLAUDE.md`](./CLAUDE.md), because each is a class of mistake
rather than a typo.

### The environment that blocked it

Until 2026-08-07 five `MONGO_TEST_*` keys were empty here — this machine's file was a copy of an unrelated
old project's — so `vitest.mongo.mts` refused to build a URL and `missingTestMongoEnv()` named every one of
them. They are filled in now and the two database users were provisioned with the loop in
`marketplace-db-setup/setup/mongodb.js`.

One other key in the same file was wrong rather than missing: `MONGODB_URI` pointed at `testRnApollo`, a
leftover database from that other project with no `authSource`.

The platform convention still holds — `MONGO_TEST_DB`, `MONGO_TEST_AUTH_ADMIN` and the database path of
`MONGO_TEST_CONN_STRING` all carry the same name, unique to the repo (`dbMarketplaceTestUserRes` here),
since every `globalSetup` drops its own database.

### The five integration files

|File|Covers|
|---|---|
|`index.itest.mts`|the bearer gate against a live Redis session (412 / 499 / 498 / **403** for another tier and for a session with no `tier` at all), CSRF on GET, a full `me` selection, a secret-non-leak check that no hash reaches the wire, and the same pair for `userExport` — the decrypted round-trip including the two login timestamps, and a body scan that additionally refuses `emailVerify.newEmailTmp`, the one encrypted value a widened projection would hand back in plaintext|
|`account.itest.mts`|`userPersonalDataUpdate` and `userUpdatePwd` against the real validator — including a raw-driver counter-proof that `contacts: { mobile: null }` is refused with `code: 121` while a real number is accepted, and real bcrypt on both sides of the password change; plus `userDel` — the `deleted` stamp accepted by the `$expr` clause on a document that carries a `defaultAddress`, the caller's key really gone from the cluster, 498 from the token layer on the second call, the resolver's own 410 when a session outlives the close, and a suspended customer closing anyway|
|`addresses.itest.mts`|the three address mutations plus `userDefaultAddressSet`, including the six-address cap — six accepted through the real mutation, the seventh answered 400 — and a block that drives the collection validator directly: `$pull` of the default rejected, `$pull` of a non-default accepted, a foreign pointer rejected, a pointer with no `addresses` rejected, a seventh address rejected on insert and on `$push`|
|`shutdown.itest.mts`|`gracefulShutdown`, the process-level handlers, production introspection refusal, and the 5s teardown budget lost for real against a local blackhole socket|
|`startFailure.itest.mts`|`start()`'s catch arm with a URL MongoDB genuinely refuses, and the env guard running *outside* the try|

`harness.mts` is shared by the four that need a server, and that is safe because vitest gives each test
file its own module registry — the tracking arrays it exports are per-file, which is what lets
`shutdown.itest.mts` destroy its connections without touching the other suites'. Seeding goes through the
raw driver, every `_id` and every Redis key is registered at creation time rather than in a `finally`, and
both are drained in `afterAll`.

### The unit project's own server

`index.unit.test.mts` boots a real server — `createServer()`, port 0, `/health`, an unknown path, a
`{ me { … } }` POST, a ShopOwner session refused 403 and a bare GET refused by `csrfPrevention` — over a
real socket with Mongo and Redis mocked. It is what keeps the coverage number honest without a database.

## Related files

| Topic | File |
|---|---|
| rules for agents working in this repo | [`CLAUDE.md`](./CLAUDE.md) |
| git hooks, gate order, node selection | [`REPO.md`](./REPO.md) |
| the whole platform — tiers, ports, terminology | parent [`CLAUDE.md`](./CLAUDE.md) |

## License

GPL-3.0-or-later — see [LICENSE](./LICENSE).
