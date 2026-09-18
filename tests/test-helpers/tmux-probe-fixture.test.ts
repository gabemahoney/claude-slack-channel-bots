/**
 * tmux-probe-fixture.test.ts — Self-tests for the tmux-probe stub fixture.
 *
 * Verifies that:
 *   - makeStubTmuxProbe yields each of the three classifications with the
 *     correct TmuxProbeResult shape.
 *   - makeStubTmuxProbeQueue shifts FIFO and sticks on the last entry.
 *   - Probe call recording (session names in order) works for both factories.
 *   - kill-session call recording (session names in order) works for both.
 *   - No child_process / real tmux is involved.
 *
 * SPDX-License-Identifier: MIT
 */

import { describe, expect, test } from 'bun:test'
import {
  makeStubTmuxProbe,
  makeStubTmuxProbeQueue,
} from './tmux-probe-stub.ts'
import type { TmuxProbeResult } from '../../src/tmux-probe.ts'

// ---------------------------------------------------------------------------
// makeStubTmuxProbe — fixed response per classification
// ---------------------------------------------------------------------------

describe('makeStubTmuxProbe', () => {
  describe('definitely-dead classification', () => {
    test('probe resolves with definitely-dead classification and canonical signal', async () => {
      const { probe } = makeStubTmuxProbe('definitely-dead')
      const result = await probe('session-alpha')
      expect(result.classification).toBe('definitely-dead')
      expect(result.signal).toBe('exit-1-session-not-found')
    })

    test('probe resolves with explicitly supplied signal', async () => {
      const { probe } = makeStubTmuxProbe('definitely-dead', 'exit-1-no-server')
      const result = await probe('session-alpha')
      expect(result.classification).toBe('definitely-dead')
      expect(result.signal).toBe('exit-1-no-server')
    })
  })

  describe('definitely-alive classification', () => {
    test('probe resolves with definitely-alive classification and canonical signal', async () => {
      const { probe } = makeStubTmuxProbe('definitely-alive')
      const result = await probe('session-beta')
      expect(result.classification).toBe('definitely-alive')
      expect(result.signal).toBe('exit-0')
    })

    test('result conforms to TmuxProbeResult shape', async () => {
      const { probe } = makeStubTmuxProbe('definitely-alive')
      const result: TmuxProbeResult = await probe('session-beta')
      expect(typeof result.classification).toBe('string')
      expect(typeof result.signal).toBe('string')
    })
  })

  describe('transient-inconclusive classification', () => {
    test('probe resolves with transient-inconclusive classification and canonical signal', async () => {
      const { probe } = makeStubTmuxProbe('transient-inconclusive')
      const result = await probe('session-gamma')
      expect(result.classification).toBe('transient-inconclusive')
      expect(result.signal).toBe('exit-1-unparseable')
    })

    test('probe resolves with explicitly supplied transient signal', async () => {
      const { probe } = makeStubTmuxProbe('transient-inconclusive', 'timeout')
      const result = await probe('session-gamma')
      expect(result.classification).toBe('transient-inconclusive')
      expect(result.signal).toBe('timeout')
    })
  })

  describe('probe call recording', () => {
    test('records session names in order across multiple calls', async () => {
      const { probe, probeCalls } = makeStubTmuxProbe('definitely-alive')
      await probe('s1')
      await probe('s2')
      await probe('s3')
      expect(probeCalls).toEqual(['s1', 's2', 's3'])
    })

    test('probeCalls starts empty', () => {
      const { probeCalls } = makeStubTmuxProbe('definitely-dead')
      expect(probeCalls).toEqual([])
    })
  })

  describe('kill-session call recording', () => {
    test('records session names in order across multiple calls', async () => {
      const { killSession, killSessionCalls } = makeStubTmuxProbe('definitely-alive')
      await killSession('s-a')
      await killSession('s-b')
      expect(killSessionCalls).toEqual(['s-a', 's-b'])
    })

    test('killSessionCalls starts empty', () => {
      const { killSessionCalls } = makeStubTmuxProbe('definitely-dead')
      expect(killSessionCalls).toEqual([])
    })

    test('probe and kill-session recordings are independent arrays', async () => {
      const { probe, killSession, probeCalls, killSessionCalls } =
        makeStubTmuxProbe('definitely-alive')
      await probe('session-x')
      await killSession('session-y')
      expect(probeCalls).toEqual(['session-x'])
      expect(killSessionCalls).toEqual(['session-y'])
    })
  })

  describe('isolation between stub instances', () => {
    test('probeCalls arrays are independent between two stubs', async () => {
      const stubA = makeStubTmuxProbe('definitely-alive')
      const stubB = makeStubTmuxProbe('definitely-dead')
      await stubA.probe('shared-name')
      expect(stubA.probeCalls).toEqual(['shared-name'])
      expect(stubB.probeCalls).toEqual([])
    })
  })
})

// ---------------------------------------------------------------------------
// makeStubTmuxProbeQueue — FIFO with last-entry-sticks semantics
// ---------------------------------------------------------------------------

describe('makeStubTmuxProbeQueue', () => {
  describe('FIFO shift behaviour', () => {
    test('returns first entry on first call', async () => {
      const { probe } = makeStubTmuxProbeQueue([
        { classification: 'transient-inconclusive', signal: 'timeout' },
        { classification: 'definitely-alive', signal: 'exit-0' },
      ])
      const result = await probe('s1')
      expect(result.classification).toBe('transient-inconclusive')
      expect(result.signal).toBe('timeout')
    })

    test('returns second entry on second call', async () => {
      const { probe } = makeStubTmuxProbeQueue([
        { classification: 'transient-inconclusive', signal: 'timeout' },
        { classification: 'definitely-alive', signal: 'exit-0' },
      ])
      await probe('s1')
      const result = await probe('s2')
      expect(result.classification).toBe('definitely-alive')
      expect(result.signal).toBe('exit-0')
    })

    test('last entry sticks — repeated calls beyond queue length return the last entry', async () => {
      const { probe } = makeStubTmuxProbeQueue([
        { classification: 'transient-inconclusive', signal: 'timeout' },
        { classification: 'definitely-alive', signal: 'exit-0' },
      ])
      await probe('s1')  // shifts first entry
      await probe('s2')  // at tail — last entry
      const r3 = await probe('s3')  // sticks on last entry
      const r4 = await probe('s4')  // still sticks
      expect(r3.classification).toBe('definitely-alive')
      expect(r4.classification).toBe('definitely-alive')
    })

    test('single-entry queue sticks immediately on every call', async () => {
      const { probe } = makeStubTmuxProbeQueue([
        { classification: 'definitely-dead', signal: 'exit-1-session-not-found' },
      ])
      const r1 = await probe('s1')
      const r2 = await probe('s2')
      expect(r1.classification).toBe('definitely-dead')
      expect(r2.classification).toBe('definitely-dead')
    })

    test('three-item queue shifts all three then sticks on last', async () => {
      const { probe } = makeStubTmuxProbeQueue([
        { classification: 'transient-inconclusive', signal: 'spawn-enoent' },
        { classification: 'transient-inconclusive', signal: 'timeout' },
        { classification: 'definitely-alive', signal: 'exit-0' },
      ])
      const r1 = await probe('s1')
      const r2 = await probe('s2')
      const r3 = await probe('s3')  // reaches tail
      const r4 = await probe('s4')  // sticks on tail
      expect(r1.signal).toBe('spawn-enoent')
      expect(r2.signal).toBe('timeout')
      expect(r3.signal).toBe('exit-0')
      expect(r4.signal).toBe('exit-0')
    })
  })

  describe('probe call recording', () => {
    test('records all session names in order including repeated calls past queue end', async () => {
      const { probe, probeCalls } = makeStubTmuxProbeQueue([
        { classification: 'transient-inconclusive', signal: 'timeout' },
        { classification: 'definitely-alive', signal: 'exit-0' },
      ])
      await probe('s1')
      await probe('s2')
      await probe('s3')
      expect(probeCalls).toEqual(['s1', 's2', 's3'])
    })

    test('probeCalls starts empty', () => {
      const { probeCalls } = makeStubTmuxProbeQueue([
        { classification: 'definitely-alive', signal: 'exit-0' },
      ])
      expect(probeCalls).toEqual([])
    })
  })

  describe('kill-session call recording', () => {
    test('records kill-session session names in order', async () => {
      const { killSession, killSessionCalls } = makeStubTmuxProbeQueue([
        { classification: 'definitely-dead', signal: 'exit-1-session-not-found' },
      ])
      await killSession('dead-1')
      await killSession('dead-2')
      expect(killSessionCalls).toEqual(['dead-1', 'dead-2'])
    })

    test('probe and kill-session recordings are independent arrays', async () => {
      const { probe, killSession, probeCalls, killSessionCalls } = makeStubTmuxProbeQueue([
        { classification: 'definitely-alive', signal: 'exit-0' },
      ])
      await probe('p-session')
      await killSession('k-session')
      expect(probeCalls).toEqual(['p-session'])
      expect(killSessionCalls).toEqual(['k-session'])
    })

    test('interleaved probe and kill-session calls both record correctly', async () => {
      const { probe, killSession, probeCalls, killSessionCalls } = makeStubTmuxProbeQueue([
        { classification: 'definitely-dead', signal: 'exit-1-session-not-found' },
      ])
      await probe('session-1')
      await killSession('session-1')
      await probe('session-2')
      await killSession('session-2')
      expect(probeCalls).toEqual(['session-1', 'session-2'])
      expect(killSessionCalls).toEqual(['session-1', 'session-2'])
    })
  })

  describe('caller queue mutation isolation', () => {
    test('mutating the source array after construction does not affect the queue', async () => {
      const responses: TmuxProbeResult[] = [
        { classification: 'definitely-alive', signal: 'exit-0' },
      ]
      const { probe } = makeStubTmuxProbeQueue(responses)
      // Mutate the source array — the stub works on an internal copy.
      responses.push({ classification: 'definitely-dead', signal: 'exit-1-session-not-found' })
      const r1 = await probe('s1')
      const r2 = await probe('s2')  // last entry sticks (the original single entry)
      expect(r1.classification).toBe('definitely-alive')
      expect(r2.classification).toBe('definitely-alive')
    })
  })

  describe('empty queue throws', () => {
    test('throws a descriptive error when called with no responses', async () => {
      const { probe } = makeStubTmuxProbeQueue([])
      await expect(probe('s1')).rejects.toThrow('tmux-probe-stub: probe called but no responses configured')
    })
  })
})
