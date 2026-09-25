/**
 * cron-scheduler-wiring.test.ts — Static audit (b.he5 E2 wiring guard;
 * b.av2 SR-11 cron semantics, SR-8.7 applied config).
 *
 * main() cannot run in a unit test (the agent-director startup gate, a real
 * port, real Slack connections), so the SRD invariant "the cron scheduler
 * starts only AFTER the HTTP server is listening, from main(), and is stopped
 * on shutdown" cannot be exercised behaviorally. This follows the repo
 * precedent for exactly that situation: tests/jsonl-safeguard-wiring.test.ts —
 * a content-anchored static audit of src/server.ts source text (import shape +
 * relative call-site ordering via indexOf; never line numbers).
 *
 * These assertions FAIL if the scheduler start call is dropped or reordered
 * before Bun.serve(), if the shutdown-path stop call disappears, if the cron
 * wiring runs before main() has an applied config, or if it stops reading the
 * applied config (its log and table paths, and the dispatcher's target
 * resolution). The applied config is the one `<loaded> = <outcome>.config`
 * after the reload controller's start resolution (the last-applied record, or
 * the config file when there is none); a refused start exits before that
 * assignment (pinned, with the start's assignment rule, in
 * tests/server-startup-wiring.test.ts).
 *
 * SPDX-License-Identifier: MIT
 */

import { describe, test, expect } from 'bun:test'
import { readFileSync } from 'node:fs'
import { balancedAfter, callArguments, indicesOf, startResolution, stripComments } from './test-helpers/source-audit.ts'

/** server.ts with every comment removed (see stripComments). */
const SERVER_CODE = stripComments(readFileSync('src/server.ts', 'utf-8'))

/** The cron calls main() makes to build the scheduler. */
const CRON_BUILDERS = ['createCronLog', 'createCronDispatcher', 'createCronScheduler']

describe('server.ts wires the cron scheduler', () => {
  test('imports createCronScheduler from the cron-scheduler module', () => {
    // The import regex subsumes a bare `toContain` name check. Read the
    // comment-stripped code, so a commented-out import cannot satisfy it.
    expect(SERVER_CODE).toMatch(
      /import\s*\{[^}]*createCronScheduler[^}]*\}\s*from\s*['"]\.\/cron-scheduler\.ts['"]/,
    )
  })

  test('starts the scheduler AFTER the Bun.serve() call site', () => {
    // Anchor on `Bun.serve({` (the actual server construction) — NOT a bare
    // `Bun.serve(`, which would first match the `ReturnType<typeof Bun.serve>`
    // type annotation near the top of the file and defeat the ordering check.
    // Read the comment-stripped code, and check EVERY start call (`?.` and `!.`
    // included), so an extra early start cannot hide behind a later one.
    const serveIdx = SERVER_CODE.indexOf('Bun.serve({')
    const starts = indicesOf(/\bcronScheduler[?!]?\.start\s*\(/g, SERVER_CODE)
    expect(serveIdx).toBeGreaterThan(-1)
    expect(starts.length).toBeGreaterThan(0)
    for (const startIdx of starts) expect(startIdx).toBeGreaterThan(serveIdx)
  })

  test('builds and starts the cron wiring only once main() has the applied config: every call follows `<loaded> = <outcome>.config`', () => {
    // A refused start exits before that assignment (server-startup-wiring
    // pins the exit), so nothing after it runs on a refused start.
    const { assignAt } = startResolution(SERVER_CODE)
    const calls = [
      ...CRON_BUILDERS.flatMap((call) => indicesOf(new RegExp(`\\b${call}\\s*\\(`, 'g'), SERVER_CODE)),
      ...indicesOf(/\bcronScheduler[?!]?\.start\s*\(/g, SERVER_CODE),
    ]
    expect(calls.length).toBeGreaterThanOrEqual(CRON_BUILDERS.length + 1)
    for (const at of calls) expect(at).toBeGreaterThan(assignAt)
  })

  test('builds the cron log, dispatcher and scheduler from the applied persona config', () => {
    // The config the start resolution applied (b.av2 SR-8.7). The dispatcher
    // resolves each fire's target against it (b.av2 SR-11). The builders run
    // after `<loaded> = <outcome>.config` (the previous test), so reading
    // <loaded> there is reading the applied config, never the edited file.
    const { loaded } = startResolution(SERVER_CODE)
    for (const call of CRON_BUILDERS) {
      const at = SERVER_CODE.search(new RegExp(`\\b${call}\\s*\\(`))
      expect(at).toBeGreaterThan(-1)
      const args = callArguments(SERVER_CODE, at)
      expect(args).toMatch(new RegExp(`\\b${loaded}\\.cron_(?:log|table)_path\\b`))
    }
    expect(callArguments(SERVER_CODE, SERVER_CODE.search(/\bcreateCronDispatcher\s*\(/))).toMatch(
      new RegExp(`\\bresolveTarget\\s*:[^,]*\\bresolvePersonaTarget\\s*\\(\\s*${loaded}\\s*,`),
    )
  })

  test('stops the scheduler inside the shutdown() function body', () => {
    // Bound the shutdown function body by its braces in the comment-stripped
    // code. Anchoring on content (not line numbers) keeps the audit robust to
    // edits elsewhere, and stripping comments keeps a commented-out stop from
    // satisfying it.
    const fn = SERVER_CODE.search(/\basync\s+function\s+shutdown\s*\(/)
    expect(fn).toBeGreaterThan(-1)
    const shutdownBody = SERVER_CODE.slice(...balancedAfter(SERVER_CODE, SERVER_CODE.indexOf(')', fn), '{', '}'))
    // The stop call must live within the shutdown region; a bare presence check
    // elsewhere in the file would not prove it runs on the shutdown path.
    expect(shutdownBody).toMatch(/\bcronScheduler[?!]?\.stop\s*\(/)
  })
})
