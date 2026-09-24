/**
 * permission-relay-wiring.test.ts — Static audit of the permission relay's
 * persona wiring in src/server.ts (b.av2 SR-7.1, SR-3.1).
 *
 * What the event router does with a click (the receiving connection's key as
 * `receivingPersonaKey`, the default `handlePermissionClick`, no key derived
 * from the clicked action) is driven through the real router in
 * tests/persona-connection-wiring.test.ts. What is left is wiring only
 * `main()` holds, so this audit pins what src/server.ts passes:
 *
 * - it builds the router, as the connection manager's `onEvent`, with
 *   `clientFor` and `getPersona: getAppliedPersona`;
 * - it starts the poller with `clientFor` and `getPersona: getAppliedPersona`,
 *   and with the one destination resolver the persona notifier also gets, so
 *   a persona's DM is opened once for both;
 * - it derives no persona key from an action ID.
 *
 * Why a static audit: main() cannot run in a unit test (the agent-director
 * startup gate, a real port, real Slack connections). The audit reads the
 * source with comments stripped and anchors on content, never on line numbers.
 *
 * SPDX-License-Identifier: MIT
 */

import { describe, test, expect } from 'bun:test'
import { readFileSync } from 'node:fs'
import { callsOf, indicesOf, objectProperties, onlyCallArguments, stripComments } from './test-helpers/source-audit.ts'

/** server.ts with every comment removed (see stripComments). */
const SERVER_CODE = stripComments(readFileSync('src/server.ts', 'utf-8'))

describe('server.ts wires the click path by persona (b.av2 SR-7.1, SR-3.1)', () => {
  test('server.ts derives no persona key from an action ID', () => {
    expect(indicesOf(/\bpersonaKeyFromActionId\b/g, SERVER_CODE)).toEqual([])
  })

  test('server.ts builds the router as the connection manager\'s onEvent, with clientFor, getPersona and the default click handler', () => {
    const managerProps = objectProperties(onlyCallArguments(SERVER_CODE, 'createPersonaConnectionManager'))
    expect(managerProps.get('onEvent')).toStartWith('createPersonaEventRouter(')
    const routerProps = objectProperties(onlyCallArguments(SERVER_CODE, 'createPersonaEventRouter'))
    expect(routerProps.get('clientFor')).toBe('clientFor')
    expect(routerProps.get('getPersona')).toBe('getAppliedPersona')
    // No override: the router's default, handlePermissionClick, decides clicks.
    expect(routerProps.has('handleClick')).toBe(false)
  })
})

describe('server.ts wires the permission poller by persona (b.av2 SR-7.1)', () => {
  test('the poller gets clientFor and getPersona', () => {
    const props = objectProperties(onlyCallArguments(SERVER_CODE, 'startPermissionPoller'))
    expect(props.get('clientFor')).toBe('clientFor')
    expect(props.get('getPersona')).toBe('getAppliedPersona')
  })

  test('the poller gets the one createPersonaDestinations resolver, the same one the persona notifier gets', () => {
    const decls = [...SERVER_CODE.matchAll(/\bconst\s+(\w+)\s*=\s*createPersonaDestinations\s*\(/g)].map((m) => m[1])
    expect(decls).toHaveLength(1)
    expect(callsOf(SERVER_CODE, 'createPersonaDestinations')).toHaveLength(1)
    const resolver = decls[0]!
    expect(objectProperties(onlyCallArguments(SERVER_CODE, 'startPermissionPoller')).get('destinations')).toBe(resolver)
    expect(objectProperties(onlyCallArguments(SERVER_CODE, 'createPersonaNotifier')).get('destinations')).toBe(resolver)
  })
})
