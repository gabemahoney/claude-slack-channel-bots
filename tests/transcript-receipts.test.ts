/** Synthetic controls for real-scenario accounting; no native agent or credentials. */
import { afterEach, expect, test } from 'bun:test'
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import * as fs from 'node:fs'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createDeliveryQueue, type AcceptedInput, type QueueItem } from '../src/delivery-queue.ts'
import { parseDeliveryTranscriptRecord, receiptTextMatches } from '../src/delivery-receipt.ts'
import { createReplyReminders, REPLY_REMINDER_TEXT } from '../src/reply-reminder.ts'
import { createFakeClock } from './test-helpers/fake-clock.ts'
import { hostSafeChildEnv } from './test-helpers/host-safe-env.ts'
import { assertNoLeak } from './test-helpers/credentials.ts'
import { injectedInput, slackInput } from './test-helpers/delivery-queue.ts'
import { cannedGetResult } from './test-helpers/agent-director-stub.ts'
import { makeMultiPersonaConfig } from './test-helpers/persona-config.ts'
import { promptEntry } from './test-helpers/working-row-panes.ts'
import { auditReceipts, deliveryFailureEvidence, jsonLines, readTranscripts, receiptJournal, receiptProgress, workloadItem, workloadItems } from './integration/fixtures/transcript-receipts.ts'
import { checkAc76Admission, type AdmissionAdapters, type AdmissionOptions } from './integration/fixtures/ac76-admission.ts'
import { runFixture, runRealSlice, runTest33Slice, SITE_SLICES, type RealSlice, type Site, type Test33Leg, type Test33Result } from './test-helpers/test33-receipt-boundary.ts'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup() })
type SendKind = 'text' | 'enter' | 'retype'
/** Durable attempt offsets for test33's key-fault legs. `fault` names the
 * injected shim outcome consumed by the attempt at that offset; reset adds its
 * guarded delayed Enter and the relaunch's first AD waiting observation. */
const plans = {
  plain: { stages: [[10, 'text']] },
  retype: { stages: [[10, 'text'], [10010, 'retype']], fault: [10, 'swallow'] },
  'unknown-typed': { stages: [[10, 'text'], [10010, 'enter']], fault: [10, 'unknown-typed'] },
  'unknown-untyped': { stages: [[10, 'text'], [10010, 'retype']], fault: [10, 'unknown-untyped'] },
  reset: { stages: [[10, 'text'], [20500, 'retype'], [81000, 'retype'], [101000, 'enter'],
    [111000, 'retype'], [141500, 'enter'], [171500, 'retype']], fault: [111000, 'swallow'], waiting: 100000 },
  'reset missing retype': { stages: [[10, 'text'], [20500, 'retype'], [81000, 'retype'], [101000, 'enter'],
    [111000, 'retype'], [141500, 'enter']], fault: [111000, 'swallow'], waiting: 100000 },
} satisfies Record<string, { stages: [number, SendKind][]; fault?: [number, string]; waiting?: number }>
type Plan = keyof typeof plans
async function fixture(seed = true, projects = false) {
  const stateDir = mkdtempSync(join(tmpdir(), 'reminder-receipts-'))
  let now = 1000
  const queue = createDeliveryQueue({ stateDir, now: () => now })
  cleanups.push(async () => { await queue.stop(); rmSync(stateDir, { recursive: true, force: true }) })
  await queue.start()
  // test33 slices find transcripts under the scenario's HOME/.claude/projects.
  const transcriptDir = projects ? join(stateDir, '.claude/projects/work') : stateDir
  mkdirSync(transcriptDir, { recursive: true })
  const transcript = join(transcriptDir, 'session.jsonl'), shimLog = join(stateDir, 'shim.log'), journal = join(stateDir, 'queue/alpha.jsonl')
  const takes: object[] = [], calls: string[] = [], lines: string[] = []
  const adapters = { parseDeliveryTranscriptRecord, receiptTextMatches }
  const persona = makeMultiPersonaConfig([{ name: 'alpha' }], stateDir).personas[0]!
  async function complete(item: QueueItem, plan: Plan = 'plain') {
    const a = item.accepted, seq = a.seq, text = `<channel seq="${seq}">${a.text}</channel>`
    const diagnostic = (kind: string) => `[${new Date(now).toISOString()}] [slack] ${kind}: persona="alpha" (key=alpha) source=${a.source} ${a.source === 'slack' ? 'chat_id' : 'sender'}=${JSON.stringify(a.channel ?? a.sender)} ts=${JSON.stringify(a.ts)} sender_id=${JSON.stringify(a.user ?? a.sender)}`
    if (a.reminder_for === undefined) lines.push(diagnostic('message-received'))
    await queue.append('alpha', { v: 1, kind: 'fixed', seq, parts: [text] })
    const base = now, { stages, fault, waiting } = plans[plan] as { stages: [number, SendKind][]; fault?: [number, string]; waiting?: number }
    for (const [attempt, [offset, send_kind]] of stages.entries()) {
      now = base + offset
      await queue.append('alpha', { v: 1, kind: 'sent', seq, part: 1, attempt: attempt + 1, send_kind, at: now, session_id: 'session', transcript_path: transcript, transcript_size: 0 })
      const words = send_kind === 'enter' ? '--key Enter'
        : `--text ${text.replace(/[^a-zA-Z0-9]/g, c => '\\' + c)} --no-enter`
      calls.push(`call\t${now / 1000}\t${seq}-${attempt}\t1\tbun\tsend-keys --instance-id cscb_alpha ${words}`)
      if (fault?.[0] === offset) {
        calls.push(`fault\t${now / 1000}\t${seq}-${attempt}\t1\tbun\tsend-keys no_enter ${fault[1]}`)
        // A swallowed text still receives its guarded delayed Enter.
        if (fault[1] === 'swallow') calls.push(`call\t${(now + 500) / 1000}\t${seq}-delayed\t1\tbun\tsend-keys --instance-id cscb_alpha --key Enter`)
      }
    }
    if (waiting !== undefined) lines.push('[slack] delivery-launch-first-waiting: ' + JSON.stringify({ key: 'alpha', session_id: 'session', at: base + waiting }))
    now += 10
    takes.push({ ...promptEntry(text), uuid: `take-${seq}`, sessionId: 'session', timestamp: new Date(now).toISOString() })
    await queue.append('alpha', { v: 1, kind: 'delivered', seq, part: 1, at: now, receipt: { path: transcript, uuid: `take-${seq}` } })
    lines.push(diagnostic('message-delivered'))
    now += 10
    writeFileSync(transcript, takes.map(r => JSON.stringify(r)).join('\n') + '\n')
    writeFileSync(shimLog, calls.join('\n') + '\n')
    writeFileSync(join(stateDir, 'server.log'), lines.join('\n') + '\n')
  }
  /** A second exact take-in of a delivered item, as AC106 types it through AD
   * rather than CSCB: no durable or shim record. */
  function duplicate(item: QueueItem) {
    now += 10
    takes.push({ ...promptEntry(`<channel seq="${item.accepted.seq}">${item.accepted.text}</channel>`), uuid: `copy-${item.accepted.seq}`, sessionId: 'session', timestamp: new Date(now).toISOString() })
    now += 10
    writeFileSync(transcript, takes.map(r => JSON.stringify(r)).join('\n') + '\n')
  }
  async function send(input: AcceptedInput, plan: Plan = 'plain') {
    const result = await queue.accept('alpha', input)
    if (result.status !== 'accepted' || !result.item) throw new Error('fixture acceptance failed')
    await complete(result.item, plan)
    return result.item
  }
  if (seed) {
    await send(slackInput())
    await queue.observeReplyReminders('alpha', cannedGetResult({ state: 'working', session_id: 'session' }, persona, stateDir), REPLY_REMINDER_TEXT, true, () => true)
    const [reminder] = await queue.observeReplyReminders('alpha', cannedGetResult({ state: 'waiting', session_id: 'session' }, persona, stateDir), REPLY_REMINDER_TEXT, true, () => true)
    if (!reminder) throw new Error('fixture reminder missing')
    await complete(reminder)
    await send(slackInput({ ts: '1700000000.000002', key: { chat_id: 'C0TEST001', ts: '1700000000.000002' } }))
    await send(injectedInput())
    await send(injectedInput({ source: 'cron' }))
  }
  const options = { stateDir, key: 'alpha', shimLog, transcripts: [transcript], expectedCount: 4 }
  const entries = () => readTranscripts([transcript], adapters)
  return { queue, journal, transcript, shimLog, options, adapters, entries, send, complete, duplicate, persona, now: () => now,
    audit: () => auditReceipts(options, entries(), adapters) }
}

function admissionFor(h: Awaited<ReturnType<typeof fixture>>, row = cannedGetResult(
  { state: 'waiting', session_id: 'session' }, h.persona, h.options.stateDir,
)) {
  const log = join(h.options.stateDir, 'server.log')
  const connection = '[slack] Session connected: persona "alpha" (key=alpha)\n'
  const connect = () => appendFileSync(log, connection)
  connect()
  const options: AdmissionOptions = { ...h.options, scratchDir: h.options.stateDir,
    expectedRow: row, connectionLineBase: 0, now: h.now }
  const adapters: AdmissionAdapters = { createDeliveryQueue, receipts: h.adapters, getRow: async () => row }
  return { options, adapters, row, log, connection, connect,
    check: (overrides: Partial<AdmissionAdapters> = {}) => checkAc76Admission(options, { ...adapters, ...overrides }) }
}

/** Execute test32's real latency loop and shell helpers, stopping at its first
 * DM boundary. Only AD, the receipt CLI transport, and the clock are injected;
 * no scenario startup, native binary, pane or operator state is reachable. */
async function firstLatencyAdmission(home: string, reply: (request: string) => Promise<string>, timeout = false) {
  const read = (path: string) => readFileSync(join(import.meta.dir, 'integration', path), 'utf8')
  const real = read('lib/real-scenario.sh'), scenario = read('lib/scenario.sh')
  const script = read('test-32-fmk-real-order.sh')
  const preceding = script.indexOf('real_wait_delivery "${REAL_KEY}" 33')
  const start = script.indexOf('for n in {1..20}; do', preceding)
  const end = script.indexOf('real_assert_latency', start)
  if (preceding < 0 || start < 0 || end < start) throw new Error('Missing test32 latency loop')
  const functions = (text: string) => [...text.matchAll(/^\w+\(\) \{[\s\S]*?^\}/gm)].map(m => m[0]).join('\n')
  const program = [
    'set -euo pipefail', 'exec 3>&1', 'exec 1>/dev/null',
    // Definitions only: neither scenario source-time setup nor native setup runs.
    functions(real),
    ...['_scenario_poll_until', '_scenario_check_timeout'].map(name => {
      const match = scenario.match(new RegExp(`^${name}\\(\\) \\{[\\s\\S]*?^\\}`, 'm'))
      if (!match) throw new Error(`Missing polling helper ${name}`)
      return match[0]
    }),
    'SCENARIO_ROOT="$HOME"', 'REAL_KEY=alpha', 'REAL_LABEL=alpha',
    'SCENARIO_AD_ROOT="$HOME/ad"', 'REAL_CONNECTION_LINE_BASE=0',
    'REAL_RECEIPTS=receipts', 'SCENARIO_AD_SHIM_LOG="$HOME/shim.log"',
    'REAL_DELIVERY_WAIT_S=3', 'REAL_DELIVERY_MAX_WAIT_S=3', 'SCENARIO_POLL_S=1',
    'bridge() { local answer; printf "%s\\n" "$*" >&3; IFS= read -r answer; printf "%s\\n" "$answer"; }',
    'fail() { printf "%s\\n" "$*" >&2; exit 1; }',
    'real_instance() { echo cscb_alpha; }',
    'real_ad() { bridge ad; }',
    '_scenario_now_ms() { bridge now; }',
    'sleep() { bridge poll >/dev/null; }',
    'bun() { local answer; answer="$(bridge "$2")"; if [[ "$2" == progress ]]; then echo "$answer"; else [[ "$answer" == ok ]]; fi; }',
    'real_dm() { bridge dm >/dev/null; exit 0; }',
    script.slice(start, end),
  ].join('\n')
  const child = spawn('bash', ['-c', program], {
    env: hostSafeChildEnv(home, { tools: ['bash', 'jq'], extras: { SLACK_STATE_DIR: home } }),
    stdio: ['pipe', 'pipe', 'pipe'], timeout: 10000,
  })
  const closed = new Promise<{ code: number | null; signal: string | null }>((resolve, reject) => {
    child.once('error', reject)
    child.once('close', (code, signal) => resolve({ code, signal }))
  })
  let stderr = ''
  child.stderr.on('data', data => { stderr += data })
  try {
    for await (const request of createInterface({ input: child.stdout })) {
      child.stdin.write(`${await reply(request)}\n`)
    }
    const result = await closed
    assertNoLeak(stderr)
    expect(result).toEqual({ code: timeout ? 1 : 0, signal: null })
    expect(stderr).toBe(timeout ? 'AC76 pre-sample admission timed out (see reason codes and counts)\n' : '')
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill()
    await closed
  }
}

test.each(['held observation', 'accepted reminder', 'drained control'] as const)(
  'pre-sample admission waits for prior reminders: %s', async mode => {
    const h = await fixture(false), clock = createFakeClock()
    // Match the real loop's preceding 33 originals; only two need reminders.
    await h.send(slackInput())
    await h.send(slackInput({ ts: '1700000000.000002', key: { chat_id: 'C0TEST001', ts: '1700000000.000002' } }))
    for (let i = 2; i < 33; i++) await h.send(injectedInput())
    h.options.expectedCount = 33
    expect(h.audit()).toMatchObject({ items: 33, reminders: 0 })
    const row = (state: 'working' | 'waiting') => {
      const r = cannedGetResult({ state, session_id: 'session' }, h.persona, h.options.stateDir)
      return { ...r, labels: { ...r.labels, reply_tool_preallowed: '1' } }
    }
    const waiting = row('waiting'), held = Promise.withResolvers<typeof waiting>()
    const admission = admissionFor(h, waiting)
    const entered = Promise.withResolvers<void>(), prepared: QueueItem[] = [], errors: unknown[] = []
    const monitor = createReplyReminders({ queue: h.queue, clock,
      ready: () => true, enabled: () => true,
      getRow: async () => { entered.resolve(); return held.promise },
      prepare: async (_key, item) => { prepared.push(item) },
      onError: (_key, error) => { errors.push(error) },
    })
    let released = false, drained = false, polls = 0
    const release = async () => {
      if (released) return
      released = true
      held.resolve(waiting)
      // Joins the real observer's serialized queue, including its held AD read.
      await monitor.observe('alpha', waiting)
      expect(prepared.map(item => item.accepted.reminder_for)).toEqual([1, 2])
      expect(h.queue.replyReminderItems('alpha')).toHaveLength(0)
      expect(h.queue.openCount('alpha')).toBe(2)
      expect(h.audit).toThrow()
    }
    const drain = async () => {
      if (drained) return
      await release()
      for (const item of prepared) await h.complete(item)
      admission.connect()
      drained = true
      expect(h.audit()).toMatchObject({ items: 33, reminders: 2 })
    }
    try {
      await monitor.observe('alpha', row('working'))
      monitor.wake('alpha')
      await clock.runNext()
      await entered.promise
      expect(h.queue.replyReminderItems('alpha')).toHaveLength(2)
      if (mode !== 'held observation') await release()
      if (mode === 'drained control') await drain()
      const admissions: { candidates: number; open: number; receipts: boolean; freshWaiting: boolean }[] = []
      let freshWaiting = false
      await firstLatencyAdmission(h.options.stateDir, async request => {
        if (request === 'ad') { freshWaiting = drained; return JSON.stringify(waiting) }
        if (request === 'admission') {
          const result = await checkAc76Admission(admission.options, { ...admission.adapters,
            getRow: async () => { freshWaiting = drained; return waiting },
          })
          return result.ready ? 'ok' : 'wait'
        }
        if (request === 'now') return String(polls * 1000)
        if (request === 'poll') {
          polls++
          if (polls === 1) await release()
          else await drain()
          return 'ok'
        }
        const receipts = () => { try { h.audit(); return true } catch { return false } }
        if (request === 'ready') return receipts() ? 'ok' : 'wait'
        if (request === 'progress') return String(receiptProgress(h.options, h.entries(), h.adapters))
        if (request === 'dm') {
          admissions.push({ candidates: h.queue.replyReminderItems('alpha').length,
            open: h.queue.openCount('alpha'), receipts: receipts(), freshWaiting })
          return 'ok'
        }
        throw new Error(`Unexpected test boundary: ${request}`)
      })
      // Even on today's premature admission, prove the held production observer
      // really can enqueue work, and that exact delivery drains it afterwards.
      await drain()
      expect(errors).toEqual([])
      expect(admissions).toEqual([{ candidates: 0, open: 0, receipts: true, freshWaiting: true }])
    } finally {
      held.resolve(waiting)
      await monitor.stop()
    }
  },
)

test('admission replays and compacts only a private copy, then obtains fresh AD waiting', async () => {
  const h = await fixture(false)
  await h.send(injectedInput())
  h.options.expectedCount = 1
  const a = admissionFor(h), bytes = readFileSync(h.journal), files = readdirSync(dirname(h.journal))
  const snapshots: string[] = [], calls: string[] = []
  const result = await a.check({
    getRow: async () => {
      calls.push('ad')
      return { ...a.row, state: calls.length === 1 ? 'working' : 'waiting' }
    },
    createDeliveryQueue: options => {
      snapshots.push(options.stateDir)
      expect(dirname(options.stateDir)).toBe(h.options.stateDir)
      expect(options.stateDir).not.toBe(h.options.stateDir)
      expect(statSync(options.stateDir).mode & 0o777).toBe(0o700)
      expect(statSync(join(options.stateDir, 'queue')).mode & 0o777).toBe(0o700)
      const copy = join(options.stateDir, 'queue/alpha.jsonl')
      expect(statSync(copy).mode & 0o777).toBe(0o600)
      expect(readFileSync(copy)).toEqual(bytes)
      expect(options.now!()).toBe(h.now())
      const queue = createDeliveryQueue(options)
      const forbidden = () => { throw new Error('Admission must only replay and count') }
      return { ...queue,
        start: async () => { calls.push('start'); await queue.start() },
        compact: async key => {
          calls.push('compact'); await queue.compact(key)
          expect(readFileSync(copy).equals(bytes)).toBe(false)
        },
        stop: async () => { calls.push('stop'); await queue.stop() },
        startMaintenance: forbidden, accept: forbidden, append: forbidden,
        observeReplyReminders: forbidden, cancelReplyReminders: forbidden, recordReplyCall: forbidden,
      }
    },
  })
  expect(result).toEqual({ ready: true, reason: 'ready', candidates: 0, open: 0 })
  expect(calls).toEqual(['ad', 'start', 'compact', 'stop', 'ad'])
  expect(snapshots).toHaveLength(1)
  expect(snapshots.every(path => !existsSync(path))).toBe(true)
  expect(readFileSync(h.journal)).toEqual(bytes)
  expect(readdirSync(dirname(h.journal))).toEqual(files)
})

test.each(['torn journal', 'swallowed replay read failure', 'compact failure', 'stop failure'] as const)(
  'admission fails closed and removes its snapshot on %s', async mode => {
    const h = await fixture(false)
    await h.send(injectedInput())
    h.options.expectedCount = 1
    const a = admissionFor(h)
    if (mode === 'torn journal') appendFileSync(h.journal, '{"v":1,"kind":"sent",')
    const bytes = readFileSync(h.journal), files = readdirSync(dirname(h.journal))
    const snapshots: string[] = [], events: string[] = []
    let stopped = 0, started = 0, compacted = 0, failedRead = false
    const result = await a.check({ createDeliveryQueue: options => {
      snapshots.push(options.stateDir)
      const queue = createDeliveryQueue({ ...options,
        onEvent: event => { events.push(event.type); options.onEvent?.(event) },
        ...(mode === 'swallowed replay read failure' ? { fs: { ...fs, readFileSync: ((...args: Parameters<typeof fs.readFileSync>) => {
          if (!failedRead) { failedRead = true; throw new Error('synthetic snapshot read failure') }
          return fs.readFileSync(...args)
        }) as typeof fs.readFileSync } } : {}),
      })
      return { ...queue,
        start: async () => { await queue.start(); started++ },
        compact: async key => {
          if (mode === 'compact failure') throw new Error('synthetic compact failure')
          await queue.compact(key); compacted++
        },
        stop: async () => {
          stopped++; await queue.stop()
          if (mode === 'stop failure') throw new Error('synthetic stop failure')
        },
      }
    } })
    expect(result).toEqual({ ready: false, reason: 'replay-failed', candidates: null, open: null })
    expect(started).toBe(1) // start can resolve even when replay could not read.
    expect(stopped).toBe(1)
    if (mode === 'torn journal') expect(events).toContain('record-unreadable')
    if (mode === 'swallowed replay read failure') {
      expect(events).toContain('recovery-failed')
      expect(compacted).toBe(1) // Later replay succeeds; the recorded failure still closes admission.
    }
    expect(snapshots).toHaveLength(1)
    expect(snapshots.every(path => !existsSync(path))).toBe(true)
    expect(readFileSync(h.journal)).toEqual(bytes)
    expect(readdirSync(dirname(h.journal))).toEqual(files)
    assertNoLeak(JSON.stringify(result))
  },
)

test.each(['replay', 'stop', 'final AD'] as const)('admission rejects journal mutation during awaited %s', async phase => {
  const h = await fixture(false)
  await h.send(injectedInput())
  h.options.expectedCount = 1
  const a = admissionFor(h), entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  const pause = async () => { entered.resolve(); await release.promise }
  let reads = 0
  const pending = a.check({
    getRow: async () => { if (++reads === 2 && phase === 'final AD') await pause(); return a.row },
    createDeliveryQueue: options => {
      const queue = createDeliveryQueue(options)
      return { ...queue,
        start: async () => { await queue.start(); if (phase === 'replay') await pause() },
        stop: async () => { await queue.stop(); if (phase === 'stop') await pause() },
      }
    },
  })
  try {
    await entered.promise
    expect(await h.queue.accept('alpha', injectedInput())).toMatchObject({ status: 'accepted' })
  } finally { release.resolve() }
  expect(await pending).toMatchObject({ ready: false, reason: 'journal-changed' })
  expect(h.queue.openCount('alpha')).toBe(1)
  expect(readdirSync(h.options.stateDir).filter(name => name.startsWith('ac76-queue-'))).toEqual([])
})

test.each(['historical only', 'other persona', 'latest disconnected', 'disconnect during AD', 'reconnect during AD'] as const)(
  'admission requires unchanged own post-cursor connection: %s', async mode => {
    const h = await fixture(false)
    await h.send(injectedInput())
    h.options.expectedCount = 1
    const a = admissionFor(h)
    const disconnect = '[slack] Session disconnected: persona "alpha" (key=alpha)\n'
    if (mode === 'historical only' || mode === 'other persona') {
      a.options.connectionLineBase = readFileSync(a.log, 'utf8').trimEnd().split('\n').length
      if (mode === 'other persona') appendFileSync(a.log, a.connection.replaceAll('alpha', 'beta'))
    }
    if (mode === 'latest disconnected') appendFileSync(a.log, disconnect)
    let reads = 0
    const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
    const pending = a.check({ getRow: async () => {
      if (++reads === 2) { entered.resolve(); await release.promise }
      return a.row
    } })
    const acrossAwait = mode.endsWith('during AD')
    if (acrossAwait) {
      try {
        await entered.promise
        appendFileSync(a.log, disconnect)
        if (mode === 'reconnect during AD') a.connect()
      } finally { release.resolve() }
    }
    expect(await pending).toMatchObject({ ready: false, reason: acrossAwait ? 'connection-changed' : 'connection-unavailable' })
    expect(reads).toBe(acrossAwait ? 2 : 0)
  },
)

test.each([
  ['instance', { instance_id: 'cscb_beta' }], ['session', { session_id: 'other' }],
  ['row start', { started_at: 'other' }], ['launch', { launch_started_at: 'other' }],
  ['tag prompt', { labels: {} }], ['ended', { state: 'ended' }],
] as const)('admission rejects changed %s before replay and after audit', async (_name, changed) => {
  const h = await fixture(false)
  await h.send(injectedInput())
  h.options.expectedCount = 1
  const a = admissionFor(h)
  for (const at of [1, 2]) {
    let reads = 0
    expect(await a.check({ getRow: async () => ++reads === at ? { ...a.row, ...changed } : a.row }))
      .toMatchObject({ ready: false, reason: 'life-changed' })
    expect(reads).toBe(at)
  }
})

test.each(['working', 'AD rejection', 'missing journal', 'wrong original count', 'missing receipt'] as const)(
  'admission refuses %s despite otherwise drained work', async mode => {
    const h = await fixture(false)
    await h.send(injectedInput())
    h.options.expectedCount = 1
    const a = admissionFor(h)
    if (mode === 'missing journal') rmSync(h.journal)
    if (mode === 'wrong original count') a.options.expectedCount++
    if (mode === 'missing receipt') writeFileSync(h.transcript, '')
    let reads = 0
    const result = await a.check({ getRow: async () => {
      if (++reads === 2 && mode === 'AD rejection') throw new Error('synthetic AD failure')
      return { ...a.row, state: mode === 'working' ? 'working' : 'waiting' }
    } })
    expect(result).toMatchObject({ ready: false, reason: mode === 'working' ? 'ad-not-waiting'
      : mode === 'AD rejection' ? 'ad-unavailable' : mode === 'missing journal' ? 'journal-unreadable' : 'receipts' })
  },
)

test('unresolved candidate without observed working reaches the watchdog without a DM or cancellation', async () => {
  const h = await fixture(false)
  await h.send(slackInput())
  for (let i = 1; i < 33; i++) await h.send(injectedInput())
  h.options.expectedCount = 33
  const a = admissionFor(h), bytes = readFileSync(h.journal)
  expect(h.audit().items).toBe(33)
  expect(h.queue.replyReminderItems('alpha')).toHaveLength(1)
  let polls = 0, attempts = 0, dms = 0
  await firstLatencyAdmission(h.options.stateDir, async request => {
    if (request === 'now') return String(polls * 1000)
    if (request === 'poll') { polls++; return 'ok' }
    if (request === 'admission') {
      attempts++
      expect(await a.check()).toEqual({ ready: false, reason: 'candidates', candidates: 1, open: 0 })
      return 'wait'
    }
    if (request === 'dm') { dms++; return 'ok' }
    throw new Error(`Unexpected test boundary: ${request}`)
  }, true)
  expect(polls).toBe(3)
  expect(attempts).toBe(5) // Initial, polling, and the actual shell's final deadline check.
  expect(dms).toBe(0)
  expect(readFileSync(h.journal)).toEqual(bytes)
  expect(h.queue.replyReminderItems('alpha')).toHaveLength(1)
})

test('original Slack and injected inputs retain exact counts and latency samples across reminder delivery and compaction', async () => {
  const h = await fixture()
  expect(h.audit()).toMatchObject({ items: 4, reminders: 1, duplicates: 0 })
  expect(h.audit().timings.map(t => t.seq)).toEqual([1, 3, 4, 5])
  const evidence = deliveryFailureEvidence(h.options, h.entries(), h.adapters)
  expect(evidence).toMatchObject({ accepted: 4, reminders: 1, expected: 4, open: 0 })
  await h.queue.compact()
  expect(h.audit()).toMatchObject({ items: 4, reminders: 1, duplicates: 0 })
})

test('functional watchdog counts original exact receipt parts across compaction, never reminders or duplicate records', async () => {
  const h = await fixture()
  const progress = () => receiptProgress(h.options, h.entries(), h.adapters)
  expect(progress()).toBe(4)
  const rows = jsonLines(h.journal)
  rows.push(...rows.filter(r => r.kind === 'delivered' || r.kind === 'sent'))
  writeFileSync(h.journal, rows.map(r => JSON.stringify(r)).join('\n') + '\n')
  expect(progress()).toBe(4)
  await h.queue.compact()
  expect(progress()).toBe(4)
})

test.each(['no-durable', 'no-take-in', 'wrong-text', 'wrong-reference', 'foreign-session', 'before-acceptance'])('functional watchdog refuses unconfirmed progress: %s', async mode => {
  const h = await fixture()
  let rows = jsonLines(h.journal), entries = h.entries()
  const delivered = rows.find(r => r.kind === 'delivered' && r.seq === 1)
  const index = entries.findIndex(e => e.uuid === delivered.receipt.uuid)
  if (mode === 'no-durable') rows = rows.filter(r => !(r.kind === 'delivered' && r.seq === 1))
  if (mode === 'no-take-in') entries[index] = { ...entries[index]!, kind: 'other' }
  if (mode === 'wrong-text') entries[index] = { ...entries[index]!, text: 'unrelated message' }
  if (mode === 'wrong-reference') delivered.receipt.uuid = 'absent'
  if (mode === 'foreign-session') {
    delivered.receipt.path = join(h.options.stateDir, 'other-session.jsonl')
    entries[index] = { ...entries[index]!, path: delivered.receipt.path }
  }
  if (mode === 'before-acceptance') entries[index] = { ...entries[index]!, at: 0 }
  writeFileSync(h.journal, rows.map(r => JSON.stringify(r)).join('\n') + '\n')
  expect(receiptProgress(h.options, entries, h.adapters)).toBe(3)
})

test('multipart workload advances progress only when each exact part has its own durable receipt', async () => {
  const h = await fixture(), rows = jsonLines(h.journal), entries = h.entries()
  const fixed = rows.find(r => r.kind === 'fixed' && r.seq === 1)
  fixed.parts.push('<channel seq="1" part="2">second part</channel>')
  const first = entries.find(e => e.uuid === 'take-1')!
  entries.push({ ...first, text: fixed.parts[1], uuid: 'take-part-2', offset: first.offset + 1 })
  const save = () => writeFileSync(h.journal, rows.map(r => JSON.stringify(r)).join('\n') + '\n')
  save()
  expect(receiptProgress(h.options, entries, h.adapters)).toBe(4)
  rows.push({ ...rows.find(r => r.kind === 'delivered' && r.seq === 1), part: 2, receipt: { path: h.transcript, uuid: 'take-part-2' } })
  save()
  expect(receiptProgress(h.options, entries, h.adapters)).toBe(5)
})

test('workload ordinals retain original input identities across interleaved reminders and recovery', async () => {
  const h = await fixture()
  const assertSelection = () => {
    const journal = receiptJournal(h.options.stateDir, 'alpha')
    const inputs = workloadItems(journal)
    expect(inputs.map(r => [r.seq, r.source])).toEqual([[1, 'slack'], [3, 'slack'], [4, 'interject'], [5, 'cron']])
    expect(inputs.map((_, i) => workloadItem(journal, i + 1).seq)).toEqual([1, 3, 4, 5])
    expect(() => workloadItem(journal, 5)).toThrow('Workload item 5 has not been accepted')
    // Selecting a workload must leave reminder evidence in the full journal.
    expect(journal.some(r => r.kind === 'accepted' && r.reminder_for === 1)).toBe(true)
  }
  assertSelection()
  await h.queue.compact()
  expect(jsonLines(h.journal).some(r => r.kind === 'accepted' && r.compact)).toBe(true)
  await h.queue.stop()
  await h.queue.start()
  assertSelection()
})

test.each([0, -1, 1.5, NaN, Infinity])('workload selection rejects invalid ordinal %s', ordinal => {
  expect(() => workloadItem([], ordinal)).toThrow('Invalid workload ordinal')
})

test.each([
  ['missing original input', 'Accepted item count differs'],
  ['missing reminder receipt', 'still open'],
  ['missing reminder take-in', 'no exact transcript receipt'],
  ['missing reminder send', 'has no shim send'],
  ['recursive reminder', 'Invalid reply reminder provenance'],
  ['cron reminder', 'Invalid reply reminder provenance'],
  ['duplicate reminder', 'Invalid reply reminder provenance'],
  ['premature reminder', 'Invalid reply reminder provenance'],
  ['reminder sent before workload delivery log', 'Successor send preceded prior receipt/delivery log'],
  ['workload sent before reminder delivery log', 'Successor send preceded prior receipt/delivery log'],
  ['reminder retyped', 'Text fidelity case retyped'],
] as const)('receipt accounting rejects %s despite excluding reminders from the expected input count', async (mode, reason) => {
  const h = await fixture()
  expect(h.audit().items).toBe(4)
  let rows = jsonLines(h.journal)
  if (mode === 'missing original input') rows = rows.filter(r => r.seq !== 5)
  if (mode === 'missing reminder receipt') rows = rows.filter(r => !(r.seq === 2 && r.kind === 'delivered'))
  if (mode === 'recursive reminder' || mode === 'cron reminder' || mode === 'premature reminder') {
    rows = rows.map(r => r.seq === 2 && r.kind === 'accepted'
      ? { ...r, ...(mode === 'premature reminder' ? { received_at: 1000 } : { reminder_for: mode === 'recursive reminder' ? 2 : 5 }) } : r)
  }
  if (mode === 'duplicate reminder') rows.push({ ...rows.find(r => r.seq === 2 && r.kind === 'accepted'), seq: 6 })
  writeFileSync(h.journal, rows.map(r => JSON.stringify(r)).join('\n') + '\n')
  if (mode === 'missing reminder take-in') writeFileSync(h.transcript, jsonLines(h.transcript).filter(r => r.uuid !== 'take-2').map(r => JSON.stringify(r)).join('\n') + '\n')
  if (mode === 'missing reminder send') writeFileSync(h.shimLog, readFileSync(h.shimLog, 'utf8').split('\n').filter((_, i) => i !== 1).join('\n'))
  if (mode === 'reminder sent before workload delivery log' || mode === 'workload sent before reminder delivery log') {
    const previousSeq = mode === 'reminder sent before workload delivery log' ? 1 : 2
    const previous = rows.find(r => r.kind === 'accepted' && r.seq === previousSeq)
    const sent = rows.find(r => r.kind === 'sent' && r.seq === previousSeq + 1)
    const logPath = join(h.options.stateDir, 'server.log')
    const lines = readFileSync(logPath, 'utf8').split('\n').map(line =>
      line.includes('message-delivered:') && line.includes(`ts=${JSON.stringify(previous.ts)}`)
        ? line.replace(/^\[[^\]]+\]/, `[${new Date(sent.at + 1).toISOString()}]`) : line)
    writeFileSync(logPath, lines.join('\n'))
  }
  if (mode === 'reminder retyped') {
    const calls = readFileSync(h.shimLog, 'utf8').trimEnd().split('\n')
    calls.splice(2, 0, calls[1]!)
    writeFileSync(h.shimLog, calls.join('\n') + '\n')
  }
  expect(() => auditReceipts({ ...h.options, noRetype: mode === 'reminder retyped' }, h.entries(), h.adapters)).toThrow(reason)
})

/** test33 legs whose full receipt wait is followed by a case audit that
 * re-reads newer evidence (b.p9r). A production reminder can be accepted
 * between the two reads. */
const test33Legs = {
  'reset-spacing': { count: 4, reminders: 2, reminderFor: 5 },
  'key-proof': { count: 2, reminders: 0, reminderFor: 1 },
  'unknown-proof': { count: 2, reminders: 0, reminderFor: 1 },
} as const satisfies Record<Test33Leg, object>
const legNames = Object.keys(test33Legs) as Test33Leg[]

const legPlans = { 'reset-spacing': 'reset', 'key-proof': 'retype', 'unknown-proof': 'unknown-typed' } as const satisfies Record<Test33Leg, Plan>
/** `plan` is the key-fault plan of the leg's own (last) original input. */
async function test33Evidence(leg: Test33Leg, plan: Plan = legPlans[leg]) {
  const h = await fixture(false, true)
  const observe = (state: 'working' | 'waiting') => h.queue.observeReplyReminders('alpha',
    cannedGetResult({ state, session_id: 'session' }, h.persona, h.options.stateDir), REPLY_REMINDER_TEXT, true, () => true)
  const slack = (n: number) => { const ts = `1700000000.00000${n}`; return slackInput({ ts, key: { chat_id: 'C0TEST001', ts } }) }
  await h.send(slack(1))
  if (leg === 'reset-spacing') {
    // As in the archived run: ordinals 1-4 are sequences 1, 2, 5 and 6, and
    // sequence 5's candidate saw AD working before the reset item completed.
    await h.send(slack(2))
    await observe('working')
    for (const reminder of await observe('waiting')) await h.complete(reminder)
    await h.send(slack(3))
    await observe('working')
    await h.send(slack(4), plan)
  } else {
    await observe('working')
    await h.send(slack(2), plan)
  }
  h.options.expectedCount = test33Legs[leg].count
  return { h, observe, slack, pending: [] as QueueItem[] }
}
type Test33Evidence = Awaited<ReturnType<typeof test33Evidence>>

/** `inject` runs once the slice's first full receipt audit has succeeded;
 * `settle` runs at the slice's first poll, else after it. The following leg's
 * full audit then reads the same settled evidence. */
async function raceTest33(leg: Test33Leg, e: Test33Evidence, race: {
  inject?(): Promise<void>; settle?(): Promise<void>
} = {}) {
  let injected = 0, settled = false
  const settle = async () => {
    if (settled || !injected) return
    settled = true
    await race.settle?.()
  }
  const result = await runTest33Slice(leg, e.h.options.stateDir, {
    afterReady: async () => { injected++; await race.inject?.() },
    poll: settle,
  })
  await settle()
  let final: { ok: true; audit: ReturnType<typeof auditReceipts> } | { ok: false; error: string }
  try { final = { ok: true, audit: e.h.audit() } } catch (error) { final = { ok: false, error: (error as Error).message } }
  return { result, injected, final }
}
const reminderRace = (e: Test33Evidence) => ({
  inject: async () => { e.pending.push(...await e.observe('waiting')) },
  settle: async () => { for (const item of e.pending) await e.h.complete(item) },
})

test.each(legNames)('test33 %s passes its receipt wait and case audit at once when no later work arrives', async leg => {
  const e = await test33Evidence(leg)
  const { result, injected, final } = await raceTest33(leg, e)
  expect(injected).toBe(1)
  expect(result).toMatchObject({ code: 0, signal: null, stderr: '', errors: [] })
  expect(final).toMatchObject({ ok: true, audit: { items: test33Legs[leg].count, reminders: test33Legs[leg].reminders } })
})

/** How each leg's corrected wait treats its case assertion's exit status. The
 * case runs its complete receipt audit first: while that fails it exits pending
 * (75) and the wait re-polls; only once it passes does the case's own proof
 * run, and that proof failing is its verdict (1), with no further poll. */
test.each(legNames)('test33 %s completes when a legitimate reply reminder is accepted after its successful receipt wait', async leg => {
  const e = await test33Evidence(leg)
  const { result, injected, final } = await raceTest33(leg, e, reminderRace(e))
  // The production observer accepted one open reminder for an earlier,
  // fully delivered Slack input after the wait's complete audit succeeded.
  expect(injected).toBe(1)
  expect(e.pending.map(item => [item.accepted.source, item.accepted.sender, item.accepted.reminder_for]))
    .toEqual([['interject', 'reply-reminder', test33Legs[leg].reminderFor]])
  // Only the case receipt audit is pending, so the whole wait re-polls once.
  expect(result).toMatchObject({ code: 0, signal: null, stderr: '', polls: 1, ready: 2,
    calls: ['ready:0', `${leg}:75`, 'progress:0', 'ready:0', `${leg}:0`],
    errors: [pendingError(e)] })
  // Every reminder still needs full receipt/FIFO proof; none is filtered out.
  expect(final).toMatchObject({ ok: true, audit: { items: test33Legs[leg].count, reminders: test33Legs[leg].reminders + 1 } })
})

const pendingError = (e: Test33Evidence, log: 'received' | 'delivered' = 'delivered') =>
  `real-case-assertions: receipts pending: Item ${e.pending[0]!.accepted.seq} has no valid message-${log} timestamp`
/** After the pending case audit, the ready audit sees the open (or defective)
 * item too. Synthetic bounds: 3 s without original-receipt progress, 5 s overall. */
function expectNoProgressWatchdog(leg: Test33Leg, e: Test33Evidence, result: Test33Result,
  { receipts = test33Legs[leg].count as number, polls = 3 } = {}) {
  const open = Array.from({ length: polls }, () => ['ready:1', 'progress:0']).flat()
  expect(result.calls.slice(0, -2)).toEqual(['ready:0', `${leg}:75`, 'progress:0', ...open])
  expect(result.calls.slice(-2)).toEqual(['diagnostic:0', `${join(e.h.options.stateDir, 'real-delivery-status.json')}:0`])
  expect(result).toMatchObject({ code: 1, signal: null, polls })
  expect(result.stderr).toBe(`real persona alpha has open/unconfirmed deliveries (no-progress watchdog; receipts=${receipts}; idle bound=3s; overall bound=5s)\n`)
}

/** Corrected waits must still reject defective evidence, and an item that never
 * completes must end under the existing synthetic watchdog rather than hang.
 * Each control is the regression race plus one defect: the defect keeps the
 * slice's ready audit failing to its watchdog, and the full audit names it. */
test.each([
  ['invalid reminder provenance', 'Invalid reply reminder provenance', (e: Test33Evidence) => ({ ...reminderRace(e),
    settle: async () => {
      await reminderRace(e).settle()
      // The completed reminder claims an input that already had its reminder.
      rewriteRows(e.h.journal, r => r.kind === 'accepted' && r.seq === e.pending[0]!.accepted.seq ? { ...r, reminder_for: 1 } : r)
    } })],
  ['missing reminder receipt', 'Item 7 part 1 has no exact transcript receipt', (e: Test33Evidence) => ({ ...reminderRace(e),
    settle: async () => {
      await reminderRace(e).settle()
      rewriteRows(e.h.transcript, r => r.uuid === 'take-7' ? undefined : r)
    } })],
  ['mismatched reminder receipt', 'Durable receipt does not identify matching take-in', (e: Test33Evidence) => ({ ...reminderRace(e),
    settle: async () => {
      await reminderRace(e).settle()
      rewriteRows(e.h.journal, r => r.kind === 'delivered' && r.seq === 7 ? { ...r, receipt: { ...r.receipt, uuid: 'take-5' } } : r)
    } })],
  ['reminder send overlapping the reset item', 'Successor send preceded prior receipt/delivery log', (e: Test33Evidence) => ({ ...reminderRace(e),
    settle: async () => {
      await reminderRace(e).settle()
      // Log the reset item's completion only after the reminder was typed.
      const log = join(e.h.options.stateDir, 'server.log'), reminderSent = jsonLines(e.h.journal).find(r => r.kind === 'sent' && r.seq === 7).at
      writeFileSync(log, readFileSync(log, 'utf8').split('\n').map(line => line.includes('message-delivered:') && line.includes('ts="1700000000.000004"')
        ? line.replace(/^\[[^\]]+\]/, `[${new Date(reminderSent + 1).toISOString()}]`) : line).join('\n'))
    } })],
  ['reminder that never completes', 'Item 7 has no valid message-delivered timestamp', (e: Test33Evidence) => ({ inject: reminderRace(e).inject })],
  ['extra original input', 'Accepted item count differs', (e: Test33Evidence) => ({
    inject: async () => {
      const r = await e.h.queue.accept('alpha', e.slack(5))
      if (r.status !== 'accepted' || !r.item) throw new Error('extra input was not accepted')
      e.pending.push(r.item)
    },
    settle: reminderRace(e).settle })],
] as const)('test33 reset-spacing race still rejects %s', async (name, reason, race) => {
  const e = await test33Evidence('reset-spacing')
  const { result, injected, final } = await raceTest33('reset-spacing', e, race(e))
  expect(injected).toBe(1)
  expect(result.signal).toBeNull()
  // The slice's own verdict: pending once, then its ready audit keeps
  // failing until the watchdog. The extra Slack input is pending on its
  // received log, and its own receipt is progress, so the idle bound
  // restarts once.
  const extra = name === 'extra original input'
  expectNoProgressWatchdog('reset-spacing', e, result, extra ? { receipts: 5, polls: 4 } : {})
  expect(result.errors).toEqual([pendingError(e, extra ? 'received' : 'delivered')])
  // Which defect it was.
  expect(final).toMatchObject({ ok: false, error: expect.stringContaining(reason) })
})

const caseProofFailures = {
  'reset-spacing': ['reset missing retype', 'reset requires the durable Enter/text/Enter/text recovery sequence'],
  'key-proof': ['plain', 'missed text was not retyped'],
  'unknown-proof': ['plain', 'unknown fault was not applied'],
} as const satisfies Record<Test33Leg, readonly [Plan, string]>
test.each(legNames)('test33 %s fails at its first audit-passing case assertion on its own case-proof failure once pending receipts complete', async leg => {
  const [plan, reason] = caseProofFailures[leg]
  const e = await test33Evidence(leg, plan)
  const { result, injected, final } = await raceTest33(leg, e, reminderRace(e))
  expect(injected).toBe(1)
  // Pending first, then the own proof on the settled evidence; no watchdog.
  expect(result).toMatchObject({ code: 1, signal: null, polls: 1, ready: 2, stderr: '',
    calls: ['ready:0', `${leg}:75`, 'progress:0', 'ready:0', `${leg}:1`],
    errors: [pendingError(e), `real-case-assertions: ${reason}`] })
  // The receipts are complete, so the failure is the case's own proof alone.
  expect(final).toMatchObject({ ok: true, audit: { items: test33Legs[leg].count, reminders: test33Legs[leg].reminders + 1 } })
})

test.each(legNames)('test33 %s with a bad case proof and a never-completing reminder fails at the existing no-progress watchdog, never passing', async leg => {
  const e = await test33Evidence(leg, caseProofFailures[leg][0])
  const { result, injected } = await raceTest33(leg, e, { inject: reminderRace(e).inject })
  expect(injected).toBe(1)
  expectNoProgressWatchdog(leg, e, result)
  // The own proof never ran on incomplete evidence, so neither verdict masks the other.
  expect(result.errors).toEqual([pendingError(e)])
})

// The slices above drive one leg each; this keeps every receipt proof, the
// unsliced key-proof 1, 3 and 7 legs included, inside its delivery wait.
test('test33 runs every receipt case proof only as its delivery wait\'s -- assertion, never as a bare follow-up', () => {
  const lines = readFileSync(join(import.meta.dir, 'integration/test-33-fmk-real-keys.sh'), 'utf8').split('\n')
  const proofs = lines.filter(line => /\bcase_assert (?:key-proof|reset-spacing|unknown-proof)\b/.test(line))
  expect(proofs.filter(line => !/^\s*(?:\w+=\S+ )*real_wait_delivery [^#]* -- case_assert (?:key-proof|reset-spacing|unknown-proof)\b/.test(line))).toEqual([])
  expect(proofs.map(line => line.match(/case_assert (\S+ \S+)/)![1])).toEqual([
    'key-proof 1', 'key-proof 2', 'key-proof 3', 'reset-spacing 4', 'unknown-proof "${outcome}"', 'key-proof 7'])
})

/** Other real tails whose last delivery wait is followed by a receipt audit
 * reading newer evidence (b.p9r). `audit` is the site's last receipt-consistent
 * audit before that tail: test39's and test104's delivery wait, and AC106's
 * ai_readback, which audits every receipt again after the wait. `pending` is
 * the slice's calls once a reminder is accepted after that audit, up to the
 * tail's first poll; `done` its calls after a later passing ready audit. */
const sites = {
  // The loop's two waits, then the tail's.
  test39: { count: 2, plans: ['plain', 'plain'], audit: 'ready', dms: [['alpha', 'fidelity one'], ['alpha', 'fidelity two']],
    pending: ['ready:0', 'ready:0', 'ready:1', 'progress:0'], done: [] },
  // The case receipt audit is the reminder's first reader, then the fault check.
  test104: { count: 3, plans: ['unknown-untyped', 'plain', 'plain'], audit: 'ready',
    dms: [1, 2, 3].map(n => ['alpha', `queued AD contract delivery ${n}`]),
    pending: ['ready:0', 'receipts:75', 'progress:0'], done: ['receipts:0', 'fault:0'] },
  // The first DM and its duplicate copy precede the slice.
  ai106: { count: 2, plans: ['plain', 'plain'], audit: 'readback', dms: [['alpha', expect.stringContaining('How many DMs')]],
    pending: ['ready:0', 'readback:0', 'ready:1', 'progress:0'], done: ['at-least-one-duplicate:0'] },
} as const satisfies Record<Site, { count: number; plans: readonly Plan[]; audit: string; dms: readonly unknown[]
  pending: readonly string[]; done: readonly string[] }>
const readyPasses = (calls: readonly string[]) => calls.filter(call => call === 'ready:0').length
const siteNames = Object.keys(sites) as Site[]

/** Each `real_dm` in the slice accepts and delivers the site's next original
 * input. AD saw working after the first, so a later waiting observation accepts
 * a reply reminder for sequence 1. */
async function siteEvidence(site: Site, { duplicate = true } = {}) {
  const h = await fixture(false, true)
  const observe = (state: 'working' | 'waiting') => h.queue.observeReplyReminders('alpha',
    cannedGetResult({ state, session_id: 'session' }, h.persona, h.options.stateDir), REPLY_REMINDER_TEXT, true, () => true)
  const slack = (n: number) => { const ts = `1700000000.00000${n}`; return slackInput({ ts, key: { chat_id: 'C0TEST001', ts } }) }
  const e = { h, observe, slack, sent: 0, dms: [] as string[][], items: [] as QueueItem[], pending: [] as QueueItem[],
    async deliver() {
      const item = await h.send(slack(e.sent + 1), sites[site].plans[e.sent])
      e.items.push(item)
      if (++e.sent === 1) await observe('working')
      return item
    } }
  if (site === 'ai106') {
    const first = await e.deliver()
    if (duplicate) h.duplicate(first)
  }
  h.options.expectedCount = sites[site].count
  return e
}
type SiteEvidence = Awaited<ReturnType<typeof siteEvidence>>

/** `inject` runs once, at the site's first passing `audit` after every input
 * was delivered, or with `later` at the next passing call after it other than
 * `progress` (a gate the tail itself adds); `settle` at the slice's next poll,
 * else after it. */
async function raceSite(site: Site, e: SiteEvidence, race: { inject?(): Promise<void>; settle?(): Promise<void> } = {}, later = false) {
  let injected = 0, settled = false, reached = false
  const settle = async () => {
    if (settled || !injected) return
    settled = true
    await race.settle?.()
  }
  const result = await runRealSlice(SITE_SLICES[site], e.h.options.stateDir, {
    dm: async words => { e.dms.push(words); await e.deliver() },
    afterAudit: async (command, code) => {
      if (injected || code !== 0 || e.sent < sites[site].count) return
      if (!reached) {
        reached = command === sites[site].audit
        if (!reached || later) return
      } else if (command === 'progress') return
      injected++
      await race.inject?.()
    },
    poll: settle,
  })
  await settle()
  expect(e.dms as unknown[]).toEqual([...sites[site].dms])
  const audit = (noRetype = false) => {
    try { return { ok: true, audit: auditReceipts({ ...e.h.options, noRetype }, e.h.entries(), e.h.adapters) } as const }
    catch (error) { return { ok: false, error: (error as Error).message } as const }
  }
  return { result, injected, final: audit(), noRetype: audit(true) }
}
const siteReminder = (e: SiteEvidence, plan: Plan = 'plain') => ({
  inject: async () => { e.pending.push(...await e.observe('waiting')) },
  settle: async () => { for (const item of e.pending) await e.h.complete(item, plan) },
})
const reminderSeq = (e: SiteEvidence) => e.pending[0]!.accepted.seq
const casePending = (e: SiteEvidence) => ({ code: 75, out: [],
  err: [`real-case-assertions: receipts pending: Item ${reminderSeq(e)} has no valid message-delivered timestamp`] })

test.each(siteNames)('%s tail completes when a legitimate reply reminder is accepted after its last passing receipt audit', async site => {
  const e = await siteEvidence(site)
  const { result, injected, final, noRetype } = await raceSite(site, e, siteReminder(e))
  // The production observer accepted one open reminder for the first, fully
  // delivered Slack input after the site's last passing receipt audit.
  expect(injected).toBe(1)
  expect(e.pending.map(item => [item.accepted.seq, item.accepted.source, item.accepted.sender, item.accepted.reminder_for]))
    .toEqual([[sites[site].count + 1, 'interject', 'reply-reminder', 1]])
  // The tail's wait re-polls once, and passes once the reminder completes.
  const calls = [...sites[site].pending, 'ready:0', ...sites[site].done]
  expect(result).toMatchObject({ code: 0, signal: null, stderr: '', polls: 1, ready: readyPasses(calls), calls,
    errors: site === 'test104' ? casePending(e).err : [] })
  // Every item, the reminder included, still has full receipt/FIFO proof.
  const proof = { items: sites[site].count, reminders: 1 }
  expect(final).toMatchObject({ ok: true, audit: site === 'ai106' ? { ...proof, duplicates: 1 } : proof })
  // test39's tail is a fidelity proof: the reminder too was typed once.
  if (site === 'test39') expect(noRetype).toMatchObject({ ok: true, audit: proof })
})

// Only AC106's tail has a passing check after its last receipt audit that a
// later reminder can precede: its own delivery wait, before the duplicate
// proof. test39's wait ends its tail, and test104's fault check after its wait
// reads no receipts.
test('ai106 tail also awaits a reply reminder accepted after its own passing delivery wait, before its duplicate proof', async () => {
  const e = await siteEvidence('ai106')
  const { result, injected, final } = await raceSite('ai106', e, siteReminder(e), true)
  expect(injected).toBe(1)
  // The duplicate case's receipt audit is pending, so the wait re-polls once.
  const calls = ['ready:0', 'readback:0', 'ready:0', 'at-least-one-duplicate:75', 'progress:0', 'ready:0', 'at-least-one-duplicate:0']
  expect(result).toMatchObject({ code: 0, signal: null, stderr: '', polls: 1, ready: readyPasses(calls), calls, errors: casePending(e).err })
  expect(final).toMatchObject({ ok: true, audit: { items: 2, reminders: 1, duplicates: 1 } })
})

/** Corrected tails must still reject: each is the regression race plus one
 * defect, and the full audit names which. The slice's own verdict: the tail's
 * ready audit keeps failing on the defect until the existing no-progress
 * watchdog ends it with the original receipts it saw. Synthetic bounds: 3 s
 * without original-receipt progress, 5 s overall. */
function expectSiteWatchdog(site: Site, e: SiteEvidence, outcome: Awaited<ReturnType<typeof raceSite>>,
  { receipts = sites[site].count as number, polls = 3, errors = site === 'test104' ? casePending(e).err : [] as string[] } = {}) {
  const { result } = outcome
  expect(outcome.injected).toBe(1)
  const calls = [...sites[site].pending, ...Array.from({ length: polls }, () => ['ready:1', 'progress:0']).flat(),
    'diagnostic:0', `${join(e.h.options.stateDir, 'real-delivery-status.json')}:0`]
  expect(result).toMatchObject({ code: 1, signal: null, polls, ready: readyPasses(calls), calls, errors })
  expect(result.stderr).toBe(`real persona alpha has open/unconfirmed deliveries (no-progress watchdog; receipts=${receipts}; idle bound=3s; overall bound=5s)\n`)
}

test.each(siteNames)('%s tail ends a reminder that never completes at its existing watchdog, never passing', async site => {
  const e = await siteEvidence(site)
  const outcome = await raceSite(site, e, { inject: siteReminder(e).inject })
  expectSiteWatchdog(site, e, outcome)
  expect(outcome.final).toEqual({ ok: false, error: `Item ${reminderSeq(e)} has no valid message-delivered timestamp` })
})

test.each(siteNames.flatMap(site => [
  [site, 'invalid reminder provenance', 'Invalid reply reminder provenance', (e: SiteEvidence) => ({ ...siteReminder(e),
    settle: async () => {
      await siteReminder(e).settle()
      // The completed reminder links to itself, not to an earlier Slack input.
      rewriteRows(e.h.journal, r => r.kind === 'accepted' && r.seq === reminderSeq(e) ? { ...r, reminder_for: reminderSeq(e) } : r)
    } })],
  [site, 'missing reminder receipt', 'part 1 has no exact transcript receipt', (e: SiteEvidence) => ({ ...siteReminder(e),
    settle: async () => {
      await siteReminder(e).settle()
      rewriteRows(e.h.transcript, r => r.uuid === `take-${reminderSeq(e)}` ? undefined : r)
    } })],
] as const))('%s tail still rejects %s', async (site, _name, reason, race) => {
  const e = await siteEvidence(site)
  const outcome = await raceSite(site, e, race(e))
  expectSiteWatchdog(site, e, outcome)
  expect(outcome.final).toMatchObject({ ok: false, error: expect.stringContaining(reason) })
})

test('test39 tail still rejects a reply reminder typed twice, as text fidelity requires', async () => {
  const e = await siteEvidence('test39')
  const outcome = await raceSite('test39', e, siteReminder(e, 'retype'))
  expectSiteWatchdog('test39', e, outcome)
  // Every receipt is otherwise exact; only the no-retype proof fails.
  expect(outcome.final).toMatchObject({ ok: true, audit: { items: 2, reminders: 1 } })
  expect(outcome.noRetype).toEqual({ ok: false, error: 'Text fidelity case retyped' })
})

test('test104 tail still rejects a wrong original count: an extra input accepted after its wait', async () => {
  const e = await siteEvidence('test104')
  const outcome = await raceSite('test104', e, {
    inject: async () => {
      const r = await e.h.queue.accept('alpha', e.slack(4))
      if (r.status !== 'accepted' || !r.item) throw new Error('extra input was not accepted')
      e.pending.push(r.item)
    },
    settle: siteReminder(e).settle,
  })
  // The extra input's own receipt is progress, so the idle bound restarts once.
  expectSiteWatchdog('test104', e, outcome, { receipts: 4, polls: 4,
    errors: ['real-case-assertions: receipts pending: Accepted item count differs'] })
  expect(outcome.final).toEqual({ ok: false, error: 'Accepted item count differs' })
  e.h.options.expectedCount = 4
  expect(e.h.audit()).toMatchObject({ items: 4, reminders: 0 })
})

test('ai106 tail still rejects a missing duplicate copy with at-least-one-duplicate\'s own verdict once receipts complete', async () => {
  const e = await siteEvidence('ai106', { duplicate: false })
  const outcome = await raceSite('ai106', e, siteReminder(e))
  expect(outcome.injected).toBe(1)
  // Pending once, then the own verdict (1) on the settled evidence ends the
  // wait at once: no further poll, no watchdog.
  const calls = [...sites.ai106.pending, 'ready:0', 'at-least-one-duplicate:1']
  expect(outcome.result).toMatchObject({ code: 1, signal: null, stderr: '', polls: 1, ready: readyPasses(calls), calls,
    errors: ['real-case-assertions: intended duplicate was not observed'] })
  // The receipts are complete, so only the duplicate proof can fail.
  expect(outcome.final).toMatchObject({ ok: true, audit: { items: 2, reminders: 1, duplicates: 0 } })
})

/** One `bun real-case-assertions.ts <command> <scenario args> [args]` call on
 * a site's evidence, outside any slice. */
const caseCli = (e: SiteEvidence, command: string, ...args: string[]) => runFixture('fixtures/real-case-assertions.ts',
  [command, e.h.options.stateDir, 'alpha', e.h.shimLog, join(e.h.options.stateDir, '.claude/projects'), ...args])

test('receipts <count> prints transcript-receipts audit\'s recorded line, and exits pending (75) while that audit fails', async () => {
  const e = await siteEvidence('test39')
  await e.deliver()
  await e.deliver()
  const audit = (count: string) => runFixture('fixtures/transcript-receipts.ts',
    ['audit', e.h.options.stateDir, 'alpha', e.h.shimLog, join(e.h.options.stateDir, '.claude/projects'), count])
  const complete = await caseCli(e, 'receipts', '2')
  expect(complete).toEqual({ code: 0, out: (await audit('2')).out, err: [] })
  expect(JSON.parse(complete.out[0]!.replace(/^recorded: receipts /, ''))).toMatchObject({ items: 2, reminders: 0, transcripts: 1 })
  // Any audit failure is pending, so the delivery wait re-polls it: here a
  // count no accepted inputs match yet,
  expect(await caseCli(e, 'receipts', '3')).toEqual({ code: 75, out: [],
    err: ['real-case-assertions: receipts pending: Accepted item count differs'] })
  // and a reminder accepted since, until it completes.
  await siteReminder(e).inject()
  expect(await caseCli(e, 'receipts', '2')).toEqual(casePending(e))
  await siteReminder(e).settle()
  const settled = await caseCli(e, 'receipts', '2')
  expect(settled).toEqual({ code: 0, out: (await audit('2')).out, err: [] })
  expect(settled.out[0]).toContain('"items":2,"reminders":1,')
})

// A bad count is the caller's error, so its verdict (1) precedes the audit and
// is never re-polled, even while receipts are pending.
test.each([[[]], [['0']]])('receipts with count %j fails (1) before its audit, never pending', async args => {
  const e = await siteEvidence('test39')
  await e.deliver()
  await e.deliver()
  await siteReminder(e).inject()
  expect(await caseCli(e, 'receipts', ...args)).toEqual({ code: 1, out: [],
    err: ['real-case-assertions: receipts needs a positive original count'] })
})

// Only the complete audit's failure is pending; the duplicate verdict (1) runs
// only once that audit passes, so neither masks the other. A missing copy on
// complete receipts is the ai106 tail's own-verdict slice above.
test.each([
  [true, false, { code: 0, out: [], err: [] }],
  [true, true, 'pending'],
  [false, true, 'pending'],
] as const)('at-least-one-duplicate with a copy=%p and a pending reminder=%p', async (duplicate, pending, expected) => {
  const e = await siteEvidence('ai106', { duplicate })
  if (pending) await siteReminder(e).inject()
  expect(await caseCli(e, 'at-least-one-duplicate') as unknown).toEqual(expected === 'pending' ? casePending(e) : expected)
})

/** AC106's first duplicate check, a wait_until before the counting query:
 * the copy reaching the transcript is what it waits for. */
const ac106CopyWait: RealSlice = { script: 'real-agent/ai-scenario.sh',
  after: ['elif [[ "${AI_CRITERION}" == 106 ]]', '--text "${TYPED}" >/dev/null\n'], before: 'real_wait_idle "${REAL_KEY}"',
  requires: ["wait_until 180 'second exact DM copy never reached transcript' case_assert at-least-one-duplicate"], preset: [], tools: [] }

test.each([
  ['pending receipts (75)', true, 'at-least-one-duplicate:75'],
  ['an unobserved copy (1)', false, 'at-least-one-duplicate:1'],
] as const)('AC106\'s copy wait_until still retries %s to success', async (_name, pending, first) => {
  const e = await siteEvidence('ai106', { duplicate: pending })
  if (pending) await siteReminder(e).inject()
  const result = await runRealSlice(ac106CopyWait, e.h.options.stateDir, {
    // At the first poll the reminder completes, or the typed copy arrives.
    poll: async () => { if (pending) await siteReminder(e).settle(); else e.h.duplicate(e.items[0]!) },
  })
  expect(result).toMatchObject({ code: 0, signal: null, stderr: '', polls: 1, calls: [first, 'at-least-one-duplicate:0'] })
})

// The site slices drive each tail once; this keeps the three b.p9r tails in
// their bound forms, so none regresses to a bare one-shot receipt audit.
test('test39, test104 and AC106 audit receipts after their last delivery only inside a re-polled wait', () => {
  const script = (name: string) => readFileSync(join(import.meta.dir, name), 'utf8').split('\n')
  const test39 = script('integration/test-39-fmk-real-fidelity.sh'), test104 = script('real-agent/test-104-fmk-real-idle-compact.sh')
  const ai = script('real-agent/ai-scenario.sh')
  for (const lines of [test39, test104, ai]) expect(lines.filter(line => /\breal_assert_(?:delivery|no_retype)\b/.test(line))).toEqual([])
  // test39: after its input loop, only the re-polled no-retype wait precedes the shape proof.
  expect(test39.slice(test39.indexOf('done') + 1, test39.indexOf('case_assert fidelity-shapes')).filter(line => !line.startsWith('#')))
    .toEqual(['real_wait_delivery "${REAL_KEY}" "${COUNT}" no-retype'])
  expect(test104.filter(line => line.includes('real-case-assertions.ts" receipts'))).toEqual([
    'real_wait_delivery "${REAL_KEY}" 3 -- bun "${SCENARIO_FIXTURES}/real-case-assertions.ts" receipts "${SLACK_STATE_DIR}" "${REAL_KEY}" "${SCENARIO_AD_SHIM_LOG}" "${HOME}/.claude/projects" 3'])
  expect(ai.filter(line => /\bcase_assert at-least-one-duplicate\b/.test(line)).map(line => line.trim())).toEqual([
    "wait_until 180 'second exact DM copy never reached transcript' case_assert at-least-one-duplicate",
    'real_wait_delivery "${REAL_KEY}" 2 -- case_assert at-least-one-duplicate'])
})

function rewriteRows(path: string, map: (row: any) => any) {
  writeFileSync(path, jsonLines(path).map(map).filter(row => row !== undefined).map(row => JSON.stringify(row)).join('\n') + '\n')
}
