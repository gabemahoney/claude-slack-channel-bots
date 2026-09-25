/**
 * bot-hook-absoluteness.test.ts — SR-8.2 verification of an AD property.
 *
 * AD writes a per-spawn Claude settings file under CLAUDE_CONFIG_DIR
 * containing hook command lines that drive Claude Code's permission relay.
 * For CSCB-managed spawns, the property under test is that every emitted
 * hook command's first argv token is an absolute path resolving OUTSIDE
 * the CSCB checkout root. This is a property of AD's spawn-time emission,
 * NOT a CSCB enforcement — CSCB does not post-process or rewrite hook
 * lines. The test guards against an AD regression that would silently
 * point bots' hooks at relative or in-checkout paths.
 *
 * Never runs in the unit suite, and says so: a unit test never spawns a real
 * Claude process (director decision), and agent-director refuses the
 * `--print` claude arg the spawn passes (`ErrSpawnDeniedFlag`) before any
 * instance exists. The case is skipped by `test.skipIf` with the reason in
 * its name, so it shows as skipped, never as a vacuous pass; docker and live
 * runs cover the property. When enabled, a missing agent-director or a failed
 * spawn fails the case.
 *
 * SPDX-License-Identifier: MIT
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { Client, resolveSystemBinary } from 'agent-director'

import { personaInstanceId, personaLabels } from '../src/persona-identity.ts'

/**
 * Whether this file may spawn a real instance: never in the unit suite (a unit
 * test never spawns a real Claude process). Decided here, at module scope, so
 * the skip is visible in the case list and nothing below spawns.
 */
const REAL_SPAWN_ALLOWED: boolean = false
const SKIP_REASON = 'needs a real agent-director spawn; covered by docker/live runs'

const CSCB_CHECKOUT_ROOT = resolve(import.meta.dirname, '..')
// One temp root per run holds both the isolated CLAUDE_CONFIG_DIR and the
// agent-director store, so the test never opens or creates the real
// ~/.agent-director/state.db (b.av2 SR-13.2) and cleans up in one rmSync.
// Created only when the spawn is allowed.
const TEST_ROOT = REAL_SPAWN_ALLOWED ? mkdtempSync(join(tmpdir(), 'cscb-hook-abs-')) : ''
const TEST_CONFIG_DIR = join(TEST_ROOT, 'claude-config')
const TEST_STORE_PATH = join(TEST_ROOT, 'agent-director', 'state.db')
// Persona-shaped fixture (b.av2 SR-2.2): instance ID `cscb_<key>` and the
// `service=cscb` / `persona=<key>` / `config_dir=<hash>` labels CSCB spawns
// with, built through the same helpers. The key is unique per run.
const TEST_PERSONA_KEY = `hook_abs_${Date.now()}_${process.pid}`
const TEST_INSTANCE_ID = personaInstanceId(TEST_PERSONA_KEY)
const TEST_LABELS = personaLabels(TEST_PERSONA_KEY, TEST_CONFIG_DIR, TEST_ROOT)

let client: Client | null = null
let spawnSucceeded = false
let spawnFailure = ''

beforeAll(async () => {
  if (!REAL_SPAWN_ALLOWED) return

  try {
    await resolveSystemBinary()
  } catch (err) {
    spawnFailure = `agent-director unavailable on host: ${(err as Error).message}`
    return
  }

  // Isolated CLAUDE_CONFIG_DIR so AD's settings writes don't touch ~/.claude
  mkdirSync(TEST_CONFIG_DIR, { recursive: true })

  try {
    mkdirSync(join(TEST_ROOT, 'agent-director'), { recursive: true })
    client = await Client.create({
      storePath: TEST_STORE_PATH,
      createIfMissing: true,
    })
  } catch (err) {
    spawnFailure = `Client.create failed: ${(err as Error).message}`
    return
  }

  try {
    await client.spawn({
      claude_instance_id: TEST_INSTANCE_ID,
      cwd: '/tmp',
      label: TEST_LABELS,
      relay_mode: 'on',
      claude_args: ['--print', 'noop'],
      extra_env: { CLAUDE_CONFIG_DIR: TEST_CONFIG_DIR },
    })
    spawnSucceeded = true
  } catch (err) {
    spawnFailure = `spawn failed: ${(err as Error).message}`
  }
})

afterAll(async () => {
  if (client && spawnSucceeded) {
    try {
      await client.kill({ claude_instance_id: TEST_INSTANCE_ID })
    } catch { /* best-effort */ }
    try {
      await client.delete({ claude_instance_id: [TEST_INSTANCE_ID] })
    } catch { /* best-effort */ }
  }
  if (client) {
    try { client.close() } catch { /* close is no-op on failure */ }
  }
  if (TEST_ROOT !== '' && existsSync(TEST_ROOT)) {
    try { rmSync(TEST_ROOT, { recursive: true, force: true }) } catch { /* best-effort */ }
  }
})

/**
 * Recursively find every `settings.json` under the test CLAUDE_CONFIG_DIR.
 * AD writes per-spawn settings; their exact path is an AD implementation
 * detail (typically `<CLAUDE_CONFIG_DIR>/settings.json` or a nested layout).
 */
function findSettingsFiles(dir: string): string[] {
  if (!existsSync(dir)) return []
  const results: string[] = []
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    const st = statSync(full)
    if (st.isDirectory()) {
      results.push(...findSettingsFiles(full))
    } else if (name === 'settings.json') {
      results.push(full)
    }
  }
  return results
}

/**
 * Walk a parsed settings.json structure and return every hook command line.
 * Claude Code's settings.json carries hooks at `hooks.<EventName>[].hooks[].command`;
 * the test tolerates a variety of shapes (string, object with `command`).
 */
function extractHookCommands(settings: unknown): string[] {
  const commands: string[] = []
  const visit = (node: unknown): void => {
    if (node === null || node === undefined) return
    if (typeof node === 'string') return
    if (Array.isArray(node)) {
      for (const item of node) visit(item)
      return
    }
    if (typeof node === 'object') {
      const obj = node as Record<string, unknown>
      if (typeof obj.command === 'string') {
        commands.push(obj.command)
      }
      for (const v of Object.values(obj)) visit(v)
    }
  }
  if (typeof settings === 'object' && settings !== null) {
    const root = settings as Record<string, unknown>
    visit(root.hooks ?? root)
  }
  return commands
}

/**
 * Pull the first argv token from a hook command line. Splits on whitespace
 * and returns the first non-empty token. The contract is the literal first
 * token, not a resolved symlink target.
 */
function firstArgvToken(command: string): string {
  const parts = command.trim().split(/\s+/)
  return parts[0] ?? ''
}

describe('SR-8.2: bot-hook absoluteness', () => {
  test.skipIf(!REAL_SPAWN_ALLOWED)(`every emitted hook command starts with an absolute path outside the CSCB checkout (skipped: ${SKIP_REASON})`, () => {
    if (!spawnSucceeded) throw new Error(`no instance to inspect: ${spawnFailure || 'spawn not attempted'}`)

    const settingsFiles = findSettingsFiles(TEST_CONFIG_DIR)
    expect(settingsFiles.length).toBeGreaterThan(0)

    let totalHooks = 0
    for (const path of settingsFiles) {
      const settings = JSON.parse(readFileSync(path, 'utf-8'))
      const commands = extractHookCommands(settings)
      for (const cmd of commands) {
        totalHooks += 1
        const token = firstArgvToken(cmd)
        // (a) Absolute path.
        expect(token.startsWith('/')).toBe(true)
        // (b) Outside the CSCB checkout root.
        const normalized = resolve(token)
        expect(normalized.startsWith(CSCB_CHECKOUT_ROOT)).toBe(false)
      }
    }

    // Defensive: if AD didn't emit any hooks, the property assertion above is
    // vacuously true. Surface that explicitly so a regression to "no hooks
    // emitted at all" doesn't pass as green.
    expect(totalHooks).toBeGreaterThan(0)
  })
})
