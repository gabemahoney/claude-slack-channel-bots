/**
 * session-manager.ts — Library-backed startup orchestration for CSCB.
 *
 * The previous tmux-direct implementation has been replaced with calls to the
 * agent-director TypeScript library `Client` singleton (SR-1). Spawns are
 * keyed by persona (b.av2 SR-2.2): instance ID `cscb_<key>`, tmux session
 * `slack_bot_<key>`, `relay_mode='on'`, and the labels `service=cscb`,
 * `persona=<key>` and `config_dir=<12 hex of the real effective
 * claude_config_dir>`, and no other label. Per-persona reconciliation uses
 * the SR-1.4 collision-then-act dispatch:
 *
 *   1. Try `client.spawn(...)` directly.
 *   2. On `ErrInstanceIdCollision`, call `client.get(...)`. A row whose `cwd`
 *      differs from the persona's working directory by real path is killed,
 *      deleted and spawned fresh whatever its state (b.av2 SR-6.2). Otherwise
 *      branch on the observed state (ended/missing → resume or
 *      kill+delete+spawn; waiting → /mcp reconnect via sendKeys; working →
 *      wait for waiting then reconnect; pending/check_permission/ask_user →
 *      no-op). Before any resume, a row whose `config_dir` label is missing
 *      or differs from the persona's current effective claude_config_dir is
 *      deleted and spawned fresh instead (a resume keeps the old config dir).
 *   3. Any other error raises a spawn-failure notice for the persona via
 *      `notifySpawnFailure` (through the per-persona notifier) and is logged.
 *
 * Both row checks go through `compareRowToPersona`. At most one launch per
 * persona is in flight (b.av2 SR-6.3): a concurrent call for the same key
 * joins the running ladder. Every launch first resolves the persona's
 * claude_config_dir to a real path with no lexical fallback (bug b.g57,
 * `checkLaunchConfigDir`); when it cannot be resolved the launch makes no
 * agent-director call, keeps the row, hands the persona to the installed
 * hook (`setConfigDirUnresolvableHook`: the bring-up controller holds it
 * `retrying` and re-checks) and returns `deferred`. Every ladder run first
 * calls the installed pre-launch trust patcher (`setPreLaunchTrustPatcher`,
 * b.av2 SR-6.2), so the persona's `.claude.json` trust flags are set before
 * any spawn or resume.
 * Immediately before each `client.spawn` / `client.resume` it calls the
 * installed pre-launch reply guard (`setPreLaunchReplyGuard`, b.av2 SR-9.4):
 * the persona's reply-guard record, launched-with dir and managed Stop hook.
 * A path that only reconnects to a live instance or does nothing runs no
 * reply-guard step (the optimistic spawn's steps are undone on a collision).
 *
 * The start sweep (`reconcileOrphans`, b.av2 SR-6.3) lists every
 * `service=cscb` spawn and kills+deletes any with no `persona` label, a
 * persona absent from the applied configuration, an instance ID other than
 * `cscb_<key>`, or a `cwd` other than its persona's working directory. While a
 * persona's working directory cannot be resolved to a real path, neither the
 * sweep nor the collision ladder kills or deletes on `cwd` grounds a row
 * whose `cwd` has no real path either (b.av2 SR-6.4): the sweep defers the
 * check to the launch, and the ladder fails the launch instead. A row whose
 * `cwd` resolves to an existing directory is still a `cwd` mismatch.
 *
 * At start, `startupSessionManager` brings each applied persona up through
 * the b.av2 SR-6.1 procedure (`persona-start.ts`, driven by the bring-up
 * controller in `persona-bringup-controller.ts`): the local credentials and
 * working-directory checks, Slack validation and connection (every persona at
 * once), then the launch through `spawnForPersona` (at most `concurrency` at
 * a time) for each persona that is up. A restart (`launchSession`) runs the
 * launch only, and only while the caller's gate says the persona is up.
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
  ErrJsonlNeverWritten,
  ErrNoSessionId,
  ErrSpawnNotFound,
  ErrSpawnNotResumable,
  ErrTmuxSendKeys,
  ErrTmuxSessionCreate,
} from 'agent-director'
import type { Client, ListRow, SpawnParams, FindMissingResult, GetResult } from 'agent-director'

import { checkCozempicAvailable, resolveJsonlPath } from './cozempic.ts'
import {
  type Persona,
  type PersonaConfig,
  type StrictRealPathFs,
  MCP_SERVER_NAME,
  resolveRealPathStrict,
  tryResolveRealPath,
} from './config.ts'
import { checkPersonaConfigDir, type ConfigDirCheckResult } from './persona-bringup.ts'
import type { PersonaCheckFailure } from './persona-diagnostics.ts'
import {
  CONFIG_DIR_LABEL_PREFIX,
  PERSONA_LABEL_KEY,
  PERSONA_LABEL_PREFIX,
  SERVICE_LABEL,
  configDirLabelValue,
  personaInstanceId,
  personaSpawnEnv,
  personaTmuxSessionName,
  renderPersonaRef,
  resolveClaudeConfigDir,
} from './persona-identity.ts'
import { getClient } from './agent-director-client.ts'
import { setOutageFlag, withOutageDetection, withSpawnDetection } from './outage-state.ts'
import {
  ErrSystemInstallDisappeared,
  ErrTmuxNotAvailable,
  ErrCwdNotFound,
  ErrCwdNotADirectory,
  ErrSpawnCapReached,
} from './agent-director-errors.ts'
import { recordStartupError } from './startup-errors.ts'
import type { ReplyGuardUndo } from './stop-hook-bootstrap.ts'
import { firstNoticeLine, notifySafely, type PersonaNoticeOptions, type PersonaNotify } from './persona-notifier.ts'
import type { PersonaBringUpFailure } from './persona-start.ts'
import type { PersonaBringUpController, PersonaBringUpOutcome } from './persona-bringup-controller.ts'
import {
  describeLogMessage,
  describeThrownValue,
  isSafeIdentifier,
  MAX_LOGGED_MESSAGE_LENGTH,
} from './persona-connection-errors.ts'
import { describeDestinationFailureCause } from './persona-destination.ts'
import { redactSlackLogText } from './slack-log-redaction.ts'
import { RESTART_FAILURE_CAP } from './restart.ts'
import { isDryRun } from './tokens.ts'
// Import cycle with jsonl-persistence-check.ts: use these imports only inside functions, never at module top level.
import {
  UNATTRIBUTABLE_ZERO_REASON,
  makeDefaultArchiveCount,
  personaArchiveEvidenceScope,
  rfc3339ToEpochSeconds,
} from './jsonl-persistence-check.ts'
import { realpathSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { resolve as resolvePath } from 'node:path'

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
 * Persona reference for log lines and startup-error messages (b.av2 SR-2.2):
 * the name JSON-quoted with the key beside it.
 */
function personaRef(persona: Pick<Persona, 'name' | 'key'>): string {
  return renderPersonaRef(persona.name, persona.key)
}

/** Log reference for a persona when only its key is in scope. */
function keyRef(key: string): string {
  return `persona=${key}`
}

/**
 * Thrown by `personaConfigDirLabelValue` for a claude_config_dir that cannot
 * be resolved to a real path (bug b.g57): there is no lexical fallback, so
 * such a directory has no `config_dir` label. Carries the configured
 * directory (tilde-expanded, absolute) and the errno code; never a token.
 */
export class ConfigDirUnresolvableError extends Error {
  constructor(
    readonly path: string,
    readonly code: string,
  ) {
    super(`claude_config_dir ${JSON.stringify(path)} cannot be resolved to a real path (${code})`)
    this.name = 'ConfigDirUnresolvableError'
  }
}

/**
 * A persona's `config_dir` label value, or why there is none: the configured
 * directory and the errno code when it cannot be resolved to a real path.
 */
function strictConfigDirLabel(
  configDir: string | undefined,
  home: string,
  fs: Partial<StrictRealPathFs> | undefined,
): { label: string } | { path: string; code: string } {
  const path = resolveClaudeConfigDir(configDir, home)
  const resolution = resolveRealPathStrict(path, fs)
  return resolution.resolved ? { label: configDirLabelValue(resolution.path, home) } : { path, code: resolution.code }
}

/**
 * Value of a persona's `config_dir` label: the 12-hex hash of the REAL path
 * of its effective claude_config_dir (b.av2 SR-1.5, SR-2.2). An absent
 * directory means `<home>/.claude`. The directory is tilde-expanded and
 * resolved against `home`, then real-pathed with `resolveRealPathStrict`, so
 * a symlink and its target give the same label, and a directory not created
 * yet gives the label of the real path it will have (its nearest existing
 * ancestor's real path plus the rest). There is no lexical fallback (bug
 * b.g57): a directory that cannot be resolved (a symlink on its path pointing
 * to nothing, an unmounted drive, a dropped mount) throws
 * `ConfigDirUnresolvableError`. E1's `configDirLabelValue` alone hashes
 * lexically; this is the one derivation spawns and later label comparisons
 * use (the launch checks the directory first, `checkLaunchConfigDir`, and
 * `compareRowToPersona` reports it as unresolved rather than throwing).
 *
 * @param configDir  The persona's effective claude_config_dir, as configured.
 * @param home       Home directory; defaults to the OS home, read at call time.
 * @param fs         Realpath and lstat overrides; default the real file system.
 */
export function personaConfigDirLabelValue(
  configDir?: string,
  home: string = homedir(),
  fs?: Partial<StrictRealPathFs>,
): string {
  const result = strictConfigDirLabel(configDir, home, fs)
  if ('label' in result) return result.label
  throw new ConfigDirUnresolvableError(result.path, result.code)
}

/** Label-map key of the `config_dir=<hash>` label (`config_dir`). */
const CONFIG_DIR_LABEL_KEY = CONFIG_DIR_LABEL_PREFIX.slice(0, -1)

/** How an agent-director row compares with a persona (b.av2 SR-6.2, SR-6.3). */
export interface RowPersonaComparison {
  /** The row's `cwd` and the persona's working_directory have the same real path. */
  cwdMatches: boolean
  /**
   * The persona's working_directory resolved to a real path. When it did not
   * (missing, not searchable, a dangling symlink), `cwdMatches` is only the
   * lexical comparison.
   */
  workingDirectoryResolved: boolean
  /**
   * The `cwd` condition cannot be evaluated now (b.av2 SR-6.4): the persona's
   * working_directory has no real path AND the row's `cwd` has none either
   * (absent, missing, a dangling symlink's old target) or equals the
   * configured working_directory lexically. The start sweep and the collision
   * ladder never kill or delete such a row on `cwd` grounds. A row whose `cwd`
   * resolves to an existing directory elsewhere is not deferred: it is a
   * `cwd` mismatch even while the working directory is missing, so a persona
   * never adopts a directory another persona may now own.
   */
  cwdCheckDeferred: boolean
  /**
   * The persona's effective claude_config_dir resolved to a real path (or to
   * the one it will have once created; `resolveRealPathStrict`). When it did
   * not (bug b.g57), there is no `config_dir` verdict: `configDirMatches` and
   * `expectedConfigDirLabel` are undefined, and a caller keeps the row rather
   * than treat it as a mismatch.
   */
  configDirResolved: boolean
  /**
   * The row carries a `config_dir` label equal to `expectedConfigDirLabel`;
   * undefined (no verdict) when the directory is unresolvable. Check
   * `configDirResolved` before acting on it.
   */
  configDirMatches: boolean | undefined
  /** The row's `config_dir` label value; undefined when the label is absent. */
  configDirLabel: string | undefined
  /**
   * The `config_dir` label a spawn of the persona carries now
   * (`personaConfigDirLabelValue`); undefined when the directory is
   * unresolvable, since no label is ever derived from its lexical path.
   */
  expectedConfigDirLabel: string | undefined
}

/**
 * Compare an agent-director row with a persona (b.av2 SR-6.2, SR-6.3). The
 * one place a row's `cwd` is compared with a persona's working directory and
 * a row's `config_dir` label with the persona's current effective
 * claude_config_dir; the collision ladder's `cwd` guard, its pre-resume
 * `config_dir` guard and the start sweep's `cwd` condition all use it.
 * Side-effect free.
 *
 * - `cwdMatches`: `resolveRealPath` on both sides (a symlink to the working
 *   directory matches). A row with no `cwd` never matches.
 * - `workingDirectoryResolved`: the persona's working directory has a real
 *   path (`tryResolveRealPath`).
 * - `cwdCheckDeferred`: the working directory has no real path and the row's
 *   `cwd` has none either or equals the configured path lexically. Callers
 *   skip the `cwd` condition for such a row rather than act on the lexical
 *   comparison (b.av2 SR-6.4); a row whose `cwd` resolves to an existing
 *   directory is compared as usual and so mismatches.
 * - `configDirResolved`: the persona's effective claude_config_dir has a real
 *   path (`resolveRealPathStrict`, no lexical fallback; bug b.g57).
 * - `configDirMatches`: the row's `config_dir` label is present and equals
 *   `personaConfigDirLabelValue(persona.claude_config_dir, home, configDirFs)`,
 *   the value the spawn writes; undefined when the directory is unresolvable.
 *
 * @param row          The row's `cwd` and `labels` (from `get` or `list`).
 * @param persona      The resolved persona.
 * @param home         Home directory for an unset claude_config_dir; defaults
 *   to the OS home, read at call time.
 * @param realpath     Realpath function; defaults to `fs.realpathSync`.
 * @param configDirFs  Realpath and lstat for the claude_config_dir; default
 *   `realpath` and the real `lstat`.
 */
export function compareRowToPersona(
  row: { cwd?: string; labels?: Record<string, string> },
  persona: Pick<Persona, 'working_directory' | 'claude_config_dir'>,
  home: string = homedir(),
  realpath: (path: string) => string = realpathSync,
  configDirFs: Partial<StrictRealPathFs> = { realpath },
): RowPersonaComparison {
  const workingDirectory = tryResolveRealPath(persona.working_directory, realpath)
  const configuredLexical = resolvePath(persona.working_directory)
  const rowCwdReal = row.cwd ? tryResolveRealPath(row.cwd, realpath) : undefined
  const cwdMatches = !!row.cwd && (rowCwdReal ?? resolvePath(row.cwd)) === (workingDirectory ?? configuredLexical)
  const cwdCheckDeferred =
    workingDirectory === undefined &&
    (rowCwdReal === undefined || resolvePath(row.cwd!) === configuredLexical)
  const configDirLabel = row.labels?.[CONFIG_DIR_LABEL_KEY]
  const expected = strictConfigDirLabel(persona.claude_config_dir, home, configDirFs)
  const expectedConfigDirLabel = 'label' in expected ? expected.label : undefined
  return {
    cwdMatches,
    workingDirectoryResolved: workingDirectory !== undefined,
    cwdCheckDeferred,
    configDirResolved: expectedConfigDirLabel !== undefined,
    configDirMatches:
      expectedConfigDirLabel === undefined ? undefined : configDirLabel !== undefined && configDirLabel === expectedConfigDirLabel,
    configDirLabel,
    expectedConfigDirLabel,
  }
}

// ---------------------------------------------------------------------------
// Persona notices — spawn failure, restart cap, transcript loss (b.av2 SR-7.2)
// ---------------------------------------------------------------------------

/**
 * The one sink every session-manager notice goes through. Production installs
 * the per-persona notifier's `notify` (`src/persona-notifier.ts`), which
 * posts to the persona's destination under its identity, adds the persona
 * reference, holds a notice until the persona's client is validated, and
 * logs instead of posting in dry run.
 */
let noticeSink: PersonaNotify | undefined

/**
 * Install the notice sink, or clear it by passing undefined. With no sink
 * installed (unit tests, the integration driver) a notice is logged, never
 * posted, and never throws.
 */
export function setSessionNotifier(notify: PersonaNotify | undefined): void {
  noticeSink = notify
}

/** Send one notice body for persona `key` through the installed sink. Never throws. */
function sendPersonaNotice(key: string, text: string, options?: PersonaNoticeOptions): void {
  if (!noticeSink) {
    console.error(`[slack] session-manager: no notifier installed — notice for ${keyRef(key)} not posted: ${firstNoticeLine(text)}`)
    return
  }
  notifySafely(noticeSink, key, text, options, (err) => {
    console.error(`[slack] session-manager: notifier failed for ${keyRef(key)}: ${describeThrownValue(err)}`)
  })
}

/**
 * The error label of a spawn-failure notice: the typed error's `errName` when
 * it is a short identifier, else `describeThrownValue` of the error without
 * its `message="…"` field (which holds the description, prefixed by the
 * unchecked `errName`). The notice shows the description itself, once,
 * after the label.
 */
function spawnFailureLabel(error: AgentDirectorError): string {
  if (isSafeIdentifier(error.errName)) return error.errName
  const described = describeThrownValue(error)
  const message = describeLogMessage(error.message)
  return message === '' ? described : described.replace(` ${message}`, '')
}

/**
 * Raise a spawn-failure notice for persona `key`: the error name, the
 * description (through `redactSlackLogText`, cut to
 * `MAX_LOGGED_MESSAGE_LENGTH` characters) and a remediation hint. When a
 * startup notice's post fails, the `spawn-failure-post` startup error is
 * recorded; outside startup the failure is logged.
 */
export function notifySpawnFailure(key: string, error: AgentDirectorError, isStartup = true): void {
  const ref = keyRef(key)
  const text =
    `Spawn failure:\n` +
    `  Error: \`${spawnFailureLabel(error)}\` — ${redactSlackLogText(error.errDescription ?? '').slice(0, MAX_LOGGED_MESSAGE_LENGTH)}\n` +
    `  Remediation: ${remediationHint(error)}`
  sendPersonaNotice(key, text, {
    onPostFailure: (failure) => {
      // Token-safe cause: a Slack rejection can carry secrets, so only the
      // describer's output (type, code, redacted message, frames) reaches
      // stderr and the log file.
      // A failed DM open names the step and its code.
      const cause = describeDestinationFailureCause(failure)
      if (isStartup) {
        recordStartupError('spawn-failure-post', `failed to post spawn failure for ${ref}`, cause)
      } else {
        console.error(`[slack] spawn-failure-post: failed to post spawn failure for ${ref}: ${cause}`)
      }
    },
  })
}

/**
 * Raise the restart-cap notice for persona `key` (restart.ts `onCapReached`):
 * a non-startup spawn-failure notice carrying `ErrSpawnCapReached`, whose
 * remediation says automatic restarts are suspended for this persona.
 */
export function notifyRestartCapReached(key: string): void {
  const err = new ErrSpawnCapReached(
    `${RESTART_FAILURE_CAP} consecutive session-launch failures — automatic restarts suspended`,
  )
  notifySpawnFailure(key, err, false)
}

function remediationHint(error: AgentDirectorError): string {
  if (error instanceof ErrInstanceIdCollision) return 'spawn dispatcher bug — please report'
  if (error instanceof ErrSpawnNotFound) return 'transient — restarting the server should resolve'
  if (error instanceof ErrSpawnCapReached) return 'restart the server to retry — automatic restarts are suspended for this persona'
  return 'Check server.log for details.'
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
 * Return 'dead-session' so spawnForPersona can fall through to resume/fresh-spawn.
 *
 * @param key  Persona key: addresses `cscb_<key>` and keys outage flags and notices.
 * @param ref  Log reference; defaults to the key alone.
 */
export async function reconnectMcp(
  key: string,
  ref: string = keyRef(key),
): Promise<ReconnectOutcome> {
  const claude_instance_id = personaInstanceId(key)
  console.error(`[slack] reconnecting MCP server "${MCP_SERVER_NAME}": ${ref}`)
  const sendReconnect = (): Promise<unknown> =>
    withOutageDetection(key, undefined, (client) => client.sendKeys({
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
        `[slack] reconnectMcp: ErrTmuxSendKeys for ${ref} — ensuring tmux server exists and retrying send-keys once`,
      )
      await _ensureTmuxServer()
      try {
        await sendReconnect()
        console.error(`[slack] reconnectMcp: retry succeeded after ErrTmuxSendKeys for ${ref}`)
        return 'ok'
      } catch (err2) {
        if (err2 instanceof ErrSystemInstallDisappeared || err2 instanceof ErrTmuxNotAvailable) return 'failed'
        const e2 = err2 instanceof AgentDirectorError ? err2 : new AgentDirectorError('send-keys', 'UnknownError', String(err2))
        console.error(`[slack] reconnectMcp: retry after ErrTmuxSendKeys failed for ${ref}: ${describeAgentDirectorFailure(e2)}`)
        if (err2 instanceof ErrTmuxSendKeys) {
          // b.3ce: the session is provably gone — signal the caller to recover
          // via resume/fresh-spawn instead of posting a terminal failure.
          return 'dead-session'
        }
        notifySpawnFailure(key, e2)
        return 'failed'
      }
    }
    const e = err instanceof AgentDirectorError ? err : new AgentDirectorError('send-keys', 'UnknownError', String(err))
    console.error(`[slack] reconnectMcp: send-keys failed for ${ref}: ${describeAgentDirectorFailure(e)}`)
    notifySpawnFailure(key, e)
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
 * per-persona session name. Injectable so unit tests stay hermetic.
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
 * into a live prompt. Addresses the persona's `cscb_<key>` instance.
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
  key: string,
  isStartup: boolean,
  ref: string = keyRef(key),
): Promise<void> {
  const claude_instance_id = personaInstanceId(key)
  const deadline = Date.now() + _dialogReadyTimeoutMs
  let deadStreak = 0

  while (Date.now() < deadline) {
    // 1) Readiness oracle.
    let state: string
    try {
      const r = await withOutageDetection(key, undefined, (client) => client.status({ claude_instance_id }))
      state = r.state
    } catch (err) {
      if (err instanceof ErrSpawnNotFound) {
        console.error(`[slack] approvePreSessionDialogs: spawn not found for ${ref} — aborting`)
        return
      }
      // Transient (incl. AD-outage errors already flagged by withOutageDetection) — keep polling.
      console.error(`[slack] approvePreSessionDialogs: status error ${ref}: ${describeThrownValue(err)}`)
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
      const sessionName = personaTmuxSessionName(key)
      try {
        const pane = await _tmuxCapturePane(sessionName)
        needleVisible = PRE_SESSION_DIALOG_NEEDLES.some((n) => pane.includes(n))
        if (needleVisible) {
          await _tmuxSendEnter(sessionName)
        }
      } catch (err) {
        console.error(`[slack] approvePreSessionDialogs: raw-tmux fallback error ${ref}: ${describeThrownValue(err)}`)
      }
    } else {
      // Interactive (pending) — drive via agent-director.
      try {
        const { pane } = await withOutageDetection(key, undefined, (client) => client.readPane({ claude_instance_id, n_lines: 40, allow_pending: true }))
        needleVisible = PRE_SESSION_DIALOG_NEEDLES.some((n) => pane.includes(n))
        if (needleVisible) {
          await withOutageDetection(key, undefined, (client) => client.sendKeys({ claude_instance_id, text: '', allow_pending: true })) // Enter
        }
      } catch (err) {
        console.error(`[slack] approvePreSessionDialogs: readPane/sendKeys error ${ref}: ${describeThrownValue(err)}`)
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
        const msg = `spawn reached ${state} before clearing dev-channels dialog for ${ref} (no needle for ${deadStreak} polls)`
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
  const msg = `spawn never reached a live state within ${_dialogReadyTimeoutMs}ms for ${ref} — dialog unrecognized or session hung (dev-needle='${DEV_CHANNELS_DIALOG_NEEDLE}')`
  console.error(`[slack] approvePreSessionDialogs: ${msg}`)
  if (isStartup) recordStartupError('dev-channels-approve-not-ready', msg)
  notifySpawnFailure(key, new AgentDirectorError('status', 'DialogApprovalTimeout', msg), isStartup)
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
 * collapse a same-tick escalate-dead burst: when N personas escalate together
 * (b.nk5 fleet shape — /tmp wiped, every persona dead-tmux at once), those
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
 * @param key persona key: the outage key and log context — the sweep itself is whole-store.
 * @param logPrefix distinguishes the call sites in the log line.
 * @param ref log reference; defaults to the key alone.
 */
async function reconcileMissingSweep(key: string, logPrefix: string, ref: string = keyRef(key)): Promise<void> {
  // Memo hit: a recent successful sweep is still within the TTL. Reuse it.
  if (_findMissingLast && Date.now() - _findMissingLast.at < _findMissingMemoTtlMs) {
    return
  }

  // Single-flight: an in-flight sweep exists — await it rather than starting one.
  if (!_findMissingInFlight) {
    _findMissingInFlight = withOutageDetection(key, undefined, (client) => client.findMissing({}))
  }
  const inFlight = _findMissingInFlight

  try {
    const r = await inFlight
    // Only the caller that started this sweep records the result/log (others
    // await the same promise but must not double-log or re-stamp the memo).
    if (_findMissingInFlight === inFlight) {
      _findMissingLast = { result: r, at: Date.now() }
      _findMissingInFlight = null
      console.error(`[slack] ${logPrefix}: findMissing sweep for ${ref} — count=${r.count} ids=[${r.ids.join(',')}] unverified=${r.unverified} unverified_ids=[${r.unverified_ids.join(',')}]`)
    }
  } catch (err) {
    // Do NOT memoize failures — clear the in-flight slot so the next caller
    // retries. Log and let the caller proceed with today's behavior.
    if (_findMissingInFlight === inFlight) {
      _findMissingInFlight = null
    }
    const e = err instanceof AgentDirectorError ? err : new AgentDirectorError('findMissing', 'UnknownError', String(err))
    console.error(`[slack] ${logPrefix}: findMissing sweep failed for ${ref}: ${describeAgentDirectorFailure(e)} — proceeding`)
  }
}

/**
 * b.sv7 / Epic t1.tkk.e4: the escalate-dead → internal-sweep entry point, and
 * the single reusable place for it (b.4vj will add a second retry driver that
 * hits dead-tmux and must share this exact logic — do NOT inline the sweep at
 * another call site).
 *
 * When the tick/restart path decides a persona's tmux session is provably dead
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
 * @param key the dead-tmux persona's key (log context; the sweep itself is
 *   whole-store, so one in-flight sweep serves the fleet — b.nk5).
 * @param verdict the verdict/context fragment for the log line (e.g. 'dead-session').
 */
export async function sweepDeadTmuxChannel(key: string, verdict: string): Promise<void> {
  console.error(
    `[slack] escalate-dead: ${keyRef(key)} verdict=${verdict} — tmux session provably dead, triggering internal findMissing reconciliation (next tick relaunches; ~/startup/find-missing-loop.sh is belt-and-braces)`,
  )
  await reconcileMissingSweep(key, 'escalate-dead')
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
  ref: string,
  reason: string,
): Promise<ReconnectOutcome> {
  if (await _hasTmuxSession(sessionName)) {
    console.error(
      `[slack] waitForWaitingAndReconnect: timed out for ${ref} after ${_waitForWaitingTimeoutMs}ms — ${reason}, tmux session alive, health-check will reconnect it (b.9a7): during an AD outage the adapter reports alive=false and the tick restarts it; once AD recovers with the row live, the tick sees alive && !connected -> scheduleRestart -> reconnect`,
    )
    return 'ok'
  }
  console.error(
    `[slack] waitForWaitingAndReconnect: timed out for ${ref} after ${_waitForWaitingTimeoutMs}ms — ${reason} and tmux session "${sessionName}" is gone — dead session`,
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
  key: string,
  config: PersonaConfig,
  ref: string = keyRef(key),
): Promise<ReconnectOutcome> {
  const claude_instance_id = personaInstanceId(key)
  const sessionName = personaTmuxSessionName(key)
  const pollIntervalMs = config.agent_director_poll_interval_ms
  const deadline = Date.now() + _waitForWaitingTimeoutMs

  // b.m4r: a bot killed mid-turn never fires SessionEnd, so its AD row freezes
  // at `working`. Without a reconcile, the poll below spins on `status` for the
  // full 10-minute window before the timeout branch's sweep + status finally
  // decides — the persona stays down that whole time. Run AD's per-row,
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
  await reconcileMissingSweep(key, 'waitForWaitingAndReconnect', ref)

  while (Date.now() < deadline) {
    let state: string
    try {
      const r = await withOutageDetection(key, undefined, (client) => client.status({ claude_instance_id }))
      state = r.state
    } catch (err) {
      if (err instanceof ErrSpawnNotFound) {
        // b.c3o: spawn-not-found means the AD row is gone — same class as
        // `missing`. Only the tmux session's actual existence decides the
        // verdict, mirroring the timeout branch's own ErrSpawnNotFound
        // sub-branch below.
        if (await _hasTmuxSession(sessionName)) {
          console.error(`[slack] waitForWaitingAndReconnect: spawn not found for ${ref} but tmux session alive — aborting poll (health-check will handle)`)
          return 'ok'
        }
        console.error(`[slack] waitForWaitingAndReconnect: spawn not found for ${ref} and tmux session "${sessionName}" is gone — dead session`)
        return 'dead-session'
      }
      if (err instanceof ErrSystemInstallDisappeared || err instanceof ErrTmuxNotAvailable) {
        return 'failed'
      }
      const e = err instanceof AgentDirectorError ? err : new AgentDirectorError('status', 'UnknownError', String(err))
      console.error(`[slack] waitForWaitingAndReconnect: status error for ${ref}: ${describeAgentDirectorFailure(e)}`)
      notifySpawnFailure(key, e)
      return 'failed'
    }

    if (state === 'waiting') {
      return reconnectMcp(key, ref)
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
    // persona to the health-check for minutes.) Live transient states
    // (ask_user, check_permission, pending) still fall through to 'ok' below.
    if (state === 'ended' || state === 'missing') {
      console.error(`[slack] waitForWaitingAndReconnect: ${ref} transitioned to state=${state} (claude process gone) — dead session`)
      return 'dead-session'
    }

    console.error(`[slack] waitForWaitingAndReconnect: ${ref} transitioned to state=${state} — aborting; health-check reconnects it (tick sees alive && !connected -> scheduleRestart -> reconnect, b.9a7)`)
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
  await reconcileMissingSweep(key, 'waitForWaitingAndReconnect: timeout', ref)
  let timeoutState: string
  try {
    const r = await withOutageDetection(key, undefined, (client) => client.status({ claude_instance_id }))
    timeoutState = r.state
  } catch (err) {
    if (err instanceof ErrSpawnNotFound) {
      return tmuxFallbackVerdict(sessionName, ref, 'spawn not found')
    }
    // Any other status error — including ErrSystemInstallDisappeared /
    // ErrTmuxNotAvailable, which the poll loop returns 'failed' for. At the
    // timeout deadline a probe-based verdict is deliberately preferred: it's
    // safe (probe-alive → 'ok' preserves the b.rmy invariant that only a
    // provably-gone session goes 'dead-session') and simpler than propagating
    // 'failed' through here.
    const e = err instanceof AgentDirectorError ? err : new AgentDirectorError('status', 'UnknownError', String(err))
    return tmuxFallbackVerdict(sessionName, ref, `status error ${describeAgentDirectorFailure(e)}`)
  }

  if (timeoutState === 'ended' || timeoutState === 'missing') {
    console.error(
      `[slack] waitForWaitingAndReconnect: timed out for ${ref} after ${_waitForWaitingTimeoutMs}ms — claude process state=${timeoutState} (gone) — dead session`,
    )
    return 'dead-session'
  }
  console.error(
    `[slack] reconnect: gave up waiting for ${ref} after ${_waitForWaitingTimeoutMs}ms — claude process state=${timeoutState} (alive), health-check will reconnect (tick sees alive && !connected -> scheduleRestart -> reconnect, b.9a7)`,
  )
  return 'ok'
}

// ---------------------------------------------------------------------------
// spawnForPersona — SR-1.4 collision-then-act dispatcher
// ---------------------------------------------------------------------------

export interface SpawnPersonaResult {
  /** Persona key. */
  key: string
  action:
    | 'spawned'
    | 'resumed'
    | 'reconnected'
    | 'no-op'
    | 'failed'
    | 'fresh-after-amnesia'
    | 'fresh-after-inconclusive-amnesia'
    /**
     * Not launched: the persona's claude_config_dir cannot be resolved to a
     * real path (bug b.g57). No agent-director call was made and its row is
     * untouched; the bring-up controller holds the persona `retrying` until
     * the directory resolves. Not a failure: `launchSession` maps it to
     * `'skipped'`, so it counts toward no restart failure or cap.
     */
    | 'deferred'
  /** For `deferred`: the claude_config_dir cause (`claude-config-dir` step). */
  deferredBy?: PersonaBringUpFailure
}

// ---------------------------------------------------------------------------
// Pre-launch claude_config_dir check (bug b.g57)
// ---------------------------------------------------------------------------

/**
 * Realpath and lstat overrides for resolving a persona's claude_config_dir on
 * the launch path: the pre-launch check, the spawn label and the ladder's
 * `config_dir` comparison. `undefined` means the real file system.
 */
let _configDirFs: Partial<StrictRealPathFs> | undefined

/** Test-only seam: resolve every persona's claude_config_dir on the launch path through `fs`. */
export function _setConfigDirFs(fs: Partial<StrictRealPathFs>): void {
  _configDirFs = fs
}

/** Test-only seam: restore the real file system for the claude_config_dir resolution. */
export function _resetConfigDirFs(): void {
  _configDirFs = undefined
}

/**
 * The launch path's check of a persona's claude_config_dir (bug b.g57):
 * `checkPersonaConfigDir` against the spawn home and the file-system seam, so
 * the check, the spawn label and the ladder's comparison resolve the
 * directory the same way. Production also injects it into the bring-up
 * controller as its re-check. Never throws.
 */
export function checkLaunchConfigDir(persona: Persona): ConfigDirCheckResult {
  return checkPersonaConfigDir(persona, { home: spawnHomeDir(), fs: _configDirFs })
}

/**
 * Told when a launch finds a persona's claude_config_dir unresolvable; returns
 * whether it holds the persona (production: the bring-up controller's
 * `holdForConfigDir`, which logs the failure line once per episode and
 * re-checks on the persona's own timer).
 */
export type ConfigDirUnresolvableHook = (persona: Persona, failure: PersonaCheckFailure) => boolean

/**
 * The one hook, installed like the pre-launch reply guard. With none installed
 * (unit tests, the integration driver), or when it does not hold the persona,
 * the failure line is logged here, on every attempt.
 */
let configDirUnresolvableHook: ConfigDirUnresolvableHook | undefined

/** Install (or, with undefined, remove) the unresolvable-claude_config_dir hook (production: `server.ts`). */
export function setConfigDirUnresolvableHook(hook: ConfigDirUnresolvableHook | undefined): void {
  configDirUnresolvableHook = hook
}

/** Hand an unresolvable claude_config_dir to the hook; log its line when nothing holds the persona. Never throws. */
function deferLaunchForConfigDir(persona: Persona, failure: PersonaCheckFailure): void {
  let held = false
  if (configDirUnresolvableHook) {
    try {
      held = configDirUnresolvableHook(persona, failure)
    } catch (err) {
      console.error(
        `[slack] spawnForPersona: holding ${personaRef(persona)} for its claude_config_dir failed: ${describeThrownValue(err)}`,
      )
    }
  }
  if (!held) console.error(failure.line)
}

/** The `deferred` result for a persona whose claude_config_dir cannot be resolved. */
function deferredResult(persona: Persona, failure: PersonaCheckFailure): SpawnPersonaResult {
  return { key: persona.key, action: 'deferred', deferredBy: { step: 'claude-config-dir', class: failure.class, cause: failure.cause } }
}

/**
 * Before a path that would touch the persona's instance ahead of its launch
 * (the restart module's kill adapter): check its claude_config_dir and, when
 * it cannot be resolved, hand it to the hook as a launch would and return
 * true, so the caller leaves the instance and its row alone. False when the
 * directory resolves. Makes no agent-director call.
 */
export function holdLaunchIfConfigDirUnresolvable(persona: Persona): boolean {
  return deferIfConfigDirUnresolvable(persona) !== undefined
}

/**
 * Check the persona's claude_config_dir; when it cannot be resolved, hand it
 * to the hook as a launch would and return the `deferred` result with its
 * cause (`deferredBy`), as the pre-launch check does. Undefined when the
 * directory resolves.
 */
function deferIfConfigDirUnresolvable(persona: Persona): SpawnPersonaResult | undefined {
  const check = checkLaunchConfigDir(persona)
  if (check.ok) return undefined
  deferLaunchForConfigDir(persona, check)
  return deferredResult(persona, check)
}

/**
 * Home directory the spawn path resolves an unset claude_config_dir against
 * (`<home>/.claude`) when computing the `config_dir` label. `undefined` means
 * the OS home, read at spawn time.
 */
let _spawnHomeDir: string | undefined

/** Test-only seam: resolve the spawn `config_dir` label against `home`. */
export function _setSpawnHomeDir(home: string): void {
  _spawnHomeDir = home
}

/** Test-only seam: restore the OS home for the spawn `config_dir` label. */
export function _resetSpawnHomeDir(): void {
  _spawnHomeDir = undefined
}

/**
 * Home directory for `config_dir` label values: the test seam's home when set,
 * else the OS home, read at call time. Used by the spawn labels and by every
 * row comparison, so both derive the label from the same home.
 */
function spawnHomeDir(): string {
  return _spawnHomeDir ?? homedir()
}

/**
 * Build SpawnParams for a persona (SR-1.1, b.av2 SR-2.2): instance ID, tmux
 * session name, labels and env from E1's persona-identity functions, `cwd`
 * set to the persona's working directory.
 *
 * `CLAUDE_CONFIG_DIR` carries the persona's effective claude_config_dir exactly
 * as configured and is absent when none is; the `config_dir` label is
 * `configDirLabel`, the hash of its real path from the launch's pre-launch
 * check (`checkLaunchConfigDir`), never of its lexical path (bug b.g57).
 *
 * extra_env unconditionally carries CSCB_CRONTABLE_PATH (the resolved,
 * tilde-expanded, absolute cron_table_path from the config) so bots can
 * locate the self-documenting crontable from the env var alone — no config
 * file lookup needed (D-Q2, b.grx decision 3).
 */
function buildSpawnParams(persona: Persona, config: PersonaConfig, configDirLabel: string): SpawnParams {
  const { key } = persona
  return {
    template: TEMPLATE_NAME,
    cwd: persona.working_directory,
    claude_instance_id: personaInstanceId(key),
    relay_mode: 'on',
    tmux_session_name: personaTmuxSessionName(key),
    label: [
      SERVICE_LABEL,
      `${PERSONA_LABEL_PREFIX}${key}`,
      `${CONFIG_DIR_LABEL_PREFIX}${configDirLabel}`,
    ],
    extra_env: personaSpawnEnv({
      key,
      crontablePath: config.cron_table_path,
      claudeConfigDir: persona.claude_config_dir,
    }),
  }
}

/**
 * Kill persona `key`'s instance (`cscb_<key>`) through `withOutageDetection`,
 * quietly: logs nothing, records no startup error and raises no notice of its
 * own (the wrapper still raises or clears the key's outage flags). Resolves
 * true when the row was there, false when it was already gone
 * (`ErrSpawnNotFound` counts as success); rethrows every other error for the
 * caller to report. For the persona teardown (b.av2 SR-6.5).
 */
export async function killPersonaInstance(key: string): Promise<boolean> {
  try {
    await withOutageDetection(key, undefined, (client) => client.kill({ claude_instance_id: personaInstanceId(key) }))
    return true
  } catch (err) {
    if (err instanceof ErrSpawnNotFound) return false
    throw err
  }
}

/** Delete persona `key`'s row (`cscb_<key>`) through `withOutageDetection`; rethrows every error. */
function deleteInstanceRow(key: string): Promise<unknown> {
  return withOutageDetection(key, undefined, (client) => client.delete({ claude_instance_id: [personaInstanceId(key)] }))
}

/**
 * Delete persona `key`'s agent-director row (`cscb_<key>`) through
 * `withOutageDetection`, quietly, as `killPersonaInstance` kills it: true when
 * the row was there, false when it was already gone (`ErrSpawnNotFound`);
 * every other error is rethrown. Unlike the collision ladder's delete, a
 * failure records no startup error and raises no spawn-failure notice. For
 * the persona teardown (b.av2 SR-6.5).
 */
export async function deletePersonaInstance(key: string): Promise<boolean> {
  try {
    await deleteInstanceRow(key)
    return true
  } catch (err) {
    if (err instanceof ErrSpawnNotFound) return false
    throw err
  }
}

/** Best-effort kill — never throws. */
async function tryKill(key: string): Promise<void> {
  try {
    await killPersonaInstance(key)
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
 * per-persona name (`personaTmuxSessionName`) is the only reliable reap, and the
 * name can only ever belong to this persona's spawn, so it is safe.
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
  persona: Persona,
  params: SpawnParams,
  ref: string,
): Promise<{ claude_instance_id: string }> {
  const { key } = persona
  const sessionName = personaTmuxSessionName(key)
  console.error(
    `[slack] spawnForPersona: ErrTmuxSessionCreate for ${ref} — killing orphan tmux session "${sessionName}" and retrying spawn once`,
  )
  await _killTmuxSession(sessionName)
  return launchWithReplyGuard(persona, ref, (client) => client.spawn(params))
}

/** Delete the spawn row; surface failures. Returns whether the delete succeeded. */
async function tryDelete(
  key: string,
  isStartup: boolean,
  ref: string,
): Promise<boolean> {
  try {
    await deleteInstanceRow(key)
    return true
  } catch (err) {
    if (err instanceof ErrSystemInstallDisappeared || err instanceof ErrTmuxNotAvailable) {
      return false
    }
    const e = err instanceof AgentDirectorError ? err : new AgentDirectorError('delete', 'UnknownError', String(err))
    console.error(`[slack] tryDelete: failed for ${ref}: ${describeAgentDirectorFailure(e)}`)
    if (isStartup) recordStartupError('spawn-failed', `delete failed for ${ref}: ${describeAgentDirectorFailure(e)}`)
    notifySpawnFailure(key, e, isStartup)
    return false
  }
}

/**
 * Replace the persona's row with a fresh spawn: kill it (best effort, when
 * `kill` is set, for a row that may still be live), delete it, spawn fresh
 * and run dialog approval. The collision ladder's kill+delete+fresh paths go
 * through here: `resume_enabled: false`, a row whose `cwd` differs from the
 * working directory (b.av2 SR-6.2), and a row whose `config_dir` label is
 * missing or differs before a resume.
 *
 * - A failed delete returns `failed` (tryDelete records `spawn-failed` at
 *   startup and raises the spawn-failure notice).
 * - `ErrTmuxSessionCreate` on the fresh spawn takes the b.vub self-heal
 *   (kill the orphan tmux session by name, retry the spawn once).
 * - Outage-class and cwd errors return `failed` quietly; any other error
 *   records `spawn-failed` at startup and raises the spawn-failure notice.
 * - Success returns `spawned`.
 */
async function replaceWithFreshSpawn(
  persona: Persona,
  params: SpawnParams,
  isStartup: boolean,
  ref: string,
  opts: { kill: boolean },
): Promise<SpawnPersonaResult> {
  const { key } = persona
  if (opts.kill) await tryKill(key)
  if (!(await tryDelete(key, isStartup, ref))) return { key, action: 'failed' }

  const failed = (err: unknown, what: string): SpawnPersonaResult => {
    if (
      err instanceof ErrSystemInstallDisappeared ||
      err instanceof ErrTmuxNotAvailable ||
      err instanceof ErrCwdNotFound ||
      err instanceof ErrCwdNotADirectory
    ) {
      return { key, action: 'failed' }
    }
    const e = err instanceof AgentDirectorError ? err : new AgentDirectorError('spawn', 'UnknownError', String(err))
    console.error(`[slack] spawnForPersona: ${what} failed for ${ref}: ${describeAgentDirectorFailure(e)}`)
    if (isStartup) recordStartupError('spawn-failed', `${what} failed for ${ref}: ${describeAgentDirectorFailure(e)}`)
    notifySpawnFailure(key, e, isStartup)
    return { key, action: 'failed' }
  }

  try {
    await launchWithReplyGuard(persona, ref, (client) => client.spawn(params))
    console.error(`[slack] spawnForPersona: fresh-spawned (after ${opts.kill ? 'kill+delete' : 'delete'}) for ${ref}`)
    await approvePreSessionDialogs(key, isStartup, ref)
    return { key, action: 'spawned' }
  } catch (err) {
    if (!(err instanceof ErrTmuxSessionCreate)) return failed(err, 'fresh spawn after delete')
  }
  try {
    const r = await selfHealTmuxCollisionAndRespawn(persona, params, ref)
    console.error(`[slack] spawnForPersona: self-heal spawn succeeded after ErrTmuxSessionCreate for ${ref} instanceId=${r.claude_instance_id}`)
    await approvePreSessionDialogs(key, isStartup, ref)
    return { key, action: 'spawned' }
  } catch (err2) {
    return failed(err2, 'self-heal spawn after ErrTmuxSessionCreate')
  }
}

// ---------------------------------------------------------------------------
// ErrJsonlMissing diagnostic (bug b.wrb)
// ---------------------------------------------------------------------------

/** The source tokens agent-director stamps on each candidate it stat'd
 *  (AD's `jsonlAttempt.source`): the persisted jsonl_path column, the
 *  CLAUDE_CONFIG_DIR-aware recomputed fallback, and archived session_history
 *  entries. Kept as the literal token set AD emits — never a version check. */
type AdJsonlCandidateSource = 'persisted' | 'fallback' | 'history'

/** Single source of truth for the tokens the candidate parser anchors on. */
const AD_JSONL_CANDIDATE_SOURCES: readonly AdJsonlCandidateSource[] = [
  'persisted',
  'fallback',
  'history',
]

/** One transcript candidate resume tried (or that we recomputed locally). */
interface JsonlCandidate {
  /** Provenance as reported by AD (see AdJsonlCandidateSource), or a
   *  'locally-computed(…)' label when we reconstructed it ourselves because
   *  AD's message lacked detail. */
  source: string
  path: string
  /** The stat error AD reported, or our own local stat result label. */
  note: string
}

/**
 * Best-effort parse of an ErrJsonlMissing description into the candidate list
 * AD enumerates as `<source> <path> (<stat error>)`, joined by "; ".
 *
 * Returns [] when the description does not carry the enumerated detail — the
 * case for any AD whose ErrJsonlMissing message predates the per-candidate
 * enumeration delivered by AD bug b.1ba. Callers MUST treat [] as "AD gave no
 * path detail" and degrade to locally-computed candidates, never as "no paths".
 *
 * Strictly non-throwing and version-agnostic: it keys off the literal
 * `persisted` / `fallback` / `history` source tokens, not any version string.
 * An AD that emits only a subset of those tokens simply yields fewer matches.
 */
function parseJsonlMissingCandidates(description: string): JsonlCandidate[] {
  if (!description) return []
  const out: JsonlCandidate[] = []
  // AD renders each attempt as: `<source> <path> (<stat error>)`.
  // Anchor on the known source tokens so unrelated prose is ignored.
  const re = new RegExp(
    `(${AD_JSONL_CANDIDATE_SOURCES.join('|')})\\s+(\\S+)\\s+\\(([^)]*)\\)`,
    'g',
  )
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
  persona: Persona,
  config: PersonaConfig,
  err: ErrJsonlMissing,
  isStartup: boolean,
): Promise<'lost' | 'never-created' | 'inconclusive'> {
  const { key } = persona
  const ref = personaRef(persona)
  // --- 1. What paths did AD try, and from where? -------------------------
  // err.errDescription is AD's detail string. The rich format (AD b.1ba,
  // shipped in v0.10.0) enumerates `<source> <path> (<err>)`; pre-b.1ba ADs do
  // not. Parse defensively — [] means "no AD detail", not "no paths".
  const adCandidates = parseJsonlMissingCandidates(err.errDescription ?? '')

  // --- 2. Fetch the row we are about to delete (best-effort). -------------
  const claudeInstanceId = personaInstanceId(key)
  let row: GetResult | undefined
  try {
    row = await withOutageDetection(key, undefined, (client) =>
      client.get({ claude_instance_id: claudeInstanceId }),
    )
  } catch (getErr) {
    // (a) Row already gone / AD unreachable — cannot enrich or classify.
    // Inconclusive: we could not consult the row at all, so we do NOT know
    // whether history was lost. Report it as uncertainty, not reassurance.
    const adDetail = adCandidates.length
      ? adCandidates.map((c) => `${c.source} ${c.path} (${c.note})`).join('; ')
      : redactSlackLogText(err.errDescription || '(no path detail from agent-director)')
    reportInconclusiveDiagnosis(
      key,
      ref,
      claudeInstanceId,
      `could not fetch the agent-director row (${describeAgentDirectorFailure(getErr)}); AD reported: ${adDetail}`,
      isStartup,
      err,
    )
    return 'inconclusive'
  }

  // --- 3. Assemble the candidate list to log. ----------------------------
  // The persona's effective claude_config_dir (per-persona, else top-level);
  // undefined makes resolveJsonlPath use the home-directory default.
  const effectiveConfigDir = persona.claude_config_dir
  const candidates: JsonlCandidate[] = [...adCandidates]

  if (adCandidates.length === 0) {
    // pre-b.1ba / shape-mismatch path: AD gave no enumerated detail.
    // Reconstruct what WE can, clearly labelled as locally computed — never
    // claim it is what AD tried.
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
      : 'agent-director gave no path detail (pre-b.1ba message shape); paths below are locally computed'

  // --- 4. Classify never-created vs lost via message-archive evidence. ----
  // Reuse b.zak's archive-count helper (message_archive_db, read-only, absent
  // file → null == no evidence). started_at bounds "since spawn".
  const startedAtEpoch = row.started_at ? rfc3339ToEpochSeconds(row.started_at) : null
  // b.av2 SR-7.4: count only the persona's `delivery: all` channels; a zero
  // count is evidence of idleness only when the archive can see all of the
  // persona's traffic (no `mentions` channel, DMs off).
  const scope = personaArchiveEvidenceScope(persona)
  const archiveCount = makeDefaultArchiveCount(config)
  const archivedSinceSpawn =
    startedAtEpoch === null ? null : archiveCount(scope.channelIds, startedAtEpoch, ref)

  if (archivedSinceSpawn !== null && archivedSinceSpawn > 0) {
    // LOST: conversation provably happened since spawn, yet no transcript
    // survives. Real context destroyed — must be operator-visible.
    const detail =
      `${ref} instance=${claudeInstanceId}: resume threw ErrJsonlMissing and the row will be ` +
      `deleted + fresh-spawned, but the message archive holds ${archivedSinceSpawn} message(s) since spawn ` +
      `(started_at=${row.started_at}). Conversation history was LOST. Transcript candidates tried ` +
      `(${detailProvenance}): ${candidateStr}.`
    console.error(`[slack] ErrJsonlMissing diagnostic: ${detail}`)
    // Operator-visible signal — reuse the existing startup-errors mechanism.
    if (isStartup) recordStartupError('jsonl-transcript-lost-on-resume', detail, describeAgentDirectorFailure(err))
    // And a persona notice so it is not buried in logs.
    sendPersonaNotice(
      key,
      `⚠️ CSCB: on restart my conversation transcript could not be found, but the message archive shows ` +
        `${archivedSinceSpawn} message(s) since I started — my conversation memory has been lost and I ` +
        `was started fresh. An operator should investigate transcript storage. Paths tried: ${candidateStr}`,
    )
    return 'lost'
  }

  // Below archivedSinceSpawn is 0 or null. Only an attributable 0 (archive
  // consulted, no activity since spawn in channels that carry all of the
  // persona's traffic) is evidence-based never-created. null means we never got
  // a usable count, and an unattributable 0 proves nothing — both are
  // INCONCLUSIVE, not reassurance.
  if (archivedSinceSpawn === 0 && scope.zeroIsAttributable) {
    // NEVER-CREATED (evidence-based): the archive was consulted and proved zero
    // archived activity since spawn. Claude writes the .jsonl lazily on first
    // message; a persona idle since spawn simply never had one. Expected and
    // lossless — quiet log, no error, no persona notice, counted as an ordinary
    // fresh-spawn.
    console.error(
      `[slack] ErrJsonlMissing diagnostic: ${ref} instance=${claudeInstanceId} — transcript never ` +
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
  //   (d) b.av2 SR-7.4: a 0 count the archive cannot attribute to the persona.
  let reason: string
  if (startedAtEpoch === null) {
    reason =
      `the row's started_at is absent or unparseable (started_at=${row.started_at ?? '(none)'}), ` +
      `so "since spawn" could not be bounded and the archive was not consulted`
  } else if (archivedSinceSpawn === 0) {
    reason = UNATTRIBUTABLE_ZERO_REASON
  } else if (!config.message_archive_db) {
    reason =
      `no message archive is configured (message_archive_db unset), so there is no evidence source to ` +
      `consult — enable the message archive to make transcript-loss diagnosis possible`
  } else {
    reason =
      `the message archive (${config.message_archive_db}) could not be consulted (missing file, ` +
      `unreadable, or the count query failed) — see prior archive-count error line`
  }
  reportInconclusiveDiagnosis(
    key,
    ref,
    claudeInstanceId,
    `${reason}. Transcript candidates tried (${detailProvenance}): ${candidateStr}`,
    isStartup,
    err,
  )
  return 'inconclusive'
}

/**
 * Token-safe description of a failed agent-director call, for a log line, a
 * startup-error record (passed instead of the error itself) or a line that is
 * also posted as a persona notice: a typed agent-director error's `errName`
 * when it is a short identifier, then its `errDescription` as `message="…"`
 * (`describeLogMessage`: through `redactSlackLogText`, on one line, capped at
 * `MAX_LOGGED_MESSAGE_LENGTH` characters) when it has one; else
 * `describeThrownValue` of the thrown value, which renders the message the
 * same way. Never the raw error object.
 */
function describeAgentDirectorFailure(err: unknown): string {
  if (err instanceof AgentDirectorError && isSafeIdentifier(err.errName)) {
    const message = describeLogMessage(err.errDescription)
    return message === '' ? err.errName : `${err.errName} ${message}`
  }
  return describeThrownValue(err)
}

/**
 * b.fwu: emit the operator-visible signal for an INCONCLUSIVE ErrJsonlMissing
 * diagnosis — one where we could not determine whether prior history was lost.
 * Follows the 'lost' branch's pattern (recordStartupError guarded by isStartup
 * + a persona notice), but worded as UNCERTAINTY, not loss: a false "your history
 * was destroyed" is its own harm. Never throws.
 */
function reportInconclusiveDiagnosis(
  key: string,
  ref: string,
  claudeInstanceId: string,
  reason: string,
  isStartup: boolean,
  err: ErrJsonlMissing,
): void {
  const detail =
    `${ref} instance=${claudeInstanceId}: resume threw ErrJsonlMissing and the row will be ` +
    `deleted + fresh-spawned, but diagnosis was INCONCLUSIVE — could not determine whether conversation ` +
    `history was lost because ${reason}.`
  console.error(`[slack] ErrJsonlMissing diagnostic: ${detail}`)
  if (isStartup) recordStartupError('jsonl-diagnosis-inconclusive', detail, describeAgentDirectorFailure(err))
  sendPersonaNotice(
    key,
    `⚠️ CSCB: on restart I was started fresh; I could not determine whether my prior ` +
      `conversation history was preserved (diagnosis inconclusive: ${reason}). An operator should ` +
      `investigate.`,
  )
}

/**
 * Recover a collided spawn whose live session cannot be reached: resume-first
 * (preserves session history) when resume_enabled, with the established
 * fallbacks (ErrTmuxSessionCreate → orphan-kill + respawn; ErrNoSessionId /
 * ErrJsonlMissing / ErrJsonlNeverWritten → delete + fresh; ErrSpawnNotResumable → kill + delete +
 * fresh; ErrSpawnNotFound → fresh, no delete since the row is already gone).
 * This is the `ended`/`missing` state handling, extracted so the
 * b.3ce dead-session fallback in the `waiting`/`working` branches reuses the
 * exact same decision logic instead of inventing its own.
 *
 * b.av2 SR-6.2 `config_dir` guard: before the `resume` call (after the
 * reconcile-missing-first sweep), the row's `config_dir` label — captured by
 * the collision `get` when the ladder started — is compared with the
 * persona's current effective claude_config_dir through
 * `compareRowToPersona`. A resume keeps the old `CLAUDE_CONFIG_DIR`, so a
 * missing or different label means no resume: kill (on the dead-session
 * paths, whose row may still be live), delete and spawn fresh, outcome
 * `spawned`. No transcript was lost (it stays in the old directory), so no
 * JSONL diagnosis or amnesia action runs. `resume_enabled: false` never
 * reaches the guard: it already kills, deletes and spawns fresh.
 *
 * @param row  The row returned by the collision `get` (its `labels`).
 */
async function resumeOrFreshSpawn(
  persona: Persona,
  params: SpawnParams,
  config: PersonaConfig,
  isStartup: boolean,
  row: Pick<GetResult, 'cwd' | 'labels'>,
  opts?: { reconcileMissingFirst?: boolean },
): Promise<SpawnPersonaResult> {
  const { key } = persona
  const ref = personaRef(persona)
  if (config.resume_enabled === false) {
    console.error(`[slack] spawnForPersona: resume_enabled=false — kill+delete+fresh for ${ref}`)
    return replaceWithFreshSpawn(persona, params, isStartup, ref, { kill: true })
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
    await reconcileMissingSweep(key, 'spawnForPersona: before resume', ref)
  }

  // b.av2 SR-6.2: a resume keeps the row's old CLAUDE_CONFIG_DIR, so resume
  // only a row labelled with the persona's current effective config dir.
  const configDir = compareRowToPersona(row, persona, spawnHomeDir(), undefined, _configDirFs)
  if (!configDir.configDirResolved) {
    // Bug b.g57: the directory stopped resolving since this ladder's
    // pre-launch check. No verdict, so no replacement: keep the row and
    // launch nothing; the hold re-checks and launches once it resolves.
    const deferred = deferIfConfigDirUnresolvable(persona)
    if (deferred !== undefined) return deferred
    // It resolved again between the comparison and the re-check: nothing
    // holds it, and its next restart or health tick launches it.
    console.error(
      `[slack] spawnForPersona: ${ref} claude_config_dir could not be resolved during the launch — keeping its row; not launching`,
    )
    return { key, action: 'deferred' }
  }
  if (!configDir.configDirMatches) {
    const was = configDir.configDirLabel === undefined ? 'label absent' : `was=${configDir.configDirLabel}`
    console.error(
      `[slack] spawnForPersona: ${ref} config_dir label ${configDir.configDirLabel === undefined ? 'missing' : 'changed'} ` +
        `(${was}, now=${configDir.expectedConfigDirLabel} for claude_config_dir=${persona.claude_config_dir ?? '<default>'}) — ` +
        `not resuming; spawning fresh`,
    )
    return replaceWithFreshSpawn(persona, params, isStartup, ref, { kill: opts?.reconcileMissingFirst === true })
  }

  // resume_enabled: attempt resume
  console.error(`[slack] spawnForPersona: attempting resume for ${ref}`)
  try {
    await launchWithReplyGuard(persona, ref, (client) => client.resume({ claude_instance_id: personaInstanceId(key) }))
    console.error(`[slack] spawnForPersona: resumed ${ref}`)
    // b.vub: a resumed bot faces the same --dangerously-load-development-channels
    // dialog. Its AD row is still `missing`/`ended` while blocked at the dialog
    // (SessionStart hasn't re-fired), so the pane-first approver drives it past.
    await approvePreSessionDialogs(key, isStartup, ref)
    return { key, action: 'resumed' }
  } catch (err) {
    if (err instanceof ErrTmuxSessionCreate) {
      // b.vub: the deterministic tmux session name is still held by an orphan
      // session while the AD row is terminal — resume cannot re-create it.
      // This is the observed field failure (resume throws ErrTmuxSessionCreate
      // every ~2 min). Self-heal: kill the orphan by name, retry spawn once.
      try {
        const r = await selfHealTmuxCollisionAndRespawn(persona, params, ref)
        console.error(`[slack] spawnForPersona: self-heal spawn succeeded after ErrTmuxSessionCreate for ${ref} instanceId=${r.claude_instance_id}`)
        await approvePreSessionDialogs(key, isStartup, ref)
        return { key, action: 'spawned' }
      } catch (err2) {
        if (
          err2 instanceof ErrSystemInstallDisappeared ||
          err2 instanceof ErrTmuxNotAvailable ||
          err2 instanceof ErrCwdNotFound ||
          err2 instanceof ErrCwdNotADirectory
        ) {
          return { key, action: 'failed' }
        }
        const e = err2 instanceof AgentDirectorError ? err2 : new AgentDirectorError('spawn', 'UnknownError', String(err2))
        console.error(`[slack] spawnForPersona: self-heal spawn after ErrTmuxSessionCreate failed for ${ref}: ${describeAgentDirectorFailure(e)}`)
        if (isStartup) recordStartupError('spawn-failed', `self-heal spawn after ErrTmuxSessionCreate failed for ${ref}: ${describeAgentDirectorFailure(e)}`)
        notifySpawnFailure(key, e, isStartup)
        return { key, action: 'failed' }
      }
    }
    if (err instanceof ErrNoSessionId || err instanceof ErrJsonlMissing || err instanceof ErrJsonlNeverWritten) {
      console.error(`[slack] spawnForPersona: ${describeAgentDirectorFailure(err)} on resume for ${ref} — delete+fresh`)
      // b.jgf: AD 0.10.0 split the old "no transcript" condition in two.
      // ErrJsonlNeverWritten asserts the session never wrote a transcript at
      // all, so a fresh spawn is lossless BY DEFINITION — it gets no diagnosis
      // ceremony, no amnesia action and no persona notice, just the delete+fresh
      // below and a successful action so restart.ts stops retrying. Only
      // ErrJsonlMissing (a transcript path was recorded but is not there now)
      // carries the ambiguity that the b.wrb/b.fwu machinery exists to resolve.
      // b.wrb: diagnose the missing transcript BEFORE deleting the row (its
      // jsonl_path / session id / started_at are needed). Logging/classification
      // only — the delete+fresh POLICY below is unchanged. The 'lost' case is
      // made operator-visible inside diagnoseJsonlMissing itself.
      let jsonlDiagnosis: 'lost' | 'never-created' | 'inconclusive' | undefined
      if (err instanceof ErrJsonlMissing) {
        jsonlDiagnosis = await diagnoseJsonlMissing(persona, config, err, isStartup)
      }
      if (!(await tryDelete(key, isStartup, ref))) return { key, action: 'failed' }
      try {
        await launchWithReplyGuard(persona, ref, (client) => client.spawn(params))
        console.error(`[slack] spawnForPersona: fresh-spawned (after delete) for ${ref}`)
        await approvePreSessionDialogs(key, isStartup, ref)
        // A fresh-spawn that replaced a resume because the transcript was gone
        // is amnesia, not a clean spawn — surface it as its own action so the
        // startup summary does not count it as an ordinary "ok". b.fwu: split
        // the amnesia into two actions by diagnosis. 'lost' and 'never-created'
        // are DIAGNOSED amnesia (we know whether history was destroyed —
        // 'lost' was already made loud above, 'never-created' is evidence-based
        // lossless). 'inconclusive' is UNDIAGNOSABLE amnesia: we could not tell
        // whether we destroyed anything, which is itself operator-worthy and
        // must not be lumped with the known-cause cases. ErrNoSessionId and
        // b.jgf's ErrJsonlNeverWritten fall through to plain 'spawned': no
        // history existed to lose, so counting them as amnesia would overstate
        // the damage in the startup summary.
        if (err instanceof ErrJsonlMissing) {
          return {
            key,
            action:
              jsonlDiagnosis === 'inconclusive'
                ? 'fresh-after-inconclusive-amnesia'
                : 'fresh-after-amnesia',
          }
        }
        return { key, action: 'spawned' }
      } catch (err2) {
        if (
          err2 instanceof ErrSystemInstallDisappeared ||
          err2 instanceof ErrTmuxNotAvailable ||
          err2 instanceof ErrCwdNotFound ||
          err2 instanceof ErrCwdNotADirectory
        ) {
          return { key, action: 'failed' }
        }
        const e = err2 instanceof AgentDirectorError ? err2 : new AgentDirectorError('spawn', 'UnknownError', String(err2))
        console.error(`[slack] spawnForPersona: fresh spawn after delete failed for ${ref}: ${describeAgentDirectorFailure(e)}`)
        if (isStartup) recordStartupError('spawn-failed', `fresh spawn after delete failed for ${ref}: ${describeAgentDirectorFailure(e)}`)
        notifySpawnFailure(key, e, isStartup)
        return { key, action: 'failed' }
      }
    }
    if (err instanceof ErrSpawnNotResumable) {
      // Row is non-terminal but resume rejected — defensive: kill + delete + spawn
      console.error(`[slack] spawnForPersona: ErrSpawnNotResumable for ${ref} — kill+delete+fresh`)
      await tryKill(key)
      if (!(await tryDelete(key, isStartup, ref))) return { key, action: 'failed' }
      try {
        await launchWithReplyGuard(persona, ref, (client) => client.spawn(params))
        await approvePreSessionDialogs(key, isStartup, ref)
        return { key, action: 'spawned' }
      } catch (err2) {
        if (
          err2 instanceof ErrSystemInstallDisappeared ||
          err2 instanceof ErrTmuxNotAvailable ||
          err2 instanceof ErrCwdNotFound ||
          err2 instanceof ErrCwdNotADirectory
        ) {
          return { key, action: 'failed' }
        }
        const e = err2 instanceof AgentDirectorError ? err2 : new AgentDirectorError('spawn', 'UnknownError', String(err2))
        if (isStartup) recordStartupError('spawn-failed', `fresh spawn failed for ${ref}: ${describeAgentDirectorFailure(e)}`)
        notifySpawnFailure(key, e, isStartup)
        return { key, action: 'failed' }
      }
    }
    if (err instanceof ErrSpawnNotFound) {
      // Row vanished between the dead-session verdict and resume (operator
      // delete, expire, race) — fresh-spawn directly, no delete: the row is
      // already gone and a delete of a missing row would throw and turn
      // recovery into action: 'failed'. Mirrors the caller-level retry below.
      console.error(`[slack] spawnForPersona: ErrSpawnNotFound on resume for ${ref} — fresh-spawn`)
      try {
        await launchWithReplyGuard(persona, ref, (client) => client.spawn(params))
        console.error(`[slack] spawnForPersona: fresh-spawned (after ErrSpawnNotFound on resume) for ${ref}`)
        await approvePreSessionDialogs(key, isStartup, ref)
        return { key, action: 'spawned' }
      } catch (err2) {
        if (
          err2 instanceof ErrSystemInstallDisappeared ||
          err2 instanceof ErrTmuxNotAvailable ||
          err2 instanceof ErrCwdNotFound ||
          err2 instanceof ErrCwdNotADirectory
        ) {
          return { key, action: 'failed' }
        }
        const e = err2 instanceof AgentDirectorError ? err2 : new AgentDirectorError('spawn', 'UnknownError', String(err2))
        console.error(`[slack] spawnForPersona: fresh spawn after ErrSpawnNotFound on resume failed for ${ref}: ${describeAgentDirectorFailure(e)}`)
        if (isStartup) recordStartupError('spawn-failed', `fresh spawn after ErrSpawnNotFound on resume failed for ${ref}: ${describeAgentDirectorFailure(e)}`)
        notifySpawnFailure(key, e, isStartup)
        return { key, action: 'failed' }
      }
    }
    if (
      err instanceof ErrSystemInstallDisappeared ||
      err instanceof ErrTmuxNotAvailable ||
      err instanceof ErrCwdNotFound ||
      err instanceof ErrCwdNotADirectory
    ) {
      return { key, action: 'failed' }
    }
    const e = err instanceof AgentDirectorError ? err : new AgentDirectorError('resume', 'UnknownError', String(err))
    console.error(`[slack] spawnForPersona: resume failed for ${ref}: ${describeAgentDirectorFailure(e)}`)
    notifySpawnFailure(key, e, isStartup)
    return { key, action: 'failed' }
  }
}

// ---------------------------------------------------------------------------
// Pre-launch trust patch (b.av2 SR-6.2)
// ---------------------------------------------------------------------------

/** Patches the persona's `.claude.json` trust flags before a launch. */
export type PreLaunchTrustPatcher = (persona: Persona) => void

/**
 * The one pre-launch trust patcher. Production installs the single-persona
 * trust patch (`trustPatchPersona` in `src/trust-bootstrap.ts`). With none
 * installed (unit tests, the integration driver) no patch runs and nothing
 * is written.
 */
let preLaunchTrustPatcher: PreLaunchTrustPatcher | undefined

/** Install the pre-launch trust patcher (production: `server.ts`). */
export function setPreLaunchTrustPatcher(patcher: PreLaunchTrustPatcher): void {
  preLaunchTrustPatcher = patcher
}

/** Test-only seam: remove any installed pre-launch trust patcher. */
export function _resetPreLaunchTrustPatcher(): void {
  preLaunchTrustPatcher = undefined
}

/**
 * Run the installed pre-launch trust patcher for `persona`. A throw is logged
 * with the persona reference and never reaches the ladder.
 */
function runPreLaunchTrustPatch(persona: Persona, ref: string): void {
  if (!preLaunchTrustPatcher) return
  try {
    preLaunchTrustPatcher(persona)
  } catch (err) {
    console.error(`[slack] spawnForPersona: pre-launch trust patch failed for ${ref} — launching anyway: ${describeThrownValue(err)}`)
  }
}

// ---------------------------------------------------------------------------
// Pre-launch reply guard (b.av2 SR-9.4, SR-6.2)
// ---------------------------------------------------------------------------

/**
 * Runs the reply-guard steps before one persona's launch (record write,
 * launched-with update, launch-time hook pass) and may return an undo for a
 * launch that turns out not to be one.
 */
export type PreLaunchReplyGuard = (persona: Persona) => ReplyGuardUndo | void

/**
 * The one pre-launch reply guard. Production installs `preLaunchReplyGuard`
 * from `src/stop-hook-bootstrap.ts`, closed over the server's state directory
 * and a getter for the applied persona set. With none installed (unit tests,
 * the integration driver) no record is written and no settings are patched;
 * nothing here resolves a state directory.
 */
let preLaunchReplyGuard: PreLaunchReplyGuard | undefined

/** Install the pre-launch reply guard (production: `server.ts`). */
export function setPreLaunchReplyGuard(guard: PreLaunchReplyGuard): void {
  preLaunchReplyGuard = guard
}

/** Test-only seam: remove any installed pre-launch reply guard. */
export function _resetPreLaunchReplyGuard(): void {
  preLaunchReplyGuard = undefined
}

/**
 * Run the installed pre-launch reply guard for `persona`, immediately before
 * an agent-director spawn or resume. A throw is logged with the persona
 * reference and never reaches the ladder. Returns the guard's undo, if any.
 */
function runPreLaunchReplyGuard(persona: Persona, ref: string): ReplyGuardUndo | undefined {
  if (!preLaunchReplyGuard) return undefined
  try {
    return preLaunchReplyGuard(persona) ?? undefined
  } catch (err) {
    console.error(`[slack] spawnForPersona: pre-launch reply guard failed for ${ref} — launching anyway: ${describeThrownValue(err)}`)
    return undefined
  }
}

/** Run a reply-guard undo; a throw is logged and never reaches the ladder. */
function undoPreLaunchReplyGuard(undo: ReplyGuardUndo | undefined, ref: string): void {
  if (!undo) return
  try {
    undo()
  } catch (err) {
    console.error(`[slack] spawnForPersona: undoing the pre-launch reply guard failed for ${ref}: ${describeThrownValue(err)}`)
  }
}

/**
 * An agent-director call that starts the persona's instance (`client.spawn`
 * or `client.resume`), preceded immediately by the reply-guard steps. Every
 * spawn and resume in the ladder goes through here except the optimistic
 * first spawn, which also undoes the steps when it meets a live instance.
 */
function launchWithReplyGuard<T>(
  persona: Persona,
  ref: string,
  call: (client: Client) => Promise<T>,
): Promise<T> {
  runPreLaunchReplyGuard(persona, ref)
  return withSpawnDetection(persona.key, persona.working_directory, call)
}

/**
 * In-flight launches by persona key (b.av2 SR-6.3): at most one ladder per
 * persona runs at a time. Holds only unsettled launches; an entry is removed
 * when its launch settles, whatever the outcome.
 */
const inFlightLaunches = new Map<string, Promise<SpawnPersonaResult>>()

/** Test-only seam: forget every in-flight launch. */
export function _resetInFlightLaunches(): void {
  inFlightLaunches.clear()
}

/**
 * True while a launch (collision ladder) for persona `key` is in flight
 * (b.av2 SR-6.6). The restart module's kill adapter consults this so a restart
 * that is about to join a running launch does not first kill the session that
 * launch is bringing up.
 */
export function isLaunchInFlight(key: string): boolean {
  return inFlightLaunches.has(key)
}

/**
 * Resolves once the launch in flight for persona `key` (if any) has settled,
 * whatever its outcome; at once when none is. Never rejects and starts
 * nothing. For a teardown (b.av2 SR-6.6), which must not kill or delete the
 * row while a launch is still bringing it up; launches that run outside the
 * lifecycle serializer (the start pass) are covered too.
 */
export async function whenLaunchSettled(key: string): Promise<void> {
  const inFlight = inFlightLaunches.get(key)
  if (inFlight === undefined) return
  try {
    await inFlight
  } catch {
    /* the launch's own caller handles its outcome */
  }
}

/**
 * Core per-persona spawn dispatcher (SR-1.4), addressing `cscb_<key>`:
 *
 * 1. One in-flight launch per persona (b.av2 SR-6.3): while a launch for the
 *    key is in flight, a second call joins it and receives its result instead
 *    of starting a second ladder. The start's worker pool and the restart
 *    module's `launchSession` both come through here. Keys are independent.
 * 2. Pre-launch claude_config_dir check (bug b.g57, `checkLaunchConfigDir`),
 *    dry run included: when the directory cannot be resolved to a real path,
 *    nothing else runs (no trust patch, no reply-guard step, no
 *    agent-director call, no record written); the failure goes to the
 *    installed hook (the bring-up controller holds the persona `retrying`)
 *    and the result is `deferred`. Otherwise its real path gives the spawn's
 *    `config_dir` label.
 * 3. Dry-run: skip the rest, return synthetic success.
 * 4. Run the installed pre-launch trust patcher for the persona (b.av2
 *    SR-6.2) once, before any spawn or resume the ladder makes.
 *    Then attempt `client.spawn(...)`. On success → done. Every spawn and
 *    resume below is immediately preceded by the installed pre-launch reply
 *    guard (b.av2 SR-9.4); the optimistic spawn undoes its reply-guard steps
 *    on `ErrInstanceIdCollision`: the record and launched-with dir are
 *    restored while still its own, and the hook is re-evaluated.
 * 5. `ErrInstanceIdCollision` → `client.get(...)`, then:
 *    - the row's `cwd` differs from the persona's working_directory by real
 *      path (`compareRowToPersona`) → kill + delete + fresh spawn, whatever
 *      the state and resume_enabled (b.av2 SR-6.2). When the working directory
 *      cannot be resolved to a real path at that moment and the row's `cwd`
 *      has none either (`cwdCheckDeferred`), the row is kept instead: no
 *      kill, no delete, `cwd-unreachable` raised and `failed` returned
 *      (b.av2 SR-6.4). Otherwise branch on state:
 *    - ended/missing + resume_enabled → resume; on ErrNoSessionId/
 *      ErrJsonlMissing/ErrJsonlNeverWritten → delete + fresh spawn.
 *    - ended/missing + !resume_enabled → kill + delete + fresh spawn.
 *    - waiting → reconnectMcp; 'dead-session' → resume/fresh-spawn (b.3ce).
 *    - working → waitForWaitingAndReconnect; 'dead-session' → resume/fresh-spawn (b.3ce).
 *    - pending/check_permission/ask_user → no-op.
 *    Every resume first checks the row's `config_dir` label; a missing or
 *    different label means delete + fresh spawn instead (resumeOrFreshSpawn).
 *    A directory that stopped resolving since step 2 keeps the row and
 *    returns `deferred` instead.
 * 6. Other errors → surface to Slack + (when isStartup) startup-errors.log.
 */
export async function spawnForPersona(
  persona: Persona,
  config: PersonaConfig,
  isStartup = true,
): Promise<SpawnPersonaResult> {
  const { key } = persona
  const ref = personaRef(persona)
  const inFlight = inFlightLaunches.get(key)
  if (inFlight) {
    console.error(`[slack] spawnForPersona: launch already in flight for ${ref} — joining it`)
    return inFlight
  }

  const configDir = checkLaunchConfigDir(persona)
  if (!configDir.ok) {
    deferLaunchForConfigDir(persona, configDir)
    return deferredResult(persona, configDir)
  }

  if (isDryRun()) {
    console.error(`[slack] dry-run: skipping spawn for ${ref} cwd=${persona.working_directory}`)
    return { key, action: 'no-op' }
  }

  const configDirLabel = configDirLabelValue(configDir.realPath, spawnHomeDir())
  const launch = runPersonaLadder(persona, config, isStartup, ref, configDirLabel)
  inFlightLaunches.set(key, launch)
  try {
    return await launch
  } finally {
    if (inFlightLaunches.get(key) === launch) inFlightLaunches.delete(key)
  }
}

/** One collision ladder for a persona; `spawnForPersona` single-flights it per key. */
async function runPersonaLadder(
  persona: Persona,
  config: PersonaConfig,
  isStartup: boolean,
  ref: string,
  configDirLabel: string,
): Promise<SpawnPersonaResult> {
  const { key } = persona
  const params = buildSpawnParams(persona, config, configDirLabel)

  // b.av2 SR-6.2: the trust patch precedes every launch. Running it once here,
  // before the first agent-director spawn or resume this ladder can make,
  // covers every path below (the patch is idempotent).
  runPreLaunchTrustPatch(persona, ref)

  // Attempt fresh spawn ---
  // b.av2 SR-9.4: the reply-guard steps run immediately before every spawn or
  // resume, never on a path that only reconnects to a live instance or does
  // nothing. This optimistic spawn is a launch only when no row exists; a
  // collision means an instance already exists, so its steps are undone (the
  // record and launched-with dir restored while still this step's own, and
  // the hook re-evaluated against the persona's current config) and any later
  // spawn or resume below runs them again.
  let replyGuardUndo: ReplyGuardUndo | undefined
  try {
    replyGuardUndo = runPreLaunchReplyGuard(persona, ref)
    const r = await withSpawnDetection(key, persona.working_directory, (client) => client.spawn(params))
    console.error(`[slack] spawnForPersona: spawned ${ref} instanceId=${r.claude_instance_id}`)
    await approvePreSessionDialogs(key, isStartup, ref)
    return { key, action: 'spawned' }
  } catch (err) {
    if (err instanceof ErrInstanceIdCollision) {
      // Collision → fall through to get-then-act
      undoPreLaunchReplyGuard(replyGuardUndo, ref)
      console.error(`[slack] spawnForPersona: ErrInstanceIdCollision for ${ref} — fetching current state`)
    } else if (err instanceof ErrTmuxSessionCreate) {
      // b.vub: fresh spawn collided on the deterministic tmux session name held
      // by an orphan session (no instance-id collision → no AD row to resolve).
      // Self-heal: kill the orphan by name, retry spawn once.
      try {
        const r = await selfHealTmuxCollisionAndRespawn(persona, params, ref)
        console.error(`[slack] spawnForPersona: self-heal spawn succeeded after ErrTmuxSessionCreate for ${ref} instanceId=${r.claude_instance_id}`)
        await approvePreSessionDialogs(key, isStartup, ref)
        return { key, action: 'spawned' }
      } catch (err2) {
        if (
          err2 instanceof ErrSystemInstallDisappeared ||
          err2 instanceof ErrTmuxNotAvailable ||
          err2 instanceof ErrCwdNotFound ||
          err2 instanceof ErrCwdNotADirectory
        ) {
          return { key, action: 'failed' }
        }
        const e = err2 instanceof AgentDirectorError ? err2 : new AgentDirectorError('spawn', 'UnknownError', String(err2))
        console.error(`[slack] spawnForPersona: self-heal spawn after ErrTmuxSessionCreate failed for ${ref}: ${describeAgentDirectorFailure(e)}`)
        if (isStartup) recordStartupError('spawn-failed', `self-heal spawn after ErrTmuxSessionCreate failed for ${ref}: ${describeAgentDirectorFailure(e)}`)
        notifySpawnFailure(key, e, isStartup)
        return { key, action: 'failed' }
      }
    } else if (
      err instanceof ErrSystemInstallDisappeared ||
      err instanceof ErrTmuxNotAvailable ||
      err instanceof ErrCwdNotFound ||
      err instanceof ErrCwdNotADirectory
    ) {
      return { key, action: 'failed' }
    } else {
      const e = err instanceof AgentDirectorError ? err : new AgentDirectorError('spawn', 'UnknownError', String(err))
      console.error(`[slack] spawnForPersona: spawn failed for ${ref}: ${describeAgentDirectorFailure(e)}`)
      if (isStartup) recordStartupError('spawn-failed', `spawn failed for ${ref}: ${describeAgentDirectorFailure(e)}`)
      notifySpawnFailure(key, e, isStartup)
      return { key, action: 'failed' }
    }
  }

  // Collision-handling: get-then-act ---
  let row: GetResult
  try {
    row = await withOutageDetection(key, undefined, (client) => client.get({ claude_instance_id: personaInstanceId(key) }))
  } catch (err) {
    if (err instanceof ErrSpawnNotFound) {
      // Race: row deleted between spawn-collision and get. Retry spawn once.
      console.error(`[slack] spawnForPersona: ErrSpawnNotFound after collision for ${ref} — retrying spawn (single retry)`)
      try {
        const r = await launchWithReplyGuard(persona, ref, (client) => client.spawn(params))
        console.error(`[slack] spawnForPersona: retry-spawn succeeded for ${ref} instanceId=${r.claude_instance_id}`)
        await approvePreSessionDialogs(key, isStartup, ref)
        return { key, action: 'spawned' }
      } catch (err2) {
        if (
          err2 instanceof ErrSystemInstallDisappeared ||
          err2 instanceof ErrTmuxNotAvailable ||
          err2 instanceof ErrCwdNotFound ||
          err2 instanceof ErrCwdNotADirectory
        ) {
          return { key, action: 'failed' }
        }
        const e = err2 instanceof AgentDirectorError ? err2 : new AgentDirectorError('spawn', 'UnknownError', String(err2))
        console.error(`[slack] spawnForPersona: retry-spawn also failed for ${ref}: ${describeAgentDirectorFailure(e)}`)
        if (isStartup) recordStartupError('spawn-failed', `retry-spawn failed for ${ref}: ${describeAgentDirectorFailure(e)}`)
        notifySpawnFailure(key, e, isStartup)
        return { key, action: 'failed' }
      }
    }
    if (err instanceof ErrSystemInstallDisappeared || err instanceof ErrTmuxNotAvailable) {
      return { key, action: 'failed' }
    }
    const e = err instanceof AgentDirectorError ? err : new AgentDirectorError('get', 'UnknownError', String(err))
    console.error(`[slack] spawnForPersona: get failed for ${ref}: ${describeAgentDirectorFailure(e)}`)
    notifySpawnFailure(key, e, isStartup)
    return { key, action: 'failed' }
  }

  const { state } = row
  console.error(`[slack] spawnForPersona: collision resolved, state=${state} for ${ref}`)

  // b.av2 SR-6.2: a row in another directory (by real path) is never resumed,
  // reconnected or waited on, whatever its state and resume_enabled: kill,
  // delete and spawn fresh in the persona's working directory.
  const comparison = compareRowToPersona(row, persona, spawnHomeDir())
  if (!comparison.cwdMatches) {
    if (comparison.cwdCheckDeferred) {
      // b.av2 SR-6.4: neither the working directory nor the row's cwd has a
      // real path right now, so the row cannot be shown to be in another
      // directory. Keep it (its instance and history) and fail the launch as a
      // spawn in a missing directory would: the cwd-unreachable notice, then
      // restart recovery. A row whose cwd resolves to an existing directory is
      // not deferred and is replaced below.
      console.error(
        `[slack] spawnForPersona: ${ref} working_directory=${persona.working_directory} cannot be resolved to a real path — ` +
          `keeping its row (cwd=${row.cwd || '<none>'}, state=${state}); the launch fails and is retried by the restart path`,
      )
      setOutageFlag(key, 'cwd-unreachable', persona.working_directory)
      return { key, action: 'failed' }
    }
    console.error(
      `[slack] spawnForPersona: ${ref} row cwd=${row.cwd || '<none>'} differs from working_directory=${persona.working_directory} (state=${state}) — replacing the row: kill+delete+fresh`,
    )
    return replaceWithFreshSpawn(persona, params, isStartup, ref, { kill: true })
  }

  if (state === 'ended' || state === 'missing') {
    return resumeOrFreshSpawn(persona, params, config, isStartup, row)
  }

  if (state === 'waiting') {
    // b.rmy: propagate the reconnect outcome — a failed reconnect must count
    // as `failed` so startupSessionManager's ok/failed totals reflect reality.
    // b.3ce: a 'dead-session' verdict means send-keys can never reach the
    // spawn (tmux session wiped by a reboot while the AD row froze at
    // `waiting`) — recover exactly like the ended/missing states instead of
    // giving up.
    const outcome = await reconnectMcp(key, ref)
    if (outcome === 'dead-session') {
      console.error(`[slack] spawnForPersona: dead tmux session for ${ref} (state=waiting) — recovering via resume/fresh-spawn`)
      return resumeOrFreshSpawn(persona, params, config, isStartup, row, { reconcileMissingFirst: true })
    }
    if (outcome !== 'ok') {
      console.error(`[slack] spawnForPersona: reconnect failed for ${ref}`)
      if (isStartup) recordStartupError('spawn-failed', `reconnect failed for ${ref} (state=waiting)`)
      return { key, action: 'failed' }
    }
    return { key, action: 'reconnected' }
  }

  if (state === 'working') {
    // b.rmy/b.3ce/b.ecw: same outcome propagation and dead-session recovery as
    // the `waiting` branch. waitForWaitingAndReconnect returns 'ok' on live
    // transient transitions and whenever the claude PROCESS is verifiably alive
    // (a long turn isn't an error); 'dead-session' when the process is provably
    // gone (ended/missing, or the timeout sweep + status verdict — b.ecw) or the
    // tmux session provably doesn't exist (spawn-not-found — b.c3o).
    const outcome = await waitForWaitingAndReconnect(key, config, ref)
    if (outcome === 'dead-session') {
      console.error(`[slack] spawnForPersona: dead tmux session for ${ref} (state=working) — recovering via resume/fresh-spawn`)
      return resumeOrFreshSpawn(persona, params, config, isStartup, row, { reconcileMissingFirst: true })
    }
    if (outcome !== 'ok') {
      console.error(`[slack] spawnForPersona: reconnect failed for ${ref}`)
      if (isStartup) recordStartupError('spawn-failed', `reconnect failed for ${ref} (state=working)`)
      return { key, action: 'failed' }
    }
    return { key, action: 'reconnected' }
  }

  if (state === 'pending' || state === 'check_permission' || state === 'ask_user') {
    console.error(`[slack] spawnForPersona: no action — state=${state} for ${ref}`)
    return { key, action: 'no-op' }
  }

  console.error(`[slack] spawnForPersona: unexpected state=${state} for ${ref} — no action`)
  return { key, action: 'no-op' }
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
 * What the start sweep does with a row (b.av2 SR-6.3, SR-6.4): `sweep` it
 * with a reason, `keep` it, or keep it with its `cwd` check `deferred` to the
 * persona's launch. A row is kept only when it has a `persona` label naming
 * an applied persona, its instance ID is that persona's `cscb_<key>`, and its
 * `cwd` matches the persona's working directory by real path. When that
 * working directory cannot be resolved to a real path (a directory-broken
 * persona) and the row's `cwd` has no real path either or equals the
 * configured path lexically (`cwdCheckDeferred`), the `cwd` condition cannot
 * be evaluated and is deferred; the other three conditions still apply. A row
 * whose `cwd` resolves to an existing directory is swept as `wrong cwd`.
 */
function sweepDecision(
  row: ListRow,
  persona: Persona | undefined,
  personaLabel: string | undefined,
  home: string,
): { action: 'sweep'; reason: string } | { action: 'keep' } | { action: 'deferred'; persona: Persona } {
  if (!personaLabel) return { action: 'sweep', reason: 'no persona label' }
  if (!persona) return { action: 'sweep', reason: 'absent persona' }
  if (row.claude_instance_id !== personaInstanceId(persona.key)) return { action: 'sweep', reason: 'wrong instance ID' }
  const comparison = compareRowToPersona(row, persona, home)
  if (comparison.cwdCheckDeferred) return { action: 'deferred', persona }
  if (!comparison.cwdMatches) return { action: 'sweep', reason: 'wrong cwd' }
  return { action: 'keep' }
}

/**
 * Start sweep (b.av2 SR-6.3; formerly SR-1.6): enumerate every `service=cscb`
 * spawn and kill+delete each one that
 *   - has no `persona` label,
 *   - names a persona absent from the applied configuration,
 *   - has an instance ID other than `cscb_<key>` for its persona, or
 *   - has a `cwd` other than its persona's working directory, by real path
 *     (`compareRowToPersona`).
 * When a persona's working directory cannot be resolved to a real path (a
 * directory-broken persona, b.av2 SR-6.4), its rows whose `cwd` has no real
 * path either (or equals the configured path lexically) are kept, and one
 * line per persona says the check is deferred to its launch; a row whose
 * `cwd` resolves to an existing directory is still swept as `wrong cwd`:
 *
 *   [slack] reconcileOrphans: persona "<name>" (key=<key>) working_directory="<path>" cannot be resolved to a real path — keeping its rows; the cwd check is deferred to its launch
 *
 * A `channel` label left on a row by an older spawn plays no part. A failed
 * kill still attempts the delete; kill and delete failures record
 * `orphan-cleanup`, a list failure records `orphan-cleanup-list-failed` and
 * does not block startup.
 */
export async function reconcileOrphans(
  personaConfig: PersonaConfig,
): Promise<OrphanReconcileResult> {
  if (isDryRun()) {
    console.error('[slack] dry-run: skipping orphan reconciliation')
    return { found: 0, killed: 0, failed: 0 }
  }

  const client = getClient()
  let rows: ListRow[]
  try {
    const r = await client.list({ label: [SERVICE_LABEL] })
    rows = r.spawns
  } catch (err) {
    const e = err instanceof AgentDirectorError ? err : new AgentDirectorError('list', 'UnknownError', String(err))
    recordStartupError(
      'orphan-cleanup-list-failed',
      `failed to list spawns for orphan reconciliation: ${describeAgentDirectorFailure(e)}`,
    )
    return { found: 0, killed: 0, failed: 0 }
  }

  const personasByKey = new Map(personaConfig.personas.map((p) => [p.key, p]))
  const home = spawnHomeDir()

  let found = 0
  let killed = 0
  let failed = 0

  const deferredLogged = new Set<string>()

  for (const row of rows) {
    const personaLabel = row.labels?.[PERSONA_LABEL_KEY]
    const persona = personaLabel ? personasByKey.get(personaLabel) : undefined
    const decision = sweepDecision(row, persona, personaLabel, home)
    if (decision.action === 'keep') continue
    if (decision.action === 'deferred') {
      const deferred = decision.persona
      if (!deferredLogged.has(deferred.key)) {
        deferredLogged.add(deferred.key)
        console.error(
          `[slack] reconcileOrphans: persona ${personaRef(deferred)} working_directory="${deferred.working_directory}" ` +
            'cannot be resolved to a real path — keeping its rows; the cwd check is deferred to its launch',
        )
      }
      continue
    }
    const { reason } = decision

    found++
    // The persona reference when the persona exists, else the raw label value.
    const displayPersona = persona ? personaRef(persona) : (personaLabel || '<no persona label>')
    const cwdDetail = reason === 'wrong cwd' ? ` cwd=${row.cwd}` : ''
    console.error(
      `[slack] reconcileOrphans: sweeping row (${reason}) persona=${displayPersona} instanceId=${row.claude_instance_id} state=${row.state}${cwdDetail} — killing and deleting`,
    )

    try {
      await client.kill({ claude_instance_id: row.claude_instance_id })
    } catch (err) {
      const e = err instanceof AgentDirectorError ? err : new AgentDirectorError('kill', 'UnknownError', String(err))
      recordStartupError(
        'orphan-cleanup',
        `kill failed for orphan instanceId=${row.claude_instance_id} persona=${displayPersona}: ${describeAgentDirectorFailure(e)}`,
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
        `delete failed for orphan instanceId=${row.claude_instance_id} persona=${displayPersona}: ${describeAgentDirectorFailure(e)}`,
      )
      failed++
    }
  }

  console.error(`[slack] reconcileOrphans: found=${found} killed=${killed} failed=${failed}`)
  return { found, killed, failed }
}

// ---------------------------------------------------------------------------
// startupSessionManager — iterate personas and dispatch per persona
// ---------------------------------------------------------------------------

/**
 * What `startupSessionManager` needs to run steps 1–3 of the SR-6.1 bring-up
 * procedure for each persona: the bring-up controller
 * (`createPersonaBringUpController`), which gives each persona its outcome and
 * runs its retries on the persona's own timers. The applied set is supplied
 * here; the launch (step 4) at start is `spawnForPersona`.
 */
export type StartupBringUpDeps = Pick<PersonaBringUpController, 'bringUp'>

/**
 * One persona's start outcome: a spawn outcome, or not brought up (steps 1–3:
 * `broken` or `retrying`) with its causes.
 */
export type StartupPersonaOutcome =
  | { key: string; action: SpawnPersonaResult['action'] }
  | {
    key: string
    action: 'not-brought-up'
    outcome: Exclude<PersonaBringUpOutcome, 'up'>
    failures: PersonaBringUpFailure[]
  }

export interface StartupSessionManagerResult {
  /** Any non-failed action (kept for callers that only care about liveness). */
  succeeded: number
  failed: number
  /**
   * Personas not brought up at start: `broken` or `retrying` after steps 1–3
   * (credentials, working directory, Slack). Not launched by the start and
   * not counted as a failed spawn; a `retrying` persona is launched later
   * from its own retry, outside the pool.
   */
  notBroughtUp: number
  /** b.wrb: honest per-outcome breakdown of the succeeded personas. */
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
  /** One outcome per persona, by key. */
  perPersona: StartupPersonaOutcome[]
}

/**
 * On server startup, bring every applied persona up once — a persona listed
 * in several channels still gets exactly one bring-up and one spawn.
 *
 * With `options.bringUp` (the server always passes its bring-up controller)
 * each persona goes through the b.av2 SR-6.1 procedure, in order: the local
 * credentials check (skipped in dry run), the working-directory check, Slack
 * validation and connection (the controller's `bringUp`, which also logs the
 * persona's `persona-start` line), then the launch (`spawnForPersona`). Steps
 * 1–3 run for every persona at once, so no persona's Slack connection waits
 * behind another persona's launch; only the launches share a pool of at most
 * `concurrency` (default 3), taken in the order the personas become ready. The
 * pass returns once every persona has an outcome and every `up` persona's
 * launch has settled: a `broken` or `retrying` persona is not brought up and
 * never takes a pool slot (its retries run on its own timers, and a retry
 * that succeeds launches it from there). It is counted apart from spawn
 * outcomes, records no startup error, posts no notice and is not a failed
 * spawn. Without `options.bringUp` each persona is launched directly
 * (steps 1–3 skipped), in config order through the same pool; only unit
 * tests of the launch ladder call it that way.
 *
 * Per-persona launch failures are logged and recorded in startup-errors.log
 * but never crash the server. cozempic availability is probed in the
 * background (non-blocking).
 */
export async function startupSessionManager(
  config: PersonaConfig,
  options?: { concurrency?: number; bringUp?: StartupBringUpDeps },
): Promise<StartupSessionManagerResult> {
  await checkCozempicAvailable()

  const personas = config.personas
  const concurrency = options?.concurrency ?? 3

  console.error(
    `[slack] startupSessionManager: ${personas.length} persona(s), concurrency=${concurrency}`,
  )

  const perPersona: StartupPersonaOutcome[] = []
  const bringUp = options?.bringUp
  const launchSlot = createLaunchPool(Math.max(1, concurrency))
  let succeeded = 0
  let failed = 0
  let notBroughtUp = 0
  let resumed = 0
  let freshSpawned = 0
  let freshAfterAmnesia = 0
  let freshAfterInconclusiveAmnesia = 0
  let reconnected = 0
  let noop = 0

  function tally(action: SpawnPersonaResult['action']): void {
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

  /**
   * Steps 1–3 (with `bringUp`, outside the pool), then step 4 through the
   * launch pool; the launch alone without `bringUp`. Undefined when not
   * brought up (recorded here).
   */
  async function launchPersona(persona: Persona): Promise<SpawnPersonaResult | undefined> {
    if (bringUp) {
      const started = await bringUp.bringUp(persona, personas)
      if (started.outcome !== 'up') {
        perPersona.push({ key: persona.key, action: 'not-brought-up', outcome: started.outcome, failures: started.failures })
        notBroughtUp++
        return undefined
      }
    }
    return launchSlot(() => spawnForPersona(persona, config))
  }

  async function processPersona(persona: Persona): Promise<void> {
    try {
      const result = await launchPersona(persona)
      if (result === undefined) return
      if (result.action === 'deferred') {
        // Bug b.g57: its claude_config_dir cannot be resolved; the bring-up
        // controller holds it retrying and launches it once it resolves.
        const failures = result.deferredBy === undefined ? [] : [result.deferredBy]
        perPersona.push({ key: persona.key, action: 'not-brought-up', outcome: 'retrying', failures })
        notBroughtUp++
        return
      }
      perPersona.push({ key: persona.key, action: result.action })
      tally(result.action)
    } catch (err) {
      const ref = personaRef(persona)
      // Token-safe: the launch covers the persona's Slack bring-up, so the
      // thrown value's message can carry secrets. Only the describer's output
      // (type, code, message through `redactSlackLogText`, frames) reaches
      // the log and startup-errors.log.
      const cause = describeThrownValue(err)
      console.error(`[slack] startupSessionManager: unexpected error for ${ref}: ${cause}`)
      recordStartupError('spawn-failed', `unexpected error spawning ${ref}: ${cause}`)
      perPersona.push({ key: persona.key, action: 'failed' })
      failed++
    }
  }

  await Promise.all(personas.map((persona) => processPersona(persona)))

  // b.wrb/b.fwu: honest breakdown. A fresh-spawn that replaced a resume because
  // the transcript was missing is reported separately and never folded into a
  // generic "ok". b.fwu splits that amnesia into DIAGNOSED (fresh-after-amnesia:
  // we know whether history was lost) vs UNDIAGNOSABLE
  // (fresh-after-inconclusive-amnesia: we could not tell).
  console.error(
    `[slack] startupSessionManager: complete — ${personas.length} persona(s): ${resumed} resumed, ` +
      `${freshSpawned} fresh-spawned, ${freshAfterAmnesia} fresh-after-amnesia, ` +
      `${freshAfterInconclusiveAmnesia} fresh-after-inconclusive-amnesia, ` +
      `${reconnected} reconnected, ${noop} no-op, ${failed} failed, ${notBroughtUp} not brought up`,
  )
  if (freshAfterAmnesia > 0) {
    // Loud, grep-friendly signal that some personas lost their resume target.
    // Per-persona "lost vs never-created" detail was already emitted (and, for
    // 'lost', recorded to startup-errors) by diagnoseJsonlMissing.
    console.error(
      `[slack] startupSessionManager: ${freshAfterAmnesia} persona(s) were fresh-spawned after ErrJsonlMissing ` +
        `(transcript could not be resumed) — see per-persona "ErrJsonlMissing diagnostic" lines above.`,
    )
  }
  if (freshAfterInconclusiveAmnesia > 0) {
    // b.fwu: a separate, louder signal — these personas were fresh-spawned but
    // the diagnosis machinery could not tell whether history was destroyed. That
    // degraded-diagnosis condition correlates with the storage faults that cause
    // real loss, so it warrants its own attention. Each was recorded to
    // startup-errors as 'jsonl-diagnosis-inconclusive'.
    console.error(
      `[slack] startupSessionManager: ${freshAfterInconclusiveAmnesia} persona(s) were fresh-spawned after ` +
        `ErrJsonlMissing WITHOUT a conclusive diagnosis — could NOT determine whether conversation history was ` +
        `lost. See per-persona "ErrJsonlMissing diagnostic ... INCONCLUSIVE" lines and the ` +
        `'jsonl-diagnosis-inconclusive' startup errors above.`,
    )
  }

  return {
    succeeded,
    failed,
    notBroughtUp,
    resumed,
    freshSpawned,
    freshAfterAmnesia,
    freshAfterInconclusiveAmnesia,
    reconnected,
    noop,
    perPersona,
  }
}

/**
 * A first-in, first-out pool: `run(task)` starts `task` once fewer than
 * `size` tasks are running, in the order `run` was called, and settles with
 * its result.
 */
function createLaunchPool(size: number): <T>(task: () => Promise<T>) => Promise<T> {
  let running = 0
  const waiting: Array<() => void> = []
  return async <T>(task: () => Promise<T>): Promise<T> => {
    if (running >= size) await new Promise<void>((resolve) => waiting.push(resolve))
    else running++
    try {
      return await task()
    } finally {
      const next = waiting.shift()
      if (next) next()
      else running--
    }
  }
}

// ---------------------------------------------------------------------------
// launchSession — restart.ts adapter
// ---------------------------------------------------------------------------

/**
 * Restart-adapter shim for restart.ts (`RestartDeps.launchSession`): launch
 * the applied persona with this key. Runs step 4 of the start procedure only:
 * a restart never repeats the credentials, working-directory or Slack steps.
 *
 * `options.canLaunch` (the server passes `createPersonaRelaunchGate`) is
 * asked first, before the persona is looked up: when it answers false — the
 * persona is not up (its Slack connection is not serving, or its bring-up is
 * broken or retrying) or its key is no longer applied (b.av2 SR-8.6) —
 * nothing is launched and the result is `'skipped'`, which restart.ts counts
 * as neither a success nor a failure. Asking it first keeps a key a
 * confirmed apply removed from counting as a failure. restart.ts asks the
 * same gate before any kill or reconnect; this check covers a flip in
 * between.
 *
 * Returns true on any non-failed action (spawned / resumed / reconnected /
 * no-op), false on `failed` or when no applied persona has the key, and
 * `'skipped'` for `deferred` (bug b.g57: its claude_config_dir cannot be
 * resolved; nothing was launched and its row is kept), which counts toward
 * no failure or cap. The richer `SpawnPersonaResult` is collapsed here
 * because the restart subsystem only cares about did-it-relaunch.
 */
export async function launchSession(
  key: string,
  config: PersonaConfig,
  options?: { canLaunch?: (key: string) => boolean },
): Promise<boolean | 'skipped'> {
  if (options?.canLaunch && !options.canLaunch(key)) return 'skipped'
  const persona = config.personas.find((p) => p.key === key)
  if (!persona) return false
  const result = await spawnForPersona(persona, config, false)
  if (result.action === 'deferred') return 'skipped'
  return result.action !== 'failed'
}
