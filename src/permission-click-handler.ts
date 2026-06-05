/**
 * permission-click-handler.ts — Block Kit decision relay.
 *
 * Consumes Socket Mode interactive events whose `action_id` matches
 * `perm_(allow|deny)_<claude_instance_id>_<request_token>`. The handler is
 * a small, single-AD-call function: it parses the action_id, calls AD's
 * `decide` (always carrying `request_token`), and — when a live entry is
 * still present — renders the operator-decide verdict against just that
 * row's Slack message.
 *
 * Stale clicks (entry absent from the pending map) still hit AD so that
 * AD remains the source of truth; the next poller tick reconciles the
 * Slack rendering. `ErrAlreadyDecided` is the canonical race sentinel and
 * is swallowed silently for the same reason.
 *
 * SPDX-License-Identifier: MIT
 */

import { AgentDirectorError, ErrAlreadyDecided } from 'agent-director'
import type { Client } from 'agent-director'
import type { WebClient } from '@slack/web-api'

import { decideWithToken } from './agent-director-client.ts'
import { parsePermissionActionId, type PermissionDecision } from './permission-action-id.ts'
import { getLivePermission, markHandled } from './permission-poller.ts'
import { emitTrail as defaultEmitTrail } from './permission-trail.ts'
import type {
  AdDecideResponseClass,
  ClosureVerdictTag,
  ParseFailureReason,
  TrailEventBase,
} from './permission-trail.ts'

export interface ClickDeps {
  /** Returns an AD Client whose `decide` method this handler will invoke. */
  getClient: () => Pick<Client, 'decide'>
  web: Pick<WebClient, 'chat'>
  log?: (...args: unknown[]) => void
  /**
   * Trail emitter hook (SR-V). Defaults to `emitTrail` from
   * `permission-trail.ts`. Tests override with a capture stub.
   */
  emitTrail?: (
    partial: Omit<TrailEventBase, 'ts'> & { [extra: string]: unknown },
  ) => void
}

function logDeps(deps: ClickDeps, ...args: unknown[]): void {
  if (deps.log) deps.log(...args)
  else console.error(...args)
}

/**
 * SR-V-2.7 call-side classification of an agent-director `decide` error.
 * Mirrors the existing branches in `handlePermissionClick`'s catch so the
 * trail's `result_class` is identical to the operational discriminator.
 */
function classifyAdDecideError(err: unknown): AdDecideResponseClass {
  if (err instanceof ErrAlreadyDecided) return 'ErrAlreadyDecided'
  if (err instanceof AgentDirectorError && err.errName === 'ErrInvalidFlags') return 'ErrInvalidFlags'
  if (err instanceof AgentDirectorError && err.errName === 'ErrAmbiguousRequest') return 'ErrAmbiguousRequest'
  return 'other'
}

/** SR-V-2.5 Slack error class string (mirrors permission-poller.ts). */
function classifySlackError(err: unknown): string {
  if (err !== null && typeof err === 'object') {
    const data = (err as { data?: unknown }).data
    if (data !== null && typeof data === 'object') {
      const e = (data as { error?: unknown }).error
      if (typeof e === 'string' && e.length > 0) return e
    }
  }
  if (err instanceof Error) {
    if (err.name === 'AbortError') return 'aborted'
    return 'network_error'
  }
  return 'unknown_error'
}

// Match the poller's SR-2.4 terminal verdict text exactly so the click-handler
// render and the next-tick reconciliation render are byte-identical — no
// visible flicker.
function buildDecisionBlocks(decision: PermissionDecision): unknown[] {
  const text = decision === 'allow'
    ? '*Permission* — Allowed'
    : '*Permission* — Denied by operator'
  return [
    {
      type: 'section',
      text: { type: 'mrkdwn', text },
    },
  ]
}

/**
 * Inbound context captured from the Socket Mode interactive payload. Used by
 * the SR-V-2.6 `cscb.click_handler.invoked` event so investigations can
 * pivot by clicking user or by the Slack message being clicked against.
 * Optional so unit-test call sites can omit it; the trail event records the
 * fields as undefined/missing when not supplied (open envelope per SR-V-1).
 */
export interface ClickInteractionContext {
  /** Inbound Slack channel id from the interactive payload. */
  channel?: string
  /** The clicked-message ts from the interactive payload. */
  messageTs?: string
  /** Clicking user's Slack id from the interactive payload. */
  user?: string
}

/**
 * Handle a permission Block Kit click. Returns true when the action_id was a
 * valid permission decision (the caller has already ack'd); false when the
 * action_id did not match the expected shape (caller should keep looking).
 */
export async function handlePermissionClick(
  actionId: string,
  deps: ClickDeps,
  context: ClickInteractionContext = {},
): Promise<boolean> {
  const parsed = parsePermissionActionId(actionId)
  if (parsed === null) return false

  const { decision, claudeInstanceId, requestToken } = parsed
  const emit = deps.emitTrail ?? defaultEmitTrail
  // SR-V-2.6: live_pending captures the click-time state. Read the entry
  // here so the trail event records the value at handler entry, before any
  // markHandled / drop later in this function (or in the next tick) mutates
  // the map.
  const earlyEntry = getLivePermission(claudeInstanceId, requestToken)
  emit({
    event: 'cscb.click_handler.invoked',
    claude_instance_id: claudeInstanceId,
    request_token: requestToken,
    channel: context.channel ?? earlyEntry?.channelId,
    message_ts: context.messageTs ?? earlyEntry?.messageTs,
    user: context.user,
    raw_action_id: actionId,
    decision,
    live_pending: earlyEntry !== undefined,
  })

  // SR-4.1, SR-4.2, SR-7.2: AD is the source of truth. Always call decide
  // with the decoded request_token — including for stale clicks whose
  // composite key is no longer in the pending map. This is the click's ONLY
  // AD interaction (SR-4.3 retires the pre-decide get).
  const decideEnvelope = {
    event: 'cscb.ad_decide.attempted',
    claude_instance_id: claudeInstanceId,
    request_token: requestToken,
    decision,
  }
  try {
    await decideWithToken(deps.getClient(), {
      claude_instance_id: claudeInstanceId,
      decision,
      request_token: requestToken,
    })
    // SR-V-2.7 call-side success emission.
    emit({ ...decideEnvelope, result_class: 'ok' satisfies AdDecideResponseClass })
  } catch (err) {
    // SR-V-2.7 call-side failure emission. Classify against the same AD
    // error names the existing branches discriminate on so the trail's
    // result_class stays consistent with src/agent-director-errors.ts. The
    // existing logDeps operational logging is preserved alongside the
    // canonical trail event — the two serve different purposes (live
    // stderr vs after-the-fact debugging).
    const result_class: AdDecideResponseClass = classifyAdDecideError(err)
    const emission: Omit<TrailEventBase, 'ts'> & { [extra: string]: unknown } = {
      ...decideEnvelope,
      result_class,
    }
    if (result_class === 'other') {
      const raw = err instanceof Error ? err.message : String(err)
      emission['raw_error_message'] = raw
    }
    emit(emission)

    // SR-4.4: ErrAlreadyDecided is silently swallowed — the next poller tick
    // reconciles the operator-visible Slack rendering via SR-2.4 / SR-5.
    if (err instanceof ErrAlreadyDecided) return true
    if (err instanceof AgentDirectorError && err.errName === 'ErrInvalidFlags') {
      logDeps(deps, `[slack] permission-click: ErrInvalidFlags from decide for ${claudeInstanceId} (request_token=${requestToken})`)
      return true
    }
    // ErrAmbiguousRequest is a defense-in-depth backstop per SR-4.4; under
    // contract it should be unreachable.
    if (err instanceof AgentDirectorError && err.errName === 'ErrAmbiguousRequest') {
      logDeps(deps, `[slack] permission-click: ErrAmbiguousRequest from decide for ${claudeInstanceId} (request_token=${requestToken})`)
      return true
    }
    const e = err instanceof AgentDirectorError ? err : null
    logDeps(deps, `[slack] permission-click: decide failed for ${claudeInstanceId}: ${e?.errName ?? String(err)}`)
    return true
  }

  // SR-4.2 stale-click semantics: decide already fired; no live entry means
  // nothing to render against here. (The poller's reconciliation tick will
  // surface the closure on whichever Slack message currently tracks it.)
  const entry = getLivePermission(claudeInstanceId, requestToken)
  if (!entry) return true

  // SR-4.5 sibling independence: target only this row's messageTs.
  const text = decision === 'allow'
    ? '*Permission* — Allowed'
    : '*Permission* — Denied by operator'
  const blocks = buildDecisionBlocks(decision)
  const verdictTag: ClosureVerdictTag = decision === 'allow'
    ? 'click_handler_allow'
    : 'click_handler_deny'
  const envelope = {
    event: 'cscb.chat_update.attempted',
    claude_instance_id: claudeInstanceId,
    request_token: requestToken,
    channel: entry.channelId,
    message_ts: entry.messageTs,
    text,
    blocks,
    verdict_tag: verdictTag,
    triggered_by: 'click_handler' as const,
  }
  try {
    await deps.web.chat.update({
      channel: entry.channelId,
      ts: entry.messageTs,
      text,
      blocks: blocks as never,
    })
    markHandled(claudeInstanceId, requestToken)
    emit({ ...envelope, ok: true })
  } catch (err) {
    // SR-V-2.5: failure-only logDeps removed; ok=false event is now the
    // first-class failure signal. error carries the Slack platform error
    // class string, not JS Error.name.
    emit({ ...envelope, ok: false, error: classifySlackError(err) })
  }
  return true
}

// ---------------------------------------------------------------------------
// SR-V-2.9 inbound block_actions emission
// ---------------------------------------------------------------------------

/**
 * Classify a `block_actions` action_id for the SR-V-2.9 trail event without
 * mutating state. Exported so `src/server.ts`'s `socket.on('interactive')`
 * handler stays a thin wiring layer and so this branch can be unit-tested
 * in isolation (server.ts has module-load side effects and is not directly
 * importable from tests).
 *
 * The decision split is intentional: a `perm_(allow|deny)_*` prefix
 * indicates a CSCB permission button whose body failed to parse
 * (`malformed_token`); anything else is foreign (`foreign_action_id`). Note
 * that `stale_prompt` is NOT a parse-failure reason here — a stale click
 * decodes fine and shows up as `cscb.click_handler.invoked{live_pending:false}`.
 */
const PERMISSION_BUTTON_PREFIX_RE = /^perm_(allow|deny)_/

export interface BlockActionTrailContext {
  /** Inbound Slack channel id from the interactive payload. */
  channel?: string
  /** Clicked message ts from the interactive payload. */
  messageTs?: string
  /** Clicking user's Slack id. */
  user?: string
}

/**
 * Emit one `cscb.block_action.received` event for an inbound `block_actions`
 * action_id. Called once per action in the payload's `actions` array,
 * regardless of whether the action_id decodes (SR-V-2.9 — the
 * decode-failure case is the diagnostically critical surface for
 * "I clicked Allow and nothing happened").
 */
export function emitBlockActionReceived(
  actionId: string,
  context: BlockActionTrailContext,
  emit: (
    partial: Omit<TrailEventBase, 'ts'> & { [extra: string]: unknown },
  ) => void = defaultEmitTrail,
): void {
  const parsed = parsePermissionActionId(actionId)
  const base = {
    event: 'cscb.block_action.received',
    channel: context.channel,
    message_ts: context.messageTs,
    user: context.user,
    raw_action_id: actionId,
  }
  if (parsed !== null) {
    emit({
      ...base,
      claude_instance_id: parsed.claudeInstanceId,
      request_token: parsed.requestToken,
      decision: parsed.decision,
    })
    return
  }
  const reason: ParseFailureReason = PERMISSION_BUTTON_PREFIX_RE.test(actionId)
    ? 'malformed_token'
    : 'foreign_action_id'
  emit({ ...base, parse_failure_reason: reason })
}
