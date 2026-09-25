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
 *     scripted on the stub, the error class in the trail, nothing leaks
 *     (b.av2 SR-10.3). A closure update failure, or a prompt failing on its
 *     own message (`invalid_blocks`, `msg_too_long`), logs one token-safe
 *     line per attempt with the platform reason; a destination failure of a
 *     prompt or wedge warning logs one `persona-destination-failed` line per
 *     episode instead.
 *   - `dm` destination (b.av2 SR-7.1; AC 29, 34, 44): `conversations.open`
 *     for `dm.contact` then `chat.postMessage` to the returned `D…`, both on
 *     the persona's own client, with no identity override; the live entry and
 *     the trail name the `D…`; one open serves every later prompt; a
 *     channel-destination persona in the same tick makes no open; a failed
 *     open is trailed (ok:false, no channel) and nothing posts; a refused
 *     destination (DMs off or no contact) is logged once per request with no
 *     Slack call and no trail event.
 *   - Destination failures held and retried (b.av2 SR-7.1, SR-3.2; AC 44),
 *     through a destination hold on a fake clock (`makeHold`): `missing_scope`
 *     on a DM-only persona's first open and `not_in_channel` on a channel
 *     post log one episode line (naming `im:write` only for the former); no
 *     Slack call, trail event or line inside a backoff window; retries at 5 s
 *     and a further 10 s; delivered once when the cause clears, with one
 *     cleared line. A prompt held when `permission_prompts` changes in place
 *     is retried, once due, at the new destination only, tracked there and
 *     named by the cleared line; a failure there logs one more opening line
 *     naming it. A held persona never holds another; a request closed
 *     while held is never posted or updated; a stuck-prompt warning joins the
 *     episode and a held tick leaves its throttle alone; a payload error is
 *     not held and is tried again next tick. A due retry whose attempt ends
 *     early (the warning finding no client) or throws (a row the builder
 *     rejects, a throwing trail emitter or logger; run in a child process,
 *     as the throw rejects the tick) never leaves the persona held: its next
 *     prompt or warning posts. A token-shaped Slack error reaches the trail
 *     and the episode line as `unknown_error`.
 *   - Closing updates after DMs are turned off, the destination changes or
 *     `dm.contact` changes in place with the cached DM forgotten (AC 36,
 *     b.av2 SR-5.1): one `chat.update` on the recorded conversation and ts,
 *     no post and no open; later prompts use the new destination; another
 *     persona's tracked prompt is untouched.
 *   - The applied set swapped mid-tick (a confirmed reload's step 1; AC 58):
 *     a destination or DMs change during the `get`, or between two prompts
 *     of one row, sends the next prompt to the new destination; a persona
 *     removed then posts nothing more, logs the unchanged "names no applied
 *     persona" line once and its tracked prompt is not closed.
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
 *     persona's destination through its client. The scenario passes a
 *     destination hold whose fake clock moves one poll interval per tick.
 *   - A persona that is not up (b.av2 SR-6.4), through the production up
 *     predicate: its rows get no `get`, post, update, live entry, wedge tick
 *     or trail event while an up persona's row posts in the same tick; a
 *     skipped request posts once after it comes up; its tracked prompt and
 *     wedge count are held (not closed, dropped, re-posted or re-armed) and
 *     reconciled once it is up; the skip is logged once per episode.
 *   - A teardown's drop (`forgetPersonaPrompts`, b.av2 SR-6.5): B's tracked
 *     prompts (by key or `cscb_<key>`), not-posted records, stuck-prompt
 *     count and not-up skip episode are dropped with no Slack call, trail
 *     event or closing update, A's are kept; one line only when prompts were
 *     dropped; a leftover row labelled for B after B left the applied set
 *     posts and tracks nothing.
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
  forgetPersonaPrompts,
  getLivePermission,
  markHandled,
  startPermissionPoller,
  stopPermissionPoller,
  wedgeTripTicks,
  type PermissionRequestRow,
  type PollerDeps,
} from '../src/permission-poller.ts'
import { _resetTrailFdForTests } from '../src/permission-trail.ts'
import { createPersonaDestinations, type PersonaDestinations } from '../src/persona-destination.ts'
import { createPersonaDestinationHold, type PersonaDestinationHold } from '../src/persona-destination-hold.ts'
import { createFakeClock, type FakeClock } from './test-helpers/fake-clock.ts'
import { parsePermissionActionId } from '../src/permission-action-id.ts'
import { personaKeyFromActionId } from './test-helpers/action-id-key.ts'
import { personaInstanceId, personaKey, renderPersonaRef } from '../src/persona-identity.ts'
import { createPersonaUpPredicate } from '../src/persona-start.ts'
import type { PersonaConnectionStatus } from '../src/persona-connections.ts'
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
import { runInFakeHome } from './test-helpers/fake-home-subprocess.ts'
import { asWebClient, makeDeferredWebApiCall, makeStubSlack, openedDm, stubOpenedDmId, type StubSlack } from './test-helpers/slack-stub.ts'
import {
  BOT_TOKEN_PREFIX,
  LEAK_SENTINEL,
  REDACTED_SENTINEL_TAIL,
  assertNoLeak,
  fakeToken,
  sentinelInMessage,
} from './test-helpers/credentials.ts'
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
// Persona D sends prompts by DM to D_CONTACT; an unscripted open returns D_DM.
const NAME_D = 'Delta Direct'
const KEY_D = personaKey(NAME_D)
const INSTANCE_D = personaInstanceId(KEY_D)
const D_WORK = 'C0DWORK001'
const D_CONTACT = 'U0DCONTACT1'
const D_DM = stubOpenedDmId(D_CONTACT)

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

/** Replace fields of applied persona `key` (a reload that changes it; the loader's rules don't apply here). */
function reconfigure(key: string, patch: Partial<Persona>): void {
  config = { ...config, personas: config.personas.map((p) => (p.key === key ? { ...p, ...patch } : p)) }
}

/** The Web API methods called on a stub's client, in call order. */
const methods = (stub: StubSlack): string[] => stub.web.callLog.map((c) => c.method)

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

/** The server-log class of a destination-failure episode (b.av2 SR-10.3). */
const EPISODE_CLASS = 'persona-destination-failed'
/** The scope a `missing_scope` failure of `conversations.open` names. */
const DM_OPEN_SCOPE = 'im:write'

/** Every `persona-destination-failed` line: the episode's opening line and its cleared line. */
const episodeLines = (logCalls: unknown[][]) => logLines(logCalls, `] ${EPISODE_CLASS}: `)
/** The cleared lines among them (E2's convention: the cause starts `cleared:`). */
const clearedLines = (logCalls: unknown[][]) => episodeLines(logCalls).filter((args) => String(args[0]).includes(': cleared: '))
/** Per-attempt failure lines the poller itself writes (a prompt or wedge-warning open or post). */
const pollerFailureLines = (logCalls: unknown[][]) =>
  logCalls.filter((args) => String(args[0]).includes('permission-poller:') && String(args[0]).includes(' failed for '))

/**
 * A destination failure (b.av2 SR-7.1, SR-10.3): exactly one
 * `persona-destination-failed` line (the episode opened; nothing cleared),
 * naming the persona by index, name and key, the destination, the failed step
 * and the Slack error code, and `im:write` only when `namesScope`; no
 * per-attempt poller failure line; nothing in the log calls or the trail
 * carries the sentinel or a token.
 */
function expectOneEpisodeLine(
  logCalls: unknown[][],
  trail: TrailCapture,
  persona: Persona,
  failure: { step: 'conversations.open' | 'chat.postMessage'; destination: string; code: string; namesScope: boolean },
): void {
  const lines = episodeLines(logCalls)
  expect(lines).toHaveLength(1)
  expect(lines[0]).toHaveLength(1)
  const line = String(lines[0][0])
  expect(line).toStartWith(`[slack] ${EPISODE_CLASS}: personas[${persona.index}] ${renderPersonaRef(persona.name, persona.key)}: `)
  expect(line).toContain(`${failure.step} failed for destination=${failure.destination} with error ${failure.code}`)
  expect(line).toContain('holding its permission prompts and notices and retrying with backoff')
  if (failure.namesScope) expect(line).toContain(`re-install the app with ${DM_OPEN_SCOPE}`)
  else expect(line).not.toContain(DM_OPEN_SCOPE)
  expect(pollerFailureLines(logCalls)).toEqual([])
  assertNoLeak({ logCalls, trail: trail.events }, 'destination failure')
}

/** A destination hold on its own fake clock, as the tick-driven tests pass it. */
interface HeldHarness {
  clock: FakeClock
  hold: PersonaDestinationHold
}

/**
 * A destination hold over `destinations` (a fresh resolver unless given), the
 * test's persona and client lookups and a fake clock, writing its lines into
 * `logCalls` beside the poller's.
 */
function makeHold(logCalls: unknown[][], destinations?: PersonaDestinations): HeldHarness {
  const clock = createFakeClock()
  const log = (line: string): void => { logCalls.push([line]) }
  const hold = createPersonaDestinationHold({
    destinations: destinations ?? createPersonaDestinations({ log }),
    getPersona,
    clientFor: clients.clientFor,
    clock,
    log,
  })
  return { clock, hold }
}

/** Make every later `method` call on `stub` fail with the platform error `error` until `clearSticky`. */
function failSticky(stub: StubSlack, method: 'open' | 'post', error: string): void {
  stub.script[method].push(...Array.from({ length: 1000 }, () => ({ kind: 'platform' as const, error })))
}

/** The cause clears: every later `method` call on `stub` succeeds. */
function clearSticky(stub: StubSlack, method: 'open' | 'post'): void {
  stub.script[method].length = 0
}

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
    reconfigure(KEY_A, { permission_prompts: A_WORK })
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

  test('a not-posted request (client unavailable) keeps its one log line across ticks where its persona is not applied', async () => {
    const logCalls: unknown[][] = []
    clients.setUnavailable(KEY_D)
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
    expect(logLines(logCalls, `no Slack client for ${renderPersonaRef(NAME_D, KEY_D)}`)).toHaveLength(1)
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
// `dm` destination (b.av2 SR-7.1; SR-5.1 exception)
// ---------------------------------------------------------------------------

describe('poller tick — `dm` destination (b.av2 SR-7.1, SR-5.1)', () => {
  const A_CONTACT = 'U0ACONTACT1'
  const D_NEW_CONTACT = 'U0DNEWCON1'
  const TOKEN_C = '33333333-3333-4333-8333-333333333333'
  const request = (request_token: string, request_id: number) => cannedPermissionRequest({ request_token, request_id })
  const allowAll = async (params: GetPermissionParams): Promise<GetPermissionResult> =>
    cannedGetPermissionResponse({ request_token: params.request_token, decision: 'allow', decision_reason: null })
  const stubOf = (key: string): StubSlack => (key === KEY_A ? stubA : key === KEY_B ? stubB : stubD)
  const otherStubs = (key: string): StubSlack[] => [stubA, stubB, stubD].filter((s) => s !== stubOf(key))

  test.each<[string, string, (() => void) | undefined, string[], () => string]>([
    ['channel destination (A): chat.postMessage only, to its channel', KEY_A, undefined, ['chat.postMessage'], () => A_DEST],
    [
      'AC 29: DM destination with DMs on (D): conversations.open for its contact, then chat.postMessage to the returned D…',
      KEY_D, undefined, ['conversations.open', 'chat.postMessage'], () => D_DM,
    ],
    [
      'AC 44: DM-only persona with zero channels (D), first prompt with no DM yet: the conversation is opened and the prompt delivered there',
      KEY_D, () => reconfigure(KEY_D, { channels: [] }), ['conversations.open', 'chat.postMessage'], () => D_DM,
    ],
  ])('%s — on the persona\'s own client, in that exact order, with no identity override; the live entry and trail name that conversation', async (_label, key, setup, expectedMethods, expectedChannel) => {
    setup?.()
    const persona = getPersona(key)!
    const stub = stubOf(key)
    const instance = personaInstanceId(key)
    scriptPostTs(stub, POST_TS)
    const trail = makeTrailCapture()
    const ivl = startPoller(() => ({
      list: async () => ({ spawns: [checkPermRow(persona)] }),
      get: async () => getResult([request(TOKEN_A, 1)], persona),
    }), { emitTrail: trail.emit })
    await ivl.tick()

    // The exact ordered call log: no conversation-list, history or membership lookup.
    expect(methods(stub)).toEqual(expectedMethods)
    if (expectedMethods.includes('conversations.open')) expect(stub.calls.conversationsOpen).toEqual([{ users: D_CONTACT }])
    for (const other of otherStubs(key)) expect(other.callLog).toEqual([])

    const [post] = posts(stub) as unknown as Array<Record<string, unknown>>
    expect(post['channel']).toBe(expectedChannel())
    expect(Array.isArray(post['blocks'])).toBe(true)
    for (const field of ['username', 'icon_url', 'icon_emoji', 'thread_ts']) expect(field in post).toBe(false)
    const actions = (post['blocks'] as Array<Record<string, unknown>>).find((b) => b['type'] === 'actions') as
      { elements: Array<{ action_id: string }> }
    expect(actions.elements.map((el) => personaKeyFromActionId(el.action_id))).toEqual([key, key])

    // The click handler and the closing update resolve in the conversation posted to.
    expect(getLivePermission(instance, TOKEN_A)).toMatchObject({ personaKey: key, channelId: expectedChannel(), messageTs: POST_TS })
    expect(chatPosts(trail).map((e) => [e.channel, e['ok'], e['slack_ts']])).toEqual([[expectedChannel(), true, POST_TS]])
  })

  test('one conversations.open serves every prompt of the persona: two requests in one tick and a third on a later tick all post to the opened D…', async () => {
    const chosen = 'D0CHOSEN01'
    stubD.script.open.push(openedDm(chosen))
    let rows = [request(TOKEN_A, 1), request(TOKEN_B, 2)]
    const ivl = startPoller(() => ({
      list: async () => ({ spawns: [checkPermRow(D)] }),
      get: async () => getResult(rows, D),
    }))
    await ivl.tick()
    rows = [...rows, request(TOKEN_C, 3)]
    await ivl.tick()

    expect(methods(stubD)).toEqual(['conversations.open', 'chat.postMessage', 'chat.postMessage', 'chat.postMessage'])
    expect(posts(stubD).map((c) => c.channel)).toEqual([chosen, chosen, chosen])
    for (const token of [TOKEN_A, TOKEN_B, TOKEN_C]) expect(getLivePermission(INSTANCE_D, token)?.channelId).toBe(chosen)
  })

  test('an injected destination resolver is the one used: a DM it already opened (as the notifier would) is reused with no second open', async () => {
    const destinations = createPersonaDestinations({ log: () => {} })
    expect(await destinations.post(D, asWebClient(stubD.web), { text: 'a notice' })).toMatchObject({ outcome: 'posted', channelId: D_DM })
    const ivl = startPoller(() => ({
      list: async () => ({ spawns: [checkPermRow(D)] }),
      get: async () => getResult([request(TOKEN_A, 1)], D),
    }), { destinations })
    await ivl.tick()
    expect(methods(stubD)).toEqual(['conversations.open', 'chat.postMessage', 'chat.postMessage'])
    expect(posts(stubD).map((c) => c.channel)).toEqual([D_DM, D_DM])
  })

  test('AC 34: two personas in one tick route by their own settings: A posts to its channel with no conversations.open, D opens and posts in its DM, each on its own client; B gets nothing', async () => {
    scriptPostTs(stubA, POST_TS)
    scriptPostTs(stubD, POST_TS_2)
    const ivl = startPoller(() => ({
      list: async () => ({ spawns: [checkPermRow(A), checkPermRow(D)] }),
      get: async (p: { claude_instance_id: string }) =>
        p.claude_instance_id === INSTANCE_A ? getResult([request(TOKEN_A, 1)], A) : getResult([request(TOKEN_B, 2)], D),
    }))
    await ivl.tick()

    expect(methods(stubA)).toEqual(['chat.postMessage'])
    expect(posts(stubA).map((c) => c.channel)).toEqual([A_DEST])
    expect(methods(stubD)).toEqual(['conversations.open', 'chat.postMessage'])
    expect(stubD.calls.conversationsOpen).toEqual([{ users: D_CONTACT }])
    expect(posts(stubD).map((c) => c.channel)).toEqual([D_DM])
    expect(stubB.callLog).toEqual([])
    expect(getLivePermission(INSTANCE_A, TOKEN_A)).toMatchObject({ personaKey: KEY_A, channelId: A_DEST, messageTs: POST_TS })
    expect(getLivePermission(INSTANCE_D, TOKEN_B)).toMatchObject({ personaKey: KEY_D, channelId: D_DM, messageTs: POST_TS_2 })
  })

  test.each<[string, string, () => void, () => string, string[], string[], () => string]>([
    [
      'AC 36: a DM prompt, after DMs are turned off and the destination is a channel',
      KEY_D, () => reconfigure(KEY_D, { dm: { enabled: false }, permission_prompts: D_WORK }),
      () => D_DM, ['conversations.open', 'chat.postMessage'], ['chat.postMessage'], () => D_WORK,
    ],
    [
      'a channel prompt, after the destination changes to dm',
      KEY_A, () => reconfigure(KEY_A, { dm: { enabled: true, contact: A_CONTACT }, permission_prompts: 'dm' }),
      () => A_DEST, ['chat.postMessage'], ['conversations.open', 'chat.postMessage'], () => stubOpenedDmId(A_CONTACT),
    ],
    [
      'a DM prompt, after dm.contact changes',
      KEY_D, () => reconfigure(KEY_D, { dm: { enabled: true, contact: D_NEW_CONTACT } }),
      () => D_DM, ['conversations.open', 'chat.postMessage'], ['conversations.open', 'chat.postMessage'], () => stubOpenedDmId(D_NEW_CONTACT),
    ],
  ])('%s: the closing update is one chat.update on the recorded conversation and ts through the persona\'s client, with no post and no open; a later prompt uses the new destination', async (_label, key, change, postedIn, firstMethods, nextMethods, nextChannel) => {
    const persona = getPersona(key)!
    const stub = stubOf(key)
    const instance = personaInstanceId(key)
    scriptPostTs(stub, POST_TS)
    let rows = [request(TOKEN_A, 1)]
    const ivl = startPoller(() => ({
      list: async () => ({ spawns: [checkPermRow(persona)] }),
      get: async () => getResult(rows, persona),
      getPermission: allowAll,
    }))
    await ivl.tick()
    expect(methods(stub)).toEqual(firstMethods)
    expect(getLivePermission(instance, TOKEN_A)?.channelId).toBe(postedIn())

    change()
    rows = []
    await ivl.tick()
    expect(methods(stub).slice(firstMethods.length)).toEqual(['chat.update'])
    expect(updates(stub).map((c) => [c.channel, c.ts])).toEqual([[postedIn(), POST_TS]])
    expect(getLivePermission(instance, TOKEN_A)).toBeUndefined()

    rows = [request(TOKEN_B, 2)]
    await ivl.tick()
    expect(methods(stub).slice(firstMethods.length + 1)).toEqual(nextMethods)
    expect(posts(stub).map((c) => c.channel)).toEqual([postedIn(), nextChannel()])
    for (const other of otherStubs(key)) expect(other.callLog).toEqual([])
  })

  test.each<[string, SlackFailureRow, 'conversations.open' | 'chat.postMessage', string]>([
    ['conversations.open fails (user_not_found)', { kind: 'platform', error: 'user_not_found' }, 'conversations.open', 'user_not_found'],
    ['conversations.open fails (network)', { kind: 'network' }, 'conversations.open', 'network_error'],
    ['chat.postMessage to the opened D… fails (is_archived)', { kind: 'platform', error: 'is_archived' }, 'chat.postMessage', 'is_archived'],
  ])('%s: not posted, no live entry; one token-safe persona-destination-failed line naming the persona, `dm`, the failed step and the error class (no per-attempt line); one ok:false chat_post trail event with the error class, naming the D… only once it was opened', async (_label, outcome, step, errorClass) => {
    if (step === 'conversations.open') stubD.script.open.push(outcome)
    else stubD.script.post.push(outcome)
    const trail = makeTrailCapture()
    const logCalls: unknown[][] = []
    const ivl = startPoller(() => ({
      list: async () => ({ spawns: [checkPermRow(D)] }),
      get: async () => getResult([request(TOKEN_A, 1)], D),
    }), { emitTrail: trail.emit, log: (...args) => { logCalls.push(args) } })
    await ivl.tick()

    expect(methods(stubD)).toEqual(step === 'conversations.open' ? ['conversations.open'] : ['conversations.open', 'chat.postMessage'])
    expect(getLivePermission(INSTANCE_D, TOKEN_A)).toBeUndefined()
    expect(rowDecisions(trail, 'post_attempted')).toHaveLength(1)
    const events = chatPosts(trail)
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ claude_instance_id: INSTANCE_D, request_token: TOKEN_A, ok: false, error: errorClass })
    if (step === 'conversations.open') expect('channel' in events[0]).toBe(false)
    else expect(events[0].channel).toBe(D_DM)
    expectOneEpisodeLine(logCalls, trail, D, { step, destination: 'dm', code: errorClass, namesScope: false })
    expect(slackCalls(stubA, stubB)).toBe(0)
  })

  test.each<[string, Persona['dm'], string]>([
    ['DMs off', { enabled: false, contact: D_CONTACT }, 'dm.enabled is not true'],
    ['no contact', { enabled: true }, 'dm.contact is not set'],
  ])('`dm` destination refused (%s; the loader rejects it): logged once per open request naming the persona and the setting; no Slack call, no live entry, no trail event; posts once the setting is fixed', async (_label, dm, setting) => {
    reconfigure(KEY_D, { dm })
    const logCalls: unknown[][] = []
    const trail = makeTrailCapture()
    const getPermissionCalls: GetPermissionParams[] = []
    let rows = [request(TOKEN_A, 1)]
    const ivl = startPoller(() => ({
      list: async () => ({ spawns: [checkPermRow(D)] }),
      get: async () => getResult(rows, D),
      getPermission: async (params: GetPermissionParams): Promise<GetPermissionResult> => {
        getPermissionCalls.push(params)
        return allowAll(params)
      },
    }), { log: (...args) => { logCalls.push(args) }, emitTrail: trail.emit })
    const refusals = () =>
      logLines(logCalls, `${renderPersonaRef(NAME_D, KEY_D)} has permission_prompts set to "dm" but ${setting}`)

    await ivl.tick()
    await ivl.tick()
    await ivl.tick()
    expect(refusals()).toHaveLength(1)
    expect(String(refusals()[0][0])).toContain(INSTANCE_D)
    expect(String(refusals()[0][0])).toContain(TOKEN_A)
    expect(slackCalls(stubA, stubB, stubD)).toBe(0)
    expect(getLivePermission(INSTANCE_D, TOKEN_A)).toBeUndefined()
    expect(trail.events).toEqual([])

    // A new open request logs its own line; the gone one was never tracked, so never reconciled.
    rows = [request(TOKEN_B, 2)]
    await ivl.tick()
    await ivl.tick()
    expect(refusals()).toHaveLength(2)
    expect(String(refusals()[1][0])).toContain(TOKEN_B)
    expect(getPermissionCalls).toHaveLength(0)
    expect(slackCalls(stubA, stubB, stubD)).toBe(0)

    // Fixed: the still-open request posts in the DM on the next tick.
    reconfigure(KEY_D, { dm: { enabled: true, contact: D_CONTACT } })
    await ivl.tick()
    expect(methods(stubD)).toEqual(['conversations.open', 'chat.postMessage'])
    expect(getLivePermission(INSTANCE_D, TOKEN_B)?.channelId).toBe(D_DM)
    expect(refusals()).toHaveLength(2)
  })
})

// ---------------------------------------------------------------------------
// The applied set swapped mid-tick (a confirmed reload's step 1; AC 58)
// ---------------------------------------------------------------------------

describe('poller tick — the applied set swapped mid-tick by a confirmed reload (AC 58)', () => {
  const A_CONTACT = 'U0ACONTACT1'
  const TOKEN_C = '33333333-3333-4333-8333-333333333333'
  const request = (request_token: string, request_id: number) => cannedPermissionRequest({ request_token, request_id })
  const allowAll = async (params: GetPermissionParams): Promise<GetPermissionResult> =>
    cannedGetPermissionResponse({ request_token: params.request_token, decision: 'allow', decision_reason: null })
  /** The poller's line for a listed row naming no applied persona, unchanged when the persona goes mid-tick. */
  const notAppliedLine = (instance: string, key: string) =>
    `[slack] permission-poller: spawn ${instance} names no applied persona (persona=${key}) — skipping`
  const notAppliedLines = (logCalls: unknown[][]) => logLines(logCalls, 'names no applied persona')

  test.each<[string, string, () => void, string[], () => string]>([
    [
      'AC 58: D\'s DMs turned off and its prompts moved to its channel while its get is in flight: one post to the channel, no conversations.open',
      KEY_D, () => reconfigure(KEY_D, { dm: { enabled: false }, permission_prompts: D_WORK }), ['chat.postMessage'], () => D_WORK,
    ],
    [
      'AC 58: A\'s prompts moved from its channel to dm while its get is in flight: the DM with the new contact is opened and posted to',
      KEY_A, () => reconfigure(KEY_A, { dm: { enabled: true, contact: A_CONTACT }, permission_prompts: 'dm' }),
      ['conversations.open', 'chat.postMessage'], () => stubOpenedDmId(A_CONTACT),
    ],
  ])('%s; the live entry names it', async (_label, key, change, expectedMethods, expectedChannel) => {
    const persona = getPersona(key)!
    const stub = key === KEY_A ? stubA : stubD
    const ivl = startPoller(() => ({
      list: async () => ({ spawns: [checkPermRow(persona)] }),
      get: async () => {
        change()
        return getResult([request(TOKEN_A, 1)], persona)
      },
    }))
    await ivl.tick()

    expect(methods(stub)).toEqual(expectedMethods)
    if (key === KEY_A) expect(stubA.calls.conversationsOpen).toEqual([{ users: A_CONTACT }])
    expect(posts(stub).map((c) => c.channel)).toEqual([expectedChannel()])
    expect(getLivePermission(personaInstanceId(key), TOKEN_A)?.channelId).toBe(expectedChannel())
    expect(slackCalls(...[stubA, stubB, stubD].filter((s) => s !== stub))).toBe(0)
  })

  test.each<[string, PermissionRequestRow[]]>([
    ['a new request (the prompt path)', [request(TOKEN_B, 2)]],
    ['no open request (the stuck-prompt path)', []],
  ])('A removed from the applied set while its get is in flight, the row showing %s: nothing posted, the unchanged not-applied line once, and its tracked prompt is not treated as closed', async (_label, laterRows) => {
    scriptPostTs(stubA, POST_TS)
    const logCalls: unknown[][] = []
    const trail = makeTrailCapture()
    const getPermissionCalls: GetPermissionParams[] = []
    let rows = [request(TOKEN_A, 1)]
    let removeDuringGet = false
    const ivl = startPoller(() => ({
      list: async () => ({ spawns: [checkPermRow(A)] }),
      get: async () => {
        if (removeDuringGet) unapply(KEY_A)
        return getResult(rows, A)
      },
      getPermission: async (params: GetPermissionParams): Promise<GetPermissionResult> => {
        getPermissionCalls.push(params)
        return allowAll(params)
      },
    }), { log: (...args) => { logCalls.push(args) }, emitTrail: trail.emit })
    await ivl.tick()
    expect(getLivePermission(INSTANCE_A, TOKEN_A)?.messageTs).toBe(POST_TS)

    removeDuringGet = true
    rows = laterRows
    await ivl.tick()

    expect(methods(stubA)).toEqual(['chat.postMessage'])
    expect(getLivePermission(INSTANCE_A, TOKEN_B)).toBeUndefined()
    expect(notAppliedLines(logCalls)).toEqual([[notAppliedLine(INSTANCE_A, KEY_A)]])
    // TOKEN_A is missing from the row, yet it is neither closed nor updated.
    expect(getPermissionCalls).toEqual([])
    expect(getLivePermission(INSTANCE_A, TOKEN_A)).toMatchObject({ channelId: A_DEST, messageTs: POST_TS, handled: false })
    expect(rowDecisions(trail, 'reconciled_closed')).toEqual([])
    expect(slackCalls(stubB, stubD)).toBe(0)
    assertNoLeak({ logCalls, trail: trail.events }, 'removed mid-get')
  })

  /**
   * Tick once with A's row holding the new requests `rows`, running `change`
   * while the first prompt's chat.postMessage is in flight (it then answers
   * POST_TS).
   */
  async function tickChangingDuringFirstPost(
    change: () => void,
    logCalls: unknown[][],
    rows: PermissionRequestRow[] = [request(TOKEN_A, 1), request(TOKEN_B, 2)],
  ): Promise<void> {
    const first = makeDeferredWebApiCall()
    stubA.script.post.push(first.outcome)
    const ivl = startPoller(() => ({
      list: async () => ({ spawns: [checkPermRow(A)] }),
      get: async () => getResult(rows, A),
    }), { log: (...args) => { logCalls.push(args) } })
    const ticking = ivl.tick()
    for (let i = 0; i < 1000 && posts(stubA).length === 0; i++) await Promise.resolve()
    expect(posts(stubA)).toHaveLength(1)
    change()
    first.settle({ kind: 'ok', result: { ts: POST_TS } })
    await ticking
  }

  test('AC 58: A\'s destination changed between two prompts of one row: the second goes to the new destination', async () => {
    const logCalls: unknown[][] = []
    await tickChangingDuringFirstPost(() => reconfigure(KEY_A, { permission_prompts: A_WORK }), logCalls)

    expect(posts(stubA).map((c) => c.channel)).toEqual([A_DEST, A_WORK])
    expect(getLivePermission(INSTANCE_A, TOKEN_A)?.channelId).toBe(A_DEST)
    expect(getLivePermission(INSTANCE_A, TOKEN_B)?.channelId).toBe(A_WORK)
    expect(notAppliedLines(logCalls)).toEqual([])
  })

  test('A removed after the first of three prompts of one row: the other two are not posted, the unchanged not-applied line once; the first stays tracked', async () => {
    const logCalls: unknown[][] = []
    await tickChangingDuringFirstPost(() => unapply(KEY_A), logCalls, [request(TOKEN_A, 1), request(TOKEN_B, 2), request(TOKEN_C, 3)])

    expect(methods(stubA)).toEqual(['chat.postMessage'])
    expect(getLivePermission(INSTANCE_A, TOKEN_A)).toMatchObject({ channelId: A_DEST, messageTs: POST_TS })
    expect(getLivePermission(INSTANCE_A, TOKEN_B)).toBeUndefined()
    expect(getLivePermission(INSTANCE_A, TOKEN_C)).toBeUndefined()
    expect(notAppliedLines(logCalls)).toEqual([[notAppliedLine(INSTANCE_A, KEY_A)]])
    expect(slackCalls(stubB, stubD)).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// Destination failures held and retried (b.av2 SR-7.1, SR-3.2, SR-10.3; AC 44)
// ---------------------------------------------------------------------------

describe('poller tick — a destination failure holds the persona\'s prompts and retries them on backoff (b.av2 SR-7.1, SR-10.3)', () => {
  const request = (request_token: string, request_id: number) => cannedPermissionRequest({ request_token, request_id })
  const allowAll = async (params: GetPermissionParams): Promise<GetPermissionResult> =>
    cannedGetPermissionResponse({ request_token: params.request_token, decision: 'allow', decision_reason: null })

  /**
   * One destination-failure case: the persona, its stub, the failing call
   * (made to fail on every attempt until the cause clears), what the episode
   * line names, and the calls one failed and one recovered attempt make.
   */
  interface HeldCase {
    persona: () => Persona
    stub: () => StubSlack
    setup?: () => void
    method: 'open' | 'post'
    step: 'conversations.open' | 'chat.postMessage'
    destination: string
    code: string
    namesScope: boolean
    failedCalls: string[]
    recoveredCalls: string[]
    /** Where the prompt lands once the cause clears. */
    channel: () => string
    /** The `channel` a failed attempt's trail event names (none when the open failed). */
    failedChannel: string | undefined
  }

  const CASES: Array<[string, HeldCase]> = [
    [
      'AC 44: a DM-only persona with zero channels (D), first prompt, conversations.open fails missing_scope',
      {
        persona: () => D,
        stub: () => stubD,
        setup: () => reconfigure(KEY_D, { channels: [] }),
        method: 'open',
        step: 'conversations.open',
        destination: 'dm',
        code: 'missing_scope',
        namesScope: true,
        failedCalls: ['conversations.open'],
        recoveredCalls: ['conversations.open', 'chat.postMessage'],
        channel: () => D_DM,
        failedChannel: undefined,
      },
    ],
    [
      'a channel-destination persona (A), chat.postMessage fails not_in_channel',
      {
        persona: () => A,
        stub: () => stubA,
        method: 'post',
        step: 'chat.postMessage',
        destination: A_DEST,
        code: 'not_in_channel',
        namesScope: false,
        failedCalls: ['chat.postMessage'],
        recoveredCalls: ['chat.postMessage'],
        channel: () => A_DEST,
        failedChannel: A_DEST,
      },
    ],
  ]

  test.each(CASES)('%s: held — one persona-destination-failed line in all; no Slack call, trail event or line inside a backoff window; failed retries at 5 s and a further 10 s; once the cause clears the next due retry delivers the prompt exactly once and one cleared line follows', async (_label, c) => {
    c.setup?.()
    const persona = getPersona(c.persona().key)!
    const stub = c.stub()
    const instance = personaInstanceId(persona.key)
    failSticky(stub, c.method, c.code)
    const trail = makeTrailCapture()
    const logCalls: unknown[][] = []
    const { clock, hold } = makeHold(logCalls)
    const ivl = startPoller(() => ({
      list: async () => ({ spawns: [checkPermRow(persona)] }),
      get: async () => getResult([request(TOKEN_A, 1)], persona),
    }), { emitTrail: trail.emit, log: (...args) => { logCalls.push(args) }, destinationHold: hold })
    // Fires one tick at virtual time `ms` and waits one zero-delay timer: every
    // call the tick makes answers through microtasks, which all run before a
    // timer does, so the tick has settled without a real-time sleep (this test
    // drives ~40 ticks; a 10 ms sleep each made it slow enough to time out
    // under load).
    const tickAt = async (ms: number): Promise<void> => {
      await clock.advanceTo(ms)
      ivl.fire()
      await new Promise((r) => setTimeout(r, 0))
    }
    /** Ticks once a second over [from, to] and asserts nothing reached Slack, the trail or the log. */
    const expectHeldThrough = async (from: number, to: number): Promise<void> => {
      const before = { calls: stub.callLog.length, events: trail.events.length, lines: logCalls.length }
      for (let ms = from; ms <= to; ms += 1000) await tickAt(ms)
      expect({ calls: stub.callLog.length, events: trail.events.length, lines: logCalls.length }).toEqual(before)
    }
    const failedAttempts = (n: number): string[] => Array.from({ length: n }, () => c.failedCalls).flat()
    const expectFailedAttemptTrail = (n: number): void => {
      expect(rowDecisions(trail, 'post_attempted')).toHaveLength(n)
      const events = chatPosts(trail)
      expect(events).toHaveLength(n)
      for (const event of events) {
        expect(event).toMatchObject({ claude_instance_id: instance, request_token: TOKEN_A, ok: false, error: c.code })
        if (c.failedChannel === undefined) expect('channel' in event).toBe(false)
        else expect(event.channel).toBe(c.failedChannel)
      }
    }

    // t=0: the first attempt fails; the episode opens with its one line.
    await tickAt(0)
    expect(methods(stub)).toEqual(failedAttempts(1))
    expectFailedAttemptTrail(1)
    expectOneEpisodeLine(logCalls, trail, persona, c)
    expect(hold.view(persona.key)).toEqual({ held: true, heldNotices: 0, nextDueAt: 5000 })

    // Inside the 5 s backoff: nothing.
    await expectHeldThrough(1000, 4000)

    // t=5 s: the first retry, still failing; the next one is 10 s on.
    await tickAt(5000)
    expect(methods(stub)).toEqual(failedAttempts(2))
    expectFailedAttemptTrail(2)
    expect(hold.view(persona.key).nextDueAt).toBe(15_000)
    await expectHeldThrough(6000, 14_000)

    // t=15 s: the second retry, still failing; the next one is 20 s on.
    await tickAt(15_000)
    expect(methods(stub)).toEqual(failedAttempts(3))
    expectFailedAttemptTrail(3)
    expect(hold.view(persona.key).nextDueAt).toBe(35_000)
    expectOneEpisodeLine(logCalls, trail, persona, c)

    // The cause clears (the scope is granted, the bot is invited), but the
    // persona stays held until its retry is due.
    clearSticky(stub, c.method)
    scriptPostTs(stub, POST_TS)
    const postsBeforeClear = posts(stub).length
    await expectHeldThrough(16_000, 34_000)
    expect(getLivePermission(instance, TOKEN_A)).toBeUndefined()

    // t=35 s: the due retry delivers the prompt, once, on the persona's client.
    await tickAt(35_000)
    expect(methods(stub)).toEqual([...failedAttempts(3), ...c.recoveredCalls])
    expect(posts(stub).slice(postsBeforeClear).map((call) => call.channel)).toEqual([c.channel()])
    expect(getLivePermission(instance, TOKEN_A)).toMatchObject({ personaKey: persona.key, channelId: c.channel(), messageTs: POST_TS })
    expect(chatPosts(trail).at(-1)).toMatchObject({ ok: true, channel: c.channel(), slack_ts: POST_TS, request_token: TOKEN_A })
    expect(rowDecisions(trail, 'post_attempted')).toHaveLength(4)
    expect(hold.view(persona.key)).toEqual({ held: false, heldNotices: 0, nextDueAt: undefined })

    // One episode: its opening line and one cleared line; no per-attempt line.
    const episode = episodeLines(logCalls).map((args) => String(args[0]))
    expect(episode).toHaveLength(2)
    expect(clearedLines(logCalls)).toHaveLength(1)
    expect(episode[1]).toBe(
      `[slack] ${EPISODE_CLASS}: personas[${persona.index}] ${renderPersonaRef(persona.name, persona.key)}: ` +
        `cleared: destination=${c.destination} accepts posts again (was ${c.step} error ${c.code}); delivering what was held`,
    )
    expect(pollerFailureLines(logCalls)).toEqual([])

    // Tracked now: later ticks make no Slack call.
    await tickAt(36_000)
    await tickAt(37_000)
    expect(methods(stub)).toHaveLength(failedAttempts(3).length + c.recoveredCalls.length)
    expect(rowDecisions(trail, 'already_tracked')).toHaveLength(2)
    for (const other of [stubA, stubB, stubD].filter((s) => s !== stub)) expect(other.callLog).toEqual([])
    assertNoLeak({ logCalls, trail: trail.events }, 'held prompt')
  })

  test.each<[string, 'posts' | 'channel_not_found']>([
    ['the cause clears: the retry due at 5 s posts once, to A_WORK', 'posts'],
    ['A_WORK fails channel_not_found at 5 s: one more opening line naming A_WORK; the retry due at 15 s posts once, to A_WORK', 'channel_not_found'],
  ])('a prompt held at A_DEST when permission_prompts changes in place to A_WORK — %s; it is tracked there (its closing update goes to A_WORK) and the cleared line names A_WORK', async (_label, atWork) => {
    failSticky(stubA, 'post', 'not_in_channel')
    const trail = makeTrailCapture()
    const logCalls: unknown[][] = []
    const { clock, hold } = makeHold(logCalls)
    let rows = [request(TOKEN_A, 1)]
    const ivl = startPoller(() => ({
      list: async () => ({ spawns: [checkPermRow(A)] }),
      get: async () => getResult(rows, A),
      getPermission: allowAll,
    }), { emitTrail: trail.emit, log: (...args) => { logCalls.push(args) }, destinationHold: hold })
    // One tick at virtual time `ms`, settled through one zero-delay timer (see the test above).
    const tickAt = async (ms: number): Promise<void> => {
      await clock.advanceTo(ms)
      ivl.fire()
      await new Promise((r) => setTimeout(r, 0))
    }
    const expectHeldThrough = async (from: number, to: number): Promise<void> => {
      const before = { calls: stubA.callLog.length, events: trail.events.length, lines: logCalls.length }
      for (let ms = from; ms <= to; ms += 1000) await tickAt(ms)
      expect({ calls: stubA.callLog.length, events: trail.events.length, lines: logCalls.length }).toEqual(before)
    }
    const prefix = `[slack] ${EPISODE_CLASS}: personas[${A.index}] ${renderPersonaRef(NAME_A, KEY_A)}: `
    const opening = (destination: string, code: string) =>
      `${prefix}chat.postMessage failed for destination=${destination} with error ${code}; ` +
      'holding its permission prompts and notices and retrying with backoff'
    const cleared = (destination: string, code: string) =>
      `${prefix}cleared: destination=${destination} accepts posts again (was chat.postMessage error ${code}); delivering what was held`
    const episode = () => episodeLines(logCalls).map((args) => String(args[0]))

    // t=0: the post to A_DEST fails; the episode opens naming A_DEST.
    await tickAt(0)
    expect(posts(stubA).map((c) => c.channel)).toEqual([A_DEST])
    expect(episode()).toEqual([opening(A_DEST, 'not_in_channel')])
    expect(hold.view(KEY_A).nextDueAt).toBe(5000)

    // The destination changes in place; the cause at A_DEST clears too.
    reconfigure(KEY_A, { permission_prompts: A_WORK })
    clearSticky(stubA, 'post')
    if (atWork === 'channel_not_found') stubA.script.post.push({ kind: 'platform', error: 'channel_not_found' })
    scriptPostTs(stubA, POST_TS)
    await expectHeldThrough(1000, 4000)

    // t=5 s: the due retry is exactly one post, to the new destination.
    await tickAt(5000)
    expect(posts(stubA).map((c) => c.channel)).toEqual([A_DEST, A_WORK])
    let dueAt = 5000
    if (atWork === 'channel_not_found') {
      expect(episode()).toEqual([opening(A_DEST, 'not_in_channel'), opening(A_WORK, 'channel_not_found')])
      expect(getLivePermission(INSTANCE_A, TOKEN_A)).toBeUndefined()
      expect(hold.view(KEY_A)).toEqual({ held: true, heldNotices: 0, nextDueAt: 15_000 })
      await expectHeldThrough(6000, 14_000)
      dueAt = 15_000
      await tickAt(dueAt)
      expect(posts(stubA).map((c) => c.channel)).toEqual([A_DEST, A_WORK, A_WORK])
      expect(episode()).toEqual([
        opening(A_DEST, 'not_in_channel'),
        opening(A_WORK, 'channel_not_found'),
        cleared(A_WORK, 'channel_not_found'),
      ])
    } else {
      expect(episode()).toEqual([opening(A_DEST, 'not_in_channel'), cleared(A_WORK, 'not_in_channel')])
    }
    expect(getLivePermission(INSTANCE_A, TOKEN_A)).toMatchObject({ personaKey: KEY_A, channelId: A_WORK, messageTs: POST_TS })
    expect(hold.view(KEY_A)).toEqual({ held: false, heldNotices: 0, nextDueAt: undefined })
    expect(pollerFailureLines(logCalls)).toEqual([])

    // The request closes: its closing update goes where the prompt was posted.
    rows = []
    await tickAt(dueAt + 1000)
    expect(updates(stubA).map((c) => [c.channel, c.ts])).toEqual([[A_WORK, POST_TS]])
    expect(posts(stubA)).toHaveLength(atWork === 'posts' ? 2 : 3)
    expect(slackCalls(stubB, stubD)).toBe(0)
    assertNoLeak({ logCalls, trail: trail.events }, 'held prompt, destination changed')
  })

  test('AC 44: the missing_scope line names the persona and the im:write scope, and tells the operator to re-install the app with it', async () => {
    reconfigure(KEY_D, { channels: [] })
    failSticky(stubD, 'open', 'missing_scope')
    const trail = makeTrailCapture()
    const logCalls: unknown[][] = []
    const { hold } = makeHold(logCalls)
    const ivl = startPoller(() => ({
      list: async () => ({ spawns: [checkPermRow(D)] }),
      get: async () => getResult([request(TOKEN_A, 1)], D),
    }), { emitTrail: trail.emit, log: (...args) => { logCalls.push(args) }, destinationHold: hold })
    await ivl.tick()

    expect(episodeLines(logCalls).map((args) => args[0])).toEqual([
      `[slack] ${EPISODE_CLASS}: personas[${D.index}] ${renderPersonaRef(NAME_D, KEY_D)}: ` +
        'conversations.open failed for destination=dm with error missing_scope — the Slack app lacks the im:write scope: ' +
        're-install the app with im:write to grant it; holding its permission prompts and notices and retrying with backoff',
    ])
  })

  test('two personas: D held on missing_scope does not hold B — B\'s prompt posts in the tick it is raised, both in the tick that opens D\'s episode and in a later held tick', async () => {
    failSticky(stubD, 'open', 'missing_scope')
    scriptPostTs(stubB, POST_TS, POST_TS_2)
    const trail = makeTrailCapture()
    const logCalls: unknown[][] = []
    const { clock, hold } = makeHold(logCalls)
    let bRows = [request(TOKEN_A, 1)]
    const ivl = startPoller(() => ({
      list: async () => ({ spawns: [checkPermRow(D), checkPermRow(B)] }),
      get: async (p: { claude_instance_id: string }) =>
        p.claude_instance_id === INSTANCE_D ? getResult([request(TOKEN_A, 1)], D) : getResult(bRows, B),
    }), { emitTrail: trail.emit, log: (...args) => { logCalls.push(args) }, destinationHold: hold })

    // t=0: D's open fails first in the tick; B's prompt still posts.
    await ivl.tick()
    expect(methods(stubD)).toEqual(['conversations.open'])
    expect(posts(stubB).map((c) => c.channel)).toEqual([B_DEST])
    expect(getLivePermission(INSTANCE_B, TOKEN_A)).toMatchObject({ personaKey: KEY_B, channelId: B_DEST, messageTs: POST_TS })
    expectOneEpisodeLine(logCalls, trail, D, { step: 'conversations.open', destination: 'dm', code: 'missing_scope', namesScope: true })
    expect(hold.view(KEY_B).held).toBe(false)

    // t=2 s, D still held: B's new prompt posts in the tick it is raised; D makes no call.
    await clock.advanceTo(2000)
    bRows = [...bRows, request(TOKEN_B, 2)]
    await ivl.tick()
    expect(methods(stubD)).toEqual(['conversations.open'])
    expect(posts(stubB)).toHaveLength(2)
    expect(getLivePermission(INSTANCE_B, TOKEN_B)).toMatchObject({ personaKey: KEY_B, channelId: B_DEST, messageTs: POST_TS_2 })
    expect(chatPosts(trail).map((e) => [e.claude_instance_id, e['ok']])).toEqual([
      [INSTANCE_D, false],
      [INSTANCE_B, true],
      [INSTANCE_B, true],
    ])
    // The one line names D only.
    expect(episodeLines(logCalls)).toHaveLength(1)
    expect(String(episodeLines(logCalls)[0][0])).not.toContain(KEY_B)
    expect(slackCalls(stubA)).toBe(0)
  })

  test('a request that closes while its persona is held is never posted: no post and no closing update after the cause clears; a later request posts', async () => {
    failSticky(stubD, 'open', 'missing_scope')
    const trail = makeTrailCapture()
    const logCalls: unknown[][] = []
    const getPermissionCalls: GetPermissionParams[] = []
    const { clock, hold } = makeHold(logCalls)
    let rows = [request(TOKEN_A, 1)]
    const ivl = startPoller(() => ({
      list: async () => ({ spawns: [checkPermRow(D)] }),
      get: async () => getResult(rows, D),
      getPermission: async (params: GetPermissionParams): Promise<GetPermissionResult> => {
        getPermissionCalls.push(params)
        return allowAll(params)
      },
    }), { emitTrail: trail.emit, log: (...args) => { logCalls.push(args) }, destinationHold: hold })

    await ivl.tick()
    expect(methods(stubD)).toEqual(['conversations.open'])

    // The request closes (it leaves the agent-director row) while D is held.
    await clock.advanceTo(1000)
    rows = []
    await ivl.tick()

    // The cause clears and the retry falls due: nothing is posted or updated for it.
    clearSticky(stubD, 'open')
    for (const ms of [5000, 6000, 20_000]) {
      await clock.advanceTo(ms)
      await ivl.tick()
    }
    expect(methods(stubD)).toEqual(['conversations.open'])
    expect(stubD.calls.update).toHaveLength(0)
    expect(getPermissionCalls).toEqual([])
    expect(getLivePermission(INSTANCE_D, TOKEN_A)).toBeUndefined()
    expect(rowDecisions(trail, 'reconciled_closed')).toHaveLength(0)
    expect(chatPosts(trail).filter((e) => e.request_token === TOKEN_A)).toHaveLength(1)

    // A later request posts in the DM, and only it.
    scriptPostTs(stubD, POST_TS)
    rows = [request(TOKEN_B, 2)]
    await clock.advanceTo(21_000)
    await ivl.tick()
    expect(methods(stubD)).toEqual(['conversations.open', 'conversations.open', 'chat.postMessage'])
    expect(posts(stubD).map((c) => c.channel)).toEqual([D_DM])
    expect(getLivePermission(INSTANCE_D, TOKEN_B)).toMatchObject({ channelId: D_DM, messageTs: POST_TS })
    expect(clearedLines(logCalls)).toHaveLength(1)
  })

  test.each(['invalid_blocks', 'msg_too_long'])('a prompt whose post fails with %s (the message, not the destination) is not held: one per-attempt log line and trail event, tried again on the next tick with no backoff; no persona-destination-failed line; the persona\'s other prompts and notices still post', async (error) => {
    // A's posts, in order: TOKEN_A fails, TOKEN_B posts (same tick), the
    // notice posts, TOKEN_A fails again (next tick), TOKEN_A posts.
    stubA.script.post.push(
      { kind: 'platform', error },
      { kind: 'ok', result: { ts: POST_TS_2 } },
      { kind: 'ok', result: { ts: 'TSNOTICE' } },
      { kind: 'platform', error },
      { kind: 'ok', result: { ts: POST_TS } },
    )
    const trail = makeTrailCapture()
    const logCalls: unknown[][] = []
    const { hold } = makeHold(logCalls)
    const ivl = startPoller(() => ({
      list: async () => ({ spawns: [checkPermRow(A)] }),
      get: async () => getResult([request(TOKEN_A, 1), request(TOKEN_B, 2)], A),
    }), { emitTrail: trail.emit, log: (...args) => { logCalls.push(args) }, destinationHold: hold })
    const failureLines = () => logLines(logCalls, `chat.postMessage failed for ${INSTANCE_A}`)

    // Tick 1: TOKEN_A fails, logged and trailed per attempt; TOKEN_B, after it, posts.
    await ivl.tick()
    expect(posts(stubA).map((c) => c.channel)).toEqual([A_DEST, A_DEST])
    expect(getLivePermission(INSTANCE_A, TOKEN_A)).toBeUndefined()
    expect(getLivePermission(INSTANCE_A, TOKEN_B)).toMatchObject({ channelId: A_DEST, messageTs: POST_TS_2 })
    expectTokenSafeFailure(logCalls, trail, `chat.postMessage failed for ${INSTANCE_A}`, { kind: 'platform', error })
    expect(hold.view(KEY_A)).toEqual({ held: false, heldNotices: 0, nextDueAt: undefined })

    // A notice for A goes out at once.
    await hold.deliver(A, clients.clientFor(KEY_A)!, { message: { text: 'a notice' }, summary: 'a notice' })
    expect(posts(stubA).map((c) => [c.channel, c.text])).toEqual([
      [A_DEST, expect.any(String)],
      [A_DEST, expect.any(String)],
      [A_DEST, 'a notice'],
    ])

    // Tick 2, no time passed: TOKEN_A is tried again at once and fails again.
    await ivl.tick()
    expect(posts(stubA)).toHaveLength(4)
    expect(failureLines()).toHaveLength(2)
    expect(String(failureLines()[1][0])).toContain(`(reason=${error})`)

    // Tick 3: it posts.
    await ivl.tick()
    expect(posts(stubA)).toHaveLength(5)
    expect(getLivePermission(INSTANCE_A, TOKEN_A)).toMatchObject({ channelId: A_DEST, messageTs: POST_TS })

    expect(chatPosts(trail).filter((e) => e.request_token === TOKEN_A).map((e) => [e['ok'], e['error']])).toEqual([
      [false, error],
      [false, error],
      [true, undefined],
    ])
    expect(rowDecisions(trail, 'post_attempted').filter((e) => e.request_token === TOKEN_A)).toHaveLength(3)
    expect(episodeLines(logCalls)).toEqual([])
    assertNoLeak({ logCalls, trail: trail.events }, 'payload error')
  })
})

// ---------------------------------------------------------------------------
// A throw inside a tick while a persona's retry is due (b.av2 SR-7.1)
// ---------------------------------------------------------------------------

/**
 * The poller's tick has no catch: a row the prompt builder rejects, or a
 * throwing trail emitter or logger, ends the tick at that row and rejects the
 * interval's fire-and-forget promise (in production, the server's
 * `unhandledRejection` handler logs it). `bun test` fails any test that leaves
 * an unhandled rejection, so these cases run in a child `bun` process
 * (`runInFakeHome`, temp HOME and state dir, no token variables) that counts
 * the rejections itself and prints one `RESULT::` JSON line.
 *
 * The child starts the real poller on a manual interval over the real hold
 * (fake clock, one tick per virtual second), the real resolver and one
 * `makeStubSlack` stub per persona, A (destination A_DEST) and B (B_DEST). A's
 * first prompt fails `not_in_channel` at t=0 and opens its episode (retry due
 * at 5 s). Scenarios:
 * - `bad-instance`, `empty-token`: at t=5 s the listing is a row the builder
 *   rejects (an instance ID without the `cscb_` prefix, or an empty
 *   `request_token`) for A, then B's row.
 * - `trail-throws`: at t=5 s A's valid row, then B's; the trail emitter throws
 *   once, on A's `post_attempted` row decision (after the attempt is begun).
 * - `wedge-log-throws`: A's request closes and its spawn stays wedged; at the
 *   trip (t=90 s, the retry due) the logger throws once, on the "wedged" line
 *   written after the warning's attempt is begun.
 *
 * Neither a rejected row nor a throw after the attempt is begun may leave the
 * persona held with no timer: at t=6 s A's valid prompt posts on the retry
 * still due (and B's with it), or for the wedge the warning posts at the next
 * throttle window (t=120 s).
 */
describe('poller tick — a throw while a persona\'s retry is due leaves it retrying (b.av2 SR-7.1)', () => {
  const POLLER_PATH = join(import.meta.dir, '..', 'src', 'permission-poller.ts')
  const REPO_ROOT = join(import.meta.dir, '..')

  const CHILD = `
    const R = input.root
    const { createPersonaDestinationHold } = await import(R + '/src/persona-destination-hold.ts')
    const { createPersonaDestinations } = await import(R + '/src/persona-destination.ts')
    const { initOutageState } = await import(R + '/src/outage-state.ts')
    const { personaInstanceId } = await import(R + '/src/persona-identity.ts')
    const { createFakeClock } = await import(R + '/tests/test-helpers/fake-clock.ts')
    const { makeStubSlack } = await import(R + '/tests/test-helpers/slack-stub.ts')
    const { makeManualInterval, makePersonaClients } = await import(R + '/tests/test-helpers/permission-relay-harness.ts')
    const ad = await import(R + '/tests/test-helpers/agent-director-stub.ts')
    const { makeMultiPersonaConfig } = await import(R + '/tests/test-helpers/persona-config.ts')

    const rejections = []
    process.on('unhandledRejection', (err) => { rejections.push(String(err && err.message ? err.message : err)) })
    initOutageState({ getClient: () => ({}), notify: () => {} })

    const config = makeMultiPersonaConfig([
      { name: input.nameA, channels: [{ id: input.destA, delivery: 'all' }] },
      { name: input.nameB, channels: [{ id: input.destB, delivery: 'all' }] },
    ], input.personaDir)
    const [A, B] = config.personas
    const getPersona = (key) => config.personas.find((p) => p.key === key)
    const stubs = { [A.key]: makeStubSlack(), [B.key]: makeStubSlack() }
    const clients = makePersonaClients((key) => stubs[key])
    const clock = createFakeClock()
    const lines = []
    let throwOnWedgedLine = false
    const log = (...args) => {
      const line = args.map(String).join(' ')
      if (throwOnWedgedLine && line.includes('wedged in check_permission')) {
        throwOnWedgedLine = false
        throw new Error('injected: log write failed')
      }
      lines.push(line)
    }
    const hold = createPersonaDestinationHold({
      destinations: createPersonaDestinations({ log }), getPersona, clientFor: clients.clientFor, clock, log,
    })
    let throwOnPostAttempted = false
    const emitTrail = (event) => {
      if (throwOnPostAttempted && event.event === 'cscb.poller.row_decision' && event.action === 'post_attempted') {
        throwOnPostAttempted = false
        throw new Error('injected: trail write failed')
      }
    }

    const instanceA = personaInstanceId(A.key)
    const instanceB = personaInstanceId(B.key)
    const row = (persona, id) => ad.cannedListRow(
      id === undefined ? { state: 'check_permission' } : { state: 'check_permission', claude_instance_id: id },
      persona, input.personaDir)
    const request = (request_token, request_id) => ad.cannedPermissionRequest({ request_token, request_id })
    let spawns = [row(A)]
    let open = { [instanceA]: [request(input.tokenA, 1)] }
    const ivl = makeManualInterval()
    mod.startPermissionPoller({
      intervalMs: 1000,
      getClient: () => ({
        list: async () => ({ spawns }),
        get: async (p) => ad.cannedGetResult(
          { state: 'check_permission', claude_instance_id: p.claude_instance_id, permission_requests: open[p.claude_instance_id] || [] },
          p.claude_instance_id === instanceB ? B : A, input.personaDir),
      }),
      clientFor: clients.clientFor, getPersona, isPersonaUp: () => true,
      setInterval: ivl.setInterval, clearInterval: ivl.clearInterval,
      destinationHold: hold, log, emitTrail,
    })

    const posts = (persona) => stubs[persona.key].calls.postMessage.length
    const snapshot = () => ({
      rejections: rejections.length,
      postsA: posts(A),
      postsB: posts(B),
      liveA: mod.getLivePermission(instanceA, input.tokenA) !== undefined,
      liveB: mod.getLivePermission(instanceB, input.tokenB) !== undefined,
      heldA: hold.view(A.key).held,
      warnings: stubs[A.key].calls.postMessage.filter((c) => String(c.text).includes('blocked on a native')).length,
    })
    const tickAt = async (ms) => {
      await clock.advanceTo(ms)
      ivl.fire()
      await new Promise((r) => setTimeout(r, 0))
      await new Promise((r) => setTimeout(r, 0))
    }

    stubs[A.key].script.post.push({ kind: 'platform', error: 'not_in_channel' })
    const result = {}
    await tickAt(0)
    result.opened = snapshot()

    if (input.scenario === 'wedge-log-throws') {
      open = {}
      throwOnWedgedLine = true
      const k = mod.wedgeTripTicks(1000)
      for (let n = 1; n < k; n++) await tickAt(n * 1000)
      result.beforeTrip = snapshot()
      await tickAt(k * 1000)
      result.threw = snapshot()
      for (let n = k + 1; n < k + 30; n++) await tickAt(n * 1000)
      result.beforeWindow = snapshot()
      await tickAt((k + 30) * 1000)
      result.after = snapshot()
    } else {
      if (input.scenario === 'bad-instance') {
        spawns = [row(A, 'no_prefix_instance'), row(B)]
        open = { no_prefix_instance: [request(input.tokenA, 1)], [instanceB]: [request(input.tokenB, 2)] }
      } else if (input.scenario === 'empty-token') {
        spawns = [row(A), row(B)]
        open = { [instanceA]: [request('', 1)], [instanceB]: [request(input.tokenB, 2)] }
      } else {
        spawns = [row(A), row(B)]
        open = { [instanceA]: [request(input.tokenA, 1)], [instanceB]: [request(input.tokenB, 2)] }
        throwOnPostAttempted = true
      }
      await tickAt(5000)
      result.threw = snapshot()
      spawns = [row(A), row(B)]
      open = { [instanceA]: [request(input.tokenA, 1)], [instanceB]: [request(input.tokenB, 2)] }
      await tickAt(6000)
      result.after = snapshot()
    }
    result.rejectionMessages = rejections
    mod.stopPermissionPoller()
    process.stdout.write('RESULT::' + JSON.stringify(result) + '\\n')
  `

  interface Snapshot {
    rejections: number
    postsA: number
    postsB: number
    liveA: boolean
    liveB: boolean
    heldA: boolean
    warnings: number
  }
  type ChildResult = Record<'opened' | 'threw' | 'after', Snapshot> & {
    beforeTrip?: Snapshot
    beforeWindow?: Snapshot
    rejectionMessages: string[]
  }

  function runScenario(scenario: string): ChildResult {
    const home = mkdtempSync(join(tmpdir(), 'poller-throw-home-'))
    try {
      const res = runInFakeHome({
        modulePath: POLLER_PATH,
        call: CHILD,
        input: {
          scenario,
          root: REPO_ROOT,
          personaDir,
          nameA: NAME_A,
          nameB: NAME_B,
          destA: A_DEST,
          destB: B_DEST,
          tokenA: TOKEN_A,
          tokenB: TOKEN_B,
        },
        home,
        stateDir: join(home, 'state'),
        timeoutMs: 60_000,
      })
      expect(res.observedHomedir).toBe(home)
      expect(res.stderr).toBe('')
      expect(res.status).toBe(0)
      const line = res.stdout.split('\n').find((l) => l.startsWith('RESULT::'))
      expect(line).toBeDefined()
      assertNoLeak({ stdout: res.stdout, stderr: res.stderr }, `child ${scenario}`)
      return JSON.parse(line!.slice('RESULT::'.length)) as ChildResult
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  }

  test.each<[string, string, string]>([
    ['a row whose instance ID lacks the cscb_ prefix (the builder rejects it)', 'bad-instance', 'must start with \'cscb_\''],
    ['a row with an empty request_token (the builder rejects it)', 'empty-token', 'request_token must be a non-empty string'],
    ['a trail emitter that throws on the post_attempted row decision, after the attempt is begun', 'trail-throws', 'injected: trail write failed'],
  ])('at A\'s due retry, %s: the tick ends at that row with one rejection and B\'s row after it waits; on the next tick A\'s prompt posts on the retry still due and B\'s posts', (_label, scenario, message) => {
    const r = runScenario(scenario)
    // t=0: A's prompt failed and opened its episode.
    expect(r.opened).toMatchObject({ rejections: 0, postsA: 1, postsB: 0, liveA: false, heldA: true })
    // t=5 s: one rejection; nothing posted, B's later row included.
    expect(r.threw).toMatchObject({ rejections: 1, postsA: 1, postsB: 0, liveA: false, liveB: false, heldA: true })
    expect(r.rejectionMessages).toHaveLength(1)
    expect(r.rejectionMessages[0]).toContain(message)
    // t=6 s: A is not wedged — its prompt posts and clears the episode; B posts too.
    expect(r.after).toMatchObject({ rejections: 1, postsA: 2, postsB: 1, liveA: true, liveB: true, heldA: false })
  }, 60_000)

  test('at A\'s due retry, a logger that throws on the stuck-prompt "wedged" line (after the warning\'s attempt is begun): one rejection and no warning; the warning posts at the next throttle window and clears the episode', () => {
    const r = runScenario('wedge-log-throws')
    expect(r.opened).toMatchObject({ rejections: 0, postsA: 1, heldA: true })
    expect(r.beforeTrip).toMatchObject({ rejections: 0, postsA: 1, warnings: 0, heldA: true })
    expect(r.threw).toMatchObject({ rejections: 1, postsA: 1, warnings: 0, heldA: true })
    expect(r.rejectionMessages).toEqual(['injected: log write failed'])
    expect(r.beforeWindow).toMatchObject({ rejections: 1, warnings: 0, heldA: true })
    expect(r.after).toMatchObject({ rejections: 1, postsA: 2, warnings: 1, heldA: false })
  }, 60_000)
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
      isPersonaUp: () => true,
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

  // The last row's Slack error is a token-shaped string (b.av2 SR-10.3): the
  // trail and the episode line carry `unknown_error`, never the raw code.
  test.each<[string, SlackFailureRow, string]>([
    ['platform channel_not_found', { kind: 'platform', error: 'channel_not_found' }, 'channel_not_found'],
    ['network', { kind: 'network' }, 'network_error'],
    ['platform, a token-shaped error code', { kind: 'platform', error: fakeToken(BOT_TOKEN_PREFIX, 'code') }, 'unknown_error'],
  ])('cscb.chat_post.attempted on Slack failure (%s) carries the token-safe error class, not Error.name; one token-safe persona-destination-failed line; no live entry', async (_label, outcome, errorClass) => {
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
    // b.emk: the failure is visible in server.log beside the trail event, as
    // the destination-failure episode line (b.av2 SR-10.3).
    expectOneEpisodeLine(logCalls, trail, A, { step: 'chat.postMessage', destination: A_DEST, code: errorClass, namesScope: false })
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
// AC 20 (b.av2 SR-10.3): an agent-director call that fails with an error that
// is not an agent-director error is logged as its description (type, safe
// code, the message logged redacted, frames), never the error itself, on each
// of the poller's three read sites. The error carries fake tokens and a
// WebSocket ticket URL in its message, and the leak sentinel in a property. An
// agent-director error is logged by its errName and its redacted description
// when that errName passes `isSafeIdentifier`; a token-shaped errName falls
// back to the description (E14 Task 0, operator decision B1).
// ---------------------------------------------------------------------------

describe('AC 20: an agent-director call failure on list, get or getPermission is logged with its message redacted', () => {
  /** A ticket URL shaped like Slack's Socket Mode WebSocket URL, holding the leak sentinel. */
  const sentinelError = (): Error =>
    Object.assign(new Error(`socket closed ${sentinelInMessage('msg')}`), { code: 'ECONNRESET', note: LEAK_SENTINEL })
  /** An agent-director error whose errName (and so its message) is a fake token. */
  const tokenErrNameError = (): Error => errGeneric('get', fakeToken(BOT_TOKEN_PREFIX, 'errname'), 'transient')
  /** An agent-director error with a safe errName whose description quotes a fake token and a ticket URL. */
  const safeErrNameError = (): Error =>
    errGeneric('get', 'ErrDaemonBusy', `retry later ${sentinelInMessage('desc')}`)
  const redactedSocket = `message="socket closed ${REDACTED_SENTINEL_TAIL}"`

  test.each<{ site: 'list' | 'get' | 'getPermission'; label: string; makeErr: () => Error; tail: string }>([
    { site: 'list', label: 'an error carrying fake tokens', makeErr: sentinelError, tail: `list failed: Error code=ECONNRESET ${redactedSocket} at ` },
    { site: 'get', label: 'an error carrying fake tokens', makeErr: sentinelError, tail: `get failed for ${INSTANCE_A}: Error code=ECONNRESET ${redactedSocket} at ` },
    { site: 'getPermission', label: 'an error carrying fake tokens', makeErr: sentinelError, tail: `get-permission failed for ${INSTANCE_A} token=${TOKEN_A}: Error code=ECONNRESET ${redactedSocket} at ` },
    { site: 'get', label: 'an AgentDirectorError with a token-shaped errName', makeErr: tokenErrNameError, tail: `get failed for ${INSTANCE_A}: AgentDirectorError message="<redacted-token> transient" at ` },
    { site: 'getPermission', label: 'an AgentDirectorError with a token-shaped errName', makeErr: tokenErrNameError, tail: `get-permission failed for ${INSTANCE_A} token=${TOKEN_A}: AgentDirectorError message="<redacted-token> transient" at ` },
  ])('AC 20: $site rejects with $label — one line naming its type, safe code and redacted message; nothing logged, trailed or posted leaks', async ({ site, makeErr, tail }) => {
    const { lines, logCalls, trail } = await runFailingSite(site, makeErr)

    expect(lines).toHaveLength(1)
    expect(lines[0]).toHaveLength(1)
    expect(String(lines[0]![0])).toStartWith(`[slack] permission-poller: ${tail}`)
    assertNoLeak({ logCalls, trail: trail.events, posts: posts(stubA) })
  })

  test.each<{ site: 'get' | 'getPermission'; head: string }>([
    { site: 'get', head: `get failed for ${INSTANCE_A}` },
    { site: 'getPermission', head: `get-permission failed for ${INSTANCE_A} token=${TOKEN_A}` },
  ])('AC 20: $site rejects with an AgentDirectorError with a safe errName — the line is the errName and its redacted description, no frames; nothing leaks', async ({ site, head }) => {
    const { lines, logCalls, trail } = await runFailingSite(site, safeErrNameError)

    expect(lines).toHaveLength(1)
    expect(lines[0]).toHaveLength(1)
    expect(String(lines[0]![0])).toBe(
      `[slack] permission-poller: ${head}: ErrDaemonBusy message="retry later ${REDACTED_SENTINEL_TAIL}"`,
    )
    assertNoLeak({ logCalls, trail: trail.events, posts: posts(stubA) })
  })

  /**
   * Run the poller with `site` rejecting `makeErr()`: one tick, or two for
   * getPermission (it runs only for a posted request whose row has gone).
   * Returns the log lines matching the site's phrase, every log call and the trail.
   */
  async function runFailingSite(
    site: 'list' | 'get' | 'getPermission',
    makeErr: () => Error,
  ): Promise<{ lines: unknown[][]; logCalls: unknown[][]; trail: TrailCapture }> {
    scriptPostTs(stubA, POST_TS)
    const logCalls: unknown[][] = []
    const trail = makeTrailCapture()
    let rowsPresent = true
    const ivl = startPoller(() => ({
      list: async () => {
        if (site === 'list') throw makeErr()
        return { spawns: rowsPresent ? [checkPermRow()] : [] }
      },
      get: async () => {
        if (site === 'get') throw makeErr()
        return getResult(rowsPresent ? [cannedPermissionRequest({ request_token: TOKEN_A, request_id: 1 })] : [])
      },
      getPermission: async (): Promise<GetPermissionResult> => { throw makeErr() },
    }), { log: (...args) => { logCalls.push(args) }, emitTrail: trail.emit })

    await ivl.tick()
    rowsPresent = false
    if (site === 'getPermission') await ivl.tick()

    const phrase = site === 'list' ? 'list failed' : site === 'get' ? 'get failed for' : 'get-permission failed for'
    return { lines: logLines(logCalls, phrase), logCalls, trail }
  }
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
   * settles, then moves the destination hold's fake clock one poll interval
   * on, so tick `n` (from 1) runs at `(n - 1) * WEDGE_INTERVAL_MS` and the
   * 30 s retry throttle and the hold's 5/10/20 s backoff line up.
   */
  function makeWedgeScenario(persona: Persona = A): {
    ivl: ManualIntervalControl
    trail: TrailCapture
    logCalls: unknown[][]
    hold: PersonaDestinationHold
    setEmpty: (v: boolean) => void
    driveTicks: (n: number) => Promise<void>
  } {
    const trail = makeTrailCapture()
    const logCalls: unknown[][] = []
    const { clock, hold } = makeHold(logCalls)
    let empty = true
    const ivl = startPoller(() => ({
      list: async () => ({ spawns: [checkPermRow(persona)] }),
      get: async () => getResult(empty ? [] : [cannedPermissionRequest({ request_token: TOKEN_A })], persona),
      getPermission: async (params: GetPermissionParams): Promise<GetPermissionResult> =>
        cannedGetPermissionResponse({ request_token: params.request_token, decision: 'allow', decision_reason: null }),
    }), {
      intervalMs: WEDGE_INTERVAL_MS,
      emitTrail: trail.emit,
      log: (...args) => { logCalls.push(args) },
      destinationHold: hold,
    })
    return {
      ivl,
      trail,
      logCalls,
      hold,
      setEmpty: (v) => { empty = v },
      driveTicks: async (n) => {
        for (let i = 0; i < n; i++) {
          ivl.fire()
          await new Promise((r) => setTimeout(r, 0))
          await clock.advance(WEDGE_INTERVAL_MS)
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
    // The failures are one destination-failure episode (b.av2 SR-7.1): one
    // opening line and one cleared line, no line per failed attempt; nothing leaks.
    expect(logLines(s.logCalls, 'wedge warning postMessage failed')).toHaveLength(0)
    const episode = episodeLines(s.logCalls).map((args) => String(args[0]))
    expect(episode).toHaveLength(2)
    expect(episode[0]).toContain(`${renderPersonaRef(NAME_A, KEY_A)}: chat.postMessage failed for destination=${A_DEST} with error network_error`)
    expect(episode[1]).toContain(`${renderPersonaRef(NAME_A, KEY_A)}: cleared: destination=${A_DEST}`)
    assertNoLeak({ logCalls: s.logCalls, trail: s.trail.events }, 'wedge post failures')
  })

  test.each<[string, SlackFailureRow, string]>([
    ['platform not_in_channel', { kind: 'platform', error: 'not_in_channel' }, 'not_in_channel'],
    ['network', { kind: 'network' }, 'network_error'],
    // A token-shaped Slack error (b.av2 SR-10.3): `unknown_error`, never the raw code.
    ['platform, a token-shaped error code', { kind: 'platform', error: fakeToken(BOT_TOKEN_PREFIX, 'code') }, 'unknown_error'],
  ])('6b. wedge warning post failure (%s) → one token-safe persona-destination-failed line naming the persona (no per-attempt line), ok:false trail with the token-safe error class', async (_label, outcome, errorClass) => {
    stubA.script.post.push(outcome)
    const s = makeWedgeScenario()
    await s.driveTicks(K)

    expect(posts(stubA)).toHaveLength(1)
    const failed = wedgeTrail(s.trail)
    expect(failed).toHaveLength(1)
    expect(failed[0]['ok']).toBe(false)
    expect(failed[0]['error']).toBe(errorClass)
    expectOneEpisodeLine(s.logCalls, s.trail, A, { step: 'chat.postMessage', destination: A_DEST, code: errorClass, namesScope: false })
    expect(logLines(s.logCalls, 'wedge warning postMessage failed')).toHaveLength(0)
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

  test('9. `dm` destination: the warning opens the persona\'s DM and posts there through its client; the trail names the D…; the episode latches', async () => {
    const s = makeWedgeScenario(D)
    await s.driveTicks(K - 1)
    expect(stubD.callLog).toEqual([])
    await s.driveTicks(1)

    expect(methods(stubD)).toEqual(['conversations.open', 'chat.postMessage'])
    expect(stubD.calls.conversationsOpen).toEqual([{ users: D_CONTACT }])
    const warnings = wedgeWarnings(stubD)
    expect(warnings.map((c) => c.channel)).toEqual([D_DM])
    expect(String(warnings[0].text).startsWith(`Persona ${renderPersonaRef(NAME_D, KEY_D)}: `)).toBe(true)
    const events = wedgeTrail(s.trail)
    expect(events.map((e) => [e['claude_instance_id'], e['channel'], e['ok']])).toEqual([[INSTANCE_D, D_DM, true]])

    // Latched: nothing more across many further empty ticks.
    await s.driveTicks(K + RETRY_EVERY)
    expect(methods(stubD)).toHaveLength(2)
    expect(wedgeTrail(s.trail)).toHaveLength(1)
    expect(slackCalls(stubA, stubB)).toBe(0)
  })

  test.each<[SlackFailureRow, string]>([
    [{ kind: 'platform', error: 'user_not_found' }, 'user_not_found'],
    [{ kind: 'network' }, 'network_error'],
  ])('9b. `dm` destination, conversations.open fails (%o) → no post, one token-safe persona-destination-failed line naming the persona and `dm` (no per-attempt line), one ok:false trail event with no channel; not latched, so the next retry window opens again, posts and clears the episode', async (outcome, errorClass) => {
    stubD.script.open.push(outcome)
    const s = makeWedgeScenario(D)
    await s.driveTicks(K)

    expect(methods(stubD)).toEqual(['conversations.open'])
    const failed = wedgeTrail(s.trail)
    expect(failed).toHaveLength(1)
    expect(failed[0]).toMatchObject({ claude_instance_id: INSTANCE_D, ok: false, error: errorClass })
    expect('channel' in failed[0]).toBe(false)
    expectOneEpisodeLine(s.logCalls, s.trail, D, { step: 'conversations.open', destination: 'dm', code: errorClass, namesScope: false })

    await s.driveTicks(RETRY_EVERY)
    expect(methods(stubD)).toEqual(['conversations.open', 'conversations.open', 'chat.postMessage'])
    expect(wedgeWarnings(stubD).map((c) => c.channel)).toEqual([D_DM])
    expect(wedgeTrail(s.trail).map((e) => e['ok'])).toEqual([false, true])
    expect(clearedLines(s.logCalls)).toHaveLength(1)
    expect(episodeLines(s.logCalls)).toHaveLength(2)
  })

  test('9c. `dm` destination refused (DMs off; the loader rejects it): one refusal line per attempt naming the persona and the setting, no Slack call, no trail event and no latch; with DMs on again, a later retry posts the warning in the DM and latches', async () => {
    reconfigure(KEY_D, { dm: { enabled: false, contact: D_CONTACT } })
    const s = makeWedgeScenario(D)
    const refusals = () =>
      logLines(s.logCalls, `${renderPersonaRef(NAME_D, KEY_D)} has permission_prompts set to "dm" but dm.enabled is not true`)
    await s.driveTicks(K)
    expect(refusals()).toHaveLength(1)
    await s.driveTicks(RETRY_EVERY)
    expect(refusals()).toHaveLength(2)
    expect(slackCalls(stubA, stubB, stubD)).toBe(0)
    expect(wedgeTrail(s.trail)).toHaveLength(0)

    reconfigure(KEY_D, { dm: { enabled: true, contact: D_CONTACT } })
    await s.driveTicks(RETRY_EVERY)
    expect(methods(stubD)).toEqual(['conversations.open', 'chat.postMessage'])
    expect(wedgeWarnings(stubD).map((c) => c.channel)).toEqual([D_DM])
    await s.driveTicks(K + RETRY_EVERY)
    expect(methods(stubD)).toHaveLength(2)
    expect(wedgeTrail(s.trail).map((e) => e['ok'])).toEqual([true])
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

  // b.av2 SR-7.1: the warning is gated by the persona's destination hold. A
  // held tick makes no attempt and writes no line, and it leaves the 30 s
  // throttle alone, so the attempt comes on the first tick the hold allows.
  test('11. a stuck-prompt warning failing with not_in_channel joins the persona\'s episode (opened by a prompt): one persona-destination-failed line and no per-attempt line; a throttle window that falls inside the backoff attempts nothing and does not move the throttle; once the cause clears exactly one warning posts and the latch holds', async () => {
    failSticky(stubA, 'post', 'not_in_channel')
    const s = makeWedgeScenario()
    const wedgedLines = () => logLines(s.logCalls, 'wedged in check_permission')
    const failEvents = () => wedgeTrail(s.trail).filter((e) => e['ok'] === false)

    // Tick 1 (t=0): an open prompt fails and opens A's episode (retry due at 5 s).
    s.setEmpty(false)
    await s.driveTicks(1)
    expect(posts(stubA)).toHaveLength(1)
    expectOneEpisodeLine(s.logCalls, s.trail, A, { step: 'chat.postMessage', destination: A_DEST, code: 'not_in_channel', namesScope: false })
    expect(s.hold.view(KEY_A)).toEqual({ held: true, heldNotices: 0, nextDueAt: 5000 })

    // The request closes; the spawn stays wedged. Tick 1 + K (t=90 s) trips;
    // the retry is due, so the warning is attempted and fails: no second line.
    s.setEmpty(true)
    await s.driveTicks(K)
    expect(wedgeWarnings(stubA)).toHaveLength(1)
    expect(failEvents().map((e) => e['error'])).toEqual(['not_in_channel'])
    expect(s.hold.view(KEY_A).nextDueAt).toBe(100_000) // 10 s after the failure at 90 s.

    // Two throttled retries (t=120 s, t=150 s), both due, both failing.
    await s.driveTicks(RETRY_EVERY)
    expect(wedgeWarnings(stubA)).toHaveLength(2)
    await s.driveTicks(RETRY_EVERY)
    expect(wedgeWarnings(stubA)).toHaveLength(3)
    expect(s.hold.view(KEY_A).nextDueAt).toBe(190_000) // 40 s after the failure at 150 s.
    expect(wedgedLines()).toHaveLength(3)

    // The next throttle window opens at t=180 s, inside the 40 s backoff: no
    // attempt, no "wedged" line and no trail event through t=189 s.
    await s.driveTicks(RETRY_EVERY + 9)
    expect(wedgeWarnings(stubA)).toHaveLength(3)
    expect(wedgedLines()).toHaveLength(3)
    expect(failEvents()).toHaveLength(3)

    // The cause clears; at t=190 s (the retry due, only 10 ticks after the
    // held window, as the throttle did not move) exactly one warning posts.
    clearSticky(stubA, 'post')
    await s.driveTicks(1)
    expect(wedgeWarnings(stubA)).toHaveLength(4)
    expect(wedgeTrail(s.trail).map((e) => e['ok'])).toEqual([false, false, false, true])
    expect(wedgeWarnings(stubA).map((c) => c.channel)).toEqual([A_DEST, A_DEST, A_DEST, A_DEST])
    expect(s.hold.view(KEY_A).held).toBe(false)

    // Latched: nothing more across many further empty ticks.
    await s.driveTicks(K + RETRY_EVERY)
    expect(posts(stubA)).toHaveLength(5) // the prompt + three failed warnings + the posted one
    expect(wedgeTrail(s.trail)).toHaveLength(4)
    expect(wedgedLines()).toHaveLength(4)

    // One episode: its opening line and its cleared line, no per-attempt line.
    const episode = episodeLines(s.logCalls).map((args) => String(args[0]))
    expect(episode).toHaveLength(2)
    expect(episode[1]).toContain(`${renderPersonaRef(NAME_A, KEY_A)}: cleared: destination=${A_DEST} accepts posts again (was chat.postMessage error not_in_channel)`)
    expect(pollerFailureLines(s.logCalls)).toEqual([])
    expect(slackCalls(stubB, stubD)).toBe(0)
    assertNoLeak({ logCalls: s.logCalls, trail: s.trail.events }, 'wedge warning held')
  })

  // The warning's attempt is taken from the hold at the due retry, then the
  // client turns out to be unavailable: the attempt must be given back
  // (released), or the persona would stay held with no timer and nothing
  // would ever post for it again.
  test('12. a stuck-prompt warning whose due retry finds the persona\'s client unavailable gives its attempt back: the schedule does not move, and once the client returns and the cause clears exactly one warning posts, the episode clears and a later prompt posts', async () => {
    failSticky(stubA, 'post', 'not_in_channel')
    const s = makeWedgeScenario()
    const noClient = () => logLines(s.logCalls, 'stuck-prompt warning for')

    // Tick 1 (t=0): an open prompt fails and opens A's episode (retry due at 5 s).
    s.setEmpty(false)
    await s.driveTicks(1)
    expect(posts(stubA)).toHaveLength(1)
    expect(s.hold.view(KEY_A)).toEqual({ held: true, heldNotices: 0, nextDueAt: 5000 })

    // The request closes and A's client goes away. Tick 1 + K (t=90 s) trips
    // with the retry due: no client, so no Slack call, no trail event, one line.
    s.setEmpty(true)
    clients.setUnavailable(KEY_A)
    await s.driveTicks(K)
    expect(noClient()).toHaveLength(1)
    expect(posts(stubA)).toHaveLength(1)
    expect(wedgeTrail(s.trail)).toHaveLength(0)
    expect(s.hold.view(KEY_A)).toEqual({ held: true, heldNotices: 0, nextDueAt: 5000 })

    // The client returns and the cause clears; the throttle still holds the
    // warning until its window opens at t=120 s.
    clients.setUnavailable(KEY_A, false)
    clearSticky(stubA, 'post')
    await s.driveTicks(RETRY_EVERY - 1)
    expect(posts(stubA)).toHaveLength(1)
    await s.driveTicks(1)
    expect(wedgeWarnings(stubA).map((c) => c.channel)).toEqual([A_DEST])
    expect(wedgeTrail(s.trail).map((e) => e['ok'])).toEqual([true])
    expect(s.hold.view(KEY_A)).toEqual({ held: false, heldNotices: 0, nextDueAt: undefined })
    expect(clearedLines(s.logCalls)).toHaveLength(1)

    // Latched; then a new request posts in the tick it is raised.
    await s.driveTicks(RETRY_EVERY)
    expect(wedgeWarnings(stubA)).toHaveLength(1)
    s.setEmpty(false)
    await s.driveTicks(1)
    expect(posts(stubA)).toHaveLength(3) // the failed prompt, the warning, the prompt again
    expect(getLivePermission(INSTANCE_A, TOKEN_A)).toMatchObject({ personaKey: KEY_A, channelId: A_DEST })
    expect(noClient()).toHaveLength(1)
    expect(episodeLines(s.logCalls)).toHaveLength(2)
    expect(slackCalls(stubB, stubD)).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// A persona that is not up (b.av2 SR-6.4, SR-7.2); the scenario is shared
// with the teardown drop below
// ---------------------------------------------------------------------------

const K = wedgeTripTicks(1000)
const UP: PersonaConnectionStatus = { state: 'up', identity: { botUserId: 'U0BOTUSER1', botId: 'B0BOTID001' } } as PersonaConnectionStatus

/**
 * The not-up states the production predicate (`createPersonaUpPredicate`)
 * sees: a connection status, or none, and the bring-up outcome.
 */
const NOT_UP: Array<[string, PersonaConnectionStatus | undefined, boolean]> = [
  ['broken: Slack refused its token', { state: 'broken', phase: 'bring-up' } as PersonaConnectionStatus, false],
  ['retrying: Slack unreachable at bring-up', { state: 'retrying', phase: 'bring-up' } as PersonaConnectionStatus, false],
  ['broken or retrying on its working directory: no connection', undefined, false],
  ['serving, but its bring-up outcome is not up', UP, false],
]

/**
 * A poller over personas A and B (listed) and D (not listed), all up to
 * start with, each with a mutable set of open requests, and the production
 * up predicate over a per-persona connection status and bring-up outcome.
 * `down(key, variant?)` puts a persona in a `NOT_UP` state, `up(key)`
 * brings it up.
 */
function makeNotUpScenario() {
  const statuses = new Map<string, PersonaConnectionStatus | undefined>([[KEY_A, UP], [KEY_B, UP], [KEY_D, UP]])
  const outcomeUp = new Set<string>([KEY_A, KEY_B, KEY_D])
  const isPersonaUp = createPersonaUpPredicate({ status: (key) => statuses.get(key) }, { isUp: (key) => outcomeUp.has(key) })
  const open = new Map<string, PermissionRequestRow[]>()
  const listed = new Set<Persona>([A, B])
  const extraRows: ReturnType<typeof cannedListRow>[] = []
  const getCalls: string[] = []
  const getPermissionCalls: string[] = []
  const logCalls: unknown[][] = []
  const trail = makeTrailCapture()
  const byInstance = (id: string) => config.personas.find((p) => personaInstanceId(p.key) === id)
  const ivl = startPoller(() => ({
    list: async () => ({ spawns: [...[...listed].map((p) => checkPermRow(p)), ...extraRows] }),
    get: async ({ claude_instance_id }) => {
      getCalls.push(claude_instance_id)
      return getResult(open.get(claude_instance_id) ?? [], byInstance(claude_instance_id))
    },
    getPermission: async (params: GetPermissionParams): Promise<GetPermissionResult> => {
      getPermissionCalls.push(params.request_token)
      return cannedGetPermissionResponse({ request_token: params.request_token, decision: 'allow', decision_reason: null })
    },
  }), { isPersonaUp, emitTrail: trail.emit, log: (...args) => { logCalls.push(args) } })
  return {
    ivl,
    open,
    listed,
    extraRows,
    getCalls,
    getPermissionCalls,
    logCalls,
    trail,
    down(key: string, [, status, outcome]: [string, PersonaConnectionStatus | undefined, boolean] = NOT_UP[0]) {
      statuses.set(key, status)
      if (outcome) outcomeUp.add(key)
      else outcomeUp.delete(key)
    },
    up(key: string) {
      statuses.set(key, UP)
      outcomeUp.add(key)
    },
    /** Fire `n` ticks, letting each settle. */
    async drive(n: number) {
      for (let i = 0; i < n; i++) {
        ivl.fire()
        await new Promise((r) => setTimeout(r, 0))
      }
    },
  }
}

const requestA = () => cannedPermissionRequest({ request_token: TOKEN_A, request_id: 1 })
const requestB = () => cannedPermissionRequest({ request_token: TOKEN_B, request_id: 2 })
const allUpdates = () => updates(stubA).length + updates(stubB).length + updates(stubD).length
const trailFor = (trail: TrailCapture, instanceId: string) =>
  trail.events.filter((e) => e['claude_instance_id'] === instanceId)
const wedgeWarnings = () =>
  [stubA, stubB, stubD].flatMap((s) => posts(s)).filter((c) => String(c.text).includes('blocked on a native'))
const skipStarts = (logCalls: unknown[][], persona: Persona) =>
  logLines(logCalls, renderPersonaRef(persona.name, persona.key)).filter((l) => String(l[0]).includes('is not up'))
const skipEnds = (logCalls: unknown[][], persona: Persona) =>
  logLines(logCalls, renderPersonaRef(persona.name, persona.key)).filter((l) => String(l[0]).includes('up again'))

describe('poller tick — a persona that is not up (b.av2 SR-6.4)', () => {
  test.each(NOT_UP)('%s: its row gets no get, no post, no update, no live entry and no trail event, while an up persona\'s row in the same tick posts through its own client', async (label, status, outcomeUp) => {
    const s = makeNotUpScenario()
    s.down(KEY_A, [label, status, outcomeUp])
    s.open.set(INSTANCE_A, [requestA()])
    s.open.set(INSTANCE_B, [requestB()])
    scriptPostTs(stubB, POST_TS_2)
    // E3's handling of a row with no persona label, and of one naming no applied persona, is unchanged.
    s.extraRows.push(
      cannedListRow({ claude_instance_id: 'cscb_unlabelled', state: 'check_permission', labels: { service: 'cscb' } }),
      cannedListRow({ claude_instance_id: 'cscb_absent', state: 'check_permission', labels: { service: 'cscb', persona: 'absent' } }),
    )
    await s.ivl.tick()

    expect(s.getCalls).toEqual([INSTANCE_B])
    expect(posts(stubA)).toHaveLength(0)
    expect(allUpdates()).toBe(0)
    expect(slackCalls(stubA, stubD)).toBe(0)
    expect(clients.calls).not.toContain(KEY_A)
    expect(getLivePermission(INSTANCE_A, TOKEN_A)).toBeUndefined()
    expect(trailFor(s.trail, INSTANCE_A)).toHaveLength(0)

    // B: posted once on its own client to its destination, tracked, with its trail.
    expect(posts(stubB).map((c) => c.channel)).toEqual([B_DEST])
    expect(getLivePermission(INSTANCE_B, TOKEN_B)).toMatchObject({ personaKey: KEY_B, channelId: B_DEST, messageTs: POST_TS_2 })
    expect(rowDecisions(s.trail, 'post_attempted').map((e) => e['claude_instance_id'])).toEqual([INSTANCE_B])
    expect(chatPosts(s.trail)).toHaveLength(1)

    expect(logLines(s.logCalls, 'cscb_unlabelled has no persona label')).toHaveLength(1)
    expect(logLines(s.logCalls, 'cscb_absent names no applied persona')).toHaveLength(1)
    expect(skipStarts(s.logCalls, A)).toHaveLength(1)
    expect(logLines(s.logCalls, 'is not up')).toHaveLength(1)
  })

  test('a skipped open request posts exactly once, through its own client to its destination, on the first tick after the persona comes up', async () => {
    const s = makeNotUpScenario()
    s.listed.delete(B)
    s.down(KEY_A)
    s.open.set(INSTANCE_A, [requestA()])
    scriptPostTs(stubA, POST_TS)
    await s.drive(4)
    expect(s.getCalls).toHaveLength(0)
    expect(slackCalls(stubA, stubB, stubD)).toBe(0)

    s.up(KEY_A)
    await s.ivl.tick()
    expect(posts(stubA).map((c) => c.channel)).toEqual([A_DEST])
    expect(getLivePermission(INSTANCE_A, TOKEN_A)?.messageTs).toBe(POST_TS)

    // The composite-key dedupe still holds: no second post.
    await s.drive(2)
    expect(posts(stubA)).toHaveLength(1)
    expect(rowDecisions(s.trail, 'post_attempted')).toHaveLength(1)
    expect(rowDecisions(s.trail, 'already_tracked')).toHaveLength(2)
    expect(slackCalls(stubB, stubD)).toBe(0)
  })

  test('the stuck-prompt warning never fires for a not-up persona\'s empty spawn; once it is up, the detector needs K fresh empty ticks', async () => {
    const s = makeNotUpScenario()
    s.listed.delete(B)
    s.down(KEY_A)
    await s.drive(K + 1)
    expect(s.getCalls).toHaveLength(0)
    expect(wedgeWarnings()).toHaveLength(0)
    expect(s.trail.events.filter((e) => e.event === 'cscb.poller.wedge_detected')).toHaveLength(0)
    expect(logLines(s.logCalls, 'wedged in check_permission')).toHaveLength(0)

    s.up(KEY_A)
    await s.drive(K - 1)
    expect(wedgeWarnings()).toHaveLength(0)
    await s.drive(1)
    expect(wedgeWarnings().map((c) => c.channel)).toEqual([A_DEST])
  })

  test('a wedge count reached before the persona went down is held, neither advanced nor reset, listed or not, and trips on the first empty tick after it is up', async () => {
    const s = makeNotUpScenario()
    s.listed.delete(B)
    await s.drive(K - 1)
    s.down(KEY_A)
    await s.drive(3) // listed, not up
    s.listed.delete(A)
    await s.drive(3) // not listed, not up
    expect(wedgeWarnings()).toHaveLength(0)

    s.listed.add(A)
    s.up(KEY_A)
    await s.drive(1) // Kth empty observation overall
    expect(wedgeWarnings().map((c) => c.channel)).toEqual([A_DEST])
  })

  test('a persona that goes down after its prompt posted: the prompt is not updated, dropped or re-posted while it is down, even after its row closes; once up, the next tick reconciles it through its own client', async () => {
    const s = makeNotUpScenario()
    s.open.set(INSTANCE_A, [requestA()])
    scriptPostTs(stubA, POST_TS)
    await s.ivl.tick()
    expect(getLivePermission(INSTANCE_A, TOKEN_A)?.messageTs).toBe(POST_TS)
    const getsBefore = s.getCalls.filter((id) => id === INSTANCE_A).length

    s.down(KEY_A)
    await s.drive(2) // row still listed and open
    s.listed.delete(A)
    await s.drive(2) // row closed while A is down
    expect(s.getCalls.filter((id) => id === INSTANCE_A)).toHaveLength(getsBefore)
    expect(s.getPermissionCalls).toHaveLength(0)
    expect(posts(stubA)).toHaveLength(1)
    expect(allUpdates()).toBe(0)
    expect(slackCalls(stubB, stubD)).toBe(0)
    expect(getLivePermission(INSTANCE_A, TOKEN_A)).toMatchObject({ messageTs: POST_TS, channelId: A_DEST, handled: false })
    expect(rowDecisions(s.trail, 'reconciled_closed')).toHaveLength(0)

    s.up(KEY_A)
    await s.ivl.tick()
    expect(s.getPermissionCalls).toEqual([TOKEN_A])
    expect(updates(stubA).map((c) => [c.channel, c.ts])).toEqual([[A_DEST, POST_TS]])
    expect(getLivePermission(INSTANCE_A, TOKEN_A)).toBeUndefined()
    expect(rowDecisions(s.trail, 'reconciled_closed')).toHaveLength(1)
    expect(posts(stubA)).toHaveLength(1)
    expect(updates(stubB).length + updates(stubD).length).toBe(0)

    await s.drive(2)
    expect(s.getPermissionCalls).toHaveLength(1)
    expect(updates(stubA)).toHaveLength(1)
  })

  test('a request not posted (client unavailable) keeps its one log line across ticks where its persona is not up', async () => {
    const s = makeNotUpScenario()
    s.listed.clear()
    s.listed.add(D)
    s.open.set(INSTANCE_D, [requestA()])
    clients.setUnavailable(KEY_D)
    await s.drive(1)
    s.down(KEY_D)
    await s.drive(2)
    s.up(KEY_D)
    await s.drive(2)
    expect(logLines(s.logCalls, `no Slack client for ${renderPersonaRef(NAME_D, KEY_D)}`)).toHaveLength(1)
    expect(slackCalls(stubA, stubB, stubD)).toBe(0)
  })

  test('the skip is logged once when it starts and once when it ends, naming the persona and key, not per tick, with no token', async () => {
    const s = makeNotUpScenario()
    s.open.set(INSTANCE_A, [requestA()])
    s.down(KEY_A)
    await s.drive(3)
    expect(skipStarts(s.logCalls, A)).toHaveLength(1)
    expect(skipEnds(s.logCalls, A)).toHaveLength(0)

    s.up(KEY_A)
    await s.drive(3)
    expect(skipStarts(s.logCalls, A)).toHaveLength(1)
    expect(skipEnds(s.logCalls, A)).toHaveLength(1)

    // A second episode logs its own pair.
    s.down(KEY_A)
    await s.drive(3)
    s.up(KEY_A)
    await s.drive(3)
    expect(skipStarts(s.logCalls, A)).toHaveLength(2)
    expect(skipEnds(s.logCalls, A)).toHaveLength(2)

    // B stayed up: nothing about it.
    expect(logLines(s.logCalls, renderPersonaRef(NAME_B, KEY_B))).toHaveLength(0)
    assertNoLeak({ logCalls: s.logCalls, trail: s.trail.events }, 'not-up skip lines')
  })

  test('a persona dropped from the applied set mid-episode ends its skip with one line naming its key; its row then gets E3\'s not-applied handling', async () => {
    const s = makeNotUpScenario()
    s.down(KEY_A)
    await s.drive(2)
    unapply(KEY_A)
    await s.drive(3)
    const ended = logLines(s.logCalls, `persona=${KEY_A} is no longer applied`)
    expect(ended).toHaveLength(1)
    expect(skipStarts(s.logCalls, A)).toHaveLength(1)
    // E3's not-applied handling logs the row on each of the three ticks.
    expect(logLines(s.logCalls, `${INSTANCE_A} names no applied persona`)).toHaveLength(3)
    expect(s.getCalls.filter((id) => id === INSTANCE_A)).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// A teardown drops one persona's poller state (b.av2 SR-6.5)
// ---------------------------------------------------------------------------

describe('forgetPersonaPrompts — a teardown drops one persona\'s poller state (b.av2 SR-6.5)', () => {
  const TOKEN_C = '33333333-3333-4333-8333-333333333333'
  /** A spawn of B's that is not `cscb_<B>`: its prompt is B's by its `persona` label only. */
  const B_OTHER_INSTANCE = `${INSTANCE_B}_other`
  const droppedLine = (key: string, n: number) =>
    `[slack] permission-poller: persona=${key}: dropped ${n} tracked prompt(s); their Slack messages stay as posted`
  const droppedLines = (logCalls: unknown[][]) => logLines(logCalls, ' tracked prompt(s); their Slack messages stay as posted')

  test('drops every tracked prompt of B, matched by its key or by its instance cscb_<key>, and none of A\'s, with no Slack call and no trail event; a later tick makes no closing update for B\'s closed requests while A\'s closes as before', async () => {
    const s = makeNotUpScenario()
    s.listed.clear()
    s.listed.add(A)
    s.extraRows.push(
      // B's instance under A's label: B's by its instance.
      cannedListRow({ claude_instance_id: INSTANCE_B, state: 'check_permission' }, A, personaDir),
      // Another instance under B's label: B's by its key.
      cannedListRow({ claude_instance_id: B_OTHER_INSTANCE, state: 'check_permission' }, B, personaDir),
    )
    s.open.set(INSTANCE_A, [requestA()])
    s.open.set(INSTANCE_B, [requestB()])
    s.open.set(B_OTHER_INSTANCE, [cannedPermissionRequest({ request_token: TOKEN_C, request_id: 3 })])
    await s.ivl.tick()
    const aEntry = getLivePermission(INSTANCE_A, TOKEN_A)
    expect(aEntry).toMatchObject({ personaKey: KEY_A, channelId: A_DEST })
    expect(getLivePermission(INSTANCE_B, TOKEN_B)).toMatchObject({ personaKey: KEY_A })
    expect(getLivePermission(B_OTHER_INSTANCE, TOKEN_C)).toMatchObject({ personaKey: KEY_B, channelId: B_DEST })
    const callsBefore = slackCalls(stubA, stubB, stubD)
    const trailBefore = s.trail.events.length

    expect(forgetPersonaPrompts(KEY_B)).toBe(2)

    expect(getLivePermission(INSTANCE_B, TOKEN_B)).toBeUndefined()
    expect(getLivePermission(B_OTHER_INSTANCE, TOKEN_C)).toBeUndefined()
    expect(getLivePermission(INSTANCE_A, TOKEN_A)).toEqual(aEntry)
    expect(slackCalls(stubA, stubB, stubD)).toBe(callsBefore)
    expect(s.trail.events).toHaveLength(trailBefore)
    expect(droppedLines(s.logCalls)).toEqual([[droppedLine(KEY_B, 2)]])

    // Every request closes and every row leaves check_permission.
    s.listed.clear()
    s.extraRows.length = 0
    await s.ivl.tick()
    expect(s.getPermissionCalls).toEqual([TOKEN_A])
    expect(updates(stubA).map((c) => [c.channel, c.ts])).toEqual([[A_DEST, aEntry!.messageTs]])
    expect(updates(stubB)).toEqual([])
    expect(slackCalls(stubB)).toBe(1) // B's one prompt, as posted
    expect(getLivePermission(INSTANCE_A, TOKEN_A)).toBeUndefined()

    // Nothing left to drop: no second line.
    expect(forgetPersonaPrompts(KEY_B)).toBe(0)
    expect(droppedLines(s.logCalls)).toHaveLength(1)
    assertNoLeak({ logCalls: s.logCalls, trail: s.trail.events }, 'tracked-prompt drop')
  })

  test('drops B\'s not-posted record, logging no drop line: the next tick logs B\'s not-posted line again, and A\'s record is kept', async () => {
    const s = makeNotUpScenario()
    s.open.set(INSTANCE_A, [requestA()])
    s.open.set(INSTANCE_B, [requestB()])
    clients.setUnavailable(KEY_A)
    clients.setUnavailable(KEY_B)
    const notPosted = (p: Persona) => logLines(s.logCalls, `no Slack client for ${renderPersonaRef(p.name, p.key)}`)
    await s.drive(2)
    expect(notPosted(A)).toHaveLength(1)
    expect(notPosted(B)).toHaveLength(1)

    expect(forgetPersonaPrompts(KEY_B)).toBe(0)
    await s.drive(1)

    expect(notPosted(B)).toHaveLength(2)
    expect(notPosted(A)).toHaveLength(1)
    expect(droppedLines(s.logCalls)).toEqual([])
    expect(slackCalls(stubA, stubB, stubD)).toBe(0)
  })

  test('drops B\'s stuck-prompt count: B needs K fresh empty ticks to warn, while A\'s count, reached before the drop, trips on schedule', async () => {
    const s = makeNotUpScenario()
    await s.drive(K - 1)
    expect(wedgeWarnings()).toHaveLength(0)

    forgetPersonaPrompts(KEY_B)
    await s.drive(1)
    expect(wedgeWarnings().map((c) => c.channel)).toEqual([A_DEST])

    await s.drive(K - 2)
    expect(posts(stubB)).toHaveLength(0)
    await s.drive(1)
    expect(posts(stubB).map((c) => c.channel)).toEqual([B_DEST])
    expect(wedgeWarnings()).toHaveLength(2)
  })

  test('drops B\'s not-up skip episode: once B leaves the applied set no "no longer applied" line is logged for it, and A\'s episode is kept', async () => {
    const s = makeNotUpScenario()
    s.down(KEY_A)
    s.down(KEY_B)
    await s.drive(2)
    expect(skipStarts(s.logCalls, A)).toHaveLength(1)
    expect(skipStarts(s.logCalls, B)).toHaveLength(1)

    forgetPersonaPrompts(KEY_B)
    unapply(KEY_B)
    await s.drive(2)

    expect(logLines(s.logCalls, `persona=${KEY_B} is no longer applied`)).toEqual([])
    expect(skipStarts(s.logCalls, A)).toHaveLength(1)
    s.up(KEY_A)
    await s.drive(1)
    expect(skipEnds(s.logCalls, A)).toHaveLength(1)
  })

  test('a leftover row still labelled for B, with open requests, after B was dropped and left the applied set: no get, post or tracked prompt for B, while A\'s prompts post and close as before', async () => {
    const s = makeNotUpScenario()
    s.open.set(INSTANCE_A, [requestA()])
    s.open.set(INSTANCE_B, [requestB()])
    await s.ivl.tick()
    expect(posts(stubB)).toHaveLength(1)
    const bGets = s.getCalls.filter((id) => id === INSTANCE_B).length

    expect(forgetPersonaPrompts(KEY_B)).toBe(1)
    unapply(KEY_B)
    // B's row is still listed (its kill failed), with its old request and a new one.
    s.open.set(INSTANCE_B, [requestB(), cannedPermissionRequest({ request_token: TOKEN_C, request_id: 3 })])
    s.open.set(INSTANCE_A, [requestA(), cannedPermissionRequest({ request_token: TOKEN_C, request_id: 4 })])
    await s.drive(2)

    expect(s.getCalls.filter((id) => id === INSTANCE_B)).toHaveLength(bGets)
    expect(slackCalls(stubB)).toBe(1)
    expect(getLivePermission(INSTANCE_B, TOKEN_B)).toBeUndefined()
    expect(getLivePermission(INSTANCE_B, TOKEN_C)).toBeUndefined()
    expect(logLines(s.logCalls, `${INSTANCE_B} names no applied persona (persona=${KEY_B})`)).toHaveLength(2)
    expect(rowDecisions(s.trail, 'post_attempted').map((e) => [e['claude_instance_id'], e['request_token']])).toEqual([
      [INSTANCE_A, TOKEN_A],
      [INSTANCE_B, TOKEN_B],
      [INSTANCE_A, TOKEN_C],
    ])

    // A: the new request posted, and its first closes with one update.
    expect(posts(stubA).map((c) => c.channel)).toEqual([A_DEST, A_DEST])
    expect(getLivePermission(INSTANCE_A, TOKEN_C)).toMatchObject({ personaKey: KEY_A, channelId: A_DEST })
    const aFirstTs = getLivePermission(INSTANCE_A, TOKEN_A)!.messageTs
    s.open.set(INSTANCE_A, [cannedPermissionRequest({ request_token: TOKEN_C, request_id: 4 })])
    await s.ivl.tick()
    expect(s.getPermissionCalls).toEqual([TOKEN_A])
    expect(updates(stubA).map((c) => [c.channel, c.ts])).toEqual([[A_DEST, aFirstTs]])
    expect(slackCalls(stubB, stubD)).toBe(1)
    assertNoLeak({ logCalls: s.logCalls, trail: s.trail.events }, 'leftover row')
  })
})
