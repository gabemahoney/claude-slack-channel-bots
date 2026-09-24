/**
 * permission-poller-trail-file.test.ts — End-to-end persistence test for the
 * SR-V Epic 2 trail emissions. Drives `runTick` against a real
 * `permission-trail.jsonl` file under a temp `SLACK_STATE_DIR`, reads the
 * file from disk, and verifies the persisted `cscb.poller.row_decision` and
 * `cscb.chat_post.attempted` events survive `JSON.stringify` → `writeSync` →
 * file → `JSON.parse` intact, including SR-V-1.4 `action_id` reversibility
 * from the persisted `blocks` array.
 *
 * Rows carry the persona label, and the poller and click handler reach Slack
 * through the persona's own client (b.av2 SR-7.1). The persisted `channel`
 * field keeps its meaning (b.av2 SR-11): the Slack channel of the prompt
 * message, i.e. the persona's destination channel ID, never its key.
 *
 * SPDX-License-Identifier: MIT
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { Client } from 'agent-director'
import type { Persona } from '../src/config.ts'
import {
  _resetPollerState,
  stopPermissionPoller,
  type PollerDeps,
} from '../src/permission-poller.ts'
import { _resetTrailFdForTests } from '../src/permission-trail.ts'
import { _resetOutageState, initOutageState } from '../src/outage-state.ts'
import {
  encodePermissionActionId,
  parsePermissionActionId,
  personaKeyFromActionId,
} from '../src/permission-action-id.ts'
import {
  emitBlockActionReceived,
  handlePermissionClick,
  type ClickDeps,
} from '../src/permission-click-handler.ts'
import { personaInstanceId, personaKey } from '../src/persona-identity.ts'
import type { DecideParams, DecideResult } from 'agent-director'
import {
  cannedGetPermissionResponse,
  cannedGetResultPlural,
  cannedListRow,
  cannedPermissionRequest,
} from './test-helpers/agent-director-stub.ts'
import { makeMultiPersonaConfig } from './test-helpers/persona-config.ts'
import { makeStubSlack, type StubSlack, type WebApiOutcome } from './test-helpers/slack-stub.ts'
import { LEAK_SENTINEL, assertNoLeak, writtenFile } from './test-helpers/credentials.ts'
import {
  makePersonaClients,
  slackCalls,
  startManualPoller,
  type ManualIntervalControl,
  type PersonaClients,
} from './test-helpers/permission-relay-harness.ts'
import type { GetPermissionParams, GetPermissionResult } from '../src/agent-director-client.ts'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

// The prompting persona: its key differs from its destination channel ID.
const NAME_A = 'Trail Demo'
const KEY_A = personaKey(NAME_A)
const INSTANCE_C = personaInstanceId(KEY_A)
const CHANNEL_CH = 'C0B1ZJJLJ9M'
// A second persona whose client must stay untouched.
const NAME_B = 'Trail Bystander'
const CHANNEL_B = 'C0BYSTAND01'
const TOKEN_A = '6f3a1d2c-aaaa-4bbb-8ccc-dddddddddddd'
const SLACK_RETURNED_TS = '1780600244.439969'

// ---------------------------------------------------------------------------
// Test isolation: per-test SLACK_STATE_DIR
// ---------------------------------------------------------------------------

let tempDir: string
let origStateDir: string | undefined
let A: Persona
let personas: Persona[]
let stubA: StubSlack
let stubB: StubSlack
let clients: PersonaClients

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'poller-trail-file-test-'))
  origStateDir = process.env['SLACK_STATE_DIR']
  process.env['SLACK_STATE_DIR'] = tempDir
  _resetTrailFdForTests()
  // Initialize outage-state so withOutageDetection does not throw during ticks.
  // Tests that need a specific client (e.g. decide) override via initOutageState
  // inside the test body.
  initOutageState({ getClient: () => ({} as unknown as Client), notify: () => {} })
  personas = makeMultiPersonaConfig(
    [
      { name: NAME_A, channels: [{ id: CHANNEL_CH, delivery: 'all' }] },
      { name: NAME_B, channels: [{ id: CHANNEL_B, delivery: 'all' }] },
    ],
    tempDir,
  ).personas
  A = personas[0]!
  // Scripted Slack failures carry the sentinel wherever a real error can hold secrets.
  stubA = makeStubSlack({ leakMarker: LEAK_SENTINEL })
  stubB = makeStubSlack({ leakMarker: LEAK_SENTINEL })
  clients = makePersonaClients((key) => (key === A.key ? stubA : key === personas[1]!.key ? stubB : undefined))
})

afterEach(() => {
  try {
    // The bystander persona's client is never used.
    expect(slackCalls(stubB)).toBe(0)
  } finally {
    stopPermissionPoller()
    _resetPollerState()
    _resetOutageState()
    if (origStateDir === undefined) delete process.env['SLACK_STATE_DIR']
    else process.env['SLACK_STATE_DIR'] = origStateDir
    _resetTrailFdForTests()
    rmSync(tempDir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const getPersona = (key: string): Persona | undefined => personas.find((p) => p.key === key)

/** Click deps for a click received on persona A's connection. */
const clickDeps = (): ClickDeps => ({ receivingPersonaKey: KEY_A, clientFor: clients.clientFor, getPersona })

/**
 * Start the poller with the persona lookups. A's first post has outcome
 * `post` (default: success returning SLACK_RETURNED_TS).
 */
function startPoller(
  getClient: PollerDeps['getClient'],
  opts: Partial<PollerDeps> & { post?: WebApiOutcome } = {},
): ManualIntervalControl {
  const { post, ...rest } = opts
  stubA.script.post.push(post ?? { kind: 'ok', result: { ts: SLACK_RETURNED_TS } })
  return startManualPoller({ getClient, clientFor: clients.clientFor, getPersona, ...rest })
}

function trailFile(): string {
  return join(tempDir, 'permission-trail.jsonl')
}

function readAllLines(): Array<Record<string, unknown>> {
  if (!existsSync(trailFile())) return []
  return readFileSync(trailFile(), 'utf-8')
    .split('\n')
    .filter(l => l.length > 0)
    .map(l => JSON.parse(l) as Record<string, unknown>)
}

/** Persona A's spawn in check_permission, as a spawn of A writes it. */
const checkPermRow = () => cannedListRow({ state: 'check_permission' }, A, tempDir)

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

describe('permission-poller — trail file end-to-end (Epic 2)', () => {
  test('success: row_decision{post_attempted} + chat_post.attempted{ok=true} persisted with matching ts', async () => {
    const getClient = () => ({
      list: async () => ({ spawns: [checkPermRow()] }),
      get: async () => cannedGetResultPlural({
        claude_instance_id: INSTANCE_C,
        state: 'check_permission',
        permission_requests: [cannedPermissionRequest({ request_token: TOKEN_A, request_id: 1 })],
      }),
    })
    initOutageState({ getClient: () => getClient() as unknown as Client, notify: () => {} })
    const ivl = startPoller(getClient)

    await ivl.tick(20)

    const all = readAllLines()
    const matching = all.filter(e => e['request_token'] === TOKEN_A)
    expect(matching.length).toBeGreaterThanOrEqual(2)

    const decision = matching.find(
      e => e['event'] === 'cscb.poller.row_decision' && e['action'] === 'post_attempted',
    )
    expect(decision).toBeDefined()
    expect(decision!['claude_instance_id']).toBe(INSTANCE_C)

    const post = matching.find(e => e['event'] === 'cscb.chat_post.attempted')
    expect(post).toBeDefined()
    expect(post!['ok']).toBe(true)
    expect(post!['slack_ts']).toBe(SLACK_RETURNED_TS)
    // The persisted channel is A's destination channel ID, never its key.
    expect(post!['channel']).toBe(CHANNEL_CH)
    expect(post!['channel']).not.toBe(KEY_A)
    // Posted through A's own client, to its destination.
    expect((stubA.calls.postMessage as Array<{ channel: string }>).map((c) => c.channel)).toEqual([CHANNEL_CH])
  })

  test('SR-V-1.4 decode round-trip: persisted blocks yield both Allow and Deny action_ids that decode back to (decision, instance, token)', async () => {
    const getClient = () => ({
      list: async () => ({ spawns: [checkPermRow()] }),
      get: async () => cannedGetResultPlural({
        claude_instance_id: INSTANCE_C,
        state: 'check_permission',
        permission_requests: [cannedPermissionRequest({ request_token: TOKEN_A, request_id: 1 })],
      }),
    })
    initOutageState({ getClient: () => getClient() as unknown as Client, notify: () => {} })
    const ivl = startPoller(getClient)

    await ivl.tick(20)

    const post = readAllLines().find(
      e => e['event'] === 'cscb.chat_post.attempted' && e['request_token'] === TOKEN_A,
    )
    expect(post).toBeDefined()
    const blocks = post!['blocks'] as Array<Record<string, unknown>>
    const actions = blocks.find(b => b['type'] === 'actions') as
      { elements: Array<{ action_id: string }> } | undefined
    expect(actions).toBeDefined()

    const allowDecoded = parsePermissionActionId(actions!.elements[0]!.action_id)
    const denyDecoded = parsePermissionActionId(actions!.elements[1]!.action_id)
    expect(allowDecoded).toEqual({
      decision: 'allow',
      claudeInstanceId: INSTANCE_C,
      requestToken: TOKEN_A,
    })
    expect(denyDecoded).toEqual({
      decision: 'deny',
      claudeInstanceId: INSTANCE_C,
      requestToken: TOKEN_A,
    })
    // The persisted buttons name persona A's instance, `cscb_<key>`.
    expect(INSTANCE_C).toBe(`cscb_${KEY_A}`)
    for (const el of actions!.elements) expect(personaKeyFromActionId(el.action_id)).toBe(KEY_A)
  })

  test('closure persists on disk: row_decision{reconciled_closed} + chat_update.attempted{operator_allow} land with the original prompt ts (SRD §10 Q5)', async () => {
    let listProjection: ReturnType<typeof cannedPermissionRequest>[] = [
      cannedPermissionRequest({ request_token: TOKEN_A, request_id: 1 }),
    ]
    const getClient = () => ({
      list: async () => ({ spawns: [checkPermRow()] }),
      get: async () => cannedGetResultPlural({
        claude_instance_id: INSTANCE_C,
        state: 'check_permission',
        permission_requests: listProjection,
      }),
      getPermission: async (p: GetPermissionParams): Promise<GetPermissionResult> =>
        cannedGetPermissionResponse({ request_token: p.request_token, decision: 'allow', decision_reason: null }),
    })
    initOutageState({ getClient: () => getClient() as unknown as Client, notify: () => {} })
    const ivl = startPoller(getClient)

    // Tick 1: post
    await ivl.tick(20)
    // Tick 2: closure
    listProjection = []
    await ivl.tick(20)

    const matching = readAllLines().filter(e => e['request_token'] === TOKEN_A)
    const events = matching.map(e => e['event'])
    // Ordered subsequence: post first, then closure.
    expect(events).toEqual([
      'cscb.poller.row_decision',
      'cscb.chat_post.attempted',
      'cscb.poller.row_decision',
      'cscb.chat_update.attempted',
    ])

    const post = matching.find(e => e['event'] === 'cscb.chat_post.attempted')!
    const closureDecision = matching.find(
      e => e['event'] === 'cscb.poller.row_decision' && e['action'] === 'reconciled_closed',
    )
    const closure = matching.find(e => e['event'] === 'cscb.chat_update.attempted')!

    expect(closureDecision).toBeDefined()
    expect(closure['verdict_tag']).toBe('operator_allow')
    expect(closure['triggered_by']).toBe('poller')
    expect(closure['ok']).toBe(true)
    // SRD §10 Q5: closure renders on the same ts the original post returned.
    expect(closure['message_ts']).toBe(post['slack_ts'])
    expect(closure['channel']).toBe(CHANNEL_CH)
    // The closure update went through A's own client, on the recorded channel and ts.
    expect(stubA.calls.update as Array<{ channel: string; ts: string }>).toMatchObject([
      { channel: CHANNEL_CH, ts: SLACK_RETURNED_TS },
    ])
  })

  test.each<[WebApiOutcome, string]>([
    [{ kind: 'platform', error: 'channel_not_found' }, 'channel_not_found'],
    [{ kind: 'network' }, 'network_error'],
  ])('failure: Slack %o → chat_post.attempted{ok=false,error=<class>} persisted; neither the file nor the log leaks', async (outcome, errorClass) => {
    const getClient = () => ({
      list: async () => ({ spawns: [checkPermRow()] }),
      get: async () => cannedGetResultPlural({
        claude_instance_id: INSTANCE_C,
        state: 'check_permission',
        permission_requests: [cannedPermissionRequest({ request_token: TOKEN_A, request_id: 1 })],
      }),
    })
    initOutageState({ getClient: () => getClient() as unknown as Client, notify: () => {} })
    const logCalls: unknown[][] = []
    const ivl = startPoller(getClient, {
      post: outcome,
      log: (...args) => { logCalls.push(args) },
    })

    await ivl.tick(20)

    const post = readAllLines().find(
      e => e['event'] === 'cscb.chat_post.attempted' && e['request_token'] === TOKEN_A,
    )
    expect(post).toBeDefined()
    expect(post!['ok']).toBe(false)
    expect(post!['error']).toBe(errorClass)
    expect(post!['channel']).toBe(CHANNEL_CH)
    expect(logCalls.filter((args) => String(args[0]).includes('chat.postMessage failed'))).toHaveLength(1)
    assertNoLeak({ logCalls, trail: writtenFile(trailFile()) }, 'trail-file post failure')
  })

  test('inbound click persists block_action.received{success} + click_handler.invoked{live_pending=true} on disk', async () => {
    const getClient = () => ({
      list: async () => ({ spawns: [checkPermRow()] }),
      get: async () => cannedGetResultPlural({
        claude_instance_id: INSTANCE_C,
        state: 'check_permission',
        permission_requests: [cannedPermissionRequest({ request_token: TOKEN_A, request_id: 1 })],
      }),
    })
    initOutageState({ getClient: () => getClient() as unknown as Client, notify: () => {} })
    const ivl = startPoller(getClient)

    // Tick 1: seed the live entry
    await ivl.tick(20)

    // Simulate the inbound Slack click: SR-V-2.9 then SR-V-2.6
    const USER = 'U_OPERATOR'
    const actionId = encodePermissionActionId('allow', INSTANCE_C, TOKEN_A)
    emitBlockActionReceived(actionId, {
      channel: CHANNEL_CH,
      messageTs: SLACK_RETURNED_TS,
      user: USER,
    })
    const decideStub: { client: { decide: (p: DecideParams) => Promise<DecideResult> } } = {
      client: { decide: async (_p: DecideParams) => ({}) },
    }
    initOutageState({ getClient: () => decideStub.client as unknown as Client, notify: () => {} })
    await handlePermissionClick(
      actionId,
      clickDeps(),
      { channel: CHANNEL_CH, messageTs: SLACK_RETURNED_TS, user: USER },
    )

    const matching = readAllLines().filter(e => e['request_token'] === TOKEN_A)
    const blockEvt = matching.find(e => e['event'] === 'cscb.block_action.received')
    expect(blockEvt).toBeDefined()
    expect(blockEvt!['raw_action_id']).toBe(actionId)
    expect(blockEvt!['decision']).toBe('allow')
    expect(blockEvt!['user']).toBe(USER)
    expect(blockEvt!['channel']).toBe(CHANNEL_CH)
    expect('parse_failure_reason' in blockEvt!).toBe(false)

    const invoked = matching.find(e => e['event'] === 'cscb.click_handler.invoked')
    expect(invoked).toBeDefined()
    expect(invoked!['live_pending']).toBe(true)
    expect(invoked!['decision']).toBe('allow')
    expect(invoked!['user']).toBe(USER)

    // block_action.received MUST precede click_handler.invoked.
    const idxBlock = matching.indexOf(blockEvt!)
    const idxInvoked = matching.indexOf(invoked!)
    expect(idxBlock).toBeLessThan(idxInvoked)

    // The click's update persisted with the destination channel and went
    // through A's own client.
    const clickUpdate = matching.find(
      e => e['event'] === 'cscb.chat_update.attempted' && e['triggered_by'] === 'click_handler',
    )
    expect(clickUpdate).toBeDefined()
    expect(clickUpdate!['channel']).toBe(CHANNEL_CH)
    expect(clickUpdate!['message_ts']).toBe(SLACK_RETURNED_TS)
    expect(stubA.calls.update as Array<{ channel: string; ts: string }>).toMatchObject([
      { channel: CHANNEL_CH, ts: SLACK_RETURNED_TS },
    ])
  })

  test('ad_decide.attempted{result_class="ok"} persists after click_handler.invoked for the same request_token', async () => {
    const getClient = () => ({
      list: async () => ({ spawns: [checkPermRow()] }),
      get: async () => cannedGetResultPlural({
        claude_instance_id: INSTANCE_C,
        state: 'check_permission',
        permission_requests: [cannedPermissionRequest({ request_token: TOKEN_A, request_id: 1 })],
      }),
    })
    initOutageState({ getClient: () => getClient() as unknown as Client, notify: () => {} })
    const ivl = startPoller(getClient)
    await ivl.tick(20)

    const decideStub: { client: { decide: (p: DecideParams) => Promise<DecideResult> } } = {
      client: { decide: async (_p: DecideParams) => ({}) },
    }
    initOutageState({ getClient: () => decideStub.client as unknown as Client, notify: () => {} })
    await handlePermissionClick(
      encodePermissionActionId('allow', INSTANCE_C, TOKEN_A),
      clickDeps(),
      { channel: CHANNEL_CH, messageTs: SLACK_RETURNED_TS, user: 'U_OPERATOR' },
    )

    const matching = readAllLines().filter(e => e['request_token'] === TOKEN_A)
    const invoked = matching.find(e => e['event'] === 'cscb.click_handler.invoked')
    const decided = matching.find(e => e['event'] === 'cscb.ad_decide.attempted')
    expect(invoked).toBeDefined()
    expect(decided).toBeDefined()
    expect(decided!['result_class']).toBe('ok')
    expect(decided!['decision']).toBe('allow')
    // Ordering on disk: click_handler.invoked precedes ad_decide.attempted.
    expect(matching.indexOf(invoked!)).toBeLessThan(matching.indexOf(decided!))
  })

  test('ad_decide.attempted{result_class="ErrAlreadyDecided"} persists when decide throws', async () => {
    // Inline import to keep the agent-director surface localized.
    const { ErrAlreadyDecided } = await import('agent-director')
    const getClient = () => ({
      list: async () => ({ spawns: [checkPermRow()] }),
      get: async () => cannedGetResultPlural({
        claude_instance_id: INSTANCE_C,
        state: 'check_permission',
        permission_requests: [cannedPermissionRequest({ request_token: TOKEN_A, request_id: 1 })],
      }),
    })
    initOutageState({ getClient: () => getClient() as unknown as Client, notify: () => {} })
    const ivl = startPoller(getClient)
    await ivl.tick(20)

    const decideStub: { client: { decide: (p: DecideParams) => Promise<DecideResult> } } = {
      client: {
        decide: async (_p: DecideParams) => {
          throw new ErrAlreadyDecided('decide', 'ErrAlreadyDecided', 'permission request already decided')
        },
      },
    }
    initOutageState({ getClient: () => decideStub.client as unknown as Client, notify: () => {} })
    await handlePermissionClick(
      encodePermissionActionId('allow', INSTANCE_C, TOKEN_A),
      clickDeps(),
      { channel: CHANNEL_CH, messageTs: SLACK_RETURNED_TS, user: 'U_OPERATOR' },
    )

    const decided = readAllLines().find(
      e => e['event'] === 'cscb.ad_decide.attempted' && e['request_token'] === TOKEN_A,
    )
    expect(decided).toBeDefined()
    expect(decided!['result_class']).toBe('ErrAlreadyDecided')
    expect('raw_error_message' in decided!).toBe(false)
  })

  test('forged foreign action_id persists block_action.received{parse_failure_reason} and no click_handler.invoked', async () => {
    const FORGED_ID = 'forged_foreign_bot_action'
    const USER = 'U_OPERATOR'

    emitBlockActionReceived(FORGED_ID, {
      channel: CHANNEL_CH,
      messageTs: '9999.0',
      user: USER,
    })
    const decideStub: { client: { decide: (p: DecideParams) => Promise<DecideResult> } } = {
      client: { decide: async (_p: DecideParams) => ({}) },
    }
    const handled = await handlePermissionClick(
      FORGED_ID,
      clickDeps(),
      { channel: CHANNEL_CH, messageTs: '9999.0', user: USER },
    )
    expect(handled).toBe(false)

    const all = readAllLines()
    const forgedEvents = all.filter(e => e['raw_action_id'] === FORGED_ID)
    expect(forgedEvents).toHaveLength(1)
    expect(forgedEvents[0]!['event']).toBe('cscb.block_action.received')
    expect(forgedEvents[0]!['parse_failure_reason']).toBe('foreign_action_id')

    const invokedForForged = all.find(
      e => e['event'] === 'cscb.click_handler.invoked' && e['raw_action_id'] === FORGED_ID,
    )
    expect(invokedForForged).toBeUndefined()
  })
})
