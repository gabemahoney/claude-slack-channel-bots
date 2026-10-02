/**
 * start-sweep-wiring.test.ts — Static audit of the start sweep's wiring in
 * src/server.ts (b.av2 SR-6.3).
 *
 * SR-6.3: at start, BEFORE any bring-up, the server runs the persona start
 * sweep, which kills and deletes `service=cscb` rows with no `persona` label,
 * an absent persona, the wrong instance ID or the wrong `cwd`. The sweep reads
 * the applied persona set main()'s start resolution chose (b.av2 SR-8.7:
 * `personaConfig = start.config`, the last-applied record's at a start from
 * the record). If the call is dropped, moved before that assignment or after
 * the start bring-up (`reload.runStartBringUp()`, whose pass brings each
 * persona up and launches it) or fed anything but the applied config, a
 * stale row survives into the collision ladder, or the sweep kills the rows
 * of a persona set that does not run.
 *
 * b.jg5 SRJ-702 (AC 56): the sweep's kills are each a bounded retry, so
 * main() hands the sweep the production kill-retry clock (imported from
 * src/kill-retry.ts, never a copy or a test clock). That each
 * `reconcileOrphans` call has its own pass budget is shown by behaviour in
 * tests/session-manager.test.ts.
 *
 * Why a static audit: main() cannot run in a unit test (the agent-director
 * startup gate, a real port, real Slack connections). This follows the
 * tests/jsonl-safeguard-wiring.test.ts precedent: it reads the source with
 * comments stripped and anchors on content, never on line numbers.
 *
 * SPDX-License-Identifier: MIT
 */

import { describe, test, expect } from 'bun:test'
import { readFileSync } from 'node:fs'
import type * as KillRetryModule from '../src/kill-retry.ts'
import { importSource, indicesOf, loadedConfigName, startResolution, stripComments } from './test-helpers/source-audit.ts'

const SERVER_SRC = readFileSync(new URL('../src/server.ts', import.meta.url), 'utf-8')

/** server.ts with every comment removed (see stripComments). */
const SERVER_CODE = stripComments(SERVER_SRC)

/** The production kill-retry clock (b.jg5 SRJ-702); renaming it fails the typecheck. */
const PRODUCTION_CLOCK: keyof typeof KillRetryModule = 'KILL_RETRY_SYSTEM_CLOCK'

/** Any call of the sweep in code, awaited or not, whatever its argument. */
const ANY_SWEEP_CALL = /\breconcileOrphans\s*\(/g

/** The awaited sweep call with exactly the loaded persona config and the production kill-retry clock. */
function sweepCall(): RegExp {
  return new RegExp(`await\\s+reconcileOrphans\\s*\\(\\s*${loadedConfigName(SERVER_CODE)}\\s*,\\s*${PRODUCTION_CLOCK}\\s*\\)`, 'g')
}

describe('server.ts wires the persona start sweep (b.av2 SR-6.3)', () => {
  test('imports reconcileOrphans from the session manager', () => {
    expect(SERVER_SRC).toMatch(
      /import\s*\{[^}]*\breconcileOrphans\b[^}]*\}\s*from\s*['"]\.\/session-manager\.ts['"]/,
    )
  })

  test('code calls the sweep exactly once, awaited with the loaded persona config and the production kill-retry clock', () => {
    expect(indicesOf(ANY_SWEEP_CALL, SERVER_CODE)).toHaveLength(1)
    expect(indicesOf(sweepCall(), SERVER_CODE)).toHaveLength(1)
  })

  test('runs the sweep AFTER the start resolution sets the applied config and BEFORE the start bring-up (the per-persona bring-up and launch)', () => {
    const [sweep] = indicesOf(sweepCall(), SERVER_CODE)
    const { assignAt, bringUpAt } = startResolution(SERVER_CODE)
    expect(sweep).toBeDefined()
    expect(sweep!).toBeGreaterThan(assignAt)
    expect(sweep!).toBeLessThan(bringUpAt)
  })

  test('b.jg5 SRJ-702: the clock handed to the sweep is the one src/kill-retry.ts exports, imported, never declared in server.ts', () => {
    expect(importSource(SERVER_CODE, PRODUCTION_CLOCK)).toBe('./kill-retry.ts')
    expect(indicesOf(new RegExp(`\\b(?:let|const|var|function)\\s+${PRODUCTION_CLOCK}\\b`, 'g'), SERVER_CODE)).toEqual([])
  })
})
