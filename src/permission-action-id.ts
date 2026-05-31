/**
 * permission-action-id.ts — Encode/decode Block Kit action IDs.
 *
 * Action IDs are emitted by the permission poller and consumed by the
 * interactive-message click handler. The format encodes:
 *
 *   perm_<allow|deny>_<claude_instance_id>_<request_token>
 *
 * `claude_instance_id` is `cscb_<channelId>` and can itself contain
 * underscores. The trailing `request_token` is an opaque per-request
 * identifier minted by agent-director — CSCB MUST NOT parse or otherwise
 * interpret its bytes (the regex anchors on UUIDv4 outer shape only to
 * fix the middle capture group's rightmost boundary, not to validate the
 * token contents).
 *
 * SPDX-License-Identifier: MIT
 */

export type PermissionDecision = 'allow' | 'deny'

export interface ParsedPermissionActionId {
  decision: PermissionDecision
  claudeInstanceId: string
  requestToken: string
}

/**
 * Anchored regex. The trailing UUIDv4-shape group is an outer-structure
 * anchor used to disambiguate the middle (underscore-bearing)
 * claude_instance_id capture — NOT a token-content validator.
 */
export const PERMISSION_ACTION_ID_RE: RegExp =
  /^perm_(allow|deny)_(cscb_.+)_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/

/**
 * Build the action_id string for a permission decision button.
 *
 * Decision and `cscb_` prefix are validated as before. `request_token` is
 * checked only for non-empty string — its bytes are opaque to CSCB.
 */
export function encodePermissionActionId(
  decision: PermissionDecision,
  claudeInstanceId: string,
  requestToken: string,
): string {
  if (decision !== 'allow' && decision !== 'deny') {
    throw new Error(`encodePermissionActionId: invalid decision: ${String(decision)}`)
  }
  if (!claudeInstanceId.startsWith('cscb_') || claudeInstanceId.length <= 'cscb_'.length) {
    throw new Error(`encodePermissionActionId: claudeInstanceId must start with 'cscb_' and be non-empty after the prefix: ${claudeInstanceId}`)
  }
  if (typeof requestToken !== 'string' || requestToken.length === 0) {
    throw new Error(`encodePermissionActionId: request_token must be a non-empty string`)
  }
  return `perm_${decision}_${claudeInstanceId}_${requestToken}`
}

/**
 * Parse the action_id back into its three components. Returns null when the
 * input doesn't match the anchored shape — callers should treat that as a
 * stale-button no-op rather than crashing.
 */
export function parsePermissionActionId(actionId: string): ParsedPermissionActionId | null {
  const match = PERMISSION_ACTION_ID_RE.exec(actionId)
  if (match === null) return null
  const decision = match[1] as PermissionDecision
  const claudeInstanceId = match[2]
  const requestToken = match[3]
  return { decision, claudeInstanceId, requestToken }
}
