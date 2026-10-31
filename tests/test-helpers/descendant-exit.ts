import { readFileSync } from 'node:fs'

// The CLI harness and its cleanup have separate 2 s and 1 s bounds, leaving
// room for this wait within Bun's default 5 s test timeout.
const DEFAULT_TIMEOUT_MS = 1_000
const POLL_INTERVAL_MS = 10

export interface DescendantExitOptions {
  readStat?: (path: string) => string
  timeoutMs?: number
  now?: () => number
  sleep?: (ms: number) => Promise<void>
}

/**
 * Shared by the real CLI signal cases and their deterministic regression cases.
 * Socket disconnection and CLI exit do not prove that every descendant stopped.
 * Poll all recorded PIDs against one deadline, yielding between observations.
 */
export async function expectDescendantsStopped(pids: readonly number[], options: DescendantExitOptions = {}): Promise<void> {
  const readStat = options.readStat ?? ((path: string) => readFileSync(path, 'utf8'))
  const now = options.now ?? (() => performance.now())
  const sleep = options.sleep ?? (ms => new Promise<void>(resolve => { setTimeout(resolve, ms) }))
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0) throw new Error('Descendant exit timeout must be finite and non-negative')
  const deadline = now() + timeoutMs

  while (true) {
    const survivors: string[] = []
    for (const pid of pids) {
      let stat: string
      try {
        stat = readStat(`/proc/${pid}/stat`)
      } catch (error) {
        // Read directly so disappearance cannot race an existence probe.
        if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') continue
        throw new Error(`Could not read state of descendant PID ${pid}`)
      }
      // The command name may contain ') '; use its last delimiter and expose
      // only a single state letter, never raw stat content or error text.
      const state = /^\) ([A-Za-z]) /.exec(stat.slice(stat.lastIndexOf(') ')))?.[1] ?? 'unknown'
      // A killed orphan can remain a zombie until the container's init reaps it.
      if (state !== 'Z') survivors.push(`PID ${pid} state ${state}`)
    }
    if (survivors.length === 0) return
    const remainingMs = deadline - now()
    if (remainingMs <= 0) throw new Error(`Descendants still live at exit deadline: ${survivors.join(', ')}`)
    await sleep(Math.min(POLL_INTERVAL_MS, remainingMs))
  }
}
