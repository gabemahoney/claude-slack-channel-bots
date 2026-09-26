/**
 * session-transcript.test.ts — A persona's Claude Code transcript as the
 * positive idle signal for a stale `working` row (bug b.f2b;
 * src/session-transcript.ts).
 *
 * - `transcriptTailTurnState`, pure: an `assistant` entry that ends the turn
 *   (`end_turn`, `stop_sequence`, `refusal`, with no `tool_use` block) and an
 *   interrupt marker (a `user` entry whose only block is the interrupt text)
 *   are `ended`; a prompt, a tool result, a tool call, a queued prompt, a
 *   Stop hook's context or blocking error after the reply, a sidechain entry,
 *   a line that isn't a JSON object and a last line still being written are
 *   `open`; `system` lines, other attachments and a completed local command
 *   (the `/mcp reconnect` CSCB types) are skipped; a tail that does not start
 *   the file drops its first, possibly cut, line.
 * - `locateTranscript`, pure: the row's persisted `jsonl_path` when it is
 *   named for the row's session, else the path composed under the config
 *   directory; never a path left from an earlier session.
 * - `readTranscriptTurnState`, over files in a per-test `mkdtempSync`
 *   directory: the snapshot (size, mtime, identity) and turn state of a
 *   regular file, only its last `TRANSCRIPT_TAIL_BYTES` read; a missing,
 *   empty or non-regular file is `unreadable` with a fixed reason. A real
 *   FIFO runs in a child `bun` process with a time limit.
 *
 * Transcript entries come from `tests/test-helpers/working-row-panes.ts`.
 *
 * SPDX-License-Identifier: MIT
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  TRANSCRIPT_TAIL_BYTES,
  locateTranscript,
  readTranscriptTurnState,
  sameTranscriptSnapshot,
  transcriptTailTurnState,
  type TranscriptTurnState,
} from '../src/session-transcript.ts'
import {
  TRANSCRIPT_SESSION_ID,
  appendTranscript,
  endedTurn,
  hookAttachmentEntry,
  interruptEntry,
  localCommandEntries,
  promptEntry,
  queuedPromptEntry,
  rejectedToolResultEntry,
  replyEntry,
  systemEntry,
  toolResultEntry,
  toolUseEntry,
  transcriptJsonl,
  writeTranscript,
  type TranscriptEntry,
} from './test-helpers/working-row-panes.ts'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cscb-transcript-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

/** A reply that ends the turn with `stopReason` but also holds a tool call. */
function replyWithToolUse(stopReason: string): TranscriptEntry {
  const entry = replyEntry(stopReason)
  const message = entry.message as { content: unknown[] }
  message.content = [...message.content, { type: 'tool_use', id: 'toolu_02', name: 'Bash', input: { command: 'ls' } }]
  return entry
}

// ---------------------------------------------------------------------------
// transcriptTailTurnState — the pure rule
// ---------------------------------------------------------------------------

describe('transcriptTailTurnState', () => {
  test.each<[string, TranscriptTurnState, TranscriptEntry[]]>([
    ['a finished turn: the reply stopped with end_turn, then its system lines', 'ended', endedTurn()],
    ['a reply stopped with stop_sequence (also Claude Code\'s own API-error message)', 'ended', [promptEntry(), replyEntry('stop_sequence')]],
    ['a reply stopped with refusal', 'ended', [promptEntry(), replyEntry('refusal')]],
    ['the prompt, waiting on the API (a retry or a stall)', 'open', [...endedTurn(), promptEntry('post it in #ops')]],
    ['a tool call waiting on its result', 'open', [promptEntry(), toolUseEntry()]],
    ['a tool result waiting on the API', 'open', [promptEntry(), toolUseEntry(), toolResultEntry()]],
    ['a reply that stopped with end_turn but holds a tool_use block', 'open', [promptEntry(), replyWithToolUse('end_turn')]],
    ['a reply stopped at max_tokens', 'open', [promptEntry(), replyEntry('max_tokens')]],
    ['a reply stopped with pause_turn', 'open', [promptEntry(), replyEntry('pause_turn')]],
    ['a reply with no stop reason yet (written before its message ended)', 'open', [promptEntry(), replyEntry(null)]],
    ['a prompt queued after the turn ended (queue-operation)', 'open', [...endedTurn(), queuedPromptEntry()]],
    ['a completed /mcp reconnect after the turn (caveat, command, stdout)', 'ended', [...endedTurn(), ...localCommandEntries()]],
    ['a local command whose output went to stderr', 'ended', [...endedTurn(), ...localCommandEntries('stderr')]],
    ['a slash command that starts a turn (its command line, no output line)', 'open', [...endedTurn(), localCommandEntries()[0]!, localCommandEntries()[1]!]],
    ['a sidechain (subagent) reply that ended its own turn', 'open', [promptEntry(), toolUseEntry(), replyEntry('end_turn', { isSidechain: true })]],
    ['only system lines: no deciding entry', 'open', [systemEntry('turn_duration'), systemEntry('stop_hook_summary')]],
    ['no entries at all', 'open', []],
  ])('%s → %s', (_label, state, entries) => {
    expect(transcriptTailTurnState(transcriptJsonl(entries), true)).toBe(state)
  })

  // A turn the user interrupts gets no Stop, so agent-director's row stays
  // `working`: the interrupt marker ends the turn. A tool result never does.
  test.each<[string, TranscriptTurnState, TranscriptEntry[]]>([
    ['REPRO: a turn interrupted while the model ran: the prompt, then the interrupt marker', 'ended', [...endedTurn(), promptEntry('post it in #ops'), interruptEntry()]],
    ['REPRO: a turn interrupted during a tool call: the call, its rejected result, then the tool-use interrupt marker', 'ended', [promptEntry(), toolUseEntry(), rejectedToolResultEntry(), interruptEntry(true)]],
    ['an interrupt marker, then Claude Code\'s own trailing lines (system, a completed /mcp reconnect)', 'ended', [promptEntry(), interruptEntry(), systemEntry('turn_duration'), ...localCommandEntries()]],
    ['an interrupt marker, then a new prompt', 'open', [promptEntry(), interruptEntry(), promptEntry('try again')]],
    ['an interrupt marker, then a queued prompt', 'open', [promptEntry(), interruptEntry(), queuedPromptEntry()]],
    ['a tool result, not an interrupt: the interrupt text in the same entry after a tool_result block', 'open', [promptEntry(), toolUseEntry(), interruptEntry(true, true)]],
    ['a rejected tool result alone (no marker written yet)', 'open', [promptEntry(), toolUseEntry(), rejectedToolResultEntry()]],
    ['a prompt whose text is the marker (string content, as a user would type it)', 'open', [...endedTurn(), promptEntry('[Request interrupted by user]')]],
    ['a sidechain (subagent) interrupt marker', 'open', [promptEntry(), toolUseEntry(), { ...interruptEntry(), isSidechain: true }]],
  ])('interrupts: %s → %s', (_label, state, entries) => {
    expect(transcriptTailTurnState(transcriptJsonl(entries), true)).toBe(state)
  })

  // b.rmy: a Stop hook that returns additionalContext (or a blocking error)
  // keeps the turn going, and Claude Code records it only as an attachment
  // after the turn's last assistant entry.
  test.each<[string, TranscriptTurnState, TranscriptEntry[]]>([
    ['REPRO: a Stop hook\'s additionalContext after the reply (the turn goes on with it)', 'open', [...endedTurn(), hookAttachmentEntry('hook_additional_context')]],
    ['a Stop hook\'s blocking error after the reply', 'open', [promptEntry(), replyEntry(), hookAttachmentEntry('hook_blocking_error'), systemEntry('stop_hook_summary')]],
    ['a Stop hook\'s context, then a completed /mcp reconnect', 'open', [...endedTurn(), hookAttachmentEntry('hook_additional_context'), ...localCommandEntries()]],
    ['a Stop hook\'s context before the reply that finished the continued turn', 'ended', [promptEntry(), replyEntry(), hookAttachmentEntry('hook_additional_context'), replyEntry(), systemEntry('turn_duration')]],
    ['a Stop hook that stopped the turn (hook_stopped_continuation)', 'ended', [...endedTurn(), hookAttachmentEntry('hook_stopped_continuation')]],
    ['a Stop hook that succeeded with no output (hook_success)', 'ended', [...endedTurn(), hookAttachmentEntry('hook_success')]],
    ['a SessionStart hook\'s context after a resumed session\'s last reply', 'ended', [...endedTurn(), hookAttachmentEntry('hook_additional_context', 'SessionStart')]],
    ['a PostToolUse hook\'s blocking error after the reply', 'ended', [...endedTurn(), hookAttachmentEntry('hook_blocking_error', 'PostToolUse')]],
  ])('Stop hook attachments: %s → %s', (_label, state, entries) => {
    expect(transcriptTailTurnState(transcriptJsonl(entries), true)).toBe(state)
  })

  test.each<[string, string]>([
    ['a line that is not JSON', 'not json at all\n'],
    ['a JSON array', '[1,2,3]\n'],
    ['a JSON string', '"end_turn"\n'],
  ])('%s after a finished turn → open', (_label, line) => {
    expect(transcriptTailTurnState(`${transcriptJsonl(endedTurn())}${line}`, true)).toBe('open')
  })

  test('a last line with no newline yet (still being written) → open, even when it is a complete reply that ends the turn', () => {
    const tail = transcriptJsonl([...endedTurn(), promptEntry(), replyEntry('end_turn')]).trimEnd()
    expect(transcriptTailTurnState(tail, true)).toBe('open')
    expect(transcriptTailTurnState(`${tail}\n`, true)).toBe('ended')
  })

  test('a tail that does not start the file drops its first line, which may be cut: an entry there decides nothing', () => {
    const tail = transcriptJsonl([replyEntry('end_turn'), systemEntry('turn_duration')])
    expect(transcriptTailTurnState(tail, true)).toBe('ended')
    expect(transcriptTailTurnState(tail, false)).toBe('open')
  })
})

// ---------------------------------------------------------------------------
// locateTranscript — which file belongs to the row's session
// ---------------------------------------------------------------------------

describe('locateTranscript', () => {
  const persisted = `/cfg/.claude/projects/-work-nightly/${TRANSCRIPT_SESSION_ID}.jsonl`
  const composed = `/other/.claude/projects/-work-nightly-bot/${TRANSCRIPT_SESSION_ID}.jsonl`
  const row = { jsonl_path: persisted, claude_session_id: TRANSCRIPT_SESSION_ID, cwd: '/work/nightly bot' }

  test.each<[string, Parameters<typeof locateTranscript>[0], string | undefined, string | undefined]>([
    ['the persisted jsonl_path, named for the row\'s session', row, '/other/.claude', persisted],
    ['a persisted path left from an earlier session: the composed path under the config dir', { ...row, jsonl_path: '/cfg/.claude/projects/-work-nightly/0000aaaa-old-session.jsonl' }, '/other/.claude', composed],
    ['no persisted path (a fresh session\'s row): the composed path', { ...row, jsonl_path: '' }, '/other/.claude', composed],
    ['a persisted path from an earlier session and no config dir: none', { ...row, jsonl_path: '/cfg/old.jsonl' }, undefined, undefined],
    ['no persisted path and no cwd: none', { ...row, jsonl_path: '', cwd: '' }, '/other/.claude', undefined],
    ['no session ID: the persisted path as it is', { ...row, jsonl_path: '/cfg/any.jsonl', claude_session_id: '' }, '/other/.claude', '/cfg/any.jsonl'],
    ['no session ID and no persisted path: none', { jsonl_path: '', claude_session_id: '', cwd: '/work' }, '/other/.claude', undefined],
  ])('%s', (_label, fields, configDir, expected) => {
    expect(locateTranscript(fields, configDir)).toBe(expected)
  })
})

// ---------------------------------------------------------------------------
// readTranscriptTurnState — a stat-first read of the file's tail
// ---------------------------------------------------------------------------

describe('readTranscriptTurnState', () => {
  function transcriptAt(entries: TranscriptEntry[]): string {
    const path = join(dir, `${TRANSCRIPT_SESSION_ID}.jsonl`)
    writeTranscript(path, entries)
    return path
  }

  test('a regular file: its turn state and its snapshot (path, device, inode, size, mtime); an append changes the snapshot', () => {
    const path = transcriptAt(endedTurn())
    const st = statSync(path)

    const first = readTranscriptTurnState(path)
    expect(first).toEqual({ kind: 'ended', snapshot: { path, dev: st.dev, ino: st.ino, size: st.size, mtimeMs: st.mtimeMs } })
    const again = readTranscriptTurnState(path)
    if (first.kind === 'unreadable' || again.kind === 'unreadable') throw new Error('expected a readable transcript')
    expect(sameTranscriptSnapshot(first.snapshot, again.snapshot)).toBe(true)

    appendTranscript(path, [promptEntry()])
    const appended = readTranscriptTurnState(path)
    if (appended.kind === 'unreadable') throw new Error('expected a readable transcript')
    expect(appended.kind).toBe('open')
    expect(sameTranscriptSnapshot(first.snapshot, appended.snapshot)).toBe(false)
  })

  test('only the last TRANSCRIPT_TAIL_BYTES are read: a transcript larger than that still reads its last turn, and the snapshot has the whole size', () => {
    const big = replyEntry('end_turn')
    ;(big.message as { content: unknown[] }).content = [{ type: 'text', text: 'x'.repeat(TRANSCRIPT_TAIL_BYTES + 1_000) }]
    const path = transcriptAt([promptEntry(), big, ...endedTurn()])
    const size = statSync(path).size
    expect(size).toBeGreaterThan(TRANSCRIPT_TAIL_BYTES)

    const reading = readTranscriptTurnState(path)
    expect(reading).toMatchObject({ kind: 'ended', snapshot: { size } })
  })

  test.each<[string, () => string, string]>([
    ['a missing file', () => join(dir, 'missing.jsonl'), 'opening it failed (ENOENT)'],
    ['an empty file', () => { const p = join(dir, 'empty.jsonl'); writeFileSync(p, ''); return p }, 'it is empty'],
    ['a directory', () => { const p = join(dir, 'a-directory.jsonl'); mkdirSync(p); return p }, 'it is not a regular file'],
  ])('%s → unreadable with a fixed reason', (_label, make, reason) => {
    expect(readTranscriptTurnState(make())).toEqual({ kind: 'unreadable', reason })
  })

  const hasMkfifo = spawnSync('mkfifo', ['--version']).status === 0
  test.skipIf(!hasMkfifo)('a real FIFO with no writer: the read does not wait, it is unreadable as not a regular file (child process, 10 s bound; skipped where mkfifo is unavailable)', () => {
    const path = join(dir, `${TRANSCRIPT_SESSION_ID}.jsonl`)
    expect(spawnSync('mkfifo', [path]).status).toBe(0)
    const modulePath = join(import.meta.dir, '..', 'src', 'session-transcript.ts')
    const script = `const t = await import(${JSON.stringify(modulePath)})\nconsole.log(JSON.stringify(t.readTranscriptTurnState(${JSON.stringify(path)})))`
    const child = spawnSync(process.execPath, ['-e', script], {
      timeout: 10_000,
      encoding: 'utf-8',
      env: { PATH: process.env['PATH'], HOME: dir, BUN_RUNTIME_TRANSPILER_CACHE_PATH: '0' },
    })

    expect(child.signal).toBeNull()
    expect(JSON.parse(child.stdout.trim())).toEqual({ kind: 'unreadable', reason: 'it is not a regular file' })
  }, 15_000)
})
