/**
 * permission-action-id.ts — Encode/decode Block Kit action IDs for permission prompts.
 *
 * Action IDs are emitted by the permission poller and consumed by the
 * interactive-message click handler. The format encodes:
 *
 *   perm_<allow|deny>_<claude_instance_id>_<request_token>
 *
 * `claude_instance_id` is `cscb_<channelId>`. `request_token` is a UUIDv4
 * string (lowercase hex, e.g. `550e8400-e29b-41d4-a716-446655440000`).
 *
 * UUIDs contain only hex digits and hyphens — no underscores — so the parse
 * regex can anchor on the UUID shape at the tail end:
 *
 *   ^perm_(allow|deny)_(cscb_.+)_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$
 *
 * Capture group 1 = decision; group 2 = claude_instance_id;
 * group 3 = request_token (UUID, lowercase).
 *
 * The regex is case-sensitive. UUIDs from the Go backend are always lowercase.
 * Old action IDs with a numeric suffix do not match and are treated as stale.
 *
 * SPDX-License-Identifier: MIT
 */

export type PermissionDecision = 'allow' | 'deny'

export interface ParsedPermissionActionId {
  decision: PermissionDecision
  claudeInstanceId: string
  requestToken: string   // UUIDv4 string, not a number
}

/** Anchored regex per SRD §OQ-1. Exported for invariant tests. */
export const PERMISSION_ACTION_ID_RE: RegExp =
  /^perm_(allow|deny)_(cscb_.+)_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/

/** UUID capture group pattern extracted from PERMISSION_ACTION_ID_RE for encoder validation. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/**
 * Build the action_id string for a permission decision button.
 *
 * All three arguments are validated; throws on invalid input so callers
 * surface programming errors early rather than posting malformed action IDs.
 *
 * `requestToken` must be a lowercase UUIDv4 string
 * (e.g. `550e8400-e29b-41d4-a716-446655440000`).
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
    throw new Error(
      `encodePermissionActionId: claudeInstanceId must start with 'cscb_' and be non-empty after the prefix: ${claudeInstanceId}`,
    )
  }
  if (!UUID_RE.test(requestToken)) {
    throw new Error(
      `encodePermissionActionId: requestToken must be a lowercase UUIDv4 string: ${requestToken}`,
    )
  }
  return `perm_${decision}_${claudeInstanceId}_${requestToken}`
}

/**
 * Parse the action_id back into its three components. Returns null when the
 * input doesn't match the UUID-bearing action_id shape — callers should treat
 * that as a stale-button no-op rather than crashing.
 *
 * Old action IDs with a numeric request_id suffix do not match and return null,
 * providing silent backward-compat for stale pre-deploy clicks.
 *
 * Never throws for any string input.
 */
export function parsePermissionActionId(actionId: string): ParsedPermissionActionId | null {
  const match = PERMISSION_ACTION_ID_RE.exec(actionId)
  if (match === null) return null
  const decision = match[1] as PermissionDecision
  const claudeInstanceId = match[2]
  const requestToken = match[3]
  return { decision, claudeInstanceId, requestToken }
}
