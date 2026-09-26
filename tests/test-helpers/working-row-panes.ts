/**
 * working-row-panes.ts — Claude Code screens and transcripts for the
 * stale-`working`-row cases (bug b.f2b).
 *
 * The wait at a launch (`waitForWaitingAndReconnect`) and the restart path's
 * evidence (`checkWorkingRowPane`, `checkWaitingRowPane`) read a persona's
 * pane while its agent-director row reads `working` (or `waiting`), and
 * reconnect a `working` row only on the positive-idle rule: the same idle
 * screen AND the same transcript, ending with a completed turn, across
 * `STALE_WORKING_WINDOW_MS`. The screens below are drawn as Claude Code
 * 2.1.280 draws them; the transcript entries are the JSONL lines it writes.
 * A suite builds its screens and transcripts from these rather than writing
 * its own.
 *
 * Time: the wait and the evidence take the session manager's clock seam, so
 * a suite passes `createFakeClock().now` to `_setNow` (reset with `_resetNow`
 * in `afterEach`) and moves it itself.
 *
 * SPDX-License-Identifier: MIT
 */

import { appendFileSync, writeFileSync } from 'node:fs'

// ---------------------------------------------------------------------------
// Screens
// ---------------------------------------------------------------------------

/** Claude Code's empty prompt box and its footer, at the bottom of every idle or busy screen below (2.1.x). */
const PROMPT_BOX = [
  '────────────────────────────────────────────────────────────────────────',
  '> ',
  '────────────────────────────────────────────────────────────────────────',
  '  ⏵⏵ bypass permissions on (shift+tab to cycle)',
]

/** Lines of an earlier, finished turn: enough to push a screen's older lines out of the bottom lines. */
const EARLIER_TURN = [
  '> check whether the nightly build passed and post the summary',
  '',
  '⏺ Bash(gh run view 4121 --json conclusion,jobs)',
  '  ⎿  {"conclusion":"success","jobs":[…]}',
  '',
]

/**
 * A real-looking Claude Code idle screen: the finished turn (a tool call, the
 * reply, the "Baked for" summary line with no ellipsis), then the empty
 * prompt box; tmux pads the pane with blank lines. More than twelve lines of
 * text, so anything above it is out of the bottom lines where Claude Code
 * draws its prompt box and dialogs.
 */
export const IDLE_PANE = [
  ...EARLIER_TURN,
  '⏺ The nightly build passed: 412 tests, no failures. I posted the',
  '  summary in the channel.',
  '',
  '✻ Baked for 4m 11s',
  '',
  ...PROMPT_BOX,
  '',
  '',
].join('\n')

/** Another idle screen: the same session after a later, different turn. */
export const OTHER_IDLE_PANE = IDLE_PANE.replace('412 tests, no failures', '413 tests, 1 skipped')

/**
 * The same session mid-turn: Claude Code's spinner line (a glyph at column 0,
 * a verb, an ellipsis, the elapsed time) above the prompt box. A running turn
 * redraws it every second.
 */
export const SPINNER_PANE = [
  '> check whether the nightly build passed and post the summary',
  '',
  '⏺ Bash(gh run watch 4121 --exit-status)',
  '  ⎿  Running…',
  '',
  '✳ Harmonizing… (2m 42s · ↓ 10.1k tokens)',
  '',
  ...PROMPT_BOX,
].join('\n')

/**
 * A tool-permission dialog no one has answered (Claude Code 2.1.x): boxed,
 * with its question, the `❯` cursor on option 1 and the deny option.
 */
export const PERMISSION_PANE = [
  '⏺ Bash(rm -rf build)',
  '',
  '╭──────────────────────────────────────────────────────────────╮',
  '│ Bash command                                                 │',
  '│                                                              │',
  '│   rm -rf build                                               │',
  '│   Remove the build directory                                 │',
  '│                                                              │',
  '│ Do you want to proceed?                                      │',
  '│ ❯ 1. Yes                                                     │',
  '│   2. No, and tell Claude what to do differently (esc)        │',
  '╰──────────────────────────────────────────────────────────────╯',
].join('\n')

/**
 * The plan-approval dialog (ExitPlanMode), unboxed: its question above the
 * numbered options, the cursor on option 1, no footer. Only the question
 * anchors it.
 */
export const PLAN_APPROVAL_PANE = [
  ...EARLIER_TURN,
  ' Here is Claude\'s plan:',
  '   - Rebuild the nightly job with the new runner image',
  '   - Post the summary in the channel',
  '',
  ' Would you like to proceed?',
  '',
  ' ❯ 1. Yes, and auto-accept edits',
  '   2. Yes, and manually approve edits',
  '   3. No, keep planning',
].join('\n')

/**
 * An AskUserQuestion select menu whose question has no question mark: option
 * descriptions between the numbered options and the "Enter to select"
 * footer, which alone anchors it.
 */
export const SELECT_MENU_PANE = [
  ...EARLIER_TURN,
  ' ☐ Deploy target',
  '',
  ' Pick the environment to deploy the nightly build to.',
  '',
  ' ❯ 1. staging',
  '      The shared staging cluster',
  '   2. production',
  '      Live traffic',
  '   3. Type something.',
  '',
  ' Enter to select · ↑/↓ to navigate · Esc to cancel',
].join('\n')

/** The `/model` picker: numbered options, the cursor on option 2, and the "Enter to confirm" footer. */
export const MODEL_PICKER_PANE = [
  ...EARLIER_TURN,
  ' Select model',
  ' Switch between Claude models. Applies to this session and future sessions.',
  '',
  '   1. Default (recommended)',
  ' ❯ 2. Opus',
  '   3. Haiku',
  '',
  ' Enter to confirm · Esc to exit',
].join('\n')

/** The folder-trust dialog at launch (2.1.x): its options and footer, no box. */
export const TRUST_DIALOG_PANE = [
  ' Accessing workspace:',
  '',
  ' /x',
  '',
  ' Quick safety check: Is this a project you created or one you trust? (Like your own code, a well-known open',
  ' source project, or work from your team). If not, take a moment to review what\'s in this folder first.',
  '',
  ' Claude Code\'ll be able to read, edit, and execute files here.',
  '',
  ' ❯ 1. Yes, I trust this folder',
  '   2. No, exit',
  '',
  ' Enter to confirm · Esc to cancel',
].join('\n')

/** The development-channels dialog at launch (2.1.x): its warning, options and footer. */
export const DEV_CHANNELS_DIALOG_PANE = [
  ' WARNING: Loading development channels',
  '',
  ' --dangerously-load-development-channels is for local channel development only. Do not use this option to',
  ' run channels you have downloaded off the internet.',
  '',
  ' Channels: server:slack-channel-router',
  '',
  ' ❯ 1. I am using this for local development',
  '   2. Exit',
  '',
  ' Enter to confirm · Esc to cancel',
].join('\n')

/**
 * The project MCP-server dialog: its options drawn inside the dialog's box,
 * with no question mark and no known option or footer, so the box alone
 * anchors it.
 */
export const MCP_SERVER_DIALOG_PANE = [
  ...EARLIER_TURN,
  '╭──────────────────────────────────────────────────────────────╮',
  '│ New MCP server found in .mcp.json: nightly-tools             │',
  '│                                                              │',
  '│ MCP servers may execute code or access system resources.     │',
  '│                                                              │',
  '│ ❯ 1. Use this and all future MCP servers in this project     │',
  '│   2. Use this MCP server                                     │',
  '│   3. Continue without using this MCP server                  │',
  '╰──────────────────────────────────────────────────────────────╯',
].join('\n')

/**
 * An idle screen whose last reply quotes a permission dialog: its question,
 * its numbered options and its deny option, but not the `❯` cursor, and the
 * empty prompt box below. Not a dialog.
 */
export const QUOTED_DIALOG_PANE = [
  ...EARLIER_TURN,
  '⏺ The tool asked:',
  '  Do you want to proceed?',
  '  1. Yes',
  '  2. No, and tell Claude what to do differently (esc)',
  '  I chose 1.',
  '',
  ...PROMPT_BOX,
].join('\n')

/**
 * An idle screen whose last reply quotes a menu with its cursor, but with no
 * question, known footer or box around it. Not a dialog.
 */
export const QUOTED_MENU_PANE = [
  ...EARLIER_TURN,
  '⏺ The deploy script printed its menu:',
  '  ❯ 1. staging',
  '    2. production',
  '  I picked staging.',
  '',
  ...PROMPT_BOX,
].join('\n')

/** `IDLE_PANE` with `line` as its last line of text (one of the bottom lines). */
export function withLastLine(line: string): string {
  return `${IDLE_PANE}\n${line}`
}

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
    version: '2.1.280',
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
