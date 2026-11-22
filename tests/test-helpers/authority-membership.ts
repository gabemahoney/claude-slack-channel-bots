/** Deferred production scanner operations; no replacement transaction or writer. */
import { expect, spyOn } from 'bun:test'
import { readFileSync } from 'node:fs'
import { membershipPage } from './shared-channels.ts'
import { makeDeferredWebApiCall } from './slack-stub.ts'
import { AUTHORITY_POPULATIONS, countAuthorityCallback, type AuthorityCostRig } from './authority-cost.ts'
import { parseSharedChannelState, createSharedChannelAuthority } from '../../src/shared-channels.ts'

export const MEMBERSHIP_OPERATIONS = ['page', 'inventory'] as const
export type MembershipOperation = typeof MEMBERSHIP_OPERATIONS[number]

// Acceptance calibration (decision 5), independent of production timers.
export const MEMBERSHIP_HOLD_SAMPLES = 8
export const MEMBERSHIP_HOLD_CEILING_MS = 25
export const MEMBERSHIP_HOLD_MEDIAN_MS = { page: 15, inventory: 12 } as const
export const MEMBERSHIP_HOLD_METRICS = ['callMs', 'timerMs', 'fsyncMs'] as const
export interface MembershipHoldSample {
  population: typeof AUTHORITY_POPULATIONS[number]
  operation: MembershipOperation
  sample: number
  callMs: number
  timerMs: number
  fsyncMs: number
}
/** Median of a copy; empty cells have no median and cannot pass a verdict. */
export function membershipHoldMedian(values: readonly number[]): number | null {
  if (!values.length) return null
  const sorted = [...values].sort((a, b) => a - b), middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2
}
/** Pure verdict: collect every count, ceiling and typical-cost failure before
 * deciding. No retries, discarded samples, timing, output or caller mutation. */
export function membershipHoldVerdict(samples: readonly MembershipHoldSample[]) {
  const expected = MEMBERSHIP_HOLD_SAMPLES * MEMBERSHIP_OPERATIONS.length * AUTHORITY_POPULATIONS.length
  const cells = MEMBERSHIP_OPERATIONS.flatMap(operation => AUTHORITY_POPULATIONS.map(population => {
    const cell = samples.filter(s => s.operation === operation && s.population === population)
    return { operation, population, sampleCount: cell.length, medianCallMs: membershipHoldMedian(cell.map(s => s.callMs)),
      limitMs: MEMBERSHIP_HOLD_MEDIAN_MS[operation] }
  }))
  const countFailures: Array<{ expected: number; actual: number; operation?: MembershipOperation; population?: MembershipHoldSample['population'] }> = []
  if (samples.length !== expected) countFailures.push({ expected, actual: samples.length })
  for (const cell of cells) if (cell.sampleCount !== MEMBERSHIP_HOLD_SAMPLES) countFailures.push({
    operation: cell.operation, population: cell.population, expected: MEMBERSHIP_HOLD_SAMPLES, actual: cell.sampleCount,
  })
  const ceilingFailures = samples.flatMap(s => MEMBERSHIP_HOLD_METRICS.filter(metric => !(s[metric] <= MEMBERSHIP_HOLD_CEILING_MS))
    .map(metric => ({ operation: s.operation, population: s.population, sample: s.sample,
      metric, valueMs: s[metric], limitMs: MEMBERSHIP_HOLD_CEILING_MS })))
  const medianFailures = cells.filter(cell => cell.medianCallMs === null || !(cell.medianCallMs <= cell.limitMs))
  return { passed: countFailures.length === 0 && ceilingFailures.length === 0 && medianFailures.length === 0,
    cells, countFailures, ceilingFailures, medianFailures }
}

export async function prepareMembershipScan(rig: AuthorityCostRig) {
  const channels = Object.keys(rig.authority.snapshot().personas['beta']!.assignments)
  const pages = Array.from({ length: 7 }, () => makeDeferredWebApiCall())
  const stub = rig.run.currentStub('beta')
  const calls = stub.calls.inventory.length
  stub.script.inventory.push(...pages.map(p => p.outcome))
  rig.run.membershipScanner.request('beta')
  await rig.run.membershipClock.advanceTo(rig.run.membershipScanner.status('beta').nextAttemptAt!)
  await rig.run.membershipClock.flush()
  expect(stub.calls.inventory.length - calls).toBe(1)
  expect(rig.run.membershipScanner.status('beta')).toMatchObject({ state: 'scanning', pages: 0, positives: 0 })
  return {
    channels,
    async operation(op: MembershipOperation) {
      pages[op === 'page' ? 0 : 6]!.settle(membershipPage(op === 'page' ? channels.slice(0, 200) : [], op === 'page' ? 'page-1' : undefined))
      await rig.run.membershipClock.flush()
    },
    async remaining() {
      for (let i = 1; i < 6; i++) {
        try {
          pages[i]!.settle(membershipPage(channels.slice(i * 200, (i + 1) * 200), `page-${i + 1}`))
          await rig.run.membershipClock.flush()
        } finally { await rig.collect(`interposed.page[${i}]`) }
      }
      expect(stub.calls.inventory.length - calls).toBe(7)
      expect(rig.run.membershipScanner.status('beta')).toMatchObject({ state: 'scanning', pages: 6, positives: 1100 })
    },
  }
}

const configTree = (value: unknown): value is { personas: unknown[] } => !!value && typeof value === 'object' &&
  Array.isArray((value as { personas?: unknown }).personas)

/** Counts only actual new string -> UTF-8 conversion, not buffer copies or
 * base64 decoding. Pretty sibling text is derived at its persisted depth.
 * Local spies preserve native overload/replacer behavior and always restore. */
export async function countMembershipWork(rig: AuthorityCostRig, operation: () => Promise<void>) {
  const state = rig.authority.snapshot()
  const sibling = JSON.stringify(state.personas['alpha'], null, 2).replaceAll('\n', '\n    ')
  const counts = { fullConfigParses: 0, siblingEncodes: 0, encodedBytes: 0, encodeCalls: 0,
    frozenConfigTrees: 0, serializedConfigTrees: 0, configVisits: 0 }
  const from = Buffer.from, freeze = Object.freeze
  // Reflect.apply keeps every Buffer.from overload and its optional arguments.
  const encoding = spyOn(Buffer, 'from').mockImplementation((...args: unknown[]) => {
    if (typeof args[0] === 'string' && (args[1] === undefined || args[1] === 'utf8' || args[1] === 'utf-8')) {
      counts.encodeCalls++; counts.encodedBytes += Buffer.byteLength(args[0])
      if (args[0].includes(sibling)) counts.siblingEncodes++
    }
    return Reflect.apply(from, Buffer, args)
  })
  const freezing = spyOn(Object, 'freeze').mockImplementation(<T>(value: T) => {
    if (configTree(value) && !Object.isFrozen(value)) counts.frozenConfigTrees++
    return freeze(value)
  })
  try {
    const { work } = await countAuthorityCallback(rig, operation, {
      parsed(value) { if (configTree(value)) counts.fullConfigParses++ },
      serialized(value) { if (configTree(value)) counts.serializedConfigTrees++ },
      visited(value) { if (configTree(value)) counts.configVisits++ },
    })
    return { ...work, ...counts }
  } finally { freezing.mockRestore(); encoding.mockRestore() }
}

/** Full-reader verification belongs outside work/timing windows. */
export function verifyMembershipWrite(rig: AuthorityCostRig, revision: number, op: MembershipOperation,
  before: ReturnType<AuthorityCostRig['authority']['snapshot']>, channels: string[]) {
  const after = rig.authority.snapshot(), delta = op === 'page' ? 200 : 1
  expect(rig.writes).toHaveLength(1)
  expect(after.revision).toBe(revision + delta)
  expect(after.personas['beta']!.assignments).toEqual(before.personas['beta']!.assignments)
  expect(after.personas['alpha']).toEqual(before.personas['alpha'])
  expect(after.outcomes).toEqual(before.outcomes)
  expect(after.source).toEqual(before.source)
  expect(after.applied).toEqual(before.applied)
  const fresh = Object.values(after.personas['beta']!.membershipEvents).filter(e => e.order > revision)
  expect(fresh.map(e => e.order)).toEqual(op === 'page' ? Array.from({ length: 200 }, (_, i) => revision + i + 1) : [])
  if (op === 'page') {
    expect(fresh.map(e => e.channel)).toEqual(channels.slice(0, 200))
    expect(rig.run.membershipScanner.status('beta')).toMatchObject({ state: 'scanning', pages: 1, positives: 1100 })
    expect(after.personas['beta']!.membershipInventory).toEqual(before.personas['beta']!.membershipInventory)
  } else {
    expect(after.personas['beta']!.membershipInventory?.recordedOrder).toBe(revision + 1)
    expect(rig.run.membershipScanner.status('beta')).toMatchObject({ state: 'complete', pages: 7, positives: 1100 })
  }
  for (const channel of channels) expect(rig.run.membership.read('beta', channel, 'open').kind).toBe('eligible')
  const bytes = readFileSync(rig.h.paths.lastApplied)
  const read = parseSharedChannelState(bytes, rig.h.paths.lastApplied, { home: rig.h.home })!
  expect(read).toEqual(after)
  expect(createSharedChannelAuthority(rig.h.paths.lastApplied, read, { home: rig.h.home }).snapshot()).toEqual(after)
}
