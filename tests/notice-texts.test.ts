/**
 * notice-texts.test.ts — The notice catalogue: every exported SRJ-10xx notice
 * builder, rendered for every variant it has, held against rules that apply to
 * every notice (b.jg5 SRJ-1001). E31 checks SRJ-511 (AC 47): no notice names
 * `clear-latch` in any spelling (tests/test-helpers/clear-latch-terms.ts). E36
 * extends the same catalogue for the rest of SRJ-1001.
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
 * server notice), the persona prefix, every outage onset and the
 * spawn-failure notice. The teardown
 * window's notices (SRJ-1003) are the kill outcome's one-line renderings.
 * agent-director's words come from the stub's descriptions; a fake token
 * (`sentinelInMessage`) rides in every quoted description that can carry one.
 *
 * Checks: each entry's text names no `clear-latch` term (the case title names
 * the SRJ id, the builder and the variant); every rendered text passes
 * `assertNoLeak`; every Slack notice that quotes agent-director's description
 * (`SLACK_QUOTING_NOTICES`) escapes Slack's control characters in it exactly
 * once; the completeness guard holds every id from SRJ-1003 to
 * SRJ-1021 either in the catalogue or in `NOT_APPLICABLE` with its reason,
 * never both; and the finder's self-check shows it finds each term, so the
 * checks are not vacuous.
 *
 * Pure: every builder here is a pure function of its arguments; nothing is
 * started, written or posted.
 *
 * SPDX-License-Identifier: MIT
 */

import { describe, expect, test } from 'bun:test'

import { CLEAR_LATCH_COMMAND, CLEAR_LATCH_ROUTE } from '../src/clear-latch.ts'
import {
  AD_ERROR_CLASS_CONFLICT,
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
import {
  killFailureStoppedRetryText,
  tmuxUnresponsiveAlertText,
  tmuxUnresponsiveOnsetText,
  tmuxUnresponsiveRecoveryText,
  personaUnclassifiedErrorEntryText,
  unclassifiedErrorAlertText,
} from '../src/persona-episodes.ts'
import { personaInstanceId, personaTmuxSessionName } from '../src/persona-identity.ts'
import {
  formatPersonaNotice,
  PERSONA_TEARDOWN_NOTICE_ALL_CLEAR_AFTER,
  PERSONA_TEARDOWN_NOTICE_DURING_WAIT,
  PERSONA_TEARDOWN_NOTICE_RAISED,
  personaTeardownNoticeEntryText,
  type PersonaTeardownNoticeOccasion,
} from '../src/persona-notifier.ts'
import { retiredKeysUnreadableMessage } from '../src/retired-keys.ts'
import { spawnFailureNoticeText } from '../src/session-manager.ts'
import { REDACTED_TOKEN_PLACEHOLDER } from '../src/slack-log-redaction.ts'
import { escapeSlackControlCharacters } from '../src/slack-text-escape.ts'
import { slowRecoveryText } from '../src/slow-recovery.ts'

import {
  errConfigMalformed,
  errGeneric,
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
import { CONFLICT_CASE_ROWS } from './test-helpers/conflict-cases.ts'
import { assertNoLeak, sentinelInMessage } from './test-helpers/credentials.ts'

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

/** A kill's non-success outcome from the stub's `ErrTmuxKillFailed`, a fake token in its description. */
function killFailedOutcome(): KillFailure {
  const outcome = killOutcomeOf({ thrown: errGeneric('kill', 'ErrTmuxKillFailed', killFailedDescription('outlived-exit-wait')) })
  if (outcome.kind !== KILL_OUTCOME_NOT_KILLED) throw new Error('notice-texts: the stub kill failure did not give a not-killed outcome')
  return outcome as KillFailure
}

/** A CONFLICT answer at a kill, a fake token in its description. */
function conflictAtKill() {
  const session = personaTmuxSessionName(OLD_KEY)
  return errGeneric('kill', 'ErrTmuxSessionConflict', withToken(errTmuxSessionConflict('kill', 'not-this-launch', session).errDescription, 'teardown-conflict'))
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
 * Every SRJ-10xx notice builder's output, by SRJ id. E36 adds its entries
 * here (and moves an id out of `NOT_APPLICABLE` once a builder is exported).
 */
const NOTICE_CATALOGUE: readonly NoticeEntry[] = Object.freeze([
  ...commonEntries(),
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

/** The SRJ-10xx ids from SRJ-1003 to SRJ-1021 with no notice builder in the catalogue, each with its reason. */
const NOT_APPLICABLE: Readonly<Partial<Record<NoticeSrj, string>>> = Object.freeze({
  'SRJ-1014': 'log lines, not notices: each is asserted with its behaviour',
  'SRJ-1015': 'the start summary line is a server-log line, not a notice',
  'SRJ-1016': 'episodes rate-limit notices and have no text of their own',
})

/** Every id the completeness guard covers: SRJ-1003 to SRJ-1021. */
const GUARDED_IDS: readonly NoticeSrj[] = Array.from({ length: 21 - 3 + 1 }, (_, i) => `SRJ-10${String(3 + i).padStart(2, '0')}` as NoticeSrj)

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

describe('the notice catalogue is complete (SRJ-1003 to SRJ-1021)', () => {
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

  test('the CONFLICT entries cover every row of the conflict-case table, and the unusable-name entries every fault', () => {
    expect(NOTICE_CATALOGUE.filter((e) => e.builder === 'conflictNoticeText').map((e) => e.variant)).toEqual(
      expect.arrayContaining(CONFLICT_CASE_ROWS.map((row) => row.name)),
    )
    expect(NOTICE_CATALOGUE.filter((e) => e.builder === 'unusableNameNoticeText').map((e) => e.variant)).toEqual(
      expect.arrayContaining([...UNUSABLE_NAME_FAULTS]),
    )
  })
})
