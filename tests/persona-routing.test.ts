/**
 * persona-routing.test.ts — Inbound channel delivery per persona (b.av2 SR-4.1
 * and SR-4.2, SR-10.1 gate removal, SR-10.3 `unclaimed-channel`).
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
 * Each persona has its own Slack connection (E3 Task 9), so a message in a
 * channel several personas are in reaches each of them on its own connection.
 * The tests feed an event to each receiving persona as its connection would:
 * one `receive` call per persona, with its key alone and its own ack
 * (`receiveOnEach`). Each persona has its own bot identity (the stub's
 * `auth.test` identity, distinct per persona). The last block drives the
 * routing over the real connection manager's per-persona identities, as the
 * server wires them (`makeManagedRouting`).
 *
 * Owns AC 1, AC 2 and 12 (persona-routing leg; the tool-level scope stays in
 * registry.test.ts), AC 52, and the SR-14 shared-channel contract end to end
 * (AC 6, 7, 8, 9, 10, 11, 16 and 18). The delivery rules themselves (SR-4.2)
 * live in src/delivery-decision.ts and are covered exhaustively by
 * tests/delivery-decision.test.ts; this file proves the pipeline is wired to
 * them (subtypes, bot and webhook authors, bot-ID self-exclusion, broadcasts),
 * pins the E3 behaviour the rules keep, and covers the per-persona dedupe and
 * the one archive row (SR-4.1) and the author and `via` meta (SR-4.4). Every
 * harness has fresh dedupe stores reading this test's fake clock. E6 replaces
 * the interim DM drop.
 *
 * SPDX-License-Identifier: MIT
 */

import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { LOST_MESSAGE_RESTARTING_REPLY, LOST_MESSAGE_STARTED_REPLY } from '../src/persona-routing.ts'
import { INBOUND_DEDUPE_RETENTION_MS } from '../src/inbound-dedupe.ts'
import type { Via } from '../src/delivery-decision.ts'
import { renderPersonaRef } from '../src/persona-identity.ts'
import { checkPersonaTarget, unregisterSession } from '../src/registry.ts'
import { initRestart, isRestartPendingOrActive } from '../src/restart.ts'
import { openArchiveDatabase } from '../src/message-archive.ts'
import { dryRunPersonaIdentity } from '../src/persona-connections.ts'
import type { Persona } from '../src/config.ts'
import type { PersonaSpec } from './test-helpers/persona-config.ts'
import {
  broadcastText,
  makeAppMention,
  makeBotMessage,
  makeChannelMessage,
  makeDm,
  makeWebhookPost,
  mentionText,
  userGroupMentionText,
  type SlackEvent,
} from './test-helpers/slack-stub.ts'
import { posts, slackCalls } from './test-helpers/permission-relay-harness.ts'
import { buildTempArchiveDb } from './test-helpers/archive-db.ts'
import { LEAK_SENTINEL, assertNoLeak } from './test-helpers/credentials.ts'
import {
  NEVER_FIRE_RESTART_DELAY_S,
  makeRestartDeps,
  makeRoutingHarness,
  resetRoutingState,
  waitFor,
  type RoutingHarness,
  type RoutingHarnessOptions,
} from './test-helpers/persona-routing-harness.ts'
import { makeConnectionHarness } from './test-helpers/persona-connection-harness.ts'
import { makeManagedRouting } from './test-helpers/persona-routing-managed.ts'
import { createFakeClock, type FakeClock } from './test-helpers/fake-clock.ts'

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
/** This test's dedupe clock; each harness gets fresh per-persona dedupe stores reading it. */
let clock: FakeClock

function makeHarness(specs: PersonaSpec[], opts: RoutingHarnessOptions = {}): Harness {
  return makeRoutingHarness(specs, dir, { dedupeClock: () => clock.now(), ...opts })
}

/** Everything a case captured, for `assertNoLeak`. */
function captured(h: Harness): Record<string, unknown> {
  return { ...h.captured(), console: consoleLines }
}

const lines = (h: Harness, needle: string) => h.logs.filter((l) => l.includes(needle))

/** Every captured line (module log seam and console) that contains `text`. */
const linesWithText = (h: Harness, text: string) => [...h.logs, ...consoleLines].filter((l) => l.includes(text))

/**
 * Feed `event` to each named persona (default: all), one `receive` per
 * persona with its own ack, as each persona's own connection delivers it.
 */
async function receiveOnEach(h: Harness, event: unknown, names: readonly string[] = h.all.map((x) => x.persona.name)): Promise<void> {
  for (const name of names) await h.receive(event, [name])
}

/** A has `all` in CA and `mentions` in CS; B has `all` in CB and `mentions` in CS (the AC 1 setup). */
function ac1Specs(): PersonaSpec[] {
  return [
    { name: 'Alpha Bot', channels: [{ id: CA, delivery: 'all' }, { id: CS, delivery: 'mentions' }] },
    { name: 'Beta Bot', channels: [{ id: CB, delivery: 'all' }, { id: CS, delivery: 'mentions' }] },
  ]
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'persona-routing-'))
  clock = createFakeClock()
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

    await receiveOnEach(h, home)
    await receiveOnEach(h, mention)

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
    await receiveOnEach(h, makeChannelMessage({ channel: CB }))

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
    await receiveOnEach(h, makeChannelMessage({ channel: CB }))

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
      await receiveOnEach(h, makeChannelMessage({ channel, text: `${mention} message for ${channel}` }))
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
// Delivery rules (b.av2 SR-4.2), against the receiving persona P, through the
// pipeline. Each row proves the pipeline is wired to src/delivery-decision.ts;
// the exhaustive matrix is tests/delivery-decision.test.ts.
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
  /** P's and Q's bot user IDs, and P's bot ID. */
  type Ids = { p: string; q: string; pBot: string }

  // One row per wiring case; the SR-14 shared-channel matrix and dedupe have their own blocks below.
  // The optional fourth element is a fragment P's one logged drop line must contain. It is read
  // through a rest parameter: a fourth named parameter would make Bun pass a `done` callback to
  // the three-element rows.
  test.each<[string, (ids: Ids) => SlackEvent, boolean, string?]>([
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
    ['SR-4.2 step 2: a post carrying P\'s own bot ID and no user is dropped as P\'s own', (ids) => makeWebhookPost({ channel: PALL, bot_id: ids.pBot }), false],
    ['SR-4.2 step 2: another app\'s bot message (its own user and bot ID, no subtype) in an `all` channel is delivered (self-exclusion is the only author filter)', () => makeBotMessage({ channel: PALL }), true],
    ['SR-4.2 steps 1-2: a webhook post (subtype bot_message, bot_id, no user) in an `all` channel is delivered', () => makeWebhookPost({ channel: PALL }), true],
    ['a channel P is not configured into (another persona\'s) is not delivered', () => makeChannelMessage({ channel: QALL }), false],
    ['a channel no persona lists is not delivered', () => makeChannelMessage({ channel: CX }), false],
    ['subtype message_changed (an edit) is dropped', () => makeChannelMessage({ channel: PALL, subtype: 'message_changed' }), false],
    ['subtype message_deleted (a deletion) is dropped', () => makeChannelMessage({ channel: PALL, subtype: 'message_deleted' }), false],
    ['subtype channel_join is dropped', () => makeChannelMessage({ channel: PALL, subtype: 'channel_join' }), false],
    ['subtype file_share is delivered', () => makeChannelMessage({ channel: PALL, subtype: 'file_share', files: [{ name: 'a.txt' }] }), true],
    [
      'SR-4.2 step 2: a message with neither user nor bot_id is dropped (no author to self-exclude against), logged as user=(none)',
      () => makeChannelMessage({ channel: PALL, user: undefined }),
      false,
      `channel=${PALL} user=(none): no-author`,
    ],
    ['SR-4.2 step 5: `mentions` channel: <!here> is delivered to the mention-only persona', () => makeChannelMessage({ channel: PMENT, text: `${broadcastText('here')} standup` }), true],
    ['SR-4.2 step 5: `mentions` channel: <!everyone> is not a mention and is dropped', () => makeChannelMessage({ channel: PMENT, text: `${broadcastText('everyone')} standup` }), false],
    ['SR-4.2 step 5: `mentions` channel: a user-group mention is not a mention and is dropped', () => makeChannelMessage({ channel: PMENT, text: `${userGroupMentionText(undefined, '@team')} standup` }), false],
  ])('%s', async (_label, build, delivered, ...[dropLine]) => {
    const h = makeHarness(specs())
    const P = h.p('Pilot')
    const event = build({ p: P.stub.identity.botUserId, q: h.p('Quill').stub.identity.botUserId, pBot: P.stub.identity.botId })

    await h.receive(event, ['Pilot'])

    expect(P.notifications).toHaveLength(delivered ? 1 : 0)
    if (delivered) expect(P.notifications[0]!.params.meta.chat_id).toBe(event.channel as string)
    if (dropLine !== undefined) {
      const dropped = lines(h, `persona ${renderPersonaRef(P.persona.name, P.persona.key)} dropped message`)
      expect(dropped).toHaveLength(1)
      expect(dropped[0]).toContain(dropLine)
    }
    // A decision never replies or restarts on its own.
    expect(posts(P.stub)).toEqual([])
    expect(isRestartPendingOrActive(P.persona.key)).toBe(false)
  })

  test('SR-4.4: a threaded file post keeps today\'s meta and text alongside the author\'s user_id and via, with the user name looked up on P\'s client', async () => {
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

    await receiveOnEach(h, event)

    expect(P.notifications).toHaveLength(1)
    const { method, params } = P.notifications[0]!
    expect(method).toBe('notifications/claude/channel')
    expect(params.content).toBe('please review')
    expect(params.meta).toEqual({
      chat_id: PMENT,
      message_id: event.ts as string,
      user: 'stub-user',
      user_id: event.user as string,
      ts: event.ts as string,
      via: 'mention',
      thread_ts: '1700000000.000001',
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
  })

  test.each<[string, Record<string, unknown>, string]>([
    ['its username', {}, 'stub-webhook'],
    ['its bot_profile name when it has no username', { username: undefined, bot_profile: { id: 'B0STUBHOOK', name: 'stub-integration' } }, 'stub-integration'],
    ['its bot ID when it carries no name', { username: undefined }, 'B0STUBHOOK'],
  ])('SR-4.2 step 2: a webhook post (no user) is delivered with no users.info call and no error, labelled with %s', async (_label, overrides, label) => {
    const h = makeHarness(specs())
    const P = h.p('Pilot')

    await h.receive(makeWebhookPost({ channel: PALL, ...overrides }), ['Pilot'])

    expect(P.notifications.map((n) => ({ chat_id: n.params.meta.chat_id, user: n.params.meta.user, content: n.params.content }))).toEqual([
      { chat_id: PALL, user: label, content: 'hello from a webhook' },
    ])
    expect(P.stub.calls.usersInfo).toEqual([])
    expect([...h.logs, ...consoleLines].filter((l) => /error|fail/i.test(l))).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Another persona's post (b.av2 SR-4.2 step 2): self-exclusion is per
// receiving persona, by its bot user ID or its bot ID, so B's post reaches A
// on A's connection and is dropped as B's own on B's.
// ---------------------------------------------------------------------------

describe('SR-4.2 step 2: a post by persona B reaches A and is B\'s own on B\'s connection', () => {
  test.each<[string, (id: { botUserId: string; botId: string }) => SlackEvent, (id: { botUserId: string; botId: string }) => string]>([
    ['B\'s bot user and bot ID', (id) => makeBotMessage({ channel: CS, user: id.botUserId, bot_id: id.botId, text: 'reply from beta' }), (id) => `user=${id.botUserId}`],
    ['B\'s bot ID only (no user)', (id) => makeWebhookPost({ channel: CS, bot_id: id.botId, text: 'reply from beta' }), (id) => `bot_id=${id.botId}`],
  ])('posted with %s in a channel where both have `delivery: all`: delivered to A, dropped as own for B, and B\'s drop line names the author ID', async (_label, build, author) => {
    const h = makeHarness([
      { name: 'Alpha Bot', channels: [{ id: CS, delivery: 'all' }] },
      { name: 'Beta Bot', channels: [{ id: CS, delivery: 'all' }] },
    ])
    const A = h.p('Alpha Bot')
    const B = h.p('Beta Bot')
    const event = build(B.stub.identity)

    await h.receive(event, ['Alpha Bot'])
    await h.receive(event, ['Beta Bot'])

    expect(A.notifications.map((n) => ({ chat_id: n.params.meta.chat_id, content: n.params.content }))).toEqual([
      { chat_id: CS, content: 'reply from beta' },
    ])
    expect(B.notifications).toHaveLength(0)
    const ref = renderPersonaRef(B.persona.name, B.persona.key)
    const dropped = lines(h, `persona ${ref} dropped message`)
    expect(dropped).toHaveLength(1)
    expect(dropped[0]).toContain(`channel=${CS} ${author(B.stub.identity)}: own`)
    expect(lines(h, `persona ${renderPersonaRef(A.persona.name, A.persona.key)} dropped message`)).toEqual([])
    assertNoLeak(captured(h))
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
    await receiveOnEach(h, makeChannelMessage({ channel: CX, text: `${marker} quarterly numbers` }))

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
    await h.receive(makeChannelMessage({ channel: CA }), ['Alpha Bot'])

    expect(h.order.filter((m) => m === 'ack')).toHaveLength(1)
    expect(h.order[0]).toBe('ack')
    expect(h.order).toContain(`archive:${h.p('Alpha Bot').persona.key}`)
    expect(h.p('Alpha Bot').notifications).toHaveLength(1)
  })

  test('the ack happens even when a later step never settles', async () => {
    const h = makeHarness(ac1Specs(), { resolveUserName: () => new Promise<string>(() => {}) })
    void h.receive(makeChannelMessage({ channel: CA }), ['Alpha Bot'])
    await new Promise((r) => setTimeout(r, 5))

    expect(h.order.filter((m) => m === 'ack')).toHaveLength(1)
    expect(h.order[0]).toBe('ack')
    expect(h.p('Alpha Bot').notifications).toHaveLength(0)
  })

  test('a failed ack is logged token-safely and delivery still happens', async () => {
    const h = makeHarness(ac1Specs())
    await h.receive(makeChannelMessage({ channel: CA }), ['Alpha Bot'], () => {
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
    await receiveOnEach(h, event)

    expect(h.p('Beta Bot').notifications).toHaveLength(1)
    expect(h.p('Beta Bot').stub.calls.reactionsAdd).toEqual([{ channel: CB, timestamp: event.ts as string, name: 'eyes' }])
    expect(h.p('Alpha Bot').stub.calls.reactionsAdd).toEqual([])
  })

  test('a throw in A\'s run is logged naming A, token-safely, and B, receiving the same message on its own connection, still gets its delivery', async () => {
    const h = makeHarness(
      [
        { name: 'Alpha Bot', channels: [{ id: CS, delivery: 'all' }] },
        { name: 'Beta Bot', channels: [{ id: CS, delivery: 'all' }] },
      ],
      { throwOnNotify: ['Alpha Bot'] },
    )
    const A = h.p('Alpha Bot').persona
    await receiveOnEach(h, makeChannelMessage({ channel: CS }))

    expect(lines(h, `error handling event for persona ${renderPersonaRef(A.name, A.key)}`)).toHaveLength(1)
    expect(h.p('Beta Bot').notifications).toHaveLength(1)
    // One ack per receiving connection.
    expect(h.order.filter((m) => m === 'ack')).toHaveLength(2)
    assertNoLeak(captured(h))
  })

  test.each([
    ['a key no applied persona has', false],
    ['no applied config at all', true],
  ])('%s: nothing is delivered to it and the event is still acked', async (_label, noConfig) => {
    const h = makeHarness(ac1Specs())
    if (noConfig) h.config = null
    const event = makeChannelMessage({ channel: CA })
    await h.receiveKeys(event, ['ghost_key'])

    expect(lines(h, 'no applied persona with key=ghost_key')).toHaveLength(1)
    expect(h.order.filter((m) => m === 'ack')).toHaveLength(1)

    await h.receiveKeys(event, [h.p('Alpha Bot').persona.key])
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

    await receiveOnEach(h, makeChannelMessage({ channel: CA }))

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

// ---------------------------------------------------------------------------
// Per-persona identities over the real connection manager (E3 Task 9; b.av2
// SR-3.1, SR-3.4, SR-4.2 step 2). The routing is built as the server builds
// it (`makeManagedRouting`): `getBotIdentity` from the manager-backed identity
// getter and `clientFor` from the manager-backed client lookup. Each receive
// names one persona by its key, as that persona's connection does. The
// per-persona archive source is covered end to end in
// tests/persona-connection-wiring.test.ts.
// ---------------------------------------------------------------------------

describe('per-persona identities (connection manager)', () => {
  /** A and B both `all` in the shared channel CS. */
  const sharedSpecs = (): PersonaSpec[] => [
    { name: 'Alpha Bot', channels: [{ id: CS, delivery: 'all' }] },
    { name: 'Beta Bot', channels: [{ id: CS, delivery: 'all' }] },
  ]

  test.each([
    ['live', false],
    ['dry run (placeholder identities)', true],
  ])('SR-4.2 step 2 (%s): a post by A\'s bot user, and one carrying only A\'s bot ID, are dropped as A\'s own on A\'s connection and delivered to B on B\'s; B\'s own posts the other way round', async (_label, dryRun) => {
    const h = makeConnectionHarness(sharedSpecs(), dir, { dryRun })
    try {
      for (const p of h.personas) expect(await h.bringUp(p)).toMatchObject({ state: 'up' })
      initRestart(makeRestartDeps({ restartDelayS: NEVER_FIRE_RESTART_DELAY_S }))
      const m = makeManagedRouting(h, dir)
      const [A, B] = h.personas as [Persona, Persona]
      const idA = h.identityFor(A.key)!
      const idB = h.identityFor(B.key)!
      expect(idA.botUserId).not.toBe(idB.botUserId)
      expect(idA.botId).not.toBe(idB.botId)
      // Dry run: the placeholder identity (`U000DRY_<key>`, `B000DRY_<key>`) is the one self-exclusion uses.
      if (dryRun) expect(idA).toEqual(dryRunPersonaIdentity(A.key))
      else expect(idA).toEqual({ botUserId: h.stub(A).identity.botUserId, botId: h.stub(A).identity.botId })
      const ack = async () => {}

      for (const [id, name, own, other] of [[idA, 'alpha', A, B], [idB, 'beta', B, A]] as const) {
        const byUser = makeChannelMessage({ channel: CS, user: id.botUserId, text: `posted by ${name}` })
        const byBotId = makeWebhookPost({ channel: CS, bot_id: id.botId, text: `hooked by ${name}` })
        for (const event of [byUser, byBotId]) {
          await m.routing.receive(event, ack, own.key)
          await m.routing.receive(event, ack, other.key)
        }
      }

      expect(m.notifications.get(A.key)!.map((n) => n.params.content)).toEqual(['posted by beta', 'hooked by beta'])
      expect(m.notifications.get(B.key)!.map((n) => n.params.content)).toEqual(['posted by alpha', 'hooked by alpha'])
      for (const p of [A, B]) {
        const own = m.logs.filter((l) => l.includes(`persona ${renderPersonaRef(p.name, p.key)} dropped message`) && l.endsWith(': own'))
        expect(own).toHaveLength(2)
      }
      assertNoLeak({ logs: m.logs, lines: h.lines })
    } finally {
      await h.manager.stopAll()
    }
  })
})

// ---------------------------------------------------------------------------
// SR-14 shared-channel matrix (b.av2 SR-13.5; AC 6-11, 16, 18), dedupe, the
// one-archive-row rule (SR-4.1) and the delivered meta (SR-4.4).
//
// Real Slack fans one channel message out to every persona app in the channel
// and also sends an `app_mention` to each persona the text mentions directly,
// so `fanOut` feeds the `message` on the connection of every persona that
// lists the channel, then its `app_mention` twin on each directly mentioned
// persona's connection. Delivery counts then prove dedupe and self-exclusion
// together.
// ---------------------------------------------------------------------------

/** A's home channel (A `all`). */
const MX_HOME = 'C0MXHOME1'
/** Coordination channel: A, B and C all `mentions`. */
const MX_COORD = 'C0MXCOORD'
/** Shared channel: D and E both `all`. */
const MX_SHARED = 'C0MXSHARE'

const MX_NAMES = ['A', 'B', 'C', 'D', 'E'] as const
type MxName = typeof MX_NAMES[number]

/** The matrix fixture: A `all` at home and `mentions` in coordination; B, C `mentions` in coordination; D, E `all` in the shared channel. */
function matrixSpecs(): PersonaSpec[] {
  return [
    { name: 'A', channels: [{ id: MX_HOME, delivery: 'all' }, { id: MX_COORD, delivery: 'mentions' }] },
    { name: 'B', channels: [{ id: MX_COORD, delivery: 'mentions' }] },
    { name: 'C', channels: [{ id: MX_COORD, delivery: 'mentions' }] },
    { name: 'D', channels: [{ id: MX_SHARED, delivery: 'all' }] },
    { name: 'E', channels: [{ id: MX_SHARED, delivery: 'all' }] },
  ]
}

/** The `app_mention` Slack sends alongside `event` to a persona it mentions: same channel, ts, text and author. */
function appMentionTwin(event: SlackEvent): SlackEvent {
  return makeAppMention({ channel: event.channel, ts: event.ts, text: event.text, user: event.user, bot_id: event.bot_id })
}

/**
 * Feed `event` as Slack fans it out: the `message` on each connection in
 * `connections` (default: every persona that lists the channel), then the
 * `app_mention` twin on each of those whose bot user the text mentions.
 */
async function fanOut(h: Harness, event: SlackEvent, connections?: readonly string[]): Promise<void> {
  const names = connections ?? h.all.filter((x) => x.persona.channels.some((c) => c.id === event.channel)).map((x) => x.persona.name)
  await receiveOnEach(h, event, names)
  const text = String(event.text ?? '')
  const mentioned = names.filter((n) => text.includes(`<@${h.p(n).stub.identity.botUserId}`))
  await receiveOnEach(h, appMentionTwin(event), mentioned)
}

/** A post by persona `name`: its bot user and bot ID, as Slack delivers a persona's `chat.postMessage`. */
function personaPost(h: Harness, name: string, overrides: Record<string, unknown>): SlackEvent {
  const { botUserId, botId } = h.p(name).stub.identity
  return makeBotMessage({ user: botUserId, bot_id: botId, ...overrides })
}

/** Each persona's deliveries as `{ chat_id, via }`, for one exact comparison per case. */
function deliveries(h: Harness, names: readonly string[] = MX_NAMES): Record<string, Array<{ chat_id: string; via: string }>> {
  return Object.fromEntries(names.map((n) => [n, h.p(n).notifications.map((x) => ({ chat_id: x.params.meta.chat_id!, via: x.params.meta.via! }))]))
}

describe('SR-14 shared-channel matrix (AC 6, 7, 8, 9, 10, 11, 16)', () => {
  type Author = 'person' | 'other-app bot' | 'webhook' | MxName
  interface MatrixCase {
    ac: string
    name: string
    channel: string
    author: Author
    /** Message text, given each persona's bot user mention. */
    text: (m: Record<MxName, string>) => string
    /** Each persona that gets the message, with its `via`; the rest get nothing. */
    expected: Partial<Record<MxName, Via>>
    /** Connections the message arrives on; default every persona that lists the channel. */
    feed?: MxName[]
  }
  /** A matrix row plus its per-persona title fields (`1 <via>` or `0`). */
  const row = (c: MatrixCase) => ({
    ...c,
    ...Object.fromEntries(MX_NAMES.map((n) => [n, c.expected[n] ? `1 ${c.expected[n]}` : '0'])) as Record<MxName, string>,
  })

  test.each([
    row({ ac: 'AC 6 / AC 16', name: 'plain post in A\'s home (sole receive-all)', channel: MX_HOME, author: 'person', text: () => 'status update', expected: { A: 'receive_all' } }),
    row({ ac: 'AC 6', name: 'plain post in coordination', channel: MX_COORD, author: 'person', text: () => 'status update', expected: {} }),
    row({ ac: 'AC 6', name: 'mention of A in coordination', channel: MX_COORD, author: 'person', text: (m) => `${m.A} can you look?`, expected: { A: 'mention' } }),
    row({ ac: 'AC 7', name: '<!here> in coordination', channel: MX_COORD, author: 'person', text: () => `${broadcastText('here')} standup`, expected: { A: 'broadcast', B: 'broadcast', C: 'broadcast' } }),
    row({ ac: 'AC 7', name: '<!channel> in coordination', channel: MX_COORD, author: 'person', text: () => `${broadcastText('channel')} standup`, expected: { A: 'broadcast', B: 'broadcast', C: 'broadcast' } }),
    row({ ac: 'AC 7', name: 'labelled <!here|here> in coordination', channel: MX_COORD, author: 'person', text: () => `${broadcastText('here', 'here')} standup`, expected: { A: 'broadcast', B: 'broadcast', C: 'broadcast' } }),
    row({ ac: 'AC 8', name: 'A\'s own <!channel> post', channel: MX_COORD, author: 'A', text: () => `${broadcastText('channel')} build is green`, expected: { B: 'broadcast', C: 'broadcast' } }),
    row({ ac: 'AC 9', name: 'broadcast+mention', channel: MX_COORD, author: 'person', text: (m) => `${broadcastText('here')} ${m.A} please lead`, expected: { A: 'mention', B: 'broadcast', C: 'broadcast' } }),
    row({ ac: 'AC 10', name: 'mention of A in its receive-all home', channel: MX_HOME, author: 'person', text: (m) => `${m.A} ping`, expected: { A: 'mention' } }),
    row({ ac: 'AC 11', name: 'other app\'s bot mentions B', channel: MX_COORD, author: 'other-app bot', text: (m) => `${m.B} build failed`, expected: { B: 'mention' } }),
    row({ ac: 'AC 11', name: 'webhook (no user) mentions B', channel: MX_COORD, author: 'webhook', text: (m) => `${m.B} deploy done`, expected: { B: 'mention' } }),
    row({ ac: 'AC 11', name: 'persona A mentions B', channel: MX_COORD, author: 'A', text: (m) => `${m.B} over to you`, expected: { B: 'mention' } }),
    row({ ac: 'AC 16', name: 'plain post in the shared channel', channel: MX_SHARED, author: 'person', text: () => 'status update', expected: { D: 'receive_all_shared', E: 'receive_all_shared' } }),
    row({ ac: 'AC 16', name: 'plain post in the shared channel, E down (D\'s connection only)', channel: MX_SHARED, author: 'person', text: () => 'status update', expected: { D: 'receive_all_shared' }, feed: ['D'] }),
  ])('$ac $name: A=$A, B=$B, C=$C, D=$D, E=$E', async (c) => {
    const h = makeHarness(matrixSpecs())
    const mentions = Object.fromEntries(MX_NAMES.map((n) => [n, mentionText(h.p(n).stub.identity.botUserId)])) as Record<MxName, string>
    const base = { channel: c.channel, text: c.text(mentions) }
    const event = c.author === 'person' ? makeChannelMessage(base)
      : c.author === 'other-app bot' ? makeBotMessage(base)
        : c.author === 'webhook' ? makeWebhookPost(base)
          : personaPost(h, c.author, base)

    await fanOut(h, event, c.feed)

    expect(deliveries(h)).toEqual(Object.fromEntries(MX_NAMES.map((n) => {
      const via = c.expected[n]
      return [n, via ? [{ chat_id: c.channel, via }] : []]
    })))
    // A delivery never replies or restarts; a drop never does either.
    expect(h.allPosts()).toEqual([])
    expect(h.launches).toEqual([])
    assertNoLeak(captured(h))
  })

  test('AC 18: 20 alternating persona mentions in coordination (A mentions B, B mentions A, ...), with no clock advance, each reach the addressee once with via=mention; 20 deliveries in all, no limit or counter', async () => {
    const h = makeHarness(matrixSpecs())
    const sent: Record<MxName, string[]> = { A: [], B: [], C: [], D: [], E: [] }

    for (let i = 0; i < 20; i++) {
      const [author, addressee] = i % 2 === 0 ? (['A', 'B'] as const) : (['B', 'A'] as const)
      const ts = `1700000500.${String(i + 1).padStart(6, '0')}`
      await fanOut(h, personaPost(h, author, { channel: MX_COORD, ts, text: `${mentionText(h.p(addressee).stub.identity.botUserId)} turn ${i + 1}` }))
      sent[addressee].push(ts)
    }

    for (const n of MX_NAMES) {
      const got = h.p(n).notifications.map((x) => x.params.meta)
      expect(got.map((m) => ({ message_id: m.message_id, chat_id: m.chat_id, via: m.via })))
        .toEqual(sent[n].map((ts) => ({ message_id: ts, chat_id: MX_COORD, via: 'mention' })))
    }
    expect(h.all.reduce((sum, x) => sum + x.notifications.length, 0)).toBe(20)
  })
})

describe('SR-4.1 per-persona dedupe through the pipeline', () => {
  /** A mention of A in coordination, as a `message` and as its `app_mention` twin. */
  function mentionPair(h: Harness): { message: SlackEvent; appMention: SlackEvent } {
    const message = makeChannelMessage({ channel: MX_COORD, text: `${mentionText(h.p('A').stub.identity.botUserId)} hi` })
    return { message, appMention: appMentionTwin(message) }
  }

  test.each<[string, (p: { message: SlackEvent; appMention: SlackEvent }) => SlackEvent[]]>([
    ['`message` then `app_mention`', (p) => [p.message, p.appMention]],
    ['`app_mention` then `message`', (p) => [p.appMention, p.message]],
    ['the same `message` redelivered', (p) => [p.message, p.message]],
  ])('%s on A\'s one connection: one notification, one ack reaction, one dispatch', async (_label, order) => {
    const h = makeHarness(matrixSpecs(), { ackReaction: 'eyes' })
    const A = h.p('A')
    const pair = mentionPair(h)

    for (const event of order(pair)) await h.receive(event, ['A'])

    expect(A.notifications.map((n) => n.params.meta.via)).toEqual(['mention'])
    expect(A.stub.calls.reactionsAdd).toEqual([{ channel: MX_COORD, timestamp: pair.message.ts as string, name: 'eyes' }])
    expect(lines(h, 'Dispatching to persona')).toHaveLength(1)
    // Both events were acked.
    expect(h.order.filter((m) => m === 'ack')).toHaveLength(2)
  })

  test('dedupe is per persona key: one (channel, ts) fed to D and E gets one notification each, and later redeliveries on each key (as after a connection reopen, which reaches the routing only as the key) are still collapsed', async () => {
    const h = makeHarness(matrixSpecs())
    const event = makeChannelMessage({ channel: MX_SHARED })

    await h.receive(event, ['D', 'E'])
    await h.receive(event, ['E'])
    await h.receive(event, ['D'])
    await h.receiveKeys(event, h.keys(['D', 'E']))

    expect(deliveries(h, ['D', 'E'])).toEqual({
      D: [{ chat_id: MX_SHARED, via: 'receive_all_shared' }],
      E: [{ chat_id: MX_SHARED, via: 'receive_all_shared' }],
    })
  })

  test.each([
    ['just inside the retention window: still collapsed', INBOUND_DEDUPE_RETENTION_MS - 1, 1],
    ['at the end of the retention window: processed again', INBOUND_DEDUPE_RETENTION_MS, 2],
  ])('a redelivery %s (injected clock)', async (_label, advanceMs, expected) => {
    const h = makeHarness(matrixSpecs())
    const event = makeChannelMessage({ channel: MX_HOME })

    await h.receive(event, ['A'])
    await clock.advance(advanceMs)
    await h.receive(event, ['A'])

    expect(h.p('A').notifications.map((n) => n.params.meta.message_id)).toEqual(Array(expected).fill(event.ts))
  })

  test('dedupe state belongs to the routing instance: a second createPersonaRouting delivers the same event again', async () => {
    const event = makeChannelMessage({ channel: MX_HOME })
    const first = makeHarness(matrixSpecs())
    await first.receive(event, ['A'])
    resetRoutingState()
    const second = makeHarness(matrixSpecs())
    await second.receive(event, ['A'])

    expect(first.p('A').notifications).toHaveLength(1)
    expect(second.p('A').notifications).toHaveLength(1)
  })
})

describe('SR-4.1 one archive row per (channel, ts)', () => {
  let archive: ReturnType<typeof buildTempArchiveDb>
  let db: ReturnType<typeof openArchiveDatabase>

  beforeEach(() => {
    archive = buildTempArchiveDb([], MX_SHARED)
    db = openArchiveDatabase(archive.dbPath)
  })

  afterEach(() => {
    db.close()
    archive.cleanup()
  })

  // The write count shows every receipt reached the archive seam: D and E; A, B and C plus A's `app_mention`.
  test.each<[string, (h: Harness) => SlackEvent, number]>([
    ['a message received by D and E', () => makeChannelMessage({ channel: MX_SHARED }), 2],
    ['a mention of A received as `message` and `app_mention`', (h) => makeChannelMessage({ channel: MX_COORD, text: `${mentionText(h.p('A').stub.identity.botUserId)} hi` }), 4],
  ])('%s leaves exactly one archive row', async (_label, build, writes) => {
    const h = makeHarness(matrixSpecs(), { archiveDb: db })
    const event = build(h)

    await fanOut(h, event)
    await Promise.all(h.archiveWrites)

    expect(h.archiveWrites).toHaveLength(writes)
    expect(db.query('SELECT channel_id FROM messages').all()).toEqual([{ channel_id: event.channel as string }])
  })
})

describe('SR-4.4 delivered meta: author ID and via', () => {
  test.each<[string, (h: Harness) => SlackEvent, (ev: SlackEvent) => Record<string, string>]>([
    ['a person\'s post carries user_id (the author) and no bot_id', () => makeChannelMessage({ channel: MX_SHARED }), (ev) => ({ user: 'stub-user', user_id: ev.user as string })],
    ['a webhook post (no user) carries bot_id and no user_id', () => makeWebhookPost({ channel: MX_SHARED }), (ev) => ({ user: 'stub-webhook', bot_id: ev.bot_id as string })],
    ['a bot_message with a bot profile and no user carries bot_id and no user_id', () => makeBotMessage({ channel: MX_SHARED, subtype: 'bot_message', user: undefined }), (ev) => ({ user: 'stub-bot', bot_id: ev.bot_id as string })],
    ['another persona\'s post (bot user and bot ID) carries that persona\'s bot user as user_id and no bot_id', (h) => personaPost(h, 'E', { channel: MX_SHARED }), (ev) => ({ user: 'stub-user', user_id: ev.user as string })],
  ])('%s', async (_label, build, author) => {
    const h = makeHarness(matrixSpecs())
    const event = build(h)

    await h.receive(event, ['D'])

    expect(h.p('D').notifications.map((n) => n.params.meta)).toEqual([{
      chat_id: MX_SHARED,
      message_id: event.ts as string,
      ...author(event),
      ts: event.ts as string,
      via: 'receive_all_shared',
    }])
  })

  test('P\'s own mention token (plain and labelled) is stripped from the content; another persona\'s mention and a broadcast stay', async () => {
    const h = makeHarness(matrixSpecs())
    const a = h.p('A').stub.identity.botUserId
    const b = h.p('B').stub.identity.botUserId
    const text = `${mentionText(a)} ${mentionText(b, 'beta')} ${broadcastText('here')} sync up ${mentionText(a, 'alpha')} now`

    await fanOut(h, makeChannelMessage({ channel: MX_COORD, text }))

    const content = (n: MxName) => h.p(n).notifications.map((x) => ({ via: x.params.meta.via, content: x.params.content }))
    expect(content('A')).toEqual([{ via: 'mention', content: `${mentionText(b, 'beta')} ${broadcastText('here')} sync up now` }])
    expect(content('B')).toEqual([{ via: 'mention', content: `${mentionText(a)} ${broadcastText('here')} sync up ${mentionText(a, 'alpha')} now` }])
    expect(content('C')).toEqual([{ via: 'broadcast', content: text }])
  })
})
