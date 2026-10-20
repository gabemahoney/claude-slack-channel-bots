/** Reply reminders use only AD row facts and CSCB's durable delivery/tool records. */
import type { GetResult } from 'agent-director'
import type { ReplyReminderQueue, QueueItem, ReplyCallTarget } from './delivery-queue.ts'
import { systemDeliveryClock, type DeliveryClock } from './delivery-lifecycle.ts'

export const REPLY_REMINDER_TEXT = "You received a Slack message and you haven't replied. If you meant to answer in Slack, do it now with the reply tool. If no reply is needed, just end your turn."
export const REPLY_REMINDER_POLL_MS = 1000
/** Set only on launches using CSCB's reply-preallowing template; AD keeps it on resume. */
export const REPLY_TOOL_PREALLOWED_LABEL = 'reply_tool_preallowed=1'
export interface ReplyReminders {
  wake(key: string): void
  /** Called synchronously when CSCB sees the bot invoke reply, including a failed call. */
  noteReplyCall(key: string): Promise<void>
  observe(key: string, row: GetResult): Promise<void>
  forget(key: string): Promise<void>
  start(): void
  stop(): Promise<void>
}
export function createReplyReminders(deps: {
  queue: ReplyReminderQueue
  getRow(key: string, current: () => boolean): Promise<GetResult | undefined>
  ready(key: string): boolean
  enabled(key: string): boolean
  prepare(key: string, item: QueueItem): Promise<void>
  onError(key: string, error: unknown): void
  clock?: DeliveryClock
  pollMs?: number
}): ReplyReminders {
  const clock = deps.clock ?? systemDeliveryClock
  interface State { generation: number; disabled: boolean; timer?: unknown; busy?: Promise<void>; replies?: ReplyCallTarget[]; cancel?: boolean }
  const states = new Map<string, State>()
  let stopped = false
  function state(key: string): State {
    let s = states.get(key)
    if (!s) { s = { generation: 0, disabled: false }; states.set(key, s) }
    return s
  }
  function cancelTimer(s: State): void { if (s.timer !== undefined) clock.clearTimeout(s.timer); s.timer = undefined }
  function pending(key: string, s: State): boolean { return s.cancel === true || s.replies !== undefined || (!s.disabled && deps.queue.replyReminderItems(key).length > 0) }
  function schedule(key: string, s: State, ms = deps.pollMs ?? REPLY_REMINDER_POLL_MS): void {
    cancelTimer(s)
    if (stopped || s.busy || !pending(key, s)) return
    s.timer = clock.setTimeout(() => { s.timer = undefined; void tick(key, s) }, ms)
  }
  async function flush(key: string, s: State): Promise<void> {
    if (s.cancel) { await deps.queue.cancelReplyReminders(key); s.cancel = false }
    const replies = s.replies
    if (replies !== undefined) {
      await deps.queue.recordReplyCall(key, replies)
      if (s.replies === replies) s.replies = undefined
    }
  }
  async function observe(key: string, row: GetResult, s: State, generation: number): Promise<void> {
    await flush(key, s)
    const configured = deps.enabled(key)
    // Older Claude rows resume their saved permissions, not the current
    // template. Do not prompt those conversations to call an unapproved tool.
    const enabled = configured && (row.agent !== 'claude' || row.labels.reply_tool_preallowed === '1')
    const current = () => deps.enabled(key) === configured && !stopped && !s.disabled && s.generation === generation && s.replies === undefined && !s.cancel && deps.ready(key)
    if (!current()) return
    const items = await deps.queue.observeReplyReminders(key, row, REPLY_REMINDER_TEXT, enabled, current)
    // Accepted work belongs to normal preparation/recovery even if teardown
    // starts after the durable append. Its delivery lifecycle gates all keys.
    const prepared = await Promise.allSettled(items.map(async item => deps.prepare(key, item)))
    for (const result of prepared) if (result.status === 'rejected') deps.onError(key, result.reason)
  }
  function run(key: string, s: State, work: () => Promise<void>): Promise<void> {
    cancelTimer(s)
    let queued: Promise<void>
    queued = (s.busy ?? Promise.resolve()).then(work).catch(error => deps.onError(key, error)).finally(() => {
      if (s.busy === queued) { s.busy = undefined; schedule(key, s) }
    })
    s.busy = queued
    return queued
  }
  function tick(key: string, s: State): Promise<void> {
    if (stopped) return Promise.resolve()
    if (s.busy) return s.busy
    const generation = s.generation
    return run(key, s, async () => {
      await flush(key, s)
      if (s.disabled || stopped || !deps.ready(key) || !deps.queue.replyReminderItems(key).length) return
      const current = () => !stopped && !s.disabled && s.generation === generation && deps.ready(key)
      const row = await deps.getRow(key, current)
      if (row && current()) await observe(key, row, s, generation)
    })
  }
  const api: ReplyReminders = {
    wake(key) { const s = state(key); s.disabled = false; schedule(key, s, 0) },
    noteReplyCall(key) {
      if (stopped) return Promise.resolve()
      const s = state(key)
      // Capture exact unrefused attempts before yielding. A later send for an
      // older queued message must not inherit this call's suppression.
      const targets = deps.queue.replyCallTargets(key)
      if (!targets.length) return Promise.resolve()
      const replies = new Map((s.replies ?? []).map(target => [target.seq, target]))
      for (const target of targets) {
        const previous = replies.get(target.seq)
        replies.set(target.seq, previous ? { seq: target.seq, ...(previous.attempts === undefined || target.attempts === undefined ? {} : { attempts: [...new Set([...previous.attempts, ...target.attempts])] }) } : target)
      }
      s.replies = [...replies.values()]
      // Persist before the reply handler proceeds, without waiting behind an
      // AD read. A failed write keeps the synchronous suppression and retries.
      return flush(key, s).catch(error => deps.onError(key, error)).finally(() => schedule(key, s))
    },
    observe(key, row) {
      if (stopped) return Promise.resolve()
      const s = state(key), generation = s.generation
      // Engine reads must not disappear behind a slow independent poll: keep
      // each authoritative row observation in order through the same writer.
      return run(key, s, () => observe(key, row, s, generation))
    },
    async forget(key) {
      const s = state(key)
      s.generation++; s.disabled = true; s.cancel = true; cancelTimer(s)
      await s.busy
      try { await flush(key, s) } catch (error) { deps.onError(key, error); schedule(key, s) }
    },
    start() { for (const key of deps.queue.keys()) schedule(key, state(key), 0) },
    async stop() {
      stopped = true
      for (const s of states.values()) { s.generation++; cancelTimer(s) }
      await Promise.allSettled([...states.values()].flatMap(s => s.busy ? [s.busy] : []))
      await Promise.allSettled([...states].map(async ([key, s]) => { try { await flush(key, s) } catch (error) { deps.onError(key, error) } }))
    },
  }
  return api
}
