/**
 * persona-connection-wiring.test.ts — Each persona's connection feeds its own
 * pipeline and click handler, and the server's Slack seams resolve to the
 * persona's own clients (b.av2 SR-3.1 wiring, SR-3.4, SR-4.1, SR-7.1, SR-7.2).
 *
 * Code under test (never `src/server.ts`, which is only read as text):
 * - `src/persona-event-router.ts` `createPersonaEventRouter`: the handler the
 *   connection manager forwards every `message`, `app_mention` and
 *   `interactive` event to, with the receiving persona's key;
 * - `src/persona-start.ts` `createPersonaClientLookup` (`clientFor`, whose
 *   serving rule is driven through the real manager's statuses),
 *   `createPersonaIdentityLookup` and `createPersonaUpFlushListener`;
 * - `src/message-archive.ts` `createPersonaNameResolverSource` and
 *   `createPersonaArchiveWriter`.
 *
 * Real collaborators: the connection manager (`persona-connections.ts`) over
 * the shared stub factory and a fake clock
 * (`tests/test-helpers/persona-connection-harness.ts`), `persona-routing.ts`
 * built as the server builds it
 * (`tests/test-helpers/persona-routing-managed.ts`), `handlePermissionClick`,
 * the permission poller, the persona notifier and the registry's session
 * server.
 *
 * Carries pinned here:
 * - Task 7: each connection's receiver passes its own persona key, and one
 *   event no longer reaches every persona (the single-socket fan-out is gone);
 * - Task 6: a click arriving on persona B's connection for A's prompt is not
 *   decided (real `handlePermissionClick`, receiving key B);
 * - E2 Task 3: `clientFor` serves on `up`, `lost` and a `reopen` retry, and
 *   nothing on `connecting`, a bring-up retry, `broken` (also after a refused
 *   reopen, where the manager still holds the Web client), `stopped`, an
 *   unknown key or dry run;
 * - E2 Task 3 / README "File attachment fails after a long wait": `reply`
 *   uploads go through the manager's long-lived client, built with the 30 s
 *   options;
 * - Task 2: a persona's held notices are flushed on its transition to `up`,
 *   and only that persona's (the hold-and-flush walk-through is in
 *   tests/persona-bringup.test.ts).
 *
 * The server's own wiring of these seams (`main()` and module scope) is
 * audited in tests/server-startup-wiring.test.ts.
 *
 * Isolation (b.av2 SR-13.2): every path is under a `mkdtempSync` directory
 * removed after each test; `SLACK_STATE_DIR` points into it for the trail;
 * `SLACK_DRY_RUN` is cleared for the tool cases and restored. Tokens are
 * sentinel-bearing fakes; captured log lines are leak-checked. No server is
 * started and nothing reaches Slack.
 *
 * SPDX-License-Identifier: MIT
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Database } from 'bun:sqlite'
import type { Client as AdClient, DecideParams } from 'agent-director'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'

import type { Persona } from '../src/config.ts'
import { credentialsFilesToProtect } from '../src/config.ts'
import { assertSendable } from '../src/lib.ts'
import { createPersonaEventRouter, type PersonaEventRouterDeps } from '../src/persona-event-router.ts'
import { createPersonaUpFlushListener } from '../src/persona-start.ts'
import {
  dryRunPersonaIdentity,
  type PersonaConnectionStatus,
  type PersonaSocketEventName,
  type PersonaSocketEventPayload,
} from '../src/persona-connections.ts'
import { longLivedWebClientOptions } from '../src/persona-slack-clients.ts'
import type { PersonaRouting } from '../src/persona-routing.ts'
import { createPersonaNotifier } from '../src/persona-notifier.ts'
import { encodePermissionActionId } from '../src/permission-action-id.ts'
import { handlePermissionClick } from '../src/permission-click-handler.ts'
import { _resetPollerState, getLivePermission, stopPermissionPoller } from '../src/permission-poller.ts'
import { _resetTrailFdForTests } from '../src/permission-trail.ts'
import { _resetOutageState, initOutageState } from '../src/outage-state.ts'
import {
  ID_ONLY_NAME_RESOLVER,
  createPersonaArchiveWriter,
  createPersonaNameResolverSource,
  openArchiveDatabase,
  type NameResolverWebClient,
} from '../src/message-archive.ts'
import { createSessionServer, registerSession, type SessionToolDeps } from '../src/registry.ts'
import { consumeAck } from '../src/ack-tracker.ts'
import { personaInstanceId, renderPersonaRef } from '../src/persona-identity.ts'
import { makeConnectionHarness, type ConnectionHarness } from './test-helpers/persona-connection-harness.ts'
import type { PersonaSpec } from './test-helpers/persona-config.ts'
import { makeAppMention, makeChannelMessage, type SlackEvent } from './test-helpers/slack-stub.ts'
import {
  makeTrailCapture,
  posts,
  slackCalls,
  startManualPoller,
  updates,
  type TrailCapture,
} from './test-helpers/permission-relay-harness.ts'
import {
  NEVER_FIRE_RESTART_DELAY_S,
  makeRestartDeps,
  makeSessionServer,
  makeTransport,
  resetRoutingState,
  waitFor,
} from './test-helpers/persona-routing-harness.ts'
import { initRestart } from '../src/restart.ts'
import { cannedGetResultPlural, cannedListRow, cannedPermissionRequest } from './test-helpers/agent-director-stub.ts'
import { LEAK_SENTINEL, assertNoLeak } from './test-helpers/credentials.ts'
import { makeManagedRouting } from './test-helpers/persona-routing-managed.ts'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ALPHA = 'Alpha Bot'
const BETA = 'Beta Bot'
/** A's home channel (`all`), A's prompt destination. */
const CA = 'C0WIREA01'
/** B's home channel (`all`), B's prompt destination. */
const CB = 'C0WIREB01'
/** A channel both personas hear (`all` for both). */
const CS = 'C0WIRESH1'
/** A request token (UUIDv4 shape, as the action-ID regex needs). */
const REQUEST_TOKEN = '44444444-4444-4444-8444-444444444444'
const CLICKER = 'U0CLICKER1'
const PROMPT_TS = '1700000000.777777'

const SPECS: PersonaSpec[] = [
  { name: ALPHA, channels: [{ id: CA, delivery: 'all' }, { id: CS, delivery: 'all' }], permission_prompts: CA },
  { name: BETA, channels: [{ id: CB, delivery: 'all' }, { id: CS, delivery: 'all' }], permission_prompts: CB },
]

let dir: string
let consoleLines: string[]
let consoleSpy: ReturnType<typeof spyOn>
let harnesses: ConnectionHarness[]
let savedStateDir: string | undefined
let savedDryRun: string | undefined
let openDbs: Database[]
let openClients: Client[]

beforeAll(() => {
  savedStateDir = process.env['SLACK_STATE_DIR']
})

afterAll(() => {
  if (savedStateDir === undefined) delete process.env['SLACK_STATE_DIR']
  else process.env['SLACK_STATE_DIR'] = savedStateDir
  _resetTrailFdForTests()
})

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'persona-connection-wiring-')))
  // The default permission trail (poller) writes under SLACK_STATE_DIR: keep it in the temp dir.
  process.env['SLACK_STATE_DIR'] = join(dir, 'state')
  _resetTrailFdForTests()
  savedDryRun = process.env['SLACK_DRY_RUN']
  delete process.env['SLACK_DRY_RUN']
  harnesses = []
  openDbs = []
  openClients = []
  resetRoutingState()
  initRestart(makeRestartDeps({ restartDelayS: NEVER_FIRE_RESTART_DELAY_S }))
  consoleLines = []
  consoleSpy = spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    consoleLines.push(args.map(String).join(' '))
  })
})

afterEach(async () => {
  try {
    for (const h of harnesses.splice(0)) {
      await h.manager.stopAll()
      assertNoLeak({ lines: h.lines }, 'manager lines')
    }
    for (const client of openClients.splice(0)) await client.close()
    for (const db of openDbs.splice(0)) db.close()
    stopPermissionPoller()
    _resetPollerState()
    _resetOutageState()
    resetRoutingState()
  } finally {
    consoleSpy.mockRestore()
    if (savedDryRun === undefined) delete process.env['SLACK_DRY_RUN']
    else process.env['SLACK_DRY_RUN'] = savedDryRun
    _resetTrailFdForTests()
    rmSync(dir, { recursive: true, force: true })
  }
})

/** A two-persona harness (A, B) tracked for cleanup. */
function harness(opts: Parameters<typeof makeConnectionHarness>[2] = {}): ConnectionHarness & { A: Persona; B: Persona } {
  const h = makeConnectionHarness(SPECS, dir, opts)
  harnesses.push(h)
  return Object.assign(h, { A: h.p(ALPHA), B: h.p(BETA) })
}

/** Bring A and B up; both must be up. */
async function bringUpBoth(h: ConnectionHarness & { A: Persona; B: Persona }): Promise<void> {
  for (const p of [h.A, h.B]) expect(await h.bringUp(p)).toMatchObject({ state: 'up' })
}

/** One `receive` call the recording intake saw. */
interface IntakeCall {
  event: unknown
  key: unknown
}

/** An intake that records each call (event and the receiver argument as given) and acks. */
function recordingIntake(): Pick<PersonaRouting, 'receive'> & { calls: IntakeCall[] } {
  const calls: IntakeCall[] = []
  return {
    calls,
    receive: async (event, ack, key) => {
      calls.push({ event, key })
      await ack()
    },
  }
}

/** One click-handler call a spy saw. */
interface ClickCall {
  actionId: string
  deps: Parameters<typeof handlePermissionClick>[1]
  context: Parameters<typeof handlePermissionClick>[2]
}

/** A click-handler spy answering `handled(actionId)` (default: not handled). */
function clickSpy(handled: (actionId: string) => boolean | Promise<boolean> = () => false): {
  calls: ClickCall[]
  handleClick: typeof handlePermissionClick
} {
  const calls: ClickCall[] = []
  return {
    calls,
    handleClick: async (actionId, deps, context) => {
      calls.push({ actionId, deps, context })
      return handled(actionId)
    },
  }
}

/** Build the event router over the harness's seams and plug it into the manager. */
function plugRouter(
  h: ConnectionHarness,
  routing: Pick<PersonaRouting, 'receive'>,
  extra: Partial<PersonaEventRouterDeps> = {},
): { logs: string[]; trail: TrailCapture; router: ReturnType<typeof createPersonaEventRouter> } {
  const logs: string[] = []
  const trail = makeTrailCapture()
  const router = createPersonaEventRouter({
    routing,
    clientFor: h.clientFor,
    getPersona: (key) => h.getPersona(key),
    log: (line) => void logs.push(line),
    emitTrail: trail.emit,
    ...extra,
  })
  h.onEvent = router
  return { logs, trail, router }
}

/** A recording ack for a direct router call. */
function recordingAck(): { ack: PersonaSocketEventPayload['ack']; count: () => number } {
  let n = 0
  return { ack: async () => { n++ }, count: () => n }
}

/** An interactive `block_actions` payload with these action IDs. */
function blockActions(actionIds: readonly string[], channel = CA): Record<string, unknown> {
  return {
    type: 'block_actions',
    user: { id: CLICKER },
    channel: { id: channel },
    message: { ts: PROMPT_TS },
    actions: actionIds.map((action_id) => ({ action_id })),
  }
}

// ---------------------------------------------------------------------------
// SR-3.1: `message` and `app_mention` on each connection
// ---------------------------------------------------------------------------

describe('SR-3.1: each connection\'s inbound events reach the intake with its own persona key', () => {
  test.each<[PersonaSocketEventName, (overrides: Record<string, unknown>) => SlackEvent]>([
    ['message', (o) => makeChannelMessage(o)],
    ['app_mention', (o) => makeAppMention(o)],
  ])('a `%s` event on A\'s connection reaches the intake once, with A\'s key alone, and is acked once on A\'s socket; the same on B\'s names only B (Task 7 carry)', async (eventName, build) => {
    const h = harness()
    await bringUpBoth(h)
    const intake = recordingIntake()
    const { logs } = plugRouter(h, intake)

    const onA = build({ channel: CS, text: 'first' })
    await h.stub(h.A).socket.deliver(onA)

    expect(intake.calls).toEqual([{ event: onA, key: h.A.key }])
    expect(h.stub(h.A).socket.acks).toHaveLength(1)
    expect(h.stub(h.B).socket.acks).toHaveLength(0)
    const raw = logs.filter((l) => l.startsWith(`[slack] RAW ${eventName} event`))
    expect(raw).toHaveLength(1)
    expect(raw[0]).toContain(`persona=${h.A.key}:`)

    const onB = build({ channel: CS, text: 'second' })
    await h.stub(h.B).socket.deliver(onB)

    expect(intake.calls.map((c) => c.key)).toEqual([h.A.key, h.B.key])
    expect(intake.calls[1]!.event).toEqual(onB)
    expect(h.stub(h.A).socket.acks).toHaveLength(1)
    expect(h.stub(h.B).socket.acks).toHaveLength(1)
    assertNoLeak({ logs })
  })

  test('the single-socket fan-out is gone: a message in a channel both personas hear (`all`), received on A\'s connection, reaches A\'s session only; the same on B\'s reaches B\'s only (real persona-routing)', async () => {
    const h = harness()
    await bringUpBoth(h)
    const { routing, logs, notifications: sessions } = makeManagedRouting(h, dir)
    plugRouter(h, routing)

    const first = makeChannelMessage({ channel: CS, text: 'for whoever received it' })
    await h.stub(h.A).socket.deliver(first)

    expect(sessions.get(h.A.key)!.map((n) => n.params.meta.message_id)).toEqual([first.ts as string])
    expect(sessions.get(h.B.key)).toEqual([])
    // The user-name lookup ran on the receiving persona's client only.
    expect(h.stub(h.A).calls.usersInfo).toHaveLength(1)
    expect(slackCalls(h.stub(h.B))).toBe(1) // B's own auth.test at bring-up, nothing since
    expect(h.stub(h.A).socket.acks).toHaveLength(1)

    const second = makeChannelMessage({ channel: CS, text: 'again' })
    await h.stub(h.B).socket.deliver(second)

    expect(sessions.get(h.B.key)!.map((n) => n.params.meta.message_id)).toEqual([second.ts as string])
    expect(sessions.get(h.A.key)).toHaveLength(1)
    expect(h.stub(h.B).calls.usersInfo).toHaveLength(1)
    expect(h.stub(h.B).socket.acks).toHaveLength(1)
    assertNoLeak({ logs })
  })

  test('an event with no body is acked once and dropped: nothing is archived or delivered and no Slack call is made', async () => {
    const h = harness()
    await bringUpBoth(h)
    const archived: string[] = []
    const { routing, notifications: sessions } = makeManagedRouting(h, dir, { archive: (key) => void archived.push(key) })
    const { router } = plugRouter(h, routing)
    const before = slackCalls(h.stub(h.A), h.stub(h.B))
    const ack = recordingAck()

    await router(h.A.key, 'message', { ack: ack.ack })

    expect(ack.count()).toBe(1)
    expect(archived).toEqual([])
    expect([...sessions.values()].flat()).toEqual([])
    expect(slackCalls(h.stub(h.A), h.stub(h.B))).toBe(before)
  })

  test('an unknown event name is acked once and ignored: no intake, no click handler, no trail event', async () => {
    const h = harness()
    const intake = recordingIntake()
    const click = clickSpy()
    const { router, logs, trail } = plugRouter(h, intake, { handleClick: click.handleClick })
    const ack = recordingAck()

    await router(h.A.key, 'reaction_added' as PersonaSocketEventName, {
      ack: ack.ack,
      event: makeChannelMessage({ channel: CA }),
      body: blockActions([encodePermissionActionId('allow', personaInstanceId(h.A.key), REQUEST_TOKEN)]),
    })

    expect(ack.count()).toBe(1)
    expect(intake.calls).toEqual([])
    expect(click.calls).toEqual([])
    expect(trail.events).toEqual([])
    expect(logs).toEqual([`[slack] persona=${h.A.key}: ignoring unexpected reaction_added event`])
  })

  test('a throw while handling A\'s event is logged with A\'s key, token-safely, never reaches the manager, and B\'s events are still delivered', async () => {
    const h = harness()
    await bringUpBoth(h)
    const intake = recordingIntake()
    // Throw for A only, with a code and a sentinel-bearing message.
    const throwing: Pick<PersonaRouting, 'receive'> = {
      receive: async (event, ack, key) => {
        if (key === h.A.key) throw Object.assign(new Error(`boom ${LEAK_SENTINEL}`), { code: 'EBOOM' })
        return intake.receive(event, ack, key)
      },
    }
    const { logs } = plugRouter(h, throwing)

    await h.stub(h.A).socket.deliver(makeChannelMessage({ channel: CS }))
    const onB = makeChannelMessage({ channel: CS })
    await h.stub(h.B).socket.deliver(onB)

    const failed = logs.filter((l) => l.includes('event handling failed'))
    expect(failed).toHaveLength(1)
    expect(failed[0]).toStartWith(`[slack] persona=${h.A.key}: message event handling failed: Error code=EBOOM`)
    expect(intake.calls).toEqual([{ event: onB, key: h.B.key }])
    expect(h.stub(h.B).socket.acks).toHaveLength(1)
    // The router caught it: the manager logged no handler failure.
    expect(h.lines.filter((l) => l.includes('event handler failed'))).toEqual([])
    assertNoLeak({ logs, lines: h.lines })
  })

  test('a click handler throw is logged with the persona key and the action\'s place in the payload, token-safely', async () => {
    const h = harness()
    await bringUpBoth(h)
    const { logs } = plugRouter(h, recordingIntake(), {
      handleClick: async () => {
        throw new Error(`click failed ${LEAK_SENTINEL}`)
      },
    })

    await h.stub(h.B).socket.deliverInteractive(blockActions(['foreign_action']))

    const failed = logs.filter((l) => l.includes('handling failed'))
    expect(failed).toHaveLength(1)
    expect(failed[0]).toStartWith(`[slack] persona=${h.B.key}: interactive action 1 of 1 handling failed: Error`)
    expect(h.lines.filter((l) => l.includes('event handler failed'))).toEqual([])
    assertNoLeak({ logs })
  })
})

// ---------------------------------------------------------------------------
// SR-7.1: `interactive` on each connection
// ---------------------------------------------------------------------------

describe('SR-7.1: interactive payloads reach the click handler with the receiving persona\'s key', () => {
  test('a payload on A\'s connection: one block_action.received per action with the envelope, each action to the click handler with A\'s key and the server lookups, and one ack', async () => {
    const h = harness()
    await bringUpBoth(h)
    const click = clickSpy()
    const { trail } = plugRouter(h, recordingIntake(), { handleClick: click.handleClick })
    const permAction = encodePermissionActionId('allow', personaInstanceId(h.A.key), REQUEST_TOKEN)

    await h.stub(h.A).socket.deliverInteractive(blockActions(['foreign_action', permAction]))

    expect(trail.events.map((e) => [e.event, e['raw_action_id'], e['channel'], e['message_ts'], e['user']])).toEqual([
      ['cscb.block_action.received', 'foreign_action', CA, PROMPT_TS, CLICKER],
      ['cscb.block_action.received', permAction, CA, PROMPT_TS, CLICKER],
    ])
    expect(click.calls.map((c) => c.actionId)).toEqual(['foreign_action', permAction])
    for (const call of click.calls) {
      expect(call.deps.receivingPersonaKey).toBe(h.A.key)
      expect(call.deps.clientFor).toBe(h.clientFor)
      expect(call.deps.emitTrail).toBe(trail.emit)
      expect(call.context).toEqual({ channel: CA, messageTs: PROMPT_TS, user: CLICKER })
    }
    expect(h.stub(h.A).socket.acks).toHaveLength(1)
    expect(h.stub(h.B).socket.acks).toHaveLength(0)
  })

  test('the same payload on B\'s connection names B as the receiving persona', async () => {
    const h = harness()
    await bringUpBoth(h)
    const click = clickSpy()
    plugRouter(h, recordingIntake(), { handleClick: click.handleClick })

    await h.stub(h.B).socket.deliverInteractive(blockActions(['foreign_action']))

    expect(click.calls.map((c) => c.deps.receivingPersonaKey)).toEqual([h.B.key])
    expect(h.stub(h.B).socket.acks).toHaveLength(1)
    expect(h.stub(h.A).socket.acks).toHaveLength(0)
  })

  test('the first handled action ends the payload: later actions get no trail event and no handler call, and the payload is acked once', async () => {
    const h = harness()
    await bringUpBoth(h)
    const click = clickSpy(() => true)
    const { trail } = plugRouter(h, recordingIntake(), { handleClick: click.handleClick })

    await h.stub(h.A).socket.deliverInteractive(blockActions(['first_action', 'second_action']))

    expect(click.calls.map((c) => c.actionId)).toEqual(['first_action'])
    expect(trail.events.map((e) => e['raw_action_id'])).toEqual(['first_action'])
    expect(h.stub(h.A).socket.acks).toHaveLength(1)
  })

  test('a payload with no actions is acked once and calls nothing', async () => {
    const h = harness()
    await bringUpBoth(h)
    const click = clickSpy()
    const { trail } = plugRouter(h, recordingIntake(), { handleClick: click.handleClick })

    await h.stub(h.A).socket.deliverInteractive(blockActions([]))

    expect(click.calls).toEqual([])
    expect(trail.events).toEqual([])
    expect(h.stub(h.A).socket.acks).toHaveLength(1)
  })

  test('a throw on action 1 is logged with its place in the payload, token-safely, and action 2 is still handled', async () => {
    const h = harness()
    const click = clickSpy((actionId) => {
      if (actionId === 'first_action') throw Object.assign(new Error(`click failed ${LEAK_SENTINEL}`), { code: 'EBOOM' })
      return true
    })
    const { router, logs, trail } = plugRouter(h, recordingIntake(), { handleClick: click.handleClick })

    await router(h.A.key, 'interactive', { ack: recordingAck().ack, body: blockActions(['first_action', 'second_action']) })

    expect(click.calls.map((c) => [c.actionId, c.deps.receivingPersonaKey])).toEqual([
      ['first_action', h.A.key],
      ['second_action', h.A.key],
    ])
    expect(trail.events.map((e) => e['raw_action_id'])).toEqual(['first_action', 'second_action'])
    const failed = logs.filter((l) => l.includes('handling failed'))
    expect(failed).toHaveLength(1)
    expect(failed[0]).toStartWith(`[slack] persona=${h.A.key}: interactive action 1 of 2 handling failed: Error code=EBOOM`)
    assertNoLeak({ logs })
  })

  test.each<[string, (actionId: string) => boolean]>([
    ['action 2 is handled', (id) => id === 'second_action'],
    ['every action throws', () => { throw new Error('click failed') }],
    ['no action is handled', () => false],
  ])('the payload is acked exactly once, after its handling, when %s', async (_label, outcome) => {
    const h = harness()
    const order: string[] = []
    const click = clickSpy((actionId) => {
      order.push(actionId)
      return outcome(actionId)
    })
    const { router } = plugRouter(h, recordingIntake(), { handleClick: click.handleClick })

    await router(h.A.key, 'interactive', {
      ack: async () => void order.push('ack'),
      body: blockActions(['first_action', 'second_action']),
    })

    expect(order).toEqual(['first_action', 'second_action', 'ack'])
  })
})

// ---------------------------------------------------------------------------
// Task 6 carry: the fail-closed click, end to end
// ---------------------------------------------------------------------------

describe('Task 6 carry: a click is decided only through the persona whose connection received it (real handlePermissionClick)', () => {
  /**
   * Bring A and B up, seed a live prompt for A through a poller tick (posted
   * on A's long-lived client via `clientFor`), and install an agent-director
   * fake whose `decide` calls are recorded.
   */
  async function seedPromptForA() {
    const h = harness()
    await bringUpBoth(h)
    const decideCalls: DecideParams[] = []
    const request = cannedPermissionRequest({ request_token: REQUEST_TOKEN })
    const ad = {
      list: async () => ({ spawns: [cannedListRow({ state: 'check_permission' }, h.A, dir)] }),
      get: async () => cannedGetResultPlural({ state: 'check_permission', permission_requests: [request] }, h.A, dir),
      decide: async (params: DecideParams) => {
        decideCalls.push(params)
        return {}
      },
    }
    initOutageState({ getClient: () => ad as unknown as AdClient, notify: () => {} })
    const poller = startManualPoller({
      getClient: (() => ad) as never,
      clientFor: h.clientFor,
      getPersona: (key) => h.getPersona(key),
    })
    await poller.tick()
    const prompt = posts(h.stub(h.A))
    expect(prompt.map((c) => c.channel)).toEqual([CA])
    const instanceA = personaInstanceId(h.A.key)
    const live = getLivePermission(instanceA, REQUEST_TOKEN)
    expect(live).toBeDefined()
    const { trail } = plugRouter(h, recordingIntake())
    return { h, decideCalls, instanceA, live: live!, trail }
  }

  test('a click on B\'s connection for A\'s prompt (action naming cscb_<A>) is logged and not decided; no message is updated and A\'s prompt stays live', async () => {
    const { h, decideCalls, instanceA, trail } = await seedPromptForA()
    const actionId = encodePermissionActionId('allow', instanceA, REQUEST_TOKEN)
    const updatesBefore = [updates(h.stub(h.A)).length, updates(h.stub(h.B)).length]

    await h.stub(h.B).socket.deliverInteractive(blockActions([actionId]))

    expect(decideCalls).toEqual([])
    const refused = consoleLines.filter((l) => l.includes('not deciding'))
    expect(refused).toHaveLength(1)
    expect(refused[0]).toContain(`click for ${instanceA} received for ${renderPersonaRef(h.B.name, h.B.key)}`)
    expect([updates(h.stub(h.A)).length, updates(h.stub(h.B)).length]).toEqual(updatesBefore)
    expect(getLivePermission(instanceA, REQUEST_TOKEN)).toBeDefined()
    expect(trail.events.filter((e) => e.event === 'cscb.ad_decide.attempted')).toEqual([])
    expect(h.stub(h.B).socket.acks).toHaveLength(1)
    assertNoLeak({ consoleLines })
  })

  test('control: the same click on A\'s connection is decided once and its verdict update goes through A\'s client only', async () => {
    const { h, decideCalls, instanceA, live } = await seedPromptForA()
    const actionId = encodePermissionActionId('allow', instanceA, REQUEST_TOKEN)
    const bCallsBefore = slackCalls(h.stub(h.B))

    await h.stub(h.A).socket.deliverInteractive(blockActions([actionId]))

    expect(decideCalls).toEqual([{ claude_instance_id: instanceA, decision: 'allow', request_token: REQUEST_TOKEN } as DecideParams])
    expect(updates(h.stub(h.A)).map((c) => ({ channel: c.channel, ts: c.ts, text: c.text }))).toEqual([
      { channel: live.channelId, ts: live.messageTs, text: '*Permission* — Allowed' },
    ])
    expect(slackCalls(h.stub(h.B))).toBe(bCallsBefore)
    expect(h.stub(h.A).socket.acks).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// E2 carry: `clientFor` and the identity getter by connection status
// ---------------------------------------------------------------------------

describe('E2 carry: clientFor serves A\'s long-lived client only while A is serving', () => {
  test('up: clientFor(A) is the one long-lived Web client the manager built for A (not the validation client), distinct from B\'s', async () => {
    const h = harness()
    await bringUpBoth(h)

    const a = h.clientFor(h.A.key)
    expect(a).toBeDefined()
    expect(a).toBe(h.manager.webClient(h.A.key)!)
    expect(h.slack.buildsOf(h.A.key, 'web')).toHaveLength(1)
    expect(h.slack.buildsOf(h.A.key, 'web')[0]!.hasToken(h.tokens(h.A).botToken)).toBe(true)
    expect(h.clientFor(h.B.key)).toBe(h.manager.webClient(h.B.key)!)
    expect(h.clientFor(h.B.key)).not.toBe(a)
  })

  test('lost, then retrying a reopen: clientFor(A) keeps serving the same client (the Web API does not need the socket); B is unaffected', async () => {
    const h = harness()
    await bringUpBoth(h)
    const a = h.manager.webClient(h.A.key)!

    h.stub(h.A).script.connect.push({ kind: 'never' }, { kind: 'network' })
    h.stub(h.A).socket.drop()
    expect(h.manager.status(h.A.key)).toEqual({ state: 'lost' })
    expect(h.clientFor(h.A.key)).toBe(a)
    expect(h.identityFor(h.A.key)).toEqual({ botUserId: h.stub(h.A).identity.botUserId, botId: h.stub(h.A).identity.botId })

    // The hung reopen is abandoned 10 s in; the retry at +5 s fails (network).
    await h.clock.advance(10_000)
    await h.clock.advance(5_000)
    expect(h.manager.status(h.A.key)).toMatchObject({ state: 'retrying', phase: 'reopen' })
    expect(h.clientFor(h.A.key)).toBe(a)
    expect(h.identityFor(h.A.key)?.botUserId).toBe(h.stub(h.A).identity.botUserId)
    expect(h.clientFor(h.B.key)).toBe(h.manager.webClient(h.B.key)!)
  })

  test('broken after a refused reopen: the manager still holds A\'s Web client, but clientFor(A) and the identity getter answer nothing', async () => {
    const h = harness()
    await bringUpBoth(h)
    h.stub(h.A).script.connect.push({ kind: 'platform', error: 'invalid_auth' })

    h.stub(h.A).socket.drop()
    await h.clock.flush()

    expect(h.manager.status(h.A.key)).toMatchObject({ state: 'broken', phase: 'reopen' })
    expect(h.manager.webClient(h.A.key)).toBeDefined()
    expect(h.manager.identity(h.A.key)).toBeDefined()
    expect(h.clientFor(h.A.key)).toBeUndefined()
    expect(h.identityFor(h.A.key)).toBeUndefined()
    expect(h.clientFor(h.B.key)).toBeDefined()
  })

  test.each<[string, Parameters<typeof makeConnectionHarness>[2], string]>([
    ['broken at bring-up (auth.test refused)', { stubOptions: { [ALPHA]: { authTest: [{ kind: 'platform', error: 'invalid_auth' }] } } }, 'broken'],
    ['retrying its bring-up (auth.test unreachable)', { stubOptions: { [ALPHA]: { authTest: [{ kind: 'network' }] } } }, 'retrying'],
    ['retrying its bring-up (socket start unreachable after a valid auth.test)', { stubOptions: { [ALPHA]: { connect: [{ kind: 'network' }] } } }, 'retrying'],
  ])('%s: clientFor(A) and the identity getter answer nothing', async (_label, opts, state) => {
    const h = harness(opts)
    expect(await h.bringUp(h.A)).toMatchObject({ state })
    expect(await h.bringUp(h.B)).toMatchObject({ state: 'up' })

    expect(h.clientFor(h.A.key)).toBeUndefined()
    expect(h.identityFor(h.A.key)).toBeUndefined()
    expect(h.clientFor(h.B.key)).toBeDefined()
  })

  test('a bring-up retry that succeeds makes clientFor(A) serve', async () => {
    const h = harness({ stubOptions: { [ALPHA]: { authTest: [{ kind: 'network' }] } } })
    expect(await h.bringUp(h.A)).toMatchObject({ state: 'retrying', phase: 'bring-up', retryInMs: 5_000 })
    expect(h.clientFor(h.A.key)).toBeUndefined()

    await h.clock.advance(5_000)

    expect(h.manager.status(h.A.key)).toMatchObject({ state: 'up' })
    expect(h.clientFor(h.A.key)).toBe(h.manager.webClient(h.A.key)!)
  })

  test('connecting: clientFor(A) answers nothing while the first attempt is in flight', async () => {
    const h = harness({ stubOptions: { [ALPHA]: { authTest: [{ kind: 'never' }] } } })
    const pending = h.bringUp(h.A)
    await h.clock.flush()

    expect(h.manager.status(h.A.key)).toEqual({ state: 'connecting' })
    expect(h.clientFor(h.A.key)).toBeUndefined()
    expect(h.identityFor(h.A.key)).toBeUndefined()

    await h.manager.stop(h.A.key)
    await pending
  })

  test('stopped, an unknown key, and a managed persona no longer in the applied config: nothing', async () => {
    const h = harness()
    await bringUpBoth(h)

    expect(h.clientFor('no_such_persona')).toBeUndefined()
    expect(h.identityFor('no_such_persona')).toBeUndefined()

    h.config = { ...h.config!, personas: [h.B] }
    expect(h.manager.webClient(h.A.key)).toBeDefined()
    expect(h.clientFor(h.A.key)).toBeUndefined()
    expect(h.identityFor(h.A.key)).toBeUndefined()
    expect(h.clientFor(h.B.key)).toBeDefined()

    h.config = { ...h.config, personas: [h.A, h.B] }
    await h.manager.stop(h.A.key)
    expect(h.statuses.filter(([key]) => key === h.A.key).at(-1)?.[1]).toEqual({ state: 'stopped' })
    expect(h.clientFor(h.A.key)).toBeUndefined()
    expect(h.identityFor(h.A.key)).toBeUndefined()
  })

  test('the identity getter returns A\'s and B\'s own, distinct identities (bot user ID and bot ID)', async () => {
    const h = harness()
    await bringUpBoth(h)

    const a = h.identityFor(h.A.key)
    const b = h.identityFor(h.B.key)
    expect(a).toEqual({ botUserId: h.stub(h.A).identity.botUserId, botId: h.stub(h.A).identity.botId })
    expect(b).toEqual({ botUserId: h.stub(h.B).identity.botUserId, botId: h.stub(h.B).identity.botId })
    expect(a!.botUserId).not.toBe(b!.botUserId)
    expect(a!.botId).not.toBe(b!.botId)
  })

  test('dry run: every persona is up with no Web client, so clientFor answers nothing; the identity getter gives each persona its placeholder', async () => {
    const h = harness({ dryRun: true })
    await bringUpBoth(h)

    for (const p of [h.A, h.B]) {
      expect(h.manager.status(p.key)).toMatchObject({ state: 'up' })
      expect(h.clientFor(p.key)).toBeUndefined()
      expect(h.identityFor(p.key)).toEqual(dryRunPersonaIdentity(p.key))
    }
    expect(h.identityFor(h.A.key)).toEqual({ botUserId: `U000DRY_${h.A.key}`, botId: `B000DRY_${h.A.key}` })
    expect(h.identityFor(h.A.key)).not.toEqual(h.identityFor(h.B.key))
    expect(h.identityFor('no_such_persona')).toBeUndefined()
    expect(h.slack.builds).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// E2 carry: `reply` uploads on the long-lived client (README 30 s note)
// ---------------------------------------------------------------------------

describe('E2 carry: reply file uploads go through the manager\'s long-lived client (README "File attachment fails after a long wait")', () => {
  test('each persona\'s long-lived Web client is built once with longLivedWebClientOptions(): a 30 s per-attempt timeout and the library\'s default retries', async () => {
    const h = harness()
    await bringUpBoth(h)

    for (const p of [h.A, h.B]) {
      const builds = h.slack.buildsOf(p.key, 'web')
      expect(builds).toHaveLength(1)
      expect(builds[0]!.options).toEqual(longLivedWebClientOptions())
      // The README note depends on these exact values.
      expect(builds[0]!.options).toEqual({ timeout: 30_000, attachOriginalToWebAPIRequestError: false })
      expect(builds[0]!.options).not.toHaveProperty('retryConfig')
      expect(builds[0]!.options).not.toHaveProperty('rejectRateLimitedCalls')
    }
  })

  test('a reply with a file, through clientFor, uploads on A\'s long-lived client and on no other client', async () => {
    const h = harness()
    await bringUpBoth(h)
    const stateDir = join(dir, 'state')
    const inboxDir = join(stateDir, 'inbox')
    mkdirSync(inboxDir, { recursive: true })
    const file = join(inboxDir, 'report.txt')
    writeFileSync(file, 'report')
    const webA = h.manager.webClient(h.A.key)!
    const uploadSpy = spyOn(webA, 'filesUploadV2')
    const postSpy = spyOn(webA.chat, 'postMessage')

    const deps: SessionToolDeps = {
      assertSendable: (p) => assertSendable(p, stateDir, inboxDir, credentialsFilesToProtect(h.config!.personas, join(stateDir, 'config.json'))),
      getAccess: () => ({ dmPolicy: 'pairing' as const, allowFrom: [], channels: {}, pending: {} }),
      getPersona: (key) => h.getPersona(key),
      clientFor: h.clientFor,
      inboxDir,
      resolveUserName: async (_key, userId) => userId,
      consumeAck,
      serverPort: 0,
    }
    const entry = registerSession(h.A.working_directory, h.A.key, makeTransport(`mcp-${h.A.key}`), makeSessionServer([]))
    const server = createSessionServer(entry, deps)
    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair()
    await server.connect(serverTransport)
    const client = new Client({ name: 'wiring-test', version: '1.0.0' }, { capabilities: {} })
    await client.connect(clientTransport)
    openClients.push(client)
    const bBefore = slackCalls(h.stub(h.B))

    const result = (await client.callTool({ name: 'reply', arguments: { chat_id: CA, text: 'attached', files: [file] } })) as {
      isError?: boolean
      content: Array<{ text: string }>
    }

    expect(result.isError).toBeUndefined()
    expect(postSpy).toHaveBeenCalledTimes(1)
    expect(uploadSpy).toHaveBeenCalledTimes(1)
    expect(uploadSpy.mock.calls[0]![0]).toEqual({ channel_id: CA, file } as never)
    expect(h.stub(h.A).calls.filesUploadV2).toHaveLength(1)
    expect(slackCalls(h.stub(h.B))).toBe(bBefore)
    assertNoLeak({ result, consoleLines })
  })
})

// ---------------------------------------------------------------------------
// SR-7.2: held notices flushed on each transition to up
// ---------------------------------------------------------------------------

describe('SR-7.2: the up listener flushes exactly the persona that came up', () => {
  test('the listener flushes the key on `up` only, never on any other status', () => {
    const flushed: string[] = []
    const listener = createPersonaUpFlushListener({ flush: async (key) => void flushed.push(key) })
    const others: PersonaConnectionStatus[] = [
      { state: 'connecting' },
      { state: 'lost' },
      { state: 'stopped' },
      { state: 'retrying', phase: 'reopen', outcome: { kind: 'slack-unreachable' } as never, retryInMs: 5_000, nextAttemptAt: 5_000 },
      { state: 'broken', phase: 'bring-up', outcome: { kind: 'credentials-refused' } as never },
    ]
    for (const status of others) expect(listener('key_a', status)).toBeUndefined()
    expect(flushed).toEqual([])

    listener('key_b', { state: 'up', identity: { botUserId: 'U0B', botId: 'B0B' } })
    listener('key_b', { state: 'up', identity: { botUserId: 'U0B', botId: 'B0B' } })
    expect(flushed).toEqual(['key_b', 'key_b'])
  })

  /** A real notifier over the harness's clientFor, with the up listener installed. */
  function notifierHarness(opts: Parameters<typeof makeConnectionHarness>[2] = {}) {
    const h = harness(opts)
    const logs: string[] = []
    const notifier = createPersonaNotifier({
      getPersona: (key) => h.getPersona(key),
      clientFor: h.clientFor,
      isDryRun: () => false,
      log: (line) => void logs.push(line),
    })
    h.onStatus = createPersonaUpFlushListener(notifier)
    return { h, notifier, logs }
  }

  test('a persona broken at bring-up keeps its notice held; nothing posts on any client', async () => {
    const { h, notifier } = notifierHarness({ stubOptions: { [ALPHA]: { authTest: [{ kind: 'platform', error: 'invalid_auth' }] } } })
    await notifier.notify(h.A.key, 'never posted')
    expect(await h.bringUp(h.A)).toMatchObject({ state: 'broken' })
    await h.bringUp(h.B)
    await h.clock.flush()

    expect(posts(h.stub(h.A))).toEqual([])
    expect(posts(h.stub(h.B))).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// SR-4.1: the archive name lookups use the receiving persona's client
// ---------------------------------------------------------------------------

describe('SR-4.1: archive rows are written with the receiving persona\'s name resolver', () => {
  interface ArchiveRowView {
    channel_id: string
    channel_name: string
    sender_id: string
    sender_name: string
  }

  function archiveHarness(opts: Parameters<typeof makeConnectionHarness>[2] = {}) {
    const h = harness(opts)
    const db = openArchiveDatabase(join(dir, 'archive', 'messages.db'))
    openDbs.push(db)
    const errors: unknown[] = []
    const write = createPersonaArchiveWriter(db, createPersonaNameResolverSource(h.clientFor), (err) => void errors.push(err))
    const { routing } = makeManagedRouting(h, dir, { archive: write })
    const { router } = plugRouter(h, routing)
    const rows = () => db.query('SELECT channel_id, channel_name, sender_id, sender_name FROM messages ORDER BY timestamp').all() as ArchiveRowView[]
    return { h, db, errors, router, rows }
  }

  test('a message received on A\'s connection is archived with names looked up on A\'s client (B\'s makes no call); the same message received on B\'s is looked up on B\'s client and stored once', async () => {
    const { h, rows, errors } = archiveHarness()
    await bringUpBoth(h)
    const bBefore = slackCalls(h.stub(h.B))
    const event = makeChannelMessage({ channel: CS })
    const row = { channel_id: CS, channel_name: `stub-${CS.toLowerCase()}`, sender_id: event.user as string, sender_name: 'stub-user' }

    await h.stub(h.A).socket.deliver(event)
    await waitFor(() => rows().length > 0)

    expect(rows()).toEqual([row])
    expect(h.stub(h.A).calls.conversationsInfo).toEqual([{ channel: CS }])
    expect(h.stub(h.A).calls.usersInfo.length).toBeGreaterThanOrEqual(1)
    expect(slackCalls(h.stub(h.B))).toBe(bBefore)

    await h.stub(h.B).socket.deliver(event)
    await waitFor(() => h.stub(h.B).calls.conversationsInfo.length > 0)

    expect(h.stub(h.B).calls.conversationsInfo).toEqual([{ channel: CS }])
    expect(h.stub(h.A).calls.conversationsInfo).toHaveLength(1)
    expect(rows()).toEqual([row])
    expect(errors).toEqual([])
  })

  test('each persona\'s resolver is built at most once: two messages in one channel on A\'s connection look the channel up once on A\'s client (its cache survives), and A\'s and B\'s resolvers differ', async () => {
    const { h, rows } = archiveHarness()
    await bringUpBoth(h)
    // Only the archive looks channels up (`conversations.info`); the pipeline's user lookup
    // would muddy a `users.info` count.
    const archiveLookups = () => h.stub(h.A).calls.conversationsInfo.length

    await h.stub(h.A).socket.deliver(makeChannelMessage({ channel: CA, ts: '1700000001.000001' }))
    await waitFor(() => rows().length === 1)
    await h.stub(h.A).socket.deliver(makeChannelMessage({ channel: CA, ts: '1700000001.000002' }))
    await waitFor(() => rows().length === 2)

    expect(rows()).toHaveLength(2)
    expect(archiveLookups()).toBe(1)

    const source = createPersonaNameResolverSource(h.clientFor)
    expect(source.resolverFor(h.A.key)).toBe(source.resolverFor(h.A.key))
    expect(source.resolverFor(h.A.key)).not.toBe(source.resolverFor(h.B.key))
  })

  test.each<[string, boolean]>([
    ['not up (never brought up)', false],
    ['in dry run', true],
  ])('with no client for the receiving persona (%s) the row is still written, with IDs for names, and no Slack call is made on any client', async (_label, dryRun) => {
    const { h, router, rows, errors } = archiveHarness({ dryRun })
    if (dryRun) await bringUpBoth(h)
    const event = makeChannelMessage({ channel: CA })

    await router(h.A.key, 'message', { event, ack: recordingAck().ack })
    await waitFor(() => rows().length > 0)

    expect(rows()).toEqual([
      { channel_id: CA, channel_name: CA, sender_id: event.user as string, sender_name: event.user as string },
    ])
    if (!dryRun) expect(slackCalls(h.stub(h.A), h.stub(h.B))).toBe(0)
    else expect(h.slack.builds).toEqual([])
    expect(errors).toEqual([])
  })

  test('a persona with no client gets the ID-only resolver, which is not kept: once its client appears the real one is built', async () => {
    const h = harness()
    const source = createPersonaNameResolverSource(h.clientFor)
    expect(source.resolverFor(h.A.key)).toBe(ID_ONLY_NAME_RESOLVER)

    await h.bringUp(h.A)

    const resolver = source.resolverFor(h.A.key)
    expect(resolver).not.toBe(ID_ONLY_NAME_RESOLVER)
    expect(await resolver.resolveChannelName(CA)).toBe(`stub-${CA.toLowerCase()}`)
    expect(h.stub(h.A).calls.conversationsInfo).toEqual([{ channel: CA }])
  })

  test('a failing resolver source reaches onError and never throws into delivery', () => {
    const db = openArchiveDatabase(join(dir, 'archive', 'failing.db'))
    openDbs.push(db)
    const errors: unknown[] = []
    const write = createPersonaArchiveWriter(db, {
      resolverFor: () => {
        throw new Error(`resolver failed ${LEAK_SENTINEL}`)
      },
    }, (err) => void errors.push(err))

    expect(() => write('key_a', makeChannelMessage({ channel: CA }))).not.toThrow()
    expect(errors).toHaveLength(1)
  })

  test('the resolver source asks clientFor on every call and hands the resolver only that persona\'s client', async () => {
    const asked: string[] = []
    const clients: Record<string, NameResolverWebClient> = {}
    const h = harness()
    await bringUpBoth(h)
    for (const p of [h.A, h.B]) clients[p.key] = h.clientFor(p.key) as unknown as NameResolverWebClient
    const source = createPersonaNameResolverSource((key) => {
      asked.push(key)
      return clients[key]
    })

    await source.resolverFor(h.B.key).resolveUserName('U0SOMEONE')
    source.resolverFor(h.B.key)

    expect(asked).toEqual([h.B.key, h.B.key])
    expect(h.stub(h.B).calls.usersInfo).toEqual([{ user: 'U0SOMEONE' }])
    expect(h.stub(h.A).calls.usersInfo).toEqual([])
  })
})
