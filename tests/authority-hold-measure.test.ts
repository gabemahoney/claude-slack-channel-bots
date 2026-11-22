/** Explicit exclusive-job guard. Host numbers are indicative, never a verdict.
 * No warm-up, retries, dropped samples, percentile oracle or adaptive limits. */
import { expect, test } from 'bun:test'
import { closeSync, fsync, openSync, writeSync } from 'node:fs'
import { join } from 'node:path'
import { assertNoLeak } from './test-helpers/credentials.ts'
import {
  AUTHORITY_FIXTURE_TIMEOUT_MS, AUTHORITY_OPERATIONS, AUTHORITY_POPULATIONS,
  makeAuthorityCostRig, type AuthorityCostRig, type AuthorityLeakFailure, type AuthorityOperation,
} from './test-helpers/authority-cost.ts'

// Calibrated acceptance limits (decision 2, 2026-11-22), not configurable production timers.
const LIMIT_MS = { assignment: 40, writingTick: 25, idleTick: 10 } as const
const SAMPLES = 8
interface HoldSample {
  operation: AuthorityOperation; population: number; sample: number
  callMs: number; timerMs: number; fsyncMs: number; bytesWritten: number; durableWriteMs: number
}
interface HoldActivity {
  operation: AuthorityOperation; population: number; sample: number
  result: Awaited<ReturnType<AuthorityCostRig['operation']>>
  revisionDelta: number
  writerCalls: Array<{ authority: boolean; ok: boolean }>
  lifecycle: ReturnType<AuthorityCostRig['run']['since']>['lifecycle']
}
async function sample(rig: AuthorityCostRig, fd: number, operation: AuthorityOperation, population: number, sample: number): Promise<{ value: HoldSample; activity: HoldActivity }> {
  rig.writes.length = 0
  const revision = rig.authority.revision, cp = rig.run.checkpoint()
  writeSync(fd, 'probe\n')
  const armed = performance.now()
  const timer = new Promise<number>(resolve => setTimeout(() => resolve(performance.now() - armed), 0))
  const sync = new Promise<number>((resolve, reject) => fsync(fd, error => error ? reject(error) : resolve(performance.now() - armed)))
  const start = performance.now()
  // Complete handler/tick turn, including Promise continuations. A reload tick
  // awaits recoverPending before derive(), so timing its initial JS return
  // would miss the stall. No real sleeps or fake elapsed clock are involved.
  const result = await rig.operation(operation)
  const callMs = performance.now() - start
  const [timerMs, fsyncMs] = await Promise.all([timer, sync])
  const activity = rig.run.since(cp)
  return { value: { operation, population, sample, callMs, timerMs, fsyncMs,
    bytesWritten: rig.writes.reduce((n, w) => n + w.byteLength, 0),
    durableWriteMs: rig.writes.reduce((n, w) => n + w.ms, 0) },
    activity: { operation, population, sample, result, revisionDelta: rig.authority.revision - revision,
      writerCalls: activity.writes.map(w => ({ authority: w.path === rig.h.paths.lastApplied, ok: w.ok })),
      lifecycle: activity.lifecycle } }
}

test.skipIf(process.env['CSCB_AUTHORITY_HOLD_MEASURE'] !== '1')('authority whole-operation hold: explicit exclusive-job measurement', async () => {
  const samples: HoldSample[] = []
  const activities: HoldActivity[] = []
  const leakFailures: AuthorityLeakFailure[] = [], captures: Record<string, unknown>[] = []
  for (const population of AUTHORITY_POPULATIONS) {
    const rig = await makeAuthorityCostRig(population)
    const errors: unknown[] = []
    let fd: number | undefined
    try {
      fd = openSync(join(rig.h.root, 'hold-probe'), 'w')
      console.log('AUTHORITY-HOLD-SHAPE', JSON.stringify({ population, bytes: rig.stateBytes, samples: SAMPLES, warmups: 0 }))
      for (let i = 0; i < SAMPLES; i++) for (const operation of AUTHORITY_OPERATIONS) {
        const { value, activity } = await (async () => {
          try { return await sample(rig, fd!, operation, population, i) }
          finally { await rig.collect(`population[${population}].sample[${i}].${operation}`) }
        })()
        samples.push(value)
        activities.push(activity)
        console.log('AUTHORITY-HOLD-SAMPLE', JSON.stringify(value))
      }
      rig.assertNoCalls()
      rig.restart()
    } catch (error) { errors.push(error); throw error }
    finally {
      try {
        // Files are checked before cleanup; only small captures and safe leak
        // failures survive for the verdict after both populations finish.
        captures.push(rig.captured({ errors, population }))
        leakFailures.push(...rig.leakFailures)
      }
      finally {
        try { if (fd !== undefined) closeSync(fd) }
        finally { await rig.close() }
      }
    }
  }
  const mean = (values: number[]) => values.reduce((a, b) => a + b, 0) / values.length
  for (const operation of AUTHORITY_OPERATIONS) {
    const low = samples.filter(s => s.operation === operation && s.population === 0)
    const high = samples.filter(s => s.operation === operation && s.population === 4000)
    console.log('AUTHORITY-HOLD-SUMMARY', JSON.stringify({ operation,
      bytesPer1000Retained: (mean(high.map(s => s.bytesWritten)) - mean(low.map(s => s.bytesWritten))) / 4,
      durableWriteMsPer1000Retained: (mean(high.map(s => s.durableWriteMs)) - mean(low.map(s => s.durableWriteMs))) / 4,
      maxCallMs: Math.max(...low.concat(high).map(s => s.callMs)),
      maxTimerMs: Math.max(...low.concat(high).map(s => s.timerMs)),
      maxFsyncMs: Math.max(...low.concat(high).map(s => s.fsyncMs)) }))
  }
  expect(leakFailures).toEqual([])
  assertNoLeak(captures)
  // Evaluate only after printing every fixed sample and growth summary.
  expect(samples).toHaveLength(AUTHORITY_POPULATIONS.length * AUTHORITY_OPERATIONS.length * SAMPLES)
  // Assert every sample's activity only after collecting all 48, just like
  // the timing verdict. A fast no-op cannot stand in for a writing tick.
  expect(activities).toEqual(samples.map(({ operation, population, sample }) => ({
    operation, population, sample,
    result: operation === 'assignment' ? { isError: false, synchronousWrites: 2 } : undefined,
    revisionDelta: operation === 'assignment' ? 2 : operation === 'writingTick' ? 1 : 0,
    writerCalls: Array.from({ length: operation === 'assignment' ? 2 : operation === 'writingTick' ? 1 : 0 },
      () => ({ authority: true, ok: true })),
    lifecycle: [],
  })))
  expect(samples.flatMap(s => (['callMs', 'timerMs', 'fsyncMs'] as const)
    .filter(metric => s[metric] > LIMIT_MS[s.operation]).map(metric => ({ ...s, metric, limitMs: LIMIT_MS[s.operation] })))).toEqual([])
}, AUTHORITY_FIXTURE_TIMEOUT_MS)
