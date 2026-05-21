/**
 * permission-click-handler.ts — Extracted click-handler logic for Slack interactive events.
 *
 * Contains the per-action logic for `perm_allow_*` and `perm_deny_*` button clicks.
 * Extracted from server.ts's `socket.on('interactive', ...)` closure to allow unit testing
 * without importing server.ts (which has module-level side effects).
 *
 * The handler is called once per action in the actions array. It returns a string indicating
 * whether it handled the action ('handled') or skipped it ('not-permission', 'malformed').
 * Callers are responsible for calling ack() after all actions are processed.
 *
 * SPDX-License-Identifier: MIT
 */

import { parsePermissionActionId } from './permission-action-id.ts'
import type { GetResult, DecideResult } from './claude-director-cli.ts'
import type { LivePromptEntry } from './permission-poller.ts'

// ---------------------------------------------------------------------------
// Deps interface
// ---------------------------------------------------------------------------

export interface PermissionClickDeps {
  /** Look up a live prompt by claudeInstanceId. Returns undefined if absent (stale). */
  getLivePrompt(claudeInstanceId: string): LivePromptEntry | undefined
  /** Claim the entry by setting finalizedAt = Date.now(). No-op if absent. */
  markFinalized(claudeInstanceId: string): void
  /** Remove the entry from the live-prompts map. */
  dropLivePrompt(claudeInstanceId: string): void
  /** Call claude-director `get`. Synchronous result type. */
  cliGet(args: { claudeInstanceId: string }): GetResult
  /** Call claude-director `decide`. Synchronous result type. */
  cliDecide(args: { claudeInstanceId: string; requestId: string; decision: 'allow' | 'deny' }): DecideResult
  /** Update an existing Slack message. */
  chatUpdate(params: { channel: string; ts: string; text: string; blocks: unknown[] }): Promise<void>
  /** Post a new Slack message to a channel. */
  chatPostMessage(params: { channel: string; text: string }): Promise<void>
  /** Resolve a user ID to a display name. Returns the userId if resolution fails. */
  resolveUserName(userId: string): Promise<string>
}

// ---------------------------------------------------------------------------
// Result type
// ---------------------------------------------------------------------------

export type ClickHandlerResult =
  | 'handled'          // perm_* action fully handled (ok or error path)
  | 'not-permission'   // action_id does not start with perm_ → skip
  | 'malformed'        // action_id starts with perm_ but is malformed → logged + skip

// ---------------------------------------------------------------------------
// buildPermissionDecisionBlocks — replicated locally so server.ts does not need to export it
// ---------------------------------------------------------------------------

function buildPermissionDecisionBlocks(
  toolName: string,
  decision: 'allow' | 'deny',
  userName: string,
): unknown[] {
  const label = decision === 'allow' ? 'Allowed' : 'Denied'
  return [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*${toolName}* — ${label} by ${userName}`,
      },
    },
  ]
}

// ---------------------------------------------------------------------------
// handlePermissionClick — main entry point
// ---------------------------------------------------------------------------

/**
 * Handle a single Slack interactive action whose action_id may be a permission button.
 *
 * @param deps   Injected dependencies (stubbed in tests, real in server.ts).
 * @param actionId  The action_id from the Slack interactive payload.
 * @param userId    The Slack user ID of the clicker (from payload.user.id).
 * @returns 'handled' | 'not-permission' | 'malformed'
 */
export async function handlePermissionClick(
  deps: PermissionClickDeps,
  actionId: string,
  userId: string,
): Promise<ClickHandlerResult> {
  const parsed = parsePermissionActionId(actionId)

  if (!parsed.ok) {
    if (parsed.reason === 'malformed') {
      console.warn('[slack] interactive: malformed perm_ action_id:', actionId)
      return 'malformed'
    }
    // not-permission-action
    return 'not-permission'
  }

  const { decision, claudeInstanceId, requestId } = parsed
  const userName = userId ? await deps.resolveUserName(userId) : 'unknown'

  // Step 1: look up live-prompts map. If absent → stale.
  // No chatUpdate here: without a live entry we have no channel/ts to update,
  // and Slack silently rejects empty channel/ts. Just log and ack.
  const liveEntry = deps.getLivePrompt(claudeInstanceId)
  if (!liveEntry) {
    console.warn('[slack] interactive: stale click — no live prompt for', claudeInstanceId)
    return 'handled'
  }

  // Step 2: Refetch via directorGet to verify current request_id (stale-button check).
  const getResult = deps.cliGet({ claudeInstanceId })
  if (!getResult.ok) {
    // ErrSpawnNotFound or other error → treat as stale
    console.warn('[slack] interactive: get failed for', claudeInstanceId, '—', getResult.error.kind)
    try {
      await deps.chatUpdate({
        channel: liveEntry.channelId,
        ts: liveEntry.messageTs,
        text: `${liveEntry.toolName} — already decided`,
        blocks: [{ type: 'section', text: { type: 'mrkdwn', text: `*${liveEntry.toolName}* — already decided` } }],
      })
    } catch (err) {
      console.error('[slack] interactive: chat.update (stale get-error) failed:', err)
    }
    return 'handled'
  }

  const currentPr = getResult.data.permissionRequest
  if (currentPr === null || currentPr.requestId !== requestId) {
    // request_id mismatch or no open request → stale button
    console.warn('[slack] interactive: stale button — request_id mismatch or no open request for', claudeInstanceId)
    try {
      await deps.chatUpdate({
        channel: liveEntry.channelId,
        ts: liveEntry.messageTs,
        text: `${liveEntry.toolName} — already decided`,
        blocks: [{ type: 'section', text: { type: 'mrkdwn', text: `*${liveEntry.toolName}* — already decided` } }],
      })
    } catch (err) {
      console.error('[slack] interactive: chat.update (stale mismatch) failed:', err)
    }
    return 'handled'
  }

  // Step 3: Claim the entry by setting finalized_at.
  deps.markFinalized(claudeInstanceId)

  // Step 4: Call decide.
  const decideResult = deps.cliDecide({ claudeInstanceId, requestId, decision })

  if (decideResult.ok) {
    // Step 5: Happy path — update Slack message, drop the live-prompts entry.
    const label = decision === 'allow' ? 'Allowed' : 'Denied'
    try {
      await deps.chatUpdate({
        channel: liveEntry.channelId,
        ts: liveEntry.messageTs,
        text: `${liveEntry.toolName} — ${label} by ${userName}`,
        blocks: buildPermissionDecisionBlocks(liveEntry.toolName, decision, userName),
      })
    } catch (err) {
      console.error('[slack] interactive: chat.update (happy path) failed:', err)
    }
    deps.dropLivePrompt(claudeInstanceId)
    return 'handled'
  }

  // Error variants
  const { kind } = decideResult.error
  if (
    kind === 'ErrAlreadyDecided' ||
    kind === 'ErrNoOpenPermissionRequest' ||
    kind === 'ErrSpawnNotFound'
  ) {
    // Idempotent — another actor already decided.
    try {
      await deps.chatUpdate({
        channel: liveEntry.channelId,
        ts: liveEntry.messageTs,
        text: `${liveEntry.toolName} — already decided`,
        blocks: [{ type: 'section', text: { type: 'mrkdwn', text: `*${liveEntry.toolName}* — already decided` } }],
      })
    } catch (err) {
      console.error('[slack] interactive: chat.update (already-decided) failed:', err)
    }
    deps.dropLivePrompt(claudeInstanceId)
    return 'handled'
  }

  if (kind === 'ErrRelayModeOff') {
    // SR-1.2 invariant violation — relay_mode should always be on.
    console.error('[slack] interactive: INVARIANT VIOLATION ErrRelayModeOff for', claudeInstanceId, '— relay_mode=off but template hard-codes relay_mode=on')
    try {
      await deps.chatPostMessage({
        channel: liveEntry.channelId,
        text: `⚠️ Invariant violation: relay_mode is off for instance ${claudeInstanceId}. This should not happen. Check claude-director template.`,
      })
    } catch (err) {
      console.error('[slack] interactive: chat.postMessage (relay-mode-off) failed:', err)
    }
    // Do NOT drop the entry per spec.
    return 'handled'
  }

  // Other errors: leave finalizedAt set (poller skips 30s window), log, no chat.update.
  console.error('[slack] interactive: decide error for', claudeInstanceId, ':', kind, decideResult.error)
  return 'handled'
}
