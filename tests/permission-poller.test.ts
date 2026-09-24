/**
 * permission-poller.test.ts — SR-2.1 / SR-2.4 / SR-5 / SR-8.4 poller behavior
 * under the plural-projection wire, composite-key live map, and verdict-
 * rendering newly-closed reconciliation, keyed by persona (b.av2 SR-7.1,
 * SR-7.2).
 *
 * Harness: a three-persona config (`makeMultiPersonaConfig`) with one
 * `makeStubSlack` stub per persona (leak marker on), handed to the poller
 * through `clientFor` (`makePersonaClients` from
 * `test-helpers/permission-relay-harness.ts`) and `getPersona`. Persona A works in one channel and sends prompts to a
 * second one (its `permission_prompts`); B has one channel that is also its
 * destination; D's destination is `dm`. Names, keys and channel IDs all
 * differ, so no assertion can pass by confusing a key with a channel ID.
 *
 * Coverage:
 *   - AC 28 / AC 31: a row labelled for A posts exactly once, on A's stub, to
 *     A's destination (not its first, work channel); no other stub is called;
 *     the live entry records the channel, ts and persona key; the buttons
 *     decode to `cscb_<A key>`.
 *   - Two personas in one tick route independently; a closure updates only
 *     through the posting persona's client, on the recorded channel and ts,
 *     even after the persona's destination changes.
 *   - Rows with no `persona` label, only the old `channel` label, or a
 *     persona the config doesn't have are logged and skipped before `get`.
 *   - A row whose persona is no longer applied keeps its live entry (no
 *     closing sweep), its wedge counter and its not-posted record; applied
 *     again, nothing is re-posted.
 *   - Slack failures (prompt post, wedge warning, closure update) are
 *     scripted on the stub: one token-safe log line with the platform
 *     reason, the error class in the trail, nothing leaks (b.av2 SR-10.3).
 *   - `dm` destination (until E7): logged once, no Slack call, no live entry.
 *   - Persona client unavailable: prompt logged once and retried; closure
 *     logged naming the persona (or its key once it is gone) and dropped;
 *     stuck-prompt warning unlatched and throttled.
 *   - Outage state keyed by the persona key, never the channel ID.
 *   - New row in `permission_requests` → posts Block Kit prompt + records
 *     live entry keyed on (claude_instance_id, request_token).
 *   - Two concurrent rows on a single tick → two distinct postMessage calls,
 *     two distinct map entries.
 *   - Repeat tick with the same plural projection → no duplicate postMessage,
 *     no map mutation (duplicate-tick no-op).
 *   - Empty `permission_requests` array → zero postMessage activity from
 *     the open-rows path; existing entries from prior ticks are reconciled
 *     via `getPermission` + verdict-distinct `chat.update` + drop (SR-2.4).
 *   - `null` / `undefined` open-rows → logs and skips, no state change.
 *   - Row disappearance → `getPermission` called for the disappeared token,
 *     verdict-distinct `chat.update` lands on that row's messageTs only,
 *     entry dropped from livePermissions (SR-2.4, SR-5.3).
 *   - SR-5.1 four verdict renderings: operator_allow, operator_deny,
 *     timeout, find_missing — each visually distinct.
 *   - SR-5.2 unknown `decision_reason` → fail-closed generic deny, log,
 *     no crash, sibling rows on the same tick still proceed.
 *   - SR-2.4 not-found (`ErrPermissionRequestNotFound`) → generic deny, log,
 *     drop, no retry on subsequent ticks.
 *   - Transient `getPermission` error → entry preserved, retried next tick.
 *   - SR-5.3 sibling independence on closure: chat.update targets only the
 *     disappeared row's messageTs; the sibling's entry + messageTs are
 *     untouched.
 *   - get() ErrSpawnNotFound → continue silently.
 *   - Skipped-tick observability (5+ consecutive in-flight ticks → warn).
 *   - buildPermissionBlocks emits the UUIDv4-anchored action_id shape.
 *   - Wedge detector (b.fae F4 / SR-7.2): one persona-named warning to the
 *     persona's destination through its client.
 *
 * SPDX-License-Identifier: MIT
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { Persona, PersonaConfig } from '../src/config.ts'
import {
  _resetPollerState,
  buildPermissionBlocks,
  dropPermission,
  getLivePermission,
  markHandled,
  startPermissionPoller,
  stopPermissionPoller,
  wedgeTripTicks,
  type PermissionRequestRow,
  type PollerDeps,
} from '../src/permission-poller.ts'
import { _resetTrailFdForTests } from '../src/permission-trail.ts'
import { parsePermissionActionId } from '../src/permission-action-id.ts'
import { personaKeyFromActionId } from './test-helpers/action-id-key.ts'
import { personaInstanceId, personaKey, renderPersonaRef } from '../src/persona-identity.ts'
import {
  cannedGetPermissionResponse,
  cannedGetResult,
  cannedListRow,
  cannedPermissionRequest,
  cannedTwoRowPluralProjection,
  defaultCannedRowCwd,
  errGeneric,
  errPermissionRequestNotFound,
  errSpawnNotFound,
  makeStubClient,
  type CannedGetResult,
} from './test-helpers/agent-director-stub.ts'
import { makeMultiPersonaConfig } from './test-helpers/persona-config.ts'
import { makeStubSlack, type StubSlack } from './test-helpers/slack-stub.ts'
import { LEAK_SENTINEL, assertNoLeak } from './test-helpers/credentials.ts'
import {
  makeManualInterval,
  makePersonaClients,
  makeTrailCapture,
  posts,
  slackCalls,
  startManualPoller,
  updates,
  type ManualIntervalControl,
  type PersonaClients,
  type TrailCapture,
} from './test-helpers/permission-relay-harness.ts'
import type { GetPermissionParams, GetPermissionResult } from '../src/agent-director-client.ts'
import {
  getClient as moduleGetClient,
  resetClientForTests,
  setClientForTests,
} from '../src/agent-director-client.ts'
import {
  ErrSystemInstallDisappeared,
} from 'agent-director'
import {
  _resetOutageState,
  getOutageFlags,
  initOutageState,
} from '../src/outage-state.ts'

// ---------------------------------------------------------------------------
// SLACK_STATE_DIR isolation — any default emitTrail in the poller would
// otherwise land on the operator's real ~/.claude/channels/slack/.
// ---------------------------------------------------------------------------

let trailTempDir: string
let origStateDir: string | undefined
let outageEmissions: Array<{ key: string; text: string }> = []

beforeAll(() => {
  trailTempDir = mkdtempSync(join(tmpdir(), 'poller-trail-isolation-'))
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

// Persona A works in A_WORK (its first channel) and sends prompts to A_DEST.
const NAME_A = 'Alpha Relay'
const KEY_A = personaKey(NAME_A)
const INSTANCE_A = personaInstanceId(KEY_A)
const A_WORK = 'C0AWORK001'
const A_DEST = 'C0ADEST001'
// Persona B has one channel, which is also its destination.
const NAME_B = 'Beta Relay'
const KEY_B = personaKey(NAME_B)
const INSTANCE_B = personaInstanceId(KEY_B)
const B_DEST = 'C0BDEST001'
// Persona D sends prompts by DM (logged only until E7).
const NAME_D = 'Delta Direct'
const KEY_D = personaKey(NAME_D)
const INSTANCE_D = personaInstanceId(KEY_D)
const D_WORK = 'C0DWORK001'
const D_CONTACT = 'U0DCONTACT1'

const POST_TS = 'TS1'
const POST_TS_2 = 'TS2'

// A handful of reusable UUIDv4-shaped tokens. CSCB treats them as opaque.
const TOKEN_A = '11111111-1111-4111-8111-111111111111'
const TOKEN_B = '22222222-2222-4222-8222-222222222222'

/** Temp dir for persona paths and the `home` the canned rows are computed against. */
let personaDir: string
/** The applied persona set `getPersona` reads on every call; a test may swap it. */
let config: PersonaConfig
let A: Persona
let B: Persona
let D: Persona
let stubA: StubSlack
let stubB: StubSlack
let stubD: StubSlack
/** The injected per-persona client lookup: each persona's own stub; a test may mark one unavailable. */
let clients: PersonaClients

beforeEach(() => {
  _resetTrailFdForTests()
  // Wire outage-state so withOutageDetection doesn't throw. Tests that use
  // the closure form in permission-poller (captures outer deps.getClient()
  // client) don't rely on outage-state's getClient for the actual AD call,
  // but the module must be initialised. A default makeStubClient() satisfies
  // the type; it is never invoked by the closure callbacks.
  outageEmissions = []
  setClientForTests(makeStubClient() as unknown as Parameters<typeof setClientForTests>[0])
  initOutageState({
    getClient: moduleGetClient,
    notify: (key, text) => { outageEmissions.push({ key, text }) },
  })

  personaDir = mkdtempSync(join(tmpdir(), 'poller-personas-'))
  config = makeMultiPersonaConfig(
    [
      {
        name: NAME_A,
        channels: [{ id: A_WORK, delivery: 'all' }, { id: A_DEST, delivery: 'mentions' }],
        permission_prompts: A_DEST,
      },
      { name: NAME_B, channels: [{ id: B_DEST, delivery: 'all' }] },
      {
        name: NAME_D,
        channels: [{ id: D_WORK, delivery: 'all' }],
        dm: { enabled: true, contact: D_CONTACT },
        permission_prompts: 'dm',
      },
    ],
    personaDir,
  )
  ;[A, B, D] = config.personas as [Persona, Persona, Persona]
  // Every scripted Slack failure carries the sentinel wherever a real error
  // can hold secrets, so a failure path that logs the raw error fails assertNoLeak.
  stubA = makeStubSlack({ leakMarker: LEAK_SENTINEL })
  stubB = makeStubSlack({ leakMarker: LEAK_SENTINEL })
  stubD = makeStubSlack({ leakMarker: LEAK_SENTINEL })
  clients = makePersonaClients((key) => (key === KEY_A ? stubA : key === KEY_B ? stubB : key === KEY_D ? stubD : undefined))
})

afterEach(() => {
  stopPermissionPoller()
  _resetPollerState()
  resetClientForTests()
  _resetOutageState()
  rmSync(personaDir, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// Test plumbing: the persona lookup, the poller start, Slack scripts, log reads
// ---------------------------------------------------------------------------

/** The injected persona lookup; reads `config` on every call. */
const getPersona = (key: string): Persona | undefined => config.personas.find((p) => p.key === key)

/** Remove persona `key` from the applied set (a reload that drops it). */
function unapply(key: string): void {
  config = { ...config, personas: config.personas.filter((p) => p.key !== key) }
}

/** Start the poller with the persona lookups and a manual interval. */
function startPoller(
  getClient: PollerDeps['getClient'],
  opts: Partial<PollerDeps> = {},
): ManualIntervalControl {
  return startManualPoller({ getClient, clientFor: clients.clientFor, getPersona, ...opts })
}

/**
 * Script the `ts` each successive `chat.postMessage` on `stub` returns
 * (undefined → a response with no ts). Once exhausted, the stub generates one.
 */
function scriptPostTs(stub: StubSlack, ...tsSequence: Array<string | undefined>): void {
  for (const ts of tsSequence) stub.script.post.push({ kind: 'ok', result: { ts } })
}

const rowDecisions = (trail: TrailCapture, action: string) =>
  trail.events.filter((e) => e.event === 'cscb.poller.row_decision' && e['action'] === action)
const chatPosts = (trail: TrailCapture) => trail.events.filter((e) => e.event === 'cscb.chat_post.attempted')
const logLines = (logCalls: unknown[][], fragment: string) =>
  logCalls.filter((args) => String(args[0]).includes(fragment))

/**
 * A failed Slack call (b.av2 SR-10.3): exactly one log line carries
 * `fragment`; it names the platform reason for a platform error (and none for
 * a network error) and ends with the token-safe description; nothing in the
 * log calls or the trail carries the sentinel or a token.
 */
function expectTokenSafeFailure(
  logCalls: unknown[][],
  trail: TrailCapture,
  fragment: string,
  outcome: SlackFailureRow,
): void {
  const lines = logLines(logCalls, fragment)
  expect(lines).toHaveLength(1)
  expect(lines[0]).toHaveLength(1)
  const line = String(lines[0][0])
  if (outcome.kind === 'platform') expect(line).toContain(`(reason=${outcome.error}): Error code=slack_webapi_platform_error`)
  else {
    expect(line).not.toContain('(reason=')
    expect(line).toContain(': Error code=slack_webapi_request_error')
  }
  assertNoLeak({ logCalls, trail: trail.events }, 'slack failure')
}

/** The Slack failures each failed-call site is checked with. */
type SlackFailureRow = { kind: 'platform'; error: string } | { kind: 'network' }

/** A persona's spawn listed in check_permission, as a spawn of that persona writes it. */
const checkPermRow = (persona: Persona = A) =>
  cannedListRow({ state: 'check_permission' }, persona, personaDir)

/**
 * The persona's `get` result in check_permission. `permission_requests`
 * undefined omits the field entirely (the non-conforming shape).
 */
function getResult(permission_requests?: PermissionRequestRow[] | null, persona: Persona = A): CannedGetResult {
  return cannedGetResult(
    permission_requests === undefined
      ? { state: 'check_permission' }
      : { state: 'check_permission', permission_requests },
    persona,
    personaDir,
  )
}

// ---------------------------------------------------------------------------
// Block Kit builder
// ---------------------------------------------------------------------------

describe('buildPermissionBlocks (SR-2.2 action_id shape with request_token)', () => {
  test('emits perm_allow_<instance>_<token> and perm_deny_<instance>_<token>', () => {
    const blocks = buildPermissionBlocks('Bash', { command: 'rm -rf' }, INSTANCE_A, TOKEN_A) as Array<Record<string, unknown>>
    const actions = blocks[1] as { elements: Array<{ action_id: string }> }
    expect(actions.elements[0].action_id).toBe(`perm_allow_${INSTANCE_A}_${TOKEN_A}`)
    expect(actions.elements[1].action_id).toBe(`perm_deny_${INSTANCE_A}_${TOKEN_A}`)
  })
})

// ---------------------------------------------------------------------------
// Tick behavior — Case 1: new entry
// ---------------------------------------------------------------------------

describe('poller tick — Case 1: new entry', () => {
  test('AC 28 / AC 31: posts once through the persona\'s own client to its destination (not its first, work channel) and records the live entry with handled=false', async () => {
    scriptPostTs(stubA, POST_TS)
    const row = cannedPermissionRequest({ request_token: TOKEN_A, request_id: 7 })
    const ivl = startPoller(() => ({
      list: async () => ({ spawns: [checkPermRow()] }),
      get: async () => getResult([row]),
    }))

    expect(ivl.pending).toHaveLength(1)
    await ivl.tick()

    const live = getLivePermission(INSTANCE_A, TOKEN_A)
    expect(live).toBeDefined()
    expect(live?.channelId).toBe(A_DEST)
    expect(live?.messageTs).toBe(POST_TS)
    expect(live?.personaKey).toBe(KEY_A)
    expect(live?.requestToken).toBe(TOKEN_A)
    expect(live?.requestId).toBe(7)
    expect(live?.handled).toBe(false)

    // AC 31 precondition: the destination is not the first channel A lists.
    expect(A.channels[0]?.id).toBe(A_WORK)
    const postCalls = posts(stubA)
    expect(postCalls).toHaveLength(1)
    expect(postCalls[0].channel).toBe(A_DEST)
    expect(postCalls.some((c) => c.channel === A_WORK)).toBe(false)
    // No other persona's client is used.
    expect(slackCalls(stubB, stubD)).toBe(0)
    expect(stubA.calls.update).toHaveLength(0)

    // The buttons resolve through persona A.
    const actions = (postCalls[0].blocks as Array<Record<string, unknown>>).find((b) => b['type'] === 'actions') as
      { elements: Array<{ action_id: string }> }
    for (const el of actions.elements) {
      expect(parsePermissionActionId(el.action_id)?.claudeInstanceId).toBe(`cscb_${KEY_A}`)
      expect(personaKeyFromActionId(el.action_id)).toBe(KEY_A)
    }
  })

  test('falls back to raw-string on unparseable tool_input', async () => {
    scriptPostTs(stubA, POST_TS)
    const ivl = startPoller(() => ({
      list: async () => ({ spawns: [checkPermRow()] }),
      get: async () => getResult([cannedPermissionRequest({ request_token: TOKEN_A, tool_input: '{not json' })]),
    }), { log: () => { /* swallow warning */ } })
    await ivl.tick()
    expect(getLivePermission(INSTANCE_A, TOKEN_A)).toBeDefined()
  })

  test('get() ErrSpawnNotFound → skip silently, no entry recorded', async () => {
    const ivl = startPoller(() => ({
      list: async () => ({ spawns: [checkPermRow()] }),
      get: async () => { throw errSpawnNotFound() },
    }))
    await ivl.tick()
    expect(getLivePermission(INSTANCE_A, TOKEN_A)).toBeUndefined()
    expect(slackCalls(stubA, stubB, stubD)).toBe(0)
  })

  test('postMessage returns no ts → no live entry recorded', async () => {
    scriptPostTs(stubA, undefined)
    const ivl = startPoller(() => ({
      list: async () => ({ spawns: [checkPermRow()] }),
      get: async () => getResult([cannedPermissionRequest({ request_token: TOKEN_A })]),
    }), { log: () => { /* swallow */ } })
    await ivl.tick()
    expect(posts(stubA)).toHaveLength(1)
    expect(getLivePermission(INSTANCE_A, TOKEN_A)).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// Persona routing (b.av2 SR-7.1)
// ---------------------------------------------------------------------------

describe('poller tick — persona routing (b.av2 SR-7.1)', () => {
  test('two personas in one tick post on their own clients to their own destinations; a closure of A updates only through A', async () => {
    scriptPostTs(stubA, POST_TS)
    scriptPostTs(stubB, POST_TS_2)
    let aRows = [cannedPermissionRequest({ request_token: TOKEN_A, request_id: 1 })]
    const bRows = [cannedPermissionRequest({ request_token: TOKEN_B, request_id: 2 })]
    const ivl = startPoller(() => ({
      list: async () => ({ spawns: [checkPermRow(A), checkPermRow(B)] }),
      get: async (p: { claude_instance_id: string }) =>
        p.claude_instance_id === INSTANCE_A ? getResult(aRows, A) : getResult(bRows, B),
      getPermission: async (params: GetPermissionParams): Promise<GetPermissionResult> =>
        cannedGetPermissionResponse({ request_token: params.request_token, decision: 'allow', decision_reason: null }),
    }))

    await ivl.tick()
    expect(posts(stubA).map((c) => c.channel)).toEqual([A_DEST])
    expect(posts(stubB).map((c) => c.channel)).toEqual([B_DEST])
    expect(getLivePermission(INSTANCE_A, TOKEN_A)?.personaKey).toBe(KEY_A)
    expect(getLivePermission(INSTANCE_B, TOKEN_B)?.personaKey).toBe(KEY_B)
    expect(getLivePermission(INSTANCE_B, TOKEN_B)?.channelId).toBe(B_DEST)

    // A's request closes; B's stays open.
    aRows = []
    await ivl.tick()
    expect(updates(stubA)).toHaveLength(1)
    expect(updates(stubA)[0].channel).toBe(A_DEST)
    expect(updates(stubA)[0].ts).toBe(POST_TS)
    expect(stubB.calls.update).toHaveLength(0)
    expect(slackCalls(stubD)).toBe(0)
    expect(getLivePermission(INSTANCE_A, TOKEN_A)).toBeUndefined()
    expect(getLivePermission(INSTANCE_B, TOKEN_B)?.messageTs).toBe(POST_TS_2)
  })

  test('a closure after the persona\'s destination changes still updates the original message through its client; new prompts use the new destination', async () => {
    scriptPostTs(stubA, POST_TS, POST_TS_2)
    let rows = [cannedPermissionRequest({ request_token: TOKEN_A, request_id: 1 })]
    const ivl = startPoller(() => ({
      list: async () => ({ spawns: [checkPermRow()] }),
      get: async () => getResult(rows),
      getPermission: async (params: GetPermissionParams): Promise<GetPermissionResult> =>
        cannedGetPermissionResponse({ request_token: params.request_token, decision: 'allow', decision_reason: null }),
    }))
    await ivl.tick()
    expect(posts(stubA).map((c) => c.channel)).toEqual([A_DEST])

    // A's destination moves to its work channel in the supplied config.
    config = {
      ...config,
      personas: config.personas.map((p) => (p.key === KEY_A ? { ...p, permission_prompts: A_WORK } : p)),
    }
    rows = [cannedPermissionRequest({ request_token: TOKEN_B, request_id: 2 })]
    await ivl.tick()

    expect(updates(stubA)).toHaveLength(1)
    expect(updates(stubA)[0].channel).toBe(A_DEST)
    expect(updates(stubA)[0].ts).toBe(POST_TS)
    expect(posts(stubA).map((c) => c.channel)).toEqual([A_DEST, A_WORK])
    expect(slackCalls(stubB, stubD)).toBe(0)
  })

  test.each<[string, Record<string, string>, string]>([
    ['no persona label', { service: 'cscb' }, 'has no persona label'],
    // The old label names A's key, so a fallback to it would visibly get and post.
    ['only the old channel label', { service: 'cscb', channel: KEY_A }, 'has no persona label'],
    ['a persona the config does not have', { service: 'cscb', persona: 'ghost_persona' }, 'names no applied persona (persona=ghost_persona)'],
  ])('row with %s → logged with its instance ID and skipped: zero get calls, no post, no live entry, no orphan outage state', async (_name, labels, logFragment) => {
    const logCalls: unknown[][] = []
    const getCalls: unknown[] = []
    const ivl = startPoller(() => ({
      list: async () => ({
        spawns: [cannedListRow({ state: 'check_permission', labels }, A, personaDir)],
      }),
      get: async (params: unknown) => {
        getCalls.push(params)
        return getResult([cannedPermissionRequest({ request_token: TOKEN_A })])
      },
    }), { log: (...args) => { logCalls.push(args) } })
    await ivl.tick()

    expect(getCalls).toHaveLength(0)
    const skipLogs = logLines(logCalls, logFragment)
    expect(skipLogs).toHaveLength(1)
    expect(String(skipLogs[0][0])).toContain(INSTANCE_A)
    expect(getLivePermission(INSTANCE_A, TOKEN_A)).toBeUndefined()
    expect(slackCalls(stubA, stubB, stubD)).toBe(0)
    for (const key of ['<unknown>', KEY_A, A_DEST, 'ghost_persona']) {
      expect(getOutageFlags(key).size).toBe(0)
    }
    expect(outageEmissions).toHaveLength(0)
  })

  test('`dm` destination (until E7): logged once per open request naming the persona; no Slack call, no live entry, no post trail across repeat ticks', async () => {
    const logCalls: unknown[][] = []
    const trail = makeTrailCapture()
    const getPermissionCalls: GetPermissionParams[] = []
    let rows = [cannedPermissionRequest({ request_token: TOKEN_A, request_id: 1 })]
    const ivl = startPoller(() => ({
      list: async () => ({ spawns: [checkPermRow(D)] }),
      get: async () => getResult(rows, D),
      getPermission: async (params: GetPermissionParams): Promise<GetPermissionResult> => {
        getPermissionCalls.push(params)
        return cannedGetPermissionResponse({ request_token: params.request_token })
      },
    }), { log: (...args) => { logCalls.push(args) }, emitTrail: trail.emit })

    await ivl.tick()
    await ivl.tick()
    await ivl.tick()

    const dmLines = logLines(logCalls, 'permission prompts by DM are not supported yet')
    expect(dmLines).toHaveLength(1)
    expect(String(dmLines[0][0])).toContain(renderPersonaRef(NAME_D, KEY_D))
    expect(String(dmLines[0][0])).toContain(INSTANCE_D)
    expect(String(dmLines[0][0])).toContain(TOKEN_A)
    expect(slackCalls(stubA, stubB, stubD)).toBe(0)
    expect(getLivePermission(INSTANCE_D, TOKEN_A)).toBeUndefined()
    expect(rowDecisions(trail, 'post_attempted')).toHaveLength(0)
    expect(chatPosts(trail)).toHaveLength(0)

    // A new open request logs its own line; the gone one is never reconciled
    // (it was never tracked).
    rows = [cannedPermissionRequest({ request_token: TOKEN_B, request_id: 2 })]
    await ivl.tick()
    await ivl.tick()
    const after = logLines(logCalls, 'permission prompts by DM are not supported yet')
    expect(after).toHaveLength(2)
    expect(String(after[1][0])).toContain(TOKEN_B)
    expect(getPermissionCalls).toHaveLength(0)
    expect(slackCalls(stubA, stubB, stubD)).toBe(0)
  })

  test('client unavailable: prompt not posted, logged once across ticks, no live entry or post trail; posts once when the client returns', async () => {
    const logCalls: unknown[][] = []
    const trail = makeTrailCapture()
    clients.setUnavailable(KEY_A)
    scriptPostTs(stubA, POST_TS)
    const ivl = startPoller(() => ({
      list: async () => ({ spawns: [checkPermRow()] }),
      get: async () => getResult([cannedPermissionRequest({ request_token: TOKEN_A, request_id: 1 })]),
    }), { log: (...args) => { logCalls.push(args) }, emitTrail: trail.emit })

    await ivl.tick()
    await ivl.tick()
    await ivl.tick()
    const noClient = logLines(logCalls, 'no Slack client for')
    expect(noClient).toHaveLength(1)
    expect(String(noClient[0][0])).toContain(renderPersonaRef(NAME_A, KEY_A))
    expect(String(noClient[0][0])).toContain(TOKEN_A)
    expect(slackCalls(stubA, stubB, stubD)).toBe(0)
    expect(getLivePermission(INSTANCE_A, TOKEN_A)).toBeUndefined()
    expect(rowDecisions(trail, 'post_attempted')).toHaveLength(0)
    expect(chatPosts(trail)).toHaveLength(0)

    clients.setUnavailable(KEY_A, false)
    await ivl.tick()
    expect(posts(stubA).map((c) => c.channel)).toEqual([A_DEST])
    expect(getLivePermission(INSTANCE_A, TOKEN_A)?.messageTs).toBe(POST_TS)
    expect(rowDecisions(trail, 'post_attempted')).toHaveLength(1)
    expect(slackCalls(stubB, stubD)).toBe(0)
    await ivl.tick()
    expect(posts(stubA)).toHaveLength(1)
    expect(logLines(logCalls, 'no Slack client for')).toHaveLength(1)
  })

  test.each<[string, boolean, () => string]>([
    ['still applied', true, () => renderPersonaRef(NAME_A, KEY_A)],
    ['no longer applied', false, () => `persona=${KEY_A}`],
  ])('closure with the posting persona (%s) client unavailable: one log line naming it, entry dropped, no chat.update on any stub', async (_label, stillApplied, ref) => {
    const logCalls: unknown[][] = []
    const trail = makeTrailCapture()
    const getPermissionCalls: GetPermissionParams[] = []
    let listed = true
    const ivl = startPoller(() => ({
      list: async () => ({ spawns: listed ? [checkPermRow()] : [] }),
      get: async () => getResult([cannedPermissionRequest({ request_token: TOKEN_A, request_id: 1 })]),
      getPermission: async (params: GetPermissionParams): Promise<GetPermissionResult> => {
        getPermissionCalls.push(params)
        return cannedGetPermissionResponse({ request_token: params.request_token, decision: 'allow', decision_reason: null })
      },
    }), { log: (...args) => { logCalls.push(args) }, emitTrail: trail.emit })
    await ivl.tick()
    expect(getLivePermission(INSTANCE_A, TOKEN_A)).toBeDefined()

    // The spawn is gone (so its entry closes); the persona's client is unavailable.
    clients.setUnavailable(KEY_A)
    if (!stillApplied) unapply(KEY_A)
    listed = false
    await ivl.tick()
    expect(getPermissionCalls).toHaveLength(1)
    const skipped = logLines(logCalls, 'closure update for')
    expect(skipped).toHaveLength(1)
    expect(String(skipped[0][0])).toContain(`no Slack client for ${ref()} — closure update for ${INSTANCE_A} token=${TOKEN_A}`)
    expect(getLivePermission(INSTANCE_A, TOKEN_A)).toBeUndefined()
    expect(stubA.calls.update.length + stubB.calls.update.length + stubD.calls.update.length).toBe(0)
    expect(trail.events.filter((e) => e.event === 'cscb.chat_update.attempted')).toHaveLength(0)

    // Dropped: no retry on the next tick.
    await ivl.tick()
    expect(getPermissionCalls).toHaveLength(1)
    expect(logLines(logCalls, 'closure update for')).toHaveLength(1)
  })

  test('a row naming a persona no longer applied while its prompt is live: no get, no get-permission, no chat.update, entry kept, no reconciled_closed; re-applied, the prompt is not re-posted', async () => {
    scriptPostTs(stubA, POST_TS)
    const logCalls: unknown[][] = []
    const trail = makeTrailCapture()
    const getCalls: unknown[] = []
    const getPermissionCalls: GetPermissionParams[] = []
    const ivl = startPoller(() => ({
      list: async () => ({ spawns: [checkPermRow()] }),
      get: async (params: unknown) => {
        getCalls.push(params)
        return getResult([cannedPermissionRequest({ request_token: TOKEN_A, request_id: 1 })])
      },
      getPermission: async (params: GetPermissionParams): Promise<GetPermissionResult> => {
        getPermissionCalls.push(params)
        return cannedGetPermissionResponse({ request_token: params.request_token, decision: 'allow', decision_reason: null })
      },
    }), { log: (...args) => { logCalls.push(args) }, emitTrail: trail.emit })
    await ivl.tick()
    expect(getLivePermission(INSTANCE_A, TOKEN_A)?.messageTs).toBe(POST_TS)
    expect(getCalls).toHaveLength(1)

    // A reload drops A while its spawn is still listed with the prompt open.
    const applied = config
    unapply(KEY_A)
    await ivl.tick()
    await ivl.tick()
    expect(getCalls).toHaveLength(1)
    expect(getPermissionCalls).toHaveLength(0)
    expect(slackCalls(stubA, stubB, stubD)).toBe(1) // tick 1's post only
    expect(getLivePermission(INSTANCE_A, TOKEN_A)).toMatchObject({ messageTs: POST_TS, handled: false })
    expect(rowDecisions(trail, 'reconciled_closed')).toHaveLength(0)
    expect(trail.events.filter((e) => e.event === 'cscb.chat_update.attempted')).toHaveLength(0)
    expect(logLines(logCalls, `${INSTANCE_A} names no applied persona (persona=${KEY_A})`).length).toBeGreaterThan(0)

    // A is applied again: the open request is already tracked, so nothing is re-posted.
    config = applied
    await ivl.tick()
    expect(getCalls).toHaveLength(2)
    expect(posts(stubA)).toHaveLength(1)
    expect(rowDecisions(trail, 'already_tracked')).toHaveLength(1)
    expect(getLivePermission(INSTANCE_A, TOKEN_A)?.messageTs).toBe(POST_TS)
  })

  test('a not-posted request keeps its one log line across ticks where its persona is not applied', async () => {
    const logCalls: unknown[][] = []
    const ivl = startPoller(() => ({
      list: async () => ({ spawns: [checkPermRow(D)] }),
      get: async () => getResult([cannedPermissionRequest({ request_token: TOKEN_A, request_id: 1 })], D),
    }), { log: (...args) => { logCalls.push(args) } })
    await ivl.tick()
    const applied = config
    unapply(KEY_D)
    await ivl.tick()
    config = applied
    await ivl.tick()
    expect(logLines(logCalls, 'permission prompts by DM are not supported yet')).toHaveLength(1)
    expect(slackCalls(stubA, stubB, stubD)).toBe(0)
  })

  test('a row in the default canned form (labels exactly service and persona, the default fixture cwd) routes by its persona label', async () => {
    const row = cannedListRow({ claude_instance_id: INSTANCE_A, state: 'check_permission' })
    expect(row.labels).toEqual({ service: 'cscb', persona: KEY_A })
    expect(row.cwd).toBe(defaultCannedRowCwd())
    scriptPostTs(stubA, POST_TS)
    const ivl = startPoller(() => ({
      list: async () => ({ spawns: [row] }),
      get: async () => getResult([cannedPermissionRequest({ request_token: TOKEN_A, request_id: 1 })]),
    }))
    await ivl.tick()
    expect(posts(stubA).map((c) => c.channel)).toEqual([A_DEST])
    expect(getLivePermission(INSTANCE_A, TOKEN_A)?.personaKey).toBe(KEY_A)
  })
})

// ---------------------------------------------------------------------------
// Tick behavior — duplicate-tick no-op (Cases 2/3 collapsed)
// ---------------------------------------------------------------------------

describe('poller tick — duplicate (claude_instance_id, request_token) is a no-op', () => {
  test('repeat tick with same plural projection → no extra postMessage, map entry unchanged', async () => {
    scriptPostTs(stubA, POST_TS)
    const row = cannedPermissionRequest({ request_token: TOKEN_A, request_id: 5 })
    const ivl = startPoller(() => ({
      list: async () => ({ spawns: [checkPermRow()] }),
      get: async () => getResult([row]),
    }))

    // Tick 1: seeds the live entry
    await ivl.tick()
    expect(posts(stubA)).toHaveLength(1)
    const seeded = getLivePermission(INSTANCE_A, TOKEN_A)
    expect(seeded?.handled).toBe(false)
    expect(seeded?.messageTs).toBe(POST_TS)

    // Tick 2: identical projection → no-op
    await ivl.tick()
    expect(posts(stubA)).toHaveLength(1)
    expect(updates(stubA)).toHaveLength(0)

    // Entry untouched (ts and handled flag preserved)
    const after = getLivePermission(INSTANCE_A, TOKEN_A)
    expect(after?.messageTs).toBe(POST_TS)
    expect(after?.handled).toBe(false)
  })

  test('handled=true + duplicate row appearance → still no-op (no fresh post, no extra chat.update)', async () => {
    scriptPostTs(stubA, POST_TS)
    const row = cannedPermissionRequest({ request_token: TOKEN_A, request_id: 5 })
    const ivl = startPoller(() => ({
      list: async () => ({ spawns: [checkPermRow()] }),
      get: async () => getResult([row]),
    }))

    // Tick 1: seed
    await ivl.tick()
    expect(posts(stubA)).toHaveLength(1)

    // Simulate click handler marking handled
    markHandled(INSTANCE_A, TOKEN_A)
    expect(getLivePermission(INSTANCE_A, TOKEN_A)?.handled).toBe(true)

    // Tick 2: same projection, handled=true → still no-op
    await ivl.tick()
    expect(posts(stubA)).toHaveLength(1)
    expect(updates(stubA)).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// Tick behavior — two concurrent rows on a single tick (Epic 1 AC)
// ---------------------------------------------------------------------------

describe('poller tick — two concurrent open rows on a single tick', () => {
  test('two `permission_requests` rows → two distinct postMessage calls + two distinct map entries', async () => {
    scriptPostTs(stubA, POST_TS, POST_TS_2)

    // Use the canonical two-row builder, then re-tag the tokens so the test
    // can assert specific keys.
    const projection = cannedTwoRowPluralProjection(INSTANCE_A)
    projection.permission_requests = [
      { ...projection.permission_requests![0], request_token: TOKEN_A },
      { ...projection.permission_requests![1], request_token: TOKEN_B },
    ]

    const ivl = startPoller(() => ({
      list: async () => ({ spawns: [checkPermRow()] }),
      get: async () => projection,
    }))
    await ivl.tick()

    const postCalls = posts(stubA)
    expect(postCalls).toHaveLength(2)
    // Both prompts went to the same destination (same persona)
    expect(postCalls.every((c) => c.channel === A_DEST)).toBe(true)

    const entryA = getLivePermission(INSTANCE_A, TOKEN_A)
    const entryB = getLivePermission(INSTANCE_A, TOKEN_B)
    expect(entryA).toBeDefined()
    expect(entryB).toBeDefined()
    expect(entryA?.messageTs).toBe(POST_TS)
    expect(entryB?.messageTs).toBe(POST_TS_2)
    expect(entryA?.requestToken).toBe(TOKEN_A)
    expect(entryB?.requestToken).toBe(TOKEN_B)
  })

  test('repeat tick with the same two-row projection → zero additional postMessage, map unchanged', async () => {
    scriptPostTs(stubA, POST_TS, POST_TS_2)
    const rows = [
      cannedPermissionRequest({ request_token: TOKEN_A, request_id: 1 }),
      cannedPermissionRequest({ request_token: TOKEN_B, request_id: 2 }),
    ]
    const ivl = startPoller(() => ({
      list: async () => ({ spawns: [checkPermRow()] }),
      get: async () => getResult(rows),
    }))

    // Tick 1: seed two entries
    await ivl.tick()
    expect(posts(stubA)).toHaveLength(2)
    expect(getLivePermission(INSTANCE_A, TOKEN_A)?.messageTs).toBe(POST_TS)
    expect(getLivePermission(INSTANCE_A, TOKEN_B)?.messageTs).toBe(POST_TS_2)

    // Tick 2: identical projection → no extra posts, no updates
    await ivl.tick()
    expect(posts(stubA)).toHaveLength(2)
    expect(updates(stubA)).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// Tick behavior — empty / null / undefined open-rows
// ---------------------------------------------------------------------------

describe('poller tick — non-positive open-rows responses', () => {
  test('empty `permission_requests` array → zero postMessage; prior entry reconciled via getPermission + verdict chat.update + drop (SR-2.4)', async () => {
    scriptPostTs(stubA, POST_TS)
    let permissionsList: ReturnType<typeof cannedPermissionRequest>[] = [
      cannedPermissionRequest({ request_token: TOKEN_A, request_id: 1 }),
    ]
    const getPermissionCalls: GetPermissionParams[] = []
    const ivl = startPoller(() => ({
      list: async () => ({ spawns: [checkPermRow()] }),
      get: async () => getResult(permissionsList),
      getPermission: async (params: GetPermissionParams): Promise<GetPermissionResult> => {
        getPermissionCalls.push(params)
        return cannedGetPermissionResponse({ request_token: params.request_token, decision: 'allow', decision_reason: null })
      },
    }))

    // Tick 1: seed
    await ivl.tick()
    expect(posts(stubA)).toHaveLength(1)
    expect(getLivePermission(INSTANCE_A, TOKEN_A)).toBeDefined()

    // Tick 2: empty array → SR-2.4 set-diff sees TOK_A missing → getPermission
    // fires for TOK_A → verdict chat.update lands → entry dropped.
    permissionsList = []
    await ivl.tick()

    // No new posts from the open-rows path
    expect(posts(stubA)).toHaveLength(1)
    // getPermission was called exactly once for the disappeared token
    expect(getPermissionCalls).toHaveLength(1)
    expect(getPermissionCalls[0].request_token).toBe(TOKEN_A)
    // Verdict chat.update landed on the seeded entry's messageTs, through A
    const updateCalls = updates(stubA)
    expect(updateCalls).toHaveLength(1)
    expect(updateCalls[0].ts).toBe(POST_TS)
    expect(updateCalls[0].channel).toBe(A_DEST)
    expect(updateCalls[0].text).toBe('*Permission* — Allowed')
    // Entry dropped
    expect(getLivePermission(INSTANCE_A, TOKEN_A)).toBeUndefined()
  })

  test('null `permission_requests` → logs and skips the row, no postMessage', async () => {
    const logCalls: unknown[][] = []
    const ivl = startPoller(() => ({
      list: async () => ({ spawns: [checkPermRow()] }),
      get: async () => getResult(null),
    }), { log: (...args) => { logCalls.push(args) } })
    await ivl.tick()

    // No new posts: the open-rows path was skipped.
    expect(posts(stubA)).toHaveLength(0)
    // No live entry was created from this row.
    expect(getLivePermission(INSTANCE_A, TOKEN_A)).toBeUndefined()
    // Non-conformance was logged
    const nonConfLogs = logLines(logCalls, 'non-conforming')
    expect(nonConfLogs.length).toBeGreaterThan(0)
  })

  test('null `permission_requests` preserves prior entries for that instance (SR-2.1)', async () => {
    scriptPostTs(stubA, POST_TS)
    let projectionMode: 'present' | 'null' = 'present'
    const ivl = startPoller(() => ({
      list: async () => ({ spawns: [checkPermRow()] }),
      get: async () => projectionMode === 'present'
        ? getResult([cannedPermissionRequest({ request_token: TOKEN_A, request_id: 3 })])
        : getResult(null),
    }), { log: () => { /* swallow */ } })

    // Tick 1: seed entry (handled=false so a naive sweep would expire it)
    await ivl.tick()
    expect(getLivePermission(INSTANCE_A, TOKEN_A)?.handled).toBe(false)

    // Tick 2: get() returns null projection — SR-2.1 says the sweep must skip
    // entries on the non-conforming instance.
    projectionMode = 'null'
    await ivl.tick()

    expect(getLivePermission(INSTANCE_A, TOKEN_A)).toBeDefined()
    expect(posts(stubA)).toHaveLength(1) // tick 1 only
    expect(updates(stubA)).toHaveLength(0)
  })

  test('undefined `permission_requests` preserves prior entries for that instance (SR-2.1)', async () => {
    scriptPostTs(stubA, POST_TS)
    let projectionMode: 'present' | 'undefined' = 'present'
    const ivl = startPoller(() => ({
      list: async () => ({ spawns: [checkPermRow()] }),
      get: async () => projectionMode === 'present'
        ? getResult([cannedPermissionRequest({ request_token: TOKEN_A, request_id: 3 })])
        // permission_requests field omitted entirely
        : getResult(),
    }), { log: () => { /* swallow */ } })

    await ivl.tick()
    expect(getLivePermission(INSTANCE_A, TOKEN_A)?.handled).toBe(false)

    projectionMode = 'undefined'
    await ivl.tick()

    expect(getLivePermission(INSTANCE_A, TOKEN_A)).toBeDefined()
    expect(posts(stubA)).toHaveLength(1)
    expect(updates(stubA)).toHaveLength(0)
  })

  test('undefined `permission_requests` → same as null (logs + skips)', async () => {
    const logCalls: unknown[][] = []
    const ivl = startPoller(() => ({
      list: async () => ({ spawns: [checkPermRow()] }),
      // permission_requests field omitted entirely
      get: async () => getResult(),
    }), { log: (...args) => { logCalls.push(args) } })
    await ivl.tick()

    expect(slackCalls(stubA, stubB, stubD)).toBe(0)
    expect(getLivePermission(INSTANCE_A, TOKEN_A)).toBeUndefined()
    const nonConfLogs = logLines(logCalls, 'non-conforming')
    expect(nonConfLogs.length).toBeGreaterThan(0)
  })
})

// ---------------------------------------------------------------------------
// Tick behavior — Case 5: row disappears
// ---------------------------------------------------------------------------

describe('poller tick — row disappears from plural projection (SR-2.4 closure reconciliation)', () => {
  test('handled=false: getPermission called → verdict chat.update fires on disappeared row → entry dropped', async () => {
    scriptPostTs(stubA, POST_TS)
    let listReturn: import('agent-director').ListResult = {
      spawns: [checkPermRow()],
    }
    const getPermissionCalls: GetPermissionParams[] = []
    const ivl = startPoller(() => ({
      list: async () => listReturn,
      get: async () => getResult([cannedPermissionRequest({ request_token: TOKEN_A, request_id: 1 })]),
      getPermission: async (params: GetPermissionParams): Promise<GetPermissionResult> => {
        getPermissionCalls.push(params)
        return cannedGetPermissionResponse({ request_token: params.request_token, decision: 'deny', decision_reason: 'timeout' })
      },
    }))

    // Tick 1: post the prompt
    await ivl.tick()
    const seeded = getLivePermission(INSTANCE_A, TOKEN_A)
    expect(seeded).toBeDefined()
    expect(seeded?.handled).toBe(false)

    // Tick 2: spawn no longer in check_permission → SR-2.4 reconciliation
    listReturn = { spawns: [] }
    await ivl.tick()

    expect(getPermissionCalls).toHaveLength(1)
    expect(getPermissionCalls[0].request_token).toBe(TOKEN_A)
    const updateCalls = updates(stubA)
    expect(updateCalls).toHaveLength(1)
    expect(updateCalls[0].ts).toBe(POST_TS)
    expect(updateCalls[0].text).toBe('⏱ *Permission* — Timed out')
    expect(getLivePermission(INSTANCE_A, TOKEN_A)).toBeUndefined()
  })

  test('handled=true: SR-2.4 reconciliation still fires verdict chat.update + drops entry', async () => {
    // Epic 3 design note: the poller-side verdict rendering is unconditional —
    // it stands in for the case where the click handler's chat.update didn't
    // land. With handled=true the click's "Allowed by X" rendering is the
    // authoritative happy-path rendering; the poller-side overwrite with the
    // verdict surface is a known, acceptable tradeoff (see source comment on
    // `buildVerdictRendering`).
    scriptPostTs(stubA, POST_TS)
    let listReturn: import('agent-director').ListResult = {
      spawns: [checkPermRow()],
    }
    const getPermissionCalls: GetPermissionParams[] = []
    const ivl = startPoller(() => ({
      list: async () => listReturn,
      get: async () => getResult([cannedPermissionRequest({ request_token: TOKEN_A, request_id: 1 })]),
      getPermission: async (params: GetPermissionParams): Promise<GetPermissionResult> => {
        getPermissionCalls.push(params)
        return cannedGetPermissionResponse({ request_token: params.request_token, decision: 'allow', decision_reason: null })
      },
    }))

    // Tick 1: post, then simulate click handler success
    await ivl.tick()
    markHandled(INSTANCE_A, TOKEN_A)
    expect(getLivePermission(INSTANCE_A, TOKEN_A)?.handled).toBe(true)

    // Tick 2: spawn disappears → reconciliation runs regardless of handled.
    listReturn = { spawns: [] }
    await ivl.tick()

    expect(getPermissionCalls).toHaveLength(1)
    expect(getPermissionCalls[0].request_token).toBe(TOKEN_A)
    const updateCalls = updates(stubA)
    expect(updateCalls).toHaveLength(1)
    expect(updateCalls[0].ts).toBe(POST_TS)
    expect(updateCalls[0].text).toBe('*Permission* — Allowed')
    expect(getLivePermission(INSTANCE_A, TOKEN_A)).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// SR-2.4 / SR-5 — verdict-driven newly-closed reconciliation
// ---------------------------------------------------------------------------

/**
 * Drive one full tick of the closure-reconciliation path: seed a single live
 * entry by running the poll once with the row present, then run a second tick
 * with the row absent and a canned `getPermission` response. Returns the
 * recorded `getPermission` params so individual tests can assert
 * verdict-rendering specifics against persona A's stub.
 */
async function seedAndClose(opts: {
  getPermissionResult?: GetPermissionResult
  getPermissionError?: Error
  postTs?: string
  token?: string
}): Promise<{
  ivl: ManualIntervalControl
  getPermissionCalls: GetPermissionParams[]
  token: string
}> {
  scriptPostTs(stubA, opts.postTs ?? POST_TS)
  const token = opts.token ?? TOKEN_A
  const getPermissionCalls: GetPermissionParams[] = []

  let rowsPresent = true
  const ivl = startPoller(() => ({
    list: async () => ({ spawns: [checkPermRow()] }),
    get: async () => getResult(rowsPresent
      ? [cannedPermissionRequest({ request_token: token, request_id: 1 })]
      : []),
    getPermission: async (params: GetPermissionParams): Promise<GetPermissionResult> => {
      getPermissionCalls.push(params)
      if (opts.getPermissionError) throw opts.getPermissionError
      return opts.getPermissionResult
        ?? cannedGetPermissionResponse({ request_token: params.request_token })
    },
  }), { log: () => { /* swallow */ } })

  // Tick 1: seed
  await ivl.tick()

  // Tick 2: row disappears → closure path
  rowsPresent = false
  await ivl.tick()

  return { ivl, getPermissionCalls, token }
}

describe('SR-2.4 / SR-5 — newly-closed reconciliation + verdict rendering', () => {
  test('SR-5.1 operator_allow rendering — decision=allow, decision_reason=null → "*Permission* — Allowed"', async () => {
    const { getPermissionCalls, token } = await seedAndClose({
      getPermissionResult: cannedGetPermissionResponse({ decision: 'allow', decision_reason: null }),
    })

    expect(getPermissionCalls).toHaveLength(1)
    expect(getPermissionCalls[0].request_token).toBe(token)
    const updateCalls = updates(stubA)
    expect(updateCalls).toHaveLength(1)
    expect(updateCalls[0].channel).toBe(A_DEST)
    expect(updateCalls[0].ts).toBe(POST_TS)
    expect(updateCalls[0].text).toBe('*Permission* — Allowed')
    expect(slackCalls(stubB, stubD)).toBe(0)
    expect(getLivePermission(INSTANCE_A, token)).toBeUndefined()
  })

  test('SR-5.1 operator_deny rendering — decision=deny, decision_reason="operator" → "*Permission* — Denied by operator"', async () => {
    const { token } = await seedAndClose({
      getPermissionResult: cannedGetPermissionResponse({ decision: 'deny', decision_reason: 'operator' }),
    })

    const updateCalls = updates(stubA)
    expect(updateCalls).toHaveLength(1)
    expect(updateCalls[0].text).toBe('*Permission* — Denied by operator')
    expect(getLivePermission(INSTANCE_A, token)).toBeUndefined()
  })

  test('SR-5.1 timeout rendering — decision=deny, decision_reason="timeout" → "⏱ *Permission* — Timed out"', async () => {
    const { token } = await seedAndClose({
      getPermissionResult: cannedGetPermissionResponse({ decision: 'deny', decision_reason: 'timeout' }),
    })

    const updateCalls = updates(stubA)
    expect(updateCalls).toHaveLength(1)
    expect(updateCalls[0].text).toBe('⏱ *Permission* — Timed out')
    expect(getLivePermission(INSTANCE_A, token)).toBeUndefined()
  })

  test('SR-5.1 find_missing rendering — decision=deny, decision_reason="find_missing" → distinct "session ended" text', async () => {
    const { token } = await seedAndClose({
      getPermissionResult: cannedGetPermissionResponse({ decision: 'deny', decision_reason: 'find_missing' }),
    })

    const updateCalls = updates(stubA)
    expect(updateCalls).toHaveLength(1)
    const findMissingText = updateCalls[0].text
    expect(findMissingText).toBe('🪦 *Permission* — Session ended')

    // SR-5.1 distinctness: find_missing must NOT collapse to operator-deny or timeout text.
    expect(findMissingText).not.toBe('*Permission* — Denied by operator')
    expect(findMissingText).not.toBe('⏱ *Permission* — Timed out')
    expect(findMissingText).not.toBe('*Permission* — Denied (closed)')
    expect(getLivePermission(INSTANCE_A, token)).toBeUndefined()
  })

  test('SR-5.2 unknown decision_reason → fail-closed generic deny, log fires, poller does not crash; sibling fresh-post still happens', async () => {
    // This test specifically exercises the "bad branch did not crash the
    // tick" assertion. Seed a live entry under TOK_A, then on the next tick
    // present a fresh row under TOK_B AND drop TOK_A from the projection.
    // The dropped TOK_A goes through the unknown-enum path; TOK_B should
    // still produce a chat.postMessage.
    scriptPostTs(stubA, POST_TS, POST_TS_2)
    const logCalls: unknown[][] = []
    const getPermissionCalls: GetPermissionParams[] = []

    let rowsPresent: Array<{ token: string; req_id: number }> = [{ token: TOKEN_A, req_id: 1 }]
    const ivl = startPoller(() => ({
      list: async () => ({ spawns: [checkPermRow()] }),
      get: async () => getResult(rowsPresent.map((r) =>
        cannedPermissionRequest({ request_token: r.token, request_id: r.req_id }),
      )),
      getPermission: async (params: GetPermissionParams): Promise<GetPermissionResult> => {
        getPermissionCalls.push(params)
        return cannedGetPermissionResponse({
          request_token: params.request_token,
          decision: 'deny',
          // Intentionally outside the canonical enum to exercise the SR-5.2
          // fail-closed path. AD 0.6.1+ types decision_reason as a strict
          // union; cast through unknown so the literal lands at runtime.
          decision_reason: 'something-new' as unknown as GetPermissionResult['decision_reason'],
        })
      },
    }), { log: (...args) => { logCalls.push(args) } })

    // Tick 1: seed TOK_A
    await ivl.tick()
    expect(getLivePermission(INSTANCE_A, TOKEN_A)?.messageTs).toBe(POST_TS)

    // Tick 2: TOK_A disappears (closure with unknown decision_reason),
    // TOK_B is a fresh open row. The unknown-enum branch must NOT crash the
    // tick; TOK_B's fresh-post must still land.
    rowsPresent = [{ token: TOKEN_B, req_id: 2 }]
    await ivl.tick()

    // Generic-deny rendering for TOK_A
    const updateCalls = updates(stubA)
    expect(updateCalls).toHaveLength(1)
    expect(updateCalls[0].ts).toBe(POST_TS)
    expect(updateCalls[0].text).toBe('*Permission* — Denied (closed)')
    expect(getLivePermission(INSTANCE_A, TOKEN_A)).toBeUndefined()

    // Log fired with the unknown value
    const unknownLogs = logLines(logCalls, 'unknown verdict')
    expect(unknownLogs.length).toBe(1)

    // SR-5.2 sanity — sibling fresh-post happened despite the bad branch
    expect(posts(stubA)).toHaveLength(2) // tick 1 (TOK_A) + tick 2 (TOK_B)
    expect(getLivePermission(INSTANCE_A, TOKEN_B)?.messageTs).toBe(POST_TS_2)
  })

  test('SR-2.4 ErrPermissionRequestNotFound → generic deny, log fires, drop, no retry on the next tick', async () => {
    // Round 1: seed TOK_A, then close with not-found.
    scriptPostTs(stubA, POST_TS)
    const logCalls: unknown[][] = []
    const getPermissionCalls: GetPermissionParams[] = []

    let rowsPresent = true
    const ivl = startPoller(() => ({
      list: async () => ({ spawns: [checkPermRow()] }),
      get: async () => getResult(rowsPresent
        ? [cannedPermissionRequest({ request_token: TOKEN_A, request_id: 1 })]
        : []),
      getPermission: async (params: GetPermissionParams): Promise<GetPermissionResult> => {
        getPermissionCalls.push(params)
        throw errPermissionRequestNotFound()
      },
    }), { log: (...args) => { logCalls.push(args) } })

    // Tick 1: seed
    await ivl.tick()

    // Tick 2: row disappears → not-found path
    rowsPresent = false
    await ivl.tick()

    expect(getPermissionCalls).toHaveLength(1)
    const updateCalls = updates(stubA)
    expect(updateCalls).toHaveLength(1)
    expect(updateCalls[0].text).toBe('*Permission* — Denied (closed)')
    expect(getLivePermission(INSTANCE_A, TOKEN_A)).toBeUndefined()
    const nfLogs = logLines(logCalls, 'not-found')
    expect(nfLogs.length).toBe(1)

    // Tick 3: same shape — entry is gone, so no second getPermission call.
    await ivl.tick()
    expect(getPermissionCalls).toHaveLength(1)
    expect(updates(stubA)).toHaveLength(1)
  })

  test('SR-2.4 transient getPermission error → entry preserved, retried next tick when call succeeds', async () => {
    scriptPostTs(stubA, POST_TS)
    const getPermissionCalls: GetPermissionParams[] = []

    let rowsPresent = true
    let throwOnNext = true
    const ivl = startPoller(() => ({
      list: async () => ({ spawns: [checkPermRow()] }),
      get: async () => getResult(rowsPresent
        ? [cannedPermissionRequest({ request_token: TOKEN_A, request_id: 1 })]
        : []),
      getPermission: async (params: GetPermissionParams): Promise<GetPermissionResult> => {
        getPermissionCalls.push(params)
        if (throwOnNext) throw errGeneric('get-permission', 'ErrSomethingTransient', 'oops')
        return cannedGetPermissionResponse({
          request_token: params.request_token,
          decision: 'allow',
          decision_reason: null,
        })
      },
    }), { log: () => { /* swallow */ } })

    // Tick 1: seed
    await ivl.tick()

    // Tick 2: row disappears → transient error → entry preserved, no chat.update
    rowsPresent = false
    await ivl.tick()

    expect(getPermissionCalls).toHaveLength(1)
    expect(updates(stubA)).toHaveLength(0)
    expect(getLivePermission(INSTANCE_A, TOKEN_A)).toBeDefined()

    // Tick 3: getPermission now succeeds → reconciliation completes
    throwOnNext = false
    await ivl.tick()

    expect(getPermissionCalls).toHaveLength(2)
    const updateCalls = updates(stubA)
    expect(updateCalls).toHaveLength(1)
    expect(updateCalls[0].text).toBe('*Permission* — Allowed')
    expect(getLivePermission(INSTANCE_A, TOKEN_A)).toBeUndefined()
  })

  test('SR-5.3 sibling independence on closure — only the disappeared row gets chat.update; sibling untouched', async () => {
    scriptPostTs(stubA, POST_TS, POST_TS_2)
    const getPermissionCalls: GetPermissionParams[] = []

    let presentRows: Array<{ token: string; req_id: number }> = [
      { token: TOKEN_A, req_id: 1 },
      { token: TOKEN_B, req_id: 2 },
    ]
    const ivl = startPoller(() => ({
      list: async () => ({ spawns: [checkPermRow()] }),
      get: async () => getResult(presentRows.map((r) =>
        cannedPermissionRequest({ request_token: r.token, request_id: r.req_id }),
      )),
      getPermission: async (params: GetPermissionParams): Promise<GetPermissionResult> => {
        getPermissionCalls.push(params)
        return cannedGetPermissionResponse({
          request_token: params.request_token,
          decision: 'allow',
          decision_reason: null,
        })
      },
    }))

    // Tick 1: seed both siblings
    await ivl.tick()
    expect(getLivePermission(INSTANCE_A, TOKEN_A)?.messageTs).toBe(POST_TS)
    expect(getLivePermission(INSTANCE_A, TOKEN_B)?.messageTs).toBe(POST_TS_2)

    // Tick 2: TOK_A drops from the projection; TOK_B still present
    presentRows = [{ token: TOKEN_B, req_id: 2 }]
    await ivl.tick()

    // SR-5.3: getPermission fired exactly once for TOK_A only
    expect(getPermissionCalls).toHaveLength(1)
    expect(getPermissionCalls[0].request_token).toBe(TOKEN_A)

    // SR-5.3: chat.update only on TOK_A's messageTs; sibling's ts never targeted
    const updateCalls = updates(stubA)
    expect(updateCalls).toHaveLength(1)
    expect(updateCalls[0].ts).toBe(POST_TS)
    expect(updateCalls.every((u) => u.ts !== POST_TS_2)).toBe(true)

    // Sibling entry untouched
    const siblingAfter = getLivePermission(INSTANCE_A, TOKEN_B)
    expect(siblingAfter).toBeDefined()
    expect(siblingAfter?.messageTs).toBe(POST_TS_2)
    expect(siblingAfter?.handled).toBe(false)

    // Closed entry dropped
    expect(getLivePermission(INSTANCE_A, TOKEN_A)).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// Skipped-tick observability
// ---------------------------------------------------------------------------

describe('poller tick — skipped-tick observability', () => {
  test('exactly one WARN at the 5th skip; further skips in the same streak are silent', async () => {
    const logCalls: unknown[][] = []

    let resolveTick: () => void = () => {}
    const ivl = startPoller(() => ({
      list: async () => {
        await new Promise<void>((resolve) => { resolveTick = resolve })
        return { spawns: [] }
      },
      get: async () => cannedGetResult({ claude_instance_id: 'x' }),
    }), { log: (...args) => { logCalls.push(args) } })

    // Tick 1 goes in-flight (list() hangs) and never finishes
    await ivl.tick(5)

    // Fire 7 more ticks while the first is still in-flight → 7 skips total.
    // With `=== 5` semantics, the warning fires exactly once (at skip 5);
    // with the older `>= 5` semantics it would fire 3 times (skips 5, 6, 7).
    for (let i = 0; i < 7; i++) {
      ivl.fire()
    }
    await new Promise((r) => setTimeout(r, 5))

    const warnLogs = logLines(logCalls, 'skipped')
    expect(warnLogs).toHaveLength(1)
    expect(String(warnLogs[0][0])).toMatch(/skipped 5 consecutive ticks/)

    // Unblock the hanging tick so cleanup works
    resolveTick()
    await new Promise((r) => setTimeout(r, 10))
  })

  test('warning re-arms after a successful tick: a second stuck streak emits another single warning', async () => {
    const logCalls: unknown[][] = []

    let hangTick = true
    let resolveTick: () => void = () => {}
    const ivl = startPoller(() => ({
      list: async () => {
        if (hangTick) {
          await new Promise<void>((resolve) => { resolveTick = resolve })
        }
        return { spawns: [] }
      },
      get: async () => cannedGetResult({ claude_instance_id: 'x' }),
    }), { log: (...args) => { logCalls.push(args) } })

    // First streak: hang + 5 skips → one warning.
    await ivl.tick(5)
    for (let i = 0; i < 5; i++) ivl.fire()
    await new Promise((r) => setTimeout(r, 5))
    expect(logLines(logCalls, 'skipped')).toHaveLength(1)

    // Resolve the hung tick + let any new tick run cleanly to reset skippedTicks.
    hangTick = false
    resolveTick()
    await new Promise((r) => setTimeout(r, 10))
    await ivl.tick()

    // Second streak: hang again + 5 skips → exactly one more warning (total 2).
    hangTick = true
    await ivl.tick(5)
    for (let i = 0; i < 5; i++) ivl.fire()
    await new Promise((r) => setTimeout(r, 5))
    expect(logLines(logCalls, 'skipped')).toHaveLength(2)

    resolveTick()
    await new Promise((r) => setTimeout(r, 10))
  })
})

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

describe('poller lifecycle', () => {
  test('startPermissionPoller is idempotent', () => {
    const ivl = makeManualInterval()
    const getClient = () => ({
      list: async () => ({ spawns: [] }),
      get: async () => cannedGetResult({ claude_instance_id: 'x' }),
    })
    const deps: PollerDeps = {
      getClient,
      clientFor: clients.clientFor,
      getPersona,
      intervalMs: 1000,
      setInterval: ivl.setInterval,
      clearInterval: ivl.clearInterval,
    }
    startPermissionPoller(deps)
    startPermissionPoller(deps)
    startPermissionPoller(deps)
    expect(ivl.pending).toHaveLength(1)
  })

  test('stopPermissionPoller is safe when not started', () => {
    expect(() => stopPermissionPoller()).not.toThrow()
  })

  test('dropPermission removes the live entry', async () => {
    scriptPostTs(stubA, POST_TS)
    const ivl = startPoller(() => ({
      list: async () => ({ spawns: [checkPermRow()] }),
      get: async () => getResult([cannedPermissionRequest({ request_token: TOKEN_A, request_id: 1 })]),
    }))
    await ivl.tick()
    expect(getLivePermission(INSTANCE_A, TOKEN_A)).toBeDefined()
    dropPermission(INSTANCE_A, TOKEN_A)
    expect(getLivePermission(INSTANCE_A, TOKEN_A)).toBeUndefined()
  })

  test('markHandled returns false when no live entry exists', () => {
    expect(markHandled('nonexistent_id', TOKEN_A)).toBe(false)
  })

  test('markHandled returns true and sets handled=true when entry exists', async () => {
    scriptPostTs(stubA, POST_TS)
    const ivl = startPoller(() => ({
      list: async () => ({ spawns: [checkPermRow()] }),
      get: async () => getResult([cannedPermissionRequest({ request_token: TOKEN_A, request_id: 1 })]),
    }))
    await ivl.tick()
    expect(getLivePermission(INSTANCE_A, TOKEN_A)?.handled).toBe(false)
    expect(markHandled(INSTANCE_A, TOKEN_A)).toBe(true)
    expect(getLivePermission(INSTANCE_A, TOKEN_A)?.handled).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// SR-V Epic 2 — cscb.poller.row_decision + cscb.chat_post.attempted
// ---------------------------------------------------------------------------

describe('trail events — cscb.poller.row_decision and cscb.chat_post.attempted', () => {
  /** Start the poller over one open A request (TOKEN_A) that stays open. */
  function startOneOpenRow(trail: TrailCapture, opts: Partial<PollerDeps> = {}): ManualIntervalControl {
    return startPoller(() => ({
      list: async () => ({ spawns: [checkPermRow()] }),
      get: async () => getResult([cannedPermissionRequest({ request_token: TOKEN_A, request_id: 1 })]),
    }), { emitTrail: trail.emit, ...opts })
  }

  test('action=post_attempted on a brand-new row', async () => {
    scriptPostTs(stubA, POST_TS)
    const trail = makeTrailCapture()
    const ivl = startOneOpenRow(trail)
    await ivl.tick()

    const decisions = trail.events.filter(e => e.event === 'cscb.poller.row_decision')
    expect(decisions).toHaveLength(1)
    expect(decisions[0]!['action']).toBe('post_attempted')
    expect(decisions[0]!.claude_instance_id).toBe(INSTANCE_A)
    expect(decisions[0]!.request_token).toBe(TOKEN_A)
  })

  test('action=already_tracked on second tick over the same row', async () => {
    scriptPostTs(stubA, POST_TS)
    const trail = makeTrailCapture()
    const ivl = startOneOpenRow(trail)
    await ivl.tick()
    await ivl.tick()

    const decisions = trail.events.filter(e => e.event === 'cscb.poller.row_decision')
    const actions = decisions.map(e => e['action'])
    expect(actions).toEqual(['post_attempted', 'already_tracked'])
  })

  test('action=reconciled_closed when the row disappears with a verdict', async () => {
    scriptPostTs(stubA, POST_TS)
    const trail = makeTrailCapture()
    let listProjection: ReturnType<typeof cannedPermissionRequest>[] = [
      cannedPermissionRequest({ request_token: TOKEN_A, request_id: 1 }),
    ]
    const ivl = startPoller(() => ({
      list: async () => ({ spawns: [checkPermRow()] }),
      get: async () => getResult(listProjection),
      getPermission: async (params: GetPermissionParams): Promise<GetPermissionResult> =>
        cannedGetPermissionResponse({ request_token: params.request_token, decision: 'allow', decision_reason: null }),
    }), { emitTrail: trail.emit })

    await ivl.tick()
    listProjection = []
    await ivl.tick()

    const reconciled = trail.events.find(
      e => e.event === 'cscb.poller.row_decision' && e['action'] === 'reconciled_closed',
    )
    expect(reconciled).toBeDefined()
    expect(reconciled!.request_token).toBe(TOKEN_A)
    expect(reconciled!.claude_instance_id).toBe(INSTANCE_A)
  })

  test('action=not_found_generic_deny when getPermission throws ErrPermissionRequestNotFound', async () => {
    scriptPostTs(stubA, POST_TS)
    const trail = makeTrailCapture()
    let listProjection: ReturnType<typeof cannedPermissionRequest>[] = [
      cannedPermissionRequest({ request_token: TOKEN_A, request_id: 1 }),
    ]
    const ivl = startPoller(() => ({
      list: async () => ({ spawns: [checkPermRow()] }),
      get: async () => getResult(listProjection),
      getPermission: async (_: GetPermissionParams): Promise<GetPermissionResult> => {
        throw errPermissionRequestNotFound()
      },
    }), { emitTrail: trail.emit, log: () => { /* swallow */ } })

    await ivl.tick()
    listProjection = []
    await ivl.tick()

    const notFound = trail.events.find(
      e => e.event === 'cscb.poller.row_decision' && e['action'] === 'not_found_generic_deny',
    )
    expect(notFound).toBeDefined()
    expect(notFound!.request_token).toBe(TOKEN_A)
  })

  test('action=non_conforming_skipped omits request_token entirely (SR-V-1.1)', async () => {
    const trail = makeTrailCapture()
    const ivl = startPoller(() => ({
      list: async () => ({ spawns: [checkPermRow()] }),
      get: async () => getResult(null),
    }), { emitTrail: trail.emit, log: () => { /* swallow */ } })
    await ivl.tick()

    const nc = trail.events.find(
      e => e.event === 'cscb.poller.row_decision' && e['action'] === 'non_conforming_skipped',
    )
    expect(nc).toBeDefined()
    expect(nc!.claude_instance_id).toBe(INSTANCE_A)
    // request_token MUST be absent — not an empty string (SR-V-1.1).
    expect('request_token' in nc!).toBe(false)
  })

  test('action=transient_retry when getPermission throws a non-not-found error', async () => {
    scriptPostTs(stubA, POST_TS)
    const trail = makeTrailCapture()
    let listProjection: ReturnType<typeof cannedPermissionRequest>[] = [
      cannedPermissionRequest({ request_token: TOKEN_A, request_id: 1 }),
    ]
    const ivl = startPoller(() => ({
      list: async () => ({ spawns: [checkPermRow()] }),
      get: async () => getResult(listProjection),
      getPermission: async (_: GetPermissionParams): Promise<GetPermissionResult> => {
        throw errGeneric('get-permission', 'ErrTransient', 'transient')
      },
    }), { emitTrail: trail.emit, log: () => { /* swallow */ } })

    await ivl.tick()
    listProjection = []
    await ivl.tick()

    const transient = trail.events.find(
      e => e.event === 'cscb.poller.row_decision' && e['action'] === 'transient_retry',
    )
    expect(transient).toBeDefined()
    expect(transient!.request_token).toBe(TOKEN_A)
  })

  test('cscb.chat_post.attempted on success carries full text+blocks, Slack-returned ts, and the destination channel', async () => {
    scriptPostTs(stubA, POST_TS)
    const trail = makeTrailCapture()
    const ivl = startOneOpenRow(trail)
    await ivl.tick()

    const post = trail.events.find(e => e.event === 'cscb.chat_post.attempted')
    expect(post).toBeDefined()
    expect(post!['ok']).toBe(true)
    expect(post!['slack_ts']).toBe(POST_TS)
    expect(post!.channel).toBe(A_DEST)
    expect(typeof post!['text']).toBe('string')
    expect(Array.isArray(post!['blocks'])).toBe(true)
  })

  test('SR-V-1.4 action_id decode round-trip from persisted blocks', async () => {
    scriptPostTs(stubA, POST_TS)
    const trail = makeTrailCapture()
    const ivl = startOneOpenRow(trail)
    await ivl.tick()

    const post = trail.events.find(e => e.event === 'cscb.chat_post.attempted')!
    const blocks = post['blocks'] as Array<Record<string, unknown>>
    const actions = blocks.find(b => b['type'] === 'actions') as
      { elements: Array<{ action_id: string }> } | undefined
    expect(actions).toBeDefined()
    const allow = actions!.elements[0]!.action_id
    const deny = actions!.elements[1]!.action_id

    const decAllow = parsePermissionActionId(allow)
    const decDeny = parsePermissionActionId(deny)
    expect(decAllow).toEqual({ decision: 'allow', claudeInstanceId: INSTANCE_A, requestToken: TOKEN_A })
    expect(decDeny).toEqual({ decision: 'deny', claudeInstanceId: INSTANCE_A, requestToken: TOKEN_A })
  })

  test.each<[SlackFailureRow, string]>([
    [{ kind: 'platform', error: 'channel_not_found' }, 'channel_not_found'],
    [{ kind: 'network' }, 'network_error'],
  ])('cscb.chat_post.attempted on Slack failure (%o) carries the error class, not Error.name; one token-safe log line; no live entry', async (outcome, errorClass) => {
    stubA.script.post.push(outcome)
    const trail = makeTrailCapture()
    const logCalls: unknown[][] = []
    const ivl = startOneOpenRow(trail, { log: (...args) => { logCalls.push(args) } })
    await ivl.tick()

    const post = trail.events.find(e => e.event === 'cscb.chat_post.attempted')
    expect(post).toBeDefined()
    expect(post!['ok']).toBe(false)
    expect(post!['error']).toBe(errorClass)
    expect(post!.channel).toBe(A_DEST)
    expect(getLivePermission(INSTANCE_A, TOKEN_A)).toBeUndefined()
    // b.emk: failure also lands in server.log alongside the trail event.
    expectTokenSafeFailure(logCalls, trail, `chat.postMessage failed for ${INSTANCE_A}`, outcome)
  })

  test('row_decision and chat_post.attempted share request_token on the same tick', async () => {
    scriptPostTs(stubA, POST_TS)
    const trail = makeTrailCapture()
    const ivl = startOneOpenRow(trail)
    await ivl.tick()

    const decision = trail.events.find(
      e => e.event === 'cscb.poller.row_decision' && e['action'] === 'post_attempted',
    )
    const post = trail.events.find(e => e.event === 'cscb.chat_post.attempted')
    expect(decision!.request_token).toBe(TOKEN_A)
    expect(post!.request_token).toBe(TOKEN_A)
    expect(decision!.claude_instance_id).toBe(post!.claude_instance_id)
  })
})

// ---------------------------------------------------------------------------
// SR-V Epic 3 — cscb.chat_update.attempted (poller-triggered)
// ---------------------------------------------------------------------------

describe('trail events — cscb.chat_update.attempted (poller-triggered)', () => {
  function makeClosureScenario(
    getPermissionImpl: (params: GetPermissionParams) => Promise<GetPermissionResult>,
  ): {
    trail: TrailCapture
    logCalls: unknown[][]
    drive: () => Promise<void>
  } {
    scriptPostTs(stubA, POST_TS)
    const trail = makeTrailCapture()
    let listProjection: ReturnType<typeof cannedPermissionRequest>[] = [
      cannedPermissionRequest({ request_token: TOKEN_A, request_id: 1 }),
    ]
    const logCalls: unknown[][] = []
    const ivl = startPoller(() => ({
      list: async () => ({ spawns: [checkPermRow()] }),
      get: async () => getResult(listProjection),
      getPermission: getPermissionImpl,
    }), { emitTrail: trail.emit, log: (...args) => { logCalls.push(args) } })
    const drive = async (): Promise<void> => {
      await ivl.tick()
      listProjection = []
      await ivl.tick()
    }
    return { trail, logCalls, drive }
  }

  test('operator_allow → ok=true, triggered_by=poller, target channel and ts match the prompt', async () => {
    const scenario = makeClosureScenario(async (p) =>
      cannedGetPermissionResponse({ request_token: p.request_token, decision: 'allow', decision_reason: null }),
    )
    await scenario.drive()
    const closure = scenario.trail.events.find(e => e.event === 'cscb.chat_update.attempted')
    expect(closure).toBeDefined()
    expect(closure!['verdict_tag']).toBe('operator_allow')
    expect(closure!['triggered_by']).toBe('poller')
    expect(closure!['ok']).toBe(true)
    expect(closure!.channel).toBe(A_DEST)
    expect(closure!.message_ts).toBe(POST_TS)
    expect(typeof closure!['text']).toBe('string')
    expect(Array.isArray(closure!['blocks'])).toBe(true)
  })

  test('operator_deny verdict tag', async () => {
    const scenario = makeClosureScenario(async (p) =>
      cannedGetPermissionResponse({ request_token: p.request_token, decision: 'deny', decision_reason: 'operator' }),
    )
    await scenario.drive()
    const closure = scenario.trail.events.find(e => e.event === 'cscb.chat_update.attempted')
    expect(closure!['verdict_tag']).toBe('operator_deny')
    expect(closure!['triggered_by']).toBe('poller')
  })

  test('timeout verdict tag', async () => {
    const scenario = makeClosureScenario(async (p) =>
      cannedGetPermissionResponse({ request_token: p.request_token, decision: 'deny', decision_reason: 'timeout' }),
    )
    await scenario.drive()
    const closure = scenario.trail.events.find(e => e.event === 'cscb.chat_update.attempted')
    expect(closure!['verdict_tag']).toBe('timeout')
  })

  test('find_missing verdict tag', async () => {
    const scenario = makeClosureScenario(async (p) =>
      cannedGetPermissionResponse({ request_token: p.request_token, decision: 'deny', decision_reason: 'find_missing' }),
    )
    await scenario.drive()
    const closure = scenario.trail.events.find(e => e.event === 'cscb.chat_update.attempted')
    expect(closure!['verdict_tag']).toBe('find_missing')
  })

  test('unknown verdict tag on weird decision/reason pair', async () => {
    const scenario = makeClosureScenario(async (p) =>
      cannedGetPermissionResponse({ request_token: p.request_token, decision: 'deny', decision_reason: 'someone_else' as never }),
    )
    await scenario.drive()
    const closure = scenario.trail.events.find(e => e.event === 'cscb.chat_update.attempted')
    expect(closure!['verdict_tag']).toBe('unknown')
  })

  test('not_found verdict tag when getPermission throws ErrPermissionRequestNotFound', async () => {
    const scenario = makeClosureScenario(async (_) => { throw errPermissionRequestNotFound() })
    await scenario.drive()
    const closure = scenario.trail.events.find(e => e.event === 'cscb.chat_update.attempted')
    expect(closure!['verdict_tag']).toBe('not_found')
  })

  test.each<[SlackFailureRow, string]>([
    [{ kind: 'platform', error: 'message_not_found' }, 'message_not_found'],
    [{ kind: 'network' }, 'network_error'],
  ])('closure chat.update failure (%o) → ok=false with the error class; one token-safe log line; entry still dropped', async (outcome, errorClass) => {
    stubA.script.update.push(outcome)
    const scenario = makeClosureScenario(async (p) =>
      cannedGetPermissionResponse({ request_token: p.request_token, decision: 'allow', decision_reason: null }),
    )
    await scenario.drive()
    const closure = scenario.trail.events.find(e => e.event === 'cscb.chat_update.attempted')
    expect(closure).toBeDefined()
    expect(closure!['ok']).toBe(false)
    expect(closure!['error']).toBe(errorClass)
    expect(closure!['triggered_by']).toBe('poller')
    // The failed update was attempted through A's client, on the recorded channel.
    expect(updates(stubA).map((u) => u.channel)).toEqual([A_DEST])
    expect(getLivePermission(INSTANCE_A, TOKEN_A)).toBeUndefined()
    // b.emk: failure also lands in server.log alongside the trail event.
    expectTokenSafeFailure(scenario.logCalls, scenario.trail, 'closure chat.update failed', outcome)
    expect(String(logLines(scenario.logCalls, 'closure chat.update failed')[0][0])).toContain(`token=${TOKEN_A} (verdict=operator_allow)`)
  })
})

// ---------------------------------------------------------------------------
// b.en2 Epic 6 — withOutageDetection wrapper integration, keyed by persona
// ---------------------------------------------------------------------------

describe('b.en2 Epic 6 — withOutageDetection wrapper integration (keyed by persona)', () => {
  // Case 1: per-row client.get raises ad-unreachable via wrapper.
  test('per-row client.get: ErrSystemInstallDisappeared → ad-unreachable raised under the persona key; no Slack postMessage', async () => {
    const getCalls: unknown[] = []
    const ivl = startPoller(() => ({
      list: async () => ({ spawns: [checkPermRow()] }),
      get: async (params: unknown) => {
        getCalls.push(params)
        throw new ErrSystemInstallDisappeared('get', '/bin/ad')
      },
    }))
    await ivl.tick(20)

    // Wrapper invoked get() exactly once.
    expect(getCalls).toHaveLength(1)
    // ad-unreachable flag raised under A's key, never under its destination channel.
    expect(getOutageFlags(KEY_A).has('ad-unreachable')).toBe(true)
    expect(getOutageFlags(A_DEST).size).toBe(0)
    // Onset Slack message carries the binaryPath detail.
    const onset = outageEmissions.find(e => e.key === KEY_A)
    expect(onset).toBeDefined()
    expect(onset!.text).toContain('/bin/ad')
    expect(outageEmissions.some(e => e.key === A_DEST)).toBe(false)
    // Per-event Slack postMessage suppressed (no double-noise).
    expect(slackCalls(stubA, stubB, stubD)).toBe(0)
  })

  // Case 2: per-entry getPermission raises ad-unreachable via wrapper.
  test('per-entry getPermission: ErrSystemInstallDisappeared → ad-unreachable raised under the posting persona key; entry preserved for retry', async () => {
    scriptPostTs(stubA, POST_TS)
    let rowsPresent = true
    const getPermCalls: GetPermissionParams[] = []
    const ivl = startPoller(() => ({
      list: async () => ({ spawns: rowsPresent ? [checkPermRow()] : [] }),
      get: async () => getResult(rowsPresent
        ? [cannedPermissionRequest({ request_token: TOKEN_A, request_id: 1 })]
        : []),
      getPermission: async (params: GetPermissionParams): Promise<GetPermissionResult> => {
        getPermCalls.push(params)
        throw new ErrSystemInstallDisappeared('get-permission', '/bin/ad')
      },
    }))
    // Tick 1: seed the live entry.
    await ivl.tick()
    expect(getLivePermission(INSTANCE_A, TOKEN_A)).toBeDefined()

    // Tick 2: row disappears → getPermission path fires with ErrSystemInstallDisappeared.
    rowsPresent = false
    await ivl.tick()

    expect(getPermCalls).toHaveLength(1)
    // ad-unreachable flag raised under the entry's persona key, not its channel.
    expect(getOutageFlags(KEY_A).has('ad-unreachable')).toBe(true)
    expect(getOutageFlags(A_DEST).size).toBe(0)
    // Onset Slack message carries the binaryPath detail.
    const onset = outageEmissions.find(e => e.key === KEY_A)
    expect(onset).toBeDefined()
    expect(onset!.text).toContain('/bin/ad')
    expect(outageEmissions.some(e => e.key === A_DEST)).toBe(false)
    // Entry preserved — no chat.update (outage-class error is a skip, not a close).
    expect(getLivePermission(INSTANCE_A, TOKEN_A)).toBeDefined()
    expect(updates(stubA)).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// b.fae F4 — silent-wedge detector (empty permission_requests in
// check_permission for K consecutive ticks → one-shot warning to the
// persona's destination + cscb.poller.wedge_detected trail event + log;
// re-arms on recovery). b.av2 SR-7.2: the warning names the persona.
// ---------------------------------------------------------------------------

describe('b.fae F4 — wedge detector', () => {
  const WEDGE_INTERVAL_MS = 1000
  // K at the 1s test interval: max(5, ceil(90000/1000)) = 90.
  const K = wedgeTripTicks(WEDGE_INTERVAL_MS)
  const RETRY_EVERY = 30 // ceil(30000/1000) at the 1s test interval.

  /**
   * Build a poller wired to a mutable open-rows projection for `persona`.
   * Flip `empty` to toggle between a wedged spawn (zero open rows) and a
   * healthy one (one open row). `driveTicks(n)` invokes the interval callback
   * n times, awaiting the microtask queue after each so the async tick body
   * settles.
   */
  function makeWedgeScenario(persona: Persona = A): {
    ivl: ManualIntervalControl
    trail: TrailCapture
    logCalls: unknown[][]
    setEmpty: (v: boolean) => void
    driveTicks: (n: number) => Promise<void>
  } {
    const trail = makeTrailCapture()
    const logCalls: unknown[][] = []
    let empty = true
    const ivl = startPoller(() => ({
      list: async () => ({ spawns: [checkPermRow(persona)] }),
      get: async () => getResult(empty ? [] : [cannedPermissionRequest({ request_token: TOKEN_A })], persona),
      getPermission: async (params: GetPermissionParams): Promise<GetPermissionResult> =>
        cannedGetPermissionResponse({ request_token: params.request_token, decision: 'allow', decision_reason: null }),
    }), { intervalMs: WEDGE_INTERVAL_MS, emitTrail: trail.emit, log: (...args) => { logCalls.push(args) } })
    return {
      ivl,
      trail,
      logCalls,
      setEmpty: (v) => { empty = v },
      driveTicks: async (n) => {
        for (let i = 0; i < n; i++) {
          ivl.fire()
          await new Promise((r) => setTimeout(r, 0))
        }
      },
    }
  }

  const wedgeWarnings = (stub: StubSlack) =>
    posts(stub).filter((c) => String(c.text).includes('blocked on a native'))
  const wedgeTrail = (trail: TrailCapture) =>
    trail.events.filter((e) => e.event === 'cscb.poller.wedge_detected')

  test('1. trips after K consecutive empty ticks: warning to the persona\'s destination through its client + trail event + log', async () => {
    const s = makeWedgeScenario()

    // K-1 empty ticks: not yet tripped.
    await s.driveTicks(K - 1)
    expect(wedgeWarnings(stubA)).toHaveLength(0)
    expect(wedgeTrail(s.trail)).toHaveLength(0)

    // Kth empty tick: trips.
    await s.driveTicks(1)
    const warnings = wedgeWarnings(stubA)
    expect(warnings).toHaveLength(1)
    expect(warnings[0].channel).toBe(A_DEST)
    expect(posts(stubA)).toHaveLength(1)
    expect(slackCalls(stubB, stubD)).toBe(0)

    const events = wedgeTrail(s.trail)
    expect(events).toHaveLength(1)
    expect(events[0]['claude_instance_id']).toBe(INSTANCE_A)
    expect(events[0]['channel']).toBe(A_DEST)
    expect(events[0]['ok']).toBe(true)

    // Log written on trip.
    const tripLogs = logLines(s.logCalls, 'wedged in check_permission')
    expect(tripLogs.length).toBeGreaterThan(0)
  })

  test('2. does NOT trip on a brief transient (< K empties then non-empty resets the counter)', async () => {
    const s = makeWedgeScenario()

    // A few empty ticks, short of K.
    await s.driveTicks(K - 2)
    expect(wedgeWarnings(stubA)).toHaveLength(0)

    // Recovery tick: an open row appears → re-arm, counter reset to zero.
    s.setEmpty(false)
    await s.driveTicks(1)
    expect(wedgeWarnings(stubA)).toHaveLength(0)

    // Back to empty: counter starts from zero, so K-1 more empties still don't trip.
    s.setEmpty(true)
    await s.driveTicks(K - 1)
    expect(wedgeWarnings(stubA)).toHaveLength(0)
    expect(wedgeTrail(s.trail)).toHaveLength(0)

    // One more empty tick reaches K post-reset → now it trips.
    await s.driveTicks(1)
    expect(wedgeWarnings(stubA)).toHaveLength(1)
  })

  test('3. fires ONCE per episode across many post-K ticks', async () => {
    const s = makeWedgeScenario()

    // Well past K — one-shot latch must suppress re-posting every tick.
    await s.driveTicks(K + 40)

    expect(wedgeWarnings(stubA)).toHaveLength(1)
    expect(wedgeTrail(s.trail)).toHaveLength(1)
  })

  test('4. re-arms after recovery: second wedge fires a second warning', async () => {
    const s = makeWedgeScenario()

    // First episode: trip.
    await s.driveTicks(K)
    expect(wedgeWarnings(stubA)).toHaveLength(1)

    // Recover (open row appears) → detector state dropped.
    s.setEmpty(false)
    await s.driveTicks(1)

    // Second wedge episode: K more empty ticks → second warning.
    s.setEmpty(true)
    await s.driveTicks(K)
    expect(wedgeWarnings(stubA)).toHaveLength(2)
    expect(wedgeTrail(s.trail)).toHaveLength(2)
  })

  test('5. warning text names the persona, mentions read-pane and does NOT recommend send-keys as a remedy', async () => {
    const s = makeWedgeScenario()
    await s.driveTicks(K)

    const warnings = wedgeWarnings(stubA)
    expect(warnings).toHaveLength(1)
    const text = String(warnings[0].text)
    expect(text.startsWith(`Persona ${renderPersonaRef(NAME_A, KEY_A)}: `)).toBe(true)
    expect(text).toContain(INSTANCE_A)
    expect(text).toContain('read-pane')
    // send-keys, if mentioned at all, must be an explicit DON'T — never a remedy.
    expect(text).toContain('Do NOT use send-keys')
    expect(text).not.toContain('use send-keys to')
  })

  // b.fae F3 — warning-post FAILURE path. The latch (`warningFired`) sets ONLY
  // on a successful chat.postMessage; a failed post keeps it unset and retries
  // on a later tick, throttled to one attempt per WEDGE_WARN_RETRY_WALL_CLOCK_MS.
  // Each ACTUAL failed attempt still emits a `cscb.poller.wedge_detected`
  // ok:false trail event; on eventual success exactly one channel message lands
  // and no further posts occur.
  test('6. post failure does not latch; retries throttled to the 30s window; success lands exactly one message (b.fae F3)', async () => {
    // Two failing posts, then Slack recovers (an empty script means success).
    stubA.script.post.push({ kind: 'network' }, { kind: 'network' })
    const s = makeWedgeScenario()
    const failEvents = () => wedgeTrail(s.trail).filter((e) => e['ok'] === false)
    const okEvents = () => wedgeTrail(s.trail).filter((e) => e['ok'] === true)

    // Reach K → first attempt fires, fails, latch stays unset, ok:false trail.
    await s.driveTicks(K)
    expect(posts(stubA)).toHaveLength(1)
    expect(failEvents()).toHaveLength(1)
    expect(okEvents()).toHaveLength(0)

    // Within the retry window (< RETRY_EVERY more ticks) no NEW attempt is made.
    await s.driveTicks(RETRY_EVERY - 1)
    expect(posts(stubA)).toHaveLength(1)
    expect(failEvents()).toHaveLength(1)

    // One more tick crosses the retry window → a second (still-failing) attempt.
    await s.driveTicks(1)
    expect(posts(stubA)).toHaveLength(2)
    expect(failEvents()).toHaveLength(2)

    // Slack recovers; the next retry-window boundary posts successfully → latch
    // sets, exactly one message lands total, one ok:true trail event, and no
    // further posts thereafter no matter how many more empty ticks elapse.
    await s.driveTicks(RETRY_EVERY)
    expect(posts(stubA)).toHaveLength(3) // two failed + one success
    expect(okEvents()).toHaveLength(1)
    const landed = wedgeWarnings(stubA)
    expect(landed).toHaveLength(3) // all three were real attempts; success is the 3rd
    expect(landed.every((c) => c.channel === A_DEST)).toBe(true)
    // Latched: no more attempts across many further ticks.
    await s.driveTicks(K + RETRY_EVERY)
    expect(posts(stubA)).toHaveLength(3)
    expect(okEvents()).toHaveLength(1)
    expect(slackCalls(stubB, stubD)).toBe(0)
    // Each failed attempt logged once; nothing leaks.
    expect(logLines(s.logCalls, 'wedge warning postMessage failed')).toHaveLength(2)
    assertNoLeak({ logCalls: s.logCalls, trail: s.trail.events }, 'wedge post failures')
  })

  test.each<[SlackFailureRow, string]>([
    [{ kind: 'platform', error: 'not_in_channel' }, 'not_in_channel'],
    [{ kind: 'network' }, 'network_error'],
  ])('6b. wedge warning post failure (%o) → one token-safe log line naming the persona, ok:false trail with the error class', async (outcome, errorClass) => {
    stubA.script.post.push(outcome)
    const s = makeWedgeScenario()
    await s.driveTicks(K)

    expect(posts(stubA)).toHaveLength(1)
    const failed = wedgeTrail(s.trail)
    expect(failed).toHaveLength(1)
    expect(failed[0]['ok']).toBe(false)
    expect(failed[0]['error']).toBe(errorClass)
    expectTokenSafeFailure(s.logCalls, s.trail, 'wedge warning postMessage failed', outcome)
    expect(String(logLines(s.logCalls, 'wedge warning postMessage failed')[0][0]))
      .toContain(`for ${renderPersonaRef(NAME_A, KEY_A)} (${INSTANCE_A})`)
  })

  // b.fae F4 — K derivation from the poll interval and the 5-tick floor.
  test.each([
    [1000, 90],
    [200, 450],
    [60000, 5],
  ])('7. wedgeTripTicks(%i ms) === %i (derivation + 5-tick floor, b.fae F4)', (intervalMs, expected) => {
    expect(wedgeTripTicks(intervalMs)).toBe(expected)
  })

  // b.fae F4 follow-up — a transient `get` error tick does NOT reset the wedge
  // counter (it is exempt from re-arming), so the counter accumulates across the
  // gap and trips at K TOTAL empty observations. An ErrSpawnNotFound tick, by
  // contrast, is a positive "spawn is gone" observation and DOES reset.
  test('8. transient get-error does not reset the counter; ErrSpawnNotFound does (b.fae F4 follow-up)', async () => {
    const trail = makeTrailCapture()
    // get() behavior is switchable per tick: 'empty' | 'transient' | 'notfound'.
    let mode: 'empty' | 'transient' | 'notfound' = 'empty'
    const ivl = startPoller(() => ({
      list: async () => ({ spawns: [checkPermRow()] }),
      get: async () => {
        if (mode === 'transient') throw errGeneric('get', 'ErrTransientGet', 'transient read failure')
        if (mode === 'notfound') throw errSpawnNotFound()
        return getResult([])
      },
      getPermission: async (params: GetPermissionParams): Promise<GetPermissionResult> =>
        cannedGetPermissionResponse({ request_token: params.request_token, decision: 'allow', decision_reason: null }),
    }), { intervalMs: WEDGE_INTERVAL_MS, emitTrail: trail.emit, log: () => {} })
    const drive = async (n: number) => {
      for (let i = 0; i < n; i++) { ivl.fire(); await new Promise((r) => setTimeout(r, 0)) }
    }

    // K-1 empty observations, then ONE transient-error tick, then 1 empty.
    // The error tick must NOT reset, so total empties = K → trips.
    await drive(K - 1)
    expect(wedgeWarnings(stubA)).toHaveLength(0)
    mode = 'transient'
    await drive(1) // read gap: counter preserved, no new empty observation.
    expect(wedgeWarnings(stubA)).toHaveLength(0)
    mode = 'empty'
    await drive(1) // Kth empty observation overall → trip.
    expect(wedgeWarnings(stubA)).toHaveLength(1)
    expect(wedgeTrail(trail)).toHaveLength(1)

    // Now recover via ErrSpawnNotFound → positive "gone" observation resets the
    // detector. Coming back empty must require a FRESH K empties before re-trip.
    mode = 'notfound'
    await drive(1)
    mode = 'empty'
    await drive(K - 1)
    expect(wedgeWarnings(stubA)).toHaveLength(1) // still just the first trip.
    await drive(1)
    expect(wedgeWarnings(stubA)).toHaveLength(2) // fresh episode trips at fresh K.
  })

  test('8b. ticks where the persona is not applied do not reset the counter', async () => {
    const s = makeWedgeScenario()
    await s.driveTicks(K - 1)
    const applied = config
    unapply(KEY_A)
    await s.driveTicks(3) // listed but not applied: no observation either way
    config = applied
    expect(wedgeWarnings(stubA)).toHaveLength(0)
    await s.driveTicks(1) // Kth empty observation overall → trip.
    expect(wedgeWarnings(stubA)).toHaveLength(1)
    expect(wedgeTrail(s.trail)).toHaveLength(1)
  })

  test('9. `dm` destination (until E7): the warning is logged naming the persona, with no Slack call and no trail event; the episode latches', async () => {
    const s = makeWedgeScenario(D)
    await s.driveTicks(K)

    const dmLines = logLines(s.logCalls, 'stuck-prompt warning by DM is not supported yet')
    expect(dmLines).toHaveLength(1)
    const line = String(dmLines[0][0])
    expect(line).toContain(renderPersonaRef(NAME_D, KEY_D))
    expect(line).toContain(`Persona ${renderPersonaRef(NAME_D, KEY_D)}: `)
    expect(line).toContain('read-pane')
    expect(slackCalls(stubA, stubB, stubD)).toBe(0)
    expect(wedgeTrail(s.trail)).toHaveLength(0)

    // Latched: no further log lines across many more empty ticks.
    await s.driveTicks(K + RETRY_EVERY)
    expect(logLines(s.logCalls, 'stuck-prompt warning by DM is not supported yet')).toHaveLength(1)
    expect(slackCalls(stubA, stubB, stubD)).toBe(0)
  })

  test('10. client unavailable: no post and no latch; once the client returns, exactly one warning lands after the retry throttle', async () => {
    clients.setUnavailable(KEY_A)
    const s = makeWedgeScenario()
    await s.driveTicks(K)

    const noClient = () => logLines(s.logCalls, 'stuck-prompt warning for')
    expect(noClient()).toHaveLength(1)
    expect(String(noClient()[0][0])).toContain(renderPersonaRef(NAME_A, KEY_A))
    expect(slackCalls(stubA, stubB, stubD)).toBe(0)
    expect(wedgeTrail(s.trail)).toHaveLength(0)

    // The client returns; the attempt is still throttled within the window.
    clients.setUnavailable(KEY_A, false)
    await s.driveTicks(RETRY_EVERY - 1)
    expect(posts(stubA)).toHaveLength(0)

    // Crossing the window: one warning lands on A's destination and latches.
    await s.driveTicks(1)
    expect(wedgeWarnings(stubA).map((c) => c.channel)).toEqual([A_DEST])
    expect(wedgeTrail(s.trail).filter((e) => e['ok'] === true)).toHaveLength(1)
    await s.driveTicks(K + RETRY_EVERY)
    expect(posts(stubA)).toHaveLength(1)
    expect(noClient()).toHaveLength(1)
    expect(slackCalls(stubB, stubD)).toBe(0)
  })
})
