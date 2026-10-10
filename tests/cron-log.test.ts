/**
 * cron-log.test.ts — Tests for the dedicated cron-fire log writer
 * (src/cron-log.ts). Covers the pure formatters (five-field layout, all nine
 * outcome classes, detail tokens, newline escaping) and the I/O half
 * (createCronLog: append accumulation, unwritable-path resilience, self-heal,
 * whole-line rapid appends) and the `cron_log_max_bytes` cap (b.p4i, E5): the
 * pure cut (`cronLogPruneOffset`) and the prune after each append — oldest
 * whole lines dropped, the newest always kept, no prune with the key absent, a
 * failed rewrite losing no line, a symlinked log path kept a symlink, a log
 * path moved away or removed while the log is open followed by the cap.
 *
 * Isolation: every test gets a fresh mkdtempSync temp dir (rmSync recursive
 * force in afterEach), matching tests/pid.test.ts. No live cron log, crontable,
 * config, or path outside the temp dir is touched. console.error is spied by
 * reassignment (no mock.module — the pretest gate forbids top-level use). The
 * prune's rewrite is observed or failed through `createCronLog`'s `write` seam.
 *
 * SPDX-License-Identifier: MIT
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { DurableWriteUnsyncedError, durableWriteFileSync } from '../src/atomic-write.ts'
import {
  createCronLog,
  cronLogPruneOffset,
  formatOutcomeLine,
  formatSummaryLine,
  formatInfoLine,
  formatWarnLine,
  type CronLog,
  type CronLogWriter,
  type CronOutcome,
  type CronLogRecord,
  type CronLogDetail,
} from '../src/cron-log.ts'
import { personaKey } from '../src/persona-identity.ts'

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
    target: 'planner',
    outcome: 'delivered',
    ...overrides,
  }
}

/** Build a CronLogDetail with optional overrides. */
function makeDetail(overrides: Partial<CronLogDetail> = {}): CronLogDetail {
  return { ...overrides }
}

/** Split a formatted line into [ts, identity, target, outcome, detail...]. */
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

/** The fire record of schedule `sched-<i>`; its detail text varies, so line lengths vary too. */
function fireRecord(i: number): CronLogRecord {
  return makeRecord({ identity: `sched-${i}`, detail: makeDetail({ text: 'x'.repeat(i % 7) }) })
}

/** The physical (newline-terminated) line the writer puts down for `fireRecord(i)`. */
function fireLine(i: number): string {
  return `${formatOutcomeLine(fireRecord(i))}\n`
}

/** Append fires `from` … `from + count - 1` through `log`; returns their physical lines, oldest first. */
function appendFires(log: CronLog, count: number, from = 0): string[] {
  const lines: string[] = []
  for (let i = from; i < from + count; i++) {
    log.outcome(fireRecord(i))
    lines.push(fireLine(i))
  }
  return lines
}

/**
 * What a prune to `cap` must leave of `lines` (each newline-terminated, oldest
 * first): the longest run of the NEWEST whole lines that fits in `cap` bytes,
 * and never less than the newest line (E5). Built independently of the code
 * under test, as the oracle the pure and I/O cases compare with.
 */
function newestWithin(lines: readonly string[], cap: number): string {
  let kept = lines[lines.length - 1]!
  for (let i = lines.length - 2; i >= 0; i--) {
    const longer = lines[i]! + kept
    if (Buffer.byteLength(longer) > cap) break
    kept = longer
  }
  return kept
}

/** A `write` seam that records each rewrite's byte count, then does the real durable rewrite. */
function recordingWriter(): { write: CronLogWriter; rewrites: number[] } {
  const rewrites: number[] = []
  return {
    rewrites,
    write: (path, bytes) => {
      rewrites.push(bytes.length)
      durableWriteFileSync(path, bytes)
    },
  }
}

const OUTCOME_CLASSES = [
  'delivered',
  'no-session',
  'unknown-persona',
  'prompt-missing',
  'prompt-unreadable',
  'prompt-oversize',
  'parse-error',
  'http-error',
  'fanout-deferred',
] as const satisfies readonly CronOutcome[]

/**
 * Compile-time guard (`bun run typecheck`): the list above names every member
 * of the CronOutcome union; `satisfies` above rejects any non-member.
 */
const COVERS_UNION: [Exclude<CronOutcome, (typeof OUTCOME_CLASSES)[number]>] extends [never] ? true : false = true

const ALL_OUTCOMES: CronOutcome[] = [...OUTCOME_CLASSES]

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
    expect(f[2]).toBe('planner')
    expect(f[3]).toBe('delivered')
    // Detail is the remaining (fifth) field, possibly multi-token free text.
    expect(f.slice(4).join(' ')).toBe('hello world')
  })

  test('positional identity/target tokens do not shift outcome position', () => {
    // Whitespace in a positional token collapses to _, preserving field index.
    const line = formatOutcomeLine(
      makeRecord({ identity: 'my schedule', target: 'Ops Bot' }),
    )
    const f = fields(line)
    expect(f[1]).toBe('my_schedule')
    expect(f[2]).toBe('Ops_Bot')
    expect(f[3]).toBe('delivered')
  })

  test.each([
    ['a hashed persona key', personaKey('Ops Bot')],
    ['a persona name', 'Planner'],
  ])('%s written as the target comes out unchanged in field 3', (_label, target) => {
    const f = fields(formatOutcomeLine(makeRecord({ target, outcome: 'unknown-persona' })))
    expect(f[2]).toBe(target)
    expect(f[3]).toBe('unknown-persona')
  })

  test('absent identity/target render as the "-" sentinel', () => {
    const line = formatOutcomeLine(makeRecord({ identity: '-', target: '-' }))
    const f = fields(line)
    expect(f[1]).toBe('-')
    expect(f[2]).toBe('-')
  })

  test('an empty positional token collapses to the "-" sentinel', () => {
    // sanitizeToken maps '' to the ABSENT sentinel (src/cron-log.ts:130-131).
    // (A whitespace-only run collapses to a single '_' via the \s+ replace, not
    // to the sentinel — only a truly-empty value hits the ABSENT branch.)
    const line = formatOutcomeLine(makeRecord({ identity: '', target: '   ' }))
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
  test('the list is the CronOutcome union: nine distinct classes', () => {
    expect(COVERS_UNION).toBe(true)
    expect(new Set(ALL_OUTCOMES).size).toBe(9)
  })

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
// Pre-fan-out failures record "-" as the target
// ---------------------------------------------------------------------------

describe('pre-fan-out failures', () => {
  test.each<[CronOutcome]>([
    ['parse-error'],
    ['prompt-missing'],
    ['fanout-deferred'],
  ])('outcome=%s with no target records "-" in the target field', (outcome) => {
    const log = createCronLog(logPath)
    log.outcome(makeRecord({ target: '-', outcome }))
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
// Warn line
// ---------------------------------------------------------------------------

describe('formatWarnLine', () => {
  test('renders in the five-field layout with warn in the outcome position', () => {
    const line = formatWarnLine(TS, 'crontable vanished, keeping last known schedules')
    const f = fields(line)
    expect(f[0]).toBe(TS)
    expect(f[1]).toBe('-')
    expect(f[2]).toBe('-')
    expect(f[3]).toBe('warn')
    expect(f.slice(4).join(' ')).toBe('crontable vanished, keeping last known schedules')
  })

  test('supplied identity/target occupy their positional fields', () => {
    const f = fields(formatWarnLine(TS, 'stat failed', 'daily-standup', 'planner'))
    expect(f[1]).toBe('daily-standup')
    expect(f[2]).toBe('planner')
    expect(f[3]).toBe('warn')
  })

  test('whitespace in identity/target collapses so warn keeps field position', () => {
    const f = fields(formatWarnLine(TS, 'stat failed', 'my schedule', 'Ops Bot'))
    expect(f[1]).toBe('my_schedule')
    expect(f[2]).toBe('Ops_Bot')
    expect(f[3]).toBe('warn')
  })

  test('newlines in the text are escaped so the record stays one line', () => {
    const line = formatWarnLine(TS, 'first\r\nsecond')
    expect(line).toContain('\\r\\n')
    expect(line).not.toContain('\n')
  })

  test('grep warn matches warn lines exactly — no other line kind contains it', () => {
    const others = [
      ...ALL_OUTCOMES.map((outcome) => formatOutcomeLine(makeRecord({ outcome }))),
      formatSummaryLine(TS, 'daily-standup', 1, 0),
      formatInfoLine(TS, 'scheduler started, 4 schedules loaded'),
    ]
    for (const line of others) expect(line).not.toContain('warn')
    expect(formatWarnLine(TS, 'vanished')).toContain('warn')
  })

  test('grep unknown-persona matches unknown-persona lines exactly — no other line kind contains it', () => {
    const others = [
      ...ALL_OUTCOMES.filter((o) => o !== 'unknown-persona').map((outcome) => formatOutcomeLine(makeRecord({ outcome }))),
      formatSummaryLine(TS, 'daily-standup', 1, 0),
      formatInfoLine(TS, 'scheduler started, 4 schedules loaded'),
      formatWarnLine(TS, 'vanished'),
    ]
    for (const line of others) expect(line).not.toContain('unknown-persona')
    expect(formatOutcomeLine(makeRecord({ outcome: 'unknown-persona' }))).toContain('unknown-persona')
  })
})

describe('warn() through the writer handle', () => {
  test('appends a warn line alongside the other kinds without truncating them', () => {
    const log = createCronLog(logPath)
    log.outcome(makeRecord())
    log.warn(TS, 'crontable vanished', 'daily-standup', 'planner')

    const lines = readLines()
    expect(lines).toHaveLength(2)
    const f = fields(lines[1])
    expect(f[1]).toBe('daily-standup')
    expect(f[2]).toBe('planner')
    expect(f[3]).toBe('warn')
    expect(f.slice(4).join(' ')).toBe('crontable vanished')
  })

  test('omitted identity/target are written as the "-" sentinel', () => {
    const log = createCronLog(logPath)
    log.warn(TS, 'stat failed')
    const f = fields(readLines()[0])
    expect(f[1]).toBe('-')
    expect(f[2]).toBe('-')
    expect(f[3]).toBe('warn')
  })

  test('a failed warn append falls back to one [slack] cron-log console.error', () => {
    const { badPath } = makeFileParentObstruction('warnfail')
    const log = createCronLog(badPath)
    expect(() => log.warn(TS, 'vanished', 'boom')).not.toThrow()
    expect(errorCalls).toHaveLength(1)
    expect(errorCalls[0]).toContain('[slack] cron-log')
    expect(errorCalls[0]).toContain('identity=boom')
    expect(errorCalls[0]).toContain('outcome=warn')
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

// ---------------------------------------------------------------------------
// cron_log_max_bytes — the pure cut (b.p4i, E5)
// ---------------------------------------------------------------------------

describe('cronLogPruneOffset — where a prune cuts the log', () => {
  /** The text a prune of `text` to `cap` keeps: everything from the offset on. */
  function kept(text: string, cap: number): string {
    const bytes = new TextEncoder().encode(text)
    return new TextDecoder().decode(bytes.subarray(cronLogPruneOffset(bytes, cap)))
  }

  test.each<[string, string, number, string]>([
    ['a log exactly at the cap is left whole', 'aa\nbb\n', 6, 'aa\nbb\n'],
    ['one byte over the cap drops the oldest line', 'aa\nbb\n', 5, 'bb\n'],
    ['a single line over the cap is left whole (nothing to rewrite)', 'abcdef\n', 3, 'abcdef\n'],
    ['cap 1 keeps only the newest of several lines', 'a\nbb\nccc\n', 1, 'ccc\n'],
    ['cap 1 on a one-line log keeps that line', 'a\n', 1, 'a\n'],
    ['a newest line larger than the cap is kept alone, never cut', 'aaaa\nbbbbbbbb\n', 4, 'bbbbbbbb\n'],
    // 'éé\n' is 5 bytes but 3 characters: a cap counted in characters would keep all 5 characters.
    ['the cap counts bytes, and the cut lands only after a newline', 'éé\nx\n', 5, 'x\n'],
  ])('%s', (_label, text, cap, expected) => {
    expect(kept(text, cap)).toBe(expected)
  })

  test('at every cap, the cut keeps the longest run of newest whole lines that fits, never less than the newest line', () => {
    const lines = ['first line\n', 'b\n', 'the third line\n', 'dd\n', 'the newest line\n']
    const text = lines.join('')
    for (let cap = 1; cap <= Buffer.byteLength(text) + 1; cap++) {
      expect([cap, kept(text, cap)]).toEqual([cap, newestWithin(lines, cap)])
    }
  })
})

// ---------------------------------------------------------------------------
// cron_log_max_bytes — the prune after each append (b.p4i, E5)
// ---------------------------------------------------------------------------

describe('cron_log_max_bytes — whole-line pruning of the log', () => {
  const CAP = 1024

  /**
   * Append fires `from` … `from + count - 1` through `log`, checking after each
   * one that the file at the log path is within `cap`; returns their lines.
   */
  function appendWithinCap(log: CronLog, cap: number, count: number, from: number): string[] {
    const lines: string[] = []
    for (let i = from; i < from + count; i++) {
      lines.push(...appendFires(log, 1, i))
      expect(statSync(logPath).size).toBeLessThanOrEqual(cap)
    }
    return lines
  }

  /**
   * A log holding fires 0–3 under a cap of exactly their size: nothing pruned
   * yet, so its fd is still open, and the next append takes the file past the cap.
   */
  function openLogAtCap(): { log: CronLog; cap: number; before: string[] } {
    const before = Array.from({ length: 4 }, (_, i) => fireLine(i))
    const cap = Buffer.byteLength(before.join(''))
    const log = createCronLog(logPath, { maxBytes: cap })
    appendFires(log, before.length)
    return { log, cap, before }
  }

  test('REGRESSION (b.p4i): with a 1 KB cap, appends past it leave the file within the cap — oldest whole lines gone, newest intact, no partial head', () => {
    const log = createCronLog(logPath, { maxBytes: CAP })
    const written = appendWithinCap(log, CAP, 60, 0)
    expect(Buffer.byteLength(written.join(''))).toBeGreaterThan(2 * CAP)
    // Exactly the newest whole lines that fit: the head is a whole line, the
    // oldest are gone, the last line is the one just written, and no more was
    // dropped than the cap needs.
    expect(readFileSync(logPath, 'utf-8')).toBe(newestWithin(written, CAP))
    expect(readLines()).not.toContain(formatOutcomeLine(fireRecord(0)))
    expect(readLines().at(-1)).toBe(formatOutcomeLine(fireRecord(59)))
  })

  test('with the key absent, the same appends grow the file past the cap untouched and never rewrite it', () => {
    const { write, rewrites } = recordingWriter()
    // The server passes `maxBytes: undefined` when the key is absent.
    const log = createCronLog(logPath, { maxBytes: undefined, write })
    const written = appendFires(log, 60)
    expect(statSync(logPath).size).toBeGreaterThan(2 * CAP)
    expect(readFileSync(logPath, 'utf-8')).toBe(written.join(''))
    expect(rewrites).toEqual([])
  })

  test('a log already past the cap when the key is set is pruned at the first append', () => {
    const older = Array.from({ length: 60 }, (_, i) => fireLine(i))
    writeFileSync(logPath, older.join(''))
    const log = createCronLog(logPath, { maxBytes: CAP })
    const newest = appendFires(log, 1, 60)
    expect(readFileSync(logPath, 'utf-8')).toBe(newestWithin([...older, ...newest], CAP))
  })

  test('a cap smaller than one line keeps only the newest line, with one rewrite per later append and none for the first', () => {
    const { write, rewrites } = recordingWriter()
    const log = createCronLog(logPath, { maxBytes: 1, write })
    const written: string[] = []
    for (let i = 0; i < 5; i++) {
      written.push(...appendFires(log, 1, i))
      expect(readFileSync(logPath, 'utf-8')).toBe(written[i]!)
    }
    // The first append leaves the newest line as the whole file: nothing to
    // rewrite. Each later one rewrites the file to its own line, once.
    expect(rewrites).toEqual(written.slice(1).map((line) => Buffer.byteLength(line)))
  })

  test('a failed prune rewrite loses no line, never throws and logs one prune-failed line; the next append prunes', () => {
    let failing = true
    const write: CronLogWriter = (path, bytes) => {
      if (failing) throw Object.assign(new Error('no space left on device'), { code: 'ENOSPC' })
      durableWriteFileSync(path, bytes)
    }
    // The second append takes the file one byte over the cap.
    const cap = Buffer.byteLength(fireLine(0) + fireLine(1)) - 1
    const log = createCronLog(logPath, { maxBytes: cap, write })
    const written = appendFires(log, 1)
    expect(() => written.push(...appendFires(log, 1, 1))).not.toThrow()

    expect(readFileSync(logPath, 'utf-8')).toBe(written.join(''))
    expect(errorCalls).toEqual([
      '[slack] cron-log: prune failed identity=sched-1 outcome=delivered — the line is written, the log is not pruned: Error code=ENOSPC message="no space left on device"',
    ])

    failing = false
    written.push(...appendFires(log, 1, 2))
    expect(readFileSync(logPath, 'utf-8')).toBe(newestWithin(written, cap))
    expect(errorCalls).toHaveLength(1)
  })

  test('a rewrite that renamed but could not sync its directory counts as done: no error line, and later lines land in the pruned log', () => {
    const write: CronLogWriter = (path, bytes) => {
      durableWriteFileSync(path, bytes)
      throw new DurableWriteUnsyncedError(path, Object.assign(new Error('i/o error'), { code: 'EIO' }))
    }
    const log = createCronLog(logPath, { maxBytes: 200, write })
    const written = appendFires(log, 10)
    expect(readFileSync(logPath, 'utf-8')).toBe(newestWithin(written, 200))
    expect(errorCalls).toEqual([])
  })

  test('a symlinked cron_log_path stays a symlink after a prune, and its target holds the pruned log', () => {
    const realDir = join(tempDir, 'real')
    mkdirSync(realDir)
    const realPath = join(realDir, 'cron.log')
    writeFileSync(realPath, '')
    symlinkSync(realPath, logPath)

    const log = createCronLog(logPath, { maxBytes: 200 })
    const written = appendFires(log, 10)

    expect(lstatSync(logPath).isSymbolicLink()).toBe(true)
    expect(readlinkSync(logPath)).toBe(realPath)
    expect(readFileSync(realPath, 'utf-8')).toBe(newestWithin(written, 200))
    // The rewrite's temporary file was made beside the target and is gone.
    expect(readdirSync(realDir)).toEqual(['cron.log'])
  })

  test('REGRESSION (b.p4i): a log path replaced while the log is open (moved away, an empty file made in its place) — the moved file stops growing, later lines land at the path within the cap, no error line', () => {
    const { log, cap, before } = openLogAtCap()
    const movedPath = join(tempDir, 'cron.log.1')
    renameSync(logPath, movedPath)
    writeFileSync(logPath, '')

    // The open fd still names the moved file: the next line lands there and
    // takes it past the cap. The path names another file, so the fd is
    // dropped instead of the path being pruned, and later appends reopen it.
    const intoMoved = appendFires(log, 1, before.length)
    const intoPath = appendWithinCap(log, cap, 20, before.length + 1)

    expect(readFileSync(movedPath, 'utf-8')).toBe([...before, ...intoMoved].join(''))
    expect(readFileSync(logPath, 'utf-8')).toBe(newestWithin(intoPath, cap))
    expect(errorCalls).toEqual([])
  })

  test('REGRESSION (b.p4i): a log path removed while the log is open — a later append recreates it, the cap holds, no error line', () => {
    const { log, cap, before } = openLogAtCap()
    rmSync(logPath)

    // The open fd still names the removed file: the next line lands there and
    // takes it past the cap. The path is gone, which is no prune failure: the
    // fd is dropped, and the append after it recreates the path.
    appendFires(log, 1, before.length)
    const intoPath = appendWithinCap(log, cap, 20, before.length + 1)

    expect(readFileSync(logPath, 'utf-8')).toBe(newestWithin(intoPath, cap))
    expect(errorCalls).toEqual([])
  })
})
