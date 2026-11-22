/** Red-first ordinary guard: observable work, independent of host timing. */
import { beforeAll, describe, expect, test } from 'bun:test'
import { assertNoLeak } from './test-helpers/credentials.ts'
import { AUTHORITY_FIXTURE_TIMEOUT_MS, AUTHORITY_POPULATIONS, makeAuthorityCostRig } from './test-helpers/authority-cost.ts'
import { MEMBERSHIP_OPERATIONS, countMembershipWork, prepareMembershipScan, verifyMembershipWrite,
  type MembershipOperation } from './test-helpers/authority-membership.ts'

describe('membership commits avoid whole-config work (b.o83 option C)', () => {
  const observations = new Map<number, Map<MembershipOperation, Awaited<ReturnType<typeof countMembershipWork>>>>()
  beforeAll(async () => {
    for (const population of AUTHORITY_POPULATIONS) {
      const rig = await makeAuthorityCostRig(population)
      const errors: unknown[] = []
      const listeners: Array<{ kind: string; revision: number; writes: number }> = []
      const record = (kind: string) => listeners.push({ kind, revision: rig.authority.revision, writes: rig.writes.length })
      const unsubscribe = [rig.authority.subscribeThreadView(() => record('thread')),
        rig.authority.subscribe(() => record('config')), rig.authority.subscribeChange(() => record('change'))]
      try {
        const scan = await prepareMembershipScan(rig), measures = new Map<MembershipOperation, Awaited<ReturnType<typeof countMembershipWork>>>()
        for (const op of MEMBERSHIP_OPERATIONS) {
          if (op === 'inventory') await scan.remaining()
          const before = rig.authority.snapshot(), revision = before.revision, cp = rig.run.checkpoint()
          listeners.length = 0
          try {
            const work = await countMembershipWork(rig, () => scan.operation(op))
            measures.set(op, work)
            console.log('AUTHORITY-MEMBERSHIP-WORK', JSON.stringify({ population, op, ...work }))
            verifyMembershipWrite(rig, revision, op, before, scan.channels)
            expect(rig.run.since(cp).writes.map(w => ({ authority: w.path === rig.h.paths.lastApplied, ok: w.ok })))
              .toEqual([{ authority: true, ok: true }])
            expect(listeners).toEqual(['thread', 'config', 'change'].map(kind => ({ kind,
              revision: revision + (op === 'page' ? 200 : 1), writes: 1 })))
            expect(rig.run.since(cp).lifecycle).toEqual([])
          } finally { await rig.collect(`population[${population}].${op}`) }
        }
        rig.restart()
        observations.set(population, measures)
      } catch (error) { errors.push(error); throw error }
      finally {
        try {
          unsubscribe.forEach(stop => stop())
          assertNoLeak(rig.captured({ errors, population }))
          expect(rig.leakFailures).toEqual([])
        } finally { await rig.close() }
      }
    }
  }, AUTHORITY_FIXTURE_TIMEOUT_MS)

  for (const op of MEMBERSHIP_OPERATIONS) {
    for (const population of AUTHORITY_POPULATIONS) {
      test(`${population} ${op}: zero full applied/source configuration parses`, () => {
        expect(observations.get(population)!.get(op)!.fullConfigParses).toBe(0)
      })
      test(`${population} ${op}: zero new UTF-8 encodings containing the complete unchanged sibling`, () => {
        expect(observations.get(population)!.get(op)!.siblingEncodes).toBe(0)
      })
      test(`${population} ${op}: no fresh full config freeze or encoding`, () => {
        const work = observations.get(population)!.get(op)!
        expect({ freeze: work.frozenConfigTrees, encode: work.serializedConfigTrees, visits: work.configVisits })
          .toEqual({ freeze: 0, encode: 0, visits: 0 })
      })
      test(`${population} ${op}: zero retained-attempt traversal, parsing, serialization or whole-state copies`, () => {
        const w = observations.get(population)!.get(op)!
        expect([w.parsedAttemptRecords, w.serializedAttemptRecords, w.clonedAttemptRecords, w.wholeStateClones,
          w.attemptKeyVisits, w.snapshotCalls, w.snapshotAttemptRecords]).toEqual([0, 0, 0, 0, 0, 0, 0])
      })
    }
    test(`${op}: actual UTF-8 encoding and visit counts are independent of 4,000 retained attempts`, () => {
      const small = observations.get(0)!.get(op)!, large = observations.get(4000)!.get(op)!
      expect({ bytes: large.encodedBytes, calls: large.encodeCalls, visits: large.configVisits, parses: large.parseCalls })
        .toEqual({ bytes: small.encodedBytes, calls: small.encodeCalls, visits: small.configVisits, parses: small.parseCalls })
    })
  }
})
