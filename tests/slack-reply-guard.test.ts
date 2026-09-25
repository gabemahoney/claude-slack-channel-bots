/**
 * slack-reply-guard.test.ts — black-box tests for stop-hooks/slack-reply-guard.sh
 *
 * Drives the script as a real subprocess via spawnSync, feeding Stop-hook
 * harness JSON on stdin and asserting exit code + stderr.
 *
 * Record gate (b.av2 SR-9.4): the guard reminds only when the record
 * `<argument>/<CSCB_PERSONA>` reads `true` (one trailing newline tolerated);
 * a missing argument, variable or record, or any other content, is a silent
 * exit 0. Default setup (b.av2 SR-13.4): every run gets a fresh
 * makeReplyGuardRecordDir state directory holding a `true` record for
 * TEST_KEY, its record directory `<state dir>/reply-guard` as the only
 * argument, and CSCB_PERSONA=TEST_KEY. The child environment is built
 * explicitly (PATH and, unless a case unsets it, CSCB_PERSONA) and never
 * inherits from the test process. Only the record-gate block departs from
 * the default; the retry and missing-jq cases pair their exit 0 with a
 * control on the same setup that exits 2.
 *
 * A `<channel source="slack…">` envelope is a delivered Slack message only when
 * it carries a `via` attribute (b.ob2 SR-9.4); an envelope without `via` is an
 * injected prompt and never triggers the reminder. The reminder states the
 * provenance of the last delivered message from its `via` and `chat_id`.
 *
 *   - SR-6.2 cases 1–7 run on the via-carrying copies of their fixtures; the
 *     fail-open cases, the negative control and the no-real-user-message case
 *     are unchanged.
 *   - The per-`via` block covers the five provenance wordings, the omitted
 *     conversation, an unknown or empty `via`, `via` (not the chat_id prefix)
 *     choosing the wording, the last delivered message winning, how the
 *     opening tag's attributes are read, and a non-Slack envelope carrying
 *     `via` never counting.
 *   - Every original Slack-wrapper fixture (no `via`) is an injected prompt
 *     and exits 0 under a `true` record, including AC 51's
 *     `injected-no-reply.jsonl`.
 *   - Every via-carrying copy keeps its original's b.wr5 / SR-6.3 result.
 *   - The record-gate block: a positive control and the reminding cases
 *     (`true` plus a newline, a record directory path with a space and a
 *     single quote, a 49-character hashed key), then every no-reminder case
 *     (no or empty argument, CSCB_PERSONA unset, empty or not a key, a
 *     nonexistent directory, no record, `false`, unrecognised or empty
 *     content, a neighbour's `true` record, a directory in the record's
 *     place, `../<name>` traversal) and the gate running before the jq check.
 *
 * The AC 59 block runs the guard over record directories a confirmed reload
 * left (`makeReloadHarness` with the real launch path): the guard follows a
 * persona's launched value until its next launch, and a neighbour's launch
 * leaves it unchanged.
 *
 * Fixture provenance is recorded above the injected-prompt describe block.
 *
 * SPDX-License-Identifier: MIT
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { resolve, join } from 'node:path'
import { mkdtempSync, writeFileSync, chmodSync, rmSync, mkdirSync, readFileSync, symlinkSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import type { PersonaInput } from '../src/config.ts'
import { PERSONA_KEY_MAX_LENGTH, personaKey } from '../src/persona-identity.ts'
import { assertNoLeak, writtenFile } from './test-helpers/credentials.ts'
import { makeReloadHarness, type ReloadHarness, type ReloadRun } from './test-helpers/reload-harness.ts'
import {
  makeReplyGuardRecordDir,
  RECORD_EMPTY,
  RECORD_FALSE,
  RECORD_TRUE,
  RECORD_TRUE_NEWLINE,
  type ReplyGuardRecordDir,
} from './test-helpers/reply-guard-record.ts'

const REPO_ROOT = resolve(import.meta.dir, '..')
const SCRIPT = join(REPO_ROOT, 'stop-hooks', 'slack-reply-guard.sh')
const FIX = join(REPO_ROOT, 'tests', 'fixtures', 'slack-reply-guard')

interface RunResult {
  exitCode: number
  stdout: string
  stderr: string
}

// The persona key every default run uses. The record gate accepts it.
const TEST_KEY = 'reply_guard_test'

/**
 * Everything a run passes to the guard besides stdin. The child environment
 * is built from these fields alone, never from process.env, so no run
 * inherits CSCB_PERSONA (or anything else) from the test process.
 */
interface GuardSetup {
  /** The guard's arguments; the default setup passes `[recordDir]`. */
  args: string[]
  /** CSCB_PERSONA in the child; `null` leaves it unset. */
  persona: string | null
  /** PATH in the child; defaults to the test process's PATH. */
  path?: string
  /** Kill the child after this many milliseconds; defaults to 20 000. */
  timeoutMs?: number
}

function spawnGuard(stdinJson: string, setup: GuardSetup): RunResult {
  const env: Record<string, string> = { PATH: setup.path ?? process.env.PATH ?? '/usr/bin:/bin' }
  if (setup.persona !== null) env.CSCB_PERSONA = setup.persona
  const result = spawnSync(SCRIPT, setup.args, {
    input: stdinJson,
    encoding: 'utf-8',
    env,
    timeout: setup.timeoutMs ?? 20_000,
  })
  return {
    exitCode: result.status ?? -1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  }
}

/** The default setup over `rec`: its record directory as the argument and TEST_KEY. */
function defaultSetup(rec: ReplyGuardRecordDir): GuardSetup {
  return { args: [rec.recordDir], persona: TEST_KEY }
}

/**
 * Run `fn` with a fresh helper record directory holding a `true` record for
 * TEST_KEY and the default setup over it; the directory is removed afterwards.
 */
function withTrueRecord<T>(fn: (setup: GuardSetup, rec: ReplyGuardRecordDir) => T): T {
  const rec = makeReplyGuardRecordDir({ records: { [TEST_KEY]: RECORD_TRUE } })
  try {
    return fn(defaultSetup(rec), rec)
  } finally {
    rec.cleanup()
  }
}

/** Run the guard under the default record setup (a `true` record for TEST_KEY). */
function runGuard(stdinJson: string): RunResult {
  return withTrueRecord((setup) => spawnGuard(stdinJson, setup))
}

const MISSING_JQ_WARNING = 'slack-reply-guard: jq not found on PATH; failing open\n'

/**
 * Run `fn` with a PATH that is a scratch dir holding only `bash` (for the
 * /usr/bin/env shebang) and `cat` (the stdin read), so `command -v jq` fails.
 */
function withNoJqPath<T>(fn: (shimDir: string) => T): T {
  const tmp = mkdtempSync(join(tmpdir(), 'srg-nojq-'))
  try {
    const shimDir = join(tmp, 'bin')
    mkdirSync(shimDir, { recursive: true })
    for (const name of ['bash', 'cat']) {
      const src = [`/usr/bin/${name}`, `/bin/${name}`].find((p) => existsSync(p))
      if (src === undefined) throw new Error(`missing-jq setup: no ${name} in /usr/bin or /bin`)
      symlinkSync(src, join(shimDir, name))
    }
    return fn(shimDir)
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}

function harness(transcriptPath: string, stopHookActive = false): string {
  return JSON.stringify({
    session_id: 'test-session',
    transcript_path: transcriptPath,
    stop_hook_active: stopHookActive,
  })
}

const REPLY_TOOL = 'mcp__slack-channel-router__reply'

// The unchanged b.wr5 closing text, including the decline sentence.
const TAIL =
  "and you haven't replied. If you meant to answer in Slack, do it now with the " +
  `${REPLY_TOOL} tool. If no reply is needed, just end your turn.`

// b.wr5's two reminder texts, byte for byte. The dm wording with a
// conversation and the fallback channel wording must still equal them.
const B_WR5_DM = `This turn started from a Slack direct message (conversation D0B1ZJJLJ9M) ${TAIL}`
const B_WR5_CHANNEL = `This turn started from a Slack channel message (channel C0B1ZJJLJ9M) ${TAIL}`
const B_WR5_CHANNEL_NO_ID = `This turn started from a Slack channel message ${TAIL}`

type Via = 'dm' | 'mention' | 'broadcast' | 'receive_all_shared' | 'receive_all'
const VIAS: Via[] = ['dm', 'mention', 'broadcast', 'receive_all_shared', 'receive_all']

// Provenance wordings (Epic t1.ob2.s3, Director decision 6).
const WORDING: Record<Via, string> = {
  dm: 'This turn started from a Slack direct message',
  mention: 'This turn started from a Slack message that @mentioned you directly',
  broadcast: 'This turn started from an @here or @channel broadcast in a Slack channel',
  receive_all_shared:
    'This turn started from a message in a Slack channel where you and other personas receive every message',
  receive_all: 'This turn started from a message in a Slack channel where only you receive every message',
}

/** The full reminder line for `via`, naming the conversation when `chatId` is given. */
function reminder(via: Via, chatId?: string): string {
  const where = chatId === undefined ? '' : ` (${via === 'dm' ? 'conversation' : 'channel'} ${chatId})`
  return `${WORDING[via]}${where} ${TAIL}`
}

// ---------------------------------------------------------------------------
// Runtime-derived transcripts. Each copy is the source fixture with its FIRST
// opening <channel …> tag edited as listed and nothing else; the tag is
// unescaped from JSON (\" → "), edited, and re-escaped. Every requested edit
// must hit, so a derived case can never pass vacuously on an unedited tag.
//   author — `user_id="U0TESTAUTHOR"` or `bot_id="B0TESTAUTHOR"` inserted right
//            after `user` (the delivered meta order)
//   user   — the `user` value replaced
//   chatId — the `chat_id` value replaced; null removes the attribute
//   attrs  — raw attribute text inserted right after `ts`, e.g. ` via="dm"`
//            (a delivered tag puts `via` right after `ts`)
// ---------------------------------------------------------------------------
interface TagEdit {
  author?: 'user_id' | 'bot_id'
  user?: string
  chatId?: string | null
  attrs?: string
}

function editOnce(tag: string, re: RegExp, to: (m: string) => string): string {
  if (!re.test(tag)) throw new Error(`derivation: ${re} not found in ${tag}`)
  return tag.replace(re, to)
}

function deriveTranscript(dir: string, fixture: string, edit: TagEdit): string {
  const raw = readFileSync(join(FIX, fixture), 'utf-8')
  const derived = raw.replace(/<channel [^>]*>/, (escaped) => {
    let tag = escaped.replaceAll('\\"', '"')
    if (edit.author) {
      const id = edit.author === 'user_id' ? 'U0TESTAUTHOR' : 'B0TESTAUTHOR'
      tag = editOnce(tag, / user="[^"]*"/, (m) => `${m} ${edit.author}="${id}"`)
    }
    if (edit.user !== undefined) tag = editOnce(tag, / user="[^"]*"/, () => ` user="${edit.user}"`)
    if (edit.chatId === null) tag = editOnce(tag, / chat_id="[^"]*"/, () => '')
    else if (edit.chatId !== undefined) tag = editOnce(tag, / chat_id="[^"]*"/, () => ` chat_id="${edit.chatId}"`)
    if (edit.attrs !== undefined) tag = editOnce(tag, / ts="[^"]*"/, (m) => `${m}${edit.attrs}`)
    return tag.replaceAll('"', '\\"')
  })
  expect(derived).not.toBe(raw)
  const path = join(dir, `derived-${fixture}`)
  writeFileSync(path, derived)
  return path
}

// ---------------------------------------------------------------------------
// SR-6.2 — the seven cases of SRD t1.2qu.u6. Every Slack-wrapper case runs on
// the via-carrying copy of its fixture (the via-less original is in the
// injected-prompt block), so exit 2 can only come from a delivered message.
// ---------------------------------------------------------------------------

describe('slack-reply-guard.sh — SR-6.2 exit-code contract', () => {
  test.each([
    ['case 1', 'via-slack-with-reply.jsonl', 'delivered Slack msg + reply tool_use'],
    ['case 3', 'non-slack.jsonl', 'non-Slack latest user msg'],
    ['case 7b', 'via-slack-then-sidechain-with-reply.jsonl', 'trailing sidechain entries + reply present'],
  ])('SR-6.2 %s: %s (%s) → exit 0, no output', (_case, fixture) => {
    const r = runGuard(harness(join(FIX, fixture)))
    expect(r.exitCode).toBe(0)
    expect(r.stderr).toBe('')
    expect(r.stdout).toBe('')
  })

  test.each([
    ['case 2', 'via-slack-no-reply.jsonl', 'delivered Slack msg + no reply', reminder('mention', 'C555')],
    [
      'case 6',
      'via-slack-then-toolresult-no-reply.jsonl',
      'trailing tool_result-only user entries do not displace the trigger',
      reminder('broadcast', 'C321'),
    ],
    [
      'case 7a',
      'via-slack-then-sidechain-no-reply.jsonl',
      'trailing sidechain entries + no reply',
      reminder('receive_all_shared', 'C777'),
    ],
  ])('SR-6.2 %s: %s (%s) → exit 2, stderr is the via wording naming the tool', (_case, fixture, _label, line) => {
    const r = runGuard(harness(join(FIX, fixture)))
    expect(r.exitCode).toBe(2)
    expect(r.stderr).toBe(`${line}\n`)
    expect(r.stderr).toContain(REPLY_TOOL)
  })

  test('SR-6.2 case 4: stop_hook_active=true on a delivered no-reply transcript (via-slack-no-reply.jsonl) under a true record → exit 0; the same run with stop_hook_active=false (control) → exit 2', () => {
    withTrueRecord((setup) => {
      const transcript = join(FIX, 'via-slack-no-reply.jsonl')
      const r = spawnGuard(harness(transcript, true), setup)
      expect(r.exitCode).toBe(0)
      expect(r.stderr).toBe('')
      // Control: same record, argument, CSCB_PERSONA and transcript; only
      // stop_hook_active changes, so the exit 0 above came from the retry path.
      const control = spawnGuard(harness(transcript, false), setup)
      expect(control.exitCode).toBe(2)
      expect(control.stderr).toBe(`${reminder('mention', 'C555')}\n`)
    })
  })

  // -------------------------------------------------------------------------
  // Case 5 — Fail-open modes: missing / unreadable / empty / malformed
  // transcript, missing transcript_path field, and missing jq (via a
  // restricted PATH). All → exit 0. Missing jq prints the guard's one-line
  // warning (permitted by SR-1.6); the test asserts that exact line, so it
  // proves the exit 0 came from the missing-jq branch.
  // -------------------------------------------------------------------------
  describe('SR-6.2 case 5: fail-open', () => {
    test('missing transcript_path field on stdin → exit 0', () => {
      const r = runGuard(
        JSON.stringify({ session_id: 's', stop_hook_active: false }),
      )
      expect(r.exitCode).toBe(0)
      expect(r.stderr).toBe('')
    })

    test('empty stdin → exit 0', () => {
      const r = runGuard('')
      expect(r.exitCode).toBe(0)
      expect(r.stderr).toBe('')
    })

    test('transcript_path points at a missing file → exit 0', () => {
      const r = runGuard(harness('/does/not/exist/at/all.jsonl'))
      expect(r.exitCode).toBe(0)
      expect(r.stderr).toBe('')
    })

    test('transcript is an unreadable file → exit 0', () => {
      const tmp = mkdtempSync(join(tmpdir(), 'srg-unread-'))
      try {
        const p = join(tmp, 'transcript.jsonl')
        writeFileSync(p, 'anything\n')
        chmodSync(p, 0o000)
        const r = runGuard(harness(p))
        expect(r.exitCode).toBe(0)
        expect(r.stderr).toBe('')
      } finally {
        try {
          chmodSync(join(tmp, 'transcript.jsonl'), 0o600)
        } catch {}
        rmSync(tmp, { recursive: true, force: true })
      }
    })

    test('empty transcript file → exit 0', () => {
      const r = runGuard(harness(join(FIX, 'empty.jsonl')))
      expect(r.exitCode).toBe(0)
      expect(r.stderr).toBe('')
    })

    test('malformed transcript (unparseable lines) → exit 0', () => {
      const r = runGuard(harness(join(FIX, 'malformed.jsonl')))
      expect(r.exitCode).toBe(0)
      expect(r.stderr).toBe('')
    })

    test('malformed JSON on stdin → exit 0', () => {
      const r = runGuard('{not valid json at all')
      expect(r.exitCode).toBe(0)
    })

    test('jq missing from PATH on a delivered no-reply transcript (via-slack-no-reply.jsonl) under a true record → exit 0 with the one-line missing-jq warning; the same run with the full PATH (control) → exit 2', () => {
      withNoJqPath((shimDir) =>
        withTrueRecord((setup) => {
          const input = harness(join(FIX, 'via-slack-no-reply.jsonl'))
          // The restricted PATH carries the same record, argument and
          // explicit CSCB_PERSONA as the control.
          const r = spawnGuard(input, { ...setup, path: shimDir })
          // The guard's missing-jq warning, exactly: the exit 0 came from the
          // missing-jq branch, not from an earlier failure (bash or cat
          // missing), the record gate or the transcript.
          expect(r.exitCode).toBe(0)
          expect(r.stderr).toBe(MISSING_JQ_WARNING)
          expect(r.stdout).toBe('')
          // Control: only PATH changes.
          const control = spawnGuard(input, setup)
          expect(control.exitCode).toBe(2)
          expect(control.stderr).toBe(`${reminder('mention', 'C555')}\n`)
        }),
      )
    })
  })
})

// ---------------------------------------------------------------------------
// Additional fixtures (beyond the seven SR-6.2 cases).
//
// SR-6.3 — Verbatim live-transcript fixture verbatim-live-with-reply.jsonl.
//   Bot            : claude-infhub (CSCB "infhub" bot)
//   Slack channel  : C0B1ZJJLJ9M
//   Session id     : 598f62cf-c0b1-45de-86e5-6e7c50f99c86
//   Source         : /home/horde/.claude-infhub/projects/
//                    -home-horde-projects-claude-slack-channel-bots-project/
//                    598f62cf-c0b1-45de-86e5-6e7c50f99c86.jsonl (line 954)
//   Entry uuid     : 85edc61a-a85a-469b-96ef-be6827560690
//   Entry timestamp: 2026-09-19T17:53:41.612Z
//   Captured on    : 2026-09-19
//   Redactions     : the human display name in the `user` attribute is
//                    replaced with "Operator"; everything else is the full
//                    JSONL entry copied byte-for-byte from the live
//                    transcript. The `<channel source="slack-channel-router"
//                    chat_id="..." message_id="..." user="Operator" ts="...">`
//                    tag is otherwise preserved verbatim (as JSON-escaped in
//                    the JSONL); body text is unredacted.
//
// Approved deviation (recorded per subtask t3.osj.jg.ut.ah instructions):
//   Live capture proved real bots render `source="slack-channel-router"`,
//   not `source="slack"`, so the guard treats any `source` starting with
//   `slack` as Slack. The case runs on via-verbatim-live-with-reply.jsonl (the
//   original plus `via="receive_all"`); the no-reply half is asserted on
//   via-verbatim-live-no-reply.jsonl in the via-copies block below.
// ---------------------------------------------------------------------------

describe('slack-reply-guard.sh — additional fixtures', () => {
  test.each([
    ['negative-control-server-name.jsonl', 'negative control: string "slack-channel-router" without <channel source="slack'],
    ['no-real-user-message.jsonl', 'no real user message anywhere (assistant + tool_result + sidechain only)'],
    ['via-verbatim-live-with-reply.jsonl', 'SR-6.3: verbatim live transcript (source="slack-channel-router", via="receive_all") + reply present'],
  ])('%s (%s) → exit 0, silent', (fixture) => {
    const r = runGuard(harness(join(FIX, fixture)))
    expect(r.exitCode).toBe(0)
    expect(r.stderr).toBe('')
  })
})

// ---------------------------------------------------------------------------
// b.ob2 SR-9.4 / SR-14 — a wrapper carrying `via` is a delivered Slack message
// and its reminder states the provenance of the last delivered message in the
// trigger run. Per-`via` fixtures are checked in (provenance below); the other
// cases derive temp transcripts from verbatim-live-no-reply.jsonl (or, for the
// retired b.ob2 E4 rows and the non-Slack envelope case, the fixture named in
// the test) with deriveTranscript.
// ---------------------------------------------------------------------------

describe('slack-reply-guard.sh — via detection and provenance wordings (b.ob2 SR-9.4)', () => {
  let tmp: string
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'srg-via-'))
  })
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true })
  })

  test.each([
    ['dm-no-reply.jsonl', 'dm', 'D0B1ZJJLJ9M'],
    ['mention-no-reply.jsonl', 'mention', 'C0B1ZJJLJ9M'],
    ['broadcast-no-reply.jsonl', 'broadcast', 'C0B1ZJJLJ9M'],
    ['receive-all-shared-no-reply.jsonl', 'receive_all_shared', 'C0B1ZJJLJ9M'],
    ['receive-all-no-reply.jsonl', 'receive_all', 'C0B1ZJJLJ9M'],
  ] as const)('per-via fixture %s (via=%s) → exit 2 once, stderr is its wording naming %s; the stop_hook_active retry exits 0 silently', (fixture, via, chatId) => {
    const r = runGuard(harness(join(FIX, fixture)))
    expect(r.exitCode).toBe(2)
    expect(r.stderr).toBe(`${reminder(via, chatId)}\n`)
    // SR-14: reminded once — the harness's retry (stop_hook_active=true) passes.
    const retry = runGuard(harness(join(FIX, fixture), true))
    expect(retry.exitCode).toBe(0)
    expect(retry.stderr).toBe('')
    expect(retry.stdout).toBe('')
  })

  // dm-no-reply.jsonl's stderr must equal b.wr5's DM text byte for byte. The
  // file is the same bytes as via-dm-from-live-no-reply.jsonl, whose row in the
  // via-copies block asserts B_WR5_DM; this pins the identity that makes that
  // row cover dm-no-reply.jsonl too (and likewise receive-all-no-reply.jsonl ≡
  // via-verbatim-live-no-reply.jsonl).
  test.each([
    ['dm-no-reply.jsonl', 'via-dm-from-live-no-reply.jsonl'],
    ['receive-all-no-reply.jsonl', 'via-verbatim-live-no-reply.jsonl'],
  ])('%s is byte-identical to %s', (a, b) => {
    expect(readFileSync(join(FIX, a))).toEqual(readFileSync(join(FIX, b)))
  })

  test('the five per-via wordings are pairwise different and none is b.wr5\'s channel wording', () => {
    const fixtures = ['dm', 'mention', 'broadcast', 'receive-all-shared', 'receive-all'].map((v) => `${v}-no-reply.jsonl`)
    // Each fixture's stderr with the " (channel|conversation <id>)" part cut out.
    const wordings = fixtures.map((f) =>
      runGuard(harness(join(FIX, f))).stderr.replace(/ \((?:channel|conversation) [A-Z0-9]+\)/, ''),
    )
    expect(new Set(wordings).size).toBe(5)
    expect(wordings).not.toContain(`${B_WR5_CHANNEL_NO_ID}\n`)
  })

  // chat_id absent, or present but not a Slack id (^[A-Z0-9]+$ fails). Every
  // via runs with chat_id absent and with a Telegram-style negative id; the
  // lowercase id and the empty value run on one via only, since the chat_id
  // test does not depend on via.
  test.each([
    ...VIAS.flatMap((via) => ([null, '-1001234567890'] as const).map((chatId) => [via, chatId] as const)),
    ['dm', 'c0b1zjjlj9m'] as const,
    ['dm', ''] as const,
  ])('via=%s with chat_id %p → exit 2, wording omits the conversation', (via, chatId) => {
    const p = deriveTranscript(tmp, 'verbatim-live-no-reply.jsonl', { chatId, attrs: ` via="${via}"` })
    const r = runGuard(harness(p))
    expect(r.exitCode).toBe(2)
    expect(r.stderr).toBe(`${reminder(via)}\n`)
  })

  test.each([
    ['', 'C0B1ZJJLJ9M', B_WR5_CHANNEL],
    ['', null, B_WR5_CHANNEL_NO_ID],
    ['thread_reply', 'C0B1ZJJLJ9M', B_WR5_CHANNEL],
    ['thread_reply', null, B_WR5_CHANNEL_NO_ID],
    ['DM', 'D0B1ZJJLJ9M', `This turn started from a Slack channel message (channel D0B1ZJJLJ9M) ${TAIL}`],
    ['receive_all ', 'C0B1ZJJLJ9M', B_WR5_CHANNEL],
  ] as const)('unknown via=%p with chat_id %p → exit 2 with b.wr5\'s channel wording, raw via never echoed', (via, chatId, line) => {
    const p = deriveTranscript(tmp, 'verbatim-live-no-reply.jsonl', { chatId, attrs: ` via="${via}"` })
    const r = runGuard(harness(p))
    expect(r.exitCode).toBe(2)
    expect(r.stderr).toBe(`${line}\n`)
    if (via.trim() !== '') expect(r.stderr).not.toContain(via.trim())
  })

  test.each([
    ['dm', 'C0B1ZJJLJ9M', 'a C-prefixed chat_id still gets the DM wording'],
    ['mention', 'D0B1ZJJLJ9M', 'a D-prefixed chat_id does not make a mention a DM'],
    ['receive_all', 'D0B1ZJJLJ9M', 'a D-prefixed chat_id does not make a receive_all message a DM'],
  ] as const)('via selects the wording: via=%s with chat_id %s → %s', (via, chatId) => {
    const p = deriveTranscript(tmp, 'verbatim-live-no-reply.jsonl', { chatId, attrs: ` via="${via}"` })
    const r = runGuard(harness(p))
    expect(r.exitCode).toBe(2)
    expect(r.stderr).toBe(`${reminder(via, chatId)}\n`)
  })

  test('last delivered message wins: dm-then-mention-no-reply.jsonl (DM then mention, no reply) → exit 2 with the mention wording', () => {
    const r = runGuard(harness(join(FIX, 'dm-then-mention-no-reply.jsonl')))
    expect(r.exitCode).toBe(2)
    expect(r.stderr).toBe(`${reminder('mention', 'C0B1ZJJLJ9M')}\n`)
  })

  test('via replaces b.wr5\'s cscb-cron:/ts test: cron-shape-with-via-no-reply.jsonl (cscb-cron: user, 3-decimal ts, via) → exit 2', () => {
    const r = runGuard(harness(join(FIX, 'cron-shape-with-via-no-reply.jsonl')))
    expect(r.exitCode).toBe(2)
    expect(r.stderr).toBe(`${reminder('receive_all', 'C0B1ZJJLJ9M')}\n`)
  })

  // Attributes are read as whole names, left to right, from whitespace-led
  // name="value" pairs: neither a longer name ending in `via` nor ` via=`
  // inside another attribute's value marks a message as delivered.
  test.each([
    ['x_via="dm" and no via', { attrs: ' x_via="dm"' }],
    ['sender label user="Operator via=" and no via', { user: 'Operator via=' }],
  ] as const)('attribute parsing: %s → exit 0, silent (no via attribute)', (_label, edit) => {
    const r = runGuard(harness(deriveTranscript(tmp, 'verbatim-live-no-reply.jsonl', edit)))
    expect(r.exitCode).toBe(0)
    expect(r.stderr).toBe('')
  })

  test('attribute parsing: a real via after a sender label containing " via=" is still read → exit 2 with its wording', () => {
    const p = deriveTranscript(tmp, 'verbatim-live-no-reply.jsonl', { user: 'Operator via=', attrs: ' via="broadcast"' })
    const r = runGuard(harness(p))
    expect(r.exitCode).toBe(2)
    expect(r.stderr).toBe(`${reminder('broadcast', 'C0B1ZJJLJ9M')}\n`)
  })

  // Retired b.ob2 E4 rows (tags carrying `user_id` / `bot_id` and `via`), now
  // asserting the via result instead of parity with the via-less original.
  test.each([
    [
      'verbatim-live-no-reply.jsonl',
      'user_id',
      'mention',
      'exit 2 with the mention wording naming channel C0B1ZJJLJ9M',
      2,
      `${reminder('mention', 'C0B1ZJJLJ9M')}\n`,
    ],
    [
      'verbatim-live-no-reply.jsonl',
      'bot_id',
      'receive_all',
      'exit 2 with the receive_all wording naming channel C0B1ZJJLJ9M',
      2,
      `${reminder('receive_all', 'C0B1ZJJLJ9M')}\n`,
    ],
    [
      'slack-no-reply.jsonl',
      'user_id',
      'receive_all_shared',
      'exit 2 with the receive_all_shared wording naming channel C555',
      2,
      `${reminder('receive_all_shared', 'C555')}\n`,
    ],
    ['verbatim-live-with-reply.jsonl', 'user_id', 'mention', 'exit 0, silent (reply present)', 0, ''],
  ] as const)('%s with %s and via=%s → %s', (fixture, author, via, _outcome, exitCode, stderr) => {
    const r = runGuard(harness(deriveTranscript(tmp, fixture, { author, attrs: ` via="${via}"` })))
    expect(r.exitCode).toBe(exitCode)
    expect(r.stderr).toBe(stderr)
  })

  // The Slack-source check (SR-6.2 case 3, kept under b.av2 SR-11): only a
  // `source="slack…"` envelope can be a delivered message. A telegram envelope carrying `via` (its body quoting a
  // via-less Slack wrapper) is not Slack, so it never triggers the reminder.
  test('non-Slack envelope carrying via: telegram-quoting-slack-wrapper-no-reply.jsonl with via="mention" on the telegram tag → exit 0, silent', () => {
    const p = deriveTranscript(tmp, 'telegram-quoting-slack-wrapper-no-reply.jsonl', { attrs: ' via="mention"' })
    expect(readFileSync(p, 'utf-8')).toContain('<channel source=\\"telegram\\" chat_id=\\"C0B1ZJJLJ9M\\" message_id=\\"1789840421.151669\\" user=\\"Operator\\" ts=\\"1789840421.151669\\" via=\\"mention\\">')
    const r = runGuard(harness(p))
    expect(r.exitCode).toBe(0)
    expect(r.stderr).toBe('')
    expect(r.stdout).toBe('')
  })
})

// ---------------------------------------------------------------------------
// Fixture provenance.
//
// b.wr5 fixtures (all read from the claude-infhub bot's transcripts under
// ~/.claude-infhub/projects/-home-horde-projects-claude-slack-channel-bots-project/,
// captured 2026-09-23). Only the message content string was edited, and only
// where noted; every other field of each JSONL entry is byte-for-byte.
//
//   verbatim-cron-no-reply.jsonl
//     eed8b45a-f705-489c-81d1-fb110e4c46d6.jsonl line 23912, the
//     2026-09-23T06:00:00Z grooming-tick delivery that the bug report
//     describes (user="cscb-cron:grooming-tick", ts="1790143200.002").
//     Redaction: the human's first name in the body → "Operator".
//   cron-quoting-slack-wrapper-no-reply.jsonl
//     DERIVED from the cron fixture above: a quoted real-shaped Slack wrapper
//     (six-digit ts, from a real channel message id) appended to the body
//     before the closing </channel>. Not a real transcript entry.
//   verbatim-interject-no-reply.jsonl
//     598f62cf-c0b1-45de-86e5-6e7c50f99c86.jsonl line 4631, an /interject
//     delivery (user="interject", ts="1789861303.035"). No edits.
//   verbatim-interject-custom-label-no-reply.jsonl
//     eed8b45a-f705-489c-81d1-fb110e4c46d6.jsonl line 544, an /interject
//     delivery with a caller-supplied label (user="agent_director bot") and
//     a two-decimal ts ("1789916660.95" — Date.now()/1000 with a trailing
//     zero dropped). Body trimmed to its first paragraph.
//   dm-from-live-no-reply.jsonl
//     DERIVED: no real Slack DM transcript exists on the capture host, so this
//     is verbatim-live-no-reply.jsonl with ONLY chat_id changed from
//     C0B1ZJJLJ9M to the D-prefixed D0B1ZJJLJ9M.
//   verbatim-compact-summary-after-reply.jsonl
//     Lines 1–2 are verbatim-live-with-reply.jsonl (a replied channel
//     message). Line 3 is eed8b45a-f705-489c-81d1-fb110e4c46d6.jsonl line
//     6083, a real isCompactSummary entry whose summary text quotes a
//     `<channel source="slack-channel-router" ...>` tag. Body trimmed to the
//     opening sentence and the one paragraph containing that quote.
//
// b.wr5 DERIVED fixtures are built from the lines above by the one edit named
// and nothing else. "Unreplied assistant entry" = line 2 of
// verbatim-live-with-reply.jsonl with its reply tool_use block removed (only
// the "Concur." text block is left).
//
//   slack-no-chat-id-no-reply.jsonl
//     verbatim-live-no-reply.jsonl with the chat_id attribute removed.
//   cron-six-decimal-ts-no-reply.jsonl
//     verbatim-cron-no-reply.jsonl with message_id and ts changed from
//     "1790143200.002" to the Slack-shaped "1790143200.002000".
//   interject-whole-second-ts-no-reply.jsonl
//     verbatim-interject-no-reply.jsonl with message_id and ts changed from
//     "1789861303.035" to "1789861303" (what String(Date.now() / 1000) gives
//     on an exact second).
//   interject-persona-meta-no-reply.jsonl
//     verbatim-interject-custom-label-no-reply.jsonl with the chat_id and
//     message_id attributes removed from its opening <channel> tag: the
//     persona-targeted /interject meta of b.av2 SR-9.2 (user and ts only).
//     Source, user and the "1789916660.95" ts are unchanged.
//   compact-summary-no-reply.jsonl
//     verbatim-compact-summary-after-reply.jsonl with line 2 replaced by the
//     unreplied assistant entry. The assistant entry sits between the Slack
//     message and the summary, so the summary would start a new trigger run
//     (and hide the Slack message) if it counted as a real user message.
//   plain-quoting-slack-wrapper-no-reply.jsonl
//     verbatim-live-no-reply.jsonl with "Quoted from Slack:\n" prepended to
//     the content, so the Slack wrapper is quoted mid-text instead of opening
//     the message.
//   telegram-quoting-slack-wrapper-no-reply.jsonl
//     verbatim-live-no-reply.jsonl with its content wrapped in a copy of its
//     own opening tag whose source is changed to "telegram" (plus the closing
//     </channel>): a non-Slack envelope whose body quotes the Slack wrapper.
//   channel-then-cron-no-reply.jsonl
//     verbatim-live-no-reply.jsonl line, then verbatim-cron-no-reply.jsonl line.
//   dm-then-interject-no-reply.jsonl
//     dm-from-live-no-reply.jsonl line, then verbatim-interject-no-reply.jsonl line.
//   cron-then-interject-no-reply.jsonl
//     verbatim-cron-no-reply.jsonl line, then verbatim-interject-no-reply.jsonl line.
//   channel-assistant-then-cron-no-reply.jsonl
//     verbatim-live-no-reply.jsonl line, the unreplied assistant entry, then
//     verbatim-cron-no-reply.jsonl line.
//
// b.ob2 E10 NEW fixtures (Subtask t3.ob2.s3.2s.8j). Unless noted, the one edit
// is ` via="<v>"` inserted right after `ts` in the opening <channel> tag.
//
//   dm-no-reply.jsonl                  dm-from-live-no-reply.jsonl + via="dm"
//   mention-no-reply.jsonl             verbatim-live-no-reply.jsonl + via="mention"
//   broadcast-no-reply.jsonl           verbatim-live-no-reply.jsonl + via="broadcast"
//   receive-all-shared-no-reply.jsonl  verbatim-live-no-reply.jsonl + via="receive_all_shared"
//   receive-all-no-reply.jsonl         verbatim-live-no-reply.jsonl + via="receive_all"
//
//   Same source and same edit, so the same bytes (asserted in the per-via
//   block): dm-no-reply.jsonl ≡ via-dm-from-live-no-reply.jsonl and
//   receive-all-no-reply.jsonl ≡ via-verbatim-live-no-reply.jsonl (the
//   DERIVED COPIES below).
//   dm-then-mention-no-reply.jsonl
//     line 1 is dm-from-live-no-reply.jsonl + via="dm"; line 2 is
//     verbatim-live-no-reply.jsonl + via="mention".
//   cron-shape-with-via-no-reply.jsonl verbatim-cron-no-reply.jsonl + via="receive_all"
//   injected-no-reply.jsonl
//     verbatim-cron-no-reply.jsonl with two edits: chat_id and message_id
//     removed from the tag (the injected meta is user and ts only), and the
//     body replaced (its first line kept, then "Check whether any worker is
//     waiting on you and act on it. No reply is needed: do not post to Slack
//     for this reminder.").
//
// b.ob2 E10 DERIVED COPIES (Subtask t3.ob2.s3.2s.jk), named via-<original>.jsonl.
// The one edit is ` via="<v>"` added to the Slack tag(s) listed: right after
// `ts`, or as the last attribute where the tag has no `ts`, or before the
// `...` of an elided tag quoted in a compaction summary. Nothing else changes.
//
//   original                                   via                  tags edited
//   slack-no-reply                             mention              the Slack message
//   slack-with-reply                           mention              sidechain line 5 and main line 6
//   slack-then-toolresult-no-reply             broadcast            the Slack message
//   slack-then-sidechain-no-reply              receive_all_shared   the Slack message
//   slack-then-sidechain-with-reply            receive_all_shared   the Slack message
//   verbatim-live-no-reply                     receive_all          the Slack message
//   verbatim-live-with-reply                   receive_all          the Slack message
//   dm-from-live-no-reply                      dm                   the Slack message
//   slack-no-chat-id-no-reply                  mention              the Slack message
//   channel-then-cron-no-reply                 receive_all          line 1 only (cron line untouched)
//   dm-then-interject-no-reply                 dm                   line 1 only (/interject untouched)
//   channel-assistant-then-cron-no-reply       receive_all          line 1 only (cron line untouched)
//   compact-summary-no-reply                   receive_all          line 1 and the elided quote in line 3
//   verbatim-compact-summary-after-reply       receive_all          line 1 and the elided quote in line 3
//   plain-quoting-slack-wrapper-no-reply       broadcast            the quoted wrapper
//   telegram-quoting-slack-wrapper-no-reply    receive_all_shared   the quoted Slack wrapper only
//   cron-quoting-slack-wrapper-no-reply        mention              the quoted Slack wrapper only
//
// RUNTIME-DERIVED transcripts (deriveTranscript, written to the describe
// block's mkdtempSync directory and removed after each test, never checked
// in). Each is the named source with its first opening tag edited as follows:
//   - omitted conversation: verbatim-live-no-reply.jsonl + ` via="<v>"` after
//     `ts`, with chat_id removed or its value set to "-1001234567890" (every
//     v), or set to "c0b1zjjlj9m" or "" (v = "dm" only).
//   - unknown via: verbatim-live-no-reply.jsonl + ` via="<v>"` after `ts`
//     (v = "", "thread_reply", "DM", "receive_all "), chat_id set to the
//     value in the row or removed.
//   - via selects the wording: verbatim-live-no-reply.jsonl + ` via="<v>"`
//     after `ts`, chat_id set to C0B1ZJJLJ9M or D0B1ZJJLJ9M.
//   - attribute parsing: verbatim-live-no-reply.jsonl with ` x_via="dm"` after
//     `ts`, or the `user` value changed to "Operator via=", no `via`; plus
//     one with the user value "Operator via=" AND ` via="broadcast"` after
//     `ts`.
//   - retired b.ob2 E4 rows (formerly `deriveWithViaTag`): the row's fixture
//     with `user_id="U0TESTAUTHOR"` or `bot_id="B0TESTAUTHOR"` inserted right
//     after `user` and ` via="<v>"` after `ts` (E4 appended `via` last; the
//     guard reads attributes by name, so the position does not matter). E4
//     asserted parity with the via-less original; these rows now assert the
//     via result.
//   - non-Slack envelope carrying via: telegram-quoting-slack-wrapper-no-reply.jsonl
//     with ` via="mention"` after `ts` in its first opening tag, the telegram
//     envelope (the quoted Slack wrapper in its body is left via-less).
// ---------------------------------------------------------------------------

describe('slack-reply-guard.sh — injected prompts (no via) never trigger the reminder', () => {
  test('AC 51: injected-no-reply.jsonl (scheduled prompt, user and ts only, asks for no reply) under a true record, the record directory argument and CSCB_PERSONA → exit 0, silent', () => {
    withTrueRecord((setup, rec) => {
      expect(rec.readRecord(TEST_KEY)).toBe(RECORD_TRUE)
      const r = spawnGuard(harness(join(FIX, 'injected-no-reply.jsonl')), setup)
      expect(r.exitCode).toBe(0)
      expect(r.stderr).toBe('')
      expect(r.stdout).toBe('')
      // Control: the same setup reminds for a delivered message, so the exit 0
      // above is the injected prompt's, not the record gate's.
      const control = spawnGuard(harness(join(FIX, 'mention-no-reply.jsonl')), setup)
      expect(control.exitCode).toBe(2)
      expect(control.stderr).toBe(`${reminder('mention', 'C0B1ZJJLJ9M')}\n`)
    })
  })

  test.each([
    // b.wr5's injected prompts.
    ['verbatim-cron-no-reply.jsonl', 'cscb_cron scheduled prompt, no via'],
    ['cron-six-decimal-ts-no-reply.jsonl', 'cscb_cron prompt with a Slack-shaped ts — no via, so injected whatever its ts'],
    ['verbatim-interject-no-reply.jsonl', '/interject with the default sender label, no via'],
    ['verbatim-interject-custom-label-no-reply.jsonl', '/interject with a custom sender label, no via'],
    ['interject-whole-second-ts-no-reply.jsonl', '/interject sent on an exact second (whole-number ts), no via'],
    ['interject-persona-meta-no-reply.jsonl', 'persona-targeted /interject — meta is user and ts only, no chat_id, message_id or via'],
    ['cron-then-interject-no-reply.jsonl', 'cron then /interject back to back, neither has via'],
    ['cron-quoting-slack-wrapper-no-reply.jsonl', 'cron envelope quoting a via-less Slack wrapper'],
    ['plain-quoting-slack-wrapper-no-reply.jsonl', 'plain message quoting a via-less Slack wrapper mid-text'],
    ['telegram-quoting-slack-wrapper-no-reply.jsonl', 'non-Slack envelope whose body quotes a via-less Slack wrapper'],
    ['channel-assistant-then-cron-no-reply.jsonl', 'via-less channel message, assistant entry, then cron'],
    ['verbatim-compact-summary-after-reply.jsonl', 'via-less replied channel message, then a compaction summary quoting a wrapper'],
    // Originals b.wr5 and SR-6.2 asserted exit 2: their wrapper has no via.
    ['slack-no-reply.jsonl', 'SR-6.2 case 2 original — no via, so injected'],
    ['slack-then-toolresult-no-reply.jsonl', 'SR-6.2 case 6 original — no via, so injected'],
    ['slack-then-sidechain-no-reply.jsonl', 'SR-6.2 case 7a original — no via, so injected'],
    ['verbatim-live-no-reply.jsonl', 'SR-6.3 verbatim channel message — no via, so injected'],
    ['dm-from-live-no-reply.jsonl', 'D-prefixed chat_id but no via — injected, not a DM'],
    ['slack-no-chat-id-no-reply.jsonl', 'wrapper without chat_id or via'],
    ['channel-then-cron-no-reply.jsonl', 'via-less channel message then cron back to back'],
    ['dm-then-interject-no-reply.jsonl', 'via-less DM-shaped message then /interject back to back'],
    ['compact-summary-no-reply.jsonl', 'via-less unreplied channel message, assistant entry, then compaction summary'],
    // Originals that exited 0 on their reply; still exit 0 with no via.
    ['slack-with-reply.jsonl', 'SR-6.2 case 1 original — no via (reply also present)'],
    ['slack-then-sidechain-with-reply.jsonl', 'SR-6.2 case 7b original — no via (reply also present)'],
    ['verbatim-live-with-reply.jsonl', 'SR-6.3 original — no via (reply also present)'],
  ])('%s (%s) → exit 0, silent', (fixture) => {
    const r = runGuard(harness(join(FIX, fixture)))
    expect(r.exitCode).toBe(0)
    expect(r.stderr).toBe('')
  })
})

// ---------------------------------------------------------------------------
// b.wr5 cases on their via-carrying copies: each copy keeps its original's
// b.wr5 result, and exit-2 copies get the wording of their via.
// ---------------------------------------------------------------------------

describe('slack-reply-guard.sh — b.wr5 cases on via-carrying copies', () => {
  test.each([
    ['via-channel-assistant-then-cron-no-reply.jsonl', 'unreplied delivered message, assistant entry, then cron — the assistant entry ends the run'],
    ['via-cron-quoting-slack-wrapper-no-reply.jsonl', 'cron envelope quoting a via-carrying Slack wrapper — only the envelope at the start counts'],
    ['via-plain-quoting-slack-wrapper-no-reply.jsonl', 'plain message quoting a via-carrying Slack wrapper mid-text'],
    ['via-telegram-quoting-slack-wrapper-no-reply.jsonl', 'non-Slack envelope whose body quotes a via-carrying Slack wrapper'],
    ['via-verbatim-compact-summary-after-reply.jsonl', 'replied delivered message, then a compaction summary quoting a via-carrying wrapper'],
  ])('no reminder: %s (%s) → exit 0, silent', (fixture) => {
    const r = runGuard(harness(join(FIX, fixture)))
    expect(r.exitCode).toBe(0)
    expect(r.stderr).toBe('')
  })

  test.each([
    ['via-verbatim-live-no-reply.jsonl', 'SR-6.3 verbatim channel message', `${reminder('receive_all', 'C0B1ZJJLJ9M')}\n`],
    ['via-dm-from-live-no-reply.jsonl', 'direct message — b.wr5\'s DM text byte for byte', `${B_WR5_DM}\n`],
    ['via-slack-no-chat-id-no-reply.jsonl', 'wrapper without chat_id — wording omits the conversation', `${reminder('mention')}\n`],
    ['via-channel-then-cron-no-reply.jsonl', 'delivered message then cron back to back — cron does not hide it', `${reminder('receive_all', 'C0B1ZJJLJ9M')}\n`],
    ['via-dm-then-interject-no-reply.jsonl', 'DM then /interject back to back — /interject does not hide it', `${reminder('dm', 'D0B1ZJJLJ9M')}\n`],
    [
      'via-compact-summary-no-reply.jsonl',
      'unreplied delivered message, assistant entry, then compaction summary — the summary is skipped',
      `${reminder('receive_all', 'C0B1ZJJLJ9M')}\n`,
    ],
  ])('delivered Slack message, no reply: %s (%s) → exit 2 with the declinable reminder', (fixture, _label, stderr) => {
    const r = runGuard(harness(join(FIX, fixture)))
    expect(r.exitCode).toBe(2)
    expect(r.stderr).toBe(stderr)
  })

  test('b.wr5 retry with stop_hook_active=true: via-verbatim-live-no-reply.jsonl under a true record → exit 0, silent (reminder shown once); the same run with stop_hook_active=false (control) → exit 2', () => {
    withTrueRecord((setup) => {
      const transcript = join(FIX, 'via-verbatim-live-no-reply.jsonl')
      const r = spawnGuard(harness(transcript, true), setup)
      expect(r.exitCode).toBe(0)
      expect(r.stderr).toBe('')
      // Control: only stop_hook_active changes.
      const control = spawnGuard(harness(transcript, false), setup)
      expect(control.exitCode).toBe(2)
      expect(control.stderr).toBe(`${reminder('receive_all', 'C0B1ZJJLJ9M')}\n`)
    })
  })
})

// ---------------------------------------------------------------------------
// b.av2 SR-9.4 — the per-persona record gate. The guard reminds only when the
// record `<argument>/<CSCB_PERSONA>` reads `true` (one trailing newline
// tolerated); anything else is a silent exit 0 (fail-open). Every case runs on
// mention-no-reply.jsonl, which exits 2 with GATE_LINE under the default
// setup (the positive control below), so each exit 0 comes from the gate.
// Each case builds its own helper record directory and GuardSetup; the parent
// process's CSCB_PERSONA is set to TEST_KEY during every run, so a runner
// that leaked it into the child would turn the unset case into an exit 2.
// ---------------------------------------------------------------------------

const GATE_FIXTURE = 'mention-no-reply.jsonl'
const GATE_LINE = `${reminder('mention', 'C0B1ZJJLJ9M')}\n`
const NEIGHBOUR_KEY = 'reply_guard_neighbour'
// A hashed key of the maximum length (40-character stem, `_`, 8 hex digits).
const HASHED_KEY = personaKey(`Reply Guard ${'x'.repeat(40)}`)

interface GateCase {
  /** Records to write up front (key to content); none means no record directory. */
  records?: Record<string, string>
  /** Create the (empty) record directory even with no records. */
  createRecordDir?: boolean
  /** Put the state directory under a parent whose name has a space and a quote. */
  spaceAndQuote?: boolean
  /** Extra setup under the state directory, before the run. */
  prepare?: (rec: ReplyGuardRecordDir) => void
  /** The run's setup; defaults to defaultSetup(rec). */
  setup?: (rec: ReplyGuardRecordDir) => GuardSetup
}

function runGateCase(c: GateCase, opts: { path?: string } = {}): RunResult {
  const rec = makeReplyGuardRecordDir({
    records: c.records,
    createRecordDir: c.createRecordDir,
    spaceAndQuote: c.spaceAndQuote,
  })
  const saved = process.env.CSCB_PERSONA
  process.env.CSCB_PERSONA = TEST_KEY
  try {
    c.prepare?.(rec)
    const setup = c.setup?.(rec) ?? defaultSetup(rec)
    return spawnGuard(harness(join(FIX, GATE_FIXTURE)), { ...setup, path: opts.path ?? setup.path })
  } finally {
    if (saved === undefined) delete process.env.CSCB_PERSONA
    else process.env.CSCB_PERSONA = saved
    rec.cleanup()
  }
}

const TRUE_RECORD = { [TEST_KEY]: RECORD_TRUE }

describe('slack-reply-guard.sh — per-persona record gate (b.av2 SR-9.4)', () => {
  test.each<[string, GateCase]>([
    ['positive control: default setup (true record, record directory argument, CSCB_PERSONA)', { records: TRUE_RECORD }],
    ['a true record followed by a newline', { records: { [TEST_KEY]: RECORD_TRUE_NEWLINE } }],
    [
      'a record directory whose path contains a space and a single quote (the argument is read as one path)',
      {
        records: TRUE_RECORD,
        spaceAndQuote: true,
        prepare: (rec) => {
          expect(rec.recordDir).toContain(' ')
          expect(rec.recordDir).toContain("'")
        },
      },
    ],
    [
      `a ${PERSONA_KEY_MAX_LENGTH}-character hashed key with a true record`,
      {
        records: { [HASHED_KEY]: RECORD_TRUE },
        prepare: () => expect(HASHED_KEY.length).toBe(PERSONA_KEY_MAX_LENGTH),
        setup: (rec) => ({ args: [rec.recordDir], persona: HASHED_KEY }),
      },
    ],
  ])('reminds: %s → exit 2 with the full mention wording', (_label, c) => {
    const r = runGateCase(c)
    expect(r.exitCode).toBe(2)
    expect(r.stderr).toBe(GATE_LINE)
  })

  test.each<[string, GateCase]>([
    ['no argument', { records: TRUE_RECORD, setup: () => ({ args: [], persona: TEST_KEY }) }],
    ['an empty argument', { records: TRUE_RECORD, setup: () => ({ args: [''], persona: TEST_KEY }) }],
    [
      'CSCB_PERSONA unset (the parent process has it set; the child must not inherit it)',
      { records: TRUE_RECORD, setup: (rec) => ({ args: [rec.recordDir], persona: null }) },
    ],
    ['CSCB_PERSONA set to an empty string', { records: TRUE_RECORD, setup: (rec) => ({ args: [rec.recordDir], persona: '' }) }],
    ['the argument naming a directory that does not exist (the record directory was never created)', {}],
    [
      'the argument naming a directory that does not exist, beside a record directory holding a true record',
      { records: TRUE_RECORD, setup: (rec) => ({ args: [join(rec.stateDir, 'no-such-dir')], persona: TEST_KEY }) },
    ],
    ['no record for the key (record directory present)', { createRecordDir: true }],
    ['a false record', { records: { [TEST_KEY]: RECORD_FALSE } }],
    ['an unrecognised record: TRUE', { records: { [TEST_KEY]: 'TRUE' } }],
    ['an unrecognised record: true followed by two newlines', { records: { [TEST_KEY]: 'true\n\n' } }],
    ['an unrecognised record: true followed by CRLF', { records: { [TEST_KEY]: 'true\r\n' } }],
    ['an unrecognised record: a leading space before true', { records: { [TEST_KEY]: ' true' } }],
    // Five characters, so they pass the 6-character read limit and only the
    // exact match rejects them (a gate accepting anything starting with true
    // would remind).
    ['an unrecognised record: true followed by a space', { records: { [TEST_KEY]: 'true ' } }],
    ['an unrecognised record: true followed by a carriage return', { records: { [TEST_KEY]: 'true\r' } }],
    ['an empty record file', { records: { [TEST_KEY]: RECORD_EMPTY } }],
    ['a true record only for a neighbour key (no record of its own)', { records: { [NEIGHBOUR_KEY]: RECORD_TRUE } }],
    [
      'a true record for a neighbour key beside its own false record',
      { records: { [NEIGHBOUR_KEY]: RECORD_TRUE, [TEST_KEY]: RECORD_FALSE } },
    ],
    [
      'the record path is a directory, not a file',
      { createRecordDir: true, prepare: (rec) => mkdirSync(rec.recordPath(TEST_KEY)) },
    ],
    [
      'the record path is a FIFO with no writer (never opened, so the run does not block)',
      {
        createRecordDir: true,
        prepare: (rec) => {
          const made = spawnSync('mkfifo', [rec.recordPath(TEST_KEY)])
          expect(made.status).toBe(0)
        },
        // Opening the FIFO would block forever; a short kill turns a
        // regression into a quick failure (exit code -1).
        setup: (rec) => ({ ...defaultSetup(rec), timeoutMs: 3_000 }),
      },
    ],
    [
      'CSCB_PERSONA set to ../<name> while <state dir>/<name> holds true (traversal refused)',
      {
        createRecordDir: true,
        prepare: (rec) => writeFileSync(join(rec.stateDir, TEST_KEY), RECORD_TRUE),
        setup: (rec) => ({ args: [rec.recordDir], persona: `../${TEST_KEY}` }),
      },
    ],
    [
      'CSCB_PERSONA not in key form (uppercase) with a true record under that exact name',
      {
        records: { Reply_Guard_Test: RECORD_TRUE },
        setup: (rec) => ({ args: [rec.recordDir], persona: 'Reply_Guard_Test' }),
      },
    ],
    [
      `CSCB_PERSONA one character over ${PERSONA_KEY_MAX_LENGTH} with a true record under that exact name`,
      {
        records: { [`${HASHED_KEY}0`]: RECORD_TRUE },
        setup: (rec) => ({ args: [rec.recordDir], persona: `${HASHED_KEY}0` }),
      },
    ],
  ])('no reminder: %s → exit 0, silent', (_label, c) => {
    const r = runGateCase(c)
    expect(r.exitCode).toBe(0)
    expect(r.stderr).toBe('')
    expect(r.stdout).toBe('')
  })

  test('the gate runs before the jq check: a false record with jq missing from PATH → exit 0 with no missing-jq warning', () => {
    withNoJqPath((shimDir) => {
      const r = runGateCase({ records: { [TEST_KEY]: RECORD_FALSE } }, { path: shimDir })
      expect(r.exitCode).toBe(0)
      expect(r.stderr).toBe('')
      // Control: a true record on the same PATH gets the warning.
      const control = runGateCase({ records: TRUE_RECORD }, { path: shimDir })
      expect(control.exitCode).toBe(0)
      expect(control.stderr).toBe(MISSING_JQ_WARNING)
    })
  })
})

// ---------------------------------------------------------------------------
// AC 59: the guard over the records a confirmed reload leaves (b.av2 SR-9.4,
// SR-8.6 `stop_hook_bootstrap` row). A running instance keeps the value it
// launched with, so the guard must remind or stay quiet as the persona's
// launched value says, not the newly applied one, until its next launch.
//
// Each case runs a server through `makeReloadHarness` with the real launch
// path (`realLaunch`: the reply-guard steps write `reply-guard/<key>` under
// the harness's temp state directory), confirms a change with the
// operator's gesture, and drives next launches through the restart path
// (`run.relaunch`, the row seeded `ended` so the ladder resumes it). The
// guard then runs on GATE_FIXTURE (via-carrying, no reply) with the
// harness's record directory as its argument and CSCB_PERSONA set to the
// persona's key in an explicitly built child environment (`spawnGuard`
// never passes the test process's environment on). Every persona has its own
// temp `claude_config_dir`, or a shared temp one.
// ---------------------------------------------------------------------------

describe('slack-reply-guard.sh — AC 59: records left by a confirmed reload (b.av2 SR-9.4, SR-8.6)', () => {
  let h: ReloadHarness
  let savedStateDirEnv: string | undefined
  /** Every guard run of the test, for the leak check. */
  let guardRuns: RunResult[]

  beforeEach(() => {
    h = makeReloadHarness({ personaConfigDirs: true })
    guardRuns = []
    // Nothing here is a startup launch, but a recordStartupError write would
    // still land in a temp dir, never under HOME.
    savedStateDirEnv = process.env.SLACK_STATE_DIR
    process.env.SLACK_STATE_DIR = h.stateDir
  })

  afterEach(async () => {
    try {
      await h.cleanup()
    } finally {
      if (savedStateDirEnv === undefined) delete process.env.SLACK_STATE_DIR
      else process.env.SLACK_STATE_DIR = savedStateDirEnv
    }
  })

  /** A server running `personas` (top-level settings `top`) from a byte-equal record and config file, detection started. */
  async function running(personas: PersonaInput[], top: { stop_hook_bootstrap?: boolean } = {}): Promise<ReloadRun> {
    h.materialize(...personas)
    h.writeRecord({ ...top, personas })
    h.writeConfig({ ...top, personas })
    const run = await h.startDetecting({ realLaunch: true })
    await run.ticks.tick()
    expect(h.pendingExists()).toBe(false)
    return run
  }

  /** Confirm `personas` (with `top`) and await the apply; a next-launch change makes no lifecycle call. */
  async function apply(run: ReloadRun, personas: PersonaInput[], top: { stop_hook_bootstrap?: boolean } = {}): Promise<void> {
    h.writeConfig({ ...top, personas })
    const cp = run.checkpoint()
    await (await run.confirmPending()).applying
    expect(h.readRecord()).toEqual(h.readConfig()!)
    expect(run.since(cp).lifecycle).toEqual([])
  }

  /** The persona's next launch: its instance has ended, and the restart path resumes it. */
  async function nextLaunch(run: ReloadRun, persona: PersonaInput): Promise<void> {
    h.seedRow(persona, { state: 'ended' })
    expect(await run.relaunch(persona.name)).toBe(true)
  }

  /** The real guard for `persona` over the harness's record directory. */
  function guardFor(persona: PersonaInput): RunResult {
    const r = spawnGuard(harness(join(FIX, GATE_FIXTURE)), { args: [h.replyGuardDir], persona: h.key(persona.name) })
    guardRuns.push(r)
    return r
  }

  function expectReminded(persona: PersonaInput): void {
    const r = guardFor(persona)
    expect(r.exitCode).toBe(2)
    expect(r.stderr).toBe(GATE_LINE)
  }

  function expectQuiet(persona: PersonaInput): void {
    const r = guardFor(persona)
    expect(r.exitCode).toBe(0)
    expect(r.stderr).toBe('')
    expect(r.stdout).toBe('')
  }

  /** Nothing posted, and no token in the logs, the guard's output, the records or anything else captured. */
  function expectNoPostNoLeak(run: ReloadRun): void {
    expect(run.slackPosts()).toEqual([])
    assertNoLeak(run.captured({ guardRuns, records: writtenFile(h.replyGuardDir), sessionNotices: run.sessionNotices }))
  }

  test('AC 59 own value true → false: after the apply the guard still reminds A (exit 2, its provenance wording); after A\'s next launch it is quiet', async () => {
    const a = h.persona('Guard A')
    const run = await running([a])
    expectReminded(a)

    const aOff = { ...a, stop_hook_bootstrap: false }
    await apply(run, [aOff])
    expectReminded(a)

    await nextLaunch(run, aOff)
    expectQuiet(a)
    expectNoPostNoLeak(run)
  })

  test('AC 59 inherited default false → true: after the apply the guard is quiet for the inheriting persona; after its next launch it reminds', async () => {
    const a = h.persona('Guard A')
    const run = await running([a], { stop_hook_bootstrap: false })
    expectQuiet(a)

    await apply(run, [a], { stop_hook_bootstrap: true })
    expectQuiet(a)

    await nextLaunch(run, a)
    expectReminded(a)
    expectNoPostNoLeak(run)
  })

  test("AC 59 a neighbour's false launch into the same dir, after A's value was changed and before A relaunches, leaves A's guard at exit 2", async () => {
    const d = h.configDir('shared')
    const a = h.persona('Guard A', { claude_config_dir: d })
    const n = h.persona('Guard N', { claude_config_dir: d, stop_hook_bootstrap: false })
    const run = await running([a, n])
    expectReminded(a)
    expectQuiet(n)

    await apply(run, [{ ...a, stop_hook_bootstrap: false }, n])
    await nextLaunch(run, n)

    expectReminded(a)
    expectQuiet(n)
    expectNoPostNoLeak(run)
  })
})
