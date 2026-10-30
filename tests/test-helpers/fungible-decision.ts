/**
 * test-helpers/fungible-decision.ts — The decision-table rows of the contract
 * read by `tests/delivery-decision-fungible.test.ts`.
 *
 * Each row holds one call of `decideDelivery`: the event (from the Slack
 * stub's event factories), the configuration (from the persona-config
 * helpers) with the receiving persona P, the envelope flag as received, the
 * shared choices, current membership and affected readability, and the full expected outcome,
 * written in the row. `decisionArgsOf(row)` turns a row into the decision's
 * four arguments the way `src/persona-routing.ts` builds them, and
 * `channelDeliveryArgsOf(row)` into `channelDeliveryFor`'s for P and the
 * row's channel. `FUNGIBLE_DECISION_GROUPS` retains the predecessor groups
 * and adds the current-authority rows to the same purity/reverse-order checks.
 *
 * A row may also put in front of the decision what the loader never
 * produces, so the row shows that an input not in force plays no part:
 * a listing or a malformed declarative section in the
 * decision's views in open mode. Both modes use the shared choices and
 * explicit membership input; missing evidence is exercised as unresolved.
 *
 * Pure data: no file, directory, timer or module mock. The configurations'
 * paths sit under a base directory that is never created, and every ID is a
 * fixed stub ID, never a token-like value.
 *
 * SPDX-License-Identifier: MIT
 */

import { CHANNEL_ID_RE, channelModeOf, type ChannelEntry, type DeliveryMode, type Persona, type PersonaConfig } from '../../src/config.ts'
import type {
  AppliedPersonaView,
  ChannelDeliveryInputs,
  ChannelDeliveryResult,
  DeliveryDecision,
  DeliveryPersona,
  FungibleChannelType,
  FungibleDecisionInputs,
  FungiblePath,
  FungibleRefusal,
  StoredChoices,
  Via,
  channelDeliveryFor,
  decideDelivery,
} from '../../src/delivery-decision.ts'
import { makeMultiPersonaConfig, type PersonaSpec } from './persona-config.ts'
import type { ThreadMemoryView } from '../../src/thread-memory.ts'
import type { MembershipReading } from '../../src/channel-membership.ts'
import {
  broadcastText,
  ENVELOPE_FLAG_FORMS,
  envelopeFlagOf,
  makeAppMention,
  makeBotMessage,
  makeChannelMessage,
  makeDm,
  makeGroupDmMessage,
  makePrivateChannelMessage,
  mentionText,
  userGroupMentionText,
  type SlackEvent,
} from './slack-stub.ts'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Base directory of the configurations' paths. Nothing is created under it, and no row reads a path. */
const UNWRITTEN_BASE_DIR = '/nonexistent/fungible-decision'

/** The personas: P receives every row's event; Q and R are the other applied personas. Each name is its own key. */
export const P_KEY = 'persona_p'
export const Q_KEY = 'persona_q'
export const R_KEY = 'persona_r'

/** Each persona's bot user ID and bot ID, as the connection manager's identity lookup gives them. */
const BOT_IDENTITIES: Readonly<Record<string, { readonly botUserId: string; readonly botId: string }>> = {
  [P_KEY]: { botUserId: 'U0PERSONAP', botId: 'B0PERSONAP' },
  [Q_KEY]: { botUserId: 'U0PERSONAQ', botId: 'B0PERSONAQ' },
  [R_KEY]: { botUserId: 'U0PERSONAR', botId: 'B0PERSONAR' },
}
const P_USER = BOT_IDENTITIES[P_KEY]!.botUserId
const P_BOT = BOT_IDENTITIES[P_KEY]!.botId
const Q_USER = BOT_IDENTITIES[Q_KEY]!.botUserId
const Q_BOT = BOT_IDENTITIES[Q_KEY]!.botId

/** A public channel (`C…`), a private channel (`G…`), a group-DM conversation (`G…`) and a DM (`D…`). */
export const PUBLIC_CHANNEL = 'C0PUBLIC01'
export const PRIVATE_CHANNEL = 'G0PRIVATE1'
export const GROUP_DM = 'G0GROUPDM1'
export const DM_CHANNEL = 'D0DIRECT01'

/** A channel ID that fails `CHANNEL_ID_RE` and does not start with `D`, so it is never taken for a DM. */
export const MALFORMED_CHANNEL = 'C0-NOT-AN-ID'

/** P's and Q's fungible destinations (`invited.permission_prompts`) in the fungible casts. */
export const P_DESTINATION = 'C0PDEST001'
export const Q_DESTINATION = 'C0QDEST001'

/** Channels P lists in the declarative casts: one `all` entry and one `mentions` entry. */
const LISTED_ALL = 'C0LISTALL1'
const LISTED_MENTIONS = 'C0LISTMEN1'

/** The forms of the `allow_invited_channels` switch. */
export const SWITCH_FORMS = ['absent', 'false', 'true'] as const
export type SwitchForm = (typeof SWITCH_FORMS)[number]

/** The envelope flag's forms: `true`, `false`, absent, or any other value. */
export const FLAG_FORMS = ['true', 'false', 'absent', 'non-boolean'] as const
export type FlagForm = (typeof FLAG_FORMS)[number]

/** The `channel_type` values completeness case spans; `absent` is an event with none. */
export const CHANNEL_TYPE_FORMS = ['channel', 'group', 'im', 'mpim', 'absent'] as const
export type ChannelTypeForm = (typeof CHANNEL_TYPE_FORMS)[number]

/**
 * The envelope flag as the routing hands it to the decision, per form: the
 * slack-stub's forms, plus `null` as a second non-boolean.
 */
const FLAG = {
  true: envelopeFlagOf(ENVELOPE_FLAG_FORMS.true),
  false: envelopeFlagOf(ENVELOPE_FLAG_FORMS.false),
  absent: envelopeFlagOf(ENVELOPE_FLAG_FORMS.absent),
  falseString: envelopeFlagOf(ENVELOPE_FLAG_FORMS['non-boolean']),
  null: null,
} as const

/** One flag of each form, in `FLAG_FORMS` order. */
const ONE_FLAG_PER_FORM: readonly unknown[] = [FLAG.true, FLAG.false, FLAG.absent, FLAG.falseString]

/** Read through a section a row marks fail-if-read: the decision must never read it. */
export const FAIL_IF_READ: unique symbol = Symbol('fail-if-read')

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

/** Stored choices as a plain lookup: persona key → channel → choice. */
export type StoredLookup = Readonly<Record<string, Readonly<Record<string, DeliveryMode>>>>

export type ThreadRead = readonly [key: string, channel: string, root: string]

/** One row of the decision table. */
export interface FungibleDecisionRow {
  /** The scenario, for the test title. */
  readonly label: string
  /** The event, from a slack-stub factory. */
  readonly event: SlackEvent
  /** The applied configuration, from the persona-config helpers; its switch picks the mode. */
  readonly config: PersonaConfig
  /** The receiving persona's key; P unless set. */
  readonly receiver?: string
  /** The envelope flag as received: `true`, `false`, undefined when absent, or any other value. */
  readonly flag: unknown
  /** The stored choices; absent: no store reaches the decision. */
  readonly stored?: StoredLookup
  /** Whether the store was readable at start; true unless set. */
  readonly readable?: boolean
  /** Independent current observations. Empty explicitly means no evidence. */
  readonly memberships?: ReadonlyMap<string, MembershipReading>
  readonly readableFor?: StoredChoices['readableFor']
  /**
   * Declarative sections the decision's views carry instead of the
   * configuration's, by persona key: any value (a malformed one included), or
   * `FAIL_IF_READ` for a section that throws when read.
   */
  readonly viewChannels?: Readonly<Record<string, unknown>>
  /** Call the decision with three arguments: no fungible-mode inputs at all. */
  readonly omitFungibleInputs?: true
  /** Fixed read-only answers, keyed by persona, channel and thread root. */
  readonly threadViews?: Readonly<Record<string, Readonly<Record<string, Readonly<Record<string, ThreadMemoryView>>>>>>
  readonly omitThreadMemory?: true
  readonly threadStampUndecided?: FungibleDecisionInputs['threadStampUndecided']
  /** Every expected lookup, in order. Omitted means no lookup. */
  readonly threadReads?: readonly ThreadRead[]
  readonly channelDelivery?: ChannelDeliveryResult
  /** The whole outcome, as written. */
  readonly expected: DeliveryDecision
}

/** A row of a channel-delivery group (4, 7 and 9), with `channelDeliveryFor`'s expected result for P and the row's channel. */
export interface ChannelDeliveryRow extends FungibleDecisionRow {
  readonly channelDelivery: ChannelDeliveryResult
}

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------

/** The persona `key` of `config`; throws when the configuration has none. */
function personaOf(config: PersonaConfig, key: string): Persona {
  const persona = config.personas.find((p) => p.key === key)
  if (persona === undefined) throw new Error(`fungible-decision: no persona ${key} in the row's configuration`)
  return persona
}

/** An object whose `channels` throws when read. */
function withFailingChannels<T extends object>(base: T, key: string): T & { readonly channels: readonly ChannelEntry[] } {
  return Object.defineProperty({ ...base }, 'channels', {
    enumerable: true,
    get(): never {
      throw new Error(`fungible-decision: the declarative section of ${key} was read`)
    },
  }) as T & { readonly channels: readonly ChannelEntry[] }
}

/** Whether the row replaces `key`'s declarative section in the decision's views. */
function replacesSection(row: FungibleDecisionRow, key: string): boolean {
  return row.viewChannels !== undefined && key in row.viewChannels
}

/** `base` with the row's replacement section for `key`: a getter that throws for `FAIL_IF_READ`, else the value as given. */
function withReplacedSection<T extends object>(row: FungibleDecisionRow, base: T, key: string): T & { readonly channels: readonly ChannelEntry[] } {
  const section = row.viewChannels?.[key]
  if (section === FAIL_IF_READ) return withFailingChannels(base, key)
  return { ...base, channels: section as readonly ChannelEntry[] }
}

/** The applied view of `persona`: the persona itself, as the routing passes it, unless the row replaces its section. */
function appliedViewOf(row: FungibleDecisionRow, persona: Persona): AppliedPersonaView {
  return replacesSection(row, persona.key) ? withReplacedSection(row, { key: persona.key }, persona.key) : persona
}

/** P as the routing maps it: its key, its bot identity, its section (or the row's replacement) and its DMs switch. */
function receivingPersonaOf(row: FungibleDecisionRow): DeliveryPersona {
  const persona = personaOf(row.config, row.receiver ?? P_KEY)
  const identity = BOT_IDENTITIES[persona.key]
  const base = { key: persona.key, botUserId: identity?.botUserId, botId: identity?.botId, dmEnabled: persona.dm.enabled }
  return replacesSection(row, persona.key) ? withReplacedSection(row, base, persona.key) : { ...base, channels: persona.channels }
}

/** The row's stored choices as the decision reads them: a read-only lookup with the row's readability, no store and no file. */
function storedChoicesOf(row: FungibleDecisionRow): StoredChoices | undefined {
  const stored = row.stored
  if (stored === undefined) return undefined
  return { readable: row.readable ?? true, readableFor: row.readableFor, storedChoice: (key, channel) => stored[key]?.[channel] }
}

/** Explicit positive input for pure decision cases; never derived from a list
 * or saved preference. Runtime composition uses the real membership owner. */
export function eligibleMembership(key: string): MembershipReading {
  return { kind: 'eligible', lifetime: { incarnation: `decision-${key}`, boundary: 1, leaveBoundary: 0 }, identity: `identity-${key}`, generation: `generation-${key}` }
}

/** `channelDeliveryFor`'s inputs besides the persona and the channel. */
function channelDeliveryInputsOf(row: FungibleDecisionRow): ChannelDeliveryInputs {
  const storedChoices = storedChoicesOf(row)
  return { storedChoices }
}

/**
 * `decideDelivery`'s arguments for `row`: the event; P; the applied views
 * (each persona as the routing passes it, or the row's replacement); and,
 * unless the row omits it, the fungible-mode inputs, with the mode from the
 * configuration's switch through `channelModeOf`, the flag as received,
 * `CHANNEL_ID_RE` itself, the row's stored choices and fixed Thread Memory view.
 */
export function decisionArgsOf(row: FungibleDecisionRow, reads: ThreadRead[] = []): Parameters<typeof decideDelivery> {
  const persona = receivingPersonaOf(row)
  const applied = row.config.personas.map((p) => appliedViewOf(row, p))
  if (row.omitFungibleInputs) return [row.event, persona, applied]
  const inputs: FungibleDecisionInputs = {
    mode: channelModeOf(row.config),
    isExtSharedChannel: row.flag,
    channelIdPattern: CHANNEL_ID_RE,
    memberships: row.memberships ?? new Map([P_KEY, Q_KEY, R_KEY].map(key => [key, eligibleMembership(key)])),
    threadMemory: row.omitThreadMemory ? undefined : (key, channel, root) => {
      reads.push([key, channel, root])
      return row.threadViews?.[key]?.[channel]?.[root] ?? 'not-joined'
    },
    threadStampUndecided: row.threadStampUndecided,
    ...channelDeliveryInputsOf(row),
  }
  return [row.event, persona, applied, inputs]
}

/** `channelDeliveryFor`'s arguments for P (or the row's receiver) and the row's channel. */
export function channelDeliveryArgsOf(row: FungibleDecisionRow): Parameters<typeof channelDeliveryFor> {
  return [row.receiver ?? P_KEY, String(row.event['channel']), channelDeliveryInputsOf(row)]
}

/** The switch form of `config`: absent when the key is unset, else its value. */
export function switchFormOf(config: PersonaConfig): SwitchForm {
  const value: unknown = config.channel_mode
  if (value === undefined) return 'absent'
  return value === 'open' ? 'true' : 'false'
}

/** The flag form of a flag as received: `null`, a string or any other non-boolean is `non-boolean`, never `absent`. */
export function flagFormOf(flag: unknown): FlagForm {
  if (flag === undefined) return 'absent'
  if (typeof flag !== 'boolean') return 'non-boolean'
  return flag ? 'true' : 'false'
}

/** The `channel_type` form of an event, or undefined for a value outside five. */
export function channelTypeFormOf(event: SlackEvent): ChannelTypeForm | undefined {
  const value = event['channel_type']
  if (value === undefined) return 'absent'
  return (CHANNEL_TYPE_FORMS as readonly unknown[]).includes(value) ? (value as ChannelTypeForm) : undefined
}

// ---------------------------------------------------------------------------
// Configurations
// ---------------------------------------------------------------------------

/**
 * P, Q and R, each named by its key with its spec over the helper's
 * defaults, under `switchForm`: `absent` leaves `allow_invited_channels`
 * unset, as a file without the key gives it; `false` and `true` set it.
 */
function cast(switchForm: SwitchForm, p: PersonaSpec = {}, q: PersonaSpec = {}, r: PersonaSpec = {}): PersonaConfig {
  const overrides = { channel_mode: switchForm === 'absent' ? undefined : switchForm === 'true' ? 'open' as const : 'strict' as const }
  return makeMultiPersonaConfig(
    [
      { name: P_KEY, ...p },
      { name: Q_KEY, ...q },
      { name: R_KEY, ...r },
    ],
    UNWRITTEN_BASE_DIR,
    overrides,
  )
}

/**
 * Declarative mode, with every fungible input the loader would not produce:
 * P lists one `all` and one `mentions` channel, DMs on, and carries an
 * `invited` section; Q lists the private channel `all`, and its `invited`
 * section and `fungible_destination` name P's listed `all` channel; R keeps
 * its default listing.
 */
function declarativeCast(switchForm: 'absent' | 'false'): PersonaConfig {
  return cast(
    switchForm,
    {
      channels: [{ id: LISTED_ALL, delivery: 'all' }, { id: LISTED_MENTIONS, delivery: 'mentions' }],
      dm: { enabled: true },
      permission_prompts: P_DESTINATION,
    },
    {
      channels: [{ id: PRIVATE_CHANNEL, delivery: 'all' }],
      permission_prompts: LISTED_ALL,
    },
  )
}

const DECLARATIVE_CASTS = { absent: declarativeCast('absent'), false: declarativeCast('false') } as const

/** Declarative mode (switch `false`), P listing the public channel `all` and the private channel `mentions`. */
const LISTED_CAST = cast('false', {
  channels: [{ id: PUBLIC_CHANNEL, delivery: 'all' }, { id: PRIVATE_CHANNEL, delivery: 'mentions' }],
})

/** Fungible mode: P's destination `P_DESTINATION` with DMs `pDm`, Q's `Q_DESTINATION`, R's `dm` (no `invited`). */
function fungibleCast(pDm = true, p: PersonaSpec = {}, q: PersonaSpec = {}, r: PersonaSpec = {}): PersonaConfig {
  return cast(
    'true',
    { permission_prompts: P_DESTINATION, dm: { enabled: pDm }, ...p },
    { permission_prompts: Q_DESTINATION, ...q },
    r,
  )
}

const FUNGIBLE_CAST = fungibleCast()
const FUNGIBLE_CAST_DM_OFF = fungibleCast(false)

// ---------------------------------------------------------------------------
// Outcomes
// ---------------------------------------------------------------------------

/** The fungible path's report: channel type and P's channel delivery. */
function onPath(channelType: FungibleChannelType, channelDelivery: DeliveryMode): FungiblePath {
  return { channelType, channelDelivery }
}

function deliver(via: Via, fungible?: FungiblePath): DeliveryDecision {
  return fungible === undefined ? { action: 'deliver', via } : { action: 'deliver', via, fungible }
}

function drop(reason: 'non-message' | 'no-author' | 'own' | 'dm-disabled' | 'group-dm' | 'not-mentioned' | 'channel-off', fungible?: FungiblePath): DeliveryDecision {
  return fungible === undefined ? { action: 'drop', reason } : { action: 'drop', reason, fungible }
}

function unresolved(reason: 'state-unavailable' | 'membership-unresolved' | 'choice-missing'): DeliveryDecision {
  return { action: 'unresolved', reason }
}

function refused(refusal: FungibleRefusal): DeliveryDecision {
  return { action: 'drop', reason: 'fungible-refused', refusal }
}

/** `channelDeliveryFor`'s result. */
function delivery(value: DeliveryMode | undefined): ChannelDeliveryResult {
  return { delivery: value }
}

/** A short form of a flag value for labels. */
function flagLabel(flag: unknown): string {
  return flag === undefined ? 'flag absent' : `flag ${JSON.stringify(flag)}`
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

const P_MENTION = `${mentionText(P_USER)} over to you`

/** A public channel message in `channel` with `text`. */
function publicMessage(channel: string, text = 'plain words'): SlackEvent {
  return makeChannelMessage({ channel, text })
}

/** A private channel message in `channel` with `text`. */
function privateMessage(channel: string, text = 'plain words'): SlackEvent {
  return makePrivateChannelMessage({ channel, text })
}

/** A message in the channel of `channelType`: the public or private factory. */
function messageIn(channelType: 'public' | 'private', text = 'plain words', channel?: string): SlackEvent {
  return channelType === 'public' ? publicMessage(channel ?? PUBLIC_CHANNEL, text) : privateMessage(channel ?? PRIVATE_CHANNEL, text)
}

const CHANNEL_KINDS = ['public', 'private'] as const

// ---------------------------------------------------------------------------
// Group 1: declarative mode is unchanged by every fungible input
// (declarative half optional inputs)
// ---------------------------------------------------------------------------

/** P's stored choice for the unlisted public and private channel, per flag form (none, `mentions`, `all`). */
const STORED_BY_FLAG: Readonly<Record<FlagForm, readonly [DeliveryMode | undefined, DeliveryMode | undefined]>> = {
  true: ['all', undefined],
  false: ['all', 'mentions'],
  absent: ['mentions', 'all'],
  'non-boolean': [undefined, 'all'],
}

function storedFor(choices: Readonly<Record<string, DeliveryMode | undefined>>): StoredLookup {
  const entries = Object.entries(choices).filter((e): e is [string, DeliveryMode] => e[1] !== undefined)
  return { [P_KEY]: Object.fromEntries(entries), [Q_KEY]: { [PUBLIC_CHANNEL]: 'all', [PRIVATE_CHANNEL]: 'all' } }
}

const declarativeRows: FungibleDecisionRow[] = (['absent', 'false'] as const).flatMap((switchForm) => {
  const config = DECLARATIVE_CASTS[switchForm]
  const perFlag = ONE_FLAG_PER_FORM.flatMap((flag): FungibleDecisionRow[] => {
    const [publicChoice, privateChoice] = STORED_BY_FLAG[flagFormOf(flag)]
    const stored = storedFor({ [PUBLIC_CHANNEL]: publicChoice, [PRIVATE_CHANNEL]: privateChoice })
    const at = `switch ${switchForm}, ${flagLabel(flag)}`
    return [
      {
        label: `${at}: unlisted public channel, P's stored choice ${publicChoice ?? 'none'}`,
        event: publicMessage(PUBLIC_CHANNEL),
        config, flag, stored,
        expected: publicChoice === undefined ? unresolved('choice-missing') : publicChoice === 'all' ? deliver('receive_all_shared') : drop('not-mentioned'),
      },
      {
        label: `${at}: private channel only Q lists, P's stored choice ${privateChoice ?? 'none'}`,
        event: privateMessage(PRIVATE_CHANNEL),
        config, flag, stored,
        expected: privateChoice === undefined ? unresolved('choice-missing') : privateChoice === 'all' ? deliver('receive_all_shared') : drop('not-mentioned'),
      },
      {
        label: `${at}: DM (im) with DMs on`,
        event: makeDm({ channel: DM_CHANNEL }),
        config, flag, stored,
        expected: deliver('dm'),
      },
      {
        label: `${at}: group DM (mpim) mentioning P`,
        event: makeGroupDmMessage({ channel: GROUP_DM, text: P_MENTION }),
        config, flag, stored,
        expected: drop('group-dm'),
      },
      {
        label: `${at}: app_mention (no channel_type) of P in an unlisted public channel`,
        event: makeAppMention({ channel: PUBLIC_CHANNEL, text: P_MENTION }),
        config, flag, stored,
        expected: publicChoice === undefined ? unresolved('choice-missing') : deliver('mention'),
      },
    ]
  })
  const listed: FungibleDecisionRow[] = [
    {
      label: `switch ${switchForm}, flag false: P's listed all channel, Q's fungible destination, P's stored choice mentions`,
      event: publicMessage(LISTED_ALL),
      config, flag: FLAG.false,
      stored: { [P_KEY]: { [LISTED_ALL]: 'mentions' } },
      expected: drop('not-mentioned'),
    },
    {
      label: `switch ${switchForm}, flag false: P's listed mentions channel, plain message, P's and Q's stored choice all`,
      event: publicMessage(LISTED_MENTIONS),
      config, flag: FLAG.false,
      stored: { [P_KEY]: { [LISTED_MENTIONS]: 'all' }, [Q_KEY]: { [LISTED_MENTIONS]: 'all' } },
      expected: deliver('receive_all_shared'),
    },
  ]
  return [...perFlag, ...listed]
})

declarativeRows.push(
  {
    label: 'no fungible-mode inputs: P\'s listed all channel',
    event: publicMessage(LISTED_ALL),
    config: DECLARATIVE_CASTS.absent, flag: undefined, omitFungibleInputs: true,
    expected: unresolved('state-unavailable'),
  },
  {
    label: 'no fungible-mode inputs: unlisted public channel',
    event: publicMessage(PUBLIC_CHANNEL),
    config: DECLARATIVE_CASTS.absent, flag: undefined, omitFungibleInputs: true,
    expected: unresolved('state-unavailable'),
  },
)

// ---------------------------------------------------------------------------
// Group 2: fungible mode, no stored choice, flag false
// ---------------------------------------------------------------------------

const noStoredChoiceRows: FungibleDecisionRow[] = CHANNEL_KINDS.flatMap((kind): FungibleDecisionRow[] => {
  const path = onPath(kind, 'off')
  const at = `${kind} channel, no stored choice`
  const row = (label: string, event: SlackEvent, expected: DeliveryDecision): FungibleDecisionRow => ({
    label: `${at}: ${label}`, event, config: FUNGIBLE_CAST, flag: FLAG.false, stored: {}, expected,
  })
  return [
    row('P\'s direct mention', messageIn(kind, P_MENTION), unresolved('choice-missing')),
    row('<!here>', messageIn(kind, `${broadcastText('here')} standup`), unresolved('choice-missing')),
    row('<!channel>', messageIn(kind, `${broadcastText('channel')} standup`), unresolved('choice-missing')),
    row('plain message', messageIn(kind), unresolved('choice-missing')),
    row('<!everyone>', messageIn(kind, `${broadcastText('everyone')} standup`), unresolved('choice-missing')),
    row('user-group mention', messageIn(kind, `${userGroupMentionText()} standup`), unresolved('choice-missing')),
    row(
      'Q\'s bot post mentioning P',
      makeBotMessage({
        channel: kind === 'public' ? PUBLIC_CHANNEL : PRIVATE_CHANNEL,
        channel_type: kind === 'public' ? 'channel' : 'group',
        user: Q_USER,
        bot_id: Q_BOT,
        text: P_MENTION,
      }),
      unresolved('choice-missing'),
    ),
  ]
})

// ---------------------------------------------------------------------------
// Group 3: fungible mode, P's stored all (via half)
// ---------------------------------------------------------------------------

const storedAllRows: FungibleDecisionRow[] = [
  {
    label: 'public channel, P\'s stored all: plain message',
    event: publicMessage(PUBLIC_CHANNEL),
    config: FUNGIBLE_CAST, flag: FLAG.false,
    stored: { [P_KEY]: { [PUBLIC_CHANNEL]: 'all' } },
    expected: deliver('receive_all', onPath('public', 'all')),
  },
  {
    label: 'private channel, P\'s stored all: plain message',
    event: privateMessage(PRIVATE_CHANNEL),
    config: FUNGIBLE_CAST, flag: FLAG.false,
    stored: { [P_KEY]: { [PRIVATE_CHANNEL]: 'all' } },
    expected: deliver('receive_all', onPath('private', 'all')),
  },
  {
    label: 'public channel, P\'s and Q\'s stored all: plain message',
    event: publicMessage(PUBLIC_CHANNEL),
    config: FUNGIBLE_CAST, flag: FLAG.false,
    stored: { [P_KEY]: { [PUBLIC_CHANNEL]: 'all' }, [Q_KEY]: { [PUBLIC_CHANNEL]: 'all' } },
    expected: deliver('receive_all_shared', onPath('public', 'all')),
  },
  {
    label: 'private channel, P\'s and R\'s stored all, R\'s destination dm: plain message',
    event: privateMessage(PRIVATE_CHANNEL),
    config: FUNGIBLE_CAST, flag: FLAG.false,
    stored: { [P_KEY]: { [PRIVATE_CHANNEL]: 'all' }, [R_KEY]: { [PRIVATE_CHANNEL]: 'all' } },
    expected: deliver('receive_all_shared', onPath('private', 'all')),
  },
  {
    label: 'P\'s own destination, P\'s and Q\'s stored all, Q also hears all: plain message',
    event: publicMessage(P_DESTINATION),
    config: FUNGIBLE_CAST, flag: FLAG.false,
    stored: { [P_KEY]: { [P_DESTINATION]: 'all' }, [Q_KEY]: { [P_DESTINATION]: 'all' } },
    expected: deliver('receive_all_shared', onPath('public', 'all')),
  },
  {
    label: 'public channel, P\'s and Q\'s stored all: P\'s direct mention',
    event: publicMessage(PUBLIC_CHANNEL, P_MENTION),
    config: FUNGIBLE_CAST, flag: FLAG.false,
    stored: { [P_KEY]: { [PUBLIC_CHANNEL]: 'all' }, [Q_KEY]: { [PUBLIC_CHANNEL]: 'all' } },
    expected: deliver('mention', onPath('public', 'all')),
  },
  {
    label: 'private channel, P\'s and Q\'s stored all: <!channel>',
    event: privateMessage(PRIVATE_CHANNEL, `${broadcastText('channel')} standup`),
    config: FUNGIBLE_CAST, flag: FLAG.false,
    stored: { [P_KEY]: { [PRIVATE_CHANNEL]: 'all' }, [Q_KEY]: { [PRIVATE_CHANNEL]: 'all' } },
    expected: deliver('broadcast', onPath('private', 'all')),
  },
]

// ---------------------------------------------------------------------------
// Group 4: fungible mode ignores channels (decision rows)
// ---------------------------------------------------------------------------

// Each row's outcome is the one groups 2 and 3 give for the same event and
// stored choices with the sections empty, as the loader leaves them.

const ignoresChannelsRows: ChannelDeliveryRow[] = [
  {
    label: 'P lists the public channel all, no stored choice: plain message',
    event: publicMessage(PUBLIC_CHANNEL),
    config: fungibleCast(true, { channels: [{ id: PUBLIC_CHANNEL, delivery: 'all' }] }),
    flag: FLAG.false, stored: {},
    expected: unresolved('choice-missing'),
    channelDelivery: delivery(undefined),
  },
  {
    label: 'P lists the private channel mentions, P\'s stored all: plain message',
    event: privateMessage(PRIVATE_CHANNEL),
    config: fungibleCast(true, { channels: [{ id: PRIVATE_CHANNEL, delivery: 'mentions' }] }),
    flag: FLAG.false,
    stored: { [P_KEY]: { [PRIVATE_CHANNEL]: 'all' } },
    expected: deliver('receive_all', onPath('private', 'all')),
    channelDelivery: delivery('all'),
  },
  {
    label: 'Q lists the public channel all with no stored choice, P\'s stored all: plain message',
    event: publicMessage(PUBLIC_CHANNEL),
    config: fungibleCast(true, {}, { channels: [{ id: PUBLIC_CHANNEL, delivery: 'all' }] }),
    flag: FLAG.false,
    stored: { [P_KEY]: { [PUBLIC_CHANNEL]: 'all' } },
    expected: deliver('receive_all', onPath('public', 'all')),
    channelDelivery: delivery('all'),
  },
  {
    label: 'P\'s section entries missing their fields, Q\'s section absent, P\'s stored all: plain message',
    event: publicMessage(PUBLIC_CHANNEL),
    config: fungibleCast(true, { channels: [{}, { id: PUBLIC_CHANNEL }] as unknown as ChannelEntry[] }),
    flag: FLAG.false,
    stored: { [P_KEY]: { [PUBLIC_CHANNEL]: 'all' } },
    expected: deliver('receive_all', onPath('public', 'all')),
    channelDelivery: delivery('all'),
  },
  {
    label: 'P\'s section a string, Q\'s an object, no stored choice: plain message',
    event: publicMessage(PUBLIC_CHANNEL),
    config: FUNGIBLE_CAST, flag: FLAG.false, stored: {},
    viewChannels: { [P_KEY]: PUBLIC_CHANNEL, [Q_KEY]: { id: PUBLIC_CHANNEL, delivery: 'all' } },
    expected: unresolved('choice-missing'),
    channelDelivery: delivery(undefined),
  },
  {
    label: 'P\'s and R\'s sections undefined, P\'s stored all: plain message',
    event: privateMessage(PRIVATE_CHANNEL),
    config: FUNGIBLE_CAST, flag: FLAG.false,
    stored: { [P_KEY]: { [PRIVATE_CHANNEL]: 'all' } },
    viewChannels: { [P_KEY]: undefined, [R_KEY]: undefined },
    expected: deliver('receive_all', onPath('private', 'all')),
    channelDelivery: delivery('all'),
  },
  {
    label: 'every section fails if read, P\'s and Q\'s stored all: plain message',
    event: publicMessage(PUBLIC_CHANNEL),
    config: FUNGIBLE_CAST, flag: FLAG.false,
    stored: { [P_KEY]: { [PUBLIC_CHANNEL]: 'all' }, [Q_KEY]: { [PUBLIC_CHANNEL]: 'all' } },
    viewChannels: { [P_KEY]: FAIL_IF_READ, [Q_KEY]: FAIL_IF_READ, [R_KEY]: FAIL_IF_READ },
    expected: deliver('receive_all_shared', onPath('public', 'all')),
    channelDelivery: delivery('all'),
  },
  {
    label: 'every section fails if read, no stored choice: P\'s direct mention in a private channel',
    event: privateMessage(PRIVATE_CHANNEL, P_MENTION),
    config: FUNGIBLE_CAST, flag: FLAG.false, stored: {},
    viewChannels: { [P_KEY]: FAIL_IF_READ, [Q_KEY]: FAIL_IF_READ, [R_KEY]: FAIL_IF_READ },
    expected: unresolved('choice-missing'),
    channelDelivery: delivery(undefined),
  },
]

// ---------------------------------------------------------------------------
// Group 5: the five conditions of the contract, and the same events listed in
// declarative mode
// ---------------------------------------------------------------------------

/** Each refused event mentions P, so its drop comes from the condition, never from a missing mention. */
const REFUSED_EVENTS = {
  noChannelType: makeAppMention({ channel: PUBLIC_CHANNEL, text: P_MENTION }),
  unknownChannelType: makeChannelMessage({ channel: PRIVATE_CHANNEL, channel_type: 'app_home', text: P_MENTION }),
  noChannelTypeMalformed: makeAppMention({ channel: MALFORMED_CHANNEL, text: P_MENTION }),
  publicMalformed: publicMessage(MALFORMED_CHANNEL, P_MENTION),
  privateMalformed: privateMessage(MALFORMED_CHANNEL, P_MENTION),
  public: publicMessage(PUBLIC_CHANNEL, P_MENTION),
  private: privateMessage(PRIVATE_CHANNEL, P_MENTION),
} as const

const conditionRows: FungibleDecisionRow[] = [
  // Condition 1: channel_type is channel or group.
  {
    label: 'condition 1 alone: no channel_type on a valid public ID, flag false',
    event: REFUSED_EVENTS.noChannelType, config: FUNGIBLE_CAST, flag: FLAG.false,
    expected: refused('not-a-channel'),
  },
  {
    label: 'condition 1 alone: channel_type app_home on a valid private ID, flag false',
    event: REFUSED_EVENTS.unknownChannelType, config: FUNGIBLE_CAST, flag: FLAG.false,
    expected: refused('not-a-channel'),
  },
  {
    label: 'condition 1 with every later one failing: no channel_type, malformed ID, flag absent',
    event: REFUSED_EVENTS.noChannelTypeMalformed, config: FUNGIBLE_CAST, flag: FLAG.absent,
    expected: refused('not-a-channel'),
  },
  // Condition 2: the ID matches CHANNEL_ID_RE.
  ...CHANNEL_KINDS.flatMap((kind): FungibleDecisionRow[] => [
    {
      label: `condition 2 alone: ${kind} channel, malformed ID, flag false`,
      event: kind === 'public' ? REFUSED_EVENTS.publicMalformed : REFUSED_EVENTS.privateMalformed,
      config: FUNGIBLE_CAST, flag: FLAG.false,
      expected: refused('channel-id-malformed'),
    },
    {
      label: `condition 2 with every later one failing: ${kind} channel, malformed ID, flag absent`,
      event: kind === 'public' ? REFUSED_EVENTS.publicMalformed : REFUSED_EVENTS.privateMalformed,
      config: FUNGIBLE_CAST, flag: FLAG.absent,
      expected: refused('channel-id-malformed'),
    },
  ]),
  // Conditions 3 to 5: the flag present, a boolean, false. An absent or
  // non-boolean flag fails every later flag condition too.
  ...CHANNEL_KINDS.flatMap((kind): FungibleDecisionRow[] => {
    const event = REFUSED_EVENTS[kind]
    return [
      { label: `condition 3: ${kind} channel, flag absent`, event, config: FUNGIBLE_CAST, flag: FLAG.absent, expected: refused('flag-missing') },
      { label: `condition 4: ${kind} channel, flag null`, event, config: FUNGIBLE_CAST, flag: FLAG.null, expected: refused('flag-not-boolean') },
      { label: `condition 4: ${kind} channel, flag "false"`, event, config: FUNGIBLE_CAST, flag: FLAG.falseString, expected: refused('flag-not-boolean') },
      { label: `condition 5: ${kind} channel, flag true`, event, config: FUNGIBLE_CAST, flag: FLAG.true, expected: refused('externally-shared') },
    ]
  }),
  // The same events in declarative mode, the channel listed for P: delivered
  // by the entry. Condition 2 has none: the loader rejects a malformed ID in
  // channels.
  {
    label: 'declarative, listed: condition 1\'s event (no channel_type), flag false',
    event: REFUSED_EVENTS.noChannelType, config: LISTED_CAST, flag: FLAG.false, stored: { [P_KEY]: { [PUBLIC_CHANNEL]: 'all' } },
    expected: deliver('mention'),
  },
  ...CHANNEL_KINDS.flatMap((kind): FungibleDecisionRow[] => {
    const event = REFUSED_EVENTS[kind]
    return [
      { label: `declarative, listed: condition 3's ${kind} event, flag absent`, event, config: LISTED_CAST, stored: { [P_KEY]: { [PUBLIC_CHANNEL]: 'all', [PRIVATE_CHANNEL]: 'mentions' } }, flag: FLAG.absent, expected: deliver('mention') },
      {
        label: `declarative, listed: condition 4's ${kind} event, flag ${kind === 'public' ? 'null' : '"false"'}`,
        event, config: LISTED_CAST, stored: { [P_KEY]: { [PUBLIC_CHANNEL]: 'all', [PRIVATE_CHANNEL]: 'mentions' } }, flag: kind === 'public' ? FLAG.null : FLAG.falseString,
        expected: deliver('mention'),
      },
      { label: `declarative, listed: condition 5's ${kind} event, flag true`, event, config: LISTED_CAST, stored: { [P_KEY]: { [PUBLIC_CHANNEL]: 'all', [PRIVATE_CHANNEL]: 'mentions' } }, flag: FLAG.true, expected: deliver('mention') },
    ]
  }),
]

// ---------------------------------------------------------------------------
// Group 6: group DMs in fungible mode
// ---------------------------------------------------------------------------

const groupDmRows: FungibleDecisionRow[] = ONE_FLAG_PER_FORM.flatMap((flag): FungibleDecisionRow[] => [
  {
    label: `mpim message mentioning P, ${flagLabel(flag)}`,
    event: makeGroupDmMessage({ channel: GROUP_DM, text: P_MENTION }),
    config: FUNGIBLE_CAST, flag,
    stored: { [P_KEY]: { [GROUP_DM]: 'all' } },
    expected: drop('group-dm'),
  },
  {
    label: `group-DM app_mention of P (no channel_type, G… ID), ${flagLabel(flag)}`,
    event: makeAppMention({ channel: GROUP_DM, text: P_MENTION }),
    config: FUNGIBLE_CAST, flag,
    stored: { [P_KEY]: { [GROUP_DM]: 'all' } },
    expected: refused('not-a-channel'),
  },
])

// ---------------------------------------------------------------------------
// Group 8: in fungible mode the first steps run first (non-message, own, no-author)
// ---------------------------------------------------------------------------

const firstStepRows: FungibleDecisionRow[] = CHANNEL_KINDS.flatMap((kind): FungibleDecisionRow[] => {
  const channel = kind === 'public' ? PUBLIC_CHANNEL : PRIVATE_CHANNEL
  const channelType = kind === 'public' ? 'channel' : 'group'
  const message = (overrides: Readonly<Record<string, unknown>>): SlackEvent =>
    kind === 'public' ? makeChannelMessage({ channel, ...overrides }) : makePrivateChannelMessage({ channel, ...overrides })
  const at = `${kind} channel`
  return [
    { label: `${at}: channel_join, flag true`, event: message({ subtype: 'channel_join' }), config: FUNGIBLE_CAST, flag: FLAG.true, expected: drop('non-message') },
    { label: `${at}: message_changed, flag absent`, event: message({ subtype: 'message_changed', text: P_MENTION }), config: FUNGIBLE_CAST, flag: FLAG.absent, expected: drop('non-message') },
    { label: `${at}: message_deleted, flag false`, event: message({ subtype: 'message_deleted' }), config: FUNGIBLE_CAST, flag: FLAG.false, expected: drop('non-message') },
    { label: `${at}: P's own post by bot user ID, flag true`, event: message({ user: P_USER, text: P_MENTION }), config: FUNGIBLE_CAST, flag: FLAG.true, expected: drop('own') },
    {
      label: `${at}: P's own post by bot ID, flag "false"`,
      event: makeBotMessage({ channel, channel_type: channelType, bot_id: P_BOT, text: P_MENTION }),
      config: FUNGIBLE_CAST, flag: FLAG.falseString,
      stored: { [P_KEY]: { [channel]: 'all' } },
      expected: drop('own'),
    },
    { label: `${at}: no author, flag true`, event: message({ user: undefined, text: P_MENTION }), config: FUNGIBLE_CAST, flag: FLAG.true, expected: drop('no-author') },
  ]
})

// ---------------------------------------------------------------------------
// Group 9: an unreadable store
// ---------------------------------------------------------------------------

const unreadableStoreRows: ChannelDeliveryRow[] = [
  {
    label: 'store unreadable, its lookup holding P\'s all: plain message in a public channel',
    event: publicMessage(PUBLIC_CHANNEL),
    config: FUNGIBLE_CAST, flag: FLAG.false,
    stored: { [P_KEY]: { [PUBLIC_CHANNEL]: 'all' } }, readable: false,
    expected: unresolved('state-unavailable'),
    channelDelivery: delivery(undefined),
  },
  {
    label: 'store unreadable, its lookup holding P\'s and Q\'s all: P\'s direct mention in a private channel',
    event: privateMessage(PRIVATE_CHANNEL, P_MENTION),
    config: FUNGIBLE_CAST, flag: FLAG.false,
    stored: { [P_KEY]: { [PRIVATE_CHANNEL]: 'all' }, [Q_KEY]: { [PRIVATE_CHANNEL]: 'all' } }, readable: false,
    expected: unresolved('state-unavailable'),
    channelDelivery: delivery(undefined),
  },
]

// ---------------------------------------------------------------------------
// Group 10: a DM in fungible mode, decided by dm.enabled
// ---------------------------------------------------------------------------

const dmRows: FungibleDecisionRow[] = [
  ...ONE_FLAG_PER_FORM.map((flag): FungibleDecisionRow => ({
    label: `DM (im), DMs on, P's stored all for it, ${flagLabel(flag)}`,
    event: makeDm({ channel: DM_CHANNEL, text: 'plain words' }),
    config: FUNGIBLE_CAST, flag,
    stored: { [P_KEY]: { [DM_CHANNEL]: 'all' } },
    expected: deliver('dm'),
  })),
  ...[FLAG.true, FLAG.absent].map((flag): FungibleDecisionRow => ({
    label: `DM (im), DMs off, P's stored all for it, ${flagLabel(flag)}`,
    event: makeDm({ channel: DM_CHANNEL, text: P_MENTION }),
    config: FUNGIBLE_CAST_DM_OFF, flag,
    stored: { [P_KEY]: { [DM_CHANNEL]: 'all' } },
    expected: drop('dm-disabled'),
  })),
  ...[FLAG.false, FLAG.null].map((flag): FungibleDecisionRow => ({
    label: `D… ID with no channel_type, DMs on, ${flagLabel(flag)}`,
    event: makeDm({ channel: DM_CHANNEL, channel_type: undefined }),
    config: FUNGIBLE_CAST, flag,
    expected: deliver('dm'),
  })),
  ...[FLAG.true, FLAG.falseString].map((flag): FungibleDecisionRow => ({
    label: `D… ID with no channel_type, DMs off, ${flagLabel(flag)}`,
    event: makeDm({ channel: DM_CHANNEL, channel_type: undefined, text: P_MENTION }),
    config: FUNGIBLE_CAST_DM_OFF, flag,
    expected: drop('dm-disabled'),
  })),
]

// ---------------------------------------------------------------------------
// The groups, in the contract order
// ---------------------------------------------------------------------------

/** Current shared-authority seams. Existing shape/flag/author matrices above
 * remain the single owners of those permutations. These rows isolate values,
 * current observations and affected projections in both modes. */
const currentAuthorityRows: FungibleDecisionRow[] = (['strict', 'open'] as const).flatMap(mode => {
  const config = { ...FUNGIBLE_CAST, channel_mode: mode }
  const base = { config, flag: false, event: publicMessage(PUBLIC_CHANNEL) }
  const outcome = (value: DeliveryMode, via?: Via): DeliveryDecision => {
    const path = mode === 'open' ? onPath('public', value) : undefined
    return value === 'off' ? drop('channel-off', path) : via ? deliver(via, path) : drop('not-mentioned', path)
  }
  const values = (['off', 'mentions', 'all', 'thread_hybrid'] as const).flatMap(value =>
    ([['plain', 'plain words', value === 'all' ? 'receive_all' : undefined],
      ['mention before broadcast', `${broadcastText('here')} ${P_MENTION}`, 'mention'],
      ['broadcast', broadcastText('channel', 'room'), 'broadcast']] as const).map(([label, text, via]): FungibleDecisionRow => ({
      ...base, label: `${mode} ${value}: ${label}`, event: publicMessage(PUBLIC_CHANNEL, text),
      stored: { [P_KEY]: { [PUBLIC_CHANNEL]: value } }, expected: outcome(value, via),
    })))
  const siblings = (['eligible', 'ineligible', 'unresolved', 'missing', 'destination', 'unreadable'] as const).map((kind): FungibleDecisionRow => {
    const memberships = new Map<string, MembershipReading>([[P_KEY, eligibleMembership(P_KEY)]])
    if (kind !== 'missing') memberships.set(Q_KEY, kind === 'ineligible' ? { kind: 'ineligible', reason: 'absent' } :
      kind === 'unresolved' ? { kind: 'unresolved', reason: 'current-membership-missing' } : eligibleMembership(Q_KEY))
    return { ...base, label: `${mode} effectively-all sibling ${kind}`,
      config: kind === 'destination' ? { ...config, personas: config.personas.map(p => p.key === P_KEY ? { ...p, permission_prompts: PUBLIC_CHANNEL } : p) } : config,
      memberships, stored: { [P_KEY]: { [PUBLIC_CHANNEL]: 'all' }, [Q_KEY]: { [PUBLIC_CHANNEL]: 'all' } },
      readableFor: kind === 'unreadable' ? key => key !== Q_KEY : undefined,
      expected: outcome('all', kind === 'eligible' || kind === 'destination' ? 'receive_all_shared' : 'receive_all') }
  })
  const unavailable = (['missing-store', 'missing-choice', 'missing-membership', 'unresolved-membership', 'absent', 'affected', 'unaffected'] as const).map((kind): FungibleDecisionRow => ({
    ...base, label: `${mode} ${kind} never becomes a fallback choice`,
    stored: kind === 'missing-store' ? undefined : kind === 'missing-choice' ? {} : { [P_KEY]: { [PUBLIC_CHANNEL]: 'all' } },
    memberships: kind === 'missing-membership' ? new Map() : kind === 'unresolved-membership' || kind === 'absent'
      ? new Map([[P_KEY, kind === 'absent' ? { kind: 'ineligible', reason: 'absent' } : { kind: 'unresolved', reason: 'current-membership-missing' }]]) : undefined,
    readable: kind === 'affected' || kind === 'unaffected' ? false : true,
    readableFor: kind === 'unaffected' ? () => true : undefined,
    expected: kind === 'unaffected' ? outcome('all', 'receive_all') : kind === 'absent' ? { action: 'drop', reason: 'channel-ineligible' } :
      unresolved(kind === 'missing-store' || kind === 'affected' ? 'state-unavailable' : kind === 'missing-choice' ? 'choice-missing' : 'membership-unresolved'),
  }))
  return [...values, ...siblings, ...unavailable,
    { ...base, label: `${mode} off precedes another persona destination and mention`,
      event: publicMessage(Q_DESTINATION, `${P_MENTION} ${broadcastText('here')}`),
      stored: { [P_KEY]: { [Q_DESTINATION]: 'off' } }, expected: outcome('off') },
    { ...base, label: `${mode} DM proceeds with an independent readable projection and no membership`,
      event: makeDm(), stored: {}, readable: false, readableFor: (_key, channel) => channel?.startsWith('D') === true,
      memberships: new Map(), expected: deliver('dm') },
  ]
})

/** Shared rows are split by mode by the two suites. The lookup's answers are
 * immutable data, independent of the expected decision and recorded reads. */
const THREAD_ROOT = '1700000000.000100'
const OTHER_ROOT = '1700000000.000200'
const REPLY_TS = '1700000000.000101'
const JOINED_VIEW = Object.freeze({
  [P_KEY]: Object.freeze({ [PUBLIC_CHANNEL]: Object.freeze({
    [THREAD_ROOT]: 'joined' as const, [OTHER_ROOT]: 'not-joined' as const,
  }) }),
})
const THREAD_READ: ThreadRead = [P_KEY, PUBLIC_CHANNEL, THREAD_ROOT]
const VALUES = ['off', 'mentions', 'all', 'thread_hybrid'] as const

function threadGroups(mode: 'strict' | 'open') {
  const config = { ...FUNGIBLE_CAST, channel_mode: mode }
  const event = (extra: Record<string, unknown> = {}) => makeChannelMessage({
    channel: PUBLIC_CHANNEL, ts: REPLY_TS, thread_ts: THREAD_ROOT, ...extra,
  })
  const path = (value: DeliveryMode) => mode === 'open' ? onPath('public', value) : undefined
  const selected = (via: Via, value: DeliveryMode = 'thread_hybrid') => deliver(via, path(value))
  const dropped = (reason: 'not-mentioned' | 'channel-off' = 'not-mentioned', value: DeliveryMode = 'thread_hybrid') => drop(reason, path(value))
  const row = (label: string, extra: Partial<FungibleDecisionRow>, expected: DeliveryDecision): FungibleDecisionRow => ({
    config, flag: false, label: `${mode}: ${label}`, event: event(),
    stored: { [P_KEY]: { [PUBLIC_CHANNEL]: 'thread_hybrid' } }, threadViews: JOINED_VIEW,
    ...extra, expected,
  })
  const rootMessage = event({ thread_ts: REPLY_TS })
  const joinedReply = event()
  const messages = [
    { label: 'direct mention', event: event({ thread_ts: undefined, text: P_MENTION }), via: 'mention' },
    { label: 'Broadcast', event: event({ thread_ts: undefined, text: broadcastText('here') }), via: 'broadcast' },
    { label: 'unrelated root', event: rootMessage, via: undefined },
    { label: 'joined reply', event: joinedReply, via: 'thread' },
    { label: 'not-joined reply', event: event({ thread_ts: OTHER_ROOT }), via: undefined },
  ] as const
  const matrix = VALUES.flatMap(value => messages.map(message => row(`${value} ${message.label}`, {
    event: message.event, stored: { [P_KEY]: { [PUBLIC_CHANNEL]: value } },
    threadReads: value === 'thread_hybrid' && message.label.endsWith('reply')
      ? [[P_KEY, PUBLIC_CHANNEL, message.label === 'joined reply' ? THREAD_ROOT : OTHER_ROOT]] : [],
  }, value === 'off' ? dropped('channel-off', value)
    : message.via === 'mention' || message.via === 'broadcast' ? selected(message.via, value)
    : value === 'all' ? selected('receive_all', value)
    : value === 'thread_hybrid' && message.via === 'thread' ? selected('thread') : dropped('not-mentioned', value))))

  const threads = [
    ...[undefined, '', null, 'bad', 1700000000, '1700000000.1', REPLY_TS].map(parent => row(
      `root or malformed parent ${String(parent)}`, { event: event({ thread_ts: parent }) }, dropped())),
    ...VALUES.flatMap(value => [
      row(`${value} joined reply mention precedes Broadcast and thread`, {
        stored: { [P_KEY]: { [PUBLIC_CHANNEL]: value } },
        event: event({ text: `${mentionText(P_USER, 'alpha')} ${broadcastText('here')}` }),
      }, value === 'off' ? dropped('channel-off', value) : selected('mention', value)),
      ...(['here', 'channel'] as const).map(kind => row(`${value} joined reply ${kind} precedes thread`, {
        stored: { [P_KEY]: { [PUBLIC_CHANNEL]: value } }, event: event({ text: broadcastText(kind, 'room') }),
      }, value === 'off' ? dropped('channel-off', value) : selected('broadcast', value))),
    ]),
    ...[['everyone', broadcastText('everyone')], ['user group', userGroupMentionText('S0GROUP')]].map(([label, text]) => row(
      `${label} mention in a joined reply`, { event: event({ text }), threadReads: [THREAD_READ] }, selected('thread'))),
    ...(['file_share', 'bot_message', 'thread_broadcast', 'me_message'] as const).map(subtype => row(
      `joined ${subtype} reply`, { event: event({ subtype }), threadReads: [THREAD_READ] }, selected('thread'))),
    row('other persona bot-only reply', {
      event: makeBotMessage({ channel: PUBLIC_CHANNEL, ts: REPLY_TS, thread_ts: THREAD_ROOT, bot_id: Q_BOT }),
      threadReads: [THREAD_READ],
    }, selected('thread')),
    row('other persona user reply', { event: event({ user: Q_USER }), threadReads: [THREAD_READ] }, selected('thread')),
    row('other persona bot reply mentioning P', {
      event: makeBotMessage({ channel: PUBLIC_CHANNEL, ts: REPLY_TS, thread_ts: THREAD_ROOT, bot_id: Q_BOT, text: P_MENTION }),
    }, selected('mention')),
    row('mention with malformed parent keeps mention', { event: event({ text: P_MENTION, thread_ts: 'invalid-parent' }) }, selected('mention')),
    row('mention without timestamps keeps mention', { event: event({ text: P_MENTION, thread_ts: undefined, ts: undefined }) }, selected('mention')),
    row('view is scoped to the receiving persona', {
      receiver: Q_KEY, stored: { [Q_KEY]: { [PUBLIC_CHANNEL]: 'thread_hybrid' } }, threadReads: [[Q_KEY, PUBLIC_CHANNEL, THREAD_ROOT]],
    }, dropped()),
    row('view is scoped to the channel', {
      event: event({ channel: Q_DESTINATION }), stored: { [P_KEY]: { [Q_DESTINATION]: 'thread_hybrid' } },
      threadReads: [[P_KEY, Q_DESTINATION, THREAD_ROOT]],
    }, dropped()),
  ]
  const noLookup = [
    row('own user is excluded before lookup', { event: event({ user: P_USER }) }, drop('own')),
    row('own bot is excluded before lookup', { event: makeBotMessage({ channel: PUBLIC_CHANNEL, ts: REPLY_TS, thread_ts: THREAD_ROOT, bot_id: P_BOT }) }, drop('own')),
    row('unsupported subtype is excluded before lookup', { event: event({ subtype: 'message_changed' }) }, drop('non-message')),
    row('no author is excluded before lookup', { event: event({ user: undefined }) }, drop('no-author')),
    row('DM precedence', { event: makeDm({ text: `${P_MENTION} ${broadcastText('here')}`, thread_ts: THREAD_ROOT }) }, deliver('dm')),
    row('disabled DM', { config: { ...FUNGIBLE_CAST_DM_OFF, channel_mode: mode }, event: makeDm({ thread_ts: THREAD_ROOT }) }, drop('dm-disabled')),
    row('group DM', { event: makeGroupDmMessage({ thread_ts: THREAD_ROOT }) }, drop('group-dm')),
    row('unreadable store', { readable: false }, unresolved('state-unavailable')),
    row('missing choice', { stored: {} }, unresolved('choice-missing')),
    row('missing membership', { memberships: new Map() }, unresolved('membership-unresolved')),
    row('unresolved membership', { memberships: new Map([[P_KEY, { kind: 'unresolved', reason: 'current-membership-missing' }]]) }, unresolved('membership-unresolved')),
    row('departed membership', { memberships: new Map([[P_KEY, { kind: 'ineligible', reason: 'absent' }]]) }, { action: 'drop', reason: 'channel-ineligible' }),
    row('undecided stamp preserves its earlier hold', { threadStampUndecided: () => true }, { action: 'unresolved', reason: 'thread-stamp-undecided' }),
    ...(mode === 'open' ? [
      row('externally shared reply', { flag: true }, refused('externally-shared')),
      row('missing sharing evidence', { flag: undefined }, refused('flag-missing')),
      row('malformed channel', { event: event({ channel: MALFORMED_CHANNEL }) }, refused('channel-id-malformed')),
    ] : []),
  ]
  // SR-1.2.5 holds only dependent replies. Missing input keeps Task Decision 3's
  // drop; every earlier selection/exclusion keeps its whole outcome and no read.
  const unknown = { [P_KEY]: { [PUBLIC_CHANNEL]: { [THREAD_ROOT]: 'unknown' as const } } }
  const unknownView = [
    ...[THREAD_ROOT, OTHER_ROOT].map(root => row(`unknown view holds reply in ${root}`, {
      event: event({ thread_ts: root }),
      threadViews: { [P_KEY]: { [PUBLIC_CHANNEL]: { [root]: 'unknown' } } },
      threadReads: [[P_KEY, PUBLIC_CHANNEL, root]],
    }, {
      action: 'hold', hold: 'memory', via: 'thread', threadRoot: root,
      ...(mode === 'open' ? { fungible: onPath('public', 'thread_hybrid') } : {}),
    })),
    row('missing view input', { omitThreadMemory: true }, dropped()),
    ...[undefined, REPLY_TS].map(parent => row(`unknown view channel message ${String(parent)}`, {
      event: event({ thread_ts: parent }), threadViews: unknown,
    }, dropped())),
    row('unknown view mention precedes Broadcast and hold', {
      event: event({ text: `${P_MENTION} ${broadcastText('here')}` }), threadViews: unknown,
    }, selected('mention')),
    ...(['here', 'channel'] as const).map(kind => row(`unknown view ${kind} precedes hold`, {
      event: event({ text: broadcastText(kind) }), threadViews: unknown,
    }, selected('broadcast'))),
    ...(['off', 'mentions', 'all'] as const).map(value => row(`unknown view ${value} reply`, {
      stored: { [P_KEY]: { [PUBLIC_CHANNEL]: value } }, threadViews: unknown,
    }, value === 'off' ? dropped('channel-off', value)
      : value === 'all' ? selected('receive_all', value) : dropped('not-mentioned', value))),
    ...noLookup.map(original => ({
      ...original, label: `${original.label}; unknown view`,
      threadViews: { [P_KEY]: { [String(original.event.channel)]: { [THREAD_ROOT]: 'unknown' as const } } },
    })),
  ]
  // The same matrix at Q's notice destination, plus prompt/notice bot posts.
  // Moving/removing Q's destination and moving P's own destination preserve it.
  const destinations: ChannelDeliveryRow[] = [
    ...matrix,
    ...VALUES.flatMap(value => ['permission prompt', 'status notice'].map(text => row(`${value} Q ${text}`, {
      event: makeBotMessage({ channel: PUBLIC_CHANNEL, bot_id: Q_BOT, text }),
      stored: { [P_KEY]: { [PUBLIC_CHANNEL]: value } },
    }, value === 'off' ? dropped('channel-off', value) : value === 'all' ? selected('receive_all', value) : dropped('not-mentioned', value)))),
    row('Q bot reply in joined thread', {
      event: makeBotMessage({ channel: PUBLIC_CHANNEL, ts: REPLY_TS, thread_ts: THREAD_ROOT, bot_id: Q_BOT }), threadReads: [THREAD_READ],
    }, selected('thread')),
  ].flatMap(original => {
    const value = original.stored![P_KEY]![PUBLIC_CHANNEL]!
    const variants = [
      ['Q destination here', PUBLIC_CHANNEL, P_DESTINATION],
      ['Q destination DM', 'dm', P_DESTINATION],
      ['Q destination elsewhere', Q_DESTINATION, P_DESTINATION],
      ['Q removed', undefined, P_DESTINATION],
      ['P destination here', Q_DESTINATION, PUBLIC_CHANNEL],
    ] as const
    // The full selection table at the destination; movement controls need only
    // the root and joined reply, where the destination formerly changed selection.
    return variants.filter((_, index) => index === 0 || original.event === rootMessage || original.event === joinedReply).map(([label, q, p]) => ({
      ...original, label: `${original.label}; ${label}`,
      config: { ...config, personas: config.personas.filter(persona => q !== undefined || persona.key !== Q_KEY).map(persona => persona.key === Q_KEY
        ? { ...persona, permission_prompts: q! } : persona.key === P_KEY ? { ...persona, permission_prompts: p } : persona) },
      channelDelivery: delivery(value),
    }))
  })
  const shared = (['all', 'thread_hybrid', 'mentions', 'off', 'not-applied'] as const).flatMap(sibling =>
    [undefined, 'mention', 'broadcast'].map(via => row(`all beside ${sibling}; ${via ?? 'plain'}`, {
      config: { ...config, personas: config.personas.filter(p => sibling !== 'not-applied' || p.key !== Q_KEY)
        .map(p => p.key === Q_KEY ? { ...p, permission_prompts: PUBLIC_CHANNEL } : p) },
      stored: { [P_KEY]: { [PUBLIC_CHANNEL]: 'all' }, [Q_KEY]: { [PUBLIC_CHANNEL]: sibling === 'not-applied' ? 'all' : sibling } },
      event: event({ text: via === 'mention' ? `${P_MENTION} ${broadcastText('here')}` : via === 'broadcast' ? broadcastText('here') : 'plain words' }),
    }, selected(via === 'mention' || via === 'broadcast' ? via : sibling === 'all' ? 'receive_all_shared' : 'receive_all', 'all'))))
  return { matrix, threads, noLookup, unknownView, destinations, shared }
}

const strictThreads = threadGroups('strict')
const openThreads = threadGroups('open')
export const THREAD_DECISION_GROUPS = {
  matrix: { rows: [...strictThreads.matrix, ...openThreads.matrix] },
  threads: { rows: [...strictThreads.threads, ...openThreads.threads] },
  noLookup: { rows: [...strictThreads.noLookup, ...openThreads.noLookup] },
  unknownView: { rows: [...strictThreads.unknownView, ...openThreads.unknownView] },
  destinations: { rows: [...strictThreads.destinations, ...openThreads.destinations] },
  shared: { rows: [...strictThreads.shared, ...openThreads.shared] },
} as const

/** One group: its rows. */
export interface FungibleDecisionGroup<R extends FungibleDecisionRow = FungibleDecisionRow> {
  readonly rows: readonly R[]
}

/** ten groups, in its order. */
export const FUNGIBLE_DECISION_GROUPS = {
  declarative: { rows: declarativeRows },
  noStoredChoice: { rows: noStoredChoiceRows },
  storedAll: { rows: storedAllRows },
  ignoresChannels: { rows: ignoresChannelsRows },
  conditions: { rows: conditionRows },
  groupDms: { rows: groupDmRows },
  firstSteps: { rows: firstStepRows },
  unreadableStore: { rows: unreadableStoreRows },
  dmInFungibleMode: { rows: dmRows },
  currentAuthority: { rows: currentAuthorityRows },
  ...THREAD_DECISION_GROUPS,
} as const satisfies Readonly<Record<string, FungibleDecisionGroup>>
