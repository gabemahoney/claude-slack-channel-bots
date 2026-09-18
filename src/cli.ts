#!/usr/bin/env bun
/**
 * cli.ts — Command-line entry point for the Slack Channel Router.
 *
 * Subcommands:
 *   start  — Validate prerequisites then launch server in the background.
 *   stop   — Send SIGTERM to a running server via its PID file.
 *
 * SPDX-License-Identifier: MIT
 */

import { homedir } from 'os'
import { join, resolve } from 'path'
import { existsSync, openSync, readFileSync, unlinkSync } from 'fs'
import { spawnSync } from 'child_process'
import { isProcessRunning } from './pid.ts'
import { loadConfig as configLoadConfig, type RoutingConfig } from './config.ts'
import { initLogging } from './logging.ts'
import { isDryRun } from './tokens.ts'
import { ErrSpawnNotFound } from 'agent-director'
import { getClient } from './agent-director-client.ts'
import { instanceIdFor } from './session-manager.ts'
import { runStartupGate } from './agent-director-startup.ts'

// ---------------------------------------------------------------------------
// Injectable dependency interface
// ---------------------------------------------------------------------------

export interface CliDeps {
  /** Run a command and return its exit code (or null if spawn failed). */
  spawnSync: (cmd: string, args: string[]) => { status: number | null }
  /** Current process environment. */
  env: NodeJS.ProcessEnv
  /** Check whether a file path exists. */
  existsSync: (path: string) => boolean
  /** Read a file as UTF-8 text. */
  readFileSync: (path: string) => string
  /** Remove a file. */
  unlinkSync: (path: string) => void
  /** Check whether a PID corresponds to a running process. */
  isProcessRunning: (pid: number) => boolean
  /** Kill a process with the given signal. */
  kill: (pid: number, signal: string | number) => void
  /** Resolve STATE_DIR from env or default. */
  resolveStateDir: () => string
  /** Launch the server. Resolves when server startup completes (or throws). */
  startServer: () => Promise<void>
  /** Exit the process. */
  exit: (code: number) => never
  /** Load the routing configuration. */
  loadConfig: () => RoutingConfig
  /**
   * Return the agent-director Client singleton.
   * Test-seam affordance: production wiring goes through buildRealDirectorDeps(getClient);
   * this slot lets test deps reach the same stub client without forking a subprocess.
   */
  getClient: () => import('agent-director').Client
  /**
   * Initialize the AD Client singleton before per-channel work. Optional seam;
   * production wires runStartupGate (non-exiting variant) so version/API gating
   * stays consistent. Tests inject a stub to drive success and gate-failure paths
   * without a real Client.create. When absent, callers fall through to the real
   * runStartupGate path.
   */
  initClient?: () => Promise<void>
  /** Query the agent-director state for a channel. Returns null when the row is absent. */
  directorStatus: (channelId: string) => Promise<{ state: string } | null>
  /** Politely shut down the spawn for a channel via client.pause. */
  directorPause: (channelId: string) => Promise<void>
  /** Hard-terminate the spawn for a channel via client.kill. */
  directorKill: (channelId: string) => Promise<void>
}

// ---------------------------------------------------------------------------
// Default STATE_DIR resolver
// ---------------------------------------------------------------------------

function defaultStateDir(): string {
  const fromEnv = process.env['SLACK_STATE_DIR']
  return fromEnv ? resolve(fromEnv) : join(homedir(), '.claude', 'channels', 'slack')
}

// ---------------------------------------------------------------------------
// Factory — createCli
// ---------------------------------------------------------------------------

export interface CliHandlers {
  start: () => Promise<void>
  stop: () => Promise<void>
  clean_restart: () => Promise<void>
}

/**
 * Build CLI handlers bound to injectable dependencies.
 * Call with real deps from top-level code; call with stubs in tests.
 */
export function createCli(deps: CliDeps): CliHandlers {
  async function start(): Promise<void> {
    // tmux is no longer a CSCB-direct prerequisite — agent-director owns the
    // tmux integration. CSCB still requires it transitively but the
    // SR-5.1 startup gate is the single source of truth for runtime checks.

    // Check required Slack tokens (skipped in dry-run mode)
    if (!isDryRun()) {
      if (!deps.env['SLACK_BOT_TOKEN']) {
        console.error('missing prerequisite: SLACK_BOT_TOKEN environment variable')
        deps.exit(1)
      }
      if (!deps.env['SLACK_APP_TOKEN']) {
        console.error('missing prerequisite: SLACK_APP_TOKEN environment variable')
        deps.exit(1)
      }
    }

    // Check config.json exists
    const stateDir = deps.resolveStateDir()
    const routingJson = join(stateDir, 'config.json')
    if (!deps.existsSync(routingJson)) {
      console.error(`missing prerequisite: config.json not found at ${routingJson}`)
      deps.exit(1)
    }

    // All checks passed — daemonize: parent exits, child continues as server
    // In Bun, we detect the child vs parent by an env marker.
    if (!process.env['_CLI_DAEMON_CHILD']) {
      // Parent: spawn a detached background child and exit
      const { spawn } = await import('child_process')
      const logPath = join(stateDir, 'server.log')
      const logFd = openSync(logPath, 'a')
      // b.1m9: propagate --reconcile-instance-ids to the daemon child via env.
      const childEnv: NodeJS.ProcessEnv = { ...process.env, _CLI_DAEMON_CHILD: '1' }
      if (process.argv.includes('--reconcile-instance-ids')) {
        childEnv['CSCB_RECONCILE_INSTANCE_IDS'] = '1'
      }
      const child = spawn(process.execPath, [import.meta.filename, 'start'], {
        detached: true,
        stdio: ['ignore', logFd, logFd],
        env: childEnv,
      })
      child.unref()
      console.error(`[slack] Server starting in background (PID ${child.pid})`)
      deps.exit(0)
    }

    // Child (daemon): redirect stderr/stdout to server.log
    try { initLogging(join(stateDir, 'server.log')) } catch { /* best-effort: log redirect failure is non-fatal */ }

    // Child (daemon): start the server
    await deps.startServer()
  }

  async function stop(): Promise<void> {
    const stateDir = deps.resolveStateDir()
    const pidFile = join(stateDir, 'server.pid')

    if (!deps.existsSync(pidFile)) {
      console.error('server is not running')
      deps.exit(0)
    }

    let pid: number
    try {
      const raw = deps.readFileSync(pidFile).trim()
      pid = parseInt(raw, 10)
      if (isNaN(pid)) throw new Error(`invalid PID: ${raw}`)
    } catch (err) {
      console.error(`[slack] Could not read PID file: ${err}`)
      deps.exit(1)
    }

    if (!deps.isProcessRunning(pid!)) {
      // Stale PID file
      try {
        deps.unlinkSync(pidFile)
      } catch { /* ignore */ }
      console.error('server is not running (removed stale PID file)')
      deps.exit(0)
    }

    // Load stop_timeout from config (fall back to 30s if unavailable)
    let stopTimeoutMs = 30_000
    try {
      const config = deps.loadConfig()
      if (typeof config.stop_timeout === 'number') {
        stopTimeoutMs = config.stop_timeout * 1000
      }
    } catch { /* use default */ }

    // Live process — send SIGTERM and poll until exit or stop_timeout
    deps.kill(pid!, 'SIGTERM')

    const deadline = Date.now() + stopTimeoutMs
    while (Date.now() < deadline) {
      await new Promise<void>((r) => setTimeout(r, 100))
      if (!deps.isProcessRunning(pid!)) {
        try { deps.unlinkSync(pidFile) } catch { /* ignore */ }
        console.error('[slack] Server stopped.')
        deps.exit(0)
      }
    }

    // SIGTERM timed out — escalate to SIGKILL
    console.error(`[slack] Warning: server did not stop within ${stopTimeoutMs / 1000}s after SIGTERM — sending SIGKILL.`)
    deps.kill(pid!, 'SIGKILL')

    // Poll briefly (~2s) to confirm death after SIGKILL
    const killDeadline = Date.now() + 2000
    while (Date.now() < killDeadline) {
      await new Promise<void>((r) => setTimeout(r, 100))
      if (!deps.isProcessRunning(pid!)) {
        try { deps.unlinkSync(pidFile) } catch { /* ignore */ }
        console.error('[slack] Server killed.')
        deps.exit(0)
      }
    }

    console.error('[slack] Warning: server did not die after SIGKILL.')
    deps.exit(1)
  }

  async function clean_restart(): Promise<void> {
    try { initLogging(join(deps.resolveStateDir(), 'clean_restart.log')) } catch { /* best-effort */ }

    // Phase 1: Load config
    let config: RoutingConfig
    try {
      config = deps.loadConfig()
    } catch (err) {
      console.error('[slack] clean_restart: failed to load config:', err)
      deps.exit(1)
    }
    const { routes, exit_timeout } = config!

    // Phase 2: Stop the server daemon
    console.error('[slack] clean_restart: stopping server')
    const stopResult = deps.spawnSync(process.execPath, [process.argv[1], 'stop'])
    if (stopResult.status !== 0) {
      console.error(`[slack] clean_restart: stop returned non-zero exit code: ${stopResult.status}`)
    }

    // Phase 2.5: Initialize the AD Client singleton before any per-channel work.
    //
    // clean_restart runs in a short-lived CLI process that does NOT run the
    // server startup gate. Without explicit init, getClient() throws because the
    // singleton was never installed. We use the non-exiting runStartupGate
    // variant (rather than runAgentDirectorStartupGate) so that gate failures
    // surface here as a distinct loud error with a clear message, rather than
    // relying on recordStartupError's side-effects.
    //
    // Design: initClient is optional in CliDeps. When provided (production
    // realDeps sets it to the runStartupGate wrapper), it is called and its
    // failure causes an immediate loud non-zero exit. When absent (tests that
    // install a stub via setClientForTests and wire deps.directorStatus directly),
    // the gate is skipped — the stub is already the active singleton.
    if (deps.initClient) {
      try {
        await deps.initClient()
      } catch (err) {
        console.error('[slack] clean_restart: agent-director initialization failed:', err)
        deps.exit(1)
      }
    }

    // Phases 3-4: SR-11 Event 12 — pause + poll via agent-director.
    // Per-route teardown: client.pause(), then poll client.status() until
    // ended/missing or exit_timeout elapses; escalate to client.kill().
    //
    // SR-27.6 concurrency analysis:
    //
    // Case A — two concurrent clean_restart invocations:
    //   stop serializes teardown via SIGTERM + poll (the stop sub-command sends
    //   SIGTERM and polls until the server process exits). A second clean_restart
    //   calling stop while the first is mid-poll will block in its own stop
    //   poll until the server is confirmed dead. After stop, the AD
    //   pause/kill verbs are idempotent on terminal rows (a pause/kill on an
    //   already-ended row is a no-op or ErrSpawnNotFound — both handled), so
    //   concurrent teardown phases are safe without a lockfile.
    //
    // Case B — start-when-running (second clean_restart's 'start' while first
    //   server is still alive):
    //   The daemon child's main() calls checkPidConflict (src/pid.ts → invoked
    //   from server.ts main()); if another server process holds the pidfile,
    //   the child exits(1). The exit is silent to the clean_restart caller
    //   because start spawns detached. This is acceptable pre-existing behavior;
    //   documented here rather than fixed (a lockfile would not prevent the race
    //   between the detached child writing the pidfile and a second start).
    //
    // Case C — exit_timeout honored:
    //   The existing poll loop reads exit_timeout from config at teardown time
    //   (loaded in Phase 1 above), so the configured budget is always observed.
    //
    // Conclusion: no lockfile is necessary. Concurrent clean_restart invocations
    // are safe given stop-serialization and idempotent AD verbs.
    const results = await Promise.allSettled(Object.entries(routes).map(async ([channelId]) => {
      // Precheck: any row? If not, nothing to do.
      // NOTE: errors here (e.g. AD connection refused) are intentionally NOT
      // caught — they propagate to allSettled as rejections so the post-loop
      // check can detect AD connectivity failures and exit non-zero.
      const precheck = await deps.directorStatus(channelId)
      if (precheck === null) {
        console.error(`[slack] clean_restart: no spawn row for channel=${channelId} — skipping`)
        return
      }
      const state = precheck.state
      if (state === 'ended' || state === 'missing') {
        console.error(`[slack] clean_restart: channel=${channelId} already terminal (state=${state}) — skipping`)
        return
      }

      // Phase 4: pause and poll for terminal transition
      try {
        await deps.directorPause(channelId)
      } catch (err) {
        console.error(`[slack] clean_restart: pause failed for channel=${channelId} — escalating to kill:`, err)
        try { await deps.directorKill(channelId) } catch { /* ignore */ }
        return
      }

      const timeoutMs = exit_timeout * 1000
      const startTime = Date.now()
      let delay = 100
      const maxDelay = 2_000

      while (Date.now() - startTime < timeoutMs) {
        await new Promise<void>((r) => setTimeout(r, delay))
        delay = Math.min(delay * 2, maxDelay)
        const pollResult = await deps.directorStatus(channelId)
        if (pollResult === null || pollResult.state === 'ended' || pollResult.state === 'missing') {
          const elapsed = Date.now() - startTime
          console.error(`[slack] clean_restart: channel=${channelId} exited cleanly in ${elapsed}ms`)
          return
        }
      }

      // Timeout — force kill via agent-director
      const elapsed = Date.now() - startTime
      try {
        await deps.directorKill(channelId)
        console.error(`[slack] clean_restart: channel=${channelId} force-killed after ${elapsed}ms`)
      } catch (err) {
        console.error(`[slack] clean_restart: kill failed for channel=${channelId}:`, err)
      }
    }))

    // Post-loop: if any channel's precheck threw (e.g. AD connection refused),
    // those rejections surface here. Exit non-zero so the caller knows the
    // restart did not complete cleanly — never proceed to 'start' in this case.
    const rejected = results.filter((r) => r.status === 'rejected')
    if (rejected.length > 0) {
      for (const r of rejected) {
        console.error(
          '[slack] clean_restart: agent-director error during teardown:',
          (r as PromiseRejectedResult).reason,
        )
      }
      deps.exit(1)
    }

    // Phases 5-6: Start new server and exit
    console.error('[slack] clean_restart: starting server')
    const startResult = deps.spawnSync(process.execPath, [process.argv[1], 'start'])
    if (startResult.status !== 0) {
      console.error(`[slack] clean_restart: start failed with exit code ${startResult.status}`)
      deps.exit(startResult.status ?? 1)
    }
    console.error('[slack] clean_restart: done')
  }

  return { start, stop, clean_restart }
}

// ---------------------------------------------------------------------------
// Exported factory — buildRealDirectorDeps
// ---------------------------------------------------------------------------

/**
 * Build the real agent-director verb deps (directorStatus, directorPause,
 * directorKill) wired through the given getClientFn.
 *
 * Extracted from the import.meta.main block so tests can drive the real
 * resolveCscbInstanceId path (SR-29.2 #1) via a stub Client installed with
 * setClientForTests, without forking a subprocess. The import.meta.main block
 * consumes this factory as: buildRealDirectorDeps(getClient).
 *
 * SR-27.2: resolveCscbInstanceId returns null ONLY on a genuine empty list
 * (spawns.length === 0). Any other error (connection refused, binary missing,
 * etc.) propagates — the bare catch that collapsed AD-unreachable to silent
 * null was the SR-27.1 incident root cause and is removed here.
 */
export function buildRealDirectorDeps(
  getClientFn: () => import('agent-director').Client,
): Pick<CliDeps, 'directorStatus' | 'directorPause' | 'directorKill'> {
  // Resolve a channel's actual claude_instance_id by querying agent-director's
  // label index. Survives the b.1m9 naming change (cscb_<name>_<id>) without
  // requiring the CLI to know the route's normalizedName.
  //
  // Returns null ONLY when no cscb row exists for the channel (empty list).
  // All other errors (AD connection refused, binary unreachable, etc.) propagate
  // to the caller — the previous bare `catch { return null }` was the root cause
  // of SR-27.1 (AD-unreachable silently treated as "no row").
  async function resolveCscbInstanceId(channelId: string): Promise<string | null> {
    const r = await getClientFn().list({ label: ['service=cscb', `channel=${channelId}`] })
    if (r.spawns.length === 0) return null
    // Prefer the new-naming row if both old and new exist mid-migration.
    const newStyle = r.spawns.find((s) => s.claude_instance_id !== `cscb_${channelId}`)
    return (newStyle ?? r.spawns[0]).claude_instance_id
  }

  return {
    directorStatus: async (channelId) => {
      // Resolve the actual claude_instance_id by label (cscb_<name>_<id> after b.1m9,
      // or cscb_<id> on pre-rename installs). If no row exists, returns null.
      // AD connectivity errors propagate (not caught here).
      const id = await resolveCscbInstanceId(channelId)
      if (id === null) return null
      try {
        const r = await getClientFn().status({ claude_instance_id: id })
        return { state: r.state }
      } catch (err) {
        if (err instanceof ErrSpawnNotFound) return null
        throw err
      }
    },
    directorPause: async (channelId) => {
      const id = (await resolveCscbInstanceId(channelId)) ?? instanceIdFor(channelId)
      await getClientFn().pause({ claude_instance_id: id })
    },
    directorKill: async (channelId) => {
      try {
        const id = (await resolveCscbInstanceId(channelId)) ?? instanceIdFor(channelId)
        await getClientFn().kill({ claude_instance_id: id })
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

  if (subcommand !== 'start' && subcommand !== 'stop' && subcommand !== 'clean_restart') {
    console.error('Usage: cli.ts <start|stop|clean_restart> [flags]')
    console.error('')
    console.error('  start          Validate prerequisites and start the server in the background')
    console.error('  stop           Send SIGTERM to a running server')
    console.error('  clean_restart  Exit all managed sessions, then stop and start the server')
    console.error('')
    console.error('Flags (b.1m9):')
    console.error('  --reconcile-instance-ids   Auto-delete stale pre-rename cscb_<id> AD rows on startup')
    process.exit(1)
  }

  const realDirectorDeps = buildRealDirectorDeps(getClient)

  const realDeps: CliDeps = {
    spawnSync: (cmd, args) => spawnSync(cmd, args, { stdio: 'ignore' }),
    env: process.env,
    existsSync,
    readFileSync: (path) => readFileSync(path, 'utf-8'),
    unlinkSync,
    isProcessRunning,
    kill: (pid, signal) => process.kill(pid, signal as NodeJS.Signals),
    resolveStateDir: defaultStateDir,
    startServer: async () => { const { main } = await import('./server.ts'); return main() },
    exit: (code) => process.exit(code),
    loadConfig: () => configLoadConfig(),
    getClient: () => getClient(),
    // initClient: run the SR-5.1 startup gate (non-exiting variant) to install
    // the Client singleton before per-channel work begins. runStartupGate is
    // chosen over runAgentDirectorStartupGate so that clean_restart controls
    // the error message and exit, keeping gate failures distinct from the
    // recordStartupError side-effects used by the server's startup path.
    initClient: async () => {
      const outcome = await runStartupGate()
      if (!outcome.ok) {
        throw new Error(
          `agent-director startup gate failed (${outcome.classLabel}): ${outcome.message}`,
        )
      }
    },
    directorStatus: realDirectorDeps.directorStatus,
    directorPause: realDirectorDeps.directorPause,
    directorKill: realDirectorDeps.directorKill,
  }

  const cli = createCli(realDeps)

  if (subcommand === 'start') {
    cli.start().catch((err) => {
      console.error('[slack] Fatal:', err)
      process.exit(1)
    })
  } else if (subcommand === 'stop') {
    cli.stop().catch((err) => {
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
