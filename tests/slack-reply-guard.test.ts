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
  //   Redactions     : none — full JSONL entry copied byte-for-byte from the
  //                    live transcript. The `<channel source="slack-channel-router"
  //                    chat_id="..." message_id="..." user="Gabe Mahoney" ts="...">`
  //                    tag is preserved verbatim (as JSON-escaped in the JSONL);
  //                    body text is unredacted.
  //
  // Approved deviation (recorded per subtask t3.osj.jg.ut.ah instructions):
  //   Live capture proved real bots render `<channel source="slack-channel-router" ...>`,
  //   not `<channel source="slack" ...>`. The User approved broadening the
  //   guard script's Slack-origination predicate to the prefix
  //   `<channel source="slack` (no closing quote) so that both the legacy
  //   `source="slack"` fixture form and the real on-wire
  //   `source="slack-channel-router"` form trigger enforcement. This verbatim
  //   fixture uses the REAL on-wire tag form and locks that predicate in
  //   against the real byte sequence.
  test('SR-6.3: verbatim live transcript (source="slack-channel-router") + no reply → exit 2', () => {
    const r = runGuard(harness(join(FIX, 'verbatim-live-no-reply.jsonl')))
    expect(r.exitCode).toBe(2)
    expect(r.stderr).toContain(REPLY_TOOL)
  })

  test('SR-6.3: verbatim live transcript (source="slack-channel-router") + reply present → exit 0', () => {
    const r = runGuard(harness(join(FIX, 'verbatim-live-with-reply.jsonl')))
    expect(r.exitCode).toBe(0)
    expect(r.stderr).toBe('')
  })

  test('prefix-only predicate: Slack tag with realistic variable attributes still triggers', () => {
    // The "slack-with-reply" and "slack-no-reply" fixtures both use rich
    // variable attributes (chat_id, message_id, user, thread_ts, ts) after
    // `<channel source="slack"`. Re-assert both to lock the prefix predicate.
    const withReply = runGuard(harness(join(FIX, 'slack-with-reply.jsonl')))
    expect(withReply.exitCode).toBe(0)
    const noReply = runGuard(harness(join(FIX, 'slack-no-reply.jsonl')))
    expect(noReply.exitCode).toBe(2)
    expect(noReply.stderr).toContain(REPLY_TOOL)
  })
})
