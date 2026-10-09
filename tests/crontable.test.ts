/**
 * crontable.test.ts — unit tests for the pure crontable parser.
 *
 * Pure module: string in, records out. No mocks, no test servers. Assertions
 * are plain input-string → output-record checks. Token 7 is a list of persona
 * targets (names or keys, b.av2 SR-9.3) kept verbatim; the parser resolves
 * nothing. The AC 50 case passes a parsed schedule through the dispatcher's
 * exported resolve step with the real name-or-key resolver; its persona config
 * is built in memory (the temp dir is only a path base, nothing is written).
 */

import { afterAll, beforeAll, describe, test, expect } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { PersonaConfig } from '../src/config.ts'
import { resolveDeliveryTargets } from '../src/cron-dispatch.ts'
import {
  parseCrontable,
  type CronSchedule,
  type CronParseError,
  type CronParseErrorReason,
} from '../src/crontable.ts'
import { personaKey, resolvePersonaTarget } from '../src/persona-identity.ts'
import { makeMultiPersonaConfig } from './test-helpers/persona-config.ts'

// ---------------------------------------------------------------------------
// Factories / helpers
// ---------------------------------------------------------------------------

/** Build a valid crontable data line from parts (sensible defaults). */
function makeLine(opts?: {
  expr?: string
  path?: string
  targets?: string
}): string {
  const expr = opts?.expr ?? '*/5 * * * *'
  const path = opts?.path ?? '~/prompts/grooming-tick.md'
  const parts = [expr, path]
  if (opts?.targets !== undefined) parts.push(opts.targets)
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
      targets: 'alpha,beta_1234abcd',
    })
    const s = onlySchedule(line)

    expect(s.identity).toBe('cscb-cron:x')
    expect(s.expression).toBe('0 9 * * 1')
    // Prompt path is kept literal — no tilde/relative expansion.
    expect(s.promptPath).toBe('~/prompts/x.md')
    expect(s.targets).toEqual({ kind: 'explicit', targets: ['alpha', 'beta_1234abcd'] })
    // Raw line preserved verbatim (downstream at-most-once keys on it).
    expect(s.rawLine).toBe(line)
    expect(s.lineNumber).toBe(1)
  })

  test('single explicit target parses to a one-element list', () => {
    const s = onlySchedule(makeLine({ targets: 'planner' }))
    expect(s.targets).toEqual({ kind: 'explicit', targets: ['planner'] })
  })

  test('rawLine preserves surrounding/interior whitespace verbatim', () => {
    const raw = '  0 9 * * 1   ~/prompts/x.md   alpha  '
    const { schedules } = parseCrontable(raw)
    expect(schedules).toHaveLength(1)
    expect(schedules[0]!.rawLine).toBe(raw)
    // Expression is normalized to single spaces regardless of input spacing.
    expect(schedules[0]!.expression).toBe('0 9 * * 1')
  })

  test('arbitrary/unknown targets are accepted (no resolution or existence check)', () => {
    const s = onlySchedule(makeLine({ targets: 'not-a-real-persona,ZZZ,#nope' }))
    expect(s.targets).toEqual({
      kind: 'explicit',
      targets: ['not-a-real-persona', 'ZZZ', '#nope'],
    })
  })

  test('a name with capitals and no whitespace or comma parses verbatim; duplicates are kept', () => {
    const s = onlySchedule(makeLine({ targets: 'Planner,Planner' }))
    expect(s.targets).toEqual({ kind: 'explicit', targets: ['Planner', 'Planner'] })
  })
})

// ---------------------------------------------------------------------------
// Persona keys always tokenize (b.av2 SR-2.1)
// ---------------------------------------------------------------------------

describe('persona keys as token 7', () => {
  test.each([
    ['plain a-z0-9_ name', 'planner_2'],
    ['name with capitals', 'Planner'],
    ['name with spaces', 'Ops Bot'],
    ['name with no ASCII letters or digits', 'ボット'],
    ['name long enough to be truncated and hashed', 'A Very Long Persona Name That Exceeds The Forty Character Stem'],
  ])('the key of a %s parses alone and inside a two-element list', (_label, name) => {
    const key = personaKey(name)
    expect(onlySchedule(makeLine({ targets: key })).targets).toEqual({ kind: 'explicit', targets: [key] })
    expect(onlySchedule(makeLine({ targets: `${key},other` })).targets).toEqual({
      kind: 'explicit',
      targets: [key, 'other'],
    })
  })
})

// ---------------------------------------------------------------------------
// Omitted target list → all-bots marker
// ---------------------------------------------------------------------------

describe('omitted target list', () => {
  test('yields the all-bots marker, distinguishable from an empty explicit list', () => {
    const s = onlySchedule(makeLine({ targets: undefined }))
    expect(s.targets.kind).toBe('all-bots')
    // The marker is NOT an empty explicit list — an empty list is not representable.
    expect(s.targets).not.toEqual({ kind: 'explicit', targets: [] })
    expect(s.targets).toEqual({ kind: 'all-bots' })
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

  test('comment/blank lines do not shift line numbers of real errors or schedules', () => {
    const text = [
      '# header',
      '',
      'bogus line',
      '   ',
      makeLine({ path: '~/a.md' }),
      '# note',
      makeLine({ path: '~/b.md' }),
    ].join('\n')
    const { schedules, errors } = parseCrontable(text)
    expect(errors).toHaveLength(1)
    // 'bogus line' is the 3rd source line (1-based).
    expect(errors[0]!.lineNumber).toBe(3)
    // The schedules are the 5th and 7th source lines: every line counts, not
    // only the data lines (the scheduler's load warning names this number).
    expect(schedules.map((s) => [s.promptPath, s.lineNumber])).toEqual([
      ['~/a.md', 5],
      ['~/b.md', 7],
    ])
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
    ['*/5 * * * * ~/a b.md alpha', 'path-with-spaces', 'path with a space (8 tokens)'],
    ['*/5 * * * * ~/p.md alpha,', 'malformed-channel-list', 'trailing comma'],
    ['*/5 * * * * ~/p.md alpha,,beta', 'malformed-channel-list', 'double comma'],
    ['*/5 * * * * ~/p.md ,alpha', 'malformed-channel-list', 'leading comma'],
    ['*/5 * * * * ~/p.md *', 'wildcard-channel-list', 'literal star target'],
  ])('line %j → reason %s (%s)', (line, reason) => {
    const err = onlyError(line)
    expect(err.reason).toBe(reason)
    expect(err.rawLine).toBe(line)
    expect(err.lineNumber).toBe(1)
  })

  test('literal * in target position is an error, NOT an all-bots schedule', () => {
    const { schedules, errors } = parseCrontable(makeLine({ targets: '*' }))
    expect(schedules).toEqual([])
    expect(errors).toHaveLength(1)
    expect(errors[0]!.reason).toBe('wildcard-channel-list')
  })

  // Positional 5-field contract: a 6-field croner-valid expression plus a path
  // is 7 tokens. The parser only reads tokens 1-5 as the expression, so the 6th
  // cron field is misread as the prompt path and the path becomes the target
  // list — it does NOT silently accept the 6-field form as the schedule minute.
  test('6-field croner-valid expr + path is read positionally (5-field contract)', () => {
    // '0 0 1 1 1 1 ~/p.md' → expr='0 0 1 1 1', promptPath='1', targets='~/p.md'
    const s = onlySchedule('0 0 1 1 1 1 ~/p.md')
    expect(s.expression).toBe('0 0 1 1 1')
    expect(s.promptPath).toBe('1')
    expect(s.targets).toEqual({ kind: 'explicit', targets: ['~/p.md'] })
  })

  test('a wrong-field-count line where a path-looking token lands in field 5 is rejected', () => {
    // '* * * * ~/p.md alpha' is 6 tokens: tokens 1-5 = '* * * * ~/p.md' — the
    // path token occupies cron field 5, so croner rejects the expression. This
    // pins the strict positional 5-field contract.
    const err = onlyError('* * * * ~/p.md alpha')
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
      '*/5 * * * * ~/p.md alpha,,beta', // malformed-channel-list (line 3)
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
  test('two identical lines both produce schedule records, equal but for their line numbers', () => {
    const line = makeLine()
    const { schedules, errors } = parseCrontable([line, line].join('\n'))
    expect(errors).toEqual([])
    expect(schedules).toHaveLength(2)
    const [{ lineNumber: first, ...a }, { lineNumber: second, ...b }] = schedules as [CronSchedule, CronSchedule]
    expect(a).toEqual(b)
    expect([first, second]).toEqual([1, 2])
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

// ---------------------------------------------------------------------------
// AC 50 — parse, then the dispatcher's resolve step: a name and its key
// deliver once (b.av2 SR-9.3). Real name-or-key resolver over two personas.
// ---------------------------------------------------------------------------

describe('AC 50: parse then resolve', () => {
  const PLANNER = 'Planner'
  const PLANNER_KEY = personaKey(PLANNER)
  const REVIEWER = 'reviewer'
  let baseDir: string
  let config: PersonaConfig

  beforeAll(() => {
    baseDir = mkdtempSync(join(tmpdir(), 'cscb-crontable-personas-'))
    config = makeMultiPersonaConfig([{ name: PLANNER }, { name: REVIEWER }], baseDir)
  })

  afterAll(() => {
    rmSync(baseDir, { recursive: true, force: true })
  })

  function resolveLine(targets: string | undefined): ReturnType<typeof resolveDeliveryTargets> {
    return resolveDeliveryTargets(onlySchedule(makeLine({ targets })), (t) => resolvePersonaTarget(config, t)?.key)
  }

  test('a line naming one persona by name and by key yields exactly one target: the key, logged as first written', () => {
    const s = onlySchedule(makeLine({ targets: `${PLANNER},${PLANNER_KEY}` }))
    // The parser keeps both written targets; the resolve step collapses them.
    expect(s.targets).toEqual({ kind: 'explicit', targets: [PLANNER, PLANNER_KEY] })
    expect(resolveLine(`${PLANNER},${PLANNER_KEY}`)).toEqual([{ persona: PLANNER_KEY, written: PLANNER }])
  })

  test('two personas keep first-seen order; an unknown target is kept once with its written text', () => {
    expect(resolveLine(`${REVIEWER},nobody,${PLANNER_KEY},nobody,${PLANNER}`)).toEqual([
      { persona: personaKey(REVIEWER), written: REVIEWER },
      { persona: 'nobody', written: 'nobody' },
      { persona: PLANNER_KEY, written: PLANNER_KEY },
    ])
  })

  test('an all-bots schedule yields no targets', () => {
    expect(resolveLine(undefined)).toEqual([])
  })
})
