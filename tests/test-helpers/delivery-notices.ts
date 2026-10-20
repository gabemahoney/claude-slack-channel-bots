/** E5 reporting composition over the real queue, episodes and persona notifier. */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDeliveryReporting, type DeliveryReportState } from '../../src/delivery-notices.ts'
import type { DeliveryReason, DeliveryStatus } from '../../src/delivery-engine.ts'
import type { AcceptedInput, QueueItem, DeliveryQueue } from '../../src/delivery-queue.ts'
import { renderPersonaRef } from '../../src/persona-identity.ts'
import { makeMultiPersonaConfig } from './persona-config.ts'
import { makeNoticeAlertsRig, makeNotifierHarness } from './persona-notifier.ts'
import { makeQueue, slackInput, deliveredRecord } from './delivery-queue.ts'

export async function makeDeliveryNoticeHarness(options: { queue?: DeliveryQueue } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'delivery-notices-'))
  const config = makeMultiPersonaConfig([
    { name: 'alpha', channels: [{ id: 'C0ALPHA01', delivery: 'all' }, { id: 'C0BETA001', delivery: 'all' }], permission_prompts: 'C0ALPHA01' },
    { name: 'beta', channels: [{ id: 'C0BETA001', delivery: 'all' }, { id: 'C0ALPHA01', delivery: 'all' }], permission_prompts: 'C0BETA001' },
  ], root)
  const h = makeNotifierHarness(config)
  const rig = makeNoticeAlertsRig(h, { logDir: root, omitStderr: true })
  const logs: string[] = [], blocked: { key: string; rule: 'menu' | 'input' }[] = [], delivered: { key: string; item: QueueItem }[] = []
  const states = new Map(config.personas.map(p => [p.key, { up: true } as DeliveryReportState]))
  const queue = options.queue ?? await makeQueue(root, { now: h.clock.now, onEvent: event => reporting?.queueEvent(event) })
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
