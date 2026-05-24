/**
 * permission-action-id.ts — Encode/decode SR-2.2 Block Kit action IDs.
 *
 * Action IDs are emitted by the permission poller and consumed by the
 * interactive-message click handler. The format encodes:
 *
 *   perm_<allow|deny>_<claude_instance_id>_<request_id>
 *
 * `claude_instance_id` is `cscb_<channelId>` and can itself contain
 * underscores (channel IDs are typically uppercase + digits, but the
 * naming scheme is extensible and the encoder must be safe for any
 * shape the SR-1.1 spec admits).
 *
 * Naive `split('_')` is forbidden — the parser anchors on the trailing
 * numeric `request_id` via this regex:
 *
 *   ^perm_(allow|deny)_(cscb_.+)_(\d+)$
 *
 * Capture group 1 = decision; group 2 = claude_instance_id;
 * group 3 = request_id.
 *
 * SPDX-License-Identifier: MIT
 */

export type PermissionDecision = 'allow' | 'deny'

export interface ParsedPermissionActionId {
  decision: PermissionDecision
  claudeInstanceId: string
  requestId: number
}

/** Anchored regex per SR-2.2. Exported for the invariant test. */
export const PERMISSION_ACTION_ID_RE: RegExp = /^perm_(allow|deny)_(cscb_.+)_(\d+)$/

/**
 * Build the action_id string for a permission decision button.
 *
 * `request_id` must be a non-negative safe integer; passing a bigint or
 * a string is a type error at the call site.
 */
export function encodePermissionActionId(
  decision: PermissionDecision,
  claudeInstanceId: string,
  requestId: number,
): string {
  if (decision !== 'allow' && decision !== 'deny') {
    throw new Error(`encodePermissionActionId: invalid decision: ${String(decision)}`)
  }
  if (!claudeInstanceId.startsWith('cscb_') || claudeInstanceId.length <= 'cscb_'.length) {
    throw new Error(`encodePermissionActionId: claudeInstanceId must start with 'cscb_' and be non-empty after the prefix: ${claudeInstanceId}`)
  }
  if (!Number.isInteger(requestId) || requestId < 0 || requestId > Number.MAX_SAFE_INTEGER) {
    throw new Error(`encodePermissionActionId: request_id must be a non-negative safe integer: ${requestId}`)
  }
  return `perm_${decision}_${claudeInstanceId}_${requestId}`
}

/**
 * Parse the action_id back into its three components. Returns null when the
 * input doesn't match the SR-2.2 shape — callers should treat that as a
 * stale-button no-op rather than crashing.
 *
 * The trailing numeric `request_id` anchor is what makes underscore-bearing
 * `claude_instance_id` values safe (regex is greedy on the middle capture
 * group and uses the trailing `\d+` to fix the rightmost boundary).
 */
export function parsePermissionActionId(actionId: string): ParsedPermissionActionId | null {
  const match = PERMISSION_ACTION_ID_RE.exec(actionId)
  if (match === null) return null
  const decision = match[1] as PermissionDecision
  const claudeInstanceId = match[2]
  const requestIdNum = Number(match[3])
  if (!Number.isFinite(requestIdNum) || !Number.isInteger(requestIdNum)) return null
  return { decision, claudeInstanceId, requestId: requestIdNum }
}
