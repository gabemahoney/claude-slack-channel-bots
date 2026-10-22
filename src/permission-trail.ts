/**
 * permission-trail.ts — Append-only JSONL event store for the CSCB-side
 * visibility trail of the AD↔CSCB tool-permission relay.
 *
 * One JSON object per newline-terminated line in
 *   <SLACK_STATE_DIR>/permission-trail.jsonl
 * (default: ~/.config/claude-slack-channel-bots/permission-trail.jsonl, `resolveServerStateDir` in config.ts).
 *
 * Public API:
 *   - TrailEvent                  — enforced line schema
 *   - emitTrail(partial)          — auto-stamps `ts`, recommended call site API
 *   - emitTrailEvent(event)       — raw, accepts caller-supplied `ts`
 *   - _resetTrailFdForTests()     — test-only fd reset
 *
 * The emitter enforces the correlation envelope, no truncation in the
 * canonical store, RFC 3339 sub-second `ts`, and a stable hierarchical
 * `event` identifier.
 *
 * SPDX-License-Identifier: MIT
 */

import { mkdirSync, openSync, writeSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { resolveServerStateDir } from './config.ts'

// ---------------------------------------------------------------------------
// Line schema
// ---------------------------------------------------------------------------

/**
 * Required envelope fields enforced by the type system on every emitted line.
 * `event` is a stable hierarchical identifier in the `cscb.*` namespace. `ts` is RFC 3339 with at least millisecond
 * precision.
 */
export interface TrailEventBase {
  ts: string
  event: string
  /** AD-minted UUID, absent for events before token assignment. */
  request_token?: string
  /** present whenever known. */
  instance_id?: string
  /** Slack channel id for events that touch Slack. */
  channel?: string
  /** Slack message ts for events that touch Slack. */
  message_ts?: string
}

/**
 * One emitted JSONL line. Extends the required envelope with an open index
 * signature so per-event-class fields pass through verbatim without truncation
 * or a cast at the call site.
 */
export type TrailEvent = TrailEventBase & { [extra: string]: unknown }

// ---------------------------------------------------------------------------
// Per-event-class field types
// ---------------------------------------------------------------------------

/**
 * The six canonical row-decision identifiers used as the `action` field on
 * `cscb.poller.row_decision` events. Exported for type-narrowing
 * at the emission site.
 *
 * The set is open to extension: the `(string & {})` widening
 * keeps existing literals discoverable in editor completions while still
 * accepting new identifiers without a type change.
 */
export const ROW_DECISION_ACTIONS = [
  'post_attempted',
  'already_tracked',
  'reconciled_closed',
  'not_found_generic_deny',
  'non_conforming_skipped',
  'transient_retry',
] as const

export type CanonicalRowDecisionAction = (typeof ROW_DECISION_ACTIONS)[number]

/** Open string-literal union — canonical values plus any new identifier. */
// eslint-disable-next-line @typescript-eslint/ban-types
export type RowDecisionAction = CanonicalRowDecisionAction | (string & {})

/**
 * The canonical verdict tags carried on `cscb.chat_update.attempted` events. Six are emitted by the poller's `renderClosureUpdate`; the
 * `click_handler_*` tags are emitted by the click handler's verdict-render
 * path. Open to extension.
 *
 * `click_handler_relay_fallen_back` is not a verdict — it records that AD
 * refused the click because the request's relay window had already elapsed
 * the real answer is given at the tmux pane.
 */
export const CLOSURE_VERDICT_TAGS = [
  'operator_allow',
  'operator_deny',
  'timeout',
  'find_missing',
  'unknown',
  'not_found',
  'click_handler_allow',
  'click_handler_deny',
  'click_handler_relay_fallen_back',
] as const

export type CanonicalClosureVerdictTag = (typeof CLOSURE_VERDICT_TAGS)[number]

// eslint-disable-next-line @typescript-eslint/ban-types
export type ClosureVerdictTag = CanonicalClosureVerdictTag | (string & {})

/** Which surface triggered a closure `chat.update`. Open to extension. */
// eslint-disable-next-line @typescript-eslint/ban-types
export type TriggeredBy = 'poller' | 'click_handler' | (string & {})

/**
 * Stable reasons a `cscb.block_action.received` event records when the
 * inbound `action_id` failed `parsePermissionActionId`. Open to
 * extension. `stale_prompt` is intentionally NOT in this set — stale clicks
 * decode fine and show up as `cscb.click_handler.invoked{live_pending:false}`.
 */
export const PARSE_FAILURE_REASONS = [
  'foreign_action_id',
  'malformed_token',
] as const

export type CanonicalParseFailureReason = (typeof PARSE_FAILURE_REASONS)[number]

// eslint-disable-next-line @typescript-eslint/ban-types
export type ParseFailureReason = CanonicalParseFailureReason | (string & {})

/** Decoded permission decision carried on inbound click events. */
export type ClickDecision = 'allow' | 'deny'

/**
 * Classification of an agent-director `decide` response on the CSCB call
 * side. The named error classes match the AD error
 * identifiers in `src/agent-director-errors.ts`. `"other"` is the catch-all
 * for any other thrown value; the emit additionally carries a
 * `raw_error_message` string in that case. Open extension allowed.
 */
export const AD_DECIDE_RESPONSE_CLASSES = [
  'ok',
  'ErrAlreadyDecided',
  'ErrInvalidFlags',
  'ErrAmbiguousRequest',
  'ErrRelayFallenBack',
  'other',
] as const

export type CanonicalAdDecideResponseClass = (typeof AD_DECIDE_RESPONSE_CLASSES)[number]

// eslint-disable-next-line @typescript-eslint/ban-types
export type AdDecideResponseClass = CanonicalAdDecideResponseClass | (string & {})

// ---------------------------------------------------------------------------
// State-dir + path resolution
// ---------------------------------------------------------------------------

const TRAIL_FILENAME = 'permission-trail.jsonl'

function resolveTrailPath(): string {
  return join(resolveServerStateDir(), TRAIL_FILENAME)
}

// ---------------------------------------------------------------------------
// Lazy-open module-scoped fd (mirrors src/logging.ts)
// ---------------------------------------------------------------------------

let fd: number | null = null

/**
 * Test-only: reset the module-scoped fd so a subsequent emit reopens the file
 * (typically against a fresh `SLACK_STATE_DIR` temp directory). Mirrors the
 * `resetClientForTests` pattern in `src/agent-director-client.ts`.
 *
 * @internal
 */
export function _resetTrailFdForTests(): void {
  fd = null
}

// ---------------------------------------------------------------------------
// Emission
// ---------------------------------------------------------------------------

const ISO_TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3,}Z$/

function isValidTs(ts: unknown): ts is string {
  return typeof ts === 'string' && ts.trim() !== '' && ISO_TIMESTAMP_RE.test(ts)
}

/**
 * Append one fully-formed `TrailEvent` to the trail file. Use this when the
 * caller supplies its own `ts` (e.g. test fixtures replaying historical
 * events). Most production call sites should prefer `emitTrail`.
 *
 * Defensive guard: if `ts` is missing, empty, or not RFC 3339 with ms
 * precision, substitute `new Date().toISOString()` and log a `[slack]`
 * warning. Silently corrupting a trail line is worse than logging.
 *
 * Never throws. Write failures are caught and logged to stderr with the
 * `[slack]` prefix per engineering-guide convention.
 */
export function emitTrailEvent(event: TrailEvent): void {
  let toWrite: TrailEvent = event
  if (!isValidTs(event.ts)) {
    const stamped = new Date().toISOString()
    console.error(
      `[slack] permission-trail: missing/invalid ts on event=${String(event.event)} — substituting ${stamped}`,
    )
    toWrite = { ...event, ts: stamped }
  }

  try {
    if (fd === null) {
      const path = resolveTrailPath()
      mkdirSync(dirname(path), { recursive: true })
      fd = openSync(path, 'a')
    }
    const line = JSON.stringify(toWrite) + '\n'
    writeSync(fd, line)
  } catch (err) {
    console.error('[slack] permission-trail: write failed', err)
  }
}

/**
 * Recommended call-site API: stamps `ts` from
 * `new Date().toISOString()` (RFC 3339 with ms precision) and delegates to
 * `emitTrailEvent`. Callers pass everything except `ts`.
 */
export function emitTrail(
  partial: Omit<TrailEventBase, 'ts'> & { [extra: string]: unknown },
): void {
  emitTrailEvent({ ...partial, ts: new Date().toISOString() })
}
