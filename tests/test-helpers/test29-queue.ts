/** Production-format journal seeds for test29's extracted shell controls.
 * These are synthetic receipts, not native delivery evidence. */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isQueueRecord, type AcceptedRecord, type QueueRecord } from '../../src/delivery-queue.ts'
import { createFakeClock } from './fake-clock.ts'
import { deliveredRecord, fixedRecord, injectedInput, makeQueue, readQueue, refusedRecord, sentRecord, slackInput } from './delivery-queue.ts'

// One identity/file set for the restart, bounded snapshots and watchdog.
const queuePersonas = [
  { variable: 'ALPHA_DIR', key: 'alpha', file: 'alpha.jsonl' },
  { variable: 'BRAVO_DIR', key: 'bravo', file: 'bravo.jsonl' },
] as const
const watchdogFiles = { current: 'current', stagePrefix: 'stage-', missing: 'missing' }
function snapshotBindings() {
  return [
    ...queuePersonas.map(persona => `${persona.variable}=${persona.key}`),
    `declare -A QUEUE_KEY=(${queuePersonas.map(persona => `[${persona.key}]=${persona.key}`).join(' ')})`,
    `declare -A DELIVERIES_FILE=(${queuePersonas.map(persona => `[${persona.key}]="$HOME/${persona.file}"`).join(' ')})`,
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
  return { ...record, part, receipt: { ...record.receipt, uuid: `receipt-${seq}-${part}` } }
}
function journal(rows: QueueRecord[]): string {
  if (!rows.every(isQueueRecord)) throw new Error('invalid test29 queue seed')
  return rows.map(row => JSON.stringify(row)).join('\n') + '\n'
}

export async function test29RestartJournal(mode: string): Promise<string> {
  const [accepted] = await acceptances(1)
  const complete = [accepted!, fixedRecord(1, ['first', 'second']), receipt(1), receipt(2, 1, 300)]
  journal(complete)
  // Each omission/corruption starts from the same valid multipart journal.
  if (mode === 'empty') return journal([])
  if (mode === 'accepted-only') return journal(complete.slice(0, 1))
  if (mode === 'missing-part') return journal(complete.slice(0, -1))
  if (mode === 'duplicate-part' || mode === 'foreign-seq') {
    complete[3] = { ...receipt(2, 1, 300), ...(mode === 'duplicate-part' ? { part: 1 } : { seq: 2 }) }
  }
  return journal(complete)
}

export async function test29RestartFixture(mode: string) {
  const rows = await test29RestartJournal(mode)
  // Expected order comes from the scenario, never from parsed shell output.
  const phases = ['before-restart', mode === 'complete' ? 'restart-drained' : 'receipt-timeout']
  return {
    bindings: snapshotBindings(),
    files: Object.fromEntries(queuePersonas.map(persona => [persona.file, rows])),
    expectedSnapshots: phases.flatMap(phase => queuePersonas.map(persona => [phase, persona.key])),
  }
}

export async function test29DiagnosticJournals(secret: string, body: string): Promise<Record<string, string>> {
  const accepted = await acceptances(70, body)
  const rows = accepted.flatMap(item => [
    item, fixedRecord(item.seq, [body, secret]),
    ...Array.from({ length: 40 }, (_, j) => ({ ...sentRecord(item.seq, j + 1), at: 200 + j })),
    refusedRecord(item.seq, 40, 250),
  ])
  journal(rows)
  // Deliberately contaminate otherwise valid seeds with content/raw-error
  // sentinels: the bounded diagnostic must never echo these extra fields.
  const contaminated = rows.map(row => row.kind === 'accepted' ? { ...row, token: secret }
    : row.kind === 'sent' ? { ...row, transcript_path: secret, text: body }
    : row.kind === 'refused' ? { ...row, error: secret } : row)
  return { [queuePersonas[0].file]: journal(contaminated), [queuePersonas[1].file]: journal(contaminated.slice(0, 1)).slice(0, -2) }
}

export async function test29DiagnosticFixture(secret: string) {
  const body = 'private-message-body'
  return { body, bindings: snapshotBindings(), files: await test29DiagnosticJournals(secret, body) }
}

export async function test29WatchdogStages(mode: string): Promise<Record<string, string>> {
  const accepted = await acceptances(6, 'content', true)
  const original = accepted[0]!, reminder = accepted[6]!
  const parts = mode === 'overall-limit' ? 7 : 4
  const base = [original, fixedRecord(original.seq, Array(parts).fill('content')),
    ...(mode === 'reminders' ? [reminder, fixedRecord(reminder.seq, Array(4).fill('reminder'))] : []),
  ]
  const stages: Record<string, string> = {}
  for (let tick = 0; tick <= 5; tick++) {
    let facts: QueueRecord[] = []
    if (['progressing', 'overall-limit'].includes(mode)) facts = Array.from({ length: Math.min(tick, parts) }, (_, n) => receipt(n + 1))
    if (mode === 'repeated') facts = Array(tick + 1).fill(receipt(1))
    // Return to the old maximum at 120s must not buy another idle window.
    if (mode === 'regressed' && tick !== 1) facts = [receipt(1)]
    if (mode === 'reminders') facts = Array.from({ length: Math.min(tick, 4) }, (_, n) => receipt(n + 1, reminder.seq))
    // Foreign receipts have no acceptance in this journal.
    if (mode === 'foreign') facts = Array.from({ length: tick }, (_, n) => ({ ...receipt(n + 1), seq: 2 }))
    if (mode === 'new-work') facts = accepted.slice(1, tick + 1).flatMap(item => [item, fixedRecord(item.seq, ['later']), receipt(1, item.seq)])
    if (mode === 'attempts') facts = Array.from({ length: tick }, (_, n) => ({ ...sentRecord(1, n + 1), at: 200 + n }))
    // Deliberately move genuine receipt shapes before their acceptance.
    if (mode === 'stale') facts = Array.from({ length: Math.min(tick, 3) }, (_, n) => ({ ...receipt(n + 1), at: 0 }))
    // A changed accepted identity must invalidate the frozen workload, even
    // when all its original seq/parts appear receipted.
    const records = mode === 'changed-identity' && tick > 0
      ? [{ ...original, channel: 'foreign' }, base[1]!, ...Array.from({ length: parts }, (_, n) => receipt(n + 1))]
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
      `TEST29_CURRENT="$HOME/${watchdogFiles.current}"`, `TEST29_STAGE_PREFIX="$HOME/${watchdogFiles.stagePrefix}"`, `TEST29_MISSING="$HOME/${watchdogFiles.missing}"`,
      'declare -A DELIVERIES_FILE=([$TEST29_QUEUE_KEY]="$TEST29_CURRENT")',
    ],
  }
}

// Independent expected projection: do not derive it from the shell output.
export function test29DiagnosticExpectedItem() {
  return {
    seq: 1, received_at: 100, parts: 2, receipted_parts: 0, complete: false,
    recent: [
      ...Array.from({ length: 7 }, (_, j) => ({ kind: 'sent', part: 1, attempt: j + 34, at: 233 + j, send_kind: 'text' })),
      { kind: 'refused', part: null, attempt: 40, at: 250, send_kind: null },
    ],
  }
}
