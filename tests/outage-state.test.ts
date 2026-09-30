/**
 * outage-state.test.ts — SRD §Test plan cases 1-24, plus the
 * tests/getclient-allowlist.txt static audit (case 22) and the
 * resetAllToHealthy call-site audit (case 23 Part A), the wrappers'
 * report to the UNAVAILABLE retry timer's trigger sink (b.jg5 SRJ-301), and
 * the declared verb's start and end of the persona's `tmux-unresponsive`
 * condition (b.jg5 SRJ-307, SRJ-310).
 *
 * Every wrapped call declares its verb. The trigger-sink and condition-sink
 * cases install recording fake sinks (no timer, no episodes) and run the
 * wrapped call inside a real attempt context (`runInAttempt`); every
 * agent-director error comes from the stub's builders.
 *
 * SPDX-License-Identifier: MIT
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'
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
  reportAgentDirectorError,
  ALL_CLEAR_TEMPLATE,
  ONSET_TEMPLATES,
  type ClassRecord,
  type OutageClass,
} from '../src/outage-state.ts'
import { renderPersonaRef } from '../src/persona-identity.ts'
import {
  AD_CALL_KILL_ROW_NOT_READ_LIVE,
  AD_CALL_KILL_ROW_READ_LIVE,
  AD_VERB_KILL,
  CSCB_UNKNOWN_ERROR_NAME,
  TMUX_TOUCHING_VERBS,
  adCallVerb,
  type AdCall,
  type AdVerb,
} from '../src/ad-error-class.ts'
import {
  TMUX_UNRESPONSIVE_END_TMUX_VERB,
  type TmuxUnresponsiveEndReason,
  type TmuxUnresponsiveSink,
} from '../src/persona-episodes.ts'
import {
  STUB_INSTANCE_ID,
  errCallTimeout,
  errConfigMalformed,
  errGeneric,
  errInstanceIdCollision,
  errSpawnNotFound,
  errSystemInstallDisappeared,
  errTmuxCaptureFailed,
  errTmuxKillFailed,
  errTmuxNotAvailable,
  errTmuxSendKeys,
  errTmuxUnresponsive,
  errUnknownErrorName,
  errUnusableName,
  makeStubCallLog,
  makeStubClient,
  type StubCallLog,
  type StubClientOptions,
} from './test-helpers/agent-director-stub.ts'
import {
  UNAVAILABLE_RETRY_CAUSE_KILL_FAILED,
  UNAVAILABLE_RETRY_CAUSE_READ_ERROR,
  UNAVAILABLE_RETRY_CAUSE_UNAVAILABLE,
  runInAttempt,
  type AttemptErrorRecord,
  type UnavailableRetryCause,
} from '../src/unavailable-retry.ts'
import { assertNoLeak, sentinelInMessage } from './test-helpers/credentials.ts'
import { makeMultiPersonaConfig } from './test-helpers/persona-config.ts'
import { formatPersonaNotice } from '../src/persona-notifier.ts'
import { stubOpenedDmId, type StubSlack } from './test-helpers/slack-stub.ts'
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
 * A call no site can declare (the type forbids it): it reaches the reporting
 * point only through this cast, as an undeclared verb would.
 */
const UNDECLARED_CALL = undefined as unknown as AdCall

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

  test('11b. resetAllToHealthy([key]) at a teardown (b.av2 SR-6.5): clears only that persona, silently; the neighbour keeps its flags and history', () => {
    const { emissions } = makeHarness()
    setOutageFlag(P1, 'ad-unreachable', '/bin/ad')
    setOutageFlag(P2, 'ad-unreachable', '/bin/ad')
    setOutageFlag(P2, 'cwd-unreachable', '/p2/work')
    clearOutageFlag(P2, 'cwd-unreachable')  // P2's bad stretch now holds both classes
    const before = emissions.length

    resetAllToHealthy([P2])

    expect(emissions.length).toBe(before)  // no notify for P2 (or anyone)
    expect(getOutageFlags(P2).size).toBe(0)
    expect([...getOutageFlags(P1)]).toEqual(['ad-unreachable'])

    // P2's bad-stretch history is gone: a fresh flag posts one onset, and its
    // all-clear names only that class, not the pre-teardown ones.
    setOutageFlag(P2, 'cwd-unreachable', '/p2/work')
    setOutageFlag(P2, 'cwd-unreachable', '/p2/work')
    clearOutageFlag(P2, 'cwd-unreachable')
    // P1's all-clear still posts as before.
    clearOutageFlag(P1, 'ad-unreachable')

    expect(emissions.slice(before).map((e) => e.key)).toEqual([P2, P2, P1])
    const [p2Onset, p2Clear, p1Clear] = emissions.slice(before).map((e) => e.text)
    expect(p2Onset).toMatch(/Working directory unreachable/)
    expect(p2Clear).toBe(ALL_CLEAR_TEMPLATE(new Map<OutageClass, ClassRecord>([['cwd-unreachable', { detail: '/p2/work' }]])))
    expect(p1Clear).toBe(ALL_CLEAR_TEMPLATE(new Map<OutageClass, ClassRecord>([['ad-unreachable', { detail: '/bin/ad' }]])))
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
      withOutageDetection(P1, '/cwd', 'spawn', async (_client) => { throw err })
    ).rejects.toBeInstanceOf(ErrSystemInstallDisappeared)
    expect(getOutageFlags(P1).has('ad-unreachable')).toBe(true)
    expect(emissions).toHaveLength(1)
    expect(emissions[0].text).toContain('/bin/ad')
  })

  test('15b. withOutageDetection ErrCwdNotFound + workingDirectory → cwd-unreachable raised; error rethrows', async () => {
    const { emissions } = makeHarness()
    const err = new ErrCwdNotFound('spawn', 'ErrCwdNotFound', 'cwd not found')
    await expect(
      withOutageDetection(P1, '/foo', 'spawn', async (_client) => { throw err })
    ).rejects.toBeInstanceOf(ErrCwdNotFound)
    expect(getOutageFlags(P1).has('cwd-unreachable')).toBe(true)
    expect(emissions).toHaveLength(1)
    expect(emissions[0].text).toContain('/foo')
  })

  test('15c. withOutageDetection unrelated error (ErrSpawnNotFound) → no flag change; error rethrows', async () => {
    const { emissions } = makeHarness()
    const err = new ErrSpawnNotFound('get', 'ErrSpawnNotFound', 'not found')
    await expect(
      withOutageDetection(P1, '/cwd', 'get', async (_client) => { throw err })
    ).rejects.toBeInstanceOf(ErrSpawnNotFound)
    expect(getOutageFlags(P1).size).toBe(0)
    expect(emissions).toHaveLength(0)
  })

  test('16a. withOutageDetection success: clears ad+tmux → all-clear emits naming both', async () => {
    const { emissions } = makeHarness()
    setOutageFlag(P1, 'ad-unreachable', '/bin/ad')
    setOutageFlag(P1, 'tmux-unavailable')
    const before = emissions.length
    await withOutageDetection(P1, '/cwd', 'status', async (_client) => 'ok')
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
    await withOutageDetection(P1, '/cwd', 'status', async (_client) => 'ok')
    expect(emissions.length).toBe(before) // silent — cwd still set
    expect(getOutageFlags(P1).has('cwd-unreachable')).toBe(true)
    expect(getOutageFlags(P1).has('ad-unreachable')).toBe(false)
    expect(getOutageFlags(P1).has('tmux-unavailable')).toBe(false)
  })

  test('17. withOutageDetection success: cwd-unreachable NOT cleared by non-spawn verb', async () => {
    const { emissions } = makeHarness()
    setOutageFlag(P1, 'cwd-unreachable', '/foo')
    const before = emissions.length
    await withOutageDetection(P1, '/cwd', 'status', async (_client) => 'ok')
    expect(emissions.length).toBe(before) // silent (only cwd, so clear of ad+tmux is a no-op)
    expect(getOutageFlags(P1).has('cwd-unreachable')).toBe(true)
  })

  test('18. withSpawnDetection success: clears cwd+ad+tmux; all-clear names all three', async () => {
    const { emissions } = makeHarness()
    setOutageFlag(P1, 'ad-unreachable', '/bin/ad')
    setOutageFlag(P1, 'tmux-unavailable')
    setOutageFlag(P1, 'cwd-unreachable', '/foo')
    const before = emissions.length
    await withSpawnDetection(P1, '/foo', 'spawn', async (_client) => 'ok')
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
      withSpawnDetection(P1, '/foo', 'spawn', async (_client) => { throw err })
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
      withOutageDetection(P1, '/cwd', 'spawn', async (_client) => { throw err })
    ).rejects.toBeInstanceOf(ErrSystemInstallDisappeared)

    // Succeed 1 → all-clear
    await withOutageDetection(P1, '/cwd', 'spawn', async (_client) => 'ok')

    // Throw 2 → onset
    await expect(
      withOutageDetection(P1, '/cwd', 'spawn', async (_client) => { throw err })
    ).rejects.toBeInstanceOf(ErrSystemInstallDisappeared)

    // Succeed 2 → all-clear
    await withOutageDetection(P1, '/cwd', 'spawn', async (_client) => 'ok')

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

    test('A with a dm destination: onset and all-clear each post once to A\'s DM with its contact, opened once on A\'s client; same text as a channel destination; nothing on B', async () => {
      const contact = 'U0ALPHADM'
      const config = makeMultiPersonaConfig(
        [
          {
            name: 'Alpha Ops',
            channels: [{ id: 'C0ALPHA01', delivery: 'all' }],
            dm: { enabled: true, contact },
            permission_prompts: 'dm',
          },
          { name: 'Bravo Ops', channels: [{ id: 'C0BRAVO01', delivery: 'all' }], permission_prompts: 'C0BRAVO01' },
        ],
        dir,
      )
      const [a, b] = config.personas
      const h = makeNotifierHarness(config)
      // The bodies outage-state raised, and the notifier's pending deliveries
      // (a DM post settles only after its conversations.open).
      const bodies: string[] = []
      const pending: Promise<void>[] = []
      _resetOutageState()
      initOutageState({
        notify: (key, text) => {
          bodies.push(text)
          pending.push(h.notifier.notify(key, text))
        },
        getClient: () => makeStubClient() as unknown as Client,
      })
      const stubA = h.stub(a.key)
      const dmId = stubOpenedDmId(contact)
      const refA = renderPersonaRef(a.name, a.key)

      setOutageFlag(a.key, 'ad-unreachable', '/bin/ad')
      // A repeated raise is deduped: nothing more is posted.
      setOutageFlag(a.key, 'ad-unreachable', '/bin/ad')
      await Promise.all(pending)
      expect(stubA.web.callLog.map((c) => c.method)).toEqual(['conversations.open', 'chat.postMessage'])
      expect(stubA.calls.conversationsOpen).toEqual([{ users: contact }])
      expect(stubA.calls.postMessage).toHaveLength(1)
      const onset = stubA.calls.postMessage[0] as { channel: string; text: string }
      // Exactly channel + text, to the opened D… conversation (never the contact's user ID).
      expect(Object.keys(onset).sort()).toEqual(['channel', 'text'])
      expect(onset.channel).toBe(dmId)
      // The same text a channel destination gets: the notifier's persona reference + the raised body.
      expect(onset.text).toBe(formatPersonaNotice(a, bodies[0]!))
      expect(onset.text).toContain(refA)
      expect(onset.text).toMatch(/agent-director unreachable/)

      clearOutageFlag(a.key, 'ad-unreachable')
      await Promise.all(pending)
      // The cached DM is reused: no second open.
      expect(stubA.web.callLog.map((c) => c.method)).toEqual(['conversations.open', 'chat.postMessage', 'chat.postMessage'])
      expect(stubA.calls.postMessage).toHaveLength(2)
      const allClear = stubA.calls.postMessage[1] as { channel: string; text: string }
      expect(Object.keys(allClear).sort()).toEqual(['channel', 'text'])
      expect(allClear.channel).toBe(dmId)
      expect(allClear.text).toBe(formatPersonaNotice(a, bodies[1]!))
      expect(allClear.text).toContain(refA)
      expect(allClear.text).toMatch(/All clear/)
      expect(bodies).toHaveLength(2)

      // Nothing on B's client, and no drop, dry-run, refusal or failure line.
      expect(h.stub(b.key).callLog).toEqual([])
      expect(h.logs).toEqual([])
    })
  })
})

// ---------------------------------------------------------------------------
// b.jg5 SRJ-301 — the wrappers report to the retry timer's trigger sink
// ---------------------------------------------------------------------------

describe('trigger sink (b.jg5 SRJ-301): the wrappers and reportAgentDirectorError', () => {
  /** One `arm` call the recording sink received. */
  type Arm = { key: string; cause: UnavailableRetryCause }

  /**
   * A fresh outage state over one stub client (every verb logged in `calls`)
   * and, unless `sink` is false, a recording trigger sink that answers true
   * (the persona has a timer), as the real controller's `arm` does.
   * `sinkThrows` makes the sink record and then throw; `sinkAnswer` makes it
   * record and answer that value instead of true.
   */
  function makeSinkHarness(opts: { sink?: boolean; sinkThrows?: boolean; sinkAnswer?: unknown; client?: StubClientOptions } = {}): {
    emissions: Emission[]
    arms: Arm[]
    calls: StubCallLog
  } {
    const emissions: Emission[] = []
    const arms: Arm[] = []
    const calls = makeStubCallLog()
    const client = makeStubClient({ ...calls, ...opts.client })
    _resetOutageState()
    initOutageState({
      notify: (key, text) => { emissions.push({ key, text }) },
      getClient: () => client as unknown as Client,
      ...(opts.sink === false
        ? {}
        : {
            triggerSink: {
              arm: (key: string, cause: UnavailableRetryCause): boolean => {
                arms.push({ key, cause })
                if (opts.sinkThrows) throw new Error('sink failed')
                // A non-boolean answer (void included) reaches the reporting point through this cast.
                return 'sinkAnswer' in opts ? (opts.sinkAnswer as boolean) : true
              },
            },
          }),
    })
    return { emissions, arms, calls }
  }

  /**
   * The verbs a wrapped call makes here, each on the default fixture's
   * instance, and the call each site declares (the kill is a teardown's, of a
   * row it did not read live). The declared call, not the client method `fn`
   * runs, is where the attempt record's verb comes from.
   */
  const VERBS = {
    status: { wrap: withOutageDetection, declared: 'status', stubError: 'statusError', call: (c: Client) => c.status({ claude_instance_id: STUB_INSTANCE_ID }) },
    get: { wrap: withOutageDetection, declared: 'get', stubError: 'getError', call: (c: Client) => c.get({ claude_instance_id: STUB_INSTANCE_ID }) },
    list: { wrap: withOutageDetection, declared: 'list', stubError: 'listError', call: (c: Client) => c.list({}) },
    kill: { wrap: withOutageDetection, declared: AD_CALL_KILL_ROW_NOT_READ_LIVE, stubError: 'killError', call: (c: Client) => c.kill({ claude_instance_id: STUB_INSTANCE_ID }) },
    'read-pane': { wrap: withOutageDetection, declared: 'read-pane', stubError: 'readPaneError', call: (c: Client) => c.readPane({ claude_instance_id: STUB_INSTANCE_ID }) },
    resume: { wrap: withSpawnDetection, declared: 'resume', stubError: 'resumeError', call: (c: Client) => c.resume({ claude_instance_id: STUB_INSTANCE_ID }) },
  } as const
  type Verb = keyof typeof VERBS

  /** Stub options that make `verb` reject with `err`. */
  function failing(verb: Verb, err: Error): StubClientOptions {
    return { [VERBS[verb].stubError]: err }
  }

  /** Run `verb` for `key` through its wrapper and answer what it rejected with (it must reject). */
  async function rejectionOf(key: string, verb: Verb): Promise<unknown> {
    const { wrap, declared, call } = VERBS[verb]
    try {
      await wrap(key, '/persona/workdir', declared, call)
    } catch (err) {
      return err
    }
    throw new Error(`${verb} did not reject`)
  }

  /**
   * Run `verb` for `key` inside a launch attempt for `attemptKey`, and answer
   * the rejection and the attempt's last-error record as it was when the call
   * settled.
   */
  async function inAttempt(attemptKey: string, key: string, verb: Verb): Promise<{ rejected: unknown; lastError: AttemptErrorRecord | undefined }> {
    return runInAttempt(attemptKey, 'launch', async (attempt) => {
      const rejected = await rejectionOf(key, verb)
      return { rejected, lastError: attempt.lastError }
    })
  }

  test.each([
    ['UNAVAILABLE from resume (withSpawnDetection)', 'resume', () => errTmuxUnresponsive('resume'), UNAVAILABLE_RETRY_CAUSE_UNAVAILABLE],
    ['UNAVAILABLE from read-pane (not a read verb)', 'read-pane', () => errCallTimeout('read-pane'), UNAVAILABLE_RETRY_CAUSE_UNAVAILABLE],
    ['UNAVAILABLE from status', 'status', () => errCallTimeout('status'), UNAVAILABLE_RETRY_CAUSE_UNAVAILABLE],
    ['ErrTmuxKillFailed from kill', 'kill', () => errTmuxKillFailed(), UNAVAILABLE_RETRY_CAUSE_KILL_FAILED],
    ['a status error (ErrSystemInstallDisappeared)', 'status', () => errSystemInstallDisappeared('status'), UNAVAILABLE_RETRY_CAUSE_READ_ERROR],
    ['a get error (a STATE error other than ErrSpawnNotFound)', 'get', () => errInstanceIdCollision(), UNAVAILABLE_RETRY_CAUSE_READ_ERROR],
    ['a list error', 'list', () => errInstanceIdCollision(), UNAVAILABLE_RETRY_CAUSE_READ_ERROR],
  ] as const)('inside P\'s attempt, %s calls the sink once with P and the cause; the attempt records it armed', async (_label, verb, build, kind) => {
    const err = build()
    const { arms } = makeSinkHarness({ client: failing(verb, err) })

    const { rejected, lastError } = await inAttempt(P1, P1, verb)

    expect(rejected).toBe(err)
    expect(arms).toHaveLength(1)
    expect(arms[0]!.key).toBe(P1)
    expect(arms[0]!.cause.kind).toBe(kind)
    expect(arms[0]!.cause.error).toBe(err)
    expect(lastError).toEqual({ verb, causeKind: kind, armed: true })
  })

  test.each([
    ['ErrSpawnNotFound from get', 'get', () => errSpawnNotFound()],
    ['ErrSpawnNotFound from status', 'status', () => errSpawnNotFound()],
    ['a CONFIG answer from status', 'status', () => errConfigMalformed()],
    ['an UNUSABLE NAME answer from get', 'get', () => errUnusableName()],
    ['a STATE error from kill (not a read verb)', 'kill', () => errInstanceIdCollision()],
    ['an ENVIRONMENT error from resume', 'resume', () => errTmuxNotAvailable(undefined, 'resume')],
  ] as const)('inside P\'s attempt, a non-arming error (%s) calls no sink; the attempt records it unarmed', async (_label, verb, build) => {
    const err = build()
    const { arms } = makeSinkHarness({ client: failing(verb, err) })

    const { rejected, lastError } = await inAttempt(P1, P1, verb)

    expect(rejected).toBe(err)
    expect(arms).toHaveLength(0)
    expect(lastError).toEqual({ verb, armed: false })
  })

  test('a call for P inside Q\'s attempt, or Q\'s call inside P\'s attempt, calls no sink and records nothing in the attempt', async () => {
    const err = errCallTimeout('status')
    const { arms } = makeSinkHarness({ client: failing('status', err) })

    const forP = await inAttempt(P2, P1, 'status')
    const forQ = await inAttempt(P1, P2, 'status')

    expect(forP.rejected).toBe(err)
    expect(forQ.rejected).toBe(err)
    expect(arms).toHaveLength(0)
    expect(forP.lastError).toBeUndefined()
    expect(forQ.lastError).toBeUndefined()
  })

  test('a call for P inside Q\'s attempt nested in P\'s arms P only, recorded in P\'s attempt', async () => {
    const err = errCallTimeout('status')
    const { arms } = makeSinkHarness({ client: failing('status', err) })

    const lastErrors = await runInAttempt(P1, 'recovery', async (outer) => {
      const inner = await inAttempt(P2, P1, 'status')
      return { outer: outer.lastError, inner: inner.lastError }
    })

    expect(arms.map((a) => a.key)).toEqual([P1])
    expect(lastErrors.outer).toEqual({ verb: 'status', causeKind: UNAVAILABLE_RETRY_CAUSE_UNAVAILABLE, armed: true })
    expect(lastErrors.inner).toBeUndefined()
  })

  test('outside any attempt an arming error calls no sink', async () => {
    const err = errCallTimeout('status')
    const { arms } = makeSinkHarness({ client: failing('status', err) })

    expect(await rejectionOf(P1, 'status')).toBe(err)
    expect(arms).toHaveLength(0)
  })

  test('after P\'s attempt settles, a call for P calls no sink', async () => {
    const err = errCallTimeout('status')
    const { arms } = makeSinkHarness({ client: failing('status', err) })

    await runInAttempt(P1, 'launch', () => 'done')

    expect(await rejectionOf(P1, 'status')).toBe(err)
    expect(arms).toHaveLength(0)
  })

  test('with no sink installed, an arming error inside P\'s attempt is recorded unarmed and rethrown unchanged', async () => {
    const err = errTmuxKillFailed()
    makeSinkHarness({ sink: false, client: failing('kill', err) })

    const { rejected, lastError } = await inAttempt(P1, P1, 'kill')

    expect(rejected).toBe(err)
    expect(lastError).toEqual({ verb: 'kill', causeKind: UNAVAILABLE_RETRY_CAUSE_KILL_FAILED, armed: false })
  })

  test('a sink that throws: the wrapper still rethrows the call\'s own error, and the attempt records it unarmed', async () => {
    const err = errCallTimeout('status')
    const { arms } = makeSinkHarness({ sinkThrows: true, client: failing('status', err) })

    const { rejected, lastError } = await inAttempt(P1, P1, 'status')

    expect(rejected).toBe(err)
    expect(arms).toHaveLength(1)
    expect(lastError).toEqual({ verb: 'status', causeKind: UNAVAILABLE_RETRY_CAUSE_UNAVAILABLE, armed: false })
  })

  test.each([
    ['false (nothing armed)', false],
    ['void (no answer)', undefined],
    ['a truthy non-boolean', 1],
  ] as const)('a sink that answers %s: the wrapper rethrows the call\'s own error, and the attempt records it unarmed', async (_label, answer) => {
    const err = errCallTimeout('status')
    const { arms } = makeSinkHarness({ sinkAnswer: answer, client: failing('status', err) })

    const { rejected, lastError } = await inAttempt(P1, P1, 'status')

    expect(rejected).toBe(err)
    expect(arms).toHaveLength(1)
    expect(arms[0]!.key).toBe(P1)
    expect(lastError).toEqual({ verb: 'status', causeKind: UNAVAILABLE_RETRY_CAUSE_UNAVAILABLE, armed: false })
  })

  test.each([
    ['ErrSystemInstallDisappeared from status (arms; raises ad-unreachable)', 'status', () => errSystemInstallDisappeared('status', '/bin/ad')],
    ['ErrTmuxKillFailed from kill (arms; no flag)', 'kill', () => errTmuxKillFailed()],
    ['ErrTmuxNotAvailable from resume (no arm; raises tmux-unavailable)', 'resume', () => errTmuxNotAvailable(undefined, 'resume')],
  ] as const)('%s: the rethrown value, flags and notices are exactly as without a sink or an attempt', async (_label, verb, build) => {
    const err = build()
    /** One run: its rejection, P's flags and every notice raised. */
    async function runWith(sink: boolean, attempt: boolean): Promise<{ rejected: unknown; flags: string[]; emissions: Emission[] }> {
      const { emissions } = makeSinkHarness({ sink, client: failing(verb, err) })
      const rejected = attempt ? (await inAttempt(P1, P1, verb)).rejected : await rejectionOf(P1, verb)
      return { rejected, flags: [...getOutageFlags(P1)].sort(), emissions }
    }

    const baseline = await runWith(false, false)
    const withSinkInAttempt = await runWith(true, true)
    const noSinkInAttempt = await runWith(false, true)

    expect(baseline.rejected).toBe(err)
    expect(withSinkInAttempt.rejected).toBe(err)
    expect(noSinkInAttempt.rejected).toBe(err)
    expect(withSinkInAttempt.flags).toEqual(baseline.flags)
    expect(noSinkInAttempt.flags).toEqual(baseline.flags)
    expect(withSinkInAttempt.emissions).toEqual(baseline.emissions)
    expect(noSinkInAttempt.emissions).toEqual(baseline.emissions)
  })

  test('the error text reaches no notice and no attempt record (leak check)', async () => {
    const err = errTmuxUnresponsive('resume', `tmux did not answer (${sentinelInMessage('resume')}); nothing was done`)
    const { emissions, arms } = makeSinkHarness({ client: failing('resume', err) })

    const { rejected, lastError } = await inAttempt(P1, P1, 'resume')

    expect(rejected).toBe(err)
    expect(arms).toHaveLength(1)
    assertNoLeak({ emissions, lastError, kinds: arms.map((a) => a.cause.kind), flags: [...getOutageFlags(P1)] })
  })

  describe('the client handed to fn (the verb is declared, so the recording proxy and its cases are retired, not weakened)', () => {
    test('fn gets the installed client itself, inside P\'s attempt and outside any attempt', async () => {
      const installed = makeStubClient()
      _resetOutageState()
      initOutageState({
        notify: () => {},
        getClient: () => installed as unknown as Client,
        triggerSink: { arm: () => true },
      })
      const handed: unknown[] = []

      await runInAttempt(P1, 'launch', () => withOutageDetection(P1, '/cwd', 'status', async (c) => { handed.push(c) }))
      await withOutageDetection(P1, '/cwd', 'status', async (c) => { handed.push(c) })
      await runInAttempt(P1, 'recovery', () => withSpawnDetection(P1, '/cwd', 'resume', async (c) => { handed.push(c) }))

      expect(handed).toHaveLength(3)
      for (const c of handed) expect(c).toBe(installed)
    })

    test('inside P\'s attempt, a successful call clears the flags as outside one', async () => {
      makeSinkHarness()
      setOutageFlag(P1, 'ad-unreachable', '/bin/ad')

      const result = await runInAttempt(P1, 'launch', () =>
        withOutageDetection(P1, '/cwd', 'status', (c) => c.status({ claude_instance_id: STUB_INSTANCE_ID })),
      )

      expect(result.state).toBe('waiting')
      expect(getOutageFlags(P1).size).toBe(0)
    })
  })

  describe('reportAgentDirectorError', () => {
    test.each([
      ['UNAVAILABLE from any verb', () => errCallTimeout('kill'), AD_CALL_KILL_ROW_NOT_READ_LIVE, 'kill', UNAVAILABLE_RETRY_CAUSE_UNAVAILABLE],
      ['ErrTmuxKillFailed', () => errTmuxKillFailed(), AD_CALL_KILL_ROW_NOT_READ_LIVE, 'kill', UNAVAILABLE_RETRY_CAUSE_KILL_FAILED],
      ['a status error', () => errSystemInstallDisappeared('status'), 'status', 'status', UNAVAILABLE_RETRY_CAUSE_READ_ERROR],
    ] as const)('inside P\'s attempt, %s calls the sink once with P and the cause', async (_label, build, declared, verb, kind) => {
      const err = build()
      const { arms } = makeSinkHarness()

      const lastError = await runInAttempt(P1, 'recovery', (attempt) => {
        reportAgentDirectorError(P1, err, declared)
        return attempt.lastError
      })

      expect(arms).toHaveLength(1)
      expect(arms[0]!.key).toBe(P1)
      expect(arms[0]!.cause.kind).toBe(kind)
      expect(arms[0]!.cause.error).toBe(err)
      expect(lastError).toEqual({ verb, causeKind: kind, armed: true })
    })

    test.each([
      ['a non-arming error inside P\'s attempt (ErrSpawnNotFound from status)', P1, () => errSpawnNotFound(), 'status'],
      ['a status error with no verb known (a call that is not a declared one)', P1, () => errSystemInstallDisappeared('status'), UNDECLARED_CALL],
      ['an arming error inside Q\'s attempt', P2, () => errCallTimeout('status'), 'status'],
    ] as const)('%s calls no sink', async (_label, attemptKey, build, call) => {
      const { arms } = makeSinkHarness()

      await runInAttempt(attemptKey, 'recovery', () => {
        reportAgentDirectorError(P1, build(), call)
      })

      expect(arms).toHaveLength(0)
    })

    test('outside any attempt it calls no sink', () => {
      const { arms } = makeSinkHarness()

      reportAgentDirectorError(P1, errCallTimeout('status'), 'status')

      expect(arms).toHaveLength(0)
    })

    test('with no sink installed, it records the error unarmed and does not throw', async () => {
      makeSinkHarness({ sink: false })

      const lastError = await runInAttempt(P1, 'recovery', (attempt) => {
        reportAgentDirectorError(P1, errCallTimeout('status'), 'status')
        return attempt.lastError
      })

      expect(lastError).toEqual({ verb: 'status', causeKind: UNAVAILABLE_RETRY_CAUSE_UNAVAILABLE, armed: false })
    })

    test.each([
      ['false', false],
      ['void', undefined],
    ] as const)('with a sink that answers %s, it records the error unarmed', async (_label, answer) => {
      const { arms } = makeSinkHarness({ sinkAnswer: answer })

      const lastError = await runInAttempt(P1, 'recovery', (attempt) => {
        reportAgentDirectorError(P1, errCallTimeout('status'), 'status')
        return attempt.lastError
      })

      expect(arms).toHaveLength(1)
      expect(lastError).toEqual({ verb: 'status', causeKind: UNAVAILABLE_RETRY_CAUSE_UNAVAILABLE, armed: false })
    })

    test('before initOutageState, or with a sink that throws, it does not throw', async () => {
      _resetOutageState()
      await runInAttempt(P1, 'recovery', () => {
        expect(() => reportAgentDirectorError(P1, errCallTimeout('status'), 'status')).not.toThrow()
      })

      const { arms } = makeSinkHarness({ sinkThrows: true })
      await runInAttempt(P1, 'recovery', () => {
        expect(() => reportAgentDirectorError(P1, errCallTimeout('status'), 'status')).not.toThrow()
      })
      expect(arms).toHaveLength(1)
    })

    test('it raises no flag and posts no notice, even for a flag-raising error', async () => {
      const { emissions, arms } = makeSinkHarness()

      await runInAttempt(P1, 'recovery', () => {
        reportAgentDirectorError(P1, errSystemInstallDisappeared('status', '/bin/ad'), 'status')
        reportAgentDirectorError(P1, errTmuxNotAvailable(undefined, 'status'), 'status')
      })

      expect(arms).toHaveLength(2)
      expect(getOutageFlags(P1).size).toBe(0)
      expect(emissions).toHaveLength(0)
    })
  })
})

// ---------------------------------------------------------------------------
// b.jg5 SRJ-307, SRJ-310 — the declared verb and the tmux-unresponsive
// condition sink
// ---------------------------------------------------------------------------

describe('the declared verb and the tmux-unresponsive condition sink (b.jg5 SRJ-307, SRJ-310)', () => {
  /** One `start` the recording condition sink received. */
  type Start = { key: string; verb: AdVerb; error: unknown }
  /** One `end` the recording condition sink received. */
  type End = { key: string; reason: TmuxUnresponsiveEndReason }
  /** One `arm` the recording trigger sink received. */
  type Arm = { key: string; kind: string }

  /** The persona's working directory every wrapped call here passes. */
  const WORKDIR = '/persona/workdir'

  /**
   * A fresh outage state over the default stub client, a recording trigger
   * sink that answers true, and, unless `conditionSink` is false, a recording
   * condition sink. `conditionSinkThrows` makes the condition sink record and
   * then throw.
   */
  function makeConditionHarness(opts: { conditionSink?: boolean; conditionSinkThrows?: boolean } = {}): {
    emissions: Emission[]
    arms: Arm[]
    starts: Start[]
    ends: End[]
  } {
    const emissions: Emission[] = []
    const arms: Arm[] = []
    const starts: Start[] = []
    const ends: End[] = []
    const client = makeStubClient()
    const conditionSink: TmuxUnresponsiveSink = {
      start: (key, verb, error) => {
        starts.push({ key, verb, error })
        if (opts.conditionSinkThrows) throw new Error('condition sink failed')
        return 'started'
      },
      end: (key, reason) => {
        ends.push({ key, reason })
        if (opts.conditionSinkThrows) throw new Error('condition sink failed')
        return 'ended'
      },
    }
    _resetOutageState()
    initOutageState({
      notify: (key, text) => { emissions.push({ key, text }) },
      getClient: () => client as unknown as Client,
      triggerSink: {
        arm: (key, cause) => {
          arms.push({ key, kind: cause.kind })
          return true
        },
      },
      ...(opts.conditionSink === false ? {} : { conditionSink }),
    })
    return { emissions, arms, starts, ends }
  }

  /** Each tmux-touching verb as a site declares it: `kill` only as a kill of a row read live. */
  const TMUX_TOUCHING_CALLS: readonly AdCall[] = [...TMUX_TOUCHING_VERBS].map((verb) =>
    verb === AD_VERB_KILL ? AD_CALL_KILL_ROW_READ_LIVE : (verb as AdCall),
  )
  /** Declared calls that are not tmux-touching, a kill of a row not read live among them. */
  const OTHER_CALLS: readonly AdCall[] = ['status', 'get', 'list', 'find-missing', 'delete', AD_CALL_KILL_ROW_NOT_READ_LIVE]

  /** A readable name for a declared call. */
  function callName(call: AdCall): string {
    return typeof call === 'string' ? call : `kill (row read live: ${call.rowReadLive})`
  }

  /** Both wrappers: the condition rules are the same through each. */
  const WRAPPERS = [
    ['withOutageDetection', withOutageDetection],
    ['withSpawnDetection', withSpawnDetection],
  ] as const
  type Wrap = (typeof WRAPPERS)[number][1]

  /** One table row per wrapper and declared call: `[wrapper name, call name, wrap, call]`. */
  function rows(calls: readonly AdCall[]): Array<[string, string, Wrap, AdCall]> {
    return WRAPPERS.flatMap(([name, wrap]) => calls.map((call): [string, string, Wrap, AdCall] => [name, callName(call), wrap, call]))
  }

  /**
   * The UNAVAILABLE forms other than `ErrTmuxKillFailed` (b.jg5 SRJ-104), each
   * built for the declared verb.
   */
  const UNAVAILABLE_FORMS: ReadonlyArray<readonly [string, (verb: string) => unknown]> = [
    ['ErrTmuxUnresponsive', (verb) => errTmuxUnresponsive(verb)],
    ['ErrCallTimeout', (verb) => errCallTimeout(verb)],
    ['an ErrUnknownErrorName of an unknown name', () => errUnknownErrorName()],
    ['CSCB\'s UnknownError wrapper', (verb) => errGeneric(verb, CSCB_UNKNOWN_ERROR_NAME)],
    ['a value that is not an agent-director error', () => new Error('not an agent-director error')],
  ]

  /** The GONE answers (b.jg5 SRJ-104). */
  const GONE_FORMS: ReadonlyArray<readonly [string, () => unknown]> = [
    ['ErrTmuxSendKeys', () => errTmuxSendKeys()],
    ['ErrTmuxCaptureFailed', () => errTmuxCaptureFailed()],
  ]

  /** Run `call` for `key` through `wrap` with an `fn` that throws `err`; answer what it rejected with (it must reject). */
  async function rejectionOf(wrap: Wrap, key: string, call: AdCall, err: unknown): Promise<unknown> {
    try {
      await wrap(key, WORKDIR, call, async () => { throw err })
    } catch (rejected) {
      return rejected
    }
    throw new Error(`${callName(call)} did not reject`)
  }

  /** Run `body` inside a launch attempt for `attemptKey`; answer its result and the attempt's last error as the body settled. */
  async function inAttempt<T>(attemptKey: string, body: () => Promise<T>): Promise<{ result: T; lastError: AttemptErrorRecord | undefined }> {
    return runInAttempt(attemptKey, 'launch', async (attempt) => {
      const result = await body()
      return { result, lastError: attempt.lastError }
    })
  }

  test('pin: the exported tmux-touching verbs are the SRD glossary\'s six', () => {
    expect([...TMUX_TOUCHING_VERBS].sort()).toEqual(['kill', 'pause', 'read-pane', 'resume', 'send-keys', 'spawn'])
  })

  test.each(rows(TMUX_TOUCHING_CALLS))('%s, tmux-touching %s: each UNAVAILABLE form inside P\'s attempt starts P\'s condition once with the declared verb; no end, no flag, no notice', async (_wrapName, _callName, wrap, call) => {
    const verb = adCallVerb(call)!
    for (const [form, build] of UNAVAILABLE_FORMS) {
      const err = build(verb)
      const { emissions, arms, starts, ends } = makeConditionHarness()

      // `fn` calls no client method: the verb can only come from the declaration.
      const { result: rejected, lastError } = await inAttempt(P1, () => rejectionOf(wrap, P1, call, err))

      expect({ form, rejected: rejected === err }).toEqual({ form, rejected: true })
      expect({ form, starts: starts.map((s) => ({ key: s.key, verb: s.verb, sameError: s.error === err })) })
        .toEqual({ form, starts: [{ key: P1, verb, sameError: true }] })
      expect({ form, ends }).toEqual({ form, ends: [] })
      expect({ form, arms }).toEqual({ form, arms: [{ key: P1, kind: UNAVAILABLE_RETRY_CAUSE_UNAVAILABLE }] })
      expect({ form, lastError }).toEqual({ form, lastError: { verb, causeKind: UNAVAILABLE_RETRY_CAUSE_UNAVAILABLE, armed: true } })
      expect({ form, flags: [...getOutageFlags(P1)], emissions }).toEqual({ form, flags: [], emissions: [] })
    }
  })

  test.each(rows(OTHER_CALLS))('%s, %s (not tmux-touching): an UNAVAILABLE inside P\'s attempt starts nothing and ends nothing; the attempt still records the declared verb', async (_wrapName, _callName, wrap, call) => {
    const verb = adCallVerb(call)!
    const err = errCallTimeout(verb)
    const { arms, starts, ends } = makeConditionHarness()

    const { result: rejected, lastError } = await inAttempt(P1, () => rejectionOf(wrap, P1, call, err))

    expect(rejected).toBe(err)
    expect(starts).toEqual([])
    expect(ends).toEqual([])
    expect(arms).toEqual([{ key: P1, kind: UNAVAILABLE_RETRY_CAUSE_UNAVAILABLE }])
    expect(lastError).toEqual({ verb, causeKind: UNAVAILABLE_RETRY_CAUSE_UNAVAILABLE, armed: true })
  })

  test.each(rows(TMUX_TOUCHING_CALLS))('%s, tmux-touching %s: ErrTmuxKillFailed inside P\'s attempt starts nothing (the kill-failure cause), and arms as before', async (_wrapName, _callName, wrap, call) => {
    const err = errTmuxKillFailed()
    const { arms, starts, ends } = makeConditionHarness()

    const { result: rejected, lastError } = await inAttempt(P1, () => rejectionOf(wrap, P1, call, err))

    expect(rejected).toBe(err)
    expect(starts).toEqual([])
    expect(ends).toEqual([])
    expect(arms).toEqual([{ key: P1, kind: UNAVAILABLE_RETRY_CAUSE_KILL_FAILED }])
    expect(lastError).toEqual({ verb: adCallVerb(call), causeKind: UNAVAILABLE_RETRY_CAUSE_KILL_FAILED, armed: true })
  })

  test.each(rows(TMUX_TOUCHING_CALLS))('%s, tmux-touching %s: a success ends P\'s condition once, inside P\'s attempt and outside any; no start, the result unchanged, no notice', async (_wrapName, _callName, wrap, call) => {
    const { emissions, starts, ends } = makeConditionHarness()

    const inside = await inAttempt(P1, () => wrap(P1, WORKDIR, call, async () => 'ok'))
    const endsInside = [...ends]
    const outside = await wrap(P1, WORKDIR, call, async () => 'ok')

    expect(inside.result).toBe('ok')
    expect(outside).toBe('ok')
    expect(endsInside).toEqual([{ key: P1, reason: TMUX_UNRESPONSIVE_END_TMUX_VERB }])
    expect(ends).toEqual([
      { key: P1, reason: TMUX_UNRESPONSIVE_END_TMUX_VERB },
      { key: P1, reason: TMUX_UNRESPONSIVE_END_TMUX_VERB },
    ])
    expect(starts).toEqual([])
    expect(emissions).toEqual([])
  })

  test.each(rows(OTHER_CALLS))('%s, %s (not tmux-touching): a success ends nothing, inside P\'s attempt or outside any', async (_wrapName, _callName, wrap, call) => {
    const { starts, ends } = makeConditionHarness()

    const inside = await inAttempt(P1, () => wrap(P1, WORKDIR, call, async () => 'ok'))
    const outside = await wrap(P1, WORKDIR, call, async () => 'ok')

    expect(inside.result).toBe('ok')
    expect(outside).toBe('ok')
    expect(ends).toEqual([])
    expect(starts).toEqual([])
  })

  test.each(rows(TMUX_TOUCHING_CALLS))('%s, tmux-touching %s: each GONE answer ends P\'s condition once, inside P\'s attempt and outside any; no start, rethrown unchanged', async (_wrapName, _callName, wrap, call) => {
    for (const [form, build] of GONE_FORMS) {
      const err = build()
      const { emissions, starts, ends } = makeConditionHarness()

      const inside = await inAttempt(P1, () => rejectionOf(wrap, P1, call, err))
      const outside = await rejectionOf(wrap, P1, call, err)

      expect({ form, inside: inside.result === err, outside: outside === err }).toEqual({ form, inside: true, outside: true })
      expect({ form, ends }).toEqual({
        form,
        ends: [
          { key: P1, reason: TMUX_UNRESPONSIVE_END_TMUX_VERB },
          { key: P1, reason: TMUX_UNRESPONSIVE_END_TMUX_VERB },
        ],
      })
      expect({ form, starts, emissions }).toEqual({ form, starts: [], emissions: [] })
    }
  })

  test.each(rows(OTHER_CALLS))('%s, %s (not tmux-touching): a GONE answer ends nothing', async (_wrapName, _callName, wrap, call) => {
    for (const [form, build] of GONE_FORMS) {
      const err = build()
      const { starts, ends } = makeConditionHarness()

      const inside = await inAttempt(P1, () => rejectionOf(wrap, P1, call, err))
      const outside = await rejectionOf(wrap, P1, call, err)

      expect({ form, inside: inside.result === err, outside: outside === err }).toEqual({ form, inside: true, outside: true })
      expect({ form, starts, ends }).toEqual({ form, starts: [], ends: [] })
    }
  })

  test.each(TMUX_TOUCHING_CALLS.map((call) => [callName(call), call] as const))('tmux-touching %s: an UNAVAILABLE outside any attempt, inside Q\'s attempt, or after P\'s attempt settled starts nothing', async (_callName, call) => {
    const err = errTmuxUnresponsive(adCallVerb(call)!)
    const { starts, ends } = makeConditionHarness()

    const outside = await rejectionOf(withOutageDetection, P1, call, err)
    const insideQ = await inAttempt(P2, () => rejectionOf(withOutageDetection, P1, call, err))
    const qInsideP = await inAttempt(P1, () => rejectionOf(withOutageDetection, P2, call, err))
    await runInAttempt(P1, 'launch', () => 'done')
    const afterP = await rejectionOf(withOutageDetection, P1, call, err)

    expect([outside, insideQ.result, qInsideP.result, afterP].every((r) => r === err)).toBe(true)
    expect(starts).toEqual([])
    expect(ends).toEqual([])
  })

  test('a call for P inside Q\'s attempt nested in P\'s starts P\'s condition only', async () => {
    const err = errTmuxUnresponsive('send-keys')
    const { starts } = makeConditionHarness()

    await runInAttempt(P1, 'recovery', () => inAttempt(P2, () => rejectionOf(withOutageDetection, P1, 'send-keys', err)))

    expect(starts.map((s) => ({ key: s.key, verb: s.verb }))).toEqual([{ key: P1, verb: 'send-keys' }])
  })

  test('reportAgentDirectorError inside P\'s attempt: a tmux-touching UNAVAILABLE starts the condition; a status or find-missing one, or an undeclared call, starts nothing', async () => {
    const { starts, ends } = makeConditionHarness()
    const touching = errTmuxUnresponsive('read-pane')

    await runInAttempt(P1, 'recovery', () => {
      reportAgentDirectorError(P1, errCallTimeout('status'), 'status')
      reportAgentDirectorError(P1, errCallTimeout('find-missing'), 'find-missing')
      reportAgentDirectorError(P1, errCallTimeout('status'), UNDECLARED_CALL)
      reportAgentDirectorError(P1, errTmuxKillFailed(), AD_CALL_KILL_ROW_READ_LIVE)
      reportAgentDirectorError(P1, touching, 'read-pane')
    })

    expect(starts.map((s) => ({ key: s.key, verb: s.verb, sameError: s.error === touching }))).toEqual([
      { key: P1, verb: 'read-pane', sameError: true },
    ])
    expect(ends).toEqual([])
  })

  /** One wrapped call's scenario for the unchanged-outcome case below. */
  type Scenario = readonly [label: string, wrap: Wrap, call: AdCall, build: (() => unknown) | undefined, inAttemptForP: boolean]
  const SCENARIOS: readonly Scenario[] = [
    ['UNAVAILABLE from spawn inside P\'s attempt (starts)', withSpawnDetection, 'spawn', () => errTmuxUnresponsive('spawn'), true],
    ['UNAVAILABLE from status inside P\'s attempt', withOutageDetection, 'status', () => errCallTimeout('status'), true],
    ['GONE from send-keys (ends)', withOutageDetection, 'send-keys', () => errTmuxSendKeys(), false],
    ['ErrTmuxNotAvailable from resume inside P\'s attempt (raises tmux-unavailable)', withSpawnDetection, 'resume', () => errTmuxNotAvailable(undefined, 'resume'), true],
    ['ErrSystemInstallDisappeared from read-pane inside P\'s attempt (raises ad-unreachable)', withOutageDetection, 'read-pane', () => errSystemInstallDisappeared('read-pane', '/bin/ad'), true],
    ['ErrTmuxKillFailed from a kill of a live row inside P\'s attempt', withOutageDetection, AD_CALL_KILL_ROW_READ_LIVE, () => errTmuxKillFailed(), true],
    ['a success of resume (ends; clears the flags)', withSpawnDetection, 'resume', undefined, false],
  ]

  test.each(SCENARIOS)('%s: the rethrown value or result, the flags, the notices and the attempt record are exactly as with no condition sink, or with one that throws', async (_label, wrap, call, build, inAttemptForP) => {
    const err = build?.()
    /** One run with the given condition sink: its outcome, P's flags, every notice and the attempt record. */
    async function runWith(opts: { conditionSink: boolean; conditionSinkThrows?: boolean }): Promise<unknown> {
      const { emissions, arms } = makeConditionHarness(opts)
      // Flags up beforehand, so a success's all-clear is part of the outcome.
      setOutageFlag(P1, 'ad-unreachable', '/bin/ad')
      setOutageFlag(P1, 'cwd-unreachable', WORKDIR)
      const body = async (): Promise<unknown> =>
        err === undefined ? { value: await wrap(P1, WORKDIR, call, async () => 'ok') } : { rejectedSame: (await rejectionOf(wrap, P1, call, err)) === err }
      const { result, lastError } = inAttemptForP ? await inAttempt(P1, body) : { result: await body(), lastError: undefined }
      return { result, lastError, arms, flags: [...getOutageFlags(P1)].sort(), emissions }
    }

    const without = await runWith({ conditionSink: false })
    const withSink = await runWith({ conditionSink: true })
    const throwingSink = await runWith({ conditionSink: true, conditionSinkThrows: true })

    expect(withSink).toEqual(without)
    expect(throwingSink).toEqual(without)
  })

  test('the error text reaches no notice, attempt record or flag, and the sink gets the error value itself (leak check)', async () => {
    const err = errTmuxUnresponsive('send-keys', `tmux did not answer (${sentinelInMessage('send-keys')}); nothing was done`)
    const { emissions, starts } = makeConditionHarness()

    const { result: rejected, lastError } = await inAttempt(P1, () => rejectionOf(withOutageDetection, P1, 'send-keys', err))

    expect(rejected).toBe(err)
    expect(starts).toHaveLength(1)
    expect(starts[0]!.error).toBe(err)
    assertNoLeak({ emissions, lastError, starts: starts.map((s) => ({ key: s.key, verb: s.verb })), flags: [...getOutageFlags(P1)] })
  })
})

// ---------------------------------------------------------------------------
// SRD § Test plan case 22 — getClient() allowlist static audit
// SRD § Test plan case 23 Part A — resetAllToHealthy call-site audit (boot + teardown)
// ---------------------------------------------------------------------------

// Repo root, so the audits below read src/ and the allow-list from any
// working directory.
const REPO_ROOT = resolve(import.meta.dir, '..')

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
    for (const abs of walk(join(REPO_ROOT, 'src'))) {
      // Normalize to forward-slashed repo-relative path (matches allowlist).
      sources.set(relative(REPO_ROOT, abs).split('\\').join('/'), readFileSync(abs, 'utf-8'))
    }

    const allowlistText = readFileSync(join(REPO_ROOT, 'tests', 'getclient-allowlist.txt'), 'utf-8')
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

  test('23 Part A. exactly one resetAllToHealthy(...) call in src/ outside src/outage-state.ts, the boot reset in src/server.ts', async () => {
    const { readFileSync, readdirSync, statSync } = await import('node:fs')
    const { stripComments } = await import('./test-helpers/source-audit.ts')

    function walk(dir: string): string[] {
      const out: string[] = []
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry)
        if (statSync(full).isDirectory()) out.push(...walk(full))
        else if (full.endsWith('.ts')) out.push(full)
      }
      return out
    }
    // Code only (comments stripped), per repo-relative file, outage-state.ts itself excluded.
    const code = new Map<string, string>()
    for (const abs of walk(join(REPO_ROOT, 'src'))) {
      const rel = relative(REPO_ROOT, abs).split('\\').join('/')
      if (rel !== 'src/outage-state.ts') code.set(rel, stripComments(readFileSync(abs, 'utf-8')))
    }
    const countIn = (re: RegExp) =>
      Object.fromEntries([...code].map(([f, c]) => [f, [...c.matchAll(re)].length] as const).filter(([, n]) => n > 0))

    // The one boot reset in server.ts. A teardown (b.av2 SR-6.5) reaches it
    // through createPersonaLifecycle's injected resetOutageState, never by
    // name; tests/reload-wiring.test.ts pins that binding.
    expect(countIn(/(?<![\w.$])resetAllToHealthy\s*\(/g)).toEqual({ 'src/server.ts': 1 })
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
      withSpawnDetection(P1, '/persona/workdir', 'spawn', spawnStub),
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
    const result = await withSpawnDetection(P1, '/persona/workdir', 'spawn', successStub)
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
    `  personaConfig: PersonaConfig,`,
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
      `  personaConfig: PersonaConfig,`,
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
      `  personaConfig: PersonaConfig,`,
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
      `  personaConfig: PersonaConfig,`,
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
