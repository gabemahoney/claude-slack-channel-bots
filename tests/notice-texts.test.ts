/**
 * notice-texts.test.ts — The notice catalogue: every exported SRJ-10xx notice
 * builder and every other server notice posted to Slack, rendered for every
 * variant it has, held against rules that apply to every notice (b.jg5
 * SRJ-1001). E31 checks SRJ-511 (AC 47): no notice names `clear-latch` in any
 * spelling (tests/test-helpers/clear-latch-terms.ts). E36 extends the same
 * catalogue, never a second one, with the rest of SRJ-1001 (AC 40, 67, 78,
 * 85, 86).
 *
 * `NOTICE_CATALOGUE` is one table of entries, each keyed by its SRJ id and
 * naming its builder and variant: the CONFLICT notice for every row of the
 * conflict-case table, a description-less (note) latch and a token-bearing
 * description (SRJ-1004); the recovery notice for each latch kind and each
 * reason, "cleared by hand" included (SRJ-1005); the `tmux-unresponsive`
 * onset, alert and recovery (SRJ-1006); the kill-failure alert's ordinary
 * version for each `ErrTmuxKillFailed` description, each instance id, each
 * closing and each form, with no description and with both, and its survivor
 * version for each pid list and closing (SRJ-1007); the `ErrInvalidFlags` hold
 * (SRJ-1008); the unclassified-error alert (SRJ-1009); slow recovery
 * (SRJ-1010); the lost-message notice in each state (SRJ-1011); the
 * permission wedge warning (SRJ-1012); the startup-errors entries' texts
 * (SRJ-1013); the stuck-launch posts, the held
 * one with and without the attach line (SRJ-1017); the `ad-config-malformed`
 * onset (SRJ-1018); the unusable-name post for each fault (SRJ-1019); the
 * launch-start-not-recorded post (SRJ-1020); the re-bound socket's onset and
 * the all-clear (SRJ-1021); and, under SRJ-1001 (whose rules hold for every
 * server notice posted to Slack), the persona prefix, every outage onset and
 * the all-clear, the spawn-failure notice for each remediation and the
 * restart-cap notice, b.f2b's not-connected notice in its six renderings,
 * the JSONL persistence safeguard's three notices (SRJ-122: they name no
 * command and keep their text) and the `ErrJsonlMissing` diagnosis's three
 * notices (SRJ-712: LOST and both INCONCLUSIVE shapes, each quoting
 * agent-director and naming no command). The teardown window's notices
 * (SRJ-1003) are the kill outcome's one-line renderings. Each builder that quotes
 * agent-director also has one redaction-and-cap row (`CAP_VARIANT`): a
 * token-bearing description longer than `MAX_LOGGED_MESSAGE_LENGTH`.
 * agent-director's words come from the stub's descriptions; a fake token
 * (`sentinelInMessage`) rides in every quoted description that can carry one.
 *
 * Checks, each a `test.each` whose case title names the SRJ id, the builder
 * and the variant:
 *   - no entry names a `clear-latch` term (SRJ-511);
 *   - CSCB's own text (`cscbOwnText` from tests/test-helpers/conflict-cases.ts,
 *     with agent-director's words "no kill was sent", "retry kill later" and
 *     "never delete this row" let through) names none of
 *     `--include-finished` (either spelling), `kill-session`, `kill-server`,
 *     a raw tmux kill, a process kill, a row delete, a tmux target without
 *     `=`, or `CSCB_OWN_LINE_FORBIDDEN`'s terms (`kill-pane`, `set-option`,
 *     `agent-director delete`, `has-session`, …);
 *   - the CONFLICT, unusable-name, launch-start and both stuck-launch texts'
 *     own lines match none of `SESSION_ENDING_COMMAND_FORMS`
 *     (`sessionEndingCommandsIn`);
 *   - every Slack notice whose own text names a command (a code span opening
 *     with `agent-director` or `tmux` and a space) or "Operator actions"
 *     carries the human-only sentence, matched by the one shared pattern
 *     (`HUMAN_ONLY_SENTENCE` from tests/test-helpers/conflict-cases.ts) since
 *     its wordings differ; "Operator
 *     actions" appears only as its quoted title; the log-only texts
 *     (`LOG_ONLY_SRJS`: SRJ-1003, SRJ-1013) quote agent-director's own
 *     pointer and are held to the other rules only;
 *   - only the ordinary kill-failure alert (and the startup-errors entry
 *     carrying it) and the wedge warning name `agent-director kill`, each
 *     checking its result; the survivor version names no command;
 *   - each redaction-and-cap row is redacted and cut before the description's
 *     end, and every builder that quotes agent-director has one; every
 *     rendered text passes `assertNoLeak`;
 *   - every Slack notice that quotes agent-director's description
 *     (`SLACK_QUOTING_NOTICES`) escapes Slack's control characters in it
 *     exactly once;
 *   - the completeness guard holds every id from SRJ-1001 to SRJ-1021 either
 *     in the catalogue or in `NOT_APPLICABLE` with its reason, never both,
 *     and every notice in `NAMED_SLACK_NOTICES` in every variant;
 *   - self-checks show each pattern finds what it looks for, and that
 *     agent-director's words in a quoted description would fail the checks
 *     if the own-lines helper stopped removing the description.
 * This file pins no notice text: each builder's exact text is asserted in
 * its own suite.
 *
 * Pure: every builder here is a pure function of its arguments; nothing is
 * started, written or posted. The JSONL safeguard has no pure builder, so it
 * runs once at load with every effect injected (a capturing notice seam, no
 * startup-errors record, a fixed mount table, a stub row and stub file and
 * archive reads); its paths are never created.
 *
 * SPDX-License-Identifier: MIT
 */

import { describe, expect, test } from 'bun:test'

import { CLEAR_LATCH_COMMAND, CLEAR_LATCH_ROUTE } from '../src/clear-latch.ts'
import { NEVER_DELETE_ROW_PHRASE, NO_KILL_SENT_PHRASE, RETRY_KILL_LATER_PHRASE } from '../src/ad-description-phrases.ts'
import {
  AD_ERROR_CLASS_CONFLICT,
  AD_ERROR_CLASS_UNAVAILABLE,
  AD_ERROR_CLASS_UNUSABLE_NAME,
  classifyAdError,
} from '../src/ad-error-class.ts'
import {
  adAlertThresholdMs,
  adLaunchBoundMs,
  DEFAULT_AD_SETTINGS_IN_EFFECT,
} from '../src/ad-settings.ts'
import {
  buildBelowPhase1FloorMessage,
  buildSystemInstallTooOldMessage,
  FOUND_BY_RUNTIME_RECHECK,
  FOUND_BY_STARTUP_CHECK,
} from '../src/ad-version-gate.ts'
import {
  KILL_OUTCOME_NOT_KILLED,
  KILL_REFUSAL_AT_KILL,
  KILL_REFUSAL_AT_READ,
  killOutcomeOf,
  teardownKillNotSucceededNoticeText,
  teardownKillRefusalNoticeText,
  type KillFailure,
} from '../src/checked-kill.ts'
import {
  CLI_COMMAND_CLEAN_RESTART,
  CLI_COMMAND_STOP_BOTS,
  cleanRestartNotRestartedAlert,
  teardownErrorReportOf,
  teardownFailureLine,
} from '../src/cli-teardown.ts'
import {
  CONFLICT_NOTICE_LIST_LINE_UNSAFE_NAME,
  conflictNoticeText,
  LATCH_CASE_CONFLICTING_LABELS,
  LATCH_CASE_LEFTOVER,
  LATCH_KIND_CONFLICT,
  LATCH_KIND_HOLD,
  LATCH_RECOVERY_REASON_CLEARED_BY_HAND,
  LATCH_RECOVERY_REASON_RELAUNCH_NOT_REFUSED,
  LATCH_RECOVERY_REASON_RETRY_NOT_REFUSED,
  LATCH_RECOVERY_REASON_ROW_GONE,
  latchRecoveryReasonRowReads,
  latchRecoveryText,
  launchStartNotRecordedNoticeText,
  type ConflictLatchCase,
  type LatchKind,
  type LatchRecoveryReason,
  unusableNameNoticeText,
} from '../src/conflict-latch.ts'
import { INVALID_FLAGS_HOLD_ALERT_TEXT } from '../src/invalid-flags-hold.ts'
import { runJsonlPersistenceSafeguard, runPersonaStorageCheck, UNATTRIBUTABLE_ZERO_REASON } from '../src/jsonl-persistence-check.ts'
import {
  KILL_FAILURE_CLOSING_CLI_TEARDOWN,
  KILL_FAILURE_CLOSING_DESTINATION,
  KILL_FAILURE_CLOSING_DESTINATION_LATCHED,
  KILL_FAILURE_CLOSING_LOG_ONLY,
  KILL_FAILURE_CONTEXTS,
  KILL_FAILURE_VERSION_ORDINARY,
  KILL_FAILURE_VERSION_SURVIVOR,
  killFailureAlertEntryText,
  killFailureAlertText,
  killFailureCliTeardownEntryContext,
  type KillFailureAlertContent,
  type KillFailureClosing,
} from '../src/kill-failure-alert.ts'
import { KILL_RETRY_ALERT_ORDINARY } from '../src/kill-retry.ts'
import { buildLostMessageNotice, LOST_MESSAGE_STATES } from '../src/lost-message.ts'
import {
  OLD_LIFE_WAIT_AT_FIND_MISSING,
  OLD_LIFE_WAIT_AT_GET,
  OLD_LIFE_WAIT_AT_KILL,
  OLD_LIFE_WAIT_AT_STATUS_READ,
  oldLifeWaitRefusalNoticeText,
  type OldLifeWaitRefusalAt,
} from '../src/old-life-wait.ts'
import {
  ALL_CLEAR_TEMPLATE,
  adConfigMalformedOnset,
  ONSET_TEMPLATES,
  OUTAGE_CLASS_ORDER,
  tmuxServerChangedOnset,
  type ClassRecord,
  type OutageClass,
} from '../src/outage-state.ts'
import { stuckLaunchHeldText, stuckLaunchRelaunchingText } from '../src/pending-row.ts'
import { buildWedgeWarningText } from '../src/permission-poller.ts'
import { MAX_LOGGED_MESSAGE_LENGTH } from '../src/persona-connection-errors.ts'
import {
  killFailureStoppedRetryText,
  tmuxUnresponsiveAlertText,
  tmuxUnresponsiveOnsetText,
  tmuxUnresponsiveRecoveryText,
  personaUnclassifiedErrorEntryText,
  unclassifiedErrorAlertText,
} from '../src/persona-episodes.ts'
import { personaInstanceId, personaTmuxSessionName, tmuxExactSessionTarget } from '../src/persona-identity.ts'
import {
  formatPersonaNotice,
  PERSONA_TEARDOWN_NOTICE_ALL_CLEAR_AFTER,
  PERSONA_TEARDOWN_NOTICE_DURING_WAIT,
  PERSONA_TEARDOWN_NOTICE_RAISED,
  personaTeardownNoticeEntryText,
  type PersonaTeardownNoticeOccasion,
} from '../src/persona-notifier.ts'
import { retiredKeysUnreadableMessage } from '../src/retired-keys.ts'
import {
  buildNotConnectedNotice,
  jsonlCandidatesInconclusiveNoticeText,
  jsonlCandidatesText,
  jsonlRowAbsentInconclusiveNoticeText,
  jsonlTranscriptLostNoticeText,
  restartCapReachedNoticeText,
  spawnFailureNoticeText,
  UNPROVEN_IDLE_NOTICE_AFTER_MS,
  waitTimedOutUnreadReport,
  type NotConnectedNotice,
} from '../src/session-manager.ts'
import { REDACTED_TOKEN_PLACEHOLDER } from '../src/slack-log-redaction.ts'
import { escapeSlackControlCharacters } from '../src/slack-text-escape.ts'
import { slowRecoveryText } from '../src/slow-recovery.ts'
import {
  ERR_TMUX_KILL_FAILED_NAME,
  ERR_TMUX_SESSION_CONFLICT_NAME,
  ErrTmuxKillFailed,
  ErrTmuxSessionConflict,
} from '../src/agent-director-errors.ts'

import {
  cannedGetResult,
  errConfigMalformed,
  errGeneric,
  errJsonlMissing,
  errSpawnNotFound,
  errTmuxKillFailed,
  errTmuxSessionConflict,
  errUnknownErrorName,
  errUnusableName,
  KILL_FAILED_DESCRIPTIONS,
  SAMPLE_LAUNCH_START_DEFAULT,
  STUB_RESOLVE_DEFAULT_PATH,
  STUB_SURVIVOR_PIDS,
  UNUSABLE_NAME_FAULTS,
} from './test-helpers/agent-director-stub.ts'
import {
  BELOW_CLIENT_MIN_VERSION,
  CLIENT_MIN_VERSION,
  DEV_PLACEHOLDER_VERSION,
} from './test-helpers/agent-director-versions.ts'
import { CLEAR_LATCH_TERMS, clearLatchTermsIn } from './test-helpers/clear-latch-terms.ts'
import {
  CONFLICT_CASE_ROWS,
  cscbOwnLineForbiddenIn,
  cscbOwnLines,
  cscbOwnText,
  HUMAN_ONLY_SENTENCE,
  humanOnlySentencesIn,
  sessionEndingCommandsIn,
} from './test-helpers/conflict-cases.ts'
import { assertNoLeak, sentinelInMessage } from './test-helpers/credentials.ts'
import { makeMultiPersonaConfig } from './test-helpers/persona-config.ts'

// ---------------------------------------------------------------------------
// The catalogue
// ---------------------------------------------------------------------------

/** An SRJ-10xx requirement id. */
type NoticeSrj = `SRJ-10${string}`

/** One rendered notice: its SRJ id, the builder that renders it, the variant and a renderer. */
interface NoticeEntry {
  readonly srj: NoticeSrj
  readonly builder: string
  readonly variant: string
  /** Renders the text; a builder that throws fails its own case. */
  readonly render: () => string
}

/** The persona the notices concern. */
const KEY = 'alpha'
const PERSONA = { name: 'Alpha', key: KEY } as const
/** An old key's persona (a renamed persona's earlier key), for the kill-failure alert's instance id. */
const OLD_KEY = 'alpha_old'

/** `text` with a fake token and a ticket URL appended: a quoted description that must come out redacted. */
function withToken(text: string, label: string): string {
  return `${text} (${sentinelInMessage(label)})`
}

function entry(srj: NoticeSrj, builder: string, variant: string, render: () => string): NoticeEntry {
  return Object.freeze({ srj, builder, variant, render })
}

/**
 * SRJ-1004's list-line renderings beyond a plain name (the Epic's hatch note
 * "orchestrator ruling after E13"): a name the line shell-quotes with a `'\''`
 * in it, and names the line leaves out for the unsafe-name sentence.
 */
const CONFLICT_LIST_NAME_VARIANTS: readonly (readonly [variant: string, sessionName: string])[] = [
  ['list line: a name with a quote and a semicolon, shell-quoted', "it's; rm -rf x"],
  ['list line left out: a name with a control character', 'bad\u001bname'],
  ['list line left out: a name with a newline', 'bad\nname'],
  ['list line left out: a name with a backtick', 'bad`name'],
  ['list line left out: a token-bearing name, which rendering redacts', `bot ${sentinelInMessage('list-name')}`],
]

/** SRJ-1004: the CONFLICT notice. */
function conflictEntries(): NoticeEntry[] {
  const byRow = CONFLICT_CASE_ROWS.map((row) =>
    entry('SRJ-1004', 'conflictNoticeText', row.name, () => {
      const record = row.record(KEY)
      return conflictNoticeText({
        sessionName: record.sessionName,
        latchCase: row.latchCase,
        ...(record.description === undefined ? {} : { description: record.description }),
      })
    }),
  )
  const session = personaTmuxSessionName(KEY)
  return [
    ...byRow,
    // A latch from a `provenance_conflict` note has no description (hatch A2).
    entry('SRJ-1004', 'conflictNoticeText', 'note latch: conflicting labels, no description', () =>
      conflictNoticeText({ sessionName: session, latchCase: LATCH_CASE_CONFLICTING_LABELS as ConflictLatchCase }),
    ),
    entry('SRJ-1004', 'conflictNoticeText', 'token-bearing description', () =>
      conflictNoticeText({
        sessionName: session,
        latchCase: LATCH_CASE_LEFTOVER as ConflictLatchCase,
        description: withToken(errTmuxSessionConflict('spawn', 'leftover', session).errDescription, 'conflict'),
      }),
    ),
    ...CONFLICT_LIST_NAME_VARIANTS.map(([variant, sessionName]) =>
      entry('SRJ-1004', 'conflictNoticeText', variant, () =>
        conflictNoticeText({ sessionName, latchCase: LATCH_CASE_LEFTOVER as ConflictLatchCase }),
      ),
    ),
  ]
}

/** SRJ-1005's reasons, "cleared by hand" (the `clear-latch` clear) included. */
const RECOVERY_REASONS: readonly (readonly [label: string, reason: LatchRecoveryReason])[] = [
  ['row reads ended', latchRecoveryReasonRowReads('ended')],
  ['row reads missing', latchRecoveryReasonRowReads('missing')],
  ['row gone', LATCH_RECOVERY_REASON_ROW_GONE],
  ['retry not refused', LATCH_RECOVERY_REASON_RETRY_NOT_REFUSED],
  ['relaunch not refused', LATCH_RECOVERY_REASON_RELAUNCH_NOT_REFUSED],
  ['cleared by hand', LATCH_RECOVERY_REASON_CLEARED_BY_HAND],
]

/** SRJ-1005: the recovery notice, for each latch kind and reason. */
function recoveryEntries(): NoticeEntry[] {
  const kinds: readonly LatchKind[] = [LATCH_KIND_CONFLICT, LATCH_KIND_HOLD]
  return kinds.flatMap((kind) =>
    RECOVERY_REASONS.map(([label, reason]) =>
      entry('SRJ-1005', 'latchRecoveryText', `${kind} latch, ${label}`, () =>
        latchRecoveryText(kind, reason, personaTmuxSessionName(KEY)),
      ),
    ),
  )
}

/** SRJ-1006: `tmux-unresponsive`. */
function tmuxUnresponsiveEntries(): NoticeEntry[] {
  return [
    entry('SRJ-1006', 'tmuxUnresponsiveOnsetText', 'onset', () => tmuxUnresponsiveOnsetText(KEY)),
    entry('SRJ-1006', 'tmuxUnresponsiveAlertText', 'alert at the default threshold', () =>
      tmuxUnresponsiveAlertText(KEY, adAlertThresholdMs(DEFAULT_AD_SETTINGS_IN_EFFECT)),
    ),
    entry('SRJ-1006', 'tmuxUnresponsiveRecoveryText', 'recovery', () => tmuxUnresponsiveRecoveryText(KEY)),
  ]
}

/** The ordinary version's closings, and the survivor version's (which has no latched one). */
const ORDINARY_CLOSINGS: readonly KillFailureClosing[] = [
  KILL_FAILURE_CLOSING_DESTINATION,
  KILL_FAILURE_CLOSING_DESTINATION_LATCHED,
  KILL_FAILURE_CLOSING_CLI_TEARDOWN,
  KILL_FAILURE_CLOSING_LOG_ONLY,
]
const SURVIVOR_CLOSINGS: readonly KillFailureClosing[] = [
  KILL_FAILURE_CLOSING_DESTINATION,
  KILL_FAILURE_CLOSING_CLI_TEARDOWN,
  KILL_FAILURE_CLOSING_LOG_ONLY,
]

/** A Slack post (escaped for Slack) and the log-line form. */
const FORMS: readonly (readonly [label: string, forSlack: boolean])[] = [
  ['Slack', true],
  ['log', false],
]

/** The ordinary version's content for one quote set. */
function ordinaryContent(instanceId: string, quotes?: { lastKillFailedDescription?: string; earlierSurvivorDescription?: string }): KillFailureAlertContent {
  return {
    version: KILL_FAILURE_VERSION_ORDINARY,
    session: personaTmuxSessionName(KEY),
    instanceId,
    ...(quotes === undefined ? {} : { quotes }),
  }
}

/** A kill-failure description from the stub, with a fake token riding in it. */
function killFailedDescription(description: (typeof KILL_FAILED_DESCRIPTIONS)[number], pids: readonly number[] = STUB_SURVIVOR_PIDS): string {
  return withToken(errTmuxKillFailed(personaTmuxSessionName(KEY), description, pids).errDescription, 'kill-failed')
}

/** SRJ-1007: the kill-failure alert, both versions. */
function killFailureEntries(): NoticeEntry[] {
  const ids: readonly (readonly [label: string, id: string])[] = [
    ['own id', personaInstanceId(KEY)],
    ["an old key's id", personaInstanceId(OLD_KEY)],
  ]
  const ordinaryQuotes: readonly (readonly [label: string, quotes: (() => { lastKillFailedDescription?: string; earlierSurvivorDescription?: string }) | undefined])[] = [
    ...KILL_FAILED_DESCRIPTIONS.map((d) => [`quoting ${d}`, () => ({ lastKillFailedDescription: killFailedDescription(d) })] as const),
    ['no description (kills succeeded, row stayed live)', undefined],
    [
      'quoting the last failure and an earlier survivor-naming one',
      () => ({
        lastKillFailedDescription: killFailedDescription('outlived-exit-wait'),
        earlierSurvivorDescription: killFailedDescription('pane-process-survived'),
      }),
    ],
  ]
  const ordinary = ids.flatMap(([idLabel, id]) =>
    ordinaryQuotes.flatMap(([quoteLabel, quotes]) =>
      ORDINARY_CLOSINGS.flatMap((closing) =>
        FORMS.map(([formLabel, forSlack]) =>
          entry('SRJ-1007', 'killFailureAlertText', `ordinary, ${idLabel}, ${quoteLabel}, closing ${closing}, ${formLabel}`, () =>
            killFailureAlertText(ordinaryContent(id, quotes?.()), closing, forSlack),
          ),
        ),
      ),
    ),
  )
  const pidLists: readonly (readonly [label: string, pids: readonly number[]])[] = [
    ['one pid', STUB_SURVIVOR_PIDS],
    ['two pids', [...STUB_SURVIVOR_PIDS, STUB_SURVIVOR_PIDS[0]! + 1]],
  ]
  const survivor = pidLists.flatMap(([pidLabel, pids]) =>
    SURVIVOR_CLOSINGS.flatMap((closing) =>
      FORMS.map(([formLabel, forSlack]) =>
        entry('SRJ-1007', 'killFailureAlertText', `survivor, ${pidLabel}, closing ${closing}, ${formLabel}`, () =>
          killFailureAlertText(
            {
              version: KILL_FAILURE_VERSION_SURVIVOR,
              session: personaTmuxSessionName(KEY),
              survivorDescription: killFailedDescription('pane-process-survived', pids),
            },
            closing,
            forSlack,
          ),
        ),
      ),
    ),
  )
  return [...ordinary, ...survivor]
}

/** SRJ-1008: the `ErrInvalidFlags` hold alert, a fixed text. */
function invalidFlagsEntries(): NoticeEntry[] {
  return [entry('SRJ-1008', 'INVALID_FLAGS_HOLD_ALERT_TEXT', 'the alert', () => INVALID_FLAGS_HOLD_ALERT_TEXT)]
}

/** An unclassified answer whose message carries a fake token. */
function unclassifiedQuote() {
  return classifyAdError(errGeneric('spawn', 'ErrFromALaterBinary', withToken('something new went wrong', 'unclassified')))
}

/** SRJ-1009: the unclassified-error alert, posted and log-only. */
function unclassifiedEntries(): NoticeEntry[] {
  return [
    entry('SRJ-1009', 'unclassifiedErrorAlertText', 'Slack', () => unclassifiedErrorAlertText(unclassifiedQuote())),
    entry('SRJ-1009', 'unclassifiedErrorAlertText', 'log-only', () =>
      unclassifiedErrorAlertText(unclassifiedQuote(), { escapeForSlack: false }),
    ),
    entry('SRJ-1009', 'unclassifiedErrorAlertText', 'no name and no message', () =>
      unclassifiedErrorAlertText({}),
    ),
  ]
}

/** SRJ-1010: slow dead-session recovery. */
function slowRecoveryEntries(): NoticeEntry[] {
  return [entry('SRJ-1010', 'slowRecoveryText', 'the post', () => slowRecoveryText(KEY))]
}

/** SRJ-1011: the lost-message notice in every state. */
function lostMessageEntries(): NoticeEntry[] {
  return LOST_MESSAGE_STATES.map((state) =>
    entry('SRJ-1011', 'buildLostMessageNotice', state, () => buildLostMessageNotice('stub-user', state)),
  )
}

/** SRJ-1012: the permission wedge warning, for a persona whose name and key differ. */
function wedgeWarningEntries(): NoticeEntry[] {
  return [
    entry('SRJ-1012', 'buildWedgeWarningText', 'the warning', () => buildWedgeWarningText(PERSONA, personaInstanceId(KEY))),
  ]
}

/**
 * A kill's non-success outcome from an `ErrTmuxKillFailed` (`new` on the class
 * binding of `src/agent-director-errors.ts`, as the stub's builder does), by
 * default the stub's description with a fake token appended.
 */
function killFailedOutcome(description: string = killFailedDescription('outlived-exit-wait')): KillFailure {
  const outcome = killOutcomeOf({ thrown: new ErrTmuxKillFailed('kill', ERR_TMUX_KILL_FAILED_NAME, description) })
  if (outcome.kind !== KILL_OUTCOME_NOT_KILLED || !('killFailed' in outcome) || outcome.killFailed !== true) {
    throw new Error('notice-texts: the kill failure did not give a not-killed kill-failure outcome')
  }
  return outcome as KillFailure
}

/**
 * A CONFLICT answer at a kill (`new` on the `ErrTmuxSessionConflict` binding,
 * as the stub's builder does), the stub's description with a fake token
 * appended.
 */
function conflictAtKill() {
  const session = personaTmuxSessionName(OLD_KEY)
  const description = withToken(errTmuxSessionConflict('kill', 'not-this-launch', session).errDescription, 'teardown-conflict')
  return new ErrTmuxSessionConflict('kill', ERR_TMUX_SESSION_CONFLICT_NAME, description)
}

/** SRJ-1003: the teardown window's notices for a kill's refusal or non-success (one builder an old-life wait uses too). */
function teardownEntries(): NoticeEntry[] {
  const refusals = [
    ['CONFLICT', AD_ERROR_CLASS_CONFLICT, conflictAtKill] as const,
    ['UNUSABLE NAME', AD_ERROR_CLASS_UNUSABLE_NAME, () => errUnusableName('control-character')] as const,
  ]
  const kill = refusals.flatMap(([label, errorClass, error]) =>
    ([KILL_REFUSAL_AT_KILL, KILL_REFUSAL_AT_READ] as const).map((at) =>
      entry('SRJ-1003', 'teardownKillRefusalNoticeText', `${label} at ${at}`, () =>
        teardownKillRefusalNoticeText(personaInstanceId(OLD_KEY), { at, errorClass, error: error() }),
      ),
    ),
  )
  const wait = refusals.flatMap(([label, errorClass, error]) =>
    ([OLD_LIFE_WAIT_AT_KILL, OLD_LIFE_WAIT_AT_STATUS_READ, OLD_LIFE_WAIT_AT_GET, OLD_LIFE_WAIT_AT_FIND_MISSING] as readonly OldLifeWaitRefusalAt[]).map((at) =>
      entry('SRJ-1003', 'oldLifeWaitRefusalNoticeText', `${label} at ${at}`, () =>
        oldLifeWaitRefusalNoticeText(personaInstanceId(OLD_KEY), { at, errorClass, error: error() }),
      ),
    ),
  )
  return [
    ...kill,
    ...wait,
    entry('SRJ-1003', 'teardownKillNotSucceededNoticeText', 'ErrTmuxKillFailed after 3 kills', () =>
      teardownKillNotSucceededNoticeText(personaInstanceId(KEY), killFailedOutcome(), 3),
    ),
  ]
}

/** SRJ-1013: the texts of the startup-errors classes. */
function startupErrorEntries(): NoticeEntry[] {
  const persona = { name: PERSONA.name, key: KEY }
  const ordinaryLog = () =>
    killFailureAlertText(ordinaryContent(personaInstanceId(KEY), { lastKillFailedDescription: killFailedDescription('outlived-exit-wait') }), KILL_FAILURE_CLOSING_LOG_ONLY, false)
  const contexts = [
    ...KILL_FAILURE_CONTEXTS.map((context) => [context, context] as const),
    ...[CLI_COMMAND_STOP_BOTS, CLI_COMMAND_CLEAN_RESTART].map(
      (command) => [`CLI teardown, ${command}`, killFailureCliTeardownEntryContext(command)] as const,
    ),
  ]
  return [
    ...([FOUND_BY_STARTUP_CHECK, FOUND_BY_RUNTIME_RECHECK] as const).flatMap((foundBy) => [
      entry('SRJ-1013', 'buildBelowPhase1FloorMessage', `ad-below-phase1-floor, ${foundBy}`, () =>
        buildBelowPhase1FloorMessage({ foundVersion: DEV_PLACEHOLDER_VERSION, binaryPath: STUB_RESOLVE_DEFAULT_PATH }, foundBy),
      ),
      entry('SRJ-1013', 'buildSystemInstallTooOldMessage', `ad-system-install-too-old, ${foundBy}`, () =>
        buildSystemInstallTooOldMessage({ foundVersion: BELOW_CLIENT_MIN_VERSION, requiredVersion: CLIENT_MIN_VERSION, binaryPath: STUB_RESOLVE_DEFAULT_PATH }, foundBy),
      ),
    ]),
    ...contexts.map(([label, context]) =>
      entry('SRJ-1013', 'killFailureAlertEntryText', `persona-kill-failed, ${label}`, () =>
        killFailureAlertEntryText(`persona=${KEY}`, context, ordinaryLog()),
      ),
    ),
    ...(['line', 'entry'] as const).map((part) =>
      entry('SRJ-1013', 'killFailureStoppedRetryText', `persona-kill-failed, a stopped retry's ${part}`, () =>
        killFailureStoppedRetryText({
          key: KEY,
          decision: { kind: KILL_RETRY_ALERT_ORDINARY, lastKillFailedDescription: killFailedDescription('unverifiable-session-present') },
          context: KILL_FAILURE_CONTEXTS[0],
          lastOutcomeClass: 'UNAVAILABLE',
        })[part],
      ),
    ),
    ...([PERSONA_TEARDOWN_NOTICE_RAISED, PERSONA_TEARDOWN_NOTICE_ALL_CLEAR_AFTER, PERSONA_TEARDOWN_NOTICE_DURING_WAIT] as const satisfies readonly PersonaTeardownNoticeOccasion[]).map((occasion) =>
      entry('SRJ-1013', 'personaTeardownNoticeEntryText', `persona-teardown-notice, ${occasion}`, () =>
        personaTeardownNoticeEntryText(
          `persona=${KEY}`,
          teardownKillRefusalNoticeText(personaInstanceId(KEY), { at: KILL_REFUSAL_AT_KILL, errorClass: AD_ERROR_CLASS_CONFLICT, error: conflictAtKill() }),
          occasion,
        ),
      ),
    ),
    entry('SRJ-1013', 'unclassifiedErrorAlertText', 'persona-unclassified-error', () =>
      personaUnclassifiedErrorEntryText(KEY, unclassifiedErrorAlertText(unclassifiedQuote(), { escapeForSlack: false })),
    ),
    ...([CLI_COMMAND_STOP_BOTS, CLI_COMMAND_CLEAN_RESTART] as const).map((command) =>
      entry('SRJ-1013', 'teardownFailureLine', `cli-teardown-failed, ${command}`, () =>
        teardownFailureLine(command, persona, teardownErrorReportOf(conflictAtKill())),
      ),
    ),
    entry('SRJ-1013', 'cleanRestartNotRestartedAlert', 'clean-restart-not-restarted', () =>
      cleanRestartNotRestartedAlert([{ persona, errorClass: 'UNAVAILABLE' }]),
    ),
    entry('SRJ-1013', 'retiredKeysUnreadableMessage', 'retired-keys-unreadable', () =>
      retiredKeysUnreadableMessage('/state/retired-keys.json', 'is not valid JSON at line 2, column 5'),
    ),
  ]
}

/** SRJ-1017: the stuck-launch posts. */
function stuckLaunchEntries(): NoticeEntry[] {
  return [
    entry('SRJ-1017', 'stuckLaunchRelaunchingText', 'relaunching, default B', () =>
      stuckLaunchRelaunchingText(KEY, adLaunchBoundMs(DEFAULT_AD_SETTINGS_IN_EFFECT)),
    ),
    entry('SRJ-1017', 'stuckLaunchHeldText', 'held, with the attach line', () => stuckLaunchHeldText(KEY, SAMPLE_LAUNCH_START_DEFAULT, false)),
    entry('SRJ-1017', 'stuckLaunchHeldText', 'held, not started by CSCB (no attach line)', () =>
      stuckLaunchHeldText(KEY, SAMPLE_LAUNCH_START_DEFAULT, true),
    ),
  ]
}

/** SRJ-1018: the `ad-config-malformed` onset. */
function adConfigMalformedEntries(): NoticeEntry[] {
  return [
    entry('SRJ-1018', 'adConfigMalformedOnset', "the stub's description", () => adConfigMalformedOnset(errConfigMalformed())),
    entry('SRJ-1018', 'adConfigMalformedOnset', 'token-bearing description', () =>
      adConfigMalformedOnset(errUnknownErrorName('ErrConfigMalformed', withToken(classifyAdError(errConfigMalformed()).message ?? '', 'config'))),
    ),
    entry('SRJ-1018', 'ALL_CLEAR_TEMPLATE', 'all-clear listing ad-config-malformed', () =>
      ALL_CLEAR_TEMPLATE(new Map<OutageClass, ClassRecord>([['ad-config-malformed', {} as ClassRecord]])),
    ),
  ]
}

/** SRJ-1019: the unusable-recorded-name post, for each fault. */
function unusableNameEntries(): NoticeEntry[] {
  return [
    ...UNUSABLE_NAME_FAULTS.map((fault) =>
      entry('SRJ-1019', 'unusableNameNoticeText', fault, () => unusableNameNoticeText(KEY, classifyAdError(errUnusableName(fault)).message)),
    ),
    entry('SRJ-1019', 'unusableNameNoticeText', 'token-bearing description', () =>
      unusableNameNoticeText(KEY, withToken(classifyAdError(errUnusableName('empty')).message ?? '', 'unusable')),
    ),
  ]
}

/** SRJ-1020: the launch-start-not-recorded post. */
function launchStartEntries(): NoticeEntry[] {
  return [entry('SRJ-1020', 'launchStartNotRecordedNoticeText', 'the post', () => launchStartNotRecordedNoticeText(KEY))]
}

/** SRJ-1021: the re-bound socket's `tmux-unavailable` onset and its (existing) all-clear. */
function tmuxServerChangedEntries(): NoticeEntry[] {
  return [
    entry('SRJ-1021', 'tmuxServerChangedOnset', 'the onset', () => tmuxServerChangedOnset()),
    entry('SRJ-1021', 'ALL_CLEAR_TEMPLATE', 'all-clear listing tmux-unavailable', () =>
      ALL_CLEAR_TEMPLATE(new Map<OutageClass, ClassRecord>([['tmux-unavailable', {} as ClassRecord]])),
    ),
  ]
}

/** SRJ-1001: its rules hold for every server notice: the persona prefix and every outage onset. */
function commonEntries(): NoticeEntry[] {
  return [
    entry('SRJ-1001', 'formatPersonaNotice', 'the persona prefix on a recovery post', () =>
      formatPersonaNotice(PERSONA, latchRecoveryText(LATCH_KIND_CONFLICT, LATCH_RECOVERY_REASON_CLEARED_BY_HAND, personaTmuxSessionName(KEY))),
    ),
    ...OUTAGE_CLASS_ORDER.map((outage) =>
      entry('SRJ-1001', 'ONSET_TEMPLATES', `${outage} onset`, () => ONSET_TEMPLATES[outage]('/usr/local/bin/agent-director')),
    ),
    entry('SRJ-1001', 'ALL_CLEAR_TEMPLATE', 'all-clear listing every class', () =>
      ALL_CLEAR_TEMPLATE(new Map<OutageClass, ClassRecord>(OUTAGE_CLASS_ORDER.map((outage) => [outage, {} as ClassRecord]))),
    ),
    entry('SRJ-1001', 'spawnFailureNoticeText', 'token-bearing description', () =>
      spawnFailureNoticeText(errGeneric('spawn', 'ErrTmuxSessionCreate', withToken('tmux new-session failed', 'spawn-failure'))),
    ),
  ]
}

/**
 * SRJ-1001: the spawn-failure notice for each remediation (its description
 * redacted and capped; its Slack escape is checked in `SLACK_QUOTING_NOTICES`)
 * and the restart-cap notice.
 */
function spawnFailureEntries(): NoticeEntry[] {
  return [
    entry('SRJ-1001', 'spawnFailureNoticeText', 'ErrSpawnNotFound', () => spawnFailureNoticeText(errSpawnNotFound())),
    entry('SRJ-1001', 'spawnFailureNoticeText', 'any other error, token-bearing description', () =>
      spawnFailureNoticeText(errGeneric('spawn', 'ErrFromALaterBinary', withToken('the launch failed', 'spawn-failure'))),
    ),
    entry('SRJ-1001', 'restartCapReachedNoticeText', 'the restart cap', () => restartCapReachedNoticeText()),
  ]
}

/** The `cause` of an `auto-restart-disabled` not-connected notice; throws for another reason. */
function notConnectedCause(notice: NotConnectedNotice): string {
  if (notice.reason !== 'auto-restart-disabled') throw new Error(`notice-texts: expected an auto-restart-disabled notice, got ${notice.reason}`)
  return notice.cause
}

/** b.f2b's not-connected notice in each of its six renderings: each reason, and each `autoRestartDisabled` or `streamless` form. */
function notConnectedVariants(): readonly (readonly [label: string, notice: NotConnectedNotice])[] {
  // A real cause, as a launch wait that timed out on an unreadable row words it.
  const cause = notConnectedCause(
    waitTimedOutUnreadReport(`persona=${KEY}`, adLaunchBoundMs(DEFAULT_AD_SETTINGS_IN_EFFECT), 'a stub status failure', AD_ERROR_CLASS_UNAVAILABLE).notice,
  )
  return [
    ['blocked-on-prompt', { reason: 'blocked-on-prompt', autoRestartDisabled: false }],
    ['blocked-on-prompt, auto-restart disabled', { reason: 'blocked-on-prompt', autoRestartDisabled: true }],
    ['unproven-idle', { reason: 'unproven-idle', autoRestartDisabled: false, heldMs: UNPROVEN_IDLE_NOTICE_AFTER_MS }],
    ['unproven-idle, auto-restart disabled', { reason: 'unproven-idle', autoRestartDisabled: true, heldMs: UNPROVEN_IDLE_NOTICE_AFTER_MS }],
    ['auto-restart-disabled, disconnected', { reason: 'auto-restart-disabled', cause }],
    ['auto-restart-disabled, streamless', { reason: 'auto-restart-disabled', cause, streamless: true }],
  ]
}

/** SRJ-1001: b.f2b's not-connected notices, which name `tmux attach` and so carry the human-only sentence. */
function notConnectedEntries(): NoticeEntry[] {
  return notConnectedVariants().map(([label, notice]) =>
    entry('SRJ-1001', 'buildNotConnectedNotice', label, () => buildNotConnectedNotice(KEY, notice)),
  )
}

/** The JSONL persistence safeguard's three notices (b.zak; SRJ-122 keeps their text): one per variant. */
const JSONL_NON_PERSISTENT = 'non-persistent storage'
const JSONL_STALE_PATH = 'stale transcript path'
const JSONL_LOST = 'lost transcript'

/** Where the safeguard's persona lives: never created, so every path resolves lexically. */
const JSONL_BASE_DIR = '/notice-texts-jsonl'
const JSONL_HOME = `${JSONL_BASE_DIR}/home`
/** Mount tables: the persona's storage on tmpfs (Layer 1 warns), or only an ext4 root (Layer 1 is quiet). */
const TMPFS_MOUNTINFO = `1 0 8:1 / / rw - ext4 /dev/sda1 rw\n2 1 0:2 / ${JSONL_BASE_DIR} rw - tmpfs tmpfs rw\n`
const EXT4_MOUNTINFO = '1 0 8:1 / / rw - ext4 /dev/sda1 rw\n'

/**
 * The safeguard's notices as its notice seam receives them, by variant. It
 * has no pure builder, so it runs once here with every effect injected: a
 * capturing seam, no startup-errors record, a fixed mount table, a stub row
 * and stub file and archive reads. Nothing is read from or written to disk
 * but path resolution, and nothing is posted.
 */
async function renderJsonlSafeguardNotices(): Promise<ReadonlyMap<string, string>> {
  const config = makeMultiPersonaConfig([{ name: PERSONA.name, claude_config_dir: `${JSONL_BASE_DIR}/claude` }], JSONL_BASE_DIR)
  const persona = config.personas[0]!
  const texts = new Map<string, string>()
  const capture = (variant: string) => (_key: string, text: string): void => {
    texts.set(variant, text)
  }
  const noRecord = (): void => {}
  runPersonaStorageCheck(persona, capture(JSONL_NON_PERSISTENT), { readMountinfo: () => TMPFS_MOUNTINFO, recordStartupError: noRecord, home: JSONL_HOME })
  const row = cannedGetResult({ state: 'live', jsonl_path: `${JSONL_BASE_DIR}/claude/projects/stale.jsonl`, claude_session_id: 'sess-notice' }, persona, JSONL_HOME)
  const layer2 = (variant: string, deps: { statFn?: (path: string) => boolean; archiveCountSince?: () => number | null }) =>
    runJsonlPersistenceSafeguard(config, capture(variant), {
      readMountinfo: () => EXT4_MOUNTINFO,
      getRow: async () => row,
      statFn: () => false,
      archiveCountSince: () => null,
      recordStartupError: noRecord,
      home: JSONL_HOME,
      ...deps,
    })
  // The recorded path is gone but the transcript is at the resolved one.
  await layer2(JSONL_STALE_PATH, { statFn: (path) => path !== row.jsonl_path })
  // No transcript anywhere, and the archive shows messages since the launch.
  await layer2(JSONL_LOST, { archiveCountSince: () => 3 })
  return texts
}

const JSONL_SAFEGUARD_NOTICES = await renderJsonlSafeguardNotices()

/** The safeguard's notice for `variant`; throws when its run raised none. */
function jsonlSafeguardNotice(variant: string): string {
  const text = JSONL_SAFEGUARD_NOTICES.get(variant)
  if (text === undefined) throw new Error(`notice-texts: the JSONL safeguard raised no ${variant} notice`)
  return text
}

/** SRJ-1001 (SRJ-122): the JSONL persistence safeguard's notices, which name no command. */
function jsonlSafeguardEntries(): NoticeEntry[] {
  return [
    entry('SRJ-1001', 'runPersonaStorageCheck', JSONL_NON_PERSISTENT, () => jsonlSafeguardNotice(JSONL_NON_PERSISTENT)),
    entry('SRJ-1001', 'runJsonlPersistenceSafeguard', JSONL_STALE_PATH, () => jsonlSafeguardNotice(JSONL_STALE_PATH)),
    entry('SRJ-1001', 'runJsonlPersistenceSafeguard', JSONL_LOST, () => jsonlSafeguardNotice(JSONL_LOST)),
  ]
}

/**
 * Slack's control characters, which a path or description agent-director
 * quotes may hold: each diagnosis notice escapes them (final-review fix #1).
 */
const JSONL_SLACK_CONTROLS = '<a>&b'

/**
 * A transcript path list as agent-director's `ErrJsonlMissing` description
 * enumerates it (`<source> <path> (<stat error>)`), the path holding
 * {@link JSONL_SLACK_CONTROLS} and a fake token riding in it.
 */
function jsonlPathsTried(label: string): string {
  return withToken(`jsonl_path ${JSONL_BASE_DIR}/claude/projects/sess-${JSONL_SLACK_CONTROLS}.jsonl (stat: no such file or directory)`, label)
}

/**
 * Where the candidates came from, as the diagnosis words it. A sample, not
 * CSCB's own wording (session-manager.ts does not export its two forms);
 * the notice texts are pinned in tests/session-manager.test.ts.
 */
const JSONL_SAMPLE_PROVENANCE = 'sample provenance of the paths below'

/**
 * SRJ-1001 (SRJ-712): the `ErrJsonlMissing` diagnosis's persona notices, LOST
 * and both INCONCLUSIVE shapes, each quoting agent-director's paths or
 * description, which hold a fake token and {@link JSONL_SLACK_CONTROLS};
 * they name no command.
 */
function jsonlDiagnosisEntries(): NoticeEntry[] {
  return [
    entry('SRJ-1001', 'jsonlTranscriptLostNoticeText', 'lost, token-bearing paths', () =>
      jsonlTranscriptLostNoticeText(3, jsonlPathsTried('jsonl-lost')),
    ),
    entry('SRJ-1001', 'jsonlRowAbsentInconclusiveNoticeText', 'inconclusive, row absent, token-bearing description', () =>
      jsonlRowAbsentInconclusiveNoticeText(withToken(`${errJsonlMissing().errDescription} ${JSONL_SLACK_CONTROLS}`, 'jsonl-row-absent')),
    ),
    entry('SRJ-1001', 'jsonlCandidatesInconclusiveNoticeText', 'inconclusive, unattributable zero, token-bearing candidates', () =>
      jsonlCandidatesInconclusiveNoticeText(UNATTRIBUTABLE_ZERO_REASON, JSONL_SAMPLE_PROVENANCE, jsonlPathsTried('jsonl-candidates')),
    ),
  ]
}

/** The variant of each builder's redaction-and-cap row. */
const CAP_VARIANT = 'redaction and cap: a token-bearing description longer than the cap'

/** Ends an over-cap description: a builder that caps what it quotes never quotes it. */
const CAP_TAIL = 'CAP-TAIL-PAST-THE-CAP'

/**
 * A description from agent-director longer than `MAX_LOGGED_MESSAGE_LENGTH`:
 * `lead`, a fake token, filler past the cap, then {@link CAP_TAIL}.
 */
function overCapDescription(label: string, lead = ''): string {
  const filler = 'more words past the cap '
  return `${lead}${sentinelInMessage(label)} ${filler.repeat(Math.ceil(MAX_LOGGED_MESSAGE_LENGTH / filler.length) + 1)}${CAP_TAIL}`
}

/** SRJ-1001: one redaction-and-cap row per builder that quotes agent-director. */
function capEntries(): NoticeEntry[] {
  const session = personaTmuxSessionName(KEY)
  const refusal = (label: string) => errGeneric('kill', 'ErrTmuxSessionConflict', overCapDescription(label))
  const ordinary = (label: string, closing: KillFailureClosing, forSlack: boolean) =>
    killFailureAlertText(ordinaryContent(personaInstanceId(KEY), { lastKillFailedDescription: overCapDescription(label) }), closing, forSlack)
  return [
    entry('SRJ-1003', 'teardownKillRefusalNoticeText', CAP_VARIANT, () =>
      teardownKillRefusalNoticeText(personaInstanceId(OLD_KEY), { at: KILL_REFUSAL_AT_KILL, errorClass: AD_ERROR_CLASS_CONFLICT, error: refusal('cap-teardown') }),
    ),
    entry('SRJ-1003', 'oldLifeWaitRefusalNoticeText', CAP_VARIANT, () =>
      oldLifeWaitRefusalNoticeText(personaInstanceId(OLD_KEY), { at: OLD_LIFE_WAIT_AT_KILL, errorClass: AD_ERROR_CLASS_CONFLICT, error: refusal('cap-old-life') }),
    ),
    entry('SRJ-1003', 'teardownKillNotSucceededNoticeText', CAP_VARIANT, () =>
      teardownKillNotSucceededNoticeText(personaInstanceId(KEY), killFailedOutcome(overCapDescription('cap-not-killed')), 3),
    ),
    entry('SRJ-1004', 'conflictNoticeText', CAP_VARIANT, () =>
      conflictNoticeText({ sessionName: session, latchCase: LATCH_CASE_LEFTOVER as ConflictLatchCase, description: overCapDescription('cap-conflict') }),
    ),
    entry('SRJ-1007', 'killFailureAlertText', `ordinary, ${CAP_VARIANT}`, () => ordinary('cap-kill-failed', KILL_FAILURE_CLOSING_DESTINATION, true)),
    entry('SRJ-1007', 'killFailureAlertText', `survivor, ${CAP_VARIANT}`, () =>
      killFailureAlertText(
        {
          version: KILL_FAILURE_VERSION_SURVIVOR,
          session,
          survivorDescription: overCapDescription('cap-survivor', `another process of the session's panes outlived it (pid ${STUB_SURVIVOR_PIDS[0]}); `),
        },
        KILL_FAILURE_CLOSING_DESTINATION,
        true,
      ),
    ),
    entry('SRJ-1009', 'unclassifiedErrorAlertText', CAP_VARIANT, () =>
      unclassifiedErrorAlertText(classifyAdError(errGeneric('spawn', 'ErrFromALaterBinary', overCapDescription('cap-unclassified')))),
    ),
    entry('SRJ-1013', 'killFailureAlertEntryText', CAP_VARIANT, () =>
      killFailureAlertEntryText(`persona=${KEY}`, KILL_FAILURE_CONTEXTS[0], ordinary('cap-entry', KILL_FAILURE_CLOSING_LOG_ONLY, false)),
    ),
    entry('SRJ-1013', 'killFailureStoppedRetryText', CAP_VARIANT, () => {
      const { line, entry: startupEntry } = killFailureStoppedRetryText({
        key: KEY,
        decision: { kind: KILL_RETRY_ALERT_ORDINARY, lastKillFailedDescription: overCapDescription('cap-stopped-retry') },
        context: KILL_FAILURE_CONTEXTS[0],
        lastOutcomeClass: AD_ERROR_CLASS_UNAVAILABLE,
      })
      return `${line}\n${startupEntry}`
    }),
    entry('SRJ-1013', 'personaTeardownNoticeEntryText', CAP_VARIANT, () =>
      personaTeardownNoticeEntryText(
        `persona=${KEY}`,
        teardownKillRefusalNoticeText(personaInstanceId(KEY), { at: KILL_REFUSAL_AT_KILL, errorClass: AD_ERROR_CLASS_CONFLICT, error: refusal('cap-teardown-entry') }),
      ),
    ),
    entry('SRJ-1013', 'teardownFailureLine', CAP_VARIANT, () =>
      teardownFailureLine(CLI_COMMAND_STOP_BOTS, { name: PERSONA.name, key: KEY }, teardownErrorReportOf(refusal('cap-cli'))),
    ),
    entry('SRJ-1018', 'adConfigMalformedOnset', CAP_VARIANT, () =>
      adConfigMalformedOnset(errUnknownErrorName('ErrConfigMalformed', overCapDescription('cap-config'))),
    ),
    entry('SRJ-1019', 'unusableNameNoticeText', CAP_VARIANT, () => unusableNameNoticeText(KEY, overCapDescription('cap-unusable'))),
    entry('SRJ-1001', 'spawnFailureNoticeText', CAP_VARIANT, () =>
      spawnFailureNoticeText(errGeneric('spawn', 'ErrFromALaterBinary', overCapDescription('cap-spawn'))),
    ),
    entry('SRJ-1001', 'jsonlTranscriptLostNoticeText', CAP_VARIANT, () => jsonlTranscriptLostNoticeText(3, overCapDescription('cap-jsonl-lost'))),
    entry('SRJ-1001', 'jsonlRowAbsentInconclusiveNoticeText', CAP_VARIANT, () =>
      jsonlRowAbsentInconclusiveNoticeText(overCapDescription('cap-jsonl-row-absent')),
    ),
    entry('SRJ-1001', 'jsonlCandidatesInconclusiveNoticeText', CAP_VARIANT, () =>
      jsonlCandidatesInconclusiveNoticeText(UNATTRIBUTABLE_ZERO_REASON, JSONL_SAMPLE_PROVENANCE, overCapDescription('cap-jsonl-candidates')),
    ),
  ]
}

/**
 * Every Slack notice's output, by SRJ id: every SRJ-10xx notice builder, and
 * under SRJ-1001 every other server notice it names (`NAMED_SLACK_NOTICES`).
 * A new notice joins here (and an id leaves `NOT_APPLICABLE` once a builder
 * is exported).
 */
const NOTICE_CATALOGUE: readonly NoticeEntry[] = Object.freeze([
  ...commonEntries(),
  ...spawnFailureEntries(),
  ...notConnectedEntries(),
  ...jsonlSafeguardEntries(),
  ...jsonlDiagnosisEntries(),
  ...capEntries(),
  ...teardownEntries(),
  ...conflictEntries(),
  ...recoveryEntries(),
  ...tmuxUnresponsiveEntries(),
  ...killFailureEntries(),
  ...invalidFlagsEntries(),
  ...unclassifiedEntries(),
  ...slowRecoveryEntries(),
  ...lostMessageEntries(),
  ...wedgeWarningEntries(),
  ...startupErrorEntries(),
  ...stuckLaunchEntries(),
  ...adConfigMalformedEntries(),
  ...unusableNameEntries(),
  ...launchStartEntries(),
  ...tmuxServerChangedEntries(),
])

/** The SRJ-10xx ids from SRJ-1001 to SRJ-1021 with no notice builder in the catalogue, each with its reason. */
const NOT_APPLICABLE: Readonly<Partial<Record<NoticeSrj, string>>> = Object.freeze({
  'SRJ-1002': 'log-only routing: it routes other notices and has no text of its own',
  'SRJ-1014': 'log lines, not notices: each is asserted with its behaviour',
  'SRJ-1015': 'the start summary line is a server-log line, not a notice',
  'SRJ-1016': 'episodes rate-limit notices and have no text of their own',
})

/** Every id the completeness guard covers: SRJ-1001 to SRJ-1021. */
const GUARDED_IDS: readonly NoticeSrj[] = Array.from({ length: 21 - 1 + 1 }, (_, i) => `SRJ-10${String(1 + i).padStart(2, '0')}` as NoticeSrj)

/**
 * The server notices posted to Slack that SRJ-1001 names beyond the SRJ-10xx
 * builders, by the builder that renders each (the JSONL safeguard's by its
 * entry points, which have no pure builder): the wedge warning, the
 * lost-message notice, the outage onsets and all-clear, the spawn-failure
 * and restart-cap notices, b.f2b's not-connected notices, the JSONL
 * safeguard's notices and the `ErrJsonlMissing` diagnosis's three notices.
 * Each has a catalogue entry.
 */
const NAMED_SLACK_NOTICES: readonly string[] = Object.freeze([
  buildWedgeWarningText.name,
  buildLostMessageNotice.name,
  'ONSET_TEMPLATES',
  'ALL_CLEAR_TEMPLATE',
  spawnFailureNoticeText.name,
  restartCapReachedNoticeText.name,
  buildNotConnectedNotice.name,
  runPersonaStorageCheck.name,
  runJsonlPersistenceSafeguard.name,
  jsonlTranscriptLostNoticeText.name,
  jsonlRowAbsentInconclusiveNoticeText.name,
  jsonlCandidatesInconclusiveNoticeText.name,
])

/** The `ErrJsonlMissing` diagnosis's notice builders (SRJ-712), each of which quotes agent-director. */
const JSONL_DIAGNOSIS_BUILDERS: readonly string[] = Object.freeze([
  jsonlTranscriptLostNoticeText.name,
  jsonlRowAbsentInconclusiveNoticeText.name,
  jsonlCandidatesInconclusiveNoticeText.name,
])

/** A description of agent-director's holding each of Slack's control characters, a broadcast and a mention among them. */
const SLACK_MARKUP_DESCRIPTION = 'quoted <!channel> & <@U0MENTION> end'

/**
 * Every Slack-bound notice that quotes agent-director's description, each
 * rendering `description` in its Slack form (SRJ-1001): the escaping audit's
 * table.
 */
const SLACK_QUOTING_NOTICES: readonly (readonly [title: string, render: (description: string) => string])[] = [
  ['SRJ-1004 conflictNoticeText', (description) =>
    conflictNoticeText({ sessionName: personaTmuxSessionName(KEY), latchCase: LATCH_CASE_LEFTOVER as ConflictLatchCase, description })],
  ['SRJ-1007 killFailureAlertText (Slack)', (description) =>
    killFailureAlertText(ordinaryContent(personaInstanceId(KEY), { lastKillFailedDescription: description }), KILL_FAILURE_CLOSING_DESTINATION, true)],
  ['SRJ-1009 unclassifiedErrorAlertText (Slack)', (description) => unclassifiedErrorAlertText(classifyAdError(errGeneric('spawn', 'ErrFromALaterBinary', description)))],
  ['SRJ-1018 adConfigMalformedOnset', (description) => adConfigMalformedOnset(errUnknownErrorName('ErrConfigMalformed', description))],
  ['SRJ-1019 unusableNameNoticeText', (description) => unusableNameNoticeText(KEY, description)],
  ['SRJ-1001 spawnFailureNoticeText', (description) => spawnFailureNoticeText(errGeneric('spawn', 'ErrTmuxSessionCreate', description))],
  ['SRJ-712 jsonlTranscriptLostNoticeText (a candidate\'s path)', (description) =>
    jsonlTranscriptLostNoticeText(2, jsonlCandidatesText([{ source: 'persisted', path: description, note: 'ENOENT' }]))],
  ['SRJ-712 jsonlCandidatesInconclusiveNoticeText (a candidate\'s note)', (description) =>
    jsonlCandidatesInconclusiveNoticeText(
      UNATTRIBUTABLE_ZERO_REASON,
      JSONL_SAMPLE_PROVENANCE,
      jsonlCandidatesText([{ source: 'persisted', path: '/data/proj/sess.jsonl', note: description }]),
    )],
  ['SRJ-712 jsonlRowAbsentInconclusiveNoticeText (agent-director\'s description)', (description) => jsonlRowAbsentInconclusiveNoticeText(description)],
]

/** `<SRJ id> <builder>: <variant>`, for case titles. */
function titleOf(e: NoticeEntry): string {
  return `${e.srj} ${e.builder}: ${e.variant}`
}

// ---------------------------------------------------------------------------
// The checks
// ---------------------------------------------------------------------------

describe('the clear-latch term finder (tests/test-helpers/clear-latch-terms.ts)', () => {
  test('the list is the command, the route and the underscore and camel-case spellings, imported or derived', () => {
    expect(CLEAR_LATCH_TERMS).toContain(CLEAR_LATCH_COMMAND)
    expect(CLEAR_LATCH_TERMS).toContain(CLEAR_LATCH_ROUTE)
    expect(CLEAR_LATCH_TERMS).toHaveLength(4)
    expect(new Set(CLEAR_LATCH_TERMS.map((t) => t.toLowerCase())).size).toBe(4)
  })

  test.each(CLEAR_LATCH_TERMS.map((term) => [term] as const))('finds %s in a notice text, in any letter case (the checks are not vacuous)', (term) => {
    const notice = latchRecoveryText(LATCH_KIND_HOLD, LATCH_RECOVERY_REASON_CLEARED_BY_HAND, personaTmuxSessionName(KEY))
    expect(clearLatchTermsIn(notice)).toEqual([])
    expect(clearLatchTermsIn(`${notice} Run ${term} to clear it.`)).toContain(term)
    expect(clearLatchTermsIn(`${notice} Run ${term.toUpperCase()} to clear it.`)).toContain(term)
  })

  test('finds nothing in a text that names none', () => {
    expect(clearLatchTermsIn('cleared by hand; clear the latch; latch-clear')).toEqual([])
  })
})

describe('SRJ-511 (AC 47): no SRJ-10xx notice names clear-latch', () => {
  test.each(NOTICE_CATALOGUE.map((e) => [titleOf(e), e] as const))('%s', (_title, e) => {
    const text = e.render()
    expect(text.trim()).not.toBe('')
    expect(clearLatchTermsIn(text)).toEqual([])
  })

  test('the "cleared by hand" recovery text, which a clear-latch clear posts, is in the catalogue', () => {
    expect(NOTICE_CATALOGUE.filter((e) => e.srj === 'SRJ-1005' && e.variant.endsWith('cleared by hand')).map((e) => e.variant)).toEqual([
      `${LATCH_KIND_CONFLICT} latch, cleared by hand`,
      `${LATCH_KIND_HOLD} latch, cleared by hand`,
    ])
  })

  test('every rendered text leaks no token: quoted descriptions are redacted', () => {
    const texts = NOTICE_CATALOGUE.map((e) => [e, e.render()] as const)
    assertNoLeak(Object.fromEntries(texts.map(([e, text]) => [titleOf(e), text])), 'notices')
    // Not vacuous: the fake tokens reach every builder that quotes agent-director, as its redaction placeholder.
    const redacted = [REDACTED_TOKEN_PLACEHOLDER, escapeSlackControlCharacters(REDACTED_TOKEN_PLACEHOLDER)]
    expect([...new Set(texts.filter(([, text]) => redacted.some((r) => text.includes(r))).map(([e]) => e.srj))].sort()).toEqual([
      'SRJ-1001',
      'SRJ-1003',
      'SRJ-1004',
      'SRJ-1007',
      'SRJ-1009',
      'SRJ-1013',
      'SRJ-1018',
      'SRJ-1019',
    ])
  })
})

describe('SRJ-1001: a Slack notice quoting agent-director escapes its description exactly once', () => {
  test.each(SLACK_QUOTING_NOTICES)('%s', (_title, render) => {
    const text = render(SLACK_MARKUP_DESCRIPTION)
    const escaped = escapeSlackControlCharacters(SLACK_MARKUP_DESCRIPTION)
    expect(text.split(escaped)).toHaveLength(2)
    expect(text).not.toContain('<!channel>')
    expect(text).not.toContain('<@U0MENTION>')
    expect(text).not.toContain(escapeSlackControlCharacters(escaped))
  })

  test('self-check: the description is escaped to entities, and escaping it twice gives a different text', () => {
    const escaped = escapeSlackControlCharacters(SLACK_MARKUP_DESCRIPTION)
    expect(escaped).toBe('quoted &lt;!channel&gt; &amp; &lt;@U0MENTION&gt; end')
    expect(escapeSlackControlCharacters(escaped)).not.toBe(escaped)
  })
})

describe('the notice catalogue is complete (SRJ-1001 to SRJ-1021, and every named Slack notice)', () => {
  test('every id has a catalogue entry or a not-applicable reason, never both', () => {
    const catalogued = new Set(NOTICE_CATALOGUE.map((e) => e.srj))
    expect(GUARDED_IDS.filter((id) => !catalogued.has(id) && NOT_APPLICABLE[id] === undefined)).toEqual([])
    expect(GUARDED_IDS.filter((id) => catalogued.has(id) && NOT_APPLICABLE[id] !== undefined)).toEqual([])
  })

  test('every not-applicable id is guarded and has a reason', () => {
    const entries = Object.entries(NOT_APPLICABLE) as [NoticeSrj, string][]
    expect(entries.filter(([id]) => !GUARDED_IDS.includes(id)).map(([id]) => id)).toEqual([])
    expect(entries.filter(([, reason]) => reason.trim() === '').map(([id]) => id)).toEqual([])
  })

  test('the CONFLICT entries cover every row of the conflict-case table and each list-line rendering, and the unusable-name entries every fault', () => {
    expect(NOTICE_CATALOGUE.filter((e) => e.builder === 'conflictNoticeText').map((e) => e.variant)).toEqual(
      expect.arrayContaining([...CONFLICT_CASE_ROWS.map((row) => row.name), ...CONFLICT_LIST_NAME_VARIANTS.map(([variant]) => variant)]),
    )
    // The renderings are what their variants say: the shell-quoted word, or the unsafe-name sentence in place of the list line.
    const rendered = (variant: string) => NOTICE_CATALOGUE.find((e) => e.variant === variant)!.render()
    const [[quotedVariant], ...unsafe] = CONFLICT_LIST_NAME_VARIANTS
    expect(rendered(quotedVariant).includes("--tmux-session-name 'it'\\''s; rm -rf x'`")).toBe(true)
    for (const [variant] of unsafe) {
      expect([variant, rendered(variant).includes(CONFLICT_NOTICE_LIST_LINE_UNSAFE_NAME), rendered(variant).includes('--tmux-session-name')]).toEqual([variant, true, false])
    }
    expect(NOTICE_CATALOGUE.filter((e) => e.builder === 'unusableNameNoticeText').map((e) => e.variant)).toEqual(
      expect.arrayContaining([...UNUSABLE_NAME_FAULTS]),
    )
  })

  test('every named Slack notice has a catalogue entry', () => {
    const builders = new Set(NOTICE_CATALOGUE.map((e) => e.builder))
    expect(NAMED_SLACK_NOTICES.filter((name) => !builders.has(name))).toEqual([])
  })

  test('the named notices are catalogued in every variant: each outage onset, each lost-message state, each not-connected rendering, each JSONL safeguard notice', () => {
    const variantsOf = (...builders: string[]) => NOTICE_CATALOGUE.filter((e) => builders.includes(e.builder)).map((e) => e.variant)
    expect(variantsOf('ONSET_TEMPLATES')).toEqual(expect.arrayContaining(OUTAGE_CLASS_ORDER.map((outage) => `${outage} onset`)))
    expect(variantsOf(buildLostMessageNotice.name)).toEqual(expect.arrayContaining([...LOST_MESSAGE_STATES]))
    expect(variantsOf(buildNotConnectedNotice.name)).toEqual(notConnectedVariants().map(([label]) => label))
    expect(new Set(notConnectedVariants().map(([, notice]) => notice.reason))).toEqual(new Set(['blocked-on-prompt', 'unproven-idle', 'auto-restart-disabled']))
    expect(variantsOf(runPersonaStorageCheck.name, runJsonlPersistenceSafeguard.name)).toEqual([JSONL_NON_PERSISTENT, JSONL_STALE_PATH, JSONL_LOST])
  })

  test('each ErrJsonlMissing diagnosis notice (SRJ-712) is a named Slack notice with a quoting row and a redaction-and-cap row', () => {
    expect(JSONL_DIAGNOSIS_BUILDERS.filter((builder) => !NAMED_SLACK_NOTICES.includes(builder))).toEqual([])
    for (const builder of JSONL_DIAGNOSIS_BUILDERS) {
      const variants = NOTICE_CATALOGUE.filter((e) => e.builder === builder).map((e) => e.variant)
      expect({ builder, cap: variants.filter((v) => v === CAP_VARIANT).length, quoting: variants.filter((v) => v !== CAP_VARIANT).length }).toEqual({
        builder,
        cap: 1,
        quoting: 1,
      })
    }
  })

  test('each ErrJsonlMissing diagnosis notice\'s quoting row escapes the "<", ">" and "&" in its quoted text for Slack, once', () => {
    const quoting = NOTICE_CATALOGUE.filter((e) => JSONL_DIAGNOSIS_BUILDERS.includes(e.builder) && e.variant !== CAP_VARIANT)
    expect(quoting.map((e) => e.builder)).toEqual([...JSONL_DIAGNOSIS_BUILDERS])
    for (const e of quoting) {
      const text = e.render()
      expect({ title: titleOf(e), escaped: text.includes(escapeSlackControlCharacters(JSONL_SLACK_CONTROLS)), raw: /[<>]/.test(text), twice: text.includes(escapeSlackControlCharacters(escapeSlackControlCharacters(JSONL_SLACK_CONTROLS))) }).toEqual({
        title: titleOf(e),
        escaped: true,
        raw: false,
        twice: false,
      })
    }
  })
})

// ---------------------------------------------------------------------------
// SRJ-1001's rules over every catalogued notice
// ---------------------------------------------------------------------------

/**
 * SRJ-1001: a notice names a command when it holds a code span that opens
 * with `agent-director` or `tmux` and a space (a class label such as
 * `tmux-unavailable` is none).
 */
const COMMAND_SPAN = /`(?:agent-director|tmux)\s/

/** The title of agent-director's README section a notice points to; a notice names it only as that quoted title (SRJ-1001). */
const OPERATOR_ACTIONS = 'Operator actions'
const OPERATOR_ACTIONS_TITLE = `"${OPERATOR_ACTIONS}"`

/** Whether `ownText` names "Operator actions" other than as its quoted title, in any letter case (SRJ-1001). */
function namesOperatorActionsUnquoted(ownText: string): boolean {
  return new RegExp(OPERATOR_ACTIONS, 'i').test(ownText.split(OPERATOR_ACTIONS_TITLE).join(''))
}

/** `agent-director kill` named as a command, which only a human's step with its result checked may name (SRJ-1001, SRJ-1007, SRJ-1012). */
const AD_KILL_COMMAND = /`agent-director kill\b/
const CHECKS_THE_RESULT = /check (?:the|its) result/

/** Whether `text` names `agent-director kill` and does not say to check its result (SRJ-1001). */
function namesKillWithoutResultCheck(text: string): boolean {
  return AD_KILL_COMMAND.test(text) && !CHECKS_THE_RESULT.test(text)
}

/**
 * The row-delete form: in one clause (cut at punctuation, a bracket, a dash
 * or a line break), a `delete` in any inflection and a row, in either order,
 * unless the clause is negated ("deletes no row", "the row is not deleted",
 * "don't delete the row", "kills, deletes and respawns nothing").
 */
const CLAUSE_END = String.raw`,.;:!?()\[\]—\n`
const DELETE_VERB = String.raw`\bdelet(?:e|es|ed|ing)\b`
const ROW_NOUN = String.raw`\brows?\b`
const CLAUSE_NEGATION = String.raw`\b(?:no|not|nothing|never|none|nor|without|cannot)\b|n['’]t\b`
const ROW_DELETE = new RegExp(
  `(?:^|[${CLAUSE_END}])(?![^${CLAUSE_END}]*(?:${CLAUSE_NEGATION}))[^${CLAUSE_END}]*` +
    `(?:${DELETE_VERB}[^${CLAUSE_END}]*${ROW_NOUN}|${ROW_NOUN}[^${CLAUSE_END}]*${DELETE_VERB})`,
  'i',
)

/**
 * What no notice names (SRJ-1001), beside `CSCB_OWN_LINE_FORBIDDEN` (a pane
 * kill, a tmux option write, an agent-director row delete, the clear-latch
 * command, a session probe, a label option's name), each with a name a
 * failure shows.
 */
const NOTICE_FORBIDDEN: readonly (readonly [name: string, pattern: RegExp])[] = Object.freeze([
  ['--include-finished, either spelling', /include[-_]finished/i],
  ['tmux kill-session', /\bkill-session\b/i],
  ['tmux kill-server', /\bkill-server\b/i],
  ['a raw tmux kill', /\btmux\s+kill/i],
  ['a process kill', /\b(?:pkill|killall)\b|\bkill\s+-(?:\d+|[A-Z]+)\b|\bkill\s+\d/],
  ['a row delete', ROW_DELETE],
  ['a tmux target without =', /\btmux\b[^`\n]*\s-t\s*(?!=)\S/],
])

/**
 * agent-director's own words, which a quoted description carries and no
 * check takes for CSCB's (SRJ-1001; ADSRD SR-1.4).
 */
const AD_OWN_WORDS: readonly string[] = Object.freeze([NO_KILL_SENT_PHRASE, RETRY_KILL_LATER_PHRASE, NEVER_DELETE_ROW_PHRASE])

/** `text` with agent-director's own words taken out. */
function withoutAdOwnWords(text: string): string {
  return AD_OWN_WORDS.reduce((rest, words) => rest.split(words).join(''), text)
}

/**
 * CSCB's own text of a notice: its own lines (`cscbOwnText`: a CONFLICT's
 * description line dropped, an inline description cut out), with
 * agent-director's own words, which a description quoted in another form
 * (the kill-failure alert's) still carries, let through.
 */
function ownTextOf(notice: string): string {
  return withoutAdOwnWords(cscbOwnText(notice))
}

/** Every SRJ-1001 term `text` names: the names of `NOTICE_FORBIDDEN`'s hits, then `CSCB_OWN_LINE_FORBIDDEN`'s per line. */
function forbiddenTermsIn(text: string): string[] {
  return [
    ...NOTICE_FORBIDDEN.filter(([, pattern]) => pattern.test(text)).map(([name]) => name),
    ...text.split('\n').flatMap(cscbOwnLineForbiddenIn),
  ]
}

/** The builders whose own lines name no session-ending command (SRJ-1001): CONFLICT, unusable-name, launch-start and both stuck-launch texts. */
const SESSION_ENDING_FREE_BUILDERS: readonly string[] = Object.freeze([
  conflictNoticeText.name,
  unusableNameNoticeText.name,
  launchStartNotRecordedNoticeText.name,
  stuckLaunchRelaunchingText.name,
  stuckLaunchHeldText.name,
])

/**
 * The ids whose texts never reach Slack (SRJ-1002): the teardown window's
 * notices (SRJ-1003) and the startup-errors entries (SRJ-1013). They quote
 * agent-director's description as a `message="…"` field, which may carry its
 * own pointer to "Operator actions"; the human-only and title rules, which
 * hold for Slack posts, skip them, and every other rule holds for them too.
 */
const LOG_ONLY_SRJS: readonly NoticeSrj[] = Object.freeze(['SRJ-1003', 'SRJ-1013'])

/** Every catalogue entry with its title, for `test.each`. */
const CASES = NOTICE_CATALOGUE.map((e) => [titleOf(e), e] as const)

/** The entries posted to Slack: every entry outside `LOG_ONLY_SRJS`. */
const SLACK_CASES = CASES.filter(([, e]) => !LOG_ONLY_SRJS.includes(e.srj))

describe('SRJ-1001: no notice names a forbidden term in CSCB\'s own text', () => {
  test.each(CASES)('%s', (_title, e) => {
    expect(forbiddenTermsIn(ownTextOf(e.render()))).toEqual([])
  })
})

describe('SRJ-1001: the CONFLICT, unusable-name, launch-start and stuck-launch posts name no session-ending command in their own lines', () => {
  test.each(CASES.filter(([, e]) => SESSION_ENDING_FREE_BUILDERS.includes(e.builder)))('%s', (_title, e) => {
    expect(cscbOwnLines(e.render()).flatMap((line) => sessionEndingCommandsIn(line).map((form) => `${form} in ${JSON.stringify(line)}`))).toEqual([])
  })

  test('every one of those builders, both stuck-launch texts included, is in the catalogue', () => {
    expect(SESSION_ENDING_FREE_BUILDERS.filter((builder) => !NOTICE_CATALOGUE.some((e) => e.builder === builder))).toEqual([])
  })
})

describe('SRJ-1001: a Slack notice that names a command or "Operator actions" carries the human-only sentence', () => {
  /** Whether `e`'s own text names a command or "Operator actions"; a builder that throws counts, so its case fails. */
  const namesCommandOrPointer = (e: NoticeEntry): boolean => {
    try {
      const own = ownTextOf(e.render())
      return COMMAND_SPAN.test(own) || own.includes(OPERATOR_ACTIONS)
    } catch {
      return true
    }
  }
  const naming = SLACK_CASES.filter(([, e]) => namesCommandOrPointer(e))

  test.each(naming)('%s', (_title, e) => {
    expect(e.render()).toMatch(HUMAN_ONLY_SENTENCE)
  })

  test('the notices that name one include the not-connected notices, the wedge warning, the CONFLICT notice, the kill-failure alert and the held stuck-launch post; the JSONL safeguard and ErrJsonlMissing diagnosis notices name none', () => {
    const builders = new Set(naming.map(([, e]) => e.builder))
    expect(
      [buildNotConnectedNotice.name, buildWedgeWarningText.name, conflictNoticeText.name, killFailureAlertText.name, stuckLaunchHeldText.name].filter(
        (builder) => !builders.has(builder),
      ),
    ).toEqual([])
    expect(naming.filter(([, e]) => e.builder === buildNotConnectedNotice.name)).toHaveLength(notConnectedVariants().length)
    const commandFree = [runPersonaStorageCheck.name, runJsonlPersistenceSafeguard.name, ...JSONL_DIAGNOSIS_BUILDERS]
    expect([...builders].filter((builder) => commandFree.includes(builder))).toEqual([])
  })
})

describe('SRJ-1001: a Slack notice names "Operator actions" only by its quoted title', () => {
  test.each(SLACK_CASES)('%s', (_title, e) => {
    expect(namesOperatorActionsUnquoted(ownTextOf(e.render()))).toBe(false)
  })
})

describe('SRJ-1001: only the ordinary kill-failure alert and the wedge warning name `agent-director kill`, each checking its result', () => {
  test.each(CASES.filter(([, e]) => AD_KILL_COMMAND.test(e.render())))('%s', (_title, e) => {
    expect(namesKillWithoutResultCheck(e.render())).toBe(false)
  })

  test("the builders that name it are those two, and the startup-errors entry that carries the ordinary alert's text", () => {
    const naming = NOTICE_CATALOGUE.filter((e) => AD_KILL_COMMAND.test(e.render()))
    expect([...new Set(naming.map((e) => e.builder))].sort()).toEqual(
      [buildWedgeWarningText.name, killFailureAlertText.name, killFailureAlertEntryText.name].sort(),
    )
    expect(naming.filter((e) => e.builder === killFailureAlertText.name && !e.variant.startsWith(KILL_FAILURE_VERSION_ORDINARY)).map(titleOf)).toEqual([])
    // The survivor version names no command at all.
    expect(NOTICE_CATALOGUE.filter((e) => e.variant.startsWith(KILL_FAILURE_VERSION_SURVIVOR) && COMMAND_SPAN.test(e.render())).map(titleOf)).toEqual([])
  })
})

describe("SRJ-1001: agent-director's quoted words are never CSCB's own", () => {
  /** A description carrying agent-director's three phrases and a session-ending command with a bare tmux target. */
  const description = `${AD_OWN_WORDS.join('; ')}; tmux kill-session -t ${personaTmuxSessionName(KEY)}`
  const notices = [
    ['CONFLICT notice (a description line)', () =>
      conflictNoticeText({ sessionName: personaTmuxSessionName(KEY), latchCase: LATCH_CASE_LEFTOVER as ConflictLatchCase, description })],
    ['unusable-name post (a description inside a sentence)', () => unusableNameNoticeText(KEY, description)],
  ] as const

  test.each(notices)('%s: the checks flag the words in the full text, and the own-lines helper removes them', (_label, render) => {
    const text = render()
    // If they were CSCB's, the checks would fail the notice.
    expect(forbiddenTermsIn(withoutAdOwnWords(text))).not.toEqual([])
    expect(cscbOwnLines(text).flatMap(sessionEndingCommandsIn)).toEqual([])
    expect(text.split('\n').flatMap(sessionEndingCommandsIn)).not.toEqual([])
    // CSCB's own text carries none of them, so they never fail a case.
    expect(AD_OWN_WORDS.filter((words) => cscbOwnText(text).includes(words))).toEqual([])
    expect(forbiddenTermsIn(ownTextOf(text))).toEqual([])
  })

  test("each phrase is agent-director's; \"never delete this row\" is a negated clause the row-delete form passes, and without its \"never\" the form flags it", () => {
    expect(forbiddenTermsIn(NEVER_DELETE_ROW_PHRASE)).toEqual([])
    expect(forbiddenTermsIn(NEVER_DELETE_ROW_PHRASE.replace(/\bnever\s+/i, ''))).toEqual(['a row delete'])
    expect(forbiddenTermsIn(withoutAdOwnWords(NEVER_DELETE_ROW_PHRASE))).toEqual([])
    // The session-ending forms take "kill" only as a command to run, so these two are no hit even unquoted (ADSRD SR-1.4).
    expect([NO_KILL_SENT_PHRASE, RETRY_KILL_LATER_PHRASE].flatMap(sessionEndingCommandsIn)).toEqual([])
  })
})

describe('SRJ-1001: the rule patterns find what they look for (the checks are not vacuous)', () => {
  const session = personaTmuxSessionName(KEY)
  const exact = tmuxExactSessionTarget(session)
  const samples: readonly (readonly [text: string, form: string])[] = [
    ['run it with `--include-finished`', '--include-finished, either spelling'],
    ['set include_finished', '--include-finished, either spelling'],
    [`run \`tmux kill-session -t ${exact}\``, 'tmux kill-session'],
    ['run `tmux kill-server`', 'tmux kill-server'],
    ['tmux kill it', 'a raw tmux kill'],
    [`run \`kill -9 ${STUB_SURVIVOR_PIDS[0]}\``, 'a process kill'],
    ['delete its agent-director row', 'a row delete'],
    ['CSCB deletes its row', 'a row delete'],
    ['CSCB deleted the row', 'a row delete'],
    ['deleting the rows by hand', 'a row delete'],
    ['The row is deleted', 'a row delete'],
    ['the rows were deleted', 'a row delete'],
    ['If it does not answer, delete the row', 'a row delete'],
    [`attach with \`tmux attach -t ${session}\``, 'a tmux target without ='],
  ]

  test.each(samples)('finds it in %s: %s', (text, form) => {
    expect(forbiddenTermsIn(text)).toContain(form)
  })

  test.each([
    ['CSCB kills, deletes and respawns nothing'],
    ['CSCB kills, deletes and respawns no row'],
    ['it deletes no row'],
    ['The row is not deleted'],
    ["don't delete the row"],
    ['on an error, don’t delete or respawn the row'],
    ['the row is kept; nothing is deleted'],
  ])('the row-delete form passes a negated clause: %s', (text) => {
    expect(forbiddenTermsIn(text)).toEqual([])
  })

  test('"Operator actions" is flagged outside its quoted title, in any letter case, and passes as the title', () => {
    expect(namesOperatorActionsUnquoted(`follow ${OPERATOR_ACTIONS}`)).toBe(true)
    expect(namesOperatorActionsUnquoted(`see ${OPERATOR_ACTIONS_TITLE}, then the ${OPERATOR_ACTIONS.toLowerCase()}`)).toBe(true)
    expect(namesOperatorActionsUnquoted(`follow ${OPERATOR_ACTIONS_TITLE}`)).toBe(false)
  })

  test('`agent-director kill` is flagged without "check the result" and passes with it', () => {
    const kill = `\`agent-director kill --claude-instance-id ${personaInstanceId(KEY)}\``
    expect(namesKillWithoutResultCheck(`run ${kill}`)).toBe(true)
    expect(namesKillWithoutResultCheck(`run ${kill}, then check its result`)).toBe(false)
    expect(namesKillWithoutResultCheck(`run ${kill} and check the result`)).toBe(false)
    expect(namesKillWithoutResultCheck(NO_KILL_SENT_PHRASE)).toBe(false)
  })

  test('every form has a sample', () => {
    expect(NOTICE_FORBIDDEN.map(([name]) => name).filter((name) => !samples.some(([, form]) => form === name))).toEqual([])
  })

  test('finds nothing in an exact attach, a class label or a row kept', () => {
    expect(forbiddenTermsIn(`attach with \`tmux attach -t ${exact}\`; \`tmux-unavailable\`; the row is kept`)).toEqual([])
  })

  test('a command span is `agent-director` or `tmux` and a space; a class label is none', () => {
    expect(COMMAND_SPAN.test(`run \`agent-director read-pane --claude-instance-id ${personaInstanceId(KEY)}\``)).toBe(true)
    expect(COMMAND_SPAN.test(`attach with \`tmux attach -t ${exact}\``)).toBe(true)
    expect(COMMAND_SPAN.test('the `tmux-unavailable` outage')).toBe(false)
  })

  test('the human-only sentence matches each of the notices\' wordings, and the catalogue holds each', () => {
    const texts = NOTICE_CATALOGUE.map((e) => e.render())
    for (const ending of ['may act on it.', 'may act on them.', 'may run them.']) {
      expect({ ending, held: texts.some((text) => humanOnlySentencesIn(text).some((sentence) => sentence.endsWith(`sees this post, ${ending}`))) }).toEqual({
        ending,
        held: true,
      })
    }
  })

  test.each([
    ['', 'These commands are for a human only: no bot, including any persona that sees this post, may run them.'],
    ['', 'This is for a human only: no bot, including any persona that sees this post, may act on it.'],
    ['', 'These remedies are for a human only: no bot, including any persona that sees this post, may act on them.'],
    // The SRD's (SRJ-1001) and the docs' wordings.
    ['It says ', 'it is for a human only: no bot, including any persona that sees the post, may act on it.'],
    ['It says ', 'its commands are for a human only: no bot, including a persona that sees the post, may run them.'],
    ['', 'These commands are for a human only: no bot runs them, including a persona that sees the post.'],
    ['', 'This is for a human only: no bot acts on it, including a persona that sees the post.'],
    ['', 'Both notices are for a human only: no bot acts on them, including a persona that sees the post.'],
  ])('the human-only sentence pattern finds the wording %p%p, once', (lead, sentence) => {
    expect(HUMAN_ONLY_SENTENCE.test(sentence)).toBe(true)
    expect(humanOnlySentencesIn(`Run \`tmux attach -t =slack_bot_x\`. ${lead}${sentence} Then more.`)).toEqual([sentence])
  })

  test.each([
    ['no persona clause', 'This is for a human only: no bot may act on it.'],
    ['"may run it"', 'These commands are for a human only: no bot, including any persona that sees this post, may run it.'],
    ['"for humans only"', 'This is for humans only: no bot, including any persona that sees this post, may act on it.'],
    ['no lead-in', 'For a human only: no bot, including any persona that sees this post, may act on it.'],
    ['an unrelated "for a human only" sentence', 'It is for a human only: no bot is offered it.'],
  ])('the human-only sentence pattern finds nothing with %s', (_label, text) => {
    expect(humanOnlySentencesIn(text)).toEqual([])
  })
})

describe('SRJ-1001: a description quoted from agent-director is redacted and capped at MAX_LOGGED_MESSAGE_LENGTH', () => {
  const redacted = [REDACTED_TOKEN_PLACEHOLDER, escapeSlackControlCharacters(REDACTED_TOKEN_PLACEHOLDER)]
  const capRows = CASES.filter(([, e]) => e.variant.endsWith(CAP_VARIANT))

  test.each(capRows)('%s', (_title, e) => {
    const text = e.render()
    assertNoLeak(text, titleOf(e))
    expect(redacted.some((r) => text.includes(r))).toBe(true)
    expect(text).not.toContain(CAP_TAIL)
  })

  test('every builder that quotes agent-director has a redaction-and-cap row', () => {
    const quoting = new Set(NOTICE_CATALOGUE.filter((e) => redacted.some((r) => e.render().includes(r))).map((e) => e.builder))
    const capped = new Set(capRows.map(([, e]) => e.builder))
    expect([...quoting].filter((builder) => !capped.has(builder)).sort()).toEqual([])
  })
})
