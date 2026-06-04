/**
 * permission-trail.ts — Append-only JSONL event store for the CSCB-side
 * visibility trail of the AD↔CSCB tool-permission relay (SRD t1.cdb.4g).
 *
 * One JSON object per newline-terminated line in
 *   <SLACK_STATE_DIR>/permission-trail.jsonl
 * (default: ~/.claude/channels/slack/permission-trail.jsonl).
 *
 * Public API:
 *   - TrailEvent                  — enforced line schema
 *   - emitTrail(partial)          — auto-stamps `ts`, recommended call site API
 *   - emitTrailEvent(event)       — raw, accepts caller-supplied `ts`
 *   - _resetTrailFdForTests()     — test-only fd reset
 *
 * The emitter is the single enforcement point for SR-V-1 (correlation
 * envelope), SR-V-3 (no truncation in the canonical store), and SR-V-4.5
 * (RFC 3339 sub-second `ts`, stable hierarchical `event` identifier).
 *
 * SPDX-License-Identifier: MIT
 */

import { mkdirSync, openSync, writeSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

// ---------------------------------------------------------------------------
// Line schema
// ---------------------------------------------------------------------------

/**
 * Required envelope fields enforced by the type system on every emitted line.
 * `event` is a stable hierarchical identifier in the `cscb.*` namespace
 * (SR-V-4.5). `ts` is RFC 3339 with at least millisecond precision
 * (SR-V-4.3, SR-V-4.5).
 */
export interface TrailEventBase {
  ts: string
  event: string
  /** SR-V-1.1: AD-minted UUID, absent for events before token assignment (SR-V-1.2). */
  request_token?: string
  /** SR-V-1.2: present whenever known. */
  claude_instance_id?: string
  /** SR-V-1.3: Slack channel id for events that touch Slack. */
  channel?: string
  /** SR-V-1.3: Slack message ts for events that touch Slack. */
  message_ts?: string
}

/**
 * One emitted JSONL line. Extends the required envelope with an open index
 * signature so per-event-class fields pass through verbatim (no truncation
 * per SR-V-3.1) without a cast at the call site.
 */
export type TrailEvent = TrailEventBase & { [extra: string]: unknown }

// ---------------------------------------------------------------------------
// Per-event-class field types
// ---------------------------------------------------------------------------

/**
 * The six canonical row-decision identifiers used as the `action` field on
 * `cscb.poller.row_decision` events (SR-V-2.3). Exported for type-narrowing
 * at the emission site.
 *
 * The set is open to extension per SR-V-2.3: the `(string & {})` widening
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

/** Open string-literal union per SR-V-2.3 — canonical values plus any new identifier. */
// eslint-disable-next-line @typescript-eslint/ban-types
export type RowDecisionAction = CanonicalRowDecisionAction | (string & {})

/**
 * The 8 canonical verdict tags carried on `cscb.chat_update.attempted` events
 * (SR-V-2.5). 6 are emitted by the poller's `renderClosureUpdate`; 2 are
 * emitted by the click handler's verdict-render path. Open to extension.
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
] as const

export type CanonicalClosureVerdictTag = (typeof CLOSURE_VERDICT_TAGS)[number]

// eslint-disable-next-line @typescript-eslint/ban-types
export type ClosureVerdictTag = CanonicalClosureVerdictTag | (string & {})

/** Which surface triggered a closure `chat.update` (SR-V-2.5). Open to extension. */
// eslint-disable-next-line @typescript-eslint/ban-types
export type TriggeredBy = 'poller' | 'click_handler' | (string & {})

// ---------------------------------------------------------------------------
// State-dir + path resolution
// ---------------------------------------------------------------------------

const TRAIL_FILENAME = 'permission-trail.jsonl'

function resolveStateDir(): string {
  const fromEnv = process.env['SLACK_STATE_DIR']
  return fromEnv ? resolve(fromEnv) : join(homedir(), '.claude', 'channels', 'slack')
}

function resolveTrailPath(): string {
  return join(resolveStateDir(), TRAIL_FILENAME)
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
 * Recommended call-site API for Epics 2–5: stamps `ts` from
 * `new Date().toISOString()` (RFC 3339 with ms precision) and delegates to
 * `emitTrailEvent`. Callers pass everything except `ts`.
 */
export function emitTrail(
  partial: Omit<TrailEventBase, 'ts'> & { [extra: string]: unknown },
): void {
  emitTrailEvent({ ...partial, ts: new Date().toISOString() })
}
