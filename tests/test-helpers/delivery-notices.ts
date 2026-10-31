/** reporting composition over the real queue, episodes and persona notifier. */
import * as fs from 'node:fs'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDeliveryReporting, type DeliveryReportState } from '../../src/delivery-notices.ts'
import type { DeliveryReason, DeliveryStatus } from '../../src/delivery-engine.ts'
import type { AcceptedInput, QueueItem, DeliveryQueue } from '../../src/delivery-queue.ts'
import { renderPersonaRef } from '../../src/persona-identity.ts'
import { createDeliveryPreparation } from '../../src/delivery-intake.ts'
import { createPersonaRouting } from '../../src/persona-routing.ts'
import { registerSession, unregisterSession, type SessionEntry } from '../../src/registry.ts'
import { makeMultiPersonaConfig, type PersonaSpec } from './persona-config.ts'
import { makeNoticeAlertsRig, makeNotifierHarness } from './persona-notifier.ts'
import { makeQueue, slackInput, deliveredRecord, readQueue } from './delivery-queue.ts'
import { asWebClient, makeChannelMessage, makeDeferredWebApiCall, type DeferredWebApiCall } from './slack-stub.ts'
import { assertNoLeak, LEAK_SENTINEL, sentinelInMessage } from './credentials.ts'

export async function makeDeliveryNoticeHarness(options: {
  queue?: DeliveryQueue; leakMarker?: string; fs?: typeof fs
  personas?: PersonaSpec[]; fungible?: boolean
} = {}) {
  const root = mkdtempSync(join(tmpdir(), 'delivery-notices-'))
  const config = makeMultiPersonaConfig(options.personas ?? [
    { name: 'alpha', channels: [{ id: 'C0ALPHA01', delivery: 'all' }, { id: 'C0BETA001', delivery: 'all' }], permission_prompts: 'C0ALPHA01' },
    { name: 'beta', channels: [{ id: 'C0BETA001', delivery: 'all' }, { id: 'C0ALPHA01', delivery: 'all' }], permission_prompts: 'C0BETA001' },
  ], root, { allow_invited_channels: options.fungible ?? false })
  const h = makeNotifierHarness(config, { leakMarker: options.leakMarker })
  const rig = makeNoticeAlertsRig(h, { logDir: root, omitStderr: true })
  const logs: string[] = [], blocked: { key: string; rule: 'menu' | 'input' }[] = [], delivered: { key: string; item: QueueItem }[] = []
  const states = new Map(config.personas.map(p => [p.key, { up: true } as DeliveryReportState]))
  const queue = options.queue ?? await makeQueue(root, { fs: options.fs, now: h.clock.now, onEvent: event => reporting?.queueEvent(event) })
  const reporting = createDeliveryReporting({ queue, episodes: rig.episodes, persona: key => config.personas.find(p => p.key === key), state: key => states.get(key)!,
    log: line => logs.push(line), notify: (key, text) => h.notifier.notify(key, text),
    delivered: (key, item) => { delivered.push({ key, item }) }, now: h.clock.now,
  })
  const [alpha, beta] = config.personas.map(p => p.key) as [string, string]
  const ref = (key = alpha) => { const p = config.personas.find(p => p.key === key)!; return renderPersonaRef(p.name, key) }
  async function accept(overrides: Partial<AcceptedInput> = {}, key = alpha) {
    const result = await queue.accept(key, slackInput(overrides))
    if (result.status === 'failed') throw new Error('notice fixture store failed')
    return result.item!
  }
  function status(item: QueueItem, patch: Partial<DeliveryStatus> = {}, key = alpha): DeliveryStatus {
    return { key, seq: item.accepted.seq, count: queue.items(key).filter(i => !i.delivered).length, ageMs: h.clock.now() - item.accepted.received_at,
      row: 'waiting', retypeCount: item.retypeCount, marker: true, relay: true, connected: true, up: true, latched: false, held: false,
      receiptWorking: false, dialogMaybeOpen: false, reconnectDeferred: false, ...patch }
  }
  function waiting(item: QueueItem, reason: DeliveryReason = 'not-now', patch: Partial<DeliveryStatus> = {}, key = alpha) {
    const facts = status(item, patch, key)
    reporting.engineEvent({ type: 'waiting', key, seq: item.accepted.seq, reason, ageMs: facts.ageMs, status: facts })
  }
  return { root, config, h, rig, queue, reporting, logs, blocked, delivered, states, alpha, beta, ref, accept, status, waiting,
    async complete(item: QueueItem, key = alpha) {
      if (!item.fixed) await queue.append(key, { v: 1, kind: 'fixed', seq: item.accepted.seq, parts: ['fixed'] })
      await queue.append(key, { ...deliveredRecord(item.accepted.seq, h.clock.now()), seq: item.accepted.seq })
      reporting.engineEvent({ type: 'item-delivered', key, seq: item.accepted.seq, at: h.clock.now(), waitMs: 0 })
    },
    async flush() { await h.clock.flush(); await Promise.resolve(); await Promise.resolve() },
    async cleanup() { await queue.stop(); rig.episodes.close(); h.cleanup(); rmSync(root, { recursive: true, force: true }) },
  }
}
export type DeliveryNoticeHarness = Awaited<ReturnType<typeof makeDeliveryNoticeHarness>>

/** b.vki: real Slack intake and durable storage, with only the disk fault and Slack answers scripted. */
export async function makeStorageNoticeHarness(options: { destination?: 'dm' | 'channel'; fungible?: boolean } = {}) {
  let diskFailed = false
  const n = await makeDeliveryNoticeHarness({
    fungible: options.fungible,
    leakMarker: LEAK_SENTINEL,
    personas: ['alpha', 'beta'].map(name => ({
      name, channels: [{ id: 'C0SOURCE1', delivery: 'all' }, { id: 'C0OTHER01', delivery: 'all' }],
      dm: { enabled: true, contact: name === 'alpha' ? 'U0ALPHA01' : 'U0BETA001' },
      permission_prompts: options.destination === 'channel' ? 'C0NOTICE1' : 'dm',
      invited: { permission_prompts: options.destination === 'channel' ? 'C0NOTICE1' : 'dm' },
    })),
    fs: { ...fs, fsyncSync(fd) {
      if (diskFailed && fs.fstatSync(fd).isFile()) throw Object.assign(new Error(sentinelInMessage('store')), { code: 'ENOSPC' })
      fs.fsyncSync(fd)
    } },
  })
  const held: DeferredWebApiCall[] = []
  const acks: { key: string; records: ReturnType<typeof readQueue> }[] = []
  const preparation = createDeliveryPreparation({
    queue: n.queue, clock: n.h.clock, resolveUserName: async (_key, user) => user,
    clientFor: key => asWebClient(n.h.stub(key).web), onReceived: n.reporting.received,
  })
  // A connected in-memory registry entry avoids all lost-session/agent work.
  for (const persona of n.config.personas) registerSession(persona.working_directory, persona.key,
    { close: async () => {} } as SessionEntry['transport'], {} as SessionEntry['server'])
  const routing = createPersonaRouting({
    getPersonaConfig: () => n.config, getBotIdentity: key => n.h.stub(key).identity,
    queue: n.queue, prepare: preparation.prepare, onReceived: n.reporting.received,
    archive: () => {}, log: line => n.logs.push(line), now: n.h.clock.now,
  })
  const body = 'private storage-warning regression body'
  const event = makeChannelMessage({ channel: 'C0SOURCE1', user: 'U0SENDER1', ts: '1700000000.000001',
    // A true mention selects the receiving persona in both Channel Modes.
    text: `<@${n.h.stub(n.alpha).identity.botUserId}> ${body}` })
  const captured = () => ({ logs: [...n.logs, ...n.h.logs, ...n.rig.lines],
    calls: [...n.h.stubs.values()].flatMap(stub => stub.callLog).filter(call => call.method.startsWith('chat.')) })
  return { ...n, event, body, acks, routing, preparation, captured,
    failStores(value = true) { diskFailed = value },
    hold(method: 'open' | 'post' | 'update', key = n.alpha) {
      const call = makeDeferredWebApiCall(); held.push(call); n.h.stub(key).script[method].push(call.outcome); return call
    },
    async receive(overrides: Record<string, unknown> = {}, key = n.alpha) {
      await routing.receive({ ...event, ...overrides }, () => { acks.push({ key, records: readQueue(n.root, key) }) }, key, false)
      await n.flush()
    },
    forget(key = n.alpha) {
      routing.forget(key); n.reporting.forget(key); preparation.forget(key)
      n.rig.episodes.forget(key); n.h.notifier.forget(key); n.h.hold.cancel(key); n.h.destinations.forget(key)
    },
    async cleanup() {
      diskFailed = false
      n.rig.episodes.close(); n.h.hold.cancelAll()
      for (const call of held) if (!call.settled) call.settle()
      await n.flush(); await preparation.stop()
      for (const persona of n.config.personas) unregisterSession(persona.key)
      try {
        assertNoLeak(captured())
        if (JSON.stringify(captured()).includes(body)) throw new Error('storage notice leaked the message body')
      } finally { await n.cleanup() }
    },
  }
}
export type StorageNoticeHarness = Awaited<ReturnType<typeof makeStorageNoticeHarness>>
