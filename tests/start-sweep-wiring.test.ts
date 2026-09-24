/**
 * start-sweep-wiring.test.ts — Static audit of the start sweep's wiring in
 * src/server.ts (b.av2 SR-6.3).
 *
 * SR-6.3: at start, BEFORE any bring-up, the server runs the persona start
 * sweep, which kills and deletes `service=cscb` rows with no `persona` label,
 * an absent persona, the wrong instance ID or the wrong `cwd`. The sweep reads
 * the persona set main() loaded (`loadStartPersonaConfig`). If the call is
 * dropped, moved after the per-persona bring-up (`startupSessionManager`, which
 * brings each persona up and launches it) or fed anything but the loaded
 * config, a stale row survives into the collision ladder.
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
import { indicesOf, loadedConfigName, stripComments } from './test-helpers/source-audit.ts'

const SERVER_SRC = readFileSync('src/server.ts', 'utf-8')

/** server.ts with every comment removed (see stripComments). */
const SERVER_CODE = stripComments(SERVER_SRC)

/** Any call of the sweep in code, awaited or not, whatever its argument. */
const ANY_SWEEP_CALL = /\breconcileOrphans\s*\(/g
const STARTUP_CALL = /\bstartupSessionManager\s*\(/g

/** The awaited sweep call with exactly the loaded persona config. */
function sweepCall(): RegExp {
  return new RegExp(`await\\s+reconcileOrphans\\s*\\(\\s*${loadedConfigName(SERVER_CODE)}\\s*\\)`, 'g')
}

describe('server.ts wires the persona start sweep (b.av2 SR-6.3)', () => {
  test('imports reconcileOrphans from the session manager', () => {
    expect(SERVER_SRC).toMatch(
      /import\s*\{[^}]*\breconcileOrphans\b[^}]*\}\s*from\s*['"]\.\/session-manager\.ts['"]/,
    )
  })

  test('code calls the sweep exactly once, awaited with the loaded persona config', () => {
    expect(indicesOf(ANY_SWEEP_CALL, SERVER_CODE)).toHaveLength(1)
    expect(indicesOf(sweepCall(), SERVER_CODE)).toHaveLength(1)
  })

  test('runs the sweep BEFORE startupSessionManager (the per-persona bring-up and launch)', () => {
    const [sweep] = indicesOf(sweepCall(), SERVER_CODE)
    const startup = indicesOf(STARTUP_CALL, SERVER_CODE)
    expect(sweep).toBeDefined()
    expect(startup.length).toBeGreaterThan(0)
    for (const s of startup) expect(sweep!).toBeLessThan(s)
  })
})
