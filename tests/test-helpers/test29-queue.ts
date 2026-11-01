/** Production-format journal seeds for test29's extracted shell controls.
 * These are synthetic receipts, not native delivery evidence. */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isQueueRecord, type AcceptedInput, type AcceptedRecord, type DeliveryQueue, type QueueRecord } from '../../src/delivery-queue.ts'
import { createFakeClock } from './fake-clock.ts'
import { deliveredRecord, fixedRecord, injectedInput, makeQueue, readQueue, refusedRecord, sentRecord, slackInput } from './delivery-queue.ts'

// One identity/file set for the restart, bounded snapshots and watchdog.
const queuePersonas = [
  { variable: 'ALPHA_DIR', key: 'alpha', file: 'alpha.jsonl' },
  { variable: 'BRAVO_DIR', key: 'bravo', file: 'bravo.jsonl' },
] as const
const watchdogFiles = { stagePrefix: 'stage-', missing: 'missing' }
// Replaced only while writing this fixture into the shell's owned scratch root.
export const TEST29_ROOT = '__TEST29_ROOT__'
const transcriptPath = `${TEST29_ROOT}/session.jsonl`
function snapshotBindings() {
  return [
    ...queuePersonas.map(persona => `${persona.variable}=${persona.key}`),
    `declare -A QUEUE_KEY=(${queuePersonas.map(persona => `[${persona.key}]=${persona.key}`).join(' ')})`,
    'declare -A QUEUE_ARCHIVES=()',
  ]
}

// Let production supply version, sequence, receipt time and injected timestamp.
// readQueue also checks the persisted records with the production parser.
async function acceptances(count: number, text = 'content', reminder = false) {
  const root = mkdtempSync(join(tmpdir(), 'cscb-test29-queue-'))
  const clock = createFakeClock({ start: 100 })
  const queue = await makeQueue(root, { now: clock.now })
  try {
    for (let i = 0; i < count; i++) {
      const input = slackInput({ text, ts: `${i + 1}.000000` })
      input.key = { chat_id: input.channel!, ts: input.ts! }
      const result = await queue.accept(queuePersonas[0].key, input)
      if (result.status !== 'accepted') throw new Error('test29 fixture acceptance failed')
    }
    if (reminder) {
      const result = await queue.accept(queuePersonas[0].key, injectedInput({ text: 'reminder', reminder_for: 1 }))
      if (result.status !== 'accepted') throw new Error('test29 fixture reminder acceptance failed')
    }
    return readQueue(root).filter((r): r is AcceptedRecord => r.kind === 'accepted' && !('compact' in r))
  } finally {
    await queue.stop()
    rmSync(root, { recursive: true, force: true })
  }
}

const receipt = (part: number, seq = 1, at = 200) => {
  const record = deliveredRecord(seq, at)
  return { ...record, part, receipt: { path: transcriptPath, uuid: `receipt-${seq}-${part}` } }
}
const sent = (seq = 1, attempt = 1) => ({ ...sentRecord(seq, attempt), at: 101, transcript_path: transcriptPath })
const take = (text: string, part: number, seq = 1) => ({ type: 'user', uuid: `receipt-${seq}-${part}`,
  sessionId: 'session', timestamp: 150, message: { role: 'user', content: text } })
function journal(rows: QueueRecord[]): string {
  if (!rows.every(isQueueRecord)) throw new Error('invalid test29 queue seed')
  return rows.map(row => JSON.stringify(row)).join('\n') + '\n'
}

export async function test29RestartJournal(mode: string): Promise<string> {
  const [accepted] = await acceptances(1)
  const complete = [accepted!, fixedRecord(1, ['first', 'second']), sent(), receipt(1), receipt(2, 1, 300)]
  journal(complete)
  // Each omission/corruption starts from the same valid multipart journal.
  if (mode === 'empty') return journal([])
  if (mode === 'accepted-only') return journal(complete.slice(0, 1))
  if (mode === 'missing-part') return journal(complete.slice(0, -1))
  if (mode === 'duplicate-part' || mode === 'foreign-seq') {
    complete[4] = { ...receipt(2, 1, 300), ...(mode === 'duplicate-part' ? { part: 1 } : { seq: 2 }) }
  }
  return journal(complete)
}

export async function test29RestartFixture(mode: string) {
  const rows = await test29RestartJournal(mode)
  return {
    bindings: snapshotBindings(),
    files: { ...Object.fromEntries(queuePersonas.map(persona => [`state/queue/${persona.file}`, rows])),
      'state/server.log': '', 'session.jsonl': [take('first',1), take('second',2)].map(r => JSON.stringify(r)).join('\n')+'\n' },
  }
}

function compactionMarkers(rows: QueueRecord[], mode: string): QueueRecord[] {
  return rows.flatMap<QueueRecord>(row => {
    if (row.kind !== 'accepted' || !('compact' in row)) return [row]
    if (row.compact === 'allocation') {
      if (mode === 'missing-allocation') return []
      if (mode === 'wrong-allocation') return [{ ...row, seq: 1 }]
    } else {
      if (mode === 'missing-key') return []
      if (mode === 'wrong-key') return [{ ...row, key: { ...row.key, ts: '9.000000' } }]
      if (mode === 'wrong-received-at') return [{ ...row, received_at: row.received_at - 1 }]
      if (mode === 'wrong-delivered-at') return [{ ...row, delivered_at: row.delivered_at + 1 }]
    }
    return [row]
  })
}

function compactionArchive(rows: QueueRecord[], mode: string): QueueRecord[] {
  return rows.flatMap<QueueRecord>(row => {
    if (row.kind === 'delivered' && row.seq === 1 && row.part === 2) {
      if (mode === 'missing-receipt') return []
      if (mode === 'altered-receipt') return [{ ...row, receipt: { ...row.receipt, uuid: 'foreign-receipt' } }]
    }
    if (row.kind === 'accepted' && !('compact' in row) && row.seq === 1) {
      if (mode === 'foreign-original') return [{ ...row, key: { ...row.key!, ts: '9.000000' }, ts: '9.000000' }]
      if (mode === 'stale-original') return [{ ...row, received_at: row.received_at - 1 }]
    }
    return [row]
  })
}

async function completedCompactionItem(queue: DeliveryQueue, key: string, input: AcceptedInput, parts: readonly string[]) {
  const accepted = await queue.accept(key, input)
  if (accepted.status !== 'accepted') throw new Error('compaction fixture acceptance failed')
  const seq = accepted.seq, at = queue.item(key, seq)!.accepted.received_at
  const path = `${TEST29_ROOT}/${key}.jsonl`, records: unknown[] = []
  await queue.append(key, fixedRecord(seq, [...parts]))
  await queue.append(key, { ...sent(seq), at: at + 1, transcript_path: path, session_id: key })
  for (const [index, text] of parts.entries()) {
    const delivered = receipt(index + 1, seq, at + 100 + index)
    await queue.append(key, { ...delivered, receipt: { ...delivered.receipt, path } })
    records.push({ ...take(text, index + 1, seq), timestamp: at + 50, sessionId: key })
  }
  return records.map(r => JSON.stringify(r)).join('\n') + '\n'
}

/** Produce both sides of a real queue startup compaction. The transcript
 * take-ins remain synthetic; no server or agent is started. */
export async function test29CompactionFixture(mode = 'complete') {
  const root = mkdtempSync(join(tmpdir(), 'cscb-test29-compaction-'))
  const body = 'private-compaction-body'
  let queue = await makeQueue(root, { now: () => 100 })
  const files: Record<string, string> = { 'state/server.log': '' }
  try {
    for (const { key, file } of queuePersonas) {
      files[`${key}.jsonl`] = ''
      for (const [input, parts] of [
        [slackInput({ text: body }), [`${body}-first`, `${body}-second`]],
        [injectedInput({ source: 'cron', sender: 'schedule', text: body }), [`${body}-cron`]],
      ] as const) {
        files[`${key}.jsonl`] += await completedCompactionItem(queue, key, input, parts)
      }
      files[`state/queue/${file}`] = journal(readQueue(root, key))
    }
    await queue.stop()
    // start() replays and compacts both queues, as a server restart does.
    queue = await makeQueue(root, { now: () => 400 })
    for (const { key, file } of queuePersonas) {
      let current = readQueue(root, key)
      if (current.some(r => r.kind === 'accepted' && !('compact' in r)) ||
          !current.some(r => r.kind === 'accepted' && 'compact' in r && r.compact === 'key') ||
          !current.some(r => r.kind === 'accepted' && 'compact' in r && r.compact === 'allocation')) {
        throw new Error('startup did not compact completed fixture work')
      }
      // Keep the other persona healthy so a failure cannot hide behind it.
      if (key === 'alpha') {
        if (mode === 'incomplete-work') {
          await queue.accept(key, slackInput({ text: body, ts: '2.000000', key: { chat_id: 'C0TEST001', ts: '2.000000' } }))
          current = readQueue(root, key)
        }
        current = compactionMarkers(current, mode)
      }
      files[`compacted/${file}`] = journal(current)
      let archive: QueueRecord[] = files[`state/queue/${file}`]!.trim().split('\n').map(line => JSON.parse(line))
      if (key === 'alpha') archive = compactionArchive(archive, mode)
      files[`archive/${file}`] = journal(archive)
      if (key === 'alpha' && ['wrong-transcript-text', 'wrong-transcript-session'].includes(mode)) {
        const takes = files[`${key}.jsonl`]!.trim().split('\n').map(line => JSON.parse(line))
        if (mode === 'wrong-transcript-text') takes[1].message.content = 'foreign body'
        else takes[1].sessionId = 'foreign-session'
        files[`${key}.jsonl`] = takes.map(r => JSON.stringify(r)).join('\n') + '\n'
      }
    }
    if (mode === 'complete') {
      for (const { key, file } of queuePersonas) {
        files[`${key}.jsonl`] += await completedCompactionItem(queue, key,
          slackInput({ text: body, ts: '2.000000', key: { chat_id: 'C0TEST001', ts: '2.000000' } }), [`${body}-later`])
        files[`next-work/${file}`] = journal(readQueue(root, key))
      }
      await queue.stop()
      queue = await makeQueue(root, { now: () => 600 })
      for (const { key, file } of queuePersonas) files[`compacted-again/${file}`] = journal(readQueue(root, key))
    }
    return { body, bindings: snapshotBindings(), files }
  } finally {
    await queue.stop()
    rmSync(root, { recursive: true, force: true })
  }
}

export async function test29DiagnosticJournals(secret: string, body: string): Promise<Record<string, string>> {
  const accepted = await acceptances(70, body)
  const rows = accepted.flatMap(item => [
    item, fixedRecord(item.seq, [body, secret]),
    ...Array.from({ length: 40 }, (_, j) => ({ ...sent(item.seq, j + 1), at: 200 + j })),
    refusedRecord(item.seq, 40, 250),
  ])
  journal(rows)
  // Deliberately contaminate otherwise valid seeds with content/raw-error
  // sentinels: the bounded diagnostic must never echo these extra fields.
  const contaminated = rows.map(row => row.kind === 'accepted' ? { ...row, token: secret }
    : row.kind === 'sent' ? { ...row, error: secret, text: body }
    : row.kind === 'refused' ? { ...row, error: secret } : row)
  return { 'state/queue/alpha.jsonl': journal(contaminated), 'state/queue/bravo.jsonl': journal(contaminated.slice(0, 1)).slice(0, -2),
    'state/server.log': '', 'session.jsonl': '' }
}

export async function test29DiagnosticFixture(secret: string) {
  const body = 'private-message-body'
  return { body, bindings: snapshotBindings(), files: await test29DiagnosticJournals(secret, body) }
}

export async function test29WatchdogStages(mode: string): Promise<Record<string, string>> {
  const accepted = await acceptances(6, 'content', true)
  const original = accepted[0]!, reminder = accepted[6]!
  const parts = mode === 'overall-limit' ? 7 : 4
  const base = [original, fixedRecord(original.seq, Array.from({ length: parts }, (_, n) => `content-${n+1}`)), sent(),
    ...(mode === 'reminders' ? [reminder, fixedRecord(reminder.seq, Array.from({ length: 4 }, (_, n) => `reminder-${n+1}`)), sent(reminder.seq)] : []),
  ]
  const stages: Record<string, string> = { 'state/server.log': '', 'session.jsonl': [
    ...Array.from({ length: parts }, (_, n) => take(`content-${n+1}`,n+1)),
    ...Array.from({ length: 4 }, (_, n) => take(`reminder-${n+1}`,n+1,reminder.seq)),
    ...accepted.slice(1,6).map(item => take('later',1,item.seq)),
  ].map(r => JSON.stringify(r)).join('\n')+'\n' }
  for (let tick = 0; tick <= 5; tick++) {
    let facts: QueueRecord[] = []
    if (['progressing', 'overall-limit'].includes(mode)) facts = Array.from({ length: Math.min(tick, parts) }, (_, n) => receipt(n + 1))
    if (mode === 'repeated') facts = Array(tick + 1).fill(receipt(1))
    // Return to the old maximum at 120s must not buy another idle window.
    if (mode === 'regressed' && tick !== 1) facts = [receipt(1)]
    if (mode === 'reminders') facts = Array.from({ length: Math.min(tick, 4) }, (_, n) => receipt(n + 1, reminder.seq))
    // Foreign receipts have no acceptance in this journal.
    if (mode === 'foreign') facts = Array.from({ length: tick }, (_, n) => ({ ...receipt(n + 1), seq: 2 }))
    if (mode === 'new-work') facts = accepted.slice(1, tick + 1).flatMap(item => [item, fixedRecord(item.seq, ['later']), sent(item.seq), receipt(1, item.seq)])
    if (mode === 'attempts') facts = Array.from({ length: tick }, (_, n) => ({ ...sent(1, n + 1), at: 200 + n }))
    // Deliberately move genuine receipt shapes before their acceptance.
    if (mode === 'stale') facts = Array.from({ length: Math.min(tick, 3) }, (_, n) => ({ ...receipt(n + 1), at: 0 }))
    // A changed accepted identity must invalidate the frozen workload, even
    // when all its original seq/parts appear receipted.
    const records = mode === 'changed-identity' && tick > 0
      ? [{ ...original, channel: 'foreign' }, base[1]!, sent(), ...Array.from({ length: parts }, (_, n) => receipt(n + 1))]
      : [...base, ...facts]
    const valid = journal(records)
    stages[`${watchdogFiles.stagePrefix}${tick}`] = mode === 'malformed' && tick > 0 ? valid.slice(0, -2) : valid
  }
  return stages
}

export async function test29WatchdogFixture(mode: string) {
  return {
    files: await test29WatchdogStages(mode),
    bindings: [
      `TEST29_QUEUE_KEY=${queuePersonas[0].key}`,
      'TEST29_CURRENT="$SLACK_STATE_DIR/queue/alpha.jsonl"', `TEST29_STAGE_PREFIX="$HOME/${watchdogFiles.stagePrefix}"`, `TEST29_MISSING="$HOME/${watchdogFiles.missing}"`,
      'declare -A QUEUE_KEY=([alpha]=alpha) QUEUE_ARCHIVES=()',
    ],
  }
}

// Independent expected projection: do not derive it from the shell output.
export function test29DiagnosticExpectedItem() {
  return {
    seq: 1, received_at: 100, parts: 2, receipted_parts: 0, complete: false,
    recent: [
      ...Array.from({ length: 7 }, (_, j) => ({ kind: 'sent', part: 1, attempt: j + 34, at: 233 + j, send_kind: 'text' })),
      { kind: 'refused', attempt: 40, at: 250 },
    ],
  }
}
