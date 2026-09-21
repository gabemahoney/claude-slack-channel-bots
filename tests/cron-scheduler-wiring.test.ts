/**
 * cron-scheduler-wiring.test.ts — Static audit (b.he5 E2 wiring guard).
 *
 * server.ts cannot be imported in tests (module-scope side effects), so the
 * SRD invariant "the cron scheduler starts only AFTER the HTTP server is
 * listening, from main(), and is stopped on shutdown" cannot be exercised
 * behaviorally. This follows the repo precedent for exactly that situation:
 * tests/jsonl-safeguard-wiring.test.ts — a content-anchored static audit of
 * src/server.ts source text (import shape + relative call-site ordering via
 * indexOf; never line numbers).
 *
 * These assertions FAIL if the scheduler start call is dropped or reordered
 * before Bun.serve(), or if the shutdown-path stop call disappears; they PASS
 * with Task 3's wiring in place.
 *
 * SPDX-License-Identifier: MIT
 */

import { describe, test, expect } from 'bun:test'
import { readFileSync } from 'node:fs'

const SERVER_SRC = readFileSync('src/server.ts', 'utf-8')

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
    const serveIdx = SERVER_SRC.indexOf('Bun.serve({')
    const startIdx = SERVER_SRC.indexOf('cronScheduler.start(')
    // serveIdx > -1 anchors the ordering; startIdx > -1 proves the start call
    // exists (subsumes a separate "is called" test); start must follow serve.
    expect(serveIdx).toBeGreaterThan(-1)
    expect(startIdx).toBeGreaterThan(-1)
    expect(startIdx).toBeGreaterThan(serveIdx)
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
