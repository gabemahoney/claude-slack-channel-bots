/**
 * cli-teardown.test.ts — The pure pieces of the CLI's teardown commands
 * (`src/cli-teardown.ts`; b.jg5 SRJ-901, SRJ-117's CLI-precheck column,
 * SRJ-903, SRJ-316): the precheck's verdict over one `get` or `read-pane`
 * answer, its two operator line builders, its tries and spacing, and the
 * config-file display name; the teardown's pause verdict over one `pause`
 * answer, its state-read verdict over one `status` answer and its
 * per-persona outcome; the kill's mapping from the bounded retry's result to
 * that outcome with its kill-failure alert decision, and its read between
 * tries (b.jg5 SRJ-904, SRJ-702, SRJ-907); the teardown's report: each
 * persona's failure line, the last line and the per-persona report plan
 * (lines printed, `server.log` lines and at most one startup-errors entry,
 * whose `cli-teardown-failed` message is the failure line; b.jg5 SRJ-907,
 * SRJ-909, SRJ-1013); `clean_restart`'s not-restarted alert and its class,
 * its answer check's line and its restart lines (SRJ-906, SRJ-1013); both
 * commands' initialization-failed line (SRJ-901 step 1); and the bounds of
 * the precheck's and the teardown's cost (SRJ-908). The precheck
 * runner, the teardown's tries, poll and kill on the CLI's injected clock,
 * both commands' order, where each report line goes, and `clean_restart`'s
 * answer check and the routes of its not-restarted alert are
 * tests/cli.test.ts's.
 *
 * Every agent-director error is built with the stub's builders, each error of a
 * class the client declares by that class's builder (never `errGeneric`, which
 * the classifier reads as UNCLASSIFIED, save the look-alike rows that pin
 * exactly that); class labels, finished and live
 * states, notes and launch starts are imported. The
 * SRD's numbers (3 tries, 2 s apart), the config file's name and one line of
 * each builder are pinned once as literals, the forms SRJ-901 and SRJ-907
 * state. The kill-failure alert's text and closing sentences come from
 * `src/kill-failure-alert.ts`'s builders.
 *
 * Each kill outcome is the checked kill's under `TEARDOWN_KILL_OPTIONS`, as the
 * CLI's kill makes it; the GONE cases, the alert decision after a
 * survivor-naming try and the CONFIG reads between tries run the CLI's own
 * retry (`runKillRetry` of `checkedKill` under `TEARDOWN_KILL_RETRY_OPTIONS`)
 * on a fake clock, so the result mapped is the one the CLI gets.
 *
 * Pure: no client, no process, no real timer, no file, no top-level
 * mock.module().
 *
 * SPDX-License-Identifier: MIT
 */

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  AD_ERROR_CLASS_CONFIG,
  AD_ERROR_CLASS_CONFLICT,
  AD_ERROR_CLASS_DIRECTORY,
  AD_ERROR_CLASS_ENVIRONMENT,
  AD_ERROR_CLASS_GONE,
  AD_ERROR_CLASS_LAUNCH_FAILURE,
  AD_ERROR_CLASS_STATE,
  AD_ERROR_CLASS_UNAVAILABLE,
  AD_ERROR_CLASS_UNCLASSIFIED,
  AD_ERROR_CLASS_UNUSABLE_NAME,
  classifyAdError,
  describeAgentDirectorFailure,
  describeReportedAdFailure,
  type AdErrorClass,
} from '../src/ad-error-class.ts'
import { AD_SETTINGS_RELATIVE_PATH } from '../src/ad-settings.ts'
import {
  ERR_SCHEMA_MIGRATION_REQUIRED_NAME,
  ERR_SCHEMA_MISMATCH_NAME,
  ERR_SPAWN_NOT_FOUND_NAME,
  ERR_STORE_OPEN_NAME,
  STORE_OPEN_ERR_NAMES,
} from '../src/agent-director-errors.ts'
import {
  AD_CONFIG_FILE_DISPLAY_NAME,
  CLEAN_RESTART_NOT_RESTARTED_LABEL,
  CLEAN_RESTART_NOT_STARTED_SENTENCE,
  CLI_COMMAND_CLEAN_RESTART,
  CLI_COMMAND_STOP_BOTS,
  CLI_TEARDOWN_FAILED_LABEL,
  PRECHECK_CALL_GET,
  PRECHECK_CALL_READ_PANE,
  PRECHECK_TRIES,
  PRECHECK_TRY_SPACING_MS,
  PRECHECK_VERDICT_FAIL,
  PRECHECK_VERDICT_FAIL_AT_ONCE,
  PRECHECK_VERDICT_PASS,
  PRECHECK_VERDICT_RETRY,
  PRECHECK_VERDICT_SKIP,
  PAUSE_VERDICT_DONE,
  PAUSE_VERDICT_ESCALATE,
  PAUSE_VERDICT_FAIL,
  PAUSE_VERDICT_RETRY,
  STATE_READ_VERDICT_ABSENT,
  STATE_READ_VERDICT_FAIL,
  STATE_READ_VERDICT_FINISHED,
  STATE_READ_VERDICT_LIVE,
  TEARDOWN_KILL_OPTIONS,
  TEARDOWN_KILL_RETRY_OPTIONS,
  TEARDOWN_OUTCOME_FAILED,
  TEARDOWN_OUTCOME_STOPPED,
  TEARDOWN_STEP_KILL,
  TEARDOWN_STEP_PAUSE,
  TEARDOWN_STEP_POLL,
  TEARDOWN_STEP_STATE_READ,
  TEARDOWN_STEP_UNEXPECTED,
  TEARDOWN_STOPPED_ALREADY_FINISHED,
  TEARDOWN_STOPPED_EXITED,
  TEARDOWN_STOPPED_KILLED,
  TEARDOWN_STOPPED_NO_ROW,
  agentDirectorInitFailedLine,
  answerCheckFailedTryLine,
  cleanRestartNotRestartedAlert,
  cleanRestartStartFailedLine,
  cleanRestartStartingAfterFailedTeardownLine,
  exitTimeoutMsOf,
  onlyServerStoppedLine,
  pauseVerdictAfterLastTry,
  pauseVerdictOf,
  personaTeardownReportOf,
  precheckBoundMs,
  precheckFailureLine,
  precheckNothingStoppedLine,
  precheckVerdictOf,
  stateReadVerdictOf,
  teardownBoundMs,
  teardownErrorReportOf,
  teardownFailed,
  teardownFailureLine,
  teardownKillOutcomeOf,
  teardownKillReadOf,
  teardownNotStoppedLine,
  teardownRejectedOutcomeOf,
  teardownStopped,
  type CleanRestartFailedPersona,
  type CliTeardownCommand,
  type CliTeardownPersona,
  type PauseVerdict,
  type PersonaTeardownOutcome,
  type PrecheckCall,
  type PrecheckRow,
  type PrecheckVerdict,
  type StateReadAnswer,
  type StateReadVerdict,
  type TeardownErrorReport,
  type TeardownKillReport,
  type TeardownStoppedReason,
} from '../src/cli-teardown.ts'
import {
  KILL_OUTCOME_NOT_KILLED,
  KILL_OUTCOME_ROW_FINISHED,
  KILL_OUTCOME_ROW_GONE,
  KILL_OUTCOME_SESSION_GONE,
  KILL_ROW_FINISHED_ENDED,
  KILL_ROW_FINISHED_MISSING,
  KILL_ROW_FINISHED_NO_ROW,
  checkedKill,
  killOutcomeOf,
  type AnyKillOutcome,
} from '../src/checked-kill.ts'
import {
  DEFAULT_AGENT_DIRECTOR_CALL_TIMEOUT_MS,
  MAX_AGENT_DIRECTOR_CALL_TIMEOUT_MS,
  MIN_AGENT_DIRECTOR_CALL_TIMEOUT_MS,
} from '../src/config.ts'
import {
  KILL_RETRY_ALERT_NONE,
  KILL_RETRY_ALERT_ORDINARY,
  KILL_RETRY_ALERT_SURVIVOR,
  KILL_RETRY_END_EXHAUSTED,
  KILL_RETRY_END_READ_CONFIG,
  KILL_RETRY_END_ROW_FINISHED,
  KILL_RETRY_END_SETTLED,
  KILL_RETRY_READ_FAILED,
  KILL_RETRY_READ_NO_ROW,
  KILL_RETRY_READ_STATE,
  KILL_RETRY_SPACING_MS,
  KILL_RETRY_TRIES,
  killRetrySeedOfState,
  runKillRetry,
  type KillRetryAlert,
  type KillRetryEnd,
  type KillRetryResult,
} from '../src/kill-retry.ts'
import {
  KILL_FAILURE_ORDINARY_CLI_TEARDOWN_CLOSING,
  KILL_FAILURE_SURVIVOR_CLI_TEARDOWN_CLOSING,
  KILL_FAILURE_VERSION_ORDINARY,
  KILL_FAILURE_VERSION_SURVIVOR,
  PERSONA_KILL_FAILED_LABEL,
  PERSONA_KILL_SURVIVOR_LABEL,
  type KillFailureOrdinaryQuotes,
} from '../src/kill-failure-alert.ts'
import { AGENT_DIRECTOR_DEAD_STATES, AGENT_DIRECTOR_LIVE_STATES, AGENT_DIRECTOR_PENDING_STATE } from '../src/liveness-reading.ts'
import { personaInstanceId, personaKey, personaTmuxSessionName, renderPersonaRef } from '../src/persona-identity.ts'
import {
  CONFLICT_CASES,
  KILL_FAILED_DESCRIPTIONS,
  SAMPLE_LAUNCH_START_DEFAULT,
  SAMPLE_LAUNCH_START_NONE,
  STUB_INSTANCE_ID,
  STUB_SURVIVOR_PIDS,
  STUB_TMUX_SOCKET_PATH,
  UNAVAILABLE_FORMS,
  UNUSABLE_NAME_FAULTS,
  cannedKillResult,
  cannedStatusResult,
  errCallTimeout,
  errConfigMalformed,
  errCwdNotFound,
  errGeneric,
  errInternal,
  errPauseTimeout,
  errRelayModeOff,
  errSchemaMismatch,
  errSpawnNotFound,
  errSpawnNotInteractive,
  errSpawnNotPausable,
  errSystemInstallDisappeared,
  errTmuxCaptureFailed,
  errTmuxKillFailed,
  errTmuxSendKeys,
  errTmuxNotAvailable,
  errTmuxNotAvailableDifferentServer,
  errTmuxSessionConflict,
  errTmuxSessionCreate,
  errTmuxUnresponsive,
  errUnknownErrorName,
  errUnusableName,
  nonLatchingNotes,
  provenanceNote,
  unknownNote,
} from './test-helpers/agent-director-stub.ts'
import { assertNoLeak, BOT_TOKEN_PREFIX, fakeToken, REDACTED_SENTINEL_TAIL, sentinelInMessage } from './test-helpers/credentials.ts'
import { UNKNOWN_STATE, cliAlertLine, teardownKillFailedDescription } from './test-helpers/cli-teardown.ts'
import { createFakeClock } from './test-helpers/fake-clock.ts'
import { forbiddenServerLoads, importedSpecifiers, stripComments } from './test-helpers/source-audit.ts'

const SOURCE = join(import.meta.dir, '..', 'src', 'cli-teardown.ts')

/** The verdict kinds that carry a failure. */
type FailureKind = typeof PRECHECK_VERDICT_RETRY | typeof PRECHECK_VERDICT_FAIL | typeof PRECHECK_VERDICT_FAIL_AT_ONCE

/** One thrown value: its label, its builder, the verdict kind and the class the failure is reported under. */
type ErrorRow = readonly [label: string, make: () => unknown, kind: FailureKind | typeof PRECHECK_VERDICT_PASS | typeof PRECHECK_VERDICT_SKIP, shown: AdErrorClass | null]

const failOf = (verdict: PrecheckVerdict): { errorClass: AdErrorClass; description: string } => {
  if (!('errorClass' in verdict)) throw new Error(`verdict ${verdict.kind} carries no failure`)
  return verdict
}

/**
 * The classes SRJ-117's CLI-precheck column and its notes fail on, common to
 * both calls: CONFLICT, ENVIRONMENT, UNUSABLE NAME and UNCLASSIFIED fail with
 * no retry; UNAVAILABLE is retried; CONFIG fails at once.
 */
function failingRows(verb: PrecheckCall): ErrorRow[] {
  return [
    ...UNAVAILABLE_FORMS.map(([label, make]): ErrorRow => [`${label} (UNAVAILABLE)`, () => make(verb), PRECHECK_VERDICT_RETRY, AD_ERROR_CLASS_UNAVAILABLE]),
    ['ErrConfigMalformed (CONFIG)', () => errConfigMalformed(), PRECHECK_VERDICT_FAIL_AT_ONCE, AD_ERROR_CLASS_CONFIG],
    ...CONFLICT_CASES.map((c): ErrorRow => [`ErrTmuxSessionConflict, ${c} (CONFLICT)`, () => errTmuxSessionConflict(verb, c), PRECHECK_VERDICT_FAIL, AD_ERROR_CLASS_CONFLICT]),
    ...UNUSABLE_NAME_FAULTS.map((f): ErrorRow => [`the unusable-name ErrInternal, ${f} (UNUSABLE NAME)`, () => errUnusableName(f), PRECHECK_VERDICT_FAIL, AD_ERROR_CLASS_UNUSABLE_NAME]),
    ['ErrTmuxNotAvailable, tmux not runnable (ENVIRONMENT)', () => errTmuxNotAvailable(undefined, verb), PRECHECK_VERDICT_FAIL, AD_ERROR_CLASS_ENVIRONMENT],
    ['ErrTmuxNotAvailable, socket not accessible (ENVIRONMENT)', () => errTmuxNotAvailable(STUB_TMUX_SOCKET_PATH, verb), PRECHECK_VERDICT_FAIL, AD_ERROR_CLASS_ENVIRONMENT],
    ['ErrTmuxNotAvailable, a different tmux server (ENVIRONMENT)', () => errTmuxNotAvailableDifferentServer(STUB_TMUX_SOCKET_PATH, verb), PRECHECK_VERDICT_FAIL, AD_ERROR_CLASS_ENVIRONMENT],
    ['a plain ErrInternal (UNCLASSIFIED)', () => errInternal(), PRECHECK_VERDICT_FAIL, AD_ERROR_CLASS_UNCLASSIFIED],
    ['a plain ErrInternal whose description carries fake tokens (UNCLASSIFIED)', () => errInternal(`the store could not be read (${sentinelInMessage('internal')})`), PRECHECK_VERDICT_FAIL, AD_ERROR_CLASS_UNCLASSIFIED],
    ['ErrSchemaMismatch (UNCLASSIFIED)', () => errSchemaMismatch(), PRECHECK_VERDICT_FAIL, AD_ERROR_CLASS_UNCLASSIFIED],
    ...[ERR_SCHEMA_MIGRATION_REQUIRED_NAME, ERR_STORE_OPEN_NAME].map((name): ErrorRow => [`${name} (UNCLASSIFIED)`, () => errUnknownErrorName(name), PRECHECK_VERDICT_FAIL, AD_ERROR_CLASS_UNCLASSIFIED]),
    ['ErrSystemInstallDisappeared (UNCLASSIFIED)', () => errSystemInstallDisappeared(verb), PRECHECK_VERDICT_FAIL, AD_ERROR_CLASS_UNCLASSIFIED],
    ['ErrSpawnNotInteractive, a STATE name other than ErrSpawnNotFound', () => errSpawnNotInteractive(verb), PRECHECK_VERDICT_FAIL, AD_ERROR_CLASS_UNCLASSIFIED],
    ['ErrTmuxSessionCreate (LAUNCH FAILURE)', () => errTmuxSessionCreate(verb), PRECHECK_VERDICT_FAIL, AD_ERROR_CLASS_UNCLASSIFIED],
    ['ErrCwdNotFound (DIRECTORY)', () => errCwdNotFound(verb), PRECHECK_VERDICT_FAIL, AD_ERROR_CLASS_UNCLASSIFIED],
    ['ErrRelayModeOff, a name CSCB gives no handling', () => errRelayModeOff(), PRECHECK_VERDICT_FAIL, AD_ERROR_CLASS_UNCLASSIFIED],
  ]
}

/** SRJ-117's CLI-precheck column at `read-pane`: GONE and `ErrSpawnNotFound` (its GONE column) pass. */
const READ_PANE_ERROR_ROWS: readonly ErrorRow[] = [
  ['ErrTmuxCaptureFailed (GONE)', () => errTmuxCaptureFailed(), PRECHECK_VERDICT_PASS, null],
  ['ErrSpawnNotFound (the GONE column)', () => errSpawnNotFound(), PRECHECK_VERDICT_PASS, null],
  ...failingRows(PRECHECK_CALL_READ_PANE),
]

/**
 * The same classes at `get`: `ErrSpawnNotFound` is no row (skipped), decided
 * by the client's class, so a base `AgentDirectorError` merely named so fails
 * as UNCLASSIFIED; GONE, which a `get` gives no meaning, fails as
 * UNCLASSIFIED with no retry.
 */
const GET_ERROR_ROWS: readonly ErrorRow[] = [
  ['ErrSpawnNotFound (no row)', () => errSpawnNotFound(), PRECHECK_VERDICT_SKIP, null],
  ['a base AgentDirectorError merely named ErrSpawnNotFound (not that class: no missing row)', () => errGeneric(PRECHECK_CALL_GET, ERR_SPAWN_NOT_FOUND_NAME, 'spawn not found'), PRECHECK_VERDICT_FAIL, AD_ERROR_CLASS_UNCLASSIFIED],
  ['ErrTmuxCaptureFailed (GONE)', () => errTmuxCaptureFailed(undefined, PRECHECK_CALL_GET), PRECHECK_VERDICT_FAIL, AD_ERROR_CLASS_UNCLASSIFIED],
  ...failingRows(PRECHECK_CALL_GET),
]

/**
 * The failure's description, redacted and on one line; a CONFIG failure's
 * names the config file. b.jg5 SRJ-104: a value the classifier reports a name
 * or message for (an UNCLASSIFIED, UNUSABLE NAME or CONFIG error: the
 * `unknownName` of an `ErrUnknownErrorName`, else its `errName`, and
 * agent-director's own description, the envelope's `err_description`)
 * carries that name and message, never only the client's "unknown err_name"
 * text, since the line is where an operator reads why the persona failed.
 * Any other value is described as `describeAgentDirectorFailure` renders it.
 */
function expectDescription(description: string, value: unknown, shown: AdErrorClass): void {
  expect(description.includes('\n')).toBe(false)
  if (shown === AD_ERROR_CLASS_CONFIG) expect(description).toContain(AD_CONFIG_FILE_DISPLAY_NAME)
  const { reportedName, message } = classifyAdError(value)
  if (reportedName !== undefined || message !== undefined) {
    if (reportedName !== undefined) expect(description).toContain(reportedName)
    if (message !== undefined) expect(description).toContain(message)
  } else if (shown === AD_ERROR_CLASS_CONFIG) {
    expect(description.endsWith(describeAgentDirectorFailure(value))).toBe(true)
  } else {
    expect(description).toBe(describeAgentDirectorFailure(value))
  }
}

describe('precheckVerdictOf: a get that answered (b.jg5 SRJ-901 step 2)', () => {
  test.each<[string, PrecheckRow | null]>([
    ['no row', null],
    ...[...AGENT_DIRECTOR_DEAD_STATES].map((state): [string, PrecheckRow] => [`a finished row (${state})`, { state }]),
    ...[...AGENT_DIRECTOR_DEAD_STATES].map((state): [string, PrecheckRow] => [`a finished row (${state}) carrying ${provenanceNote}`, { state, liveness_note: provenanceNote }]),
  ])('%s is skipped: no read-pane follows', (_label, row) => {
    expect(precheckVerdictOf({ call: PRECHECK_CALL_GET, row })).toEqual({ kind: PRECHECK_VERDICT_SKIP })
  })

  test.each<[string, PrecheckRow]>([
    ...[...AGENT_DIRECTOR_LIVE_STATES].map((state): [string, PrecheckRow] => [`a ${state} row`, { state }]),
    ['a row in a state CSCB does not know', { state: UNKNOWN_STATE }],
    // b.jg5 SRJ-114, SRJ-901 step 5: a note alone fails nothing; the read-pane decides.
    [`a waiting row carrying ${provenanceNote}`, { state: 'waiting', liveness_note: provenanceNote }],
    ...nonLatchingNotes.map((note): [string, PrecheckRow] => [`a waiting row carrying ${note}`, { state: 'waiting', liveness_note: note }]),
    [`a waiting row carrying a note CSCB does not know (${unknownNote})`, { state: 'waiting', liveness_note: unknownNote }],
    // b.jg5 SRJ-513 latches only in the server; the precheck reads the pane.
    ['a pending row with no launch start', { state: AGENT_DIRECTOR_PENDING_STATE }],
    ['a pending row with a launch start, carrying the note', { state: AGENT_DIRECTOR_PENDING_STATE, launch_started_at: SAMPLE_LAUNCH_START_DEFAULT, liveness_note: provenanceNote }],
  ])('%s is live: it passes the get, and the one-line read-pane follows', (_label, row) => {
    expect(precheckVerdictOf({ call: PRECHECK_CALL_GET, row })).toEqual({ kind: PRECHECK_VERDICT_PASS })
  })
})

describe('precheckVerdictOf: a read-pane that answered a pane passes (b.jg5 SRJ-117, SRJ-613)', () => {
  test.each(['> ', ''])('the pane %p passes (and proves nothing; the teardown is the backstop)', (pane) => {
    expect(precheckVerdictOf({ call: PRECHECK_CALL_READ_PANE, pane })).toEqual({ kind: PRECHECK_VERDICT_PASS })
  })
})

describe.each<[PrecheckCall, readonly ErrorRow[]]>([
  [PRECHECK_CALL_READ_PANE, READ_PANE_ERROR_ROWS],
  [PRECHECK_CALL_GET, GET_ERROR_ROWS],
])('precheckVerdictOf: a %s that threw (SRJ-117\'s CLI-precheck column; SRJ-901 steps 2 to 4)', (call, rows) => {
  test.each(rows)('%s → its verdict, the class it is reported under and its redacted one-line description', (_label, make, kind, shown) => {
    const value = make()
    const verdict = precheckVerdictOf({ call, error: value })
    expect(verdict.kind).toBe(kind)
    if (kind === PRECHECK_VERDICT_PASS || kind === PRECHECK_VERDICT_SKIP) {
      expect(verdict).toEqual({ kind })
      return
    }
    const failure = failOf(verdict)
    expect(failure.errorClass).toBe(shown!)
    expectDescription(failure.description, value, shown!)
    assertNoLeak(failure.description)
  })

  test('the rows reach every verdict kind the call has', () => {
    const kinds = new Set<string>(rows.map(([, , kind]) => kind))
    const expected = call === PRECHECK_CALL_GET
      ? [PRECHECK_VERDICT_SKIP, PRECHECK_VERDICT_RETRY, PRECHECK_VERDICT_FAIL, PRECHECK_VERDICT_FAIL_AT_ONCE]
      : [PRECHECK_VERDICT_PASS, PRECHECK_VERDICT_RETRY, PRECHECK_VERDICT_FAIL, PRECHECK_VERDICT_FAIL_AT_ONCE]
    expect(kinds).toEqual(new Set(expected))
  })
})

describe('precheck failure lines (b.jg5 SRJ-901)', () => {
  const PERSONA = { name: 'Ops Bot', key: 'ops_bot' } as const

  test('SRJ-901\'s two forms, exactly (pinned once): the persona line and the closing line, with no [slack] prefix', () => {
    expect(precheckFailureLine(CLI_COMMAND_STOP_BOTS, PERSONA, { errorClass: AD_ERROR_CLASS_CONFLICT, description: 'what agent-director said' })).toBe(
      'stop --stop-bots: precheck failed for persona "Ops Bot" (key=ops_bot), session "slack_bot_ops_bot": CONFLICT: what agent-director said',
    )
    expect(precheckFailureLine(CLI_COMMAND_CLEAN_RESTART, PERSONA, { errorClass: AD_ERROR_CLASS_UNAVAILABLE, description: 'd' })).toBe(
      'clean_restart: precheck failed for persona "Ops Bot" (key=ops_bot), session "slack_bot_ops_bot": UNAVAILABLE: d',
    )
    expect(precheckNothingStoppedLine(CLI_COMMAND_STOP_BOTS)).toBe('stop --stop-bots: nothing was stopped')
    expect(precheckNothingStoppedLine(CLI_COMMAND_CLEAN_RESTART)).toBe('clean_restart: nothing was stopped')
  })

  test('SRJ-902\'s too-old closing line, exactly (pinned once), with no [slack] prefix', () => {
    expect(onlyServerStoppedLine()).toBe('stop --stop-bots: only the server was stopped; every worker and row was left as it is')
  })

  test('the initialization-failed line of each command, exactly (pinned once), with the [slack] prefix and the description as given', () => {
    expect(agentDirectorInitFailedLine(CLI_COMMAND_STOP_BOTS, 'what the gate said')).toBe(
      '[slack] stop --stop-bots: agent-director initialization failed: what the gate said',
    )
    expect(agentDirectorInitFailedLine(CLI_COMMAND_CLEAN_RESTART, 'd')).toBe('[slack] clean_restart: agent-director initialization failed: d')
  })

  test('the tries, their spacing and the config file\'s display name are SRJ-901\'s (pinned once): 3 tries 2 s apart, ~/.agent-director/config.toml, built from the settings path', () => {
    expect([PRECHECK_TRIES, PRECHECK_TRY_SPACING_MS]).toEqual([3, 2_000])
    expect(AD_CONFIG_FILE_DISPLAY_NAME).toBe('~/.agent-director/config.toml')
    expect(AD_CONFIG_FILE_DISPLAY_NAME).toBe(join('~', AD_SETTINGS_RELATIVE_PATH))
  })

  test('a CONFIG failure\'s line names the config file; a CONFLICT and an UNCLASSIFIED description carrying fake tokens render redacted on one line', () => {
    const lines = [
      errConfigMalformed(),
      errTmuxSessionConflict(PRECHECK_CALL_READ_PANE, 'unrecognised', sentinelInMessage('conflict')),
      errGeneric(PRECHECK_CALL_READ_PANE, 'ErrNoHandlingInCscb', `refused (${sentinelInMessage('unclassified')})`),
    ].map((value) => precheckFailureLine(CLI_COMMAND_CLEAN_RESTART, PERSONA, failOf(precheckVerdictOf({ call: PRECHECK_CALL_READ_PANE, error: value }))))

    expect(lines[0]).toContain(`: ${AD_ERROR_CLASS_CONFIG}: `)
    expect(lines[0]).toContain(AD_CONFIG_FILE_DISPLAY_NAME)
    expect(lines[1]).toContain(`: ${AD_ERROR_CLASS_CONFLICT}: `)
    expect(lines[2]).toContain(`: ${AD_ERROR_CLASS_UNCLASSIFIED}: `)
    for (const line of lines.slice(1)) expect(line).toContain(REDACTED_SENTINEL_TAIL)
    for (const line of lines) expect(line.includes('\n')).toBe(false)
    assertNoLeak(lines)
  })
})

// ---------------------------------------------------------------------------
// The teardown (b.jg5 SRJ-903, SRJ-119, SRJ-316; hatch note E12)
// ---------------------------------------------------------------------------

/** The verb of every `pause` answer below. */
const PAUSE_VERB = 'pause'
/** The verb of every `status` answer below. */
const STATUS_VERB = 'status'

/**
 * A teardown failure's report: the classifier's class, unchanged; the
 * description `describeReportedAdFailure` renders (SRJ-104), redacted and on
 * one line; a CONFIG failure's description led by the config file's name
 * (SRJ-316).
 */
function expectTeardownReport(report: TeardownErrorReport, value: unknown, errorClass: AdErrorClass): void {
  expect(report.errorClass).toBe(errorClass)
  expect(report.errorClass).toBe(classifyAdError(value).errorClass)
  expect(report.description.includes('\n')).toBe(false)
  const reported = describeReportedAdFailure(value)
  if (errorClass === AD_ERROR_CLASS_CONFIG) {
    expect(report.description).toContain(AD_CONFIG_FILE_DISPLAY_NAME)
    expect(report.description.endsWith(reported)).toBe(true)
  } else {
    expect(report.description).toBe(reported)
  }
  assertNoLeak(report.description)
}

/** One `pause` answer that threw: its label, its builder, the verdict kind and the class the classifier gives it. */
type PauseRow = readonly [label: string, make: () => unknown, kind: PauseVerdict['kind'], errorClass: AdErrorClass]

/**
 * SRJ-903's table, one row per answer: GONE escalates; UNAVAILABLE retries;
 * CONFLICT, ENVIRONMENT, UNUSABLE NAME and another `ErrInternal` fail at
 * once; CONFIG fails at once naming the config file; `ErrSpawnNotPausable`
 * on a `pending` row, `ErrSpawnNotFound`, `ErrPauseTimeout`, the three store
 * names and every other answer escalate to the kill (hatch A3).
 */
const PAUSE_ERROR_ROWS: readonly PauseRow[] = [
  ['ErrTmuxSendKeys (GONE)', () => errTmuxSendKeys(), PAUSE_VERDICT_ESCALATE, AD_ERROR_CLASS_GONE],
  ...UNAVAILABLE_FORMS.map(([label, make]): PauseRow => [`${label} (UNAVAILABLE)`, () => make(PAUSE_VERB), PAUSE_VERDICT_RETRY, AD_ERROR_CLASS_UNAVAILABLE]),
  ...CONFLICT_CASES.map((c): PauseRow => [`ErrTmuxSessionConflict, ${c} (CONFLICT)`, () => errTmuxSessionConflict(PAUSE_VERB, c), PAUSE_VERDICT_FAIL, AD_ERROR_CLASS_CONFLICT]),
  ['ErrTmuxNotAvailable, tmux not runnable (ENVIRONMENT)', () => errTmuxNotAvailable(undefined, PAUSE_VERB), PAUSE_VERDICT_FAIL, AD_ERROR_CLASS_ENVIRONMENT],
  ['ErrTmuxNotAvailable, socket not accessible (ENVIRONMENT)', () => errTmuxNotAvailable(STUB_TMUX_SOCKET_PATH, PAUSE_VERB), PAUSE_VERDICT_FAIL, AD_ERROR_CLASS_ENVIRONMENT],
  ['ErrTmuxNotAvailable, a different tmux server (ENVIRONMENT)', () => errTmuxNotAvailableDifferentServer(STUB_TMUX_SOCKET_PATH, PAUSE_VERB), PAUSE_VERDICT_FAIL, AD_ERROR_CLASS_ENVIRONMENT],
  ...UNUSABLE_NAME_FAULTS.map((f): PauseRow => [`the unusable-name ErrInternal, ${f} (UNUSABLE NAME)`, () => errUnusableName(f), PAUSE_VERDICT_FAIL, AD_ERROR_CLASS_UNUSABLE_NAME]),
  ['a plain ErrInternal (another ErrInternal)', () => errInternal(), PAUSE_VERDICT_FAIL, AD_ERROR_CLASS_UNCLASSIFIED],
  ['a plain ErrInternal whose description carries fake tokens', () => errInternal(`the store could not be read (${sentinelInMessage('pause-internal')})`), PAUSE_VERDICT_FAIL, AD_ERROR_CLASS_UNCLASSIFIED],
  ['ErrConfigMalformed (CONFIG)', () => errConfigMalformed(), PAUSE_VERDICT_FAIL, AD_ERROR_CLASS_CONFIG],
  ['ErrSpawnNotPausable, a pending row (STATE)', () => errSpawnNotPausable(PAUSE_VERB), PAUSE_VERDICT_ESCALATE, AD_ERROR_CLASS_STATE],
  ['ErrSpawnNotFound (STATE)', () => errSpawnNotFound(), PAUSE_VERDICT_ESCALATE, AD_ERROR_CLASS_STATE],
  ['ErrPauseTimeout (UNCLASSIFIED)', () => errPauseTimeout(), PAUSE_VERDICT_ESCALATE, AD_ERROR_CLASS_UNCLASSIFIED],
  [`${ERR_SCHEMA_MISMATCH_NAME} (a store name)`, () => errSchemaMismatch(), PAUSE_VERDICT_ESCALATE, AD_ERROR_CLASS_UNCLASSIFIED],
  ...STORE_OPEN_ERR_NAMES.filter((name) => name !== ERR_SCHEMA_MISMATCH_NAME)
    .map((name): PauseRow => [`${name} (a store name)`, () => errUnknownErrorName(name), PAUSE_VERDICT_ESCALATE, AD_ERROR_CLASS_UNCLASSIFIED]),
  ['ErrSystemInstallDisappeared (UNCLASSIFIED)', () => errSystemInstallDisappeared(PAUSE_VERB), PAUSE_VERDICT_ESCALATE, AD_ERROR_CLASS_UNCLASSIFIED],
  ['ErrRelayModeOff, another UNCLASSIFIED name', () => errRelayModeOff(), PAUSE_VERDICT_ESCALATE, AD_ERROR_CLASS_UNCLASSIFIED],
  ['ErrSpawnNotInteractive, another STATE name', () => errSpawnNotInteractive(PAUSE_VERB), PAUSE_VERDICT_ESCALATE, AD_ERROR_CLASS_STATE],
  ['ErrTmuxSessionCreate (LAUNCH FAILURE)', () => errTmuxSessionCreate(PAUSE_VERB), PAUSE_VERDICT_ESCALATE, AD_ERROR_CLASS_LAUNCH_FAILURE],
  ['ErrCwdNotFound (DIRECTORY)', () => errCwdNotFound(PAUSE_VERB), PAUSE_VERDICT_ESCALATE, AD_ERROR_CLASS_DIRECTORY],
]

describe('pauseVerdictOf: each pause answer by class (b.jg5 SRJ-903, SRJ-119; hatch note E12)', () => {
  test('a pause that succeeded is done: the poll follows', () => {
    expect(pauseVerdictOf({ paused: true })).toEqual({ kind: PAUSE_VERDICT_DONE })
  })

  test.each(PAUSE_ERROR_ROWS)('%s → its verdict, the classifier\'s class and the reported description', (_label, make, kind, errorClass) => {
    const value = make()
    const verdict = pauseVerdictOf({ error: value })
    expect(verdict.kind).toBe(kind)
    if (verdict.kind === PAUSE_VERDICT_DONE) throw new Error('precondition: a thrown pause answer is never done')
    if (verdict.kind === PAUSE_VERDICT_FAIL) {
      expectTeardownReport(verdict, value, errorClass)
      return
    }
    expect(verdict).toEqual({ kind: verdict.kind, errorClass, description: describeReportedAdFailure(value) })
    assertNoLeak(verdict.description)
  })

  test('the rows reach every verdict kind a thrown answer has', () => {
    expect(new Set(PAUSE_ERROR_ROWS.map(([, , kind]) => kind))).toEqual(new Set([PAUSE_VERDICT_RETRY, PAUSE_VERDICT_ESCALATE, PAUSE_VERDICT_FAIL]))
  })

  test.each(PAUSE_ERROR_ROWS)('after the last try, %s: a retry escalates with its class and description; every other verdict stands', (_label, make, kind) => {
    const verdict = pauseVerdictOf({ error: make() })
    const last = pauseVerdictAfterLastTry(verdict)
    if (kind === PAUSE_VERDICT_RETRY && verdict.kind === PAUSE_VERDICT_RETRY) expect(last).toEqual({ ...verdict, kind: PAUSE_VERDICT_ESCALATE })
    else expect([kind, last]).toEqual([kind, verdict])
  })

  test('after the last try, a pause that succeeded is still done', () => {
    expect(pauseVerdictAfterLastTry(pauseVerdictOf({ paused: true }))).toEqual({ kind: PAUSE_VERDICT_DONE })
  })
})

/** One `status` answer that threw: its label, its builder and the class the read fails with (null: no row). */
type StateReadErrorRow = readonly [label: string, make: () => unknown, errorClass: AdErrorClass | null]

/**
 * The teardown's own `status` read: `ErrSpawnNotFound` is no row, decided by
 * the client's class (a base `AgentDirectorError` merely named so is
 * UNCLASSIFIED); every other answer fails at once with the classifier's
 * class, never relabelled UNCLASSIFIED as the precheck's `get` relabels.
 */
const STATE_READ_ERROR_ROWS: readonly StateReadErrorRow[] = [
  ['ErrSpawnNotFound (no row)', () => errSpawnNotFound(), null],
  ['a base AgentDirectorError merely named ErrSpawnNotFound (not that class: no missing row)', () => errGeneric(STATUS_VERB, ERR_SPAWN_NOT_FOUND_NAME, 'spawn not found'), AD_ERROR_CLASS_UNCLASSIFIED],
  ...UNAVAILABLE_FORMS.map(([label, make]): StateReadErrorRow => [`${label} (UNAVAILABLE)`, () => make(STATUS_VERB), AD_ERROR_CLASS_UNAVAILABLE]),
  ['ErrConfigMalformed (CONFIG)', () => errConfigMalformed(), AD_ERROR_CLASS_CONFIG],
  ['ErrTmuxSessionConflict (CONFLICT)', () => errTmuxSessionConflict(STATUS_VERB, 'unrecognised'), AD_ERROR_CLASS_CONFLICT],
  ['ErrTmuxNotAvailable (ENVIRONMENT)', () => errTmuxNotAvailable(undefined, STATUS_VERB), AD_ERROR_CLASS_ENVIRONMENT],
  ...UNUSABLE_NAME_FAULTS.map((f): StateReadErrorRow => [`the unusable-name ErrInternal, ${f} (UNUSABLE NAME)`, () => errUnusableName(f), AD_ERROR_CLASS_UNUSABLE_NAME]),
  ['a plain ErrInternal (UNCLASSIFIED)', () => errInternal(), AD_ERROR_CLASS_UNCLASSIFIED],
  [`${ERR_SCHEMA_MISMATCH_NAME} (UNCLASSIFIED)`, () => errSchemaMismatch(), AD_ERROR_CLASS_UNCLASSIFIED],
  ['ErrTmuxCaptureFailed (GONE, kept)', () => errTmuxCaptureFailed(undefined, STATUS_VERB), AD_ERROR_CLASS_GONE],
  ['ErrSpawnNotInteractive (STATE, kept)', () => errSpawnNotInteractive(STATUS_VERB), AD_ERROR_CLASS_STATE],
  ['ErrTmuxSessionCreate (LAUNCH FAILURE, kept)', () => errTmuxSessionCreate(STATUS_VERB), AD_ERROR_CLASS_LAUNCH_FAILURE],
  ['ErrCwdNotFound (DIRECTORY, kept)', () => errCwdNotFound(STATUS_VERB), AD_ERROR_CLASS_DIRECTORY],
]

describe('stateReadVerdictOf: the teardown\'s own status reads, before the pause and in the poll (b.jg5 SRJ-903, SRJ-316)', () => {
  test('no row (null) is absent: the persona is stopped', () => {
    expect(stateReadVerdictOf({ row: null })).toEqual({ kind: STATE_READ_VERDICT_ABSENT })
  })

  test.each([...AGENT_DIRECTOR_DEAD_STATES])('a %s row is finished: the persona is stopped', (state) => {
    expect(stateReadVerdictOf({ row: { state } })).toEqual({ kind: STATE_READ_VERDICT_FINISHED, state })
  })

  test.each([...AGENT_DIRECTOR_LIVE_STATES, AGENT_DIRECTOR_PENDING_STATE, UNKNOWN_STATE])('a %s row is live: the teardown goes on', (state) => {
    expect(stateReadVerdictOf({ row: { state } })).toEqual({ kind: STATE_READ_VERDICT_LIVE, state })
  })

  test.each(STATE_READ_ERROR_ROWS)('%s → absent, or a failure at once with the classifier\'s class and the reported description', (_label, make, errorClass) => {
    const value = make()
    const verdict: StateReadVerdict = stateReadVerdictOf({ error: value })
    if (errorClass === null) {
      expect(verdict).toEqual({ kind: STATE_READ_VERDICT_ABSENT })
      return
    }
    expect(verdict.kind).toBe(STATE_READ_VERDICT_FAIL)
    if (verdict.kind !== STATE_READ_VERDICT_FAIL) return
    expectTeardownReport(verdict, value, errorClass)
  })
})

describe('the teardown\'s per-persona outcome and its error report (b.jg5 SRJ-903, SRJ-104, SRJ-316)', () => {
  test('teardownStopped carries its reason; teardownFailed its step and the report, field by field', () => {
    for (const reason of [TEARDOWN_STOPPED_NO_ROW, TEARDOWN_STOPPED_ALREADY_FINISHED, TEARDOWN_STOPPED_EXITED, TEARDOWN_STOPPED_KILLED] as const) {
      expect(teardownStopped(reason)).toEqual({ kind: TEARDOWN_OUTCOME_STOPPED, reason })
    }
    const report = teardownErrorReportOf(errConfigMalformed())
    for (const step of [TEARDOWN_STEP_STATE_READ, TEARDOWN_STEP_PAUSE, TEARDOWN_STEP_POLL, TEARDOWN_STEP_KILL, TEARDOWN_STEP_UNEXPECTED] as const) {
      expect(teardownFailed(step, { ...report, extra: 'not copied' } as TeardownErrorReport)).toEqual({ kind: TEARDOWN_OUTCOME_FAILED, step, ...report })
    }
  })

  test('a CONFLICT, an UNCLASSIFIED and a plain ErrInternal description carrying fake tokens come out redacted on one line, at the pause (failing or escalating) and at a status read', () => {
    const values = [
      errTmuxSessionConflict(PAUSE_VERB, 'unrecognised', sentinelInMessage('teardown-conflict')),
      errGeneric(PAUSE_VERB, 'ErrNoHandlingInCscb', `refused (${sentinelInMessage('teardown-unclassified')})`),
      errInternal(`the store could not be read (${sentinelInMessage('teardown-internal')})`),
    ]
    const descriptions = values.flatMap((value) => {
      const pause = pauseVerdictOf({ error: value })
      const read = stateReadVerdictOf({ error: value })
      if (pause.kind === PAUSE_VERDICT_DONE || read.kind !== STATE_READ_VERDICT_FAIL) throw new Error('precondition: each is reported at the pause and fails the read')
      return [pause.description, read.description, teardownErrorReportOf(value).description]
    })
    for (const description of descriptions) {
      expect(description).toContain(REDACTED_SENTINEL_TAIL)
      expect(description.includes('\n')).toBe(false)
    }
    assertNoLeak(descriptions)
  })
})

describe('src/cli-teardown.ts is pure (b.jg5 SRJ-114, SRJ-115, SRJ-801, SRJ-908)', () => {
  const code = stripComments(readFileSync(SOURCE, 'utf-8'))

  test('it loads no server-only module (the session manager, the conflict latch …), no Slack module, never src/cli.ts, the retired-key record module or the settings reader (the config file\'s name comes from src/ad-config-file.ts)', () => {
    const { loads, forbidden } = forbiddenServerLoads('cli-teardown.ts')
    expect(forbidden).toEqual([])
    expect(loads.modules.has('pane-read.ts')).toBe(true) // the walk is not vacuous
    expect(loads.modules.has('ad-config-file.ts')).toBe(true)
    expect([...loads.modules.keys()].filter((name) => ['cli.ts', 'retired-keys.ts', 'ad-settings.ts'].includes(name))).toEqual([])
    expect(importedSpecifiers(code).filter((s) => !s.startsWith('./') && !s.startsWith('node:'))).toEqual([])
  })

  test('it reads no clock, arms no timer and has no instanceof of its own (it tells error classes apart only through src/ad-error-class.ts)', () => {
    for (const banned of [/\bDate\.now\b/, /\bsetTimeout\b/, /\bsetInterval\b/, /\binstanceof\b/]) {
      expect([banned.source, banned.test(code)]).toEqual([banned.source, false])
    }
  })
})

// ---------------------------------------------------------------------------
// The teardown's kill (b.jg5 SRJ-904, SRJ-702, SRJ-110, SRJ-907; hatch A3)
// ---------------------------------------------------------------------------

/** The verb of every `kill` answer below. */
const KILL_VERB = 'kill'
/** The verb of `clean_restart`'s answer check. */
const LIST_VERB = 'list'

/** A bounded retry's result: `outcome` standing at `end` after `tries` kills and `reads` status reads, with `alert`. */
const retryResult = (
  outcome: AnyKillOutcome,
  end: KillRetryEnd,
  tries: number,
  reads: number,
  alert: KillRetryAlert = { kind: KILL_RETRY_ALERT_NONE },
): KillRetryResult<AnyKillOutcome> => ({ outcome, end, tries, reads, alert })

/** The outcome a kill that threw `value` gives the CLI (the checked kill's, under the teardown's options). */
const thrownOutcome = (value: unknown): AnyKillOutcome => killOutcomeOf({ thrown: value }, TEARDOWN_KILL_OPTIONS)

/**
 * The CLI's bounded retry of the kill, as `teardownKill` (`src/cli.ts`) runs
 * it, under `TEARDOWN_KILL_RETRY_OPTIONS`, from a row last read `lastState`:
 * each try one checked kill under `TEARDOWN_KILL_OPTIONS` throwing the next
 * of `answers`, each read between tries the next of `reads` through
 * `teardownKillReadOf` (once they run out, a live `waiting` row), on a fake
 * clock moved one pending wait at a time. Answers the retry's result; its
 * lines are leak-checked (their text is tests/kill-retry.test.ts's and
 * tests/cli.test.ts's).
 */
async function cliKillRetry(
  answers: readonly unknown[],
  reads: readonly StateReadAnswer[] = [],
  lastState = 'waiting',
): Promise<KillRetryResult<AnyKillOutcome>> {
  const clock = createFakeClock()
  const queue = [...answers]
  const readQueue = [...reads]
  const lines: string[] = []
  let settled = false
  const work = runKillRetry<AnyKillOutcome>({
    ...TEARDOWN_KILL_RETRY_OPTIONS,
    instanceId: STUB_INSTANCE_ID,
    kill: () => checkedKill(STUB_INSTANCE_ID, async () => {
      if (queue.length === 0) throw new Error('precondition: a kill answer for every try')
      throw queue.shift()
    }, TEARDOWN_KILL_OPTIONS),
    read: async () => teardownKillReadOf(readQueue.shift() ?? { row: { state: 'waiting' } }),
    wait: clock,
    lastRead: killRetrySeedOfState(lastState),
    log: (line) => {
      lines.push(line)
    },
    logPrefix: '[slack] cli-teardown-test',
  })
  void work.then(() => { settled = true })
  for (let step = 0; step < KILL_RETRY_TRIES; step++) {
    await clock.flush()
    if (settled) break
    if (clock.pendingCount() === 0) throw new Error('the retry neither settled nor waits on the clock')
    await clock.runNext()
  }
  const result = await work
  expect(clock.pendingCount()).toBe(0)
  assertNoLeak(lines)
  return result
}

/** The latest survivor-naming description a retry quotes: the survivor-naming `ErrTmuxKillFailed`'s, raw. */
const survivorDescription = (): string => teardownKillFailedDescription(errTmuxKillFailed(undefined, 'pane-process-survived'))

/** Every success form a retry can end in, with how it ended and its calls. */
const SUCCESS_RESULTS: ReadonlyArray<readonly [string, () => KillRetryResult<AnyKillOutcome>]> = [
  ['a kill result with kill_sent true', () => retryResult(killOutcomeOf({ result: cannedKillResult(true) }, TEARDOWN_KILL_OPTIONS), KILL_RETRY_END_SETTLED, 1, 0)],
  ['a kill result with kill_sent false', () => retryResult(killOutcomeOf({ result: cannedKillResult(false) }, TEARDOWN_KILL_OPTIONS), KILL_RETRY_END_SETTLED, 1, 0)],
  ['a kill result with no kill_sent (a binary older than Phase 1)', () => retryResult(killOutcomeOf({ result: cannedKillResult() }, TEARDOWN_KILL_OPTIONS), KILL_RETRY_END_SETTLED, 1, 0)],
  ['ErrSpawnNotFound at a try', () => retryResult(thrownOutcome(errSpawnNotFound()), KILL_RETRY_END_SETTLED, 1, 0)],
  ...([KILL_ROW_FINISHED_ENDED, KILL_ROW_FINISHED_MISSING, KILL_ROW_FINISHED_NO_ROW] as const).map((read) =>
    [`a read between tries finding the row finished (${read})`, () => retryResult({ kind: KILL_OUTCOME_ROW_FINISHED, read }, KILL_RETRY_END_ROW_FINISHED, 1, 1)] as const),
]

/** A failure a retry can end in, with the class the CLI reports it under. */
type FailureRow = readonly [label: string, make: () => unknown, errorClass: AdErrorClass]

/** Every kill answer that is no success, after its tries: UNAVAILABLE after them, every other at once (b.jg5 SRJ-904). */
const NOT_KILLED_ROWS: readonly FailureRow[] = [
  ...UNAVAILABLE_FORMS.map(([label, make]): FailureRow => [`${label} (UNAVAILABLE, after its tries)`, () => make(KILL_VERB), AD_ERROR_CLASS_UNAVAILABLE]),
  ...CONFLICT_CASES.map((c): FailureRow => [`ErrTmuxSessionConflict, ${c} (CONFLICT)`, () => errTmuxSessionConflict(KILL_VERB, c), AD_ERROR_CLASS_CONFLICT]),
  ['ErrTmuxNotAvailable, tmux not runnable (ENVIRONMENT)', () => errTmuxNotAvailable(undefined, KILL_VERB), AD_ERROR_CLASS_ENVIRONMENT],
  ['ErrTmuxNotAvailable, socket not accessible (ENVIRONMENT)', () => errTmuxNotAvailable(STUB_TMUX_SOCKET_PATH, KILL_VERB), AD_ERROR_CLASS_ENVIRONMENT],
  ['ErrTmuxNotAvailable, a different tmux server (ENVIRONMENT)', () => errTmuxNotAvailableDifferentServer(STUB_TMUX_SOCKET_PATH, KILL_VERB), AD_ERROR_CLASS_ENVIRONMENT],
  ...UNUSABLE_NAME_FAULTS.map((f): FailureRow => [`the unusable-name ErrInternal, ${f} (UNUSABLE NAME)`, () => errUnusableName(f), AD_ERROR_CLASS_UNUSABLE_NAME]),
  ['a plain ErrInternal (UNCLASSIFIED)', () => errInternal(), AD_ERROR_CLASS_UNCLASSIFIED],
  ['a base AgentDirectorError merely named ErrSpawnNotFound at a try (not that class: no success, UNCLASSIFIED)', () => errGeneric(KILL_VERB, ERR_SPAWN_NOT_FOUND_NAME, 'row gone'), AD_ERROR_CLASS_UNCLASSIFIED],
  ['a plain ErrInternal whose description carries fake tokens (UNCLASSIFIED)', () => errInternal(`the store could not be read (${sentinelInMessage('kill-internal')})`), AD_ERROR_CLASS_UNCLASSIFIED],
  ['a CONFLICT whose description carries fake tokens', () => errTmuxSessionConflict(KILL_VERB, 'unrecognised', sentinelInMessage('kill-conflict')), AD_ERROR_CLASS_CONFLICT],
  [`${ERR_SCHEMA_MISMATCH_NAME} (a store name, UNCLASSIFIED)`, () => errSchemaMismatch(), AD_ERROR_CLASS_UNCLASSIFIED],
  ...STORE_OPEN_ERR_NAMES.filter((name) => name !== ERR_SCHEMA_MISMATCH_NAME)
    .map((name): FailureRow => [`${name} (a store name, UNCLASSIFIED)`, () => errUnknownErrorName(name), AD_ERROR_CLASS_UNCLASSIFIED]),
  ['ErrSystemInstallDisappeared (UNCLASSIFIED)', () => errSystemInstallDisappeared(KILL_VERB), AD_ERROR_CLASS_UNCLASSIFIED],
  ['ErrConfigMalformed at a try (CONFIG)', () => errConfigMalformed(), AD_ERROR_CLASS_CONFIG],
]

/** Kill answers SRJ-110 gives no row: the checked kill's UNCLASSIFIED with the classifier's class kept, which the CLI reports. */
const UNLISTED_ROWS: readonly FailureRow[] = [
  ['ErrSpawnNotInteractive, a STATE name other than ErrSpawnNotFound', () => errSpawnNotInteractive(KILL_VERB), AD_ERROR_CLASS_STATE],
  ['ErrCwdNotFound (DIRECTORY)', () => errCwdNotFound(KILL_VERB), AD_ERROR_CLASS_DIRECTORY],
  ['ErrTmuxSessionCreate (LAUNCH FAILURE)', () => errTmuxSessionCreate(KILL_VERB), AD_ERROR_CLASS_LAUNCH_FAILURE],
]

/**
 * GONE kill answers: under `TEARDOWN_KILL_OPTIONS` the checked kill's GONE
 * non-success, which the retry never tries again (b.jg5 SRJ-904, SRJ-702;
 * hatch A3). The second carries a fake token in its session name.
 */
const GONE_ROWS: readonly FailureRow[] = [
  ['ErrTmuxSendKeys', () => errTmuxSendKeys(), AD_ERROR_CLASS_GONE],
  ['ErrTmuxCaptureFailed', () => errTmuxCaptureFailed(fakeToken(BOT_TOKEN_PREFIX, 'gone-session'), KILL_VERB), AD_ERROR_CLASS_GONE],
]

/** The failed outcome's kill report, after `expectTeardownReport` checked its error report. */
function killReportOf(outcome: PersonaTeardownOutcome): TeardownKillReport {
  if (outcome.kind !== TEARDOWN_OUTCOME_FAILED || outcome.kill === undefined) throw new Error(`precondition: a failed kill outcome, got ${outcome.kind}`)
  expect(outcome.step).toBe(TEARDOWN_STEP_KILL)
  return outcome.kill
}

describe('teardownKillOutcomeOf: a success stops the persona (b.jg5 SRJ-904 bullet 1, SRJ-110)', () => {
  test.each(SUCCESS_RESULTS)('%s → stopped (killed), carrying the retry\'s result and no alert', (_label, make) => {
    const result = make()
    expect(teardownKillOutcomeOf(result) as unknown).toEqual({ kind: TEARDOWN_OUTCOME_STOPPED, reason: TEARDOWN_STOPPED_KILLED, kill: result })
  })

  test.each(SUCCESS_RESULTS)('%s after a survivor-naming ErrTmuxKillFailed → stopped, carrying the survivor decision quoting that description', (_label, make) => {
    const alert: KillRetryAlert = { kind: KILL_RETRY_ALERT_SURVIVOR, survivorDescription: survivorDescription() }
    const result = { ...make(), alert }
    expect(teardownKillOutcomeOf(result) as unknown).toEqual({ kind: TEARDOWN_OUTCOME_STOPPED, reason: TEARDOWN_STOPPED_KILLED, kill: result })
  })
})

describe('teardownKillOutcomeOf: every other answer fails the persona with its class (b.jg5 SRJ-904 bullets 2 to 4 and 6; hatch A3)', () => {
  test.each(NOT_KILLED_ROWS)('%s → failed at the kill with the classifier\'s class and the reported description; the retry\'s result is carried', (_label, make, errorClass) => {
    const value = make()
    const unavailable = errorClass === AD_ERROR_CLASS_UNAVAILABLE
    const result = retryResult(thrownOutcome(value), unavailable ? KILL_RETRY_END_EXHAUSTED : KILL_RETRY_END_SETTLED, unavailable ? KILL_RETRY_TRIES : 1, unavailable ? KILL_RETRY_TRIES - 1 : 0)
    const outcome = teardownKillOutcomeOf(result)
    expect(outcome.kind).toBe(TEARDOWN_OUTCOME_FAILED)
    if (outcome.kind !== TEARDOWN_OUTCOME_FAILED) return
    expectTeardownReport(outcome, value, errorClass)
    expect(killReportOf(outcome)).toEqual(result)
  })

  test.each(UNLISTED_ROWS)('%s → failed with its own class, never relabelled UNCLASSIFIED', (_label, make, errorClass) => {
    const value = make()
    const killOutcome = thrownOutcome(value)
    // Precondition: the checked kill reports it UNCLASSIFIED, keeping the classifier's class.
    expect(killOutcome as unknown).toEqual({ kind: KILL_OUTCOME_NOT_KILLED, errorClass: AD_ERROR_CLASS_UNCLASSIFIED, error: value, unlistedClass: errorClass })
    const outcome = teardownKillOutcomeOf(retryResult(killOutcome, KILL_RETRY_END_SETTLED, 1, 0))
    if (outcome.kind !== TEARDOWN_OUTCOME_FAILED) throw new Error('expected a failed outcome')
    expectTeardownReport(outcome, value, errorClass)
  })

  test.each(GONE_ROWS)('GONE (%s) at the first try of the CLI\'s retry (the checked kill under TEARDOWN_KILL_OPTIONS) → failed at the kill with class GONE and its reported description, after one kill, carrying the retry\'s result with no alert', async (_label, make, errorClass) => {
    const value = make()
    const result = await cliKillRetry([value])
    expect(result).toEqual(retryResult(killOutcomeOf({ thrown: value }, TEARDOWN_KILL_OPTIONS), KILL_RETRY_END_SETTLED, 1, 0))
    const outcome = teardownKillOutcomeOf(result)
    if (outcome.kind !== TEARDOWN_OUTCOME_FAILED) throw new Error('expected a failed outcome')
    expectTeardownReport(outcome, value, errorClass)
    expect(killReportOf(outcome)).toEqual(result)
  })

  // The CLI's checked kill never answers session-gone; were one to reach the mapping, it still never stops a persona.
  test('a session-gone outcome → failed with class GONE, described by its GONE name, never stopped', () => {
    const killOutcome = killOutcomeOf({ thrown: errTmuxSendKeys() })
    if (killOutcome.kind !== KILL_OUTCOME_SESSION_GONE || killOutcome.name === undefined) throw new Error('precondition: the server default\'s named session-gone outcome')
    const result = retryResult(killOutcome, KILL_RETRY_END_SETTLED, 1, 0)
    expect(teardownKillOutcomeOf(result) as unknown).toEqual({
      kind: TEARDOWN_OUTCOME_FAILED, step: TEARDOWN_STEP_KILL, errorClass: AD_ERROR_CLASS_GONE, description: killOutcome.name, kill: result,
    })
  })

  // Only the listed successes stop a persona: an outcome of a kind the mapping does not list fails it.
  test('an outcome of a kind the mapping does not list → failed at the kill as UNCLASSIFIED, never stopped', () => {
    const result = retryResult({ kind: 'a-kind-no-mapping-lists' } as unknown as AnyKillOutcome, KILL_RETRY_END_SETTLED, 1, 0)
    const outcome = teardownKillOutcomeOf(result)
    expect(outcome).toMatchObject({ kind: TEARDOWN_OUTCOME_FAILED, step: TEARDOWN_STEP_KILL, errorClass: AD_ERROR_CLASS_UNCLASSIFIED })
    expect(killReportOf(outcome)).toEqual(result)
  })
})

describe('teardownKillOutcomeOf: the alert decision after a survivor-naming try (b.jg5 SRJ-904 bullet 7, SRJ-907, SRJ-1007)', () => {
  // The CLI's retry gives the survivor version only on a success end, so a stopped persona carries it as it is.
  test.each<[string, unknown, AnyKillOutcome['kind']]>([
    ['ErrSpawnNotFound (a success)', errSpawnNotFound(), KILL_OUTCOME_ROW_GONE],
    ['a read finding the row ended', undefined, KILL_OUTCOME_ROW_FINISHED],
  ])('a survivor-naming first try, then %s in the CLI\'s retry → stopped (killed), carrying the retry\'s own survivor decision quoting that description, never the ordinary one', async (_label, second, kind) => {
    const first = errTmuxKillFailed(undefined, 'pane-process-survived')
    const result = await cliKillRetry(second === undefined ? [first] : [first, second], second === undefined ? [{ row: { state: 'ended' } }] : [])
    expect(result.outcome.kind).toBe(kind)
    expect(result.alert).toEqual({ kind: KILL_RETRY_ALERT_SURVIVOR, survivorDescription: survivorDescription() })
    expect(teardownKillOutcomeOf(result) as unknown).toEqual({ kind: TEARDOWN_OUTCOME_STOPPED, reason: TEARDOWN_STOPPED_KILLED, kill: result })
  })

  test.each(GONE_ROWS)('a survivor-naming first try, then GONE (%s) at the 2nd try of the CLI\'s retry → failed as GONE after 2 kills and 1 read, carrying the retry\'s own ordinary decision quoting the survivor-naming description, never the survivor one', async (_label, make, errorClass) => {
    const value = make()
    const result = await cliKillRetry([errTmuxKillFailed(undefined, 'pane-process-survived'), value])
    expect(result).toEqual(retryResult(
      killOutcomeOf({ thrown: value }, TEARDOWN_KILL_OPTIONS), KILL_RETRY_END_SETTLED, 2, 1,
      { kind: KILL_RETRY_ALERT_ORDINARY, earlierSurvivorDescription: survivorDescription() },
    ))
    const outcome = teardownKillOutcomeOf(result)
    if (outcome.kind !== TEARDOWN_OUTCOME_FAILED) throw new Error('expected a failed outcome')
    expectTeardownReport(outcome, value, errorClass)
    expect(killReportOf(outcome)).toEqual(result)
  })

  test.each([...UNLISTED_ROWS, ...NOT_KILLED_ROWS.filter(([, , errorClass]) => errorClass !== AD_ERROR_CLASS_UNAVAILABLE)])(
    '%s after a survivor-naming try → failed, keeping the retry\'s ordinary decision quoting that description',
    (_label, make) => {
      const value = make()
      const alert: KillRetryAlert = { kind: KILL_RETRY_ALERT_ORDINARY, earlierSurvivorDescription: survivorDescription() }
      const result = retryResult(thrownOutcome(value), KILL_RETRY_END_SETTLED, 2, 1, alert)
      expect(killReportOf(teardownKillOutcomeOf(result))).toEqual(result)
    },
  )

  test('ErrTmuxKillFailed naming no survivor after the tries, following a survivor-naming one → failed, keeping the ordinary decision quoting both descriptions', () => {
    const value = errTmuxKillFailed(undefined, 'outlived-exit-wait')
    const killOutcome = thrownOutcome(value)
    if (killOutcome.kind !== KILL_OUTCOME_NOT_KILLED || killOutcome.errorClass !== AD_ERROR_CLASS_UNAVAILABLE) throw new Error('precondition: UNAVAILABLE')
    const alert: KillRetryAlert = { kind: KILL_RETRY_ALERT_ORDINARY, lastKillFailedDescription: killOutcome.killFailedDescription, earlierSurvivorDescription: survivorDescription() }
    const result = retryResult(killOutcome, KILL_RETRY_END_EXHAUSTED, KILL_RETRY_TRIES, KILL_RETRY_TRIES - 1, alert)
    const outcome = teardownKillOutcomeOf(result)
    if (outcome.kind !== TEARDOWN_OUTCOME_FAILED) throw new Error('expected a failed outcome')
    expectTeardownReport(outcome, value, AD_ERROR_CLASS_UNAVAILABLE)
    expect(killReportOf(outcome)).toEqual(result)
  })
})

describe('teardownKillOutcomeOf: CONFIG at a status read between tries (b.jg5 SRJ-904 bullet 4, SRJ-702, SRJ-316)', () => {
  /** A CONFIG read ends the CLI's tries whatever state the row was last read in: each row's tries before it, its last read state and the retry's decision. */
  const CONFIG_READ_ROWS: ReadonlyArray<readonly [string, () => {
    readonly answers: readonly unknown[]
    readonly reads: readonly StateReadAnswer[]
    readonly lastState: string
    readonly calls: readonly [tries: number, reads: number]
    readonly alert: KillRetryAlert
  }]> = [
    ['ErrTmuxUnresponsive on a row last read waiting', () => ({
      answers: [errTmuxUnresponsive(KILL_VERB)], reads: [], lastState: 'waiting', calls: [1, 1], alert: { kind: KILL_RETRY_ALERT_NONE },
    })],
    [`ErrTmuxUnresponsive on a row last read ${AGENT_DIRECTOR_PENDING_STATE}`, () => ({
      answers: [errTmuxUnresponsive(KILL_VERB)], reads: [], lastState: AGENT_DIRECTOR_PENDING_STATE, calls: [1, 1], alert: { kind: KILL_RETRY_ALERT_NONE },
    })],
    ['the survivor-naming ErrTmuxKillFailed on a row last read waiting', () => ({
      answers: [errTmuxKillFailed(undefined, 'pane-process-survived')], reads: [], lastState: 'waiting', calls: [1, 1],
      alert: { kind: KILL_RETRY_ALERT_ORDINARY, lastKillFailedDescription: survivorDescription() },
    })],
    ['the survivor-naming ErrTmuxKillFailed, a read of waiting, then ErrCallTimeout', () => ({
      answers: [errTmuxKillFailed(undefined, 'pane-process-survived'), errCallTimeout(KILL_VERB)], reads: [{ row: { state: 'waiting' } }], lastState: 'waiting', calls: [2, 2],
      alert: { kind: KILL_RETRY_ALERT_ORDINARY, earlierSurvivorDescription: survivorDescription() },
    })],
    ['ErrTmuxUnresponsive, a read of a pending row with no launch start, then ErrTmuxUnresponsive', () => ({
      answers: [errTmuxUnresponsive(KILL_VERB), errTmuxUnresponsive(KILL_VERB)],
      reads: [{ row: cannedStatusResult({ state: AGENT_DIRECTOR_PENDING_STATE, launch_started_at: SAMPLE_LAUNCH_START_NONE }) }],
      lastState: 'waiting', calls: [2, 2], alert: { kind: KILL_RETRY_ALERT_NONE },
    })],
  ]

  test.each(CONFIG_READ_ROWS)(
    'tries of %s, then a read answering CONFIG in the CLI\'s retry: it ends the tries (read-config) keeping that read\'s error, with no further kill → failed at the kill as CONFIG naming the config file, whatever the last try; the retry\'s decision is kept',
    async (_label, make) => {
      const { answers, reads, lastState, calls, alert } = make()
      const configValue = errConfigMalformed()
      const result = await cliKillRetry(answers, [...reads, { error: configValue }], lastState)
      expect([result.end, result.tries, result.reads]).toEqual([KILL_RETRY_END_READ_CONFIG, ...calls])
      expect(result.outcome).toEqual(thrownOutcome(answers.at(-1)))
      expect(result.configRead?.error).toBe(configValue)
      expect(result.alert).toEqual(alert)
      const outcome = teardownKillOutcomeOf(result)
      if (outcome.kind !== TEARDOWN_OUTCOME_FAILED) throw new Error('expected a failed outcome')
      expectTeardownReport(outcome, configValue, AD_ERROR_CLASS_CONFIG)
      expect(killReportOf(outcome)).toEqual({ outcome: result.outcome, end: result.end, tries: result.tries, reads: result.reads, alert })
    },
  )
})

describe('teardownKillReadOf: the read between kill tries latches nothing in the CLI (b.jg5 SRJ-904 bullet 5, SRJ-702, SRJ-115)', () => {
  test('no row (null) → no row', () => {
    expect(teardownKillReadOf({ row: null })).toEqual({ kind: KILL_RETRY_READ_NO_ROW })
  })

  test.each([...AGENT_DIRECTOR_DEAD_STATES, ...AGENT_DIRECTOR_LIVE_STATES, AGENT_DIRECTOR_PENDING_STATE, UNKNOWN_STATE])('a %s row → its state', (state) => {
    expect(teardownKillReadOf({ row: { state } })).toEqual({ kind: KILL_RETRY_READ_STATE, state })
  })

  test('a pending row with no launch start → a live read of its state, never a latching read', () => {
    const row = cannedStatusResult({ state: AGENT_DIRECTOR_PENDING_STATE, launch_started_at: SAMPLE_LAUNCH_START_NONE })
    expect(row.launch_started_at).toBeUndefined() // precondition
    expect(teardownKillReadOf({ row })).toEqual({ kind: KILL_RETRY_READ_STATE, state: AGENT_DIRECTOR_PENDING_STATE })
  })

  /** Values a read can throw. */
  const READ_ERRORS: ReadonlyArray<readonly [string, () => unknown]> = [
    ['the unusable-name ErrInternal (UNUSABLE NAME)', () => errUnusableName()],
    ['ErrTmuxSessionConflict (CONFLICT)', () => errTmuxSessionConflict(STATUS_VERB, 'unrecognised')],
    ...UNAVAILABLE_FORMS.map(([label, make]) => [`${label} (UNAVAILABLE)`, () => make(STATUS_VERB)] as const),
    ['ErrSpawnNotFound', () => errSpawnNotFound()],
    ['a plain ErrInternal (UNCLASSIFIED)', () => errInternal()],
    ['ErrConfigMalformed (CONFIG)', () => errConfigMalformed()],
  ]

  test.each(READ_ERRORS)('a read that threw %s → a failed read carrying that value, never a latching read', (_label, make) => {
    const error = make()
    const read = teardownKillReadOf({ error })
    expect(read).toEqual({ kind: KILL_RETRY_READ_FAILED, error })
    if (read.kind === KILL_RETRY_READ_FAILED) expect(read.error).toBe(error)
  })
})

// ---------------------------------------------------------------------------
// The teardown's report (b.jg5 SRJ-907, SRJ-909, SRJ-1013, SRJ-1007; hatch A3)
// ---------------------------------------------------------------------------

/** Both teardown commands. */
const REPORT_COMMANDS: CliTeardownCommand[] = [CLI_COMMAND_STOP_BOTS, CLI_COMMAND_CLEAN_RESTART]

/** The persona every report below is for: its name differs from its key. */
const REPORT_PERSONA: CliTeardownPersona = { name: 'Ops Bot', key: personaKey('Ops Bot') }

/** Each row of `rows` for each command: `[command, ...row]`. */
function forEachReportCommand<R extends readonly unknown[]>(rows: ReadonlyArray<R>): Array<[CliTeardownCommand, ...R]> {
  return REPORT_COMMANDS.flatMap((command) => rows.map((row): [CliTeardownCommand, ...R] => [command, ...row]))
}

/** The ordinary version's alert line for the report persona quoting `quotes`; it ends with the ordinary CLI closing sentence. */
function ordinaryAlertLine(command: CliTeardownCommand, quotes: KillFailureOrdinaryQuotes): string {
  const line = cliAlertLine(command, REPORT_PERSONA, {
    version: KILL_FAILURE_VERSION_ORDINARY,
    session: personaTmuxSessionName(REPORT_PERSONA.key),
    instanceId: personaInstanceId(REPORT_PERSONA.key),
    quotes,
  })
  expect(line.endsWith(KILL_FAILURE_ORDINARY_CLI_TEARDOWN_CLOSING)).toBe(true)
  return line
}

/** The survivor version's alert line for the report persona quoting `description`; it ends with the survivor CLI closing sentence. */
function survivorAlertLine(command: CliTeardownCommand, description: string): string {
  const line = cliAlertLine(command, REPORT_PERSONA, {
    version: KILL_FAILURE_VERSION_SURVIVOR,
    session: personaTmuxSessionName(REPORT_PERSONA.key),
    survivorDescription: description,
  })
  expect(line.endsWith(KILL_FAILURE_SURVIVOR_CLI_TEARDOWN_CLOSING)).toBe(true)
  return line
}

/** The failed outcome a kill that threw `value` gives after its tries, carrying `alert`; its class is checked against `errorClass`. */
function failedKillOutcome(value: unknown, errorClass: AdErrorClass, alert: KillRetryAlert, tries = 1): PersonaTeardownOutcome {
  const end = tries === KILL_RETRY_TRIES ? KILL_RETRY_END_EXHAUSTED : KILL_RETRY_END_SETTLED
  const outcome = teardownKillOutcomeOf(retryResult(thrownOutcome(value), end, tries, tries - 1, alert))
  if (outcome.kind !== TEARDOWN_OUTCOME_FAILED) throw new Error('precondition: a failed kill outcome')
  expect(outcome.errorClass).toBe(errorClass)
  return outcome
}

describe('the failure line and the last line (b.jg5 SRJ-907, SRJ-1013)', () => {
  test.each(forEachReportCommand<[number]>([[1], [2]]))('%s: SRJ-907\'s forms, exactly (pinned once), with no [slack] prefix: the failure line, and the last line for a count of %p', (command, count) => {
    const persona: CliTeardownPersona = { name: 'Ops Bot', key: 'ops_bot' }
    expect(teardownFailureLine(command, persona, { errorClass: AD_ERROR_CLASS_CONFLICT, description: 'what agent-director said' })).toBe(
      `${command}: could not stop persona "Ops Bot" (key=ops_bot), session "slack_bot_ops_bot": CONFLICT: what agent-director said`,
    )
    expect(teardownNotStoppedLine(command, count)).toBe(
      `${command}: could not stop ${count} persona(s); rows are never deleted, so running the command again is safe`,
    )
  })

  /** A failure the line reports: its label, its builder and the class the classifier gives it. */
  const LINE_ROWS: ReadonlyArray<readonly [string, () => unknown, AdErrorClass, names: readonly string[]]> = [
    ['a CONFLICT', () => errTmuxSessionConflict(KILL_VERB, 'not-this-launch', personaTmuxSessionName(REPORT_PERSONA.key)), AD_ERROR_CLASS_CONFLICT, []],
    ['a CONFIG', () => errConfigMalformed(), AD_ERROR_CLASS_CONFIG, [AD_CONFIG_FILE_DISPLAY_NAME]],
    [`a store name (${ERR_SCHEMA_MISMATCH_NAME})`, () => errSchemaMismatch(), AD_ERROR_CLASS_UNCLASSIFIED, [ERR_SCHEMA_MISMATCH_NAME]],
    ...STORE_OPEN_ERR_NAMES.filter((name) => name !== ERR_SCHEMA_MISMATCH_NAME)
      .map((name) => [`a store name (${name})`, () => errUnknownErrorName(name), AD_ERROR_CLASS_UNCLASSIFIED, [name]] as const),
  ]

  test.each(forEachReportCommand(LINE_ROWS))('%s: the line for %s holds, in SRJ-907\'s order, the command, the persona, its session, the class and the redacted description', (command, _label, make, errorClass, names) => {
    const value = make()
    const report = teardownErrorReportOf(value)
    expectTeardownReport(report, value, errorClass)
    const line = teardownFailureLine(command, REPORT_PERSONA, report)
    const pieces = [
      `${command}: `,
      renderPersonaRef(REPORT_PERSONA.name, REPORT_PERSONA.key),
      JSON.stringify(personaTmuxSessionName(REPORT_PERSONA.key)),
      `: ${errorClass}: `,
      report.description,
    ]
    const at = pieces.map((piece) => line.indexOf(piece))
    expect(at[0]).toBe(0)
    expect(at.every((i) => i >= 0)).toBe(true)
    expect([...at].sort((a, b) => a - b)).toEqual(at)
    expect(line.endsWith(report.description)).toBe(true)
    for (const name of names) expect(line).toContain(name)
    expect(line.includes('\n')).toBe(false)
    assertNoLeak(line)
  })

  test.each(REPORT_COMMANDS)('%s: a CONFLICT and an UNCLASSIFIED description carrying fake tokens come out redacted on one line', (command) => {
    const outputs = [
      errTmuxSessionConflict(KILL_VERB, 'unrecognised', sentinelInMessage('line-conflict')),
      errGeneric(KILL_VERB, 'ErrNoHandlingInCscb', `refused (${sentinelInMessage('line-unclassified')})`),
    ].map((value) => teardownFailureLine(command, REPORT_PERSONA, teardownErrorReportOf(value)))
    for (const output of outputs) {
      expect(output).toContain(REDACTED_SENTINEL_TAIL)
      expect(output.includes('\n')).toBe(false)
    }
    assertNoLeak(outputs)
  })
})

describe('teardownRejectedOutcomeOf: a persona\'s teardown that rejected fails it (the CLI waits for every persona to settle)', () => {
  test.each<[string, () => unknown]>([
    ['a plain Error whose message carries fake tokens', () => new Error(`teardown broke (${sentinelInMessage('rejected')})`)],
    ['an agent-director error', () => errInternal()],
    ['a string', () => 'boom'],
    ['undefined', () => undefined],
  ])('%s → failed at no known step, reporting the classifier\'s class and the redacted description; never throws', (_label, make) => {
    const reason = make()
    const outcome = teardownRejectedOutcomeOf(reason)
    expect(outcome).toEqual(teardownFailed(TEARDOWN_STEP_UNEXPECTED, teardownErrorReportOf(reason)))
    expect(outcome.description.includes('\n')).toBe(false)
    assertNoLeak(outcome)
  })
})

describe('personaTeardownReportOf: each persona\'s report plan (b.jg5 SRJ-907, SRJ-909, SRJ-1013, SRJ-1007)', () => {
  const STOPPED_REASONS: readonly TeardownStoppedReason[] = [TEARDOWN_STOPPED_NO_ROW, TEARDOWN_STOPPED_ALREADY_FINISHED, TEARDOWN_STOPPED_EXITED, TEARDOWN_STOPPED_KILLED]

  test.each(forEachReportCommand<[string, () => PersonaTeardownOutcome]>([
    ...STOPPED_REASONS.map((reason) => [`stopped (${reason})`, () => teardownStopped(reason)] as [string, () => PersonaTeardownOutcome]),
    ...SUCCESS_RESULTS.map(([label, make]) => [`stopped by a kill ending in ${label}, no alert`, () => teardownKillOutcomeOf(make())] as [string, () => PersonaTeardownOutcome]),
  ]))('%s: %s → nothing printed, logged or recorded; not failed', (command, _label, make) => {
    expect(personaTeardownReportOf(command, REPORT_PERSONA, make())).toEqual({ failed: false, printed: [], logged: [] })
  })

  test.each(forEachReportCommand(SUCCESS_RESULTS))('%s: stopped by a kill ending in %s after a survivor-naming try → no failure line, not failed; the survivor version with the CLI closing sentence printed and logged as one line, and one persona-kill-survivor entry holding it, its context naming the command', (command, _label, make) => {
    const description = survivorDescription()
    const outcome = teardownKillOutcomeOf({ ...make(), alert: { kind: KILL_RETRY_ALERT_SURVIVOR, survivorDescription: description } })
    const alert = survivorAlertLine(command, description)
    const report = personaTeardownReportOf(command, REPORT_PERSONA, outcome)
    expect(report).toEqual({ failed: false, printed: [alert], logged: [alert], entry: { classLabel: PERSONA_KILL_SURVIVOR_LABEL, message: alert } })
    expect(report.printed.filter((line) => line.startsWith(`${command}: `))).toEqual([])
    expect(alert).toContain(command)
    for (const pid of STUB_SURVIVOR_PIDS) expect(alert).toContain(String(pid))
    assertNoLeak(report)
  })

  /** A failed kill whose decision is the ordinary version, with the quotes that decision carries. */
  const ORDINARY_ROWS: ReadonlyArray<readonly [string, () => readonly [PersonaTeardownOutcome, KillFailureOrdinaryQuotes, unknown]]> = [
    ...KILL_FAILED_DESCRIPTIONS.map((d) => [`ErrTmuxKillFailed (${d}) standing after the tries`, () => {
      const value = errTmuxKillFailed(undefined, d)
      const quotes = { lastKillFailedDescription: teardownKillFailedDescription(value) }
      return [failedKillOutcome(value, AD_ERROR_CLASS_UNAVAILABLE, { kind: KILL_RETRY_ALERT_ORDINARY, ...quotes }, KILL_RETRY_TRIES), quotes, value] as const
    }] as const),
    ['ErrTmuxKillFailed naming no survivor standing after a survivor-naming try (both quoted)', () => {
      const value = errTmuxKillFailed(undefined, 'outlived-exit-wait')
      const quotes = { lastKillFailedDescription: teardownKillFailedDescription(value), earlierSurvivorDescription: survivorDescription() }
      return [failedKillOutcome(value, AD_ERROR_CLASS_UNAVAILABLE, { kind: KILL_RETRY_ALERT_ORDINARY, ...quotes }, KILL_RETRY_TRIES), quotes, value] as const
    }],
    ...([
      ['ErrTmuxUnresponsive', () => errTmuxUnresponsive(KILL_VERB), AD_ERROR_CLASS_UNAVAILABLE, KILL_RETRY_TRIES],
      ['CONFLICT', () => errTmuxSessionConflict(KILL_VERB, 'not-this-launch'), AD_ERROR_CLASS_CONFLICT, 2],
      ['GONE (ErrTmuxSendKeys)', () => errTmuxSendKeys(), AD_ERROR_CLASS_GONE, 2],
      ['UNCLASSIFIED (a plain ErrInternal)', () => errInternal(), AD_ERROR_CLASS_UNCLASSIFIED, 2],
    ] as const).map(([label, make, errorClass, tries]) => [`${label} after a survivor-naming try`, () => {
      const value = make()
      const quotes = { earlierSurvivorDescription: survivorDescription() }
      return [failedKillOutcome(value, errorClass, { kind: KILL_RETRY_ALERT_ORDINARY, ...quotes }, tries), quotes, value] as const
    }] as const),
  ]

  test.each(forEachReportCommand(ORDINARY_ROWS))('%s: failed with %s → the failure line, then the ordinary version with the CLI closing sentence, printed and logged as two lines; one persona-kill-failed entry holding the line followed by the alert, its context naming the command', (command, _label, make) => {
    const [outcome, quotes, value] = make()
    const line = teardownFailureLine(command, REPORT_PERSONA, teardownErrorReportOf(value))
    const alert = ordinaryAlertLine(command, quotes)
    const report = personaTeardownReportOf(command, REPORT_PERSONA, outcome)
    expect(report).toEqual({
      failed: true,
      printed: [line, alert],
      logged: [line, alert],
      entry: { classLabel: PERSONA_KILL_FAILED_LABEL, message: `${line} ${alert}` },
    })
    expect(alert).toContain(command)
    assertNoLeak(report)
  })

  /** A failure no alert follows: its outcome and the value it reports. */
  const NO_ALERT_ROWS: ReadonlyArray<readonly [string, () => readonly [PersonaTeardownOutcome, unknown]]> = [
    ['a pause CONFLICT', () => {
      const value = errTmuxSessionConflict(PAUSE_VERB, 'leftover')
      return [teardownFailed(TEARDOWN_STEP_PAUSE, teardownErrorReportOf(value)), value] as const
    }],
    ['a pause CONFIG', () => {
      const value = errConfigMalformed()
      return [teardownFailed(TEARDOWN_STEP_PAUSE, teardownErrorReportOf(value)), value] as const
    }],
    ['a state read UNAVAILABLE', () => {
      const value = errCallTimeout(STATUS_VERB)
      return [teardownFailed(TEARDOWN_STEP_STATE_READ, teardownErrorReportOf(value)), value] as const
    }],
    ['a kill ErrTmuxUnresponsive standing after the tries, with no survivor-naming try', () => {
      const value = errTmuxUnresponsive(KILL_VERB)
      return [failedKillOutcome(value, AD_ERROR_CLASS_UNAVAILABLE, { kind: KILL_RETRY_ALERT_NONE }, KILL_RETRY_TRIES), value] as const
    }],
    ['a kill CONFLICT with no survivor-naming try', () => {
      const value = errTmuxSessionConflict(KILL_VERB, 'not-this-launch')
      return [failedKillOutcome(value, AD_ERROR_CLASS_CONFLICT, { kind: KILL_RETRY_ALERT_NONE }), value] as const
    }],
    ['a kill UNUSABLE NAME', () => {
      const value = errUnusableName()
      return [failedKillOutcome(value, AD_ERROR_CLASS_UNUSABLE_NAME, { kind: KILL_RETRY_ALERT_NONE }), value] as const
    }],
    ['a teardown that rejected', () => {
      const value = new Error('teardown broke')
      return [teardownRejectedOutcomeOf(value), value] as const
    }],
  ]

  test.each(forEachReportCommand(NO_ALERT_ROWS))('%s: failed with %s → the failure line alone, printed and logged; one cli-teardown-failed entry holding that line', (command, _label, make) => {
    const [outcome, value] = make()
    const line = teardownFailureLine(command, REPORT_PERSONA, teardownErrorReportOf(value))
    const report = personaTeardownReportOf(command, REPORT_PERSONA, outcome)
    expect(report).toEqual({ failed: true, printed: [line], logged: [line], entry: { classLabel: CLI_TEARDOWN_FAILED_LABEL, message: line } })
    assertNoLeak(report)
  })

  test.each(REPORT_COMMANDS)('%s: a version that does not fit the outcome is never reported: a stopped persona given the ordinary decision reports nothing, and a failed one given the survivor decision only its line under cli-teardown-failed', (command) => {
    const description = survivorDescription()
    const success = SUCCESS_RESULTS[0]![1]()
    const stopped = { ...teardownKillOutcomeOf(success), kill: { ...success, alert: { kind: KILL_RETRY_ALERT_ORDINARY, earlierSurvivorDescription: description } } }
    expect(personaTeardownReportOf(command, REPORT_PERSONA, stopped as unknown as PersonaTeardownOutcome)).toEqual({ failed: false, printed: [], logged: [] })

    const value = errInternal()
    const failed = failedKillOutcome(value, AD_ERROR_CLASS_UNCLASSIFIED, { kind: KILL_RETRY_ALERT_NONE })
    const withSurvivor = { ...failed, kill: { ...(failed.kill as TeardownKillReport), alert: { kind: KILL_RETRY_ALERT_SURVIVOR, survivorDescription: description } } }
    const line = teardownFailureLine(command, REPORT_PERSONA, teardownErrorReportOf(value))
    expect(personaTeardownReportOf(command, REPORT_PERSONA, withSurvivor as unknown as PersonaTeardownOutcome)).toEqual({
      failed: true, printed: [line], logged: [line], entry: { classLabel: CLI_TEARDOWN_FAILED_LABEL, message: line },
    })
  })

  test.each(REPORT_COMMANDS)('%s: descriptions carrying fake tokens, in the failure line and in both versions\' quotes, come out redacted in every printed line, logged line and entry', (command) => {
    const killValue = errTmuxKillFailed(sentinelInMessage('report-last'), 'outlived-exit-wait')
    // The fake token leads the quoted description, so the log cap never cuts it off.
    const survivorWithToken = `(${sentinelInMessage('report-survivor')}) ${survivorDescription()}`
    const failed = personaTeardownReportOf(command, REPORT_PERSONA, failedKillOutcome(killValue, AD_ERROR_CLASS_UNAVAILABLE, {
      kind: KILL_RETRY_ALERT_ORDINARY, lastKillFailedDescription: teardownKillFailedDescription(killValue), earlierSurvivorDescription: survivorWithToken,
    }, KILL_RETRY_TRIES))
    const survivor = personaTeardownReportOf(command, REPORT_PERSONA, teardownKillOutcomeOf({
      ...SUCCESS_RESULTS[0]![1](), alert: { kind: KILL_RETRY_ALERT_SURVIVOR, survivorDescription: survivorWithToken },
    }))
    expect([failed.printed.length, survivor.printed.length]).toEqual([2, 1])
    for (const text of [...failed.printed, ...failed.logged, failed.entry!.message, ...survivor.printed, ...survivor.logged, survivor.entry!.message]) {
      expect(text).toContain(REDACTED_SENTINEL_TAIL)
      expect(text.includes('\n')).toBe(false)
    }
    assertNoLeak({ failed, survivor })
  })
})

// ---------------------------------------------------------------------------
// clean_restart's not-restarted alert and its class (b.jg5 SRJ-906, SRJ-1013)
// ---------------------------------------------------------------------------

describe('the not-restarted alert and its class, the answer check\'s line and the restart lines (b.jg5 SRJ-906, SRJ-1013)', () => {
  const SECOND_PERSONA: CliTeardownPersona = { name: 'Beta', key: personaKey('Beta') }

  test('SRJ-906\'s answer check line, the line before the restart and the start-failed line, exactly (pinned once)', () => {
    expect(answerCheckFailedTryLine(2, { errorClass: AD_ERROR_CLASS_UNAVAILABLE, description: 'what agent-director said' })).toBe(
      '[slack] clean_restart: agent-director answer check: list try 2 of 3 failed: UNAVAILABLE: what agent-director said',
    )
    expect(cleanRestartStartingAfterFailedTeardownLine()).toBe('[slack] clean_restart: agent-director answers — starting server after the failed teardown')
    expect(cleanRestartStartFailedLine(3)).toBe('[slack] clean_restart: start failed with exit code 3')
    expect(cleanRestartStartFailedLine(null)).toBe('[slack] clean_restart: start failed with exit code null')
  })

  test.each(Array.from({ length: PRECHECK_TRIES }, (_, i) => i + 1))('the answer check line of try %p of PRECHECK_TRIES: a CONFIG failure names the config file, and a description carrying fake tokens comes out redacted on one line', (tryNumber) => {
    const lines = [
      errConfigMalformed(),
      errGeneric(LIST_VERB, 'ErrNoHandlingInCscb', `refused (${sentinelInMessage('answer-check')})`),
    ].map((value) => answerCheckFailedTryLine(tryNumber, teardownErrorReportOf(value)))
    for (const line of lines) {
      expect(line).toContain(`list try ${tryNumber} of ${PRECHECK_TRIES} failed: `)
      expect(line.includes('\n')).toBe(false)
    }
    expect(lines[0]).toContain(`: ${AD_ERROR_CLASS_CONFIG}: `)
    expect(lines[0]).toContain(AD_CONFIG_FILE_DISPLAY_NAME)
    expect(lines[1]).toContain(`: ${AD_ERROR_CLASS_UNCLASSIFIED}: `)
    expect(lines[1]).toContain(REDACTED_SENTINEL_TAIL)
    assertNoLeak(lines)
  })

  test('SRJ-1013\'s class label, closing sentence and one alert, exactly (pinned once)', () => {
    expect(CLEAN_RESTART_NOT_RESTARTED_LABEL).toBe('clean-restart-not-restarted')
    expect(CLEAN_RESTART_NOT_STARTED_SENTENCE).toBe('the server was not started: start it once agent-director answers')
    expect(cleanRestartNotRestartedAlert([{ persona: { name: 'Ops Bot', key: 'ops_bot' }, errorClass: AD_ERROR_CLASS_CONFLICT }])).toBe(
      'clean_restart: could not stop persona "Ops Bot" (key=ops_bot), session "slack_bot_ops_bot": CONFLICT; ' +
        'agent-director did not answer, so the server was not started: start it once agent-director answers',
    )
  })

  test.each<[string, CleanRestartFailedPersona[]]>([
    ['one failed persona', [{ persona: REPORT_PERSONA, errorClass: AD_ERROR_CLASS_UNAVAILABLE }]],
    ['two failed personas', [
      { persona: REPORT_PERSONA, errorClass: AD_ERROR_CLASS_CONFLICT },
      { persona: SECOND_PERSONA, errorClass: AD_ERROR_CLASS_ENVIRONMENT },
    ]],
    ['two failed personas given in the other order', [
      { persona: SECOND_PERSONA, errorClass: AD_ERROR_CLASS_CONFIG },
      { persona: REPORT_PERSONA, errorClass: AD_ERROR_CLASS_UNAVAILABLE },
    ]],
  ])('%s: one line that starts with the command, names each persona with its session and class, in the order given, and ends with the closing sentence', (_label, failures) => {
    const alert = cleanRestartNotRestartedAlert(failures)
    const pieces = [
      `${CLI_COMMAND_CLEAN_RESTART}: `,
      ...failures.flatMap(({ persona, errorClass }) => [
        renderPersonaRef(persona.name, persona.key),
        JSON.stringify(personaTmuxSessionName(persona.key)),
        `: ${errorClass}`,
      ]),
      CLEAN_RESTART_NOT_STARTED_SENTENCE,
    ]
    const at = pieces.map((piece) => alert.indexOf(piece))
    expect(at[0]).toBe(0)
    expect(at.every((i) => i >= 0)).toBe(true)
    expect([...at].sort((a, b) => a - b)).toEqual(at)
    expect(alert.endsWith(CLEAN_RESTART_NOT_STARTED_SENTENCE)).toBe(true)
    expect(alert.includes('\n')).toBe(false)
    assertNoLeak(alert)
  })

  test('the alert carries no agent-director description: failures whose descriptions carry fake tokens give an alert holding neither the redacted description nor the token', () => {
    const failures = [
      errTmuxSessionConflict(KILL_VERB, 'unrecognised', sentinelInMessage('not-restarted-conflict')),
      errGeneric(KILL_VERB, 'ErrNoHandlingInCscb', `refused (${sentinelInMessage('not-restarted-unclassified')})`),
    ].map((value, i) => {
      const report = teardownErrorReportOf(value)
      expect(report.description).toContain(REDACTED_SENTINEL_TAIL) // precondition: the failure line would carry it, redacted
      return { persona: [REPORT_PERSONA, SECOND_PERSONA][i]!, errorClass: report.errorClass, description: report.description }
    })
    const alert = cleanRestartNotRestartedAlert(failures.map(({ persona, errorClass }) => ({ persona, errorClass })))
    for (const { description, errorClass } of failures) {
      expect(alert).not.toContain(description)
      expect(alert).toContain(`: ${errorClass}`)
    }
    expect(alert).not.toContain(REDACTED_SENTINEL_TAIL)
    assertNoLeak(alert)
  })
})

// ---------------------------------------------------------------------------
// Bounded cost (b.jg5 SRJ-908)
// ---------------------------------------------------------------------------

describe('the precheck\'s and the teardown\'s bounds (b.jg5 SRJ-908)', () => {
  const CALL_TIMEOUTS = [0, MIN_AGENT_DIRECTOR_CALL_TIMEOUT_MS, DEFAULT_AGENT_DIRECTOR_CALL_TIMEOUT_MS, MAX_AGENT_DIRECTOR_CALL_TIMEOUT_MS] as const
  const EXIT_TIMEOUTS = [0, 1, 5] as const
  /** The precheck's calls of one persona, each with its own tries: its get, then its read-pane. */
  const PRECHECK_CALLS = [PRECHECK_CALL_GET, PRECHECK_CALL_READ_PANE] as const

  test.each([1, 5, 0.5])('exit_timeout %p s in ms', (seconds) => {
    expect(exitTimeoutMsOf(seconds)).toBe(seconds * 1_000)
  })

  test.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])('exit_timeout %p counts as 0', (seconds) => {
    expect(exitTimeoutMsOf(seconds)).toBe(0)
  })

  test.each([...CALL_TIMEOUTS])('precheckBoundMs(%p): each of its calls\' PRECHECK_TRIES calls, PRECHECK_TRY_SPACING_MS apart, each taking the call timeout', (callMs) => {
    const oneCall = PRECHECK_TRIES * callMs + (PRECHECK_TRIES - 1) * PRECHECK_TRY_SPACING_MS
    expect(precheckBoundMs(callMs)).toBe(PRECHECK_CALLS.length * oneCall)
  })

  test.each(EXIT_TIMEOUTS.flatMap((e) => CALL_TIMEOUTS.map((c) => [e, c] as const)))(
    'teardownBoundMs(%p, %p): the state read, the pause\'s tries, exit_timeout and the poll\'s last read, then the kill\'s tries with a read before each further one, each call taking the call timeout',
    (exitTimeoutS, callMs) => {
      const stateRead = callMs
      const pause = PRECHECK_TRIES * callMs + (PRECHECK_TRIES - 1) * PRECHECK_TRY_SPACING_MS
      const poll = exitTimeoutMsOf(exitTimeoutS) + callMs
      const kill = KILL_RETRY_TRIES * callMs + (KILL_RETRY_TRIES - 1) * (KILL_RETRY_SPACING_MS + callMs)
      expect(teardownBoundMs(exitTimeoutS, callMs)).toBe(stateRead + pause + poll + kill)
    },
  )

  test.each(EXIT_TIMEOUTS.flatMap((e) => CALL_TIMEOUTS.map((c) => [e, c] as const)))('both bounds grow with each input (exit_timeout %p, call timeout %p)', (exitTimeoutS, callMs) => {
    expect(teardownBoundMs(exitTimeoutS + 1, callMs)).toBeGreaterThan(teardownBoundMs(exitTimeoutS, callMs))
    expect(teardownBoundMs(exitTimeoutS, callMs + 1)).toBeGreaterThan(teardownBoundMs(exitTimeoutS, callMs))
    expect(precheckBoundMs(callMs + 1)).toBeGreaterThan(precheckBoundMs(callMs))
  })

  test.each([-1, Number.NaN, Number.POSITIVE_INFINITY])('a call timeout of %p counts as 0 in both bounds', (callMs) => {
    expect(precheckBoundMs(callMs)).toBe(precheckBoundMs(0))
    expect(teardownBoundMs(1, callMs)).toBe(teardownBoundMs(1, 0))
  })
})
