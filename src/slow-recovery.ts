/**
 * slow-recovery.ts — The slow dead-session recovery post (b.jg5 SRJ-610,
 * SRJ-1010, SRJ-1016).
 *
 * After an escalate-dead sweep, agent-director may leave the persona's row
 * live for further ticks (in `unverified_ids`, or not judged), so the restart
 * path re-sweeps on each escalate-dead tick and does nothing more: no kill
 * outside the live-row sequence, no counted failure, no other destructive
 * step. This tracker counts persona P's consecutive escalate-dead verdicts
 * whose re-probe still reads the row live, and the third posts SRJ-1010 once
 * per slow-recovery episode, so a human is told once that recovery is slow.
 *
 * The count is the `slow-dead-session-recovery` kind's count in the episodes
 * instance (`src/persona-episodes.ts`), kept beside P's episode of that kind,
 * so a teardown's `forget` and shutdown's `close` clear it with the episode.
 * The restart work (`src/restart.ts`) tells the tracker what each run read,
 * through `RestartDeps.slowRecovery`, and the health check tells it each
 * tick that finds P healthy (`HealthCheckDeps.resetSlowRecoveryCount`);
 * `main()` builds one tracker over the server's episodes instance, hands it
 * to `initRestart` and `initHealthCheck`, and ends P's episode from the
 * latch's hold observer (`endForLatch`).
 *
 * Per persona (SRJ-610, SRJ-1016):
 *
 * - `noteLive(key)`: an escalate-dead verdict whose re-probe reads the row
 *   `live` (a live state other than `pending`). The count goes up by one.
 *   When it reaches `SLOW_RECOVERY_POST_THRESHOLD` and no slow-recovery
 *   episode is open, the episode begins and SRJ-1010's text is posted once
 *   through the episodes instance (its sink, the persona notifier). While the
 *   episode is open, further notes post nothing.
 * - `noteDead(key)`: a row read of `ended` or `missing`, or no row
 *   (`ErrSpawnNotFound`), at the run's first liveness probe or at the
 *   re-probe. The count is reset and the episode ends silently, so a later
 *   run of three posts again.
 * - `noteInstallGone(key)`: the `dead` reading from
 *   `ErrSystemInstallDisappeared`, which reads no row. The count is reset;
 *   an open episode stays open (hatch A2).
 * - `noteOther(key, reason)`: a run whose reconnect ended with a verdict
 *   other than escalate-dead or that found P already connected with its
 *   stream, a run whose first liveness probe read `pending`, or an
 *   escalate-dead verdict whose re-probe read `pending` (whose notice is the
 *   stuck-launch post, SRJ-1017). The count is reset; an open episode stays
 *   open.
 * - `noteHealthy(key)`: a health-check tick found P `live`, connected and
 *   with its stream. The count is reset; an open episode stays open.
 * - `endForLatch(key)`: P latched. The count is reset and the episode ends
 *   silently.
 * - `count(key)` and `isOpen(key)` read the state, for tests.
 *
 * An `unknown` or thrown re-probe is not noted at all: it neither counts nor
 * resets. A count reset alone never ends an open episode: only a row read of
 * `ended` or `missing` or no row, a latch or a teardown ends it.
 *
 * Text (SRJ-1010; `<session>` the persona's quoted session name,
 * `"slack_bot_<key>"`, as the other notices render it): `slowRecoveryText`.
 *
 * Log lines, to the injected log, with the persona reference only (a
 * throwing log is swallowed):
 *
 *   [slack] slow-recovery: persona=<key> count <n> of <threshold> — an escalate-dead verdict's re-probe still reads the row live
 *   [slack] slow-recovery: persona=<key> notice posted — <n> consecutive escalate-dead verdicts whose re-probe still reads the row live
 *   [slack] slow-recovery: persona=<key> notice not posted — the server is shutting down
 *   [slack] slow-recovery: persona=<key> count reset from <n> — <reason>
 *   [slack] slow-recovery: persona=<key> episode ended — <reason>
 *
 * A reset line is logged only when the count was above 0, and an ended line
 * only when an episode was open. The reasons are `SLOW_RECOVERY_RESET_TEXT`'s.
 * A note that throws inside (an episodes call) logs `[slack] slow-recovery:
 * persona=<key> failed: <error>` and changes nothing else. Each line has its
 * exported builder (`slowRecoveryCountLine`, `slowRecoveryNoticePostedLine`,
 * `slowRecoveryNoticeNotPostedLine`, `slowRecoveryCountResetLine`,
 * `slowRecoveryEpisodeEndedLine`, `slowRecoveryFailedLine`).
 *
 * No agent-director call, no timer and no Slack client: the post goes only
 * through the episodes instance. No module-scope state: each instance keeps
 * its state in its episodes instance; nothing is read, posted or logged at
 * import or at creation. Never throws.
 *
 * SPDX-License-Identifier: MIT
 */

import { describeThrownValue } from './persona-connection-errors.ts'
import { PERSONA_EPISODE_KIND_SLOW_DEAD_SESSION_RECOVERY, type PersonaEpisodes } from './persona-episodes.ts'
import { personaTmuxSessionName } from './persona-identity.ts'
import {
  RESTART_SLOW_RECOVERY_OTHER_PENDING_PROBE,
  RESTART_SLOW_RECOVERY_OTHER_PENDING_REPROBE,
  RESTART_SLOW_RECOVERY_OTHER_VERDICT,
  type RestartSlowRecoveryObserver,
  type SlowRecoveryOtherReason,
} from './restart.ts'

/** How many consecutive escalate-dead verdicts whose re-probe still reads the row live post SRJ-1010 (b.jg5 SRJ-610). */
export const SLOW_RECOVERY_POST_THRESHOLD = 3

/**
 * The slow-recovery notice's body for persona `key` (b.jg5 SRJ-1010); the
 * persona notifier adds the persona prefix.
 */
export function slowRecoveryText(key: string): string {
  return (
    `:hourglass_flowing_sand: *Slow recovery* — agent-director has not yet marked the worker row of this persona's session "${personaTmuxSessionName(key)}" ended or missing. ` +
    'CSCB keeps retrying; no action is needed unless this persists.'
  )
}

/** Reset reason: a row read of `ended` or `missing`, or no row (`noteDead`). */
export const SLOW_RECOVERY_RESET_ROW_DEAD = 'row-dead'
/** Reset reason: the `dead` reading from `ErrSystemInstallDisappeared` (`noteInstallGone`). */
export const SLOW_RECOVERY_RESET_INSTALL_GONE = 'install-gone'
/** Reset reason: a run whose reconnect ended with another verdict, or that found the persona already connected with its stream (`noteOther`). */
export const SLOW_RECOVERY_RESET_OTHER_VERDICT = RESTART_SLOW_RECOVERY_OTHER_VERDICT
/** Reset reason: an escalate-dead verdict whose re-probe read `pending` (`noteOther`). */
export const SLOW_RECOVERY_RESET_PENDING_REPROBE = RESTART_SLOW_RECOVERY_OTHER_PENDING_REPROBE
/** Reset reason: a run whose first liveness probe read `pending` (`noteOther`). */
export const SLOW_RECOVERY_RESET_PENDING_PROBE = RESTART_SLOW_RECOVERY_OTHER_PENDING_PROBE
/** Reset reason: a health-check tick found the persona `live`, connected and with its stream (`noteHealthy`). */
export const SLOW_RECOVERY_RESET_HEALTHY = 'healthy'
/** Reset reason: the persona latched (`endForLatch`). */
export const SLOW_RECOVERY_RESET_LATCHED = 'latched'

/** Why a persona's count was reset, or its episode ended. */
export type SlowRecoveryResetReason =
  | typeof SLOW_RECOVERY_RESET_ROW_DEAD
  | typeof SLOW_RECOVERY_RESET_INSTALL_GONE
  | SlowRecoveryOtherReason
  | typeof SLOW_RECOVERY_RESET_HEALTHY
  | typeof SLOW_RECOVERY_RESET_LATCHED

/** The text each reset reason's lines carry. */
export const SLOW_RECOVERY_RESET_TEXT: Readonly<Record<SlowRecoveryResetReason, string>> = Object.freeze({
  [SLOW_RECOVERY_RESET_ROW_DEAD]: 'its row read ended or missing, or no row was found',
  [SLOW_RECOVERY_RESET_INSTALL_GONE]: 'its liveness read dead from ErrSystemInstallDisappeared, which reads no row',
  [SLOW_RECOVERY_RESET_OTHER_VERDICT]: 'a restart run ended with a verdict other than escalate-dead',
  [SLOW_RECOVERY_RESET_PENDING_REPROBE]: "an escalate-dead verdict's re-probe read the row pending, which is not counted",
  [SLOW_RECOVERY_RESET_PENDING_PROBE]: "a restart run's liveness probe read the row pending",
  [SLOW_RECOVERY_RESET_HEALTHY]: 'a health check found the session live, connected and with its stream',
  [SLOW_RECOVERY_RESET_LATCHED]: 'the persona latched',
})

/** The head of every tracker line for persona `key`. */
function slowRecoveryLineHead(key: string): string {
  return `[slack] slow-recovery: persona=${key}`
}

/** The line for a `noteLive` that brought persona `key`'s count to `count`. */
export function slowRecoveryCountLine(key: string, count: number): string {
  return `${slowRecoveryLineHead(key)} count ${count} of ${SLOW_RECOVERY_POST_THRESHOLD} — an escalate-dead verdict's re-probe still reads the row live`
}

/** The line for the notice posted for persona `key` at `count` (b.jg5 SRJ-1010). */
export function slowRecoveryNoticePostedLine(key: string, count: number): string {
  return `${slowRecoveryLineHead(key)} notice posted — ${count} consecutive escalate-dead verdicts whose re-probe still reads the row live`
}

/** The line for a notice not posted for persona `key` because the episodes are closed (shutdown). */
export function slowRecoveryNoticeNotPostedLine(key: string): string {
  return `${slowRecoveryLineHead(key)} notice not posted — the server is shutting down`
}

/** The line for persona `key`'s count reset from `prior` (above 0) for `reason`. */
export function slowRecoveryCountResetLine(key: string, prior: number, reason: SlowRecoveryResetReason): string {
  return `${slowRecoveryLineHead(key)} count reset from ${prior} — ${SLOW_RECOVERY_RESET_TEXT[reason]}`
}

/** The line for persona `key`'s open episode ended for `reason`. */
export function slowRecoveryEpisodeEndedLine(key: string, reason: SlowRecoveryResetReason): string {
  return `${slowRecoveryLineHead(key)} episode ended — ${SLOW_RECOVERY_RESET_TEXT[reason]}`
}

/** The line for a note on persona `key` that threw inside (an episodes call); `described` is the thrown value through `describeThrownValue`. */
export function slowRecoveryFailedLine(key: string, described: string): string {
  return `${slowRecoveryLineHead(key)} failed: ${described}`
}

/** `noteOther`'s reason as given when it is one of `SlowRecoveryOtherReason`'s, else the other-verdict reason. */
function otherReason(reason: unknown): SlowRecoveryOtherReason {
  return reason === SLOW_RECOVERY_RESET_PENDING_REPROBE || reason === SLOW_RECOVERY_RESET_PENDING_PROBE
    ? reason
    : SLOW_RECOVERY_RESET_OTHER_VERDICT
}

/** What `noteLive` did: counted below the threshold or with the episode open, posted the notice, or posted nothing because the episodes are closed. */
export type SlowRecoveryLiveResult = 'counted' | 'posted' | 'closed'

/** Dependencies of `createSlowRecoveryTracker`. */
export interface SlowRecoveryTrackerDeps {
  /** The server's episodes instance: holds the count and the episode, and its sink posts the notice. */
  episodes: PersonaEpisodes
  /** Receives each `[slack] slow-recovery:` line (the server log). A throwing log is swallowed. */
  log: (line: string) => void
}

/** One server's slow-recovery tracker; the restart work's slow-recovery observer. */
export interface SlowRecoveryTracker extends RestartSlowRecoveryObserver {
  /** An escalate-dead verdict whose re-probe reads the row live: count one; at the threshold with no episode open, begin it and post once. */
  noteLive(key: string): SlowRecoveryLiveResult
  /** A row read of `ended` or `missing`, or no row: reset the count and end the episode silently. */
  noteDead(key: string): void
  /** The `dead` reading from `ErrSystemInstallDisappeared`: reset the count; an open episode stays open. */
  noteInstallGone(key: string): void
  /** Another verdict, a session already connected, or a `pending` first probe or re-probe: reset the count; an open episode stays open. */
  noteOther(key: string, reason: SlowRecoveryOtherReason): void
  /** A health-check tick found the persona `live`, connected and with its stream: reset the count; an open episode stays open. */
  noteHealthy(key: string): void
  /** The persona latched: reset the count and end the episode silently. */
  endForLatch(key: string): void
  /** The persona's current count. */
  count(key: string): number
  /** Whether the persona's slow-recovery episode is open. */
  isOpen(key: string): boolean
}

/**
 * Build one server's slow-recovery tracker over `deps.episodes`; see the
 * module comment. Nothing is read, posted or logged at creation.
 */
export function createSlowRecoveryTracker(deps: SlowRecoveryTrackerDeps): SlowRecoveryTracker {
  const kind = PERSONA_EPISODE_KIND_SLOW_DEAD_SESSION_RECOVERY
  const { episodes } = deps

  function log(text: string): void {
    try {
      deps.log(text)
    } catch {
      /* a failing logger must not change what the tracker does */
    }
  }

  /** Reset the count, logging when it was above 0. */
  function reset(key: string, reason: SlowRecoveryResetReason): void {
    const prior = episodes.resetCount(key, kind)
    if (prior > 0) log(slowRecoveryCountResetLine(key, prior, reason))
  }

  /** End the open episode silently, logging when one was open. */
  function endEpisode(key: string, reason: SlowRecoveryResetReason): void {
    if (episodes.end(key, kind)) log(slowRecoveryEpisodeEndedLine(key, reason))
  }

  /** Run `step`; a throw is logged and swallowed, so the restart work is never disturbed. */
  function guarded<T>(key: string, step: () => T, fallback: T): T {
    try {
      return step()
    } catch (err) {
      log(slowRecoveryFailedLine(key, describeThrownValue(err)))
      return fallback
    }
  }

  return {
    noteLive: (key) =>
      guarded<SlowRecoveryLiveResult>(
        key,
        () => {
          const count = episodes.addCount(key, kind)
          log(slowRecoveryCountLine(key, count))
          if (count < SLOW_RECOVERY_POST_THRESHOLD || episodes.isOpen(key, kind)) return 'counted'
          if (episodes.begin(key, kind) === 'closed') {
            log(slowRecoveryNoticeNotPostedLine(key))
            return 'closed'
          }
          if (!episodes.post(key, kind, slowRecoveryText(key))) return 'counted'
          log(slowRecoveryNoticePostedLine(key, count))
          return 'posted'
        },
        'counted',
      ),

    noteDead: (key) =>
      guarded(
        key,
        () => {
          reset(key, SLOW_RECOVERY_RESET_ROW_DEAD)
          endEpisode(key, SLOW_RECOVERY_RESET_ROW_DEAD)
        },
        undefined,
      ),

    noteInstallGone: (key) => guarded(key, () => reset(key, SLOW_RECOVERY_RESET_INSTALL_GONE), undefined),

    noteOther: (key, reason) => guarded(key, () => reset(key, otherReason(reason)), undefined),

    noteHealthy: (key) => guarded(key, () => reset(key, SLOW_RECOVERY_RESET_HEALTHY), undefined),

    endForLatch: (key) =>
      guarded(
        key,
        () => {
          reset(key, SLOW_RECOVERY_RESET_LATCHED)
          endEpisode(key, SLOW_RECOVERY_RESET_LATCHED)
        },
        undefined,
      ),

    count: (key) => episodes.count(key, kind),

    isOpen: (key) => episodes.isOpen(key, kind),
  }
}
