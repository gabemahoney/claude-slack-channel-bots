/**
 * tmux-probe.ts — General injectable tmux-exec seam (Task A, Epic t1.a3g.b7)
 *
 * Exports a typed probe factory (`buildTmuxProbe`) for `tmux has-session` liveness
 * checks and a kill-session operation, both routed through a single injectable
 * exec dependency so unit tests can record invocations without spawning real
 * processes.
 *
 * SR-20.2 signal mapping (classification table):
 *   exit 0                                    → definitely-alive  (signal: 'exit-0')
 *   exit 1 + session-not-found stderr         → definitely-dead   (signal: 'exit-1-session-not-found')
 *   exit 1 + no-server / socket-absent stderr → definitely-dead   (signal: 'exit-1-no-server')
 *   ENOENT / not-executable spawn failure     → transient-inconclusive (signal: 'spawn-enoent')
 *   timeout                                   → transient-inconclusive (signal: 'timeout')
 *   killed by signal                          → transient-inconclusive (signal: 'signal-killed')
 *   exit 1 + unparseable stderr               → transient-inconclusive (signal: 'exit-1-unparseable')
 *
 * No import-time side effects. No module-scoped state.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Three-way liveness classification per SR-20.2. */
export type TmuxProbeClassification =
  | 'definitely-dead'
  | 'definitely-alive'
  | 'transient-inconclusive'

/**
 * Producing signal that caused this classification — carries SR-20.2
 * traceability for callers that need to branch on the root cause.
 */
export type TmuxProbeSignal =
  | 'exit-0'                  // tmux exited 0 → session alive
  | 'exit-1-session-not-found' // exit 1 + "can't find session" / "session not found"
  | 'exit-1-no-server'        // exit 1 + "no server running" / "failed to connect"
  | 'exit-1-unparseable'      // exit 1 + stderr we don't recognise → transient
  | 'spawn-enoent'            // tmux binary missing / not-executable
  | 'timeout'                 // probe exceeded budget
  | 'signal-killed'           // child killed by OS signal

/** Result of a single `tmux has-session` probe. */
export interface TmuxProbeResult {
  classification: TmuxProbeClassification
  signal: TmuxProbeSignal
}

/** Function signature for a has-session probe. */
export type TmuxProbeFn = (sessionName: string) => Promise<TmuxProbeResult>

// ---------------------------------------------------------------------------
// Injectable exec dependency
// ---------------------------------------------------------------------------

/**
 * Outcome of a single tmux exec call as seen by the probe logic.
 * The injectable exec dep resolves to this shape; it never rejects (errors are
 * encoded in the result).
 */
export interface TmuxExecResult {
  /** Process exit code, or null if killed by signal. */
  exitCode: number | null
  /** Collected stderr output. */
  stderr: string
  /**
   * True when the spawn itself failed (e.g. ENOENT — tmux not found).
   * When true, exitCode and stderr are irrelevant.
   */
  spawnError?: boolean
  /** True when the probe timed out before the process exited. */
  timedOut?: boolean
  /** True when the process was killed by a signal (exitCode will be null). */
  signalKilled?: boolean
}

/**
 * Injectable exec dependency.  Receives the tmux subcommand args and resolves
 * to a TmuxExecResult.  Never rejects.
 */
export type TmuxExecFn = (args: string[]) => Promise<TmuxExecResult>

// ---------------------------------------------------------------------------
// Stderr pattern matching (SR-20.2)
// ---------------------------------------------------------------------------

/** Patterns that indicate the session name was not found. */
const SESSION_NOT_FOUND_PATTERNS = [
  "can't find session",
  'session not found',
]

/** Patterns that indicate tmux server / socket is absent. */
const NO_SERVER_PATTERNS = [
  'no server running',
  'failed to connect to server',
]

function matchesAny(stderr: string, patterns: string[]): boolean {
  const lower = stderr.toLowerCase()
  return patterns.some((p) => lower.includes(p))
}

// ---------------------------------------------------------------------------
// Classification helper
// ---------------------------------------------------------------------------

function classifyHasSession(result: TmuxExecResult): TmuxProbeResult {
  if (result.spawnError) {
    return { classification: 'transient-inconclusive', signal: 'spawn-enoent' }
  }
  if (result.timedOut) {
    return { classification: 'transient-inconclusive', signal: 'timeout' }
  }
  if (result.signalKilled || result.exitCode === null) {
    return { classification: 'transient-inconclusive', signal: 'signal-killed' }
  }
  if (result.exitCode === 0) {
    return { classification: 'definitely-alive', signal: 'exit-0' }
  }
  // exitCode === 1 (or other non-zero)
  if (matchesAny(result.stderr, SESSION_NOT_FOUND_PATTERNS)) {
    return { classification: 'definitely-dead', signal: 'exit-1-session-not-found' }
  }
  if (matchesAny(result.stderr, NO_SERVER_PATTERNS)) {
    return { classification: 'definitely-dead', signal: 'exit-1-no-server' }
  }
  return { classification: 'transient-inconclusive', signal: 'exit-1-unparseable' }
}

// ---------------------------------------------------------------------------
// Real exec implementation (default wiring)
// ---------------------------------------------------------------------------

/**
 * Default TmuxExecFn: spawns the real `tmux` binary with the given args.
 * Timeout defaults to 5 000 ms (overridable via buildTmuxProbe deps).
 */
function makeRealTmuxExec(timeoutMs: number): TmuxExecFn {
  return (args: string[]): Promise<TmuxExecResult> =>
    new Promise<TmuxExecResult>((resolve) => {
      let settled = false
      let timeoutHandle: ReturnType<typeof setTimeout> | undefined

      function settle(result: TmuxExecResult): void {
        if (settled) return
        settled = true
        if (timeoutHandle !== undefined) clearTimeout(timeoutHandle)
        resolve(result)
      }

      // Dynamic import avoids any import-time side effects.
      import('child_process').then(({ spawn }) => {
        let stderrBuf = ''
        let child: ReturnType<typeof spawn>
        try {
          child = spawn('tmux', args, { stdio: ['ignore', 'ignore', 'pipe'] })
        } catch {
          // Synchronous spawn failure (unusual but possible)
          settle({ exitCode: null, stderr: '', spawnError: true })
          return
        }

        child.stderr?.on('data', (d: Buffer) => {
          stderrBuf += d.toString('utf8')
        })

        child.on('error', (err: NodeJS.ErrnoException) => {
          const isEnoent = err.code === 'ENOENT' || err.code === 'EACCES'
          settle({ exitCode: null, stderr: stderrBuf, spawnError: isEnoent })
        })

        child.on('close', (code: number | null, signal: NodeJS.Signals | null) => {
          if (signal !== null) {
            settle({ exitCode: null, stderr: stderrBuf, signalKilled: true })
          } else {
            settle({ exitCode: code, stderr: stderrBuf })
          }
        })

        timeoutHandle = setTimeout(() => {
          try { child.kill() } catch { /* ignore */ }
          settle({ exitCode: null, stderr: stderrBuf, timedOut: true })
        }, timeoutMs)
      }).catch(() => {
        // child_process import failure — extremely unlikely
        settle({ exitCode: null, stderr: '', spawnError: true })
      })
    })
}

// ---------------------------------------------------------------------------
// buildTmuxProbe factory
// ---------------------------------------------------------------------------

export interface TmuxProbeDeps {
  /**
   * Injectable exec function.  Receives raw tmux args (e.g.
   * `['has-session', '-t', name]`).  Must never reject; encode errors in
   * TmuxExecResult.  When omitted, the real child_process spawn is used.
   */
  exec?: TmuxExecFn
  /**
   * Timeout budget in milliseconds for the has-session probe.
   * Ignored when `exec` is injected (caller controls timing in that case).
   * Default: 5 000.
   */
  timeoutMs?: number
}

/**
 * Factory that returns a TmuxProbeFn and a kill-session operation sharing
 * the same injectable exec dep.
 *
 * Usage (production):
 *   const { probe, killSession } = buildTmuxProbe()
 *
 * Usage (tests):
 *   const calls: string[][] = []
 *   const exec = async (args) => { calls.push(args); return { exitCode: 0, stderr: '' } }
 *   const { probe, killSession } = buildTmuxProbe({ exec })
 */
export function buildTmuxProbe(deps?: TmuxProbeDeps): {
  probe: TmuxProbeFn
  killSession: (sessionName: string) => Promise<void>
} {
  const timeoutMs = deps?.timeoutMs ?? 5_000
  const exec: TmuxExecFn = deps?.exec ?? makeRealTmuxExec(timeoutMs)

  const probe: TmuxProbeFn = async (sessionName: string): Promise<TmuxProbeResult> => {
    const result = await exec(['has-session', '-t', sessionName])
    return classifyHasSession(result)
  }

  const killSession = async (sessionName: string): Promise<void> => {
    // Best-effort: ignore all errors (same contract as _killTmuxSession in
    // session-manager.ts, but routed through the injectable exec dep so tests
    // can assert the invocation).
    await exec(['kill-session', '-t', sessionName])
  }

  return { probe, killSession }
}

// ---------------------------------------------------------------------------
// defaultTmuxProbe — real wiring point for production callers
// ---------------------------------------------------------------------------

/**
 * Ready-to-use probe backed by the real `tmux has-session` binary.
 * Constructed once at module load from buildTmuxProbe() with no deps.
 *
 * Production callers that only need a probe and don't need to assert
 * kill-session can import this directly.  Callers that need both operations
 * or need to inject stubs should call buildTmuxProbe() instead.
 */
export const defaultTmuxProbe: TmuxProbeFn = buildTmuxProbe().probe
