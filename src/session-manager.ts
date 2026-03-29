/**
 * session-manager.ts — Startup orchestration for tmux-managed Claude Code sessions.
 *
 * Handles two cases per route at server startup:
 *   exists  — tmux session found → kill and relaunch
 *   missing — no tmux session → launch fresh
 *
 * SPDX-License-Identifier: MIT
 */

import { type TmuxClient, sessionName, isClaudeRunning } from './tmux.ts'
import { type SessionsMap } from './sessions.ts'
import { type RoutingConfig } from './config.ts'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface LaunchOptions {
  /** Maximum time in ms to poll for the safety prompt. Default: 60000. */
  pollTimeout?: number
}

export interface SessionStateResult {
  channelId: string
  action: 'relaunched' | 'launched' | 'failed'
  sessionName: string
}

// ---------------------------------------------------------------------------
// launchSession
// ---------------------------------------------------------------------------

/**
 * Creates a new tmux session for a Slack channel, launches Claude with the
 * correct MCP config, polls for the safety prompt, and records the session
 * in sessions.json on success.
 *
 * Returns true on success, false on failure.
 */
export async function launchSession(
  channelId: string,
  cwd: string,
  routingConfig: RoutingConfig,
  tmuxClient: TmuxClient,
  readSessionsFn: (path?: string) => SessionsMap,
  writeSessionsFn: (sessions: SessionsMap, path?: string) => void,
  options?: LaunchOptions,
): Promise<boolean> {
  const name = sessionName(cwd)
  const pollTimeout = options?.pollTimeout ?? 60_000

  // Create detached tmux session with the channel's CWD
  await tmuxClient.newSession(name, cwd)
  console.error(`[slack] Session created: ${name} (cwd="${cwd}")`)

  // Send the claude launch command, then Enter to execute it
  const escapedConfigPath = routingConfig.mcp_config_path.replace(/'/g, "'\\''")
  const launchCmd = `claude --mcp-config '${escapedConfigPath}' --dangerously-load-development-channels server:slack-channel-router`
  await tmuxClient.sendKeys(name, launchCmd)
  await tmuxClient.sendKeys(name, 'Enter')
  console.error(`[slack] Claude launch command sent to session: ${name}`)

  // Poll capturePane for the safety prompt with exponential backoff.
  // Start at 500ms, double each iteration, cap at 5s, total limit 60s.
  const POLL_START_MS = 500
  const POLL_CAP_MS = 5_000
  const PROMPT_TEXT = 'I am using this for local development'

  let delay = POLL_START_MS
  const deadline = Date.now() + pollTimeout

  while (Date.now() < deadline) {
    await new Promise<void>((resolve) => setTimeout(resolve, delay))
    delay = Math.min(delay * 2, POLL_CAP_MS)

    let pane: string
    try {
      pane = await tmuxClient.capturePane(name)
    } catch {
      // capturePane failure is terminal — session may have died
      break
    }

    if (pane.includes(PROMPT_TEXT)) {
      // Safety prompt found — acknowledge it and record success
      await tmuxClient.sendKeys(name, 'Enter')
      console.error(`[slack] Safety prompt acknowledged in session: ${name}`)
      const sessions = readSessionsFn()
      sessions[channelId] = { tmuxSession: name, lastLaunch: new Date().toISOString() }
      writeSessionsFn(sessions)
      console.error(`[slack] Session recorded in sessions.json: channel=${channelId}`)
      return true
    }
  }

  // Prompt not found — check if Claude is running anyway (forward-compatible)
  const running = await isClaudeRunning(name, tmuxClient)
  if (running) {
    console.error(`[slack] Safety prompt not found but Claude is running — accepting session: ${name}`)
    const sessions = readSessionsFn()
    sessions[channelId] = { tmuxSession: name, lastLaunch: new Date().toISOString() }
    writeSessionsFn(sessions)
    console.error(`[slack] Session recorded in sessions.json: channel=${channelId}`)
    return true
  }

  console.error(`[slack] Session launch failed — Claude not running in session: ${name}`)
  return false
}

// ---------------------------------------------------------------------------
// startupSessionManager
// ---------------------------------------------------------------------------

/**
 * On server startup, inspects all configured routes and takes action:
 *   - Exists (session found): kills session and relaunches
 *   - Missing: launches fresh
 *
 * Returns early with a warning if tmux is unavailable.
 */
export async function startupSessionManager(
  routingConfig: RoutingConfig,
  tmuxClient: TmuxClient,
  readSessionsFn: (path?: string) => SessionsMap,
  writeSessionsFn: (sessions: SessionsMap, path?: string) => void,
  options?: LaunchOptions,
): Promise<SessionStateResult[]> {
  // Verify tmux is installed before proceeding
  try {
    const version = await tmuxClient.checkAvailability()
    console.error(`[slack] tmux available: ${version}`)
  } catch {
    console.error('[slack] Warning: tmux not available — skipping session startup')
    return []
  }

  const results: SessionStateResult[] = []

  for (const [channelId, route] of Object.entries(routingConfig.routes)) {
    const name = sessionName(route.cwd)

    try {
      const exists = await tmuxClient.hasSession(name)

      if (exists) {
        // Session exists — kill and relaunch regardless of whether Claude is running
        console.error(`[slack] Session exists — killing and relaunching: channel=${channelId} session=${name}`)
        await tmuxClient.killSession(name)
        const ok = await launchSession(
          channelId, route.cwd, routingConfig, tmuxClient,
          readSessionsFn, writeSessionsFn, options,
        )
        results.push({ channelId, action: ok ? 'relaunched' : 'failed', sessionName: name })
      } else {
        // No session — launch fresh
        console.error(`[slack] No session found — launching: channel=${channelId} session=${name}`)
        const ok = await launchSession(
          channelId, route.cwd, routingConfig, tmuxClient,
          readSessionsFn, writeSessionsFn, options,
        )
        results.push({ channelId, action: ok ? 'launched' : 'failed', sessionName: name })
      }
    } catch (err) {
      console.error(`[slack] Session startup error for channel=${channelId}:`, err)
      results.push({ channelId, action: 'failed', sessionName: name })
    }
  }

  const succeeded = results.filter((r) => r.action !== 'failed').length
  const failed = results.filter((r) => r.action === 'failed').length
  console.error(`[slack] Session startup complete: ${succeeded} ok, ${failed} failed`)

  return results
}
