/**
 * trail-query-integration.test.ts — End-to-end test of the SR-V Epic 6
 * operator query path. Drives a full permission-relay interaction
 * sequentially in-process, lets the events emit through to a real
 * permission-trail.jsonl file under a temp SLACK_STATE_DIR, then
 * exercises queryByToken + queryByChannelTimerange and asserts the
 * SRD §10 (CSCB-side) questions 2–5 are answerable from the returned
 * events alone.
 *
 * SPDX-License-Identifier: MIT
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { DecideParams, DecideResult } from 'agent-director'
import {
  _resetPollerState,
  startPermissionPoller,
  stopPermissionPoller,
} from '../src/permission-poller.ts'
import {
  emitBlockActionReceived,
  handlePermissionClick,
} from '../src/permission-click-handler.ts'
import { _resetTrailFdForTests } from '../src/permission-trail.ts'
import { encodePermissionActionId } from '../src/permission-action-id.ts'
import {
  queryByChannelTimerange,
  queryByToken,
} from '../src/trail-query.ts'
import {
  cannedGetPermissionResponse,
  cannedGetResultPlural,
  cannedListRow,
  cannedPermissionRequest,
} from './test-helpers/agent-director-stub.ts'
import type { GetPermissionParams, GetPermissionResult } from '../src/agent-director-client.ts'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const INSTANCE_C = 'cscb_demo_C0B1ZJJLJ9M'
const CHANNEL_CH = 'C0B1ZJJLJ9M'
const TOKEN_A = '6f3a1d2c-aaaa-4bbb-8ccc-dddddddddddd'
const SLACK_RETURNED_TS = '1780600244.439969'
const USER = 'U_OPERATOR'

// ---------------------------------------------------------------------------
// Isolation
// ---------------------------------------------------------------------------

let tempDir: string
let origStateDir: string | undefined

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'trail-query-integration-'))
  origStateDir = process.env['SLACK_STATE_DIR']
  process.env['SLACK_STATE_DIR'] = tempDir
  _resetTrailFdForTests()
})

afterEach(() => {
  stopPermissionPoller()
  _resetPollerState()
  if (origStateDir === undefined) delete process.env['SLACK_STATE_DIR']
  else process.env['SLACK_STATE_DIR'] = origStateDir
  _resetTrailFdForTests()
  rmSync(tempDir, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// Drive a full interaction
// ---------------------------------------------------------------------------

interface ManualInterval { cb: () => void; ms: number }

function makeInterval(): {
  setInterval: typeof globalThis.setInterval
  clearInterval: typeof globalThis.clearInterval
  pending: ManualInterval[]
} {
  const pending: ManualInterval[] = []
  return {
    setInterval: ((cb: () => void, ms: number) => {
      const e: ManualInterval = { cb, ms }
      pending.push(e)
      return e as unknown as ReturnType<typeof setInterval>
    }) as unknown as typeof globalThis.setInterval,
    clearInterval: (() => { /* no-op */ }) as unknown as typeof globalThis.clearInterval,
    pending,
  }
}

interface ChatStub {
  web: {
    chat: {
      postMessage: (a: unknown) => Promise<{ ts?: string }>
      update: (a: unknown) => Promise<unknown>
    }
  }
}

function makeChatStub(ts: string): ChatStub {
  return {
    web: {
      chat: {
        async postMessage(_a: unknown): Promise<{ ts?: string }> { return { ts } },
        async update(_a: unknown): Promise<unknown> { return {} },
      },
    },
  }
}

const checkPermRow = () =>
  cannedListRow({
    claude_instance_id: INSTANCE_C,
    state: 'check_permission',
    labels: { service: 'cscb', channel: CHANNEL_CH },
  })

async function driveFullInteraction(): Promise<void> {
  const ivl = makeInterval()
  const chat = makeChatStub(SLACK_RETURNED_TS)
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
  startPermissionPoller({
    getClient,
    web: chat.web as never,
    intervalMs: 1000,
    setInterval: ivl.setInterval,
    clearInterval: ivl.clearInterval,
  })

  // Tick 1: post the prompt.
  ivl.pending[0]!.cb()
  await new Promise(r => setTimeout(r, 20))

  // Simulate the inbound block_actions + click + decide.
  const actionId = encodePermissionActionId('allow', INSTANCE_C, TOKEN_A)
  emitBlockActionReceived(actionId, {
    channel: CHANNEL_CH,
    messageTs: SLACK_RETURNED_TS,
    user: USER,
  })
  const decide: { client: { decide: (p: DecideParams) => Promise<DecideResult> } } = {
    client: { decide: async (_p: DecideParams) => ({}) },
  }
  await handlePermissionClick(
    actionId,
    { getClient: () => decide.client, web: chat.web as never },
    { channel: CHANNEL_CH, messageTs: SLACK_RETURNED_TS, user: USER },
  )

  // Tick 2: poller reconciles the closure.
  listProjection = []
  ivl.pending[0]!.cb()
  await new Promise(r => setTimeout(r, 20))
}

// ---------------------------------------------------------------------------
// Integration assertions
// ---------------------------------------------------------------------------

describe('SR-V Epic 6 — operator query of a full interaction', () => {
  test('queryByToken returns at least one event for each of the six event classes', async () => {
    await driveFullInteraction()

    const events = queryByToken(TOKEN_A)
    const eventClasses = new Set(events.map(e => e.event))
    expect(eventClasses.has('cscb.poller.row_decision')).toBe(true)
    expect(eventClasses.has('cscb.chat_post.attempted')).toBe(true)
    expect(eventClasses.has('cscb.block_action.received')).toBe(true)
    expect(eventClasses.has('cscb.click_handler.invoked')).toBe(true)
    expect(eventClasses.has('cscb.ad_decide.attempted')).toBe(true)
    expect(eventClasses.has('cscb.chat_update.attempted')).toBe(true)
  })

  test('events are returned in ts-ascending order', async () => {
    await driveFullInteraction()
    const events = queryByToken(TOKEN_A)
    const tses = events.map(e => e.ts)
    const sorted = [...tses].sort()
    expect(tses).toEqual(sorted)
  })

  test('SRD §10 Q2: cscb.chat_post.attempted carries the full blocks array with both action_ids', async () => {
    await driveFullInteraction()
    const events = queryByToken(TOKEN_A)
    const post = events.find(e => e.event === 'cscb.chat_post.attempted')
    expect(post).toBeDefined()
    const blocks = post!['blocks'] as Array<Record<string, unknown>>
    expect(Array.isArray(blocks)).toBe(true)
    const actions = blocks.find(b => b['type'] === 'actions') as { elements: Array<{ action_id: string }> } | undefined
    expect(actions).toBeDefined()
    expect(actions!.elements).toHaveLength(2)
    // Both buttons carry permission action_ids.
    expect(actions!.elements[0]!.action_id.startsWith('perm_allow_')).toBe(true)
    expect(actions!.elements[1]!.action_id.startsWith('perm_deny_')).toBe(true)
  })

  test('SRD §10 Q3: cscb.chat_post.attempted slack_ts equals the Slack-returned ts', async () => {
    await driveFullInteraction()
    const post = queryByToken(TOKEN_A).find(e => e.event === 'cscb.chat_post.attempted')
    expect(post!['slack_ts']).toBe(SLACK_RETURNED_TS)
  })

  test('SRD §10 Q4: cscb.block_action.received message_ts matches the post slack_ts', async () => {
    await driveFullInteraction()
    const events = queryByToken(TOKEN_A)
    const post = events.find(e => e.event === 'cscb.chat_post.attempted')!
    const block = events.find(e => e.event === 'cscb.block_action.received')
    expect(block).toBeDefined()
    expect(block!.message_ts).toBe(post['slack_ts'] as string)
  })

  test('SRD §10 Q5: at least one cscb.chat_update.attempted has message_ts equal to the post slack_ts (closure renders on original ts)', async () => {
    await driveFullInteraction()
    const events = queryByToken(TOKEN_A)
    const post = events.find(e => e.event === 'cscb.chat_post.attempted')!
    const closures = events.filter(e => e.event === 'cscb.chat_update.attempted')
    expect(closures.length).toBeGreaterThan(0)
    expect(closures.some(c => c.message_ts === post['slack_ts'])).toBe(true)
  })

  test('queryByChannelTimerange returns the same events for the channel inside the window', async () => {
    await driveFullInteraction()
    const tokenEvents = queryByToken(TOKEN_A)
    // Wide enough window to capture every emit in this test.
    const since = '2000-01-01T00:00:00.000Z'
    const until = '2099-12-31T23:59:59.999Z'
    const channelEvents = queryByChannelTimerange(CHANNEL_CH, since, until)
    // Every event tied to the channel (i.e. all chat_post / chat_update /
    // block_action / click_handler events) should be present in the channel
    // query — the row_decision and ad_decide events don't carry a `channel`
    // field by design, so they're correctly excluded from this scope.
    const tokenChannelEvents = tokenEvents.filter(e => e.channel === CHANNEL_CH)
    expect(tokenChannelEvents.length).toBeGreaterThan(0)
    for (const e of tokenChannelEvents) {
      const match = channelEvents.find(c => c.ts === e.ts && c.event === e.event)
      expect(match).toBeDefined()
    }
  })
})
