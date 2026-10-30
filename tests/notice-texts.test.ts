/**
 * notice-texts.test.ts — The notice catalogue: every exported catalogued notice
 * builder and every other server notice posted to Slack, rendered for every
 * variant it has, held against rules that apply to every notice. checks no notice names `clear-latch` in any
 * spelling (tests/test-helpers/clear-latch-terms.ts). extends the same
 * catalogue, never a second one, with the rest of the contract (67, 78,
 * 85, 86).
 *
 * `NOTICE_CATALOGUE` is one table of entries, each keyed by its behavior group and
 * naming its builder and variant: the CONFLICT notice for every row of the
 * conflict-case table, a description-less (note) latch and a token-bearing
 * description; the recovery notice for each latch kind and each
 * reason, "cleared by hand" included; the `tmux-unresponsive`
 * onset, alert and recovery; the kill-failure alert's ordinary
 * version for each `ErrTmuxKillFailed` description, each instance id, each
 * closing and each form, with no description and with both, and its survivor
 * version for each pid list and closing; the `ErrInvalidFlags` hold
 * the unclassified-error alert; slow recovery
 * typed delivery notices; the
 * permission wedge warning; the startup-errors entries' texts
 * the stuck-launch posts, the held
 * one with and without the attach line; the `ad-config-malformed`
 * onset; the unusable-name post for each fault; the
 * launch-start-not-recorded post; the re-bound socket's onset and
 * the all-clear; and, under the contract (whose rules hold for every
 * server notice posted to Slack), the persona prefix, every outage onset and
 * the all-clear, the spawn-failure notice for each remediation and the
 * restart-cap notice not-connected notice in every rendering,
 * the JSONL persistence safeguard's storage and AD-reference notices (they name no
 * command and keep their text) and the `ErrJsonlMissing` diagnosis's three
 * notices (both uncertainty shapes, each quoting
 * agent-director and naming no command). The teardown window's notices
 * are the kill outcome's one-line renderings. Each builder that quotes
 * agent-director also has one redaction-and-cap row (`CAP_VARIANT`): a
 * token-bearing description longer than `MAX_LOGGED_MESSAGE_LENGTH`.
 * agent-director's words come from the stub's descriptions; a fake token
 * (`sentinelInMessage`) rides in every quoted description that can carry one.
 *
 * Checks, each a `test.each` whose case title names the behavior group, the builder
 * and the variant:
 * - no entry names a `clear-latch` term;
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
 * (`LOG_ONLY_GROUPS`:) quote agent-director's own
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
 * - the completeness guard holds every id from the contract either
 *     in the catalogue or in `NOT_APPLICABLE` with its reason, never both,
 *     and every notice in `NAMED_SLACK_NOTICES` in every variant;
 *   - the hold settle-failure and no-ts prompt lines are one line of safe
 *     identifiers that pass `assertNoLeak`;
 *   - self-checks show each pattern finds what it looks for, and that
 *     agent-director's words in a quoted description would fail the checks
 *     if the own-lines helper stopped removing the description.
 * Thread Memory and shared-state text pins live here; other builders pin
 * their exact text in their own suites.
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
  ERR_TMUX_KILL_FAILED_NAME,
  ERR_TMUX_SESSION_CONFLICT_NAME,
  ErrTmuxKillFailed,
  ErrTmuxSessionConflict,
} from '../src/agent-director-errors.ts'
import {
  KILL_OUTCOME_NOT_KILLED,
  KILL_REFUSAL_AT_KILL,
  KILL_REFUSAL_AT_READ,
  killOutcomeOf,
  teardownKillNotSucceededNoticeText,
  teardownKillRefusalNoticeText,
  type KillFailure,
} from '../src/checked-kill.ts'
import { CLEAR_LATCH_COMMAND, CLEAR_LATCH_ROUTE } from '../src/clear-latch.ts'
import {
  cleanRestartNotRestartedAlert,
  CLI_COMMAND_CLEAN_RESTART,
  CLI_COMMAND_STOP_BOTS,
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
  unusableNameNoticeText,
  type ConflictLatchCase,
  type LatchKind,
  type LatchRecoveryReason,
} from '../src/conflict-latch.ts'
import { DELIVERY_STUCK_AFTER_MS, THREAD_MEMORY_NOTICE_MAX_CHARS } from '../src/delivery-constants.ts'
import {
  buildDeliveryStuckNotice,
  buildMessageNotSavedNotice,
  buildMessageNotTakenInNotice,
  buildMessagesWaitingNotice,
  buildQueueRecordUnreadableNotice,
  MESSAGES_WAITING_STATES,
  type DeliveryStuckReason,
} from '../src/delivery-notices.ts'
import { INVALID_FLAGS_HOLD_ALERT_TEXT } from '../src/invalid-flags-hold.ts'
import { runJsonlPersistenceSafeguard, runPersonaStorageCheck } from '../src/jsonl-persistence-check.ts'
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
import {
  OLD_LIFE_WAIT_AT_FIND_MISSING,
  OLD_LIFE_WAIT_AT_GET,
  OLD_LIFE_WAIT_AT_KILL,
  OLD_LIFE_WAIT_AT_STATUS_READ,
  oldLifeWaitRefusalNoticeText,
  type OldLifeWaitRefusalAt,
} from '../src/old-life-wait.ts'
import {
  adConfigMalformedOnset,
  ALL_CLEAR_TEMPLATE,
  ONSET_TEMPLATES,
  OUTAGE_CLASS_ORDER,
  tmuxServerChangedOnset,
  type ClassRecord,
  type OutageClass,
} from '../src/outage-state.ts'
import { stuckLaunchHeldText, stuckLaunchRelaunchingText } from '../src/pending-row.ts'
import { buildPromptPostedWithoutTsLine, buildWedgeWarningText } from '../src/permission-poller.ts'
import { describeThrownValue, MAX_LOGGED_MESSAGE_LENGTH } from '../src/persona-connection-errors.ts'
import { buildHoldSettleFailedLine } from '../src/persona-destination-hold.ts'
import {
  killFailureStoppedRetryText,
  personaUnclassifiedErrorEntryText,
  tmuxUnresponsiveAlertText,
  tmuxUnresponsiveOnsetText,
  tmuxUnresponsiveRecoveryText,
  unclassifiedErrorAlertText,
} from '../src/persona-episodes.ts'
import { personaInstanceId, personaTmuxSessionName, renderPersonaRef, tmuxExactSessionTarget } from '../src/persona-identity.ts'
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
  restartCapReachedNoticeText,
  spawnFailureNoticeText,
  waitTimedOutUnreadReport,
  type NotConnectedNotice,
} from '../src/session-manager.ts'
import { REDACTED_TOKEN_PLACEHOLDER, redactSlackLogText } from '../src/slack-log-redaction.ts'
import { escapeSlackControlCharacters } from '../src/slack-text-escape.ts'
import { slowRecoveryText } from '../src/slow-recovery.ts'
import {
  THREAD_MEMORY_SLACK_RETRY_WARNING,
  buildThreadMemoryNotSavedNotice, buildThreadMemoryUnreadableNotice,
  buildThreadMemoryJoinsLostNotice, buildThreadMemoryChangedWhileStoppedNotice,
  buildThreadMemoryRecoveredNotice,
  buildThreadMemoryNotSavedLine, buildThreadMemoryUnreadableLine,
  buildThreadMemoryJoinsLostLine, buildThreadMemoryChangedWhileStoppedLine,
  buildThreadMemoryRecoveredLine, buildThreadMemoryQuarantinedLine,
  buildThreadMemoryCompactionFailedLine, buildThreadMemoryRemovalFailedLine,
  buildThreadMemorySealUnreadableLine, buildThreadMemorySealNotSavedLine,
  buildThreadMemoryHoldsNotResolvedLine,
  type ThreadMemoryLoss,
} from '../src/thread-memory-reports.ts'
import { THREAD_MEMORY_DIAGNOSTIC_CLASSES } from '../src/persona-diagnostics.ts'
import { PERSONA_DIAGNOSTIC_CLASSES, SHARED_STATE_STAGED_SLACK_RETRY_WARNING } from '../src/persona-diagnostics.ts'
import {
  SHARED_STATE_NOTICE_MAX_CHANNELS, SHARED_STATE_DIAGNOSTIC_CLASSES, SHARED_STATE_SLACK_RETRY_WARNING,
  buildSharedStateUnresolvedNotice, buildMembershipEvidenceUnresolvedNotice, buildSharedStateRecoveredNotice, buildReloadApplyFailedNotice,
  buildSharedStateDiagnostic, buildSharedStateUnresolvedLine, buildMembershipEvidenceUnresolvedLine, buildSharedStateRecoveredLine,
  type SharedStateCause, type SharedStateClosing, type SharedStateReportScope,
  type MembershipHistoryEvidence, type MembershipReportEvidence, type MembershipReportProblem,
} from '../src/shared-state-reports.ts'

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
import { assertNoLeak, APP_TOKEN_PREFIX, BOT_TOKEN_PREFIX, fakeToken, LEAK_SENTINEL, sentinelInMessage } from './test-helpers/credentials.ts'
import { makeMultiPersonaConfig } from './test-helpers/persona-config.ts'
import { THREAD_CHANNELS, THREAD_ROOTS, threadPath } from './test-helpers/thread-memory.ts'
import { channelPopulation, sharedChannelPath, MEMBERSHIP_FIXTURE_TIME } from './test-helpers/shared-channels.ts'

// ---------------------------------------------------------------------------
// The catalogue
// ---------------------------------------------------------------------------

/** An catalogued requirement id. */
type NoticeGroup = typeof GUARDED_IDS[number]

/** One rendered notice: its behavior group, the builder that renders it, the variant and a renderer. */
interface NoticeEntry {
  readonly group: NoticeGroup
  readonly builder: string
  readonly variant: string
  /** Renders the text; a builder that throws fails its own case. */
  readonly render: () => string
  /** Exact configured fields, one occurrence each; all other output is leak-checked. */
  readonly configuredSpans?: readonly string[]
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

function entry(group: NoticeGroup, builder: string, variant: string, render: () => string, configuredSpans?: readonly string[]): NoticeEntry {
  return Object.freeze({ group, builder, variant, render, configuredSpans })
}

/** Mask only an explicitly preserved field, once. A second copy in an error
 * or an unrelated credential still fails assertNoLeak, even with the same value. */
function withoutConfiguredSpans(text: string, spans: readonly string[] = []): string {
  for (const span of spans) {
    expect(span.length).toBeGreaterThan(0)
    expect(text).toContain(span)
    text = text.replace(span, '[configured field]')
  }
  return text
}

/**
 * list-line renderings beyond a plain name (the component's design note
 * "orchestrator ruling after "): a name the line shell-quotes with a `'\''`
 * in it, and names the line leaves out for the unsafe-name sentence.
 */
const CONFLICT_LIST_NAME_VARIANTS: readonly (readonly [variant: string, sessionName: string])[] = [
  ['list line: a name with a quote and a semicolon, shell-quoted', "it's; rm -rf x"],
  ['list line left out: a name with a control character', 'bad\u001bname'],
  ['list line left out: a name with a newline', 'bad\nname'],
  ['list line left out: a name with a backtick', 'bad`name'],
  ['list line left out: a token-bearing name, which rendering redacts', `bot ${sentinelInMessage('list-name')}`],
]

/** the CONFLICT notice. */
function conflictEntries(): NoticeEntry[] {
  const byRow = CONFLICT_CASE_ROWS.map((row) =>
    entry("conflict", 'conflictNoticeText', row.name, () => {
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
    // A latch from a `provenance_conflict` note has no description (design A2).
    entry("conflict", 'conflictNoticeText', 'note latch: conflicting labels, no description', () =>
      conflictNoticeText({ sessionName: session, latchCase: LATCH_CASE_CONFLICTING_LABELS as ConflictLatchCase }),
    ),
    entry("conflict", 'conflictNoticeText', 'token-bearing description', () =>
      conflictNoticeText({
        sessionName: session,
        latchCase: LATCH_CASE_LEFTOVER as ConflictLatchCase,
        description: withToken(errTmuxSessionConflict('spawn', 'leftover', session).errDescription, 'conflict'),
      }),
    ),
    ...CONFLICT_LIST_NAME_VARIANTS.map(([variant, sessionName]) =>
      entry("conflict", 'conflictNoticeText', variant, () =>
        conflictNoticeText({ sessionName, latchCase: LATCH_CASE_LEFTOVER as ConflictLatchCase }),
      ),
    ),
  ]
}

/** reasons, "cleared by hand" (the `clear-latch` clear) included. */
const RECOVERY_REASONS: readonly (readonly [label: string, reason: LatchRecoveryReason])[] = [
  ['row reads ended', latchRecoveryReasonRowReads('ended')],
  ['row reads missing', latchRecoveryReasonRowReads('missing')],
  ['row gone', LATCH_RECOVERY_REASON_ROW_GONE],
  ['retry not refused', LATCH_RECOVERY_REASON_RETRY_NOT_REFUSED],
  ['relaunch not refused', LATCH_RECOVERY_REASON_RELAUNCH_NOT_REFUSED],
  ['cleared by hand', LATCH_RECOVERY_REASON_CLEARED_BY_HAND],
]

/** the recovery notice, for each latch kind and reason. */
function recoveryEntries(): NoticeEntry[] {
  const kinds: readonly LatchKind[] = [LATCH_KIND_CONFLICT, LATCH_KIND_HOLD]
  return kinds.flatMap((kind) =>
    RECOVERY_REASONS.map(([label, reason]) =>
      entry("latch-recovery", 'latchRecoveryText', `${kind} latch, ${label}`, () =>
        latchRecoveryText(kind, reason, personaTmuxSessionName(KEY)),
      ),
    ),
  )
}

/** `tmux-unresponsive`. */
function tmuxUnresponsiveEntries(): NoticeEntry[] {
  return [
    entry("tmux-unresponsive", 'tmuxUnresponsiveOnsetText', 'onset', () => tmuxUnresponsiveOnsetText(KEY)),
    entry("tmux-unresponsive", 'tmuxUnresponsiveAlertText', 'alert at the default threshold', () =>
      tmuxUnresponsiveAlertText(KEY, adAlertThresholdMs(DEFAULT_AD_SETTINGS_IN_EFFECT)),
    ),
    entry("tmux-unresponsive", 'tmuxUnresponsiveRecoveryText', 'recovery', () => tmuxUnresponsiveRecoveryText(KEY)),
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

/** the kill-failure alert, both versions. */
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
          entry("kill-failure", 'killFailureAlertText', `ordinary, ${idLabel}, ${quoteLabel}, closing ${closing}, ${formLabel}`, () =>
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
        entry("kill-failure", 'killFailureAlertText', `survivor, ${pidLabel}, closing ${closing}, ${formLabel}`, () =>
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

/** the `ErrInvalidFlags` hold alert, a fixed text. */
function invalidFlagsEntries(): NoticeEntry[] {
  return [entry("invalid-flags", 'INVALID_FLAGS_HOLD_ALERT_TEXT', 'the alert', () => INVALID_FLAGS_HOLD_ALERT_TEXT)]
}

/** An unclassified answer whose message carries a fake token. */
function unclassifiedQuote() {
  return classifyAdError(errGeneric('spawn', 'ErrFromALaterBinary', withToken('something new went wrong', 'unclassified')))
}

/** the unclassified-error alert, posted and log-only. */
function unclassifiedEntries(): NoticeEntry[] {
  return [
    entry("unclassified-error", 'unclassifiedErrorAlertText', 'Slack', () => unclassifiedErrorAlertText(unclassifiedQuote())),
    entry("unclassified-error", 'unclassifiedErrorAlertText', 'log-only', () =>
      unclassifiedErrorAlertText(unclassifiedQuote(), { escapeForSlack: false }),
    ),
    entry("unclassified-error", 'unclassifiedErrorAlertText', 'no name and no message', () =>
      unclassifiedErrorAlertText({}),
    ),
  ]
}

/** slow dead-session recovery. */
function slowRecoveryEntries(): NoticeEntry[] {
  return [entry("slow-recovery", 'slowRecoveryText', 'the post', () => slowRecoveryText(KEY))]
}

/** the permission wedge warning, for a persona whose name and key differ. */
function wedgeWarningEntries(): NoticeEntry[] {
  return [
    entry("permission-wedge", 'buildWedgeWarningText', 'the warning', () => buildWedgeWarningText(PERSONA, personaInstanceId(KEY))),
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

/** the teardown window's notices for a kill's refusal or non-success (one builder an old-life wait uses too). */
function teardownEntries(): NoticeEntry[] {
  const refusals = [
    ['CONFLICT', AD_ERROR_CLASS_CONFLICT, conflictAtKill] as const,
    ['UNUSABLE NAME', AD_ERROR_CLASS_UNUSABLE_NAME, () => errUnusableName('control-character')] as const,
  ]
  const kill = refusals.flatMap(([label, errorClass, error]) =>
    ([KILL_REFUSAL_AT_KILL, KILL_REFUSAL_AT_READ] as const).map((at) =>
      entry("teardown", 'teardownKillRefusalNoticeText', `${label} at ${at}`, () =>
        teardownKillRefusalNoticeText(personaInstanceId(OLD_KEY), { at, errorClass, error: error() }),
      ),
    ),
  )
  const wait = refusals.flatMap(([label, errorClass, error]) =>
    ([OLD_LIFE_WAIT_AT_KILL, OLD_LIFE_WAIT_AT_STATUS_READ, OLD_LIFE_WAIT_AT_GET, OLD_LIFE_WAIT_AT_FIND_MISSING] as readonly OldLifeWaitRefusalAt[]).map((at) =>
      entry("teardown", 'oldLifeWaitRefusalNoticeText', `${label} at ${at}`, () =>
        oldLifeWaitRefusalNoticeText(personaInstanceId(OLD_KEY), { at, errorClass, error: error() }),
      ),
    ),
  )
  return [
    ...kill,
    ...wait,
    entry("teardown", 'teardownKillNotSucceededNoticeText', 'ErrTmuxKillFailed after 3 kills', () =>
      teardownKillNotSucceededNoticeText(personaInstanceId(KEY), killFailedOutcome(), 3),
    ),
  ]
}

/** the texts of the startup-errors classes. */
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
      entry("startup-errors", 'buildBelowPhase1FloorMessage', `ad-below-phase1-floor, ${foundBy}`, () =>
        buildBelowPhase1FloorMessage({ foundVersion: DEV_PLACEHOLDER_VERSION, binaryPath: STUB_RESOLVE_DEFAULT_PATH }, foundBy),
      ),
      entry("startup-errors", 'buildSystemInstallTooOldMessage', `ad-system-install-too-old, ${foundBy}`, () =>
        buildSystemInstallTooOldMessage({ foundVersion: BELOW_CLIENT_MIN_VERSION, requiredVersion: CLIENT_MIN_VERSION, binaryPath: STUB_RESOLVE_DEFAULT_PATH }, foundBy),
      ),
    ]),
    ...contexts.map(([label, context]) =>
      entry("startup-errors", 'killFailureAlertEntryText', `persona-kill-failed, ${label}`, () =>
        killFailureAlertEntryText(`persona=${KEY}`, context, ordinaryLog()),
      ),
    ),
    ...(['line', 'entry'] as const).map((part) =>
      entry("startup-errors", 'killFailureStoppedRetryText', `persona-kill-failed, a stopped retry's ${part}`, () =>
        killFailureStoppedRetryText({
          key: KEY,
          decision: { kind: KILL_RETRY_ALERT_ORDINARY, lastKillFailedDescription: killFailedDescription('unverifiable-session-present') },
          context: KILL_FAILURE_CONTEXTS[0],
          lastOutcomeClass: 'UNAVAILABLE',
        })[part],
      ),
    ),
    ...([PERSONA_TEARDOWN_NOTICE_RAISED, PERSONA_TEARDOWN_NOTICE_ALL_CLEAR_AFTER, PERSONA_TEARDOWN_NOTICE_DURING_WAIT] as const satisfies readonly PersonaTeardownNoticeOccasion[]).map((occasion) =>
      entry("startup-errors", 'personaTeardownNoticeEntryText', `persona-teardown-notice, ${occasion}`, () =>
        personaTeardownNoticeEntryText(
          `persona=${KEY}`,
          teardownKillRefusalNoticeText(personaInstanceId(KEY), { at: KILL_REFUSAL_AT_KILL, errorClass: AD_ERROR_CLASS_CONFLICT, error: conflictAtKill() }),
          occasion,
        ),
      ),
    ),
    entry("startup-errors", 'unclassifiedErrorAlertText', 'persona-unclassified-error', () =>
      personaUnclassifiedErrorEntryText(KEY, unclassifiedErrorAlertText(unclassifiedQuote(), { escapeForSlack: false })),
    ),
    ...([CLI_COMMAND_STOP_BOTS, CLI_COMMAND_CLEAN_RESTART] as const).map((command) =>
      entry("startup-errors", 'teardownFailureLine', `cli-teardown-failed, ${command}`, () =>
        teardownFailureLine(command, persona, teardownErrorReportOf(conflictAtKill())),
      ),
    ),
    entry("startup-errors", 'cleanRestartNotRestartedAlert', 'clean-restart-not-restarted', () =>
      cleanRestartNotRestartedAlert([{ persona, errorClass: 'UNAVAILABLE' }]),
    ),
    entry("startup-errors", 'retiredKeysUnreadableMessage', 'retired-keys-unreadable', () =>
      retiredKeysUnreadableMessage('/state/retired-keys.json', 'is not valid JSON at line 2, column 5'),
    ),
  ]
}

/** the stuck-launch posts. */
function stuckLaunchEntries(): NoticeEntry[] {
  return [
    entry("stuck-launch", 'stuckLaunchRelaunchingText', 'relaunching, default B', () =>
      stuckLaunchRelaunchingText(KEY, adLaunchBoundMs(DEFAULT_AD_SETTINGS_IN_EFFECT)),
    ),
    entry("stuck-launch", 'stuckLaunchHeldText', 'held, with the attach line', () => stuckLaunchHeldText(KEY, SAMPLE_LAUNCH_START_DEFAULT, false)),
    entry("stuck-launch", 'stuckLaunchHeldText', 'held, not started by CSCB (no attach line)', () =>
      stuckLaunchHeldText(KEY, SAMPLE_LAUNCH_START_DEFAULT, true),
    ),
  ]
}

/** the `ad-config-malformed` onset. */
function adConfigMalformedEntries(): NoticeEntry[] {
  return [
    entry("ad-config-malformed", 'adConfigMalformedOnset', "the stub's description", () => adConfigMalformedOnset(errConfigMalformed())),
    entry("ad-config-malformed", 'adConfigMalformedOnset', 'token-bearing description', () =>
      adConfigMalformedOnset(errUnknownErrorName('ErrConfigMalformed', withToken(classifyAdError(errConfigMalformed()).message ?? '', 'config'))),
    ),
    entry("ad-config-malformed", 'ALL_CLEAR_TEMPLATE', 'all-clear listing ad-config-malformed', () =>
      ALL_CLEAR_TEMPLATE(new Map<OutageClass, ClassRecord>([['ad-config-malformed', {} as ClassRecord]])),
    ),
  ]
}

/** the unusable-recorded-name post, for each fault. */
function unusableNameEntries(): NoticeEntry[] {
  return [
    ...UNUSABLE_NAME_FAULTS.map((fault) =>
      entry("unusable-name", 'unusableNameNoticeText', fault, () => unusableNameNoticeText(KEY, classifyAdError(errUnusableName(fault)).message)),
    ),
    entry("unusable-name", 'unusableNameNoticeText', 'token-bearing description', () =>
      unusableNameNoticeText(KEY, withToken(classifyAdError(errUnusableName('empty')).message ?? '', 'unusable')),
    ),
  ]
}

/** the launch-start-not-recorded post. */
function launchStartEntries(): NoticeEntry[] {
  return [entry("launch-start-missing", 'launchStartNotRecordedNoticeText', 'the post', () => launchStartNotRecordedNoticeText(KEY))]
}

/** the re-bound socket's `tmux-unavailable` onset and its (existing) all-clear. */
function tmuxServerChangedEntries(): NoticeEntry[] {
  return [
    entry("tmux-server-changed", 'tmuxServerChangedOnset', 'the onset', () => tmuxServerChangedOnset()),
    entry("tmux-server-changed", 'ALL_CLEAR_TEMPLATE', 'all-clear listing tmux-unavailable', () =>
      ALL_CLEAR_TEMPLATE(new Map<OutageClass, ClassRecord>([['tmux-unavailable', {} as ClassRecord]])),
    ),
  ]
}

/** its rules hold for every server notice: the persona prefix and every outage onset. */
function commonEntries(): NoticeEntry[] {
  return [
    entry("common", 'formatPersonaNotice', 'the persona prefix on a recovery post', () =>
      formatPersonaNotice(PERSONA, latchRecoveryText(LATCH_KIND_CONFLICT, LATCH_RECOVERY_REASON_CLEARED_BY_HAND, personaTmuxSessionName(KEY))),
    ),
    ...OUTAGE_CLASS_ORDER.map((outage) =>
      entry("common", 'ONSET_TEMPLATES', `${outage} onset`, () => ONSET_TEMPLATES[outage]('/usr/local/bin/agent-director')),
    ),
    entry("common", 'ALL_CLEAR_TEMPLATE', 'all-clear listing every class', () =>
      ALL_CLEAR_TEMPLATE(new Map<OutageClass, ClassRecord>(OUTAGE_CLASS_ORDER.map((outage) => [outage, {} as ClassRecord]))),
    ),
    entry("common", 'spawnFailureNoticeText', 'token-bearing description', () =>
      spawnFailureNoticeText(errGeneric('spawn', 'ErrTmuxSessionCreate', withToken('tmux new-session failed', 'spawn-failure'))),
    ),
  ]
}

/**
 * the spawn-failure notice for each remediation (its description
 * redacted and capped; its Slack escape is checked in `SLACK_QUOTING_NOTICES`)
 * and the restart-cap notice.
 */
function spawnFailureEntries(): NoticeEntry[] {
  return [
    entry("common", 'spawnFailureNoticeText', 'ErrSpawnNotFound', () => spawnFailureNoticeText(errSpawnNotFound())),
    entry("common", 'spawnFailureNoticeText', 'any other error, token-bearing description', () =>
      spawnFailureNoticeText(errGeneric('spawn', 'ErrFromALaterBinary', withToken('the launch failed', 'spawn-failure'))),
    ),
    entry("common", 'restartCapReachedNoticeText', 'the restart cap', () => restartCapReachedNoticeText()),
  ]
}

/** The `cause` of an `auto-restart-disabled` not-connected notice; throws for another reason. */
function notConnectedCause(notice: NotConnectedNotice): string {
  if (notice.reason !== 'auto-restart-disabled') throw new Error(`notice-texts: expected an auto-restart-disabled notice, got ${notice.reason}`)
  return notice.cause
}

/** Retained-message MCP notices for authoritative AD prompt and restart states. */
function notConnectedVariants(): readonly (readonly [label: string, notice: NotConnectedNotice])[] {
  // A real cause, as a launch wait that timed out on an unreadable row words it.
  const cause = notConnectedCause(
    waitTimedOutUnreadReport(`persona=${KEY}`, adLaunchBoundMs(DEFAULT_AD_SETTINGS_IN_EFFECT), 'a stub status failure', AD_ERROR_CLASS_UNAVAILABLE).notice,
  )
  return [
    ['blocked-on-prompt', { reason: 'blocked-on-prompt', autoRestartDisabled: false }],
    ['blocked-on-prompt, auto-restart disabled', { reason: 'blocked-on-prompt', autoRestartDisabled: true }],
    ['auto-restart-disabled, disconnected', { reason: 'auto-restart-disabled', cause }],
  ]
}

/** not-connected notices, which name `tmux attach` and so carry the human-only sentence. */
function notConnectedEntries(): NoticeEntry[] {
  return notConnectedVariants().map(([label, notice]) =>
    entry("common", 'buildNotConnectedNotice', label, () => buildNotConnectedNotice(KEY, notice)),
  )
}

/** variants join the existing catalogue and all its safety checks. */
const DELIVERY_STUCK_REASONS: readonly DeliveryStuckReason[] = [
  'relay-off', 'mcp', 'refused', 'transcript',
  'queue-unwritable', 'not-taken-in', 'dialog-hold',
]
function deliveryEntries(): NoticeEntry[] {
  return [
    entry("common", buildMessageNotSavedNotice.name, 'store failed', () => buildMessageNotSavedNotice(PERSONA.name, 'U0SENDER1')),
    ...DELIVERY_STUCK_REASONS.map((reason) => entry("common", buildDeliveryStuckNotice.name, reason, () =>
      buildDeliveryStuckNotice(PERSONA.name, KEY, 2, DELIVERY_STUCK_AFTER_MS + 1, reason, 3))),
    entry("common", buildMessageNotTakenInNotice.name, 'unconfirmed first retype', () => buildMessageNotTakenInNotice(PERSONA.name, 'U0SENDER1')),
    ...MESSAGES_WAITING_STATES.map((state) => entry("common", buildMessagesWaitingNotice.name, state, () =>
      buildMessagesWaitingNotice(PERSONA.name, 2, DELIVERY_STUCK_AFTER_MS, state))),
    entry("common", buildQueueRecordUnreadableNotice.name, 'unreadable accepted record', () =>
      buildQueueRecordUnreadableNotice(PERSONA.name, 2, '/scratch/queue/quarantined.jsonl')),
  ]
}

// Metadata only: these shared fixture identifiers are never read from disk.
const MEMORY_CHANNELS = [THREAD_CHANNELS.primary, THREAD_CHANNELS.secondary]
const MEMORY_PATH = threadPath('/scratch/notice-texts', KEY)
const MEMORY_BODY = 'THREAD-MEMORY-MESSAGE-BODY-MUST-NOT-BE-RENDERED'
const MEMORY_USER = 'THREAD-MEMORY-USER-NAME-MUST-NOT-BE-RENDERED'
const memoryRef = () => renderPersonaRef(PERSONA.name, KEY)
function memoryError(path = memoryTokenPath()) {
  return Object.assign(new Error(`cannot write <journal> & ${sentinelInMessage('memory-error')}; path=${JSON.stringify(path)}`), {
    code: 'EACCES', data: { text: MEMORY_BODY, user: MEMORY_USER, credentials: LEAK_SENTINEL },
  })
}
const memoryTokenPath = () => threadPath(`/scratch/${fakeToken(BOT_TOKEN_PREFIX, 'memory-path')}/<journal>&`, KEY)
const MEMORY_CONFIGURED_PATHS = [
  { label: 'ordinary path', path: MEMORY_PATH },
  { label: 'bot-token segment and Slack controls', path: memoryTokenPath() },
  { label: 'app-token segment', path: threadPath(`/scratch/${fakeToken(APP_TOKEN_PREFIX, 'memory-path')}`, KEY) },
  { label: 'quotes, backslash and line separators', path: threadPath('/scratch/"quoted"\\\r\n\t\u2028\u2029/<journal>&', KEY) },
]
/** JSON is the oracle for preserving a path; Unicode line separators must
 * also be escaped so a diagnostic stays on one physical line. */
const quotedMemoryPath = (path: string) => JSON.stringify(path).replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029')
const MEMORY_CONFIGURED_NAMES = [
  { label: 'bot-token name', name: fakeToken(BOT_TOKEN_PREFIX, 'configured-name') },
  { label: 'app-token name', name: fakeToken(APP_TOKEN_PREFIX, 'configured-name') },
  { label: 'embedded token', name: `Ops ${fakeToken(BOT_TOKEN_PREFIX, 'embedded-name')} bot` },
  { label: 'quoted name with Slack controls', name: `Ops "<&>" \\ ${fakeToken(APP_TOKEN_PREFIX, 'quoted-name')}` },
  { label: 'long name has no non-loss excerpt', name: 'Ops 🚀 <&> '.repeat(300) },
]
const MEMORY_NON_LOSS_NOTICES = [
  { builder: buildThreadMemoryNotSavedNotice.name, variant: 'not saved', build: (ref: string) => buildThreadMemoryNotSavedNotice(ref, MEMORY_CHANNELS, MEMORY_PATH, 'journal-append', memoryError()) },
  { builder: buildThreadMemoryUnreadableNotice.name, variant: 'unreadable', build: (ref: string) => buildThreadMemoryUnreadableNotice(ref, MEMORY_CHANNELS, MEMORY_PATH) },
  ...(['changed', 'unclean'] as const).map(wording => ({ builder: buildThreadMemoryChangedWhileStoppedNotice.name, variant: wording, build: (ref: string) => buildThreadMemoryChangedWhileStoppedNotice(ref, MEMORY_CHANNELS, wording) })),
  { builder: buildThreadMemoryRecoveredNotice.name, variant: 'recovered', build: (ref: string) => buildThreadMemoryRecoveredNotice(ref, MEMORY_CHANNELS) },
]
const MEMORY_LOSSES: readonly (readonly [string, () => ThreadMemoryLoss])[] = [
  ['threads only', () => ({ threads: [{ channel: THREAD_CHANNELS.primary, root: THREAD_ROOTS.primary }], messages: [] })],
  ['messages only', () => ({ threads: [], messages: [{ channel: THREAD_CHANNELS.secondary, ts: THREAD_ROOTS.secondary }] })],
  ['unreadable identities only', () => ({ threads: [], messages: [], unreadableLines: 3 })],
  ['mixed losses', () => ({
    threads: [{ channel: THREAD_CHANNELS.primary, root: THREAD_ROOTS.primary }],
    messages: [{ channel: THREAD_CHANNELS.secondary, ts: THREAD_ROOTS.secondary }], unreadableLines: 3,
  })],
  ['identifier overflow', () => ({
    threads: Array.from({ length: 120 }, (_, i) => ({ channel: THREAD_CHANNELS.primary, root: `1700000000.${String(i).padStart(6, '0')}` })),
    messages: Array.from({ length: 120 }, (_, i) => ({ channel: THREAD_CHANNELS.secondary, ts: `1700000001.${String(i).padStart(6, '0')}` })),
    unreadableLines: 3,
  })],
]
function renderMemoryLoss(persona: { name: string; key: string }, loss: ThreadMemoryLoss): string {
  const notice = buildThreadMemoryJoinsLostNotice(persona, loss)
  return formatPersonaNotice(persona, notice.text, notice.options)
}
const oneThreadLoss = (): ThreadMemoryLoss => ({ threads: [{ channel: THREAD_CHANNELS.primary, root: THREAD_ROOTS.primary }], messages: [] })
/** A full-name oracle from the small pinned notice, with no budgeting logic. */
function fullLossForName(name: string): string {
  const ref = escapeSlackControlCharacters(renderPersonaRef(name, KEY))
  const small = buildThreadMemoryJoinsLostNotice(PERSONA, oneThreadLoss())
  return formatPersonaNotice({ name, key: KEY }, small.text.replaceAll(memoryRef(), ref), { personaRef: ref })
}
const lastFittingNameLength = () => Math.floor((THREAD_MEMORY_NOTICE_MAX_CHARS - fullLossForName('').length) / 2)
const MEMORY_NAMES = [
  { label: 'ordinary name longer than excerpt', name: () => 'Alpha <&> '.repeat(8), excerpt: false },
  { label: 'just below full-name threshold', name: () => 'N'.repeat(lastFittingNameLength()), excerpt: false },
  { label: 'just above full-name threshold', name: () => 'N'.repeat(lastFittingNameLength() + 1), excerpt: true },
  { label: '2100-character name', name: () => 'N'.repeat(2100), excerpt: true },
  { label: 'Slack escaping alone crosses threshold', name: () => 'N'.repeat(lastFittingNameLength() - 2) + '&', excerpt: true },
  { label: 'surrogate pair at excerpt boundary', name: () => 'N'.repeat(63) + '🚀' + 'tail'.repeat(600), excerpt: true },
  { label: 'entity at excerpt boundary', name: () => 'N'.repeat(63) + '&' + '<tail>'.repeat(600), excerpt: true },
  { label: 'JSON quoting at excerpt boundary', name: () => 'N'.repeat(63) + '"\\' + 'tail'.repeat(600), excerpt: true },
]
function threadMemoryEntries(): NoticeEntry[] {
  const row = (builder: string, variant: string, render: () => string, configuredSpans?: readonly string[]) => entry('thread-memory', builder, variant, render, configuredSpans)
  const path = escapeSlackControlCharacters(quotedMemoryPath(memoryTokenPath()))
  return [
    row(buildThreadMemoryNotSavedNotice.name, 'all channels; token-bearing path and error', () =>
      formatPersonaNotice(PERSONA, buildThreadMemoryNotSavedNotice(memoryRef(), MEMORY_CHANNELS, memoryTokenPath(), 'journal-append', memoryError())), [`Could not save ${path} (`]),
    row(buildThreadMemoryUnreadableNotice.name, 'all channels; token-bearing path', () =>
      formatPersonaNotice(PERSONA, buildThreadMemoryUnreadableNotice(memoryRef(), MEMORY_CHANNELS, memoryTokenPath())), [`Cannot read ${path}.`]),
    ...(['changed', 'unclean'] as const).map(wording => row(buildThreadMemoryChangedWhileStoppedNotice.name, wording, () =>
      formatPersonaNotice(PERSONA, buildThreadMemoryChangedWhileStoppedNotice(memoryRef(), MEMORY_CHANNELS, wording)))),
    row(buildThreadMemoryRecoveredNotice.name, 'all channels', () =>
      formatPersonaNotice(PERSONA, buildThreadMemoryRecoveredNotice(memoryRef(), MEMORY_CHANNELS))),
    ...MEMORY_LOSSES.map(([variant, loss]) => row(buildThreadMemoryJoinsLostNotice.name, variant, () => renderMemoryLoss(PERSONA, loss()))),
    ...MEMORY_NAMES.map(({ label, name }) => row(buildThreadMemoryJoinsLostNotice.name, label, () => renderMemoryLoss({ name: name(), key: KEY }, oneThreadLoss()))),
    ...MEMORY_CONFIGURED_NAMES.flatMap(({ label, name }) => MEMORY_NON_LOSS_NOTICES.map(({ builder, variant, build }) => {
      const ref = renderPersonaRef(name, KEY)
      return row(builder, `${variant}; ${label}`, () => formatPersonaNotice({ name, key: KEY }, build(ref)), [
        `Persona ${ref}: `, ` — ${escapeSlackControlCharacters(ref)}; channels:`,
      ])
    })),
  ]
}

// Record keys make additions to the exported unions require a catalogue row.
const SHARED_CAUSES = { unsynced: true, 'evidence-changed': true, 'restoration-staged': true, 'retirement-unresolved': true, 'not-saved': true } satisfies Record<SharedStateCause, true>
const SHARED_HISTORY = { 'absence-order': true, 'event-history': true } satisfies Record<MembershipHistoryEvidence, true>
const SHARED_PROBLEMS = { deadline: true, access: true, authentication: true, 'installation-unverified': true, 'malformed-page': true, 'current-membership-missing': true, 'eligibility-missing': true, 'event-order-conflict': true } satisfies Record<MembershipReportProblem, true>
const SHARED_CLOSINGS = { state: true, evidence: true, repair: true } satisfies Record<SharedStateClosing, true>
const sharedCauses = Object.keys(SHARED_CAUSES) as SharedStateCause[]
const sharedHistory = Object.keys(SHARED_HISTORY) as MembershipHistoryEvidence[]
const sharedProblems = Object.keys(SHARED_PROBLEMS) as MembershipReportProblem[]
const sharedClosings = Object.keys(SHARED_CLOSINGS) as SharedStateClosing[]
const SHARED_CHANNELS = channelPopulation(SHARED_STATE_NOTICE_MAX_CHANNELS + 3).map(c => c.id)
const SHARED_PATH = sharedChannelPath('/notice-texts-shared-state')
const sharedRef = () => renderPersonaRef(PERSONA.name, KEY)
// This directory is a nonsecret configured value, not a credential fixture.
const sharedTokenPath = () => sharedChannelPath(`/notice-texts-shared-state/${BOT_TOKEN_PREFIX}configured-authority`)
const sharedFailure = (path = sharedTokenPath()) => `EIO ${sentinelInMessage('authority-failure')}; path=${JSON.stringify(path)}`
const SHARED_CONFIGURED_FIELDS = [
  { label: 'ordinary fields', name: PERSONA.name, path: SHARED_PATH },
  { label: 'URL-like name and nonsecret token-shaped directory', name: 'https://configured.invalid/ops?team=blue', path: sharedTokenPath() },
  { label: 'token-shaped name and app-token-shaped directory', name: fakeToken(BOT_TOKEN_PREFIX, 'configured-shared-name'), path: sharedChannelPath(`/scratch/${APP_TOKEN_PREFIX}configured-directory`) },
  { label: 'quotes, backslash, newlines and Slack controls', name: 'Ops "<&>" \\\r\n\t\u2028\u2029', path: sharedChannelPath(`/scratch/"<&>"\\\r\n\t\u2028\u2029/${BOT_TOKEN_PREFIX}configured-directory`) },
  { label: 'long configured name is not excerpted', name: 'Ops 🚀 <&> '.repeat(300), path: SHARED_PATH },
]
// Extra payload fields must never be serialized by these metadata-only builders.
function sharedScope(overrides: Partial<SharedStateReportScope> = {}): SharedStateReportScope {
  const scope = { channels: [THREAD_CHANNELS.primary, THREAD_CHANNELS.secondary], text: MEMORY_BODY, user: MEMORY_USER, ...overrides }
  return scope
}
function sharedEvidence(overrides: MembershipReportEvidence): MembershipReportEvidence {
  const evidence = { text: MEMORY_BODY, user: MEMORY_USER, ...overrides }
  return evidence
}
const SHARED_SCOPE_CASES: readonly (readonly [string, SharedStateReportScope])[] = [
  ['at bound', sharedScope({ channels: SHARED_CHANNELS.slice(0, SHARED_STATE_NOTICE_MAX_CHANNELS) })],
  ['over bound', sharedScope({ channels: SHARED_CHANNELS })],
  ['all and DM', sharedScope({ all: true, dm: true })],
]
const SHARED_INVENTORY_SCOPES = SHARED_SCOPE_CASES.map(([label, scope]) => [`inventory ${label}`, { ...scope, all: true }] as const)
const SHARED_STAGED_SCOPES: readonly (readonly [string, SharedStateReportScope])[] = [
  ['identical usable projections', sharedScope({ all: true, repairPending: { usable: [THREAD_CHANNELS.primary, THREAD_CHANNELS.secondary], held: [] } })],
  ['usable and held projections', sharedScope({ all: true, dm: true, repairPending: { usable: [THREAD_CHANNELS.primary], held: [THREAD_CHANNELS.secondary] } })],
  ['staged over bound', sharedScope({ all: true, channels: SHARED_CHANNELS, repairPending: { held: SHARED_CHANNELS.slice(0, 2), usable: SHARED_CHANNELS.slice(2) } })],
  ['staged all membership held', sharedScope({ all: true, repairPending: { usable: [], held: [THREAD_CHANNELS.primary, THREAD_CHANNELS.secondary] } })],
  ['staged empty inventory', sharedScope({ all: true, channels: [], repairPending: { usable: [], held: [] } })],
]
function sharedStateEntries(): NoticeEntry[] {
  const row = (builder: string, variant: string, render: () => string, configuredSpans?: readonly string[]) => entry('shared-state', builder, variant, () => formatPersonaNotice(PERSONA, render()), configuredSpans)
  const path = escapeSlackControlCharacters(quotedMemoryPath(sharedTokenPath()))
  return [
    ...sharedCauses.map(cause => row(buildSharedStateUnresolvedNotice.name, cause, () => buildSharedStateUnresolvedNotice(sharedRef(), sharedScope(), cause, SHARED_PATH))),
    ...SHARED_INVENTORY_SCOPES.map(([label, scope]) => row(buildSharedStateUnresolvedNotice.name, label, () => buildSharedStateUnresolvedNotice(sharedRef(), scope, 'not-saved', SHARED_PATH))),
    ...(['authority', 'retired-keys'] as const).map(record => row(buildReloadApplyFailedNotice.name, record,
      () => buildReloadApplyFailedNotice(sharedRef(), { record, path: sharedTokenPath(), failure: sharedFailure() }),
      record === 'authority' ? [`the shared channel authority at ${path} (`] : [])),
    ...sharedHistory.map(evidence => row(buildMembershipEvidenceUnresolvedNotice.name, evidence, () => buildMembershipEvidenceUnresolvedNotice(sharedRef(), sharedScope(), sharedEvidence({ history: [{ channel: THREAD_CHANNELS.primary, evidence }] })))),
    ...sharedProblems.flatMap(problem => [undefined, 'missing_scope'].map(slackError => row(buildMembershipEvidenceUnresolvedNotice.name, `${problem}; ${slackError ?? 'no slack_error'}`, () => buildMembershipEvidenceUnresolvedNotice(sharedRef(), sharedScope(), sharedEvidence({ problem, slackError, nextAttemptAt: MEMBERSHIP_FIXTURE_TIME }))))),
    ...sharedClosings.map(closing => row(buildSharedStateRecoveredNotice.name, closing, () => buildSharedStateRecoveredNotice(sharedRef(), sharedScope(), closing))),
    ...SHARED_SCOPE_CASES.flatMap(([label, scope]) => [
      row(buildSharedStateUnresolvedNotice.name, label, () => buildSharedStateUnresolvedNotice(sharedRef(), scope, 'unsynced', SHARED_PATH)),
      row(buildMembershipEvidenceUnresolvedNotice.name, label, () => buildMembershipEvidenceUnresolvedNotice(sharedRef(), scope, sharedEvidence({ history: scope.channels.map(channel => ({ channel, evidence: 'absence-order' })) }))),
      row(buildSharedStateRecoveredNotice.name, label, () => buildSharedStateRecoveredNotice(sharedRef(), scope, 'repair')),
    ]),
    ...SHARED_STAGED_SCOPES.map(([label, scope]) => row(buildSharedStateUnresolvedNotice.name, label, () => buildSharedStateUnresolvedNotice(sharedRef(), scope, 'restoration-staged', SHARED_PATH))),
    row(buildSharedStateUnresolvedNotice.name, 'token-bearing path and failure', () => buildSharedStateUnresolvedNotice(sharedRef(), sharedScope(), 'unsynced', sharedTokenPath(), sharedFailure()), [`Shared channel authority: ${path} (`]),
    row(buildMembershipEvidenceUnresolvedNotice.name, 'token-bearing Slack reason', () => buildMembershipEvidenceUnresolvedNotice(sharedRef(), sharedScope(), sharedEvidence({ problem: 'access', slackError: sentinelInMessage('scan-error') }))),
  ]
}

/** The JSONL persistence safeguard's storage and AD-reference notices (keeps their text): one per variant. */
const JSONL_NON_PERSISTENT = 'non-persistent storage'
const JSONL_ROTATED = 'AD rotated transcript reference'

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
 * with AD transcript status supplied by the row. Nothing is read from or written to disk
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
  const row = cannedGetResult({ state: 'ended', transcript_status: 'rotated', jsonl_path: '', session_id: 'sess-notice' }, persona, JSONL_HOME)
  await runJsonlPersistenceSafeguard(config, capture(JSONL_ROTATED), {
    readMountinfo: () => EXT4_MOUNTINFO,
    getRow: async () => row,
    recordStartupError: noRecord,
    home: JSONL_HOME,
  })
  return texts
}

const JSONL_SAFEGUARD_NOTICES = await renderJsonlSafeguardNotices()

/** The safeguard's notice for `variant`; throws when its run raised none. */
function jsonlSafeguardNotice(variant: string): string {
  const text = JSONL_SAFEGUARD_NOTICES.get(variant)
  if (text === undefined) throw new Error(`notice-texts: the JSONL safeguard raised no ${variant} notice`)
  return text
}

/** the JSONL persistence safeguard's notices, which name no command. */
function jsonlSafeguardEntries(): NoticeEntry[] {
  return [
    entry("common", 'runPersonaStorageCheck', JSONL_NON_PERSISTENT, () => jsonlSafeguardNotice(JSONL_NON_PERSISTENT)),
    entry("common", 'runJsonlPersistenceSafeguard', JSONL_ROTATED, () => jsonlSafeguardNotice(JSONL_ROTATED)),
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
 * the `ErrJsonlMissing` diagnosis's two uncertainty notices, each quoting agent-director's paths or
 * description, which hold a fake token and {@link JSONL_SLACK_CONTROLS};
 * they name no command.
 */
function jsonlDiagnosisEntries(): NoticeEntry[] {
  return [
    entry("common", 'jsonlRowAbsentInconclusiveNoticeText', 'inconclusive, row absent, token-bearing description', () =>
      jsonlRowAbsentInconclusiveNoticeText(withToken(`${errJsonlMissing().errDescription} ${JSONL_SLACK_CONTROLS}`, 'jsonl-row-absent')),
    ),
    entry("common", 'jsonlCandidatesInconclusiveNoticeText', 'inconclusive, unattributable zero, token-bearing candidates', () =>
      jsonlCandidatesInconclusiveNoticeText('agent-director references do not verify transcript readability', JSONL_SAMPLE_PROVENANCE, jsonlPathsTried('jsonl-candidates')),
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

/** one redaction-and-cap row per builder that quotes agent-director. */
function capEntries(): NoticeEntry[] {
  const session = personaTmuxSessionName(KEY)
  const refusal = (label: string) => errGeneric('kill', 'ErrTmuxSessionConflict', overCapDescription(label))
  const ordinary = (label: string, closing: KillFailureClosing, forSlack: boolean) =>
    killFailureAlertText(ordinaryContent(personaInstanceId(KEY), { lastKillFailedDescription: overCapDescription(label) }), closing, forSlack)
  return [
    entry("teardown", 'teardownKillRefusalNoticeText', CAP_VARIANT, () =>
      teardownKillRefusalNoticeText(personaInstanceId(OLD_KEY), { at: KILL_REFUSAL_AT_KILL, errorClass: AD_ERROR_CLASS_CONFLICT, error: refusal('cap-teardown') }),
    ),
    entry("teardown", 'oldLifeWaitRefusalNoticeText', CAP_VARIANT, () =>
      oldLifeWaitRefusalNoticeText(personaInstanceId(OLD_KEY), { at: OLD_LIFE_WAIT_AT_KILL, errorClass: AD_ERROR_CLASS_CONFLICT, error: refusal('cap-old-life') }),
    ),
    entry("teardown", 'teardownKillNotSucceededNoticeText', CAP_VARIANT, () =>
      teardownKillNotSucceededNoticeText(personaInstanceId(KEY), killFailedOutcome(overCapDescription('cap-not-killed')), 3),
    ),
    entry("conflict", 'conflictNoticeText', CAP_VARIANT, () =>
      conflictNoticeText({ sessionName: session, latchCase: LATCH_CASE_LEFTOVER as ConflictLatchCase, description: overCapDescription('cap-conflict') }),
    ),
    entry("kill-failure", 'killFailureAlertText', `ordinary, ${CAP_VARIANT}`, () => ordinary('cap-kill-failed', KILL_FAILURE_CLOSING_DESTINATION, true)),
    entry("kill-failure", 'killFailureAlertText', `survivor, ${CAP_VARIANT}`, () =>
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
    entry("unclassified-error", 'unclassifiedErrorAlertText', CAP_VARIANT, () =>
      unclassifiedErrorAlertText(classifyAdError(errGeneric('spawn', 'ErrFromALaterBinary', overCapDescription('cap-unclassified')))),
    ),
    entry("startup-errors", 'killFailureAlertEntryText', CAP_VARIANT, () =>
      killFailureAlertEntryText(`persona=${KEY}`, KILL_FAILURE_CONTEXTS[0], ordinary('cap-entry', KILL_FAILURE_CLOSING_LOG_ONLY, false)),
    ),
    entry("startup-errors", 'killFailureStoppedRetryText', CAP_VARIANT, () => {
      const { line, entry: startupEntry } = killFailureStoppedRetryText({
        key: KEY,
        decision: { kind: KILL_RETRY_ALERT_ORDINARY, lastKillFailedDescription: overCapDescription('cap-stopped-retry') },
        context: KILL_FAILURE_CONTEXTS[0],
        lastOutcomeClass: AD_ERROR_CLASS_UNAVAILABLE,
      })
      return `${line}\n${startupEntry}`
    }),
    entry("startup-errors", 'personaTeardownNoticeEntryText', CAP_VARIANT, () =>
      personaTeardownNoticeEntryText(
        `persona=${KEY}`,
        teardownKillRefusalNoticeText(personaInstanceId(KEY), { at: KILL_REFUSAL_AT_KILL, errorClass: AD_ERROR_CLASS_CONFLICT, error: refusal('cap-teardown-entry') }),
      ),
    ),
    entry("startup-errors", 'teardownFailureLine', CAP_VARIANT, () =>
      teardownFailureLine(CLI_COMMAND_STOP_BOTS, { name: PERSONA.name, key: KEY }, teardownErrorReportOf(refusal('cap-cli'))),
    ),
    entry("ad-config-malformed", 'adConfigMalformedOnset', CAP_VARIANT, () =>
      adConfigMalformedOnset(errUnknownErrorName('ErrConfigMalformed', overCapDescription('cap-config'))),
    ),
    entry("unusable-name", 'unusableNameNoticeText', CAP_VARIANT, () => unusableNameNoticeText(KEY, overCapDescription('cap-unusable'))),
    entry("common", 'spawnFailureNoticeText', CAP_VARIANT, () =>
      spawnFailureNoticeText(errGeneric('spawn', 'ErrFromALaterBinary', overCapDescription('cap-spawn'))),
    ),
    entry("common", 'jsonlRowAbsentInconclusiveNoticeText', CAP_VARIANT, () =>
      jsonlRowAbsentInconclusiveNoticeText(overCapDescription('cap-jsonl-row-absent')),
    ),
    entry("common", 'jsonlCandidatesInconclusiveNoticeText', CAP_VARIANT, () =>
      jsonlCandidatesInconclusiveNoticeText('agent-director references do not verify transcript readability', JSONL_SAMPLE_PROVENANCE, overCapDescription('cap-jsonl-candidates')),
    ),
  ]
}

/**
 * Every Slack notice's output, by behavior group: every catalogued notice builder, and
 * under the contract every other server notice it names (`NAMED_SLACK_NOTICES`).
 * A new notice joins here (and an id leaves `NOT_APPLICABLE` once a builder
 * is exported).
 */
const NOTICE_CATALOGUE: readonly NoticeEntry[] = Object.freeze([
  ...commonEntries(),
  ...spawnFailureEntries(),
  ...notConnectedEntries(),
  ...deliveryEntries(),
  ...threadMemoryEntries(),
  ...sharedStateEntries(),
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
  ...wedgeWarningEntries(),
  ...startupErrorEntries(),
  ...stuckLaunchEntries(),
  ...adConfigMalformedEntries(),
  ...unusableNameEntries(),
  ...launchStartEntries(),
  ...tmuxServerChangedEntries(),
])

/** The catalogued ids from the contract to with no notice builder in the catalogue, each with its reason. */
const NOT_APPLICABLE: Readonly<Partial<Record<NoticeGroup, string>>> = Object.freeze({
  "queued-delivery": 'removes Message lost; accepted inputs remain in the queue and recovery posts nothing.',
  "routing": 'log-only routing: it routes other notices and has no text of its own',
  "settings-log": 'log lines, not notices: each is asserted with its behaviour',
  "startup-summary": 'the start summary line is a server-log line, not a notice',
  "episodes": 'episodes rate-limit notices and have no text of their own',
})

/** Every id the completeness guard covers: to. */
const GUARDED_IDS = ['common', 'routing', 'teardown', 'conflict', 'latch-recovery', 'tmux-unresponsive', 'kill-failure', 'invalid-flags', 'unclassified-error', 'slow-recovery', 'queued-delivery', 'permission-wedge', 'startup-errors', 'settings-log', 'startup-summary', 'episodes', 'stuck-launch', 'ad-config-malformed', 'unusable-name', 'launch-start-missing', 'tmux-server-changed', 'thread-memory', 'shared-state'] as const

/**
 * The server notices posted to Slack that names beyond the catalogued
 * builders, by the builder that renders each (the JSONL safeguard's by its
 * entry points, which have no pure builder): the wedge warning, the
 * lost-message notice, the outage onsets and all-clear, the spawn-failure
 * and restart-cap notices not-connected notices, the JSONL
 * safeguard's notices and the `ErrJsonlMissing` diagnosis's three notices.
 * Each has a catalogue entry.
 */
const NAMED_SLACK_NOTICES: readonly string[] = Object.freeze([
  buildWedgeWarningText.name,
  'ONSET_TEMPLATES',
  'ALL_CLEAR_TEMPLATE',
  spawnFailureNoticeText.name,
  restartCapReachedNoticeText.name,
  buildNotConnectedNotice.name,
  buildMessageNotSavedNotice.name,
  buildDeliveryStuckNotice.name,
  buildMessageNotTakenInNotice.name,
  buildMessagesWaitingNotice.name,
  buildQueueRecordUnreadableNotice.name,
  buildThreadMemoryNotSavedNotice.name,
  buildThreadMemoryUnreadableNotice.name,
  buildThreadMemoryJoinsLostNotice.name,
  buildThreadMemoryChangedWhileStoppedNotice.name,
  buildThreadMemoryRecoveredNotice.name,
  runPersonaStorageCheck.name,
  runJsonlPersistenceSafeguard.name,
  jsonlRowAbsentInconclusiveNoticeText.name,
  jsonlCandidatesInconclusiveNoticeText.name,
])

/** The `ErrJsonlMissing` diagnosis's notice builders, each of which quotes agent-director. */
const JSONL_DIAGNOSIS_BUILDERS: readonly string[] = Object.freeze([
  jsonlRowAbsentInconclusiveNoticeText.name,
  jsonlCandidatesInconclusiveNoticeText.name,
])

/** A description of agent-director's holding each of Slack's control characters, a broadcast and a mention among them. */
const SLACK_MARKUP_DESCRIPTION = 'quoted <!channel> & <@U0MENTION> end'

/**
 * Every Slack-bound notice that quotes agent-director's description, each
 * rendering `description` in its Slack form: the escaping audit's
 * table.
 */
const SLACK_QUOTING_NOTICES: readonly (readonly [title: string, render: (description: string) => string])[] = [
  ['conflictNoticeText', (description) =>
    conflictNoticeText({ sessionName: personaTmuxSessionName(KEY), latchCase: LATCH_CASE_LEFTOVER as ConflictLatchCase, description })],
  ['killFailureAlertText (Slack)', (description) =>
    killFailureAlertText(ordinaryContent(personaInstanceId(KEY), { lastKillFailedDescription: description }), KILL_FAILURE_CLOSING_DESTINATION, true)],
  ['unclassifiedErrorAlertText (Slack)', (description) => unclassifiedErrorAlertText(classifyAdError(errGeneric('spawn', 'ErrFromALaterBinary', description)))],
  ['adConfigMalformedOnset', (description) => adConfigMalformedOnset(errUnknownErrorName('ErrConfigMalformed', description))],
  ['unusableNameNoticeText', (description) => unusableNameNoticeText(KEY, description)],
  ['spawnFailureNoticeText', (description) => spawnFailureNoticeText(errGeneric('spawn', 'ErrTmuxSessionCreate', description))],
  ['jsonlCandidatesInconclusiveNoticeText (a candidate\'s note)', (description) =>
    jsonlCandidatesInconclusiveNoticeText(
      'agent-director references do not verify transcript readability',
      JSONL_SAMPLE_PROVENANCE,
      jsonlCandidatesText([{ source: 'persisted', path: '/data/proj/sess.jsonl', note: description }]),
    )],
  ['jsonlRowAbsentInconclusiveNoticeText (agent-director\'s description)', (description) => jsonlRowAbsentInconclusiveNoticeText(description)],
]

/** `<behavior group> <builder>: <variant>`, for case titles. */
function titleOf(e: NoticeEntry): string {
  return `${e.group} ${e.builder}: ${e.variant}`
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

describe('no catalogued notice names clear-latch', () => {
  test.each(NOTICE_CATALOGUE.map((e) => [titleOf(e), e] as const))('%s', (_title, e) => {
    const text = e.render()
    expect(text.trim()).not.toBe('')
    expect(clearLatchTermsIn(text)).toEqual([])
  })

  test('the "cleared by hand" recovery text, which a clear-latch clear posts, is in the catalogue', () => {
    expect(NOTICE_CATALOGUE.filter((e) => e.group === "latch-recovery" && e.variant.endsWith('cleared by hand')).map((e) => e.variant)).toEqual([
      `${LATCH_KIND_CONFLICT} latch, cleared by hand`,
      `${LATCH_KIND_HOLD} latch, cleared by hand`,
    ])
  })

  test('every rendered text leaks no token: quoted descriptions are redacted', () => {
    const texts = NOTICE_CATALOGUE.map((e) => [e, e.render()] as const)
    assertNoLeak(Object.fromEntries(texts.map(([e, text]) => [titleOf(e), withoutConfiguredSpans(text, e.configuredSpans)])), 'notices')
    for (const [, text] of texts) {
      expect(text).not.toContain(MEMORY_BODY)
      expect(text).not.toContain(MEMORY_USER)
    }
    // Not vacuous: the fake tokens reach every builder that quotes agent-director, as its redaction placeholder.
    const redacted = [REDACTED_TOKEN_PLACEHOLDER, escapeSlackControlCharacters(REDACTED_TOKEN_PLACEHOLDER)]
    expect([...new Set(texts.filter(([, text]) => redacted.some((r) => text.includes(r))).map(([e]) => e.group))].sort()).toEqual(([
      "common",
      "teardown",
      "conflict",
      "kill-failure",
      "unclassified-error",
      "startup-errors",
      "ad-config-malformed",
      "unusable-name",
      "thread-memory",
      "shared-state",
    ] as NoticeGroup[]).sort())
  })
})

describe('a Slack notice quoting agent-director escapes its description exactly once', () => {
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

describe('the notice catalogue is complete (to, and every named Slack notice)', () => {
  test('every id has a catalogue entry or a not-applicable reason, never both', () => {
    const catalogued = new Set(NOTICE_CATALOGUE.map((e) => e.group))
    expect(GUARDED_IDS.filter((id) => !catalogued.has(id) && NOT_APPLICABLE[id] === undefined)).toEqual([])
    expect(GUARDED_IDS.filter((id) => catalogued.has(id) && NOT_APPLICABLE[id] !== undefined)).toEqual([])
  })

  test('every not-applicable id is guarded and has a reason', () => {
    const entries = Object.entries(NOT_APPLICABLE) as [NoticeGroup, string][]
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

  test.each(notConnectedEntries().map(e => [titleOf(e), e] as const))('%s never claims disconnected messages are lost or needs a stream', (_title, e) => {
    expect(e.render()).not.toMatch(/\blost\b|not receiving messages|\bstream(?:less)?\b/i)
  })

  test('the named notices are catalogued in every variant: outage, MCP, delivery and JSONL notices', () => {
    const variantsOf = (...builders: string[]) => NOTICE_CATALOGUE.filter((e) => builders.includes(e.builder)).map((e) => e.variant)
    expect(variantsOf('ONSET_TEMPLATES')).toEqual(expect.arrayContaining(OUTAGE_CLASS_ORDER.map((outage) => `${outage} onset`)))
    expect(variantsOf(buildNotConnectedNotice.name)).toEqual(notConnectedVariants().map(([label]) => label))
    expect(new Set(notConnectedVariants().map(([, notice]) => notice.reason))).toEqual(new Set(['blocked-on-prompt', 'auto-restart-disabled']))
    expect(variantsOf(buildDeliveryStuckNotice.name)).toEqual([...DELIVERY_STUCK_REASONS])
    expect(variantsOf(buildMessagesWaitingNotice.name)).toEqual([...MESSAGES_WAITING_STATES])
    expect(variantsOf(runPersonaStorageCheck.name, runJsonlPersistenceSafeguard.name)).toEqual([JSONL_NON_PERSISTENT, JSONL_ROTATED])
  })

  test('each ErrJsonlMissing diagnosis notice is a named Slack notice with a quoting row and a redaction-and-cap row', () => {
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
// rules over every catalogued notice
// ---------------------------------------------------------------------------

/**
 * a notice names a command when it holds a code span that opens
 * with `agent-director` or `tmux` and a space (a class label such as
 * `tmux-unavailable` is none).
 */
const COMMAND_SPAN = /`(?:agent-director|tmux)\s/

/** The title of agent-director's README section a notice points to; a notice names it only as that quoted title. */
const OPERATOR_ACTIONS = 'Operator actions'
const OPERATOR_ACTIONS_TITLE = `"${OPERATOR_ACTIONS}"`

/** Whether `ownText` names "Operator actions" other than as its quoted title, in any letter case. */
function namesOperatorActionsUnquoted(ownText: string): boolean {
  return new RegExp(OPERATOR_ACTIONS, 'i').test(ownText.split(OPERATOR_ACTIONS_TITLE).join(''))
}

/** `agent-director kill` named as a command, which only a human's step with its result checked may name. */
const AD_KILL_COMMAND = /`agent-director kill\b/
const CHECKS_THE_RESULT = /check (?:the|its) result/

/** Whether `text` names `agent-director kill` and does not say to check its result. */
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
 * What no notice names, beside `CSCB_OWN_LINE_FORBIDDEN` (a pane
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
 * check takes for CSCB's (agent-director contract).
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

/** Every term `text` names: the names of `NOTICE_FORBIDDEN`'s hits, then `CSCB_OWN_LINE_FORBIDDEN`'s per line. */
function forbiddenTermsIn(text: string): string[] {
  return [
    ...NOTICE_FORBIDDEN.filter(([, pattern]) => pattern.test(text)).map(([name]) => name),
    ...text.split('\n').flatMap(cscbOwnLineForbiddenIn),
  ]
}

/** The builders whose own lines name no session-ending command: CONFLICT, unusable-name, launch-start and both stuck-launch texts. */
const SESSION_ENDING_FREE_BUILDERS: readonly string[] = Object.freeze([
  conflictNoticeText.name,
  unusableNameNoticeText.name,
  launchStartNotRecordedNoticeText.name,
  stuckLaunchRelaunchingText.name,
  stuckLaunchHeldText.name,
  buildDeliveryStuckNotice.name,
])

/**
 * The ids whose texts never reach Slack: the teardown window's
 * notices and the startup-errors entries. They quote
 * agent-director's description as a `message="…"` field, which may carry its
 * own pointer to "Operator actions"; the human-only and title rules, which
 * hold for Slack posts, skip them, and every other rule holds for them too.
 */
const LOG_ONLY_GROUPS: readonly NoticeGroup[] = Object.freeze(["teardown", "startup-errors"])

/** Every catalogue entry with its title, for `test.each`. */
const CASES = NOTICE_CATALOGUE.map((e) => [titleOf(e), e] as const)

/** The entries posted to Slack: every entry outside `LOG_ONLY_GROUPS`. */
const SLACK_CASES = CASES.filter(([, e]) => !LOG_ONLY_GROUPS.includes(e.group))

describe('Shared-state catalogue content and diagnostic lines', () => {
  const variants = (builder: string) => NOTICE_CATALOGUE.filter(e => e.group === 'shared-state' && e.builder === builder).map(e => e.variant)

  test('every exported cause, evidence, problem and closing has a catalogue row; no transport or superseded report', () => {
    expect(variants(buildReloadApplyFailedNotice.name)).toEqual(['authority', 'retired-keys'])
    expect(variants(buildSharedStateUnresolvedNotice.name)).toEqual([
      ...sharedCauses, ...SHARED_INVENTORY_SCOPES.map(([label]) => label), ...SHARED_SCOPE_CASES.map(([label]) => label), ...SHARED_STAGED_SCOPES.map(([label]) => label), 'token-bearing path and failure',
    ])
    expect(variants(buildMembershipEvidenceUnresolvedNotice.name)).toEqual([
      ...sharedHistory, ...sharedProblems.flatMap(problem => [`${problem}; no slack_error`, `${problem}; missing_scope`]),
      ...SHARED_SCOPE_CASES.map(([label]) => label), 'token-bearing Slack reason',
    ])
    expect(variants(buildSharedStateRecoveredNotice.name)).toEqual([...sharedClosings, ...SHARED_SCOPE_CASES.map(([label]) => label)])
    expect([...sharedCauses, ...sharedHistory, ...sharedProblems, ...sharedClosings].filter(v => ['transport', 'superseded'].includes(v))).toEqual([])
    expect(SHARED_STATE_DIAGNOSTIC_CLASSES).toEqual(['shared-state-unresolved', 'membership-evidence-unresolved', 'shared-state-recovered'])
    for (const kind of SHARED_STATE_DIAGNOSTIC_CLASSES) expect(PERSONA_DIAGNOSTIC_CLASSES.filter(value => value === kind)).toHaveLength(1)
  })

  test('notice texts, actions, repair limits and diagnostic actions (one literal pin)', () => {
    for (const record of ['authority', 'retired-keys'] as const) {
      const text = buildReloadApplyFailedNotice(sharedRef(), { record, path: SHARED_PATH, failure: 'EIO' })
      expect(text).toBe(`:warning: *Configuration change not applied* — ${sharedRef()}; could not write ${record === 'authority' ? `the shared channel authority at ${JSON.stringify(SHARED_PATH)}` : 'the retired-key record'} (EIO). Nothing in the confirmed change was applied. This persona and every other persona keep running as before, and the change stays pending. Fix the cause, for example disk space or permissions, then review the pending change again and confirm it afresh; a failed confirmation is not reused.`)
      const redacted = buildReloadApplyFailedNotice(sharedRef(), { record, path: sharedTokenPath(), failure: sharedFailure() })
      const fields = record === 'authority' ? [`the shared channel authority at ${escapeSlackControlCharacters(quotedMemoryPath(sharedTokenPath()))} (`] : []
      assertNoLeak(withoutConfiguredSpans(redacted, fields))
      expect(redacted).not.toContain(MEMORY_BODY)
      expect(redacted).not.toContain(MEMORY_USER)
    }
    expect(SHARED_STATE_NOTICE_MAX_CHANNELS).toBe(20)
    expect(SHARED_STATE_SLACK_RETRY_WARNING).toBe('Messages Slack sent to held channels while this lasted stay unacknowledged. Slack retries each only a limited number of times, so messages never accepted may be lost and should be sent again.')
    expect(SHARED_STATE_STAGED_SLACK_RETRY_WARNING).toBe('Only messages whose intake is held remain unacknowledged. Slack retries each only a limited number of times, so messages never accepted may be lost and should be sent again.')
    const ref = sharedRef(), scope = sharedScope(), channels = scope.channels.join(', ')
    const continuing = 'Other channels and personas, and already accepted queues, keep working.'
    const warning = SHARED_STATE_SLACK_RETRY_WARNING
    const causes: Record<SharedStateCause, readonly [string, string]> = {
      unsynced: ["A shared-state write was renamed but not synced. CSCB finishes it at its next configuration checks once the state directory can be synced. Check the disk and filesystem. If the file changes meanwhile, existing recovery can still finish when the exact pending bytes return and synchronization succeeds. If that recovery cannot finish, use reviewed restoration, or explicit replacement when restoration is impossible, as the debugging skill's reload-shared-recovery entry describes, then restart.", 'finish the write at configuration checks; check disk/filesystem; if evidence changes, existing recovery can still finish when exact pending bytes return and sync succeeds; if recovery cannot finish, use reviewed restoration or explicit replacement and restart'],
      'evidence-changed': ["The file no longer holds what CSCB wrote, so CSCB won't guess. Preserve the evidence. Existing recovery can still finish without restarting when the exact pending bytes return and synchronization succeeds. If that recovery cannot finish, use reviewed restoration, or explicit replacement when restoration is impossible, as the debugging skill's reload-shared-recovery entry describes, then restart. Choices that cannot be restored are lost and must be set again.", 'preserve evidence; existing recovery can still finish without restarting when exact pending bytes return and sync succeeds; if recovery cannot finish, use reviewed restoration or explicit replacement and restart; unrestorable choices must be set again'],
      'restoration-staged': ['A reviewed restoration is staged. Restart CSCB to review and confirm it; staging alone does not complete the repair.', 'restart to review and confirm staged restoration; channel lists describe membership readiness only; thread-dependent replies in thread_hybrid channels stay held and unacknowledged while Channel Stamps are undecided; otherwise eligible @mentions, Broadcasts and other intake independent of Channel Stamps continue'],
      'retirement-unresolved': ["A confirmed change's persona retirement could not be finished or undone. CSCB retries at each configuration check. Check the state directory's disk; the retirement must be recovered before affected intake resumes.", 'retirement recovery retries at configuration checks; check the state directory disk'],
      'not-saved': ["CSCB could not save membership evidence for these channels. It retries reconciliation in the background. Check the state directory's disk; retries cannot restore events Slack no longer sends.", 'membership reconciliation retries in the background; check the state directory disk'],
    }
    for (const cause of sharedCauses) {
      const held = cause === 'restoration-staged' ? 'Messages in the affected channels stay held.' : 'Messages there stay held.'
      const causeWarning = cause === 'restoration-staged' ? SHARED_STATE_STAGED_SLACK_RETRY_WARNING : warning
      expect(buildSharedStateUnresolvedNotice(ref, scope, cause, SHARED_PATH)).toBe(`:warning: *Channel state unresolved* — ${ref}; channels: ${channels}. Shared channel authority: ${JSON.stringify(SHARED_PATH)}. ${causes[cause][0]} ${held} ${continuing} ${causeWarning}`)
      expect(buildSharedStateUnresolvedLine(KEY, scope, cause, SHARED_PATH)).toBe(`[slack] shared-state-unresolved: persona=${KEY} cause=${cause} channels=${JSON.stringify(scope.channels)} path=${JSON.stringify(SHARED_PATH)} ${causes[cause][1]}. ${causeWarning}`)
    }
    const inventory = { ...scope, all: true }
    expect(buildSharedStateUnresolvedNotice(ref, inventory, 'not-saved', SHARED_PATH)).toBe(`:warning: *Channel state unresolved* — ${ref}; membership inventory incomplete; known channels: ${channels}. Shared channel authority: ${JSON.stringify(SHARED_PATH)}. CSCB could not save a complete membership inventory. It retries reconciliation in the background. Check the state directory's disk; retries cannot restore events Slack no longer sends. Verified usable channels keep working. Only intake depending on missing membership evidence stays held and unacknowledged. Recovery requires a complete membership inventory. ${continuing} ${warning}`)
    expect(buildSharedStateUnresolvedLine(KEY, inventory, 'not-saved', SHARED_PATH)).toBe(`[slack] shared-state-unresolved: persona=${KEY} cause=not-saved scope=inventory known_channels=${JSON.stringify(scope.channels)} path=${JSON.stringify(SHARED_PATH)} complete membership inventory not saved; verified usable channels keep working; only intake depending on missing membership evidence stays held and unacknowledged; recovery requires a complete membership inventory; membership reconciliation retries in the background; check the state directory disk. ${warning}`)
    const history: Record<MembershipHistoryEvidence, string> = {
      'absence-order': 'the bot was seen absent, but CSCB cannot tell whether that leave came before or after a choice confirmed meanwhile',
      'event-history': 'a membership event conflicts with recorded history',
    }
    const evidenceTail = ` Messages whose eligibility depends on this missing evidence stay held. ${continuing} Elapsed time does not establish missing evidence. ${warning}`
    for (const evidence of sharedHistory) {
      const facts = sharedEvidence({ history: [{ channel: THREAD_CHANNELS.primary, evidence }] })
      expect(buildMembershipEvidenceUnresolvedNotice(ref, scope, facts)).toBe(`:warning: *Channel membership evidence unresolved* — ${ref}; channels: ${channels}. ${THREAD_CHANNELS.primary}: ${history[evidence]}. Retries, reconciliation and time cannot settle this history; only reviewed recovery can, through an explicit absence replacement for the channel or reviewed restoration.${evidenceTail}`)
      expect(buildMembershipEvidenceUnresolvedLine(KEY, scope, facts, SHARED_PATH)).toBe(`[slack] membership-evidence-unresolved: persona=${KEY} cause=history channels=${JSON.stringify(scope.channels)} path=${JSON.stringify(SHARED_PATH)} missing_evidence=[${THREAD_CHANNELS.primary}:${evidence}] history needs explicit absence replacement or reviewed restoration; retries and time cannot settle it. ${warning}`)
    }
    const problems: Record<MembershipReportProblem, string> = {
      deadline: "Slack's membership list could not be read in time. CSCB retries; if this continues, check Slack's status and the workspace size.",
      access: 'The bot lacks a scope or channel access needed to read membership. Add the scope named in the debugging skill and reinstall; retries alone cannot fix it.',
      authentication: "Slack refused the bot's credentials. Fix the bot token through a confirmed configuration change; retries alone cannot fix it.",
      'installation-unverified': 'CSCB could not verify the app installation. Check the installation and its credentials; retries alone cannot fix it.',
      'malformed-page': 'Slack returned a membership page CSCB cannot read. CSCB retries; the incomplete page establishes no missing fact.',
      'current-membership-missing': "A complete scan still left current membership undecided for these channels. CSCB retries; check the debugging skill's current-membership-missing entry.",
      'eligibility-missing': "A complete scan still left channel eligibility undecided. CSCB retries; check the debugging skill's eligibility-missing entry.",
      'event-order-conflict': "A complete scan still left membership event order undecided. CSCB retries; check the debugging skill's event-order-conflict entry.",
    }
    for (const problem of sharedProblems) for (const slackError of [undefined, 'missing_scope']) {
      const facts = sharedEvidence({ problem, slackError, nextAttemptAt: MEMBERSHIP_FIXTURE_TIME })
      expect(buildMembershipEvidenceUnresolvedNotice(ref, scope, facts)).toBe(`:warning: *Channel membership evidence unresolved* — ${ref}; channels: ${channels}.  ${problems[problem]}${slackError ? ` Slack reason: ${slackError}.` : ''} Next attempt at: ${MEMBERSHIP_FIXTURE_TIME}.${evidenceTail}`)
      expect(buildMembershipEvidenceUnresolvedLine(KEY, scope, facts, SHARED_PATH)).toBe(`[slack] membership-evidence-unresolved: persona=${KEY} cause=scan-ended channels=${JSON.stringify(scope.channels)} path=${JSON.stringify(SHARED_PATH)} problem=${problem}${slackError ? ` slack_error=${slackError}` : ''} next_attempt_at=${MEMBERSHIP_FIXTURE_TIME} background scans retry; restore the named access, authorization, installation or membership evidence; retries and time do not establish missing facts. ${warning}`)
    }
    for (const closing of sharedClosings) {
      expect(buildSharedStateRecoveredNotice(ref, scope, closing)).toBe(`:white_check_mark: *Channel state recovered* — ${ref}; channels: ${channels}. ${closing === 'repair' ? "The reviewed restoration or replacement is applied and this persona's current membership is verified. " : ''}The channel state and current membership for these channels are trustworthy again; held messages there are decided now. Slack retries are finite. Messages Slack stopped retrying meanwhile are not recovered; send missing messages again.`)
      expect(buildSharedStateRecoveredLine(KEY, scope, closing, SHARED_PATH)).toBe(`[slack] shared-state-recovered: persona=${KEY} cause=${closing} closed=${closing} channels=${JSON.stringify(scope.channels)} path=${JSON.stringify(SHARED_PATH)} state and current membership trustworthy; held messages are decided now. Slack retries are finite; messages Slack stopped retrying are not recovered.`)
    }
    for (const [label, staged] of SHARED_STAGED_SCOPES.filter(([, scope]) => scope.channels.length <= SHARED_STATE_NOTICE_MAX_CHANNELS)) {
      const pending = staged.repairPending!
      const status = `Repair is pending for this persona. Membership decided: ${pending.usable.join(', ') || 'none'}. Membership unresolved (intake held): ${pending.held.join(', ') || 'none'}${staged.dm ? '; DMs are held too' : ''}. These lists describe membership readiness only. Thread-dependent replies in thread_hybrid channels stay held and unacknowledged while Channel Stamps are undecided. Otherwise eligible @mentions, Broadcasts and other intake independent of Channel Stamps continue.`
      const text = buildSharedStateUnresolvedNotice(ref, staged, 'restoration-staged', SHARED_PATH)
      expect(text, label).toBe(`:warning: *Channel state unresolved* — ${ref}; all its channels; repair pending. Shared channel authority: ${JSON.stringify(SHARED_PATH)}. ${causes['restoration-staged'][0]} ${status} ${continuing} ${SHARED_STATE_STAGED_SLACK_RETRY_WARNING}`)
      expect(text).not.toContain('Still usable:')
      expect(text).not.toContain('Held: none')
      const line = buildSharedStateUnresolvedLine(KEY, staged, 'restoration-staged', SHARED_PATH)
      expect(line, label).toBe(`[slack] shared-state-unresolved: persona=${KEY} cause=restoration-staged scope=all channels=${JSON.stringify(staged.channels)}${staged.dm ? ' dm=true' : ''} repair_pending=true membership_decided=${JSON.stringify(pending.usable)} membership_held=${JSON.stringify(pending.held)} path=${JSON.stringify(SHARED_PATH)} ${causes['restoration-staged'][1]}. ${SHARED_STATE_STAGED_SLACK_RETRY_WARNING}`)
      expect(line).not.toMatch(/ (?:usable|held)=/)
    }
  })

  test.each(SHARED_SCOPE_CASES)('%s names every channel within the shared bound, the remainder and affected DM', (_label, scope) => {
    const notices = [
      [buildSharedStateUnresolvedNotice(sharedRef(), scope, 'unsynced', SHARED_PATH), false],
      [buildMembershipEvidenceUnresolvedNotice(sharedRef(), scope, sharedEvidence({ history: scope.channels.map(channel => ({ channel, evidence: 'absence-order' })) })), false],
      [buildSharedStateRecoveredNotice(sharedRef(), scope, 'repair'), false],
      [buildSharedStateUnresolvedNotice(sharedRef(), { ...scope, all: true }, 'not-saved', SHARED_PATH), true],
    ] as const
    for (const [text, inventory] of notices) {
      expect(text).toContain(sharedRef())
      for (const channel of scope.channels.slice(0, SHARED_STATE_NOTICE_MAX_CHANNELS)) expect(text).toContain(channel)
      for (const channel of scope.channels.slice(SHARED_STATE_NOTICE_MAX_CHANNELS)) expect(text).not.toContain(channel)
      const remaining = scope.channels.length - SHARED_STATE_NOTICE_MAX_CHANNELS
      if (remaining > 0) expect(text).toContain(`and ${remaining} more`)
      else expect(text).not.toContain(' more')
      expect(text.includes('all its channels')).toBe(scope.all === true && !inventory)
      expect(text.includes('membership inventory incomplete; known channels:')).toBe(inventory)
      expect(text.includes('DMs also affected')).toBe(scope.dm === true)
    }
    assertNoLeak(notices)
  })

  test('staged membership lists share one display budget; no channel beyond it leaks through the heading', () => {
    const scope = SHARED_STAGED_SCOPES.find(([label]) => label === 'staged over bound')![1]
    const text = buildSharedStateUnresolvedNotice(sharedRef(), scope, 'restoration-staged', SHARED_PATH)
    for (const channel of SHARED_CHANNELS.slice(0, SHARED_STATE_NOTICE_MAX_CHANNELS)) expect(text).toContain(channel)
    for (const channel of SHARED_CHANNELS.slice(SHARED_STATE_NOTICE_MAX_CHANNELS)) expect(text).not.toContain(channel)
    expect(text).toContain(`and ${SHARED_CHANNELS.length - SHARED_STATE_NOTICE_MAX_CHANNELS} more`)
    assertNoLeak(text)
  })

  test.each(SHARED_CONFIGURED_FIELDS.flatMap(fields => [false, true].map(all => ({ ...fields, all }))))('$label: all diagnostic variants preserve the full configured path and redact failures (all=$all)', ({ path, all }) => {
    const scope = sharedScope({ channels: SHARED_CHANNELS, all, dm: true })
    const failure = sharedFailure(path)
    const lines: Array<readonly [string, string, boolean?, boolean?]> = [
      ...sharedCauses.map(cause => [SHARED_STATE_DIAGNOSTIC_CLASSES[0], buildSharedStateUnresolvedLine(KEY,
        cause === 'restoration-staged' ? { ...scope, repairPending: { usable: SHARED_CHANNELS, held: [] } } : scope,
        cause, path, failure), cause === 'not-saved' && all, cause === 'restoration-staged'] as const),
      ...sharedHistory.map(evidence => [SHARED_STATE_DIAGNOSTIC_CLASSES[1], buildMembershipEvidenceUnresolvedLine(KEY, scope, sharedEvidence({ history: SHARED_CHANNELS.map(channel => ({ channel, evidence })) }), path, failure)] as const),
      ...sharedProblems.flatMap(problem => [undefined, 'missing_scope'].map(slackError => [SHARED_STATE_DIAGNOSTIC_CLASSES[1], buildMembershipEvidenceUnresolvedLine(KEY, scope, sharedEvidence({ problem, slackError, nextAttemptAt: MEMBERSHIP_FIXTURE_TIME }), path, failure)] as const)),
      ...sharedClosings.map(closing => [SHARED_STATE_DIAGNOSTIC_CLASSES[2], buildSharedStateRecoveredLine(KEY, scope, closing, path, failure)] as const),
    ]
    expect([...new Set(lines.map(([kind]) => kind))]).toEqual([...SHARED_STATE_DIAGNOSTIC_CLASSES])
    for (const [kind, line, inventory = false, staged = false] of lines) {
      assertNoLeak(withoutConfiguredSpans(line, [` path=${quotedMemoryPath(path)} `]))
      expect(line).toStartWith(`[slack] ${kind}: persona=${KEY} `)
      expect(line).not.toMatch(/[\r\n\u2028\u2029]/)
      expect(line).toContain(` ${inventory ? 'known_channels' : 'channels'}=${JSON.stringify(SHARED_CHANNELS)}`)
      expect(line).toContain(`path=${quotedMemoryPath(path)}`)
      const actualPath = line.match(/ path=("(?:[^"\\]|\\.)*") /)![1]!
      expect(JSON.parse(actualPath)).toBe(path)
      expect(line).toContain(redactSlackLogText(failure).replace(/[\r\n\u2028\u2029]/g, ' '))
      expect(line.includes('scope=all')).toBe(all && !inventory)
      expect(line.includes('scope=inventory')).toBe(inventory)
      expect(line).toContain('dm=true')
      expect(line).not.toContain(MEMORY_BODY)
      expect(line).not.toContain(MEMORY_USER)
      if (kind !== SHARED_STATE_DIAGNOSTIC_CLASSES[2]) expect(line).toContain(staged ? SHARED_STATE_STAGED_SLACK_RETRY_WARNING : SHARED_STATE_SLACK_RETRY_WARNING)
    }
    for (const evidence of sharedHistory) {
      const line = buildMembershipEvidenceUnresolvedLine(KEY, scope, { history: SHARED_CHANNELS.map(channel => ({ channel, evidence })) }, SHARED_PATH)
      for (const channel of SHARED_CHANNELS) expect(line).toContain(`${channel}:${evidence}`)
    }
  })

  test('staging diagnostics retain every decided/held membership channel and the generic line builder sanitizes each field', () => {
    for (const [, scope] of SHARED_STAGED_SCOPES) {
      const line = buildSharedStateUnresolvedLine(KEY, scope, 'restoration-staged', SHARED_PATH)
      expect(line).toContain(`repair_pending=true membership_decided=${JSON.stringify(scope.repairPending!.usable)} membership_held=${JSON.stringify(scope.repairPending!.held)}`)
      assertNoLeak(line)
    }
    for (const kind of SHARED_STATE_DIAGNOSTIC_CLASSES) {
      const line = buildSharedStateDiagnostic(kind, `${KEY}\n${fakeToken(BOT_TOKEN_PREFIX, 'key')}`, `identity\r${fakeToken(APP_TOKEN_PREFIX, 'identity')}`, `detail\u2028${sentinelInMessage('detail')}\u2029`)
      expect(line).not.toMatch(/[\r\n\u2028\u2029]/)
      assertNoLeak(line)
    }
  })

  test.each(SHARED_CONFIGURED_FIELDS)('$label: all four notices preserve configured fields and redact untrusted failures', ({ name, path }) => {
    const ref = renderPersonaRef(name, KEY)
    const escapedRef = escapeSlackControlCharacters(ref).replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029')
    const quotedPath = escapeSlackControlCharacters(quotedMemoryPath(path))
    const failure = `${sharedFailure(path)}\n<&>`
    const safeFailure = escapeSlackControlCharacters(redactSlackLogText(failure).replace(/[\r\n\u2028\u2029]/g, ' '))
    const rendered: Array<{ text: string; pathField?: string; hasFailure: boolean }> = [
      { text: buildSharedStateUnresolvedNotice(ref, sharedScope(), 'unsynced', path, failure), pathField: `Shared channel authority: ${quotedPath} (`, hasFailure: true },
      { text: buildSharedStateUnresolvedNotice(ref, SHARED_STAGED_SCOPES[0]![1], 'restoration-staged', path, failure), pathField: `Shared channel authority: ${quotedPath} (`, hasFailure: true },
      ...[false, true].map(all => ({ text: buildSharedStateUnresolvedNotice(ref, sharedScope({ all }), 'not-saved', path, failure), pathField: `Shared channel authority: ${quotedPath} (`, hasFailure: true })),
      { text: buildMembershipEvidenceUnresolvedNotice(ref, sharedScope(), sharedEvidence({ problem: 'access', slackError: failure })), hasFailure: true },
      { text: buildSharedStateRecoveredNotice(ref, sharedScope(), 'repair'), hasFailure: false },
      ...(['authority', 'retired-keys'] as const).map(record => ({
        text: buildReloadApplyFailedNotice(ref, { record, path, failure }),
        pathField: record === 'authority' ? `the shared channel authority at ${quotedPath} (` : undefined,
        hasFailure: true,
      })),
    ]
    for (const { text, pathField, hasFailure } of rendered) {
      const fields = [` — ${escapedRef}; `, ...(pathField ? [pathField] : [])]
      assertNoLeak(withoutConfiguredSpans(text, fields))
      expect(text).toContain(` — ${escapedRef}; `)
      if (pathField) expect(text).toContain(pathField)
      if (hasFailure) {
        expect(text).toContain(safeFailure)
        expect(text).toContain(escapeSlackControlCharacters(REDACTED_TOKEN_PLACEHOLDER))
      }
      expect(text).not.toMatch(/[\r\n\u2028\u2029]/)
      expect(text).not.toContain('<&>')
      expect(text).not.toContain('&amp;lt;')
      expect(text).not.toContain(MEMORY_BODY)
      expect(text).not.toContain(MEMORY_USER)
      // Only the designated occurrence is allowed. A duplicate configured
      // path in untrusted failure text must still trip the credential audit.
      for (const leak of [sharedTokenPath(), fakeToken(APP_TOKEN_PREFIX, 'unrelated-shared-credential')]) {
        expect(() => assertNoLeak(withoutConfiguredSpans(`${text} error=${leak}`, fields))).toThrow('assertNoLeak')
      }
    }
  })
})

describe('Thread Memory catalogue content and loss budget', () => {
  test('the catalogue retains every loss variant and name boundary', () => {
    expect(NOTICE_CATALOGUE.filter(e => e.builder === buildThreadMemoryJoinsLostNotice.name).map(e => e.variant)).toEqual([
      ...MEMORY_LOSSES.map(([label]) => label), ...MEMORY_NAMES.map(row => row.label),
    ])
    expect(NOTICE_CATALOGUE.filter(e => e.builder === buildThreadMemoryChangedWhileStoppedNotice.name).map(e => e.variant)).toEqual([
      'changed', 'unclean', ...MEMORY_CONFIGURED_NAMES.flatMap(({ label }) => [`changed; ${label}`, `unclean; ${label}`]),
    ])
  })

  test('notice texts and the final Slack-message bound (one literal pin)', () => {
    expect(THREAD_MEMORY_NOTICE_MAX_CHARS).toBe(4000)
    expect(THREAD_MEMORY_SLACK_RETRY_WARNING).toBe("If CSCB also can't save this bot's incoming messages, Slack retries each a limited number of times and can turn off the app's events. Check the app's Event Subscriptions page in Slack for disabled events; after storage works, send missing messages again.")
    const ref = memoryRef(), channels = MEMORY_CHANNELS.join(', ')
    const error = Object.assign(new Error('storage unavailable'), { code: 'EIO' })
    const warning = THREAD_MEMORY_SLACK_RETRY_WARNING
    expect(buildThreadMemoryNotSavedNotice(ref, MEMORY_CHANNELS, MEMORY_PATH, 'journal-append', error)).toBe(
      `:warning: *Thread Memory not saved* — ${ref}; channels: ${channels}. Could not save ${JSON.stringify(MEMORY_PATH)} (journal-append): Error code=EIO message="storage unavailable". Joins are kept and will be saved once storage works. Check the file's permissions and storage. ${warning}`,
    )
    expect(buildThreadMemoryUnreadableNotice(ref, MEMORY_CHANNELS, MEMORY_PATH)).toBe(
      `:warning: *Thread Memory unreadable* — ${ref}; channels: ${channels}. Cannot read ${JSON.stringify(MEMORY_PATH)}. Replies in this bot's threads are saved and wait until Thread Memory can be read. ${warning} Fix the file's permissions or storage. To start this bot's Thread Memory empty, stop CSCB, move the journal aside and start CSCB again; a Thread Memory changed while stopped report follows, and Joins lost names waiting replies to send again.`,
    )
    for (const [wording, sentence] of [
      ['changed', 'Some Joined Threads may be missing, or may be ones the bot should have forgotten.'],
      ['unclean', "CSCB didn't shut down cleanly, so it can't tell whether Thread Memory changed."],
    ] as const) {
      expect(buildThreadMemoryChangedWhileStoppedNotice(ref, MEMORY_CHANNELS, wording)).toBe(
        `:warning: *Thread Memory changed while stopped* — ${ref}; channels: ${channels}. ${sentence} CSCB uses the Thread Memory it found. Check the threads the bot should be in; a new @mention puts it back in a thread.`,
      )
    }
    expect(buildThreadMemoryRecoveredNotice(ref, MEMORY_CHANNELS)).toBe(
      `:white_check_mark: *Thread Memory recovered* — ${ref}; channels: ${channels}. Thread Memory can be read and every kept join is saved.`,
    )
    const loss = MEMORY_LOSSES.find(([label]) => label === 'mixed losses')![1]()
    expect(buildThreadMemoryJoinsLostNotice(PERSONA, loss)).toEqual({
      text: `:warning: *Joins lost* — ${ref} is no longer in the listed threads. A new @mention in a thread puts the bot back in it. Send each listed message again if it was meant for the bot. 3 quarantined line(s) have no readable thread identity.\nThread: ${THREAD_CHANNELS.primary} / ${THREAD_ROOTS.primary}.\nSend again: ${THREAD_CHANNELS.secondary} / ${THREAD_ROOTS.secondary}.`,
      options: { personaRef: ref },
    })
  })

  test.each(MEMORY_LOSSES)('%s retains complete ordered identifiers or an exact count, and logs every loss', (_label, makeLoss) => {
    const loss = makeLoss()
    const notice = buildThreadMemoryJoinsLostNotice(PERSONA, loss)
    const text = renderMemoryLoss(PERSONA, loss)
    const line = buildThreadMemoryJoinsLostLine(PERSONA, loss)
    assertNoLeak({ text, line })
    const identifiers = [
      ...loss.threads.map(t => `Thread: ${t.channel} / ${t.root}.`),
      ...loss.messages.map(m => `Send again: ${m.channel} / ${m.ts}.`),
    ]
    const [, ...bodyLines] = notice.text.split('\n')
    const hasCount = bodyLines.at(-1)?.includes('more thread/message entry(s)') ?? false
    const kept = hasCount ? bodyLines.slice(0, -1) : bodyLines
    expect(kept).toEqual(identifiers.slice(0, kept.length))
    expect(text.length).toBeLessThanOrEqual(THREAD_MEMORY_NOTICE_MAX_CHARS)
    const omitted = identifiers.length - kept.length
    if (omitted) {
      expect(kept.length).toBeGreaterThan(0)
      expect(bodyLines.at(-1)).toBe(`${omitted} more thread/message entry(s); see the server log for all identifiers.`)
      expect(line.length).toBeGreaterThan(THREAD_MEMORY_NOTICE_MAX_CHARS)
    } else {
      expect(hasCount).toBe(false)
      expect(kept).toEqual(identifiers)
    }
    // The full heading is a fitting builder result, pinned above; overflow
    // may change the display reference but must not truncate operator advice.
    const heading = buildThreadMemoryJoinsLostNotice(PERSONA, { threads: [], messages: [], unreadableLines: loss.unreadableLines }).text
    expect(notice.text.split('\n')[0]).toBe(heading.replaceAll(memoryRef(), notice.options.personaRef))
    if (loss.unreadableLines) expect(line).toContain(`unreadable_lines=${loss.unreadableLines}`)
    for (const t of loss.threads) expect(line).toContain(`channel=${t.channel} root=${t.root}`)
    for (const m of loss.messages) expect(line).toContain(`channel=${m.channel} ts=${m.ts}`)
    expect(line).toContain(`bot=${memoryRef()}`)
    expect(line).not.toMatch(/[\r\n\u2028\u2029]/)
  })

  test.each(MEMORY_NAMES)('$label budgets the escaped prefix and body together; the log retains the full name', ({ label, name, excerpt }) => {
    const persona = Object.freeze({ name: name(), key: KEY })
    const before = { ...persona }, full = fullLossForName(persona.name)
    const notice = buildThreadMemoryJoinsLostNotice(persona, oneThreadLoss())
    const text = formatPersonaNotice(persona, notice.text, notice.options)
    const line = buildThreadMemoryJoinsLostLine(persona, oneThreadLoss())
    expect(full.length > THREAD_MEMORY_NOTICE_MAX_CHARS).toBe(excerpt)
    if (label.startsWith('just ')) expect(Math.abs(full.length - THREAD_MEMORY_NOTICE_MAX_CHARS)).toBeLessThanOrEqual(2)
    if (label === 'Slack escaping alone crosses threshold') {
      expect(full.replaceAll('&amp;', '&').length).toBeLessThanOrEqual(THREAD_MEMORY_NOTICE_MAX_CHARS)
    }
    const displayName = excerpt ? Array.from(persona.name).slice(0, 64).join('') + '…' : persona.name
    const ref = escapeSlackControlCharacters(renderPersonaRef(displayName, KEY))
    expect(notice.options).toEqual({ personaRef: ref })
    expect(text).toBe(fullLossForName(displayName))
    expect(text.split(ref)).toHaveLength(3) // exactly the prefix and body
    expect(text.length).toBeLessThanOrEqual(THREAD_MEMORY_NOTICE_MAX_CHARS)
    expect(text).not.toContain('&amp;lt;')
    expect(text).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u)
    expect(line).toContain(`bot=${renderPersonaRef(persona.name, KEY)}`)
    expect(line).toContain(`channel=${THREAD_CHANNELS.primary} root=${THREAD_ROOTS.primary}`)
    expect(persona).toEqual(before)
    assertNoLeak({ text, line })
  })

  test.each(MEMORY_CONFIGURED_NAMES)('$label is preserved in all five non-loss wordings', ({ name, label }) => {
    const ref = renderPersonaRef(name, KEY), escaped = escapeSlackControlCharacters(ref)
    const persona = Object.freeze({ name, key: KEY })
    for (const { variant, build } of MEMORY_NON_LOSS_NOTICES) {
      const body = build(ref), text = formatPersonaNotice(persona, body)
      // Reuse the pinned ordinary notice as the content oracle: only the
      // configured reference changes, never its channels, advice or error.
      expect({ variant, body }).toEqual({ variant, body: build(memoryRef()).replace(memoryRef(), escaped) })
      expect(text).toStartWith(`Persona ${ref}: `)
      expect(body).toContain(` — ${escaped}; channels:`)
      expect(body).not.toContain('&amp;lt;')
      if (label.startsWith('long name')) expect(text.length).toBeGreaterThan(THREAD_MEMORY_NOTICE_MAX_CHARS)
      assertNoLeak(withoutConfiguredSpans(text, [`Persona ${ref}: `, ` — ${escaped}; channels:`]))
      expect(text).not.toContain(MEMORY_BODY)
      expect(text).not.toContain(MEMORY_USER)
    }
    expect(persona).toEqual({ name, key: KEY })
  })

  test.each(MEMORY_CONFIGURED_PATHS)('$label is preserved and quoted in both path-bearing notices', ({ path }) => {
    const quoted = escapeSlackControlCharacters(quotedMemoryPath(path))
    const error = memoryError(path)
    const rendered = [
      [buildThreadMemoryNotSavedNotice(memoryRef(), MEMORY_CHANNELS, path, 'journal-append', error), `Could not save ${quoted} (`],
      [buildThreadMemoryUnreadableNotice(memoryRef(), MEMORY_CHANNELS, path), `Cannot read ${quoted}.`],
    ] as const
    for (const [body, field] of rendered) {
      const text = formatPersonaNotice(PERSONA, body)
      expect(text).toContain(field)
      expect(text).not.toContain('<journal>')
      expect(text).not.toContain('&amp;lt;')
      expect(text).not.toMatch(/[\r\n\u2028\u2029]/)
      expect(text).not.toContain(MEMORY_BODY)
      expect(text).not.toContain(MEMORY_USER)
      assertNoLeak(withoutConfiguredSpans(text, [field]))
    }
    expect(rendered[0][0]).toContain(escapeSlackControlCharacters(REDACTED_TOKEN_PLACEHOLDER))
  })

  test('metadata projection ignores extra message and user fields; only configured fields bypass error redaction', () => {
    const contaminated = {
      threads: [{ channel: THREAD_CHANNELS.primary, root: THREAD_ROOTS.primary, text: MEMORY_BODY, user: MEMORY_USER, credentials: LEAK_SENTINEL }],
      messages: [{ channel: THREAD_CHANNELS.secondary, ts: THREAD_ROOTS.secondary, text: MEMORY_BODY, user: MEMORY_USER, credentials: LEAK_SENTINEL }],
      text: MEMORY_BODY, user: MEMORY_USER,
    }
    const captured = [
      renderMemoryLoss(PERSONA, contaminated), buildThreadMemoryJoinsLostLine(PERSONA, contaminated),
      ...threadMemoryEntries().map(e => withoutConfiguredSpans(e.render(), e.configuredSpans)),
    ]
    assertNoLeak(captured)
    for (const text of captured) {
      expect(text).not.toContain(MEMORY_BODY)
      expect(text).not.toContain(MEMORY_USER)
    }
    for (const e of threadMemoryEntries().filter(e => e.variant.includes('token-bearing'))) {
      const text = e.render()
      if (e.builder === buildThreadMemoryNotSavedNotice.name) expect(text).toContain(escapeSlackControlCharacters(REDACTED_TOKEN_PLACEHOLDER))
      expect(text).toContain(escapeSlackControlCharacters(quotedMemoryPath(memoryTokenPath())))
      expect(text).toContain('&lt;journal&gt;&amp;')
      expect(text).not.toContain('<journal>')
      expect(text).not.toContain('&amp;lt;')
    }
  })

  test('configured-field masking still rejects the same path, name or a different credential outside those fields', () => {
    const path = memoryTokenPath(), name = MEMORY_CONFIGURED_NAMES[0]!.name
    const ref = renderPersonaRef(name, KEY)
    const body = buildThreadMemoryNotSavedNotice(ref, MEMORY_CHANNELS, path, 'journal-append', memoryError(path))
    const text = formatPersonaNotice({ name, key: KEY }, body)
    const fields = [`Persona ${ref}: `, ` — ${escapeSlackControlCharacters(ref)}; channels:`, `Could not save ${escapeSlackControlCharacters(quotedMemoryPath(path))} (`]
    assertNoLeak(withoutConfiguredSpans(text, fields))
    for (const leak of [path, ref, fakeToken(APP_TOKEN_PREFIX, 'unrelated-credential')]) {
      expect(() => assertNoLeak(withoutConfiguredSpans(`${text} error=${leak}`, fields))).toThrow('assertNoLeak')
    }
  })
})

describe('Thread Memory diagnostic builders', () => {
  function rows(path: string, error: Error) {
    const channels = MEMORY_CHANNELS
    const loss = MEMORY_LOSSES.find(([label]) => label === 'mixed losses')![1]()
    return [
      ['thread-memory-not-saved', KEY, buildThreadMemoryNotSavedLine(KEY, channels, path, 'journal-append', error), path],
      ['thread-memory-unreadable', KEY, buildThreadMemoryUnreadableLine(KEY, channels, path, error), path],
      ['thread-memory-unreadable', KEY, buildThreadMemoryUnreadableLine(KEY, channels, path, undefined, true), path],
      ['thread-memory-joins-lost', KEY, buildThreadMemoryJoinsLostLine(PERSONA, loss)],
      ['thread-memory-changed-while-stopped', KEY, buildThreadMemoryChangedWhileStoppedLine(KEY, channels, 'journal-changed', 'changed')],
      ['thread-memory-changed-while-stopped', KEY, buildThreadMemoryChangedWhileStoppedLine(KEY, channels, 'unclean-stop', 'unclean')],
      ['thread-memory-recovered', KEY, buildThreadMemoryRecoveredLine(KEY, channels)],
      ['thread-memory-quarantined', KEY, buildThreadMemoryQuarantinedLine(KEY, path, 4, 1), path],
      ['thread-memory-compaction-failed', KEY, buildThreadMemoryCompactionFailedLine(KEY, path, 'journal-rewrite', error), path],
      ['thread-memory-removal-failed', KEY, buildThreadMemoryRemovalFailedLine(KEY, path, 'unlink', error), path],
      ['thread-memory-seal-unreadable', 'all', buildThreadMemorySealUnreadableLine(path, error), path],
      ...[false, true].map(unsynced => ['thread-memory-seal-not-saved', 'all', buildThreadMemorySealNotSavedLine(path, error, unsynced), path]),
      ['thread-memory-holds-not-resolved', KEY, buildThreadMemoryHoldsNotResolvedLine(KEY, error)],
    ]
  }

  test.each(MEMORY_CONFIGURED_PATHS)('$label: all eleven classes retain configured fields, redact errors and render one log line', ({ path }) => {
    const rendered = rows(path, memoryError(path))
    expect([...new Set(rendered.map(([kind]) => kind))].sort()).toEqual([...THREAD_MEMORY_DIAGNOSTIC_CLASSES].sort())
    for (const [kind, key, line, configuredPath] of rendered) {
      expect(line!).toStartWith(`[slack] ${kind}: persona=${key} `)
      expect(line!).not.toMatch(/[\r\n\u2028\u2029]/)
      expect(line!).not.toContain(MEMORY_BODY)
      expect(line!).not.toContain(MEMORY_USER)
      const fields = configuredPath === undefined ? [] : [` path=${quotedMemoryPath(configuredPath)} `]
      assertNoLeak(withoutConfiguredSpans(line!, fields))
      if (configuredPath !== undefined) {
        expect(line!).toContain(fields[0]!)
        // Decode the actual field, not a re-rendered value: quotes, newlines,
        // backslashes, token-shaped segments and Slack markup all round-trip.
        const actual = line!.match(/ path=("(?:[^"\\]|\\.)*") /)![1]!
        expect(JSON.parse(actual)).toBe(path)
        expect(line!).not.toContain('&lt;journal&gt;')
      }
    }
    expect(rendered.filter(([, , , configuredPath]) => configuredPath !== undefined)).toHaveLength(9)
    for (const [, , line] of rendered.filter(([, , line]) => line!.includes('code='))) {
      expect(line!).toContain('code=EACCES')
      expect(line!).toContain(`cannot write <journal> & ${REDACTED_TOKEN_PLACEHOLDER}`)
    }
  })

  test('diagnostic identities and operator actions (one literal pin)', () => {
    const c = `channels=${JSON.stringify(MEMORY_CHANNELS)}`, p = `path=${JSON.stringify(MEMORY_PATH)}`
    const error = new Error('storage unavailable'), cause = 'Error message="storage unavailable"'
    const expected = [
      `${c} step=journal-append ${p} ${cause}; joins kept, saving retried; check permissions/storage. ${THREAD_MEMORY_SLACK_RETRY_WARNING}`,
      `${c} ${p} ${cause}; replies saved and waiting; fix permissions/storage, or stop CSCB, move the journal aside and start again. ${THREAD_MEMORY_SLACK_RETRY_WARNING}`,
      `${c} ${p} journal missing on retry; Thread Memory stays unknown until the next start; waiting replies remain saved`,
      `threads=[channel=${THREAD_CHANNELS.primary} root=${THREAD_ROOTS.primary}] messages=[channel=${THREAD_CHANNELS.secondary} ts=${THREAD_ROOTS.secondary}] unreadable_lines=3 bot no longer in these threads; a new @mention puts it back; send each listed message again if meant for the bot bot=${memoryRef()}`,
      `${c} case=journal-changed wording=changed Joined Threads may be missing or ones the bot should have forgotten; check threads, a new @mention puts the bot back`,
      `${c} case=unclean-stop wording=unclean CSCB didn't shut down cleanly; cannot tell whether Thread Memory changed; check threads, a new @mention puts the bot back`,
      `${c} Thread Memory readable; every kept join saved`,
      `lines=4 invalid_final_lines=1 ${p} invalid lines quarantined; an invalid final line has no Joins lost report`,
      `step=journal-rewrite ${p} ${cause}; compaction not confirmed; journal retained, retried at maintenance`,
      `step=unlink ${p} ${cause}; removal retried at next start`,
      `${p} ${cause}; seal treated as having no entries`,
      `written_but_not_synced=false ${p} ${cause}; seal write retried`,
      `written_but_not_synced=true ${p} ${cause}; seal write retried`,
      `step=resolution-append ${cause}; Memory Hold resolution not saved, retried`,
    ]
    const rendered = rows(MEMORY_PATH, error)
    expect(rendered.map(([kind, key, line]) => line)).toEqual(rendered.map(([kind, key], i) => `[slack] ${kind}: persona=${key} ${expected[i]}`))
    assertNoLeak(rendered)
  })
})

describe('no notice names a forbidden term in CSCB\'s own text', () => {
  test.each(CASES)('%s', (_title, e) => {
    expect(forbiddenTermsIn(ownTextOf(e.render()))).toEqual([])
  })
})

describe('the CONFLICT, unusable-name, launch-start and stuck-launch posts name no session-ending command in their own lines', () => {
  test.each(CASES.filter(([, e]) => SESSION_ENDING_FREE_BUILDERS.includes(e.builder)))('%s', (_title, e) => {
    expect(cscbOwnLines(e.render()).flatMap((line) => sessionEndingCommandsIn(line).map((form) => `${form} in ${JSON.stringify(line)}`))).toEqual([])
  })

  test('every one of those builders, both stuck-launch texts included, is in the catalogue', () => {
    expect(SESSION_ENDING_FREE_BUILDERS.filter((builder) => !NOTICE_CATALOGUE.some((e) => e.builder === builder))).toEqual([])
  })
})

describe('a Slack notice that names a command or "Operator actions" carries the human-only sentence', () => {
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

describe('a Slack notice names "Operator actions" only by its quoted title', () => {
  test.each(SLACK_CASES)('%s', (_title, e) => {
    expect(namesOperatorActionsUnquoted(ownTextOf(e.render()))).toBe(false)
  })
})

describe('only the ordinary kill-failure alert and the wedge warning name `agent-director kill`, each checking its result', () => {
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

describe("agent-director's quoted words are never CSCB's own", () => {
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
    // The session-ending forms take "kill" only as a command to run, so these two are no hit even unquoted (agent-director contract).
    expect([NO_KILL_SENT_PHRASE, RETRY_KILL_LATER_PHRASE].flatMap(sessionEndingCommandsIn)).toEqual([])
  })
})

describe('the rule patterns find what they look for (the checks are not vacuous)', () => {
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
    const kill = `\`agent-director kill --instance-id ${personaInstanceId(KEY)}\``
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
    expect(COMMAND_SPAN.test(`run \`agent-director read-pane --instance-id ${personaInstanceId(KEY)}\``)).toBe(true)
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
    // The contract's and the docs' wordings.
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

describe('a description quoted from agent-director is redacted and capped at MAX_LOGGED_MESSAGE_LENGTH', () => {
  const redacted = [REDACTED_TOKEN_PLACEHOLDER, escapeSlackControlCharacters(REDACTED_TOKEN_PLACEHOLDER)]
  const capRows = CASES.filter(([, e]) => e.variant.endsWith(CAP_VARIANT))

  test.each(capRows)('%s', (_title, e) => {
    const text = e.render()
    assertNoLeak(text, titleOf(e))
    expect(redacted.some((r) => text.includes(r))).toBe(true)
    expect(text).not.toContain(CAP_TAIL)
  })

  test('every builder that quotes agent-director has a redaction-and-cap row', () => {
    // Thread Memory quotes storage errors, not agent-director descriptions;
    // its loss notice has its own final-message budget below.
    const quoting = new Set(NOTICE_CATALOGUE.filter((e) => e.group !== 'thread-memory' && e.group !== 'shared-state' && redacted.some((r) => e.render().includes(r))).map((e) => e.builder))
    const capped = new Set(capRows.map(([, e]) => e.builder))
    expect([...quoting].filter((builder) => !capped.has(builder)).sort()).toEqual([])
  })
})

describe('the lines for a fault after a confirmed post are one line of safe identifiers', () => {
  const settleError = () => Object.assign(new Error(sentinelInMessage('hold-settle')), { code: 'EIO' })
  const REQUEST_TOKEN = 'req-no-ts-prompt-0001'

  test('the hold settle-failure line names the persona and carries the fault only as its safe description', () => {
    const line = buildHoldSettleFailedLine(KEY, describeThrownValue(settleError()))
    assertNoLeak(line, 'hold settle-failure line')
    expect({
      prefix: line.startsWith('[slack] persona-destination-hold: '),
      oneLine: !/[\r\n]/.test(line),
      persona: line.includes(`persona=${KEY}:`),
      code: line.includes('code=EIO'),
    }).toEqual({ prefix: true, oneLine: true, persona: true, code: true })
  })

  test('self-check: the hold line does not redact a raw message itself, so the leak check catches one', () => {
    expect(() => assertNoLeak(buildHoldSettleFailedLine(KEY, settleError().message), 'hold line with raw message')).toThrow()
  })

  test('the no-ts prompt line names the instance and request token and leaks nothing', () => {
    const instance = personaInstanceId(KEY)
    const line = buildPromptPostedWithoutTsLine(instance, REQUEST_TOKEN)
    assertNoLeak(line, 'no-ts prompt line')
    expect({
      prefix: line.startsWith('[slack] permission-poller: '),
      oneLine: !/[\r\n]/.test(line),
      instance: line.includes(instance),
      token: line.includes(`request_token=${REQUEST_TOKEN}`),
    }).toEqual({ prefix: true, oneLine: true, instance: true, token: true })
  })
})
