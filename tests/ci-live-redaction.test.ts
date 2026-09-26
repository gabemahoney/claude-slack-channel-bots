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
 * escaped forms too (JSON as JavaScript, Python and PHP write it, with `\/`
 * and `\uXXXX`, JSON inside JSON, and Markdown), and results are redacted
 * before they are serialised; the scan counts the escaped forms as well, and
 * a value past ASCII in a file as the latin1 read shows it. A terminal's
 * text (`redactWrapped`, for a tmux pane Claude Code hard-wraps) also loses
 * every 10-character fragment of a registered form and every piece of a
 * value or token split across rows. The results' own sections (the prompt
 * guard's denials, the memory watchdog's peaks) are redacted like the rest.
 * Every secret here is a sentinel-bearing fake built at runtime; captured
 * output is checked with `assertNoLeak`.
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
  MIN_FRAGMENT_LENGTH,
  MIN_SECRET_LENGTH,
  Redactor,
  REDACTED_SECRET,
  REDACTED_TOKEN,
  secretForms,
} from '../ci-live/lib/redact.ts'
import { redactDeep, renderPromptGuard, RESULTS_COLUMNS, renderResultsRow, writeResults, type RunSummary } from '../ci-live/lib/results.ts'
import { describeScan, latin1Spellings, nodeScanFs, scanOutputs, type ScanFs } from '../ci-live/lib/secrecy-scan.ts'
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

  test('secretForms: the value as it is, JSON-escaped, Markdown-cell-escaped, JSON inside JSON, and with / as \\/ and non-ASCII as \\uXXXX (lower- and upper-case hex, and both), each once', () => {
    expect(secretForms('plain-value')).toEqual(['plain-value'])
    expect(secretForms('a"b\\c|d')).toEqual(['a"b\\c|d', 'a\\"b\\\\c|d', 'a"b\\c\\|d', 'a\\\\\\"b\\\\\\\\c|d'])
    expect(secretForms('a/b-é')).toEqual([
      'a/b-é',
      'a\\/b-é',
      'a/b-\\u00e9',
      'a/b-\\u00E9',
      'a\\/b-\\u00e9',
      'a\\/b-\\u00E9',
      'a\\\\/b-é',
      'a/b-\\\\u00e9',
      'a/b-\\\\u00E9',
      'a\\\\/b-\\\\u00e9',
      'a\\\\/b-\\\\u00E9',
    ])
    // A character past U+FFFF is escaped as its two surrogates, as JSON encoders write it.
    expect(secretForms('k😀-long')).toContain('k\\ud83d\\ude00-long')
  })

  test('a secret holding /, ", \\ and characters past ASCII is masked, and counted by the closing scan, however a JSON encoder wrote it', () => {
    const tricky = `pw/${LEAK_SENTINEL}"é\\😀|x`
    const r = redactorWith(tricky)
    const js = JSON.stringify({ v: tricky })
    const hex = (text: string, upper: boolean) =>
      text.replace(/[^\x00-\x7f]/g, (c) => {
        const h = c.charCodeAt(0).toString(16).padStart(4, '0')
        return `\\u${upper ? h.toUpperCase() : h}`
      })
    const written = {
      'JavaScript (JSON.stringify)': js,
      'JSON inside JSON': JSON.stringify({ outer: js }),
      "Python (json.dumps, ensure_ascii)": hex(js, false),
      'PHP (json_encode: \\/ and \\uXXXX)': hex(js, false).replace(/\//g, '\\/'),
      '/ as \\/ only': js.replace(/\//g, '\\/'),
      'upper-case \\uXXXX': hex(js, true),
      'upper-case \\uXXXX inside JSON': JSON.stringify({ outer: hex(js, true) }),
    }
    const before = scanOutputs([], Object.entries(written).map(([source, text]) => ({ source, text })), r.knownSecrets())
    expect(before.counts.map((c) => [c.source, c.knownSecrets])).toEqual(Object.keys(written).map((source) => [source, 1]))
    const out = Object.fromEntries(Object.entries(written).map(([k, text]) => [k, r.redact(text)]))
    for (const text of Object.values(out)) expect(text).toContain(REDACTED_SECRET)
    expect(scanOutputs([], Object.entries(out).map(([source, text]) => ({ source, text })), r.knownSecrets()).total).toBe(0)
    assertNoLeak(out)
    assertNoLeak(describeScan(before))
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

// ---------------------------------------------------------------------------
// Redactor.redactWrapped: a terminal's text, which Claude Code hard-wraps
// ---------------------------------------------------------------------------

describe('Redactor.redactWrapped (a tmux pane: Claude Code hard-wraps a long line itself, a line break then indentation or a │ / ⎿ border)', () => {
  /** A long token no redactor knows (58 characters). */
  const TOKEN = fakeToken(BOT_TOKEN_PREFIX, '1234567890-ABCDEFGHIJKLMNOPQRSTUVWX')
  /** A registered value that is not token-shaped, as the Claude gateway key is (56 characters). */
  const GATEWAY = `gw-key-${LEAK_SENTINEL}-0123456789abcdef0123456789abcd`
  /** Both masks as one, where a piece may get either (a registered token: a token's mask, or a value's). */
  const oneMask = (text: string): string => text.replaceAll(REDACTED_TOKEN, '<M>').replaceAll(REDACTED_SECRET, '<M>')

  test('a token split by a row break then indentation, or a "│ " border, is masked in both pieces, even split inside its prefix; the one-text redaction is the control', () => {
    const r = new Redactor()
    const text = [`token: ${TOKEN.slice(0, 30)}`, `    ${TOKEN.slice(30)}`, '', `│ inside its prefix: ${TOKEN.slice(0, 2)}`, `│ ${TOKEN.slice(2)}`, ''].join('\n')
    expect(r.redactWrapped(text)).toBe([`token: ${REDACTED_TOKEN}`, `    ${REDACTED_TOKEN}`, '', `│ inside its prefix: ${REDACTED_TOKEN}`, `│ ${REDACTED_TOKEN}`, ''].join('\n'))
    // The control: redact alone masks only the first piece of the first, and nothing of the second.
    const plain = r.redact(text)
    expect([plain.includes(TOKEN.slice(30)), plain.includes(TOKEN.slice(2))]).toEqual([true, true])
  })

  test('a registered value that is not token-shaped, split by a row break then a border, is masked in each piece however short (a box\'s right border and trailing spaces too)', () => {
    const r = redactorWith(GATEWAY)
    for (const at of [3, 28, GATEWAY.length - 3]) {
      const text = `│ key: ${GATEWAY.slice(0, at)}   │\n│ ${GATEWAY.slice(at)}   │\n`
      expect(r.redactWrapped(text)).toBe(`│ key: ${REDACTED_SECRET}   │\n│ ${REDACTED_SECRET}   │\n`)
      // The control: redact alone leaves both pieces.
      expect(r.redact(text)).toBe(text)
    }
  })

  test('every split of a token, a registered value and a registered token, after indentation, a "│ " or a "  ⎿  ", leaves no piece: each is masked on its row', () => {
    const registered = fakeToken(APP_TOKEN_PREFIX, 'A0123456789-0123456789abcdef')
    const r = redactorWith(GATEWAY, registered)
    let cases = 0
    for (const value of [TOKEN, GATEWAY, registered]) {
      for (const lead of ['    ', '│ ', '  ⎿  ']) {
        for (let at = 1; at < value.length; at++) {
          const out = r.redactWrapped(`(a) ${value.slice(0, at)}\n${lead}${value.slice(at)}\n(b)\n`)
          expect(oneMask(out)).toBe(`(a) <M>\n${lead}<M>\n(b)\n`)
          cases++
        }
      }
    }
    expect(cases).toBe(3 * (TOKEN.length + GATEWAY.length + registered.length - 3))
  })

  test('a token or a registered value split over three rows is masked in all three', () => {
    const r = redactorWith(GATEWAY)
    const text = `a: ${TOKEN.slice(0, 20)}\n  ${TOKEN.slice(20, 40)}\n  ${TOKEN.slice(40)}\n\nb: ${GATEWAY.slice(0, 12)}\n  ${GATEWAY.slice(12, 24)}\n  ${GATEWAY.slice(24)}\n`
    const T = REDACTED_TOKEN
    const S = REDACTED_SECRET
    expect(r.redactWrapped(text)).toBe(`a: ${T}\n  ${T}\n  ${T}\n\nb: ${S}\n  ${S}\n  ${S}\n`)
  })

  test(`every fragment of ${MIN_FRAGMENT_LENGTH} or more characters of a registered form (its JSON-escaped one too) is masked wherever it is, a value cut short included; ${MIN_FRAGMENT_LENGTH - 1} are not`, () => {
    const r = redactorWith(GATEWAY, ESCAPABLE)
    expect(MIN_FRAGMENT_LENGTH).toBe(10)
    expect(r.redactWrapped(`cut short: ${GATEWAY.slice(0, 10)}… and ${GATEWAY.slice(5, 25)} end\n`)).toBe(`cut short: ${REDACTED_SECRET}… and ${REDACTED_SECRET} end\n`)
    const json = JSON.stringify(ESCAPABLE).slice(1, -1)
    expect(r.redactWrapped(`{"v":"${json.slice(0, 12)}…"}\n`)).toBe(`{"v":"${REDACTED_SECRET}…"}\n`)
    const nine = `nine: ${GATEWAY.slice(0, 9)}.\n`
    expect(r.redactWrapped(nine)).toBe(nine)
  })

  test(`a registered form shorter than ${MIN_FRAGMENT_LENGTH} characters (a sign-in code) is masked whole, even split across rows`, () => {
    const r = redactorWith('482913')
    expect(r.redactWrapped('code: 482913\n')).toBe(`code: ${REDACTED_SECRET}\n`)
    expect(r.redactWrapped('code: 482\n  913\n')).toBe(`code: ${REDACTED_SECRET}\n  ${REDACTED_SECRET}\n`)
    expect(r.redactWrapped('code: 48291\n')).toBe('code: 48291\n')
  })

  test('the over-masking, pinned: a row ending with a token takes the next row\'s leading run of token characters with it; an empty row, or a row that starts with another character, stops it', () => {
    const r = new Redactor()
    expect(r.redactWrapped(`t: ${TOKEN}\nnext words\n`)).toBe(`t: ${REDACTED_TOKEN}\n${REDACTED_TOKEN} words\n`)
    expect(r.redactWrapped(`t: ${TOKEN}\n\nnext words\n`)).toBe(`t: ${REDACTED_TOKEN}\n\nnext words\n`)
    expect(r.redactWrapped(`t: ${TOKEN}\n│      │\nnext words\n`)).toBe(`t: ${REDACTED_TOKEN}\n│      │\nnext words\n`)
    expect(r.redactWrapped(`t: ${TOKEN}\n(next) words\n`)).toBe(`t: ${REDACTED_TOKEN}\n(next) words\n`)
  })

  test('text with nothing registered or token-shaped in it is left as it is, its indentation, borders and line breaks included', () => {
    const text = '╭────╮\n│ a box │\n  ⎿  indented\n\n\tplain  \n'
    expect(new Redactor().redactWrapped(text)).toBe(text)
    expect(redactorWith(PASSWORD, GATEWAY).redactWrapped(text)).toBe(text)
    expect(new Redactor().redactWrapped('')).toBe('')
  })

  test('what redact masks, it masks too (a value spanning a plain line break included), and it leaves nothing the closing scan would count', () => {
    const split = `split-${LEAK_SENTINEL}\nsecret-tail`
    const r = redactorWith(PASSWORD, split)
    // Each row ends with `;`, not a token character: no row takes the next one's first word with it.
    const text = `pw ${PASSWORD} ${fakeToken(APP_TOKEN_PREFIX)};\nkey: ${split};\n${Object.values(PREFIXES).map((p, i) => fakeToken(p, `t${i}`)).join(' ')}\n`
    const out = r.redactWrapped(text)
    expect(oneMask(out)).toBe(oneMask(r.redact(text)))
    expect([countTokenShaped(out), countKnownSecrets(out, r.knownSecrets())]).toEqual([0, 0])
    assertNoLeak(out)
  })

  test('a secret registered after a pass is masked by the next (the fragments are rebuilt)', () => {
    const r = new Redactor()
    const text = `k: ${GATEWAY.slice(0, 20)}\n  ${GATEWAY.slice(20)}\n`
    expect(r.redactWrapped(text)).toBe(text)
    r.addSecret(GATEWAY)
    expect(r.redactWrapped(text)).toBe(`k: ${REDACTED_SECRET}\n  ${REDACTED_SECRET}\n`)
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

  test("the memory watchdog's peaks, when the run had one, go into results.json and a section of results.md, redacted", () => {
    const withMemory = summary({
      memory: {
        intervalMs: 30_000,
        samples: 2,
        failedSamples: 1,
        thresholds: { hostWorkingSetBytes: 40, chromePssBytes: 4 },
        hostMaxBytes: null,
        peaks: { runnerRss: { value: 1, at: '2026-09-26T12:00:00.000Z' } },
        abort: null,
        lines: ['2 samples every 30 s, 1 with a failed reading', `runner RSS peak 1 B (note ${PASSWORD})`],
      },
    })
    const written: Record<string, string> = {}
    writeResults(withMemory, { write: (name, content) => (written[name] = content) }, redactorWith(PASSWORD))
    expect(JSON.parse(written['results.json']!).memory.samples).toBe(2)
    expect(written['results.md']).toEndWith(
      `## Memory (the watchdog's peaks)\n\n- 2 samples every 30 s, 1 with a failed reading\n- runner RSS peak 1 B (note ${REDACTED_SECRET})\n`,
    )
    const without: Record<string, string> = {}
    writeResults(summary({}), { write: (name, content) => (without[name] = content) }, redactorWith(PASSWORD))
    expect([without['results.md']!.includes('## Memory'), 'memory' in JSON.parse(without['results.json']!)]).toEqual([false, false])
    assertNoLeak(written)
  })

  test("the prompt guard's report, when the run had one, goes into results.json and a section of results.md before the memory's, redacted", () => {
    const s = summary({
      promptGuard: {
        seen: 3,
        denied: 1,
        notDenied: 1,
        entries: [
          { check: 'check 12', persona: 'persona_a', command: `Bash: env | grep ${PASSWORD}`, why: 'unexpected', how: 'Deny clicked' },
          { check: 'check 23', persona: 'persona_b', command: 'Bash: date > prompt-b.txt', why: 'left open', how: 'not denied' },
        ],
      },
      memory: {
        intervalMs: 30_000,
        samples: 1,
        failedSamples: 0,
        thresholds: { hostWorkingSetBytes: 40, chromePssBytes: 4 },
        hostMaxBytes: null,
        peaks: {},
        abort: null,
        lines: ['1 sample every 30 s'],
      },
    })
    const written: Record<string, string> = {}
    writeResults(s, { write: (name, content) => (written[name] = content) }, redactorWith(PASSWORD))
    const json = JSON.parse(written['results.json']!)
    expect(json.promptGuard).toEqual({
      seen: 3,
      denied: 1,
      notDenied: 1,
      entries: [
        { check: 'check 12', persona: 'persona_a', command: `Bash: env | grep ${REDACTED_SECRET}`, why: 'unexpected', how: 'Deny clicked' },
        { check: 'check 23', persona: 'persona_b', command: 'Bash: date > prompt-b.txt', why: 'left open', how: 'not denied' },
      ],
    })
    expect(written['results.md']).toContain(
      '## Prompt guard (prompts no check expected, and prompts a check left open)\n\n' +
        '3 permission prompt(s) seen; 1 denied, 1 could not be denied. A denial is a note, never a FAIL.\n\n' +
        `- check 12, persona_a, unexpected: Bash: env | grep ${REDACTED_SECRET} (Deny clicked)\n` +
        '- check 23, persona_b, left open: Bash: date > prompt-b.txt (not denied)\n\n' +
        "## Memory (the watchdog's peaks)",
    )
    expect(renderPromptGuard({ seen: 0, denied: 0, notDenied: 0, entries: [] })).toEqual([
      '0 permission prompt(s) seen; 0 denied, 0 could not be denied. A denial is a note, never a FAIL.',
    ])
    const without: Record<string, string> = {}
    writeResults(summary({}), { write: (name, content) => (without[name] = content) }, redactorWith(PASSWORD))
    expect([without['results.md']!.includes('## Prompt guard'), 'promptGuard' in JSON.parse(without['results.json']!)]).toEqual([false, false])
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

    test('a file is read as latin1: a registered value with characters past ASCII is counted as its UTF-8 bytes read that way', () => {
      const secret = `pässwörd-${LEAK_SENTINEL}`
      writeFileSync(join(dir, 'run.log'), `line ${secret}\n`)
      const r = redactorWith(secret)
      expect(scanOutputs([dir], [], r.knownSecrets(), nodeScanFs).counts.map((c) => c.knownSecrets)).toEqual([1])
      // The control: the file as read holds none of the forms as they are.
      expect(countKnownSecrets(nodeScanFs.readFile(join(dir, 'run.log')), r.knownSecrets())).toBe(0)
      // A text passed as it is (the docker logs) is scanned for the forms as they are.
      expect(scanOutputs([], [{ source: 'docker logs', text: secret }], r.knownSecrets()).total).toBe(1)
      expect(latin1Spellings(['ascii-only', 'é-x'])).toEqual(['ascii-only', 'é-x', 'Ã©-x'])
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
