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
import type { ClosureVerdictTag, TrailEventBase } from './permission-trail.ts'

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
 * Handle a permission Block Kit click. Returns true when the action_id was a
 * valid permission decision (the caller has already ack'd); false when the
 * action_id did not match the expected shape (caller should keep looking).
 */
export async function handlePermissionClick(
  actionId: string,
  deps: ClickDeps,
): Promise<boolean> {
  const parsed = parsePermissionActionId(actionId)
  if (parsed === null) return false

  const { decision, claudeInstanceId, requestToken } = parsed

  // SR-4.1, SR-4.2, SR-7.2: AD is the source of truth. Always call decide
  // with the decoded request_token — including for stale clicks whose
  // composite key is no longer in the pending map. This is the click's ONLY
  // AD interaction (SR-4.3 retires the pre-decide get).
  try {
    await decideWithToken(deps.getClient(), {
      claude_instance_id: claudeInstanceId,
      decision,
      request_token: requestToken,
    })
  } catch (err) {
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
  const emit = deps.emitTrail ?? defaultEmitTrail
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
