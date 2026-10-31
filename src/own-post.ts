/**
 * own-post.ts — The bot's own posts: per-call operations on each surface, the
 * observer that keeps a post's success apart from the bookkeeping after it,
 * own-post channel eligibility, and the confirmation of upload completions.
 *
 * The observer never throws or rejects, and waits only for the intent append.
 * Its owner's faults,
 * synchronous or asynchronous, go to the caller's fault callback, whose own
 * throw is swallowed. An upload completion confirms its files by ID only; it
 * names no thread.
 *
 * SPDX-License-Identifier: MIT
 */

import { CHANNEL_ID_RE, channelModeOf, type ChannelMode, type DeliveryMode, type Persona, type ServerSettings } from './config.ts'
import { isThreadTimestamp, personaListsChannel, type StoredChoices } from './delivery-decision.ts'
import type { MembershipReading } from './channel-membership.ts'
import { slackPlatformReason } from './persona-connection-errors.ts'
export type { OwnPostContent } from './thread-memory.ts'
import type { OwnPostContent } from './thread-memory.ts'
export { createOwnPostJoins, ownPostStampState } from './own-post-joins.ts'
export type { OwnPostJoins, OwnPostJoinsDeps, PendingOwnPost, OwnPostEvent, OwnPostOutcome,
  OwnPostLookupHolds, OwnPostLookupOutcome, OwnPostLookupResult } from './own-post-joins.ts'

/** Surfaces that start an own-post operation. `file` is reserved for uploads. */
export const OWN_POST_SURFACES = ['text', 'prompt', 'warning', 'notice', 'file'] as const
export type OwnPostSurface = typeof OWN_POST_SURFACES[number]

// ---------------------------------------------------------------------------
// Own-post eligibility
// ---------------------------------------------------------------------------

/** Whether a confirmed own post may enroll, from current applied evidence. */
export type OwnPostEligibility =
  | { kind: 'eligible'; mode: ChannelMode; delivery: DeliveryMode }
  | { kind: 'ineligible'; mode: ChannelMode; reason: 'dm' | 'unlisted' | 'absent' | 'external-sharing' | 'invalid-channel' | 'not-thread-hybrid' }
  | { kind: 'unresolved'; mode: ChannelMode; delivery?: DeliveryMode; reason: string }
export interface OwnPostEligibilityInputs {
  channel: string
  mode: ChannelMode
  /** The persona's configured channel entries name this channel; read in strict mode only. */
  listed: boolean
  /** The shared choice projection is trustworthy for this persona/channel. */
  choiceReadable: boolean
  choice: DeliveryMode | undefined
  membership: MembershipReading | undefined
}
/**
 * Only a readable thread_hybrid choice and verified membership permit a join.
 * Posting success, a destination, a listed entry or an ID prefix alone proves
 * neither membership nor sharing.
 * Pure.
 */
export function decideOwnPostEligibility(inputs: OwnPostEligibilityInputs): OwnPostEligibility {
  const { channel, mode, choice, membership } = inputs
  if (!CHANNEL_ID_RE.test(channel)) return { kind: 'ineligible', mode, reason: channel.startsWith('D') ? 'dm' : 'invalid-channel' }
  if (!inputs.choiceReadable) return { kind: 'unresolved', mode, reason: 'state-unavailable' }
  if (choice !== 'thread_hybrid') return { kind: 'ineligible', mode, reason: choice === undefined && !inputs.listed ? 'unlisted' : 'not-thread-hybrid' }
  if (!membership) return { kind: 'unresolved', mode, delivery: choice, reason: 'current-membership-missing' }
  if (membership.kind === 'ineligible') return { kind: 'ineligible', mode, reason: membership.reason }
  if (membership.kind === 'unresolved') return { kind: 'unresolved', mode, delivery: choice, reason: membership.reason }
  return { kind: 'eligible', mode, delivery: choice }
}

/** The current facts `ownPostEligibility` reads at each confirmation. */
export interface OwnPostEligibilitySources {
  config(): Pick<ServerSettings, 'channel_mode'> | null | undefined
  persona(key: string): Pick<Persona, 'channels'> | undefined
  choices(): Pick<StoredChoices, 'storedChoice'> & { readableFor(key: string, channel?: string): boolean } | undefined
  membership(key: string, channel: string, mode: ChannelMode): MembershipReading | undefined
}
/** The owner's `eligibility` over the applied config, stored choices and current membership. */
export function ownPostChoice(sources: Pick<OwnPostEligibilitySources, 'choices'>): (key: string, channel: string) => OwnPostChoice {
  return (key, channel) => {
    const store = sources.choices()
    return store?.readableFor(key, channel) ? { readable: true, choice: store.storedChoice(key, channel) } : { readable: false }
  }
}
export type OwnPostChoice = { readable: true; choice: DeliveryMode | undefined } | { readable: false }
export function ownPostEligibility(sources: OwnPostEligibilitySources): (key: string, channel: string) => OwnPostEligibility {
  return (key, channel) => {
    const mode = channelModeOf(sources.config()), store = sources.choices()
    const readable = store !== undefined && store.readableFor(key, channel)
    return decideOwnPostEligibility({
      // Open mode reads no persona's channel entries.
      channel, mode, listed: mode === 'strict' && personaListsChannel(sources.persona(key), channel),
      choiceReadable: readable, choice: readable ? store.storedChoice(key, channel) : undefined,
      membership: sources.membership(key, channel, mode),
    })
  }
}

// ---------------------------------------------------------------------------
// Post-success separation
// ---------------------------------------------------------------------------

/** The bookkeeping an observed own post is handed to. */
export interface OwnPostOwner {
  startOperation(key: string, surface: OwnPostSurface, target: OwnPostTarget, content: OwnPostContent): OwnPostStart | undefined
  endOperation(operation: OwnPostOperation, answer: OwnPostAnswer): void
}
export interface OwnPostTarget { channel: string; parent?: string }
export type OwnPostAnswer =
  | { kind: 'confirmed'; channel: string; ts?: string; threadTs?: string; file?: string }
  | { kind: 'failed'; code: string }
  | { kind: 'no-answer' }
declare const operationBrand: unique symbol
export interface OwnPostOperation { readonly [operationBrand]: true }
export interface OwnPostStart { operation: OwnPostOperation; ready?: Promise<void> }

/** Errors that Slack answered are failures; transport uncertainty is not. */
export function ownPostAnswerOfError(error: unknown): OwnPostAnswer {
  const reason = slackPlatformReason(error)
  if (reason) return { kind: 'failed', code: reason }
  try {
    if (object(error) && error['code'] === 'slack_webapi_rate_limited_error') return { kind: 'failed', code: 'ratelimited' }
    if (object(error) && (error['code'] === 'slack_webapi_platform_error' || (object(error['data']) && typeof error['data']['error'] === 'string'))) {
      return { kind: 'failed', code: 'slack_error' }
    }
  } catch { /* malformed external errors supply no evidence */ }
  return { kind: 'no-answer' }
}
/** Read only Slack's returned timestamp and the posted message's thread root. */
export function ownPostAnswerOfPost(channel: string, response: unknown): OwnPostAnswer {
  try {
    if (!object(response)) return { kind: 'no-answer' }
    if (response['ok'] === false) return { kind: 'failed', code: slackPlatformReason({ data: response }) ?? 'slack_error' }
    if (response['ok'] !== true || !isThreadTimestamp(response['ts'])) return { kind: 'no-answer' }
    const message = response['message'], thread = object(message) ? message['thread_ts'] : undefined
    return { kind: 'confirmed', channel, ts: response['ts'], ...(isThreadTimestamp(thread) ? { threadTs: thread } : {}) }
  } catch { return { kind: 'no-answer' } }
}

/** The posting adapters' view: faults cannot change the Slack operation. */
export interface OwnPostObserver {
  start(key: string, surface: OwnPostSurface, target: OwnPostTarget, content: OwnPostContent): OwnPostStart | undefined
  end(operation: OwnPostOperation | undefined, answer: OwnPostAnswer): void
}
/** The shared adapter over the current owner; a fault, sync or async, reaches `onFault`. */
export function createOwnPostObserver(owner: () => OwnPostOwner | undefined,
  onFault?: (error: unknown) => void): OwnPostObserver {
  const owners = new WeakMap<OwnPostOperation, OwnPostOwner>()
  const fault = (error: unknown) => {
    try { onFault?.(error) } catch { /* reporting cannot fail a post */ }
  }
  return {
    start(key, surface, target, content) {
      try {
        const current = owner(), started = current?.startOperation(key, surface, target, content)
        if (!started || !current) return undefined
        owners.set(started.operation, current)
        return { operation: started.operation, ...(started.ready ? { ready: Promise.resolve(started.ready).catch(fault) } : {}) }
      } catch (error) { fault(error); return undefined }
    },
    end(operation, answer) {
      if (!operation) return
      const current = owners.get(operation)
      owners.delete(operation)
      try { void Promise.resolve(current?.endOperation(operation, answer)).catch(fault) } catch (error) { fault(error) }
    },
  }
}

// ---------------------------------------------------------------------------
// Upload completions
// ---------------------------------------------------------------------------

/** A Slack file ID as CSCB records it. */
export const SLACK_FILE_ID_RE = /^F[A-Z0-9]{2,63}$/

/** One completed file of an upload completion response. */
export interface CompletedFile {
  id: string
}

const object = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** A file object with a valid Slack file ID: what an upload confirms and what its share is matched by. */
export function isSlackFile(file: unknown): file is { id: string } {
  return object(file) && typeof file['id'] === 'string' && SLACK_FILE_ID_RE.test(file['id'])
}

/**
 * The confirmed files of one `files.completeUploadExternal` response: each
 * file with a valid ID, in response order. A response that is not `ok: true`
 * with a `files` array confirms nothing. Nothing else in the answer is read:
 * a parent-bound upload's thread is its requested parent's Thread Root, and a
 * new-message upload's thread is learnt from P's own `file_share` message
 * (SR-3.2.3). Pure.
 */
export function completionFiles(response: unknown): CompletedFile[] {
  if (!object(response) || response['ok'] !== true || !Array.isArray(response['files'])) return []
  const files: CompletedFile[] = []
  for (const file of response['files']) if (isSlackFile(file)) files.push({ id: file.id })
  return files
}

/** Order two valid Slack timestamps numerically. */
export function compareTs(a: string, b: string): number {
  const [as, af] = a.split('.') as [string, string]
  const [bs, bf] = b.split('.') as [string, string]
  if (as.length !== bs.length) return as.length - bs.length
  return as < bs ? -1 : as > bs ? 1 : af < bf ? -1 : af > bf ? 1 : 0
}
