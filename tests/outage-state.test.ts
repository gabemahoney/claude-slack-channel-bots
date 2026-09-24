/**
 * outage-state.test.ts — SRD §Test plan cases 1-24, plus the
 * tests/getclient-allowlist.txt static audit (case 22) and the
 * resetAllToHealthy single-call-site audit (case 23 Part A).
 *
 * SPDX-License-Identifier: MIT
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
  ONSET_TEMPLATES,
  type ClassRecord,
  type OutageClass,
} from '../src/outage-state.ts'
import { renderPersonaRef } from '../src/persona-identity.ts'
import { makeStubClient } from './test-helpers/agent-director-stub.ts'
import { makeMultiPersonaConfig } from './test-helpers/persona-config.ts'
import type { StubSlack } from './test-helpers/slack-stub.ts'
import { makeNotifierHarness } from './test-helpers/persona-notifier.ts'
import {
  auditGetClientAllowlist,
  enclosingScope,
  scanFile,
} from './getclient-allowlist-audit.ts'

// ---------------------------------------------------------------------------
// Harness helpers
// ---------------------------------------------------------------------------

/** One captured `notify` call: the persona key and the notice body. */
type Emission = { key: string; text: string }

/**
 * Persona keys. Outage state is keyed by persona key (b.av2 SR-6.3); it never
 * resolves a key, so plain in-form keys stand in for applied personas.
 */
const P1 = 'persona_one'
const P2 = 'persona_two'
const P9 = 'persona_nine'

/**
 * makeHarness — builds a fresh per-test emissions array + `notify` capture.
 * Calls _resetOutageState() and initOutageState() so the module is ready.
 */
function makeHarness(overrideNotify?: (key: string, text: string) => void): {
  emissions: Emission[]
} {
  const emissions: Emission[] = []
  _resetOutageState()
  initOutageState({
    notify: overrideNotify ?? ((key, text) => { emissions.push({ key, text }) }),
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
    setOutageFlag(P1, 'ad-unreachable', '/bin/agent-director')
    expect(emissions).toHaveLength(1)
    expect(emissions[0].key).toBe(P1)
    expect(emissions[0].text).toMatch(/agent-director unreachable/)
    expect(getOutageFlags(P1).has('ad-unreachable')).toBe(true)
    expect(getOutageFlags(P1).size).toBe(1)
  })

  test('2. repeated setOutageFlag → no second emission, flag set unchanged', () => {
    const { emissions } = makeHarness()
    setOutageFlag(P1, 'ad-unreachable', '/bin/agent-director')
    setOutageFlag(P1, 'ad-unreachable', '/bin/agent-director')
    expect(emissions).toHaveLength(1)
    expect(getOutageFlags(P1).size).toBe(1)
  })

  test('3. setOutageFlag cwd-unreachable /foo → one cwd-onset containing /foo', () => {
    const { emissions } = makeHarness()
    setOutageFlag(P1, 'cwd-unreachable', '/foo')
    expect(emissions).toHaveLength(1)
    expect(emissions[0].text).toContain('/foo')
    expect(emissions[0].text).toMatch(/Working directory unreachable/)
    expect(getOutageFlags(P1).has('cwd-unreachable')).toBe(true)
  })

  test('4. setOutageFlag ad then cwd → exactly two onsets, one per class', () => {
    const { emissions } = makeHarness()
    setOutageFlag(P1, 'ad-unreachable', '/bin/ad')
    setOutageFlag(P1, 'cwd-unreachable', '/foo')
    expect(emissions).toHaveLength(2)
    expect(emissions[0].text).toMatch(/agent-director unreachable/)
    expect(emissions[1].text).toMatch(/Working directory unreachable/)
    expect(getOutageFlags(P1).has('ad-unreachable')).toBe(true)
    expect(getOutageFlags(P1).has('cwd-unreachable')).toBe(true)
  })

  test('5. clearOutageFlag ad with only ad set → one all-clear naming ad-unreachable + detail; flags empty', () => {
    const { emissions } = makeHarness()
    setOutageFlag(P1, 'ad-unreachable', '/bin/agent-director')
    // clear the onset emission; track only the all-clear
    const before = emissions.length
    clearOutageFlag(P1, 'ad-unreachable')
    const newEmissions = emissions.slice(before)
    expect(newEmissions).toHaveLength(1)
    expect(newEmissions[0].text).toMatch(/All clear/)
    expect(newEmissions[0].text).toContain('ad-unreachable')
    expect(newEmissions[0].text).toContain('/bin/agent-director')
    expect(getOutageFlags(P1).size).toBe(0)
  })

  test('6. clearOutageFlag ad with both ad+cwd set → silent; flags = {cwd-unreachable}', () => {
    const { emissions } = makeHarness()
    setOutageFlag(P1, 'ad-unreachable', '/bin/ad')
    setOutageFlag(P1, 'cwd-unreachable', '/foo')
    const before = emissions.length
    clearOutageFlag(P1, 'ad-unreachable')
    expect(emissions.length).toBe(before) // no new emission
    expect(getOutageFlags(P1).has('ad-unreachable')).toBe(false)
    expect(getOutageFlags(P1).has('cwd-unreachable')).toBe(true)
    expect(getOutageFlags(P1).size).toBe(1)
  })

  test('7. clearOutageFlag cwd after case-6 state → all-clear naming BOTH classes; flags empty', () => {
    const { emissions } = makeHarness()
    // Replicate case-6 state
    setOutageFlag(P1, 'ad-unreachable', '/bin/ad')
    setOutageFlag(P1, 'cwd-unreachable', '/foo')
    clearOutageFlag(P1, 'ad-unreachable') // silent
    const before = emissions.length
    clearOutageFlag(P1, 'cwd-unreachable')
    const newEmissions = emissions.slice(before)
    expect(newEmissions).toHaveLength(1)
    expect(newEmissions[0].text).toMatch(/All clear/)
    expect(newEmissions[0].text).toContain('ad-unreachable')
    expect(newEmissions[0].text).toContain('cwd-unreachable')
    expect(getOutageFlags(P1).size).toBe(0)
  })

  test('8. clearOutageFlag cwd with only cwd set → immediate all-clear', () => {
    const { emissions } = makeHarness()
    setOutageFlag(P1, 'cwd-unreachable', '/foo')
    const before = emissions.length
    clearOutageFlag(P1, 'cwd-unreachable')
    const newEmissions = emissions.slice(before)
    expect(newEmissions).toHaveLength(1)
    expect(newEmissions[0].text).toMatch(/All clear/)
    expect(newEmissions[0].text).toContain('cwd-unreachable')
    expect(getOutageFlags(P1).size).toBe(0)
  })

  test('9. clearOutageFlag for never-set flag → silent no-op', () => {
    const { emissions } = makeHarness()
    clearOutageFlag(P1, 'ad-unreachable')
    expect(emissions).toHaveLength(0)
    expect(getOutageFlags(P1).size).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// Cases 10-14 — bad-stretch history, reset, template, post-failure,
//               startup bounded pair (case 14)
// ---------------------------------------------------------------------------

describe('cases 10-14: bad-stretch history, reset, template, post-failure, startup pair', () => {

  test('10. intra-stretch flap: raise ad → raise cwd → clear ad (silent) → raise ad again → clear cwd (silent) → clear ad → all-clear names ad-unreachable once, no timestamp', () => {
    const { emissions } = makeHarness()
    setOutageFlag(P1, 'ad-unreachable', '/bin/ad')  // onset ad
    setOutageFlag(P1, 'cwd-unreachable', '/foo')     // onset cwd
    clearOutageFlag(P1, 'ad-unreachable')             // silent (cwd still set)
    setOutageFlag(P1, 'ad-unreachable', '/bin/ad')   // onset ad again
    clearOutageFlag(P1, 'cwd-unreachable')            // silent (ad still set)
    const before = emissions.length
    clearOutageFlag(P1, 'ad-unreachable')             // all-clear
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
    setOutageFlag(P1, 'ad-unreachable', '/bin/ad')
    setOutageFlag(P2, 'ad-unreachable', '/bin/ad')
    const before = emissions.length
    resetAllToHealthy([P1, P2])
    expect(emissions.length).toBe(before) // silent — no all-clear
    expect(getOutageFlags(P1).size).toBe(0)
    expect(getOutageFlags(P2).size).toBe(0)
    // Post-reset, a fresh onset MUST emit (not deduped)
    setOutageFlag(P1, 'ad-unreachable', '/bin/ad')
    expect(emissions.length).toBe(before + 1)
    expect(emissions[before].text).toMatch(/agent-director unreachable/)
  })

  test('12. notify synchronous failure propagates; state mutation already applied', () => {
    let throwNext = false
    const emissions: Emission[] = []
    _resetOutageState()
    initOutageState({
      notify: (key, text) => {
        if (throwNext) throw new Error('slack-post-failed')
        emissions.push({ key, text })
      },
      getClient: () => makeStubClient() as unknown as Client,
    })
    throwNext = true
    expect(() => setOutageFlag(P1, 'ad-unreachable', '/bin/ad')).toThrow('slack-post-failed')
    // State mutation happened before the emit, so re-call is deduped (silent)
    throwNext = false
    setOutageFlag(P1, 'ad-unreachable', '/bin/ad')
    expect(emissions).toHaveLength(0) // dedupe — no new emission
    expect(getOutageFlags(P1).has('ad-unreachable')).toBe(true)
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

  test('14. startup bounded pair: onset then immediate clear → 2 emissions; correct content + persona key', () => {
    const { emissions } = makeHarness()
    setOutageFlag(P1, 'cwd-unreachable', '/foo')
    clearOutageFlag(P1, 'cwd-unreachable')
    expect(emissions).toHaveLength(2)
    expect(emissions[0].key).toBe(P1)
    expect(emissions[0].text).toMatch(/Working directory unreachable/)
    expect(emissions[1].key).toBe(P1)
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
      withOutageDetection(P1, '/cwd', async (_client) => { throw err })
    ).rejects.toBeInstanceOf(ErrSystemInstallDisappeared)
    expect(getOutageFlags(P1).has('ad-unreachable')).toBe(true)
    expect(emissions).toHaveLength(1)
    expect(emissions[0].text).toContain('/bin/ad')
  })

  test('15b. withOutageDetection ErrCwdNotFound + workingDirectory → cwd-unreachable raised; error rethrows', async () => {
    const { emissions } = makeHarness()
    const err = new ErrCwdNotFound('spawn', 'ErrCwdNotFound', 'cwd not found')
    await expect(
      withOutageDetection(P1, '/foo', async (_client) => { throw err })
    ).rejects.toBeInstanceOf(ErrCwdNotFound)
    expect(getOutageFlags(P1).has('cwd-unreachable')).toBe(true)
    expect(emissions).toHaveLength(1)
    expect(emissions[0].text).toContain('/foo')
  })

  test('15c. withOutageDetection unrelated error (ErrSpawnNotFound) → no flag change; error rethrows', async () => {
    const { emissions } = makeHarness()
    const err = new ErrSpawnNotFound('get', 'ErrSpawnNotFound', 'not found')
    await expect(
      withOutageDetection(P1, '/cwd', async (_client) => { throw err })
    ).rejects.toBeInstanceOf(ErrSpawnNotFound)
    expect(getOutageFlags(P1).size).toBe(0)
    expect(emissions).toHaveLength(0)
  })

  test('16a. withOutageDetection success: clears ad+tmux → all-clear emits naming both', async () => {
    const { emissions } = makeHarness()
    setOutageFlag(P1, 'ad-unreachable', '/bin/ad')
    setOutageFlag(P1, 'tmux-unavailable')
    const before = emissions.length
    await withOutageDetection(P1, '/cwd', async (_client) => 'ok')
    const newEmissions = emissions.slice(before)
    expect(newEmissions).toHaveLength(1)
    expect(newEmissions[0].text).toMatch(/All clear/)
    expect(newEmissions[0].text).toContain('ad-unreachable')
    expect(newEmissions[0].text).toContain('tmux-unavailable')
    expect(getOutageFlags(P1).size).toBe(0)
  })

  test('16b. withOutageDetection success with cwd also set: ad+tmux clear is silent; cwd-unreachable remains', async () => {
    const { emissions } = makeHarness()
    setOutageFlag(P1, 'ad-unreachable', '/bin/ad')
    setOutageFlag(P1, 'tmux-unavailable')
    setOutageFlag(P1, 'cwd-unreachable', '/foo')
    const before = emissions.length
    await withOutageDetection(P1, '/cwd', async (_client) => 'ok')
    expect(emissions.length).toBe(before) // silent — cwd still set
    expect(getOutageFlags(P1).has('cwd-unreachable')).toBe(true)
    expect(getOutageFlags(P1).has('ad-unreachable')).toBe(false)
    expect(getOutageFlags(P1).has('tmux-unavailable')).toBe(false)
  })

  test('17. withOutageDetection success: cwd-unreachable NOT cleared by non-spawn verb', async () => {
    const { emissions } = makeHarness()
    setOutageFlag(P1, 'cwd-unreachable', '/foo')
    const before = emissions.length
    await withOutageDetection(P1, '/cwd', async (_client) => 'ok')
    expect(emissions.length).toBe(before) // silent (only cwd, so clear of ad+tmux is a no-op)
    expect(getOutageFlags(P1).has('cwd-unreachable')).toBe(true)
  })

  test('18. withSpawnDetection success: clears cwd+ad+tmux; all-clear names all three', async () => {
    const { emissions } = makeHarness()
    setOutageFlag(P1, 'ad-unreachable', '/bin/ad')
    setOutageFlag(P1, 'tmux-unavailable')
    setOutageFlag(P1, 'cwd-unreachable', '/foo')
    const before = emissions.length
    await withSpawnDetection(P1, '/foo', async (_client) => 'ok')
    const newEmissions = emissions.slice(before)
    expect(newEmissions).toHaveLength(1)
    expect(newEmissions[0].text).toMatch(/All clear/)
    expect(newEmissions[0].text).toContain('ad-unreachable')
    expect(newEmissions[0].text).toContain('tmux-unavailable')
    expect(newEmissions[0].text).toContain('cwd-unreachable')
    expect(getOutageFlags(P1).size).toBe(0)
  })

  test('19. withSpawnDetection ErrCwdNotFound: cwd-unreachable raised; ad/tmux NOT cleared; error rethrows', async () => {
    const { emissions } = makeHarness()
    setOutageFlag(P1, 'ad-unreachable', '/bin/ad')
    setOutageFlag(P1, 'tmux-unavailable')
    const before = emissions.length
    const err = new ErrCwdNotFound('spawn', 'ErrCwdNotFound', 'cwd not found')
    await expect(
      withSpawnDetection(P1, '/foo', async (_client) => { throw err })
    ).rejects.toBeInstanceOf(ErrCwdNotFound)
    expect(getOutageFlags(P1).has('cwd-unreachable')).toBe(true)
    expect(getOutageFlags(P1).has('ad-unreachable')).toBe(true)
    expect(getOutageFlags(P1).has('tmux-unavailable')).toBe(true)
    // Only the cwd onset emitted; ad+tmux not cleared
    const newEmissions = emissions.slice(before)
    expect(newEmissions).toHaveLength(1)
    expect(newEmissions[0].text).toMatch(/Working directory unreachable/)
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
      withOutageDetection(P1, '/cwd', async (_client) => { throw err })
    ).rejects.toBeInstanceOf(ErrSystemInstallDisappeared)

    // Succeed 1 → all-clear
    await withOutageDetection(P1, '/cwd', async (_client) => 'ok')

    // Throw 2 → onset
    await expect(
      withOutageDetection(P1, '/cwd', async (_client) => { throw err })
    ).rejects.toBeInstanceOf(ErrSystemInstallDisappeared)

    // Succeed 2 → all-clear
    await withOutageDetection(P1, '/cwd', async (_client) => 'ok')

    expect(emissions).toHaveLength(4)
    expect(emissions[0].text).toMatch(/agent-director unreachable/)  // onset 1
    expect(emissions[1].text).toMatch(/All clear/)                   // all-clear 1
    expect(emissions[2].text).toMatch(/agent-director unreachable/)  // onset 2
    expect(emissions[3].text).toMatch(/All clear/)                   // all-clear 2
  })

  test('21. clearOutageFlag on never-touched persona → silent; getOutageFlags returns empty set', () => {
    makeHarness()
    clearOutageFlag(P9, 'ad-unreachable')
    expect(getOutageFlags(P9).size).toBe(0)
    // Confirm P9 is isolated — activity on another persona doesn't bleed in
    setOutageFlag(P1, 'ad-unreachable', '/bin/ad')
    expect(getOutageFlags(P9).size).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// Persona keying — notice wording, per-persona isolation, and the AC 25
// destination leg through the real per-persona notifier (b.av2 SR-6.3, SR-7.2)
// ---------------------------------------------------------------------------

describe('persona-keyed notices', () => {
  const ALL_CLASSES: OutageClass[] = ['ad-unreachable', 'tmux-unavailable', 'cwd-unreachable']

  test('onset and all-clear texts name no route or channel and carry no persona reference (the notifier adds it)', () => {
    const texts = [
      ...ALL_CLASSES.map((cls) => ONSET_TEMPLATES[cls]('/some/detail')),
      ALL_CLEAR_TEMPLATE(new Map(ALL_CLASSES.map((cls) => [cls, { detail: '/some/detail' }]))),
    ]
    for (const text of texts) {
      expect(text).not.toMatch(/route/i)
      expect(text).not.toMatch(/channel/i)
      expect(text).not.toMatch(/\bPersona "/)
      expect(text).not.toContain('key=')
      expect(text).not.toMatch(/\dT\d/)
    }
    // The fleet-wide classes say they affect every persona.
    expect(ONSET_TEMPLATES['ad-unreachable']('/bin/ad')).toContain('affects every persona')
    expect(ONSET_TEMPLATES['tmux-unavailable']()).toContain('affects every persona')
    // cwd-unreachable points at the persona's working directory, not a route.
    const cwd = ONSET_TEMPLATES['cwd-unreachable']('/work/dir')
    expect(cwd).toMatch(/Working directory unreachable/)
    expect(cwd).toContain('/work/dir')
    expect(cwd).toContain('`working_directory`')
    expect(cwd).not.toMatch(/remove this/i)
  })

  test('two personas: raise/clear for A emits only for A; B is untouched and a same-class raise for B is not deduped against A', () => {
    const { emissions } = makeHarness()
    const forKey = (key: string) => emissions.filter((e) => e.key === key)

    setOutageFlag(P1, 'ad-unreachable', '/bin/ad')
    expect(emissions).toHaveLength(1)
    expect(forKey(P1)).toHaveLength(1)
    expect(forKey(P2)).toHaveLength(0)
    expect(getOutageFlags(P2).size).toBe(0)

    clearOutageFlag(P1, 'ad-unreachable')
    expect(emissions).toHaveLength(2)
    expect(forKey(P1)).toHaveLength(2)
    expect(forKey(P1)[1].text).toMatch(/All clear/)
    expect(forKey(P2)).toHaveLength(0)
    expect(getOutageFlags(P2).size).toBe(0)

    // A holds the flag; the same class raised for B still emits B's own onset.
    setOutageFlag(P1, 'ad-unreachable', '/bin/ad')
    setOutageFlag(P2, 'ad-unreachable', '/bin/ad')
    expect(emissions).toHaveLength(4)
    expect(emissions[3].key).toBe(P2)
    expect(emissions[3].text).toMatch(/agent-director unreachable/)
    expect(getOutageFlags(P1).has('ad-unreachable')).toBe(true)
    expect(getOutageFlags(P2).has('ad-unreachable')).toBe(true)

    // Clearing B leaves A's flag and history alone: A's later clear is A's own all-clear.
    clearOutageFlag(P2, 'ad-unreachable')
    expect(emissions).toHaveLength(5)
    expect(emissions[4].key).toBe(P2)
    expect(getOutageFlags(P1).has('ad-unreachable')).toBe(true)
    clearOutageFlag(P1, 'ad-unreachable')
    expect(emissions).toHaveLength(6)
    expect(emissions[5].key).toBe(P1)
    expect(emissions[5].text).toMatch(/All clear/)
    expect(forKey(P1)).toHaveLength(4)
    expect(forKey(P2)).toHaveLength(2)
  })

  describe('AC 25 (outage-state leg): notices reach only the persona destination through the real notifier', () => {
    let dir: string

    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), 'outage-state-ac25-'))
    })

    afterEach(() => {
      rmSync(dir, { recursive: true, force: true })
    })

    function setup(): { stubA: StubSlack; stubB: StubSlack; refA: string; refB: string; keyA: string; destA: string; lines: string[] } {
      // Names differ from keys, and each persona's destination is a channel
      // that differs from its key and from its first channel.
      const config = makeMultiPersonaConfig(
        [
          {
            name: 'Alpha Ops',
            channels: [{ id: 'C0ALPHA01', delivery: 'all' }, { id: 'C0ALPHA02', delivery: 'all' }],
            permission_prompts: 'C0ALPHA02',
          },
          {
            name: 'Bravo Ops',
            channels: [{ id: 'C0BRAVO01', delivery: 'all' }],
            permission_prompts: 'C0BRAVO01',
          },
        ],
        dir,
      )
      const [a, b] = config.personas
      const h = makeNotifierHarness(config)
      _resetOutageState()
      initOutageState({
        notify: (key, text) => { void h.notifier.notify(key, text) },
        getClient: () => makeStubClient() as unknown as Client,
      })
      expect(a.key).not.toBe(a.permission_prompts)
      return {
        stubA: h.stub(a.key),
        stubB: h.stub(b.key),
        refA: renderPersonaRef(a.name, a.key),
        refB: renderPersonaRef(b.name, b.key),
        keyA: a.key,
        destA: a.permission_prompts,
        lines: h.logs,
      }
    }

    test('raise then clear for A → one post each on A\'s client to A\'s permission_prompts channel naming A; nothing on B', async () => {
      const { stubA, stubB, refA, refB, keyA, destA, lines } = setup()

      setOutageFlag(keyA, 'ad-unreachable', '/bin/ad')
      await Promise.resolve()
      expect(stubA.calls.postMessage).toHaveLength(1)
      const onset = stubA.calls.postMessage[0] as { channel: string; text: string }
      // Exactly channel + text: top-level, no thread or identity override.
      expect(Object.keys(onset).sort()).toEqual(['channel', 'text'])
      expect(onset.channel).toBe(destA)
      expect(onset.text).toContain(refA)
      expect(onset.text).not.toContain(refB)
      expect(onset.text).toMatch(/agent-director unreachable/)
      expect(onset.text).toContain('/bin/ad')
      expect(stubB.calls.postMessage).toHaveLength(0)

      clearOutageFlag(keyA, 'ad-unreachable')
      await Promise.resolve()
      expect(stubA.calls.postMessage).toHaveLength(2)
      const allClear = stubA.calls.postMessage[1] as { channel: string; text: string }
      expect(Object.keys(allClear).sort()).toEqual(['channel', 'text'])
      expect(allClear.channel).toBe(destA)
      expect(allClear.text).toContain(refA)
      expect(allClear.text).not.toContain(refB)
      expect(allClear.text).toMatch(/All clear/)
      expect(allClear.text).toContain('ad-unreachable')
      expect(stubB.calls.postMessage).toHaveLength(0)

      // No drop, dry-run or failure path was taken.
      expect(lines).toEqual([])
    })
  })
})

// ---------------------------------------------------------------------------
// SRD § Test plan case 22 — getClient() allowlist static audit
// SRD § Test plan case 23 Part A — resetAllToHealthy single-call-site audit
// ---------------------------------------------------------------------------

describe('static audits', () => {
  test('22. every getClient() site in src/ is content-anchored in tests/getclient-allowlist.txt', async () => {
    const { readFileSync, readdirSync, statSync } = await import('node:fs')
    const { join } = await import('node:path')

    // Enumerate src/**/*.ts and build a path → content Map for the pure core.
    // Anchoring is by (path, enclosing-scope, normalized-content), so this
    // audit survives comment/JSDoc insertion above a site (b.qbn); it fails
    // only when a NEW site appears or a site MOVES to a different function.
    function walk(dir: string): string[] {
      const out: string[] = []
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry)
        if (statSync(full).isDirectory()) out.push(...walk(full))
        else if (full.endsWith('.ts')) out.push(full)
      }
      return out
    }
    const sources = new Map<string, string>()
    for (const abs of walk('src')) {
      // Normalize to forward-slashed repo-relative path (matches allowlist).
      sources.set(abs.split('\\').join('/'), readFileSync(abs, 'utf-8'))
    }

    const allowlistText = readFileSync('tests/getclient-allowlist.txt', 'utf-8')
    const { violations, staleEntries } = auditGetClientAllowlist(sources, allowlistText)

    const problems: string[] = []
    if (violations.length > 0) {
      problems.push(
        `unsanctioned getClient() site(s) found in src/ not content-anchored in tests/getclient-allowlist.txt:\n` +
          violations.map((v) => `  ${v}`).join('\n') +
          `\n\nIf a site is a legitimate sanctioned exception, copy the anchor above into\n` +
          `tests/getclient-allowlist.txt (path | scope | content). Otherwise migrate it to\n` +
          `withOutageDetection / withSpawnDetection from src/outage-state.ts.`,
      )
    }
    if (staleEntries.length > 0) {
      problems.push(
        `stale allowlist entr${staleEntries.length === 1 ? 'y' : 'ies'} in ` +
          `tests/getclient-allowlist.txt matching no getClient() site (the site moved or was removed):\n` +
          staleEntries.map((e) => `  ${e}`).join('\n'),
      )
    }
    if (problems.length > 0) throw new Error(problems.join('\n\n'))
  })

  test('23 Part A. exactly one resetAllToHealthy(...) call site in src/ outside src/outage-state.ts', async () => {
    const { execSync } = await import('node:child_process')

    let grepOut = ''
    try {
      grepOut = execSync(
        `grep -rn 'resetAllToHealthy(' src/ --include='*.ts'`,
        { encoding: 'utf-8' },
      )
    } catch (err) {
      grepOut = ((err as { stdout?: Buffer }).stdout?.toString()) ?? ''
    }

    const matches = grepOut
      .split('\n')
      .filter((l) => l && !l.startsWith('src/outage-state.ts:'))
      // Filter out comment / JSDoc lines like the case-22 audit.
      .filter((l) => {
        const m = l.match(/^[^:]+:\d+:(.*)$/)
        return m ? !/^\s*(\*|\/\/)/.test(m[1]) : false
      })

    expect(matches).toHaveLength(1)
    // The one sanctioned call site lives in src/server.ts.
    expect(matches[0]).toMatch(/^src\/server\.ts:\d+:/)
  })

  test('23 Part B. resetAllToHealthy is silent + idempotent across consecutive calls', () => {
    const { emissions } = makeHarness()
    setOutageFlag(P1, 'ad-unreachable', '/x')
    expect(getOutageFlags(P1).has('ad-unreachable')).toBe(true)
    const beforeFirst = emissions.length

    resetAllToHealthy([P1])
    expect(getOutageFlags(P1).size).toBe(0)
    expect(emissions.length).toBe(beforeFirst)  // silent: no emission

    resetAllToHealthy([P1])
    expect(getOutageFlags(P1).size).toBe(0)
    expect(emissions.length).toBe(beforeFirst)  // still silent on second call
  })

  test('24. mixed-source two-flag composition: tick + wrapper raise both; spawn-success all-clear names both', async () => {
    const { emissions } = makeHarness()

    // Step 1: simulate the tick raising cwd-unreachable for P1.
    // The tick's effect on the state machine is one setOutageFlag call —
    // exercising it directly is semantically equivalent to driving the tick
    // body, and keeps this case a pure outage-state composition test.
    setOutageFlag(P1, 'cwd-unreachable', '/persona/workdir')

    // Step 2: drive the wrapper to raise ad-unreachable from a spawn throw.
    const adErr = new ErrSystemInstallDisappeared('spawn', '/bin/ad')
    const spawnStub = async () => { throw adErr }
    await expect(
      withSpawnDetection(P1, '/persona/workdir', spawnStub),
    ).rejects.toThrow(ErrSystemInstallDisappeared)

    // Assert: two onsets in order.
    expect(emissions).toHaveLength(2)
    expect(emissions[0].key).toBe(P1)
    expect(emissions[0].text).toMatch(/Working directory unreachable/)
    expect(emissions[0].text).toContain('/persona/workdir')
    expect(emissions[1].key).toBe(P1)
    expect(emissions[1].text).toMatch(/agent-director unreachable/)
    expect(emissions[1].text).toContain('/bin/ad')
    expect(getOutageFlags(P1).has('ad-unreachable')).toBe(true)
    expect(getOutageFlags(P1).has('cwd-unreachable')).toBe(true)

    // Step 3: flip the spawn stub to succeed; withSpawnDetection clears both.
    const successStub = async () => 'ok'
    const result = await withSpawnDetection(P1, '/persona/workdir', successStub)
    expect(result).toBe('ok')

    // Exactly one new emission (the all-clear). Three total now.
    expect(emissions).toHaveLength(3)
    const allClear = emissions[2]
    expect(allClear.key).toBe(P1)
    expect(allClear.text).toMatch(/All clear/)
    // SRD stable rendering order: ad-unreachable BEFORE cwd-unreachable.
    const adIdx = allClear.text.indexOf('ad-unreachable')
    const cwdIdx = allClear.text.indexOf('cwd-unreachable')
    expect(adIdx).toBeGreaterThan(-1)
    expect(cwdIdx).toBeGreaterThan(-1)
    expect(adIdx).toBeLessThan(cwdIdx)
    expect(allClear.text).toContain('/bin/ad')
    expect(allClear.text).toContain('/persona/workdir')
    expect(getOutageFlags(P1).size).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// b.qbn — getClient() allowlist content-anchoring meta-tests
//
// These exercise the PURE audit core (tests/getclient-allowlist-audit.ts) with
// SYNTHETIC sources, proving both directions of the guard independent of the
// real src/ tree: comment insertion is inert (AC-1), a new site fails (AC-2),
// a relocated site fails (AC-3), plus counts, the four non-call kinds, and
// stale-entry detection.
// ---------------------------------------------------------------------------

describe('getClient() allowlist content-anchoring (b.qbn)', () => {
  // A tiny synthetic module with one sanctioned site inside `reconcileOrphans`,
  // and the allowlist entry that anchors it. Reused across cases.
  const baseSource = [
    `export async function reconcileOrphans(`,
    `  routingConfig: RoutingConfig,`,
    `): Promise<void> {`,
    `  const client = getClient()`,
    `  return client.list()`,
    `}`,
  ].join('\n')
  const baseAllowlist =
    `# header comment\n` +
    `src/fake.ts | reconcileOrphans | const client = getClient()  # sanctioned`

  test('AC-1: inserting comment/JSDoc lines above an allowed site → no violations, no stale entries', () => {
    const withComments = [
      `export async function reconcileOrphans(`,
      `  routingConfig: RoutingConfig,`,
      `): Promise<void> {`,
      `  // freshly inserted line comment`,
      `  /**`,
      `   * freshly inserted JSDoc block`,
      `   */`,
      `  const client = getClient()`,
      `  return client.list()`,
      `}`,
    ].join('\n')
    const res = auditGetClientAllowlist(
      new Map([['src/fake.ts', withComments]]),
      baseAllowlist,
    )
    expect(res.violations).toEqual([])
    expect(res.staleEntries).toEqual([])
  })

  test('AC-2: a brand-new getClient() call not covered by an entry → violation names path + scope + content', () => {
    const withNewSite = baseSource.replace(
      `  return client.list()`,
      `  return client.list()\n}\n\nexport async function brandNewFn(): Promise<void> {\n  const c2 = getClient()\n  return c2.list()`,
    )
    const res = auditGetClientAllowlist(
      new Map([['src/fake.ts', withNewSite]]),
      baseAllowlist,
    )
    expect(res.violations).toHaveLength(1)
    expect(res.violations[0]).toContain('src/fake.ts')
    expect(res.violations[0]).toContain('brandNewFn')
    expect(res.violations[0]).toContain('const c2 = getClient()')
    expect(res.staleEntries).toEqual([])
  })

  test('AC-3: relocating an allowed call into a DIFFERENT function → violation AND stale entry', () => {
    const relocated = [
      `export async function reconcileOrphans(`,
      `  routingConfig: RoutingConfig,`,
      `): Promise<void> {`,
      `  return`,
      `}`,
      ``,
      `export async function somewhereElse(): Promise<void> {`,
      `  const client = getClient()`,
      `  return client.list()`,
      `}`,
    ].join('\n')
    const res = auditGetClientAllowlist(
      new Map([['src/fake.ts', relocated]]),
      baseAllowlist,
    )
    // The hit's scope is now `somewhereElse` — no matching entry → violation.
    expect(res.violations).toHaveLength(1)
    expect(res.violations[0]).toContain('somewhereElse')
    // The `reconcileOrphans` entry now matches nothing → stale.
    expect(res.staleEntries).toHaveLength(1)
    expect(res.staleEntries[0]).toContain('reconcileOrphans')
  })

  test('duplicate identical call in the same function → violation (counts are enforced)', () => {
    const dup = [
      `export async function reconcileOrphans(`,
      `  routingConfig: RoutingConfig,`,
      `): Promise<void> {`,
      `  const client = getClient()`,
      `  const client = getClient()`,
      `  return client.list()`,
      `}`,
    ].join('\n')
    const res = auditGetClientAllowlist(new Map([['src/fake.ts', dup]]), baseAllowlist)
    // One entry consumes one hit; the second identical hit is unmatched.
    expect(res.violations).toHaveLength(1)
    expect(res.violations[0]).toContain('const client = getClient()')
    expect(res.staleEntries).toEqual([])
  })

  test('stale-entry detection: deleting the only allowed site → stale entry named', () => {
    const noSite = [
      `export async function reconcileOrphans(`,
      `): Promise<void> {`,
      `  return`,
      `}`,
    ].join('\n')
    const res = auditGetClientAllowlist(new Map([['src/fake.ts', noSite]]), baseAllowlist)
    expect(res.violations).toEqual([])
    expect(res.staleEntries).toHaveLength(1)
    expect(res.staleEntries[0]).toContain('reconcileOrphans')
  })

  test('the four non-call kinds anchor to the honest scope', () => {
    // definition line + string literal both live inside getClient's own body;
    // single-line JSDoc + interface property both belong to OutageStateDeps.
    const src = [
      `export function getClient(): Client {`,
      `  if (singleton === null) {`,
      `    throw new Error(`,
      `      'getClient() called before the startup gate installed a Client',`,
      `    )`,
      `  }`,
      `  return singleton`,
      `}`,
      ``,
      `export interface OutageStateDeps {`,
      `  /** Return the singleton AD Client. Same semantics as getClient() here. */`,
      `  getClient(): Client`,
      `}`,
    ].join('\n')
    const lines = src.split('\n')
    // definition line (index 0) → own name, opens a scope.
    expect(enclosingScope(lines, 0)).toBe('getClient')
    // string literal inside the throw (index 3) → still getClient's body.
    expect(enclosingScope(lines, 3)).toBe('getClient')
    // single-line JSDoc (index 10) → the enclosing interface, not a call.
    expect(enclosingScope(lines, 10)).toBe('OutageStateDeps')
    // interface property (index 11) → the enclosing interface, not its own name.
    expect(enclosingScope(lines, 11)).toBe('OutageStateDeps')

    // And scanFile's comment filter keeps the single-line JSDoc + the interface
    // property (neither begins with `*` or `//`), but the string-literal line
    // and definition line are also real hits → 4 hits total here.
    const hits = scanFile('src/fake.ts', src)
    expect(hits).toHaveLength(4)
    expect(hits.map((h) => h.scope).sort()).toEqual([
      'OutageStateDeps',
      'OutageStateDeps',
      'getClient',
      'getClient',
    ])
  })
})
