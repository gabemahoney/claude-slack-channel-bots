/** Real journal + covered adapter, synthetic AD custody facts, manual time. */
import * as fs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { GetResult } from 'agent-director'
import type { CoveredClient, CoveredDeliveryStep } from '../../src/covered-delivery.ts'
import type { DeliveryQueueOptions, SubmittedRecord } from '../../src/delivery-queue.ts'
import { cannedGetResult, makeStubCallLog, makeStubClient, type StubClientOptions } from './agent-director-stub.ts'
import { createFakeClock } from './fake-clock.ts'
import { injectedInput, makeQueue, readQueue } from './delivery-queue.ts'

export async function makeBusyHarness(options: { fs?: DeliveryQueueOptions['fs'] } = {}) {
  const root = fs.mkdtempSync(join(tmpdir(), 'busy-send-'))
  const clock = createFakeClock({ start: 1000 })
  let queue = await makeQueue(root, { ...options, now: clock.now })
  let ready = true, completions = 0
  const logs: string[] = [], notices: string[] = [], calls = makeStubCallLog()
  const script: StubClientOptions = { ...calls }
  const client = makeStubClient(script)
  let row = cannedGetResult({ instance_id: 'cscb_alpha', busy_send: 'covered', launch_token: 'launch-a', session_id: 'session' })
  let read: () => Promise<GetResult | undefined> = async () => row
  let call: CoveredDeliveryStep['call'] = async (_verb, run) => run(client)
  const module = await import('../../src/covered-delivery.ts')
  let adapter = module.createCoveredDelivery({ queue, now: clock.now, log: (_key, reason) => logs.push(reason), notify: (_key, reason) => notices.push(reason) })
  const accepted = await queue.accept('alpha', injectedInput({ text: 'exact\n🙂 <tag>\tbytes' }))
  if (accepted.status !== 'accepted') throw new Error('busy fixture acceptance failed')
  const seq = accepted.seq
  await queue.append('alpha', { v: 1, kind: 'fixed', seq, parts: [accepted.item!.accepted.text] })
  return {
    root, get queue() { return queue }, seq, script, calls, client, logs, notices, module,
    get row() { return row }, set row(value) { row = value },
    get completions() { return completions },
    advance(ms = module.COVERED_DELIVERY_POLL_MS) { return clock.advance(ms) },
    ready(value: boolean) { ready = value },
    read(fn: typeof read) { read = fn }, call(fn: typeof call) { call = fn },
    records() { return readQueue(root) },
    intent() { return queue.item('alpha', seq)!.records.find((r): r is SubmittedRecord => r.kind === 'submitted')! },
    resetAdapter() { adapter = module.createCoveredDelivery({ queue, now: clock.now, log: (_key, reason) => logs.push(reason), notify: (_key, reason) => notices.push(reason) }) },
    step(overrides: Partial<CoveredDeliveryStep> = {}) {
      return adapter.step({ key: 'alpha', row, item: queue.item('alpha', seq)!, part: 1, readRow: () => read(), ready: () => ready,
        client: async () => client as CoveredClient, call: (verb, run) => call(verb, run), delivered: () => { completions++ }, ...overrides })
    },
    async restart() { await queue.stop(); queue = await makeQueue(root, { ...options, now: clock.now }); adapter = module.createCoveredDelivery({ queue, now: clock.now, log: (_key, reason) => logs.push(reason), notify: (_key, reason) => notices.push(reason) }) },
    async cleanup() { await queue.stop(); fs.rmSync(root, { recursive: true, force: true }) },
  }
}
export type BusyHarness = Awaited<ReturnType<typeof makeBusyHarness>>
