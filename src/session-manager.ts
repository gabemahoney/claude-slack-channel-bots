/**
 * session-manager.ts — Library-backed startup orchestration for CSCB.
 *
 * The previous tmux-direct implementation has been replaced with calls to the
 * agent-director TypeScript library `Client` singleton (SR-1). Every spawn
 * carries `relay_mode='on'` and `service=cscb` / `channel=<id>` labels.
 * Per-route reconciliation uses the SR-1.4 collision-then-act dispatch:
 *
 *   1. Try `client.spawn(...)` directly.
 *   2. On `ErrInstanceIdCollision`, call `client.get(...)` and branch on the
 *      observed state (ended/missing → resume or kill+delete+spawn; waiting
 *      → /mcp reconnect via sendKeys; working → wait for waiting then
 *      reconnect; pending/check_permission/ask_user → no-op).
 *   3. Any other error surfaces to the affected Slack channel via
 *      `postSpawnFailureToChannel` and is logged.
 *
 * Orphan reconciliation (SR-1.6) lists every `service=cscb` spawn and
 * kills+deletes any whose `channel` label is missing or not in
 * `routingConfig.routes`.
 *
 * No tmux process-tree walks, no JSONL existence checks for resume eligibility:
 * the library encapsulates both.
 *
 * SPDX-License-Identifier: MIT
 */

import {
  AgentDirectorError,
  ErrInstanceIdCollision,
  ErrJsonlMissing,
  ErrNoSessionId,
  ErrSpawnNotFound,
  ErrSpawnNotResumable,
  ErrTmuxSendKeys,
  ErrTmuxSessionCreate,
} from 'agent-director'
import type { ListRow, SpawnParams, FindMissingResult, GetResult } from 'agent-director'
import type { WebClient } from '@slack/web-api'

import { checkCozempicAvailable, resolveJsonlPath } from './cozempic.ts'
import { type RoutingConfig, MCP_SERVER_NAME, normalizeChannelName } from './config.ts'
import { getClient } from './agent-director-client.ts'
import { withOutageDetection, withSpawnDetection } from './outage-state.ts'
import {
  ErrSystemInstallDisappeared,
  ErrTmuxNotAvailable,
  ErrCwdNotFound,
  ErrCwdNotADirectory,
  ErrSpawnCapReached,
} from './agent-director-errors.ts'
import { recordStartupError } from './startup-errors.ts'
import { isDryRun } from './tokens.ts'
import {
  resolveEffectiveConfigDir,
  makeDefaultArchiveCount,
  rfc3339ToEpochSeconds,
} from './jsonl-persistence-check.ts'
import { statSync } from 'node:fs'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Live states per SR-11 (agent-director Spawn state machine). Terminal states
 * (`ended`, `missing`) and the typed `ErrSpawnNotFound` rejection from
 * `client.status(...)` are treated as dead by callers.
 */
export const AGENT_DIRECTOR_LIVE_STATES: ReadonlySet<string> = new Set([
  'pending',
  'waiting',
  'working',
  'ask_user',
  'check_permission',
])

/** The CSCB-shipped template name (mirrors agent-director-client). */
const TEMPLATE_NAME = 'slack-channel-bot'

/**
 * Build the deterministic claude_instance_id for a channelId.
 *
 * When `normalizedName` is a non-empty string, the id is composed as
 * `cscb_${normalizedName}_${channelId}` for operator glanceability in
 * `agent-director list`. When omitted or empty, falls back to the bare
 * `cscb_${channelId}` form so callers without a resolved name still produce
 * a stable id. The channelId always suffixes — it is the canonical key
 * and survives channel renames.
 */
export function instanceIdFor(channelId: string, normalizedName?: string): string {
  if (normalizedName && normalizedName.length > 0) {
    return `cscb_${normalizedName}_${channelId}`
  }
  return `cscb_${channelId}`
}

/**
 * Build the canonical tmux session name for a channelId.
 *
 * Mirrors `instanceIdFor` composition: with a name, `slack_bot_${name}_${id}`;
 * without, `slack_bot_${id}`. The id suffix keeps sessions unique across
 * channel renames or collisions between channels that normalize identically.
 */
export function tmuxSessionNameFor(channelId: string, normalizedName?: string): string {
  if (normalizedName && normalizedName.length > 0) {
    return `slack_bot_${normalizedName}_${channelId}`
  }
  return `slack_bot_${channelId}`
}

/**
 * Look up the cached normalized channel name on a route. Returns undefined
 * when the route is missing or the name has not been resolved yet.
 */
export function getNormalizedNameForChannel(
  channelId: string,
  routingConfig: RoutingConfig,
): string | undefined {
  return routingConfig.routes[channelId]?.normalizedName
}

// ---------------------------------------------------------------------------
// Spawn-failure queue — Slack-error surface (SR-1.1 channel-post path)
// ---------------------------------------------------------------------------

interface SpawnFailureEntry {
  channelId: string
  error: AgentDirectorError
  remediation: string
}

const spawnFailureQueue: SpawnFailureEntry[] = []

/**
 * Surface a spawn-related failure to the bot's configured Slack channel.
 * Before Socket Mode is up, queue the entry; `flushSpawnFailureQueue` drains
 * the queue once the WebClient is authenticated. Dry-run logs to stderr only.
 */
export function postSpawnFailureToChannel(
  channelId: string,
  error: AgentDirectorError,
  web?: WebClient,
  isStartup = true,
): void {
  const remediation = remediationHint(error)

  if (!web) {
    spawnFailureQueue.push({ channelId, error, remediation })
    return
  }

  if (isDryRun()) {
    console.error(
      `[slack] dry-run: would post spawn failure for channel=${channelId} errName=${error.errName} remediation="${remediation}"`,
    )
    return
  }

  const text =
    `Spawn failure for channel \`${channelId}\`:\n` +
    `  Error: \`${error.errName}\` — ${error.errDescription.slice(0, 300)}\n` +
    `  Remediation: ${remediation}`

  web.chat.postMessage({ channel: channelId, text }).catch((err) => {
    if (isStartup) {
      recordStartupError('spawn-failure-post', `failed to post spawn failure to channel=${channelId}`, err)
    } else {
      console.error(`[slack] spawn-failure-post: failed to post spawn failure to channel=${channelId}`, err)
    }
  })
}

function remediationHint(error: AgentDirectorError): string {
  if (error instanceof ErrInstanceIdCollision) return 'spawn dispatcher bug — please report'
  if (error instanceof ErrSpawnNotFound) return 'transient — restarting the server should resolve'
  if (error instanceof ErrSpawnCapReached) return 'restart the server to retry — automatic restarts are suspended for this channel'
  return 'Check server.log for details.'
}

/** Drain the pre-auth queue once Socket Mode is up. Called from server.ts main(). */
export function flushSpawnFailureQueue(web: WebClient): void {
  while (spawnFailureQueue.length > 0) {
    const entry = spawnFailureQueue.shift()!
    postSpawnFailureToChannel(entry.channelId, entry.error, web)
  }
}

// ---------------------------------------------------------------------------
// reconnectMcp — send `/mcp reconnect <server-name>` via library sendKeys
// ---------------------------------------------------------------------------

/**
 * Ensure a tmux server exists on the default socket. Injectable seam so unit
 * tests can assert the b.rmy self-heal path without spawning real processes.
 * Default impl runs `tmux start-server` best-effort — never throws.
 *
 * b.rmy: after a container restart, /tmp (and thus the tmux socket) is wiped
 * and nothing auto-starts tmux at boot, so every startup reconnect fails with
 * `ErrTmuxSendKeys` ("no server running"). Starting the server before a retry
 * gives the reconnect a chance to succeed instead of failing terminally.
 */
export type TmuxServerEnsurer = () => Promise<void>

const defaultEnsureTmuxServer: TmuxServerEnsurer = async (): Promise<void> => {
  const { spawn } = await import('child_process')
  await new Promise<void>((resolve) => {
    try {
      const child = spawn('tmux', ['start-server'], { stdio: 'ignore' })
      child.on('error', () => resolve()) // tmux missing — best-effort
      child.on('close', () => resolve())
    } catch {
      resolve()
    }
  })
}

let _ensureTmuxServer: TmuxServerEnsurer = defaultEnsureTmuxServer

/** Test-only seam: override the tmux-server ensurer. */
export function _setTmuxServerEnsurer(fn: TmuxServerEnsurer): void {
  _ensureTmuxServer = fn
}

/** Test-only seam: restore the default tmux-server ensurer. */
export function _resetTmuxServerEnsurer(): void {
  _ensureTmuxServer = defaultEnsureTmuxServer
}

/**
 * Probe whether a tmux session with this exact name is alive. Injectable seam
 * so unit tests can drive the b.3ce timeout-liveness verdict without real
 * tmux. Default impl runs `tmux has-session -t =<name>` (the `=` prefix
 * forces exact-name match, not prefix match) and reports exit code 0.
 */
export type TmuxSessionProber = (sessionName: string) => Promise<boolean>

const defaultHasTmuxSession: TmuxSessionProber = async (sessionName: string): Promise<boolean> => {
  const { spawn } = await import('child_process')
  return new Promise<boolean>((resolve) => {
    try {
      const child = spawn('tmux', ['has-session', '-t', `=${sessionName}`], { stdio: 'ignore' })
      child.on('error', () => resolve(false)) // tmux missing — treat as dead
      child.on('close', (code) => resolve(code === 0))
    } catch {
      resolve(false)
    }
  })
}

let _hasTmuxSession: TmuxSessionProber = defaultHasTmuxSession

/** Test-only seam: override the tmux-session liveness prober. */
export function _setTmuxSessionProber(fn: TmuxSessionProber): void {
  _hasTmuxSession = fn
}

/** Test-only seam: restore the default tmux-session liveness prober. */
export function _resetTmuxSessionProber(): void {
  _hasTmuxSession = defaultHasTmuxSession
}

/**
 * Reconnect outcome (b.3ce). `dead-session` means the session is provably
 * unusable — callers should recover via the resume/fresh-spawn path rather than
 * report a bare failure. Two classes of proof qualify:
 *   - the claude PROCESS is provably gone per AD's evidence-based
 *     findMissing + status verdict (waitForWaitingAndReconnect's ended/missing
 *     branch and its timeout branch; b.ecw), or
 *   - the tmux SESSION provably doesn't exist (the ErrSpawnNotFound paths where
 *     AD has no row to consult, and reconnectMcp's double-ErrTmuxSendKeys).
 */
export type ReconnectOutcome = 'ok' | 'failed' | 'dead-session'

/**
 * Send `/mcp reconnect <MCP_SERVER_NAME>` to the spawn's pane. Library's
 * sendKeys appends Enter automatically per its contract.
 *
 * b.rmy self-heal: on `ErrTmuxSendKeys` (no tmux server / session — the
 * post-reboot field failure), ensure a tmux server exists and retry the
 * send-keys ONCE.
 *
 * b.3ce: if the retry ALSO fails with `ErrTmuxSendKeys`, the session is gone
 * for good (post-reboot /tmp wipe) — no amount of send-keys can revive it.
 * Return 'dead-session' so spawnForRoute can fall through to resume/fresh-spawn.
 */
export async function reconnectMcp(
  channelId: string,
  web?: WebClient,
  routingConfig?: RoutingConfig,
): Promise<ReconnectOutcome> {
  const claude_instance_id = instanceIdFor(channelId, routingConfig?.routes[channelId]?.normalizedName)
  console.error(`[slack] reconnecting MCP server "${MCP_SERVER_NAME}": channel=${channelId}`)
  const sendReconnect = (): Promise<unknown> =>
    withOutageDetection(channelId, undefined, (client) => client.sendKeys({
      claude_instance_id,
      text: `/mcp reconnect ${MCP_SERVER_NAME}`,
    }))
  try {
    await sendReconnect()
    return 'ok'
  } catch (err) {
    if (err instanceof ErrSystemInstallDisappeared || err instanceof ErrTmuxNotAvailable) return 'failed'
    if (err instanceof ErrTmuxSendKeys) {
      console.error(
        `[slack] reconnectMcp: ErrTmuxSendKeys for channel=${channelId} — ensuring tmux server exists and retrying send-keys once`,
      )
      await _ensureTmuxServer()
      try {
        await sendReconnect()
        console.error(`[slack] reconnectMcp: retry succeeded after ErrTmuxSendKeys for channel=${channelId}`)
        return 'ok'
      } catch (err2) {
        if (err2 instanceof ErrSystemInstallDisappeared || err2 instanceof ErrTmuxNotAvailable) return 'failed'
        const e2 = err2 instanceof AgentDirectorError ? err2 : new AgentDirectorError('send-keys', 'UnknownError', String(err2))
        console.error(`[slack] reconnectMcp: retry after ErrTmuxSendKeys failed for channel=${channelId}: ${e2.errName}`)
        if (err2 instanceof ErrTmuxSendKeys) {
          // b.3ce: the session is provably gone — signal the caller to recover
          // via resume/fresh-spawn instead of posting a terminal failure.
          return 'dead-session'
        }
        postSpawnFailureToChannel(channelId, e2, web)
        return 'failed'
      }
    }
    const e = err instanceof AgentDirectorError ? err : new AgentDirectorError('send-keys', 'UnknownError', String(err))
    console.error(`[slack] reconnectMcp: send-keys failed for channel=${channelId}: ${e.errName}`)
    postSpawnFailureToChannel(channelId, e, web)
    return 'failed'
  }
}

// ---------------------------------------------------------------------------
// approvePreSessionDialogs — auto-approve pre-SessionStart dialogs on spawn
// ---------------------------------------------------------------------------

/**
 * Verified against Claude Code 2.1.120 (2026-05-27). If this stops matching,
 * the dev-channels dialog has drifted — see b.yy6. Match the option label
 * (semantic, stable) rather than the header (cosmetic, drifts).
 */
export const DEV_CHANNELS_DIALOG_NEEDLE = 'I am using this for local development'

/**
 * Verified against Claude Code 2.1.120 (2026-06-02). If this stops matching,
 * the folder-trust dialog has drifted — see b.k54 / b.uhv. Match the option
 * label (semantic, stable) rather than the header (cosmetic, drifts).
 */
export const TRUST_DIALOG_NEEDLE = 'Yes, I trust this folder'

/** Default poll interval while watching for pre-session dialogs. */
export const DIALOG_POLL_INTERVAL_MS = 500

let _dialogPollIntervalMs = DIALOG_POLL_INTERVAL_MS

/** Test-only seam: override the dialog poll interval. */
export function _setDialogPollIntervalMs(ms: number): void {
  _dialogPollIntervalMs = ms
}

/** Test-only seam: restore the default poll interval. */
export function _resetDialogPollIntervalMs(): void {
  _dialogPollIntervalMs = DIALOG_POLL_INTERVAL_MS
}

/** Hard cap: how long to wait for a fresh spawn to leave `pending` (reach a
 *  live SessionStart state) while auto-dismissing pre-session dialogs. */
export const DIALOG_READY_TIMEOUT_MS = 5 * 60_000

let _dialogReadyTimeoutMs = DIALOG_READY_TIMEOUT_MS

/** Test-only seam: override the ready cap. */
export function _setDialogReadyTimeoutMs(ms: number): void {
  _dialogReadyTimeoutMs = ms
}

/** Test-only seam: restore the default ready cap. */
export function _resetDialogReadyTimeoutMs(): void {
  _dialogReadyTimeoutMs = DIALOG_READY_TIMEOUT_MS
}

// ---------------------------------------------------------------------------
// Raw-tmux dialog fallback (b.vub) — bypass agent-director when the row is in
// a non-interactive state (missing/ended) but the pane still shows the dialog.
// ---------------------------------------------------------------------------

/**
 * b.vub — the critical mechanism the ticket's manual mitigation used.
 *
 * On the RESUME lap, `client.resume` re-creates the tmux session but the AD row
 * stays `missing`/`ended` until SessionStart re-fires — and SessionStart can't
 * fire because the dev-channels dialog blocks it. Crucially, agent-director's
 * `read-pane` / `send-keys` REFUSE to touch a `missing`/`ended` row
 * (`ErrSpawnNotInteractive`, even with allow_pending), so the approver cannot
 * clear the dialog through AD. A raw `tmux capture-pane` + `tmux send-keys …
 * Enter` DOES clear it (verified against real AD/tmux; this is exactly the
 * `tmux send-keys -t <session> Enter` the operator ran by hand in the ticket),
 * after which AD flips to `waiting`.
 *
 * These two seams shell out to tmux directly, keyed on the deterministic
 * per-channel session name. Injectable so unit tests stay hermetic.
 */
export type TmuxPaneReader = (sessionName: string) => Promise<string>
export type TmuxEnterSender = (sessionName: string) => Promise<void>

function defaultTmuxCapturePane(sessionName: string): Promise<string> {
  return (async () => {
    const { spawn } = await import('child_process')
    return await new Promise<string>((resolve) => {
      try {
        const child = spawn('tmux', ['capture-pane', '-p', '-t', sessionName])
        let out = ''
        child.stdout?.on('data', (d: Buffer) => { out += d.toString('utf8') })
        child.on('error', () => resolve(''))
        child.on('close', () => resolve(out))
      } catch {
        resolve('')
      }
    })
  })()
}

function defaultTmuxSendEnter(sessionName: string): Promise<void> {
  return (async () => {
    const { spawn } = await import('child_process')
    await new Promise<void>((resolve) => {
      try {
        const child = spawn('tmux', ['send-keys', '-t', sessionName, 'Enter'], { stdio: 'ignore' })
        child.on('error', () => resolve())
        child.on('close', () => resolve())
      } catch {
        resolve()
      }
    })
  })()
}

let _tmuxCapturePane: TmuxPaneReader = defaultTmuxCapturePane
let _tmuxSendEnter: TmuxEnterSender = defaultTmuxSendEnter

/** Test-only seam: override the raw tmux pane reader. */
export function _setTmuxCapturePane(fn: TmuxPaneReader): void {
  _tmuxCapturePane = fn
}
/** Test-only seam: override the raw tmux Enter sender. */
export function _setTmuxSendEnter(fn: TmuxEnterSender): void {
  _tmuxSendEnter = fn
}
/** Test-only seam: restore the default raw tmux helpers. */
export function _resetTmuxDialogHelpers(): void {
  _tmuxCapturePane = defaultTmuxCapturePane
  _tmuxSendEnter = defaultTmuxSendEnter
}

/** Live (post-SessionStart) states: the dialog is gone, the session is ready. */
const DIALOG_READY_STATES = new Set(['waiting', 'working', 'ask_user', 'check_permission'])
/** Terminal states: the spawn died before becoming ready. */
const DIALOG_DEAD_STATES = new Set(['ended', 'missing'])
/** Every pre-SessionStart dialog we can auto-approve (option 1 pre-selected; Enter accepts). */
const PRE_SESSION_DIALOG_NEEDLES = [TRUST_DIALOG_NEEDLE, DEV_CHANNELS_DIALOG_NEEDLE]

/**
 * b.vub: consecutive dead-state-with-no-needle polls required before treating a
 * spawn as genuinely dead. A freshly resumed (or freshly spawned) row is
 * legitimately `missing`/`ended` for a brief window: after `client.resume`, the
 * tmux pane needs a moment to render the dev-channels dialog, and AD keeps
 * reporting the prior terminal state until SessionStart re-fires. Bailing on the
 * FIRST such poll (as the pre-b.vub code did) races the dialog and re-hangs the
 * resume. Requiring a short grace streak lets the dialog appear (needle → Enter,
 * which resets the streak) while still fast-failing a truly dead spawn without
 * waiting the full 5-minute cap. Reset to 0 on any live state or needle sighting.
 */
export const DIALOG_DEAD_GRACE_POLLS = 20

let _dialogDeadGracePolls = DIALOG_DEAD_GRACE_POLLS

/** Test-only seam: override the dead-state grace streak. */
export function _setDialogDeadGracePolls(n: number): void {
  _dialogDeadGracePolls = n
}

/** Test-only seam: restore the default dead-state grace streak. */
export function _resetDialogDeadGracePolls(): void {
  _dialogDeadGracePolls = DIALOG_DEAD_GRACE_POLLS
}

/**
 * Drive a freshly-spawned bot past its pre-SessionStart dialogs (folder-trust
 * and/or dev-channels) by watching agent-director's state machine: while the
 * spawn is `pending` (SessionStart not yet fired — a dialog may be blocking),
 * poll the pane and press Enter whenever a known dialog needle is on screen.
 * Exit the instant AD reports a live state (the dialog is gone). 5-minute hard
 * cap; failure to reach ready is surfaced loudly — never a silent early quit.
 *
 * status/readPane/sendKeys are wrapped in withOutageDetection so AD-outage
 * flags keep working (b.en2). readPane/sendKeys use allow_pending:true because
 * the bot is `pending` here (b.98w). The needle-gate guarantees Enter is sent
 * ONLY when a dialog is actually displayed, so we never inject a stray Enter
 * into a live prompt. Uses the composed instance id (b.ben).
 *
 * Replaces the former two-function pair (trust-folder + dev-channels approvers):
 * one loop from spawn+0 (no wasted 30s trust window) that self-heals a missed
 * Enter (state stays pending, needle reappears, next iteration presses again)
 * and never gives up silently at 30s.
 *
 * b.vub: pane-first / state-tolerant, with a RAW-TMUX fallback for dead rows.
 * A *resumed* bot faces the same `--dangerously-load-development-channels`
 * dialog, but its AD row is `missing`/`ended` from the prior life while it sits
 * blocked at the dialog (SessionStart never re-fires). Two compounding facts the
 * pre-b.vub code missed: (1) it early-returned on DIALOG_DEAD_STATES before ever
 * reading the pane; (2) even if it had tried, agent-director's read-pane/
 * send-keys REFUSE a `missing`/`ended` row (ErrSpawnNotInteractive), so the
 * dialog can only be cleared by talking to tmux directly. Fix: within the
 * pre-SessionStart window, for a dead row read+Enter via raw tmux (keyed on the
 * deterministic session name), for a pending row via AD; press Enter whenever a
 * needle is visible regardless of AD state; treat missing/ended as terminal only
 * after a short no-needle grace streak (DIALOG_DEAD_GRACE_POLLS), tolerating the
 * brief post-resume window before the dialog renders. Still needle-gated (no
 * stray Enter into a live session) and bounded by the hard cap.
 */
export async function approvePreSessionDialogs(
  channelId: string,
  web: WebClient | undefined,
  isStartup: boolean,
  normalizedName?: string,
): Promise<void> {
  const claude_instance_id = instanceIdFor(channelId, normalizedName)
  const deadline = Date.now() + _dialogReadyTimeoutMs
  let deadStreak = 0

  while (Date.now() < deadline) {
    // 1) Readiness oracle.
    let state: string
    try {
      const r = await withOutageDetection(channelId, undefined, (client) => client.status({ claude_instance_id }))
      state = r.state
    } catch (err) {
      if (err instanceof ErrSpawnNotFound) {
        console.error(`[slack] approvePreSessionDialogs: spawn not found for channel=${channelId} — aborting`)
        return
      }
      // Transient (incl. AD-outage errors already flagged by withOutageDetection) — keep polling.
      console.error(`[slack] approvePreSessionDialogs: status error channel=${channelId}: ${String(err)}`)
      await new Promise((r) => setTimeout(r, _dialogPollIntervalMs))
      continue
    }
    if (DIALOG_READY_STATES.has(state)) return // dialog cleared, session live

    // 2) Pane-first (b.vub): read the pane and dismiss any visible pre-session
    // dialog BEFORE deciding whether a dead state is terminal.
    //
    // Two paths, because agent-director's read-pane/send-keys REFUSE a
    // `missing`/`ended` row (ErrSpawnNotInteractive) even with allow_pending:
    //   - Fresh spawn (state=pending): drive via AD read-pane/send-keys.
    //   - Resumed row (state=missing/ended): AD won't touch the pane, but the
    //     dialog IS on screen and blocking SessionStart. Fall back to RAW tmux
    //     (capture-pane + send-keys Enter) keyed on the deterministic session
    //     name — exactly the `tmux send-keys -t <session> Enter` the operator
    //     ran by hand in the ticket. Once Enter lands, SessionStart fires and
    //     AD flips to a live state on the next poll.
    let needleVisible = false
    if (DIALOG_DEAD_STATES.has(state)) {
      // Raw-tmux fallback (agent-director cannot interact with a dead row).
      const sessionName = tmuxSessionNameFor(channelId, normalizedName)
      try {
        const pane = await _tmuxCapturePane(sessionName)
        needleVisible = PRE_SESSION_DIALOG_NEEDLES.some((n) => pane.includes(n))
        if (needleVisible) {
          await _tmuxSendEnter(sessionName)
        }
      } catch (err) {
        console.error(`[slack] approvePreSessionDialogs: raw-tmux fallback error channel=${channelId}: ${String(err)}`)
      }
    } else {
      // Interactive (pending) — drive via agent-director.
      try {
        const { pane } = await withOutageDetection(channelId, undefined, (client) => client.readPane({ claude_instance_id, n_lines: 40, allow_pending: true }))
        needleVisible = PRE_SESSION_DIALOG_NEEDLES.some((n) => pane.includes(n))
        if (needleVisible) {
          await withOutageDetection(channelId, undefined, (client) => client.sendKeys({ claude_instance_id, text: '', allow_pending: true })) // Enter
        }
      } catch (err) {
        console.error(`[slack] approvePreSessionDialogs: readPane/sendKeys error channel=${channelId}: ${String(err)}`)
      }
    }

    // 3) Dead-state handling (b.vub). A needle means "dialog-blocked, not dead":
    // reset the streak and keep pressing Enter. Only treat missing/ended as
    // terminal after it persists with NO needle for DIALOG_DEAD_GRACE_POLLS
    // consecutive polls — this tolerates the brief post-spawn/post-resume window
    // where the row is still terminal and the pane hasn't rendered the dialog
    // yet, without racing the dialog and re-hanging the resume.
    if (needleVisible) {
      deadStreak = 0
    } else if (DIALOG_DEAD_STATES.has(state)) {
      deadStreak += 1
      if (deadStreak >= _dialogDeadGracePolls) {
        const msg = `spawn reached ${state} before clearing dev-channels dialog for channel=${channelId} (no needle for ${deadStreak} polls)`
        console.error(`[slack] approvePreSessionDialogs: ${msg}`)
        if (isStartup) recordStartupError('dev-channels-approve-spawn-died', msg)
        return
      }
    } else {
      // pending (or any other non-dead, non-ready state) — reset the streak.
      deadStreak = 0
    }

    await new Promise((r) => setTimeout(r, _dialogPollIntervalMs))
  }

  // 3) Hard cap hit — genuine failure, surfaced loudly (no silent give-up).
  const msg = `spawn never reached a live state within ${_dialogReadyTimeoutMs}ms for channel=${channelId} — dialog unrecognized or session hung (dev-needle='${DEV_CHANNELS_DIALOG_NEEDLE}')`
  console.error(`[slack] approvePreSessionDialogs: ${msg}`)
  if (isStartup) recordStartupError('dev-channels-approve-not-ready', msg)
  postSpawnFailureToChannel(channelId, new AgentDirectorError('status', 'DialogApprovalTimeout', msg), web, isStartup)
}

// ---------------------------------------------------------------------------
// waitForWaitingAndReconnect — used when a colliding spawn is in `working`
// ---------------------------------------------------------------------------

/** Hard cap on the wait-for-waiting poller (10 minutes). Test-only override below. */
export const WAIT_FOR_WAITING_TIMEOUT_MS = 10 * 60 * 1000

let _waitForWaitingTimeoutMs = WAIT_FOR_WAITING_TIMEOUT_MS

/** Test-only seam: override the wait-for-waiting timeout. */
export function _setWaitForWaitingTimeoutMs(ms: number): void {
  _waitForWaitingTimeoutMs = ms
}

/** Test-only seam: restore the default. */
export function _resetWaitForWaitingTimeoutMs(): void {
  _waitForWaitingTimeoutMs = WAIT_FOR_WAITING_TIMEOUT_MS
}

// ---------------------------------------------------------------------------
// reconcileMissingSweep — shared, load-shedding findMissing sweep
// ---------------------------------------------------------------------------

/**
 * TTL for the findMissing memo window (b.m4r). AD's `findMissing({})` is a
 * whole-store, per-row evidence-based sweep; it is idempotent, so two sweeps
 * fired within a few seconds of each other return the same verdicts. On a
 * fleet restart, startupSessionManager (concurrency=3) resolves collisions
 * across N channels near-simultaneously, and every `working`-row collision —
 * plus each dead-path `reconcileMissingFirst` — would otherwise fire its own
 * whole-store sweep (N sweeps, up to 3 concurrent). Single-flight collapses
 * concurrent callers onto one in-flight promise; the TTL then lets callers
 * arriving just after it resolves reuse that result instead of re-sweeping.
 *
 * 10s is chosen to comfortably cover one startup reconcile wave (the whole
 * concurrency=3 wave over the fleet completes well inside this window) and to
 * collapse a same-tick escalate-dead burst: when N channels escalate together
 * (b.nk5 fleet shape — /tmp wiped, every channel dead-tmux at once), those
 * `sweepDeadTmuxChannel` callers deliberately land INSIDE the window and share
 * the single in-flight/memoized sweep — one findMissing reconciles the whole
 * store for all of them. Across ticks the 10s TTL is far shorter than the
 * ~120s health-check cadence, so the following tick's escalate-dead sweeps
 * always fall outside the window and re-sweep: a memoized-stale answer costs at
 * most ONE extra tick. Recovery behavior is unchanged, only redundant load is
 * shed (see the `_buildReconnectSessionAdapter` call-site note in src/server.ts
 * and docs/architecture.md's b.m4r sweep note).
 */
const FIND_MISSING_MEMO_TTL_MS = 10 * 1000

let _findMissingMemoTtlMs = FIND_MISSING_MEMO_TTL_MS

/** In-flight single-flight promise, shared by concurrent callers. */
let _findMissingInFlight: Promise<FindMissingResult> | null = null
/** Last successful sweep result and the time it resolved (for TTL reuse). */
let _findMissingLast: { result: FindMissingResult; at: number } | null = null

/**
 * Test-only seam (mirrors `_setWaitForWaitingTimeoutMs`): override the memo TTL.
 */
export function _setFindMissingMemoTtlMs(ms: number): void {
  _findMissingMemoTtlMs = ms
}

/**
 * Test-only seam: clear all memo state (in-flight promise, cached result) and
 * restore the default TTL. Tests that count findMissing calls must call this in
 * their setup/teardown to stay deterministic.
 */
export function _resetFindMissingMemo(): void {
  _findMissingInFlight = null
  _findMissingLast = null
  _findMissingMemoTtlMs = FIND_MISSING_MEMO_TTL_MS
}

/**
 * Run AD's per-row, evidence-based `findMissing({})` sweep once, shedding
 * redundant load (b.m4r). The sweep is idempotent, so this is purely a
 * load-shedding optimization over calling `client.findMissing({})` directly:
 *
 * - Single-flight: concurrent callers share one in-flight sweep promise.
 * - Short-TTL memo: a caller arriving within `_findMissingMemoTtlMs` of the
 *   last successful sweep reuses that result instead of re-sweeping.
 *
 * Failures are NOT memoized — on error the next caller retries. Error handling
 * mirrors the previous inline call sites: log once and let the caller proceed
 * with today's behavior (fall through to the poll loop / attempt resume anyway).
 *
 * @param channelId only used for log context — the sweep itself is whole-store.
 * @param logPrefix distinguishes the two call sites in the log line.
 */
async function reconcileMissingSweep(channelId: string, logPrefix: string): Promise<void> {
  // Memo hit: a recent successful sweep is still within the TTL. Reuse it.
  if (_findMissingLast && Date.now() - _findMissingLast.at < _findMissingMemoTtlMs) {
    return
  }

  // Single-flight: an in-flight sweep exists — await it rather than starting one.
  if (!_findMissingInFlight) {
    _findMissingInFlight = withOutageDetection(channelId, undefined, (client) => client.findMissing({}))
  }
  const inFlight = _findMissingInFlight

  try {
    const r = await inFlight
    // Only the caller that started this sweep records the result/log (others
    // await the same promise but must not double-log or re-stamp the memo).
    if (_findMissingInFlight === inFlight) {
      _findMissingLast = { result: r, at: Date.now() }
      _findMissingInFlight = null
      console.error(`[slack] ${logPrefix}: findMissing sweep for channel=${channelId} — count=${r.count} ids=[${r.ids.join(',')}] unverified=${r.unverified} unverified_ids=[${r.unverified_ids.join(',')}]`)
    }
  } catch (err) {
    // Do NOT memoize failures — clear the in-flight slot so the next caller
    // retries. Log and let the caller proceed with today's behavior.
    if (_findMissingInFlight === inFlight) {
      _findMissingInFlight = null
    }
    const e = err instanceof AgentDirectorError ? err : new AgentDirectorError('findMissing', 'UnknownError', String(err))
    console.error(`[slack] ${logPrefix}: findMissing sweep failed for channel=${channelId}: ${e.errName} — proceeding`)
  }
}

/**
 * b.sv7 / Epic t1.tkk.e4: the escalate-dead → internal-sweep entry point, and
 * the single reusable place for it (b.4vj will add a second retry driver that
 * hits dead-tmux and must share this exact logic — do NOT inline the sweep at
 * another call site).
 *
 * When the tick/restart path decides a channel's tmux session is provably dead
 * while its AD row still looks alive ('dead-session' → 'escalate-dead'), CSCB
 * recovers itself instead of silently waiting on the external
 * `~/startup/find-missing-loop.sh`: emit an operator-visible log line, then run
 * the existing memoized `reconcileMissingSweep` (b.m4r). The sweep reconciles
 * the frozen `working` row to `missing`, so the NEXT health-check tick observes
 * `alive === false` and takes the normal kill+relaunch branch. The external
 * loop remains belt-and-braces; removing it is a separate operator decision.
 *
 * The log line is emitted UNCONDITIONALLY here — before/outside the memoized
 * helper — because a memo hit returns silently and a sweep failure logs only
 * the generic failure line; an operator must see that recovery was triggered on
 * every escalate-dead verdict. `reconcileMissingSweep` stays module-private; this
 * wrapper is the only export.
 *
 * Never throws: `reconcileMissingSweep` already logs and swallows its own
 * failures (and does not memoize them, so the next tick retries), so the caller
 * can await this and return its verdict unchanged regardless of sweep outcome.
 *
 * @param channelId the dead-tmux channel to reconcile (log context; the sweep
 *   itself is whole-store, so one in-flight sweep serves the fleet — b.nk5).
 * @param verdict the verdict/context fragment for the log line (e.g. 'dead-session').
 */
export async function sweepDeadTmuxChannel(channelId: string, verdict: string): Promise<void> {
  console.error(
    `[slack] escalate-dead: channel=${channelId} verdict=${verdict} — tmux session provably dead, triggering internal findMissing reconciliation (next tick relaunches; ~/startup/find-missing-loop.sh is belt-and-braces)`,
  )
  await reconcileMissingSweep(channelId, 'escalate-dead')
}

/**
 * b.ecw: the timeout-branch tmux-probe fallback. When the timeout status call
 * throws and AD therefore has nothing to say, key on the tmux SESSION (the only
 * object left) so an AD outage can't manufacture a false 'dead-session' — the
 * b.rmy invariant. `reason` is the log fragment describing why we fell back
 * (e.g. `spawn not found`, `status error ${errName}`): alive → 'ok', gone →
 * 'dead-session'.
 */
async function tmuxFallbackVerdict(
  sessionName: string,
  channelId: string,
  reason: string,
): Promise<ReconnectOutcome> {
  if (await _hasTmuxSession(sessionName)) {
    console.error(
      `[slack] waitForWaitingAndReconnect: timed out for channel=${channelId} after ${_waitForWaitingTimeoutMs}ms — ${reason}, tmux session alive, health-check will reconnect it (b.9a7): during an AD outage the adapter reports alive=false and the tick restarts it; once AD recovers with the row live, the tick sees alive && !connected -> scheduleRestart -> reconnect`,
    )
    return 'ok'
  }
  console.error(
    `[slack] waitForWaitingAndReconnect: timed out for channel=${channelId} after ${_waitForWaitingTimeoutMs}ms — ${reason} and tmux session "${sessionName}" is gone — dead session`,
  )
  return 'dead-session'
}

/**
 * Poll `status({claude_instance_id})` until the spawn transitions to
 * `waiting`, then call reconnectMcp. Transitions to live transient states
 * (ask_user, check_permission, pending) return 'ok'; recovery is then the
 * health-check tick's job — post-b.9a7 the tick observes the row as
 * alive && !connected and routes it through scheduleRestart -> reconnect.
 *
 * b.ecw — which object each terminal branch keys on. AD probes the claude
 * PROCESS; CSCB's `_hasTmuxSession` probes the TMUX SESSION. A lingering tmux
 * shell with a dead claude process would flip the two verdicts, so the choice
 * is made per branch (requires AD ≥ 0.8.0 / b.93m Part E — degraded-mode guard
 * removed, findMissing verdicts per-row and evidence-based):
 *   - ended/missing branch: keys on the claude process. `ended` means
 *     SessionEnd fired (process exited); `missing` after the up-front sweep is
 *     an evidence-based verdict that the process is provably gone. Returns
 *     'dead-session' directly — no tmux probe. A dead process in a live tmux
 *     shell is a dead bot; the resume/fresh-spawn path's b.vub self-heal reaps
 *     the orphan tmux session.
 *   - timeout branch: keys on the claude process via a FRESH findMissing sweep
 *     (the 10s memo has long expired at the 10-minute deadline) + one status
 *     call. A process mid-long-turn stays 'ok' (the b.rmy/b.3ce long-turn
 *     guard, now keyed on the process); only a provably-gone process returns
 *     'dead-session'. On ErrSpawnNotFound or any other status error it falls
 *     back to the raw tmux probe so an AD outage can't manufacture a false
 *     'dead-session' (b.rmy invariant).
 *   - ErrSpawnNotFound branch: keys on the TMUX SESSION by design — no AD row
 *     exists, so there is nothing to reconcile or consult (b.c3o).
 */
export async function waitForWaitingAndReconnect(
  channelId: string,
  routingConfig: RoutingConfig,
  web?: WebClient,
): Promise<ReconnectOutcome> {
  const claude_instance_id = instanceIdFor(channelId, routingConfig.routes[channelId]?.normalizedName)
  const sessionName = tmuxSessionNameFor(channelId, routingConfig.routes[channelId]?.normalizedName)
  const pollIntervalMs = routingConfig.agent_director_poll_interval_ms
  const deadline = Date.now() + _waitForWaitingTimeoutMs

  // b.m4r: a bot killed mid-turn never fires SessionEnd, so its AD row freezes
  // at `working`. Without a reconcile, the poll below spins on `status` for the
  // full 10-minute window before the timeout branch's sweep + status finally
  // decides — the channel stays down that whole time. Run AD's per-row,
  // evidence-based findMissing sweep ONCE up front (agent-director plan b.93m,
  // t1.93m.hp: degraded-mode guard removed, shipped ≥ 0.8.0). A genuinely-dead
  // row reconciles to `missing`, so the FIRST status poll below hits the
  // ended/missing branch and returns 'dead-session' directly in seconds (b.ecw:
  // process-keyed, no tmux probe); a genuinely-alive long-turn row is untouched
  // by the evidence-based sweep and keeps today's polling behavior (b.rmy
  // long-turn guard preserved). Prefer
  // AD's findMissing verb over a CSCB-side tmux reconcile per
  // docs/engineering-guide.md ("Avoiding Duplicated Effort"), mirroring
  // resumeOrFreshSpawn's reconcileMissingFirst branch. On any findMissing
  // error, log and fall through to the existing poll loop (today's behavior).
  await reconcileMissingSweep(channelId, 'waitForWaitingAndReconnect')

  while (Date.now() < deadline) {
    let state: string
    try {
      const r = await withOutageDetection(channelId, undefined, (client) => client.status({ claude_instance_id }))
      state = r.state
    } catch (err) {
      if (err instanceof ErrSpawnNotFound) {
        // b.c3o: spawn-not-found means the AD row is gone — same class as
        // `missing`. Only the tmux session's actual existence decides the
        // verdict, mirroring the timeout branch's own ErrSpawnNotFound
        // sub-branch below.
        if (await _hasTmuxSession(sessionName)) {
          console.error(`[slack] waitForWaitingAndReconnect: spawn not found for channel=${channelId} but tmux session alive — aborting poll (health-check will handle)`)
          return 'ok'
        }
        console.error(`[slack] waitForWaitingAndReconnect: spawn not found for channel=${channelId} and tmux session "${sessionName}" is gone — dead session`)
        return 'dead-session'
      }
      if (err instanceof ErrSystemInstallDisappeared || err instanceof ErrTmuxNotAvailable) {
        return 'failed'
      }
      const e = err instanceof AgentDirectorError ? err : new AgentDirectorError('status', 'UnknownError', String(err))
      console.error(`[slack] waitForWaitingAndReconnect: status error for channel=${channelId}: ${e.errName}`)
      postSpawnFailureToChannel(channelId, e, web)
      return 'failed'
    }

    if (state === 'waiting') {
      return reconnectMcp(channelId, web, routingConfig)
    }

    if (state === 'working') {
      await new Promise<void>((resolve) => setTimeout(resolve, pollIntervalMs))
      continue
    }

    // b.ecw: post-b.93m (AD ≥ 0.8.0) this branch keys on the claude PROCESS,
    // not the tmux session. `ended` means SessionEnd fired (the process
    // exited); `missing` — after the up-front reconcileMissingSweep — is an
    // evidence-based verdict that the process was probed and is provably gone.
    // Either way the bot is dead, so return 'dead-session' directly with no
    // tmux probe. A dead claude process in a lingering tmux shell is still a
    // dead bot; routing it to resumeOrFreshSpawn lets b.vub's
    // selfHealTmuxCollisionAndRespawn reap the orphan tmux session on
    // ErrTmuxSessionCreate. (The old tmux-alive → 'ok' behavior deferred a dead
    // channel to the health-check for minutes.) Live transient states
    // (ask_user, check_permission, pending) still fall through to 'ok' below.
    if (state === 'ended' || state === 'missing') {
      console.error(`[slack] waitForWaitingAndReconnect: channel=${channelId} transitioned to state=${state} (claude process gone) — dead session`)
      return 'dead-session'
    }

    console.error(`[slack] waitForWaitingAndReconnect: channel=${channelId} transitioned to state=${state} — aborting; health-check reconnects it (tick sees alive && !connected -> scheduleRestart -> reconnect, b.9a7)`)
    return 'ok'
  }

  // b.ecw: timed out — key on the claude PROCESS via AD, not the raw tmux
  // session. The up-front sweep's 10s memo has long expired at the 10-minute
  // deadline, so run a FRESH reconcileMissingSweep (a real whole-store
  // findMissing) to reconcile a row frozen at `working`, then one status call.
  // - ended/missing → the process is provably gone → 'dead-session'.
  // - any live state (working/waiting/ask_user/check_permission/pending) → a
  //   process merely mid-long-turn stays 'ok' (b.rmy/b.3ce long-turn guard,
  //   now keyed on the process rather than the tmux session).
  // - ErrSpawnNotFound → the AD row is gone and AD has nothing to say, so fall
  //   back to the tmux session (the only object left to key on), exactly like
  //   the poll loop's ErrSpawnNotFound branch: alive → 'ok', gone →
  //   'dead-session'.
  // - any other status error → fall back to the raw tmux probe (today's
  //   verdict) so an AD outage can't manufacture a false 'dead-session' — the
  //   b.rmy invariant that only a provably-gone session may go 'dead-session'.
  await reconcileMissingSweep(channelId, 'waitForWaitingAndReconnect: timeout')
  let timeoutState: string
  try {
    const r = await withOutageDetection(channelId, undefined, (client) => client.status({ claude_instance_id }))
    timeoutState = r.state
  } catch (err) {
    if (err instanceof ErrSpawnNotFound) {
      return tmuxFallbackVerdict(sessionName, channelId, 'spawn not found')
    }
    // Any other status error — including ErrSystemInstallDisappeared /
    // ErrTmuxNotAvailable, which the poll loop returns 'failed' for. At the
    // timeout deadline a probe-based verdict is deliberately preferred: it's
    // safe (probe-alive → 'ok' preserves the b.rmy invariant that only a
    // provably-gone session goes 'dead-session') and simpler than propagating
    // 'failed' through here.
    const e = err instanceof AgentDirectorError ? err : new AgentDirectorError('status', 'UnknownError', String(err))
    return tmuxFallbackVerdict(sessionName, channelId, `status error ${e.errName}`)
  }

  if (timeoutState === 'ended' || timeoutState === 'missing') {
    console.error(
      `[slack] waitForWaitingAndReconnect: timed out for channel=${channelId} after ${_waitForWaitingTimeoutMs}ms — claude process state=${timeoutState} (gone) — dead session`,
    )
    return 'dead-session'
  }
  console.error(
    `[slack] reconnect: gave up waiting for channel=${channelId} after ${_waitForWaitingTimeoutMs}ms — claude process state=${timeoutState} (alive), health-check will reconnect (tick sees alive && !connected -> scheduleRestart -> reconnect, b.9a7)`,
  )
  return 'ok'
}

// ---------------------------------------------------------------------------
// spawnForRoute — SR-1.4 collision-then-act dispatcher
// ---------------------------------------------------------------------------

export interface SpawnRouteResult {
  channelId: string
  action:
    | 'spawned'
    | 'resumed'
    | 'reconnected'
    | 'no-op'
    | 'failed'
    | 'fresh-after-amnesia'
    | 'fresh-after-inconclusive-amnesia'
}

/**
 * Build SpawnParams for a route (SR-1.1). Per-route claude_config_dir wins.
 *
 * extra_env unconditionally carries CSCB_CRONTABLE_PATH (the resolved,
 * tilde-expanded, absolute cron_table_path from the config) so bots can
 * locate the self-documenting crontable from the env var alone — no config
 * file lookup needed (D-Q2, b.grx decision 3).
 */
function buildSpawnParams(
  channelId: string,
  route: { cwd: string },
  routingConfig: RoutingConfig,
): SpawnParams {
  const effectiveConfigDir =
    routingConfig.routes[channelId]?.claude_config_dir ?? routingConfig.claude_config_dir
  const normalizedName = routingConfig.routes[channelId]?.normalizedName
  const params: SpawnParams = {
    template: TEMPLATE_NAME,
    cwd: route.cwd,
    claude_instance_id: instanceIdFor(channelId, normalizedName),
    relay_mode: 'on',
    tmux_session_name: tmuxSessionNameFor(channelId, normalizedName),
    label: ['service=cscb', `channel=${channelId}`],
  }
  params.extra_env = {
    ...(effectiveConfigDir ? { CLAUDE_CONFIG_DIR: effectiveConfigDir } : {}),
    CLAUDE_MANAGED_CHANNEL: channelId,
    CSCB_CRONTABLE_PATH: routingConfig.cron_table_path,
  }
  return params
}

/** Best-effort kill — never throws. */
async function tryKill(channelId: string, normalizedName: string | undefined): Promise<void> {
  try {
    await withOutageDetection(channelId, undefined, (client) => client.kill({ claude_instance_id: instanceIdFor(channelId, normalizedName) }))
  } catch {
    /* ignore */
  }
}

// ---------------------------------------------------------------------------
// Orphan-tmux self-heal (b.vub)
// ---------------------------------------------------------------------------

/**
 * Kill a tmux session by its exact name. Injectable seam so unit tests can
 * assert the self-heal path without spawning real processes. Default impl
 * runs `tmux kill-session -t <name>` best-effort.
 *
 * b.vub: the field failure is an orphan tmux session that survives the AD row
 * going `missing` — the AD `client.kill` verb does NOT reap it (observed across
 * dozens of restart cycles). Killing the session directly by its deterministic,
 * per-channel name (`tmuxSessionNameFor`) is the only reliable reap, and the
 * name can only ever belong to this channel's spawn, so it is safe.
 */
export type TmuxSessionKiller = (sessionName: string) => Promise<void>

let _killTmuxSession: TmuxSessionKiller = async (sessionName: string): Promise<void> => {
  const { spawn } = await import('child_process')
  await new Promise<void>((resolve) => {
    try {
      const child = spawn('tmux', ['kill-session', '-t', sessionName], { stdio: 'ignore' })
      child.on('error', () => resolve()) // tmux missing / session absent — best-effort
      child.on('close', () => resolve())
    } catch {
      resolve()
    }
  })
}

/** Test-only seam: override the tmux-session killer. */
export function _setTmuxSessionKiller(fn: TmuxSessionKiller): void {
  _killTmuxSession = fn
}

/** Test-only seam: restore the default tmux-session killer. */
export function _resetTmuxSessionKiller(): void {
  _killTmuxSession = async (sessionName: string): Promise<void> => {
    const { spawn } = await import('child_process')
    await new Promise<void>((resolve) => {
      try {
        const child = spawn('tmux', ['kill-session', '-t', sessionName], { stdio: 'ignore' })
        child.on('error', () => resolve())
        child.on('close', () => resolve())
      } catch {
        resolve()
      }
    })
  }
}

/**
 * Self-heal an `ErrTmuxSessionCreate` collision (b.vub): the deterministic tmux
 * session name is still held by an orphaned session while the AD row is
 * terminal/gone, so a fresh spawn/resume cannot create the session. Kill the
 * orphan by name, then retry `client.spawn` ONCE. Returns the spawn result on
 * success, or rethrows the retry's error (caller surfaces it).
 */
async function selfHealTmuxCollisionAndRespawn(
  channelId: string,
  route: { cwd: string },
  params: SpawnParams,
  normalizedName: string | undefined,
): Promise<{ claude_instance_id: string }> {
  const sessionName = tmuxSessionNameFor(channelId, normalizedName)
  console.error(
    `[slack] spawnForRoute: ErrTmuxSessionCreate for channel=${channelId} — killing orphan tmux session "${sessionName}" and retrying spawn once`,
  )
  await _killTmuxSession(sessionName)
  return withSpawnDetection(channelId, route.cwd, (client) => client.spawn(params))
}

/** Delete the spawn row; surface failures. Returns whether the delete succeeded. */
async function tryDelete(
  channelId: string,
  normalizedName: string | undefined,
  web: WebClient | undefined,
  isStartup: boolean,
): Promise<boolean> {
  try {
    await withOutageDetection(channelId, undefined, (client) => client.delete({ claude_instance_id: [instanceIdFor(channelId, normalizedName)] }))
    return true
  } catch (err) {
    if (err instanceof ErrSystemInstallDisappeared || err instanceof ErrTmuxNotAvailable) {
      return false
    }
    const e = err instanceof AgentDirectorError ? err : new AgentDirectorError('delete', 'UnknownError', String(err))
    console.error(`[slack] tryDelete: failed for channel=${channelId}: ${e.errName}`)
    if (isStartup) recordStartupError('spawn-failed', `delete failed for channel=${channelId}: ${e.errName}`, e)
    postSpawnFailureToChannel(channelId, e, web, isStartup)
    return false
  }
}

// ---------------------------------------------------------------------------
// ErrJsonlMissing diagnostic (bug b.wrb)
// ---------------------------------------------------------------------------

/** One transcript candidate resume tried (or that we recomputed locally). */
interface JsonlCandidate {
  /** Provenance as reported by AD ('persisted' | 'fallback'), or 'locally-computed'
   *  when we reconstructed it ourselves because AD's message lacked detail. */
  source: string
  path: string
  /** The stat error AD reported, or our own local stat result label. */
  note: string
}

/**
 * Best-effort parse of an ErrJsonlMissing description into the candidate list
 * AD enumerates as `<source> <path> (<stat error>)`, joined by "; ".
 *
 * Returns [] when the description does not carry the enumerated detail — which
 * is the case for the installed agent-director 0.8.0 (whose ErrJsonlMissing
 * message predates AD bug b.1ba). Callers MUST treat [] as "AD gave no path
 * detail" and degrade to locally-computed candidates, never as "no paths".
 *
 * Strictly non-throwing and version-agnostic: it keys off the literal `persisted`
 * / `fallback` source tokens, not any version string.
 */
function parseJsonlMissingCandidates(description: string): JsonlCandidate[] {
  if (!description) return []
  const out: JsonlCandidate[] = []
  // AD renders each attempt as: `<source> <path> (<stat error>)`.
  // Anchor on the known source tokens so unrelated prose is ignored.
  const re = /(persisted|fallback)\s+(\S+)\s+\(([^)]*)\)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(description)) !== null) {
    out.push({ source: m[1], path: m[2], note: m[3] })
  }
  return out
}

/** Local stat label: what WE see at a path right now (never claims AD tried it). */
function localStatNote(path: string): string {
  try {
    const st = statSync(path)
    if (st.isFile() && st.size > 0) return `locally present, ${st.size} bytes`
    if (st.isFile()) return 'locally present but empty'
    return 'locally present but not a regular file'
  } catch (err) {
    const code = (err as { code?: string })?.code
    return code ? `locally absent (${code})` : 'locally absent'
  }
}

/**
 * b.wrb: make an ErrJsonlMissing resume failure LEGIBLE without changing the
 * delete+fresh recovery policy. Fetches the doomed AD row (before delete),
 * logs which transcript path(s) were tried and their provenance, and classifies
 * the loss as never-created (expected, lossless) vs lost (real context
 * destroyed → operator-visible).
 *
 * MUST be called BEFORE tryDelete so the row's jsonl_path / session id / cwd /
 * started_at are still available. Never throws.
 *
 * @returns 'lost' when the row had provable prior activity but no transcript
 *          survives (loud), 'never-created' when the archive was consulted and
 *          proved idle-since-spawn (quiet, evidence-based lossless), or
 *          'inconclusive' when we could not gather enough evidence to decide
 *          either way (loud-but-uncertain — the diagnosis machinery itself is
 *          degraded, which correlates with the storage faults that cause loss).
 */
async function diagnoseJsonlMissing(
  channelId: string,
  routingConfig: RoutingConfig,
  normalizedName: string | undefined,
  err: ErrJsonlMissing,
  web: WebClient | undefined,
  isStartup: boolean,
): Promise<'lost' | 'never-created' | 'inconclusive'> {
  // --- 1. What paths did AD try, and from where? -------------------------
  // err.errDescription is AD's detail string. In the future rich format (AD
  // b.1ba) it enumerates `<source> <path> (<err>)`; in installed 0.8.0 it does
  // not. Parse defensively — [] means "no AD detail", not "no paths".
  const adCandidates = parseJsonlMissingCandidates(err.errDescription ?? '')

  // --- 2. Fetch the row we are about to delete (best-effort). -------------
  const claudeInstanceId = instanceIdFor(channelId, normalizedName)
  let row: GetResult | undefined
  try {
    row = await withOutageDetection(channelId, undefined, (client) =>
      client.get({ claude_instance_id: claudeInstanceId }),
    )
  } catch (getErr) {
    // (a) Row already gone / AD unreachable — cannot enrich or classify.
    // Inconclusive: we could not consult the row at all, so we do NOT know
    // whether history was lost. Report it as uncertainty, not reassurance.
    const adDetail = adCandidates.length
      ? adCandidates.map((c) => `${c.source} ${c.path} (${c.note})`).join('; ')
      : err.errDescription || '(no path detail from agent-director)'
    reportInconclusiveDiagnosis(
      channelId,
      claudeInstanceId,
      `could not fetch the agent-director row (${String(getErr)}); AD reported: ${adDetail}`,
      web,
      isStartup,
      err,
    )
    return 'inconclusive'
  }

  // --- 3. Assemble the candidate list to log. ----------------------------
  const effectiveConfigDir = resolveEffectiveConfigDir(routingConfig, channelId)
  const candidates: JsonlCandidate[] = [...adCandidates]

  if (adCandidates.length === 0) {
    // 0.8.0 path: AD gave no enumerated detail. Reconstruct what WE can, clearly
    // labelled as locally computed — never claim it is what AD tried.
    if (row.jsonl_path) {
      candidates.push({
        source: 'locally-computed(persisted-column)',
        path: row.jsonl_path,
        note: localStatNote(row.jsonl_path),
      })
    }
    if (row.claude_session_id) {
      const fallback = resolveJsonlPath(row.cwd, row.claude_session_id, effectiveConfigDir)
      if (fallback !== row.jsonl_path) {
        candidates.push({
          source: 'locally-computed(config-dir fallback)',
          path: fallback,
          note: localStatNote(fallback),
        })
      }
    }
  }

  const candidateStr =
    candidates.length > 0
      ? candidates.map((c) => `${c.source} ${c.path} (${c.note})`).join('; ')
      : '(no transcript path could be determined)'
  const detailProvenance =
    adCandidates.length > 0
      ? 'paths+sources reported by agent-director'
      : 'agent-director gave no path detail (0.8.0); paths below are locally computed'

  // --- 4. Classify never-created vs lost via message-archive evidence. ----
  // Reuse b.zak's archive-count helper (message_archive_db, read-only, absent
  // file → null == no evidence). started_at bounds "since spawn".
  const startedAtEpoch = row.started_at ? rfc3339ToEpochSeconds(row.started_at) : null
  const archiveCount = makeDefaultArchiveCount(routingConfig)
  const archivedSinceSpawn =
    startedAtEpoch === null ? null : archiveCount(channelId, startedAtEpoch)

  if (archivedSinceSpawn !== null && archivedSinceSpawn > 0) {
    // LOST: conversation provably happened since spawn, yet no transcript
    // survives. Real context destroyed — must be operator-visible.
    const detail =
      `channel=${channelId} instance=${claudeInstanceId}: resume threw ErrJsonlMissing and the row will be ` +
      `deleted + fresh-spawned, but the message archive holds ${archivedSinceSpawn} message(s) since spawn ` +
      `(started_at=${row.started_at}). Conversation history was LOST. Transcript candidates tried ` +
      `(${detailProvenance}): ${candidateStr}.`
    console.error(`[slack] ErrJsonlMissing diagnostic: ${detail}`)
    // Operator-visible signal — reuse the existing startup-errors mechanism.
    if (isStartup) recordStartupError('jsonl-transcript-lost-on-resume', detail, err)
    // And a channel post so it is not buried in logs.
    if (web !== undefined) {
      web.chat
        .postMessage({
          channel: channelId,
          text:
            `⚠️ CSCB: on restart my conversation transcript could not be found, but the message archive shows ` +
            `${archivedSinceSpawn} message(s) since I started — my memory of this channel has been lost and I ` +
            `was started fresh. An operator should investigate transcript storage. Paths tried: ${candidateStr}`,
        })
        .catch((postErr: unknown) => {
          console.error(
            `[slack] ErrJsonlMissing diagnostic: failed to post lost-transcript notice to channel=${channelId}:`,
            postErr,
          )
        })
    }
    return 'lost'
  }

  // Below archivedSinceSpawn is 0 or null. Only 0 (archive consulted, no
  // activity since spawn) is evidence-based never-created. null means we never
  // got a usable count — that is INCONCLUSIVE, not reassurance.
  if (archivedSinceSpawn === 0) {
    // NEVER-CREATED (evidence-based): the archive was consulted and proved zero
    // archived activity since spawn. Claude writes the .jsonl lazily on first
    // message; an idle-since-spawn channel simply never had one. Expected and
    // lossless — quiet log, no error, no channel post, counted as an ordinary
    // fresh-spawn.
    console.error(
      `[slack] ErrJsonlMissing diagnostic: channel=${channelId} instance=${claudeInstanceId} — transcript never ` +
        `created (archive consulted: 0 archived messages since spawn). Nothing to lose; resume will fresh-spawn. ` +
        `Transcript candidates tried (${detailProvenance}): ${candidateStr}.`,
    )
    return 'never-created'
  }

  // INCONCLUSIVE: we could not gather enough evidence to decide loss vs
  // never-created. Determine WHY — the operator needs the actionable cause.
  //   (b) started_at absent/unparseable → could not bound "since spawn".
  //   (c-config) no message_archive_db configured → diagnosis is structurally
  //              impossible; actionable "turn on the archive" hint.
  //   (c-other) archive configured but file-missing / unreadable / query threw.
  let reason: string
  if (startedAtEpoch === null) {
    reason =
      `the row's started_at is absent or unparseable (started_at=${row.started_at ?? '(none)'}), ` +
      `so "since spawn" could not be bounded and the archive was not consulted`
  } else if (!routingConfig.message_archive_db) {
    reason =
      `no message archive is configured (message_archive_db unset), so there is no evidence source to ` +
      `consult — enable the message archive to make transcript-loss diagnosis possible`
  } else {
    reason =
      `the message archive (${routingConfig.message_archive_db}) could not be consulted (missing file, ` +
      `unreadable, or the count query failed) — see prior archive-count error line`
  }
  reportInconclusiveDiagnosis(
    channelId,
    claudeInstanceId,
    `${reason}. Transcript candidates tried (${detailProvenance}): ${candidateStr}`,
    web,
    isStartup,
    err,
  )
  return 'inconclusive'
}

/**
 * b.fwu: emit the operator-visible signal for an INCONCLUSIVE ErrJsonlMissing
 * diagnosis — one where we could not determine whether prior history was lost.
 * Follows the 'lost' branch's pattern (recordStartupError guarded by isStartup
 * + a channel post), but worded as UNCERTAINTY, not loss: a false "your history
 * was destroyed" is its own harm. Never throws.
 */
function reportInconclusiveDiagnosis(
  channelId: string,
  claudeInstanceId: string,
  reason: string,
  web: WebClient | undefined,
  isStartup: boolean,
  err: ErrJsonlMissing,
): void {
  const detail =
    `channel=${channelId} instance=${claudeInstanceId}: resume threw ErrJsonlMissing and the row will be ` +
    `deleted + fresh-spawned, but diagnosis was INCONCLUSIVE — could not determine whether conversation ` +
    `history was lost because ${reason}.`
  console.error(`[slack] ErrJsonlMissing diagnostic: ${detail}`)
  if (isStartup) recordStartupError('jsonl-diagnosis-inconclusive', detail, err)
  if (web !== undefined) {
    web.chat
      .postMessage({
        channel: channelId,
        text:
          `⚠️ CSCB: on restart this channel was restarted fresh; I could not determine whether my prior ` +
          `conversation history was preserved (diagnosis inconclusive: ${reason}). An operator should ` +
          `investigate.`,
      })
      .catch((postErr: unknown) => {
        console.error(
          `[slack] ErrJsonlMissing diagnostic: failed to post inconclusive-diagnosis notice to channel=${channelId}:`,
          postErr,
        )
      })
  }
}

/**
 * Recover a collided spawn whose live session cannot be reached: resume-first
 * (preserves session history) when resume_enabled, with the established
 * fallbacks (ErrTmuxSessionCreate → orphan-kill + respawn; ErrNoSessionId /
 * ErrJsonlMissing → delete + fresh; ErrSpawnNotResumable → kill + delete +
 * fresh; ErrSpawnNotFound → fresh, no delete since the row is already gone).
 * This is the `ended`/`missing` state handling, extracted so the
 * b.3ce dead-session fallback in the `waiting`/`working` branches reuses the
 * exact same decision logic instead of inventing its own.
 */
async function resumeOrFreshSpawn(
  channelId: string,
  route: { cwd: string },
  params: SpawnParams,
  routingConfig: RoutingConfig,
  normalizedName: string | undefined,
  web: WebClient | undefined,
  isStartup: boolean,
  opts?: { reconcileMissingFirst?: boolean },
): Promise<SpawnRouteResult> {
  if (routingConfig.resume_enabled === false) {
    console.error(`[slack] spawnForRoute: resume_enabled=false — kill+delete+fresh for channel=${channelId}`)
    await tryKill(channelId, normalizedName)
    if (!(await tryDelete(channelId, normalizedName, web, isStartup))) return { channelId, action: 'failed' }
    try {
      await withSpawnDetection(channelId, route.cwd, (client) => client.spawn(params))
      console.error(`[slack] spawnForRoute: fresh-spawned (after kill+delete) for channel=${channelId}`)
      await approvePreSessionDialogs(channelId, web, isStartup, normalizedName)
      return { channelId, action: 'spawned' }
    } catch (err) {
      if (
        err instanceof ErrSystemInstallDisappeared ||
        err instanceof ErrTmuxNotAvailable ||
        err instanceof ErrCwdNotFound ||
        err instanceof ErrCwdNotADirectory
      ) {
        return { channelId, action: 'failed' }
      }
      const e = err instanceof AgentDirectorError ? err : new AgentDirectorError('spawn', 'UnknownError', String(err))
      console.error(`[slack] spawnForRoute: fresh spawn after delete failed for channel=${channelId}: ${e.errName}`)
      if (isStartup) recordStartupError('spawn-failed', `fresh spawn after delete failed for channel=${channelId}: ${e.errName}`, e)
      postSpawnFailureToChannel(channelId, e, web, isStartup)
      return { channelId, action: 'failed' }
    }
  }

  // b.4dk: dead-session callers (state=waiting/working with a verified-dead
  // tmux session) arrive with a LIVE-state AD row. AD's resume verb requires
  // a terminal row (ended/missing) — otherwise ErrSpawnNotResumable. Run
  // findMissing first so AD's per-row, evidence-based sweep (agent-director
  // plan b.93m, t1.93m.hp: degraded-mode guard removed) transitions the dead
  // row to `missing`, letting resume succeed and preserve session history.
  // The ended/missing caller does NOT set reconcileMissingFirst (row already
  // terminal). On any findMissing error, fall through to attempting resume
  // anyway — resume was never going to succeed on a still-live row, so the
  // existing ErrSpawnNotResumable → kill+delete+fresh branch is the correct
  // (today's) fallback. Prefer AD's findMissing verb over CSCB-side tmux
  // probing per docs/engineering-guide.md ("Avoiding Duplicated Effort").
  if (opts?.reconcileMissingFirst) {
    await reconcileMissingSweep(channelId, 'spawnForRoute: before resume')
  }

  // resume_enabled: attempt resume
  console.error(`[slack] spawnForRoute: attempting resume for channel=${channelId}`)
  try {
    await withSpawnDetection(channelId, route.cwd, (client) => client.resume({ claude_instance_id: instanceIdFor(channelId, normalizedName) }))
    console.error(`[slack] spawnForRoute: resumed channel=${channelId}`)
    // b.vub: a resumed bot faces the same --dangerously-load-development-channels
    // dialog. Its AD row is still `missing`/`ended` while blocked at the dialog
    // (SessionStart hasn't re-fired), so the pane-first approver drives it past.
    await approvePreSessionDialogs(channelId, web, isStartup, normalizedName)
    return { channelId, action: 'resumed' }
  } catch (err) {
    if (err instanceof ErrTmuxSessionCreate) {
      // b.vub: the deterministic tmux session name is still held by an orphan
      // session while the AD row is terminal — resume cannot re-create it.
      // This is the observed field failure (resume throws ErrTmuxSessionCreate
      // every ~2 min). Self-heal: kill the orphan by name, retry spawn once.
      try {
        const r = await selfHealTmuxCollisionAndRespawn(channelId, route, params, normalizedName)
        console.error(`[slack] spawnForRoute: self-heal spawn succeeded after ErrTmuxSessionCreate for channel=${channelId} instanceId=${r.claude_instance_id}`)
        await approvePreSessionDialogs(channelId, web, isStartup, normalizedName)
        return { channelId, action: 'spawned' }
      } catch (err2) {
        if (
          err2 instanceof ErrSystemInstallDisappeared ||
          err2 instanceof ErrTmuxNotAvailable ||
          err2 instanceof ErrCwdNotFound ||
          err2 instanceof ErrCwdNotADirectory
        ) {
          return { channelId, action: 'failed' }
        }
        const e = err2 instanceof AgentDirectorError ? err2 : new AgentDirectorError('spawn', 'UnknownError', String(err2))
        console.error(`[slack] spawnForRoute: self-heal spawn after ErrTmuxSessionCreate failed for channel=${channelId}: ${e.errName}`)
        if (isStartup) recordStartupError('spawn-failed', `self-heal spawn after ErrTmuxSessionCreate failed for channel=${channelId}: ${e.errName}`, e)
        postSpawnFailureToChannel(channelId, e, web, isStartup)
        return { channelId, action: 'failed' }
      }
    }
    if (err instanceof ErrNoSessionId || err instanceof ErrJsonlMissing) {
      console.error(`[slack] spawnForRoute: ${err.errName} on resume for channel=${channelId} — delete+fresh`)
      // b.wrb: diagnose the missing transcript BEFORE deleting the row (its
      // jsonl_path / session id / started_at are needed). Logging/classification
      // only — the delete+fresh POLICY below is unchanged. The 'lost' case is
      // made operator-visible inside diagnoseJsonlMissing itself.
      let jsonlDiagnosis: 'lost' | 'never-created' | 'inconclusive' | undefined
      if (err instanceof ErrJsonlMissing) {
        jsonlDiagnosis = await diagnoseJsonlMissing(
          channelId,
          routingConfig,
          normalizedName,
          err,
          web,
          isStartup,
        )
      }
      if (!(await tryDelete(channelId, normalizedName, web, isStartup))) return { channelId, action: 'failed' }
      try {
        await withSpawnDetection(channelId, route.cwd, (client) => client.spawn(params))
        console.error(`[slack] spawnForRoute: fresh-spawned (after delete) for channel=${channelId}`)
        await approvePreSessionDialogs(channelId, web, isStartup, normalizedName)
        // A fresh-spawn that replaced a resume because the transcript was gone
        // is amnesia, not a clean spawn — surface it as its own action so the
        // startup summary does not count it as an ordinary "ok". b.fwu: split
        // the amnesia into two actions by diagnosis. 'lost' and 'never-created'
        // are DIAGNOSED amnesia (we know whether history was destroyed —
        // 'lost' was already made loud above, 'never-created' is evidence-based
        // lossless). 'inconclusive' is UNDIAGNOSABLE amnesia: we could not tell
        // whether we destroyed anything, which is itself operator-worthy and
        // must not be lumped with the known-cause cases.
        if (err instanceof ErrJsonlMissing) {
          return {
            channelId,
            action:
              jsonlDiagnosis === 'inconclusive'
                ? 'fresh-after-inconclusive-amnesia'
                : 'fresh-after-amnesia',
          }
        }
        return { channelId, action: 'spawned' }
      } catch (err2) {
        if (
          err2 instanceof ErrSystemInstallDisappeared ||
          err2 instanceof ErrTmuxNotAvailable ||
          err2 instanceof ErrCwdNotFound ||
          err2 instanceof ErrCwdNotADirectory
        ) {
          return { channelId, action: 'failed' }
        }
        const e = err2 instanceof AgentDirectorError ? err2 : new AgentDirectorError('spawn', 'UnknownError', String(err2))
        console.error(`[slack] spawnForRoute: fresh spawn after delete failed for channel=${channelId}: ${e.errName}`)
        if (isStartup) recordStartupError('spawn-failed', `fresh spawn after delete failed for channel=${channelId}: ${e.errName}`, e)
        postSpawnFailureToChannel(channelId, e, web, isStartup)
        return { channelId, action: 'failed' }
      }
    }
    if (err instanceof ErrSpawnNotResumable) {
      // Row is non-terminal but resume rejected — defensive: kill + delete + spawn
      console.error(`[slack] spawnForRoute: ErrSpawnNotResumable for channel=${channelId} — kill+delete+fresh`)
      await tryKill(channelId, normalizedName)
      if (!(await tryDelete(channelId, normalizedName, web, isStartup))) return { channelId, action: 'failed' }
      try {
        await withSpawnDetection(channelId, route.cwd, (client) => client.spawn(params))
        await approvePreSessionDialogs(channelId, web, isStartup, normalizedName)
        return { channelId, action: 'spawned' }
      } catch (err2) {
        if (
          err2 instanceof ErrSystemInstallDisappeared ||
          err2 instanceof ErrTmuxNotAvailable ||
          err2 instanceof ErrCwdNotFound ||
          err2 instanceof ErrCwdNotADirectory
        ) {
          return { channelId, action: 'failed' }
        }
        const e = err2 instanceof AgentDirectorError ? err2 : new AgentDirectorError('spawn', 'UnknownError', String(err2))
        if (isStartup) recordStartupError('spawn-failed', `fresh spawn failed for channel=${channelId}: ${e.errName}`, e)
        postSpawnFailureToChannel(channelId, e, web, isStartup)
        return { channelId, action: 'failed' }
      }
    }
    if (err instanceof ErrSpawnNotFound) {
      // Row vanished between the dead-session verdict and resume (operator
      // delete, expire, race) — fresh-spawn directly, no delete: the row is
      // already gone and a delete of a missing row would throw and turn
      // recovery into action: 'failed'. Mirrors the caller-level retry below.
      console.error(`[slack] spawnForRoute: ErrSpawnNotFound on resume for channel=${channelId} — fresh-spawn`)
      try {
        await withSpawnDetection(channelId, route.cwd, (client) => client.spawn(params))
        console.error(`[slack] spawnForRoute: fresh-spawned (after ErrSpawnNotFound on resume) for channel=${channelId}`)
        await approvePreSessionDialogs(channelId, web, isStartup, normalizedName)
        return { channelId, action: 'spawned' }
      } catch (err2) {
        if (
          err2 instanceof ErrSystemInstallDisappeared ||
          err2 instanceof ErrTmuxNotAvailable ||
          err2 instanceof ErrCwdNotFound ||
          err2 instanceof ErrCwdNotADirectory
        ) {
          return { channelId, action: 'failed' }
        }
        const e = err2 instanceof AgentDirectorError ? err2 : new AgentDirectorError('spawn', 'UnknownError', String(err2))
        console.error(`[slack] spawnForRoute: fresh spawn after ErrSpawnNotFound on resume failed for channel=${channelId}: ${e.errName}`)
        if (isStartup) recordStartupError('spawn-failed', `fresh spawn after ErrSpawnNotFound on resume failed for channel=${channelId}: ${e.errName}`, e)
        postSpawnFailureToChannel(channelId, e, web, isStartup)
        return { channelId, action: 'failed' }
      }
    }
    if (
      err instanceof ErrSystemInstallDisappeared ||
      err instanceof ErrTmuxNotAvailable ||
      err instanceof ErrCwdNotFound ||
      err instanceof ErrCwdNotADirectory
    ) {
      return { channelId, action: 'failed' }
    }
    const e = err instanceof AgentDirectorError ? err : new AgentDirectorError('resume', 'UnknownError', String(err))
    console.error(`[slack] spawnForRoute: resume failed for channel=${channelId}: ${e.errName}`)
    postSpawnFailureToChannel(channelId, e, web, isStartup)
    return { channelId, action: 'failed' }
  }
}

/**
 * Core per-route spawn dispatcher (SR-1.4):
 *
 * 1. Dry-run: skip entirely, return synthetic success.
 * 2. Attempt `client.spawn(...)`. On success → done.
 * 3. `ErrInstanceIdCollision` → `client.get(...)` then branch on state:
 *    - ended/missing + resume_enabled → resume; on ErrNoSessionId/
 *      ErrJsonlMissing → delete + fresh spawn.
 *    - ended/missing + !resume_enabled → kill + delete + fresh spawn.
 *    - waiting → reconnectMcp; 'dead-session' → resume/fresh-spawn (b.3ce).
 *    - working → waitForWaitingAndReconnect; 'dead-session' → resume/fresh-spawn (b.3ce).
 *    - pending/check_permission/ask_user → no-op.
 * 4. Other errors → surface to Slack + (when isStartup) startup-errors.log.
 */
export async function spawnForRoute(
  channelId: string,
  route: { cwd: string },
  routingConfig: RoutingConfig,
  web?: WebClient,
  isStartup = true,
): Promise<SpawnRouteResult> {
  if (isDryRun()) {
    console.error(`[slack] dry-run: skipping spawn for channel=${channelId} cwd=${route.cwd}`)
    return { channelId, action: 'no-op' }
  }

  const params = buildSpawnParams(channelId, route, routingConfig)
  const normalizedName = routingConfig.routes[channelId]?.normalizedName

  // Attempt fresh spawn ---
  try {
    const r = await withSpawnDetection(channelId, route.cwd, (client) => client.spawn(params))
    console.error(`[slack] spawnForRoute: spawned channel=${channelId} instanceId=${r.claude_instance_id}`)
    await approvePreSessionDialogs(channelId, web, isStartup, normalizedName)
    return { channelId, action: 'spawned' }
  } catch (err) {
    if (err instanceof ErrInstanceIdCollision) {
      // Collision → fall through to get-then-act
      console.error(`[slack] spawnForRoute: ErrInstanceIdCollision for channel=${channelId} — fetching current state`)
    } else if (err instanceof ErrTmuxSessionCreate) {
      // b.vub: fresh spawn collided on the deterministic tmux session name held
      // by an orphan session (no instance-id collision → no AD row to resolve).
      // Self-heal: kill the orphan by name, retry spawn once.
      try {
        const r = await selfHealTmuxCollisionAndRespawn(channelId, route, params, normalizedName)
        console.error(`[slack] spawnForRoute: self-heal spawn succeeded after ErrTmuxSessionCreate for channel=${channelId} instanceId=${r.claude_instance_id}`)
        await approvePreSessionDialogs(channelId, web, isStartup, normalizedName)
        return { channelId, action: 'spawned' }
      } catch (err2) {
        if (
          err2 instanceof ErrSystemInstallDisappeared ||
          err2 instanceof ErrTmuxNotAvailable ||
          err2 instanceof ErrCwdNotFound ||
          err2 instanceof ErrCwdNotADirectory
        ) {
          return { channelId, action: 'failed' }
        }
        const e = err2 instanceof AgentDirectorError ? err2 : new AgentDirectorError('spawn', 'UnknownError', String(err2))
        console.error(`[slack] spawnForRoute: self-heal spawn after ErrTmuxSessionCreate failed for channel=${channelId}: ${e.errName}`)
        if (isStartup) recordStartupError('spawn-failed', `self-heal spawn after ErrTmuxSessionCreate failed for channel=${channelId}: ${e.errName}`, e)
        postSpawnFailureToChannel(channelId, e, web, isStartup)
        return { channelId, action: 'failed' }
      }
    } else if (
      err instanceof ErrSystemInstallDisappeared ||
      err instanceof ErrTmuxNotAvailable ||
      err instanceof ErrCwdNotFound ||
      err instanceof ErrCwdNotADirectory
    ) {
      return { channelId, action: 'failed' }
    } else {
      const e = err instanceof AgentDirectorError ? err : new AgentDirectorError('spawn', 'UnknownError', String(err))
      console.error(`[slack] spawnForRoute: spawn failed for channel=${channelId}: ${e.errName}`)
      if (isStartup) recordStartupError('spawn-failed', `spawn failed for channel=${channelId}: ${e.errName}`, e)
      postSpawnFailureToChannel(channelId, e, web, isStartup)
      return { channelId, action: 'failed' }
    }
  }

  // Collision-handling: get-then-act ---
  let state: string
  try {
    const r = await withOutageDetection(channelId, undefined, (client) => client.get({ claude_instance_id: instanceIdFor(channelId, normalizedName) }))
    state = r.state
  } catch (err) {
    if (err instanceof ErrSpawnNotFound) {
      // Race: row deleted between spawn-collision and get. Retry spawn once.
      console.error(`[slack] spawnForRoute: ErrSpawnNotFound after collision for channel=${channelId} — retrying spawn (single retry)`)
      try {
        const r = await withSpawnDetection(channelId, route.cwd, (client) => client.spawn(params))
        console.error(`[slack] spawnForRoute: retry-spawn succeeded for channel=${channelId} instanceId=${r.claude_instance_id}`)
        await approvePreSessionDialogs(channelId, web, isStartup, normalizedName)
        return { channelId, action: 'spawned' }
      } catch (err2) {
        if (
          err2 instanceof ErrSystemInstallDisappeared ||
          err2 instanceof ErrTmuxNotAvailable ||
          err2 instanceof ErrCwdNotFound ||
          err2 instanceof ErrCwdNotADirectory
        ) {
          return { channelId, action: 'failed' }
        }
        const e = err2 instanceof AgentDirectorError ? err2 : new AgentDirectorError('spawn', 'UnknownError', String(err2))
        console.error(`[slack] spawnForRoute: retry-spawn also failed for channel=${channelId}: ${e.errName}`)
        if (isStartup) recordStartupError('spawn-failed', `retry-spawn failed for channel=${channelId}: ${e.errName}`, e)
        postSpawnFailureToChannel(channelId, e, web, isStartup)
        return { channelId, action: 'failed' }
      }
    }
    if (err instanceof ErrSystemInstallDisappeared || err instanceof ErrTmuxNotAvailable) {
      return { channelId, action: 'failed' }
    }
    const e = err instanceof AgentDirectorError ? err : new AgentDirectorError('get', 'UnknownError', String(err))
    console.error(`[slack] spawnForRoute: get failed for channel=${channelId}: ${e.errName}`)
    postSpawnFailureToChannel(channelId, e, web, isStartup)
    return { channelId, action: 'failed' }
  }

  console.error(`[slack] spawnForRoute: collision resolved, state=${state} for channel=${channelId}`)

  if (state === 'ended' || state === 'missing') {
    return resumeOrFreshSpawn(channelId, route, params, routingConfig, normalizedName, web, isStartup)
  }

  if (state === 'waiting') {
    // b.rmy: propagate the reconnect outcome — a failed reconnect must count
    // as `failed` so startupSessionManager's ok/failed totals reflect reality.
    // b.3ce: a 'dead-session' verdict means send-keys can never reach the
    // spawn (tmux session wiped by a reboot while the AD row froze at
    // `waiting`) — recover exactly like the ended/missing states instead of
    // giving up.
    const outcome = await reconnectMcp(channelId, web, routingConfig)
    if (outcome === 'dead-session') {
      console.error(`[slack] spawnForRoute: dead tmux session for channel=${channelId} (state=waiting) — recovering via resume/fresh-spawn`)
      return resumeOrFreshSpawn(channelId, route, params, routingConfig, normalizedName, web, isStartup, { reconcileMissingFirst: true })
    }
    if (outcome !== 'ok') {
      console.error(`[slack] spawnForRoute: reconnect failed for channel=${channelId}`)
      if (isStartup) recordStartupError('spawn-failed', `reconnect failed for channel=${channelId} (state=waiting)`)
      return { channelId, action: 'failed' }
    }
    return { channelId, action: 'reconnected' }
  }

  if (state === 'working') {
    // b.rmy/b.3ce/b.ecw: same outcome propagation and dead-session recovery as
    // the `waiting` branch. waitForWaitingAndReconnect returns 'ok' on live
    // transient transitions and whenever the claude PROCESS is verifiably alive
    // (a long turn isn't an error); 'dead-session' when the process is provably
    // gone (ended/missing, or the timeout sweep + status verdict — b.ecw) or the
    // tmux session provably doesn't exist (spawn-not-found — b.c3o).
    const outcome = await waitForWaitingAndReconnect(channelId, routingConfig, web)
    if (outcome === 'dead-session') {
      console.error(`[slack] spawnForRoute: dead tmux session for channel=${channelId} (state=working) — recovering via resume/fresh-spawn`)
      return resumeOrFreshSpawn(channelId, route, params, routingConfig, normalizedName, web, isStartup, { reconcileMissingFirst: true })
    }
    if (outcome !== 'ok') {
      console.error(`[slack] spawnForRoute: reconnect failed for channel=${channelId}`)
      if (isStartup) recordStartupError('spawn-failed', `reconnect failed for channel=${channelId} (state=working)`)
      return { channelId, action: 'failed' }
    }
    return { channelId, action: 'reconnected' }
  }

  if (state === 'pending' || state === 'check_permission' || state === 'ask_user') {
    console.error(`[slack] spawnForRoute: no action — state=${state} for channel=${channelId}`)
    return { channelId, action: 'no-op' }
  }

  console.error(`[slack] spawnForRoute: unexpected state=${state} for channel=${channelId} — no action`)
  return { channelId, action: 'no-op' }
}

// ---------------------------------------------------------------------------
// reconcileOrphans — SR-1.6 startup orphan reconciliation
// ---------------------------------------------------------------------------

export interface OrphanReconcileResult {
  found: number
  killed: number
  failed: number
}

/**
 * Enumerate all `service=cscb` spawns and kill+delete any whose `channel`
 * label is missing or not in routingConfig.routes. List-level failure is
 * logged but does not block startup.
 */
export async function reconcileOrphans(
  routingConfig: RoutingConfig,
): Promise<OrphanReconcileResult> {
  if (isDryRun()) {
    console.error('[slack] dry-run: skipping orphan reconciliation')
    return { found: 0, killed: 0, failed: 0 }
  }

  const client = getClient()
  let rows: ListRow[]
  try {
    const r = await client.list({ label: ['service=cscb'] })
    rows = r.spawns
  } catch (err) {
    const e = err instanceof AgentDirectorError ? err : new AgentDirectorError('list', 'UnknownError', String(err))
    recordStartupError(
      'orphan-cleanup-list-failed',
      `failed to list spawns for orphan reconciliation: ${e.errName}`,
      e,
    )
    return { found: 0, killed: 0, failed: 0 }
  }

  const configuredChannels = new Set(Object.keys(routingConfig.routes))

  let found = 0
  let killed = 0
  let failed = 0

  for (const row of rows) {
    const channelLabel = row.labels['channel']
    const isOrphan = !channelLabel || !configuredChannels.has(channelLabel)
    if (!isOrphan) continue

    found++
    const displayChannel = channelLabel ?? '<no channel label>'
    console.error(
      `[slack] reconcileOrphans: orphan found channel=${displayChannel} instanceId=${row.claude_instance_id} state=${row.state} — killing and deleting`,
    )

    try {
      await client.kill({ claude_instance_id: row.claude_instance_id })
    } catch (err) {
      const e = err instanceof AgentDirectorError ? err : new AgentDirectorError('kill', 'UnknownError', String(err))
      recordStartupError(
        'orphan-cleanup',
        `kill failed for orphan instanceId=${row.claude_instance_id} channel=${displayChannel}: ${e.errName}`,
        e,
      )
      // continue to delete attempt
    }

    try {
      await client.delete({ claude_instance_id: [row.claude_instance_id] })
      killed++
    } catch (err) {
      const e = err instanceof AgentDirectorError ? err : new AgentDirectorError('delete', 'UnknownError', String(err))
      recordStartupError(
        'orphan-cleanup',
        `delete failed for orphan instanceId=${row.claude_instance_id} channel=${displayChannel}: ${e.errName}`,
        e,
      )
      failed++
    }
  }

  console.error(`[slack] reconcileOrphans: found=${found} killed=${killed} failed=${failed}`)
  return { found, killed, failed }
}

// ---------------------------------------------------------------------------
// Channel-name resolution (b.1m9)
// ---------------------------------------------------------------------------

export interface ChannelNameResolveResult {
  channelId: string
  name?: string
  normalizedName?: string
  /** When set, conversations.info failed; route stays nameless and falls back to bare-ID naming. */
  error?: string
}

/** Minimal WebClient surface this module needs — just conversations.info. */
export type ChannelInfoClient = {
  conversations: {
    info: (args: { channel: string }) => Promise<{ channel?: { name?: string } }>
  }
}

/**
 * Resolve and cache Slack channel names for every route at startup.
 *
 * For each `routingConfig.routes[channelId]`, call `conversations.info` once
 * and stash the result on `route.name` + `route.normalizedName`. Sessions
 * spawned during startup then carry the new `slack_bot_<name>_<id>` /
 * `cscb_<name>_<id>` naming for operator glanceability.
 *
 * Failure is non-fatal: any per-route rejection (network, missing scope,
 * unknown channel, no `channel.name` field) logs a single line and leaves
 * the route nameless. `instanceIdFor` / `tmuxSessionNameFor` then fall back
 * to bare-ID naming, preserving pre-b.1m9 behavior for that one route.
 *
 * Mutates `routingConfig.routes` in place. Returns per-route diagnostics for
 * the operator and for tests.
 */
export async function resolveChannelNames(
  routingConfig: RoutingConfig,
  web: ChannelInfoClient | undefined,
): Promise<ChannelNameResolveResult[]> {
  const results: ChannelNameResolveResult[] = []
  if (!web) {
    // Dry-run or otherwise no WebClient — leave every route nameless.
    console.error('[slack] resolveChannelNames: no WebClient available — skipping')
    return results
  }
  for (const [channelId, route] of Object.entries(routingConfig.routes)) {
    try {
      const resp = await web.conversations.info({ channel: channelId })
      const name = resp.channel?.name
      if (!name) {
        const r: ChannelNameResolveResult = { channelId, error: 'no name on conversations.info response' }
        console.error(`[slack] resolveChannelNames: channel=${channelId} → (no name) — falling back to bare-ID`)
        results.push(r)
        continue
      }
      const normalizedName = normalizeChannelName(name)
      route.name = name
      route.normalizedName = normalizedName.length > 0 ? normalizedName : undefined
      console.error(
        `[slack] resolveChannelNames: channel=${channelId} → "${name}" (normalized="${route.normalizedName ?? ''}")`,
      )
      results.push({ channelId, name, normalizedName: route.normalizedName })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error(`[slack] resolveChannelNames: channel=${channelId} → error: ${msg} — falling back to bare-ID`)
      results.push({ channelId, error: msg })
    }
  }
  return results
}

/**
 * Opportunistically refresh a route's cached channel name from an incoming
 * Slack event. Slack only includes `channel.name` on some event types
 * (channel_rename, channel_archive, etc.); message events typically don't
 * carry it. When it IS present, refreshing here covers channel renames
 * without a CSCB restart.
 *
 * No-ops when the event has no channel name, no matching route, or the
 * cached name is already up to date.
 */
export function refreshRouteNameFromEvent(
  routingConfig: RoutingConfig,
  event: unknown,
): void {
  if (!event || typeof event !== 'object') return
  const ev = event as Record<string, unknown>

  let channelId: string | undefined
  let channelName: string | undefined

  // Form A: { channel: 'C…', channel_name: 'foo' } — used by channel_rename
  if (typeof ev['channel'] === 'string') {
    channelId = ev['channel'] as string
    if (typeof ev['channel_name'] === 'string') channelName = ev['channel_name'] as string
  }
  // Form B: { channel: { id: 'C…', name: 'foo' } } — used by channel_archive, etc.
  if (channelName === undefined && ev['channel'] && typeof ev['channel'] === 'object') {
    const ch = ev['channel'] as Record<string, unknown>
    if (typeof ch['id'] === 'string') channelId = ch['id'] as string
    if (typeof ch['name'] === 'string') channelName = ch['name'] as string
  }

  if (!channelId || !channelName) return
  const route = routingConfig.routes[channelId]
  if (!route) return
  if (route.name === channelName) return

  const normalizedName = normalizeChannelName(channelName)
  route.name = channelName
  route.normalizedName = normalizedName.length > 0 ? normalizedName : undefined
  console.error(
    `[slack] refreshRouteNameFromEvent: channel=${channelId} → "${channelName}" (normalized="${route.normalizedName ?? ''}")`,
  )
}

// ---------------------------------------------------------------------------
// Instance-id migration (b.1m9)
// ---------------------------------------------------------------------------

export interface InstanceIdMigrationResult {
  /** Rows whose claude_instance_id doesn't match the route's expected new-naming id. */
  orphans: Array<{ channelId: string; oldInstanceId: string; expectedInstanceId: string }>
  /** When auto-delete is on: count of rows we successfully removed. */
  deleted: number
  /** When auto-delete is on: count of rows whose delete failed. */
  failed: number
}

/**
 * Detect agent-director rows whose `claude_instance_id` predates the b.1m9
 * naming change (`cscb_<id>`) for channels we now spawn as
 * `cscb_<name>_<id>`. The bare-ID rows are orphans the next time the server
 * starts; the new-naming spawn won't collide with them, so they linger.
 *
 * Default behavior: warn only, one line per orphan listing the exact
 * `agent-director delete --claude-instance-id …` command the operator can
 * paste. With `autoDelete=true`, this function calls `client.delete` for
 * each orphan instead.
 *
 * Note: a row whose channel label is not in `routingConfig.routes` at all
 * is handled by `reconcileOrphans` (SR-1.6), not here.
 */
export async function reconcileInstanceIds(
  routingConfig: RoutingConfig,
  autoDelete: boolean,
): Promise<InstanceIdMigrationResult> {
  const empty: InstanceIdMigrationResult = { orphans: [], deleted: 0, failed: 0 }
  if (isDryRun()) {
    console.error('[slack] dry-run: skipping instance-id reconcile')
    return empty
  }

  const client = getClient()
  let rows: ListRow[]
  try {
    const r = await client.list({ label: ['service=cscb'] })
    rows = r.spawns
  } catch (err) {
    const e = err instanceof AgentDirectorError ? err : new AgentDirectorError('list', 'UnknownError', String(err))
    console.error(`[slack] reconcileInstanceIds: list failed — skipping: ${e.errName}`)
    return empty
  }

  const orphans: InstanceIdMigrationResult['orphans'] = []
  for (const row of rows) {
    const channelId = row.labels['channel']
    if (!channelId) continue
    const route = routingConfig.routes[channelId]
    if (!route) continue // covered by reconcileOrphans
    const expected = instanceIdFor(channelId, route.normalizedName)
    if (row.claude_instance_id === expected) continue
    orphans.push({ channelId, oldInstanceId: row.claude_instance_id, expectedInstanceId: expected })
  }

  if (orphans.length === 0) {
    return empty
  }

  if (!autoDelete) {
    console.error(
      `[slack] reconcileInstanceIds: found ${orphans.length} row(s) with stale claude_instance_id ` +
        `(pre-b.1m9 naming). The new spawn(s) will not collide; the old row(s) will linger. ` +
        `Pass --reconcile-instance-ids to auto-delete, or run the commands below:`,
    )
    for (const o of orphans) {
      console.error(
        `[slack] reconcileInstanceIds: channel=${o.channelId} stale=${o.oldInstanceId} ` +
          `expected=${o.expectedInstanceId} — agent-director delete --claude-instance-id ${o.oldInstanceId}`,
      )
    }
    return { orphans, deleted: 0, failed: 0 }
  }

  let deleted = 0
  let failed = 0
  for (const o of orphans) {
    console.error(
      `[slack] reconcileInstanceIds: deleting stale row channel=${o.channelId} instanceId=${o.oldInstanceId}`,
    )
    try {
      await withOutageDetection(o.channelId, undefined, (client) => client.delete({ claude_instance_id: [o.oldInstanceId] }))
      deleted++
    } catch (err) {
      if (err instanceof ErrSystemInstallDisappeared || err instanceof ErrTmuxNotAvailable) {
        failed++
        continue
      }
      const e = err instanceof AgentDirectorError ? err : new AgentDirectorError('delete', 'UnknownError', String(err))
      console.error(
        `[slack] reconcileInstanceIds: delete failed for channel=${o.channelId} instanceId=${o.oldInstanceId}: ${e.errName}`,
      )
      failed++
    }
  }
  return { orphans, deleted, failed }
}

// ---------------------------------------------------------------------------
// startupSessionManager — iterate routes and dispatch per-channel
// ---------------------------------------------------------------------------

export interface StartupSessionManagerResult {
  /** Any non-failed action (kept for callers that only care about liveness). */
  succeeded: number
  failed: number
  /** b.wrb: honest per-outcome breakdown of the succeeded routes. */
  resumed: number
  /** Clean fresh spawns (no prior row / no resume attempted). */
  freshSpawned: number
  /** Fresh spawns that REPLACED a resume because the transcript was missing
   *  (ErrJsonlMissing amnesia) and diagnosis was CONCLUSIVE ('lost' or
   *  evidence-based 'never-created') — separated so they are never hidden in
   *  "ok". */
  freshAfterAmnesia: number
  /** b.fwu: fresh spawns that REPLACED a resume after ErrJsonlMissing amnesia
   *  where diagnosis was INCONCLUSIVE — we could not determine whether prior
   *  history was destroyed. Kept apart from freshAfterAmnesia so the operator
   *  can distinguish known-cause amnesia from undiagnosable amnesia. */
  freshAfterInconclusiveAmnesia: number
  reconnected: number
  noop: number
  perChannel: Array<{ channelId: string; action: SpawnRouteResult['action'] }>
}

/**
 * On server startup, iterate all configured routes and call spawnForRoute
 * for each. Uses a worker-pool pattern to limit concurrency.
 *
 * Per-route failures are logged and recorded in startup-errors.log but never
 * crash the server. cozempic availability is probed in the background
 * (non-blocking).
 */
export async function startupSessionManager(
  routingConfig: RoutingConfig,
  options?: { concurrency?: number },
  web?: WebClient,
): Promise<StartupSessionManagerResult> {
  await checkCozempicAvailable()

  const routeEntries = Object.entries(routingConfig.routes)
  const concurrency = options?.concurrency ?? 3

  console.error(
    `[slack] startupSessionManager: ${routeEntries.length} route(s), concurrency=${concurrency}`,
  )

  const perChannel: Array<{ channelId: string; action: SpawnRouteResult['action'] }> = []
  let succeeded = 0
  let failed = 0
  let resumed = 0
  let freshSpawned = 0
  let freshAfterAmnesia = 0
  let freshAfterInconclusiveAmnesia = 0
  let reconnected = 0
  let noop = 0
  let nextIdx = 0

  function tally(action: SpawnRouteResult['action']): void {
    switch (action) {
      case 'failed':
        failed++
        break
      case 'resumed':
        resumed++
        succeeded++
        break
      case 'fresh-after-amnesia':
        freshAfterAmnesia++
        succeeded++
        break
      case 'fresh-after-inconclusive-amnesia':
        freshAfterInconclusiveAmnesia++
        succeeded++
        break
      case 'reconnected':
        reconnected++
        succeeded++
        break
      case 'no-op':
        noop++
        succeeded++
        break
      case 'spawned':
      default:
        freshSpawned++
        succeeded++
        break
    }
  }

  async function processRoute(channelId: string, route: { cwd: string }): Promise<void> {
    try {
      const result = await spawnForRoute(channelId, route, routingConfig, web)
      perChannel.push({ channelId, action: result.action })
      tally(result.action)
    } catch (err) {
      console.error(`[slack] startupSessionManager: unexpected error for channel=${channelId}:`, err)
      recordStartupError(
        'spawn-failed',
        `unexpected error spawning channel=${channelId}: ${String(err)}`,
        err,
      )
      perChannel.push({ channelId, action: 'failed' })
      failed++
    }
  }

  async function worker(): Promise<void> {
    while (nextIdx < routeEntries.length) {
      const idx = nextIdx++
      if (idx >= routeEntries.length) break
      const [channelId, route] = routeEntries[idx]
      await processRoute(channelId, route)
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, routeEntries.length || 1) }, () => worker()),
  )

  // b.wrb/b.fwu: honest breakdown. A fresh-spawn that replaced a resume because
  // the transcript was missing is reported separately and never folded into a
  // generic "ok". b.fwu splits that amnesia into DIAGNOSED (fresh-after-amnesia:
  // we know whether history was lost) vs UNDIAGNOSABLE
  // (fresh-after-inconclusive-amnesia: we could not tell).
  console.error(
    `[slack] startupSessionManager: complete — ${resumed} resumed, ${freshSpawned} fresh-spawned, ` +
      `${freshAfterAmnesia} fresh-after-amnesia, ${freshAfterInconclusiveAmnesia} fresh-after-inconclusive-amnesia, ` +
      `${reconnected} reconnected, ${noop} no-op, ${failed} failed`,
  )
  if (freshAfterAmnesia > 0) {
    // Loud, grep-friendly signal that some channels lost their resume target.
    // Per-channel "lost vs never-created" detail was already emitted (and, for
    // 'lost', recorded to startup-errors) by diagnoseJsonlMissing.
    console.error(
      `[slack] startupSessionManager: ${freshAfterAmnesia} channel(s) were fresh-spawned after ErrJsonlMissing ` +
        `(transcript could not be resumed) — see per-channel "ErrJsonlMissing diagnostic" lines above.`,
    )
  }
  if (freshAfterInconclusiveAmnesia > 0) {
    // b.fwu: a separate, louder signal — these channels were fresh-spawned but
    // the diagnosis machinery could not tell whether history was destroyed. That
    // degraded-diagnosis condition correlates with the storage faults that cause
    // real loss, so it warrants its own attention. Each was recorded to
    // startup-errors as 'jsonl-diagnosis-inconclusive'.
    console.error(
      `[slack] startupSessionManager: ${freshAfterInconclusiveAmnesia} channel(s) were fresh-spawned after ` +
        `ErrJsonlMissing WITHOUT a conclusive diagnosis — could NOT determine whether conversation history was ` +
        `lost. See per-channel "ErrJsonlMissing diagnostic ... INCONCLUSIVE" lines and the ` +
        `'jsonl-diagnosis-inconclusive' startup errors above.`,
    )
  }

  return {
    succeeded,
    failed,
    resumed,
    freshSpawned,
    freshAfterAmnesia,
    freshAfterInconclusiveAmnesia,
    reconnected,
    noop,
    perChannel,
  }
}

// ---------------------------------------------------------------------------
// launchSession — restart.ts adapter
// ---------------------------------------------------------------------------

/**
 * Restart-adapter shim for restart.ts (`RestartDeps.launchSession`).
 *
 * Returns true on any non-failed action (spawned / resumed / reconnected /
 * no-op), false on `failed`. The richer `SpawnRouteResult` is collapsed
 * here because the restart subsystem only cares about did-it-relaunch.
 */
export async function launchSession(
  channelId: string,
  cwd: string,
  routingConfig: RoutingConfig,
  web?: WebClient,
): Promise<boolean> {
  const result = await spawnForRoute(channelId, { cwd }, routingConfig, web, false)
  return result.action !== 'failed'
}
