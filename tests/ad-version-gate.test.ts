/**
 * ad-version-gate.test.ts — CSCB's Phase 1 floor (b.jg5 SRJ-201), its
 * comparison (b.jg5 SRJ-202), the shared test versions (b.jg5 SRJ-1304) and
 * the runtime re-check of the host binary (b.jg5 SRJ-204, SRJ-205).
 *
 * Every version is built from the floor constant's parts or imported from
 * `tests/test-helpers/agent-director-versions.ts`, so a change to
 * `PHASE1_FLOOR_VERSION` moves every case with it. Every class label,
 * interval, time limit, runbook title and the runtime phrase is imported from
 * `src/`; one case pins the interval constant to SRJ-204's 120 s.
 *
 * The runtime re-check runs on `createFakeClock` with
 * `makeStubResolveSystemBinary` and no health check (the
 * `health_check_interval` 0 condition): its own timer is the only one armed.
 *
 * No process, no real HOME, no real timer, no top-level mock.module(), no
 * value import of `Client` or `resolveSystemBinary`. Module state (the
 * installed re-check, the tick listeners, the client singleton) is reset and
 * temp directories are removed in `afterEach`.
 *
 * SPDX-License-Identifier: MIT
 */

import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import semver from 'semver'

import {
  AD_VERSION_RECHECK_INTERVAL_MS,
  AD_VERSION_RECHECK_STOP_EXIT_CODE,
  AD_VERSION_RECHECK_TIME_LIMIT_MS,
  buildBelowPhase1FloorMessage,
  buildSystemInstallTooOldMessage,
  createAdVersionRecheck,
  decideAdVersionRecheckOutcome,
  disposeAdVersionRecheck,
  FOUND_BY_RUNTIME_RECHECK,
  installAdVersionRecheck,
  meetsPhase1Floor,
  onAdVersionRecheckTick,
  PHASE1_FLOOR_VERSION,
  PHASE1_RUNBOOK_SECTION_TITLE,
  RECHECK_OUTCOME_STOP,
  resetAdVersionRecheckForTests,
  RUNTIME_RECHECK_PHRASE,
  type AdVersionRecheck,
  type AdVersionRecheckDeps,
  type AdVersionRecheckTickListener,
} from '../src/ad-version-gate.ts'
import { resetClientForTests, setClientForTests } from '../src/agent-director-client.ts'
import { AD_BELOW_PHASE1_FLOOR, AD_SYSTEM_INSTALL_TOO_OLD } from '../src/install-check.ts'
import { renderInstallSkillInstructions } from '../src/install-skill-pointer.ts'
import { recordStartupError } from '../src/startup-errors.ts'
import {
  errBunVersionTooOld,
  errSystemInstallNotFound,
  errSystemInstallTooOld,
  errSystemInstallUnreachable,
  makeStubCallLog,
  makeStubClient,
  makeStubResolveSystemBinary,
  stubCallCount,
  type StubResolveSystemBinaryOutcome,
} from './test-helpers/agent-director-stub.ts'
import {
  CLIENT_MIN_VERSION,
  DEV_PLACEHOLDER_VERSION,
  DEV_UNPARSEABLE_VERSION,
  OLD_AD_VERSION,
  PHASE1_RC_VERSION,
} from './test-helpers/agent-director-versions.ts'
import { createFakeClock, type FakeClock } from './test-helpers/fake-clock.ts'
import { STALE_VERSION } from './test-helpers/install-check-fixtures.ts'
import { flat } from './test-helpers/markdown.ts'
import { stripComments } from './test-helpers/source-audit.ts'
import { UPGRADE_FORMS } from './test-helpers/upgrade-forms.ts'

// ---------------------------------------------------------------------------
// Versions built from the floor's parts
// ---------------------------------------------------------------------------

const FLOOR = PHASE1_FLOOR_VERSION.split('.').map(Number) as [number, number, number]
const [MAJOR, MINOR, PATCH] = FLOOR

/** The pre-release suffix the helper's release candidate carries. */
const RC = PHASE1_RC_VERSION.slice(PHASE1_FLOOR_VERSION.length)

const v = (major: number, minor: number, patch: number): string => `${major}.${minor}.${patch}`

/** A patch number high enough to sit above any real release in its minor. */
const HIGH = 999

/** The version just below the floor: one patch below, or the previous minor's (major's) highest-looking release. */
const JUST_BELOW = PATCH > 0
  ? v(MAJOR, MINOR, PATCH - 1)
  : MINOR > 0
    ? v(MAJOR, MINOR - 1, HIGH)
    : v(MAJOR - 1, HIGH, HIGH)

const LATER_PATCH = v(MAJOR, MINOR, PATCH + 1)
const LATER_MINOR = v(MAJOR, MINOR + 1, 0)
const LATER_MAJOR = v(MAJOR + 1, 0, 0)

/** Replace floor part `i` with `value` and zero the parts after it. */
function withPart(i: number, value: number): string {
  return FLOOR.map((n, j) => (j < i ? n : j === i ? value : 0)).join('.')
}

/**
 * Versions whose string order is the opposite of their numeric order against
 * the floor, each with the numeric answer (semver's). Each floor part is
 * replaced by 9 (a single digit, sorting after any other leading digit) and
 * by the next power of ten above it (one more digit, leading 1); a candidate
 * is kept when it sorts before the floor as a string yet passes numerically
 * (`0.100.0` against `0.11.0`), or sorts after it yet is refused (`0.9.0`
 * against `0.11.0`).
 */
const LEXICAL_TRAPS: Array<[string, boolean]> = FLOOR.flatMap((n, i) =>
  [withPart(i, 9), withPart(i, 10 ** String(n).length)]
    .map((version): [string, boolean] => [version, semver.gte(version, PHASE1_FLOOR_VERSION)])
    .filter(([version, passes]) => (version < PHASE1_FLOOR_VERSION) === passes),
)

// ---------------------------------------------------------------------------
// The floor constant (SRJ-201)
// ---------------------------------------------------------------------------

describe('PHASE1_FLOOR_VERSION', () => {
  test('is strict major.minor.patch with no pre-release suffix', () => {
    expect(PHASE1_FLOOR_VERSION).toMatch(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/)
  })

  test("is above the client's own minimum, so CSCB's check never sits below the client's", () => {
    expect(semver.gt(PHASE1_FLOOR_VERSION, CLIENT_MIN_VERSION)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// The comparison (SRJ-202)
// ---------------------------------------------------------------------------

describe('meetsPhase1Floor', () => {
  test.each([
    ['the floor', PHASE1_FLOOR_VERSION],
    ["the floor's release candidate", PHASE1_RC_VERSION],
    ['a later patch release', LATER_PATCH],
    ['a later patch release candidate', `${LATER_PATCH}${RC}`],
    ['a later minor release', LATER_MINOR],
    ['a later minor release candidate', `${LATER_MINOR}${RC}`],
    ['a later major release', LATER_MAJOR],
    ['a later major release candidate', `${LATER_MAJOR}${RC}`],
  ])('passes %s (%s)', (_label, version) => {
    expect(meetsPhase1Floor(version)).toBe(true)
  })

  test.each([
    ['the release before Phase 1', OLD_AD_VERSION],
    ["the client's dev sentinel (the client's own rule ranks it above every floor, and CSCB refuses it)", DEV_PLACEHOLDER_VERSION],
    ['a release candidate of a version below the floor', `${JUST_BELOW}${RC}`],
    ['the version just below the floor', JUST_BELOW],
  ])('refuses %s (%s)', (_label, version) => {
    expect(meetsPhase1Floor(version)).toBe(false)
  })

  test('the floor has a version whose string order disagrees with its numeric order', () => {
    expect(LEXICAL_TRAPS.length).toBeGreaterThan(0)
  })

  test.each(LEXICAL_TRAPS)('compares %s numerically, not as a string (passes: %p)', (version, passes) => {
    expect(meetsPhase1Floor(version)).toBe(passes)
  })

  test.each([
    ['a leading-v form of the floor', `v${PHASE1_FLOOR_VERSION}`],
    ['a +build form of the floor', `${PHASE1_FLOOR_VERSION}+build.1`],
    ['the floor with a trailing newline', `${PHASE1_FLOOR_VERSION}\n`],
    ['an unparseable dev version', DEV_UNPARSEABLE_VERSION],
    ['the empty string', ''],
  ])('fails closed on %s', (_label, version) => {
    expect(meetsPhase1Floor(version)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// The shared test versions (SRJ-1304)
// ---------------------------------------------------------------------------

describe('agent-director-versions helper', () => {
  test('OLD_AD_VERSION is at or above the client minimum: the client admits it, only CSCB refuses it', () => {
    expect(semver.gte(OLD_AD_VERSION, CLIENT_MIN_VERSION)).toBe(true)
    expect(meetsPhase1Floor(OLD_AD_VERSION)).toBe(false)
  })

  test("CLIENT_MIN_VERSION is the installed client's version-floor.json value", async () => {
    const floorPath = Bun.resolveSync('agent-director/dist/version-floor.json', import.meta.dir)
    const floorJson = (await Bun.file(floorPath).json()) as { min_binary_version: unknown }
    expect(CLIENT_MIN_VERSION).toBe(floorJson.min_binary_version as string)
  })
})

// ---------------------------------------------------------------------------
// Runtime re-check (b.jg5 SRJ-204, SRJ-205): shared fixtures
// ---------------------------------------------------------------------------

/** The version the startup gate read: the re-check's first last version seen. */
const BASELINE_VERSION = PHASE1_RC_VERSION

/** A distinct binary path per case, so a message shows the path it was given is passed through. */
const binaryPathFor = (label: string): string => join(tmpdir(), 'cscb-ad-version-recheck', label, 'agent-director')

/** One entry of a rig's shared event list, in the order the hooks ran. */
type RecheckEvent = 'call' | 'record' | 'stop' | 'tick'

interface RecheckRigOptions {
  /** The stub's ordered answers (default: every call resolves with `PHASE1_RC_VERSION`). */
  outcomes?: readonly StubResolveSystemBinaryOutcome[]
  /** Replaces the stub resolve (a deferred answer, a synchronous throw). */
  resolveSystemBinary?: AdVersionRecheckDeps['resolveSystemBinary']
  /** Where the record hook forwards, after the rig captures the call. */
  recordStartupError?: (classLabel: string, message: string) => void
  /** Tick listeners run after the rig's own `tick` listener. */
  tickListeners?: readonly AdVersionRecheckTickListener[]
  /** Call `start()` (default true). */
  start?: boolean
}

/**
 * One re-check on one fake clock and one stub resolve, with capturing record,
 * stop, log and tick hooks. Its first tick listener pushes `tick`, so `events`
 * shows every call, record, stop and tick in order.
 */
interface RecheckRig {
  readonly clock: FakeClock
  readonly recheck: AdVersionRecheck
  readonly events: RecheckEvent[]
  readonly records: Array<{ classLabel: string; message: string }>
  readonly stops: number[]
  readonly logs: string[]
  /** How many times `resolveSystemBinary` was called. */
  callCount(): number
  /** How many times the rig's own tick listener ran. */
  tickCount(): number
}

/** Every rig built in the running test; disposed in `afterEach`. */
const liveRigs: AdVersionRecheck[] = []

/** Temp directories made in the running test; removed in `afterEach`. */
const tempDirs: string[] = []

function makeRecheckRig(opts: RecheckRigOptions = {}): RecheckRig {
  const clock = createFakeClock()
  const events: RecheckEvent[] = []
  const records: Array<{ classLabel: string; message: string }> = []
  const stops: number[] = []
  const logs: string[] = []
  const stub = opts.resolveSystemBinary ?? makeStubResolveSystemBinary(opts.outcomes ? { outcomes: opts.outcomes } : {})
  const listeners: AdVersionRecheckTickListener[] = [() => { events.push('tick') }, ...(opts.tickListeners ?? [])]
  const recheck = createAdVersionRecheck({
    resolveSystemBinary: () => {
      events.push('call')
      return stub()
    },
    baselineVersion: BASELINE_VERSION,
    recordStartupError: (classLabel, message) => {
      events.push('record')
      records.push({ classLabel, message })
      opts.recordStartupError?.(classLabel, message)
    },
    stop: (exitCode) => {
      events.push('stop')
      stops.push(exitCode)
    },
    log: (line) => { logs.push(line) },
    clock,
    tickListeners: () => listeners,
  })
  liveRigs.push(recheck)
  if (opts.start ?? true) recheck.start()
  return {
    clock,
    recheck,
    events,
    records,
    stops,
    logs,
    callCount: () => events.filter((e) => e === 'call').length,
    tickCount: () => events.filter((e) => e === 'tick').length,
  }
}

/** A promise the test settles by hand: a `resolveSystemBinary` answer that arrives when the test says. */
function deferredAnswer(): {
  promise: Promise<{ path: string; version: string }>
  resolve: (value: { path: string; version: string }) => void
} {
  let resolve!: (value: { path: string; version: string }) => void
  const promise = new Promise<{ path: string; version: string }>((r) => { resolve = r })
  return { promise, resolve }
}

/** Assert the rig's only pending timer is the next re-check, one interval from now. */
function expectNextRecheckArmed(rig: RecheckRig): void {
  const pending = rig.clock.pending()
  expect(pending).toHaveLength(1)
  expect(pending[0]!.delayMs).toBe(AD_VERSION_RECHECK_INTERVAL_MS)
  expect(pending[0]!.dueAt).toBe(rig.clock.now() + AD_VERSION_RECHECK_INTERVAL_MS)
}

/** Assert one refusal stop: record then stop, each once, a non-zero exit code, no timer left. */
function expectStoppedOnce(rig: RecheckRig, classLabel: string): string {
  expect(rig.events).toEqual(['call', 'record', 'stop'])
  expect(rig.records).toHaveLength(1)
  expect(rig.records[0]!.classLabel).toBe(classLabel)
  expect(rig.stops).toEqual([AD_VERSION_RECHECK_STOP_EXIT_CODE])
  expect(rig.stops[0]).not.toBe(0)
  expect(rig.clock.pendingCount()).toBe(0)
  return rig.records[0]!.message
}

afterEach(() => {
  for (const recheck of liveRigs.splice(0)) recheck.dispose()
  resetAdVersionRecheckForTests()
  resetClientForTests()
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// Runtime re-check: the schedule (SRJ-204)
// ---------------------------------------------------------------------------

describe('runtime re-check: schedule (health_check_interval 0)', () => {
  test("AD_VERSION_RECHECK_INTERVAL_MS is SRJ-204's 120 s", () => {
    expect(AD_VERSION_RECHECK_INTERVAL_MS).toBe(120_000)
  })

  test('the time limit on one call is positive and shorter than the interval', () => {
    expect(AD_VERSION_RECHECK_TIME_LIMIT_MS).toBeGreaterThan(0)
    expect(AD_VERSION_RECHECK_TIME_LIMIT_MS).toBeLessThan(AD_VERSION_RECHECK_INTERVAL_MS)
  })

  test('building the re-check arms nothing and calls nothing', async () => {
    const rig = makeRecheckRig({ start: false })
    expect(rig.clock.pendingCount()).toBe(0)
    await rig.clock.advance(AD_VERSION_RECHECK_INTERVAL_MS * 3)
    expect(rig.callCount()).toBe(0)
  })

  test('with health_check_interval 0, start calls nothing at once and arms one timer at the interval (no health check timer)', async () => {
    const rig = makeRecheckRig()
    await rig.clock.flush()
    expect(rig.callCount()).toBe(0)
    expectNextRecheckArmed(rig)
  })

  test('with health_check_interval 0, just under the interval nothing is called; at the interval one call', async () => {
    const rig = makeRecheckRig()
    await rig.clock.advance(AD_VERSION_RECHECK_INTERVAL_MS - 1)
    expect(rig.callCount()).toBe(0)
    await rig.clock.advance(1)
    expect(rig.callCount()).toBe(1)
  })

  test('with health_check_interval 0, N intervals give N calls, with exactly one timer pending after each settled call', async () => {
    const rig = makeRecheckRig()
    const intervals = 5
    for (let n = 1; n <= intervals; n++) {
      await rig.clock.advance(AD_VERSION_RECHECK_INTERVAL_MS)
      expect(rig.callCount()).toBe(n)
      expectNextRecheckArmed(rig)
    }
    expect(rig.records).toHaveLength(0)
    expect(rig.stops).toHaveLength(0)
  })

  test('a second start() is a logged no-op that arms no second timer', async () => {
    const rig = makeRecheckRig()
    rig.recheck.start()
    expect(rig.logs).toHaveLength(1)
    expect(rig.clock.pendingCount()).toBe(1)
    await rig.clock.advance(AD_VERSION_RECHECK_INTERVAL_MS)
    expect(rig.callCount()).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// Runtime re-check: one case per SRJ-204 table row
// ---------------------------------------------------------------------------

describe('runtime re-check: a version that passes the floor changes nothing', () => {
  test.each([
    ['the floor', PHASE1_FLOOR_VERSION, binaryPathFor('pass-floor')],
    ["the floor's release candidate", PHASE1_RC_VERSION, binaryPathFor('pass-rc')],
    ['a later release built from the floor', LATER_MINOR, binaryPathFor('pass-later')],
  ])('%s (%s): no record, no stop, the version becomes the last seen, next call one interval later', async (_label, version, path) => {
    const rig = makeRecheckRig({ outcomes: [{ version, path }] })
    await rig.clock.advance(AD_VERSION_RECHECK_INTERVAL_MS)
    expect(rig.events).toEqual(['call', 'tick'])
    expect(rig.recheck.lastVersionSeen()).toBe(version)
    expectNextRecheckArmed(rig)
    await rig.clock.advance(AD_VERSION_RECHECK_INTERVAL_MS - 1)
    expect(rig.callCount()).toBe(1)
    await rig.clock.advance(1)
    expect(rig.callCount()).toBe(2)
    expect(rig.records).toHaveLength(0)
    expect(rig.stops).toHaveLength(0)
  })
})

describe('runtime re-check: a version below the floor stops the server (ad-below-phase1-floor)', () => {
  test.each([
    ['the release before Phase 1', OLD_AD_VERSION, binaryPathFor('below-old')],
    ["the client's dev sentinel", DEV_PLACEHOLDER_VERSION, binaryPathFor('below-dev')],
    ['an unparseable version the client resolved with (fail closed)', DEV_UNPARSEABLE_VERSION, binaryPathFor('below-unparseable')],
  ])('%s (%s): one record naming the found version, the floor, the path and the runtime phrase, then one non-zero stop', async (_label, version, path) => {
    const rig = makeRecheckRig({ outcomes: [{ version, path }] })
    await rig.clock.advance(AD_VERSION_RECHECK_INTERVAL_MS)
    const message = expectStoppedOnce(rig, AD_BELOW_PHASE1_FLOOR)
    for (const text of [version, PHASE1_FLOOR_VERSION, path, RUNTIME_RECHECK_PHRASE, PHASE1_RUNBOOK_SECTION_TITLE]) {
      expect(message).toContain(text)
    }
    expect(message).not.toContain(renderInstallSkillInstructions())
    for (const [, pattern] of UPGRADE_FORMS) expect(flat(message)).not.toMatch(pattern)
    expect(rig.recheck.lastVersionSeen()).toBe(BASELINE_VERSION)
  })
})

describe("runtime re-check: the client's too-old refusal stops the server (ad-system-install-too-old)", () => {
  test("ErrSystemInstallTooOld: one record naming the error's versions, the floor, the path and the runtime phrase, ending with the install-skill block; then one non-zero stop", async () => {
    const path = binaryPathFor('too-old')
    const tooOld = errSystemInstallTooOld(STALE_VERSION, CLIENT_MIN_VERSION, path)
    const rig = makeRecheckRig({ outcomes: [{ throws: tooOld }] })
    await rig.clock.advance(AD_VERSION_RECHECK_INTERVAL_MS)
    const message = expectStoppedOnce(rig, AD_SYSTEM_INSTALL_TOO_OLD)
    for (const text of [tooOld.actualVersion, tooOld.requiredVersion, PHASE1_FLOOR_VERSION, tooOld.binaryPath, RUNTIME_RECHECK_PHRASE, PHASE1_RUNBOOK_SECTION_TITLE]) {
      expect(message).toContain(text)
    }
    expect(message.endsWith(renderInstallSkillInstructions())).toBe(true)
    for (const [, pattern] of UPGRADE_FORMS) expect(flat(message)).not.toMatch(pattern)
  })

  test('is recognised by its name, not its class: a plain object carrying the errName stops the server the same way', async () => {
    const path = binaryPathFor('too-old-by-name')
    const byName = { errName: errSystemInstallTooOld().errName, actualVersion: STALE_VERSION, requiredVersion: CLIENT_MIN_VERSION, binaryPath: path }
    const outcome = decideAdVersionRecheckOutcome({ kind: 'rejected', error: byName })
    expect(outcome.kind).toBe(RECHECK_OUTCOME_STOP)
    if (outcome.kind === RECHECK_OUTCOME_STOP) {
      expect(outcome.classLabel).toBe(AD_SYSTEM_INSTALL_TOO_OLD)
      for (const text of [STALE_VERSION, CLIENT_MIN_VERSION, path, RUNTIME_RECHECK_PHRASE]) expect(outcome.message).toContain(text)
    }
  })
})

describe('runtime re-check: a re-check that cannot run changes nothing', () => {
  test.each([
    ['ErrSystemInstallUnreachable (a timed-out probe)', errSystemInstallUnreachable('probe-timeout', null, binaryPathFor('unreachable-timeout'))],
    ['ErrSystemInstallUnreachable (an unparseable version)', errSystemInstallUnreachable('unparseable-version', DEV_UNPARSEABLE_VERSION, binaryPathFor('unreachable-unparseable'))],
    ['ErrSystemInstallNotFound (a missing binary)', errSystemInstallNotFound()],
    ['ErrBunVersionTooOld', errBunVersionTooOld()],
    ['a plain error', new Error('stub resolve failure')],
  ])('%s: no record, no stop, one timer re-armed, and the next interval calls again', async (_label, error) => {
    const rig = makeRecheckRig({ outcomes: [{ throws: error }] })
    await rig.clock.advance(AD_VERSION_RECHECK_INTERVAL_MS)
    expect(rig.events).toEqual(['call', 'tick'])
    expect(rig.recheck.lastVersionSeen()).toBe(BASELINE_VERSION)
    expectNextRecheckArmed(rig)
    await rig.clock.advance(AD_VERSION_RECHECK_INTERVAL_MS)
    expect(rig.callCount()).toBe(2)
    expect(rig.records).toHaveLength(0)
    expect(rig.stops).toHaveLength(0)
  })

  test('a resolve that throws synchronously is could-not-run too', async () => {
    const rig = makeRecheckRig({
      resolveSystemBinary: () => {
        throw new Error('stub synchronous failure')
      },
    })
    await rig.clock.advance(AD_VERSION_RECHECK_INTERVAL_MS)
    expect(rig.events).toEqual(['call', 'tick'])
    expect(rig.records).toHaveLength(0)
    expect(rig.stops).toHaveLength(0)
    expectNextRecheckArmed(rig)
  })
})

// ---------------------------------------------------------------------------
// Runtime re-check: the stop (SRJ-205)
// ---------------------------------------------------------------------------

describe('runtime re-check: a stop happens once, record before stop', () => {
  test('after a pass then a below-floor answer, further advances call nothing and record and stop are not called again', async () => {
    const rig = makeRecheckRig({ outcomes: [{ version: PHASE1_RC_VERSION }, { version: OLD_AD_VERSION, path: binaryPathFor('stop-once') }] })
    await rig.clock.advance(AD_VERSION_RECHECK_INTERVAL_MS * 2)
    expect(rig.events).toEqual(['call', 'tick', 'call', 'record', 'stop'])
    expect(rig.clock.pendingCount()).toBe(0)
    await rig.clock.advance(AD_VERSION_RECHECK_INTERVAL_MS * 10)
    expect(rig.events).toEqual(['call', 'tick', 'call', 'record', 'stop'])
    expect(rig.clock.pendingCount()).toBe(0)
  })

  test('a record hook that throws is logged and the server still stops once', async () => {
    const rig = makeRecheckRig({
      outcomes: [{ version: OLD_AD_VERSION, path: binaryPathFor('record-throws') }],
      recordStartupError: () => {
        throw new Error('stub record failure')
      },
    })
    await rig.clock.advance(AD_VERSION_RECHECK_INTERVAL_MS)
    expectStoppedOnce(rig, AD_BELOW_PHASE1_FLOOR)
    expect(rig.logs).toHaveLength(1)
  })

  test('the real recordStartupError writes one entry carrying the floor label, both versions, the path and the runtime phrase', async () => {
    const logDir = mkdtempSync(join(tmpdir(), 'cscb-ad-version-recheck-'))
    tempDirs.push(logDir)
    const path = binaryPathFor('real-record')
    const rig = makeRecheckRig({
      outcomes: [{ version: OLD_AD_VERSION, path }],
      recordStartupError: (classLabel, message) => recordStartupError(classLabel, message, undefined, { logDir }),
    })
    await rig.clock.advance(AD_VERSION_RECHECK_INTERVAL_MS)
    expectStoppedOnce(rig, AD_BELOW_PHASE1_FLOOR)
    const lines = readFileSync(join(logDir, 'startup-errors.log'), 'utf-8').split('\n').filter((line) => line !== '')
    expect(lines).toHaveLength(1)
    for (const text of [`[${AD_BELOW_PHASE1_FLOOR}]`, OLD_AD_VERSION, PHASE1_FLOOR_VERSION, path, RUNTIME_RECHECK_PHRASE]) {
      expect(lines[0]).toContain(text)
    }
  })
})

describe('runtime re-check: no agent-director call after a stop', () => {
  test.each([
    ['below the floor', { version: OLD_AD_VERSION, path: binaryPathFor('no-verb-floor') }, AD_BELOW_PHASE1_FLOOR],
    ['too old for the client', { throws: errSystemInstallTooOld(STALE_VERSION, CLIENT_MIN_VERSION, binaryPathFor('no-verb-too-old')) }, AD_SYSTEM_INSTALL_TOO_OLD],
  ] as Array<[string, StubResolveSystemBinaryOutcome, string]>)('%s: the installed stub client logs no verb and the exit code is non-zero', async (_label, outcome, classLabel) => {
    const calls = makeStubCallLog()
    setClientForTests(makeStubClient(calls) as unknown as Parameters<typeof setClientForTests>[0])
    const rig = makeRecheckRig({ outcomes: [outcome] })
    await rig.clock.advance(AD_VERSION_RECHECK_INTERVAL_MS)
    expectStoppedOnce(rig, classLabel)
    await rig.clock.advance(AD_VERSION_RECHECK_INTERVAL_MS * 3)
    expect(stubCallCount(calls)).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// Runtime re-check: the time limit on one call
// ---------------------------------------------------------------------------

describe('runtime re-check: time limit', () => {
  test('a call that never settles becomes could-not-run at the time limit; no second call overlaps it; the next interval still calls', async () => {
    const rig = makeRecheckRig({ outcomes: [{ never: true }, { version: PHASE1_RC_VERSION }] })
    await rig.clock.advance(AD_VERSION_RECHECK_INTERVAL_MS)
    expect(rig.callCount()).toBe(1)
    const pending = rig.clock.pending()
    expect(pending).toHaveLength(1)
    expect(pending[0]!.delayMs).toBe(AD_VERSION_RECHECK_TIME_LIMIT_MS)
    await rig.clock.advance(AD_VERSION_RECHECK_TIME_LIMIT_MS - 1)
    expect(rig.events).toEqual(['call'])
    await rig.clock.advance(1)
    expect(rig.events).toEqual(['call', 'tick'])
    expectNextRecheckArmed(rig)
    await rig.clock.advance(AD_VERSION_RECHECK_INTERVAL_MS)
    expect(rig.events).toEqual(['call', 'tick', 'call', 'tick'])
    expect(rig.records).toHaveLength(0)
    expect(rig.stops).toHaveLength(0)
  })

  test('a below-floor answer arriving after the time limit is ignored', async () => {
    const late = deferredAnswer()
    const rig = makeRecheckRig({ resolveSystemBinary: () => late.promise })
    await rig.clock.advance(AD_VERSION_RECHECK_INTERVAL_MS + AD_VERSION_RECHECK_TIME_LIMIT_MS)
    expectNextRecheckArmed(rig)
    late.resolve({ version: OLD_AD_VERSION, path: binaryPathFor('late-answer') })
    await rig.clock.flush()
    expect(rig.events).toEqual(['call', 'tick'])
    expect(rig.records).toHaveLength(0)
    expect(rig.stops).toHaveLength(0)
    expectNextRecheckArmed(rig)
  })

  test('an answer inside the time limit clears the limit timer: only the next re-check stays pending', async () => {
    const answer = deferredAnswer()
    const rig = makeRecheckRig({ resolveSystemBinary: () => answer.promise })
    await rig.clock.advance(AD_VERSION_RECHECK_INTERVAL_MS + AD_VERSION_RECHECK_TIME_LIMIT_MS - 1)
    answer.resolve({ version: PHASE1_RC_VERSION, path: binaryPathFor('in-time') })
    await rig.clock.flush()
    expect(rig.events).toEqual(['call', 'tick'])
    expectNextRecheckArmed(rig)
  })
})

// ---------------------------------------------------------------------------
// Runtime re-check: dispose
// ---------------------------------------------------------------------------

describe('runtime re-check: dispose', () => {
  test('before any tick: nothing runs after any advance, dispose is idempotent and a later start arms nothing', async () => {
    const rig = makeRecheckRig()
    rig.recheck.dispose()
    expect(rig.clock.pendingCount()).toBe(0)
    rig.recheck.dispose()
    await rig.clock.advance(AD_VERSION_RECHECK_INTERVAL_MS * 5)
    expect(rig.events).toEqual([])
    expect(rig.clock.pendingCount()).toBe(0)
  })

  test('dispose before start: a later start is a logged no-op', async () => {
    const rig = makeRecheckRig({ start: false })
    rig.recheck.dispose()
    rig.recheck.start()
    expect(rig.logs).toHaveLength(1)
    expect(rig.clock.pendingCount()).toBe(0)
    await rig.clock.advance(AD_VERSION_RECHECK_INTERVAL_MS * 2)
    expect(rig.events).toEqual([])
  })

  test('during a call in flight: a later below-floor answer records, stops and ticks nothing, and no timer is left', async () => {
    const answer = deferredAnswer()
    const rig = makeRecheckRig({ resolveSystemBinary: () => answer.promise })
    await rig.clock.advance(AD_VERSION_RECHECK_INTERVAL_MS)
    expect(rig.events).toEqual(['call'])
    rig.recheck.dispose()
    expect(rig.clock.pendingCount()).toBe(0)
    answer.resolve({ version: OLD_AD_VERSION, path: binaryPathFor('disposed-in-flight') })
    await rig.clock.flush()
    await rig.clock.advance(AD_VERSION_RECHECK_INTERVAL_MS * 3)
    expect(rig.events).toEqual(['call'])
    expect(rig.clock.pendingCount()).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// Runtime re-check: the tick hook (b.jg5 SRJ-209)
// ---------------------------------------------------------------------------

describe('runtime re-check: tick hook', () => {
  test('a listener runs once per timed re-check after it finishes, on pass and on could-not-run, with the next re-check already armed', async () => {
    const armedAtTick: number[] = []
    let rig: RecheckRig | undefined
    rig = makeRecheckRig({
      outcomes: [{ version: PHASE1_RC_VERSION }, { throws: errSystemInstallNotFound() }, { never: true }],
      tickListeners: [() => { armedAtTick.push(rig!.clock.pendingCount()) }],
    })
    await rig.clock.advance(AD_VERSION_RECHECK_INTERVAL_MS * 2)
    expect(rig.events).toEqual(['call', 'tick', 'call', 'tick'])
    await rig.clock.advance(AD_VERSION_RECHECK_INTERVAL_MS)
    expect(rig.events).toEqual(['call', 'tick', 'call', 'tick', 'call'])
    await rig.clock.advance(AD_VERSION_RECHECK_TIME_LIMIT_MS)
    expect(rig.events).toEqual(['call', 'tick', 'call', 'tick', 'call', 'tick'])
    expect(armedAtTick).toEqual([1, 1, 1])
  })

  test('not on a stopping tick', async () => {
    const rig = makeRecheckRig({ outcomes: [{ version: PHASE1_RC_VERSION }, { version: OLD_AD_VERSION, path: binaryPathFor('tick-stop') }] })
    await rig.clock.advance(AD_VERSION_RECHECK_INTERVAL_MS * 2)
    expect(rig.events).toEqual(['call', 'tick', 'call', 'record', 'stop'])
    expect(rig.tickCount()).toBe(1)
  })

  test('not after dispose', async () => {
    const rig = makeRecheckRig()
    await rig.clock.advance(AD_VERSION_RECHECK_INTERVAL_MS)
    expect(rig.tickCount()).toBe(1)
    rig.recheck.dispose()
    await rig.clock.advance(AD_VERSION_RECHECK_INTERVAL_MS * 3)
    expect(rig.tickCount()).toBe(1)
  })

  test('a throwing listener is logged once per tick, later listeners still run and the next tick still arms', async () => {
    const after: number[] = []
    const rig = makeRecheckRig({
      tickListeners: [
        () => {
          throw new Error('stub listener failure')
        },
        () => { after.push(1) },
      ],
    })
    await rig.clock.advance(AD_VERSION_RECHECK_INTERVAL_MS)
    expect(rig.logs).toHaveLength(1)
    expect(after).toHaveLength(1)
    expectNextRecheckArmed(rig)
    await rig.clock.advance(AD_VERSION_RECHECK_INTERVAL_MS)
    expect(rig.callCount()).toBe(2)
    expect(rig.logs).toHaveLength(2)
    expect(after).toHaveLength(2)
  })

  test('a rejecting listener is logged once and the next tick still arms', async () => {
    const rig = makeRecheckRig({ tickListeners: [() => Promise.reject(new Error('stub listener rejection'))] })
    await rig.clock.advance(AD_VERSION_RECHECK_INTERVAL_MS)
    expect(rig.logs).toHaveLength(1)
    expectNextRecheckArmed(rig)
    expect(rig.records).toHaveLength(0)
    expect(rig.stops).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// Runtime re-check: the module-level install used by main() and shutdown()
// ---------------------------------------------------------------------------

describe('runtime re-check: module-level install, dispose and tick registration', () => {
  function installDeps(clock: FakeClock, logs: string[], resolveCalls: Array<object | undefined>): Omit<AdVersionRecheckDeps, 'tickListeners'> {
    return {
      resolveSystemBinary: makeStubResolveSystemBinary({ calls: resolveCalls }),
      baselineVersion: BASELINE_VERSION,
      recordStartupError: () => {},
      stop: () => {},
      log: (line) => { logs.push(line) },
      clock,
    }
  }

  test('install starts the re-check; a second install is a logged no-op returning the same handle and arming nothing', async () => {
    const clock = createFakeClock()
    const secondClock = createFakeClock()
    const calls: Array<object | undefined> = []
    const secondLogs: string[] = []
    const first = installAdVersionRecheck(installDeps(clock, [], calls))
    expect(first).toBeDefined()
    expect(clock.pendingCount()).toBe(1)
    const second = installAdVersionRecheck(installDeps(secondClock, secondLogs, calls))
    expect(second).toBe(first)
    expect(secondLogs).toHaveLength(1)
    expect(secondClock.pendingCount()).toBe(0)
    await clock.advance(AD_VERSION_RECHECK_INTERVAL_MS)
    expect(calls).toHaveLength(1)
  })

  test('dispose clears the timer and is idempotent; an install after dispose is a logged no-op', async () => {
    const clock = createFakeClock()
    const calls: Array<object | undefined> = []
    installAdVersionRecheck(installDeps(clock, [], calls))
    disposeAdVersionRecheck()
    disposeAdVersionRecheck()
    expect(clock.pendingCount()).toBe(0)
    const laterClock = createFakeClock()
    const laterLogs: string[] = []
    expect(installAdVersionRecheck(installDeps(laterClock, laterLogs, calls))).toBeUndefined()
    expect(laterLogs).toHaveLength(1)
    expect(laterClock.pendingCount()).toBe(0)
    await clock.advance(AD_VERSION_RECHECK_INTERVAL_MS * 2)
    expect(calls).toHaveLength(0)
  })

  test('dispose with nothing installed is a no-op', () => {
    expect(() => disposeAdVersionRecheck()).not.toThrow()
  })

  test('a registered listener runs on each tick, before or after install; its unsubscribe removes only its own', async () => {
    const ticks: string[] = []
    const unsubscribeA = onAdVersionRecheckTick(() => { ticks.push('a') })
    const clock = createFakeClock()
    installAdVersionRecheck(installDeps(clock, [], []))
    onAdVersionRecheckTick(() => { ticks.push('b') })
    await clock.advance(AD_VERSION_RECHECK_INTERVAL_MS)
    expect(ticks).toEqual(['a', 'b'])
    unsubscribeA()
    await clock.advance(AD_VERSION_RECHECK_INTERVAL_MS)
    expect(ticks).toEqual(['a', 'b', 'b'])
  })
})

// ---------------------------------------------------------------------------
// Runtime refusal messages (b.jg5 SRJ-205, SRJ-208, SRJ-1013)
// ---------------------------------------------------------------------------

describe('runtime refusal messages', () => {
  const floorParts = { foundVersion: OLD_AD_VERSION, binaryPath: binaryPathFor('message-floor') }
  const tooOldParts = { foundVersion: STALE_VERSION, requiredVersion: CLIENT_MIN_VERSION, binaryPath: binaryPathFor('message-too-old') }

  test.each([
    ['ad-below-phase1-floor', buildBelowPhase1FloorMessage(floorParts, FOUND_BY_RUNTIME_RECHECK), buildBelowPhase1FloorMessage(floorParts)],
    ['ad-system-install-too-old', buildSystemInstallTooOldMessage(tooOldParts, FOUND_BY_RUNTIME_RECHECK), buildSystemInstallTooOldMessage(tooOldParts)],
  ])('%s: the runtime form carries the runtime phrase and the startup (default) form does not', (_label, runtime, startup) => {
    expect(runtime).toContain(RUNTIME_RECHECK_PHRASE)
    expect(startup).not.toContain(RUNTIME_RECHECK_PHRASE)
    for (const message of [runtime, startup]) {
      expect(message).toContain(PHASE1_RUNBOOK_SECTION_TITLE)
      expect(message).not.toContain(renderInstallSkillInstructions())
    }
  })
})

// ---------------------------------------------------------------------------
// No Slack post on a runtime refusal (contribution to b.jg5 SRJ-1002)
// ---------------------------------------------------------------------------

describe('runtime re-check: no Slack post (source audit)', () => {
  /** Specifiers of every value import or re-export in comment-stripped code (`import type` / `export type` excluded). */
  function valueImportSpecifiers(code: string): string[] {
    const specifiers: string[] = []
    for (const m of code.matchAll(/\b(import|export)\s+(type\s+)?[^'";]*?\bfrom\s+['"]([^'"]+)['"]/g)) {
      if (m[2] === undefined) specifiers.push(m[3]!)
    }
    for (const m of code.matchAll(/\bimport\s*(?:\(\s*)?['"]([^'"]+)['"]/g)) specifiers.push(m[1]!)
    return specifiers
  }

  test('src/ad-version-gate.ts value-imports no Slack client, notifier or persona-notifier module', () => {
    const code = stripComments(readFileSync(join(import.meta.dir, '..', 'src', 'ad-version-gate.ts'), 'utf-8'))
    const specifiers = valueImportSpecifiers(code)
    expect(specifiers.length).toBeGreaterThan(0)
    for (const specifier of specifiers) {
      expect(specifier).not.toMatch(/^@slack\//)
      expect(specifier).not.toMatch(/notifier/)
      expect(specifier).not.toMatch(/persona-slack-|persona-connections|slack-client|server\.ts$/)
    }
    expect(code).not.toMatch(/\bchat\.postMessage\b|\bpostMessage\s*\(/)
  })
})
