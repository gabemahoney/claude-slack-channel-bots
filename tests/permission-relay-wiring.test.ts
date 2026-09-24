/**
 * permission-relay-wiring.test.ts — Static audit of the permission relay's
 * persona wiring in src/server.ts (b.av2 SR-7.1).
 *
 * The click handler resolves a click through the receiving persona and the
 * poller routes rows through the persona lookups. Both take these as
 * injected deps, and `receivingPersonaKey` is optional: if server.ts dropped
 * it, every click would be logged and bypassed, and no unit test of the
 * handler would notice. So this audit pins what server.ts passes:
 *
 * - `handlePermissionClick` gets `receivingPersonaKey` from
 *   `personaKeyFromActionId(actionId)` (TRANSITIONAL until E3 Task 9 takes it
 *   from the receiving connection), `clientFor` and
 *   `getPersona: getAppliedPersona`;
 * - `startPermissionPoller` gets `clientFor` and
 *   `getPersona: getAppliedPersona`.
 *
 * Why a static audit: importing src/server.ts runs module-scope startup code
 * against the real HOME and token environment, which unit tests must not do
 * (b.av2 SR-13.2). The audit reads the source with comments stripped and
 * anchors on content, never on line numbers.
 *
 * SPDX-License-Identifier: MIT
 */

import { describe, test, expect } from 'bun:test'
import { readFileSync } from 'node:fs'
import { indicesOf, stripComments } from './test-helpers/source-audit.ts'

const SERVER_SRC = readFileSync('src/server.ts', 'utf-8')

/** server.ts with every comment removed (see stripComments). */
const SERVER_CODE = stripComments(SERVER_SRC)

/**
 * The argument text of the call whose name starts at `at`: from its opening
 * parenthesis to the matching closing one (both excluded).
 */
function callArguments(code: string, at: number): string {
  const open = code.indexOf('(', at)
  let depth = 0
  for (let i = open; i < code.length; i++) {
    if (code[i] === '(') depth++
    else if (code[i] === ')' && --depth === 0) return code.slice(open + 1, i)
  }
  throw new Error('unbalanced call')
}

/** The arguments of the only call of `name` in code; fails unless there is exactly one. */
function onlyCallArguments(name: string): string {
  const calls = indicesOf(new RegExp(`\\b${name}\\s*\\(`, 'g'), SERVER_CODE)
  expect(calls).toHaveLength(1)
  return callArguments(SERVER_CODE, calls[0]!)
}

/** `clientFor` passed as a property, shorthand or `clientFor: clientFor`. */
const CLIENT_FOR_PROP = /(?:^|[{,\s])clientFor\s*(?:,|\}|$|:\s*clientFor\b)/m
const GET_PERSONA_PROP = /\bgetPersona\s*:\s*getAppliedPersona\b/

describe('server.ts wires the permission relay by persona (b.av2 SR-7.1)', () => {
  test('imports personaKeyFromActionId from the action-id module', () => {
    expect(SERVER_SRC).toMatch(
      /import\s*\{[^}]*\bpersonaKeyFromActionId\b[^}]*\}\s*from\s*['"]\.\/permission-action-id\.ts['"]/,
    )
  })

  test('the click handler gets the receiving persona key from personaKeyFromActionId(actionId), clientFor and getPersona', () => {
    const args = onlyCallArguments('handlePermissionClick')
    expect(args).toMatch(/\breceivingPersonaKey\s*:\s*personaKeyFromActionId\s*\(\s*actionId\s*\)/)
    expect(args).toMatch(CLIENT_FOR_PROP)
    expect(args).toMatch(GET_PERSONA_PROP)
  })

  test('the poller gets clientFor and getPersona', () => {
    const args = onlyCallArguments('startPermissionPoller')
    expect(args).toMatch(CLIENT_FOR_PROP)
    expect(args).toMatch(GET_PERSONA_PROP)
  })
})
