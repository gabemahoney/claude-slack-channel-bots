/**
 * human-session.ts — the test human's side of the checks, over the human
 * session API (`HumanApi`): posting (a genuine user message: mentions as
 * `<@U…>`, `<!here>`, `<!channel>`), editing, opening DMs, reading history
 * and replies, and waiting for a persona's answer with a deadline.
 *
 * Waits poll only the conversation a check watches, from the check's own
 * starting point: one `conversations.history` page, plus `conversations.replies`
 * only for a thread whose latest reply is new. A transient Slack failure
 * inside a wait (a network error, a timeout, a 5xx or a 429 after the
 * session's own Retry-After retries, `internal_error`, `ratelimited` …) is
 * "not yet", never a failed check.
 *
 * Pure apart from the injected API and clock.
 */

import type { HumanApi } from './browser-types.ts'
import { safeErrorCode, SlackTransportError, type SlackResponse } from './slack-api.ts'
import { waitFor, POLL_MS, type Clock } from './wait.ts'

export interface SlackMessage {
  ts: string
  text: string
  user?: string
  bot_id?: string
  subtype?: string
  thread_ts?: string
  reply_count?: number
  /** A thread parent's newest reply (history lists it on the parent). */
  latest_reply?: string
  reactions?: { name: string; users?: string[] }[]
  blocks?: unknown[]
  edited?: unknown
}

export class HumanCallError extends Error {
  constructor(
    readonly method: string,
    readonly code: string,
  ) {
    super(`${method} failed: ${code}`)
    this.name = 'HumanCallError'
  }
}

/** Slack error codes that mean "try again later", not a refusal. */
export const TRANSIENT_SLACK_CODES = new Set(['internal_error', 'request_timeout', 'fatal_error', 'service_unavailable', 'ratelimited'])

/**
 * True when `err` is a transient Slack failure: no answer (network, timeout,
 * unparsable body), a 5xx or a 429 left after the retries, or an answer with
 * a transient error code.
 */
export function isTransientSlackFailure(err: unknown): boolean {
  if (err instanceof SlackTransportError) {
    if (err.kind !== 'http') return true
    return err.status !== undefined && (err.status >= 500 || err.status === 429)
  }
  return err instanceof HumanCallError && TRANSIENT_SLACK_CODES.has(err.code)
}

/** `probe()`, with a transient Slack failure read as "not yet" (`null`). Anything else is thrown. */
export async function notYetOnTransient<T>(probe: () => Promise<T>): Promise<T | null> {
  try {
    return await probe()
  } catch (err) {
    if (isTransientSlackFailure(err)) return null
    throw err
  }
}

const TS_RE = /^\d{9,11}\.\d{6}$/

export function isTs(v: unknown): v is string {
  return typeof v === 'string' && TS_RE.test(v)
}

function asMessage(v: unknown): SlackMessage | null {
  if (!v || typeof v !== 'object') return null
  const m = v as Record<string, unknown>
  if (!isTs(m.ts)) return null
  return {
    ts: m.ts,
    text: typeof m.text === 'string' ? m.text : '',
    user: typeof m.user === 'string' ? m.user : undefined,
    bot_id: typeof m.bot_id === 'string' ? m.bot_id : undefined,
    subtype: typeof m.subtype === 'string' ? m.subtype : undefined,
    thread_ts: typeof m.thread_ts === 'string' ? m.thread_ts : undefined,
    reply_count: typeof m.reply_count === 'number' ? m.reply_count : undefined,
    latest_reply: isTs(m.latest_reply) ? m.latest_reply : undefined,
    reactions: Array.isArray(m.reactions) ? (m.reactions as SlackMessage['reactions']) : undefined,
    blocks: Array.isArray(m.blocks) ? m.blocks : undefined,
    edited: m.edited,
  }
}

/** Compare two Slack timestamps. */
export function tsAfter(a: string, b: string): boolean {
  const [as, au] = a.split('.').map(Number) as [number, number]
  const [bs, bu] = b.split('.').map(Number) as [number, number]
  return as > bs || (as === bs && au > bu)
}

/** A bot's identity, to match its posts by user ID or bot ID. */
export interface BotRef {
  userId: string
  botId?: string
}

export function isFrom(message: SlackMessage, bot: BotRef): boolean {
  return message.user === bot.userId || (bot.botId !== undefined && message.bot_id === bot.botId)
}

/** The message's text plus the text of its blocks (button labels, section text). */
export function messageText(message: SlackMessage): string {
  const parts = [message.text]
  const walk = (v: unknown): void => {
    if (!v || typeof v !== 'object') return
    if (Array.isArray(v)) return v.forEach(walk)
    const o = v as Record<string, unknown>
    if (typeof o.text === 'string') parts.push(o.text)
    for (const value of Object.values(o)) if (value && typeof value === 'object') walk(value)
  }
  walk(message.blocks)
  return parts.join('\n')
}

export class HumanSession {
  constructor(
    private readonly api: HumanApi,
    private readonly clock: Clock,
  ) {}

  private async need(method: string, params: Record<string, string | number | boolean | undefined>): Promise<SlackResponse> {
    const answer = await this.api.call(method, params)
    if (!answer.ok) throw new HumanCallError(method, safeErrorCode(answer))
    return answer
  }

  /** Post as the test human; returns the message ts. */
  async post(channel: string, text: string, threadTs?: string): Promise<string> {
    const answer = await this.need('chat.postMessage', { channel, text, thread_ts: threadTs })
    if (!isTs(answer.ts)) throw new HumanCallError('chat.postMessage', 'no_ts')
    return answer.ts
  }

  /** Edit one of the human's messages. */
  async update(channel: string, ts: string, text: string): Promise<void> {
    await this.need('chat.update', { channel, ts, text })
  }

  /** Invite `user` to `channel`; a user already there is fine. */
  async invite(channel: string, user: string): Promise<void> {
    const answer = await this.api.call('conversations.invite', { channel, users: user })
    if (!answer.ok && safeErrorCode(answer) !== 'already_in_channel') throw new HumanCallError('conversations.invite', safeErrorCode(answer))
  }

  /** The DM conversation between the human and `user` (a bot user), opened when needed. */
  async openDm(user: string): Promise<string> {
    const answer = await this.need('conversations.open', { users: user, return_im: true })
    const channel = answer.channel && typeof answer.channel === 'object' ? (answer.channel as Record<string, unknown>).id : undefined
    if (typeof channel !== 'string' || !/^D[A-Z0-9]+$/.test(channel)) throw new HumanCallError('conversations.open', 'no_dm_id')
    return channel
  }

  /** Top-level messages in `channel` after `oldest` (exclusive), oldest first. */
  async history(channel: string, oldest: string): Promise<SlackMessage[]> {
    const answer = await this.need('conversations.history', { channel, oldest, inclusive: false, limit: 200 })
    const messages = (Array.isArray(answer.messages) ? answer.messages : []).map(asMessage).filter((m): m is SlackMessage => m !== null)
    return messages.sort((a, b) => (tsAfter(a.ts, b.ts) ? 1 : -1))
  }

  /** One message by ts (top-level), or null. */
  async message(channel: string, ts: string): Promise<SlackMessage | null> {
    const answer = await this.need('conversations.history', { channel, oldest: ts, latest: ts, inclusive: true, limit: 1 })
    const list = Array.isArray(answer.messages) ? answer.messages : []
    return list.map(asMessage).find((m) => m?.ts === ts) ?? null
  }

  /** The replies in a thread (without the parent). */
  async replies(channel: string, threadTs: string): Promise<SlackMessage[]> {
    const answer = await this.need('conversations.replies', { channel, ts: threadTs, limit: 200 })
    return (Array.isArray(answer.messages) ? answer.messages : [])
      .map(asMessage)
      .filter((m): m is SlackMessage => m !== null && m.ts !== threadTs)
  }

  /**
   * Every message in `channel` after `oldest`, thread replies included. Only
   * threads whose parent is at or after `parentsSince` (default: `oldest`
   * itself, so the thread under the message a check posted counts) are
   * read, and of those only the ones with a reply newer than `oldest`.
   */
  async everythingAfter(channel: string, oldest: string, parentsSince: string = oldest): Promise<SlackMessage[]> {
    const listed = await this.historyFrom(channel, tsAfter(parentsSince, oldest) ? oldest : parentsSince)
    const out = listed.filter((m) => tsAfter(m.ts, oldest))
    for (const parent of listed) {
      if ((parent.reply_count ?? 0) === 0) continue
      if (parent.latest_reply !== undefined && !tsAfter(parent.latest_reply, oldest)) continue
      for (const r of await this.replies(channel, parent.ts)) if (tsAfter(r.ts, oldest)) out.push(r)
    }
    return out
  }

  /** Top-level messages in `channel` from `oldest` (inclusive), oldest first. */
  private async historyFrom(channel: string, oldest: string): Promise<SlackMessage[]> {
    const answer = await this.need('conversations.history', { channel, oldest, inclusive: true, limit: 200 })
    const messages = (Array.isArray(answer.messages) ? answer.messages : []).map(asMessage).filter((m): m is SlackMessage => m !== null)
    return messages.sort((a, b) => (tsAfter(a.ts, b.ts) ? 1 : -1))
  }

  /**
   * Wait for a message in `channel` after `after` from `bot` (top-level or in
   * a thread) whose text matches `match`. Returns it, or null at the
   * deadline. A transient Slack failure is a poll with nothing found yet.
   */
  async waitForBotMessage(
    channel: string,
    bot: BotRef,
    after: string,
    match: (text: string, message: SlackMessage) => boolean,
    timeoutMs: number,
  ): Promise<SlackMessage | null> {
    return waitFor(
      async () => {
        const messages = await notYetOnTransient(() => this.everythingAfter(channel, after))
        return messages?.find((m) => isFrom(m, bot) && match(messageText(m), m)) ?? null
      },
      { timeoutMs, intervalMs: POLL_MS, clock: this.clock },
    )
  }

  /** Wait until the message `ts` in `channel` satisfies `match` (e.g. a prompt updated by a click). */
  async waitForMessageState(
    channel: string,
    ts: string,
    match: (text: string, message: SlackMessage) => boolean,
    timeoutMs: number,
  ): Promise<SlackMessage | null> {
    return waitFor(
      async () => {
        const m = await notYetOnTransient(() => this.message(channel, ts))
        return m && match(messageText(m), m) ? m : null
      },
      { timeoutMs, intervalMs: POLL_MS, clock: this.clock },
    )
  }

  /** The human's user ID and team ID. */
  async whoami(): Promise<{ userId: string; teamId: string }> {
    const answer = await this.need('auth.test', {})
    return { userId: String(answer.user_id ?? ''), teamId: String(answer.team_id ?? '') }
  }

  /** A user's display name and full name as the workspace shows them (non-empty ones). */
  async userNames(user: string): Promise<string[]> {
    const answer = await this.need('users.info', { user })
    const u = answer.user && typeof answer.user === 'object' ? (answer.user as Record<string, unknown>) : {}
    const profile = u.profile && typeof u.profile === 'object' ? (u.profile as Record<string, unknown>) : {}
    return [profile.display_name, profile.real_name, u.real_name, u.name].filter((n): n is string => typeof n === 'string' && n !== '')
  }

  /** The conversations `user` is a member of (public and private channels). */
  async conversationsOf(user: string): Promise<string[]> {
    const answer = await this.need('users.conversations', { user, types: 'public_channel,private_channel', limit: 200 })
    return (Array.isArray(answer.channels) ? answer.channels : [])
      .map((c) => (c && typeof c === 'object' ? (c as Record<string, unknown>).id : undefined))
      .filter((id): id is string => typeof id === 'string')
  }

  /** The DM conversations the human has with `user`, if any (no DM is opened). */
  async existingDm(user: string): Promise<string | null> {
    const answer = await this.need('conversations.list', { types: 'im', limit: 1000 })
    for (const c of Array.isArray(answer.channels) ? answer.channels : []) {
      const o = c && typeof c === 'object' ? (c as Record<string, unknown>) : {}
      if (o.user === user && typeof o.id === 'string') return o.id
    }
    return null
  }
}
