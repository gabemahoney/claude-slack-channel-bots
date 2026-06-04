/**
 * permission-poller-trail-file.test.ts — End-to-end persistence test for the
 * SR-V Epic 2 trail emissions. Drives `runTick` against a real
 * `permission-trail.jsonl` file under a temp `SLACK_STATE_DIR`, reads the
 * file from disk, and verifies the persisted `cscb.poller.row_decision` and
 * `cscb.chat_post.attempted` events survive `JSON.stringify` → `writeSync` →
 * file → `JSON.parse` intact, including SR-V-1.4 `action_id` reversibility
 * from the persisted `blocks` array.
 *
 * SPDX-License-Identifier: MIT
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  _resetPollerState,
  startPermissionPoller,
  stopPermissionPoller,
} from '../src/permission-poller.ts'
import { _resetTrailFdForTests } from '../src/permission-trail.ts'
import { parsePermissionActionId } from '../src/permission-action-id.ts'
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

// ---------------------------------------------------------------------------
// Test isolation: per-test SLACK_STATE_DIR
// ---------------------------------------------------------------------------

let tempDir: string
let origStateDir: string | undefined

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'poller-trail-file-test-'))
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
// Helpers
// ---------------------------------------------------------------------------

interface ManualInterval {
  cb: () => void
  ms: number
}

function makeInterval(): {
  setInterval: typeof globalThis.setInterval
  clearInterval: typeof globalThis.clearInterval
  pending: ManualInterval[]
} {
  const pending: ManualInterval[] = []
  return {
    setInterval: ((cb: () => void, ms: number) => {
      const entry: ManualInterval = { cb, ms }
      pending.push(entry)
      return entry as unknown as ReturnType<typeof setInterval>
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

function makeChatStub(opts: { ts?: string; postMessageError?: Error } = {}): ChatStub {
  return {
    web: {
      chat: {
        async postMessage(_args: unknown): Promise<{ ts?: string }> {
          if (opts.postMessageError) throw opts.postMessageError
          return { ts: opts.ts ?? SLACK_RETURNED_TS }
        },
        async update(_args: unknown): Promise<unknown> {
          return {}
        },
      },
    },
  }
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

const checkPermRow = () =>
  cannedListRow({
    claude_instance_id: INSTANCE_C,
    state: 'check_permission',
    labels: { service: 'cscb', channel: CHANNEL_CH },
  })

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

describe('permission-poller — trail file end-to-end (Epic 2)', () => {
  test('success: row_decision{post_attempted} + chat_post.attempted{ok=true} persisted with matching ts', async () => {
    const ivl = makeInterval()
    const chat = makeChatStub({ ts: SLACK_RETURNED_TS })
    const getClient = () => ({
      list: async () => ({ spawns: [checkPermRow()] }),
      get: async () => cannedGetResultPlural({
        claude_instance_id: INSTANCE_C,
        state: 'check_permission',
        permission_requests: [cannedPermissionRequest({ request_token: TOKEN_A, request_id: 1 })],
      }),
    })
    startPermissionPoller({
      getClient,
      web: chat.web as never,
      intervalMs: 1000,
      setInterval: ivl.setInterval,
      clearInterval: ivl.clearInterval,
    })

    ivl.pending[0]!.cb()
    await new Promise(r => setTimeout(r, 20))

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
    expect(post!['channel']).toBe(CHANNEL_CH)
  })

  test('SR-V-1.4 decode round-trip: persisted blocks yield both Allow and Deny action_ids that decode back to (decision, instance, token)', async () => {
    const ivl = makeInterval()
    const chat = makeChatStub()
    const getClient = () => ({
      list: async () => ({ spawns: [checkPermRow()] }),
      get: async () => cannedGetResultPlural({
        claude_instance_id: INSTANCE_C,
        state: 'check_permission',
        permission_requests: [cannedPermissionRequest({ request_token: TOKEN_A, request_id: 1 })],
      }),
    })
    startPermissionPoller({
      getClient,
      web: chat.web as never,
      intervalMs: 1000,
      setInterval: ivl.setInterval,
      clearInterval: ivl.clearInterval,
    })

    ivl.pending[0]!.cb()
    await new Promise(r => setTimeout(r, 20))

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
  })

  test('closure persists on disk: row_decision{reconciled_closed} + chat_update.attempted{operator_allow} land with the original prompt ts (SRD §10 Q5)', async () => {
    const ivl = makeInterval()
    const chat = makeChatStub({ ts: SLACK_RETURNED_TS })
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

    // Tick 1: post
    ivl.pending[0]!.cb()
    await new Promise(r => setTimeout(r, 20))
    // Tick 2: closure
    listProjection = []
    ivl.pending[0]!.cb()
    await new Promise(r => setTimeout(r, 20))

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
  })

  test('failure: Slack platform error → chat_post.attempted{ok=false,error="channel_not_found"} persisted', async () => {
    const ivl = makeInterval()
    const platformError = Object.assign(new Error('platform error'), {
      name: 'WebAPIPlatformError',
      data: { ok: false, error: 'channel_not_found' },
    })
    const chat = makeChatStub({ postMessageError: platformError })
    const getClient = () => ({
      list: async () => ({ spawns: [checkPermRow()] }),
      get: async () => cannedGetResultPlural({
        claude_instance_id: INSTANCE_C,
        state: 'check_permission',
        permission_requests: [cannedPermissionRequest({ request_token: TOKEN_A, request_id: 1 })],
      }),
    })
    startPermissionPoller({
      getClient,
      web: chat.web as never,
      intervalMs: 1000,
      setInterval: ivl.setInterval,
      clearInterval: ivl.clearInterval,
      log: () => { /* swallow */ },
    })

    ivl.pending[0]!.cb()
    await new Promise(r => setTimeout(r, 20))

    const post = readAllLines().find(
      e => e['event'] === 'cscb.chat_post.attempted' && e['request_token'] === TOKEN_A,
    )
    expect(post).toBeDefined()
    expect(post!['ok']).toBe(false)
    expect(post!['error']).toBe('channel_not_found')
  })
})
