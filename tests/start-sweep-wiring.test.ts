/**
 * start-sweep-wiring.test.ts — Static audit of the start sweep's wiring in
 * src/server.ts (b.av2 SR-6.3).
 *
 * SR-6.3: at start, BEFORE any bring-up, the server runs the persona start
 * sweep, which kills and deletes `service=cscb` rows with no `persona` label,
 * an absent persona, the wrong instance ID or the wrong `cwd`. The sweep reads
 * the persona set, not routes. If the call is dropped, moved after the
 * per-persona bring-up (`startupSessionManager`) or fed `routingConfig` again,
 * a stale row survives into the collision ladder.
 *
 * Why a static audit: importing src/server.ts runs module-scope startup code
 * against the real HOME and token environment, which unit tests must not do
 * (b.av2 SR-13.2). This follows the tests/jsonl-safeguard-wiring.test.ts
 * precedent and anchors on source content, never on line numbers.
 *
 * SPDX-License-Identifier: MIT
 */

import { describe, test, expect } from 'bun:test'
import { readFileSync } from 'node:fs'

const SERVER_SRC = readFileSync('src/server.ts', 'utf-8')

/**
 * server.ts with every comment removed: block comments (JSDoc included) and
 * line comments, whole-line or trailing. String and template literals are
 * matched first and kept, so a `//` inside a string is not taken for a
 * comment. Prose or commented-out code that names a function (e.g. "BEFORE
 * startupSessionManager", `// await reconcileOrphans(personaConfig)`) can then
 * never satisfy or skew a code-position assertion.
 */
const SERVER_CODE = SERVER_SRC.replace(
  /('(?:\\.|[^'\\\n])*'|"(?:\\.|[^"\\\n])*"|`(?:\\.|[^`\\])*`)|\/\*[\s\S]*?\*\/|\/\/[^\n]*/g,
  (_match, literal: string | undefined) => literal ?? '',
)

/** Any call of the sweep in code, awaited or not, whatever its argument. */
const ANY_SWEEP_CALL = /\breconcileOrphans\s*\(/g
const SWEEP_CALL = /await\s+reconcileOrphans\s*\(\s*personaConfig\s*\)/g
const STARTUP_CALL = /await\s+startupSessionManager\s*\(/g

function indicesOf(re: RegExp, text: string): number[] {
  return [...text.matchAll(re)].map((m) => m.index ?? -1)
}

describe('server.ts wires the persona start sweep (b.av2 SR-6.3)', () => {
  test('imports reconcileOrphans from the session manager', () => {
    expect(SERVER_SRC).toMatch(
      /import\s*\{[^}]*\breconcileOrphans\b[^}]*\}\s*from\s*['"]\.\/session-manager\.ts['"]/,
    )
  })

  test('code calls the sweep exactly once, awaited with the persona configuration (never routingConfig)', () => {
    expect(indicesOf(ANY_SWEEP_CALL, SERVER_CODE)).toHaveLength(1)
    expect(indicesOf(SWEEP_CALL, SERVER_CODE)).toHaveLength(1)
  })

  test('runs the sweep BEFORE startupSessionManager (the per-persona bring-up)', () => {
    const [sweep] = indicesOf(SWEEP_CALL, SERVER_CODE)
    const startup = indicesOf(STARTUP_CALL, SERVER_CODE)
    expect(startup.length).toBeGreaterThan(0)
    for (const s of startup) expect(sweep!).toBeLessThan(s)
  })
})
