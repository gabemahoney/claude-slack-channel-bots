/**
 * participation-channel-evidence.ts — Outbound channel evidence and
 * root-lookup capability for enrollment.
 *
 * Channel evidence: an own post in open mode enrolls only when its channel's
 * type and external sharing are known. When verified membership lacks them,
 * an authenticated `conversations.info` for the exact channel supplies them:
 * a public or private channel with an explicit boolean `is_ext_shared`.
 * `false` lets the existing eligibility checks decide, `true` excludes, and
 * anything else (another ID, a DM or group DM, a missing or non-boolean flag,
 * a pending external share) stays unresolved. Posting success, a configured
 * destination, a listed entry, an ID prefix, a name or file visibility
 * proves neither membership nor sharing; membership stays its own authority.
 *
 * Capability: root lookup (`conversations.replies`) needs the history scope
 * of every configured surface: `channels:history` (public) and
 * `groups:history` (private) always, and `im:history` when the persona's DMs
 * are enabled. No group-DM surface is configured, so `mpim:history` is never
 * required. The scopes are checked when the persona comes up, from the scopes
 * Slack reported for its token, with no probe; the method's own usability is
 * verified by the first real bounded lookup. A missing scope or a refused
 * method leaves the persona up: only selections that depend on a root lookup
 * stay unresolved, and the gap is reported once per episode. Every root
 * lookup is in a channel, so a gap of only `im:history` holds none of them.
 *
 * SPDX-License-Identifier: MIT
 */

import { CHANNEL_ID_RE, type Persona } from './config.ts'
import type { EnrollmentMetadataMethod, MetadataAttempts, MetadataFailure } from './thread-memory.ts'

/** One authenticated metadata request on the persona's current connection (`PersonaConnectionManager.metadataCall`, bound). */
export type MetadataCaller = (method: EnrollmentMetadataMethod, args: Record<string, unknown>, signal: AbortSignal) => Promise<unknown>

export const PUBLIC_HISTORY_SCOPE = 'channels:history'
export const PRIVATE_HISTORY_SCOPE = 'groups:history'
export const DM_HISTORY_SCOPE = 'im:history'

/** The history scopes root lookup needs for the persona's configured surfaces, in a fixed order. */
export function requiredHistoryScopes(persona: Pick<Persona, 'dm'> | undefined): string[] {
  return [PUBLIC_HISTORY_SCOPE, PRIVATE_HISTORY_SCOPE, ...(persona?.dm.enabled ? [DM_HISTORY_SCOPE] : [])]
}

/** The required history scopes `granted` lacks; `undefined` when the granted scopes are unknown. Pure. */
export function missingHistoryScopes(granted: readonly string[] | undefined, persona: Pick<Persona, 'dm'> | undefined): string[] | undefined {
  if (granted === undefined) return undefined
  const have = new Set(granted)
  return requiredHistoryScopes(persona).filter(scope => !have.has(scope))
}

/** Why a persona cannot look up thread roots. */
export type RootLookupCapabilityGap =
  | { kind: 'missing-scope'; scopes: string[] }
  | { kind: 'method-refused'; method: 'conversations.replies'; slackError: string }

/** Whether `gap` holds root lookups: a refused method, or a missing channel history scope. No root lookup runs in a DM. Pure. */
export function capabilityGapHoldsLookups(gap: RootLookupCapabilityGap | undefined): boolean {
  return !!gap && (gap.kind === 'method-refused' || gap.scopes.some(scope => scope !== DM_HISTORY_SCOPE))
}

/** What one `conversations.info` response proves about the exact channel. */
export type ChannelSharingEvidence =
  | { kind: 'evidence'; channel: string; channelType: 'public' | 'private'; externallyShared: boolean }
  | { kind: 'unresolved'; reason: 'malformed' | 'mismatch' | 'unsupported-type' | 'conflicting' }

const object = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** Parse an authenticated `conversations.info` result for exactly `channel`. Pure. */
export function parseConversationInfo(result: unknown, channel: string): ChannelSharingEvidence {
  if (!object(result) || result['ok'] !== true || !object(result['channel']) || !CHANNEL_ID_RE.test(channel)) return { kind: 'unresolved', reason: 'malformed' }
  const info = result['channel']
  if (info['id'] !== channel) return { kind: 'unresolved', reason: 'mismatch' }
  if (info['is_im'] === true || info['is_mpim'] === true) return { kind: 'unresolved', reason: 'unsupported-type' }
  const shared = info['is_ext_shared']
  if (typeof shared !== 'boolean') return { kind: 'unresolved', reason: 'malformed' }
  if (info['is_pending_ext_shared'] === true && !shared) return { kind: 'unresolved', reason: 'conflicting' }
  const priv = info['is_private']
  if (typeof priv !== 'boolean') return { kind: 'unresolved', reason: 'malformed' }
  if (!priv && info['is_channel'] !== true) return { kind: 'unresolved', reason: 'unsupported-type' }
  if (priv && info['is_group'] !== true && info['is_channel'] !== true) return { kind: 'unresolved', reason: 'unsupported-type' }
  return { kind: 'evidence', channel, channelType: priv ? 'private' : 'public', externallyShared: shared }
}

/**
 * Resolve one channel's type and sharing with one bounded, revocable
 * `conversations.info` attempt owned by persona `key`. `current` is the
 * caller's binding guard (same connection, identity, lifetime and pending
 * observation), re-checked after the await: a result after it turns false is
 * `cancelled` and must change nothing. A failure is returned classified,
 * never as evidence.
 */
export async function resolveChannelEvidence(attempts: MetadataAttempts, key: string, channel: string, current: () => boolean,
  call: MetadataCaller): Promise<ChannelSharingEvidence | MetadataFailure> {
  if (!CHANNEL_ID_RE.test(channel)) return { kind: 'unresolved', reason: 'malformed' }
  const result = await attempts.run(key, current, signal => call('conversations.info', { channel }, signal), 'conversations.info')
  return result.kind === 'ok' ? parseConversationInfo(result.value, channel) : result
}
