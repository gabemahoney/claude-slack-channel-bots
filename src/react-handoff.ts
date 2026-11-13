/**
 * react-handoff.ts — The `react` hand-off: a Bot-to-Bot Reaction Notice's
 * path from persona B's winning `react` call to persona A's reaction intake
 * (SR-6.2, SR-6.5).
 *
 * `onReactClaimed` takes the claim the registry hands over for each `react`
 * whose answer was the first, notes the time CSCB observed it and returns at
 * once; the rest runs detached, so it never delays or changes the tool
 * result. On a zero-delay timer it reads the reacted message with B's client
 * as Reaction Item preparation's lookup 2 does (`lookupReactionMessage`). When
 * the message is not a Server Post and its author is the confirmed bot user
 * of another applied persona A, it gives A's intake a `bot-tool` event with
 * B's bot user ID and persona name as captured with the claim, never a
 * later identity of B. A's intake owns the decision, durability and
 * preparation; this module makes no other Slack call, reads no routing
 * setting, checks no subscription and calls no agent-director.
 *
 * A failed read or hand-off writes one content-free `reaction-handoff-failed`
 * line and brings no notice; nothing retries it (L3). Skips, normal intake
 * results and cancellation by `forget` or `stop` write nothing.
 *
 * Import-safe: no I/O, timer or state until the factory runs, and the factory
 * starts nothing until a claim arrives.
 *
 * SPDX-License-Identifier: MIT
 */

import type { WebClient } from '@slack/web-api'
import type { Persona } from './config.ts'
import type { BotToolReactionInput, BotToolReactionIntakeResult } from './persona-routing.ts'
import type { SlackBotIdentity } from './persona-slack-validation.ts'
import { lookupReactionMessage, type ReactionMessageRead } from './reaction-preparation.ts'
import { quoteReactionLogField as quote, reactionLogWord as word, renderReactionPersonaRef as ref } from './reaction-log-fields.ts'
import type { ReactClaimContext } from './registry.ts'
import { NAME_LOOKUP_TIMEOUT_MS } from './tag-wrapper.ts'

// ---------------------------------------------------------------------------
// The failure line
// ---------------------------------------------------------------------------

export const REACTION_HANDOFF_FAILED = 'reaction-handoff-failed'

/**
 * Why a hand-off failed: B's read was rejected or malformed, timed out, or
 * found no message with the reacted ts; A's intake rejected, or answered
 * `store-failed`; or anything else went wrong in this module.
 */
export const REACTION_HANDOFF_FAILURE_REASONS = ['read-failed', 'read-timeout', 'message-missing', 'handoff-rejected', 'store-failed', 'internal-failed'] as const
export type ReactionHandoffFailureReason = typeof REACTION_HANDOFF_FAILURE_REASONS[number]

/** A persona the line names: its key, and its configured name when known. */
export interface ReactionHandoffPersona {
  key: string
  name?: string
}

export interface ReactionHandoffFailure {
  /** B, the persona whose `react` call it was. */
  reactor: ReactionHandoffPersona
  /** A, once the read found it. */
  receiver?: ReactionHandoffPersona
  chat_id: string
  message_ts: string
  reason: ReactionHandoffFailureReason
}

/**
 * `[slack] reaction-handoff-failed: persona=<B ref>[ receiver=<A ref>] chat_id="…" message_ts="…" reason=<reason>`.
 * No message text, emoji, Slack response, error or token.
 */
export function buildReactionHandoffFailedLine(f: ReactionHandoffFailure): string {
  const receiver = f.receiver !== undefined ? ` receiver=${ref(f.receiver)}` : ''
  return `[slack] ${REACTION_HANDOFF_FAILED}: persona=${ref(f.reactor)}${receiver} chat_id=${quote(f.chat_id)} message_ts=${quote(f.message_ts)} reason=${word(f.reason)}`
}

// ---------------------------------------------------------------------------
// The observed time
// ---------------------------------------------------------------------------

/**
 * `epochMs` as an injected item's timestamp: decimal Unix seconds with six
 * fractional digits, the milliseconds taken to whole microseconds
 * (1700000000123 -> `1700000000.123000`), as the delivery queue writes them.
 */
export function formatObservedEventTs(epochMs: number): string {
  const us = BigInt(Math.trunc(epochMs * 1000))
  return `${us / 1000000n}.${String(us % 1000000n).padStart(6, '0')}`
}

// ---------------------------------------------------------------------------
// The owner
// ---------------------------------------------------------------------------

export interface ReactHandoffClock {
  now(): number
  setTimeout(callback: () => void, delayMs: number): unknown
  clearTimeout(handle: unknown): void
}

export interface ReactHandoffDeps {
  /** The applied personas of the configuration in effect, read after each read. */
  getAppliedPersonas(): readonly Persona[]
  /**
   * A persona's confirmed identity now, or undefined when it is not serving.
   * Target selection asks it while scanning the applied personas, so it may
   * be asked for B; the reactor ID given to A and the self-author check use
   * only the ID captured with the claim, never a later identity of B.
   */
  getBotIdentity(key: string): Pick<SlackBotIdentity, 'botUserId'> | undefined
  /** A's `bot-tool` reaction intake. */
  receiveBotToolReaction(key: string, input: BotToolReactionInput): Promise<BotToolReactionIntakeResult>
  clock: ReactHandoffClock
  /** The message read's bound. Absent: NAME_LOOKUP_TIMEOUT_MS. */
  lookupTimeoutMs?: number
  /** The live shutdown query, asked before a read and before a hand-off; a throw counts as shutting down. */
  isShuttingDown(): boolean
  /** Receives each `reaction-handoff-failed` line. */
  log(line: string): void
}

export interface ReactHandoff {
  /** The registry's `onReactClaimed`: notes the observed time and schedules the work. Never throws. */
  onReactClaimed(claim: ReactClaimContext): void
  /**
   * Cancel the work of `key` as the reacting persona that has not reached
   * an intake, and silence the outcome of an intake already given to `key`
   * as the receiver. Idempotent; other keys' work goes on.
   */
  forget(key: string): void
  /**
   * Take no further claim and cancel every job that has not reached an
   * intake, at once; the promise settles once every intake already given a
   * reaction has settled.
   */
  stop(): Promise<void>
}

/** One claim's work, with everything it needs copied when the claim arrived. */
interface Job {
  reactor: { key: string; name: string }
  reactorUserId: string
  client: WebClient
  chatId: string
  messageId: string
  emoji: string
  eventTs: string
  stage: 'scheduled' | 'reading' | 'intake'
  receiver?: { key: string; name: string }
  timer?: unknown
  abort?: AbortController
  cancelled: boolean
  logged: boolean
}

const READ_FAILURES: Readonly<Record<Exclude<ReactionMessageRead['state'], 'found' | 'cancelled'>, ReactionHandoffFailureReason>> = {
  refused: 'read-failed',
  failed: 'read-failed',
  timeout: 'read-timeout',
  missing: 'message-missing',
}

export function createReactHandoff(deps: ReactHandoffDeps): ReactHandoff {
  const lookupTimeoutMs = deps.lookupTimeoutMs ?? NAME_LOOKUP_TIMEOUT_MS
  /** Every job not yet finished, intake stage included. */
  const jobs = new Set<Job>()
  /** The intakes already given a reaction, for `stop`'s drain. */
  const intakes = new Set<Promise<void>>()
  let admitting = true

  function stopping(): boolean {
    if (!admitting) return true
    try { return deps.isShuttingDown() } catch { return true }
  }

  const live = (job: Job): boolean => !job.cancelled && !stopping()

  /** One line per job at most, never for a cancelled one; a throwing logger changes nothing. */
  function fail(job: Job, reason: ReactionHandoffFailureReason): void {
    if (job.logged || job.cancelled) return
    job.logged = true
    try {
      deps.log(buildReactionHandoffFailedLine({ reactor: job.reactor, receiver: job.receiver, chat_id: job.chatId, message_ts: job.messageId, reason }))
    } catch { /* best effort */ }
  }

  function cancel(job: Job): void {
    job.cancelled = true
    if (job.timer !== undefined) {
      const timer = job.timer
      job.timer = undefined
      jobs.delete(job)
      try { deps.clock.clearTimeout(timer) } catch { /* the run finds the job cancelled */ }
    }
    job.abort?.abort()
  }

  /** The other applied persona whose confirmed bot user wrote the message, read now. */
  function receiverOf(author: string, reactorKey: string): Persona | undefined {
    for (const persona of deps.getAppliedPersonas()) {
      if (deps.getBotIdentity(persona.key)?.botUserId === author) return persona.key === reactorKey ? undefined : persona
    }
    return undefined
  }

  async function handOff(job: Job, receiverKey: string, author: string): Promise<void> {
    let result: BotToolReactionIntakeResult
    try {
      result = await deps.receiveBotToolReaction(receiverKey, {
        change: 'added', reactorUserId: job.reactorUserId, reactorPersonaName: job.reactor.name, emoji: job.emoji,
        channel: job.chatId, messageTs: job.messageId, eventTs: job.eventTs, messageAuthorUserId: author,
      })
    } catch {
      return fail(job, 'handoff-rejected')
    }
    const status = result?.status
    if (status === 'store-failed') fail(job, 'store-failed')
    else if (status !== 'stored' && status !== 'duplicate' && status !== 'dropped') fail(job, 'internal-failed')
  }

  async function run(job: Job): Promise<void> {
    try {
      if (!live(job)) return
      job.stage = 'reading'
      job.abort = new AbortController()
      const read = await lookupReactionMessage(job.client, job.chatId, job.messageId, { clock: deps.clock, lookupTimeoutMs, signal: job.abort.signal })
      job.abort = undefined
      if (read.state === 'cancelled' || !live(job)) return
      if (read.state !== 'found') return fail(job, READ_FAILURES[read.state])
      if (read.serverPost || read.author === undefined || read.author === job.reactorUserId) return
      const receiver = receiverOf(read.author, job.reactor.key)
      if (!receiver || !live(job)) return
      job.receiver = { key: receiver.key, name: receiver.name }
      job.stage = 'intake'
      const intake = handOff(job, receiver.key, read.author)
      intakes.add(intake)
      try { await intake } finally { intakes.delete(intake) }
    } catch {
      fail(job, 'internal-failed')
    } finally {
      jobs.delete(job)
    }
  }

  function onReactClaimed(claim: ReactClaimContext): void {
    // Before anything else. A throwing clock leaves NaN, which formatObservedEventTs rejects, failing the job below.
    let observedAt = Number.NaN
    try { observedAt = deps.clock.now() } catch { /* see above */ }
    let job: Job | undefined
    try {
      if (stopping()) return
      job = {
        reactor: { key: claim.persona.key, name: claim.persona.name },
        reactorUserId: claim.botUserId,
        client: claim.client,
        chatId: claim.chatId,
        messageId: claim.messageId,
        emoji: claim.emoji,
        eventTs: '',
        stage: 'scheduled',
        cancelled: false,
        logged: false,
      }
      job.eventTs = formatObservedEventTs(observedAt)
      const scheduled = job
      jobs.add(scheduled)
      scheduled.timer = deps.clock.setTimeout(() => {
        scheduled.timer = undefined
        void run(scheduled)
      }, 0)
    } catch {
      if (job) {
        jobs.delete(job)
        fail(job, 'internal-failed')
      }
    }
  }

  function forget(key: string): void {
    for (const job of [...jobs]) {
      if (job.stage === 'intake' ? job.receiver?.key === key : job.reactor.key === key) cancel(job)
    }
  }

  function stop(): Promise<void> {
    admitting = false
    for (const job of [...jobs]) if (job.stage !== 'intake') cancel(job)
    return Promise.allSettled([...intakes]).then(() => undefined)
  }

  return { onReactClaimed, forget, stop }
}
