/**
 * persona-notifier.ts — Per-persona server notices (b.av2 SR-7.1, SR-7.2).
 *
 * Every server notice about a persona goes only to that persona's destination
 * (its `permission_prompts` channel), under its identity: the post goes through
 * the persona's own Web client, as one top-level message with no `thread_ts`
 * and no username or icon override. The notifier adds the persona reference to
 * every notice text, so callers pass only the key and the notice body.
 *
 * Routing of one notice:
 * - no applied persona has the key: one log line, the notice is dropped;
 * - dry run (b.av2 SR-3.4): one log line with the persona reference and the
 *   notice's first line only, no Slack call;
 * - `dm` destination: logged in full, not posted and not held (server notices
 *   by DM are not supported yet);
 * - channel destination whose client is not validated yet: held in that
 *   persona's own queue, in raised order, until `flush(key)` (or the first
 *   notice raised once the client is validated, which posts the held ones
 *   first);
 * - otherwise: posted. A rejected post is caught, logged token-safely and
 *   handed to the caller's failure callback; there is no retry. The log line
 *   carries the error type/code and, when it is a short identifier, Slack's
 *   platform reason (e.g. `not_in_channel`); never the error message.
 *
 * Held notices are per persona (b.av2 SR-3.3): flushing one persona never
 * touches another's queue.
 *
 * Shared helpers: `resolvePersonaDestination` (where a persona's prompts and
 * notices go) and `formatPersonaNotice` (a notice text carrying the persona
 * reference) are pure and exported. The permission poller uses both for its
 * prompts and its stuck-prompt warning, which need the post's outcome and so
 * cannot go through `notify`. E7 extends the destination helper for DMs.
 *
 * Pure module (b.av2 SR-13.1): no module-scope state, no I/O of its own, no
 * timers and nothing runs at import. All state lives in the instance the
 * factory returns; the Slack client, the persona lookup, the dry-run predicate
 * and the logger are injected.
 *
 * SPDX-License-Identifier: MIT
 */

import type { WebClient } from '@slack/web-api'
import { DM_DESTINATION, type Persona } from './config.ts'
import { renderPersonaRef } from './persona-identity.ts'
import { describeThrownValue, slackPlatformReason } from './persona-connection-errors.ts'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Per-notice options. */
export interface PersonaNoticeOptions {
  /**
   * Called with the rejection when the notice's Slack post fails, whether it
   * was posted at once or held and flushed later. Not called for a dropped,
   * dry-run or `dm` notice.
   */
  onPostFailure?: (err: unknown) => void
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
   * Every post is issued before this returns; the promise resolves once they
   * all settle. Never rejects.
   */
  flush(key: string): Promise<void>
}

/**
 * Where a persona's permission prompts and server notices go (b.av2 SR-7.1):
 * a channel, with its ID, or `dm`.
 */
export type PersonaDestination =
  | { kind: 'channel'; channelId: string }
  | { kind: 'dm' }

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
 * Resolve a persona's destination from its `permission_prompts` setting:
 * `dm` for the DM destination, else the channel it names. Pure; shared by
 * `notify` and the permission poller. E7 extends it for DMs.
 */
export function resolvePersonaDestination(persona: Pick<Persona, 'permission_prompts'>): PersonaDestination {
  if (persona.permission_prompts === DM_DESTINATION) return { kind: 'dm' }
  return { kind: 'channel', channelId: persona.permission_prompts }
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

  // The Slack call is made before the first `await`, so calling `post` issues
  // the post synchronously; only the settling is awaited.
  async function post(persona: Persona, channel: string, client: WebClient, notice: HeldNotice): Promise<void> {
    const ref = renderPersonaRef(persona.name, persona.key)
    try {
      await client.chat.postMessage({ channel, text: formatPersonaNotice(persona, notice.text) })
    } catch (err) {
      const reason = slackPlatformReason(err)
      const where = reason ? `${channel} (reason=${reason})` : channel
      deps.log(`[slack] persona-notifier: failed to post notice for ${ref} to ${where}: ${describeThrownValue(err)}`)
      try {
        notice.options?.onPostFailure?.(err)
      } catch (cbErr) {
        deps.log(`[slack] persona-notifier: failure callback threw for ${ref}: ${describeThrownValue(cbErr)}`)
      }
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
    const destination = resolvePersonaDestination(persona)
    if (destination.kind === 'dm') {
      deps.log(
        `[slack] persona-notifier: ${ref} has permission_prompts set to DM, and server notices by DM are not ` +
          `supported yet — notice logged instead of posted: ${text}`,
      )
      return
    }
    const client = deps.clientFor(key)
    const queue = held.get(key)
    if (!client || queue) {
      if (queue) queue.push({ text, options })
      else held.set(key, [{ text, options }])
      // A validated persona with notices still held posts them first, so
      // notices always post in raised order.
      if (client) await flush(key)
      return
    }
    await post(persona, destination.channelId, client, { text, options })
  }

  async function flush(key: string): Promise<void> {
    const queue = held.get(key)
    if (!queue || queue.length === 0) return
    if (!deps.clientFor(key)) return
    held.delete(key)
    // Re-route each held notice: the persona is looked up again, so one no
    // longer applied is dropped with a log line. `map` calls `notify` for
    // every notice before the first `await`, so each post is issued in raised
    // order before this yields.
    await Promise.all(queue.map((notice) => notify(key, notice.text, notice.options)))
  }

  return { notify, flush }
}
