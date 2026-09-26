/**
 * session-transcript.ts — A persona's Claude Code transcript as the positive
 * idle signal for a stale `working` agent-director row (bug b.f2b).
 *
 * agent-director can leave a persona's row `working` after its turn ended.
 * The pane alone can't prove the session idle: Claude Code 2.1.280 sometimes
 * draws a live turn with no spinner at all (an API retry or stall shows static
 * rows with no glyph and no timer), and such a screen reads idle. So the
 * session manager also requires the transcript Claude Code writes for the
 * session to end with a completed turn and to stay unchanged across the whole
 * evidence window. A live turn, an API retry included, never ends that way:
 * its last conversation entry is the prompt or a tool result waiting on the
 * API, a tool call waiting on its result, or a Stop hook's feedback that
 * keeps the turn going. A turn the user interrupted does end that way, with
 * its interrupt marker: Claude Code fires no Stop for it.
 *
 * - `locateTranscript` finds the file from the persona's agent-director row
 *   (`get`): its persisted `jsonl_path` when that belongs to the row's
 *   `claude_session_id`, else `<claude_config_dir>/projects/<cwd slug>/
 *   <claude_session_id>.jsonl` (`resolveJsonlPath`, as the resume and the
 *   transcript-loss checks compose it). agent-director records the persisted
 *   path only at SessionStart, and only when the file already exists, so a
 *   fresh session's row has none.
 * - `readTranscriptTurnState` reads the file's tail stat-first (opened
 *   read-only and non-blocking, `fstat`ed, only a regular file read, so a FIFO
 *   there can't hang the server) and returns its identity (`TranscriptSnapshot`:
 *   device, inode, size, mtime) with its turn state.
 * - `transcriptTailTurnState` is the pure rule (see there).
 *
 * Anything that can't be located, opened or parsed is no evidence: the caller
 * treats it as "not idle" and types nothing.
 *
 * SPDX-License-Identifier: MIT
 */

import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs'
import { basename } from 'node:path'
import { resolveJsonlPath } from './cozempic.ts'
import { isSafeIdentifier } from './persona-connection-errors.ts'

/** How much of the transcript's end is read: the last entries of a turn are small, a whole transcript can be many MB. */
export const TRANSCRIPT_TAIL_BYTES = 256 * 1024

/**
 * Stop reasons that end a Claude Code turn: `end_turn`, `stop_sequence` (also
 * Claude Code's own synthetic API-error message, written when it gives up
 * retrying) and `refusal`. `tool_use`, `max_tokens`, `pause_turn` and a
 * missing stop reason (a content block written before its message ended) do
 * not.
 */
const COMPLETED_TURN_STOP_REASONS: ReadonlySet<string> = new Set(['end_turn', 'stop_sequence', 'refusal'])

/** The agent-director row fields the transcript is located from (`GetResult`). */
export interface TranscriptRowFields {
  jsonl_path?: string
  claude_session_id?: string
  cwd?: string
}

/**
 * The transcript of the row's current Claude session, or undefined when it
 * can't be located. With a `claude_session_id`: the persisted `jsonl_path`
 * when its file name is `<claude_session_id>.jsonl` (a path left from an
 * earlier session is never read), else the composed path under `configDir`
 * (the persona's effective claude_config_dir, absolute; undefined: not
 * composed). Without one: the persisted path, if any. Pure.
 */
export function locateTranscript(row: TranscriptRowFields, configDir: string | undefined): string | undefined {
  const persisted = row.jsonl_path || undefined
  const sessionId = row.claude_session_id || undefined
  if (sessionId === undefined) return persisted
  if (persisted !== undefined && basename(persisted) === `${sessionId}.jsonl`) return persisted
  if (configDir === undefined || !row.cwd) return undefined
  return resolveJsonlPath(row.cwd, sessionId, configDir)
}

/** The identity of a transcript file at one read. Two reads with equal snapshots saw the file unchanged. */
export interface TranscriptSnapshot {
  path: string
  dev: number
  ino: number
  size: number
  mtimeMs: number
}

/** Whether two reads saw the same, unchanged transcript file (path, device, inode, size and mtime). */
export function sameTranscriptSnapshot(a: TranscriptSnapshot, b: TranscriptSnapshot): boolean {
  return a.path === b.path && a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs
}

/** Whether a transcript's last conversation entry is a completed turn (`ended`) or not (`open`). */
export type TranscriptTurnState = 'ended' | 'open'

/** One read of a transcript: its snapshot and turn state, or why it could not be read (fixed, token-free text). */
export type TranscriptReading =
  | { kind: TranscriptTurnState; snapshot: TranscriptSnapshot }
  | { kind: 'unreadable'; reason: string }

/**
 * The text Claude Code 2.1.280 writes, as a `user` entry's only content block,
 * when the user interrupts a turn (Esc), and when they interrupt it while a
 * tool call waits for permission or runs.
 */
const INTERRUPT_MARKERS: ReadonlySet<string> = new Set([
  '[Request interrupted by user]',
  '[Request interrupted by user for tool use]',
])

/**
 * The `attachment` types a Stop hook's output is recorded as when it keeps the
 * turn going (Claude Code 2.1.280): its `additionalContext`
 * (`hook_additional_context`) and a blocking error (`hook_blocking_error`),
 * each with `hookEvent` `Stop`. A Stop hook that ends the turn
 * (`hook_stopped_continuation`), and any other hook's attachment (a
 * SessionStart hook's context written after a resumed session's last reply,
 * for one), is not among them.
 */
const TURN_CONTINUING_STOP_HOOK_ATTACHMENTS: ReadonlySet<string> = new Set(['hook_additional_context', 'hook_blocking_error'])

/** A user entry's content when it is a plain string. */
function stringContent(entry: Record<string, unknown>): string | undefined {
  const message = entry.message
  if (typeof message !== 'object' || message === null) return undefined
  const content = (message as Record<string, unknown>).content
  return typeof content === 'string' ? content : undefined
}

/**
 * Whether a user entry is an interrupt marker: its content is a single text
 * block holding one of `INTERRUPT_MARKERS`. A prompt, a string content (a user
 * can type the marker's text) and any content with a `tool_result` block is
 * not.
 */
function isInterruptMarker(entry: Record<string, unknown>): boolean {
  const message = entry.message
  if (typeof message !== 'object' || message === null) return false
  const content = (message as Record<string, unknown>).content
  if (!Array.isArray(content) || content.length !== 1) return false
  const block: unknown = content[0]
  if (typeof block !== 'object' || block === null) return false
  const { type, text } = block as Record<string, unknown>
  return type === 'text' && typeof text === 'string' && INTERRUPT_MARKERS.has(text)
}

/** Whether an `attachment` entry records a Stop hook's output that keeps the turn going. */
function stopHookContinuesTurn(entry: Record<string, unknown>): boolean {
  const attachment = entry.attachment
  if (typeof attachment !== 'object' || attachment === null) return false
  const { type, hookEvent } = attachment as Record<string, unknown>
  return hookEvent === 'Stop' && typeof type === 'string' && TURN_CONTINUING_STOP_HOOK_ATTACHMENTS.has(type)
}

/** Whether an assistant entry is the last entry of a completed turn. */
function assistantEndsTurn(entry: Record<string, unknown>): boolean {
  const message = entry.message
  if (typeof message !== 'object' || message === null) return false
  const { stop_reason: stopReason, content } = message as Record<string, unknown>
  if (typeof stopReason !== 'string' || !COMPLETED_TURN_STOP_REASONS.has(stopReason)) return false
  const hasToolUse =
    Array.isArray(content) &&
    content.some((block) => typeof block === 'object' && block !== null && (block as Record<string, unknown>).type === 'tool_use')
  return !hasToolUse
}

/**
 * The turn state of a transcript's tail (Claude Code's JSONL, one entry per
 * line, each ending in a newline). `fromStart` says the tail begins at the
 * file's first byte; otherwise its first line may be cut and is dropped.
 * Scanning back from the last entry:
 * - an entry that is not part of a turn is skipped: every type other than
 *   `user`, `assistant` and `queue-operation` (`system` lines such as
 *   `turn_duration`, `stop_hook_summary` or `api_error`, `attachment`,
 *   `file-history-snapshot`, `last-prompt`, `mode`, `summary`, `progress`, …),
 *   and a completed local command's three `user` lines (the `isMeta`
 *   `<local-command-caveat>`, the `<command-name>` line directly followed by
 *   its `<local-command-stdout>`/`<local-command-stderr>` line, and that
 *   output line), so the `/mcp reconnect` CSCB types after a turn doesn't
 *   hide the turn's end;
 * - except that an `attachment` recording a Stop hook's output that keeps the
 *   turn going (`TURN_CONTINUING_STOP_HOOK_ATTACHMENTS` with `hookEvent`
 *   `Stop`), written after the turn's last `assistant` entry, is `open`: the
 *   turn goes on with it, and Claude Code writes nothing else for it (b.rmy);
 * - the first other entry decides: `ended` for an `assistant` entry whose
 *   stop reason ends a turn and which holds no `tool_use` block, and for an
 *   interrupt marker (a `user` entry whose only content block is
 *   `[Request interrupted by user]` or `[Request interrupted by user for
 *   tool use]`: the user ended the turn, and Claude Code fires no Stop for
 *   it, so agent-director's row stays `working`). Any other `user` entry (a
 *   prompt, a tool result, Stop-hook feedback, a slash command that starts a
 *   turn), a `queue-operation` (a prompt waiting to run), a sidechain entry,
 *   a line that isn't a JSON object, or a last line with no newline yet
 *   (still being written) is `open`.
 * No deciding entry in the tail is `open`. Pure.
 */
export function transcriptTailTurnState(tail: string, fromStart: boolean): TranscriptTurnState {
  if (!tail.endsWith('\n')) return 'open'
  const lines = tail.split('\n')
  if (!fromStart) lines.shift()
  let afterLocalOutput = false
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!.trim()
    if (line === '') continue
    let entry: unknown
    try {
      entry = JSON.parse(line)
    } catch {
      return 'open'
    }
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return 'open'
    const e = entry as Record<string, unknown>
    if (e.isSidechain === true) return 'open'
    if (e.type === 'assistant') return assistantEndsTurn(e) ? 'ended' : 'open'
    if (e.type === 'queue-operation') return 'open'
    if (e.type === 'attachment' && stopHookContinuesTurn(e)) return 'open'
    if (e.type !== 'user') continue
    if (isInterruptMarker(e)) return 'ended'
    const content = stringContent(e)
    if (content === undefined) return 'open'
    if (content.startsWith('<local-command-stdout>') || content.startsWith('<local-command-stderr>')) {
      afterLocalOutput = true
      continue
    }
    if (afterLocalOutput && content.startsWith('<command-name>')) {
      afterLocalOutput = false
      continue
    }
    if (e.isMeta === true && content.startsWith('<local-command-caveat>')) continue
    return 'open'
  }
  return 'open'
}

/** A file-system failure as a fixed reason: its `code` when it is a short identifier. */
function fsFailureReason(step: string, failure: unknown): string {
  const code = typeof failure === 'object' && failure !== null ? (failure as { code?: unknown }).code : undefined
  return `${step} failed (${isSafeIdentifier(code) ? code : 'unknown error'})`
}

/**
 * Read the transcript at `path` stat-first and return its snapshot and the
 * turn state of its last `TRANSCRIPT_TAIL_BYTES`; `unreadable` (with a fixed
 * reason) when it can't be opened, isn't a regular file, is empty or can't be
 * read. Never throws.
 */
export function readTranscriptTurnState(path: string): TranscriptReading {
  let fd: number
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK)
  } catch (failure) {
    return { kind: 'unreadable', reason: fsFailureReason('opening it', failure) }
  }
  try {
    const st = fstatSync(fd)
    if (!st.isFile()) return { kind: 'unreadable', reason: 'it is not a regular file' }
    if (st.size === 0) return { kind: 'unreadable', reason: 'it is empty' }
    const start = Math.max(0, st.size - TRANSCRIPT_TAIL_BYTES)
    const buffer = Buffer.alloc(st.size - start)
    let read = 0
    while (read < buffer.length) {
      const n = readSync(fd, buffer, read, buffer.length - read, start + read)
      if (n === 0) break
      read += n
    }
    const snapshot: TranscriptSnapshot = { path, dev: st.dev, ino: st.ino, size: st.size, mtimeMs: st.mtimeMs }
    return { kind: transcriptTailTurnState(buffer.subarray(0, read).toString('utf8'), start === 0), snapshot }
  } catch (failure) {
    return { kind: 'unreadable', reason: fsFailureReason('reading it', failure) }
  } finally {
    try {
      closeSync(fd)
    } catch {
      /* ignore */
    }
  }
}
