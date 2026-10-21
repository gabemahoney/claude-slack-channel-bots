/** Read/write adapter over the single recovered shared-channel authority.
 * It owns no file, fallback choices, timestamps or independent persistence.
 */
import { sameSharedDeclaration, type SharedChannelAuthority, type PersonaDeclaration } from './shared-channels.ts'
import type { DeliveryMode, Persona } from './config.ts'

export const SET_CHANNEL_DELIVERY_TOOL = 'set_channel_delivery'
export const CHANNEL_DELIVERY_FILE_NAME = 'config.json.last-applied'
export const CHANNEL_DELIVERY_SET_STORED = 'stored'
export const CHANNEL_DELIVERY_SET_UNREADABLE = 'unreadable'
export const CHANNEL_DELIVERY_SET_INVALID = 'invalid'
export const CHANNEL_DELIVERY_SET_WRITE_FAILED = 'write-failed'
export type ChannelDeliveryDeclaration = PersonaDeclaration
export const CHANNEL_DELIVERY_DECLARATION_FIELDS = ['name', 'credentials_file', 'working_directory'] as const
export type ChannelDeliverySetInvalidField = 'key' | 'channel' | 'delivery' | 'declaration' | 'set_at'
export type ChannelDeliverySetResult =
  | { kind: typeof CHANNEL_DELIVERY_SET_STORED; previous: DeliveryMode | undefined }
  | { kind: typeof CHANNEL_DELIVERY_SET_UNREADABLE; path: string }
  | { kind: typeof CHANNEL_DELIVERY_SET_INVALID; field: ChannelDeliverySetInvalidField }
  | { kind: typeof CHANNEL_DELIVERY_SET_WRITE_FAILED; path: string }
export interface ChannelDeliveryStore {
  readonly path: string
  readonly readable: boolean
  readonly authority: SharedChannelAuthority
  storedChoice(key: string, channel: string): DeliveryMode | undefined
  storedChannels(key: string): string[]
  set(key: string, channel: string, delivery: DeliveryMode, declaration: ChannelDeliveryDeclaration): ChannelDeliverySetResult
  beginRetiring(keys: Iterable<string>): void
  endRetiring(keys: Iterable<string>): void
  isRetiring(key: string): boolean
}
export function channelDeliveryDeclarationOf(persona: Pick<Persona, 'name' | 'credentials_file' | 'working_directory'>): ChannelDeliveryDeclaration {
  return { name: persona.name, credentials_file: persona.credentials_file, working_directory: persona.working_directory }
}
export function createChannelDeliveryStore(authority: SharedChannelAuthority): ChannelDeliveryStore {
  const retiring = new Set<string>()
  return {
    path: authority.path,
    authority,
    get readable() { return authority.readable },
    storedChoice: (key, channel) => authority.choice(key, channel),
    storedChannels: key => authority.channels(key),
    set(key, channel, delivery, declaration) {
      if (!authority.readable) return { kind: CHANNEL_DELIVERY_SET_UNREADABLE, path: authority.path }
      const snapshot = authority.snapshot()
      const life = Object.hasOwn(snapshot.personas, key) ? snapshot.personas[key] : undefined
      if (!life || retiring.has(key) || !sameSharedDeclaration(life.declaration, declaration)) return { kind: CHANNEL_DELIVERY_SET_INVALID, field: 'declaration' }
      const previous = this.storedChoice(key, channel)
      const result = authority.assign(key, life.incarnation, channel, delivery, authority.revision)
      if (result.kind === 'applied') return { kind: CHANNEL_DELIVERY_SET_STORED, previous }
      if (result.kind === 'unresolved') return { kind: CHANNEL_DELIVERY_SET_UNREADABLE, path: authority.path }
      return { kind: CHANNEL_DELIVERY_SET_WRITE_FAILED, path: authority.path }
    },
    beginRetiring: keys => { for (const key of keys) retiring.add(key) },
    endRetiring: keys => { for (const key of keys) retiring.delete(key) },
    isRetiring: key => retiring.has(key),
  }
}
