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
import { existsSync, readFileSync, unlinkSync } from 'fs'
import { spawnSync } from 'child_process'
import { isProcessRunning } from './pid.ts'
import { defaultTmuxClient, isClaudeRunning as tmuxIsClaudeRunning } from './tmux.ts'
import { readSessions, type SessionsMap } from './sessions.ts'

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
  /** Returns true if a tmux session with the given name exists. */
  hasSession: (name: string) => Promise<boolean>
  /** Sends keystrokes to the given tmux session. */
  sendKeys: (session: string, keys: string) => Promise<void>
  /** Returns true if a 'claude' process is running in the given tmux session. */
  isClaudeRunning: (session: string) => Promise<boolean>
  /** Kills the named tmux session. */
  killSession: (session: string) => Promise<void>
  /** Read the sessions registry. */
  readSessions: () => SessionsMap
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
    // Check tmux is on PATH
    const tmuxCheck = deps.spawnSync('tmux', ['-V'])
    if (tmuxCheck.status !== 0) {
      console.error('missing prerequisite: tmux (not found on PATH)')
      deps.exit(1)
    }

    // Check required Slack tokens
    if (!deps.env['SLACK_BOT_TOKEN']) {
      console.error('missing prerequisite: SLACK_BOT_TOKEN environment variable')
      deps.exit(1)
    }
    if (!deps.env['SLACK_APP_TOKEN']) {
      console.error('missing prerequisite: SLACK_APP_TOKEN environment variable')
      deps.exit(1)
    }

    // Check routing.json exists
    const stateDir = deps.resolveStateDir()
    const routingJson = join(stateDir, 'routing.json')
    if (!deps.existsSync(routingJson)) {
      console.error(`missing prerequisite: routing.json not found at ${routingJson}`)
      deps.exit(1)
    }

    // All checks passed — daemonize: parent exits, child continues as server
    // In Bun, we detect the child vs parent by an env marker.
    if (!process.env['_CLI_DAEMON_CHILD']) {
      // Parent: spawn a detached background child and exit
      const { spawn } = await import('child_process')
      const child = spawn(process.execPath, [import.meta.filename, 'start'], {
        detached: true,
        stdio: 'ignore',
        env: { ...process.env, _CLI_DAEMON_CHILD: '1' },
      })
      child.unref()
      console.error(`[slack] Server starting in background (PID ${child.pid})`)
      deps.exit(0)
    }

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

    // Live process — send SIGTERM and poll until exit or 5s timeout
    deps.kill(pid!, 'SIGTERM')

    const deadline = Date.now() + 5000
    while (Date.now() < deadline) {
      await new Promise<void>((r) => setTimeout(r, 100))
      if (!deps.isProcessRunning(pid!)) {
        console.error('[slack] Server stopped.')
        deps.exit(0)
      }
    }

    console.error('[slack] Warning: server did not stop within 5s after SIGTERM.')
    deps.exit(0)
  }

  async function clean_restart(): Promise<void> {
    const sessions = deps.readSessions()
    const entries = Object.entries(sessions)

    if (entries.length > 0) {
      console.error(`[slack] clean_restart: sending /exit to ${entries.length} session(s)`)

      // Fan out: send /exit + Enter to all sessions in parallel (best-effort)
      await Promise.all(entries.map(async ([channelId, record]) => {
        try {
          const exists = await deps.hasSession(record.tmuxSession)
          if (!exists) {
            console.error(`[slack] clean_restart: session not found for channel=${channelId}, skipping`)
            return
          }
          await deps.sendKeys(record.tmuxSession, '/exit')
          await deps.sendKeys(record.tmuxSession, 'Enter')
          console.error(`[slack] clean_restart: sent /exit to channel=${channelId} session=${record.tmuxSession}`)
        } catch (err) {
          console.error(`[slack] clean_restart: error sending /exit to channel=${channelId}:`, err)
        }
      }))

      // Poll each session until Claude exits or 60s timeout (best-effort)
      await Promise.all(entries.map(async ([channelId, record]) => {
        try {
          const exists = await deps.hasSession(record.tmuxSession)
          if (!exists) return

          const timeout = 60_000
          const start = Date.now()
          let delay = 500
          const maxDelay = 5_000

          while (Date.now() - start < timeout) {
            const running = await deps.isClaudeRunning(record.tmuxSession)
            if (!running) {
              console.error(`[slack] clean_restart: channel=${channelId} exited cleanly`)
              return
            }
            await new Promise<void>((r) => setTimeout(r, delay))
            delay = Math.min(delay * 2, maxDelay)
          }

          // Timed out — force kill
          console.error(`[slack] clean_restart: timeout waiting for channel=${channelId}, force-killing`)
          try {
            await deps.killSession(record.tmuxSession)
          } catch (err) {
            console.error(`[slack] clean_restart: killSession failed for channel=${channelId}:`, err)
          }
        } catch (err) {
          console.error(`[slack] clean_restart: error polling channel=${channelId}:`, err)
        }
      }))
    }

    // Stop the server
    console.error('[slack] clean_restart: stopping server')
    deps.spawnSync(process.execPath, [process.argv[1], 'stop'])

    // Start the server
    console.error('[slack] clean_restart: starting server')
    const startResult = deps.spawnSync(process.execPath, [process.argv[1], 'start'])
    if (startResult.status !== 0) {
      console.error(`[slack] clean_restart: start failed with exit code ${startResult.status}`)
      deps.exit(startResult.status ?? 1)
    }
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
    hasSession: (name) => defaultTmuxClient.hasSession(name),
    sendKeys: (session, keys) => defaultTmuxClient.sendKeys(session, keys),
    isClaudeRunning: (session) => tmuxIsClaudeRunning(session, defaultTmuxClient),
    killSession: (session) => defaultTmuxClient.killSession(session),
    readSessions: () => readSessions(),
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
