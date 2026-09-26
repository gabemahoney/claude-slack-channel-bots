/**
 * ci-live-redaction.test.ts — Tests for the /ci-live runner's output hygiene
 * (bug b.1cx): the one redactor every log line and report goes through
 * (`ci-live/lib/redact.ts`), the error describer (`lib/errors.ts`), the run
 * log (`lib/log.ts`), the results writer (`lib/results.ts`) and the closing
 * secrecy scan (`lib/secrecy-scan.ts`).
 *
 * The rule under test: no token or known secret value reaches stdout,
 * run.log, verdict.txt, results.json or results.md, and the scan that closes
 * every run counts what slipped through without ever printing it. A secret
 * is masked from 4 characters up (a 6-digit sign-in code included), in its
 * JSON- and Markdown-escaped forms too, and results are redacted before they
 * are serialised; the scan counts the escaped forms as well. Every
 * secret here is a sentinel-bearing fake built at runtime; captured output is
 * checked with `assertNoLeak`.
 *
 * SPDX-License-Identifier: MIT
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { RecordedResult } from '../ci-live/checks/framework.ts'
import { describeError } from '../ci-live/lib/errors.ts'
import { createRunLog } from '../ci-live/lib/log.ts'
import {
  countKnownSecrets,
  countTokenShaped,
  MIN_SECRET_LENGTH,
  Redactor,
  REDACTED_SECRET,
  REDACTED_TOKEN,
  secretForms,
} from '../ci-live/lib/redact.ts'
import { redactDeep, RESULTS_COLUMNS, renderResultsRow, writeResults, type RunSummary } from '../ci-live/lib/results.ts'
import { describeScan, nodeScanFs, scanOutputs, type ScanFs } from '../ci-live/lib/secrecy-scan.ts'
import { APP_TOKEN_PREFIX, assertNoLeak, BOT_TOKEN_PREFIX, fakeToken, LEAK_SENTINEL, writtenFile } from './test-helpers/credentials.ts'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Every Slack token shape the runner handles, as sentinel-bearing fakes. */
const PREFIXES = {
  bot: BOT_TOKEN_PREFIX,
  app: APP_TOKEN_PREFIX,
  session: BOT_TOKEN_PREFIX.replace('b', 'c'),
  cookie: BOT_TOKEN_PREFIX.replace('b', 'd'),
  user: BOT_TOKEN_PREFIX.replace('b', 'p'),
  config: `${BOT_TOKEN_PREFIX.slice(0, 3)}e.`,
  refresh: BOT_TOKEN_PREFIX.replace('b', 'e'),
}

/** A password-like known secret: not token-shaped, so only the known-value rule can catch it. */
const PASSWORD = `hunter-${LEAK_SENTINEL}-pw`

/** A secret whose JSON and Markdown-cell forms differ from the value: `"`, `\` and `|`. */
const ESCAPABLE = `pa|ss"wo\\rd-${LEAK_SENTINEL}`

function redactorWith(...secrets: string[]): Redactor {
  const r = new Redactor()
  for (const s of secrets) r.addSecret(s)
  return r
}

function result(overrides: Partial<RecordedResult> = {}): RecordedResult {
  return { id: '1', title: 'Check 1', row: '1', durationMs: 5, status: 'PASS', evidence: [], ...overrides }
}

function summary(overrides: Partial<RunSummary> = {}): RunSummary {
  return {
    runId: '1700000000',
    mode: 'dry-run',
    date: '2026-09-25',
    build: '0.10.0, abc1234',
    hostUser: 'cscb-live-1700000000 / testuser',
    verdict: 'PASS',
    results: [],
    notes: [],
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Redactor
// ---------------------------------------------------------------------------

describe('Redactor', () => {
  test.each(Object.entries(PREFIXES))('masks token-shaped text of the %s kind, known or not', (_kind, prefix) => {
    const out = new Redactor().redact(`before ${fakeToken(prefix, 'x')} after`)
    expect(out).toBe(`before ${REDACTED_TOKEN} after`)
  })

  test('leaves a bare prefix, as rule text names it, as it is', () => {
    const text = `a bot token starts with ${BOT_TOKEN_PREFIX} and an app token with ${APP_TOKEN_PREFIX}`
    expect(new Redactor().redact(text)).toBe(text)
  })

  test('masks every registered secret value, the longest first so one holding another is masked whole', () => {
    const inner = `inner-${LEAK_SENTINEL}`
    const outer = `${inner}-outer`
    const r = redactorWith(inner, outer)
    expect(r.redact(`a ${outer} b ${inner} c ${outer}`)).toBe(`a ${REDACTED_SECRET} b ${REDACTED_SECRET} c ${REDACTED_SECRET}`)
    expect(r.secretCount).toBe(2)
  })

  test('registers the trimmed value too, so a secret read with its newline is masked either way', () => {
    const r = redactorWith(`${PASSWORD}\n`)
    expect(r.redact(`pw=${PASSWORD};`)).toBe(`pw=${REDACTED_SECRET};`)
  })

  test.each([undefined, null, '', 'abc'])('ignores an absent or shorter-than-4 value (%p)', (value) => {
    const r = new Redactor()
    r.addSecret(value)
    expect(r.secretCount).toBe(0)
    expect(r.redact('abc')).toBe('abc')
  })

  test(`masks and counts a short secret of ${MIN_SECRET_LENGTH} characters or more, such as a 6-digit sign-in code`, () => {
    const code = '482913'
    const r = redactorWith(code, 'wxyz')
    expect(r.redact(`code ${code}, word wxyz`)).toBe(`code ${REDACTED_SECRET}, word ${REDACTED_SECRET}`)
    expect(countKnownSecrets(`x${code}x`, r.knownSecrets())).toBe(1)
    expect(countKnownSecrets('abc abc', ['abc'])).toBe(0)
  })

  test('secretForms: the value as it is, JSON-escaped and Markdown-cell-escaped, each once', () => {
    expect(secretForms('plain-value')).toEqual(['plain-value'])
    expect(secretForms('a"b\\c|d')).toEqual(['a"b\\c|d', 'a\\"b\\\\c|d', 'a"b\\c\\|d'])
  })

  test('masks a secret holding ", \\ or | in its JSON- and Markdown-escaped forms too', () => {
    const r = redactorWith(ESCAPABLE)
    const texts = [ESCAPABLE, JSON.stringify({ reason: ESCAPABLE }), `| ${ESCAPABLE.replace(/\|/g, '\\|')} |`]
    const out = texts.map((t) => r.redact(t))
    expect(out).toEqual([REDACTED_SECRET, `{"reason":"${REDACTED_SECRET}"}`, `| ${REDACTED_SECRET} |`])
    assertNoLeak(out)
  })

  test('leaves nothing the closing scan would count', () => {
    const r = redactorWith(PASSWORD)
    const text = Object.values(PREFIXES).map((p, i) => `${fakeToken(p, `t${i}`)} ${PASSWORD}`).join('\n')
    const out = r.redact(text)
    expect(countTokenShaped(out)).toBe(0)
    expect(countKnownSecrets(out, r.knownSecrets())).toBe(0)
    assertNoLeak(out)
  })
})

describe('the closing scan counters', () => {
  test('countTokenShaped counts each token-shaped string and no bare prefix', () => {
    const text = `${fakeToken(PREFIXES.bot, 'a')} ${fakeToken(PREFIXES.app, 'b')} ${fakeToken(PREFIXES.config, 'c')} ${BOT_TOKEN_PREFIX}`
    expect(countTokenShaped(text)).toBe(3)
    expect(countTokenShaped('no tokens here')).toBe(0)
  })

  test('countKnownSecrets counts every occurrence of every secret', () => {
    const other = `other-${LEAK_SENTINEL}`
    expect(countKnownSecrets(`${PASSWORD} x ${PASSWORD} ${other}`, [PASSWORD, other])).toBe(3)
    expect(countKnownSecrets('clean', [PASSWORD])).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// describeError
// ---------------------------------------------------------------------------

describe('describeError', () => {
  test("keeps the error's name and first line, and drops every URL's query and fragment", () => {
    const err = new TypeError(`failed at https://example.invalid/oauth?code=${LEAK_SENTINEL}#frag and more\nsecond ${LEAK_SENTINEL}`)
    const out = describeError(err)
    expect(out).toBe('TypeError: failed at https://example.invalid/oauth?<query> and more')
    assertNoLeak(out)
  })

  test('truncates a long description', () => {
    const out = describeError(new Error('x'.repeat(1000)))
    expect(out.length).toBe(301)
    expect(out.endsWith('…')).toBe(true)
  })

  test.each([
    ['a thrown string', 'boom', 'Error: boom'],
    ['a thrown object', { secret: LEAK_SENTINEL }, 'non-Error thrown value'],
    ['undefined', undefined, 'non-Error thrown value'],
  ])('describes %s', (_what, value, expected) => {
    expect(describeError(value)).toBe(expected)
  })
})

// ---------------------------------------------------------------------------
// The run log
// ---------------------------------------------------------------------------

describe('createRunLog', () => {
  function harness() {
    const terminal: string[] = []
    const file: string[] = []
    const log = createRunLog({
      redactor: redactorWith(PASSWORD),
      write: (line) => terminal.push(line),
      append: (line) => file.push(line),
      now: () => new Date('2026-09-25T00:00:00.000Z'),
    })
    return { log, terminal, file }
  }

  test('info goes to the terminal and the file, detail to the file only, error to both with ERROR:, all redacted', () => {
    const { log, terminal, file } = harness()
    const token = fakeToken(BOT_TOKEN_PREFIX)
    log.info(`progress ${token}`)
    log.detail(`detail ${PASSWORD}`)
    log.error(`broke ${token}`)
    expect(terminal).toEqual([`progress ${REDACTED_TOKEN}`, `ERROR: broke ${REDACTED_TOKEN}`])
    expect(file).toEqual([
      `2026-09-25T00:00:00.000Z progress ${REDACTED_TOKEN}`,
      `2026-09-25T00:00:00.000Z detail ${REDACTED_SECRET}`,
      `2026-09-25T00:00:00.000Z ERROR: broke ${REDACTED_TOKEN}`,
    ])
    assertNoLeak({ terminal, file })
  })

  describe('attachFile', () => {
    let dir: string
    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), 'ci-live-log-'))
    })
    afterEach(() => {
      rmSync(dir, { recursive: true, force: true })
    })

    test('writes run.log with mode 600, redacted, from the moment it is attached', () => {
      const terminal: string[] = []
      const log = createRunLog({ redactor: redactorWith(PASSWORD), write: (l) => terminal.push(l), append: null, now: () => new Date(0) })
      log.info('before the file')
      const path = join(dir, 'run.log')
      log.attachFile(path)
      log.info(`after ${PASSWORD} ${fakeToken(APP_TOKEN_PREFIX)}`)
      expect(readFileSync(path, 'utf-8')).toBe(`1970-01-01T00:00:00.000Z after ${REDACTED_SECRET} ${REDACTED_TOKEN}\n`)
      expect(statSync(path).mode & 0o777).toBe(0o600)
      assertNoLeak({ terminal, file: writtenFile(path) })
    })
  })
})

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

describe('writeResults', () => {
  test('verdict.txt, results.json and results.md pass through the redactor', () => {
    const token = fakeToken(BOT_TOKEN_PREFIX, 'evidence')
    const s = summary({
      verdict: `FAIL: 5: saw ${PASSWORD}\nsecond line ${token}`,
      results: [
        result({ id: '5', row: '5', status: 'FAIL', reason: `saw ${PASSWORD}`, evidence: [`server.log: ${token}`], notes: [`note ${token}`] }),
      ],
      notes: [`run note ${PASSWORD}`],
    })
    const written: Record<string, string> = {}
    writeResults(s, { write: (name, content) => (written[name] = content) }, redactorWith(PASSWORD))
    expect(Object.keys(written).sort()).toEqual(['results.json', 'results.md', 'verdict.txt'])
    expect(written['verdict.txt']).toBe(`FAIL: 5: saw ${REDACTED_SECRET}\n`)
    expect(JSON.parse(written['results.json']!).results[0].evidence).toEqual([`server.log: ${REDACTED_TOKEN}`])
    expect(written['results.md']).toContain(`| 5 | Check 1 | FAIL | saw ${REDACTED_SECRET} | server.log: ${REDACTED_TOKEN} |`)
    assertNoLeak(written)
  })

  test('a secret holding ", \\ or | is masked before JSON or Markdown escaping could hide it, and the scan of the outputs finds nothing', () => {
    const r = redactorWith(ESCAPABLE)
    const s = summary({
      verdict: `FAIL: 5: saw ${ESCAPABLE}`,
      results: [result({ id: '5', row: '5', status: 'FAIL', reason: `saw ${ESCAPABLE}`, evidence: [`log: ${ESCAPABLE}`] })],
      notes: [`note ${ESCAPABLE}`],
    })
    const written: Record<string, string> = {}
    writeResults(s, { write: (name, content) => (written[name] = content) }, r)
    expect(JSON.parse(written['results.json']!).results[0].reason).toBe(`saw ${REDACTED_SECRET}`)
    expect(written['results.md']).toContain(`| 5 | Check 1 | FAIL | saw ${REDACTED_SECRET} | log: ${REDACTED_SECRET} |`)
    const scan = scanOutputs([], Object.entries(written).map(([source, text]) => ({ source, text })), r.knownSecrets())
    expect(scan.total).toBe(0)
    assertNoLeak(written)
  })

  test('redactDeep masks every string at any depth and keeps other values', () => {
    const r = redactorWith(PASSWORD)
    const out = redactDeep({ a: [`x ${PASSWORD}`, 3, null, true], b: { c: fakeToken(BOT_TOKEN_PREFIX) } }, r)
    expect(out).toEqual({ a: [`x ${REDACTED_SECRET}`, 3, null, true], b: { c: REDACTED_TOKEN } })
    assertNoLeak(out)
  })
})

describe('renderResultsRow', () => {
  test("fills the testplan's columns in order: pass, fail, or not run for a skipped or absent check", () => {
    const row = renderResultsRow(
      summary({
        results: [
          result({ id: 'S2', row: 'S2', status: 'PASS' }),
          result({ id: '1', row: '1', status: 'FAIL', reason: 'x' }),
          result({ id: '14', row: '14', status: 'SKIPPED', reason: 'no second account' }),
          result({ id: 'teardown', row: null, status: 'PASS' }),
        ],
        notes: ['a | b', 'multi\nline'],
      }),
    )
    const cells = row.slice(2, -2).split(' | ')
    expect(cells.length).toBe(3 + RESULTS_COLUMNS.length + 1)
    const byColumn = Object.fromEntries(RESULTS_COLUMNS.map((c, i) => [c, cells[3 + i]]))
    expect([byColumn.S1, byColumn.S2, byColumn['1'], byColumn['14'], byColumn['29a']]).toEqual(['not run', 'pass', 'fail', 'not run', 'not run'])
    expect(cells.at(-1)).toBe('a \\| b; multi line')
  })
})

// ---------------------------------------------------------------------------
// The closing secrecy scan
// ---------------------------------------------------------------------------

describe('scanOutputs', () => {
  function fakeFs(tree: Record<string, string>): ScanFs {
    return {
      listFiles: (dir) => Object.keys(tree).filter((p) => p.startsWith(`${dir}/`)).sort(),
      readFile: (path) => tree[path] ?? '',
    }
  }

  test('counts token-shaped strings and known secrets per source, and describes the result by name and number only', () => {
    const token = fakeToken(APP_TOKEN_PREFIX)
    const report = scanOutputs(
      ['/results'],
      [{ source: 'docker logs', text: `leaked ${PASSWORD}` }],
      [PASSWORD],
      fakeFs({ '/results/results.md': 'clean', '/results/container/server.log': `x ${token} y ${token}`, '/elsewhere/x': token }),
    )
    expect(report.counts).toEqual([
      { source: '/results/container/server.log', tokenShaped: 2, knownSecrets: 0 },
      { source: '/results/results.md', tokenShaped: 0, knownSecrets: 0 },
      { source: 'docker logs', tokenShaped: 0, knownSecrets: 1 },
    ])
    expect(report.total).toBe(3)
    const lines = describeScan(report)
    expect(lines).toEqual([
      '/results/container/server.log: 2 token-shaped, 0 known-secret',
      'docker logs: 0 token-shaped, 1 known-secret',
      'secrecy scan: 3 sources, 3 finding(s)',
    ])
    assertNoLeak(lines)
  })

  test("counts a known secret in its JSON-escaped and Markdown-escaped forms, through the redactor's known forms", () => {
    const report = scanOutputs(
      [],
      [
        { source: 'results.json', text: JSON.stringify({ reason: ESCAPABLE }) },
        { source: 'results.md', text: `| ${ESCAPABLE.replace(/\|/g, '\\|')} |` },
      ],
      redactorWith(ESCAPABLE).knownSecrets(),
    )
    expect(report.counts.map((c) => [c.source, c.knownSecrets])).toEqual([
      ['results.json', 1],
      ['results.md', 1],
    ])
    assertNoLeak(describeScan(report))
  })

  describe('on the real file system', () => {
    let dir: string
    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), 'ci-live-scan-'))
    })
    afterEach(() => {
      rmSync(dir, { recursive: true, force: true })
    })

    test('walks nested directories and finds a planted token', () => {
      mkdirSync(join(dir, 'container'))
      writeFileSync(join(dir, 'verdict.txt'), 'PASS\n')
      writeFileSync(join(dir, 'container', 'server.log'), `line ${fakeToken(BOT_TOKEN_PREFIX)}\n`)
      const report = scanOutputs([dir], [], [], nodeScanFs)
      expect(report.counts.map((c) => [c.source, c.tokenShaped])).toEqual([
        [join(dir, 'container', 'server.log'), 1],
        [join(dir, 'verdict.txt'), 0],
      ])
      assertNoLeak(describeScan(report))
    })
  })
})
