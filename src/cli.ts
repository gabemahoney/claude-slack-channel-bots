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
import { ErrSpawnNotFound } from './agent-director-errors.ts'
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
   * b.qwo: initialize the agent-director Client singleton before any per-channel
   * teardown work. clean_restart / `stop --stop-bots` run in a short-lived CLI
   * process that never runs the server startup gate, so getClient() would throw
   * (the b.qps root cause). Production wires this to the non-exiting
   * runStartupGate variant; on failure the caller exits loudly (AD-unreachable
   * is never a silent skip). Optional so tests that install a stub singleton via
   * setClientForTests can omit it — when absent, callers skip init and use the
   * already-installed stub.
   */
  initClient?: () => Promise<void>
  /** Query the agent-director state for a channel. Returns null when the row is absent. */
  directorStatus: (channelId: string) => Promise<{ state: string } | null>
  /** Politely shut down the spawn for a channel via client.pause. */
  directorPause: (channelId: string) => Promise<void>
  /**
   * Hard-terminate the spawn for a channel via client.kill. May throw
   * ErrSpawnNotFound for an already-gone row; the real deps absorb it and
   * teardownBots also tolerates it at the call sites — the double-layer
   * leniency is intentional (b.dnt).
   */
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
}

/**
 * Build CLI handlers bound to injectable dependencies.
 * Call with real deps from top-level code; call with stubs in tests.
 */
export function createCli(deps: CliDeps): CliHandlers {
  /**
   * b.4dk: per-route graceful bot teardown — SR-11 Event 12's pause/poll/kill
   * sequence, extracted so both clean_restart and `stop --stop-bots` reuse the
   * exact same tested logic instead of duplicating it.
   *
   * For each route: precheck the row state; skip absent/terminal rows;
   * client.pause() (sends `/exit` → SessionEnd reason prompt_input_exit → the
   * row reaches `ended`); poll client.status() with exponential backoff until
   * ended/missing or exit_timeout elapses; on timeout escalate to
   * client.kill(). NOTE: a kill escalation does NOT guarantee an `ended` row —
   * that residual case is recovered later via the findMissing→resume path.
   */
  async function teardownBots(routes: RoutingConfig['routes'], exit_timeout: number): Promise<void> {
    // b.qwo: the precheck's directorStatus() reaches agent-director. If AD is
    // unreachable (the b.qps/incident-2026-09-18 root cause: getClient() throws
    // in the short-lived CLI process, or the AD binary is down), that error MUST
    // NOT be swallowed as a per-channel "no spawn row — skipping" no-op. We let
    // the precheck error propagate to Promise.allSettled as a rejection, then
    // throw a loud aggregate error after the loop so callers exit non-zero and
    // never proceed to `start`. b.dnt: escalation/timeout kill failures on a
    // present row also reject into the aggregate now — only the benign
    // ErrSpawnNotFound already-gone race stays per-channel handled below.
    const results = await Promise.allSettled(Object.entries(routes).map(async ([channelId]) => {
      // Precheck: any row? If not, nothing to do.
      // NOTE (b.qwo): errors here (AD unreachable / uninitialized client)
      // intentionally propagate — they become allSettled rejections handled
      // by the post-loop loud-failure check. "no spawn row" is reported ONLY
      // when directorStatus resolves to null (row genuinely absent).
      const precheck = await deps.directorStatus(channelId)
      if (precheck === null) {
        console.error(`[slack] teardownBots: no spawn row for channel=${channelId} — skipping`)
        return
      }
      const state = precheck.state
      if (state === 'ended' || state === 'missing') {
        console.error(`[slack] teardownBots: channel=${channelId} already terminal (state=${state}) — skipping`)
        return
      }

      // pause and poll for terminal transition
      try {
        await deps.directorPause(channelId)
      } catch (err) {
        console.error(`[slack] teardownBots: pause failed for channel=${channelId} — escalating to kill:`, err)
        // b.dnt: the kill's outcome decides this channel's fate. A benign
        // ErrSpawnNotFound (row genuinely already gone) resolves quietly;
        // any other kill error (e.g. AD died mid-teardown) rethrows so it
        // rejects into the Promise.allSettled aggregate below. SR-0.2:
        // branch via the typed class, never on error strings.
        try {
          await deps.directorKill(channelId)
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
        const pollResult = await deps.directorStatus(channelId)
        if (pollResult === null || pollResult.state === 'ended' || pollResult.state === 'missing') {
          const elapsed = Date.now() - startTime
          console.error(`[slack] teardownBots: channel=${channelId} exited cleanly in ${elapsed}ms`)
          return
        }
      }

      // Timeout — force kill via agent-director
      const elapsed = Date.now() - startTime
      try {
        await deps.directorKill(channelId)
        console.error(`[slack] teardownBots: channel=${channelId} force-killed after ${elapsed}ms`)
      } catch (err) {
        console.error(`[slack] teardownBots: kill failed for channel=${channelId}:`, err)
        // b.dnt: same rule as the escalation path — a throwing kill here means
        // AD is dead mid-teardown, not a benign already-gone row. Rethrow so it
        // rejects into the aggregate; swallow only the benign ErrSpawnNotFound.
        if (!(err instanceof ErrSpawnNotFound)) throw err
      }
    }))

    // b.qwo: loud AD-unreachable failure. A rejected settlement here is an
    // agent-director error — from the connectivity/precheck at the top of a
    // channel's teardown, from a directorStatus poll-loop call, or
    // (b.dnt) from an escalation/timeout kill that failed with anything other
    // than the benign ErrSpawnNotFound already-gone race — never a normal
    // terminal-row skip, which resolves. Surface every one and throw so the
    // teardown is never a silent no-op and the caller aborts before starting a
    // new server.
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected')
    if (rejected.length > 0) {
      for (const r of rejected) {
        console.error('[slack] teardownBots: agent-director error during teardown:', r.reason)
      }
      throw new Error(
        `teardownBots: agent-director error — teardown incomplete for ${rejected.length} channel(s); ` +
          `other channels may already have been paused or killed; rows are never deleted, safe to retry`,
      )
    }
  }

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
    // onsessionclosed handler (src/server.ts:381-403) would scheduleRestart the
    // channel, respawning it fresh (deleting its `ended` row and history) before
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
          console.error('[slack] stop --stop-bots: agent-director initialization failed:', err)
          deps.exit(1)
        }
      }

      // Config load is best-effort: a config problem logs and skips teardown
      // without failing the stop (the server is already down; b.4dk behavior).
      let config: RoutingConfig | null = null
      try {
        config = deps.loadConfig()
      } catch (err) {
        console.error('[slack] stop --stop-bots: could not load config — skipping bot teardown:', err)
      }

      // b.qwo: a teardown failure (AD unreachable) is a LOUD failure — exit
      // non-zero rather than swallowing it and reporting a clean stop.
      if (config !== null) {
        console.error('[slack] stop --stop-bots: gracefully exiting managed bots')
        try {
          await teardownBots(config.routes, config.exit_timeout)
        } catch (err) {
          console.error('[slack] stop --stop-bots: bot teardown failed:', err)
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
        return 0
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
        return 0
      }
    }

    console.error('[slack] Warning: server did not die after SIGKILL.')
    return 1
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

    // Phase 2.5 (b.qwo): initialize the AD Client singleton before per-channel
    // work. This CLI process does NOT run the server startup gate, so without
    // explicit init getClient() throws (the b.qps root cause). We use the
    // non-exiting runStartupGate variant so a gate failure surfaces here as a
    // distinct loud non-zero exit rather than a silently skipped teardown.
    if (deps.initClient) {
      try {
        await deps.initClient()
      } catch (err) {
        console.error('[slack] clean_restart: agent-director initialization failed:', err)
        deps.exit(1)
      }
    }

    // Phases 3-4: SR-11 Event 12 — per-route pause/poll/kill teardown via
    // agent-director (shared with `stop --stop-bots`).
    //
    // b.qwo: teardownBots throws if AD is unreachable during the precheck. A
    // failed teardown must abort the restart — never proceed to `start` on top
    // of bots we could not reach.
    try {
      await teardownBots(routes, exit_timeout)
    } catch (err) {
      console.error('[slack] clean_restart: bot teardown failed — aborting restart:', err)
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
    console.error('stop flags:')
    console.error('  --stop-bots    Gracefully exit all managed bots before stopping the server')
    console.error('')
    console.error('Flags (b.1m9):')
    console.error('  --reconcile-instance-ids   Auto-delete stale pre-rename cscb_<id> AD rows on startup')
    process.exit(1)
  }

  // Resolve a channel's actual claude_instance_id by querying agent-director's
  // label index. Survives the b.1m9 naming change (cscb_<name>_<id>) without
  // requiring the CLI to know the route's normalizedName.
  //
  // b.qwo: returns null ONLY when no cscb row exists for the channel (empty
  // list). All other errors (AD connection refused, uninitialized client,
  // binary unreachable, etc.) PROPAGATE. The previous bare `catch { return
  // null }` was the b.qps / incident-2026-09-18 root cause: it collapsed an
  // AD-unreachable throw into a "no row" null, so the teardown skipped every
  // channel and silently no-op'd. AD-unreachable must fail loudly, and "no
  // spawn row" must mean the row is genuinely absent.
  async function resolveCscbInstanceId(channelId: string): Promise<string | null> {
    const r = await getClient().list({ label: ['service=cscb', `channel=${channelId}`] })
    if (r.spawns.length === 0) return null
    // Prefer the new-naming row if both old and new exist mid-migration.
    const newStyle = r.spawns.find((s) => s.claude_instance_id !== `cscb_${channelId}`)
    return (newStyle ?? r.spawns[0]).claude_instance_id
  }

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
    // b.qwo: install the AD Client singleton via the non-exiting startup gate
    // before teardown. runStartupGate performs Client.create() + setClient() and
    // returns a typed outcome; on failure we throw so the caller (clean_restart /
    // stop --stop-bots) exits loudly rather than silently skipping teardown.
    initClient: async () => {
      const outcome = await runStartupGate()
      if (!outcome.ok) {
        throw new Error(
          `agent-director startup gate failed (${outcome.classLabel}): ${outcome.message}`,
        )
      }
    },
    directorStatus: async (channelId) => {
      // Resolve the actual claude_instance_id by label (cscb_<name>_<id> after b.1m9,
      // or cscb_<id> on pre-rename installs). Falls back to bare-ID lookup if
      // listing isn't possible, preserving compatibility with single-row stubs.
      const id = await resolveCscbInstanceId(channelId)
      if (id === null) return null
      try {
        const r = await getClient().status({ claude_instance_id: id })
        return { state: r.state }
      } catch (err) {
        if (err instanceof ErrSpawnNotFound) return null
        throw err
      }
    },
    directorPause: async (channelId) => {
      const id = (await resolveCscbInstanceId(channelId)) ?? instanceIdFor(channelId)
      await getClient().pause({ claude_instance_id: id })
    },
    directorKill: async (channelId) => {
      try {
        const id = (await resolveCscbInstanceId(channelId)) ?? instanceIdFor(channelId)
        await getClient().kill({ claude_instance_id: id })
      } catch (err) {
        if (err instanceof ErrSpawnNotFound) return
        throw err
      }
    },
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
  } else {
    cli.clean_restart().catch((err) => {
      console.error('[slack] Fatal:', err)
      process.exit(1)
    })
  }
}
