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

  test('constructs the cron scheduler+log INSIDE the `if (routingConfig)` guard block (env-var fallback path builds nothing cron-related)', () => {
    // AC (subtask t3.he5.eu.4q.ti): on the env-var fallback path (no routing
    // config) nothing cron-related is constructed or started. Enforced by
    // requiring the createCronLog/createCronScheduler/start() calls to live
    // inside the routingConfig guard block, so dropping the guard fails here.
    const schedIdx = SERVER_SRC.indexOf('createCronScheduler(')
    const logIdx = SERVER_SRC.indexOf('createCronLog(')
    const startIdx = SERVER_SRC.indexOf('cronScheduler.start(')
    expect(schedIdx).toBeGreaterThan(-1)
    expect(logIdx).toBeGreaterThan(-1)
    expect(startIdx).toBeGreaterThan(-1)

    // The enclosing guard is the LAST `if (routingConfig) {` before the cron
    // construction; its try/catch closes at the first `catch (err)` after it.
    // Bounding the region by content (never line numbers) keeps this robust to
    // edits elsewhere in main() — the same indexOf technique the shutdown-region
    // and Bun.serve-ordering tests use.
    const guardIdx = SERVER_SRC.lastIndexOf('if (routingConfig) {', schedIdx)
    expect(guardIdx).toBeGreaterThan(-1)
    const guardEnd = SERVER_SRC.indexOf('catch (err)', guardIdx)
    expect(guardEnd).toBeGreaterThan(guardIdx)

    // All three cron wiring calls must fall strictly within [guard, catch): if
    // the guard were removed the lastIndexOf would land on a DIFFERENT, earlier
    // `if (routingConfig)` and one of these bounds would fail.
    for (const idx of [logIdx, schedIdx, startIdx]) {
      expect(idx).toBeGreaterThan(guardIdx)
      expect(idx).toBeLessThan(guardEnd)
    }
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
