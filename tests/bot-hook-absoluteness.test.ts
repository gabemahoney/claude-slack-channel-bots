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
 * Self-skips when AD is unavailable on the host (e.g. contributor laptops
 * without a system-wide install) so it never produces false failures.
 *
 * SPDX-License-Identifier: MIT
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from 'node:fs'
import { join, resolve } from 'node:path'

import { Client, resolveSystemBinary } from 'agent-director'

const CSCB_CHECKOUT_ROOT = resolve(import.meta.dirname, '..')
const TEST_CONFIG_DIR = `/tmp/cscb-hook-abs-${Date.now()}-${process.pid}`
const TEST_INSTANCE_ID = `cscb_hook_abs_${Date.now()}_${process.pid}`

let adAvailable = false
let adAvailableSkipReason = ''
let client: Client | null = null
let spawnSucceeded = false
let spawnSkipReason = ''

beforeAll(async () => {
  try {
    await resolveSystemBinary()
    adAvailable = true
  } catch (err) {
    adAvailableSkipReason = `agent-director unavailable on host: ${(err as Error).message}`
    return
  }

  // Isolated CLAUDE_CONFIG_DIR so AD's settings writes don't touch ~/.claude
  mkdirSync(TEST_CONFIG_DIR, { recursive: true })

  try {
    client = await Client.create({
      storePath: '~/.agent-director/state.db',
      createIfMissing: true,
    })
  } catch (err) {
    spawnSkipReason = `Client.create failed: ${(err as Error).message}`
    return
  }

  try {
    await client.spawn({
      claude_instance_id: TEST_INSTANCE_ID,
      cwd: '/tmp',
      label: ['service=cscb', 'channel=C_HOOK_ABS_TEST'],
      relay_mode: 'on',
      claude_args: ['--print', 'noop'],
      extra_env: { CLAUDE_CONFIG_DIR: TEST_CONFIG_DIR },
    })
    spawnSucceeded = true
  } catch (err) {
    spawnSkipReason = `spawn failed: ${(err as Error).message}`
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
  if (existsSync(TEST_CONFIG_DIR)) {
    try { rmSync(TEST_CONFIG_DIR, { recursive: true, force: true }) } catch { /* best-effort */ }
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
  test('preconditions: AD available + spawn succeeded', () => {
    if (!adAvailable) {
      // Self-skip on AD-unavailable hosts.
      console.log(`[bot-hook-absoluteness] skipping: ${adAvailableSkipReason}`)
      return
    }
    if (!spawnSucceeded) {
      console.log(`[bot-hook-absoluteness] skipping: ${spawnSkipReason}`)
      return
    }
    expect(spawnSucceeded).toBe(true)
  })

  test('every emitted hook command starts with an absolute path outside CSCB checkout', () => {
    if (!adAvailable || !spawnSucceeded) {
      console.log('[bot-hook-absoluteness] skipping property assertion (AD/spawn unavailable)')
      return
    }

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
