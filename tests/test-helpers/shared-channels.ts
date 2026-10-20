/** Shared-authority fixtures: production schema, serializer and durable writer only. */
import { existsSync, readFileSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { durableWriteFileSync } from '../../src/atomic-write.ts'
import { parsePersonaConfigBytes, type PersonaConfigInput } from '../../src/config.ts'
import {
  createSharedChannelAuthority, initialSharedChannelState, parseSharedChannelState,
  serializeSharedChannelState, type SharedChannelDeps, type SharedChannelState,
} from '../../src/shared-channels.ts'
import { isRealHome, isUnder, osTempDir } from './host-safe-env.ts'
import { makePersonaConfigInput } from './persona-config.ts'

export const SHARED_CHANNEL_IDS = { primary: 'C0TEST001', secondary: 'C0TEST002', private: 'G0TEST003' } as const
export function sharedChannelPath(stateDir: string): string { return join(resolve(stateDir), 'config.json.last-applied') }
export function configBytes(input: unknown): Buffer { return Buffer.from(JSON.stringify(input, null, 2) + '\n') }
export function channelPopulation(count: number, offset = 0) {
  return Array.from({ length: count }, (_, i) => ({
    id: `C0LARGE${String(i + offset).padStart(5, '0')}`,
    delivery: (['off', 'mentions', 'all', 'thread_hybrid'] as const)[i % 4]!,
  }))
}
export function initialSharedState(stateDir: string, input: PersonaConfigInput = makePersonaConfigInput({}, stateDir)): SharedChannelState {
  const bytes = configBytes(input)
  const config = parsePersonaConfigBytes(bytes, join(stateDir, 'config.json'), stateDir)
  let life = 0
  return initialSharedChannelState(bytes, config, () => `fixture-incarnation-${++life}`)
}
export function writeSharedState(stateDir: string, state: SharedChannelState): string {
  const dir = resolve(stateDir)
  if (isRealHome(dir) || dir === osTempDir() || !isUnder(dir, osTempDir())) {
    throw new Error('writeSharedState: pass an owned directory under the OS temp directory')
  }
  const path = sharedChannelPath(dir)
  const bytes = serializeSharedChannelState(state)
  if (!parseSharedChannelState(bytes, path)) throw new Error('writeSharedState: expected a shared authority')
  durableWriteFileSync(path, bytes)
  return path
}
export function readSharedState(stateDir: string): SharedChannelState | null {
  const path = sharedChannelPath(stateDir)
  if (!existsSync(path)) return null
  const state = parseSharedChannelState(readFileSync(path), path)
  if (!state) throw new Error('readSharedState: expected a shared authority envelope')
  return state
}
export function makeSharedAuthority(stateDir: string, input = makePersonaConfigInput({}, stateDir), deps: SharedChannelDeps = {}) {
  const state = initialSharedState(stateDir, input)
  writeSharedState(stateDir, state)
  return createSharedChannelAuthority(sharedChannelPath(stateDir), state, deps)
}
