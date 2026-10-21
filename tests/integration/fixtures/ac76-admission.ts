/** Test32 pre-sample admission. Replay only a private copy of the real journal;
 * production owns candidate eligibility, while AD alone supplies agent state.
 * Importing this module performs no I/O and starts no process or timer. */
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, relative, resolve } from 'node:path'
import type { DeliveryQueueOptions, ReplyReminderQueue } from '../../../src/delivery-queue.ts'
import { auditReceipts, packedReceiptAdapters, readTranscripts, transcriptFiles, type AuditOptions, type ReceiptAdapters } from './transcript-receipts.ts'

export interface AdmissionRow {
  instance_id: string
  state: string
  session_id: string
  started_at: string
  launch_started_at?: string | null
  labels: Record<string, string>
}
export interface AdmissionOptions extends AuditOptions {
  expectedCount: number
  scratchDir: string
  expectedRow: AdmissionRow
  connectionLineBase: number
  now: () => number
}
export interface AdmissionAdapters {
  createDeliveryQueue(options: DeliveryQueueOptions): ReplyReminderQueue
  receipts: ReceiptAdapters
  getRow(): Promise<AdmissionRow>
}
export type AdmissionReason = 'ready' | 'invalid-input' | 'connection-unavailable' | 'connection-changed'
  | 'ad-unavailable' | 'life-changed' | 'ad-not-waiting' | 'journal-unreadable' | 'journal-changed'
  | 'replay-failed' | 'candidates' | 'open-work' | 'receipts'
export interface AdmissionResult { ready: boolean; reason: AdmissionReason; candidates: number | null; open: number | null }

function sameLife(row: AdmissionRow, expected: AdmissionRow, key: string): boolean {
  return row?.instance_id === `cscb_${key}` && row.instance_id === expected?.instance_id
    && typeof row.session_id === 'string' && row.session_id.length > 0 && row.session_id === expected.session_id
    && typeof row.started_at === 'string' && row.started_at.length > 0 && row.started_at === expected.started_at
    && (row.launch_started_at ?? null) === (expected.launch_started_at ?? null)
    && row.labels?.tag_prompt === '1' && ['waiting', 'working'].includes(row.state)
}

/** Only CSCB's connection diagnostics are read here, never transcript or pane
 * content. A later disconnection overrides a historical connected line. */
export function connectionVersion(stateDir: string, key: string, lineBase: number): string | undefined {
  const path = join(stateDir, 'server.log'), stat = statSync(path)
  const lines = readFileSync(path, 'utf8').split('\n')
  let latest = -1, connected = false
  for (let i = lineBase; i < lines.length; i++) {
    const line = lines[i]!.replace(/^\[[^\]\r\n]+\] (?=\[slack\] )/, '')
    const diagnostic = /^\[slack\] Session (connected|disconnected[^:]*): persona "(?:[^"\\]|\\.)*" \(key=([a-z0-9_]+)\)(?: |$)/.exec(line)
    if (diagnostic?.[2] !== key) continue
    latest = i
    connected = diagnostic[1] === 'connected'
  }
  if (latest < 0 || !connected) return undefined
  return `${stat.dev}:${stat.ino}:${createHash('sha256').update(lines.slice(0, latest + 1).join('\n')).digest('hex')}`
}

async function replayCounts(bytes: Buffer, options: AdmissionOptions, adapters: AdmissionAdapters) {
  const snapshot = mkdtempSync(join(options.scratchDir, 'ac76-queue-'))
  let queue: ReplyReminderQueue | undefined, damaged = false
  try {
    mkdirSync(join(snapshot, 'queue'), { mode: 0o700 })
    writeFileSync(join(snapshot, 'queue', `${options.key}.jsonl`), bytes, { mode: 0o600 })
    const at = options.now()
    if (!Number.isFinite(at)) throw new Error('Invalid observation time')
    queue = adapters.createDeliveryQueue({ stateDir: snapshot, now: () => at,
      onEvent: event => { if (!['stored', 'writable', 'retained'].includes(event.type)) damaged = true },
    })
    await queue.start()
    // start catches per-key failures; this explicit operation must also pass.
    await queue.compact(options.key)
    if (damaged || queue.startupFindings().length) throw new Error('Replay integrity failure')
    return { candidates: queue.replyReminderItems(options.key).length, open: queue.openCount(options.key) }
  } finally {
    try { await queue?.stop() } finally { rmSync(snapshot, { recursive: true, force: true }) }
  }
}

/** One observation attempt, not a reservation or a sleep-based idle heuristic.
 * The shell watchdog retries closed attempts before sending the next DM once. */
export async function checkAc76Admission(options: AdmissionOptions, adapters: AdmissionAdapters): Promise<AdmissionResult> {
  let reason: AdmissionReason = 'invalid-input', candidates: number | null = null, open: number | null = null
  const closed = (): AdmissionResult => ({ ready: false, reason, candidates, open })
  try {
    if (!/^[a-z0-9_]+$/.test(options.key) || !Number.isSafeInteger(options.expectedCount) || options.expectedCount < 1
      || !Number.isSafeInteger(options.connectionLineBase) || options.connectionLineBase < 0) return closed()
    reason = 'connection-unavailable'
    const connection = connectionVersion(options.stateDir, options.key, options.connectionLineBase)
    if (!connection) return closed()
    reason = 'ad-unavailable'
    const before = await adapters.getRow()
    reason = 'life-changed'
    if (!sameLife(before, options.expectedRow, options.key)) return closed()
    reason = 'journal-unreadable'
    const journal = join(options.stateDir, 'queue', `${options.key}.jsonl`)
    // Missing/unreadable live input never becomes an empty, apparently ready queue.
    const bytes = readFileSync(journal)
    reason = 'replay-failed'
    const counts = await replayCounts(bytes, options, adapters)
    candidates = counts.candidates
    open = counts.open
    reason = 'journal-changed'
    if (!readFileSync(journal).equals(bytes)) return closed()
    reason = 'candidates'
    if (candidates !== 0) return closed()
    reason = 'open-work'
    if (open !== 0) return closed()
    reason = 'receipts'
    auditReceipts(options, readTranscripts(options.transcripts, adapters.receipts), adapters.receipts)
    reason = 'ad-unavailable'
    const after = await adapters.getRow()
    reason = 'life-changed'
    if (!sameLife(after, before, options.key) || !sameLife(after, options.expectedRow, options.key)) return closed()
    reason = 'ad-not-waiting'
    if (after.state !== 'waiting') return closed()
    reason = 'connection-changed'
    if (connectionVersion(options.stateDir, options.key, options.connectionLineBase) !== connection) return closed()
    reason = 'journal-changed'
    if (!readFileSync(journal).equals(bytes)) return closed()
    return { ready: true, reason: 'ready', candidates, open }
  } catch { return closed() }
}

function within(root: string, path: string): boolean {
  const rel = relative(realpathSync(root), realpathSync(path))
  return rel !== '' && rel !== '..' && !rel.startsWith('../') && !isAbsolute(rel)
}

if (import.meta.main) {
  try {
    if (!existsSync('/etc/cscb-ci-image')) throw new Error('CI image required')
    const [command, stateDir, key, shimLog, root, count, scratchDir, adBinary, rowFile, lineBase] = process.argv.slice(2)
    const home = process.env.HOME
    if (command !== 'admission' || !stateDir || !key || !shimLog || !root || !count || !scratchDir || !adBinary || !rowFile
      || !home || !within(scratchDir, home) || !within(scratchDir, stateDir) || !within(home, adBinary)) throw new Error('Invalid scenario containment')
    const pkg = resolve(process.env.CSCB_PKG_DIR ?? '/test-repo/node_modules/claude-slack-channel-bots')
    const { createDeliveryQueue } = await import(join(pkg, 'src/delivery-queue.ts'))
    const receipts = await packedReceiptAdapters(pkg)
    const getRow = (): Promise<AdmissionRow> => new Promise((resolveRow, reject) => {
      execFile(adBinary, ['get', '--instance-id', `cscb_${key}`], {
        timeout: 10000, maxBuffer: 1024 * 1024,
        env: { HOME: home, PATH: process.env.PATH, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME },
      }, (error, stdout) => {
        if (error) { reject(new Error('AD observation unavailable')); return }
        try { resolveRow(JSON.parse(stdout)) } catch { reject(new Error('AD observation invalid')) }
      })
    })
    const result = await checkAc76Admission({ stateDir, key, shimLog, transcripts: transcriptFiles(root),
      expectedCount: Number(count), scratchDir, expectedRow: JSON.parse(readFileSync(rowFile, 'utf8')),
      connectionLineBase: Number(lineBase), now: Date.now,
    }, { createDeliveryQueue, receipts, getRow })
    // Fixed reason codes and numeric counts only; no journal, AD or error payloads.
    console.log(`recorded: AC76 admission ${JSON.stringify(result)}`)
    process.exit(result.ready ? 0 : 1)
  } catch {
    console.error('recorded: AC76 admission unavailable')
    process.exit(1)
  }
}
