/**
 * log.ts — the run log. Every progress line and log line /ci-live writes goes
 * through here, and through the redactor, before it reaches stdout or
 * `run.log`.
 *
 * I/O is injected (`write` for the terminal, `append` for the file) so tests
 * can capture both.
 */

import { appendFileSync } from 'node:fs'

import type { Redactor } from './redact.ts'

export interface RunLogDeps {
  redactor: Redactor
  /** Terminal sink (one line, newline added by the log). */
  write: (line: string) => void
  /** File sink; `null` until a run.log exists. */
  append: ((line: string) => void) | null
  /** Clock for the ISO timestamp in run.log. */
  now: () => Date
}

export interface RunLog {
  /** A progress line: stdout and run.log. */
  info(message: string): void
  /** A detail line: run.log only. */
  detail(message: string): void
  /** An error line: stdout and run.log, prefixed `ERROR:`. */
  error(message: string): void
  /** Start writing run.log at `path` (earlier lines are not replayed). */
  attachFile(path: string): void
  /** The redactor every line goes through. */
  readonly redactor: Redactor
}

export function createRunLog(deps: RunLogDeps): RunLog {
  let append = deps.append
  const toFile = (line: string): void => {
    if (append) append(`${deps.now().toISOString()} ${line}`)
  }
  return {
    redactor: deps.redactor,
    info(message) {
      const line = deps.redactor.redact(message)
      deps.write(line)
      toFile(line)
    },
    detail(message) {
      toFile(deps.redactor.redact(message))
    },
    error(message) {
      const line = `ERROR: ${deps.redactor.redact(message)}`
      deps.write(line)
      toFile(line)
    },
    attachFile(path) {
      append = (line: string) => appendFileSync(path, `${line}\n`, { mode: 0o600 })
    },
  }
}

/**
 * The process's run log: stdout, plus run.log once attached. A terminal that
 * went away (a killed tmux session, a `tee` that exited) never stops the run
 * or its cleanup: stdout write errors are dropped, and run.log keeps every line.
 */
export function createProcessRunLog(redactor: Redactor): RunLog {
  process.stdout.on('error', () => {
    /* ignore: the terminal or pipe is gone; run.log still has the line */
  })
  return createRunLog({
    redactor,
    write: (line) => {
      try {
        process.stdout.write(`${line}\n`)
      } catch {
        /* ignore: as above */
      }
    },
    append: null,
    now: () => new Date(),
  })
}
