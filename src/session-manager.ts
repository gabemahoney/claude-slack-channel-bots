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

import { readFileSync, readdirSync, statSync, accessSync, constants } from 'fs'
import { homedir } from 'node:os'
import { join, basename } from 'node:path'
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
}

export interface SessionStateResult {
  channelId: string
  action: 'reconnected' | 'launched' | 'resumed' | 'failed'
  sessionName: string
}

// ---------------------------------------------------------------------------
// JSONL-based session ID discovery
// ---------------------------------------------------------------------------

/**
 * Computes the Claude project directory slug from a CWD path.
 * Claude Code stores conversation JSONL files under:
 *   ~/.claude/projects/<slug>/*.jsonl
 * where <slug> is the absolute CWD with '/' replaced by '-' and '_' replaced by '-'.
 */
export function projectSlug(cwd: string): string {
  const expanded = cwd.startsWith('~') ? homedir() + cwd.slice(1) : cwd
  return expanded.replace(/\//g, '-').replace(/_/g, '-')
}

/**
 * Scans the JSONL conversation directory for the given CWD and returns the
 * session ID (UUID) from the most recently modified .jsonl file, or null
 * if no files are found or the directory does not exist.
 *
 * This is more reliable than PID-based session file lookup because Claude Code
 * creates new JSONL files with new UUIDs after context window compaction,
 * while the PID-based session file retains the original (stale) UUID.
 */
export function findLatestJsonlSessionId(cwd: string): string | null {
  const slug = projectSlug(cwd)
  const dir = join(homedir(), '.claude', 'projects', slug)

  try {
    const files = readdirSync(dir).filter(f => f.endsWith('.jsonl'))
    if (files.length === 0) return null

    let latest: { name: string; mtime: number } | null = null
    for (const file of files) {
      const filePath = join(dir, file)
      const stat = statSync(filePath)
      if (latest === null || stat.mtimeMs > latest.mtime) {
        latest = { name: file, mtime: stat.mtimeMs }
      }
    }

    if (latest === null) return null
    return basename(latest.name, '.jsonl')
  } catch {
    return null
  }
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
  const launchDeadline = Date.now() + pollTimeout
  const resumeSessionId = options?.sessionId

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

    let delay = POLL_START_MS
    let promptAcknowledged = false

    while (Date.now() < launchDeadline) {
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

      // Fast-fail: "No conversation found" means the resume failed
      if (pane.includes(NO_CONVERSATION_TEXT)) {
        console.error(`[slack] "No conversation found" detected — fast-fail resume for channel=${channelId}`)
        return 'NO_CONVERSATION' as unknown as SessionRecord
      }

      // Try to discover session ID via PID
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
        } catch {
          // Session file not yet written — keep polling
        }
      }
    }

    console.error(`[slack] Timed out waiting for session ID for channel=${channelId}`)
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
 * On server startup, inspects all configured routes concurrently and takes
 * action using a three-branch decision tree per route:
 *   - Reconnect: tmux session exists AND Claude is running → send /mcp reconnect,
 *                discover session ID via PID-based file lookup, return SessionRecord
 *   - Resume: dead or missing process with stored session ID → kill stale session,
 *             relaunch with --resume, return SessionRecord
 *   - Fresh: dead or missing process without stored session ID → kill stale session,
 *            launch fresh, return SessionRecord
 *
 * Accepts stored sessions externally (caller is responsible for reading them).
 * Returns a Map of channelId → SessionRecord for all successfully launched routes.
 * Returns early with a warning if tmux is unavailable.
 */
export async function startupSessionManager(
  routingConfig: RoutingConfig,
  tmuxClient: TmuxClient,
  storedSessions: SessionsMap,
  options?: { pollTimeout?: number; concurrency?: number; startupTimeout?: number },
): Promise<Map<string, SessionRecord>> {
  // Verify tmux is installed before proceeding
  try {
    const version = await tmuxClient.checkAvailability()
    console.error(`[slack] tmux available: ${version}`)
  } catch {
    console.error('[slack] Warning: tmux not available — skipping session startup')
    return new Map()
  }

  console.error(`[slack] startupSessionManager: storedSessions=${JSON.stringify(storedSessions)}`)

  const routeEntries = Object.entries(routingConfig.routes)
  const concurrency = options?.concurrency ?? 3
  const startupTimeout = options?.startupTimeout ?? 60_000

  console.error(`[slack] startupSessionManager: ${routeEntries.length} route(s), concurrency=${concurrency}, per-route timeout=${startupTimeout}ms`)

  const resultMap = new Map<string, SessionRecord>()
  let succeeded = 0
  let failed = 0
  let nextIdx = 0

  // Process a single route: reconnect, resume, or fresh launch
  async function processRoute(channelId: string, route: { cwd: string }): Promise<void> {
    const routeStart = Date.now()
    const name = sessionName(route.cwd)
    const exists = await tmuxClient.hasSession(name)

    if (exists) {
      const running = await isClaudeRunning(name, tmuxClient)

      if (running) {
        // Branch 1: Reconnect — session live, send /mcp reconnect <server-name>
        const reconnectSessionId = storedSessions[channelId]?.sessionId ?? 'none'
        console.error(`[slack] startupSessionManager: branch=reconnect channel=${channelId} sessionId=${reconnectSessionId}`)
        console.error(`[slack] Session live — reconnecting MCP server "${MCP_SERVER_NAME}": channel=${channelId} session=${name}`)
        await tmuxClient.sendKeys(name, `/mcp reconnect ${MCP_SERVER_NAME}`, 'Enter')

        // Discover session ID via JSONL directory scan
        const jsonlId = findLatestJsonlSessionId(route.cwd)
        if (jsonlId) {
          console.error(`[slack] startupSessionManager: reconnect discovered sessionId=${jsonlId} via JSONL scan for channel=${channelId} (${Date.now() - routeStart}ms)`)
          resultMap.set(channelId, {
            tmuxSession: name,
            lastLaunch: new Date().toISOString(),
            sessionId: jsonlId,
          })
          succeeded++
          return
        }

        console.error(`[slack] startupSessionManager: reconnect — no JSONL files found for channel=${channelId}`)
        failed++
        return
      }
    }

    // Branch 2 or 3: Dead or missing process — JSONL scan is the only source of session IDs
    const storedSessionId = findLatestJsonlSessionId(route.cwd)

    if (exists) {
      // Kill stale tmux session before relaunching
      console.error(`[slack] Bare tmux session detected (Claude not running) — will relaunch: channel=${channelId} session=${name}`)
      console.error(`[slack] Stale session found — killing before relaunch: channel=${channelId} session=${name}`)
      await tmuxClient.killSession(name)
    }

    // Each route gets the full startupTimeout as its poll window
    const effectiveTimeout = Math.min(options?.pollTimeout ?? 120_000, startupTimeout)
    const launchOpts = { ...options, pollTimeout: effectiveTimeout }

    if (storedSessionId && storedSessionId !== 'pending') {
      // Branch 2: Resume — launch with stored session ID
      console.error(`[slack] startupSessionManager: branch=resume channel=${channelId} sessionId=${storedSessionId}`)
      console.error(`[slack] Dead/missing process with stored session ID — resuming: channel=${channelId} session=${name} sessionId=${storedSessionId}`)
      const record = await launchSession(
        channelId, route.cwd, routingConfig, tmuxClient,
        { ...launchOpts, sessionId: storedSessionId },
      )
      const elapsed = Date.now() - routeStart
      if (record !== null) {
        console.error(`[slack] startupSessionManager: channel=${channelId} resumed in ${elapsed}ms`)
        resultMap.set(channelId, record)
        succeeded++
      } else {
        console.error(`[slack] startupSessionManager: channel=${channelId} resume failed after ${elapsed}ms`)
        failed++
      }
    } else {
      // Branch 3: Fresh — launch without session ID
      console.error(`[slack] startupSessionManager: branch=fresh channel=${channelId} sessionId=none`)
      console.error(`[slack] No stored session ID — launching fresh: channel=${channelId} session=${name}`)
      const record = await launchSession(
        channelId, route.cwd, routingConfig, tmuxClient,
        launchOpts,
      )
      const elapsed = Date.now() - routeStart
      if (record !== null) {
        console.error(`[slack] startupSessionManager: channel=${channelId} launched fresh in ${elapsed}ms`)
        resultMap.set(channelId, record)
        succeeded++
      } else {
        console.error(`[slack] startupSessionManager: channel=${channelId} fresh launch failed after ${elapsed}ms`)
        failed++
      }
    }
  }

  // Worker pool — each worker grabs the next unprocessed route until done
  async function worker(): Promise<void> {
    while (nextIdx < routeEntries.length) {
      const idx = nextIdx++
      if (idx >= routeEntries.length) break
      const [channelId, route] = routeEntries[idx]
      try {
        await processRoute(channelId, route)
      } catch (err) {
        console.error('[slack] Session startup error:', err)
        failed++
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, routeEntries.length) }, () => worker()),
  )

  console.error(`[slack] Session startup complete: ${succeeded} ok, ${failed} failed`)

  return resultMap
}
