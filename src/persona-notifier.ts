/**
 * persona-notifier.ts — Per-persona server notices (b.av2 SR-7.1, SR-7.2).
 *
 * Every server notice about a persona goes only to that persona's destination
 * (its `permission_prompts` channel, or its DM with `dm.contact`), under its
 * identity: the post goes through the persona's own Web client, as one
 * top-level message with no `thread_ts` and no username or icon override. The
 * destination is resolved, and a DM opened when needed, by the shared
 * destination resolver (`persona-destination.ts`). The notifier adds the
 * persona reference to every notice text, so callers pass only the key and
 * the notice body.
 *
 * Routing of one notice:
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
 * Shared helper: `formatPersonaNotice` (a notice text carrying the persona
 * reference) is pure and exported. The permission poller uses it for its
 * stuck-prompt warning, which needs the post's outcome and so cannot go
 * through `notify`; the poller posts through the same destination hold and
 * resolver.
 *
 * Pure module (b.av2 SR-13.1): no module-scope state, no I/O of its own, no
 * timers of its own and nothing runs at import. All state lives in the
 * instance the factory returns; the Slack client, the persona lookup, the
 * destination hold (or the resolver to build one), the dry-run predicate and
 * the logger are injected.
 *
 * SPDX-License-Identifier: MIT
 */

import type { WebClient } from '@slack/web-api'
import type { Persona } from './config.ts'
import { renderPersonaRef } from './persona-identity.ts'
import { describeThrownValue, slackPlatformReason } from './persona-connection-errors.ts'
import {
  createPersonaDestinations,
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
}

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
   * validated; leaves the queue as it is while the client is not validated.
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
   */
  forget(key: string): void
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
    destinations: deps.destinations ?? createPersonaDestinations({ log: deps.log }),
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

  async function notify(key: string, text: string, options?: PersonaNoticeOptions): Promise<void> {
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

  return { notify, flush, forget }
}
