/**
 * tmux-probe.ts — General injectable tmux-exec seam (Task A, Epic t1.a3g.b7)
 *
 * Exports a typed probe factory (`buildTmuxProbe`) for `tmux has-session` liveness
 * checks and a kill-session operation, both routed through a single injectable
 * exec dependency so unit tests can record invocations without spawning real
 * processes.
 *
 * Also exports `classifyAdError` (Task A, Epic t1.a3g.6i) — the single shared
 * definition of liveness classification for AD-verb errors (SR-20.2 AD-verb rows).
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
 * SR-20.4 conservatism contract (callers of both the probe and classifyAdError):
 *   - `transient-inconclusive` obligates the caller to raise existing outage flags
 *     via withOutageDetection (outage-state.ts) and return early. The session MUST
 *     NOT be killed, resumed, or deleted on a transient verdict.
 *   - `definitely-dead` (from has-session rows only) authorizes kill/resume (SR-20.4).
 *     Only the two `definitely-dead` has-session rows may issue that authorization.
 *   - `not-a-liveness-signal` errors (ErrTmuxSessionCreate, ErrCwdNotFound,
 *     ErrCwdNotADirectory) are not liveness verdicts at all and must be handled by
 *     their owning recovery paths (SR-26.2, SR-24.6) — they must never drive
 *     kill/resume/delete decisions and callers must not pass them to probe-result
 *     routing code.
 *
 * Flag-coverage gap — explicit deferral (SR-20.4):
 *   ErrCallTimeout and generic AD-unreachable errors (non-ErrSystemInstallDisappeared
 *   AD connection failures) currently raise NO outage flag via withOutageDetection:
 *   the function rethrows them without calling setOutageFlag. Flag-raising for these
 *   transients is DEFERRED to the wiring Epics t1.a3g.mb and t1.a3g.yn, which must
 *   decide where flag-raising for those error classes lands. This module must NOT
 *   modify outage-state.ts to fill the gap — that is out of scope for Epic t1.a3g.6i.
 *
 * Name-resolution convention:
 *   Callers resolve session names via tmuxSessionNameFor (exported from
 *   src/session-manager.ts) at the call site. No convenience wrapper exists in this
 *   module by design — a wrapper would create the circular import that t1.a3g.mb must
 *   avoid (src/session-manager.ts depends on agent-director-client.ts, which is in the
 *   same import cycle mb is navigating).
 *
 * No import-time side effects. No module-scoped state.
 */

// ---------------------------------------------------------------------------
// Imports (AD error classes for classifyAdError)
// ---------------------------------------------------------------------------

import {
  ErrSpawnNotFound,
  ErrSystemInstallDisappeared,
  ErrTmuxNotAvailable,
  ErrCallTimeout,
  ErrTmuxSendKeys,
  ErrTmuxSessionCreate,
  ErrCwdNotFound,
  ErrCwdNotADirectory,
} from './agent-director-errors.ts'

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

/**
 * Lowercase substrings whose presence in stderr indicates the tmux session
 * name was not found.  Shared between classifyHasSession (has-session probe)
 * and reconnectMcp's ErrTmuxSendKeys discriminator (SR-22.1) so both use a
 * SINGLE definition.  Import via `SEND_KEYS_NOT_FOUND_NEEDLES` for the
 * send-keys use-case.
 */
export const SEND_KEYS_NOT_FOUND_NEEDLES: ReadonlyArray<string> = [
  "can't find session",
  'session not found',
]

/** Internal alias — same reference, avoids rename churn in classifyHasSession. */
const SESSION_NOT_FOUND_PATTERNS = SEND_KEYS_NOT_FOUND_NEEDLES

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
// AD-verb error classifier (SR-20.2 AD-verb rows, SR-20.3)
// ---------------------------------------------------------------------------

/**
 * Classification outcome from `classifyAdError`.
 *
 * Extends `TmuxProbeClassification` with a fourth literal for errors that are
 * not liveness signals at all.  Using a distinct value (rather than reusing
 * `transient-inconclusive`) ensures callers cannot silently treat a
 * non-liveness error as a liveness verdict — the type forces an explicit
 * branch.  SR-20.2 rows 7 and 13 describe these as non-liveness signals
 * handled by SR-26.2 and SR-24.6 respectively.
 */
export type AdErrorClassification =
  | TmuxProbeClassification
  | 'not-a-liveness-signal'

/**
 * `classifyAdError` — maps a caught AD-verb error to an `AdErrorClassification`
 * following the SR-20.2 AD-verb rows.  Pure function: no side effects, no
 * outage-state imports, no module-scoped state mutations.
 *
 * Mapping table (SR-20.2):
 *   ErrSpawnNotFound                         → definitely-dead
 *   ErrSystemInstallDisappeared              → transient-inconclusive
 *   ErrTmuxNotAvailable (AD-sourced)         → transient-inconclusive   ¹
 *   ErrCallTimeout                           → transient-inconclusive
 *   AD-unreachable / connection-refused      → transient-inconclusive   ²
 *   ErrTmuxSendKeys                          → transient-inconclusive   ³
 *   any unrecognized AgentDirectorError      → transient-inconclusive
 *   any non-AgentDirectorError               → transient-inconclusive
 *   ErrTmuxSessionCreate                     → not-a-liveness-signal    ⁴
 *   ErrCwdNotFound / ErrCwdNotADirectory     → not-a-liveness-signal    ⁵
 *
 * Notes:
 *
 * ¹ SR-20.3: AD's `ErrTmuxNotAvailable` stays `transient-inconclusive` here.
 *   The socket-absent verdict (`definitely-dead`) is only derivable from the
 *   direct `tmux has-session` probe's exit code + stderr (classifyHasSession,
 *   signal `exit-1-no-server`).  CSCB's own error catalog
 *   (src/agent-director-errors.ts) treats AD-sourced `ErrTmuxNotAvailable` as
 *   inconclusive because the library emits it for a broader range of tmux
 *   failures than "socket absent", so reclassifying it here would over-commit.
 *
 * ² Generic AD-unreachable errors (non-ErrSystemInstallDisappeared connection
 *   failures) are not represented by a distinct class in the current catalog;
 *   they fall into the "unrecognized AgentDirectorError" branch → transient.
 *
 * ³ ErrTmuxSendKeys send-keys escalation (SR-20.2 row 8 / SR-22.1): the
 *   "session not found" variant of send-keys is `definitely-dead` ONLY after a
 *   confirming has-session re-probe.  classifyAdError deliberately returns
 *   `transient-inconclusive` for ALL ErrTmuxSendKeys variants.  The re-probe
 *   and escalation to `definitely-dead` are Epic u4's responsibility (SR-22.1).
 *
 * ⁴ ErrTmuxSessionCreate is not a liveness signal — it indicates a session
 *   creation failure (SR-26.2) during spawn, not evidence about whether an
 *   existing session is alive or dead.
 *
 * ⁵ ErrCwdNotFound / ErrCwdNotADirectory are not liveness signals — they
 *   indicate route configuration issues (SR-24.6), not the liveness of a tmux
 *   session.  Both are handled by the cwd-unreachable outage path.
 *
 * Name-resolution convention: callers resolve session names via
 * `tmuxSessionNameFor` (src/session-manager.ts) at the call site.  No wrapper
 * exists here by design — see module-level JSDoc for rationale.
 *
 * SR-20.4 conservatism contract for `transient-inconclusive` results:
 *   raise existing outage flags via withOutageDetection and return early;
 *   never kill/resume/delete the session.  See module-level JSDoc for the
 *   flag-coverage gap deferral (ErrCallTimeout / generic AD-unreachable raise
 *   no flag today — deferred to t1.a3g.mb / t1.a3g.yn).
 */
export function classifyAdError(err: unknown): AdErrorClassification {
  // --- not-a-liveness-signal errors (must be checked before AgentDirectorError) ---
  if (err instanceof ErrTmuxSessionCreate) return 'not-a-liveness-signal'
  if (err instanceof ErrCwdNotFound) return 'not-a-liveness-signal'
  if (err instanceof ErrCwdNotADirectory) return 'not-a-liveness-signal'

  // --- definitely-dead ---
  if (err instanceof ErrSpawnNotFound) return 'definitely-dead'

  // --- transient-inconclusive (named AD error classes) ---
  if (err instanceof ErrSystemInstallDisappeared) return 'transient-inconclusive'
  if (err instanceof ErrTmuxNotAvailable) return 'transient-inconclusive'
  if (err instanceof ErrCallTimeout) return 'transient-inconclusive'
  if (err instanceof ErrTmuxSendKeys) return 'transient-inconclusive'

  // --- transient-inconclusive (unrecognized AgentDirectorError or non-AD error) ---
  // Covers: generic AD-unreachable/connection-refused (no distinct class today),
  // any future AgentDirectorError not yet in the catalog, and non-AD exceptions
  // thrown from unexpected paths.
  return 'transient-inconclusive'
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
