/**
 * permission-click-handler.ts — Block Kit decision relay.
 *
 * Consumes Socket Mode interactive events whose action_id matches
 * `perm_(allow|deny)_<claude_instance_id>_<request_token>`.
 *
 * Epic 1 keeps the legacy pre-decide reconciliation flow intact (rekeyed
 * onto the composite key + plural projection); Epic 2 will rewrite this
 * file to thread `request_token` through `decide()` and remove the
 * pre-decide refetch entirely.
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
  getLivePermission,
  markHandled,
  type GetResultWithPermissionRequests,
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
 * action_id did not match the expected shape (caller should keep looking).
 */
export async function handlePermissionClick(
  actionId: string,
  slackUserId: string,
  deps: ClickDeps,
): Promise<boolean> {
  const parsed = parsePermissionActionId(actionId)
  if (parsed === null) return false

  const { decision, claudeInstanceId, requestToken } = parsed

  const entry = getLivePermission(claudeInstanceId, requestToken)
  if (!entry) {
    logDeps(deps, `[slack] permission-click: no live entry for ${claudeInstanceId} (request_token=${requestToken}) — stale click`)
    return true
  }

  // Refetch + check whether the token still appears in the open-rows
  // projection to detect stale-button clicks.
  let tokenStillOpen: boolean
  try {
    const got = (await deps.getClient().get({
      claude_instance_id: claudeInstanceId,
    })) as unknown as GetResultWithPermissionRequests
    const rows = got.permission_requests
    tokenStillOpen = Array.isArray(rows) && rows.some((r) => r.request_token === requestToken)
  } catch (err) {
    if (err instanceof ErrSpawnNotFound) {
      logDeps(deps, `[slack] permission-click: spawn ${claudeInstanceId} disappeared — marking stale`)
      tokenStillOpen = false
    } else {
      const e = err instanceof AgentDirectorError ? err : null
      logDeps(deps, `[slack] permission-click: get failed for ${claudeInstanceId}: ${e?.errName ?? String(err)}`)
      return true
    }
  }

  if (!tokenStillOpen) {
    try {
      await deps.web.chat.update({
        channel: entry.channelId,
        ts: entry.messageTs,
        text: 'already decided — stale prompt',
        blocks: buildAlreadyDecidedBlocks() as never,
      })
      markHandled(claudeInstanceId, requestToken)
    } catch (err) {
      logDeps(deps, `[slack] permission-click: stale-click chat.update failed for ${claudeInstanceId}:`, err)
    }
    return true
  }

  // decide() still takes the two-field shape; Epic 2 adds request_token.
  try {
    await deps.getClient().decide({ claude_instance_id: claudeInstanceId, decision })
  } catch (err) {
    if (!(err instanceof ErrAlreadyDecided)) {
      const e = err instanceof AgentDirectorError ? err : null
      logDeps(deps, `[slack] permission-click: decide failed for ${claudeInstanceId}: ${e?.errName ?? String(err)}`)
      return true
    }
  }

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
    markHandled(claudeInstanceId, requestToken)
  } catch (err) {
    logDeps(deps, `[slack] permission-click: decision chat.update failed for ${claudeInstanceId}:`, err)
  }
  return true
}
