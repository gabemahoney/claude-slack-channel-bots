/**
 * agent-director-client-displayed-states.test.ts — the installed agent-director
 * client answers raw states for agent-director 0.16 and 0.17.0's Displayed
 * States, and passes rows in agent-director 0.17.1's wire format through.
 *
 * `setClient` and `setClientForTests` normalise the client they install, in
 * place: `get`, `status` and `list` answer `check_permission` for a row
 * showing `needs_intelligence` in `state` and `working` for one showing
 * `idle_screen` (agent-director `docs/caller-contract.md`, "Needs-intelligence
 * and idle-screen rows": both are reports only, over those raw states), and a
 * `list` state filter also asks for the Displayed States shown over the raw
 * states it names, since agent-director 0.16 and 0.17.0 match a filter on the
 * shown state alone. When it widens a filter, `list` keeps only the rows
 * whose raw state the caller named: agent-director 0.17.1 keeps `state` raw,
 * adds `displayed_state` and matches a filter on either (`pkg/api/list.go`
 * `listFiltered`, `release/v0.17.1`). 0.17.1 itself shows only `idle_screen`,
 * over `working`, and never `needs_intelligence` (`pkg/api/display.go`); the
 * drop guards against a later agent-director showing `needs_intelligence` (or
 * `idle_screen`) over another raw state, which a widened filter would
 * otherwise list.
 *
 * Harness: `makeStubClient` with canned answers (`getResult`, `statusResult`,
 * `listResult`, `killResult` and the `<verb>Error` knobs) and its call-capture
 * arrays, with `get`, `status`, `list` and `kill` wrapped to also record each
 * call's `this` and every argument, which the stub's arrays leave out. Rows
 * come from `cannedGetResult`, `cannedStatusResult` and `cannedListRow`, plus
 * the fields agent-director 0.16 and 0.17 give each verb and state, which the
 * pinned 0.12.0 client's types lack (its `docs/caller-contract.md`,
 * "Needs-intelligence and idle-screen rows", and `docs/usage.md`, "Family
 * state"): every row `family_state` and `idle_screen_availability`; a `get`
 * or `status` row showing a Displayed State its `since` and detail
 * (`request_token` and `tool_name` on `needs_intelligence`,
 * `unchanged_minutes` on `idle_screen`), and a `status` row
 * `tmux_session_name` too; a `list` row neither; a row in the 0.17.1 wire
 * format its `displayed_state`. `permission_requests` is open only over raw
 * `check_permission`.
 *
 * Coverage, through `setClient`:
 *   - `get`, `status` and each `list` row: each Displayed State in `state`
 *     maps to its raw state with every other field kept; every other state,
 *     an unknown one included, and every 0.17.1-format row answer the
 *     verb's own value; the inner verb runs on the client with the caller's
 *     arguments, and its rejection reaches the caller as is;
 *   - `list` state filter: widened for `check_permission` and `working`, with
 *     no duplicate when the caller names a Displayed State; no change for other
 *     states, an empty filter or no filter; the caller's params never mutated;
 *   - `list` rows after a widened filter: a row whose raw state the caller did
 *     not name dropped; the result itself answered when no row is dropped or
 *     normalised; no row dropped when the filter was not widened;
 *   - every other verb is the client's own function; a missing verb stays
 *     missing;
 *   - `getClient()` returns the installed object.
 *
 * Through `setClientForTests`, which normalises as `setClient` does: a `get`
 * row showing `needs_intelligence` and a widened `list` state filter.
 * Reinstalling a client with the other installer wraps no verb twice.
 *
 * SPDX-License-Identifier: MIT
 */

import { afterEach, describe, expect, test } from 'bun:test'
import type { Client, GetParams, GetResult, ListParams, ListResult, StatusParams, StatusResult } from 'agent-director'
import { getClient, resetClientForTests, setClient, setClientForTests } from '../src/agent-director-client.ts'
import {
  cannedGetResult,
  cannedListRow,
  cannedPermissionRequest,
  cannedStatusResult,
  makeStubClient,
  type StubClientOptions,
} from './test-helpers/agent-director-stub.ts'

const NEEDS_INTELLIGENCE = 'needs_intelligence'
const IDLE_SCREEN = 'idle_screen'
const CHECK_PERMISSION = 'check_permission'
const WORKING = 'working'

/** Every state agent-director 0.12–0.17 reports that is not a Displayed State, and one it may add later. */
const OTHER_STATES = ['pending', 'waiting', WORKING, 'ask_user', CHECK_PERMISSION, 'ended', 'missing', 'some_later_state']

/**
 * The row shapes agent-director 0.17.1's wire format allows: a raw `state` and
 * the Displayed State in `displayed_state` shown over it. 0.17.1 itself shows
 * only `idle_screen` over `working`; the others guard against a later
 * agent-director.
 */
const WIRE_0171_SHAPES = [
  [CHECK_PERMISSION, NEEDS_INTELLIGENCE],
  [CHECK_PERMISSION, IDLE_SCREEN],
  [WORKING, NEEDS_INTELLIGENCE],
  [WORKING, IDLE_SCREEN],
] as const

const INSTANCE = 'cscb_alpha'
const REQUEST_TOKEN = '33333333-3333-4333-8333-333333333333'
const SINCE = '2026-10-23T12:00:00.123Z'

type RowVerb = 'get' | 'status' | 'list'
type Row = Record<string, unknown>

/** The fields agent-director 0.16 and 0.17 give `verb`'s row showing `shown` (see the header). */
function adFields(verb: RowVerb, shown: string): Row {
  const fields: Row = {
    family_state: ['waiting', 'ended', 'missing'].includes(shown) ? 'waiting' : WORKING,
    idle_screen_availability: 'available',
  }
  if (verb !== 'list' && shown === NEEDS_INTELLIGENCE) Object.assign(fields, { since: SINCE, request_token: REQUEST_TOKEN, tool_name: 'Bash' })
  if (verb !== 'list' && shown === IDLE_SCREEN) Object.assign(fields, { since: SINCE, unchanged_minutes: 21 })
  if (verb === 'status' && (shown === NEEDS_INTELLIGENCE || shown === IDLE_SCREEN)) fields.tmux_session_name = 'slack_bot_alpha'
  return fields
}

/**
 * A Claude row as `verb` answers it with `state`: from agent-director 0.16 or
 * 0.17.0, or, given `displayed`, in the 0.17.1 wire format with that Displayed
 * State shown over `state`.
 */
function row(verb: RowVerb, state: string, { displayed, instanceId = INSTANCE }: { displayed?: string; instanceId?: string } = {}): Row {
  const fields = { ...adFields(verb, displayed ?? state), ...(displayed === undefined ? {} : { displayed_state: displayed }) }
  const permission_requests = state === CHECK_PERMISSION || state === NEEDS_INTELLIGENCE
    ? [cannedPermissionRequest({ request_token: REQUEST_TOKEN })]
    : []
  if (verb === 'status') return { ...cannedStatusResult({ state }), ...fields }
  if (verb === 'get') return { ...cannedGetResult({ instance_id: instanceId, state, permission_requests }), ...fields }
  return { ...cannedListRow({ instance_id: instanceId, state, permission_requests }), ...fields }
}

/** A `list` result of `rows`. */
const listOf = (...rows: Row[]): ListResult => ({ spawns: rows }) as unknown as ListResult

/** `verb`'s canned answer as the stub's knob for it. */
function answering(verb: RowVerb, value: Row): StubClientOptions {
  if (verb === 'get') return { getResult: value as unknown as GetResult }
  if (verb === 'status') return { statusResult: value as unknown as StatusResult }
  return { listResult: value as unknown as ListResult }
}

/** `verb`'s rejection with `error` as the stub's knob for it. */
function rejecting(verb: RowVerb, error: Error): StubClientOptions {
  if (verb === 'get') return { getError: error }
  if (verb === 'status') return { statusError: error }
  return { listError: error }
}

interface RecordedCall {
  args: unknown[]
  self: unknown
}

type Verbs = Record<string, (...args: unknown[]) => Promise<unknown>>

/**
 * A stub client from `makeStubClient(opts)` reporting binary 0.17.0: `calls`
 * holds the parameters its `get`, `status` and `list` received; `seen` holds
 * each `get`, `status`, `list` and `kill` call's `this` and every argument;
 * `own` holds its verbs before any install.
 */
function makeClient(opts: StubClientOptions = {}) {
  const calls = { get: [] as GetParams[], status: [] as StatusParams[], list: [] as ListParams[] }
  const client = makeStubClient({ binaryVersion: '0.17.0', getCalls: calls.get, statusCalls: calls.status, listCalls: calls.list, ...opts })
  const verbs = client as unknown as Verbs
  const seen: Record<string, RecordedCall[]> = { get: [], status: [], list: [], kill: [] }
  for (const verb of Object.keys(seen)) {
    const inner = verbs[verb]!
    verbs[verb] = async function (this: unknown, ...args: unknown[]) {
      seen[verb]!.push({ args, self: this })
      return inner.apply(this, args)
    }
  }
  return { client, own: { ...verbs }, calls, seen }
}

/** The client as CSCB's callers read it. */
const asClient = (client: object) => client as unknown as Client
const installed = () => getClient() as unknown as Verbs

afterEach(() => {
  resetClientForTests()
})

describe('a client installed with setClient', () => {
  const install = setClient

  describe.each(['get', 'status'] as const)('%s', (verb) => {
    test.each([
      [NEEDS_INTELLIGENCE, CHECK_PERMISSION],
      [IDLE_SCREEN, WORKING],
    ])('a row showing %s answers %s, every other field kept', async (shown, raw) => {
      const given = row(verb, shown)
      const { client } = makeClient(answering(verb, given))
      install(asClient(client))

      expect(await installed()[verb]!({ instance_id: INSTANCE })).toEqual({ ...given, state: raw })
      expect(given.state).toBe(shown)
    })

    test.each(OTHER_STATES)('a row showing %s is answered as the client gave it', async (state) => {
      const given = row(verb, state)
      const { client } = makeClient(answering(verb, given))
      install(asClient(client))

      expect(await installed()[verb]!({ instance_id: INSTANCE })).toBe(given)
    })

    test.each(WIRE_0171_SHAPES)('a 0.17.1-format row, %s showing %s, is answered as the client gave it', async (state, displayed) => {
      const given = row(verb, state, { displayed })
      const { client } = makeClient(answering(verb, given))
      install(asClient(client))

      const result = (await installed()[verb]!({ instance_id: INSTANCE })) as Row

      expect(result).toBe(given)
      expect(result).toMatchObject({ state, displayed_state: displayed })
    })

    test('the client\'s verb runs on the client with the caller\'s arguments', async () => {
      const { client, calls, seen } = makeClient(answering(verb, row(verb, NEEDS_INTELLIGENCE)))
      install(asClient(client))
      const params = { instance_id: INSTANCE }
      const extra = { signal: 'x' }

      await installed()[verb]!(params, extra)

      expect(calls[verb]).toHaveLength(1)
      expect(calls[verb][0]).toBe(params)
      expect(seen[verb]).toHaveLength(1)
      expect(seen[verb]![0]!.self).toBe(client)
      expect(seen[verb]![0]!.args[1]).toBe(extra)
    })

    test('the client\'s rejection reaches the caller unchanged', async () => {
      const failure = new Error('spawn not found')
      const { client } = makeClient(rejecting(verb, failure))
      install(asClient(client))

      await expect(installed()[verb]!({ instance_id: INSTANCE })).rejects.toBe(failure)
    })
  })

  test('a get row showing needs_intelligence keeps its permission_requests array itself', async () => {
    const given = row('get', NEEDS_INTELLIGENCE)
    const { client } = makeClient(answering('get', given))
    install(asClient(client))

    const result = (await installed().get!({ instance_id: INSTANCE })) as Row

    expect(result.permission_requests).toBe(given.permission_requests)
  })

  describe('list rows', () => {
    test('each row showing a Displayed State answers its raw state; the others, and the result\'s other fields, are kept', async () => {
      const ni = row('list', NEEDS_INTELLIGENCE, { instanceId: 'cscb_a' })
      const plain = row('list', CHECK_PERMISSION, { instanceId: 'cscb_b' })
      const idle = row('list', IDLE_SCREEN, { instanceId: 'cscb_c' })
      const waiting = row('list', 'waiting', { instanceId: 'cscb_d' })
      const result = { spawns: [ni, plain, idle, waiting], next: 'kept' }
      const { client } = makeClient(answering('list', result))
      install(asClient(client))

      const listed = (await installed().list!({ label: ['service=cscb'] })) as typeof result

      expect(listed).toEqual({
        spawns: [{ ...ni, state: CHECK_PERMISSION }, plain, { ...idle, state: WORKING }, waiting],
        next: 'kept',
      })
      expect(listed.spawns[0]!.permission_requests).toBe(ni.permission_requests)
      expect(listed.spawns[1]).toBe(plain)
      expect(listed.spawns[3]).toBe(waiting)
      expect(result.spawns.map((r) => r.state)).toEqual([NEEDS_INTELLIGENCE, CHECK_PERMISSION, IDLE_SCREEN, 'waiting'])
    })

    test('a result with no row showing a Displayed State is answered as the client gave it', async () => {
      const result = listOf(...OTHER_STATES.map((state, i) => row('list', state, { instanceId: `cscb_${i}` })))
      const { client } = makeClient({ listResult: result })
      install(asClient(client))

      expect(await installed().list!({})).toBe(result)
    })

    test('0.17.1-format rows are answered as the client gave them, displayed_state untouched', async () => {
      const result = listOf(...WIRE_0171_SHAPES.map(([state, displayed], i) => row('list', state, { displayed, instanceId: `cscb_${i}` })))
      const { client } = makeClient({ listResult: result })
      install(asClient(client))

      const listed = (await installed().list!({ label: ['service=cscb'] })) as ListResult

      expect(listed).toBe(result)
      expect(listed.spawns.map((r) => [r.state, (r as unknown as Row).displayed_state])).toEqual(WIRE_0171_SHAPES.map(([s, d]) => [s, d]))
    })

    test('the client\'s rejection reaches the caller unchanged', async () => {
      const failure = new Error('list failed')
      const { client } = makeClient({ listError: failure })
      install(asClient(client))

      await expect(installed().list!({ state: [CHECK_PERMISSION] })).rejects.toBe(failure)
    })
  })

  describe('list rows after a widened state filter', () => {
    // 0.17.1 shows neither pairing; a later agent-director may show either.
    test.each([
      [CHECK_PERMISSION, WORKING, NEEDS_INTELLIGENCE],
      [WORKING, CHECK_PERMISSION, IDLE_SCREEN],
    ])('[%s] drops a raw %s row showing %s and keeps the rows of the raw state asked for, normalised', async (asked, other, displayed) => {
      const dropped = row('list', other, { displayed, instanceId: 'cscb_a' })
      const plain = row('list', asked, { instanceId: 'cscb_b' })
      const shown = row('list', displayed, { instanceId: 'cscb_c' })
      const result = listOf(dropped, plain, shown)
      const { client } = makeClient({ listResult: result })
      install(asClient(client))

      const listed = (await installed().list!({ state: [asked], label: ['service=cscb'] })) as ListResult

      expect(listed).toEqual(listOf(plain, { ...shown, state: asked }))
      expect(listed.spawns[0]).toBe(plain as never)
      expect(result.spawns).toHaveLength(3)
    })

    test('the result itself is answered when every row has a raw state asked for', async () => {
      const result = listOf(
        row('list', CHECK_PERMISSION, { instanceId: 'cscb_a' }),
        row('list', CHECK_PERMISSION, { displayed: NEEDS_INTELLIGENCE, instanceId: 'cscb_b' }),
        row('list', WORKING, { displayed: IDLE_SCREEN, instanceId: 'cscb_c' }),
        row('list', WORKING, { instanceId: 'cscb_d' }),
      )
      const { client } = makeClient({ listResult: result })
      install(asClient(client))

      expect(await installed().list!({ state: [CHECK_PERMISSION, WORKING] })).toBe(result)
    })

    test.each([
      ['no params', undefined],
      ['no state filter', { label: ['service=cscb'] }],
      ['an empty state filter', { state: [] }],
      ['a filter naming check_permission and needs_intelligence', { state: [CHECK_PERMISSION, NEEDS_INTELLIGENCE] }],
      ['a filter naming a Displayed State alone', { state: [NEEDS_INTELLIGENCE] }],
      ['a filter naming no raw state a Displayed State is shown over', { state: ['waiting'] }],
    ])('%s: no row is dropped', async (_case, params) => {
      const raw = row('list', WORKING, { displayed: NEEDS_INTELLIGENCE, instanceId: 'cscb_a' })
      const waiting = row('list', 'waiting', { instanceId: 'cscb_b' })
      const shown = row('list', NEEDS_INTELLIGENCE, { instanceId: 'cscb_c' })
      const { client } = makeClient({ listResult: listOf(raw, waiting, shown) })
      install(asClient(client))

      const listed = (await installed().list!(params)) as ListResult

      expect(listed).toEqual(listOf(raw, waiting, { ...shown, state: CHECK_PERMISSION }))
      expect(listed.spawns[0]).toBe(raw as never)
    })
  })

  describe('list state filter', () => {
    test.each([
      [[CHECK_PERMISSION], [CHECK_PERMISSION, NEEDS_INTELLIGENCE]],
      [[WORKING], [WORKING, IDLE_SCREEN]],
      [[WORKING, CHECK_PERMISSION], [WORKING, CHECK_PERMISSION, IDLE_SCREEN, NEEDS_INTELLIGENCE]],
      [['waiting', CHECK_PERMISSION], ['waiting', CHECK_PERMISSION, NEEDS_INTELLIGENCE]],
      [[CHECK_PERMISSION, NEEDS_INTELLIGENCE, WORKING], [CHECK_PERMISSION, NEEDS_INTELLIGENCE, WORKING, IDLE_SCREEN]],
    ])('%j asks the client for %j, the other params kept', async (asked, sent) => {
      const { client, calls } = makeClient()
      install(asClient(client))
      const params = { state: asked, label: ['service=cscb'], limit: 5 }

      await installed().list!(params)

      const passed = calls.list[0]!
      expect([...passed.state!].sort()).toEqual([...sent].sort())
      expect(new Set(passed.state).size).toBe(passed.state!.length)
      expect(passed.label).toBe(params.label)
      expect(passed.limit).toBe(5)
    })

    test.each([
      [[CHECK_PERMISSION, NEEDS_INTELLIGENCE]],
      [[WORKING, IDLE_SCREEN]],
      [[NEEDS_INTELLIGENCE]],
      [[IDLE_SCREEN]],
      [['waiting', 'ask_user', 'pending', 'ended', 'missing']],
      [[]],
    ])('%j reaches the client as the caller passed it', async (asked) => {
      const { client, calls } = makeClient()
      install(asClient(client))
      const params = { state: asked, label: ['service=cscb'] }

      await installed().list!(params)

      expect(calls.list[0]).toBe(params)
    })

    test.each([
      ['no state filter', { label: ['service=cscb'] }],
      ['no params', undefined],
    ])('%s reaches the client as the caller passed it', async (_case, params) => {
      const { client, seen } = makeClient()
      install(asClient(client))

      await installed().list!(params)

      expect(seen.list).toHaveLength(1)
      expect(seen.list![0]!.args[0]).toBe(params)
    })

    test('the caller\'s params and state array are not mutated, and later arguments pass through', async () => {
      const { client, calls, seen } = makeClient()
      install(asClient(client))
      const state = Object.freeze([CHECK_PERMISSION, WORKING])
      const params = Object.freeze({ state, label: Object.freeze(['service=cscb']) })
      const extra = { signal: 'x' }

      await installed().list!(params, extra)

      expect(params.state).toBe(state)
      expect(state).toEqual([CHECK_PERMISSION, WORKING])
      expect(calls.list[0]).not.toBe(params)
      expect(seen.list![0]!.args[1]).toBe(extra)
      expect(seen.list![0]!.self).toBe(client)
    })
  })

  describe('installation', () => {
    test('getClient() returns the installed object itself', () => {
      const { client } = makeClient()
      install(asClient(client))

      expect(getClient() as unknown).toBe(client)
      expect(getClient().binaryVersion).toBe('0.17.0')
    })

    test('every other verb is the client\'s own function, its answer unchanged', async () => {
      const killed = { kill_sent: true }
      const { client, own, seen } = makeClient({ killResult: killed })
      install(asClient(client))

      for (const verb of ['kill', 'sendKeys', 'getPermission', 'readPane', 'decide']) expect(installed()[verb]).toBe(own[verb]!)
      for (const verb of ['get', 'status', 'list']) expect(installed()[verb]).not.toBe(own[verb]!)
      expect(await installed().kill!({ instance_id: INSTANCE })).toBe(killed)
      expect(seen.kill![0]!.self).toBe(client)
    })

    test('a verb the client lacks stays missing, and the others are still normalised', async () => {
      const { client } = makeClient(answering('get', row('get', IDLE_SCREEN)))
      delete (client as unknown as Partial<Verbs>).list
      delete (client as unknown as Partial<Verbs>).status
      install(asClient(client))

      expect('list' in client).toBe(false)
      expect('status' in client).toBe(false)
      expect(await installed().get!({ instance_id: INSTANCE })).toMatchObject({ state: WORKING })
    })
  })
})

describe('a client installed with setClientForTests', () => {
  test('a get row showing needs_intelligence answers check_permission, every other field kept', async () => {
    const given = row('get', NEEDS_INTELLIGENCE)
    const { client } = makeClient(answering('get', given))
    setClientForTests(asClient(client))

    expect(await installed().get!({ instance_id: INSTANCE })).toEqual({ ...given, state: CHECK_PERMISSION })
  })

  test('a list state filter naming check_permission also asks for needs_intelligence', async () => {
    const { client, calls } = makeClient()
    setClientForTests(asClient(client))

    await installed().list!({ state: [CHECK_PERMISSION], label: ['service=cscb'] })

    expect(calls.list[0]).toEqual({ state: [CHECK_PERMISSION, NEEDS_INTELLIGENCE], label: ['service=cscb'] })
  })
})

describe('reinstalling an installed client', () => {
  test.each([
    ['setClient', 'setClientForTests', setClient, setClientForTests],
    ['setClientForTests', 'setClient', setClientForTests, setClient],
  ] as const)('installed with %s, reinstalled with %s: no verb is wrapped twice', async (_name, _again, install, reinstall) => {
    const { client, calls } = makeClient({ ...answering('get', row('get', NEEDS_INTELLIGENCE)), ...answering('status', row('status', IDLE_SCREEN)) })
    install(asClient(client))
    const first = { get: installed().get, status: installed().status, list: installed().list }

    reinstall(asClient(client))
    install(asClient(client))

    expect(getClient() as unknown).toBe(client)
    expect(installed().get).toBe(first.get!)
    expect(installed().status).toBe(first.status!)
    expect(installed().list).toBe(first.list!)
    expect(await installed().get!({ instance_id: INSTANCE })).toMatchObject({ state: CHECK_PERMISSION })
    expect(await installed().status!({ instance_id: INSTANCE })).toMatchObject({ state: WORKING })
    await installed().list!({ state: [CHECK_PERMISSION] })
    expect(calls.get).toHaveLength(1)
    expect(calls.status).toHaveLength(1)
    expect(calls.list).toHaveLength(1)
    expect(calls.list[0]!.state).toEqual([CHECK_PERMISSION, NEEDS_INTELLIGENCE])
  })
})
