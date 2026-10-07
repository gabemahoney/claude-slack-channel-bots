/**
 * persona-notifier.ts — Per-persona server notices (b.av2 SR-7.1, SR-7.2).
 *
 * Every server notice about a persona goes only to that persona's destination
 * (the channel the one destination rule names, or its DM with `dm.contact`),
 * under its identity: the post goes through the persona's own Web client, as
 * one top-level message with no `thread_ts` and no username or icon override.
 * The destination is resolved, and a DM opened when needed, by the shared
 * destination resolver (`persona-destination.ts`) through the one destination
 * rule (`personaDestinationOf`, b.av2 SR-7.1, b.deo SRI-701) over the
 * configuration in effect at each attempt (b.deo SRI-201): its
 * `permission_prompts` in declarative mode, its fungible destination in
 * fungible mode. The notifier reads no destination setting and no switch
 * itself, the lost-message notice included. The notifier adds the
 * persona reference to every notice text, so callers pass only the key and
 * the notice body.
 *
 * Routing of one notice, first match wins:
 * - the key's persona teardown window is open (b.jg5 SRJ-1003, below): one
 *   log line and one startup-errors entry, never a Slack post, never held,
 *   never dropped;
 * - the all-clear of an outage whose onset the key's window routed (b.jg5
 *   SRJ-1002, SRJ-1003), whenever it comes, after the window has closed
 *   included: one log line and one `persona-teardown-notice` entry, never a
 *   Slack post; an all-clear that also lists a class whose onset was not
 *   routed so is split when it can be (`PersonaNoticeOutage.allClearOf`):
 *   the marked classes' all-clear is written, the rest routes on below;
 * - the onset of an outage that is a notice episode of its own (b.jg5
 *   SRJ-1016: `ad-config-malformed`) for a key whose teardown is submitted
 *   and whose window is not open yet: one log line, no Slack post and no
 *   entry; its all-clear is then written as one the window routed (b.jg5
 *   SRJ-1003);
 * - no applied persona has the key: one log line, the notice is dropped;
 * - dry run (b.av2 SR-3.4): one log line with the persona reference and the
 *   notice's first line only, no Slack call;
 * - a persona whose client is not validated yet (channel or `dm`
 *   destination): held in that persona's own queue, in raised order, until
 *   `flush(key)` (or the first
 *   notice raised once the client is validated, which posts the held ones
 *   first). A queue holds at most `MAX_HELD_NOTICES_PER_PERSONA` notices: a
 *   persona that is broken or retrying may stay without a client for a long
 *   time, so once the queue is full each new notice drops the oldest held
 *   one, which is logged (one line, the notice's first line) and never
 *   posted;
 * - otherwise: handed to the destination hold (`persona-destination-hold.ts`,
 *   shared with the permission poller), which posts it to the destination at
 *   once unless the persona is held. For a `dm` destination the DM is opened
 *   (or taken from the resolver's cache) at the attempt, so a notice held
 *   before validation opens it only when flushed after, never before. When
 *   the post fails at the destination (the open or the post refused, Slack
 *   unreachable) the hold keeps the notice and retries it on the SR-3.2
 *   backoff, logging one `persona-destination-failed` line per episode, not
 *   one per notice or attempt; the notice is never lost to it. A post that
 *   fails for the message itself (`invalid_blocks`, `msg_too_long`, …) is
 *   logged here token-safely and dropped: the log line carries the error
 *   type/code, its message through `redactSlackLogText` (URL-like and
 *   token-like text replaced, one line, capped) and, when it is a short
 *   identifier, Slack's platform reason. Either way the caller's failure
 *   callback runs once, at the notice's first failed attempt. A `dm` destination the
 *   resolver refuses (DMs off or no contact, which the loader rejects) is
 *   logged by the resolver and not posted.
 *
 * Held notices are per persona (b.av2 SR-3.3): flushing one persona never
 * touches another's queue.
 *
 * The persona teardown window (b.jg5 SRJ-1002, SRJ-1003, SRJ-1013). The
 * persona teardown (`runTeardown`, `src/persona-lifecycle.ts`) opens a window
 * for its persona when its serializer turn starts (`openTeardownWindow`,
 * given the persona's name and key, so a key no longer applied is still
 * named) and closes it when the teardown completes (`closeTeardownWindow`).
 * While it is open, every notice for the key is one log line and one
 * startup-errors entry through the injected recorder (production:
 * `recordStartupError`), its text with Slack's control-character escapes
 * undone (`unescapeSlackControlCharacters`, so `&amp;`, `&lt;` and `&gt;` in
 * a notice built for Slack are written as `&`, `<` and `>`): of class `persona-teardown-notice`
 * (`PERSONA_TEARDOWN_NOTICE_LABEL`), or `persona-kill-survivor` for the
 * kill-failure alert's survivor version (`PersonaNoticeOptions.teardownEntryClass`,
 * b.jg5 SRJ-704). The entry is `personaTeardownNoticeEntryText`'s: the
 * persona reference, "raised during its teardown", the notice's text. No
 * Slack call is made, nothing is held and nothing is dropped: this branch
 * comes before the drop for a key no longer applied, the dry-run branch, the
 * pre-validation hold and the destination hold, and `flush` posts nothing
 * for a key whose window is open. `forget` therefore never drops a notice
 * raised in the window (none is queued); notices held before the window keep
 * its drop and its one line. A notice raised outside the window routes as
 * any other, with one exception: an outage onset the window routed
 * (`PersonaNoticeOptions.outage`, given by the outage state) marks its
 * classes for the key, and the all-clear that lists a marked class, whenever
 * it comes, takes the same route (its entry says "the all-clear of an outage
 * raised during its teardown" once the window has closed) and never reaches
 * a Slack destination, the new half's of a destructive modify included. An
 * onset of a marked class raised outside any window starts a new outage and
 * drops that class's mark.
 *
 * The teardown also registers its submit (`submitTeardown`, before its
 * serializer turn) and its end (`settleTeardown`): `teardownWindowState`
 * answers `submitted` from the submit until the window opens, `open` while
 * it is open, and `none` otherwise. The notifier's own routing reads only
 * the open window; the notice episodes (`src/persona-episodes.ts`) read the
 * state, so from the submit on they post nothing to Slack for the key (b.jg5
 * SRJ-1003).
 *
 * Shared helpers: `formatPersonaNotice` (a notice text carrying the persona
 * reference) is pure and exported. The permission poller uses it for its
 * stuck-prompt warning, which needs the post's outcome and so cannot go
 * through `notify`; the poller posts through the same destination hold and
 * resolver, except while the persona's teardown window is open, when it hands
 * the warning to `notify` so the window writes it (b.jg5 SRJ-1003).
 * `personaTeardownNoticeEntryText` builds every
 * `persona-teardown-notice` entry (and the survivor version's entry raised in
 * a window), the episodes' log-only teardown route included.
 *
 * Log lines, besides the ones above (`<ref>` the persona reference, `<class>`
 * the entry's class, `<first line>` the notice's first line, unescaped):
 *
 *   [slack] persona-notifier: notice for <ref> raised during its teardown — written to the server log and startup-errors.log (<class>), not posted: <first line>
 *   [slack] persona-notifier: all-clear for <ref> of an outage raised during its teardown — written to the server log and startup-errors.log (persona-teardown-notice), not posted: <first line>
 *   [slack] persona-notifier: onset for <ref> of <classes> not posted — muted, its persona teardown was submitted; its all-clear is written, never posted: <first line>
 *
 * and, only on a failure, `… not posted, and its startup-errors entry was not
 * written: <reason>` in place of the written part.
 *
 * Pure module (b.av2 SR-13.1): no module-scope state, no I/O of its own, no
 * timers of its own and nothing runs at import. All state lives in the
 * instance the factory returns; the Slack client, the persona lookup, the
 * destination hold (or the resolver to build one), the dry-run predicate,
 * the startup-errors recorder and the logger are injected.
 *
 * SPDX-License-Identifier: MIT
 */

import type { WebClient } from '@slack/web-api'
import type { Persona } from './config.ts'
import { PERSONA_TEARDOWN_NOTICE_LABEL, type PERSONA_KILL_SURVIVOR_LABEL } from './kill-failure-alert.ts'
import { renderPersonaRef } from './persona-identity.ts'
import { unescapeSlackControlCharacters } from './slack-text-escape.ts'
import { describeThrownValue, slackPlatformReason } from './persona-connection-errors.ts'
import {
  createPersonaDestinations,
  type DestinationConfig,
  type DestinationFailure,
  type PersonaDestinations,
} from './persona-destination.ts'
import {
  MAX_HELD_NOTICES_PER_PERSONA,
  createPersonaDestinationHold,
  type HoldNotice,
  type PersonaDestinationHold,
} from './persona-destination-hold.ts'

export { MAX_HELD_NOTICES_PER_PERSONA }

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Per-notice options. */
export interface PersonaNoticeOptions {
  /**
   * Called with the failure (the step, the error class and, when one was
   * thrown, the rejection) when the notice's Slack post fails (or, for a `dm`
   * destination, the `conversations.open` before it), whether it was posted
   * at once or held and flushed later. Called once, at the notice's first
   * failed attempt: the destination hold's later retries of the same notice
   * don't call it again. Not called for a dropped, dry-run or refused notice.
   */
  onPostFailure?: (failure: DestinationFailure) => void
  /**
   * The kill-failure alert's survivor version (b.jg5 SRJ-704, SRJ-1003,
   * SRJ-1013): while the key's teardown window is open the notice's entry is
   * of this class, `persona-kill-survivor`, in place of
   * `persona-teardown-notice`. Outside a window it changes nothing.
   */
  teardownEntryClass?: typeof PERSONA_KILL_SURVIVOR_LABEL
  /**
   * The notice is an outage's onset or all-clear, with the outage classes it
   * concerns (the outage state's notices, `src/outage-state.ts`): an onset
   * the teardown window routes marks its classes for the key, and an
   * all-clear listing a marked class takes the teardown route whenever it
   * comes (b.jg5 SRJ-1002, SRJ-1003).
   */
  outage?: PersonaNoticeOutage
}

/** An outage notice's phase and the outage classes it concerns (`OutageClass` labels). */
export interface PersonaNoticeOutage {
  readonly phase: typeof PERSONA_NOTICE_OUTAGE_ONSET | typeof PERSONA_NOTICE_OUTAGE_ALL_CLEAR
  readonly classes: readonly string[]
  /**
   * All-clear only: the all-clear text of a subset of `classes` (the outage
   * state's `allClearOf`). With it, an all-clear listing both a class whose
   * onset a teardown window routed and one whose onset was posted is split:
   * the marked classes' all-clear is written, the rest posted. Without it
   * the whole all-clear is written.
   */
  readonly allClearOf?: (classes: readonly string[]) => string
}

/**
 * The outage classes that are notice episodes of their own (b.jg5 SRJ-1016:
 * `ad-config-malformed`, whose flag is its once-per-episode latch): from a
 * persona teardown's submit until its window opens, their onset for the key
 * is muted (one log line, no Slack post, no entry) and marked like an onset
 * the window routed, so that outage's all-clear is written, never posted
 * (b.jg5 SRJ-1003, SRJ-1002). The other outage classes are not SRJ-1016
 * kinds and route as any notice until the window opens.
 */
export const PERSONA_NOTICE_SUBMIT_MUTED_OUTAGE_CLASSES: readonly string[] = Object.freeze(['ad-config-malformed'])

/** An outage onset (`PersonaNoticeOutage.phase`). */
export const PERSONA_NOTICE_OUTAGE_ONSET = 'onset'
/** An outage all-clear (`PersonaNoticeOutage.phase`). */
export const PERSONA_NOTICE_OUTAGE_ALL_CLEAR = 'all-clear'

/**
 * Where a key stands with its persona teardown (b.jg5 SRJ-1003): `none`;
 * `submitted`, from the teardown's submit until its window opens; `open`,
 * while its window is open.
 */
export type PersonaTeardownWindowState = 'none' | 'submitted' | 'open'

/**
 * The startup-errors recorder (production: `recordStartupError`, which also
 * writes the line to stderr, the server log): one entry of `classLabel`
 * carrying `message`.
 */
export type PersonaStartupErrorRecorder = (classLabel: string, message: string) => void

/**
 * Raise a notice for the persona with this key. `text` is the notice body; the
 * notifier adds the persona reference. Never throws, and the returned promise
 * never rejects.
 */
export type PersonaNotify = (key: string, text: string, options?: PersonaNoticeOptions) => void | Promise<void>

/** Dependencies injected into `createPersonaNotifier`. */
export interface PersonaNotifierDeps {
  /** The applied persona with this key, or undefined when there is none. */
  getPersona(key: string): Persona | undefined
  /** The persona's validated Web client, or undefined while it is not validated. */
  clientFor(key: string): WebClient | undefined
  /**
   * The destination resolver (per-persona DM cache) shared with the permission
   * poller. Used only to build the notifier's own destination hold when
   * `destinationHold` is not given; defaults to an instance of its own.
   */
  destinations?: PersonaDestinations
  /**
   * The configuration in effect, read at each attempt (b.deo SRI-201). Used
   * only to build the notifier's own resolver when neither `destinationHold`
   * nor `destinations` is given (a given resolver reads its own). Absent: no
   * configuration, so declarative mode (`channelModeOf`).
   */
  getPersonaConfig?(): DestinationConfig
  /**
   * The destination hold (per-persona episodes, retries and held notices)
   * shared with the permission poller, which every notice for a validated
   * persona is handed to. Defaults to one of the notifier's own, over
   * `destinations`, the persona and client lookups, the real clock and `log`.
   */
  destinationHold?: PersonaDestinationHold
  /** True in dry run: nothing is posted. */
  isDryRun(): boolean
  /** Writes one log line. */
  log(line: string): void
  /**
   * Writes one startup-errors entry: every notice the persona teardown
   * window routes (b.jg5 SRJ-1003, SRJ-1013). Production binds
   * `recordStartupError` with its default log directory; tests pass one over
   * a temp `logDir`. Absent: the notice's log line says no entry was written
   * (no recorder is installed); it is still never posted.
   */
  recordStartupError?: PersonaStartupErrorRecorder
}

/** A notifier instance: routing, per-persona hold and flush. */
export interface PersonaNotifier {
  /**
   * Route one notice (see the module header). Resolves once the post settles,
   * or at once when the notice is logged, dropped or held. Never rejects.
   */
  notify(key: string, text: string, options?: PersonaNoticeOptions): Promise<void>
  /**
   * Post the persona's held notices in raised order once its client is
   * validated; leaves the queue as it is while the client is not validated,
   * or while the persona's teardown window is open (posts nothing then).
   * For a channel destination every post is issued before this returns; for
   * a `dm` destination the posts go out, still in raised order, once the
   * shared DM open settles. The promise resolves once they all settle. Never
   * rejects.
   */
  flush(key: string): Promise<void>
  /**
   * Drop the persona's pre-validation queue unposted (b.av2 SR-6.5, a
   * teardown), so a persona added later with the same key never posts the
   * removed persona's notices. Leaves the destination hold alone (the
   * teardown cancels it) and every other persona's queue. No Slack call;
   * logs one line when notices were dropped. A no-op for an unknown key.
   * Only notices held before the persona's teardown window opened are in the
   * queue: a notice raised while it is open is written, never held, so none
   * is dropped here (b.jg5 SRJ-1003).
   */
  forget(key: string): void
  /**
   * The persona teardown's submit (b.jg5 SRJ-1003): from now until the
   * matching `settleTeardown`, `teardownWindowState` answers at least
   * `submitted` for the key. Counted, so two teardowns of one key pair up.
   * Changes no routing of the notifier's own.
   */
  submitTeardown(key: string): void
  /** The end of a teardown `submitTeardown` registered. A no-op when none is registered. */
  settleTeardown(key: string): void
  /**
   * Open the persona's teardown window (b.jg5 SRJ-1003) at the start of its
   * teardown's serializer turn: until `closeTeardownWindow`, every notice
   * for `persona.key` is written (log line and startup-errors entry naming
   * the persona), never posted, held or dropped. Counted, so a nested open
   * needs its own close.
   */
  openTeardownWindow(persona: Pick<Persona, 'name' | 'key'>): void
  /** Close the window `openTeardownWindow` opened, once the teardown completes. A no-op when none is open. */
  closeTeardownWindow(key: string): void
  /** Where the key stands with its persona teardown: `open`, `submitted` or `none`. Never throws. */
  teardownWindowState(key: string): PersonaTeardownWindowState
}

/** A notice held until its persona's client is validated. */
interface HeldNotice {
  text: string
  options?: PersonaNoticeOptions
}

// ---------------------------------------------------------------------------
// Text helpers
// ---------------------------------------------------------------------------

/** First line of a notice body: the only part a dry-run log line carries. */
export function firstNoticeLine(text: string): string {
  const end = text.search(/\r\n|[\n\r]/)
  return end === -1 ? text : text.slice(0, end)
}

/**
 * The posted text of a notice: the persona reference, rendered from the
 * persona's stored key (never one derived again from the name), then the
 * body. Pure; shared by `notify` and the permission poller.
 */
export function formatPersonaNotice(persona: Pick<Persona, 'name' | 'key'>, text: string): string {
  return `Persona ${renderPersonaRef(persona.name, persona.key)}: ${text}`
}

/**
 * The `startup-errors.log` class of a notice raised during a persona teardown
 * (b.jg5 SRJ-1003, SRJ-1013): every notice the teardown window routes but the
 * kill-failure alert's survivor version, and the all-clear of an outage whose
 * onset was raised during one. Re-exported from `src/kill-failure-alert.ts`,
 * the pure module that holds every kill-failure class, so one constant
 * serves the window and the kill-failure alert's route selection.
 */
export { PERSONA_TEARDOWN_NOTICE_LABEL }

/** A `persona-teardown-notice` entry's occasion: a notice raised while the teardown window was open (b.jg5 SRJ-1013). */
export const PERSONA_TEARDOWN_NOTICE_RAISED = 'raised during its teardown'

/**
 * A `persona-teardown-notice` entry's occasion: the all-clear of an outage
 * whose onset the teardown window routed, coming after the window has closed
 * (b.jg5 SRJ-1002, SRJ-1013).
 */
export const PERSONA_TEARDOWN_NOTICE_ALL_CLEAR_AFTER = 'the all-clear of an outage raised during its teardown'

/**
 * A `persona-teardown-notice` entry's occasion: a CONFLICT or an unusable
 * recorded name met in an old-life wait for the old key (b.jg5 SRJ-811,
 * SRJ-1002, SRJ-1013: "or during the wait"), written by the session manager's
 * wait end handler, never by the teardown window.
 */
export const PERSONA_TEARDOWN_NOTICE_DURING_WAIT = 'raised during its old-life wait'

/** Which occasion a teardown-route entry names. */
export type PersonaTeardownNoticeOccasion =
  | typeof PERSONA_TEARDOWN_NOTICE_RAISED
  | typeof PERSONA_TEARDOWN_NOTICE_ALL_CLEAR_AFTER
  | typeof PERSONA_TEARDOWN_NOTICE_DURING_WAIT

/**
 * One teardown-route startup-errors entry (b.jg5 SRJ-1003, SRJ-1013): the
 * persona reference (`persona "<name>" (key=<key>)`, or `persona=<key>` where
 * only the key is known), the occasion and the notice's text, as
 * `<ref>, <occasion>: <text>`. `text` is the notice's own text (no persona
 * prefix); the recorder flattens it to one line. The one builder of every
 * `persona-teardown-notice` entry, and of the survivor version's entry the
 * window writes. Pure.
 */
export function personaTeardownNoticeEntryText(
  personaRef: string,
  text: string,
  occasion: PersonaTeardownNoticeOccasion = PERSONA_TEARDOWN_NOTICE_RAISED,
): string {
  return `${personaRef}, ${occasion}: ${text}`
}

/**
 * The head of a teardown-route log line for `persona` (b.jg5 SRJ-1003,
 * SRJ-1002): a notice raised while the window was open, or the all-clear of
 * an outage whose onset the window routed.
 */
function teardownNoticeLineHead(persona: Pick<Persona, 'name' | 'key'>, occasion: PersonaTeardownNoticeOccasion): string {
  const ref = renderPersonaRef(persona.name, persona.key)
  return occasion === PERSONA_TEARDOWN_NOTICE_ALL_CLEAR_AFTER
    ? `[slack] persona-notifier: all-clear for ${ref} of an outage raised during its teardown`
    : `[slack] persona-notifier: notice for ${ref} raised during its teardown`
}

/**
 * The one log line of a notice the teardown route wrote (b.jg5 SRJ-1003,
 * SRJ-1002): `persona`, the entry's class `classLabel`, the occasion, and
 * the first line of `text`, the notice as handed in, with Slack's
 * control-character escapes undone:
 *
 *   [slack] persona-notifier: notice for <ref> raised during its teardown — written to the server log and startup-errors.log (<class>), not posted: <first line>
 *   [slack] persona-notifier: all-clear for <ref> of an outage raised during its teardown — written to the server log and startup-errors.log (<class>), not posted: <first line>
 *
 * Pure.
 */
export function personaTeardownNoticeWrittenLine(
  persona: Pick<Persona, 'name' | 'key'>,
  classLabel: string,
  occasion: PersonaTeardownNoticeOccasion,
  text: string,
): string {
  return `${teardownNoticeLineHead(persona, occasion)} — written to the server log and startup-errors.log (${classLabel}), not posted: ${firstNoticeLine(unescapeSlackControlCharacters(text))}`
}

/**
 * Call a `PersonaNotify` sink without letting it throw or reject: a
 * synchronous throw or a rejected promise goes to `onError` instead. For
 * callers holding an injected sink (which may be a test fake).
 */
export function notifySafely(
  notify: PersonaNotify,
  key: string,
  text: string,
  options: PersonaNoticeOptions | undefined,
  onError: (err: unknown) => void,
): void {
  try {
    const pending = notify(key, text, options)
    if (pending instanceof Promise) pending.catch(onError)
  } catch (err) {
    onError(err)
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/** Build a notifier over the injected persona lookup, clients, dry-run predicate and logger. */
export function createPersonaNotifier(deps: PersonaNotifierDeps): PersonaNotifier {
  const held = new Map<string, HeldNotice[]>()
  const destinationHold = deps.destinationHold ?? createPersonaDestinationHold({
    destinations: deps.destinations ?? createPersonaDestinations({
      log: deps.log,
      getPersonaConfig: () => deps.getPersonaConfig?.(),
    }),
    getPersona: deps.getPersona,
    clientFor: deps.clientFor,
    log: deps.log,
  })

  /**
   * Log a failed post that the hold does not retry: a failure specific to the
   * notice, which only `chat.postMessage` reports (every open failure is held).
   */
  function logDroppedFailure(ref: string, failure: DestinationFailure): void {
    const reason = slackPlatformReason(failure.error)
    const where = reason ? `${failure.channelId} (reason=${reason})` : failure.channelId
    deps.log(`[slack] persona-notifier: failed to post notice for ${ref} to ${where}: ${describeThrownValue(failure.error)}`)
  }

  // Handed to the hold, which for a channel destination issues the post
  // before the first `await` when the persona is not held, so calling `post`
  // issues it synchronously; only the settling is awaited. A `dm` destination
  // is resolved first (the open, or the cached conversation).
  function post(persona: Persona, client: WebClient, notice: HeldNotice): Promise<void> {
    const ref = renderPersonaRef(persona.name, persona.key)
    const holdNotice: HoldNotice = {
      message: { text: formatPersonaNotice(persona, notice.text) },
      summary: firstNoticeLine(notice.text),
      onAttemptFailed: (failure, info) => {
        if (!info.held) logDroppedFailure(ref, failure)
        if (!info.first) return
        try {
          notice.options?.onPostFailure?.(failure)
        } catch (cbErr) {
          deps.log(`[slack] persona-notifier: failure callback threw for ${ref}: ${describeThrownValue(cbErr)}`)
        }
      },
    }
    return destinationHold.deliver(persona, client, holdNotice)
  }

  /** Open teardown windows by key: the persona as the window named it, and how many opens are not closed yet. */
  const windows = new Map<string, { persona: Pick<Persona, 'name' | 'key'>; depth: number }>()
  /** Teardowns submitted and not settled yet, by key. */
  const submitted = new Map<string, number>()
  /**
   * Outage classes whose onset a teardown window routed, by key, with the
   * persona the window named (b.jg5 SRJ-1002): their all-clear takes the
   * teardown route whenever it comes.
   */
  const teardownOutages = new Map<string, { persona: Pick<Persona, 'name' | 'key'>; classes: Set<string> }>()

  /** The teardown-route persona reference: `persona "<name>" (key=<key>)`. */
  function teardownRef(persona: Pick<Persona, 'name' | 'key'>): string {
    return `persona ${renderPersonaRef(persona.name, persona.key)}`
  }

  /**
   * The teardown route (b.jg5 SRJ-1003): one startup-errors entry of
   * `classLabel` through the recorder, then one log line saying so. Never a
   * Slack call. The text is written with Slack's control-character escapes
   * undone (`unescapeSlackControlCharacters`): a notice built for Slack (the
   * CONFLICT and hold notices, the `ad-config-malformed` onset, the
   * lost-message notice) then reads as the notices handed in unescaped do.
   * Never throws: a failing (or absent) recorder is named in the line in
   * place of the written part.
   */
  function writeTeardownNotice(
    persona: Pick<Persona, 'name' | 'key'>,
    slackText: string,
    classLabel: string,
    occasion: PersonaTeardownNoticeOccasion,
  ): void {
    const text = unescapeSlackControlCharacters(slackText)
    let failure: string | undefined
    if (deps.recordStartupError === undefined) {
      failure = 'no startup-errors recorder is installed'
    } else {
      try {
        deps.recordStartupError(classLabel, personaTeardownNoticeEntryText(teardownRef(persona), text, occasion))
      } catch (err) {
        failure = describeThrownValue(err)
      }
    }
    deps.log(
      failure === undefined
        ? personaTeardownNoticeWrittenLine(persona, classLabel, occasion, slackText)
        : `${teardownNoticeLineHead(persona, occasion)} — not posted, and its startup-errors entry was not written: ${failure}: ${firstNoticeLine(text)}`,
    )
  }

  /** Mark `classes` of the key's outage as routed by its teardown, naming `persona`. */
  function mark(key: string, persona: Pick<Persona, 'name' | 'key'>, classes: readonly string[]): void {
    const marked = teardownOutages.get(key)
    if (marked === undefined) teardownOutages.set(key, { persona, classes: new Set(classes) })
    else {
      marked.persona = persona
      for (const cls of classes) marked.classes.add(cls)
    }
  }

  /**
   * Route a notice for `key` on the teardown route when its window is open,
   * or when it is the all-clear of an outage a window routed (b.jg5 SRJ-1002,
   * SRJ-1003); and mute the onset of an outage that is a notice episode of
   * its own (`PERSONA_NOTICE_SUBMIT_MUTED_OUTAGE_CLASSES`) from the key's
   * teardown submit until its window opens. Answers undefined when the
   * notice was fully routed so; otherwise what is left to route as any
   * notice: the notice as given, or, for an all-clear listing marked and
   * unmarked classes that can be split (`allClearOf`), the unmarked classes'
   * all-clear, the marked ones' having been written. An onset raised outside
   * any window drops the marks of the classes it raises anew.
   */
  function routeTeardownNotice(
    key: string,
    text: string,
    options: PersonaNoticeOptions | undefined,
  ): { text: string; options: PersonaNoticeOptions | undefined } | undefined {
    const rest = { text, options }
    const outage = readOutage(options)
    const open = windows.get(key)
    if (open !== undefined) {
      if (outage?.phase === PERSONA_NOTICE_OUTAGE_ONSET) mark(key, open.persona, outage.classes)
      else if (outage?.phase === PERSONA_NOTICE_OUTAGE_ALL_CLEAR) unmark(key, outage.classes)
      const classLabel = options?.teardownEntryClass ?? PERSONA_TEARDOWN_NOTICE_LABEL
      writeTeardownNotice(open.persona, text, classLabel, PERSONA_TEARDOWN_NOTICE_RAISED)
      return undefined
    }
    if (outage === undefined) return rest
    if (outage.phase === PERSONA_NOTICE_OUTAGE_ONSET) {
      // A new outage of a class whose earlier onset a window routed: that
      // earlier outage ended without an all-clear (its flag was wiped).
      unmark(key, outage.classes)
      return muteSubmittedOnset(key, text, outage) ? undefined : rest
    }
    const marked = teardownOutages.get(key)
    if (marked === undefined) return rest
    const markedClasses = outage.classes.filter((cls) => marked.classes.has(cls))
    if (markedClasses.length === 0) return rest
    const persona = marked.persona
    unmark(key, outage.classes)
    const unmarkedClasses = outage.classes.filter((cls) => !markedClasses.includes(cls))
    const split = unmarkedClasses.length === 0 ? undefined : splitAllClear(outage, markedClasses, unmarkedClasses)
    if (split === undefined) {
      // Nothing to split, or no renderer for a part: the whole all-clear is
      // written, so a class whose onset was posted gets no Slack all-clear.
      writeTeardownNotice(persona, text, PERSONA_TEARDOWN_NOTICE_LABEL, PERSONA_TEARDOWN_NOTICE_ALL_CLEAR_AFTER)
      return undefined
    }
    writeTeardownNotice(persona, split.marked, PERSONA_TEARDOWN_NOTICE_LABEL, PERSONA_TEARDOWN_NOTICE_ALL_CLEAR_AFTER)
    const restOptions: PersonaNoticeOptions = {
      ...options,
      outage: { phase: PERSONA_NOTICE_OUTAGE_ALL_CLEAR, classes: unmarkedClasses, allClearOf: outage.allClearOf },
    }
    return { text: split.unmarked, options: restOptions }
  }

  /**
   * The two parts of an all-clear listing marked and unmarked classes,
   * rendered by its `allClearOf`; undefined when it has none, or it throws or
   * answers no string for a part. Never throws.
   */
  function splitAllClear(
    outage: PersonaNoticeOutage,
    markedClasses: readonly string[],
    unmarkedClasses: readonly string[],
  ): { marked: string; unmarked: string } | undefined {
    if (outage.allClearOf === undefined) return undefined
    try {
      const markedText: unknown = outage.allClearOf(markedClasses)
      const unmarkedText: unknown = outage.allClearOf(unmarkedClasses)
      if (typeof markedText !== 'string' || typeof unmarkedText !== 'string') return undefined
      return { marked: markedText, unmarked: unmarkedText }
    } catch {
      return undefined
    }
  }

  /**
   * b.jg5 SRJ-1003, SRJ-1016: an onset of an outage that is a notice episode
   * of its own (`PERSONA_NOTICE_SUBMIT_MUTED_OUTAGE_CLASSES`) for a key
   * whose teardown is submitted and whose window is not open yet: one log
   * line, no Slack post and no entry, and its classes are marked, so that
   * outage's all-clear is written, never posted. Only for a key with an
   * applied persona: a key no longer applied has its notice dropped as any
   * other. Answers whether it muted the onset.
   */
  function muteSubmittedOnset(key: string, text: string, outage: PersonaNoticeOutage): boolean {
    if (!submitted.has(key)) return false
    if (!outage.classes.some((cls) => PERSONA_NOTICE_SUBMIT_MUTED_OUTAGE_CLASSES.includes(cls))) return false
    const persona = deps.getPersona(key)
    if (persona === undefined) return false
    mark(key, { name: persona.name, key: persona.key }, outage.classes)
    deps.log(
      `[slack] persona-notifier: onset for ${renderPersonaRef(persona.name, persona.key)} of ${outage.classes.join(', ')} not posted — ` +
        `muted, its persona teardown was submitted; its all-clear is written, never posted: ${firstNoticeLine(unescapeSlackControlCharacters(text))}`,
    )
    return true
  }

  /** Drop the key's teardown marks of `classes`. */
  function unmark(key: string, classes: readonly string[]): void {
    const marked = teardownOutages.get(key)
    if (marked === undefined) return
    for (const cls of classes) marked.classes.delete(cls)
    if (marked.classes.size === 0) teardownOutages.delete(key)
  }

  async function notify(key: string, givenText: string, givenOptions?: PersonaNoticeOptions): Promise<void> {
    const left = routeTeardownNotice(key, givenText, givenOptions)
    if (left === undefined) return
    const { text, options } = left
    const persona = deps.getPersona(key)
    if (!persona) {
      deps.log(`[slack] persona-notifier: no applied persona with key=${key} — notice dropped`)
      return
    }
    const ref = renderPersonaRef(persona.name, persona.key)
    if (deps.isDryRun()) {
      deps.log(`[slack] dry-run: would post notice for ${ref}: ${firstNoticeLine(text)}`)
      return
    }
    const client = deps.clientFor(key)
    const queue = held.get(key)
    if (!client || queue) {
      hold(key, ref, { text, options })
      // A validated persona with notices still held posts them first, so
      // notices always post in raised order.
      if (client) await flush(key)
      return
    }
    await post(persona, client, { text, options })
  }

  /** Append to the persona's queue; past the bound, drop (log, never post) the oldest held notice. */
  function hold(key: string, ref: string, notice: HeldNotice): void {
    let queue = held.get(key)
    if (!queue) {
      queue = []
      held.set(key, queue)
    }
    queue.push(notice)
    if (queue.length <= MAX_HELD_NOTICES_PER_PERSONA) return
    const dropped = queue.shift()!
    deps.log(
      `[slack] persona-notifier: more than ${MAX_HELD_NOTICES_PER_PERSONA} notices held for ${ref} — ` +
        `oldest held notice dropped, not posted: ${firstNoticeLine(dropped.text)}`,
    )
  }

  async function flush(key: string): Promise<void> {
    const queue = held.get(key)
    if (!queue || queue.length === 0) return
    if (!deps.clientFor(key)) return
    // b.jg5 SRJ-1003: nothing is posted for a key under teardown; the
    // teardown's `forget` drops what was held before its window opened.
    if (windows.has(key)) return
    held.delete(key)
    // Re-route each held notice: the persona is looked up again, so one no
    // longer applied is dropped with a log line. `map` calls `notify` for
    // every notice before the first `await`, so the posts keep raised order:
    // to a channel each is issued before this yields; to a `dm` destination
    // they all wait on the one shared open and go out in raised order once it
    // settles.
    await Promise.all(queue.map((notice) => notify(key, notice.text, notice.options)))
  }

  function forget(key: string): void {
    const queue = held.get(key)
    if (queue === undefined) return
    held.delete(key)
    if (queue.length === 0) return
    deps.log(`[slack] persona-notifier: persona=${key}: dropped ${queue.length} held notice(s), not posted — the persona was torn down`)
  }

  return {
    notify,
    flush,
    forget,
    submitTeardown(key) {
      submitted.set(key, (submitted.get(key) ?? 0) + 1)
    },
    settleTeardown(key) {
      const count = submitted.get(key)
      if (count === undefined) return
      if (count <= 1) submitted.delete(key)
      else submitted.set(key, count - 1)
    },
    openTeardownWindow(persona) {
      const { name, key } = persona
      const open = windows.get(key)
      windows.set(key, { persona: { name, key }, depth: (open?.depth ?? 0) + 1 })
    },
    closeTeardownWindow(key) {
      const open = windows.get(key)
      if (open === undefined) return
      if (open.depth <= 1) windows.delete(key)
      else open.depth--
    },
    teardownWindowState(key) {
      if (windows.has(key)) return 'open'
      return submitted.has(key) ? 'submitted' : 'none'
    },
  }
}

/** `options.outage` when it is a well-formed outage notice, else undefined. Never throws. */
function readOutage(options: PersonaNoticeOptions | undefined): PersonaNoticeOutage | undefined {
  try {
    const outage = options?.outage
    if (outage === undefined || outage === null) return undefined
    const { phase, classes } = outage
    if (phase !== PERSONA_NOTICE_OUTAGE_ONSET && phase !== PERSONA_NOTICE_OUTAGE_ALL_CLEAR) return undefined
    if (!Array.isArray(classes)) return undefined
    const filtered = classes.filter((cls): cls is string => typeof cls === 'string')
    const allClearOf: unknown = phase === PERSONA_NOTICE_OUTAGE_ALL_CLEAR ? outage.allClearOf : undefined
    return typeof allClearOf === 'function'
      ? { phase, classes: filtered, allClearOf: allClearOf as (classes: readonly string[]) => string }
      : { phase, classes: filtered }
  } catch {
    return undefined
  }
}
