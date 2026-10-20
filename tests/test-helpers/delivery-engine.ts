/** Real durable queue + production executor, manual clock, shared AD stub and
 * concrete UI/transcript adapters (b.omv SR-13.2–13.4). No agent is launched. */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SendKeysParams } from 'agent-director'
import { createDeliveryEngines, createDeliveryLifecycle, DELIVERY_ROW_POLL_MS, type DeliveryEngineDeps, type DeliveryEngines, type DeliveryEngineEvent } from '../../src/delivery-engine.ts'
import { createDeliveryPreparation } from '../../src/delivery-intake.ts'
import type { AcceptedInput, DeliveryQueue, QueueRecord } from '../../src/delivery-queue.ts'
import { createFakeClock } from './fake-clock.ts'
import { makeQueue, injectedInput, readQueue } from './delivery-queue.ts'
import { cannedGetResult, makeStubClient, type CannedGetResult } from './agent-director-stub.ts'
import { appendTranscript, codexPromptEntry, endedTurn, promptEntry, replyEntry, writeTranscript } from './working-row-panes.ts'

export async function makeEngineHarness(options: { keys?: string[]; constants?: DeliveryEngineDeps['constants']; stateDir?: string; configuredAgent?: 'claude' | 'codex'; clientFor?: DeliveryEngineDeps['clientFor']; onRow?: DeliveryEngineDeps['onRow']; inspectUpgrade?: DeliveryEngineDeps['inspectUpgrade']; onEvent?: DeliveryEngineDeps['onEvent'] } = {}) {
  const root = options.stateDir ?? mkdtempSync(join(tmpdir(), 'delivery-engine-'))
  const clock = createFakeClock(), events: DeliveryEngineEvent[] = [], errors: unknown[] = []
  const calls: { key: string; verb: string; at: number; params: unknown }[] = []
  const restarts: { key: string; cwd: string }[] = [], order: string[] = [], failures = new Map<string, number>()
  let queue!: DeliveryQueue, engines!: DeliveryEngines, start = 0
  let realQueue = await makeQueue(root, { now: clock.now })
  queue = { ...realQueue, async append(key, record) {
    const count = failures.get(record.kind) ?? 0
    if (count > 0) { failures.set(record.kind, count - 1); throw Object.assign(new Error('injected append failure'), { code: 'ENOSPC' }) }
    await realQueue.append(key, record)
    order.push(`append:${record.kind}:${record.seq}`)
  } }
  const personas = new Map((options.keys ?? ['alpha']).map(key => {
    const path = join(root, `${key}-session.jsonl`)
    writeTranscript(path, endedTurn())
    const state = {
      key, path, row: cannedGetResult({ instance_id: `cscb_${key}`, cwd: root, jsonl_path: path, session_id: `${key}-session`, labels: { tag_prompt: '1' } }) as CannedGetResult,
      box: '', up: true, latched: false, held: false, connected: true, applied: true, restartPending: false,
      running: false, pane: undefined as string | undefined, getError: undefined as Error | undefined, getHook: undefined as (() => void) | undefined, paneError: undefined as Error | undefined,
      autoReceipt: true, lostEnters: 0, retainBox: false,
      keyHook: undefined as ((params: SendKeysParams) => Error | undefined | Promise<Error | undefined>) | undefined,
      reads: 0, readHook: undefined as (() => void) | undefined,
    }
    state.row.transcript_status = 'present'
    const stub = makeStubClient({
      getFn(params) { state.getHook?.(); calls.push({ key, verb: 'get', at: clock.now(), params }); return state.getError ?? state.row },
      readPaneFn(params) { calls.push({ key, verb: 'read-pane', at: clock.now(), params }); state.reads++; state.readHook?.(); return state.paneError ?? { pane: state.pane ?? 'arbitrary terminal contents', pane_sha256: '' } },
      async sendKeysFn(params) {
        calls.push({ key, verb: 'send-keys', at: clock.now(), params: { ...params } }); order.push(`keys:${key}`)
        const error = await state.keyHook?.(params)
        if (error) return error
        if (params.no_enter) state.box = params.text ?? ''
        else if (params.key === 'Enter') {
          if (state.lostEnters > 0) state.lostEnters--
          else {
            if (state.autoReceipt && state.box) appendTranscript(state.path, [state.row.agent === 'codex' ? codexPromptEntry(state.box) : promptEntry(state.box)])
            if (!state.retainBox) state.box = ''
            if (state.autoReceipt && state.row.agent !== 'codex') appendTranscript(state.path, [replyEntry()])
          }
        }
        return {}
      },
    })
    return [key, { ...state, stub, state }] as const
  }))
  let lifecycle = createDeliveryLifecycle({ clock })
  const preparation = createDeliveryPreparation({ queue, clock, clientFor: () => undefined,
    resolveUserName: async () => { order.push('lookup'); return 'sender' },
    onPending: key => engines?.wake(key), wake: key => engines?.wake(key),
  })
  function build() {
    engines = createDeliveryEngines({ queue, lifecycle, clock, constants: options.constants,
      clientFor: options.clientFor ?? (async key => personas.get(key)!.stub),
      instanceId: key => `cscb_${key}`,
      persona: key => personas.get(key)?.state.applied ? { cwd: root, agent: options.configuredAgent ?? (personas.get(key)!.state.row.agent === 'codex' ? 'codex' : 'claude') } : undefined,
      isUp: key => personas.get(key)?.state.up ?? false, isLatched: key => personas.get(key)?.state.latched ?? false,
      isHeld: key => personas.get(key)?.state.held ?? false, isConnected: key => personas.get(key)?.state.connected ?? false,
      prepare: (key, item) => preparation.owns(key, item.accepted.seq) ? preparation.prepare(key, item) : Promise.resolve(),
      isRestartPendingOrActive: key => personas.get(key)?.state.restartPending ?? false, scheduleRestart: (key, cwd) => restarts.push({ key, cwd }),
      reconnect: async (key, _client, beforeCall) => { beforeCall(); calls.push({ key, verb: 'reconnect', at: clock.now(), params: {} }) },
      onRow: options.onRow, inspectUpgrade: options.inspectUpgrade, onEvent: event => { events.push(event); options.onEvent?.(event) }, onError: (_key, error) => errors.push(error),
      onKeyError: async (_key, error) => { errors.push(error) },
    })
  }
  build()
  const h = {
    root, clock, queue, get realQueue() { return realQueue }, preparation, calls, events, errors, restarts, order,
    get engine() { return engines }, get lifecycle() { return lifecycle },
    p: (key = 'alpha') => personas.get(key)!.state,
    client: (key = 'alpha') => personas.get(key)!.stub,
    records: (key = 'alpha') => readQueue(root, key),
    failAppend: (kind: QueueRecord['kind'], count = 1) => failures.set(kind, count),
    async accept(text = 'message', key = 'alpha', parts: string[] | undefined = [text]) {
      const accepted = await queue.accept(key, injectedInput({ text }))
      if (accepted.status === 'failed') throw new Error('fixture acceptance failed')
      if (parts) await queue.append(key, { v: 1, kind: 'fixed', seq: accepted.seq, parts })
      return accepted.item!
    },
    async tick(key = 'alpha') { await engines.tick(key); await clock.flush() },
    async advance(ms: number) {
      const end = clock.now() + ms
      do { await clock.advanceTo(Math.min(end, clock.now() + DELIVERY_ROW_POLL_MS / 2)); for (const key of personas.keys()) if (engines.running(key)) await engines.tick(key) } while (clock.now() < end)
    },
    async until(predicate: () => boolean, limit = 300000) {
      const end = clock.now() + limit
      while (!predicate() && clock.now() < end) await h.advance(DELIVERY_ROW_POLL_MS / 2)
      if (!predicate()) throw new Error(`engine condition not reached at ${clock.now()}; phases=${JSON.stringify([...personas.keys()].map(key => [key, engines.snapshot(key)?.e.phase, engines.snapshot(key)?.r]))}`)
    },
    keyCalls(key = 'alpha') { return calls.filter(c => c.key === key && c.verb === 'send-keys') as { key: string; verb: string; at: number; params: SendKeysParams }[] },
    textCalls(key = 'alpha') { return h.keyCalls(key).filter(c => c.params.no_enter) },
    async restartServer() {
      await engines.stop(); await realQueue.stop()
      realQueue = await makeQueue(root, { now: clock.now })
      const append = queue.append
      Object.assign(queue, realQueue, { append })
      lifecycle = createDeliveryLifecycle({ clock }); build()
      for (const key of personas.keys()) engines.wake(key)
    },
    async cleanup() { await engines.stop(); await preparation.stop(); await queue.stop(); if (!options.stateDir) rmSync(root, { recursive: true, force: true }) },
  }
  return h
}
export type EngineHarness = Awaited<ReturnType<typeof makeEngineHarness>>
