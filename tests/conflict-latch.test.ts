/**
 * conflict-latch.test.ts — CONFLICT case recognition (b.jg5 SRJ-507), the
 * `tests/conflict-latch.test.ts` half of SRJ-1303, and the latch record
 * (SRJ-501, with SRJ-506's same-case rule) over `createConflictLatch`.
 *
 * Recognition: every row of the case table (`tests/test-helpers/conflict-cases.ts`)
 * resolves to its case; a description carrying several case phrases takes the
 * first in `CONFLICT_CASE_ORDER`, and so does a description built from any two
 * phrase constants, in either textual order; the plain spawn's label wordings
 * and the other words beside a case phrase are no case; one pin case (the
 * file's only literal block) checks the exported order against SRJ-507's,
 * with "no pane 0.0" absent. The `different-id` and `another-store`
 * descriptions carry no "Operator actions" section title, which is read from
 * the stub's own descriptions, never typed.
 *
 * Record: latching a persona on each row's error records the quoted session,
 * the case, the refused operation and the row state; a description with no
 * quoted name records `slack_bot_<key>`; an empty or multi-line quoted span
 * is skipped whole (quotes pair left to right), so a later name is taken, and
 * a description with only such spans records `slack_bot_<key>`; a `waiting` state and an unreadable
 * state count as live, `pending`, `ended`, `missing` and no row do not; the
 * description is kept redacted, on one line and capped. A different case
 * relatches (the record replaced), the same case keeps the record unchanged
 * (SRJ-506, hatch A3), and `set` answers which. One latch per persona, a new
 * instance holds none, and `forget` is silent and per key. Set observers see
 * every set; a throwing or rejecting observer, and a throwing log, are
 * swallowed.
 *
 * The CONFLICT notice (SRJ-1004), its episode (SRJ-508, SRJ-1016) and the
 * recovery texts (SRJ-1005). One pin case (the file's only literal block for
 * these texts) checks every case's notice, every fixed line and both recovery
 * templates with each reason against SRJ-1004's and SRJ-1005's words. Every
 * other case compares with the helper's `expectedConflictNotice`, assembled
 * from the exported constants: per row, the post a real latch bound to real
 * notice episodes makes is the row's expected notice, its lines in SRJ-1004's
 * order ("a different instance id": its must-not-be-ended line in place of
 * the pointer and no "Operator actions"; "another agent-director store": its
 * must-not-be-ended line, then the pointer, then the `list` line); CSCB's own
 * lines (`cscbOwnLines`) match none of `SESSION_ENDING_COMMAND_FORMS` and none
 * of this file's `CSCB_OWN_LINE_FORBIDDEN` (kill-pane, set-option,
 * agent-director delete, clear-latch, has-session, a label option name), while
 * the quoted "no kill was sent" is let through; the description is redacted,
 * capped and escaped once for Slack (the log line stays unescaped), and a
 * record with none has no description line. Episode: a latch posts once, a
 * same-case set posts nothing, a new case posts once more, another persona
 * posts only for itself, a hold case, a closed instance and an unbound
 * observer post nothing, and a b.f2b `unproven-idle` or `blocked-on-prompt`
 * notice already raised for the persona suppresses nothing (AC 41). A hold
 * case opens no CONFLICT episode and posts no CONFLICT notice: each hold
 * opens its own episode kind, and the unusable-name hold posts SRJ-1019.
 *
 * The unusable recorded name (SRJ-512, SRJ-1019, SRJ-508, SRJ-1016; AC 77,
 * AC 85), over the helper's `UNUSABLE_NAME_CASE_ROWS`. One pin case (the
 * file's only literal block for this text) checks SRJ-1019 word for word
 * against the builder; every other case compares with the rows' `notice`.
 * Per fault: the latch posts the row's notice once, with the instance id,
 * the description rendered (redacted, capped) and quoted, the "Operator
 * actions" title (read from the stub) and the human-only sentence; CSCB's
 * own text (`cscbOwnText`) names no session-ending command and nothing of
 * `CSCB_OWN_LINE_FORBIDDEN`. A sentinel-bearing description is redacted and
 * an overlong one capped; through `makeNotifierHarness` the persona's own
 * stub gets `formatPersonaNotice(persona, notice)` at its destination. Per
 * row: the record (the case, "none", the row's state, `slack_bot_<key>`, the
 * description) and the matching set input; a quoted session is recorded by
 * SRJ-501's rule; an `ErrInternal` without the phrase, and other values,
 * latch nothing. Episode: the first latch posts once under the unusable-name
 * kind, a second UNUSABLE NAME posts nothing, a relatch from a CONFLICT posts
 * once and a relatch back posts SRJ-1004 once (each ending the other kind's
 * episode silently), and a not-connected notice suppresses nothing.
 *
 * SRJ-512's automated half (SRJ-502, on `makeRecoveryHarness`, both settings
 * 0): P latches from `resume`'s UNUSABLE NAME, and in a second harness from
 * the working-row evidence `read-pane`; then a new launch, the retry entry,
 * a scheduled and a human-triggered restart and the retry timer make no
 * tmux-touching call (`tmuxTouchingCallsIn`) or delete for P's instance and
 * no raw tmux seam call (`recordRawTmux`) for P's session, count nothing,
 * and leave exactly one post, SRJ-1019; Q's paths reach the stub as before.
 * A message lost for P so latched reports `held-for-human` with no call and
 * no restart; Q's reports its own state. The UNCLASSIFIED control: an
 * `ErrInternal` without the phrase at the same `resume` latches nothing,
 * posts no hold notice and takes E12's handling (the unclassified episode,
 * the UNCLASSIFIED cause armed, nothing counted).
 *
 * The reconnect as a latch site (SRJ-118, SRJ-505, on `makeRecoveryHarness`,
 * both settings 0): P launches onto a colliding `waiting` row whose
 * reconnect's one `send-keys` answers CONFLICT (a case-table reconnect row)
 * or UNUSABLE NAME; P latches once with one post, and the same paths plus a
 * health tick make no further `send-keys`, other tmux-touching call, raw tmux
 * call or delete for P and count nothing, the retry timer stopping latched;
 * Q launches and reconnects as before.
 * Recovery: each reason ("row reads" over every live and dead state) under
 * both latch kinds, with no line matching either list.
 *
 * AC 46's automated half (SRJ-502, on `makeRecoveryHarness` with both
 * settings 0): P latches through the launch driver at a plain-spawn row and
 * at a `resume` row; then a new launch, the retry entry, a scheduled restart,
 * a human-triggered restart request, the retry timer (armed after the latch,
 * over several waits) and a health tick with the latched query bound make no
 * kill, spawn, resume or delete for P (the tick reads its liveness only), and
 * the latch posts exactly one CONFLICT notice and no spawn-failure notice;
 * Q's run of each path is asserted call for call. The restart module's delay
 * accessor answers a non-zero delay (the setting 0 arms no restart timer), and
 * the restart timer and the health interval, which take no clock, are fired
 * by hand from a captured callback, so no real timer runs. A failing
 * latch-time `status` read (UNAVAILABLE, and UNCLASSIFIED) proves the order:
 * the read before any set, then the set, the three holds in order and the
 * notice, by which P's timer, `tmux-unresponsive` condition and
 * unclassified episode are all closed, and nothing fires for P afterwards.
 *
 * The holds' set observer (SRJ-502, SRJ-610, SRJ-1016), pure: on a set the
 * four holds (the timer's stop, the condition's end, the unclassified end and
 * the slow-recovery end) run for the persona in that order, before a notice
 * observer bound after them; a hold that throws is logged and the next still
 * runs; holds with no slow-recovery end run the other three. The latch's
 * slow-recovery end on `makeRecoveryHarness` (SRJ-610, SRJ-1016, SRJ-502):
 * P's and Q's rows read `working` with their panes gone, so three restart
 * runs each escalate dead with a live re-probe and open both slow-recovery
 * episodes (one `slowRecoveryText` post each); P's next run meets the
 * working-row verdict's `read-pane` CONFLICT and latches; by the CONFLICT
 * notice P's count is 0 and its episode ended, with the latched reason's
 * lines and no slow-recovery post, exactly one CONFLICT post follows, later
 * runs for P are latched and post nothing, and Q keeps its count and open
 * episode; the harness's cleanup leaves no count or episode behind.
 *
 * A lost message while latched (SRJ-502, SRJ-1011, AC 68, on
 * `makeRecoveryHarness` with both settings 0): P latches through the launch
 * driver at a plain-spawn `scan-leftover` row; a message lost for P through
 * the harness's lost-message driver (the real routing's no-session branch,
 * its latched query the harness's latch, as `main()` binds it) reports
 * `held-for-human` with the exported wording, posted at P's destination, asks
 * the restart module for no restart and makes no call, and nothing fires for
 * P afterwards; Q's lost message reports its own state.
 *
 * SRJ-504's restart legs (AC 45, on `makeRecoveryHarness`): a server restart
 * is two harness lifetimes, the first cleaned up before the second is built,
 * each over a stub answering the same condition. In each lifetime P's
 * bring-up latches it with the one fresh latch reaction (set latched, the
 * three holds, one CONFLICT post), no spawn-failure notice and only the leg's
 * calls; before the second lifetime's first attempt P is unlatched, with no
 * record, event, post or call. The scan leg: the plain first spawn meets
 * `scan-leftover`, recorded "plain spawn" with no row (the latch-time `status`
 * read answers `ErrSpawnNotFound`). The "no valid label" leg, as today's
 * ladder reaches it (E22 makes its last step the reuse spawn): collision,
 * `get` reading `ended` with no session id, `resume` answering
 * `ErrNoSessionId`, delete, then the plain spawn answering `no-valid-id`,
 * recorded "plain spawn" with the collision `get`'s `ended`.
 *
 * The note rules (SRJ-114; SRJ-501's note trigger and its Test half;
 * SRJ-1004's note notice, hatch A2). The pure decision
 * (`decideOwnRowRead`): a configured persona's own row carrying the stub's
 * `provenanceNote`, in every state, decides a latch with "conflicting
 * labels", P's bring-up and the state read (a `waiting` state counts as
 * live); every other note agent-director names (`nonLatchingNotes`), the
 * stub's `unknownNote` (a prefix of it is the latching note), the latching
 * note case-folded or inside other text, and no note decide nothing; so does
 * the latching note on an unconfigured key's row, another caller's row,
 * another persona's row read for P and an id that only starts with P's.
 * Through the shared own-row read (`readPersonaOwnRow`) on
 * `makeRecoveryHarness`, its real latch and notice episodes: a note latch
 * once (the record is `slack_bot_<key>`, "conflicting labels", P's bring-up
 * and the live `waiting` state, with no description; one CONFLICT post; a
 * second read posts nothing; Q is neither latched nor called); the notice,
 * line by line from the exported constants and the case-sentence table, with
 * no "agent-director said" line; P latched first with another case relatches
 * on the note with one new post; a configured Q's own row latches Q alone;
 * and `tmux_server_changed`, `process_not_seen_session_present` (standing
 * for every other listed note), the unknown note, no note, and the latching
 * note on another caller's row, on a key outside the configuration and on a
 * removed persona's row latch no one and post nothing.
 *
 * A `pending` row with no launch start (SRJ-513, SRJ-1020, SRJ-508,
 * SRJ-1016; AC 8, AC 68, AC 86), over the helper's launch-start rows. The
 * decision: every latching row (a `status`, a `get` and a `list` read; P's
 * current life, another `cwd` and another `config_dir` label, covered or
 * not by construction; the launch start absent, `null` or unparseable)
 * decides "launch start not recorded", "none" and `pending`, and latched
 * from it P records that with `slack_bot_<key>` and posts the row's notice
 * once; every non-latching row (a launch start recorded, another state, an
 * absent persona's, another caller's or a pre-persona row) decides nothing;
 * a row with both the note and no launch start decides the launch-start case
 * only. One pin case (the file's only literal block for this text) checks
 * SRJ-1020 word for word against the builder; the notice quotes the session,
 * points to "Operator actions", and names no session-ending command and
 * nothing of `CSCB_OWN_LINE_FORBIDDEN`; through `makeNotifierHarness` it is
 * posted as `formatPersonaNotice(persona, notice)`. Episode: three more
 * reads post nothing; P latched first on a CONFLICT, on "unusable recorded
 * name" or on a note relatches with one new post, the record replaced; a
 * not-connected notice suppresses nothing. On `makeRecoveryHarness` (both
 * settings 0), with P's row read `pending` with no launch start
 * (`readPendingNoLaunchStart`): P latches once from the collision `get` (in
 * P's `cwd` and in another), a scheduled restart's liveness read, the retry
 * timer's pending-only row read and the lost-message read; then every
 * automated path (`driveEveryPath`) makes no call for P's instance, no
 * find-missing, counts nothing and leaves no timer armed, with one SRJ-1020
 * post; such a row under a key outside the configuration latches no one. A
 * CONFLICT or an UNUSABLE NAME whose latch-time `status` read finds such a
 * row leaves P latched with the launch-start case alone, one post (hatch
 * A2). A relatch through a real read (the shared own-row `status` read,
 * `readPersonaOwnRowStatus`): P latched first on a CONFLICT (at its launch)
 * or on "unusable recorded name" (at a `status` read) relatches on a read
 * of its own `pending` row with no launch start, the record replaced
 * (`launchStartRecord`), the first episode ended, one SRJ-1020 post and the
 * step's "the persona relatched" line; and P latched on the launch-start
 * case relatches on a read answering UNUSABLE NAME with one SRJ-1019 post.
 * Expected hold records come from the helper (an unusable-name row's
 * `record(key)`, `launchStartRecord(key)`), never typed here. A lost
 * message: its read of such a row latches P and reports
 * `held-for-human` with no restart; its read answering UNUSABLE NAME does
 * the same with SRJ-1019; with a launch start it reports `session-starting`;
 * with P already latched on either hold it reports `held-for-human` with no
 * read; Q reports its own state.
 *
 * The dialog approver's latches (SRJ-404, SRJ-501, SRJ-502, SRJ-512, SRJ-513;
 * SRJ-117 and SRJ-118's approver rows), on `makeRecoveryHarness` with both
 * settings 0, P's and Q's rows read `pending` with a launch start and every
 * pane showing the folder-trust dialog. Its own answer, per approver row of
 * the helper's tables (`APPROVER_CONFLICT_CASE_ROWS`: each CONFLICT its
 * `read-pane` and `send-keys` can meet, recording P's next check or recovery
 * and `pending`; `APPROVER_UNUSABLE_NAME_CASE_ROWS`: UNUSABLE NAME at its
 * `status`, `read-pane` and `send-keys`, refused operation none): the
 * approver stops `latched` with its lap's calls up to the refused one and
 * none after, P latches once through the latch's set entry (the set, the
 * three holds, one post), nothing is armed, counted or noticed, and Q's
 * approver presses Enter on its own dialog and runs on to its cap; then every
 * automated path (`driveEveryPath`) makes no call for P, tmux-touching or
 * raw, with still one post, while Q's paths reach the stub as before. A latch
 * from another path (an own-row `get` of a `provenance_conflict` note, an
 * own-row `status` of a `pending` row with no launch start, a CONFLICT at a
 * new launch's plain spawn), set while P's approver sleeps between laps or
 * while its `read-pane` showing the dialog is awaited: the approver stops
 * `latched` before the clock moves (its cap is past the laps driven), no
 * Enter reaches P after the latch and no call follows over three more laps,
 * with one post; Q, unlatched, presses Enter at each of its laps.
 *
 * Pure module under test, except the recovery-harness cases: one
 * `createConflictLatch` per test over a line capture and a recording
 * observer; `afterEach` runs `assertNoLeak` over every line, event and record
 * captured, over every notice post and over each harness's `captured()`,
 * then cleans the harness up (which throws on a pending timer) and resets the
 * health check and the raw tmux seams a case recorded. The notice cases build `createPersonaEpisodes` over
 * `createFakeClock` with a recording sink; `afterEach` checks no timer is
 * pending and clears the session-manager notifier and its not-connected
 * latch. No `mock.module()`.
 *
 * SPDX-License-Identifier: MIT
 */

import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  UNUSABLE_RECORDED_NAME_PHRASE,
  CONFLICT_ANOTHER_STORE_PHRASE,
  CONFLICT_CONFLICTING_LABELS_PHRASE,
  CONFLICT_DIFFERENT_ID_PHRASE,
  CONFLICT_LEFTOVER_PHRASE,
  CONFLICT_NEVER_REPORTED_IN_PHRASE,
  CONFLICT_NO_VALID_ID_PHRASE,
  CONFLICT_NOT_THIS_LAUNCH_PHRASE,
  CONFLICT_OWN_ID_PHRASE,
  CONFLICT_PANE_NOT_FOUND_PHRASE,
  NEVER_DELETE_ROW_PHRASE,
  NEW_ROW_ENDED_PHRASE,
  NO_KILL_SENT_PHRASE,
  NOTHING_WRITTEN_PHRASE,
  PANE_NOT_ADOPTED_PHRASE,
  PLAIN_SPAWN_LABEL_NAMES_THIS_ID_PHRASE,
  PLAIN_SPAWN_LABEL_NOT_THIS_ID_PHRASE,
  RETRY_KILL_LATER_PHRASE,
} from '../src/ad-description-phrases.ts'
import { adAlertThresholdMsInEffect } from '../src/ad-settings.ts'
import { ERR_TMUX_SESSION_CONFLICT_NAME } from '../src/agent-director-errors.ts'
import {
  CONFLICT_CASE_ORDER,
  CONFLICT_CASE_SENTENCES,
  CONFLICT_LATCH_SET_LATCHED,
  CONFLICT_LATCH_SET_RELATCHED,
  CONFLICT_LATCH_SET_SAME_CASE,
  CONFLICT_NOTICE_ANOTHER_STORE_MUST_NOT_END_LINE,
  CONFLICT_NOTICE_CASE_SENTENCE_LEAD,
  CONFLICT_NOTICE_DESCRIPTION_LINE_HEAD,
  CONFLICT_NOTICE_DESCRIPTION_LINE_TAIL,
  CONFLICT_NOTICE_DIFFERENT_ID_MUST_NOT_END_LINE,
  CONFLICT_NOTICE_FIRST_LINE_HEAD,
  CONFLICT_NOTICE_FIRST_LINE_TAIL,
  CONFLICT_NOTICE_HUMAN_ONLY_LINE,
  CONFLICT_NOTICE_LINE_SEPARATOR,
  CONFLICT_NOTICE_LIST_LINE_HEAD,
  CONFLICT_NOTICE_LIST_LINE_TAIL,
  CONFLICT_NOTICE_POINTER_LINE,
  CONFLICT_RECOVERY_HEAD,
  CONFLICT_RECOVERY_REASON_LEAD,
  HOLD_LATCH_CASES,
  HOLD_RECOVERY_HEAD,
  LATCH_CASES,
  LATCH_CASE_ANOTHER_STORE,
  LATCH_CASE_CONFLICTING_LABELS,
  LATCH_CASE_DIFFERENT_ID,
  LATCH_CASE_LAUNCH_START_NOT_RECORDED,
  LATCH_CASE_LEFTOVER,
  LATCH_CASE_NEVER_REPORTED_IN,
  LATCH_CASE_NO_VALID_ID,
  LATCH_CASE_NOT_THIS_LAUNCH,
  LATCH_CASE_OWN_ID,
  LATCH_CASE_PANE_NOT_FOUND,
  LATCH_CASE_UNRECOGNISED,
  LATCH_CASE_UNUSABLE_RECORDED_NAME,
  LATCH_KIND_CONFLICT,
  LATCH_KIND_HOLD,
  LATCH_RECOVERY_REASON_CLEARED_BY_HAND,
  LATCH_RECOVERY_REASON_KIND_ROW_READS,
  LATCH_RECOVERY_REASON_RELAUNCH_NOT_REFUSED,
  LATCH_RECOVERY_REASON_RETRY_NOT_REFUSED,
  LATCH_RECOVERY_REASON_ROW_GONE,
  LATCH_RECOVERY_REASON_ROW_READS_HEAD,
  LATCH_RECOVERY_REASON_TEXTS,
  LATCH_RECOVERY_TAIL,
  LAUNCH_START_NOTICE_POINTER,
  LATCH_ROW_STATE_KIND_NO_ROW,
  LATCH_ROW_STATE_NO_ROW,
  LATCH_ROW_STATE_UNREADABLE,
  REFUSED_OPERATION_BRING_UP,
  REFUSED_OPERATION_NEXT_CHECK_OR_RECOVERY,
  REFUSED_OPERATION_NONE,
  REFUSED_OPERATION_PLAIN_SPAWN,
  REFUSED_OPERATION_RESUME,
  REFUSED_OPERATION_REUSE_SPAWN,
  UNUSABLE_NAME_NOTICE_HEAD,
  UNUSABLE_NAME_NOTICE_REASON,
  bindConflictLatchHolds,
  bindConflictNotice,
  conflictCaseSentence,
  conflictNoticeText,
  conflictRecoveryText,
  conflictSessionName,
  createConflictLatch,
  holdRecoveryText,
  isHoldLatchCase,
  latchKindOf,
  latchRecoveryReasonRowReads,
  latchRecoveryReasonText,
  latchRecoveryText,
  latchRowStateRead,
  launchStartNotRecordedNoticeText,
  launchStartNotRecordedSetInput,
  recogniseConflictCase,
  rowStateCountsAsLive,
  takesUnrecognisedHandling,
  isUnusableNameError,
  unusableNameNoticeText,
  unusableNameSetInput,
  type ConflictLatch,
  type ConflictLatchCase,
  type ConflictLatchConflictFields,
  type ConflictLatchHolds,
  type ConflictLatchRecord,
  type ConflictLatchSetEvent,
  type ConflictLatchSetInput,
  type LatchCase,
  type LatchKind,
  type LatchRecoveryReason,
  type LatchRowState,
} from '../src/conflict-latch.ts'
import {
  AGENT_DIRECTOR_DEAD_STATES,
  AGENT_DIRECTOR_LIVE_STATES,
  AGENT_DIRECTOR_PENDING_STATE,
} from '../src/liveness-reading.ts'
import { MAX_LOGGED_MESSAGE_LENGTH, renderLogMessageText } from '../src/persona-connection-errors.ts'
import { formatPersonaNotice } from '../src/persona-notifier.ts'
import {
  createPersonaEpisodes,
  PERSONA_EPISODE_KIND_CONFLICT,
  PERSONA_EPISODE_KIND_LAUNCH_START_NOT_RECORDED,
  PERSONA_EPISODE_KIND_SLOW_DEAD_SESSION_RECOVERY,
  PERSONA_EPISODE_KIND_UNUSABLE_RECORDED_NAME,
  TMUX_UNRESPONSIVE_END_LATCHED,
  UNCLASSIFIED_ERROR_END_LATCHED,
  type PersonaEpisodeKind,
  type PersonaEpisodes,
} from '../src/persona-episodes.ts'
import { personaInstanceId, personaTmuxSessionName } from '../src/persona-identity.ts'
import type { PersonaSerialize, PersonaSerializer } from '../src/persona-serializer.ts'
import { getFailureCount, isAtCap } from '../src/backoff.ts'
import { _resetHealthCheckState, initHealthCheck, startHealthCheck, stopHealthCheck } from '../src/health-check.ts'
import {
  isRestartPendingOrActive,
  RESTART_FAILURE_CAP,
  RESTART_OUTCOME_LATCHED,
  RESTART_OUTCOME_LAUNCHED,
  RESTART_OUTCOME_RECONNECT_DEFERRED,
  runRestartRetry,
  scheduleRestart,
} from '../src/restart.ts'
import {
  SLOW_RECOVERY_POST_THRESHOLD,
  SLOW_RECOVERY_RESET_LATCHED,
  slowRecoveryCountResetLine,
  slowRecoveryEpisodeEndedLine,
  slowRecoveryText,
} from '../src/slow-recovery.ts'
import { _buildIsSessionAliveAdapter } from '../src/server.ts'
import { decideOwnRowRead, ROW_READ_LAUNCH_START_NOT_RECORDED, ROW_READ_NO_DECISION, type RowReadRow } from '../src/row-read-rules.ts'
import {
  APPROVER_STOP_CAP,
  APPROVER_STOP_LATCHED,
  DIALOG_POLL_INTERVAL_MS,
  TRUST_DIALOG_NEEDLE,
  _resetNotConnectedEpisodes,
  _resetTmuxCommandRunner,
  _resetTmuxSessionProber,
  _setTmuxCommandRunner,
  _setTmuxSessionKiller,
  _setTmuxSessionProber,
  isLaunchInFlight,
  notifyPersonaNotConnected,
  OWN_ROW_READ_ROW,
  OWN_ROW_STATUS_LATCHED,
  OWN_ROW_STATUS_STATE,
  readPersonaOwnRow,
  readPersonaOwnRowStatus,
  setSessionNotifier,
  type ApproverVerb,
  type NotConnectedNotice,
  type OwnRowReadSite,
} from '../src/session-manager.ts'
import {
  UNAVAILABLE_RETRY_CAUSE_READ_ERROR,
  UNAVAILABLE_RETRY_CAUSE_UNAVAILABLE,
  UNAVAILABLE_RETRY_CAUSE_UNCLASSIFIED,
  UNAVAILABLE_RETRY_CEILING_S,
  UNAVAILABLE_RETRY_MODE_PENDING_ONLY,
  UNAVAILABLE_RETRY_STOP_LATCHED,
} from '../src/unavailable-retry.ts'
import { REDACTED_TOKEN_PLACEHOLDER } from '../src/slack-log-redaction.ts'
import { escapeSlackControlCharacters } from '../src/slack-text-escape.ts'
import {
  CONFLICT_CASES,
  cannedGetResult,
  cannedStatusResult,
  errGeneric,
  errCallTimeout,
  errInternal,
  errNoSessionId,
  errSpawnNotFound,
  errTmuxCaptureFailed,
  errTmuxSessionConflict,
  errTmuxUnresponsive,
  errUnknownErrorName,
  nonLatchingNotes,
  provenanceNote,
  SAMPLE_LAUNCH_START_DEFAULT,
  SAMPLE_LAUNCH_START_NONE,
  STUB_TMUX_SESSION_NAME,
  UNUSABLE_NAME_FAULTS,
  errUnusableName,
  unknownNote,
  type CannedRowPersona,
  type UnusableNameFault,
} from './test-helpers/agent-director-stub.ts'
import {
  APPROVER_CONFLICT_CASE_ROWS,
  APPROVER_SITES,
  APPROVER_UNUSABLE_NAME_CASE_ROWS,
  APPROVER_VERB_CALLS,
  CONFLICT_CASE_ROWS,
  LAUNCH_START_ABSENT_PERSONA_KEY,
  LAUNCH_START_AND_NOTE_ROW,
  LAUNCH_START_ANOTHER_CALLERS_ID,
  LAUNCH_START_CASE_ROWS,
  LAUNCH_START_NON_LATCHING_ROWS,
  SESSION_ENDING_COMMAND_FORMS,
  UNUSABLE_NAME_CASE_ROWS,
  cscbOwnLines,
  cscbOwnText,
  expectedConflictNotice,
  expectedLatchRecord,
  isApproverSite,
  launchStartRecord,
  livenessPaneConflictRowsAt,
  reconnectConflictRowsAt,
  reconnectUnusableNameRowsAt,
  sessionEndingCommandsIn,
  tmuxTouchingCallCounts,
  tmuxTouchingCallsIn,
  type ConflictCaseRow,
  type LaunchStartCaseRow,
  type UnusableNameCaseRow,
  type UnusableNameSite,
} from './test-helpers/conflict-cases.ts'
import {
  BOT_TOKEN_PREFIX,
  LEAK_SENTINEL,
  REDACTED_SENTINEL_TAIL,
  assertNoLeak,
  fakeToken,
  sentinelInMessage,
} from './test-helpers/credentials.ts'
import { createFakeClock, type FakeClock } from './test-helpers/fake-clock.ts'
import { posts } from './test-helpers/permission-relay-harness.ts'
import { makeMultiPersonaConfig } from './test-helpers/persona-config.ts'
import { makeNotifierHarness } from './test-helpers/persona-notifier.ts'
import {
  callCounts,
  callCountsSince,
  collided,
  conditionEndedLine,
  conditionRecoveryLine,
  expectLostMessageReports,
  makeRecoveryHarness,
  personaCallCounts,
  personaOf,
  recordCallOrder,
  retryNow,
  unclassifiedEndedLine,
  unclassifiedLines,
  unclassifiedStartedLine,
  type RecoveryHarness,
  type RecoveryHarnessOptions,
  type RecoveryStubScript,
} from './test-helpers/recovery-harness.ts'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** The persona latched in most cases; its own session differs from the stub's quoted one. */
const KEY = 'alpha'
/** A second persona. */
const OTHER = 'beta'

interface LatchRun {
  readonly latch: ConflictLatch
  readonly lines: string[]
  readonly events: ConflictLatchSetEvent[]
}

/** Every run of this test, leak-checked in `afterEach`. */
let runs: LatchRun[] = []

/** One latch over a line capture and a recording set observer. */
function makeLatchRun(): LatchRun {
  const lines: string[] = []
  const events: ConflictLatchSetEvent[] = []
  const latch = createConflictLatch({ log: (line) => lines.push(line) })
  latch.addSetObserver((event) => {
    events.push(event)
  })
  const run = { latch, lines, events }
  runs.push(run)
  return run
}

afterEach(() => {
  const captured = runs.map((run) => ({
    lines: run.lines,
    events: run.events,
    records: [KEY, OTHER].map((key) => run.latch.record(key)),
  }))
  runs = []
  assertNoLeak(captured)
})

/** `test.each` rows over the case table: the row name, then the row. */
const ROWS = CONFLICT_CASE_ROWS.map((row) => [row.name, row] as const)

/** The `ended` row state. */
const ENDED = latchRowStateRead('ended')

/** A row's description, as the stub builds it. */
const descriptionOf = (row: ConflictCaseRow): string => row.build().errDescription

/** Latch `key` on a row's error with the row's refused operation and row state. */
function latchOnRow(latch: ConflictLatch, key: string, row: ConflictCaseRow, rowState: LatchRowState = row.rowState) {
  return latch.setFromConflict(key, row.build(), { refusedOperation: row.refusedOperation, rowState })
}

/** The first table row matching `pred`; throws when none does, so a case never runs on nothing. */
function rowWhere(pred: (row: ConflictCaseRow) => boolean): ConflictCaseRow {
  const found = CONFLICT_CASE_ROWS.find(pred)
  if (found === undefined) throw new Error('no case-table row matches')
  return found
}

/** The case-phrase entries of `CONFLICT_CASE_ORDER` a description carries, in that order. */
const casePhrasesIn = (description: string) => CONFLICT_CASE_ORDER.filter((entry) => description.includes(entry.phrase))

/** The two cases whose description points to no "Operator actions" (ADSRD SR-1.4; SRJ-1004). */
const NO_POINTER_CASES: ReadonlySet<string> = new Set([LATCH_CASE_DIFFERENT_ID, LATCH_CASE_ANOTHER_STORE])

/**
 * The "Operator actions" section title, read from the stub: the one quoted
 * text, other than the session, that every pointing description carries.
 */
function operatorActionsTitle(): string {
  const quotedTexts = (row: ConflictCaseRow): Set<string> =>
    new Set(Array.from(descriptionOf(row).matchAll(/"([^"]+)"/g), (m) => m[1]).filter((t) => t !== row.sessionName))
  const pointing = CONFLICT_CASE_ROWS.filter((row) => !NO_POINTER_CASES.has(row.latchCase)).map(quotedTexts)
  const common = [...pointing[0]].filter((text) => pointing.every((texts) => texts.has(text)))
  if (common.length !== 1) throw new Error(`expected one shared quoted title, found ${common.length}`)
  return common[0]
}

// ---------------------------------------------------------------------------
// Recognition (SRJ-507, SRJ-1303)
// ---------------------------------------------------------------------------

describe('case recognition', () => {
  test('the case table covers every stub CONFLICT case', () => {
    expect(new Set(CONFLICT_CASE_ROWS.map((row) => row.stubCase))).toEqual(new Set(CONFLICT_CASES))
  })

  test.each(ROWS)('%s resolves to its case', (_name, row) => {
    expect(recogniseConflictCase(descriptionOf(row))).toBe(row.latchCase)
  })

  test('each description carrying two or three case phrases takes the first in the order', () => {
    const multi = CONFLICT_CASE_ROWS.filter((row) => casePhrasesIn(descriptionOf(row)).length >= 2)
    expect(new Set(multi.map((row) => row.latchCase))).toEqual(
      new Set([LATCH_CASE_PANE_NOT_FOUND, LATCH_CASE_NOT_THIS_LAUNCH, LATCH_CASE_NEVER_REPORTED_IN]),
    )
    for (const row of multi) {
      const carried = casePhrasesIn(descriptionOf(row))
      expect(recogniseConflictCase(descriptionOf(row))).toBe(carried[0].latchCase)
      expect(carried.map((entry) => entry.latchCase)).toContain(LATCH_CASE_OWN_ID)
    }
  })

  test('the scan\'s and the duplicate-session leftover descriptions both resolve to the leftover case; only the latter carries the label wording', () => {
    const plainLeftover = (scanned: boolean) =>
      descriptionOf(rowWhere((row) =>
        row.refusedOperation === REFUSED_OPERATION_PLAIN_SPAWN &&
        row.latchCase === LATCH_CASE_LEFTOVER &&
        (row.rowState === LATCH_ROW_STATE_NO_ROW) === scanned))
    const duplicate = plainLeftover(false)
    const scan = plainLeftover(true)
    expect(duplicate.includes(PLAIN_SPAWN_LABEL_NAMES_THIS_ID_PHRASE)).toBe(true)
    expect(scan.includes(PLAIN_SPAWN_LABEL_NAMES_THIS_ID_PHRASE)).toBe(false)
    expect([recogniseConflictCase(duplicate), recogniseConflictCase(scan)]).toEqual([LATCH_CASE_LEFTOVER, LATCH_CASE_LEFTOVER])
  })

  test('the another-store descriptions from a resume, a reuse and a plain spawn resolve to the another-store case', () => {
    const rows = CONFLICT_CASE_ROWS.filter((row) => descriptionOf(row).includes(CONFLICT_ANOTHER_STORE_PHRASE))
    expect(new Set(rows.map((row) => row.refusedOperation))).toEqual(
      new Set([REFUSED_OPERATION_RESUME, REFUSED_OPERATION_REUSE_SPAWN, REFUSED_OPERATION_PLAIN_SPAWN]),
    )
    expect(rows.map((row) => recogniseConflictCase(descriptionOf(row)))).toEqual(rows.map(() => LATCH_CASE_ANOTHER_STORE))
  })

  test('the never-reported-in description, which also carries the own-id phrase, resolves to its own case and takes unrecognised handling', () => {
    const description = descriptionOf(rowWhere((row) => row.latchCase === LATCH_CASE_NEVER_REPORTED_IN))
    expect(description.includes(CONFLICT_OWN_ID_PHRASE)).toBe(true)
    expect(recogniseConflictCase(description)).toBe(LATCH_CASE_NEVER_REPORTED_IN)
    expect(takesUnrecognisedHandling(LATCH_CASE_NEVER_REPORTED_IN)).toBe(true)
  })

  const PAIRS = CONFLICT_CASE_ORDER.flatMap((first, i) =>
    CONFLICT_CASE_ORDER.slice(i + 1).map((later) => [first.latchCase, later.latchCase, first.phrase, later.phrase] as const),
  )

  test.each(PAIRS)('%s wins over %s in either textual order', (firstCase, _laterCase, firstPhrase, laterPhrase) => {
    expect(recogniseConflictCase(`${firstPhrase}; ${laterPhrase}`)).toBe(firstCase)
    expect(recogniseConflictCase(`${laterPhrase}; ${firstPhrase}`)).toBe(firstCase)
  })

  test('the exported order is SRJ-507\'s, each case on its own phrase, with "no pane 0.0" absent', () => {
    // The file's only literal block: SRJ-507's case words, in its order.
    expect(CONFLICT_CASE_ORDER.map((entry) => entry.phrase)).toEqual([
      'conflicting labels',
      "the agent's pane was not found",
      "not this launch's session",
      'left over from an earlier life',
      'never reported in',
      "this row's own id",
      'no valid instance id',
      'a different instance id',
      'another agent-director store',
    ])
    expect(recogniseConflictCase('no pane 0.0')).toBe(LATCH_CASE_UNRECOGNISED)
    expect(CONFLICT_CASE_ORDER.map((entry) => [entry.latchCase, entry.phrase])).toEqual([
      [LATCH_CASE_CONFLICTING_LABELS, CONFLICT_CONFLICTING_LABELS_PHRASE],
      [LATCH_CASE_PANE_NOT_FOUND, CONFLICT_PANE_NOT_FOUND_PHRASE],
      [LATCH_CASE_NOT_THIS_LAUNCH, CONFLICT_NOT_THIS_LAUNCH_PHRASE],
      [LATCH_CASE_LEFTOVER, CONFLICT_LEFTOVER_PHRASE],
      [LATCH_CASE_NEVER_REPORTED_IN, CONFLICT_NEVER_REPORTED_IN_PHRASE],
      [LATCH_CASE_OWN_ID, CONFLICT_OWN_ID_PHRASE],
      [LATCH_CASE_NO_VALID_ID, CONFLICT_NO_VALID_ID_PHRASE],
      [LATCH_CASE_DIFFERENT_ID, CONFLICT_DIFFERENT_ID_PHRASE],
      [LATCH_CASE_ANOTHER_STORE, CONFLICT_ANOTHER_STORE_PHRASE],
    ])
  })

  test.each([
    [PLAIN_SPAWN_LABEL_NAMES_THIS_ID_PHRASE],
    [PLAIN_SPAWN_LABEL_NOT_THIS_ID_PHRASE],
    [NEW_ROW_ENDED_PHRASE],
    [NOTHING_WRITTEN_PHRASE],
    [PANE_NOT_ADOPTED_PHRASE],
    [NO_KILL_SENT_PHRASE],
    [''],
    [undefined],
  ] as const)('%p alone is no case: unrecognised text', (text) => {
    expect(recogniseConflictCase(text)).toBe(LATCH_CASE_UNRECOGNISED)
  })

  test('no different-id or another-store description, in any variant, carries the Operator actions section title', () => {
    const title = operatorActionsTitle()
    const noPointer = CONFLICT_CASE_ROWS.filter((row) => NO_POINTER_CASES.has(row.latchCase))
    expect(new Set(noPointer.map((row) => row.refusedOperation))).toEqual(
      new Set([REFUSED_OPERATION_RESUME, REFUSED_OPERATION_REUSE_SPAWN, REFUSED_OPERATION_PLAIN_SPAWN]),
    )
    expect(noPointer.filter((row) => descriptionOf(row).includes(title)).map((row) => row.name)).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// The record (SRJ-501)
// ---------------------------------------------------------------------------

describe('the latch record', () => {
  test.each(ROWS)('%s: latching records the quoted session, the case, the refused operation and the row state', (_name, row) => {
    const run = makeLatchRun()
    expect(latchOnRow(run.latch, KEY, row)).toBe(CONFLICT_LATCH_SET_LATCHED)
    expect(run.latch.isLatched(KEY)).toBe(true)
    expect(run.latch.record(KEY)).toMatchObject({
      sessionName: row.sessionName,
      latchCase: row.latchCase,
      refusedOperation: row.refusedOperation,
      rowState: row.rowState,
    })
    expect(run.events.map((event): unknown[] => [event.key, event.outcome, event.record])).toEqual([
      [KEY, CONFLICT_LATCH_SET_LATCHED, run.latch.record(KEY)],
    ])
  })

  test('the quoted session is the first double-quoted name; with none it is the persona\'s own slack_bot_<key>', () => {
    const quoted = personaTmuxSessionName(OTHER)
    const second = STUB_TMUX_SESSION_NAME
    expect(conflictSessionName(`${JSON.stringify(quoted)} then ${JSON.stringify(second)}`, KEY)).toBe(quoted)
    expect(conflictSessionName(CONFLICT_OWN_ID_PHRASE, KEY)).toBe(personaTmuxSessionName(KEY))
    expect(conflictSessionName(undefined, KEY)).toBe(personaTmuxSessionName(KEY))

    const run = makeLatchRun()
    const noName = errGeneric('resume', ERR_TMUX_SESSION_CONFLICT_NAME, CONFLICT_OWN_ID_PHRASE)
    run.latch.setFromConflict(KEY, noName, { refusedOperation: REFUSED_OPERATION_RESUME, rowState: LATCH_ROW_STATE_NO_ROW })
    expect(run.latch.record(KEY)?.sessionName).toBe(personaTmuxSessionName(KEY))
    run.latch.set(OTHER, { latchCase: LATCH_CASE_OWN_ID, refusedOperation: REFUSED_OPERATION_RESUME, rowState: LATCH_ROW_STATE_NO_ROW })
    expect(run.latch.record(OTHER)?.sessionName).toBe(personaTmuxSessionName(OTHER))
  })

  test('an empty quoted span is skipped whole: its closing quote never opens the next span', () => {
    const name = STUB_TMUX_SESSION_NAME
    expect(conflictSessionName(`a "" then ${JSON.stringify(name)}`, KEY)).toBe(name)
    expect(conflictSessionName(`"" "" then ${JSON.stringify(name)}`, KEY)).toBe(name)
    expect(conflictSessionName(`a "" then ""`, KEY)).toBe(personaTmuxSessionName(KEY))

    const run = makeLatchRun()
    const description = `${CONFLICT_OWN_ID_PHRASE} "" then ${JSON.stringify(name)}`
    run.latch.setFromConflict(KEY, errGeneric('resume', ERR_TMUX_SESSION_CONFLICT_NAME, description), {
      refusedOperation: REFUSED_OPERATION_RESUME,
      rowState: LATCH_ROW_STATE_NO_ROW,
    })
    expect(run.latch.record(KEY)?.sessionName).toBe(name)
  })

  test.each([
    ['a newline', '\n'],
    ['a carriage return', '\r'],
    ['a CRLF', '\r\n'],
    ['a line separator', '\u2028'],
    ['a paragraph separator', '\u2029'],
  ])('a quoted span broken by %s is skipped whole: its closing quote never opens the next span', (_name, lineBreak) => {
    const name = STUB_TMUX_SESSION_NAME
    const broken = `"${personaTmuxSessionName(OTHER)}${lineBreak}${name}"`
    expect(conflictSessionName(`a ${broken} then ${JSON.stringify(name)}`, KEY)).toBe(name)
    expect(conflictSessionName(`a ${broken} then "" then ${JSON.stringify(name)}`, KEY)).toBe(name)
    expect(conflictSessionName(`a ${broken} then ${broken}`, KEY)).toBe(personaTmuxSessionName(KEY))
    expect(conflictSessionName(`a ${broken} then ""`, KEY)).toBe(personaTmuxSessionName(KEY))
  })

  test.each([
    ['waiting', latchRowStateRead('waiting'), true],
    ['unreadable', LATCH_ROW_STATE_UNREADABLE, true],
    ['an unsafe state (recorded unreadable)', latchRowStateRead(`waiting ${CONFLICT_OWN_ID_PHRASE}`), true],
    ['pending', latchRowStateRead(AGENT_DIRECTOR_PENDING_STATE), false],
    ['ended', ENDED, false],
    ['no row', LATCH_ROW_STATE_NO_ROW, false],
  ] as const)('a latch met with the row %s records a state that counts as live: %p', (_label, rowState, live) => {
    const run = makeLatchRun()
    latchOnRow(run.latch, KEY, rowWhere((row) => row.verb === 'kill' && row.latchCase === LATCH_CASE_NOT_THIS_LAUNCH), rowState)
    const recorded = run.latch.record(KEY)?.rowState
    expect(recorded).toBeDefined()
    expect(rowStateCountsAsLive(recorded as LatchRowState)).toBe(live)
  })

  test('every live state but pending, and any state CSCB does not know, counts as live; pending and the dead states do not', () => {
    const live = [...AGENT_DIRECTOR_LIVE_STATES].filter((state) => state !== AGENT_DIRECTOR_PENDING_STATE)
    const notLive = [AGENT_DIRECTOR_PENDING_STATE, ...AGENT_DIRECTOR_DEAD_STATES]
    expect(live.map((state) => rowStateCountsAsLive(latchRowStateRead(state)))).toEqual(live.map(() => true))
    expect(notLive.map((state) => rowStateCountsAsLive(latchRowStateRead(state)))).toEqual(notLive.map(() => false))
    expect(rowStateCountsAsLive(latchRowStateRead('stopping'))).toBe(true)
    expect(latchRowStateRead(42)).toBe(LATCH_ROW_STATE_UNREADABLE)
  })

  test('the description is kept redacted, on one line and capped; a token-shaped quoted name is redacted', () => {
    const run = makeLatchRun()
    const long = `${CONFLICT_OWN_ID_PHRASE} (${sentinelInMessage('d')})\n${NO_KILL_SENT_PHRASE} ${'x'.repeat(MAX_LOGGED_MESSAGE_LENGTH)}`
    run.latch.setFromConflict(KEY, errGeneric('resume', ERR_TMUX_SESSION_CONFLICT_NAME, long), {
      refusedOperation: REFUSED_OPERATION_RESUME,
      rowState: LATCH_ROW_STATE_NO_ROW,
    })
    const description = run.latch.record(KEY)?.description ?? ''
    expect(description.startsWith(`${CONFLICT_OWN_ID_PHRASE} (${REDACTED_SENTINEL_TAIL}) ${NO_KILL_SENT_PHRASE}`)).toBe(true)
    expect(description.length).toBeLessThanOrEqual(MAX_LOGGED_MESSAGE_LENGTH)

    const ownId = rowWhere((row) => row.latchCase === LATCH_CASE_OWN_ID)
    const tokenSession = errTmuxSessionConflict(ownId.verb, ownId.stubCase, fakeToken(BOT_TOKEN_PREFIX, 's'), ownId.options)
    run.latch.setFromConflict(OTHER, tokenSession, { refusedOperation: REFUSED_OPERATION_RESUME, rowState: LATCH_ROW_STATE_NO_ROW })
    expect(run.latch.record(OTHER)?.sessionName).toBe(REDACTED_TOKEN_PLACEHOLDER)
  })

  test('a set with no description records none, and its line has no message', () => {
    const run = makeLatchRun()
    run.latch.set(KEY, { latchCase: LATCH_CASE_OWN_ID, refusedOperation: REFUSED_OPERATION_RESUME, rowState: ENDED })
    expect(run.latch.record(KEY)).toEqual({
      sessionName: personaTmuxSessionName(KEY),
      latchCase: LATCH_CASE_OWN_ID,
      refusedOperation: REFUSED_OPERATION_RESUME,
      rowState: ENDED,
    })
    expect(run.lines).toEqual([
      `[slack] conflict-latch: persona=${KEY} latched — case=${LATCH_CASE_OWN_ID} session=${JSON.stringify(personaTmuxSessionName(KEY))} refused=${REFUSED_OPERATION_RESUME} state=ended`,
    ])
  })

  test('the hold cases are recorded with the refused operation none', () => {
    const run = makeLatchRun()
    for (const [key, latchCase] of [[KEY, LATCH_CASE_UNUSABLE_RECORDED_NAME], [OTHER, LATCH_CASE_LAUNCH_START_NOT_RECORDED]] as const) {
      const rowState = latchRowStateRead(AGENT_DIRECTOR_PENDING_STATE)
      expect(run.latch.set(key, { latchCase, refusedOperation: REFUSED_OPERATION_NONE, rowState })).toBe(CONFLICT_LATCH_SET_LATCHED)
      expect(run.latch.record(key)).toMatchObject({ latchCase, refusedOperation: REFUSED_OPERATION_NONE, rowState })
    }
  })

  test.each(LATCH_CASES.map((latchCase) => [latchCase]))('case %s: hold and unrecognised-handling marks', (latchCase) => {
    expect(isHoldLatchCase(latchCase)).toBe((HOLD_LATCH_CASES as readonly string[]).includes(latchCase))
    expect(takesUnrecognisedHandling(latchCase)).toBe(
      latchCase === LATCH_CASE_UNRECOGNISED || latchCase === LATCH_CASE_NEVER_REPORTED_IN,
    )
  })

  test.each([
    ['ErrSpawnNotFound', (): unknown => errSpawnNotFound()],
    ['ErrTmuxUnresponsive', (): unknown => errTmuxUnresponsive()],
    ['an ErrUnknownErrorName naming the conflict', (): unknown => errUnknownErrorName(ERR_TMUX_SESSION_CONFLICT_NAME, CONFLICT_OWN_ID_PHRASE)],
    ['a plain Error', (): unknown => new Error(CONFLICT_OWN_ID_PHRASE)],
    ['undefined', (): unknown => undefined],
  ] as const)('setFromConflict on %s latches nothing, changes nothing and is silent', (_label, build) => {
    const run = makeLatchRun()
    const row = rowWhere((r) => r.latchCase === LATCH_CASE_LEFTOVER)
    latchOnRow(run.latch, OTHER, row)
    const before = run.latch.record(OTHER)
    const fields: ConflictLatchConflictFields = { refusedOperation: REFUSED_OPERATION_RESUME, rowState: LATCH_ROW_STATE_NO_ROW }
    expect(run.latch.setFromConflict(KEY, build(), fields)).toBeUndefined()
    expect(run.latch.setFromConflict(OTHER, build(), fields)).toBeUndefined()
    expect(run.latch.isLatched(KEY)).toBe(false)
    expect(run.latch.record(OTHER)).toBe(before)
    expect(run.lines.length).toBe(1)
    expect(run.events.length).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// Relatch and same case (SRJ-501, SRJ-506)
// ---------------------------------------------------------------------------

describe('relatch', () => {
  const first: ConflictLatchSetInput = {
    latchCase: LATCH_CASE_OWN_ID,
    refusedOperation: REFUSED_OPERATION_RESUME,
    rowState: ENDED,
    description: CONFLICT_OWN_ID_PHRASE,
  }

  test('a different case relatches: the case, the refused operation, the recorded state and the session are replaced', () => {
    const run = makeLatchRun()
    run.latch.set(KEY, first)
    const previous = run.latch.record(KEY)
    const second: ConflictLatchSetInput = {
      latchCase: LATCH_CASE_LEFTOVER,
      refusedOperation: REFUSED_OPERATION_PLAIN_SPAWN,
      rowState: LATCH_ROW_STATE_NO_ROW,
      sessionName: STUB_TMUX_SESSION_NAME,
      description: CONFLICT_LEFTOVER_PHRASE,
    }
    expect(run.latch.set(KEY, second)).toBe(CONFLICT_LATCH_SET_RELATCHED)
    expect<unknown>(run.latch.record(KEY)).toEqual(second)
    expect(run.events.map((event): unknown[] => [event.outcome, event.record, event.previous])).toEqual([
      [CONFLICT_LATCH_SET_LATCHED, previous, undefined],
      [CONFLICT_LATCH_SET_RELATCHED, second, previous],
    ])
    expect(run.lines).toEqual([
      `[slack] conflict-latch: persona=${KEY} latched — case=${LATCH_CASE_OWN_ID} session=${JSON.stringify(personaTmuxSessionName(KEY))} refused=${REFUSED_OPERATION_RESUME} state=ended message=${JSON.stringify(CONFLICT_OWN_ID_PHRASE)}`,
      `[slack] conflict-latch: persona=${KEY} relatched — case=${LATCH_CASE_LEFTOVER} (was ${LATCH_CASE_OWN_ID}) session=${JSON.stringify(STUB_TMUX_SESSION_NAME)} refused=${REFUSED_OPERATION_PLAIN_SPAWN} state=${LATCH_ROW_STATE_KIND_NO_ROW} message=${JSON.stringify(CONFLICT_LEFTOVER_PHRASE)}`,
    ])
  })

  test('a relatch through setFromConflict takes the new error\'s case and the retry\'s fields', () => {
    const run = makeLatchRun()
    const scan = rowWhere(
      (row) => row.refusedOperation === REFUSED_OPERATION_PLAIN_SPAWN && row.latchCase === LATCH_CASE_LEFTOVER && row.rowState === LATCH_ROW_STATE_NO_ROW,
    )
    const killed = rowWhere((row) => row.verb === 'kill' && row.latchCase === LATCH_CASE_NOT_THIS_LAUNCH)
    latchOnRow(run.latch, KEY, killed)
    expect(latchOnRow(run.latch, KEY, scan)).toBe(CONFLICT_LATCH_SET_RELATCHED)
    expect(run.latch.record(KEY)).toMatchObject({
      latchCase: LATCH_CASE_LEFTOVER,
      refusedOperation: REFUSED_OPERATION_PLAIN_SPAWN,
      rowState: LATCH_ROW_STATE_NO_ROW,
    })
  })

  test('the same case keeps the persona latched with the record unchanged, logs nothing and reports same case', () => {
    const run = makeLatchRun()
    run.latch.set(KEY, first)
    const kept = run.latch.record(KEY)
    const again: ConflictLatchSetInput = {
      latchCase: LATCH_CASE_OWN_ID,
      refusedOperation: REFUSED_OPERATION_REUSE_SPAWN,
      rowState: LATCH_ROW_STATE_UNREADABLE,
      sessionName: STUB_TMUX_SESSION_NAME,
      description: CONFLICT_NO_VALID_ID_PHRASE,
    }
    expect(run.latch.set(KEY, again)).toBe(CONFLICT_LATCH_SET_SAME_CASE)
    expect(run.latch.record(KEY)).toBe(kept)
    expect(run.lines.length).toBe(1)
    expect(run.events.map((event): unknown[] => [event.outcome, event.record, event.previous])).toEqual([
      [CONFLICT_LATCH_SET_LATCHED, kept, undefined],
      [CONFLICT_LATCH_SET_SAME_CASE, kept, kept],
    ])
  })

  test('a relatch back to an earlier case is a relatch: the case is compared with the one now held', () => {
    const run = makeLatchRun()
    run.latch.set(KEY, first)
    run.latch.set(KEY, { ...first, latchCase: LATCH_CASE_LEFTOVER })
    expect(run.latch.set(KEY, first)).toBe(CONFLICT_LATCH_SET_RELATCHED)
    expect(run.latch.record(KEY)?.latchCase).toBe(LATCH_CASE_OWN_ID)
  })
})

// ---------------------------------------------------------------------------
// Scope, forget and observers
// ---------------------------------------------------------------------------

describe('scope', () => {
  const ownId = rowWhere((row) => row.latchCase === LATCH_CASE_OWN_ID)
  const leftover = rowWhere((row) => row.latchCase === LATCH_CASE_LEFTOVER)

  test('one latch per persona: another persona is unaffected by a latch, a relatch and a forget', () => {
    const run = makeLatchRun()
    latchOnRow(run.latch, KEY, ownId)
    expect([run.latch.isLatched(OTHER), run.latch.record(OTHER)]).toEqual([false, undefined])

    expect(latchOnRow(run.latch, OTHER, ownId)).toBe(CONFLICT_LATCH_SET_LATCHED)
    const other = run.latch.record(OTHER)
    expect(latchOnRow(run.latch, KEY, leftover)).toBe(CONFLICT_LATCH_SET_RELATCHED)
    expect(run.latch.record(OTHER)).toBe(other)
    expect(run.latch.forget(KEY)).toBe(true)
    expect(run.latch.record(OTHER)).toBe(other)
  })

  test('a new instance holds no latch', () => {
    const one = makeLatchRun()
    latchOnRow(one.latch, KEY, ownId)
    const two = makeLatchRun()
    expect([two.latch.isLatched(KEY), two.latch.record(KEY)]).toEqual([false, undefined])
  })

  test('forget is silent and per key; a later set latches afresh', () => {
    const run = makeLatchRun()
    latchOnRow(run.latch, KEY, ownId)
    const lines = run.lines.length
    const events = run.events.length
    expect(run.latch.forget(KEY)).toBe(true)
    expect(run.latch.forget(KEY)).toBe(false)
    expect([run.latch.isLatched(KEY), run.latch.record(KEY)]).toEqual([false, undefined])
    expect([run.lines.length, run.events.length]).toEqual([lines, events])
    expect(latchOnRow(run.latch, KEY, ownId)).toBe(CONFLICT_LATCH_SET_LATCHED)
  })
})

describe('set observers', () => {
  const ownId = rowWhere((row) => row.latchCase === LATCH_CASE_OWN_ID)

  test('a removed observer is not called again', () => {
    const run = makeLatchRun()
    const seen: string[] = []
    const remove = run.latch.addSetObserver((event) => {
      seen.push(event.outcome)
    })
    latchOnRow(run.latch, KEY, ownId)
    remove()
    latchOnRow(run.latch, KEY, ownId)
    expect(seen).toEqual([CONFLICT_LATCH_SET_LATCHED])
    expect(run.events.map((event) => event.outcome)).toEqual([CONFLICT_LATCH_SET_LATCHED, CONFLICT_LATCH_SET_SAME_CASE])
  })

  test('a throwing and a rejecting observer are logged redacted and swallowed; the set still holds and others are called', async () => {
    const run = makeLatchRun()
    run.latch.addSetObserver(() => {
      throw new Error(`observer (${sentinelInMessage('t')})`)
    })
    run.latch.addSetObserver(() => Promise.reject(new Error(`observer (${sentinelInMessage('r')})`)))
    const seen: string[] = []
    run.latch.addSetObserver((event) => {
      seen.push(event.key)
    })
    expect(latchOnRow(run.latch, KEY, ownId)).toBe(CONFLICT_LATCH_SET_LATCHED)
    await Promise.resolve()
    await Promise.resolve()
    expect(run.latch.isLatched(KEY)).toBe(true)
    expect(seen).toEqual([KEY])
    const failed = run.lines.filter((line) => line.startsWith(`[slack] conflict-latch: persona=${KEY} set observer failed: `))
    expect(failed.length).toBe(2)
    for (const line of failed) expect(line.includes(`(${REDACTED_SENTINEL_TAIL})`)).toBe(true)
  })

  test('a throwing log breaks no set', () => {
    const latch = createConflictLatch({
      log: () => {
        throw new Error('log down')
      },
    })
    expect(latchOnRow(latch, KEY, ownId)).toBe(CONFLICT_LATCH_SET_LATCHED)
    expect(latch.isLatched(KEY)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// The CONFLICT notice and its episode: fixtures (SRJ-1004, SRJ-508, SRJ-1016)
// ---------------------------------------------------------------------------

interface NoticeRun extends LatchRun {
  readonly clock: FakeClock
  readonly episodes: PersonaEpisodes
  /** Every notice the episodes' sink received: the key and the body. */
  readonly posts: Array<readonly [string, string]>
  /** Removes the notice reaction from the latch. */
  readonly unbind: () => void
}

/** Every notice run of this test, checked in `afterEach`. */
let noticeRuns: NoticeRun[] = []

/**
 * One latch with the latch notices bound to a real episodes instance over a
 * fake clock and a recording sink, which also hands each post to `forward`
 * when given (a case's persona notifier).
 */
function makeNoticeRun(forward?: (key: string, text: string) => void): NoticeRun {
  const run = makeLatchRun()
  const clock = createFakeClock()
  const posts: Array<readonly [string, string]> = []
  const episodes = createPersonaEpisodes({
    sink: (key, text) => {
      posts.push([key, text])
      forward?.(key, text)
    },
    log: (line) => run.lines.push(line),
    clock,
  })
  const unbind = bindConflictNotice(run.latch, episodes)
  const noticeRun = { ...run, clock, episodes, posts, unbind }
  noticeRuns.push(noticeRun)
  return noticeRun
}

afterEach(() => {
  const pending = noticeRuns.map((run) => run.clock.pendingCount())
  const posts = noticeRuns.map((run) => run.posts)
  noticeRuns = []
  setSessionNotifier(undefined)
  _resetNotConnectedEpisodes()
  expect(pending).toEqual(pending.map(() => 0))
  assertNoLeak(posts, 'posts')
})

/** A CONFLICT error carrying `description`, as agent-director throws it. */
const conflictError = (description: string) => errGeneric('resume', ERR_TMUX_SESSION_CONFLICT_NAME, description)

/** Latch `key` on a CONFLICT error carrying `description`. */
function latchOnDescription(latch: ConflictLatch, key: string, description: string) {
  return latch.setFromConflict(key, conflictError(description), { refusedOperation: REFUSED_OPERATION_RESUME, rowState: ENDED })
}

/** Every CONFLICT latch case: the nine recognised cases, then unrecognised text. */
const CONFLICT_LATCH_CASES: readonly ConflictLatchCase[] = [...CONFLICT_CASE_ORDER.map((entry) => entry.latchCase), LATCH_CASE_UNRECOGNISED]

/**
 * The recovery reasons, by name, for `test.each`: "row reads" over every dead
 * state and every live state (`waiting` among them), then the fixed reasons.
 */
const RECOVERY_REASONS: ReadonlyArray<readonly [string, LatchRecoveryReason]> = [
  ...[...AGENT_DIRECTOR_DEAD_STATES, ...AGENT_DIRECTOR_LIVE_STATES].map(
    (state) => [`row reads ${state}`, latchRecoveryReasonRowReads(state)] as const,
  ),
  ['row gone', LATCH_RECOVERY_REASON_ROW_GONE],
  ['retry not refused', LATCH_RECOVERY_REASON_RETRY_NOT_REFUSED],
  ['relaunch not refused', LATCH_RECOVERY_REASON_RELAUNCH_NOT_REFUSED],
  ['cleared by hand', LATCH_RECOVERY_REASON_CLEARED_BY_HAND],
]

// ---------------------------------------------------------------------------
// Pin: SRJ-1004's and SRJ-1005's texts
// ---------------------------------------------------------------------------

describe('notice texts: pin', () => {
  test('every case\'s CONFLICT notice, every fixed line and both recovery templates with each reason are SRJ-1004\'s and SRJ-1005\'s words', () => {
    // The file's only literal block for these texts: SRJ-1004 and SRJ-1005 as written.
    const FIRST_WITH_CASE =
      ":no_entry: *Held: tmux session conflict* — agent-director will not act on this persona's tmux session <session>: <case sentence>. CSCB takes no action for this persona until the conflict clears, and messages sent to it meanwhile are lost."
    const FIRST_WITHOUT_CASE =
      ":no_entry: *Held: tmux session conflict* — agent-director will not act on this persona's tmux session <session>. CSCB takes no action for this persona until the conflict clears, and messages sent to it meanwhile are lost."
    const DESCRIPTION = 'agent-director said: "<its description, redacted>"'
    const POINTER = 'What to do: a human follows the "Operator actions" section of agent-director\'s README for this session.'
    const ANOTHER_ROW = 'This session belongs to another agent-director row and must not be ended.'
    const ANOTHER_STORE = 'This session belongs to another agent-director store and must not be ended.'
    const LIST =
      'To see which agent-director rows record the session name, run `agent-director list --tmux-session-name <name>` on the command line (over MCP, list ignores that filter).'
    const HUMAN_ONLY = 'This is for a human only: no bot, including any persona that sees this post, may act on it.'
    const CASE_SENTENCES: Record<string, string> = {
      [LATCH_CASE_OWN_ID]:
        "this persona's own session still runs on its finished agent-director row past agent-director's stopping window and starting-session bound, or its worker process still runs after that session has gone; the worker may be hung or running on a row wrongly marked finished, and the conversation stays resumable",
      [LATCH_CASE_LEFTOVER]:
        "a session left over from an earlier launch of this persona holds the name or, renamed, still carries this persona's agent-director label, and ending it is a human's decision",
      [LATCH_CASE_NOT_THIS_LAUNCH]:
        "a session left over from an earlier launch of this persona is there; CSCB will not act on it, and ending it is a human's decision",
      [LATCH_CASE_NO_VALID_ID]: 'a session with no valid agent-director label holds the name; CSCB never touches it',
      [LATCH_CASE_DIFFERENT_ID]: "another agent-director row's session holds the name; CSCB never touches it",
      [LATCH_CASE_PANE_NOT_FOUND]:
        "the worker's recorded pane is not there (it is gone, it was respawned with another program, or it could not be adopted), or the one session left over from an earlier launch of this persona has no pane agent-director can find, and a human should look",
      [LATCH_CASE_CONFLICTING_LABELS]:
        "two sessions carry this launch's agent-director label, or an agent-director label value is set at the server, global or global-window scope; nothing automatic is safe, and a human must look",
      [LATCH_CASE_ANOTHER_STORE]:
        'a worker of another agent-director store sharing this tmux server holds the name; CSCB never touches it',
    }
    const CONFLICT_RECOVERY =
      ":white_check_mark: *Conflict cleared* — the hold on this persona's tmux session <session> is cleared (<reason>). CSCB is recovering this persona again."
    const HOLD_RECOVERY =
      ":white_check_mark: *Hold cleared* — the hold on this persona's agent-director row is cleared (<reason>). CSCB is recovering this persona again."
    const REASONS: ReadonlyArray<readonly [LatchRecoveryReason, string]> = [
      [latchRecoveryReasonRowReads('ended'), 'its agent-director row reads ended'],
      [LATCH_RECOVERY_REASON_ROW_GONE, 'its agent-director row is gone'],
      [LATCH_RECOVERY_REASON_RETRY_NOT_REFUSED, 'a retry of the refused operation was not refused'],
      [LATCH_RECOVERY_REASON_RELAUNCH_NOT_REFUSED, 'its row finished and a relaunch was not refused'],
      [LATCH_RECOVERY_REASON_CLEARED_BY_HAND, 'cleared by hand'],
    ]

    const name = personaTmuxSessionName(KEY)
    const session = JSON.stringify(name)
    const description = NO_KILL_SENT_PHRASE
    const fill = (template: string, values: Record<string, string>) =>
      Object.entries(values).reduce((text, [slot, value]) => text.replace(slot, () => value), template)

    expect<unknown>(CONFLICT_CASE_SENTENCES).toEqual(CASE_SENTENCES)
    expect([
      CONFLICT_NOTICE_POINTER_LINE,
      CONFLICT_NOTICE_DIFFERENT_ID_MUST_NOT_END_LINE,
      CONFLICT_NOTICE_ANOTHER_STORE_MUST_NOT_END_LINE,
      CONFLICT_NOTICE_HUMAN_ONLY_LINE,
      CONFLICT_NOTICE_LINE_SEPARATOR,
    ]).toEqual([POINTER, ANOTHER_ROW, ANOTHER_STORE, HUMAN_ONLY, '\n'])

    for (const latchCase of CONFLICT_LATCH_CASES) {
      const sentence = CASE_SENTENCES[latchCase]
      const first =
        sentence === undefined
          ? fill(FIRST_WITHOUT_CASE, { '<session>': session })
          : fill(FIRST_WITH_CASE, { '<session>': session, '<case sentence>': sentence })
      const middle =
        latchCase === LATCH_CASE_DIFFERENT_ID ? [ANOTHER_ROW] : latchCase === LATCH_CASE_ANOTHER_STORE ? [ANOTHER_STORE, POINTER] : [POINTER]
      const lines = [
        first,
        fill(DESCRIPTION, { '<its description, redacted>': description }),
        ...middle,
        fill(LIST, { '<name>': name }),
        HUMAN_ONLY,
      ]
      expect([latchCase, conflictNoticeText({ sessionName: name, latchCase, description }).split('\n')]).toEqual([latchCase, lines])
      expect([latchCase, expectedConflictNotice({ sessionName: name, latchCase, description }).lines]).toEqual([latchCase, lines])
    }
    expect(CASE_SENTENCES[LATCH_CASE_NEVER_REPORTED_IN]).toBeUndefined()
    expect(CASE_SENTENCES[LATCH_CASE_UNRECOGNISED]).toBeUndefined()

    for (const [reason, reasonText] of REASONS) {
      expect(latchRecoveryReasonText(reason)).toBe(reasonText)
      const conflict = fill(CONFLICT_RECOVERY, { '<session>': session, '<reason>': reasonText })
      const hold = fill(HOLD_RECOVERY, { '<reason>': reasonText })
      expect([conflictRecoveryText(name, reason), latchRecoveryText(LATCH_KIND_CONFLICT, reason, name)]).toEqual([conflict, conflict])
      expect([holdRecoveryText(reason), latchRecoveryText(LATCH_KIND_HOLD, reason, name)]).toEqual([hold, hold])
    }
  })
})

// ---------------------------------------------------------------------------
// The CONFLICT notice by row (SRJ-1004, SRJ-508; AC 40, AC 77)
// ---------------------------------------------------------------------------

describe('the CONFLICT notice by row', () => {
  test('every CONFLICT latch case has a row, unrecognised text and "never reported in" included, and only those two carry no case sentence', () => {
    expect(new Set(CONFLICT_CASE_ROWS.map((row) => row.latchCase))).toEqual(new Set(CONFLICT_LATCH_CASES))
    const noSentence = CONFLICT_CASE_ROWS.filter((row) => row.notice.caseSentence === undefined)
    expect(new Set(noSentence.map((row) => row.latchCase))).toEqual(new Set([LATCH_CASE_UNRECOGNISED, LATCH_CASE_NEVER_REPORTED_IN]))
    expect(CONFLICT_LATCH_CASES.filter((latchCase) => conflictCaseSentence(latchCase) === undefined)).toEqual([
      LATCH_CASE_NEVER_REPORTED_IN,
      LATCH_CASE_UNRECOGNISED,
    ])
    for (const latchCase of HOLD_LATCH_CASES) expect(conflictCaseSentence(latchCase)).toBeUndefined()
  })

  test.each(ROWS)('%s: the latch posts the row\'s notice once to the persona, its lines in SRJ-1004\'s order', (_name, row) => {
    const run = makeNoticeRun()
    expect(latchOnRow(run.latch, KEY, row)).toBe(CONFLICT_LATCH_SET_LATCHED)
    expect(run.posts).toEqual([[KEY, row.notice.text]])

    const lines = run.posts[0][1].split(CONFLICT_NOTICE_LINE_SEPARATOR)
    const at = (line: string) => lines.indexOf(line)
    const listLine = CONFLICT_NOTICE_LIST_LINE_HEAD + row.sessionName + CONFLICT_NOTICE_LIST_LINE_TAIL
    expect(lines[0].startsWith(CONFLICT_NOTICE_FIRST_LINE_HEAD + JSON.stringify(row.sessionName))).toBe(true)
    expect(lines[1]).toBe(row.notice.descriptionLine as string)
    expect(lines.slice(-2)).toEqual([listLine, CONFLICT_NOTICE_HUMAN_ONLY_LINE])
    expect(at(CONFLICT_NOTICE_POINTER_LINE) >= 0).toBe(row.notice.carries.pointer)
    expect(at(CONFLICT_NOTICE_DIFFERENT_ID_MUST_NOT_END_LINE) >= 0).toBe(row.notice.carries.mustNotEnd === 'row')
    expect(at(CONFLICT_NOTICE_ANOTHER_STORE_MUST_NOT_END_LINE) >= 0).toBe(row.notice.carries.mustNotEnd === 'store')
    if (row.latchCase === LATCH_CASE_DIFFERENT_ID) {
      expect(at(CONFLICT_NOTICE_DIFFERENT_ID_MUST_NOT_END_LINE)).toBe(2)
      expect(run.posts[0][1].includes(operatorActionsTitle())).toBe(false)
    } else if (row.latchCase === LATCH_CASE_ANOTHER_STORE) {
      expect([at(CONFLICT_NOTICE_ANOTHER_STORE_MUST_NOT_END_LINE), at(CONFLICT_NOTICE_POINTER_LINE), at(listLine)]).toEqual([2, 3, 4])
    } else {
      expect(at(CONFLICT_NOTICE_POINTER_LINE)).toBe(2)
    }
  })

  test('the scan\'s and the duplicate-session leftover descriptions both get the "left over from an earlier life" wording', () => {
    const leftovers = CONFLICT_CASE_ROWS.filter((row) => row.refusedOperation === REFUSED_OPERATION_PLAIN_SPAWN && row.latchCase === LATCH_CASE_LEFTOVER)
    expect(leftovers.map((row) => descriptionOf(row).includes(PLAIN_SPAWN_LABEL_NAMES_THIS_ID_PHRASE)).sort()).toEqual([false, true])
    for (const row of leftovers) {
      const run = makeNoticeRun()
      latchOnRow(run.latch, KEY, row)
      expect(run.posts[0][1].split(CONFLICT_NOTICE_LINE_SEPARATOR)[0].includes(CONFLICT_CASE_SENTENCES[LATCH_CASE_LEFTOVER])).toBe(true)
    }
  })

  test('a record with no description gives no description line (the note latch\'s form)', () => {
    const run = makeNoticeRun()
    run.latch.set(KEY, { latchCase: LATCH_CASE_CONFLICTING_LABELS, refusedOperation: REFUSED_OPERATION_RESUME, rowState: ENDED })
    const expected = expectedConflictNotice({ latchCase: LATCH_CASE_CONFLICTING_LABELS, sessionName: personaTmuxSessionName(KEY) })
    expect(expected.descriptionLine).toBeUndefined()
    expect(run.posts).toEqual([[KEY, expected.text]])
    expect(run.posts[0][1].includes(CONFLICT_NOTICE_DESCRIPTION_LINE_HEAD)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// No session-ending command in CSCB's own lines (SRJ-1001, SRJ-1004; AC 40)
// ---------------------------------------------------------------------------

/**
 * What CSCB's own notice and recovery lines never spell, beyond SR-1.4's five
 * session-ending forms (SRJ-1001; SRJ-716's label option names): a pane kill,
 * a tmux option write, an agent-director row delete, the latch-clearing
 * command, a session probe, and either label option's name.
 */
const CSCB_OWN_LINE_FORBIDDEN: readonly RegExp[] = [
  /kill-pane/i,
  /set-option/i,
  /agent-director\s+delete/i,
  /clear-latch|clear_latch|clearLatch/,
  /has-session/i,
  /ad_owner|ad_pane/,
]

/** Each `CSCB_OWN_LINE_FORBIDDEN` entry a line matches, with the line, so a failure names both. */
const forbiddenIn = (line: string): string[] =>
  CSCB_OWN_LINE_FORBIDDEN.filter((pattern) => pattern.test(line)).map((pattern) => `${pattern} in ${JSON.stringify(line)}`)

describe('no session-ending command', () => {
  test.each(ROWS)('%s: CSCB\'s own lines name no session-ending command, no --include-finished, and no kill-pane, set-option, agent-director delete, clear-latch, has-session or label option', (_name, row) => {
    const own = cscbOwnLines(conflictNoticeText({ sessionName: row.sessionName, latchCase: row.latchCase, description: descriptionOf(row) }))
    expect(own.length).toBe(row.notice.lines.length - 1)
    expect(own.flatMap(sessionEndingCommandsIn)).toEqual([])
    expect(own.flatMap(forbiddenIn)).toEqual([])
  })

  /** One sample per spelling the forbidden list names; each matches exactly one entry. */
  const FORBIDDEN_SAMPLES = [
    'tmux kill-pane -t =slack_bot_alpha',
    'tmux set-option -t =slack_bot_alpha',
    'run agent-director  delete --claude-instance-id cscb_alpha',
    'cscb clear-latch alpha',
    'the clear_latch tool',
    'call clearLatch()',
    'tmux has-session -t =slack_bot_alpha',
    'the @ad_owner option',
    'the @ad_pane option',
  ]

  test.each(FORBIDDEN_SAMPLES.map((sample) => [sample]))('%p in a line of CSCB\'s own is caught; in the quoted description it is let through', (sample) => {
    const notice = conflictNoticeText({ sessionName: STUB_TMUX_SESSION_NAME, latchCase: LATCH_CASE_OWN_ID, description: sample })
    expect(cscbOwnLines(notice).flatMap(forbiddenIn)).toEqual([])
    expect(cscbOwnLines(`${notice}${CONFLICT_NOTICE_LINE_SEPARATOR}${sample}`).flatMap(forbiddenIn).length).toBe(1)
  })

  test('the never-reported-in and not-this-launch kill rows quote "no kill was sent", and the check lets it through', () => {
    const killRows = CONFLICT_CASE_ROWS.filter(
      (row) => row.verb === 'kill' && (row.latchCase === LATCH_CASE_NEVER_REPORTED_IN || row.latchCase === LATCH_CASE_NOT_THIS_LAUNCH),
    )
    expect(new Set(killRows.map((row) => row.latchCase))).toEqual(new Set([LATCH_CASE_NEVER_REPORTED_IN, LATCH_CASE_NOT_THIS_LAUNCH]))
    for (const row of killRows) {
      expect(row.notice.text.includes(NO_KILL_SENT_PHRASE)).toBe(true)
      expect(cscbOwnLines(row.notice.text).some((line) => line.includes(NO_KILL_SENT_PHRASE))).toBe(false)
      expect(cscbOwnLines(row.notice.text).flatMap(sessionEndingCommandsIn)).toEqual([])
    }
  })

  test('a session-ending command in a line of CSCB\'s own is caught; the same words in the quoted description are let through', () => {
    const named = 'run `agent-director kill --claude-instance-id cscb_alpha` now'
    const notice = conflictNoticeText({ sessionName: STUB_TMUX_SESSION_NAME, latchCase: LATCH_CASE_OWN_ID, description: named })
    expect(cscbOwnLines(notice).flatMap(sessionEndingCommandsIn)).toEqual([])
    expect(sessionEndingCommandsIn(notice)).toEqual(['kill as a command'])
    expect(cscbOwnLines(`${notice}${CONFLICT_NOTICE_LINE_SEPARATOR}${named}`).flatMap(sessionEndingCommandsIn)).toEqual(['kill as a command'])
  })

  test.each([
    ['kill as a command', 'run `agent-director kill --claude-instance-id cscb_alpha`'],
    ['kill as a command', 'agent-director kill'],
    ['kill as a command', 'then kill -9 4242'],
    ['kill as a command', 'run kill on that pane'],
    ['kill as a command', 'type `kill 4242`'],
    ['pause', 'run `agent-director pause --claude-instance-id cscb_alpha`'],
    ['pause', 'pause the session'],
    ['--include-finished', 'agent-director kill --include-finished'],
    ['--include-finished', 'the include-finished option'],
    ['tmux kill-session', 'tmux kill-session -t =slack_bot_alpha'],
    ['tmux kill-server', 'tmux kill-server'],
  ])('the form %p catches %p', (form, text) => {
    expect(sessionEndingCommandsIn(text)).toContain(form)
  })

  test('the forms cover SRJ-1001\'s five commands, and none matches agent-director\'s own words or any stub description', () => {
    expect(SESSION_ENDING_COMMAND_FORMS.map((form) => form.name)).toEqual([
      'kill as a command',
      'pause',
      '--include-finished',
      'tmux kill-session',
      'tmux kill-server',
    ])
    expect([NO_KILL_SENT_PHRASE, RETRY_KILL_LATER_PHRASE, NEVER_DELETE_ROW_PHRASE].flatMap(sessionEndingCommandsIn)).toEqual([])
    expect(CONFLICT_CASE_ROWS.flatMap((row) => sessionEndingCommandsIn(descriptionOf(row)))).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Redaction, the cap and Slack escaping (SRJ-1001, SRJ-508; E12 hatch note)
// ---------------------------------------------------------------------------

describe('the quoted description and session in the notice', () => {
  test('a token-bearing description is redacted in the description line and the post passes assertNoLeak', () => {
    const run = makeNoticeRun()
    const description = `${CONFLICT_OWN_ID_PHRASE} (${sentinelInMessage('n')})`
    latchOnDescription(run.latch, KEY, description)
    const descriptionLine = run.posts[0][1].split(CONFLICT_NOTICE_LINE_SEPARATOR)[1]
    expect(descriptionLine).toBe(expectedConflictNotice({ latchCase: LATCH_CASE_OWN_ID, sessionName: personaTmuxSessionName(KEY), description }).descriptionLine as string)
    expect(descriptionLine.includes(escapeSlackControlCharacters(`(${REDACTED_SENTINEL_TAIL})`))).toBe(true)
    assertNoLeak(run.posts)
  })

  test('an overlong description is capped at MAX_LOGGED_MESSAGE_LENGTH before it is quoted', () => {
    const run = makeNoticeRun()
    const description = `${CONFLICT_OWN_ID_PHRASE} ${'x'.repeat(2 * MAX_LOGGED_MESSAGE_LENGTH)}`
    latchOnDescription(run.latch, KEY, description)
    const descriptionLine = run.posts[0][1].split(CONFLICT_NOTICE_LINE_SEPARATOR)[1]
    const quoted = descriptionLine.slice(CONFLICT_NOTICE_DESCRIPTION_LINE_HEAD.length, -CONFLICT_NOTICE_DESCRIPTION_LINE_TAIL.length)
    expect(quoted).toBe(renderLogMessageText(description))
    expect(quoted.length).toBe(MAX_LOGGED_MESSAGE_LENGTH)
  })

  test('Slack control characters in the description and the session name are escaped once in the post; the log line keeps them as written', () => {
    const run = makeNoticeRun()
    const sessionName = 'ses<s>&n'
    const controls = '<!channel> & <@U0ALERT>'
    const description = `tmux session ${JSON.stringify(sessionName)}: ${CONFLICT_OWN_ID_PHRASE} ${controls}`
    latchOnDescription(run.latch, KEY, description)
    const notice = run.posts[0][1]
    expect(notice).toBe(expectedConflictNotice({ latchCase: LATCH_CASE_OWN_ID, sessionName, description }).text)
    const lines = notice.split(CONFLICT_NOTICE_LINE_SEPARATOR)
    expect(lines[0].includes(JSON.stringify(escapeSlackControlCharacters(sessionName)))).toBe(true)
    expect(lines.at(-2)).toBe(CONFLICT_NOTICE_LIST_LINE_HEAD + escapeSlackControlCharacters(sessionName) + CONFLICT_NOTICE_LIST_LINE_TAIL)
    expect(lines[1]).toBe(CONFLICT_NOTICE_DESCRIPTION_LINE_HEAD + escapeSlackControlCharacters(description) + CONFLICT_NOTICE_DESCRIPTION_LINE_TAIL)
    expect(/[<>]/.test(notice)).toBe(false)
    expect(notice.includes(escapeSlackControlCharacters(escapeSlackControlCharacters('<')))).toBe(false)
    expect(run.lines.filter((line) => line.includes(controls) && line.includes(JSON.stringify(sessionName))).length).toBe(1)
  })

  test('a token-shaped quoted session is redacted in the first line and the list line', () => {
    const run = makeNoticeRun()
    const ownId = rowWhere((row) => row.latchCase === LATCH_CASE_OWN_ID)
    run.latch.setFromConflict(KEY, errTmuxSessionConflict(ownId.verb, ownId.stubCase, fakeToken(BOT_TOKEN_PREFIX, 'q'), ownId.options), {
      refusedOperation: REFUSED_OPERATION_RESUME,
      rowState: ENDED,
    })
    const lines = run.posts[0][1].split(CONFLICT_NOTICE_LINE_SEPARATOR)
    const placeholder = escapeSlackControlCharacters(REDACTED_TOKEN_PLACEHOLDER)
    expect(lines[0].includes(JSON.stringify(placeholder))).toBe(true)
    expect(lines.at(-2)).toBe(CONFLICT_NOTICE_LIST_LINE_HEAD + placeholder + CONFLICT_NOTICE_LIST_LINE_TAIL)
  })
})

// ---------------------------------------------------------------------------
// The episode: once per latch episode (SRJ-508, SRJ-1016; AC 41)
// ---------------------------------------------------------------------------

describe('the CONFLICT notice\'s episode', () => {
  const ownId = rowWhere((row) => row.latchCase === LATCH_CASE_OWN_ID)
  const ownIdAgain = rowWhere((row) => row.latchCase === LATCH_CASE_OWN_ID && row !== ownId)
  const leftover = rowWhere((row) => row.latchCase === LATCH_CASE_LEFTOVER)

  test('a latch posts once; a same-case set posts nothing; a new case posts once more; a return to the first case is a new case too', () => {
    const run = makeNoticeRun()
    latchOnRow(run.latch, KEY, ownId)
    const firstEpisode = run.episodes.view(KEY, PERSONA_EPISODE_KIND_CONFLICT)
    expect(firstEpisode?.caseLabel).toBe(LATCH_CASE_OWN_ID)

    expect(latchOnRow(run.latch, KEY, ownIdAgain)).toBe(CONFLICT_LATCH_SET_SAME_CASE)
    expect(latchOnRow(run.latch, KEY, ownId)).toBe(CONFLICT_LATCH_SET_SAME_CASE)
    expect(run.posts).toEqual([[KEY, ownId.notice.text]])
    expect(run.episodes.view(KEY, PERSONA_EPISODE_KIND_CONFLICT)?.episode).toBe(firstEpisode?.episode)

    expect(latchOnRow(run.latch, KEY, leftover)).toBe(CONFLICT_LATCH_SET_RELATCHED)
    expect(latchOnRow(run.latch, KEY, leftover)).toBe(CONFLICT_LATCH_SET_SAME_CASE)
    expect(latchOnRow(run.latch, KEY, ownId)).toBe(CONFLICT_LATCH_SET_RELATCHED)
    expect(run.posts).toEqual([
      [KEY, ownId.notice.text],
      [KEY, leftover.notice.text],
      [KEY, ownId.notice.text],
    ])
    expect(run.episodes.view(KEY, PERSONA_EPISODE_KIND_CONFLICT)?.caseLabel).toBe(LATCH_CASE_OWN_ID)
  })

  test('a second persona\'s latch posts only for itself and leaves the first persona\'s episode as it was', () => {
    const run = makeNoticeRun()
    latchOnRow(run.latch, KEY, ownId)
    const first = run.episodes.view(KEY, PERSONA_EPISODE_KIND_CONFLICT)
    latchOnRow(run.latch, OTHER, leftover)
    latchOnRow(run.latch, OTHER, leftover)
    expect(run.posts).toEqual([
      [KEY, ownId.notice.text],
      [OTHER, leftover.notice.text],
    ])
    expect(run.episodes.view(KEY, PERSONA_EPISODE_KIND_CONFLICT)).toEqual(first)
  })

  test.each([
    ['unproven-idle', { reason: 'unproven-idle', autoRestartDisabled: false, heldMs: 600_000 }],
    ['blocked-on-prompt', { reason: 'blocked-on-prompt', autoRestartDisabled: false }],
  ] as const)('a persona already given the %s not-connected notice still gets the CONFLICT post once', (_reason, notConnected: NotConnectedNotice) => {
    const notConnectedPosts: Array<readonly [string, string]> = []
    setSessionNotifier((key, text) => {
      notConnectedPosts.push([key, text])
    })
    expect(notifyPersonaNotConnected(KEY, notConnected)).toBe(true)
    expect(notConnectedPosts.map(([key]) => key)).toEqual([KEY])

    const run = makeNoticeRun()
    latchOnRow(run.latch, KEY, ownId)
    latchOnRow(run.latch, KEY, ownId)
    expect(run.posts).toEqual([[KEY, ownId.notice.text]])
    expect(notifyPersonaNotConnected(KEY, notConnected)).toBe(false)
    expect(notConnectedPosts.length).toBe(1)
    assertNoLeak(notConnectedPosts)
  })

  test('a hold case opens no CONFLICT episode and posts no CONFLICT notice: each hold opens its own kind, and the unusable-name hold posts SRJ-1019', () => {
    const run = makeNoticeRun()
    const description = UNUSABLE_NAME_CASE_ROWS[0]!.description
    const holds = [
      [KEY, LATCH_CASE_UNUSABLE_RECORDED_NAME, PERSONA_EPISODE_KIND_UNUSABLE_RECORDED_NAME],
      [OTHER, LATCH_CASE_LAUNCH_START_NOT_RECORDED, PERSONA_EPISODE_KIND_LAUNCH_START_NOT_RECORDED],
    ] as const
    expect(new Set(holds.map(([, latchCase]) => latchCase))).toEqual(new Set(HOLD_LATCH_CASES))
    for (const [key, latchCase] of holds) {
      run.latch.set(key, { latchCase, refusedOperation: REFUSED_OPERATION_NONE, rowState: LATCH_ROW_STATE_UNREADABLE, description })
    }
    for (const [key, , kind] of holds) {
      expect([key, run.episodes.isOpen(key, PERSONA_EPISODE_KIND_CONFLICT), run.episodes.isOpen(key, kind)]).toEqual([key, false, true])
    }
    expect(run.posts.filter(([key]) => key === KEY)).toEqual([[KEY, unusableNameNoticeText(KEY, description)]])
    expect(run.posts.filter(([, text]) => text.startsWith(CONFLICT_NOTICE_FIRST_LINE_HEAD))).toEqual([])
  })

  test('after the episodes close (shutdown) a latch opens and posts nothing; an unbound reaction posts nothing', () => {
    const closed = makeNoticeRun()
    closed.episodes.close()
    latchOnRow(closed.latch, KEY, ownId)
    expect([closed.posts, closed.episodes.isOpen(KEY, PERSONA_EPISODE_KIND_CONFLICT)]).toEqual([[], false])

    const unbound = makeNoticeRun()
    unbound.unbind()
    latchOnRow(unbound.latch, KEY, ownId)
    expect([unbound.posts, unbound.episodes.isOpen(KEY, PERSONA_EPISODE_KIND_CONFLICT)]).toEqual([[], false])
  })

  test('after a teardown forgets the latch and the episodes, a new latch with the same case posts again', () => {
    const run = makeNoticeRun()
    latchOnRow(run.latch, KEY, ownId)
    run.latch.forget(KEY)
    run.episodes.forget(KEY)
    expect(latchOnRow(run.latch, KEY, ownId)).toBe(CONFLICT_LATCH_SET_LATCHED)
    expect(run.posts).toEqual([
      [KEY, ownId.notice.text],
      [KEY, ownId.notice.text],
    ])
  })
})

// ---------------------------------------------------------------------------
// The recovery notice (SRJ-1005)
// ---------------------------------------------------------------------------

describe('the recovery notice', () => {
  const KINDS: ReadonlyArray<readonly [string, LatchKind]> = [
    ['conflict', LATCH_KIND_CONFLICT],
    ['hold', LATCH_KIND_HOLD],
  ]
  const CASES = RECOVERY_REASONS.flatMap(([reasonName, reason]) => KINDS.map(([kindName, kind]) => [kindName, reasonName, kind, reason] as const))

  test.each(CASES)('a %s latch cleared for %s: the heading for its kind, the quoted session only for a CONFLICT latch, and the reason', (_k, _r, kind, reason) => {
    const name = STUB_TMUX_SESSION_NAME
    const reasonText =
      reason.kind === LATCH_RECOVERY_REASON_KIND_ROW_READS
        ? LATCH_RECOVERY_REASON_ROW_READS_HEAD + reason.state
        : LATCH_RECOVERY_REASON_TEXTS[reason.kind]
    const text = latchRecoveryText(kind, reason, name)
    expect(text).toBe(
      kind === LATCH_KIND_CONFLICT
        ? `${CONFLICT_RECOVERY_HEAD}${JSON.stringify(name)}${CONFLICT_RECOVERY_REASON_LEAD}${reasonText}${LATCH_RECOVERY_TAIL}`
        : `${HOLD_RECOVERY_HEAD}${reasonText}${LATCH_RECOVERY_TAIL}`,
    )
    expect(text.includes(name)).toBe(kind === LATCH_KIND_CONFLICT)
    expect(sessionEndingCommandsIn(text)).toEqual([])
    expect(text.split(CONFLICT_NOTICE_LINE_SEPARATOR).flatMap(forbiddenIn)).toEqual([])
  })

  test('each case maps to its latch kind: the two hold cases to hold, every other case to conflict', () => {
    expect(LATCH_CASES.map((latchCase) => [latchCase, latchKindOf(latchCase)])).toEqual(
      LATCH_CASES.map((latchCase) => [latchCase, isHoldLatchCase(latchCase) ? LATCH_KIND_HOLD : LATCH_KIND_CONFLICT]),
    )
  })

  test('a row state and a session name are redacted and escaped in the recovery text', () => {
    const state = `<!here> ${sentinelInMessage('state')}`
    const reasonText = latchRecoveryReasonText(latchRecoveryReasonRowReads(state))
    expect(reasonText).toBe(LATCH_RECOVERY_REASON_ROW_READS_HEAD + escapeSlackControlCharacters(renderLogMessageText(state)))
    const sessionName = 'ses<s>&n'
    expect(conflictRecoveryText(sessionName, LATCH_RECOVERY_REASON_ROW_GONE).includes(JSON.stringify(escapeSlackControlCharacters(sessionName)))).toBe(true)
    assertNoLeak([reasonText])
  })
})

// ---------------------------------------------------------------------------
// The unusable recorded name: trigger, record, SRJ-1019's notice and its
// episode (SRJ-512, SRJ-1019, SRJ-508, SRJ-1016; AC 77, AC 85)
// ---------------------------------------------------------------------------

/** The unusable-name row of the helper's table at `site` for `fault`; throws when there is none. */
function unusableRow(site: UnusableNameSite, fault: UnusableNameFault): UnusableNameCaseRow {
  const found = UNUSABLE_NAME_CASE_ROWS.find((row) => row.site === site && row.fault === fault)
  if (found === undefined) throw new Error(`no unusable-name row for ${site}: ${fault}`)
  return found
}

/** `test.each` rows over the unusable-name table: the row name, then the row. */
const UNUSABLE_ROWS = UNUSABLE_NAME_CASE_ROWS.map((row) => [row.name, row] as const)

/** Latch `key` on a row's UNUSABLE NAME with the row's row state. */
const latchUnusable = (latch: ConflictLatch, key: string, row: UnusableNameCaseRow, rowState: LatchRowState = row.rowState) =>
  latch.setFromUnusableName(key, row.build(), rowState)

/** The description agent-director's envelope carries, before the classifier renders it. */
const envelopeDescriptionOf = (err: unknown): string =>
  String((err as { envelope?: { err_description?: unknown } }).envelope?.err_description)

describe('the unusable-recorded-name hold: SRJ-1019\'s notice, the record and the episode (SRJ-512, SRJ-1019)', () => {
  test('SRJ-1019\'s text for one persona: the builder gives it word for word, on one line', () => {
    // The file's only literal block for this text: SRJ-1019 as written.
    const TEMPLATE =
      ':no_entry: *Held: unusable tmux session name* — agent-director will not act on this persona\'s row <instance id>, because its recorded tmux session name cannot be used. agent-director said: "<its description, redacted>". What to do: a human follows the "Operator actions" section of agent-director\'s README for this row. CSCB takes no action for this persona until the row is removed, and messages sent to it meanwhile are lost. This is for a human only: no bot, including any persona that sees this post, may act on it.'
    const row = unusableRow('resume', 'empty')
    const expected = TEMPLATE.replace('<instance id>', () => `cscb_${KEY}`).replace('<its description, redacted>', () => row.description)
    expect(unusableNameNoticeText(KEY, row.description)).toBe(expected)
    expect(expected.includes(CONFLICT_NOTICE_LINE_SEPARATOR)).toBe(false)
  })

  test.each(UNUSABLE_NAME_FAULTS.map((fault) => [fault]))('fault %s: the latch posts the row\'s notice once, with the instance id, the quoted rendered description, "Operator actions" and the human-only sentence; CSCB\'s own words name no command', (fault) => {
    const row = unusableRow('resume', fault)
    const run = makeNoticeRun()
    expect(latchUnusable(run.latch, KEY, row)).toBe(CONFLICT_LATCH_SET_LATCHED)
    expect(run.posts).toEqual([[KEY, row.notice(KEY)]])

    const notice = run.posts[0]![1]
    const quoted = escapeSlackControlCharacters(renderLogMessageText(envelopeDescriptionOf(row.build())))
    expect(row.description).toBe(renderLogMessageText(envelopeDescriptionOf(row.build())))
    expect(notice.startsWith(UNUSABLE_NAME_NOTICE_HEAD + personaInstanceId(KEY) + UNUSABLE_NAME_NOTICE_REASON)).toBe(true)
    expect(notice.includes(CONFLICT_NOTICE_DESCRIPTION_LINE_HEAD + quoted + CONFLICT_NOTICE_DESCRIPTION_LINE_TAIL)).toBe(true)
    expect(notice.includes(JSON.stringify(operatorActionsTitle()))).toBe(true)
    expect(notice.endsWith(CONFLICT_NOTICE_HUMAN_ONLY_LINE)).toBe(true)

    // CSCB's own words: the description cut out, every other word kept.
    const own = cscbOwnText(notice)
    expect(own.includes(row.description)).toBe(false)
    expect(own.includes(personaInstanceId(KEY))).toBe(true)
    expect(sessionEndingCommandsIn(own)).toEqual([])
    expect(own.split(CONFLICT_NOTICE_LINE_SEPARATOR).flatMap(forbiddenIn)).toEqual([])
  })

  test('a token-bearing description is redacted in the notice and the post passes assertNoLeak; an overlong one is capped at MAX_LOGGED_MESSAGE_LENGTH before it is quoted', () => {
    const run = makeNoticeRun()
    const secret = `${UNUSABLE_RECORDED_NAME_PHRASE} is empty (${sentinelInMessage('u')}); nothing was done`
    expect(run.latch.setFromUnusableName(KEY, errInternal(secret), ENDED)).toBe(CONFLICT_LATCH_SET_LATCHED)
    expect(run.posts.map(([, text]) => text.includes(escapeSlackControlCharacters(`(${REDACTED_SENTINEL_TAIL})`)))).toEqual([true])
    assertNoLeak(run.posts)

    const long = `${UNUSABLE_RECORDED_NAME_PHRASE} is empty ${'x'.repeat(2 * MAX_LOGGED_MESSAGE_LENGTH)}`
    run.latch.setFromUnusableName(OTHER, errInternal(long), ENDED)
    const capped = renderLogMessageText(long)
    expect(capped.length).toBe(MAX_LOGGED_MESSAGE_LENGTH)
    expect(run.latch.record(OTHER)?.description).toBe(capped)
    expect(run.posts[1]).toEqual([OTHER, unusableNameNoticeText(OTHER, capped)])
    expect(run.posts[1]![1].includes(long)).toBe(false)
  })

  test('posted through the persona notifier, the persona\'s own stub receives the notice under the persona prefix at its destination; the other persona\'s stub receives nothing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'conflict-latch-notifier-'))
    try {
      const config = makeMultiPersonaConfig([{}, {}], dir)
      const [persona, other] = config.personas as [(typeof config.personas)[number], (typeof config.personas)[number]]
      const notifier = makeNotifierHarness(config, { leakMarker: LEAK_SENTINEL })
      const sent: Array<Promise<void>> = []
      const run = makeNoticeRun((key, text) => {
        sent.push(notifier.notifier.notify(key, text))
      })
      const row = unusableRow('read-pane', 'stored-differently')
      latchUnusable(run.latch, persona.key, row)
      await Promise.all(sent)
      expect(notifier.posts(persona.key)).toEqual([
        { channel: persona.permission_prompts, text: formatPersonaNotice(persona, unusableNameNoticeText(persona.key, row.description)) },
      ])
      expect(notifier.posts(other.key)).toEqual([])
      expect(notifier.clock.pendingCount()).toBe(0)
      assertNoLeak([notifier.allPosts(), notifier.logs])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test.each(UNUSABLE_ROWS)('%s: the set input is the case, "none", the path\'s row state, slack_bot_<key> and the rendered description; the latch records the row\'s record; a second persona reads not latched', (_name, row) => {
    const run = makeLatchRun()
    expect(isUnusableNameError(row.build())).toBe(true)
    expect(unusableNameSetInput(KEY, row.build(), row.rowState)).toEqual({
      latchCase: row.latchCase,
      refusedOperation: row.refusedOperation,
      rowState: row.rowState,
      sessionName: row.sessionName(KEY),
      description: row.description,
    })
    expect(latchUnusable(run.latch, KEY, row)).toBe(CONFLICT_LATCH_SET_LATCHED)
    expect(run.latch.record(KEY)).toEqual(row.record(KEY))
    expect([run.latch.isLatched(OTHER), run.latch.record(OTHER)]).toEqual([false, undefined])
  })

  test('a description that quotes a session records that session (SRJ-501\'s rule)', () => {
    const run = makeLatchRun()
    const quoted = personaTmuxSessionName(OTHER)
    const err = errInternal(`${UNUSABLE_RECORDED_NAME_PHRASE} ${JSON.stringify(quoted)} is empty; nothing was done`)
    run.latch.setFromUnusableName(KEY, err, ENDED)
    expect(run.latch.record(KEY)?.sessionName).toBe(quoted)
  })

  test.each([
    ['an ErrInternal without the phrase', (): unknown => errInternal()],
    ['the phrase in another error name', (): unknown => errUnknownErrorName('ErrFromALaterBinary', `${UNUSABLE_RECORDED_NAME_PHRASE} is empty`)],
    ['a CONFLICT', (): unknown => rowWhere((row) => row.latchCase === LATCH_CASE_OWN_ID).build()],
    ['a plain Error carrying the phrase', (): unknown => new Error(`${UNUSABLE_RECORDED_NAME_PHRASE} is empty`)],
  ] as const)('%s is no UNUSABLE NAME: setFromUnusableName latches nothing, posts nothing and is silent', (_label, build) => {
    const run = makeNoticeRun()
    expect(isUnusableNameError(build())).toBe(false)
    expect(unusableNameSetInput(KEY, build(), ENDED)).toBeUndefined()
    expect(run.latch.setFromUnusableName(KEY, build(), ENDED)).toBeUndefined()
    expect([run.latch.isLatched(KEY), run.lines, run.events, run.posts]).toEqual([false, [], [], []])
  })
})

describe('the unusable-recorded-name notice\'s episode (SRJ-508, SRJ-1016)', () => {
  const first = unusableRow('resume', 'empty')
  const second = unusableRow('read-pane', 'control-character')
  const conflictRow = rowWhere((row) => row.latchCase === LATCH_CASE_OWN_ID)
  const kindsOpen = (run: NoticeRun, key: string) => [
    run.episodes.isOpen(key, PERSONA_EPISODE_KIND_CONFLICT),
    run.episodes.isOpen(key, PERSONA_EPISODE_KIND_UNUSABLE_RECORDED_NAME),
  ]

  test('the first latch posts once under the unusable-name kind; a second UNUSABLE NAME for P posts nothing and keeps the record; another persona posts for itself', () => {
    const run = makeNoticeRun()
    expect(latchUnusable(run.latch, KEY, first)).toBe(CONFLICT_LATCH_SET_LATCHED)
    const record = run.latch.record(KEY)
    const episode = run.episodes.view(KEY, PERSONA_EPISODE_KIND_UNUSABLE_RECORDED_NAME)
    expect(episode?.caseLabel).toBe(LATCH_CASE_UNUSABLE_RECORDED_NAME)
    expect(kindsOpen(run, KEY)).toEqual([false, true])

    expect(latchUnusable(run.latch, KEY, second)).toBe(CONFLICT_LATCH_SET_SAME_CASE)
    expect(run.latch.record(KEY)).toBe(record)
    expect(run.episodes.view(KEY, PERSONA_EPISODE_KIND_UNUSABLE_RECORDED_NAME)?.episode).toBe(episode?.episode)

    latchUnusable(run.latch, OTHER, second)
    expect(run.posts).toEqual([
      [KEY, first.notice(KEY)],
      [OTHER, second.notice(OTHER)],
    ])
  })

  test('P latched on a CONFLICT relatches on an UNUSABLE NAME with one new post, the record replaced; a relatch back to that CONFLICT posts SRJ-1004 once more; each relatch ends the other kind\'s episode silently', () => {
    const run = makeNoticeRun()
    expect(latchOnRow(run.latch, KEY, conflictRow)).toBe(CONFLICT_LATCH_SET_LATCHED)
    expect(kindsOpen(run, KEY)).toEqual([true, false])

    expect(latchUnusable(run.latch, KEY, first)).toBe(CONFLICT_LATCH_SET_RELATCHED)
    expect(run.latch.record(KEY)).toEqual(first.record(KEY))
    expect(kindsOpen(run, KEY)).toEqual([false, true])
    expect(run.posts).toEqual([
      [KEY, conflictRow.notice.text],
      [KEY, first.notice(KEY)],
    ])

    expect(latchOnRow(run.latch, KEY, conflictRow)).toBe(CONFLICT_LATCH_SET_RELATCHED)
    expect(kindsOpen(run, KEY)).toEqual([true, false])
    expect(latchUnusable(run.latch, KEY, first)).toBe(CONFLICT_LATCH_SET_RELATCHED)
    expect(run.posts).toEqual([
      [KEY, conflictRow.notice.text],
      [KEY, first.notice(KEY)],
      [KEY, conflictRow.notice.text],
      [KEY, first.notice(KEY)],
    ])
  })

  test.each([
    ['unproven-idle', { reason: 'unproven-idle', autoRestartDisabled: false, heldMs: 600_000 }],
    ['blocked-on-prompt', { reason: 'blocked-on-prompt', autoRestartDisabled: false }],
  ] as const)('a persona already given the %s not-connected notice still gets the unusable-name post once', (_reason, notConnected: NotConnectedNotice) => {
    const notConnectedPosts: Array<readonly [string, string]> = []
    setSessionNotifier((key, text) => {
      notConnectedPosts.push([key, text])
    })
    expect(notifyPersonaNotConnected(KEY, notConnected)).toBe(true)

    const run = makeNoticeRun()
    latchUnusable(run.latch, KEY, first)
    latchUnusable(run.latch, KEY, second)
    expect(run.posts).toEqual([[KEY, first.notice(KEY)]])
    expect(notConnectedPosts.map(([key]) => key)).toEqual([KEY])
    assertNoLeak(notConnectedPosts)
  })
})

// ---------------------------------------------------------------------------
// The holds' set observer (SRJ-502; SRJ-610 and SRJ-1016's slow-recovery end)
// ---------------------------------------------------------------------------

/** The holds as `bindConflictLatchHolds` takes them, each recording `[hold, key]` in `calls`; `slowRecovery: false` leaves the optional slow-recovery end out. */
function recordingHolds(calls: Array<readonly [string, string]>, opts: { slowRecovery?: boolean; throwAt?: keyof ConflictLatchHolds } = {}): ConflictLatchHolds {
  const hold = (name: keyof ConflictLatchHolds) => (key: string): void => {
    calls.push([name, key])
    if (opts.throwAt === name) throw new Error(`${name} failed`)
  }
  return {
    stopRetryTimer: hold('stopRetryTimer'),
    endTmuxUnresponsive: hold('endTmuxUnresponsive'),
    endUnclassifiedError: hold('endUnclassifiedError'),
    ...(opts.slowRecovery === false ? {} : { endSlowRecovery: hold('endSlowRecovery') }),
  }
}

describe('the holds\' set observer: the slow-recovery end is the fourth hold (SRJ-502, SRJ-610, SRJ-1016)', () => {
  test('on a set the four holds run for the persona in order, before a notice observer bound after them; a hold that throws is logged and the slow-recovery end still runs', () => {
    const { latch, lines } = makeLatchRun()
    const calls: Array<readonly [string, string]> = []
    bindConflictLatchHolds(latch, recordingHolds(calls, { throwAt: 'endUnclassifiedError' }), (line) => lines.push(line))
    latch.addSetObserver(({ key }) => {
      calls.push(['notice', key])
    })
    latchOnRow(latch, KEY, ROWS[0]![1])
    expect(calls).toEqual([
      ['stopRetryTimer', KEY],
      ['endTmuxUnresponsive', KEY],
      ['endUnclassifiedError', KEY],
      ['endSlowRecovery', KEY],
      ['notice', KEY],
    ])
    expect(lines.filter((line) => line.includes(' hold failed '))).toEqual([expect.stringContaining(`persona=${KEY} hold failed (unclassified-error end): `)])
  })

  test('holds with no slow-recovery end run the other three and log no failure', () => {
    const { latch, lines } = makeLatchRun()
    const calls: Array<readonly [string, string]> = []
    bindConflictLatchHolds(latch, recordingHolds(calls, { slowRecovery: false }), (line) => lines.push(line))
    latchOnRow(latch, KEY, ROWS[0]![1])
    expect(calls.map(([name]) => name)).toEqual(['stopRetryTimer', 'endTmuxUnresponsive', 'endUnclassifiedError'])
    expect(lines.filter((line) => line.includes(' hold failed '))).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// AC 46's automated half, on the recovery harness (SRJ-502, SRJ-501, SRJ-508)
// ---------------------------------------------------------------------------

/** Every recovery harness of this test, leak-checked and cleaned up in `afterEach`. */
let harnesses: RecoveryHarness[] = []

afterEach(() => {
  const built = harnesses
  harnesses = []
  _resetHealthCheckState()
  // The raw tmux seams a case records (`recordRawTmux`); the harness puts back the killer.
  _resetTmuxCommandRunner()
  _resetTmuxSessionProber()
  for (const h of built) {
    try {
      assertNoLeak(h.captured())
    } finally {
      h.cleanup()
    }
  }
})

/** The restart delay the restart module reads; never waited out: a case fires the restart timer by hand. */
const RESTART_DELAY_S = 1

interface AutomatedPathsRun {
  readonly h: RecoveryHarness
  /** Each restart work's outcome, as its serialized turn answered it, in order. */
  readonly outcomes: Array<readonly [string, unknown]>
  /** Mark persona `key`'s row dead: its `status` reads `ended` until its next spawn resolves, then `waiting`. */
  readonly killRow: (key: string) => void
  /** Persona `key`'s row reads `working` from now on, whatever its spawns answer. */
  readonly readWorking: (key: string) => void
  /** Persona `key`'s row reads `pending` with no launch start from now on, whatever its spawns answer (b.jg5 SRJ-513). */
  readonly readPendingNoLaunchStart: (key: string) => void
  /**
   * Persona `key`'s row reads `pending` with the stub's launch start while
   * `pending` is true (the default), whatever its spawns answer; false puts
   * back the reads above.
   */
  readonly readPending: (key: string, pending?: boolean) => void
  /** Persona `key`'s `status` answers `err` from now on. */
  readonly failStatus: (key: string, err: Error) => void
}

/**
 * A recovery harness with both settings 0, every persona's row read `ended`
 * until a spawn of it resolves (`waiting` from then on), and the restart
 * module's serialized turns recorded. The restart module's delay accessor
 * answers `RESTART_DELAY_S`, so `scheduleRestart` arms its timer (with the
 * setting 0 it arms none); the configuration keeps `session_restart_delay` 0.
 * `options` go to the harness (the approver's cap, for instance).
 */
function makeAutomatedPathsRun(options: Omit<RecoveryHarnessOptions, 'restartDeps'> = {}): AutomatedPathsRun {
  const outcomes: Array<readonly [string, unknown]> = []
  let serializer: PersonaSerializer | undefined
  const serialize: PersonaSerialize = (key, operation) =>
    serializer!.run(key, async () => {
      const outcome = await operation()
      outcomes.push([key, outcome])
      return outcome
    })
  const h = makeRecoveryHarness({ ...options, restartDeps: { getRestartDelay: () => RESTART_DELAY_S, serialize } })
  harnesses.push(h)
  serializer = h.serializer
  const live = new Set<string>()
  const working = new Set<string>()
  const noLaunchStart = new Set<string>()
  const pending = new Set<string>()
  const statusErrors = new Map<string, Error>()
  const spawn = h.stub.client.spawn.bind(h.stub.client)
  h.stub.client.spawn = async (params) => {
    const result = await spawn(params)
    live.add(String(params.claude_instance_id))
    return result
  }
  h.script({
    statusFn: (params) => {
      const id = String(params.claude_instance_id)
      const err = statusErrors.get(id)
      if (err !== undefined) return err
      if (noLaunchStart.has(id)) return cannedStatusResult({ state: AGENT_DIRECTOR_PENDING_STATE, launch_started_at: SAMPLE_LAUNCH_START_NONE })
      if (pending.has(id)) return cannedStatusResult({ state: AGENT_DIRECTOR_PENDING_STATE })
      return cannedStatusResult({ state: working.has(id) ? 'working' : live.has(id) ? 'waiting' : 'ended' })
    },
  })
  return {
    h,
    outcomes,
    killRow: (key) => live.delete(personaInstanceId(key)),
    readWorking: (key) => working.add(personaInstanceId(key)),
    readPendingNoLaunchStart: (key) => noLaunchStart.add(personaInstanceId(key)),
    readPending: (key, isPending = true) => {
      if (isPending) pending.add(personaInstanceId(key))
      else pending.delete(personaInstanceId(key))
    },
    failStatus: (key, err) => statusErrors.set(personaInstanceId(key), err),
  }
}

/**
 * Run `arm` with the global `kind` swapped for a recorder and answer the
 * callbacks it set, never scheduled: the restart timer and the health
 * interval take no clock, so a case fires them by hand and no real timer runs.
 */
function armedTimers(kind: 'setTimeout' | 'setInterval', arm: () => void): Array<() => unknown> {
  const g = globalThis as unknown as Record<string, unknown>
  const saved = g[kind]
  const callbacks: Array<() => unknown> = []
  g[kind] = (callback: () => unknown) => {
    callbacks.push(callback)
    return 0
  }
  try {
    arm()
  } finally {
    g[kind] = saved
  }
  return callbacks
}

/** Run `arm`, which sets exactly one timer through the global `kind` (`armedTimers`), and answer that timer's callback. */
function captureTimer(kind: 'setTimeout' | 'setInterval', arm: () => void): () => Promise<void> {
  const callbacks = armedTimers(kind, arm)
  if (callbacks.length !== 1) throw new Error(`expected one ${kind}, got ${callbacks.length}`)
  return async () => {
    await callbacks[0]()
  }
}

/** The stub's launch answers back to their defaults (the row reads stay). */
const CLEARED: RecoveryStubScript = { spawnError: undefined, spawnQueue: undefined, getResult: undefined, resumeError: undefined, readPaneError: undefined }

/** One relaunch of a dead row: its liveness read, the kill, the spawn and the launch's own read. */
const RELAUNCH = { statusCalls: 2, killCalls: 1, spawnCalls: 1 }

/** The latch's reaction to one set of P, as `latchSteps` reads it: the set, the three holds in order, then the notice. */
const oneLatch = (key: string) => [
  ['set', key],
  ['hold', key, 'retry timer stop'],
  ['hold', key, 'tmux-unresponsive end'],
  ['hold', key, 'unclassified-error end'],
  ['notice', key],
]
const latchSteps = (h: RecoveryHarness) =>
  h.latchEvents.map((event) => (event.step === 'hold' ? [event.step, event.key, event.hold] : [event.step, event.key]))

/** The one line a restart request for latched persona `key` logs instead of arming a timer. */
const notSchedulingLine = (key: string) =>
  `[slack] Not scheduling restart for persona=${key} — the persona is latched; no timer armed (b.jg5 SRJ-502)`

/** What `driveEveryPath` saw. */
interface EveryPathRun {
  /** Each new launch's answer: P's, then Q's. */
  readonly launched: unknown[]
  /** What Q's run of each path called, by path name. */
  readonly qCalls: Array<readonly [string, Record<string, number>]>
  /** The lines naming P that each restart request for P logged. */
  readonly notScheduledLines: string[][]
  /** How many retry attempts were recorded before the retry timer's path. */
  readonly attemptsBefore: number
}

/**
 * Drive, for latched P and then for Q with its row dead, a new launch, the
 * retry entry, a scheduled restart, a human-triggered restart request and
 * the retry timer (armed, then over several waits), recording what Q's run
 * of each path called. A restart request for P arms no timer; Q's one timer
 * is fired by hand.
 */
async function driveEveryPath({ h, killRow }: AutomatedPathsRun): Promise<EveryPathRun> {
  const [p, q] = h.keys as [string, string]
  const cwdOf = (key: string): string => personaOf(h, key).working_directory
  const qCalls: Array<readonly [string, Record<string, number>]> = []
  /** Drive `path` for P, then for Q with its row dead, recording what Q's run called. */
  async function drive(name: string, path: (key: string) => Promise<unknown>): Promise<void> {
    await path(p)
    await h.settle()
    killRow(q)
    const before = personaCallCounts(h, q)
    await path(q)
    await h.settle()
    qCalls.push([name, callCountsSince(personaCallCounts(h, q), before)])
  }

  /**
   * Schedule a restart for `key` (`opts` as given): for latched P, no timer is
   * armed and the one line saying so is logged; for Q, its one timer is fired.
   */
  const notScheduledLines: string[][] = []
  async function scheduleFor(key: string, opts?: { humanTrigger: true }): Promise<void> {
    const from = h.errors.length
    const timers = armedTimers('setTimeout', () => scheduleRestart(key, cwdOf(key), undefined, opts))
    if (key !== p) {
      expect(timers).toHaveLength(1)
      await timers[0]!()
      return
    }
    expect(timers).toEqual([])
    expect(isRestartPendingOrActive(p)).toBe(false)
    notScheduledLines.push(h.errors.slice(from).filter((line) => line.includes(`persona=${p}`)))
  }

  const launched: unknown[] = []
  await drive('a new launch', async (key) => launched.push(await h.launch(key)))
  await drive('the retry entry', (key) => runRestartRetry(key, cwdOf(key), isLaunchInFlight))
  await drive('a scheduled restart', (key) => scheduleFor(key))
  await drive('a human-triggered restart', (key) => scheduleFor(key, { humanTrigger: true }))
  const attemptsBefore = h.attempts.length
  await drive('the retry timer', async (key) => {
    h.controller.arm(key, { kind: UNAVAILABLE_RETRY_CAUSE_READ_ERROR })
    await h.advance(4 * UNAVAILABLE_RETRY_CEILING_S * 1000)
  })
  return { launched, qCalls, notScheduledLines, attemptsBefore }
}

/**
 * One health tick, its latched query bound as `main()` binds it, with Q's row
 * read dead first; answers the keys it scheduled a restart for and what Q's
 * part of the tick called.
 */
async function runHealthTick({ h, killRow }: AutomatedPathsRun): Promise<{ scheduled: string[]; qCalls: Record<string, number> }> {
  const q = h.keys[1]!
  const scheduled: string[] = []
  initHealthCheck({
    isSessionAlive: _buildIsSessionAliveAdapter(() => h.config),
    isSessionConnected: () => false,
    hasSessionStream: () => false,
    isRestartPendingOrActive,
    isLaunchInFlight,
    isLatched: (key) => h.latch.isLatched(key),
    isAtCap: (key) => isAtCap(key, RESTART_FAILURE_CAP),
    statRoute: async () => true,
    scheduleRestart: (key) => {
      scheduled.push(key)
    },
    isShuttingDown: () => false,
    getPersonas: () => Object.fromEntries(h.keys.map((key) => [key, personaOf(h, key).working_directory])),
    endTmuxUnresponsive: (key) => {
      h.tickEnd(key)
    },
    onTickEnd: (startedAt) => h.tickOnset(startedAt),
    now: h.clock.now,
  })
  killRow(q)
  const qBeforeTick = personaCallCounts(h, q)
  await captureTimer('setInterval', () => startHealthCheck(1))()
  stopHealthCheck()
  return { scheduled, qCalls: callCountsSince(personaCallCounts(h, q), qBeforeTick) }
}

/** What Q's run of each `driveEveryPath` path calls: Q is unlatched, so each reaches the stub. */
const Q_CALLS_ON_EVERY_PATH = [
  ['a new launch', { spawnCalls: 1, statusCalls: 1 }],
  ['the retry entry', RELAUNCH],
  ['a scheduled restart', RELAUNCH],
  ['a human-triggered restart', RELAUNCH],
  ['the retry timer', { ...RELAUNCH, statusCalls: RELAUNCH.statusCalls + 1 }],
] as const

describe('AC 46: no automated path kills, launches or recovers a latched persona (recovery harness)', () => {
  const plainSpawnRow = rowWhere(
    (row) => row.refusedOperation === REFUSED_OPERATION_PLAIN_SPAWN && row.latchCase === LATCH_CASE_LEFTOVER && row.rowState !== LATCH_ROW_STATE_NO_ROW,
  )
  const resumeRow = rowWhere((row) => row.refusedOperation === REFUSED_OPERATION_RESUME && row.latchCase === LATCH_CASE_OWN_ID)
  /** How each row latches P through the launch driver: its first spawn refused, or the resume of its `ended` row. */
  const LATCH_ROWS: ReadonlyArray<readonly [string, ConflictCaseRow, (h: RecoveryHarness, key: string) => RecoveryStubScript]> = [
    ['a plain spawn', plainSpawnRow, () => ({ spawnError: plainSpawnRow.build() })],
    ['a resume', resumeRow, (h, key) => ({ ...collided(h, personaOf(h, key), { state: 'ended' }), resumeError: resumeRow.build() })],
  ]
  test.each(LATCH_ROWS)('P latched at %s: a new launch, the retry entry, a scheduled restart, a human-triggered restart, the retry timer and the health tick make no kill, spawn, resume or delete for P; one CONFLICT post; Q\'s paths reach the stub as before', async (_label, row, latchScript) => {
    const run = makeAutomatedPathsRun()
    const { h, outcomes } = run
    const [p, q] = h.keys as [string, string]

    h.script(latchScript(h, p))
    expect(await h.launch(p)).toEqual({ key: p, action: 'latched' })
    expect(h.latch.record(p)).toMatchObject({
      sessionName: row.sessionName,
      latchCase: row.latchCase,
      refusedOperation: row.refusedOperation,
      rowState: row.rowState,
    })
    h.script(CLEARED)
    const pAtLatch = personaCallCounts(h, p)
    const { launched, qCalls, notScheduledLines, attemptsBefore } = await driveEveryPath(run)
    // Each request for P logged the not-scheduling line once, and nothing else naming P.
    expect(notScheduledLines).toEqual([[notSchedulingLine(p)], [notSchedulingLine(p)]])

    const { scheduled, qCalls: qTickCalls } = await runHealthTick(run)
    qCalls.push(['the health tick', qTickCalls])

    // P: since the latch, only the tick's liveness read; never a kill of its instance.
    expect(callCountsSince(personaCallCounts(h, p), pAtLatch)).toEqual({ statusCalls: 1 })
    expect(h.stub.calls.killCalls.filter((call) => call.claude_instance_id === personaInstanceId(p))).toEqual([])
    expect(launched).toEqual([{ key: p, action: 'latched' }, { key: q, action: 'spawned' }])
    // P's only serialized work is the retry entry's, answered latched; neither restart request armed a timer for it.
    expect(outcomes).toEqual([
      [p, RESTART_OUTCOME_LATCHED],
      ...[1, 2, 3, 4].map(() => [q, RESTART_OUTCOME_LAUNCHED] as const),
    ])
    expect(isRestartPendingOrActive(p)).toBe(false)
    // P's timer fired once and stopped as latched, with no call; Q's ran its relaunch, then read its row live out of pending.
    expect(h.attempts.slice(attemptsBefore).map((a) => [a.key, a.retry])).toEqual([[p, 1], [q, 1], [q, 2]])
    expect(h.stops.filter((stop) => stop.key === p)).toEqual([{ key: p, reason: UNAVAILABLE_RETRY_STOP_LATCHED }])
    expect(h.controller.armedKeys()).toEqual([])
    expect(scheduled).toEqual([q])
    expect([getFailureCount(p), getFailureCount(q)]).toEqual([0, 0])

    // One latch, one CONFLICT post, no spawn-failure notice or spawn-failed entry.
    expect(latchSteps(h)).toEqual(oneLatch(p))
    expect(h.episodeNotices).toEqual([{ key: p, text: row.notice.text }])
    expect(h.notices).toEqual([])
    expect(h.startupErrors()).toEqual([])
    expect(h.latch.isLatched(q)).toBe(false)

    // Q, beside it, still reaches the stub on every path.
    expect(qCalls).toEqual([...Q_CALLS_ON_EVERY_PATH, ['the health tick', { statusCalls: 1 }]])
  })

  test.each([
    ['UNAVAILABLE (ErrTmuxUnresponsive)', (): Error => errTmuxUnresponsive('status'), UNAVAILABLE_RETRY_CAUSE_UNAVAILABLE, false],
    ['UNAVAILABLE (ErrCallTimeout)', (): Error => errCallTimeout('status'), UNAVAILABLE_RETRY_CAUSE_UNAVAILABLE, false],
    // A read verb's UNCLASSIFIED answer arms with the read-error cause.
    ['UNCLASSIFIED (ErrInternal)', (): Error => errInternal(), UNAVAILABLE_RETRY_CAUSE_READ_ERROR, true],
  ] as const)('a latch-time status read answering %s: read, then set, then the holds, then the notice; no retry timer, tmux-unresponsive condition or unclassified episode is left open for P', async (_label, readError, cause, opensEpisode) => {
    const { h } = makeAutomatedPathsRun()
    const [p, q] = h.keys as [string, string]

    // P's condition holds and its timer is armed: a launch whose spawn tmux did not answer.
    h.script({ spawnError: errTmuxUnresponsive('spawn') })
    expect((await h.launch(p)).action).toBe('failed')
    expect([h.tmuxUnresponsive.holds(p), h.controller.isArmed(p)]).toEqual([true, true])

    // Then a launch whose first spawn answers a CONFLICT; nothing was read before it, so one status read follows.
    const err = readError()
    const atRead: unknown[] = []
    h.script({
      spawnError: plainSpawnRow.build(),
      statusFn: () => {
        atRead.push({ latchSteps: h.latchEvents.length, latched: h.latch.isLatched(p) })
        return err
      },
    })
    const atNotice: unknown[] = []
    const post = h.episodeNotices.push.bind(h.episodeNotices)
    h.episodeNotices.push = (...notices) => {
      atNotice.push({
        armed: h.controller.isArmed(p),
        conditionHolds: h.tmuxUnresponsive.holds(p),
        episodeOpen: h.unclassifiedErrorOpen(p),
        latched: h.latch.isLatched(p),
      })
      return post(...notices)
    }
    const triggersBefore = h.triggers.length

    expect(await h.launch(p)).toEqual({ key: p, action: 'latched' })

    // Read: before any set, and its error reached the timer and (UNCLASSIFIED) the episode, which the latch ended.
    expect(atRead).toEqual([{ latchSteps: 0, latched: false }])
    expect(h.triggers.slice(triggersBefore)).toEqual([{ key: p, kind: cause }])
    const episodeLines = opensEpisode ? [unclassifiedStartedLine(p, err), unclassifiedEndedLine(p, UNCLASSIFIED_ERROR_END_LATCHED)] : []
    expect(unclassifiedLines(h, p)).toEqual(episodeLines)
    // Set, with the read's state (unreadable), then the holds in order, then the notice.
    expect(h.latch.record(p)).toMatchObject({ refusedOperation: REFUSED_OPERATION_PLAIN_SPAWN, rowState: LATCH_ROW_STATE_UNREADABLE })
    expect(latchSteps(h)).toEqual(oneLatch(p))
    expect(h.stops).toEqual([{ key: p, reason: UNAVAILABLE_RETRY_STOP_LATCHED }])
    expect(h.lines.includes(conditionEndedLine(p, TMUX_UNRESPONSIVE_END_LATCHED))).toBe(true)
    expect(h.lines.includes(conditionRecoveryLine(p))).toBe(false)
    // By the notice every hold had run.
    expect(atNotice).toEqual([{ armed: false, conditionHolds: false, episodeOpen: false, latched: true }])
    expect(h.episodeNotices).toEqual([{ key: p, text: plainSpawnRow.notice.text }])

    // Nothing is left to fire for P: several waits on, then past twice the alert threshold in effect, no attempt, no call and no unclassified alert.
    const pCalls = personaCallCounts(h, p)
    await h.advance(4 * UNAVAILABLE_RETRY_CEILING_S * 1000)
    await h.advance(2 * adAlertThresholdMsInEffect())
    expect([h.attempts, personaCallCounts(h, p), h.controller.armedKeys(), h.clock.pendingCount()]).toEqual([[], pCalls, [], 0])
    expect(unclassifiedLines(h, p)).toEqual(episodeLines)
    expect(h.episodeNotices).toEqual([{ key: p, text: plainSpawnRow.notice.text }])
    expect(h.notices).toEqual([])
    expect(personaCallCounts(h, q)).toEqual({})
  })
})

// ---------------------------------------------------------------------------
// SRJ-610, SRJ-1016, SRJ-502: a latch ends P's open slow-recovery episode
// silently and resets its count, through the harness's hold observer as
// main() binds it; Q's episode is left as it is
// ---------------------------------------------------------------------------

describe('SRJ-610, SRJ-1016, SRJ-502: P\'s latch ends its open slow-recovery episode silently and resets its count; Q\'s is untouched (recovery harness)', () => {
  /** The working-row verdict's `read-pane` CONFLICT row: P's next run latches P through the latch's set entry. */
  const workingRowConflict = livenessPaneConflictRowsAt('working-row verdict')[0]!
  const SLOW = PERSONA_EPISODE_KIND_SLOW_DEAD_SESSION_RECOVERY
  /** `key`'s slow-recovery lines among `lines`. */
  const slowLinesOf = (lines: readonly string[], key: string): string[] =>
    lines.filter((line) => line.startsWith(`[slack] slow-recovery: persona=${key} `))

  test('P\'s and Q\'s episodes open after three escalate-dead runs each whose re-probe reads the row live; P\'s CONFLICT latches it: by the CONFLICT notice its count is 0 and its episode ended, with the latched reason and no slow-recovery post; exactly one CONFLICT post; later runs for P post nothing; Q keeps its count and open episode; cleanup leaves no count or episode', async () => {
    const h = makeRecoveryHarness()
    harnesses.push(h)
    const [p, q] = h.keys as [string, string]
    const cwdOf = (key: string): string => personaOf(h, key).working_directory
    const run = (key: string) => runRestartRetry(key, cwdOf(key), isLaunchInFlight)

    // Both rows read `working` and each pane read answers GONE: every run's
    // working-row verdict sweeps and escalates dead, and its re-probe still
    // reads the row live, so each run is one of the tracker's notes.
    h.script({ statusResult: cannedStatusResult({ state: 'working' }), readPaneError: errTmuxCaptureFailed() })
    for (let tick = 0; tick < SLOW_RECOVERY_POST_THRESHOLD; tick++) {
      expect([await run(p), await run(q)]).toEqual([RESTART_OUTCOME_RECONNECT_DEFERRED, RESTART_OUTCOME_RECONNECT_DEFERRED])
    }
    await h.settle()
    // Open, through the tracker and through the harness's episodes view.
    for (const key of [p, q]) {
      expect([key, h.slowRecovery.count(key), h.slowRecovery.isOpen(key), h.episodes.count(key, SLOW), h.episodes.isOpen(key, SLOW)])
        .toEqual([key, SLOW_RECOVERY_POST_THRESHOLD, true, SLOW_RECOVERY_POST_THRESHOLD, true])
    }
    expect(h.episodeNotices).toEqual([{ key: p, text: slowRecoveryText(p) }, { key: q, text: slowRecoveryText(q) }])
    expect([h.latchEvents, h.stub.calls.killCalls, h.stub.calls.spawnCalls]).toEqual([[], [], []])

    // What P's and Q's slow-recovery state is when the CONFLICT notice is posted.
    const atNotice: unknown[] = []
    const post = h.episodeNotices.push.bind(h.episodeNotices)
    h.episodeNotices.push = (...notices) => {
      atNotice.push([h.slowRecovery.count(p), h.slowRecovery.isOpen(p), h.slowRecovery.count(q), h.slowRecovery.isOpen(q)])
      return post(...notices)
    }

    // P's next run: its working-row read-pane answers a CONFLICT, which latches P.
    const linesBefore = h.lines.length
    h.script({ readPaneError: workingRowConflict.build() })
    await run(p)
    await h.settle()
    expect(h.latch.record(p)).toMatchObject({
      sessionName: workingRowConflict.sessionName,
      latchCase: workingRowConflict.latchCase,
      refusedOperation: workingRowConflict.refusedOperation,
      rowState: workingRowConflict.rowState,
    })
    expect(latchSteps(h)).toEqual(oneLatch(p))
    // By the notice the latch's hold had reset P's count and ended its episode; Q's were as before.
    expect(atNotice).toEqual([[0, false, SLOW_RECOVERY_POST_THRESHOLD, true]])
    // Silently: no slow-recovery post, exactly one CONFLICT post; the ended lines carry the latched reason.
    expect(h.episodeNotices).toEqual([
      { key: p, text: slowRecoveryText(p) },
      { key: q, text: slowRecoveryText(q) },
      { key: p, text: workingRowConflict.notice.text },
    ])
    const latchRunLines = h.lines.slice(linesBefore)
    expect(slowLinesOf(latchRunLines, p)).toEqual([
      slowRecoveryCountResetLine(p, SLOW_RECOVERY_POST_THRESHOLD, SLOW_RECOVERY_RESET_LATCHED),
      slowRecoveryEpisodeEndedLine(p, SLOW_RECOVERY_RESET_LATCHED),
    ])
    expect(slowLinesOf(latchRunLines, q)).toEqual([])

    // Later runs for P are latched: no call, no count, no slow-recovery post.
    const pCalls = personaCallCounts(h, p)
    for (let tick = 0; tick < SLOW_RECOVERY_POST_THRESHOLD; tick++) expect(await run(p)).toBe(RESTART_OUTCOME_LATCHED)
    expect([personaCallCounts(h, p), h.slowRecovery.count(p), h.slowRecovery.isOpen(p), h.episodes.isOpen(p, SLOW)]).toEqual([pCalls, 0, false, false])
    expect(h.episodeNotices).toHaveLength(3)
    // Q, not latched, keeps its count and its open episode.
    expect([h.latch.isLatched(q), h.slowRecovery.count(q), h.slowRecovery.isOpen(q)]).toEqual([false, SLOW_RECOVERY_POST_THRESHOLD, true])
    expect(h.clock.pendingCount()).toBe(0)

    // Cleanup leaves no count or open episode behind: Q's are gone with it.
    harnesses = harnesses.filter((built) => built !== h)
    try {
      assertNoLeak(h.captured())
    } finally {
      h.cleanup()
    }
    expect([h.slowRecovery.count(q), h.slowRecovery.isOpen(q), h.clock.pendingCount()]).toEqual([0, false, 0])
  })
})

// ---------------------------------------------------------------------------
// SRJ-502, SRJ-1011: a message lost while P is latched reports held for a
// human, and no restart fires (AC 68), through the recovery harness's
// lost-message driver: the real routing's no-session branch with the
// harness's latch's latched query bound as `main()` binds it
// ---------------------------------------------------------------------------

describe('SRJ-502, SRJ-1011: a message lost while P is latched reports held for a human and fires no restart (recovery harness)', () => {
  const leftoverRow = rowWhere(
    (row) => row.refusedOperation === REFUSED_OPERATION_PLAIN_SPAWN && row.stubCase === 'scan-leftover' && row.rowState === LATCH_ROW_STATE_NO_ROW,
  )

  test('a CONFLICT at P’s spawn latches P; a message lost then reports held for a human with its exported wording at P’s destination, asks for no restart and makes no call, and nothing fires for P afterwards; Q’s lost message reports its own state after its one row read', async () => {
    const h = makeRecoveryHarness()
    harnesses.push(h)
    expect(h.config.session_restart_delay).toBe(0)
    const [p, q] = h.keys as [string, string]
    h.script({ spawnError: leftoverRow.build(), statusError: errSpawnNotFound() })
    expect(await h.launch(p)).toEqual({ key: p, action: 'latched' })
    expect(h.latch.isLatched(p)).toBe(true)
    const afterLatch = callCounts(h)
    const personaCountsAfterLatch = personaCallCounts(h, p)

    // Ignoring the latch would report the delay 0's auto-restart disabled; a
    // restart request is seen even though the latched restart module arms none.
    const lost = await expectLostMessageReports(h, p, 'held-for-human')
    const persona = personaOf(h, p)
    expect(posts(h.slack(p)).map((post) => [post.channel, post.text])).toEqual([
      [persona.permission_prompts, formatPersonaNotice(persona, lost.notice)],
    ])
    expect(h.lostMessageNotices).toEqual([{ key: p, text: lost.notice }])
    expect(h.episodeNotices).toEqual([{ key: p, text: leftoverRow.notice.text }])

    // Nothing fires for P afterwards: several retry waits on, no attempt, no call, nothing pending.
    await h.advance(4 * UNAVAILABLE_RETRY_CEILING_S * 1000)
    expect([h.attempts, callCounts(h), h.clock.pendingCount(), isRestartPendingOrActive(p)]).toEqual([[], afterLatch, 0, false])

    // Q is not latched: its message reports the state that applies to it at
    // the delay 0. States 1 to 5 are clear for Q and nothing is in flight, so
    // its message makes the routing's one row read (SRJ-1011), a `status` of
    // Q's instance, which reads no row (dead), not `pending`.
    await expectLostMessageReports(h, q, 'auto-restart-disabled')
    expect(h.slack(q).calls.postMessage).toHaveLength(1)
    expect(h.slack(p).calls.postMessage).toHaveLength(1)
    expect(h.latch.isLatched(q)).toBe(false)
    expect(personaCallCounts(h, q)).toEqual({ statusCalls: 1 })
    // The latched P's own calls are still those of its launch.
    expect(personaCallCounts(h, p)).toEqual(personaCountsAfterLatch)
  })
})

// ---------------------------------------------------------------------------
// SRJ-512, SRJ-502: an UNUSABLE NAME from `resume` and from the working-row
// evidence `read-pane` latches P once, posts SRJ-1019 once, and is followed
// by no tmux-touching call, raw tmux call, delete or counted failure on any
// automated path; a lost message then reports held for a human (AC 68, AC 77)
// ---------------------------------------------------------------------------

/** One raw tmux seam call: the seam and what it targeted (a session name, or the runner's arguments joined). */
interface RawTmuxCall {
  readonly seam: string
  readonly target: string
}

/**
 * Replace every raw tmux seam of the session manager (the command runner,
 * the session prober and the session killer) with a recorder that runs
 * nothing; `afterEach` and the harness's `cleanup()` put them back. Answers
 * the recorded calls, in order. The startup-dialog approver has no raw tmux
 * seam: its pane reads and keys go through the stub client's `readPane` and
 * `sendKeys`, which `tmuxTouchingCallsIn` counts.
 */
function recordRawTmux(): RawTmuxCall[] {
  const calls: RawTmuxCall[] = []
  const record = (seam: string, target: string) => calls.push({ seam, target })
  _setTmuxCommandRunner(async (args) => {
    record('runner', args.join(' '))
    return { code: 1, stdout: '' }
  })
  _setTmuxSessionProber(async (name) => {
    record('prober', name)
    return false
  })
  _setTmuxSessionKiller(async (name) => {
    record('killer', name)
  })
  return calls
}

/** The instance id a stub call's params name, if any. */
const instanceOf = (params: unknown): unknown => (params as { claude_instance_id?: unknown } | undefined)?.claude_instance_id

/**
 * Each way an UNUSABLE NAME latches P through the launch driver: the row
 * whose answer it is, and the stub answers that bring P's launch there.
 * `resume`: the optimistic spawn collides, the collision `get` reads `ended`
 * and the `resume` answers it. The working-row evidence `read-pane`: the
 * optimistic spawn collides, the collision `get` reads a live `working` row,
 * so the launch waits for it; the wait's `status` reads `working` (the case
 * makes P's row read so) and its evidence read, the pane read, answers it.
 */
const UNUSABLE_LATCH_WAYS: ReadonlyArray<readonly [string, UnusableNameCaseRow, (h: RecoveryHarness, key: string) => RecoveryStubScript]> = [
  ['resume', unusableRow('resume', 'empty'), (h, key) => ({ ...collided(h, personaOf(h, key), { state: 'ended' }), resumeError: unusableRow('resume', 'empty').build() })],
  [
    'the working-row evidence read-pane',
    unusableRow('read-pane', 'control-character'),
    (h, key) => ({ ...collided(h, personaOf(h, key), { state: 'working' }), readPaneError: unusableRow('read-pane', 'control-character').build() }),
  ],
]

describe('SRJ-512: an UNUSABLE NAME from resume and from the working-row read-pane holds P for a human on every automated path (recovery harness)', () => {
  test.each(UNUSABLE_LATCH_WAYS)('P latched by %s: one SRJ-1019 post; then a new launch, the retry entry, a scheduled and a human-triggered restart and the retry timer make no tmux-touching call, raw tmux call or delete for P and count nothing; Q\'s paths reach the stub as before', async (_label, row, latchScript) => {
    const run = makeAutomatedPathsRun()
    const { h, outcomes } = run
    expect([h.config.session_restart_delay, h.config.health_check_interval]).toEqual([0, 0])
    const [p, q] = h.keys as [string, string]
    const session = personaTmuxSessionName(p)
    const raw = recordRawTmux()
    run.readWorking(p)

    h.script(latchScript(h, p))
    expect(await h.launch(p)).toEqual({ key: p, action: 'latched' })
    expect(h.latch.record(p)).toEqual(row.record(p))
    h.script(CLEARED)
    const touchingAtLatch = tmuxTouchingCallCounts(h.stub.calls)
    const rawAtLatch = raw.length

    const { launched, qCalls, notScheduledLines, attemptsBefore } = await driveEveryPath(run)

    // Nothing tmux-touching, raw or deleting reached P after the latch.
    expect(tmuxTouchingCallsIn(h.stub.calls, touchingAtLatch).filter((call) => instanceOf(call.params) === personaInstanceId(p))).toEqual([])
    expect(raw.slice(rawAtLatch).filter((call) => call.target.includes(session))).toEqual([])
    expect(h.stub.calls.deleteCalls.filter((call) => instanceOf(call) === personaInstanceId(p))).toEqual([])
    // Each path stopped for P: the launch and the retry entry answered latched, no restart timer, the retry timer stopped latched.
    expect(launched).toEqual([{ key: p, action: 'latched' }, { key: q, action: 'spawned' }])
    expect(outcomes).toEqual([
      [p, RESTART_OUTCOME_LATCHED],
      ...[1, 2, 3, 4].map(() => [q, RESTART_OUTCOME_LAUNCHED] as const),
    ])
    expect(notScheduledLines).toEqual([[notSchedulingLine(p)], [notSchedulingLine(p)]])
    expect(h.attempts.slice(attemptsBefore).map((a) => [a.key, a.retry])).toEqual([[p, 1], [q, 1], [q, 2]])
    expect(h.stops.filter((stop) => stop.key === p)).toEqual([{ key: p, reason: UNAVAILABLE_RETRY_STOP_LATCHED }])
    expect([h.controller.armedKeys(), isRestartPendingOrActive(p)]).toEqual([[], false])
    // Nothing counted, no spawn-failure notice or spawn-failed entry, one latch and exactly one post: SRJ-1019.
    expect([getFailureCount(p), getFailureCount(q)]).toEqual([0, 0])
    expect(h.notices).toEqual([])
    expect(h.startupErrors()).toEqual([])
    expect(latchSteps(h)).toEqual(oneLatch(p))
    expect(h.episodeNotices).toEqual([{ key: p, text: row.notice(p) }])
    expect(h.latch.isLatched(q)).toBe(false)
    // Q, beside it, still reaches the stub on every path.
    expect(qCalls).toEqual([...Q_CALLS_ON_EVERY_PATH])
  })

  test.each(UNUSABLE_LATCH_WAYS)('P latched by %s: a message lost then reports held for a human with its exported wording at P\'s destination, with no status read and no restart; Q\'s lost message reports its own state', async (_label, row, latchScript) => {
    const h = makeRecoveryHarness()
    harnesses.push(h)
    expect(h.config.session_restart_delay).toBe(0)
    const [p, q] = h.keys as [string, string]
    // P's row reads working (the read-pane way's evidence read is then made); Q's reads no row.
    h.script({
      ...latchScript(h, p),
      statusFn: (params) => (params.claude_instance_id === personaInstanceId(p) ? cannedStatusResult({ state: 'working' }) : errSpawnNotFound()),
    })
    expect(await h.launch(p)).toEqual({ key: p, action: 'latched' })
    expect(h.latch.record(p)).toEqual(row.record(p))
    const pCallsAtLatch = personaCallCounts(h, p)

    const lost = await expectLostMessageReports(h, p, 'held-for-human')
    const persona = personaOf(h, p)
    expect(posts(h.slack(p)).map((post) => [post.channel, post.text])).toEqual([[persona.permission_prompts, formatPersonaNotice(persona, lost.notice)]])
    expect(h.restartAsks.filter((key) => key === p)).toEqual([])
    expect([isRestartPendingOrActive(p), personaCallCounts(h, p)]).toEqual([false, pCallsAtLatch])
    expect(h.episodeNotices).toEqual([{ key: p, text: row.notice(p) }])

    await expectLostMessageReports(h, q, 'auto-restart-disabled')
    expect(h.latch.isLatched(q)).toBe(false)
  })

  test('UNCLASSIFIED control: an ErrInternal without the phrase from the same resume latches nothing, posts no hold notice and takes the unclassified handling', async () => {
    const h = makeRecoveryHarness()
    harnesses.push(h)
    const [p] = h.keys as [string]
    const err = errInternal()
    h.script({ ...collided(h, personaOf(h, p), { state: 'ended' }), resumeError: err })

    expect(await h.launch(p)).toEqual({ key: p, action: 'failed', refused: true })

    // No latch and no hold notice.
    expect([h.latch.isLatched(p), h.latchEvents, h.episodeNotices]).toEqual([false, [], []])
    // E12's handling: the unclassified episode opens, the timer is armed with the UNCLASSIFIED cause, nothing is counted or noticed, and nothing more is called.
    expect(unclassifiedLines(h, p)).toEqual([unclassifiedStartedLine(p, err)])
    expect(h.unclassifiedErrorOpen(p)).toBe(true)
    expect(h.triggers).toEqual([{ key: p, kind: UNAVAILABLE_RETRY_CAUSE_UNCLASSIFIED }])
    expect([getFailureCount(p), h.notices, h.startupErrors()]).toEqual([0, [], []])
    expect(personaCallCounts(h, p)).toEqual({ spawnCalls: 1, getCalls: 1, resumeCalls: 1 })
  })
})

// ---------------------------------------------------------------------------
// SRJ-118, SRJ-505, SRJ-502, SRJ-512: the reconnect is a latch site. P
// launches onto a colliding `waiting` row and its reconnect's one `send-keys`
// answers CONFLICT (a case-table reconnect row for `waiting`) or UNUSABLE
// NAME: P latches once with one post, and no path that could retry it (a new
// launch, the retry entry, a scheduled and a human-triggered restart, the
// retry timer, the health tick) makes another `send-keys`, any other
// tmux-touching call or a raw tmux call for P, or counts anything; Q's
// launch and reconnect go on.
// ---------------------------------------------------------------------------

/** How P's reconnect latches: [label, P's expected record, P's one post, the stub answers of the launch]. */
const RECONNECT_LATCH_WAYS: ReadonlyArray<
  readonly [string, (key: string) => ConflictLatchRecord, (key: string) => string, (h: RecoveryHarness, key: string) => RecoveryStubScript]
> = [
  ...[reconnectConflictRowsAt('waiting')[0]!].map((row) => [
    `CONFLICT (${row.name})`,
    (key: string) =>
      expectedLatchRecord(key, {
        latchCase: row.latchCase,
        refusedOperation: row.refusedOperation,
        rowState: row.rowState,
        sessionName: row.sessionName,
        description: row.build().errDescription,
      }),
    () => row.notice.text,
    (h: RecoveryHarness, key: string) => ({ ...collided(h, personaOf(h, key), { state: 'waiting' }), sendKeysError: row.build() }),
  ] as const),
  ...[reconnectUnusableNameRowsAt('waiting')[0]!].map((row) => [
    `UNUSABLE NAME (${row.name})`,
    (key: string) => row.record(key),
    (key: string) => row.notice(key),
    (h: RecoveryHarness, key: string) => ({ ...collided(h, personaOf(h, key), { state: 'waiting' }), sendKeysError: row.build() }),
  ] as const),
]

describe('SRJ-118, SRJ-505: a CONFLICT or UNUSABLE NAME at the reconnect\'s send-keys holds P, and no automated path retries it (recovery harness)', () => {
  test.each(RECONNECT_LATCH_WAYS)('P latched by its reconnect\'s %s: one post; then a new launch, the retry entry, a scheduled and a human-triggered restart, the retry timer and the health tick make no send-keys, other tmux-touching call, raw tmux call or delete for P and count nothing; the retry timer is stopped; Q launches and reconnects as before', async (_label, record, notice, latchScript) => {
    const run = makeAutomatedPathsRun()
    const { h, outcomes } = run
    expect([h.config.session_restart_delay, h.config.health_check_interval]).toEqual([0, 0])
    const [p, q] = h.keys as [string, string]
    const session = personaTmuxSessionName(p)
    const raw = recordRawTmux()

    h.script(latchScript(h, p))
    expect(await h.launch(p)).toEqual({ key: p, action: 'latched' })
    expect(h.latch.record(p)).toEqual(record(p))
    expect(h.stub.calls.sendKeysCalls.map((call) => call.claude_instance_id)).toEqual([personaInstanceId(p)])
    h.script({ ...CLEARED, sendKeysError: undefined })
    const touchingAtLatch = tmuxTouchingCallCounts(h.stub.calls)
    const rawAtLatch = raw.length

    const { launched, qCalls, notScheduledLines, attemptsBefore } = await driveEveryPath(run)
    const tick = await runHealthTick(run)

    // Nothing tmux-touching (the send-keys included), raw or deleting reached P after the latch.
    expect(tmuxTouchingCallsIn(h.stub.calls, touchingAtLatch).filter((call) => instanceOf(call.params) === personaInstanceId(p))).toEqual([])
    expect(h.stub.calls.sendKeysCalls.filter((call) => call.claude_instance_id === personaInstanceId(p))).toHaveLength(1)
    expect(raw.slice(rawAtLatch).filter((call) => call.target.includes(session))).toEqual([])
    expect(h.stub.calls.deleteCalls.filter((call) => instanceOf(call) === personaInstanceId(p))).toEqual([])
    // Each path stopped for P: the launch and the retry entry answered latched, no restart timer, the retry timer stopped latched, the tick scheduled nothing for it.
    expect(launched).toEqual([{ key: p, action: 'latched' }, { key: q, action: 'spawned' }])
    expect(outcomes).toEqual([
      [p, RESTART_OUTCOME_LATCHED],
      ...[1, 2, 3, 4].map(() => [q, RESTART_OUTCOME_LAUNCHED] as const),
    ])
    expect(notScheduledLines).toEqual([[notSchedulingLine(p)], [notSchedulingLine(p)]])
    expect(h.attempts.slice(attemptsBefore).map((a) => [a.key, a.retry])).toEqual([[p, 1], [q, 1], [q, 2]])
    expect(h.stops.filter((stop) => stop.key === p)).toEqual([{ key: p, reason: UNAVAILABLE_RETRY_STOP_LATCHED }])
    expect([h.controller.armedKeys(), isRestartPendingOrActive(p)]).toEqual([[], false])
    expect(tick.scheduled).toEqual([q])
    // Nothing counted, no spawn-failure notice or spawn-failed entry, one latch and exactly one post.
    expect([getFailureCount(p), getFailureCount(q)]).toEqual([0, 0])
    expect(h.notices).toEqual([])
    expect(h.startupErrors()).toEqual([])
    expect(latchSteps(h)).toEqual(oneLatch(p))
    expect(h.episodeNotices).toEqual([{ key: p, text: notice(p) }])
    expect(h.latch.isLatched(q)).toBe(false)
    // Q, beside it, reaches the stub on every path, and its own reconnect on a waiting row is typed.
    expect(qCalls).toEqual([...Q_CALLS_ON_EVERY_PATH])
    expect(tick.qCalls).toEqual({ statusCalls: 1 })
    h.script(collided(h, personaOf(h, q), { state: 'waiting' }))
    expect(await h.launch(q)).toEqual({ key: q, action: 'reconnected' })
    expect(h.stub.calls.sendKeysCalls.filter((call) => call.claude_instance_id === personaInstanceId(q))).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// SRJ-504: a server restart drops every latch; the next attempt meeting the
// same condition latches again with exactly one post (AC 45)
// ---------------------------------------------------------------------------

describe('SRJ-504: after a server restart a persona that was latched latches again with exactly one post (recovery harness)', () => {
  const scanRow = rowWhere(
    (row) => row.refusedOperation === REFUSED_OPERATION_PLAIN_SPAWN && row.stubCase === 'scan-leftover' && row.rowState === LATCH_ROW_STATE_NO_ROW,
  )
  const noValidIdRow = rowWhere((row) => row.refusedOperation === REFUSED_OPERATION_PLAIN_SPAWN && row.latchCase === LATCH_CASE_NO_VALID_ID)

  /**
   * Each leg: the row its refusal is, the stub's answers (the same in both
   * lifetimes: the condition still holds after the restart), the row state the
   * latch records by T3's rule, and the calls the bring-up's launch makes.
   */
  const RESTART_LEGS: ReadonlyArray<
    readonly [string, ConflictCaseRow, (h: RecoveryHarness, key: string) => RecoveryStubScript, LatchRowState, readonly string[]]
  > = [
    [
      // The scan's refusal wrote no row, so the bring-up's plain first spawn
      // meets the scan again; the latch-time status read finds no row (HO rev 15).
      'the scan leg: the bring-up\'s plain first spawn meets scan-leftover again',
      scanRow,
      () => ({ spawnError: scanRow.build(), statusError: errSpawnNotFound() }),
      LATCH_ROW_STATE_NO_ROW,
      ['spawn', 'status'],
    ],
    [
      // Today's ladder (E22 makes the last step the reuse spawn): the row reads
      // ended with no session id, so the resume answers ErrNoSessionId, the row
      // is deleted and the plain spawn meets "duplicate session"; the collision
      // get's ended is the last read before it (no diagnosis get for ErrNoSessionId).
      'the "no valid label" leg: collision, get ended with no session id, resume ErrNoSessionId, delete, plain spawn no-valid-id',
      noValidIdRow,
      (h, key) => ({
        ...collided(h, personaOf(h, key), { state: 'ended', claude_session_id: '' }, noValidIdRow.build()),
        resumeError: errNoSessionId(),
      }),
      ENDED,
      ['spawn', 'get', 'resume', 'delete', 'spawn'],
    ],
  ]

  /** The reaction to one fresh latch of `key`: the set (latched, not relatched), the three holds, the one notice. */
  const freshLatch = (key: string, text: string) => [
    ['set', key, CONFLICT_LATCH_SET_LATCHED],
    ['hold', key, 'retry timer stop'],
    ['hold', key, 'tmux-unresponsive end'],
    ['hold', key, 'unclassified-error end'],
    ['notice', key, text],
  ]
  const latchReaction = (h: RecoveryHarness) =>
    h.latchEvents.map((event) =>
      event.step === 'set' ? [event.step, event.key, event.outcome] : event.step === 'hold' ? [event.step, event.key, event.hold] : [event.step, event.key, event.text],
    )

  /**
   * One server lifetime's bring-up of P against the condition: the launch
   * answers latched with the leg's record, the one fresh latch reaction and
   * exactly one CONFLICT post, no spawn-failure notice and no spawn-failed
   * entry, and only the leg's calls.
   */
  async function bringUpLatches(
    h: RecoveryHarness,
    row: ConflictCaseRow,
    script: (h: RecoveryHarness, key: string) => RecoveryStubScript,
    rowState: LatchRowState,
    calls: readonly string[],
  ): Promise<void> {
    const [p, q] = h.keys as [string, string]
    h.script(script(h, p))
    const order = recordCallOrder(h)
    expect(await h.launch(p)).toEqual({ key: p, action: 'latched' })
    expect(h.latch.isLatched(p)).toBe(true)
    expect(h.latch.record(p)).toMatchObject({
      sessionName: row.sessionName,
      latchCase: row.latchCase,
      refusedOperation: REFUSED_OPERATION_PLAIN_SPAWN,
      rowState,
    })
    expect(order).toEqual([...calls])
    expect(latchReaction(h)).toEqual(freshLatch(p, row.notice.text))
    expect(h.episodeNotices).toEqual([{ key: p, text: row.notice.text }])
    expect(h.notices).toEqual([])
    expect(h.startupErrors()).toEqual([])
    expect(h.latch.isLatched(q)).toBe(false)
  }

  test.each(RESTART_LEGS)('%s: P latches in the first lifetime; the second starts with P unlatched and latches it again with one post', async (_label, row, script, rowState, calls) => {
    // The first server lifetime: P latches at its bring-up.
    const h1 = makeRecoveryHarness()
    harnesses.push(h1)
    const p = h1.keys[0]!
    await bringUpLatches(h1, row, script, rowState, calls)
    // The restart: leak-checked as afterEach would and cleaned up here, even when the check fails; only then out of the afterEach list.
    try {
      assertNoLeak(h1.captured())
    } finally {
      h1.cleanup()
    }
    harnesses = harnesses.filter((h) => h !== h1)

    // The second lifetime, over a stub still answering the same condition.
    const h2 = makeRecoveryHarness()
    harnesses.push(h2)
    expect(h2.keys[0]).toBe(p)
    // Nothing carried over: before its first attempt P is unlatched, with no record, no latch event and no post.
    expect([h2.latch.isLatched(p), h2.latch.record(p)]).toEqual([false, undefined])
    expect([h2.latchEvents, h2.episodeNotices, callCounts(h2)]).toEqual([[], [], {}])

    await bringUpLatches(h2, row, script, rowState, calls)
  })
})

// ---------------------------------------------------------------------------
// The note rules (SRJ-114; SRJ-501's note trigger; SRJ-1004's note notice;
// AC 40, AC 45, AC 85)
// ---------------------------------------------------------------------------

/**
 * One row read as `decideOwnRowRead` takes it. A `pending` row shows the
 * stub's default launch start, as the canned builders give one, so the note
 * is what decides; the other states show none.
 */
const rowRead = (claudeInstanceId: string, note: string | null | undefined, state = 'waiting'): RowReadRow => ({
  claude_instance_id: claudeInstanceId,
  state,
  liveness_note: note,
  ...(state === AGENT_DIRECTOR_PENDING_STATE ? { launch_started_at: SAMPLE_LAUNCH_START_DEFAULT } : {}),
})

/** Every state agent-director reports, by name: the live states (`pending` and `waiting` among them), then the dead ones. */
const ROW_STATES = [...AGENT_DIRECTOR_LIVE_STATES, ...AGENT_DIRECTOR_DEAD_STATES].map((state) => [state] as const)

/**
 * The notes that latch no one, by name: every other note agent-director
 * names, a note CSCB does not know (which starts with the latching note's
 * spelling, so a prefix match catches it), the latching note case-folded and
 * inside other text (no case-folded or substring match), and no note.
 */
const NON_LATCHING_NOTES: ReadonlyArray<readonly [string, string | null | undefined]> = [
  ...nonLatchingNotes.map((note) => [`the ${note} note`, note] as const),
  [`the unknown note ${unknownNote}`, unknownNote],
  ['the latching note case-folded', provenanceNote.toUpperCase()],
  ['the latching note inside other text', ` ${provenanceNote} `],
  ['no note (absent)', undefined],
  ['no note (null)', null],
  ['an empty note', ''],
]

describe('the note rules: the pure decision over one read of a persona\'s own row (SRJ-114)', () => {
  test.each(ROW_STATES)('a configured persona\'s own row in state %s with the latching note decides a latch: conflicting labels, P\'s bring-up and the state read', (state) => {
    expect(decideOwnRowRead({ key: KEY, row: rowRead(personaInstanceId(KEY), provenanceNote, state), configured: true })).toEqual({
      latch: { latchCase: LATCH_CASE_CONFLICTING_LABELS, refusedOperation: REFUSED_OPERATION_BRING_UP, rowState: latchRowStateRead(state) },
    })
  })

  test('a waiting row\'s decided state counts as live', () => {
    const decision = decideOwnRowRead({ key: KEY, row: rowRead(personaInstanceId(KEY), provenanceNote, 'waiting'), configured: true })
    expect(decision.latch).toBeDefined()
    expect(rowStateCountsAsLive(decision.latch!.rowState)).toBe(true)
  })

  test.each(NON_LATCHING_NOTES)('%s on a configured persona\'s own row decides nothing', (_name, note) => {
    expect(decideOwnRowRead({ key: KEY, row: rowRead(personaInstanceId(KEY), note), configured: true })).toEqual(ROW_READ_NO_DECISION)
  })

  test.each([
    ['the row of a key not configured (an absent persona\'s own row)', personaInstanceId(KEY), false],
    ['another caller\'s row', LAUNCH_START_ANOTHER_CALLERS_ID, true],
    ['another persona\'s own row, read for P', personaInstanceId(OTHER), true],
    ['a row whose id only starts with P\'s own', `${personaInstanceId(KEY)}_x`, true],
  ] as const)('the latching note on %s decides nothing', (_name, claudeInstanceId, configured) => {
    expect(decideOwnRowRead({ key: KEY, row: rowRead(claudeInstanceId, provenanceNote), configured })).toEqual(ROW_READ_NO_DECISION)
  })
})

describe('the note latch through the own-row read: record, notice, relatch and who latches (recovery harness; SRJ-114, SRJ-501, SRJ-1004)', () => {
  /** The reading site the log lines name; any site reads the same way. */
  const SITE: OwnRowReadSite = { site: 'conflict-latch.test', what: 'own-row get' }

  /** A recovery harness, cleaned up and leak-checked in `afterEach`, with its two configured personas. */
  function makeNoteRun(): { h: RecoveryHarness; p: string; q: string } {
    const h = makeRecoveryHarness()
    harnesses.push(h)
    const [p, q] = h.keys as [string, string]
    return { h, p, q }
  }

  /** The stub's `get` answer: configured persona `key`'s own row in `state`, carrying `note` (none when undefined). */
  const ownRowAnswer = (h: RecoveryHarness, key: string, note: string | undefined, state = 'waiting'): RecoveryStubScript => ({
    getResult: cannedGetResult({ state, liveness_note: note }, personaOf(h, key), h.home),
  })

  /** Each latch set as the observers saw it: the key and the outcome. */
  const setOutcomes = (h: RecoveryHarness) => h.latchEvents.flatMap((event) => (event.step === 'set' ? [[event.key, event.outcome]] : []))

  /** The note latch's notice for `key`, as the shared helper builds it: "conflicting labels", `slack_bot_<key>`, no description. */
  const noteNotice = (key: string) => expectedConflictNotice({ latchCase: LATCH_CASE_CONFLICTING_LABELS, sessionName: personaTmuxSessionName(key) }).text

  test('a note latch once: a provenance_conflict note on P\'s own waiting row latches P with slack_bot_<key>, conflicting labels, P\'s bring-up and a live waiting state; one CONFLICT post; a second read posts nothing; Q stays unlatched', async () => {
    const { h, p, q } = makeNoteRun()
    h.script(ownRowAnswer(h, p, provenanceNote))

    expect(await readPersonaOwnRow(p, SITE)).toMatchObject({ kind: OWN_ROW_READ_ROW, latched: true })
    const record = h.latch.record(p)
    expect(record).toEqual({
      sessionName: personaTmuxSessionName(p),
      latchCase: LATCH_CASE_CONFLICTING_LABELS,
      refusedOperation: REFUSED_OPERATION_BRING_UP,
      rowState: latchRowStateRead('waiting'),
    })
    expect(rowStateCountsAsLive(record!.rowState)).toBe(true)
    expect(h.episodeNotices).toEqual([{ key: p, text: noteNotice(p) }])

    // The same note read again: still latched with the record unchanged, and nothing more posted.
    expect(await readPersonaOwnRow(p, SITE)).toMatchObject({ kind: OWN_ROW_READ_ROW, latched: true })
    expect(h.latch.record(p)).toBe(record)
    expect(setOutcomes(h)).toEqual([[p, CONFLICT_LATCH_SET_LATCHED], [p, CONFLICT_LATCH_SET_SAME_CASE]])
    expect(h.episodeNotices).toEqual([{ key: p, text: noteNotice(p) }])
    expect(h.notices).toEqual([])

    // Q, configured beside P, is neither latched nor called.
    expect([h.latch.isLatched(q), h.latch.record(q)]).toEqual([false, undefined])
    expect(personaCallCounts(h, q)).toEqual({})
    expect(personaCallCounts(h, p)).toEqual({ getCalls: 2 })
  })

  test('the note latch\'s notice is SRJ-1004\'s conflicting-labels notice for slack_bot_<key>: the first line with the case sentence, the pointer, the list and the human-only lines, and no "agent-director said" line', async () => {
    const { h, p } = makeNoteRun()
    h.script(ownRowAnswer(h, p, provenanceNote))
    await readPersonaOwnRow(p, SITE)

    const session = personaTmuxSessionName(p)
    expect(h.episodeNotices.map((notice) => notice.key)).toEqual([p])
    const lines = h.episodeNotices[0]!.text.split(CONFLICT_NOTICE_LINE_SEPARATOR)
    expect(lines).toEqual([
      CONFLICT_NOTICE_FIRST_LINE_HEAD +
        JSON.stringify(session) +
        CONFLICT_NOTICE_CASE_SENTENCE_LEAD +
        CONFLICT_CASE_SENTENCES[LATCH_CASE_CONFLICTING_LABELS] +
        CONFLICT_NOTICE_FIRST_LINE_TAIL,
      CONFLICT_NOTICE_POINTER_LINE,
      CONFLICT_NOTICE_LIST_LINE_HEAD + session + CONFLICT_NOTICE_LIST_LINE_TAIL,
      CONFLICT_NOTICE_HUMAN_ONLY_LINE,
    ])
    expect(lines.filter((line) => line.startsWith(CONFLICT_NOTICE_DESCRIPTION_LINE_HEAD))).toEqual([])
  })

  test('P latched first with another case relatches on the note with conflicting labels, P\'s bring-up and the state read, and exactly one new post', async () => {
    const { h, p, q } = makeNoteRun()
    const first = rowWhere(
      (row) => row.refusedOperation === REFUSED_OPERATION_PLAIN_SPAWN && row.latchCase === LATCH_CASE_LEFTOVER && row.rowState !== LATCH_ROW_STATE_NO_ROW,
    )
    h.script({ spawnError: first.build() })
    expect(await h.launch(p)).toEqual({ key: p, action: 'latched' })
    expect(h.latch.record(p)?.latchCase).toBe(LATCH_CASE_LEFTOVER)

    h.script({ spawnError: undefined, ...ownRowAnswer(h, p, provenanceNote, 'ended') })
    expect(await readPersonaOwnRow(p, SITE)).toMatchObject({ kind: OWN_ROW_READ_ROW, latched: true })
    expect(h.latch.record(p)).toEqual({
      sessionName: personaTmuxSessionName(p),
      latchCase: LATCH_CASE_CONFLICTING_LABELS,
      refusedOperation: REFUSED_OPERATION_BRING_UP,
      rowState: ENDED,
    })
    expect(setOutcomes(h)).toEqual([[p, CONFLICT_LATCH_SET_LATCHED], [p, CONFLICT_LATCH_SET_RELATCHED]])
    expect(h.episodeNotices).toEqual([
      { key: p, text: first.notice.text },
      { key: p, text: noteNotice(p) },
    ])
    expect(h.latch.isLatched(q)).toBe(false)
  })

  test('a configured second persona\'s own row with the note latches that persona alone, with its own session', async () => {
    const { h, p, q } = makeNoteRun()
    h.script(ownRowAnswer(h, q, provenanceNote))
    expect(await readPersonaOwnRow(q, SITE)).toMatchObject({ kind: OWN_ROW_READ_ROW, latched: true })
    expect(h.latch.record(q)?.sessionName).toBe(personaTmuxSessionName(q))
    expect([h.latch.isLatched(p), h.latch.record(p)]).toEqual([false, undefined])
    expect(setOutcomes(h)).toEqual([[q, CONFLICT_LATCH_SET_LATCHED]])
    expect(h.episodeNotices).toEqual([{ key: q, text: noteNotice(q) }])
  })

  /**
   * The reads that latch no one, by name: the key read and the stub's `get`
   * answer for it. Two listed notes stand for the rest (the pure decision
   * above covers every note). An absent persona is a key outside the
   * harness's personas, or one removed from the applied configuration.
   */
  const NO_LATCH_READS: ReadonlyArray<readonly [string, (h: RecoveryHarness, p: string) => { key: string; script: RecoveryStubScript }]> = [
    ...(['tmux_server_changed', 'process_not_seen_session_present'] as const).map(
      (note) => [`a ${note} note on P's own row`, (h: RecoveryHarness, p: string) => ({ key: p, script: ownRowAnswer(h, p, note) })] as const,
    ),
    [`an unknown note (${unknownNote}) on P's own row`, (h, p) => ({ key: p, script: ownRowAnswer(h, p, unknownNote) })],
    ['no note on P\'s own row', (h, p) => ({ key: p, script: ownRowAnswer(h, p, undefined) })],
    [
      `a ${provenanceNote} note on another caller's row`,
      (_h, p) => ({ key: p, script: { getResult: cannedGetResult({ claude_instance_id: LAUNCH_START_ANOTHER_CALLERS_ID, liveness_note: provenanceNote }) } }),
    ],
    [
      `a ${provenanceNote} note on the own row of a key outside the configuration (an absent persona)`,
      (h) => {
        expect(h.keys).not.toContain(LAUNCH_START_ABSENT_PERSONA_KEY)
        return { key: LAUNCH_START_ABSENT_PERSONA_KEY, script: { getResult: cannedGetResult({ claude_instance_id: personaInstanceId(LAUNCH_START_ABSENT_PERSONA_KEY), liveness_note: provenanceNote }) } }
      },
    ],
    [
      `a ${provenanceNote} note on the own row of a persona removed from the applied configuration`,
      (h, p) => {
        const script = ownRowAnswer(h, p, provenanceNote)
        h.remove(p)
        return { key: p, script }
      },
    ],
  ]

  test.each(NO_LATCH_READS)('%s latches no one and posts nothing', async (_name, read) => {
    const { h, p } = makeNoteRun()
    const { key, script } = read(h, p)
    h.script(script)
    expect(await readPersonaOwnRow(key, SITE)).toMatchObject({ kind: OWN_ROW_READ_ROW, latched: false })
    expect([...h.keys, LAUNCH_START_ABSENT_PERSONA_KEY].filter((k) => h.latch.isLatched(k))).toEqual([])
    expect([h.latchEvents, h.episodeNotices, h.notices]).toEqual([[], [], []])
  })
})

// ---------------------------------------------------------------------------
// A `pending` row with no launch start (SRJ-513, SRJ-1020, SRJ-508, SRJ-1016;
// AC 8, AC 68, AC 86): the decision, the notice, the record and episode, the
// hold on every automated path, the latch-time read's precedence and the
// lost message
// ---------------------------------------------------------------------------

/**
 * The directory the decision cases' persona labels are computed against: its
 * `claude_config_dir` sits under it (not created; the label follows the
 * nearest existing ancestor's real path). Nothing is written there. Made by
 * the first case that asks for it (`mkdtempSync`) and removed in `afterEach`.
 */
let launchStartHomeDir: string | undefined

/** This case's launch-start home: made on first use, removed in `afterEach`. */
function launchStartHome(): string {
  launchStartHomeDir ??= mkdtempSync(join(tmpdir(), 'conflict-latch-launch-start-'))
  return launchStartHomeDir
}

afterEach(() => {
  const dir = launchStartHomeDir
  launchStartHomeDir = undefined
  if (dir !== undefined) rmSync(dir, { recursive: true, force: true })
})

/** A persona the launch-start rows are built for, its directories under `launchStartHome()`. */
const launchStartPersona = (key: string): CannedRowPersona => ({
  key,
  working_directory: join(launchStartHome(), key, 'work'),
  claude_config_dir: join(launchStartHome(), key, 'claude'),
})

/** `test.each` rows over the latching launch-start rows: the row name, then the row. */
const LAUNCH_START_ROWS = LAUNCH_START_CASE_ROWS.map((row) => [row.name, row] as const)

/** The `pending` row state a launch-start latch records. */
const PENDING = latchRowStateRead(AGENT_DIRECTOR_PENDING_STATE)

/** The launch-start decision over `row` read for persona `key` (the one configured persona). */
const launchStartDecision = (row: LaunchStartCaseRow, key = KEY) => decideOwnRowRead(row.decisionInput(launchStartPersona(key), launchStartHome()))

/** The latching row of `shape` for P's current life, its launch start absent. */
function currentLifeRow(shape: LaunchStartCaseRow['shape']): LaunchStartCaseRow {
  const found = LAUNCH_START_CASE_ROWS.find((row) => row.shape === shape && row.variant === 'current life' && row.form === 'absent')
  if (found === undefined) throw new Error(`no current-life launch-start row for ${shape}`)
  return found
}

/** Latch `key` from one read of `row`, as the shared reads do: the decision, then the latch with its row state. */
function latchFromLaunchStartRead(latch: ConflictLatch, key: string, row: LaunchStartCaseRow) {
  const decision = launchStartDecision(row, key)
  if (decision.latch === undefined) throw new Error(`${row.name} decided nothing`)
  return latch.setLaunchStartNotRecorded(key, decision.latch.rowState)
}

describe('the launch-start decision over one read of a persona\'s own row (SRJ-513, SRJ-408)', () => {
  test.each(LAUNCH_START_ROWS)('%s: the decision latches with "launch start not recorded", "none" and pending; latched from it, P records that with slack_bot_<key> and the post is the row\'s notice, once', (_name, row) => {
    expect(launchStartDecision(row)).toEqual({
      latch: { latchCase: row.latchCase, refusedOperation: row.refusedOperation, rowState: row.rowState },
    })
    const run = makeNoticeRun()
    expect(latchFromLaunchStartRead(run.latch, KEY, row)).toBe(CONFLICT_LATCH_SET_LATCHED)
    expect(run.latch.record(KEY)).toEqual(row.record(KEY))
    expect(run.posts).toEqual([[KEY, row.notice(KEY)]])
  })

  test.each(LAUNCH_START_NON_LATCHING_ROWS.map((row) => [row.name, row] as const))('%s decides nothing', (_name, row) => {
    expect(decideOwnRowRead(row.decisionInput(launchStartPersona(KEY), launchStartHome()))).toEqual(ROW_READ_NO_DECISION)
  })

  test('a row carrying both the provenance_conflict note and no launch start decides "launch start not recorded" only, never "conflicting labels"', () => {
    const row = LAUNCH_START_AND_NOTE_ROW
    expect(row.readRow(launchStartPersona(KEY), launchStartHome()).liveness_note).toBe(provenanceNote)
    expect(launchStartDecision(row)).toEqual(ROW_READ_LAUNCH_START_NOT_RECORDED)
    expect(launchStartDecision(row).latch?.latchCase).toBe(LATCH_CASE_LAUNCH_START_NOT_RECORDED)
  })
})

describe('SRJ-1020\'s notice for a launch start not recorded', () => {
  test('SRJ-1020\'s text for one persona: the builder gives it word for word, on one line', () => {
    // The file's only literal block for this text: SRJ-1020 as written.
    const TEMPLATE =
      ':no_entry: *Held: launch start not recorded* — this persona\'s agent-director row reads pending but records no launch start, so it was written by an agent-director process older than the install, and agent-director will not act on its session <session>. A human should look: follow the "Operator actions" section of agent-director\'s README. CSCB takes no action for this persona until the row reads ended or missing, or is removed, and messages sent to it meanwhile are lost. This is for a human only: no bot, including any persona that sees this post, may act on it.'
    const expected = TEMPLATE.replace('<session>', () => JSON.stringify(`slack_bot_${KEY}`))
    expect(launchStartNotRecordedNoticeText(KEY)).toBe(expected)
    expect(expected.includes(CONFLICT_NOTICE_LINE_SEPARATOR)).toBe(false)
  })

  test('the notice quotes the persona\'s session, points to "Operator actions" for a human only, and CSCB\'s words name no session-ending command, include-finished, kill-pane, set-option, agent-director delete or clear-latch', () => {
    const notice = launchStartNotRecordedNoticeText(KEY)
    expect(notice.includes(JSON.stringify(personaTmuxSessionName(KEY)))).toBe(true)
    expect(notice.includes(LAUNCH_START_NOTICE_POINTER)).toBe(true)
    expect(notice.includes(JSON.stringify(operatorActionsTitle()))).toBe(true)
    expect(notice.endsWith(CONFLICT_NOTICE_HUMAN_ONLY_LINE)).toBe(true)

    // No description is quoted, so the whole notice is CSCB's own text.
    const own = cscbOwnText(notice)
    expect(own).toBe(notice)
    expect(sessionEndingCommandsIn(own)).toEqual([])
    expect(own.split(CONFLICT_NOTICE_LINE_SEPARATOR).flatMap(forbiddenIn)).toEqual([])
    assertNoLeak([notice])
  })

  test('a persona key with Slack control characters is escaped once in the quoted session', () => {
    const key = 'p<q>&r'
    const notice = launchStartNotRecordedNoticeText(key)
    expect(notice.includes(JSON.stringify(escapeSlackControlCharacters(personaTmuxSessionName(key))))).toBe(true)
    expect(/[<>]/.test(notice)).toBe(false)
  })

  test('posted through the persona notifier, the persona\'s own stub receives formatPersonaNotice(persona, notice) at its destination; the other persona\'s stub receives nothing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'conflict-latch-launch-start-notifier-'))
    try {
      const config = makeMultiPersonaConfig([{}, {}], dir)
      const [persona, other] = config.personas as [(typeof config.personas)[number], (typeof config.personas)[number]]
      const notifier = makeNotifierHarness(config, { leakMarker: LEAK_SENTINEL })
      const sent: Array<Promise<void>> = []
      const run = makeNoticeRun((key, text) => {
        sent.push(notifier.notifier.notify(key, text))
      })
      expect(run.latch.setLaunchStartNotRecorded(persona.key, PENDING)).toBe(CONFLICT_LATCH_SET_LATCHED)
      await Promise.all(sent)
      expect(notifier.posts(persona.key)).toEqual([
        { channel: persona.permission_prompts, text: formatPersonaNotice(persona, launchStartNotRecordedNoticeText(persona.key)) },
      ])
      expect(notifier.posts(other.key)).toEqual([])
      expect(notifier.clock.pendingCount()).toBe(0)
      assertNoLeak([notifier.allPosts(), notifier.logs])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('the launch-start latch\'s record and episode (SRJ-513, SRJ-508, SRJ-1016)', () => {
  const kindsOpen = (run: NoticeRun, key: string) => [
    run.episodes.isOpen(key, PERSONA_EPISODE_KIND_CONFLICT),
    run.episodes.isOpen(key, PERSONA_EPISODE_KIND_UNUSABLE_RECORDED_NAME),
    run.episodes.isOpen(key, PERSONA_EPISODE_KIND_LAUNCH_START_NOT_RECORDED),
  ]

  test('the first read latches P with the case, "none", pending and the quoted slack_bot_<key> and posts once; three more reads of the same row (status, list, get) post nothing and keep the record; a second persona stays unlatched', () => {
    const run = makeNoticeRun()
    const get = currentLifeRow('get')
    expect(latchFromLaunchStartRead(run.latch, KEY, get)).toBe(CONFLICT_LATCH_SET_LATCHED)
    const record = run.latch.record(KEY)
    expect(record).toEqual(launchStartRecord(KEY))
    expect(launchStartNotRecordedSetInput(KEY, PENDING)).toEqual({
      latchCase: LATCH_CASE_LAUNCH_START_NOT_RECORDED,
      refusedOperation: REFUSED_OPERATION_NONE,
      rowState: PENDING,
      sessionName: personaTmuxSessionName(KEY),
    })
    const episode = run.episodes.view(KEY, PERSONA_EPISODE_KIND_LAUNCH_START_NOT_RECORDED)
    expect(episode?.caseLabel).toBe(LATCH_CASE_LAUNCH_START_NOT_RECORDED)
    expect(kindsOpen(run, KEY)).toEqual([false, false, true])

    for (const row of [currentLifeRow('status'), currentLifeRow('list'), get]) {
      expect(latchFromLaunchStartRead(run.latch, KEY, row)).toBe(CONFLICT_LATCH_SET_SAME_CASE)
    }
    expect(run.latch.record(KEY)).toBe(record)
    expect(run.episodes.view(KEY, PERSONA_EPISODE_KIND_LAUNCH_START_NOT_RECORDED)?.episode).toBe(episode?.episode)
    expect(run.posts).toEqual([[KEY, launchStartNotRecordedNoticeText(KEY)]])
    expect([run.latch.isLatched(OTHER), run.latch.record(OTHER)]).toEqual([false, undefined])
  })

  /** Each way P is latched first, the post it made, and the episode kind it opened. */
  const FIRST_LATCHES: ReadonlyArray<readonly [string, (latch: ConflictLatch) => unknown, string, PersonaEpisodeKind]> = [
    (() => {
      const row = rowWhere((r) => r.latchCase === LATCH_CASE_OWN_ID)
      return ['a CONFLICT (a case-table row)', (latch: ConflictLatch) => latchOnRow(latch, KEY, row), row.notice.text, PERSONA_EPISODE_KIND_CONFLICT] as const
    })(),
    (() => {
      const row = unusableRow('resume', 'empty')
      return ['"unusable recorded name"', (latch: ConflictLatch) => latchUnusable(latch, KEY, row), row.notice(KEY), PERSONA_EPISODE_KIND_UNUSABLE_RECORDED_NAME] as const
    })(),
    [
      'a provenance_conflict note',
      (latch: ConflictLatch) =>
        latch.set(KEY, {
          latchCase: LATCH_CASE_CONFLICTING_LABELS,
          refusedOperation: REFUSED_OPERATION_BRING_UP,
          rowState: latchRowStateRead('waiting'),
          sessionName: personaTmuxSessionName(KEY),
        }),
      expectedConflictNotice({ latchCase: LATCH_CASE_CONFLICTING_LABELS, sessionName: personaTmuxSessionName(KEY) }).text,
      PERSONA_EPISODE_KIND_CONFLICT,
    ],
  ]

  test.each(FIRST_LATCHES)('P latched first on %s relatches on a no-launch-start read with exactly one new post, the record replaced and the first kind\'s episode ended', (_label, latchFirst, firstPost, firstKind) => {
    const run = makeNoticeRun()
    expect(latchFirst(run.latch)).toBe(CONFLICT_LATCH_SET_LATCHED)
    expect(run.episodes.isOpen(KEY, firstKind)).toBe(true)

    expect(latchFromLaunchStartRead(run.latch, KEY, currentLifeRow('status'))).toBe(CONFLICT_LATCH_SET_RELATCHED)
    expect(run.latch.record(KEY)).toEqual(launchStartRecord(KEY))
    expect(kindsOpen(run, KEY)).toEqual([false, false, true])
    expect(latchFromLaunchStartRead(run.latch, KEY, currentLifeRow('get'))).toBe(CONFLICT_LATCH_SET_SAME_CASE)
    expect(run.posts).toEqual([
      [KEY, firstPost],
      [KEY, launchStartNotRecordedNoticeText(KEY)],
    ])
    expect(run.latch.isLatched(OTHER)).toBe(false)
  })

  test.each([
    ['unproven-idle', { reason: 'unproven-idle', autoRestartDisabled: false, heldMs: 600_000 }],
    ['blocked-on-prompt', { reason: 'blocked-on-prompt', autoRestartDisabled: false }],
  ] as const)('a persona already given the %s not-connected notice still gets the launch-start post once', (_reason, notConnected: NotConnectedNotice) => {
    const notConnectedPosts: Array<readonly [string, string]> = []
    setSessionNotifier((key, text) => {
      notConnectedPosts.push([key, text])
    })
    expect(notifyPersonaNotConnected(KEY, notConnected)).toBe(true)

    const run = makeNoticeRun()
    latchFromLaunchStartRead(run.latch, KEY, currentLifeRow('get'))
    latchFromLaunchStartRead(run.latch, KEY, currentLifeRow('list'))
    expect(run.posts).toEqual([[KEY, launchStartNotRecordedNoticeText(KEY)]])
    expect(notConnectedPosts.map(([key]) => key)).toEqual([KEY])
    assertNoLeak(notConnectedPosts)
  })
})

/** Each latch set the harness's observers saw: the key and the outcome. */
const harnessSetOutcomes = (h: RecoveryHarness) => h.latchEvents.flatMap((event) => (event.step === 'set' ? [[event.key, event.outcome]] : []))

/** A `status` answer: persona `p`'s own row reads `pending` with no launch start; every other persona's row is gone. */
const pNoLaunchStartStatus = (p: string): RecoveryStubScript => ({
  statusFn: (params) =>
    params.claude_instance_id === personaInstanceId(p)
      ? cannedStatusResult({ state: AGENT_DIRECTOR_PENDING_STATE, launch_started_at: SAMPLE_LAUNCH_START_NONE })
      : errSpawnNotFound(),
})

/**
 * Each origin of P's launch-start latch on `makeAutomatedPathsRun`'s harness,
 * where P's row reads `pending` with no launch start. Each runs the origin
 * and checks only that it latched P.
 */
const LAUNCH_START_ORIGINS: ReadonlyArray<readonly [string, (run: AutomatedPathsRun, p: string) => Promise<void>]> = [
  [
    'the collision get after P\'s launch collided, the row in P\'s cwd',
    async ({ h }, p) => {
      h.script(collided(h, personaOf(h, p), { state: AGENT_DIRECTOR_PENDING_STATE, launch_started_at: SAMPLE_LAUNCH_START_NONE }))
      expect(await h.launch(p)).toEqual({ key: p, action: 'latched' })
    },
  ],
  [
    'the collision get after P\'s launch collided, the row in another existing cwd',
    async ({ h }, p) => {
      h.script(collided(h, personaOf(h, p), { state: AGENT_DIRECTOR_PENDING_STATE, launch_started_at: SAMPLE_LAUNCH_START_NONE, cwd: h.home }))
      expect(await h.launch(p)).toEqual({ key: p, action: 'latched' })
    },
  ],
  [
    'a scheduled restart\'s liveness read',
    async ({ h, outcomes }, p) => {
      const fire = captureTimer('setTimeout', () => scheduleRestart(p, personaOf(h, p).working_directory))
      await fire()
      await h.settle()
      expect(outcomes).toEqual([[p, RESTART_OUTCOME_LATCHED]])
    },
  ],
  [
    'the retry timer\'s row read in pending-only mode',
    async ({ h }, p) => {
      h.controller.armPendingOnly(p)
      await retryNow(h, p)
      expect(h.attempts.map((a) => [a.key, a.mode])).toEqual([[p, UNAVAILABLE_RETRY_MODE_PENDING_ONLY]])
    },
  ],
  [
    'the lost-message read',
    async ({ h }, p) => {
      await expectLostMessageReports(h, p, 'held-for-human', { calls: { statusCalls: 1 } })
    },
  ],
]

describe('SRJ-513: a pending row with no launch start holds P for a human on every automated path (recovery harness)', () => {
  test.each(LAUNCH_START_ORIGINS)('P latched by %s: then the retry timer over several waits, a scheduled and a human-triggered restart, the retry entry and a new launch make no send-keys, kill, read-pane, find-missing, spawn or resume for P, count nothing and leave no timer armed; one SRJ-1020 post; Q\'s paths reach the stub as before', async (_label, origin) => {
    const run = makeAutomatedPathsRun()
    const { h, outcomes } = run
    expect([h.config.session_restart_delay, h.config.health_check_interval]).toEqual([0, 0])
    const [p, q] = h.keys as [string, string]
    run.readPendingNoLaunchStart(p)

    await origin(run, p)
    expect(h.latch.record(p)).toEqual(launchStartRecord(p))
    h.script(CLEARED)
    const pAtLatch = personaCallCounts(h, p)
    const touchingAtLatch = tmuxTouchingCallCounts(h.stub.calls)
    const findMissingAtLatch = h.stub.calls.findMissingCalls.length
    // An origin may itself have run restart work or stopped P's timer; only what the paths below add is checked.
    const outcomesAtLatch = outcomes.length
    const pStopsAtLatch = h.stops.filter((stop) => stop.key === p).length

    const { launched, qCalls, notScheduledLines, attemptsBefore } = await driveEveryPath(run)

    // Since the latch, no call of any verb for P's instance, no tmux-touching call for it, and no find-missing sweep.
    expect(callCountsSince(personaCallCounts(h, p), pAtLatch)).toEqual({})
    expect(tmuxTouchingCallsIn(h.stub.calls, touchingAtLatch).filter((call) => instanceOf(call.params) === personaInstanceId(p))).toEqual([])
    expect(h.stub.calls.findMissingCalls.length).toBe(findMissingAtLatch)
    // Never, before the latch or after it, a send-keys or a kill for P.
    expect(tmuxTouchingCallsIn(h.stub.calls).filter((call) => (call.verb === 'send-keys' || call.verb === 'kill') && instanceOf(call.params) === personaInstanceId(p))).toEqual([])
    // Each path stopped for P: the launch and the retry entry answered latched, no restart timer, the retry timer stopped latched.
    expect(launched).toEqual([{ key: p, action: 'latched' }, { key: q, action: 'spawned' }])
    expect(outcomes.slice(outcomesAtLatch)).toEqual([
      [p, RESTART_OUTCOME_LATCHED],
      ...[1, 2, 3, 4].map(() => [q, RESTART_OUTCOME_LAUNCHED] as const),
    ])
    expect(notScheduledLines).toEqual([[notSchedulingLine(p)], [notSchedulingLine(p)]])
    expect(h.attempts.slice(attemptsBefore).map((a) => [a.key, a.retry])).toEqual([[p, 1], [q, 1], [q, 2]])
    expect(h.stops.filter((stop) => stop.key === p).slice(pStopsAtLatch)).toEqual([{ key: p, reason: UNAVAILABLE_RETRY_STOP_LATCHED }])
    expect([h.controller.isArmed(p), h.controller.armedKeys(), isRestartPendingOrActive(p)]).toEqual([false, [], false])
    // Nothing counted, no spawn-failure notice or spawn-failed entry, one latch and exactly one post: SRJ-1020.
    expect([getFailureCount(p), getFailureCount(q)]).toEqual([0, 0])
    expect(h.notices).toEqual([])
    expect(h.startupErrors()).toEqual([])
    expect(harnessSetOutcomes(h)).toEqual([[p, CONFLICT_LATCH_SET_LATCHED]])
    expect(h.episodeNotices).toEqual([{ key: p, text: launchStartNotRecordedNoticeText(p) }])
    expect(h.latch.isLatched(q)).toBe(false)
    // Q, beside it, still reaches the stub on every path.
    expect(qCalls).toEqual([...Q_CALLS_ON_EVERY_PATH])
  })

  /** A key outside the harness's personas, or a persona removed from the applied configuration, whose row reads `pending` with no launch start. */
  const UNCONFIGURED_KEYS: ReadonlyArray<readonly [string, (h: RecoveryHarness, p: string) => string]> = [
    ['a key outside the harness\'s personas', (h) => {
      expect(h.keys).not.toContain(LAUNCH_START_ABSENT_PERSONA_KEY)
      return LAUNCH_START_ABSENT_PERSONA_KEY
    }],
    ['a persona removed from the applied configuration', (h, p) => {
      h.remove(p)
      return p
    }],
  ]

  test.each(UNCONFIGURED_KEYS)('a no-launch-start pending row under %s latches no one and posts nothing, at a get and at a status read', async (_label, keyOf) => {
    const h = makeRecoveryHarness()
    harnesses.push(h)
    const [p] = h.keys as [string]
    const persona = personaOf(h, p)
    const key = keyOf(h, p)
    const row = { state: AGENT_DIRECTOR_PENDING_STATE, launch_started_at: SAMPLE_LAUNCH_START_NONE }
    h.script({
      getResult: cannedGetResult(row, { ...persona, key }, h.home),
      statusResult: cannedStatusResult(row),
    })
    const site: OwnRowReadSite = { site: 'conflict-latch.test', what: 'own-row read' }

    expect(await readPersonaOwnRow(key, site)).toMatchObject({ kind: OWN_ROW_READ_ROW, latched: false })
    expect(await readPersonaOwnRowStatus(key, site)).toMatchObject({ kind: OWN_ROW_STATUS_STATE, state: AGENT_DIRECTOR_PENDING_STATE })
    expect([...h.keys, LAUNCH_START_ABSENT_PERSONA_KEY].filter((k) => h.latch.isLatched(k))).toEqual([])
    expect([h.latchEvents, h.episodeNotices, h.notices]).toEqual([[], [], []])
  })
})

describe('SRJ-513, A2: a CONFLICT or an UNUSABLE NAME whose latch-time status read finds P\'s own row pending with no launch start leaves P latched with "launch start not recorded" alone, with one post (recovery harness)', () => {
  const plainSpawnConflict = rowWhere(
    (row) => row.refusedOperation === REFUSED_OPERATION_PLAIN_SPAWN && row.latchCase === LATCH_CASE_LEFTOVER && row.rowState !== LATCH_ROW_STATE_NO_ROW,
  )
  const plainSpawnUnusable = unusableRow('plain spawn', 'empty')

  test.each([
    ['a CONFLICT (a case-table row)', (): Error => plainSpawnConflict.build()],
    ['an UNUSABLE NAME', (): Error => plainSpawnUnusable.build()],
  ] as const)('P\'s first spawn refused with %s: the latch-time read latches P with the launch-start case, no other case is set on top, and the one post is SRJ-1020\'s', async (_label, spawnError) => {
    const h = makeRecoveryHarness()
    harnesses.push(h)
    const [p, q] = h.keys as [string, string]
    h.script({ spawnError: spawnError(), ...pNoLaunchStartStatus(p) })

    expect(await h.launch(p)).toEqual({ key: p, action: 'latched' })
    expect(h.latch.record(p)).toEqual(launchStartRecord(p))
    expect(harnessSetOutcomes(h)).toEqual([[p, CONFLICT_LATCH_SET_LATCHED]])
    expect(latchSteps(h)).toEqual(oneLatch(p))
    expect(h.episodeNotices).toEqual([{ key: p, text: launchStartNotRecordedNoticeText(p) }])
    expect(personaCallCounts(h, p)).toEqual({ spawnCalls: 1, statusCalls: 1 })
    expect([h.notices, getFailureCount(p), h.latch.isLatched(q)]).toEqual([[], 0, false])
  })
})

describe('SRJ-513, SRJ-512: P latched on another case relatches through a real own-row status read with one new post (recovery harness)', () => {
  /** The reading site the step's lines name. */
  const SITE: OwnRowReadSite = { site: 'conflict-latch.test', what: 'own-row status read' }
  const conflictRow = rowWhere(
    (row) => row.refusedOperation === REFUSED_OPERATION_PLAIN_SPAWN && row.latchCase === LATCH_CASE_LEFTOVER && row.rowState !== LATCH_ROW_STATE_NO_ROW,
  )
  const unusable = unusableRow('status', 'empty')

  /** `[slack] <site>: <what> for persona=<key>`: the head of every line the step logs for `key` at `SITE`. */
  const stepHead = (key: string) => `[slack] ${SITE.site}: ${SITE.what} for persona=${key}`
  /** The lines the step logged at `SITE` for `key` since `from` (an index into `h.errors`). */
  const stepLinesSince = (h: RecoveryHarness, key: string, from: number) => h.errors.slice(from).filter((line) => line.startsWith(`${stepHead(key)}:`))

  /** A `status` answer: persona `p`'s own row answers UNUSABLE NAME; every other persona's row is gone. */
  const pUnusableStatus = (p: string): RecoveryStubScript => ({
    statusFn: (params) => (params.claude_instance_id === personaInstanceId(p) ? unusable.build() : errSpawnNotFound()),
  })

  /** Each way P is latched first through a real path: the case it holds, its one post and the episode kind it opened. */
  const FIRST_LATCHES: ReadonlyArray<readonly [string, (h: RecoveryHarness, p: string) => Promise<unknown>, LatchCase, (p: string) => string, PersonaEpisodeKind]> = [
    [
      'a CONFLICT (a case-table row) at P\'s launch',
      async (h, p) => {
        h.script({ spawnError: conflictRow.build() })
        expect(await h.launch(p)).toEqual({ key: p, action: 'latched' })
        h.script({ spawnError: undefined })
      },
      LATCH_CASE_LEFTOVER,
      () => conflictRow.notice.text,
      PERSONA_EPISODE_KIND_CONFLICT,
    ],
    [
      '"unusable recorded name" at a status read',
      async (h, p) => {
        h.script(pUnusableStatus(p))
        expect(await readPersonaOwnRowStatus(p, SITE)).toEqual({ kind: OWN_ROW_STATUS_LATCHED, rowState: LATCH_ROW_STATE_UNREADABLE })
        expect(h.latch.record(p)).toEqual(unusable.record(p))
      },
      LATCH_CASE_UNUSABLE_RECORDED_NAME,
      (p) => unusable.notice(p),
      PERSONA_EPISODE_KIND_UNUSABLE_RECORDED_NAME,
    ],
  ]

  test.each(FIRST_LATCHES)('P latched first on %s: a status read of P\'s own pending row with no launch start relatches it with "launch start not recorded", ends the first episode, posts SRJ-1020 once and logs the relatched line', async (_label, latchFirst, firstCase, firstPost, firstKind) => {
    const h = makeRecoveryHarness()
    harnesses.push(h)
    const [p, q] = h.keys as [string, string]
    await latchFirst(h, p)
    expect(h.latch.record(p)?.latchCase).toBe(firstCase)
    expect(h.episodes.isOpen(p, firstKind)).toBe(true)

    h.script(pNoLaunchStartStatus(p))
    const from = h.errors.length
    expect(await readPersonaOwnRowStatus(p, SITE)).toEqual({ kind: OWN_ROW_STATUS_LATCHED, rowState: PENDING })

    expect(h.latch.record(p)).toEqual(launchStartRecord(p))
    expect(harnessSetOutcomes(h)).toEqual([[p, CONFLICT_LATCH_SET_LATCHED], [p, CONFLICT_LATCH_SET_RELATCHED]])
    expect([h.episodes.isOpen(p, firstKind), h.episodes.isOpen(p, PERSONA_EPISODE_KIND_LAUNCH_START_NOT_RECORDED)]).toEqual([false, true])
    expect(h.episodeNotices).toEqual([
      { key: p, text: firstPost(p) },
      { key: p, text: launchStartNotRecordedNoticeText(p) },
    ])
    expect(stepLinesSince(h, p, from)).toEqual([
      `${stepHead(p)}: its row read latches the persona (case=${LATCH_CASE_LAUNCH_START_NOT_RECORDED}, state=${AGENT_DIRECTOR_PENDING_STATE}) — the persona relatched; nothing more is called for it (b.jg5 SRJ-115, SRJ-501)`,
    ])
    expect([h.notices, h.latch.isLatched(q)]).toEqual([[], false])
  })

  test('P latched on "launch start not recorded" by a status read: a status read answering UNUSABLE NAME relatches it with "unusable recorded name", ends the launch-start episode, posts SRJ-1019 once and logs the relatched line', async () => {
    const h = makeRecoveryHarness()
    harnesses.push(h)
    const [p, q] = h.keys as [string, string]
    h.script(pNoLaunchStartStatus(p))
    expect(await readPersonaOwnRowStatus(p, SITE)).toEqual({ kind: OWN_ROW_STATUS_LATCHED, rowState: PENDING })
    expect(h.latch.record(p)).toEqual(launchStartRecord(p))
    expect(h.episodes.isOpen(p, PERSONA_EPISODE_KIND_LAUNCH_START_NOT_RECORDED)).toBe(true)

    h.script(pUnusableStatus(p))
    const from = h.errors.length
    expect(await readPersonaOwnRowStatus(p, SITE)).toEqual({ kind: OWN_ROW_STATUS_LATCHED, rowState: LATCH_ROW_STATE_UNREADABLE })

    expect(h.latch.record(p)).toEqual(unusable.record(p))
    expect(harnessSetOutcomes(h)).toEqual([[p, CONFLICT_LATCH_SET_LATCHED], [p, CONFLICT_LATCH_SET_RELATCHED]])
    expect([
      h.episodes.isOpen(p, PERSONA_EPISODE_KIND_LAUNCH_START_NOT_RECORDED),
      h.episodes.isOpen(p, PERSONA_EPISODE_KIND_UNUSABLE_RECORDED_NAME),
    ]).toEqual([false, true])
    expect(h.episodeNotices).toEqual([
      { key: p, text: launchStartNotRecordedNoticeText(p) },
      { key: p, text: unusable.notice(p) },
    ])
    // The answer is rendered by the redacting describer between the head and the outcome.
    const lines = stepLinesSince(h, p, from)
    expect(lines).toHaveLength(1)
    expect(lines[0]!.endsWith(' — UNUSABLE NAME: the persona relatched; nothing more is called for it (b.jg5 SRJ-105, SRJ-512)')).toBe(true)
    expect([h.notices, h.latch.isLatched(q)]).toEqual([[], false])
  })
})

describe('SRJ-513, SRJ-1011: a message lost for P whose row reads pending with no launch start (AC 68, recovery harness)', () => {
  /** A harness (both settings 0) whose `status` answers `script`, with its two personas. */
  function makeLostRun(script: (p: string) => RecoveryStubScript): { h: RecoveryHarness; p: string; q: string } {
    const h = makeRecoveryHarness()
    harnesses.push(h)
    expect([h.config.session_restart_delay, h.config.health_check_interval]).toEqual([0, 0])
    const [p, q] = h.keys as [string, string]
    h.script(script(p))
    return { h, p, q }
  }

  /** No restart was asked for P, none is pending or running, and nothing is counted for it. */
  function expectNoRestartFor(h: RecoveryHarness, p: string): void {
    expect(h.restartAsks.filter((key) => key === p)).toEqual([])
    expect(isRestartPendingOrActive(p)).toBe(false)
    expect(getFailureCount(p)).toBe(0)
  }

  test('with nothing latched, the message\'s one status read latches P and the message reports held for a human at P\'s destination, with no restart; one SRJ-1020 post; Q reports its own state', async () => {
    const { h, p, q } = makeLostRun(pNoLaunchStartStatus)
    const lost = await expectLostMessageReports(h, p, 'held-for-human', { calls: { statusCalls: 1 } })
    const persona = personaOf(h, p)
    expect(posts(h.slack(p)).map((post) => [post.channel, post.text])).toEqual([[persona.permission_prompts, formatPersonaNotice(persona, lost.notice)]])
    expect(h.latch.record(p)).toEqual(launchStartRecord(p))
    expect(h.episodeNotices).toEqual([{ key: p, text: launchStartNotRecordedNoticeText(p) }])
    expectNoRestartFor(h, p)

    await expectLostMessageReports(h, q, 'auto-restart-disabled')
    expect(h.latch.isLatched(q)).toBe(false)
  })

  test('the same lost-message read answering UNUSABLE NAME latches P with "unusable recorded name"; the message reports held for a human, with no restart; one SRJ-1019 post', async () => {
    const row = unusableRow('status', 'empty')
    const { h, p, q } = makeLostRun((key) => ({
      statusFn: (params) => (params.claude_instance_id === personaInstanceId(key) ? errUnusableName('empty') : errSpawnNotFound()),
    }))
    await expectLostMessageReports(h, p, 'held-for-human', { calls: { statusCalls: 1 } })
    expect(h.latch.record(p)).toEqual(row.record(p))
    expect(h.episodeNotices).toEqual([{ key: p, text: row.notice(p) }])
    expectNoRestartFor(h, p)
    expect(h.latch.isLatched(q)).toBe(false)
  })

  test('the same row with a launch start reports the session starting and latches nothing', async () => {
    const { h, p } = makeLostRun((key) => ({
      statusFn: (params) =>
        params.claude_instance_id === personaInstanceId(key) ? cannedStatusResult({ state: AGENT_DIRECTOR_PENDING_STATE }) : errSpawnNotFound(),
    }))
    await expectLostMessageReports(h, p, 'session-starting')
    expect([h.latch.isLatched(p), h.latchEvents, h.episodeNotices]).toEqual([false, [], []])
    expectNoRestartFor(h, p)
  })

  /** Each way P is already latched by an own-row status read before the message: its record, and its post. */
  const ALREADY_LATCHED: ReadonlyArray<readonly [string, (p: string) => RecoveryStubScript, (p: string) => ConflictLatchRecord, (p: string) => string]> = [
    ['on this case', pNoLaunchStartStatus, launchStartRecord, launchStartNotRecordedNoticeText],
    [
      'on "unusable recorded name"',
      () => ({ statusError: errUnusableName('empty') }),
      (p) => unusableRow('status', 'empty').record(p),
      (p) => unusableRow('status', 'empty').notice(p),
    ],
  ]

  test.each(ALREADY_LATCHED)('with P already latched %s, a lost message reports held for a human with no status read and no restart; Q reports its own state', async (_label, latchScript, record, notice) => {
    const { h, p, q } = makeLostRun(latchScript)
    const site: OwnRowReadSite = { site: 'conflict-latch.test', what: 'own-row status read' }
    expect(await readPersonaOwnRowStatus(p, site)).toMatchObject({ kind: OWN_ROW_STATUS_LATCHED })
    expect(h.latch.record(p)).toEqual(record(p))
    h.script({ statusError: undefined, ...pNoLaunchStartStatus(p) })
    const pCalls = personaCallCounts(h, p)

    await expectLostMessageReports(h, p, 'held-for-human')
    expect(personaCallCounts(h, p)).toEqual(pCalls)
    expectNoRestartFor(h, p)
    expect(h.episodeNotices).toEqual([{ key: p, text: notice(p) }])

    await expectLostMessageReports(h, q, 'auto-restart-disabled')
    expect(h.latch.isLatched(q)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// The dialog approver's latches (b.jg5 SRJ-404, SRJ-501, SRJ-502, SRJ-512,
// SRJ-513; SRJ-117 and SRJ-118's approver rows), on the recovery harness
// ---------------------------------------------------------------------------

/** The approver verb of one of its site kinds; throws for any other site, so a case never runs on a wrong row. */
function approverVerbOf(site: string): ApproverVerb {
  if (!isApproverSite(site)) throw new Error(`not an approver site: ${site}`)
  return site.slice('approver '.length) as ApproverVerb
}

/** The calls one approver lap makes up to and including its call at `verb`, by verb (one each). */
function lapCallsThrough(verb: ApproverVerb): Record<string, number> {
  const verbs = APPROVER_SITES.map(approverVerbOf)
  return Object.fromEntries(verbs.slice(0, verbs.indexOf(verb) + 1).map((v) => [APPROVER_VERB_CALLS[v], 1]))
}

/** One answer to the approver that latches P: the verb that meets it, the answer, and what the latch holds and posts for persona `key`. */
interface ApproverLatchCase {
  readonly verb: ApproverVerb
  readonly build: () => Error
  readonly record: (key: string) => ConflictLatchRecord
  readonly notice: (key: string) => string
}

/**
 * Every approver row of the helper's tables: each CONFLICT its `read-pane`
 * and `send-keys` can meet on a `pending` row records P's next check or
 * recovery and `pending` (b.jg5 SRJ-501, typed here from the SRD, not read
 * from the row) beside the row's quoted session and description, as a whole
 * record; each UNUSABLE NAME at its `status`, `read-pane` and `send-keys`
 * holds the row's whole record (refused operation none).
 */
const APPROVER_LATCH_CASES: ReadonlyArray<readonly [string, ApproverLatchCase]> = [
  ...APPROVER_CONFLICT_CASE_ROWS.map((row): readonly [string, ApproverLatchCase] => [
    `CONFLICT at ${row.name}`,
    {
      verb: approverVerbOf(row.site),
      build: row.build,
      record: (key) =>
        expectedLatchRecord(key, {
          sessionName: row.sessionName,
          latchCase: row.latchCase,
          refusedOperation: REFUSED_OPERATION_NEXT_CHECK_OR_RECOVERY,
          rowState: latchRowStateRead(AGENT_DIRECTOR_PENDING_STATE),
          description: row.build().errDescription,
        }),
      notice: () => row.notice.text,
    },
  ]),
  ...APPROVER_UNUSABLE_NAME_CASE_ROWS.map((row): readonly [string, ApproverLatchCase] => [
    `UNUSABLE NAME at ${row.name}`,
    { verb: approverVerbOf(row.site), build: row.build, record: row.record, notice: row.notice },
  ]),
]

/**
 * Every pane shows the folder-trust dialog, and persona `key`'s approver
 * call at `verb` answers `err`: its `status` through the run's row reads, a
 * pane verb by wrapping the stub client's verb, which records the call
 * before it answers.
 */
function approverMeets(run: AutomatedPathsRun, key: string, verb: ApproverVerb, err: Error): void {
  const { h } = run
  h.script({ readPaneResults: [{ pane: TRUST_DIALOG_NEEDLE }] })
  const id = personaInstanceId(key)
  const client = h.stub.client
  if (verb === 'status') {
    run.failStatus(key, err)
  } else if (verb === 'read-pane') {
    const readPane = client.readPane.bind(client)
    client.readPane = async (params) => {
      const result = await readPane(params)
      if (params.claude_instance_id === id) throw err
      return result
    }
  } else {
    const sendKeys = client.sendKeys.bind(client)
    client.sendKeys = async (params) => {
      const result = await sendKeys(params)
      if (params.claude_instance_id === id) throw err
      return result
    }
  }
}

/** The calls of persona `key`'s instance in one stub call list. */
const callsOf = (calls: readonly unknown[], key: string): unknown[] => calls.filter((params) => instanceOf(params) === personaInstanceId(key))

/** The approver's cap in the cases where P latches from another path: past the laps the case drives, so only a stop ends P's approver. */
const OTHER_PATH_CAP_MS = 10 * DIALOG_POLL_INTERVAL_MS

/** The reading site the other paths' own-row reads name. */
const OTHER_PATH_SITE: OwnRowReadSite = { site: 'conflict-latch.test', what: 'another path\'s own-row read' }

/** A plain spawn's CONFLICT whose row state comes from the latch-time `status` read. */
const LADDER_SPAWN_ROW = rowWhere(
  (row) => row.refusedOperation === REFUSED_OPERATION_PLAIN_SPAWN && row.latchCase === LATCH_CASE_LEFTOVER && row.rowState !== LATCH_ROW_STATE_NO_ROW,
)

/** Each other path that latches P while its approver runs, and the case it records. */
const OTHER_LATCH_PATHS: ReadonlyArray<readonly [string, (run: AutomatedPathsRun, p: string) => Promise<void>, LatchCase]> = [
  [
    'an own-row get read of a provenance_conflict note',
    async ({ h }, p) => {
      h.script({ getResult: cannedGetResult({ state: AGENT_DIRECTOR_PENDING_STATE, liveness_note: provenanceNote }, personaOf(h, p), h.home) })
      expect(await readPersonaOwnRow(p, OTHER_PATH_SITE)).toMatchObject({ latched: true })
    },
    LATCH_CASE_CONFLICTING_LABELS,
  ],
  [
    'an own-row status read of its pending row with no launch start',
    async (run, p) => {
      run.readPendingNoLaunchStart(p)
      expect(await readPersonaOwnRowStatus(p, OTHER_PATH_SITE)).toMatchObject({ kind: OWN_ROW_STATUS_LATCHED })
    },
    LATCH_CASE_LAUNCH_START_NOT_RECORDED,
  ],
  [
    'a CONFLICT at a new launch\'s plain spawn',
    async ({ h }, p) => {
      h.script({ spawnError: LADDER_SPAWN_ROW.build() })
      expect(await h.launch(p)).toEqual({ key: p, action: 'latched' })
    },
    LADDER_SPAWN_ROW.latchCase,
  ],
]

/** When the other path latches P: while its approver sleeps between laps, or while its first `read-pane` (showing the dialog) is awaited. */
const LATCH_TIMES = ['between its laps', 'while its read-pane is awaited'] as const

describe('the dialog approver\'s latches: its own CONFLICT or UNUSABLE NAME latches P once, and a latch from any path stops it (recovery harness; SRJ-404, SRJ-501, SRJ-502, SRJ-512, SRJ-513)', () => {
  test.each(APPROVER_LATCH_CASES)('%s: P latches once with its record and one post, its approver stops latched with nothing typed after it, and no automated path calls P while it is latched; Q\'s approver clears its own dialog', async (_name, c) => {
    const run = makeAutomatedPathsRun()
    const { h } = run
    const [p, q] = h.keys as [string, string]
    const raw = recordRawTmux()
    run.readPending(p)
    run.readPending(q)
    approverMeets(run, p, c.verb, c.build())

    expect(await h.launch(p)).toEqual({ key: p, action: 'spawned' })
    expect(await h.launch(q)).toEqual({ key: q, action: 'spawned' })
    await h.settle()

    // P: its lap's calls up to the refused one and none after; one latch through the latch's set entry, one post; nothing armed, counted or noticed.
    expect((await h.runApproverToStop(p))?.reason).toBe(APPROVER_STOP_LATCHED)
    expect(personaCallCounts(h, p)).toEqual({ spawnCalls: 1, ...lapCallsThrough(c.verb) })
    expect(h.latch.record(p)).toEqual(c.record(p))
    expect(latchSteps(h)).toEqual(oneLatch(p))
    expect(h.episodeNotices).toEqual([{ key: p, text: c.notice(p) }])
    expect([h.triggers, h.controller.armedKeys(), getFailureCount(p), h.notices]).toEqual([[], [], 0, []])

    // Q, beside it: its approver pressed Enter on its dialog and ran on until its cap; Q is not latched.
    expect(personaCallCounts(h, q)).toEqual({ spawnCalls: 1, ...lapCallsThrough('send-keys') })
    expect(h.approverRunning(q)).toBe(true)
    expect((await h.runApproverToStop(q))?.reason).toBe(APPROVER_STOP_CAP)
    expect(h.latch.isLatched(q)).toBe(false)

    // While P is latched no automated path calls it, tmux-touching or not; Q's paths reach the stub as before.
    run.readPending(q, false)
    const pAtLatch = personaCallCounts(h, p)
    const touchingAtLatch = tmuxTouchingCallCounts(h.stub.calls)
    const { launched, qCalls, attemptsBefore } = await driveEveryPath(run)
    expect(callCountsSince(personaCallCounts(h, p), pAtLatch)).toEqual({})
    expect(tmuxTouchingCallsIn(h.stub.calls, touchingAtLatch).filter((call) => instanceOf(call.params) === personaInstanceId(p))).toEqual([])
    expect(raw.filter((call) => call.target.includes(personaTmuxSessionName(p)))).toEqual([])
    expect(launched).toEqual([{ key: p, action: 'latched' }, { key: q, action: 'spawned' }])
    expect(h.attempts.slice(attemptsBefore).map((a) => [a.key, a.retry])).toEqual([[p, 1], [q, 1], [q, 2]])
    expect(h.stops.filter((stop) => stop.key === p)).toEqual([{ key: p, reason: UNAVAILABLE_RETRY_STOP_LATCHED }])
    expect(qCalls).toEqual([...Q_CALLS_ON_EVERY_PATH])
    // Still the one latch and the one post.
    expect(latchSteps(h)).toEqual(oneLatch(p))
    expect(h.episodeNotices).toEqual([{ key: p, text: c.notice(p) }])
    expect([getFailureCount(p), h.clock.pendingCount()]).toEqual([0, 0])
  })

  test.each(OTHER_LATCH_PATHS.flatMap(([name, latchP, latchCase]) => LATCH_TIMES.map((when) => [name, when, latchP, latchCase] as const)))('P latched by %s %s: its running approver stops latched and makes no further call, so no Enter reaches P after the latch; one post; Q\'s approver runs on and keeps clearing its dialog', async (_name, when, latchP, latchCase) => {
    const run = makeAutomatedPathsRun({ approverCapMs: OTHER_PATH_CAP_MS })
    const { h } = run
    const [p, q] = h.keys as [string, string]
    run.readPending(p)
    run.readPending(q)
    h.script({ readPaneResults: [{ pane: TRUST_DIALOG_NEEDLE }] })
    let pAtLatch: Record<string, number> | undefined
    const latchNow = async (): Promise<void> => {
      await latchP(run, p)
      pAtLatch = personaCallCounts(h, p)
    }
    if (when === 'while its read-pane is awaited') {
      // P's first pane read is made and shows the dialog; P latches before the approver gets its answer.
      const client = h.stub.client
      const readPane = client.readPane.bind(client)
      client.readPane = async (params) => {
        const result = await readPane(params)
        if (params.claude_instance_id === personaInstanceId(p) && pAtLatch === undefined) await latchNow()
        return result
      }
    }

    expect(await h.launch(p)).toEqual({ key: p, action: 'spawned' })
    expect(await h.launch(q)).toEqual({ key: q, action: 'spawned' })
    await h.settle()
    if (when === 'between its laps') {
      // P's first lap pressed Enter, and its approver sleeps until its next lap.
      expect(h.approverRunning(p)).toBe(true)
      await latchNow()
    }
    await h.settle()

    // Stopped by the latch, not by its cap: no longer running before the clock moves.
    expect(h.approverRunning(p)).toBe(false)
    expect((await h.runApproverToStop(p))?.reason).toBe(APPROVER_STOP_LATCHED)
    expect(callsOf(h.stub.calls.sendKeysCalls, p)).toHaveLength(when === 'between its laps' ? 1 : 0)
    expect(h.latch.record(p)?.latchCase).toBe(latchCase)
    expect(latchSteps(h)).toEqual(oneLatch(p))
    expect(h.episodeNotices.map((notice) => notice.key)).toEqual([p])

    // Three laps of Q later: no call for P, and Q, unlatched, pressed Enter at each.
    expect(h.approverRunning(q)).toBe(true)
    const qEnters = callsOf(h.stub.calls.sendKeysCalls, q).length
    await h.advance(3 * DIALOG_POLL_INTERVAL_MS)
    expect(callCountsSince(personaCallCounts(h, p), pAtLatch!)).toEqual({})
    expect(callsOf(h.stub.calls.sendKeysCalls, q)).toHaveLength(qEnters + 3)
    expect([h.latch.isLatched(q), h.approverRunning(q)]).toEqual([false, true])
    expect(h.episodeNotices.map((notice) => notice.key)).toEqual([p])
    expect((await h.runApproverToStop(q))?.reason).toBe(APPROVER_STOP_CAP)
    expect(h.clock.pendingCount()).toBe(0)
  })
})
