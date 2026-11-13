/** Shared-mode controls for the existing registered-hook stub, image only.
 * setup <work> selects displayed-states BEFORE that worker is launched.
 * permission-1|permission-2 <work> <key> queues each permission once/session.
 * receipt <work> <key> releases one submitted text (displayed-states delays it).
 * outcome <work> <key> <token> reads AD's decision/delivery, never decides it.
 * complete-1|complete-2 <work> <key> <token>, once AD reads that observed
 * request allow/delivered: ends the allowed turn through the registered Stop
 * hook, from a later whole second than AD recorded the request, and waits for
 * AD itself to read waiting. Once per session, no retry.
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
 * 30 s process deadline; 5 s AD calls; metadata-only stdout, redacted failure
 * naming only a fixed step label and the last bound row's state, then one
 * metadata line of fixed labels, command, key, counts and times.
 * notice-resume also accepts the same-session row a server start already
 * resumed, without resuming it again.
 */
import { existsSync, realpathSync, lstatSync, readFileSync, openSync, closeSync, fstatSync, readSync, writeSync, constants } from 'node:fs'
import { join, resolve, sep } from 'node:path'

if (!existsSync('/etc/cscb-ci-image')) {
  console.error('FAIL: shared-stub-permission: refused outside the CI image')
  process.exit(2)
}

// The redacted failure line's fixed step label and last bound AD row state.
let failureStep = 'prerequisites'
let failureState: string | undefined
// Observer-only failure metadata: fixed labels, validated commands and keys,
// counts and times. Never pane text, message contents or tokens.
let failureFacts: Record<string, string | number> = {}

function requireFact(value: unknown): asserts value {
  if (!value) throw new Error('shared stub prerequisite or binding failed')
}
function noticeFact(check: string, value: unknown): asserts value {
  failureFacts.check = check
  requireFact(value)
}
function failureMetadata(): string | undefined {
  if (!Object.keys(failureFacts).length) return undefined
  const fields = Object.entries({ ...failureFacts, ad_state: failureState ?? 'unknown' })
  return 'shared-stub-permission: failure metadata ' + fields.map(([name, value]) => `${name}=${typeof value === 'number'
    ? (Number.isFinite(value) ? value : 'invalid') : /^[a-z0-9_.:-]{1,64}$/.test(value) ? value : 'invalid'}`).join(' ')
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
  const read = async () => {
    failureFacts.check = 'ad-read'
    const row = await client.get({ instance_id: id }); bound(row); return row
  }
  const first = await read()
  const clean = (row: typeof first) => noticeFact('clean-requests', row.permission_requests.length === 0 && row.unproven_requests.length === 0)
  const identity = { instance_id: id, session_id: first.session_id, key, work }
  const save = (phase: string, row: typeof first, exclusive = false) =>
    writeNoticeEvidence(evidence, { ...identity, phase, state: row.state, last_seen_at: row.last_seen_at }, exclusive)
  let startupResumed = false
  if (command === 'notice-end') {
    noticeFact('end-waiting', first.state === 'waiting'); clean(first)
    noticeFact('evidence-absent', !existsSync(evidence))
    // Take the literal from the verified fixture, not a second sentinel spelling.
    const sentinel = /^SENTINEL="([^"\r\n]+)"$/m.exec(stubText)?.[1]
    noticeFact('sentinel', sentinel)
    const fresh = await read()
    noticeFact('end-fresh-waiting', fresh.state === 'waiting'); clean(fresh)
    save('end-requested', fresh, true)
    failureFacts.check = 'send-keys'
    await client.sendKeys({ instance_id: id, text: sentinel })
  } else {
    failureFacts.check = 'journal-read'
    const journal = boundedText(evidence)
    noticeFact('journal-shape', journal.endsWith('\n'))
    const events = journal.trim().split('\n').map(line => JSON.parse(line))
    noticeFact('journal-shape', events.length === 2 && events[0].phase === 'end-requested' && events[1].phase === 'ended')
    noticeFact('journal-states', events[0].state === 'waiting' && events[1].state === 'ended')
    noticeFact('journal-identity', events.every(event => event.instance_id === id && event.session_id === first.session_id &&
      event.key === key && event.work === work))
    const stillEnded = first.state === 'ended' && events[1].last_seen_at === first.last_seen_at
    if (command === 'notice-ended') {
      noticeFact('ended-state', stillEnded); clean(first)
      console.log(JSON.stringify({ ...identity, state: first.state })); return
    }
    noticeFact('notice-command', command === 'notice-resume')
    if (first.state === 'ended') {
      noticeFact('ended-state', stillEnded); clean(first)
      // Displayed-state commands start reading at zero on resume. Keep their
      // evidence intact, but select ordinary receipts so no permission replays.
      appendControl(modes, 'at-once\t' + work + '\n')
      const fresh = await read()
      noticeFact('resume-fresh-ended', fresh.state === 'ended' && fresh.last_seen_at === first.last_seen_at); clean(fresh)
      save('resume-requested', fresh)
      // AD owns the launch and refuses any still-held/conflicting session. Any
      // error (including an uncertain create) fails without automatic retry.
      failureFacts.check = 'resume-call'
      await client.resume({ instance_id: id })
    } else {
      // A server start resumes an ended row itself, in the same conversation
      // (bound above). Observe that launch to waiting; never resume it again.
      // Its stub must already run ordinary receipts, or controls would replay.
      startupResumed = true
      const selected = boundedText(modes).split('\n').filter(line => line.split('\t')[1] === work).at(-1)
      noticeFact('startup-resume-mode', selected === 'at-once\t' + work)
      noticeFact('startup-resume-state', first.state === 'pending' ||
        (['working', 'waiting'].includes(first.state) && first.last_seen_at !== events[1].last_seen_at))
      clean(first)
    }
  }
  const wanted = command === 'notice-end' ? 'ended' : 'waiting'
  const passing = command === 'notice-end' ? ['waiting'] : startupResumed ? ['pending', 'working'] : ['ended', 'pending']
  // One last read at the deadline, so a transition during the final sleep is
  // seen rather than reported as unobserved.
  const deadline = Date.now() + 20000
  let last: boolean
  do {
    last = Date.now() >= deadline
    const row = await read()
    if (row.state === wanted) {
      clean(row)
      save(command === 'notice-end' ? 'ended' : 'resumed', row)
      console.log(JSON.stringify({ ...identity, state: row.state }))
      return
    }
    noticeFact('transition-state', passing.includes(row.state))
    if (!last) await Bun.sleep(100)
  } while (!last)
  failureFacts.check = 'transition-timeout'
  throw new Error('notice worker transition not observed')
}
async function run() {
  failureStep = 'prerequisites'
  failureState = undefined
  failureFacts = {}
  const [binArg, command, workArg, key, token] = process.argv.slice(2)
  requireFact(binArg && workArg && ['setup', 'permission-1', 'permission-2', 'receipt', 'outcome',
    'complete-1', 'complete-2', 'notice-setup', 'notice-end', 'notice-ended', 'notice-resume'].includes(command))
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
    failureStep = 'notice prerequisites'
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
  failureStep = 'agent-director client'
  const { Client } = await import(import.meta.resolve('agent-director', join(pkg, 'src/agent-director-client.ts')))
  const client = await Client.create({ createIfMissing: false, callTimeoutMs: 5000,
    logger: { debug() {}, info() {}, warn() {}, error() {} } })
  try {
    const id = personaInstanceId(key)
    failureStep = 'session binding'
    const first = await client.get({ instance_id: id })
    const session = first.session_id
    requireFact(/^[a-f0-9-]{36}$/.test(session))
    const bind = (row: typeof first) => {
      failureState = typeof row?.state === 'string' && /^[a-z_]{1,32}$/.test(row.state) ? row.state : 'invalid'
      requireFact(row.instance_id === id && row.session_id === session && row.agent === 'claude' &&
        row.labels.persona === key && row.labels.service === 'cscb' && realpathSync(row.cwd) === work &&
        (notice || !['pending', 'missing', 'ended'].includes(row.state)))
      return row
    }
    bind(first)
    failureStep = 'transcript identity'
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
      failureStep = 'notice control'
      failureFacts = { command, key }
      await noticeControl(client, command, id, key, work, token!, modes, stubText, row => {
        bind(row)
        requireFact(row.jsonl_path === first.jsonl_path)
      })
      return
    }
    if (command === 'outcome') {
      failureStep = 'permission outcome'
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
    const complete = command.startsWith('complete-')
    failureStep = 'hook control files'
    requireFact(complete ? token : !token)
    const control = scratchPath(root, join(bin, `stub-claude-hooks.${session}`))
    const record = scratchPath(root, control + '.jsonl')
    const observed = scratchPath(root, control + '.observed')
    for (const n of ['1', '2']) for (const suffix of ['out', 'err']) scratchPath(root, `${control}.${n}.${suffix}`)
    const commands = boundedText(control, true).split('\n').filter(Boolean)
    if (command !== 'receipt') requireFact(!commands.includes(command))
    const records = () => boundedText(record, true).split('\n').filter(Boolean).map(line => JSON.parse(line))
    // Each read keeps only record counts, its time and the last record's time.
    const observe = () => {
      const all = records(), at = all.at(-1)?.at
      Object.assign(failureFacts, { submitted: all.filter(r => r.command === 'submitted').length,
        receipt: all.filter(r => r.command === 'receipt').length, records_read_at: Date.now(),
        last_record_at: at === undefined ? 'absent' : typeof at === 'string' && /^\d{1,12}(\.\d{1,9})?$/.test(at) ? at : 'invalid' })
      return all
    }
    const prior = records().filter(r => r.command === command).length
    failureFacts = { command, prior, bound: 'submission', deadline_ms: 20000 }
    const waitStarted = Date.now(), deadline = waitStarted + 20000
    if (command === 'receipt') {
      // A durable queue ACK can precede typing. Wait for this stub's recorded
      // submission, never a pane. A previously queued, unobserved release is
      // not retried: it might still execute.
      requireFact(commands.filter(c => c === 'receipt').length === prior)
      failureStep = 'receipt: no submitted record'
      while (observe().filter(r => r.command === 'submitted').length <= prior) {
        failureFacts.elapsed_ms = Date.now() - waitStarted
        requireFact(Date.now() < deadline)
        bind(await client.get({ instance_id: id }))
        failureFacts.ad_read_at = Date.now()
        await Bun.sleep(100)
      }
    }
    if (complete) {
      // Only this session's observed request, decided allow and delivered to
      // its registered hook, may end the simulated turn.
      failureStep = 'completion permission'
      requireFact(commands.includes(`permission-${command.slice(-1)}`))
      requireFact(boundedText(observed).split('\n').includes(token!))
      const result = await client.getPermission({ request_token: token })
      requireFact(result.request_token === token && result.decision === 'allow' && result.delivery === 'delivered' &&
        JSON.parse(result.tool_input).command === `printf fixture-${command.slice(-1)}`)
      // AD's Stop proves a request's dialog gone only when the request was
      // recorded in an earlier whole second than the hook started (its turn-end
      // cut). A Stop in that same second leaves it unproven, and AD refuses
      // every later send-keys to this worker (ErrDialogMaybeOpen).
      const recorded = Date.parse(result.requested_at)
      requireFact(Number.isFinite(recorded))
      const later = Math.floor(recorded / 1000) * 1000 + 1000
      while (Date.now() < later) await Bun.sleep(later - Date.now())
    }
    // A completion's waiting must follow its Stop, never precede it.
    failureStep = 'control append'
    requireFact(!complete || bind(await client.get({ instance_id: id })).state !== 'waiting')
    bind(await client.get({ instance_id: id }))
    appendControl(control, command + '\n')
    failureStep = 'registered hook evidence'
    // The appended control's evidence has its own bound, not what the
    // submission wait left. One last pass after it expires reads the records
    // again, so one written during the final AD read or sleep is not missed.
    const started = Date.now(), observeBy = started + 20000
    Object.assign(failureFacts, { bound: 'observation', elapsed_ms: 0 })
    let last: boolean
    do {
      last = Date.now() >= observeBy
      const events = observe().filter(r => r.command === command)
      requireFact(events.length <= prior + 1)
      const row = bind(await client.get({ instance_id: id }))
      Object.assign(failureFacts, { ad_read_at: Date.now(), elapsed_ms: Date.now() - started })
      if (events.length === prior + 1) {
        requireFact(events.at(-1).instance_id === id && events.at(-1).session_id === session)
        if (command === 'receipt') {
          console.log(JSON.stringify({ instance_id: id, session_id: session, command, state: row.state }))
          return
        }
        if (complete) {
          requireFact(events.at(-1).event === 'Stop')
          if (row.state === 'waiting') {
            console.log(JSON.stringify({ instance_id: id, session_id: session, command, request_token: token, state: row.state }))
            return
          }
        } else {
          const requests = row.permission_requests.filter((r: any) => JSON.parse(r.tool_input).command === `printf fixture-${command.slice(-1)}`)
          if (requests.length === 1) {
            const request = requests[0]
            appendControl(observed, request.request_token + '\n')
            console.log(JSON.stringify({ instance_id: id, session_id: session, command, request_token: request.request_token, delivery: request.delivery }))
            return
          }
          requireFact(requests.length === 0)
        }
      }
      if (!last) await Bun.sleep(100)
    } while (!last)
    throw new Error('registered hook not observed')
  } finally { await client.close() }
}

const watchdog = setTimeout(() => {
  console.error(`FAIL: shared-stub-permission: overall deadline (step=${failureStep} state=${failureState ?? 'unknown'})`)
  const metadata = failureMetadata(); if (metadata) console.error(metadata)
  process.exit(1)
}, 30000)
try { await run() }
catch {
  // Fixed labels and a validated row state only: never a raw client error.
  console.error(`FAIL: shared-stub-permission: prerequisites, session binding or registered hook evidence failed (step=${failureStep} state=${failureState ?? 'unknown'})`)
  const metadata = failureMetadata(); if (metadata) console.error(metadata)
  process.exitCode = 1
}
finally { clearTimeout(watchdog) }
