import { beforeAll, describe, expect, test } from 'bun:test'
import { assertNoLeak } from './test-helpers/credentials.ts'
import {
  AUTHORITY_FIXTURE_TIMEOUT_MS, AUTHORITY_OPERATIONS, AUTHORITY_POPULATIONS,
  countAuthorityWork, makeAuthorityCostRig, readAuthorityImage, type AuthorityOperation, type AuthorityWork,
} from './test-helpers/authority-cost.ts'

describe('authority CPU work with retained attempts (b.o83)', () => {
  const observations = new Map<number, Map<AuthorityOperation, AuthorityWork>>()
  const behavior = new Map<number, { operations: unknown[]; restart: boolean }>()
  beforeAll(async () => {
    for (const population of AUTHORITY_POPULATIONS) {
      const rig = await makeAuthorityCostRig(population, true)
      const errors: unknown[] = []
      try {
        const steps: unknown[] = [], measures = new Map<AuthorityOperation, AuthorityWork>()
        for (const op of AUTHORITY_OPERATIONS) {
          rig.writes.length = 0
          const revision = rig.authority.revision
          const cp = rig.run.checkpoint()
          try {
            const { work, result } = await countAuthorityWork(rig, op)
            measures.set(op, work)
            const images = rig.writes.map(w => readAuthorityImage(rig, w))
            steps.push({ op, result, writes: images.map(s => ({ order: s.revision - revision,
              measured: Object.values(s.outcomes.botAttempts ?? {}).filter(a => a.startedOrder > revision).map(a => a.status) })),
              writerCalls: rig.run.since(cp).writes.map(w => ({ authority: w.path === rig.h.paths.lastApplied, ok: w.ok })),
              revisionDelta: rig.authority.revision - revision })
            rig.assertNoCalls()
            if (op !== 'assignment') expect(rig.run.since(cp).lifecycle).toEqual([])
            console.log('AUTHORITY-WORK', JSON.stringify({ population, op, ...work }))
          } finally { await rig.collect(`population[${population}].${op}`) }
        }
        rig.restart()
        behavior.set(population, { operations: steps, restart: true })
        observations.set(population, measures)
      } catch (error) { errors.push(error); throw error }
      finally {
        try {
          const captured = rig.captured({ errors, population })
          expect(rig.leakFailures).toEqual([])
          assertNoLeak(captured)
        }
        finally { await rig.close() }
      }
    }
  }, AUTHORITY_FIXTURE_TIMEOUT_MS)

  for (const op of AUTHORITY_OPERATIONS) {
    test(`${op}: parsing and attempt traversal do not grow with retained history`, () => {
      const small = observations.get(0)!.get(op)!, large = observations.get(4000)!.get(op)!
      // Each is actual production work, not an estimate from fixture size.
      expect(large.parsedAttemptRecords).toBeLessThanOrEqual(small.parsedAttemptRecords)
      expect(large.serializedAttemptRecords).toBeLessThanOrEqual(small.serializedAttemptRecords)
      expect(large.clonedAttemptRecords).toBeLessThanOrEqual(small.clonedAttemptRecords)
      expect(large.attemptKeyVisits).toBeLessThanOrEqual(small.attemptKeyVisits)
      expect(large.snapshotAttemptRecords).toBeLessThanOrEqual(small.snapshotAttemptRecords)
      expect(large.parseCalls).toBeLessThanOrEqual(small.parseCalls)
    })
  }
  for (const population of AUTHORITY_POPULATIONS) {
    test(`${population}: idle tick takes no whole-authority snapshot`, () => {
      expect(observations.get(population)!.get('idleTick')!.snapshotCalls).toBe(0)
      expect(observations.get(population)!.get('idleTick')!.wholeStateClones).toBe(0)
    })
    test(`${population}: ordered durable writes, full-reader restart, all historical outcomes and no external calls`, () => {
      expect(behavior.get(population)).toEqual({ restart: true, operations: [
        { op: 'assignment', result: { isError: false, synchronousWrites: 2 }, revisionDelta: 2,
          writerCalls: [{ authority: true, ok: true }, { authority: true, ok: true }],
          writes: [{ order: 1, measured: ['pending'] }, { order: 2, measured: ['applied'] }] },
        { op: 'writingTick', result: undefined, revisionDelta: 1, writes: [{ order: 1, measured: [] }], writerCalls: [{ authority: true, ok: true }] },
        { op: 'idleTick', result: undefined, revisionDelta: 0, writes: [], writerCalls: [] },
      ] })
    })
  }
})
