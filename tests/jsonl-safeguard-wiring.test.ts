/**
 * jsonl-safeguard-wiring.test.ts — Static audit of the start-time passes in
 * src/server.ts (b.zak regression guard; b.av2 SR-6.2).
 *
 * The b.zak fix is a NEW module whose value is realised only if main() actually
 * invokes it BEFORE the resume path (the start bring-up, which runs
 * startupSessionManager) that silently deletes+fresh-spawns on
 * ErrJsonlMissing. If the call is dropped or reordered, the preventative
 * warning never fires and every bot can lose memory silently — exactly the
 * 2026-09-20 incident.
 *
 * b.av2 SR-6.2 widens the audit to every start-time pass: the trust patch, the
 * legacy-hook cleanup and the JSONL safeguard all run over the applied persona
 * config before the per-persona bring-up (b.av2 SR-6.1), the agent-director
 * template install covers the personas' config dirs, and the session manager's
 * pre-launch trust patcher is installed before anything can launch (the
 * persona Slack connections, Bun.serve, initRestart, the per-persona bring-up).
 *
 * b.av2 SR-8.7 routes the start through the reload controller: main() resolves
 * the start (`const start = reload.resolveStart()`), sets the applied config
 * from it (`personaConfig = start.config`, the last-applied record's at a start
 * from the record, never the edited config file), and requests the bring-up
 * with `reload.runStartBringUp()`, which runs the controller's lifecycle
 * `startBringUp` (`startupSessionManager` over the config the controller
 * hands it). So every pass must come after that assignment and before that
 * invocation; `startupSessionManager`'s text now sits in the controller's
 * construction, above the passes, and is no ordering anchor (that its
 * argument is the controller's applied config is pinned in
 * tests/server-startup-wiring.test.ts). Bug b.js7 removes the pre-launch
 * reply guard; startup and launches remove only legacy settings entries.
 *
 * Why a static audit: main() cannot run in a unit test (the agent-director
 * startup gate, a real port, real Slack connections). Positions and arguments
 * are read from the source with every comment stripped, and anchor on names,
 * never on line numbers or whole lines.
 *
 * SPDX-License-Identifier: MIT
 */

import { describe, test, expect } from 'bun:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  callArguments,
  indicesOf,
  insideMain,
  loadedConfigName,
  mainBody,
  onlyCallArguments,
  objectProperties,
  splitTopLevel,
  startResolution,
  stripComments,
} from './test-helpers/source-audit.ts'

const SERVER_SRC = readFileSync(fileURLToPath(new URL('../src/server.ts', import.meta.url)), 'utf-8')

/** server.ts with every comment removed (see stripComments). */
const SERVER_CODE = stripComments(SERVER_SRC)

/** Offsets of every call of `name` in code (`name(`, whatever its argument). */
function callsOf(name: string): number[] {
  return indicesOf(new RegExp(`\\b${name}\\s*\\(`, 'g'), SERVER_CODE)
}

/** The first argument (trimmed source text) of every call of `name` in code. */
function firstArgsOf(name: string): string[] {
  return [...SERVER_CODE.matchAll(new RegExp(`\\b${name}\\s*\\(\\s*([^,)]*)`, 'g'))].map((m) => m[1]!.trim())
}

/** Offset of the first code call of `name`; fails the test if there is none. */
function firstCallOf(name: string): number {
  const calls = callsOf(name)
  expect(calls.length).toBeGreaterThan(0)
  return calls[0]!
}

/**
 * Offset of the start bring-up request in main(): `<controller>.runStartBringUp(`
 * (the one call; startResolution throws otherwise). Fails unless it is inside
 * main().
 */
function startBringUpAt(): number {
  const { bringUpAt } = startResolution(SERVER_CODE)
  expect(insideMain(SERVER_CODE, bringUpAt)).toBe(true)
  return bringUpAt
}

/** Every start-time pass SR-6.2 requires to run over the applied personas. */
const START_PASSES = [
  'installSlackChannelBotTemplate',
  'runJsonlPersistenceSafeguard',
] as const

describe('server.ts wires the JSONL-persistence safeguard', () => {
  test('passes the restart module\'s live shutdown query to the per-persona safeguard', () => {
    const args = splitTopLevel(onlyCallArguments(SERVER_CODE, 'runJsonlPersistenceSafeguard'))
    expect(args).toHaveLength(3)
    const safeguard = objectProperties(args[2]!)
    const restartArgs = splitTopLevel(onlyCallArguments(SERVER_CODE, 'initRestart'))
    const restart = objectProperties(restartArgs[0]!)
    const query = safeguard.get('isShuttingDown')
    expect(query).toMatch(/^\(\) => \w+$/)
    expect(query).toBe(restart.get('isShuttingDown'))
  })

  test('imports runJsonlPersistenceSafeguard from the safeguard module', () => {
    // The import regex subsumes a bare `toContain` name check.
    expect(SERVER_SRC).toMatch(
      /import\s*\{[^}]*runJsonlPersistenceSafeguard[^}]*\}\s*from\s*['"]\.\/jsonl-persistence-check\.ts['"]/,
    )
  })

  test('calls the safeguard in main() BEFORE the start bring-up (the resume/wipe path)', () => {
    const safeguardIdx = SERVER_CODE.indexOf('runJsonlPersistenceSafeguard(')
    // safeguardIdx > -1 proves the call exists (subsumes a separate "is called"
    // test); startBringUpAt() anchors the ordering on the bring-up request in
    // main(); safeguard must precede resume.
    expect(safeguardIdx).toBeGreaterThan(mainBody(SERVER_CODE)[0])
    expect(safeguardIdx).toBeLessThan(startBringUpAt())
  })
})

describe('server.ts runs every start-time pass over the applied personas (b.av2 SR-6.2)', () => {
  test.each(['runJsonlPersistenceSafeguard'])(
    'every %s call comes BEFORE the start bring-up (`<controller>.runStartBringUp()` in main())',
    (pass) => {
      const passCalls = callsOf(pass)
      const bringUp = startBringUpAt()
      expect(passCalls.length).toBeGreaterThan(0)
      for (const p of passCalls) expect(p).toBeLessThan(bringUp)
    },
  )

  test.each([...START_PASSES])(
    'every %s call comes AFTER the start resolution sets the applied config (`<loaded> = <outcome>.config`)',
    (pass) => {
      const { assignAt } = startResolution(SERVER_CODE)
      const passCalls = callsOf(pass)
      expect(passCalls.length).toBeGreaterThan(0)
      for (const p of passCalls) expect(p).toBeGreaterThan(assignAt)
    },
  )

  test.each([...START_PASSES])(
    '%s takes exactly the loaded persona config',
    (pass) => {
      const loaded = loadedConfigName(SERVER_CODE)
      const args = firstArgsOf(pass)
      expect(args.length).toBeGreaterThan(0)
      for (const arg of args) expect(arg).toBe(loaded)
    },
  )
})

test('AD owns pre-trust: server installs no native trust writer', () => {
  expect(SERVER_CODE).not.toMatch(/\b(?:trustBootstrap|trustPatchPersona|setPreLaunchTrustPatcher)\b/)
})

describe('server.ts removes legacy hooks without installing a pre-launch hook', () => {
  test('cleans the loaded personas before bring-up', () => {
    const loaded = loadedConfigName(SERVER_CODE)
    const calls = callsOf('removeLegacyReplyHooks').filter(at => splitTopLevel(callArguments(SERVER_CODE, at))[0]?.startsWith(`${loaded}.personas.map(`))
    expect(calls).toHaveLength(1)
    expect(splitTopLevel(callArguments(SERVER_CODE, calls[0]!))).toEqual([`${loaded}.personas.map(persona => persona.claude_config_dir)`])
    expect(calls[0]).toBeLessThan(startBringUpAt())
    expect(SERVER_CODE).not.toMatch(/\b(?:setPreLaunchReplyGuard|preLaunchReplyGuard|stopHookBootstrap)\s*\(/)
  })

  test('prepares the system prompt and retries legacy-hook cleanup before launches', () => {
    expect(() => onlyCallArguments(SERVER_CODE, 'setSystemPromptPreparer')).not.toThrow()
    expect(SERVER_CODE).toContain('removeLegacyReplyHooks([persona.claude_config_dir])')
    expect(SERVER_CODE).toContain("prepareSystemPrompt('server-start')")
  })
})
