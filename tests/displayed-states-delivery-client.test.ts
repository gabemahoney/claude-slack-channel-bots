/**
 * displayed-states-delivery-client.test.ts — the per-persona delivery clients
 * (`createDeliveryClientFactory().clientFor()`, `src/agent-director-startup.ts`)
 * answer each row's raw state whatever Displayed State agent-director 0.16 and
 * 0.17.0 show over it, as the installed singleton does.
 *
 * Harness: a stub `createClient` injected into the delivery client factory,
 * as `tests/dependency-check.test.ts` injects it, answering a stub
 * agent-director client. The stub shows one state; its `list` applies
 * agent-director's displayed-state filter (`listByDisplayedState`: a row
 * matches a `state` filter value only by the state it shows, and every
 * `label` entry). Reads go through `withOutageDetection` with the
 * delivery client given, as `src/server.ts` wires the delivery reads;
 * outage-state's own `getClient` throws, so no read can reach a singleton.
 *
 * Each case runs `assertNoLeak` over the outage notices and the engine's or
 * queue's records.
 *
 * Coverage, each for a row showing `idle_screen` or `needs_intelligence` and,
 * as the control, the raw `working` or `check_permission`:
 *   - the delivery client's `get`, `status` and a `list` filtered on the raw
 *     state answer the raw state;
 *   - delivery-engine receipt (audit site 18): a row that goes `idle_screen`
 *     after Enter holds the receipt's working extension, read as `working`,
 *     the facts the delivery-notices stuck exemption reads (site 19);
 *   - reply reminders (site 20): a row read `idle_screen` and then `waiting`
 *     keeps `row_state` `working` and nudges once.
 *
 * SPDX-License-Identifier: MIT
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Client, ListParams } from 'agent-director'
import { createDeliveryClientFactory } from '../src/agent-director-startup.ts'
import { DEFAULT_AGENT_DIRECTOR_CALL_TIMEOUT_MS } from '../src/config.ts'
import { DELIVERY_ROW_POLL_MS, ENTER_DELAY_MS, RECEIPT_WAIT_MS } from '../src/delivery-engine.ts'
import { createDeliveryQueue, type ReplyReminderQueue } from '../src/delivery-queue.ts'
import { _resetOutageState, initOutageState, withOutageDetection } from '../src/outage-state.ts'
import { createReplyReminders, REPLY_REMINDER_POLL_MS, REPLY_TOOL_PREALLOWED_LABEL, type ReplyReminders } from '../src/reply-reminder.ts'
import { personaInstanceId } from '../src/persona-identity.ts'
import { cannedGetResult, cannedListRow, cannedStatusResult, listByDisplayedState, makeStubClient, type StubClient } from './test-helpers/agent-director-stub.ts'
import { assertNoLeak } from './test-helpers/credentials.ts'
import { makeEngineHarness, type EngineHarness } from './test-helpers/delivery-engine.ts'
import { deliveredRecord, readQueue, sentRecord, slackInput } from './test-helpers/delivery-queue.ts'
import { createFakeClock } from './test-helpers/fake-clock.ts'
import { makeMultiPersonaConfig } from './test-helpers/persona-config.ts'
import { appendTranscript, promptEntry } from './test-helpers/working-row-panes.ts'

const KEY = 'alpha'
const INSTANCE = personaInstanceId(KEY)

/** Each state agent-director may show, with the raw state the delivery client must answer. */
const SHOWN_AS_RAW = [
  ['idle_screen', 'working'],
  ['needs_intelligence', 'check_permission'],
  ['working', 'working'],
  ['check_permission', 'check_permission'],
] as const

let dir: string
let closers: (() => Promise<void>)[]
/** Outage notices `withOutageDetection` posts; every case expects none. */
let notices: { key: string; text: string }[]

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'displayed-states-delivery-'))
  closers = []
  notices = []
  initOutageState({ getClient: () => { throw new Error('a delivery read reached the singleton') }, notify: (key, text) => { notices.push({ key, text }) } })
})

afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close()
  _resetOutageState()
  rmSync(dir, { recursive: true, force: true })
})

/** A delivery client factory whose every construction answers `client`, closed after the test. */
function deliveryClients(client: () => StubClient) {
  const factory = createDeliveryClientFactory(DEFAULT_AGENT_DIRECTOR_CALL_TIMEOUT_MS, {
    createClient: async () => client(),
    closeClient: () => {},
  })
  closers.push(() => factory.close())
  return factory
}

/** A delivery `get` as `src/server.ts` makes it: the persona's delivery client, through `withOutageDetection`. */
async function deliveryGet(factory: ReturnType<typeof deliveryClients>, key = KEY) {
  const client = await factory.clientFor(key)
  return withOutageDetection(key, undefined, 'get', c => c.get({ instance_id: INSTANCE }), { client, armsNothing: { personaConfigured: () => true } })
}

describe('a delivery client answers the raw state agent-director shows a Displayed State over', () => {
  test.each(SHOWN_AS_RAW)('shown %s: get, status and a list filtered on the raw state answer %s', async (shown, raw) => {
    const stub = makeStubClient({
      getFn: () => cannedGetResult({ instance_id: INSTANCE, state: shown }),
      statusFn: () => cannedStatusResult({ state: shown }),
    })
    Object.assign(stub, {
      list: async (params: ListParams) => ({ spawns: listByDisplayedState([cannedListRow({ instance_id: INSTANCE, state: shown })], params) }),
    })
    const factory = deliveryClients(() => stub)
    const client: Client = await factory.clientFor(KEY)
    expect((await deliveryGet(factory)).state).toBe(raw)
    expect((await client.status({ instance_id: INSTANCE })).state).toBe(raw)
    expect((await client.list({ state: [raw] })).spawns.map(row => [row.instance_id, row.state])).toEqual([[INSTANCE, raw]])
    expect(notices).toHaveLength(0)
    assertNoLeak({ notices })
  })
})

describe('delivery-engine receipt: a row showing idle_screen after Enter holds the working extension', () => {
  let h: EngineHarness
  afterEach(async () => { await h.cleanup() })

  test.each(['idle_screen', 'working'])('shown %s: the receipt is held as working, then delivered once on its receipt', async (shown) => {
    const factory = deliveryClients(() => h.client(KEY))
    h = await makeEngineHarness({ clientFor: key => factory.clientFor(key) })
    await h.accept('first')
    const p = h.p(); p.autoReceipt = false
    p.keyHook = params => { if (params.key === 'Enter') p.row.state = shown; return undefined }
    await h.tick()
    await h.advance(ENTER_DELAY_MS + DELIVERY_ROW_POLL_MS)
    expect(h.engine.status(KEY)).toMatchObject({ row: 'working', receiptWorking: true })
    await h.advance(2 * RECEIPT_WAIT_MS)
    expect(h.engine.status(KEY)).toMatchObject({ row: 'working', receiptWorking: true })
    expect(h.textCalls().map(call => call.params.text)).toEqual(['first'])
    appendTranscript(p.path, [promptEntry('first')])
    p.row.state = 'waiting'
    await h.until(() => h.queue.openCount(KEY) === 0)
    expect(h.textCalls().map(call => call.params.text)).toEqual(['first'])
    expect(h.records().filter(record => record.kind === 'delivered').map(record => record.seq)).toEqual([1])
    expect(h.errors).toHaveLength(0)
    expect(notices).toHaveLength(0)
    assertNoLeak({ events: h.events, records: h.records(), notices })
  })
})

describe('reply reminders: a row read idle_screen then waiting is nudged as from working', () => {
  test.each(['idle_screen', 'working'])('shown %s: the reminder fact records row_state working and one nudge follows waiting', async (shown) => {
    const queue = createDeliveryQueue({ stateDir: dir, now: () => 1000 })
    await queue.start()
    let monitor: ReplyReminders | undefined
    closers.push(async () => { await monitor?.stop(); await queue.stop() })
    const persona = makeMultiPersonaConfig([{ name: KEY }], dir).personas[0]!
    let state: string = shown
    const stub = makeStubClient({
      getFn: () => {
        const row = cannedGetResult({ state, session_id: 'session' }, persona, dir)
        return { ...row, labels: { ...row.labels, ...Object.fromEntries([REPLY_TOOL_PREALLOWED_LABEL.split('=')]) } }
      },
    })
    const factory = deliveryClients(() => stub)
    const clock = createFakeClock(), errors: unknown[] = []
    monitor = createReplyReminders({ queue, clock, getRow: (key) => deliveryGet(factory, key), ready: () => true, enabled: () => true,
      prepare: async () => {}, onError: (_key, error) => { errors.push(error) } })
    await delivered(queue)
    monitor.start(); await clock.runNext()
    expect(readQueue(dir, KEY).filter(r => r.kind === 'reply-reminder').at(-1)).toMatchObject({ state: 'observed', row_state: 'working' })
    state = 'waiting'; await clock.advance(REPLY_REMINDER_POLL_MS)
    expect(queue.items(KEY).filter(item => item.accepted.reminder_for !== undefined).map(item => item.accepted.reminder_for)).toEqual([1])
    expect(errors).toHaveLength(0)
    expect(notices).toHaveLength(0)
    assertNoLeak({ records: readQueue(dir, KEY), notices })
  })
})

/** A Slack message delivered to the persona with a durable delivery, so its reply reminder is pending. */
async function delivered(queue: ReplyReminderQueue): Promise<void> {
  const accepted = await queue.accept(KEY, slackInput())
  if (accepted.status !== 'accepted') throw new Error('fixture acceptance failed')
  await queue.append(KEY, { v: 1, kind: 'fixed', seq: accepted.seq, parts: ['delivered body'] })
  await queue.append(KEY, sentRecord(accepted.seq))
  await queue.append(KEY, deliveredRecord(accepted.seq))
}
