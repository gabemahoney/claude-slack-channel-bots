/** Best-effort correction of an existing notice, using its original Slack identity. */
import type { PostedPersonaNotice } from './persona-notifier.ts'
import type { PersonaConnectionClock } from './persona-connections.ts'
import { describeSlackCallFailure } from './persona-connection-errors.ts'
import { OWN_POST_CANCELLED } from './persona-destination.ts'
import { ownPostAnswerOfError, ownPostAnswerOfPost, type OwnPostAnswer, type OwnPostStart } from './own-post.ts'
import { SERVER_POST_EVENT_TYPE } from './server-post.ts'

export const NOTICE_CORRECTION_TIMEOUT_MS = 10_000
export type NoticeCorrectionOutcome =
  | { outcome: 'success' | 'cancelled' }
  | { outcome: 'failed'; reason: string }
export interface NoticeCorrectionDeps {
  clock: PersonaConnectionClock
  signal: AbortSignal
  isActive(): boolean
  logOutcome(operation: 'edit' | 'correction', result: NoticeCorrectionOutcome): void
}

/** A late Slack answer cannot restart work after the bound or lifecycle cancellation. */
function attempt(call: () => Promise<unknown>, deps: NoticeCorrectionDeps): Promise<NoticeCorrectionOutcome> {
  if (deps.signal.aborted || !deps.isActive()) return Promise.resolve({ outcome: 'cancelled' })
  return new Promise(resolve => {
    let settled = false
    let timer: ReturnType<PersonaConnectionClock['setTimeout']>
    const finish = (result: NoticeCorrectionOutcome) => {
      if (settled) return
      settled = true
      deps.clock.clearTimeout(timer)
      deps.signal.removeEventListener('abort', cancel)
      resolve(result)
    }
    const cancel = () => finish({ outcome: 'cancelled' })
    timer = deps.clock.setTimeout(() => finish({ outcome: 'failed', reason: 'timeout' }), NOTICE_CORRECTION_TIMEOUT_MS)
    deps.signal.addEventListener('abort', cancel, { once: true })
    try {
      void call().then(() => finish({ outcome: 'success' }), error => finish({ outcome: 'failed', reason: describeSlackCallFailure(error) }))
    } catch (error) { finish({ outcome: 'failed', reason: describeSlackCallFailure(error) }) }
  })
}

/**
 * The fallback is a new message as the persona, so it runs as an own-post
 * operation of the original post's kind (SR-3.2.1): the intent is kept before
 * the call, and the operation ends with Slack's own answer whatever this
 * correction's bound or cancellation decides. Bookkeeping never changes the
 * correction (SR-3.2.5).
 */
async function postCorrection(post: PostedPersonaNotice, text: string, deps: NoticeCorrectionDeps): Promise<NoticeCorrectionOutcome> {
  const own = post.ownPost
  let op: OwnPostStart | undefined
  try {
    op = own?.observer.start(own.key, own.surface, { channel: post.channelId }, { kind: 'text', text })
    if (op?.ready) await op.ready
  } catch { /* join bookkeeping cannot change the correction */ }
  const end = (answer: OwnPostAnswer) => {
    try { own?.observer.end(op?.operation, answer) } catch { /* join bookkeeping cannot change the correction */ }
  }
  if (deps.signal.aborted || !deps.isActive()) { end({ kind: 'failed', code: OWN_POST_CANCELLED }); return { outcome: 'cancelled' } }
  return attempt(() => {
    let call: Promise<unknown>
    try {
      call = post.client.chat.postMessage({ channel: post.channelId, text, metadata: { event_type: SERVER_POST_EVENT_TYPE, event_payload: {} } })
    } catch (error) { end(ownPostAnswerOfError(error)); throw error }
    void call.then(response => end(ownPostAnswerOfPost(post.channelId, response)), error => end(ownPostAnswerOfError(error)))
    return call
  }, deps)
}

/** One edit, then at most one short same-place correction; neither enters destination retries. */
export async function correctPostedNotice(post: PostedPersonaNotice, text: string, deps: NoticeCorrectionDeps): Promise<void> {
  const active = () => !deps.signal.aborted && deps.isActive()
  if (!active()) return
  const formatted = post.format(text)
  const edited: NoticeCorrectionOutcome = post.ts
    ? await attempt(() => post.client.chat.update({ channel: post.channelId, ts: post.ts!, text: formatted }), deps)
    : { outcome: 'failed', reason: 'missing_message_ts' }
  if (!active() || edited.outcome === 'cancelled') return
  deps.logOutcome('edit', edited)
  if (edited.outcome === 'success') return
  const correction = await postCorrection(post, formatted, deps)
  if (active() && correction.outcome !== 'cancelled') deps.logOutcome('correction', correction)
}
