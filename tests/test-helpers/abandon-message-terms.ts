/** Operator-only command spellings, derived from the runtime's public names. */
import { ABANDON_MESSAGE_COMMAND, ABANDON_MESSAGE_ROUTE } from '../../src/abandon-message.ts'

export const ABANDON_MESSAGE_TERMS: readonly string[] = Object.freeze([
  ABANDON_MESSAGE_COMMAND,
  ABANDON_MESSAGE_ROUTE,
  ABANDON_MESSAGE_COMMAND.replaceAll('-', '_'),
  ABANDON_MESSAGE_COMMAND.replace(/-([a-z])/g, (_dash, letter: string) => letter.toUpperCase()),
  ABANDON_MESSAGE_COMMAND.replaceAll('-', ' '),
])

export function abandonMessageTermsIn(text: string): string[] {
  const folded = text.toLowerCase()
  return ABANDON_MESSAGE_TERMS.filter(term => folded.includes(term.toLowerCase()))
}
