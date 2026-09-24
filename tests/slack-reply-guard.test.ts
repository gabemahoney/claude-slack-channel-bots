/**
 * slack-reply-guard.test.ts — black-box tests for stop-hooks/slack-reply-guard.sh
 *
 * Drives the script as a real subprocess via spawnSync, feeding Stop-hook
 * harness JSON on stdin and asserting exit code + stderr.
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
 *     and exits 0, including AC 51's `injected-no-reply.jsonl`.
 *   - Every via-carrying copy keeps its original's b.wr5 / SR-6.3 result.
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

const REPO_ROOT = resolve(import.meta.dir, '..')
const SCRIPT = join(REPO_ROOT, 'stop-hooks', 'slack-reply-guard.sh')
const FIX = join(REPO_ROOT, 'tests', 'fixtures', 'slack-reply-guard')

interface RunResult {
  exitCode: number
  stdout: string
  stderr: string
}

function runGuard(
  stdinJson: string,
  opts: { env?: NodeJS.ProcessEnv } = {},
): RunResult {
  const result = spawnSync(SCRIPT, [], {
    input: stdinJson,
    encoding: 'utf-8',
    env: opts.env ?? process.env,
  })
  return {
    exitCode: result.status ?? -1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
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

  test('SR-6.2 case 4: stop_hook_active=true on a delivered no-reply transcript (via-slack-no-reply.jsonl) → exit 0', () => {
    const r = runGuard(harness(join(FIX, 'via-slack-no-reply.jsonl'), true))
    expect(r.exitCode).toBe(0)
    expect(r.stderr).toBe('')
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

    test('jq missing from PATH on a delivered no-reply transcript (via-slack-no-reply.jsonl) → exit 0 with the one-line missing-jq warning', () => {
      // PATH is a scratch dir holding only `bash` (for the /usr/bin/env
      // shebang) and `cat` (the stdin read), so `command -v jq` fails.
      const tmp = mkdtempSync(join(tmpdir(), 'srg-nojq-'))
      try {
        const shimDir = join(tmp, 'bin')
        mkdirSync(shimDir, { recursive: true })
        for (const name of ['bash', 'cat']) {
          const src = [`/usr/bin/${name}`, `/bin/${name}`].find((p) => existsSync(p))
          if (src === undefined) throw new Error(`missing-jq setup: no ${name} in /usr/bin or /bin`)
          symlinkSync(src, join(shimDir, name))
        }
        const r = runGuard(harness(join(FIX, 'via-slack-no-reply.jsonl')), {
          env: { ...process.env, PATH: shimDir },
        })
        // The guard's missing-jq warning, exactly: the exit 0 came from the
        // missing-jq branch, not from an earlier failure (bash or cat missing)
        // or from the transcript.
        expect(r.exitCode).toBe(0)
        expect(r.stderr).toBe('slack-reply-guard: jq not found on PATH; failing open\n')
        expect(r.stdout).toBe('')
      } finally {
        rmSync(tmp, { recursive: true, force: true })
      }
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
  test('AC 51: injected-no-reply.jsonl (scheduled prompt, user and ts only, asks for no reply) → exit 0, silent', () => {
    const r = runGuard(harness(join(FIX, 'injected-no-reply.jsonl')))
    expect(r.exitCode).toBe(0)
    expect(r.stderr).toBe('')
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

  test('b.wr5 retry with stop_hook_active=true: via-verbatim-live-no-reply.jsonl → exit 0, silent (reminder shown once)', () => {
    const r = runGuard(harness(join(FIX, 'via-verbatim-live-no-reply.jsonl'), true))
    expect(r.exitCode).toBe(0)
    expect(r.stderr).toBe('')
  })
})
