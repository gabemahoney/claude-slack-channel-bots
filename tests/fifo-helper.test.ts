/**
 * fifo-helper.test.ts — the shared FIFO helper (tests/test-helpers/fifo.ts)
 * with no `mkfifo` on `PATH`: `mkfifoAvailable()` is false and `makeFifo`
 * throws a `HostSafetyError` (`toolNotFound`), creating nothing.
 *
 * Isolation: the case runs in a child `bun` process whose environment is a
 * direct `hostSafeChildEnv` call with no tool (so its `PATH` finds nothing),
 * its HOME and `TMPDIR` directories under this file's `mkdtempSync` root
 * (removed in `afterEach`). No FIFO is made or opened.
 *
 * SPDX-License-Identifier: MIT
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { EMPTY_CHILD_PATH, HOST_SAFETY_REFUSAL, hostSafeChildEnv } from './test-helpers/host-safe-env.ts'
import { FIFO_HOME_PREFIX } from './test-helpers/fifo.ts'

const FIFO_HELPER_PATH = join(import.meta.dir, 'test-helpers', 'fifo.ts')
const HOST_SAFE_ENV_PATH = join(import.meta.dir, 'test-helpers', 'host-safe-env.ts')

let root: string

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'fifo-helper-test-')))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('fifo helper with no mkfifo on PATH', () => {
  test('mkfifoAvailable() is false, and makeFifo throws toolNotFound creating nothing (in a child bun whose PATH finds nothing)', () => {
    const home = join(root, 'child-home')
    const childTmp = join(root, 'child-tmp')
    mkdirSync(home)
    mkdirSync(childTmp)
    const target = join(root, 'never.fifo')
    const script = `
      const { mkfifoAvailable, makeFifo } = await import(${JSON.stringify(FIFO_HELPER_PATH)})
      const { HostSafetyError } = await import(${JSON.stringify(HOST_SAFE_ENV_PATH)})
      let makeError = null
      try { makeFifo(${JSON.stringify(target)}) } catch (err) { makeError = { isHostSafetyError: err instanceof HostSafetyError, reason: err.reason ?? null } }
      console.log(JSON.stringify({ path: process.env.PATH, available: mkfifoAvailable(), makeError }))
    `
    const child = spawnSync(process.execPath, ['-e', script], {
      env: hostSafeChildEnv(home, { tools: [], extras: { TMPDIR: childTmp } }),
      encoding: 'utf-8',
      timeout: 10_000,
    })

    expect(child.signal).toBeNull()
    expect(child.status).toBe(0)
    const result = JSON.parse(child.stdout.trim()) as {
      path: string
      available: boolean
      makeError: { isHostSafetyError: boolean; reason: string | null } | null
    }
    expect(result.path).toBe(EMPTY_CHILD_PATH)
    expect(result.available).toBe(false)
    expect(result.makeError).toEqual({ isHostSafetyError: true, reason: HOST_SAFETY_REFUSAL.toolNotFound })
    expect(existsSync(target)).toBe(false)
    expect(readdirSync(childTmp).filter((name) => name.startsWith(FIFO_HOME_PREFIX))).toEqual([])
  })
})
