/**
 * session-cleaner.test.ts — Tests for cozempic.ts session cleaning logic.
 *
 * SPDX-License-Identifier: MIT
 */

import { describe, test, expect, beforeEach, afterEach, mock, spyOn } from 'bun:test'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'fs'
import { tmpdir, homedir } from 'os'
import { join } from 'path'
import { EventEmitter } from 'events'

// ---------------------------------------------------------------------------
// Fake process helpers
// ---------------------------------------------------------------------------

function makeFakeProcess(exitCode: number, stderrLines: string[] = []) {
  const proc = new EventEmitter() as any
  proc.stdout = new EventEmitter()
  proc.stderr = new EventEmitter()
  setImmediate(() => {
    for (const line of stderrLines) proc.stderr.emit('data', Buffer.from(line + '\n'))
    proc.emit('close', exitCode)
  })
  return proc
}

function makeErrorProcess(errCode: string) {
  const proc = new EventEmitter() as any
  proc.stdout = new EventEmitter()
  proc.stderr = new EventEmitter()
  setImmediate(() => {
    const err = new Error(`spawn cozempic ENOENT`)
    ;(err as any).code = errCode
    proc.emit('error', err)
  })
  return proc
}

// ---------------------------------------------------------------------------
// Temp dir management
// ---------------------------------------------------------------------------

// We need JSONL files to land at the path that resolveJsonlPath produces.
// resolveJsonlPath(cwd, sessionId) → ${homedir()}/.claude/projects/${slug}/${sessionId}.jsonl
// where slug = cwd with non-[a-zA-Z0-9-] replaced by hyphens.
//
// Strategy: use a cwd whose slug we know, then create the file in the right place.

const FAKE_CWD = '/fake/cwd/test'
const FAKE_CWD_SLUG = '-fake-cwd-test'
const SESSION_ID = 'session-abc-123'

function expectedJsonlPath(sessionId: string = SESSION_ID): string {
  return join(homedir(), '.claude', 'projects', FAKE_CWD_SLUG, `${sessionId}.jsonl`)
}

function ensureJsonlDir(): void {
  const dir = join(homedir(), '.claude', 'projects', FAKE_CWD_SLUG)
  mkdirSync(dir, { recursive: true })
}

function writeJsonlFile(content: string, sessionId: string = SESSION_ID): string {
  ensureJsonlDir()
  const path = expectedJsonlPath(sessionId)
  writeFileSync(path, content)
  return path
}

function removeJsonlFile(sessionId: string = SESSION_ID): void {
  try {
    const path = expectedJsonlPath(sessionId)
    rmSync(path, { force: true })
  } catch { /* ignore */ }
}

// ---------------------------------------------------------------------------
// Spawn injection via mock.module
// ---------------------------------------------------------------------------

// spawnFactory holds the factory function used per-test. Each mock.module call
// replaces child_process.spawn with a function that delegates to spawnFactory.
let spawnFactory: (...args: any[]) => any = () => makeFakeProcess(0)

mock.module('child_process', () => ({
  spawn: (...args: any[]) => spawnFactory(...args),
}))

// Import cozempic AFTER mock.module so the mocked spawn is in scope.
const {
  cleanSession,
  _resetCozempicAvailable,
} = await import('../src/cozempic.ts')

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

let spawnCalls: Array<{ cmd: string; args: string[] }> = []
let consoleErrorSpy: ReturnType<typeof spyOn>

beforeEach(() => {
  _resetCozempicAvailable()
  spawnCalls = []
  spawnFactory = (...args: any[]) => makeFakeProcess(0)
  consoleErrorSpy = spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  consoleErrorSpy.mockRestore()
  removeJsonlFile()
})

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('cleanSession', () => {
  test('1. success — resolves when cozempic exits 0, logs before/after sizes', async () => {
    const content = 'some jsonl content\n'
    writeJsonlFile(content)

    spawnFactory = (cmd: string, args: string[]) => {
      spawnCalls.push({ cmd, args })
      return makeFakeProcess(0)
    }

    await expect(cleanSession(SESSION_ID, FAKE_CWD, 'standard')).resolves.toBeUndefined()

    expect(spawnCalls).toHaveLength(1)
    expect(spawnCalls[0].cmd).toBe('cozempic')
    expect(spawnCalls[0].args).toEqual(['treat', SESSION_ID, '-rx', 'standard', '--execute'])

    // before-size log appeared
    const loggedMessages: string[] = consoleErrorSpy.mock.calls.map((c: any[]) => c[0] as string)
    const hasBeforeLog = loggedMessages.some(
      (m) => m.includes('cleaning started') && m.includes(`session=${SESSION_ID}`) && m.includes('size=')
    )
    expect(hasBeforeLog).toBe(true)

    // after-size log appeared
    const hasAfterLog = loggedMessages.some(
      (m) => m.includes('cleaning done') && m.includes(`session=${SESSION_ID}`) && m.includes('size=')
    )
    expect(hasAfterLog).toBe(true)
  })

  test('2. non-zero exit — resolves without throwing, logs exit code', async () => {
    writeJsonlFile('some content\n')

    spawnFactory = (_cmd: string, _args: string[]) =>
      makeFakeProcess(1, ['something went wrong'])

    await expect(cleanSession(SESSION_ID, FAKE_CWD, 'standard')).resolves.toBeUndefined()

    const loggedMessages: string[] = consoleErrorSpy.mock.calls.map((c: any[]) => c[0] as string)
    const hasExitCodeLog = loggedMessages.some(
      (m) => m.includes('exit code 1') && m.includes(`session=${SESSION_ID}`)
    )
    expect(hasExitCodeLog).toBe(true)
  })

  test('3. missing binary (ENOENT) — resolves without throwing', async () => {
    writeJsonlFile('some content\n')

    spawnFactory = (_cmd: string, _args: string[]) => makeErrorProcess('ENOENT')

    await expect(cleanSession(SESSION_ID, FAKE_CWD, 'standard')).resolves.toBeUndefined()
  })

  test('4. missing JSONL file — returns early without spawning', async () => {
    // Ensure file does NOT exist
    removeJsonlFile()

    spawnFactory = (cmd: string, args: string[]) => {
      spawnCalls.push({ cmd, args })
      return makeFakeProcess(0)
    }

    await expect(cleanSession(SESSION_ID, FAKE_CWD, 'standard')).resolves.toBeUndefined()

    expect(spawnCalls).toHaveLength(0)
  })

  test('5. empty JSONL file (size 0) — returns early without spawning', async () => {
    writeJsonlFile('')  // 0 bytes

    spawnFactory = (cmd: string, args: string[]) => {
      spawnCalls.push({ cmd, args })
      return makeFakeProcess(0)
    }

    await expect(cleanSession(SESSION_ID, FAKE_CWD, 'standard')).resolves.toBeUndefined()

    expect(spawnCalls).toHaveLength(0)
  })
})
