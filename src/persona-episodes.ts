/**
 * persona-episodes.ts — The once-per-episode latch of every per-persona
 * notice kind b.jg5 adds (b.jg5 SRJ-1016).
 *
 * An episode is the span in which one notice kind posts at most once for one
 * persona. Each persona key has at most one open episode per kind, and every
 * (key, kind) pair is independent: two personas' episodes of one kind, and
 * two kinds of one persona, never share a latch. What begins and ends an
 * episode is decided by the kind's poster (SRJ-1016's table); this module
 * only keeps the latch:
 *
 * - `begin(key, kind, caseLabel?)` opens an episode, recording its start time
 *   from the clock. While one is open it is kept, unless a case is given
 *   that differs from the open episode's: then a new episode begins, with a
 *   new start time and nothing posted in it yet (CONFLICT: a retry refused
 *   with a new case begins a new episode; the same case keeps it, SRJ-506).
 *   No case given keeps the open episode.
 * - `post(key, kind, text, mark?)` hands `text` to the notice sink at most
 *   once per mark in the open episode, and never when none is open. A kind
 *   with one text uses the default mark; a kind with two texts (stuck
 *   launch) gives each its own mark, so each posts at most once.
 * - `postWithoutEpisode(key, kind, text, options?)` hands `text` to the
 *   notice sink with no episode read or changed (the kill-failure alert's
 *   survivor version, posted once per bounded retry, and any kill-failure
 *   alert raised during a persona teardown); never after `close`.
 * - `end(key, kind)` ends the open episode silently: a later `begin` opens a
 *   new one, whose post is made again.
 * - `forget(key)` ends every kind's episode of one persona silently (its
 *   teardown); `forgetAll()` ends every episode and leaves the instance open
 *   (the module's one test reset, with no production caller); `close()`, the
 *   server's shutdown, ends every episode and refuses every later `begin`
 *   (it answers `closed`), so a launch still running after it opens nothing.
 *   None posts anything.
 * - `whenClosed(key, kind, dispose)` runs `dispose` once when the open
 *   episode closes, by any of the above or a new case: a poster's timer for
 *   the episode (the `tmux-unresponsive` alert check) is cancelled with it.
 * - `openKeys(kind)` lists the keys with an open episode of the kind; `clock`
 *   is the clock the start times come from.
 * - `teardownWindowState(key)` reads the injected teardown query (b.jg5
 *   SRJ-1003; production: the persona notifier's `teardownWindowState`).
 *
 * A persona teardown (b.jg5 SRJ-1002, SRJ-1003). From the teardown's submit
 * until its serializer turn opens its window (`submitted`), a post or a
 * `postWithoutEpisode` for the key reaches no sink: one line says it was not
 * posted, and a post still counts as posted in its episode, so an old half's
 * `tmux-unresponsive` onset, alert or recovery never reaches the new half's
 * destination. While the window is open (`open`) every post is handed to the
 * sink, whose window (the persona notifier's) writes it as a server-log line
 * and a `persona-teardown-notice` startup-errors entry and posts nothing; the
 * log-only routes below take that route too, in place of their own classes:
 * the unclassified-error alert for a key no longer applied, and every
 * kill-failure alert for the key (its route chosen with the context `persona
 * teardown`, SRJ-704's first match, so the survivor version's entry is
 * `persona-kill-survivor`). A kill-failure decision whose tries were stopped
 * (SRJ-702) is no notice: it is decided before the window, and writes no
 * `persona-teardown-notice` entry. The muted post's line (each poster's own
 * line then says its notice was not posted, not that it was):
 *
 *   [slack] persona-episodes: persona=<key> <kind> notice not posted — its persona teardown was submitted (b.jg5 SRJ-1003)
 * - `count(key, kind)`, `addCount(key, kind)` and `resetCount(key, kind)`
 *   keep a per-persona, per-kind count of consecutive observations, for a
 *   kind whose post waits for a run of them (the slow dead-session recovery
 *   kind: consecutive escalate-dead verdicts whose re-probe still reads the
 *   row live, b.jg5 SRJ-610). The count runs before the episode begins (the
 *   episode begins at its post), so it is kept apart from the open episode:
 *   beginning, posting in or ending an episode leaves it as it is, and only
 *   its poster adds to it or resets it. `forget(key)` clears the persona's
 *   counts of every kind with its episodes, and `forgetAll()` and `close()`
 *   clear every count; none posts anything.
 *
 * Kinds and their posters. One label per row of SRJ-1016's table
 * (`PERSONA_EPISODE_KINDS`). `tmux-unresponsive`'s episode is begun and
 * ended by its condition (below), which posts its onset, alert and recovery;
 * `unclassified-error`'s by its episodes (below), which post its one alert;
 * CONFLICT's, `unusable-recorded-name`'s and `launch-start-not-recorded`'s
 * are begun by the conflict latch's one notice reaction
 * (`src/conflict-latch.ts`), which posts each kind's one notice per episode
 * (the CONFLICT notice, SRJ-1019 and SRJ-1020) and, when it begins one, ends
 * the persona's open episodes of the other latch kinds silently;
 * `slow-dead-session-recovery`'s by the slow-recovery tracker
 * (`createSlowRecoveryTracker`, `src/slow-recovery.ts`), which keeps its
 * count here and posts SRJ-1010 once per episode; `kill-failure`'s by the
 * kill-failure alerts (below), which post the ordinary version once per
 * episode and the survivor version with no episode; `invalid-flags-hold`'s
 * by the `ErrInvalidFlags` hold's reactions (`src/invalid-flags-hold.ts`),
 * which post SRJ-1008's alert once per episode; `stuck-launch`'s by the
 * stuck-launch posters (`src/pending-row.ts`), which post each of SRJ-1017's
 * two texts once per episode; `ad-config-malformed` posts nothing here (its
 * outage flag is its latch).
 *
 * The `tmux-unresponsive` condition (b.jg5 SRJ-307 to SRJ-310, SRJ-1006).
 * `createTmuxUnresponsiveCondition(deps)` builds it over one episodes
 * instance: the condition holds for a persona while its `tmux-unresponsive`
 * episode is open, and the episode's start time is the first refusal's time.
 * It is a per-persona condition, not an outage class: it never raises or
 * clears an outage flag, records no bad-stretch history, never touches the
 * retry timer or the restart cap, and its only posts are its three notices
 * (no generic outage onset or all-clear), each at most once per episode:
 *
 * - `start(key, verb, error)` starts the condition (opens the episode, the
 *   first refusal's time from the episodes' clock, one started line, and
 *   the alert check armed) or continues it (the first refusal's time kept,
 *   no line, the onset allowed again when a non-terminal retry-timer stop
 *   held it back, and the alert check armed again when a retry-timer stop
 *   cancelled it; see the onset and the alert below). After the episodes'
 *   `close` it does nothing. Its only caller
 *   is the outage state's reporting point (`src/outage-state.ts`), for a
 *   tmux-touching call's UNAVAILABLE inside a launch or recovery attempt for
 *   the persona; it never throws there.
 * - `holds(key)` and `firstRefusalAt(key)` read it.
 * - The onset (SRJ-308): `onsetAtTick(tickStartedAt)`, called once per
 *   health-tick body after all of the tick's per-persona work, posts it
 *   while the health check is on for every condition still holding whose
 *   first refusal precedes the tick's start (a persona the tick skipped
 *   included; one the tick found healthy has already ended its condition, so
 *   gets none); `onsetAtRetry(key, firedAt)`,
 *   called at every fire of the persona's retry timer (a fire whose retry is
 *   skipped for work in flight included), posts it while the health check
 *   is off, at the first fire `TMUX_UNRESPONSIVE_ONSET_FLOOR_MS` or more
 *   after the first refusal. The mode is read from the injected accessor
 *   (the configuration in effect) at each check. Once the episode's alert
 *   has posted, neither posts the onset in it (one `onset not posted` line
 *   per episode instead): the alert has said more. The onset says CSCB is
 *   retrying, so neither posts it either while the persona's retry timer is
 *   stopped (SRJ-305): every stop reported to `cancelAlert(key, stopReason)`
 *   while the condition holds, whatever its reason and whether or not an
 *   alert check was pending, marks the episode stopped (one `onset not
 *   posted` line per episode while the mark holds the onset back; the
 *   alert-held line takes precedence once the alert has posted). A later
 *   refusal in the episode (`start` continuing it, whose reporting point has
 *   just armed the timer again) clears the mark, so the onset may post again
 *   on the usual terms; a terminal stop's mark
 *   (`UNAVAILABLE_RETRY_TERMINAL_STOPS`: torn down, not in the applied
 *   configuration, server shutdown) is never cleared in its episode, so no
 *   onset posts in it after such a stop. Only a refusal clears the mark: an
 *   arm of the timer that is not a refusal (the health tick's
 *   `armMissingRetryTimer`, `src/health-check.ts`, or an arm for an
 *   ENVIRONMENT answer) clears nothing, and the
 *   condition never reads whether the timer is armed. The episode's close
 *   drops the mark, so a new episode starts with none.
 * - The alert (SRJ-309): one check per episode, armed at the first refusal
 *   on the episodes' clock with the never-early wait (`armNeverEarlyWait`,
 *   `src/ad-settings.ts`) over the injected threshold accessor (the
 *   threshold in effect, read at every fire). It posts once the condition
 *   has lasted strictly longer than the threshold in effect, the minutes
 *   rendered by `wholeMinutes`. It needs no onset. The episode's end, a new
 *   episode, `forget`, `forgetAll` and `close` cancel it; a check armed for
 *   an earlier episode never posts in a later one (the episode number of
 *   `view`). Its text says CSCB keeps retrying, so it runs only while the
 *   persona's retry timer does: `cancelAlert(key, stopReason)`, bound in
 *   `main()` to every stop of the retry timer
 *   (`UnavailableRetryDeps.onStopped`, `src/unavailable-retry.ts`), records
 *   the stop for the onset (above) and cancels a check not yet posted while
 *   the condition holds, with one line naming the stop's reason (an alert
 *   already posted stays posted). A later
 *   refusal in the same episode, which arms the timer again at the reporting
 *   point before it continues the condition, arms the check again from the
 *   episode's first refusal (one line), so it posts at once when the
 *   condition has already lasted longer than the threshold. A stop for a
 *   terminal reason (`UNAVAILABLE_RETRY_TERMINAL_STOPS`: torn down, not in
 *   the applied configuration, server shutdown) never arms it again, nor
 *   lets a later refusal in the episode arm it again, even when an earlier
 *   non-terminal stop had already cancelled it (the terminal stop withdraws
 *   that re-arm).
 * - `end(key, reason, reading?, options?)` ends a holding condition once:
 *   the recovery (SRJ-310) is posted when the episode's onset or alert was,
 *   unless `options.silent` (a CONFLICT answer ends it; its notice follows:
 *   `main()`'s latch hold ends it so, with `TMUX_UNRESPONSIVE_END_LATCHED`);
 *   the episode ends, which cancels the alert check; one ended line names
 *   the reason; and the injected condition-end hook is called once with the
 *   reading the end brings (a tick's or a retry's live reading; the live
 *   state this launch's row was read in, for SRJ-310's rule 3 after a launch
 *   timeout, `TMUX_UNRESPONSIVE_END_LAUNCH_ROW_LIVE`; `pending` for a
 *   successful `spawn` or `resume`; none for any other tmux-touching success
 *   or GONE). It answers whether either notice had been posted
 *   (`ended-after-notice`). On a persona that does not hold it, it does
 *   nothing.
 * - The episodes' `forget(key)` (a teardown), `forgetAll()` and `close()`
 *   drop a holding condition silently, with no post, no line and no hook
 *   call.
 *
 * Texts (SRJ-1006; `<session>` the persona's quoted session name,
 * `"slack_bot_<key>"`, SRJ-1001, from the one shared helper
 * `quotedPersonaSessionName`, `src/persona-identity.ts`): `tmuxUnresponsiveOnsetText`,
 * `tmuxUnresponsiveAlertText` and `tmuxUnresponsiveRecoveryText`.
 *
 * Log lines, to the injected log (a throwing log is swallowed):
 *
 *   [slack] persona-episodes: persona=<key> tmux-unresponsive started — <verb> failed: <describeAgentDirectorFailure(error)>
 *   [slack] persona-episodes: persona=<key> tmux-unresponsive onset posted — still not answering at <a health tick|a retry>, <s> s after its first refusal
 *   [slack] persona-episodes: persona=<key> tmux-unresponsive onset not posted — its alert already posted
 *   [slack] persona-episodes: persona=<key> tmux-unresponsive onset not posted — its retry timer stopped and no refusal has re-armed it
 *   [slack] persona-episodes: persona=<key> tmux-unresponsive alert posted — not answering for <s> s, over its alert threshold of <s> s
 *   [slack] persona-episodes: persona=<key> tmux-unresponsive alert check cancelled — its retry timer stopped: <stop reason>
 *   [slack] persona-episodes: persona=<key> tmux-unresponsive alert check armed again — a new refusal armed its retry timer again
 *   [slack] persona-episodes: persona=<key> tmux-unresponsive ended — <reason text>
 *   [slack] persona-episodes: persona=<key> tmux-unresponsive recovery posted
 *   [slack] persona-episodes: persona=<key> tmux-unresponsive recovery not posted — a silent end (a CONFLICT answer ended it)
 *
 * When the key's persona teardown was submitted and its window is not open
 * yet (b.jg5 SRJ-1003), the onset, the alert and the recovery reach no sink
 * but still count as posted in their episode; their lines say so in place of
 * the posted ones:
 *
 *   [slack] persona-episodes: persona=<key> tmux-unresponsive onset not posted — muted, its persona teardown was submitted; it counts as posted in its episode; still not answering at <a health tick|a retry>, <s> s after its first refusal
 *   [slack] persona-episodes: persona=<key> tmux-unresponsive alert not posted — muted, its persona teardown was submitted; it counts as posted in its episode; not answering for <s> s, over its alert threshold of <s> s
 *   [slack] persona-episodes: persona=<key> tmux-unresponsive recovery not posted — muted, its persona teardown was submitted
 *
 * and, only on a failure: `alert check not armed: <error>`, `alert check
 * failed: <error>`, `onset check at a retry failed: <error>`, `alert check
 * cancel failed: <error>` (each after `persona=<key> tmux-unresponsive`),
 * `[slack] persona-episodes: tmux-unresponsive onset check at a health tick
 * failed: <error>` and `[slack] persona-episodes: tmux-unresponsive
 * health-check mode read failed: <error> — taken as on`.
 *
 * The unclassified-error episodes (b.jg5 SRJ-313, SRJ-1009).
 * `createUnclassifiedErrorEpisodes(deps)` builds them over one episodes
 * instance: a persona's episode is its open `unclassified-error` episode, and
 * the episode's start time is its first outcome's time. They post nothing but
 * the one alert per episode, set no timer and touch no outage flag, retry
 * timer or restart counter:
 *
 * - `report(key, error, classification?)` is the outage state's unclassified
 *   sink (`OutageStateDeps.unclassifiedSink`, `src/outage-state.ts`), called
 *   once for each UNCLASSIFIED outcome in a launch or recovery attempt for
 *   the persona, a row read's included (its only caller; a site that
 *   classifies an outcome itself passes its classification through the
 *   outage state's site entry). With no open episode it begins one. In an
 *   open episode whose alert has not been posted, when the time since its
 *   first outcome, on the episodes' clock, is strictly longer than the alert
 *   threshold in effect now (the injected accessor, read at each check), the
 *   alert is posted once, quoting this outcome. No timer: an outcome met past
 *   the threshold posts it, and none posts it otherwise.
 * - The alert's route is decided when it is posted: while the persona's
 *   teardown window is open (b.jg5 SRJ-1003) it goes, unescaped, through the
 *   episodes' sink, whose window writes it as a `persona-teardown-notice`
 *   entry and posts nothing, whether the persona is configured or not;
 *   otherwise a persona in the applied configuration (the injected lookup)
 *   gets it through the episodes' sink (its destination); any other persona
 *   gets it through the injected log-only route (in production
 *   `recordStartupError` with `PERSONA_UNCLASSIFIED_ERROR_LABEL`, the key and
 *   the unescaped text), and nothing reaches Slack. Either way it counts as
 *   posted.
 * - `end(key, reason)` ends the episode silently: `retryStopped(key, stop)`,
 *   bound in `main()` to every stop of the retry timer, ends it for the stops
 *   that mean the retries are over because the persona's state got better:
 *   `UNAVAILABLE_RETRY_STOP_RECOVERED` (`UNCLASSIFIED_ERROR_END_RECOVERED`),
 *   `UNAVAILABLE_RETRY_STOP_ROW_LIVE` (`UNCLASSIFIED_ERROR_END_ROW_LIVE`: a
 *   pending-only retry read the row live out of `pending`, so a launch the
 *   retries made succeeded and no retry follows),
 *   `UNAVAILABLE_RETRY_STOP_TMUX_UNAVAILABLE_CLEARED` and
 *   `UNAVAILABLE_RETRY_STOP_TMUX_UNRESPONSIVE_ENDED`
 *   (`UNCLASSIFIED_ERROR_END_CONDITION_ENDED`: the timer's tmux condition
 *   ended and no retry follows) and `UNAVAILABLE_RETRY_STOP_ROW_GONE`
 *   (`UNCLASSIFIED_ERROR_END_ROW_GONE`: a pending-only retry read the row
 *   ended or missing, or found none, and handed the persona to the restart
 *   path's decision). Every other stop (not up, not applied, launch skipped,
 *   run failed and the rest) leaves it open: `main()` ends it at the restart
 *   cap and when the persona latches (`UNCLASSIFIED_ERROR_END_LATCHED`), and
 *   a teardown or shutdown drops it through `forget` or `close`.
 *   A later report begins a new episode, whose alert is posted again. The
 *   episodes' `forget(key)` (a teardown), `forgetAll()` and `close()` drop it
 *   silently with nothing left pending.
 *
 * Text (SRJ-1009): `unclassifiedErrorAlertText`, from the classifier's
 * reported name (left out when absent) and rendered message, the message
 * escaped for Slack (`escapeSlackControlCharacters`) after its redaction and
 * cap; the log-only route and every log line carry it unescaped.
 *
 * Log lines, to the injected log (a throwing log is swallowed):
 *
 *   [slack] persona-episodes: persona=<key> unclassified-error started — <describeAdErrorClassification>
 *   [slack] persona-episodes: persona=<key> unclassified-error alert posted to its destination — <met>
 *   [slack] persona-episodes: persona=<key> unclassified-error alert not posted to its destination — muted, its persona teardown was submitted; it counts as posted in its episode; <met>
 *   [slack] persona-episodes: persona=<key> unclassified-error alert written to the server log and startup-errors.log (persona-unclassified-error) — the persona is not in the applied configuration; <met>
 *   [slack] persona-episodes: persona=<key> unclassified-error alert written to the server log and startup-errors.log (persona-teardown-notice) — raised during its persona teardown; <met>
 *   [slack] persona-episodes: persona=<key> unclassified-error ended — <reason>
 *
 * where `<met>` is `an UNCLASSIFIED outcome met <s> s after the episode's
 * first, over its alert threshold of <s> s: <describeAdErrorClassification>`;
 * and, only on a failure or a missing route: `report failed: <error>`,
 * `configured-key lookup failed: <error> — the alert takes the log-only
 * route`, `log-only alert failed: <error>` (in place of the written line) and
 * `alert not routed — …` (each after `persona=<key> unclassified-error`). The
 * written line is logged only after the log-only route returns.
 *
 * b.f2b's not-connected reasons keep their one shared latch
 * (`notConnectedNoticeRaised` in `src/session-manager.ts`), which this module
 * neither reads nor writes. `src/persona-slack-episodes.ts` is a different
 * concern: it logs the start and end of a persona's Slack validation and
 * connection outcomes to the server log, one tracker per persona, and posts
 * nothing; this module latches notices posted to a persona's destination.
 *
 * The notice sink is the persona notifier's post in production (`main()` in
 * `src/server.ts`), which adds the persona prefix and holds a notice until
 * the persona's client is validated; while the key's teardown window is open
 * it writes the notice instead (the sink's options carry the survivor
 * version's class). A sink that throws or rejects is logged
 * through the injected log, with the text counted as posted; so is a
 * `whenClosed` disposer that throws (`episode close step failed`). The clock is
 * injected in `PersonaConnectionClock`'s shape (`now`, `setTimeout`,
 * `clearTimeout`; the shared fake clock satisfies it), the real clock by
 * default. No agent-director call, no Slack client and no module-scope
 * state: each instance keeps its own episodes, and nothing is read, posted or
 * logged at import or at creation.
 *
 * SPDX-License-Identifier: MIT
 */

import {
  classifyAdError,
  describeAdErrorClassification,
  describeAgentDirectorFailure,
  type AdErrorClassification,
  type AdVerb,
} from './ad-error-class.ts'
import { armNeverEarlyWait, wholeMinutes } from './ad-settings.ts'
import {
  KILL_FAILURE_CONTEXT_CLI_TEARDOWN,
  KILL_FAILURE_CONTEXT_PERSONA_TEARDOWN,
  KILL_FAILURE_CONTEXT_START_SWEEP,
  KILL_FAILURE_VERSION_ORDINARY,
  PERSONA_KILL_FAILED_LABEL,
  PERSONA_KILL_SURVIVOR_LABEL,
  describeKillFailureDescriptions,
  killFailureAlertContentOf,
  killFailureAlertEntryText,
  killFailureAlertText,
  selectKillFailureAlertRoute,
  type KillFailureAlertContent,
  type KillFailureAlertContext,
} from './kill-failure-alert.ts'
import type { KillRetryAlert } from './kill-retry.ts'
import { describeThrownValue, isSafeIdentifier } from './persona-connection-errors.ts'
import { SYSTEM_PERSONA_CONNECTION_CLOCK, type PersonaConnectionClock } from './persona-connections.ts'
import { personaInstanceId, personaTmuxSessionName, quotedPersonaSessionName } from './persona-identity.ts'
import {
  PERSONA_TEARDOWN_NOTICE_LABEL,
  personaTeardownNoticeEntryText,
  type PersonaNoticeOptions,
  type PersonaTeardownWindowState,
} from './persona-notifier.ts'
import { escapeSlackControlCharacters } from './slack-text-escape.ts'
import {
  UNAVAILABLE_RETRY_STOP_RECOVERED,
  UNAVAILABLE_RETRY_STOP_ROW_GONE,
  UNAVAILABLE_RETRY_STOP_ROW_LIVE,
  UNAVAILABLE_RETRY_STOP_TMUX_UNAVAILABLE_CLEARED,
  UNAVAILABLE_RETRY_STOP_TMUX_UNRESPONSIVE_ENDED,
  UNAVAILABLE_RETRY_TERMINAL_STOPS,
} from './unavailable-retry.ts'

/**
 * Why a poster's post reached no sink: the key's persona teardown was
 * submitted and its window is not open yet (b.jg5 SRJ-1003). The post still
 * counts as posted in its episode; the poster's line says it was not posted.
 * Exported for the posters outside this module (`src/slow-recovery.ts`).
 */
export const MUTED_BY_TEARDOWN = 'muted, its persona teardown was submitted'

// ---------------------------------------------------------------------------
// Kinds (b.jg5 SRJ-1016)
// ---------------------------------------------------------------------------

/**
 * CONFLICT (SRJ-506, SRJ-508): from the latch being set until it clears; a
 * new case begins a new episode. Posted by the conflict latch's notice
 * reaction (`createConflictNoticeObserver`, bound in `main()` by
 * `bindConflictNotice`, `src/conflict-latch.ts`): a latch or a relatch with a
 * new case begins the episode with its case and posts the CONFLICT notice
 * once; the same case keeps it and posts nothing; a latch of a hold case ends
 * it silently. The latch's clear (`createLatchClear`) posts the recovery
 * notice in it once and ends it.
 */
export const PERSONA_EPISODE_KIND_CONFLICT = 'conflict'

/**
 * Unusable recorded name (SRJ-512, SRJ-1019): from the latch being set until
 * it clears. Posted by the conflict latch's notice reaction
 * (`createConflictNoticeObserver`, bound in `main()` by `bindConflictNotice`,
 * `src/conflict-latch.ts`): a latch, or a relatch from another case, begins
 * the episode and posts SRJ-1019 once; a latch of another kind ends it
 * silently. The latch's clear (`createLatchClear`) posts the recovery notice
 * in it once and ends it.
 */
export const PERSONA_EPISODE_KIND_UNUSABLE_RECORDED_NAME = 'unusable-recorded-name'

/**
 * Launch start not recorded (SRJ-513, SRJ-1020): from the latch being set
 * until it clears. Posted by the conflict latch's notice reaction
 * (`createConflictNoticeObserver`, `src/conflict-latch.ts`): a latch, or a
 * relatch from another case, begins the episode and posts SRJ-1020 once; a
 * latch of another kind ends it silently. The latch's clear
 * (`createLatchClear`) posts the recovery notice in it once and ends it.
 */
export const PERSONA_EPISODE_KIND_LAUNCH_START_NOT_RECORDED = 'launch-start-not-recorded'

/**
 * Kill failure (SRJ-704, SRJ-1016): from its ordinary version's alert until
 * the row reads `ended` or `missing`, or is gone (`ErrSpawnNotFound`), or the
 * persona is torn down. A later kill that succeeds while the row stays live
 * does not end it. Posted by the kill-failure alerts
 * (`createKillFailureAlerts`, below): the ordinary version at a configured
 * persona's destination begins it and posts once in it; the survivor version
 * opens no episode, is posted once per bounded retry and is not held back by
 * an open one. The session manager's own-row reads end it
 * (`src/session-manager.ts`); a teardown's `forget` and shutdown's `close`
 * drop it.
 */
export const PERSONA_EPISODE_KIND_KILL_FAILURE = 'kill-failure'

/** `tmux-unresponsive` (SRJ-307 to SRJ-310): from the first refusal until the condition ends. Posted by its condition (below). */
export const PERSONA_EPISODE_KIND_TMUX_UNRESPONSIVE = 'tmux-unresponsive'

/**
 * `ad-config-malformed` (SRJ-316, SRJ-1016): as the `ad-unreachable` outage's
 * episode. Its once-per-episode latch is the `ad-config-malformed` outage
 * flag in `src/outage-state.ts` (raised by `raiseAdConfigMalformed`, which
 * posts its one onset), so this kind never posts and opens no episode here.
 */
export const PERSONA_EPISODE_KIND_AD_CONFIG_MALFORMED = 'ad-config-malformed'

/**
 * `ErrInvalidFlags` hold (SRJ-207, SRJ-1008): from the hold being set until
 * a re-check finds a different binary version, the persona is torn down or
 * the server restarts. Posted by the hold's set reaction
 * (`createInvalidFlagsHoldSetReaction`, bound in `main()`,
 * `src/invalid-flags-hold.ts`): a new hold begins the episode and posts
 * SRJ-1008's alert once in it. The version-change reaction ends it silently
 * (`endInvalidFlagsHoldsOnVersionChange`); a teardown's `forget` and
 * shutdown's `close` drop it.
 */
export const PERSONA_EPISODE_KIND_INVALID_FLAGS_HOLD = 'invalid-flags-hold'

/**
 * Unclassified error (SRJ-313): from the first UNCLASSIFIED outcome in a
 * launch or recovery attempt until a retry finds nothing left to recover or,
 * pending-only, reads the row live out of `pending`, the persona reaches the
 * restart cap or is torn down. Posted by its episodes
 * (`createUnclassifiedErrorEpisodes`, below); a latch's end is E13's.
 */
export const PERSONA_EPISODE_KIND_UNCLASSIFIED_ERROR = 'unclassified-error'

/**
 * Slow dead-session recovery (SRJ-610, SRJ-1010): from its post until the row
 * reads `ended` or `missing` or is gone (`ErrSpawnNotFound`), the persona
 * latches, or it is torn down. Posted by the slow-recovery tracker
 * (`createSlowRecoveryTracker`, `src/slow-recovery.ts`): its count of
 * consecutive escalate-dead verdicts whose re-probe still reads the row live
 * is this kind's count here (`addCount`, `resetCount`), and the third begins
 * the episode and posts SRJ-1010 once. The tracker ends it on a row read of
 * `ended` or `missing` or no row, and at the latch (`main()`'s latch hold);
 * a teardown's `forget` and shutdown's `close` drop it and its count.
 */
export const PERSONA_EPISODE_KIND_SLOW_DEAD_SESSION_RECOVERY = 'slow-dead-session-recovery'

/**
 * Stuck launch (SRJ-410, SRJ-1016, SRJ-1017): from its first post until the
 * row reaches a live state out of `pending` (`waiting`, `working`,
 * `ask_user` or `check_permission`), the persona latches, or it is torn
 * down; a read of `pending`, `ended`, `missing` or no row does not end it.
 * Each of its two texts posts at most once (one mark each), and a relaunch
 * after CSCB's abort keeps the episode. Posted by the stuck-launch posters
 * (`postStuckLaunchRelaunching`, `postStuckLaunchHeld`, `src/pending-row.ts`):
 * a post begins or keeps the episode, and neither posts or begins one while
 * the persona's `tmux-unavailable` outage is raised. The session manager's
 * shared own-row reads end it on a live state out of `pending`
 * (`src/session-manager.ts`), and the latch's hold observer ends it
 * (`endStuckLaunchEpisodeForLatch`, bound in `main()`); both end it
 * silently. A teardown needs no step of its own: its `forget` drops the
 * episode, as shutdown's `close` does.
 */
export const PERSONA_EPISODE_KIND_STUCK_LAUNCH = 'stuck-launch'

/** Every notice kind with a latch here, one per row of SRJ-1016's table. */
export const PERSONA_EPISODE_KINDS = [
  PERSONA_EPISODE_KIND_CONFLICT,
  PERSONA_EPISODE_KIND_UNUSABLE_RECORDED_NAME,
  PERSONA_EPISODE_KIND_LAUNCH_START_NOT_RECORDED,
  PERSONA_EPISODE_KIND_KILL_FAILURE,
  PERSONA_EPISODE_KIND_TMUX_UNRESPONSIVE,
  PERSONA_EPISODE_KIND_AD_CONFIG_MALFORMED,
  PERSONA_EPISODE_KIND_INVALID_FLAGS_HOLD,
  PERSONA_EPISODE_KIND_UNCLASSIFIED_ERROR,
  PERSONA_EPISODE_KIND_SLOW_DEAD_SESSION_RECOVERY,
  PERSONA_EPISODE_KIND_STUCK_LAUNCH,
] as const

/** A notice kind with a latch here. */
export type PersonaEpisodeKind = (typeof PERSONA_EPISODE_KINDS)[number]

/** The mark a post uses when none is given: a kind with one text posts it at most once per episode. */
export const PERSONA_EPISODE_DEFAULT_MARK = 'notice'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** The clock and timers an instance uses (the shared fake clock satisfies it in tests). */
export type PersonaEpisodesClock = PersonaConnectionClock

/**
 * A notice's options for the sink: the kill-failure alert's survivor version
 * raised during a persona teardown carries its entry's class
 * (`persona-kill-survivor`, b.jg5 SRJ-1003, SRJ-1013).
 */
export type PersonaEpisodeSinkOptions = Pick<PersonaNoticeOptions, 'teardownEntryClass'>

/**
 * Receives each notice to post: the persona key, the notice body and its
 * options when it has any (production: the persona notifier's post).
 */
export type PersonaEpisodeSink = (key: string, text: string, options?: PersonaEpisodeSinkOptions) => void | Promise<void>

/** Dependencies of `createPersonaEpisodes`. */
export interface PersonaEpisodesDeps {
  /** Receives each notice a post makes. */
  sink: PersonaEpisodeSink
  /**
   * Receives each `[slack]` line (the server log): a sink or a close step
   * that throws or rejects, and a post not made because the key's persona
   * teardown was submitted. A throwing log is swallowed.
   */
  log: (line: string) => void
  /** Clock and timers; `SYSTEM_PERSONA_CONNECTION_CLOCK` by default. */
  clock?: PersonaEpisodesClock
  /**
   * Where the key stands with its persona teardown (b.jg5 SRJ-1003;
   * production: the persona notifier's `teardownWindowState`): `submitted`
   * mutes the key's posts, `open` routes the log-only routes through the sink
   * (see the module comment). Absent, or a throw: `none` (a throw is logged).
   */
  teardownWindow?: (key: string) => PersonaTeardownWindowState
}

/**
 * What `begin` did: opened an episode where none was open, kept the open one,
 * began a new one for a new case, or nothing because the instance is closed.
 */
export type PersonaEpisodeBeginResult = 'begun' | 'kept' | 'new-case' | 'closed'

/** A read-only view of one persona's open episode of one kind. */
export interface PersonaEpisodeView {
  /** Which episode this is for the instance, from 1: a new episode, of any key or kind, has a new number. */
  readonly episode: number
  /** When the episode began, in clock milliseconds. */
  readonly startedAt: number
  /** The case it began with, when one was given. */
  readonly caseLabel?: string
  /** The marks posted in it, in the order posted. */
  readonly posted: readonly string[]
}

/** The latches of one server. */
export interface PersonaEpisodes {
  /** The clock the episodes' start times come from; a poster's timers for an episode run on it too. */
  readonly clock: PersonaEpisodesClock
  /**
   * Open the persona's episode of this kind, or keep the open one. A case
   * that differs from the open episode's begins a new episode; no case, or
   * the same case, keeps it. After `close`, opens nothing and answers `closed`.
   */
  begin(key: string, kind: PersonaEpisodeKind, caseLabel?: string): PersonaEpisodeBeginResult
  /** Whether the persona has an open episode of this kind. */
  isOpen(key: string, kind: PersonaEpisodeKind): boolean
  /** The keys with an open episode of this kind. */
  openKeys(kind: PersonaEpisodeKind): string[]
  /**
   * Run `dispose` once when the persona's open episode of this kind closes,
   * however it closes (`end`, a new case, `forget`, `forgetAll`, `close`).
   * Returns false, and keeps nothing, when no episode is open. A throwing
   * `dispose` is logged and swallowed.
   */
  whenClosed(key: string, kind: PersonaEpisodeKind, dispose: () => void): boolean
  /**
   * Hand `text` to the sink once for this mark (`PERSONA_EPISODE_DEFAULT_MARK`
   * when none is given) in the open episode. Returns true when it was handed
   * over; false when no episode is open or the mark was already posted in it.
   */
  post(key: string, kind: PersonaEpisodeKind, text: string, mark?: string): boolean
  /**
   * Hand `text` to the sink, with `options`, for a notice of this kind that
   * has no episode (the kill-failure alert's survivor version, b.jg5
   * SRJ-704, and any kill-failure alert raised during a persona teardown,
   * SRJ-1003): no episode is read, begun or changed. Returns true when it was
   * handed over, or muted because the key's persona teardown was submitted;
   * false after `close`.
   */
  postWithoutEpisode(key: string, kind: PersonaEpisodeKind, text: string, options?: PersonaEpisodeSinkOptions): boolean
  /** Where the key stands with its persona teardown (the injected query; `none` when absent). Never throws. */
  teardownWindowState(key: string): PersonaTeardownWindowState
  /** Whether this mark (`PERSONA_EPISODE_DEFAULT_MARK` when none is given) was posted in the open episode. */
  hasPosted(key: string, kind: PersonaEpisodeKind, mark?: string): boolean
  /** End the open episode silently. Returns whether one was open. */
  end(key: string, kind: PersonaEpisodeKind): boolean
  /** The open episode, or undefined. */
  view(key: string, kind: PersonaEpisodeKind): PersonaEpisodeView | undefined
  /**
   * The persona's count of this kind: how many consecutive observations its
   * poster has added since the last reset (0 when none). Independent of
   * whether an episode of the kind is open.
   */
  count(key: string, kind: PersonaEpisodeKind): number
  /** Add one to the persona's count of this kind. Answers the new count. Posts nothing. */
  addCount(key: string, kind: PersonaEpisodeKind): number
  /** Reset the persona's count of this kind to 0. Answers the count before the reset. Posts nothing; an open episode stays open. */
  resetCount(key: string, kind: PersonaEpisodeKind): number
  /** End every kind's episode of the persona silently, and clear its counts of every kind. */
  forget(key: string): void
  /**
   * End every episode of every persona silently and clear every count,
   * leaving the instance open (a later `begin` opens again). For tests only:
   * the module's one test reset, which lets a test harness reset between
   * cases without closing the instance. No production path calls it;
   * shutdown uses `close`.
   */
  forgetAll(): void
  /**
   * The server's shutdown: end every episode silently and clear every count,
   * as `forgetAll`, and refuse every later `begin`, so nothing opens, posts
   * or arms after it.
   */
  close(): void
}

/** One open episode. */
interface OpenEpisode {
  readonly episode: number
  readonly startedAt: number
  readonly caseLabel?: string
  readonly posted: Set<string>
  /** Run once when the episode closes (`whenClosed`). */
  readonly disposers: (() => void)[]
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/** Build one server's latches. Nothing is read, posted or logged at creation. */
export function createPersonaEpisodes(deps: PersonaEpisodesDeps): PersonaEpisodes {
  const clock = deps.clock ?? SYSTEM_PERSONA_CONNECTION_CLOCK
  /** Open episodes by persona key, then by kind. */
  const byKey = new Map<string, Map<PersonaEpisodeKind, OpenEpisode>>()
  /** Counts above 0 by persona key, then by kind; kept apart from the open episodes. */
  const counts = new Map<string, Map<PersonaEpisodeKind, number>>()
  let lastEpisode = 0
  /** Set by `close`: every later `begin` is refused. */
  let closed = false

  function open(key: string, kind: PersonaEpisodeKind): OpenEpisode | undefined {
    return byKey.get(key)?.get(kind)
  }

  /** Run a closed episode's disposers once each; a throwing one is logged. Never throws. */
  function dispose(key: string, kind: PersonaEpisodeKind, closing: OpenEpisode): void {
    for (const disposer of closing.disposers.splice(0)) {
      try {
        disposer()
      } catch (err) {
        safeLog(deps.log, `[slack] persona-episodes: persona=${key} ${kind} episode close step failed: ${describeThrownValue(err)}`)
      }
    }
  }

  /** Close every episode of every persona silently, and clear every count. */
  function closeAll(): void {
    const closing = [...byKey].flatMap(([key, kinds]) => [...kinds].map(([kind, ep]) => ({ key, kind, ep })))
    byKey.clear()
    counts.clear()
    for (const { key, kind, ep } of closing) dispose(key, kind, ep)
  }

  function start(key: string, kind: PersonaEpisodeKind, caseLabel: string | undefined): void {
    let kinds = byKey.get(key)
    if (kinds === undefined) {
      kinds = new Map()
      byKey.set(key, kinds)
    }
    const replaced = kinds.get(kind)
    const startedAt = clock.now()
    lastEpisode++
    kinds.set(kind, {
      episode: lastEpisode,
      startedAt,
      ...(caseLabel === undefined ? {} : { caseLabel }),
      posted: new Set(),
      disposers: [],
    })
    if (replaced !== undefined) dispose(key, kind, replaced)
  }

  /** The injected teardown query; absent reads `none`, a throw `none` with one line. Never throws. */
  function teardownWindowState(key: string): PersonaTeardownWindowState {
    if (deps.teardownWindow === undefined) return 'none'
    try {
      const state = deps.teardownWindow(key)
      return state === 'open' || state === 'submitted' ? state : 'none'
    } catch (err) {
      safeLog(deps.log, `[slack] persona-episodes: persona=${key} teardown window read failed: ${describeThrownValue(err)} — read as none`)
      return 'none'
    }
  }

  /**
   * Hand a notice to the sink, unless the key's persona teardown was
   * submitted and its window is not open yet (b.jg5 SRJ-1003): then one line
   * says it was not posted, and nothing reaches the sink.
   */
  function send(key: string, kind: PersonaEpisodeKind, text: string, options?: PersonaEpisodeSinkOptions): void {
    if (teardownWindowState(key) === 'submitted') {
      safeLog(deps.log, `[slack] persona-episodes: persona=${key} ${kind} notice not posted — its persona teardown was submitted (b.jg5 SRJ-1003)`)
      return
    }
    const failed = (err: unknown): void =>
      safeLog(deps.log, `[slack] persona-episodes: persona=${key} ${kind} notice failed: ${describeThrownValue(err)}`)
    try {
      void Promise.resolve(options === undefined ? deps.sink(key, text) : deps.sink(key, text, options)).catch(failed)
    } catch (err) {
      failed(err)
    }
  }

  return {
    clock,

    begin(key, kind, caseLabel) {
      if (closed) return 'closed'
      const current = open(key, kind)
      if (current === undefined) {
        start(key, kind, caseLabel)
        return 'begun'
      }
      if (caseLabel === undefined || caseLabel === current.caseLabel) return 'kept'
      start(key, kind, caseLabel)
      return 'new-case'
    },

    isOpen: (key, kind) => open(key, kind) !== undefined,

    openKeys: (kind) => [...byKey].filter(([, kinds]) => kinds.has(kind)).map(([key]) => key),

    whenClosed(key, kind, disposer) {
      const current = open(key, kind)
      if (current === undefined) return false
      current.disposers.push(disposer)
      return true
    },

    post(key, kind, text, mark = PERSONA_EPISODE_DEFAULT_MARK) {
      const current = open(key, kind)
      if (current === undefined || current.posted.has(mark)) return false
      // Marked before the sink runs, so a sink that re-enters posts nothing twice.
      current.posted.add(mark)
      send(key, kind, text)
      return true
    },

    postWithoutEpisode(key, kind, text, options) {
      if (closed) return false
      send(key, kind, text, options)
      return true
    },

    teardownWindowState,

    hasPosted: (key, kind, mark = PERSONA_EPISODE_DEFAULT_MARK) => open(key, kind)?.posted.has(mark) ?? false,

    end(key, kind) {
      const kinds = byKey.get(key)
      const current = kinds?.get(kind)
      if (kinds === undefined || current === undefined) return false
      kinds.delete(kind)
      if (kinds.size === 0) byKey.delete(key)
      dispose(key, kind, current)
      return true
    },

    view(key, kind) {
      const current = open(key, kind)
      if (current === undefined) return undefined
      return {
        episode: current.episode,
        startedAt: current.startedAt,
        ...(current.caseLabel === undefined ? {} : { caseLabel: current.caseLabel }),
        posted: [...current.posted],
      }
    },

    count: (key, kind) => counts.get(key)?.get(kind) ?? 0,

    addCount(key, kind) {
      let kinds = counts.get(key)
      if (kinds === undefined) {
        kinds = new Map()
        counts.set(key, kinds)
      }
      const next = (kinds.get(kind) ?? 0) + 1
      kinds.set(kind, next)
      return next
    },

    resetCount(key, kind) {
      const kinds = counts.get(key)
      const prior = kinds?.get(kind) ?? 0
      if (kinds !== undefined) {
        kinds.delete(kind)
        if (kinds.size === 0) counts.delete(key)
      }
      return prior
    },

    forget(key) {
      counts.delete(key)
      const kinds = byKey.get(key)
      if (kinds === undefined) return
      byKey.delete(key)
      for (const [kind, ep] of kinds) dispose(key, kind, ep)
    },

    forgetAll: closeAll,

    close() {
      closed = true
      closeAll()
    },
  }
}

/** Hand `line` to `log`; a throwing log is swallowed, so no caller throws or rejects because of it. */
function safeLog(log: (line: string) => void, line: string): void {
  try {
    log(line)
  } catch {
    /* a failing logger must not change what a latch or condition does */
  }
}

// ---------------------------------------------------------------------------
// The tmux-unresponsive condition (b.jg5 SRJ-307, SRJ-310)
// ---------------------------------------------------------------------------

/**
 * With the health check off (`health_check_interval` 0), the onset is posted
 * at the first retry of the persona's retry timer made at least this long
 * after the first refusal (b.jg5 SRJ-308).
 */
export const TMUX_UNRESPONSIVE_ONSET_FLOOR_MS = 120_000

/** The onset notice's body for persona `key` (b.jg5 SRJ-1006); the persona notifier adds the persona prefix. */
export function tmuxUnresponsiveOnsetText(key: string): string {
  return (
    `:hourglass_flowing_sand: *Not answering* — agent-director or tmux is not answering for this persona's session ${quotedPersonaSessionName(key)}. ` +
    'CSCB keeps retrying; nothing is needed yet.'
  )
}

/**
 * The alert notice's body for persona `key` (b.jg5 SRJ-1006), stating
 * `thresholdMs` (the alert threshold in effect, SRJ-210) in whole minutes,
 * rounded down (`wholeMinutes`): "over 6 minutes" at agent-director's defaults.
 */
export function tmuxUnresponsiveAlertText(key: string, thresholdMs: number): string {
  return (
    `:rotating_light: *Still not answering* — this persona has not reached its session ${quotedPersonaSessionName(key)} ` +
    `for over ${wholeMinutes(thresholdMs)} minutes. CSCB keeps retrying and takes no destructive action. ` +
    "If this persists, a human should check the host's tmux server and agent-director."
  )
}

/** The recovery notice's body for persona `key` (b.jg5 SRJ-1006). */
export function tmuxUnresponsiveRecoveryText(key: string): string {
  return `:white_check_mark: *Answering again* — this persona reaches its session ${quotedPersonaSessionName(key)} again.`
}

/** The onset's mark: the default one, so `hasPosted` with no mark answers whether the onset was posted. */
const ONSET_MARK = PERSONA_EPISODE_DEFAULT_MARK
/** The alert's mark. */
const ALERT_MARK = 'alert'
/** The recovery's mark. */
const RECOVERY_MARK = 'recovery'

/** End reason: a tmux-touching call for the persona succeeded or answered GONE (SRJ-310 rule 1). */
export const TMUX_UNRESPONSIVE_END_TMUX_VERB = 'tmux-verb'

/** End reason: a health tick found the persona's row live, not `pending`, connected with its stream (SRJ-310 rule 2). */
export const TMUX_UNRESPONSIVE_END_TICK = 'tick'

/** End reason: a retry found the persona's row live, not `pending`, connected with its stream (SRJ-310 rule 2). */
export const TMUX_UNRESPONSIVE_END_RETRY = 'retry'

/**
 * End reason: the persona latched (b.jg5 SRJ-310, SRJ-502). `main()`'s latch
 * hold ends the condition with it, silently (`options.silent`): no recovery
 * notice, since the CONFLICT notice follows.
 */
export const TMUX_UNRESPONSIVE_END_LATCHED = 'latched'

/**
 * End reason: after a launch timeout, this launch's row (its launch start
 * inside the launch call's window) left `pending` for a live state (SRJ-310
 * rule 3, b.jg5 SRJ-407). The session manager's shared own-row reads end the
 * condition so through `src/outage-state.ts`'s end entry, once "this launch's
 * row" was established by a `pending` read.
 */
export const TMUX_UNRESPONSIVE_END_LAUNCH_ROW_LIVE = 'launch-row-live'

/** Why a `tmux-unresponsive` condition ended. */
export type TmuxUnresponsiveEndReason =
  | typeof TMUX_UNRESPONSIVE_END_TMUX_VERB
  | typeof TMUX_UNRESPONSIVE_END_TICK
  | typeof TMUX_UNRESPONSIVE_END_RETRY
  | typeof TMUX_UNRESPONSIVE_END_LATCHED
  | typeof TMUX_UNRESPONSIVE_END_LAUNCH_ROW_LIVE

/** The text each end reason's ended line carries. */
export const TMUX_UNRESPONSIVE_END_TEXT: Readonly<Record<TmuxUnresponsiveEndReason, string>> = Object.freeze({
  [TMUX_UNRESPONSIVE_END_TMUX_VERB]: 'a tmux-touching call succeeded or answered GONE',
  [TMUX_UNRESPONSIVE_END_TICK]: 'a health tick found its row live and its session connected with its stream',
  [TMUX_UNRESPONSIVE_END_RETRY]: 'a retry found its row live and its session connected with its stream',
  [TMUX_UNRESPONSIVE_END_LATCHED]: 'the persona latched',
  [TMUX_UNRESPONSIVE_END_LAUNCH_ROW_LIVE]: "after a launch timeout, this launch's row left pending for a live state",
})

/** What `start` did: started the condition, continued one already holding, or nothing after the episodes' `close` (shutdown). */
export type TmuxUnresponsiveStartResult = 'started' | 'continued' | 'closed'

/**
 * What `end` did: nothing (`not-holding`), or ended a holding condition in
 * whose episode neither the onset nor the alert had been posted (`ended`),
 * or one of them had (`ended-after-notice`).
 */
export type TmuxUnresponsiveEndResult = 'not-holding' | 'ended' | 'ended-after-notice'

/** Options of an end. */
export interface TmuxUnresponsiveEndOptions {
  /**
   * End without the recovery notice even when the onset or the alert was posted: the
   * answer that ends it is CONFLICT, whose notice follows (b.jg5 SRJ-310).
   */
  silent?: boolean
}

/**
 * Where the outage state's wrappers start and end the condition
 * (`OutageStateDeps.conditionSink`, `src/outage-state.ts`). The condition is
 * one.
 */
export interface TmuxUnresponsiveSink {
  start(key: string, verb: AdVerb, error: unknown): unknown
  end(key: string, reason: TmuxUnresponsiveEndReason, reading?: string, options?: TmuxUnresponsiveEndOptions): unknown
}

/**
 * The condition-end hook: called once per end of a holding condition, with
 * the reading the end brings (a tick's or a retry's live reading, or the live
 * state this launch's row left `pending` for (SRJ-310 rule 3), a row state
 * other than `pending`; `pending` for a successful launch call, `spawn` or
 * `resume`, whose row its success leaves `pending`), none for any other
 * tmux-touching success or GONE. Production
 * binds the retry controller's condition-end entry
 * (`conditionEnded(key, UNAVAILABLE_RETRY_CONDITION_TMUX_UNRESPONSIVE, reading)`,
 * b.jg5 SRJ-306).
 */
export type TmuxUnresponsiveConditionEndHook = (key: string, reading: string | undefined) => unknown

/** Dependencies of `createTmuxUnresponsiveCondition`. */
export interface TmuxUnresponsiveConditionDeps {
  /** The episodes instance whose `tmux-unresponsive` episode is the condition. */
  episodes: PersonaEpisodes
  /** Receives the started and ended lines (the server log). A throwing log is swallowed. */
  log: (line: string) => void
  /** Called once per end of a holding condition; absent, nothing is called. A throwing hook is swallowed. */
  conditionEnded?: TmuxUnresponsiveConditionEndHook
  /**
   * Whether the health check is on (`health_check_interval` not 0), read from
   * the configuration in effect at each onset check: on, the onset comes at a
   * health tick (`onsetAtTick`); off, at a retry (`onsetAtRetry`). Absent: on.
   */
  healthCheckOn?: () => boolean
  /**
   * The alert threshold in effect, in milliseconds (production: E6's
   * `adAlertThresholdMsInEffect`), read at the arm and at every check.
   * Absent: no alert check is armed.
   */
  alertThresholdMs?: () => number
}

/** One server's `tmux-unresponsive` conditions, one per persona key. */
export interface TmuxUnresponsiveCondition extends TmuxUnresponsiveSink {
  /**
   * Start persona `key`'s condition for a refusal `error` from `verb` (one
   * started line; the first refusal's time from the clock), or continue it
   * while it holds (its first refusal's time kept, no line; a non-terminal
   * retry-timer stop's hold on the episode's onset is lifted, and an alert
   * check a retry-timer stop cancelled in the episode is armed again, with
   * one line).
   */
  start(key: string, verb: AdVerb, error: unknown): TmuxUnresponsiveStartResult
  /** Whether persona `key`'s condition holds. */
  holds(key: string): boolean
  /** The first refusal's time, in clock milliseconds, while the condition holds; else `undefined`. */
  firstRefusalAt(key: string): number | undefined
  /**
   * End persona `key`'s condition for `reason`: when it holds, post the
   * recovery notice once if the onset or the alert was posted (none with
   * `options.silent`), end its episode (which cancels its alert check), log
   * one ended line and call the condition-end hook once with `reading`, and
   * answer whether either notice had been posted; when it does not hold,
   * answer `not-holding` and do nothing else.
   */
  end(
    key: string,
    reason: TmuxUnresponsiveEndReason,
    reading?: string,
    options?: TmuxUnresponsiveEndOptions,
  ): TmuxUnresponsiveEndResult
  /**
   * The health tick's onset check, once per tick body, after all of the
   * tick's per-persona work (b.jg5 SRJ-308): with the health check on, post
   * the onset once per episode for every persona whose condition still holds
   * and whose first refusal is strictly before `tickStartedAt` (the tick's
   * start, in the episodes' clock milliseconds), unless the episode's alert
   * has posted or a stop of the persona's retry timer holds it back
   * (`cancelAlert`). A condition the tick ended no longer holds, so gets
   * none. No agent-director call; never throws.
   */
  onsetAtTick(tickStartedAt: number): void
  /**
   * A retry's onset check, at every fire of persona `key`'s retry timer, a
   * fire whose retry is skipped for work in flight included (b.jg5 SRJ-308,
   * SRJ-303): with the health check off, post the onset once per episode
   * when the condition holds and `firedAt` is at least
   * `TMUX_UNRESPONSIVE_ONSET_FLOOR_MS` after its first refusal, unless the
   * episode's alert has posted or a stop of the persona's retry timer holds
   * it back (`cancelAlert`). Never throws.
   */
  onsetAtRetry(key: string, firedAt: number): void
  /**
   * A stop of persona `key`'s retry timer, for `stopReason`, the condition
   * kept (production binds it to the retry controller's `onStopped`, so
   * every stop reason reaches it). While the condition holds, the stop is
   * recorded for its episode whatever its reason, whether or not a check is
   * pending: the onset is held back until the episode's next refusal
   * (`start`), or for the rest of the episode when `stopReason` is terminal
   * (`UNAVAILABLE_RETRY_TERMINAL_STOPS`); an absent `stopReason` is a
   * non-terminal stop. Then it cancels the pending alert check. Only a check
   * not yet posted in the episode open now is cancelled; an alert already
   * posted stays posted. When one is cancelled, one line names `stopReason`
   * (none when it is absent), and the episode's next refusal arms the check
   * again (`start`) unless `stopReason` is terminal
   * (`UNAVAILABLE_RETRY_TERMINAL_STOPS`: torn down, not in the applied
   * configuration, server shutdown), which never re-arms it. A terminal
   * stop also withdraws the re-arm an earlier non-terminal stop left in the
   * episode (its check already cancelled, so none is pending now), so no
   * later refusal in the episode arms the check again. Answers whether one
   * was pending; with no condition holding (its end has already cancelled
   * the check), false and no line.
   */
  cancelAlert(key: string, stopReason?: string): boolean
}

/**
 * Build one server's `tmux-unresponsive` conditions over `deps.episodes`; see
 * the module comment. Nothing is read, posted or logged at creation.
 */
export function createTmuxUnresponsiveCondition(deps: TmuxUnresponsiveConditionDeps): TmuxUnresponsiveCondition {
  const kind = PERSONA_EPISODE_KIND_TMUX_UNRESPONSIVE
  const { episodes } = deps
  /** Each persona's pending alert check: the episode it was armed for and its cancel. */
  const alerts = new Map<string, { episode: number; cancel: () => void }>()
  /**
   * The episode whose pending alert check `cancelAlert` cancelled with the
   * condition kept (a non-terminal stop of the persona's retry timer): the
   * next refusal in that episode arms it again (`start`), unless a terminal
   * stop in the episode has withdrawn it first.
   */
  const rearmable = new Map<string, number>()
  /** The episode whose onset was held back because its alert had posted: logged once per episode. */
  const onsetHeld = new Map<string, number>()
  /**
   * The episode in which a stop of the persona's retry timer
   * (`cancelAlert`) holds the onset back, and whether that stop was terminal
   * (`UNAVAILABLE_RETRY_TERMINAL_STOPS`): a refusal continuing the episode
   * (`start`) clears a non-terminal mark; a terminal one stays for the
   * episode.
   */
  const timerStopped = new Map<string, { episode: number; terminal: boolean }>()
  /** The episode whose onset was held back because its retry timer was stopped: logged once per episode. */
  const onsetHeldStopped = new Map<string, number>()

  function line(key: string, text: string): void {
    safeLog(deps.log, `[slack] persona-episodes: persona=${key} ${kind} ${text}`)
  }

  /** The health check's mode in effect; a throwing accessor reads as on. */
  function healthCheckOn(): boolean {
    if (deps.healthCheckOn === undefined) return true
    try {
      return deps.healthCheckOn()
    } catch (err) {
      safeLog(deps.log, `[slack] persona-episodes: ${kind} health-check mode read failed: ${describeThrownValue(err)} — taken as on`)
      return true
    }
  }

  /** Cancel the persona's pending alert check (only the one armed for `episode`, when given). Answers whether one was pending. */
  function cancelPendingAlert(key: string, episode?: number): boolean {
    const pending = alerts.get(key)
    if (pending === undefined || (episode !== undefined && pending.episode !== episode)) return false
    alerts.delete(key)
    pending.cancel()
    return true
  }

  /** Drop the per-episode marks of the persona's `episode` once it closes. */
  function dropMarks(key: string, episode: number): void {
    if (rearmable.get(key) === episode) rearmable.delete(key)
    if (onsetHeld.get(key) === episode) onsetHeld.delete(key)
    if (timerStopped.get(key)?.episode === episode) timerStopped.delete(key)
    if (onsetHeldStopped.get(key) === episode) onsetHeldStopped.delete(key)
  }

  /**
   * Record a stop of the persona's retry timer for its open `episode`
   * (b.jg5 SRJ-305, SRJ-308): the onset is held back from now on. A terminal
   * stop is kept terminal: a later non-terminal stop in the episode never
   * weakens it.
   */
  function markTimerStopped(key: string, episode: number, terminal: boolean): void {
    const prior = timerStopped.get(key)
    const wasTerminal = prior?.episode === episode && prior.terminal
    timerStopped.set(key, { episode, terminal: terminal || wasTerminal })
  }

  /**
   * A refusal that continues a holding condition (b.jg5 SRJ-305, SRJ-308):
   * the refusal's reporting point has just armed the persona's retry timer
   * again, so a non-terminal stop no longer holds the episode's onset back.
   * A terminal stop's mark stays.
   */
  function clearNonTerminalStop(key: string, episode: number): void {
    const mark = timerStopped.get(key)
    if (mark !== undefined && mark.episode === episode && !mark.terminal) timerStopped.delete(key)
  }

  /**
   * A refusal that continues a holding condition (b.jg5 SRJ-309): when a stop
   * of the persona's retry timer cancelled the episode's pending alert check
   * (`cancelAlert`), and the refusal's reporting point has just armed the
   * timer again (`reportAgentDirectorError` arms before it starts or
   * continues the condition), arm the check again from the episode's first
   * refusal, so the alert posts once the condition has lasted longer than
   * the threshold while CSCB is retrying again. Never throws.
   */
  function rearmAlert(key: string): void {
    const current = episodes.view(key, kind)
    if (current === undefined || rearmable.get(key) !== current.episode) return
    rearmable.delete(key)
    if (alerts.has(key) || current.posted.includes(ALERT_MARK)) return
    if (armAlert(key)) line(key, 'alert check armed again — a new refusal armed its retry timer again')
  }

  /**
   * Arm the alert check for the persona's episode just begun (b.jg5 SRJ-309):
   * on the episodes' clock, from the first refusal, until the condition has
   * lasted strictly longer than the threshold in effect (the never-early wait
   * of the threshold plus 1 ms, read at every fire). Answers whether it was
   * armed. Never throws: a failed arm is logged, and the condition holds
   * with no alert check.
   */
  function armAlert(key: string): boolean {
    const threshold = deps.alertThresholdMs
    if (threshold === undefined) return false
    try {
      const opened = episodes.view(key, kind)
      if (opened === undefined) return false
      const { episode, startedAt } = opened
      const cancel = armNeverEarlyWait(episodes.clock, startedAt, () => threshold() + 1, () => fireAlert(key, episode))
      alerts.set(key, { episode, cancel })
      episodes.whenClosed(key, kind, () => cancelPendingAlert(key, episode))
      return true
    } catch (err) {
      line(key, `alert check not armed: ${describeThrownValue(err)}`)
      return false
    }
  }

  /** The alert check's fire: post the alert once if the episode it was armed for is still open. Never throws. */
  function fireAlert(key: string, episode: number): void {
    try {
      if (alerts.get(key)?.episode === episode) alerts.delete(key)
      const current = episodes.view(key, kind)
      if (current === undefined || current.episode !== episode) return
      const thresholdMs = deps.alertThresholdMs?.()
      if (thresholdMs === undefined) return
      const muted = episodes.teardownWindowState(key) === 'submitted'
      if (!episodes.post(key, kind, tmuxUnresponsiveAlertText(key, thresholdMs), ALERT_MARK)) return
      line(
        key,
        `${muted ? `alert not posted — ${MUTED_BY_TEARDOWN}; it counts as posted in its episode;` : 'alert posted —'} ` +
          `not answering for ${seconds(episodes.clock.now() - current.startedAt)} s, ` +
          `over its alert threshold of ${seconds(thresholdMs)} s`,
      )
    } catch (err) {
      line(key, `alert check failed: ${describeThrownValue(err)}`)
    }
  }

  /**
   * Post the onset once in the persona's open episode; log it when posted.
   * Once the episode's alert has posted, the onset is not posted in it (the
   * alert already said more), and one line per episode says so. While a stop
   * of the persona's retry timer holds the episode's onset back (no refusal
   * since a non-terminal stop, or any terminal stop), it is not posted
   * either (it says CSCB is retrying), and one line per episode says so.
   */
  function postOnset(key: string, where: string, now: number): void {
    const current = episodes.view(key, kind)
    if (current === undefined || current.posted.includes(ONSET_MARK)) return
    if (current.posted.includes(ALERT_MARK)) {
      if (onsetHeld.get(key) === current.episode) return
      onsetHeld.set(key, current.episode)
      line(key, 'onset not posted — its alert already posted')
      return
    }
    if (timerStopped.get(key)?.episode === current.episode) {
      if (onsetHeldStopped.get(key) === current.episode) return
      onsetHeldStopped.set(key, current.episode)
      line(key, 'onset not posted — its retry timer stopped and no refusal has re-armed it')
      return
    }
    const muted = episodes.teardownWindowState(key) === 'submitted'
    if (!episodes.post(key, kind, tmuxUnresponsiveOnsetText(key), ONSET_MARK)) return
    const what = muted ? `onset not posted — ${MUTED_BY_TEARDOWN}; it counts as posted in its episode;` : 'onset posted —'
    line(key, `${what} still not answering at ${where}, ${seconds(now - current.startedAt)} s after its first refusal`)
  }

  return {
    start(key, verb, error) {
      if (episodes.isOpen(key, kind)) {
        const open = episodes.view(key, kind)?.episode
        if (open !== undefined) clearNonTerminalStop(key, open)
        rearmAlert(key)
        return 'continued'
      }
      if (episodes.begin(key, kind) === 'closed') return 'closed'
      line(key, `started — ${verb} failed: ${describeAgentDirectorFailure(error)}`)
      const episode = episodes.view(key, kind)?.episode
      if (episode !== undefined) episodes.whenClosed(key, kind, () => dropMarks(key, episode))
      armAlert(key)
      return 'started'
    },

    holds: (key) => episodes.isOpen(key, kind),

    firstRefusalAt: (key) => episodes.view(key, kind)?.startedAt,

    end(key, reason, reading, options) {
      if (!episodes.isOpen(key, kind)) return 'not-holding'
      // The recovery follows either notice: the onset, or the alert (which
      // holds the onset back once it has posted).
      const noticePosted = episodes.hasPosted(key, kind, ONSET_MARK) || episodes.hasPosted(key, kind, ALERT_MARK)
      const silent = options?.silent === true
      const muted = episodes.teardownWindowState(key) === 'submitted'
      const recovered = noticePosted && !silent && episodes.post(key, kind, tmuxUnresponsiveRecoveryText(key), RECOVERY_MARK)
      episodes.end(key, kind)
      line(key, `ended — ${endText(reason)}`)
      if (recovered) line(key, muted ? `recovery not posted — ${MUTED_BY_TEARDOWN}` : 'recovery posted')
      else if (noticePosted && silent) line(key, 'recovery not posted — a silent end (a CONFLICT answer ended it)')
      try {
        deps.conditionEnded?.(key, reading)
      } catch {
        /* a failing hook must not change how the condition ended */
      }
      return noticePosted ? 'ended-after-notice' : 'ended'
    },

    onsetAtTick(tickStartedAt) {
      try {
        if (!healthCheckOn()) return
        const now = episodes.clock.now()
        for (const key of episodes.openKeys(kind)) {
          const startedAt = episodes.view(key, kind)?.startedAt
          if (startedAt !== undefined && startedAt < tickStartedAt) postOnset(key, 'a health tick', now)
        }
      } catch (err) {
        safeLog(deps.log, `[slack] persona-episodes: ${kind} onset check at a health tick failed: ${describeThrownValue(err)}`)
      }
    },

    onsetAtRetry(key, firedAt) {
      try {
        if (healthCheckOn()) return
        const startedAt = episodes.view(key, kind)?.startedAt
        if (startedAt === undefined || firedAt - startedAt < TMUX_UNRESPONSIVE_ONSET_FLOOR_MS) return
        postOnset(key, 'a retry', firedAt)
      } catch (err) {
        line(key, `onset check at a retry failed: ${describeThrownValue(err)}`)
      }
    },

    cancelAlert: (key, stopReason) => {
      try {
        // Only the check armed for the episode open now: the condition holds.
        const episode = episodes.view(key, kind)?.episode
        if (episode === undefined) return false
        // A terminal stop (torn down, removed, shutdown) never re-arms: a
        // refusal landing after it (a launch still in flight) must not bring
        // the onset or the alert back for a persona that is going away.
        const terminal = stopReason !== undefined && UNAVAILABLE_RETRY_TERMINAL_STOPS.has(stopReason)
        // Every stop holds the onset back, a pending alert check or not.
        markTimerStopped(key, episode, terminal)
        // A terminal stop also withdraws a re-arm an earlier non-terminal
        // stop left for the episode, whose check it already cancelled.
        if (terminal && rearmable.get(key) === episode) rearmable.delete(key)
        if (!cancelPendingAlert(key, episode)) return false
        if (!terminal) rearmable.set(key, episode)
        if (stopReason !== undefined) line(key, `alert check cancelled — its retry timer stopped: ${stopReason}`)
        return true
      } catch (err) {
        line(key, `alert check cancel failed: ${describeThrownValue(err)}`)
        return false
      }
    },
  }
}

/** Whole seconds, rounded down, of a span in milliseconds. */
function seconds(ms: number): number {
  return Math.floor(ms / 1000)
}

/** The ended line's text for `reason`; an unknown reason is named as such. Never throws. */
function endText(reason: unknown): string {
  return typeof reason === 'string' && Object.hasOwn(TMUX_UNRESPONSIVE_END_TEXT, reason)
    ? TMUX_UNRESPONSIVE_END_TEXT[reason as TmuxUnresponsiveEndReason]
    : 'an unnamed reason'
}

// ---------------------------------------------------------------------------
// The unclassified-error episode (b.jg5 SRJ-313, SRJ-1009)
// ---------------------------------------------------------------------------

/**
 * The `startup-errors.log` class of an unclassified-error alert for a persona
 * no longer in the applied configuration (b.jg5 SRJ-313, SRJ-1013). `main()`
 * binds the episode's log-only route to `recordStartupError` with it.
 */
export const PERSONA_UNCLASSIFIED_ERROR_LABEL = 'persona-unclassified-error'

/** End reason: a retry of the persona's timer found nothing left to recover (b.jg5 SRJ-313). */
export const UNCLASSIFIED_ERROR_END_RECOVERED = 'a retry found nothing left to recover'

/**
 * End reason: a pending-only retry of the persona's timer read its row live
 * out of `pending` (b.jg5 SRJ-313): a launch the retries made succeeded and
 * the retries are over.
 */
export const UNCLASSIFIED_ERROR_END_ROW_LIVE = 'a retry read its row live out of pending'

/**
 * End reason: the persona's retry timer stopped because its `tmux-unavailable`
 * condition cleared or its `tmux-unresponsive` condition ended (b.jg5
 * SRJ-313): no retry follows.
 */
export const UNCLASSIFIED_ERROR_END_CONDITION_ENDED = 'its retry timer stopped when its tmux condition ended'

/**
 * End reason: a pending-only retry of the persona's timer read its row ended
 * or missing, or found none (b.jg5 SRJ-313): the retries are over and the
 * restart path's decision runs once.
 */
export const UNCLASSIFIED_ERROR_END_ROW_GONE = 'a retry read its row ended or gone'

/** End reason: the persona reached the restart cap (b.jg5 SRJ-313). */
export const UNCLASSIFIED_ERROR_END_CAPPED = 'the persona reached the restart cap'

/**
 * End reason: the persona latched (b.jg5 SRJ-313, SRJ-502); `main()`'s latch
 * hold ends the episode with it, whatever the latch's case.
 */
export const UNCLASSIFIED_ERROR_END_LATCHED = 'the persona latched'

/**
 * End reason: the old-life hold on the row ended (b.jg5 SRJ-313, SRJ-811):
 * an old-life wait's episode, keyed by the held instance id, ends with its
 * hold, and with nothing else.
 */
export const UNCLASSIFIED_ERROR_END_HOLD_ENDED = 'its old-life hold ended'

/** Why an unclassified-error episode ended. */
export type UnclassifiedErrorEndReason =
  | typeof UNCLASSIFIED_ERROR_END_RECOVERED
  | typeof UNCLASSIFIED_ERROR_END_ROW_LIVE
  | typeof UNCLASSIFIED_ERROR_END_CONDITION_ENDED
  | typeof UNCLASSIFIED_ERROR_END_ROW_GONE
  | typeof UNCLASSIFIED_ERROR_END_CAPPED
  | typeof UNCLASSIFIED_ERROR_END_LATCHED
  | typeof UNCLASSIFIED_ERROR_END_HOLD_ENDED

/** What the alert quotes: the classifier's reported name (a safe identifier) and rendered message. */
export type UnclassifiedErrorQuote = Pick<AdErrorClassification, 'reportedName' | 'message'>

/** Options of {@link unclassifiedErrorAlertText}. */
export interface UnclassifiedErrorAlertTextOptions {
  /**
   * Escape Slack's control characters in the quoted message
   * (`escapeSlackControlCharacters`), for a Slack post. Default true; false
   * for the log-only route, whose text goes to the server log and
   * `startup-errors.log` and is never posted.
   */
  escapeForSlack?: boolean
}

/**
 * The unclassified-error alert's body (b.jg5 SRJ-1009); the persona notifier
 * adds the persona prefix. `<error name>` is the classification's reported
 * name, left out (with no placeholder) when it is absent or not a safe
 * identifier; the quoted message is its rendered message (agent-director's
 * description through `redactSlackLogText`, on one line, capped at
 * `MAX_LOGGED_MESSAGE_LENGTH`), escaped for Slack after that unless
 * `options.escapeForSlack` is false, and left out with its quotes when
 * absent. With neither, the sentence ends at "for this persona". Never throws.
 */
export function unclassifiedErrorAlertText(quote: UnclassifiedErrorQuote, options?: UnclassifiedErrorAlertTextOptions): string {
  const parts: string[] = []
  const name = readQuoteField(quote, 'reportedName')
  if (isSafeIdentifier(name)) parts.push(name)
  const message = readQuoteField(quote, 'message')
  if (typeof message === 'string' && message !== '') {
    parts.push(`"${options?.escapeForSlack === false ? message : escapeSlackControlCharacters(message)}"`)
  }
  const quoted = parts.length > 0 ? `: ${parts.join(' ')}` : ''
  return (
    `:warning: *Unclassified agent-director error* — agent-director returned an error CSCB cannot classify for this persona${quoted}. ` +
    "CSCB keeps retrying and takes no destructive action; a human should check the host's agent-director."
  )
}

/** `quote[field]`, or `undefined` when the read throws. */
function readQuoteField(quote: UnclassifiedErrorQuote, field: keyof UnclassifiedErrorQuote): unknown {
  try {
    return quote[field]
  } catch {
    return undefined
  }
}

/**
 * Where the outage state's reporting point reports an UNCLASSIFIED outcome in
 * a launch or recovery attempt for the persona (`OutageStateDeps.unclassifiedSink`,
 * `src/outage-state.ts`). The unclassified-error episodes are one.
 * `classification` is given by a site that classified the outcome itself (the
 * resume path's `ErrInvalidFlags` after its re-check); otherwise the value is
 * classified here.
 */
export interface UnclassifiedErrorSink {
  report(key: string, error: unknown, classification?: AdErrorClassification): unknown
}

/** What `report` did: began an episode, continued one, posted its alert, or nothing after the episodes' `close`. */
export type UnclassifiedErrorReportResult = 'begun' | 'continued' | 'alerted' | 'closed'

/** Dependencies of `createUnclassifiedErrorEpisodes`. */
export interface UnclassifiedErrorEpisodesDeps {
  /** The episodes instance whose `unclassified-error` episode is the persona's episode; its sink posts the alert. */
  episodes: PersonaEpisodes
  /** Receives the episode's `[slack]` lines (the server log). A throwing log is swallowed. */
  log: (line: string) => void
  /** The alert threshold in effect, in milliseconds (production: E6's `adAlertThresholdMsInEffect`), read at each check. */
  alertThresholdMs: () => number
  /**
   * Whether the persona is in the applied configuration, read when the alert
   * is posted: true, the alert goes to the episodes' sink (the persona's
   * destination); false, to `logOnly`. Absent: every key is configured. A
   * throw takes the log-only route.
   */
  isConfigured?: (key: string) => boolean
  /**
   * The log-only route for a persona not in the applied configuration
   * (production: `recordStartupError` with `PERSONA_UNCLASSIFIED_ERROR_LABEL`,
   * the key and the text, which writes the server-log line and the
   * startup-errors entry). Given the unescaped text. Never posts to Slack.
   * Absent: one line says the alert had no route. The written line follows
   * its return; a throw is logged in its place, and the alert still counts as
   * posted.
   */
  logOnly?: (key: string, text: string) => void
}

/** One server's unclassified-error episodes, one per persona key. */
export interface UnclassifiedErrorEpisodes extends UnclassifiedErrorSink {
  /**
   * An UNCLASSIFIED outcome `error` in a launch or recovery attempt for
   * persona `key` (b.jg5 SRJ-313), with the site's own `classification` when
   * given. With no open episode it begins one (the time from the episodes'
   * clock, one started line). In an open episode whose alert has not been
   * posted, when the time since the episode's first outcome is strictly
   * longer than the threshold in effect now, it posts the alert once,
   * quoting this outcome, routed by `isConfigured`. Never throws.
   */
  report(key: string, error: unknown, classification?: AdErrorClassification): UnclassifiedErrorReportResult
  /** End persona `key`'s open episode silently, with one ended line naming `reason`. Answers whether one was open. */
  end(key: string, reason: UnclassifiedErrorEndReason): boolean
  /**
   * A stop of persona `key`'s retry timer (`UnavailableRetryDeps.onStopped`).
   * The stops that mean the retries are over because the persona's state got
   * better end the episode: `UNAVAILABLE_RETRY_STOP_RECOVERED` (a retry found
   * nothing left to recover; `UNCLASSIFIED_ERROR_END_RECOVERED`),
   * `UNAVAILABLE_RETRY_STOP_ROW_LIVE` (a pending-only retry read the row live
   * out of `pending`; `UNCLASSIFIED_ERROR_END_ROW_LIVE`),
   * `UNAVAILABLE_RETRY_STOP_TMUX_UNAVAILABLE_CLEARED` and
   * `UNAVAILABLE_RETRY_STOP_TMUX_UNRESPONSIVE_ENDED` (the timer's tmux
   * condition ended; `UNCLASSIFIED_ERROR_END_CONDITION_ENDED`) and
   * `UNAVAILABLE_RETRY_STOP_ROW_GONE` (a pending-only retry read the row
   * ended or missing, or found none; `UNCLASSIFIED_ERROR_END_ROW_GONE`). No
   * retry follows any of them. Every other stop reason (not up, not applied,
   * launch skipped, run failed, torn down, shutdown, capped, a caller's own
   * text) leaves it open: the cap ends it through `end`, a teardown or
   * shutdown drops it through the episodes' `forget` or `close`. Answers
   * whether it ended one.
   */
  retryStopped(key: string, stopReason: string): boolean
  /** Whether persona `key`'s episode is open. */
  isOpen(key: string): boolean
}

/** The unclassified-error alert's mark in its episode. */
const UNCLASSIFIED_ALERT_MARK = 'alert'

/**
 * Build one server's unclassified-error episodes over `deps.episodes` (b.jg5
 * SRJ-313); see the module comment. No timer, no agent-director call; nothing
 * is read, posted or logged at creation.
 */
export function createUnclassifiedErrorEpisodes(deps: UnclassifiedErrorEpisodesDeps): UnclassifiedErrorEpisodes {
  const kind = PERSONA_EPISODE_KIND_UNCLASSIFIED_ERROR
  const { episodes } = deps
  /**
   * The episode whose alert was posted, per persona, by either route (the
   * log-only route hands nothing to the episodes' sink). Dropped when that
   * episode closes, by an end, `forget`, `forgetAll` or `close`.
   */
  const alerted = new Map<string, number>()

  function line(key: string, text: string): void {
    safeLog(deps.log, `[slack] persona-episodes: persona=${key} ${kind} ${text}`)
  }

  /** The configured-key lookup; absent reads as configured, a throw as not configured (logged). */
  function configured(key: string): boolean {
    if (deps.isConfigured === undefined) return true
    try {
      return deps.isConfigured(key) === true
    } catch (err) {
      line(key, `configured-key lookup failed: ${describeThrownValue(err)} — the alert takes the log-only route`)
      return false
    }
  }

  /** Post the alert for `episode` once, quoting `classification`, by the route `isConfigured` gives now. */
  function postAlert(key: string, episode: number, classification: AdErrorClassification, elapsedMs: number, thresholdMs: number): void {
    alerted.set(key, episode)
    episodes.whenClosed(key, kind, () => {
      if (alerted.get(key) === episode) alerted.delete(key)
    })
    const met = `an UNCLASSIFIED outcome met ${seconds(elapsedMs)} s after the episode's first, over its alert threshold of ${seconds(thresholdMs)} s: ${describeAdErrorClassification(classification)}`
    // b.jg5 SRJ-1003, SRJ-704's first match: during the persona's teardown
    // the alert is a teardown notice, configured or not: the sink's window
    // writes it (unescaped) and posts nothing.
    if (episodes.teardownWindowState(key) === 'open') {
      episodes.post(key, kind, unclassifiedErrorAlertText(classification, { escapeForSlack: false }), UNCLASSIFIED_ALERT_MARK)
      line(key, `alert written to the server log and startup-errors.log (${PERSONA_TEARDOWN_NOTICE_LABEL}) — raised during its persona teardown; ${met}`)
      return
    }
    if (configured(key)) {
      const muted = episodes.teardownWindowState(key) === 'submitted'
      episodes.post(key, kind, unclassifiedErrorAlertText(classification), UNCLASSIFIED_ALERT_MARK)
      line(
        key,
        muted
          ? `alert not posted to its destination — ${MUTED_BY_TEARDOWN}; it counts as posted in its episode; ${met}`
          : `alert posted to its destination — ${met}`,
      )
      return
    }
    const text = unclassifiedErrorAlertText(classification, { escapeForSlack: false })
    if (deps.logOnly === undefined) {
      line(key, `alert not routed — the persona is not in the applied configuration and no log-only route is installed; ${met}`)
      return
    }
    try {
      deps.logOnly(key, text)
    } catch (err) {
      // The alert stays latched as posted; no "written" line, which would be false.
      line(key, `log-only alert failed: ${describeThrownValue(err)}`)
      return
    }
    line(key, `alert written to the server log and startup-errors.log (${PERSONA_UNCLASSIFIED_ERROR_LABEL}) — the persona is not in the applied configuration; ${met}`)
  }

  function end(key: string, reason: UnclassifiedErrorEndReason): boolean {
    if (!episodes.end(key, kind)) return false
    line(key, `ended — ${reason}`)
    return true
  }

  /** `report` for an outcome already classified. Never throws. */
  function reportClassified(key: string, classification: AdErrorClassification): UnclassifiedErrorReportResult {
    try {
      const current = episodes.view(key, kind)
      if (current === undefined) {
        if (episodes.begin(key, kind) === 'closed') return 'closed'
        line(key, `started — ${describeAdErrorClassification(classification)}`)
        return 'begun'
      }
      if (alerted.get(key) === current.episode) return 'continued'
      const thresholdMs = deps.alertThresholdMs()
      const elapsedMs = episodes.clock.now() - current.startedAt
      if (!(elapsedMs > thresholdMs)) return 'continued'
      postAlert(key, current.episode, classification, elapsedMs, thresholdMs)
      return 'alerted'
    } catch (err) {
      line(key, `report failed: ${describeThrownValue(err)}`)
      return 'continued'
    }
  }

  return {
    // `classifyAdError` never throws.
    report: (key, error, given) => reportClassified(key, given ?? classifyAdError(error)),

    end,

    retryStopped(key, stopReason) {
      if (stopReason === UNAVAILABLE_RETRY_STOP_RECOVERED) return end(key, UNCLASSIFIED_ERROR_END_RECOVERED)
      if (stopReason === UNAVAILABLE_RETRY_STOP_ROW_LIVE) return end(key, UNCLASSIFIED_ERROR_END_ROW_LIVE)
      if (
        stopReason === UNAVAILABLE_RETRY_STOP_TMUX_UNAVAILABLE_CLEARED ||
        stopReason === UNAVAILABLE_RETRY_STOP_TMUX_UNRESPONSIVE_ENDED
      ) {
        return end(key, UNCLASSIFIED_ERROR_END_CONDITION_ENDED)
      }
      if (stopReason === UNAVAILABLE_RETRY_STOP_ROW_GONE) return end(key, UNCLASSIFIED_ERROR_END_ROW_GONE)
      return false
    },

    isOpen: (key) => episodes.isOpen(key, kind),
  }
}

// ---------------------------------------------------------------------------
// The kill-failure alerts (b.jg5 SRJ-704, SRJ-1007, SRJ-1016)
// ---------------------------------------------------------------------------

/** End reason: a read of the persona's own row read it `ended` or `missing` (b.jg5 SRJ-704, SRJ-1016). */
export const KILL_FAILURE_END_ROW_FINISHED = 'its own row read ended or missing'

/** End reason: a read of the persona's own row found it gone (`ErrSpawnNotFound`; b.jg5 SRJ-704, SRJ-1016). */
export const KILL_FAILURE_END_ROW_GONE = 'its own row is gone (ErrSpawnNotFound)'

/**
 * The route name in the written line of a stopped ordinary decision's entry
 * (`KillFailureRaiseInput.stopped` for a persona no longer in the applied
 * configuration, or an old-life wait's old key).
 */
const KILL_FAILURE_STOPPED_ROUTE = 'stopped'

/** What that written line names: the stop's log line, never an alert (b.jg5 SRJ-702, SRJ-1013). */
const KILL_FAILURE_STOPPED_SUBJECT = "stopped retry's log line (no alert text)"

/** The stop's cause a stopped kill retry's line and entry name when its raiser gives none (`KillFailureRaiseInput.stopCause`; b.jg5 SRJ-702). */
export const KILL_FAILURE_STOP_CAUSE_DEFAULT = 'the persona is not up or is torn down, or the server is shutting down'

/** What the stopped-retry line and entry are built from (`killFailureStoppedRetryText`). */
export type KillFailureStoppedRetryInput = Pick<KillFailureRaiseInput, 'key' | 'decision' | 'context' | 'lastOutcomeClass' | 'stopCause' | 'ref'>

/**
 * The one line, and the entry text, of an ordinary kill-failure decision
 * whose tries were stopped (b.jg5 SRJ-702, SRJ-1013): the line names the
 * persona, the stop's cause (`KILL_FAILURE_STOP_CAUSE_DEFAULT` when none is
 * given), the last outcome's class when given, the redacted descriptions and
 * the context; the entry (written only for a persona no longer configured,
 * as `persona-kill-failed`) carries the same content with no alert text,
 * naming the entry reference (`ref`; `persona=<key>` when absent):
 *
 *   line:  [slack] persona-episodes: persona=<key> kill-failure ordinary alert not raised — its tries were stopped (<cause>)[; its last outcome's class: <class>], so nothing retries this kill; <descriptions> (<context>)
 *   entry: <ref> (<context>): the kill-failure ordinary alert not raised — its tries were stopped (<cause>)[; its last outcome's class: <class>], so nothing retries this kill; <descriptions>
 *
 * Pure; never throws for a well-formed decision.
 */
export function killFailureStoppedRetryText(input: KillFailureStoppedRetryInput): { readonly line: string; readonly entry: string } {
  const { key, context } = input
  const lastOutcome = input.lastOutcomeClass === undefined ? '' : `; its last outcome's class: ${input.lastOutcomeClass}`
  const cause = input.stopCause ?? KILL_FAILURE_STOP_CAUSE_DEFAULT
  const what =
    `${KILL_FAILURE_VERSION_ORDINARY} alert not raised — its tries were stopped (${cause})${lastOutcome}, ` +
    `so nothing retries this kill; ${describeKillFailureDescriptions(input.decision)}`
  return {
    line: `[slack] persona-episodes: persona=${key} ${PERSONA_EPISODE_KIND_KILL_FAILURE} ${what} (${context})`,
    entry: killFailureAlertEntryText(entryRefOf(input), context, `the ${PERSONA_EPISODE_KIND_KILL_FAILURE} ${what}`),
  }
}

/** Why a kill-failure episode ended (a teardown's `forget` and shutdown's `close` drop it with no line). */
export type KillFailureEndReason = typeof KILL_FAILURE_END_ROW_FINISHED | typeof KILL_FAILURE_END_ROW_GONE

/**
 * What raising an alert did:
 *   - `posted`: handed to the persona's destination (the ordinary version
 *     beginning its episode, or the survivor version with none);
 *   - `held`: the ordinary version at a destination whose episode has
 *     already posted it, so nothing is posted;
 *   - `logged`: written through the log-only route (one entry of the route's
 *     class, whose writer also writes the server-log line);
 *   - `not-routed`: a log-only route with no log-only sink installed, or one
 *     that threw (one line says so);
 *   - `closed`: after the episodes' `close` (shutdown), nothing is posted;
 *   - `stopped`: an ordinary decision whose tries were stopped
 *     (`KillFailureRaiseInput.stopped`): one line, nothing posted and no
 *     episode; for a persona no longer configured, also one
 *     `persona-kill-failed` entry with no alert text;
 *   - `none`: the decision called for no alert.
 */
export type KillFailureRaiseResult = 'posted' | 'held' | 'logged' | 'not-routed' | 'closed' | 'stopped' | 'none'

/** What a raise is given. */
export interface KillFailureRaiseInput {
  /** The persona key the killed row belongs to. */
  readonly key: string
  /** The bounded retry's alert decision (`KillRetryResult.alert`, `src/kill-retry.ts`); its descriptions raw. */
  readonly decision: KillRetryAlert
  /**
   * Whether the persona is latched now: by the retry's last outcome (after
   * that outcome's own handling) or by a `status` read between its tries
   * (b.jg5 SRJ-702; hatch A2). Read only for the ordinary version at a
   * destination, whose closing sentence it picks.
   */
  readonly latched: boolean
  /** Where it was raised (`src/kill-failure-alert.ts`'s contexts). */
  readonly context: KillFailureAlertContext
  /**
   * True when the retry's tries were stopped by its keep-going check while
   * the persona was not latched (it is torn down or not up, or the server is
   * shutting down), or the last outcome's version re-check decided that the
   * server stops. A stopped ordinary decision is no notice (b.jg5 SRJ-702,
   * SRJ-1003, SRJ-1013), inside a teardown window or not: neither version is
   * raised, nothing is posted and no episode is read or changed; one line
   * names the persona, the context, the last outcome's class
   * (`lastOutcomeClass`), the stop's cause (`stopCause`) and the redacted
   * descriptions, the latest survivor-naming one included. For a persona no
   * longer in the applied configuration (or an old-life wait's old key) that
   * line's content is also written as one `persona-kill-failed` entry naming
   * `ref`, with no alert text; a configured persona's stop writes the line only.
   */
  readonly stopped?: boolean
  /**
   * With `stopped`: the class of the outcome that stands (its failure class,
   * or its outcome kind), for the stop's line and entry (b.jg5 SRJ-702).
   * Absent: the line names none.
   */
  readonly lastOutcomeClass?: string
  /** With `stopped`: why the tries were stopped, for the stop's line and entry; a generic cause when absent. */
  readonly stopCause?: string
  /**
   * With `stopped`: the stop is a configured persona's, so only the line is
   * written, whatever the context's route (b.jg5 SRJ-702: a configured
   * persona's stop writes the log line only). An old-life wait's kill
   * stopped by the latch of the configured persona whose own row it is gives
   * it, since that context's route is otherwise always the log-only one.
   * Absent: the route decides.
   */
  readonly lineOnly?: boolean
  /** The session the alert names, unquoted; `slack_bot_<key>` when absent. */
  readonly session?: string
  /** The row's instance id; `cscb_<key>` when absent. */
  readonly instanceId?: string
  /**
   * The persona reference or the row's id a log-only entry names (b.jg5
   * SRJ-1007, SRJ-1013), as `killFailureAlertEntryText` takes it:
   * `persona=<key>` when absent. An old-life wait gives its own reference
   * (`oldLifeWaitRef`, `src/old-life-wait.ts`): `persona=<old key>` for a
   * `cscb_<old key>` row, `instanceId=<id>` for an id standing in for the
   * old key (a pre-persona or wrong-id row). The `[slack] persona-episodes:`
   * lines name `persona=<key>` whatever it is.
   */
  readonly ref?: string
}

/** The reference a log-only entry names (`KillFailureRaiseInput.ref`; `persona=<key>` when absent). */
function entryRefOf(input: Pick<KillFailureRaiseInput, 'key' | 'ref'>): string {
  return input.ref ?? `persona=${input.key}`
}

/** Dependencies of `createKillFailureAlerts`. */
export interface KillFailureAlertsDeps {
  /** The episodes instance whose `kill-failure` episode is the persona's; its sink posts the destination route. */
  episodes: PersonaEpisodes
  /** Receives the alerts' `[slack]` lines (the server log). A throwing log is swallowed. */
  log: (line: string) => void
  /**
   * Whether the persona is in the applied configuration, read when the alert
   * is raised (production: the applied configuration in effect). Absent:
   * every key is configured. A throw takes the log-only route.
   */
  isConfigured?: (key: string) => boolean
  /**
   * The log-only route (production: `recordStartupError(classLabel, entry)`,
   * which writes the server-log line and the startup-errors entry). Given
   * the route's class and the entry (`killFailureAlertEntryText`: the
   * persona reference or the row's id, `KillFailureRaiseInput.ref`, the
   * context and the unescaped text). Never posts to
   * Slack. Absent: one line says the alert had no route.
   */
  logOnly?: (classLabel: string, entry: string) => void
}

/** One server's kill-failure alerts. */
export interface KillFailureAlerts {
  /**
   * Raise the alert the retry's decision calls for (b.jg5 SRJ-704). An
   * ordinary decision with `stopped` is decided first, before every route
   * below, the teardown window's included: one line, and for a persona no
   * longer configured one `persona-kill-failed` entry with no alert text
   * (SRJ-702); it answers `stopped`. While the
   * key's persona teardown window is open, for any context but a start-sweep
   * or CLI teardown kill, it takes the persona-teardown
   * route (b.jg5 SRJ-1003): handed to the sink with no episode, whose window
   * writes it (`persona-teardown-notice`, or `persona-kill-survivor` for the
   * survivor version) and posts nothing; it answers `logged`. Otherwise it
   * takes the route `selectKillFailureAlertRoute` gives for the context,
   * whether the persona is configured now and `latched`:
   *   - ordinary, at a destination: begins the persona's kill-failure
   *     episode when none is open and posts the text once in it (a later
   *     raise in the same episode posts nothing);
   *   - survivor, at a destination: posts the text once for this call, with
   *     no episode read or changed;
   *   - either, on a log-only route: one entry of the route's class through
   *     the log-only sink (a `persona-teardown-notice` entry built by
   *     `personaTeardownNoticeEntryText`), and no episode.
   * A post that the key's submitted teardown mutes (SRJ-1003) still answers
   * `posted` and counts in its episode; its line says it was not posted.
   * A `none` decision does nothing. Never throws.
   */
  raise(input: KillFailureRaiseInput): KillFailureRaiseResult
  /** End persona `key`'s open kill-failure episode silently, with one ended line. Answers whether one was open. */
  end(key: string, reason: KillFailureEndReason): boolean
  /** Whether persona `key`'s kill-failure episode is open (lost-message state 4, b.jg5 SRJ-1011). */
  isOpen(key: string): boolean
}

/**
 * Build one server's kill-failure alerts over `deps.episodes` (b.jg5
 * SRJ-704, SRJ-1007, SRJ-1016). No timer, no agent-director call; nothing is
 * read, posted or logged at creation.
 *
 * Log lines, to the injected log (a throwing log is swallowed):
 *
 *   [slack] persona-episodes: persona=<key> kill-failure ordinary alert posted to its destination (<context>; <closing>)
 *   [slack] persona-episodes: persona=<key> kill-failure ordinary alert not posted — its episode's alert already posted
 *   [slack] persona-episodes: persona=<key> kill-failure survivor alert posted to its destination (<context>)
 *   [slack] persona-episodes: persona=<key> kill-failure <version> alert written to the server log and startup-errors.log (<class>) — <route>
 *   [slack] persona-episodes: persona=<key> kill-failure <version> alert written to the server log and startup-errors.log (<class>) — persona-teardown, raised during its teardown (<context>)
 *   [slack] persona-episodes: persona=<key> kill-failure ordinary alert not posted to its destination — muted, its persona teardown was submitted; it counts as posted in its episode (<context>; <closing>)
 *   [slack] persona-episodes: persona=<key> kill-failure survivor alert not posted to its destination — muted, its persona teardown was submitted (<context>)
 *   [slack] persona-episodes: persona=<key> kill-failure ordinary alert not raised — its tries were stopped (<cause>)[; its last outcome's class: <class>], so nothing retries this kill; <descriptions> (<context>)
 *   [slack] persona-episodes: persona=<key> kill-failure stopped retry's log line (no alert text) written to the server log and startup-errors.log (persona-kill-failed) — stopped
 *   [slack] persona-episodes: persona=<key> kill-failure ended — <reason>
 *
 * and, only on a failure or a missing route: `configured-key lookup failed:
 * <error> — the alert takes the log-only route`, `<version> alert not routed
 * — no log-only route is installed`, `<version> log-only alert failed:
 * <error>` (for a stopped retry's entry, `stopped retry's log line (no alert
 * text) not routed — …` and `… log-only write failed: <error>`),
 * `<version> alert not posted — the episodes are closed` and
 * `raise failed: <error>` (each after `persona=<key> kill-failure`).
 */
export function createKillFailureAlerts(deps: KillFailureAlertsDeps): KillFailureAlerts {
  const kind = PERSONA_EPISODE_KIND_KILL_FAILURE
  const { episodes } = deps

  function line(key: string, text: string): void {
    safeLog(deps.log, `[slack] persona-episodes: persona=${key} ${kind} ${text}`)
  }

  /** The configured-key lookup; absent reads as configured, a throw as not configured (logged). */
  function configured(key: string): boolean {
    if (deps.isConfigured === undefined) return true
    try {
      return deps.isConfigured(key) === true
    } catch (err) {
      line(key, `configured-key lookup failed: ${describeThrownValue(err)} — the alert takes the log-only route`)
      return false
    }
  }

  /**
   * Write `entry` of `classLabel` through the log-only sink, with its line
   * naming `routeName`. True when written; false (one line says why) when no
   * sink or class is installed, or the sink threw.
   */
  function writeLogOnly(
    key: string,
    version: string,
    classLabel: string | undefined,
    entry: string,
    routeName: string,
    what?: string,
  ): boolean {
    const subject = what ?? `${version} alert`
    if (deps.logOnly === undefined || classLabel === undefined) {
      line(key, `${subject} not routed — no log-only route is installed`)
      return false
    }
    try {
      deps.logOnly(classLabel, entry)
    } catch (err) {
      line(key, `${what === undefined ? `${version} log-only alert` : `${what} log-only write`} failed: ${describeThrownValue(err)}`)
      return false
    }
    line(key, `${subject} written to the server log and startup-errors.log (${classLabel}) — ${routeName}`)
    return true
  }

  /**
   * An alert raised while the key's persona teardown window is open (b.jg5
   * SRJ-1003, SRJ-704's first match): the persona-teardown route, written by
   * the sink's window (one server-log line and one entry naming the persona
   * and "raised during its teardown"; `persona-kill-survivor` for the
   * survivor version), with no episode and no Slack post. An alert of
   * another context than the persona teardown's own kill (a `recovery` or
   * `stuck-launch abort` kill whose tries ended in the window) carries that
   * context ahead of its text, as `(<context>) <text>`, so its entry names
   * it (SRJ-1007, SRJ-1013).
   */
  function raiseInTeardownWindow(input: KillFailureRaiseInput, content: KillFailureAlertContent): KillFailureRaiseResult {
    const { key, context } = input
    const { version } = content
    const route = selectKillFailureAlertRoute({ version, context: KILL_FAILURE_CONTEXT_PERSONA_TEARDOWN, configured: configured(key), latched: false })
    const alertText = killFailureAlertText(content, route.closing, false)
    const text = context === KILL_FAILURE_CONTEXT_PERSONA_TEARDOWN ? alertText : `(${context}) ${alertText}`
    const options: PersonaEpisodeSinkOptions | undefined =
      route.classLabel === PERSONA_KILL_SURVIVOR_LABEL ? { teardownEntryClass: PERSONA_KILL_SURVIVOR_LABEL } : undefined
    if (!episodes.postWithoutEpisode(key, kind, text, options)) {
      line(key, `${version} alert not posted — the episodes are closed`)
      return 'closed'
    }
    line(key, `${version} alert written to the server log and startup-errors.log (${route.classLabel ?? PERSONA_TEARDOWN_NOTICE_LABEL}) — ${route.route}, raised during its teardown (${input.context})`)
    return 'logged'
  }

  /**
   * An ordinary decision whose tries SRJ-702's stop rule stopped (b.jg5
   * SRJ-702, SRJ-704, SRJ-1003, SRJ-1013): no notice, whether or not the
   * key's teardown window is open. Nothing is posted, no episode is read or
   * changed and no alert text is written: one line naming the persona, the
   * context, the last outcome's class, the stop's cause and the redacted
   * descriptions (the latest survivor-naming one included); and, for a
   * persona no longer in the applied configuration (or an old-life wait's
   * old key), that line's content as one entry of the not-configured route's
   * class, `persona-kill-failed`. A configured persona's stop writes the line
   * only, and so does a stop given `lineOnly`.
   */
  function raiseStopped(input: KillFailureRaiseInput): KillFailureRaiseResult {
    const { key, context } = input
    const stopped = killFailureStoppedRetryText(input)
    safeLog(deps.log, stopped.line)
    if (input.lineOnly === true) return 'stopped'
    const route = selectKillFailureAlertRoute({
      version: KILL_FAILURE_VERSION_ORDINARY,
      context,
      configured: configured(key),
      latched: input.latched === true,
    })
    if (route.destination) return 'stopped'
    // Never a persona-teardown-notice entry: a stopped retry is no notice.
    const classLabel = route.classLabel === PERSONA_TEARDOWN_NOTICE_LABEL ? PERSONA_KILL_FAILED_LABEL : route.classLabel
    writeLogOnly(
      key,
      KILL_FAILURE_VERSION_ORDINARY,
      classLabel,
      stopped.entry,
      KILL_FAILURE_STOPPED_ROUTE,
      KILL_FAILURE_STOPPED_SUBJECT,
    )
    return 'stopped'
  }

  function raise(input: KillFailureRaiseInput): KillFailureRaiseResult {
    const { key, context } = input
    const content = killFailureAlertContentOf(
      input.decision,
      input.session ?? personaTmuxSessionName(key),
      input.instanceId ?? personaInstanceId(key),
    )
    if (content === undefined) return 'none'
    const { version } = content
    // b.jg5 SRJ-702, SRJ-1003: a retry whose tries were stopped is no notice,
    // inside a teardown window or not: it is decided before every route.
    if (version === KILL_FAILURE_VERSION_ORDINARY && input.stopped === true) return raiseStopped(input)
    // b.jg5 SRJ-704: a start-sweep or CLI teardown kill matches first.
    if (
      context !== KILL_FAILURE_CONTEXT_START_SWEEP &&
      context !== KILL_FAILURE_CONTEXT_CLI_TEARDOWN &&
      episodes.teardownWindowState(key) === 'open'
    ) {
      return raiseInTeardownWindow(input, content)
    }
    const route = selectKillFailureAlertRoute({ version, context, configured: configured(key), latched: input.latched === true })
    if (!route.destination) {
      const text = killFailureAlertText(content, route.closing, false)
      // b.jg5 SRJ-1007, SRJ-1013: the entry names the persona reference or
      // the row's id (`ref`); a persona-teardown-notice entry also says
      // "raised during its teardown".
      const ref = entryRefOf(input)
      const entry =
        route.classLabel === PERSONA_TEARDOWN_NOTICE_LABEL
          ? personaTeardownNoticeEntryText(ref, text)
          : killFailureAlertEntryText(ref, context, text)
      return writeLogOnly(key, version, route.classLabel, entry, route.route) ? 'logged' : 'not-routed'
    }
    const text = killFailureAlertText(content, route.closing, true)
    // b.jg5 SRJ-1003: read before the post, which a submitted teardown mutes
    // (the episode still counts it as posted).
    const muted = episodes.teardownWindowState(key) === 'submitted'
    // A destination route that opens no episode (the survivor version) posts once for this call.
    if (!route.opensEpisode) {
      if (!episodes.postWithoutEpisode(key, kind, text)) {
        line(key, `${version} alert not posted — the episodes are closed`)
        return 'closed'
      }
      line(key, muted ? `${version} alert not posted to its destination — ${MUTED_BY_TEARDOWN} (${context})` : `${version} alert posted to its destination (${context})`)
      return 'posted'
    }
    if (episodes.begin(key, kind) === 'closed') {
      line(key, `${version} alert not posted — the episodes are closed`)
      return 'closed'
    }
    if (!episodes.post(key, kind, text)) {
      line(key, `${version} alert not posted — its episode's alert already posted`)
      return 'held'
    }
    line(
      key,
      muted
        ? `${version} alert not posted to its destination — ${MUTED_BY_TEARDOWN}; it counts as posted in its episode (${context}; ${route.closing})`
        : `${version} alert posted to its destination (${context}; ${route.closing})`,
    )
    return 'posted'
  }

  return {
    raise(input) {
      try {
        return raise(input)
      } catch (err) {
        line(input.key, `raise failed: ${describeThrownValue(err)}`)
        return 'not-routed'
      }
    },

    end(key, reason) {
      if (!episodes.end(key, kind)) return false
      line(key, `ended — ${reason}`)
      return true
    },

    isOpen: (key) => episodes.isOpen(key, kind),
  }
}
