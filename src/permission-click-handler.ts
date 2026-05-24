/**
 * permission-click-handler.ts — SR-2.2 Block Kit decision relay.
 *
 * Consumes Socket Mode interactive events whose action_id matches the
 * SR-2.2 shape `perm_(allow|deny)_<claude_instance_id>_<request_id>`.
 *
 * Sequence per click (SR-2.2):
 *   1. Parse the action_id; if malformed, treat as stale-click no-op.
 *   2. Look up the live entry in permission-poller's module-scoped map and
 *      set its `finalizedAt = now()` to claim the message (suppresses the
 *      poller's "expired" update for 30 s).
 *   3. `client.get({claude_instance_id})` and compare the typed
 *      `permission_request.request_id` to the encoded value. Mismatch →
 *      `chat.update` to "already decided" without calling decide().
 *   4. `client.decide({ claude_instance_id, decision })`. `ErrAlreadyDecided`
 *      is treated as success (idempotent).
 *   5. `chat.update` the live message to "Allowed/Denied by <user>".
 *      Drop the live entry.
 *
 * Errors after the claim leave `finalizedAt` set so the poller skips the
 * entry for the 30 s window; the operator can re-click.
 *
 * SPDX-License-Identifier: MIT
 */

import {
  AgentDirectorError,
  ErrAlreadyDecided,
  ErrSpawnNotFound,
} from 'agent-director'
import type { WebClient } from '@slack/web-api'

import { parsePermissionActionId, type PermissionDecision } from './permission-action-id.ts'
import {
  claimPermission,
  dropPermission,
  getLivePermission,
} from './permission-poller.ts'

export interface ClickDeps {
  getClient: () => {
    get: (params: import('agent-director').GetParams) => Promise<import('agent-director').GetResult>
    decide: (params: import('agent-director').DecideParams) => Promise<import('agent-director').DecideResult>
  }
  web: Pick<WebClient, 'chat'>
  /** Returns the display name for a Slack user id; used to label decision updates. */
  resolveUserName: (userId: string) => Promise<string>
  log?: (...args: unknown[]) => void
}

function logDeps(deps: ClickDeps, ...args: unknown[]): void {
  if (deps.log) deps.log(...args)
  else console.error(...args)
}

/** Build the Block Kit "decided" block for the chat.update payload. */
function buildDecisionBlocks(decision: PermissionDecision, userName: string): unknown[] {
  const label = decision === 'allow' ? 'Allowed' : 'Denied'
  return [
    {
      type: 'section',
      text: { type: 'mrkdwn', text: `*Permission* — ${label} by ${userName}` },
    },
  ]
}

/** Build the stale-click "already decided" Block Kit. */
function buildAlreadyDecidedBlocks(): unknown[] {
  return [
    {
      type: 'section',
      text: { type: 'mrkdwn', text: '⏳ Already decided — this prompt is stale.' },
    },
  ]
}

/**
 * Handle a permission Block Kit click. Returns true when the action_id was a
 * valid permission decision (the caller has already ack'd); false when the
 * action_id did not match the SR-2.2 shape (caller should keep looking).
 */
export async function handlePermissionClick(
  actionId: string,
  slackUserId: string,
  deps: ClickDeps,
): Promise<boolean> {
  const parsed = parsePermissionActionId(actionId)
  if (parsed === null) return false

  const { decision, claudeInstanceId, requestId } = parsed

  const entry = getLivePermission(claudeInstanceId)
  if (!entry) {
    // No live entry — either the poller hasn't seen this yet, or it already
    // expired. Either way, treat as a stale click no-op.
    logDeps(deps, `[slack] permission-click: no live entry for ${claudeInstanceId} (request_id=${requestId}) — stale click`)
    return true
  }

  // Step 2: claim the message so the poller doesn't race us.
  claimPermission(claudeInstanceId)

  // Step 3: refetch + compare request_id to detect stale-button clicks.
  let currentRequestId: number | null
  try {
    const got = await deps.getClient().get({ claude_instance_id: claudeInstanceId })
    currentRequestId = got.permission_request?.request_id ?? null
  } catch (err) {
    if (err instanceof ErrSpawnNotFound) {
      logDeps(deps, `[slack] permission-click: spawn ${claudeInstanceId} disappeared — marking stale`)
      currentRequestId = null
    } else {
      const e = err instanceof AgentDirectorError ? err : null
      logDeps(deps, `[slack] permission-click: get failed for ${claudeInstanceId}: ${e?.errName ?? String(err)}`)
      // Leave finalizedAt set so the poller skips the entry for 30 s.
      return true
    }
  }

  if (currentRequestId === null || currentRequestId !== requestId) {
    // Stale click — no decide() call.
    try {
      await deps.web.chat.update({
        channel: entry.channelId,
        ts: entry.messageTs,
        text: 'already decided — stale prompt',
        blocks: buildAlreadyDecidedBlocks() as never,
      })
    } catch (err) {
      logDeps(deps, `[slack] permission-click: stale-click chat.update failed for ${claudeInstanceId}:`, err)
    }
    dropPermission(claudeInstanceId)
    return true
  }

  // Step 4: call client.decide(). Idempotent — ErrAlreadyDecided counts as success.
  try {
    await deps.getClient().decide({ claude_instance_id: claudeInstanceId, decision })
  } catch (err) {
    if (!(err instanceof ErrAlreadyDecided)) {
      const e = err instanceof AgentDirectorError ? err : null
      logDeps(deps, `[slack] permission-click: decide failed for ${claudeInstanceId}: ${e?.errName ?? String(err)}`)
      // Leave finalizedAt set; the operator can re-click. Don't update the
      // Slack message — the buttons are still visible.
      return true
    }
  }

  // Step 5: confirm via chat.update. Resolve the user name for the label.
  let userName: string
  try {
    userName = slackUserId ? await deps.resolveUserName(slackUserId) : 'unknown'
  } catch {
    userName = slackUserId || 'unknown'
  }
  try {
    await deps.web.chat.update({
      channel: entry.channelId,
      ts: entry.messageTs,
      text: `Permission — ${decision === 'allow' ? 'Allowed' : 'Denied'} by ${userName}`,
      blocks: buildDecisionBlocks(decision, userName) as never,
    })
  } catch (err) {
    logDeps(deps, `[slack] permission-click: decision chat.update failed for ${claudeInstanceId}:`, err)
  }
  dropPermission(claudeInstanceId)
  return true
}
