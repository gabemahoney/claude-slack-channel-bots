/**
 * jsonl-safeguard-wiring.test.ts — Static audit (b.zak regression guard).
 *
 * The b.zak fix is a NEW module whose value is realised only if main() actually
 * invokes it BEFORE the resume path (startupSessionManager) that silently
 * deletes+fresh-spawns on ErrJsonlMissing. If the call is dropped or reordered,
 * the preventative warning never fires and every bot can lose memory silently —
 * exactly the 2026-09-20 incident.
 *
 * This test FAILS on main (where server.ts neither imports nor calls
 * runJsonlPersistenceSafeguard) and PASSES with the fix wired in. It follows the
 * existing static-audit precedent (tests/getclient-allowlist static audit in
 * tests/outage-state.test.ts).
 *
 * SPDX-License-Identifier: MIT
 */

import { describe, test, expect } from 'bun:test'
import { readFileSync } from 'node:fs'

const SERVER_SRC = readFileSync('src/server.ts', 'utf-8')

describe('server.ts wires the JSONL-persistence safeguard', () => {
  test('imports runJsonlPersistenceSafeguard from the safeguard module', () => {
    // The import regex subsumes a bare `toContain` name check.
    expect(SERVER_SRC).toMatch(
      /import\s*\{[^}]*runJsonlPersistenceSafeguard[^}]*\}\s*from\s*['"]\.\/jsonl-persistence-check\.ts['"]/,
    )
  })

  test('calls the safeguard BEFORE startupSessionManager (the resume/wipe path)', () => {
    const safeguardIdx = SERVER_SRC.indexOf('runJsonlPersistenceSafeguard(')
    const startupIdx = SERVER_SRC.indexOf('startupSessionManager(')
    // safeguardIdx > -1 proves the call exists (subsumes a separate "is called"
    // test); startupIdx > -1 anchors the ordering; safeguard must precede resume.
    expect(safeguardIdx).toBeGreaterThan(-1)
    expect(startupIdx).toBeGreaterThan(-1)
    expect(safeguardIdx).toBeLessThan(startupIdx)
  })
})
