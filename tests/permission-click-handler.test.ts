/**
 * permission-click-handler.test.ts — SR-2.2 / SR-4 click → decide path under
 * the request_token / plural-projection wire (Epic 2 rewrite).
 *
 * Contract pins:
 *   - decide() is the ONLY AD call. No pre-decide get(); no `tokenStillOpen`
 *     branch. Every click code path calls decide(request_token) exactly once
 *     (SR-4.1, SR-4.3).
 *   - Composite-key routing: live entry lookup is keyed on
 *     (claude_instance_id, request_token) (SR-4.2).
 *   - Stale click (no live entry): decide still fires; NO chat.update from
 *     the click handler. The next poller tick reconciles the rendering
 *     (SR-4.2).
 *   - Happy path: decide → chat.update verdict text → markHandled
 *     ONLY after the chat.update lands (SR-5.4).
 *   - Happy path with chat.update throwing → markHandled NOT called.
 *   - ErrAlreadyDecided → silent swallow. No chat.update, no markHandled
 *     mutation (SR-4.4).
 *   - ErrInvalidFlags / ErrAmbiguousRequest → log + no retry + no
 *     chat.update (SR-4.4).
 *   - Unknown decide error → log + no chat.update (SR-4.4).
 *   - Sibling independence: clicking one of two siblings on the same spawn
 *     leaves the sibling's entry / messageTs untouched (SR-4.5).
 *   - Malformed action_id returns false (caller keeps looking).
 *
 * SPDX-License-Identifier: MIT
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { ErrSystemInstallDisappeared, type Client, type DecideParams, type DecideResult } from 'agent-director'
import { handlePermissionClick } from '../src/permission-click-handler.ts'
import { encodePermissionActionId } from '../src/permission-action-id.ts'
import {
  _resetPollerState,
  getLivePermission,
  startPermissionPoller,
  stopPermissionPoller,
} from '../src/permission-poller.ts'
import { _resetTrailFdForTests, type TrailEventBase } from '../src/permission-trail.ts'
import {
  cannedGetResultPlural,
  cannedListRow,
  cannedPermissionRequest,
  errAlreadyDecided,
  errAmbiguousRequest,
  errInvalidFlags,
} from './test-helpers/agent-director-stub.ts'
import {
  _resetOutageState,
  getOutageFlags,
  initOutageState,
} from '../src/outage-state.ts'

// ---------------------------------------------------------------------------
// SLACK_STATE_DIR isolation — default emitTrail in the click handler would
// otherwise land on the operator's real ~/.claude/channels/slack/.
// ---------------------------------------------------------------------------

let trailTempDir: string
let origStateDir: string | undefined

beforeAll(() => {
  trailTempDir = mkdtempSync(join(tmpdir(), 'click-trail-isolation-'))
  origStateDir = process.env['SLACK_STATE_DIR']
  process.env['SLACK_STATE_DIR'] = trailTempDir
})

afterAll(() => {
  if (origStateDir === undefined) delete process.env['SLACK_STATE_DIR']
  else process.env['SLACK_STATE_DIR'] = origStateDir
  _resetTrailFdForTests()
  rmSync(trailTempDir, { recursive: true, force: true })
})

beforeEach(() => {
  _resetTrailFdForTests()
  // Initialize outage-state so withOutageDetection (used in the poller) does
  // not throw during seedLiveEntry ticks. Per-test calls to initOutageState
  // below override this with the decide-stub for click-handler assertions.
  initOutageState({ getClient: () => ({} as unknown as Client), postToChannel: () => {} })
})

// ---------------------------------------------------------------------------
// Trail event capture (Epic 3 closure tests)
// ---------------------------------------------------------------------------

type CapturedTrailEvent = Omit<TrailEventBase, 'ts'> & { [extra: string]: unknown }

function makeTrailCapture(): {
  emit: (partial: CapturedTrailEvent) => void
  events: CapturedTrailEvent[]
} {
  const events: CapturedTrailEvent[] = []
  return { events, emit: (p) => { events.push(p) } }
}

// ---------------------------------------------------------------------------
// Shared fixtures — no inline magic strings (SR-8.1)
// ---------------------------------------------------------------------------

const INSTANCE_C = 'cscb_C'
const CHANNEL_CH = 'CH'
const TOKEN_A = '11111111-1111-4111-8111-111111111111'
const TOKEN_B = '22222222-2222-4222-8222-222222222222'
const TOKEN_C = '33333333-3333-4333-8333-333333333333'

interface ChatCall { kind: 'postMessage' | 'update'; channel: string; ts?: string; text?: string }

function makeChatStub(opts?: { updateError?: Error }): {
  web: { chat: { postMessage: (args: unknown) => Promise<{ ts: string }>; update: (args: unknown) => Promise<unknown> } }
  calls: ChatCall[]
} {
  const calls: ChatCall[] = []
  let postCounter = 0
  return {
    web: {
      chat: {
        async postMessage(args: unknown): Promise<{ ts: string }> {
          const a = args as { channel: string; text: string }
          postCounter++
          calls.push({ kind: 'postMessage', channel: a.channel, text: a.text })
          return { ts: `POSTED.TS.${postCounter}` }
        },
        async update(args: unknown): Promise<unknown> {
          const a = args as { channel: string; ts: string; text: string }
          calls.push({ kind: 'update', channel: a.channel, ts: a.ts, text: a.text })
          if (opts?.updateError) throw opts.updateError
          return {}
        },
      },
    },
    calls,
  }
}

interface ManualInterval { cb: () => void; ms: number; cleared: boolean }
function makeIntervalStubs(): {
  setInterval: typeof globalThis.setInterval
  clearInterval: typeof globalThis.clearInterval
  pending: ManualInterval[]
} {
  const pending: ManualInterval[] = []
  return {
    setInterval: ((cb: () => void, ms: number) => {
      const entry: ManualInterval = { cb, ms, cleared: false }
      pending.push(entry)
      return entry as unknown as ReturnType<typeof setInterval>
    }) as unknown as typeof globalThis.setInterval,
    clearInterval: ((handle: unknown) => {
      const entry = handle as ManualInterval
      entry.cleared = true
    }) as unknown as typeof globalThis.clearInterval,
    pending,
  }
}

/**
 * Seed a single live entry under the composite key
 * (instanceId, requestToken) by running one poller tick against a chat stub.
 * Returns the chat stub so the same `web` can be reused as the click
 * handler's `deps.web` — chat.update calls then accumulate on
 * `result.web.calls`.
 */
async function seedLiveEntry(opts: {
  instanceId: string
  channelId: string
  requestToken: string
  requestId?: number
}): Promise<{ chat: ReturnType<typeof makeChatStub>; pending: ManualInterval[] }> {
  const ivl = makeIntervalStubs()
  const chat = makeChatStub()
  const getClient = () => ({
    list: async () => ({
      spawns: [
        cannedListRow({
          claude_instance_id: opts.instanceId,
          state: 'check_permission',
          labels: { service: 'cscb', channel: opts.channelId },
        }),
      ],
    }),
    get: async () => cannedGetResultPlural({
      claude_instance_id: opts.instanceId,
      state: 'check_permission',
      permission_requests: [
        cannedPermissionRequest({
          request_token: opts.requestToken,
          request_id: opts.requestId ?? 1,
        }),
      ],
    }),
  })
  initOutageState({ getClient: () => getClient() as unknown as Client, postToChannel: () => {} })
  startPermissionPoller({
    getClient,
    web: chat.web as never,
    intervalMs: 1000,
    setInterval: ivl.setInterval,
    clearInterval: ivl.clearInterval,
  })
  ivl.pending[0].cb()
  await new Promise((r) => setTimeout(r, 10))
  return { chat, pending: ivl.pending }
}

/**
 * Seed TWO live entries on the SAME spawn under different request_tokens.
 * Used to assert SR-4.5 sibling independence on click. Uses the canonical
 * two-row plural-projection fixture and pins both tokens to known constants
 * so the test can target a specific sibling.
 */
async function seedTwoSiblings(opts: {
  instanceId: string
  channelId: string
  tokenA: string
  tokenB: string
}): Promise<{ chat: ReturnType<typeof makeChatStub>; pending: ManualInterval[] }> {
  const ivl = makeIntervalStubs()
  const chat = makeChatStub()
  // cannedTwoRowPluralProjection mints fresh random tokens; override the
  // two PermissionRequestRow entries' request_tokens to the test constants
  // by constructing the GetResult directly via cannedGetResultPlural.
  const getClient = () => ({
    list: async () => ({
      spawns: [
        cannedListRow({
          claude_instance_id: opts.instanceId,
          state: 'check_permission',
          labels: { service: 'cscb', channel: opts.channelId },
        }),
      ],
    }),
    get: async () => cannedGetResultPlural({
      claude_instance_id: opts.instanceId,
      state: 'check_permission',
      permission_requests: [
        cannedPermissionRequest({
          request_token: opts.tokenA,
          request_id: 1,
          tool_name: 'Bash',
          tool_input: JSON.stringify({ command: 'ls /tmp' }),
        }),
        cannedPermissionRequest({
          request_token: opts.tokenB,
          request_id: 2,
          tool_name: 'Edit',
          tool_input: JSON.stringify({ file_path: '/etc/hosts' }),
        }),
      ],
    }),
  })
  initOutageState({ getClient: () => getClient() as unknown as Client, postToChannel: () => {} })
  startPermissionPoller({
    getClient,
    web: chat.web as never,
    intervalMs: 1000,
    setInterval: ivl.setInterval,
    clearInterval: ivl.clearInterval,
  })
  ivl.pending[0].cb()
  await new Promise((r) => setTimeout(r, 10))
  return { chat, pending: ivl.pending }
}

/**
 * Build a decide-capturing client. Default behavior is to resolve with `{}`;
 * pass `throwOn` to inject an error on every call. The `calls` array is
 * mutated in place so individual tests can assert the decide-wire shape.
 */
function makeDecideStub(opts: { throwOn?: Error } = {}): {
  client: { decide: (params: DecideParams) => Promise<DecideResult> }
  calls: DecideParams[]
} {
  const calls: DecideParams[] = []
  return {
    client: {
      decide: async (params: DecideParams): Promise<DecideResult> => {
        calls.push(params)
        if (opts.throwOn) throw opts.throwOn
        return {}
      },
    },
    calls,
  }
}

interface ClickHandlerDepsShape {
  web: { chat: { update: (args: unknown) => Promise<unknown> } }
  log?: (...args: unknown[]) => void
  emitTrail?: (partial: CapturedTrailEvent) => void
}

afterEach(() => {
  stopPermissionPoller()
  _resetPollerState()
  _resetOutageState()
})

// ---------------------------------------------------------------------------
// Malformed action_id
// ---------------------------------------------------------------------------

describe('handlePermissionClick — non-matching action ids', () => {
  test('returns false on non-perm action id; no AD or chat call', async () => {
    const chat = makeChatStub()
    const decide = makeDecideStub()
    const handled = await handlePermissionClick(
      'some_other_action',
      {
        web: chat.web as never,
      } satisfies ClickHandlerDepsShape as never,
    )
    expect(handled).toBe(false)
    expect(decide.calls).toHaveLength(0)
    expect(chat.calls).toHaveLength(0)
  })

  test('returns false on perm action id missing the cscb_ prefix; no AD or chat call', async () => {
    const chat = makeChatStub()
    const decide = makeDecideStub()
    const handled = await handlePermissionClick(
      `perm_allow_NOT_CSCB_PREFIX_${TOKEN_A}`,
      {
        web: chat.web as never,
      } satisfies ClickHandlerDepsShape as never,
    )
    expect(handled).toBe(false)
    expect(decide.calls).toHaveLength(0)
    expect(chat.calls).toHaveLength(0)
  })

  test('returns false on perm action id with non-UUID trailing segment', async () => {
    const chat = makeChatStub()
    const decide = makeDecideStub()
    const handled = await handlePermissionClick(
      `perm_allow_${INSTANCE_C}_42`,
      {
        web: chat.web as never,
      } satisfies ClickHandlerDepsShape as never,
    )
    expect(handled).toBe(false)
    expect(decide.calls).toHaveLength(0)
    expect(chat.calls).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// Happy path — decide → chat.update → markHandled
// ---------------------------------------------------------------------------

describe('handlePermissionClick — happy path', () => {
  test('allow → decide(allow, request_token) → chat.update "Allowed" → markHandled', async () => {
    const seed = await seedLiveEntry({
      instanceId: INSTANCE_C,
      channelId: CHANNEL_CH,
      requestToken: TOKEN_A,
    })
    const entryBefore = getLivePermission(INSTANCE_C, TOKEN_A)
    expect(entryBefore).toBeDefined()
    const messageTs = entryBefore!.messageTs

    const decide = makeDecideStub()
    initOutageState({ getClient: () => decide.client as unknown as Client, postToChannel: () => {} })
    const handled = await handlePermissionClick(
      encodePermissionActionId('allow', INSTANCE_C, TOKEN_A),
      {
        web: seed.chat.web as never,
      } satisfies ClickHandlerDepsShape as never,
    )

    expect(handled).toBe(true)
    expect(decide.calls).toHaveLength(1)
    expect(decide.calls[0]).toEqual({
      claude_instance_id: INSTANCE_C,
      decision: 'allow',
      // SR-4.1 / SR-7.2: request_token is unconditionally on the wire.
      request_token: TOKEN_A,
    } as DecideParams & { request_token: string })

    const updates = seed.chat.calls.filter((c) => c.kind === 'update')
    expect(updates).toHaveLength(1)
    expect(updates[0].channel).toBe(CHANNEL_CH)
    expect(updates[0].ts).toBe(messageTs)
    expect(updates[0].text).toBe('*Permission* — Allowed')

    expect(getLivePermission(INSTANCE_C, TOKEN_A)?.handled).toBe(true)
  })

  test('deny → decide(deny, request_token) → chat.update "Denied by operator" → markHandled', async () => {
    const seed = await seedLiveEntry({
      instanceId: INSTANCE_C,
      channelId: CHANNEL_CH,
      requestToken: TOKEN_A,
    })
    const decide = makeDecideStub()
    initOutageState({ getClient: () => decide.client as unknown as Client, postToChannel: () => {} })

    await handlePermissionClick(
      encodePermissionActionId('deny', INSTANCE_C, TOKEN_A),
      {
        web: seed.chat.web as never,
      } satisfies ClickHandlerDepsShape as never,
    )

    expect(decide.calls).toHaveLength(1)
    expect(decide.calls[0].decision).toBe('deny')
    expect((decide.calls[0] as DecideParams & { request_token: string }).request_token).toBe(TOKEN_A)

    const updates = seed.chat.calls.filter((c) => c.kind === 'update')
    expect(updates).toHaveLength(1)
    expect(updates[0].text).toBe('*Permission* — Denied by operator')
    expect(getLivePermission(INSTANCE_C, TOKEN_A)?.handled).toBe(true)
  })

  test('chat.update throws → markHandled NOT called; handled stays false', async () => {
    const seed = await seedLiveEntry({
      instanceId: INSTANCE_C,
      channelId: CHANNEL_CH,
      requestToken: TOKEN_A,
    })
    // Swap the seeded chat stub's update for one that throws by overriding
    // its method directly (the click handler reuses seed.chat.web).
    const chatForClick = makeChatStub({ updateError: new Error('Slack API down') })
    const decide = makeDecideStub()
    initOutageState({ getClient: () => decide.client as unknown as Client, postToChannel: () => {} })

    const logs: unknown[][] = []
    const result = await handlePermissionClick(
      encodePermissionActionId('allow', INSTANCE_C, TOKEN_A),
      {
        web: chatForClick.web as never,
        log: (...args: unknown[]) => logs.push(args),
      } satisfies ClickHandlerDepsShape as never,
    )

    expect(result).toBe(true)
    // decide still landed before chat.update was attempted.
    expect(decide.calls).toHaveLength(1)
    // chat.update was attempted once and threw.
    expect(chatForClick.calls.filter((c) => c.kind === 'update')).toHaveLength(1)
    // handled stays false — markHandled is only called on update success.
    const entry = getLivePermission(INSTANCE_C, TOKEN_A)
    expect(entry).toBeDefined()
    expect(entry?.handled).toBe(false)
    // b.emk: failures land in BOTH server.log (via logDeps) and the trail
    // JSONL (cscb.chat_update.attempted{ok=false}, asserted separately).
    expect(logs.length).toBeGreaterThan(0)
    // The original seeded stub did not see the update (it landed on the
    // separately-stubbed chatForClick), so the poller's chat history is
    // untouched.
    expect(seed.chat.calls.filter((c) => c.kind === 'update')).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// SR-4.1 / SR-7.2 — decide-wire invariant
// ---------------------------------------------------------------------------

describe('handlePermissionClick — decide-wire invariant (SR-4.1 / SR-7.2)', () => {
  test('every decide call carries a non-empty request_token matching the action_id', async () => {
    const seed = await seedLiveEntry({
      instanceId: INSTANCE_C,
      channelId: CHANNEL_CH,
      requestToken: TOKEN_A,
    })
    const decide = makeDecideStub()
    initOutageState({ getClient: () => decide.client as unknown as Client, postToChannel: () => {} })
    await handlePermissionClick(
      encodePermissionActionId('allow', INSTANCE_C, TOKEN_A),
      {
        web: seed.chat.web as never,
      } satisfies ClickHandlerDepsShape as never,
    )
    expect(decide.calls).toHaveLength(1)
    const wire = decide.calls[0] as DecideParams & { request_token: string }
    expect(typeof wire.request_token).toBe('string')
    expect(wire.request_token.length).toBeGreaterThan(0)
    expect(wire.request_token).toBe(TOKEN_A)
  })
})

// ---------------------------------------------------------------------------
// SR-4.2 — stale click semantics (no live entry but decide STILL fires)
// ---------------------------------------------------------------------------

describe('handlePermissionClick — stale click (SR-4.2)', () => {
  test('no live entry for (instance, token) → decide STILL fires with decoded token; NO chat.update', async () => {
    // Do NOT seed an entry. The poller-state is empty; the click is stale.
    // Supply context.channel so ctxChannel resolves and decide still fires
    // (production payloads always carry a channel).
    const chat = makeChatStub()
    const decide = makeDecideStub()
    initOutageState({ getClient: () => decide.client as unknown as Client, postToChannel: () => {} })
    const result = await handlePermissionClick(
      encodePermissionActionId('allow', INSTANCE_C, TOKEN_C),
      {
        web: chat.web as never,
        log: () => { /* swallow */ },
      } satisfies ClickHandlerDepsShape as never,
      { channel: CHANNEL_CH },
    )

    expect(result).toBe(true)
    // SR-4.2: decide STILL fires on stale clicks — AD is the source of truth.
    expect(decide.calls).toHaveLength(1)
    expect(decide.calls[0]).toEqual({
      claude_instance_id: INSTANCE_C,
      decision: 'allow',
      request_token: TOKEN_C,
    } as DecideParams & { request_token: string })
    // No chat.update from the click handler — the poller's reconciliation
    // tick surfaces the closure.
    expect(chat.calls.filter((c) => c.kind === 'update')).toHaveLength(0)
  })

  test('seeded entry on a DIFFERENT token → that other entry untouched; clicked token still fires decide', async () => {
    // Seed token A live; click token C (not in map). This makes sure the
    // composite-key lookup miss is taken on the click's token, not on the
    // claude_instance_id alone. Supply context.channel so ctxChannel resolves.
    const seed = await seedLiveEntry({
      instanceId: INSTANCE_C,
      channelId: CHANNEL_CH,
      requestToken: TOKEN_A,
    })
    const decide = makeDecideStub()
    initOutageState({ getClient: () => decide.client as unknown as Client, postToChannel: () => {} })
    await handlePermissionClick(
      encodePermissionActionId('deny', INSTANCE_C, TOKEN_C),
      {
        web: seed.chat.web as never,
        log: () => { /* swallow */ },
      } satisfies ClickHandlerDepsShape as never,
      { channel: CHANNEL_CH },
    )
    expect(decide.calls).toHaveLength(1)
    expect((decide.calls[0] as DecideParams & { request_token: string }).request_token).toBe(TOKEN_C)
    // The seeded sibling on TOKEN_A is untouched: no chat.update against
    // its messageTs, handled=false.
    expect(seed.chat.calls.filter((c) => c.kind === 'update')).toHaveLength(0)
    expect(getLivePermission(INSTANCE_C, TOKEN_A)?.handled).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// SR-4.4 — decide-error handling
// ---------------------------------------------------------------------------

describe('handlePermissionClick — decide-error handling (SR-4.4)', () => {
  test('ErrAlreadyDecided → silent swallow: no chat.update, no markHandled, returns true', async () => {
    const seed = await seedLiveEntry({
      instanceId: INSTANCE_C,
      channelId: CHANNEL_CH,
      requestToken: TOKEN_A,
    })
    const decide = makeDecideStub({ throwOn: errAlreadyDecided() })
    initOutageState({ getClient: () => decide.client as unknown as Client, postToChannel: () => {} })
    const logs: unknown[][] = []

    const result = await handlePermissionClick(
      encodePermissionActionId('allow', INSTANCE_C, TOKEN_A),
      {
        web: seed.chat.web as never,
        log: (...args: unknown[]) => logs.push(args),
      } satisfies ClickHandlerDepsShape as never,
    )

    expect(result).toBe(true)
    expect(decide.calls).toHaveLength(1)
    // SR-4.4: no chat.update from the click handler on ErrAlreadyDecided.
    expect(seed.chat.calls.filter((c) => c.kind === 'update')).toHaveLength(0)
    // markHandled was NOT called: the entry remains pristine.
    expect(getLivePermission(INSTANCE_C, TOKEN_A)?.handled).toBe(false)
    // ErrAlreadyDecided is swallowed silently — no log fires.
    expect(logs).toHaveLength(0)
  })

  test('ErrInvalidFlags → logged once, no retry, no chat.update; returns true', async () => {
    const seed = await seedLiveEntry({
      instanceId: INSTANCE_C,
      channelId: CHANNEL_CH,
      requestToken: TOKEN_A,
    })
    const decide = makeDecideStub({ throwOn: errInvalidFlags() })
    initOutageState({ getClient: () => decide.client as unknown as Client, postToChannel: () => {} })
    const logs: unknown[][] = []

    const result = await handlePermissionClick(
      encodePermissionActionId('allow', INSTANCE_C, TOKEN_A),
      {
        web: seed.chat.web as never,
        log: (...args: unknown[]) => logs.push(args),
      } satisfies ClickHandlerDepsShape as never,
    )

    expect(result).toBe(true)
    // exactly one decide attempt — no retry.
    expect(decide.calls).toHaveLength(1)
    // exactly one log entry.
    expect(logs).toHaveLength(1)
    // The log message names the failing errName.
    expect(String(logs[0].join(' '))).toContain('ErrInvalidFlags')
    // No chat.update from the click handler.
    expect(seed.chat.calls.filter((c) => c.kind === 'update')).toHaveLength(0)
    // No markHandled mutation.
    expect(getLivePermission(INSTANCE_C, TOKEN_A)?.handled).toBe(false)
  })

  test('ErrAmbiguousRequest → logged once, no retry, no chat.update; returns true', async () => {
    const seed = await seedLiveEntry({
      instanceId: INSTANCE_C,
      channelId: CHANNEL_CH,
      requestToken: TOKEN_A,
    })
    const decide = makeDecideStub({ throwOn: errAmbiguousRequest() })
    initOutageState({ getClient: () => decide.client as unknown as Client, postToChannel: () => {} })
    const logs: unknown[][] = []

    const result = await handlePermissionClick(
      encodePermissionActionId('allow', INSTANCE_C, TOKEN_A),
      {
        web: seed.chat.web as never,
        log: (...args: unknown[]) => logs.push(args),
      } satisfies ClickHandlerDepsShape as never,
    )

    expect(result).toBe(true)
    expect(decide.calls).toHaveLength(1)
    expect(logs).toHaveLength(1)
    expect(String(logs[0].join(' '))).toContain('ErrAmbiguousRequest')
    expect(seed.chat.calls.filter((c) => c.kind === 'update')).toHaveLength(0)
    expect(getLivePermission(INSTANCE_C, TOKEN_A)?.handled).toBe(false)
  })

  test('unknown (non-AgentDirectorError) → logged, no chat.update, returns true', async () => {
    const seed = await seedLiveEntry({
      instanceId: INSTANCE_C,
      channelId: CHANNEL_CH,
      requestToken: TOKEN_A,
    })
    const decide = makeDecideStub({ throwOn: new Error('something exploded') })
    initOutageState({ getClient: () => decide.client as unknown as Client, postToChannel: () => {} })
    const logs: unknown[][] = []

    const result = await handlePermissionClick(
      encodePermissionActionId('allow', INSTANCE_C, TOKEN_A),
      {
        web: seed.chat.web as never,
        log: (...args: unknown[]) => logs.push(args),
      } satisfies ClickHandlerDepsShape as never,
    )

    expect(result).toBe(true)
    expect(decide.calls).toHaveLength(1)
    expect(logs).toHaveLength(1)
    expect(seed.chat.calls.filter((c) => c.kind === 'update')).toHaveLength(0)
    expect(getLivePermission(INSTANCE_C, TOKEN_A)?.handled).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// SR-4.5 — sibling independence on click
// ---------------------------------------------------------------------------

describe('handlePermissionClick — sibling independence (SR-4.5)', () => {
  test('two sibling rows seeded; clicking one updates only the clicked entry', async () => {
    const seed = await seedTwoSiblings({
      instanceId: INSTANCE_C,
      channelId: CHANNEL_CH,
      tokenA: TOKEN_A,
      tokenB: TOKEN_B,
    })

    const entryABefore = getLivePermission(INSTANCE_C, TOKEN_A)
    const entryBBefore = getLivePermission(INSTANCE_C, TOKEN_B)
    expect(entryABefore).toBeDefined()
    expect(entryBBefore).toBeDefined()
    expect(entryABefore!.messageTs).not.toBe(entryBBefore!.messageTs)
    const tsA = entryABefore!.messageTs
    const tsB = entryBBefore!.messageTs

    // Click sibling A.
    const decide = makeDecideStub()
    initOutageState({ getClient: () => decide.client as unknown as Client, postToChannel: () => {} })
    await handlePermissionClick(
      encodePermissionActionId('allow', INSTANCE_C, TOKEN_A),
      {
        web: seed.chat.web as never,
      } satisfies ClickHandlerDepsShape as never,
    )

    // Exactly one decide call, carrying A's token.
    expect(decide.calls).toHaveLength(1)
    expect((decide.calls[0] as DecideParams & { request_token: string }).request_token).toBe(TOKEN_A)

    // Exactly one chat.update — against A's messageTs only.
    const updates = seed.chat.calls.filter((c) => c.kind === 'update')
    expect(updates).toHaveLength(1)
    expect(updates[0].ts).toBe(tsA)
    // No update targeted B's messageTs.
    expect(updates.find((u) => u.ts === tsB)).toBeUndefined()

    // A is markHandled; B is untouched.
    expect(getLivePermission(INSTANCE_C, TOKEN_A)?.handled).toBe(true)
    expect(getLivePermission(INSTANCE_C, TOKEN_B)?.handled).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Smoke: helper-only stubs reach reasonable round-trip behavior — guard rail
// against accidental regressions in the fixture helpers themselves.
// ---------------------------------------------------------------------------

describe('handlePermissionClick — helper sanity', () => {
  test('cannedGetResultPlural seed yields a getLivePermission entry under the composite key', async () => {
    await seedLiveEntry({
      instanceId: INSTANCE_C,
      channelId: CHANNEL_CH,
      requestToken: TOKEN_A,
      requestId: 17,
    })
    const entry = getLivePermission(INSTANCE_C, TOKEN_A)
    expect(entry).toBeDefined()
    expect(entry?.claudeInstanceId).toBe(INSTANCE_C)
    expect(entry?.requestToken).toBe(TOKEN_A)
    expect(entry?.requestId).toBe(17)
    expect(entry?.handled).toBe(false)
  })

})

// ---------------------------------------------------------------------------
// SR-V Epic 3 — cscb.chat_update.attempted (click-handler-triggered)
// ---------------------------------------------------------------------------

describe('trail events — cscb.chat_update.attempted (click-handler-triggered)', () => {
  test('Allow click → ok=true, verdict_tag=click_handler_allow, triggered_by=click_handler', async () => {
    const seed = await seedLiveEntry({
      instanceId: INSTANCE_C,
      channelId: CHANNEL_CH,
      requestToken: TOKEN_A,
    })
    const entry = getLivePermission(INSTANCE_C, TOKEN_A)!
    const trail = makeTrailCapture()
    const decide = makeDecideStub()
    initOutageState({ getClient: () => decide.client as unknown as Client, postToChannel: () => {} })
    await handlePermissionClick(
      encodePermissionActionId('allow', INSTANCE_C, TOKEN_A),
      {
        web: seed.chat.web as never,
        emitTrail: trail.emit,
      } satisfies ClickHandlerDepsShape as never,
    )
    const closure = trail.events.find(e => e.event === 'cscb.chat_update.attempted')
    expect(closure).toBeDefined()
    expect(closure!['verdict_tag']).toBe('click_handler_allow')
    expect(closure!['triggered_by']).toBe('click_handler')
    expect(closure!['ok']).toBe(true)
    expect(closure!.channel).toBe(CHANNEL_CH)
    expect(closure!.message_ts).toBe(entry.messageTs)
    expect(typeof closure!['text']).toBe('string')
    expect(Array.isArray(closure!['blocks'])).toBe(true)
    expect(closure!.request_token).toBe(TOKEN_A)
  })

  test('Deny click → ok=true, verdict_tag=click_handler_deny', async () => {
    const seed = await seedLiveEntry({
      instanceId: INSTANCE_C,
      channelId: CHANNEL_CH,
      requestToken: TOKEN_A,
    })
    const trail = makeTrailCapture()
    const decide = makeDecideStub()
    initOutageState({ getClient: () => decide.client as unknown as Client, postToChannel: () => {} })
    await handlePermissionClick(
      encodePermissionActionId('deny', INSTANCE_C, TOKEN_A),
      {
        web: seed.chat.web as never,
        emitTrail: trail.emit,
      } satisfies ClickHandlerDepsShape as never,
    )
    const closure = trail.events.find(e => e.event === 'cscb.chat_update.attempted')
    expect(closure!['verdict_tag']).toBe('click_handler_deny')
    expect(closure!['triggered_by']).toBe('click_handler')
    expect(closure!['ok']).toBe(true)
  })

  test('chat.update Slack platform error → ok=false, error=Slack platform error class', async () => {
    await seedLiveEntry({
      instanceId: INSTANCE_C,
      channelId: CHANNEL_CH,
      requestToken: TOKEN_A,
    })
    const platformError = Object.assign(new Error('platform error'), {
      name: 'WebAPIPlatformError',
      data: { ok: false, error: 'message_not_found' },
    })
    const chatForClick = makeChatStub({ updateError: platformError })
    const trail = makeTrailCapture()
    const decide = makeDecideStub()
    initOutageState({ getClient: () => decide.client as unknown as Client, postToChannel: () => {} })
    await handlePermissionClick(
      encodePermissionActionId('allow', INSTANCE_C, TOKEN_A),
      {
        web: chatForClick.web as never,
        emitTrail: trail.emit,
      } satisfies ClickHandlerDepsShape as never,
    )
    const closure = trail.events.find(e => e.event === 'cscb.chat_update.attempted')
    expect(closure).toBeDefined()
    expect(closure!['ok']).toBe(false)
    expect(closure!['error']).toBe('message_not_found')
    expect(closure!['triggered_by']).toBe('click_handler')
  })

  test('request_token correlation: trail event request_token matches decoded action_id', async () => {
    const seed = await seedLiveEntry({
      instanceId: INSTANCE_C,
      channelId: CHANNEL_CH,
      requestToken: TOKEN_C,
    })
    const trail = makeTrailCapture()
    const decide = makeDecideStub()
    initOutageState({ getClient: () => decide.client as unknown as Client, postToChannel: () => {} })
    await handlePermissionClick(
      encodePermissionActionId('allow', INSTANCE_C, TOKEN_C),
      {
        web: seed.chat.web as never,
        emitTrail: trail.emit,
      } satisfies ClickHandlerDepsShape as never,
    )
    const closure = trail.events.find(e => e.event === 'cscb.chat_update.attempted')
    expect(closure!.request_token).toBe(TOKEN_C)
    expect(closure!.claude_instance_id).toBe(INSTANCE_C)
  })
})

// ---------------------------------------------------------------------------
// SR-V Epic 4 — cscb.click_handler.invoked
// ---------------------------------------------------------------------------

describe('trail events — cscb.click_handler.invoked', () => {
  const USER = 'U_OPERATOR'

  test('live_pending=true when a LivePermission entry exists at click time', async () => {
    const seed = await seedLiveEntry({
      instanceId: INSTANCE_C,
      channelId: CHANNEL_CH,
      requestToken: TOKEN_A,
    })
    const entry = getLivePermission(INSTANCE_C, TOKEN_A)!
    const trail = makeTrailCapture()
    const decide = makeDecideStub()
    initOutageState({ getClient: () => decide.client as unknown as Client, postToChannel: () => {} })
    const actionId = encodePermissionActionId('allow', INSTANCE_C, TOKEN_A)
    await handlePermissionClick(
      actionId,
      {
        web: seed.chat.web as never,
        emitTrail: trail.emit,
      } satisfies ClickHandlerDepsShape as never,
      { channel: CHANNEL_CH, messageTs: entry.messageTs, user: USER },
    )
    const invoked = trail.events.find(e => e.event === 'cscb.click_handler.invoked')
    expect(invoked).toBeDefined()
    expect(invoked!['live_pending']).toBe(true)
    expect(invoked!['decision']).toBe('allow')
    expect(invoked!.claude_instance_id).toBe(INSTANCE_C)
    expect(invoked!.request_token).toBe(TOKEN_A)
    expect(invoked!.channel).toBe(CHANNEL_CH)
    expect(invoked!.message_ts).toBe(entry.messageTs)
    expect(invoked!['user']).toBe(USER)
    expect(invoked!['raw_action_id']).toBe(actionId)
  })

  test('live_pending=false when no LivePermission entry exists at click time', async () => {
    // No seed — the live map is empty.
    const decide = makeDecideStub()
    initOutageState({ getClient: () => decide.client as unknown as Client, postToChannel: () => {} })
    const trail = makeTrailCapture()
    const chatForClick = makeChatStub()
    const actionId = encodePermissionActionId('deny', INSTANCE_C, TOKEN_A)
    await handlePermissionClick(
      actionId,
      {
        web: chatForClick.web as never,
        emitTrail: trail.emit,
      } satisfies ClickHandlerDepsShape as never,
      { channel: CHANNEL_CH, messageTs: '0000.0000', user: USER },
    )
    const invoked = trail.events.find(e => e.event === 'cscb.click_handler.invoked')
    expect(invoked).toBeDefined()
    expect(invoked!['live_pending']).toBe(false)
    expect(invoked!['decision']).toBe('deny')
    expect(invoked!.claude_instance_id).toBe(INSTANCE_C)
    expect(invoked!.request_token).toBe(TOKEN_A)
  })

  test('decode failure path does NOT emit cscb.click_handler.invoked', async () => {
    const decide = makeDecideStub()
    const trail = makeTrailCapture()
    const chatForClick = makeChatStub()
    const handled = await handlePermissionClick(
      'foreign_bot_action',
      {
        web: chatForClick.web as never,
        emitTrail: trail.emit,
      } satisfies ClickHandlerDepsShape as never,
      { channel: CHANNEL_CH, messageTs: '0.0', user: USER },
    )
    expect(handled).toBe(false)
    const invoked = trail.events.find(e => e.event === 'cscb.click_handler.invoked')
    expect(invoked).toBeUndefined()
    // Defense in depth: the decide call must also NOT fire on decode failure.
    expect(decide.calls).toHaveLength(0)
  })

  test('emitted once per call (no duplicate emissions per click)', async () => {
    const seed = await seedLiveEntry({
      instanceId: INSTANCE_C,
      channelId: CHANNEL_CH,
      requestToken: TOKEN_A,
    })
    const trail = makeTrailCapture()
    const decide = makeDecideStub()
    initOutageState({ getClient: () => decide.client as unknown as Client, postToChannel: () => {} })
    await handlePermissionClick(
      encodePermissionActionId('allow', INSTANCE_C, TOKEN_A),
      {
        web: seed.chat.web as never,
        emitTrail: trail.emit,
      } satisfies ClickHandlerDepsShape as never,
      { channel: CHANNEL_CH, messageTs: 'TS', user: USER },
    )
    const invoked = trail.events.filter(e => e.event === 'cscb.click_handler.invoked')
    expect(invoked).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// SR-V Epic 5 — cscb.ad_decide.attempted
// ---------------------------------------------------------------------------

describe('trail events — cscb.ad_decide.attempted', () => {
  const USER = 'U_OPERATOR'

  test('happy path → result_class="ok" with submitted decision', async () => {
    const seed = await seedLiveEntry({
      instanceId: INSTANCE_C,
      channelId: CHANNEL_CH,
      requestToken: TOKEN_A,
    })
    const trail = makeTrailCapture()
    const decide = makeDecideStub()
    initOutageState({ getClient: () => decide.client as unknown as Client, postToChannel: () => {} })
    await handlePermissionClick(
      encodePermissionActionId('allow', INSTANCE_C, TOKEN_A),
      {
        web: seed.chat.web as never,
        emitTrail: trail.emit,
      } satisfies ClickHandlerDepsShape as never,
      { channel: CHANNEL_CH, messageTs: 'TS', user: USER },
    )
    const event = trail.events.find(e => e.event === 'cscb.ad_decide.attempted')
    expect(event).toBeDefined()
    expect(event!['result_class']).toBe('ok')
    expect(event!['decision']).toBe('allow')
    expect(event!.claude_instance_id).toBe(INSTANCE_C)
    expect(event!.request_token).toBe(TOKEN_A)
    expect('raw_error_message' in event!).toBe(false)
  })

  test('happy path → submitted decision recorded for deny', async () => {
    const seed = await seedLiveEntry({
      instanceId: INSTANCE_C,
      channelId: CHANNEL_CH,
      requestToken: TOKEN_A,
    })
    const trail = makeTrailCapture()
    const decide = makeDecideStub()
    initOutageState({ getClient: () => decide.client as unknown as Client, postToChannel: () => {} })
    await handlePermissionClick(
      encodePermissionActionId('deny', INSTANCE_C, TOKEN_A),
      {
        web: seed.chat.web as never,
        emitTrail: trail.emit,
      } satisfies ClickHandlerDepsShape as never,
      { channel: CHANNEL_CH, messageTs: 'TS', user: USER },
    )
    const event = trail.events.find(e => e.event === 'cscb.ad_decide.attempted')
    expect(event!['decision']).toBe('deny')
    expect(event!['result_class']).toBe('ok')
  })

  test('ErrAlreadyDecided → result_class="ErrAlreadyDecided", no raw_error_message', async () => {
    const seed = await seedLiveEntry({
      instanceId: INSTANCE_C,
      channelId: CHANNEL_CH,
      requestToken: TOKEN_A,
    })
    const trail = makeTrailCapture()
    const decide = makeDecideStub({ throwOn: errAlreadyDecided() })
    initOutageState({ getClient: () => decide.client as unknown as Client, postToChannel: () => {} })
    await handlePermissionClick(
      encodePermissionActionId('allow', INSTANCE_C, TOKEN_A),
      {
        web: seed.chat.web as never,
        emitTrail: trail.emit,
      } satisfies ClickHandlerDepsShape as never,
      { channel: CHANNEL_CH, messageTs: 'TS', user: USER },
    )
    const event = trail.events.find(e => e.event === 'cscb.ad_decide.attempted')
    expect(event!['result_class']).toBe('ErrAlreadyDecided')
    expect('raw_error_message' in event!).toBe(false)
  })

  test('ErrInvalidFlags → result_class="ErrInvalidFlags", no raw_error_message', async () => {
    const seed = await seedLiveEntry({
      instanceId: INSTANCE_C,
      channelId: CHANNEL_CH,
      requestToken: TOKEN_A,
    })
    const trail = makeTrailCapture()
    const decide = makeDecideStub({ throwOn: errInvalidFlags() })
    initOutageState({ getClient: () => decide.client as unknown as Client, postToChannel: () => {} })
    await handlePermissionClick(
      encodePermissionActionId('allow', INSTANCE_C, TOKEN_A),
      {
        web: seed.chat.web as never,
        emitTrail: trail.emit,
        log: () => { /* swallow */ },
      } satisfies ClickHandlerDepsShape as never,
      { channel: CHANNEL_CH, messageTs: 'TS', user: USER },
    )
    const event = trail.events.find(e => e.event === 'cscb.ad_decide.attempted')
    expect(event!['result_class']).toBe('ErrInvalidFlags')
    expect('raw_error_message' in event!).toBe(false)
  })

  test('ErrAmbiguousRequest → result_class="ErrAmbiguousRequest", no raw_error_message', async () => {
    const seed = await seedLiveEntry({
      instanceId: INSTANCE_C,
      channelId: CHANNEL_CH,
      requestToken: TOKEN_A,
    })
    const trail = makeTrailCapture()
    const decide = makeDecideStub({ throwOn: errAmbiguousRequest() })
    initOutageState({ getClient: () => decide.client as unknown as Client, postToChannel: () => {} })
    await handlePermissionClick(
      encodePermissionActionId('allow', INSTANCE_C, TOKEN_A),
      {
        web: seed.chat.web as never,
        emitTrail: trail.emit,
        log: () => { /* swallow */ },
      } satisfies ClickHandlerDepsShape as never,
      { channel: CHANNEL_CH, messageTs: 'TS', user: USER },
    )
    const event = trail.events.find(e => e.event === 'cscb.ad_decide.attempted')
    expect(event!['result_class']).toBe('ErrAmbiguousRequest')
    expect('raw_error_message' in event!).toBe(false)
  })

  test('generic Error → result_class="other" with raw_error_message', async () => {
    const seed = await seedLiveEntry({
      instanceId: INSTANCE_C,
      channelId: CHANNEL_CH,
      requestToken: TOKEN_A,
    })
    const trail = makeTrailCapture()
    const decide = makeDecideStub({ throwOn: new Error('network timeout') })
    initOutageState({ getClient: () => decide.client as unknown as Client, postToChannel: () => {} })
    await handlePermissionClick(
      encodePermissionActionId('allow', INSTANCE_C, TOKEN_A),
      {
        web: seed.chat.web as never,
        emitTrail: trail.emit,
        log: () => { /* swallow */ },
      } satisfies ClickHandlerDepsShape as never,
      { channel: CHANNEL_CH, messageTs: 'TS', user: USER },
    )
    const event = trail.events.find(e => e.event === 'cscb.ad_decide.attempted')
    expect(event!['result_class']).toBe('other')
    expect(event!['raw_error_message']).toBe('network timeout')
  })

  test('request_token correlates with click_handler.invoked from Epic 4', async () => {
    const seed = await seedLiveEntry({
      instanceId: INSTANCE_C,
      channelId: CHANNEL_CH,
      requestToken: TOKEN_B,
    })
    const trail = makeTrailCapture()
    const decide = makeDecideStub()
    initOutageState({ getClient: () => decide.client as unknown as Client, postToChannel: () => {} })
    await handlePermissionClick(
      encodePermissionActionId('allow', INSTANCE_C, TOKEN_B),
      {
        web: seed.chat.web as never,
        emitTrail: trail.emit,
      } satisfies ClickHandlerDepsShape as never,
      { channel: CHANNEL_CH, messageTs: 'TS', user: USER },
    )
    const invoked = trail.events.find(e => e.event === 'cscb.click_handler.invoked')
    const decided = trail.events.find(e => e.event === 'cscb.ad_decide.attempted')
    expect(invoked!.request_token).toBe(TOKEN_B)
    expect(decided!.request_token).toBe(TOKEN_B)
    // click_handler.invoked is emitted BEFORE ad_decide.attempted.
    const idxInv = trail.events.indexOf(invoked!)
    const idxDec = trail.events.indexOf(decided!)
    expect(idxInv).toBeLessThan(idxDec)
  })
})

// ---------------------------------------------------------------------------
// Epic 5 — wrapper outage short-circuit + log-and-bypass
// ---------------------------------------------------------------------------

describe('handlePermissionClick — wrapper outage short-circuit', () => {
  test('ErrSystemInstallDisappeared → ad-unreachable flag raised; no per-event logDeps call; returns true', async () => {
    const BINARY = '/usr/local/bin/agent-director'
    const err = new ErrSystemInstallDisappeared('spawn', BINARY)
    const decide = makeDecideStub({ throwOn: err })
    const seed = await seedLiveEntry({
      instanceId: INSTANCE_C,
      channelId: CHANNEL_CH,
      requestToken: TOKEN_A,
    })
    initOutageState({ getClient: () => decide.client as unknown as Client, postToChannel: () => {} })
    const logCalls: unknown[][] = []
    const handled = await handlePermissionClick(
      encodePermissionActionId('allow', INSTANCE_C, TOKEN_A),
      {
        web: seed.chat.web as never,
        log: (...args) => { logCalls.push(args) },
      } satisfies ClickHandlerDepsShape as never,
      { channel: CHANNEL_CH },
    )
    expect(handled).toBe(true)
    // The wrapper raised ad-unreachable with the binary path as detail.
    expect(getOutageFlags(CHANNEL_CH).has('ad-unreachable')).toBe(true)
    // The per-event logDeps branch (ErrInvalidFlags / ErrAmbiguousRequest / generic log)
    // must NOT fire — the ad/tmux short-circuit returns before those branches.
    expect(logCalls).toHaveLength(0)
  })

  test('carve-out trail entry carries result_class=ErrSystemInstallDisappeared + raw_error_message', async () => {
    const BINARY = '/usr/local/bin/agent-director'
    const err = new ErrSystemInstallDisappeared('spawn', BINARY)
    const decide = makeDecideStub({ throwOn: err })
    const seed = await seedLiveEntry({
      instanceId: INSTANCE_C,
      channelId: CHANNEL_CH,
      requestToken: TOKEN_A,
    })
    initOutageState({ getClient: () => decide.client as unknown as Client, postToChannel: () => {} })
    const trail = makeTrailCapture()
    await handlePermissionClick(
      encodePermissionActionId('allow', INSTANCE_C, TOKEN_A),
      {
        web: seed.chat.web as never,
        emitTrail: trail.emit,
      } satisfies ClickHandlerDepsShape as never,
      { channel: CHANNEL_CH },
    )
    // Exactly one cscb.ad_decide.attempted entry should land — the carve-out
    // emits before the early return. result_class names the typed AD error
    // (not the generic 'other' bucket); raw_error_message preserves the
    // forensic context the loud Slack alert can't carry by itself.
    const adDecides = trail.events.filter(e => e['event'] === 'cscb.ad_decide.attempted')
    expect(adDecides).toHaveLength(1)
    expect(adDecides[0]['result_class']).toBe('ErrSystemInstallDisappeared')
    expect(adDecides[0]['raw_error_message']).toBe(err.message)
    expect(adDecides[0]['claude_instance_id']).toBe(INSTANCE_C)
    expect(adDecides[0]['request_token']).toBe(TOKEN_A)
  })

  test('carve-out trail entry for ErrTmuxNotAvailable: result_class=ErrTmuxNotAvailable + raw_error_message', async () => {
    const ErrTmuxCtor = (await import('agent-director')).ErrTmuxNotAvailable
    const err = new ErrTmuxCtor('spawn', 'ErrTmuxNotAvailable', 'tmux not found on PATH')
    const decide = makeDecideStub({ throwOn: err })
    const seed = await seedLiveEntry({
      instanceId: INSTANCE_C,
      channelId: CHANNEL_CH,
      requestToken: TOKEN_A,
    })
    initOutageState({ getClient: () => decide.client as unknown as Client, postToChannel: () => {} })
    const trail = makeTrailCapture()
    await handlePermissionClick(
      encodePermissionActionId('allow', INSTANCE_C, TOKEN_A),
      {
        web: seed.chat.web as never,
        emitTrail: trail.emit,
      } satisfies ClickHandlerDepsShape as never,
      { channel: CHANNEL_CH },
    )
    const adDecides = trail.events.filter(e => e['event'] === 'cscb.ad_decide.attempted')
    expect(adDecides).toHaveLength(1)
    expect(adDecides[0]['result_class']).toBe('ErrTmuxNotAvailable')
    expect(adDecides[0]['raw_error_message']).toBe(err.message)
    expect(getOutageFlags(CHANNEL_CH).has('tmux-unavailable')).toBe(true)
  })
})

describe('handlePermissionClick — log-and-bypass (no resolvable ctxChannel)', () => {
  test('no context.channel + no earlyEntry → 0 decide calls, no outage flag, diagnostic log emitted', async () => {
    const decide = makeDecideStub()
    initOutageState({ getClient: () => decide.client as unknown as Client, postToChannel: () => {} })
    const logLines: string[] = []
    const ACTION_ID = encodePermissionActionId('allow', INSTANCE_C, TOKEN_A)
    const handled = await handlePermissionClick(
      ACTION_ID,
      {
        web: { chat: { update: async () => ({}) } } as never,
        log: (...args) => { logLines.push(args.map(String).join(' ')) },
      } satisfies ClickHandlerDepsShape as never,
      // no context.channel supplied; no live entry seeded → ctxChannel = undefined
      {},
    )
    expect(handled).toBe(true)
    expect(decide.calls).toHaveLength(0)
    // No orphan outage flag under any channel, including '<unknown>'
    expect(getOutageFlags(CHANNEL_CH).size).toBe(0)
    // Diagnostic log must contain action_id and request_token
    const log = logLines.join('\n')
    expect(log).toContain(ACTION_ID)
    expect(log).toContain(TOKEN_A)
  })
})
