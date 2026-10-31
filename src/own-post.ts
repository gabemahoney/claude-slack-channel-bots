/**
 * own-post.ts — The bot's own posts: the surfaces that confirm one, the
 * observer that keeps a post's success apart from the bookkeeping after it,
 * own-post channel eligibility, and the reading of upload completions.
 *
 * The observer never throws or rejects, and waits only for the intent append.
 * Its owner's faults,
 * synchronous or asynchronous, go to the caller's fault callback, whose own
 * throw is swallowed. Upload completions name a root only through the file's
 * own share in the actual target channel; the earliest share there decides.
 *
 * SPDX-License-Identifier: MIT
 */

import { CHANNEL_ID_RE, channelModeOf, type ChannelMode, type DeliveryMode, type Persona, type ServerSettings } from './config.ts'
import { isThreadTimestamp, personaListsChannel, type StoredChoices } from './delivery-decision.ts'
import type { MembershipReading } from './channel-membership.ts'
import type { SharedChannelLifetime } from './shared-channels.ts'
import { slackPlatformReason } from './persona-connection-errors.ts'
export type { OwnPostContent } from './thread-memory.ts'
import type { OwnPostContent } from './thread-memory.ts'
export { createOwnPostJoins } from './own-post-joins.ts'
export type { OwnPostJoins, OwnPostJoinsDeps, PendingOwnPost, OwnPostEvent, OwnPostOutcome } from './own-post-joins.ts'

/** Surfaces that confirm an own post. `file` is reserved for upload completions. */
export const OWN_POST_SURFACES = ['text', 'prompt', 'warning', 'notice', 'file'] as const
export type OwnPostSurface = typeof OWN_POST_SURFACES[number]
/** The authenticated identity that issued a post, captured before its await. */
export interface OwnPostIssuer { botUserId?: string; botId?: string }

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

/** Captured before the post's await, so a replacement identity or lifetime is never rebound. */
export interface OwnPostIssue {
  key: string
  surface: OwnPostSurface
  operation: string
  incarnation?: string
  /** The persona's reset order, when the channel was known at issue. */
  resetOrder?: number
  /** The channel the post was issued for, when known before the post. */
  channel?: string
  /** That channel's whole lifetime at issue: a leave, rejoin or reset since supersedes the post. */
  lifetime?: SharedChannelLifetime
  issuer: OwnPostIssuer
  /** Epoch milliseconds at issue, before the post's await. */
  issuedAt?: number
}
/** What Slack's success response showed: the actual channel and returned timestamp. */
export interface OwnPostPosted {
  channel: string
  ts?: string
  parent?: string
  /** 1-based part within the operation; one when absent. */
  part?: number
  /** A completed file's ID (`file` surface); `ts` then only when its own share named the root. */
  file?: string
}
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
  /** Replaced by start; inert until all posting surfaces migrate. */
  issue(key: string, surface: OwnPostSurface, channel?: string): OwnPostIssue | undefined
  /** Replaced by end; inert until all posting surfaces migrate. */
  confirm(issue: OwnPostIssue | undefined, posted: OwnPostPosted): void
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
    issue: () => undefined,
    confirm: () => {},
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
  /** The root its own share created, when the completion already carried it. */
  root?: string
}

/** What share metadata proves about one file in one channel. */
export type FileShareEvidence =
  | { kind: 'root'; root: string }
  | { kind: 'unresolved'; reason: 'no-share' | 'ambiguous' | 'malformed' }

const object = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** Every share entry of `file` in `channel`, public and private. Malformed entries are dropped. */
function sharesIn(file: Record<string, unknown>, channel: string): Array<{ ts: string; thread_ts?: string }> | undefined {
  const shares = file['shares']
  if (shares === undefined) return []
  if (!object(shares)) return undefined
  const found: Array<{ ts: string; thread_ts?: string }> = []
  for (const visibility of ['public', 'private']) {
    const byChannel = shares[visibility]
    if (byChannel === undefined) continue
    if (!object(byChannel)) return undefined
    const entries = byChannel[channel]
    if (entries === undefined) continue
    if (!Array.isArray(entries)) return undefined
    for (const entry of entries) {
      if (!object(entry) || !isThreadTimestamp(entry['ts'])) continue
      const thread = entry['thread_ts']
      found.push({ ts: entry['ts'], ...(isThreadTimestamp(thread) ? { thread_ts: thread } : {}) })
    }
  }
  return found
}

/**
 * The root a new (parentless) upload of `file` created in `channel`: the
 * file's earliest share there, when that share is a root-level message. A
 * threaded earliest share, a tie, malformed shares or no share leave it
 * unresolved. Pure.
 */
export function fileShareRoot(file: unknown, channel: string): FileShareEvidence {
  if (!object(file)) return { kind: 'unresolved', reason: 'malformed' }
  const shares = sharesIn(file, channel)
  if (shares === undefined) return { kind: 'unresolved', reason: 'malformed' }
  if (!shares.length) return { kind: 'unresolved', reason: 'no-share' }
  const earliest = shares.reduce((a, b) => (compareTs(b.ts, a.ts) < 0 ? b : a))
  const ties = shares.filter(s => s.ts === earliest.ts)
  if (ties.some(s => s.thread_ts !== undefined && s.thread_ts !== s.ts)) return { kind: 'unresolved', reason: 'ambiguous' }
  return { kind: 'root', root: earliest.ts }
}

/**
 * The confirmed files of one `files.completeUploadExternal` response: each
 * file with a valid ID, and for a parentless upload the root its share in
 * `channel` names, when the response already carries it. A response that is
 * not `ok: true` confirms nothing. Pure.
 */
export function completionFiles(response: unknown, channel: string, parent?: string): CompletedFile[] {
  if (!object(response) || response['ok'] !== true || !Array.isArray(response['files'])) return []
  const files: CompletedFile[] = []
  for (const file of response['files']) {
    if (!object(file) || typeof file['id'] !== 'string' || !SLACK_FILE_ID_RE.test(file['id'])) continue
    const share = parent === undefined ? fileShareRoot(file, channel) : undefined
    files.push({ id: file['id'], ...(share?.kind === 'root' ? { root: share.root } : {}) })
  }
  return files
}

/** Order two valid Slack timestamps numerically. */
export function compareTs(a: string, b: string): number {
  const [as, af] = a.split('.') as [string, string]
  const [bs, bf] = b.split('.') as [string, string]
  if (as.length !== bs.length) return as.length - bs.length
  return as < bs ? -1 : as > bs ? 1 : af < bf ? -1 : af > bf ? 1 : 0
}
