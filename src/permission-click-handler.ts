/**
 * permission-click-handler.ts — SR-2.2 Block Kit decision relay.
 *
 * Consumes Socket Mode interactive events whose action_id matches the
 * SR-2.2 shape `perm_(allow|deny)_<claude_instance_id>_<request_token>`.
 *
 * Ten-step sequence per click (SR-2.2):
 *   1. Parse the action_id; if malformed, return false (caller keeps looking).
 *   2. Extract { decision, claudeInstanceId, requestToken }.
 *   3. makePermKey(claudeInstanceId, requestToken) → key.
 *   4. getLivePermission(key); if absent → log stale + return true.
 *   5. claimPermission(key).
 *   6. client.getPermission({ request_token }) pre-flight.
 *   7. client.decide({ claude_instance_id, request_token, decision }).
 *   8. chat.update with buildDecisionBlocks(decision).
 *   9. dropPermission(key).
 *  10. Return true.
 *
 * Errors after the claim leave `finalizedAt` set so the poller skips the
 * entry for the 30 s window; the operator can re-click.
 *
 * SPDX-License-Identifier: MIT
 */

import {
  AgentDirectorError,
  ErrAlreadyDecided,
  ErrAmbiguousRequest,
  ErrInvalidFlags,
  ErrMissingRequestToken,
  ErrPermissionRequestNotFound,
} from 'agent-director'
import type {
  GetPermissionParams,
  GetPermissionResult,
} from 'agent-director'
import type { WebClient } from '@slack/web-api'

import { parsePermissionActionId, type PermissionDecision } from './permission-action-id.ts'
import {
  claimPermission,
  dropPermission,
  getLivePermission,
  makePermKey,
} from './permission-poller.ts'

export interface ClickDeps {
  getClient: () => {
    getPermission: (params: GetPermissionParams) => Promise<GetPermissionResult>
    decide: (params: import('agent-director').DecideParams) => Promise<import('agent-director').DecideResult>
  }
  web: Pick<WebClient, 'chat'>
  log?: (...args: unknown[]) => void
}

function logDeps(deps: ClickDeps, ...args: unknown[]): void {
  if (deps.log) deps.log(...args)
  else console.error(...args)
}

/** Build the Block Kit "decided" block for the chat.update payload. */
function buildDecisionBlocks(decision: PermissionDecision): unknown[] {
  const label = decision === 'allow' ? 'Allowed' : 'Denied'
  return [
    {
      type: 'section',
      text: { type: 'mrkdwn', text: `*Permission* — ${label}` },
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
  deps: ClickDeps,
): Promise<boolean> {
  // Step 1: parse action_id.
  const parsed = parsePermissionActionId(actionId)
  if (parsed === null) return false

  // Step 2: extract fields.
  const { decision, claudeInstanceId, requestToken } = parsed

  // Step 3: composite key.
  const key = makePermKey(claudeInstanceId, requestToken)

  // Step 4: look up live entry.
  const entry = getLivePermission(key)
  if (!entry) {
    logDeps(deps, `[slack] permission-click: no live entry for key=${key} — stale click`)
    return true
  }

  // Step 5: claim the message so the poller doesn't race us.
  claimPermission(key)

  // Step 6: pre-flight getPermission to detect already-decided / not-found.
  let result: GetPermissionResult
  try {
    result = await deps.getClient().getPermission({ request_token: requestToken })
  } catch (err) {
    if (err instanceof ErrPermissionRequestNotFound) {
      // Row is gone — update message to stale and clean up.
      try {
        await deps.web.chat.update({
          channel: entry.channelId,
          ts: entry.messageTs,
          text: 'already decided — stale prompt',
          blocks: buildAlreadyDecidedBlocks() as never,
        })
      } catch (updateErr) {
        logDeps(deps, `[slack] permission-click: stale chat.update failed for key=${key}:`, updateErr)
      }
      dropPermission(key)
      return true
    }
    if (err instanceof AgentDirectorError) {
      logDeps(deps, `[slack] permission-click: getPermission failed for key=${key}: ${err.errName}`)
      // Leave finalizedAt set; operator can re-click.
      return true
    }
    logDeps(deps, `[slack] permission-click: getPermission unexpected error for key=${key}:`, err)
    return true
  }

  // Already decided — update message to stale and clean up.
  if (result.decision != null) {
    try {
      await deps.web.chat.update({
        channel: entry.channelId,
        ts: entry.messageTs,
        text: 'already decided — stale prompt',
        blocks: buildAlreadyDecidedBlocks() as never,
      })
    } catch (updateErr) {
      logDeps(deps, `[slack] permission-click: stale chat.update failed for key=${key}:`, updateErr)
    }
    dropPermission(key)
    return true
  }

  // Step 7: call decide(). ErrAlreadyDecided is idempotent — fall through.
  try {
    await deps.getClient().decide({ claude_instance_id: claudeInstanceId, request_token: requestToken, decision })
  } catch (err) {
    if (err instanceof ErrAlreadyDecided) {
      // Idempotent — treat as success and fall through to chat.update.
    } else if (
      err instanceof ErrAmbiguousRequest ||
      err instanceof ErrMissingRequestToken ||
      err instanceof ErrInvalidFlags
    ) {
      // Relay bug — log ERROR but leave buttons visible (do NOT update message).
      logDeps(deps, `[slack] permission-click: ERROR relay bug for key=${key}: ${err.errName}`)
      return true
    } else if (err instanceof AgentDirectorError) {
      logDeps(deps, `[slack] permission-click: decide failed for key=${key}: ${err.errName}`)
      // Leave finalizedAt set; operator can re-click.
      return true
    } else {
      logDeps(deps, `[slack] permission-click: decide unexpected error for key=${key}:`, err)
      return true
    }
  }

  // Step 8: update message to reflect the decision.
  try {
    await deps.web.chat.update({
      channel: entry.channelId,
      ts: entry.messageTs,
      text: `Permission — ${decision === 'allow' ? 'Allowed' : 'Denied'}`,
      blocks: buildDecisionBlocks(decision) as never,
    })
  } catch (err) {
    logDeps(deps, `[slack] permission-click: decision chat.update failed for key=${key}:`, err)
  }

  // Step 9: drop the live entry.
  dropPermission(key)

  // Step 10: done.
  return true
}
