/**
 * outage-state.test.ts — SRD §Test plan cases 1-24, plus the
 * tests/getclient-allowlist.txt static audit (case 22) and the
 * resetAllToHealthy call-site audit (case 23 Part A), the wrappers'
 * report to the UNAVAILABLE retry timer's trigger sink (b.jg5 SRJ-301), and
 * the declared verb's start and end of the persona's `tmux-unresponsive`
 * condition (b.jg5 SRJ-307, SRJ-310), and the `tmux-unavailable` onset a
 * re-bound socket gets (b.jg5 SRJ-1021: one pin case holds its text; every
 * other case compares with the exported builder), and the
 * `ad-config-malformed` outage a CONFIG answer raises: its raise, clear,
 * report and onset (b.jg5 SRJ-316, SRJ-312, SRJ-1018: one pin case holds
 * the onset's text; every other case compares with the exported template
 * over the classifier's rendered message), and the report of an UNCLASSIFIED
 * outcome met in P's attempt to the unclassified sink, through the wrappers,
 * the reporting point and the site entry (b.jg5 SRJ-313, SRJ-301).
 *
 * Every wrapped call declares its verb. The trigger-sink and condition-sink
 * cases install recording fake sinks (no timer, no episodes) and run the
 * wrapped call inside a real attempt context (`runInAttempt`); every
 * agent-director error comes from the stub's builders.
 *
 * SPDX-License-Identifier: MIT
 */

import { describe, test, expect, beforeEach, afterEach, spyOn } from 'bun:test'
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
  reportUnclassifiedAtSite,
  ALL_CLEAR_TEMPLATE,
  ONSET_TEMPLATES,
  OUTAGE_CLASS_ORDER,
  adConfigMalformedOnset,
  raiseAdConfigMalformed,
  raiseTmuxUnavailable,
  tmuxServerChangedOnset,
  type ClassRecord,
  type OutageClass,
} from '../src/outage-state.ts'
import { DIFFERENT_TMUX_SERVER_PHRASE } from '../src/ad-description-phrases.ts'
import { renderPersonaRef } from '../src/persona-identity.ts'
import { LIVENESS_LIVE } from '../src/liveness-reading.ts'
import {
  AD_CALL_KILL_ROW_NOT_READ_LIVE,
  AD_CALL_KILL_ROW_READ_LIVE,
  AD_ERROR_CLASS_UNCLASSIFIED,
  AD_VERB_KILL,
  AD_VERBS,
  TMUX_TOUCHING_VERBS,
  adCallVerb,
  classifyAdError,
  classifyWithInvalidFlagsRecheck,
  describeAdErrorClassification,
  type AdCall,
  type AdErrorClassification,
  type AdVerb,
} from '../src/ad-error-class.ts'
import {
  TMUX_UNRESPONSIVE_END_TMUX_VERB,
  type TmuxUnresponsiveEndReason,
  type TmuxUnresponsiveSink,
} from '../src/persona-episodes.ts'
import {
  STUB_INSTANCE_ID,
  STUB_TMUX_SOCKET_PATH,
  errCallTimeout,
  errConfigMalformed,
  errGeneric,
  errInstanceIdCollision,
  errInternal,
  errInvalidFlags,
  errSchemaMismatch,
  errSpawnNotFound,
  errSpawnNotResumable,
  errSystemInstallDisappeared,
  errTmuxCaptureFailed,
  errTmuxKillFailed,
  errTmuxNotAvailable,
  errTmuxNotAvailableDifferentServer,
  errTmuxSendKeys,
  errTmuxUnresponsive,
  errUnknownErrorName,
  errUnusableName,
  makeStubCallLog,
  makeStubClient,
  makeStubResolveSystemBinary,
  type StubCallLog,
  type StubClientOptions,
  unavailableForms,
} from './test-helpers/agent-director-stub.ts'
import {
  UNAVAILABLE_RETRY_CAUSE_CONFIG,
  UNAVAILABLE_RETRY_CAUSE_ENVIRONMENT,
  UNAVAILABLE_RETRY_CAUSE_KILL_FAILED,
  UNAVAILABLE_RETRY_CAUSE_READ_ERROR,
  UNAVAILABLE_RETRY_CAUSE_UNAVAILABLE,
  UNAVAILABLE_RETRY_CAUSE_UNCLASSIFIED,
  UNAVAILABLE_RETRY_ROW_PENDING,
  runInAttempt,
  type AttemptErrorRecord,
  type UnavailableRetryCause,
} from '../src/unavailable-retry.ts'
import { APP_TOKEN_PREFIX, REDACTED_SENTINEL_TAIL, assertNoLeak, sentinelInMessage } from './test-helpers/credentials.ts'
import { MAX_LOGGED_MESSAGE_LENGTH, describeThrownValue } from '../src/persona-connection-errors.ts'
import { RECHECK_OUTCOME_NOT_RUNNING, RECHECK_OUTCOME_PASS, createAdVersionRecheck } from '../src/ad-version-gate.ts'
import { PHASE1_RC_VERSION } from './test-helpers/agent-director-versions.ts'
import { createFakeClock } from './test-helpers/fake-clock.ts'
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

  test('16a. withOutageDetection success of a tmux-touching call (read-pane): clears ad+tmux → all-clear emits naming both', async () => {
    const { emissions } = makeHarness()
    setOutageFlag(P1, 'ad-unreachable', '/bin/ad')
    setOutageFlag(P1, 'tmux-unavailable')
    const before = emissions.length
    await withOutageDetection(P1, '/cwd', 'read-pane', async (_client) => 'ok')
    const newEmissions = emissions.slice(before)
    expect(newEmissions).toHaveLength(1)
    expect(newEmissions[0].text).toMatch(/All clear/)
    expect(newEmissions[0].text).toContain('ad-unreachable')
    expect(newEmissions[0].text).toContain('tmux-unavailable')
    expect(getOutageFlags(P1).size).toBe(0)
  })

  test('16b. withOutageDetection success of a tmux-touching call (read-pane) with cwd also set: ad+tmux clear is silent; cwd-unreachable remains', async () => {
    const { emissions } = makeHarness()
    setOutageFlag(P1, 'ad-unreachable', '/bin/ad')
    setOutageFlag(P1, 'tmux-unavailable')
    setOutageFlag(P1, 'cwd-unreachable', '/foo')
    const before = emissions.length
    await withOutageDetection(P1, '/cwd', 'read-pane', async (_client) => 'ok')
    expect(emissions.length).toBe(before) // silent — cwd still set
    expect(getOutageFlags(P1).has('cwd-unreachable')).toBe(true)
    expect(getOutageFlags(P1).has('ad-unreachable')).toBe(false)
    expect(getOutageFlags(P1).has('tmux-unavailable')).toBe(false)
  })

  test.each([
    ['a non-spawn verb that is not tmux-touching (status)', 'status'],
    ['its twin, a non-spawn tmux-touching verb (read-pane)', 'read-pane'],
  ] as const)('17. withOutageDetection success: cwd-unreachable NOT cleared by %s', async (_label, call) => {
    const { emissions } = makeHarness()
    setOutageFlag(P1, 'cwd-unreachable', '/foo')
    const before = emissions.length
    await withOutageDetection(P1, '/cwd', call, async (_client) => 'ok')
    expect(emissions.length).toBe(before) // silent (only cwd, so clear of ad+tmux is a no-op)
    expect(getOutageFlags(P1).has('cwd-unreachable')).toBe(true)
  })

  test('18. withSpawnDetection success of a tmux-touching call (spawn): clears cwd+ad+tmux; all-clear names all three', async () => {
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

  test('18 twin. withSpawnDetection success of a call that is not tmux-touching (status): clears cwd+ad silently; tmux-unavailable stays raised', async () => {
    const { emissions } = makeHarness()
    setOutageFlag(P1, 'ad-unreachable', '/bin/ad')
    setOutageFlag(P1, 'tmux-unavailable')
    setOutageFlag(P1, 'cwd-unreachable', '/foo')
    const before = emissions.length
    await withSpawnDetection(P1, '/foo', 'status', async (_client) => 'ok')
    expect(emissions.length).toBe(before)
    expect([...getOutageFlags(P1)]).toEqual(['tmux-unavailable'])
  })

  test.each([
    ['a tmux-touching call (spawn)', 'spawn'],
    ['its twin, a call that is not tmux-touching (status)', 'status'],
  ] as const)('19. withSpawnDetection ErrCwdNotFound from %s: cwd-unreachable raised; ad/tmux NOT cleared; error rethrows', async (_label, call) => {
    const { emissions } = makeHarness()
    setOutageFlag(P1, 'ad-unreachable', '/bin/ad')
    setOutageFlag(P1, 'tmux-unavailable')
    const before = emissions.length
    const err = new ErrCwdNotFound(call, 'ErrCwdNotFound', 'cwd not found')
    await expect(
      withSpawnDetection(P1, '/foo', call, async (_client) => { throw err })
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
  const ALL_CLASSES: readonly OutageClass[] = OUTAGE_CLASS_ORDER

  test('onset and all-clear texts name no route or channel and carry no persona reference (the notifier adds it)', () => {
    const texts = [
      ...ALL_CLASSES.map((cls) => ONSET_TEMPLATES[cls]('/some/detail')),
      tmuxServerChangedOnset(),
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
    ['ENVIRONMENT from resume', 'resume', () => errTmuxNotAvailable(undefined, 'resume'), UNAVAILABLE_RETRY_CAUSE_ENVIRONMENT],
    ['ENVIRONMENT from kill', 'kill', () => errTmuxNotAvailable(undefined, 'kill'), UNAVAILABLE_RETRY_CAUSE_ENVIRONMENT],
    ['ENVIRONMENT from status (the ENVIRONMENT cause, not read-error)', 'status', () => errTmuxNotAvailable(undefined, 'status'), UNAVAILABLE_RETRY_CAUSE_ENVIRONMENT],
    ['a CONFIG answer from status (the CONFIG cause, not read-error; b.jg5 SRJ-316)', 'status', () => errConfigMalformed(), UNAVAILABLE_RETRY_CAUSE_CONFIG],
    ['a CONFIG answer from get (the CONFIG cause, not read-error)', 'get', () => errConfigMalformed(), UNAVAILABLE_RETRY_CAUSE_CONFIG],
    ['a CONFIG answer from kill (not a read verb)', 'kill', () => errConfigMalformed(), UNAVAILABLE_RETRY_CAUSE_CONFIG],
    ['a CONFIG answer from resume (withSpawnDetection; not a read verb)', 'resume', () => errConfigMalformed(), UNAVAILABLE_RETRY_CAUSE_CONFIG],
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
    ['an UNUSABLE NAME answer from get', 'get', () => errUnusableName()],
    ['a STATE error from kill (not a read verb)', 'kill', () => errInstanceIdCollision()],
    ['a STATE error from resume (not a read verb; ENVIRONMENT now arms, b.jg5 SRJ-311)', 'resume', () => errSpawnNotResumable()],
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
    ['ErrTmuxNotAvailable from resume (arms the ENVIRONMENT cause; raises tmux-unavailable)', 'resume', () => errTmuxNotAvailable(undefined, 'resume')],
    ['a CONFIG answer from status (arms the CONFIG cause; raises ad-config-malformed)', 'status', () => errConfigMalformed()],
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
        reportAgentDirectorError(P1, errConfigMalformed(), 'status')
      })

      expect(arms).toHaveLength(3)
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

  type Wrap = typeof withOutageDetection
  type Row = [string, string, Wrap, AdCall]

  /**
   * One table row per declared call through `withOutageDetection`:
   * `[wrapper name, call name, wrap, call]`. `withSpawnDetection` delegates to
   * it, so the start and success tables each add one `withSpawnDetection` row.
   */
  function rows(calls: readonly AdCall[]): Row[] {
    return calls.map((call): Row => ['withOutageDetection', callName(call), withOutageDetection, call])
  }

  /**
   * The UNAVAILABLE forms other than `ErrTmuxKillFailed` (b.jg5 SRJ-104), each
   * built for the declared verb.
   */
  const TMUX_STARTING_FORMS = unavailableForms('ErrTmuxUnresponsive', 'ErrCallTimeout', 'ErrUnknownErrorName', 'a wrapped UnknownError', 'a plain Error')

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

  test.each([...rows(TMUX_TOUCHING_CALLS), ['withSpawnDetection', 'spawn', withSpawnDetection, 'spawn'] as Row])('%s, tmux-touching %s: each UNAVAILABLE form inside P\'s attempt starts P\'s condition once with the declared verb; no end, no flag, no notice', async (_wrapName, _callName, wrap, call) => {
    const verb = adCallVerb(call)!
    for (const [form, build] of TMUX_STARTING_FORMS) {
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

  test.each([...rows(TMUX_TOUCHING_CALLS), ['withSpawnDetection', 'resume', withSpawnDetection, 'resume'] as Row])('%s, tmux-touching %s: a success ends P\'s condition once, inside P\'s attempt and outside any; no start, the result unchanged, no notice', async (_wrapName, _callName, wrap, call) => {
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

    expect([outside, insideQ.result, qInsideP.result, afterP]).toEqual([err, err, err, err])
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
    ['a CONFIG answer from spawn inside P\'s attempt (raises ad-config-malformed)', withSpawnDetection, 'spawn', () => errConfigMalformed(), true],
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
// b.jg5 SRJ-311, SRJ-312, SRJ-301, SRJ-305 — what clears `tmux-unavailable`,
// ENVIRONMENT's report to the trigger sink, and the cleared-flag observer
// ---------------------------------------------------------------------------

/** The persona's working directory every wrapped call in the sections below passes. */
const WRAP_WORKDIR = '/persona/workdir'

/** One `arm` the recording trigger sink received: the key, the cause kind, and whether the error is the thrown value itself. */
type RecordedArm = { key: string; kind: string; error: unknown }
/** One call the recording cleared-flag observer received. */
type RecordedClear = { key: string; cls: OutageClass; reading: string | undefined }

/**
 * A fresh outage state over the default stub client with, unless turned off,
 * a recording trigger sink that answers true, a recording condition sink and
 * a recording cleared-flag observer. `observerThrows` makes the observer
 * record and then throw. `onClear` runs inside the observer, after the record.
 */
function makeRecordingHarness(opts: { sink?: boolean; observer?: boolean; observerThrows?: boolean; onClear?: (c: RecordedClear) => void } = {}): {
  emissions: Emission[]
  arms: RecordedArm[]
  starts: string[]
  cleared: RecordedClear[]
} {
  const emissions: Emission[] = []
  const arms: RecordedArm[] = []
  const starts: string[] = []
  const cleared: RecordedClear[] = []
  const client = makeStubClient()
  _resetOutageState()
  initOutageState({
    notify: (key, text) => { emissions.push({ key, text }) },
    getClient: () => client as unknown as Client,
    ...(opts.sink === false
      ? {}
      : { triggerSink: { arm: (key: string, cause: UnavailableRetryCause) => { arms.push({ key, kind: cause.kind, error: cause.error }); return true } } }),
    conditionSink: {
      start: (key) => { starts.push(key); return 'started' },
      end: () => 'ended',
    },
    ...(opts.observer === false
      ? {}
      : {
          onFlagCleared: (key: string, cls: OutageClass, reading?: string) => {
            const c = { key, cls, reading }
            cleared.push(c)
            opts.onClear?.(c)
            if (opts.observerThrows) throw new Error('observer failed')
          },
        }),
  })
  return { emissions, arms, starts, cleared }
}

/** A readable name for a declared call. */
function declaredName(call: AdCall): string {
  return typeof call === 'string' ? call : `kill (row read live: ${call.rowReadLive})`
}

/** Each tmux-touching verb in the exported set as a site declares it: `kill` only as a kill of a row read live. */
const CLEARING_CALLS: readonly AdCall[] = [...TMUX_TOUCHING_VERBS].map((verb) =>
  verb === AD_VERB_KILL ? AD_CALL_KILL_ROW_READ_LIVE : (verb as AdCall),
)
/** Every declared call: each agent-director verb, and `kill` in both declarations. */
const EVERY_DECLARED_CALL: readonly AdCall[] = AD_VERBS.flatMap((verb): AdCall[] =>
  verb === AD_VERB_KILL ? [AD_CALL_KILL_ROW_READ_LIVE, AD_CALL_KILL_ROW_NOT_READ_LIVE] : [verb],
)
/** Every other declared call: tmux does not answer it, so it never clears `tmux-unavailable`. */
const NON_CLEARING_CALLS: readonly AdCall[] = EVERY_DECLARED_CALL.filter((call) => !CLEARING_CALLS.includes(call))

type AnyWrap = typeof withOutageDetection
/** The two wrappers, by name. */
const WRAPPERS: ReadonlyArray<readonly [string, AnyWrap]> = [
  ['withOutageDetection', withOutageDetection],
  ['withSpawnDetection', withSpawnDetection],
]
type WrapRow = [wrapName: string, callName: string, wrap: AnyWrap, call: AdCall]
/** One row per wrapper and declared call. */
function wrapRows(calls: readonly AdCall[]): WrapRow[] {
  return WRAPPERS.flatMap(([name, wrap]) => calls.map((call): WrapRow => [name, declaredName(call), wrap, call]))
}
/** Every declared call through withOutageDetection, and the launch calls through withSpawnDetection. */
const EVERY_WRAPPED_ROW: readonly WrapRow[] = [
  ...EVERY_DECLARED_CALL.map((call): WrapRow => ['withOutageDetection', declaredName(call), withOutageDetection, call]),
  ['withSpawnDetection', 'spawn', withSpawnDetection, 'spawn'],
  ['withSpawnDetection', 'resume', withSpawnDetection, 'resume'],
]

/** Run `call` for `key` through `wrap` with an `fn` that throws `err`; answer what it rejected with (it must reject). */
async function rejectionFrom(wrap: AnyWrap, key: string, call: AdCall, err: unknown): Promise<unknown> {
  try {
    await wrap(key, WRAP_WORKDIR, call, async () => { throw err })
  } catch (rejected) {
    return rejected
  }
  throw new Error(`${declaredName(call)} did not reject`)
}

/** The GONE answers (b.jg5 SRJ-104). */
const GONE_ANSWERS: ReadonlyArray<readonly [string, () => unknown]> = [
  ['ErrTmuxSendKeys', () => errTmuxSendKeys()],
  ['ErrTmuxCaptureFailed', () => errTmuxCaptureFailed()],
]

/** The all-clear for a bad stretch that recorded exactly `history`. */
function allClearOf(history: ReadonlyArray<readonly [OutageClass, string | undefined]>): string {
  return ALL_CLEAR_TEMPLATE(new Map<OutageClass, ClassRecord>(history.map(([cls, detail]) => [cls, { detail }])))
}

/** Where a call runs: inside an attempt for P, inside another persona's (Q's) attempt, outside every attempt. */
type Context = 'inside P\'s attempt' | 'inside Q\'s attempt' | 'outside any attempt'
const CONTEXTS: readonly Context[] = ['inside P\'s attempt', 'inside Q\'s attempt', 'outside any attempt']

/** Run `body` in `context`; answer its result and the last error of the attempt it ran in (none outside). */
async function runIn<T>(context: Context, body: () => Promise<T> | T): Promise<{ result: T; lastError: AttemptErrorRecord | undefined }> {
  if (context === 'outside any attempt') return { result: await body(), lastError: undefined }
  return runInAttempt(context === 'inside P\'s attempt' ? P1 : P2, 'launch', async (attempt) => {
    const result = await body()
    return { result, lastError: attempt.lastError }
  })
}

describe('what clears tmux-unavailable (b.jg5 SRJ-312: AC 27, AC 36)', () => {
  test('pin: the calls the not-tmux-touching rows below run over include every one the SRD names (status, get, list, find-missing, delete, kill of a row not read live)', () => {
    expect(NON_CLEARING_CALLS).toEqual(expect.arrayContaining(
      ['status', 'get', 'list', 'find-missing', 'delete', AD_CALL_KILL_ROW_NOT_READ_LIVE] satisfies AdCall[],
    ))
  })

  test.each(wrapRows(CLEARING_CALLS))('%s, tmux-touching %s: a success clears it and ad-unreachable, with one all-clear over the recorded history; B is untouched', async (_w, _c, wrap, call) => {
    const { emissions } = makeRecordingHarness()
    setOutageFlag(P1, 'ad-unreachable', '/bin/ad')
    setOutageFlag(P1, 'tmux-unavailable')
    setOutageFlag(P2, 'tmux-unavailable')
    const before = emissions.length

    expect(await wrap(P1, WRAP_WORKDIR, call, async () => 'ok')).toBe('ok')

    expect(emissions.slice(before)).toEqual([
      { key: P1, text: allClearOf([['ad-unreachable', '/bin/ad'], ['tmux-unavailable', undefined]]) },
    ])
    expect(getOutageFlags(P1).size).toBe(0)
    expect([...getOutageFlags(P2)]).toEqual(['tmux-unavailable'])
  })

  test.each(wrapRows(NON_CLEARING_CALLS))('%s, %s (not tmux-touching): a success leaves it raised and posts nothing, but clears ad-unreachable silently; a later tmux-touching success posts the one all-clear over both', async (_w, _c, wrap, call) => {
    const { emissions } = makeRecordingHarness()
    setOutageFlag(P1, 'ad-unreachable', '/bin/ad')
    setOutageFlag(P1, 'tmux-unavailable')
    const before = emissions.length

    expect(await wrap(P1, WRAP_WORKDIR, call, async () => 'ok')).toBe('ok')
    expect(emissions.length).toBe(before)
    expect([...getOutageFlags(P1)]).toEqual(['tmux-unavailable'])

    // The same call does it again: still raised, still silent.
    await wrap(P1, WRAP_WORKDIR, call, async () => 'ok')
    expect(emissions.length).toBe(before)
    expect([...getOutageFlags(P1)]).toEqual(['tmux-unavailable'])

    // tmux answers: the one all-clear names both classes of the stretch.
    await withOutageDetection(P1, WRAP_WORKDIR, 'read-pane', async () => 'ok')
    expect(emissions.slice(before)).toEqual([
      { key: P1, text: allClearOf([['ad-unreachable', '/bin/ad'], ['tmux-unavailable', undefined]]) },
    ])
    expect(getOutageFlags(P1).size).toBe(0)
  })

  test.each(wrapRows(NON_CLEARING_CALLS))('%s, %s (not tmux-touching): a success still clears ad-unreachable raised alone, with its all-clear', async (_w, _c, wrap, call) => {
    const { emissions } = makeRecordingHarness()
    setOutageFlag(P1, 'ad-unreachable', '/bin/ad')
    const before = emissions.length

    await wrap(P1, WRAP_WORKDIR, call, async () => 'ok')

    expect(emissions.slice(before)).toEqual([{ key: P1, text: allClearOf([['ad-unreachable', '/bin/ad']]) }])
    expect(getOutageFlags(P1).size).toBe(0)
  })

  test.each(wrapRows(CLEARING_CALLS))('%s, tmux-touching %s: each GONE answer clears it with one all-clear and rethrows the same value', async (_w, _c, wrap, call) => {
    for (const [form, build] of GONE_ANSWERS) {
      const err = build()
      const { emissions } = makeRecordingHarness()
      setOutageFlag(P1, 'tmux-unavailable')
      const before = emissions.length

      const rejected = await rejectionFrom(wrap, P1, call, err)

      expect({ form, same: rejected === err }).toEqual({ form, same: true })
      expect({ form, flags: [...getOutageFlags(P1)] }).toEqual({ form, flags: [] })
      expect({ form, posted: emissions.slice(before) }).toEqual({
        form,
        posted: [{ key: P1, text: allClearOf([['tmux-unavailable', undefined]]) }],
      })
    }
  })

  test.each(wrapRows(NON_CLEARING_CALLS))('%s, %s (not tmux-touching): a GONE answer leaves it raised, posts nothing and rethrows the same value', async (_w, _c, wrap, call) => {
    for (const [form, build] of GONE_ANSWERS) {
      const err = build()
      const { emissions } = makeRecordingHarness()
      setOutageFlag(P1, 'tmux-unavailable')
      const before = emissions.length

      const rejected = await rejectionFrom(wrap, P1, call, err)

      expect({ form, same: rejected === err }).toEqual({ form, same: true })
      expect({ form, flags: [...getOutageFlags(P1)], posted: emissions.length - before }).toEqual({ form, flags: ['tmux-unavailable'], posted: 0 })
    }
  })

  test.each([...CLEARING_CALLS, ...NON_CLEARING_CALLS].map((call) => [declaredName(call), call] as const))('withSpawnDetection, %s: a success clears cwd-unreachable as before (tmux-touching or not); a failure does not', async (_c, call) => {
    const { emissions } = makeRecordingHarness()
    setOutageFlag(P1, 'cwd-unreachable', WRAP_WORKDIR)

    await rejectionFrom(withSpawnDetection, P1, call, errTmuxSendKeys())
    expect([...getOutageFlags(P1)]).toEqual(['cwd-unreachable'])
    const before = emissions.length

    await withSpawnDetection(P1, WRAP_WORKDIR, call, async () => 'ok')

    expect(emissions.slice(before)).toEqual([{ key: P1, text: allClearOf([['cwd-unreachable', WRAP_WORKDIR]]) }])
    expect(getOutageFlags(P1).size).toBe(0)
  })
})

describe('ENVIRONMENT is reported (b.jg5 SRJ-301, SRJ-311): from any verb for P, in any context', () => {
  /**
   * The ENVIRONMENT answers, each built for the declared verb, with the onset
   * it raises: SRJ-1021's for the different-server form, today's for the others.
   */
  const ENVIRONMENT_FORMS: ReadonlyArray<readonly [string, (verb: string) => unknown, () => string]> = [
    ['plain', (verb) => errTmuxNotAvailable(undefined, verb), () => ONSET_TEMPLATES['tmux-unavailable']()],
    ['a socket not accessible', (verb) => errTmuxNotAvailable(STUB_TMUX_SOCKET_PATH, verb), () => ONSET_TEMPLATES['tmux-unavailable']()],
    ['the different-server form', (verb) => errTmuxNotAvailableDifferentServer(STUB_TMUX_SOCKET_PATH, verb), tmuxServerChangedOnset],
  ]

  test.each(EVERY_WRAPPED_ROW)('%s, %s: each form, in each context, raises P\'s tmux-unavailable with one onset and reports the ENVIRONMENT cause once for P; B gets nothing; rethrown unchanged; no condition start', async (_w, _c, wrap, call) => {
    const verb = adCallVerb(call)!
    for (const [form, build, onset] of ENVIRONMENT_FORMS) {
      for (const context of CONTEXTS) {
        const err = build(verb)
        const { emissions, arms, starts } = makeRecordingHarness()

        const { result: rejected, lastError } = await runIn(context, () => rejectionFrom(wrap, P1, call, err))

        const at = { form, context }
        expect({ ...at, same: rejected === err }).toEqual({ ...at, same: true })
        expect({ ...at, arms: arms.map((a) => ({ key: a.key, kind: a.kind, same: a.error === err })) })
          .toEqual({ ...at, arms: [{ key: P1, kind: UNAVAILABLE_RETRY_CAUSE_ENVIRONMENT, same: true }] })
        expect({ ...at, flags: [...getOutageFlags(P1)], b: [...getOutageFlags(P2)] }).toEqual({ ...at, flags: ['tmux-unavailable'], b: [] })
        expect({ ...at, emissions }).toEqual({ ...at, emissions: [{ key: P1, text: onset() }] })
        // SRJ-307: only UNAVAILABLE starts tmux-unresponsive, never ENVIRONMENT.
        expect({ ...at, starts }).toEqual({ ...at, starts: [] })
        // Inside P's attempt the attempt records it armed (the launch is refused, never counted);
        // inside Q's attempt, Q's attempt records nothing of P's error.
        const expected = context === 'inside P\'s attempt' ? { verb, causeKind: UNAVAILABLE_RETRY_CAUSE_ENVIRONMENT, armed: true } : undefined
        expect({ ...at, lastError }).toEqual({ ...at, lastError: expected })
      }
    }
  })

  test.each([...CONTEXTS])('through reportAgentDirectorError (the liveness adapter\'s bare status), %s: each form reports the ENVIRONMENT cause once for P; no flag, no notice; B gets nothing', async (context) => {
    for (const [form, build] of ENVIRONMENT_FORMS) {
      const err = build('status')
      const { emissions, arms, starts } = makeRecordingHarness()

      const { lastError } = await runIn(context, () => reportAgentDirectorError(P1, err, 'status'))

      expect({ form, arms: arms.map((a) => ({ key: a.key, kind: a.kind, same: a.error === err })) })
        .toEqual({ form, arms: [{ key: P1, kind: UNAVAILABLE_RETRY_CAUSE_ENVIRONMENT, same: true }] })
      expect({ form, flags: getOutageFlags(P1).size + getOutageFlags(P2).size, emissions, starts }).toEqual({ form, flags: 0, emissions: [], starts: [] })
      const expected = context === 'inside P\'s attempt' ? { verb: 'status', causeKind: UNAVAILABLE_RETRY_CAUSE_ENVIRONMENT, armed: true } : undefined
      expect({ form, lastError }).toEqual({ form, lastError: expected })
    }
  })

  test.each([...CONTEXTS])('with no sink installed, %s: nothing is reported; the flag, onset and rethrow are as with one', async (context) => {
    const err = errTmuxNotAvailable(undefined, 'resume')
    const { emissions } = makeRecordingHarness({ sink: false })

    const { result: rejected, lastError } = await runIn(context, () => rejectionFrom(withSpawnDetection, P1, 'resume', err))
    const direct = await runIn(context, () => reportAgentDirectorError(P1, err, 'status'))

    expect(rejected).toBe(err)
    expect([...getOutageFlags(P1)]).toEqual(['tmux-unavailable'])
    expect(emissions).toEqual([{ key: P1, text: ONSET_TEMPLATES['tmux-unavailable']() }])
    const recorded = (v: string) => context === 'inside P\'s attempt' ? { verb: v, causeKind: UNAVAILABLE_RETRY_CAUSE_ENVIRONMENT, armed: false } : undefined
    expect(lastError).toEqual(recorded('resume'))
    expect(direct.lastError).toEqual(recorded('status'))
  })

  /** Errors of other classes that arm only inside an attempt for P. */
  const OTHER_CLASSES: ReadonlyArray<readonly [string, AdCall, () => unknown]> = [
    ['UNAVAILABLE (ErrCallTimeout) from status', 'status', () => errCallTimeout('status')],
    ['UNAVAILABLE (ErrTmuxUnresponsive) from resume', 'resume', () => errTmuxUnresponsive('resume')],
    ['ErrTmuxKillFailed from a kill of a live row', AD_CALL_KILL_ROW_READ_LIVE, () => errTmuxKillFailed()],
    ['a read error (ErrSystemInstallDisappeared) from status', 'status', () => errSystemInstallDisappeared('status', '/bin/ad')],
    ['a read error (a STATE error) from get', 'get', () => errInstanceIdCollision()],
    ['GONE from send-keys', 'send-keys', () => errTmuxSendKeys()],
  ]

  test.each(OTHER_CLASSES)('%s outside any attempt, or inside Q\'s attempt, reports nothing (wrapped or through reportAgentDirectorError)', async (_label, call, build) => {
    const err = build()
    const { arms } = makeRecordingHarness()

    for (const context of ['outside any attempt', 'inside Q\'s attempt'] as const) {
      expect(await runIn(context, () => rejectionFrom(withOutageDetection, P1, call, err)).then((r) => r.result)).toBe(err)
      await runIn(context, () => reportAgentDirectorError(P1, err, call))
    }

    expect(arms).toEqual([])
  })

  test('AD rev 23: after a kill of the last persona on a socket, repeated ErrTmuxNotAvailable posts one onset (each report arms P); tmux answering posts one all-clear; nothing latches', async () => {
    const { emissions, arms } = makeRecordingHarness()

    await withOutageDetection(P1, WRAP_WORKDIR, AD_CALL_KILL_ROW_READ_LIVE, async () => 'ok')
    await rejectionFrom(withOutageDetection, P1, AD_CALL_KILL_ROW_READ_LIVE, errTmuxNotAvailable(undefined, 'kill'))
    await rejectionFrom(withOutageDetection, P1, 'status', errTmuxNotAvailable(undefined, 'status'))
    await rejectionFrom(withSpawnDetection, P1, 'spawn', errTmuxNotAvailable(undefined, 'spawn'))

    expect(emissions).toEqual([{ key: P1, text: ONSET_TEMPLATES['tmux-unavailable']() }])
    expect(arms.map((a) => [a.key, a.kind])).toEqual([
      [P1, UNAVAILABLE_RETRY_CAUSE_ENVIRONMENT],
      [P1, UNAVAILABLE_RETRY_CAUSE_ENVIRONMENT],
      [P1, UNAVAILABLE_RETRY_CAUSE_ENVIRONMENT],
    ])

    // A read that succeeds while tmux is still unusable ends nothing.
    await withOutageDetection(P1, WRAP_WORKDIR, 'status', async () => 'ok')
    expect(emissions).toHaveLength(1)

    await withSpawnDetection(P1, WRAP_WORKDIR, 'spawn', async () => 'ok')
    expect(emissions.slice(1)).toEqual([{ key: P1, text: allClearOf([['tmux-unavailable', undefined]]) }])
    expect(getOutageFlags(P1).size).toBe(0)

    // Not latched: the next ENVIRONMENT answer is a fresh onset.
    await rejectionFrom(withOutageDetection, P1, 'read-pane', errTmuxNotAvailable(undefined, 'read-pane'))
    expect(emissions.slice(2)).toEqual([{ key: P1, text: ONSET_TEMPLATES['tmux-unavailable']() }])
  })

  test('the error text reaches no notice, flag or attempt record (leak check)', async () => {
    const err = errTmuxNotAvailable(sentinelInMessage('resume'), 'resume')
    const { emissions, arms } = makeRecordingHarness()

    const { result: rejected, lastError } = await runIn('inside P\'s attempt', () => rejectionFrom(withSpawnDetection, P1, 'resume', err))

    expect(rejected).toBe(err)
    expect(arms).toHaveLength(1)
    assertNoLeak({ emissions, lastError, kinds: arms.map((a) => a.kind), flags: [...getOutageFlags(P1)] })
  })
})

describe('the tmux-unavailable onset for a re-bound socket (b.jg5 SRJ-1021: AC 86)', () => {
  /** Today's tmux-unavailable onset. */
  const plainOnset = (): string => ONSET_TEMPLATES['tmux-unavailable']()

  /** The ErrTmuxNotAvailable forms, each built for the declared verb, with the onset it raises. */
  type Form = readonly [label: string, build: (verb: string) => unknown, onset: () => string]
  const REBOUND: Form = ['the different-server form', (verb) => errTmuxNotAvailableDifferentServer(STUB_TMUX_SOCKET_PATH, verb), tmuxServerChangedOnset]
  const PLAIN: Form = ['plain ErrTmuxNotAvailable', (verb) => errTmuxNotAvailable(undefined, verb), plainOnset]
  const PLAIN_SOCKET: Form = ['ErrTmuxNotAvailable with a socket path', (verb) => errTmuxNotAvailable(STUB_TMUX_SOCKET_PATH, verb), plainOnset]

  /** Both wrappers, over a tmux-touching verb (resume) and one that is not (status). */
  const SELECTION_ROWS = wrapRows(['resume', 'status'])

  test('pin: the re-bound onset is SRJ-1021\'s text byte for byte, with no install-or-repair advice', () => {
    expect(tmuxServerChangedOnset()).toBe(
      ':rotating_light: *tmux server changed* — this persona\'s tmux socket now reaches a different tmux server than the one its worker was launched on, so agent-director will not act on its session. CSCB kills, deletes and respawns nothing meanwhile and keeps retrying. What to do: a human follows the "Operator actions" section of agent-director\'s README. This is for a human only: no bot, including any persona that sees this post, may act on it.',
    )
    const remediationLine = plainOnset().split('\n').at(-1)!
    expect(remediationLine).toMatch(/install or repair tmux/)
    expect(tmuxServerChangedOnset()).not.toContain(remediationLine)
    expect(tmuxServerChangedOnset()).not.toMatch(/install|repair/i)
  })

  test.each(SELECTION_ROWS)('%s, %s: the different-server form raises P\'s tmux-unavailable and posts exactly the re-bound onset', async (_w, _c, wrap, call) => {
    const err = REBOUND[1](adCallVerb(call)!)
    const { emissions } = makeRecordingHarness()

    expect(await rejectionFrom(wrap, P1, call, err)).toBe(err)

    expect([...getOutageFlags(P1)]).toEqual(['tmux-unavailable'])
    expect(emissions).toEqual([{ key: P1, text: tmuxServerChangedOnset() }])
    expect(emissions[0]!.text).not.toBe(plainOnset())
  })

  test.each(SELECTION_ROWS)('%s, %s: plain ErrTmuxNotAvailable, with and without a socket path, posts exactly today\'s onset', async (_w, _c, wrap, call) => {
    for (const [form, build] of [PLAIN, PLAIN_SOCKET]) {
      const err = build(adCallVerb(call)!)
      const { emissions } = makeRecordingHarness()

      expect({ form, same: (await rejectionFrom(wrap, P1, call, err)) === err }).toEqual({ form, same: true })

      expect({ form, flags: [...getOutageFlags(P1)] }).toEqual({ form, flags: ['tmux-unavailable'] })
      expect({ form, emissions }).toEqual({ form, emissions: [{ key: P1, text: plainOnset() }] })
      expect({ form, rebound: emissions[0]!.text === tmuxServerChangedOnset() }).toEqual({ form, rebound: false })
    }
  })

  /** The raise routes: a wrapper's ENVIRONMENT branch, and the one raise entry called directly (as the liveness adapter and the sweep do). */
  type RaiseRoute = readonly [label: string, raise: (err: unknown) => Promise<unknown> | void]
  const RAISE_ROUTES: readonly RaiseRoute[] = [
    ['withOutageDetection (read-pane)', (err) => rejectionFrom(withOutageDetection, P1, 'read-pane', err)],
    ['withSpawnDetection (resume)', (err) => rejectionFrom(withSpawnDetection, P1, 'resume', err)],
    ['raiseTmuxUnavailable', (err) => raiseTmuxUnavailable(P1, err)],
  ]

  /** The all-clear a plain tmux-unavailable stretch posts, through the same route and the same clearing success. */
  async function plainStretchAllClear(raise: RaiseRoute[1]): Promise<string> {
    const { emissions } = makeRecordingHarness()
    await raise(PLAIN[1]('resume'))
    await withOutageDetection(P1, WRAP_WORKDIR, 'read-pane', async () => 'ok')
    expect(emissions).toHaveLength(2)
    return emissions[1]!.text
  }

  test.each(RAISE_ROUTES)('all-clear, %s: after a re-bound onset the clear posts the text a plain stretch gets, with no description in it', async (_label, raise) => {
    const plainAllClear = await plainStretchAllClear(raise)
    const err = errTmuxNotAvailableDifferentServer(STUB_TMUX_SOCKET_PATH, 'resume')
    const { emissions } = makeRecordingHarness()

    await raise(err)
    await withOutageDetection(P1, WRAP_WORKDIR, 'read-pane', async () => 'ok')

    expect(emissions).toEqual([
      { key: P1, text: tmuxServerChangedOnset() },
      { key: P1, text: plainAllClear },
    ])
    expect(plainAllClear).toBe(allClearOf([['tmux-unavailable', undefined]]))
    expect(emissions[1]!.text).not.toContain(DIFFERENT_TMUX_SERVER_PHRASE)
    expect(emissions[1]!.text).not.toContain(STUB_TMUX_SOCKET_PATH)
    expect(getOutageFlags(P1).size).toBe(0)
  })

  /** Both orders of the two forms. */
  const ORDERS: ReadonlyArray<readonly [string, Form, Form]> = [
    ['re-bound then plain', REBOUND, PLAIN],
    ['plain then re-bound', PLAIN, REBOUND],
  ]

  test.each(ORDERS)('dedupe, %s: while the flag is raised by one form, the other form posts nothing (wrapped or direct); after the clear, it posts its own onset', async (_label, [, first, firstOnset], [, second, secondOnset]) => {
    const { emissions } = makeRecordingHarness()

    await rejectionFrom(withSpawnDetection, P1, 'resume', first('resume'))
    await rejectionFrom(withOutageDetection, P1, 'read-pane', second('read-pane'))
    await rejectionFrom(withOutageDetection, P1, 'status', second('status'))
    raiseTmuxUnavailable(P1, second('resume'))

    expect(emissions).toEqual([{ key: P1, text: firstOnset() }])
    expect([...getOutageFlags(P1)]).toEqual(['tmux-unavailable'])

    // tmux answers: one all-clear; the next stretch's onset is chosen by its own first error.
    await withSpawnDetection(P1, WRAP_WORKDIR, 'spawn', async () => 'ok')
    await rejectionFrom(withOutageDetection, P1, 'send-keys', second('send-keys'))

    expect(emissions).toEqual([
      { key: P1, text: firstOnset() },
      { key: P1, text: allClearOf([['tmux-unavailable', undefined]]) },
      { key: P1, text: secondOnset() },
    ])
  })

  test('isolation: P\'s re-bound onset leaves B silent and unflagged; B\'s own plain error then posts B\'s own today\'s onset', async () => {
    const { emissions } = makeRecordingHarness()

    await rejectionFrom(withSpawnDetection, P1, 'resume', REBOUND[1]('resume'))

    expect(emissions).toEqual([{ key: P1, text: tmuxServerChangedOnset() }])
    expect(getOutageFlags(P2).size).toBe(0)

    await rejectionFrom(withOutageDetection, P2, 'read-pane', PLAIN[1]('read-pane'))

    expect(emissions).toEqual([
      { key: P1, text: tmuxServerChangedOnset() },
      { key: P2, text: plainOnset() },
    ])
  })

  /** Values handed to raiseTmuxUnavailable directly, with the onset each must post. */
  const DIRECT: ReadonlyArray<readonly [string, () => unknown, () => string]> = [
    ['the different-server form', () => errTmuxNotAvailableDifferentServer(), tmuxServerChangedOnset],
    ['plain ErrTmuxNotAvailable', () => errTmuxNotAvailable(undefined, 'status'), plainOnset],
    ['ErrTmuxNotAvailable with a socket path', () => errTmuxNotAvailable(STUB_TMUX_SOCKET_PATH, 'status'), plainOnset],
    ['another class carrying the different-server words (ErrTmuxUnresponsive)', () => errTmuxUnresponsive('resume', `the tmux server is ${DIFFERENT_TMUX_SERVER_PHRASE}; nothing was done`), plainOnset],
    ['a plain Error carrying the different-server words', () => new Error(DIFFERENT_TMUX_SERVER_PHRASE), plainOnset],
    ['undefined', () => undefined, plainOnset],
  ]

  test.each(DIRECT)('raiseTmuxUnavailable, %s: raises P\'s tmux-unavailable with its onset, records no detail (the all-clear is today\'s), and a second raise posts nothing', (_label, build, onset) => {
    const { emissions } = makeRecordingHarness()

    raiseTmuxUnavailable(P1, build())
    raiseTmuxUnavailable(P1, build())

    expect(emissions).toEqual([{ key: P1, text: onset() }])
    expect([...getOutageFlags(P1)]).toEqual(['tmux-unavailable'])
    expect(getOutageFlags(P2).size).toBe(0)

    clearOutageFlag(P1, 'tmux-unavailable')
    expect(emissions.slice(1)).toEqual([{ key: P1, text: allClearOf([['tmux-unavailable', undefined]]) }])
  })

  test('raiseTmuxUnavailable before initOutageState does nothing and does not throw', () => {
    _resetOutageState()
    expect(() => raiseTmuxUnavailable(P1, errTmuxNotAvailableDifferentServer())).not.toThrow()
    expect(getOutageFlags(P1).size).toBe(0)
  })

  test('the description reaches neither the re-bound onset nor its all-clear (leak check)', async () => {
    const err = errTmuxNotAvailableDifferentServer(sentinelInMessage('resume'), 'resume')
    const { emissions } = makeRecordingHarness()

    await rejectionFrom(withSpawnDetection, P1, 'resume', err)
    await withSpawnDetection(P1, WRAP_WORKDIR, 'resume', async () => 'ok')

    expect(emissions.map((e) => e.text)).toEqual([tmuxServerChangedOnset(), allClearOf([['tmux-unavailable', undefined]])])
    assertNoLeak({ emissions, flags: [...getOutageFlags(P1)] })
  })
})

describe('the cleared-flag observer (b.jg5 SRJ-305, SRJ-311)', () => {
  /** A real clear of P's tmux-unavailable, by route, and the reading the observer must get. */
  type Route = readonly [label: string, clear: () => Promise<unknown> | void, reading: string | undefined]
  const ROUTES: readonly Route[] = [
    ['clearOutageFlag with no reading', () => clearOutageFlag(P1, 'tmux-unavailable'), undefined],
    ['clearOutageFlag with a check\'s live reading (the tick\'s healthy branch, a retry\'s healthy row)', () => clearOutageFlag(P1, 'tmux-unavailable', LIVENESS_LIVE), LIVENESS_LIVE],
    ['a launch success: spawn through withSpawnDetection', () => withSpawnDetection(P1, WRAP_WORKDIR, 'spawn', async () => 'ok'), UNAVAILABLE_RETRY_ROW_PENDING],
    ['a launch success: resume through withSpawnDetection', () => withSpawnDetection(P1, WRAP_WORKDIR, 'resume', async () => 'ok'), UNAVAILABLE_RETRY_ROW_PENDING],
    ['a launch success: spawn through withOutageDetection', () => withOutageDetection(P1, WRAP_WORKDIR, 'spawn', async () => 'ok'), UNAVAILABLE_RETRY_ROW_PENDING],
    ['a non-launch tmux-touching success: read-pane', () => withOutageDetection(P1, WRAP_WORKDIR, 'read-pane', async () => 'ok'), undefined],
    ['a non-launch tmux-touching success: send-keys', () => withOutageDetection(P1, WRAP_WORKDIR, 'send-keys', async () => 'ok'), undefined],
    ['a non-launch tmux-touching success: pause', () => withOutageDetection(P1, WRAP_WORKDIR, 'pause', async () => 'ok'), undefined],
    ['a non-launch tmux-touching success: a kill of a live row', () => withOutageDetection(P1, WRAP_WORKDIR, AD_CALL_KILL_ROW_READ_LIVE, async () => 'ok'), undefined],
    ['a GONE answer from send-keys', () => rejectionFrom(withOutageDetection, P1, 'send-keys', errTmuxSendKeys()), undefined],
    ['a GONE answer from read-pane', () => rejectionFrom(withOutageDetection, P1, 'read-pane', errTmuxCaptureFailed()), undefined],
    ['a GONE answer from a launch call (spawn): no pending reading', () => rejectionFrom(withSpawnDetection, P1, 'spawn', errTmuxSendKeys()), undefined],
  ]

  test.each(ROUTES)('a real clear of P\'s tmux-unavailable by %s calls it once with P, the class and the reading, after the state change and the all-clear', async (_label, clear, reading) => {
    const seen: Array<{ flags: OutageClass[]; posted: number }> = []
    const h = makeRecordingHarness({ onClear: () => { seen.push({ flags: [...getOutageFlags(P1)], posted: h.emissions.length }) } })
    setOutageFlag(P1, 'tmux-unavailable')
    setOutageFlag(P2, 'tmux-unavailable')

    await clear()

    expect(h.cleared).toEqual([{ key: P1, cls: 'tmux-unavailable', reading }])
    // Called after the flag is lowered and after the all-clear was posted.
    expect(seen).toEqual([{ flags: [], posted: 2 + 1 }])
    expect(h.emissions.at(-1)).toEqual({ key: P1, text: allClearOf([['tmux-unavailable', undefined]]) })
    expect([...getOutageFlags(P2)]).toEqual(['tmux-unavailable'])
  })

  test('each class\'s real clear is told with its class: a launch success over all four calls it in clear order, the reading on tmux-unavailable only', async () => {
    const { cleared } = makeRecordingHarness()
    setOutageFlag(P1, 'ad-unreachable', '/bin/ad')
    setOutageFlag(P1, 'tmux-unavailable')
    setOutageFlag(P1, 'cwd-unreachable', WRAP_WORKDIR)
    raiseAdConfigMalformed(P1, errConfigMalformed())

    await withSpawnDetection(P1, WRAP_WORKDIR, 'resume', async () => 'ok')

    expect(cleared).toEqual([
      { key: P1, cls: 'ad-unreachable', reading: undefined },
      { key: P1, cls: 'ad-config-malformed', reading: undefined },
      { key: P1, cls: 'tmux-unavailable', reading: UNAVAILABLE_RETRY_ROW_PENDING },
      { key: P1, cls: 'cwd-unreachable', reading: undefined },
    ])
  })

  test('a clear of a flag that is not raised calls nothing: a never-touched key, another class, a second clear, a non-tmux-touching success or GONE', async () => {
    const { cleared } = makeRecordingHarness()

    clearOutageFlag(P9, 'tmux-unavailable')
    setOutageFlag(P1, 'tmux-unavailable')
    clearOutageFlag(P1, 'ad-unreachable')
    clearOutageFlag(P1, 'cwd-unreachable', LIVENESS_LIVE)
    for (const call of NON_CLEARING_CALLS) {
      await withOutageDetection(P1, WRAP_WORKDIR, call, async () => 'ok')
      await rejectionFrom(withOutageDetection, P1, call, errTmuxSendKeys())
    }
    expect(cleared).toEqual([])

    clearOutageFlag(P1, 'tmux-unavailable')
    clearOutageFlag(P1, 'tmux-unavailable')
    await withOutageDetection(P1, WRAP_WORKDIR, 'read-pane', async () => 'ok')

    expect(cleared).toEqual([{ key: P1, cls: 'tmux-unavailable', reading: undefined }])
  })

  test('resetAllToHealthy (boot, teardown) calls nothing, and a later clear of the wiped flag calls nothing', () => {
    const { cleared, emissions } = makeRecordingHarness()
    setOutageFlag(P1, 'tmux-unavailable')
    setOutageFlag(P1, 'ad-unreachable', '/bin/ad')
    setOutageFlag(P2, 'tmux-unavailable')

    resetAllToHealthy([P1])
    resetAllToHealthy([P1, P2])
    clearOutageFlag(P1, 'tmux-unavailable')
    clearOutageFlag(P2, 'tmux-unavailable')

    expect(cleared).toEqual([])
    expect(emissions).toHaveLength(3) // the three onsets only
  })

  test('an observer that throws changes nothing: the flag is lowered, the all-clear posted, the wrapper answers its result, and the next clear is told again', async () => {
    const { cleared, emissions } = makeRecordingHarness({ observerThrows: true })
    setOutageFlag(P1, 'tmux-unavailable')

    expect(() => clearOutageFlag(P1, 'tmux-unavailable')).not.toThrow()
    expect(getOutageFlags(P1).size).toBe(0)
    expect(emissions.at(-1)).toEqual({ key: P1, text: allClearOf([['tmux-unavailable', undefined]]) })

    setOutageFlag(P1, 'tmux-unavailable')
    expect(await withSpawnDetection(P1, WRAP_WORKDIR, 'spawn', async () => 'ok')).toBe('ok')
    expect(getOutageFlags(P1).size).toBe(0)
    expect(cleared).toEqual([
      { key: P1, cls: 'tmux-unavailable', reading: undefined },
      { key: P1, cls: 'tmux-unavailable', reading: UNAVAILABLE_RETRY_ROW_PENDING },
    ])
  })

  test('with no observer installed, a clear works as before', async () => {
    const { emissions } = makeRecordingHarness({ observer: false })
    setOutageFlag(P1, 'tmux-unavailable')

    await withOutageDetection(P1, WRAP_WORKDIR, 'send-keys', async () => 'ok')

    expect(getOutageFlags(P1).size).toBe(0)
    expect(emissions.at(-1)).toEqual({ key: P1, text: allClearOf([['tmux-unavailable', undefined]]) })
  })
})

// ---------------------------------------------------------------------------
// b.jg5 SRJ-316, SRJ-312, SRJ-1018, SRJ-301 — the ad-config-malformed outage
// a CONFIG answer (`ErrConfigMalformed`) raises: its onset, raise, clear,
// report, the stable class order, and the version re-check (AC 84)
// ---------------------------------------------------------------------------

describe('the ad-config-malformed outage (b.jg5 SRJ-316, SRJ-312, SRJ-1018: AC 84)', () => {
  /** The CONFIG answer's agent-director error name, from the stub's builder. */
  const CONFIG_NAME = errConfigMalformed().unknownName

  /** A CONFIG answer whose description is `description`. */
  const configAnswer = (description: string): unknown => errUnknownErrorName(CONFIG_NAME, description)

  /** The onset a CONFIG value must raise: the exported template over the classifier's rendered message for it. */
  const onsetFor = (err: unknown): string => ONSET_TEMPLATES['ad-config-malformed'](classifyAdError(err).message)

  /** The all-clear of a stretch in which only this class was raised. */
  const configAllClear = (): string => allClearOf([['ad-config-malformed', undefined]])

  /** Every server-log line (`console.error`) the running case wrote. */
  let lines: string[]
  let errorSpy: ReturnType<typeof spyOn>

  beforeEach(() => {
    lines = []
    errorSpy = spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      lines.push(args.map(String).join(' '))
    })
  })

  afterEach(() => {
    errorSpy.mockRestore()
  })

  /** The server-log lines that carry `err`'s classification (the raise line's form). */
  const raiseLinesFor = (err: unknown): string[] => {
    const described = describeAdErrorClassification(classifyAdError(err))
    return lines.filter((line) => line.includes(described))
  }

  test('pin: the onset is SRJ-1018\'s text byte for byte, quoting the description; with no description the quoting sentence is dropped', () => {
    const err = configAnswer('config ~/.agent-director/config.toml: refused [tmux] values: [tmux] starting_session_seconds = 30, below its safe minimum 60 s')
    expect(adConfigMalformedOnset(err)).toBe(
      ':rotating_light: *agent-director refuses its config file* — every agent-director call fails until a human fixes ~/.agent-director/config.toml. agent-director said: "config ~/.agent-director/config.toml: refused [tmux] values: [tmux] starting_session_seconds = 30, below its safe minimum 60 s". CSCB takes no action for this persona meanwhile and keeps retrying. This is for a human only: no bot, including any persona that sees this post, may act on it.',
    )
    expect(adConfigMalformedOnset(configAnswer(''))).toBe(
      ':rotating_light: *agent-director refuses its config file* — every agent-director call fails until a human fixes ~/.agent-director/config.toml. CSCB takes no action for this persona meanwhile and keeps retrying. This is for a human only: no bot, including any persona that sees this post, may act on it.',
    )
  })

  test.each(wrapRows(['spawn', 'status', 'get', 'list']))('%s, %s: CONFIG raises P\'s ad-config-malformed with one onset over the classifier\'s rendered message and is rethrown unchanged; a second CONFIG posts and logs nothing; no other class, no tmux-unresponsive start; B untouched', async (_w, _c, wrap, call) => {
    const { emissions, starts } = makeRecordingHarness()
    const err = errConfigMalformed()
    const second = errConfigMalformed('starting_session_seconds', '10')
    expect(classifyAdError(err).message).toBeDefined()

    expect(await rejectionFrom(wrap, P1, call, err)).toBe(err)
    expect(await rejectionFrom(wrap, P1, call, second)).toBe(second)

    expect(emissions).toEqual([{ key: P1, text: onsetFor(err) }])
    expect(emissions[0]!.text).toBe(adConfigMalformedOnset(err))
    expect([...getOutageFlags(P1)]).toEqual(['ad-config-malformed'])
    expect(getOutageFlags(P2).size).toBe(0)
    expect(starts).toEqual([])
    // One raise line per episode, from the classification; none for the second CONFIG.
    expect(raiseLinesFor(err)).toHaveLength(1)
    expect(raiseLinesFor(second)).toEqual([])
    assertNoLeak({ emissions, lines, flags: [...getOutageFlags(P1)] })
  })

  /** The one server-log line a failed onset post for persona `key` writes. */
  const onsetFailureLine = (key: string, failure: unknown): string =>
    `[slack] outage-state: onset notice for persona=${key} failed: ${describeThrownValue(failure)} — the flag stays raised; the notice counts as posted`

  /** The server-log lines that report a failed onset post (any persona). */
  const onsetFailureLines = (): string[] => lines.filter((line) => line.includes('outage-state: onset notice for persona='))

  /** How a notify can fail: it throws the failure, or answers a promise that rejects with it. */
  const NOTIFY_FAILURES: ReadonlyArray<readonly [form: string, fail: (failure: Error) => unknown]> = [
    ['a notify that throws', (failure) => { throw failure }],
    ['a notify whose promise rejects', (failure) => Promise.reject(failure)],
  ]

  /** A failure whose message carries a fake token and URL, so the failure line is leak-checked. */
  const notifyFailure = (): Error => new Error(`slack post failed (${sentinelInMessage('notify')})`)

  /**
   * A fresh outage state whose notify records every call and then fails as
   * `fail` does, with a recording trigger sink.
   */
  function makeFailingNotifyHarness(fail: (failure: Error) => unknown, failure: Error): { calls: Emission[]; arms: RecordedArm[] } {
    const calls: Emission[] = []
    const arms: RecordedArm[] = []
    const client = makeStubClient()
    _resetOutageState()
    initOutageState({
      notify: (key, text) => {
        calls.push({ key, text })
        return fail(failure)
      },
      getClient: () => client as unknown as Client,
      triggerSink: { arm: (key: string, cause: UnavailableRetryCause) => { arms.push({ key, kind: cause.kind, error: cause.error }); return true } },
    })
    return { calls, arms }
  }

  /** Let every queued promise reaction (a rejected notify's handler) run. */
  const settle = (): Promise<void> => new Promise((done) => setTimeout(done, 0))

  test.each(NOTIFY_FAILURES.flatMap(([form, fail]) => wrapRows(['status', 'spawn']).map(([w, c, wrap, call]) => [form, w, c, wrap, call, fail] as const)))('%s, %s, %s: one failure line, the flag stays raised, the wrapper reports and rethrows the original CONFIG value; a second CONFIG calls notify not at all', async (_form, _w, _c, wrap, call, fail) => {
    const failure = notifyFailure()
    const { calls, arms } = makeFailingNotifyHarness(fail, failure)
    const err = errConfigMalformed()
    const second = errConfigMalformed('starting_session_seconds', '10')

    expect(await rejectionFrom(wrap, P1, call, err)).toBe(err)
    await settle()

    expect(calls).toEqual([{ key: P1, text: onsetFor(err) }])
    expect(onsetFailureLines()).toEqual([onsetFailureLine(P1, failure)])
    expect([...getOutageFlags(P1)]).toEqual(['ad-config-malformed'])
    expect(arms.map((a) => ({ key: a.key, kind: a.kind, same: a.error === err }))).toEqual([{ key: P1, kind: UNAVAILABLE_RETRY_CAUSE_CONFIG, same: true }])
    expect(raiseLinesFor(err)).toHaveLength(1)

    // The onset counts as posted: the next CONFIG is deduped, reported and rethrown, and notify is not called.
    expect(await rejectionFrom(wrap, P1, call, second)).toBe(second)
    await settle()

    expect(calls).toHaveLength(1)
    expect(onsetFailureLines()).toHaveLength(1)
    expect(raiseLinesFor(second)).toEqual([])
    expect([...getOutageFlags(P1)]).toEqual(['ad-config-malformed'])
    expect(arms.map((a) => a.error === second)).toEqual([false, true])
    assertNoLeak({ calls, lines })
  })

  test.each(NOTIFY_FAILURES)('raiseAdConfigMalformed, %s: never throws, logs one failure line, leaves the flag raised', async (_form, fail) => {
    const failure = notifyFailure()
    const { calls } = makeFailingNotifyHarness(fail, failure)
    const err = errConfigMalformed()

    expect(() => raiseAdConfigMalformed(P1, err)).not.toThrow()
    await settle()

    expect(calls).toEqual([{ key: P1, text: onsetFor(err) }])
    expect(onsetFailureLines()).toEqual([onsetFailureLine(P1, failure)])
    expect([...getOutageFlags(P1)]).toEqual(['ad-config-malformed'])
    expect(raiseLinesFor(err)).toHaveLength(1)
    assertNoLeak({ calls, lines })
  })

  /** `REDACTED_SENTINEL_TAIL` as the onset shows it: its placeholders' `<` and `>` escaped. */
  const ESCAPED_SENTINEL_TAIL = REDACTED_SENTINEL_TAIL.split('<').join('&lt;').split('>').join('&gt;')

  /**
   * Descriptions agent-director may give, and what the onset and the
   * server-log raise line must show for each. The onset escapes Slack's
   * control characters after redaction, flattening and the cap; the raise
   * line quotes the redacted text unescaped.
   */
  const DESCRIPTIONS: ReadonlyArray<readonly [label: string, description: string, check: (onset: string, raiseLine: string) => void]> = [
    [
      'carrying fake tokens and a URL: redacted in place, the placeholders escaped in the onset only',
      `refused (${sentinelInMessage('config')}) and (${sentinelInMessage('config-app', APP_TOKEN_PREFIX)})`,
      (onset, raiseLine) => {
        expect(ESCAPED_SENTINEL_TAIL).toBe('&lt;redacted-token&gt; &lt;redacted-url&gt;')
        expect(onset).toContain(` agent-director said: "refused (${ESCAPED_SENTINEL_TAIL}) and (${ESCAPED_SENTINEL_TAIL})".`)
        expect(onset).not.toContain(REDACTED_SENTINEL_TAIL)
        expect(raiseLine).toContain(`message="refused (${REDACTED_SENTINEL_TAIL}) and (${REDACTED_SENTINEL_TAIL})"`)
        expect(raiseLine).not.toContain('&lt;')
      },
    ],
    [
      'carrying <!channel>, <@U…> and &: escaped in the onset so the post renders them as text and pings no one; unescaped in the raise line',
      'fix <!channel> and <@U0123ABCD> & <!here|here> > soon',
      (onset, raiseLine) => {
        expect(onset).toContain(' agent-director said: "fix &lt;!channel&gt; and &lt;@U0123ABCD&gt; &amp; &lt;!here|here&gt; &gt; soon".')
        expect(onset).not.toMatch(/<[!@]/)
        expect(raiseLine).toContain('message="fix <!channel> and <@U0123ABCD> & <!here|here> > soon"')
        expect(raiseLine).not.toMatch(/&(amp|lt|gt);/)
      },
    ],
    [
      'already holding entities: escaped again, so the post shows them as written',
      'value &lt;60&gt; &amp; up',
      (onset, raiseLine) => {
        expect(onset).toContain(' agent-director said: "value &amp;lt;60&amp;gt; &amp;amp; up".')
        expect(raiseLine).toContain('message="value &lt;60&gt; &amp; up"')
      },
    ],
    [
      'of only < characters, longer than MAX_LOGGED_MESSAGE_LENGTH: capped first, then escaped, so no entity is cut',
      '<'.repeat(MAX_LOGGED_MESSAGE_LENGTH + 100),
      (onset, raiseLine) => {
        expect(onset).toContain(` agent-director said: "${'&lt;'.repeat(MAX_LOGGED_MESSAGE_LENGTH - 1)}…".`)
        expect(raiseLine).toContain(`message="${'<'.repeat(MAX_LOGGED_MESSAGE_LENGTH - 1)}…"`)
      },
    ],
    [
      'spread over several lines: on one line',
      'line one\nline two\r\nline three',
      (onset) => {
        expect(onset).toContain('line one line two line three')
        expect(onset).not.toMatch(/[\r\n\u2028\u2029]/)
      },
    ],
    [
      `longer than MAX_LOGGED_MESSAGE_LENGTH: capped`,
      'x'.repeat(MAX_LOGGED_MESSAGE_LENGTH + 100),
      (onset) => {
        expect(onset).toContain('x'.repeat(MAX_LOGGED_MESSAGE_LENGTH - 10))
        expect(onset).not.toContain('x'.repeat(MAX_LOGGED_MESSAGE_LENGTH))
      },
    ],
    [
      'missing (empty): the onset with no quoting sentence',
      '',
      (onset) => expect(onset).toBe(ONSET_TEMPLATES['ad-config-malformed']()),
    ],
    [
      'only whitespace: the onset with no quoting sentence',
      '  \n ',
      (onset) => expect(onset).toBe(ONSET_TEMPLATES['ad-config-malformed']()),
    ],
  ]

  test.each(DESCRIPTIONS)('a description %s; the raised onset is the exported onset for the value; nothing leaks', async (_label, description, check) => {
    const { emissions } = makeRecordingHarness()
    const err = configAnswer(description)

    expect(await rejectionFrom(withOutageDetection, P1, 'status', err)).toBe(err)

    expect(emissions).toEqual([{ key: P1, text: onsetFor(err) }])
    expect(emissions[0]!.text).toBe(adConfigMalformedOnset(err))
    const raiseLines = raiseLinesFor(err)
    expect(raiseLines).toHaveLength(1)
    check(emissions[0]!.text, raiseLines[0]!)
    assertNoLeak({ emissions, lines })
  })

  test.each(wrapRows(EVERY_DECLARED_CALL))('%s, %s: a success clears it with one all-clear listing the bare class and not the description; the observer is told; a second success posts nothing', async (_w, _c, wrap, call) => {
    const { emissions, cleared } = makeRecordingHarness()
    const err = configAnswer(`refused (${sentinelInMessage('config')}) [tmux] starting_session_seconds = 30`)
    await rejectionFrom(withOutageDetection, P1, 'status', err)
    raiseAdConfigMalformed(P2, errConfigMalformed())
    const before = emissions.length

    expect(await wrap(P1, WRAP_WORKDIR, call, async () => 'ok')).toBe('ok')
    await wrap(P1, WRAP_WORKDIR, call, async () => 'ok')

    expect(emissions.slice(before)).toEqual([{ key: P1, text: configAllClear() }])
    expect(emissions.at(-1)!.text).not.toContain(classifyAdError(err).message!)
    expect(getOutageFlags(P1).size).toBe(0)
    expect([...getOutageFlags(P2)]).toEqual(['ad-config-malformed'])
    expect(cleared).toEqual([{ key: P1, cls: 'ad-config-malformed', reading: undefined }])
    assertNoLeak({ emissions, lines })
  })

  test.each(WRAPPERS)('%s: with ad-unreachable also raised, one success clears both with one all-clear in the exported class order', async (_w, wrap) => {
    const { emissions } = makeRecordingHarness()
    await rejectionFrom(wrap, P1, 'status', errConfigMalformed())
    setOutageFlag(P1, 'ad-unreachable', '/bin/ad')
    const before = emissions.length

    await wrap(P1, WRAP_WORKDIR, 'get', async () => 'ok')

    expect(emissions.slice(before)).toEqual([
      { key: P1, text: allClearOf([['ad-unreachable', '/bin/ad'], ['ad-config-malformed', undefined]]) },
    ])
    const text = emissions.at(-1)!.text
    const positions = OUTAGE_CLASS_ORDER.filter((cls) => cls === 'ad-unreachable' || cls === 'ad-config-malformed').map((cls) => text.indexOf(cls))
    expect(positions.every((at) => at >= 0)).toBe(true)
    expect([...positions].sort((a, b) => a - b)).toEqual(positions)
    expect(getOutageFlags(P1).size).toBe(0)
  })

  test.each(wrapRows(NON_CLEARING_CALLS))('%s, %s (not tmux-touching): with tmux-unavailable also raised, a success clears ad-config-malformed silently and tmux-unavailable stays; a later tmux-touching success posts one all-clear over both', async (_w, _c, wrap, call) => {
    const { emissions } = makeRecordingHarness()
    await rejectionFrom(withOutageDetection, P1, 'status', errConfigMalformed())
    setOutageFlag(P1, 'tmux-unavailable')
    const before = emissions.length

    await wrap(P1, WRAP_WORKDIR, call, async () => 'ok')

    expect(emissions.length).toBe(before)
    expect([...getOutageFlags(P1)]).toEqual(['tmux-unavailable'])

    await withOutageDetection(P1, WRAP_WORKDIR, 'read-pane', async () => 'ok')
    expect(emissions.slice(before)).toEqual([
      { key: P1, text: allClearOf([['tmux-unavailable', undefined], ['ad-config-malformed', undefined]]) },
    ])
    expect(getOutageFlags(P1).size).toBe(0)
  })

  /** Error answers that must never clear it, each built for the declared verb, with the notices each posts by itself. */
  const ERROR_ANSWERS: ReadonlyArray<readonly [label: string, build: (verb: string) => unknown, posts: () => string[]]> = [
    ['UNAVAILABLE (ErrTmuxUnresponsive)', (verb) => errTmuxUnresponsive(verb), () => []],
    ['UNAVAILABLE (ErrCallTimeout)', (verb) => errCallTimeout(verb), () => []],
    ['GONE (ErrTmuxSendKeys)', () => errTmuxSendKeys(), () => []],
    ['GONE (ErrTmuxCaptureFailed)', () => errTmuxCaptureFailed(), () => []],
    ['ErrSpawnNotFound', () => errSpawnNotFound(), () => []],
    ['ENVIRONMENT (raises tmux-unavailable)', (verb) => errTmuxNotAvailable(undefined, verb), () => [ONSET_TEMPLATES['tmux-unavailable']()]],
    ['UNCLASSIFIED (ErrInternal)', () => errInternal(), () => []],
  ]

  test.each(wrapRows(['status', 'get', 'list', 'send-keys', 'spawn']))('%s, %s: no error answer clears it; none posts an all-clear', async (_w, _c, wrap, call) => {
    const verb = adCallVerb(call)!
    for (const [form, build, posts] of ERROR_ANSWERS) {
      const { emissions, cleared } = makeRecordingHarness()
      await rejectionFrom(withOutageDetection, P1, 'status', errConfigMalformed())
      const before = emissions.length
      const err = build(verb)

      expect({ form, same: (await rejectionFrom(wrap, P1, call, err)) === err }).toEqual({ form, same: true })

      expect({ form, raised: getOutageFlags(P1).has('ad-config-malformed') }).toEqual({ form, raised: true })
      expect({ form, posted: emissions.slice(before).map((e) => e.text) }).toEqual({ form, posted: posts() })
      expect({ form, cleared }).toEqual({ form, cleared: [] })
    }
  })

  test('AC 84: with it raised, a version re-check that passes leaves it raised and posts nothing; no wrapped call is version or help', async () => {
    const { emissions, cleared } = makeRecordingHarness()
    await rejectionFrom(withOutageDetection, P1, 'status', errConfigMalformed())
    const clock = createFakeClock()
    const records: string[] = []
    const stops: number[] = []
    const recheckLog: string[] = []
    const recheck = createAdVersionRecheck({
      resolveSystemBinary: makeStubResolveSystemBinary(),
      baselineVersion: PHASE1_RC_VERSION,
      recordStartupError: (classLabel) => { records.push(classLabel) },
      stop: (exitCode) => { stops.push(exitCode) },
      log: (line) => { recheckLog.push(line) },
      clock,
    })
    recheck.start()
    const answer = await recheck.trigger().finally(() => recheck.dispose())

    expect(answer.kind).toBe(RECHECK_OUTCOME_PASS)
    expect(clock.pendingCount()).toBe(0)
    expect({ records, stops }).toEqual({ records: [], stops: [] })
    expect([...getOutageFlags(P1)]).toEqual(['ad-config-malformed'])
    expect(emissions).toHaveLength(1)
    expect(cleared).toEqual([])
    // CSCB never wraps `version` or `help`, so no wrapped success can be one of them.
    expect(EVERY_DECLARED_CALL.map(adCallVerb)).not.toContain('version')
    expect(EVERY_DECLARED_CALL.map(adCallVerb)).not.toContain('help')
  })

  test.each(EVERY_WRAPPED_ROW)('%s, %s: CONFIG, in each context, reports the CONFIG cause once for P and raises P\'s flag with one onset; B gets nothing; no condition start', async (_w, _c, wrap, call) => {
    const verb = adCallVerb(call)!
    for (const context of CONTEXTS) {
      const err = errConfigMalformed()
      const { emissions, arms, starts } = makeRecordingHarness()

      const { result: rejected, lastError } = await runIn(context, () => rejectionFrom(wrap, P1, call, err))

      const at = { context }
      expect({ ...at, same: rejected === err }).toEqual({ ...at, same: true })
      expect({ ...at, arms: arms.map((a) => ({ key: a.key, kind: a.kind, same: a.error === err })) })
        .toEqual({ ...at, arms: [{ key: P1, kind: UNAVAILABLE_RETRY_CAUSE_CONFIG, same: true }] })
      expect({ ...at, flags: [...getOutageFlags(P1)], b: [...getOutageFlags(P2)] }).toEqual({ ...at, flags: ['ad-config-malformed'], b: [] })
      expect({ ...at, emissions }).toEqual({ ...at, emissions: [{ key: P1, text: onsetFor(err) }] })
      // SRJ-307: only UNAVAILABLE starts tmux-unresponsive, never CONFIG.
      expect({ ...at, starts }).toEqual({ ...at, starts: [] })
      // Inside P's attempt the attempt records it armed (the launch is refused, never counted).
      const expected = context === 'inside P\'s attempt' ? { verb, causeKind: UNAVAILABLE_RETRY_CAUSE_CONFIG, armed: true } : undefined
      expect({ ...at, lastError }).toEqual({ ...at, lastError: expected })
    }
  })

  test.each([...CONTEXTS])('through reportAgentDirectorError (the liveness adapter\'s bare status), %s: reports the CONFIG cause once for P; no flag, no notice', async (context) => {
    const err = errConfigMalformed()
    const { emissions, arms, starts } = makeRecordingHarness()

    const { lastError } = await runIn(context, () => reportAgentDirectorError(P1, err, 'status'))

    expect(arms.map((a) => ({ key: a.key, kind: a.kind, same: a.error === err }))).toEqual([{ key: P1, kind: UNAVAILABLE_RETRY_CAUSE_CONFIG, same: true }])
    expect({ flags: getOutageFlags(P1).size + getOutageFlags(P2).size, emissions, starts }).toEqual({ flags: 0, emissions: [], starts: [] })
    const expected = context === 'inside P\'s attempt' ? { verb: 'status', causeKind: UNAVAILABLE_RETRY_CAUSE_CONFIG, armed: true } : undefined
    expect(lastError).toEqual(expected)
  })

  test.each([...CONTEXTS])('with no sink installed, %s: nothing is reported; the flag, onset and rethrow are as with one', async (context) => {
    const err = errConfigMalformed()
    const { emissions } = makeRecordingHarness({ sink: false })

    const { result: rejected, lastError } = await runIn(context, () => rejectionFrom(withSpawnDetection, P1, 'resume', err))
    const direct = await runIn(context, () => reportAgentDirectorError(P1, err, 'status'))

    expect(rejected).toBe(err)
    expect([...getOutageFlags(P1)]).toEqual(['ad-config-malformed'])
    expect(emissions).toEqual([{ key: P1, text: onsetFor(err) }])
    const recorded = (v: string) => context === 'inside P\'s attempt' ? { verb: v, causeKind: UNAVAILABLE_RETRY_CAUSE_CONFIG, armed: false } : undefined
    expect(lastError).toEqual(recorded('resume'))
    expect(direct.lastError).toEqual(recorded('status'))
  })

  test('raiseAdConfigMalformed: raises P\'s flag with the onset for the value, records no detail, logs one raise line; a second raise posts and logs nothing; before initOutageState it does nothing', () => {
    const { emissions } = makeRecordingHarness()
    const err = errConfigMalformed()

    raiseAdConfigMalformed(P1, err)
    raiseAdConfigMalformed(P1, errConfigMalformed('starting_session_seconds', '5'))

    expect(emissions).toEqual([{ key: P1, text: onsetFor(err) }])
    expect(raiseLinesFor(err)).toHaveLength(1)
    clearOutageFlag(P1, 'ad-config-malformed')
    expect(emissions.slice(1)).toEqual([{ key: P1, text: configAllClear() }])

    _resetOutageState()
    expect(() => raiseAdConfigMalformed(P1, err)).not.toThrow()
    expect(getOutageFlags(P1).size).toBe(0)
  })

  test('setOutageFlag with this class records no detail: the all-clear lists the bare class', () => {
    const { emissions } = makeRecordingHarness()

    setOutageFlag(P1, 'ad-config-malformed', 'agent-director text that must not reach the all-clear')
    clearOutageFlag(P1, 'ad-config-malformed')

    expect(emissions.at(-1)).toEqual({ key: P1, text: configAllClear() })
  })

  test('resetAllToHealthy wipes it silently (no all-clear, no observer call); the next CONFIG is a fresh onset', async () => {
    const { emissions, cleared } = makeRecordingHarness()
    const err = errConfigMalformed()
    await rejectionFrom(withOutageDetection, P1, 'status', err)

    resetAllToHealthy([P1])

    expect(getOutageFlags(P1).size).toBe(0)
    expect(emissions).toHaveLength(1)
    expect(cleared).toEqual([])

    await rejectionFrom(withOutageDetection, P1, 'get', err)
    expect(emissions).toEqual([{ key: P1, text: onsetFor(err) }, { key: P1, text: onsetFor(err) }])
  })

  test('flap: CONFIG → success → CONFIG → success gives onset, all-clear, onset, all-clear; a raise line per episode', async () => {
    const { emissions } = makeRecordingHarness()
    const err = errConfigMalformed()

    await rejectionFrom(withOutageDetection, P1, 'status', err)
    await withOutageDetection(P1, WRAP_WORKDIR, 'status', async () => 'ok')
    await rejectionFrom(withSpawnDetection, P1, 'spawn', err)
    await withSpawnDetection(P1, WRAP_WORKDIR, 'spawn', async () => 'ok')

    expect(emissions.map((e) => e.text)).toEqual([onsetFor(err), configAllClear(), onsetFor(err), configAllClear()])
    expect(raiseLinesFor(err)).toHaveLength(2)
  })
})

describe('UNCLASSIFIED is reported to the unclassified sink in P\'s attempt only (b.jg5 SRJ-313, SRJ-301)', () => {
  /** One `report` the recording unclassified sink received. */
  type Report = { key: string; error: unknown; classification: AdErrorClassification | undefined }

  /** The binary path the `ErrSystemInstallDisappeared` answers here carry. */
  const AD_PATH = '/bin/ad'

  /**
   * A fresh outage state over the default stub client with a recording
   * trigger sink that answers true, a recording condition sink, a recording
   * cleared-flag observer and, unless `unclassified` is false, a recording
   * unclassified sink. `unclassifiedThrows` makes that sink record and then throw.
   */
  function makeUnclassifiedHarness(opts: { unclassified?: boolean; unclassifiedThrows?: boolean } = {}): {
    emissions: Emission[]
    arms: RecordedArm[]
    reports: Report[]
    starts: string[]
    ends: string[]
    cleared: RecordedClear[]
  } {
    const emissions: Emission[] = []
    const arms: RecordedArm[] = []
    const reports: Report[] = []
    const starts: string[] = []
    const ends: string[] = []
    const cleared: RecordedClear[] = []
    const client = makeStubClient()
    _resetOutageState()
    initOutageState({
      notify: (key, text) => { emissions.push({ key, text }) },
      getClient: () => client as unknown as Client,
      triggerSink: { arm: (key, cause) => { arms.push({ key, kind: cause.kind, error: cause.error }); return true } },
      conditionSink: {
        start: (key) => { starts.push(key); return 'started' },
        end: (key) => { ends.push(key); return 'ended' },
      },
      onFlagCleared: (key, cls, reading) => { cleared.push({ key, cls, reading }) },
      ...(opts.unclassified === false
        ? {}
        : {
            unclassifiedSink: {
              report: (key: string, error: unknown, classification?: AdErrorClassification) => {
                reports.push({ key, error, classification })
                if (opts.unclassifiedThrows) throw new Error('unclassified sink failed')
                return 'begun'
              },
            },
          }),
    })
    return { emissions, arms, reports, starts, ends, cleared }
  }

  /** The reports as `{ key, same }`, `same` true when the reported value is `err` itself. */
  function reportsOf(reports: Report[], err: unknown): Array<{ key: string; same: boolean }> {
    return reports.map((r) => ({ key: r.key, same: r.error === err }))
  }

  /** The arms as `{ key, kind, same }`, `same` true when the cause carries `err` itself. */
  function armsOf(arms: RecordedArm[], err: unknown): Array<{ key: string; kind: string; same: boolean }> {
    return arms.map((a) => ({ key: a.key, kind: a.kind, same: a.error === err }))
  }

  /**
   * The UNCLASSIFIED answers (b.jg5 SRJ-104), each built for the declared
   * verb, with the flags each raises by itself: `ErrSystemInstallDisappeared`
   * still raises `ad-unreachable`; the others raise none.
   */
  const UNCLASSIFIED_FORMS: ReadonlyArray<readonly [label: string, build: (verb: string) => unknown, raises: OutageClass[]]> = [
    ['ErrInternal', () => errInternal(), []],
    ['an unhandled name', (verb) => errGeneric(verb, 'ErrNoHandlingInCscb'), []],
    ['ErrSchemaMismatch', () => errSchemaMismatch(), []],
    ['ErrSystemInstallDisappeared', (verb) => errSystemInstallDisappeared(verb, AD_PATH), ['ad-unreachable']],
  ]

  /** The read calls, which keep E8's read-error cause; every other declared call arms the UNCLASSIFIED cause. */
  const READ_CALLS: readonly AdCall[] = ['status', 'get', 'list']

  test.each(EVERY_WRAPPED_ROW)('%s, %s: each form inside P\'s attempt is reported once for P with the same value and arms once; inside Q\'s attempt or outside any, nothing; no flag raised (but ad-unreachable) or cleared; no condition start or end; rethrown unchanged', async (_w, _c, wrap, call) => {
    const verb = adCallVerb(call)!
    const kind = READ_CALLS.includes(call) ? UNAVAILABLE_RETRY_CAUSE_READ_ERROR : UNAVAILABLE_RETRY_CAUSE_UNCLASSIFIED
    for (const [form, build, raises] of UNCLASSIFIED_FORMS) {
      for (const context of CONTEXTS) {
        const err = build(verb)
        const { emissions, arms, reports, starts, ends, cleared } = makeUnclassifiedHarness()
        // Flags up beforehand, so a clear would show.
        setOutageFlag(P1, 'tmux-unavailable')
        setOutageFlag(P1, 'cwd-unreachable', WRAP_WORKDIR)
        const before = emissions.length

        const { result: rejected, lastError } = await runIn(context, () => rejectionFrom(wrap, P1, call, err))

        const at = { form, context }
        const inP = context === 'inside P\'s attempt'
        expect({ ...at, same: rejected === err }).toEqual({ ...at, same: true })
        expect({ ...at, reports: reportsOf(reports, err) }).toEqual({ ...at, reports: inP ? [{ key: P1, same: true }] : [] })
        expect({ ...at, arms: armsOf(arms, err) }).toEqual({ ...at, arms: inP ? [{ key: P1, kind, same: true }] : [] })
        expect({ ...at, lastError }).toEqual({ ...at, lastError: inP ? { verb, causeKind: kind, armed: true } : undefined })
        expect({ ...at, flags: [...getOutageFlags(P1)].sort(), b: [...getOutageFlags(P2)] })
          .toEqual({ ...at, flags: (['cwd-unreachable', 'tmux-unavailable', ...raises] satisfies OutageClass[]).sort(), b: [] })
        expect({ ...at, cleared }).toEqual({ ...at, cleared: [] })
        expect({ ...at, posted: emissions.slice(before) }).toEqual({ ...at, posted: raises.map(() => ({ key: P1, text: ONSET_TEMPLATES['ad-unreachable'](AD_PATH) })) })
        // SRJ-307: only UNAVAILABLE starts tmux-unresponsive; an UNCLASSIFIED answer is not tmux answering either.
        expect({ ...at, starts, ends }).toEqual({ ...at, starts: [], ends: [] })
      }
    }
  })

  test('a call for P inside Q\'s attempt nested in P\'s is reported once, for P', async () => {
    const err = errInternal()
    const { reports, arms } = makeUnclassifiedHarness()

    await runInAttempt(P1, 'recovery', () => runInAttempt(P2, 'launch', () => rejectionFrom(withSpawnDetection, P1, 'spawn', err)))

    expect(reportsOf(reports, err)).toEqual([{ key: P1, same: true }])
    expect(armsOf(arms, err)).toEqual([{ key: P1, kind: UNAVAILABLE_RETRY_CAUSE_UNCLASSIFIED, same: true }])
  })

  test('an ErrInternal carrying the unusable-name phrase (UNUSABLE NAME, the E16 boundary) inside P\'s attempt is not reported', async () => {
    const err = errUnusableName()
    const { reports } = makeUnclassifiedHarness()

    await runIn('inside P\'s attempt', async () => {
      await rejectionFrom(withOutageDetection, P1, 'get', err)
      await rejectionFrom(withSpawnDetection, P1, 'spawn', err)
      reportAgentDirectorError(P1, err, 'status')
    })

    expect(reports).toEqual([])
  })

  test('ruling 4: an UNCLASSIFIED answer from a call with no known verb, inside P\'s attempt, neither arms nor is reported', async () => {
    const { reports, arms } = makeUnclassifiedHarness()

    const { lastError } = await runIn('inside P\'s attempt', () => reportAgentDirectorError(P1, errInternal(), UNDECLARED_CALL))

    expect(reports).toEqual([])
    expect(arms).toEqual([])
    expect(lastError).toEqual({ armed: false })
  })

  test.each([
    ['no options (reports)', errInternal(), undefined, 1],
    ['no options, ErrSystemInstallDisappeared (reports)', errSystemInstallDisappeared('status', AD_PATH), undefined, 1],
    ['reportUnclassified true (reports)', errSystemInstallDisappeared('status', AD_PATH), { reportUnclassified: true }, 1],
    ['reportUnclassified false, the liveness adapter\'s ErrSystemInstallDisappeared (not reported)', errSystemInstallDisappeared('status', AD_PATH), { reportUnclassified: false }, 0],
    ['reportUnclassified false, ErrInternal (not reported)', errInternal(), { reportUnclassified: false }, 0],
  ] as const)('reportAgentDirectorError from status inside P\'s attempt, %s: the read-error arming is the same either way; no flag, no notice', async (_label, err, options, reported) => {
    const { emissions, arms, reports, starts } = makeUnclassifiedHarness()

    const { lastError } = await runIn('inside P\'s attempt', () => reportAgentDirectorError(P1, err, 'status', options))

    expect(reportsOf(reports, err)).toEqual(reported === 1 ? [{ key: P1, same: true }] : [])
    expect(armsOf(arms, err)).toEqual([{ key: P1, kind: UNAVAILABLE_RETRY_CAUSE_READ_ERROR, same: true }])
    expect(lastError).toEqual({ verb: 'status', causeKind: UNAVAILABLE_RETRY_CAUSE_READ_ERROR, armed: true })
    expect({ flags: getOutageFlags(P1).size, emissions, starts }).toEqual({ flags: 0, emissions: [], starts: [] })
  })

  test.each([...CONTEXTS])('reportAgentDirectorError outside P\'s attempt (%s) reports nothing', async (context) => {
    const err = errInternal()
    const { reports } = makeUnclassifiedHarness()

    await runIn(context, () => {
      reportAgentDirectorError(P1, err, 'status')
      reportAgentDirectorError(P1, err, 'spawn')
    })

    expect(reportsOf(reports, err)).toEqual(context === 'inside P\'s attempt' ? [{ key: P1, same: true }, { key: P1, same: true }] : [])
  })

  /** The resume path's step for `err`: the ErrInvalidFlags re-check, here answering not-running. */
  function invalidFlagsStep(err: ReturnType<typeof errInvalidFlags>) {
    return classifyWithInvalidFlagsRecheck(err, async () => ({ kind: RECHECK_OUTCOME_NOT_RUNNING }))
  }

  test.each([...CONTEXTS])('the site entry after the resume path\'s ErrInvalidFlags, %s: inside P\'s attempt it arms the UNCLASSIFIED cause and reports once with the step\'s classification (the wrapper reported and armed nothing); elsewhere nothing', async (context) => {
    const err = errInvalidFlags('resume')
    const { classification } = await invalidFlagsStep(err)
    const { emissions, arms, reports, starts, ends, cleared } = makeUnclassifiedHarness()

    const { result, lastError } = await runIn(context, async () => {
      const rejected = await rejectionFrom(withSpawnDetection, P1, 'resume', err)
      const byWrapper = { reports: reports.length, arms: arms.length }
      return { same: rejected === err, byWrapper, armed: reportUnclassifiedAtSite(P1, err, 'resume', classification) }
    })

    const inP = context === 'inside P\'s attempt'
    expect(classification.errorClass).toBe(AD_ERROR_CLASS_UNCLASSIFIED)
    expect(result).toEqual({ same: true, byWrapper: { reports: 0, arms: 0 }, armed: inP })
    expect(armsOf(arms, err)).toEqual(inP ? [{ key: P1, kind: UNAVAILABLE_RETRY_CAUSE_UNCLASSIFIED, same: true }] : [])
    expect(reports.map((r) => ({ key: r.key, same: r.error === err, classification: r.classification })))
      .toEqual(inP ? [{ key: P1, same: true, classification }] : [])
    expect(lastError).toEqual(inP ? { verb: 'resume', causeKind: UNAVAILABLE_RETRY_CAUSE_UNCLASSIFIED, armed: true } : undefined)
    expect({ flags: getOutageFlags(P1).size, emissions, starts, ends, cleared }).toEqual({ flags: 0, emissions: [], starts: [], ends: [], cleared: [] })
  })

  test.each([
    ['no unclassified sink installed', { unclassified: false }],
    ['an unclassified sink that throws', { unclassifiedThrows: true }],
  ] as const)('the site entry with %s still arms and answers true, and does not throw', async (_label, opts) => {
    const err = errInvalidFlags('resume')
    const { classification } = await invalidFlagsStep(err)
    const { arms, reports } = makeUnclassifiedHarness(opts)

    const { result: armed } = await runIn('inside P\'s attempt', () => reportUnclassifiedAtSite(P1, err, 'resume', classification))

    expect(armed).toBe(true)
    expect(armsOf(arms, err)).toEqual([{ key: P1, kind: UNAVAILABLE_RETRY_CAUSE_UNCLASSIFIED, same: true }])
    expect(reports).toHaveLength('unclassifiedThrows' in opts ? 1 : 0)
  })

  test.each([
    ['ErrInternal from spawn', withSpawnDetection, 'spawn', () => errInternal()],
    ['ErrSystemInstallDisappeared from status (raises ad-unreachable)', withOutageDetection, 'status', () => errSystemInstallDisappeared('status', AD_PATH)],
  ] as const)('%s inside P\'s attempt: the rethrown value, arming, attempt record, flags and notices are exactly as with no unclassified sink, or with one that throws', async (_label, wrap, call, build) => {
    const err = build()
    /** One run: its outcome, the arms, P's flags and every notice. */
    async function runWith(opts: { unclassified?: boolean; unclassifiedThrows?: boolean }): Promise<unknown> {
      const { emissions, arms, starts } = makeUnclassifiedHarness(opts)
      const { result, lastError } = await runIn('inside P\'s attempt', async () => (await rejectionFrom(wrap, P1, call, err)) === err)
      return { result, lastError, arms: armsOf(arms, err), flags: [...getOutageFlags(P1)].sort(), emissions, starts }
    }

    const without = await runWith({ unclassified: false })
    const recording = await runWith({})
    const throwing = await runWith({ unclassifiedThrows: true })

    expect(recording).toEqual(without)
    expect(throwing).toEqual(without)
  })

  test('the error text reaches no notice, flag or attempt record, and the sink gets the value itself (leak check)', async () => {
    const err = errInternal(`the store could not be read (${sentinelInMessage('spawn')}); nothing was done`)
    const { emissions, arms, reports, starts } = makeUnclassifiedHarness()

    const { result: rejected, lastError } = await runIn('inside P\'s attempt', () => rejectionFrom(withSpawnDetection, P1, 'spawn', err))

    expect(rejected).toBe(err)
    expect(reportsOf(reports, err)).toEqual([{ key: P1, same: true }])
    assertNoLeak({ emissions, lastError, kinds: arms.map((a) => a.kind), flags: [...getOutageFlags(P1)], starts })
  })
})

describe('the stable class order (b.jg5 SRJ-1018)', () => {
  test('every OutageClass appears exactly once in OUTAGE_CLASS_ORDER, which is read-only', () => {
    // ONSET_TEMPLATES is a Record over OutageClass, so its keys are every member.
    expect<string[]>([...OUTAGE_CLASS_ORDER].sort()).toEqual(Object.keys(ONSET_TEMPLATES).sort())
    expect(new Set(OUTAGE_CLASS_ORDER).size).toBe(OUTAGE_CLASS_ORDER.length)
    expect(Object.isFrozen(OUTAGE_CLASS_ORDER)).toBe(true)
  })

  test('the order is ad-unreachable, cwd-unreachable, tmux-unavailable, then ad-config-malformed', () => {
    expect<readonly string[]>(OUTAGE_CLASS_ORDER).toEqual(['ad-unreachable', 'cwd-unreachable', 'tmux-unavailable', 'ad-config-malformed'])
  })

  test.each([
    ['in the exported order', [...OUTAGE_CLASS_ORDER]],
    ['in reverse order', [...OUTAGE_CLASS_ORDER].reverse()],
  ] as const)('raised %s, the one all-clear lists every class in the exported order', (_label, raiseOrder) => {
    const { emissions } = makeRecordingHarness()
    for (const cls of raiseOrder) {
      if (cls === 'ad-config-malformed') raiseAdConfigMalformed(P1, errConfigMalformed())
      else setOutageFlag(P1, cls)
    }
    for (const cls of raiseOrder) clearOutageFlag(P1, cls)

    const text = emissions.at(-1)!.text
    expect(emissions).toHaveLength(OUTAGE_CLASS_ORDER.length + 1)
    const positions = OUTAGE_CLASS_ORDER.map((cls) => text.indexOf(cls))
    expect(positions.every((at) => at >= 0)).toBe(true)
    expect([...positions].sort((a, b) => a - b)).toEqual(positions)
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
