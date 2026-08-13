import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

/*
 * ⚠️ **The enumeration E15-S06 asks for: every credential write in this service ends the account's
 * sessions, and a new one cannot be added quietly.** `mutations.test.mts` proves the one call site that
 * exists today. This walks `src/`, finds every file that writes a login identifier, and fails on any
 * writer whose resolver does not revoke after the write.
 *
 * There is one writer here now and the story that added this test changed no code in this service: the
 * customer tier has no email-change mutation, so `userUpdatePwd` is the whole set. The test exists for
 * the one that comes later — a `userUpdateEmail` added without a revoke fails here by name.
 *
 * The scan is deliberately substring-based rather than a single tight regex spanning `$set` and the
 * field name. Stryker runs this suite against instrumented sources, where a string literal is rewritten
 * into a ternary carrying both the mutated and the original value — an adjacency regex would stop
 * matching under instrumentation and fail in the dry run, before any mutant is even active. The
 * substrings survive that rewrite because both branches keep the literal text.
 *
 * `login.email` and `login.password` are the two halves of a credential on all three collections
 * (`marketplace-common/src/models/MongoDB/*.mts`). `personalData.contacts.email` deliberately is not:
 * it is where the platform writes *to* a person, not what they sign in with, which is why
 * `userPersonalDataUpdate` is absent from this list and must stay absent from it.
 */

const SRC = new URL('../src/', import.meta.url).pathname
const MUTATIONS = join(SRC, 'graphQLApi/schema/mutations')

// The assertion is equality, not inclusion: a second mutation that writes a credential lands here as a
// failing test naming the file, which is the point of the story.
const KNOWN_WRITERS = ['src/lib/user/funUserUpdatePwd.mts']

const walk = (dir: string): string[] =>
	readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
		entry.isDirectory() ? walk(join(dir, entry.name)) : [join(dir, entry.name)]
	)

const sources = walk(SRC)
	.filter((path) => path.endsWith('.mts'))
	.map((path) => ({ path, relative: `src${path.slice(SRC.length - 1)}`, code: readFileSync(path, 'utf8') }))

const writesCredential = ({ code }: { code: string }) =>
	code.includes('$set') && (code.includes("'login.email'") || code.includes("'login.password'"))

const credentialWriters = sources.filter(writesCredential)

/** The mutations importing a given lib file — how a writer is tied to the resolver answering for it. */
const callersOf = (relative: string) => {
	const module = relative.split('/').pop()?.replace('.mts', '') ?? ''

	return sources.filter(({ path, code }) => path.startsWith(MUTATIONS) && code.includes(`/${module}.mjs'`))
}

describe('every credential write in this service ends the account’s sessions', () => {
	it('finds exactly the known credential writers', () => {
		expect(credentialWriters.map(({ relative }) => relative).sort()).toStrictEqual(KNOWN_WRITERS)
	})

	// One resolver per writer, so "the mutation that answers for this write" is a single, checkable thing.
	// A lib reached from two mutations would need both checked, and this is where that stops being silent.
	it.each(KNOWN_WRITERS)('%s is reached from exactly one mutation, and that mutation revokes', (writer) => {
		const callers = callersOf(writer)

		expect(callers).toHaveLength(1)
		expect(callers[0]?.code).toMatch(/await endEvery[A-Za-z]*Session\(/)
	})

	/*
	 * ⚠️ The revoke has to sit **after** the write. Asserted textually here because the per-mutation tests
	 * assert it by invocation order and this suite has no resolver to run — a new mutation that revoked
	 * first would pass every check above while logging accounts out for writes that never landed.
	 */
	it.each(KNOWN_WRITERS)('%s is written before its mutation revokes', (writer) => {
		const [caller] = callersOf(writer)
		const module = writer.split('/').pop()?.replace('.mts', '') ?? ''
		const code = caller?.code ?? ''

		expect(code.indexOf(`await ${module}(`)).toBeGreaterThan(-1)
		expect(code.search(/await endEvery[A-Za-z]*Session\(/)).toBeGreaterThan(code.indexOf(`await ${module}(`))
	})
})
