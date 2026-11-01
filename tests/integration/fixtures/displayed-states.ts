/** b.iy3: packed production consumers over real registered AD hooks.
 * Image-only executable: no host client discovery, pane reads or AD JSON stubs.
 * stdout is a bounded evidence stream retained by the runner before cleanup.
 */
import { appendFileSync, existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { dirname, join, sep } from 'node:path'
import { strict as assert } from 'node:assert'
import { inspect } from 'node:util'

if (!existsSync('/etc/cscb-ci-image')) {
  console.error('FAIL: displayed-states: refused outside the CI image')
  process.exit(2)
}

setTimeout(() => { console.error('FAIL: displayed-states: 180 s overall bound'); process.exit(1) }, 180000).unref()

// Persist all captured diagnostics even when an assertion fails. The shell
// scans these and redirected stdout/stderr before releasing any driver output.
const errors: unknown[] = []
const trail: any[] = []
const log: unknown[] = []
const results: unknown[] = []
const capture = <T>(value: T): T => { results.push(value); return value }
const { assertPermissionPosts, assertListStates } = await import('./displayed-state-assertions.ts')
const root = realpathSync(process.env.SCENARIO_ROOT!)
for (const name of ['HOME', 'TMUX_TMPDIR', 'SLACK_STATE_DIR', 'DISPLAY_WORK', 'DISPLAY_BIN']) {
  const path = realpathSync(process.env[name]!)
  assert(path.startsWith(root + sep), `${name} is outside this scenario`)
}
assert(!process.env.TMUX && !process.env.TMUX_PANE, 'inherited tmux context')
const captureFile = process.env.DISPLAY_CAPTURE_FILE!
assert.equal(realpathSync(dirname(captureFile)), root, 'capture file is outside this scenario')
assert(!existsSync(captureFile), 'capture file must be fresh')
process.on('exit', () => writeFileSync(captureFile,
  inspect({ errors, trail, log, results }, { depth: null, maxArrayLength: null, maxStringLength: null })))
const pkg = process.env.CSCB_PKG_DIR ?? '/test-repo/node_modules/claude-slack-channel-bots'
const mod = (name: string): Promise<any> => import(join(pkg, 'src', name + '.ts'))
const { Client } = await import(import.meta.resolve('agent-director', join(pkg, 'src', 'agent-director-client.ts')))
const { WebClient } = await import(import.meta.resolve('@slack/web-api', join(pkg, 'src', 'server.ts')))
const configModule = await mod('config')
const identity = await mod('persona-identity')
const startup = await mod('agent-director-startup')
const singleton = await mod('agent-director-client')
const poller = await mod('permission-poller')
const outage = await mod('outage-state')
const delivery = await mod('delivery-engine')
const { createPersonaUpPredicate } = await mod('persona-start')
const { createDeliveryQueue } = await mod('delivery-queue')
const name = process.env.DISPLAY_PERSONA!
const channel = process.env.DISPLAY_CHANNEL!
const work = process.env.DISPLAY_WORK!
const config = configModule.resolvePersonaConfig({ personas: [{ name,
  credentials_file: join(root, 'unused-credentials.json'), working_directory: work,
  channels: [{ id: channel, delivery: 'all' }], permission_prompts: channel,
}], bind: '127.0.0.1', port: 3100 }, root)
const persona = config.personas[0]
const key = persona.key
// Explicit fixture connection/outcome/applied queries, using the same
// production admission predicate for both consumers.
const isPersonaUp = createPersonaUpPredicate({ status: (wanted: string) => wanted === key ? { state: 'up' } : undefined },
  { isUp: (wanted: string) => wanted === key, isApplied: (wanted: string) => wanted === key })
assert.equal(isPersonaUp(key), true)
assert.equal(isPersonaUp(key + '-unknown'), false)
const instance = identity.personaInstanceId(key)
const legacy = process.argv[2] === 'legacy'
assert(['current', 'legacy'].includes(process.argv[2]!), 'unknown scenario contract')
const record = JSON.parse(readFileSync(process.env.DISPLAY_RELEASE_RECORD!, 'utf8'))
const evidence = (kind: string, fields: object) => console.log('recorded: displayed-state ' + JSON.stringify({ kind, at: Date.now(), instance_id: instance, ...fields }))
const raw = await Client.create({ storePath: singleton.DEFAULT_STORE_PATH, createIfMissing: false, callTimeoutMs: 5000,
  logger: { debug() {}, info() {}, warn() {}, error() {} } })
assert.equal(raw.binaryVersion, record.version, 'selected client runtime differs from verified installed binary')
evidence('client-runtime', { version: raw.binaryVersion, path: raw.binaryPath, contract: legacy ? 'legacy' : 'current' })
await startup.runAgentDirectorStartupGate({ recordStartupError() {}, exit() { throw new Error('production startup gate refused') } })
const normalized = singleton.getClient()
outage.initOutageState({ getClient: singleton.getClient, notify() { throw new Error('unexpected AD outage') } })
const clients = startup.createDeliveryClientFactory(5000)
const deliveryClient = await clients.clientFor(key)
let session = ''
function bind(row: any) {
  assert.equal(row.instance_id, instance)
  assert.equal(row.session_id, session)
  assert.equal(row.agent, 'claude')
  assert.equal(row.labels.persona, key)
  assert.equal(row.labels.service, 'cscb')
  return row
}
async function read() { return bind(capture(await raw.get({ instance_id: instance }))) }
async function until(label: string, condition: () => Promise<boolean>, ms = 20000) {
  const deadline = Date.now() + ms
  do { if (await condition()) return; await Bun.sleep(200) } while (Date.now() < deadline)
  throw new Error(`timed out: ${label}`)
}
const initial = await raw.get({ instance_id: instance })
assert.equal(initial.state, 'waiting')
assert(initial.session_id && initial.jsonl_path, 'real SessionStart did not publish a session/transcript')
session = initial.session_id
bind(initial)
const control = join(process.env.DISPLAY_BIN!, 'stub-claude-hooks.' + session)
const adTrail = () => readFileSync(join(process.env.HOME!, '.config/agent-director/ad-trail.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
const hookRecords = () => existsSync(control + '.jsonl') ? readFileSync(control + '.jsonl', 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : []
async function command(value: string) {
  appendFileSync(control, value + '\n')
  await until(`registered hook control ${value}`, async () => hookRecords().some(row => row.command === value))
  const observed = hookRecords().filter(row => row.command === value)
  assert.equal(observed.length, 1)
  assert.equal(observed[0].session_id, session)
  assert.equal(observed[0].instance_id, instance)
  evidence('registered-hook', observed[0])
}
async function appliedHook(event: string) {
  let rows: any[] = []
  await until(`AD applied ${event}`, async () => {
    rows = adTrail().filter(row => row.event === 'ad.hook.fired' && row.instance_id === instance && row.session_id === session &&
      row.event_name === event && row.upsert_outcome === 'updated')
    return rows.length > 0
  })
  evidence('ad-hook-applied', { session_id: session, event_name: event, events: rows.map(row => ({ ts: row.ts,
    event_name: row.event_name, instance_id: row.instance_id, session_id: row.session_id, upsert_outcome: row.upsert_outcome })) })
}
await appliedHook('SessionStart')
function projection(row: any) {
  return { instance_id: row.instance_id, session_id: row.session_id, state: row.state, displayed_state: row.displayed_state,
    since: row.since, request_token: row.request_token, unchanged_minutes: row.unchanged_minutes, permission_requests: row.permission_requests?.map((r: any) => ({ request_token: r.request_token,
      request_id: r.request_id, delivery: r.delivery, requested_at: r.requested_at, hook_gone_at: r.hook_gone_at, tool_name: r.tool_name })) }
}
async function observeState(expected: string) {
  const row = await read()
  assert.equal(row.state, legacy ? expected : expected === 'idle_screen' ? 'working' : expected)
  if (!legacy && expected === 'idle_screen') assert.equal((row as any).displayed_state, 'idle_screen')
  const status = capture(await raw.status({ instance_id: instance }))
  assert.equal(status.state, row.state)
  bind(await raw.get({ instance_id: instance })) // bind the status read to the unchanged session
  if (!legacy && expected === 'idle_screen') assert.equal((status as any).displayed_state, 'idle_screen')
  evidence('get-status', { session_id: session, get: projection(row), status: projection(status) })
  return row
}
async function observeList(client: any, state: string, expected: { state: string; displayed_state?: string } | null) {
  await read()
  const rows = capture(await client.list({ state: [state], label: ['service=cscb', `persona=${key}`] })).spawns
  assertListStates(rows, expected)
  for (const row of rows) {
    assert.equal(row.instance_id, instance)
    assert.equal(row.agent, 'claude')
    assert.equal(row.cwd, work)
    assert.equal(row.labels.persona, key)
    assert.equal(row.labels.service, 'cscb')
    assert.equal(row.tmux_session_name, initial.tmux_session_name)
  }
  await read() // list has no session_id; bracket it with the same live get identity
  evidence('list', { session_id: session, client: client === raw ? 'unnormalized' : 'production-normalized', filter: state,
    rows: rows.map(projection) })
}
const queue = createDeliveryQueue({ stateDir: join(root, 'display-delivery') })
await queue.start()
const engine = delivery.createDeliveryEngines({ queue, lifecycle: delivery.createDeliveryLifecycle({}),
  clientFor: () => Promise.resolve(deliveryClient), instanceId: () => instance,
  persona: () => ({ cwd: work, agent: 'claude' }), isUp: isPersonaUp, isLatched: () => false,
  isHeld: () => false, isConnected: () => true, prepare: async () => {},
  isRestartPendingOrActive: () => false, scheduleRestart: () => { throw new Error('unexpected restart') },
  reconnect: async () => { throw new Error('unexpected reconnect') },
  onRow: (_key: string, row: any) => { bind(row); return false },
  onError: (_key: string, error: unknown) => { errors.push(error) },
  onKeyError: (_key: string, error: unknown) => { errors.push(error) },
})
try {
  const text = `displayed-state-receipt-${session}`
  const accepted = await queue.accept(key, { source: 'interject', sender: 'interject', text })
  assert.equal(accepted.status, 'accepted')
  await queue.append(key, { v: 1, kind: 'fixed', seq: accepted.seq, parts: [text] })
  engine.wake(key)
  await until('actual hook working and AD idle_screen', async () => {
    const row = await read()
    return (legacy ? row.state : (row as any).displayed_state) === 'idle_screen'
  })
  await observeState('idle_screen')
  const submitted = hookRecords().filter(row => row.event === 'UserPromptSubmit')
  assert.equal(submitted.length, 1)
  assert.equal(submitted[0].session_id, session)
  assert.equal(submitted[0].instance_id, instance)
  evidence('registered-hook', submitted[0])
  await appliedHook('UserPromptSubmit')
  const rawWorking = legacy ? { state: 'idle_screen' } : { state: 'working', displayed_state: 'idle_screen' }
  await observeList(raw, 'idle_screen', rawWorking)
  await observeList(raw, 'working', legacy ? null : rawWorking)
  await observeList(deliveryClient, 'working', legacy ? { state: 'working' } : rawWorking)
  assert.equal(bind(await deliveryClient.get({ instance_id: instance })).state, 'working')
  assert.equal((await deliveryClient.status({ instance_id: instance })).state, 'working')
  evidence(legacy ? 'expected-negative' : 'current-filters', { session_id: session,
    reason: legacy ? 'unnormalized-working-filter-omits-idle_screen' : 'raw-and-displayed-filters-match', normalized_working: true })
  const workingStart = Date.now()
  while (Date.now() - workingStart <= 2 * delivery.RECEIPT_WAIT_MS) {
    await engine.tick(key)
    assert.deepEqual(errors, [])
    assert.equal(queue.openCount(key), 1)
    assert.equal(engine.status(key).row, 'working')
    assert.equal(engine.status(key).receiptWorking, true)
    await Bun.sleep(1000)
  }
  evidence('working-extension', { session_id: session, elapsed_ms: Date.now() - workingStart,
    receipt_wait_ms: delivery.RECEIPT_WAIT_MS, status: engine.status(key) })
  await command('receipt')
  await appliedHook('Stop')
  await until('exact delayed receipt delivered', async () => queue.openCount(key) === 0)
  await engine.stop()
  const journal = readFileSync(join(root, 'display-delivery', 'queue', key + '.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line))
  const sent = journal.filter(row => row.kind === 'sent' && row.send_kind === 'text')
  const delivered = journal.filter(row => row.kind === 'delivered')
  assert.equal(sent.length, 1, 'delivery retyped before the receipt')
  assert.equal(sent[0].session_id, session)
  assert.equal(delivered.length, 1)
  assert.equal(delivered[0].seq, accepted.seq)
  assert.equal(delivered[0].receipt.path, initial.jsonl_path)
  const receipts = readFileSync(initial.jsonl_path, 'utf8').trim().split('\n').map(line => JSON.parse(line))
  assert.equal(receipts.filter(row => row.uuid === delivered[0].receipt.uuid && row.sessionId === session && row.message?.content === text).length, 1)
  evidence('exact-receipt', { session_id: session, delivered: delivered[0], text_sends: sent.length })
  await until('Stop reports waiting', async () => (await read()).state === 'waiting')

  // Real HTTP Slack stub; the only injected boundary is Slack, plus the
  // documented client seam for the legacy unnormalized negative control.
  const api = process.env.CSCB_SLACK_API_URL!
  assert(/^http:\/\/127\.0\.0\.1:[0-9]+\/api\/$/.test(api), 'non-loopback Slack endpoint')
  const web = new WebClient(process.env.DISPLAY_BOT_TOKEN!, { slackApiUrl: api, retryConfig: { retries: 0 } })
  const slackRows = () => readFileSync(process.env.DISPLAY_SLACK_RECORD!, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
  const permissionStart = slackRows().length
  const checkpoint = () => ({ http: slackRows().length, trail: trail.length })
  const checkPosts = (mark: ReturnType<typeof checkpoint>, tokens: string[]) =>
    assertPermissionPosts(slackRows().slice(mark.http), trail.slice(mark.trail), tokens, instance, channel)
  let fire: () => void
  let listDone = 0
  function start(client: any, expectedState: string | null = 'check_permission') {
    poller._resetPollerState()
    poller.startPermissionPoller({ getClient: () => ({
      async list(params: any) {
        const result = capture(await client.list(params))
        assertListStates(result.spawns, expectedState === null ? null : { state: expectedState })
        for (const row of result.spawns) {
          assert.equal(row.instance_id, instance)
          assert.equal(row.labels.persona, key)
          assert.equal(row.labels.service, 'cscb')
          assert.equal(row.agent, 'claude')
          assert.equal(row.cwd, work)
          assert.equal(row.tmux_session_name, initial.tmux_session_name)
        }
        await read()
        listDone++
        return result
      },
      get: async (params: any) => capture(await client.get(params)),
      getPermission: async (params: any) => capture(await client.getPermission(params)),
    }), clientFor: (wanted: string) => wanted === key ? web : undefined,
    getPersona: (wanted: string) => wanted === key ? persona : undefined, getPersonaConfig: () => config,
    isPersonaUp, intervalMs: 1000,
    setInterval: (cb: () => void) => { fire = cb; return 1 }, clearInterval() {},
    log: (...args: unknown[]) => { log.push(args) }, emitTrail(event: any) { trail.push(event) },
    })
  }
  async function tick(tokens: string[]) {
    const before = listDone
    const trailBefore = trail.length
    fire!()
    await until('poller completed actual list', async () => listDone === before + 1)
    await until('poller tracked intended requests', async () => tokens.every(token => poller.getLivePermission(instance, token)?.channelId === channel))
    await until('poller processed each request this tick', async () => tokens.every(token => trail.slice(trailBefore).some(event =>
      event.instance_id === instance && event.request_token === token &&
      ((event.event === 'cscb.poller.row_decision' && event.action === 'already_tracked') ||
       (event.event === 'cscb.chat_post.attempted' && event.ok === true)))))
    // Each token reached the post/duplicate branch. Empty raw-negative ticks
    // have no rows or tracked entries; their completion is synchronous after list.
    await Bun.sleep(0)
    assert.deepEqual(log, [], 'poller read/post/setup failure cannot count as a negative control')
  }
  async function requests(count: number) {
    let row: any
    await until(`real open request count ${count}`, async () => { row = await read(); return row.permission_requests.length === count })
    assert.deepEqual(row.permission_requests.map((r: any) => JSON.parse(r.tool_input).command).sort(),
      Array.from({ length: count }, (_, index) => `printf fixture-${index + 1}`))
    const tokens = row.permission_requests.map((r: any) => r.request_token)
    assert.equal(new Set(tokens).size, count)
    for (const token of tokens) {
      const request = capture(await raw.getPermission({ request_token: token }))
      assert.equal(request.request_token, token)
      const permission = row.permission_requests.find((p: any) => p.request_token === token)
      assert.equal(request.request_id, permission.request_id)
      assert.equal(request.tool_input, permission.tool_input)
      assert.equal(request.tool_name, 'Bash')
      const marker = JSON.parse(request.tool_input).command
      assert(['printf fixture-1', 'printf fixture-2'].includes(marker), 'foreign request body')
      await until('AD applied real relay request', async () => adTrail().some(event => event.event === 'ad.relay_attempt.completed' &&
        event.instance_id === instance && event.request_token === token && event.outcome === 'db_relay_active' && event.source === 'relay_hook'))
      evidence('ad-relay-active', { session_id: session, request_token: token, request_id: request.request_id, requested_at: request.requested_at })
    }
    return tokens as string[]
  }
  await command('permission-1')
  const [first] = await requests(1)
  await observeState('check_permission')
  await observeList(raw, 'check_permission', { state: 'check_permission' })
  // Unaged raw positive: the very same production poller posts this request.
  const unaged = checkpoint()
  start(raw)
  await tick([first!]); await tick([first!])
  const unagedPosts = checkPosts(unaged, [first!])
  const unagedPost = slackRows().find(row => row.response_ts === unagedPosts.posts[0]!.slack_ts)
  assert(unagedPost.blocks.some((block: any) => block.elements?.some((button: any) => button.action_id === `perm_allow_${instance}_${first}`)))
  evidence('unaged-permission-post', { session_id: session, request_token: first, channel, ...unagedPosts })
  // Deliberately contaminate only an in-memory copy of the actual HTTP
  // evidence. The same oracle must reject an extra post to another channel.
  assert.throws(() => assertPermissionPosts([...slackRows().slice(unaged.http),
    { ...unagedPost, channel: channel + 'EXTRA', response_ts: 'extra-post-control' }],
    trail.slice(unaged.trail), [first!], instance, channel), /HTTP post count differs from expected requests/)
  evidence('expected-negative', { reason: 'extra-http-post-rejected', source: 'in-memory-observation-copy' })
  poller.stopPermissionPoller(); poller._resetPollerState()
  await command('fallback-1')
  await until('AD confirms hook fallback', async () => (await raw.getPermission({ request_token: first! })).delivery === 'fallen_back')
  const fallbackObserved = Date.now()
  // Both versions use the legacy default aging interval (30 s), explicitly
  // configured by the guarded shell writer; it has no effect on current AD.
  await Bun.sleep(31000)
  await observeState(legacy ? 'needs_intelligence' : 'check_permission')
  const row = await read()
  assert.equal(row.permission_requests[0].request_token, first)
  if (legacy) assert.equal((row as any).request_token, first)
  else assert.notEqual((row as any).displayed_state, 'needs_intelligence')
  await observeList(raw, 'check_permission', legacy ? null : { state: 'check_permission' })
  if (legacy) {
    await observeList(raw, 'needs_intelligence', { state: 'needs_intelligence' })
    const negative = checkpoint()
    start(raw, null)
    await tick([]); await tick([])
    const negativePosts = checkPosts(negative, [])
    assert.equal(poller.getLivePermission(instance, first), undefined)
    await observeState('needs_intelligence')
    evidence('expected-negative', { session_id: session, request_token: first, reason: 'unnormalized-permission-filter-missing-post', completed_ticks: 2, ...negativePosts })
    poller.stopPermissionPoller(); poller._resetPollerState()
  }
  await observeList(normalized, 'check_permission', { state: 'check_permission' })
  const positive = checkpoint()
  start(normalized)
  await tick([first!]); await tick([first!])
  checkPosts(positive, [first!])
  await command('permission-2')
  const both = await requests(2)
  const second = both.find(token => token !== first)!
  assert(second)
  await command('fallback-2')
  await until('second confirmed fallback', async () => (await raw.getPermission({ request_token: second })).delivery === 'fallen_back')
  await observeState(legacy ? 'needs_intelligence' : 'check_permission')
  await observeList(raw, legacy ? 'needs_intelligence' : 'check_permission',
    { state: legacy ? 'needs_intelligence' : 'check_permission' })
  await observeList(normalized, 'check_permission', { state: 'check_permission' })
  await tick(both); await tick(both)
  const positivePosts = checkPosts(positive, [first!, second])
  for (const token of both) {
    assert.equal(poller.getLivePermission(instance, token).handled, false)
    assert.equal(poller.getLivePermission(instance, token).personaKey, key)
  }
  evidence('normalized-permission-posts', { session_id: session, request_tokens: [first, second], channel,
    ...positivePosts, fallback_age_ms: Date.now() - fallbackObserved, needs_intelligence_timeout_seconds: 30, idle_screen_timeout_seconds: 2 })
  poller.stopPermissionPoller(); poller._resetPollerState()
  const allPosts = slackRows().slice(permissionStart).filter(row => row.event === 'api' && row.method === 'chat.postMessage')
  assert.deepEqual(allPosts.map(row => ({ slack_ts: row.response_ts, channel: row.channel })),
    [...unagedPosts.posts, ...positivePosts.posts].map(({ slack_ts, channel }) => ({ slack_ts, channel })),
    'HTTP posts outside the checked legs')
  evidence('all-permission-posts', { session_id: session, post_count: allPosts.length })
  assert.deepEqual(errors, [])
} finally {
  poller.stopPermissionPoller()
  await engine.stop(); await queue.stop(); await clients.close()
  singleton.closeClient(); raw.close()
}
