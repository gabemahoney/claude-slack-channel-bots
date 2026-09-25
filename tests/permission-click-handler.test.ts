/**
 * permission-click-handler.test.ts — SR-2.2 / SR-4 click → decide path under
 * the request_token / plural-projection wire (Epic 2 rewrite), resolved by
 * persona (b.av2 SR-7.1).
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
 *   - Happy path with chat.update failing (scripted on the stub) →
 *     markHandled NOT called; one token-safe log line; nothing leaks.
 *   - ErrAlreadyDecided → silent swallow. No chat.update, no markHandled
 *     mutation (SR-4.4).
 *   - ErrRelayFallenBack → log + buttonless "answer at the tmux pane"
 *     repaint + no markHandled + no retry (b.qi1).
 *   - ErrInvalidFlags / ErrAmbiguousRequest → log + no retry + no
 *     chat.update (SR-4.4).
 *   - Unknown decide error → log + no chat.update (SR-4.4).
 *   - Sibling independence: clicking one of two siblings on the same spawn
 *     leaves the sibling's entry / messageTs untouched (SR-4.5).
 *   - Malformed action_id returns false (caller keeps looking), before the
 *     receiving persona is resolved.
 *
 * Persona pins (b.av2 SR-7.1, AC 28):
 *   - Two personas, A and B, each with its own `makeStubSlack` Web stub and
 *     a destination channel that differs from its key. Prompts are seeded
 *     through a poller tick, so they post on A's stub to A's destination.
 *   - A click on A's prompt resolves and updates through A's client only;
 *     B's stub sees no call.
 *   - Outage flags raised by decide land under the persona key, never the
 *     channel ID.
 *   - A click with no live entry and no payload channel, received for an
 *     applied persona, is still decided.
 *   - An unresolvable receiving persona is logged and bypassed; a click whose
 *     instance is not `cscb_<receiving key>` fails closed; a persona with no
 *     client gets decide but no update and no markHandled.
 *   - Trail `channel` fields keep holding Slack channel IDs.
 *
 * DM prompt pins (b.av2 SR-7.1 DM part, SR-5.1 exception; AC 29, AC 36):
 *   - A third persona, D, has DMs on, a `dm.contact` and
 *     `permission_prompts: 'dm'`. Its prompt is seeded through a poller tick,
 *     which opens the DM on D's stub and records the opened `D…` ID as the
 *     entry's conversation.
 *   - A click on D's DM prompt is decided once and makes exactly one
 *     `chat.update` on that `D…` conversation and ts, through D's client only.
 *   - With D's applied persona then switched to DMs off and a channel
 *     destination, the click still makes that one update in the DM and
 *     nothing else: no post, no `conversations.open` (an update is not a post).
 *   - A's channel prompt and D's DM prompt, clicked in one run, each update
 *     through their own client.
 *   - In-place changes (E12): with B's channel dropped from `channels` and
 *     its destination moved, or D's `dm.contact` changed, a click on the
 *     prompt posted before the change still makes its one update where it
 *     was posted, through the persona's client, with no post and no open;
 *     A's prompt clicked in the same run is unaffected.
 *
 * SPDX-License-Identifier: MIT
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { ErrSystemInstallDisappeared, ErrTmuxNotAvailable, type Client, type DecideParams, type DecideResult } from 'agent-director'
import { handlePermissionClick, type ClickDeps } from '../src/permission-click-handler.ts'
import { encodePermissionActionId } from '../src/permission-action-id.ts'
import { REDACTED_TOKEN_PLACEHOLDER, REDACTED_URL_PLACEHOLDER } from '../src/slack-log-redaction.ts'
import { personaKeyFromActionId } from './test-helpers/action-id-key.ts'
import {
  _resetPollerState,
  getLivePermission,
  stopPermissionPoller,
} from '../src/permission-poller.ts'
import { _resetTrailFdForTests } from '../src/permission-trail.ts'
import type { Persona } from '../src/config.ts'
import { personaInstanceId, renderPersonaRef } from '../src/persona-identity.ts'
import {
  cannedGetResultPlural,
  cannedListRow,
  cannedPermissionRequest,
  errAlreadyDecided,
  errAmbiguousRequest,
  errGeneric,
  errInvalidFlags,
  errRelayFallenBack,
} from './test-helpers/agent-director-stub.ts'
import { makeMultiPersonaConfig } from './test-helpers/persona-config.ts'
import { makeStubSlack, openedDm, type StubSlack } from './test-helpers/slack-stub.ts'
import { APP_TOKEN_PREFIX, BOT_TOKEN_PREFIX, LEAK_SENTINEL, assertNoLeak, fakeToken } from './test-helpers/credentials.ts'
import {
  makePersonaClients,
  makeTrailCapture,
  posts,
  slackCalls,
  startManualPoller,
  updates as updatesOn,
  type ManualInterval,
  type PersonaClients,
} from './test-helpers/permission-relay-harness.ts'
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

// ---------------------------------------------------------------------------
// Shared fixtures — no inline magic strings (SR-8.1)
// ---------------------------------------------------------------------------

/** Persona A's name; its key (hashed form) differs from its destination channel. */
const PERSONA_A_NAME = 'Ops Review Bot'
/** Persona B's name. */
const PERSONA_B_NAME = 'Build Bot'
/** Persona A's destination (`permission_prompts`) channel. */
const CHANNEL_A = 'C0OPSREVIEW'
/** Persona B's destination channel. */
const CHANNEL_B = 'C0BUILDBOT'
/** Persona D's name: DMs on, prompts to its DM with its contact. */
const PERSONA_D_NAME = 'Inbox Bot'
/** Persona D's one channel; its prompt destination once DMs are turned off. */
const CHANNEL_D = 'C0INBOXBOT'
/** Persona D's `dm.contact`. */
const CONTACT_D = 'U0OPERATOR1'
/** The DM conversation `conversations.open` returns for D's contact. */
const DM_D = 'D0INBOXDM1'
/** B's only channel and destination after an in-place change moves it off CHANNEL_B. */
const CHANNEL_B_MOVED = 'C0BUILDNEW'
/** D's `dm.contact` after an in-place change. */
const CONTACT_D_MOVED = 'U0OPERATOR2'
const TOKEN_A = '11111111-1111-4111-8111-111111111111'
const TOKEN_B = '22222222-2222-4222-8222-222222222222'
const TOKEN_C = '33333333-3333-4333-8333-333333333333'
/** A key naming no applied persona. */
const UNKNOWN_KEY = 'no_such_persona'

const ALLOWED_TEXT = '*Permission* — Allowed'
const DENIED_TEXT = '*Permission* — Denied by operator'
const RELAY_FALLEN_BACK_TEXT =
  '*Permission* — relay window elapsed; answer this prompt at the session\'s tmux pane'

// ---------------------------------------------------------------------------
// Two-persona harness
// ---------------------------------------------------------------------------

interface Harness {
  dir: string
  personaA: Persona
  personaB: Persona
  /** DMs on, `dm.contact` set, prompts to its DM (`permission_prompts: 'dm'`). */
  personaD: Persona
  instanceA: string
  instanceB: string
  instanceD: string
  stubA: StubSlack
  stubB: StubSlack
  stubD: StubSlack
  /** Each persona's own stub client; `setUnavailable` makes one unavailable, `calls` records every key asked for. */
  clients: PersonaClients
  /** Every key `getPersona` was asked for, in order. */
  getPersonaCalls: string[]
  getPersona: (key: string) => Persona | undefined
  /** Replace the applied persona with this key, as a reload would (read by `getPersona` from then on). */
  applyPersona: (persona: Persona) => void
}

let h: Harness

function makeHarness(): Harness {
  const dir = mkdtempSync(join(tmpdir(), 'click-persona-'))
  const config = makeMultiPersonaConfig(
    [
      { name: PERSONA_A_NAME, channels: [{ id: CHANNEL_A, delivery: 'all' }] },
      { name: PERSONA_B_NAME, channels: [{ id: CHANNEL_B, delivery: 'all' }] },
      {
        name: PERSONA_D_NAME,
        channels: [{ id: CHANNEL_D, delivery: 'all' }],
        dm: { enabled: true, contact: CONTACT_D },
        permission_prompts: 'dm',
      },
    ],
    dir,
  )
  const [personaA, personaB, personaD] = config.personas as [Persona, Persona, Persona]
  // Scripted Slack failures carry the sentinel wherever a real error can hold secrets.
  const stubA = makeStubSlack({ leakMarker: LEAK_SENTINEL })
  const stubB = makeStubSlack({ leakMarker: LEAK_SENTINEL })
  const stubD = makeStubSlack({ leakMarker: LEAK_SENTINEL })
  const stubs = new Map([[personaA.key, stubA], [personaB.key, stubB], [personaD.key, stubD]])
  const clients = makePersonaClients((key) => stubs.get(key))
  const byKey = new Map(config.personas.map((p) => [p.key, p]))
  const getPersonaCalls: string[] = []
  return {
    dir,
    personaA,
    personaB,
    personaD,
    instanceA: personaInstanceId(personaA.key),
    instanceB: personaInstanceId(personaB.key),
    instanceD: personaInstanceId(personaD.key),
    stubA,
    stubB,
    stubD,
    clients,
    getPersonaCalls,
    getPersona: (key) => { getPersonaCalls.push(key); return byKey.get(key) },
    applyPersona: (persona) => { byKey.set(persona.key, persona) },
  }
}

/**
 * Click-handler deps for persona A receiving the click, through the
 * harness's `clientFor` / `getPersona`. Overrides win (an explicit
 * `receivingPersonaKey: undefined` clears the receiving key).
 */
function clickDeps(overrides: Partial<ClickDeps> = {}): ClickDeps {
  return {
    receivingPersonaKey: h.personaA.key,
    clientFor: h.clients.clientFor,
    getPersona: h.getPersona,
    ...overrides,
  }
}

beforeEach(() => {
  _resetTrailFdForTests()
  h = makeHarness()
  // Initialize outage-state so withOutageDetection (used in the poller) does
  // not throw during seedLiveEntry ticks. Per-test calls to initOutageState
  // below override this with the decide-stub for click-handler assertions.
  initOutageState({ getClient: () => ({} as unknown as Client), notify: () => {} })
})

afterEach(() => {
  stopPermissionPoller()
  _resetPollerState()
  _resetOutageState()
  rmSync(h.dir, { recursive: true, force: true })
})

/**
 * Run one poller tick over one `check_permission` spawn per `[persona,
 * requests]` pair, as a spawn of that persona writes it, whose open rows are
 * `requests`. The poller posts each prompt through the persona's client (the
 * harness stub) to its destination (its channel, or its DM, opened first) and
 * records the live entries.
 */
async function runSeedTick(
  spawns: Array<[Persona, ReturnType<typeof cannedPermissionRequest>[]]>,
): Promise<ManualInterval[]> {
  const getClient = () => ({
    list: async () => ({
      spawns: spawns.map(([persona]) => cannedListRow({ state: 'check_permission' }, persona, h.dir)),
    }),
    get: async ({ claude_instance_id }: { claude_instance_id: string }) => {
      const [persona, requests] = spawns.find(([p]) => personaInstanceId(p.key) === claude_instance_id)!
      return cannedGetResultPlural(
        { state: 'check_permission', permission_requests: requests },
        persona,
        h.dir,
      )
    },
  })
  initOutageState({ getClient: () => getClient() as unknown as Client, notify: () => {} })
  const ivl = startManualPoller({ getClient: getClient as never, clientFor: h.clients.clientFor, getPersona: h.getPersona })
  await ivl.tick()
  return ivl.pending
}

/**
 * Seed a single live entry under the composite key
 * (cscb_<persona key>, requestToken) by running one poller tick. The prompt
 * posts on the persona's stub; the click handler's updates then accumulate
 * on the same stub's `calls.update`.
 */
async function seedLiveEntry(opts: {
  persona?: Persona
  requestToken: string
  requestId?: number
}): Promise<{ pending: ManualInterval[] }> {
  const pending = await runSeedTick([[opts.persona ?? h.personaA, [
    cannedPermissionRequest({
      request_token: opts.requestToken,
      request_id: opts.requestId ?? 1,
    }),
  ]]])
  return { pending }
}

/**
 * Seed TWO live entries on persona A's spawn under different request_tokens.
 * Used to assert SR-4.5 sibling independence on click. Pins both tokens to
 * known constants so the test can target a specific sibling.
 */
async function seedTwoSiblings(opts: {
  tokenA: string
  tokenB: string
}): Promise<{ pending: ManualInterval[] }> {
  const pending = await runSeedTick([[h.personaA, [
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
  ]]])
  return { pending }
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

// ---------------------------------------------------------------------------
// Malformed action_id — parse first (SR-11)
// ---------------------------------------------------------------------------

describe('handlePermissionClick — non-matching action ids', () => {
  test('returns false on non-perm action id; no AD or chat call', async () => {
    const decide = makeDecideStub()
    initOutageState({ getClient: () => decide.client as unknown as Client, notify: () => {} })
    const logs: unknown[][] = []
    const handled = await handlePermissionClick(
      'some_other_action',
      clickDeps({ receivingPersonaKey: undefined, log: (...args) => { logs.push(args) } }),
    )
    expect(handled).toBe(false)
    expect(decide.calls).toHaveLength(0)
    expect(slackCalls(h.stubA)).toBe(0)
    expect(slackCalls(h.stubB)).toBe(0)
    // Parse first: no bypass log line, and the persona is never resolved.
    expect(logs).toHaveLength(0)
    expect(h.getPersonaCalls).toHaveLength(0)
    expect(h.clients.calls).toHaveLength(0)
  })

  test('returns false on perm action id missing the cscb_ prefix; no AD or chat call', async () => {
    const decide = makeDecideStub()
    initOutageState({ getClient: () => decide.client as unknown as Client, notify: () => {} })
    const logs: unknown[][] = []
    const handled = await handlePermissionClick(
      `perm_allow_NOT_CSCB_PREFIX_${TOKEN_A}`,
      clickDeps({ receivingPersonaKey: undefined, log: (...args) => { logs.push(args) } }),
    )
    expect(handled).toBe(false)
    expect(decide.calls).toHaveLength(0)
    expect(slackCalls(h.stubA)).toBe(0)
    expect(slackCalls(h.stubB)).toBe(0)
    expect(logs).toHaveLength(0)
    expect(h.getPersonaCalls).toHaveLength(0)
  })

  test('returns false on perm action id with non-UUID trailing segment', async () => {
    const decide = makeDecideStub()
    initOutageState({ getClient: () => decide.client as unknown as Client, notify: () => {} })
    const logs: unknown[][] = []
    const handled = await handlePermissionClick(
      `perm_allow_${h.instanceA}_42`,
      clickDeps({ receivingPersonaKey: undefined, log: (...args) => { logs.push(args) } }),
    )
    expect(handled).toBe(false)
    expect(decide.calls).toHaveLength(0)
    expect(slackCalls(h.stubA)).toBe(0)
    expect(slackCalls(h.stubB)).toBe(0)
    // Parse first: a malformed perm_ id never reaches the bypass log line.
    expect(logs).toHaveLength(0)
    expect(h.getPersonaCalls).toHaveLength(0)
  })

  test('a malformed perm_ id is not handled even when a receiving persona is known', async () => {
    const decide = makeDecideStub()
    initOutageState({ getClient: () => decide.client as unknown as Client, notify: () => {} })
    const handled = await handlePermissionClick(`perm_deny_${h.instanceA}_42`, clickDeps())
    expect(handled).toBe(false)
    expect(decide.calls).toHaveLength(0)
    expect(slackCalls(h.stubA)).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// Happy path — decide → chat.update → markHandled (AC 28)
// ---------------------------------------------------------------------------

describe('handlePermissionClick — happy path', () => {
  test('allow → decide(allow, request_token) → chat.update "Allowed" through A\'s client → markHandled', async () => {
    await seedLiveEntry({ requestToken: TOKEN_A })
    const entryBefore = getLivePermission(h.instanceA, TOKEN_A)
    expect(entryBefore).toBeDefined()
    const messageTs = entryBefore!.messageTs

    const decide = makeDecideStub()
    initOutageState({ getClient: () => decide.client as unknown as Client, notify: () => {} })
    const handled = await handlePermissionClick(
      encodePermissionActionId('allow', h.instanceA, TOKEN_A),
      clickDeps(),
    )

    expect(handled).toBe(true)
    expect(decide.calls).toHaveLength(1)
    expect(decide.calls[0]).toEqual({
      claude_instance_id: h.instanceA,
      decision: 'allow',
      // SR-4.1 / SR-7.2: request_token is unconditionally on the wire.
      request_token: TOKEN_A,
    } as DecideParams & { request_token: string })

    const updates = updatesOn(h.stubA)
    expect(updates).toHaveLength(1)
    expect(updates[0]!.channel).toBe(CHANNEL_A)
    expect(updates[0]!.ts).toBe(messageTs)
    expect(updates[0]!.text).toBe(ALLOWED_TEXT)
    // Nothing went through persona B's client.
    expect(slackCalls(h.stubB)).toBe(0)
    // The update was resolved through A's key.
    expect(h.clients.calls.at(-1)).toBe(h.personaA.key)

    expect(getLivePermission(h.instanceA, TOKEN_A)?.handled).toBe(true)
  })

  test('deny → decide(deny, request_token) → chat.update "Denied by operator" through A\'s client → markHandled', async () => {
    await seedLiveEntry({ requestToken: TOKEN_A })
    const messageTs = getLivePermission(h.instanceA, TOKEN_A)!.messageTs
    const decide = makeDecideStub()
    initOutageState({ getClient: () => decide.client as unknown as Client, notify: () => {} })

    await handlePermissionClick(
      encodePermissionActionId('deny', h.instanceA, TOKEN_A),
      clickDeps(),
    )

    expect(decide.calls).toHaveLength(1)
    expect(decide.calls[0]!.decision).toBe('deny')
    expect((decide.calls[0] as DecideParams & { request_token: string }).request_token).toBe(TOKEN_A)

    const updates = updatesOn(h.stubA)
    expect(updates).toHaveLength(1)
    expect(updates[0]!.channel).toBe(CHANNEL_A)
    expect(updates[0]!.ts).toBe(messageTs)
    expect(updates[0]!.text).toBe(DENIED_TEXT)
    expect(slackCalls(h.stubB)).toBe(0)
    expect(getLivePermission(h.instanceA, TOKEN_A)?.handled).toBe(true)
  })

  test('B\'s prompt clicked on B → updates through B\'s client only', async () => {
    await seedLiveEntry({ persona: h.personaB, requestToken: TOKEN_B })
    const messageTs = getLivePermission(h.instanceB, TOKEN_B)!.messageTs
    const updatesOnABefore = h.stubA.calls.update.length
    const decide = makeDecideStub()
    initOutageState({ getClient: () => decide.client as unknown as Client, notify: () => {} })

    await handlePermissionClick(
      encodePermissionActionId('allow', h.instanceB, TOKEN_B),
      clickDeps({ receivingPersonaKey: h.personaB.key }),
    )

    expect(decide.calls).toHaveLength(1)
    expect(decide.calls[0]!.claude_instance_id).toBe(h.instanceB)
    expect(h.stubB.calls.update).toHaveLength(1)
    expect(h.stubB.calls.update[0]!.channel).toBe(CHANNEL_B)
    expect(h.stubB.calls.update[0]!.ts).toBe(messageTs)
    expect(h.stubA.calls.update.length).toBe(updatesOnABefore)
    expect(slackCalls(h.stubA)).toBe(0)
    expect(getLivePermission(h.instanceB, TOKEN_B)?.handled).toBe(true)
  })

  test.each<[{ kind: 'platform'; error: string } | { kind: 'network' }, string]>([
    [{ kind: 'platform', error: 'message_not_found' }, 'message_not_found'],
    [{ kind: 'network' }, 'network_error'],
  ])('chat.update fails (%o) → markHandled NOT called; ok=false trail with the error class; one token-safe log line', async (outcome, errorClass) => {
    await seedLiveEntry({ requestToken: TOKEN_A })
    h.stubA.script.update.push(outcome)
    const decide = makeDecideStub()
    initOutageState({ getClient: () => decide.client as unknown as Client, notify: () => {} })

    const trail = makeTrailCapture()
    const logs: unknown[][] = []
    const result = await handlePermissionClick(
      encodePermissionActionId('allow', h.instanceA, TOKEN_A),
      clickDeps({ emitTrail: trail.emit, log: (...args: unknown[]) => logs.push(args) }),
    )

    expect(result).toBe(true)
    // decide still landed before chat.update was attempted.
    expect(decide.calls).toHaveLength(1)
    // chat.update was attempted once, through A's client, and failed.
    expect(h.stubA.calls.update).toHaveLength(1)
    expect(h.stubA.calls.update[0]!.channel).toBe(CHANNEL_A)
    // handled stays false — markHandled is only called on update success.
    const entry = getLivePermission(h.instanceA, TOKEN_A)
    expect(entry).toBeDefined()
    expect(entry?.handled).toBe(false)
    // b.emk: failures land in BOTH server.log (via logDeps) and the trail JSONL.
    const closure = trail.events.find(e => e.event === 'cscb.chat_update.attempted')
    expect(closure).toBeDefined()
    expect(closure!['ok']).toBe(false)
    expect(closure!['error']).toBe(errorClass)
    expect(closure!['triggered_by']).toBe('click_handler')
    // One line, token-safe (b.av2 SR-10.3): the platform reason, never the raw error.
    expect(logs).toHaveLength(1)
    expect(logs[0]).toHaveLength(1)
    const line = String(logs[0]![0])
    expect(line).toContain(`decision chat.update failed for ${h.instanceA}`)
    if (outcome.kind === 'platform') expect(line).toContain(`(reason=${outcome.error}): Error code=slack_webapi_platform_error`)
    else {
      expect(line).not.toContain('(reason=')
      expect(line).toContain(': Error code=slack_webapi_request_error')
    }
    assertNoLeak({ logs, trail: trail.events }, 'click update failure')
    // Persona B's client saw nothing.
    expect(slackCalls(h.stubB)).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// A prompt in a persona's DM — AC 29, AC 36 (b.av2 SR-7.1 DM part, SR-5.1 exception)
// ---------------------------------------------------------------------------

/**
 * Seed persona D's prompt for `requestToken` through a poller tick (alone, or
 * beside other spawns): the poller opens D's DM with its contact on D's stub,
 * which answers `DM_D`, and posts the prompt there. Returns D's live entry
 * and how many calls D's stub had logged by then.
 */
async function seedDmPrompt(
  requestToken: string,
  others: Array<[Persona, ReturnType<typeof cannedPermissionRequest>[]]> = [],
): Promise<{ entry: NonNullable<ReturnType<typeof getLivePermission>>; seedCalls: number }> {
  h.stubD.script.open.push(openedDm(DM_D))
  await runSeedTick([...others, [h.personaD, [cannedPermissionRequest({ request_token: requestToken })]]])
  // Precondition: the prompt lives in the opened DM, posted through D's client.
  expect(h.stubD.callLog.map((c) => c.method)).toEqual(['conversations.open', 'chat.postMessage'])
  expect(h.stubD.calls.conversationsOpen).toEqual([{ users: CONTACT_D }])
  expect(posts(h.stubD).map((p) => p.channel)).toEqual([DM_D])
  const entry = getLivePermission(h.instanceD, requestToken)!
  expect(entry.personaKey).toBe(h.personaD.key)
  expect(entry.channelId).toBe(DM_D)
  return { entry, seedCalls: h.stubD.callLog.length }
}

/** D as applied after DMs were turned off: the switch off and prompts to its channel. */
const withDmsOff = (persona: Persona): Persona => ({
  ...persona,
  dm: { enabled: false, contact: CONTACT_D },
  permission_prompts: CHANNEL_D,
})

describe('handlePermissionClick — a prompt in a persona\'s DM (AC 29, AC 36)', () => {
  test.each<{ label: string; change?: (p: Persona) => Persona }>([
    { label: 'AC 29: DMs on' },
    { label: 'AC 36: DMs turned off after the prompt was posted', change: withDmsOff },
    {
      label: '`dm.contact` changed in place after the prompt was posted',
      change: (p) => ({ ...p, dm: { enabled: true, contact: CONTACT_D_MOVED } }),
    },
  ])('$label → an allow click is decided once; exactly one chat.update on the DM conversation and ts through D\'s own client; no post, no conversations.open, no call on another client', async ({ change }) => {
    const { entry, seedCalls } = await seedDmPrompt(TOKEN_A)
    if (change) h.applyPersona(change(h.personaD))
    const decide = makeDecideStub()
    initOutageState({ getClient: () => decide.client as unknown as Client, notify: () => {} })
    const trail = makeTrailCapture()
    const logs: unknown[][] = []

    const result = await handlePermissionClick(
      encodePermissionActionId('allow', h.instanceD, TOKEN_A),
      clickDeps({ receivingPersonaKey: h.personaD.key, emitTrail: trail.emit, log: (...args) => { logs.push(args) } }),
      { channel: DM_D, messageTs: entry.messageTs, user: CONTACT_D },
    )

    expect(result).toBe(true)
    expect(decide.calls).toEqual([
      { claude_instance_id: h.instanceD, decision: 'allow', request_token: TOKEN_A } as DecideParams & { request_token: string },
    ])
    // D's client made exactly one call after the seed: the update, in the DM, at the prompt's ts.
    const clickCalls = h.stubD.callLog.slice(seedCalls)
    expect(clickCalls.map((c) => c.method)).toEqual(['chat.update'])
    const update = clickCalls[0]!.args as { channel: string; ts: string; text: string }
    expect(update.channel).toBe(entry.channelId)
    expect(update.channel).toBe(DM_D)
    expect(update.ts).toBe(entry.messageTs)
    expect(update.text).toBe(ALLOWED_TEXT)
    expect(h.clients.calls.at(-1)).toBe(h.personaD.key)
    // No other client saw anything.
    expect(h.stubA.callLog).toEqual([])
    expect(h.stubB.callLog).toEqual([])
    // The trail names the DM conversation, and the click posted nothing.
    const closure = trail.events.filter((e) => e.event === 'cscb.chat_update.attempted')
    expect(closure).toHaveLength(1)
    expect(closure[0]!.channel).toBe(DM_D)
    expect(closure[0]!['verdict_tag']).toBe('click_handler_allow')
    expect(closure[0]!['ok']).toBe(true)
    expect(trail.events.find((e) => e.event === 'cscb.chat_post.attempted')).toBeUndefined()
    expect(getLivePermission(h.instanceD, TOKEN_A)?.handled).toBe(true)
    // Nothing logged: a DMs-off refusal would add a line.
    expect(logs).toEqual([])
    assertNoLeak({ logs, trail: trail.events }, 'DM prompt click')
  })

  test('two personas: A\'s channel prompt and D\'s DM prompt, each clicked on its own connection → each update through its own client, in its own conversation', async () => {
    const { entry: entryD, seedCalls } = await seedDmPrompt(TOKEN_B, [
      [h.personaA, [cannedPermissionRequest({ request_token: TOKEN_A })]],
    ])
    const entryA = getLivePermission(h.instanceA, TOKEN_A)!
    expect(entryA.channelId).toBe(CHANNEL_A)
    const seedCallsA = h.stubA.callLog.length
    const decide = makeDecideStub()
    initOutageState({ getClient: () => decide.client as unknown as Client, notify: () => {} })

    await handlePermissionClick(
      encodePermissionActionId('deny', h.instanceD, TOKEN_B),
      clickDeps({ receivingPersonaKey: h.personaD.key }),
    )
    await handlePermissionClick(
      encodePermissionActionId('allow', h.instanceA, TOKEN_A),
      clickDeps({ receivingPersonaKey: h.personaA.key }),
    )

    expect(decide.calls.map((c) => c.claude_instance_id)).toEqual([h.instanceD, h.instanceA])
    expect(h.stubD.callLog.slice(seedCalls).map((c) => ({ method: c.method, args: c.args }))).toEqual([
      { method: 'chat.update', args: expect.objectContaining({ channel: DM_D, ts: entryD.messageTs, text: DENIED_TEXT }) },
    ])
    expect(h.stubA.callLog.slice(seedCallsA).map((c) => ({ method: c.method, args: c.args }))).toEqual([
      { method: 'chat.update', args: expect.objectContaining({ channel: CHANNEL_A, ts: entryA.messageTs, text: ALLOWED_TEXT }) },
    ])
    expect(h.stubB.callLog).toEqual([])
    expect(getLivePermission(h.instanceD, TOKEN_B)?.handled).toBe(true)
    expect(getLivePermission(h.instanceA, TOKEN_A)?.handled).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Prompts posted before an in-place change (E12; b.av2 SR-7.1, SR-5.1)
// ---------------------------------------------------------------------------

describe('handlePermissionClick — a prompt posted before an in-place change', () => {
  // An in-place change replaces the persona's applied entry (read by
  // `getPersona` at each click); a prompt posted before it stays where it was.
  // (D's DM prompt after a `dm.contact` change is a row of the DM table above.)
  test('B\'s channel prompt, after its channel leaves `channels` and `permission_prompts` names another channel → a click on its connection is decided once and makes one chat.update where the prompt was posted, through its own client; no post, no conversations.open', async () => {
    await runSeedTick([[h.personaB, [cannedPermissionRequest({ request_token: TOKEN_B })]]])
    const entry = getLivePermission(h.instanceB, TOKEN_B)!
    expect(entry.channelId).toBe(CHANNEL_B)
    const seedCalls = h.stubB.callLog.length

    h.applyPersona({ ...h.personaB, channels: [{ id: CHANNEL_B_MOVED, delivery: 'all' }], permission_prompts: CHANNEL_B_MOVED })
    const decide = makeDecideStub()
    initOutageState({ getClient: () => decide.client as unknown as Client, notify: () => {} })
    const trail = makeTrailCapture()
    const logs: unknown[][] = []

    await handlePermissionClick(
      encodePermissionActionId('allow', h.instanceB, TOKEN_B),
      clickDeps({ receivingPersonaKey: h.personaB.key, emitTrail: trail.emit, log: (...args) => { logs.push(args) } }),
      { channel: entry.channelId, messageTs: entry.messageTs },
    )

    expect(decide.calls).toEqual([
      { claude_instance_id: h.instanceB, decision: 'allow', request_token: TOKEN_B },
    ] as Array<DecideParams & { request_token: string }>)
    expect(h.stubB.callLog.slice(seedCalls).map((c) => ({ method: c.method, args: c.args }))).toEqual([
      { method: 'chat.update', args: expect.objectContaining({ channel: CHANNEL_B, ts: entry.messageTs, text: ALLOWED_TEXT }) },
    ])
    // No other persona's client saw anything, and the click path posted nothing.
    expect(h.stubA.callLog).toEqual([])
    expect(h.stubD.callLog).toEqual([])
    expect(trail.events.find((e) => e.event === 'cscb.chat_post.attempted')).toBeUndefined()
    expect(getLivePermission(h.instanceB, TOKEN_B)?.handled).toBe(true)
    // Nothing logged: a refused (posting-scope or instance) click would add a line.
    expect(logs).toEqual([])
    assertNoLeak({ logs, trail: trail.events }, 'in-place change click')
  })
})

// ---------------------------------------------------------------------------
// SR-4.1 / SR-7.2 — decide-wire invariant
// ---------------------------------------------------------------------------

describe('handlePermissionClick — decide-wire invariant (SR-4.1 / SR-7.2)', () => {
  test('every decide call carries a non-empty request_token matching the action_id', async () => {
    await seedLiveEntry({ requestToken: TOKEN_A })
    const decide = makeDecideStub()
    initOutageState({ getClient: () => decide.client as unknown as Client, notify: () => {} })
    await handlePermissionClick(
      encodePermissionActionId('allow', h.instanceA, TOKEN_A),
      clickDeps(),
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
    // The receiving persona resolves, so decide still fires.
    const decide = makeDecideStub()
    initOutageState({ getClient: () => decide.client as unknown as Client, notify: () => {} })
    const result = await handlePermissionClick(
      encodePermissionActionId('allow', h.instanceA, TOKEN_C),
      clickDeps({ log: () => { /* swallow */ } }),
      { channel: CHANNEL_A },
    )

    expect(result).toBe(true)
    // SR-4.2: decide STILL fires on stale clicks — AD is the source of truth.
    expect(decide.calls).toHaveLength(1)
    expect(decide.calls[0]).toEqual({
      claude_instance_id: h.instanceA,
      decision: 'allow',
      request_token: TOKEN_C,
    } as DecideParams & { request_token: string })
    // No chat.update from the click handler — the poller's reconciliation
    // tick surfaces the closure.
    expect(h.stubA.calls.update).toHaveLength(0)
    expect(h.stubB.calls.update).toHaveLength(0)
  })

  test('seeded entry on a DIFFERENT token → that other entry untouched; clicked token still fires decide', async () => {
    // Seed token A live; click token C (not in map). This makes sure the
    // composite-key lookup miss is taken on the click's token, not on the
    // claude_instance_id alone.
    await seedLiveEntry({ requestToken: TOKEN_A })
    const decide = makeDecideStub()
    initOutageState({ getClient: () => decide.client as unknown as Client, notify: () => {} })
    await handlePermissionClick(
      encodePermissionActionId('deny', h.instanceA, TOKEN_C),
      clickDeps({ log: () => { /* swallow */ } }),
      { channel: CHANNEL_A },
    )
    expect(decide.calls).toHaveLength(1)
    expect((decide.calls[0] as DecideParams & { request_token: string }).request_token).toBe(TOKEN_C)
    // The seeded sibling on TOKEN_A is untouched: no chat.update against
    // its messageTs, handled=false.
    expect(h.stubA.calls.update).toHaveLength(0)
    expect(h.stubB.calls.update).toHaveLength(0)
    expect(getLivePermission(h.instanceA, TOKEN_A)?.handled).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// SR-4.4 — decide-error handling
// ---------------------------------------------------------------------------

describe('handlePermissionClick — decide-error handling (SR-4.4)', () => {
  test('ErrAlreadyDecided → silent swallow: no chat.update, no markHandled, returns true', async () => {
    await seedLiveEntry({ requestToken: TOKEN_A })
    const decide = makeDecideStub({ throwOn: errAlreadyDecided() })
    initOutageState({ getClient: () => decide.client as unknown as Client, notify: () => {} })
    const logs: unknown[][] = []

    const result = await handlePermissionClick(
      encodePermissionActionId('allow', h.instanceA, TOKEN_A),
      clickDeps({ log: (...args: unknown[]) => logs.push(args) }),
    )

    expect(result).toBe(true)
    expect(decide.calls).toHaveLength(1)
    // SR-4.4: no chat.update from the click handler on ErrAlreadyDecided.
    expect(h.stubA.calls.update).toHaveLength(0)
    expect(h.stubB.calls.update).toHaveLength(0)
    // markHandled was NOT called: the entry remains pristine.
    expect(getLivePermission(h.instanceA, TOKEN_A)?.handled).toBe(false)
    // ErrAlreadyDecided is swallowed silently — no log fires.
    expect(logs).toHaveLength(0)
  })

  test('ErrInvalidFlags → logged once, no retry, no chat.update; returns true', async () => {
    await seedLiveEntry({ requestToken: TOKEN_A })
    const decide = makeDecideStub({ throwOn: errInvalidFlags() })
    initOutageState({ getClient: () => decide.client as unknown as Client, notify: () => {} })
    const logs: unknown[][] = []

    const result = await handlePermissionClick(
      encodePermissionActionId('allow', h.instanceA, TOKEN_A),
      clickDeps({ log: (...args: unknown[]) => logs.push(args) }),
    )

    expect(result).toBe(true)
    // exactly one decide attempt — no retry.
    expect(decide.calls).toHaveLength(1)
    // exactly one log entry.
    expect(logs).toHaveLength(1)
    // The log message names the failing errName.
    expect(String(logs[0]!.join(' '))).toContain('ErrInvalidFlags')
    // No chat.update from the click handler.
    expect(h.stubA.calls.update).toHaveLength(0)
    expect(h.stubB.calls.update).toHaveLength(0)
    // No markHandled mutation.
    expect(getLivePermission(h.instanceA, TOKEN_A)?.handled).toBe(false)
  })

  test('ErrAmbiguousRequest → logged once, no retry, no chat.update; returns true', async () => {
    await seedLiveEntry({ requestToken: TOKEN_A })
    const decide = makeDecideStub({ throwOn: errAmbiguousRequest() })
    initOutageState({ getClient: () => decide.client as unknown as Client, notify: () => {} })
    const logs: unknown[][] = []

    const result = await handlePermissionClick(
      encodePermissionActionId('allow', h.instanceA, TOKEN_A),
      clickDeps({ log: (...args: unknown[]) => logs.push(args) }),
    )

    expect(result).toBe(true)
    expect(decide.calls).toHaveLength(1)
    expect(logs).toHaveLength(1)
    expect(String(logs[0]!.join(' '))).toContain('ErrAmbiguousRequest')
    expect(h.stubA.calls.update).toHaveLength(0)
    expect(h.stubB.calls.update).toHaveLength(0)
    expect(getLivePermission(h.instanceA, TOKEN_A)?.handled).toBe(false)
  })

  test('unknown (non-AgentDirectorError) → logged, no chat.update, returns true', async () => {
    await seedLiveEntry({ requestToken: TOKEN_A })
    const decide = makeDecideStub({ throwOn: new Error('something exploded') })
    initOutageState({ getClient: () => decide.client as unknown as Client, notify: () => {} })
    const logs: unknown[][] = []

    const result = await handlePermissionClick(
      encodePermissionActionId('allow', h.instanceA, TOKEN_A),
      clickDeps({ log: (...args: unknown[]) => logs.push(args) }),
    )

    expect(result).toBe(true)
    expect(decide.calls).toHaveLength(1)
    expect(logs).toHaveLength(1)
    expect(h.stubA.calls.update).toHaveLength(0)
    expect(h.stubB.calls.update).toHaveLength(0)
    expect(getLivePermission(h.instanceA, TOKEN_A)?.handled).toBe(false)
  })

  // AC 20 (b.av2 SR-10.3): the catch-all line logs the error's description
  // (type, safe code, frames), never the error itself or its message.
  /** A non-agent-director decide error whose message and properties carry fake tokens. */
  const sentinelDecideError = (): Error =>
    Object.assign(new Error(`socket closed ${fakeToken(BOT_TOKEN_PREFIX, 'msg')}`), {
      code: 'ECONNRESET',
      detail: fakeToken(APP_TOKEN_PREFIX, 'detail'),
      note: LEAK_SENTINEL,
    })

  /** Click allow on A's seeded prompt with decide rejecting `err`; returns the log calls and trail. */
  async function clickWithFailingDecide(err: Error): Promise<{ result: boolean; logs: unknown[][]; trail: ReturnType<typeof makeTrailCapture> }> {
    await seedLiveEntry({ requestToken: TOKEN_A })
    const decide = makeDecideStub({ throwOn: err })
    initOutageState({ getClient: () => decide.client as unknown as Client, notify: () => {} })
    const logs: unknown[][] = []
    const trail = makeTrailCapture()
    const result = await handlePermissionClick(
      encodePermissionActionId('allow', h.instanceA, TOKEN_A),
      clickDeps({ log: (...args: unknown[]) => logs.push(args), emitTrail: trail.emit }),
    )
    return { result, logs, trail }
  }

  // E13 Director decision 16: an agent-director errName is logged only when it
  // passes `isSafeIdentifier`; a token-shaped one falls back to the description.
  test.each([
    { label: 'a non-AgentDirectorError carrying fake tokens', makeErr: sentinelDecideError, desc: 'Error code=ECONNRESET at ' },
    {
      label: 'an AgentDirectorError with a token-shaped errName',
      makeErr: () => errGeneric('decide', fakeToken(BOT_TOKEN_PREFIX, 'errname'), 'transient'),
      desc: 'AgentDirectorError at ',
    },
  ])('AC 20: $label → one "decide failed" line naming its type and safe code only; no log line or Slack call leaks', async ({ makeErr, desc }) => {
    const { result, logs } = await clickWithFailingDecide(makeErr())

    expect(result).toBe(true)
    expect(logs).toHaveLength(1)
    expect(logs[0]).toHaveLength(1)
    expect(String(logs[0]![0])).toStartWith(`[slack] permission-click: decide failed for ${h.instanceA}: ${desc}`)
    expect(h.stubA.calls.update).toHaveLength(0)
    assertNoLeak({ logs, slack: h.stubA.web.callLog })
  })

  // AC 20 / E13 Director decision 16: the trail's raw_error_message
  // (SR-V-2.7) is recorded with URL-like and token-like text replaced, on
  // both the `other` branch and the ad/tmux carve-out.
  const redactableText = (): string => `via https://files.example.test/upload?id=7 ${fakeToken(APP_TOKEN_PREFIX, 'msg')}`
  test.each([
    { label: 'a non-AgentDirectorError', resultClass: 'other', makeErr: () => new Error(`socket closed ${redactableText()}`) },
    {
      label: 'ErrSystemInstallDisappeared (carve-out)',
      resultClass: 'ErrSystemInstallDisappeared',
      makeErr: () => new ErrSystemInstallDisappeared('decide', `/opt/ad ${redactableText()}`),
    },
    {
      label: 'ErrTmuxNotAvailable (carve-out)',
      resultClass: 'ErrTmuxNotAvailable',
      makeErr: () => new ErrTmuxNotAvailable('decide', 'ErrTmuxNotAvailable', `tmux not found ${redactableText()}`),
    },
  ])('AC 20: $label whose message holds a URL and a fake token → its cscb.ad_decide.attempted event records the message redacted', async ({ resultClass, makeErr }) => {
    const { logs, trail } = await clickWithFailingDecide(makeErr())

    const events = trail.events.filter((e) => e.event === 'cscb.ad_decide.attempted')
    expect(events).toHaveLength(1)
    expect(events[0]!['result_class']).toBe(resultClass)
    expect(String(events[0]!['raw_error_message'])).toContain(`via ${REDACTED_URL_PLACEHOLDER} ${REDACTED_TOKEN_PLACEHOLDER}`)
    assertNoLeak({ logs, trail: trail.events, slack: h.stubA.web.callLog })
  })
})

// ---------------------------------------------------------------------------
// b.qi1 — ErrRelayFallenBack (AD 0.10.0) surfaced, session untouched
// ---------------------------------------------------------------------------

describe('handlePermissionClick — ErrRelayFallenBack (b.qi1)', () => {
  test('repaints the prompt buttonless through A\'s client, emits the relay-fallen-back trail pair, and leaves the entry unhandled', async () => {
    await seedLiveEntry({ requestToken: TOKEN_A })
    const messageTs = getLivePermission(h.instanceA, TOKEN_A)!.messageTs
    const trail = makeTrailCapture()
    const decide = makeDecideStub({ throwOn: errRelayFallenBack() })
    initOutageState({ getClient: () => decide.client as unknown as Client, notify: () => {} })
    const logs: unknown[][] = []

    const result = await handlePermissionClick(
      encodePermissionActionId('allow', h.instanceA, TOKEN_A),
      clickDeps({
        emitTrail: trail.emit,
        log: (...args: unknown[]) => logs.push(args),
      }),
      { channel: CHANNEL_A },
    )

    expect(result).toBe(true)
    // Exactly one decide attempt — the window is closed, so re-deciding would
    // fail identically. No retry.
    expect(decide.calls).toHaveLength(1)

    // The operator's click is surfaced, not swallowed: one chat.update over
    // the original prompt message, carrying the pane-redirect text and no
    // actions block (the buttons are now inert).
    const updates = updatesOn(h.stubA)
    expect(updates).toHaveLength(1)
    expect(updates[0]!.channel).toBe(CHANNEL_A)
    expect(updates[0]!.ts).toBe(messageTs)
    expect(updates[0]!.text).toBe(RELAY_FALLEN_BACK_TEXT)
    const blocks = updates[0]!.blocks as Array<{ type: string }>
    expect(blocks.find((b) => b.type === 'actions')).toBeUndefined()
    // The repaint went through A's client only.
    expect(slackCalls(h.stubB)).toBe(0)

    // The decide attempt is classified, not bucketed into 'other'.
    const decided = trail.events.find((e) => e.event === 'cscb.ad_decide.attempted')
    expect(decided!['result_class']).toBe('ErrRelayFallenBack')
    expect('raw_error_message' in decided!).toBe(false)

    // The repaint is recorded under its own non-verdict tag.
    const closure = trail.events.find((e) => e.event === 'cscb.chat_update.attempted')
    expect(closure).toBeDefined()
    expect(closure!['verdict_tag']).toBe('click_handler_relay_fallen_back')
    expect(closure!['triggered_by']).toBe('click_handler')
    expect(closure!['ok']).toBe(true)
    expect(closure!.message_ts).toBe(messageTs)
    expect(closure!.request_token).toBe(TOKEN_A)
    expect(closure!.channel).toBe(CHANNEL_A)

    // markHandled is deliberately NOT called: this is not a verdict, so the
    // AD row stays open and a later poller closure may render over it.
    expect(getLivePermission(h.instanceA, TOKEN_A)?.handled).toBe(false)

    // Loud, not silent: the operator-facing repaint is accompanied by a log.
    expect(logs).toHaveLength(1)
    expect(String(logs[0]!.join(' '))).toContain('ErrRelayFallenBack')
  })

  test('stale click (no live entry) → decide fires once, no chat.update, returns true', async () => {
    const trail = makeTrailCapture()
    const decide = makeDecideStub({ throwOn: errRelayFallenBack() })
    initOutageState({ getClient: () => decide.client as unknown as Client, notify: () => {} })

    const result = await handlePermissionClick(
      encodePermissionActionId('deny', h.instanceA, TOKEN_C),
      clickDeps({
        emitTrail: trail.emit,
        log: () => { /* swallow */ },
      }),
      { channel: CHANNEL_A },
    )

    expect(result).toBe(true)
    expect(decide.calls).toHaveLength(1)
    // Nothing to repaint — there is no Slack message this handler owns.
    expect(h.stubA.calls.update).toHaveLength(0)
    expect(h.stubB.calls.update).toHaveLength(0)
    expect(trail.events.find((e) => e.event === 'cscb.chat_update.attempted')).toBeUndefined()
    const decided = trail.events.find((e) => e.event === 'cscb.ad_decide.attempted')
    expect(decided!['result_class']).toBe('ErrRelayFallenBack')
  })
})

// ---------------------------------------------------------------------------
// SR-4.5 — sibling independence on click
// ---------------------------------------------------------------------------

describe('handlePermissionClick — sibling independence (SR-4.5)', () => {
  test('two sibling rows seeded; clicking one updates only the clicked entry', async () => {
    await seedTwoSiblings({ tokenA: TOKEN_A, tokenB: TOKEN_B })

    const entryABefore = getLivePermission(h.instanceA, TOKEN_A)
    const entryBBefore = getLivePermission(h.instanceA, TOKEN_B)
    expect(entryABefore).toBeDefined()
    expect(entryBBefore).toBeDefined()
    expect(entryABefore!.messageTs).not.toBe(entryBBefore!.messageTs)
    const tsA = entryABefore!.messageTs
    const tsB = entryBBefore!.messageTs

    // Click sibling A.
    const decide = makeDecideStub()
    initOutageState({ getClient: () => decide.client as unknown as Client, notify: () => {} })
    await handlePermissionClick(
      encodePermissionActionId('allow', h.instanceA, TOKEN_A),
      clickDeps(),
    )

    // Exactly one decide call, carrying A's token.
    expect(decide.calls).toHaveLength(1)
    expect((decide.calls[0] as DecideParams & { request_token: string }).request_token).toBe(TOKEN_A)

    // Exactly one chat.update — against A's messageTs only.
    const updates = updatesOn(h.stubA)
    expect(updates).toHaveLength(1)
    expect(updates[0]!.ts).toBe(tsA)
    // No update targeted B's messageTs.
    expect(updates.find((u) => u.ts === tsB)).toBeUndefined()

    // A is markHandled; B is untouched.
    expect(getLivePermission(h.instanceA, TOKEN_A)?.handled).toBe(true)
    expect(getLivePermission(h.instanceA, TOKEN_B)?.handled).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Smoke: helper-only stubs reach reasonable round-trip behavior — guard rail
// against accidental regressions in the fixture helpers themselves.
// ---------------------------------------------------------------------------

describe('handlePermissionClick — helper sanity', () => {
  test('cannedGetResultPlural seed yields a getLivePermission entry under the composite key', async () => {
    await seedLiveEntry({ requestToken: TOKEN_A, requestId: 17 })
    const entry = getLivePermission(h.instanceA, TOKEN_A)
    expect(entry).toBeDefined()
    expect(entry?.claudeInstanceId).toBe(h.instanceA)
    expect(entry?.requestToken).toBe(TOKEN_A)
    expect(entry?.requestId).toBe(17)
    expect(entry?.handled).toBe(false)
  })

  test('the seed posts through A\'s stub to A\'s destination channel; keys differ from channel IDs', async () => {
    expect(h.personaA.key).not.toBe(CHANNEL_A)
    expect(h.personaB.key).not.toBe(CHANNEL_B)
    expect(h.instanceA).toBe(`cscb_${h.personaA.key}`)
    await seedLiveEntry({ requestToken: TOKEN_A })
    const entry = getLivePermission(h.instanceA, TOKEN_A)!
    expect(entry.personaKey).toBe(h.personaA.key)
    expect(entry.channelId).toBe(CHANNEL_A)
    expect(h.stubA.calls.postMessage).toHaveLength(1)
    expect(h.stubA.calls.postMessage[0]!.channel).toBe(CHANNEL_A)
    expect(slackCalls(h.stubB)).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// SR-V Epic 3 — cscb.chat_update.attempted (click-handler-triggered)
// ---------------------------------------------------------------------------

describe('trail events — cscb.chat_update.attempted (click-handler-triggered)', () => {
  test('Allow click → ok=true, verdict_tag=click_handler_allow, triggered_by=click_handler', async () => {
    await seedLiveEntry({ requestToken: TOKEN_A })
    const entry = getLivePermission(h.instanceA, TOKEN_A)!
    const trail = makeTrailCapture()
    const decide = makeDecideStub()
    initOutageState({ getClient: () => decide.client as unknown as Client, notify: () => {} })
    await handlePermissionClick(
      encodePermissionActionId('allow', h.instanceA, TOKEN_A),
      clickDeps({ emitTrail: trail.emit }),
    )
    const closure = trail.events.find(e => e.event === 'cscb.chat_update.attempted')
    expect(closure).toBeDefined()
    expect(closure!['verdict_tag']).toBe('click_handler_allow')
    expect(closure!['triggered_by']).toBe('click_handler')
    expect(closure!['ok']).toBe(true)
    // `channel` keeps its meaning: the entry's Slack channel, never the persona key.
    expect(closure!.channel).toBe(CHANNEL_A)
    expect(closure!.channel).not.toBe(h.personaA.key)
    expect(closure!.message_ts).toBe(entry.messageTs)
    expect(typeof closure!['text']).toBe('string')
    expect(Array.isArray(closure!['blocks'])).toBe(true)
    expect(closure!.request_token).toBe(TOKEN_A)
  })

  test('Deny click → ok=true, verdict_tag=click_handler_deny', async () => {
    await seedLiveEntry({ requestToken: TOKEN_A })
    const trail = makeTrailCapture()
    const decide = makeDecideStub()
    initOutageState({ getClient: () => decide.client as unknown as Client, notify: () => {} })
    await handlePermissionClick(
      encodePermissionActionId('deny', h.instanceA, TOKEN_A),
      clickDeps({ emitTrail: trail.emit }),
    )
    const closure = trail.events.find(e => e.event === 'cscb.chat_update.attempted')
    expect(closure!['verdict_tag']).toBe('click_handler_deny')
    expect(closure!['triggered_by']).toBe('click_handler')
    expect(closure!['ok']).toBe(true)
    expect(closure!.channel).toBe(CHANNEL_A)
  })

  test('request_token correlation: trail event request_token matches decoded action_id', async () => {
    await seedLiveEntry({ requestToken: TOKEN_C })
    const trail = makeTrailCapture()
    const decide = makeDecideStub()
    initOutageState({ getClient: () => decide.client as unknown as Client, notify: () => {} })
    await handlePermissionClick(
      encodePermissionActionId('allow', h.instanceA, TOKEN_C),
      clickDeps({ emitTrail: trail.emit }),
    )
    const closure = trail.events.find(e => e.event === 'cscb.chat_update.attempted')
    expect(closure!.request_token).toBe(TOKEN_C)
    expect(closure!.claude_instance_id).toBe(h.instanceA)
  })
})

// ---------------------------------------------------------------------------
// SR-V Epic 4 — cscb.click_handler.invoked
// ---------------------------------------------------------------------------

describe('trail events — cscb.click_handler.invoked', () => {
  const USER = 'U_OPERATOR'

  test('live_pending=true when a LivePermission entry exists at click time', async () => {
    await seedLiveEntry({ requestToken: TOKEN_A })
    const entry = getLivePermission(h.instanceA, TOKEN_A)!
    const trail = makeTrailCapture()
    const decide = makeDecideStub()
    initOutageState({ getClient: () => decide.client as unknown as Client, notify: () => {} })
    const actionId = encodePermissionActionId('allow', h.instanceA, TOKEN_A)
    await handlePermissionClick(
      actionId,
      clickDeps({ emitTrail: trail.emit }),
      { channel: CHANNEL_A, messageTs: entry.messageTs, user: USER },
    )
    const invoked = trail.events.find(e => e.event === 'cscb.click_handler.invoked')
    expect(invoked).toBeDefined()
    expect(invoked!['live_pending']).toBe(true)
    expect(invoked!['decision']).toBe('allow')
    expect(invoked!.claude_instance_id).toBe(h.instanceA)
    expect(invoked!.request_token).toBe(TOKEN_A)
    // `channel` keeps its meaning: the payload's Slack channel, never the persona key.
    expect(invoked!.channel).toBe(CHANNEL_A)
    expect(invoked!.channel).not.toBe(h.personaA.key)
    expect(invoked!.message_ts).toBe(entry.messageTs)
    expect(invoked!['user']).toBe(USER)
    expect(invoked!['raw_action_id']).toBe(actionId)
  })

  test('live_pending=false when no LivePermission entry exists at click time', async () => {
    // No seed — the live map is empty.
    const decide = makeDecideStub()
    initOutageState({ getClient: () => decide.client as unknown as Client, notify: () => {} })
    const trail = makeTrailCapture()
    const actionId = encodePermissionActionId('deny', h.instanceA, TOKEN_A)
    await handlePermissionClick(
      actionId,
      clickDeps({ emitTrail: trail.emit }),
      { channel: CHANNEL_A, messageTs: '0000.0000', user: USER },
    )
    const invoked = trail.events.find(e => e.event === 'cscb.click_handler.invoked')
    expect(invoked).toBeDefined()
    expect(invoked!['live_pending']).toBe(false)
    expect(invoked!['decision']).toBe('deny')
    expect(invoked!.claude_instance_id).toBe(h.instanceA)
    expect(invoked!.request_token).toBe(TOKEN_A)
    expect(invoked!.channel).toBe(CHANNEL_A)
  })

  test('decode failure path does NOT emit cscb.click_handler.invoked', async () => {
    const decide = makeDecideStub()
    initOutageState({ getClient: () => decide.client as unknown as Client, notify: () => {} })
    const trail = makeTrailCapture()
    const handled = await handlePermissionClick(
      'foreign_bot_action',
      clickDeps({ emitTrail: trail.emit }),
      { channel: CHANNEL_A, messageTs: '0.0', user: USER },
    )
    expect(handled).toBe(false)
    const invoked = trail.events.find(e => e.event === 'cscb.click_handler.invoked')
    expect(invoked).toBeUndefined()
    // Defense in depth: the decide call must also NOT fire on decode failure.
    expect(decide.calls).toHaveLength(0)
  })

  test('emitted once per call (no duplicate emissions per click)', async () => {
    await seedLiveEntry({ requestToken: TOKEN_A })
    const trail = makeTrailCapture()
    const decide = makeDecideStub()
    initOutageState({ getClient: () => decide.client as unknown as Client, notify: () => {} })
    await handlePermissionClick(
      encodePermissionActionId('allow', h.instanceA, TOKEN_A),
      clickDeps({ emitTrail: trail.emit }),
      { channel: CHANNEL_A, messageTs: 'TS', user: USER },
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
    await seedLiveEntry({ requestToken: TOKEN_A })
    const trail = makeTrailCapture()
    const decide = makeDecideStub()
    initOutageState({ getClient: () => decide.client as unknown as Client, notify: () => {} })
    await handlePermissionClick(
      encodePermissionActionId('allow', h.instanceA, TOKEN_A),
      clickDeps({ emitTrail: trail.emit }),
      { channel: CHANNEL_A, messageTs: 'TS', user: USER },
    )
    const event = trail.events.find(e => e.event === 'cscb.ad_decide.attempted')
    expect(event).toBeDefined()
    expect(event!['result_class']).toBe('ok')
    expect(event!['decision']).toBe('allow')
    expect(event!.claude_instance_id).toBe(h.instanceA)
    expect(event!.request_token).toBe(TOKEN_A)
    expect('raw_error_message' in event!).toBe(false)
  })

  test('happy path → submitted decision recorded for deny', async () => {
    await seedLiveEntry({ requestToken: TOKEN_A })
    const trail = makeTrailCapture()
    const decide = makeDecideStub()
    initOutageState({ getClient: () => decide.client as unknown as Client, notify: () => {} })
    await handlePermissionClick(
      encodePermissionActionId('deny', h.instanceA, TOKEN_A),
      clickDeps({ emitTrail: trail.emit }),
      { channel: CHANNEL_A, messageTs: 'TS', user: USER },
    )
    const event = trail.events.find(e => e.event === 'cscb.ad_decide.attempted')
    expect(event!['decision']).toBe('deny')
    expect(event!['result_class']).toBe('ok')
  })

  test('ErrAlreadyDecided → result_class="ErrAlreadyDecided", no raw_error_message', async () => {
    await seedLiveEntry({ requestToken: TOKEN_A })
    const trail = makeTrailCapture()
    const decide = makeDecideStub({ throwOn: errAlreadyDecided() })
    initOutageState({ getClient: () => decide.client as unknown as Client, notify: () => {} })
    await handlePermissionClick(
      encodePermissionActionId('allow', h.instanceA, TOKEN_A),
      clickDeps({ emitTrail: trail.emit }),
      { channel: CHANNEL_A, messageTs: 'TS', user: USER },
    )
    const event = trail.events.find(e => e.event === 'cscb.ad_decide.attempted')
    expect(event!['result_class']).toBe('ErrAlreadyDecided')
    expect('raw_error_message' in event!).toBe(false)
  })

  test('ErrInvalidFlags → result_class="ErrInvalidFlags", no raw_error_message', async () => {
    await seedLiveEntry({ requestToken: TOKEN_A })
    const trail = makeTrailCapture()
    const decide = makeDecideStub({ throwOn: errInvalidFlags() })
    initOutageState({ getClient: () => decide.client as unknown as Client, notify: () => {} })
    await handlePermissionClick(
      encodePermissionActionId('allow', h.instanceA, TOKEN_A),
      clickDeps({ emitTrail: trail.emit, log: () => { /* swallow */ } }),
      { channel: CHANNEL_A, messageTs: 'TS', user: USER },
    )
    const event = trail.events.find(e => e.event === 'cscb.ad_decide.attempted')
    expect(event!['result_class']).toBe('ErrInvalidFlags')
    expect('raw_error_message' in event!).toBe(false)
  })

  test('ErrAmbiguousRequest → result_class="ErrAmbiguousRequest", no raw_error_message', async () => {
    await seedLiveEntry({ requestToken: TOKEN_A })
    const trail = makeTrailCapture()
    const decide = makeDecideStub({ throwOn: errAmbiguousRequest() })
    initOutageState({ getClient: () => decide.client as unknown as Client, notify: () => {} })
    await handlePermissionClick(
      encodePermissionActionId('allow', h.instanceA, TOKEN_A),
      clickDeps({ emitTrail: trail.emit, log: () => { /* swallow */ } }),
      { channel: CHANNEL_A, messageTs: 'TS', user: USER },
    )
    const event = trail.events.find(e => e.event === 'cscb.ad_decide.attempted')
    expect(event!['result_class']).toBe('ErrAmbiguousRequest')
    expect('raw_error_message' in event!).toBe(false)
  })

  test('generic Error → result_class="other" with raw_error_message', async () => {
    await seedLiveEntry({ requestToken: TOKEN_A })
    const trail = makeTrailCapture()
    const decide = makeDecideStub({ throwOn: new Error('network timeout') })
    initOutageState({ getClient: () => decide.client as unknown as Client, notify: () => {} })
    await handlePermissionClick(
      encodePermissionActionId('allow', h.instanceA, TOKEN_A),
      clickDeps({ emitTrail: trail.emit, log: () => { /* swallow */ } }),
      { channel: CHANNEL_A, messageTs: 'TS', user: USER },
    )
    const event = trail.events.find(e => e.event === 'cscb.ad_decide.attempted')
    expect(event!['result_class']).toBe('other')
    expect(event!['raw_error_message']).toBe('network timeout')
  })

  test('request_token correlates with click_handler.invoked from Epic 4', async () => {
    await seedLiveEntry({ requestToken: TOKEN_B })
    const trail = makeTrailCapture()
    const decide = makeDecideStub()
    initOutageState({ getClient: () => decide.client as unknown as Client, notify: () => {} })
    await handlePermissionClick(
      encodePermissionActionId('allow', h.instanceA, TOKEN_B),
      clickDeps({ emitTrail: trail.emit }),
      { channel: CHANNEL_A, messageTs: 'TS', user: USER },
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
// Epic 5 — wrapper outage short-circuit, keyed by persona (b.av2 SR-7.1)
// ---------------------------------------------------------------------------

describe('handlePermissionClick — wrapper outage short-circuit', () => {
  test('ErrSystemInstallDisappeared → ad-unreachable flag raised under A\'s key; no per-event logDeps call; returns true', async () => {
    const BINARY = '/usr/local/bin/agent-director'
    const err = new ErrSystemInstallDisappeared('spawn', BINARY)
    const decide = makeDecideStub({ throwOn: err })
    await seedLiveEntry({ requestToken: TOKEN_A })
    const notices: Array<{ key: string; text: string }> = []
    initOutageState({
      getClient: () => decide.client as unknown as Client,
      notify: (key, text) => { notices.push({ key, text }) },
    })
    const logCalls: unknown[][] = []
    const handled = await handlePermissionClick(
      encodePermissionActionId('allow', h.instanceA, TOKEN_A),
      clickDeps({ log: (...args) => { logCalls.push(args) } }),
      { channel: CHANNEL_A },
    )
    expect(handled).toBe(true)
    // The wrapper raised ad-unreachable under the persona key...
    expect(getOutageFlags(h.personaA.key).has('ad-unreachable')).toBe(true)
    // ...and nothing under the channel ID or the other persona.
    expect(getOutageFlags(CHANNEL_A).size).toBe(0)
    expect(getOutageFlags(h.personaB.key).size).toBe(0)
    // The onset notice is addressed to A's key.
    expect(notices.map((n) => n.key)).toEqual([h.personaA.key])
    // The per-event logDeps branch (ErrInvalidFlags / ErrAmbiguousRequest / generic log)
    // must NOT fire — the ad/tmux short-circuit returns before those branches.
    expect(logCalls).toHaveLength(0)
    expect(h.stubA.calls.update).toHaveLength(0)
    expect(slackCalls(h.stubB)).toBe(0)
  })

  test('carve-out trail entry carries result_class=ErrSystemInstallDisappeared + raw_error_message', async () => {
    const BINARY = '/usr/local/bin/agent-director'
    const err = new ErrSystemInstallDisappeared('spawn', BINARY)
    const decide = makeDecideStub({ throwOn: err })
    await seedLiveEntry({ requestToken: TOKEN_A })
    initOutageState({ getClient: () => decide.client as unknown as Client, notify: () => {} })
    const trail = makeTrailCapture()
    await handlePermissionClick(
      encodePermissionActionId('allow', h.instanceA, TOKEN_A),
      clickDeps({ emitTrail: trail.emit }),
      { channel: CHANNEL_A },
    )
    // Exactly one cscb.ad_decide.attempted entry should land — the carve-out
    // emits before the early return. result_class names the typed AD error
    // (not the generic 'other' bucket); raw_error_message preserves the
    // forensic context the loud Slack alert can't carry by itself.
    const adDecides = trail.events.filter(e => e['event'] === 'cscb.ad_decide.attempted')
    expect(adDecides).toHaveLength(1)
    expect(adDecides[0]!['result_class']).toBe('ErrSystemInstallDisappeared')
    expect(adDecides[0]!['raw_error_message']).toBe(err.message)
    expect(adDecides[0]!['claude_instance_id']).toBe(h.instanceA)
    expect(adDecides[0]!['request_token']).toBe(TOKEN_A)
    expect(getOutageFlags(h.personaA.key).has('ad-unreachable')).toBe(true)
    expect(getOutageFlags(CHANNEL_A).size).toBe(0)
  })

  test('carve-out trail entry for ErrTmuxNotAvailable: result_class=ErrTmuxNotAvailable + raw_error_message; flag under A\'s key', async () => {
    const ErrTmuxCtor = (await import('agent-director')).ErrTmuxNotAvailable
    const err = new ErrTmuxCtor('spawn', 'ErrTmuxNotAvailable', 'tmux not found on PATH')
    const decide = makeDecideStub({ throwOn: err })
    await seedLiveEntry({ requestToken: TOKEN_A })
    const notices: Array<{ key: string; text: string }> = []
    initOutageState({
      getClient: () => decide.client as unknown as Client,
      notify: (key, text) => { notices.push({ key, text }) },
    })
    const trail = makeTrailCapture()
    await handlePermissionClick(
      encodePermissionActionId('allow', h.instanceA, TOKEN_A),
      clickDeps({ emitTrail: trail.emit }),
      { channel: CHANNEL_A },
    )
    const adDecides = trail.events.filter(e => e['event'] === 'cscb.ad_decide.attempted')
    expect(adDecides).toHaveLength(1)
    expect(adDecides[0]!['result_class']).toBe('ErrTmuxNotAvailable')
    expect(adDecides[0]!['raw_error_message']).toBe(err.message)
    expect(getOutageFlags(h.personaA.key).has('tmux-unavailable')).toBe(true)
    expect(getOutageFlags(CHANNEL_A).size).toBe(0)
    expect(getOutageFlags(h.personaB.key).size).toBe(0)
    expect(notices.map((n) => n.key)).toEqual([h.personaA.key])
  })
})

// ---------------------------------------------------------------------------
// Unresolvable receiving persona — log and bypass
// ---------------------------------------------------------------------------

describe('handlePermissionClick — log-and-bypass (unresolvable receiving persona)', () => {
  const GHOST_INSTANCE = personaInstanceId('ghost_persona')

  test.each([
    { label: 'no receiving key', instance: 'A', receiving: () => undefined },
    { label: 'an unknown receiving key', instance: 'A', receiving: () => UNKNOWN_KEY },
    {
      label: 'an instance id that maps to no applied persona',
      instance: 'ghost',
      receiving: (actionId: string) => personaKeyFromActionId(actionId),
    },
  ] as const)('$label → 0 decide calls, no Slack call, no outage flag, diagnostic log emitted', async ({ instance, receiving }) => {
    // A live prompt exists on A, and the payload names A's channel: neither
    // is enough to resolve the persona.
    await seedLiveEntry({ requestToken: TOKEN_A })
    const callsA = slackCalls(h.stubA)
    const clientForBefore = h.clients.calls.length
    const decide = makeDecideStub()
    initOutageState({ getClient: () => decide.client as unknown as Client, notify: () => {} })
    const logLines: string[] = []
    const instanceId = instance === 'A' ? h.instanceA : GHOST_INSTANCE
    const ACTION_ID = encodePermissionActionId('allow', instanceId, TOKEN_A)
    const handled = await handlePermissionClick(
      ACTION_ID,
      clickDeps({
        receivingPersonaKey: receiving(ACTION_ID),
        log: (...args) => { logLines.push(args.map(String).join(' ')) },
      }),
      { channel: CHANNEL_A },
    )
    expect(handled).toBe(true)
    expect(decide.calls).toHaveLength(0)
    // No Slack call through any persona's client.
    expect(slackCalls(h.stubA)).toBe(callsA)
    expect(slackCalls(h.stubB)).toBe(0)
    expect(h.clients.calls.length).toBe(clientForBefore)
    expect(getLivePermission(h.instanceA, TOKEN_A)?.handled).toBe(false)
    // No orphan outage flag under any key or channel, including '<unknown>'.
    for (const key of [h.personaA.key, h.personaB.key, CHANNEL_A, CHANNEL_B, UNKNOWN_KEY, 'ghost_persona', '<unknown>', 'undefined']) {
      expect(getOutageFlags(key).size).toBe(0)
    }
    // One diagnostic log line carrying the action_id and request_token.
    expect(logLines).toHaveLength(1)
    expect(logLines[0]).toContain(ACTION_ID)
    expect(logLines[0]).toContain(TOKEN_A)
  })
})

describe('handlePermissionClick — no channel anywhere, receiving persona known', () => {
  test('no live entry and no payload channel, received for applied A → exactly one decide with the token, no update, no bypass log line', async () => {
    const decide = makeDecideStub()
    initOutageState({ getClient: () => decide.client as unknown as Client, notify: () => {} })
    const logs: unknown[][] = []
    const handled = await handlePermissionClick(
      encodePermissionActionId('allow', h.instanceA, TOKEN_C),
      clickDeps({ log: (...args) => { logs.push(args) } }),
    )
    expect(handled).toBe(true)
    expect(decide.calls).toEqual([
      { claude_instance_id: h.instanceA, decision: 'allow', request_token: TOKEN_C } as DecideParams & { request_token: string },
    ])
    expect(slackCalls(h.stubA, h.stubB)).toBe(0)
    expect(logs).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// Mismatch — a click for B's instance received as A's fails closed (ENG-4)
// ---------------------------------------------------------------------------

describe('handlePermissionClick — instance / receiving persona mismatch (fail closed)', () => {
  test('click for cscb_<B key> delivered as A\'s → not decided, no chat.update, logged naming both keys', async () => {
    await seedLiveEntry({ persona: h.personaB, requestToken: TOKEN_B })
    const decide = makeDecideStub()
    initOutageState({ getClient: () => decide.client as unknown as Client, notify: () => {} })
    const trail = makeTrailCapture()
    const logLines: string[] = []
    const handled = await handlePermissionClick(
      encodePermissionActionId('allow', h.instanceB, TOKEN_B),
      clickDeps({
        receivingPersonaKey: h.personaA.key,
        emitTrail: trail.emit,
        log: (...args) => { logLines.push(args.map(String).join(' ')) },
      }),
      { channel: CHANNEL_A },
    )
    expect(handled).toBe(true)
    expect(decide.calls).toHaveLength(0)
    expect(h.stubA.calls.update).toHaveLength(0)
    expect(h.stubB.calls.update).toHaveLength(0)
    expect(getLivePermission(h.instanceB, TOKEN_B)?.handled).toBe(false)
    expect(trail.events.find((e) => e.event === 'cscb.ad_decide.attempted')).toBeUndefined()
    expect(trail.events.find((e) => e.event === 'cscb.chat_update.attempted')).toBeUndefined()
    for (const key of [h.personaA.key, h.personaB.key, CHANNEL_A, CHANNEL_B]) {
      expect(getOutageFlags(key).size).toBe(0)
    }
    expect(logLines).toHaveLength(1)
    expect(logLines[0]).toContain(h.personaA.key)
    expect(logLines[0]).toContain(h.personaB.key)
    expect(logLines[0]).toContain(renderPersonaRef(h.personaA.name, h.personaA.key))
    expect(logLines[0]).toContain(TOKEN_B)
  })
})

// ---------------------------------------------------------------------------
// Client unavailable — decide, but no update and no markHandled
// ---------------------------------------------------------------------------

describe('handlePermissionClick — persona client unavailable', () => {
  test.each(['allow', 'deny'] as const)('%s on A\'s live prompt with no client for A → decide once, no chat.update, no markHandled, one log line', async (decision) => {
    await seedLiveEntry({ requestToken: TOKEN_A })
    h.clients.setUnavailable(h.personaA.key)
    const decide = makeDecideStub()
    initOutageState({ getClient: () => decide.client as unknown as Client, notify: () => {} })
    const logLines: string[] = []
    const handled = await handlePermissionClick(
      encodePermissionActionId(decision, h.instanceA, TOKEN_A),
      clickDeps({ log: (...args) => { logLines.push(args.map(String).join(' ')) } }),
      { channel: CHANNEL_A },
    )
    expect(handled).toBe(true)
    expect(decide.calls).toHaveLength(1)
    expect(decide.calls[0]).toEqual({
      claude_instance_id: h.instanceA,
      decision,
      request_token: TOKEN_A,
    } as DecideParams & { request_token: string })
    expect(h.clients.calls.at(-1)).toBe(h.personaA.key)
    expect(h.stubA.calls.update).toHaveLength(0)
    expect(h.stubB.calls.update).toHaveLength(0)
    expect(slackCalls(h.stubB)).toBe(0)
    expect(getLivePermission(h.instanceA, TOKEN_A)?.handled).toBe(false)
    expect(logLines).toHaveLength(1)
    expect(logLines[0]).toContain(renderPersonaRef(h.personaA.name, h.personaA.key))
    expect(logLines[0]).toContain(TOKEN_A)
  })
})
