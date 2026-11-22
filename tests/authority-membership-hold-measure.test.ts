/** Exclusive-job measurement: all 32 samples, no warmup, retries or drops.
 * Decision 5: every metric ≤25 ms; per-cell call median page ≤15/inventory ≤12.
 * Decision 6: rig garbage is not production load; operation garbage is still collected in its window. */
import { expect, test } from 'bun:test'
import { closeSync, fsync, openSync, writeSync } from 'node:fs'
import { join } from 'node:path'
import { assertNoLeak } from './test-helpers/credentials.ts'
import { AUTHORITY_FIXTURE_TIMEOUT_MS, AUTHORITY_POPULATIONS, makeAuthorityCostRig, type AuthorityLeakFailure } from './test-helpers/authority-cost.ts'
import { MEMBERSHIP_OPERATIONS, MEMBERSHIP_HOLD_SAMPLES, membershipHoldMedian, membershipHoldVerdict, prepareMembershipScan,
  type MembershipHoldSample } from './test-helpers/authority-membership.ts'

const SAMPLES = MEMBERSHIP_HOLD_SAMPLES
interface Sample extends MembershipHoldSample {
  bytesWritten: number; durableWriteMs: number; gcMs: number
}
test.skipIf(process.env['CSCB_AUTHORITY_HOLD_MEASURE'] !== '1')('membership page and inventory hold: all 32 samples', async () => {
  const samples: Sample[] = [], activities: unknown[] = [], captures: unknown[] = [], leaks: AuthorityLeakFailure[] = []
  for (const population of AUTHORITY_POPULATIONS) {
    const rig = await makeAuthorityCostRig(population), errors: unknown[] = []
    let fd: number | undefined
    try {
      fd = openSync(join(rig.h.root, 'membership-hold-probe'), 'w')
      console.log('AUTHORITY-MEMBERSHIP-HOLD-SHAPE', JSON.stringify({ population, bytes: rig.stateBytes, samples: SAMPLES, warmups: 0 }))
      for (let sample = 0; sample < SAMPLES; sample++) {
        const scan = await prepareMembershipScan(rig)
        for (const operation of MEMBERSHIP_OPERATIONS) {
          if (operation === 'inventory') await scan.remaining()
          const revision = rig.authority.revision, cp = rig.run.checkpoint()
          try {
            const gcStart = performance.now()
            Bun.gc(true)
            const gcMs = performance.now() - gcStart
            writeSync(fd, 'probe\n')
            const armed = performance.now()
            const timer = new Promise<number>(resolve => setTimeout(() => resolve(performance.now() - armed), 0))
            const sync = new Promise<number>((resolve, reject) => fsync(fd!, error => error ? reject(error) : resolve(performance.now() - armed)))
            const start = performance.now()
            await scan.operation(operation)
            const callMs = performance.now() - start
            const [timerMs, fsyncMs] = await Promise.all([timer, sync])
            const value: Sample = { population, operation, sample, callMs, timerMs, fsyncMs, gcMs,
              bytesWritten: rig.writes.reduce((n, w) => n + w.byteLength, 0),
              durableWriteMs: rig.writes.reduce((n, w) => n + w.ms, 0) }
            samples.push(value)
            const activity = rig.run.since(cp)
            activities.push({ population, operation, sample, revisionDelta: rig.authority.revision - revision,
              writerCalls: activity.writes.map(w => ({ authority: w.path === rig.h.paths.lastApplied, ok: w.ok })),
              lifecycle: activity.lifecycle, status: rig.run.membershipScanner.status('beta').state })
            console.log('AUTHORITY-MEMBERSHIP-HOLD-SAMPLE', JSON.stringify(value))
          } finally { await rig.collect(`population[${population}].sample[${sample}].${operation}`) }
        }
      }
      rig.restart()
    } catch (error) { errors.push(error); throw error }
    finally {
      try { captures.push(rig.captured({ errors, population })); leaks.push(...rig.leakFailures) }
      finally { try { if (fd !== undefined) closeSync(fd) } finally { await rig.close() } }
    }
  }
  const verdict = membershipHoldVerdict(samples)
  const mean = (values: number[]) => values.reduce((a, b) => a + b, 0) / values.length
  for (const operation of MEMBERSHIP_OPERATIONS) {
    const low = samples.filter(s => s.population === 0 && s.operation === operation)
    const high = samples.filter(s => s.population === 4000 && s.operation === operation)
    console.log('AUTHORITY-MEMBERSHIP-HOLD-SUMMARY', JSON.stringify({ operation,
      bytesPer1000Retained: (mean(high.map(s => s.bytesWritten)) - mean(low.map(s => s.bytesWritten))) / 4,
      durableWriteMsPer1000Retained: (mean(high.map(s => s.durableWriteMs)) - mean(low.map(s => s.durableWriteMs))) / 4,
      residualCallMsPer1000Retained: (mean(high.map(s => s.callMs - s.durableWriteMs)) - mean(low.map(s => s.callMs - s.durableWriteMs))) / 4,
      ...Object.fromEntries(AUTHORITY_POPULATIONS.map(population => [population, {
        ...Object.fromEntries((['callMs', 'timerMs', 'fsyncMs'] as const)
          .map(metric => [metric, Math.max(...samples.filter(s => s.population === population && s.operation === operation).map(s => s[metric]))])),
        medianCallMs: verdict.cells.find(cell => cell.operation === operation && cell.population === population)!.medianCallMs,
        gcMs: Math.max(...samples.filter(s => s.population === population && s.operation === operation).map(s => s.gcMs)),
        medianGcMs: membershipHoldMedian(samples.filter(s => s.population === population && s.operation === operation).map(s => s.gcMs)),
      }])) }))
  }
  // Report both checks together, even if a count/activity/secrecy assertion
  // below fails. Every raw sample and cell summary has already been printed.
  const failures = { countFailures: verdict.countFailures, ceilingFailures: verdict.ceilingFailures, medianFailures: verdict.medianFailures }
  console.log('AUTHORITY-MEMBERSHIP-HOLD-VERDICT', JSON.stringify(failures))
  expect(leaks).toEqual([]); assertNoLeak(captures)
  expect(samples).toHaveLength(32)
  expect(activities).toEqual(samples.map(({ population, operation, sample }) => ({ population, operation, sample,
    revisionDelta: operation === 'page' ? 200 : 1, writerCalls: [{ authority: true, ok: true }], lifecycle: [],
    status: operation === 'page' ? 'scanning' : 'complete' })))
  expect(failures).toEqual({ countFailures: [], ceilingFailures: [], medianFailures: [] })
}, AUTHORITY_FIXTURE_TIMEOUT_MS)
