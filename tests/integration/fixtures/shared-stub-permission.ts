/** Shared-mode controls for the existing registered-hook stub, image only.
 * setup <work> selects displayed-states BEFORE that worker is launched.
 * permission-1|permission-2 <work> <key> queues each permission once/session.
 * receipt <work> <key> releases one submitted text (displayed-states delays it).
 * outcome <work> <key> <token> reads AD's decision/delivery, never decides it.
 * notice-setup <work> selects ordinary at-once receipts BEFORE launch.
 * notice-end|notice-ended|notice-resume <work> <key> <evidence-file>:
 * graceful sentinel through fresh AD waiting, then verified ended; recheck;
 * or one normal AD resume, verified waiting in the SAME conversation.
 * Requires applied automatic restarts off and the exact configured scratch
 * work/key. Evidence is exclusive, metadata only, and never authorizes retry.
 * Resume selects at-once to avoid replaying displayed-state controls retained
 * for that conversation. Do permission phases before this notice/recovery leg.
 * All control paths, including the stub's hook TMPDIR, are fenced to scratch.
 * HOME and AD's real image store stay unchanged. No pane or store writes.
 * 30 s process deadline; 5 s AD calls; metadata-only stdout, redacted failure.
 */
import { existsSync, realpathSync, lstatSync, readFileSync, openSync, closeSync, fstatSync, readSync, writeSync, constants } from 'node:fs'
import { join, resolve, sep } from 'node:path'

if (!existsSync('/etc/cscb-ci-image')) {
  console.error('FAIL: shared-stub-permission: refused outside the CI image')
  process.exit(2)
}

function requireFact(value: unknown): asserts value {
  if (!value) throw new Error('shared stub prerequisite or binding failed')
}
function scratchPath(root: string, path: string, directory = false): string {
  requireFact(resolve(path).startsWith(root + sep))
  const parent = realpathSync(directory ? path : join(path, '..'))
  requireFact(parent.startsWith(root + sep) || (!directory && parent === root))
  if (existsSync(path)) {
    const st = lstatSync(path)
    requireFact(!st.isSymbolicLink() && (directory ? st.isDirectory() : st.isFile()))
  } else requireFact(!directory)
  return path
}
function boundedText(path: string, absent = false): string {
  if (absent && !existsSync(path)) return ''
  const fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW)
  try {
    const st = fstatSync(fd)
    requireFact(st.isFile() && st.size <= 1024 * 1024)
    const bytes = Buffer.alloc(st.size)
    requireFact(readSync(fd, bytes, 0, bytes.length, 0) === bytes.length)
    return bytes.toString('utf8')
  } finally { closeSync(fd) }
}
function appendControl(path: string, text: string): void {
  const fd = openSync(path, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NONBLOCK | constants.O_NOFOLLOW, 0o600)
  try {
    requireFact(fstatSync(fd).isFile() && fstatSync(fd).size < 1024 * 1024)
    requireFact(writeSync(fd, text) === Buffer.byteLength(text))
  } finally { closeSync(fd) }
}
function writeNoticeEvidence(path: string, value: object, exclusive = false): void {
  const fd = openSync(path, constants.O_WRONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW |
    (exclusive ? constants.O_CREAT | constants.O_EXCL : 0), 0o600)
  try {
    requireFact(fstatSync(fd).isFile() && fstatSync(fd).size < 1024 * 1024)
    // Append a small operation journal. An interrupted action stays requested;
    // neither it nor a previous successful action may be submitted twice.
    const text = JSON.stringify(value) + '\n'
    requireFact(writeSync(fd, text, fstatSync(fd).size, 'utf8') === Buffer.byteLength(text))
  } finally { closeSync(fd) }
}
type NoticeClient = Pick<import('agent-director').Client, 'get' | 'sendKeys' | 'resume'>
async function noticeControl(client: NoticeClient, command: string, id: string, key: string, work: string,
  evidence: string, modes: string, stubText: string, bound: (row: Awaited<ReturnType<NoticeClient['get']>>) => void) {
  const read = async () => { const row = await client.get({ instance_id: id }); bound(row); return row }
  const first = await read()
  const clean = (row: typeof first) => requireFact(row.permission_requests.length === 0 && row.unproven_requests.length === 0)
  const identity = { instance_id: id, session_id: first.session_id, key, work }
  const save = (phase: string, row: typeof first, exclusive = false) =>
    writeNoticeEvidence(evidence, { ...identity, phase, state: row.state, last_seen_at: row.last_seen_at }, exclusive)
  if (command === 'notice-end') {
    requireFact(first.state === 'waiting'); clean(first)
    requireFact(!existsSync(evidence))
    // Take the literal from the verified fixture, not a second sentinel spelling.
    const sentinel = /^SENTINEL="([^"\r\n]+)"$/m.exec(stubText)?.[1]
    requireFact(sentinel)
    const fresh = await read()
    requireFact(fresh.state === 'waiting'); clean(fresh)
    save('end-requested', fresh, true)
    await client.sendKeys({ instance_id: id, text: sentinel })
  } else {
    const journal = boundedText(evidence)
    requireFact(journal.endsWith('\n'))
    const events = journal.trim().split('\n').map(line => JSON.parse(line))
    requireFact(events.length === 2 && events[0].phase === 'end-requested' && events[1].phase === 'ended')
    requireFact(events[0].state === 'waiting' && events[1].state === 'ended' &&
      events[1].last_seen_at === first.last_seen_at)
    requireFact(events.every(event => event.instance_id === id && event.session_id === first.session_id &&
      event.key === key && event.work === work))
    requireFact(first.state === 'ended'); clean(first)
    if (command === 'notice-ended') { console.log(JSON.stringify({ ...identity, state: first.state })); return }
    requireFact(command === 'notice-resume')
    // Displayed-state commands start reading at zero on resume. Keep their
    // evidence intact, but select ordinary receipts so no permission replays.
    appendControl(modes, 'at-once\t' + work + '\n')
    const fresh = await read()
    requireFact(fresh.state === 'ended' && fresh.last_seen_at === first.last_seen_at); clean(fresh)
    save('resume-requested', fresh)
    // AD owns the launch and refuses any still-held/conflicting session. Any
    // error (including an uncertain create) fails without automatic retry.
    await client.resume({ instance_id: id })
  }
  const wanted = command === 'notice-end' ? 'ended' : 'waiting'
  const deadline = Date.now() + 20000
  do {
    const row = await read()
    if (row.state === wanted) {
      clean(row)
      save(command === 'notice-end' ? 'ended' : 'resumed', row)
      console.log(JSON.stringify({ ...identity, state: row.state }))
      return
    }
    requireFact(command === 'notice-end' ? row.state === 'waiting' : ['ended', 'pending'].includes(row.state))
    await Bun.sleep(100)
  } while (Date.now() < deadline)
  throw new Error('notice worker transition not observed')
}
async function run() {
  const [binArg, command, workArg, key, token] = process.argv.slice(2)
  requireFact(binArg && workArg && ['setup', 'permission-1', 'permission-2', 'receipt', 'outcome',
    'notice-setup', 'notice-end', 'notice-ended', 'notice-resume'].includes(command))
  const root = realpathSync(process.env.SCENARIO_ROOT!)
  const bin = realpathSync(scratchPath(root, binArg, true))
  const work = realpathSync(scratchPath(root, workArg, true))
  const tmp = realpathSync(scratchPath(root, process.env.TMPDIR!, true))
  requireFact(tmp.startsWith(root + sep))
  const stub = scratchPath(root, join(bin, 'claude'))
  const stubText = boundedText(stub)
  requireFact(stubText === readFileSync(join(import.meta.dir, 'stub-claude.sh'), 'utf8'))
  const modes = scratchPath(root, join(bin, 'stub-claude-modes'))
  if (command === 'setup' || command === 'notice-setup') {
    requireFact(!key && !/[\r\n\t]/.test(work))
    const mode = command === 'setup' ? 'displayed-states' : 'at-once'
    appendControl(modes, mode + '\t' + work + '\n')
    console.log(JSON.stringify({ mode, work }))
    return
  }
  requireFact(key && /^[a-z0-9_]+$/.test(key))
  const selected = boundedText(modes).split('\n').filter(line => line.split('\t')[1] === work).at(-1)
  const notice = command.startsWith('notice-')
  if (notice) requireFact(process.argv.slice(2).length === 5)
  requireFact(selected === 'displayed-states\t' + work || (notice && selected === 'at-once\t' + work))
  const pkg = process.env.CSCB_PKG_DIR ?? '/test-repo/node_modules/claude-slack-channel-bots'
  const { personaInstanceId } = await import(join(pkg, 'src/persona-identity.ts'))
  if (notice) {
    const stateDir = scratchPath(root, process.env.SLACK_STATE_DIR!, true)
    const configPath = scratchPath(root, join(stateDir, 'config.json'))
    const recordPath = scratchPath(root, join(stateDir, 'config.json.last-applied'))
    const { parseSharedChannelState, sharedAppliedConfig } = await import(join(pkg, 'src/shared-channels.ts'))
    const state = parseSharedChannelState(Buffer.from(boundedText(recordPath)), recordPath, { sourcePath: configPath })
    requireFact(state)
    const applied = sharedAppliedConfig(state, configPath)
    requireFact(applied.session_restart_delay === 0 && applied.personas.some((p: any) =>
      p.key === key && realpathSync(p.working_directory) === work))
    requireFact(token && !resolve(token).startsWith(realpathSync(stateDir) + sep))
    scratchPath(root, token)
    const evidenceParent = realpathSync(join(token, '..')), realState = realpathSync(stateDir)
    requireFact(evidenceParent !== realState && !evidenceParent.startsWith(realState + sep))
  }
  const { Client } = await import(import.meta.resolve('agent-director', join(pkg, 'src/agent-director-client.ts')))
  const client = await Client.create({ createIfMissing: false, callTimeoutMs: 5000,
    logger: { debug() {}, info() {}, warn() {}, error() {} } })
  try {
    const id = personaInstanceId(key)
    const first = await client.get({ instance_id: id })
    const session = first.session_id
    requireFact(/^[a-f0-9-]{36}$/.test(session))
    const bind = (row: typeof first) => {
      requireFact(row.instance_id === id && row.session_id === session && row.agent === 'claude' &&
        row.labels.persona === key && row.labels.service === 'cscb' && realpathSync(row.cwd) === work &&
        (notice || !['pending', 'missing', 'ended'].includes(row.state)))
      return row
    }
    bind(first)
    const transcript = boundedText(first.jsonl_path)
    requireFact(transcript.split('\n').filter(Boolean).some(line => {
      const row = JSON.parse(line)
      return row.type === 'summary' && row.summary === 'stub-claude session' && row.leafUuid === session
    }))
    if (notice) {
      // Stub transcript convention is fixture identity evidence, never a source
      // of readiness. Preserve AD's actual reference and same session on resume.
      const expected = join(process.env.HOME!, '.claude', 'projects', work.replace(/[/._]/g, '-'), session + '.jsonl')
      requireFact(realpathSync(first.jsonl_path) === realpathSync(expected))
      await noticeControl(client, command, id, key, work, token!, modes, stubText, row => {
        bind(row)
        requireFact(row.jsonl_path === first.jsonl_path)
      })
      return
    }
    if (command === 'outcome') {
      requireFact(token)
      const result = await client.getPermission({ request_token: token })
      // A token must first have been observed for this exact scratch session.
      const observed = scratchPath(root, join(bin, `stub-claude-hooks.${session}.observed`))
      requireFact(boundedText(observed).split('\n').includes(token))
      bind(await client.get({ instance_id: id }))
      console.log(JSON.stringify({ instance_id: id, session_id: session, request_token: token,
        decision: result.decision, delivery: result.delivery }))
      return
    }
    requireFact(!token)
    const control = scratchPath(root, join(bin, `stub-claude-hooks.${session}`))
    const record = scratchPath(root, control + '.jsonl')
    const observed = scratchPath(root, control + '.observed')
    for (const n of ['1', '2']) for (const suffix of ['out', 'err']) scratchPath(root, `${control}.${n}.${suffix}`)
    const commands = boundedText(control, true).split('\n').filter(Boolean)
    if (command !== 'receipt') requireFact(!commands.includes(command))
    const records = () => boundedText(record, true).split('\n').filter(Boolean).map(line => JSON.parse(line))
    const prior = records().filter(r => r.command === command).length
    const deadline = Date.now() + 20000
    if (command === 'receipt') {
      // A durable queue ACK can precede typing. Wait for this stub's recorded
      // submission, never a pane. A previously queued, unobserved release is
      // not retried: it might still execute.
      requireFact(commands.filter(c => c === 'receipt').length === prior)
      while (records().filter(r => r.command === 'submitted').length <= prior) {
        requireFact(Date.now() < deadline)
        bind(await client.get({ instance_id: id }))
        await Bun.sleep(100)
      }
    }
    bind(await client.get({ instance_id: id }))
    appendControl(control, command + '\n')
    do {
      const events = records().filter(r => r.command === command)
      requireFact(events.length <= prior + 1)
      const row = bind(await client.get({ instance_id: id }))
      if (events.length === prior + 1) {
        requireFact(events.at(-1).instance_id === id && events.at(-1).session_id === session)
        if (command === 'receipt') {
          console.log(JSON.stringify({ instance_id: id, session_id: session, command, state: row.state }))
          return
        }
        const requests = row.permission_requests.filter((r: any) => JSON.parse(r.tool_input).command === `printf fixture-${command.slice(-1)}`)
        if (requests.length === 1) {
          const request = requests[0]
          appendControl(observed, request.request_token + '\n')
          console.log(JSON.stringify({ instance_id: id, session_id: session, command, request_token: request.request_token, delivery: request.delivery }))
          return
        }
        requireFact(requests.length === 0)
      }
      await Bun.sleep(100)
    } while (Date.now() < deadline)
    throw new Error('registered hook not observed')
  } finally { await client.close() }
}

const watchdog = setTimeout(() => { console.error('FAIL: shared-stub-permission: overall deadline'); process.exit(1) }, 30000)
try { await run() }
catch { console.error('FAIL: shared-stub-permission: prerequisites, session binding or registered hook evidence failed'); process.exitCode = 1 }
finally { clearTimeout(watchdog) }
