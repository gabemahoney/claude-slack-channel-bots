import { closeSync, existsSync, fstatSync, openSync, renameSync, rmSync, writeSync } from 'node:fs'

// --- Logging ---

// Size-based rotation of the active log file. Rotation ships with the package
// so it applies on every machine that runs CSCB (no per-host logrotate config).
//
// When the active file crosses ROTATE_THRESHOLD_BYTES, it is renamed to
// `<path>.1`, the previous `.1`→`.2`, … up to ROTATE_KEEP generations; the
// oldest generation beyond that is discarded. Thresholds/generations are
// overridable via env for ops tuning:
//   CSCB_LOG_MAX_BYTES  — rotate when the active file reaches N bytes
//                         (default 10 MiB; values <= 0 or non-numeric ignored)
//   CSCB_LOG_KEEP        — number of rotated generations to retain
//                         (default 5; values < 0 or non-numeric ignored)
const DEFAULT_ROTATE_THRESHOLD_BYTES = 10 * 1024 * 1024
const DEFAULT_ROTATE_KEEP = 5

function rotateThresholdBytes(): number {
  const raw = process.env['CSCB_LOG_MAX_BYTES']
  if (raw !== undefined) {
    const n = Number(raw)
    if (Number.isFinite(n) && n > 0) return n
  }
  return DEFAULT_ROTATE_THRESHOLD_BYTES
}

function rotateKeep(): number {
  const raw = process.env['CSCB_LOG_KEEP']
  if (raw !== undefined) {
    const n = Number(raw)
    if (Number.isFinite(n) && n >= 0) return Math.floor(n)
  }
  return DEFAULT_ROTATE_KEEP
}

let fd: number | null = null
let currentPath: string | null = null
const originalConsoleError = console.error
const originalConsoleLog = console.log

function formatArgs(args: unknown[]): string {
  return args
    .map(arg => {
      if (typeof arg === 'string') return arg
      if (arg instanceof Error) return `${arg.name}: ${arg.message}\n${arg.stack ?? ''}`
      if (arg !== null && typeof arg === 'object') return JSON.stringify(arg)
      return String(arg)
    })
    .join(' ')
}

/**
 * Roll the active log file if it has grown past the threshold. Called before
 * each write. Best-effort: it never throws into the caller's hot path.
 *
 * Rotation closes the active fd (so the rename releases the write handle),
 * shifts the generations, and reopens a fresh active file. If that final
 * reopen fails (transient ENOSPC/EMFILE/permissions), `fd` is left null and
 * the write falls back to console for this call — but recovery is NOT lost:
 * `currentPath` is retained, so `makeLogFn` attempts to reopen on the next
 * write once the condition clears, and file logging resumes automatically.
 */
function maybeRotate(): void {
  if (fd === null || currentPath === null) return
  let size: number
  try {
    size = fstatSync(fd).size
  } catch {
    return
  }
  if (size < rotateThresholdBytes()) return

  const path = currentPath
  const keep = rotateKeep()
  try {
    // Close the active fd so the rename releases the write handle.
    closeSync(fd)
    fd = null

    if (keep === 0) {
      // Retain nothing: truncate by replacing the file outright.
      try { rmSync(path, { force: true }) } catch { /* ignore */ }
    } else {
      // Drop the oldest generation, then shift .N-1 → .N down to .1.
      try { rmSync(`${path}.${keep}`, { force: true }) } catch { /* ignore */ }
      for (let i = keep - 1; i >= 1; i--) {
        const from = `${path}.${i}`
        if (existsSync(from)) {
          try { renameSync(from, `${path}.${i + 1}`) } catch { /* ignore */ }
        }
      }
      try { renameSync(path, `${path}.1`) } catch { /* ignore */ }
    }
  } catch {
    // Fall through to reopen below regardless of rotation success.
  }

  // Reopen a fresh active file (append mode; new inode after the rename).
  try {
    fd = openSync(path, 'a')
  } catch {
    fd = null
  }
}

function makeLogFn(original: (...args: unknown[]) => void): (...args: unknown[]) => void {
  return (...args: unknown[]): void => {
    const timestamp = new Date().toISOString()
    const message = formatArgs(args)
    const line = `[${timestamp}] ${message}`
    // Recover a dropped fd: if a prior rotation reopen failed but the target
    // path is still known, retry the open here. Best-effort — a failure leaves
    // fd null and we fall back to console for this write, retrying next time.
    if (fd === null && currentPath !== null) {
      try {
        fd = openSync(currentPath, 'a')
      } catch {
        fd = null
      }
    }
    if (fd !== null) {
      try {
        maybeRotate()
        if (fd !== null) {
          writeSync(fd, line + '\n')
          return
        }
      } catch {
        // fall through to original
      }
    }
    original(...args)
  }
}

export function initLogging(logFilePath: string): void {
  if (fd !== null) {
    try { closeSync(fd) } catch { /* ignore */ }
  }
  fd = openSync(logFilePath, 'a')
  currentPath = logFilePath
  console.error = makeLogFn(originalConsoleError) as typeof console.error
  console.log = makeLogFn(originalConsoleLog) as typeof console.log
}
