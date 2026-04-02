/**
 * session-manager.ts — Startup orchestration for tmux-managed Claude Code sessions.
 *
 * Handles three cases per route at server startup:
 *   reconnect — tmux session exists AND Claude is running → send /mcp reconnect, do not relaunch
 *   resume    — dead or missing process with stored session ID → kill stale session, relaunch with --resume
 *   fresh     — dead or missing process without stored session ID → kill stale session, launch fresh
 *
 * SPDX-License-Identifier: MIT
 */

import { readFileSync, accessSync, constants } from 'fs'
import { homedir } from 'node:os'
import { type TmuxClient, sessionName, isClaudeRunning, getClaudePid } from './tmux.ts'
import { type SessionsMap, type SessionRecord } from './sessions.ts'
import { type RoutingConfig, MCP_SERVER_NAME } from './config.ts'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface LaunchOptions {
  /** Maximum time in ms to poll for the safety prompt. Default: 120000. */
  pollTimeout?: number
  /** Claude session UUID to resume. When provided, --resume <id> is appended to the CLI command. */
  sessionId?: string
  /**
   * How many ms after launch before checking isClaudeRunning inside the poll loop.
   * Guards against accepting a session too early before Claude has a chance to start.
   * Default: 5000.
   */
  earlyDetectAfterMs?: number
}

export interface SessionStateResult {
  channelId: string
  action: 'reconnected' | 'launched' | 'resumed' | 'failed'
  sessionName: string
}

// ---------------------------------------------------------------------------
// launchSession
// ---------------------------------------------------------------------------

/**
 * Creates a new tmux session for a Slack channel, launches Claude with the
 * correct MCP config, polls for the safety prompt, discovers the Claude
 * session ID via PID-based file lookup, and returns a SessionRecord on success.
 *
 * When options.sessionId is provided, appends --resume <id> to the CLI
 * command. If "No conversation found" is detected, kills the tmux session,
 * recreates it, and retries with a fresh launch. If the poll timeout is
 * reached with Claude running but no session ID discovered, returns null.
 *
 * Returns a SessionRecord on success, null on failure.
 */
export async function launchSession(
  channelId: string,
  cwd: string,
  routingConfig: RoutingConfig,
  tmuxClient: TmuxClient,
  options?: LaunchOptions,
): Promise<SessionRecord | null> {
  const name = sessionName(cwd)
  const pollTimeout = options?.pollTimeout ?? 120_000
  const resumeSessionId = options?.sessionId
  const earlyDetectAfterMs = options?.earlyDetectAfterMs ?? 5_000

  const escapedConfigPath = routingConfig.mcp_config_path.replace(/'/g, "'\\''")
  let baseCmd = `SLACK_CHANNEL_BOT_SESSION=1 claude --mcp-config '${escapedConfigPath}' --dangerously-load-development-channels server:${MCP_SERVER_NAME}`

  if (routingConfig.append_system_prompt_file !== undefined) {
    try {
      accessSync(routingConfig.append_system_prompt_file, constants.R_OK)
      const escapedPromptPath = routingConfig.append_system_prompt_file.replace(/'/g, "'\\''")
      baseCmd += ` --append-system-prompt-file '${escapedPromptPath}'`
    } catch {
      // file missing or unreadable — skip
    }
  }

  const POLL_START_MS = 500
  const POLL_CAP_MS = 5_000
  const PROMPT_TEXT = 'I am using this for local development'
  const NO_CONVERSATION_TEXT = 'No conversation found'

  // Inner helper: sends the launch command and polls for the safety prompt,
  // then continues polling for Claude PID and session file discovery.
  // Returns the discovered SessionRecord on success, or null on failure/timeout.
  async function attemptLaunch(
    withResumeId: string | undefined,
    sessionName_: string,
  ): Promise<SessionRecord | null> {
    const safeResumeId = withResumeId && /^[a-zA-Z0-9_-]+$/.test(withResumeId) ? withResumeId : undefined
    if (withResumeId && !safeResumeId) {
      console.error(`[slack] Invalid session ID format — ignoring resume for channel=${channelId}`)
    }
    const launchCmd = safeResumeId ? `${baseCmd} --resume ${safeResumeId}` : baseCmd
    console.error(`[slack] launchSession: launchCmd=${launchCmd}`)
    if (safeResumeId) {
      console.error(`[slack] Attempting resume launch for channel=${channelId} sessionId=${safeResumeId}`)
    } else {
      console.error(`[slack] Attempting fresh launch for channel=${channelId}`)
    }
    await tmuxClient.sendKeys(sessionName_, launchCmd)
    await tmuxClient.sendKeys(sessionName_, 'Enter')
    console.error(`[slack] Claude launch command sent to session: ${sessionName_}`)

    const launchStart = Date.now()
    let delay = POLL_START_MS
    const deadline = launchStart + pollTimeout
    let promptAcknowledged = false

    while (Date.now() < deadline) {
      await new Promise<void>((resolve) => setTimeout(resolve, delay))
      delay = Math.min(delay * 2, POLL_CAP_MS)

      let pane: string
      try {
        pane = await tmuxClient.capturePane(sessionName_)
      } catch {
        // capturePane failure is terminal — session may have died
        return null
      }

      if (!promptAcknowledged && pane.includes(PROMPT_TEXT)) {
        await tmuxClient.sendKeys(sessionName_, 'Enter')
        console.error(`[slack] Safety prompt acknowledged in session: ${sessionName_}`)
        promptAcknowledged = true
      }

      if (Date.now() - launchStart > earlyDetectAfterMs) {
        // Fast-fail: "No conversation found" means the resume failed
        if (pane.includes(NO_CONVERSATION_TEXT)) {
          console.error(`[slack] "No conversation found" detected — fast-fail resume for channel=${channelId}`)
          return 'NO_CONVERSATION' as unknown as SessionRecord
        }

        const running = await isClaudeRunning(sessionName_, tmuxClient)

        if (!promptAcknowledged && running) {
          console.error(`[slack] No safety prompt but Claude is running — accepted session early: ${sessionName_}`)
          promptAcknowledged = true
        }

        if (promptAcknowledged || running) {
          // Claude is running — try to discover session ID via PID
          const pid = await getClaudePid(sessionName_, tmuxClient)
          if (pid !== null) {
            const sessionFilePath = `${homedir()}/.claude/sessions/${pid}.json`
            try {
              const raw = readFileSync(sessionFilePath, 'utf-8')
              const entry = JSON.parse(raw)
              if (
                typeof entry === 'object' &&
                entry !== null &&
                typeof entry.sessionId === 'string' &&
                entry.sessionId.length > 0
              ) {
                const foundId = entry.sessionId as string
                console.error(`[slack] launchSession: discovered sessionId=${foundId} via PID=${pid} for channel=${channelId}`)
                return {
                  tmuxSession: sessionName_,
                  lastLaunch: new Date().toISOString(),
                  sessionId: foundId,
                }
              }
              // Session file exists but sessionId not yet populated — keep polling
            } catch {
              // Session file not yet written — keep polling
            }
          }
          // PID found or Claude running but no session file yet — keep polling
        } else {
          // Claude is not running after earlyDetectAfterMs — fail
          return null
        }
      }
    }

    // Timeout — check if Claude is still running
    const running = await isClaudeRunning(sessionName_, tmuxClient)
    if (running) {
      console.error(`[slack] Timed out waiting for session ID with Claude running — returning null for channel=${channelId}`)
      return null
    }

    return null
  }

  // Create detached tmux session with the channel's CWD
  await tmuxClient.newSession(name, cwd)
  console.error(`[slack] Session created: ${name} (cwd="${cwd}")`)

  // Attempt launch (with --resume if sessionId provided)
  let result = await attemptLaunch(resumeSessionId, name)

  // "No conversation found" fast-fail on resume — kill, recreate, relaunch fresh
  if (result !== null && (result as unknown as string) === 'NO_CONVERSATION' && resumeSessionId !== undefined) {
    console.error(`[slack] Fast-fail resume for channel=${channelId} — killing session and relaunching fresh`)
    try {
      await tmuxClient.killSession(name)
    } catch {
      // ignore kill errors
    }
    await tmuxClient.newSession(name, cwd)
    console.error(`[slack] Session recreated for fresh fallback: ${name} (cwd="${cwd}")`)
    result = await attemptLaunch(undefined, name)
  }

  // Resume timed out or failed (not NO_CONVERSATION) — fall back to fresh
  if (result === null && resumeSessionId !== undefined) {
    console.error(`[slack] Resume failed for channel=${channelId} — killing session and retrying with fresh launch`)
    try {
      await tmuxClient.killSession(name)
    } catch {
      // ignore kill errors; proceed with fresh session creation
    }
    await tmuxClient.newSession(name, cwd)
    console.error(`[slack] Session recreated for fresh fallback: ${name} (cwd="${cwd}")`)
    result = await attemptLaunch(undefined, name)
  }

  if (result === null || (result as unknown as string) === 'NO_CONVERSATION') {
    console.error(`[slack] Session launch failed — Claude not running or no session ID in session: ${name}`)
    return null
  }

  return result
}

// ---------------------------------------------------------------------------
// startupSessionManager
// ---------------------------------------------------------------------------

/**
 * On server startup, inspects all configured routes and takes action using a
 * three-branch decision tree per route:
 *   - Reconnect: tmux session exists AND Claude is running → send /mcp reconnect, do not relaunch
 *   - Resume: dead or missing process with stored session ID → kill stale session, relaunch with --resume
 *   - Fresh: dead or missing process without stored session ID → kill stale session, launch fresh
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

  // Load stored session IDs for all channels once before the route iteration loop
  const storedSessions = readSessionsFn()
  console.error(`[slack] startupSessionManager: storedSessions=${JSON.stringify(storedSessions)}`)

  for (const [channelId, route] of Object.entries(routingConfig.routes)) {
    const name = sessionName(route.cwd)

    try {
      const exists = await tmuxClient.hasSession(name)

      if (exists) {
        const running = await isClaudeRunning(name, tmuxClient)

        if (running) {
          // Branch 1: Reconnect — session live, send /mcp reconnect <server-name>
          const reconnectSessionId = storedSessions[channelId]?.sessionId ?? 'none'
          console.error(`[slack] startupSessionManager: branch=reconnect channel=${channelId} sessionId=${reconnectSessionId}`)
          console.error(`[slack] Session live — reconnecting MCP server "${MCP_SERVER_NAME}": channel=${channelId} session=${name}`)
          await tmuxClient.sendKeys(name, `/mcp reconnect ${MCP_SERVER_NAME}`)
          await tmuxClient.sendKeys(name, 'Enter')
          results.push({ channelId, action: 'reconnected', sessionName: name })
          continue
        }
      }

      // Branch 2 or 3: Dead or missing process — check for stored session ID
      const storedSessionId = storedSessions[channelId]?.sessionId

      if (exists) {
        // Kill stale tmux session before relaunching
        console.error(`[slack] Stale session found — killing before relaunch: channel=${channelId} session=${name}`)
        await tmuxClient.killSession(name)
      }

      if (storedSessionId && storedSessionId !== 'pending') {
        // Branch 2: Resume — launch with stored session ID
        console.error(`[slack] startupSessionManager: branch=resume channel=${channelId} sessionId=${storedSessionId}`)
        console.error(`[slack] Dead/missing process with stored session ID — resuming: channel=${channelId} session=${name} sessionId=${storedSessionId}`)
        const record = await launchSession(
          channelId, route.cwd, routingConfig, tmuxClient,
          { ...options, sessionId: storedSessionId },
        )
        if (record) {
          const sessions = readSessionsFn()
          sessions[channelId] = record
          writeSessionsFn(sessions)
          console.error(`[slack] Session recorded in sessions.json: channel=${channelId} sessionId=${record.sessionId}`)
        }
        results.push({ channelId, action: record ? 'resumed' : 'failed', sessionName: name })
      } else {
        // Branch 3: Fresh — launch without session ID
        console.error(`[slack] startupSessionManager: branch=fresh channel=${channelId} sessionId=none`)
        console.error(`[slack] No stored session ID — launching fresh: channel=${channelId} session=${name}`)
        const record = await launchSession(
          channelId, route.cwd, routingConfig, tmuxClient,
          options,
        )
        if (record) {
          const sessions = readSessionsFn()
          sessions[channelId] = record
          writeSessionsFn(sessions)
          console.error(`[slack] Session recorded in sessions.json: channel=${channelId} sessionId=${record.sessionId}`)
        }
        results.push({ channelId, action: record ? 'launched' : 'failed', sessionName: name })
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
