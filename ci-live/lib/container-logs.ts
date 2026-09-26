/**
 * container-logs.ts — the test container's own logs, copied into the results
 * before the container is removed or stopped (b.1cx). Without them a failed
 * check can't be traced once the container is gone: run.log and
 * container.log (docker logs, the entrypoint's output) hold neither CSCB's
 * nor agent-director's logs. Copied, from the test user's home:
 * - CSCB's state dir (`$S` in the helpers, `CONTAINER_STATE_DIR`):
 *   `server.log` and its rotated generations (`server.log.1` …),
 *   `startup-errors.log`, `cron.log` (the default `cron_log_path`, beside
 *   config.json: the runner's config sets none) and `permission-trail.jsonl`;
 * - `~/cscb-live/boot-start.log`: the output of the server the entrypoint
 *   starts at boot (Check 28's reboot);
 * - agent-director's `~/.agent-director/errors.log` and `ad-trail.jsonl`.
 *
 * How:
 * - One `docker exec` per file (the one exec path, lib/container.ts), read
 *   into memory. At most the last `CONTAINER_LOG_MAX_BYTES` of a file are
 *   read, so a runaway log can't blow up the runner's memory.
 * - A copy keeps only whole lines. A file cut at the cap loses its partial
 *   first line, so no tail of a secret is left for the redactor to miss; an
 *   unterminated last line (one still being written when it was read) is
 *   left out too, so no prefix of a secret that is not token-shaped is kept.
 *   Both are noted.
 * - Only a regular file is read: a missing one is noted, a symlink or
 *   anything else is skipped and noted, never followed.
 * - Each copy goes through the run's redactor as one text, so a registered
 *   value spanning a line break is masked too. The copies are written mode
 *   600 in `RESULTS_DIR/container-logs/` (mode 700), beside `index.txt`,
 *   which says what was copied, cut, missing, skipped or not copied. The
 *   closing secrecy scan covers them like every other output.
 * - A failure to copy is logged and never changes the verdict.
 *   `ContainerLogCollector` copies once, however many cleanup paths ask, and
 *   each caller waits only as long as it can afford (`CONTAINER_LOGS_WAIT_MS`,
 *   a memory watchdog stop `CONTAINER_LOGS_URGENT_WAIT_MS`); the copy goes on
 *   after a caller stops waiting, and a later caller waits for that same
 *   copy. Nothing is written once `seal` is called (the closing scan is
 *   about to read the results), so a copy nobody waits for any more can't
 *   add a file the scan never saw.
 *
 * File writes go through `ContainerLogsSink`, the container through
 * `ContainerExec` and a caller's wait through `CollectorClock`, so tests use
 * fakes (the shared fake clock drives a caller's bound).
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import type { ContainerExec } from './container.ts'
import { CONTAINER_HOME } from './docker.ts'
import { describeError } from './errors.ts'
import { CONTAINER_STATE_DIR } from './live-config.ts'
import type { RunLog } from './log.ts'
import { formatBytes } from './memory-watchdog.ts'
import type { ProcResult } from './proc.ts'
import type { Redactor } from './redact.ts'

/** The results dir's subdirectory the copies go in. */
export const CONTAINER_LOGS_DIR = 'container-logs'

/** The list of what was copied, beside the copies. */
export const CONTAINER_LOGS_INDEX = 'index.txt'

/**
 * The most of one file that is read: its last 20 MiB. CSCB rotates server.log
 * at 10 MiB, so in practice only an unrotated file (cron.log, the trails,
 * agent-director's errors.log) is ever cut.
 */
export const CONTAINER_LOG_MAX_BYTES = 20 * 1024 * 1024

/**
 * A dry run's cap: 1 MiB. Its self-test plants a log over the cap to prove
 * the cut; at the real cap that fixture would add 20 MiB to every dry run's
 * kept results.
 */
export const DRY_RUN_CONTAINER_LOG_MAX_BYTES = 1024 * 1024

/** At most this many rotated server.log generations are copied, the newest first (CSCB keeps 5 by default). */
export const MAX_ROTATED_SERVER_LOGS = 10

/** One file's `docker exec` time limit. */
export const CONTAINER_LOG_EXEC_TIMEOUT_MS = 30_000

/** How long a cleanup waits for the copy before it removes or stops the container anyway. */
export const CONTAINER_LOGS_WAIT_MS = 60_000

/** The same on a memory watchdog stop, which must not hang (Chrome is closing meanwhile): a short wait. */
export const CONTAINER_LOGS_URGENT_WAIT_MS = 15_000

/** agent-director's directory in the container (the test user's `~/.agent-director`). */
export const CONTAINER_AGENT_DIRECTOR_DIR = `${CONTAINER_HOME}/.agent-director`

/** The runner's work dir in the container (the test user's `~/cscb-live`), where the boot start logs. */
export const CONTAINER_CSCB_LIVE_DIR = `${CONTAINER_HOME}/cscb-live`

export interface ContainerLogFile {
  /** The copy's name in container-logs/. */
  name: string
  /** The file's absolute path in the container. */
  path: string
}

function inStateDir(name: string): ContainerLogFile {
  return { name, path: `${CONTAINER_STATE_DIR}/${name}` }
}

/** The active server log. Its rotated generations are listed when the copy is made. */
export const SERVER_LOG: ContainerLogFile = inStateDir('server.log')

/** Every other file copied, after the server logs. */
export const OTHER_LOG_FILES: readonly ContainerLogFile[] = [
  inStateDir('startup-errors.log'),
  inStateDir('cron.log'),
  inStateDir('permission-trail.jsonl'),
  // The server the entrypoint starts at boot logs its output here (docker/live/entrypoint.sh; Check 28).
  { name: 'boot-start.log', path: `${CONTAINER_CSCB_LIVE_DIR}/boot-start.log` },
  { name: 'agent-director-errors.log', path: `${CONTAINER_AGENT_DIRECTOR_DIR}/errors.log` },
  { name: 'agent-director-ad-trail.jsonl', path: `${CONTAINER_AGENT_DIRECTOR_DIR}/ad-trail.jsonl` },
]

/** A copy's file name: plain, so it can never point outside container-logs/. */
const COPY_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/

/** A rotated generation's name, `server.log.<suffix>` (CSCB writes `server.log.1` …). Anything else is skipped. */
const ROTATED_SERVER_LOG_RE = /^server\.log\.[A-Za-z0-9_-][A-Za-z0-9._-]{0,63}$/

/**
 * Prints the names in the directory $1 that match `server.log.*`, one per
 * line, a symlink or other non-regular entry included (the read skips it).
 * Nothing when the directory is not there.
 */
export const LIST_ROTATED_SCRIPT = [
  'cd -- "$1" 2>/dev/null || exit 0',
  'for f in server.log.*; do if [ -e "$f" ] || [ -L "$f" ]; then printf \'%s\\n\' "$f"; fi; done',
].join('\n')

/**
 * Reads the regular file $1, keeping at most its last $2 bytes. Prints a
 * first line `<size> <cut>` (the file's size, taken once, and how many bytes
 * before the kept part are left out), then the kept bytes, up to that size
 * (a log growing meanwhile adds nothing past it). With a cut, the byte just
 * before the kept part comes first, so the reader can tell whether the kept
 * part starts on a whole line. Exit 3: not there; 4: not a regular file (a
 * symlink is never followed); 5: its size could not be read; 6: not
 * readable.
 */
export const READ_LOG_SCRIPT = [
  'f=$1; n=$2',
  'if [ -L "$f" ]; then exit 4; fi',
  'if [ ! -e "$f" ]; then exit 3; fi',
  'if [ ! -f "$f" ]; then exit 4; fi',
  'if [ ! -r "$f" ]; then exit 6; fi',
  's=$(stat -c %s -- "$f") || exit 5',
  'k=0; if [ "$s" -gt "$n" ]; then k=$((s - n)); fi',
  'printf \'%s %s\\n\' "$s" "$k"',
  'if [ "$k" -gt 0 ]; then tail -c +"$k" -- "$f" | head -c "$((s - k + 1))"; else head -c "$s" -- "$f"; fi',
].join('\n')

/** The argv that reads one file in the container (its path and the cap as arguments, never in the script). */
export function readLogArgv(path: string, maxBytes: number): string[] {
  return ['bash', '-c', READ_LOG_SCRIPT, 'read', path, String(maxBytes)]
}

/** The argv that lists the rotated server logs. */
export function listRotatedArgv(): string[] {
  return ['bash', '-c', LIST_ROTATED_SCRIPT, 'list', CONTAINER_STATE_DIR]
}

// ---------------------------------------------------------------------------
// Reading one file
// ---------------------------------------------------------------------------

/**
 * Why a `docker exec` failed, from its exit code and docker's own error (never
 * echoed): a stopped container can't be read (its logs are then lost with it).
 */
export function execFailure(r: ProcResult): string {
  if (r.timedOut) return 'docker exec timed out'
  if (/is not running/i.test(r.stderr)) return `the container is not running (docker exec exit ${r.code})`
  if (/No such container/i.test(r.stderr)) return `the container is gone (docker exec exit ${r.code})`
  return `docker exec exit ${r.code}`
}

export type LogRead =
  /** `content` holds the kept bytes, preceded by the byte before them when `cut` > 0. */
  | { kind: 'read'; size: number; cut: number; content: string }
  | { kind: 'missing' }
  | { kind: 'skipped'; reason: string }
  | { kind: 'failed'; reason: string }

/** What one `READ_LOG_SCRIPT` exec came to. */
export function parseLogRead(r: ProcResult): LogRead {
  if (r.timedOut) return { kind: 'failed', reason: execFailure(r) }
  if (r.code === 3) return { kind: 'missing' }
  if (r.code === 4) return { kind: 'skipped', reason: 'not a regular file (a symlink is never followed)' }
  if (r.code === 6) return { kind: 'skipped', reason: 'not readable by the test user' }
  if (r.code !== 0) return { kind: 'failed', reason: execFailure(r) }
  const nl = r.stdout.indexOf('\n')
  const m = /^(\d{1,15}) (\d{1,15})$/.exec(nl === -1 ? '' : r.stdout.slice(0, nl))
  if (!m) return { kind: 'failed', reason: 'no size line' }
  const size = Number(m[1])
  const cut = Number(m[2])
  if (cut > size) return { kind: 'failed', reason: 'a cut past the size' }
  return { kind: 'read', size, cut, content: r.stdout.slice(nl + 1) }
}

export interface WholeLines {
  /** The whole lines kept, each with its line break. */
  text: string
  /** The bytes of an unterminated last line left out (0: none). */
  unterminated: number
}

/**
 * The whole lines of what was read. With a cut, `content` starts with the
 * byte before the kept part: everything up to its first line break is
 * dropped (only that byte when it is the break itself, so a kept part that
 * starts on a whole line keeps it). No break at all then: nothing is kept.
 * An unterminated last line (no break after it: a line still being written,
 * or a file that does not end with a break) is left out and counted, so no
 * prefix of a secret is kept for the redactor to miss.
 */
export function wholeLines(content: string, cut: number): WholeLines {
  const start = cut === 0 ? 0 : content.indexOf('\n') + 1
  if (cut > 0 && start === 0) return { text: '', unterminated: 0 }
  const end = content.lastIndexOf('\n') + 1
  return { text: content.slice(start, end), unterminated: Buffer.byteLength(content.slice(Math.max(start, end))) }
}

// ---------------------------------------------------------------------------
// The rotated server logs
// ---------------------------------------------------------------------------

export interface RotatedServerLogs {
  /** The generations to copy, the newest (`server.log.1`) first. */
  files: ContainerLogFile[]
  /** Entries whose name is not a plain `server.log.<suffix>`: not copied. */
  unexpected: number
  /** Generations past `MAX_ROTATED_SERVER_LOGS`: not copied. */
  beyondCap: number
}

function generation(name: string): number {
  const m = /^server\.log\.([1-9][0-9]{0,5})$/.exec(name)
  return m ? Number(m[1]) : Number.POSITIVE_INFINITY
}

/** The rotated server logs `LIST_ROTATED_SCRIPT` printed: numbered generations in order, then any other suffix by name. */
export function rotatedServerLogs(stdout: string): RotatedServerLogs {
  const names = [...new Set(stdout.split('\n').map((s) => s.trim()).filter(Boolean))]
  const plain = names.filter((n) => ROTATED_SERVER_LOG_RE.test(n))
  plain.sort((a, b) => {
    const [ga, gb] = [generation(a), generation(b)]
    if (ga !== gb) return ga < gb ? -1 : 1
    return a < b ? -1 : a > b ? 1 : 0
  })
  return {
    files: plain.slice(0, MAX_ROTATED_SERVER_LOGS).map(inStateDir),
    unexpected: names.length - plain.length,
    beyondCap: Math.max(0, plain.length - MAX_ROTATED_SERVER_LOGS),
  }
}

// ---------------------------------------------------------------------------
// The copy
// ---------------------------------------------------------------------------

export type LogOutcome =
  | (ContainerLogFile & {
      status: 'copied'
      /** The file's size when it was read. */
      size: number
      /** The bytes kept (before redaction). */
      kept: number
      /** Only its last `cap` bytes were read, from their first whole line. */
      cut: boolean
      cap: number
      /** The bytes of its unterminated last line, left out (0: it ended with a line break). */
      unterminated: number
    })
  | (ContainerLogFile & { status: 'missing' })
  | (ContainerLogFile & { status: 'skipped' | 'failed'; reason: string })

/** Where the copies go. */
export interface ContainerLogsSink {
  /** The directory the copies are written in (for log lines). */
  readonly dir: string
  /** Write one copy, mode 600, creating the directory (mode 700) first. Throws on a failure. */
  write(name: string, content: string): void
}

/** The real sink: `<resultsDir>/container-logs/`, mode 700, each copy mode 600 and new (never written over). */
export function containerLogsSink(resultsDir: string): ContainerLogsSink {
  const dir = join(resultsDir, CONTAINER_LOGS_DIR)
  return {
    dir,
    write(name, content) {
      if (!COPY_NAME_RE.test(name)) throw new Error('a container log copy needs a plain file name')
      mkdirSync(dir, { recursive: true, mode: 0o700 })
      writeFileSync(join(dir, name), content, { mode: 0o600, flag: 'wx' })
    },
  }
}

export interface CollectOptions {
  container: Pick<ContainerExec, 'exec'>
  redactor: Redactor
  sink: ContainerLogsSink
  /** False from the moment nothing more may be written (the closing scan is about to read the results). */
  writable: () => boolean
  maxBytes?: number
  execTimeoutMs?: number
}

const NOT_WRITTEN = 'the results were already being written'

/** One line per outcome, for index.txt and run.log. */
export function describeLogOutcome(o: LogOutcome): string {
  switch (o.status) {
    case 'copied': {
      const tail = o.unterminated > 0 ? `; its unterminated last line (${o.unterminated} bytes, perhaps still being written) left out` : ''
      return o.cut
        ? `${o.name}: cut: its last ${formatBytes(o.kept)} (${o.kept} of ${o.size} bytes), from the first whole line within the ${formatBytes(o.cap)} cap${tail} (${o.path})`
        : `${o.name}: copied, ${o.kept} bytes${tail} (${o.path})`
    }
    case 'missing':
      return `${o.name}: not there (${o.path})`
    case 'skipped':
      return `${o.name}: skipped: ${o.reason} (${o.path})`
    case 'failed':
      return `${o.name}: not copied: ${o.reason} (${o.path})`
  }
}

/** The run.log summary of a copy. */
export function summarizeLogOutcomes(outcomes: readonly LogOutcome[], dir: string): string {
  const count = (status: LogOutcome['status']): number => outcomes.filter((o) => o.status === status).length
  const cut = outcomes.filter((o) => o.status === 'copied' && o.cut).length
  return (
    `container logs: ${count('copied')} copied${cut > 0 ? ` (${cut} cut to its last whole lines within the cap)` : ''}, ` +
    `${count('missing')} not there, ${count('skipped')} skipped, ${count('failed')} not copied, in ${dir} (${CONTAINER_LOGS_INDEX} lists each)`
  )
}

async function copyOne(file: ContainerLogFile, o: CollectOptions, maxBytes: number, timeoutMs: number): Promise<LogOutcome> {
  if (!o.writable()) return { ...file, status: 'failed', reason: NOT_WRITTEN }
  let r: ProcResult
  try {
    r = await o.container.exec(readLogArgv(file.path, maxBytes), { timeoutMs })
  } catch (err) {
    return { ...file, status: 'failed', reason: describeError(err) }
  }
  const read = parseLogRead(r)
  if (read.kind === 'missing') return { ...file, status: 'missing' }
  if (read.kind !== 'read') return { ...file, status: read.kind, reason: read.reason }
  const kept = wholeLines(read.content, read.cut)
  // Redacted whole, not line by line: a registered value spanning a line break is masked too.
  const copy = o.redactor.redact(kept.text)
  if (!o.writable()) return { ...file, status: 'failed', reason: NOT_WRITTEN }
  try {
    o.sink.write(file.name, copy)
  } catch (err) {
    return { ...file, status: 'failed', reason: `could not be written: ${describeError(err)}` }
  }
  return { ...file, status: 'copied', size: read.size, kept: Buffer.byteLength(kept.text), cut: read.cut > 0, cap: maxBytes, unterminated: kept.unterminated }
}

/** The rotated server logs to copy, and an outcome for any listed entry that is not copied. */
async function listRotated(o: CollectOptions, timeoutMs: number): Promise<{ files: ContainerLogFile[]; notes: LogOutcome[] }> {
  const all: ContainerLogFile = { name: 'server.log.*', path: `${CONTAINER_STATE_DIR}/server.log.*` }
  let r: ProcResult
  try {
    r = await o.container.exec(listRotatedArgv(), { timeoutMs })
  } catch (err) {
    return { files: [], notes: [{ ...all, status: 'failed', reason: `the rotated server logs could not be listed: ${describeError(err)}` }] }
  }
  if (r.timedOut || r.code !== 0) {
    return { files: [], notes: [{ ...all, status: 'failed', reason: `the rotated server logs could not be listed (${execFailure(r)})` }] }
  }
  const rotated = rotatedServerLogs(r.stdout)
  const notes: LogOutcome[] = []
  if (rotated.unexpected > 0) notes.push({ ...all, status: 'skipped', reason: `${rotated.unexpected} entr${rotated.unexpected === 1 ? 'y' : 'ies'} not named server.log.<generation>` })
  if (rotated.beyondCap > 0) notes.push({ ...all, status: 'skipped', reason: `${rotated.beyondCap} generation(s) past the newest ${MAX_ROTATED_SERVER_LOGS}` })
  return { files: rotated.files, notes }
}

/**
 * Copy every log file out of the container, one at a time, then write
 * index.txt. Only one file is held at once, as a few strings of at most
 * about the cap each (what was read, its whole lines and their redacted
 * copy). Never throws: every failure is an outcome.
 */
export async function collectContainerLogs(o: CollectOptions): Promise<LogOutcome[]> {
  const maxBytes = o.maxBytes ?? CONTAINER_LOG_MAX_BYTES
  const timeoutMs = o.execTimeoutMs ?? CONTAINER_LOG_EXEC_TIMEOUT_MS
  const rotated = await listRotated(o, timeoutMs)
  const outcomes: LogOutcome[] = []
  for (const file of [SERVER_LOG, ...rotated.files, ...OTHER_LOG_FILES]) outcomes.push(await copyOne(file, o, maxBytes, timeoutMs))
  outcomes.push(...rotated.notes)
  if (o.writable()) {
    const index = [
      `The test container's own logs, copied before it was removed or stopped: each redacted, each file at most its last ${formatBytes(maxBytes)}, whole lines only (a partial first line at a cut and an unterminated last line left out).`,
      ...outcomes.map(describeLogOutcome),
      '',
    ].join('\n')
    try {
      o.sink.write(CONTAINER_LOGS_INDEX, o.redactor.redact(index))
    } catch {
      /* the outcomes still reach run.log */
    }
  }
  return outcomes
}

// ---------------------------------------------------------------------------
// One copy per run
// ---------------------------------------------------------------------------

/**
 * The timer a caller's wait runs on. Injected, so a test drives a caller's
 * bound on a fake clock (the shared fake clock fits it as it is).
 */
export interface CollectorClock {
  setTimeout(callback: () => void, delayMs: number): unknown
  clearTimeout(handle: unknown): void
}

export const realCollectorClock: CollectorClock = {
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
}

/** True when `work` settles within `ms` on `clock`; the timer is always cleared. */
async function settlesWithin(work: Promise<void>, ms: number, clock: CollectorClock): Promise<boolean> {
  let timer: unknown
  const late = new Promise<boolean>((resolve) => {
    timer = clock.setTimeout(() => resolve(false), ms)
  })
  try {
    return await Promise.race([work.then(() => true), late])
  } finally {
    clock.clearTimeout(timer)
  }
}

export interface CollectorDeps {
  redactor: Redactor
  sink: ContainerLogsSink
  log: Pick<RunLog, 'info' | 'detail' | 'error'>
  maxBytes?: number
  execTimeoutMs?: number
  /** The timer a caller's wait runs on (default: the real one). */
  clock?: CollectorClock
}

export class ContainerLogCollector {
  private running: Promise<void> | null = null
  private settled = false
  private sealed = false
  private result: LogOutcome[] | null = null
  private readonly clock: CollectorClock

  constructor(private readonly deps: CollectorDeps) {
    this.clock = deps.clock ?? realCollectorClock
  }

  /** What the copy came to; `null` until it has finished, and when no container was started. */
  get outcomes(): readonly LogOutcome[] | null {
    return this.result
  }

  /**
   * Copy the container's logs, once: a later call waits for the same copy
   * (in flight or done). The caller waits at most `waitMs` on the clock
   * (`CONTAINER_LOGS_WAIT_MS`, a memory watchdog stop
   * `CONTAINER_LOGS_URGENT_WAIT_MS`); the copy goes on after that, and each
   * file it finishes before `seal` is written. `container` is `null` when
   * none was started: nothing to copy. Never throws.
   */
  async collect(container: Pick<ContainerExec, 'exec'> | null, waitMs: number): Promise<void> {
    if (this.sealed && this.running === null) return
    this.running ??= this.run(container)
    if (!(await settlesWithin(this.running, waitMs, this.clock)) && !this.sealed) {
      this.deps.log.error(`container logs: not all copied within ${Math.round(waitMs / 1000)} s; going on without them (what is copied before the results are written is kept)`)
    }
  }

  /** Nothing is written from now on: the closing scan is about to read the results. */
  seal(): void {
    if (this.sealed) return
    this.sealed = true
    if (this.running !== null && !this.settled) {
      this.deps.log.error(`container logs: still copying when the results were written; nothing more is copied (${CONTAINER_LOGS_DIR}/ holds what was)`)
    }
  }

  private async run(container: Pick<ContainerExec, 'exec'> | null): Promise<void> {
    try {
      if (container === null) {
        this.deps.log.info('container logs: none to copy (no test container was started)')
        return
      }
      const outcomes = await collectContainerLogs({
        container,
        redactor: this.deps.redactor,
        sink: this.deps.sink,
        writable: () => !this.sealed,
        maxBytes: this.deps.maxBytes,
        execTimeoutMs: this.deps.execTimeoutMs,
      })
      this.result = outcomes
      if (this.sealed) return
      this.deps.log.info(summarizeLogOutcomes(outcomes, this.deps.sink.dir))
      for (const o of outcomes) this.deps.log.detail(`container logs: ${describeLogOutcome(o)}`)
    } catch (err) {
      if (!this.sealed) this.deps.log.error(`container logs: the copy failed: ${describeError(err)}`)
    } finally {
      this.settled = true
    }
  }
}
