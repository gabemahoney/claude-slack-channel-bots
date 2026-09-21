/**
 * crontable.test.ts — unit tests for the pure crontable parser.
 *
 * Pure module: string in, records out. No fs, no mocks, no test servers.
 * Assertions are plain input-string → output-record checks.
 */

import { describe, test, expect } from 'bun:test'
import {
  parseCrontable,
  type CronSchedule,
  type CronParseError,
  type CronParseErrorReason,
} from '../src/crontable.ts'

// ---------------------------------------------------------------------------
// Factories / helpers
// ---------------------------------------------------------------------------

/** Build a valid crontable data line from parts (sensible defaults). */
function makeLine(opts?: {
  expr?: string
  path?: string
  channels?: string
}): string {
  const expr = opts?.expr ?? '*/5 * * * *'
  const path = opts?.path ?? '~/prompts/grooming-tick.md'
  const parts = [expr, path]
  if (opts?.channels !== undefined) parts.push(opts.channels)
  return parts.join(' ')
}

/** Parse a single line and return its sole schedule (asserts exactly one). */
function onlySchedule(line: string): CronSchedule {
  const { schedules, errors } = parseCrontable(line)
  expect(errors).toEqual([])
  expect(schedules).toHaveLength(1)
  return schedules[0]!
}

/** Parse a single line and return its sole error (asserts exactly one). */
function onlyError(line: string): CronParseError {
  const { schedules, errors } = parseCrontable(line)
  expect(schedules).toEqual([])
  expect(errors).toHaveLength(1)
  return errors[0]!
}

// ---------------------------------------------------------------------------
// Valid lines
// ---------------------------------------------------------------------------

describe('valid lines', () => {
  test('produces a full schedule record with verbatim fields', () => {
    const line = makeLine({
      expr: '0 9 * * 1',
      path: '~/prompts/x.md',
      channels: 'C123,C456',
    })
    const s = onlySchedule(line)

    expect(s.identity).toBe('cscb-cron:x')
    expect(s.expression).toBe('0 9 * * 1')
    // Prompt path is kept literal — no tilde/relative expansion.
    expect(s.promptPath).toBe('~/prompts/x.md')
    expect(s.channels).toEqual({ kind: 'explicit', channelIds: ['C123', 'C456'] })
    // Raw line preserved verbatim (downstream at-most-once keys on it).
    expect(s.rawLine).toBe(line)
  })

  test('single explicit channel parses to a one-element list', () => {
    const s = onlySchedule(makeLine({ channels: 'C999' }))
    expect(s.channels).toEqual({ kind: 'explicit', channelIds: ['C999'] })
  })

  test('rawLine preserves surrounding/interior whitespace verbatim', () => {
    const raw = '  0 9 * * 1   ~/prompts/x.md   C1  '
    const { schedules } = parseCrontable(raw)
    expect(schedules).toHaveLength(1)
    expect(schedules[0]!.rawLine).toBe(raw)
    // Expression is normalized to single spaces regardless of input spacing.
    expect(schedules[0]!.expression).toBe('0 9 * * 1')
  })

  test('arbitrary/unknown channel IDs are accepted (no existence check)', () => {
    const s = onlySchedule(makeLine({ channels: 'not-a-real-channel,ZZZ,#nope' }))
    expect(s.channels).toEqual({
      kind: 'explicit',
      channelIds: ['not-a-real-channel', 'ZZZ', '#nope'],
    })
  })
})

// ---------------------------------------------------------------------------
// Omitted channel list → all-bots marker
// ---------------------------------------------------------------------------

describe('omitted channel list', () => {
  test('yields the all-bots marker, distinguishable from an empty explicit list', () => {
    const s = onlySchedule(makeLine({ channels: undefined }))
    expect(s.channels.kind).toBe('all-bots')
    // The marker is NOT an empty explicit list — an empty list is not representable.
    expect(s.channels).not.toEqual({ kind: 'explicit', channelIds: [] })
    expect(s.channels).toEqual({ kind: 'all-bots' })
  })
})

// ---------------------------------------------------------------------------
// Silently skipped lines (no schedule AND no error)
// ---------------------------------------------------------------------------

describe('silently skipped lines', () => {
  test.each([
    ['# a comment', 'hash comment'],
    ['   # indented comment', 'indented comment'],
    ['', 'empty line'],
    ['   ', 'whitespace-only line'],
    ['\t \t', 'tabs and spaces'],
  ])('skips %j (%s) with neither schedule nor error', (line) => {
    const { schedules, errors } = parseCrontable(line)
    expect(schedules).toEqual([])
    expect(errors).toEqual([])
  })

  test('comment/blank lines do not shift line numbers of real errors', () => {
    const text = ['# header', '', 'bogus line', '   ', makeLine()].join('\n')
    const { schedules, errors } = parseCrontable(text)
    expect(schedules).toHaveLength(1)
    expect(errors).toHaveLength(1)
    // 'bogus line' is the 3rd source line (1-based).
    expect(errors[0]!.lineNumber).toBe(3)
  })
})

// ---------------------------------------------------------------------------
// Bad-line classes — each yields a parse-error record; siblings survive.
// ---------------------------------------------------------------------------

describe('bad-line classes', () => {
  test.each<[string, CronParseErrorReason, string]>([
    ['zz * * * * ~/p.md', 'invalid-expression', 'non-numeric minute field (6 tokens)'],
    ['99 * * * * ~/p.md', 'invalid-expression', 'out-of-range minute (6 tokens)'],
    ['*/5 * * * *', 'missing-prompt-path', 'only 5 tokens, no prompt path'],
    ['not a cron here', 'missing-prompt-path', 'four garbage tokens, no path'],
    ['*/5 * * * * ~/a b.md C1', 'path-with-spaces', 'path with a space (8 tokens)'],
    ['*/5 * * * * ~/p.md C1,', 'malformed-channel-list', 'trailing comma'],
    ['*/5 * * * * ~/p.md C1,,C2', 'malformed-channel-list', 'double comma'],
    ['*/5 * * * * ~/p.md ,C1', 'malformed-channel-list', 'leading comma'],
    ['*/5 * * * * ~/p.md *', 'wildcard-channel-list', 'literal star channel'],
  ])('line %j → reason %s (%s)', (line, reason) => {
    const err = onlyError(line)
    expect(err.reason).toBe(reason)
    expect(err.rawLine).toBe(line)
    expect(err.lineNumber).toBe(1)
  })

  test('literal * in channel position is an error, NOT an all-bots schedule', () => {
    const { schedules, errors } = parseCrontable(makeLine({ channels: '*' }))
    expect(schedules).toEqual([])
    expect(errors).toHaveLength(1)
    expect(errors[0]!.reason).toBe('wildcard-channel-list')
  })

  // Positional 5-field contract: a 6-field croner-valid expression plus a path
  // is 7 tokens. The parser only reads tokens 1-5 as the expression, so the 6th
  // cron field is misread as the prompt path and the path becomes the channel
  // list — it does NOT silently accept the 6-field form as the schedule minute.
  test('6-field croner-valid expr + path is read positionally (5-field contract)', () => {
    // '0 0 1 1 1 1 ~/p.md' → expr='0 0 1 1 1', promptPath='1', channels='~/p.md'
    const s = onlySchedule('0 0 1 1 1 1 ~/p.md')
    expect(s.expression).toBe('0 0 1 1 1')
    expect(s.promptPath).toBe('1')
    expect(s.channels).toEqual({ kind: 'explicit', channelIds: ['~/p.md'] })
  })

  test('a wrong-field-count line where a path-looking token lands in field 5 is rejected', () => {
    // '* * * * ~/p.md C1' is 6 tokens: tokens 1-5 = '* * * * ~/p.md' — the path
    // token occupies cron field 5, so croner rejects the expression. This pins
    // the strict positional 5-field contract.
    const err = onlyError('* * * * ~/p.md C1')
    expect(err.reason).toBe('invalid-expression')
  })

  test('a bad line does not throw and lets sibling valid lines survive', () => {
    const good1 = makeLine({ path: '~/prompts/a.md' })
    const bad = '99 * * * * ~/prompts/b.md'
    const good2 = makeLine({ path: '~/prompts/c.md' })
    const text = [good1, bad, good2].join('\n')

    let result: ReturnType<typeof parseCrontable>
    expect(() => {
      result = parseCrontable(text)
    }).not.toThrow()

    expect(result!.schedules.map((s) => s.identity)).toEqual([
      'cscb-cron:a',
      'cscb-cron:c',
    ])
    expect(result!.errors).toHaveLength(1)
    expect(result!.errors[0]!.reason).toBe('invalid-expression')
    expect(result!.errors[0]!.lineNumber).toBe(2)
    expect(result!.errors[0]!.rawLine).toBe(bad)
  })

  test('multiple distinct bad-line classes coexist in one parse call', () => {
    const text = [
      'zz * * * * ~/p.md', // invalid-expression (line 1)
      '*/5 * * * *', // missing-prompt-path (line 2)
      '*/5 * * * * ~/p.md C1,,C2', // malformed-channel-list (line 3)
      '*/5 * * * * ~/p.md *', // wildcard-channel-list (line 4)
    ].join('\n')
    const { schedules, errors } = parseCrontable(text)
    expect(schedules).toEqual([])
    expect(errors.map((e) => [e.lineNumber, e.reason])).toEqual([
      [1, 'invalid-expression'],
      [2, 'missing-prompt-path'],
      [3, 'malformed-channel-list'],
      [4, 'wildcard-channel-list'],
    ])
  })
})

// ---------------------------------------------------------------------------
// Duplicates
// ---------------------------------------------------------------------------

describe('duplicate lines', () => {
  test('two identical lines both produce schedule records', () => {
    const line = makeLine()
    const { schedules, errors } = parseCrontable([line, line].join('\n'))
    expect(errors).toEqual([])
    expect(schedules).toHaveLength(2)
    expect(schedules[0]).toEqual(schedules[1]!)
  })
})

// ---------------------------------------------------------------------------
// Identity derivation edge cases
// ---------------------------------------------------------------------------

describe('identity derivation', () => {
  test.each([
    ['~/prompts/grooming-tick.md', 'cscb-cron:grooming-tick', 'extension stripped'],
    ['/abs/path/report', 'cscb-cron:report', 'no extension'],
    ['~/config/.env', 'cscb-cron:.env', 'dotfile keeps its name'],
    ['bare.md', 'cscb-cron:bare', 'no directory component'],
    ['~/a/archive.tar.gz', 'cscb-cron:archive.tar', 'only final extension dropped'],
  ])('path %j → identity %s (%s)', (path, identity) => {
    expect(onlySchedule(makeLine({ path })).identity).toBe(identity)
  })

  test('two different paths sharing a basename get the same identity label (PD-1)', () => {
    const a = makeLine({ path: '~/team-a/daily.md' })
    const b = makeLine({ path: '~/team-b/daily.md' })
    const { schedules, errors } = parseCrontable([a, b].join('\n'))
    expect(errors).toEqual([])
    expect(schedules).toHaveLength(2)
    expect(schedules[0]!.identity).toBe('cscb-cron:daily')
    expect(schedules[1]!.identity).toBe('cscb-cron:daily')
    // Same label, but distinct records with distinct prompt paths.
    expect(schedules[0]!.promptPath).not.toBe(schedules[1]!.promptPath)
  })
})
