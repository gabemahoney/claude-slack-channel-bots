/**
 * persona-destination.ts — Where a persona's permission prompts and server
 * notices go, and the post there (b.av2 SR-7.1, SR-5.1).
 *
 * A persona's destination comes from one rule, `personaDestinationOf`
 * (b.av2 SR-7.1, b.deo SRI-701): its `permission_prompts` setting in
 * declarative mode, its fungible destination (`invited.permission_prompts`,
 * `dm` by default) in fungible mode; either way a channel ID, or `dm`. A
 * channel destination is that channel. A `dm` destination
 * is the persona's DM conversation with its `dm.contact`, obtained with
 * `conversations.open` on the persona's own client (Slack returns the existing
 * conversation, or creates one when none exists, so a DM-only persona's first
 * post needs no prior DM and no history or conversation-list lookup). Posts
 * always name the returned `D…` conversation ID, never the contact's user ID:
 * `chat.postMessage` to a user ID would open a DM implicitly.
 *
 * The resolved DM conversation is cached per persona, tied to the contact it
 * was opened for:
 * - a later post for the same persona and contact makes no second open;
 * - concurrent posts share the one in-flight open (the pending promise is the
 *   cache value), so a flush of several held notices makes one open;
 * - a changed contact never reuses the old conversation: the next post opens
 *   again for the current contact;
 * - a failed open is never cached, so the next attempt opens again;
 * - a post to the cached conversation failing with `channel_not_found` drops
 *   the entry it used (not a newer one opened meanwhile), so the next attempt
 *   opens again;
 * - `forget(key)` drops the persona's entry (a reload, teardown).
 * The cache holds one entry per persona key: no entry, lock or timer spans two
 * personas (b.av2 SR-3.3), so one persona's failed open never affects
 * another's destination.
 *
 * Defensive refusal (b.av2 SR-5.1): the loader guarantees a `dm` destination
 * has `dm.enabled` on and `dm.contact` set (SR-1.5). Should either be missing
 * anyway, nothing is opened or posted: the refusal is logged and returned. It
 * does not go through the MCP tool-scope check (`checkPersonaTarget`).
 *
 * A failed open or post is returned, never thrown, with the step that failed
 * and the Slack error code (`classifySlackError`), so a caller can log it,
 * trail it, or hold and retry it. The thrown value is returned for the
 * caller's token-safe description only (`describeDestinationFailure`,
 * `describeDestinationFailureCause`); it is never logged here.
 *
 * Dry run (b.av2 SR-3.4) never reaches this module: the notifier's dry-run
 * branch returns first and the permission poller does not run.
 *
 * Pure module (b.av2 SR-13.1): no module-scope state, no I/O of its own, no
 * timers and nothing runs at import. The cache lives in the instance the
 * factory returns; the Slack client and the logger are injected.
 *
 * SPDX-License-Identifier: MIT
 */

import type { WebClient } from '@slack/web-api'
import { DM_DESTINATION, type Persona } from './config.ts'
import { renderPersonaRef } from './persona-identity.ts'
import { describeSlackCallFailure, describeThrownValue, isSafeIdentifier } from './persona-connection-errors.ts'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** The bot scope `conversations.open` needs to open a DM with a user. */
export const DM_OPEN_SCOPE = 'im:write'

/** Slack's platform error for a call the app's scopes do not cover. */
export const MISSING_SCOPE_ERROR = 'missing_scope'

/** Slack's platform error for a conversation that does not exist (or the app cannot see). */
const CHANNEL_NOT_FOUND_ERROR = 'channel_not_found'

/** Failure code of a `conversations.open` that succeeded but returned no conversation ID. */
export const NO_CONVERSATION_ID_CODE = 'no_conversation_id'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** The Slack surface a destination post uses on a persona's client. */
export type DestinationSlackClient = Pick<WebClient, 'chat' | 'conversations'>

/**
 * Where a persona's permission prompts and server notices go (b.av2 SR-7.1):
 * a channel, with its ID, or `dm`.
 */
type PersonaDestination =
  | { kind: 'channel'; channelId: string }
  | { kind: 'dm' }

/** Why a `dm` destination is refused without a Slack call. */
export type DmDestinationRefusal = 'dm_disabled' | 'no_dm_contact'

/** The Slack call that failed. */
export type DestinationStep = 'conversations.open' | 'chat.postMessage'

/** A failed open or post. */
export interface DestinationFailure {
  outcome: 'failed'
  step: DestinationStep
  /**
   * The Slack platform error (e.g. `missing_scope`, `not_in_channel`,
   * `channel_not_found`), else `network_error`, `aborted` or `unknown_error`
   * (`classifySlackError`); `no_conversation_id` for an open that returned no
   * conversation ID.
   */
  code: string
  /** The conversation posted to; absent when the open failed. */
  channelId?: string
  /**
   * The thrown value, for a token-safe description only (never log it
   * directly); absent for `no_conversation_id`.
   */
  error?: unknown
}

/** A `dm` destination refused without a Slack call (logged by this module). */
export interface DestinationRefused {
  outcome: 'refused'
  reason: DmDestinationRefusal
}

/** The outcome of a `conversations.open`: the DM conversation, or the failure. */
type DmOpenResult = { outcome: 'opened'; channelId: string } | DestinationFailure

/** The outcome of one post to a persona's destination. */
export type DestinationPostResult =
  | { outcome: 'posted'; channelId: string; ts: string | undefined }
  | DestinationRefused
  | DestinationFailure

/** The message to post: a top-level message, with no username or icon override. */
export interface DestinationMessage {
  text: string
  blocks?: unknown[]
}

/** Dependencies injected into `createPersonaDestinations`. */
export interface PersonaDestinationsDeps {
  /** Writes one log line. */
  log(line: string): void
}

/** A destination resolver instance, holding the per-persona DM cache. */
export interface PersonaDestinations {
  /**
   * Post one message to the persona's destination with `client`: the
   * configured channel, or the DM with `dm.contact` (opened on `client` unless
   * cached). For a channel destination the post is issued synchronously
   * (before the first `await`). Never rejects.
   */
  post(persona: Persona, client: DestinationSlackClient, message: DestinationMessage): Promise<DestinationPostResult>
  /** Drop the persona's cached DM conversation (and any in-flight open's claim to the cache). */
  forget(personaKey: string): void
}

/** One persona's cached DM: the contact it was opened for and the (possibly pending) open. */
interface DmCacheEntry {
  contact: string
  pending: Promise<DmOpenResult>
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/** The resolved fields the one destination rule reads. */
export type PersonaDestinationFields = Pick<Persona, 'permission_prompts' | 'fungible_destination'>

/**
 * The one destination rule (b.av2 SR-7.1, b.deo SRI-701): a persona's
 * destination, `dm` or a channel ID, by the channel mode of the
 * configuration the persona was resolved in. Fungible mode: its fungible
 * destination (`invited.permission_prompts`, `dm` when that is absent).
 * Declarative mode: its `permission_prompts`.
 *
 * The persona's resolved fields carry that mode: the loader fills
 * `fungible_destination` in fungible mode only, and `permission_prompts` in
 * declarative mode only (b.deo SRI-102). Every caller passes the persona it
 * read from the configuration in effect at that attempt, never a copy held
 * from earlier, so a confirmed change of the switch or of either destination
 * setting applies from the next attempt. A persona with neither field (no
 * loaded configuration resolves one) gets `dm`, which `dmDestinationRefusal`
 * refuses unless DMs are on with a contact.
 *
 * The one place a destination consumer reads `permission_prompts` or
 * `fungible_destination` (b.deo SRI-202): the resolver below, its DM
 * refusal, the destination hold, the permission poller and the notifier all
 * go through it. Pure.
 */
export function personaDestinationOf(persona: PersonaDestinationFields): string {
  if (persona.fungible_destination !== undefined) return persona.fungible_destination
  return persona.permission_prompts ?? DM_DESTINATION
}

/**
 * Resolve a persona's destination through the one destination rule
 * (`personaDestinationOf`): `dm` for the DM destination, else the channel it
 * names. Pure.
 */
function resolvePersonaDestination(persona: PersonaDestinationFields): PersonaDestination {
  const destination = personaDestinationOf(persona)
  if (destination === DM_DESTINATION) return { kind: 'dm' }
  return { kind: 'channel', channelId: destination }
}

/**
 * Why the persona's `dm` destination must not be opened (DMs off, or no
 * contact), or undefined when it may be, or when the destination is a
 * channel. The destination comes from the one destination rule
 * (`personaDestinationOf`, b.deo SRI-701). Pure.
 */
export function dmDestinationRefusal(
  persona: PersonaDestinationFields & Pick<Persona, 'dm'>,
): DmDestinationRefusal | undefined {
  if (personaDestinationOf(persona) !== DM_DESTINATION) return undefined
  if (!persona.dm.enabled) return 'dm_disabled'
  if (!persona.dm.contact) return 'no_dm_contact'
  return undefined
}

/** The setting a refusal names, for log lines: `dm.enabled is not true` or `dm.contact is not set`. */
export function describeDmDestinationRefusal(reason: DmDestinationRefusal): string {
  return reason === 'dm_disabled' ? 'dm.enabled is not true' : 'dm.contact is not set'
}

/**
 * Map an unknown Slack error to a stable error-class string (SR-V-2.4, the
 * trail's `error` field). Slack platform errors expose `data.error` (e.g.
 * `channel_not_found`); other errors collapse to short class labels.
 */
export function classifySlackError(err: unknown): string {
  if (err !== null && typeof err === 'object') {
    const data = (err as { data?: unknown }).data
    if (data !== null && typeof data === 'object') {
      const e = (data as { error?: unknown }).error
      if (typeof e === 'string' && e.length > 0) return e
    }
  }
  if (err instanceof Error) {
    if (err.name === 'AbortError') return 'aborted'
    return 'network_error'
  }
  return 'unknown_error'
}

/**
 * The token-safe tail of a failed-destination log line: for a thrown value,
 * `describeSlackCallFailure` (` (reason=<reason>): <description>`); for an
 * open that returned no conversation ID, ` (reason=no_conversation_id)`.
 */
export function describeDestinationFailure(failure: DestinationFailure): string {
  return failure.error !== undefined ? describeSlackCallFailure(failure.error) : ` (reason=${failure.code})`
}

/**
 * A token-safe cause for a failed destination post, for a record naming what
 * failed. A failed post is `describeThrownValue` of the rejection. A failed
 * open is `conversations.open code=<code>` (`unknown_error` when the code is
 * not a short identifier), then `: <describeThrownValue>` when the open threw
 * (not for `no_conversation_id`).
 */
export function describeDestinationFailureCause(failure: DestinationFailure): string {
  if (failure.step === 'chat.postMessage') return describeThrownValue(failure.error)
  const head = `conversations.open code=${safeFailureCode(failure.code)}`
  return 'error' in failure ? `${head}: ${describeThrownValue(failure.error)}` : head
}

/**
 * A failure's code when it is a short identifier (`isSafeIdentifier`), else
 * `unknown_error`: the form a log line or a trail event may carry. Pure.
 */
export function safeFailureCode(code: string): string {
  return isSafeIdentifier(code) ? code : 'unknown_error'
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/** Build a destination resolver with an empty per-persona DM cache. */
export function createPersonaDestinations(deps: PersonaDestinationsDeps): PersonaDestinations {
  const dmCache = new Map<string, DmCacheEntry>()

  /**
   * The persona's cache entry for its DM with its current contact, opening it
   * on `client` unless cached; or the logged refusal. Never throws.
   */
  function dmEntry(persona: Persona, client: DestinationSlackClient): DmCacheEntry | DestinationRefused {
    const refusal = dmDestinationRefusal(persona)
    if (refusal) {
      deps.log(
        `[slack] persona-destination: ${renderPersonaRef(persona.name, persona.key)} has permission_prompts set to ` +
          `"${DM_DESTINATION}" but ${describeDmDestinationRefusal(refusal)} — no DM opened and nothing posted`,
      )
      return { outcome: 'refused', reason: refusal }
    }
    const contact = persona.dm.contact!
    const cached = dmCache.get(persona.key)
    if (cached && cached.contact === contact) return cached
    const entry: DmCacheEntry = { contact, pending: openDm(client, contact) }
    dmCache.set(persona.key, entry)
    // A failed open is never cached; a forget or a newer open meanwhile keeps its own entry.
    void entry.pending.then((result) => {
      if (result.outcome !== 'opened' && dmCache.get(persona.key) === entry) dmCache.delete(persona.key)
    })
    return entry
  }

  // The channel path makes no `await` before `chat.postMessage`, so callers
  // that issue several posts in a row keep their order.
  async function post(
    persona: Persona,
    client: DestinationSlackClient,
    message: DestinationMessage,
  ): Promise<DestinationPostResult> {
    const destination = resolvePersonaDestination(persona)
    let channelId: string
    // The cache entry the post used, so a stale-conversation failure drops
    // that entry only, never a newer one.
    let used: DmCacheEntry | undefined
    if (destination.kind === 'channel') {
      channelId = destination.channelId
    } else {
      const entry = dmEntry(persona, client)
      if ('outcome' in entry) return entry
      used = entry
      const opened = await entry.pending
      if (opened.outcome !== 'opened') return opened
      channelId = opened.channelId
    }
    const args: { channel: string; text: string; blocks?: never } = { channel: channelId, text: message.text }
    if (message.blocks !== undefined) args.blocks = message.blocks as never
    try {
      const response = await client.chat.postMessage(args)
      return { outcome: 'posted', channelId, ts: (response as { ts?: string }).ts }
    } catch (err) {
      const code = classifySlackError(err)
      if (used && code === CHANNEL_NOT_FOUND_ERROR && dmCache.get(persona.key) === used) dmCache.delete(persona.key)
      return { outcome: 'failed', step: 'chat.postMessage', code, channelId, error: err }
    }
  }

  function forget(personaKey: string): void {
    dmCache.delete(personaKey)
  }

  return { post, forget }
}

/** `conversations.open` with one user on the persona's client. Never rejects. */
async function openDm(client: DestinationSlackClient, contact: string): Promise<DmOpenResult> {
  try {
    const response = await client.conversations.open({ users: contact })
    const id = response.channel?.id
    if (typeof id === 'string' && id !== '') return { outcome: 'opened', channelId: id }
    return { outcome: 'failed', step: 'conversations.open', code: NO_CONVERSATION_ID_CODE }
  } catch (err) {
    return { outcome: 'failed', step: 'conversations.open', code: classifySlackError(err), error: err }
  }
}
