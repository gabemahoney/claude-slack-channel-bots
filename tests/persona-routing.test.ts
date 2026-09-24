/**
 * persona-routing.test.ts — Inbound channel delivery per persona (b.av2 SR-4.1
 * and SR-4.2 core, SR-10.1 gate removal, SR-10.3 `unclaimed-channel`).
 *
 * Replaces the old DM-routing and default-route fallback suites and the gate
 * and pairing cases of server.test.ts (b.av2 SR-13.5). Drives the real
 * `createPersonaRouting` from src/persona-routing.ts (never server.ts) over:
 *
 * - one `makeStubSlack` stub per persona (leak marker on), handed out through
 *   `makePersonaClients` as the injected `clientFor`;
 * - the real persona-keyed registry, with a fake MCP server per registered
 *   session that captures `notifications/claude/channel` calls;
 * - the real restart and backoff state (restart deps injected with a fast
 *   delay, launches captured);
 * - a line capture for the module's log seam, and a `console.error` spy for
 *   the restart and registry modules' own lines.
 *
 * Until E3 Task 9 the server hands each event to every persona's pipeline, so
 * the tests feed one event to several persona keys in one `receive` call.
 *
 * Owns AC 1, AC 2 and 12 (persona-routing leg; the tool-level scope stays in
 * registry.test.ts) and AC 52. E4 adds rows to the delivery table (broadcasts,
 * dedupe, `via`, bot-to-bot) and E6 replaces the interim DM drop.
 *
 * SPDX-License-Identifier: MIT
 */

import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  decideDelivery,
  LOST_MESSAGE_RESTARTING_REPLY,
  LOST_MESSAGE_STARTED_REPLY,
} from '../src/persona-routing.ts'
import { renderPersonaRef } from '../src/persona-identity.ts'
import { checkPersonaTarget, unregisterSession } from '../src/registry.ts'
import { isRestartPendingOrActive } from '../src/restart.ts'
import { openArchiveDatabase } from '../src/message-archive.ts'
import type { PersonaSpec } from './test-helpers/persona-config.ts'
import {
  makeAppMention,
  makeBotMessage,
  makeChannelMessage,
  makeDm,
  mentionText,
  type SlackEvent,
} from './test-helpers/slack-stub.ts'
import { posts, slackCalls } from './test-helpers/permission-relay-harness.ts'
import { buildTempArchiveDb } from './test-helpers/archive-db.ts'
import { LEAK_SENTINEL, assertNoLeak } from './test-helpers/credentials.ts'
import {
  makeRoutingHarness,
  resetRoutingState,
  waitFor,
  type RoutingHarness,
  type RoutingHarnessOptions,
} from './test-helpers/persona-routing-harness.ts'

// ---------------------------------------------------------------------------
// Channels
// ---------------------------------------------------------------------------

/** A's home channel (`all`). */
const CA = 'C0HOMEA01'
/** B's home channel (`all`). */
const CB = 'C0HOMEB01'
/** Shared channel: A and B both `mentions`. */
const CS = 'C0SHARED1'
/** A channel no persona lists. */
const CX = 'C0NOBODY1'

// ---------------------------------------------------------------------------
// Harness (tests/test-helpers/persona-routing-harness.ts)
// ---------------------------------------------------------------------------

type Harness = RoutingHarness

let dir: string
let consoleLines: string[]
let consoleSpy: ReturnType<typeof spyOn>

function makeHarness(specs: PersonaSpec[], opts: RoutingHarnessOptions = {}): Harness {
  return makeRoutingHarness(specs, dir, opts)
}

/** Everything a case captured, for `assertNoLeak`. */
function captured(h: Harness): Record<string, unknown> {
  return { ...h.captured(), console: consoleLines }
}

const lines = (h: Harness, needle: string) => h.logs.filter((l) => l.includes(needle))

/** Every captured line (module log seam and console) that contains `text`. */
const linesWithText = (h: Harness, text: string) => [...h.logs, ...consoleLines].filter((l) => l.includes(text))

/** A has `all` in CA and `mentions` in CS; B has `all` in CB and `mentions` in CS (the AC 1 setup). */
function ac1Specs(): PersonaSpec[] {
  return [
    { name: 'Alpha Bot', channels: [{ id: CA, delivery: 'all' }, { id: CS, delivery: 'mentions' }] },
    { name: 'Beta Bot', channels: [{ id: CB, delivery: 'all' }, { id: CS, delivery: 'mentions' }] },
  ]
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'persona-routing-'))
  resetRoutingState()
  consoleLines = []
  consoleSpy = spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    consoleLines.push(args.map(String).join(' '))
  })
})

afterEach(() => {
  try {
    resetRoutingState()
  } finally {
    consoleSpy.mockRestore()
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// AC 1: each persona hears its own channels
// ---------------------------------------------------------------------------

describe('AC 1: two personas, home channels and a shared mention-only channel', () => {
  test.each([
    ['B has a live session', ['Alpha Bot', 'Beta Bot']],
    ['B has no live session', ['Alpha Bot']],
  ])('AC 1: A\'s home message and a mention of A in the shared channel reach A once each and never B (%s)', async (_label, sessions) => {
    const h = makeHarness(ac1Specs(), { sessions })
    const A = h.p('Alpha Bot')
    const B = h.p('Beta Bot')
    const home = makeChannelMessage({ channel: CA })
    const mention = makeChannelMessage({ channel: CS, text: `${mentionText(A.stub.identity.botUserId)} can you look?` })

    await h.receive(home)
    await h.receive(mention)

    expect(A.notifications.map((n) => n.params.meta.chat_id)).toEqual([CA, CS])
    expect(B.notifications).toHaveLength(0)
    expect(slackCalls(B.stub)).toBe(0)
    expect(isRestartPendingOrActive(B.persona.key)).toBe(false)
    expect(h.launches).toEqual([])
    assertNoLeak(captured(h))
  })

  test('AC 1 / AC 52: a home message in B\'s channel reaches only B; A, which does not list it, logs nothing (no unclaimed-channel line)', async () => {
    const h = makeHarness(ac1Specs())
    const A = h.p('Alpha Bot').persona
    await h.receive(makeChannelMessage({ channel: CB }))

    expect(h.p('Beta Bot').notifications.map((n) => n.params.meta.chat_id)).toEqual([CB])
    expect(h.p('Alpha Bot').notifications).toHaveLength(0)
    expect(slackCalls(h.p('Alpha Bot').stub)).toBe(0)
    expect(lines(h, 'unclaimed-channel')).toEqual([])
    expect(lines(h, renderPersonaRef(A.name, A.key))).toEqual([])
    assertNoLeak(captured(h))
  })

  test('AC 1: a message in B\'s home channel while B has no session is not delivered to A, and only B recovers and replies (b.7a4)', async () => {
    const h = makeHarness(ac1Specs(), { sessions: ['Alpha Bot'] })
    const A = h.p('Alpha Bot')
    const B = h.p('Beta Bot')
    await h.receive(makeChannelMessage({ channel: CB }))

    expect(A.notifications).toHaveLength(0)
    expect(slackCalls(A.stub)).toBe(0)
    expect(posts(B.stub).map((c) => ({ channel: c.channel, text: c.text }))).toEqual([{ channel: CB, text: LOST_MESSAGE_STARTED_REPLY }])
    expect(isRestartPendingOrActive(B.persona.key)).toBe(true)
    expect(isRestartPendingOrActive(A.persona.key)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// AC 2 and 12: one persona, several channels, one instance
// ---------------------------------------------------------------------------

describe('AC 2 / AC 12: a persona in several channels hears all of them in one instance', () => {
  const C1 = 'C0MULTI01'
  const C2 = 'C0MULTI02'
  const C3 = 'C0MULTI03'

  test.each([
    ['all three channels `all` (AC 12 human impersonation)', 'all' as const],
    ['one channel `mentions`, mentioned there', 'mentions' as const],
  ])('AC 2 / AC 12: each message reaches the single session with its source chat_id, which passes the posting scope (%s)', async (_label, thirdDelivery) => {
    const h = makeHarness([
      { name: 'Multi Bot', channels: [{ id: C1, delivery: 'all' }, { id: C2, delivery: 'all' }, { id: C3, delivery: thirdDelivery }] },
      { name: 'Other Bot' },
    ])
    const P = h.p('Multi Bot')
    const mention = mentionText(P.stub.identity.botUserId)

    for (const channel of [C1, C2, C3]) {
      await h.receive(makeChannelMessage({ channel, text: `${mention} message for ${channel}` }))
    }

    const chatIds = P.notifications.map((n) => n.params.meta.chat_id)
    expect(chatIds).toEqual([C1, C2, C3])
    expect(P.notifications.map((n) => n.params.content)).toEqual([C1, C2, C3].map((c) => `message for ${c}`))
    for (const chatId of chatIds) expect(checkPersonaTarget(P.persona, chatId)).toEqual({ allowed: true })
    // Control: the scope check is not vacuous.
    expect(checkPersonaTarget(P.persona, CX).allowed).toBe(false)
    expect(h.p('Other Bot').notifications).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// Delivery rules (b.av2 SR-4.2 core), against the receiving persona P
// ---------------------------------------------------------------------------

describe('delivery rules against the receiving persona P', () => {
  /** P: `all` in C0PALL001, `mentions` in C0PMENT01. Q: `all` in C0QALL001, `mentions` in C0PMENT01. */
  const PALL = 'C0PALL001'
  const PMENT = 'C0PMENT01'
  const QALL = 'C0QALL001'
  const specs = (): PersonaSpec[] => [
    { name: 'Pilot', channels: [{ id: PALL, delivery: 'all' }, { id: PMENT, delivery: 'mentions' }] },
    { name: 'Quill', channels: [{ id: QALL, delivery: 'all' }, { id: PMENT, delivery: 'mentions' }] },
  ]
  type Ids = { p: string; q: string }

  // One row per rule; E4 appends broadcast, dedupe and bot-to-bot rows here.
  test.each<[string, (ids: Ids) => SlackEvent, boolean]>([
    ['`all` channel: a plain message is delivered', () => makeChannelMessage({ channel: PALL }), true],
    ['`all` channel: a human with no allowlist or pairing entry is delivered (no sender filter)', () => makeChannelMessage({ channel: PALL, user: 'U0STRANGER' }), true],
    ['`mentions` channel: a message with P\'s user mention is delivered', (ids) => makeChannelMessage({ channel: PMENT, text: `${mentionText(ids.p)} hi` }), true],
    ['`mentions` channel: an app_mention of P is delivered', (ids) => makeAppMention({ channel: PMENT, text: `${mentionText(ids.p)} hi` }), true],
    ['`mentions` channel: a message without a mention is dropped', () => makeChannelMessage({ channel: PMENT }), false],
    ['`mentions` channel: a message mentioning only another persona is dropped', (ids) => makeChannelMessage({ channel: PMENT, text: `${mentionText(ids.q)} hi` }), false],
    ['`mentions` channel: P\'s name as plain text (no user mention) is dropped', () => makeChannelMessage({ channel: PMENT, text: '@Pilot hi' }), false],
    ['own message (author user = P\'s bot user, no bot_id) in an `all` channel is dropped', (ids) => makeChannelMessage({ channel: PALL, user: ids.p }), false],
    ['own message mentioning itself in a `mentions` channel is dropped', (ids) => makeChannelMessage({ channel: PMENT, user: ids.p, text: `${mentionText(ids.p)} hi` }), false],
    ['own bot post (bot_id and P\'s bot user) is dropped', (ids) => makeBotMessage({ channel: PALL, user: ids.p }), false],
    ['another app\'s bot message (its own user, no subtype) in an `all` channel is delivered (today; E4 revisits bot-to-bot)', () => makeBotMessage({ channel: PALL }), true],
    ['a channel P is not configured into (another persona\'s) is not delivered', () => makeChannelMessage({ channel: QALL }), false],
    ['a channel no persona lists is not delivered', () => makeChannelMessage({ channel: CX }), false],
    ['subtype message_changed is dropped', () => makeChannelMessage({ channel: PALL, subtype: 'message_changed' }), false],
    ['subtype message_deleted is dropped', () => makeChannelMessage({ channel: PALL, subtype: 'message_deleted' }), false],
    ['subtype channel_join is dropped', () => makeChannelMessage({ channel: PALL, subtype: 'channel_join' }), false],
    ['subtype file_share is delivered', () => makeChannelMessage({ channel: PALL, subtype: 'file_share', files: [{ name: 'a.txt' }] }), true],
    ['a message with no user is dropped (today; E4 revisits authorless posts)', () => makeChannelMessage({ channel: PALL, user: undefined }), false],
  ])('%s', async (_label, build, delivered) => {
    const h = makeHarness(specs())
    const P = h.p('Pilot')
    const event = build({ p: P.stub.identity.botUserId, q: h.p('Quill').stub.identity.botUserId })

    await h.receive(event, ['Pilot'])

    expect(P.notifications).toHaveLength(delivered ? 1 : 0)
    if (delivered) expect(P.notifications[0]!.params.meta.chat_id).toBe(event.channel as string)
    // A decision never replies or restarts on its own.
    expect(posts(P.stub)).toEqual([])
    expect(isRestartPendingOrActive(P.persona.key)).toBe(false)
  })

  test('delivered meta and text follow today\'s shape, with the user name looked up on P\'s client', async () => {
    const h = makeHarness(specs())
    const P = h.p('Pilot')
    const Q = h.p('Quill')
    const event = makeChannelMessage({
      channel: PMENT,
      subtype: 'file_share',
      thread_ts: '1700000000.000001',
      text: `${mentionText(P.stub.identity.botUserId)}  please review`,
      files: [{ name: 'report.pdf', mimetype: 'application/pdf', size: 2048 }],
    })

    await h.receive(event)

    expect(P.notifications).toHaveLength(1)
    const { method, params } = P.notifications[0]!
    expect(method).toBe('notifications/claude/channel')
    expect(params.content).toBe('please review')
    expect(params.meta).toMatchObject({
      chat_id: PMENT,
      message_id: event.ts as string,
      ts: event.ts as string,
      thread_ts: '1700000000.000001',
      user: 'stub-user',
      attachment_count: '1',
      attachments: 'report.pdf (application/pdf, 2048 bytes)',
    })
    expect(P.stub.calls.usersInfo).toEqual([{ user: event.user as string }])
    expect(Q.stub.calls.usersInfo).toEqual([])
    expect(Q.notifications).toHaveLength(0)
  })

  test('an empty bot user ID for P: nothing is dropped as P\'s own, no mention matches, and the text is not stripped', async () => {
    const h = makeHarness(specs(), { stubOptions: { Pilot: { botUserId: '' } } })
    const P = h.p('Pilot')
    const emptyMention = `${mentionText('')} hi`

    // `all` channel: a human's message, even one holding the empty-ID mention token, is delivered unchanged.
    await h.receive(makeChannelMessage({ channel: PALL, text: emptyMention }), ['Pilot'])
    // `mentions` channel: neither the empty-ID token nor another persona's mention counts as P's mention.
    await h.receive(makeChannelMessage({ channel: PMENT, text: emptyMention }), ['Pilot'])
    await h.receive(makeChannelMessage({ channel: PMENT, text: `${mentionText(h.p('Quill').stub.identity.botUserId)} hi` }), ['Pilot'])

    expect(P.notifications.map((n) => ({ chat_id: n.params.meta.chat_id, content: n.params.content }))).toEqual([
      { chat_id: PALL, content: emptyMention },
    ])
    expect(lines(h, ': own')).toEqual([])
    expect(lines(h, ': not-mentioned')).toHaveLength(2)
    // The pure decision agrees for an unknown (undefined) bot user ID.
    const applied = h.config!.personas
    expect(decideDelivery(makeChannelMessage({ channel: PALL }), { botUserId: undefined, channels: P.persona.channels }, applied)).toEqual({ action: 'deliver' })
    expect(decideDelivery(makeChannelMessage({ channel: PMENT, text: emptyMention }), { botUserId: undefined, channels: P.persona.channels }, applied))
      .toEqual({ action: 'drop', reason: 'not-mentioned' })
  })
})

// ---------------------------------------------------------------------------
// AC 52: unclaimed-channel (b.av2 SR-10.3)
// ---------------------------------------------------------------------------

describe('AC 52: unclaimed-channel line', () => {
  // The silence of a channel another persona claims is pinned by the AC 1 / AC 52 case above.
  test('AC 52: a channel no applied persona lists logs one unclaimed-channel line per receiving persona, naming the channel and that persona, without the message text, and reaches no session', async () => {
    const h = makeHarness(ac1Specs())
    const marker = 'ZEBRA7731UNCLAIMED'
    await h.receive(makeChannelMessage({ channel: CX, text: `${marker} quarterly numbers` }))

    for (const { persona, notifications } of h.all) {
      const mine = lines(h, `unclaimed-channel: personas[${persona.index}] ${renderPersonaRef(persona.name, persona.key)}`)
      expect(mine).toHaveLength(1)
      expect(mine[0]).toContain(CX)
      expect(notifications).toHaveLength(0)
    }
    expect(lines(h, 'unclaimed-channel')).toHaveLength(2)
    expect(linesWithText(h, marker)).toEqual([])
    expect(h.all.map((x) => slackCalls(x.stub))).toEqual([0, 0])
    assertNoLeak(captured(h))
  })
})

// ---------------------------------------------------------------------------
// DMs (interim until E6)
// ---------------------------------------------------------------------------

describe('DMs are dropped with a persona-dm-dropped line (interim until E6)', () => {
  const marker = 'ZEBRA4410DIRECT'

  // Rule order (5i): the subtype and own-message rules run before the DM rule,
  // so a DM that is P's own message, or a non-file_share subtype, is dropped
  // for that reason and logs no persona-dm-dropped line.
  test.each<[string, boolean, boolean, (pBot: string) => SlackEvent, 'dm' | 'own' | 'non-message']>([
    ['DMs off, session live', false, true, () => makeDm({ text: `${marker} private note` }), 'dm'],
    ['DMs on, session live', true, true, () => makeDm({ text: `${marker} private note` }), 'dm'],
    ['DMs on, no session', true, false, () => makeDm({ text: `${marker} private note` }), 'dm'],
    ['P\'s own DM, DMs on, session live', true, true, (pBot) => makeDm({ user: pBot, text: `${marker} private note` }), 'own'],
    ['a message_changed DM, DMs on, session live', true, true, () => makeDm({ subtype: 'message_changed', text: `${marker} private note` }), 'non-message'],
  ])('a DM is not delivered, gets no reply or restart, logs no message text, and logs the line its rule gives (%s)', async (_label, enabled, live, build, reason) => {
    const h = makeHarness(
      [{ name: 'Dm Bot', dm: { enabled } }],
      { sessions: live ? ['Dm Bot'] : [] },
    )
    const P = h.p('Dm Bot')
    const ref = renderPersonaRef(P.persona.name, P.persona.key)

    await h.receive(build(P.stub.identity.botUserId))

    const dropped = lines(h, 'persona-dm-dropped')
    if (reason === 'dm') {
      expect(dropped).toHaveLength(1)
      expect(dropped[0]).toContain(`personas[0] ${ref}`)
      expect(lines(h, `persona ${ref} dropped message`)).toEqual([])
    } else {
      expect(dropped).toEqual([])
      expect(lines(h, `persona ${ref} dropped message`).filter((l) => l.endsWith(`: ${reason}`))).toHaveLength(1)
    }
    expect(lines(h, 'unclaimed-channel')).toEqual([])
    expect(linesWithText(h, marker)).toEqual([])
    expect(P.notifications).toHaveLength(0)
    expect(posts(P.stub)).toEqual([]) // no pairing reply, no lost-message reply
    expect(isRestartPendingOrActive(P.persona.key)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Intake (b.av2 SR-4.1 core)
// ---------------------------------------------------------------------------

describe('intake', () => {
  // A `message` and an `app_mention` of P in a `mentions` channel: see the delivery-rules table.

  test('the event is acked exactly once, before the archive write and before any decision', async () => {
    const h = makeHarness(ac1Specs())
    await h.receive(makeChannelMessage({ channel: CA }))

    expect(h.order.filter((m) => m === 'ack')).toHaveLength(1)
    expect(h.order[0]).toBe('ack')
    expect(h.order).toContain(`archive:${h.p('Alpha Bot').persona.key}`)
    expect(h.p('Alpha Bot').notifications).toHaveLength(1)
  })

  test('the ack happens even when a later step never settles', async () => {
    const h = makeHarness(ac1Specs(), { resolveUserName: () => new Promise<string>(() => {}) })
    void h.receive(makeChannelMessage({ channel: CA }))
    await new Promise((r) => setTimeout(r, 5))

    expect(h.order.filter((m) => m === 'ack')).toHaveLength(1)
    expect(h.order[0]).toBe('ack')
    expect(h.p('Alpha Bot').notifications).toHaveLength(0)
  })

  test('a failed ack is logged token-safely and delivery still happens', async () => {
    const h = makeHarness(ac1Specs())
    await h.receive(makeChannelMessage({ channel: CA }), undefined, () => {
      throw new Error(`ack refused ${LEAK_SENTINEL}`)
    })

    expect(lines(h, 'failed to ack event')).toHaveLength(1)
    expect(h.p('Alpha Bot').notifications).toHaveLength(1)
    assertNoLeak(captured(h))
  })

  test.each([
    ['a message that is delivered', (_p: string) => makeChannelMessage({ channel: CS, text: `${mentionText(_p)} hi` })],
    ['a message that is dropped (unmentioned in a `mentions` channel)', () => makeChannelMessage({ channel: CS })],
  ])('the archive is written for %s, with its name lookups on P\'s client', async (_label, build) => {
    const archive = buildTempArchiveDb([], CS)
    const db = openArchiveDatabase(archive.dbPath)
    try {
      const h = makeHarness(ac1Specs(), { archiveDb: db })
      const A = h.p('Alpha Bot')
      const event = build(A.stub.identity.botUserId)

      await h.receive(event, ['Alpha Bot'])
      await Promise.all(h.archiveWrites)

      expect(h.order.filter((m) => m.startsWith('archive:'))).toEqual([`archive:${A.persona.key}`])
      expect(db.query('SELECT channel_id, channel_name, sender_name FROM messages').all()).toEqual([
        { channel_id: CS, channel_name: `stub-${CS.toLowerCase()}`, sender_name: 'stub-user' },
      ])
      expect(A.stub.calls.conversationsInfo).toEqual([{ channel: CS }])
      expect(slackCalls(h.p('Beta Bot').stub)).toBe(0)
    } finally {
      db.close()
      archive.cleanup()
    }
  })

  test('the ack reaction of a delivered message is added on P\'s stub (the second persona) and on no other persona\'s', async () => {
    const h = makeHarness(ac1Specs(), { ackReaction: 'eyes' })
    const event = makeChannelMessage({ channel: CB })
    await h.receive(event)

    expect(h.p('Beta Bot').notifications).toHaveLength(1)
    expect(h.p('Beta Bot').stub.calls.reactionsAdd).toEqual([{ channel: CB, timestamp: event.ts as string, name: 'eyes' }])
    expect(h.p('Alpha Bot').stub.calls.reactionsAdd).toEqual([])
  })

  test('a throw in A\'s run is logged naming A, token-safely, and B still gets its delivery', async () => {
    const h = makeHarness(
      [
        { name: 'Alpha Bot', channels: [{ id: CS, delivery: 'all' }] },
        { name: 'Beta Bot', channels: [{ id: CS, delivery: 'all' }] },
      ],
      { throwOnNotify: ['Alpha Bot'] },
    )
    const A = h.p('Alpha Bot').persona
    await h.receive(makeChannelMessage({ channel: CS }))

    expect(lines(h, `error handling event for persona ${renderPersonaRef(A.name, A.key)}`)).toHaveLength(1)
    expect(h.p('Beta Bot').notifications).toHaveLength(1)
    expect(h.order.filter((m) => m === 'ack')).toHaveLength(1)
    assertNoLeak(captured(h))
  })

  test.each([
    ['a key no applied persona has', false],
    ['no applied config at all', true],
  ])('%s: nothing is delivered to it and the event is still acked', async (_label, noConfig) => {
    const h = makeHarness(ac1Specs())
    if (noConfig) h.config = null
    await h.receiveKeys(makeChannelMessage({ channel: CA }), ['ghost_key', h.p('Alpha Bot').persona.key])

    expect(lines(h, 'no applied persona with key=ghost_key')).toHaveLength(1)
    expect(h.order.filter((m) => m === 'ack')).toHaveLength(1)
    expect(h.p('Alpha Bot').notifications).toHaveLength(noConfig ? 0 : 1)
  })
})

// ---------------------------------------------------------------------------
// Lost message (b.kvq no session / b.9cj streamless), keyed to the persona.
// One smoke case here; the branches and guards are owned by
// tests/inbound-recovery-drop-branch.test.ts (no session) and
// tests/dispatch-get-stream.test.ts (streamless).
// ---------------------------------------------------------------------------

describe('lost message: reply and recovery keyed to the persona, through its client', () => {
  test('smoke: P (the second persona) has no session: one "started" reply to the source channel on P\'s stub, a restart of P in its working directory, nothing for the other persona', async () => {
    const h = makeHarness(
      [
        { name: 'Other Bot', channels: [{ id: CB, delivery: 'all' }] },
        { name: 'Lost Bot', channels: [{ id: CA, delivery: 'all' }] },
      ],
      { sessions: ['Other Bot'] },
    )
    const lost = h.p('Lost Bot')
    const other = h.p('Other Bot')

    await h.receive(makeChannelMessage({ channel: CA }))

    expect(h.allPosts()).toEqual([{ key: lost.persona.key, channel: CA, text: LOST_MESSAGE_STARTED_REPLY }])
    expect(other.notifications).toHaveLength(0)
    expect(isRestartPendingOrActive(other.persona.key)).toBe(false)
    await waitFor(() => h.launches.length > 0)
    expect(h.launches).toEqual([{ key: lost.persona.key, cwd: lost.persona.working_directory }])
    assertNoLeak(captured(h))
  })
})

// ---------------------------------------------------------------------------
// Dispatch acts on P's session as it is after the name lookup and ack
// reaction (b.9cj race, PM S1): the stream probe, the log line and the
// notification (or the drop) all use the session read after those awaits.
// ---------------------------------------------------------------------------

describe('dispatch uses P\'s session as registered after the awaited lookup', () => {
  /** Other Bot first, Race Bot (the receiving persona P) second; both `all` in their own channel. */
  const raceSpecs = (): PersonaSpec[] => [
    { name: 'Other Bot', channels: [{ id: CA, delivery: 'all' }] },
    { name: 'Race Bot', channels: [{ id: CB, delivery: 'all' }] },
  ]

  /** A harness whose name lookup for P runs `during` before it resolves. */
  function raceHarness(opts: { firstStreamless: boolean }, during: (h: Harness) => void): Harness {
    let hook: () => void = () => {}
    const h = makeHarness(raceSpecs(), {
      streamless: opts.firstStreamless ? ['Race Bot'] : [],
      restartDelayS: 9999,
      resolveUserName: async () => {
        hook()
        return 'a-human'
      },
    })
    hook = () => during(h)
    return h
  }

  test('a newer session with its stream registers during the lookup (the first was streamless): the notification goes to the new session only, with no DROP line and no reply', async () => {
    let fresh: ReturnType<Harness['registerFor']> | undefined
    const h = raceHarness({ firstStreamless: true }, (x) => { fresh = x.registerFor('Race Bot', { tag: 'new' }) })
    const P = h.p('Race Bot')
    const ref = renderPersonaRef(P.persona.name, P.persona.key)

    await h.receive(makeChannelMessage({ channel: CB }), ['Race Bot'])

    expect(fresh!.notifications.map((n) => n.params.meta.chat_id)).toEqual([CB])
    expect(P.notifications).toHaveLength(0)
    expect(h.p('Other Bot').notifications).toHaveLength(0)
    const dispatched = lines(h, `Dispatching to persona ${ref} chat_id=${CB}`)
    expect(dispatched).toHaveLength(1)
    expect(dispatched[0]).toContain(`cwd="${fresh!.cwd}" mcpSessionId=${fresh!.mcpSessionId} hasGetStream=true connected=true`)
    expect(lines(h, 'DROP:')).toEqual([])
    expect(h.allPosts()).toEqual([])
    expect(h.all.map((x) => isRestartPendingOrActive(x.persona.key))).toEqual([false, false])
    assertNoLeak(captured(h))
  })

  test('a newer streamless session registers during the lookup (the first had its stream): a DROP line names the new session, nothing is notified, and recovery restarts in the new session\'s cwd', async () => {
    let fresh: ReturnType<Harness['registerFor']> | undefined
    const h = raceHarness({ firstStreamless: false }, (x) => { fresh = x.registerFor('Race Bot', { tag: 'new', streamless: true }) })
    const P = h.p('Race Bot')
    const ref = renderPersonaRef(P.persona.name, P.persona.key)
    h.restartDelayS = 0.005

    await h.receive(makeChannelMessage({ channel: CB }), ['Race Bot'])

    const dropped = lines(h, `DROP: no _GET_stream for persona ${ref} chat_id=${CB}`)
    expect(dropped).toHaveLength(1)
    expect(dropped[0]).toContain(`cwd="${fresh!.cwd}" mcpSessionId=${fresh!.mcpSessionId}`)
    expect(lines(h, `Dispatching to persona ${ref}`)[0]).toContain(`mcpSessionId=${fresh!.mcpSessionId} hasGetStream=false connected=true`)
    expect(fresh!.notifications).toHaveLength(0)
    expect(P.notifications).toHaveLength(0)
    expect(h.allPosts()).toEqual([{ key: P.persona.key, channel: CB, text: LOST_MESSAGE_RESTARTING_REPLY }])
    await waitFor(() => h.launches.length > 0)
    expect(h.launches).toEqual([{ key: P.persona.key, cwd: fresh!.cwd }])
    expect(isRestartPendingOrActive(h.p('Other Bot').persona.key)).toBe(false)
    assertNoLeak(captured(h))
  })

  test('P\'s session goes away during the lookup: the no-session branch runs (no DROP line, no notification, "started" reply)', async () => {
    const h = raceHarness({ firstStreamless: false }, (x) => { unregisterSession(x.p('Race Bot').persona.key) })
    const P = h.p('Race Bot')
    const ref = renderPersonaRef(P.persona.name, P.persona.key)

    await h.receive(makeChannelMessage({ channel: CB }), ['Race Bot'])

    expect(lines(h, `No live session for persona ${ref} chat_id=${CB}`)).toHaveLength(1)
    expect(lines(h, 'DROP:')).toEqual([])
    expect(lines(h, 'Dispatching to persona')).toEqual([])
    expect(P.notifications).toHaveLength(0)
    expect(h.allPosts()).toEqual([{ key: P.persona.key, channel: CB, text: LOST_MESSAGE_STARTED_REPLY }])
    expect(isRestartPendingOrActive(P.persona.key)).toBe(true)
    expect(isRestartPendingOrActive(h.p('Other Bot').persona.key)).toBe(false)
    assertNoLeak(captured(h))
  })
})
