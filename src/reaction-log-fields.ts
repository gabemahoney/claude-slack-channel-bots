/** Shared, pure rendering for content-free reaction diagnostics. */
import { escapeCause } from './persona-diagnostics.ts'
import { renderPersonaRef } from './persona-identity.ts'
import { redactSlackLogText } from './slack-log-redaction.ts'

/** JSON quoting covers C0; escapeCause also covers DEL, C1 and U+2028/U+2029. */
export function quoteReactionLogField(text: string): string {
  return escapeCause(JSON.stringify(redactSlackLogText(text)))
}

/** Unquoted metadata, such as a reason or change, stays in a single field. */
export function reactionLogWord(text: string): string {
  return escapeCause(redactSlackLogText(text)).replace(/\s/g, '_')
}

/** Configured names remain verbatim apart from quoting and control escaping. */
export function renderReactionPersonaRef(persona: { key: string; name?: string }): string {
  return escapeCause(persona.name !== undefined ? renderPersonaRef(persona.name, persona.key) : persona.key)
}
