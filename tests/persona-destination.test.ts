/**
 * persona-destination.test.ts — Where a persona's permission prompts and
 * notices go, and the post there (b.av2 SR-7.1, SR-5.1).
 *
 * The destination module is proven here once, so the poller and notifier
 * suites need not re-prove it: a channel destination is the configured
 * channel, a `dm` destination is the persona's DM with `dm.contact`, opened
 * with `conversations.open` on the persona's own client and cached per persona
 * until the contact changes, the persona is forgotten, the open fails, or a
 * post to the cached conversation fails `channel_not_found`. Concurrent posts
 * share one open. A `dm` destination with DMs off or no contact is refused
 * with no Slack call. Nothing rejects. A `channel_not_found` eviction is
 * synchronous and drops only the entry the post used, never a newer (even
 * pending) one. An open in flight across a `forget(key)` (an in-place update,
 * with or without a new contact) that then succeeds is never reused. Failures are described token-safely
 * (`describeDestinationFailure`, `describeDestinationFailureCause`).
 *
 * Pure module under test: built over one `makeStubSlack` stub per persona
 * (leak marker on) and a line capture. No token, file or timer is used;
 * `afterEach` runs `assertNoLeak` over every log line and result.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { Persona } from '../src/config.ts'
import {
  NO_CONVERSATION_ID_CODE,
  createPersonaDestinations,
  describeDestinationFailure,
  describeDestinationFailureCause,
  dmDestinationRefusal,
  type DestinationFailure,
  type DestinationSlackClient,
  type PersonaDestinations,
} from '../src/persona-destination.ts'
import { describeThrownValue } from '../src/persona-connection-errors.ts'
import { renderPersonaRef } from '../src/persona-identity.ts'
import { makeMultiPersonaConfig } from './test-helpers/persona-config.ts'
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
  d = createPersonaDestinations({ log: (line) => logs.push(line) })
}

const stub = (p: Persona): StubSlack => stubs.get(p.key)!
const client = (p: Persona): DestinationSlackClient => asWebClient(stub(p).web)
const methods = (p: Persona): string[] => stub(p).callLog.map((c) => c.method)
const opens = (p: Persona) => stub(p).calls.conversationsOpen
/** `chat.postMessage` arguments on `p`'s stub, as the module passes them. */
const posts = (p: Persona) => stub(p).calls.postMessage as { channel: string; text: string; blocks?: unknown[] }[]

/** The persona with another contact (an in-place contact change, as E12's reload makes). */
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
  assertNoLeak({ lines: logs, results })
  rmSync(dir, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

describe('resolution (SR-7.1)', () => {
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
      { channel: 'D0ALPHADM', text: 'p1' },
      { channel: 'D0ALPHADM', text: 'p2' },
      { channel: 'D0ALPHADM', text: 'p3' },
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
  // `dm.enabled` or `permission_prompts` changed (E12 decision 11), so the
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
      ['chat.postMessage', { channel: stubOpenedDmId('U0ALPHA01'), text: 'for A' }],
    ])
    expect(stub(B).callLog.map((c) => [c.method, c.args])).toEqual([
      ['conversations.open', { users: 'U0BETA002' }],
      ['chat.postMessage', { channel: stubOpenedDmId('U0BETA002'), text: 'for B' }],
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
      expect(posts(A)).toEqual([{ channel: stubOpenedDmId('U0ALPHA01'), text: 'second' }])
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

describe('posting (SR-7.1, SR-3.1)', () => {
  test('AC 29 / AC 44: a DM-only persona\'s first post, with no DM yet, opens the DM on its own client, then posts to the D… ID (never the user ID) with no username or icon override', async () => {
    const r = await d.post(A, client(A), { text: 'prompt', blocks: [{ type: 'section' }] })
    record(r)

    const dm = stubOpenedDmId('U0ALPHA01')
    expect(r).toEqual({ outcome: 'posted', channelId: dm, ts: expect.any(String) })
    expect(methods(A)).toEqual(['conversations.open', 'chat.postMessage'])
    const [args] = posts(A)
    expect(args).toEqual({ channel: dm, text: 'prompt', blocks: [{ type: 'section' }] })
    expect(args!.channel).not.toBe('U0ALPHA01')
    for (const s of [B, C]) expect(methods(s)).toEqual([])
  })

  test('a channel destination posts exactly {channel, text} to the configured channel with no open and no log line, and the post is issued synchronously', () => {
    const pending = d.post(C, client(C), { text: 'now' })
    // Before any await: the channel post is already made.
    expect(posts(C)).toEqual([{ channel: 'C0CHAN002', text: 'now' }])
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
// Defensive refusal (SR-5.1)
// ---------------------------------------------------------------------------

describe('a dm destination with DMs off or no contact is refused (SR-5.1)', () => {
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
