/** Cheap real queue/engine consumer of the shim's actual Results. In CI this
 * imports the installed tarball via CSCB_PKG_DIR. No native process or Slack. */
import assert from 'node:assert/strict'
import { appendFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
export async function checkBusyPackedConsumer(root: string, held: any, final: any) {
  const pkg = process.env.CSCB_PKG_DIR ?? resolve(import.meta.dir, '../../..')
  const { createDeliveryQueue } = await import(join(pkg, 'src/delivery-queue.ts'))
  const { createDeliveryEngines, createDeliveryLifecycle } = await import(join(pkg, 'src/delivery-engine.ts'))
  let now = 1000, sends = 0, completions = 0
  const clock = { now: () => now, setTimeout: () => 0, clearTimeout: () => {} }
  const queue = createDeliveryQueue({ stateDir: join(root, 'packed-consumer'), now: clock.now })
  await queue.start()
  const row = { instance_id: held.instance_id, state: 'waiting', agent: 'claude', busy_send: 'covered',
    session_id: 'fixture-session', relay_mode: 'on', labels: { tag_prompt: '1' } }
  const client = { get: async () => row, sendKeys: async () => { sends++; return held }, getDelivery: async () => ({ lookup: 'found', result: final }) }
  const engine = createDeliveryEngines({ queue, clock, lifecycle: createDeliveryLifecycle({ clock }),
    clientFor: async () => client, instanceId: () => row.instance_id, persona: () => ({ cwd: root, agent: 'claude' }),
    isUp: () => true, isLatched: () => false, isHeld: () => false, isConnected: () => true,
    prepare: async () => { throw new Error('missing fixed fixture') }, reconnect: async () => { throw new Error('unexpected reconnect') },
    isRestartPendingOrActive: () => false, scheduleRestart: () => { throw new Error('unexpected restart') },
    onEvent: (event: any) => { if (event.type === 'item-delivered') completions++ },
  })
  try {
    const accepted = await queue.accept('fixture', { source: 'interject', sender: 'fixture', text: 'exact bytes' })
    assert.equal(accepted.status, 'accepted')
    await queue.append('fixture', { v: 1, kind: 'fixed', seq: accepted.seq, parts: ['exact bytes'] })
    await engine.tick('fixture')
    assert.equal(sends, 1); assert.equal(completions, 0)
    now += 1000; await engine.tick('fixture')
    assert.equal(completions, 1, 'shim Final must pass the production journal validator')
    assert.equal(queue.item('fixture', accepted.seq).delivered, true)
    assert.equal(queue.item('fixture', accepted.seq).records.find((r: any) => r.kind === 'delivered').ad.launch_token, final.launch_token)
  } finally { await engine.stop(); await queue.stop() }
}

/** Consume the actual shim's get as well as its custody responses. A covered
 * waiting row has neither public launch_token nor pending-only launch start.
 * Only the raw transport's transcript write is simulated here; CI uses AD. */
export async function checkBusyShimConsumer(root: string, mode: string, invoke: (verb: string, params: any) => any) {
  const pkg = process.env.CSCB_PKG_DIR ?? resolve(import.meta.dir, '../../..')
  const { createDeliveryQueue } = await import(join(pkg, 'src/delivery-queue.ts'))
  const { createDeliveryEngines, createDeliveryLifecycle } = await import(join(pkg, 'src/delivery-engine.ts'))
  const { ErrCantSend, ErrUnknownErrorName } = await import(join(pkg, 'src/agent-director-errors.ts'))
  let now = 1000, coveredSends = 0, lookups = 0, completions = 0, composer = ''
  const rawCalls: any[] = []
  const clock = { now: () => now, setTimeout: () => 0, clearTimeout: () => {} }
  const queue = createDeliveryQueue({ stateDir: join(root, `shim-consumer-${mode}`), now: clock.now })
  await queue.start()
  const client = {
    get: async (params: any) => invoke('get', params),
    sendKeys: async (params: any) => {
      const reply = invoke('send-keys', params)
      if (params.send_mode) coveredSends++
      else rawCalls.push(params)
      if (reply.err_name) {
        assert.equal(reply.err_name, 'ErrCantSend')
        throw ErrCantSend ? new ErrCantSend('send-keys', reply.err_name, reply.err_description, reply.err_details)
          : new ErrUnknownErrorName(reply.err_name, { status: 'error', ...reply })
      }
      if (params.no_enter) composer = params.text
      else if (params.key === 'Enter') {
        appendFileSync(join(root, 'legacy-transcript.jsonl'), JSON.stringify({ type: 'user', uuid: `receipt-${mode}`,
          message: { role: 'user', content: composer } }) + '\n')
        composer = ''
      }
      return reply
    },
    getDelivery: async (params: any) => { lookups++; return invoke('get-delivery', params) },
  }
  const engine = createDeliveryEngines({ queue, clock, lifecycle: createDeliveryLifecycle({ clock }),
    clientFor: async () => client, instanceId: () => 'own', persona: () => ({ cwd: root, agent: 'claude' }),
    isUp: () => true, isLatched: () => false, isHeld: () => false, isConnected: () => true,
    prepare: async () => { throw new Error('missing fixed fixture') }, reconnect: async () => { throw new Error('unexpected reconnect') },
    isRestartPendingOrActive: () => false, scheduleRestart: () => { throw new Error('unexpected restart') },
    onEvent: (event: any) => { if (event.type === 'item-delivered') completions++ },
  })
  try {
    const text = `shim ${mode}\nexact 🙂 bytes`
    const accepted = await queue.accept('fixture', { source: 'interject', sender: 'fixture', text })
    assert.equal(accepted.status, 'accepted')
    await queue.append('fixture', { v: 1, kind: 'fixed', seq: accepted.seq, parts: [text] })
    await engine.tick('fixture')
    assert.equal(coveredSends, 1, `${mode}: shim-covered legacy waiting row never reached custody send`)
    for (let i = 0; i < 6; i++) { now += 1000; await engine.tick('fixture') }
    const item = queue.item('fixture', accepted.seq)
    assert.equal(item.delivered, mode !== 'unknown', `${mode}: shim response did not reach expected completion`)
    assert.equal(completions, mode === 'unknown' ? 0 : 1)
    assert.equal(coveredSends, 1, `${mode}: duplicate custody send`)
    if (mode === 'fallback') {
      assert.deepEqual(rawCalls.map(call => call.no_enter ? 'text' : call.key), ['text', 'Enter'])
      assert.equal(rawCalls[0].text, text)
      assert(item.records.some((record: any) => record.kind === 'refused'))
      assert.equal(lookups, 0)
    } else { assert.deepEqual(rawCalls, []); assert(lookups > 0) }
  } finally { await engine.stop(); await queue.stop() }
}
