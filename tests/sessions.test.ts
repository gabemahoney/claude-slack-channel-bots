import { describe, test, expect, afterEach } from 'bun:test'
import { writeFileSync, readFileSync, mkdtempSync, existsSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { readSessions, writeSessions, rotateSessions, type SessionRecord, type SessionsMap } from '../src/sessions.ts'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSessionRecord(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    tmuxSession: 'claude:0',
    lastLaunch: '2024-01-01T00:00:00.000Z',
    ...overrides,
  }
}

function makeSessionsMap(overrides: Partial<SessionsMap> = {}): SessionsMap {
  return {
    C_GENERAL: makeSessionRecord(),
    ...overrides,
  }
}

let tempDir: string | undefined

afterEach(() => {
  if (tempDir) {
    rmSync(tempDir, { recursive: true, force: true })
    tempDir = undefined
  }
})

// ---------------------------------------------------------------------------
// readSessions()
// ---------------------------------------------------------------------------

describe('readSessions', () => {
  test('returns {} for a missing file path', () => {
    const result = readSessions('/tmp/this-path-does-not-exist-sessions-test-12345.json')
    expect(result).toEqual({})
  })

  test('returns {} for corrupt JSON', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'sessions-test-'))
    const badPath = join(tempDir, 'sessions.json')
    writeFileSync(badPath, '{ this is not valid json !!!', 'utf-8')
    expect(readSessions(badPath)).toEqual({})
  })

  test('returns parsed map for a valid file', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'sessions-test-'))
    const sessionsPath = join(tempDir, 'sessions.json')
    const sessions = makeSessionsMap()
    writeFileSync(sessionsPath, JSON.stringify(sessions), 'utf-8')
    expect(readSessions(sessionsPath)).toEqual(sessions)
  })

  test('preserves tmuxSession field', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'sessions-test-'))
    const sessionsPath = join(tempDir, 'sessions.json')
    const sessions: SessionsMap = {
      C_GENERAL: makeSessionRecord({ tmuxSession: 'main:1' }),
    }
    writeFileSync(sessionsPath, JSON.stringify(sessions), 'utf-8')
    const result = readSessions(sessionsPath)
    expect(result['C_GENERAL'].tmuxSession).toBe('main:1')
  })

  test('preserves lastLaunch field', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'sessions-test-'))
    const sessionsPath = join(tempDir, 'sessions.json')
    const sessions: SessionsMap = {
      C_GENERAL: makeSessionRecord({ lastLaunch: '2024-06-15T12:00:00.000Z' }),
    }
    writeFileSync(sessionsPath, JSON.stringify(sessions), 'utf-8')
    const result = readSessions(sessionsPath)
    expect(result['C_GENERAL'].lastLaunch).toBe('2024-06-15T12:00:00.000Z')
  })
})

// ---------------------------------------------------------------------------
// writeSessions()
// ---------------------------------------------------------------------------

describe('writeSessions', () => {
  test('written file is valid JSON matching the input', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'sessions-test-'))
    const sessionsPath = join(tempDir, 'sessions.json')
    const sessions = makeSessionsMap()
    writeSessions(sessions, sessionsPath)
    const raw = readFileSync(sessionsPath, 'utf-8')
    expect(JSON.parse(raw)).toEqual(sessions)
  })

  test('round-trip write then read returns original data', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'sessions-test-'))
    const sessionsPath = join(tempDir, 'sessions.json')
    const sessions = makeSessionsMap()
    writeSessions(sessions, sessionsPath)
    expect(readSessions(sessionsPath)).toEqual(sessions)
  })

  test('no .tmp file remains after successful write', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'sessions-test-'))
    const sessionsPath = join(tempDir, 'sessions.json')
    writeSessions(makeSessionsMap(), sessionsPath)
    expect(existsSync(sessionsPath + '.tmp')).toBe(false)
  })

  test('overwriting existing file preserves only new data', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'sessions-test-'))
    const sessionsPath = join(tempDir, 'sessions.json')
    const first: SessionsMap = {
      C_GENERAL: makeSessionRecord({ tmuxSession: 'first:0' }),
    }
    const second: SessionsMap = {
      C_DEV: makeSessionRecord({ tmuxSession: 'second:1' }),
    }
    writeSessions(first, sessionsPath)
    writeSessions(second, sessionsPath)
    const result = readSessions(sessionsPath)
    expect(result).toEqual(second)
    expect(result['C_GENERAL']).toBeUndefined()
  })

  test('writing empty map produces valid empty JSON object', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'sessions-test-'))
    const sessionsPath = join(tempDir, 'sessions.json')
    writeSessions({}, sessionsPath)
    expect(readSessions(sessionsPath)).toEqual({})
  })
})

// ---------------------------------------------------------------------------
// rotateSessions()
// ---------------------------------------------------------------------------

describe('rotateSessions', () => {
  test('renames sessions.json to sessions.json.last when file exists', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'sessions-test-'))
    const sessionsPath = join(tempDir, 'sessions.json')
    writeFileSync(sessionsPath, JSON.stringify(makeSessionsMap()), 'utf-8')
    rotateSessions(sessionsPath)
    expect(existsSync(sessionsPath)).toBe(false)
    expect(existsSync(sessionsPath + '.last')).toBe(true)
  })

  test('sessions.json.last has the original content after rotation', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'sessions-test-'))
    const sessionsPath = join(tempDir, 'sessions.json')
    const sessions = makeSessionsMap({ C_GENERAL: makeSessionRecord({ tmuxSession: 'rotate:0' }) })
    writeFileSync(sessionsPath, JSON.stringify(sessions), 'utf-8')
    rotateSessions(sessionsPath)
    const rotated = JSON.parse(readFileSync(sessionsPath + '.last', 'utf-8'))
    expect(rotated).toEqual(sessions)
  })

  test('is a no-op when sessions.json does not exist', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'sessions-test-'))
    const sessionsPath = join(tempDir, 'sessions.json')
    expect(() => rotateSessions(sessionsPath)).not.toThrow()
  })

  test('preserves existing .last file when sessions.json does not exist', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'sessions-test-'))
    const sessionsPath = join(tempDir, 'sessions.json')
    const lastSessions = makeSessionsMap({ C_OLD: makeSessionRecord({ tmuxSession: 'old:0' }) })
    writeFileSync(sessionsPath + '.last', JSON.stringify(lastSessions), 'utf-8')
    rotateSessions(sessionsPath)
    const preserved = JSON.parse(readFileSync(sessionsPath + '.last', 'utf-8'))
    expect(preserved).toEqual(lastSessions)
  })

  test('accepts a custom path parameter', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'sessions-test-'))
    const customPath = join(tempDir, 'custom-sessions.json')
    const sessions = makeSessionsMap()
    writeFileSync(customPath, JSON.stringify(sessions), 'utf-8')
    rotateSessions(customPath)
    expect(existsSync(customPath)).toBe(false)
    expect(existsSync(customPath + '.last')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Crash recovery
// ---------------------------------------------------------------------------

describe('rotateSessions — crash recovery (T25)', () => {
  test('T25: server crash before rotation — sessions.json renamed to .last, original content preserved', () => {
    // Scenario: server had a valid sessions.json from a previous cycle.
    // When rotateSessions() runs (e.g. on next startup), sessions.json must be
    // renamed to sessions.json.last and the original file must no longer exist.
    tempDir = mkdtempSync(join(tmpdir(), 'sessions-test-'))
    const sessionsPath = join(tempDir, 'sessions.json')
    const sessions = makeSessionsMap({
      C_GENERAL: makeSessionRecord({ tmuxSession: 'crash:0' }),
    })
    writeFileSync(sessionsPath, JSON.stringify(sessions), 'utf-8')

    rotateSessions(sessionsPath)

    // sessions.json must no longer exist after rotation
    expect(existsSync(sessionsPath)).toBe(false)

    // sessions.json.last must exist and contain the original data
    expect(existsSync(sessionsPath + '.last')).toBe(true)
    const rotated = JSON.parse(readFileSync(sessionsPath + '.last', 'utf-8'))
    expect(rotated).toEqual(sessions)
  })

  test('T25: .last content matches original sessions.json byte-for-byte (parsed)', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'sessions-test-'))
    const sessionsPath = join(tempDir, 'sessions.json')
    const sessions: SessionsMap = {
      C_GENERAL: makeSessionRecord({ tmuxSession: 'main:0' }),
      C_DEV: makeSessionRecord({ tmuxSession: 'dev:1' }),
    }
    writeFileSync(sessionsPath, JSON.stringify(sessions), 'utf-8')

    rotateSessions(sessionsPath)

    const last = JSON.parse(readFileSync(sessionsPath + '.last', 'utf-8')) as SessionsMap
    expect(last['C_GENERAL'].tmuxSession).toBe('main:0')
    expect(last['C_DEV'].tmuxSession).toBe('dev:1')
  })
})

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe('readSessions edge cases', () => {
  test('stale .tmp file alongside valid main file does not corrupt read', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'sessions-test-'))
    const sessionsPath = join(tempDir, 'sessions.json')
    const sessions = makeSessionsMap()
    writeFileSync(sessionsPath, JSON.stringify(sessions), 'utf-8')
    writeFileSync(sessionsPath + '.tmp', '{ "stale": true }', 'utf-8')
    expect(readSessions(sessionsPath)).toEqual(sessions)
  })

  test('returns {} when only .tmp file exists (not the main file)', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'sessions-test-'))
    const sessionsPath = join(tempDir, 'sessions.json')
    writeFileSync(sessionsPath + '.tmp', JSON.stringify(makeSessionsMap()), 'utf-8')
    expect(readSessions(sessionsPath)).toEqual({})
  })
})
