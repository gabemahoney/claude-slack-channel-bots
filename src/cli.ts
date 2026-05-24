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
      const child = spawn(process.execPath, [import.meta.filename, 'start'], {
        detached: true,
        stdio: ['ignore', logFd, logFd],
        env: { ...process.env, _CLI_DAEMON_CHILD: '1' },
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

    // Phases 3-4: SR-11 Event 12 — pause + poll via agent-director.
    // Per-route teardown: client.pause(), then poll client.status() until
    // ended/missing or exit_timeout elapses; escalate to client.kill().
    await Promise.allSettled(Object.entries(routes).map(async ([channelId]) => {
      try {
        // Precheck: any row? If not, nothing to do.
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
      } catch (err) {
        console.error(`[slack] clean_restart: error processing channel=${channelId}:`, err)
      }
    }))

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
    console.error('Usage: cli.ts <start|stop|clean_restart>')
    console.error('')
    console.error('  start          Validate prerequisites and start the server in the background')
    console.error('  stop           Send SIGTERM to a running server')
    console.error('  clean_restart  Exit all managed sessions, then stop and start the server')
    process.exit(1)
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
    directorStatus: async (channelId) => {
      try {
        const r = await getClient().status({ claude_instance_id: instanceIdFor(channelId) })
        return { state: r.state }
      } catch (err) {
        if (err instanceof ErrSpawnNotFound) return null
        throw err
      }
    },
    directorPause: async (channelId) => {
      await getClient().pause({ claude_instance_id: instanceIdFor(channelId) })
    },
    directorKill: async (channelId) => {
      try {
        await getClient().kill({ claude_instance_id: instanceIdFor(channelId) })
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
