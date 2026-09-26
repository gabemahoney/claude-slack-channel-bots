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
 *      wait for waiting (or, b.f2b, for positive evidence that the row is
 *      stale and the session idle: the same idle pane and the same transcript,
 *      ended with a completed turn, across a window) then reconnect;
 *      pending/check_permission/ask_user →
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
 * `service=cscb` spawn and kills+deletes any with a persona absent from the
 * applied configuration, an instance ID other than `cscb_<key>`, or a `cwd`
 * other than its persona's working directory. A pre-persona row (no `persona`
 * label) is never deleted: it is kept, and killed only when live, with one
 * findMissing sweep after the kills so a killed row reads `missing` once its
 * session is gone and isn't killed again at the next start (b.1ix). While a
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
 * a time) for each persona that is up. A launch that starts waiting for a
 * `working` row is left to finish in the background, still in flight, so the
 * pass does not wait for it (b.f2b). A restart (`launchSession`) runs the
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
  ErrSpawnNotInteractive,
} from './agent-director-errors.ts'
import { recordStartupError } from './startup-errors.ts'
import {
  locateTranscript,
  readTranscriptTurnState,
  sameTranscriptSnapshot,
  type TranscriptReading,
  type TranscriptSnapshot,
} from './session-transcript.ts'
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

/**
 * Why a persona is reported not connected (b.f2b), and what the notice says:
 * - `blocked-on-prompt`: its session shows a prompt or dialog that no one
 *   answered, and CSCB never types into one, so it won't reconnect the
 *   persona while the prompt is up: its `working` row's pane has shown one
 *   for `STALE_WORKING_WINDOW_MS`, its `waiting` row's pane shows one, or its
 *   row reads `ask_user` or `check_permission` (the restart path, or a launch
 *   wait that ended there). With `autoRestartDisabled` the notice also says
 *   nothing will reconnect it once the prompt is answered.
 * - `auto-restart-disabled`: its session runs but messages can't reach it
 *   (`cause`, fixed token-free text): its MCP connection is down, or, with
 *   `streamless`, it is connected but its message stream is gone. With
 *   `session_restart_delay` 0 nothing will reconnect it.
 * - `unproven-idle`: its row reads `working` and CSCB has held back from it,
 *   typing nothing, for `heldMs` (at least `UNPROVEN_IDLE_NOTICE_AFTER_MS`,
 *   `noteWorkingRowDeferral`, or a launch wait that gave up on the row at
 *   `session_restart_delay` 0), because it can't prove the session idle. With
 *   `autoRestartDisabled` the notice says nothing will reconnect it on its
 *   own; otherwise that CSCB reconnects it once it can tell it is idle.
 */
export type NotConnectedNotice =
  | { reason: 'blocked-on-prompt'; autoRestartDisabled: boolean }
  | { reason: 'auto-restart-disabled'; cause: string; streamless?: boolean }
  | { reason: 'unproven-idle'; autoRestartDisabled: boolean; heldMs: number }

/**
 * Why the health check finds an alive persona undeliverable (b.f2b): its MCP
 * session is not connected, or it is connected but has no message stream
 * (b.9cj).
 */
export type UndeliverableCause = 'disconnected' | 'streamless'

/**
 * Personas whose not-connected notice was raised in the current episode
 * (b.f2b). The episode ends when the persona's MCP session registers again,
 * when the health check finds it deliverable again, or when the persona is
 * torn down (`forgetNotConnectedEpisode`).
 */
const notConnectedNoticeRaised = new Set<string>()

/**
 * Raise the not-connected notice for persona `key` (b.f2b), at most once per
 * episode, through the persona notifier: its session runs, but it is not
 * connected to this server and CSCB will not reconnect it on its own. The
 * notice says why and what to do. Logs one line when it raises the notice and
 * returns whether it did; a second call in the same episode does nothing.
 */
export function notifyPersonaNotConnected(key: string, notice: NotConnectedNotice): boolean {
  if (notConnectedNoticeRaised.has(key)) return false
  notConnectedNoticeRaised.add(key)
  console.error(`[slack] session-manager: ${keyRef(key)} is not connected (${notice.reason}) — raising a not-connected notice (b.f2b)`)
  sendPersonaNotice(key, buildNotConnectedNotice(key, notice))
  return true
}

/**
 * The health check's report for an alive persona it would reconnect while
 * auto-restart is disabled (b.f2b): the `auto-restart-disabled` notice, once
 * per episode (`notifyPersonaNotConnected`), worded for why it is
 * undeliverable: its MCP connection is down (`disconnected`, the default), or
 * it is connected but its message stream is gone (`streamless`).
 */
export function notifyDisconnectedWithAutoRestartDisabled(key: string, cause: UndeliverableCause = 'disconnected'): void {
  notifyPersonaNotConnected(
    key,
    cause === 'streamless'
      ? {
          reason: 'auto-restart-disabled',
          cause: 'found on two health checks in a row',
          streamless: true,
        }
      : { reason: 'auto-restart-disabled', cause: 'its connection has been down on two health checks in a row' },
  )
}

/**
 * End persona `key`'s not-connected episode (b.f2b): its MCP session
 * registered again, the health check found it deliverable again, or it was
 * torn down. Its notice latch is cleared, so a later episode is reported
 * again, and so are the idle evidence the restart path gathered for its
 * `working` row (`checkWorkingRowPane`) and its run of deferrals on that row
 * (`noteWorkingRowDeferral`). Silent; other personas are untouched.
 */
export function forgetNotConnectedEpisode(key: string): void {
  notConnectedNoticeRaised.delete(key)
  workingRowPaneRuns.delete(key)
  workingRowDeferredSince.delete(key)
}

/** Test-only seam: end every persona's not-connected episode (notice latches, idle evidence and deferral runs). */
export function _resetNotConnectedEpisodes(): void {
  notConnectedNoticeRaised.clear()
  workingRowPaneRuns.clear()
  workingRowDeferredSince.clear()
}

/**
 * The not-connected notice body (b.f2b). The first line says what is wrong,
 * so a dry-run log line (which carries only the first line) keeps it; the
 * second says what to do. The notifier adds the persona reference. The attach
 * command names the session exactly (`=slack_bot_<key>`, b.1ix): a bare name
 * would attach to a prefix neighbour's session (`slack_bot_dev_2` for
 * `slack_bot_dev`) once the persona's own is gone.
 */
function buildNotConnectedNotice(key: string, notice: NotConnectedNotice): string {
  const attach = `\`tmux attach -t ${tmuxExactSessionTarget(personaTmuxSessionName(key))}\``
  const reconnect = `\`/mcp reconnect ${MCP_SERVER_NAME}\``
  if (notice.reason === 'blocked-on-prompt') {
    const after = notice.autoRestartDisabled
      ? `Automatic restarts are disabled (\`session_restart_delay\` is 0): if it is still not connected once its turn ends, type ${reconnect} there or restart the server.`
      : `Once it is answered, CSCB reconnects it when it can tell the session is idle again (its row reads waiting, or its screen and transcript prove it idle); if it stays disconnected, type ${reconnect} there.`
    return (
      `:warning: *Waiting on a prompt* — this persona is not connected to this server, and its session shows a prompt or dialog in its terminal that no one has answered. CSCB never types into a prompt, so it won't reconnect the persona while the prompt is up; messages sent to it until then are lost.\n` +
      `Attach with ${attach} and answer it. ${after}`
    )
  }
  if (notice.reason === 'unproven-idle') {
    const after = notice.autoRestartDisabled
      ? `Automatic restarts are disabled (\`session_restart_delay\` is 0), so nothing will reconnect it on its own; if it stays disconnected, restart the server.`
      : `Otherwise CSCB keeps checking it and reconnects it once its row reads waiting or its screen and transcript prove it idle.`
    return (
      `:warning: *Not connected* — this persona is not connected to this server: its session reads working but CSCB can't prove it's idle, so it won't type into it, and has held back for ${describeWaitSpan(notice.heldMs)}. Messages sent to it until it reconnects are lost.\n` +
      `Check it with ${attach}: let a running turn finish and answer anything on screen; if it sits idle at its prompt, type ${reconnect} there. ${after}`
    )
  }
  if (notice.streamless === true) {
    return (
      `:warning: *Not receiving messages* — this persona's session is running and connected to this server, but its message stream is gone (${notice.cause}), and automatic restarts are disabled (\`session_restart_delay\` is 0), so nothing will restore it; messages sent to it are lost.\n` +
      `To recover: attach with ${attach}, deal with anything on screen and type ${reconnect}, or restart the server.`
    )
  }
  return (
    `:warning: *Not connected* — this persona's session is running but is not connected to this server (${notice.cause}), and automatic restarts are disabled (\`session_restart_delay\` is 0), so nothing will reconnect it; messages sent to it are lost.\n` +
    `To recover: attach with ${attach}, deal with anything on screen and type ${reconnect}, or restart the server.`
  )
}

function remediationHint(error: AgentDirectorError): string {
  if (error instanceof ErrInstanceIdCollision) return 'spawn dispatcher bug — please report'
  if (error instanceof ErrSpawnNotFound) return 'transient — restarting the server should resolve'
  if (error instanceof ErrSpawnCapReached) return 'restart the server to retry — automatic restarts are suspended for this persona'
  return 'Check server.log for details.'
}

// ---------------------------------------------------------------------------
// Raw tmux calls — one runner, exact targets only (b.1ix)
// ---------------------------------------------------------------------------

/** One `tmux` run: its exit code (`null` when it could not run) and its stdout. */
export interface TmuxRunResult {
  code: number | null
  stdout: string
}

/**
 * Runs `tmux <args>` and never rejects. Every raw tmux call in the server goes
 * through this one runner (the server start, the liveness probe, the dialog
 * approver's pane read and Enter, and the b.vub orphan kill), so a unit test
 * can see each argv and no test reaches a real tmux server.
 */
export type TmuxCommandRunner = (args: readonly string[]) => Promise<TmuxRunResult>

const defaultRunTmux: TmuxCommandRunner = async (args) => {
  const { spawn } = await import('child_process')
  return new Promise<TmuxRunResult>((resolve) => {
    try {
      const child = spawn('tmux', [...args], { stdio: ['ignore', 'pipe', 'ignore'] })
      let stdout = ''
      child.stdout?.on('data', (d: Buffer) => { stdout += d.toString('utf8') })
      child.on('error', () => resolve({ code: null, stdout: '' })) // tmux missing
      child.on('close', (code) => resolve({ code, stdout }))
    } catch {
      resolve({ code: null, stdout: '' })
    }
  })
}

let _runTmux: TmuxCommandRunner = defaultRunTmux

/** Test-only seam: override the tmux command runner. */
export function _setTmuxCommandRunner(fn: TmuxCommandRunner): void {
  _runTmux = fn
}

/** Test-only seam: restore the default tmux command runner. */
export function _resetTmuxCommandRunner(): void {
  _runTmux = defaultRunTmux
}

/**
 * tmux resolves a bare `-t <name>` to the session with that exact name when
 * there is one, and otherwise to the one session whose name starts with it.
 * Persona keys can prefix one another (`dev`, `dev_2`), so a bare
 * `slack_bot_dev` reaches `slack_bot_dev_2` whenever `slack_bot_dev` is gone:
 * a kill or an Enter would hit the neighbour's bot. A `=` prefix accepts only
 * the exact name (b.1ix). Verified against tmux 3.2a, the version in the
 * `/ci` image.
 *
 * A session target (`has-session`, `kill-session`, and the `attach` command
 * the not-connected notices give an operator) is `=<name>`.
 */
function tmuxExactSessionTarget(sessionName: string): string {
  return `=${sessionName}`
}

/**
 * A pane target (`capture-pane`, `send-keys`) is `=<name>:`, the exact
 * session's active pane: tmux 3.2a refuses `=<name>` as a pane target
 * ("can't find pane"), even when the session exists.
 */
function tmuxExactPaneTarget(sessionName: string): string {
  return `=${sessionName}:`
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
  await _runTmux(['start-server']) // best-effort
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
 * forces exact-name match, not prefix match) and reports exit code 0; tmux
 * missing reads as dead.
 */
export type TmuxSessionProber = (sessionName: string) => Promise<boolean>

const defaultHasTmuxSession: TmuxSessionProber = async (sessionName: string): Promise<boolean> => {
  const { code } = await _runTmux(['has-session', '-t', tmuxExactSessionTarget(sessionName)])
  return code === 0
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
 * Probe whether the persona's own tmux session (`slack_bot_<key>`) is alive,
 * through the tmux-session prober seam above (b.d61: the restart module's
 * reconnect adapter bounds its `working` deferral with it). The default prober
 * never rejects; an injected one may, so the caller decides what a failed probe
 * means.
 */
export async function hasPersonaTmuxSession(key: string): Promise<boolean> {
  return _hasTmuxSession(personaTmuxSessionName(key))
}

/**
 * Reconnect outcome (b.3ce). `dead-session` means the session is provably
 * unusable — callers should recover via the resume/fresh-spawn path rather than
 * report a bare failure. Two classes of proof qualify:
 *   - the claude PROCESS is provably gone per AD's evidence-based
 *     findMissing + status verdict (waitForWaitingAndReconnect's ended/missing
 *     branch and its timeout branch; b.ecw), or AD refused reconnectMcp's
 *     keystrokes because it had ended the row or marked it missing since the
 *     caller read its state (`ErrSpawnNotInteractive`; b.dup), or
 *   - the tmux SESSION provably doesn't exist (the ErrSpawnNotFound paths where
 *     AD has no row to consult, and reconnectMcp's double-ErrTmuxSendKeys).
 */
export type ReconnectOutcome = 'ok' | 'failed' | 'dead-session'

/**
 * `waitForWaitingAndReconnect`'s outcome (b.f2b): a reconnect outcome (`ok`
 * only when `/mcp reconnect` was typed); `not-reconnected`: the wait ended
 * with the persona's session alive but typed nothing (the row moved to a live
 * transient state, agent-director lost the row while its tmux session lives,
 * or the timeout found it still live), and has logged what happens next for
 * the restart delay in effect (`reportWaitEndedDisconnected`); or `cancelled`:
 * the persona's teardown cancelled the wait (`cancelWorkingRowWait`), and
 * nothing was typed.
 */
export type WaitReconnectOutcome = ReconnectOutcome | 'not-reconnected' | 'cancelled'

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
 * b.dup: agent-director refuses send-keys to a row that is not interactive
 * with `ErrSpawnNotInteractive` (an `ended` or `missing` row; a `pending` one
 * too, without allow_pending, but no caller passes one: the restart path's
 * adapter defers a `pending` row). Every caller read the row `waiting` (or a
 * stale `working`) just before, so the row was ended or marked missing in
 * between: SessionEnd fired, or a findMissing sweep (another persona's launch
 * wait starts with one, b.m4r) found the claude process gone. That process is
 * gone, so this returns 'dead-session' too, on the first attempt or on the
 * `ErrTmuxSendKeys` retry, with one log line and no spawn-failure notice: the
 * caller recovers the persona (the ladder through resume/fresh-spawn, the
 * restart adapter by escalating it for a relaunch in the same run).
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
    if (err instanceof ErrSpawnNotInteractive) return reconnectRefusedDeadSession(err, ref)
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
        if (err2 instanceof ErrSpawnNotInteractive) return reconnectRefusedDeadSession(err2, ref)
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

/**
 * b.dup: reconnectMcp's verdict when agent-director refused its keystrokes
 * with `ErrSpawnNotInteractive`: the row was ended or marked missing after the
 * caller read its state, so the claude process is gone. Logs one line (the
 * error's name and redacted description) and returns 'dead-session'; raises
 * no notice, since the caller recovers the persona.
 */
function reconnectRefusedDeadSession(err: ErrSpawnNotInteractive, ref: string): 'dead-session' {
  console.error(
    `[slack] reconnectMcp: send-keys refused for ${ref}: ${describeAgentDirectorFailure(err)} — agent-director ended its row or marked it missing after its state was read (SessionEnd or a findMissing sweep), so its claude process is gone — dead session (b.dup)`,
  )
  return 'dead-session'
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
 * per-persona session name and addressing that session's pane exactly
 * (`=<name>:`, b.1ix), so a persona whose key prefixes another's never reads
 * or presses Enter in its neighbour's pane. A session that isn't there reads
 * as an empty pane. Injectable so unit tests stay hermetic.
 */
export type TmuxPaneReader = (sessionName: string) => Promise<string>
export type TmuxEnterSender = (sessionName: string) => Promise<void>

async function defaultTmuxCapturePane(sessionName: string): Promise<string> {
  const { stdout } = await _runTmux(['capture-pane', '-p', '-t', tmuxExactPaneTarget(sessionName)])
  return stdout
}

async function defaultTmuxSendEnter(sessionName: string): Promise<void> {
  await _runTmux(['send-keys', '-t', tmuxExactPaneTarget(sessionName), 'Enter'])
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
    //     name, addressed exactly (`=<session>:`, b.1ix) — the
    //     `tmux send-keys -t <session> Enter` the operator ran by hand in the
    //     ticket. Once Enter lands, SessionStart fires and AD flips to a live
    //     state on the next poll.
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

/**
 * The clock of the `working`-row wait and evidence (b.f2b):
 * `waitForWaitingAndReconnect`'s deadline and loop, the launch wait's
 * evidence reads (`staleWorkingRowIsIdle`) and the restart path's
 * (`checkWorkingRowPane`), pane and transcript alike. Test-only override
 * below.
 */
let _now: () => number = () => Date.now()

/** Test-only seam: override the clock of the `working`-row wait and evidence (a suite passes `createFakeClock().now`). */
export function _setNow(now: () => number): void {
  _now = now
}

/** Test-only seam: restore the real clock. */
export function _resetNow(): void {
  _now = () => Date.now()
}

// ---------------------------------------------------------------------------
// Stale `working` rows (b.f2b) — evidence from the persona's pane and transcript
// ---------------------------------------------------------------------------

/**
 * How long a `working` row's idle evidence must hold, or its pane keep showing
 * a prompt, before `waitForWaitingAndReconnect` at a launch, or the restart
 * path's reconnect adapter across its attempts (`checkWorkingRowPane`), acts
 * on it (b.f2b): it reconnects the stale row, or reports the prompt. Idle
 * evidence is the positive-idle rule of `foldWorkingPaneRun`: at every read
 * across the window, the pane shows the same idle screen AND the session's
 * transcript ends with a completed turn, unchanged. Test-only override below.
 */
export const STALE_WORKING_WINDOW_MS = 60_000

let _staleWorkingWindowMs = STALE_WORKING_WINDOW_MS

/** Test-only seam: override the stale-`working` evidence window. */
export function _setStaleWorkingWindowMs(ms: number): void {
  _staleWorkingWindowMs = ms
}

/** Test-only seam: restore the default stale-`working` evidence window. */
export function _resetStaleWorkingWindowMs(): void {
  _staleWorkingWindowMs = STALE_WORKING_WINDOW_MS
}

/**
 * How often the launch wait reads a `working` row's evidence (b.f2b): its
 * pane and, when that shows an idle screen, its agent-director row and
 * transcript. Every agent-director call goes through its one queue, shared by
 * every persona, so the wait reads at this cadence rather than on each status
 * poll. Test-only override below.
 */
export const WORKING_ROW_READ_INTERVAL_MS = 5_000

let _workingRowReadIntervalMs = WORKING_ROW_READ_INTERVAL_MS

/** Test-only seam: override how often the launch wait reads a `working` row's evidence. */
export function _setWorkingRowReadIntervalMs(ms: number): void {
  _workingRowReadIntervalMs = ms
}

/** Test-only seam: restore the default evidence read interval. */
export function _resetWorkingRowReadIntervalMs(): void {
  _workingRowReadIntervalMs = WORKING_ROW_READ_INTERVAL_MS
}

/**
 * How long CSCB holds back from a persona whose row reads `working`, typing
 * nothing because it can't prove the session idle, before it reports the
 * persona through the `unproven-idle` not-connected notice (b.f2b), whatever
 * `session_restart_delay` is: measured from the first deferral of the run
 * (`noteWorkingRowDeferral`). Without it, a row whose idleness can't be proven
 * (an unreadable transcript, a compaction summary, a screen that keeps
 * changing) would be held back from for good, silently. Test-only override
 * below.
 */
export const UNPROVEN_IDLE_NOTICE_AFTER_MS = 10 * 60 * 1000

let _unprovenIdleNoticeAfterMs = UNPROVEN_IDLE_NOTICE_AFTER_MS

/** Test-only seam: override how long deferrals on a `working` row run before the `unproven-idle` notice. */
export function _setUnprovenIdleNoticeAfterMs(ms: number): void {
  _unprovenIdleNoticeAfterMs = ms
}

/** Test-only seam: restore the default. */
export function _resetUnprovenIdleNoticeAfterMs(): void {
  _unprovenIdleNoticeAfterMs = UNPROVEN_IDLE_NOTICE_AFTER_MS
}

/** Trailing pane lines read from a `working` row (as `approvePreSessionDialogs` reads). */
const WORKING_PANE_LINES = 40

/** The pane's last lines with text: Claude Code's prompt box, footer and any dialog are drawn there. */
const WORKING_PANE_BOTTOM_LINES = 12

/**
 * Claude Code's spinner line while a turn runs (2.1.280), matched only in its
 * own shape: at column 0 a spinner glyph, a space, the spinner's message, an
 * ellipsis, then the end of the line or ` (` and the turn's status (elapsed
 * time, tokens, thinking), e.g. `✳ Harmonizing… (2m 42s · ↓ 10.1k tokens)`.
 * The message holds no ellipsis and is short: a verb from Claude Code's list
 * (`Harmonizing`, `Fiddle-faddling`), a custom one from the `spinnerVerbs`
 * setting, which can be several words (`🐝 Buzzing about the hive`), or the
 * current task's `activeForm`. The status is left out at first, and in
 * screen-reader mode. The animated glyphs (`·` `✢` `✳` `✶` `✻` `✽`, and `*`
 * on some terminals) start no other line with an ellipsis: a finished turn's
 * line (`✻ Baked for 4m 11s`) has none, and text quoted in a reply is
 * indented.
 * `●` (U+25CF) is the glyph with prefersReducedMotion, but on Linux Claude
 * Code also draws it at column 0 before every reply and tool call (macOS draws
 * `⏺` there), and those lines can hold an ellipsis. So a `●` line counts only
 * as a single word and an ellipsis ending the line, or as any message whose
 * ellipsis is followed by ` (` and a status that starts with an elapsed time,
 * a token arrow or `thinking`/`thought for`; `● Let me check the logs…`,
 * `● Checked the build… (see the thread)` and `● Bash(ls …)` do not. Verified
 * (2026-09-26) against the 2.1.280 binary and live panes, which show custom
 * verbs of an emoji and three words with their status, and `●` reply and tool
 * lines. 2.1.280 no longer prints "esc to interrupt" while a turn runs.
 */
const BUSY_SPINNER_LINE_RE =
  /^(?:[·✢✳✶✻✽*] [^\s…][^…\n]{0,79}…(?: \(.*)?|● [\p{L}\p{M}'’-]{1,40}…|● [^\s…][^…\n]{0,79}… \((?:\d+(?:\.\d+)?[smhd]\b|[↓↑] |thinking|thought for ).*)$/mu

/**
 * Busy hints in the pane's bottom lines, matched case-insensitively: the
 * "esc to interrupt" hint of earlier Claude Code versions and of the
 * capacity-retry line ("to interrupt" also covers a rebound key), and a turn
 * paused on a usage limit ("continuing automatically at … · esc to cancel").
 */
const BUSY_PANE_NEEDLES = ['to interrupt', 'esc to cancel']

/**
 * The static rows Claude Code 2.1.280 draws instead of the spinner while a
 * turn waits on the API, with no glyph, no timer and no interrupt hint,
 * matched case-insensitively in the pane's bottom lines (b.f2b): "No response
 * from the API after 2m · retrying, waiting up to 5m · attempt 2/10" and its
 * fixed second line "A proxy or gateway that buffers…", "Rate limit reached ·
 * Retrying in 7m (resets …) · attempt n/m" (the countdown shows whole minutes
 * from 5 m up, so the row can stay the same for a minute or more), and
 * "Waiting for API response · will retry in …". Each is anchored on Claude
 * Code's own `·` separator or fixed wording, so a reply that mentions a retry
 * does not read busy.
 */
const BUSY_API_RETRY_ROWS: readonly RegExp[] = [
  /no response from the api after [^\n]*·\s*retrying/i,
  /a proxy or gateway that buffers/i,
  /rate limit reached\s*·\s*retrying in/i,
  /waiting for api response\s*·\s*will retry in/i,
  /·\s*attempt \d+\/\d+/i,
]

/**
 * A numbered option line of a Claude Code dialog (2.1.280), its box side
 * (`│`) dropped: an optional `❯` selection cursor, the option's number, a
 * period and its label, e.g. `❯ 1. Yes` or `2. No, and tell Claude what to do
 * differently (esc)`. Group 2 is the number.
 */
const DIALOG_OPTION_LINE_RE = /^(❯\s*)?(\d+)\.\s+\S/

/**
 * Option labels and footers that mark a Claude Code dialog (2.1.280), matched
 * case-insensitively on its option list and the lines below it: the deny
 * option of every tool-permission dialog, the select-menu footers
 * (AskUserQuestion and other pickers) and the pre-session dialogs' options.
 */
const DIALOG_NEEDLES = [
  'tell Claude what to do differently',
  'Enter to select',
  'Enter to confirm',
  ...PRE_SESSION_DIALOG_NEEDLES,
].map((needle) => needle.toLowerCase())

/** What a pane read from a `working` row shows (b.f2b). */
export type WorkingPaneReading = 'prompt' | 'busy' | 'idle' | 'blank'

/** The pane's lines without trailing spaces, and without the blank lines after its last text. */
function paneLines(pane: string): string[] {
  const lines = pane.split('\n').map((line) => line.trimEnd())
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  return lines
}

/** A pane line's text with a dialog box's sides (`│`) dropped, and whether it had a left side. */
function dialogRow(line: string): { text: string; boxed: boolean } {
  const trimmed = line.trim()
  const boxed = trimmed.startsWith('│')
  const text = (boxed ? trimmed.slice(1) : trimmed).replace(/│$/, '').trim()
  return { text, boxed }
}

/**
 * Whether the pane's bottom lines show a Claude Code dialog (b.f2b), anchored
 * to its layout, so an idle screen whose last reply merely quotes a dialog's
 * wording does not count: a numbered option list (an option `1.` and, below
 * it, an option `2.`; description lines may sit between them) with the `❯`
 * selection cursor on one of its options, and, to anchor it, a question line
 * (ending in `?`) above the list, a dialog option or footer
 * (`DIALOG_NEEDLES`) on or below it, or its options drawn inside the dialog's
 * box (`│`).
 */
function paneShowsDialog(bottom: readonly string[]): boolean {
  const rows = bottom.map(dialogRow)
  const optionNumber = (text: string): string | undefined => DIALOG_OPTION_LINE_RE.exec(text)?.[2]
  const first = rows.findIndex((row) => optionNumber(row.text) === '1')
  if (first < 0) return false
  const below = rows.slice(first)
  const options = below.filter((row) => optionNumber(row.text) !== undefined)
  if (!options.some((row) => optionNumber(row.text) === '2')) return false
  if (!options.some((row) => row.text.startsWith('❯'))) return false
  return (
    rows.slice(0, first).some((row) => row.text.endsWith('?')) ||
    below.some((row) => DIALOG_NEEDLES.some((needle) => row.text.toLowerCase().includes(needle))) ||
    options.some((row) => row.boxed)
  )
}

/**
 * Classify a pane read from a `working` (or `waiting`) row (b.f2b): `prompt`
 * when its bottom lines show a dialog (`paneShowsDialog`); else `busy` when it
 * shows Claude Code's spinner line anywhere, or a busy hint or an API retry
 * row in its bottom lines; `blank` when it holds no text; otherwise `idle`. A
 * prompt wins over a busy sign, since a dialog may sit under a running turn's
 * spinner: either way nothing is typed. `idle` is no proof the session is
 * idle: the stale-row rule also needs the transcript (`foldWorkingPaneRun`).
 * Pure.
 */
export function classifyWorkingPane(pane: string): WorkingPaneReading {
  const lines = paneLines(pane)
  if (lines.length === 0) return 'blank'
  const bottomLines = lines.slice(-WORKING_PANE_BOTTOM_LINES)
  if (paneShowsDialog(bottomLines)) return 'prompt'
  if (BUSY_SPINNER_LINE_RE.test(lines.join('\n'))) return 'busy'
  const bottom = bottomLines.join('\n').toLowerCase()
  if (BUSY_PANE_NEEDLES.some((needle) => bottom.includes(needle))) return 'busy'
  if (BUSY_API_RETRY_ROWS.some((row) => row.test(bottom))) return 'busy'
  return 'idle'
}

/** A run of consecutive evidence reads of a `working` row that agree (b.f2b). */
export interface WorkingPaneRun {
  /**
   * `idle`: every read showed the same idle screen and the same, unchanged
   * transcript ending with a completed turn; `prompt`: every read showed a
   * prompt or dialog.
   */
  reading: 'idle' | 'prompt'
  /** The run's first screen (its lines, trailing spaces dropped): an idle run lasts only while it is unchanged. */
  screen: string
  /** An idle run's transcript as its first read saw it: the run lasts only while every read sees it unchanged. */
  transcript?: TranscriptSnapshot
  /** When the run started (epoch ms, the session manager's clock `_now`). */
  since: number
}

/**
 * Fold one evidence read into the current run (b.f2b). This is the
 * positive-idle rule: a pane alone is never idle evidence.
 * - `pane` undefined (the read failed), a `busy` or a `blank` pane ends the
 *   run: no evidence.
 * - A `prompt` pane continues a prompt run, or starts one at `now`; the
 *   transcript plays no part (nothing is typed into a prompt either way).
 * - An `idle` pane is evidence only together with `transcript`, the session's
 *   transcript read with it, ending with a completed turn (`ended`, see
 *   `transcriptTailTurnState`). A transcript that doesn't, can't be located or
 *   read, or wasn't read ends the run. An idle run continues only while both
 *   the screen and the transcript's snapshot (path, device, inode, size,
 *   mtime) are unchanged; otherwise a new idle run starts at `now`.
 * So a row is stale only once the same idle screen and the same ended,
 * unchanged transcript were read at every read across the window. A live
 * turn, an API retry included, never ends its transcript with a completed
 * turn, so it never gives idle evidence, however still its screen. Pure.
 */
export function foldWorkingPaneRun(
  run: WorkingPaneRun | undefined,
  pane: string | undefined,
  now: number,
  transcript?: TranscriptReading,
): WorkingPaneRun | undefined {
  if (pane === undefined) return undefined
  const reading = classifyWorkingPane(pane)
  const screen = paneLines(pane).join('\n')
  if (reading === 'prompt') return run?.reading === 'prompt' ? run : { reading, screen, since: now }
  if (reading !== 'idle' || transcript === undefined || transcript.kind !== 'ended') return undefined
  const unchanged =
    run?.reading === 'idle' &&
    run.screen === screen &&
    run.transcript !== undefined &&
    sameTranscriptSnapshot(run.transcript, transcript.snapshot)
  return unchanged ? run : { reading, screen, transcript: transcript.snapshot, since: now }
}

/** One evidence read of a `working` row (b.f2b). */
interface WorkingRowRead {
  /** The pane; undefined when the read failed. */
  pane: string | undefined
  /** Why the pane read failed (`describeAgentDirectorFailure`, token-safe); set only then. */
  paneFailure?: string
  /** The session's transcript, read only when the pane shows an idle screen. */
  transcript?: TranscriptReading
}

/**
 * Read persona `key`'s pane and, only when it shows an idle screen, its
 * transcript (`readPersonaTranscript`), for one evidence read (b.f2b). Never
 * throws.
 */
async function readWorkingRowEvidence(key: string, configDir: string | undefined): Promise<WorkingRowRead> {
  const read = await readWorkingPane(key)
  if ('failure' in read) return { pane: undefined, paneFailure: read.failure }
  if (classifyWorkingPane(read.pane) !== 'idle') return { pane: read.pane }
  return { pane: read.pane, transcript: await readPersonaTranscript(key, configDir) }
}

/**
 * Read the last lines of persona `key`'s pane (b.f2b): the pane, or the
 * failure as `describeAgentDirectorFailure` renders it (token-safe).
 */
async function readWorkingPane(key: string): Promise<{ pane: string } | { failure: string }> {
  try {
    const r = await withOutageDetection(key, undefined, (client) =>
      client.readPane({ claude_instance_id: personaInstanceId(key), n_lines: WORKING_PANE_LINES }))
    return { pane: r.pane }
  } catch (err) {
    return { failure: describeAgentDirectorFailure(err) }
  }
}

/**
 * The effective claude_config_dir of `persona`, absolute (`<home>/.claude`
 * when none is set), for composing its transcript's path (b.f2b); undefined
 * when the persona isn't known, and then only the row's persisted path is
 * used (`locateTranscript`).
 */
function transcriptConfigDir(persona: Pick<Persona, 'claude_config_dir'> | undefined): string | undefined {
  return persona === undefined ? undefined : resolveClaudeConfigDir(persona.claude_config_dir, spawnHomeDir())
}

/**
 * Read persona `key`'s transcript for idle evidence (b.f2b): fetch its
 * agent-director row (`get`, through `withOutageDetection`), locate the
 * transcript of the row's session (`locateTranscript`: the persisted
 * `jsonl_path`, else the path composed under `configDir`) and read its turn
 * state (`readTranscriptTurnState`). A failed `get`, a row that names no
 * transcript, or a file that can't be read is `unreadable`, with a
 * token-safe reason: no evidence. Never throws.
 */
async function readPersonaTranscript(key: string, configDir: string | undefined): Promise<TranscriptReading> {
  let row: GetResult
  try {
    row = await withOutageDetection(key, undefined, (client) =>
      client.get({ claude_instance_id: personaInstanceId(key) }))
  } catch (err) {
    return { kind: 'unreadable', reason: `reading its agent-director row failed: ${describeAgentDirectorFailure(err)}` }
  }
  const path = locateTranscript(row, configDir)
  if (path === undefined) return { kind: 'unreadable', reason: 'its agent-director row names no transcript for its session' }
  const reading = readTranscriptTurnState(path)
  return reading.kind === 'unreadable' ? { kind: 'unreadable', reason: `"${path}": ${reading.reason}` } : reading
}

/**
 * Why a transcript read with an idle pane gives no idle evidence (b.f2b), for
 * a log line; undefined when it was not read or ends with a completed turn.
 */
function transcriptNoEvidence(transcript: TranscriptReading | undefined): string | undefined {
  if (transcript === undefined) return undefined
  if (transcript.kind === 'unreadable') return `its transcript can't be read: ${transcript.reason}`
  return transcript.kind === 'open' ? `its transcript "${transcript.snapshot.path}" does not end with a completed turn` : undefined
}

/** One launch wait's evidence for a `working` row (b.f2b). */
interface WorkingPaneWatch {
  run: WorkingPaneRun | undefined
  /** When the wait last read the evidence (`_now`); undefined before its first read. */
  lastReadAt: number | undefined
  /** The first failed pane read was logged (later ones are not, for the rest of the wait). */
  readFailureLogged: boolean
  /** The last reason an idle pane's transcript gave no evidence, as logged: a changed reason is logged again. */
  transcriptNote: string | undefined
  /** A prompt run reached the window: logged and reported once for the wait. */
  promptReported: boolean
}

/**
 * The launch wait's evidence check for persona `key`'s `working` row (b.f2b),
 * called on every status poll. It reads the evidence only once
 * `WORKING_ROW_READ_INTERVAL_MS` has passed since its last read (the first
 * poll reads at once), and folds it into the wait's run (`foldWorkingPaneRun`).
 * True once the idle evidence has held for the whole window: the pane has
 * shown the same idle screen and the transcript has ended with a completed
 * turn, unchanged, at every read. The row is stale and the caller reconnects
 * it. A prompt shown for the window is logged and reported (once per wait,
 * through the not-connected notice) and the wait goes on; nothing is typed
 * into it. A failed pane read or an idle pane whose transcript gives no
 * evidence ends the run; the wait's first pane failure and each new
 * transcript reason are logged, and the wait goes on as before.
 */
async function staleWorkingRowIsIdle(
  key: string,
  ref: string,
  config: PersonaConfig,
  watch: WorkingPaneWatch,
): Promise<boolean> {
  const due = _now()
  if (watch.lastReadAt !== undefined && due - watch.lastReadAt < _workingRowReadIntervalMs) return false
  watch.lastReadAt = due
  const read = await readWorkingRowEvidence(key, transcriptConfigDir(config.personas.find((p) => p.key === key)))
  if (read.paneFailure !== undefined && !watch.readFailureLogged) {
    watch.readFailureLogged = true
    console.error(
      `[slack] waitForWaitingAndReconnect: reading the pane of ${ref} failed: ${read.paneFailure} — no idle evidence from it; still waiting for its working row (b.f2b)`,
    )
  }
  const note = transcriptNoEvidence(read.transcript)
  if (note !== undefined && note !== watch.transcriptNote) {
    watch.transcriptNote = note
    console.error(
      `[slack] waitForWaitingAndReconnect: ${ref} reads working and its pane shows an idle screen, but ${note} — no idle evidence; still waiting for its working row (b.f2b)`,
    )
  }
  const now = _now()
  watch.run = foldWorkingPaneRun(watch.run, read.pane, now, read.transcript)
  const run = watch.run
  if (run === undefined || now - run.since < _staleWorkingWindowMs) return false
  const seconds = Math.round((now - run.since) / 1000)
  if (run.reading === 'idle') {
    console.error(
      `[slack] waitForWaitingAndReconnect: ${ref} reads working, but its pane has shown the same idle screen (no busy indicator, no prompt) and its transcript has ended with a completed turn, both unchanged, for ${seconds}s — treating the row as stale and reconnecting (b.f2b)`,
    )
    return true
  }
  if (!watch.promptReported) {
    watch.promptReported = true
    console.error(
      `[slack] waitForWaitingAndReconnect: ${ref} reads working and its pane has shown a prompt or dialog for ${seconds}s — blocked on it; not typing into it, still waiting (answer it in tmux session "${personaTmuxSessionName(key)}") (b.f2b)`,
    )
    notifyPersonaNotConnected(key, { reason: 'blocked-on-prompt', autoRestartDisabled: config.session_restart_delay === 0 })
  }
  return false
}

/**
 * The restart path's evidence for each persona whose row reads `working`
 * (b.f2b): one run per persona, kept across its reconnect attempts, which are
 * minutes apart (`checkWorkingRowPane`). Forgotten when an attempt finds the
 * row in another state or can't read it (`forgetWorkingRowEvidence`), when a
 * read gives no evidence and ends the run, when an idle run concludes and the
 * reconnect is typed, when any launch for the persona starts
 * (`spawnForPersona`), and with the persona's not-connected episode
 * (`forgetNotConnectedEpisode`: it reconnected, became deliverable again, or
 * was torn down).
 */
const workingRowPaneRuns = new Map<string, WorkingPaneRun>()

/**
 * When each persona's current run of deferrals on its `working` row began
 * (b.f2b, on the session manager's clock `_now`): the first time a launch
 * wait or the restart path held back from the row, typing nothing, because it
 * could not prove the session idle (`noteWorkingRowDeferral`). A run goes on
 * across reads and attempts that find no proof, whatever the reason: a busy,
 * changing, blank or unreadable pane, a transcript that doesn't end with a
 * completed turn or can't be read, idle evidence not yet held for the window,
 * a prompt, a failed tmux probe. A failed status call neither extends nor
 * ends it. It ends (`endWorkingRowDeferral`) when the row reads another state,
 * when a reconnect is typed into it, when any launch for the persona starts
 * (the launch's own wait starts a new run), and with the persona's
 * not-connected episode (`forgetNotConnectedEpisode`).
 */
const workingRowDeferredSince = new Map<string, number>()

/**
 * b.f2b: note that CSCB held back from persona `key`'s `working` row once
 * more, typing nothing, because it could not prove the session idle. The
 * first deferral of a run starts it (`workingRowDeferredSince`); once the run
 * has lasted `UNPROVEN_IDLE_NOTICE_AFTER_MS`, the `unproven-idle`
 * not-connected notice is raised, at any `session_restart_delay`, through the
 * shared latch: once per episode, and not at all when another not-connected
 * notice was raised in the episode. `autoRestartDisabled` (`session_restart_delay`
 * is 0) words what happens next; the restart path runs only with auto-restart
 * on. Returns whether it raised the notice; `notifyPersonaNotConnected` logs
 * the line.
 */
export function noteWorkingRowDeferral(key: string, autoRestartDisabled: boolean): boolean {
  const now = _now()
  let since = workingRowDeferredSince.get(key)
  if (since === undefined) {
    since = now
    workingRowDeferredSince.set(key, since)
  }
  const heldMs = now - since
  if (heldMs < _unprovenIdleNoticeAfterMs) return false
  return notifyPersonaNotConnected(key, { reason: 'unproven-idle', autoRestartDisabled, heldMs })
}

/**
 * b.f2b: end persona `key`'s run of deferrals on its `working` row (it read
 * another state, a reconnect was typed into it, or a launch for it started),
 * so a later deferral starts a new run. Silent; other personas are untouched.
 */
export function endWorkingRowDeferral(key: string): void {
  workingRowDeferredSince.delete(key)
}

/** What `checkWorkingRowPane` and `checkWaitingRowPane` tell the restart path's reconnect adapter (b.f2b). */
export type WorkingRowPaneVerdict = 'reconnect' | 'defer'

/**
 * b.f2b — the restart path's check of a persona whose row reads `working` and
 * whose tmux session is alive (the reconnect adapter in `server.ts`). Makes
 * one evidence read (the pane and, when it shows an idle screen, the
 * transcript, located with `persona`'s claude_config_dir; without `persona`
 * only the row's persisted transcript path is used) and folds it into the
 * persona's run, kept across reconnect attempts (`workingRowPaneRuns`):
 * - `reconnect` once the idle evidence has held across reads spanning
 *   `STALE_WORKING_WINDOW_MS`: the same idle screen (no busy indicator, no
 *   prompt) and the same transcript, ended with a completed turn and
 *   unchanged, at every read. The row is stale, and the caller types
 *   `/mcp reconnect`. The run is forgotten.
 * - `defer` otherwise: a busy, blank or unreadable pane, or an idle pane whose
 *   transcript does not end with a completed turn or can't be located or read
 *   (the run ends: no evidence); idle evidence not yet held for the window;
 *   or a prompt or dialog. A prompt shown across reads spanning the window
 *   also raises the `blocked-on-prompt` not-connected notice (once per
 *   episode); nothing is ever typed into a prompt.
 * Each `defer` is one more deferral in the persona's run on its `working` row
 * (`noteWorkingRowDeferral`): once the run has lasted
 * `UNPROVEN_IDLE_NOTICE_AFTER_MS`, the `unproven-idle` notice is raised (once
 * per episode), so a row whose idleness can never be proven is not held back
 * from silently. `reconnect` ends the run. A live turn never ends its
 * transcript with a completed turn, so it is never taken for idle (b.rmy).
 * Logs one line per call; never throws.
 */
export async function checkWorkingRowPane(
  key: string,
  persona?: Pick<Persona, 'claude_config_dir'>,
): Promise<WorkingRowPaneVerdict> {
  const verdict = await workingRowPaneVerdict(key, persona)
  if (verdict === 'reconnect') {
    endWorkingRowDeferral(key)
  } else {
    // The restart path runs only with auto-restart on.
    noteWorkingRowDeferral(key, false)
  }
  return verdict
}

/** `checkWorkingRowPane`'s evidence read and verdict, before its deferral is noted (b.f2b). */
async function workingRowPaneVerdict(
  key: string,
  persona: Pick<Persona, 'claude_config_dir'> | undefined,
): Promise<WorkingRowPaneVerdict> {
  const ref = keyRef(key)
  const read = await readWorkingRowEvidence(key, transcriptConfigDir(persona))
  if (read.pane === undefined) {
    workingRowPaneRuns.delete(key)
    console.error(
      `[slack] reconnectSession: ${ref} is working and reading its pane failed: ${read.paneFailure} — no idle evidence; deferring /mcp reconnect to a later tick (b.f2b/b.rmy)`,
    )
    return 'defer'
  }
  const now = _now()
  const run = foldWorkingPaneRun(workingRowPaneRuns.get(key), read.pane, now, read.transcript)
  if (run === undefined) {
    workingRowPaneRuns.delete(key)
    logNoWorkingRowEvidence(ref, classifyWorkingPane(read.pane), read.transcript)
    return 'defer'
  }
  workingRowPaneRuns.set(key, run)
  const span = now - run.since
  const seconds = Math.round(span / 1000)
  if (run.reading === 'idle') {
    if (span < _staleWorkingWindowMs) {
      console.error(
        `[slack] reconnectSession: ${ref} is working; its pane shows an idle screen (no busy indicator, no prompt) and its transcript ends with a completed turn, both unchanged for ${seconds}s of the ${Math.round(_staleWorkingWindowMs / 1000)}s needed — deferring /mcp reconnect to a later tick, which reads them again (b.f2b)`,
      )
      return 'defer'
    }
    workingRowPaneRuns.delete(key)
    console.error(
      `[slack] reconnectSession: ${ref} reads working, but its pane has shown the same idle screen (no busy indicator, no prompt) and its transcript has ended with a completed turn, both unchanged, for ${seconds}s — treating the row as stale and reconnecting (b.f2b)`,
    )
    return 'reconnect'
  }
  if (span < _staleWorkingWindowMs) {
    console.error(`[slack] reconnectSession: ${ref} is working and its pane shows a prompt or dialog — not typing into it; deferring /mcp reconnect to a later tick (b.f2b/b.rmy)`)
    return 'defer'
  }
  console.error(
    `[slack] reconnectSession: ${ref} reads working and its pane has shown a prompt or dialog for ${seconds}s — blocked on it; not typing into it, deferring /mcp reconnect to a later tick (answer it in tmux session "${personaTmuxSessionName(key)}") (b.f2b)`,
  )
  // The restart path runs only with auto-restart on: `scheduleRestart` arms
  // nothing while `session_restart_delay` is 0.
  notifyPersonaNotConnected(key, { reason: 'blocked-on-prompt', autoRestartDisabled: false })
  return 'defer'
}

/** `checkWorkingRowPane`'s line for a read that gave no evidence and ended the run (b.f2b). */
function logNoWorkingRowEvidence(ref: string, reading: WorkingPaneReading, transcript: TranscriptReading | undefined): void {
  if (reading === 'busy') {
    console.error(`[slack] reconnectSession: ${ref} is working — deferring /mcp reconnect to a later tick (b.9a7/b.rmy)`)
  } else if (reading === 'blank') {
    console.error(`[slack] reconnectSession: ${ref} is working and its pane is blank — no idle evidence; deferring /mcp reconnect to a later tick (b.f2b)`)
  } else {
    console.error(
      `[slack] reconnectSession: ${ref} is working and its pane shows an idle screen, but ${transcriptNoEvidence(transcript) ?? 'its transcript was not read'} — no idle evidence; deferring /mcp reconnect to a later tick (b.f2b/b.rmy)`,
    )
  }
}

/**
 * b.f2b — the restart path's check of a persona whose row reads `waiting`,
 * before the reconnect adapter types `/mcp reconnect`: one pane read. A pane
 * that shows a running turn (`busy`) defers; so does a prompt or dialog,
 * which is never typed into and raises the `blocked-on-prompt` not-connected
 * notice (once per episode). Anything else, a failed read included, lets the
 * reconnect go ahead: the `waiting` row is agent-director's own idle signal.
 * Logs a line for each deferral and for a failed read; never throws.
 */
export async function checkWaitingRowPane(key: string): Promise<WorkingRowPaneVerdict> {
  const ref = keyRef(key)
  const read = await readWorkingPane(key)
  if ('failure' in read) {
    console.error(`[slack] reconnectSession: ${ref} is waiting and reading its pane failed: ${read.failure} — reconnecting on the waiting row alone (b.f2b)`)
    return 'reconnect'
  }
  const reading = classifyWorkingPane(read.pane)
  if (reading === 'busy') {
    console.error(`[slack] reconnectSession: ${ref} is waiting but its pane shows a running turn — deferring /mcp reconnect to a later tick (b.f2b/b.rmy)`)
    return 'defer'
  }
  if (reading === 'prompt') {
    console.error(
      `[slack] reconnectSession: ${ref} is waiting but its pane shows a prompt or dialog — not typing into it; deferring /mcp reconnect to a later tick (answer it in tmux session "${personaTmuxSessionName(key)}") (b.f2b/b.rmy)`,
    )
    notifyPersonaNotConnected(key, { reason: 'blocked-on-prompt', autoRestartDisabled: false })
    return 'defer'
  }
  return 'reconnect'
}

/**
 * b.f2b: true while the restart path holds an idle run for persona `key`'s
 * `working` row that has not yet concluded: one more reconnect attempt can
 * find the row stale and reconnect it. The health check then schedules that
 * attempt the first tick it finds the persona undeliverable, rather than
 * after two. A prompt run does not count: CSCB cannot recover that persona
 * until someone answers the prompt.
 */
export function hasPendingWorkingRowEvidence(key: string): boolean {
  return workingRowPaneRuns.get(key)?.reading === 'idle'
}

/**
 * b.f2b: forget the restart path's evidence for persona `key`'s `working` row
 * (a reconnect attempt found the row in another state or couldn't read it, so
 * the next `working` reading starts afresh). Silent; other personas are
 * untouched.
 */
export function forgetWorkingRowEvidence(key: string): void {
  workingRowPaneRuns.delete(key)
}

// ---------------------------------------------------------------------------
// Cancelling a launch's wait for a `working` row (b.f2b)
// ---------------------------------------------------------------------------

/** A running `waitForWaitingAndReconnect`, which the persona's teardown can cancel (b.f2b). */
interface WorkingRowWait {
  cancelled: boolean
  /** Ends the wait's current poll sleep at once (a no-op between sleeps). */
  wake: () => void
}

/** The running wait of each persona whose launch waits for a `working` row (b.f2b); at most one per persona, like its launch. */
const workingRowWaits = new Map<string, WorkingRowWait>()

/**
 * Personas whose launch in flight has not started its wait for a `working`
 * row yet, but whose teardown already cancelled it (b.f2b): a wait that launch
 * starts is cancelled from its first check. Forgotten when the launch settles
 * (`spawnForPersona`).
 */
const cancelledLaunchWaits = new Set<string>()

/**
 * b.f2b: cancel persona `key`'s launch wait for a `working` row
 * (`waitForWaitingAndReconnect`, up to `WAIT_FOR_WAITING_TIMEOUT_MS`). The
 * persona's teardown calls this, so it does not wait out a launch parked on
 * the row, and neither does the apply that runs it (b.av2 SR-8.6). A running
 * wait wakes from its poll sleep at once, checks the flag after each
 * agent-director call, types nothing and returns `cancelled`; its launch then
 * settles as `not-reconnected`. When a launch for the persona is in flight
 * but has not started its wait yet, a wait it starts later is cancelled from
 * its first check. Logs one line and returns true when it cancelled a
 * running or a coming wait; returns false, silently, when no launch for the
 * persona is in flight or its wait was already cancelled.
 */
export function cancelWorkingRowWait(key: string): boolean {
  const wait = workingRowWaits.get(key)
  if (wait !== undefined) {
    if (wait.cancelled) return false
    wait.cancelled = true
    wait.wake()
    console.error(`[slack] waitForWaitingAndReconnect: ${keyRef(key)} — cancelling its launch's wait for its working row (b.f2b)`)
    return true
  }
  if (!inFlightLaunches.has(key) || cancelledLaunchWaits.has(key)) return false
  cancelledLaunchWaits.add(key)
  console.error(
    `[slack] waitForWaitingAndReconnect: ${keyRef(key)} — its launch in flight will not wait for a working row: any such wait is cancelled at once (b.f2b)`,
  )
  return true
}

/** Sleep `ms` (the wait's poll interval), or until the wait is cancelled (b.f2b). */
function sleepUnlessCancelled(wait: WorkingRowWait, ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(done, ms)
    function done(): void {
      clearTimeout(timer)
      wait.wake = () => {}
      resolve()
    }
    wait.wake = done
  })
}

/** The wait's outcome once its teardown cancelled it (b.f2b): logged, nothing typed. */
function waitCancelled(ref: string): 'cancelled' {
  console.error(`[slack] waitForWaitingAndReconnect: the wait for ${ref} was cancelled (its persona is being torn down) — nothing typed (b.f2b)`)
  return 'cancelled'
}

/** A wait's length for a notice: whole minutes from one minute up, else seconds. */
function describeWaitSpan(ms: number): string {
  return ms >= 60_000 ? `${Math.round(ms / 60_000)} min` : `${Math.round(ms / 1000)} s`
}

/**
 * agent-director states in which the persona's session waits on a question
 * (`ask_user`) or a permission dialog (`check_permission`): nothing is ever
 * typed into them, and a persona left disconnected there is reported as
 * blocked on a prompt (b.f2b).
 */
export const PROMPT_ROW_STATES: ReadonlySet<string> = new Set(['ask_user', 'check_permission'])

/**
 * The not-connected notice for a wait that ended with its session alive and
 * its row in `state` while auto-restart is disabled (b.f2b):
 * `blocked-on-prompt` for `ask_user` or `check_permission` (a prompt is why
 * nothing reconnects it), else `auto-restart-disabled` with `cause`. (The
 * timeout words a `working` row's as `unproven-idle` itself.)
 */
function waitEndedNotice(state: string, cause: string): NotConnectedNotice {
  return PROMPT_ROW_STATES.has(state)
    ? { reason: 'blocked-on-prompt', autoRestartDisabled: true }
    : { reason: 'auto-restart-disabled', cause }
}

/**
 * b.f2b: the wait ends with the persona's session alive but not reconnected.
 * Log what happens next for the restart delay in effect: with auto-restart
 * on, `logHead` and `enabledFollowUp` (the recovery the health check drives);
 * with `session_restart_delay` 0, that nothing will reconnect it, and raise
 * the once-per-episode not-connected `notice`, so the persona is never left
 * down silently. Returns the wait's outcome, `not-reconnected`.
 */
function reportWaitEndedDisconnected(
  key: string,
  config: PersonaConfig,
  logHead: string,
  enabledFollowUp: string,
  notice: NotConnectedNotice,
): 'not-reconnected' {
  if (config.session_restart_delay !== 0) {
    console.error(`${logHead}; ${enabledFollowUp}`)
    return 'not-reconnected'
  }
  console.error(`${logHead}; session_restart_delay is 0, so nothing will reconnect it — the not-connected notice reports it (once per episode) (b.f2b)`)
  notifyPersonaNotConnected(key, notice)
  return 'not-reconnected'
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
 * @returns the sweep's result (this caller's, a shared in-flight one or the
 *   memoized one), or undefined when the sweep failed.
 */
async function reconcileMissingSweep(key: string, logPrefix: string, ref: string = keyRef(key)): Promise<FindMissingResult | undefined> {
  return sharedFindMissingSweep(() => withOutageDetection(key, undefined, (client) => client.findMissing({})), logPrefix, ref)
}

/**
 * The memo and single-flight core of `reconcileMissingSweep`, shared by every
 * findMissing caller. `start` makes the call when no sweep is in flight or
 * memoized: a persona's call through `withOutageDetection`, or the start
 * sweep's direct call (`reconcileKilledPrePersonaRows`), which acts for no
 * persona. Never throws; logs as `reconcileMissingSweep` describes.
 */
async function sharedFindMissingSweep(
  start: () => Promise<FindMissingResult>,
  logPrefix: string,
  ref: string,
): Promise<FindMissingResult | undefined> {
  // Memo hit: a recent successful sweep is still within the TTL. Reuse it.
  if (_findMissingLast && Date.now() - _findMissingLast.at < _findMissingMemoTtlMs) {
    return _findMissingLast.result
  }

  // Single-flight: an in-flight sweep exists — await it rather than starting one.
  // The async wrapper turns a synchronous throw from `start` into a rejection.
  if (!_findMissingInFlight) {
    _findMissingInFlight = (async () => start())()
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
    return r
  } catch (err) {
    // Do NOT memoize failures — clear the in-flight slot so the next caller
    // retries. Log and let the caller proceed with today's behavior.
    if (_findMissingInFlight === inFlight) {
      _findMissingInFlight = null
    }
    const e = err instanceof AgentDirectorError ? err : new AgentDirectorError('findMissing', 'UnknownError', String(err))
    console.error(`[slack] ${logPrefix}: findMissing sweep failed for ${ref}: ${describeAgentDirectorFailure(e)} — proceeding`)
    return undefined
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
 * the frozen `working` row to `missing`, so the restart run's second liveness
 * probe (b.d61) observes `alive === false` and takes the normal kill+relaunch
 * branch at once; if the row still reads alive, a later health-check tick
 * does. The external loop remains belt-and-braces; removing it is a separate
 * operator decision.
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
    `[slack] escalate-dead: ${keyRef(key)} verdict=${verdict} — tmux session provably dead, triggering internal findMissing reconciliation (the restart relaunches it once its row reads dead; ~/startup/find-missing-loop.sh is belt-and-braces)`,
  )
  await reconcileMissingSweep(key, 'escalate-dead')
}

/**
 * b.ecw: the timeout-branch tmux-probe fallback. When the timeout status call
 * throws and AD therefore has nothing to say, key on the tmux SESSION (the only
 * object left) so an AD outage can't manufacture a false 'dead-session' — the
 * b.rmy invariant. `reason` is the log fragment describing why we fell back
 * (e.g. `spawn not found`, `status error ${errName}`): alive →
 * 'not-reconnected' (b.f2b; 'ok' before), which says what happens next for
 * the restart delay in effect (`reportWaitEndedDisconnected`); gone →
 * 'dead-session'.
 */
async function tmuxFallbackVerdict(
  key: string,
  config: PersonaConfig,
  ref: string,
  reason: string,
): Promise<WaitReconnectOutcome> {
  const sessionName = personaTmuxSessionName(key)
  if (await _hasTmuxSession(sessionName)) {
    return reportWaitEndedDisconnected(
      key,
      config,
      `[slack] waitForWaitingAndReconnect: timed out for ${ref} after ${_waitForWaitingTimeoutMs}ms — ${reason}, tmux session alive`,
      'the health check recovers it (b.9a7): during an AD outage the adapter reports alive=false and the tick restarts it; once AD recovers with the row live, the tick sees alive && !connected -> scheduleRestart -> reconnect',
      {
        reason: 'auto-restart-disabled',
        cause: `agent-director could not report its state when CSCB stopped waiting for it, ${describeWaitSpan(_waitForWaitingTimeoutMs)} after launching it`,
      },
    )
  }
  console.error(
    `[slack] waitForWaitingAndReconnect: timed out for ${ref} after ${_waitForWaitingTimeoutMs}ms — ${reason} and tmux session "${sessionName}" is gone — dead session`,
  )
  return 'dead-session'
}

/**
 * Poll `status({claude_instance_id})` until the spawn transitions to
 * `waiting`, then call reconnectMcp. Transitions to live transient states
 * (ask_user, check_permission, pending) return 'not-reconnected' (b.f2b;
 * 'ok' before); recovery is then the health-check tick's job — post-b.9a7 the
 * tick observes the row as alive && !connected and routes it through
 * scheduleRestart -> reconnect. 'ok' now always means `/mcp reconnect` was
 * typed.
 *
 * b.f2b — a stale `working` row. agent-director can leave a row `working`
 * after the turn ended, so while the row reads `working` the wait also reads
 * its evidence, every `WORKING_ROW_READ_INTERVAL_MS` (`staleWorkingRowIsIdle`):
 * the persona's pane and, when that shows an idle screen, the session's
 * transcript. The row is stale only on the positive-idle rule
 * (`foldWorkingPaneRun`): for the whole `STALE_WORKING_WINDOW_MS`, every read
 * showed the same idle screen (no spinner, busy hint, API retry row, prompt
 * or dialog) AND the same transcript, unchanged, ending with a completed turn.
 * Then it reconnects, as the `waiting` branch does. A live turn never ends its
 * transcript with a completed turn, an API retry or stall included (which can
 * hide the spinner and hold the screen still), so it is never taken for idle
 * and never typed into (the b.rmy invariant). A transcript that can't be
 * located or read is no evidence. A pane that shows a prompt or dialog for
 * the window is never typed into either: the wait goes on, and the prompt is
 * logged and reported through the not-connected notice, once. The reconnect
 * is part of the launch, not an auto-restart, so it runs whatever
 * `session_restart_delay` is, like the `waiting` branch's. Each poll that
 * reads the row `working` and doesn't reconnect it is one more deferral in
 * the persona's run on the row (`noteWorkingRowDeferral`), and so is the
 * timeout on a `working` row: once the run has lasted
 * `UNPROVEN_IDLE_NOTICE_AFTER_MS`, the `unproven-idle` notice is raised, at
 * any restart delay (once per episode). Any other state ends the run.
 *
 * b.f2b — every wait that ends without reconnecting a live session (a live
 * transient state, a missing row with a live tmux session, the timeout)
 * returns 'not-reconnected' and says what happens next for the restart delay
 * in effect: with `session_restart_delay` 0 nothing will reconnect the
 * persona, so the not-connected notice is raised (once per episode) instead
 * of claiming the health check will (`reportWaitEndedDisconnected`): the
 * `blocked-on-prompt` notice when the row ended at `ask_user` or
 * `check_permission`, `unproven-idle` when the timeout finds it `working`,
 * the `auto-restart-disabled` one otherwise.
 *
 * b.f2b — a teardown cancels the wait (`cancelWorkingRowWait`). The wait
 * checks after each agent-director call and wakes from its poll sleep at
 * once, types nothing once cancelled, and returns 'cancelled'.
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
 *     call. A `waiting` row is reconnected (b.f2b); a process mid-long-turn
 *     is left alive, 'not-reconnected' (the b.rmy/b.3ce long-turn guard, now
 *     keyed on the process); only a provably-gone process returns
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
): Promise<WaitReconnectOutcome> {
  const wait: WorkingRowWait = { cancelled: cancelledLaunchWaits.has(key), wake: () => {} }
  workingRowWaits.set(key, wait)
  try {
    return await waitForWorkingRow(key, config, ref, wait)
  } finally {
    if (workingRowWaits.get(key) === wait) workingRowWaits.delete(key)
  }
}

/** `waitForWaitingAndReconnect`'s body, with its cancellable `wait` (b.f2b). */
async function waitForWorkingRow(
  key: string,
  config: PersonaConfig,
  ref: string,
  wait: WorkingRowWait,
): Promise<WaitReconnectOutcome> {
  const claude_instance_id = personaInstanceId(key)
  const sessionName = personaTmuxSessionName(key)
  const pollIntervalMs = config.agent_director_poll_interval_ms
  const waitStartedAt = _now()
  const deadline = waitStartedAt + _waitForWaitingTimeoutMs
  const paneWatch: WorkingPaneWatch = {
    run: undefined,
    lastReadAt: undefined,
    readFailureLogged: false,
    transcriptNote: undefined,
    promptReported: false,
  }

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
  if (wait.cancelled) return waitCancelled(ref)
  await reconcileMissingSweep(key, 'waitForWaitingAndReconnect', ref)

  while (_now() < deadline) {
    if (wait.cancelled) return waitCancelled(ref)
    let state: string
    try {
      const r = await withOutageDetection(key, undefined, (client) => client.status({ claude_instance_id }))
      state = r.state
    } catch (err) {
      if (wait.cancelled) return waitCancelled(ref)
      if (err instanceof ErrSpawnNotFound) {
        // b.c3o: spawn-not-found means the AD row is gone — same class as
        // `missing`. Only the tmux session's actual existence decides the
        // verdict, mirroring the timeout branch's own ErrSpawnNotFound
        // sub-branch below.
        if (await _hasTmuxSession(sessionName)) {
          return reportWaitEndedDisconnected(
            key,
            config,
            `[slack] waitForWaitingAndReconnect: spawn not found for ${ref} but tmux session alive — aborting poll`,
            'the health check reads the missing row as dead and relaunches the persona',
            { reason: 'auto-restart-disabled', cause: 'agent-director has no record of its session, though its tmux session is alive' },
          )
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
    if (wait.cancelled) return waitCancelled(ref)
    // b.f2b: a run of deferrals on the `working` row ends with any other state.
    if (state !== 'working') endWorkingRowDeferral(key)

    if (state === 'waiting') {
      return reconnectMcp(key, ref)
    }

    if (state === 'working') {
      // b.f2b: a stale row — the positive-idle rule held for the whole window
      // (the same idle screen and the same ended, unchanged transcript) — is
      // reconnected like a `waiting` one.
      const stale = await staleWorkingRowIsIdle(key, ref, config, paneWatch)
      if (wait.cancelled) return waitCancelled(ref)
      if (stale) {
        endWorkingRowDeferral(key)
        return reconnectMcp(key, ref)
      }
      // b.f2b: held back again; a run that has lasted
      // UNPROVEN_IDLE_NOTICE_AFTER_MS raises the unproven-idle notice.
      noteWorkingRowDeferral(key, config.session_restart_delay === 0)
      await sleepUnlessCancelled(wait, pollIntervalMs)
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
    // (ask_user, check_permission, pending) still fall through to
    // 'not-reconnected' below (b.f2b).
    if (state === 'ended' || state === 'missing') {
      console.error(`[slack] waitForWaitingAndReconnect: ${ref} transitioned to state=${state} (claude process gone) — dead session`)
      return 'dead-session'
    }

    return reportWaitEndedDisconnected(
      key,
      config,
      `[slack] waitForWaitingAndReconnect: ${ref} transitioned to state=${state} — aborting`,
      'the health check reconnects it (tick sees alive && !connected on two ticks -> scheduleRestart -> reconnect, b.9a7; an ask_user or check_permission row is never typed into, b.f2b)',
      waitEndedNotice(state, `it moved to state ${state} while CSCB waited to reconnect it`),
    )
  }

  // b.ecw: timed out — key on the claude PROCESS via AD, not the raw tmux
  // session. The up-front sweep's 10s memo has long expired at the 10-minute
  // deadline, so run a FRESH reconcileMissingSweep (a real whole-store
  // findMissing) to reconcile a row frozen at `working`, then one status call.
  // - ended/missing → the process is provably gone → 'dead-session'.
  // - waiting → the turn ended at the deadline: reconnect (b.f2b).
  // - any other live state (working/ask_user/check_permission/pending) → a
  //   process merely mid-long-turn is left alive, 'not-reconnected' (b.f2b;
  //   'ok' before) (b.rmy/b.3ce long-turn guard, now keyed on the process
  //   rather than the tmux session).
  // - ErrSpawnNotFound → the AD row is gone and AD has nothing to say, so fall
  //   back to the tmux session (the only object left to key on), exactly like
  //   the poll loop's ErrSpawnNotFound branch: alive → 'not-reconnected', gone
  //   → 'dead-session'.
  // - any other status error → fall back to the raw tmux probe (today's
  //   verdict) so an AD outage can't manufacture a false 'dead-session' — the
  //   b.rmy invariant that only a provably-gone session may go 'dead-session'.
  if (wait.cancelled) return waitCancelled(ref)
  await reconcileMissingSweep(key, 'waitForWaitingAndReconnect: timeout', ref)
  if (wait.cancelled) return waitCancelled(ref)
  let timeoutState: string
  try {
    const r = await withOutageDetection(key, undefined, (client) => client.status({ claude_instance_id }))
    timeoutState = r.state
  } catch (err) {
    if (wait.cancelled) return waitCancelled(ref)
    if (err instanceof ErrSpawnNotFound) {
      return tmuxFallbackVerdict(key, config, ref, 'spawn not found')
    }
    // Any other status error — including ErrSystemInstallDisappeared /
    // ErrTmuxNotAvailable, which the poll loop returns 'failed' for. At the
    // timeout deadline a probe-based verdict is deliberately preferred: it's
    // safe (probe-alive → 'not-reconnected' preserves the b.rmy invariant that only a
    // provably-gone session goes 'dead-session') and simpler than propagating
    // 'failed' through here.
    const e = err instanceof AgentDirectorError ? err : new AgentDirectorError('status', 'UnknownError', String(err))
    return tmuxFallbackVerdict(key, config, ref, `status error ${describeAgentDirectorFailure(e)}`)
  }
  if (wait.cancelled) return waitCancelled(ref)

  if (timeoutState !== 'working') endWorkingRowDeferral(key)
  if (timeoutState === 'ended' || timeoutState === 'missing') {
    console.error(
      `[slack] waitForWaitingAndReconnect: timed out for ${ref} after ${_waitForWaitingTimeoutMs}ms — claude process state=${timeoutState} (gone) — dead session`,
    )
    return 'dead-session'
  }
  // b.f2b: the row settled at the deadline — reconnect, as the loop would have.
  if (timeoutState === 'waiting') return reconnectMcp(key, ref)
  // b.f2b: a `working` row given up on is one more deferral: a run that has
  // lasted UNPROVEN_IDLE_NOTICE_AFTER_MS raises the unproven-idle notice, at
  // any restart delay.
  let notice = waitEndedNotice(
    timeoutState,
    `its agent-director row still read ${timeoutState} ${describeWaitSpan(_waitForWaitingTimeoutMs)} after launch, and CSCB found no proof it was idle`,
  )
  if (timeoutState === 'working') {
    const heldMs = _now() - (workingRowDeferredSince.get(key) ?? waitStartedAt)
    noteWorkingRowDeferral(key, config.session_restart_delay === 0)
    notice = { reason: 'unproven-idle', autoRestartDisabled: true, heldMs }
  }
  // b.f2b: say what actually happens next for the restart delay in effect.
  // With auto-restart on, the health check schedules the reconnect, whose
  // adapter types `/mcp reconnect` into a `working` row only on the
  // positive-idle rule across attempts, and never into a prompt
  // (b.9a7/b.rmy); with `session_restart_delay` 0 nothing reconnects it, so
  // the not-connected notice is raised (once per episode: not again after a
  // prompt or unproven-idle report).
  return reportWaitEndedDisconnected(
    key,
    config,
    `[slack] reconnect: gave up waiting for ${ref} after ${_waitForWaitingTimeoutMs}ms — claude process state=${timeoutState} (alive)`,
    `the health check schedules a reconnect once it has seen the persona disconnected on two ticks; for a working row it types /mcp reconnect only once its pane has shown the same idle screen and its transcript has ended with a completed turn, both unchanged, across attempts, and never into a prompt, and it reports the persona once CSCB has held back from the row for ${describeWaitSpan(_unprovenIdleNoticeAfterMs)} (b.9a7/b.rmy/b.f2b)`,
    notice,
  )
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
    /** `/mcp reconnect` was typed into the persona's live session. */
    | 'reconnected'
    /**
     * b.f2b: the persona's row read `working`, and the wait for it to settle
     * ended with its session alive but nothing typed
     * (`waitForWaitingAndReconnect`'s `not-reconnected`; the wait logged what
     * happens next), or its teardown cancelled the wait (`cancelled`). Not a
     * failure: the session runs, so it is counted with the
     * succeeded personas and `launchSession` maps it to true, as it did when
     * this outcome was reported as `reconnected` (SR-25.1 counting unchanged).
     */
    | 'not-reconnected'
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
 * runs `tmux kill-session -t =<name>` best-effort (tmux missing or the session
 * absent is ignored).
 *
 * b.vub: the field failure is an orphan tmux session that survives the AD row
 * going `missing` — the AD `client.kill` verb does NOT reap it (observed across
 * dozens of restart cycles). Killing the session directly by its deterministic,
 * per-persona name (`personaTmuxSessionName`) is the only reliable reap.
 *
 * b.1ix: the target is exact (`=<name>`). A bare name is resolved by prefix
 * when no session has that exact name, so `slack_bot_dev` would kill persona
 * `dev_2`'s `slack_bot_dev_2`. The kill is still not ownership-checked: a
 * session someone made by hand with this exact name is killed too. The b.fmk
 * CSCB version removes this kill (agent-director's classified spawn and
 * resume replace it).
 */
export type TmuxSessionKiller = (sessionName: string) => Promise<void>

const defaultKillTmuxSession: TmuxSessionKiller = async (sessionName: string): Promise<void> => {
  await _runTmux(['kill-session', '-t', tmuxExactSessionTarget(sessionName)])
}

let _killTmuxSession: TmuxSessionKiller = defaultKillTmuxSession

/** Test-only seam: override the tmux-session killer. */
export function _setTmuxSessionKiller(fn: TmuxSessionKiller): void {
  _killTmuxSession = fn
}

/** Test-only seam: restore the default tmux-session killer. */
export function _resetTmuxSessionKiller(): void {
  _killTmuxSession = defaultKillTmuxSession
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

/** Test-only seam: forget every in-flight launch (and, b.f2b, every cancel of a wait one had not started). */
export function _resetInFlightLaunches(): void {
  inFlightLaunches.clear()
  cancelledLaunchWaits.clear()
}

/**
 * True while a launch (collision ladder) for persona `key` is in flight
 * (b.av2 SR-6.6). The restart module's kill adapter consults this so a restart
 * that is about to join a running launch does not first kill the session that
 * launch is bringing up. The health check skips such a persona (b.f2b): a
 * start launch still waiting in the background for a `working` row owns its
 * session until it settles.
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
 *    - waiting → reconnectMcp; 'dead-session' → resume/fresh-spawn (b.3ce;
 *      b.dup: a row ended or marked missing before the keystrokes landed).
 *    - working → waitForWaitingAndReconnect; 'dead-session' → resume/fresh-spawn (b.3ce);
 *      'not-reconnected' or 'cancelled' (its teardown cancelled the wait) →
 *      `not-reconnected` (b.f2b: nothing was typed; `reconnected` only when
 *      `/mcp reconnect` was). `hooks.onWorkingRowWait` is called as the wait
 *      starts (b.f2b).
 *    - pending/check_permission/ask_user → no-op.
 *    Every resume first checks the row's `config_dir` label; a missing or
 *    different label means delete + fresh spawn instead (resumeOrFreshSpawn).
 *    A directory that stopped resolving since step 2 keeps the row and
 *    returns `deferred` instead.
 * 6. Other errors → surface to Slack + (when isStartup) startup-errors.log.
 *
 * `hooks` belong to the ladder this call starts; a call that joins a launch
 * already in flight gets none of them.
 */
export async function spawnForPersona(
  persona: Persona,
  config: PersonaConfig,
  isStartup = true,
  hooks?: LaunchHooks,
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
  // b.f2b: the restart path's idle evidence for an earlier `working` row says
  // nothing about the session this launch brings up (and must not let the
  // health check skip its two-tick guard while it boots), and the launch's own
  // wait, if any, starts its own run of deferrals on the row.
  forgetWorkingRowEvidence(key)
  endWorkingRowDeferral(key)
  const launch = runPersonaLadder(persona, config, isStartup, ref, configDirLabel, hooks)
  inFlightLaunches.set(key, launch)
  try {
    return await launch
  } finally {
    if (inFlightLaunches.get(key) === launch) {
      inFlightLaunches.delete(key)
      // b.f2b: a teardown's cancel of this launch's wait ends with it.
      cancelledLaunchWaits.delete(key)
    }
  }
}

/** A caller's view into the collision ladder one `spawnForPersona` call starts (b.f2b). */
export interface LaunchHooks {
  /**
   * Called once, as the ladder starts waiting for a `working` row to settle
   * (`waitForWaitingAndReconnect`, up to `WAIT_FOR_WAITING_TIMEOUT_MS`). The
   * start pass stops waiting for the launch here and lets it finish in the
   * background; the launch stays in flight until it settles. Must not throw.
   */
  onWorkingRowWait?: () => void
}

/** One collision ladder for a persona; `spawnForPersona` single-flights it per key. */
async function runPersonaLadder(
  persona: Persona,
  config: PersonaConfig,
  isStartup: boolean,
  ref: string,
  configDirLabel: string,
  hooks: LaunchHooks | undefined,
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
    // giving up. b.dup: so does a row agent-director ended or marked missing
    // after the `get` above read it `waiting` (a findMissing sweep, e.g. from
    // another persona's launch wait, landed before the keystrokes).
    const outcome = await reconnectMcp(key, ref)
    if (outcome === 'dead-session') {
      console.error(`[slack] spawnForPersona: dead session for ${ref} (state=waiting) — recovering via resume/fresh-spawn`)
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
    // the `waiting` branch. waitForWaitingAndReconnect returns 'ok' once it
    // typed `/mcp reconnect`; 'not-reconnected' (b.f2b) on live transient
    // transitions and whenever the claude PROCESS is verifiably alive at the
    // deadline (a long turn isn't an error); 'dead-session' when the process is
    // provably gone (ended/missing, or the timeout sweep + status verdict —
    // b.ecw; or its reconnect was refused because the row had just been
    // ended or marked missing — b.dup) or the tmux session provably doesn't
    // exist (spawn-not-found — b.c3o).
    // b.f2b: the wait can take up to WAIT_FOR_WAITING_TIMEOUT_MS; tell the
    // caller (the start pass lets the launch go on in the background).
    hooks?.onWorkingRowWait?.()
    const outcome = await waitForWaitingAndReconnect(key, config, ref)
    if (outcome === 'dead-session') {
      console.error(`[slack] spawnForPersona: dead session for ${ref} (state=working) — recovering via resume/fresh-spawn`)
      return resumeOrFreshSpawn(persona, params, config, isStartup, row, { reconcileMissingFirst: true })
    }
    // b.f2b: report the real outcome, not `reconnected`. A wait its persona's
    // teardown cancelled typed nothing either, and its session is left to
    // the teardown.
    if (outcome === 'not-reconnected' || outcome === 'cancelled') return { key, action: 'not-reconnected' }
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

/** What the start sweep did. */
export interface OrphanReconcileResult {
  /** Rows swept: each killed, then deleted. Pre-persona rows are never swept. */
  found: number
  /** Swept rows deleted. */
  killed: number
  /** Swept rows whose delete failed. */
  failed: number
  /** Pre-persona rows (no `persona` label), all kept (b.1ix). */
  prePersona: PrePersonaSweepCounts
}

/**
 * The start sweep's pre-persona rows (b.1ix): all kept; each live one is
 * killed at this start, then one findMissing sweep lets a killed row whose
 * session is gone read `missing`, so a later start doesn't kill it again.
 */
export interface PrePersonaSweepCounts {
  /** Pre-persona rows listed. Every one is kept. */
  kept: number
  /** Those in a live state (`AGENT_DIRECTOR_LIVE_STATES`), each given one kill call at this start. */
  live: number
  /** Live ones whose kill failed. */
  killFailed: number
}

/** A start sweep that did nothing (dry run, or a failed list). */
function emptySweepResult(): OrphanReconcileResult {
  return { found: 0, killed: 0, failed: 0, prePersona: { kept: 0, live: 0, killFailed: 0 } }
}

/**
 * What the start sweep does with a row that has a `persona` label (b.av2
 * SR-6.3, SR-6.4): `sweep` it with a reason, `keep` it, or keep it with its
 * `cwd` check `deferred` to the persona's launch. A row is kept only when its
 * label names an applied persona, its instance ID is that persona's
 * `cscb_<key>`, and its `cwd` matches the persona's working directory by real
 * path. When that working directory cannot be resolved to a real path (a
 * directory-broken persona) and the row's `cwd` has no real path either or
 * equals the configured path lexically (`cwdCheckDeferred`), the `cwd`
 * condition cannot be evaluated and is deferred; the other conditions still
 * apply. A row whose `cwd` resolves to an existing directory is swept as
 * `wrong cwd`. A row with no `persona` label never gets here: see
 * `keepPrePersonaRow`.
 */
function sweepDecision(
  row: ListRow,
  persona: Persona | undefined,
  home: string,
): { action: 'sweep'; reason: string } | { action: 'keep' } | { action: 'deferred'; persona: Persona } {
  if (!persona) return { action: 'sweep', reason: 'absent persona' }
  if (row.claude_instance_id !== personaInstanceId(persona.key)) return { action: 'sweep', reason: 'wrong instance ID' }
  const comparison = compareRowToPersona(row, persona, home)
  if (comparison.cwdCheckDeferred) return { action: 'deferred', persona }
  if (!comparison.cwdMatches) return { action: 'sweep', reason: 'wrong cwd' }
  return { action: 'keep' }
}

/**
 * The start sweep's handling of a pre-persona row, one with no `persona`
 * label (b.1ix; the rows a build that predates personas made, instance IDs
 * `cscb_<name>_<channel>`): the row is kept, never deleted. Its ID is never a
 * persona's `cscb_<key>`, so no launch reuses or resumes it, and keeping it is
 * harmless. A row in a live state gets one kill call at this start and the
 * kill's result logged; an `ended` or `missing` row is left alone, with no
 * call and no line. Returns whether it called `kill`.
 *
 * agent-director 0.10.0's `kill` doesn't change the row's state, so a killed
 * row would still read live at every later start and be killed again each
 * time. `reconcileOrphans` therefore runs one findMissing sweep after the
 * kills (`reconcileKilledPrePersonaRows`): a row whose session is gone then
 * reads `missing`, and later starts leave it alone. A row whose session is
 * still there stays live and is killed again at the next start.
 *
 * Why no delete: agent-director 0.10.0's `kill` can report success while the
 * session lives on, and a deleted row would leave that session running with
 * no row to find it by (the incident pattern, at the upgrade to personas the
 * whole fleet at once). The upgrade runbook stops the old build's bots first
 * and has an operator confirm with `tmux ls` that none is left.
 *
 *   [slack] reconcileOrphans: pre-persona row (no persona label) instanceId=<id> state=<state> tmux_session=<name> is live — killing it; the row is kept (a pre-persona row is never deleted)
 *   [slack] reconcileOrphans: kill reported success for pre-persona row instanceId=<id> — row kept; a reported success does not prove tmux session <name> is gone
 *
 * A failed kill records `orphan-cleanup` (`kill failed for pre-persona row
 * instanceId=<id>: <errName> message="…"; row kept, its session may still be
 * running`).
 */
async function keepPrePersonaRow(client: Client, row: ListRow, counts: PrePersonaSweepCounts): Promise<boolean> {
  counts.kept++
  if (!AGENT_DIRECTOR_LIVE_STATES.has(row.state)) return false
  counts.live++
  const id = row.claude_instance_id
  console.error(
    `[slack] reconcileOrphans: pre-persona row (no persona label) instanceId=${id} state=${row.state} tmux_session=${row.tmux_session_name} is live — killing it; the row is kept (a pre-persona row is never deleted)`,
  )
  try {
    await client.kill({ claude_instance_id: id })
  } catch (err) {
    counts.killFailed++
    const e = err instanceof AgentDirectorError ? err : new AgentDirectorError('kill', 'UnknownError', String(err))
    recordStartupError(
      'orphan-cleanup',
      `kill failed for pre-persona row instanceId=${id}: ${describeAgentDirectorFailure(e)}; row kept, its session may still be running`,
    )
    return true
  }
  console.error(
    `[slack] reconcileOrphans: kill reported success for pre-persona row instanceId=${id} — row kept; a reported success does not prove tmux session ${row.tmux_session_name} is gone`,
  )
  return true
}

/**
 * After the start sweep's kills of live pre-persona rows (b.1ix), run one
 * findMissing sweep, so each killed row whose session is gone reads `missing`
 * and is not killed again at the next start (agent-director 0.10.0's `kill`
 * leaves the row's state as it was). It runs after a failed kill too: the
 * session may be gone all the same, and only the sweep would tell.
 *
 * It is the memoized, single-flight sweep every findMissing caller shares
 * (`sharedFindMissingSweep`, b.m4r). The start sweep runs before any launch
 * and before the health check, so no earlier sweep in this process can be
 * reused; the launches right after it reuse this one within its TTL. The call
 * goes to the start sweep's client directly, as its list and kills do: it acts
 * for no persona, so no persona's outage flag is raised or cleared. Never
 * throws. The sweep's own line, then one line with the outcome for the killed
 * rows (`still-live` holds each the sweep did not mark missing, an unverified
 * one included):
 *
 *   [slack] reconcileOrphans: findMissing sweep for killed pre-persona rows — count=<n> ids=[…] unverified=<n> unverified_ids=[…]
 *   [slack] reconcileOrphans: findMissing after the kills of <n> live pre-persona row(s): missing=<n> [<ids>] still-live=<n> [<ids>] — a row that still reads live is killed again at the next start
 *
 * or, when the sweep fails, its failure line and:
 *
 *   [slack] reconcileOrphans: findMissing after the kills of <n> live pre-persona row(s) failed — they still read live and are killed again at the next start
 */
async function reconcileKilledPrePersonaRows(client: Client, killedIds: string[]): Promise<void> {
  const head = `[slack] reconcileOrphans: findMissing after the kills of ${killedIds.length} live pre-persona row(s)`
  const r = await sharedFindMissingSweep(() => client.findMissing({}), 'reconcileOrphans', 'killed pre-persona rows')
  if (!r) {
    console.error(`${head} failed — they still read live and are killed again at the next start`)
    return
  }
  const nowMissing = new Set(r.ids)
  const missing = killedIds.filter((id) => nowMissing.has(id))
  const stillLive = killedIds.filter((id) => !nowMissing.has(id))
  console.error(
    `${head}: missing=${missing.length} [${missing.join(',')}] still-live=${stillLive.length} [${stillLive.join(',')}] — a row that still reads live is killed again at the next start`,
  )
}

/**
 * Kill, then delete, one row the start sweep swept. A failed kill still
 * attempts the delete (b.fmk replaces this with no delete after a kill that
 * didn't succeed). Returns whether the delete succeeded; each failure records
 * `orphan-cleanup`.
 */
async function killAndDeleteSweptRow(client: Client, row: ListRow, displayPersona: string): Promise<boolean> {
  const id = row.claude_instance_id
  try {
    await client.kill({ claude_instance_id: id })
  } catch (err) {
    const e = err instanceof AgentDirectorError ? err : new AgentDirectorError('kill', 'UnknownError', String(err))
    recordStartupError('orphan-cleanup', `kill failed for orphan instanceId=${id} persona=${displayPersona}: ${describeAgentDirectorFailure(e)}`)
  }
  try {
    await client.delete({ claude_instance_id: [id] })
    return true
  } catch (err) {
    const e = err instanceof AgentDirectorError ? err : new AgentDirectorError('delete', 'UnknownError', String(err))
    recordStartupError('orphan-cleanup', `delete failed for orphan instanceId=${id} persona=${displayPersona}: ${describeAgentDirectorFailure(e)}`)
    return false
  }
}

/**
 * Start sweep (b.av2 SR-6.3; formerly SR-1.6): enumerate every `service=cscb`
 * spawn.
 *
 * A pre-persona row (no `persona` label) is kept, never deleted, and killed
 * only when it is live (`keepPrePersonaRow`, b.1ix). When at least one was
 * killed, one findMissing sweep follows the loop, so a killed row whose
 * session is gone reads `missing` and the next start leaves it alone
 * (`reconcileKilledPrePersonaRows`).
 *
 * Every other row is swept, killed and then deleted, when it
 *   - names a persona absent from the applied configuration (the kill and
 *     delete stay until b.fmk: agent-director 0.10.0 has no reuse, and a
 *     persona added again must start fresh),
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
 * kill of a swept row still attempts the delete; kill and delete failures
 * record `orphan-cleanup`, a list failure records `orphan-cleanup-list-failed`
 * and does not block startup. One summary line ends the sweep:
 *
 *   [slack] reconcileOrphans: found=<n> killed=<n> failed=<n>; pre-persona rows kept=<n> live=<n> kill-failed=<n>
 */
export async function reconcileOrphans(
  personaConfig: PersonaConfig,
): Promise<OrphanReconcileResult> {
  if (isDryRun()) {
    console.error('[slack] dry-run: skipping orphan reconciliation')
    return emptySweepResult()
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
    return emptySweepResult()
  }

  const personasByKey = new Map(personaConfig.personas.map((p) => [p.key, p]))
  const home = spawnHomeDir()
  const result = emptySweepResult()
  const deferredLogged = new Set<string>()
  const killedPrePersonaIds: string[] = []

  for (const row of rows) {
    const personaLabel = row.labels?.[PERSONA_LABEL_KEY]
    if (!personaLabel) {
      if (await keepPrePersonaRow(client, row, result.prePersona)) killedPrePersonaIds.push(row.claude_instance_id)
      continue
    }
    const persona = personasByKey.get(personaLabel)
    const decision = sweepDecision(row, persona, home)
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

    result.found++
    // The persona reference when the persona exists, else the raw label value.
    const displayPersona = persona ? personaRef(persona) : personaLabel
    const cwdDetail = reason === 'wrong cwd' ? ` cwd=${row.cwd}` : ''
    console.error(
      `[slack] reconcileOrphans: sweeping row (${reason}) persona=${displayPersona} instanceId=${row.claude_instance_id} state=${row.state}${cwdDetail} — killing and deleting`,
    )
    if (await killAndDeleteSweptRow(client, row, displayPersona)) result.killed++
    else result.failed++
  }

  if (killedPrePersonaIds.length > 0) await reconcileKilledPrePersonaRows(client, killedPrePersonaIds)

  const { found, killed, failed, prePersona } = result
  console.error(
    `[slack] reconcileOrphans: found=${found} killed=${killed} failed=${failed}; pre-persona rows kept=${prePersona.kept} live=${prePersona.live} kill-failed=${prePersona.killFailed}`,
  )
  return result
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
 * One persona's start outcome: a spawn outcome; not brought up (steps 1–3:
 * `broken` or `retrying`) with its causes; or, b.f2b, a launch still waiting
 * in the background for its `working` row to settle when the pass returned.
 */
export type StartupPersonaOutcome =
  | { key: string; action: SpawnPersonaResult['action'] }
  | {
    key: string
    action: 'not-brought-up'
    outcome: Exclude<PersonaBringUpOutcome, 'up'>
    failures: PersonaBringUpFailure[]
  }
  | { key: string; action: 'waiting-in-background' }

/** b.f2b: a start launch parked while it waits for a `working` row to settle. */
const WAITING_IN_BACKGROUND = 'waiting-in-background'

/** A start launch's result as the start pass sees it (b.f2b). */
type StartLaunchResult = SpawnPersonaResult | typeof WAITING_IN_BACKGROUND

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
  /** `/mcp reconnect` typed into a live session. */
  reconnected: number
  /**
   * b.f2b: `not-reconnected` launches — the session runs, but the wait for
   * its `working` row ended with nothing typed. Counted in `succeeded` too,
   * as when they were reported as reconnected.
   */
  notReconnected: number
  noop: number
  /**
   * b.f2b: launches still waiting in the background for a `working` row to
   * settle when the pass returned; counted in no other field. Each stays in
   * flight (`isLaunchInFlight`) until it settles, and its outcome is logged
   * then.
   */
  waitingInBackground: number
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
 * launch has settled or is waiting for a `working` row: a `broken` or
 * `retrying` persona is not brought up and never takes a pool slot (its
 * retries run on its own timers, and a retry that succeeds launches it from
 * there). It is counted apart from spawn outcomes, records no startup error,
 * posts no notice and is not a failed spawn. Without `options.bringUp` each
 * persona is launched directly (steps 1–3 skipped), in config order through
 * the same pool; only unit tests of the launch ladder call it that way.
 *
 * b.f2b — one stuck persona must not hold up the others. A launch whose
 * collision ladder starts waiting for a `working` row to settle
 * (`waitForWaitingAndReconnect`, up to `WAIT_FOR_WAITING_TIMEOUT_MS`) is
 * parked: the pass stops waiting for it and frees its pool slot, and the
 * launch goes on in the background. It is reported as `waiting-in-background`
 * (`waitingInBackground`), stays in flight until it settles (so the health
 * check skips it, a restart joins it and a teardown waits for it, as for any
 * launch in flight), and its outcome is logged when it settles. So the health
 * check and the reload detection tick, which start once the pass returns, are
 * not held up by one persona's wait (b.av2 SR-8.2 keeps its intent: every
 * persona's bring-up has read its credentials by then).
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
  let notReconnected = 0
  let noop = 0
  let waitingInBackground = 0

  function tally(action: SpawnPersonaResult['action']): void {
    switch (action) {
      case 'failed':
        failed++
        break
      case 'resumed':
        resumed++
        succeeded++
        break
      case 'not-reconnected':
        notReconnected++
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
   * brought up (recorded here). `waiting-in-background` once the launch
   * waits for a `working` row (b.f2b): its pool slot is freed then.
   */
  async function launchPersona(persona: Persona): Promise<StartLaunchResult | undefined> {
    if (bringUp) {
      const started = await bringUp.bringUp(persona, personas)
      if (started.outcome !== 'up') {
        perPersona.push({ key: persona.key, action: 'not-brought-up', outcome: started.outcome, failures: started.failures })
        notBroughtUp++
        return undefined
      }
    }
    return launchSlot(() => launchOrPark(persona, config))
  }

  async function processPersona(persona: Persona): Promise<void> {
    try {
      const result = await launchPersona(persona)
      if (result === undefined) return
      if (result === WAITING_IN_BACKGROUND) {
        perPersona.push({ key: persona.key, action: WAITING_IN_BACKGROUND })
        waitingInBackground++
        return
      }
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
  // (fresh-after-inconclusive-amnesia: we could not tell). b.f2b: a session
  // left running but not reconnected has its own bucket, last, so the line up
  // to `not brought up` reads as before.
  console.error(
    `[slack] startupSessionManager: complete — ${personas.length} persona(s): ${resumed} resumed, ` +
      `${freshSpawned} fresh-spawned, ${freshAfterAmnesia} fresh-after-amnesia, ` +
      `${freshAfterInconclusiveAmnesia} fresh-after-inconclusive-amnesia, ` +
      `${reconnected} reconnected, ${noop} no-op, ${failed} failed, ${notBroughtUp} not brought up, ` +
      `${notReconnected} not reconnected`,
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
  if (waitingInBackground > 0) {
    console.error(
      `[slack] startupSessionManager: ${waitingInBackground} persona(s) still waiting in the background for a working row ` +
        `to settle — not counted above; each logs its outcome when it settles (b.f2b)`,
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
    notReconnected,
    noop,
    waitingInBackground,
    perPersona,
  }
}

/**
 * b.f2b: one start launch, or `waiting-in-background` as soon as its
 * collision ladder starts waiting for a `working` row to settle. From then on
 * the launch goes on in the background, in flight until it settles, and
 * `followParkedLaunch` logs its outcome. A launch that rejects before that
 * rejects here, as before.
 */
async function launchOrPark(persona: Persona, config: PersonaConfig): Promise<StartLaunchResult> {
  let park: () => void = () => {}
  const parked = new Promise<typeof WAITING_IN_BACKGROUND>((resolve) => {
    park = () => resolve(WAITING_IN_BACKGROUND)
  })
  const launch = spawnForPersona(persona, config, true, { onWorkingRowWait: () => park() })
  const first = await Promise.race([launch, parked])
  if (first === WAITING_IN_BACKGROUND) followParkedLaunch(persona, launch)
  return first
}

/**
 * b.f2b: log that the start pass goes on without a parked launch, and its
 * outcome once it settles: its `SpawnPersonaResult` action, so `reconnected`
 * only when `/mcp reconnect` was typed and `not-reconnected` when the wait
 * gave up with the session alive (the wait's own line says what happens
 * next). A rejection is logged and recorded as the start pass records one;
 * never rethrown.
 */
function followParkedLaunch(persona: Persona, launch: Promise<SpawnPersonaResult>): void {
  const ref = personaRef(persona)
  console.error(
    `[slack] startupSessionManager: ${ref} is waiting for its working row to settle — the start pass goes on without it; its launch stays in flight in the background (b.f2b)`,
  )
  launch.then(
    (result) => console.error(`[slack] startupSessionManager: background launch for ${ref} settled: ${result.action} (b.f2b)`),
    (err: unknown) => {
      // Token-safe, as in the start pass: only the describer's output.
      const cause = describeThrownValue(err)
      console.error(`[slack] startupSessionManager: unexpected error in the background launch for ${ref}: ${cause}`)
      recordStartupError('spawn-failed', `unexpected error spawning ${ref}: ${cause}`)
    },
  )
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
 * not-reconnected / no-op; b.f2b: `not-reconnected` counts as it did when it
 * was reported as `reconnected`, so SR-25.1 counting is unchanged), false on
 * `failed` or when no applied persona has the key, and
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
