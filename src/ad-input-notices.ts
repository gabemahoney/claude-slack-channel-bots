import type { SubmissionUnconfirmedFacts } from './ad-error-class.ts'
import { CONFLICT_NOTICE_HUMAN_ONLY_LINE } from './conflict-latch.ts'
import { renderPersonaRef } from './persona-identity.ts'
import { escapeSlackControlCharacters } from './slack-text-escape.ts'
import { renderLogMessageText, isSafeIdentifier } from './persona-connection-errors.ts'
export interface AdInputNoticePersona { readonly key: string; readonly name?: string }
const ref = (p: AdInputNoticePersona) => escapeSlackControlCharacters(p.name === undefined ? `persona=${p.key}` : renderPersonaRef(p.name, p.key))
export function buildAdInputHoldNotice(persona: AdInputNoticePersona, holdPath: string): string {
  return `:warning: Automatic input to persona ${ref(persona)} is paused because a previous input may have reached the agent. Queued messages are kept and will not be resent automatically. A human must follow "Unresolved ordinary input" in the "Operator actions" section of agent-director's README and resolve the input. To release the hold, create a new persona launch that CSCB observes, or stop CSCB, remove the reviewed hold record ${escapeSlackControlCharacters(holdPath)}, and start CSCB again. ${CONFLICT_NOTICE_HUMAN_ONLY_LINE}`
}
export function buildAdDeliveryUnconfirmedNotice(persona: AdInputNoticePersona): string {
  return `:warning: Delivery to persona ${ref(persona)} is unconfirmed. CSCB has kept the queued message and paused automatic resend. A human must follow "Unresolved ordinary input" in the "Operator actions" section of agent-director's README, resolve the input, and review the retained delivery before allowing it to be sent again. ${CONFLICT_NOTICE_HUMAN_ONLY_LINE}`
}
export function buildAdInputOutcomeLine(input: { readonly personaRef: string; readonly site: 'reconnect' | 'delivery' | 'pause'; readonly facts: SubmissionUnconfirmedFacts; readonly state?: string }): string {
  const f = input.facts
  return `[slack] ${input.site}: ${renderLogMessageText(input.personaRef)} outcome=${f.kind} step=${f.step} next=${f.next}${input.state && isSafeIdentifier(input.state) ? ` state=${input.state}` : ''} — ${f.kind === 'not_started' ? 'no input attempted for this call; read AD before retry' : f.kind === 'gateway_refused' ? 'gateway discarded submission; explicit resubmission required' : 'input may have reached the agent; automatic input held'}`
}
export function buildAdInputHoldClearedLine(personaRef: string, reason: 'new-launch' | 'operator'): string {
  return `[slack] input hold cleared: ${renderLogMessageText(personaRef)} reason=${reason}`
}
