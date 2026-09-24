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
 * - otherwise: posted to the destination. For a `dm` destination the DM is
 *   opened (or taken from the resolver's cache) at this point, so a held
 *   notice opens it only when flushed after validation, never before. A
 *   failed open or post is logged token-safely and the failure (step,
 *   error class, rejection) handed to the caller's failure callback; there is no retry. The log line carries
 *   the error type/code and, when it is a short identifier, Slack's platform
 *   reason (e.g. `not_in_channel`); never the error message. A `dm`
 *   destination the resolver refuses (DMs off or no contact, which the loader
 *   rejects) is logged by the resolver and not posted.
 *
 * Held notices are per persona (b.av2 SR-3.3): flushing one persona never
 * touches another's queue.
 *
 * Shared helper: `formatPersonaNotice` (a notice text carrying the persona
 * reference) is pure and exported. The permission poller uses it for its
 * stuck-prompt warning, which needs the post's outcome and so cannot go
 * through `notify`; the poller posts through the same destination resolver.
 *
 * Pure module (b.av2 SR-13.1): no module-scope state, no I/O of its own, no
 * timers and nothing runs at import. All state lives in the instance the
 * factory returns; the Slack client, the persona lookup, the destination
 * resolver, the dry-run predicate and the logger are injected.
 *
 * SPDX-License-Identifier: MIT
 */

import type { WebClient } from '@slack/web-api'
import type { Persona } from './config.ts'
import { renderPersonaRef } from './persona-identity.ts'
import { describeThrownValue, slackPlatformReason } from './persona-connection-errors.ts'
import {
  createPersonaDestinations,
  describeDestinationFailure,
  type DestinationFailure,
  type PersonaDestinations,
} from './persona-destination.ts'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Per-notice options. */
export interface PersonaNoticeOptions {
  /**
   * Called with the failure (the step, the error class and, when one was
   * thrown, the rejection) when the notice's Slack post fails (or, for a `dm`
   * destination, the `conversations.open` before it), whether it was posted
   * at once or held and flushed later. Not called for a dropped, dry-run or
   * refused notice.
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
   * poller. Defaults to an instance of the notifier's own.
   */
  destinations?: PersonaDestinations
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
}

/**
 * Most notices held for one persona while its client is not validated
 * (b.av2 SR-7.2). Past it the oldest held notice is dropped with a log line,
 * so the queue keeps the most recent notices and a persona that is broken or
 * retrying for a long time holds a bounded amount.
 */
export const MAX_HELD_NOTICES_PER_PERSONA = 20

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
  const destinations = deps.destinations ?? createPersonaDestinations({ log: deps.log })

  // For a channel destination the Slack call is made before the first
  // `await`, so calling `post` issues the post synchronously; only the
  // settling is awaited. A `dm` destination is resolved first (the open, or
  // the cached conversation).
  async function post(persona: Persona, client: WebClient, notice: HeldNotice): Promise<void> {
    const ref = renderPersonaRef(persona.name, persona.key)
    const result = await destinations.post(persona, client, { text: formatPersonaNotice(persona, notice.text) })
    if (result.outcome !== 'failed') return
    if (result.step === 'conversations.open') {
      deps.log(
        `[slack] persona-notifier: failed to post notice for ${ref}: could not open its DM destination ` +
          `(conversations.open)${describeDestinationFailure(result)}`,
      )
    } else {
      const reason = slackPlatformReason(result.error)
      const where = reason ? `${result.channelId} (reason=${reason})` : result.channelId
      deps.log(`[slack] persona-notifier: failed to post notice for ${ref} to ${where}: ${describeThrownValue(result.error)}`)
    }
    try {
      notice.options?.onPostFailure?.(result)
    } catch (cbErr) {
      deps.log(`[slack] persona-notifier: failure callback threw for ${ref}: ${describeThrownValue(cbErr)}`)
    }
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

  return { notify, flush }
}
