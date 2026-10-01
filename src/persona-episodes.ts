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
 *
 * Kinds and their posters. One label per row of SRJ-1016's table
 * (`PERSONA_EPISODE_KINDS`). `tmux-unresponsive`'s episode is begun and
 * ended by its condition (below), which posts its onset, alert and recovery;
 * `unclassified-error`'s by its episodes (below), which post its one alert;
 * CONFLICT's is begun by the conflict latch's notice reaction
 * (`src/conflict-latch.ts`), which posts its one notice per episode;
 * every other kind has no poster yet: its begin and end triggers and text
 * come with the Epic that posts it, named on its label below.
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
 *   unless `options.silent` (a CONFLICT answer ends it; its notice follows);
 *   the episode ends, which cancels the alert check; one ended line names
 *   the reason; and the injected condition-end hook is called once with the
 *   reading the end brings (a tick's or a retry's live reading; `pending`
 *   for a successful `spawn` or `resume`; none for any other tmux-touching
 *   success or GONE). It answers whether either notice had been posted
 *   (`ended-after-notice`). On a persona that does not hold it, it does
 *   nothing.
 * - The episodes' `forget(key)` (a teardown), `forgetAll()` and `close()`
 *   drop a holding condition silently, with no post, no line and no hook
 *   call.
 *
 * Texts (SRJ-1006; `<session>` the persona's quoted session name,
 * `"slack_bot_<key>"`, SRJ-1001): `tmuxUnresponsiveOnsetText`,
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
 * - The alert's route is decided when it is posted: a persona in the applied
 *   configuration (the injected lookup) gets it through the episodes' sink
 *   (its destination); any other persona gets it through the injected
 *   log-only route (in production `recordStartupError` with
 *   `PERSONA_UNCLASSIFIED_ERROR_LABEL`, the key and the unescaped text), and
 *   nothing reaches Slack. Either way it counts as posted.
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
 *   cap, and a teardown or shutdown drops it through `forget` or `close`.
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
 *   [slack] persona-episodes: persona=<key> unclassified-error alert written to the server log and startup-errors.log (persona-unclassified-error) — the persona is not in the applied configuration; <met>
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
 * the persona's client is validated. A sink that throws or rejects is logged
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
import { describeThrownValue, isSafeIdentifier } from './persona-connection-errors.ts'
import { SYSTEM_PERSONA_CONNECTION_CLOCK, type PersonaConnectionClock } from './persona-connections.ts'
import { personaTmuxSessionName } from './persona-identity.ts'
import { escapeSlackControlCharacters } from './slack-text-escape.ts'
import {
  UNAVAILABLE_RETRY_STOP_RECOVERED,
  UNAVAILABLE_RETRY_STOP_ROW_GONE,
  UNAVAILABLE_RETRY_STOP_ROW_LIVE,
  UNAVAILABLE_RETRY_STOP_TMUX_UNAVAILABLE_CLEARED,
  UNAVAILABLE_RETRY_STOP_TMUX_UNRESPONSIVE_ENDED,
  UNAVAILABLE_RETRY_TERMINAL_STOPS,
} from './unavailable-retry.ts'

// ---------------------------------------------------------------------------
// Kinds (b.jg5 SRJ-1016)
// ---------------------------------------------------------------------------

/**
 * CONFLICT (SRJ-506, SRJ-508): from the latch being set until it clears; a
 * new case begins a new episode. Posted by the conflict latch's notice
 * reaction (`createConflictNoticeObserver`, bound in `main()` by
 * `bindConflictNotice`, `src/conflict-latch.ts`): a latch or a relatch with a
 * new case begins the episode with its case and posts the CONFLICT notice
 * once; the same case keeps it and posts nothing. Its end, at the latch's
 * clear, is E30's.
 */
export const PERSONA_EPISODE_KIND_CONFLICT = 'conflict'

/** Unusable recorded name (SRJ-512): from the latch being set until it clears. No poster yet (b.jg5 E16). */
export const PERSONA_EPISODE_KIND_UNUSABLE_RECORDED_NAME = 'unusable-recorded-name'

/** Launch start not recorded (SRJ-513): from the latch being set until it clears. No poster yet (b.jg5 E16). */
export const PERSONA_EPISODE_KIND_LAUNCH_START_NOT_RECORDED = 'launch-start-not-recorded'

/**
 * Kill failure (SRJ-704): from its ordinary version's alert until the row
 * reads `ended` or `missing`, or the persona is torn down. The survivor
 * version opens no episode. No poster yet (b.jg5 E20).
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

/** `ErrInvalidFlags` hold: as SRJ-207 states. No poster yet (b.jg5 E23). */
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
 * Slow dead-session recovery: from its post until the row reads `ended` or
 * `missing`, the persona latches, or it is torn down. No poster yet (b.jg5 E18).
 */
export const PERSONA_EPISODE_KIND_SLOW_DEAD_SESSION_RECOVERY = 'slow-dead-session-recovery'

/**
 * Stuck launch (SRJ-410, SRJ-1017): from its first post until the row
 * reaches a live state out of `pending`, the persona latches, or it is torn
 * down. Each of its two texts posts at most once (one mark each), and a
 * relaunch after CSCB's abort keeps the episode. No poster yet (b.jg5 E29).
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

/** Receives each notice to post: the persona key and the notice body (production: the persona notifier's post). */
export type PersonaEpisodeSink = (key: string, text: string) => void | Promise<void>

/** Dependencies of `createPersonaEpisodes`. */
export interface PersonaEpisodesDeps {
  /** Receives each notice a post makes. */
  sink: PersonaEpisodeSink
  /** Receives each `[slack]` line (the server log): only a sink or a close step that throws or rejects. A throwing log is swallowed. */
  log: (line: string) => void
  /** Clock and timers; `SYSTEM_PERSONA_CONNECTION_CLOCK` by default. */
  clock?: PersonaEpisodesClock
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
  /** Whether this mark (`PERSONA_EPISODE_DEFAULT_MARK` when none is given) was posted in the open episode. */
  hasPosted(key: string, kind: PersonaEpisodeKind, mark?: string): boolean
  /** End the open episode silently. Returns whether one was open. */
  end(key: string, kind: PersonaEpisodeKind): boolean
  /** The open episode, or undefined. */
  view(key: string, kind: PersonaEpisodeKind): PersonaEpisodeView | undefined
  /** End every kind's episode of the persona silently. */
  forget(key: string): void
  /**
   * End every episode of every persona silently, leaving the instance open
   * (a later `begin` opens again). For tests only: the module's one test
   * reset, which lets a test harness reset between cases without closing
   * the instance. No production path calls it; shutdown uses `close`.
   */
  forgetAll(): void
  /**
   * The server's shutdown: end every episode silently, as `forgetAll`, and
   * refuse every later `begin`, so nothing opens, posts or arms after it.
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

  /** Close every episode of every persona silently. */
  function closeAll(): void {
    const closing = [...byKey].flatMap(([key, kinds]) => [...kinds].map(([kind, ep]) => ({ key, kind, ep })))
    byKey.clear()
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

  function send(key: string, kind: PersonaEpisodeKind, text: string): void {
    const failed = (err: unknown): void =>
      safeLog(deps.log, `[slack] persona-episodes: persona=${key} ${kind} notice failed: ${describeThrownValue(err)}`)
    try {
      void Promise.resolve(deps.sink(key, text)).catch(failed)
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

    forget(key) {
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

/** `<session>` in SRJ-1006's texts: the persona's quoted session name (SRJ-1001). */
function quotedSession(key: string): string {
  return `"${personaTmuxSessionName(key)}"`
}

/** The onset notice's body for persona `key` (b.jg5 SRJ-1006); the persona notifier adds the persona prefix. */
export function tmuxUnresponsiveOnsetText(key: string): string {
  return (
    `:hourglass_flowing_sand: *Not answering* — agent-director or tmux is not answering for this persona's session ${quotedSession(key)}. ` +
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
    `:rotating_light: *Still not answering* — this persona has not reached its session ${quotedSession(key)} ` +
    `for over ${wholeMinutes(thresholdMs)} minutes. CSCB keeps retrying and takes no destructive action. ` +
    "If this persists, a human should check the host's tmux server and agent-director."
  )
}

/** The recovery notice's body for persona `key` (b.jg5 SRJ-1006). */
export function tmuxUnresponsiveRecoveryText(key: string): string {
  return `:white_check_mark: *Answering again* — this persona reaches its session ${quotedSession(key)} again.`
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

/** Why a `tmux-unresponsive` condition ended. */
export type TmuxUnresponsiveEndReason =
  | typeof TMUX_UNRESPONSIVE_END_TMUX_VERB
  | typeof TMUX_UNRESPONSIVE_END_TICK
  | typeof TMUX_UNRESPONSIVE_END_RETRY

/** The text each end reason's ended line carries. */
export const TMUX_UNRESPONSIVE_END_TEXT: Readonly<Record<TmuxUnresponsiveEndReason, string>> = Object.freeze({
  [TMUX_UNRESPONSIVE_END_TMUX_VERB]: 'a tmux-touching call succeeded or answered GONE',
  [TMUX_UNRESPONSIVE_END_TICK]: 'a health tick found its row live and its session connected with its stream',
  [TMUX_UNRESPONSIVE_END_RETRY]: 'a retry found its row live and its session connected with its stream',
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
 * the reading the end brings (a tick's or a retry's live reading, a row state
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
      if (!episodes.post(key, kind, tmuxUnresponsiveAlertText(key, thresholdMs), ALERT_MARK)) return
      line(
        key,
        `alert posted — not answering for ${seconds(episodes.clock.now() - current.startedAt)} s, ` +
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
    if (!episodes.post(key, kind, tmuxUnresponsiveOnsetText(key), ONSET_MARK)) return
    line(key, `onset posted — still not answering at ${where}, ${seconds(now - current.startedAt)} s after its first refusal`)
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
      const recovered = noticePosted && !silent && episodes.post(key, kind, tmuxUnresponsiveRecoveryText(key), RECOVERY_MARK)
      episodes.end(key, kind)
      line(key, `ended — ${endText(reason)}`)
      if (recovered) line(key, 'recovery posted')
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

/** Why an unclassified-error episode ended. */
export type UnclassifiedErrorEndReason =
  | typeof UNCLASSIFIED_ERROR_END_RECOVERED
  | typeof UNCLASSIFIED_ERROR_END_ROW_LIVE
  | typeof UNCLASSIFIED_ERROR_END_CONDITION_ENDED
  | typeof UNCLASSIFIED_ERROR_END_ROW_GONE
  | typeof UNCLASSIFIED_ERROR_END_CAPPED

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
    if (configured(key)) {
      episodes.post(key, kind, unclassifiedErrorAlertText(classification), UNCLASSIFIED_ALERT_MARK)
      line(key, `alert posted to its destination — ${met}`)
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
