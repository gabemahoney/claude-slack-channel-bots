/**
 * persona-destination.ts — Where a persona's permission prompts and server
 * notices go, and the post there (b.av2 SR-7.1, SR-5.1).
 *
 * A persona's destination comes from one rule, `personaDestinationOf`
 * (b.av2 SR-7.1, b.deo SRI-701), over the configuration in effect: its
 * `permission_prompts` setting in declarative mode, its fungible destination
 * (`invited.permission_prompts`, `dm` by default) in fungible mode; either way
 * a channel ID, or `dm`. The resolver reads the configuration in effect
 * through its injected `getPersonaConfig` at each attempt (b.deo SRI-201),
 * which every resolver is given. The destination hold and the permission poller ask the resolver
 * (`destinationOf`, `refusalOf`, `settingOf`), so all of them read the one
 * switch. In fungible mode prompts and notices go to the fungible
 * destination on the persona's own client (b.deo SRI-702), and after a
 * confirmed switch change the next attempt goes to the destination of the
 * mode turned on (b.deo SRI-703). A channel destination is that channel. A
 * `dm` destination is the persona's DM conversation with its `dm.contact`,
 * explicit or by default in fungible mode, obtained with
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
 * has `dm.enabled` on and `dm.contact` set (SR-1.5, b.deo SRI-104). Should
 * either be missing anyway, nothing is opened or posted: the refusal is logged
 * and returned. Its line names the destination setting in force
 * (`destinationSettingOf`, b.deo SRI-906): `permission_prompts` in
 * declarative mode, `invited.permission_prompts` in fungible mode. It does
 * not go through the MCP tool-scope check (`checkPersonaTarget`).
 *
 * Every line elsewhere that names a destination setting (the destination
 * hold's `persona-destination-failed` lines, the permission poller's
 * refusal) takes it from the resolver (`settingOf`, read through
 * `destinationSettingFrom`) in the same step as the destination it names, so
 * it names the setting that destination came from (b.deo SRI-906).
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
import { DM_DESTINATION, channelModeOf, type Persona, type ServerSettings } from './config.ts'
import type { PersonaFungibleDestination } from './delivery-decision.ts'
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

/** The setting that names a persona's destination in declarative mode (b.av2 SR-1.2 as amended by b.deo SRI-102, SRI-202). */
export const DECLARATIVE_DESTINATION_SETTING = 'permission_prompts'

/** The setting that names a persona's destination in fungible mode (b.deo SRI-102, SRI-702). */
export const FUNGIBLE_DESTINATION_SETTING = 'invited.permission_prompts'

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

/**
 * The setting that names a persona's destination in the mode in force
 * (`destinationSettingOf`, b.deo SRI-906).
 */
export type DestinationSetting = typeof DECLARATIVE_DESTINATION_SETTING | typeof FUNGIBLE_DESTINATION_SETTING

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

/**
 * The part of a configuration the one destination rule reads: its
 * `allow_invited_channels` switch (`channelModeOf`). Null or undefined when
 * there is no configuration (before the server's start resolves): declarative
 * mode.
 */
export type DestinationConfig = Pick<ServerSettings, 'allow_invited_channels'> | null | undefined

/** Dependencies injected into `createPersonaDestinations`. */
export interface PersonaDestinationsDeps {
  /** Writes one log line. */
  log(line: string): void
  /**
   * The configuration in effect, read at each attempt (b.deo SRI-201), never
   * a copy taken earlier: the destination rule takes the switch from it.
   * Production passes the server's applied configuration.
   */
  getPersonaConfig(): DestinationConfig
}

/**
 * Where a consumer that builds a destination resolver of its own when none is
 * given gets one: the given resolver, or the configuration in effect that its
 * own resolver reads (b.deo SRI-201). A consumer never builds a resolver
 * without the configuration in effect.
 */
export type PersonaDestinationsSource =
  | { destinations: PersonaDestinations; getPersonaConfig?: () => DestinationConfig }
  | { destinations?: undefined; getPersonaConfig: () => DestinationConfig }

/** A destination resolver instance, holding the per-persona DM cache. */
export interface PersonaDestinations {
  /**
   * Post one message to the persona's destination with `client`: the
   * configured channel, or the DM with `dm.contact` (opened on `client` unless
   * cached). The destination is resolved, by the one destination rule over
   * the configuration in effect, synchronously at the call. For a channel
   * destination the post is issued synchronously (before the first `await`).
   * Never rejects.
   */
  post(persona: Persona, client: DestinationSlackClient, message: DestinationMessage): Promise<DestinationPostResult>
  /**
   * The persona's destination now (`personaDestinationOf` over the
   * configuration in effect at this call): what a `post` called at the same
   * moment posts to.
   */
  destinationOf(persona: PersonaDestinationFields): string
  /**
   * Why the persona's `dm` destination would be refused now
   * (`dmDestinationRefusal` over the configuration in effect at this call),
   * or undefined.
   */
  refusalOf(persona: PersonaDestinationFields & Pick<Persona, 'dm'>): DmDestinationRefusal | undefined
  /**
   * The setting that names the persona's destination now
   * (`destinationSettingOf` over the configuration in effect at this call,
   * b.deo SRI-906): the one a line naming the destination `destinationOf`
   * gives at the same moment names. Read through `destinationSettingFrom`.
   */
  settingOf(persona: PersonaDestinationFields): DestinationSetting
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
 * destination, `dm` or a channel ID, by the channel mode of `config`, the
 * configuration in effect when the caller acts (b.deo SRI-201,
 * `channelModeOf`). Fungible mode: its fungible destination
 * (`invited.permission_prompts`, `dm` when that is absent). Declarative mode:
 * its `permission_prompts` (`dm` when that is absent, which no loaded
 * declarative configuration resolves).
 *
 * Every caller passes the configuration in effect and the persona it read
 * from it at that attempt, never a copy taken at start or held in a closure
 * or a queued item, so a confirmed change of the switch or of either
 * destination setting applies from the next attempt. A `dm` destination is
 * refused by `dmDestinationRefusal` unless DMs are on with a contact.
 *
 * The one place a destination consumer reads `permission_prompts` or
 * `fungible_destination` (b.deo SRI-202): the resolver below, its DM
 * refusal, the destination hold, the permission poller and the notifier all
 * go through it. Pure.
 */
export function personaDestinationOf(config: DestinationConfig, persona: PersonaDestinationFields): string {
  if (channelModeOf(config) === 'fungible') return persona.fungible_destination ?? DM_DESTINATION
  return persona.permission_prompts ?? DM_DESTINATION
}

/**
 * The setting that names a persona's destination under `config`, the
 * configuration in effect when the caller acts (b.deo SRI-906, SRI-201):
 * `permission_prompts` in declarative mode, `invited.permission_prompts` in
 * fungible mode. It reads the same switch the one destination rule reads
 * (`channelModeOf`), so a line naming it names the setting that
 * `personaDestinationOf` over the same `config` took the destination from.
 * Pure.
 */
export function destinationSettingOf(config: DestinationConfig): DestinationSetting {
  return channelModeOf(config) === 'fungible' ? FUNGIBLE_DESTINATION_SETTING : DECLARATIVE_DESTINATION_SETTING
}

/**
 * The setting in force for `persona`, asked of a resolver
 * (`PersonaDestinations.settingOf`, b.deo SRI-906). Every line outside this
 * module that names a destination setting reads it here.
 */
export function destinationSettingFrom(
  destinations: Pick<PersonaDestinations, 'settingOf'>,
  persona: PersonaDestinationFields,
): DestinationSetting {
  return destinations.settingOf(persona)
}

/**
 * The loop guard's input (b.deo SRI-305, SRI-504): each of `personas` (the
 * applied personas of the configuration in effect) with its destination by
 * the one destination rule over `config`, in their order. The one builder of
 * that input: the routing passes it to the delivery decision at each
 * fungible-mode event, and `set_channel_delivery` passes it to
 * `channelDeliveryFor` for its result and line, so both read the same
 * destinations. Pure.
 */
export function fungibleDestinationsOf(
  config: DestinationConfig,
  personas: readonly (PersonaDestinationFields & Pick<Persona, 'key'>)[],
): PersonaFungibleDestination[] {
  return personas.map((p) => ({ key: p.key, destination: personaDestinationOf(config, p) }))
}

/**
 * Resolve a persona's destination through the one destination rule
 * (`personaDestinationOf`) over `config`: `dm` for the DM destination, else
 * the channel it names. Pure.
 */
function resolvePersonaDestination(config: DestinationConfig, persona: PersonaDestinationFields): PersonaDestination {
  const destination = personaDestinationOf(config, persona)
  if (destination === DM_DESTINATION) return { kind: 'dm' }
  return { kind: 'channel', channelId: destination }
}

/**
 * Why the persona's `dm` destination must not be opened (DMs off, or no
 * contact), or undefined when it may be, or when the destination is a
 * channel. The destination comes from the one destination rule over `config`,
 * the configuration in effect (`personaDestinationOf`, b.deo SRI-701). Pure.
 */
export function dmDestinationRefusal(
  config: DestinationConfig,
  persona: PersonaDestinationFields & Pick<Persona, 'dm'>,
): DmDestinationRefusal | undefined {
  if (personaDestinationOf(config, persona) !== DM_DESTINATION) return undefined
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

  function destinationOf(persona: PersonaDestinationFields): string {
    return personaDestinationOf(deps.getPersonaConfig(), persona)
  }

  function refusalOf(persona: PersonaDestinationFields & Pick<Persona, 'dm'>): DmDestinationRefusal | undefined {
    return dmDestinationRefusal(deps.getPersonaConfig(), persona)
  }

  function settingOf(persona: PersonaDestinationFields): DestinationSetting {
    return destinationSettingOf(deps.getPersonaConfig())
  }

  /**
   * The persona's cache entry for its DM with its current contact, opening it
   * on `client` unless cached; or the logged refusal, naming the destination
   * setting in force under `config` (b.deo SRI-906). Never throws.
   */
  function dmEntry(
    config: DestinationConfig,
    persona: Persona,
    client: DestinationSlackClient,
  ): DmCacheEntry | DestinationRefused {
    const refusal = dmDestinationRefusal(config, persona)
    if (refusal) {
      deps.log(
        `[slack] persona-destination: ${renderPersonaRef(persona.name, persona.key)} has ` +
          `${destinationSettingOf(config)} set to "${DM_DESTINATION}" but ${describeDmDestinationRefusal(refusal)} — ` +
          'no DM opened and nothing posted',
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
    // One read of the configuration in effect for the whole attempt.
    const config = deps.getPersonaConfig()
    const destination = resolvePersonaDestination(config, persona)
    let channelId: string
    // The cache entry the post used, so a stale-conversation failure drops
    // that entry only, never a newer one.
    let used: DmCacheEntry | undefined
    if (destination.kind === 'channel') {
      channelId = destination.channelId
    } else {
      const entry = dmEntry(config, persona, client)
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

  return { post, destinationOf, refusalOf, settingOf, forget }
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
