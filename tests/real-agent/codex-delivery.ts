/** D1 production-module driver. Executable only inside a disposable CI shard.
 * Login contents are never read here; all rollout/home files remain private. */
import { appendFileSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { randomBytes } from 'node:crypto'

if (!existsSync('/etc/cscb-ci-image')) {
  console.error('FAIL: codex-delivery: refused: /etc/cscb-ci-image is absent')
  process.exit(2)
}

const { codexContainment, codexArguments, configureScratchCodex, createScratchCodexLifecycle, codexRetirementCheckpoint, CODEX_NATIVE, CODEX_AUTH_MOUNT, CODEX_NO_REPLY, under } = await import('./codex-guards.ts')
let paths: ReturnType<typeof codexContainment>
try { paths = codexContainment(process.env, realpathSync) }
catch { console.error('FAIL: codex-delivery: refused: scratch HOME/TMUX_TMPDIR, unset TMUX and selected model are required'); process.exit(2) }

const pkg = resolve(process.env.CSCB_PKG_DIR ?? '/test-repo/node_modules/claude-slack-channel-bots')
if (!under('/test-repo/node_modules', realpathSync(pkg))) {
  console.error('FAIL: codex-delivery: refused: the installed packed package is required')
  process.exit(2)
}
const crashProtocol = await import('./codex-crash-barrier.ts')
const { projectFailureState } = await import('./ai-failure-diagnostics.ts')

const codexHome = join(paths.home, '.codex'), work = join(paths.root, 'work', 'codex-delivery')
const stateDir = join(paths.root, 'codex-delivery-state'), key = 'codex_delivery'
let instance = `cscb_${key}`, stage = 'prepare', lastKey: string | null = null
const liveInstances = new Set<string>()
const nativeRollouts = new Map<string, import('./codex-evidence.ts').CodexRollout>()
const userNames = new Map<string, string>(), channelNames = new Map<string, string>()
let crashBarrier = false
let multipartSend: ((params: any) => Promise<any>) | undefined
const shim = join(paths.home, '.config/agent-director/bin/agent-director')
const shimLog = join(paths.home, '.config/agent-director/bin/agent-director-shim.log')
let scratchLifecycle: ReturnType<typeof createScratchCodexLifecycle> | undefined
let crashProgress: import('./codex-crash-barrier.ts').CrashProgress = { version: 1, pid: process.pid, instance: 'cscb_codex_gate',
  stage: 'startup', firstSeq: null, successorSeq: null, prepared: false, clientReady: false, queueReady: false,
  textStarted: false, textReturned: false, failed: false, errors: 0, error: 'none' }

function crashCheckpoint(next: string, patch: Partial<typeof crashProgress> = {}) {
  if (process.argv[2] !== 'crash-worker') return
  // Acceptance may finish concurrently with the held text call. Keep the
  // latest transport stage while adding the explicit durable sequence IDs.
  const preserveStage = crashProgress.textStarted && ['queue-ready', 'first-accepted', 'successor-accepted'].includes(next)
  crashProgress = { ...crashProgress, ...patch, stage: preserveStage ? crashProgress.stage : next }
  stage = `crash-worker-${crashProgress.stage}`
  crashProtocol.publishCrashProgress(join(stateDir, 'crash-progress.json'), crashProgress)
}
function crashError(error: unknown) {
  return error instanceof transport.ErrDialogMaybeOpen ? 'ErrDialogMaybeOpen'
    : error instanceof transport.ErrInvalidFlags ? 'ErrInvalidFlags'
    : error instanceof transport.ErrSendKeysWhileRelayed ? 'ErrSendKeysWhileRelayed'
    : error instanceof transport.ErrRelayFallenBack ? 'ErrRelayFallenBack' : 'other'
}

function entryExists(path: string) { try { lstatSync(path); return true } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return false; throw e } }
function privateDirectory(path: string) {
  let ancestor = path
  while (!entryExists(ancestor)) ancestor = dirname(ancestor)
  const existing = realpathSync(ancestor)
  if (existing !== paths.root && !under(paths.root, existing)) throw new Error('private directory ancestor escapes scratch root')
  mkdirSync(path, { recursive: true, mode: 0o700 })
  if (lstatSync(path).isSymbolicLink() || !under(paths.root, realpathSync(path))) throw new Error('private directory escapes scratch root')
}
function authSymlink() {
  if (!scratchLifecycle) throw new Error('scratch Codex lifecycle is not prepared')
  scratchLifecycle.check('on-error')
}
function authContract(checkpoint: 'prepare' | 'postspawn' | 'postidle' | 'final') {
  if (!scratchLifecycle) throw new Error('scratch Codex lifecycle is not prepared')
  scratchLifecycle.check(checkpoint)
}
function log(line: string) { appendFileSync(join(stateDir, 'server.log'), `[${new Date().toISOString()}] ${line}\n`, { mode: 0o600 }) }
function record(label: string, value: unknown) {
  console.log(`recorded: codex-${label} ${observation.redactRealObservation(JSON.stringify(value), process.env)}`)
}

async function prepare() {
  // All guards above precede process/state access. Never inspect the login bytes.
  if (!existsSync(CODEX_AUTH_MOUNT) || !lstatSync(CODEX_AUTH_MOUNT).isFile() || lstatSync(CODEX_AUTH_MOUNT).isSymbolicLink()
    || realpathSync(CODEX_AUTH_MOUNT) !== CODEX_AUTH_MOUNT || !lstatSync(shim).isFile() || !under(paths.home, realpathSync(shim))
    || !readFileSync(shim, 'utf8').includes('CSCB_CI_AGENT_DIRECTOR_SHIM_MARKER')) throw new Error('single login mount and scenario shim are required')
  privateDirectory(codexHome)
  if ((lstatSync(codexHome).mode & 0o777) !== 0o700) throw new Error('Codex home must be 0700')
  const auth = join(codexHome, 'auth.json')
  if (!entryExists(auth)) {
    const { symlinkSync } = await import('node:fs')
    symlinkSync(CODEX_AUTH_MOUNT, auth)
  }
  privateDirectory(work); privateDirectory(stateDir)
  crashCheckpoint('startup')
  // The package owns the strict TOML/key policy. No host settings are copied.
  const { checkCodexScratchConfigKeys } = await import(join(pkg, 'src/codex-config-keys.ts'))
  scratchLifecycle = createScratchCodexLifecycle({ root: paths.root, home: codexHome, stateDir,
    hostProjection: process.env.CODEX_HOST_CONFIG_KEYS, checkConfigKeys: checkCodexScratchConfigKeys,
    onCheck: (checkpoint, contract) => console.log(`recorded: codex-auth-contract ${JSON.stringify({ checkpoint, instance, ...contract })}`),
  })
  authContract('prepare')
  process.env.CODEX_HOME = codexHome
  const version = Bun.spawn([CODEX_NATIVE, '--version'], { stdout: 'pipe', stderr: 'pipe' })
  const [stdout, , exit] = await Promise.all([new Response(version.stdout).text(), new Response(version.stderr).text(), version.exited])
  if (exit !== 0 || stdout.trim() !== 'codex-cli 0.159.2') throw new Error('native Codex version mismatch')
  authContract('prepare')
  // Resolve config only inside scratch; no copied host settings.
  configureScratchCodex(paths.root, paths.home)
  console.log('recorded: codex-native {"version":"0.159.2"}')
}

function startupFailure(): never {
  try { crashCheckpoint(crashProgress.stage, { failed: true, error: 'preparation', errors: 1 }) } catch { /* no private checkpoint available yet */ }
  console.error('FAIL: codex-delivery: guarded native preparation failed')
  if (entryExists(join(codexHome, 'auth.json'))) {
    try { authSymlink(); console.log('recorded: codex-auth-symlink true') }
    catch { console.error('FAIL: codex-delivery: scratch auth/config contract failed') }
  }
  process.exit(1)
}
await prepare().catch(startupFailure)
crashCheckpoint('prepared', { prepared: true })
// Load only packed production modules after image/scratch/model/auth guards.
const [engineModule, queueModule, intakeModule, diagnostics, identity, notices, description, evidence, observation, transport, receipts] = await Promise.all([
  import(join(pkg, 'src/delivery-engine.ts')), import(join(pkg, 'src/delivery-queue.ts')),
  import(join(pkg, 'src/delivery-intake.ts')), import(join(pkg, 'src/persona-diagnostics.ts')),
  import(join(pkg, 'src/persona-identity.ts')), import(join(pkg, 'src/delivery-notices.ts')),
  import(join(pkg, 'src/tag-description.ts')), import('./codex-evidence.ts'),
  import('../integration/fixtures/real-observations.ts'),
  import(import.meta.resolve('agent-director', join(pkg, 'src/agent-director-startup.ts'))),
  import('../integration/fixtures/transcript-receipts.ts'),
]).catch(startupFailure)
crashCheckpoint('modules-ready')
// Deliberately omit storePath/home; Codex's AD hooks resolve through HOME.
const client = await transport.Client.create().catch(startupFailure)
if (client.binaryPath !== shim || client.binaryVersion !== '0.12.0') {
  await client.close()
  startupFailure()
}
crashCheckpoint('client-ready', { clientReady: true })
const tagDescription = `${description.TAG_DESCRIPTION}\n${CODEX_NO_REPLY}\n`
let engines: any, preparation: any, queue: any, lifecycle: any
const received = new Set<number>()
function receivedItem(item: any) {
  if (received.has(item.accepted.seq)) return
  received.add(item.accepted.seq)
  log(diagnostics.buildDeliveryDiagnostic(diagnostics.MESSAGE_RECEIVED, identity.renderPersonaRef('codex-delivery', key), diagnostics.deliveryIdentity(item.accepted)))
}
function engineEvent(event: any) {
  appendFileSync(join(stateDir, 'engine-events.jsonl'), JSON.stringify({ instance, ...event }) + '\n', { mode: 0o600 })
  if (event.type === 'launch-observed' || event.type === 'launch-first-waiting') {
    log(`[slack] delivery-${event.type}: ${JSON.stringify({ key, launch_id: event.launchId, session_id: event.sessionId, at: event.at })}`); return
  }
  const item = queue.item(key, event.seq)
  if (!item) return
  const ref = identity.renderPersonaRef('codex-delivery', key), who = diagnostics.deliveryIdentity(item.accepted)
  if (event.type === 'item-delivered') { receivedItem(item); log(diagnostics.buildDeliveryDiagnostic(diagnostics.MESSAGE_DELIVERED, ref, who, `at=${event.at} wait_ms=${event.waitMs}`)) }
  if (event.type === 'first-typed' && item.accepted.source === 'slack') log(notices.buildDeliveryDispatchLine(ref, item.accepted))
  if (event.type === 'retyped') log(diagnostics.buildDeliveryDiagnostic(diagnostics.MESSAGE_RETYPED, ref, who, `retype_count=${event.count}`))
  if (event.type === 'first-unconfirmed-retype') log(diagnostics.buildDeliveryDiagnostic(diagnostics.MESSAGE_NOT_TAKEN_IN, ref, who))
}
async function buildEngine() {
  queue = queueModule.createDeliveryQueue({ stateDir })
  await queue.start()
  lifecycle = engineModule.createDeliveryLifecycle({ startId: randomBytes(16).toString('hex') })
  preparation = intakeModule.createDeliveryPreparation({ queue, clientFor: () => ({ conversations: {
    info: async ({ channel }: { channel: string }) => ({ channel: { name: channelNames.get(channel) ?? channel } }),
  } }),
    resolveUserName: async (_key: string, user: string) => userNames.get(user) ?? user,
    // D1 injects lookup answers, never a Slack/MCP server or client.
    onReceived: (_key: string, item: any) => receivedItem(item), wake: () => engines.wake(key), onPending: () => engines?.wake(key) })
  engines = engineModule.createDeliveryEngines({ queue, lifecycle, clientFor: async () => ({
    get: (params: any) => client.get(params),
    sendKeys: async (params: any) => {
      if (crashBarrier && params.no_enter && typeof params.text === 'string') crashCheckpoint('text-call-start', { textStarted: true })
      const result = await (multipartSend ? multipartSend(params) : client.sendKeys(params))
      if (crashBarrier && params.no_enter && typeof params.text === 'string') {
        crashBarrier = false
        crashCheckpoint('text-call-return', { textReturned: true })
        crashProtocol.publishCrashProgress(join(stateDir, 'crash-after-text.json'), crashProgress)
        crashCheckpoint('barrier-published')
        // The real text call finished; hold its return so no Enter can start.
        // The parent SIGKILLs this harness, leaving the native agent alive.
        await new Promise(() => {})
      }
      return result
    },
  }),
    instanceId: () => instance, persona: () => ({ cwd: work, agent: 'codex' }),
    isUp: () => true, isLatched: () => false, isHeld: () => false, isConnected: () => true,
    prepare: (k: string, item: any) => preparation.prepare(k, item),
    isRestartPendingOrActive: () => false,
    scheduleRestart: () => { throw new Error('native row ended; observation requires a new contained dispatch') },
    reconnect: async () => { throw new Error('D1 injects connected; no MCP reconnect is permitted') },
    onError: (_key: string, error: unknown) => {
      crashCheckpoint(crashProgress.stage, { error: crashError(error), errors: Math.min(1000000, crashProgress.errors + 1) })
      log('[slack] codex-harness-call-failed')
    }, onEvent: engineEvent,
  })
  await preparation.recover([key])
  crashCheckpoint('queue-ready', { queueReady: true })
}
async function stopEngine() { await engines?.stop(); await preparation?.stop(); await lifecycle?.stop(); await queue?.stop() }
async function poll<T>(step: string, check: () => Promise<T | undefined>, ms = 120000): Promise<T> {
  const end = Date.now() + ms
  while (Date.now() < end) { const result = await check(); if (result !== undefined && Date.now() <= end) return result; await Bun.sleep(250) }
  record('bound', { step, milliseconds: ms })
  throw new Error(`${step}: observation incomplete within bound`)
}
async function row() {
  const r = await client.get({ instance_id: instance })
  if (r.instance_id !== instance || r.agent !== 'codex' || r.labels?.tag_prompt !== '1' || r.relay_mode !== 'on' || r.cwd !== work) throw new Error('wrong native row identity')
  return r
}
async function rollout(r = undefined as any) {
  r ??= await row()
  if (!r.jsonl_path || !r.session_id || !under(join(codexHome, 'sessions'), realpathSync(r.jsonl_path))) throw new Error('native rollout not yet available')
  const bytes = readFileSync(r.jsonl_path)
  if (bytes.length > 32 * 1024 * 1024) throw new Error('native rollout exceeded observation bound')
  const data = evidence.projectCodexRollout(bytes, r.session_id)
  nativeRollouts.set(data.session, data)
  return { row: r, path: r.jsonl_path, data }
}
async function waiting() {
  return poll('AD waiting row', async () => {
    const r = await row()
    if (r.state !== 'waiting') return
    authContract('postidle')
    return r
  })
}
async function sendWaiting(params: Record<string, unknown>) {
  await waiting()
  return client.sendKeys({ instance_id: instance, ...params })
}
async function retire(label: string) {
  stage = `${label}-retire`; lastKey = null
  await client.kill({ instance_id: instance })
  await retired(instance)
  liveInstances.delete(instance)
  await rollout()
  record('retired', { label, instance, method: 'kill-and-find-missing', state: (await row()).state, retired: true })
}
async function retired(id: string) {
  // AD 0.12 kill proves process exit but deliberately leaves the stored state.
  // Only its supported sweep may settle that state; never edit the store.
  return poll('row retirement', async () => {
    return await codexRetirementCheckpoint({ findMissing: () => client.findMissing({}),
      state: async () => (await client.get({ instance_id: id })).state }) ? true : undefined
  }, 30000)
}
async function start(label = 'delivery', instructions = 'For observation probes, answer with OK unless the input asks for another response.') {
  stage = `${label}-spawn`; lastKey = null
  instance = `cscb_codex_${label.replaceAll('-', '_')}`
  writeFileSync(join(work, 'AGENTS.md'), `${tagDescription}\n${instructions}\n`, { mode: 0o600 })
  liveInstances.add(instance)
  scratchLifecycle!.beforeSpawn()
  await client.spawn({ agent: 'codex', cwd: work, instance_id: instance, label: ['tag_prompt=1'], relay_mode: 'on',
    extra_env: { CODEX_HOME: codexHome }, agent_args: codexArguments(paths.model, tagDescription) })
  scratchLifecycle!.afterSpawn(instance)
  stage = `${label}-idle`
  await waiting()
  record('launch', { label, instance, agent: 'codex', version: '0.159.2', relay: 'on', tagPrompt: true, nativePath: CODEX_NATIVE, model: paths.model })
}
async function accept(input: any) {
  const result = await queue.accept(key, input)
  if (result.status !== 'accepted' || !result.item) throw new Error('queue did not durably accept observation input')
  if (process.argv[2] === 'crash-worker') {
    if (crashProgress.firstSeq === null) crashCheckpoint('first-accepted', { firstSeq: result.seq })
    else crashCheckpoint('successor-accepted', { successorSeq: result.seq })
  }
  receivedItem(result.item)
  await preparation.prepare(key, result.item)
  return result.seq as number
}
async function delivered(seq: number) {
  await poll('production delivery', async () => { await engines.tick(key); return queue.item(key, seq)?.delivered ? true : undefined }, 180000)
  return queue.item(key, seq)
}
async function completedItem(seq: number, part?: number, expected?: unknown, noTools = false) {
  const item = queue.item(key, seq)
  const target = part ?? item.fixed.parts.length
  const sends = item.records.filter((r: any) => r.kind === 'sent' && !r.unknown_outcome && r.part === target)
  const sent = sends[0]
  if (!sent) throw new Error('delivery has no durable send')
  const end = sent.at + 180000
  const complete = await poll('native completion', async () => {
    const current = await rollout()
    const window = { session: sent.session_id, offset: sent.transcript_size, sentAt: sent.at, text: item.fixed.parts[target - 1], model: paths.model }
    try {
      if (expected !== undefined) return (await import('./codex-ai.ts')).assertCodexAnswer(current.data, window, expected, { noTools })
      return evidence.completedCodexTurn(current.data, window)
    } catch { return }
  }, Math.max(0, end - Date.now()))
  record('rollout-model', complete.model)
  record('completed-turn', { session: sent.session_id, send: complete.send, receipt: complete.receipt, completion: complete.completion })
  return complete
}
async function observe(completionResearch = true) {
  await start('delivery'); await buildEngine()
  stage = 'queued-delivery'
  const seq = await accept({ source: 'interject', sender: 'codex-observation', text: 'Answer only OK. Use no tools.' })
  await delivered(seq)
  if (completionResearch) await completedItem(seq)
  await waiting()
  record('observations', { collected: true, contract: 'AD waiting and exact delivery receipt', completionResearch })
}

function journal() { return readFileSync(join(stateDir, 'queue', `${key}.jsonl`), 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) }
function eventJournal() { return readFileSync(join(stateDir, 'engine-events.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) }
function fault(match: 'key=Enter' | 'no_enter') {
  writeFileSync(shimLog.replace(/\.log$/, '.faults'), `send-keys ${match} swallow 1\n`, { mode: 0o600 })
}
function consumedFault(match: string) {
  return readFileSync(shimLog, 'utf8').split('\n').some(line => line.startsWith('fault\t') && receipts.shimWords(line.split('\t')[5]!)[1] === match)
}
function dm(text: string, n: number) {
  const ts = `1792000100.${String(n).padStart(6, '0')}`
  return { source: 'slack', text, user: 'U0OPERATOR', channel: 'D0CODEX', channel_type: 'im', via: 'dm', ts, key: { chat_id: 'D0CODEX', ts } }
}
function nativeTotals() {
  const totals = { input: 0, output: 0, cache_read: 0, cache_creation: 0 }
  for (const data of nativeRollouts.values()) {
    if (data.incomplete) throw new Error('partial final native rollout')
    const models = data.records.filter(r => r.type === 'turn_context')
    if (!models.length || models.some(r => r.model !== paths.model)) throw new Error('actual native model mismatch')
    const usage = data.records.filter(r => r.usage).at(-1)?.usage
    if (!usage || usage.input <= 0 || usage.output <= 0) throw new Error('actual native usage missing')
    for (const k of ['input', 'output', 'cache_read', 'cache_creation'] as const) totals[k] += usage[k]
    record('rollout-model', { session: data.session, model: paths.model })
  }
  if (!nativeRollouts.size) throw new Error('no native rollouts')
  return totals
}
async function summary(duplicates: number, completed: boolean) {
  await rollout()
  const tokens = nativeTotals()
  authContract('final')
  console.log(`duplicates: ${duplicates}`)
  console.log(`tokens: ${JSON.stringify(tokens)}`)
  console.log(`recorded: codex-model ${paths.model}`)
  if (completed) console.log('recorded: codex-completed true')
}

async function gate() {
  await observe(false)
  await stopEngine()
  // This probe and the gate share a workdir. Retire its AD row before the
  // next spawn; stopping delivery alone leaves the native process alive.
  await retire('delivery')
  await start('gate')
  await buildEngine()
  stage = 'gate-ac2'
  const basic = [dm('A direct message from the operator.', 1),
    { ...dm('A channel mention from the operator.', 2), channel: 'C0CODEX', channel_type: 'channel', via: 'mention', key: { chat_id: 'C0CODEX', ts: '1792000100.000002' } },
    { ...dm('A thread reply from the operator.', 3), channel: 'C0CODEX', channel_type: 'channel', via: 'thread', thread_ts: '1792000099.000001', key: { chat_id: 'C0CODEX', ts: '1792000100.000003' } }]
  const basicSeqs: number[] = []
  for (const input of basic) basicSeqs.push(await accept(input))
  for (const seq of basicSeqs) await delivered(seq)

  stage = 'gate-interleaved-faults'
  fault('key=Enter')
  const burst: number[] = []
  for (let n = 0; n < 10; n++) burst.push(await accept(n % 3 === 0 ? dm(`Interleaved Slack item ${n}.`, n + 10)
    : { source: n % 3 === 1 ? 'interject' : 'cron', sender: n % 3 === 1 ? 'operator' : 'cscb-cron:gate', text: `Interleaved prompt item ${n}.` }))
  await poll('actual swallowed Enter', async () => consumedFault('key=Enter') ? true : undefined, 180000)
  // The next text call is swallowed independently; unconfirmed work retries
  // under the same AD-state/backoff contract as every other delivery.
  fault('no_enter')
  for (const seq of burst) await delivered(seq)
  if (!consumedFault('no_enter')) throw new Error('whole-text fault never occurred')
  const { auditCodexDelivery, assertCodexRecovery, codexShimCalls } = await import('./codex-gate.ts')
  assertCodexRecovery(journal(), burst[0]!, 'enter', readFileSync(shimLog, 'utf8'), instance)
  assertCodexRecovery(journal(), burst[1]!, 'retype', readFileSync(shimLog, 'utf8'), instance)
  const completedPrefix = journal().filter(r => r.seq >= basicSeqs[0]!)

  stage = 'gate-crash-between-text-and-enter'
  await stopEngine()
  const child = Bun.spawn([process.execPath, import.meta.path, 'crash-worker'], { stdout: 'ignore', stderr: 'ignore', env: { ...process.env } })
  try {
    const pair = await crashProtocol.waitForCrashBoundary({ child, instance,
      checkpoint: join(stateDir, 'crash-progress.json'), marker: join(stateDir, 'crash-after-text.json'),
      journal,
      counts: () => {
        try {
          const calls = codexShimCalls(readFileSync(shimLog, 'utf8')).filter(c => c.parent === child.pid && c.instance === instance)
          return { queue: journal().filter(r => r.kind === 'accepted').length, text: calls.filter(c => c.noEnter).length, enter: calls.filter(c => c.key === 'Enter').length }
        } catch { return { queue: -1, text: -1, enter: -1 } }
      },
      diagnostic: value => record('crash-worker', value), bound: () => record('bound', { step: 'real child text barrier', milliseconds: 180000 }),
      now: () => Date.now(), sleep: ms => Bun.sleep(ms),
    })
    const beforeKill = journal(), crashItem = beforeKill.find(r => r.kind === 'accepted' && r.seq === pair.firstSeq)
    if (!crashItem || !beforeKill.some(r => r.kind === 'accepted' && r.seq === pair.successorSeq)) throw new Error('crash input pair was not durable')
    const typed = beforeKill.find(r => r.kind === 'fixed' && r.seq === crashItem.seq)?.parts[0]
    const calls = codexShimCalls(readFileSync(shimLog, 'utf8')).filter(c => c.parent === child.pid && c.instance === instance)
    if (!calls.some(c => c.text === typed && c.noEnter) || calls.some(c => c.key === 'Enter')) throw new Error('child crash boundary did not precede Enter')
    child.kill('SIGKILL')
    await child.exited
    if (child.signalCode !== 'SIGKILL') throw new Error('harness was not actually killed with SIGKILL')
    record('harness-crash', { pid: child.pid, signal: child.signalCode, seq: crashItem.seq, afterText: true, beforeEnter: true })
    await buildEngine()
    for (const item of queue.items(key)) if (!item.delivered) await delivered(item.accepted.seq)
    assertCodexRecovery(journal(), crashItem.seq, 'enter', readFileSync(shimLog, 'utf8'), instance)
  } finally { if (child.exitCode === null) { child.kill('SIGKILL'); await child.exited } }

  stage = 'gate-trailing-popup-fidelity'
  for (const [index, suffix] of ['@', '$'].entries()) {
    const seq = await accept(dm(`This body ends in ${suffix}`, 30 + index))
    await delivered(seq)
    assertCodexRecovery(journal(), seq, 'no-retype', readFileSync(shimLog, 'utf8'), instance)
  }
  if (queue.openCount(key) !== 0) throw new Error('gate retained open items')
  stage = 'gate-final-audit'
  const current = await rollout()
  const audit = auditCodexDelivery({ journal: journal().filter(r => r.seq >= basicSeqs[0]!), completedPrefix, rollout: current.data, path: current.path,
    instance, shim: readFileSync(shimLog, 'utf8'), events: eventJournal(), key, log: readFileSync(join(stateDir, 'server.log'), 'utf8') })
  if (audit.items !== 17) throw new Error('gate scenario inventory incomplete')
  record('gate', { assertionsPassed: true, items: audit.items, firstReceipts: audit.firstReceipts, queueEmpty: true })
  await summary(audit.duplicates, false)
}

async function crashWorker() {
  instance = 'cscb_codex_gate'
  crashBarrier = true
  await buildEngine()
  const seq = await accept(dm('Recover this message after a harness crash.', 25))
  await accept({ source: 'interject', sender: 'operator', text: 'Deliver this queued successor after crash recovery.' })
  await delivered(seq)
  throw new Error('crash worker unexpectedly escaped its text boundary')
}

async function ai(ac: number) {
  if (!/^[123]$/.test(process.env.REAL_AGENT_TRIAL ?? '') || ![11, 12, 15, 20, 106].includes(ac)) throw new Error('explicit AI criterion and trial 1..3 required')
  const oracle = await import('./codex-ai.ts'), gateOracle = await import('./codex-gate.ts')
  const sessions = new Set<string>()
  let duplicates = 0
  const begin = async (label: string, instructions: string) => {
    if (engines) await stopEngine()
    await start(label, instructions)
    const session = (await row()).session_id
    if (!session || sessions.has(session)) throw new Error('AI case did not get a fresh native conversation')
    sessions.add(session)
    await buildEngine()
    return queue.items(key).at(-1)?.accepted.seq ?? 0
  }
  const audit = async (after: number) => {
    const current = await rollout()
    const actual = gateOracle.auditCodexDelivery({ journal: journal().filter(r => r.seq > after), rollout: current.data, path: current.path,
      instance, shim: readFileSync(shimLog, 'utf8'), events: eventJournal(), key, log: readFileSync(join(stateDir, 'server.log'), 'utf8') })
    duplicates += actual.duplicates
    oracle.assertCodexNoShell(current.data)
  }
  if ([11, 12, 20].includes(ac)) {
    const cases = oracle.codexAICases(ac)
    if (ac === 11 && cases.length !== 15) throw new Error('AC11 corpus incomplete')
    for (const [i, test] of cases.entries()) {
      stage = `AI-AC${ac}-${test.label}`
      if (test.msg.user_id) userNames.set(test.msg.user_id, test.msg.user)
      channelNames.set(test.msg.chat_id, test.msg.channel_name)
      const after = await begin(`ai_${ac}_${i}`, `For each received tagged message return one JSON object {"case":"${test.label}","attributes":a map of all outer tag attributes and values,"body":the received BODY}. Transcribe BODY verbatim, preserving every character, whitespace and entity spelling; use only JSON string escaping. Return JSON without Markdown.`)
      const seq = await accept(oracle.codexSlackInput(test.msg))
      if (JSON.stringify(queue.item(key, seq).fixed.parts) !== JSON.stringify([test.typed])) throw new Error('production wrapper differs from independent audited reference')
      await delivered(seq)
      await completedItem(seq, 1, test.expected, test.name === 'ex3_peer_bot_spoof')
      await waiting()
      await completedItem(seq, 1, test.expected, test.name === 'ex3_peer_bot_spoof')
      await audit(after)
      record('ai-case', { ac, trial: Number(process.env.REAL_AGENT_TRIAL), case: test.label, fixture: test.name, completed: true })
      await retire(`ai_${ac}_${i}`)
    }
  } else if (ac === 15) {
    const after = await begin('ai_15', 'Give a visible JSON response on every turn. For received multipart input, acknowledge a nonfinal part with {"status":"received"} and finish the turn. Once complete return {"case":"AC15","messages":the number of messages received,"body":the joined BODY}. Use only input received in this conversation. Do not retrieve other data. Use no tools. Return JSON without Markdown.')
    const message = oracle.codexAC15Message(), body = message.text
    userNames.set(message.user_id, message.user)
    const answers: any[] = []
    multipartSend = oracle.codexMultipartSender((params: any) => client.sendKeys(params), async text => {
      const item = queue.items(key).find((item: any) => item.accepted.seq > after && item.fixed?.parts.includes(text))
      if (!item) throw new Error('AC15 submission has no exact durable part')
      const part = item.fixed.parts.indexOf(text) + 1
      if (part !== answers.length + 1) throw new Error('AC15 submission order differs')
      stage = `AI-AC15-part-${part}-completion`
      answers.push(await completedItem(item.accepted.seq, part,
        part < 3 ? { status: 'received' } : { case: 'AC15', messages: 1, body }, true))
    })
    try {
      const seq = await accept(oracle.codexSlackInput(message))
      await delivered(seq)
      const parts = queue.item(key, seq).fixed.parts
      if (parts.length !== 3) throw new Error('AC15 production wrapper did not make three parts')
      oracle.assertCodexMultipart(parts, body, answers)
      await waiting()
      await completedItem(seq, 3, { case: 'AC15', messages: 1, body }, true)
      await audit(after)
    } finally { multipartSend = undefined }
  } else {
    const after = await begin('ai_106', 'Answer ordinary test requests with JSON without Markdown. Acknowledge a message with {"status":"received"}. When asked for a count, return {"case":"AC106","messages":the number of distinct prior DMs received before the query}. Use no tools.')
    const seq = await accept(dm('Please acknowledge this DM.', 110))
    await delivered(seq); await completedItem(seq, 1, { status: 'received' }, true); await waiting()
    const item = queue.item(key, seq), sent = item.records.find((r: any) => r.kind === 'sent' && r.part === 1)
    const first = { session: sent.session_id, offset: sent.transcript_size, sentAt: sent.at, text: item.fixed.parts[0], model: paths.model }
    const before = await rollout(), second = { session: before.data.session, offset: before.data.size, sentAt: Date.now(), text: first.text, model: paths.model }
    await sendWaiting({ text: first.text })
    await poll('second actual exact DM take-in and completion', async () => {
      const current = await rollout()
      try { return oracle.assertCodexDuplicateTakeins(current.data, first, second) } catch { return }
    }, 180000)
    const actual = [...receipts.shimSends(readFileSync(shimLog, 'utf8'))].reverse().find(s => s.instanceId === instance && s.text === first.text && s.at >= second.sentAt && !s.words.includes('--no-enter'))
    if (!actual) throw new Error('second DM has no actual submitted shim call')
    await waiting()
    oracle.assertCodexDuplicateTakeins((await rollout()).data, first, second)
    const query = await accept(dm('How many distinct DMs have you received before this query? Return a JSON object with case "AC106" and messages set to the count you observed.', 111))
    await delivered(query); await completedItem(query, 1, { case: 'AC106', messages: 1 }, true); await waiting()
    await completedItem(query, 1, { case: 'AC106', messages: 1 }, true)
    await audit(after)
  }
  if (queue.openCount(key) !== 0) throw new Error('AI scenario retained open items')
  await summary(duplicates, true)
}

try {
  const [command, file] = process.argv.slice(2)
  if (command === 'observe') await observe()
  else if (command === 'gate') await gate()
  else if (command === 'crash-worker') await crashWorker()
  else if (command === 'ai') await ai(Number(file))
  else if (command === 'start') await start()
  else if (command === 'deliver' || command === 'recover') {
    await buildEngine()
    if (command === 'deliver') {
      if (!file || !under(paths.root, realpathSync(file))) throw new Error('input file must be private scenario input')
      const inputs = JSON.parse(readFileSync(file, 'utf8'))
      if (!Array.isArray(inputs)) throw new Error('input must be an array')
      for (const input of inputs) await accept(input)
    }
    for (const item of queue.items(key)) if (!item.delivered) await delivered(item.accepted.seq)
  }
  else throw new Error('usage: codex-delivery observe|start|deliver <private-input.json>|recover')
} catch (error) {
  crashCheckpoint(crashProgress.stage, { failed: true, error: crashError(error), errors: Math.min(1000000, crashProgress.errors + 1) })
  // Do not print arbitrary native errors, arguments or raw session content.
  const refused = error instanceof transport.ErrDialogMaybeOpen ? 'ErrDialogMaybeOpen'
    : error instanceof transport.ErrInvalidFlags ? 'ErrInvalidFlags'
    : error instanceof transport.ErrSendKeysWhileRelayed ? 'ErrSendKeysWhileRelayed'
    : error instanceof transport.ErrRelayFallenBack ? 'ErrRelayFallenBack' : 'other'
  record('failure', { stage, key: lastKey, errorClass: refused })
  console.error('FAIL: codex-delivery: native evidence incomplete; inspect retained safe observations')
  process.exitCode = 1
} finally {
  // Capture AD state while rows still exist, also for cleanup failures.
  // The shell's shared failure hook emits these only if the final status fails.
  const finalStates = []
  for (const id of liveInstances) {
    try { finalStates.push({ instance: id, ...projectFailureState(await client.get({ instance_id: id })) }) }
    catch { finalStates.push({ instance: id, unavailable: true }) }
  }
  try { writeFileSync(join(paths.root, 'real-final-states.jsonl'), (finalStates.length ? finalStates : [{ unavailable: true }]).map(p => JSON.stringify(p)).join('\n') + '\n', { mode: 0o600 }) }
  catch { console.error('recorded: final AD state retention unavailable') }
  try { await stopEngine() }
  catch { console.error('FAIL: codex-delivery: engine cleanup failed'); process.exitCode = 1 }
  for (const id of liveInstances) {
    try { await client.kill({ instance_id: id }); await retired(id) }
    catch { console.error('FAIL: codex-delivery: native row cleanup failed'); process.exitCode = 1 }
  }
  try { await client.close() }
  catch { console.error('FAIL: codex-delivery: transport cleanup failed'); process.exitCode = 1 }
  try { authContract('final'); console.log('recorded: codex-auth-symlink true') }
  catch { console.error('FAIL: codex-delivery: scratch auth/config lifecycle contract failed'); process.exitCode = 1 }
}
