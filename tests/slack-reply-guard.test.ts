/**
 * slack-reply-guard.test.ts — black-box tests for stop-hooks/slack-reply-guard.sh
 *
 * Drives the script as a real subprocess via spawnSync, feeding Stop-hook
 * harness JSON on stdin and asserting exit code + stderr. Covers all seven
 * SR-6.2 cases from SRD t1.2qu.u6, plus a negative-control (server-name
 * substring only), a no-real-user-message transcript, and additional
 * fail-open modes (missing file, empty file, malformed lines, missing
 * transcript_path, missing jq via restricted PATH).
 *
 * SR-6.3 verbatim live-transcript fixture is included below (see the
 * provenance comment in the "additional fixtures" describe block).
 *
 * b.wr5 (injected prompts and reminder provenance) is covered by the last
 * describe block, using verbatim cron and /interject transcript entries.
 *
 * SPDX-License-Identifier: MIT
 */

import { describe, test, expect } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { resolve, join } from 'node:path'
import { mkdtempSync, writeFileSync, chmodSync, rmSync, mkdirSync } from 'node:fs'
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

describe('slack-reply-guard.sh — SR-6.2 exit-code contract', () => {
  // -------------------------------------------------------------------------
  // Case 1 — Slack-originated msg + subsequent matching tool_use → exit 0.
  // -------------------------------------------------------------------------
  test('SR-6.2 case 1: Slack msg + reply tool_use → exit 0, silent', () => {
    const r = runGuard(harness(join(FIX, 'slack-with-reply.jsonl')))
    expect(r.exitCode).toBe(0)
    expect(r.stderr).toBe('')
    expect(r.stdout).toBe('')
  })

  // -------------------------------------------------------------------------
  // Case 2 — Slack-originated msg + no reply → exit 2, stderr names the tool.
  // -------------------------------------------------------------------------
  test('SR-6.2 case 2: Slack msg + no reply → exit 2, stderr names tool', () => {
    const r = runGuard(harness(join(FIX, 'slack-no-reply.jsonl')))
    expect(r.exitCode).toBe(2)
    expect(r.stderr).toContain(REPLY_TOOL)
  })

  // -------------------------------------------------------------------------
  // Case 3 — Non-Slack latest real user msg → exit 0, no output.
  // -------------------------------------------------------------------------
  test('SR-6.2 case 3: non-Slack latest user msg → exit 0, no output', () => {
    const r = runGuard(harness(join(FIX, 'non-slack.jsonl')))
    expect(r.exitCode).toBe(0)
    expect(r.stderr).toBe('')
    expect(r.stdout).toBe('')
  })

  // -------------------------------------------------------------------------
  // Case 4 — stop_hook_active: true → exit 0 regardless of transcript.
  // -------------------------------------------------------------------------
  test('SR-6.2 case 4: stop_hook_active=true → exit 0 despite VIOLATION shape', () => {
    // Reuse the no-reply fixture which would otherwise trigger exit 2.
    const r = runGuard(harness(join(FIX, 'slack-no-reply.jsonl'), true))
    expect(r.exitCode).toBe(0)
    expect(r.stderr).toBe('')
  })

  // -------------------------------------------------------------------------
  // Case 5 — Fail-open modes: missing / unreadable / empty / malformed
  // transcript, missing transcript_path field, and missing jq (via a
  // restricted PATH). All → exit 0. Missing-jq allows a one-line stderr
  // warning per SR-1.6, so assert exit code only.
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

    test('jq missing from PATH → exit 0 (stderr warning permitted)', () => {
      // Restrict PATH to a scratch dir that contains only `cat` and coreutils
      // shims, forcing `command -v jq` to fail.
      const tmp = mkdtempSync(join(tmpdir(), 'srg-nojq-'))
      try {
        // A PATH pointing only at an empty dir would break `cat` (used by the
        // script). Symlink the coreutils bins we actually rely on, but not jq.
        // Simpler: use a directory containing symlinks to /bin/cat only, and
        // let the script's `command -v jq` return non-zero.
        // Actually the script uses only builtins + `cat` + `command -v` + `jq`.
        // On this platform `cat` lives at /bin/cat or /usr/bin/cat.
        const shimDir = join(tmp, 'bin')
        mkdirSync(shimDir, { recursive: true })
        const fs = require('node:fs') as typeof import('node:fs')
        // Symlink the coreutils the script actually needs (bash for the
        // shebang via /usr/bin/env, cat for stdin read), but deliberately
        // NOT jq — that is the condition under test.
        for (const name of ['bash', 'cat']) {
          for (const src of [`/usr/bin/${name}`, `/bin/${name}`]) {
            try {
              fs.symlinkSync(src, join(shimDir, name))
              break
            } catch {}
          }
        }
        const r = runGuard(harness(join(FIX, 'slack-no-reply.jsonl')), {
          env: { ...process.env, PATH: shimDir },
        })
        // Exit code only — a one-line stderr warning is explicitly permitted.
        expect(r.exitCode).toBe(0)
      } finally {
        rmSync(tmp, { recursive: true, force: true })
      }
    })
  })

  // -------------------------------------------------------------------------
  // Case 6 — tool_result-only user entries after the Slack msg do NOT displace
  // it as the trigger; enforcement still applies. Reused fixture.
  // -------------------------------------------------------------------------
  test('SR-6.2 case 6: trailing tool_result-only user entries do not displace trigger → exit 2', () => {
    const r = runGuard(
      harness(join(FIX, 'slack-then-toolresult-no-reply.jsonl')),
    )
    expect(r.exitCode).toBe(2)
    expect(r.stderr).toContain(REPLY_TOOL)
  })

  // -------------------------------------------------------------------------
  // Case 7 — Sidechain user entries after the Slack msg are skipped. Assert
  // BOTH branches: exit 2 when no reply follows, exit 0 when a reply follows.
  // -------------------------------------------------------------------------
  test('SR-6.2 case 7a: trailing sidechain entries + no reply → exit 2', () => {
    const r = runGuard(harness(join(FIX, 'slack-then-sidechain-no-reply.jsonl')))
    expect(r.exitCode).toBe(2)
    expect(r.stderr).toContain(REPLY_TOOL)
  })

  test('SR-6.2 case 7b: trailing sidechain entries + reply present → exit 0', () => {
    const r = runGuard(
      harness(join(FIX, 'slack-then-sidechain-with-reply.jsonl')),
    )
    expect(r.exitCode).toBe(0)
    expect(r.stderr).toBe('')
  })
})

// ---------------------------------------------------------------------------
// Additional fixtures required by the subtask (beyond the seven SR-6.2 cases)
// ---------------------------------------------------------------------------

describe('slack-reply-guard.sh — additional fixtures', () => {
  test('negative control: string "slack-channel-router" without <channel source="slack" → exit 0', () => {
    const r = runGuard(
      harness(join(FIX, 'negative-control-server-name.jsonl')),
    )
    expect(r.exitCode).toBe(0)
    expect(r.stderr).toBe('')
  })

  test('no real user message anywhere (assistant + tool_result + sidechain only) → exit 0', () => {
    const r = runGuard(harness(join(FIX, 'no-real-user-message.jsonl')))
    expect(r.exitCode).toBe(0)
    expect(r.stderr).toBe('')
  })

  // ---------------------------------------------------------------------------
  // SR-6.3 — Verbatim live-transcript fixture.
  //
  // Provenance:
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
  //   `slack` as Slack. This fixture locks that in against the real on-wire
  //   bytes. The no-reply half (exit 2 with the exact channel reminder) is
  //   asserted in the b.wr5 describe block below.
  test('SR-6.3: verbatim live transcript (source="slack-channel-router") + reply present → exit 0', () => {
    const r = runGuard(harness(join(FIX, 'verbatim-live-with-reply.jsonl')))
    expect(r.exitCode).toBe(0)
    expect(r.stderr).toBe('')
  })
})

// ---------------------------------------------------------------------------
// b.wr5 — injected prompts never trigger the guard; the reminder is a
// declinable one-time nudge that names the message's provenance.
//
// Fixture provenance (all read from the claude-infhub bot's transcripts under
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
// DERIVED fixtures below are built from the lines above by the one edit named
// and nothing else. "Unreplied assistant entry" = line 2 of
// verbatim-live-with-reply.jsonl with its reply tool_use block removed (only
// the "Concur." text block is left).
//
//   slack-no-chat-id-no-reply.jsonl
//     verbatim-live-no-reply.jsonl with the chat_id attribute removed.
//   cron-six-decimal-ts-no-reply.jsonl
//     verbatim-cron-no-reply.jsonl with message_id and ts changed from
//     "1790143200.002" to the Slack-shaped "1790143200.002000", so only the
//     `cscb-cron:` user prefix marks it as injected.
//   interject-whole-second-ts-no-reply.jsonl
//     verbatim-interject-no-reply.jsonl with message_id and ts changed from
//     "1789861303.035" to "1789861303" (what String(Date.now() / 1000) gives
//     on an exact second).
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
// ---------------------------------------------------------------------------

describe('slack-reply-guard.sh — b.wr5 injected prompts and reminder provenance', () => {
  const tail =
    "and you haven't replied. If you meant to answer in Slack, do it now with the " +
    `${REPLY_TOOL} tool. If no reply is needed, just end your turn.`

  const channel = `This turn started from a Slack channel message (channel C0B1ZJJLJ9M) ${tail}`
  const dm = `This turn started from a Slack direct message (conversation D0B1ZJJLJ9M) ${tail}`

  test.each([
    ['verbatim-cron-no-reply.jsonl', 'cscb_cron scheduled prompt'],
    ['cron-six-decimal-ts-no-reply.jsonl', 'cscb_cron prompt with a Slack-shaped ts — the user prefix alone exempts it'],
    ['verbatim-interject-no-reply.jsonl', '/interject with the default sender label'],
    ['verbatim-interject-custom-label-no-reply.jsonl', '/interject with a custom sender label'],
    ['interject-whole-second-ts-no-reply.jsonl', '/interject sent on an exact second (whole-number ts)'],
    ['cron-then-interject-no-reply.jsonl', 'cron then /interject back to back'],
    ['cron-quoting-slack-wrapper-no-reply.jsonl', 'cron envelope quoting a real Slack wrapper — only the envelope at the start counts'],
    ['plain-quoting-slack-wrapper-no-reply.jsonl', 'plain message quoting a Slack wrapper mid-text'],
    ['telegram-quoting-slack-wrapper-no-reply.jsonl', 'non-Slack envelope whose body quotes a Slack wrapper'],
    ['channel-assistant-then-cron-no-reply.jsonl', 'unreplied channel message, assistant entry, then cron — the assistant entry ends the run'],
    ['verbatim-compact-summary-after-reply.jsonl', 'replied channel message, then a compaction summary quoting a wrapper'],
  ])('no reminder: %s (%s) → exit 0, silent', (fixture) => {
    const r = runGuard(harness(join(FIX, fixture)))
    expect(r.exitCode).toBe(0)
    expect(r.stderr).toBe('')
  })

  test.each([
    ['verbatim-live-no-reply.jsonl', 'SR-6.3 verbatim channel message', channel],
    ['dm-from-live-no-reply.jsonl', 'direct message', dm],
    ['slack-no-chat-id-no-reply.jsonl', 'wrapper without chat_id', `This turn started from a Slack channel message ${tail}`],
    ['channel-then-cron-no-reply.jsonl', 'channel message then cron back to back — cron does not hide it', channel],
    ['dm-then-interject-no-reply.jsonl', 'DM then /interject back to back — /interject does not hide it', dm],
    ['compact-summary-no-reply.jsonl', 'unreplied channel message, assistant entry, then compaction summary — the summary is skipped', channel],
  ])('real Slack message, no reply: %s (%s) → exit 2 with the declinable reminder', (fixture, _label, reminder) => {
    const r = runGuard(harness(join(FIX, fixture)))
    expect(r.exitCode).toBe(2)
    expect(r.stderr).toBe(`${reminder}\n`)
  })

  test('b.wr5 retry with stop_hook_active=true: verbatim channel message → exit 0, silent (reminder shown once)', () => {
    const r = runGuard(harness(join(FIX, 'verbatim-live-no-reply.jsonl'), true))
    expect(r.exitCode).toBe(0)
    expect(r.stderr).toBe('')
  })
})
