/** Live-test agent input goes through AD, including its permission and dialog guards. */
import { POLL_MS, REPLY_TIMEOUT_MS, SECOND, waitFor } from '../lib/wait.ts'
import type { CheckContext } from './context.ts'
import { guarded, personaRowId, q, run } from './helpers.ts'
import type { PersonaLetter } from '../lib/personas.ts'

/** One ordinary submission; AD appends Enter. Never retry uncertain input. */
export function personaTextCommand(letter: PersonaLetter, text: string): string {
  return `agent-director send-keys --instance-id ${q(personaRowId(letter))} --text ${q(text)}`
}

export function personaInterruptCommand(letter: PersonaLetter): string {
  return `agent-director send-keys --instance-id ${q(personaRowId(letter))} --key Escape`
}

/**
 * Interrupt only when requested, then wait on AD's state before submitting.
 * No pending override, screen inspection or automatic pane-hash override.
 * Each action is attempted once: a refusal or uncertain delivery ends the step.
 */
export async function sendPersonaText(ctx: CheckContext, letter: PersonaLetter, text: string, interrupt = false): Promise<void> {
  const id = personaRowId(letter)
  if (interrupt) {
    const stopped = await guarded(ctx, personaInterruptCommand(letter))
    if (!stopped.ok || stopped.code !== 0) throw new Error(`agent-director interrupt refused or unconfirmed for ${id} (exit ${stopped.code})`)
  }
  const ready = await waitFor(async deadline => {
    const status = await run(ctx, `agent-director status --instance-id ${q(id)}`, Math.max(1, deadline - ctx.clock.now()))
    if (status.code !== 0) throw new Error(`agent-director status failed for ${id} (exit ${status.code})`)
    let state: unknown
    try { state = JSON.parse(status.out).state } catch { /* An unusable answer is never readiness. */ }
    if (state === 'waiting') return true
    if (state === 'pending' || state === 'working') return null
    throw new Error(`agent-director did not report an input-ready row for ${id}`)
  }, { timeoutMs: REPLY_TIMEOUT_MS, intervalMs: POLL_MS, clock: ctx.clock })
  if (!ready) throw new Error(`agent-director did not report waiting for ${id} within the input deadline`)
  // Native submission can take 60 s plus readiness/confirmation; keep its result.
  const sent = await guarded(ctx, personaTextCommand(letter, text), 90 * SECOND)
  if (!sent.ok || sent.code !== 0) throw new Error(`agent-director text refused or unconfirmed for ${id} (exit ${sent.code}); input was not retried`)
}
