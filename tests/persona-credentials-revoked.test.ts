/**
 * persona-credentials-revoked.test.ts — A bot token revoked while a persona
 * runs, end to end, and its recovery (bug b.ujn; b.av2 SR-6.4, SR-8.6 step 6).
 *
 * Personas alpha (A) and bravo (B) run from a byte-equal record and
 * configuration file through `makeReloadHarness` with the real lifecycle
 * composition (`opts.realLifecycle`), stub Slack, the fake clock and a
 * registered MCP session each. A real consumer makes a Web API call for A
 * that the stub answers `token_revoked` (sentinel-bearing), mostly an MCP
 * tool call through `run.callTool`, once a notice through `run.notice`.
 * Then A is credentials-broken at once (one `persona-credentials-refused`
 * line naming A, its `personas[i]` entry and its credentials path), its MCP
 * session is dropped, its instance is kept (no agent-director call), nothing
 * more reaches it or is posted for it, and B keeps serving. A recovers only
 * through the confirmed credentials change: a working file at its path, the
 * pending change confirmed, and apply step 6's recovery bring-up.
 *
 * With `opts.realLifecycle` the reload harness hands its connection manager
 * the composition's serializer, as `server.ts` does; no reload case holds
 * A's turn when the mark lands, so the socket it detaches is closed as soon
 * as that close runs. The window in which that socket is still open because
 * a lifecycle operation holds A's turn is covered by the last describe
 * block, over `makeConnectionHarness` with the serializer wired as
 * `server.ts` wires it, the real event router and the real routing.
 *
 * Every case passes everything it captured (`run.captured()`: logs, Slack
 * calls, lifecycle records and every file the server wrote that still
 * exists, so neither `config.json` nor a credentials file) to
 * `assertNoLeak`.
 *
 * SPDX-License-Identifier: MIT
 */

import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { Persona, PersonaInput } from '../src/config.ts'
import { isCredentialsBroken } from '../src/persona-bringup-controller.ts'
import { formatPersonaDiagnostic, PERSONA_CREDENTIALS_REFUSED, PERSONA_DESTINATION_FAILED } from '../src/persona-diagnostics.ts'
import { createPersonaEventRouter } from '../src/persona-event-router.ts'
import { createPersonaSerializer } from '../src/persona-serializer.ts'
import { stubCallCount } from './test-helpers/agent-director-stub.ts'
import { assertNoLeak } from './test-helpers/credentials.ts'
import { makeConnectionHarness, type ConnectionHarness } from './test-helpers/persona-connection-harness.ts'
import { resetRoutingState } from './test-helpers/persona-routing-harness.ts'
import { makeManagedRouting } from './test-helpers/persona-routing-managed.ts'
import { makeChannelMessage, type StubSlack } from './test-helpers/slack-stub.ts'
import { makeReloadHarness, type ReloadHarness, type ReloadRun } from './test-helpers/reload-harness.ts'

let h: ReloadHarness
/** The server lines the tool handlers write to `console.error` (a failed tool call's line), for `assertNoLeak`. */
let consoleLines: string[]
let consoleSpy: ReturnType<typeof spyOn>

beforeEach(() => {
  h = makeReloadHarness()
  consoleLines = []
  consoleSpy = spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    consoleLines.push(args.map(String).join(' '))
  })
})

afterEach(async () => {
  try {
    await h.cleanup()
  } finally {
    consoleSpy.mockRestore()
  }
})

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const HOUR_MS = 60 * 60 * 1000

/** A message ID for the tools that act on one (`react`). */
const MESSAGE_TS = '1700000000.000100'

/** A running pair: the run, alpha and bravo in file form. */
interface Running {
  run: ReloadRun
  alpha: PersonaInput
  bravo: PersonaInput
}

/**
 * alpha and bravo running from a byte-equal record and configuration file,
 * with the real lifecycle composition, detection started and its first check
 * run (nothing pending), and an MCP session registered for each.
 */
async function running(): Promise<Running> {
  const alpha = h.persona('alpha')
  const bravo = h.persona('bravo')
  h.materialize(alpha, bravo)
  h.writeRecord({ personas: [alpha, bravo] })
  h.writeConfig({ personas: [alpha, bravo] })
  const run = await h.startDetecting({ realLifecycle: true })
  await run.ticks.tick()
  expect(h.pendingExists()).toBe(false)
  expect([run.isUp('alpha'), run.isUp('bravo')]).toEqual([true, true])
  run.registerSession('alpha')
  run.registerSession('bravo')
  return { run, alpha, bravo }
}

/** The persona's only channel (its destination too). */
function channelOf(persona: PersonaInput): string {
  return persona.channels![0]!.id
}

/** The applied persona named `name`. */
function applied(run: ReloadRun, name: string): Persona {
  const found = run.controller.applied()?.config.personas.find((p) => p.name === name)
  if (found === undefined) throw new Error(`not applied: ${name}`)
  return found
}

/** The one line a Web API call of `method` refused with `code` logs for the persona: personas[i], name, key and credentials path. */
function refusedLine(persona: Persona, method: string, code = 'token_revoked'): string {
  return formatPersonaDiagnostic({
    class: PERSONA_CREDENTIALS_REFUSED,
    name: persona.name,
    key: persona.key,
    index: persona.index,
    path: persona.credentials_file,
    cause: `bot_token refused by a Web API call (${method}): Slack error ${code}`,
  })
}

/** Yield event-loop turns (no timer) until `cond` holds; fails if it never does. */
async function until(cond: () => boolean): Promise<void> {
  for (let i = 0; i < 1_000 && !cond(); i++) await new Promise((done) => setImmediate(done))
  expect(cond()).toBe(true)
}

/** Every `chat.postMessage` on `stubs` whose text is `text`. */
function postsCarrying(stubs: readonly StubSlack[], text: string): unknown[] {
  return stubs.flatMap((stub) =>
    stub.callLog.filter((c) => c.method === 'chat.postMessage' && JSON.stringify(c.args).includes(text)),
  )
}

/** B serves: an event on its connection reaches its session, and its tool call posts in its channel. */
async function expectBravoServes(run: ReloadRun, bravo: PersonaInput, tag: string): Promise<void> {
  const delivered = run.deliveries('bravo').length
  await run.deliver('bravo', makeChannelMessage({ channel: channelOf(bravo), text: `to bravo ${tag}` }))
  expect(run.deliveries('bravo').slice(delivered).map((d) => [d.chat_id, d.content])).toEqual([[channelOf(bravo), `to bravo ${tag}`]])
  const posts = run.stub('bravo').calls.postMessage.length
  const reply = await run.callTool('bravo', 'reply', { chat_id: channelOf(bravo), text: `from bravo ${tag}` })
  expect(reply.isError).toBe(false)
  expect(run.stub('bravo').calls.postMessage.slice(posts)).toMatchObject([{ channel: channelOf(bravo), text: `from bravo ${tag}` }])
}

/**
 * Revoke A's bot token and make A's `react` tool call hit it: the call is a
 * tool error, and A is marked at once. Returns the tool result.
 */
async function revokeThroughReact(run: ReloadRun, alpha: PersonaInput): Promise<{ isError: boolean; text: string }> {
  run.revokeBotToken('alpha')
  return run.callTool('alpha', 'react', { chat_id: channelOf(alpha), message_id: MESSAGE_TS, emoji: 'eyes' })
}

/**
 * The operator's repair: a working credentials file at A's path (fresh
 * tokens), the tick that previews it, the confirmation and the tick that
 * applies it. Returns the new credential set's stub.
 */
async function recover(run: ReloadRun, alpha: PersonaInput): Promise<StubSlack> {
  const { label } = h.rotateCredentials(alpha)
  await (await run.confirmPending()).applying
  return run.credentialsStub('alpha', label)
}

/** No token in anything the run captured, the tool handlers' console lines or `extra`. */
function expectNoLeak(run: ReloadRun, extra: Record<string, unknown> = {}): void {
  assertNoLeak(run.captured({ console: consoleLines, ...extra }))
}

// ---------------------------------------------------------------------------
// The revocation
// ---------------------------------------------------------------------------

describe('b.ujn: a Web API call refused with token_revoked marks the persona broken at once', () => {
  test('b.ujn: A’s tool call refused with token_revoked marks A broken with a credentials cause, logs one line naming A, personas[0] and its credentials path, drops A’s MCP session, keeps its instance (no agent-director call) and leaves B serving', async () => {
    const { run, alpha, bravo } = await running()
    const a = applied(run, 'alpha')
    const cp = run.checkpoint()

    const refused = await revokeThroughReact(run, alpha)

    expect(refused.isError).toBe(true)
    // The mark: the manager's status, the controller's credentials-broken state, the up check.
    expect(run.connections.manager.status(a.key)).toMatchObject({
      state: 'broken',
      phase: 'running',
      outcome: { class: PERSONA_CREDENTIALS_REFUSED, check: 'web-api', key: 'bot_token', slackError: 'token_revoked', method: 'reactions.add' },
    })
    expect(isCredentialsBroken(run.bringUps.state(a.key))).toBe(true)
    expect(run.bringUps.state(a.key)?.causes.slack?.class).toBe(PERSONA_CREDENTIALS_REFUSED)
    expect(run.isUp('alpha')).toBe(false)
    // Exactly one line names A's credentials path: the refused line, personas[0] and all.
    const logged = run.since(cp).logs
    expect(logged.filter((line) => line.includes(a.credentials_file))).toEqual([refusedLine(a, 'reactions.add')])
    expect(run.logsOf(PERSONA_CREDENTIALS_REFUSED)).toEqual([refusedLine(a, 'reactions.add')])
    // The one Slack call made since, by any persona, is A's refused one.
    expect(run.since(cp).slackCalls.map((c) => c.method)).toEqual(['reactions.add'])
    // Its MCP session is dropped; its instance is kept: no agent-director call, no lifecycle call.
    await until(() => run.session('alpha') === undefined)
    expect(stubCallCount(run.composition!.agentDirector)).toBe(0)
    expect(run.composition!.calls).toEqual([])
    expect(run.since(cp).lifecycle).toEqual([])
    // B is untouched and keeps serving.
    expect(run.isUp('bravo')).toBe(true)
    expect(run.session('bravo')).toBeDefined()
    await expectBravoServes(run, bravo, 'after the revocation')
    expectNoLeak(run, { refused })
  })

  test('b.ujn: nothing more reaches A: its connection is closed and never reopened, so no inbound event is delivered; a later notice and a later tool call post nothing under any identity; its instance cannot register', async () => {
    const { run, alpha, bravo } = await running()
    const a = applied(run, 'alpha')
    const stubA = run.stub('alpha')
    await revokeThroughReact(run, alpha)
    await until(() => run.session('alpha') === undefined)

    // The socket that carried A's events is closed by the manager and never reopened.
    const sockets = stubA.sockets.length
    const starts = stubA.sockets.map((s) => s.startCalls)
    expect(stubA.sockets.map((s) => s.connected)).toEqual(stubA.sockets.map(() => false))
    await run.clock.advance(HOUR_MS)
    expect(stubA.sockets).toHaveLength(sockets)
    expect(stubA.sockets.map((s) => s.startCalls)).toEqual(starts)

    // A later notice for A is held, never posted: no chat.postMessage on any stub carries it.
    const calls = stubA.callLog.length
    await run.notice('alpha', 'a notice while alpha is broken')
    await run.noticeClock.advance(HOUR_MS)
    expect(postsCarrying([stubA, run.stub('bravo')], 'a notice while alpha is broken')).toEqual([])

    // A's instance cannot register again; were a session still there, its tool call gets no client.
    expect(run.admitSession('alpha')).toEqual({ kind: 'not-up' })
    expect(run.session('alpha')).toBeUndefined()
    run.registerSession('alpha')
    const reply = await run.callTool('alpha', 'reply', { chat_id: channelOf(alpha), text: 'a reply while alpha is broken' })
    expect(reply.isError).toBe(true)
    expect(reply.text).toContain('not available')
    expect(postsCarrying([stubA, run.stub('bravo')], 'a reply while alpha is broken')).toEqual([])
    // Nothing of that reached Slack on A's stub.
    expect(stubA.callLog).toHaveLength(calls)

    expect(run.linesOf('alpha').filter((line) => line.includes(a.credentials_file))).toHaveLength(1)
    await expectBravoServes(run, bravo, 'while alpha is broken')
    expectNoLeak(run, { reply })
  })

  test('b.ujn: A does not recover by itself: its held digest still matches its file, so no pending change is written, and over many ticks and a long clock advance it is not re-validated and does not come up', async () => {
    const { run, alpha } = await running()
    const a = applied(run, 'alpha')
    await revokeThroughReact(run, alpha)
    expect(run.bringUps.credentialsDigest(a.key)).toEqual(h.credentialsDigestOf(alpha))
    const authTests = run.stub('alpha').calls.authTest.length
    const cp = run.checkpoint()

    await run.ticks.ticks(10)
    expect(h.pendingExists()).toBe(false)
    await run.clock.advance(24 * HOUR_MS)
    await run.ticks.ticks(10)

    expect(h.pendingExists()).toBe(false)
    expect(run.since(cp).lifecycle).toEqual([])
    expect(run.since(cp).writes).toEqual([])
    expect(run.stub('alpha').calls.authTest).toHaveLength(authTests)
    expect(run.isUp('alpha')).toBe(false)
    expect(isCredentialsBroken(run.bringUps.state(a.key))).toBe(true)
    expectNoLeak(run)
  })
})

// ---------------------------------------------------------------------------
// Recovery through the confirmed credentials change (b.av2 SR-6.4)
// ---------------------------------------------------------------------------

describe('b.ujn: recovery through the confirmed credentials change', () => {
  test('b.ujn: a working file at A’s path is previewed, not applied; once confirmed, step 6’s recovery bring-up brings A up with the new tokens and records its launch, with no reconnect, kill or delete, and admits its MCP registration again; the notice held while broken posts through the new identity only; B is untouched', async () => {
    const { run, alpha, bravo } = await running()
    const a = applied(run, 'alpha')
    const oldStub = run.stub('alpha')
    await revokeThroughReact(run, alpha)
    await until(() => run.session('alpha') === undefined)
    await run.notice('alpha', 'raised while alpha is broken')
    const bravoCalls = run.stub('bravo').callLog.length
    const bravoSockets = run.stub('bravo').sockets.length

    // The operator places a working file: previewed on the next tick, nothing applied.
    const { label } = h.rotateCredentials(alpha)
    const newStub = run.credentialsStub('alpha', label)
    const cp = run.checkpoint()
    await run.ticks.tick()
    expect(h.pendingExists()).toBe(true)
    expect(run.since(cp).lifecycle).toEqual([])
    expect(newStub.calls.authTest).toEqual([])
    expect(run.isUp('alpha')).toBe(false)
    expectNoLeak(run)

    // Confirmed: step 6 brings A up again as a recovery, with no reconnect and nothing for B.
    h.confirm()
    await run.ticks.tick()

    expect(run.since(cp).lifecycle).toEqual([
      { op: 'bring-up', key: a.key, via: 'apply', recovery: true, result: { outcome: 'up', failures: [] } },
      { op: 'launch', key: a.key, via: 'apply' },
    ])
    expect(run.isUp('alpha')).toBe(true)
    expect(run.currentStub('alpha')).toBe(newStub)
    expect(newStub.calls.authTest).toHaveLength(1)
    expect(run.bringUps.credentialsDigest(a.key)).toEqual(h.credentialsDigestOf(alpha))
    // The recovery, in order: A's bring-up state cancelled, its connection stopped and its DM
    // destination forgotten, then brought up afresh and launched; no reconnect, kill or delete.
    expect(run.composition!.calls).toEqual([
      ['bringUps.cancel', a.key],
      ['connections.stop', a.key],
      ['destinations.forget', a.key],
      ['storageCheck', a.key],
      ['bringUps.bringUp', a.key],
      ['launch', a.key],
    ])
    // No agent-director call (the launch is only recorded; its reuse of a kept row is
    // session-manager.test.ts's collision ladder).
    expect(stubCallCount(run.composition!.agentDirector)).toBe(0)
    expect(run.admitSession('alpha')).toMatchObject({ kind: 'admitted' })

    // A serves again under its new identity only: an event reaches its session, its tool call posts on the new client.
    const text = 'to alpha after the recovery'
    await newStub.socket.deliver(makeChannelMessage({ channel: channelOf(alpha), text }))
    expect(run.deliveries('alpha').map((d) => [d.chat_id, d.content])).toEqual([[channelOf(alpha), text]])
    const reply = await run.callTool('alpha', 'reply', { chat_id: channelOf(alpha), text: 'from alpha after the recovery' })
    expect(reply.isError).toBe(false)
    expect(postsCarrying([newStub], 'from alpha after the recovery')).toHaveLength(1)
    // The notice held while A was broken is posted once, through the new client.
    await run.noticeClock.advance(HOUR_MS)
    expect(postsCarrying([newStub], 'raised while alpha is broken')).toHaveLength(1)
    expect(postsCarrying([oldStub, run.stub('bravo')], 'raised while alpha is broken')).toEqual([])
    expect(postsCarrying([oldStub, run.stub('bravo')], 'from alpha after the recovery')).toEqual([])

    // B: no lifecycle record, Slack call or socket from the apply.
    expect(run.since(cp).lifecycle.filter((r) => r.key !== a.key)).toEqual([])
    expect(run.stub('bravo').sockets).toHaveLength(bravoSockets)
    expect(run.stub('bravo').callLog).toHaveLength(bravoCalls)
    await expectBravoServes(run, bravo, 'after alpha’s recovery')
    expect(h.pendingExists()).toBe(false)
    expect(h.readRecord()).toEqual(h.readConfig()!)
    expectNoLeak(run, { reply, newStub: newStub.callLog })
  })
})

// ---------------------------------------------------------------------------
// A notice that finds the token revoked (E13 Director: the hold keeps it)
// ---------------------------------------------------------------------------

describe('b.ujn: a notice post refused with token_revoked', () => {
  test('b.ujn: marks A broken the same way, and the notice is held, never posted while A is broken; after the confirmed recovery it posts once through A’s new client', async () => {
    const { run, alpha, bravo } = await running()
    const a = applied(run, 'alpha')
    const oldStub = run.stub('alpha')
    const text = 'the notice that finds the token revoked'
    run.revokeBotToken('alpha')
    const cp = run.checkpoint()

    await run.notice('alpha', text)

    expect(run.connections.manager.status(a.key)).toMatchObject({
      state: 'broken',
      phase: 'running',
      outcome: { slackError: 'token_revoked', method: 'chat.postMessage' },
    })
    expect(run.logsOf(PERSONA_CREDENTIALS_REFUSED)).toEqual([refusedLine(a, 'chat.postMessage')])
    // The notifier holds the refused notice under its destination-failure episode.
    expect(run.since(cp).logs.filter((line) => line.startsWith(`[slack] ${PERSONA_DESTINATION_FAILED}: `))).toHaveLength(1)
    await until(() => run.session('alpha') === undefined)

    // Held while A is broken: only the one refused attempt ever reached Slack, on any stub, however long the hold waits.
    await run.noticeClock.advance(HOUR_MS)
    await run.clock.advance(HOUR_MS)
    expect(postsCarrying([oldStub, run.stub('bravo')], text)).toHaveLength(1)
    expect(postsCarrying([oldStub], text)).toHaveLength(1)
    expect(run.isUp('alpha')).toBe(false)
    await expectBravoServes(run, bravo, 'while alpha’s notice is held')

    const newStub = await recover(run, alpha)
    expect(run.isUp('alpha')).toBe(true)
    await run.noticeClock.advance(HOUR_MS)

    expect(postsCarrying([newStub], text)).toHaveLength(1)
    expect(postsCarrying([oldStub, run.stub('bravo')], text)).toHaveLength(1)
    expectNoLeak(run, { newStub: newStub.callLog })
  })
})

// ---------------------------------------------------------------------------
// The detached socket while A's serializer turn is held (server.ts wiring)
// ---------------------------------------------------------------------------

describe('b.ujn: the manager wired with the per-persona serializer, as server.ts wires it', () => {
  let dir: string
  let c: ConnectionHarness | undefined

  beforeEach(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'persona-credentials-revoked-')))
    resetRoutingState()
  })

  afterEach(async () => {
    try {
      await c?.manager.stopAll()
      c = undefined
      resetRoutingState()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('b.ujn: A’s next inbound event, arriving on its detached socket before that socket’s close gets A’s turn, is not delivered to A’s session, while B’s event reaches B’s session; the close runs once A’s turn is free', async () => {
    const serializer = createPersonaSerializer()
    c = makeConnectionHarness([{ name: 'alpha' }, { name: 'bravo' }], dir, { serialize: serializer.run })
    const [A, B] = [c.p('alpha'), c.p('bravo')]
    for (const p of [A, B]) expect(await c.bringUp(p)).toMatchObject({ state: 'up' })
    const { routing, logs, notifications } = makeManagedRouting(c, dir)
    c.onEvent = createPersonaEventRouter({ routing, clientFor: c.clientFor, getPersona: c.getPersona, log: (line) => void logs.push(line) })
    const socketA = c.stub(A).socket
    const channelA = A.channels[0]!.id
    const channelB = B.channels[0]!.id

    // A lifecycle operation holds A's turn when a consumer's call on A's client is refused.
    const turn = Promise.withResolvers<void>()
    const held = serializer.run(A.key, () => turn.promise)
    c.stub(A).script.reactionsAdd.push({ kind: 'platform', error: 'token_revoked' })
    const refused = await c.clientFor(A.key)!.reactions.add({ channel: channelA, timestamp: MESSAGE_TS, name: 'eyes' }).then(
      () => undefined,
      (err: unknown) => err,
    )
    expect(refused).toMatchObject({ data: { error: 'token_revoked' } })
    expect(c.manager.status(A.key)).toMatchObject({ state: 'broken', phase: 'running' })
    expect(c.lines).toEqual([refusedLine(A, 'reactions.add')])
    expect(c.clientFor(A.key)).toBeUndefined()

    // Still open on the network, but detached: the event reaches no session.
    expect(socketA.connected).toBe(true)
    await socketA.deliver(makeChannelMessage({ channel: channelA, text: 'to alpha after the revocation' }))
    expect(notifications.get(A.key)).toEqual([])
    expect(logs.filter((line) => line.includes(`persona=${A.key}`))).toEqual([])
    await c.stub(B).socket.deliver(makeChannelMessage({ channel: channelB, text: 'to bravo' }))
    expect(notifications.get(B.key)!.map((n) => n.params.content)).toEqual(['to bravo'])
    expect(notifications.get(A.key)).toEqual([])

    turn.resolve()
    await held
    await c.clock.flush()
    expect(socketA.connected).toBe(false)
    expect(socketA.disconnectCalls).toBe(1)
    await c.clock.advance(HOUR_MS)
    expect(c.stub(A).sockets).toHaveLength(1)
    expect(c.lines).toHaveLength(1)
    assertNoLeak({ lines: c.lines, logs, console: consoleLines })
  })
})
