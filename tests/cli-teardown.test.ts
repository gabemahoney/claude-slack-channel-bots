/**
 * cli-teardown.test.ts — The pure pieces of the CLI's teardown commands
 * (`src/cli-teardown.ts`; b.jg5 SRJ-901, SRJ-117's CLI-precheck column,
 * SRJ-903, SRJ-316): the precheck's verdict over one `get` or `read-pane`
 * answer, its two operator line builders, its tries and spacing, and the
 * config-file display name; the teardown's pause verdict over one `pause`
 * answer, its state-read verdict over one `status` answer and its
 * per-persona outcome. The precheck runner, the teardown's tries and poll on
 * the CLI's injected clock and both commands' order are tests/cli.test.ts's.
 *
 * Every agent-director error is built by name with the stub's builders; class
 * labels, finished and live states, notes and launch starts are imported. The
 * SRD's numbers (3 tries, 2 s apart), the config file's name and one line of
 * each builder are pinned once as literals, the forms SRJ-901 states.
 *
 * Pure: no client, no process, no timer, no file, no top-level mock.module().
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
  ERR_STORE_OPEN_NAME,
  ERR_TMUX_SESSION_CONFLICT_NAME,
  STORE_OPEN_ERR_NAMES,
} from '../src/agent-director-errors.ts'
import {
  AD_CONFIG_FILE_DISPLAY_NAME,
  CLI_COMMAND_CLEAN_RESTART,
  CLI_COMMAND_STOP_BOTS,
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
  TEARDOWN_OUTCOME_FAILED,
  TEARDOWN_OUTCOME_STOPPED,
  TEARDOWN_STEP_KILL,
  TEARDOWN_STEP_PAUSE,
  TEARDOWN_STEP_POLL,
  TEARDOWN_STEP_STATE_READ,
  TEARDOWN_STOPPED_ALREADY_FINISHED,
  TEARDOWN_STOPPED_EXITED,
  TEARDOWN_STOPPED_KILLED,
  TEARDOWN_STOPPED_NO_ROW,
  onlyServerStoppedLine,
  pauseVerdictAfterLastTry,
  pauseVerdictOf,
  precheckFailureLine,
  precheckNothingStoppedLine,
  precheckVerdictOf,
  stateReadVerdictOf,
  teardownErrorReportOf,
  teardownFailed,
  teardownStopped,
  type PauseVerdict,
  type PrecheckCall,
  type PrecheckRow,
  type PrecheckVerdict,
  type StateReadVerdict,
  type TeardownErrorReport,
} from '../src/cli-teardown.ts'
import { AGENT_DIRECTOR_DEAD_STATES, AGENT_DIRECTOR_LIVE_STATES, AGENT_DIRECTOR_PENDING_STATE } from '../src/liveness-reading.ts'
import {
  CONFLICT_CASES,
  SAMPLE_LAUNCH_START_DEFAULT,
  STUB_TMUX_SOCKET_PATH,
  UNAVAILABLE_FORMS,
  UNUSABLE_NAME_FAULTS,
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
  errTmuxSendKeys,
  errTmuxNotAvailable,
  errTmuxNotAvailableDifferentServer,
  errTmuxSessionConflict,
  errTmuxSessionCreate,
  errUnknownErrorName,
  errUnusableName,
  nonLatchingNotes,
  provenanceNote,
  unknownNote,
} from './test-helpers/agent-director-stub.ts'
import { assertNoLeak, REDACTED_SENTINEL_TAIL, sentinelInMessage } from './test-helpers/credentials.ts'
import { forbiddenServerLoads, importedSpecifiers, stripComments } from './test-helpers/source-audit.ts'

const SOURCE = join(import.meta.dir, '..', 'src', 'cli-teardown.ts')

/** A row state CSCB does not know: live (b.jg5 SRJ-901 step 2, hatch A3). */
const UNKNOWN_STATE = 'a_state_cscb_does_not_know'

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
 * The same classes at `get`: `ErrSpawnNotFound` is no row (skipped); GONE,
 * which a `get` gives no meaning, fails as UNCLASSIFIED with no retry.
 */
const GET_ERROR_ROWS: readonly ErrorRow[] = [
  ['ErrSpawnNotFound (no row)', () => errSpawnNotFound(), PRECHECK_VERDICT_SKIP, null],
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

  test('the tries, their spacing and the config file\'s display name are SRJ-901\'s (pinned once): 3 tries 2 s apart, ~/.agent-director/config.toml, built from the settings path', () => {
    expect([PRECHECK_TRIES, PRECHECK_TRY_SPACING_MS]).toEqual([3, 2_000])
    expect(AD_CONFIG_FILE_DISPLAY_NAME).toBe('~/.agent-director/config.toml')
    expect(AD_CONFIG_FILE_DISPLAY_NAME).toBe(join('~', AD_SETTINGS_RELATIVE_PATH))
  })

  test('a CONFIG failure\'s line names the config file; a CONFLICT and an UNCLASSIFIED description carrying fake tokens render redacted on one line', () => {
    const lines = [
      errConfigMalformed(),
      errGeneric(PRECHECK_CALL_READ_PANE, ERR_TMUX_SESSION_CONFLICT_NAME, `session refused (${sentinelInMessage('conflict')})`),
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
 * (SRJ-316) and flagged as naming it.
 */
function expectTeardownReport(report: TeardownErrorReport, value: unknown, errorClass: AdErrorClass): void {
  expect(report.errorClass).toBe(errorClass)
  expect(report.errorClass).toBe(classifyAdError(value).errorClass)
  expect(report.description.includes('\n')).toBe(false)
  const reported = describeReportedAdFailure(value)
  if (errorClass === AD_ERROR_CLASS_CONFIG) {
    expect(report.namesConfigFile).toBe(true)
    expect(report.description).toContain(AD_CONFIG_FILE_DISPLAY_NAME)
    expect(report.description.endsWith(reported)).toBe(true)
  } else {
    expect(report.namesConfigFile).toBe(false)
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
 * The teardown's own `status` read: `ErrSpawnNotFound` is no row; every
 * other answer fails at once with the classifier's class, never relabelled
 * UNCLASSIFIED as the precheck's `get` relabels.
 */
const STATE_READ_ERROR_ROWS: readonly StateReadErrorRow[] = [
  ['ErrSpawnNotFound (no row)', () => errSpawnNotFound(), null],
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
    for (const step of [TEARDOWN_STEP_STATE_READ, TEARDOWN_STEP_PAUSE, TEARDOWN_STEP_POLL, TEARDOWN_STEP_KILL] as const) {
      expect(teardownFailed(step, { ...report, extra: 'not copied' } as TeardownErrorReport)).toEqual({ kind: TEARDOWN_OUTCOME_FAILED, step, ...report })
    }
  })

  test('a CONFLICT, an UNCLASSIFIED and a plain ErrInternal description carrying fake tokens come out redacted on one line, at the pause (failing or escalating) and at a status read', () => {
    const values = [
      errGeneric(PAUSE_VERB, ERR_TMUX_SESSION_CONFLICT_NAME, `session refused (${sentinelInMessage('teardown-conflict')})`),
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

  test('it loads no server-only module (the session manager, the conflict latch …), no Slack module, never src/cli.ts and never the retired-key record module', () => {
    const { loads, forbidden } = forbiddenServerLoads('cli-teardown.ts')
    expect(forbidden).toEqual([])
    expect(loads.modules.has('pane-read.ts')).toBe(true) // the walk is not vacuous
    expect([...loads.modules.keys()].filter((name) => name === 'cli.ts' || name === 'retired-keys.ts')).toEqual([])
    expect(importedSpecifiers(code).filter((s) => !s.startsWith('./') && !s.startsWith('node:'))).toEqual([])
  })

  test('it reads no clock, arms no timer and tells no error apart by its class (instanceof)', () => {
    for (const banned of [/\bDate\.now\b/, /\bsetTimeout\b/, /\bsetInterval\b/, /\binstanceof\b/]) {
      expect([banned.source, banned.test(code)]).toEqual([banned.source, false])
    }
  })
})
