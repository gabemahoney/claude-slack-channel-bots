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

import { readdirSync, readFileSync, accessSync, constants } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { type TmuxClient, sessionName, isClaudeRunning } from './tmux.ts'
import { type SessionsMap } from './sessions.ts'
import { type RoutingConfig, MCP_SERVER_NAME } from './config.ts'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface LaunchOptions {
  /** Maximum time in ms to poll for the safety prompt. Default: 60000. */
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
 * correct MCP config, polls for the safety prompt, and records the session
 * in sessions.json on success.
 *
 * When options.sessionId is provided, appends --resume <id> to the CLI
 * command. If the resume attempt fails, kills the tmux session and retries
 * once with a fresh launch (no --resume).
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

  // Inner helper: sends the launch command and polls for the safety prompt.
  // Returns { ok: true } on success, or { ok: false } when Claude is not
  // running after the poll timeout. Session ID discovery is handled
  // asynchronously by verifySessionIdInBackground after launch succeeds.
  async function attemptLaunch(
    withResumeId: string | undefined,
  ): Promise<{ ok: true } | { ok: false }> {
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
    await tmuxClient.sendKeys(name, launchCmd)
    await tmuxClient.sendKeys(name, 'Enter')
    console.error(`[slack] Claude launch command sent to session: ${name}`)

    const launchStart = Date.now()
    let delay = POLL_START_MS
    const deadline = launchStart + pollTimeout

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
        await tmuxClient.sendKeys(name, 'Enter')
        console.error(`[slack] Safety prompt acknowledged in session: ${name}`)
        return { ok: true }
      }

      if (Date.now() - launchStart > earlyDetectAfterMs) {
        const running = await isClaudeRunning(name, tmuxClient)
        if (running) {
          console.error(`[slack] No safety prompt but Claude is running — accepting session early: ${name}`)
          return { ok: true }
        }
      }
    }

    // Prompt not found — check if Claude is running anyway (forward-compatible)
    const running = await isClaudeRunning(name, tmuxClient)
    if (running) {
      console.error(`[slack] Safety prompt not found but Claude is running — accepting session: ${name}`)
      return { ok: true }
    }

    return { ok: false }
  }

  // Create detached tmux session with the channel's CWD
  await tmuxClient.newSession(name, cwd)
  console.error(`[slack] Session created: ${name} (cwd="${cwd}")`)

  // Attempt launch (with --resume if sessionId provided)
  let result = await attemptLaunch(resumeSessionId)

  // resumeSessionId was provided but launch failed — fall back to a fresh launch
  if (!result.ok && resumeSessionId !== undefined) {
    console.error(`[slack] Resume failed for channel=${channelId} — killing session and retrying with fresh launch`)
    try {
      await tmuxClient.killSession(name)
    } catch {
      // ignore kill errors; proceed with fresh session creation
    }
    await tmuxClient.newSession(name, cwd)
    console.error(`[slack] Session recreated for fresh fallback: ${name} (cwd="${cwd}")`)
    result = await attemptLaunch(undefined)
  }

  if (!result.ok) {
    console.error(`[slack] Session launch failed — Claude not running in session: ${name}`)
    return false
  }

  // Record session immediately — preserve resumeSessionId if available.
  // Background verification will discover/confirm the actual sessionId async.
  const launchTimestamp = Date.now()
  const sessions = readSessionsFn()
  sessions[channelId] = {
    tmuxSession: name,
    lastLaunch: new Date().toISOString(),
    ...(resumeSessionId !== undefined ? { sessionId: resumeSessionId } : {}),
  }
  writeSessionsFn(sessions)
  console.error(`[slack] Session recorded in sessions.json: channel=${channelId} sessionId=${resumeSessionId ?? 'none'} saved=${JSON.stringify(sessions[channelId])}`)

  // Fire background verification to discover (fresh) or confirm/update (resume) the sessionId
  verifySessionIdInBackground(
    channelId, cwd, launchTimestamp, resumeSessionId,
    readSessionsFn, writeSessionsFn,
  ).catch((err) => {
    console.error(`[slack] verifySessionIdInBackground: unexpected error for channel=${channelId}:`, err)
  })

  return true
}

// ---------------------------------------------------------------------------
// Background session ID verification
// ---------------------------------------------------------------------------

/**
 * After a successful launch, polls ~/.claude/sessions/ for up to 2 minutes
 * (exponential backoff: 2s initial, 15s cap) to discover or verify the sessionId.
 *
 * This is the sole mechanism for session ID discovery/confirmation.
 *
 * - Fresh launch (expectedSessionId undefined): discovers the new sessionId and
 *   saves it to sessions.json.
 * - Resume launch (expectedSessionId provided): confirms or updates the sessionId
 *   if a different one is found.
 * - If it times out: logs that discovery/verification failed but any stored ID is preserved.
 *
 * This runs asynchronously and never throws (caller should add .catch() anyway).
 */
export async function verifySessionIdInBackground(
  channelId: string,
  cwd: string,
  launchTimestamp: number,
  expectedSessionId: string | undefined,
  readSessionsFn: (path?: string) => SessionsMap,
  writeSessionsFn: (sessions: SessionsMap, path?: string) => void,
): Promise<void> {
  const sessionsDir = join(homedir(), '.claude', 'sessions')
  const TIMEOUT_MS = 2 * 60 * 1_000 // 2 minutes
  const INITIAL_DELAY_MS = 2_000
  const MAX_DELAY_MS = 15_000
  const deadline = Date.now() + TIMEOUT_MS

  let delay = INITIAL_DELAY_MS
  let attempt = 0

  while (Date.now() < deadline) {
    await new Promise<void>((resolve) => setTimeout(resolve, delay))
    attempt++
    delay = Math.min(delay * 2, MAX_DELAY_MS)

    try {
      const files = readdirSync(sessionsDir)
      for (const file of files) {
        if (!file.endsWith('.json')) continue
        try {
          const raw = readFileSync(join(sessionsDir, file), 'utf-8')
          const entry = JSON.parse(raw)
          if (
            typeof entry === 'object' &&
            entry !== null &&
            entry.cwd === cwd &&
            typeof entry.startedAt === 'number' &&
            entry.startedAt > launchTimestamp &&
            typeof entry.sessionId === 'string' &&
            entry.sessionId.length > 0
          ) {
            const foundId = entry.sessionId as string

            if (expectedSessionId === undefined) {
              // Fresh launch — discovered sessionId for the first time
              console.error(`[slack] verifySessionIdInBackground: discovered sessionId=${foundId} for channel=${channelId} (attempt ${attempt})`)
              const sessions = readSessionsFn()
              const existing = sessions[channelId]
              if (existing) {
                existing.sessionId = foundId
                writeSessionsFn(sessions)
                console.error(`[slack] verifySessionIdInBackground: sessions.json updated for channel=${channelId} with sessionId=${foundId}`)
              }
              return
            } else if (foundId === expectedSessionId) {
              console.error(`[slack] verifySessionIdInBackground: confirmed sessionId=${expectedSessionId} for channel=${channelId} (attempt ${attempt})`)
              return
            } else {
              // Different sessionId found — update sessions.json
              console.error(`[slack] verifySessionIdInBackground: WARNING sessionId mismatch for channel=${channelId} — expected=${expectedSessionId} found=${foundId}, updating sessions.json`)
              const sessions = readSessionsFn()
              const existing = sessions[channelId]
              if (existing) {
                existing.sessionId = foundId
                writeSessionsFn(sessions)
                console.error(`[slack] verifySessionIdInBackground: sessions.json updated for channel=${channelId} with sessionId=${foundId}`)
              }
              return
            }
          }
        } catch {
          // skip unreadable or malformed files
        }
      }
    } catch {
      // sessionsDir not readable — try again next iteration
    }
  }

  console.error(`[slack] verifySessionIdInBackground: timed out after ${TIMEOUT_MS / 1000}s for channel=${channelId} — stored sessionId=${expectedSessionId ?? 'none'} preserved`)
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

      if (storedSessionId) {
        // Branch 2: Resume — launch with stored session ID
        console.error(`[slack] startupSessionManager: branch=resume channel=${channelId} sessionId=${storedSessionId}`)
        console.error(`[slack] Dead/missing process with stored session ID — resuming: channel=${channelId} session=${name} sessionId=${storedSessionId}`)
        const ok = await launchSession(
          channelId, route.cwd, routingConfig, tmuxClient,
          readSessionsFn, writeSessionsFn, { ...options, sessionId: storedSessionId },
        )
        results.push({ channelId, action: ok ? 'resumed' : 'failed', sessionName: name })
      } else {
        // Branch 3: Fresh — launch without session ID
        console.error(`[slack] startupSessionManager: branch=fresh channel=${channelId} sessionId=none`)
        console.error(`[slack] No stored session ID — launching fresh: channel=${channelId} session=${name}`)
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
