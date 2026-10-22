/** Read/write adapter over the single recovered shared-channel authority.
 * It owns no file, fallback choices, timestamps or independent persistence.
 */
import { sameSharedDeclaration, type SharedChannelAuthority, type PersonaDeclaration } from './shared-channels.ts'
import type { ChannelMode, DeliveryMode, Persona } from './config.ts'
import { channelDeliveryFor } from './delivery-decision.ts'
import { fungibleDestinationsOf } from './persona-destination.ts'
import type { BotAttemptRejection, BotAttemptResult, ChannelDeliveryAttemptRequest, ChannelDeliveryFacts, SharedBotAttempt } from './channel-delivery-attempt.ts'
import type { MembershipFault, MembershipReading } from './channel-membership.ts'

export type { BotAttemptResult, ChannelDeliveryAttemptRequest, ChannelDeliveryFacts } from './channel-delivery-attempt.ts'

export type ChannelDeliveryUnavailableReason = MembershipFault | 'channel-removed' | 'absent' | 'external-sharing' | 'invalid-channel'
export type ChannelDeliveryCurrentFacts =
  | { kind: 'available'; mode: ChannelMode; facts: ChannelDeliveryFacts }
  | { kind: 'unavailable'; reason: ChannelDeliveryUnavailableReason; saved?: DeliveryMode }
/** Project known saved facts separately from current eligibility. Missing
 * evidence never falls through the delivery policy's absent-choice default. */
export function currentChannelDeliveryFacts(
  key: string, channel: string, mode: ChannelMode,
  store: Pick<ChannelDeliveryStore, 'readableFor' | 'storedChoice'>,
  personas: readonly Persona[], membership: MembershipReading | undefined,
): ChannelDeliveryCurrentFacts {
  if (!store.readableFor(key, channel)) return { kind: 'unavailable', reason: 'shared-state-unreadable' }
  const saved = store.storedChoice(key, channel)
  if (saved === undefined) return { kind: 'unavailable', reason: 'channel-removed' }
  if (membership?.kind !== 'eligible') return { kind: 'unavailable', saved, reason: membership?.reason ?? 'current-membership-missing' }
  const effective = channelDeliveryFor(key, channel, {
    fungibleDestinations: mode === 'open' ? fungibleDestinationsOf({ channel_mode: mode }, personas) : [],
    storedChoices: { readable: true, storedChoice: () => saved },
  })
  return { kind: 'available', mode, facts: { saved, effective: effective.delivery!, heldByLoopGuard: effective.heldByLoopGuard } }
}

export const SET_CHANNEL_DELIVERY_TOOL = 'set_channel_delivery'
export const CHANNEL_DELIVERY_FILE_NAME = 'config.json.last-applied'
export const CHANNEL_DELIVERY_SET_STORED = 'stored'
export const CHANNEL_DELIVERY_SET_UNREADABLE = 'unreadable'
export const CHANNEL_DELIVERY_SET_INVALID = 'invalid'
export const CHANNEL_DELIVERY_SET_WRITE_FAILED = 'write-failed'
export type ChannelDeliveryDeclaration = PersonaDeclaration
export const CHANNEL_DELIVERY_DECLARATION_FIELDS = ['name', 'credentials_file', 'working_directory'] as const
export type ChannelDeliverySetInvalidField = 'key' | 'channel' | 'delivery' | 'declaration' | 'set_at' | 'membership'
export type ChannelDeliverySetResult =
  | { kind: typeof CHANNEL_DELIVERY_SET_STORED; previous: DeliveryMode | undefined }
  | { kind: typeof CHANNEL_DELIVERY_SET_UNREADABLE; path: string }
  | { kind: typeof CHANNEL_DELIVERY_SET_INVALID; field: ChannelDeliverySetInvalidField }
  | { kind: typeof CHANNEL_DELIVERY_SET_WRITE_FAILED; path: string }
export interface ChannelDeliveryStore {
  readonly path: string
  readonly readable: boolean
  readableFor(key: string, channel?: string): boolean
  readonly authority: SharedChannelAuthority
  incarnation(key: string): string | undefined
  storedChoice(key: string, channel: string): DeliveryMode | undefined
  storedChannels(key: string): string[]
  set(key: string, channel: string, delivery: DeliveryMode, declaration: ChannelDeliveryDeclaration): ChannelDeliverySetResult
  lookupAttempt(key: string, incarnation: string, request: ChannelDeliveryAttemptRequest): BotAttemptResult | undefined
  attempt(key: string, incarnation: string, request: ChannelDeliveryAttemptRequest,
    authorize: () => BotAttemptRejection | undefined,
    applied?: (outcome: Extract<SharedBotAttempt, { status: 'applied' }>) => void): BotAttemptResult
  beginRetiring(keys: Iterable<string>): void
  endRetiring(keys: Iterable<string>): void
  isRetiring(key: string): boolean
}
export function channelDeliveryDeclarationOf(persona: Pick<Persona, 'name' | 'credentials_file' | 'working_directory'>): ChannelDeliveryDeclaration {
  return { name: persona.name, credentials_file: persona.credentials_file, working_directory: persona.working_directory }
}
export function createChannelDeliveryStore(authority: SharedChannelAuthority, currentMembership?: (key: string, channel: string) => boolean): ChannelDeliveryStore {
  const retiring = new Set<string>()
  return {
    path: authority.path,
    authority,
    incarnation: key => authority.incarnation(key),
    get readable() { return authority.readable },
    readableFor: (key, channel) => authority.readableFor(key, channel),
    storedChoice: (key, channel) => authority.choice(key, channel),
    storedChannels: key => authority.channels(key),
    lookupAttempt: (key, incarnation, request) => retiring.has(key) ? { kind: 'inactive' } : authority.lookupBotAttempt(key, incarnation, request),
    attempt(key, incarnation, request, authorize, applied) {
      if (retiring.has(key) || authority.incarnation(key) !== incarnation || authority.reviewHeld(key)) return { kind: 'inactive' }
      return authority.botAttempt(key, incarnation, request, () => {
        const refusal = authorize()
        if (refusal) return { kind: 'refused', reason: refusal }
        if (retiring.has(key) || authority.incarnation(key) !== incarnation || authority.reviewHeld(key)) return { kind: 'refused', reason: 'inactive' }
        if (!currentMembership?.(key, request.channel)) return { kind: 'refused', reason: 'membership' }
        const config = authority.config()
        const result = channelDeliveryFor(key, request.channel, {
          fungibleDestinations: fungibleDestinationsOf(config, config.personas),
          storedChoices: { readable: true, storedChoice: () => request.delivery },
        })
        const facts: ChannelDeliveryFacts = { saved: request.delivery, effective: result.delivery!, heldByLoopGuard: result.heldByLoopGuard }
        return { kind: 'authorized', facts }
      }, applied)
    },
    set(key, channel, delivery, declaration) {
      if (!authority.readable) return { kind: CHANNEL_DELIVERY_SET_UNREADABLE, path: authority.path }
      const snapshot = authority.snapshot()
      const life = Object.hasOwn(snapshot.personas, key) ? snapshot.personas[key] : undefined
      if (!life || retiring.has(key) || authority.reviewHeld(key) || !sameSharedDeclaration(life.declaration, declaration)) return { kind: CHANNEL_DELIVERY_SET_INVALID, field: 'declaration' }
      if (currentMembership && !currentMembership(key, channel)) return { kind: CHANNEL_DELIVERY_SET_INVALID, field: 'membership' }
      const previous = this.storedChoice(key, channel)
      const result = authority.assign(key, life.incarnation, channel, delivery, authority.revision)
      if (result.kind === 'applied') return { kind: CHANNEL_DELIVERY_SET_STORED, previous }
      if (result.kind === 'unresolved') return { kind: CHANNEL_DELIVERY_SET_UNREADABLE, path: authority.path }
      return { kind: CHANNEL_DELIVERY_SET_WRITE_FAILED, path: authority.path }
    },
    beginRetiring: keys => { for (const key of keys) retiring.add(key) },
    endRetiring: keys => { for (const key of keys) retiring.delete(key) },
    isRetiring: key => retiring.has(key) || authority.reviewHeld(key),
  }
}
