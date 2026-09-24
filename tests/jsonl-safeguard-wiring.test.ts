/**
 * jsonl-safeguard-wiring.test.ts — Static audit of the start-time passes in
 * src/server.ts (b.zak regression guard; b.av2 SR-6.2).
 *
 * The b.zak fix is a NEW module whose value is realised only if main() actually
 * invokes it BEFORE the resume path (startupSessionManager) that silently
 * deletes+fresh-spawns on ErrJsonlMissing. If the call is dropped or reordered,
 * the preventative warning never fires and every bot can lose memory silently —
 * exactly the 2026-09-20 incident.
 *
 * b.av2 SR-6.2 widens the audit to every start-time pass: the trust patch, the
 * Stop-hook bootstrap and the JSONL safeguard all run over the persona config
 * main() loaded (`loadStartPersonaConfig`) before the per-persona bring-up
 * (`startupSessionManager`, which brings each persona up and launches it; b.av2
 * SR-6.1), the agent-director template install covers the personas' config
 * dirs, and the session manager's pre-launch trust patcher is installed before
 * anything can launch (the persona Slack connections, Bun.serve, initRestart,
 * the per-persona bring-up).
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
import { indicesOf, loadedConfigName, stripComments } from './test-helpers/source-audit.ts'

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

/** Every start-time pass SR-6.2 requires to run over the applied personas. */
const START_PASSES = [
  'installSlackChannelBotTemplate',
  'trustBootstrap',
  'runJsonlPersistenceSafeguard',
  'stopHookBootstrap',
] as const

describe('server.ts wires the JSONL-persistence safeguard', () => {
  test('imports runJsonlPersistenceSafeguard from the safeguard module', () => {
    // The import regex subsumes a bare `toContain` name check.
    expect(SERVER_SRC).toMatch(
      /import\s*\{[^}]*runJsonlPersistenceSafeguard[^}]*\}\s*from\s*['"]\.\/jsonl-persistence-check\.ts['"]/,
    )
  })

  test('calls the safeguard BEFORE startupSessionManager (the resume/wipe path)', () => {
    const safeguardIdx = SERVER_CODE.indexOf('runJsonlPersistenceSafeguard(')
    const startupIdx = SERVER_CODE.indexOf('startupSessionManager(')
    // safeguardIdx > -1 proves the call exists (subsumes a separate "is called"
    // test); startupIdx > -1 anchors the ordering; safeguard must precede resume.
    expect(safeguardIdx).toBeGreaterThan(-1)
    expect(startupIdx).toBeGreaterThan(-1)
    expect(safeguardIdx).toBeLessThan(startupIdx)
  })
})

describe('server.ts runs every start-time pass over the applied personas (b.av2 SR-6.2)', () => {
  test.each(['trustBootstrap', 'stopHookBootstrap', 'runJsonlPersistenceSafeguard'])(
    'every %s call comes BEFORE startupSessionManager',
    (pass) => {
      const passCalls = callsOf(pass)
      const startupCalls = callsOf('startupSessionManager')
      expect(passCalls.length).toBeGreaterThan(0)
      expect(startupCalls.length).toBeGreaterThan(0)
      for (const p of passCalls) for (const s of startupCalls) expect(p).toBeLessThan(s)
    },
  )

  test.each([...START_PASSES, 'startupSessionManager'])(
    '%s takes exactly the loaded persona config',
    (pass) => {
      const loaded = loadedConfigName(SERVER_CODE)
      const args = firstArgsOf(pass)
      expect(args.length).toBeGreaterThan(0)
      for (const arg of args) expect(arg).toBe(loaded)
    },
  )
})

describe('server.ts installs the pre-launch trust patcher (b.av2 SR-6.2)', () => {
  /** The setter call carrying the single-persona trust patch. */
  const INSTALL = /\bsetPreLaunchTrustPatcher\s*\(\s*trustPatchPersona\b/g

  test('imports the setter from the session manager and the patch from trust-bootstrap', () => {
    expect(SERVER_CODE).toMatch(
      /import\s*\{[^}]*\bsetPreLaunchTrustPatcher\b[^}]*\}\s*from\s*['"]\.\/session-manager\.ts['"]/,
    )
    expect(SERVER_CODE).toMatch(
      /import\s*\{[^}]*\btrustPatchPersona\b[^}]*\}\s*from\s*['"]\.\/trust-bootstrap\.ts['"]/,
    )
  })

  test('installs trustPatchPersona as the pre-launch trust patcher', () => {
    expect(indicesOf(INSTALL, SERVER_CODE).length).toBeGreaterThan(0)
    // Every install carries the persona trust patch, never something else.
    const args = firstArgsOf('setPreLaunchTrustPatcher')
    expect(args.length).toBeGreaterThan(0)
    for (const arg of args) expect(arg).toBe('trustPatchPersona')
  })

  test.each([
    ['the template install', 'installSlackChannelBotTemplate'],
    ['the persona Slack connections', 'createPersonaConnectionManager'],
    ['Bun.serve', 'Bun\\.serve'],
    ['initRestart', 'initRestart'],
    ['startupSessionManager', 'startupSessionManager'],
  ])('installs the patcher BEFORE %s', (_label, anchor) => {
    const [install] = indicesOf(INSTALL, SERVER_CODE)
    expect(install).toBeDefined()
    expect(install!).toBeLessThan(firstCallOf(anchor))
  })
})
