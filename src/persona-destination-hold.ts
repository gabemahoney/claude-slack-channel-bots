/**
 * persona-destination-hold.ts — Hold and retry a persona's permission prompts
 * and server notices while its destination fails (b.av2 SR-7.1 failure part,
 * SR-3.2, SR-10.3).
 *
 * A post to a persona's destination (`persona-destination.ts`) can fail: the
 * app was not re-installed with `im:write`, so `conversations.open` answers
 * `missing_scope`; the bot is not in the channel (`not_in_channel`); Slack
 * cannot be reached. Such a failure is a destination failure and opens an
 * episode for the persona. While the episode is open the persona is held:
 * nothing is attempted for it before its next retry is due, on its own SR-3.2
 * schedule (5 s doubling to 300 s, no give-up, never shorter than a
 * `retryAfter` the error carries). Nothing is lost and nothing is spammed.
 *
 * Which failures hold the persona:
 * - every failure of the open (`conversations.open`, including an open that
 *   returns no conversation ID), and every failure of the post
 *   (`chat.postMessage`) except a payload error specific to one message
 *   (`MESSAGE_PAYLOAD_ERRORS`: `invalid_blocks`, `msg_too_long`, …). So
 *   `missing_scope`, `not_in_channel`, `channel_not_found`, `is_archived`,
 *   any other conversation or permission error, and the Slack-unreachable
 *   class (`network_error`, `aborted`, `unknown_error`, `ratelimited`,
 *   timeouts) are held and retried, never dropped.
 * - A payload error is not a destination failure (`isDestinationFailure`): it
 *   neither opens nor extends an episode and never holds the persona's other
 *   prompts and notices. The item follows its per-item handling: a prompt is
 *   logged by the poller and tried again on its next tick; a notice is handed
 *   to its failure callback and dropped (it would fail the same way again).
 * - A refusal (a `dm` destination with DMs off or no contact, which the loader
 *   rejects) makes no Slack call and is not a failure; the resolver logs it.
 *
 * Two ways in:
 * - Re-derived items (the poller's prompts and its stuck-prompt warning) ask
 *   `begin(key)` for an attempt. It answers "not now" (undefined) while the
 *   persona is held and its retry is not due, or while a retry for it is in
 *   flight (the in-flight guard: at most one retry at a time, and an attempt
 *   can take about 30 min, see below). Otherwise the attempt posts through
 *   the resolver and reports its own outcome. Nothing is queued: the poller
 *   derives the prompt again on a later tick.
 * - Notices are handed over with `deliver`. A persona that is not held (no
 *   episode open, no notice waiting) has the notice attempted at once, with
 *   the post issued before `deliver` first yields (so a channel destination
 *   keeps the raised order the notifier relies on). Otherwise the notice
 *   joins the persona's FIFO of held notices, behind the earlier ones, and
 *   nothing is attempted. When the persona's retry is due its own timer
 *   attempts the held notices in order, one at a time: the first failure
 *   stops it and reschedules; once one is posted the rest follow. A success
 *   reported by a re-derived item also ends the episode, and the held notices
 *   are then attempted at once, in order, with no wait for a timer.
 *
 * Every attempt resolves the persona, its client and its destination at that
 * moment (`getPersona`, `clientFor`, the resolver), never from a value
 * captured when the notice was held, so a destination or contact changed
 * while a notice waits is honoured. Every destination this module names or
 * compares comes from the one destination rule (`personaDestinationOf`,
 * b.av2 SR-7.1, b.deo SRI-701) applied to the persona of that attempt;
 * nothing here reads a destination setting itself. A retry that comes due while the persona
 * has no client (it is not up) keeps it held and waits again, with no line;
 * one whose persona or client lookup throws waits again the same way, with
 * one line per run of such throws (never a restart at once). A persona no
 * longer applied when its retry comes due has its held notices dropped with
 * one line.
 *
 * Episodes:
 * - An episode opens at the first destination failure when none is open, with
 *   one `persona-destination-failed` line (`formatPersonaDiagnostic`) naming
 *   the persona (JSON-quoted name, key beside it, `personas[i]`), the
 *   destination (the channel ID, or `dm`), the failed step and the Slack error
 *   code; for `missing_scope` on the open it names the `im:write` scope and
 *   says the app must be re-installed to gain it.
 * - A failed retry advances the schedule and logs nothing, unless it failed at
 *   a destination no line of the open episode has named yet (the persona's
 *   destination changed in place): then it logs one fresh opening line for
 *   that destination, once per distinct destination per episode.
 * - A failure from an attempt that started before the last episode change
 *   (an episode opened or closed since; e.g. the notifier's concurrent flush,
 *   all waiting on one DM open, or a slow post that fails after a retry has
 *   ended the episode) is stale: it logs nothing, opens no episode and does
 *   not advance the schedule. Its notice is re-queued in submission order
 *   (under the one episode line, or attempted again at once when no episode
 *   is open, so a genuine failure then opens one). A success from an attempt
 *   that started before the open episode opened changes nothing either: it is
 *   older evidence than the failure that opened the episode.
 * - The first successful retry ends the episode with one cleared line (the
 *   same class label, the cause starting `cleared:`, as the other persona
 *   lines' clears do, naming
 *   the destination that post went to) and resets the schedule; a later
 *   failure opens a new episode and logs again.
 * - Nothing is logged per attempt. The code is copied only when it is a short
 *   identifier (`safeFailureCode`); nothing else from the thrown value reaches
 *   a line, so no token value can.
 *
 * Held notices are capped at `MAX_HELD_NOTICES_PER_PERSONA` per persona: past
 * it the oldest held notice (not one being attempted) is dropped with one
 * line and never posted. Prompts are never queued here, so the cap never
 * drops a prompt.
 *
 * Timers: a persona's timer exists only while it has held notices and is
 * waiting for its retry; re-derived items compare the clock with the due
 * time, so a hold used only by the poller never creates a timer. Every timer
 * callback catches its own errors. `cancel(key)` drops the persona's held
 * notices, clears its timer and closes its episode (the persona's teardown); an
 * attempt in flight then changes nothing. `cancelAll()` cancels every persona
 * (shutdown). Neither posts what it drops; each logs one line per persona
 * that had notices held (`hold cancelled` / `shutting down`), none otherwise.
 *
 * A re-derived attempt must end: `post` settles it even when the resolver
 * throws, and a caller that throws before posting must `release` it (a
 * `finally`), or the persona would stay held with no timer.
 *
 * Production caveat (accepted): the long-lived Web API client
 * (`persona-slack-clients.ts`) keeps the library's own retry policy, about
 * ten retries over about 30 minutes, and waits out rate limits itself. So a
 * network-class failure reaches the hold only after about 30 minutes, and a
 * rate-limited rejection carrying `retryAfter` does not reach it at all; only
 * platform errors (`missing_scope`, `not_in_channel`, `channel_not_found`)
 * arrive at once. The hold handles every class the same way anyway; tests
 * drive it through the Slack stub.
 *
 * Per persona (b.av2 SR-3.3): each persona has its own entry, schedule, FIFO,
 * timer and in-flight guard; nothing spans two personas, so one persona's
 * episode never delays, holds or logs for another.
 *
 * Pure module (b.av2 SR-13.1): no module-scope state, no I/O of its own and
 * nothing runs at import; building a hold starts no timer. The resolver, the
 * persona and client lookups, the clock and the logger are injected.
 *
 * SPDX-License-Identifier: MIT
 */

import type { Persona } from './config.ts'
import { describeThrownValue } from './persona-connection-errors.ts'
import { SYSTEM_PERSONA_CONNECTION_CLOCK, type PersonaConnectionClock } from './persona-connections.ts'
import {
  DM_OPEN_SCOPE,
  MISSING_SCOPE_ERROR,
  safeFailureCode,
  type DestinationFailure,
  type DestinationMessage,
  type DestinationPostResult,
  type DestinationSlackClient,
  type DestinationStep,
  type PersonaDestinations,
  personaDestinationOf,
} from './persona-destination.ts'
import { PERSONA_DESTINATION_FAILED, formatPersonaDiagnostic } from './persona-diagnostics.ts'
import { renderPersonaRef } from './persona-identity.ts'
import { PERSONA_RETRY_BASE_S, createPersonaRetrySchedule, type PersonaRetrySchedule } from './persona-retry-schedule.ts'
import { slackRetryAfterSeconds } from './persona-slack-validation.ts'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Most notices held for one persona (b.av2 SR-7.2): by the notifier while the
 * persona's client is not validated, and by the destination hold while its
 * destination fails. Past it the oldest held notice is dropped with a log
 * line, so a queue keeps the most recent notices and a persona that is broken,
 * retrying or refused for a long time holds a bounded amount.
 */
export const MAX_HELD_NOTICES_PER_PERSONA = 20

/**
 * `chat.postMessage` errors about the message itself, not the destination:
 * the same message fails the same way wherever and whenever it is posted.
 * They never open or extend an episode.
 */
export const MESSAGE_PAYLOAD_ERRORS: ReadonlySet<string> = new Set([
  'invalid_blocks',
  'invalid_blocks_format',
  'msg_too_long',
  'msg_blocks_too_long',
  'no_text',
  'too_many_attachments',
  'invalid_attachments',
  'attachment_payload_limit_exceeded',
  'invalid_metadata_format',
  'invalid_metadata_schema',
  'metadata_too_large',
])

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** What a notice's failure callback learns about one failed attempt. */
export interface HoldNoticeFailureInfo {
  /** True at the notice's first failed attempt only. */
  first: boolean
  /**
   * True when the notice stays held for a retry (a destination failure);
   * false when it is dropped (a failure specific to it, `MESSAGE_PAYLOAD_ERRORS`).
   */
  held: boolean
}

/** A notice handed to the hold. */
export interface HoldNotice {
  /** The message to post: the notice text as posted. */
  message: DestinationMessage
  /** One line naming the notice (its first line), for the dropped-notice lines. */
  summary: string
  /** Called after each failed attempt of this notice. Its throw is logged, never propagated. */
  onAttemptFailed?(failure: DestinationFailure, info: HoldNoticeFailureInfo): void
}

/**
 * One gated attempt for a re-derived item. Use it once: `post`, or `release`
 * when nothing is posted after all. Callers release in a `finally`: a release
 * after `post` (or a second release) is a no-op, and an attempt never ended
 * leaves a retrying persona held for good.
 */
export interface HoldAttempt {
  /**
   * Post through the resolver and report the outcome to the hold; resolves
   * with the resolver's result. Never rejects while the resolver keeps its
   * never-rejects contract; the attempt ends even if it does not.
   */
  post(persona: Persona, client: DestinationSlackClient, message: DestinationMessage): Promise<DestinationPostResult>
  /** Give the attempt back without posting (no client after all). */
  release(): void
}

/** A read-only view of one persona's hold, for tests and diagnostics. */
export interface PersonaDestinationHoldView {
  /** True while an episode is open. */
  held: boolean
  /** Notices waiting in the persona's FIFO. */
  heldNotices: number
  /** When the next retry is due (clock milliseconds) while an episode is open, else undefined. */
  nextDueAt: number | undefined
}

/** Dependencies injected into `createPersonaDestinationHold`. */
export interface PersonaDestinationHoldDeps {
  /** The destination resolver every attempt posts through (the one shared instance in production). */
  destinations: PersonaDestinations
  /** The applied persona with this key, or undefined; read at each held-notice retry. */
  getPersona(key: string): Persona | undefined
  /** The persona's client, or undefined while it is not up; read at each held-notice retry. */
  clientFor(key: string): DestinationSlackClient | undefined
  /** Clock and timers; defaults to the real ones. */
  clock?: PersonaConnectionClock
  /** Writes one `[slack]` server-log line. */
  log(line: string): void
}

/** A destination hold: per-persona episodes, retries and held notices. */
export interface PersonaDestinationHold {
  /**
   * Ask to attempt a re-derived item for the persona now: an attempt, or
   * undefined while the persona is held and its retry is not due or a retry
   * for it is in flight.
   */
  begin(key: string): HoldAttempt | undefined
  /**
   * Hand over one notice for the persona, whose client the caller has just
   * read. Attempted at once when the persona is not held (the post issued
   * before this first yields); held otherwise. Resolves once the immediate
   * attempt settles, or at once when the notice is held. Never rejects.
   */
  deliver(persona: Persona, client: DestinationSlackClient, notice: HoldNotice): Promise<void>
  /**
   * Drop the persona's held notices, clear its timer and close its episode.
   * Logs one `hold cancelled` line when notices were held, none otherwise.
   * Idempotent.
   */
  cancel(key: string): void
  /** Cancel every persona (shutdown): one `shutting down` line per persona that had notices held. */
  cancelAll(): void
  /** The persona's hold as it is now. */
  view(key: string): PersonaDestinationHoldView
}

/** A timer handle, boxed so any value the clock returns (even `undefined`) is a handle. */
interface TimerBox {
  handle: unknown
}

/**
 * An open episode: what its lines name, copied from the failure that opened
 * it, or from the latest one at a destination not yet named in the episode.
 */
interface OpenEpisode {
  name: string
  index: number
  destination: string
  step: DestinationStep
  code: string
  /** Every destination an opening line of this episode has named. */
  named: Set<string>
}

/** A notice in a persona's FIFO. */
interface QueuedNotice {
  /** Submission order across the hold, so re-queued notices keep it. */
  seq: number
  notice: HoldNotice
  /** Set once the notice has failed an attempt (its callback's `first`). */
  failed: boolean
}

/** Everything the hold keeps for one persona. Nothing here is shared with another persona. */
interface HoldEntry {
  readonly key: string
  readonly schedule: PersonaRetrySchedule
  episode: OpenEpisode | undefined
  /**
   * Bumped whenever an episode opens or closes, so an attempt knows whether
   * it started in the episode that is open when it settles.
   */
  generation: number
  /** When the next retry is due, while an episode is open. */
  dueAt: number
  /** The wait last taken from the schedule, reused when a retry finds no client. */
  delayMs: number
  /** A retry (an attempt made while held) or a held-notice attempt is in flight. */
  inFlight: boolean
  /** The notice being attempted by the drain, which the cap never drops. */
  attempting: QueuedNotice | undefined
  /** The held notices are being attempted in order. */
  draining: boolean
  readonly notices: QueuedNotice[]
  timer: TimerBox | undefined
  /** The persona's name as last handed over with a notice, for the cancel lines. */
  name: string | undefined
  /** A held-notice retry found the persona or client lookup throwing; cleared by a lookup that returns. */
  lookupFailing: boolean
}

/** How a settled attempt counts. */
type SettledAs = 'posted' | 'refused' | 'payload' | 'destination'

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/**
 * Whether a failed open or post is a destination failure (held and retried):
 * every open failure, and every post failure except a payload error specific
 * to the message (`MESSAGE_PAYLOAD_ERRORS`). Pure.
 */
export function isDestinationFailure(failure: Pick<DestinationFailure, 'step' | 'code'>): boolean {
  return failure.step !== 'chat.postMessage' || !MESSAGE_PAYLOAD_ERRORS.has(failure.code)
}

/** The cause of an episode's opening line. Pure. */
function openingCause(episode: OpenEpisode): string {
  const scope = episode.step === 'conversations.open' && episode.code === MISSING_SCOPE_ERROR
    ? ` — the Slack app lacks the ${DM_OPEN_SCOPE} scope: re-install the app with ${DM_OPEN_SCOPE} to grant it`
    : ''
  return `${episode.step} failed for destination=${episode.destination} with error ${episode.code}${scope}; ` +
    'holding its permission prompts and notices and retrying with backoff'
}

/** The cause of an episode's cleared line, naming the destination that accepted the post. Pure. */
function clearedCause(episode: OpenEpisode, destination: string): string {
  return `cleared: destination=${destination} accepts posts again ` +
    `(was ${episode.step} error ${episode.code}); delivering what was held`
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/** Build a destination hold with no persona held and no timer. */
export function createPersonaDestinationHold(deps: PersonaDestinationHoldDeps): PersonaDestinationHold {
  const clock = deps.clock ?? SYSTEM_PERSONA_CONNECTION_CLOCK
  const entries = new Map<string, HoldEntry>()
  let nextSeq = 0

  function entryFor(key: string): HoldEntry {
    let entry = entries.get(key)
    if (!entry) {
      entry = {
        key,
        schedule: createPersonaRetrySchedule(),
        episode: undefined,
        generation: 0,
        dueAt: 0,
        delayMs: PERSONA_RETRY_BASE_S * 1000,
        inFlight: false,
        attempting: undefined,
        draining: false,
        notices: [],
        timer: undefined,
        name: undefined,
        lookupFailing: false,
      }
      entries.set(key, entry)
    }
    return entry
  }

  /** False once the entry was cancelled (and possibly replaced): its late outcomes change nothing. */
  function isCurrent(entry: HoldEntry): boolean {
    return entries.get(entry.key) === entry
  }

  function isHeld(entry: HoldEntry): boolean {
    return entry.episode !== undefined && (entry.inFlight || clock.now() < entry.dueAt)
  }

  // -------------------------------------------------------------------------
  // Episodes
  // -------------------------------------------------------------------------

  /**
   * Account one settled attempt that started at generation `started`: open,
   * advance or close the episode. Returns how the attempt counts.
   */
  function settle(entry: HoldEntry, started: number, persona: Persona, result: DestinationPostResult): SettledAs {
    const current = entry.episode !== undefined && started === entry.generation
    if (result.outcome === 'posted') {
      if (current) closeEpisode(entry, personaDestinationOf(persona))
      return 'posted'
    }
    if (result.outcome === 'refused') return 'refused'
    if (!isDestinationFailure(result)) return 'payload'
    // Stale: the episode opened or closed since this attempt started, so the
    // failure is older evidence than that change. Log nothing, schedule
    // nothing; the caller re-queues a notice and `ensureProgress` retries it.
    if (started !== entry.generation) return 'destination'
    if (entry.episode === undefined) openEpisode(entry, persona, result)
    else {
      // The persona's destination changed in place while the episode is open:
      // name the new destination once, in a fresh opening line.
      if (!entry.episode.named.has(personaDestinationOf(persona))) nameDestination(entry, entry.episode, persona, result)
      scheduleRetry(entry, result)
    }
    return 'destination'
  }

  function openEpisode(entry: HoldEntry, persona: Persona, failure: DestinationFailure): void {
    const destination = personaDestinationOf(persona)
    const episode: OpenEpisode = {
      name: persona.name,
      index: persona.index,
      destination,
      step: failure.step,
      code: safeFailureCode(failure.code),
      named: new Set([destination]),
    }
    entry.episode = episode
    entry.generation += 1
    logOpening(entry, episode)
    scheduleRetry(entry, failure)
  }

  /** Copy a failure at a destination not yet named in the open episode into it and log its opening line. */
  function nameDestination(entry: HoldEntry, episode: OpenEpisode, persona: Persona, failure: DestinationFailure): void {
    const destination = personaDestinationOf(persona)
    episode.name = persona.name
    episode.index = persona.index
    episode.destination = destination
    episode.step = failure.step
    episode.code = safeFailureCode(failure.code)
    episode.named.add(destination)
    logOpening(entry, episode)
  }

  function logOpening(entry: HoldEntry, episode: OpenEpisode): void {
    deps.log(formatPersonaDiagnostic({
      class: PERSONA_DESTINATION_FAILED,
      name: episode.name,
      key: entry.key,
      index: episode.index,
      cause: openingCause(episode),
    }))
  }

  /** Take the next wait from the persona's schedule; the retry is due after it. */
  function scheduleRetry(entry: HoldEntry, failure: DestinationFailure): void {
    entry.delayMs = entry.schedule.nextDelayMs(slackRetryAfterSeconds(failure.error))
    entry.dueAt = clock.now() + entry.delayMs
    clearTimer(entry)
  }

  /** Close the open episode; its cleared line names `destination`, the one the post that ended it went to. */
  function closeEpisode(entry: HoldEntry, destination: string): void {
    const episode = entry.episode
    if (episode === undefined) return
    entry.episode = undefined
    entry.generation += 1
    entry.schedule.reset()
    entry.delayMs = PERSONA_RETRY_BASE_S * 1000
    clearTimer(entry)
    deps.log(formatPersonaDiagnostic({
      class: PERSONA_DESTINATION_FAILED,
      name: episode.name,
      key: entry.key,
      index: episode.index,
      cause: clearedCause(episode, destination),
    }))
  }

  // -------------------------------------------------------------------------
  // Held notices
  // -------------------------------------------------------------------------

  /** Insert in submission order; past the cap, drop (log, never post) the oldest one not being attempted. */
  function enqueue(entry: HoldEntry, queued: QueuedNotice, persona: Pick<Persona, 'name' | 'key'>): void {
    entry.name = persona.name
    let at = entry.notices.length
    while (at > 0 && entry.notices[at - 1]!.seq > queued.seq) at -= 1
    entry.notices.splice(at, 0, queued)
    if (entry.notices.length <= MAX_HELD_NOTICES_PER_PERSONA) return
    const oldest = entry.notices[0] === entry.attempting ? 1 : 0
    const [dropped] = entry.notices.splice(oldest, 1)
    deps.log(
      `[slack] persona-destination-hold: more than ${MAX_HELD_NOTICES_PER_PERSONA} notices held for ` +
        `${renderPersonaRef(persona.name, persona.key)} while its destination fails — oldest held notice dropped, ` +
        `not posted: ${dropped!.notice.summary}`,
    )
  }

  function removeQueued(entry: HoldEntry, queued: QueuedNotice): void {
    const at = entry.notices.indexOf(queued)
    if (at !== -1) entry.notices.splice(at, 1)
  }

  /** Run the notice's failure callback, never letting it throw. */
  function noticeFailed(entry: HoldEntry, queued: QueuedNotice, failure: DestinationFailure, held: boolean): void {
    const first = !queued.failed
    queued.failed = true
    try {
      queued.notice.onAttemptFailed?.(failure, { first, held })
    } catch (err) {
      deps.log(`[slack] persona-destination-hold: notice failure callback threw for persona=${entry.key}: ${describeThrownValue(err)}`)
    }
  }

  /**
   * Make sure held notices are on their way: attempted now when no episode
   * holds them, else a timer for the due time. Nothing while the drain runs,
   * a timer is set or a retry is in flight (its outcome calls this again).
   */
  function ensureProgress(entry: HoldEntry): void {
    if (!isCurrent(entry) || entry.notices.length === 0 || entry.draining || entry.timer !== undefined) return
    if (entry.episode === undefined) {
      runDrain(entry)
      return
    }
    if (entry.inFlight) return
    startTimer(entry, Math.max(0, entry.dueAt - clock.now()))
  }

  function startTimer(entry: HoldEntry, delayMs: number): void {
    clearTimer(entry)
    const timer: TimerBox = { handle: undefined }
    entry.timer = timer
    timer.handle = clock.setTimeout(() => {
      if (entry.timer !== timer) return
      entry.timer = undefined
      runDrain(entry)
    }, delayMs)
  }

  function clearTimer(entry: HoldEntry): void {
    const timer = entry.timer
    if (timer === undefined) return
    entry.timer = undefined
    clock.clearTimeout(timer.handle)
  }

  /** Start the drain, catching anything it throws. */
  function runDrain(entry: HoldEntry): void {
    try {
      drain(entry).catch((err) => {
        deps.log(`[slack] persona-destination-hold: retry of held notices failed for persona=${entry.key}: ${describeThrownValue(err)}`)
      })
    } catch (err) {
      deps.log(`[slack] persona-destination-hold: retry of held notices failed for persona=${entry.key}: ${describeThrownValue(err)}`)
    }
  }

  /**
   * Attempt the held notices in order, one at a time, until the FIFO is empty
   * or a destination failure (which opens or advances the episode) stops it.
   * A payload error or a refusal drops that notice and goes on.
   */
  async function drain(entry: HoldEntry): Promise<void> {
    if (entry.draining || !isCurrent(entry)) return
    entry.draining = true
    try {
      while (entry.notices.length > 0 && isCurrent(entry)) {
        if (isHeld(entry)) return
        let persona: Persona | undefined
        let client: DestinationSlackClient | undefined
        try {
          persona = deps.getPersona(entry.key)
          client = persona ? deps.clientFor(entry.key) : undefined
        } catch (err) {
          // A throwing lookup waits like a missing client (never a restart at
          // once, which could spin), with one line per run of failures.
          waitAgain(entry)
          if (!entry.lookupFailing) {
            entry.lookupFailing = true
            deps.log(
              `[slack] persona-destination-hold: persona or client lookup threw for persona=${entry.key}: ` +
                `${describeThrownValue(err)} — held notices wait and retry with backoff`,
            )
          }
          return
        }
        entry.lookupFailing = false
        if (!persona) {
          dropForUnappliedPersona(entry)
          return
        }
        if (!client) {
          // Not up: stay held and wait again, with no line.
          waitAgain(entry)
          return
        }
        const queued = entry.notices[0]!
        const started = entry.generation
        entry.inFlight = true
        entry.attempting = queued
        let result: DestinationPostResult
        try {
          result = await deps.destinations.post(persona, client, queued.notice.message)
        } finally {
          entry.inFlight = false
          entry.attempting = undefined
        }
        if (!isCurrent(entry)) return
        const settled = settle(entry, started, persona, result)
        if (settled === 'destination') {
          noticeFailed(entry, queued, result as DestinationFailure, true)
          return
        }
        removeQueued(entry, queued)
        if (settled === 'payload') noticeFailed(entry, queued, result as DestinationFailure, false)
      }
    } finally {
      entry.draining = false
      ensureProgress(entry)
    }
  }

  /** Wait the last wait again (held while an episode is open), then retry the held notices. */
  function waitAgain(entry: HoldEntry): void {
    if (entry.episode !== undefined) entry.dueAt = clock.now() + entry.delayMs
    startTimer(entry, entry.delayMs)
  }

  function dropForUnappliedPersona(entry: HoldEntry): void {
    const count = entry.notices.length
    // Removed before the line, so a throwing logger cannot leave it to be retried at once.
    remove(entry.key)
    deps.log(
      `[slack] persona-destination-hold: persona=${entry.key} is no longer applied — ` +
        `${count} held notice(s) dropped, not posted`,
    )
  }

  // -------------------------------------------------------------------------
  // Ways in
  // -------------------------------------------------------------------------

  function begin(key: string): HoldAttempt | undefined {
    const entry = entryFor(key)
    if (isHeld(entry)) return undefined
    const started = entry.generation
    const retry = entry.episode !== undefined
    if (retry) entry.inFlight = true
    let used = false
    const finish = (): boolean => {
      if (used) return false
      used = true
      if (retry) entry.inFlight = false
      return true
    }
    return {
      async post(persona, client, message) {
        let result: DestinationPostResult | undefined
        try {
          result = await deps.destinations.post(persona, client, message)
          return result
        } finally {
          // Settled even when the resolver throws, so the in-flight guard never leaks.
          if (finish() && isCurrent(entry)) {
            try {
              if (result !== undefined) settle(entry, started, persona, result)
            } finally {
              ensureProgress(entry)
            }
          }
        }
      },
      release() {
        if (finish()) ensureProgress(entry)
      },
    }
  }

  async function deliver(persona: Persona, client: DestinationSlackClient, notice: HoldNotice): Promise<void> {
    const entry = entryFor(persona.key)
    nextSeq += 1
    const queued: QueuedNotice = { seq: nextSeq, notice, failed: false }
    if (entry.episode !== undefined || entry.notices.length > 0 || entry.draining) {
      enqueue(entry, queued, persona)
      ensureProgress(entry)
      return
    }
    const started = entry.generation
    // Issued before the first `await` for a channel destination (the resolver's guarantee).
    const result = await deps.destinations.post(persona, client, notice.message)
    if (!isCurrent(entry)) return
    const settled = settle(entry, started, persona, result)
    if (settled === 'destination') {
      noticeFailed(entry, queued, result as DestinationFailure, true)
      if (!isCurrent(entry)) return
      enqueue(entry, queued, persona)
      ensureProgress(entry)
    } else if (settled === 'payload') {
      noticeFailed(entry, queued, result as DestinationFailure, false)
    }
  }

  /**
   * Forget the persona's entry: drop its held notices, clear its timer, close
   * its episode, with no line. Returns what was dropped, or undefined when
   * nothing was held.
   */
  function remove(key: string): { name: string | undefined, dropped: number } | undefined {
    const entry = entries.get(key)
    if (!entry) return undefined
    entries.delete(key)
    clearTimer(entry)
    const dropped = entry.notices.length
    entry.notices.length = 0
    entry.episode = undefined
    return dropped > 0 ? { name: entry.name, dropped } : undefined
  }

  /** One token-safe line for held notices dropped by a cancel, never posted. */
  function logDropped(why: string, key: string, name: string | undefined, dropped: number): void {
    const ref = name !== undefined ? renderPersonaRef(name, key) : `persona=${key}`
    deps.log(`[slack] persona-destination-hold: ${why} — ${dropped} held notice(s) for ${ref} dropped, not posted`)
  }

  function cancel(key: string): void {
    const gone = remove(key)
    if (gone) logDropped('hold cancelled', key, gone.name, gone.dropped)
  }

  function cancelAll(): void {
    for (const key of [...entries.keys()]) {
      const gone = remove(key)
      if (gone) logDropped('shutting down', key, gone.name, gone.dropped)
    }
  }

  function view(key: string): PersonaDestinationHoldView {
    const entry = entries.get(key)
    if (!entry) return { held: false, heldNotices: 0, nextDueAt: undefined }
    return {
      held: entry.episode !== undefined,
      heldNotices: entry.notices.length,
      nextDueAt: entry.episode !== undefined ? entry.dueAt : undefined,
    }
  }

  return { begin, deliver, cancel, cancelAll, view }
}
