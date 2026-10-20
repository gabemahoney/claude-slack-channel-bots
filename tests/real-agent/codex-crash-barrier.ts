/** Private D1 crash-worker protocol. No streams, arguments, bodies or arbitrary
 * errors enter it. Readers project an exact bounded schema before reporting. */
import { closeSync, constants, fstatSync, openSync, readSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'

export type CrashProgress = {
  version: 1; pid: number; instance: 'cscb_codex_gate'; stage: string
  firstSeq: number | null; successorSeq: number | null
  prepared: boolean; clientReady: boolean; queueReady: boolean
  textStarted: boolean; textReturned: boolean; failed: boolean; errors: number; error: string
}
const stages = ['startup', 'prepared', 'modules-ready', 'client-ready', 'queue-ready', 'first-accepted',
  'successor-accepted', 'text-call-start', 'text-call-return', 'barrier-published']
const errors = ['none', 'preparation', 'ErrDialogMaybeOpen', 'ErrInvalidFlags', 'ErrSendKeysWhileRelayed', 'ErrRelayFallenBack', 'other']

export function projectCrashProgress(value: unknown, pid: number, instance: string): CrashProgress {
  const v = value as CrashProgress
  const integer = (n: unknown) => Number.isSafeInteger(n) && Number(n) > 0
  if (!v || typeof v !== 'object' || Array.isArray(v)
    || Object.keys(v).sort().join(',') !== 'clientReady,error,errors,failed,firstSeq,instance,pid,prepared,queueReady,stage,successorSeq,textReturned,textStarted,version'
    || v.version !== 1 || !integer(v.pid) || v.pid !== pid || v.instance !== 'cscb_codex_gate' || v.instance !== instance
    || !stages.includes(v.stage) || !errors.includes(v.error)
    || ![v.firstSeq, v.successorSeq].every(n => n === null || integer(n))
    || (v.successorSeq !== null && (v.firstSeq === null || v.successorSeq <= v.firstSeq))
    || typeof v.textStarted !== 'boolean' || typeof v.textReturned !== 'boolean' || (v.textReturned && !v.textStarted)
    || typeof v.failed !== 'boolean'
    || ![v.prepared, v.clientReady, v.queueReady].every(n => typeof n === 'boolean')
    || !Number.isSafeInteger(v.errors) || v.errors < 0 || v.errors > 1000000) throw new Error('invalid crash checkpoint')
  return { version: 1, pid: v.pid, instance: v.instance, stage: v.stage, firstSeq: v.firstSeq, successorSeq: v.successorSeq,
    prepared: v.prepared, clientReady: v.clientReady, queueReady: v.queueReady,
    textStarted: v.textStarted, textReturned: v.textReturned, failed: v.failed, errors: v.errors, error: v.error }
}

export function publishCrashProgress(file: string, progress: CrashProgress) {
  const safe = projectCrashProgress(progress, progress.pid, progress.instance), temporary = `${file}.${progress.pid}.tmp`
  try {
    writeFileSync(temporary, JSON.stringify(safe), { mode: 0o600, flag: 'wx' })
    renameSync(temporary, file)
  } finally {
    try { unlinkSync(temporary) } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e }
  }
}

export function readCrashProgress(file: string, pid: number, instance: string): { status: 'missing' | 'invalid' | 'valid'; value?: CrashProgress } {
  let fd: number | undefined
  try {
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    const stat = fstatSync(fd)
    if (!stat.isFile() || stat.size > 2048) return { status: 'invalid' }
    const bytes = Buffer.alloc(2049), n = readSync(fd, bytes, 0, bytes.length, 0)
    if (n > 2048) return { status: 'invalid' }
    return { status: 'valid', value: projectCrashProgress(JSON.parse(bytes.subarray(0, n).toString('utf8')), pid, instance) }
  } catch (e) { return { status: (e as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'invalid' } }
  finally { if (fd !== undefined) closeSync(fd) }
}

/** Both durable IDs and the successful text boundary must exist inside the
 * original shared deadline. Diagnostics precede the caller's failure cleanup. */
export async function waitForCrashBoundary(options: {
  child: { pid: number; exitCode: number | null; signalCode: string | null }
  checkpoint: string; marker: string; instance: string
  journal(): { kind: string; seq: number }[]
  counts(): { queue: number; text: number; enter: number }
  diagnostic(value: unknown): void; bound(): void
  now(): number; sleep(ms: number): Promise<unknown>
}) {
  const end = options.now() + 180000
  let last: CrashProgress | undefined
  let checkpointStatus = 'missing', markerStatus = 'missing'
  const diagnostic = () => {
    const counts = options.counts(), bounded = (n: number) => Number.isSafeInteger(n) && n >= 0 ? Math.min(n, 1000000) : null
    const signal = ['SIGKILL', 'SIGTERM', 'SIGINT', 'SIGABRT', 'SIGSEGV', 'SIGPIPE', 'SIGHUP'].includes(options.child.signalCode ?? '')
      ? options.child.signalCode : options.child.signalCode === null ? null : 'other'
    options.diagnostic({ checkpointStatus, markerStatus, progress: last ?? null,
      exit: Number.isSafeInteger(options.child.exitCode) ? options.child.exitCode : null, signal,
      counts: { queue: bounded(counts.queue), text: bounded(counts.text), enter: bounded(counts.enter) } })
  }
  try {
    while (options.now() < end) {
      // The child publishes its checkpoint before the marker. Read the marker
      // first so a new boundary cannot be compared with an older checkpoint.
      const marker = readCrashProgress(options.marker, options.child.pid, options.instance)
      const checkpoint = readCrashProgress(options.checkpoint, options.child.pid, options.instance)
      checkpointStatus = checkpoint.status; markerStatus = marker.status
      last = checkpoint.value
      if (checkpoint.status === 'invalid' || marker.status === 'invalid') throw new Error('invalid crash protocol')
      if (options.child.exitCode !== null || options.child.signalCode !== null) throw new Error('crash worker exited before text boundary')
      if (marker.value && (!marker.value.textReturned || marker.value.firstSeq === null || marker.value.firstSeq !== last?.firstSeq)) throw new Error('crash marker does not match successful text boundary')
      if (marker.value && last?.textReturned && last.firstSeq !== null && last.successorSeq !== null) {
        const records = options.journal()
        if ([last.firstSeq, last.successorSeq].every(seq => records.some(r => r.kind === 'accepted' && r.seq === seq))
          && options.now() <= end) {
          diagnostic()
          return { firstSeq: last.firstSeq, successorSeq: last.successorSeq }
        }
      }
      await options.sleep(250)
    }
    options.bound()
    throw new Error('real child text barrier: observation incomplete within bound')
  } catch (error) { diagnostic(); throw error }
}
