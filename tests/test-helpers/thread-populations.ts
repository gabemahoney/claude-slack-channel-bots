/**
 * thread-populations.ts — t1.k49.39 SR-8's verification workloads as plain
 * data, and `seedPopulation`, which writes a Joined Thread population through
 * an injected production Thread Memory.
 *
 * This file imports only `node:` built-ins, never `src/` or a helper that
 * imports it: the `/ci` image holds only `/tests` and the packed package, so
 * `tests/integration/fixtures/sr8-evidence.ts` loads this file dynamically and
 * binds the packed package's modules (Task t2.yiv.sf.tu Decision 4). Unit
 * suites never import it directly: `tests/test-helpers/thread-memory.ts`
 * re-exports it and binds `seedPopulation` to `src/` (`seedUnitPopulation`).
 *
 * Injection surface (`SeedPopulationDeps`), all from one package:
 * - `createThreadMemory`: `src/thread-memory.ts`' factory, as is.
 * - `authority`: a `SharedChannelAuthority` (`src/shared-channels.ts`) over the
 *   stopped server's shared state, e.g. `createSharedChannelAuthority(path,
 *   parseSharedChannelState(bytes, path)!)` over `config.json.last-applied`.
 *   Joins take its current Channel Stamps; a store it has no marker for gets
 *   one through `setThreadMemoryCreated`, as at a production start.
 * - `stateDir`: the server's state directory; journals go to `<stateDir>/threads`.
 * - `fs`, `now`, `setInterval`, `clearInterval`: optional, passed through to the
 *   factory (production defaults otherwise). Seeding starts no maintenance, so
 *   no timer is armed.
 *
 * Seeding writes no journal or seal line itself: the factory loads the key,
 * then `addJoin` and `saveJoins` run in batches, then `flush` and `stop`. The
 * journal holds what production writes under the current Channel Stamps, and
 * the seal file is not touched. It runs while the server is stopped, and the
 * next start judges it by t1.k49.39 SR-2.4.4 as built:
 * - into a persona with no journal (no store yet, so no seal entry), the next
 *   start reports *changed while stopped* (`entry-missing`) once; a clean stop
 *   and another start report nothing (Decision 14's start, clean stop, measured
 *   start);
 * - into a store that a start created and a clean stop sealed, appended joins
 *   keep its store ID and raise its last record number, which SR-2.4.4 does not
 *   count as a change: the next start reports nothing.
 * Zero joins seed nothing and write nothing (Decision 21).
 *
 * SPDX-License-Identifier: MIT
 */
import type * as nodeFs from 'node:fs'

/** Joined Threads per persona (SR-8.1). */
export const SR8_POPULATIONS = [0, 10_000, 100_000] as const
/** `thread_hybrid` channels a population is spread over (SR-8.1). */
export const SR8_ELIGIBLE_CHANNELS = 100
/** First-time root-mention joins, then unmentioned replies in those threads (SR-8.2). */
export const SR8_BURST_JOINS = 1_000
export const SR8_BURST_REPLIES = 1_000
/** Unmentioned top-level messages dropped in `thread_hybrid` channels during a burst: one per eligible channel. */
export const SR8_BURST_DROPPED = SR8_ELIGIBLE_CHANNELS
/** Shared channels for the large-list workload (t1.tad.5i SR-6.3: at least 1,000). */
export const SR8_SHARED_LIST_CHANNELS = 1_000
export const SR8_CHANNEL_MODES = ['strict', 'open'] as const
export const SR8_RECIPIENTS = [1, 2] as const
/** Recipient persona names, in order; each name is also its persona key. */
export const SR8_PERSONAS = ['alpha', 'beta'] as const
/** `channelPopulation`'s delivery cycle: every fourth channel is `thread_hybrid`. */
export const SR8_DELIVERY_CYCLE = ['off', 'mentions', 'all', 'thread_hybrid'] as const
/** Channels a population's config lists so that exactly `SR8_ELIGIBLE_CHANNELS` are eligible. */
export const SR8_POPULATION_CHANNEL_COUNT = SR8_ELIGIBLE_CHANNELS * SR8_DELIVERY_CYCLE.length
/** Population Thread Roots are whole seconds from here (2020), older than any burst. */
export const SR8_ROOT_BASE_S = 1_600_000_000

export type Sr8ChannelMode = typeof SR8_CHANNEL_MODES[number]
export interface Sr8Combination { population: number; mode: Sr8ChannelMode; recipients: number }
/** The 12 combinations: population, then Channel Mode, then recipients. */
export function sr8Combinations(): Sr8Combination[] {
  return SR8_POPULATIONS.flatMap(population => SR8_CHANNEL_MODES.flatMap(mode =>
    SR8_RECIPIENTS.map(recipients => ({ population, mode, recipients }))))
}
export function sr8Personas(recipients: number): string[] { return SR8_PERSONAS.slice(0, recipients) }

export interface PopulationChannel { id: string; delivery: typeof SR8_DELIVERY_CYCLE[number] }
/** The same entries as `shared-channels.ts`' `channelPopulation(count, offset)`. */
export function populationChannels(count: number, offset = 0): PopulationChannel[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `C0LARGE${String(i + offset).padStart(5, '0')}`,
    delivery: SR8_DELIVERY_CYCLE[i % SR8_DELIVERY_CYCLE.length]!,
  }))
}
export const eligibleChannels = (channels: readonly PopulationChannel[]): string[] =>
  channels.filter(c => c.delivery === 'thread_hybrid').map(c => c.id)

/** A Joined Thread before its Channel Stamp: seeding takes the stamp from the authority. */
export interface PopulationJoin { key: string; channel: string; root: string; source: 'mention'; at: number }
const rootOf = (i: number) => `${SR8_ROOT_BASE_S + i}.000000`
/** Join `i` is in `channels[i % n]` with Thread Root `SR8_ROOT_BASE_S + i` s,
 * so roots strictly increase and a longer population extends a shorter one. */
export function populationJoins(persona: string, count: number, channels: readonly string[]): PopulationJoin[] {
  if (count > 0 && !channels.length) throw new Error('populationJoins needs channels')
  return Array.from({ length: count }, (_, i) => ({
    key: persona, channel: channels[i % channels.length]!, root: rootOf(i), source: 'mention', at: (SR8_ROOT_BASE_S + i) * 1000,
  }))
}
/** The `n` joins with the oldest Thread Roots (a double keeps a Slack timestamp's microseconds apart). */
export function oldestJoins<T extends { root: string }>(joins: readonly T[], n: number): T[] {
  return [...joins].sort((a, b) => Number(a.root) - Number(b.root)).slice(0, n)
}

/** One burst message as data; the scenarios build its event with Task t2.yiv.sf.2f's builders.
 * `personas` receive it (they share the channel); `mentions` are mentioned in it. */
export interface BurstMessage { channel: string; ts: string; threadTs?: string; personas: string[]; mentions: string[] }
export interface BurstSpec { rootMentions: BurstMessage[]; replies: BurstMessage[]; dropped: BurstMessage[] }
/** A combination's burst over `channels` (its eligible ids). Timestamps are
 * `startS` seconds plus a strictly increasing microsecond count, in push order:
 * root mentions of every recipient, one unmentioned reply in each new thread,
 * then unmentioned top-level messages, which `thread_hybrid` drops. */
export function burstSpec(combination: Sr8Combination, channels: readonly string[], startS: number): BurstSpec {
  if (!channels.length) throw new Error('burstSpec needs channels')
  const personas = sr8Personas(combination.recipients)
  let n = 0
  const ts = () => `${startS}.${String(++n).padStart(6, '0')}`
  const rootMentions = Array.from({ length: SR8_BURST_JOINS }, (_, i) =>
    ({ channel: channels[i % channels.length]!, ts: ts(), personas: [...personas], mentions: [...personas] }))
  const replies = Array.from({ length: SR8_BURST_REPLIES }, (_, i) => {
    const root = rootMentions[i % rootMentions.length]!
    return { channel: root.channel, ts: ts(), threadTs: root.ts, personas: [...personas], mentions: [] }
  })
  const dropped = Array.from({ length: SR8_BURST_DROPPED }, (_, i) =>
    ({ channel: channels[i % channels.length]!, ts: ts(), personas: [...personas], mentions: [] }))
  return { rootMentions, replies, dropped }
}

// --- Seeding through injected production modules ---

/** `src/thread-memory.ts`' `ThreadMemoryStampState`. */
export type PopulationStampState =
  | { kind: 'decided'; incarnation: string; threadHybridSince?: string }
  | { kind: 'undecided' }
export interface PopulationThreadJoin {
  channel: string; root: string; stamp: { incarnation: string; threadHybridSince: string }
  source: 'mention' | 'broadcast' | 'own-post'; at: number
}
/** The `createThreadMemory` options seeding sets (a subset of `ThreadMemoryOptions`). */
export interface PopulationMemoryOptions {
  stateDir: string; fs?: typeof nodeFs; now?: () => number
  setInterval?: typeof globalThis.setInterval; clearInterval?: typeof globalThis.clearInterval
  appliedKeys(): readonly string[]
  stamp(key: string, channel: string): PopulationStampState | undefined
  threadHybridChannels(key: string): readonly string[]
  markerKeys(): readonly string[]
  setCreated(key: string): { kind: 'saved' | 'failed' }
  clearCreated(key: string): { kind: 'saved' | 'failed' }
  onEvent?(event: { type: string; key: string }): void
}
/** What seeding calls on the store `createThreadMemory` returns. */
export interface PopulationMemory {
  loadKey(key: string): Promise<void>
  addJoin(key: string, fact: PopulationThreadJoin): boolean
  saveJoins(key: string, facts: readonly PopulationThreadJoin[]): Promise<{ kind: string }>
  flush(key: string): Promise<{ kind: string }>
  stop(): Promise<void>
}
/** What seeding reads of the `SharedChannelAuthority`. */
export interface PopulationAuthority {
  config(): { personas: readonly { key: string }[] }
  channelStamp(key: string, channel: string): PopulationStampState | undefined
  threadView(): { threadHybridChannels(key: string): readonly string[] }
  threadMemoryCreatedKeys(): readonly string[]
  setThreadMemoryCreated(key: string): { kind: 'saved' | 'failed' }
  clearThreadMemoryCreated(key: string): { kind: 'saved' | 'failed' }
}
export interface SeedPopulationDeps {
  createThreadMemory(options: PopulationMemoryOptions): PopulationMemory
  authority: PopulationAuthority
  stateDir: string
  fs?: typeof nodeFs; now?: () => number
  setInterval?: typeof globalThis.setInterval; clearInterval?: typeof globalThis.clearInterval
  onEvent?(event: { type: string; key: string }): void
}
/** Joins per `addJoin`/`saveJoins` batch: the fastest measured (100,000 joins in about 3 s). */
export const SEED_BATCH_JOINS = 1_000
const SEED_REFUSED_EVENTS = new Set(['read-failed', 'lines-quarantined', 'append-failed', 'creation-failed', 'compaction-failed'])

/** `joins` (all of persona `key`) under the authority's current Channel Stamps. */
export function stampedJoins(authority: Pick<PopulationAuthority, 'channelStamp'>, key: string, joins: readonly PopulationJoin[]): PopulationThreadJoin[] {
  const stamps = new Map<string, PopulationThreadJoin['stamp']>()
  return joins.map(join => {
    if (join.key !== key) throw new Error('stampedJoins: a join of another persona')
    let stamp = stamps.get(join.channel)
    if (!stamp) {
      const state = authority.channelStamp(key, join.channel)
      if (state?.kind !== 'decided' || state.threadHybridSince === undefined) throw new Error('stampedJoins: a channel without a decided thread_hybrid stamp')
      stamps.set(join.channel, stamp = { incarnation: state.incarnation, threadHybridSince: state.threadHybridSince })
    }
    return { channel: join.channel, root: join.root, stamp, source: join.source, at: join.at }
  })
}

/** Write `joins` (all of persona `key`) through production Thread Memory, then
 * stop it. Throws, after stopping, on any join production refuses or any
 * save that is not `saved`. Zero joins write nothing. */
export async function seedPopulation(deps: SeedPopulationDeps, { key, joins, batch = SEED_BATCH_JOINS }:
  { key: string; joins: readonly PopulationJoin[]; batch?: number }): Promise<{ key: string; seeded: number }> {
  if (!joins.length) return { key, seeded: 0 }
  const { authority } = deps, facts = stampedJoins(authority, key, joins)
  // Applied keys are read once, as the server holds its applied config.
  const refused: string[] = [], applied = authority.config().personas.map(p => p.key)
  const memory = deps.createThreadMemory({
    stateDir: deps.stateDir, fs: deps.fs, now: deps.now, setInterval: deps.setInterval, clearInterval: deps.clearInterval,
    appliedKeys: () => applied,
    stamp: (k, channel) => authority.channelStamp(k, channel),
    threadHybridChannels: k => authority.threadView().threadHybridChannels(k),
    markerKeys: () => authority.threadMemoryCreatedKeys(),
    setCreated: k => authority.setThreadMemoryCreated(k),
    clearCreated: k => authority.clearThreadMemoryCreated(k),
    onEvent(event) { if (SEED_REFUSED_EVENTS.has(event.type)) refused.push(event.type); deps.onEvent?.(event) },
  })
  try {
    await memory.loadKey(key)
    if (refused.length) throw new Error(`seedPopulation: Thread Memory reported ${refused.join(', ')}`)
    for (let at = 0; at < facts.length; at += batch) {
      const part = facts.slice(at, at + batch)
      if (!part.every(fact => memory.addJoin(key, fact))) throw new Error('seedPopulation: a join production refused')
      const saved = await memory.saveJoins(key, part)
      if (saved.kind !== 'saved') throw new Error(`seedPopulation: a batch was ${saved.kind}`)
    }
    const flushed = await memory.flush(key)
    if (flushed.kind !== 'saved' || refused.length) throw new Error(`seedPopulation: the last save was ${flushed.kind}`)
  } finally { await memory.stop() }
  return { key, seeded: facts.length }
}
