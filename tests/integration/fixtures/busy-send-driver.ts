/** Integration of the packed queue/executor with real legacy AD and a shim's
 * synthetic custody contract. No test modules, fake source or Claude model.
 * Covered wire encoding is deliberately fixture-owned until E2's client exists.
 * Candidate runs must separately prove that client's actual option forwarding.
 */
import assert from 'node:assert/strict'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

assert(existsSync('/etc/cscb-ci-image'), 'requires the CI image')
const [root, instance, cwd, mode] = process.argv.slice(2)
assert(root && instance && cwd && ['absent', 'not_covered', 'fallback', 'covered', 'unknown'].includes(mode))
const pkg = process.env.CSCB_PKG_DIR!
const moduleAt = (name: string) => import(join(pkg, 'src', name + '.ts'))
const { Client } = await import(Bun.resolveSync('agent-director', pkg))
const { createDeliveryQueue } = await moduleAt('delivery-queue')
const { createDeliveryEngines, createDeliveryLifecycle } = await moduleAt('delivery-engine')
const { createCoveredReconnect } = await moduleAt('covered-delivery')
const { ErrCantSend, ErrUnknownErrorName } = await moduleAt('agent-director-errors')
const ad = await Client.create()
const bin = join(process.env.HOME!, '.config/agent-director/bin')
const control = join(bin, 'agent-director-busy-send.json')
const covered = ['fallback', 'covered', 'unknown'].includes(mode)
// "absent" leaves the real get untouched: this leg proves the actual runtime
// contract, and fails visibly if an E2 candidate covers this launch.
if (mode !== 'absent') writeFileSync(control, JSON.stringify({ instance_id: instance,
  busy_send: covered ? 'covered' : 'not_covered',
  send: mode === 'fallback' ? 'agent_not_covered' : 'held', lookup: mode === 'unknown' ? 'unknown' : 'final' }))

const wireCalls: { verb: string; params: any }[] = []
// E2 transport stand-in, not a replacement production client. The injected
// legacy methods still go through the actual packed AD client's serializer.
async function custody(verb: string, params: Record<string, unknown>) {
  if (verb === 'send-keys') {
    const records = readFileSync(join(stateDir, 'queue', key + '.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line))
    assert(records.some(r => r.kind === 'submitted' && r.caller_uuid === params.caller_uuid &&
      r.delivery_request_id === params.delivery_request_id), 'covered call preceded durable submission intent')
  }
  wireCalls.push({ verb, params })
  const argv = [join(bin, 'agent-director'), verb]
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === false) continue
    argv.push('--' + key.replaceAll('_', '-'))
    if (value !== true) argv.push(String(value))
  }
  const child = Bun.spawn(argv, { stdout: 'pipe', stderr: 'pipe' })
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
  if (code) {
    const error = JSON.parse(stderr)
    assert.equal(error.err_name, 'ErrCantSend')
    throw ErrCantSend ? new ErrCantSend(verb, error.err_name, error.err_description, error.err_details)
      : new ErrUnknownErrorName(error.err_name, { status: 'error', ...error })
  }
  return JSON.parse(stdout)
}
let now = Date.now()
const clock = { now: () => now, setTimeout: () => 0, clearTimeout: () => {} }
let queue: any, engine: any
const events: any[] = [], errors: unknown[] = []
const key = 'busy_fixture', stateDir = join(root, mode)
const legacyCalls: any[] = []
const client = {
  get: (params: any) => ad.get(params),
  async sendKeys(params: any) {
    if (params.send_mode) return custody('send-keys', params)
    legacyCalls.push(params)
    return ad.sendKeys(params)
  },
  getDelivery: (params: any) => custody('get-delivery', params),
}
async function open() {
  queue = createDeliveryQueue({ stateDir, now: clock.now })
  await queue.start()
  engine = createDeliveryEngines({ queue, clock, lifecycle: createDeliveryLifecycle({ clock }),
    clientFor: async () => client, instanceId: () => instance, persona: () => ({ cwd, agent: 'claude' }),
    isUp: () => true, isLatched: () => false, isHeld: () => false, isConnected: () => true,
    prepare: async () => { throw new Error('fixed record missing') },
    isRestartPendingOrActive: () => false, scheduleRestart: () => { throw new Error('unexpected restart') },
    reconnect: async () => { throw new Error('unexpected delivery reconnect') },
    onError: (_key: string, error: unknown) => errors.push(error), onEvent: (event: any) => events.push(event),
  })
}
async function tick() { now += 1000; await engine.tick(key) }
try {
  await open()
  const row = await ad.get({ instance_id: instance })
  if (mode === 'absent') assert.equal(row.busy_send, undefined, 'legacy runtime must really omit busy_send')
  else assert.equal(row.busy_send, covered ? 'covered' : 'not_covered')
  assert.equal(row.state, 'waiting')
  assert.equal(row.labels?.tag_prompt, '1')
  const text = `dual-path ${mode}\nexact 🙂 bytes`
  const accepted = await queue.accept(key, { source: 'interject', sender: 'interject', text })
  assert.equal(accepted.status, 'accepted')
  await queue.append(key, { v: 1, kind: 'fixed', seq: accepted.seq, parts: [text] })
  if (mode === 'covered' || mode === 'unknown') {
    await tick()
    assert.equal(wireCalls.filter(c => c.verb === 'send-keys').length, 1)
    assert.equal(queue.item(key, accepted.seq).delivered, false, 'held is not completion')
    assert.equal(events.filter(e => e.type === 'item-delivered').length, 0)
    const intent = queue.item(key, accepted.seq).records.find((r: any) => r.kind === 'submitted')
    assert(intent, 'durable submission missing')
    await engine.stop(); await queue.stop()
    await open() // Production journal recovery; the original adapter is gone.
    await tick()
    if (mode === 'unknown') {
      for (let i = 0; i < 3; i++) { now += 60_000; await tick() }
      assert.equal(queue.item(key, accepted.seq).delivered, false)
      assert.equal(events.filter(e => e.type === 'item-delivered').length, 0)
    } else {
      assert.equal(queue.item(key, accepted.seq).delivered, true)
      assert.equal(events.filter(e => e.type === 'item-delivered').length, 1)
    }
    assert.equal(wireCalls.filter(c => c.verb === 'send-keys').length, 1, 'recovery resent covered text')
    for (const call of wireCalls.filter(c => c.verb === 'get-delivery')) {
      assert.equal(call.params.caller_uuid, intent.caller_uuid)
      assert.equal(call.params.delivery_request_id, intent.delivery_request_id)
    }
    assert.equal(legacyCalls.length, 0, 'covered delivery escaped into raw keys')
    let pauses = 0, resumes = 0, notices = 0
    const reconnect = createCoveredReconnect()
    const input = { key, row, readRow: async () => row, ready: () => true,
      pause: async () => { pauses++ }, resume: async () => { resumes++ }, log: () => {}, notify: () => { notices++ } }
    assert.equal(await reconnect(input), 'restart-required')
    assert.equal(await reconnect(input), 'restart-required')
    assert.deepEqual([pauses, resumes, notices], [0, 0, 1])
  } else {
    const deadline = Date.now() + 20_000
    while (!queue.item(key, accepted.seq).delivered && Date.now() < deadline) {
      await tick()
      await Bun.sleep(50) // Let real tmux/stub transcript writes complete.
    }
    assert.equal(queue.item(key, accepted.seq).delivered, true, 'legacy transcript-backed delivery did not complete')
    assert.deepEqual(legacyCalls.map(c => c.no_enter ? 'text' : c.key), ['text', 'Enter'])
    assert.equal(legacyCalls[0].text, text)
    assert.equal(events.filter(e => e.type === 'item-delivered').length, 1)
    assert.equal(wireCalls.filter(c => c.verb === 'send-keys').length, mode === 'fallback' ? 1 : 0)
    if (mode === 'fallback') {
      assert.equal((await ad.get({ instance_id: instance })).busy_send, 'not_covered')
      const records = queue.item(key, accepted.seq).records
      assert(records.some((r: any) => r.kind === 'refused'), 'safe refusal was not persisted')
    }
  }
  // route_unavailable is an expected held diagnostic, never a restart.
  assert(errors.every(e => e instanceof Error &&
    (e.message.startsWith('route_unavailable:') || (mode === 'unknown' && e.message.startsWith('lookup-unknown:')))))
  console.log(`recorded: dual path ${mode} passed (packed executor/journal; ${covered ? 'synthetic custody' : 'real legacy transport'})`)
} finally {
  await engine?.stop(); await queue?.stop(); ad.close()
}
