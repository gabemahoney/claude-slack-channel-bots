/**
 * cron-scheduler-wiring.test.ts — Static audit (b.he5 E2 wiring guard;
 * b.av2 SR-11 cron semantics).
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
 * before Bun.serve(), if the shutdown-path stop call disappears, or if the
 * cron wiring stops reading the persona config main() loaded (its log and
 * table paths, and the dispatcher's target resolution). There is no longer a
 * no-config start: main() requires the config file (b.av2 SR-8.7), so the
 * scheduler is always built.
 *
 * SPDX-License-Identifier: MIT
 */

import { describe, test, expect } from 'bun:test'
import { readFileSync } from 'node:fs'
import { callArguments, indicesOf, loadedConfigName, stripComments } from './test-helpers/source-audit.ts'

const SERVER_SRC = readFileSync('src/server.ts', 'utf-8')

/** server.ts with every comment removed (see stripComments). */
const SERVER_CODE = stripComments(SERVER_SRC)

describe('server.ts wires the cron scheduler', () => {
  test('imports createCronScheduler from the cron-scheduler module', () => {
    // The import regex subsumes a bare `toContain` name check.
    expect(SERVER_SRC).toMatch(
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

  test('builds the cron log, dispatcher and scheduler from the loaded persona config', () => {
    // The config main() loaded through the persona loader (b.av2 SR-1.7). The
    // dispatcher resolves each fire's target against it (b.av2 SR-11).
    const config = loadedConfigName(SERVER_CODE)
    for (const call of ['createCronLog', 'createCronDispatcher', 'createCronScheduler']) {
      const at = SERVER_CODE.search(new RegExp(`\\b${call}\\s*\\(`))
      expect(at).toBeGreaterThan(-1)
      const args = callArguments(SERVER_CODE, at)
      expect(args).toMatch(new RegExp(`\\b${config}\\.cron_(?:log|table)_path\\b`))
    }
    expect(callArguments(SERVER_CODE, SERVER_CODE.search(/\bcreateCronDispatcher\s*\(/))).toMatch(
      new RegExp(`\\bresolveTarget\\s*:[^,]*\\bresolvePersonaTarget\\s*\\(\\s*${config}\\s*,`),
    )
  })

  test('stops the scheduler inside the shutdown() function body', () => {
    // Bound the shutdown function body by content: from its declaration to the
    // first process.on() signal-wiring line that follows it. Anchoring on
    // content (not line numbers) keeps the audit robust to edits elsewhere.
    const shutdownStart = SERVER_SRC.indexOf('async function shutdown(')
    expect(shutdownStart).toBeGreaterThan(-1)
    const shutdownEnd = SERVER_SRC.indexOf("process.on('SIGTERM'", shutdownStart)
    expect(shutdownEnd).toBeGreaterThan(shutdownStart)

    const shutdownBody = SERVER_SRC.slice(shutdownStart, shutdownEnd)
    // The stop call must live within the shutdown region; a bare presence check
    // elsewhere in the file would not prove it runs on the shutdown path.
    expect(shutdownBody).toContain('cronScheduler.stop(')
  })
})
