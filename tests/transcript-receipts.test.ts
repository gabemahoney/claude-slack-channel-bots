/** Synthetic controls for real-scenario accounting; no native agent or credentials. */
import { afterEach, expect, test } from 'bun:test'
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import * as fs from 'node:fs'
import { appendFileSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
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

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup() })
async function fixture(seed = true) {
  const stateDir = mkdtempSync(join(tmpdir(), 'reminder-receipts-'))
  let now = 1000
  const queue = createDeliveryQueue({ stateDir, now: () => now })
  cleanups.push(async () => { await queue.stop(); rmSync(stateDir, { recursive: true, force: true }) })
  await queue.start()
  const transcript = join(stateDir, 'session.jsonl'), shimLog = join(stateDir, 'shim.log'), journal = join(stateDir, 'queue/alpha.jsonl')
  const takes: object[] = [], calls: string[] = [], lines: string[] = []
  const adapters = { parseDeliveryTranscriptRecord, receiptTextMatches }
  const persona = makeMultiPersonaConfig([{ name: 'alpha' }], stateDir).personas[0]!
  async function complete(item: QueueItem) {
    const a = item.accepted, seq = a.seq, text = `<channel seq="${seq}">${a.text}</channel>`
    const diagnostic = (kind: string) => `[${new Date(now).toISOString()}] [slack] ${kind}: persona="alpha" (key=alpha) source=${a.source} ${a.source === 'slack' ? 'chat_id' : 'sender'}=${JSON.stringify(a.channel ?? a.sender)} ts=${JSON.stringify(a.ts)} sender_id=${JSON.stringify(a.user ?? a.sender)}`
    if (a.reminder_for === undefined) lines.push(diagnostic('message-received'))
    await queue.append('alpha', { v: 1, kind: 'fixed', seq, parts: [text] })
    now += 10
    await queue.append('alpha', { v: 1, kind: 'sent', seq, part: 1, attempt: 1, send_kind: 'text', at: now, session_id: 'session', transcript_path: transcript, transcript_size: 0 })
    calls.push(`call\t${now / 1000}\t1\t1\tbun\tsend-keys --instance-id cscb_alpha --text ${text.replace(/[^a-zA-Z0-9]/g, c => '\\' + c)} --no-enter`)
    now += 10
    takes.push({ ...promptEntry(text), uuid: `take-${seq}`, sessionId: 'session', timestamp: new Date(now).toISOString() })
    await queue.append('alpha', { v: 1, kind: 'delivered', seq, part: 1, at: now, receipt: { path: transcript, uuid: `take-${seq}` } })
    lines.push(diagnostic('message-delivered'))
    now += 10
    writeFileSync(transcript, takes.map(r => JSON.stringify(r)).join('\n') + '\n')
    writeFileSync(shimLog, calls.join('\n') + '\n')
    writeFileSync(join(stateDir, 'server.log'), lines.join('\n') + '\n')
  }
  async function send(input: AcceptedInput) {
    const result = await queue.accept('alpha', input)
    if (result.status !== 'accepted' || !result.item) throw new Error('fixture acceptance failed')
    await complete(result.item)
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
  return { queue, journal, transcript, shimLog, options, adapters, entries, send, complete, persona, now: () => now,
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
  'AC76 pre-sample admission waits for prior reminders: %s', async mode => {
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

test('AC76 admission replays and compacts only a private copy, then obtains fresh AD waiting', async () => {
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
  'AC76 admission fails closed and removes its snapshot on %s', async mode => {
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

test.each(['replay', 'stop', 'final AD'] as const)('AC76 admission rejects journal mutation during awaited %s', async phase => {
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
  'AC76 admission requires unchanged own post-cursor connection: %s', async mode => {
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
] as const)('AC76 admission rejects changed %s before replay and after audit', async (_name, changed) => {
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
  'AC76 admission refuses %s despite otherwise drained work', async mode => {
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

test('AC76 unresolved candidate without observed working reaches the watchdog without a DM or cancellation', async () => {
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
