/**
 * ad-version-gate.test.ts — CSCB's Phase 1 floor (b.jg5 SRJ-201), its
 * comparison (b.jg5 SRJ-202), the shared test versions (b.jg5 SRJ-1304; the
 * Claude Code minimum `MIN_CLAUDE_CODE_VERSION` by its form, and by a scan
 * that finds its value in the code, comments stripped, of no `tests/`
 * TypeScript file but the helper's) and the runtime re-check of the host binary (b.jg5 SRJ-204, SRJ-205): its one
 * log line per run of could-not-run results (b.jg5 SRJ-206, AC 22), the
 * immediate trigger (AC 23's first half) and the version-changed signal;
 * the host-version decision shared by `/publish`'s SR-2.5 check and the
 * install check (b.jg5 SRJ-211, SRJ-212; AC 81), the reason word of a version
 * that cannot be read (agent-director's own, `UNREACHABLE_REASON_UNKNOWN` for
 * an absent or unsafe one, `UNREACHABLE_REASON_UNPARSEABLE_VERSION` for a
 * resolved version that does not parse), its settle step
 * (`settleHostVersionCall`), the one-line redaction its callers apply
 * (`redactToOneLine`), its client-order comparison and its Phase 1 note; and
 * a source audit of the import-cycle fix (`src/install-check-labels.ts`,
 * every label of which `src/install-check.ts` re-exports); and the
 * `ErrInvalidFlags` hold (`src/invalid-flags-hold.ts`, b.jg5 SRJ-207,
 * SRJ-1008, AC 23): SRJ-1008's text (written out once, in its pin case), the
 * hold decision on each re-check answer, the last version seen it begins
 * under (`lastAdVersionSeen`), one alert per hold episode after the retry
 * timer's stop, its end on the version-changed signal (with the listener
 * registered as `main()` registers it, a retry at once for each applied
 * persona), its other ends (a teardown's forget, shutdown, a server restart)
 * and the below-floor stop, on a hold composed as `main()` composes it. And
 * b.jg5 SRJ-1204's bound citing SRJ-204 and SRJ-209: with the settings read
 * installed on the re-check's tick, one re-check and one read per interval,
 * the `ErrInvalidFlags` step's trigger the only extra re-check.
 *
 * Every version is built from the floor constant's parts or imported from
 * `tests/test-helpers/agent-director-versions.ts`, so a change to
 * `PHASE1_FLOOR_VERSION` moves every case with it. Every class label,
 * interval, time limit, runbook title and the runtime phrase is imported from
 * `src/`; one case pins the interval constant to SRJ-204's 120 s.
 *
 * `PHASE1_FLOOR_VERSION` is confirmed from the Phase 1 release (SRJ-201),
 * the agent-director version `package.json` pins exactly (checked in
 * `tests/packaging-completeness.test.ts`). The floor cases hold for it: the
 * release before Phase 1 and the dev sentinel are refused, the floor and its
 * release candidates pass, later versions pass, and an earlier version's
 * release candidate is refused. Its lexical traps (`LEXICAL_TRAPS`) are not
 * empty, so a string comparison planted in the floor check fails a case.
 * `tests/ci-live-docker.test.ts` checks that the release candidate pinned in
 * `docker/Dockerfile.test.base` (`AD_RC_VERSION`) has the floor as its
 * major.minor.patch and passes it (SRJ-201, SRJ-202). Here, the
 * `PHASE1_RC_VERSION` case (it parses as the floor with pre-release `rc.1`,
 * SRJ-1304) guards the versions helper's shape only, since the helper builds
 * it from the floor; and any `<floor>-rc.N` passes the floor (SRJ-202).
 *
 * The runtime re-check runs on `createFakeClock` with
 * `makeStubResolveSystemBinary` and no health check (the
 * `health_check_interval` 0 condition): its own timer is the only one armed.
 *
 * No process, no real HOME, no real timer, no top-level mock.module(), no
 * value import of `Client` or `resolveSystemBinary`. Module state (the
 * installed re-check, the tick and version-changed listeners, the client
 * singleton) is reset and temp directories are removed in `afterEach`.
 *
 * SPDX-License-Identifier: MIT
 */

import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import semver from 'semver'

import { DEV_SENTINEL_VERSION } from 'agent-director'

import {
  AD_VERSION_RECHECK_COULD_NOT_RUN_LOG_PREFIX,
  AD_VERSION_RECHECK_INTERVAL_MS,
  AD_VERSION_RECHECK_STOP_EXIT_CODE,
  AD_VERSION_RECHECK_TIME_LIMIT_MS,
  buildAdVersionRecheckCouldNotRunLine,
  buildPhase1HostNote,
  CLIENT_DEV_SENTINEL_VERSION,
  buildBelowPhase1FloorMessage,
  buildSystemInstallTooOldMessage,
  compareAdVersions,
  createAdVersionRecheck,
  decideAdVersionRecheckOutcome,
  decideHostAdVersion,
  DEBUG_SKILL_RUNTIME_STOP_POINTER,
  disposeAdVersionRecheck,
  FOUND_BY_RUNTIME_RECHECK,
  HOST_VERSION_FAIL_BELOW_CLIENT_MINIMUM,
  HOST_VERSION_FAIL_CLIENT_MINIMUM_UNREADABLE,
  HOST_VERSION_FAIL_NOT_FOUND,
  HOST_VERSION_FAIL_OTHER,
  HOST_VERSION_FAIL_VERSION_UNREADABLE,
  HOST_VERSION_OUTCOME_FAIL,
  HOST_VERSION_OUTCOME_PASS,
  HOST_VERSION_OUTCOME_PASS_BELOW_FLOOR,
  installAdVersionRecheck,
  lastAdVersionSeen,
  meetsPhase1Floor,
  onAdVersionChanged,
  onAdVersionRecheckTick,
  PHASE1_FLOOR_VERSION,
  PHASE1_HOST_NOTE_PHRASE,
  PHASE1_REQUIRED_PHRASE,
  PHASE1_RUNBOOK_SECTION_TITLE,
  RECHECK_OUTCOME_COULD_NOT_RUN,
  RECHECK_OUTCOME_NOT_RUNNING,
  RECHECK_OUTCOME_PASS,
  RECHECK_OUTCOME_STOP,
  redactToOneLine,
  resetAdVersionRecheckForTests,
  RUNTIME_RECHECK_PHRASE,
  settleHostVersionCall,
  triggerAdVersionRecheck,
  UNREACHABLE_REASON_UNKNOWN,
  UNREACHABLE_REASON_UNPARSEABLE_VERSION,
  type AdVersionChangedListener,
  type AdVersionRecheck,
  type AdVersionRecheckDeps,
  type AdVersionRecheckTickListener,
  type HostVersionCallResult,
  type HostVersionFailure,
  type HostVersionOutcome,
} from '../src/ad-version-gate.ts'
import { classifyWithInvalidFlagsRecheck } from '../src/ad-error-class.ts'
import { installAdSettings, resetAdSettingsForTests } from '../src/ad-settings.ts'
import { resetClientForTests, setClientForTests } from '../src/agent-director-client.ts'
import * as installCheck from '../src/install-check.ts'
import * as installCheckLabels from '../src/install-check-labels.ts'
import { AD_BELOW_PHASE1_FLOOR, AD_SYSTEM_INSTALL_TOO_OLD } from '../src/install-check-labels.ts'
import { REDACTED_TOKEN_PLACEHOLDER } from '../src/slack-log-redaction.ts'
import { recordStartupError } from '../src/startup-errors.ts'
import {
  bindInvalidFlagsHoldSetReaction,
  createInvalidFlagsHold,
  decideInvalidFlagsHold,
  describeHoldVersion,
  endInvalidFlagsHoldsOnVersionChange,
  HOLD_VERSION_UNKNOWN,
  HOLD_VERSION_UNREADABLE,
  INVALID_FLAGS_HOLD_ALERT_TEXT,
  INVALID_FLAGS_HOLD_DECISION_HOLD,
  INVALID_FLAGS_HOLD_DECISION_STOP,
  INVALID_FLAGS_HOLD_END_FORGOTTEN,
  INVALID_FLAGS_HOLD_LOG_PREFIX,
  invalidFlagsHoldEndLine,
  invalidFlagsHoldForgetLine,
  invalidFlagsHoldRetryLine,
  invalidFlagsHoldSetLine,
  type InvalidFlagsHold,
} from '../src/invalid-flags-hold.ts'
import { createPersonaEpisodes, PERSONA_EPISODE_KIND_INVALID_FLAGS_HOLD, type PersonaEpisodes } from '../src/persona-episodes.ts'
import { setSessionNotifier } from '../src/session-manager.ts'
import { sessionEndingCommandsIn } from './test-helpers/conflict-cases.ts'
import {
  errBunVersionTooOld,
  errInvalidFlags,
  errSystemInstallNotFound,
  errSystemInstallTooOld,
  errSystemInstallUnreachable,
  errTmuxUnresponsive,
  makeStubCallLog,
  makeStubClient,
  makeStubResolveSystemBinary,
  stubCallCount,
  type StubResolveSystemBinaryOutcome,
} from './test-helpers/agent-director-stub.ts'
import {
  BELOW_CLIENT_MIN_VERSION,
  CLIENT_MIN_VERSION,
  DEV_PLACEHOLDER_VERSION,
  DEV_UNPARSEABLE_VERSION,
  MIN_CLAUDE_CODE_VERSION,
  OLD_AD_VERSION,
  PHASE1_RC_VERSION,
} from './test-helpers/agent-director-versions.ts'
import {
  assertNoLeak,
  BOT_TOKEN_PREFIX,
  fakeToken,
  LEAK_SENTINEL,
  REDACTED_SENTINEL_TAIL,
  sentinelInMessage,
} from './test-helpers/credentials.ts'
import { createFakeClock, type FakeClock } from './test-helpers/fake-clock.ts'
import { STALE_VERSION, UNREACHABLE_REASONS } from './test-helpers/install-check-fixtures.ts'
import { flat } from './test-helpers/markdown.ts'
import { importSource, stripComments } from './test-helpers/source-audit.ts'
import { UPGRADE_FORMS } from './test-helpers/upgrade-forms.ts'
import { expectRuntimeEntryPointsToDebugSkill } from './test-helpers/ad-version-entries.ts'

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

  /** Later release candidates of the floor; rc.10 sorts below rc.2 as a string, above it in SemVer. */
  const FLOOR_RC_2 = `${PHASE1_FLOOR_VERSION}-rc.2`
  const FLOOR_RC_10 = `${PHASE1_FLOOR_VERSION}-rc.10`

  test('self-check: the floor\'s rc.10 sorts below its rc.2 as a string and above it in SemVer, and both sit below the floor in SemVer', () => {
    expect(FLOOR_RC_10 < FLOOR_RC_2).toBe(true)
    expect(semver.gt(FLOOR_RC_10, FLOOR_RC_2)).toBe(true)
    expect(semver.lt(FLOOR_RC_2, PHASE1_FLOOR_VERSION)).toBe(true)
    expect(semver.lt(FLOOR_RC_10, PHASE1_FLOOR_VERSION)).toBe(true)
  })

  test.each([
    ["the floor's rc.2", FLOOR_RC_2],
    ["the floor's rc.10", FLOOR_RC_10],
  ])('passes %s (%s): a <floor>-rc.N counts as the floor, the pre-release not compared (SRJ-201, SRJ-202)', (_label, version) => {
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
  test("PHASE1_RC_VERSION is the floor's first release candidate: strict SemVer, the floor's major.minor.patch, pre-release rc.1 (SRJ-201, SRJ-1304)", () => {
    const rc = semver.parse(PHASE1_RC_VERSION)
    const floor = semver.parse(PHASE1_FLOOR_VERSION)
    expect(rc).not.toBeNull()
    expect(floor).not.toBeNull()
    // Strict: the parsed form is the whole string (no leading v, no +build, no whitespace).
    expect(rc!.version).toBe(PHASE1_RC_VERSION)
    expect([rc!.major, rc!.minor, rc!.patch]).toEqual([floor!.major, floor!.minor, floor!.patch])
    expect(rc!.prerelease).toEqual(['rc', 1])
    expect(rc!.build).toEqual([])
  })

  test('OLD_AD_VERSION is at or above the client minimum: the client admits it, only CSCB refuses it', () => {
    expect(semver.gte(OLD_AD_VERSION, CLIENT_MIN_VERSION)).toBe(true)
    expect(meetsPhase1Floor(OLD_AD_VERSION)).toBe(false)
  })

  test("CLIENT_MIN_VERSION is the installed client's version-floor.json value", async () => {
    const floorPath = Bun.resolveSync('agent-director/dist/version-floor.json', import.meta.dir)
    const floorJson = (await Bun.file(floorPath).json()) as { min_binary_version: unknown }
    expect(CLIENT_MIN_VERSION).toBe(floorJson.min_binary_version as string)
  })

  test('MIN_CLAUDE_CODE_VERSION is a strict SemVer release, with no pre-release or build part', () => {
    expect(MIN_CLAUDE_CODE_VERSION).toMatch(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/)
  })

  /** Every TypeScript file under `dir`, relative to it, and a reader of one's code with its comments stripped. */
  function typeScriptCodeIn(dir: string): { readonly files: string[]; codeOf(rel: string): string } {
    const files = readdirSync(dir, { recursive: true, encoding: 'utf-8' })
      .filter((rel) => /\.[cm]?tsx?$/.test(rel) && !rel.split(sep).includes('node_modules'))
    return { files, codeOf: (rel) => stripComments(readFileSync(join(dir, rel), 'utf-8')) }
  }

  test('no tests/ TypeScript file but the helper writes MIN_CLAUDE_CODE_VERSION in code (comments stripped)', () => {
    const helper = join('test-helpers', 'agent-director-versions.ts')
    const { files, codeOf } = typeScriptCodeIn(import.meta.dir)
    // Not vacuous: the scan reads the helper, and the needle is found in its code.
    expect(files).toContain(helper)
    expect(codeOf(helper)).toContain(MIN_CLAUDE_CODE_VERSION)
    expect(files.filter((rel) => rel !== helper && codeOf(rel).includes(MIN_CLAUDE_CODE_VERSION)).sort()).toEqual([])
  })

  test('no src/ TypeScript file writes MIN_CLAUDE_CODE_VERSION in code (comments stripped): no src/ module defines or reads a Claude Code version', () => {
    const { files, codeOf } = typeScriptCodeIn(join(import.meta.dir, '..', 'src'))
    // Not vacuous: the scan reads src/, the gate module included.
    expect(files).toContain('ad-version-gate.ts')
    expect(codeOf('ad-version-gate.ts')).toContain('PHASE1_FLOOR_VERSION')
    expect(files.filter((rel) => codeOf(rel).includes(MIN_CLAUDE_CODE_VERSION)).sort()).toEqual([])
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
  /** Version-changed listeners run after the rig's own capturing one. */
  versionChangedListeners?: readonly AdVersionChangedListener[]
  /** Call `start()` (default true). */
  start?: boolean
}

/**
 * One re-check on one fake clock and one stub resolve, with capturing record,
 * stop, log, tick and version-changed hooks. Its first tick listener pushes
 * `tick`, so `events` shows every call, record, stop and tick in order.
 */
interface RecheckRig {
  readonly clock: FakeClock
  readonly recheck: AdVersionRecheck
  readonly events: RecheckEvent[]
  readonly records: Array<{ classLabel: string; message: string }>
  readonly stops: number[]
  readonly logs: string[]
  /** Each version-changed signal as [previous version, new version], in order. */
  readonly changes: Array<[string, string]>
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
  const changes: Array<[string, string]> = []
  const stub = opts.resolveSystemBinary ?? makeStubResolveSystemBinary(opts.outcomes ? { outcomes: opts.outcomes } : {})
  const listeners: AdVersionRecheckTickListener[] = [() => { events.push('tick') }, ...(opts.tickListeners ?? [])]
  const changedListeners: AdVersionChangedListener[] = [
    (previousVersion, newVersion) => { changes.push([previousVersion, newVersion]) },
    ...(opts.versionChangedListeners ?? []),
  ]
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
    versionChangedListeners: () => changedListeners,
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
    changes,
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

/** A clock advance well past both the interval and the time limit, from the exported constants. */
const WELL_PAST_INTERVAL_AND_LIMIT = (AD_VERSION_RECHECK_INTERVAL_MS + AD_VERSION_RECHECK_TIME_LIMIT_MS) * 3

/** The not-running answer, built from the exported kind. */
const NOT_RUNNING = { kind: RECHECK_OUTCOME_NOT_RUNNING } as const

/**
 * Each waiter's answer as it settles, `undefined` until then, so a case can
 * tell an answer given at once from one that waits on the call.
 */
function trackAnswers(
  waiters: ReadonlyArray<ReturnType<AdVersionRecheck['trigger']>>,
): Array<Awaited<ReturnType<AdVersionRecheck['trigger']>> | undefined> {
  const answers: Array<Awaited<ReturnType<AdVersionRecheck['trigger']>> | undefined> = waiters.map(() => undefined)
  waiters.forEach((waiter, i) => {
    void waiter.then((answer) => { answers[i] = answer })
  })
  return answers
}

/** Assert the rig acted on nothing after its one call: no record, stop, log line, tick or version change, and no timer. */
function expectNothingAfterTheCall(rig: RecheckRig): void {
  expect(rig.events).toEqual(['call'])
  expect(rig.records).toEqual([])
  expect(rig.stops).toEqual([])
  expect(rig.logs).toEqual([])
  expect(rig.changes).toEqual([])
  expect(rig.tickCount()).toBe(0)
  expect(rig.clock.pendingCount()).toBe(0)
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

/**
 * Run `act` with the session manager's notice sink recording, where a Slack
 * notice for a persona would go (b.jg5 SRJ-1002): answers every notice it
 * received.
 */
async function noticesDuring(act: () => Promise<unknown>): Promise<Array<[string, string]>> {
  const notices: Array<[string, string]> = []
  setSessionNotifier((key, text) => { notices.push([key, text]) })
  try {
    await act()
  } finally {
    setSessionNotifier(undefined)
  }
  return notices
}

afterEach(() => {
  for (const recheck of liveRigs.splice(0)) recheck.dispose()
  resetAdVersionRecheckForTests()
  resetAdSettingsForTests()
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
  ])('%s (%s): one record naming the found version, the floor, the path, the runtime phrase, that Phase 1 is required and the debug skill, then one non-zero stop; no re-check line and no notice (b.jg5 SRJ-1002)', async (_label, version, path) => {
    const rig = makeRecheckRig({ outcomes: [{ version, path }] })
    expect(await noticesDuring(() => rig.clock.advance(AD_VERSION_RECHECK_INTERVAL_MS))).toEqual([])
    expect(rig.logs).toEqual([])
    const message = expectStoppedOnce(rig, AD_BELOW_PHASE1_FLOOR)
    expect(message).toBe(buildBelowPhase1FloorMessage({ foundVersion: version, binaryPath: path }, FOUND_BY_RUNTIME_RECHECK))
    for (const text of [version, PHASE1_FLOOR_VERSION, path, PHASE1_REQUIRED_PHRASE]) expect(message).toContain(text)
    expectRuntimeEntryPointsToDebugSkill(message)
    expect(rig.recheck.lastVersionSeen()).toBe(BASELINE_VERSION)
  })
})

describe("runtime re-check: the client's too-old refusal stops the server (ad-system-install-too-old)", () => {
  test("ErrSystemInstallTooOld: one record naming the error's versions, the floor, the path, the runtime phrase and the debug skill, with no install-skill block; then one non-zero stop; no re-check line and no notice (b.jg5 SRJ-1002)", async () => {
    const path = binaryPathFor('too-old')
    const tooOld = errSystemInstallTooOld(STALE_VERSION, CLIENT_MIN_VERSION, path)
    const rig = makeRecheckRig({ outcomes: [{ throws: tooOld }] })
    expect(await noticesDuring(() => rig.clock.advance(AD_VERSION_RECHECK_INTERVAL_MS))).toEqual([])
    expect(rig.logs).toEqual([])
    const message = expectStoppedOnce(rig, AD_SYSTEM_INSTALL_TOO_OLD)
    expect(message).toBe(
      buildSystemInstallTooOldMessage({ foundVersion: tooOld.actualVersion, requiredVersion: tooOld.requiredVersion, binaryPath: tooOld.binaryPath }, FOUND_BY_RUNTIME_RECHECK),
    )
    for (const text of [tooOld.actualVersion, tooOld.requiredVersion, PHASE1_FLOOR_VERSION, tooOld.binaryPath]) expect(message).toContain(text)
    expect(message.endsWith(`${DEBUG_SKILL_RUNTIME_STOP_POINTER}.`)).toBe(true)
    expectRuntimeEntryPointsToDebugSkill(message)
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

  test.each([
    ['a thrown string', sentinelInMessage('thrown-string')],
    ['a thrown null', null],
    ['a plain object with no name', { detail: LEAK_SENTINEL }],
    ['an error whose errName is token-shaped', Object.assign(new Error('stub resolve failure'), { errName: fakeToken(BOT_TOKEN_PREFIX, 'errname') })],
  ] as Array<[string, unknown]>)('a rejection with %s: could-not-run, one token-free line, one timer re-armed', async (_label, rejection) => {
    const rig = makeRecheckRig({ resolveSystemBinary: () => Promise.reject(rejection) })
    await rig.clock.advance(AD_VERSION_RECHECK_INTERVAL_MS)
    expect(rig.events).toEqual(['call', 'tick'])
    expect(rig.records).toHaveLength(0)
    expect(rig.stops).toHaveLength(0)
    expectNextRecheckArmed(rig)
    expect(rig.logs).toHaveLength(1)
    expect(rig.logs[0]!.startsWith(AD_VERSION_RECHECK_COULD_NOT_RUN_LOG_PREFIX)).toBe(true)
    assertNoLeak(rig.logs, 'logs')
  })
})

// ---------------------------------------------------------------------------
// Runtime re-check: the stop (SRJ-205)
// ---------------------------------------------------------------------------

describe('runtime re-check: a stop happens once, record before stop', () => {
  test('after a pass then a below-floor answer, further advances call nothing and record and stop are not called again (no tick on the stopping re-check)', async () => {
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
    for (const text of [`[${AD_BELOW_PHASE1_FLOOR}]`, OLD_AD_VERSION, PHASE1_FLOOR_VERSION, path, PHASE1_REQUIRED_PHRASE]) {
      expect(lines[0]).toContain(text)
    }
    expectRuntimeEntryPointsToDebugSkill(lines[0]!)
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
  test.each([
    ['before the first tick', 0, []],
    ['after one tick', 1, ['call', 'tick']],
  ] as Array<[string, number, RecheckEvent[]]>)('%s: nothing runs (no call, no tick) after any advance, dispose is idempotent and a later start arms nothing', async (_label, intervals, before) => {
    const rig = makeRecheckRig()
    await rig.clock.advance(AD_VERSION_RECHECK_INTERVAL_MS * intervals)
    expect(rig.events).toEqual(before)
    rig.recheck.dispose()
    expect(rig.clock.pendingCount()).toBe(0)
    rig.recheck.dispose()
    rig.recheck.start()
    expect(rig.clock.pendingCount()).toBe(0)
    await rig.clock.advance(AD_VERSION_RECHECK_INTERVAL_MS * 5)
    expect(rig.events).toEqual(before)
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

  test.each([
    ['timed', true],
    ['triggered', false],
  ])('during a %s call in flight: any waiter answers not-running before the call settles; the later below-floor answer records, stops, logs, ticks and signals nothing; no timer is left', async (label, timed) => {
    const answer = deferredAnswer()
    const rig = makeRecheckRig({ resolveSystemBinary: () => answer.promise })
    const waiters: Array<ReturnType<AdVersionRecheck['trigger']>> = []
    if (timed) await rig.clock.advance(AD_VERSION_RECHECK_INTERVAL_MS)
    else waiters.push(rig.recheck.trigger())
    const answers = trackAnswers(waiters)
    expect(rig.events).toEqual(['call'])
    rig.recheck.dispose()
    expect(rig.clock.pendingCount()).toBe(0)
    await rig.clock.flush()
    expect(answers).toEqual(waiters.map(() => NOT_RUNNING))
    answer.resolve({ version: OLD_AD_VERSION, path: binaryPathFor(`disposed-${label}`) })
    await rig.clock.flush()
    expect(answers).toEqual(waiters.map(() => NOT_RUNNING))
    expectNothingAfterTheCall(rig)
    await rig.clock.advance(AD_VERSION_RECHECK_INTERVAL_MS * 3)
    expectNothingAfterTheCall(rig)
  })

  test.each([
    ['joined to a timed check', true, 1, 1],
    ['two triggers', false, 2, 0],
  ])('%s waiting on a call that never settles: dispose answers every waiter not-running at once, with no clock advance; nothing is re-armed, fired, logged, ticked or signalled, even well past the interval and the limit; a later trigger answers not-running without a call', async (_label, timed, triggers, firedBefore) => {
    const rig = makeRecheckRig({ outcomes: [{ never: true }] })
    if (timed) {
      await rig.clock.advance(AD_VERSION_RECHECK_INTERVAL_MS)
      expect(rig.events).toEqual(['call'])
    }
    const answers = trackAnswers(Array.from({ length: triggers }, () => rig.recheck.trigger()))
    expect(rig.callCount()).toBe(1)
    await rig.clock.flush()
    expect(answers).toEqual(Array.from({ length: triggers }, () => undefined))
    const now = rig.clock.now()
    expect(rig.clock.firedCount()).toBe(firedBefore)
    rig.recheck.dispose()
    await rig.clock.flush()
    expect(answers).toEqual(Array.from({ length: triggers }, () => NOT_RUNNING))
    expect(rig.clock.now()).toBe(now)
    expectNothingAfterTheCall(rig)
    await rig.clock.advance(WELL_PAST_INTERVAL_AND_LIMIT)
    expectNothingAfterTheCall(rig)
    expect(rig.clock.firedCount()).toBe(firedBefore)
    expect(await rig.recheck.trigger()).toEqual(NOT_RUNNING)
    expect(rig.callCount()).toBe(1)
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

  test.each([
    ['throws', () => { throw new Error('stub listener failure') }],
    ['rejects', () => Promise.reject(new Error('stub listener rejection'))],
  ] as Array<[string, AdVersionRecheckTickListener]>)('a listener that %s is logged once per tick, later listeners still run and the next tick still arms', async (_label, failing) => {
    const after: number[] = []
    const rig = makeRecheckRig({ tickListeners: [failing, () => { after.push(1) }] })
    await rig.clock.advance(AD_VERSION_RECHECK_INTERVAL_MS)
    expect(rig.logs).toHaveLength(1)
    expect(after).toHaveLength(1)
    expectNextRecheckArmed(rig)
    await rig.clock.advance(AD_VERSION_RECHECK_INTERVAL_MS)
    expect(rig.callCount()).toBe(2)
    expect(rig.logs).toHaveLength(2)
    expect(after).toHaveLength(2)
    expect(rig.records).toHaveLength(0)
    expect(rig.stops).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// Runtime re-check: the module-level install used by main() and shutdown()
// ---------------------------------------------------------------------------

/** Deps for the module-level install: the stub resolve (its `outcomes` if given) records each call in `resolveCalls`. */
function installDeps(
  clock: FakeClock,
  logs: string[],
  resolveCalls: Array<object | undefined>,
  outcomes?: readonly StubResolveSystemBinaryOutcome[],
): Omit<AdVersionRecheckDeps, 'tickListeners' | 'versionChangedListeners'> {
  return {
    resolveSystemBinary: makeStubResolveSystemBinary(outcomes ? { calls: resolveCalls, outcomes } : { calls: resolveCalls }),
    baselineVersion: BASELINE_VERSION,
    recordStartupError: () => {},
    stop: () => {},
    log: (line) => { logs.push(line) },
    clock,
  }
}

describe('runtime re-check: module-level install, dispose and tick registration', () => {
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

  test('dispose clears the timer and is idempotent; the trigger then answers not-running and calls nothing; an install after dispose is a logged no-op', async () => {
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
    expect(await triggerAdVersionRecheck()).toEqual(NOT_RUNNING)
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
// Runtime re-check: one log line per run of could-not-run results (b.jg5 SRJ-206, AC 22)
// ---------------------------------------------------------------------------

/** The line a run that starts with `error` (a named agent-director error) writes: it names the error, never its text. */
function expectCouldNotRunLineNaming(line: string | undefined, error: Error & { errName: string }): void {
  expect(line).toBe(buildAdVersionRecheckCouldNotRunLine(error.errName))
  expect(line).not.toContain(error.message)
}

describe('runtime re-check: a run of could-not-run results logs one line', () => {
  test('three failures in a row log one line, at the first; a pass writes none; a new failure logs a second; a later below-floor answer records once and stops non-zero', async () => {
    const first = errSystemInstallNotFound()
    const second = errBunVersionTooOld()
    const rig = makeRecheckRig({
      outcomes: [
        { throws: first },
        { throws: first },
        { throws: first },
        { version: BASELINE_VERSION },
        { throws: second },
        { version: OLD_AD_VERSION, path: binaryPathFor('run-then-stop') },
      ],
    })
    for (let n = 1; n <= 3; n++) {
      await rig.clock.advance(AD_VERSION_RECHECK_INTERVAL_MS)
      expect(rig.callCount()).toBe(n)
      expect(rig.logs).toHaveLength(1)
      expectNextRecheckArmed(rig)
    }
    expectCouldNotRunLineNaming(rig.logs[0], first)
    await rig.clock.advance(AD_VERSION_RECHECK_INTERVAL_MS)
    expect(rig.logs).toHaveLength(1)
    await rig.clock.advance(AD_VERSION_RECHECK_INTERVAL_MS)
    expect(rig.logs).toHaveLength(2)
    expectCouldNotRunLineNaming(rig.logs[1], second)
    expect(rig.records).toHaveLength(0)
    expect(rig.stops).toHaveLength(0)
    await rig.clock.advance(AD_VERSION_RECHECK_INTERVAL_MS)
    expect(rig.records.map((r) => r.classLabel)).toEqual([AD_BELOW_PHASE1_FLOOR])
    expect(rig.stops).toEqual([AD_VERSION_RECHECK_STOP_EXIT_CODE])
    expect(rig.stops[0]).not.toBe(0)
    expect(rig.events.slice(-3)).toEqual(['call', 'record', 'stop'])
    expect(rig.clock.pendingCount()).toBe(0)
    expect(rig.logs).toHaveLength(2)
    assertNoLeak(rig.logs, 'logs')
  })

  test('mixed failure kinds in one run (unreachable, a plain error, not found, the time limit) log one token-free line, naming the first', async () => {
    const unreachable = errSystemInstallUnreachable('probe-timeout', LEAK_SENTINEL, `${binaryPathFor('mixed-run')}/${sentinelInMessage('recheck')}`)
    const rig = makeRecheckRig({
      outcomes: [
        { throws: unreachable },
        { throws: new Error(`stub resolve failure (${sentinelInMessage('plain')})`) },
        { throws: errSystemInstallNotFound() },
        { never: true },
      ],
    })
    await rig.clock.advance(AD_VERSION_RECHECK_INTERVAL_MS * 3)
    await rig.clock.advance(AD_VERSION_RECHECK_INTERVAL_MS + AD_VERSION_RECHECK_TIME_LIMIT_MS)
    expect(rig.events).toEqual(['call', 'tick', 'call', 'tick', 'call', 'tick', 'call', 'tick'])
    expect(rig.logs).toHaveLength(1)
    const line = rig.logs[0]!
    expect(line.startsWith(AD_VERSION_RECHECK_COULD_NOT_RUN_LOG_PREFIX)).toBe(true)
    for (const text of [unreachable.errName, unreachable.reason, REDACTED_SENTINEL_TAIL]) expect(line).toContain(text)
    expect(line).not.toContain(unreachable.message)
    expect(rig.records).toHaveLength(0)
    expect(rig.stops).toHaveLength(0)
    expectNextRecheckArmed(rig)
    assertNoLeak(rig.logs, 'logs')
  })

  test('an unreachable binary path holding \\r, \\n, U+2028 and U+2029: the description and the line carry none of them and still name every visible part', async () => {
    const parts = [binaryPathFor('line-breaks'), 'after-cr', 'after-lf', 'after-ls', 'after-ps']
    const separators = ['\r', '\n', ' ', ' ']
    const path = parts.reduce((joined, part, i) => `${joined}${separators[i - 1]}${part}`)
    const unreachable = errSystemInstallUnreachable('probe-timeout', null, path)
    expect(unreachable.binaryPath).toBe(path)
    const outcome = decideAdVersionRecheckOutcome({ kind: 'rejected', error: unreachable })
    expect(outcome.kind).toBe(RECHECK_OUTCOME_COULD_NOT_RUN)
    const description = outcome.kind === RECHECK_OUTCOME_COULD_NOT_RUN ? outcome.description : ''
    const rig = makeRecheckRig({ outcomes: [{ throws: unreachable }] })
    await rig.clock.advance(AD_VERSION_RECHECK_INTERVAL_MS)
    expect(rig.logs).toEqual([buildAdVersionRecheckCouldNotRunLine(description)])
    for (const text of [description, rig.logs[0]!]) {
      for (const separator of separators) expect(text).not.toContain(separator)
      for (const part of parts) expect(text).toContain(part)
    }
  })

  test('passes alone write no line', async () => {
    const rig = makeRecheckRig({ outcomes: [{ version: BASELINE_VERSION }, { version: LATER_PATCH }] })
    await rig.clock.advance(AD_VERSION_RECHECK_INTERVAL_MS * 3)
    expect(rig.callCount()).toBe(3)
    expect(rig.logs).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Runtime re-check: the immediate trigger (b.jg5 SRJ-204, AC 23's first half)
// ---------------------------------------------------------------------------

describe('runtime re-check: trigger', () => {
  test('calls at once with no clock advance; a passing answer changes nothing: no tick, no record, no stop, no line, the timer untouched', async () => {
    const path = binaryPathFor('trigger-pass')
    const rig = makeRecheckRig({ outcomes: [{ version: BASELINE_VERSION, path }] })
    await rig.clock.advance(Math.floor(AD_VERSION_RECHECK_INTERVAL_MS / 2))
    const pendingBefore = rig.clock.pending()
    const now = rig.clock.now()
    const answered = rig.recheck.trigger()
    expect(rig.callCount()).toBe(1)
    expect(await answered).toEqual({ kind: RECHECK_OUTCOME_PASS, version: BASELINE_VERSION, binaryPath: path })
    expect(rig.clock.now()).toBe(now)
    expect(rig.clock.pending()).toEqual(pendingBefore)
    expect(rig.events).toEqual(['call'])
    expect(rig.logs).toEqual([])
    expect(rig.changes).toEqual([])
    await rig.clock.advanceTo(pendingBefore[0]!.dueAt - 1)
    expect(rig.callCount()).toBe(1)
    await rig.clock.advance(1)
    expect(rig.events).toEqual(['call', 'call', 'tick'])
    expectNextRecheckArmed(rig)
  })

  test.each([
    ['below the floor', { version: OLD_AD_VERSION, path: binaryPathFor('trigger-below') }, AD_BELOW_PHASE1_FLOOR],
    ['too old for the client', { throws: errSystemInstallTooOld(STALE_VERSION, CLIENT_MIN_VERSION, binaryPathFor('trigger-too-old')) }, AD_SYSTEM_INSTALL_TOO_OLD],
  ] as Array<[string, StubResolveSystemBinaryOutcome, string]>)('%s: with no clock advance, one record and one non-zero stop; a later trigger answers not-running and calls nothing', async (_label, outcome, classLabel) => {
    const rig = makeRecheckRig({ outcomes: [outcome] })
    const answer = await rig.recheck.trigger()
    expect(rig.clock.now()).toBe(0)
    expect(rig.clock.firedCount()).toBe(0)
    const message = expectStoppedOnce(rig, classLabel)
    expect(answer).toEqual({ kind: RECHECK_OUTCOME_STOP, classLabel, message } as typeof answer)
    expect(message).toContain(RUNTIME_RECHECK_PHRASE)
    expect(await rig.recheck.trigger()).toEqual({ kind: RECHECK_OUTCOME_NOT_RUNNING })
    await rig.clock.advance(AD_VERSION_RECHECK_INTERVAL_MS * 2)
    expect(rig.callCount()).toBe(1)
  })

  test('a triggered could-not-run joins the current run (no second line); a triggered pass ends it, so the next failure logs again', async () => {
    const first = errSystemInstallNotFound()
    const later = errBunVersionTooOld()
    const rig = makeRecheckRig({
      outcomes: [
        { throws: first },
        { throws: errSystemInstallUnreachable('probe-timeout', null, binaryPathFor('trigger-joins-run')) },
        { version: BASELINE_VERSION },
        { throws: later },
      ],
    })
    await rig.clock.advance(AD_VERSION_RECHECK_INTERVAL_MS)
    expect(rig.logs).toHaveLength(1)
    expect((await rig.recheck.trigger()).kind).toBe(RECHECK_OUTCOME_COULD_NOT_RUN)
    expect(rig.logs).toHaveLength(1)
    expect((await rig.recheck.trigger()).kind).toBe(RECHECK_OUTCOME_PASS)
    expect(rig.logs).toHaveLength(1)
    await rig.clock.advance(AD_VERSION_RECHECK_INTERVAL_MS)
    expect(rig.callCount()).toBe(4)
    expect(rig.logs).toHaveLength(2)
    expectCouldNotRunLineNaming(rig.logs[0], first)
    expectCouldNotRunLineNaming(rig.logs[1], later)
    expect(rig.records).toHaveLength(0)
    expect(rig.stops).toHaveLength(0)
    assertNoLeak(rig.logs, 'logs')
  })

  test('the first failure after start, when triggered, logs the line', async () => {
    const error = errSystemInstallNotFound()
    const rig = makeRecheckRig({ outcomes: [{ throws: error }] })
    expect((await rig.recheck.trigger()).kind).toBe(RECHECK_OUTCOME_COULD_NOT_RUN)
    expect(rig.logs).toHaveLength(1)
    expectCouldNotRunLineNaming(rig.logs[0], error)
  })

  test.each([
    ['a triggered call', false, 0],
    ['a timed call', true, 1],
  ])('two triggers during %s make no second call; every waiter gets the one outcome, acted on once', async (_label, timed, ticks) => {
    const answer = deferredAnswer()
    const path = binaryPathFor('joined')
    const rig = makeRecheckRig({ resolveSystemBinary: () => answer.promise })
    const waiters: Array<ReturnType<AdVersionRecheck['trigger']>> = []
    if (timed) await rig.clock.advance(AD_VERSION_RECHECK_INTERVAL_MS)
    else waiters.push(rig.recheck.trigger())
    waiters.push(rig.recheck.trigger(), rig.recheck.trigger())
    expect(rig.callCount()).toBe(1)
    answer.resolve({ version: LATER_PATCH, path })
    const expected = { kind: RECHECK_OUTCOME_PASS, version: LATER_PATCH, binaryPath: path } as const
    for (const answered of await Promise.all(waiters)) expect(answered).toEqual(expected)
    await rig.clock.flush()
    expect(rig.callCount()).toBe(1)
    expect(rig.changes).toEqual([[BASELINE_VERSION, LATER_PATCH]])
    expect(rig.tickCount()).toBe(ticks)
  })

  test('a timed re-check coming due during a triggered call makes no second call, then arms the next and runs the tick listeners', async () => {
    const answer = deferredAnswer()
    const rig = makeRecheckRig({ resolveSystemBinary: () => answer.promise })
    await rig.clock.advance(AD_VERSION_RECHECK_INTERVAL_MS - 1)
    const triggered = rig.recheck.trigger()
    await rig.clock.advance(1)
    expect(rig.callCount()).toBe(1)
    const pending = rig.clock.pending()
    expect(pending).toHaveLength(1)
    expect(pending[0]!.delayMs).toBe(AD_VERSION_RECHECK_TIME_LIMIT_MS)
    answer.resolve({ version: LATER_PATCH, path: binaryPathFor('due-during-trigger') })
    expect((await triggered).kind).toBe(RECHECK_OUTCOME_PASS)
    await rig.clock.flush()
    expect(rig.events).toEqual(['call', 'tick'])
    expect(rig.changes).toHaveLength(1)
    expectNextRecheckArmed(rig)
  })

  test.each([
    ['before start', false],
    ['after dispose', true],
  ])('%s: answers not-running, calls nothing and leaves no timer', async (_label, started) => {
    const rig = makeRecheckRig({ start: started })
    if (started) rig.recheck.dispose()
    expect(await rig.recheck.trigger()).toEqual({ kind: RECHECK_OUTCOME_NOT_RUNNING })
    expect(rig.callCount()).toBe(0)
    expect(rig.clock.pendingCount()).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// Runtime re-check: the version-changed signal (b.jg5 SRJ-204 row 1, SRJ-207)
// ---------------------------------------------------------------------------

describe('runtime re-check: version-changed signal', () => {
  test.each([
    ['the baseline version: none', [{ version: BASELINE_VERSION }], []],
    ['a different passing version, then the same again: one, with the previous and new versions', [{ version: LATER_PATCH }, { version: LATER_PATCH }], [[BASELINE_VERSION, LATER_PATCH]]],
    ['two changes in turn: one each, the second from the first', [{ version: LATER_PATCH }, { version: LATER_MINOR }], [[BASELINE_VERSION, LATER_PATCH], [LATER_PATCH, LATER_MINOR]]],
    ['A, could not run, B: one', [{ version: BASELINE_VERSION }, { throws: errSystemInstallNotFound() }, { version: LATER_MINOR }], [[BASELINE_VERSION, LATER_MINOR]]],
    ['A, could not run, A: none', [{ version: BASELINE_VERSION }, { throws: errSystemInstallNotFound() }, { version: BASELINE_VERSION }], []],
    ['below the floor: none (the server stops)', [{ version: OLD_AD_VERSION, path: binaryPathFor('signal-below') }], []],
  ] as Array<[string, StubResolveSystemBinaryOutcome[], Array<[string, string]>]>)('timed re-checks at %s', async (_label, outcomes, expected) => {
    const rig = makeRecheckRig({ outcomes })
    await rig.clock.advance(AD_VERSION_RECHECK_INTERVAL_MS * (outcomes.length + 1))
    expect(rig.changes).toEqual(expected)
  })

  test('a triggered re-check finding a new version signals once, after the last version seen has moved', async () => {
    const seenAtSignal: string[] = []
    let rig: RecheckRig | undefined
    rig = makeRecheckRig({
      outcomes: [{ version: LATER_MINOR }],
      versionChangedListeners: [() => { seenAtSignal.push(rig!.recheck.lastVersionSeen()) }],
    })
    expect((await rig.recheck.trigger()).kind).toBe(RECHECK_OUTCOME_PASS)
    expect(rig.changes).toEqual([[BASELINE_VERSION, LATER_MINOR]])
    expect(seenAtSignal).toEqual([LATER_MINOR])
    expect(rig.tickCount()).toBe(0)
  })

  test.each([
    ['throws', () => { throw new Error(`stub version-changed listener failure (${sentinelInMessage('listener')})`) }],
    ['rejects', () => Promise.reject(new Error(`stub version-changed listener rejection (${sentinelInMessage('listener')})`))],
  ] as Array<[string, AdVersionChangedListener]>)('a listener that %s is logged as one token-free line; the listeners after it still run and the next tick still arms', async (_label, failing) => {
    const after: Array<[string, string]> = []
    const rig = makeRecheckRig({
      outcomes: [{ version: LATER_PATCH }, { version: LATER_MINOR }],
      versionChangedListeners: [failing, (previousVersion, newVersion) => { after.push([previousVersion, newVersion]) }],
    })
    await rig.clock.advance(AD_VERSION_RECHECK_INTERVAL_MS)
    expect(rig.logs).toHaveLength(1)
    expect(after).toEqual([[BASELINE_VERSION, LATER_PATCH]])
    expect(rig.tickCount()).toBe(1)
    expectNextRecheckArmed(rig)
    await rig.clock.advance(AD_VERSION_RECHECK_INTERVAL_MS)
    expect(rig.logs).toHaveLength(2)
    expect(after).toEqual([[BASELINE_VERSION, LATER_PATCH], [LATER_PATCH, LATER_MINOR]])
    expect(rig.records).toHaveLength(0)
    expect(rig.stops).toHaveLength(0)
    assertNoLeak(rig.logs, 'logs')
  })
})

// ---------------------------------------------------------------------------
// Runtime re-check: the module-level trigger and signal (the ErrInvalidFlags
// step's immediate re-check and the hold's version-change reaction use them)
// ---------------------------------------------------------------------------

describe('runtime re-check: module-level trigger and version-changed registration', () => {
  test('with nothing installed, the trigger answers not-running', async () => {
    expect(await triggerAdVersionRecheck()).toEqual({ kind: RECHECK_OUTCOME_NOT_RUNNING })
  })

  test('the trigger re-checks the installed re-check at once; listeners registered before or after install run in order; an unsubscribe removes only its own', async () => {
    const heard: Array<[string, string, string]> = []
    const unsubscribeA = onAdVersionChanged((previousVersion, newVersion) => { heard.push(['a', previousVersion, newVersion]) })
    const clock = createFakeClock()
    const calls: Array<object | undefined> = []
    installAdVersionRecheck(installDeps(clock, [], calls, [{ version: LATER_PATCH }, { version: LATER_MINOR }]))
    onAdVersionChanged((previousVersion, newVersion) => { heard.push(['b', previousVersion, newVersion]) })
    const answer = await triggerAdVersionRecheck()
    expect(calls).toHaveLength(1)
    expect(clock.now()).toBe(0)
    expect(answer.kind).toBe(RECHECK_OUTCOME_PASS)
    expect(heard).toEqual([['a', BASELINE_VERSION, LATER_PATCH], ['b', BASELINE_VERSION, LATER_PATCH]])
    unsubscribeA()
    await clock.advance(AD_VERSION_RECHECK_INTERVAL_MS)
    expect(calls).toHaveLength(2)
    expect(heard).toEqual([['a', BASELINE_VERSION, LATER_PATCH], ['b', BASELINE_VERSION, LATER_PATCH], ['b', LATER_PATCH, LATER_MINOR]])
  })
})

// ---------------------------------------------------------------------------
// SRJ-1204's bound, citing SRJ-204 and SRJ-209: the version re-check and the
// settings read each once per interval, whatever health_check_interval is;
// the ErrInvalidFlags step's trigger is the only extra re-check
// ---------------------------------------------------------------------------

describe('runtime re-check: SRJ-1204\'s bound, with the settings installed on its tick as main() installs them (b.jg5 SRJ-204, SRJ-209, SRJ-1204; health_check_interval 0)', () => {
  test('over several intervals: one re-check and one settings read per interval and one timer pending; an ErrInvalidFlags step mid-interval adds one re-check and no read, another error none, and the next interval comes when it was due', async () => {
    const clock = createFakeClock()
    const resolveCalls: Array<object | undefined> = []
    installAdVersionRecheck(installDeps(clock, [], resolveCalls))
    const home = mkdtempSync(join(tmpdir(), 'cscb-ad-version-bound-'))
    tempDirs.push(home)
    let reads = 0
    installAdSettings({
      home: () => {
        reads += 1
        return home
      },
      log: () => {},
    })
    // The startup read at once; no re-check yet, and the re-check's timer the only one.
    expect([resolveCalls.length, reads, clock.pendingCount()]).toEqual([0, 1, 1])

    const intervals = 4
    const perInterval: Array<[number, number, number]> = []
    for (let n = 0; n < intervals; n++) {
      const [callsBefore, readsBefore] = [resolveCalls.length, reads]
      await clock.advance(AD_VERSION_RECHECK_INTERVAL_MS)
      perInterval.push([resolveCalls.length - callsBefore, reads - readsBefore, clock.pendingCount()])
    }
    expect(perInterval).toEqual(Array.from({ length: intervals }, () => [1, 1, 1]))

    // Mid-interval: a non-ErrInvalidFlags answer triggers nothing; an ErrInvalidFlags one exactly one re-check, with no settings read.
    const dueAt = clock.pending()[0]!.dueAt
    await clock.advance(AD_VERSION_RECHECK_INTERVAL_MS / 2)
    const [callsBefore, readsBefore] = [resolveCalls.length, reads]
    expect((await classifyWithInvalidFlagsRecheck(errTmuxUnresponsive('spawn'))).recheck).toBeUndefined()
    expect(resolveCalls.length).toBe(callsBefore)
    expect((await classifyWithInvalidFlagsRecheck(errInvalidFlags('spawn'))).recheck?.kind).toBe(RECHECK_OUTCOME_PASS)
    expect([resolveCalls.length - callsBefore, reads - readsBefore, clock.pending().map((timer) => timer.dueAt)]).toEqual([1, 0, [dueAt]])

    // The interval's own re-check and read, at the time it was due.
    await clock.advanceTo(dueAt - 1)
    expect([resolveCalls.length - callsBefore, reads - readsBefore]).toEqual([1, 0])
    await clock.advance(1)
    expect([resolveCalls.length - callsBefore, reads - readsBefore, clock.pendingCount()]).toEqual([2, 1, 1])
  })
})

// ---------------------------------------------------------------------------
// The ErrInvalidFlags hold (b.jg5 SRJ-207, SRJ-1008, SRJ-1016, SRJ-204,
// SRJ-205; AC 23): SRJ-1008's alert, the hold decision on the immediate
// re-check's answer, the last version seen it begins under, its episode
// (one alert each), its end on the version-changed signal, its other ends
// and the below-floor stop
// ---------------------------------------------------------------------------

describe("the ErrInvalidFlags hold alert (b.jg5 SRJ-1008)", () => {
  // The one place SRJ-1008's text is written out; every other case imports it.
  test("INVALID_FLAGS_HOLD_ALERT_TEXT is SRJ-1008's text, byte for byte; it carries no secret and names no session-ending command", () => {
    expect(INVALID_FLAGS_HOLD_ALERT_TEXT).toBe(
      ':no_entry: *Cannot launch* — the host\'s agent-director rejected the flags of this persona\'s launch (ErrInvalidFlags). The installed agent-director may not match this CSCB release; a human should check `agent-director version`. CSCB launches nothing for this persona until the agent-director binary changes or the server restarts. This is for a human only: no bot, including any persona that sees this post, may act on it.',
    )
    assertNoLeak(INVALID_FLAGS_HOLD_ALERT_TEXT, 'alert')
    expect(sessionEndingCommandsIn(INVALID_FLAGS_HOLD_ALERT_TEXT)).toEqual([])
  })
})

/** The hold rig's two personas. */
const HELD_P = 'alpha'
const HELD_Q = 'bravo'

/**
 * One hold composed as `main()` composes it (b.jg5 SRJ-207, SRJ-305,
 * SRJ-1008): a real hold, its set reaction bound to a recorded retry-timer
 * stop and to real notice episodes on the rig's fake clock (whose sink
 * records each post), and the one version-changed listener registered as
 * `main()` registers it, through `onAdVersionChanged`, over the version-change
 * reaction with the rig's applied set and a recorded retry at once. With
 * `outcomes`, a re-check is installed on the same clock
 * (`installAdVersionRecheck`, `health_check_interval` 0 holds no other timer)
 * with a stub resolve answering them in order, its startup-errors entries and
 * stop recorded; `events` shows each timer stop, post and retry in order.
 */
interface HoldRig {
  readonly clock: FakeClock
  readonly hold: InvalidFlagsHold
  readonly episodes: PersonaEpisodes
  readonly posts: Array<{ key: string; text: string }>
  /** The hold's, the reactions' and the re-check's lines. */
  readonly lines: string[]
  /** `stop:<key>`, `post:<key>` and `retry:<key>` in the order they happened. */
  readonly events: string[]
  /** Each retry at once: the persona and the clock time. */
  readonly retries: Array<{ key: string; at: number }>
  readonly applied: Set<string>
  readonly resolveCalls: Array<object | undefined>
  readonly records: Array<{ classLabel: string; message: string }>
  readonly stops: number[]
}

function makeHoldRig(opts: { outcomes?: readonly StubResolveSystemBinaryOutcome[] } = {}): HoldRig {
  const clock = createFakeClock()
  const lines: string[] = []
  const posts: Array<{ key: string; text: string }> = []
  const events: string[] = []
  const retries: Array<{ key: string; at: number }> = []
  const applied = new Set([HELD_P, HELD_Q])
  const log = (line: string): void => {
    lines.push(line)
  }
  const episodes = createPersonaEpisodes({
    sink: (key, text) => {
      posts.push({ key, text })
      events.push(`post:${key}`)
    },
    log,
    clock,
  })
  const hold = createInvalidFlagsHold({ log })
  bindInvalidFlagsHoldSetReaction(hold, {
    stopRetryTimer: (key) => {
      events.push(`stop:${key}`)
    },
    episodes,
    log,
  })
  onAdVersionChanged((_previousVersion, newVersion) => {
    endInvalidFlagsHoldsOnVersionChange(hold, newVersion, {
      episodes,
      isApplied: (key) => applied.has(key),
      retryAtOnce: (key) => {
        retries.push({ key, at: clock.now() })
        events.push(`retry:${key}`)
      },
      log,
    })
  })
  const resolveCalls: Array<object | undefined> = []
  const records: Array<{ classLabel: string; message: string }> = []
  const stops: number[] = []
  if (opts.outcomes !== undefined) {
    installAdVersionRecheck({
      resolveSystemBinary: makeStubResolveSystemBinary({ calls: resolveCalls, outcomes: opts.outcomes }),
      baselineVersion: BASELINE_VERSION,
      recordStartupError: (classLabel, message) => {
        records.push({ classLabel, message })
      },
      stop: (exitCode) => {
        stops.push(exitCode)
      },
      log,
      clock,
    })
  }
  return { clock, hold, episodes, posts, lines, events, retries, applied, resolveCalls, records, stops }
}

/** The alert as the rig's sink receives it for persona `key`. */
const alertOf = (key: string): { key: string; text: string } => ({ key, text: INVALID_FLAGS_HOLD_ALERT_TEXT })

/**
 * Hold persona `key` as a reuse spawn's ErrInvalidFlags holds it: one
 * immediate re-check (`triggerAdVersionRecheck`), then the hold decision on
 * its answer with the last version seen (`lastAdVersionSeen`), and a set
 * unless it decided the stop. Answers the decision.
 */
async function holdAsAReuseDoes(rig: HoldRig, key: string): Promise<ReturnType<typeof decideInvalidFlagsHold>> {
  const decision = decideInvalidFlagsHold(await triggerAdVersionRecheck(), lastAdVersionSeen())
  if (decision.kind === INVALID_FLAGS_HOLD_DECISION_HOLD) rig.hold.set(key, decision.version)
  return decision
}

/** The rig's pending timers are only the re-check's next one, when one is installed and running. */
function expectOnlyTheRecheckPending(rig: HoldRig, running: boolean): void {
  expect(rig.clock.pendingCount()).toBe(running ? 1 : 0)
  if (running) expect(rig.clock.pending()[0]!.delayMs).toBe(AD_VERSION_RECHECK_INTERVAL_MS)
}

describe('the ErrInvalidFlags hold decision (b.jg5 SRJ-207, SRJ-204, SRJ-205): a pass, a could-not-run and a not-running re-check hold; a stop does not', () => {
  const PATH = binaryPathFor('hold-decision')
  test.each([
    ['a pass holds under the version it found', decideAdVersionRecheckOutcome({ kind: 'resolved', value: { version: LATER_PATCH, path: PATH } }), BASELINE_VERSION, { kind: INVALID_FLAGS_HOLD_DECISION_HOLD, version: LATER_PATCH }],
    ['could not run (the resolve rejected) holds under the last version seen', decideAdVersionRecheckOutcome({ kind: 'rejected', error: errSystemInstallNotFound() }), BASELINE_VERSION, { kind: INVALID_FLAGS_HOLD_DECISION_HOLD, version: BASELINE_VERSION }],
    ['could not run (the call timed out) holds under the last version seen', decideAdVersionRecheckOutcome({ kind: 'timed-out', timeLimitMs: AD_VERSION_RECHECK_TIME_LIMIT_MS }), BASELINE_VERSION, { kind: INVALID_FLAGS_HOLD_DECISION_HOLD, version: BASELINE_VERSION }],
    ['could not run with no last version seen holds under none', decideAdVersionRecheckOutcome({ kind: 'rejected', error: errSystemInstallNotFound() }), undefined, { kind: INVALID_FLAGS_HOLD_DECISION_HOLD }],
    ['not running (none installed, disposed or stopped: no last version seen) holds under none', NOT_RUNNING, undefined, { kind: INVALID_FLAGS_HOLD_DECISION_HOLD }],
    ['a stop below the floor does not hold', decideAdVersionRecheckOutcome({ kind: 'resolved', value: { version: OLD_AD_VERSION, path: PATH } }), BASELINE_VERSION, { kind: INVALID_FLAGS_HOLD_DECISION_STOP }],
    ["a stop on the client's too-old refusal does not hold", decideAdVersionRecheckOutcome({ kind: 'rejected', error: errSystemInstallTooOld(STALE_VERSION, CLIENT_MIN_VERSION, PATH) }), BASELINE_VERSION, { kind: INVALID_FLAGS_HOLD_DECISION_STOP }],
  ] as const)('%s', (_label, answer, lastSeen, expected) => {
    expect(decideInvalidFlagsHold(answer, lastSeen)).toEqual(expected)
  })

  test('a trigger whose resolve throws at once answers could not run, and the decision holds under the last version seen', async () => {
    const rig = makeRecheckRig({
      resolveSystemBinary: () => {
        throw errSystemInstallNotFound()
      },
    })
    const answer = await rig.recheck.trigger()
    expect(answer.kind).toBe(RECHECK_OUTCOME_COULD_NOT_RUN)
    expect(decideInvalidFlagsHold(answer, rig.recheck.lastVersionSeen())).toEqual({ kind: INVALID_FLAGS_HOLD_DECISION_HOLD, version: BASELINE_VERSION })
    expectNextRecheckArmed(rig)
  })
})

describe('lastAdVersionSeen (b.jg5 SRJ-204, SRJ-207): the installed re-check\'s last version seen, none when none runs', () => {
  test('none with nothing installed; the baseline before any pass; a passing new version after it; unchanged by the same version and by a could-not-run; none after dispose', async () => {
    expect(lastAdVersionSeen()).toBeUndefined()
    const clock = createFakeClock()
    installAdVersionRecheck(installDeps(clock, [], [], [{ version: LATER_PATCH }, { version: LATER_PATCH }, { throws: errSystemInstallNotFound() }]))
    expect(lastAdVersionSeen()).toBe(BASELINE_VERSION)
    await clock.advance(AD_VERSION_RECHECK_INTERVAL_MS)
    expect(lastAdVersionSeen()).toBe(LATER_PATCH)
    await clock.advance(AD_VERSION_RECHECK_INTERVAL_MS)
    expect(lastAdVersionSeen()).toBe(LATER_PATCH)
    await clock.advance(AD_VERSION_RECHECK_INTERVAL_MS)
    expect(lastAdVersionSeen()).toBe(LATER_PATCH)
    disposeAdVersionRecheck()
    expect(lastAdVersionSeen()).toBeUndefined()
    expect(clock.pendingCount()).toBe(0)
  })

  test('none once a stop ended the re-check', async () => {
    const clock = createFakeClock()
    installAdVersionRecheck(installDeps(clock, [], [], [{ version: OLD_AD_VERSION }]))
    expect((await triggerAdVersionRecheck()).kind).toBe(RECHECK_OUTCOME_STOP)
    expect(lastAdVersionSeen()).toBeUndefined()
    expect(clock.pendingCount()).toBe(0)
  })

  test('isRunning: false before start, true from start, false after dispose or a stop', async () => {
    const idle = makeRecheckRig({ start: false })
    expect(idle.recheck.isRunning()).toBe(false)
    idle.recheck.start()
    expect(idle.recheck.isRunning()).toBe(true)
    idle.recheck.dispose()
    expect(idle.recheck.isRunning()).toBe(false)
    const stopped = makeRecheckRig({ outcomes: [{ version: OLD_AD_VERSION }] })
    await stopped.recheck.trigger()
    expect(stopped.recheck.isRunning()).toBe(false)
    expect(stopped.clock.pendingCount()).toBe(0)
  })
})

describe('the ErrInvalidFlags hold episode (b.jg5 SRJ-207, SRJ-1008, SRJ-1016, SRJ-305): one alert per episode, after the retry timer stop', () => {
  test('holding P stops its timer, then posts the alert once at P; a second set while held changes nothing; Q\'s hold posts its own; ending P and holding it again posts one new alert', async () => {
    const rig = makeHoldRig()

    expect(rig.hold.set(HELD_P, BASELINE_VERSION)).toBe(true)
    await rig.clock.flush()
    expect(rig.events).toEqual([`stop:${HELD_P}`, `post:${HELD_P}`])
    expect(rig.posts).toEqual([alertOf(HELD_P)])
    expect(rig.episodes.isOpen(HELD_P, PERSONA_EPISODE_KIND_INVALID_FLAGS_HOLD)).toBe(true)
    expect(rig.lines).toEqual([invalidFlagsHoldSetLine(HELD_P, BASELINE_VERSION)])

    expect(rig.hold.set(HELD_P, BASELINE_VERSION)).toBe(false)
    expect(rig.hold.set(HELD_P, LATER_PATCH)).toBe(false)
    await rig.clock.flush()
    expect(rig.posts).toEqual([alertOf(HELD_P)])
    expect(rig.events).toHaveLength(2)
    expect(rig.hold.beganUnder(HELD_P)).toBe(BASELINE_VERSION)

    expect(rig.hold.set(HELD_Q, BASELINE_VERSION)).toBe(true)
    await rig.clock.flush()
    expect(rig.posts).toEqual([alertOf(HELD_P), alertOf(HELD_Q)])

    // The holds end (the binary changed), silently; a new ErrInvalidFlags begins a new episode.
    expect(endInvalidFlagsHoldsOnVersionChange(rig.hold, LATER_PATCH, { episodes: rig.episodes, isApplied: () => false, retryAtOnce: () => undefined, log: () => {} })).toEqual([HELD_P, HELD_Q])
    expect(rig.posts).toHaveLength(2)
    expect(rig.hold.set(HELD_P, LATER_PATCH)).toBe(true)
    await rig.clock.flush()
    expect(rig.posts).toEqual([alertOf(HELD_P), alertOf(HELD_Q), alertOf(HELD_P)])
    expect(rig.clock.pendingCount()).toBe(0)
    assertNoLeak({ lines: rig.lines, posts: rig.posts })
  })

  test('after the episodes close (shutdown) a set posts nothing; it still stops the timer', async () => {
    const rig = makeHoldRig()
    rig.episodes.close()
    expect(rig.hold.set(HELD_P, BASELINE_VERSION)).toBe(true)
    await rig.clock.flush()
    expect(rig.events).toEqual([`stop:${HELD_P}`])
    expect(rig.posts).toEqual([])
    expect(rig.clock.pendingCount()).toBe(0)
  })

  /** A step of the hold or its reactions that a case makes fail for P. */
  type FailingStep = 'stop' | 'alert' | 'episode end' | 'retry' | 'set observer' | 'end observer'

  // Each step is isolated: one that throws or rejects for P is logged once,
  // described and redacted, and P's other steps and Q's all still run.
  test.each<[string, FailingStep, 'throws' | 'rejects', string]>([
    ['the retry timer stop throws', 'stop', 'throws', 'retry timer stop'],
    ['the alert step throws', 'alert', 'throws', 'alert'],
    ['ending its hold episode on a version change throws', 'episode end', 'throws', 'ending its hold episode'],
    ['its retry at once throws', 'retry', 'throws', 'its retry'],
    ['its retry at once rejects', 'retry', 'rejects', 'its retry'],
    ['a set observer throws', 'set observer', 'throws', 'set observer'],
    ['a set observer rejects', 'set observer', 'rejects', 'set observer'],
    ['an end observer throws', 'end observer', 'throws', 'end observer'],
    ['an end observer rejects', 'end observer', 'rejects', 'end observer'],
  ])('for P, %s: one line naming that step, redacted; P\'s other steps and Q\'s set, alert, end and retry still run', async (_label, step, how, what) => {
    const clock = createFakeClock()
    const lines: string[] = []
    const posts: Array<{ key: string; text: string }> = []
    const stops: string[] = []
    const retries: string[] = []
    const log = (line: string): void => {
      lines.push(line)
    }
    const err = Object.assign(new Error(`${what} broke (${sentinelInMessage('hold-step')})`), { note: LEAK_SENTINEL })
    /** P's `at` step fails as the case says; every other step, and every step of Q, does not. */
    const fail = (key: string, at: FailingStep): Promise<void> | undefined => {
      if (key !== HELD_P || at !== step) return undefined
      if (how === 'rejects') return Promise.reject(err)
      throw err
    }
    const episodes = createPersonaEpisodes({ sink: (key, text) => { posts.push({ key, text }) }, log, clock })
    const hold = createInvalidFlagsHold({ log })
    hold.addSetObserver(({ key }) => fail(key, 'set observer'))
    hold.addEndObserver(({ key }) => fail(key, 'end observer'))
    bindInvalidFlagsHoldSetReaction(hold, {
      stopRetryTimer: (key) => {
        stops.push(key)
        fail(key, 'stop')
      },
      episodes: {
        begin: (key, kind) => episodes.begin(key, kind),
        post: (key, kind, text) => {
          fail(key, 'alert')
          return episodes.post(key, kind, text)
        },
      },
      log,
    })

    hold.set(HELD_P, BASELINE_VERSION)
    hold.set(HELD_Q, BASELINE_VERSION)
    const ended = endInvalidFlagsHoldsOnVersionChange(hold, LATER_PATCH, {
      episodes: {
        end: (key, kind) => {
          fail(key, 'episode end')
          return episodes.end(key, kind)
        },
      },
      isApplied: () => true,
      retryAtOnce: (key) => {
        retries.push(key)
        return fail(key, 'retry')
      },
      log,
    })
    await clock.flush()

    const failed = lines.filter((line) => line.includes(' failed: '))
    expect(failed).toHaveLength(1)
    expect(failed[0]).toStartWith(`${INVALID_FLAGS_HOLD_LOG_PREFIX} persona=${HELD_P} ${what} failed: Error message="${what} broke (${REDACTED_SENTINEL_TAIL})" at `)
    expect([ended, hold.heldKeys(), stops, retries]).toEqual([[HELD_P, HELD_Q], [], [HELD_P, HELD_Q], [HELD_P, HELD_Q]])
    expect(posts).toEqual(step === 'alert' ? [alertOf(HELD_Q)] : [alertOf(HELD_P), alertOf(HELD_Q)])
    for (const key of [HELD_P, HELD_Q]) {
      expect(lines.filter((line) => line === invalidFlagsHoldEndLine(key, BASELINE_VERSION, LATER_PATCH))).toHaveLength(1)
      expect(lines.filter((line) => line === invalidFlagsHoldRetryLine(key, true))).toHaveLength(1)
    }
    expect([episodes.isOpen(HELD_P, PERSONA_EPISODE_KIND_INVALID_FLAGS_HOLD), episodes.isOpen(HELD_Q, PERSONA_EPISODE_KIND_INVALID_FLAGS_HOLD)]).toEqual([step === 'episode end', false])
    assertNoLeak({ lines, posts })
    expect(clock.pendingCount()).toBe(0)
  })

  test('a version change whose ending of the holds throws: one line naming it, redacted; nothing ends, so nothing is retried', () => {
    const lines: string[] = []
    const retries: string[] = []
    const failing = {
      versionChanged: (): string[] => {
        throw Object.assign(new Error(`versionChanged broke (${sentinelInMessage('hold-change')})`), { note: LEAK_SENTINEL })
      },
    }

    const ended = endInvalidFlagsHoldsOnVersionChange(failing, LATER_PATCH, {
      episodes: { end: () => false },
      isApplied: () => true,
      retryAtOnce: (key) => {
        retries.push(key)
      },
      log: (line) => {
        lines.push(line)
      },
    })

    expect([ended, retries, lines.length]).toEqual([[], [], 1])
    expect(lines[0]).toStartWith(`${INVALID_FLAGS_HOLD_LOG_PREFIX} ending the holds on a version change failed: Error message="versionChanged broke (${REDACTED_SENTINEL_TAIL})" at `)
    assertNoLeak(lines, 'lines')
  })

  test('a version that is not a short version string is logged as unreadable, so no other text reaches a line', () => {
    const lines: string[] = []
    const hold = createInvalidFlagsHold({ log: (line) => { lines.push(line) } })
    const odd = `${LEAK_SENTINEL} ${fakeToken(BOT_TOKEN_PREFIX, 'hold')}`
    hold.set(HELD_P, odd)
    expect(lines).toEqual([invalidFlagsHoldSetLine(HELD_P, odd)])
    expect(lines[0]).toContain(HOLD_VERSION_UNREADABLE)
    expect(describeHoldVersion(undefined)).toBe(HOLD_VERSION_UNKNOWN)
    assertNoLeak(lines, 'lines')
  })
})

describe('the ErrInvalidFlags hold ends on the version-changed signal (b.jg5 SRJ-207, SRJ-204): a re-check passing with a version other than the one a hold began under ends it, silently, and retries the persona at once; the same version or a could-not-run keeps it', () => {
  test('a timed re-check passing with the same version keeps every hold; a could-not-run keeps them; a pass with a different version ends every hold, posts nothing, and retries each applied persona at once, at the re-check\'s time', async () => {
    const rig = makeHoldRig({ outcomes: [{ version: BASELINE_VERSION }, { throws: errSystemInstallNotFound() }, { version: LATER_PATCH }] })
    rig.hold.set(HELD_P, BASELINE_VERSION)
    rig.hold.set(HELD_Q, BASELINE_VERSION)
    await rig.clock.flush()
    const posts = [...rig.posts]

    await rig.clock.advance(AD_VERSION_RECHECK_INTERVAL_MS)
    expect(rig.hold.heldKeys()).toEqual([HELD_P, HELD_Q])
    await rig.clock.advance(AD_VERSION_RECHECK_INTERVAL_MS)
    expect(rig.hold.heldKeys()).toEqual([HELD_P, HELD_Q])
    expect(rig.retries).toEqual([])

    const due = rig.clock.pending()[0]!.dueAt
    await rig.clock.advance(AD_VERSION_RECHECK_INTERVAL_MS)
    expect(rig.resolveCalls).toHaveLength(3)
    expect(rig.hold.heldKeys()).toEqual([])
    expect(rig.posts).toEqual(posts)
    for (const key of [HELD_P, HELD_Q]) {
      expect(rig.episodes.isOpen(key, PERSONA_EPISODE_KIND_INVALID_FLAGS_HOLD)).toBe(false)
      expect(rig.lines.filter((line) => line === invalidFlagsHoldEndLine(key, BASELINE_VERSION, LATER_PATCH))).toHaveLength(1)
      expect(rig.lines.filter((line) => line === invalidFlagsHoldRetryLine(key, true))).toHaveLength(1)
    }
    expect(rig.retries).toEqual([{ key: HELD_P, at: due }, { key: HELD_Q, at: due }])
    expectOnlyTheRecheckPending(rig, true)
    assertNoLeak({ lines: rig.lines, posts: rig.posts })
  })

  test('a triggered re-check with a different version ends them too, at once', async () => {
    const rig = makeHoldRig({ outcomes: [{ version: LATER_MINOR }] })
    rig.hold.set(HELD_P, BASELINE_VERSION)
    const now = rig.clock.now()
    expect((await triggerAdVersionRecheck()).kind).toBe(RECHECK_OUTCOME_PASS)
    expect(rig.hold.isHeld(HELD_P)).toBe(false)
    expect(rig.retries).toEqual([{ key: HELD_P, at: now }])
    expectOnlyTheRecheckPending(rig, true)
  })

  test('a hold begun right after the immediate re-check that reported a new version stays held: it began under that version, which later re-checks keep finding', async () => {
    const rig = makeHoldRig({ outcomes: [{ version: LATER_PATCH }] })
    expect(await holdAsAReuseDoes(rig, HELD_P)).toEqual({ kind: INVALID_FLAGS_HOLD_DECISION_HOLD, version: LATER_PATCH })
    expect(rig.hold.beganUnder(HELD_P)).toBe(LATER_PATCH)
    await rig.clock.advance(3 * AD_VERSION_RECHECK_INTERVAL_MS)
    expect(rig.resolveCalls).toHaveLength(4)
    expect(rig.hold.isHeld(HELD_P)).toBe(true)
    expect(rig.retries).toEqual([])
    await rig.clock.flush()
    expect(rig.posts).toEqual([alertOf(HELD_P)])
    expectOnlyTheRecheckPending(rig, true)
  })

  test('a hold that began under no version (its re-check not running) ends at the first version change', async () => {
    const rig = makeHoldRig()
    expect(await holdAsAReuseDoes(rig, HELD_P)).toEqual({ kind: INVALID_FLAGS_HOLD_DECISION_HOLD })
    expect(rig.hold.beganUnder(HELD_P)).toBeUndefined()
    // The re-check installed afterwards, on the rig's clock.
    installAdVersionRecheck(installDeps(rig.clock, [], [], [{ version: BASELINE_VERSION }, { version: LATER_PATCH }]))
    await rig.clock.advance(AD_VERSION_RECHECK_INTERVAL_MS)
    expect(rig.hold.isHeld(HELD_P)).toBe(true)
    await rig.clock.advance(AD_VERSION_RECHECK_INTERVAL_MS)
    expect(rig.hold.isHeld(HELD_P)).toBe(false)
    expect(rig.lines.filter((line) => line === invalidFlagsHoldEndLine(HELD_P, undefined, LATER_PATCH))).toHaveLength(1)
    expect(rig.retries).toHaveLength(1)
    expectOnlyTheRecheckPending(rig, true)
  })

  test('a persona no longer applied is not retried when its hold ends; one line says so', async () => {
    const rig = makeHoldRig({ outcomes: [{ version: LATER_PATCH }] })
    rig.hold.set(HELD_P, BASELINE_VERSION)
    rig.hold.set(HELD_Q, BASELINE_VERSION)
    rig.applied.delete(HELD_Q)
    await triggerAdVersionRecheck()
    expect(rig.hold.heldKeys()).toEqual([])
    expect(rig.retries.map((retry) => retry.key)).toEqual([HELD_P])
    expect(rig.lines.filter((line) => line === invalidFlagsHoldRetryLine(HELD_Q, false))).toHaveLength(1)
  })
})

describe('the ErrInvalidFlags hold\'s other ends (b.jg5 SRJ-207, SRJ-715): a teardown\'s forget and a server restart', () => {
  test('forgetting P ends P\'s hold silently (no post, no retry) and keeps Q\'s; P held again posts one new alert', async () => {
    const rig = makeHoldRig()
    const ends: Array<{ key: string; reason: string }> = []
    rig.hold.addEndObserver(({ key, reason }) => {
      ends.push({ key, reason })
    })
    rig.hold.set(HELD_P, BASELINE_VERSION)
    rig.hold.set(HELD_Q, BASELINE_VERSION)
    await rig.clock.flush()
    const posts = [...rig.posts]

    expect(rig.hold.forget(HELD_P)).toBe(true)
    expect(rig.hold.forget(HELD_P)).toBe(false)
    rig.episodes.forget(HELD_P)
    await rig.clock.flush()
    expect(rig.hold.heldKeys()).toEqual([HELD_Q])
    expect(ends).toEqual([{ key: HELD_P, reason: INVALID_FLAGS_HOLD_END_FORGOTTEN }])
    expect(rig.posts).toEqual(posts)
    expect(rig.retries).toEqual([])
    expect(rig.lines.filter((line) => line === invalidFlagsHoldForgetLine(HELD_P, BASELINE_VERSION))).toHaveLength(1)

    rig.hold.set(HELD_P, BASELINE_VERSION)
    await rig.clock.flush()
    expect(rig.posts).toEqual([...posts, alertOf(HELD_P)])
    expect(rig.clock.pendingCount()).toBe(0)
  })

  test('forgetAll (shutdown) ends every hold silently: no end or retry line, and no retry', async () => {
    const rig = makeHoldRig()
    rig.hold.set(HELD_P, BASELINE_VERSION)
    rig.hold.set(HELD_Q)
    await rig.clock.flush()
    const before = rig.lines.length

    expect(rig.hold.forgetAll()).toEqual([HELD_P, HELD_Q])
    await rig.clock.flush()

    expect(rig.hold.heldKeys()).toEqual([])
    // Only the two forget lines: no end line and no retry line.
    expect(rig.lines.slice(before)).toEqual([invalidFlagsHoldForgetLine(HELD_P, BASELINE_VERSION), invalidFlagsHoldForgetLine(HELD_Q, undefined)])
    expect(rig.retries).toEqual([])
    expect(rig.clock.pendingCount()).toBe(0)
  })
})

describe('the ErrInvalidFlags hold below the floor (b.jg5 SRJ-205, AC 23): a reuse\'s re-check answering stop holds nothing', () => {
  test('one startup-errors entry of the exported class and one non-zero stop; no hold, no alert, no timer stop, and no further agent-director call', async () => {
    const rig = makeHoldRig({ outcomes: [{ version: OLD_AD_VERSION, path: binaryPathFor('hold-below-floor') }] })

    expect(await holdAsAReuseDoes(rig, HELD_P)).toEqual({ kind: INVALID_FLAGS_HOLD_DECISION_STOP })

    expect(rig.records.map((record) => record.classLabel)).toEqual([AD_BELOW_PHASE1_FLOOR])
    expect(rig.stops).toEqual([AD_VERSION_RECHECK_STOP_EXIT_CODE])
    expect(rig.stops[0]).not.toBe(0)
    expect([rig.hold.heldKeys(), rig.posts, rig.events]).toEqual([[], [], []])
    // The re-check ended with the stop: no timed re-check, and a later trigger calls nothing.
    await rig.clock.advance(3 * AD_VERSION_RECHECK_INTERVAL_MS)
    expect(await triggerAdVersionRecheck()).toEqual(NOT_RUNNING)
    expect(rig.resolveCalls).toHaveLength(1)
    expectOnlyTheRecheckPending(rig, false)
  })
})

// ---------------------------------------------------------------------------
// No Slack post on a runtime refusal (contribution to b.jg5 SRJ-1002)
// ---------------------------------------------------------------------------

describe('runtime re-check: no Slack post (source audit)', () => {
  /** The two gate modules: the runtime re-check's and the startup gate's (b.jg5 SRJ-1002). */
  const GATE_MODULES: string[] = ['ad-version-gate.ts', 'agent-director-startup.ts']

  /** Specifiers of every value import or re-export in comment-stripped code (`import type` / `export type` excluded). */
  function valueImportSpecifiers(code: string): string[] {
    const specifiers: string[] = []
    for (const m of code.matchAll(/\b(import|export)\s+(type\s+)?[^'";]*?\bfrom\s+['"]([^'"]+)['"]/g)) {
      if (m[2] === undefined) specifiers.push(m[3]!)
    }
    for (const m of code.matchAll(/\bimport\s*(?:\(\s*)?['"]([^'"]+)['"]/g)) specifiers.push(m[1]!)
    return specifiers
  }

  /** What in `code` could reach Slack: each value import of a Slack client, notifier or persona-notifier module, and each Slack post. */
  function slackReachIn(code: string): string[] {
    const imports = valueImportSpecifiers(code).filter(
      (specifier) => /^@slack\//.test(specifier) || /notifier/.test(specifier) || /persona-slack-|persona-connections|slack-client|server\.ts$/.test(specifier),
    )
    const posts = [...code.matchAll(/\bchat\.postMessage\b|\bpostMessage\s*\(/g)].map((m) => m[0])
    return [...imports, ...posts]
  }

  const gateCode = (file: string): string => stripComments(readFileSync(join(import.meta.dir, '..', 'src', file), 'utf-8'))

  test.each(GATE_MODULES)('src/%s value-imports no Slack client, notifier or persona-notifier module and posts nothing', (file) => {
    const code = gateCode(file)
    expect(valueImportSpecifiers(code).length).toBeGreaterThan(0)
    expect(slackReachIn(code)).toEqual([])
  })

  test.each(
    GATE_MODULES.flatMap((file) =>
      [
        ["import { WebClient } from '@slack/web-api'", '@slack/web-api'],
        ["import { createPersonaNotifier } from './persona-notifier.ts'", './persona-notifier.ts'],
        ["export { setSessionNotifier } from './server.ts'", './server.ts'],
        ["const m = await import('./persona-slack-episodes.ts')", './persona-slack-episodes.ts'],
        ['client.chat.postMessage({ channel, text })', 'chat.postMessage'],
      ].map(([planted, found]) => [file, planted!, found!] as const),
    ),
  )('a planted Slack reach in src/%s is found: %s', (file, planted, found) => {
    expect(slackReachIn(`${gateCode(file)}\n${planted}\n`)).toEqual([found])
  })

  test('a type-only Slack import is no reach', () => {
    expect(slackReachIn("import type { WebClient } from '@slack/web-api'\n")).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Host-version decision (b.jg5 SRJ-211, SRJ-212; AC 81): shared fixtures
// ---------------------------------------------------------------------------

/** A distinct host binary path per case, so an outcome shows the path it was given is passed through. */
const hostBinaryPath = (label: string): string => join(tmpdir(), 'cscb-ad-host-version', label, 'agent-director')

/** The next patch release after `version`. */
const coreAbove = (version: string): string => v(semver.major(version), semver.minor(version), semver.patch(version) + 1)

/** The client minimum's release candidate: below the minimum in the client's order (a release ranks above its pre-release). */
const CLIENT_MIN_RC = `${CLIENT_MIN_VERSION}${RC}`

/** A client minimum just above `OLD_AD_VERSION` (and so below the floor). */
const MIN_ABOVE_OLD = coreAbove(OLD_AD_VERSION)

/** A resolved `resolveSystemBinary()` call. */
const resolvedWith = (version: unknown, path: string): HostVersionCallResult =>
  ({ kind: 'resolved', value: { version, path } }) as HostVersionCallResult

/** A rejected `resolveSystemBinary()` call. */
const rejectedWith = (error: unknown): HostVersionCallResult => ({ kind: 'rejected', error })

/** The failure of a failing outcome; fails the test for a pass. */
function failureOf(outcome: HostVersionOutcome): HostVersionFailure {
  expect(outcome.kind).toBe(HOST_VERSION_OUTCOME_FAIL)
  if (outcome.kind !== HOST_VERSION_OUTCOME_FAIL) throw new Error(`expected a failing outcome, got ${outcome.kind}`)
  return outcome.failure
}

describe('host-version decision: fixtures built from the helper versions', () => {
  test("CLIENT_MIN_RC is below the client's minimum; MIN_ABOVE_OLD is above OLD_AD_VERSION and below the floor", () => {
    expect(semver.lt(CLIENT_MIN_RC, CLIENT_MIN_VERSION)).toBe(true)
    expect(semver.gt(MIN_ABOVE_OLD, OLD_AD_VERSION)).toBe(true)
    expect(meetsPhase1Floor(MIN_ABOVE_OLD)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Host-version decision: one case per SRJ-211 row
// ---------------------------------------------------------------------------

describe('host-version decision: passes (SRJ-211)', () => {
  test.each([
    ["the floor's release candidate", PHASE1_RC_VERSION],
    ['the floor', PHASE1_FLOOR_VERSION],
    ['a later minor release built from the floor', LATER_MINOR],
    ['a later major release built from the floor', LATER_MAJOR],
  ])('%s (%s): pass with no note, carrying the version and path', (label, version) => {
    const path = hostBinaryPath(`pass-${label}`)
    expect(decideHostAdVersion(resolvedWith(version, path), CLIENT_MIN_VERSION)).toEqual({
      kind: HOST_VERSION_OUTCOME_PASS,
      version,
      binaryPath: path,
    })
  })

  test.each([
    ['the release before Phase 1', OLD_AD_VERSION],
    ["the client's dev sentinel (ranked above every version by the client)", DEV_PLACEHOLDER_VERSION],
    ["the client's minimum itself", CLIENT_MIN_VERSION],
  ])('%s (%s): pass below the floor (the Phase 1 note), carrying the version and path', (label, version) => {
    const path = hostBinaryPath(`pass-below-${label}`)
    expect(decideHostAdVersion(resolvedWith(version, path), CLIENT_MIN_VERSION)).toEqual({
      kind: HOST_VERSION_OUTCOME_PASS_BELOW_FLOOR,
      version,
      binaryPath: path,
    })
  })
})

describe("host-version decision: below the client's minimum fails (SRJ-211)", () => {
  test.each([
    ['a resolved release below the minimum', BELOW_CLIENT_MIN_VERSION],
    ["the minimum's release candidate (below it in the client's order)", CLIENT_MIN_RC],
  ])('%s (%s): fails below the client minimum, carrying found, required and path', (label, version) => {
    const path = hostBinaryPath(`below-min-${label}`)
    expect(failureOf(decideHostAdVersion(resolvedWith(version, path), CLIENT_MIN_VERSION))).toEqual({
      kind: HOST_VERSION_FAIL_BELOW_CLIENT_MINIMUM,
      foundVersion: version,
      requiredVersion: CLIENT_MIN_VERSION,
      binaryPath: path,
    })
  })

  test("ErrSystemInstallTooOld: fails below the client minimum, carrying the error's found and required versions and path", () => {
    const path = hostBinaryPath('too-old')
    const error = errSystemInstallTooOld(BELOW_CLIENT_MIN_VERSION, CLIENT_MIN_VERSION, path)
    expect(failureOf(decideHostAdVersion(rejectedWith(error), CLIENT_MIN_VERSION))).toEqual({
      kind: HOST_VERSION_FAIL_BELOW_CLIENT_MINIMUM,
      foundVersion: error.actualVersion,
      requiredVersion: error.requiredVersion,
      binaryPath: error.binaryPath,
    })
  })

  test("ErrSystemInstallTooOld: the error's required version wins over the supplied minimum", () => {
    const path = hostBinaryPath('too-old-required')
    const error = errSystemInstallTooOld(BELOW_CLIENT_MIN_VERSION, CLIENT_MIN_VERSION, path)
    const failure = failureOf(decideHostAdVersion(rejectedWith(error), MIN_ABOVE_OLD))
    expect(failure.kind).toBe(HOST_VERSION_FAIL_BELOW_CLIENT_MINIMUM)
    if (failure.kind === HOST_VERSION_FAIL_BELOW_CLIENT_MINIMUM) expect(failure.requiredVersion).toBe(CLIENT_MIN_VERSION)
  })
})

describe('host-version decision: not found fails (SRJ-211)', () => {
  test('ErrSystemInstallNotFound: fails not found', () => {
    expect(failureOf(decideHostAdVersion(rejectedWith(errSystemInstallNotFound()), CLIENT_MIN_VERSION))).toEqual({
      kind: HOST_VERSION_FAIL_NOT_FOUND,
    })
  })
})

describe('host-version decision: a version that cannot be read fails (SRJ-211, SRJ-202 strict parse)', () => {
  test.each([
    ['a timed-out probe', errSystemInstallUnreachable('probe-timeout', null, hostBinaryPath('unreachable-timeout'))],
    ['an unparseable version', errSystemInstallUnreachable('unparseable-version', DEV_UNPARSEABLE_VERSION, hostBinaryPath('unreachable-unparseable'))],
  ])('ErrSystemInstallUnreachable (%s): fails version unreadable, carrying the path and the reason word', (_label, error) => {
    const failure = failureOf(decideHostAdVersion(rejectedWith(error), CLIENT_MIN_VERSION))
    expect(failure.kind).toBe(HOST_VERSION_FAIL_VERSION_UNREADABLE)
    if (failure.kind === HOST_VERSION_FAIL_VERSION_UNREADABLE) {
      expect(failure.binaryPath).toBe(error.binaryPath)
      expect(failure.reason).toBe(error.reason)
      expect(failure.detail).toContain(error.reason)
    }
  })

  test.each([
    ['no reason', {}],
    ['an empty reason', { reason: '' }],
    ['a non-string reason', { reason: 42 }],
    ['an upper-case reason', { reason: UNREACHABLE_REASONS[0]!.toUpperCase() }],
    ['a reason with a line break', { reason: `${UNREACHABLE_REASONS[0]}\n${UNREACHABLE_REASONS[1]}` }],
    ['a reason longer than 64 characters', { reason: UNREACHABLE_REASONS[0]!.padEnd(65, 'x') }],
    ['a token-bearing reason', { reason: fakeToken(BOT_TOKEN_PREFIX, 'reason') }],
    ['a reason carrying a fake token and URL', { reason: sentinelInMessage('reason') }],
  ] as Array<[string, Record<string, unknown>]>)('ErrSystemInstallUnreachable with %s: reason UNREACHABLE_REASON_UNKNOWN, with no credential', (label, fields) => {
    const path = hostBinaryPath(`unreachable-unknown-${label}`)
    const unreachable = { errName: errSystemInstallUnreachable().errName, binaryPath: path, ...fields }
    const failure = failureOf(decideHostAdVersion(rejectedWith(unreachable), CLIENT_MIN_VERSION))
    expect(failure.kind).toBe(HOST_VERSION_FAIL_VERSION_UNREADABLE)
    if (failure.kind === HOST_VERSION_FAIL_VERSION_UNREADABLE) {
      expect(failure.binaryPath).toBe(path)
      expect(failure.reason).toBe(UNREACHABLE_REASON_UNKNOWN)
      expect(failure.detail).toContain(UNREACHABLE_REASON_UNKNOWN)
    }
    assertNoLeak(failure, label)
  })

  test("UNREACHABLE_REASON_UNKNOWN is none of agent-director's reasons; UNREACHABLE_REASON_UNPARSEABLE_VERSION is one of them", () => {
    expect(UNREACHABLE_REASONS).not.toContain(UNREACHABLE_REASON_UNKNOWN)
    expect(UNREACHABLE_REASONS).toContain(UNREACHABLE_REASON_UNPARSEABLE_VERSION)
  })

  test.each([
    ['an unparseable development version', DEV_UNPARSEABLE_VERSION],
    ['a leading-v form of the floor', `v${PHASE1_FLOOR_VERSION}`],
    ['a leading-v form of the release before Phase 1', `v${OLD_AD_VERSION}`],
    ['a +build form of the floor', `${PHASE1_FLOOR_VERSION}+build.1`],
    ['the empty string', ''],
  ])('a resolved %s (%p): fails version unreadable with reason UNREACHABLE_REASON_UNPARSEABLE_VERSION, carrying the path, never a pass', (label, version) => {
    const path = hostBinaryPath(`unreadable-${label}`)
    const failure = failureOf(decideHostAdVersion(resolvedWith(version, path), CLIENT_MIN_VERSION))
    expect(failure.kind).toBe(HOST_VERSION_FAIL_VERSION_UNREADABLE)
    if (failure.kind === HOST_VERSION_FAIL_VERSION_UNREADABLE) {
      expect(failure.binaryPath).toBe(path)
      expect(failure.reason).toBe(UNREACHABLE_REASON_UNPARSEABLE_VERSION)
      if (version !== '') expect(failure.detail).toContain(version)
    }
  })

  test.each([
    ['no version', undefined],
    ['a numeric version', 11],
    ['a null version', null],
  ] as Array<[string, unknown]>)('a resolved value with %s: fails version unreadable with reason UNREACHABLE_REASON_UNPARSEABLE_VERSION, carrying the path', (label, version) => {
    const path = hostBinaryPath(`no-version-${label}`)
    const failure = failureOf(decideHostAdVersion(resolvedWith(version, path), CLIENT_MIN_VERSION))
    expect(failure.kind).toBe(HOST_VERSION_FAIL_VERSION_UNREADABLE)
    if (failure.kind === HOST_VERSION_FAIL_VERSION_UNREADABLE) {
      expect(failure.binaryPath).toBe(path)
      expect(failure.reason).toBe(UNREACHABLE_REASON_UNPARSEABLE_VERSION)
    }
  })
})

describe('host-version decision: any other thrown value fails, never a pass (SRJ-211)', () => {
  test('another named agent-director error (ErrBunVersionTooOld): fails other, naming it', () => {
    const error = errBunVersionTooOld()
    expect(failureOf(decideHostAdVersion(rejectedWith(error), CLIENT_MIN_VERSION))).toEqual({
      kind: HOST_VERSION_FAIL_OTHER,
      description: error.errName,
    })
  })

  test.each([
    ['a plain Error', new Error('stub resolve failure')],
    ['a thrown string', 'stub resolve failure'],
    ['a thrown number', 15],
    ['a thrown null', null],
    ['a thrown undefined', undefined],
    ['a plain object with no name', { detail: 'stub resolve failure' }],
  ] as Array<[string, unknown]>)('%s: fails other', (_label, thrown) => {
    expect(failureOf(decideHostAdVersion(rejectedWith(thrown), CLIENT_MIN_VERSION)).kind).toBe(HOST_VERSION_FAIL_OTHER)
  })

  test("a getter that throws on the thrown value's name is read as no name: fails other, and the decision does not throw", () => {
    const hostile = Object.defineProperty({}, 'errName', { get: () => { throw new Error('stub getter failure') } })
    expect(failureOf(decideHostAdVersion(rejectedWith(hostile), CLIENT_MIN_VERSION)).kind).toBe(HOST_VERSION_FAIL_OTHER)
  })
})

describe("host-version decision: the client's minimum is an input", () => {
  test('with a minimum above OLD_AD_VERSION, OLD_AD_VERSION fails below that minimum while the dev sentinel still passes below the floor', () => {
    const oldPath = hostBinaryPath('input-min-old')
    const devPath = hostBinaryPath('input-min-dev')
    expect(failureOf(decideHostAdVersion(resolvedWith(OLD_AD_VERSION, oldPath), MIN_ABOVE_OLD))).toEqual({
      kind: HOST_VERSION_FAIL_BELOW_CLIENT_MINIMUM,
      foundVersion: OLD_AD_VERSION,
      requiredVersion: MIN_ABOVE_OLD,
      binaryPath: oldPath,
    })
    expect(decideHostAdVersion(resolvedWith(DEV_PLACEHOLDER_VERSION, devPath), MIN_ABOVE_OLD)).toEqual({
      kind: HOST_VERSION_OUTCOME_PASS_BELOW_FLOOR,
      version: DEV_PLACEHOLDER_VERSION,
      binaryPath: devPath,
    })
  })

  test("with a minimum above the floor, the floor's release candidate fails below it", () => {
    const path = hostBinaryPath('input-min-above-floor')
    const failure = failureOf(decideHostAdVersion(resolvedWith(PHASE1_RC_VERSION, path), LATER_MINOR))
    expect(failure).toEqual({
      kind: HOST_VERSION_FAIL_BELOW_CLIENT_MINIMUM,
      foundVersion: PHASE1_RC_VERSION,
      requiredVersion: LATER_MINOR,
      binaryPath: path,
    })
  })

  test.each([
    ['a leading-v form of the client minimum', `v${CLIENT_MIN_VERSION}`],
    ['an unparseable development version', DEV_UNPARSEABLE_VERSION],
  ])('a resolved binary against %s (%s): fails client minimum unreadable, never a pass', (_label, minimum) => {
    expect(failureOf(decideHostAdVersion(resolvedWith(PHASE1_RC_VERSION, hostBinaryPath('min-unreadable')), minimum))).toEqual({
      kind: HOST_VERSION_FAIL_CLIENT_MINIMUM_UNREADABLE,
      clientMinimum: minimum,
    })
  })
})

describe('host-version decision: install errors are recognised by name', () => {
  /** The structural fields the decision reads from an install error. */
  const INSTALL_ERROR_FIELDS = ['actualVersion', 'requiredVersion', 'binaryPath', 'reason'] as const

  /** A plain object (no class, no `name`, no `message`) carrying only `error`'s `errName` and its install fields. */
  function byNameOnly(error: Error & { errName: string }): Record<string, unknown> {
    const plain: Record<string, unknown> = { errName: error.errName }
    for (const key of INSTALL_ERROR_FIELDS) {
      if (key in error) plain[key] = (error as unknown as Record<string, unknown>)[key]
    }
    return plain
  }

  test.each([
    ['ErrSystemInstallNotFound', errSystemInstallNotFound()],
    ['ErrSystemInstallTooOld', errSystemInstallTooOld(BELOW_CLIENT_MIN_VERSION, CLIENT_MIN_VERSION, hostBinaryPath('by-name-too-old'))],
    ['ErrSystemInstallUnreachable', errSystemInstallUnreachable('probe-timeout', null, hostBinaryPath('by-name-unreachable'))],
    ['ErrBunVersionTooOld', errBunVersionTooOld()],
  ] as Array<[string, Error & { errName: string }]>)('%s: a plain object carrying only its errName and fields gives the same outcome as the class-built error', (_label, error) => {
    const plain = byNameOnly(error)
    expect(plain).not.toBeInstanceOf(Error)
    expect(decideHostAdVersion(rejectedWith(plain), CLIENT_MIN_VERSION)).toEqual(decideHostAdVersion(rejectedWith(error), CLIENT_MIN_VERSION))
  })

  test('errName wins over name: a value whose errName names another error and whose name names not-found fails other', () => {
    const bunTooOld = errBunVersionTooOld()
    const mixed = { errName: bunTooOld.errName, name: errSystemInstallNotFound().errName }
    expect(failureOf(decideHostAdVersion(rejectedWith(mixed), CLIENT_MIN_VERSION))).toEqual({
      kind: HOST_VERSION_FAIL_OTHER,
      description: bunTooOld.errName,
    })
  })
})

describe('host-version decision: every outcome is token-free', () => {
  test.each([
    ['a resolved pass with a token-bearing path', resolvedWith(PHASE1_RC_VERSION, `${hostBinaryPath('token-pass')}/${sentinelInMessage('pass')}`), CLIENT_MIN_VERSION],
    ['a resolved pass below the floor with a token-bearing path', resolvedWith(OLD_AD_VERSION, `${hostBinaryPath('token-below')}/${sentinelInMessage('below')}`), CLIENT_MIN_VERSION],
    ['a resolved token-bearing unparseable version', resolvedWith(sentinelInMessage('version'), hostBinaryPath('token-version')), CLIENT_MIN_VERSION],
    ['a token-bearing client minimum', resolvedWith(PHASE1_RC_VERSION, hostBinaryPath('token-min')), sentinelInMessage('minimum')],
    ['ErrSystemInstallTooOld with a token-bearing path', rejectedWith(errSystemInstallTooOld(BELOW_CLIENT_MIN_VERSION, CLIENT_MIN_VERSION, `${hostBinaryPath('token-too-old')}/${sentinelInMessage('too-old')}`)), CLIENT_MIN_VERSION],
    ['ErrSystemInstallUnreachable with a token-bearing path and diagnostic', rejectedWith(errSystemInstallUnreachable('probe-timeout', LEAK_SENTINEL, `${hostBinaryPath('token-unreachable')}/${sentinelInMessage('unreachable')}`)), CLIENT_MIN_VERSION],
    ['an error whose errName is token-shaped', rejectedWith(Object.assign(new Error('stub resolve failure'), { errName: fakeToken(BOT_TOKEN_PREFIX, 'errname') })), CLIENT_MIN_VERSION],
  ] as Array<[string, HostVersionCallResult, string]>)('%s: no credential in the outcome', (label, result, minimum) => {
    assertNoLeak(decideHostAdVersion(result, minimum), label)
  })
})

// ---------------------------------------------------------------------------
// Host-version decision: the settle step and the one-line redaction
// ---------------------------------------------------------------------------

describe('settleHostVersionCall', () => {
  test('a resolved call settles resolved, carrying the value as given', async () => {
    const value = { version: PHASE1_RC_VERSION, path: hostBinaryPath('settle-resolved') }
    const settled = await settleHostVersionCall(() => Promise.resolve(value))
    expect(settled).toEqual({ kind: 'resolved', value })
    if (settled.kind === 'resolved') expect(settled.value).toBe(value)
  })

  test.each([
    ['a rejection', (error: unknown) => () => Promise.reject(error)],
    ['a synchronous throw', (error: unknown) => () => { throw error }],
  ] as Array<[string, (error: unknown) => () => Promise<never>]>)('%s settles rejected, carrying the thrown value; the settle never rejects', async (_label, makeResolve) => {
    const error = errSystemInstallNotFound()
    const settled = await settleHostVersionCall(makeResolve(error))
    expect(settled.kind).toBe('rejected')
    if (settled.kind === 'rejected') expect(settled.error).toBe(error)
  })

  test('makes exactly one resolver call', async () => {
    const calls: Array<object | undefined> = []
    await settleHostVersionCall(makeStubResolveSystemBinary({ calls }))
    expect(calls).toHaveLength(1)
  })
})

describe('redactToOneLine', () => {
  test.each([
    ['a fake token and a URL', `probe failed (${sentinelInMessage('redact')})`, `probe failed (${REDACTED_SENTINEL_TAIL})`],
    ['a CRLF and a run of line feeds', 'first\r\nsecond\n\n\nthird', 'first second third'],
    ['Unicode line and paragraph separators', 'first\u2028second\u2029third', 'first second third'],
    ['a fake token on one line and a URL on the next', `${fakeToken(BOT_TOKEN_PREFIX, 'multi')}\n${sentinelInMessage('multi')}`, `${REDACTED_TOKEN_PLACEHOLDER} ${REDACTED_SENTINEL_TAIL}`],
    ['plain one-line text', `binary at ${hostBinaryPath('plain')}`, `binary at ${hostBinaryPath('plain')}`],
  ])('%s: one token-free line', (label, text, expected) => {
    const line = redactToOneLine(text)
    expect(line).toBe(expected)
    expect(line).not.toMatch(/[\r\n\u2028\u2029]/)
    assertNoLeak(line, label)
  })
})

// ---------------------------------------------------------------------------
// Host-version decision: the client's version order (SRJ-211)
// ---------------------------------------------------------------------------

describe('compareAdVersions', () => {
  test("CLIENT_DEV_SENTINEL_VERSION is the client's own DEV_SENTINEL_VERSION", () => {
    expect(CLIENT_DEV_SENTINEL_VERSION).toBe(DEV_SENTINEL_VERSION)
  })

  test.each([
    ['the release before Phase 1', OLD_AD_VERSION],
    ["the client's minimum", CLIENT_MIN_VERSION],
    ['the floor', PHASE1_FLOOR_VERSION],
    ["the floor's release candidate", PHASE1_RC_VERSION],
    ['a later major release', LATER_MAJOR],
  ])('ranks the sentinel above %s (%s)', (_label, version) => {
    expect(compareAdVersions(CLIENT_DEV_SENTINEL_VERSION, version)).toBe(1)
    expect(compareAdVersions(version, CLIENT_DEV_SENTINEL_VERSION)).toBe(-1)
  })

  test('the sentinel equals itself', () => {
    expect(compareAdVersions(CLIENT_DEV_SENTINEL_VERSION, CLIENT_DEV_SENTINEL_VERSION)).toBe(0)
  })

  test.each([
    ['the floor', PHASE1_FLOOR_VERSION],
    ["the client's minimum", CLIENT_MIN_VERSION],
    ['a later minor release', LATER_MINOR],
  ])('ranks a release above its own pre-release: %s (%s)', (_label, version) => {
    expect(compareAdVersions(version, `${version}${RC}`)).toBe(1)
    expect(compareAdVersions(`${version}${RC}`, version)).toBe(-1)
  })

  test.each([
    ['the floor', PHASE1_FLOOR_VERSION],
    ["the floor's release candidate", PHASE1_RC_VERSION],
    ['the release before Phase 1', OLD_AD_VERSION],
  ])('a version equals itself: %s (%s)', (_label, version) => {
    expect(compareAdVersions(version, version)).toBe(0)
  })

  test.each([
    ['the release before Phase 1 against the floor', OLD_AD_VERSION, PHASE1_FLOOR_VERSION],
    ['the version just below the floor against the floor', JUST_BELOW, PHASE1_FLOOR_VERSION],
    ['the floor against a later patch release', PHASE1_FLOOR_VERSION, LATER_PATCH],
    ['a later minor release against a later major release', LATER_MINOR, LATER_MAJOR],
    ["a release below the client's minimum against the minimum", BELOW_CLIENT_MIN_VERSION, CLIENT_MIN_VERSION],
  ])('orders %s: -1 one way, 1 the other', (_label, lower, higher) => {
    expect(compareAdVersions(lower, higher)).toBe(-1)
    expect(compareAdVersions(higher, lower)).toBe(1)
  })

  test.each(LEXICAL_TRAPS)('compares %s against the floor numerically, not as a string', (version) => {
    expect(compareAdVersions(version, PHASE1_FLOOR_VERSION)).toBe(semver.compare(version, PHASE1_FLOOR_VERSION))
  })

  test('two pre-release tags compare as strings, as the client orders them', () => {
    const [low, high] = [`${PHASE1_FLOOR_VERSION}${RC}0`, `${PHASE1_FLOOR_VERSION}${RC.slice(0, -1)}9`].sort()
    expect(low! < high!).toBe(true)
    expect(compareAdVersions(low!, high!)).toBe(-1)
    expect(compareAdVersions(high!, low!)).toBe(1)
  })

  test.each([
    ['a leading-v form of the floor', `v${PHASE1_FLOOR_VERSION}`],
    ['a +build form of the floor', `${PHASE1_FLOOR_VERSION}+build.1`],
    ['an unparseable development version', DEV_UNPARSEABLE_VERSION],
    ['the empty string', ''],
  ])('answers null when either side is %s (%p)', (_label, unparseable) => {
    expect(compareAdVersions(unparseable, PHASE1_FLOOR_VERSION)).toBeNull()
    expect(compareAdVersions(PHASE1_FLOOR_VERSION, unparseable)).toBeNull()
    expect(compareAdVersions(unparseable, CLIENT_DEV_SENTINEL_VERSION)).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Host-version decision: the Phase 1 note (SRJ-211)
// ---------------------------------------------------------------------------

describe('buildPhase1HostNote', () => {
  /** The note for a binary that passes below the floor, built from the decision's outcome. */
  function noteFor(version: string, label: string): { note: string; path: string } {
    const path = hostBinaryPath(`note-${label}`)
    const outcome = decideHostAdVersion(resolvedWith(version, path), CLIENT_MIN_VERSION)
    expect(outcome.kind).toBe(HOST_VERSION_OUTCOME_PASS_BELOW_FLOOR)
    if (outcome.kind === HOST_VERSION_OUTCOME_FAIL) throw new Error('expected a passing outcome')
    return { note: buildPhase1HostNote({ foundVersion: outcome.version, binaryPath: outcome.binaryPath }), path }
  }

  test.each([
    ['the release before Phase 1', OLD_AD_VERSION],
    ["the client's dev sentinel", DEV_PLACEHOLDER_VERSION],
  ])('for %s (%s): names the found version, the path, the floor, the Phase 1 phrase and the runbook section title; no upgrade instruction, no package.json, no command and no link', (label, version) => {
    const { note, path } = noteFor(version, label)
    for (const text of [version, path, PHASE1_FLOOR_VERSION, PHASE1_HOST_NOTE_PHRASE, PHASE1_RUNBOOK_SECTION_TITLE]) {
      expect(note).toContain(text)
    }
    expect(note.toLowerCase()).not.toContain('upgrade agent-director')
    expect(note).not.toContain('package.json')
    for (const [, pattern] of UPGRADE_FORMS) expect(flat(note)).not.toMatch(pattern)
    expect(note).not.toMatch(/https?:\/\//)
  })
})

// ---------------------------------------------------------------------------
// The import-cycle fix: the leaf labels module (source audit)
// ---------------------------------------------------------------------------

describe('install-check labels: the import-cycle fix (source audit)', () => {
  const readSrc = (file: string): string => stripComments(readFileSync(join(import.meta.dir, '..', 'src', file), 'utf-8'))

  test('src/ad-version-gate.ts names ./install-check.ts in no import, re-export, dynamic import or require, and takes its labels from ./install-check-labels.ts', () => {
    const code = readSrc('ad-version-gate.ts')
    expect(code).not.toMatch(/['"`]\.\/install-check(?:\.[jt]s)?['"`]/)
    expect(importSource(code, 'AD_BELOW_PHASE1_FLOOR')).toBe('./install-check-labels.ts')
    expect(importSource(code, 'AD_SYSTEM_INSTALL_TOO_OLD')).toBe('./install-check-labels.ts')
  })

  test('src/install-check-labels.ts imports nothing: no import, re-export, dynamic import or require', () => {
    const code = readSrc('install-check-labels.ts')
    expect(code).toMatch(/\bexport\s+const\b/)
    expect(code).not.toMatch(/\bimport\b/)
    expect(code).not.toMatch(/\bfrom\s*['"`]/)
    expect(code).not.toMatch(/\brequire\s*\(/)
  })

  test('src/install-check-labels.ts exports labels to check', () => {
    expect(Object.keys(installCheckLabels).length).toBeGreaterThan(0)
  })

  test.each(Object.entries(installCheckLabels))('src/install-check.ts re-exports %s with the same value', (name, value) => {
    expect({ name, reExported: (installCheck as Record<string, unknown>)[name] }).toEqual({ name, reExported: value })
  })
})
