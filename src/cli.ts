#!/usr/bin/env bun
/**
 * cli.ts — Command-line entry point for the Slack Channel Router.
 *
 * Subcommands:
 *   start          — Check that the configuration file exists, launch the
 *                    server in the background, and report an early startup
 *                    failure of the daemon.
 *   stop           — Send SIGTERM to a running server via its PID file.
 *                    `--stop-bots` first runs the precheck, then stops the
 *                    server and exits every configured persona's instance.
 *   clean_restart  — Run the precheck, then stop the server, exit every
 *                    configured persona's instance and start the server;
 *                    after a failed teardown, start it only once
 *                    agent-director answers.
 *   credentials    — `credentials <persona>`: write that persona's
 *                    credentials file from the operator's terminal, by
 *                    running the packaged `scripts/write-credentials.sh`
 *                    (b.av2 SR-12, SR-1.4 part).
 *   clear-latch    — `clear-latch <persona>`: clear that persona's latch on
 *                    the running server, through one `POST /clear-latch` to
 *                    `127.0.0.1` at the port in `server.port` (b.jg5 SRJ-509,
 *                    SRJ-510). For the operator only: nothing offers it to a
 *                    bot (SRJ-511).
 *
 * `clear-latch` checks the PID file as `stop` does (`readServerPid`): an
 * absent, unreadable or stale PID file is "no server is running". It uses
 * `server.port` only when the PID it records is the running server's, and
 * never the configuration file or the last-applied record. It waits for the
 * answer at most CLEAR_LATCH_WAIT_MS on the injected clock: a wait that runs
 * out is the "did not confirm" line, since the clear may still run in the
 * persona's turn. It makes no agent-director call, loads no configuration,
 * writes and removes no file and never repeats its argument. Each outcome
 * prints one line to stderr (`CLEAR_LATCH_USAGE` and the `clearLatchCli*Line`
 * builders) and exits 2 (usage), 1 or 0.
 *
 * `start`, `stop` and `clean_restart` take their settings and persona set from
 * the configuration the server runs (b.av2 SR-8.7): the last-applied record
 * beside the configuration file (`resolveServerConfigPath`) when it exists,
 * otherwise the configuration file (`readAppliedPersonaConfig`).
 * `stop --stop-bots` and `clean_restart` read it before they initialize the
 * agent-director client (`initClient`, production `initProductionClient`),
 * which is built with its `agent_director_call_timeout_ms`, or the default
 * when `stop --stop-bots` cannot read it (b.jg5 SRJ-213); `clean_restart`
 * stops on an unreadable configuration before building any client.
 *
 * Before either stops anything, `stop --stop-bots` and `clean_restart` run
 * the precheck (b.jg5 SRJ-901): the client's initialization, then per persona
 * of that configuration one `get` of its row and, for a live row, one
 * one-line `read-pane`, decided by `precheckVerdictOf` (`src/cli-teardown.ts`).
 * A failed precheck stops neither the server nor any persona: the command
 * prints its lines, ending `<command>: nothing was stopped`, and exits 1.
 * The precheck latches nothing and writes no file. After a passed precheck
 * the server is stopped, then every persona torn down; `clean_restart` then
 * starts the server, or, after a failed teardown, checks that agent-director
 * answers first (below). `stop --stop-bots` with an unreadable configuration
 * has no per-persona step: it stops the server and skips the teardown.
 *
 * Personas are torn down in parallel, and once every persona has settled
 * each persona's report is written in configuration order (b.jg5 SRJ-907,
 * SRJ-909; `personaTeardownReportOf`, `src/cli-teardown.ts`): a persona that
 * could not be stopped gets its failure line, followed by the kill-failure
 * alert's ordinary version where its outcome's alert decision says so; a
 * persona stopped after a survivor-naming kill failure gets the alert's
 * survivor version instead and counts as stopped. Each line is printed
 * (stderr; for `clean_restart` through its fatal path, so it reaches the
 * terminal once and `clean_restart.log` once), appended to `server.log` in
 * the state directory (`appendServerLogLine`), and recorded in
 * `startup-errors.log` with no copy on the terminal
 * (`recordStartupErrorEntry`): `persona-kill-failed`, `cli-teardown-failed`
 * or `persona-kill-survivor`. Both writes are best effort and change no exit
 * status. When any persona failed, the command ends with the last line
 * (`teardownNotStoppedLine`), printed only, and exits 1. Nothing is posted
 * to Slack and nothing latches (b.jg5 SRJ-1002).
 *
 * After the teardown (b.jg5 SRJ-905, SRJ-906):
 *   - `stop --stop-bots` never starts the server: with a failed persona it
 *     exits 1 and the server stays stopped; otherwise it exits with the
 *     server stop's code;
 *   - `clean_restart` with every persona stopped (a persona stopped with the
 *     survivor version included) starts the server, with no answer check,
 *     and exits as `start` does;
 *   - `clean_restart` with a failed persona checks that agent-director
 *     answers: one `list` of `service=cscb` rows (`directorList`) succeeds
 *     within PRECHECK_TRIES calls PRECHECK_TRY_SPACING_MS apart on the
 *     injected clock, any error a failed try (`callWithCliTries`, the CLI's
 *     one source of those tries). If it answers, the server is started, a
 *     failed start printing its start-failed line; if not, the server is not
 *     started (b.qwo) and the not-restarted alert
 *     (`cleanRestartNotRestartedAlert`) is printed, appended to `server.log`
 *     and recorded as one `clean-restart-not-restarted` entry. The last line
 *     follows that outcome, and the exit is 1 either way. Rows are never
 *     deleted.
 *
 * `clean_restart`'s initialization runs the whole startup gate, CSCB's
 * Phase 1 floor included, and any failure of it stops nothing (b.jg5
 * SRJ-203). `stop --stop-bots`'s initialization leaves the floor out, so the
 * command makes no version check of its own, and has three outcomes (b.jg5
 * SRJ-902):
 *   - it passes on any binary the client accepts, one below CSCB's floor
 *     included, and the precheck and teardown run through that client;
 *   - the client refuses the binary as too old (the gate's refusal kind,
 *     never its label or message): no agent-director call can be made, so
 *     the server alone is stopped, with no precheck and no teardown; the
 *     command prints the initialization-failed line carrying the gate's
 *     too-old message, then `onlyServerStoppedLine`, and exits 1 whatever
 *     the server's stop returned, with the configuration read or not;
 *   - any other failure is a precheck failure: nothing is stopped, the
 *     initialization-failed line and `<command>: nothing was stopped` are
 *     printed, and the exit is 1.
 *
 * `credentials` reads the configuration file as it stands
 * (`loadPersonaConfig`), where a persona being added is declared before any
 * confirmation. The CLI never writes any reload file, and this process reads
 * no Slack token and no credentials file (b.av2 SR-10.2): the server reads
 * each persona's credentials file, and the credentials script, run as a child
 * on the operator's terminal, reads the tokens at its own no-echo prompts.
 *
 * SPDX-License-Identifier: MIT
 */

import { join, resolve } from 'path'
import { closeSync, existsSync, fstatSync, openSync, readFileSync, readSync, statSync, unlinkSync } from 'fs'
import { spawn, spawnSync } from 'child_process'
import { isProcessRunning } from './pid.ts'
import {
  CLEAR_LATCH_COMMAND,
  dialClearLatch,
  parseClearLatchAnswer,
  readServerPortRecord,
  removeServerPortRecord,
  serverPortFilePath,
  type ClearLatchDialAnswer,
} from './clear-latch.ts'
import {
  agentDirectorCallTimeoutMsOf,
  loadPersonaConfig,
  resolveServerConfigPath,
  resolveServerStateDir,
  type Persona,
  type PersonaConfig,
} from './config.ts'
import { readAppliedPersonaConfig, reloadFilePaths } from './reload.ts'
import { appendLogLine, initLogging, type AppendLogLineResult } from './logging.ts'
import { recordStartupError } from './startup-errors.ts'
import { ERR_SPAWN_NOT_FOUND_NAME } from './agent-director-errors.ts'
import { hasAdErrorName } from './ad-error-class.ts'
import { checkedKill, type PlainKillParams } from './checked-kill.ts'
import { killRetrySeedOfState, runKillRetry, type KillRetryRead } from './kill-retry.ts'
import type { Phase1GetResult } from './ad-phase1-types.ts'
import { describeThrownValue } from './persona-connection-errors.ts'
import { getClient } from './agent-director-client.ts'
import type { Client, ListRow } from 'agent-director'
import { SERVICE_LABEL, personaInstanceId, personaKey, renderPersonaRef, resolvePersonaTarget } from './persona-identity.ts'
import { REFUSAL_KIND_CLIENT_TOO_OLD, runStartupGate } from './agent-director-startup.ts'
import type { StartupGateDeps, StartupGateOptions, StartupGateRefusalKind } from './agent-director-startup.ts'
import { PROBE_PANE_READ_LINES } from './pane-read.ts'
import {
  CLEAN_RESTART_NOT_RESTARTED_LABEL,
  CLI_COMMAND_CLEAN_RESTART,
  CLI_COMMAND_STOP_BOTS,
  PRECHECK_CALL_GET,
  PRECHECK_CALL_READ_PANE,
  PRECHECK_TRIES,
  PRECHECK_TRY_SPACING_MS,
  PRECHECK_VERDICT_PASS,
  PRECHECK_VERDICT_RETRY,
  PRECHECK_VERDICT_SKIP,
  PAUSE_VERDICT_DONE,
  PAUSE_VERDICT_FAIL,
  PAUSE_VERDICT_RETRY,
  STATE_READ_VERDICT_ABSENT,
  STATE_READ_VERDICT_FAIL,
  STATE_READ_VERDICT_LIVE,
  TEARDOWN_OUTCOME_FAILED,
  TEARDOWN_POLL_FIRST_WAIT_MS,
  TEARDOWN_POLL_MAX_WAIT_MS,
  TEARDOWN_STEP_PAUSE,
  TEARDOWN_STEP_POLL,
  TEARDOWN_STEP_STATE_READ,
  TEARDOWN_STOPPED_ALREADY_FINISHED,
  TEARDOWN_STOPPED_EXITED,
  TEARDOWN_STOPPED_NO_ROW,
  TEARDOWN_KILL_OPTIONS,
  TEARDOWN_KILL_RETRY_OPTIONS,
  agentDirectorInitFailedLine,
  answerCheckFailedTryLine,
  cleanRestartNotRestartedAlert,
  cleanRestartStartFailedLine,
  cleanRestartStartingAfterFailedTeardownLine,
  exitTimeoutMsOf,
  onlyServerStoppedLine,
  pauseVerdictAfterLastTry,
  personaTeardownReportOf,
  pauseVerdictOf,
  precheckFailureLine,
  precheckNothingStoppedLine,
  precheckVerdictOf,
  stateReadVerdictOf,
  teardownErrorReportOf,
  teardownFailed,
  teardownKillOutcomeOf,
  teardownKillReadOf,
  teardownNotStoppedLine,
  teardownRejectedOutcomeOf,
  teardownStopped,
  type CleanRestartFailedPersona,
  type CliTeardownCommand,
  type CliTeardownStartupErrorEntry,
  type PauseAnswer,
  type PauseVerdict,
  type PersonaTeardownOutcome,
  type PrecheckAnswer,
  type PrecheckFailure,
  type PrecheckRow,
  type PrecheckVerdict,
  type StateReadAnswer,
  type StateReadVerdict,
} from './cli-teardown.ts'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * How long `start` waits for the daemon it spawned to get past startup
 * (b.av2 SR-1.7, SR-8.7): long enough for the agent-director startup gate,
 * the configuration load and the template refresh that precede the PID file.
 */
export const DAEMON_STARTUP_WAIT_MS = 30_000

/** How often `start` checks the daemon while it waits. */
export const DAEMON_STARTUP_POLL_MS = 100

/** How often `stop` checks whether the server has exited, after SIGTERM and after SIGKILL. */
export const STOP_POLL_MS = 100

/** How long `stop` waits for the server to die after SIGKILL. */
export const STOP_KILL_WAIT_MS = 2000

/** Most `server.log` lines `start` repeats when the daemon exits during startup. */
export const DAEMON_FAILURE_LOG_LINES = 20

/**
 * The packaged credentials script `credentials` runs (b.av2 SR-12): shipped
 * in the npm package (package.json `files`) beside `src/`.
 */
export const CREDENTIALS_SCRIPT_PATH = resolve(import.meta.dir, '..', 'scripts', 'write-credentials.sh')

/** `credentials`' usage line, printed with exit 2 when it is not given exactly one persona. */
export const CREDENTIALS_USAGE = 'Usage: claude-slack-channel-bots credentials <persona name or key>'

// ---------------------------------------------------------------------------
// The usage text
// ---------------------------------------------------------------------------

/** `clear-latch`'s entry in the usage text (b.jg5 SRJ-509). */
export const CLEAR_LATCH_USAGE_ENTRY =
  `  ${CLEAR_LATCH_COMMAND}    <persona name or key>: clear a persona's latch ` +
  '(a session conflict, an unusable recorded name or a launch with no recorded start) on the running server'

/**
 * The usage text, one line per entry: printed to stderr, line by line, when
 * the entry point gets no subcommand or one it does not accept, before it
 * exits 1. It lists every subcommand the entry point accepts and `stop`'s one
 * flag, and nothing else (b.av2 SR-8.8: no reload gesture is advertised).
 */
export const CLI_USAGE_LINES: readonly string[] = Object.freeze([
  `Usage: cli.ts <start|stop|clean_restart|credentials|${CLEAR_LATCH_COMMAND}> [flags]`,
  '',
  '  start          Validate prerequisites and start the server in the background',
  '  stop           Send SIGTERM to a running server',
  '  clean_restart  Exit all managed sessions, then stop and start the server',
  "  credentials    <persona name or key>: write that persona's credentials file from this terminal",
  CLEAR_LATCH_USAGE_ENTRY,
  '',
  'stop flags:',
  '  --stop-bots    Gracefully exit all managed bots before stopping the server',
])

// ---------------------------------------------------------------------------
// clear-latch's lines and wait (b.jg5 SRJ-509, SRJ-510)
// ---------------------------------------------------------------------------

/** `clear-latch`'s usage line, printed with exit 2 when it is not given exactly one non-empty argument. */
export const CLEAR_LATCH_USAGE = `Usage: claude-slack-channel-bots ${CLEAR_LATCH_COMMAND} <persona name or key>`

/**
 * How long `clear-latch` waits for the server's answer, on the CLI's injected
 * clock (`CliDeps.now`, `CliDeps.sleep`). A wait that runs out is the "did
 * not confirm" line, whose "30 s" is this value: the route answers once the
 * clear has run in the persona's lifecycle serializer turn, so a busy turn
 * can outlast the wait, and the clear it received still runs.
 */
export const CLEAR_LATCH_WAIT_MS = 30_000

/** No server is running: the PID file is absent, unreadable or stale, as `stop` reads it. Pure. */
export function clearLatchCliNoServerLine(): string {
  return `${CLEAR_LATCH_COMMAND}: no server is running`
}

/**
 * The server cannot be reached; `cause` is a `server.port` read's cause
 * (`SERVER_PORT_CAUSE_*`), a failed connection described by
 * `describeThrownValue`, or an unexpected answer's status
 * (`clearLatchStatusCause`). Pure.
 */
export function clearLatchCliNotAnsweredLine(cause: string): string {
  return `${CLEAR_LATCH_COMMAND}: the server did not answer: ${cause}`
}

/** The cause of an answer other than 200 or 404, or of a malformed 200: the status, never the body. Pure. */
export function clearLatchStatusCause(status: number): string {
  return `HTTP ${status}`
}

/** No answer within CLEAR_LATCH_WAIT_MS: the clear may still run. Pure. */
export function clearLatchCliNotConfirmedLine(): string {
  return (
    `${CLEAR_LATCH_COMMAND}: the server did not confirm within ${CLEAR_LATCH_WAIT_MS / 1000} s; ` +
    "the clear is queued and may still run. Check this persona's latch in the server log before trying again."
  )
}

/** No applied persona has the name or key; the argument is never repeated. Pure. */
export function clearLatchCliNoPersonaLine(): string {
  return `${CLEAR_LATCH_COMMAND}: no persona in the running configuration has that name or key`
}

/** The persona named `name` in the server's answer was latched and is cleared; its key is `personaKey(name)`. Pure. */
export function clearLatchCliClearedLine(name: string): string {
  return `${CLEAR_LATCH_COMMAND}: cleared the latch of persona ${renderPersonaRef(name, personaKey(name))}`
}

/** The persona named `name` in the server's answer was not latched; its key is `personaKey(name)`. Pure. */
export function clearLatchCliNotLatchedLine(name: string): string {
  return `${CLEAR_LATCH_COMMAND}: persona ${renderPersonaRef(name, personaKey(name))} was not latched; nothing changed`
}

// ---------------------------------------------------------------------------
// Daemon child
// ---------------------------------------------------------------------------

/** Options `start` spawns the daemon with (b.acn: detached, no inherited stdio). */
export interface DaemonSpawnOptions {
  detached: true
  stdio: ['ignore', number, number]
  env: NodeJS.ProcessEnv
}

/** The part of a spawned daemon child that `start` uses. */
export interface DaemonChild {
  /** Undefined when the spawn failed (an `error` event follows). */
  readonly pid?: number
  unref(): void
  once(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown
  once(event: 'error', listener: (err: Error) => void): unknown
}

// ---------------------------------------------------------------------------
// Injectable dependency interface
// ---------------------------------------------------------------------------

/**
 * The startup gate's options a caller of `initClient` may set (b.jg5
 * SRJ-203): every `StartupGateOptions` field but the call timeout, which
 * `initClient` takes as its own argument.
 */
export type InitClientGateOptions = Omit<StartupGateOptions, 'callTimeoutMs'>

export interface CliDeps {
  /** Run a command and return its exit code (or null if spawn failed). */
  spawnSync: (cmd: string, args: string[]) => { status: number | null }
  /** Spawn the detached server daemon (`start`'s parent path). */
  spawnDaemon: (cmd: string, args: string[], opts: DaemonSpawnOptions) => DaemonChild
  /** Open a file for appending (creating it) and return its descriptor: the daemon's `server.log`. */
  openLogAppend: (path: string) => number
  /** Close a descriptor `openLogAppend` returned. */
  closeFd: (fd: number) => void
  /**
   * Redirect console.error / console.log to a log file (`initLogging` in
   * production): the daemon child's `server.log`, clean_restart's
   * `clean_restart.log`. May throw; both callers treat a failure as non-fatal.
   */
  initLogging: (path: string) => void
  /** Check whether a file path exists. */
  existsSync: (path: string) => boolean
  /** Read a file as UTF-8 text. */
  readFileSync: (path: string) => string
  /** Size of a file in bytes; 0 when it cannot be read. */
  fileSize: (path: string) => number
  /** A file's bytes from `offset` to the end, as UTF-8 text; '' when it cannot be read. */
  readFileFrom: (path: string, offset: number) => string
  /** Current time in milliseconds (the clock of the daemon startup wait, `stop`'s exit polls, the precheck's tries, the teardown's pause tries, poll and kill tries, `clean_restart`'s answer check, and `clear-latch`'s `CLEAR_LATCH_WAIT_MS` wait for the server's answer). */
  now: () => number
  /** Resolve after `ms` milliseconds (the clock of the daemon startup wait, `stop`'s exit polls, the precheck's tries, the teardown's pause tries, poll and kill tries, `clean_restart`'s answer check, and `clear-latch`'s `CLEAR_LATCH_WAIT_MS` wait for the server's answer). */
  sleep: (ms: number) => Promise<void>
  /** Remove a file. */
  unlinkSync: (path: string) => void
  /** Check whether a PID corresponds to a running process. */
  isProcessRunning: (pid: number) => boolean
  /** Kill a process with the given signal. */
  kill: (pid: number, signal: string | number) => void
  /** The server's state directory (`resolveServerStateDir` in production). */
  resolveStateDir: () => string
  /** The configuration file the server loads (`resolveServerConfigPath` in production). */
  resolveConfigPath: () => string
  /** Launch the server. Resolves when server startup completes (or throws). */
  startServer: () => Promise<void>
  /** Exit the process. */
  exit: (code: number) => never
  /**
   * The configuration the server runs, for the configuration file at `path`
   * (`readAppliedPersonaConfig` in production, b.av2 SR-8.7): the last-applied
   * record beside it when one exists, otherwise the file itself. Throws the
   * start's wording on failure: a record that cannot be read or validated is
   * named with the deletion hint (never falling back to the file), and a
   * file error carries the loader's message, including its conversion error
   * for a pre-persona file (b.av2 SR-1.7). Never writes any reload file.
   */
  loadConfig: (path: string) => PersonaConfig
  /**
   * The configuration file at `path` as it stands, never the last-applied
   * record (`loadPersonaConfig` in production): `credentials` finds its
   * persona there, so a persona declared but not yet confirmed is found.
   * Throws the loader's error, which names the file and never echoes a
   * credential value (b.av2 SR-10.3). Reads no credentials file.
   */
  loadConfigFile: (path: string) => PersonaConfig
  /**
   * Run the packaged credentials script (`CREDENTIALS_SCRIPT_PATH`) with bash
   * for `credentialsFile`, on this process's terminal (stdio inherited), and
   * return its exit status: the script reads the tokens at its own no-echo
   * prompts, so they never pass through this process or any command line.
   * Returns 1 when the script is missing or bash cannot be run, after
   * printing why.
   */
  runCredentialsScript: (credentialsFile: string) => number
  /**
   * b.qwo: initialize the agent-director Client singleton before the precheck
   * and any per-persona teardown work (b.jg5 SRJ-901 step 1). clean_restart /
   * `stop --stop-bots` run in a short-lived CLI process that never runs the
   * server startup gate, so getClient() would throw (the b.qps root cause).
   * Production wires this to {@link initProductionClient}, the non-exiting
   * runStartupGate variant; on failure the caller exits loudly
   * (AD-unreachable is never a silent skip): clean_restart stops nothing,
   * and `stop --stop-bots` stops nothing unless the client refused the binary
   * as too old (b.jg5 SRJ-902). Optional so tests that install a stub
   * singleton via setClientForTests can omit it — when absent, callers skip
   * init and use the already-installed stub.
   *
   * `callTimeoutMs` is the client's call timeout (b.jg5 SRJ-213): the
   * configuration's `agent_director_call_timeout_ms` (its default when the
   * configuration omits it), or the default when `stop --stop-bots` could not
   * read the configuration. Both commands read the configuration before this.
   *
   * `gateOptions` are the startup gate's behaviour options (b.jg5 SRJ-203).
   * Only `stop --stop-bots` passes any: the option that leaves CSCB's Phase 1
   * floor out, so it makes no version check of its own and any binary the
   * client accepts passes. Absent, the whole gate runs, as for clean_restart.
   */
  initClient?: (callTimeoutMs: number, gateOptions?: InitClientGateOptions) => Promise<void>
  /**
   * The precheck's read of a persona's row (b.jg5 SRJ-901): one `get` of its
   * instance ID (`cscb_<key>`), answering the row's state, `liveness_note` and
   * launch start. Returns null only when the row is absent (ErrSpawnNotFound,
   * by name); every other error propagates for the precheck to classify.
   * Latches, records and logs nothing.
   */
  directorGet: (instanceId: string) => Promise<PrecheckRow | null>
  /**
   * The precheck's one-line read of a persona's live row (b.jg5 SRJ-901,
   * SRJ-117): one `read-pane` of its instance ID (`cscb_<key>`) asking for
   * `nLines` trailing lines, answering the pane. Every error propagates,
   * ErrSpawnNotFound included, for the precheck to classify. Latches,
   * records and logs nothing.
   */
  directorReadPane: (instanceId: string, nLines: number) => Promise<string>
  /**
   * Query the agent-director state of a persona's instance, addressed by its
   * instance ID (`cscb_<key>`). Returns null only when the row is absent
   * (ErrSpawnNotFound, by name); every other error propagates for the
   * teardown to classify (b.qwo).
   */
  directorStatus: (instanceId: string) => Promise<{ state: string } | null>
  /**
   * Politely shut down a persona's instance (`cscb_<key>`) via client.pause.
   * Every error propagates, ErrSpawnNotFound included, for the teardown to
   * classify (b.jg5 SRJ-903).
   */
  directorPause: (instanceId: string) => Promise<void>
  /**
   * One plain `kill` of a persona's instance (`cscb_<key>`) via client.kill,
   * with the instance ID alone: never `include_finished` (b.jg5 SRJ-106,
   * SRJ-904). Answers the client's kill result as given, `kill_sent` true,
   * false or absent, and rejects with every error unchanged, ErrSpawnNotFound
   * included: the teardown's checked kill (`checkedKill`,
   * `src/checked-kill.ts`) is the one place that decides what the result or
   * the error means, a result with no `kill_sent` (a binary older than
   * Phase 1, reached only by `stop --stop-bots`) being a plain success
   * (b.jg5 SRJ-110, SRJ-902).
   */
  directorKill: (instanceId: string) => Promise<unknown>
  /**
   * `clean_restart`'s answer check after a failed teardown (b.jg5 SRJ-906):
   * one `list` filtered by the service label alone (`SERVICE_LABEL`,
   * `service=cscb`), answering the rows as given, finished rows included.
   * Every error propagates unchanged; the caller counts any of them as a
   * failed try. Latches, records and writes nothing.
   */
  directorList: () => Promise<readonly ListRow[]>
  /**
   * Append one line to `server.log` in the state directory, in the server
   * log's `[<ISO time>] <text>` form at `at` (ms since the epoch, from
   * `now`), through the shared rotation (`appendLogLine`, `src/logging.ts`,
   * in production on `resolveServerStateDir()`'s `server.log`). The CLI
   * writes it while the server is stopped (b.jg5 SRJ-909). Answers whether
   * the line was written; best effort: a failure (answered or thrown) is
   * reported in one line and changes no exit status. Writes nothing else.
   */
  appendServerLogLine: (line: string, at: number) => AppendLogLineResult
  /**
   * Record one `startup-errors.log` entry of `classLabel` with `message` in
   * the state directory, with no copy on fd 2, since the CLI prints each
   * line itself (`recordStartupError` with `logDir` the resolved state
   * directory and `omitStderr`, in production; b.jg5 SRJ-909, SRJ-1013).
   * Best effort: a throw is reported in one line and changes no exit status.
   * Writes nothing else: no reload file, no retired-key record.
   */
  recordStartupErrorEntry: (classLabel: string, message: string) => void
  /**
   * `clear-latch`'s one request (b.jg5 SRJ-510): `POST /clear-latch` of
   * `{ "persona": <persona> }` to `127.0.0.1` at `port` (`dialClearLatch`,
   * `src/clear-latch.ts`, in production), answering the status and the body
   * text, or rejecting when the connection or the body read fails. It sets
   * no timeout of its own: the handler bounds the wait at CLEAR_LATCH_WAIT_MS
   * on `now` and `sleep`. Logs nothing.
   */
  dialClearLatch: (port: number, persona: string) => Promise<ClearLatchDialAnswer>
}

// ---------------------------------------------------------------------------
// The PID file, read as `stop` reads it (b.jg5 SRJ-509)
// ---------------------------------------------------------------------------

/** The PID file does not exist. */
export const SERVER_PID_ABSENT = 'absent'
/** The PID file could not be read, or does not start with a number. */
export const SERVER_PID_UNREADABLE = 'unreadable'
/** The PID file names a process that is not running. */
export const SERVER_PID_STALE = 'stale'
/** The PID file names a running process: the server. */
export const SERVER_PID_RUNNING = 'running'

/**
 * What the PID file says about the server. An unreadable file's `error` is
 * what the read threw, or the invalid-PID error for text that is not a number.
 */
export type ServerPidRead =
  | { readonly kind: typeof SERVER_PID_ABSENT }
  | { readonly kind: typeof SERVER_PID_UNREADABLE; readonly error: unknown }
  | { readonly kind: typeof SERVER_PID_STALE; readonly pid: number }
  | { readonly kind: typeof SERVER_PID_RUNNING; readonly pid: number }

/** The calls the PID file's read makes, in `CliDeps`'s shape. */
export type ServerPidReadDeps = Pick<CliDeps, 'existsSync' | 'readFileSync' | 'isProcessRunning'>

/**
 * Read the PID file at `pidFile`: absent; unreadable (a failed read, or text
 * whose start is not a number); stale (its process is not running); or
 * running, with the PID. The one reading `stop` and `clear-latch` share
 * (b.jg5 SRJ-509): it only reads, and each caller decides what to print and
 * what to remove. A throw from `existsSync` or `isProcessRunning` propagates.
 */
export function readServerPid(pidFile: string, deps: ServerPidReadDeps): ServerPidRead {
  if (!deps.existsSync(pidFile)) return { kind: SERVER_PID_ABSENT }
  let pid: number
  try {
    const raw = deps.readFileSync(pidFile).trim()
    pid = parseInt(raw, 10)
    if (isNaN(pid)) throw new Error(`invalid PID: ${raw}`)
  } catch (error) {
    return { kind: SERVER_PID_UNREADABLE, error }
  }
  return deps.isProcessRunning(pid) ? { kind: SERVER_PID_RUNNING, pid } : { kind: SERVER_PID_STALE, pid }
}

// ---------------------------------------------------------------------------
// CSCB-authored failures (b.av2 SR-10.3)
// ---------------------------------------------------------------------------

/**
 * The agent-director startup gate's failure, as the production `initClient`
 * throws it. Its message is the gate's own class label and message
 * (`runStartupGate`), which CSCB builds and which name versions, paths and the
 * fix, never a token, so a failure line prints it rather than only describing
 * the error: it is the operator's diagnosis. `refusalKind` is the gate
 * outcome's refusal kind (`client-too-old`, `below-phase1-floor`, `other`),
 * so a caller branches on which check refused, never on the class label or
 * the message text (b.jg5 SRJ-203).
 */
export class StartupGateFailedError extends Error {
  constructor(
    readonly classLabel: string,
    detail: string,
    readonly refusalKind: StartupGateRefusalKind,
  ) {
    super(`agent-director startup gate failed (${classLabel}): ${detail}`)
    this.name = 'StartupGateFailedError'
  }
}

/**
 * The tail of a CLI failure line: the message of a failure CSCB authored
 * ({@link StartupGateFailedError}), else `describeThrownValue` of the thrown
 * value (its message only through `redactSlackLogText`).
 */
function describeCliFailure(err: unknown): string {
  if (err instanceof StartupGateFailedError) return err.message
  return describeThrownValue(err)
}

/**
 * True when `err` is the startup gate's failure for the client's own too-old
 * refusal (b.jg5 SRJ-902): decided by its refusal kind alone, never by its
 * class label or its message (SRJ-203).
 */
function isClientTooOldRefusal(err: unknown): boolean {
  return err instanceof StartupGateFailedError && err.refusalKind === REFUSAL_KIND_CLIENT_TOO_OLD
}

// ---------------------------------------------------------------------------
// Tries on the CLI's injected clock (b.jg5 SRJ-908)
// ---------------------------------------------------------------------------

/**
 * One agent-director call of the CLI, made again while its answer asks for
 * another try: at most PRECHECK_TRIES calls, PRECHECK_TRY_SPACING_MS apart,
 * each wait through `sleep` (the CLI's injected clock, `CliDeps.sleep`;
 * b.jg5 SRJ-908), and no wait after the last call. Answers the last answer;
 * the caller decides what an answer that still asks for another try means.
 * The one source of the CLI's "3 calls 2 s apart" tries: the precheck's
 * `get` and `read-pane` and the teardown's `pause` retry while their verdict
 * is UNAVAILABLE (b.jg5 SRJ-901, SRJ-903), and `clean_restart`'s answer
 * check retries its `list` on any error (b.jg5 SRJ-906). Never throws unless
 * `call` or `sleep` does.
 */
export async function callWithCliTries<A>(
  call: () => Promise<A>,
  retry: (answer: A) => boolean,
  sleep: (ms: number) => Promise<void>,
): Promise<A> {
  let answer = await call()
  for (let tries = 1; retry(answer) && tries < PRECHECK_TRIES; tries++) {
    await sleep(PRECHECK_TRY_SPACING_MS)
    answer = await call()
  }
  return answer
}

// ---------------------------------------------------------------------------
// Log reads for the daemon startup report (production deps)
// ---------------------------------------------------------------------------

function fileSize(path: string): number {
  try {
    return statSync(path).size
  } catch {
    return 0
  }
}

function readFileFrom(path: string, offset: number): string {
  let fd: number
  try {
    fd = openSync(path, 'r')
  } catch {
    return ''
  }
  try {
    const start = Math.max(0, offset)
    const length = Math.max(0, fstatSync(fd).size - start)
    const buf = Buffer.alloc(length)
    const read = readSync(fd, buf, 0, length, start)
    return buf.subarray(0, read).toString('utf-8')
  } catch {
    return ''
  } finally {
    closeSync(fd)
  }
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
  /** `credentials <persona>`, given the arguments after the subcommand. */
  credentials: (args: readonly string[]) => Promise<void>
  /** `clear-latch <persona>`, given the arguments after the subcommand (b.jg5 SRJ-509). */
  clearLatch: (args: readonly string[]) => Promise<void>
}

/** How `clear-latch`'s request ended: an answer, a failed dial, or no answer within CLEAR_LATCH_WAIT_MS. */
type ClearLatchOutcome =
  | { readonly kind: 'answered'; readonly answer: ClearLatchDialAnswer }
  | { readonly kind: 'failed'; readonly error: unknown }
  | { readonly kind: 'timed-out' }

/**
 * `clear-latch`'s line and exit code for its request's outcome (b.jg5
 * SRJ-509, SRJ-510): a well-formed 200 is the cleared or the not-latched
 * line, exit 0; a 404 the no-persona line; a failed dial the not-answered
 * line with its description; any other status, and a malformed 200, the
 * not-answered line naming the status only; no answer in time the "did not
 * confirm" line; each of these exit 1. Pure.
 */
function clearLatchReportOf(outcome: ClearLatchOutcome): { readonly line: string; readonly exitCode: number } {
  if (outcome.kind === 'timed-out') return { line: clearLatchCliNotConfirmedLine(), exitCode: 1 }
  if (outcome.kind === 'failed') return { line: clearLatchCliNotAnsweredLine(describeThrownValue(outcome.error)), exitCode: 1 }
  const { status, body } = outcome.answer
  if (status === 404) return { line: clearLatchCliNoPersonaLine(), exitCode: 1 }
  const answer = status === 200 ? parseClearLatchAnswer(body) : null
  if (answer === null) return { line: clearLatchCliNotAnsweredLine(clearLatchStatusCause(status)), exitCode: 1 }
  return {
    line: answer.cleared ? clearLatchCliClearedLine(answer.persona) : clearLatchCliNotLatchedLine(answer.persona),
    exitCode: 0,
  }
}

/** A persona the precheck could not reach, with its failure (b.jg5 SRJ-901). */
interface PrecheckPersonaFailure {
  readonly persona: Persona
  readonly failure: PrecheckFailure
}

/**
 * Build CLI handlers bound to injectable dependencies.
 * Call with real deps from top-level code; call with stubs in tests.
 */
export function createCli(deps: CliDeps): CliHandlers {
  /**
   * b.4dk: per-persona graceful bot teardown — SR-11 Event 12's pause/poll/kill
   * sequence, extracted so both clean_restart and `stop --stop-bots` reuse the
   * exact same tested logic instead of duplicating it.
   *
   * Runs once per persona of the configuration the server runs (b.av2 SR-8.7:
   * the last-applied record, or the configuration file without one), addressing
   * each persona's instance as `cscb_<key>`; see `teardownPersona`. A config
   * with no personas tears down nothing. Answers the per-persona outcomes in
   * configuration order once every persona's teardown has settled; it never
   * throws. The caller reports them (`reportTeardown`).
   */
  async function teardownBots(
    personas: readonly Persona[],
    exit_timeout: number,
  ): Promise<readonly PersonaTeardownOutcome[]> {
    // Personas are torn down in parallel; each answers its outcome and never
    // throws for an agent-director answer. Every persona settles before any
    // is reported: a teardown that rejects all the same is a failed outcome
    // (b.qwo: a teardown is never a silent no-op), so no persona is left
    // un-awaited and none is reported stopped without proof.
    const settled = await Promise.allSettled(personas.map((persona) => teardownPersona(persona, exit_timeout)))
    return settled.map((result) => (result.status === 'fulfilled' ? result.value : teardownRejectedOutcomeOf(result.reason)))
  }

  /**
   * Report every persona's teardown outcome under `command` (b.jg5 SRJ-907,
   * SRJ-909), in configuration order, from each persona's report
   * (`personaTeardownReportOf`, `src/cli-teardown.ts`): its lines through
   * `print`, its `server.log` lines through `deps.appendServerLogLine` (timed
   * by `deps.now`), and its `startup-errors.log` entry through
   * `deps.recordStartupErrorEntry`. Answers the number of personas that
   * could not be stopped; a persona stopped with the kill-failure alert's
   * survivor version counts as stopped. When that number is above 0, the
   * caller ends with the last line (`teardownNotStoppedLine`), printed last
   * and only printed.
   *
   * The writes are best effort: a failed `server.log` or startup-errors write
   * is reported in one line (`console.error`) and stops neither the other
   * destination nor the print. Nothing is posted to Slack and nothing
   * latches (b.jg5 SRJ-1002).
   */
  function reportTeardown(
    command: CliTeardownCommand,
    personas: readonly Persona[],
    outcomes: readonly PersonaTeardownOutcome[],
    print: (line: string) => void,
  ): number {
    let failed = 0
    outcomes.forEach((outcome, i) => {
      const report = personaTeardownReportOf(command, personas[i], outcome)
      for (const line of report.printed) print(line)
      for (const line of report.logged) appendServerLog(command, line)
      if (report.entry !== undefined) recordEntry(command, report.entry)
      if (report.failed) failed++
    })
    return failed
  }

  /** One best-effort `server.log` line (b.jg5 SRJ-909): a failure is reported in one line. */
  function appendServerLog(command: CliTeardownCommand, line: string): void {
    let failure: { readonly error: unknown } | undefined
    try {
      const result = deps.appendServerLogLine(line, deps.now())
      if (!result.written) failure = { error: result.error }
    } catch (error) {
      failure = { error }
    }
    if (failure !== undefined) {
      console.error(`[slack] ${command}: could not append a line to server.log: ${describeThrownValue(failure.error)}`)
    }
  }

  /** One best-effort `startup-errors.log` entry (b.jg5 SRJ-909): a failure is reported in one line. */
  function recordEntry(command: CliTeardownCommand, entry: CliTeardownStartupErrorEntry): void {
    try {
      deps.recordStartupErrorEntry(entry.classLabel, entry.message)
    } catch (error) {
      console.error(
        `[slack] ${command}: could not record a ${entry.classLabel} entry in startup-errors.log: ${describeThrownValue(error)}`,
      )
    }
  }

  /**
   * One persona's teardown (b.jg5 SRJ-903), answering its outcome
   * (`PersonaTeardownOutcome`, `src/cli-teardown.ts`); it never throws for
   * an agent-director answer:
   *
   *   1. one `status` read of `cscb_<key>` (`stateReadVerdictOf`): no row or
   *      a finished row is stopped; any other error fails the persona;
   *   2. `pause` (`/exit` → SessionEnd → the row reaches `ended`), decided by
   *      `pauseVerdictOf`: UNAVAILABLE is tried again, only the `pause`, up
   *      to PRECHECK_TRIES calls PRECHECK_TRY_SPACING_MS apart, then
   *      escalates; an escalation goes to the kill; a fail-at-once verdict
   *      fails the persona with no kill;
   *   3. after a successful pause, `status` reads with a doubling wait until
   *      the row is `ended`, `missing` or absent, or `exit_timeout` passes;
   *      the last wait is cut short at `exit_timeout`; a read error fails the
   *      persona (`stateReadVerdictOf`);
   *   4. at `exit_timeout`, or after an escalated pause, the kill's bounded
   *      retry by class (`teardownKill`, b.jg5 SRJ-904).
   *
   * Every wait is on the CLI's injected clock (`deps.now`, `deps.sleep`), and
   * the whole teardown, with every call taking the call timeout, ends within
   * `teardownBoundMs(exit_timeout, callTimeoutMs)` (`src/cli-teardown.ts`;
   * b.jg5 SRJ-908): no other wait, no sleep past `exit_timeout` and no call
   * beyond the state read, the pause's tries, the poll and the kill's tries
   * with their reads. A kill does not guarantee an `ended` row; the next
   * server's start recovers such a row. Log lines name the persona as its
   * JSON-quoted name with its key (b.av2 SR-2.2).
   */
  async function teardownPersona(persona: Persona, exit_timeout: number): Promise<PersonaTeardownOutcome> {
    const id = personaInstanceId(persona.key)
    const ref = renderPersonaRef(persona.name, persona.key)

    // State read. "No spawn row" is reported only for a row that is
    // genuinely absent (ErrSpawnNotFound, by name); any other error (b.qwo:
    // agent-director unreachable, no client installed) fails the persona.
    const initial = await teardownStateRead(id)
    if (initial.kind === STATE_READ_VERDICT_ABSENT) {
      console.error(`[slack] teardownBots: no spawn row for persona ${ref} — skipping`)
      return teardownStopped(TEARDOWN_STOPPED_NO_ROW)
    }
    if (initial.kind === STATE_READ_VERDICT_FAIL) return teardownFailed(TEARDOWN_STEP_STATE_READ, initial)
    if (initial.kind !== STATE_READ_VERDICT_LIVE) {
      console.error(`[slack] teardownBots: persona ${ref} already terminal (state=${initial.state}) — skipping`)
      return teardownStopped(TEARDOWN_STOPPED_ALREADY_FINISHED)
    }

    // Pause, by class (b.jg5 SRJ-903). `pause` waits up to the host's
    // `[pause] timeout_seconds` for the row to end; the client's call timeout
    // (CSCB's `agent_director_call_timeout_ms`, given to initClient) is sized
    // above that wait (b.jg5 SRJ-213), so a slow `/exit` ends in
    // agent-director's ErrPauseTimeout, which escalates, rather than in
    // ErrCallTimeout (b.jg5 SRJ-119).
    // No latch check holds the kill back: a human-initiated teardown makes
    // its ordinary checked kill of a row the server would hold, a `pending`
    // row with or without a launch start included, which goes pause,
    // ErrSpawnNotPausable, then the kill (b.jg5 SRJ-503, SRJ-513).
    const pause = await pauseTries(id)
    if (pause.kind === PAUSE_VERDICT_FAIL) return teardownFailed(TEARDOWN_STEP_PAUSE, pause)
    if (pause.kind !== PAUSE_VERDICT_DONE) {
      console.error(`[slack] teardownBots: pause failed for persona ${ref} — escalating to kill: ${pause.description}`)
      return teardownKill(id, ref, initial.state)
    }

    // Poll for `ended` or `missing`. Each read goes through the same verdict
    // as the state read; it latches nothing, reads and writes no record and
    // never clears a retired-key entry (an SRJ-115 site; b.jg5 SRJ-801: the
    // CLI never writes retired-keys.json and installs no store).
    const startTime = deps.now()
    const deadline = startTime + exitTimeoutMsOf(exit_timeout)
    let wait = TEARDOWN_POLL_FIRST_WAIT_MS
    let lastState = initial.state
    while (deps.now() < deadline) {
      await deps.sleep(Math.min(wait, deadline - deps.now()))
      wait = Math.min(wait * 2, TEARDOWN_POLL_MAX_WAIT_MS)
      const polled = await teardownStateRead(id)
      if (polled.kind === STATE_READ_VERDICT_FAIL) return teardownFailed(TEARDOWN_STEP_POLL, polled)
      if (polled.kind !== STATE_READ_VERDICT_LIVE) {
        console.error(`[slack] teardownBots: persona ${ref} exited cleanly in ${deps.now() - startTime}ms`)
        return teardownStopped(TEARDOWN_STOPPED_EXITED)
      }
      lastState = polled.state
    }

    // exit_timeout passed: the kill.
    const elapsed = deps.now() - startTime
    const killed = await teardownKill(id, ref, lastState)
    if (killed.kind === TEARDOWN_OUTCOME_FAILED) {
      console.error(`[slack] teardownBots: kill failed for persona ${ref}: ${killed.description}`)
    } else {
      console.error(`[slack] teardownBots: persona ${ref} force-killed after ${elapsed}ms`)
    }
    return killed
  }

  /** One of the teardown's own `status` reads of `id`, and its verdict (`stateReadVerdictOf`). */
  async function teardownStateRead(id: string): Promise<StateReadVerdict> {
    let answer: StateReadAnswer
    try {
      answer = { row: await deps.directorStatus(id) }
    } catch (error) {
      answer = { error }
    }
    return stateReadVerdictOf(answer)
  }

  /**
   * The teardown's `pause` of `id` and its verdict, the `pause` alone made
   * again while it answers UNAVAILABLE (`callWithCliTries`): at most
   * PRECHECK_TRIES calls, PRECHECK_TRY_SPACING_MS apart on the injected
   * clock, with no `status` read between them (b.jg5 SRJ-903, SRJ-908). A
   * retry verdict that stands after the last try escalates
   * (`pauseVerdictAfterLastTry`).
   */
  async function pauseTries(id: string): Promise<PauseVerdict> {
    const call = async (): Promise<PauseAnswer> => {
      try {
        await deps.directorPause(id)
        return { paused: true }
      } catch (error) {
        return { error }
      }
    }
    const verdict = await callWithCliTries(
      async () => pauseVerdictOf(await call()),
      (v) => v.kind === PAUSE_VERDICT_RETRY,
      deps.sleep,
    )
    return pauseVerdictAfterLastTry(verdict)
  }

  /**
   * The teardown's kill of `id` (persona `ref`), after an escalated pause or
   * at `exit_timeout`, whose path last read the row in `lastState` (b.jg5
   * SRJ-904, SRJ-702, SRJ-110): one bounded retry (`runKillRetry`,
   * `src/kill-retry.ts`), mapped to the persona's outcome by
   * `teardownKillOutcomeOf` (`src/cli-teardown.ts`).
   *
   *   - each try is one checked kill (`checkedKill`, `src/checked-kill.ts`)
   *     over `deps.directorKill`: a plain kill, never `include_finished`
   *     (b.jg5 SRJ-106), under `TEARDOWN_KILL_OPTIONS`: a GONE answer is a
   *     non-success, which the retry never tries again and logs as the
   *     failure it is for the persona (b.jg5 SRJ-904, SRJ-702);
   *   - an UNAVAILABLE try is tried again, up to KILL_RETRY_TRIES kills
   *     KILL_RETRY_SPACING_MS apart on the CLI's injected clock
   *     (`deps.sleep`), with one `status` read (`deps.directorStatus`,
   *     `teardownKillReadOf`) before each further try;
   *   - a CONFIG answer at that read ends the tries (`read-config`) with no
   *     further kill, whatever state was last read, under
   *     `TEARDOWN_KILL_RETRY_OPTIONS`; the result keeps the read's error,
   *     which fails the persona with class CONFIG;
   *   - an UNUSABLE NAME answer at that read, or a `pending` row with no
   *     launch start, lets the try go ahead: nothing latches in the CLI, which
   *     imports no latch and writes no retired-key record (b.jg5 SRJ-115,
   *     SRJ-801, SRJ-1002);
   *   - each try, read and end line goes through `console.error` with the
   *     teardown's prefix: stderr for `stop --stop-bots`, `clean_restart.log`
   *     for `clean_restart`, which has redirected it.
   * Raises no outage, arms no retry timer and starts no condition: the CLI
   * has none. Never throws for an agent-director answer.
   */
  async function teardownKill(id: string, ref: string, lastState: string): Promise<PersonaTeardownOutcome> {
    const kill = (params: PlainKillParams): Promise<unknown> => deps.directorKill(params.claude_instance_id)
    const result = await runKillRetry({
      ...TEARDOWN_KILL_RETRY_OPTIONS,
      instanceId: id,
      kill: () => checkedKill(id, kill, TEARDOWN_KILL_OPTIONS),
      read: async (): Promise<KillRetryRead> => {
        let answer: StateReadAnswer
        try {
          answer = { row: await deps.directorStatus(id) }
        } catch (error) {
          answer = { error }
        }
        return teardownKillReadOf(answer)
      },
      wait: deps.sleep,
      lastRead: killRetrySeedOfState(lastState),
      log: (line) => console.error(line),
      logPrefix: `[slack] teardownBots: persona ${ref}`,
    })
    return teardownKillOutcomeOf(result)
  }

  /**
   * The precheck over `personas` (b.jg5 SRJ-901 steps 2 to 5), run after the
   * client's initialization and before anything is stopped. Answers the
   * personas it could not reach, each with its failure, in configuration
   * order; an empty answer is a pass (an empty persona set included).
   * Personas are checked in parallel. Makes only `get` and `read-pane` calls,
   * latches nothing, writes nothing and prints nothing.
   */
  async function runPrecheck(personas: readonly Persona[]): Promise<PrecheckPersonaFailure[]> {
    const results = await Promise.all(personas.map((persona) => precheckPersona(persona)))
    return results.flatMap((failure, i) => (failure === null ? [] : [{ persona: personas[i], failure }]))
  }

  /**
   * One persona's precheck: one `get` of `cscb_<key>`; for a live row, one
   * `read-pane` of the one-line count (`PROBE_PANE_READ_LINES`). Answers its
   * failure, or null when it passes.
   */
  async function precheckPersona(persona: Persona): Promise<PrecheckFailure | null> {
    const id = personaInstanceId(persona.key)
    const got = await precheckTries(async (): Promise<PrecheckAnswer> => {
      try {
        return { call: PRECHECK_CALL_GET, row: await deps.directorGet(id) }
      } catch (error) {
        return { call: PRECHECK_CALL_GET, error }
      }
    })
    if (got.kind === PRECHECK_VERDICT_SKIP) return null
    if (got.kind !== PRECHECK_VERDICT_PASS) return { errorClass: got.errorClass, description: got.description }
    const read = await precheckTries(async (): Promise<PrecheckAnswer> => {
      try {
        return { call: PRECHECK_CALL_READ_PANE, pane: await deps.directorReadPane(id, PROBE_PANE_READ_LINES) }
      } catch (error) {
        return { call: PRECHECK_CALL_READ_PANE, error }
      }
    })
    if (read.kind === PRECHECK_VERDICT_SKIP || read.kind === PRECHECK_VERDICT_PASS) return null
    return { errorClass: read.errorClass, description: read.description }
  }

  /**
   * One precheck call and its verdict, the call made again while it answers
   * UNAVAILABLE (`callWithCliTries`): at most PRECHECK_TRIES calls,
   * PRECHECK_TRY_SPACING_MS apart on the injected clock (b.jg5 SRJ-901
   * step 3, SRJ-908). A retry verdict that stands after the last try is the
   * persona's failure.
   */
  async function precheckTries(call: () => Promise<PrecheckAnswer>): Promise<PrecheckVerdict> {
    return callWithCliTries(
      async () => precheckVerdictOf(await call()),
      (v) => v.kind === PRECHECK_VERDICT_RETRY,
      deps.sleep,
    )
  }

  /**
   * `clean_restart`'s answer check after a failed teardown (b.jg5 SRJ-906):
   * true when one `list` of `service=cscb` rows (`deps.directorList`)
   * succeeds within PRECHECK_TRIES calls, PRECHECK_TRY_SPACING_MS apart on
   * the injected clock (`callWithCliTries`). Any error is a failed try,
   * CONFIG included, and is written in one line with its class and redacted
   * description (`answerCheckFailedTryLine`) through `console.error`, which
   * `clean_restart` has redirected, so the line reaches only
   * `clean_restart.log`. Latches, records and writes nothing else; never
   * throws for an agent-director answer.
   */
  async function agentDirectorAnswers(): Promise<boolean> {
    let tries = 0
    return callWithCliTries(
      async (): Promise<boolean> => {
        tries++
        try {
          await deps.directorList()
          return true
        } catch (error) {
          const { errorClass, description } = teardownErrorReportOf(error)
          console.error(answerCheckFailedTryLine(tries, { errorClass, description }))
          return false
        }
      },
      (answered) => !answered,
      deps.sleep,
    )
  }

  /**
   * Print a failed precheck through `print` (b.jg5 SRJ-901): one line per
   * persona it could not reach, then `<command>: nothing was stopped`. The
   * caller exits 1.
   */
  function printPrecheckFailure(
    command: CliTeardownCommand,
    failures: readonly PrecheckPersonaFailure[],
    print: (line: string) => void,
  ): void {
    for (const { persona, failure } of failures) print(precheckFailureLine(command, persona, failure))
    print(precheckNothingStoppedLine(command))
  }

  async function start(): Promise<void> {
    // tmux is no longer a CSCB-direct prerequisite — agent-director owns the
    // tmux integration. CSCB still requires it transitively but the
    // SR-5.1 startup gate is the single source of truth for runtime checks.
    //
    // No token check (b.av2 SR-10.2): the server reads each persona's tokens
    // from its credentials file, never from the environment.

    // b.av2 SR-8.7: the configuration file the server loads, or its
    // last-applied record, must exist. Their contents are not checked here:
    // the server validates them at start, and `start` reports that failure
    // from the daemon's log (see `awaitDaemonStartup`).
    const stateDir = deps.resolveStateDir()
    const configPath = deps.resolveConfigPath()
    const recordPath = reloadFilePaths(configPath).lastApplied
    if (!deps.existsSync(configPath) && !deps.existsSync(recordPath)) {
      console.error(
        `missing prerequisite: config.json not found at ${configPath}, and no config.json.last-applied at ${recordPath}`,
      )
      deps.exit(1)
    }

    // All checks passed — daemonize: the parent spawns the daemon and waits for
    // its startup outcome, the child continues as the server.
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
      // Parent: spawn a detached background child, then report its startup.
      const logPath = join(stateDir, 'server.log')
      const logOffset = deps.fileSize(logPath)
      const logFd = deps.openLogAppend(logPath)
      const childEnv: NodeJS.ProcessEnv = { ...process.env, _CLI_DAEMON_CHILD: '1' }
      let child: DaemonChild
      try {
        child = deps.spawnDaemon(process.execPath, [import.meta.filename, 'start'], {
          detached: true,
          stdio: ['ignore', logFd, logFd],
          env: childEnv,
        })
      } finally {
        // The daemon holds its own copy of the descriptor; the parent's is not
        // needed while it waits (up to DAEMON_STARTUP_WAIT_MS).
        deps.closeFd(logFd)
      }
      child.unref()
      await awaitDaemonStartup(child, join(stateDir, 'server.pid'), logPath, logOffset)
      return
    }

    // Child (daemon): redirect stderr/stdout to server.log
    try { deps.initLogging(join(stateDir, 'server.log')) } catch { /* best-effort: log redirect failure is non-fatal */ }

    // Child (daemon): start the server
    await deps.startServer()
  }

  /**
   * `start`'s parent path after the spawn (b.av2 SR-1.7, SR-8.7): wait up to
   * DAEMON_STARTUP_WAIT_MS for the daemon to exit or to write its own PID to
   * the PID file, which the server does once it is listening, after the
   * configuration load. Then exit:
   *
   * - the daemon wrote its PID: 0, with the "Server starting in background"
   *   line;
   * - the daemon exited (or could not be spawned): 1, repeating the lines
   *   this run appended to `server.log`, which carry the server's own fatal
   *   reason (the loader's conversion error verbatim for a pre-persona file). Server
   *   log lines never carry a token (b.av2 SR-10.3);
   * - the wait expired: 0, saying the server is still starting and where its
   *   log is. The daemon is never signalled.
   */
  async function awaitDaemonStartup(
    child: DaemonChild,
    pidFile: string,
    logPath: string,
    logOffset: number,
  ): Promise<void> {
    // Set by the child's events; the first one wins.
    const outcome: { failure: string | null } = { failure: null }
    child.once('exit', (code, signal) => {
      outcome.failure ??= signal !== null ? `killed by ${signal}` : `exit code ${code}`
    })
    child.once('error', (err) => {
      outcome.failure ??= `could not be launched: ${err.message}`
    })

    const deadline = deps.now() + DAEMON_STARTUP_WAIT_MS
    for (;;) {
      if (outcome.failure !== null) {
        reportDaemonFailure(outcome.failure, logPath, logOffset)
        deps.exit(1)
      }
      if (daemonWrotePid(pidFile, child.pid)) {
        console.error(`[slack] Server starting in background (PID ${child.pid})`)
        deps.exit(0)
      }
      if (deps.now() >= deadline) {
        console.error(
          `[slack] Server is still starting in the background (PID ${child.pid}) after ` +
            `${DAEMON_STARTUP_WAIT_MS / 1000}s — its log is ${logPath}`,
        )
        deps.exit(0)
      }
      await deps.sleep(DAEMON_STARTUP_POLL_MS)
    }
  }

  /** True when the PID file names `pid`: the daemon got past startup. */
  function daemonWrotePid(pidFile: string, pid: number | undefined): boolean {
    if (pid === undefined || !deps.existsSync(pidFile)) return false
    try {
      return parseInt(deps.readFileSync(pidFile).trim(), 10) === pid
    } catch {
      return false
    }
  }

  /**
   * Write the daemon's startup failure to stderr: the last
   * DAEMON_FAILURE_LOG_LINES non-empty lines appended to `server.log` since
   * `logOffset`. A log now shorter than the offset was rotated, so it is read
   * from its start.
   */
  function reportDaemonFailure(failure: string, logPath: string, logOffset: number): void {
    const from = deps.fileSize(logPath) < logOffset ? 0 : logOffset
    const lines = deps.readFileFrom(logPath, from)
      .split('\n')
      .map((line) => line.trimEnd())
      .filter((line) => line !== '')
      .slice(-DAEMON_FAILURE_LOG_LINES)
    if (lines.length === 0) {
      console.error(`[slack] Server failed to start (${failure}); it wrote nothing to ${logPath}`)
      return
    }
    console.error(`[slack] Server failed to start (${failure}). From ${logPath}:`)
    for (const line of lines) console.error(line)
  }

  async function stop(opts?: { stopBots?: boolean }): Promise<void> {
    // b.4dk: `stop --stop-bots` gracefully exits the managed bots (reusing
    // clean_restart's tested pause/poll/kill teardown) AND stops the server,
    // WITHOUT the restart phase. Plain `stop` leaves the bots running (they
    // are meant to survive server restarts).
    //
    // Order (b.jg5 SRJ-901): the configuration, the client's initialization
    // and the precheck come first, so a failed one stops nothing (the
    // client's too-old refusal alone stops the server, SRJ-902). Then the
    // server stops, then teardownBots runs — clean_restart's order too. If
    // teardown ran while the daemon were still alive, a bot's graceful `/exit`
    // would close its MCP session and the live server's onsessionclosed
    // handler (src/server.ts) would scheduleRestart the persona, respawning it
    // before SIGTERM lands. directorPause is an agent-director client
    // subprocess that needs no live CSCB daemon (SessionEnd hooks are wired by
    // agent-director into the spawned claude process and call the AD binary),
    // so teardown works fine after the server is down.
    const config = opts?.stopBots ? await precheckStopBots() : null

    // Stop the server daemon. Returns the intended exit code so teardown can
    // run before we actually exit.
    const stopServerCode = await stopServer()

    // Gracefully exit managed bots (only for --stop-bots with a readable
    // configuration). b.qwo: a teardown failure (AD unreachable) is a LOUD
    // failure — exit non-zero rather than swallowing it and reporting a clean
    // stop. Each persona's report is printed to stderr, appended to
    // server.log and recorded in startup-errors.log once every persona has
    // settled (b.jg5 SRJ-907, SRJ-909); any persona that could not be stopped
    // exits 1 (b.jg5 SRJ-905). A persona stopped with the kill-failure
    // alert's survivor version counts as stopped: the survivor text changes
    // no exit status.
    //
    // b.jg5 SRJ-905: `stop --stop-bots` never starts the server. It has no
    // answer check and no `start` spawn: after a failed teardown the server
    // stays stopped, unlike clean_restart (SRJ-906).
    if (config !== null) {
      console.error('[slack] stop --stop-bots: gracefully exiting managed bots')
      const outcomes = await teardownBots(config.personas, config.exit_timeout)
      const failed = reportTeardown(CLI_COMMAND_STOP_BOTS, config.personas, outcomes, (line) => console.error(line))
      if (failed > 0) {
        console.error(teardownNotStoppedLine(CLI_COMMAND_STOP_BOTS, failed))
        deps.exit(1)
      }
    }

    deps.exit(stopServerCode)
  }

  /**
   * `stop --stop-bots`' steps before anything is stopped (b.jg5 SRJ-901):
   * load the configuration the server runs, initialize the client with its
   * call timeout, and run the precheck over its personas. Answers the
   * configuration to tear down, or null when it cannot be read: then there is
   * no per-persona step, the client takes the default call timeout, and the
   * teardown is skipped after the server stop. The initialization leaves
   * CSCB's Phase 1 floor out (b.jg5 SRJ-203). When the client refuses the
   * binary as too old, the server alone is stopped and the command exits 1
   * after the "only the server was stopped" line (b.jg5 SRJ-902), whether or
   * not the configuration was read. Any other failed initialization, and a
   * failed precheck, print their lines, ending with the "nothing was
   * stopped" line, and exit 1 with nothing stopped.
   */
  async function precheckStopBots(): Promise<PersonaConfig | null> {
    // Config load is best-effort: a config problem (a pre-persona file
    // included) logs and skips the precheck and the teardown without failing
    // the stop (b.4dk behavior). It comes before the client's initialization,
    // which takes its call timeout from it, or the default when it cannot be
    // read (b.jg5 SRJ-213).
    let config: PersonaConfig | null = null
    try {
      config = deps.loadConfig(deps.resolveConfigPath())
    } catch (err) {
      console.error('[slack] stop --stop-bots: could not load config — skipping bot teardown:', err)
    }

    // b.qwo: initialize the AD Client singleton before the precheck. Like
    // clean_restart, `stop --stop-bots` runs in a short-lived CLI process that
    // never runs the server startup gate; without init getClient() throws and
    // the precheck and teardown could reach no row (the b.qps root cause).
    // The gate leaves CSCB's Phase 1 floor out here and only here (b.jg5
    // SRJ-203, SRJ-902): `stop --stop-bots` makes no version check of its own,
    // so a binary the client accepts runs the precheck and teardown.
    if (deps.initClient) {
      try {
        await deps.initClient(agentDirectorCallTimeoutMsOf(config), { skipPhase1Floor: true })
      } catch (err) {
        console.error(agentDirectorInitFailedLine(CLI_COMMAND_STOP_BOTS, describeCliFailure(err)))
        if (isClientTooOldRefusal(err)) {
          // b.jg5 SRJ-902: no agent-director call can be made, so the server
          // alone is stopped, with no precheck and no teardown; every worker
          // and row is left as it is. The line above carries the gate's
          // too-old message (both versions). Exit 1 whatever the stop returned.
          await stopServer()
          console.error(onlyServerStoppedLine())
          deps.exit(1)
        }
        console.error(precheckNothingStoppedLine(CLI_COMMAND_STOP_BOTS))
        deps.exit(1)
      }
    }

    if (config !== null) {
      const failures = await runPrecheck(config.personas)
      if (failures.length > 0) {
        printPrecheckFailure(CLI_COMMAND_STOP_BOTS, failures, (line) => console.error(line))
        deps.exit(1)
      }
    }
    return config
  }

  // Stop the server daemon. Returns the intended process exit code instead of
  // calling deps.exit() directly, so callers can run additional teardown work
  // (e.g. --stop-bots) before exiting.
  async function stopServer(): Promise<number> {
    const stateDir = deps.resolveStateDir()
    const pidFile = join(stateDir, 'server.pid')
    // b.jg5 SRJ-510: the listener's record goes with the PID file on each
    // path that removes it, so a server ended by SIGKILL leaves none.
    const serverPortFile = serverPortFilePath(stateDir)

    // The PID file's reading `clear-latch` shares (b.jg5 SRJ-509).
    const server = readServerPid(pidFile, deps)
    if (server.kind === SERVER_PID_ABSENT) {
      console.error('server is not running')
      return 0
    }
    if (server.kind === SERVER_PID_UNREADABLE) {
      const err = server.error
      console.error(`[slack] Could not read PID file: ${err}`)
      return 1
    }
    if (server.kind === SERVER_PID_STALE) {
      try {
        deps.unlinkSync(pidFile)
      } catch { /* ignore */ }
      removeServerPortRecord(serverPortFile, deps)
      console.error('server is not running (removed stale PID file)')
      return 0
    }
    const pid = server.pid

    // Load stop_timeout from the record or config (fall back to 30s if
    // unavailable, a pre-persona file included). A read failure is reported in
    // one line with the loader's message (which names the file and, for a bad
    // record, carries the deletion hint, never file content), and the stop
    // proceeds with the default.
    let stopTimeoutMs = 30_000
    try {
      const config = deps.loadConfig(deps.resolveConfigPath())
      if (typeof config.stop_timeout === 'number') {
        stopTimeoutMs = config.stop_timeout * 1000
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error(`[slack] stop: could not load the applied configuration — using the default 30s stop_timeout: ${msg}`)
    }

    // Live process — send SIGTERM and poll until exit or stop_timeout
    deps.kill(pid, 'SIGTERM')

    const deadline = deps.now() + stopTimeoutMs
    while (deps.now() < deadline) {
      await deps.sleep(STOP_POLL_MS)
      if (!deps.isProcessRunning(pid)) {
        try { deps.unlinkSync(pidFile) } catch { /* ignore */ }
        removeServerPortRecord(serverPortFile, deps)
        console.error('[slack] Server stopped.')
        return 0
      }
    }

    // SIGTERM timed out — escalate to SIGKILL
    console.error(`[slack] Warning: server did not stop within ${stopTimeoutMs / 1000}s after SIGTERM — sending SIGKILL.`)
    deps.kill(pid, 'SIGKILL')

    // Poll briefly (~2s) to confirm death after SIGKILL
    const killDeadline = deps.now() + STOP_KILL_WAIT_MS
    while (deps.now() < killDeadline) {
      await deps.sleep(STOP_POLL_MS)
      if (!deps.isProcessRunning(pid)) {
        try { deps.unlinkSync(pidFile) } catch { /* ignore */ }
        removeServerPortRecord(serverPortFile, deps)
        console.error('[slack] Server killed.')
        return 0
      }
    }

    console.error('[slack] Warning: server did not die after SIGKILL.')
    return 1
  }

  /**
   * `clean_restart`, in this order (b.jg5 SRJ-901, SRJ-906): load the
   * configuration the server runs, initialize the client, run the precheck
   * (a failure stops nothing), spawn `stop`, tear down every persona and
   * report it, then:
   *   - every persona stopped: spawn `start`;
   *   - a persona failed: the answer check (`agentDirectorAnswers`), then
   *     spawn `start` if agent-director answers, or the not-restarted alert,
   *     with no `start`, if it does not; then the last line and exit 1.
   * Nothing is stopped before the precheck has passed.
   */
  async function clean_restart(): Promise<void> {
    // Everything below goes to clean_restart.log. A fatal line is also written
    // to the stderr in place before the redirect, so a failed clean_restart
    // says why on the terminal instead of a bare exit 1. These lines name
    // paths, persona refs and loader/agent-director errors, never a token.
    const terminalError = console.error
    try { deps.initLogging(join(deps.resolveStateDir(), 'clean_restart.log')) } catch { /* best-effort */ }
    const fatal = (...args: unknown[]): void => {
      console.error(...args)
      if (console.error !== terminalError) terminalError(...args)
    }
    // The `start` spawn: one `start` of this CLI, whose own daemon startup
    // report decides its status. A non-zero status prints the start-failed
    // line through the fatal path. Answers the status; the caller exits.
    const spawnStart = (): number | null => {
      console.error('[slack] clean_restart: starting server')
      const startResult = deps.spawnSync(process.execPath, [process.argv[1], 'start'])
      if (startResult.status !== 0) {
        fatal(cleanRestartStartFailedLine(startResult.status))
      }
      return startResult.status
    }

    // Phase 1: Load config (the persona set to check and tear down). An
    // unreadable configuration is fatal before anything is stopped.
    let config: PersonaConfig
    try {
      config = deps.loadConfig(deps.resolveConfigPath())
    } catch (err) {
      fatal('[slack] clean_restart: failed to load config:', err)
      deps.exit(1)
    }
    const { personas, exit_timeout } = config!

    // Phase 2 (b.qwo): initialize the AD Client singleton before the precheck.
    // This CLI process does NOT run the server startup gate, so without
    // explicit init getClient() throws (the b.qps root cause). We use the
    // non-exiting runStartupGate variant so a gate failure surfaces here as a
    // distinct loud non-zero exit, with nothing stopped (b.jg5 SRJ-901 step 1).
    // The client takes the loaded configuration's call timeout (b.jg5 SRJ-213)
    // and the whole gate runs, CSCB's Phase 1 floor included (b.jg5 SRJ-203):
    // every gate refusal, the floor's included, stops nothing.
    if (deps.initClient) {
      try {
        await deps.initClient(agentDirectorCallTimeoutMsOf(config!))
      } catch (err) {
        fatal(agentDirectorInitFailedLine(CLI_COMMAND_CLEAN_RESTART, describeCliFailure(err)))
        fatal(precheckNothingStoppedLine(CLI_COMMAND_CLEAN_RESTART))
        deps.exit(1)
      }
    }

    // Phase 3 (b.jg5 SRJ-901): the precheck, before anything is stopped. A
    // failed precheck stops neither the server nor any persona; its lines go
    // to the terminal and clean_restart.log only.
    const failures = await runPrecheck(personas)
    if (failures.length > 0) {
      printPrecheckFailure(CLI_COMMAND_CLEAN_RESTART, failures, (line) => fatal(line))
      deps.exit(1)
    }

    // Phase 4: Stop the server daemon
    console.error('[slack] clean_restart: stopping server')
    const stopResult = deps.spawnSync(process.execPath, [process.argv[1], 'stop'])
    if (stopResult.status !== 0) {
      console.error(`[slack] clean_restart: stop returned non-zero exit code: ${stopResult.status}`)
    }

    // Phase 5: SR-11 Event 12 — per-persona pause/poll/kill teardown via
    // agent-director (shared with `stop --stop-bots`), addressing `cscb_<key>`.
    // Each persona's report goes through the fatal path (the terminal once
    // and clean_restart.log), server.log and startup-errors.log once every
    // persona has settled (b.jg5 SRJ-907, SRJ-909), the survivor text
    // included on a teardown that succeeded. A persona stopped with the
    // survivor version counts as stopped: it takes no failure path.
    const outcomes = await teardownBots(personas, exit_timeout)
    const failed = reportTeardown(CLI_COMMAND_CLEAN_RESTART, personas, outcomes, (line) => fatal(line))

    // Phase 6: Start the server. After a teardown that stopped every persona,
    // start as ever, with no answer check.
    if (failed === 0) {
      const status = spawnStart()
      if (status !== 0) deps.exit(status ?? 1)
      console.error('[slack] clean_restart: done')
      return
    }

    // b.jg5 SRJ-906: a failed teardown restarts the server, so no failure
    // ends with every persona down, once agent-director answers (one `list`
    // of service=cscb rows within PRECHECK_TRIES tries, PRECHECK_TRY_SPACING_MS
    // apart on the injected clock). The started server applies its ordinary
    // start rules: a configured persona's own running row is kept, and a
    // session conflict at its launch latches. A start that then fails prints its
    // start-failed line and records no not-restarted entry. Either way the
    // last line follows the restart's outcome and the exit is 1. Rows are
    // never deleted.
    if (await agentDirectorAnswers()) {
      console.error(cleanRestartStartingAfterFailedTeardownLine())
      spawnStart()
      fatal(teardownNotStoppedLine(CLI_COMMAND_CLEAN_RESTART, failed))
      deps.exit(1)
    }

    // b.qwo: agent-director did not answer, so the server is not started on
    // top of bots CSCB could not reach. One alert names every failed persona
    // with its session and class: printed through the fatal path, appended
    // as one server.log line and recorded as one clean-restart-not-restarted
    // entry, the same text on all three routes; both writes are best effort
    // (b.jg5 SRJ-906, SRJ-1013). Nothing goes to Slack and nothing latches.
    const failedPersonas: CleanRestartFailedPersona[] = outcomes.flatMap((outcome, i) =>
      outcome.kind === TEARDOWN_OUTCOME_FAILED ? [{ persona: personas[i], errorClass: outcome.errorClass }] : [],
    )
    const alert = cleanRestartNotRestartedAlert(failedPersonas)
    fatal(alert)
    appendServerLog(CLI_COMMAND_CLEAN_RESTART, alert)
    recordEntry(CLI_COMMAND_CLEAN_RESTART, { classLabel: CLEAN_RESTART_NOT_RESTARTED_LABEL, message: alert })
    fatal(teardownNotStoppedLine(CLI_COMMAND_CLEAN_RESTART, failed))
    deps.exit(1)
  }

  /**
   * `credentials <persona>` (b.av2 SR-12, SR-1.4 part): find the persona by
   * name or key (`resolvePersonaTarget`) in the configuration file as it
   * stands, then run the packaged credentials script for its
   * `credentials_file` on this terminal and exit with the script's status.
   * The script asks for the tokens without echo, validates them with Slack
   * and writes the file with mode 0600 (see `scripts/write-credentials.sh`).
   *
   * Exits 2 with the usage line unless given exactly one non-empty argument,
   * and 1 when the configuration file cannot be loaded (the loader's error,
   * which names the file) or no persona has that name or key (the line lists
   * the declared personas and never repeats the argument, in case a token was
   * typed there). Needs no running server and no agent-director.
   */
  async function credentials(args: readonly string[]): Promise<void> {
    if (args.length !== 1 || args[0] === '') {
      console.error(CREDENTIALS_USAGE)
      return deps.exit(2)
    }
    const configPath = deps.resolveConfigPath()
    let config: PersonaConfig
    try {
      config = deps.loadConfigFile(configPath)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error(`credentials: cannot read the personas in ${configPath}: ${msg}`)
      return deps.exit(1)
    }
    const persona = resolvePersonaTarget(config, args[0])
    if (persona === undefined) {
      const declared = config.personas.map((p) => renderPersonaRef(p.name, p.key)).join(', ')
      console.error(
        `credentials: no persona in ${configPath} has that name or key; declare it there first ` +
          `(declared: ${declared === '' ? 'none' : declared})`,
      )
      return deps.exit(1)
    }
    console.error(`Credentials file of persona ${renderPersonaRef(persona.name, persona.key)}: ${persona.credentials_file}`)
    return deps.exit(deps.runCredentialsScript(persona.credentials_file))
  }

  /**
   * `clear-latch <persona>` (b.jg5 SRJ-509, SRJ-510), in this order: the
   * argument check (exactly one non-empty argument, else the usage line and
   * exit 2); the PID file, read as `stop` reads it (`readServerPid`), where
   * anything but a running server is "no server is running"; `server.port`,
   * used only when it records that server's PID (`readServerPortRecord`), an
   * unusable record being "cannot be reached" with its cause and no request;
   * then one request to `127.0.0.1` at the record's port
   * (`clearLatchRequest`), whose outcome gives the line and the exit code
   * (`clearLatchReportOf`). Every line goes to stderr and none repeats the
   * argument. Ends through `deps.exit`, so neither the losing wait nor an
   * unanswered request keeps the process alive. Never reads the
   * configuration file or the last-applied record, builds no agent-director
   * client, and writes and removes no file.
   */
  async function clearLatch(args: readonly string[]): Promise<void> {
    if (args.length !== 1 || args[0] === '') {
      console.error(CLEAR_LATCH_USAGE)
      return deps.exit(2)
    }
    const stateDir = deps.resolveStateDir()
    const server = readServerPid(join(stateDir, 'server.pid'), deps)
    if (server.kind !== SERVER_PID_RUNNING) {
      console.error(clearLatchCliNoServerLine())
      return deps.exit(1)
    }
    const record = readServerPortRecord(serverPortFilePath(stateDir), server.pid, deps)
    if (!record.ok) {
      console.error(clearLatchCliNotAnsweredLine(record.cause))
      return deps.exit(1)
    }
    const { line, exitCode } = clearLatchReportOf(await clearLatchRequest(record.record.port, args[0]))
    console.error(line)
    return deps.exit(exitCode)
  }

  /**
   * `clear-latch`'s one request of `target` to `port` (`deps.dialClearLatch`)
   * raced against CLEAR_LATCH_WAIT_MS on the injected clock: the wait sleeps
   * (`deps.sleep`) until `deps.now` reaches its deadline, and stops once the
   * request has settled. Answers the request's answer or failure, or
   * `timed-out` when the deadline comes first; the request is not cancelled,
   * and the route still runs a clear it has received. Never rejects for the
   * request; a throw from `now` or `sleep` propagates.
   */
  async function clearLatchRequest(port: number, target: string): Promise<ClearLatchOutcome> {
    let settled = false
    const dialed = (async (): Promise<ClearLatchOutcome> => {
      try {
        return { kind: 'answered', answer: await deps.dialClearLatch(port, target) }
      } catch (error) {
        return { kind: 'failed', error }
      }
    })()
    const waited = (async (): Promise<ClearLatchOutcome> => {
      const deadline = deps.now() + CLEAR_LATCH_WAIT_MS
      for (let left = CLEAR_LATCH_WAIT_MS; left > 0 && !settled; left = deadline - deps.now()) {
        await deps.sleep(left)
      }
      return { kind: 'timed-out' }
    })()
    // A wait that fails after the request has won is not this command's failure.
    waited.catch(() => {})
    try {
      return await Promise.race([dialed, waited])
    } finally {
      settled = true
    }
  }

  return { start, stop, clean_restart, credentials, clearLatch }
}

// ---------------------------------------------------------------------------
// Production credentials script runner
// ---------------------------------------------------------------------------

/**
 * The production `runCredentialsScript`: `bash <CREDENTIALS_SCRIPT_PATH>
 * <credentialsFile>` with stdio inherited and this process's environment.
 * While it runs, this process ignores SIGINT and SIGQUIT, as a shell does for
 * a foreground job: Ctrl-C reaches the script, which removes its temporary
 * file and exits, and this process then exits with its status instead of
 * returning the prompt first. A script killed by a signal counts as 1.
 */
function runCredentialsScript(credentialsFile: string): number {
  if (!existsSync(CREDENTIALS_SCRIPT_PATH)) {
    console.error(
      `credentials: the credentials script ${CREDENTIALS_SCRIPT_PATH} is missing; reinstall claude-slack-channel-bots`,
    )
    return 1
  }
  const ignore = (): void => {}
  process.on('SIGINT', ignore)
  process.on('SIGQUIT', ignore)
  try {
    const result = spawnSync('bash', [CREDENTIALS_SCRIPT_PATH, credentialsFile], { stdio: 'inherit' })
    if (result.error !== undefined) {
      console.error(`credentials: could not run bash: ${describeThrownValue(result.error)}`)
      return 1
    }
    return result.status ?? 1
  } finally {
    process.off('SIGINT', ignore)
    process.off('SIGQUIT', ignore)
  }
}

// ---------------------------------------------------------------------------
// Production agent-director operations for the precheck and the persona teardown
// ---------------------------------------------------------------------------

/**
 * The agent-director operations the precheck, `teardownBots` and
 * `clean_restart`'s answer check use (the `director*` CliDeps).
 */
export type DirectorOps = Pick<
  CliDeps,
  'directorGet' | 'directorReadPane' | 'directorStatus' | 'directorPause' | 'directorKill' | 'directorList'
>

/** The part of the agent-director Client that `createDirectorOps` calls. */
export type DirectorClient = Pick<Client, 'get' | 'readPane' | 'status' | 'pause' | 'kill' | 'list'>

/**
 * Build the production `directorGet` / `directorReadPane` /
 * `directorStatus` / `directorPause` / `directorKill` / `directorList` deps over `getClient`
 * (the agent-director singleton accessor in production). `getClient` is
 * called on every operation, so the Client installed by `initClient` is
 * picked up and an uninstalled one throws at the call.
 *
 * Each `id` is a persona's instance ID, `cscb_<key>` (b.av2 SR-8.7). b.qwo:
 * `directorGet` and `directorStatus` return null for ErrSpawnNotFound alone,
 * recognised by name (`hasAdErrorName`), and pass every other error (AD
 * unreachable, no Client installed, a call timeout, …) through, so the
 * precheck or the teardown classifies it and a failure is loud.
 * `directorReadPane`, `directorPause` and `directorKill` pass every error
 * through, ErrSpawnNotFound included. `directorKill` answers the kill result
 * as given, for the teardown's checked kill (b.jg5 SRJ-110, SRJ-904).
 * `directorList` makes one `list` filtered by `SERVICE_LABEL` alone and
 * answers its rows, passing every error through, for `clean_restart`'s
 * answer check (b.jg5 SRJ-906).
 *
 * b.jg5 SRJ-114, SRJ-801, SRJ-807: `directorGet` and `directorStatus` apply
 * no row-read rule and the CLI installs no latch and no retired-key store, so
 * no read the CLI makes latches a persona or clears a retired-key entry.
 */
export function createDirectorOps(getClient: () => DirectorClient): DirectorOps {
  return {
    directorGet: async (id) => {
      try {
        const r: Phase1GetResult = await getClient().get({ claude_instance_id: id })
        return { state: r.state, liveness_note: r.liveness_note, launch_started_at: r.launch_started_at }
      } catch (err) {
        if (hasAdErrorName(err, ERR_SPAWN_NOT_FOUND_NAME)) return null
        throw err
      }
    },
    directorReadPane: async (id, nLines) => {
      const r = await getClient().readPane({ claude_instance_id: id, n_lines: nLines })
      return r.pane
    },
    directorStatus: async (id) => {
      try {
        const r = await getClient().status({ claude_instance_id: id })
        return { state: r.state }
      } catch (err) {
        if (hasAdErrorName(err, ERR_SPAWN_NOT_FOUND_NAME)) return null
        throw err
      }
    },
    directorPause: async (id) => {
      await getClient().pause({ claude_instance_id: id })
    },
    // The kill's parameters are the instance ID alone, never
    // `include_finished` (b.jg5 SRJ-106, SRJ-904). The result is answered as
    // given and every error passes through, ErrSpawnNotFound included: the
    // teardown's checked kill reads both, and a result with no `kill_sent`
    // field (a binary older than Phase 1, which only `stop --stop-bots`
    // reaches) is a plain success there (b.jg5 SRJ-110, SRJ-902).
    directorKill: async (id) => {
      return getClient().kill({ claude_instance_id: id })
    },
    // The service label is the only filter: no state filter, no other label
    // (b.jg5 SRJ-906). Every error passes through; the answer check counts
    // each as a failed try.
    directorList: async () => {
      const r = await getClient().list({ label: [SERVICE_LABEL] })
      return r.spawns
    },
  }
}

// ---------------------------------------------------------------------------
// Production agent-director client initialization
// ---------------------------------------------------------------------------

/**
 * The production `initClient` (b.qwo): installs the agent-director Client
 * singleton through the non-exiting startup gate, `runStartupGate`, which
 * performs Client.create() + setClient() and returns a typed outcome. The
 * client is built with `callTimeoutMs` as its call timeout (b.jg5 SRJ-213).
 * The caller's `gateOptions` go to the gate as they are (b.jg5 SRJ-203):
 * without any it runs the whole gate, CSCB's Phase 1 floor included, as for
 * clean_restart; `stop --stop-bots` passes the option that leaves the floor
 * out, and the client's own too-old refusal still fails the gate. On
 * failure it throws {@link StartupGateFailedError} with the outcome's class
 * label, message and refusal kind, so the caller (clean_restart /
 * `stop --stop-bots`) exits loudly rather than silently skipping teardown.
 * `gateDeps` overrides the gate's seams (tests); production passes none.
 */
export async function initProductionClient(
  callTimeoutMs: number,
  gateOptions?: InitClientGateOptions,
  gateDeps?: Partial<StartupGateDeps>,
): Promise<void> {
  const outcome = await runStartupGate(gateDeps, { ...gateOptions, callTimeoutMs })
  if (!outcome.ok) {
    throw new StartupGateFailedError(outcome.classLabel, outcome.message, outcome.refusalKind)
  }
}

// ---------------------------------------------------------------------------
// Top-level entry point
// ---------------------------------------------------------------------------

if (import.meta.main) {
  const subcommand = process.argv[2]

  if (
    subcommand !== 'start' &&
    subcommand !== 'stop' &&
    subcommand !== 'clean_restart' &&
    subcommand !== 'credentials' &&
    subcommand !== CLEAR_LATCH_COMMAND
  ) {
    for (const line of CLI_USAGE_LINES) console.error(line)
    process.exit(1)
  }

  const directorOps = createDirectorOps(getClient)

  const realDeps: CliDeps = {
    spawnSync: (cmd, args) => spawnSync(cmd, args, { stdio: 'ignore' }),
    spawnDaemon: (cmd, args, opts) => spawn(cmd, args, opts),
    openLogAppend: (path) => openSync(path, 'a'),
    closeFd: (fd) => closeSync(fd),
    initLogging,
    existsSync,
    readFileSync: (path) => readFileSync(path, 'utf-8'),
    fileSize,
    readFileFrom,
    now: () => Date.now(),
    sleep: (ms) => new Promise<void>((r) => setTimeout(r, ms)),
    unlinkSync,
    isProcessRunning,
    kill: (pid, signal) => process.kill(pid, signal as NodeJS.Signals),
    resolveStateDir: () => resolveServerStateDir(),
    resolveConfigPath: () => resolveServerConfigPath(),
    startServer: async () => { const { main } = await import('./server.ts'); return main() },
    exit: (code) => process.exit(code),
    loadConfig: (path) => readAppliedPersonaConfig(path),
    loadConfigFile: (path) => loadPersonaConfig(path),
    runCredentialsScript,
    // b.qwo: install the AD Client singleton via the non-exiting startup gate
    // before the precheck and teardown, with the configuration's call timeout
    // (b.jg5 SRJ-213) and the caller's gate options (b.jg5 SRJ-203).
    initClient: (callTimeoutMs, gateOptions) => initProductionClient(callTimeoutMs, gateOptions),
    directorGet: directorOps.directorGet,
    directorReadPane: directorOps.directorReadPane,
    directorStatus: directorOps.directorStatus,
    directorPause: directorOps.directorPause,
    directorKill: directorOps.directorKill,
    directorList: directorOps.directorList,
    // b.jg5 SRJ-909: the teardown's server.log lines and startup-errors.log
    // entries, in the state directory the server uses, the entries with no
    // copy on fd 2.
    appendServerLogLine: (line, at) => appendLogLine(join(resolveServerStateDir(), 'server.log'), line, at),
    recordStartupErrorEntry: (classLabel, message) =>
      recordStartupError(classLabel, message, undefined, { logDir: resolveServerStateDir(), omitStderr: true }),
    // b.jg5 SRJ-510: clear-latch's one request to 127.0.0.1, with no timeout of its own.
    dialClearLatch: (port, persona) => dialClearLatch(port, persona),
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
  } else if (subcommand === 'credentials') {
    cli.credentials(process.argv.slice(3)).catch((err) => {
      console.error('[slack] Fatal:', err)
      process.exit(1)
    })
  } else if (subcommand === CLEAR_LATCH_COMMAND) {
    cli.clearLatch(process.argv.slice(3)).catch((err) => {
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
