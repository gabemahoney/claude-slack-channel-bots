/**
 * http-verbose-gate.test.ts — the per-request HTTP access line is gated (b.3k6).
 *
 * b.brv silenced the loudest routine "success" chatter (the AD
 * `SubprocessClient: <verb> ok` dumps) behind CSCB_AD_VERBOSE. b.3k6 continues
 * that pass for the next-loudest steady-state offender: the `/mcp` fetch
 * handler's per-request access line
 *
 *   [slack] HTTP <method> <path> session=<sid>
 *
 * which fires on every MCP round-trip (poll, notification, tool response, each
 * SSE open). b.3k6 gates it behind a new `isHttpVerbose()` helper reading
 * CSCB_HTTP_VERBOSE, OFF by default, truthy `1/true/yes/on` (case-insensitive) —
 * mirroring b.brv's CSCB_AD_VERBOSE contract in agent-director-logger.ts.
 *
 * `isHttpVerbose()` is now exported from src/server.ts as an env-parameterized
 * seam (mirroring b.brv's isVerbose in agent-director-logger.ts), so the truthy
 * contract is exercised by importing the helper and injecting `env` objects
 * directly — no source-text audit needed. Importing src/server.ts is safe: its
 * `main()` boot is guarded behind `if (import.meta.main)`, so a plain
 * `import { isHttpVerbose }` runs no side effects (existing tests already import
 * `_buildIsSessionAliveAdapter` / `_buildStatRouteImpl` from the same module).
 *
 * The one remaining static assertion is the guard-adjacency regression pin: it
 * fails on the pre-fix code — where the access line was an unconditional
 * `console.error(...)` with no gate and no env var — and passes once the line
 * is wrapped in `if (isHttpVerbose())`.
 *
 * SPDX-License-Identifier: MIT
 */

import { describe, test, expect } from 'bun:test'
import { readFileSync } from 'node:fs'
import { isHttpVerbose, HTTP_VERBOSE_ENV } from '../src/server.ts'

const SERVER_SRC = readFileSync('src/server.ts', 'utf-8')

// The exact per-request access-line emit inside the /mcp fetch handler.
const ACCESS_LINE_RE =
  /console\.error\(`\[slack\] HTTP \$\{req\.method\} \$\{url\.pathname\} session=\$\{mcpSid \?\? '\(none\)'\}`\)/

/** Build an env with only the given CSCB_HTTP_VERBOSE override (nothing else). */
function envWith(val: string | undefined): NodeJS.ProcessEnv {
  return val === undefined ? {} : { [HTTP_VERBOSE_ENV]: val }
}

describe('b.3k6 — isHttpVerbose honors the b.brv truthy contract', () => {
  test.each([
    ['1'],
    ['true'],
    ['yes'],
    ['on'],
    ['TRUE'],
    ['On'],
    ['YES'],
    [' 1 '],
    ['\ttrue\n'],
  ])('truthy value %p enables verbose', (val) => {
    expect(isHttpVerbose(envWith(val))).toBe(true)
  })

  test.each([
    ['0'],
    ['false'],
    ['no'],
    ['off'],
    [''],
    ['maybe'],
    ['2'],
    ['onoff'],
    ['tru'],
  ])('non-truthy value %p disables verbose', (val) => {
    expect(isHttpVerbose(envWith(val))).toBe(false)
  })

  test('unset CSCB_HTTP_VERBOSE disables verbose', () => {
    expect(isHttpVerbose(envWith(undefined))).toBe(false)
  })

  test('HTTP_VERBOSE_ENV names the CSCB_HTTP_VERBOSE knob', () => {
    expect(HTTP_VERBOSE_ENV).toBe('CSCB_HTTP_VERBOSE')
  })
})

describe('b.3k6 — per-request HTTP access line is gated behind CSCB_HTTP_VERBOSE', () => {
  test('the access line is present exactly once', () => {
    const matches = SERVER_SRC.match(new RegExp(ACCESS_LINE_RE, 'g')) ?? []
    expect(matches).toHaveLength(1)
  })

  test('the access line is wrapped in an isHttpVerbose() guard, not unconditional', () => {
    // FAILS pre-fix: on the pre-b.3k6 source the emit sits at column 6 with no
    // guard, so the line preceding it does not open an `if (isHttpVerbose())`.
    const idx = SERVER_SRC.search(ACCESS_LINE_RE)
    expect(idx).toBeGreaterThan(-1)

    const before = SERVER_SRC.slice(0, idx)
    const priorLines = before.split('\n')
    // The emit's own leading indentation is the final split fragment, so the
    // opening guard is the line just above it. Assert the guard sits directly
    // adjacent to the emit (no unrelated statements between them).
    const lastTwo = priorLines
      .slice(-2)
      .map((l) => l.trim())
      .filter((l) => l.length > 0)
    expect(lastTwo).toContain('if (isHttpVerbose()) {')
  })
})
