/**
 * startup-errors.test.ts — `recordStartupError` (`src/startup-errors.ts`):
 * its `omitStderr` option, and one entry of each `startup-errors.log` class,
 * read back from the case's own log directory (b.jg5 SRJ-1013, SRJ-702,
 * SRJ-704, SRJ-909).
 *
 * The `omitStderr` cases run each call in a child `bun` process
 * (`runInFakeHome`), so everything the call writes to fd 2 is captured whole,
 * however it is written. The child's HOME, state directory and `logDir` are
 * the case's own `mkdtempSync` tree, and the case checks that nothing else
 * was written there.
 *
 * The class cases (SRJ-1013's Test line: one case per class, reading the
 * entry from a temp log directory) run in process. Each drives the class's
 * producing path, the route or the entry builder its module exports, with the
 * real `recordStartupError` writing into the case's own directory: through
 * the producer's recorder seam (`logDir`), or, where the producer imports
 * the recorder itself (the start sweep, the launch, the dialog approver),
 * through `SLACK_STATE_DIR`, which the recovery harness or the case points
 * at its own directory and puts back. Every entry is read with
 * `readStartupEntries`; every label, builder, phrase, context and count comes
 * from `src/` or the helpers, and every agent-director error from the stub's
 * builders. The server-log line each entry comes with is `recordStartupError`'s
 * own fd-2 copy (pinned by the `omitStderr` cases above), and the route's own
 * line where the route writes one.
 *
 * The stopped-retry cases (SRJ-702, SRJ-704, SRJ-1013; AC 64) drive a launch
 * attempt's live-row sequence on the recovery harness (its kill-failure
 * alerts installed as `main()` installs them, its notices through the real
 * notifier with one Slack stub per persona): its kill's tries stopped between
 * tries by the persona's removal, its teardown, its stopping being up or a
 * server shutdown. The old-life wait's stopped kills, the hold-end control
 * and the start sweep's stopped kill are their own files' cases
 * (`tests/old-life-wait.test.ts`, `tests/session-manager.test.ts`).
 *
 * SPDX-License-Identifier: MIT
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { classifyAdError, describeAgentDirectorFailure, killFailedDescriptionOf } from '../src/ad-error-class.ts'
import { adAlertThresholdMsInEffect, adLaunchBoundMsInEffect, resetAdSettingsForTests } from '../src/ad-settings.ts'
import {
  AD_VERSION_RECHECK_INTERVAL_MS,
  AD_VERSION_RECHECK_STOP_EXIT_CODE,
  DEBUG_SKILL_PATH,
  DEBUG_SKILL_RUNTIME_STOP_POINTER,
  PHASE1_FLOOR_VERSION,
  PHASE1_REQUIRED_PHRASE,
  PHASE1_RUNBOOK_SECTION_TITLE,
  PHASE1_SWITCH_OVER_INSTRUCTION,
  RUNTIME_RECHECK_PHRASE,
  createAdVersionRecheck,
  type AdVersionRecheck,
} from '../src/ad-version-gate.ts'
import { getClient, resetClientForTests, setClientForTests } from '../src/agent-director-client.ts'
import { runAgentDirectorStartupGate } from '../src/agent-director-startup.ts'
import { KILL_OUTCOME_KILLED, describeKillOutcome, killOutcomeOf } from '../src/checked-kill.ts'
import {
  CLEAN_RESTART_NOT_RESTARTED_LABEL,
  CLEAN_RESTART_NOT_STARTED_SENTENCE,
  CLI_COMMAND_CLEAN_RESTART,
  CLI_COMMAND_STOP_BOTS,
  CLI_TEARDOWN_FAILED_LABEL,
  TEARDOWN_STEP_PAUSE,
  cleanRestartNotRestartedAlert,
  personaTeardownReportOf,
  teardownErrorReportOf,
  teardownFailed,
  teardownKillOutcomeOf,
  type CliTeardownPersona,
} from '../src/cli-teardown.ts'
import { configReadFailurePredicate, type Persona } from '../src/config.ts'
import { AD_SYSTEM_INSTALL_TOO_OLD, AD_BELOW_PHASE1_FLOOR } from '../src/install-check-labels.ts'
import { renderInstallSkillInstructions } from '../src/install-skill-pointer.ts'
import {
  KILL_FAILURE_CLOSING_CLI_TEARDOWN,
  KILL_FAILURE_CLOSING_DESTINATION,
  KILL_FAILURE_CLOSING_DESTINATION_LATCHED,
  KILL_FAILURE_CLOSING_LOG_ONLY,
  KILL_FAILURE_CONTEXT_PERSONA_TEARDOWN,
  KILL_FAILURE_CONTEXT_RECOVERY,
  KILL_FAILURE_CONTEXT_START_SWEEP,
  KILL_FAILURE_VERSION_ORDINARY,
  KILL_FAILURE_VERSION_SURVIVOR,
  ORPHAN_CLEANUP_LABEL,
  PERSONA_KILL_FAILED_LABEL,
  PERSONA_KILL_SURVIVOR_LABEL,
  PERSONA_TEARDOWN_NOTICE_LABEL,
  killFailureAlertEntryText,
  killFailureAlertText,
  killFailureCliTeardownEntryContext,
  killFailureClosingSentence,
  renderKillFailureAlertEntryContext,
  type KillFailureAlertContent,
  type KillFailureClosing,
} from '../src/kill-failure-alert.ts'
import {
  KILL_RETRY_ALERT_ORDINARY,
  KILL_RETRY_ALERT_SURVIVOR,
  KILL_RETRY_END_EXHAUSTED,
  KILL_RETRY_END_SETTLED,
  KILL_RETRY_TRIES,
  type KillRetryAlert,
  type KillRetryResult,
} from '../src/kill-retry.ts'
import { AGENT_DIRECTOR_PENDING_STATE, LIVENESS_DEAD_ROW_ENDED } from '../src/liveness-reading.ts'
import {
  LIVE_ROW_OUTCOME_STOPPED,
  LIVE_ROW_STOP_SHUTDOWN,
  LIVE_ROW_STOP_TEARDOWN,
  liveRowStopCauseText,
} from '../src/live-row-sequence.ts'
import { _resetOutageState, initOutageState } from '../src/outage-state.ts'
import { parseLaunchStart } from '../src/pending-row.ts'
import {
  PERSONA_UNCLASSIFIED_ERROR_LABEL,
  personaUnclassifiedErrorEntryText,
  createKillFailureAlerts,
  createPersonaEpisodes,
  createUnclassifiedErrorEpisodes,
  unclassifiedErrorAlertText,
} from '../src/persona-episodes.ts'
import { personaInstanceId, personaTmuxSessionName, renderPersonaRef } from '../src/persona-identity.ts'
import { PERSONA_TEARDOWN_NOTICE_RAISED } from '../src/persona-notifier.ts'
import { RETIRED_KEYS_UNREADABLE_LABEL, readRetiredKeysAtStart, retiredKeysPath, retiredKeysUnreadableMessage } from '../src/retired-keys.ts'
import {
  APPROVER_BOUND_FROM_LAUNCH_START,
  APPROVER_STOP_BOUND,
  APPROVER_STOP_FINISHED,
  PERSONA_KILL_STOP_CAUSE_NOT_UP,
  STARTUP_ERROR_APPROVE_NOT_READY,
  STARTUP_ERROR_APPROVE_SPAWN_DIED,
  STARTUP_ERROR_SPAWN_FAILED,
  _resetApproverClock,
  _setApproverClock,
  approvePreSessionDialogs,
  approverBoundMessage,
  approverFinishedMessage,
  approverLogLine,
  setSessionNotifier,
  startSweepKillFailedEntry,
} from '../src/session-manager.ts'
import { recordStartupError, type StartupErrorOptions } from '../src/startup-errors.ts'
import {
  SAMPLE_LAUNCH_START_DEFAULT,
  cannedStatusResult,
  errInternal,
  errSystemInstallTooOld,
  errTmuxKillFailed,
  errTmuxSessionCreate,
  errTmuxUnresponsive,
  makePassingGateDeps,
  makeStubClient,
  makeStubCreateClient,
  makeStubResolveSystemBinary,
  type StubResolveSystemBinaryOutcome,
} from './test-helpers/agent-director-stub.ts'
import { CLIENT_MIN_VERSION, OLD_AD_VERSION, PHASE1_RC_VERSION } from './test-helpers/agent-director-versions.ts'
import { assertNoLeak, LEAK_SENTINEL, sentinelInMessage, writtenFile } from './test-helpers/credentials.ts'
import { createFakeClock } from './test-helpers/fake-clock.ts'
import { runInFakeHome } from './test-helpers/fake-home-subprocess.ts'
import { STALE_VERSION } from './test-helpers/install-check-fixtures.ts'
import { flat } from './test-helpers/markdown.ts'
import { listed, sweepOver } from './test-helpers/old-life.ts'
import { makeMultiPersonaConfig } from './test-helpers/persona-config.ts'
import {
  makeNotifierHarness,
  readStartupEntries,
  teardownNoticeEntry,
  teardownNoticeLine,
  type NotifierHarness,
  type StartupEntry,
} from './test-helpers/persona-notifier.ts'
import {
  killFailureLines,
  killFailureNotRaisedLine,
  killFailureStoppedEntry,
  killFailureStoppedEntryLine,
  launchThroughSequence,
  makeRecoveryHarness,
  ordinaryAlertContent,
  personaOf,
  scriptLiveRowElsewhere,
  survivorAlertContent,
  type RecoveryHarness,
} from './test-helpers/recovery-harness.ts'
import { UPGRADE_FORMS } from './test-helpers/upgrade-forms.ts'

/** The module under test, by absolute path, for the child to import. */
const STARTUP_ERRORS_SRC = resolve(import.meta.dir, '..', 'src', 'startup-errors.ts')

/** The log file's name inside its directory. */
const LOG_NAME = 'startup-errors.log'

/** An entry message spread over lines, as a failure line followed by an alert is. */
const MESSAGE = 'first line\nsecond line\r\nthird line\rfourth line'

/** `MESSAGE` as the entry carries it: one line. */
const FLAT_MESSAGE = 'first line second line third line fourth line'

let root: string
let home: string
let stateDir: string
let logDir: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'startup-errors-test-'))
  home = join(root, 'home')
  stateDir = join(root, 'state')
  logDir = join(root, 'log')
  mkdirSync(home)
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

/** Run `recordStartupError(CLI_TEARDOWN_FAILED_LABEL, MESSAGE, undefined, options)` in a child; its fd 2 and stdout. */
function record(options: StartupErrorOptions): { stderr: string; stdout: string } {
  const res = runInFakeHome({
    modulePath: STARTUP_ERRORS_SRC,
    call: 'mod.recordStartupError(input.classLabel, input.message, undefined, input.options)',
    input: { classLabel: CLI_TEARDOWN_FAILED_LABEL, message: MESSAGE, options },
    home,
    stateDir,
  })
  expect(res.observedHomedir).toBe(home)
  expect(res.status).toBe(0)
  return { stderr: res.stderr, stdout: res.stdout }
}

/** The lines of `text`, empty ones dropped. */
function linesOf(text: string): string[] {
  return text.split('\n').filter((line) => line.length > 0)
}

/** Fails unless `line` is the one entry: a timestamp, the class in brackets, then the flattened message. */
function expectEntry(line: string | undefined): void {
  expect(line).toMatch(/^\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\] /)
  expect(line!.slice(line!.indexOf('] ') + 2)).toBe(`[${CLI_TEARDOWN_FAILED_LABEL}] ${FLAT_MESSAGE}`)
}

/** Fails unless the case's tree holds nothing but the log directory's one file and the empty home (the child runtime's cache aside). */
function expectNoStrayWrite(): void {
  expect(readdirSync(root).sort()).toEqual(['home', 'log'])
  expect(readdirSync(logDir)).toEqual([LOG_NAME])
  expect(readdirSync(home).filter((e) => e !== '.bun')).toEqual([])
  expect(existsSync(stateDir)).toBe(false)
}

describe("recordStartupError's omitStderr option (b.jg5 SRJ-909)", () => {
  test('with omitStderr: one one-line entry under the given class in logDir, and nothing on fd 2', () => {
    const { stderr, stdout } = record({ logDir, omitStderr: true })
    const logged = linesOf(readFileSync(join(logDir, LOG_NAME), 'utf-8'))

    expect(stderr).toBe('')
    expect(logged).toHaveLength(1)
    expectEntry(logged[0])
    expectNoStrayWrite()
    assertNoLeak({ stderr, stdout, logged })
  })

  test.each<[string, boolean | undefined]>([
    ['omitStderr unset', undefined],
    ['omitStderr false', false],
  ])('with %s: the same one-line entry in logDir and on fd 2, as before', (_label, omitStderr) => {
    const { stderr, stdout } = record(omitStderr === undefined ? { logDir } : { logDir, omitStderr })
    const logged = linesOf(readFileSync(join(logDir, LOG_NAME), 'utf-8'))

    expect(logged).toHaveLength(1)
    expectEntry(logged[0])
    expect(linesOf(stderr)).toEqual(logged)
    expectNoStrayWrite()
    assertNoLeak({ stderr, stdout, logged })
  })

  test('with omitStderr and a logDir that cannot be made: no entry anywhere, and the one-line disk-failure warning still on fd 2', () => {
    const blocker = join(root, 'blocker')
    writeFileSync(blocker, '')
    const { stderr, stdout } = record({ logDir: join(blocker, 'log'), omitStderr: true })

    const warnings = linesOf(stderr)
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain(join(blocker, 'log', LOG_NAME))
    expect(warnings[0]).not.toContain(FLAT_MESSAGE)
    expect(readFileSync(blocker, 'utf-8')).toBe('')
    expect(readdirSync(root).sort()).toEqual(['blocker', 'home'])
    assertNoLeak({ stderr, stdout })
  })
})

// ===========================================================================
// b.jg5 SRJ-1013: one entry per class, read from the case's log directory
// ===========================================================================

/** The real `recordStartupError` into `dir`, as the server's recorder writes an entry (its fd-2 copy included). */
function recorderInto(dir: string): (classLabel: string, message: string) => void {
  return (classLabel, message) => recordStartupError(classLabel, message, undefined, { logDir: dir })
}

/** The CLI's recorder (`src/cli.ts`): the real `recordStartupError` into `dir`, with no fd-2 copy (b.jg5 SRJ-909). */
function cliRecorderInto(dir: string): (classLabel: string, message: string) => void {
  return (classLabel, message) => recordStartupError(classLabel, message, undefined, { logDir: dir, omitStderr: true })
}

/** `text` as `recordStartupError` writes it: each line break a space. */
function oneLine(text: string): string {
  return text.replace(/\r?\n/g, ' ').replace(/\r/g, ' ')
}

/** The entries in `dir`'s `startup-errors.log`: fails unless there is exactly one, of `classLabel`. Answers its text. */
function onlyEntry(dir: string, classLabel: string): string {
  const entries = readStartupEntries(dir)
  expect(entries.map((entry) => entry.classLabel)).toEqual([classLabel])
  return entries[0]!.text
}

/** Fails unless `text` holds every one of `named` and none of `absent`. */
function expectNames(text: string, named: readonly string[], absent: readonly string[] = []): void {
  for (const part of named) expect(text).toContain(part)
  for (const part of absent) expect(text).not.toContain(part)
}

/** Fails if `text` carries an instruction to upgrade agent-director or an upgrade or install command (b.jg5 SRJ-208). */
function expectNoUpgradeForm(text: string): void {
  for (const [, pattern] of UPGRADE_FORMS) expect(flat(text)).not.toMatch(pattern)
}

// ---------------------------------------------------------------------------
// The two version classes, from the startup gate and from a runtime re-check
// (SRJ-203, SRJ-204, SRJ-205, SRJ-208; hatch A3)
// ---------------------------------------------------------------------------

describe('b.jg5 SRJ-1013, SRJ-208 (hatch A3): ad-below-phase1-floor and ad-system-install-too-old, from the startup gate and from a runtime re-check', () => {
  const rechecks: AdVersionRecheck[] = []

  afterEach(() => {
    for (const recheck of rechecks.splice(0)) recheck.dispose()
    resetClientForTests()
  })

  /** A binary path of the case's own, so an entry shows the path it was given is passed through. */
  const binaryPath = (): string => join(root, 'bin', 'agent-director')

  /** The startup gate (`runAgentDirectorStartupGate`) over `createClient`, its record the real recorder into `logDir`: one exit, non-zero. */
  async function startupGate(createClient: ReturnType<typeof makeStubCreateClient>): Promise<void> {
    const exits: number[] = []
    const exit = (code: number): never => {
      exits.push(code)
      throw new Error(`exit(${code})`)
    }
    await expect(runAgentDirectorStartupGate(makePassingGateDeps({ createClient, recordStartupError: recorderInto(logDir), exit }))).rejects.toThrow()
    expect(exits).toHaveLength(1)
    expect(exits[0]).not.toBe(0)
  }

  /** One runtime re-check (`createAdVersionRecheck`) on a fake clock, the resolve answering `outcome`, its record the real recorder into `logDir`: one stop. */
  async function runtimeRecheck(outcome: StubResolveSystemBinaryOutcome): Promise<void> {
    const clock = createFakeClock()
    const stops: number[] = []
    const logs: string[] = []
    const recheck = createAdVersionRecheck({
      resolveSystemBinary: makeStubResolveSystemBinary({ outcomes: [outcome] }),
      baselineVersion: PHASE1_RC_VERSION,
      recordStartupError: recorderInto(logDir),
      stop: (code) => {
        stops.push(code)
      },
      log: (line) => {
        logs.push(line)
      },
      clock,
    })
    rechecks.push(recheck)
    recheck.start()
    await clock.advance(AD_VERSION_RECHECK_INTERVAL_MS)
    expect(stops).toEqual([AD_VERSION_RECHECK_STOP_EXIT_CODE])
    expect(logs).toEqual([])
  }

  /**
   * What a runtime re-check's entry never names (b.jg5 SRJ-208, SRJ-1013;
   * hatch A3): the switch-over runbook (its section, the startup gate's
   * instruction), the install skill's block, and an instruction to install
   * agent-director.
   */
  function expectNoRunbookOrInstall(text: string): void {
    expectNames(text, [], [PHASE1_RUNBOOK_SECTION_TITLE, PHASE1_SWITCH_OVER_INSTRUCTION, oneLine(renderInstallSkillInstructions()).trim()])
    expect(text).not.toMatch(/switch-over runbook/i)
    expect(text).not.toMatch(/\binstall agent-director\b/i)
  }

  test('below the floor, at the startup gate: one entry naming the version found, the floor, the binary path, that the startup check found it, and the switch-over runbook sentence with its section', async () => {
    const path = binaryPath()

    await startupGate(makeStubCreateClient({ client: makeStubClient({ binaryVersion: OLD_AD_VERSION, binaryPath: path }) }))

    const text = onlyEntry(logDir, AD_BELOW_PHASE1_FLOOR)
    expectNames(text, [OLD_AD_VERSION, PHASE1_FLOOR_VERSION, path, PHASE1_SWITCH_OVER_INSTRUCTION, PHASE1_RUNBOOK_SECTION_TITLE], [RUNTIME_RECHECK_PHRASE, DEBUG_SKILL_PATH])
    expectNoUpgradeForm(text)
    assertNoLeak(writtenFile(join(logDir, LOG_NAME)))
  })

  test('below the floor, at a runtime re-check: one entry naming the version found, the floor, the binary path, the runtime phrase, that this release requires Phase 1 and the debug skill; neither the runbook nor the install skill', async () => {
    const path = binaryPath()

    await runtimeRecheck({ version: OLD_AD_VERSION, path })

    const text = onlyEntry(logDir, AD_BELOW_PHASE1_FLOOR)
    expectNames(text, [OLD_AD_VERSION, PHASE1_FLOOR_VERSION, path, RUNTIME_RECHECK_PHRASE, PHASE1_REQUIRED_PHRASE, DEBUG_SKILL_RUNTIME_STOP_POINTER, DEBUG_SKILL_PATH])
    expectNoRunbookOrInstall(text)
    expectNoUpgradeForm(text)
    assertNoLeak(writtenFile(join(logDir, LOG_NAME)))
  })

  test("the client's too-old refusal, at the startup gate: one entry naming the version found, the client's minimum, the floor, the binary path and the runbook section, ending with the install-skill block", async () => {
    const path = binaryPath()

    await startupGate(makeStubCreateClient({ error: errSystemInstallTooOld(STALE_VERSION, CLIENT_MIN_VERSION, path) }))

    const text = onlyEntry(logDir, AD_SYSTEM_INSTALL_TOO_OLD)
    expectNames(text, [STALE_VERSION, CLIENT_MIN_VERSION, PHASE1_FLOOR_VERSION, path, PHASE1_RUNBOOK_SECTION_TITLE], [RUNTIME_RECHECK_PHRASE, DEBUG_SKILL_PATH])
    expect(text.endsWith(oneLine(renderInstallSkillInstructions()))).toBe(true)
    expectNoUpgradeForm(text)
    assertNoLeak(writtenFile(join(logDir, LOG_NAME)))
  })

  test("the client's too-old refusal, at a runtime re-check: one entry naming the version found, the client's minimum, the floor, the binary path, the runtime phrase and the debug skill; neither the runbook nor the install skill", async () => {
    const path = binaryPath()

    await runtimeRecheck({ throws: errSystemInstallTooOld(STALE_VERSION, CLIENT_MIN_VERSION, path) })

    const text = onlyEntry(logDir, AD_SYSTEM_INSTALL_TOO_OLD)
    expectNames(text, [STALE_VERSION, CLIENT_MIN_VERSION, PHASE1_FLOOR_VERSION, path, RUNTIME_RECHECK_PHRASE, DEBUG_SKILL_RUNTIME_STOP_POINTER, DEBUG_SKILL_PATH])
    expectNoRunbookOrInstall(text)
    expectNoUpgradeForm(text)
    assertNoLeak(writtenFile(join(logDir, LOG_NAME)))
  })
})

// ---------------------------------------------------------------------------
// The kill-failure classes, the teardown notice and the unclassified-error
// alert, on their log-only routes (SRJ-704, SRJ-1003, SRJ-1007, SRJ-1009;
// the E20 and E25 hatch notes)
// ---------------------------------------------------------------------------

/**
 * The server's notice composition, as `main()` builds it: the real persona
 * notifier over one Slack stub per persona (its teardown window's recorder
 * the real `recordStartupError` into `logDir`), the notice episodes handing
 * their posts to it and reading its teardown window, and the kill-failure
 * alerts and unclassified-error episodes over those episodes, each persona
 * configured while it is in `h.personas`, their log-only routes the real
 * recorder into `logDir`. Every timer runs on one fake clock.
 */
interface NoticeRig {
  readonly h: NotifierHarness
  readonly clock: ReturnType<typeof createFakeClock>
  readonly lines: string[]
  readonly alerts: ReturnType<typeof createKillFailureAlerts>
  readonly unclassified: ReturnType<typeof createUnclassifiedErrorEpisodes>
  /** The first persona, the one each case raises for. */
  readonly persona: Persona
  /** Drop the first persona from the applied configuration (a reload that removed it). */
  remove(): void
}

describe('b.jg5 SRJ-1013, SRJ-704, SRJ-1003: persona-kill-failed, persona-kill-survivor, persona-teardown-notice and persona-unclassified-error on their log-only routes', () => {
  let rig: NoticeRig | undefined

  afterEach(() => {
    const done = rig
    rig = undefined
    if (done === undefined) return
    try {
      // Nothing reached Slack: no post through any persona's stub.
      expect(done.h.allPosts()).toEqual(Object.fromEntries([...done.h.stubs.keys()].map((key) => [key, []])))
      expect(done.clock.pendingCount()).toBe(0)
      assertNoLeak({ lines: done.lines, logs: done.h.logs, entries: readStartupEntries(logDir), file: writtenFile(join(logDir, LOG_NAME)) })
    } finally {
      done.h.cleanup()
    }
  })

  function buildRig(): NoticeRig {
    const config = makeMultiPersonaConfig([{ name: 'Ops Bot' }, { name: 'dev' }], root)
    const h = makeNotifierHarness(config, { leakMarker: LEAK_SENTINEL, recordStartupError: recorderInto(logDir) })
    const clock = createFakeClock()
    const lines: string[] = []
    const log = (line: string): void => {
      lines.push(line)
    }
    const episodes = createPersonaEpisodes({
      sink: (key, text, options) => {
        void h.notifier.notify(key, text, options)
      },
      log,
      clock,
      teardownWindow: (key) => h.notifier.teardownWindowState(key),
    })
    const isConfigured = (key: string): boolean => h.personas.some((p) => p.key === key)
    const alerts = createKillFailureAlerts({ episodes, log, isConfigured, logOnly: recorderInto(logDir) })
    const unclassified = createUnclassifiedErrorEpisodes({
      episodes,
      log,
      alertThresholdMs: adAlertThresholdMsInEffect,
      isConfigured,
      // As `main()` binds it (`src/server.ts`).
      logOnly: (key, text) => recordStartupError(PERSONA_UNCLASSIFIED_ERROR_LABEL, personaUnclassifiedErrorEntryText(key, text), undefined, { logDir }),
    })
    const persona = h.personas[0]!
    rig = {
      h,
      clock,
      lines,
      alerts,
      unclassified,
      persona,
      remove: () => {
        h.personas.splice(h.personas.indexOf(persona), 1)
      },
    }
    return rig
  }

  /** A survivor-naming `ErrTmuxKillFailed` whose description carries the sentinel (in its session name). */
  const survivorNaming = (label: string): Error => errTmuxKillFailed(sentinelInMessage(label), 'pane-process-survived')

  /** The raw description an `ErrTmuxKillFailed` carries. */
  function descriptionOf(err: Error): string {
    const description = killFailedDescriptionOf(err)
    if (description === undefined) throw new Error('no ErrTmuxKillFailed description')
    return description
  }

  test('persona-kill-failed (the not-configured route): the ordinary version for a persona no longer in the applied configuration is one entry naming the persona, the context and the alert text; one written line', () => {
    const r = buildRig()
    const err = errTmuxKillFailed(sentinelInMessage('not-configured'))
    r.remove()

    expect(r.alerts.raise({ key: r.persona.key, decision: { kind: KILL_RETRY_ALERT_ORDINARY, lastKillFailedDescription: descriptionOf(err) }, latched: false, context: KILL_FAILURE_CONTEXT_RECOVERY })).toBe('logged')

    const content: KillFailureAlertContent = {
      version: KILL_FAILURE_VERSION_ORDINARY,
      session: personaTmuxSessionName(r.persona.key),
      instanceId: personaInstanceId(r.persona.key),
      quotes: { lastKillFailedDescription: descriptionOf(err) },
    }
    const text = onlyEntry(logDir, PERSONA_KILL_FAILED_LABEL)
    expect(text).toBe(killFailureAlertEntryText(`persona=${r.persona.key}`, KILL_FAILURE_CONTEXT_RECOVERY, killFailureAlertText(content, KILL_FAILURE_CLOSING_LOG_ONLY, false)))
    expect(r.lines.filter((line) => line.includes(`(${PERSONA_KILL_FAILED_LABEL})`))).toHaveLength(1)
  })

  // Rows: the version raised during P's teardown, the decision, its content for P, and the entry's class.
  test.each<[string, (description: string) => KillRetryAlert, (key: string, description: string) => KillFailureAlertContent, string]>([
    [
      'persona-kill-survivor: the survivor version',
      (description) => ({ kind: KILL_RETRY_ALERT_SURVIVOR, survivorDescription: description }),
      (key, description) => ({ version: KILL_FAILURE_VERSION_SURVIVOR, session: personaTmuxSessionName(key), survivorDescription: description }),
      PERSONA_KILL_SURVIVOR_LABEL,
    ],
    [
      'persona-teardown-notice: the ordinary version',
      (description) => ({ kind: KILL_RETRY_ALERT_ORDINARY, lastKillFailedDescription: description }),
      (key, description) => ({ version: KILL_FAILURE_VERSION_ORDINARY, session: personaTmuxSessionName(key), instanceId: personaInstanceId(key), quotes: { lastKillFailedDescription: description } }),
      PERSONA_TEARDOWN_NOTICE_LABEL,
    ],
  ])('%s raised during the persona\'s teardown (the persona-teardown route, E25) is one entry of its class naming the persona, "raised during its teardown" and the alert text, and one window line', async (_label, decision, contentOf, classLabel) => {
    const r = buildRig()
    const description = descriptionOf(survivorNaming('teardown-route'))

    await r.h.duringTeardown(r.persona, () => {
      expect(r.alerts.raise({ key: r.persona.key, decision: decision(description), latched: false, context: KILL_FAILURE_CONTEXT_PERSONA_TEARDOWN })).toBe('logged')
    })

    const text = killFailureAlertText(contentOf(r.persona.key, description), KILL_FAILURE_CLOSING_LOG_ONLY, false)
    expect(readStartupEntries(logDir)).toEqual([teardownNoticeEntry(r.persona, text, PERSONA_TEARDOWN_NOTICE_RAISED, classLabel)])
    expect(r.h.logs.filter((line) => line === teardownNoticeLine(r.persona, text, PERSONA_TEARDOWN_NOTICE_RAISED, classLabel))).toHaveLength(1)
  })

  test('persona-unclassified-error: the alert of an episode past its threshold, for a persona no longer in the applied configuration, is one entry naming the persona key and the alert text', async () => {
    const r = buildRig()
    const first = errInternal(sentinelInMessage('unclassified-first'))
    const err = errInternal(sentinelInMessage('unclassified-alert'))

    expect(r.unclassified.report(r.persona.key, first)).toBe('begun')
    await r.clock.advance(adAlertThresholdMsInEffect() + 1)
    r.remove()
    expect(r.unclassified.report(r.persona.key, err)).toBe('alerted')

    const text = onlyEntry(logDir, PERSONA_UNCLASSIFIED_ERROR_LABEL)
    expectNames(text, [r.persona.key])
    expect(text.endsWith(unclassifiedErrorAlertText(classifyAdError(err), { escapeForSlack: false }))).toBe(true)
    expect(r.lines.filter((line) => line.includes(`(${PERSONA_UNCLASSIFIED_ERROR_LABEL})`))).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// The CLI teardown's classes, and its route of the kill classes with the
// command as context (SRJ-904, SRJ-906, SRJ-907, SRJ-909; the E33 hatch note)
// ---------------------------------------------------------------------------

describe('b.jg5 SRJ-1013, SRJ-909: cli-teardown-failed, clean-restart-not-restarted and the CLI route of the kill classes, through the CLI\'s recorder', () => {
  const PERSONA: CliTeardownPersona = { name: 'Ops Bot', key: 'ops_bot' }
  const OTHER: CliTeardownPersona = { name: 'dev', key: 'dev' }

  /** One persona's report under `command`, recorded as the CLI records it (`src/cli.ts`). */
  function recordReport(command: typeof CLI_COMMAND_STOP_BOTS | typeof CLI_COMMAND_CLEAN_RESTART, persona: CliTeardownPersona, outcome: Parameters<typeof personaTeardownReportOf>[2]): void {
    const { entry } = personaTeardownReportOf(command, persona, outcome)
    if (entry === undefined) throw new Error('the report has no startup-errors entry')
    cliRecorderInto(logDir)(entry.classLabel, entry.message)
  }

  /** A persona and its session, as the CLI's lines name them. */
  const named = (persona: CliTeardownPersona): string[] => [renderPersonaRef(persona.name, persona.key), personaTmuxSessionName(persona.key)]

  /** The kill-failure alert text on the CLI teardown's route for `content`. */
  const cliAlert = (persona: CliTeardownPersona, command: string, content: KillFailureAlertContent): string =>
    killFailureAlertEntryText(`persona ${renderPersonaRef(persona.name, persona.key)}`, killFailureCliTeardownEntryContext(command), killFailureAlertText(content, KILL_FAILURE_CLOSING_CLI_TEARDOWN, false))

  test.each([CLI_COMMAND_STOP_BOTS, CLI_COMMAND_CLEAN_RESTART] as const)('cli-teardown-failed (%s): a pause that failed is one entry naming the command, the persona, its session, the class and the redacted description', (command) => {
    const err = errInternal(sentinelInMessage('cli-pause'))
    const report = teardownErrorReportOf(err)

    recordReport(command, PERSONA, teardownFailed(TEARDOWN_STEP_PAUSE, report))

    const text = onlyEntry(logDir, CLI_TEARDOWN_FAILED_LABEL)
    expectNames(text, [command, ...named(PERSONA), report.errorClass, report.description])
    assertNoLeak({ text, file: writtenFile(join(logDir, LOG_NAME)) })
  })

  test('clean-restart-not-restarted: one entry naming each failed persona with its session and class, and the closing sentence', () => {
    const failures = [
      { persona: PERSONA, errorClass: classifyAdError(errInternal()).errorClass },
      { persona: OTHER, errorClass: classifyAdError(errTmuxUnresponsive('pause')).errorClass },
    ]

    cliRecorderInto(logDir)(CLEAN_RESTART_NOT_RESTARTED_LABEL, cleanRestartNotRestartedAlert(failures))

    const text = onlyEntry(logDir, CLEAN_RESTART_NOT_RESTARTED_LABEL)
    expectNames(text, [CLI_COMMAND_CLEAN_RESTART, ...named(PERSONA), ...named(OTHER), ...failures.map((f) => f.errorClass), CLEAN_RESTART_NOT_STARTED_SENTENCE])
    expect(text.endsWith(CLEAN_RESTART_NOT_STARTED_SENTENCE)).toBe(true)
  })

  test.each([CLI_COMMAND_STOP_BOTS, CLI_COMMAND_CLEAN_RESTART] as const)('persona-kill-failed on the CLI route (%s): a kill that failed after its tries is one entry naming the persona, the context with the command, and the ordinary alert text', (command) => {
    const err = errTmuxKillFailed(sentinelInMessage('cli-kill'))
    const retried: KillRetryResult = {
      outcome: killOutcomeOf({ thrown: err }),
      end: KILL_RETRY_END_EXHAUSTED,
      tries: KILL_RETRY_TRIES,
      reads: KILL_RETRY_TRIES - 1,
      alert: { kind: KILL_RETRY_ALERT_ORDINARY, lastKillFailedDescription: killFailedDescriptionOf(err)! },
    }

    recordReport(command, PERSONA, teardownKillOutcomeOf(retried))

    const text = onlyEntry(logDir, PERSONA_KILL_FAILED_LABEL)
    const content: KillFailureAlertContent = {
      version: KILL_FAILURE_VERSION_ORDINARY,
      session: personaTmuxSessionName(PERSONA.key),
      instanceId: personaInstanceId(PERSONA.key),
      quotes: { lastKillFailedDescription: killFailedDescriptionOf(err)! },
    }
    expect(text.endsWith(cliAlert(PERSONA, command, content))).toBe(true)
    expectNames(text, [renderKillFailureAlertEntryContext(killFailureCliTeardownEntryContext(command)), ...named(PERSONA)])
    assertNoLeak({ text, file: writtenFile(join(logDir, LOG_NAME)) })
  })

  test.each([CLI_COMMAND_STOP_BOTS, CLI_COMMAND_CLEAN_RESTART] as const)('persona-kill-survivor on the CLI route (%s): a kill that succeeded after a survivor-naming failure is one entry naming the persona, the context with the command, and the survivor alert text', (command) => {
    const survivor = errTmuxKillFailed(sentinelInMessage('cli-survivor'), 'pane-process-survived')
    const outcome = killOutcomeOf({ result: { kill_sent: true } })
    expect(outcome.kind).toBe(KILL_OUTCOME_KILLED)
    const retried: KillRetryResult = {
      outcome,
      end: KILL_RETRY_END_SETTLED,
      tries: 2,
      reads: 1,
      alert: { kind: KILL_RETRY_ALERT_SURVIVOR, survivorDescription: killFailedDescriptionOf(survivor)! },
    }

    recordReport(command, PERSONA, teardownKillOutcomeOf(retried))

    const content: KillFailureAlertContent = { version: KILL_FAILURE_VERSION_SURVIVOR, session: personaTmuxSessionName(PERSONA.key), survivorDescription: killFailedDescriptionOf(survivor)! }
    expect(onlyEntry(logDir, PERSONA_KILL_SURVIVOR_LABEL)).toBe(cliAlert(PERSONA, command, content))
    assertNoLeak(writtenFile(join(logDir, LOG_NAME)))
  })
})

// ---------------------------------------------------------------------------
// retired-keys-unreadable (SRJ-802)
// ---------------------------------------------------------------------------

describe('b.jg5 SRJ-1013, SRJ-802: retired-keys-unreadable', () => {
  test('a record that cannot be read at start (a directory at its path) is one entry naming the file and the remedy', () => {
    mkdirSync(stateDir)
    const path = retiredKeysPath(stateDir)
    mkdirSync(path)
    const logs: string[] = []

    expect(readRetiredKeysAtStart(stateDir, { log: (line) => logs.push(line), recordStartupError: recorderInto(logDir) })).toEqual({ kind: 'refused', path })

    expect(onlyEntry(logDir, RETIRED_KEYS_UNREADABLE_LABEL)).toBe(retiredKeysUnreadableMessage(path, configReadFailurePredicate('EISDIR')))
    expect(logs).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// The dialog approver's classes (SRJ-402, SRJ-404, SRJ-405), the approver run
// directly on a fake clock over the stub client, `SLACK_STATE_DIR` pointing at
// the case's log directory
// ---------------------------------------------------------------------------

describe('b.jg5 SRJ-1013, SRJ-402, SRJ-405: dev-channels-approve-spawn-died and dev-channels-approve-not-ready, from a start-pass approver', () => {
  const KEY = 'ops_bot'
  const REF = renderPersonaRef('Ops Bot', KEY)
  let savedStateDir: string | undefined
  let lines: string[]
  let notices: Array<{ key: string; text: string }>
  let savedConsoleError: typeof console.error

  beforeEach(() => {
    savedStateDir = process.env['SLACK_STATE_DIR']
    process.env['SLACK_STATE_DIR'] = logDir
    lines = []
    notices = []
    savedConsoleError = console.error
    console.error = (...args: unknown[]) => {
      lines.push(args.map(String).join(' '))
    }
    initOutageState({
      notify: (key, text) => {
        notices.push({ key, text })
      },
      getClient,
    })
    setSessionNotifier((key, text) => {
      notices.push({ key, text })
    })
  })

  afterEach(() => {
    console.error = savedConsoleError
    try {
      // The approver posts nothing (b.jg5 SRJ-405).
      expect(notices).toEqual([])
      assertNoLeak({ lines, notices, file: writtenFile(join(logDir, LOG_NAME)) })
    } finally {
      _resetApproverClock()
      _resetOutageState()
      setSessionNotifier(undefined)
      resetClientForTests()
      resetAdSettingsForTests()
      if (savedStateDir === undefined) delete process.env['SLACK_STATE_DIR']
      else process.env['SLACK_STATE_DIR'] = savedStateDir
    }
  })

  /** Run a start-pass approver for KEY over a stub whose `status` answers `row`, on a fake clock from `startMs`, to its stop. */
  async function approveOver(row: ReturnType<typeof cannedStatusResult>, startMs: number): Promise<string> {
    const clock = createFakeClock({ start: startMs })
    _setApproverClock(clock)
    setClientForTests(makeStubClient({ statusResult: row }) as unknown as Parameters<typeof setClientForTests>[0])
    let stop: string | undefined
    void approvePreSessionDialogs(KEY, true, REF).then((reason) => {
      stop = reason
    })
    for (let fired = 0; stop === undefined && fired < 1_000; fired++) {
      await clock.flush()
      if (stop === undefined) await clock.runNext()
    }
    expect(clock.pendingCount()).toBe(0)
    return stop!
  }

  // Rows: the row's state, the stop, the entry's class and its message (the persona, and the state read or B).
  test.each<[string, string, string, string, () => string]>([
    ['dev-channels-approve-spawn-died: a row read ended, written at once, naming the persona and the state read', LIVENESS_DEAD_ROW_ENDED, APPROVER_STOP_FINISHED, STARTUP_ERROR_APPROVE_SPAWN_DIED, () => approverFinishedMessage(REF, LIVENESS_DEAD_ROW_ENDED)],
    ['dev-channels-approve-not-ready: a row still pending at B, naming the persona and B from its launch start', AGENT_DIRECTOR_PENDING_STATE, APPROVER_STOP_BOUND, STARTUP_ERROR_APPROVE_NOT_READY, () => approverBoundMessage(REF, adLaunchBoundMsInEffect(), APPROVER_BOUND_FROM_LAUNCH_START)],
  ])('%s: one entry and one approver line; nothing is posted', async (_label, state, stopReason, classLabel, message) => {
    expect(await approveOver(cannedStatusResult({ state }), parseLaunchStart(SAMPLE_LAUNCH_START_DEFAULT)!)).toBe(stopReason)

    expect(onlyEntry(logDir, classLabel)).toBe(message())
    expect(lines.filter((line) => line === approverLogLine(message()))).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// The recovery harness's classes: the start sweep's orphan-cleanup (SRJ-714;
// the E26 hatch note) and the start pass's spawn-failed (the E17 hatch note)
// ---------------------------------------------------------------------------

describe('b.jg5 SRJ-1013, SRJ-714: orphan-cleanup from the start sweep, and spawn-failed from a start-pass launch', () => {
  let harness: RecoveryHarness | undefined

  afterEach(() => {
    const h = harness
    harness = undefined
    if (h === undefined) return
    try {
      assertNoLeak(h.captured())
    } finally {
      h.cleanup()
    }
  })

  test('orphan-cleanup: a start-sweep kill of a persona\'s old row that failed through its tries is one entry naming the row, its persona, its outcome and the ordinary alert text (start sweep); no delete', async () => {
    const h = (harness = makeRecoveryHarness())
    const b = h.keys[1]!
    const err = errTmuxKillFailed(sentinelInMessage('orphan-cleanup'))
    h.script({ killError: err })
    const row = listed(h, b, { claude_instance_id: `${personaInstanceId(b)}_old` })

    await sweepOver(h, [row])

    const text = onlyEntry(h.stateDir, ORPHAN_CLEANUP_LABEL)
    const outcome = killOutcomeOf({ thrown: err })
    expect(
      text.startsWith(
        startSweepKillFailedEntry({
          instanceId: row.claude_instance_id,
          persona: renderPersonaRef(personaOf(h, b).name, b),
          state: row.state,
          session: row.tmux_session_name,
          outcome: describeKillOutcome(outcome),
          stoppedAtShutdown: false,
        }),
      ),
    ).toBe(true)
    const content: KillFailureAlertContent = {
      version: KILL_FAILURE_VERSION_ORDINARY,
      session: row.tmux_session_name,
      instanceId: row.claude_instance_id,
      quotes: { lastKillFailedDescription: killFailedDescriptionOf(err)! },
    }
    expect(text.endsWith(killFailureAlertEntryText(`instanceId=${row.claude_instance_id}`, KILL_FAILURE_CONTEXT_START_SWEEP, killFailureAlertText(content, KILL_FAILURE_CLOSING_LOG_ONLY, false)))).toBe(true)
    expect(h.stub.calls.deleteCalls).toEqual([])
    expect([h.episodeNotices, h.notices]).toEqual([[], []])
  })

  test('spawn-failed: a start-pass launch whose spawn failed to create its session is one entry naming the persona and the described failure', async () => {
    const h = (harness = makeRecoveryHarness())
    const p = h.keys[0]!
    const err = errTmuxSessionCreate('spawn')
    h.script({ spawnError: err })

    await h.launch(p)

    const text = onlyEntry(h.stateDir, STARTUP_ERROR_SPAWN_FAILED)
    expectNames(text, [renderPersonaRef(personaOf(h, p).name, p), describeAgentDirectorFailure(err)])
  })
})

// ===========================================================================
// b.jg5 SRJ-702, SRJ-704, SRJ-1013 (AC 64): a launch or recovery attempt's
// kill whose tries SRJ-702's stop rule stopped between tries
//
// P's launch meets its own row read live in another directory and starts P's
// live-row sequence (`scriptLiveRowElsewhere`, `launchThroughSequence`), whose
// step-1 kill answers the scripted error at its first try; the stop comes as
// that try returns. Every expected line and entry is built by the harness's
// builders over `src/`'s (`killFailureStoppedRetryText`).
// ===========================================================================

describe('b.jg5 SRJ-702, SRJ-704, SRJ-1013 (AC 64): a stopped kill retry posts nothing and raises neither version', () => {
  let harness: RecoveryHarness | undefined

  afterEach(() => {
    const h = harness
    harness = undefined
    if (h === undefined) return
    try {
      assertNoLeak(h.captured())
    } finally {
      h.cleanup()
    }
  })

  /** A survivor-naming `ErrTmuxKillFailed` whose description carries the sentinel. */
  const survivorFailure = (): Error => errTmuxKillFailed(sentinelInMessage('stopped-survivor'), 'pane-process-survived')

  /** Run `stop` as P's first kill try returns. */
  function stopAtFirstKill(h: RecoveryHarness, stop: () => void): void {
    const kill = h.stub.client.kill.bind(h.stub.client)
    h.stub.client.kill = async (params) => {
      try {
        return await kill(params)
      } finally {
        stop()
      }
    }
  }

  /** Every closing sentence of both versions of the kill-failure alert. */
  const CLOSINGS: readonly KillFailureClosing[] = [
    KILL_FAILURE_CLOSING_DESTINATION,
    KILL_FAILURE_CLOSING_DESTINATION_LATCHED,
    KILL_FAILURE_CLOSING_CLI_TEARDOWN,
    KILL_FAILURE_CLOSING_LOG_ONLY,
  ]

  /** Fails if `text` carries either version's alert text for P (its body or any closing sentence), quoting `err` when it carries a description. */
  function expectNoAlertText(text: string, p: string, err: Error): void {
    const described = killFailedDescriptionOf(err) !== undefined
    const contents: KillFailureAlertContent[] = described ? [ordinaryAlertContent(p, { last: err }), survivorAlertContent(p, err)] : [ordinaryAlertContent(p)]
    for (const content of contents) {
      for (const closing of CLOSINGS) {
        expect(text).not.toContain(killFailureAlertText(content, closing, false))
        expect(text).not.toContain(killFailureClosingSentence(content.version, closing))
      }
    }
  }

  /** No post, no alert episode and no persona-kill-survivor or persona-teardown-notice entry: nothing reached Slack. */
  function expectNothingPosted(h: RecoveryHarness, p: string): void {
    expect([h.episodeNotices, h.notices, h.outageNotices]).toEqual([[], [], []])
    for (const key of h.keys) expect(h.slack(key).callLog).toEqual([])
    expect(h.killFailureOpen(p)).toBe(false)
  }

  test.each<[string, () => Error, (err: Error) => { last?: Error }]>([
    ['a survivor-naming ErrTmuxKillFailed: the entry quotes it', survivorFailure, (err) => ({ last: err })],
    ['ErrTmuxUnresponsive, with no survivor-naming failure (a `none` decision): the entry names no description', () => errTmuxUnresponsive('kill'), () => ({})],
  ])(
    'P removed from the applied configuration as its first try returned %s; no further kill, one stop line, and one persona-kill-failed entry holding that line\'s content, with no alert text; never persona-teardown-notice',
    async (_label, make, quoted) => {
      const h = (harness = makeRecoveryHarness())
      const p = h.keys[0]!
      const err = make()
      scriptLiveRowElsewhere(h, p, { killError: err })
      stopAtFirstKill(h, () => h.remove(p))

      expect(await launchThroughSequence(h, p)).toMatchObject({ kind: LIVE_ROW_OUTCOME_STOPPED })

      expect(h.stub.calls.killCalls).toHaveLength(1)
      const entries: StartupEntry[] = readStartupEntries(h.stateDir)
      expect(entries).toEqual([{ classLabel: PERSONA_KILL_FAILED_LABEL, text: killFailureStoppedEntry(p, PERSONA_KILL_STOP_CAUSE_NOT_UP, quoted(err)) }])
      expectNoAlertText(entries[0]!.text, p, err)
      expect(killFailureLines(h, p)).toEqual([killFailureNotRaisedLine(p, PERSONA_KILL_STOP_CAUSE_NOT_UP, quoted(err)), killFailureStoppedEntryLine(p)])
      expectNothingPosted(h, p)
    },
  )

  test.each<[string, (h: RecoveryHarness, p: string) => void, string]>([
    ['its teardown', (h, p) => h.teardown(p), liveRowStopCauseText(LIVE_ROW_STOP_TEARDOWN)],
    ['its stopping being up', (h, p) => h.setUp(p, false), PERSONA_KILL_STOP_CAUSE_NOT_UP],
    ['a server shutdown', (h) => h.shutdown(), liveRowStopCauseText(LIVE_ROW_STOP_SHUTDOWN)],
  ])(
    'configured P\'s tries stopped by %s as a survivor-naming ErrTmuxKillFailed returned: one line quoting that description and naming the stop\'s cause; no startup-errors entry of any class',
    async (_label, stop, cause) => {
      const h = (harness = makeRecoveryHarness())
      const p = h.keys[0]!
      const err = survivorFailure()
      scriptLiveRowElsewhere(h, p, { killError: err })
      stopAtFirstKill(h, () => stop(h, p))

      expect(await launchThroughSequence(h, p)).toMatchObject({ kind: LIVE_ROW_OUTCOME_STOPPED })

      expect(h.stub.calls.killCalls).toHaveLength(1)
      expect(readStartupEntries(h.stateDir)).toEqual([])
      const line = killFailureNotRaisedLine(p, cause, { last: err })
      expect(killFailureLines(h, p)).toEqual([line])
      expectNothingPosted(h, p)
    },
  )
})
