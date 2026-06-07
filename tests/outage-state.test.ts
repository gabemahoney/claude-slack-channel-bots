/**
 * outage-state.test.ts — SRD §Test plan cases 1-21.
 *
 * Cases 22-24 are deferred to Epics 7 and 8 — not implemented here.
 *
 * SPDX-License-Identifier: MIT
 */

import { describe, test, expect, beforeEach } from 'bun:test'
import type { Client } from 'agent-director'
import {
  ErrSystemInstallDisappeared,
  ErrTmuxNotAvailable,
  ErrCwdNotFound,
  ErrSpawnNotFound,
} from '../src/agent-director-errors.ts'
import {
  _resetOutageState,
  initOutageState,
  getOutageFlags,
  setOutageFlag,
  clearOutageFlag,
  resetAllToHealthy,
  withOutageDetection,
  withSpawnDetection,
  ALL_CLEAR_TEMPLATE,
  type ClassRecord,
  type OutageClass,
} from '../src/outage-state.ts'
import { makeStubClient } from './test-helpers/agent-director-stub.ts'

// ---------------------------------------------------------------------------
// Harness helpers
// ---------------------------------------------------------------------------

type Emission = { channelId: string; text: string }

/**
 * makeHarness — builds a fresh per-test emissions array + postToChannel capture.
 * Calls _resetOutageState() and initOutageState() so the module is ready.
 */
function makeHarness(overridePost?: (channelId: string, text: string) => void): {
  emissions: Emission[]
} {
  const emissions: Emission[] = []
  _resetOutageState()
  initOutageState({
    postToChannel: overridePost ?? ((channelId, text) => { emissions.push({ channelId, text }) }),
    getClient: () => makeStubClient() as unknown as Client,
  })
  return { emissions }
}

// ---------------------------------------------------------------------------
// beforeEach — belt-and-suspenders reset (makeHarness also resets)
// ---------------------------------------------------------------------------

beforeEach(() => {
  _resetOutageState()
})

// ---------------------------------------------------------------------------
// Cases 1-9 — single-flag lifecycle
// ---------------------------------------------------------------------------

describe('cases 1-9: single-flag lifecycle', () => {

  test('1. fresh setOutageFlag ad-unreachable → one onset, flag set contains ad-unreachable', () => {
    const { emissions } = makeHarness()
    setOutageFlag('C1', 'ad-unreachable', '/bin/agent-director')
    expect(emissions).toHaveLength(1)
    expect(emissions[0].channelId).toBe('C1')
    expect(emissions[0].text).toMatch(/agent-director unreachable/)
    expect(getOutageFlags('C1').has('ad-unreachable')).toBe(true)
    expect(getOutageFlags('C1').size).toBe(1)
  })

  test('2. repeated setOutageFlag → no second emission, flag set unchanged', () => {
    const { emissions } = makeHarness()
    setOutageFlag('C1', 'ad-unreachable', '/bin/agent-director')
    setOutageFlag('C1', 'ad-unreachable', '/bin/agent-director')
    expect(emissions).toHaveLength(1)
    expect(getOutageFlags('C1').size).toBe(1)
  })

  test('3. setOutageFlag cwd-unreachable /foo → one cwd-onset containing /foo', () => {
    const { emissions } = makeHarness()
    setOutageFlag('C1', 'cwd-unreachable', '/foo')
    expect(emissions).toHaveLength(1)
    expect(emissions[0].text).toContain('/foo')
    expect(emissions[0].text).toMatch(/Route cwd unreachable/)
    expect(getOutageFlags('C1').has('cwd-unreachable')).toBe(true)
  })

  test('4. setOutageFlag ad then cwd → exactly two onsets, one per class', () => {
    const { emissions } = makeHarness()
    setOutageFlag('C1', 'ad-unreachable', '/bin/ad')
    setOutageFlag('C1', 'cwd-unreachable', '/foo')
    expect(emissions).toHaveLength(2)
    expect(emissions[0].text).toMatch(/agent-director unreachable/)
    expect(emissions[1].text).toMatch(/Route cwd unreachable/)
    expect(getOutageFlags('C1').has('ad-unreachable')).toBe(true)
    expect(getOutageFlags('C1').has('cwd-unreachable')).toBe(true)
  })

  test('5. clearOutageFlag ad with only ad set → one all-clear naming ad-unreachable + detail; flags empty', () => {
    const { emissions } = makeHarness()
    setOutageFlag('C1', 'ad-unreachable', '/bin/agent-director')
    // clear the onset emission; track only the all-clear
    const before = emissions.length
    clearOutageFlag('C1', 'ad-unreachable')
    const newEmissions = emissions.slice(before)
    expect(newEmissions).toHaveLength(1)
    expect(newEmissions[0].text).toMatch(/All clear/)
    expect(newEmissions[0].text).toContain('ad-unreachable')
    expect(newEmissions[0].text).toContain('/bin/agent-director')
    expect(getOutageFlags('C1').size).toBe(0)
  })

  test('6. clearOutageFlag ad with both ad+cwd set → silent; flags = {cwd-unreachable}', () => {
    const { emissions } = makeHarness()
    setOutageFlag('C1', 'ad-unreachable', '/bin/ad')
    setOutageFlag('C1', 'cwd-unreachable', '/foo')
    const before = emissions.length
    clearOutageFlag('C1', 'ad-unreachable')
    expect(emissions.length).toBe(before) // no new emission
    expect(getOutageFlags('C1').has('ad-unreachable')).toBe(false)
    expect(getOutageFlags('C1').has('cwd-unreachable')).toBe(true)
    expect(getOutageFlags('C1').size).toBe(1)
  })

  test('7. clearOutageFlag cwd after case-6 state → all-clear naming BOTH classes; flags empty', () => {
    const { emissions } = makeHarness()
    // Replicate case-6 state
    setOutageFlag('C1', 'ad-unreachable', '/bin/ad')
    setOutageFlag('C1', 'cwd-unreachable', '/foo')
    clearOutageFlag('C1', 'ad-unreachable') // silent
    const before = emissions.length
    clearOutageFlag('C1', 'cwd-unreachable')
    const newEmissions = emissions.slice(before)
    expect(newEmissions).toHaveLength(1)
    expect(newEmissions[0].text).toMatch(/All clear/)
    expect(newEmissions[0].text).toContain('ad-unreachable')
    expect(newEmissions[0].text).toContain('cwd-unreachable')
    expect(getOutageFlags('C1').size).toBe(0)
  })

  test('8. clearOutageFlag cwd with only cwd set → immediate all-clear', () => {
    const { emissions } = makeHarness()
    setOutageFlag('C1', 'cwd-unreachable', '/foo')
    const before = emissions.length
    clearOutageFlag('C1', 'cwd-unreachable')
    const newEmissions = emissions.slice(before)
    expect(newEmissions).toHaveLength(1)
    expect(newEmissions[0].text).toMatch(/All clear/)
    expect(newEmissions[0].text).toContain('cwd-unreachable')
    expect(getOutageFlags('C1').size).toBe(0)
  })

  test('9. clearOutageFlag for never-set flag → silent no-op', () => {
    const { emissions } = makeHarness()
    clearOutageFlag('C1', 'ad-unreachable')
    expect(emissions).toHaveLength(0)
    expect(getOutageFlags('C1').size).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// Cases 10-14 — bad-stretch history, reset, template, post-failure
// ---------------------------------------------------------------------------

describe('cases 10-14: bad-stretch history, reset, template, post-failure', () => {

  test('10. intra-stretch flap: raise ad → raise cwd → clear ad (silent) → raise ad again → clear cwd (silent) → clear ad → all-clear names ad-unreachable once, no timestamp', () => {
    const { emissions } = makeHarness()
    setOutageFlag('C1', 'ad-unreachable', '/bin/ad')  // onset ad
    setOutageFlag('C1', 'cwd-unreachable', '/foo')     // onset cwd
    clearOutageFlag('C1', 'ad-unreachable')             // silent (cwd still set)
    setOutageFlag('C1', 'ad-unreachable', '/bin/ad')   // onset ad again
    clearOutageFlag('C1', 'cwd-unreachable')            // silent (ad still set)
    const before = emissions.length
    clearOutageFlag('C1', 'ad-unreachable')             // all-clear
    const newEmissions = emissions.slice(before)
    expect(newEmissions).toHaveLength(1)
    const msg = newEmissions[0].text
    expect(msg).toMatch(/All clear/)
    expect(msg).toContain('ad-unreachable')
    // SRD case 10 — no timestamp text
    expect(msg).not.toMatch(/\dT\d/)
  })

  test('11. resetAllToHealthy → silent; subsequent setOutageFlag re-emits fresh onset', () => {
    const { emissions } = makeHarness()
    setOutageFlag('C1', 'ad-unreachable', '/bin/ad')
    setOutageFlag('C2', 'ad-unreachable', '/bin/ad')
    const before = emissions.length
    resetAllToHealthy(['C1', 'C2'])
    expect(emissions.length).toBe(before) // silent — no all-clear
    expect(getOutageFlags('C1').size).toBe(0)
    expect(getOutageFlags('C2').size).toBe(0)
    // Post-reset, a fresh onset MUST emit (not deduped)
    setOutageFlag('C1', 'ad-unreachable', '/bin/ad')
    expect(emissions.length).toBe(before + 1)
    expect(emissions[before].text).toMatch(/agent-director unreachable/)
  })

  test('12. postToChannel synchronous failure propagates; state mutation already applied', () => {
    let throwNext = false
    const emissions: Emission[] = []
    _resetOutageState()
    initOutageState({
      postToChannel: (channelId, text) => {
        if (throwNext) throw new Error('slack-post-failed')
        emissions.push({ channelId, text })
      },
      getClient: () => makeStubClient() as unknown as Client,
    })
    throwNext = true
    expect(() => setOutageFlag('C1', 'ad-unreachable', '/bin/ad')).toThrow('slack-post-failed')
    // State mutation happened before the emit, so re-call is deduped (silent)
    throwNext = false
    setOutageFlag('C1', 'ad-unreachable', '/bin/ad')
    expect(emissions).toHaveLength(0) // dedupe — no new emission
    expect(getOutageFlags('C1').has('ad-unreachable')).toBe(true)
  })

  test('13. ALL_CLEAR_TEMPLATE renders both classes in stable order; no ISO-8601 substring', () => {
    const history = new Map<OutageClass, ClassRecord>([
      ['ad-unreachable', { detail: '/bin/x' }],
      ['cwd-unreachable', { detail: '/foo' }],
    ])
    const msg = ALL_CLEAR_TEMPLATE(history)
    expect(msg).toMatch(/All clear/)
    expect(msg).toContain('ad-unreachable')
    expect(msg).toContain('/bin/x')
    expect(msg).toContain('cwd-unreachable')
    expect(msg).toContain('/foo')
    // Stable order: ad-unreachable appears before cwd-unreachable
    expect(msg.indexOf('ad-unreachable')).toBeLessThan(msg.indexOf('cwd-unreachable'))
    // No ISO-8601 timestamp
    expect(msg).not.toMatch(/\dT\d/)
    // Compile-time test: ClassRecord has no enteredAtIso field
    const rec: ClassRecord = { detail: '/bin/x' }
    // @ts-expect-error — enteredAtIso does not exist on ClassRecord
    void rec.enteredAtIso
  })

  test('14. startup bounded pair: onset then immediate clear → 2 emissions; correct content + channelId', () => {
    const { emissions } = makeHarness()
    setOutageFlag('C1', 'cwd-unreachable', '/foo')
    clearOutageFlag('C1', 'cwd-unreachable')
    expect(emissions).toHaveLength(2)
    expect(emissions[0].channelId).toBe('C1')
    expect(emissions[0].text).toMatch(/Route cwd unreachable/)
    expect(emissions[1].channelId).toBe('C1')
    expect(emissions[1].text).toMatch(/All clear.*cwd-unreachable/)
  })
})

// ---------------------------------------------------------------------------
// Cases 15-19 — wrapper error + success paths
// ---------------------------------------------------------------------------

describe('cases 15-19: withOutageDetection and withSpawnDetection', () => {

  test('15a. withOutageDetection ErrSystemInstallDisappeared → ad-unreachable raised with binaryPath; error rethrows', async () => {
    const { emissions } = makeHarness()
    const err = new ErrSystemInstallDisappeared('spawn', '/bin/ad')
    await expect(
      withOutageDetection('C1', '/cwd', async (_client) => { throw err })
    ).rejects.toBeInstanceOf(ErrSystemInstallDisappeared)
    expect(getOutageFlags('C1').has('ad-unreachable')).toBe(true)
    expect(emissions).toHaveLength(1)
    expect(emissions[0].text).toContain('/bin/ad')
  })

  test('15b. withOutageDetection ErrCwdNotFound + routeCwd → cwd-unreachable raised; error rethrows', async () => {
    const { emissions } = makeHarness()
    const err = new ErrCwdNotFound('spawn', 'ErrCwdNotFound', 'cwd not found')
    await expect(
      withOutageDetection('C1', '/foo', async (_client) => { throw err })
    ).rejects.toBeInstanceOf(ErrCwdNotFound)
    expect(getOutageFlags('C1').has('cwd-unreachable')).toBe(true)
    expect(emissions).toHaveLength(1)
    expect(emissions[0].text).toContain('/foo')
  })

  test('15c. withOutageDetection unrelated error (ErrSpawnNotFound) → no flag change; error rethrows', async () => {
    const { emissions } = makeHarness()
    const err = new ErrSpawnNotFound('get', 'ErrSpawnNotFound', 'not found')
    await expect(
      withOutageDetection('C1', '/cwd', async (_client) => { throw err })
    ).rejects.toBeInstanceOf(ErrSpawnNotFound)
    expect(getOutageFlags('C1').size).toBe(0)
    expect(emissions).toHaveLength(0)
  })

  test('16a. withOutageDetection success: clears ad+tmux → all-clear emits naming both', async () => {
    const { emissions } = makeHarness()
    setOutageFlag('C1', 'ad-unreachable', '/bin/ad')
    setOutageFlag('C1', 'tmux-unavailable')
    const before = emissions.length
    await withOutageDetection('C1', '/cwd', async (_client) => 'ok')
    const newEmissions = emissions.slice(before)
    expect(newEmissions).toHaveLength(1)
    expect(newEmissions[0].text).toMatch(/All clear/)
    expect(newEmissions[0].text).toContain('ad-unreachable')
    expect(newEmissions[0].text).toContain('tmux-unavailable')
    expect(getOutageFlags('C1').size).toBe(0)
  })

  test('16b. withOutageDetection success with cwd also set: ad+tmux clear is silent; cwd-unreachable remains', async () => {
    const { emissions } = makeHarness()
    setOutageFlag('C1', 'ad-unreachable', '/bin/ad')
    setOutageFlag('C1', 'tmux-unavailable')
    setOutageFlag('C1', 'cwd-unreachable', '/foo')
    const before = emissions.length
    await withOutageDetection('C1', '/cwd', async (_client) => 'ok')
    expect(emissions.length).toBe(before) // silent — cwd still set
    expect(getOutageFlags('C1').has('cwd-unreachable')).toBe(true)
    expect(getOutageFlags('C1').has('ad-unreachable')).toBe(false)
    expect(getOutageFlags('C1').has('tmux-unavailable')).toBe(false)
  })

  test('17. withOutageDetection success: cwd-unreachable NOT cleared by non-spawn verb', async () => {
    const { emissions } = makeHarness()
    setOutageFlag('C1', 'cwd-unreachable', '/foo')
    const before = emissions.length
    await withOutageDetection('C1', '/cwd', async (_client) => 'ok')
    expect(emissions.length).toBe(before) // silent (only cwd, so clear of ad+tmux is a no-op)
    expect(getOutageFlags('C1').has('cwd-unreachable')).toBe(true)
  })

  test('18. withSpawnDetection success: clears cwd+ad+tmux; all-clear names all three', async () => {
    const { emissions } = makeHarness()
    setOutageFlag('C1', 'ad-unreachable', '/bin/ad')
    setOutageFlag('C1', 'tmux-unavailable')
    setOutageFlag('C1', 'cwd-unreachable', '/foo')
    const before = emissions.length
    await withSpawnDetection('C1', '/foo', async (_client) => 'ok')
    const newEmissions = emissions.slice(before)
    expect(newEmissions).toHaveLength(1)
    expect(newEmissions[0].text).toMatch(/All clear/)
    expect(newEmissions[0].text).toContain('ad-unreachable')
    expect(newEmissions[0].text).toContain('tmux-unavailable')
    expect(newEmissions[0].text).toContain('cwd-unreachable')
    expect(getOutageFlags('C1').size).toBe(0)
  })

  test('19. withSpawnDetection ErrCwdNotFound: cwd-unreachable raised; ad/tmux NOT cleared; error rethrows', async () => {
    const { emissions } = makeHarness()
    setOutageFlag('C1', 'ad-unreachable', '/bin/ad')
    setOutageFlag('C1', 'tmux-unavailable')
    const before = emissions.length
    const err = new ErrCwdNotFound('spawn', 'ErrCwdNotFound', 'cwd not found')
    await expect(
      withSpawnDetection('C1', '/foo', async (_client) => { throw err })
    ).rejects.toBeInstanceOf(ErrCwdNotFound)
    expect(getOutageFlags('C1').has('cwd-unreachable')).toBe(true)
    expect(getOutageFlags('C1').has('ad-unreachable')).toBe(true)
    expect(getOutageFlags('C1').has('tmux-unavailable')).toBe(true)
    // Only the cwd onset emitted; ad+tmux not cleared
    const newEmissions = emissions.slice(before)
    expect(newEmissions).toHaveLength(1)
    expect(newEmissions[0].text).toMatch(/Route cwd unreachable/)
  })
})

// ---------------------------------------------------------------------------
// Cases 20-21 — flap cycles + never-set no-op
// ---------------------------------------------------------------------------

describe('cases 20-21: flap cycles and never-set no-op', () => {

  test('20. AD flap: throw → succeed → throw → succeed → exactly 4 emissions onset/all-clear/onset/all-clear', async () => {
    const { emissions } = makeHarness()
    const err = new ErrSystemInstallDisappeared('spawn', '/bin/ad')

    // Throw 1 → onset
    await expect(
      withOutageDetection('C1', '/cwd', async (_client) => { throw err })
    ).rejects.toBeInstanceOf(ErrSystemInstallDisappeared)

    // Succeed 1 → all-clear
    await withOutageDetection('C1', '/cwd', async (_client) => 'ok')

    // Throw 2 → onset
    await expect(
      withOutageDetection('C1', '/cwd', async (_client) => { throw err })
    ).rejects.toBeInstanceOf(ErrSystemInstallDisappeared)

    // Succeed 2 → all-clear
    await withOutageDetection('C1', '/cwd', async (_client) => 'ok')

    expect(emissions).toHaveLength(4)
    expect(emissions[0].text).toMatch(/agent-director unreachable/)  // onset 1
    expect(emissions[1].text).toMatch(/All clear/)                   // all-clear 1
    expect(emissions[2].text).toMatch(/agent-director unreachable/)  // onset 2
    expect(emissions[3].text).toMatch(/All clear/)                   // all-clear 2
  })

  test('21. clearOutageFlag on never-touched channel → silent; getOutageFlags returns empty set', () => {
    makeHarness()
    clearOutageFlag('C9', 'ad-unreachable')
    expect(getOutageFlags('C9').size).toBe(0)
    // Confirm C9 is isolated — activity on another channel doesn't bleed in
    setOutageFlag('C1', 'ad-unreachable', '/bin/ad')
    expect(getOutageFlags('C9').size).toBe(0)
  })
})
