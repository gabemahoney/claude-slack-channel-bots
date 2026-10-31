/** Best-effort correction of an existing notice, using its original Slack identity. */
import type { PostedPersonaNotice } from './persona-notifier.ts'
import type { PersonaConnectionClock } from './persona-connections.ts'
import { describeSlackCallFailure } from './persona-connection-errors.ts'

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
  const correction = await attempt(() => post.client.chat.postMessage({ channel: post.channelId, text: formatted }), deps)
  if (active() && correction.outcome !== 'cancelled') deps.logOutcome('correction', correction)
}
