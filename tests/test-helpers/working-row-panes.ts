/** Opaque terminal output and independent JSONL receipt fixtures.
 * Pane contents have no delivery or readiness meaning. */
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'
import { MIN_CLAUDE_CODE_VERSION } from './agent-director-versions.ts'

export const IDLE_PANE = 'arbitrary terminal contents'
export const SPINNER_PANE = 'unrelated terminal output'

// ---------------------------------------------------------------------------
// Transcripts
// ---------------------------------------------------------------------------

/** The Claude session ID the transcripts below belong to (a transcript file is `<id>.jsonl`). */
export const TRANSCRIPT_SESSION_ID = '5b0c9a3e-7d4f-4e21-9c8a-1f2e3d4c5b6a'

/** One transcript entry: a JSON object, one per line. */
export type TranscriptEntry = Record<string, unknown>

/** The fields Claude Code writes on every conversation entry. */
function conversation(type: 'user' | 'assistant', message: Record<string, unknown>, extra: TranscriptEntry = {}): TranscriptEntry {
  return {
    parentUuid: null,
    isSidechain: false,
    userType: 'external',
    cwd: '/x',
    sessionId: TRANSCRIPT_SESSION_ID,
    version: MIN_CLAUDE_CODE_VERSION,
    type,
    message,
    uuid: crypto.randomUUID(),
    timestamp: '2026-09-26T09:14:02.000Z',
    ...extra,
  }
}

/** A prompt the session was given (a `user` entry with string content). */
export function promptEntry(text = 'check whether the nightly build passed and post the summary'): TranscriptEntry {
  return conversation('user', { role: 'user', content: text })
}

/** A tool call: an `assistant` entry with a `tool_use` block, stopped for it. */
export function toolUseEntry(): TranscriptEntry {
  return conversation('assistant', {
    role: 'assistant',
    content: [{ type: 'tool_use', id: 'toolu_01', name: 'Bash', input: { command: 'gh run view 4121' } }],
    stop_reason: 'tool_use',
  })
}

/** The tool's result, handed back to the model (a `user` entry with a `tool_result` block). */
export function toolResultEntry(): TranscriptEntry {
  return conversation('user', {
    role: 'user',
    content: [{ type: 'tool_result', tool_use_id: 'toolu_01', content: '{"conclusion":"success"}' }],
  })
}

/**
 * The model's reply: an `assistant` entry with a text block and
 * `stopReason` (`end_turn` ends the turn), or with no stop reason at all
 * (`null`: a content block written before its message ended).
 */
export function replyEntry(stopReason: string | null = 'end_turn', extra: TranscriptEntry = {}): TranscriptEntry {
  const message: Record<string, unknown> = { role: 'assistant', content: [{ type: 'text', text: 'The nightly build passed.' }] }
  if (stopReason !== null) message.stop_reason = stopReason
  return conversation('assistant', message, extra)
}

/** A `system` line Claude Code writes around a turn, such as `turn_duration` or `stop_hook_summary`. */
export function systemEntry(subtype: string): TranscriptEntry {
  return { type: 'system', subtype, sessionId: TRANSCRIPT_SESSION_ID, timestamp: '2026-09-26T09:14:03.000Z' }
}

/**
 * The marker Claude Code writes when the user interrupts a turn: a `user`
 * entry whose only content block is the text `[Request interrupted by user]`,
 * or `[Request interrupted by user for tool use]` (`forToolUse`) after a tool
 * call's rejected result. With `withToolResult` the text block follows a
 * `tool_result` block in the same entry.
 */
export function interruptEntry(forToolUse = false, withToolResult = false): TranscriptEntry {
  const text = forToolUse ? '[Request interrupted by user for tool use]' : '[Request interrupted by user]'
  const content: unknown[] = [{ type: 'text', text }]
  if (withToolResult) {
    content.unshift({ type: 'tool_result', tool_use_id: 'toolu_01', content: 'The user doesn\'t want to proceed with this tool use.', is_error: true })
  }
  return conversation('user', { role: 'user', content })
}

/** A tool call's result after the user rejected or interrupted it (`is_error`). */
export function rejectedToolResultEntry(): TranscriptEntry {
  return conversation('user', {
    role: 'user',
    content: [{ type: 'tool_result', tool_use_id: 'toolu_01', content: 'The user doesn\'t want to proceed with this tool use.', is_error: true }],
  })
}

/**
 * A hook's output recorded as an `attachment` entry (Claude Code 2.1.280),
 * e.g. a Stop hook's `additionalContext` (`hook_additional_context`, which
 * keeps the turn going), its blocking error (`hook_blocking_error`), or a
 * SessionStart hook's context.
 */
export function hookAttachmentEntry(type: string, hookEvent = 'Stop'): TranscriptEntry {
  return {
    parentUuid: null,
    isSidechain: false,
    userType: 'external',
    cwd: '/x',
    sessionId: TRANSCRIPT_SESSION_ID,
    version: MIN_CLAUDE_CODE_VERSION,
    type: 'attachment',
    attachment: { type, content: ['Check the job list before you finish.'], hookName: hookEvent, toolUseID: `hook-${hookEvent}`, hookEvent },
    uuid: crypto.randomUUID(),
    timestamp: '2026-09-26T09:14:03.000Z',
  }
}

/** A prompt queued while a turn runs (`queue-operation`). */
export function queuedPromptEntry(text = 'post it in #ops too'): TranscriptEntry {
  return { type: 'queue-operation', operation: 'enqueue', content: text, sessionId: TRANSCRIPT_SESSION_ID }
}

/**
 * The three `user` lines of a completed local command such as the
 * `/mcp reconnect` CSCB types: the `isMeta` caveat, the command line and its
 * output (`stream`: stdout or stderr).
 */
export function localCommandEntries(stream: 'stdout' | 'stderr' = 'stdout'): TranscriptEntry[] {
  return [
    conversation(
      'user',
      {
        role: 'user',
        content:
          '<local-command-caveat>Caveat: The messages below were generated by the user while running local commands. DO NOT respond to these messages or otherwise consider them in your response unless the user explicitly asks you to.</local-command-caveat>',
      },
      { isMeta: true },
    ),
    conversation('user', {
      role: 'user',
      content: '<command-name>/mcp</command-name>\n<command-message>mcp</command-message>\n<command-args>reconnect slack-channel-router</command-args>',
    }),
    conversation('user', { role: 'user', content: `<local-command-${stream}>Reconnected to slack-channel-router.</local-command-${stream}>` }),
  ]
}

/** A whole finished turn: the prompt, a tool call and its result, the reply (`end_turn`) and the turn's `system` lines. */
export function endedTurn(): TranscriptEntry[] {
  return [promptEntry(), toolUseEntry(), toolResultEntry(), replyEntry(), systemEntry('stop_hook_summary'), systemEntry('turn_duration')]
}

/** `entries` as Claude Code's JSONL: one entry per line, each ending in a newline. */
export function transcriptJsonl(entries: readonly TranscriptEntry[]): string {
  return entries.map((entry) => `${JSON.stringify(entry)}\n`).join('')
}

/** Write `entries` to the transcript at `path` (inside the caller's temp directory), replacing it. */
export function writeTranscript(path: string, entries: readonly TranscriptEntry[]): void {
  writeFileSync(path, transcriptJsonl(entries))
}

/** Append `entries` to the transcript at `path`, as Claude Code does while a session runs. */
export function appendTranscript(path: string, entries: readonly TranscriptEntry[]): void {
  appendFileSync(path, transcriptJsonl(entries))
}

/** Concrete composer drawings, shared by delivery, replay and reconnect tests
 * (b.omv SR-5.3/5.4). No long/tall-paste research assumptions are added here. */
export function queuedCommandEntry(text: string, extra: TranscriptEntry = {}): TranscriptEntry {
  return { ...hookAttachmentEntry('queued_command'), attachment: { type: 'queued_command', prompt: text }, ...extra }
}
export function queueOperationEntry(operation: string, text: string, reason?: string): TranscriptEntry {
  return { type: 'queue-operation', operation, content: text, ...(reason ? { reason } : {}) }
}
export function codexPromptEntry(text: string): TranscriptEntry {
  return { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] } }
}
export function codexTurnEntry(type: 'task_started' | 'task_complete'): TranscriptEntry {
  return { type: 'event_msg', payload: { type } }
}

export function pastedText(text: string, id = 'abcd'): string {
  return `<pasted_content id="${id}">\n${text}\n</pasted_content id="${id}">`
}
