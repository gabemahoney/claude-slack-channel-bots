/**
 * permission-action-id.ts — Anchored action_id parser for permission Block Kit buttons.
 *
 * SR-2.2: action_id format is `perm_<allow|deny>_<claudeInstanceId>_<requestId>`.
 * claudeInstanceId always starts with "cscb_" and may contain underscores (e.g.
 * "cscb_test_channel" in dev/test routes). The trailing `_<digits>` is the anchor
 * that separates requestId from the greedy claudeInstanceId capture, making naive
 * split('_') incorrect and forbidden.
 *
 * SPDX-License-Identifier: MIT
 */

// SR-2.2: anchored regex — cscb_ prefix + greedy match against trailing _\d+$ anchor.
// requestId is captured as a raw digit string — NEVER coerced through Number/parseInt.
// The `cscb_.+` capture is greedy; the `_(\d+)$` tail acts as the right-hand anchor,
// so the last underscore-followed-by-digits is consumed as requestId, and everything
// in between is claudeInstanceId.
const PERM_ACTION_RE = /^perm_(allow|deny)_(cscb_.+)_(\d+)$/

export type ParsePermissionActionIdResult =
  | { ok: true; decision: 'allow' | 'deny'; claudeInstanceId: string; requestId: string }
  | { ok: false; reason: 'not-permission-action' | 'malformed' }

/**
 * Parse a Slack Block Kit action_id for permission buttons.
 *
 * Returns `{ ok: true, decision, claudeInstanceId, requestId }` on a valid match.
 * Returns `{ ok: false, reason: 'not-permission-action' }` for strings not beginning with `perm_`.
 * Returns `{ ok: false, reason: 'malformed' }` for strings that start with `perm_` but don't
 * match the full anchored regex (e.g. wrong format, missing requestId, non-cscb instanceId).
 *
 * requestId is always returned as a STRING — never coerced through Number, parseInt,
 * or parseFloat. This preserves full precision for values > 2^53 (SR-2.2 bigint discipline).
 */
export function parsePermissionActionId(actionId: string): ParsePermissionActionIdResult {
  if (!actionId.startsWith('perm_')) {
    return { ok: false, reason: 'not-permission-action' }
  }

  const m = PERM_ACTION_RE.exec(actionId)
  if (!m) {
    return { ok: false, reason: 'malformed' }
  }

  // m[1]: 'allow' | 'deny'
  // m[2]: claudeInstanceId (e.g. 'cscb_C123' or 'cscb_test_channel')
  // m[3]: requestId as digit string — do NOT coerce through Number
  return {
    ok: true,
    decision: m[1] as 'allow' | 'deny',
    claudeInstanceId: m[2]!,
    requestId: m[3]!,
  }
}
