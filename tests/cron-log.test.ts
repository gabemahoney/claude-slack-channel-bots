/**
 * cron-log.test.ts — Tests for the dedicated cron-fire log writer
 * (src/cron-log.ts). Covers the pure formatters (five-field layout, all nine
 * outcome classes, detail tokens, newline escaping) and the I/O half
 * (createCronLog: append accumulation, unwritable-path resilience, self-heal,
 * whole-line rapid appends).
 *
 * Isolation: every test gets a fresh mkdtempSync temp dir (rmSync recursive
 * force in afterEach), matching tests/pid.test.ts. No live cron log, crontable,
 * config, or path outside the temp dir is touched. console.error is spied by
 * reassignment (no mock.module — the pretest gate forbids top-level use).
 *
 * SPDX-License-Identifier: MIT
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  createCronLog,
  formatOutcomeLine,
  formatSummaryLine,
  formatInfoLine,
  type CronOutcome,
  type CronLogRecord,
  type CronLogDetail,
} from '../src/cron-log.ts'

// ---------------------------------------------------------------------------
// Test isolation
// ---------------------------------------------------------------------------

let tempDir: string
let logPath: string

/** Capture array for the spied console.error. */
let errorCalls: string[]
let orig_console_error: typeof console.error

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'cron-log-test-'))
  logPath = join(tempDir, 'cron.log')

  errorCalls = []
  orig_console_error = console.error
  console.error = (...args: unknown[]) => {
    errorCalls.push(args.map(String).join(' '))
  }
})

afterEach(() => {
  console.error = orig_console_error
  rmSync(tempDir, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// Fixture factories
// ---------------------------------------------------------------------------

const TS = '2026-09-20T12:00:00.000Z'

/** Build a CronLogRecord with sensible defaults and optional overrides. */
function makeRecord(overrides: Partial<CronLogRecord> = {}): CronLogRecord {
  return {
    timestamp: TS,
    identity: 'daily-standup',
    channel: 'C0123',
    outcome: 'delivered',
    ...overrides,
  }
}

/** Build a CronLogDetail with optional overrides. */
function makeDetail(overrides: Partial<CronLogDetail> = {}): CronLogDetail {
  return { ...overrides }
}

/** Split a formatted line into [ts, identity, channel, outcome, detail...]. */
function fields(line: string): string[] {
  return line.split(' ')
}

/** Read the log file and return its physical, newline-terminated lines. */
function readLines(): string[] {
  const raw = readFileSync(logPath, 'utf-8')
  // A well-formed file ends in \n; drop the trailing empty element.
  const parts = raw.split('\n')
  if (parts[parts.length - 1] === '') parts.pop()
  return parts
}

/** Count newline-terminated physical lines in the file. */
function countNewlines(): number {
  return readFileSync(logPath, 'utf-8').split('\n').length - 1
}

/**
 * Build a log path whose parent is a plain file (so mkdir of the parent, and
 * thus the append, cannot succeed). Returns both the obstructing file path and
 * the unwritable log path under it. `name` keeps parallel tests isolated.
 */
function makeFileParentObstruction(name: string): { fileParent: string; badPath: string } {
  const fileParent = join(tempDir, name)
  writeFileSync(fileParent, 'x')
  return { fileParent, badPath: join(fileParent, 'cron.log') }
}

const ALL_OUTCOMES: CronOutcome[] = [
  'delivered',
  'no-session',
  'unknown-channel',
  'prompt-missing',
  'prompt-unreadable',
  'prompt-oversize',
  'parse-error',
  'http-error',
  'fanout-deferred',
]

// ---------------------------------------------------------------------------
// Pure formatting — five-field layout
// ---------------------------------------------------------------------------

describe('formatOutcomeLine — five-field layout', () => {
  test('carries all five fields with expected content', () => {
    const line = formatOutcomeLine(
      makeRecord({ detail: makeDetail({ text: 'hello world' }) }),
    )
    const f = fields(line)
    expect(f[0]).toBe(TS)
    expect(f[1]).toBe('daily-standup')
    expect(f[2]).toBe('C0123')
    expect(f[3]).toBe('delivered')
    // Detail is the remaining (fifth) field, possibly multi-token free text.
    expect(f.slice(4).join(' ')).toBe('hello world')
  })

  test('positional identity/channel tokens do not shift outcome position', () => {
    // Whitespace in a positional token collapses to _, preserving field index.
    const line = formatOutcomeLine(
      makeRecord({ identity: 'my schedule', channel: 'C 9' }),
    )
    const f = fields(line)
    expect(f[1]).toBe('my_schedule')
    expect(f[2]).toBe('C_9')
    expect(f[3]).toBe('delivered')
  })

  test('absent identity/channel render as the "-" sentinel', () => {
    const line = formatOutcomeLine(makeRecord({ identity: '-', channel: '-' }))
    const f = fields(line)
    expect(f[1]).toBe('-')
    expect(f[2]).toBe('-')
  })

  test('an empty positional token collapses to the "-" sentinel', () => {
    // sanitizeToken maps '' to the ABSENT sentinel (src/cron-log.ts:130-131).
    // (A whitespace-only run collapses to a single '_' via the \s+ replace, not
    // to the sentinel — only a truly-empty value hits the ABSENT branch.)
    const line = formatOutcomeLine(makeRecord({ identity: '', channel: '   ' }))
    const f = fields(line)
    expect(f[1]).toBe('-')
    expect(f[2]).toBe('_')
    expect(f[3]).toBe('delivered')
  })

  test('record with no detail renders exactly four fields (no dangling space)', () => {
    const line = formatOutcomeLine(makeRecord({ detail: undefined }))
    expect(fields(line)).toHaveLength(4)
    expect(line.endsWith(' ')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Pure formatting — all nine outcome classes round-trip
// ---------------------------------------------------------------------------

describe('all nine outcome classes round-trip into the log', () => {
  test.each(ALL_OUTCOMES)('outcome=%s appears in field 4 of the written line', (outcome) => {
    const log = createCronLog(logPath)
    log.outcome(makeRecord({ outcome }))
    const lines = readLines()
    expect(lines).toHaveLength(1)
    expect(fields(lines[0])[3]).toBe(outcome)
  })
})

// ---------------------------------------------------------------------------
// Pure formatting — detail tokens
// ---------------------------------------------------------------------------

describe('detail key=value tokens', () => {
  test('carries the full prompt path in a prompt= token', () => {
    const promptPath = '/home/horde/.claude/channels/slack/prompts/daily.md'
    const line = formatOutcomeLine(
      makeRecord({ detail: makeDetail({ promptPath }) }),
    )
    expect(line).toContain(`prompt=${promptPath}`)
  })

  test.each<[CronOutcome, CronLogDetail, string]>([
    ['http-error', { status: 503 }, 'status=503'],
    ['prompt-unreadable', { errno: 'EACCES' }, 'errno=EACCES'],
    ['parse-error', { line: 7 }, 'line=7'],
  ])('outcome=%s records the %o token %s', (outcome, detailOverrides, token) => {
    const line = formatOutcomeLine(
      makeRecord({ outcome, detail: makeDetail(detailOverrides) }),
    )
    const detail = fields(line).slice(4)
    expect(detail).toContain(token)
  })

  test('multiple detail tokens render in fixed order before free text', () => {
    const line = formatOutcomeLine(
      makeRecord({
        outcome: 'http-error',
        detail: makeDetail({
          promptPath: '/p/a.md',
          status: 500,
          errno: 'ETIMEDOUT',
          line: 3,
          text: 'gave up',
        }),
      }),
    )
    const detail = fields(line).slice(4).join(' ')
    expect(detail).toBe('prompt=/p/a.md status=500 errno=ETIMEDOUT line=3 gave up')
  })
})

// ---------------------------------------------------------------------------
// Pre-fan-out failures record "-" as the target channel
// ---------------------------------------------------------------------------

describe('pre-fan-out failures', () => {
  test.each<[CronOutcome]>([
    ['parse-error'],
    ['prompt-missing'],
    ['fanout-deferred'],
  ])('outcome=%s with no target records "-" in the channel field', (outcome) => {
    const log = createCronLog(logPath)
    log.outcome(makeRecord({ channel: '-', outcome }))
    const f = fields(readLines()[0])
    expect(f[2]).toBe('-')
    expect(f[3]).toBe(outcome)
  })
})

// ---------------------------------------------------------------------------
// Summary line
// ---------------------------------------------------------------------------

describe('formatSummaryLine', () => {
  test('shares the five-field layout with summary in the outcome position', () => {
    const line = formatSummaryLine(TS, 'daily-standup', 2, 1)
    const f = fields(line)
    expect(f[0]).toBe(TS)
    expect(f[1]).toBe('daily-standup')
    expect(f[2]).toBe('-')
    expect(f[3]).toBe('summary')
  })

  // The module does no counting — it formats caller-supplied numbers — so a
  // single formatter test covers both count combinations.
  test.each<[number, number, string]>([
    [2, 2, 'delivered=2 failed=2'],
    [0, 3, 'delivered=0 failed=3'],
  ])('formats delivered=%d failed=%d into the detail field', (delivered, failed, expected) => {
    const line = formatSummaryLine(TS, 'daily-standup', delivered, failed)
    const detail = fields(line).slice(4).join(' ')
    expect(detail).toBe(expected)
  })
})

// ---------------------------------------------------------------------------
// Info line
// ---------------------------------------------------------------------------

describe('formatInfoLine', () => {
  test('renders in the five-field layout with info in the outcome position', () => {
    const line = formatInfoLine(TS, 'scheduler started, 4 schedules loaded')
    const f = fields(line)
    expect(f[0]).toBe(TS)
    expect(f[1]).toBe('-')
    expect(f[2]).toBe('-')
    expect(f[3]).toBe('info')
    expect(f.slice(4).join(' ')).toBe('scheduler started, 4 schedules loaded')
  })

  test('info() append writes an info line to the file', () => {
    const log = createCronLog(logPath)
    log.info(TS, 'scheduler started, 0 schedules loaded')
    const f = fields(readLines()[0])
    expect(f[3]).toBe('info')
  })
})

// ---------------------------------------------------------------------------
// Newline-escape invariant — one record is always one physical line
// ---------------------------------------------------------------------------

describe('newline-escape invariant', () => {
  test('embedded \\n in a detail value produces exactly one physical line', () => {
    const log = createCronLog(logPath)
    log.outcome(makeRecord({ detail: makeDetail({ text: 'line one\nline two\nline three' }) }))
    expect(countNewlines()).toBe(1)
    // The \n is escaped, not literal — the escaped form survives on the line.
    expect(readLines()[0]).toContain('\\n')
  })

  test('CRLF (\\r\\n) in a detail value produces exactly one physical line', () => {
    const log = createCronLog(logPath)
    log.outcome(makeRecord({ detail: makeDetail({ text: 'a\r\nb' }) }))
    expect(countNewlines()).toBe(1)
    const only = readLines()[0]
    expect(only).toContain('\\r\\n')
  })

  test('newline embedded in the prompt path also collapses to one line', () => {
    const log = createCronLog(logPath)
    log.outcome(makeRecord({ detail: makeDetail({ promptPath: '/p/a\nb.md' }) }))
    expect(countNewlines()).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// Append accumulation — no truncation
// ---------------------------------------------------------------------------

describe('append accumulation', () => {
  test('later appends preserve earlier lines (no truncation)', () => {
    const log = createCronLog(logPath)
    log.outcome(makeRecord({ identity: 'first', outcome: 'delivered' }))
    log.outcome(makeRecord({ identity: 'second', outcome: 'no-session' }))
    log.summary(TS, 'first', 1, 1)

    const lines = readLines()
    expect(lines).toHaveLength(3)
    expect(fields(lines[0])[1]).toBe('first')
    expect(fields(lines[1])[1]).toBe('second')
    expect(fields(lines[2])[3]).toBe('summary')
  })

  test('a second writer handle on the same path appends rather than truncates', () => {
    createCronLog(logPath).outcome(makeRecord({ identity: 'a' }))
    createCronLog(logPath).outcome(makeRecord({ identity: 'b' }))
    expect(readLines()).toHaveLength(2)
  })

  test('mkdir parent is created lazily on first append', () => {
    const nested = join(tempDir, 'a', 'b', 'cron.log')
    const log = createCronLog(nested)
    log.outcome(makeRecord())
    expect(existsSync(nested)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Unwritable path — never throws, exactly one console.error per failed append
// ---------------------------------------------------------------------------

describe('unwritable path resilience', () => {
  test('a directory as the file path does not throw into the caller', () => {
    // The path itself is a directory → openSync('a') fails.
    const dirAsPath = join(tempDir, 'iamadir')
    mkdirSync(dirAsPath)
    const log = createCronLog(dirAsPath)
    expect(() => log.outcome(makeRecord())).not.toThrow()
  })

  test('a parent that is a file (cannot be mkdir-ed) does not throw', () => {
    const { badPath } = makeFileParentObstruction('afile')
    const log = createCronLog(badPath)
    expect(() => log.outcome(makeRecord())).not.toThrow()
  })

  test('emits exactly one console.error per failed append', () => {
    const { badPath } = makeFileParentObstruction('afile2')
    const log = createCronLog(badPath)
    log.outcome(makeRecord())
    log.outcome(makeRecord())
    expect(errorCalls).toHaveLength(2)
  })

  test('failure log line is [slack] cron-log-prefixed and carries identity+outcome', () => {
    const { badPath } = makeFileParentObstruction('afile3')
    const log = createCronLog(badPath)
    log.outcome(makeRecord({ identity: 'boom', outcome: 'http-error' }))
    expect(errorCalls).toHaveLength(1)
    const msg = errorCalls[0]
    expect(msg).toContain('[slack] cron-log')
    expect(msg).toContain('identity=boom')
    expect(msg).toContain('outcome=http-error')
  })
})

// ---------------------------------------------------------------------------
// Self-heal — next append after failure succeeds once the path is writable
// ---------------------------------------------------------------------------

describe('self-heal after a failed append', () => {
  test('next append succeeds after the parent-file obstruction is removed', () => {
    const { fileParent, badPath } = makeFileParentObstruction('heal')
    const log = createCronLog(badPath)

    // First append fails (parent is a file).
    log.outcome(makeRecord({ identity: 'pre-heal' }))
    expect(errorCalls).toHaveLength(1)
    expect(existsSync(badPath)).toBe(false)

    // Remove the obstruction so the parent dir can be created.
    rmSync(fileParent)
    log.outcome(makeRecord({ identity: 'post-heal' }))

    // No new error, and the post-heal line is now on disk.
    expect(errorCalls).toHaveLength(1)
    const lines = readFileSync(badPath, 'utf-8').split('\n').filter((l) => l !== '')
    expect(lines).toHaveLength(1)
    expect(lines[0].split(' ')[1]).toBe('post-heal')
  })
})

// ---------------------------------------------------------------------------
// Rapid sequential appends — whole newline-terminated lines, no fragments
// ---------------------------------------------------------------------------

describe('rapid sequential appends', () => {
  test('100 appends yield 100 whole newline-terminated lines', () => {
    const log = createCronLog(logPath)
    const N = 100
    for (let i = 0; i < N; i++) {
      log.outcome(makeRecord({ identity: `sched-${i}`, outcome: 'delivered' }))
    }
    expect(countNewlines()).toBe(N)
    const lines = readLines()
    expect(lines).toHaveLength(N)
    // Every line is well-formed: five-plus fields, correct outcome token.
    for (let i = 0; i < N; i++) {
      const f = fields(lines[i])
      expect(f[1]).toBe(`sched-${i}`)
      expect(f[3]).toBe('delivered')
    }
  })
})
