/** Applied-choice projections and seeds over the sole shared envelope. */
import { channelDeliveryDeclarationOf, type ChannelDeliveryDeclaration } from '../../src/channel-delivery.ts'
import type { DeliveryMode, Persona } from '../../src/config.ts'
import { makePersona, makePersonaConfigInput } from './persona-config.ts'
import { initialSharedState, readSharedState, writeSharedState } from './shared-channels.ts'
export const SAMPLE_SET_AT = '2026-06-01T09:30:00.000Z'
export interface ChannelDeliveryChannelSeed { readonly delivery: DeliveryMode; readonly set_at?: string }
export interface ChannelDeliveryPersonaSeed {
  readonly declaration: ChannelDeliveryDeclaration
  readonly channels: Readonly<Record<string, ChannelDeliveryChannelSeed>>
}
export type ChannelDeliveryRecord = Map<string, { declaration: ChannelDeliveryDeclaration; channels: Map<string, { delivery: DeliveryMode }> }>
export const declarationOf = (persona: Pick<Persona, 'name' | 'credentials_file' | 'working_directory'>): ChannelDeliveryDeclaration => channelDeliveryDeclarationOf(persona)
export function channelDeliveryRecordOf(entries: Readonly<Record<string, ChannelDeliveryPersonaSeed>>): ChannelDeliveryRecord {
  return new Map(Object.entries(entries).map(([key, value]) => [key, {
    declaration: value.declaration,
    channels: new Map(Object.entries(value.channels).map(([id, channel]) => [id, { delivery: channel.delivery }])),
  }]))
}
export function writeChannelDeliveryRecord(stateDir: string, entries: Readonly<Record<string, ChannelDeliveryPersonaSeed>>): string {
  const personas = Object.values(entries).map(entry => {
    const channels = Object.entries(entry.channels).map(([id, choice]) => ({ id, delivery: choice.delivery }))
    return makePersona({ ...entry.declaration, channels, permission_prompts: channels[0]?.id ?? 'dm', ...(channels.length ? {} : { dm: { enabled: true, contact: 'U0TEST001' } }) }, stateDir)
  })
  return writeSharedState(stateDir, initialSharedState(stateDir, makePersonaConfigInput({ personas }, stateDir)))
}
export function readChannelDeliveryRecord(stateDir: string): ChannelDeliveryRecord | null {
  const state = readSharedState(stateDir)
  return state && new Map(Object.entries(state.personas).map(([key, life]) => [key, {
    declaration: life.declaration,
    channels: new Map(Object.entries(life.assignments).map(([id, choice]) => [id, { delivery: choice.delivery }])),
  }]))
}
