#!/usr/bin/env bun
/**
 * cli.ts — Command-line entry point for the Slack Channel Router.
 *
 * Subcommands:
 *   start          — Check that the configuration file exists, launch the
 *                    server in the background, and report an early startup
 *                    failure of the daemon.
 *   stop           — Send SIGTERM to a running server via its PID file.
 *                    `--stop-bots` also exits every configured persona's
 *                    instance.
 *   clean_restart  — Exit every configured persona's instance, then stop and
 *                    start the server.
 *   credentials    — `credentials <persona>`: write that persona's
 *                    credentials file from the operator's terminal, by
 *                    running the packaged `scripts/write-credentials.sh`
 *                    (b.av2 SR-12, SR-1.4 part).
 *
 * `start`, `stop` and `clean_restart` take their settings and persona set from
 * the configuration the server runs (b.av2 SR-8.7): the last-applied record
 * beside the configuration file (`resolveServerConfigPath`) when it exists,
 * otherwise the configuration file (`readAppliedPersonaConfig`).
 * `credentials` reads the configuration file as it stands
 * (`loadPersonaConfig`), where a persona being added is declared before any
 * confirmation. The CLI never writes any reload file, and this process reads
 * no Slack token and no credentials file (b.av2 SR-10.2): the server reads
 * each persona's credentials file, and the credentials script, run as a child
 * on the operator's terminal, reads the tokens at its own no-echo prompts.
 *
 * SPDX-License-Identifier: MIT
 */

import { join, resolve } from 'path'
import { closeSync, existsSync, fstatSync, openSync, readFileSync, readSync, statSync, unlinkSync } from 'fs'
import { spawn, spawnSync } from 'child_process'
import { isProcessRunning } from './pid.ts'
import {
  loadPersonaConfig,
  resolveServerConfigPath,
  resolveServerStateDir,
  type Persona,
  type PersonaConfig,
} from './config.ts'
import { readAppliedPersonaConfig, reloadFilePaths } from './reload.ts'
import { initLogging } from './logging.ts'
import { ErrSpawnNotFound } from './agent-director-errors.ts'
import { describeThrownValue } from './persona-connection-errors.ts'
import { getClient } from './agent-director-client.ts'
import type { Client } from 'agent-director'
import { personaInstanceId, renderPersonaRef, resolvePersonaTarget } from './persona-identity.ts'
import { runStartupGate } from './agent-director-startup.ts'
import type { StartupGateRefusalKind } from './agent-director-startup.ts'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * How long `start` waits for the daemon it spawned to get past startup
 * (b.av2 SR-1.7, SR-8.7): long enough for the agent-director startup gate,
 * the configuration load and the template refresh that precede the PID file.
 */
export const DAEMON_STARTUP_WAIT_MS = 30_000

/** How often `start` checks the daemon while it waits. */
export const DAEMON_STARTUP_POLL_MS = 100

/** How often `stop` checks whether the server has exited, after SIGTERM and after SIGKILL. */
export const STOP_POLL_MS = 100

/** How long `stop` waits for the server to die after SIGKILL. */
export const STOP_KILL_WAIT_MS = 2000

/** Most `server.log` lines `start` repeats when the daemon exits during startup. */
export const DAEMON_FAILURE_LOG_LINES = 20

/**
 * The packaged credentials script `credentials` runs (b.av2 SR-12): shipped
 * in the npm package (package.json `files`) beside `src/`.
 */
export const CREDENTIALS_SCRIPT_PATH = resolve(import.meta.dir, '..', 'scripts', 'write-credentials.sh')

/** `credentials`' usage line, printed with exit 2 when it is not given exactly one persona. */
export const CREDENTIALS_USAGE = 'Usage: claude-slack-channel-bots credentials <persona name or key>'

// ---------------------------------------------------------------------------
// Daemon child
// ---------------------------------------------------------------------------

/** Options `start` spawns the daemon with (b.acn: detached, no inherited stdio). */
export interface DaemonSpawnOptions {
  detached: true
  stdio: ['ignore', number, number]
  env: NodeJS.ProcessEnv
}

/** The part of a spawned daemon child that `start` uses. */
export interface DaemonChild {
  /** Undefined when the spawn failed (an `error` event follows). */
  readonly pid?: number
  unref(): void
  once(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown
  once(event: 'error', listener: (err: Error) => void): unknown
}

// ---------------------------------------------------------------------------
// Injectable dependency interface
// ---------------------------------------------------------------------------

export interface CliDeps {
  /** Run a command and return its exit code (or null if spawn failed). */
  spawnSync: (cmd: string, args: string[]) => { status: number | null }
  /** Spawn the detached server daemon (`start`'s parent path). */
  spawnDaemon: (cmd: string, args: string[], opts: DaemonSpawnOptions) => DaemonChild
  /** Open a file for appending (creating it) and return its descriptor: the daemon's `server.log`. */
  openLogAppend: (path: string) => number
  /** Close a descriptor `openLogAppend` returned. */
  closeFd: (fd: number) => void
  /**
   * Redirect console.error / console.log to a log file (`initLogging` in
   * production): the daemon child's `server.log`, clean_restart's
   * `clean_restart.log`. May throw; both callers treat a failure as non-fatal.
   */
  initLogging: (path: string) => void
  /** Check whether a file path exists. */
  existsSync: (path: string) => boolean
  /** Read a file as UTF-8 text. */
  readFileSync: (path: string) => string
  /** Size of a file in bytes; 0 when it cannot be read. */
  fileSize: (path: string) => number
  /** A file's bytes from `offset` to the end, as UTF-8 text; '' when it cannot be read. */
  readFileFrom: (path: string, offset: number) => string
  /** Current time in milliseconds (the clock of the daemon startup wait and of `stop`'s exit polls). */
  now: () => number
  /** Resolve after `ms` milliseconds (the clock of the daemon startup wait and of `stop`'s exit polls). */
  sleep: (ms: number) => Promise<void>
  /** Remove a file. */
  unlinkSync: (path: string) => void
  /** Check whether a PID corresponds to a running process. */
  isProcessRunning: (pid: number) => boolean
  /** Kill a process with the given signal. */
  kill: (pid: number, signal: string | number) => void
  /** The server's state directory (`resolveServerStateDir` in production). */
  resolveStateDir: () => string
  /** The configuration file the server loads (`resolveServerConfigPath` in production). */
  resolveConfigPath: () => string
  /** Launch the server. Resolves when server startup completes (or throws). */
  startServer: () => Promise<void>
  /** Exit the process. */
  exit: (code: number) => never
  /**
   * The configuration the server runs, for the configuration file at `path`
   * (`readAppliedPersonaConfig` in production, b.av2 SR-8.7): the last-applied
   * record beside it when one exists, otherwise the file itself. Throws the
   * start's wording on failure: a record that cannot be read or validated is
   * named with the deletion hint (never falling back to the file), and a
   * file error carries the loader's message, including E1's conversion error
   * for a pre-persona file (b.av2 SR-1.7). Never writes any reload file.
   */
  loadConfig: (path: string) => PersonaConfig
  /**
   * The configuration file at `path` as it stands, never the last-applied
   * record (`loadPersonaConfig` in production): `credentials` finds its
   * persona there, so a persona declared but not yet confirmed is found.
   * Throws the loader's error, which names the file and never echoes a
   * credential value (b.av2 SR-10.3). Reads no credentials file.
   */
  loadConfigFile: (path: string) => PersonaConfig
  /**
   * Run the packaged credentials script (`CREDENTIALS_SCRIPT_PATH`) with bash
   * for `credentialsFile`, on this process's terminal (stdio inherited), and
   * return its exit status: the script reads the tokens at its own no-echo
   * prompts, so they never pass through this process or any command line.
   * Returns 1 when the script is missing or bash cannot be run, after
   * printing why.
   */
  runCredentialsScript: (credentialsFile: string) => number
  /**
   * b.qwo: initialize the agent-director Client singleton before any per-persona
   * teardown work. clean_restart / `stop --stop-bots` run in a short-lived CLI
   * process that never runs the server startup gate, so getClient() would throw
   * (the b.qps root cause). Production wires this to the non-exiting
   * runStartupGate variant; on failure the caller exits loudly (AD-unreachable
   * is never a silent skip). Optional so tests that install a stub singleton via
   * setClientForTests can omit it — when absent, callers skip init and use the
   * already-installed stub.
   */
  initClient?: () => Promise<void>
  /**
   * Query the agent-director state of a persona's instance, addressed by its
   * instance ID (`cscb_<key>`). Returns null only when the row is absent
   * (ErrSpawnNotFound); every other error propagates (b.qwo).
   */
  directorStatus: (instanceId: string) => Promise<{ state: string } | null>
  /** Politely shut down a persona's instance (`cscb_<key>`) via client.pause. */
  directorPause: (instanceId: string) => Promise<void>
  /**
   * Hard-terminate a persona's instance (`cscb_<key>`) via client.kill. May
   * throw ErrSpawnNotFound for an already-gone row; the real deps absorb it
   * and teardownBots also tolerates it at the call sites — the double-layer
   * leniency is intentional (b.dnt).
   */
  directorKill: (instanceId: string) => Promise<void>
}

// ---------------------------------------------------------------------------
// CSCB-authored failures (b.av2 SR-10.3)
// ---------------------------------------------------------------------------

/**
 * The agent-director startup gate's failure, as the production `initClient`
 * throws it. Its message is the gate's own class label and message
 * (`runStartupGate`), which CSCB builds and which name versions, paths and the
 * fix, never a token, so a failure line prints it rather than only describing
 * the error: it is the operator's diagnosis. `refusalKind` is the gate
 * outcome's refusal kind (`client-too-old`, `below-phase1-floor`, `other`),
 * so a caller branches on which check refused, never on the class label or
 * the message text (b.jg5 SRJ-203).
 */
export class StartupGateFailedError extends Error {
  constructor(
    readonly classLabel: string,
    detail: string,
    readonly refusalKind: StartupGateRefusalKind,
  ) {
    super(`agent-director startup gate failed (${classLabel}): ${detail}`)
    this.name = 'StartupGateFailedError'
  }
}

/**
 * `teardownBots`' aggregate failure. Its message is CSCB's own (a persona
 * count and the retry advice); each underlying error was already logged
 * through `describeThrownValue`.
 */
class TeardownIncompleteError extends Error {
  constructor(rejected: number) {
    super(
      `teardownBots: agent-director error — teardown incomplete for ${rejected} persona(s); ` +
        `other personas may already have been paused or killed; rows are never deleted, safe to retry`,
    )
    this.name = 'TeardownIncompleteError'
  }
}

/**
 * The tail of a CLI failure line: the message of a failure CSCB authored
 * ({@link StartupGateFailedError}, {@link TeardownIncompleteError}), else
 * `describeThrownValue` of the thrown value (its message only through
 * `redactSlackLogText`).
 */
function describeCliFailure(err: unknown): string {
  if (err instanceof StartupGateFailedError || err instanceof TeardownIncompleteError) return err.message
  return describeThrownValue(err)
}

// ---------------------------------------------------------------------------
// Log reads for the daemon startup report (production deps)
// ---------------------------------------------------------------------------

function fileSize(path: string): number {
  try {
    return statSync(path).size
  } catch {
    return 0
  }
}

function readFileFrom(path: string, offset: number): string {
  let fd: number
  try {
    fd = openSync(path, 'r')
  } catch {
    return ''
  }
  try {
    const start = Math.max(0, offset)
    const length = Math.max(0, fstatSync(fd).size - start)
    const buf = Buffer.alloc(length)
    const read = readSync(fd, buf, 0, length, start)
    return buf.subarray(0, read).toString('utf-8')
  } catch {
    return ''
  } finally {
    closeSync(fd)
  }
}

// ---------------------------------------------------------------------------
// Session-leader detection (b.acn)
// ---------------------------------------------------------------------------

/**
 * True if this process is a session leader (its own session id equals its pid).
 * A daemon spawned with detached:true is a session leader; a process that merely
 * inherited a leaked _CLI_DAEMON_CHILD marker from its launcher is not.
 *
 * Bun lacks process.getsid, so read the session id (field 6) from
 * /proc/self/stat on Linux. The comm field (2) may contain spaces/parens, so
 * split on the LAST ") " to safely reach the space-delimited numeric fields.
 * If the platform has no /proc (non-Linux) the detection is unavailable; fail
 * open (treat as leader) so the marker is trusted as before on those platforms.
 */
function isSessionLeader(): boolean {
  try {
    const stat = readFileSync('/proc/self/stat', 'utf8')
    const fields = stat.slice(stat.lastIndexOf(') ') + 2).split(' ')
    // After comm: [0]=state [1]=ppid [2]=pgrp [3]=session
    const session = parseInt(fields[3] ?? '', 10)
    return Number.isNaN(session) ? true : session === process.pid
  } catch {
    return true
  }
}

// ---------------------------------------------------------------------------
// Factory — createCli
// ---------------------------------------------------------------------------

export interface CliHandlers {
  start: () => Promise<void>
  stop: (opts?: { stopBots?: boolean }) => Promise<void>
  clean_restart: () => Promise<void>
  /** `credentials <persona>`, given the arguments after the subcommand. */
  credentials: (args: readonly string[]) => Promise<void>
}

/**
 * Build CLI handlers bound to injectable dependencies.
 * Call with real deps from top-level code; call with stubs in tests.
 */
export function createCli(deps: CliDeps): CliHandlers {
  /**
   * b.4dk: per-persona graceful bot teardown — SR-11 Event 12's pause/poll/kill
   * sequence, extracted so both clean_restart and `stop --stop-bots` reuse the
   * exact same tested logic instead of duplicating it.
   *
   * Runs once per persona of the configuration the server runs (b.av2 SR-8.7:
   * the last-applied record, or the configuration file without one), addressing
   * each persona's instance as `cscb_<key>`; see `teardownPersona`. A config
   * with no personas tears down nothing.
   */
  async function teardownBots(personas: readonly Persona[], exit_timeout: number): Promise<void> {
    // b.qwo: the precheck's directorStatus() reaches agent-director. If AD is
    // unreachable (the b.qps/incident-2026-09-18 root cause: getClient() throws
    // in the short-lived CLI process, or the AD binary is down), that error MUST
    // NOT be swallowed as a per-persona "no spawn row — skipping" no-op. We let
    // the precheck error propagate to Promise.allSettled as a rejection, then
    // throw a loud aggregate error after the loop so callers exit non-zero and
    // never proceed to `start`. b.dnt: escalation/timeout kill failures on a
    // present row also reject into the aggregate now — only the benign
    // ErrSpawnNotFound already-gone race stays per-persona handled.
    const results = await Promise.allSettled(personas.map((persona) => teardownPersona(persona, exit_timeout)))

    // b.qwo: loud AD-unreachable failure. A rejected settlement here is an
    // agent-director error — from the connectivity/precheck at the top of a
    // persona's teardown, from a directorStatus poll-loop call, or
    // (b.dnt) from an escalation/timeout kill that failed with anything other
    // than the benign ErrSpawnNotFound already-gone race — never a normal
    // terminal-row skip, which resolves. Surface every one and throw so the
    // teardown is never a silent no-op and the caller aborts before starting a
    // new server.
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected')
    if (rejected.length > 0) {
      for (const r of rejected) {
        console.error(`[slack] teardownBots: agent-director error during teardown: ${describeThrownValue(r.reason)}`)
      }
      throw new TeardownIncompleteError(rejected.length)
    }
  }

  /**
   * One persona's teardown: precheck the row state of `cscb_<key>`; skip an
   * absent/terminal row; client.pause() (sends `/exit` → SessionEnd reason
   * prompt_input_exit → the row reaches `ended`); poll client.status() with
   * exponential backoff until ended/missing or exit_timeout elapses; on
   * timeout escalate to client.kill(). NOTE: a kill escalation does NOT
   * guarantee an `ended` row — that residual case is recovered later via the
   * findMissing→resume path. Log lines name the persona as its JSON-quoted
   * name with its key (b.av2 SR-2.2).
   */
  async function teardownPersona(persona: Persona, exit_timeout: number): Promise<void> {
    const id = personaInstanceId(persona.key)
    const ref = renderPersonaRef(persona.name, persona.key)

    // Precheck: any row? If not, nothing to do.
    // NOTE (b.qwo): errors here (AD unreachable / uninitialized client)
    // intentionally propagate — they become allSettled rejections handled
    // by teardownBots' loud-failure check. "no spawn row" is reported ONLY
    // when directorStatus resolves to null (row genuinely absent).
    const precheck = await deps.directorStatus(id)
    if (precheck === null) {
      console.error(`[slack] teardownBots: no spawn row for persona ${ref} — skipping`)
      return
    }
    const state = precheck.state
    if (state === 'ended' || state === 'missing') {
      console.error(`[slack] teardownBots: persona ${ref} already terminal (state=${state}) — skipping`)
      return
    }

    // pause and poll for terminal transition
    try {
      await deps.directorPause(id)
    } catch (err) {
      console.error(`[slack] teardownBots: pause failed for persona ${ref} — escalating to kill: ${describeThrownValue(err)}`)
      // b.dnt: the kill's outcome decides this persona's fate. A benign
      // ErrSpawnNotFound (row genuinely already gone) resolves quietly;
      // any other kill error (e.g. AD died mid-teardown) rethrows so it
      // rejects into the Promise.allSettled aggregate. SR-0.2: branch via
      // the typed class, never on error strings.
      try {
        await deps.directorKill(id)
      } catch (killErr) {
        if (!(killErr instanceof ErrSpawnNotFound)) throw killErr
      }
      return
    }

    const timeoutMs = exit_timeout * 1000
    const startTime = Date.now()
    let delay = 100
    const maxDelay = 2_000

    while (Date.now() - startTime < timeoutMs) {
      await new Promise<void>((r) => setTimeout(r, delay))
      delay = Math.min(delay * 2, maxDelay)
      const pollResult = await deps.directorStatus(id)
      if (pollResult === null || pollResult.state === 'ended' || pollResult.state === 'missing') {
        const elapsed = Date.now() - startTime
        console.error(`[slack] teardownBots: persona ${ref} exited cleanly in ${elapsed}ms`)
        return
      }
    }

    // Timeout — force kill via agent-director
    const elapsed = Date.now() - startTime
    try {
      await deps.directorKill(id)
      console.error(`[slack] teardownBots: persona ${ref} force-killed after ${elapsed}ms`)
    } catch (err) {
      console.error(`[slack] teardownBots: kill failed for persona ${ref}: ${describeThrownValue(err)}`)
      // b.dnt: same rule as the escalation path — a throwing kill here means
      // AD is dead mid-teardown, not a benign already-gone row. Rethrow so it
      // rejects into the aggregate; swallow only the benign ErrSpawnNotFound.
      if (!(err instanceof ErrSpawnNotFound)) throw err
    }
  }

  async function start(): Promise<void> {
    // tmux is no longer a CSCB-direct prerequisite — agent-director owns the
    // tmux integration. CSCB still requires it transitively but the
    // SR-5.1 startup gate is the single source of truth for runtime checks.
    //
    // No token check (b.av2 SR-10.2): the server reads each persona's tokens
    // from its credentials file, never from the environment.

    // b.av2 SR-8.7: the configuration file the server loads, or its
    // last-applied record, must exist. Their contents are not checked here:
    // the server validates them at start, and `start` reports that failure
    // from the daemon's log (see `awaitDaemonStartup`).
    const stateDir = deps.resolveStateDir()
    const configPath = deps.resolveConfigPath()
    const recordPath = reloadFilePaths(configPath).lastApplied
    if (!deps.existsSync(configPath) && !deps.existsSync(recordPath)) {
      console.error(
        `missing prerequisite: config.json not found at ${configPath}, and no config.json.last-applied at ${recordPath}`,
      )
      deps.exit(1)
    }

    // All checks passed — daemonize: the parent spawns the daemon and waits for
    // its startup outcome, the child continues as the server.
    // In Bun, we detect the child vs parent by an env marker.
    //
    // b.acn: the marker alone is untrustworthy. If _CLI_DAEMON_CHILD leaks into
    // the launching environment (e.g. from an operator wrapper like start-all.sh
    // / cscb-up), the parent daemonize branch is skipped and the server runs
    // in-place as a direct child of the launching shell — inheriting its
    // session/PGID and dying when that group is killed. A real daemon child
    // (spawned with detached:true) is always a session leader, so require the
    // marker AND session-leadership to trust it. A set-but-not-leader marker is
    // a leak: clear it and fall through to the parent path to re-detach.
    if (process.env['_CLI_DAEMON_CHILD'] && !isSessionLeader()) {
      delete process.env['_CLI_DAEMON_CHILD']
    }
    if (!process.env['_CLI_DAEMON_CHILD']) {
      // Parent: spawn a detached background child, then report its startup.
      const logPath = join(stateDir, 'server.log')
      const logOffset = deps.fileSize(logPath)
      const logFd = deps.openLogAppend(logPath)
      const childEnv: NodeJS.ProcessEnv = { ...process.env, _CLI_DAEMON_CHILD: '1' }
      let child: DaemonChild
      try {
        child = deps.spawnDaemon(process.execPath, [import.meta.filename, 'start'], {
          detached: true,
          stdio: ['ignore', logFd, logFd],
          env: childEnv,
        })
      } finally {
        // The daemon holds its own copy of the descriptor; the parent's is not
        // needed while it waits (up to DAEMON_STARTUP_WAIT_MS).
        deps.closeFd(logFd)
      }
      child.unref()
      await awaitDaemonStartup(child, join(stateDir, 'server.pid'), logPath, logOffset)
      return
    }

    // Child (daemon): redirect stderr/stdout to server.log
    try { deps.initLogging(join(stateDir, 'server.log')) } catch { /* best-effort: log redirect failure is non-fatal */ }

    // Child (daemon): start the server
    await deps.startServer()
  }

  /**
   * `start`'s parent path after the spawn (b.av2 SR-1.7, SR-8.7): wait up to
   * DAEMON_STARTUP_WAIT_MS for the daemon to exit or to write its own PID to
   * the PID file, which the server does once it is listening, after the
   * configuration load. Then exit:
   *
   * - the daemon wrote its PID: 0, with the "Server starting in background"
   *   line;
   * - the daemon exited (or could not be spawned): 1, repeating the lines
   *   this run appended to `server.log`, which carry the server's own fatal
   *   reason (E1's conversion error verbatim for a pre-persona file). Server
   *   log lines never carry a token (b.av2 SR-10.3);
   * - the wait expired: 0, saying the server is still starting and where its
   *   log is. The daemon is never signalled.
   */
  async function awaitDaemonStartup(
    child: DaemonChild,
    pidFile: string,
    logPath: string,
    logOffset: number,
  ): Promise<void> {
    // Set by the child's events; the first one wins.
    const outcome: { failure: string | null } = { failure: null }
    child.once('exit', (code, signal) => {
      outcome.failure ??= signal !== null ? `killed by ${signal}` : `exit code ${code}`
    })
    child.once('error', (err) => {
      outcome.failure ??= `could not be launched: ${err.message}`
    })

    const deadline = deps.now() + DAEMON_STARTUP_WAIT_MS
    for (;;) {
      if (outcome.failure !== null) {
        reportDaemonFailure(outcome.failure, logPath, logOffset)
        deps.exit(1)
      }
      if (daemonWrotePid(pidFile, child.pid)) {
        console.error(`[slack] Server starting in background (PID ${child.pid})`)
        deps.exit(0)
      }
      if (deps.now() >= deadline) {
        console.error(
          `[slack] Server is still starting in the background (PID ${child.pid}) after ` +
            `${DAEMON_STARTUP_WAIT_MS / 1000}s — its log is ${logPath}`,
        )
        deps.exit(0)
      }
      await deps.sleep(DAEMON_STARTUP_POLL_MS)
    }
  }

  /** True when the PID file names `pid`: the daemon got past startup. */
  function daemonWrotePid(pidFile: string, pid: number | undefined): boolean {
    if (pid === undefined || !deps.existsSync(pidFile)) return false
    try {
      return parseInt(deps.readFileSync(pidFile).trim(), 10) === pid
    } catch {
      return false
    }
  }

  /**
   * Write the daemon's startup failure to stderr: the last
   * DAEMON_FAILURE_LOG_LINES non-empty lines appended to `server.log` since
   * `logOffset`. A log now shorter than the offset was rotated, so it is read
   * from its start.
   */
  function reportDaemonFailure(failure: string, logPath: string, logOffset: number): void {
    const from = deps.fileSize(logPath) < logOffset ? 0 : logOffset
    const lines = deps.readFileFrom(logPath, from)
      .split('\n')
      .map((line) => line.trimEnd())
      .filter((line) => line !== '')
      .slice(-DAEMON_FAILURE_LOG_LINES)
    if (lines.length === 0) {
      console.error(`[slack] Server failed to start (${failure}); it wrote nothing to ${logPath}`)
      return
    }
    console.error(`[slack] Server failed to start (${failure}). From ${logPath}:`)
    for (const line of lines) console.error(line)
  }

  async function stop(opts?: { stopBots?: boolean }): Promise<void> {
    // b.4dk: `stop --stop-bots` gracefully exits the managed bots (reusing
    // clean_restart's tested pause/poll/kill teardown) AND stops the server,
    // WITHOUT the restart phase. Plain `stop` leaves the bots running (they
    // are meant to survive server restarts).
    //
    // Order matters: stop the server FIRST, then run teardownBots — mirroring
    // clean_restart's production-proven order (phase 2 server stop before
    // teardown). If teardown ran while the daemon were still alive, a bot's
    // graceful `/exit` would close its MCP session and the live server's
    // onsessionclosed handler (src/server.ts) would scheduleRestart the
    // persona, respawning it fresh (deleting its `ended` row and history) before
    // SIGTERM lands. directorPause is an agent-director client subprocess that
    // needs no live CSCB daemon (SessionEnd hooks are wired by agent-director
    // into the spawned claude process and call the AD binary), so teardown works
    // fine after the server is down.

    // Phase 1: stop the server daemon. Returns the intended exit code so
    // teardown can run before we actually exit.
    const stopServerCode = await stopServer()

    // Phase 2: gracefully exit managed bots (only for --stop-bots).
    if (opts?.stopBots) {
      // Phase 2.4 (b.qwo): initialize the AD Client singleton before teardown.
      // Like clean_restart, `stop --stop-bots` runs in a short-lived CLI process
      // that never runs the server startup gate; without init getClient() throws
      // and teardown becomes a silent no-op (the b.qps root cause).
      if (deps.initClient) {
        try {
          await deps.initClient()
        } catch (err) {
          console.error(`[slack] stop --stop-bots: agent-director initialization failed: ${describeCliFailure(err)}`)
          deps.exit(1)
        }
      }

      // Config load is best-effort: a config problem (a pre-persona file
      // included) logs and skips teardown without failing the stop (the server
      // is already down; b.4dk behavior).
      let config: PersonaConfig | null = null
      try {
        config = deps.loadConfig(deps.resolveConfigPath())
      } catch (err) {
        console.error('[slack] stop --stop-bots: could not load config — skipping bot teardown:', err)
      }

      // b.qwo: a teardown failure (AD unreachable) is a LOUD failure — exit
      // non-zero rather than swallowing it and reporting a clean stop.
      if (config !== null) {
        console.error('[slack] stop --stop-bots: gracefully exiting managed bots')
        try {
          await teardownBots(config.personas, config.exit_timeout)
        } catch (err) {
          console.error(`[slack] stop --stop-bots: bot teardown failed: ${describeCliFailure(err)}`)
          deps.exit(1)
        }
      }
    }

    deps.exit(stopServerCode)
  }

  // Stop the server daemon. Returns the intended process exit code instead of
  // calling deps.exit() directly, so callers can run additional teardown work
  // (e.g. --stop-bots) before exiting.
  async function stopServer(): Promise<number> {
    const stateDir = deps.resolveStateDir()
    const pidFile = join(stateDir, 'server.pid')

    if (!deps.existsSync(pidFile)) {
      console.error('server is not running')
      return 0
    }

    let pid: number
    try {
      const raw = deps.readFileSync(pidFile).trim()
      pid = parseInt(raw, 10)
      if (isNaN(pid)) throw new Error(`invalid PID: ${raw}`)
    } catch (err) {
      console.error(`[slack] Could not read PID file: ${err}`)
      return 1
    }

    if (!deps.isProcessRunning(pid!)) {
      // Stale PID file
      try {
        deps.unlinkSync(pidFile)
      } catch { /* ignore */ }
      console.error('server is not running (removed stale PID file)')
      return 0
    }

    // Load stop_timeout from the record or config (fall back to 30s if
    // unavailable, a pre-persona file included). A read failure is reported in
    // one line with the loader's message (which names the file and, for a bad
    // record, carries the deletion hint, never file content), and the stop
    // proceeds with the default.
    let stopTimeoutMs = 30_000
    try {
      const config = deps.loadConfig(deps.resolveConfigPath())
      if (typeof config.stop_timeout === 'number') {
        stopTimeoutMs = config.stop_timeout * 1000
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error(`[slack] stop: could not load the applied configuration — using the default 30s stop_timeout: ${msg}`)
    }

    // Live process — send SIGTERM and poll until exit or stop_timeout
    deps.kill(pid!, 'SIGTERM')

    const deadline = deps.now() + stopTimeoutMs
    while (deps.now() < deadline) {
      await deps.sleep(STOP_POLL_MS)
      if (!deps.isProcessRunning(pid!)) {
        try { deps.unlinkSync(pidFile) } catch { /* ignore */ }
        console.error('[slack] Server stopped.')
        return 0
      }
    }

    // SIGTERM timed out — escalate to SIGKILL
    console.error(`[slack] Warning: server did not stop within ${stopTimeoutMs / 1000}s after SIGTERM — sending SIGKILL.`)
    deps.kill(pid!, 'SIGKILL')

    // Poll briefly (~2s) to confirm death after SIGKILL
    const killDeadline = deps.now() + STOP_KILL_WAIT_MS
    while (deps.now() < killDeadline) {
      await deps.sleep(STOP_POLL_MS)
      if (!deps.isProcessRunning(pid!)) {
        try { deps.unlinkSync(pidFile) } catch { /* ignore */ }
        console.error('[slack] Server killed.')
        return 0
      }
    }

    console.error('[slack] Warning: server did not die after SIGKILL.')
    return 1
  }

  async function clean_restart(): Promise<void> {
    // Everything below goes to clean_restart.log. A fatal line is also written
    // to the stderr in place before the redirect, so a failed clean_restart
    // says why on the terminal instead of a bare exit 1. These lines name
    // paths, persona refs and loader/agent-director errors, never a token.
    const terminalError = console.error
    try { deps.initLogging(join(deps.resolveStateDir(), 'clean_restart.log')) } catch { /* best-effort */ }
    const fatal = (...args: unknown[]): void => {
      console.error(...args)
      if (console.error !== terminalError) terminalError(...args)
    }

    // Phase 1: Load config (the persona set to tear down)
    let config: PersonaConfig
    try {
      config = deps.loadConfig(deps.resolveConfigPath())
    } catch (err) {
      fatal('[slack] clean_restart: failed to load config:', err)
      deps.exit(1)
    }
    const { personas, exit_timeout } = config!

    // Phase 2: Stop the server daemon
    console.error('[slack] clean_restart: stopping server')
    const stopResult = deps.spawnSync(process.execPath, [process.argv[1], 'stop'])
    if (stopResult.status !== 0) {
      console.error(`[slack] clean_restart: stop returned non-zero exit code: ${stopResult.status}`)
    }

    // Phase 2.5 (b.qwo): initialize the AD Client singleton before per-persona
    // work. This CLI process does NOT run the server startup gate, so without
    // explicit init getClient() throws (the b.qps root cause). We use the
    // non-exiting runStartupGate variant so a gate failure surfaces here as a
    // distinct loud non-zero exit rather than a silently skipped teardown.
    if (deps.initClient) {
      try {
        await deps.initClient()
      } catch (err) {
        fatal('[slack] clean_restart: agent-director initialization failed:', err)
        deps.exit(1)
      }
    }

    // Phases 3-4: SR-11 Event 12 — per-persona pause/poll/kill teardown via
    // agent-director (shared with `stop --stop-bots`), addressing `cscb_<key>`.
    //
    // b.qwo: teardownBots throws if AD is unreachable during the precheck. A
    // failed teardown must abort the restart — never proceed to `start` on top
    // of bots we could not reach.
    try {
      await teardownBots(personas, exit_timeout)
    } catch (err) {
      fatal('[slack] clean_restart: bot teardown failed — aborting restart:', err)
      deps.exit(1)
    }

    // Phases 5-6: Start new server and exit
    console.error('[slack] clean_restart: starting server')
    const startResult = deps.spawnSync(process.execPath, [process.argv[1], 'start'])
    if (startResult.status !== 0) {
      fatal(`[slack] clean_restart: start failed with exit code ${startResult.status}`)
      deps.exit(startResult.status ?? 1)
    }
    console.error('[slack] clean_restart: done')
  }

  /**
   * `credentials <persona>` (b.av2 SR-12, SR-1.4 part): find the persona by
   * name or key (`resolvePersonaTarget`) in the configuration file as it
   * stands, then run the packaged credentials script for its
   * `credentials_file` on this terminal and exit with the script's status.
   * The script asks for the tokens without echo, validates them with Slack
   * and writes the file with mode 0600 (see `scripts/write-credentials.sh`).
   *
   * Exits 2 with the usage line unless given exactly one non-empty argument,
   * and 1 when the configuration file cannot be loaded (the loader's error,
   * which names the file) or no persona has that name or key (the line lists
   * the declared personas and never repeats the argument, in case a token was
   * typed there). Needs no running server and no agent-director.
   */
  async function credentials(args: readonly string[]): Promise<void> {
    if (args.length !== 1 || args[0] === '') {
      console.error(CREDENTIALS_USAGE)
      return deps.exit(2)
    }
    const configPath = deps.resolveConfigPath()
    let config: PersonaConfig
    try {
      config = deps.loadConfigFile(configPath)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error(`credentials: cannot read the personas in ${configPath}: ${msg}`)
      return deps.exit(1)
    }
    const persona = resolvePersonaTarget(config, args[0])
    if (persona === undefined) {
      const declared = config.personas.map((p) => renderPersonaRef(p.name, p.key)).join(', ')
      console.error(
        `credentials: no persona in ${configPath} has that name or key; declare it there first ` +
          `(declared: ${declared === '' ? 'none' : declared})`,
      )
      return deps.exit(1)
    }
    console.error(`Credentials file of persona ${renderPersonaRef(persona.name, persona.key)}: ${persona.credentials_file}`)
    return deps.exit(deps.runCredentialsScript(persona.credentials_file))
  }

  return { start, stop, clean_restart, credentials }
}

// ---------------------------------------------------------------------------
// Production credentials script runner
// ---------------------------------------------------------------------------

/**
 * The production `runCredentialsScript`: `bash <CREDENTIALS_SCRIPT_PATH>
 * <credentialsFile>` with stdio inherited and this process's environment.
 * While it runs, this process ignores SIGINT and SIGQUIT, as a shell does for
 * a foreground job: Ctrl-C reaches the script, which removes its temporary
 * file and exits, and this process then exits with its status instead of
 * returning the prompt first. A script killed by a signal counts as 1.
 */
function runCredentialsScript(credentialsFile: string): number {
  if (!existsSync(CREDENTIALS_SCRIPT_PATH)) {
    console.error(
      `credentials: the credentials script ${CREDENTIALS_SCRIPT_PATH} is missing; reinstall claude-slack-channel-bots`,
    )
    return 1
  }
  const ignore = (): void => {}
  process.on('SIGINT', ignore)
  process.on('SIGQUIT', ignore)
  try {
    const result = spawnSync('bash', [CREDENTIALS_SCRIPT_PATH, credentialsFile], { stdio: 'inherit' })
    if (result.error !== undefined) {
      console.error(`credentials: could not run bash: ${describeThrownValue(result.error)}`)
      return 1
    }
    return result.status ?? 1
  } finally {
    process.off('SIGINT', ignore)
    process.off('SIGQUIT', ignore)
  }
}

// ---------------------------------------------------------------------------
// Production agent-director operations for the persona teardown
// ---------------------------------------------------------------------------

/** The agent-director operations `teardownBots` uses (the `director*` CliDeps). */
export type DirectorOps = Pick<CliDeps, 'directorStatus' | 'directorPause' | 'directorKill'>

/** The part of the agent-director Client that `createDirectorOps` calls. */
export type DirectorClient = Pick<Client, 'status' | 'pause' | 'kill'>

/**
 * Build the production `directorStatus` / `directorPause` / `directorKill`
 * deps over `getClient` (the agent-director singleton accessor in production).
 * `getClient` is called on every operation, so the Client installed by
 * `initClient` is picked up and an uninstalled one throws at the call.
 *
 * Each `id` is a persona's instance ID, `cscb_<key>` (b.av2 SR-8.7). b.qwo:
 * only ErrSpawnNotFound means "no row" — `directorStatus` returns null and
 * `directorKill` returns normally; every other error (AD unreachable, no
 * Client installed, a call timeout, …) propagates so the teardown fails
 * loudly. `directorPause` passes every error through.
 */
export function createDirectorOps(getClient: () => DirectorClient): DirectorOps {
  return {
    directorStatus: async (id) => {
      try {
        const r = await getClient().status({ claude_instance_id: id })
        return { state: r.state }
      } catch (err) {
        if (err instanceof ErrSpawnNotFound) return null
        throw err
      }
    },
    directorPause: async (id) => {
      await getClient().pause({ claude_instance_id: id })
    },
    directorKill: async (id) => {
      try {
        await getClient().kill({ claude_instance_id: id })
      } catch (err) {
        if (err instanceof ErrSpawnNotFound) return
        throw err
      }
    },
  }
}

// ---------------------------------------------------------------------------
// Top-level entry point
// ---------------------------------------------------------------------------

if (import.meta.main) {
  const subcommand = process.argv[2]

  if (subcommand !== 'start' && subcommand !== 'stop' && subcommand !== 'clean_restart' && subcommand !== 'credentials') {
    console.error('Usage: cli.ts <start|stop|clean_restart|credentials> [flags]')
    console.error('')
    console.error('  start          Validate prerequisites and start the server in the background')
    console.error('  stop           Send SIGTERM to a running server')
    console.error('  clean_restart  Exit all managed sessions, then stop and start the server')
    console.error("  credentials    <persona name or key>: write that persona's credentials file from this terminal")
    console.error('')
    console.error('stop flags:')
    console.error('  --stop-bots    Gracefully exit all managed bots before stopping the server')
    process.exit(1)
  }

  const directorOps = createDirectorOps(getClient)

  const realDeps: CliDeps = {
    spawnSync: (cmd, args) => spawnSync(cmd, args, { stdio: 'ignore' }),
    spawnDaemon: (cmd, args, opts) => spawn(cmd, args, opts),
    openLogAppend: (path) => openSync(path, 'a'),
    closeFd: (fd) => closeSync(fd),
    initLogging,
    existsSync,
    readFileSync: (path) => readFileSync(path, 'utf-8'),
    fileSize,
    readFileFrom,
    now: () => Date.now(),
    sleep: (ms) => new Promise<void>((r) => setTimeout(r, ms)),
    unlinkSync,
    isProcessRunning,
    kill: (pid, signal) => process.kill(pid, signal as NodeJS.Signals),
    resolveStateDir: () => resolveServerStateDir(),
    resolveConfigPath: () => resolveServerConfigPath(),
    startServer: async () => { const { main } = await import('./server.ts'); return main() },
    exit: (code) => process.exit(code),
    loadConfig: (path) => readAppliedPersonaConfig(path),
    loadConfigFile: (path) => loadPersonaConfig(path),
    runCredentialsScript,
    // b.qwo: install the AD Client singleton via the non-exiting startup gate
    // before teardown. runStartupGate performs Client.create() + setClient() and
    // returns a typed outcome; on failure we throw so the caller (clean_restart /
    // stop --stop-bots) exits loudly rather than silently skipping teardown.
    // Both run the full gate, CSCB's Phase 1 floor included (b.jg5 SRJ-203);
    // the thrown error keeps the outcome's refusal kind.
    initClient: async () => {
      const outcome = await runStartupGate()
      if (!outcome.ok) {
        throw new StartupGateFailedError(outcome.classLabel, outcome.message, outcome.refusalKind)
      }
    },
    directorStatus: directorOps.directorStatus,
    directorPause: directorOps.directorPause,
    directorKill: directorOps.directorKill,
  }

  const cli = createCli(realDeps)

  if (subcommand === 'start') {
    cli.start().catch((err) => {
      console.error('[slack] Fatal:', err)
      process.exit(1)
    })
  } else if (subcommand === 'stop') {
    const stopBots = process.argv.slice(3).includes('--stop-bots')
    cli.stop({ stopBots }).catch((err) => {
      console.error('[slack] Fatal:', err)
      process.exit(1)
    })
  } else if (subcommand === 'credentials') {
    cli.credentials(process.argv.slice(3)).catch((err) => {
      console.error('[slack] Fatal:', err)
      process.exit(1)
    })
  } else {
    cli.clean_restart().catch((err) => {
      console.error('[slack] Fatal:', err)
      process.exit(1)
    })
  }
}
