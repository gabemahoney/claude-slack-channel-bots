/** Test32 and test103 pre-sample admission. Replay only a private copy of the real journal;
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
  | 'ad-unavailable' | 'life-changed' | `ad-state:${string}` | 'ad-not-waiting' | 'journal-unreadable' | 'journal-changed'
  | 'replay-failed' | 'candidates' | 'open-work' | 'receipts'
export interface AdmissionResult { ready: boolean; reason: AdmissionReason; candidates: number | null; open: number | null }

/** The same native life: instance, session, start, launch and tagged prompt. */
function sameLife(row: AdmissionRow, expected: AdmissionRow, key: string): boolean {
  return row?.instance_id === `cscb_${key}` && row.instance_id === expected?.instance_id
    && typeof row.session_id === 'string' && row.session_id.length > 0 && row.session_id === expected.session_id
    && typeof row.started_at === 'string' && row.started_at.length > 0 && row.started_at === expected.started_at
    && (row.launch_started_at ?? null) === (expected.launch_started_at ?? null)
    && row.labels?.tag_prompt === '1'
}

/** A live life's state outside waiting/working (check_permission, ask_user, …)
 * is reported as itself, never as a changed life. Unrecognised text stays fixed. */
function stateReason(row: AdmissionRow): AdmissionReason | undefined {
  if (['waiting', 'working'].includes(row.state)) return undefined
  return `ad-state:${typeof row.state === 'string' && /^[a-z_]{1,32}$/.test(row.state) ? row.state : 'unreadable'}`
}

export const ADMISSION_ROW_MAX_REQUESTS = 20

/** Bounded AD row projection for an admission timeout: state, family and
 * request tools/verdicts only; no tool input, arguments or other payloads. */
export function projectAdmissionRow(row: unknown): Record<string, unknown> {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return { unavailable: true }
  const value = row as Record<string, unknown>
  const word = (v: unknown, pattern: RegExp) => typeof v === 'string' && pattern.test(v) ? v : v === null || v === undefined ? null : 'unreadable'
  // At most ADMISSION_ROW_MAX_REQUESTS entries per list, each a few bounded
  // words, with the list's total: the line stays a few KB whatever AD holds.
  const requests = (list: unknown) => Array.isArray(list)
    ? { total: list.length, shown: list.slice(0, ADMISSION_ROW_MAX_REQUESTS).map(r => r && typeof r === 'object' ? {
        tool_name: word((r as any).tool_name, /^[A-Za-z0-9_.:-]{1,128}$/),
        requested_at: word((r as any).requested_at, /^[0-9T:.+Z-]{1,40}$/),
        decision: word((r as any).decision, /^[a-z_]{1,32}$/),
      } : 'unreadable') }
    : list === undefined ? null : 'unreadable'
  return {
    state: word(value.state, /^[a-z_]{1,32}$/),
    state_changed_at: word(value.state_changed_at, /^[0-9T:.+Z-]{1,40}$/),
    family_state: word(value.family_state, /^[a-z_]{1,32}$/),
    tag_prompt: word((value.labels as Record<string, unknown> | undefined)?.tag_prompt, /^[0-9]{1,3}$/),
    permission_requests: requests(value.permission_requests),
    unproven_requests: requests(value.unproven_requests),
  }
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
    reason = stateReason(before) ?? reason
    if (reason !== 'life-changed') return closed()
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
    reason = stateReason(after) ?? reason
    if (reason !== 'life-changed') return closed()
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
    if (process.argv[2] === 'row' && process.argv.length === 4) {
      // Timeout diagnostic: `row <AD get output file>`, the projection only.
      let row: unknown
      try { row = JSON.parse(readFileSync(process.argv[3]!, 'utf8')) } catch { row = undefined }
      console.log(`recorded: AC76 AD row ${JSON.stringify(projectAdmissionRow(row))}`)
      process.exit(0)
    }
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
