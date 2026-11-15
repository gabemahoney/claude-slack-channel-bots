/**
 * persona-destination.test.ts — Where a persona's permission prompts and
 * notices go, and the post there.
 *
 * One destination rule per mode (beside): a
 * persona's destination is its `permission_prompts` in declarative mode and
 * its fungible destination (`invited.permission_prompts`, `dm` when absent)
 * in fungible mode; the section not in force is ignored, and the resolver
 * reads the configuration in effect and the applied persona again at each
 * attempt. In fungible mode the resolver posts to
 * a channel destination, or opens the DM with `dm.contact` on the persona's
 * own client for a `dm` one. `destinationSettingOf` is
 * pinned here for each mode, the one pin of the setting names in this work;
 * every other suite builds its expectations through it. The resolver's
 * refusal of a `dm` destination names the setting in force, and in fungible
 * mode differs from the declarative line in that name only (
 * beside).
 *
 * The destination module is proven here once, so the poller and notifier
 * suites need not re-prove it: a channel destination is the configured
 * channel, a `dm` destination is the persona's DM with `dm.contact`, opened
 * with `conversations.open` on the persona's own client and cached per persona
 * until the contact changes, the persona is forgotten, the open fails, or a
 * post to the cached conversation fails `channel_not_found`. Concurrent posts
 * share one open. Every post, to a channel or a DM, with or without blocks,
 * carries the Server Post Marker in its one `chat.postMessage` request, with
 * no other call. A `dm` destination with DMs off or no contact is refused
 * with no Slack call. Nothing rejects. A `channel_not_found` eviction is
 * synchronous and drops only the entry the post used, never a newer (even
 * pending) one. An open in flight across a `forget(key)` (an in-place update,
 * with or without a new contact) that then succeeds is never reused. Failures are described token-safely
 * (`describeDestinationFailure`, `describeDestinationFailureCause`).
 *
 * Pure module under test: built over one `makeStubSlack` stub per persona
 * (leak marker on), a line capture and the shared fake clock; no real timer is used.
 * Real-owner cases use isolated Thread Memory;
 * `afterEach` runs `assertNoLeak` over every log line and result.
 */

import { SERVER_POST_METADATA } from './test-helpers/server-post.ts'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { DM_DESTINATION, type Persona } from '../src/config.ts'
import {
  NO_CONVERSATION_ID_CODE,
  DM_OPEN_TIMEOUT_MS,
  createPersonaDestinations,
  describeDestinationFailure,
  describeDestinationFailureCause,
  destinationSettingOf,
  dmDestinationRefusal,
  personaDestinationOf,
  type DestinationConfig,
  type DestinationFailure,
  type DestinationPosted,
  type DestinationMessageTracking,
  type DestinationPostResult,
  type DestinationSlackClient,
  type DmDestinationRefusal,
  type PersonaDestinations,
} from '../src/persona-destination.ts'
import { describeThrownValue } from '../src/persona-connection-errors.ts'
import { createOwnPostObserver, ownPostAnswerOfError, type OwnPostObserver } from '../src/own-post.ts'
import { holdOwnPostReady, makeOwnPostHarness, makeRecordingOwnPostObserver, type OwnPostStep } from './test-helpers/own-post.ts'
import { SHARED_CHANNEL_IDS } from './test-helpers/shared-channels.ts'
import { renderPersonaRef } from '../src/persona-identity.ts'
import { makeMultiPersonaConfig, type PersonaSpec } from './test-helpers/persona-config.ts'
import {
  asWebClient,
  makeDeferredWebApiCall,
  makeStubSlack,
  openedDm,
  stubOpenedDmId,
  type StubSlack,
  type WebApiOutcome,
} from './test-helpers/slack-stub.ts'
import { BOT_TOKEN_PREFIX, LEAK_SENTINEL, assertNoLeak, fakeToken } from './test-helpers/credentials.ts'
import { createFakeClock, type FakeClock } from './test-helpers/fake-clock.ts'

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

let dir: string
/** Channel-destination persona. */
let C: Persona
/** `dm`-destination personas with different contacts (DM-only, no channels). */
let A: Persona
let B: Persona
let stubs: Map<string, StubSlack>
let logs: string[]
/**
 * Every result the module returned, less the raw thrown value (which the
 * stub's errors fill with `LEAK_SENTINEL` and the module only hands back for
 * `describeDestinationFailure`), for `assertNoLeak`.
 */
let results: unknown[]
let d: PersonaDestinations
let clock: FakeClock

function makeFixture(): void {
  const config = makeMultiPersonaConfig(
    [
      { name: 'Chan Dest', channels: [{ id: 'C0CHAN001', delivery: 'all' }, { id: 'C0CHAN002', delivery: 'all' }], permission_prompts: 'C0CHAN002' },
      { name: 'Alpha Dest', channels: [], dm: { enabled: true, contact: 'U0ALPHA01' }, permission_prompts: 'dm' },
      { name: 'Beta Dest', channels: [], dm: { enabled: true, contact: 'U0BETA002' }, permission_prompts: 'dm' },
    ],
    dir,
  )
  ;[C, A, B] = config.personas as [Persona, Persona, Persona]
  stubs = new Map(config.personas.map((p) => [p.key, makeStubSlack({ leakMarker: LEAK_SENTINEL })]))
  logs = []
  results = []
  clock = createFakeClock()
  d = createPersonaDestinations({ log: (line) => logs.push(line), clock, getPersonaConfig: () => config })
}

const stub = (p: Persona): StubSlack => stubs.get(p.key)!
const client = (p: Persona): DestinationSlackClient => asWebClient(stub(p).web)
const methods = (p: Persona): string[] => stub(p).callLog.map((c) => c.method)
const opens = (p: Persona) => stub(p).calls.conversationsOpen
/** `chat.postMessage` arguments on `p`'s stub, as the module passes them. */
const posts = (p: Persona) => stub(p).calls.postMessage as { channel: string; text: string; blocks?: unknown[]; metadata?: unknown }[]

/** The persona with another contact (an in-place contact change, as reload makes). */
const withContact = (p: Persona, contact: string): Persona => ({ ...p, dm: { ...p.dm, contact } })

/** Record a result for the leak check, without its raw thrown value. */
function record<T extends object>(r: T): T {
  const { error: _error, ...rest } = r as T & { error?: unknown }
  results.push(rest)
  return r
}

/** Post `text` for `p` on its own client, recording the result. */
async function post(p: Persona, text = 'hello') {
  return record(await d.post(p, client(p), { text }))
}

/** Let pending promise continuations run (no timer, no clock). */
async function drainMicrotasks(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve()
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'persona-destination-'))
  makeFixture()
})

afterEach(() => {
  expect(clock.pendingCount()).toBe(0)
  assertNoLeak({ lines: logs, results, posts: [...stubs.values()].flatMap(s => s.calls.postMessage) })
  rmSync(dir, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

describe('bounded, cancellable shared DM opens', () => {
  function tracked() {
    const abort = new AbortController(), callbacks: string[] = []
    const tracking: DestinationMessageTracking = {
      signal: abort.signal,
      canPost: () => { callbacks.push('canPost'); return true },
      onPosted: () => { callbacks.push('onPosted') },
      onPostFailed: () => { callbacks.push('onPostFailed') },
    }
    return { abort, callbacks, tracking }
  }

  test.each(['success', 'failure'] as const)('cancelling one consumer preserves the shared open for its surviving consumer: %s', async outcome => {
    const opening = makeDeferredWebApiCall(), t = tracked()
    stub(A).script.open.push(opening.outcome)
    let otherResult: DestinationPostResult | undefined
    const cancelled = d.post(A, client(A), { text: 'cancelled', tracking: t.tracking }).then(record)
    const other = post(A, 'survivor').then(result => { otherResult = result; return result })
    expect(opens(A)).toHaveLength(1)
    t.abort.abort()
    await clock.flush()
    expect(await cancelled).toEqual({ outcome: 'cancelled' })
    expect(otherResult).toBeUndefined()
    expect(opening.settled).toBe(false)
    // Another persona is independent while alpha still has a live consumer.
    expect(await post(B, 'sibling')).toMatchObject({ outcome: 'posted', channelId: stubOpenedDmId(B.dm.contact!) })
    expect(opens(B)).toHaveLength(1)
    opening.settle(outcome === 'success' ? openedDm('D0SHARED1') : { kind: 'platform', error: 'missing_scope' })
    expect(await other).toMatchObject(outcome === 'success'
      ? { outcome: 'posted', channelId: 'D0SHARED1' }
      : { outcome: 'failed', step: 'conversations.open', code: 'missing_scope' })
    expect(posts(A)).toEqual(outcome === 'success' ? [{ channel: 'D0SHARED1', text: 'survivor', metadata: SERVER_POST_METADATA }] : [])
    expect(t.callbacks).toEqual([])
    expect(clock.pendingCount()).toBe(0)
    if (outcome === 'failure') stub(A).script.open.push(openedDm('D0SHARED1'))
    expect(await post(A, 'next')).toMatchObject({ outcome: 'posted', channelId: 'D0SHARED1' })
    expect(opens(A)).toHaveLength(outcome === 'success' ? 1 : 2)
    expect(posts(B)).toHaveLength(1)
  })

  test.each([
    ['cancel', 'success'], ['cancel', 'failure'],
    ['timeout', 'success'], ['timeout', 'failure'],
  ] as const)('%s releases a pending open; its late %s cannot settle or evict a newer open', async (reason, late) => {
    const old = makeDeferredWebApiCall(), t = tracked()
    stub(A).script.open.push(old.outcome)
    let originalResult: DestinationPostResult | undefined, lateJoinResult: DestinationPostResult | undefined
    const original = d.post(A, client(A), { text: 'old', tracking: t.tracking })
      .then(result => { originalResult = record(result); return result })
    if (reason === 'cancel') t.abort.abort()
    else {
      expect(DM_OPEN_TIMEOUT_MS).toBe(10_000) // Sole pin; all timing uses the exported bound.
      await clock.advance(DM_OPEN_TIMEOUT_MS - 1)
      expect(originalResult).toBeUndefined()
      // A late consumer shares the original deadline, not a fresh full wait.
      const lateJoin = post(A, 'late join').then(result => { lateJoinResult = result; return result })
      await clock.flush()
      expect(lateJoinResult).toBeUndefined()
      expect(opens(A)).toHaveLength(1)
      await clock.advance(1)
      expect(lateJoinResult).toEqual({ outcome: 'failed', step: 'conversations.open', code: 'timeout' })
      await lateJoin
    }
    await clock.flush()
    const expected: DestinationPostResult = reason === 'cancel' ? { outcome: 'cancelled' }
      : { outcome: 'failed', step: 'conversations.open', code: 'timeout' }
    expect(originalResult).toEqual(expected)
    expect(await original).toEqual(expected)
    expect(old.settled).toBe(false)
    expect(clock.pendingCount()).toBe(0)

    const fresh = makeDeferredWebApiCall()
    stub(A).script.open.push(fresh.outcome)
    let newerResult: DestinationPostResult | undefined
    const newer = post(A, 'newer').then(result => { newerResult = result; return result })
    expect(opens(A)).toHaveLength(2)
    old.settle(late === 'success' ? openedDm('D0STALE01') : { kind: 'platform', error: 'missing_scope' })
    await clock.flush()
    expect(newerResult).toBeUndefined()
    expect(posts(A)).toEqual([])
    expect(t.callbacks).toEqual([])
    // Joining while the newer open is still pending catches stale cache eviction.
    const peer = post(A, 'fresh peer')
    expect(opens(A)).toHaveLength(2)
    fresh.settle(openedDm('D0FRESH01'))
    expect(await newer).toMatchObject({ outcome: 'posted', channelId: 'D0FRESH01' })
    expect(await peer).toMatchObject({ outcome: 'posted', channelId: 'D0FRESH01' })
    await post(A, 'cached fresh')
    expect(posts(A)).toEqual(['newer', 'fresh peer', 'cached fresh'].map(text => ({ channel: 'D0FRESH01', text, metadata: SERVER_POST_METADATA })))
    expect(opens(A)).toHaveLength(2)
    t.abort.abort()
    await clock.advance(DM_OPEN_TIMEOUT_MS * 2)
    expect(originalResult).toEqual(expected)
    expect(t.callbacks).toEqual([])
    expect(posts(A)).toHaveLength(3)
    expect(clock.pendingCount()).toBe(0)
  })
})

describe('resolution', () => {
  test('a dm destination opens the DM with its contact on its own client and posts to the returned D… ID; a second post reuses the cache', async () => {
    stub(A).script.open.push(openedDm('D0ALPHADM'))

    expect(await post(A, '1')).toEqual({ outcome: 'posted', channelId: 'D0ALPHADM', ts: expect.any(String) })
    expect(opens(A)).toEqual([{ users: 'U0ALPHA01' }])

    expect(await post(A, '2')).toEqual({ outcome: 'posted', channelId: 'D0ALPHADM', ts: expect.any(String) })
    expect(opens(A)).toHaveLength(1)
    expect(methods(A)).toEqual(['conversations.open', 'chat.postMessage', 'chat.postMessage'])
    expect(posts(A).map((c) => c.channel)).toEqual(['D0ALPHADM', 'D0ALPHADM'])
    expect(logs).toEqual([])
  })

  test('concurrent posts for the same persona and contact share one conversations.open', async () => {
    const open = makeDeferredWebApiCall()
    stub(A).script.open.push(open.outcome)

    const pending = ['p1', 'p2', 'p3'].map((text) => d.post(A, client(A), { text }))
    await drainMicrotasks()
    expect(methods(A)).toEqual(['conversations.open'])

    open.settle({ kind: 'ok', result: { channel: { id: 'D0ALPHADM' } } })
    const settled = await Promise.all(pending)
    settled.forEach(record)

    expect(opens(A)).toHaveLength(1)
    expect(settled.map((r) => r.outcome)).toEqual(['posted', 'posted', 'posted'])
    expect(posts(A)).toEqual([
      { channel: 'D0ALPHADM', text: 'p1', metadata: SERVER_POST_METADATA },
      { channel: 'D0ALPHADM', text: 'p2', metadata: SERVER_POST_METADATA },
      { channel: 'D0ALPHADM', text: 'p3', metadata: SERVER_POST_METADATA },
    ])
  })

  test('a changed contact is not served from the cache: the next post opens for the new contact and posts there, and so does a change back', async () => {
    const first = await post(A, 'old')
    const changed = await post(withContact(A, 'U0NEWCON1'), 'new')
    const back = await post(A, 'back')

    expect(opens(A)).toEqual([{ users: 'U0ALPHA01' }, { users: 'U0NEWCON1' }, { users: 'U0ALPHA01' }])
    expect(first).toMatchObject({ outcome: 'posted', channelId: stubOpenedDmId('U0ALPHA01') })
    expect(changed).toMatchObject({ outcome: 'posted', channelId: stubOpenedDmId('U0NEWCON1') })
    expect(back).toMatchObject({ outcome: 'posted', channelId: stubOpenedDmId('U0ALPHA01') })
    // Each post goes to its own contact's conversation, never the other one.
    expect(posts(A).map((c) => [c.text, c.channel])).toEqual([
      ['old', stubOpenedDmId('U0ALPHA01')],
      ['new', stubOpenedDmId('U0NEWCON1')],
      ['back', stubOpenedDmId('U0ALPHA01')],
    ])
  })

  test('forget(key) drops only that persona\'s entry: its next post opens again, the other persona stays cached', async () => {
    await post(A)
    await post(B)

    d.forget(A.key)
    await post(A)
    await post(B)

    expect(opens(A)).toHaveLength(2)
    expect(opens(B)).toHaveLength(1)
    expect(posts(A)).toHaveLength(2)
    expect(posts(B)).toHaveLength(2)
  })

  // An in-place update forgets the persona's cached DM when `dm.contact`,
  // `dm.enabled` or `permission_prompts` changed, so the
  // forget can come with or without a new contact.
  test.each([
    ['with a new contact', 'U0NEWCON1'],
    ['with the contact unchanged (a permission_prompts or dm.enabled change)', 'U0ALPHA01'],
  ] as const)(
    'an open in flight when forget(key) runs %s, succeeding afterwards, is never reused: the next post opens for the current contact; the other persona stays cached',
    async (_label, contact) => {
      await post(B, 'b-1')
      const old = makeDeferredWebApiCall()
      stub(A).script.open.push(old.outcome)
      const oldPost = d.post(A, client(A), { text: 'old' })
      await drainMicrotasks()

      d.forget(A.key)
      const current = withContact(A, contact)
      old.settle({ kind: 'ok', result: { channel: { id: 'D0STALEDM1' } } })
      // The post issued before the change finishes in the conversation it opened.
      expect(record(await oldPost)).toMatchObject({ outcome: 'posted', channelId: 'D0STALEDM1' })
      await drainMicrotasks()

      stub(A).script.open.push(openedDm('D0FRESHDM1'))
      expect(await post(current, 'new-1')).toMatchObject({ outcome: 'posted', channelId: 'D0FRESHDM1' })
      expect(await post(current, 'new-2')).toMatchObject({ outcome: 'posted', channelId: 'D0FRESHDM1' })
      await post(B, 'b-2')

      expect(opens(A)).toEqual([{ users: 'U0ALPHA01' }, { users: contact }])
      expect(posts(A).map((c) => [c.text, c.channel])).toEqual([
        ['old', 'D0STALEDM1'],
        ['new-1', 'D0FRESHDM1'],
        ['new-2', 'D0FRESHDM1'],
      ])
      expect(opens(B)).toEqual([{ users: 'U0BETA002' }])
      expect(posts(B).map((c) => c.channel)).toEqual([stubOpenedDmId('U0BETA002'), stubOpenedDmId('U0BETA002')])
    },
  )

  test('two dm personas with different contacts each open their own conversation on their own client only', async () => {
    const [ra, rb] = (await Promise.all([d.post(A, client(A), { text: 'for A' }), d.post(B, client(B), { text: 'for B' })])).map(record)

    expect(ra).toEqual({ outcome: 'posted', channelId: stubOpenedDmId('U0ALPHA01'), ts: expect.any(String) })
    expect(rb).toEqual({ outcome: 'posted', channelId: stubOpenedDmId('U0BETA002'), ts: expect.any(String) })
    expect(stub(A).callLog.map((c) => [c.method, c.args])).toEqual([
      ['conversations.open', { users: 'U0ALPHA01' }],
      ['chat.postMessage', { channel: stubOpenedDmId('U0ALPHA01'), text: 'for A', metadata: SERVER_POST_METADATA }],
    ])
    expect(stub(B).callLog.map((c) => [c.method, c.args])).toEqual([
      ['conversations.open', { users: 'U0BETA002' }],
      ['chat.postMessage', { channel: stubOpenedDmId('U0BETA002'), text: 'for B', metadata: SERVER_POST_METADATA }],
    ])
    expect(methods(C)).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Failed opens
// ---------------------------------------------------------------------------

const OPEN_FAILURES: [string, WebApiOutcome, string][] = [
  ['missing_scope', { kind: 'platform', error: 'missing_scope' }, 'missing_scope'],
  ['user_not_found', { kind: 'platform', error: 'user_not_found' }, 'user_not_found'],
  ['a network error', { kind: 'network' }, 'network_error'],
  ['a rejection with a non-Error value', { kind: 'reject', value: 'boom' }, 'unknown_error'],
  ['an answer with no conversation ID', { kind: 'ok', result: { channel: undefined } }, NO_CONVERSATION_ID_CODE],
  ['an answer with an empty conversation ID', openedDm(''), NO_CONVERSATION_ID_CODE],
]

describe('a failed conversations.open', () => {
  test.each(OPEN_FAILURES)(
    'an open failing with %s is reported with its code and the open step, posts nothing, is not cached, and the next attempt opens again',
    async (_label, outcome, code) => {
      stub(A).script.open.push(outcome)

      const failed = await post(A, 'first')
      expect(failed).toMatchObject({ outcome: 'failed', step: 'conversations.open', code })
      expect((failed as DestinationFailure).channelId).toBeUndefined()
      expect(methods(A)).toEqual(['conversations.open'])

      const again = await post(A, 'second')
      expect(again).toEqual({ outcome: 'posted', channelId: stubOpenedDmId('U0ALPHA01'), ts: expect.any(String) })
      expect(methods(A)).toEqual(['conversations.open', 'conversations.open', 'chat.postMessage'])
      expect(posts(A)).toEqual([{ channel: stubOpenedDmId('U0ALPHA01'), text: 'second', metadata: SERVER_POST_METADATA }])
      // A failure is returned to the caller, not logged here.
      expect(logs).toEqual([])
    },
  )

  test('concurrent posts sharing an open that fails all report the open failure; nothing is posted and the next post opens again', async () => {
    const open = makeDeferredWebApiCall()
    stub(A).script.open.push(open.outcome)

    const pending = [d.post(A, client(A), { text: '1' }), d.post(A, client(A), { text: '2' })]
    open.settle({ kind: 'platform', error: 'missing_scope' })
    const settled = await Promise.all(pending)
    settled.forEach(record)

    expect(settled.map((r) => (r as DestinationFailure).code)).toEqual(['missing_scope', 'missing_scope'])
    expect(methods(A)).toEqual(['conversations.open'])
    await post(A)
    expect(methods(A)).toEqual(['conversations.open', 'conversations.open', 'chat.postMessage'])
  })

  test('an older open that fails after the contact changed does not evict the newer contact\'s cached DM', async () => {
    const old = makeDeferredWebApiCall()
    stub(A).script.open.push(old.outcome)
    const oldPost = d.post(A, client(A), { text: 'old' })
    await drainMicrotasks()

    // The new contact's post opens its own DM while the older open is still
    // pending (asserted before settling, so a post that waited on the older
    // open fails here rather than by timeout).
    const moved = withContact(A, 'U0NEWCON1')
    const newPost = d.post(moved, client(A), { text: 'new-1' })
    await drainMicrotasks()
    expect(opens(A)).toEqual([{ users: 'U0ALPHA01' }, { users: 'U0NEWCON1' }])

    old.settle({ kind: 'platform', error: 'missing_scope' })
    expect(record(await oldPost)).toMatchObject({ outcome: 'failed', step: 'conversations.open', code: 'missing_scope' })
    expect(record(await newPost)).toMatchObject({ outcome: 'posted', channelId: stubOpenedDmId('U0NEWCON1') })
    await drainMicrotasks()

    await post(moved, 'new-2')
    expect(opens(A)).toEqual([{ users: 'U0ALPHA01' }, { users: 'U0NEWCON1' }])
    expect(posts(A).map((c) => c.text)).toEqual(['new-1', 'new-2'])
  })

  test('an open in flight across forget(key) that then fails does not evict the entry re-created after the forget', async () => {
    const old = makeDeferredWebApiCall()
    stub(A).script.open.push(old.outcome)
    const oldPost = d.post(A, client(A), { text: 'old' })
    await drainMicrotasks()

    // After the forget the next post opens again while the older open is
    // still pending (asserted before settling, so a post that reused the
    // forgotten open fails here rather than by timeout).
    d.forget(A.key)
    const freshPost = d.post(A, client(A), { text: 'fresh-1' })
    await drainMicrotasks()
    expect(opens(A)).toHaveLength(2)

    old.settle({ kind: 'platform', error: 'missing_scope' })
    expect(record(await oldPost)).toMatchObject({ outcome: 'failed', step: 'conversations.open', code: 'missing_scope' })
    expect(record(await freshPost)).toMatchObject({ outcome: 'posted', channelId: stubOpenedDmId('U0ALPHA01') })
    await drainMicrotasks()

    await post(A, 'fresh-2')
    expect(opens(A)).toHaveLength(2)
    expect(posts(A).map((c) => c.text)).toEqual(['fresh-1', 'fresh-2'])
  })

  test('a failed open of one persona leaves the other persona\'s cached DM in place', async () => {
    await post(B)
    stub(A).script.open.push({ kind: 'platform', error: 'missing_scope' })

    expect(await post(A)).toMatchObject({ outcome: 'failed', step: 'conversations.open', code: 'missing_scope' })
    await post(B)

    expect(opens(B)).toHaveLength(1)
    expect(posts(B)).toHaveLength(2)
  })
})

// ---------------------------------------------------------------------------
// Posting
// ---------------------------------------------------------------------------

describe('posting', () => {
  test('a DM-only persona\'s first post, with no DM yet, opens the DM on its own client, then posts to the D… ID (never the user ID) with no username or icon override', async () => {
    const r = await d.post(A, client(A), { text: 'prompt', blocks: [{ type: 'section' }] })
    record(r)

    const dm = stubOpenedDmId('U0ALPHA01')
    expect(r).toEqual({ outcome: 'posted', channelId: dm, ts: expect.any(String) })
    expect(methods(A)).toEqual(['conversations.open', 'chat.postMessage'])
    const [args] = posts(A)
    expect(args).toEqual({ channel: dm, text: 'prompt', blocks: [{ type: 'section' }], metadata: SERVER_POST_METADATA })
    expect(args!.channel).not.toBe('U0ALPHA01')
    for (const s of [B, C]) expect(methods(s)).toEqual([])
  })

  test.each([
    ['{channel, text, metadata}', undefined],
    ['{channel, text, blocks, metadata}', [{ type: 'section' }]],
  ] as const)('a channel destination posts exactly %s (the Server Post Marker) to the configured channel with no open and no log line, and the post is issued synchronously', (_label, blocks) => {
    const pending = d.post(C, client(C), blocks === undefined ? { text: 'now' } : { text: 'now', blocks: [...blocks] })
    // Before any await: the channel post, marker included, is already made.
    expect(posts(C)).toEqual([{ channel: 'C0CHAN002', text: 'now', ...(blocks === undefined ? {} : { blocks: [...blocks] }), metadata: SERVER_POST_METADATA }])
    expect(methods(C)).toEqual(['chat.postMessage'])
    return pending.then((r) => {
      record(r)
      expect(r).toEqual({ outcome: 'posted', channelId: 'C0CHAN002', ts: expect.any(String) })
      expect(methods(C)).toEqual(['chat.postMessage'])
      expect(logs).toEqual([])
    })
  })

  test('a channel post failure is returned with the post step, its code and the channel; no open is ever made', async () => {
    stub(C).script.post.push({ kind: 'platform', error: 'channel_not_found' })

    expect(await post(C)).toMatchObject({ outcome: 'failed', step: 'chat.postMessage', code: 'channel_not_found', channelId: 'C0CHAN002' })
    await post(C)
    expect(methods(C)).toEqual(['chat.postMessage', 'chat.postMessage'])
  })

  test('a post to the cached DM failing channel_not_found drops the entry, so the next post opens again', async () => {
    await post(A, '1')
    stub(A).script.post.push({ kind: 'platform', error: 'channel_not_found' })

    expect(await post(A, '2')).toMatchObject({
      outcome: 'failed',
      step: 'chat.postMessage',
      code: 'channel_not_found',
      channelId: stubOpenedDmId('U0ALPHA01'),
    })
    stub(A).script.open.push(openedDm('D0REOPEN1'))
    expect(await post(A, '3')).toMatchObject({ outcome: 'posted', channelId: 'D0REOPEN1' })

    expect(methods(A)).toEqual([
      'conversations.open',
      'chat.postMessage',
      'chat.postMessage',
      'conversations.open',
      'chat.postMessage',
    ])
  })

  test.each<[string, WebApiOutcome, string]>([
    ['not_in_channel', { kind: 'platform', error: 'not_in_channel' }, 'not_in_channel'],
    ['a network error', { kind: 'network' }, 'network_error'],
    ['an HTTP error', { kind: 'http', status: 503 }, 'network_error'],
  ])('a DM post failing with %s keeps the cached DM: the next post makes no open', async (_label, outcome, code) => {
    await post(A, '1')
    stub(A).script.post.push(outcome)

    expect(await post(A, '2')).toMatchObject({ outcome: 'failed', step: 'chat.postMessage', code })
    await post(A, '3')

    expect(opens(A)).toHaveLength(1)
    expect(posts(A).map((c) => c.channel)).toEqual(Array(3).fill(stubOpenedDmId('U0ALPHA01')))
  })

  test('channel_not_found for an older DM does not evict the entry that now names another conversation', async () => {
    await post(A, 'first')
    const late = makeDeferredWebApiCall()
    stub(A).script.post.push(late.outcome)
    const oldPost = d.post(A, client(A), { text: 'old' })
    await drainMicrotasks()

    const moved = withContact(A, 'U0NEWCON1')
    await post(moved, 'new-1')
    late.settle({ kind: 'platform', error: 'channel_not_found' })
    record(await oldPost)
    await post(moved, 'new-2')

    expect(opens(A)).toEqual([{ users: 'U0ALPHA01' }, { users: 'U0NEWCON1' }])
    expect(posts(A).map((c) => [c.text, c.channel])).toEqual([
      ['first', stubOpenedDmId('U0ALPHA01')],
      ['old', stubOpenedDmId('U0ALPHA01')],
      ['new-1', stubOpenedDmId('U0NEWCON1')],
      ['new-2', stubOpenedDmId('U0NEWCON1')],
    ])
  })

  test.each([
    ['a forget', (): Persona => (d.forget(A.key), A), 'U0ALPHA01'],
    ['a contact change', (): Persona => withContact(A, 'U0NEWCON1'), 'U0NEWCON1'],
  ] as const)(
    'channel_not_found for an older DM while a newer open (after %s) is still pending returns at once and keeps the newer entry',
    async (_label, replace, contact) => {
      await post(A, 'first')
      const late = makeDeferredWebApiCall()
      stub(A).script.post.push(late.outcome)
      const oldPost = d.post(A, client(A), { text: 'old' })
      await drainMicrotasks()

      // A newer open replaces the entry the old post used and stays pending.
      const newer = makeDeferredWebApiCall()
      stub(A).script.open.push(newer.outcome)
      const p = replace()
      const newPost = d.post(p, client(A), { text: 'new-1' })
      await drainMicrotasks()
      expect(opens(A)).toEqual([{ users: 'U0ALPHA01' }, { users: contact }])

      // The old post's failure settles without waiting on the newer open.
      let oldResult: unknown
      void oldPost.then((r) => (oldResult = record(r)))
      late.settle({ kind: 'platform', error: 'channel_not_found' })
      await drainMicrotasks()
      expect(newer.settled).toBe(false)
      expect(oldResult).toMatchObject({ outcome: 'failed', step: 'chat.postMessage', code: 'channel_not_found', channelId: stubOpenedDmId('U0ALPHA01') })

      // The newer entry was kept: its own post and the next one share its one open.
      newer.settle({ kind: 'ok', result: { channel: { id: 'D0NEWER01' } } })
      expect(record(await newPost)).toMatchObject({ outcome: 'posted', channelId: 'D0NEWER01' })
      expect(await post(p, 'new-2')).toMatchObject({ outcome: 'posted', channelId: 'D0NEWER01' })
      expect(opens(A)).toHaveLength(2)
      expect(posts(A).map((c) => c.channel)).toEqual([stubOpenedDmId('U0ALPHA01'), stubOpenedDmId('U0ALPHA01'), 'D0NEWER01', 'D0NEWER01'])
    },
  )
})

// ---------------------------------------------------------------------------
// Never rejects
// ---------------------------------------------------------------------------

describe('own-post operations', () => {
  function observed(steps: OwnPostStep[] = []) {
    const recording = makeRecordingOwnPostObserver(steps)
    const resolver = createPersonaDestinations({ log: line => logs.push(line), clock,
      getPersonaConfig: () => ({ channel_mode: 'strict' }), ownPosts: recording.observer })
    return { ...recording, resolver }
  }

  test.each(['prompt', 'warning', 'notice'] as const)('%s starts before Slack without a ready wait, and ends once before onPosted and return', async surface => {
    const { calls, resolver } = observed()
    const answer = makeDeferredWebApiCall()
    stub(C).script.post.push(answer.outcome)
    const message = { text: 'exact notice\nwith whitespace  ', blocks: [{ type: 'section' }] }
    const atPost: string[][] = [], atCallback: string[][] = [], callbacks: DestinationPosted[] = []
    const web = stub(C).web, original = web.chat.postMessage
    web.chat.postMessage = ((...args: Parameters<typeof original>) => {
      atPost.push(calls.map(c => c.kind))
      return original(...args)
    }) as typeof original
    const pending = resolver.post(C, client(C), message, { surface, onPosted(posted) {
      atCallback.push(calls.map(c => c.kind)); callbacks.push(posted)
    } })
    // No await has occurred: both the start and the actual Slack call exist.
    expect(calls).toEqual([{ kind: 'start', key: C.key, surface,
      target: { channel: 'C0CHAN002' }, content: { kind: 'text', text: message.text }, operation: expect.any(Object) }])
    expect(posts(C)).toEqual([{ channel: 'C0CHAN002', ...message, metadata: SERVER_POST_METADATA }])
    expect(atPost).toEqual([['start']])
    await drainMicrotasks()
    expect(calls).toHaveLength(1)
    expect(callbacks).toEqual([])
    answer.settle({ kind: 'ok', result: { ts: '1700000000.000900', message: { thread_ts: '1700000000.000800' } } })
    const posted = { outcome: 'posted' as const, channelId: 'C0CHAN002', ts: '1700000000.000900' }
    expect(record(await pending)).toEqual(posted)
    expect(calls).toHaveLength(2)
    expect(calls[1]).toEqual({ kind: 'end', operation: calls[0]!.operation,
      answer: { kind: 'confirmed', channel: 'C0CHAN002', ts: posted.ts, threadTs: '1700000000.000800' } })
    expect(calls[1]!.operation).toBe(calls[0]!.operation)
    expect(atCallback).toEqual([['start', 'end']])
    expect(callbacks).toEqual([posted])
    results.push(callbacks)
    expect(logs).toEqual([])
  })

  test.each(['resolve', 'reject'] as const)('a held ready blocks Slack until it settles (%s), then posts exactly once', async settlement => {
    const held = holdOwnPostReady(), { calls, resolver } = observed([{ ready: held.ready }])
    const callbacks: DestinationPosted[] = []
    const pending = resolver.post(C, client(C), { text: 'waiting' }, { surface: 'notice', onPosted: p => { callbacks.push(p) } })
    await drainMicrotasks()
    expect(calls.map(c => c.kind)).toEqual(['start'])
    expect(posts(C)).toEqual([])
    expect(callbacks).toEqual([])
    if (settlement === 'resolve') held.resolve()
    else held.reject(new Error('injected readiness failure'))
    const result = record(await pending)
    expect(result).toMatchObject({ outcome: 'posted', channelId: 'C0CHAN002' })
    if (result.outcome !== 'posted') throw new Error('expected posted result')
    expect(callbacks).toEqual([result]); results.push(callbacks)
    expect(calls.map(c => c.kind)).toEqual(['start', 'end'])
    expect(posts(C)).toEqual([{ channel: 'C0CHAN002', text: 'waiting', metadata: SERVER_POST_METADATA }])
    expect(logs).toEqual([])
  })

  test.each(['platform', 'network', 'sync'] as const)('a %s post failure ends its operation exactly once and never calls onPosted', async kind => {
    const { calls, resolver } = observed()
    let synchronousCalls = 0, callbacks = 0
    if (kind === 'sync') stub(C).web.chat.postMessage = (() => {
      synchronousCalls++; throw new Error('sync post failure')
    }) as DestinationSlackClient['chat']['postMessage']
    else stub(C).script.post.push(kind === 'platform' ? { kind: 'platform', error: 'invalid_blocks' } : { kind: 'network' })
    const result = record(await resolver.post(C, client(C), { text: 'fails' }, { surface: 'prompt', onPosted: () => { callbacks++ } }))
    expect(result).toMatchObject({ outcome: 'failed', step: 'chat.postMessage', channelId: 'C0CHAN002' })
    if (result.outcome !== 'failed') throw new Error('expected failed post')
    expect(calls).toHaveLength(2)
    expect(calls[1]).toEqual({ kind: 'end', operation: calls[0]!.operation, answer: ownPostAnswerOfError(result.error) })
    expect(calls[1]!.operation).toBe(calls[0]!.operation)
    expect(callbacks).toBe(0)
    await drainMicrotasks()
    expect(kind === 'sync' ? synchronousCalls : posts(C).length).toBe(1)
    expect(logs).toEqual([])
  })

  test('an ok response without ts ends no-answer and preserves the callback and result', async () => {
    const { calls, resolver } = observed(), callbacks: DestinationPosted[] = []
    stub(C).script.post.push({ kind: 'ok', result: { ts: undefined } })
    const posted = { outcome: 'posted' as const, channelId: 'C0CHAN002', ts: undefined }
    expect(record(await resolver.post(C, client(C), { text: 'no ts' }, { surface: 'prompt', onPosted: p => { callbacks.push(p) } }))).toEqual(posted)
    expect(calls).toHaveLength(2)
    expect(calls[1]).toEqual({ kind: 'end', operation: calls[0]!.operation, answer: { kind: 'no-answer' } })
    expect(callbacks).toEqual([posted]); results.push(callbacks)
  })

  test.each(['start', 'end'] as const)('a payload failure with a throwing %s stays failed and is never posted again', async fault => {
    const error = new Error('injected observer failure')
    const { calls, resolver } = observed([fault === 'start' ? { throwStart: error } : { throwEnd: error }])
    stub(C).script.post.push({ kind: 'platform', error: 'invalid_blocks' })
    let callbacks = 0
    const result = record(await resolver.post(C, client(C), { text: 'bad payload' }, {
      surface: 'prompt', onPosted: () => { callbacks++ },
    }))
    expect(result).toMatchObject({ outcome: 'failed', step: 'chat.postMessage', code: 'invalid_blocks', channelId: 'C0CHAN002' })
    expect(calls.map(c => c.kind)).toEqual(['start', 'end'])
    expect(calls[1]).toMatchObject({ answer: { kind: 'failed', code: 'invalid_blocks' } })
    await drainMicrotasks()
    expect(posts(C)).toEqual([{ channel: 'C0CHAN002', text: 'bad payload', metadata: SERVER_POST_METADATA }])
    expect(callbacks).toBe(0)
    expect(logs).toEqual([])
  })

  test('a DM starts only after the open and names the opened conversation', async () => {
    const { calls, resolver } = observed(), opening = makeDeferredWebApiCall()
    stub(A).script.open.push(opening.outcome)
    const pending = resolver.post(A, client(A), { text: 'dm notice' }, { surface: 'notice' })
    await drainMicrotasks()
    expect(calls).toEqual([]); expect(posts(A)).toEqual([])
    const opened = openedDm('D0ALPHADM')
    if (opened.kind !== 'ok') throw new Error('expected opened DM fixture')
    opening.settle(opened)
    const result = record(await pending)
    expect(result).toMatchObject({ outcome: 'posted', channelId: 'D0ALPHADM' })
    expect(calls).toHaveLength(2)
    expect(calls[0]).toMatchObject({ kind: 'start', key: A.key, surface: 'notice',
      target: { channel: 'D0ALPHADM' }, content: { kind: 'text', text: 'dm notice' } })
    expect(calls[1]).toMatchObject({ kind: 'end', answer: { kind: 'confirmed', channel: 'D0ALPHADM' } })
    expect(calls[1]!.operation).toBe(calls[0]!.operation)
    expect(methods(A)).toEqual(['conversations.open', 'chat.postMessage'])
  })

  test.each(['no surface', 'DM disabled', 'no contact', 'failed open', 'open without ID'] as const)('%s starts no operation', async kind => {
    const { calls, resolver } = observed()
    const persona = kind === 'no surface' ? C : kind === 'DM disabled' ? { ...A, dm: { enabled: false } }
      : kind === 'no contact' ? { ...A, dm: { enabled: true } } : A
    if (kind === 'failed open') stub(A).script.open.push({ kind: 'platform', error: 'missing_scope' })
    if (kind === 'open without ID') stub(A).script.open.push({ kind: 'ok', result: { channel: undefined } })
    const result = record(await resolver.post(persona, client(persona), { text: 'excluded' }, kind === 'no surface' ? undefined : { surface: 'notice' }))
    expect(result.outcome).toBe(kind === 'no surface' ? 'posted' : kind.startsWith('open') || kind === 'failed open' ? 'failed' : 'refused')
    expect(calls).toEqual([])
    expect(posts(persona)).toHaveLength(kind === 'no surface' ? 1 : 0)
  })

  const faults = ['no observer', 'start', 'end', 'owner start', 'owner end', 'onPosted', 'no operation'] as const
  for (const surface of ['prompt', 'warning', 'notice'] as const) {
    test.each([...faults])(`${surface} with %s preserves one post, callback values and result without logging`, async fault => {
      const failure = new Error('injected bookkeeping failure')
      const recording = makeRecordingOwnPostObserver([fault === 'start' ? { throwStart: failure }
        : fault === 'end' ? { throwEnd: failure } : fault === 'no operation' ? { start: 'undefined' } : {}])
      let ownerCalls = 0
      const owner = createOwnPostObserver(() => ({
        startOperation(...args) {
          if (fault === 'owner start') { ownerCalls++; throw failure }
          return recording.observer.start(...args)
        },
        endOperation() { ownerCalls++; throw failure },
      }))
      const ownPosts: OwnPostObserver | undefined = fault === 'no observer' ? undefined
        : fault.startsWith('owner') ? owner : recording.observer
      const resolver = createPersonaDestinations({ log: line => logs.push(line), clock, getPersonaConfig: () => ({ channel_mode: 'strict' }), ownPosts })
      const callbacks: DestinationPosted[] = []
      stub(C).script.post.push({ kind: 'ok', result: { ts: '1700000000.000901' } })
      const result = record(await resolver.post(C, client(C), { text: 'notice' }, { surface, onPosted(posted) {
        callbacks.push(posted)
        if (fault === 'onPosted') throw failure
      } }))
      const posted = { outcome: 'posted' as const, channelId: 'C0CHAN002', ts: '1700000000.000901' }
      expect(result).toEqual(posted)
      expect(callbacks).toEqual([posted]); results.push(callbacks)
      expect(posts(C)).toEqual([{ channel: 'C0CHAN002', text: 'notice', metadata: SERVER_POST_METADATA }])
      if (fault.startsWith('owner')) expect(ownerCalls).toBe(1)
      expect(logs).toEqual([])
    })
  }
})

describe('destination joins through the production owner', () => {
  test.each(['prompt', 'notice', 'failed', 'off', 'dm', 'intent failure'] as const)('%s preserves posting and records only its eligible join', async scenario => {
    const channel = SHARED_CHANNEL_IDS.primary, ts = '1700000000.000950'
    const h = await makeOwnPostHarness(dir, { membership: { channels: [{ id: channel, delivery: scenario === 'off' ? 'off' : 'thread_hybrid' }] } })
    const slack = makeStubSlack({ leakMarker: LEAK_SENTINEL }), callbacks: DestinationPosted[] = []
    try {
      const persona = { ...h.authority.config().personas[0]!, permission_prompts: scenario === 'dm' ? DM_DESTINATION : channel }
      const resolver = createPersonaDestinations({ log: line => logs.push(line), clock, getPersonaConfig: h.authority.config, ownPosts: h.observer })
      slack.script.post.push(scenario === 'failed' ? { kind: 'platform', error: 'not_in_channel' } : { kind: 'ok', result: { ts } })
      if (scenario === 'intent failure') h.io.fail('writeSync')
      const result = record(await resolver.post(persona, asWebClient(slack.web), { text: 'owner notice' }, {
        surface: scenario === 'prompt' ? 'prompt' : 'notice', onPosted: p => { callbacks.push(p) },
      }))
      await h.flush()
      expect(slack.calls.postMessage).toHaveLength(1)
      const target = scenario === 'dm' ? stubOpenedDmId(persona.dm.contact!) : channel
      expect(result).toMatchObject({ outcome: scenario === 'failed' ? 'failed' : 'posted', channelId: target })
      expect(callbacks).toEqual(scenario === 'failed' ? [] : [{ outcome: 'posted', channelId: target, ts }])
      results.push(callbacks)
      const excluded = scenario === 'off' || scenario === 'dm'
      expect(h.events.filter(e => e.type === 'registered')).toHaveLength(excluded ? 0 : 1)
      expect(h.read.pendingOwnPosts(persona.key, target)).toEqual([])
      expect(h.view(persona.key, target, ts)).toBe(excluded || scenario === 'failed' ? 'not-joined' : 'joined')
      const records = h.records(persona.key)
      expect(records.filter(r => r.kind === 'post-intent')).toHaveLength(excluded || scenario === 'intent failure' ? 0 : 1)
      expect(records.filter(r => r.kind === 'post-outcome').map(r => r.outcome)).toEqual(excluded || scenario === 'intent failure' ? [] : [scenario === 'failed' ? 'none' : 'joined'])
      if (scenario === 'intent failure') expect(h.owner.memoryOnlyJoins(persona.key)).toEqual([{ channel, root: ts }])
      expect(logs).toEqual([])
      assertNoLeak({ result: results, callbacks, logs, owner: h.captured() })
    } finally { await h.close() }
  })
})

describe('never rejects', () => {
  test('a conversations.open that throws synchronously is a failed open, not a rejection', async () => {
    const web = stub(A).web
    web.conversations.open = (() => {
      throw new Error('sync open failure')
    }) as typeof web.conversations.open

    // Twice: the failed open is not cached, so the second post tries again and fails the same way.
    for (const text of ['x', 'y']) {
      await expect(d.post(A, client(A), { text })).resolves.toMatchObject({ outcome: 'failed', step: 'conversations.open', code: 'network_error' })
    }
    expect(posts(A)).toEqual([])
  })

  test.each([
    ['channel', () => C],
    ['dm', () => A],
  ] as const)('a chat.postMessage that throws synchronously on a %s destination is a failed post, not a rejection', async (_label, pick) => {
    const p = pick()
    const web = stub(p).web
    web.chat.postMessage = (() => {
      throw new Error('sync post failure')
    }) as typeof web.chat.postMessage

    await expect(d.post(p, client(p), { text: 'x' })).resolves.toMatchObject({ outcome: 'failed', step: 'chat.postMessage', code: 'network_error' })
  })
})

// ---------------------------------------------------------------------------
// Defensive refusal
// ---------------------------------------------------------------------------

describe('a dm destination with DMs off or no contact is refused', () => {
  test.each([
    ['DMs off', { enabled: false, contact: 'U0ALPHA01' }, 'dm_disabled', 'dm.enabled is not true'],
    ['no contact', { enabled: true }, 'no_dm_contact', 'dm.contact is not set'],
  ] as const)('%s: every post makes no Slack call and logs one line naming the persona', async (_label, dm, reason, names) => {
    const p: Persona = { ...A, dm }

    expect(await post(p, 'first')).toEqual({ outcome: 'refused', reason })
    expect(await post(p, 'second')).toEqual({ outcome: 'refused', reason })

    expect(methods(A)).toEqual([])
    const line =
      `[slack] persona-destination: ${renderPersonaRef(A.name, A.key)} has permission_prompts set to "dm" but ` +
      `${names} — no DM opened and nothing posted`
    expect(logs).toEqual([line, line])
  })

  test('a channel destination is never refused, whatever its DM settings', () => {
    expect(dmDestinationRefusal(undefined, { ...C, dm: { enabled: false } })).toBeUndefined()
    expect(dmDestinationRefusal(undefined, A)).toBeUndefined()
  })

  test('turning DMs off keeps no cached DM in use: the refused persona makes no call even after a successful open', async () => {
    await post(A)

    expect(await post({ ...A, dm: { enabled: false, contact: 'U0ALPHA01' } })).toEqual({ outcome: 'refused', reason: 'dm_disabled' })
    expect(methods(A)).toEqual(['conversations.open', 'chat.postMessage'])
  })
})

// ---------------------------------------------------------------------------
// Token-safe failure description
// ---------------------------------------------------------------------------

describe('describeDestinationFailure (token-safe)', () => {
  test('a token in a thrown value\'s message never appears in the description; the message is logged redacted', async () => {
    const token = fakeToken(BOT_TOKEN_PREFIX, 'x')
    stub(A).script.open.push({ kind: 'reject', value: Object.assign(new Error(`bad auth ${token}`), { code: 'slack_webapi_request_error' }) })

    const failed = (await post(A)) as DestinationFailure
    const tail = describeDestinationFailure(failed)

    expect(tail).toStartWith(': Error code=slack_webapi_request_error message="bad auth <redacted-token>"')
    expect(tail).not.toContain(BOT_TOKEN_PREFIX)
    assertNoLeak({ tail })
  })

  test('a platform error carries its Slack reason and the error\'s message logged redacted', async () => {
    // The stub's platform rejection quotes a fake token and a WebSocket
    // ticket URL, each holding the leak sentinel.
    stub(A).script.open.push({ kind: 'platform', error: 'missing_scope' })

    const tail = describeDestinationFailure((await post(A)) as DestinationFailure)

    expect(tail).toStartWith(' (reason=missing_scope): Error code=slack_webapi_platform_error message="')
    const message = /message="([^"]*)"/.exec(tail)?.[1]
    expect(message).toContain('missing_scope')
    expect(message).toContain('<redacted-token>')
    expect(message).toContain('<redacted-url>')
    assertNoLeak({ tail })
  })

  test('an open with no conversation ID is described by its code alone', async () => {
    stub(A).script.open.push({ kind: 'ok', result: { channel: undefined } })

    const failed = (await post(A)) as DestinationFailure
    expect(failed.error).toBeUndefined()
    expect(describeDestinationFailure(failed)).toBe(` (reason=${NO_CONVERSATION_ID_CODE})`)
  })
})

describe('describeDestinationFailureCause (token-safe)', () => {
  test('a failed open names the open step and its code, then the thrown-value description', async () => {
    stub(A).script.open.push({ kind: 'platform', error: 'missing_scope' })

    const failed = (await post(A)) as DestinationFailure
    const cause = describeDestinationFailureCause(failed)

    expect(cause).toBe(`conversations.open code=missing_scope: ${describeThrownValue(failed.error)}`)
    expect(cause).toContain('<redacted-token>')
    expect(cause).toContain('<redacted-url>')
    assertNoLeak({ cause })
  })

  test('an open with no conversation ID is the open step and no_conversation_id alone', async () => {
    stub(A).script.open.push({ kind: 'ok', result: { channel: undefined } })

    expect(describeDestinationFailureCause((await post(A)) as DestinationFailure)).toBe(`conversations.open code=${NO_CONVERSATION_ID_CODE}`)
  })

  test('an open that rejected with undefined still marks that it threw', async () => {
    stub(A).script.open.push({ kind: 'reject', value: undefined })

    expect(describeDestinationFailureCause((await post(A)) as DestinationFailure)).toBe('conversations.open code=unknown_error: undefined')
  })

  test.each<[string, () => Persona]>([
    ['channel', () => C],
    ['dm', () => A],
  ])('a failed post on a %s destination is the thrown-value description unchanged, with no step or code prefix', async (_label, pick) => {
    const p = pick()
    stub(p).script.post.push({ kind: 'platform', error: 'not_in_channel' })

    const failed = (await post(p)) as DestinationFailure
    expect(failed).toMatchObject({ outcome: 'failed', step: 'chat.postMessage', code: 'not_in_channel' })
    const cause = describeDestinationFailureCause(failed)

    expect(cause).toBe(describeThrownValue(failed.error))
    expect(cause).toStartWith('Error code=slack_webapi_platform_error ')
    expect(cause).not.toContain('conversations.open')
    expect(cause).not.toContain('code=not_in_channel')
    assertNoLeak({ cause })
  })

  test('an open whose Slack error code is not a short identifier (a fake token) is printed as unknown_error', async () => {
    const token = fakeToken(BOT_TOKEN_PREFIX, 'code')
    stub(A).script.open.push({ kind: 'platform', error: token })

    // Not recorded: the returned code is the raw Slack error, which here holds the fake token.
    const failed = (await d.post(A, client(A), { text: 'x' })) as DestinationFailure
    expect(failed).toMatchObject({ outcome: 'failed', step: 'conversations.open', code: token })
    const cause = describeDestinationFailureCause(failed)

    expect(cause).toStartWith('conversations.open code=unknown_error: ')
    expect(cause).not.toContain(BOT_TOKEN_PREFIX)
    assertNoLeak({ cause })
  })

  test.each<[string, string]>([
    ['a hyphenated token', fakeToken(BOT_TOKEN_PREFIX, 'x')],
    ['spaces', 'not in channel'],
    ['a newline', 'missing_scope\nsecond'],
    ['more than 64 characters', `a${'b'.repeat(64)}`],
    ['an empty string', ''],
  ])('a failure built with a code holding %s prints unknown_error', (_label, code) => {
    const failure: DestinationFailure = { outcome: 'failed', step: 'conversations.open', code, error: new Error('boom') }

    const cause = describeDestinationFailureCause(failure)
    expect(cause).toStartWith('conversations.open code=unknown_error: Error')
    assertNoLeak({ cause })
  })

  test.each([
    ['conversations.open', 'conversations.open code=network_error: Error code=slack_webapi_request_error'],
    ['chat.postMessage', 'Error code=slack_webapi_request_error'],
  ] as const)('a fake xoxb- token in the %s error message never appears in the cause; the message is logged redacted', async (step, prefix) => {
    const token = fakeToken(BOT_TOKEN_PREFIX, 'msg')
    const err = Object.assign(new Error(`bad auth ${token}`), { code: 'slack_webapi_request_error' })
    const outcome: WebApiOutcome = { kind: 'reject', value: err }
    if (step === 'conversations.open') stub(A).script.open.push(outcome)
    else stub(A).script.post.push(outcome)

    const failed = (await post(A)) as DestinationFailure
    expect(failed.step).toBe(step)
    const cause = describeDestinationFailureCause(failed)

    expect(cause).toStartWith(`${prefix} message="bad auth <redacted-token>"`)
    expect(cause).not.toContain(BOT_TOKEN_PREFIX)
    assertNoLeak({ cause })
  })
})

describe('one shared destination in strict and open modes', () => {
  test.each(['strict', 'open'] as const)('%s names permission_prompts for channel and DM destinations', async channel_mode => {
    const config = { channel_mode }
    expect(destinationSettingOf()).toBe('permission_prompts')
    const resolver = createPersonaDestinations({ log: line => logs.push(line), clock, getPersonaConfig: () => config })
    expect(personaDestinationOf(C)).toBe(C.permission_prompts)
    expect(resolver.destinationOf(C)).toBe(C.permission_prompts)
    expect(resolver.destinationOf(A)).toBe('dm')
    expect(dmDestinationRefusal(config, A)).toBeUndefined()
    expect(record(await resolver.post(C, client(C), { text: 'channel' }))).toMatchObject({ outcome: 'posted', channelId: C.permission_prompts })
    expect(record(await resolver.post(A, client(A), { text: 'direct' }))).toMatchObject({ outcome: 'posted' })
    expect(opens(A)).toEqual([{ users: A.dm.contact! }])
    expect(stub(B).callLog).toEqual([])
  })
  test('a mode-only edit preserves the same destination and DM cache; a destination edit affects the next post', async () => {
    let config: DestinationConfig = { channel_mode: 'strict' }
    const resolver = createPersonaDestinations({ log: line => logs.push(line), clock, getPersonaConfig: () => config })
    await resolver.post(A, client(A), { text: 'first' })
    config = { channel_mode: 'open' }
    await resolver.post(A, client(A), { text: 'second' })
    expect(opens(A)).toHaveLength(1)
    const changed = { ...A, channels: C.channels, permission_prompts: C.permission_prompts }
    expect(record(await resolver.post(changed, client(A), { text: 'changed' }))).toMatchObject({ outcome: 'posted', channelId: C.permission_prompts })
    expect(opens(A)).toHaveLength(1)
    expect(stub(B).callLog).toEqual([])
  })
  test.each(['strict', 'open'] as const)('%s defensively refuses a DM without enabled/contact and makes no Slack call', async channel_mode => {
    const config = { channel_mode }
    const resolver = createPersonaDestinations({ log: line => logs.push(line), clock, getPersonaConfig: () => config })
    for (const dm of [{ enabled: false }, { enabled: true }]) {
      const persona = { ...A, dm }
      expect(record(await resolver.post(persona, client(A), { text: 'refused' }))).toEqual({ outcome: 'refused', reason: dm.enabled ? 'no_dm_contact' : 'dm_disabled' })
    }
    expect(stub(A).callLog).toEqual([])
    expect(stub(B).callLog).toEqual([])
    expect(logs.every(line => line.includes('permission_prompts'))).toBe(true)
  })
})
