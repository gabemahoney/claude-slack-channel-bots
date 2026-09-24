/**
 * test-helpers/action-id-key.ts — Recover the persona key a permission
 * action ID was built for.
 *
 * Production code no longer needs this: each click arrives on its persona's
 * own connection, which names the receiving persona (b.av2 SR-11). Tests still
 * use it to check which persona a posted button targets, and to derive a
 * receiving key from the clicked action. Built only on the production decoder
 * and prefix, so it cannot drift from the wire format.
 *
 * SPDX-License-Identifier: MIT
 */

import { parsePermissionActionId } from '../../src/permission-action-id.ts'
import { PERSONA_INSTANCE_ID_PREFIX } from '../../src/persona-identity.ts'

/**
 * The persona key in `actionId`'s instance ID (`cscb_<key>` with the prefix
 * removed, the inverse of `personaInstanceId`). Undefined for a foreign or
 * malformed action ID.
 */
export function personaKeyFromActionId(actionId: string): string | undefined {
  const parsed = parsePermissionActionId(actionId)
  if (parsed === null || !parsed.claudeInstanceId.startsWith(PERSONA_INSTANCE_ID_PREFIX)) return undefined
  return parsed.claudeInstanceId.slice(PERSONA_INSTANCE_ID_PREFIX.length)
}
