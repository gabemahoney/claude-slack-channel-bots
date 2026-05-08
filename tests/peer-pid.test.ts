/**
 * peer-pid.test.ts — Tests for getPeerPidByPort and getSessionIdForPid.
 *
 * SPDX-License-Identifier: MIT
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { writeFileSync, mkdirSync, mkdtempSync, rmSync, existsSync } from 'fs'
import { homedir, tmpdir } from 'os'
import { join } from 'path'
import { getPeerPidByPort, getSessionIdForPid } from '../src/peer-pid.ts'

// ---------------------------------------------------------------------------
// Bun.spawn stub — replace before each test, restore after
// ---------------------------------------------------------------------------

let origBunSpawn: typeof Bun.spawn

beforeEach(() => {
  origBunSpawn = Bun.spawn
})

afterEach(() => {
  Bun.spawn = origBunSpawn
})

/** Replace Bun.spawn with a stub that returns a fake subprocess whose stdout yields `output`. */
function stubSpawnOutput(output: string): void {
  const encoder = new TextEncoder()
  ;(Bun as any).spawn = (_cmd: string[], _opts?: unknown) => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(output))
        controller.close()
      },
    })
    return { stdout: stream }
  }
}

/** Replace Bun.spawn with a stub that throws immediately. */
function stubSpawnThrows(err: Error): void {
  ;(Bun as any).spawn = () => {
    throw err
  }
}

// ---------------------------------------------------------------------------
// Sample ss -tnp output lines
// ---------------------------------------------------------------------------

/** Client side: local=127.0.0.1:54321 (peerPort), peer=127.0.0.1:8080 (serverPort), pid=12345 */
const IPV4_LINE =
  'ESTAB      0      0      127.0.0.1:54321         127.0.0.1:8080          users:(("claude",pid=12345,fd=7))'

/** Client side, IPv6: local=[::1]:54321, peer=[::1]:8080, pid=67890 */
const IPV6_LINE =
  'ESTAB      0      0      [::1]:54321              [::1]:8080               users:(("claude",pid=67890,fd=5))'

/** Server side of the same connection — must NOT match (local=serverPort). */
const SERVER_SIDE_LINE =
  'ESTAB      0      0      127.0.0.1:8080          127.0.0.1:54321         users:(("bun",pid=99999,fd=20))'

/** Line with the right peerPort in local but a different remote port (9090 instead of 8080). */
const WRONG_SERVER_PORT_LINE =
  'ESTAB      0      0      127.0.0.1:54321         127.0.0.1:9090          users:(("bun",pid=11111,fd=3))'

/** Client-side line missing the pid= field in the users section. */
const NO_PID_LINE =
  'ESTAB      0      0      127.0.0.1:54321         127.0.0.1:8080          users:(("claude",fd=7))'

// ---------------------------------------------------------------------------
// getPeerPidByPort
// ---------------------------------------------------------------------------

describe('getPeerPidByPort', () => {
  test('returns PID from ss output with IPv4 loopback address (127.0.0.1)', async () => {
    stubSpawnOutput(IPV4_LINE + '\n')
    const pid = await getPeerPidByPort(54321, 8080)
    expect(pid).toBe(12345)
  })

  test('returns PID from ss output with IPv6 loopback address (::1)', async () => {
    stubSpawnOutput(IPV6_LINE + '\n')
    const pid = await getPeerPidByPort(54321, 8080)
    expect(pid).toBe(67890)
  })

  test('returns null when ss output has no line matching the port pair', async () => {
    stubSpawnOutput(WRONG_SERVER_PORT_LINE + '\n')
    const pid = await getPeerPidByPort(54321, 8080)
    expect(pid).toBeNull()
  })

  test('returns null when ss command spawn throws', async () => {
    stubSpawnThrows(new Error('ENOENT: ss not found'))
    const pid = await getPeerPidByPort(54321, 8080)
    expect(pid).toBeNull()
  })

  test('returns null when matching line has no pid= field', async () => {
    stubSpawnOutput(NO_PID_LINE + '\n')
    const pid = await getPeerPidByPort(54321, 8080)
    expect(pid).toBeNull()
  })

  test('rejects the server-side line (local=serverPort) and only matches the client side', async () => {
    stubSpawnOutput(SERVER_SIDE_LINE + '\n')
    const pid = await getPeerPidByPort(54321, 8080)
    expect(pid).toBeNull()
  })

  test('returns the client-side PID when both sides of the loopback pair are present', async () => {
    stubSpawnOutput(SERVER_SIDE_LINE + '\n' + IPV4_LINE + '\n')
    const pid = await getPeerPidByPort(54321, 8080)
    expect(pid).toBe(12345)
  })
})

// ---------------------------------------------------------------------------
// getSessionIdForPid — helpers
// ---------------------------------------------------------------------------

const SESSIONS_DIR = join(homedir(), '.claude', 'sessions')

/** PIDs well above the Linux max (4,194,304) so they never collide with real entries. */
const TEST_PID_BASE = 9_900_000

let testPid: number
let filesToCleanup: string[]

beforeEach(() => {
  testPid = TEST_PID_BASE + Math.floor(Math.random() * 99_999)
  filesToCleanup = []
  mkdirSync(SESSIONS_DIR, { recursive: true })
})

afterEach(() => {
  for (const f of filesToCleanup) {
    if (existsSync(f)) rmSync(f)
  }
})

function writeSessionFile(pid: number, content: string): void {
  const path = join(SESSIONS_DIR, `${pid}.json`)
  writeFileSync(path, content, 'utf-8')
  filesToCleanup.push(path)
}

// ---------------------------------------------------------------------------
// getSessionIdForPid
// ---------------------------------------------------------------------------

describe('getSessionIdForPid', () => {
  test('returns sessionId from a valid PID file', async () => {
    writeSessionFile(testPid, JSON.stringify({ sessionId: 'abc-123-test-session' }))
    const result = await getSessionIdForPid(testPid)
    expect(result).toBe('abc-123-test-session')
  })

  test('returns null when PID file does not exist', async () => {
    // No file created — the PID is guaranteed not to have a session file.
    const result = await getSessionIdForPid(TEST_PID_BASE + 99_998)
    expect(result).toBeNull()
  })

  test('returns null when file contains invalid JSON', async () => {
    writeSessionFile(testPid, '{ not valid json !!!')
    const result = await getSessionIdForPid(testPid)
    expect(result).toBeNull()
  })

  test('returns null when JSON is valid but lacks sessionId field', async () => {
    writeSessionFile(testPid, JSON.stringify({ other: 'data' }))
    const result = await getSessionIdForPid(testPid)
    expect(result).toBeNull()
  })

  test('returns null when sessionId is not a string', async () => {
    writeSessionFile(testPid, JSON.stringify({ sessionId: 42 }))
    const result = await getSessionIdForPid(testPid)
    expect(result).toBeNull()
  })

  test('reads from a custom claudeConfigDir when provided', async () => {
    const customDir = mkdtempSync(join(tmpdir(), 'peer-pid-customdir-'))
    const customSessionsDir = join(customDir, 'sessions')
    mkdirSync(customSessionsDir, { recursive: true })
    const customPid = TEST_PID_BASE + 50_000
    const customFile = join(customSessionsDir, `${customPid}.json`)
    writeFileSync(customFile, JSON.stringify({ sessionId: 'from-custom-dir' }), 'utf-8')

    try {
      // Default lookup (no override) should miss
      const defaultResult = await getSessionIdForPid(customPid)
      expect(defaultResult).toBeNull()

      // Override should hit
      const overrideResult = await getSessionIdForPid(customPid, customDir)
      expect(overrideResult).toBe('from-custom-dir')
    } finally {
      rmSync(customDir, { recursive: true, force: true })
    }
  })

  test('returns null when claudeConfigDir override has no matching file', async () => {
    const customDir = mkdtempSync(join(tmpdir(), 'peer-pid-customdir-'))
    try {
      const result = await getSessionIdForPid(TEST_PID_BASE + 50_001, customDir)
      expect(result).toBeNull()
    } finally {
      rmSync(customDir, { recursive: true, force: true })
    }
  })
})
