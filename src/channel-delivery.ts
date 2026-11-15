/** Read/write adapter over the single recovered shared-channel authority.
 * It owns no file, fallback choices, timestamps or independent persistence.
 */
import type { SharedChannelAuthority } from './shared-channels.ts'
import type { ChannelMode, DeliveryMode } from './config.ts'
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
  membership: MembershipReading | undefined,
): ChannelDeliveryCurrentFacts {
  if (!store.readableFor(key, channel)) return { kind: 'unavailable', reason: 'shared-state-unreadable' }
  const saved = store.storedChoice(key, channel)
  if (saved === undefined) return { kind: 'unavailable', reason: 'channel-removed' }
  if (membership?.kind !== 'eligible') return { kind: 'unavailable', saved, reason: membership?.reason ?? 'current-membership-missing' }
  return { kind: 'available', mode, facts: { saved, effective: saved } }
}

export const SET_CHANNEL_DELIVERY_TOOL = 'set_channel_delivery'
export const CHANNEL_DELIVERY_FILE_NAME = 'config.json.last-applied'
export interface ChannelDeliveryStore {
  readonly path: string
  readonly readable: boolean
  readableFor(key: string, channel?: string): boolean
  readonly authority: SharedChannelAuthority
  incarnation(key: string): string | undefined
  storedChoice(key: string, channel: string): DeliveryMode | undefined
  lookupAttempt(key: string, incarnation: string, request: ChannelDeliveryAttemptRequest): BotAttemptResult | undefined
  attempt(key: string, incarnation: string, request: ChannelDeliveryAttemptRequest,
    authorize: () => BotAttemptRejection | undefined,
    applied?: (outcome: Extract<SharedBotAttempt, { status: 'applied' }>) => void): BotAttemptResult
  beginRetiring(keys: Iterable<string>): void
  endRetiring(keys: Iterable<string>): void
  isRetiring(key: string): boolean
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
    lookupAttempt: (key, incarnation, request) => retiring.has(key) ? { kind: 'inactive' } : authority.lookupBotAttempt(key, incarnation, request),
    attempt(key, incarnation, request, authorize, applied) {
      if (retiring.has(key) || authority.incarnation(key) !== incarnation || authority.reviewHeld(key)) return { kind: 'inactive' }
      return authority.botAttempt(key, incarnation, request, () => {
        const refusal = authorize()
        if (refusal) return { kind: 'refused', reason: refusal }
        if (retiring.has(key) || authority.incarnation(key) !== incarnation || authority.reviewHeld(key)) return { kind: 'refused', reason: 'inactive' }
        if (!currentMembership?.(key, request.channel)) return { kind: 'refused', reason: 'membership' }
        const facts: ChannelDeliveryFacts = { saved: request.delivery, effective: request.delivery }
        return { kind: 'authorized', facts }
      }, applied)
    },
    beginRetiring: keys => { for (const key of keys) retiring.add(key) },
    endRetiring: keys => { for (const key of keys) retiring.delete(key) },
    isRetiring: key => retiring.has(key) || authority.reviewHeld(key),
  }
}
