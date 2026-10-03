/**
 * start-sweep-wiring.test.ts — Static audit of the start sweep's wiring in
 * src/server.ts, and of the sweep's own path in src/session-manager.ts
 * (b.av2 SR-6.3 as amended by b.jg5 SRJ-1506; b.jg5 SRJ-714).
 *
 * SR-6.3, SRJ-714, SRJ-1506: at start, BEFORE any bring-up, the server runs
 * the persona start sweep. It reads every `service=cscb` row, latches from
 * the configured personas' own rows, records the keys of absent personas as
 * retired, kills the live strays (rows with no `persona` label, an absent
 * persona, the wrong instance ID or the wrong `cwd`) with each kill's result
 * checked, and deletes none: a killed row is kept until agent-director's
 * `expire` removes it. The sweep reads the applied persona set main()'s start
 * resolution chose (b.av2 SR-8.7: `personaConfig = start.config`, the
 * last-applied record's at a start from the record). If the call is dropped,
 * moved before that assignment or after the start bring-up
 * (`reload.runStartBringUp()`, whose pass brings each persona up and launches
 * it) or fed anything but the applied config, a stale row survives into the
 * collision ladder, or the sweep kills the rows of a persona set that does
 * not run.
 *
 * b.jg5 SRJ-702 (AC 56): the sweep's kills are each a bounded retry, so
 * main() hands the sweep the production kill-retry clock (imported from
 * src/kill-retry.ts, never a copy or a test clock). That each
 * `reconcileOrphans` call has its own pass budget is shown by behaviour in
 * tests/session-manager.test.ts.
 *
 * b.jg5 SRJ-205, SRJ-714: main() hands the sweep a shutdown query that reads
 * the module's `shuttingDown` flag each time it is asked, so a shutdown begun
 * during the sweep stops its agent-director calls. What the sweep does once
 * the query answers true is shown by behaviour in
 * tests/session-manager.test.ts; the `if (shuttingDown) return` before the
 * sweep is pinned with the other start-time guards in
 * tests/server-startup-wiring.test.ts.
 *
 * Why a static audit: main() cannot run in a unit test (the agent-director
 * startup gate, a real port, real Slack connections). This follows the
 * tests/jsonl-safeguard-wiring.test.ts precedent: it reads the source with
 * comments stripped and anchors on content, never on line numbers. The
 * no-delete pin is the sweep's own; the `src/`-wide one is E34's.
 *
 * SPDX-License-Identifier: MIT
 */

import { describe, test, expect } from 'bun:test'
import { readFileSync } from 'node:fs'
import type * as KillRetryModule from '../src/kill-retry.ts'
import {
  importSource,
  indicesOf,
  insideMain,
  loadedConfigName,
  onlyCallArguments,
  splitTopLevel,
  startResolution,
  stripComments,
} from './test-helpers/source-audit.ts'

const SERVER_SRC = readFileSync(new URL('../src/server.ts', import.meta.url), 'utf-8')

/** server.ts with every comment removed (see stripComments). */
const SERVER_CODE = stripComments(SERVER_SRC)

/** session-manager.ts with every comment removed (see stripComments). */
const SESSION_MANAGER_CODE = stripComments(readFileSync(new URL('../src/session-manager.ts', import.meta.url), 'utf-8'))

/** The production kill-retry clock (b.jg5 SRJ-702); renaming it fails the typecheck. */
const PRODUCTION_CLOCK: keyof typeof KillRetryModule = 'KILL_RETRY_SYSTEM_CLOCK'

/** Any call of the sweep in code, awaited or not, whatever its argument. */
const ANY_SWEEP_CALL = /\breconcileOrphans\s*\(/g

/** The awaited sweep call (its arguments are pinned by the call-shape case). */
const AWAITED_SWEEP_CALL = /\bawait\s+reconcileOrphans\s*\(/g

/** A shutdown query that reads the module's flag when asked: an arrow returning `shuttingDown` itself. */
const LIVE_SHUTDOWN_QUERY = '() => shuttingDown'

/**
 * An agent-director `delete` verb call: a `delete` on a client (`client.delete(`,
 * `pass.client.delete(`, `getClient().delete(`) or a `.delete(` given a params
 * object (`{ claude_instance_id: [...] }`). A `Map`'s `.delete(key)` is neither.
 */
const DELETE_VERB_CALL = /(?:\bclient|\bgetClient\s*\(\s*\))\s*\.\s*delete\s*\(|\.\s*delete\s*\(\s*\{/i

/** A kill-and-delete helper's name (`killAndDeleteSweptRow` and the like). */
const KILL_AND_DELETE_NAME = /\b\w*kill\w*delete\w*\b/i

/**
 * `code`'s top-level `function`, `const` and `let` declarations by name, each
 * mapped to its text: from its declaration to the next top-level declaration
 * (any line that starts in column 0 with a declaration keyword). An overloaded
 * function's texts are joined.
 */
function topLevelDeclarations(code: string): Map<string, string> {
  const starts = indicesOf(/^(?:export\s+)?(?:declare\s+)?(?:async\s+)?(?:function|const|let|var|interface|type|class|import|enum)\b/gm, code)
  const decls = new Map<string, string>()
  starts.forEach((at, i) => {
    const name = code.slice(at).match(/^(?:export\s+)?(?:async\s+)?(?:function\s*\*?\s*|const\s+|let\s+)([A-Za-z_$][\w$]*)/)?.[1]
    if (name === undefined) return
    decls.set(name, (decls.get(name) ?? '') + code.slice(at, starts[i + 1] ?? code.length))
  })
  return decls
}

/**
 * The texts of `entry` and of every top-level declaration of `code` it reaches,
 * transitively: any identifier in a reached text that names a top-level
 * declaration is followed, so a function handed on as a callback counts as
 * called. Keyed by name.
 */
function reachedDeclarations(code: string, entry: string): Map<string, string> {
  const decls = topLevelDeclarations(code)
  if (!decls.has(entry)) throw new Error(`no top-level declaration of ${entry}`)
  const reached = new Map<string, string>([[entry, decls.get(entry)!]])
  const queue = [entry]
  for (let name = queue.shift(); name !== undefined; name = queue.shift()) {
    for (const [, id] of reached.get(name)!.matchAll(/(?<![\w.$])([A-Za-z_$][\w$]*)/g)) {
      if (!decls.has(id!) || reached.has(id!)) continue
      reached.set(id!, decls.get(id!)!)
      queue.push(id!)
    }
  }
  return reached
}

describe('server.ts wires the persona start sweep (b.av2 SR-6.3, b.jg5 SRJ-714)', () => {
  test('imports reconcileOrphans from the session manager', () => {
    expect(SERVER_SRC).toMatch(
      /import\s*\{[^}]*\breconcileOrphans\b[^}]*\}\s*from\s*['"]\.\/session-manager\.ts['"]/,
    )
  })

  test('code calls the sweep exactly once, awaited, with the loaded persona config, the production kill-retry clock and a shutdown query reading `shuttingDown` when asked', () => {
    expect(indicesOf(ANY_SWEEP_CALL, SERVER_CODE)).toHaveLength(1)
    expect(indicesOf(AWAITED_SWEEP_CALL, SERVER_CODE)).toHaveLength(1)
    expect(splitTopLevel(onlyCallArguments(SERVER_CODE, 'reconcileOrphans'))).toEqual([
      loadedConfigName(SERVER_CODE),
      PRODUCTION_CLOCK,
      LIVE_SHUTDOWN_QUERY,
    ])
  })

  test('b.jg5 SRJ-205: the flag the shutdown query reads is server.ts\'s one module-level `let shuttingDown`, never re-declared in main(), so the query sees a shutdown begun after the call', () => {
    const decls = indicesOf(/\b(?:let|const|var)\s+shuttingDown\b/g, SERVER_CODE)
    expect(decls).toHaveLength(1)
    expect(SERVER_CODE.slice(decls[0]!)).toMatch(/^let\s/)
    expect(insideMain(SERVER_CODE, decls[0]!)).toBe(false)
  })

  test('runs the sweep AFTER the start resolution sets the applied config and BEFORE the start bring-up (the per-persona bring-up and launch)', () => {
    const [sweep] = indicesOf(AWAITED_SWEEP_CALL, SERVER_CODE)
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

describe('the start sweep deletes no row (b.jg5 SRJ-714, SRJ-1506 beside b.av2 SR-6.3; HO C2, C17; AC 77)', () => {
  test('reconcileOrphans and every session-manager function it reaches (its kills, their retry and the post-kill find-missing run included) make no agent-director `delete` call and name no kill-and-delete helper', () => {
    const reached = reachedDeclarations(SESSION_MANAGER_CODE, 'reconcileOrphans')
    const path = [...reached.values()].join('\n')
    // Not vacuous: the walk reaches the sweep's kill call and its post-kill find-missing run.
    expect(path).toMatch(/\bclient\s*\.\s*kill\s*\(/)
    expect(path).toMatch(/\bclient\s*\.\s*findMissing\s*\(/)
    const offenders = [...reached]
      .filter(([, text]) => DELETE_VERB_CALL.test(text) || KILL_AND_DELETE_NAME.test(text))
      .map(([name]) => name)
    expect(offenders).toEqual([])
  })
})
