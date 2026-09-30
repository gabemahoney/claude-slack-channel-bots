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
 *   teardown); `forgetAll()` ends every episode (shutdown, test reset).
 *   Neither posts anything.
 *
 * Kinds and their posters. One label per row of SRJ-1016's table
 * (`PERSONA_EPISODE_KINDS`). None has a poster yet: `tmux-unresponsive`'s
 * episode is begun and ended by its condition (below), and its posts come
 * with its onset, alert and recovery (b.jg5 E10); every other kind's begin
 * and end triggers and text come with the Epic that posts it, named on its
 * label below.
 *
 * The `tmux-unresponsive` condition (b.jg5 SRJ-307, SRJ-310).
 * `createTmuxUnresponsiveCondition(deps)` builds it over one episodes
 * instance: the condition holds for a persona while its `tmux-unresponsive`
 * episode is open, and the episode's start time is the first refusal's time.
 * It is a per-persona condition, not an outage class: it never raises or
 * clears an outage flag, posts nothing and records no bad-stretch history.
 *
 * - `start(key, verb, error)` starts the condition (opens the episode, the
 *   first refusal's time from the episodes' clock, one started line) or
 *   continues it (the first refusal's time kept, no line). Its only caller is
 *   the outage state's reporting point (`src/outage-state.ts`), for a
 *   tmux-touching call's UNAVAILABLE inside a launch or recovery attempt for
 *   the persona.
 * - `holds(key)` and `firstRefusalAt(key)` read it.
 * - `end(key, reason, reading?)` ends a holding condition once: the episode
 *   ends, one ended line names the reason, and the injected condition-end
 *   hook is called once with the reading the end brings (a tick's or a
 *   retry's live reading; `pending` for a successful `spawn` or `resume`;
 *   none for any other tmux-touching success or GONE). It
 *   answers whether the episode's onset had been posted. On a persona that
 *   does not hold it, it does nothing.
 * - The episodes' `forget(key)` (a teardown) and `forgetAll()` drop a holding
 *   condition silently, with no line and no hook call.
 *
 * Log lines, to the injected log (a throwing log is swallowed):
 *
 *   [slack] persona-episodes: persona=<key> tmux-unresponsive started — <verb> failed: <describeAgentDirectorFailure(error)>
 *   [slack] persona-episodes: persona=<key> tmux-unresponsive ended — <reason text>
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
 * through the injected log, with the text counted as posted. The clock is
 * injected in `PersonaConnectionClock`'s shape (`now`, `setTimeout`,
 * `clearTimeout`; the shared fake clock satisfies it), the real clock by
 * default. No agent-director call, no Slack client and no module-scope
 * state: each instance keeps its own episodes, and nothing is read, posted or
 * logged at import or at creation.
 *
 * SPDX-License-Identifier: MIT
 */

import { describeAgentDirectorFailure, type AdVerb } from './ad-error-class.ts'
import { describeThrownValue } from './persona-connection-errors.ts'
import { SYSTEM_PERSONA_CONNECTION_CLOCK, type PersonaConnectionClock } from './persona-connections.ts'

// ---------------------------------------------------------------------------
// Kinds (b.jg5 SRJ-1016)
// ---------------------------------------------------------------------------

/** CONFLICT (SRJ-506): from the latch being set until it clears; a new case begins a new episode. No poster yet (b.jg5 E13). */
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

/** `tmux-unresponsive` (SRJ-307 to SRJ-310): from the first refusal until the condition ends. No poster yet (this Epic's condition). */
export const PERSONA_EPISODE_KIND_TMUX_UNRESPONSIVE = 'tmux-unresponsive'

/** `ad-config-malformed` (SRJ-316): as the `ad-unreachable` outage's episode. No poster yet (b.jg5 E12). */
export const PERSONA_EPISODE_KIND_AD_CONFIG_MALFORMED = 'ad-config-malformed'

/** `ErrInvalidFlags` hold: as SRJ-207 states. No poster yet (b.jg5 E23). */
export const PERSONA_EPISODE_KIND_INVALID_FLAGS_HOLD = 'invalid-flags-hold'

/** Unclassified error: as SRJ-313 states. No poster yet (b.jg5 E12). */
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
  /** Receives each `[slack]` line (the server log): only a sink that throws or rejects. A throwing log is swallowed. */
  log: (line: string) => void
  /** Clock and timers; `SYSTEM_PERSONA_CONNECTION_CLOCK` by default. */
  clock?: PersonaEpisodesClock
}

/** What `begin` did: opened an episode where none was open, kept the open one, or began a new one for a new case. */
export type PersonaEpisodeBeginResult = 'begun' | 'kept' | 'new-case'

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
  /**
   * Open the persona's episode of this kind, or keep the open one. A case
   * that differs from the open episode's begins a new episode; no case, or
   * the same case, keeps it.
   */
  begin(key: string, kind: PersonaEpisodeKind, caseLabel?: string): PersonaEpisodeBeginResult
  /** Whether the persona has an open episode of this kind. */
  isOpen(key: string, kind: PersonaEpisodeKind): boolean
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
  /** End every episode of every persona silently. */
  forgetAll(): void
}

/** One open episode. */
interface OpenEpisode {
  readonly episode: number
  readonly startedAt: number
  readonly caseLabel?: string
  readonly posted: Set<string>
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

  function open(key: string, kind: PersonaEpisodeKind): OpenEpisode | undefined {
    return byKey.get(key)?.get(kind)
  }

  function start(key: string, kind: PersonaEpisodeKind, caseLabel: string | undefined): void {
    let kinds = byKey.get(key)
    if (kinds === undefined) {
      kinds = new Map()
      byKey.set(key, kinds)
    }
    const startedAt = clock.now()
    lastEpisode++
    kinds.set(kind, {
      episode: lastEpisode,
      startedAt,
      ...(caseLabel === undefined ? {} : { caseLabel }),
      posted: new Set(),
    })
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
    begin(key, kind, caseLabel) {
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
      if (kinds === undefined || !kinds.delete(kind)) return false
      if (kinds.size === 0) byKey.delete(key)
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
      byKey.delete(key)
    },

    forgetAll() {
      byKey.clear()
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

/** What `start` did: started the condition, or continued one already holding. */
export type TmuxUnresponsiveStartResult = 'started' | 'continued'

/**
 * What `end` did: nothing (`not-holding`), or ended a holding condition whose
 * onset had not been posted (`ended`) or had been (`ended-after-onset`).
 */
export type TmuxUnresponsiveEndResult = 'not-holding' | 'ended' | 'ended-after-onset'

/**
 * Where the outage state's wrappers start and end the condition
 * (`OutageStateDeps.conditionSink`, `src/outage-state.ts`). The condition is
 * one.
 */
export interface TmuxUnresponsiveSink {
  start(key: string, verb: AdVerb, error: unknown): unknown
  end(key: string, reason: TmuxUnresponsiveEndReason, reading?: string): unknown
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
}

/** One server's `tmux-unresponsive` conditions, one per persona key. */
export interface TmuxUnresponsiveCondition extends TmuxUnresponsiveSink {
  /**
   * Start persona `key`'s condition for a refusal `error` from `verb` (one
   * started line; the first refusal's time from the clock), or continue it
   * while it holds (its first refusal's time kept, no line).
   */
  start(key: string, verb: AdVerb, error: unknown): TmuxUnresponsiveStartResult
  /** Whether persona `key`'s condition holds. */
  holds(key: string): boolean
  /** The first refusal's time, in clock milliseconds, while the condition holds; else `undefined`. */
  firstRefusalAt(key: string): number | undefined
  /**
   * End persona `key`'s condition for `reason`: when it holds, end its
   * episode, log one ended line and call the condition-end hook once with
   * `reading`, and answer whether the onset had been posted; when it does
   * not hold, answer `not-holding` and do nothing else.
   */
  end(key: string, reason: TmuxUnresponsiveEndReason, reading?: string): TmuxUnresponsiveEndResult
}

/**
 * Build one server's `tmux-unresponsive` conditions over `deps.episodes`; see
 * the module comment. Nothing is read, posted or logged at creation.
 */
export function createTmuxUnresponsiveCondition(deps: TmuxUnresponsiveConditionDeps): TmuxUnresponsiveCondition {
  const kind = PERSONA_EPISODE_KIND_TMUX_UNRESPONSIVE
  const { episodes } = deps

  return {
    start(key, verb, error) {
      if (episodes.isOpen(key, kind)) return 'continued'
      episodes.begin(key, kind)
      safeLog(
        deps.log,
        `[slack] persona-episodes: persona=${key} ${kind} started — ${verb} failed: ${describeAgentDirectorFailure(error)}`,
      )
      return 'started'
    },

    holds: (key) => episodes.isOpen(key, kind),

    firstRefusalAt: (key) => episodes.view(key, kind)?.startedAt,

    end(key, reason, reading) {
      if (!episodes.isOpen(key, kind)) return 'not-holding'
      const onsetPosted = episodes.hasPosted(key, kind)
      episodes.end(key, kind)
      safeLog(deps.log, `[slack] persona-episodes: persona=${key} ${kind} ended — ${endText(reason)}`)
      try {
        deps.conditionEnded?.(key, reading)
      } catch {
        /* a failing hook must not change how the condition ended */
      }
      return onsetPosted ? 'ended-after-onset' : 'ended'
    },
  }
}

/** The ended line's text for `reason`; an unknown reason is named as such. Never throws. */
function endText(reason: unknown): string {
  return typeof reason === 'string' && Object.hasOwn(TMUX_UNRESPONSIVE_END_TEXT, reason)
    ? TMUX_UNRESPONSIVE_END_TEXT[reason as TmuxUnresponsiveEndReason]
    : 'an unnamed reason'
}
