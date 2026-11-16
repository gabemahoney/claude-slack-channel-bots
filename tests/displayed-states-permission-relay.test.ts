/**
 * displayed-states-permission-relay.test.ts — the permission poller relays a
 * prompt whatever Displayed State agent-director 0.16 and 0.17.0 show over
 * the raw `check_permission` row.
 *
 * Harness: one persona (A, prompts to its own destination channel), its
 * `makeStubSlack` stub through `makePersonaClients`, and an agent-director
 * stub client installed as the singleton through the production installer
 * (`setClient`) and read by the poller through the module's `getClient`, as
 * `src/server.ts` wires it. The stub's `list` applies agent-director's
 * displayed-state filter (`listByDisplayedState`): a row showing
 * `needs_intelligence` does not match `state: ['check_permission']`, and
 * `label` entries `k=v` AND together. `get` answers the row's shown state
 * and both request projections: `permission_requests` is state-dependent,
 * while `unproven_requests` also carries background asks after the main Stop.
 *
 * Coverage, each for a row showing `needs_intelligence` and, as the control,
 * `check_permission`:
 *   - a request the poller is not tracking is posted on a tick, once, to the
 *     persona's destination, and tracked;
 *   - a second request on a row already showing the state, its first request
 *     tracked, is posted too; the first is not posted again, stays tracked
 *     and unhandled, and no post is updated.
 *
 * Each case runs `assertNoLeak` over the poller's log lines, trail events and
 * posts.
 *
 * SPDX-License-Identifier: MIT
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { Client, GetParams, GetPermissionParams, ListParams } from 'agent-director'
import type { Persona, PersonaConfig } from '../src/config.ts'
import { _resetPollerState, getLivePermission, stopPermissionPoller, type PermissionRequestRow } from '../src/permission-poller.ts'
import { _resetTrailFdForTests } from '../src/permission-trail.ts'
import { personaInstanceId, personaKey } from '../src/persona-identity.ts'
import { getClient, resetClientForTests, setClient } from '../src/agent-director-client.ts'
import { _resetOutageState, initOutageState } from '../src/outage-state.ts'
import {
  cannedGetResult,
  cannedGetPermissionResponse,
  cannedListRow,
  cannedPermissionRequest,
  errSpawnNotFound,
  listByDisplayedState,
  makeStubClient,
} from './test-helpers/agent-director-stub.ts'
import { assertNoLeak } from './test-helpers/credentials.ts'
import { makeMultiPersonaConfig } from './test-helpers/persona-config.ts'
import { makeStubSlack, type StubSlack } from './test-helpers/slack-stub.ts'
import { makePersonaClients, makeTrailCapture, posts, startManualPoller, updates } from './test-helpers/permission-relay-harness.ts'

const NAME_A = 'Alpha Relay'
const KEY_A = personaKey(NAME_A)
const INSTANCE_A = personaInstanceId(KEY_A)
const A_WORK = 'C0AWORK001'
const A_DEST = 'C0ADEST001'

const TOKEN_1 = '11111111-1111-4111-8111-111111111111'
const TOKEN_2 = '22222222-2222-4222-8222-222222222222'

/** The Displayed State agent-director 0.16 and 0.17.0 show over a raw `check_permission` row. */
const NEEDS_INTELLIGENCE = 'needs_intelligence'
const CHECK_PERMISSION = 'check_permission'

/** One spawn as the stub agent-director holds it: the state it shows and its open requests. */
interface StubSpawn {
  shown: string
  listed?: string
  requests: PermissionRequestRow[]
  unproven?: PermissionRequestRow[]
}

let personaDir: string
let config: PersonaConfig
let A: Persona
let stubA: StubSlack
/** The stub agent-director's spawns, by instance ID; a test changes them between ticks. */
let spawns: Map<string, StubSpawn>
let listCalls: ListParams[]
let getCalls: GetParams[]
let permissionCalls: GetPermissionParams[]
let logCalls: unknown[][]
let trail: ReturnType<typeof makeTrailCapture>

/** The stub agent-director client: `list` filters on the shown state; `get` answers the shown state and the open requests. */
function makeDisplayedStateClient() {
  const base = makeStubClient({
    getFn: (params: GetParams) => {
      getCalls.push(params)
      const spawn = spawns.get(params.instance_id)
      if (spawn === undefined) return errSpawnNotFound()
      return cannedGetResult({ state: spawn.shown, permission_requests: spawn.requests,
        unproven_requests: 'unproven' in spawn ? spawn.unproven : spawn.requests }, A, personaDir)
    },
    getPermissionCalls: permissionCalls,
    getPermissionResult: cannedGetPermissionResponse({ request_token: TOKEN_1, decision: 'deny', decision_reason: 'operator' }),
  })
  return Object.assign(base, {
    list: async (params: ListParams) => {
      listCalls.push(params)
      const rows = [...spawns.values()].map((spawn) => cannedListRow({ state: spawn.listed ?? spawn.shown }, A, personaDir))
      return { spawns: listByDisplayedState(rows, params) }
    },
  })
}

beforeEach(() => {
  _resetTrailFdForTests()
  spawns = new Map()
  listCalls = []
  getCalls = []
  permissionCalls = []
  logCalls = []
  trail = makeTrailCapture()
  personaDir = mkdtempSync(join(tmpdir(), 'displayed-states-relay-'))
  config = makeMultiPersonaConfig(
    [{ name: NAME_A, channels: [{ id: A_WORK, delivery: 'all' }, { id: A_DEST, delivery: 'mentions' }], permission_prompts: A_DEST }],
    personaDir,
  )
  ;[A] = config.personas as [Persona]
  stubA = makeStubSlack()
  setClient(makeDisplayedStateClient() as unknown as Client)
  initOutageState({ getClient, notify: () => {} })
})

describe.each(['pending', 'waiting', 'working', 'ask_user', CHECK_PERMISSION])('unproven discovery in %s', (shown) => {
  test('posts an undecided subagent request once after the main Stop, without closing it on the next tick', async () => {
    const request = cannedPermissionRequest({ request_token: TOKEN_1 })
    spawns.set(INSTANCE_A, { shown, requests: [], unproven: [request] })
    const ivl = startPoller()
    await ivl.tick()
    await ivl.tick()
    expect(postedTokens()).toEqual([TOKEN_1])
    expect(updates(stubA)).toHaveLength(0)
    expect(getLivePermission(INSTANCE_A, TOKEN_1)).toMatchObject({ handled: false, personaKey: KEY_A })
    expect(logCalls).toEqual([])
    expect(listCalls).toHaveLength(2)
    expect(getCalls).toHaveLength(2)
    expect(permissionCalls).toEqual([])
    assertNoLeak({ logCalls, trail: trail.events, posts: posts(stubA) }, `unproven request, ${shown}`)
  })
})

test('a tracked request decided while still unproven is reconciled once, without a duplicate post', async () => {
  const request = cannedPermissionRequest({ request_token: TOKEN_1 })
  spawns.set(INSTANCE_A, { shown: 'waiting', requests: [], unproven: [request] })
  const ivl = startPoller()
  await ivl.tick()
  expect(postedTokens()).toEqual([TOKEN_1])
  request.decision = 'deny'
  request.delivery = 'delivered'
  request.unproven_since = '2026-05-24T12:00:01Z'
  await ivl.tick()
  await ivl.tick()
  expect(postedTokens()).toEqual([TOKEN_1])
  expect(updates(stubA)).toHaveLength(1)
  expect(permissionCalls).toEqual([{ request_token: TOKEN_1 }])
  expect(getLivePermission(INSTANCE_A, TOKEN_1)).toBeUndefined()
})

test('overlapping projections and movement between them preserve each prompt without a false closing sweep', async () => {
  const first = cannedPermissionRequest({ request_token: TOKEN_1 })
  const second = cannedPermissionRequest({ request_token: TOKEN_2 })
  const spawn: StubSpawn = { shown: CHECK_PERMISSION, requests: [first], unproven: [] }
  spawns.set(INSTANCE_A, spawn)
  const ivl = startPoller()
  await ivl.tick()
  expect(postedTokens()).toEqual([TOKEN_1])
  spawn.shown = 'waiting'
  spawn.requests = []
  spawn.unproven = [first]
  await ivl.tick()
  expect(postedTokens()).toEqual([TOKEN_1])
  spawn.shown = CHECK_PERMISSION
  spawn.requests = [first, second]
  spawn.unproven = [first, second, second]
  await ivl.tick()
  expect(postedTokens()).toEqual([TOKEN_1, TOKEN_2])
  spawn.unproven = []
  await ivl.tick()
  expect(postedTokens()).toEqual([TOKEN_1, TOKEN_2])
  expect(updates(stubA)).toEqual([])
  expect(permissionCalls).toEqual([])
  expect(getCalls).toHaveLength(4)
  expect(getLivePermission(INSTANCE_A, TOKEN_1)).toBeDefined()
  expect(getLivePermission(INSTANCE_A, TOKEN_2)).toBeDefined()
  assertNoLeak({ logCalls, trail: trail.events, posts: posts(stubA) }, 'union discovery')
})

test.each([null, undefined])('a missing additive unproven projection (%s) still discovers permission_requests', async (missing) => {
  spawns.set(INSTANCE_A, { shown: CHECK_PERMISSION,
    requests: [cannedPermissionRequest({ request_token: TOKEN_1 })],
    unproven: missing as unknown as PermissionRequestRow[],
  })
  const ivl = startPoller()
  await ivl.tick()
  await ivl.tick()
  expect(postedTokens()).toEqual([TOKEN_1])
  expect(getLivePermission(INSTANCE_A, TOKEN_1)).toBeDefined()
  expect(permissionCalls).toEqual([])
  expect(updates(stubA)).toEqual([])
})

test('only fresh check_permission with no open requests advances the wedge; leaving it re-arms the warning', async () => {
  const spawn: StubSpawn = { shown: 'waiting', listed: CHECK_PERMISSION, requests: [] }
  spawns.set(INSTANCE_A, spawn)
  const ivl = startPoller(30000)
  for (let i = 0; i < 6; i++) await ivl.tick()
  expect(posts(stubA)).toHaveLength(0)
  spawn.shown = CHECK_PERMISSION
  for (let i = 0; i < 5; i++) await ivl.tick()
  expect(posts(stubA)).toHaveLength(1)
  spawn.shown = 'working'
  await ivl.tick()
  spawn.shown = CHECK_PERMISSION
  for (let i = 0; i < 5; i++) await ivl.tick()
  expect(posts(stubA)).toHaveLength(2)
})

test('closed or decided unproven requests never create prompts', async () => {
  spawns.set(INSTANCE_A, { shown: 'waiting', requests: [], unproven: [
    cannedPermissionRequest({ request_token: TOKEN_1, decision: 'allow', delivery: 'not_confirmed' }),
    cannedPermissionRequest({ request_token: TOKEN_2, unproven_since: '2026-05-24T12:00:01Z', delivery: 'fallen_back', pane_answer: 'outside' }),
  ] })
  const ivl = startPoller()
  await ivl.tick()
  expect(posts(stubA)).toHaveLength(0)
  expect(getLivePermission(INSTANCE_A, TOKEN_1)).toBeUndefined()
  expect(getLivePermission(INSTANCE_A, TOKEN_2)).toBeUndefined()
})

test.each([null, undefined])('a non-conforming unproven projection (%s) holds tracked prompts', async (malformed) => {
  const spawn: StubSpawn = { shown: 'waiting', requests: [], unproven: [cannedPermissionRequest({ request_token: TOKEN_1 })] }
  spawns.set(INSTANCE_A, spawn)
  const ivl = startPoller()
  await ivl.tick()
  expect(postedTokens()).toEqual([TOKEN_1])
  spawn.unproven = malformed as unknown as PermissionRequestRow[]
  await ivl.tick()
  expect(getLivePermission(INSTANCE_A, TOKEN_1)).toBeDefined()
  expect(updates(stubA)).toEqual([])
  expect(permissionCalls).toEqual([])
  expect(logCalls.flat().join(' ')).toContain('non-conforming open-rows response')
})

test.each(['waiting', 'working', 'ask_user', 'pending'])('a latched %s row gets no discovery read; check_permission and an unlatched row still do', async (shown) => {
  const first = cannedPermissionRequest({ request_token: TOKEN_1 })
  const second = cannedPermissionRequest({ request_token: TOKEN_2 })
  const spawn: StubSpawn = { shown, requests: [], unproven: [first] }
  spawns.set(INSTANCE_A, spawn)
  let latched = true
  const ivl = startPoller(1000, () => latched)
  await ivl.tick()
  expect(getCalls).toHaveLength(0)
  expect(posts(stubA)).toHaveLength(0)
  expect(permissionCalls).toEqual([])
  spawn.shown = CHECK_PERMISSION
  spawn.requests = [first]
  await ivl.tick()
  await ivl.tick()
  expect(getCalls).toHaveLength(2)
  expect(postedTokens()).toEqual([TOKEN_1])
  expect(updates(stubA)).toEqual([])
  latched = false
  spawn.shown = shown
  spawn.requests = []
  spawn.unproven = [first, second]
  await ivl.tick()
  expect(getCalls).toHaveLength(3)
  expect(postedTokens()).toEqual([TOKEN_1, TOKEN_2])
  expect(permissionCalls).toEqual([])
  assertNoLeak({ logCalls, trail: trail.events, posts: posts(stubA) }, `latched ${shown}`)
})

afterEach(() => {
  stopPermissionPoller()
  _resetPollerState()
  resetClientForTests()
  _resetOutageState()
  rmSync(personaDir, { recursive: true, force: true })
})

/** Start the poller as `src/server.ts` wires it, reading the installed agent-director client. */
function startPoller(intervalMs = 1000, isPersonaLatched = (_key: string) => false) {
  const clients = makePersonaClients((key) => (key === KEY_A ? stubA : undefined))
  return startManualPoller({
    isPersonaLatched,
    intervalMs,
    getClient,
    clientFor: clients.clientFor,
    getPersona: (key) => config.personas.find((p) => p.key === key),
    getPersonaConfig: () => config,
    emitTrail: trail.emit,
    log: (...args) => { logCalls.push(args) },
  })
}

/** The request tokens of the prompts posted on A's client, in post order, read from their Allow buttons. */
function postedTokens(): string[] {
  return posts(stubA).map((call) => {
    const actions = (call.blocks as Array<{ type: string; elements?: Array<{ action_id: string }> }>).find((b) => b.type === 'actions')
    const allow = actions?.elements?.[0]?.action_id ?? ''
    return allow.slice(`perm_allow_${INSTANCE_A}_`.length)
  })
}

describe.each([NEEDS_INTELLIGENCE, CHECK_PERMISSION])('a cscb persona row showing %s', (shown) => {
  test('a request the poller is not tracking is posted on a tick, once, to the persona\'s destination, and tracked', async () => {
    spawns.set(INSTANCE_A, { shown, requests: [cannedPermissionRequest({ request_token: TOKEN_1, request_id: 1 })] })
    const ivl = startPoller()

    await ivl.tick()
    await ivl.tick()

    expect(listCalls).toHaveLength(2)
    expect(posts(stubA).map((c) => c.channel)).toEqual([A_DEST])
    expect(postedTokens()).toEqual([TOKEN_1])
    expect(getLivePermission(INSTANCE_A, TOKEN_1)).toMatchObject({ channelId: A_DEST, personaKey: KEY_A, handled: false })
    assertNoLeak({ logCalls, trail: trail.events, posts: posts(stubA) }, `untracked request, ${shown}`)
  })

  test('a second request on a row already showing the state is posted; the first is not posted again and stays tracked and unhandled', async () => {
    const first = cannedPermissionRequest({ request_token: TOKEN_1, request_id: 1 })
    const second = cannedPermissionRequest({ request_token: TOKEN_2, request_id: 2 })
    // The first request is posted while the row shows raw check_permission.
    spawns.set(INSTANCE_A, { shown: CHECK_PERMISSION, requests: [first] })
    const ivl = startPoller()
    await ivl.tick()
    expect(postedTokens()).toEqual([TOKEN_1])

    // The row comes to show the state with the first request still open, then a second request opens.
    spawns.set(INSTANCE_A, { shown, requests: [first] })
    await ivl.tick()
    spawns.set(INSTANCE_A, { shown, requests: [first, second] })
    await ivl.tick()

    expect(postedTokens()).toEqual([TOKEN_1, TOKEN_2])
    expect(posts(stubA).map((c) => c.channel)).toEqual([A_DEST, A_DEST])
    expect(getLivePermission(INSTANCE_A, TOKEN_1)).toMatchObject({ channelId: A_DEST, personaKey: KEY_A, handled: false })
    expect(getLivePermission(INSTANCE_A, TOKEN_2)).toMatchObject({ channelId: A_DEST, personaKey: KEY_A, handled: false })
    expect(updates(stubA)).toHaveLength(0)
    assertNoLeak({ logCalls, trail: trail.events, posts: posts(stubA) }, `second request, ${shown}`)
  })
})
