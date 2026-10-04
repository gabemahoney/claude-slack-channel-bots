/**
 * cli.test.ts — Coverage for the CLI surface (`start`, `stop`,
 * `clean_restart`, `credentials`) at the createCli factory level, with all
 * I/O injected; for `clear-latch` (b.jg5 SRJ-509), only its usage entry, the
 * entry point, the production dial's wiring and the retired-key check, its
 * rows being tests/clear-latch.test.ts's. No other command dials
 * `clear-latch`'s route: the fixture's default dial records any call and
 * fails the case. `credentials <persona>` finds the persona by name or key in
 * `config.json` as it stands (never the record) and hands its
 * `credentials_file` to an injected fake of the credentials-script runner;
 * the script itself, and the one real run of the CLI through it, are
 * tests/credentials-command.test.ts's.
 *
 * Persona model (b.av2 SR-8.7, SR-10.2): the CLI reads no Slack token (AC 47,
 * cli leg), takes its settings and persona set from the configuration the
 * server runs (`config.json.last-applied` beside `config.json` in the state
 * directory when it exists, otherwise `config.json`), and tears down exactly
 * that configuration's personas, addressing each instance as `cscb_<key>`.
 *
 * The retired-key record (b.jg5 SRJ-801): only the server writes it. Every
 * command that acts leaves a record seeded by `writeRetiredKeysRecord`
 * byte-identical, a marked key whose row the stub client reports live
 * included, and creates none where there was none.
 *
 * Isolation (b.av2 SR-13.2): every real path sits under a per-test
 * `mkdtempSync` directory removed in `afterEach`. The token variables are
 * removed for the whole file (restored afterwards), so no case or failure
 * message can see an ambient token. `start`'s daemon is always the injected
 * fake `spawnDaemon`; the only real spawns are the eight tests of the
 * `unknown subcommand` block (and its hidden-subcommand `beforeAll`), the
 * two real-CLI tests of `credentials` (a usage error and an unknown persona,
 * neither of which reaches the script) and the two of `clear-latch` (a usage
 * error and no PID file, neither of which dials), which
 * run the CLI script through `runCli`, whose env is a direct `hostSafeChildEnv`
 * call (temp HOME, no PATH directory, its own TMUX_TMPDIR, plus temp
 * SLACK_STATE_DIR and BUN_RUNTIME_TRANSPILER_CACHE_PATH=0). Waits in `start` and
 * `stop` (the daemon startup wait, the SIGTERM and SIGKILL polls), the
 * precheck's tries, the teardown's pause tries, poll and kill tries, and
 * `clean_restart`'s answer check run on the per-test fake clock; none waits in real time, and no case leaves a timer
 * pending.
 *
 * The precheck (b.jg5 SRJ-901): before `stop --stop-bots` or `clean_restart`
 * stops anything, one `get` and, for a live row, one one-line `read-pane` of
 * each persona's `cscb_<key>` (the fixture's `directorGet` and
 * `directorReadPane`, by default a live `waiting` row and a pane). The
 * verdict over each answer is tests/cli-teardown.test.ts's.
 *
 * The teardown (b.jg5 SRJ-903, SRJ-119, SRJ-904, SRJ-908): after a passed
 * precheck and the server stop, each persona's `status` read, its `pause`
 * decided by class (GONE and every other answer escalate to the kill,
 * UNAVAILABLE is tried three times 2 s apart, CONFLICT, ENVIRONMENT, UNUSABLE
 * NAME, another `ErrInternal` and CONFIG fail with no kill), the poll after
 * it, and the kill: the bounded retry of checked kills by class, with a
 * `status` read before each further try (the fixture's `directorKill`
 * answers `cannedKillResult(true)` by default). The fixture records each
 * director call's fake-clock time, can make each call take a set time
 * (`callMs`) for the bound cases, and `scripted` gives a verb its answers in
 * call order. The verdicts and the kill's mapping per answer are
 * tests/cli-teardown.test.ts's.
 *
 * The teardown's report (b.jg5 SRJ-907, SRJ-909, SRJ-1013): once every
 * persona has settled, each failed persona's failure line, followed by the
 * kill-failure alert's ordinary version where the kill's decision says so,
 * and a stopped persona's survivor version, in configuration order, then the
 * last line when any persona failed. Each line and alert is printed once
 * (for `clean_restart` once in `clean_restart.log` too), appended to the real
 * `<stateDir>/server.log` through the fixture's `appendServerLogLine` seam
 * (`appendLogLine` over the temp tree, timed by the fake clock) and recorded
 * in the real `<stateDir>/startup-errors.log` through its
 * `recordStartupErrorEntry` seam (`recordStartupError` with the temp state
 * directory and no copy on fd 2); the last line is printed only. Every
 * expected line comes from the builders of `src/cli-teardown.ts` and
 * `src/kill-failure-alert.ts`.
 *
 * After the teardown (b.jg5 SRJ-905, SRJ-906, SRJ-1013): `stop --stop-bots`
 * never starts the server. `clean_restart` after a failed teardown checks
 * that agent-director answers through the fixture's `directorList` (each
 * call recorded with its fake-clock time and in `events`; by default a
 * successful empty list, so it answers at once and the server is started),
 * and when it never answers starts nothing and prints, logs and records the
 * not-restarted alert (`cleanRestartNotRestartedAlert`). The tries on the
 * injected clock (`callWithCliTries`) are also tested on their own.
 *
 * The client's initialization (b.jg5 SRJ-203, SRJ-902): the fixture's
 * `initClient` records the call timeout and the gate each command asks for
 * (`clean_restart` the whole gate, `stop --stop-bots` the gate without CSCB's
 * Phase 1 floor). Every gate refusal a case throws is the real gate's
 * (`initProductionClient` or `runStartupGate` over passing seams and the stub
 * client factory), and the cases that run `stop --stop-bots` through the stub
 * client install it as the singleton and reset it after each case; no
 * agent-director binary runs.
 *
 * SPDX-License-Identifier: MIT
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from 'bun:test'

import { SocketModeClient } from '@slack/socket-mode'
import { WebClient } from '@slack/web-api'
import { spawnSync } from 'node:child_process'
import { EventEmitter } from 'node:events'
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'
import {
  CLEAR_LATCH_USAGE,
  CLEAR_LATCH_USAGE_ENTRY,
  CLI_USAGE_LINES,
  CREDENTIALS_SCRIPT_PATH,
  CREDENTIALS_USAGE,
  DAEMON_FAILURE_LOG_LINES,
  DAEMON_STARTUP_POLL_MS,
  DAEMON_STARTUP_WAIT_MS,
  STOP_KILL_WAIT_MS,
  STOP_POLL_MS,
  StartupGateFailedError,
  callWithCliTries,
  clearLatchCliNoServerLine,
  createCli,
  createDirectorOps,
  initProductionClient,
  type CliDeps,
  type DaemonSpawnOptions,
  type DirectorClient,
  type DirectorOps,
  type InitClientGateOptions,
} from '../src/cli.ts'
import {
  CLEAR_LATCH_COMMAND,
  serverPortFilePath,
  writeServerPortRecord,
  type ClearLatchDialAnswer,
} from '../src/clear-latch.ts'
import {
  AD_CONFIG_FILE_DISPLAY_NAME,
  CLEAN_RESTART_NOT_RESTARTED_LABEL,
  CLI_COMMAND_CLEAN_RESTART,
  CLI_COMMAND_STOP_BOTS,
  PRECHECK_CALL_GET,
  PRECHECK_CALL_READ_PANE,
  PRECHECK_TRIES,
  PRECHECK_TRY_SPACING_MS,
  PAUSE_VERDICT_ESCALATE,
  PAUSE_VERDICT_FAIL,
  PAUSE_VERDICT_RETRY,
  TEARDOWN_POLL_FIRST_WAIT_MS,
  TEARDOWN_KILL_OPTIONS,
  TEARDOWN_POLL_MAX_WAIT_MS,
  teardownKillReadOf,
  CLI_TEARDOWN_FAILED_LABEL,
  agentDirectorInitFailedLine,
  answerCheckFailedTryLine,
  cleanRestartNotRestartedAlert,
  cleanRestartStartFailedLine,
  cleanRestartStartingAfterFailedTeardownLine,
  exitTimeoutMsOf,
  onlyServerStoppedLine,
  precheckBoundMs,
  precheckFailureLine,
  precheckNothingStoppedLine,
  precheckVerdictOf,
  teardownBoundMs,
  teardownErrorReportOf,
  teardownFailureLine,
  teardownNotStoppedLine,
  type CleanRestartFailedPersona,
  type CliTeardownCommand,
  type CliTeardownPersona,
  type PrecheckCall,
  type PrecheckFailure,
  type PrecheckRow,
} from '../src/cli-teardown.ts'
import {
  AD_ERROR_CLASS_CONFIG,
  AD_ERROR_CLASS_CONFLICT,
  AD_ERROR_CLASS_DIRECTORY,
  AD_ERROR_CLASS_ENVIRONMENT,
  AD_ERROR_CLASS_GONE,
  AD_ERROR_CLASS_LAUNCH_FAILURE,
  AD_ERROR_CLASS_STATE,
  AD_ERROR_CLASS_UNAVAILABLE,
  AD_ERROR_CLASS_UNCLASSIFIED,
  AD_ERROR_CLASS_UNUSABLE_NAME,
  describeReportedAdFailure,
  type AdErrorClass,
} from '../src/ad-error-class.ts'
import {
  AgentDirectorError,
  ERR_SCHEMA_MISMATCH_NAME,
  ERR_SPAWN_NOT_FOUND_NAME,
  ERR_TMUX_SESSION_CONFLICT_NAME,
  ErrCallTimeout,
  STORE_OPEN_ERR_NAMES,
} from '../src/agent-director-errors.ts'
import { AGENT_DIRECTOR_DEAD_STATES, AGENT_DIRECTOR_LIVE_STATES, AGENT_DIRECTOR_PENDING_STATE } from '../src/liveness-reading.ts'
import {
  REFUSAL_KIND_BELOW_PHASE1_FLOOR,
  REFUSAL_KIND_CLIENT_TOO_OLD,
  REFUSAL_KIND_OTHER,
  runStartupGate,
  type StartupGateDeps,
  type StartupGateFailure,
  type StartupGateOptions,
  type StartupGateRefusalKind,
} from '../src/agent-director-startup.ts'
import { getClient, resetClientForTests, setClientForTests } from '../src/agent-director-client.ts'
import {
  KILL_OUTCOME_ROW_FINISHED,
  KILL_OUTCOME_SESSION_GONE,
  KILL_ROW_FINISHED_ENDED,
  describeKillOutcome,
  killOutcomeOf,
  type AnyKillOutcome,
} from '../src/checked-kill.ts'
import {
  KILL_FAILURE_ORDINARY_CLI_TEARDOWN_CLOSING,
  KILL_FAILURE_SURVIVOR_CLI_TEARDOWN_CLOSING,
  KILL_FAILURE_VERSION_ORDINARY,
  KILL_FAILURE_VERSION_SURVIVOR,
  PERSONA_KILL_FAILED_LABEL,
  PERSONA_KILL_SURVIVOR_LABEL,
  killFailureAlertEntryText,
  killFailureCliTeardownEntryContext,
  type KillFailureOrdinaryQuotes,
} from '../src/kill-failure-alert.ts'
import { appendLogLine } from '../src/logging.ts'
import { describeThrownValue } from '../src/persona-connection-errors.ts'
import { recordStartupError } from '../src/startup-errors.ts'
import {
  KILL_RETRY_ALERT_NONE,
  KILL_RETRY_ALERT_ORDINARY,
  KILL_RETRY_END_READ_CONFIG,
  KILL_RETRY_END_SETTLED,
  KILL_RETRY_NEXT_NOT_RETRIED,
  KILL_RETRY_SPACING_MS,
  KILL_RETRY_TRIES,
  KILL_RETRY_END_ROW_FINISHED,
  KILL_RETRY_NEXT_NOT_LIVE,
  KILL_RETRY_NEXT_SUCCESS,
  KILL_RETRY_VERDICT_FINISHED,
  KILL_RETRY_VERDICT_GO,
  killRetryEndLine,
  killRetryReadLine,
  killRetrySeedOfState,
  killRetryTryLine,
} from '../src/kill-retry.ts'
import { buildBelowPhase1FloorMessage } from '../src/ad-version-gate.ts'
import { AD_BELOW_PHASE1_FLOOR, AD_SYSTEM_INSTALL_NOT_FOUND, AD_SYSTEM_INSTALL_TOO_OLD } from '../src/install-check.ts'
import {
  CONFIG_NOT_REGULAR_FILE_CODE,
  DEFAULT_AGENT_DIRECTOR_CALL_TIMEOUT_MS,
  DEFAULT_PERSONA_CONFIG_FS,
  loadPersonaConfig,
  MAX_AGENT_DIRECTOR_CALL_TIMEOUT_MS,
  MIN_AGENT_DIRECTOR_CALL_TIMEOUT_MS,
  prePersonaConversionMessage,
  resolveServerConfigPath,
  resolveServerStateDir,
  type PersonaConfig,
  type PersonaConfigFs,
  type PersonaConfigInput,
} from '../src/config.ts'
import { SERVICE_LABEL, personaInstanceId, personaKey, personaTmuxSessionName, renderPersonaRef } from '../src/persona-identity.ts'
import { PROBE_PANE_READ_LINES } from '../src/pane-read.ts'
import { readAppliedPersonaConfig } from '../src/reload.ts'
import { RETIRED_KEY_CAUSE_DESTRUCTIVE_MODIFY, RETIRED_KEY_CAUSE_REMOVED, retiredKeysPath } from '../src/retired-keys.ts'
import type * as RetiredKeysModule from '../src/retired-keys.ts'
import {
  APP_TOKEN_PREFIX,
  assertNoLeak,
  BOT_TOKEN_PREFIX,
  fakeToken,
  LEAK_SENTINEL,
  REDACTED_SENTINEL_TAIL,
  sentinelInMessage,
  writeCredentialsFile,
  writtenFile,
} from './test-helpers/credentials.ts'
import { UNKNOWN_STATE, cliAlertLine, teardownKillFailedDescription } from './test-helpers/cli-teardown.ts'
import { createFakeClock, type FakeClock } from './test-helpers/fake-clock.ts'
import {
  CONFLICT_CASES,
  KILL_FAILED_DESCRIPTIONS,
  SAMPLE_LAUNCH_START_DEFAULT,
  SAMPLE_LAUNCH_START_NONE,
  STUB_SURVIVOR_PIDS,
  STUB_TMUX_SOCKET_PATH,
  UNAVAILABLE_FORMS,
  UNUSABLE_NAME_FAULTS,
  cannedGetResult,
  cannedKillResult,
  cannedListRow,
  cannedStatusResult,
  errCallTimeout,
  errConfigMalformed,
  errCwdNotFound,
  errGeneric,
  errInternal,
  errPauseTimeout,
  errRelayModeOff,
  errSchemaMismatch,
  errSpawnNotFound,
  errSpawnNotInteractive,
  errSpawnNotPausable,
  errSystemInstallDisappeared,
  errSystemInstallNotFound,
  errSystemInstallTooOld,
  errTmuxCaptureFailed,
  errTmuxKillFailed,
  errTmuxNotAvailable,
  errTmuxNotAvailableDifferentServer,
  errTmuxSendKeys,
  errTmuxSessionConflict,
  errTmuxSessionCreate,
  errTmuxUnresponsive,
  errUnknownErrorName,
  errUnusableName,
  makePassingGateDeps,
  provenanceNote,
  makeStubCallLog,
  makeStubClient,
  makeStubCreateClient,
  stubCallCount,
  type StubClientOptions,
  type StubCreateClientOptions,
} from './test-helpers/agent-director-stub.ts'
import { BELOW_CLIENT_MIN_VERSION, CLIENT_MIN_VERSION, OLD_AD_VERSION } from './test-helpers/agent-director-versions.ts'
import { hostSafeChildEnv } from './test-helpers/host-safe-env.ts'
import {
  makeMultiPersonaConfig,
  makePersona,
  makePersonaConfigInput,
  writeConfigFile,
} from './test-helpers/persona-config.ts'
import { reloadTermsIn } from './test-helpers/reload-terms.ts'
import { writeRetiredKeysRecord } from './test-helpers/retired-keys.ts'
import {
  balancedAfter,
  callArguments,
  callsOf,
  importedSpecifiers,
  indicesOf,
  objectProperties,
  onlyCallArguments,
  splitTopLevel,
  stripComments,
} from './test-helpers/source-audit.ts'

const CLI_SOURCE = resolve(import.meta.dir, '..', 'src', 'cli.ts')
const TOKEN_VARS = ['SLACK_BOT_TOKEN', 'SLACK_APP_TOKEN'] as const

// ---------------------------------------------------------------------------
// File-level isolation: no ambient token for any case (b.av2 SR-13.2)
// ---------------------------------------------------------------------------

const savedTokenEnv: Record<string, string | undefined> = {}
const originalConsoleError = console.error
const originalConsoleLog = console.log

beforeAll(() => {
  for (const name of TOKEN_VARS) {
    savedTokenEnv[name] = process.env[name]
    delete process.env[name]
  }
})

afterAll(() => {
  for (const name of TOKEN_VARS) {
    if (savedTokenEnv[name] === undefined) delete process.env[name]
    else process.env[name] = savedTokenEnv[name]
  }
})

/** One captured console line: the args joined with spaces, an Error as its message. */
const formatLine = (args: unknown[]): string => args.map((a) => (a instanceof Error ? a.message : String(a))).join(' ')

/** An initLogging that sends console.error to `log`, as the real one sends it to clean_restart.log. */
const redirectTo = (log: string[]) => (): void => {
  console.error = (...args: unknown[]) => { log.push(formatLine(args)) }
}

class ExitError extends Error {
  constructor(public readonly code: number) {
    super(`exit(${code})`)
  }
}

// Per-test temp tree: <root>/state is the state directory the CLI resolves.
let root: string
let stateDir: string
let configPath: string
let logPath: string
let pidPath: string
let stderr: string[]
let errorSpy: ReturnType<typeof spyOn>
let savedArgv: string[]
/** The fake clock of the case's last `makeDeps` bundle; checked for pending timers after each case. */
let currentClock: FakeClock | null
/**
 * Every call of a `makeDeps` bundle's default `dialClearLatch` in the case,
 * as `[port, persona]`; checked empty after each case, so a command other
 * than `clear-latch` that dials fails it (b.jg5 SRJ-509).
 */
let unexpectedDials: Array<[port: number, persona: string]>

beforeEach(() => {
  currentClock = null
  unexpectedDials = []
  root = mkdtempSync(join(tmpdir(), 'cscb-cli-'))
  stateDir = join(root, 'state')
  mkdirSync(stateDir)
  configPath = join(stateDir, 'config.json')
  logPath = join(stateDir, 'server.log')
  pidPath = join(stateDir, 'server.pid')
  // A config file exists by default; `start` checks for it.
  writeConfigFile(stateDir, makePersonaConfigInput({ personas: [makePersona({ name: OPS_NAME }, root)] }, root))
  savedArgv = process.argv
  stderr = []
  errorSpy = spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    stderr.push(formatLine(args))
  })
})

afterEach(() => {
  errorSpy.mockRestore()
  // Belt and braces: nothing may leave console redirected for later files.
  console.error = originalConsoleError
  console.log = originalConsoleLog
  process.argv = savedArgv
  delete process.env['_CLI_DAEMON_CHILD']
  for (const name of TOKEN_VARS) delete process.env[name]
  rmSync(root, { recursive: true, force: true })
  // Every wait ran on the fake clock and none is left behind (b.jg5 SRJ-908).
  expect(currentClock?.pending() ?? []).toEqual([])
  // Only clear-latch dials, and no case here runs it over the default dial.
  expect(unexpectedDials).toEqual([])
})

/**
 * Every path under the per-test root (state dir and credentials files,
 * directories included), sorted, with each file's bytes in base64 and `null`
 * for a directory. Compare two snapshots with `toEqual`: a file added,
 * removed, renamed or changed by one byte fails.
 */
function snapshotTree(): Record<string, string | null> {
  const entries = (readdirSync(root, { recursive: true }) as string[]).sort()
  return Object.fromEntries(entries.map((rel) => {
    const path = join(root, rel)
    return [rel, statSync(path).isFile() ? readFileSync(path, 'base64') : null]
  }))
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** A persona whose name differs from its key, so name- or channel-addressing fails. */
const OPS_NAME = 'Ops Bot'
const OPS_CHANNEL = 'C0TEST001'
const opsId = (): string => personaInstanceId(personaKey(OPS_NAME))
/** The Ops persona as the teardown's lines name it. */
const OPS_PERSONA: CliTeardownPersona = Object.freeze({ name: OPS_NAME, key: personaKey(OPS_NAME) })

/** The last-applied record beside the per-test config.json. */
const recordPath = (): string => `${configPath}.last-applied`

/** The production `loadConfig` (b.av2 SR-8.7) over the per-test tree, with the temp root as home. */
const appliedLoader = (path: string): PersonaConfig => readAppliedPersonaConfig(path, root)

function opsConfig(overrides: Partial<Omit<PersonaConfig, 'personas'>> = {}): PersonaConfig {
  return makeMultiPersonaConfig([{ name: OPS_NAME, channels: [{ id: OPS_CHANNEL, delivery: 'all' }] }], root, overrides)
}

/** Two personas: Alpha is in two channels, Beta is in none with DMs on. */
const ALPHA = {
  name: 'Alpha Bot',
  channels: [{ id: 'C0ALPHA01', delivery: 'all' as const }, { id: 'C0SHARED1', delivery: 'mentions' as const }],
  permission_prompts: 'C0ALPHA01',
}
const BETA = { name: 'Beta', channels: [], dm: { enabled: true, contact: 'U0TEST001' }, permission_prompts: 'dm' }
/** The configuration of {@link ALPHA} and {@link BETA}, in that order. */
const twoPersonas = (): PersonaConfig => makeMultiPersonaConfig([ALPHA, BETA], root)

/** A fake daemon child: never a real process; records signals so "never signalled" is checkable. */
class FakeDaemon extends EventEmitter {
  unrefCalls = 0
  readonly signals: unknown[] = []
  constructor(public readonly pid: number | undefined) {
    super()
  }
  unref(): void {
    this.unrefCalls++
  }
  kill(signal?: unknown): boolean {
    this.signals.push(signal)
    return true
  }
}

/** The precheck `get`'s default answer: a live `waiting` row with no note and no launch start. */
const LIVE_ROW: PrecheckRow = Object.freeze({ state: 'waiting' })
/** The precheck `read-pane`'s default answer: a pane. */
const FAKE_PANE = '> '

const DAEMON_PID = 999_999
/** The descriptor the fake `openLogAppend` returns; never a real open file. */
const LOG_FD = 57

/** What a daemon script gets: the child and the clock to schedule its behaviour on. */
interface DaemonCtl {
  child: FakeDaemon
  clock: FakeClock
}

/** Default daemon: writes its own PID to the PID file after 200 ms (ready). */
const readyDaemon = ({ child, clock }: DaemonCtl): void => {
  clock.setTimeout(() => writeFileSync(pidPath, `${child.pid}\n`), 200)
}

interface Overrides {
  spawnSyncStatus?: number | null
  /** Written to the real `<stateDir>/server.pid` before the call. */
  serverPid?: number
  isProcessRunning?: (pid: number) => boolean
  /** Resolved config the stub loader returns; default `opsConfig()`. */
  config?: PersonaConfig
  loadConfig?: (path: string) => PersonaConfig
  /** Daemon behaviour scheduled at spawn; default `readyDaemon`. */
  daemon?: (ctl: DaemonCtl) => void
  daemonPid?: number | undefined
  /** Thrown by the fake `spawnDaemon` instead of returning a child. */
  spawnDaemonError?: Error
  /** Runs after the call is recorded; the default only records (console is never redirected). */
  initLogging?: (path: string) => void
  /** Answers each `initClient` call, given the call timeout and the gate options it received. */
  initClient?: (callTimeoutMs: number, gateOptions?: InitClientGateOptions) => Promise<void>
  /** The precheck's `get`; default a live `waiting` row with no note ({@link LIVE_ROW}). */
  directorGet?: (id: string) => Promise<PrecheckRow | null>
  /** The precheck's `read-pane`; default a pane ({@link FAKE_PANE}). */
  directorReadPane?: (id: string, nLines: number) => Promise<string>
  directorStatus?: (id: string) => Promise<{ state: string } | null>
  directorPause?: (id: string) => Promise<void>
  /** The teardown's kill; default the Phase 1 success with a kill sent (`cannedKillResult(true)`). */
  directorKill?: (id: string) => Promise<unknown>
  /**
   * `clean_restart`'s answer check's `list` (b.jg5 SRJ-906); default a
   * successful empty list, so agent-director answers at the first try.
   */
  directorList?: CliDeps['directorList']
  /**
   * How long each director call (`get`, `read-pane`, `status`, `pause`,
   * `kill`, `list`) takes on the fake clock before it answers, as a call that uses
   * its whole call timeout does (b.jg5 SRJ-908); default 0, an answer at once.
   */
  callMs?: number
  /** `credentials`' loader of the configuration file; default the real `loadPersonaConfig` with the temp root as home. */
  loadConfigFile?: (path: string) => PersonaConfig
  /** The credentials script's exit status the fake runner returns; default 0. */
  credentialsScriptStatus?: number
  /**
   * Called with each `sleep`'s time before the fake clock moves; a throw
   * rejects that `sleep`. Default: none, every sleep only moves the clock.
   */
  sleep?: (ms: number) => Promise<void>
  /**
   * The teardown's `server.log` appender; default the real `appendLogLine`
   * on `<stateDir>/server.log` in the temp tree (b.jg5 SRJ-909).
   */
  appendServerLogLine?: CliDeps['appendServerLogLine']
  /**
   * The teardown's startup-errors recorder; default the real
   * `recordStartupError` into `<stateDir>/startup-errors.log` in the temp
   * tree, with no copy on fd 2 (b.jg5 SRJ-909, SRJ-1013).
   */
  recordStartupErrorEntry?: CliDeps['recordStartupErrorEntry']
  /**
   * `clear-latch`'s dial (b.jg5 SRJ-510). Default: none of this file's
   * commands may dial; the default records the call in `unexpectedDials`,
   * which fails the case, and rejects.
   */
  dialClearLatch?: CliDeps['dialClearLatch']
}

interface Bundle {
  deps: CliDeps
  clock: FakeClock
  exitCodes: number[]
  /** Fake-clock time of each exit. */
  exitTimes: number[]
  spawnCalls: Array<{ cmd: string; args: string[] }>
  daemonSpawns: Array<{ cmd: string; args: string[]; opts: DaemonSpawnOptions; child: FakeDaemon }>
  logOpens: string[]
  closedFds: number[]
  logInits: string[]
  loadPaths: string[]
  /** The id of each precheck `get`, in call order. */
  getCalls: string[]
  /** The id and line count of each precheck `read-pane`, in call order. */
  readPaneCalls: Array<[id: string, nLines: number]>
  /**
   * Each director call (`get`, `read-pane`, `status`, `pause`, `kill`) as
   * `<verb>:<id>`, and each `list` as {@link LIST_CALL}, with its fake-clock
   * time.
   */
  directorCallTimes: Array<[call: string, at: number]>
  statusCalls: string[]
  pauseCalls: string[]
  killCalls: string[]
  serverSignals: string[]
  events: string[]
  /** The call timeout each `initClient` call received, in call order (b.jg5 SRJ-213). */
  initClientCalls: number[]
  /**
   * The gate each `initClient` call asked for, in call order (b.jg5 SRJ-203):
   * `undefined` for the whole gate, {@link FLOOR_EXEMPT_GATE} for the gate
   * without CSCB's Phase 1 floor.
   */
  initClientGates: Array<InitClientGateOptions | undefined>
  /** Each path `credentials` loaded the configuration file from. */
  configFileLoads: string[]
  /** Each credentials file the fake credentials-script runner was given. */
  credentialsRuns: string[]
  /** Each path given to `unlinkSync`, in call order; the fake removes nothing. */
  unlinked: string[]
  /** Each `dialClearLatch` call as `[port, persona]`, in call order, the default's included. */
  dialCalls: Array<[port: number, persona: string]>
  readonly startServerCalled: boolean
}

/**
 * Deps over the per-test temp state dir. The state dir and config path come
 * from the real resolvers with an injected env naming the temp dir, the same
 * functions production wires (see the wiring audit). File reads are real, on
 * the temp tree; the director verbs, loader, spawns and clock are fakes.
 */
function makeDeps(o: Overrides = {}): Bundle {
  const clock = createFakeClock()
  currentClock = clock
  const getCalls: string[] = []
  const readPaneCalls: Bundle['readPaneCalls'] = []
  const directorCallTimes: Bundle['directorCallTimes'] = []
  /** Record one director call in the event order with its fake-clock time, then take `callMs` on the fake clock. */
  const directorCall = async (call: string): Promise<void> => {
    events.push(call)
    directorCallTimes.push([call, clock.now()])
    if (o.callMs !== undefined && o.callMs > 0) await clock.advance(o.callMs)
  }
  const exitCodes: number[] = []
  const exitTimes: number[] = []
  const spawnCalls: Bundle['spawnCalls'] = []
  const daemonSpawns: Bundle['daemonSpawns'] = []
  const loadPaths: string[] = []
  const logOpens: string[] = []
  const closedFds: number[] = []
  const logInits: string[] = []
  const statusCalls: string[] = []
  const pauseCalls: string[] = []
  const killCalls: string[] = []
  const serverSignals: string[] = []
  const events: string[] = []
  const initClientCalls: number[] = []
  const initClientGates: Bundle['initClientGates'] = []
  const configFileLoads: string[] = []
  const credentialsRuns: string[] = []
  const unlinked: string[] = []
  const dialCalls: Bundle['dialCalls'] = []
  let startServerCalled = false
  if (o.serverPid !== undefined) writeFileSync(pidPath, `${o.serverPid}\n`)
  const stateEnv = { SLACK_STATE_DIR: stateDir }
  const deps: CliDeps = {
    spawnSync: (cmd, args) => {
      spawnCalls.push({ cmd, args })
      events.push(`spawnSync:${args.at(-1)}`)
      return { status: o.spawnSyncStatus !== undefined ? o.spawnSyncStatus : 0 }
    },
    spawnDaemon: (cmd, args, opts) => {
      events.push('spawnDaemon')
      if (o.spawnDaemonError) throw o.spawnDaemonError
      const child = new FakeDaemon('daemonPid' in o ? o.daemonPid : DAEMON_PID)
      daemonSpawns.push({ cmd, args, opts, child })
      ;(o.daemon ?? readyDaemon)({ child, clock })
      return child
    },
    openLogAppend: (path) => {
      logOpens.push(path)
      events.push('openLogAppend')
      return LOG_FD
    },
    closeFd: (fd) => {
      closedFds.push(fd)
      events.push(`closeFd:${fd}`)
    },
    initLogging: (path) => {
      logInits.push(path)
      events.push('initLogging')
      o.initLogging?.(path)
    },
    existsSync: (p) => existsSync(p),
    readFileSync: (p) => readFileSync(p, 'utf-8'),
    fileSize: (p) => (existsSync(p) ? statSync(p).size : 0),
    readFileFrom: (p, offset) => (existsSync(p) ? readFileSync(p).subarray(offset).toString('utf-8') : ''),
    now: () => clock.now(),
    sleep: async (ms) => {
      events.push('sleep')
      await o.sleep?.(ms)
      await clock.advance(ms)
    },
    // Recorded only: the PID file stays (nothing reads it again) and the tree is unchanged.
    unlinkSync: (p) => { unlinked.push(p) },
    isProcessRunning: o.isProcessRunning ?? (() => false),
    kill: (_pid, signal) => {
      serverSignals.push(String(signal))
      events.push(`server:${String(signal)}`)
    },
    resolveStateDir: () => resolveServerStateDir(root, stateEnv),
    resolveConfigPath: () => resolveServerConfigPath(root, stateEnv),
    startServer: async () => { startServerCalled = true },
    exit: (code) => {
      exitCodes.push(code)
      exitTimes.push(clock.now())
      throw new ExitError(code)
    },
    loadConfig: (path) => {
      loadPaths.push(path)
      events.push('loadConfig')
      return o.loadConfig ? o.loadConfig(path) : (o.config ?? opsConfig())
    },
    loadConfigFile: (path) => {
      configFileLoads.push(path)
      events.push('loadConfigFile')
      return o.loadConfigFile ? o.loadConfigFile(path) : loadPersonaConfig(path, root)
    },
    runCredentialsScript: (credentialsFile) => {
      credentialsRuns.push(credentialsFile)
      events.push('runCredentialsScript')
      return o.credentialsScriptStatus ?? 0
    },
    appendServerLogLine: (line, at) => {
      events.push('appendServerLogLine')
      return o.appendServerLogLine ? o.appendServerLogLine(line, at) : appendLogLine(logPath, line, at)
    },
    recordStartupErrorEntry: (classLabel, message) => {
      events.push('recordStartupErrorEntry')
      if (o.recordStartupErrorEntry) return o.recordStartupErrorEntry(classLabel, message)
      recordStartupError(classLabel, message, undefined, { logDir: stateDir, omitStderr: true })
    },
    ...(o.initClient
      ? {
          initClient: async (callTimeoutMs: number, gateOptions?: InitClientGateOptions) => {
            initClientCalls.push(callTimeoutMs)
            initClientGates.push(gateOptions)
            events.push('initClient')
            return o.initClient!(callTimeoutMs, gateOptions)
          },
        }
      : {}),
    directorGet: async (id) => {
      getCalls.push(id)
      await directorCall(`${PRECHECK_CALL_GET}:${id}`)
      return o.directorGet ? o.directorGet(id) : LIVE_ROW
    },
    directorReadPane: async (id, nLines) => {
      readPaneCalls.push([id, nLines])
      await directorCall(`${PRECHECK_CALL_READ_PANE}:${id}`)
      return o.directorReadPane ? o.directorReadPane(id, nLines) : FAKE_PANE
    },
    directorStatus: async (id) => {
      statusCalls.push(id)
      await directorCall(`status:${id}`)
      return o.directorStatus ? o.directorStatus(id) : null
    },
    directorPause: async (id) => {
      pauseCalls.push(id)
      await directorCall(`pause:${id}`)
      if (o.directorPause) return o.directorPause(id)
    },
    directorKill: async (id) => {
      killCalls.push(id)
      await directorCall(`kill:${id}`)
      return o.directorKill ? o.directorKill(id) : cannedKillResult(true)
    },
    directorList: async () => {
      await directorCall(LIST_CALL)
      return o.directorList ? o.directorList() : []
    },
    dialClearLatch: async (port, persona) => {
      dialCalls.push([port, persona])
      events.push('dialClearLatch')
      if (o.dialClearLatch) return o.dialClearLatch(port, persona)
      unexpectedDials.push([port, persona])
      throw new Error('precondition: no command in this case dials clear-latch\'s route')
    },
  }
  return {
    deps, clock, exitCodes, exitTimes, spawnCalls, daemonSpawns, logOpens, closedFds, logInits, loadPaths,
    getCalls, readPaneCalls, directorCallTimes, statusCalls, pauseCalls, killCalls,
    serverSignals, events, initClientCalls, initClientGates, configFileLoads, credentialsRuns, unlinked, dialCalls,
    get startServerCalled() { return startServerCalled },
  }
}

/** How the fixture records each `directorList` call in `events` and `directorCallTimes`; it takes no instance id. */
const LIST_CALL = 'list'

/** The gate `stop --stop-bots` asks for: CSCB's Phase 1 floor left out (b.jg5 SRJ-203, SRJ-902). */
const FLOOR_EXEMPT_GATE: InitClientGateOptions = Object.freeze({ skipPhase1Floor: true })

/** The options each stub client was built with, as `makeStubCreateClient` records them. */
type RecordedClientOptions = NonNullable<StubCreateClientOptions['calls']>

/** Startup-gate seams that pass every check after construction; `createClient` decides the build (never a real client). */
const passingGateSeams = (createClient: StartupGateDeps['createClient']): Partial<StartupGateDeps> =>
  makePassingGateDeps({ createClient, exit: (code) => { throw new ExitError(code) } })

/**
 * The error the production init throws when the startup gate refuses the
 * build `stub` describes: the gate's own class label, message and refusal
 * kind. The gate runs over passing seams, so no agent-director binary runs.
 */
async function gateRefusalOf(stub: StubCreateClientOptions, gateOptions?: InitClientGateOptions): Promise<StartupGateFailedError> {
  const err = await initProductionClient(DEFAULT_AGENT_DIRECTOR_CALL_TIMEOUT_MS, gateOptions, passingGateSeams(makeStubCreateClient(stub)))
    .then(() => undefined, (e: unknown) => e)
  if (!(err instanceof StartupGateFailedError)) {
    resetClientForTests()
    throw new Error('precondition: the startup gate refuses the build')
  }
  return err
}

/** A stub client factory that throws the client's own too-old refusal of a binary one step below the client's minimum. */
const tooOldBuild = (calls?: RecordedClientOptions): StubCreateClientOptions => ({
  error: errSystemInstallTooOld(BELOW_CLIENT_MIN_VERSION, CLIENT_MIN_VERSION),
  calls,
})

/** The gate's client-too-old refusal of {@link tooOldBuild}, as `stop --stop-bots`' init throws it. */
const tooOldRefusal = (): Promise<StartupGateFailedError> => gateRefusalOf(tooOldBuild(), FLOOR_EXEMPT_GATE)

/**
 * One build per refusal kind the whole gate gives (b.jg5 SRJ-203): the
 * client's own too-old refusal, CSCB's floor refusing `OLD_AD_VERSION`, and
 * another construction failure.
 */
const GATE_REFUSAL_BUILDS: ReadonlyArray<readonly [StartupGateRefusalKind, () => StubCreateClientOptions]> = [
  [REFUSAL_KIND_CLIENT_TOO_OLD, () => tooOldBuild()],
  [REFUSAL_KIND_BELOW_PHASE1_FLOOR, () => ({ client: makeStubClient({ binaryVersion: OLD_AD_VERSION }) })],
  [REFUSAL_KIND_OTHER, () => ({ error: errSystemInstallNotFound() })],
]

/** The whole gate's refusal of the build of `kind` in {@link GATE_REFUSAL_BUILDS}; it keeps that kind. */
async function wholeGateRefusal(kind: StartupGateRefusalKind): Promise<StartupGateFailedError> {
  const build = GATE_REFUSAL_BUILDS.find(([k]) => k === kind)![1]
  const err = await gateRefusalOf(build())
  expect(err.refusalKind).toBe(kind)
  return err
}

/** `stop --stop-bots`' initialization-failed line for `description`. */
const stopBotsInitFailed = (description: string): string => agentDirectorInitFailedLine(CLI_COMMAND_STOP_BOTS, description)

const startedServer = (b: Bundle): boolean => b.spawnCalls.some((c) => c.args.includes('start'))

/** The fake-clock time of each `directorList` call (`clean_restart`'s answer check, b.jg5 SRJ-906), in call order. */
const listTimesOf = (b: Bundle): number[] => b.directorCallTimes.filter(([call]) => call === LIST_CALL).map(([, at]) => at)

/** The teardown's director verbs, whose calls all come before the answer check's `list`. */
const TEARDOWN_VERBS = ['status', 'pause', 'kill'] as const

/**
 * `clean_restart` after a failed teardown, agent-director answering (b.jg5
 * SRJ-906): it spawned `stop`, then made `lists` `list` calls (one by
 * default), the first after the last teardown call, then spawned `start`, so
 * the server runs again.
 */
function expectRestarted(b: Bundle, lists = 1): void {
  expect(b.spawnCalls.map((c) => c.args.at(-1))).toEqual(['stop', 'start'])
  expect(listTimesOf(b)).toHaveLength(lists)
  const list = b.events.indexOf(LIST_CALL)
  const lastTeardownCall = Math.max(...b.events.flatMap((e, i) => (TEARDOWN_VERBS.some((v) => e.startsWith(`${v}:`)) ? [i] : [])))
  expect(lastTeardownCall).toBeLessThan(list)
  expect(b.events.lastIndexOf(LIST_CALL)).toBeLessThan(b.events.indexOf('spawnSync:start'))
}

/** The precheck made exactly one `get` and one one-line `read-pane` of each of `ids`, and of no other instance (b.jg5 SRJ-901). */
function expectOnePrecheckEach(b: Bundle, ids: readonly string[]): void {
  const sorted = [...ids].sort()
  expect([...b.getCalls].sort()).toEqual(sorted)
  expect([...b.readPaneCalls].sort(([a], [c]) => a.localeCompare(c))).toEqual(sorted.map((id) => [id, PROBE_PANE_READ_LINES]))
}

/** A `stop` bundle whose server is already gone (stale PID file → exit 0). */
function makeStopDeps(o: Overrides = {}): Bundle {
  return makeDeps({ serverPid: 4242, isProcessRunning: () => false, ...o })
}

/**
 * A `stop` bundle whose server is up at the liveness check and gone by the
 * first poll: a stop that goes ahead sends SIGTERM, so "no server signal"
 * shows that nothing was stopped.
 */
function makeLiveStopDeps(o: Overrides = {}): Bundle {
  let alive = true
  return makeDeps({ serverPid: 4242, isProcessRunning: () => { const was = alive; alive = false; return was }, ...o })
}

// ---------------------------------------------------------------------------
// The teardown's report and its three destinations (b.jg5 SRJ-907, SRJ-909,
// SRJ-1013)
// ---------------------------------------------------------------------------

/** `<stateDir>/startup-errors.log`, where the fixture's recorder writes. */
const startupErrorsPath = (): string => join(stateDir, 'startup-errors.log')

/**
 * The texts of `server.log`'s lines, in order, each after its `[<ISO time>] `
 * stamp, which must be `at`'s (the fake clock's time of the report); none
 * when the file was never written.
 */
function serverLogTexts(at: number): string[] {
  if (!existsSync(logPath)) return []
  const stamp = `[${new Date(at).toISOString()}] `
  return readFileSync(logPath, 'utf-8').split('\n').filter((l) => l !== '').map((line) => {
    expect(line.startsWith(stamp)).toBe(true)
    return line.slice(stamp.length)
  })
}

/** One `startup-errors.log` entry: its class and its message. */
interface StartupErrorEntry {
  readonly classLabel: string
  readonly message: string
}

/** `startup-errors.log`'s entries, in order, as class and message; none when the file was never written. */
function startupErrorEntries(): StartupErrorEntry[] {
  if (!existsSync(startupErrorsPath())) return []
  return readFileSync(startupErrorsPath(), 'utf-8').split('\n').filter((l) => l !== '').map((line) => {
    const m = /^\[[^\]]+\] \[([^\]]+)\] (.*)$/.exec(line)
    if (m === null) throw new Error(`not a startup-errors entry: ${line}`)
    return { classLabel: m[1]!, message: m[2]! }
  })
}

/** The teardown's two log files that exist, for `assertNoLeak`. */
const writtenTeardownLogs = (): unknown[] => [logPath, startupErrorsPath()].filter((p) => existsSync(p)).map((p) => writtenFile(p))

/** {@link snapshotTree} without the teardown's `server.log` and `startup-errors.log`, whose content each case checks itself. */
function snapshotTreeExceptTeardownLogs(): Record<string, string | null> {
  const logs = new Set([relative(root, logPath), relative(root, startupErrorsPath())])
  return Object.fromEntries(Object.entries(snapshotTree()).filter(([rel]) => !logs.has(rel)))
}

/** A persona as the teardown's lines name it. */
const personaOf = (name: string): CliTeardownPersona => ({ name, key: personaKey(name) })
/** {@link ALPHA} and {@link BETA} as the teardown's lines name them. */
const ALPHA_PERSONA = personaOf(ALPHA.name)
const BETA_PERSONA = personaOf(BETA.name)

/** What one persona's teardown reports (b.jg5 SRJ-907, SRJ-909): its lines in order and its startup-errors entry. */
interface ExpectedReport {
  /** Printed (for `clean_restart` through its fatal path) and appended to `server.log`, one line each. */
  readonly lines: readonly string[]
  /** The one `startup-errors.log` entry. */
  readonly entry: StartupErrorEntry
  /** Whether the persona counts in the last line. */
  readonly failed: boolean
}

/**
 * A failed persona's report: `teardownFailureLine` over the classifier's
 * class (`errorClass`, checked) and `describeReportedAdFailure`'s redacted
 * description of `error` (SRJ-104; a CONFIG one led by the config file's
 * name), naming the persona's session. With `quotes` it is followed by the
 * ordinary version quoting them, ending with the ordinary CLI closing
 * sentence, both recorded as one `persona-kill-failed` entry; without, the
 * line alone is recorded under `cli-teardown-failed`.
 */
function failedReport(
  command: CliTeardownCommand,
  persona: CliTeardownPersona,
  error: unknown,
  errorClass: AdErrorClass,
  quotes?: KillFailureOrdinaryQuotes,
): ExpectedReport {
  const report = teardownErrorReportOf(error)
  expect(report.errorClass).toBe(errorClass)
  const reported = describeReportedAdFailure(error)
  if (errorClass === AD_ERROR_CLASS_CONFIG) {
    expect(report.description).toContain(AD_CONFIG_FILE_DISPLAY_NAME)
    expect(report.description.endsWith(reported)).toBe(true)
  } else {
    expect(report.description).toBe(reported)
  }
  const line = teardownFailureLine(command, persona, report)
  expect(line).toContain(JSON.stringify(personaTmuxSessionName(persona.key)))
  if (quotes === undefined) return { lines: [line], entry: { classLabel: CLI_TEARDOWN_FAILED_LABEL, message: line }, failed: true }
  const alert = cliAlertLine(command, persona, {
    version: KILL_FAILURE_VERSION_ORDINARY,
    session: personaTmuxSessionName(persona.key),
    instanceId: personaInstanceId(persona.key),
    quotes,
  })
  expect(alert.endsWith(KILL_FAILURE_ORDINARY_CLI_TEARDOWN_CLOSING)).toBe(true)
  return { lines: [line, alert], entry: { classLabel: PERSONA_KILL_FAILED_LABEL, message: `${line} ${alert}` }, failed: true }
}

/**
 * A persona stopped after a survivor-naming kill failure: no failure line;
 * the survivor version quoting `survivorDescription` and naming the stub's
 * survivor pids, ending with the survivor CLI closing sentence, recorded under
 * `persona-kill-survivor`; not counted.
 */
function survivorReport(command: CliTeardownCommand, persona: CliTeardownPersona, survivorDescription: string): ExpectedReport {
  const alert = cliAlertLine(command, persona, {
    version: KILL_FAILURE_VERSION_SURVIVOR,
    session: personaTmuxSessionName(persona.key),
    survivorDescription,
  })
  expect(alert.endsWith(KILL_FAILURE_SURVIVOR_CLI_TEARDOWN_CLOSING)).toBe(true)
  for (const pid of STUB_SURVIVOR_PIDS) expect(alert).toContain(String(pid))
  return { lines: [alert], entry: { classLabel: PERSONA_KILL_SURVIVOR_LABEL, message: alert }, failed: false }
}

/** Which of the report's files a case expects written; a seam made to fail leaves its file unwritten. */
interface ReportDestinations {
  readonly serverLog?: boolean
  readonly startupErrors?: boolean
}

/**
 * The teardown's report under `command` is exactly `reports`, in
 * configuration order (b.jg5 SRJ-907, SRJ-909): its lines on the terminal
 * once each, in order, and when any persona failed the last line, counting
 * only the failed ones, as the last line of all; one `server.log` line per
 * report line, stamped with the fake clock's time, and one
 * `startup-errors.log` entry per persona that has one; the last line neither
 * logged nor recorded. Nothing printed, logged or recorded leaks.
 */
function expectReported(b: Bundle, command: CliTeardownCommand, reports: readonly ExpectedReport[], to: ReportDestinations = {}): void {
  const lines = reports.flatMap((r) => r.lines)
  const failed = reports.filter((r) => r.failed).length
  const last = failed > 0 ? [teardownNotStoppedLine(command, failed)] : []
  expect(stderr.filter((l) => l.startsWith(`${command}: `) || lines.includes(l))).toEqual([...lines, ...last])
  if (failed > 0) expect(stderr.at(-1)).toBe(last[0])
  expect(serverLogTexts(b.clock.now())).toEqual(to.serverLog === false ? [] : lines)
  expect(startupErrorEntries()).toEqual(to.startupErrors === false ? [] : reports.map((r) => r.entry))
  assertNoLeak({ stderr, consoleErrorArgs: errorSpy.mock.calls, files: writtenTeardownLogs() })
}

/** A scripted answer that is thrown rather than returned; see {@link scripted}. */
interface Thrown {
  readonly thrown: unknown
}
const thrown = (error: unknown): Thrown => ({ thrown: error })
const isThrown = (answer: unknown): answer is Thrown => typeof answer === 'object' && answer !== null && 'thrown' in answer

/**
 * One director verb's answers in call order: each call takes the next
 * answer, the last one repeating; a {@link thrown} answer is thrown. For a
 * fixture override such as `directorStatus` or `directorPause`.
 */
function scripted<T>(...answers: ReadonlyArray<T | Thrown>): () => Promise<T> {
  let next = 0
  return async () => {
    const answer = answers[Math.min(next++, answers.length - 1)]
    if (isThrown(answer)) throw answer.thrown
    return answer as T
  }
}

/** The fake-clock times of each `<verb>` call of `id`, in call order. */
const callTimesOf = (b: Bundle, verb: string, id: string = opsId()): number[] =>
  b.directorCallTimes.filter(([call]) => call === `${verb}:${id}`).map(([, at]) => at)

// ---------------------------------------------------------------------------
// start — pre-flight (AC 47, b.av2 SR-8.7, SR-10.2)
// ---------------------------------------------------------------------------

describe('start — pre-flight', () => {
  test.each([
    ['unset', undefined],
    ['set to placeholders', 'placeholder-not-a-credential'],
  ])('AC 47: start passes pre-flight with the token variables %s (they are never read)', async (_label, value) => {
    for (const name of TOKEN_VARS) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
    const b = makeDeps()

    await expect(createCli(b.deps).start()).rejects.toBeInstanceOf(ExitError)

    // Reached the daemonize path and reported a started daemon: no exit(1).
    expect(b.daemonSpawns).toHaveLength(1)
    expect(b.exitCodes).toEqual([0])
    expect(stderr.join('\n')).not.toContain('missing prerequisite')
  })

  test('AC 47: the code of src/cli.ts names neither SLACK_BOT_TOKEN nor SLACK_APP_TOKEN (static)', () => {
    const code = stripComments(readFileSync(CLI_SOURCE, 'utf-8'))
    expect(code).not.toContain('SLACK_BOT_TOKEN')
    expect(code).not.toContain('SLACK_APP_TOKEN')
  })

  test.each([
    ['config.json only', false],
    ['config.json.last-applied only (no config.json)', true],
  ])('%s: start passes pre-flight and spawns the daemon', async (_label, recordOnly) => {
    if (recordOnly) {
      writeFileSync(recordPath(), readFileSync(configPath))
      rmSync(configPath)
    }
    const b = makeDeps()

    await expect(createCli(b.deps).start()).rejects.toBeInstanceOf(ExitError)

    expect(b.daemonSpawns).toHaveLength(1)
    expect(b.exitCodes).toEqual([0])
    expect(stderr.join('\n')).not.toContain('missing prerequisite')
    assertNoLeak({ stderr }, 'start pre-flight')
  })

  test('neither config.json nor config.json.last-applied: exit 1, one line naming both paths, nothing spawned', async () => {
    rmSync(configPath)
    const b = makeDeps()

    await expect(createCli(b.deps).start()).rejects.toBeInstanceOf(ExitError)

    expect(b.exitCodes).toEqual([1])
    expect(stderr).toEqual([
      `missing prerequisite: config.json not found at ${configPath}, and no config.json.last-applied at ${recordPath()}`,
    ])
    expect(b.daemonSpawns).toEqual([])
  })

  test('does NOT probe tmux on PATH (Epic 2: SR-5.1 owns runtime checks)', async () => {
    const b = makeDeps()
    await expect(createCli(b.deps).start()).rejects.toBeInstanceOf(ExitError)
    expect(b.spawnCalls.filter((c) => c.cmd === 'tmux')).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// The CLI reads the configuration file the server loads (b.av2 SR-8.7)
// ---------------------------------------------------------------------------

describe('shared config path (SR-8.7)', () => {
  /** A pre-persona key E1's loader rejects with its conversion message (b.av2 SR-1.7). */
  const PRE_PERSONA_KEY = 'default_route'
  const writePrePersonaFile = (): void => {
    writeConfigFile(stateDir, { [PRE_PERSONA_KEY]: { cwd: join(root, 'work') } })
  }

  test('production deps resolve the state dir, config path and loader with the server functions (static)', () => {
    const code = stripComments(readFileSync(CLI_SOURCE, 'utf-8'))
    const props = objectProperties(code.slice(code.indexOf('const realDeps: CliDeps =')))
    expect(props.get('resolveStateDir')).toBe('() => resolveServerStateDir()')
    expect(props.get('resolveConfigPath')).toBe('() => resolveServerConfigPath()')
    expect(props.get('loadConfig')).toBe('(path) => readAppliedPersonaConfig(path)')
    expect(code).toMatch(/import\s*\{[^}]*\breadAppliedPersonaConfig\b[^}]*\}\s*from\s*'\.\/reload\.ts'/)
  })

  test('clean_restart loads exactly <stateDir>/config.json', async () => {
    const b = makeDeps()
    await createCli(b.deps).clean_restart()
    expect(b.loadPaths).toEqual([configPath])
  })

  test('stop (live server) loads exactly <stateDir>/config.json', async () => {
    let alive = true
    const b = makeDeps({ serverPid: 4242, isProcessRunning: () => { const was = alive; alive = false; return was } })
    await expect(createCli(b.deps).stop()).rejects.toBeInstanceOf(ExitError)
    expect(b.loadPaths).toEqual([configPath])
    expect(b.exitCodes).toEqual([0])
  })

  test('stop --stop-bots (live server) loads <stateDir>/config.json for the precheck and teardown, and again for the stop', async () => {
    const b = makeLiveStopDeps()
    await expect(createCli(b.deps).stop({ stopBots: true })).rejects.toBeInstanceOf(ExitError)
    expect(b.loadPaths).toEqual([configPath, configPath])
    expect(b.getCalls).toEqual([opsId()])
    expect(b.statusCalls).toEqual([opsId()])
  })

  test('stop honours the config\'s stop_timeout: 0 sends SIGKILL right after SIGTERM to a server that stays up', async () => {
    // With the 30 s default the SIGTERM wait would outlast the test's timeout.
    const b: Bundle = makeDeps({
      serverPid: 4242,
      config: opsConfig({ stop_timeout: 0 }),
      isProcessRunning: () => !b.serverSignals.includes('SIGKILL'),
    })
    await expect(createCli(b.deps).stop()).rejects.toBeInstanceOf(ExitError)
    expect(b.serverSignals).toEqual(['SIGTERM', 'SIGKILL'])
    expect(b.exitCodes).toEqual([0])
  })

  test('clean_restart over a real two-persona file through the production resolver (no record) tears down exactly cscb_<key> of each persona', async () => {
    writeConfigFile(stateDir, makePersonaConfigInput({ personas: [makePersona(ALPHA, root), makePersona(BETA, root)] }, root))
    const b = makeDeps({ loadConfig: appliedLoader })

    await createCli(b.deps).clean_restart()

    const ids = [personaInstanceId(personaKey(ALPHA.name)), personaInstanceId(personaKey(BETA.name))]
    expectOnePrecheckEach(b, ids)
    expect(new Set(b.statusCalls)).toEqual(new Set(ids))
    expect(b.statusCalls).toHaveLength(2)
    expect(startedServer(b)).toBe(true)
  })

  test('clean_restart given a pre-persona file (production resolver, no record) exits 1 with the conversion message, no director call, never starts', async () => {
    writePrePersonaFile()
    const b = makeDeps({ loadConfig: appliedLoader })

    await expect(createCli(b.deps).clean_restart()).rejects.toBeInstanceOf(ExitError)

    expect(b.exitCodes).toEqual([1])
    expect(stderr.join('\n')).toContain(prePersonaConversionMessage(PRE_PERSONA_KEY))
    expect(b.directorCallTimes).toEqual([]) // no precheck call and no teardown call
    expect(b.spawnCalls).toEqual([]) // neither stop nor start ran
  })

  test('stop --stop-bots given a pre-persona file (production resolver, no record) logs, skips teardown and still stops the server', async () => {
    writePrePersonaFile()
    let alive = true
    const b = makeDeps({
      serverPid: 4242,
      isProcessRunning: () => { const was = alive; alive = false; return was },
      loadConfig: appliedLoader,
    })

    await expect(createCli(b.deps).stop({ stopBots: true })).rejects.toBeInstanceOf(ExitError)

    expect(b.serverSignals).toEqual(['SIGTERM'])
    expect(b.exitCodes).toEqual([0])
    // b.jg5 SRJ-901: no per-persona step (no get or read-pane), and the teardown skipped.
    expect(b.directorCallTimes).toEqual([])
    expect(stderr.join('\n')).toContain('could not load config — skipping bot teardown')
  })
})

// ---------------------------------------------------------------------------
// stop — the SIGTERM and SIGKILL waits run on the injected clock
// ---------------------------------------------------------------------------

describe('stop — waits on the injected clock', () => {
  /** Record the fake-clock time of every server signal and the length of every sleep. */
  function timed(b: Bundle): { signalAt: Array<[string, number]>; sleeps: number[] } {
    const signalAt: Array<[string, number]> = []
    const sleeps: number[] = []
    const { kill, sleep } = b.deps
    b.deps.kill = (pid, signal) => {
      signalAt.push([String(signal), b.clock.now()])
      kill(pid, signal)
    }
    b.deps.sleep = (ms) => {
      sleeps.push(ms)
      return sleep(ms)
    }
    return { signalAt, sleeps }
  }

  // A 5 s stop_timeout here would outlast the test's own 5 s timeout if the
  // waits were real.
  test('a server that ignores SIGTERM gets SIGKILL once stop_timeout has passed on the fake clock, then exits 0 at the next poll after it dies', async () => {
    const b: Bundle = makeDeps({
      serverPid: 4242,
      config: opsConfig({ stop_timeout: 5 }),
      isProcessRunning: () => !b.serverSignals.includes('SIGKILL'),
    })
    const t = timed(b)

    await expect(createCli(b.deps).stop()).rejects.toBeInstanceOf(ExitError)

    expect(t.signalAt.map(([s]) => s)).toEqual(['SIGTERM', 'SIGKILL'])
    expect(t.signalAt[0]![1]).toBe(0)
    expect(t.signalAt[1]![1]).toBeGreaterThanOrEqual(5_000)
    expect(t.signalAt[1]![1]).toBeLessThan(5_000 + STOP_POLL_MS)
    expect(b.exitCodes).toEqual([0])
    expect(b.exitTimes[0]).toBe(t.signalAt[1]![1] + STOP_POLL_MS)
    expect(new Set(t.sleeps)).toEqual(new Set([STOP_POLL_MS]))
    expect(stderr).toContain('[slack] Warning: server did not stop within 5s after SIGTERM — sending SIGKILL.')
    expect(stderr).toContain('[slack] Server killed.')
  })

  test(`a server that survives SIGKILL: exit 1 once STOP_KILL_WAIT_MS (${STOP_KILL_WAIT_MS} ms) has passed on the fake clock`, async () => {
    const b = makeDeps({ serverPid: 4242, config: opsConfig({ stop_timeout: 5 }), isProcessRunning: () => true })
    const t = timed(b)

    await expect(createCli(b.deps).stop()).rejects.toBeInstanceOf(ExitError)

    expect(t.signalAt.map(([s]) => s)).toEqual(['SIGTERM', 'SIGKILL'])
    const killAt = t.signalAt[1]![1]
    expect(b.exitCodes).toEqual([1])
    expect(b.exitTimes[0]).toBeGreaterThanOrEqual(killAt + STOP_KILL_WAIT_MS)
    expect(b.exitTimes[0]).toBeLessThan(killAt + STOP_KILL_WAIT_MS + STOP_POLL_MS)
    expect(new Set(t.sleeps)).toEqual(new Set([STOP_POLL_MS]))
    expect(stderr).toContain('[slack] Warning: server did not die after SIGKILL.')
  })

  test('a server that exits after SIGTERM is seen at the first poll, STOP_POLL_MS after it', async () => {
    let alive = true
    const b = makeDeps({ serverPid: 4242, config: opsConfig({ stop_timeout: 5 }), isProcessRunning: () => { const was = alive; alive = false; return was } })
    const t = timed(b)

    await expect(createCli(b.deps).stop()).rejects.toBeInstanceOf(ExitError)

    expect(t.signalAt).toEqual([['SIGTERM', 0]])
    expect(b.exitCodes).toEqual([0])
    expect(b.exitTimes).toEqual([STOP_POLL_MS])
    expect(stderr).toContain('[slack] Server stopped.')
  })
})

// ---------------------------------------------------------------------------
// stop — server.port goes with the PID file (b.jg5 SRJ-510): removed when the
// PID is stale and after the server stops or is killed, and on no other path.
// ---------------------------------------------------------------------------

describe('stop — server.port is removed with the PID file', () => {
  /** A `stop` bundle (stop_timeout 5) whose server's liveness reads `alive` over the signals sent so far. */
  function stopWith(alive: (signals: readonly string[]) => boolean): Bundle {
    const b: Bundle = makeDeps({ serverPid: 4242, config: opsConfig({ stop_timeout: 5 }), isProcessRunning: () => alive(b.serverSignals) })
    return b
  }

  /** The PID file and the record beside it, in either order, each once. */
  const bothFiles = (): string[] => [pidPath, serverPortFilePath(stateDir)].sort()

  test.each([
    ['the PID is stale', () => false, [], 'server is not running (removed stale PID file)'],
    ['the server exits after SIGTERM', (s: readonly string[]) => s.length === 0, ['SIGTERM'], '[slack] Server stopped.'],
    ['the server dies only after SIGKILL', (s: readonly string[]) => !s.includes('SIGKILL'), ['SIGTERM', 'SIGKILL'], '[slack] Server killed.'],
  ] as const)('%s: the PID file and server.port are removed, exit 0', async (label, alive, signals, line) => {
    const b = stopWith(alive)

    await expect(createCli(b.deps).stop()).rejects.toBeInstanceOf(ExitError)

    expect([...b.unlinked].sort()).toEqual(bothFiles())
    expect(b.serverSignals).toEqual([...signals])
    expect(b.exitCodes).toEqual([0])
    expect(stderr).toContain(line)
    assertNoLeak({ stderr, exitCodes: b.exitCodes }, `stop (${label})`)
  })

  test.each([
    ['there is no PID file', () => makeDeps(), 0, 'server is not running'],
    ['the PID file is unreadable', () => { writeFileSync(pidPath, 'not-a-pid\n'); return makeDeps() }, 1, '[slack] Could not read PID file: Error: invalid PID: not-a-pid'],
    ['the server survives SIGKILL', () => stopWith(() => true), 1, '[slack] Warning: server did not die after SIGKILL.'],
  ] as const)('%s: nothing is removed, exit %d', async (label, build, code, line) => {
    const b = build()

    await expect(createCli(b.deps).stop()).rejects.toBeInstanceOf(ExitError)

    expect(b.unlinked).toEqual([])
    expect(b.exitCodes).toEqual([code])
    expect(stderr).toContain(line)
    assertNoLeak({ stderr, exitCodes: b.exitCodes }, `stop (${label})`)
  })

  test('stop --stop-bots over a stale PID removes the PID file and server.port, and tears the persona down as before', async () => {
    const b = makeStopDeps({ directorStatus: async () => ({ state: 'ended' }) })

    await expect(createCli(b.deps).stop({ stopBots: true })).rejects.toBeInstanceOf(ExitError)

    expect([...b.unlinked].sort()).toEqual(bothFiles())
    expectOnePrecheckEach(b, [opsId()])
    expect(b.statusCalls).toEqual([opsId()])
    expect(b.exitCodes).toEqual([0])
    assertNoLeak({ stderr, exitCodes: b.exitCodes }, 'stop --stop-bots (stale PID)')
  })
})

// ---------------------------------------------------------------------------
// The last-applied record (b.av2 SR-8.7): settings and persona set come from
// config.json.last-applied when it exists, from config.json when it does not.
// Every case goes through the production resolver over real files in the
// per-test tree.
// ---------------------------------------------------------------------------

describe('last-applied record (SR-8.7)', () => {
  /** Only in the edited config.json: a record-sourced teardown never addresses it. */
  const GAMMA = { name: 'Gamma Bot', channels: [{ id: 'C0GAMMA01', delivery: 'all' as const }], permission_prompts: 'C0GAMMA01' }
  const alphaId = (): string => personaInstanceId(personaKey(ALPHA.name))
  const betaId = (): string => personaInstanceId(personaKey(BETA.name))
  const gammaId = (): string => personaInstanceId(personaKey(GAMMA.name))

  /**
   * The call timeouts of APPLIED and EDITED (b.jg5 SRJ-213): the setting's
   * two bounds, so each differs from the other and from the default.
   */
  const APPLIED_CALL_TIMEOUT_MS = MIN_AGENT_DIRECTOR_CALL_TIMEOUT_MS
  const EDITED_CALL_TIMEOUT_MS = MAX_AGENT_DIRECTOR_CALL_TIMEOUT_MS

  /**
   * The applied configuration: Alpha and Beta with the short timeouts. With
   * stop_timeout 0 a live server gets SIGKILL straight after SIGTERM; with
   * exit_timeout 0 a paused persona is killed at once. Reading the longer
   * values of EDITED instead shows up as no SIGKILL and no kill.
   */
  const APPLIED = (): PersonaConfigInput =>
    makePersonaConfigInput({
      personas: [makePersona(ALPHA, root), makePersona(BETA, root)],
      stop_timeout: 0,
      exit_timeout: 0,
      agent_director_call_timeout_ms: APPLIED_CALL_TIMEOUT_MS,
    }, root)
  /** The operator's edit, not yet applied: Beta removed, Gamma added, longer timeouts. */
  const EDITED = (): PersonaConfigInput =>
    makePersonaConfigInput({
      personas: [makePersona(ALPHA, root), makePersona(GAMMA, root)],
      stop_timeout: 5,
      exit_timeout: 5,
      agent_director_call_timeout_ms: EDITED_CALL_TIMEOUT_MS,
    }, root)

  /**
   * `record`: config.json.last-applied holds APPLIED and config.json holds
   * EDITED. `config`: no record, config.json holds APPLIED. Each persona's
   * credentials file holds fake tokens, so a CLI that read one and printed it
   * fails `assertNoLeak`.
   */
  function writeSource(source: 'record' | 'config'): void {
    for (const p of [ALPHA, BETA, GAMMA]) writeCredentialsFile(join(root, 'personas', personaKey(p.name)))
    if (source === 'record') {
      writeFileSync(recordPath(), JSON.stringify(APPLIED(), null, 2))
      writeConfigFile(stateDir, EDITED())
    } else {
      writeConfigFile(stateDir, APPLIED())
    }
  }

  /**
   * A server that is up at `stop`'s liveness check and gone by the first poll,
   * STOP_POLL_MS of fake-clock time after SIGTERM: stop_timeout 0 still sends
   * SIGKILL (no poll before the deadline), any longer stop_timeout does not.
   */
  function goneAfterFirstCheck(): () => boolean {
    let calls = 0
    return () => ++calls === 1
  }

  /** Each instance's first status is `waiting` (so it is paused), every later one `ended`. */
  function waitingThenEnded(): (id: string) => Promise<{ state: string }> {
    const seen = new Set<string>()
    return async (id) => {
      const first = !seen.has(id)
      seen.add(id)
      return { state: first ? 'waiting' : 'ended' }
    }
  }

  const runStopBots = (b: Bundle): Promise<void> =>
    createCli(b.deps).stop({ stopBots: true }).catch((e) => { if (!(e instanceof ExitError)) throw e })
  const runCleanRestart = (b: Bundle): Promise<void> => createCli(b.deps).clean_restart()

  const SOURCES = [
    ['record present: the record', 'record'],
    ['no record: config.json', 'config'],
  ] as const

  test.each(SOURCES)('stop: stop_timeout comes from %s (0 → SIGKILL right after SIGTERM)', async (_label, source) => {
    writeSource(source)
    const b = makeDeps({ serverPid: 4242, isProcessRunning: goneAfterFirstCheck(), loadConfig: appliedLoader })

    await expect(createCli(b.deps).stop()).rejects.toBeInstanceOf(ExitError)

    expect(b.serverSignals).toEqual(['SIGTERM', 'SIGKILL'])
    expect(b.exitCodes).toEqual([0])
    assertNoLeak({ stderr, exitCodes: b.exitCodes }, `stop (${source})`)
  })

  // b.jg5 SRJ-213: the CLI's client carries the call timeout of the
  // configuration the server runs, read before the client is built; with a
  // record present, the record's, never the edited config.json's.
  test.each([
    ...SOURCES.map(([label, source]) => ['clean_restart', label, source, runCleanRestart] as const),
    ...SOURCES.map(([label, source]) => ['stop --stop-bots', label, source, runStopBots] as const),
  ])('%s: persona set, exit_timeout and the client\'s agent_director_call_timeout_ms come from %s — exactly cscb_<key> of Alpha and Beta, each prechecked, then paused and killed at once, never Gamma; initClient gets the call timeout once, after the configuration is read and before the precheck, clean_restart asking for the whole gate and stop --stop-bots for the gate without CSCB\'s floor', async (name, _label, source, run) => {
    // Precondition: the three values differ, so any wrong source shows.
    expect(new Set([APPLIED_CALL_TIMEOUT_MS, EDITED_CALL_TIMEOUT_MS, DEFAULT_AGENT_DIRECTOR_CALL_TIMEOUT_MS]).size).toBe(3)
    writeSource(source)
    const b = makeDeps({
      serverPid: 4242,
      isProcessRunning: goneAfterFirstCheck(),
      loadConfig: appliedLoader,
      directorStatus: waitingThenEnded(),
      initClient: async () => { /* gate ok */ },
    })

    await run(b)

    const ids = [alphaId(), betaId()].sort()
    // b.jg5 SRJ-901: one get and one one-line read-pane of each persona of the configuration the server runs.
    expectOnePrecheckEach(b, ids)
    // exit_timeout 0: no status poll after the pause, straight to kill.
    expect([...b.statusCalls].sort()).toEqual(ids)
    expect([...b.pauseCalls].sort()).toEqual(ids)
    expect([...b.killCalls].sort()).toEqual(ids)
    expect(b.directorCallTimes.map(([call]) => call).filter((call) => call.endsWith(gammaId()))).toEqual([])
    if (name === 'stop --stop-bots') {
      expect(b.serverSignals).toEqual(['SIGTERM', 'SIGKILL'])
      expect(b.exitCodes).toEqual([0])
    } else {
      expect(b.exitCodes).toEqual([])
      expect(startedServer(b)).toBe(true)
    }
    expect(b.initClientCalls).toEqual([APPLIED_CALL_TIMEOUT_MS])
    // b.jg5 SRJ-203: only stop --stop-bots leaves the floor out.
    expect(b.initClientGates).toEqual([name === 'stop --stop-bots' ? FLOOR_EXEMPT_GATE : undefined])
    // The configuration read that sizes the client comes before it is built,
    // and the client is built before the precheck's first call.
    const initAt = b.events.indexOf('initClient')
    expect(b.events.slice(0, initAt)).toContain('loadConfig')
    expect(initAt).toBeLessThan(b.events.indexOf(`${PRECHECK_CALL_GET}:${alphaId()}`))
    expect(initAt).toBeLessThan(b.events.indexOf(`${PRECHECK_CALL_GET}:${betaId()}`))
    // After it, only `stop`'s own stop_timeout read, once the precheck has passed.
    const lastPrecheck = Math.max(...b.events.flatMap((e, i) => (e.startsWith(`${PRECHECK_CALL_READ_PANE}:`) ? [i] : [])))
    const laterLoads = b.events.flatMap((e, i) => (e === 'loadConfig' && i > initAt ? [i] : []))
    if (name === 'stop --stop-bots') {
      expect(laterLoads).toHaveLength(1)
      expect(laterLoads[0]).toBeGreaterThan(lastPrecheck)
      expect(laterLoads[0]).toBeLessThan(b.events.indexOf('server:SIGTERM'))
    } else {
      expect(laterLoads).toEqual([])
    }
    assertNoLeak({ stderr, exitCodes: b.exitCodes }, `${name} (${source})`)
  })

  // b.jg5 SRJ-119, SRJ-213: pause waits up to the host's [pause] timeout, so
  // the client carries CSCB's configured call timeout, sized above that wait;
  // with the key omitted, the default (config.test.ts pins its value).
  /** A configured call timeout strictly between the setting's bounds, and not the default. */
  const MID_CALL_TIMEOUT_MS = Math.round((MIN_AGENT_DIRECTOR_CALL_TIMEOUT_MS + MAX_AGENT_DIRECTOR_CALL_TIMEOUT_MS) / 2)

  test.each([
    ...[['clean_restart', runCleanRestart], ['stop --stop-bots', runStopBots]].flatMap(([name, run]) => [
      [name, 'a configured agent_director_call_timeout_ms between the minimum and the maximum', MID_CALL_TIMEOUT_MS, run],
      [name, 'agent_director_call_timeout_ms omitted', undefined, run],
    ] as const),
  ] as ReadonlyArray<readonly [string, string, number | undefined, (b: Bundle) => Promise<void>]>)('%s with %s: initClient gets that call timeout, or the default, once; the teardown still pauses the persona', async (name, _label, configured, run) => {
    expect(MID_CALL_TIMEOUT_MS).toBeGreaterThan(MIN_AGENT_DIRECTOR_CALL_TIMEOUT_MS)
    expect(MID_CALL_TIMEOUT_MS).toBeLessThan(MAX_AGENT_DIRECTOR_CALL_TIMEOUT_MS)
    expect(MID_CALL_TIMEOUT_MS).not.toBe(DEFAULT_AGENT_DIRECTOR_CALL_TIMEOUT_MS)
    writeCredentialsFile(join(root, 'personas', personaKey(ALPHA.name)))
    writeConfigFile(stateDir, makePersonaConfigInput({
      personas: [makePersona(ALPHA, root)],
      exit_timeout: 0,
      ...(configured === undefined ? {} : { agent_director_call_timeout_ms: configured }),
    }, root))
    const b = makeDeps({
      serverPid: 4242,
      isProcessRunning: goneAfterFirstCheck(),
      loadConfig: appliedLoader,
      directorStatus: waitingThenEnded(),
      initClient: async () => { /* gate ok */ },
    })

    await run(b)

    expect(b.initClientCalls).toEqual([configured ?? DEFAULT_AGENT_DIRECTOR_CALL_TIMEOUT_MS])
    expect(b.pauseCalls).toEqual([alphaId()])
    expect(b.exitCodes).not.toContain(1)
    assertNoLeak({ stderr, exitCodes: b.exitCodes }, `${name} (call timeout)`)
  })

  const runStop = (b: Bundle): Promise<void> =>
    createCli(b.deps).stop().catch((e) => { if (!(e instanceof ExitError)) throw e })

  test.each([
    ...SOURCES.map(([label, source]) => ['clean_restart', label, source, runCleanRestart] as const),
    ...SOURCES.map(([label, source]) => ['stop --stop-bots', label, source, runStopBots] as const),
    ...SOURCES.map(([label, source]) => ['stop', label, source, runStop] as const),
  ])('%s never writes a reload file (%s): every file is byte-for-byte unchanged and none is added or removed', async (name, _label, source, run) => {
    writeSource(source)
    const b = makeDeps({
      serverPid: 4242,
      isProcessRunning: goneAfterFirstCheck(),
      loadConfig: appliedLoader,
      directorStatus: waitingThenEnded(),
    })
    const before = snapshotTree() // after makeDeps, so the PID file is in it

    await run(b)

    // Precondition: the run read the intended source, prechecked and tore down
    // its set; plain `stop` makes no director call.
    if (name !== 'stop') {
      expectOnePrecheckEach(b, [alphaId(), betaId()])
      expect([...b.killCalls].sort()).toEqual([alphaId(), betaId()].sort())
    } else {
      expect(b.directorCallTimes).toEqual([])
    }
    expect(existsSync(recordPath())).toBe(source === 'record')
    expect(snapshotTree()).toEqual(before)
    assertNoLeak({ stderr, exitCodes: b.exitCodes }, `${name} (${source}, no writes)`)
  })

  test.each(SOURCES)('readAppliedPersonaConfig expands every ~ under the injected home: a "~/…" config path, and "~/…" persona paths in %s', (_label, source) => {
    const tildePaths = (name: string) => ({
      credentials_file: `~/personas/${personaKey(name)}/credentials.json`,
      working_directory: `~/personas/${personaKey(name)}/work`,
    })
    const applied = makePersonaConfigInput(
      {
        personas: [makePersona({ ...ALPHA, ...tildePaths(ALPHA.name) }, root), makePersona({ ...BETA, ...tildePaths(BETA.name) }, root)],
        stop_timeout: 0,
        exit_timeout: 0,
      },
      root,
    )
    if (source === 'record') {
      writeFileSync(recordPath(), JSON.stringify(applied, null, 2))
      writeConfigFile(stateDir, EDITED())
    } else {
      writeConfigFile(stateDir, applied)
    }
    // Precondition: the injected home is not the process's own, so a `~`
    // expanded under the OS home finds no file (or other paths).
    expect(resolve(process.env['HOME'] ?? '')).not.toBe(resolve(root))

    const config = readAppliedPersonaConfig(`~/${relative(root, configPath)}`, root)

    expect(config.stop_timeout).toBe(0) // the applied file, not EDITED's 5
    expect(config.personas.map((p) => [p.key, p.credentials_file, p.working_directory])).toEqual(
      [ALPHA.name, BETA.name].map((n) => [
        personaKey(n),
        join(root, 'personas', personaKey(n), 'credentials.json'),
        join(root, 'personas', personaKey(n), 'work'),
      ]),
    )
  })

  test.each([
    ['clean_restart', runCleanRestart],
    ['stop --stop-bots', runStopBots],
  ] as const)('%s: a record whose two personas share a working directory by real path is still read (record mode); both instances are torn down', async (name, run) => {
    const work = join(root, 'shared-work')
    mkdirSync(work)
    const alias = join(root, 'shared-work-link')
    symlinkSync(work, alias)
    writeFileSync(
      recordPath(),
      JSON.stringify(
        makePersonaConfigInput(
          {
            personas: [makePersona({ ...ALPHA, working_directory: work }, root), makePersona({ ...BETA, working_directory: alias }, root)],
            stop_timeout: 0,
            exit_timeout: 0,
          },
          root,
        ),
      ),
    )
    const b = makeDeps({
      serverPid: 4242,
      isProcessRunning: goneAfterFirstCheck(),
      loadConfig: appliedLoader,
      directorStatus: waitingThenEnded(),
    })

    await run(b)

    const ids = [alphaId(), betaId()].sort()
    expectOnePrecheckEach(b, ids)
    expect([...b.pauseCalls].sort()).toEqual(ids)
    expect([...b.killCalls].sort()).toEqual(ids)
    expect(stderr.join('\n')).not.toContain('could not load config')
    expect(b.exitCodes).not.toContain(1)
    assertNoLeak({ stderr, exitCodes: b.exitCodes }, name)
  })

  /**
   * A record that is not JSON, holding a fake token, beside a valid
   * config.json (EDITED). The parse error must name the record, carry the
   * deletion hint and quote none of the record's content.
   */
  function writeMalformedRecord(): void {
    writeConfigFile(stateDir, EDITED())
    writeFileSync(recordPath(), `{"personas": [{"name": "${fakeToken(BOT_TOKEN_PREFIX, 'record')}"`)
  }
  const deletionHint = (): string => `Deleting the last-applied record "${recordPath()}"`
  /** `stop`'s one line for a stop_timeout read failure, before the loader's message. */
  const STOP_LOAD_FAILURE_PREFIX = '[slack] stop: could not load the applied configuration — using the default 30s stop_timeout: '

  test('clean_restart with a malformed record: exit 1 naming the record with the deletion hint, no client built, no teardown, no fallback to config.json, never starts', async () => {
    writeMalformedRecord()
    const b = makeDeps({ loadConfig: appliedLoader, directorStatus: waitingThenEnded(), initClient: async () => { /* gate ok */ } })

    await expect(createCli(b.deps).clean_restart()).rejects.toBeInstanceOf(ExitError)

    expect(b.exitCodes).toEqual([1])
    expect(stderr).toHaveLength(1)
    expect(stderr[0]!.startsWith('[slack] clean_restart: failed to load config:')).toBe(true)
    expect(stderr[0]).toContain(deletionHint())
    expect(b.initClientCalls).toEqual([]) // b.jg5 SRJ-213: fatal before any client is built
    expect(b.directorCallTimes).toEqual([]) // no get, read-pane, status, pause or kill
    expect(b.spawnCalls).toEqual([])
    assertNoLeak({ stderr, exitCodes: b.exitCodes }, 'clean_restart (malformed record)')
  })

  test('stop --stop-bots with a malformed record: logs the record with the deletion hint, builds its client with the default call timeout, skips teardown (no fallback to config.json), still stops the server', async () => {
    writeMalformedRecord()
    const b = makeDeps({
      serverPid: 4242,
      isProcessRunning: goneAfterFirstCheck(),
      loadConfig: appliedLoader,
      directorStatus: waitingThenEnded(),
      initClient: async () => { /* gate ok */ },
    })

    await expect(createCli(b.deps).stop({ stopBots: true })).rejects.toBeInstanceOf(ExitError)

    expect(b.exitCodes).toEqual([0])
    expect(b.serverSignals).toEqual(['SIGTERM'])
    const skip = stderr.filter((l) => l.startsWith('[slack] stop --stop-bots: could not load config — skipping bot teardown:'))
    expect(skip).toHaveLength(1)
    expect(skip[0]).toContain(deletionHint())
    // The server stop's own read failed too, and says so once, with the same hint.
    const stopLine = stderr.filter((l) => l.startsWith(STOP_LOAD_FAILURE_PREFIX))
    expect(stopLine).toHaveLength(1)
    expect(stopLine[0]).toContain(deletionHint())
    // b.jg5 SRJ-213: the default, never the edited config.json's value.
    expect(b.initClientCalls).toEqual([DEFAULT_AGENT_DIRECTOR_CALL_TIMEOUT_MS])
    expect(b.directorCallTimes).toEqual([]) // no get, read-pane, status, pause or kill
    assertNoLeak({ stderr, exitCodes: b.exitCodes }, 'stop --stop-bots (malformed record)')
  })

  // -------------------------------------------------------------------------
  // A record, or config.json without one, that is not a regular file: refused
  // unread (`readPersonaConfigBytes`), so no CLI command can hang on a FIFO or
  // a device. The file the loader would read is left a valid regular file for
  // the FIFO kind, so a loader that bypassed the seam would read it and pass.
  // -------------------------------------------------------------------------

  const NON_REGULAR_KINDS = [
    ['a FIFO (injected fstatFile: neither a file nor a directory)', 'fifo', CONFIG_NOT_REGULAR_FILE_CODE],
    ['a directory (real)', 'directory', 'EISDIR'],
  ] as const
  const NON_REGULAR_CASES = SOURCES.flatMap(([label, source]) =>
    NON_REGULAR_KINDS.map(([kindLabel, kind, code]) => [label, kindLabel, source, kind, code] as const),
  )
  /** Each case is bounded well below Bun's default, so a hang fails fast. */
  const NON_REGULAR_TIMEOUT_MS = 2_000

  interface NonRegularFile {
    loader: (path: string) => PersonaConfig
    /** The start's wording for the refused file (with the deletion hint for the record). */
    cause: string
    /** For the FIFO kind: the target was opened, nothing was read and every descriptor was closed. */
    assertUnreadAndClosed(): void
  }

  function makeNonRegular(source: 'record' | 'config', kind: 'fifo' | 'directory', code: string): NonRegularFile {
    writeSource(source)
    const target = source === 'record' ? recordPath() : configPath
    const cause =
      source === 'record'
        ? `The last-applied record "${recordPath()}" cannot be read (${code}). ${deletionHint()} makes the next start ` +
          `apply the configuration file "${configPath}" as it stands.`
        : `The configuration file "${configPath}" cannot be read (${code}). The server requires the configuration file to start.`
    if (kind === 'directory') {
      rmSync(target)
      mkdirSync(target)
      return { loader: appliedLoader, cause, assertUnreadAndClosed: () => {} }
    }
    const open = new Map<number, string>()
    const reads: string[] = []
    let targetOpens = 0
    const fs: Partial<PersonaConfigFs> = {
      openFile: (p) => {
        const fd = DEFAULT_PERSONA_CONFIG_FS.openFile(p)
        open.set(fd, p)
        if (p === target) targetOpens++
        return fd
      },
      fstatFile: (fd) =>
        open.get(fd) === target ? { isFile: () => false, isDirectory: () => false } : DEFAULT_PERSONA_CONFIG_FS.fstatFile(fd),
      readFileFd: (fd) => {
        reads.push(open.get(fd) ?? `fd ${fd}`)
        return DEFAULT_PERSONA_CONFIG_FS.readFileFd(fd)
      },
      closeFile: (fd) => {
        open.delete(fd)
        DEFAULT_PERSONA_CONFIG_FS.closeFile(fd)
      },
    }
    return {
      loader: (p) => readAppliedPersonaConfig(p, root, fs),
      cause,
      assertUnreadAndClosed: () => {
        expect(targetOpens).toBeGreaterThan(0)
        expect(reads).toEqual([]) // neither the target nor, for the record, config.json
        expect([...open.values()]).toEqual([])
      },
    }
  }

  test.each(NON_REGULAR_CASES)(
    'clean_restart (%s) where that file is %s: exit 1 at once with "cannot be read" wording, no teardown, no fallback, never starts',
    async (_label, _kindLabel, source, kind, code) => {
      const f = makeNonRegular(source, kind, code)
      const b = makeDeps({ loadConfig: f.loader, directorStatus: waitingThenEnded() })

      await expect(createCli(b.deps).clean_restart()).rejects.toBeInstanceOf(ExitError)

      expect(b.exitCodes).toEqual([1])
      expect(stderr).toHaveLength(1)
      expect(stderr[0]!.startsWith('[slack] clean_restart: failed to load config:')).toBe(true)
      expect(stderr[0]).toContain(f.cause)
      expect(b.directorCallTimes).toEqual([]) // no get, read-pane, status, pause or kill
      expect(b.spawnCalls).toEqual([])
      expect(b.clock.now()).toBe(0)
      f.assertUnreadAndClosed()
      assertNoLeak({ stderr, exitCodes: b.exitCodes }, `clean_restart (${source}, ${kind})`)
    },
    NON_REGULAR_TIMEOUT_MS,
  )

  test.each(NON_REGULAR_CASES)(
    'stop --stop-bots (%s) where that file is %s: the server still stops (30 s default, so no SIGKILL), the skip line carries the "cannot be read" wording, no teardown',
    async (_label, _kindLabel, source, kind, code) => {
      const f = makeNonRegular(source, kind, code)
      const b = makeDeps({
        serverPid: 4242,
        isProcessRunning: goneAfterFirstCheck(),
        loadConfig: f.loader,
        directorStatus: waitingThenEnded(),
      })

      await expect(createCli(b.deps).stop({ stopBots: true })).rejects.toBeInstanceOf(ExitError)

      expect(b.exitCodes).toEqual([0])
      // The applied file's stop_timeout 0 would have sent SIGKILL; it was not read.
      expect(b.serverSignals).toEqual(['SIGTERM'])
      const skip = stderr.filter((l) => l.startsWith('[slack] stop --stop-bots: could not load config — skipping bot teardown:'))
      expect(skip).toHaveLength(1)
      expect(skip[0]).toContain(f.cause)
      expect(stderr.filter((l) => l.startsWith(STOP_LOAD_FAILURE_PREFIX))).toEqual([`${STOP_LOAD_FAILURE_PREFIX}${f.cause}`])
      expect(b.directorCallTimes).toEqual([]) // no get, read-pane, status, pause or kill
      f.assertUnreadAndClosed()
      assertNoLeak({ stderr, exitCodes: b.exitCodes }, `stop --stop-bots (${source}, ${kind})`)
    },
    NON_REGULAR_TIMEOUT_MS,
  )

  // Plain `stop` reports the load failure in exactly one line, first, with the
  // loader's message (the record's deletion hint, or the config wording), then
  // falls back to the 30 s default stop_timeout and still stops the server.
  test.each(NON_REGULAR_CASES)(
    'stop (%s) where that file is %s: logs one "could not load" line with the "cannot be read" wording, then uses the 30 s default stop_timeout (fake clock) and still stops a server that ignores SIGTERM',
    async (_label, _kindLabel, source, kind, code) => {
      const f = makeNonRegular(source, kind, code)
      const b: Bundle = makeDeps({
        serverPid: 4242,
        isProcessRunning: () => !b.serverSignals.includes('SIGKILL'),
        loadConfig: f.loader,
      })

      await expect(createCli(b.deps).stop()).rejects.toBeInstanceOf(ExitError)

      expect(b.serverSignals).toEqual(['SIGTERM', 'SIGKILL'])
      expect(b.exitCodes).toEqual([0])
      expect(b.exitTimes).toEqual([30_000 + STOP_POLL_MS])
      expect(stderr).toEqual([
        `${STOP_LOAD_FAILURE_PREFIX}${f.cause}`,
        '[slack] Warning: server did not stop within 30s after SIGTERM — sending SIGKILL.',
        '[slack] Server killed.',
      ])
      f.assertUnreadAndClosed()
      assertNoLeak({ stderr, exitCodes: b.exitCodes }, `stop (${source}, ${kind})`)
    },
    NON_REGULAR_TIMEOUT_MS,
  )
})

// ---------------------------------------------------------------------------
// start — waiting for the daemon's startup outcome (b.av2 SR-1.7, SR-8.7)
// ---------------------------------------------------------------------------

describe('start — daemon startup wait', () => {
  /** stderr lines after the "Server failed to start" header. */
  function reportedLogLines(): string[] {
    const at = stderr.findIndex((l) => l.startsWith('[slack] Server failed to start'))
    return stderr.slice(at + 1)
  }

  test.each([
    [1, null, 'exit code 1'],
    [null, 'SIGKILL', 'killed by SIGKILL'],
  ] as const)('daemon exits during the wait (%p, %p): exit 1 with only the lines it appended to server.log', async (code, signal, reason) => {
    writeFileSync(logPath, '[slack] line from an earlier run\n')
    const fatal = `[slack] Fatal: configuration error — ${prePersonaConversionMessage('default_route')}`
    const b = makeDeps({
      daemon: ({ child, clock }) => clock.setTimeout(() => {
        appendFileSync(logPath, `\n${fatal}\n`)
        child.emit('exit', code, signal)
      }, 250),
    })

    await expect(createCli(b.deps).start()).rejects.toBeInstanceOf(ExitError)

    expect(b.exitCodes).toEqual([1])
    expect(stderr).toContain(`[slack] Server failed to start (${reason}). From ${logPath}:`)
    expect(reportedLogLines()).toEqual([fatal])
    expect(b.startServerCalled).toBe(false)
  })

  test(`repeats at most the last DAEMON_FAILURE_LOG_LINES (${DAEMON_FAILURE_LOG_LINES}) non-empty lines`, async () => {
    const lines = Array.from({ length: DAEMON_FAILURE_LOG_LINES + 5 }, (_, i) => `[slack] line ${i + 1}`)
    const b = makeDeps({
      daemon: ({ child, clock }) => clock.setTimeout(() => {
        appendFileSync(logPath, lines.join('\n\n') + '\n')
        child.emit('exit', 1, null)
      }, 100),
    })

    await expect(createCli(b.deps).start()).rejects.toBeInstanceOf(ExitError)

    expect(reportedLogLines()).toEqual(lines.slice(-DAEMON_FAILURE_LOG_LINES))
  })

  test('log rotated during the wait (now shorter than before): reported from its start', async () => {
    writeFileSync(logPath, '[slack] old line that is longer than the new log\n'.repeat(10))
    const b = makeDeps({
      daemon: ({ child, clock }) => clock.setTimeout(() => {
        writeFileSync(logPath, '[slack] Fatal: fresh\n')
        child.emit('exit', 1, null)
      }, 100),
    })

    await expect(createCli(b.deps).start()).rejects.toBeInstanceOf(ExitError)

    expect(b.exitCodes).toEqual([1])
    expect(reportedLogLines()).toEqual(['[slack] Fatal: fresh'])
  })

  test('daemon exits having written nothing: exit 1, says it wrote nothing to server.log', async () => {
    writeFileSync(logPath, '[slack] line from an earlier run\n')
    const b = makeDeps({ daemon: ({ child, clock }) => clock.setTimeout(() => child.emit('exit', 1, null), 100) })

    await expect(createCli(b.deps).start()).rejects.toBeInstanceOf(ExitError)

    expect(b.exitCodes).toEqual([1])
    expect(stderr).toContain(`[slack] Server failed to start (exit code 1); it wrote nothing to ${logPath}`)
    expect(stderr.join('\n')).not.toContain('earlier run')
  })

  test('spawn fails (`error` event): exit 1, could not be launched', async () => {
    const b = makeDeps({
      daemonPid: undefined,
      daemon: ({ child, clock }) => clock.setTimeout(() => child.emit('error', new Error('spawn ENOENT')), 0),
    })

    await expect(createCli(b.deps).start()).rejects.toBeInstanceOf(ExitError)

    expect(b.exitCodes).toEqual([1])
    expect(stderr).toContain(`[slack] Server failed to start (could not be launched: spawn ENOENT); it wrote nothing to ${logPath}`)
  })

  test('daemon writes its PID to the PID file: exit 0 with the starting-in-background line, before the bound', async () => {
    const b = makeDeps() // readyDaemon: PID file at 200 ms

    await expect(createCli(b.deps).start()).rejects.toBeInstanceOf(ExitError)

    expect(b.exitCodes).toEqual([0])
    expect(stderr).toContain(`[slack] Server starting in background (PID ${DAEMON_PID})`)
    expect(b.exitTimes[0]).toBeGreaterThanOrEqual(200)
    expect(b.exitTimes[0]).toBeLessThan(200 + 2 * DAEMON_STARTUP_POLL_MS)
  })

  test('neither exit nor PID within the bound: exit 0 with the still-starting line, daemon never signalled', async () => {
    // A PID file naming another process (a previous server) does not count as ready.
    writeFileSync(pidPath, '4242\n')
    const b = makeDeps({ daemon: () => { /* stays silent */ } })

    await expect(createCli(b.deps).start()).rejects.toBeInstanceOf(ExitError)

    expect(b.exitCodes).toEqual([0])
    expect(b.exitTimes[0]).toBeGreaterThanOrEqual(DAEMON_STARTUP_WAIT_MS)
    expect(b.exitTimes[0]).toBeLessThan(DAEMON_STARTUP_WAIT_MS + DAEMON_STARTUP_POLL_MS)
    expect(stderr).toContain(
      `[slack] Server is still starting in the background (PID ${DAEMON_PID}) after ${DAEMON_STARTUP_WAIT_MS / 1000}s — its log is ${logPath}`,
    )
    expect(b.daemonSpawns[0]!.child.signals).toEqual([])
    expect(b.serverSignals).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// start — the daemon's server.log descriptor (the parent never holds it open)
// ---------------------------------------------------------------------------

describe('start — server.log descriptor', () => {
  test('opens <stateDir>/server.log, gives that fd to the daemon as stdout and stderr, closes it once after the spawn and before the wait', async () => {
    const b = makeDeps()

    await expect(createCli(b.deps).start()).rejects.toBeInstanceOf(ExitError)

    expect(b.logOpens).toEqual([logPath])
    expect(b.daemonSpawns[0]!.opts.stdio).toEqual(['ignore', LOG_FD, LOG_FD])
    expect(b.closedFds).toEqual([LOG_FD])
    expect(b.events.slice(0, 4)).toEqual(['openLogAppend', 'spawnDaemon', `closeFd:${LOG_FD}`, 'sleep'])
    expect(b.exitCodes).toEqual([0])
  })

  test('spawnDaemon throwing: the fd is still closed once and the error propagates', async () => {
    const err = new Error('spawn EAGAIN')
    const b = makeDeps({ spawnDaemonError: err })

    await expect(createCli(b.deps).start()).rejects.toBe(err)

    expect(b.closedFds).toEqual([LOG_FD])
    expect(b.exitCodes).toEqual([])
  })

  test('production deps open the log for append, close it with closeSync and redirect with initLogging from ./logging.ts (static)', () => {
    const code = stripComments(readFileSync(CLI_SOURCE, 'utf-8'))
    const props = objectProperties(code.slice(code.indexOf('const realDeps: CliDeps =')))
    expect(props.get('openLogAppend')).toBe("(path) => openSync(path, 'a')")
    expect(props.get('closeFd')).toBe('(fd) => closeSync(fd)')
    expect(props.get('initLogging')).toBe('initLogging')
    expect(code).toMatch(/import\s*\{[^}]*\binitLogging\b[^}]*\}\s*from\s*'\.\/logging\.ts'/)
  })
})

// ---------------------------------------------------------------------------
// start — session-leader daemonize guard (b.acn)
//
// The bug: a leaked _CLI_DAEMON_CHILD marker in the launcher's environment made
// `start` trust the marker and run the server in-place (child path), inheriting
// the launcher's session/PGID so killing the launcher's group killed the server.
// The fix: only trust the marker when the process is ALSO a session leader; a
// set-but-not-leader marker is treated as a leak, cleared, and the parent path
// re-detaches via a detached spawn.
//
// Under `bun test` the test process is NOT a session leader, so with the marker
// preset we exercise exactly the leaked-marker scenario:
//   - fixed code  -> parent path: detached spawn + exit(0), startServer NOT run
//   - pre-fix code -> child path: startServer run in-place (the bug)
//
// The daemon is the injected fake `spawnDaemon`, so no real server process is
// ever launched (shared-infra safety).
// ---------------------------------------------------------------------------

/** Session id (field 4 after comm) from /proc/self/stat, as src/cli.ts reads it; null without /proc. */
function readOwnSessionId(): number | null {
  try {
    const stat = readFileSync('/proc/self/stat', 'utf8')
    const fields = stat.slice(stat.lastIndexOf(') ') + 2).split(' ')
    const session = parseInt(fields[3] ?? '', 10)
    return Number.isNaN(session) ? null : session
  } catch {
    return null
  }
}

describe('start — daemonize session-leader guard (b.acn)', () => {
  beforeEach(() => {
    // PRECONDITION: the leaked-marker tests assume the runner is NOT a session
    // leader. Fail loudly with a self-diagnosing message if it is (e.g. PID 1).
    const sid = readOwnSessionId()
    if (sid !== null && sid === process.pid) {
      throw new Error(
        `b.acn precondition violated: the test runner IS a session leader ` +
        `(session id ${sid} === pid ${process.pid}). The leaked-marker guard ` +
        `tests require a non-session-leader runner. Run the suite as a child ` +
        `process (not PID 1 / not a session leader).`,
      )
    }
  })

  // The recorded spawn is a real detach: detached:true, the marker in the child
  // env, stdio not inherited (the child survives its parent), the `start`
  // subcommand, and the child unref'd.
  function expectRealDetach(b: Bundle) {
    expect(b.daemonSpawns).toHaveLength(1)
    const { cmd, args, opts, child } = b.daemonSpawns[0]!
    expect(cmd).toBe(process.execPath)
    expect(opts.detached).toBe(true)
    expect(opts.env['_CLI_DAEMON_CHILD']).toBe('1')
    expect(opts.stdio).not.toContain('inherit')
    expect(opts.stdio[0]).toBe('ignore')
    expect(args).toContain('start')
    expect(child.unrefCalls).toBe(1)
  }

  // REGRESSION (b.acn): fails with pre-fix code, passes with the fix.
  test('leaked _CLI_DAEMON_CHILD marker (not a session leader) re-detaches instead of running in-place', async () => {
    const b = makeDeps()
    process.env['_CLI_DAEMON_CHILD'] = '1'

    await expect(createCli(b.deps).start()).rejects.toBeInstanceOf(ExitError)

    expectRealDetach(b)
    expect(b.exitCodes).toEqual([0])
    expect(b.startServerCalled).toBe(false)
  })

  // Baseline: with no marker, the parent always detaches.
  test('no marker at all: parent detaches and exits (baseline)', async () => {
    const b = makeDeps()

    await expect(createCli(b.deps).start()).rejects.toBeInstanceOf(ExitError)

    expectRealDetach(b)
    expect(b.exitCodes).toEqual([0])
    expect(b.startServerCalled).toBe(false)
  })

  // b.av2 SR-10.2: `--reconcile-instance-ids` is retired, so `start` no longer
  // turns it into CSCB_RECONCILE_INSTANCE_IDS for the daemon child.
  test('--reconcile-instance-ids on argv is not forwarded to the daemon child as CSCB_RECONCILE_INSTANCE_IDS (SR-10.2)', async () => {
    const savedEnv = process.env['CSCB_RECONCILE_INSTANCE_IDS']
    // The child env copies process.env, so the runner's own value must not mask a forward.
    delete process.env['CSCB_RECONCILE_INSTANCE_IDS']
    process.argv = [...savedArgv, '--reconcile-instance-ids']
    try {
      const b = makeDeps()
      await expect(createCli(b.deps).start()).rejects.toBeInstanceOf(ExitError)

      expectRealDetach(b)
      expect('CSCB_RECONCILE_INSTANCE_IDS' in b.daemonSpawns[0]!.opts.env).toBe(false)
    } finally {
      if (savedEnv === undefined) delete process.env['CSCB_RECONCILE_INSTANCE_IDS']
      else process.env['CSCB_RECONCILE_INSTANCE_IDS'] = savedEnv
    }
  })
})

// ---------------------------------------------------------------------------
// Persona-set teardown (b.av2 SR-8.7): exactly the config's personas, by cscb_<key>
// ---------------------------------------------------------------------------

describe('persona-set teardown', () => {
  const alphaId = (): string => personaInstanceId(personaKey(ALPHA.name))
  const betaId = (): string => personaInstanceId(personaKey(BETA.name))

  test.each([
    ['clean_restart', (b: Bundle) => createCli(b.deps).clean_restart()],
    ['stop --stop-bots', (b: Bundle) => createCli(b.deps).stop({ stopBots: true }).catch((e) => { if (!(e instanceof ExitError)) throw e })],
  ])('%s: two personas (two channels; zero channels with DMs) each get one get, one one-line read-pane, one status, pause and kill on cscb_<key>, none by channel', async (_name, run) => {
    const b = makeStopDeps({
      config: twoPersonas(),
      directorStatus: async () => ({ state: 'waiting' }),
      directorPause: async () => { throw errTmuxSendKeys() }, // GONE: escalate → one kill each (b.jg5 SRJ-903)
    })

    await run(b)

    const ids = [alphaId(), betaId()].sort()
    expectOnePrecheckEach(b, ids)
    expect([...b.statusCalls].sort()).toEqual(ids)
    expect([...b.pauseCalls].sort()).toEqual(ids)
    expect([...b.killCalls].sort()).toEqual(ids)
    const channelIds = [...ALPHA.channels.map((c) => c.id)]
    for (const [call] of b.directorCallTimes) {
      expect(channelIds.some((c) => call.includes(c))).toBe(false)
    }
    expect(b.exitCodes).not.toContain(1)
  })

  test('the instance ID is cscb_<key>, never the persona name or its channel', async () => {
    const b = makeDeps({ directorStatus: async () => ({ state: 'ended' }) })
    await createCli(b.deps).clean_restart()
    expect(personaKey(OPS_NAME)).not.toBe(OPS_NAME) // precondition: name ≠ key
    expectOnePrecheckEach(b, [opsId()])
    expect(b.statusCalls).toEqual([opsId()])
  })

  test('an absent row logs the persona reference ("<name>" (key=<key>)) and skips', async () => {
    const b = makeDeps({ directorStatus: async () => null })
    await createCli(b.deps).clean_restart()
    expect(stderr).toContain(`[slack] teardownBots: no spawn row for persona ${renderPersonaRef(OPS_NAME, personaKey(OPS_NAME))} — skipping`)
  })

  test('clean_restart with an empty personas array: no director call, still stops and starts', async () => {
    const b = makeDeps({ config: makeMultiPersonaConfig([], root), directorStatus: async () => ({ state: 'waiting' }) })
    await createCli(b.deps).clean_restart()
    expect(b.directorCallTimes).toEqual([]) // no get, read-pane, status, pause or kill
    expect(b.spawnCalls.map((c) => c.args.at(-1))).toEqual(['stop', 'start'])
    expect(b.exitCodes).toEqual([])
  })

  test('stop --stop-bots with an empty personas array: no director call, server stop exit 0', async () => {
    const b = makeStopDeps({ config: makeMultiPersonaConfig([], root), directorStatus: async () => ({ state: 'waiting' }) })
    await expect(createCli(b.deps).stop({ stopBots: true })).rejects.toBeInstanceOf(ExitError)
    expect(b.directorCallTimes).toEqual([]) // no get, read-pane, status, pause or kill
    expect(b.exitCodes).toEqual([0])
  })

  test('one persona failing loudly still lets the other be torn down; the last line counts one persona, and clean_restart, agent-director answering, starts the server again', async () => {
    const alphaError = errCallTimeout('status')
    const b = makeDeps({
      config: twoPersonas(),
      directorStatus: async (id) => {
        if (id === alphaId()) throw alphaError
        return { state: 'waiting' }
      },
      directorPause: async () => { throw errTmuxSendKeys() }, // GONE: one pause, then the kill (b.jg5 SRJ-903)
    })
    await expect(createCli(b.deps).clean_restart()).rejects.toBeInstanceOf(ExitError)
    expect(b.killCalls).toEqual([betaId()])
    expect(b.exitCodes).toEqual([1])
    expectReported(b, CLI_COMMAND_CLEAN_RESTART, [failedReport(CLI_COMMAND_CLEAN_RESTART, personaOf(ALPHA.name), alphaError, AD_ERROR_CLASS_UNAVAILABLE)])
    expectRestarted(b)
  })

  // AC 20 (b.av2 SR-10.3): the pause-escalation, timeout-path "kill failed"
  // and per-persona teardown failure lines log each error's description
  // (b.jg5 SRJ-104: the reported name and redacted description of an
  // agent-director error, else its type, safe code, message through
  // `redactSlackLogText` and frames), never the error itself; the failure
  // line also names the persona, its session and the class (b.jg5 SRJ-907).
  // The errors carry fake tokens (in a message, with a URL); the raw
  // console.error arguments, server.log and startup-errors.log are checked.
  // With a successful pause and `exit_timeout: 0` the poll loop never runs,
  // so the timeout path's kill is reached at once.
  /** The command's report lines that name a class (SRJ-907's failure lines). */
  const failureLines = (): string[] => stderr.filter((l) => l.startsWith(`${CLI_COMMAND_CLEAN_RESTART}: `))

  test('AC 20: a pause answering UNAVAILABLE on every try and then its escalation kill failing, with errors carrying fake tokens — the pause and teardown lines name each error with its message redacted; clean_restart exits 1 and, agent-director answering, starts the server again; nothing logged leaks', async () => {
    const killError = new AgentDirectorError('kill', 'ErrKillBroken', `kill refused (${sentinelInMessage('kill', APP_TOKEN_PREFIX)})`)
    const b = makeDeps({
      directorStatus: async () => ({ state: 'waiting' }),
      // A plain Error is UNAVAILABLE: the pause is tried PRECHECK_TRIES times, then escalates (b.jg5 SRJ-903).
      directorPause: async () => {
        throw Object.assign(new Error(`pause refused (${sentinelInMessage('pause')})`), { code: 'ECONNRESET', note: LEAK_SENTINEL })
      },
      directorKill: async () => { throw killError },
    })

    await expect(createCli(b.deps).clean_restart()).rejects.toBeInstanceOf(ExitError)

    const ref = renderPersonaRef(OPS_NAME, personaKey(OPS_NAME))
    const line = (fragment: string): string[] => stderr.filter((l) => l.includes(fragment))
    expect(b.pauseCalls).toHaveLength(PRECHECK_TRIES)
    expect(b.killCalls).toEqual([opsId()])
    expect(line('pause failed').map((l) => l.split(' at ')[0])).toEqual([
      `[slack] teardownBots: pause failed for persona ${ref} — escalating to kill: Error code=ECONNRESET message="pause refused (${REDACTED_SENTINEL_TAIL})"`,
    ])
    expectReported(b, CLI_COMMAND_CLEAN_RESTART, [failedReport(CLI_COMMAND_CLEAN_RESTART, OPS_PERSONA, killError, AD_ERROR_CLASS_UNCLASSIFIED)])
    expect(failureLines()[0]).toContain(`: ${AD_ERROR_CLASS_UNCLASSIFIED}: ErrKillBroken message="kill refused (${REDACTED_SENTINEL_TAIL})"`)
    expect(b.exitCodes).toEqual([1])
    expectRestarted(b)
    assertNoLeak({ consoleErrorArgs: errorSpy.mock.calls, stderr })
  })

  test('AC 20: a timeout-path kill failing with an UNAVAILABLE error carrying fake tokens on every try — KILL_RETRY_TRIES kills with a status read before each further one, then the "kill failed" and teardown lines name the error with its message redacted; clean_restart exits 1 and, agent-director answering, starts the server again; nothing logged leaks', async () => {
    const killError = Object.assign(new Error(`kill refused (${sentinelInMessage('kill')})`), { code: 'ECONNRESET', note: LEAK_SENTINEL })
    const b = makeDeps({
      config: opsConfig({ exit_timeout: 0 }),
      directorStatus: async () => ({ state: 'waiting' }),
      directorPause: async () => { /* pause succeeds */ },
      directorKill: async () => { throw killError },
    })

    await expect(createCli(b.deps).clean_restart()).rejects.toBeInstanceOf(ExitError)

    const ref = renderPersonaRef(OPS_NAME, personaKey(OPS_NAME))
    const line = (fragment: string): string[] => stderr.filter((l) => l.includes(fragment))
    expect(b.pauseCalls).toEqual([opsId()])
    // A plain Error is UNAVAILABLE: tried KILL_RETRY_TRIES times, one status read before each further try (b.jg5 SRJ-904).
    expect(b.killCalls).toEqual(Array.from({ length: KILL_RETRY_TRIES }, opsId))
    expect(b.statusCalls).toEqual(Array.from({ length: 1 + (KILL_RETRY_TRIES - 1) }, opsId)) // the state read, then one read between each pair of tries
    expect(line('kill failed').map((l) => l.split(' at ')[0])).toEqual([
      `[slack] teardownBots: kill failed for persona ${ref}: Error code=ECONNRESET message="kill refused (${REDACTED_SENTINEL_TAIL})"`,
    ])
    // A plain Error is no ErrTmuxKillFailed: no alert follows its line (b.jg5 SRJ-907).
    expectReported(b, CLI_COMMAND_CLEAN_RESTART, [failedReport(CLI_COMMAND_CLEAN_RESTART, OPS_PERSONA, killError, AD_ERROR_CLASS_UNAVAILABLE)])
    expect(failureLines()[0]).toContain(`: ${AD_ERROR_CLASS_UNAVAILABLE}: Error code=ECONNRESET message="kill refused (${REDACTED_SENTINEL_TAIL})"`)
    expect(b.exitCodes).toEqual([1])
    expectRestarted(b)
    assertNoLeak({ consoleErrorArgs: errorSpy.mock.calls, stderr })
  })
})

// ---------------------------------------------------------------------------
// clean_restart — SR-11 Event 12: a row with nothing to stop is skipped. The
// pause, the poll and the kill by class are covered for both commands below.
// ---------------------------------------------------------------------------

describe('clean_restart', () => {
  test('genuinely-absent row (null) skips quietly and clean_restart still starts', async () => {
    const b = makeDeps({ directorStatus: async () => null })
    await createCli(b.deps).clean_restart()
    expect(b.statusCalls).toEqual([opsId()])
    expect(b.pauseCalls).toEqual([])
    expect(b.killCalls).toEqual([])
    // Absent-row (null) → skip + proceed; AD error (throw) → loud abort (b.qwo below).
    expect(b.exitCodes).not.toContain(1)
    expect(startedServer(b)).toBe(true)
  })

  test('skips personas already in terminal state', async () => {
    const b = makeDeps({ directorStatus: async () => ({ state: 'ended' }) })
    await createCli(b.deps).clean_restart()
    expect(b.pauseCalls).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// clean_restart — clean_restart.log, with fatal lines also on the terminal
// ---------------------------------------------------------------------------

describe('clean_restart — clean_restart.log and the terminal', () => {
  /** The state read's answer in the "teardown fails" case. */
  const teardownError = new Error('AD connection refused')
  /** The initialization's failure in the "agent-director initialization fails" case. */
  const initError = new Error('startup gate failed')

  /** Each case's fatal lines, in order: each terminal line starts with its entry. */
  const FATAL: Array<[string, Overrides, () => string[]]> = [
    ['config load fails', { loadConfig: () => { throw new Error('config boom') } }, () => ['[slack] clean_restart: failed to load config: config boom']],
    // b.jg5 SRJ-901: an initialization failure is a precheck failure; it stops nothing and says so.
    [
      'agent-director initialization fails',
      { initClient: async () => { throw initError } },
      () => [
        agentDirectorInitFailedLine(CLI_COMMAND_CLEAN_RESTART, describeThrownValue(initError)),
        precheckNothingStoppedLine(CLI_COMMAND_CLEAN_RESTART),
      ],
    ],
    // b.jg5 SRJ-906, SRJ-907: agent-director answers, so the server is started (its lines are log only); the
    // persona's failure line, then the last line, printed last.
    [
      'teardown fails',
      { directorStatus: async () => { throw teardownError } },
      () => [
        teardownFailureLine(CLI_COMMAND_CLEAN_RESTART, OPS_PERSONA, teardownErrorReportOf(teardownError)),
        teardownNotStoppedLine(CLI_COMMAND_CLEAN_RESTART, 1),
      ],
    ],
    // b.jg5 SRJ-906: the start after the failed teardown fails: its start-failed line before the last line.
    [
      'teardown fails, then the start fails',
      { directorStatus: async () => { throw teardownError }, spawnSyncStatus: 3 },
      () => [
        teardownFailureLine(CLI_COMMAND_CLEAN_RESTART, OPS_PERSONA, teardownErrorReportOf(teardownError)),
        cleanRestartStartFailedLine(3),
        teardownNotStoppedLine(CLI_COMMAND_CLEAN_RESTART, 1),
      ],
    ],
    // b.jg5 SRJ-906, SRJ-1013: agent-director does not answer: the not-restarted alert before the last line; each
    // failed list try's line is log only.
    [
      'teardown fails and agent-director does not answer',
      { directorStatus: async () => { throw teardownError }, directorList: async () => { throw teardownError } },
      () => [
        teardownFailureLine(CLI_COMMAND_CLEAN_RESTART, OPS_PERSONA, teardownErrorReportOf(teardownError)),
        cleanRestartNotRestartedAlert([{ persona: OPS_PERSONA, errorClass: teardownErrorReportOf(teardownError).errorClass }]),
        teardownNotStoppedLine(CLI_COMMAND_CLEAN_RESTART, 1),
      ],
    ],
    // stop's non-zero exit is a non-fatal line: log only.
    ['start fails', { spawnSyncStatus: 3 }, () => [cleanRestartStartFailedLine(3)]],
  ]

  test.each(FATAL)('%s: each fatal line reaches the terminal once and the log once; no other line reaches the terminal', async (_name, o, lines) => {
    const log: string[] = []
    const b = makeDeps({ ...o, initLogging: redirectTo(log) })

    await expect(createCli(b.deps).clean_restart()).rejects.toBeInstanceOf(ExitError)

    expect(b.logInits).toEqual([join(stateDir, 'clean_restart.log')])
    const expected = lines()
    expect(stderr).toHaveLength(expected.length)
    expected.forEach((line, i) => {
      expect(stderr[i]!.startsWith(line)).toBe(true)
      expect(log.filter((l) => l === stderr[i])).toHaveLength(1)
    })
    assertNoLeak({ stderr, log })
  })

  test('a successful run redirects to <stateDir>/clean_restart.log before loading the config; every line goes to the log, none to the terminal', async () => {
    const log: string[] = []
    const b = makeDeps({ initLogging: redirectTo(log) })

    await createCli(b.deps).clean_restart()

    expect(b.logInits).toEqual([join(stateDir, 'clean_restart.log')])
    expect(b.events.indexOf('initLogging')).toBeLessThan(b.events.indexOf('loadConfig'))
    expect(stderr).toEqual([])
    expect(log).toContain('[slack] clean_restart: stopping server')
    expect(log).toContain('[slack] clean_restart: done')
  })

  test('initLogging throwing: clean_restart still runs, its lines stay on the terminal and the fatal line appears once', async () => {
    const b = makeDeps({ spawnSyncStatus: 3, initLogging: () => { throw new Error('EACCES') } })

    await expect(createCli(b.deps).clean_restart()).rejects.toBeInstanceOf(ExitError)

    expect(b.exitCodes).toEqual([3])
    expect(stderr).toContain('[slack] clean_restart: stopping server')
    expect(stderr.filter((l) => l === cleanRestartStartFailedLine(3))).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// createDirectorOps — the production director deps (b.qwo, b.dnt)
// ---------------------------------------------------------------------------

describe('createDirectorOps', () => {
  const OPS: Array<keyof DirectorOps> = ['directorGet', 'directorReadPane', 'directorStatus', 'directorPause', 'directorKill', 'directorList']

  /** The one row the fake Client's `list` answers. */
  const LIST_ROW = cannedListRow({ claude_instance_id: opsId() })

  /** The `get` row the fake Client answers: a live row carrying a note and a launch start, so each field read shows. */
  const GET_ROW: PrecheckRow = { state: 'pending', liveness_note: provenanceNote, launch_started_at: SAMPLE_LAUNCH_START_DEFAULT }

  /**
   * A fake Client whose verbs record [verb, request] and throw `fail` when
   * given; its `kill` answers `killResult` (default `cannedKillResult(true)`).
   */
  function fakeClient(fail?: unknown, killResult: object = cannedKillResult(true)): { client: DirectorClient; calls: Array<[string, unknown]> } {
    const calls: Array<[string, unknown]> = []
    const verb = (name: string, result: object) => async (req: unknown) => {
      calls.push([name, req])
      if (fail !== undefined) throw fail
      return result
    }
    const client = {
      get: verb('get', { ...GET_ROW, claude_instance_id: opsId() }),
      readPane: verb('readPane', { pane: FAKE_PANE }),
      status: verb('status', { state: 'working' }),
      pause: verb('pause', {}),
      kill: verb('kill', killResult),
      list: verb('list', { spawns: [LIST_ROW] }),
    }
    return { client: client as unknown as DirectorClient, calls }
  }

  /** Call `op` on `ops` for the Ops persona; `directorReadPane` with the one-line count; `directorList` with none. */
  const callOp = (ops: DirectorOps, op: keyof DirectorOps): Promise<unknown> => {
    if (op === 'directorReadPane') return ops.directorReadPane(opsId(), PROBE_PANE_READ_LINES)
    if (op === 'directorList') return ops.directorList()
    return ops[op](opsId())
  }

  /**
   * Every error an op meets, built by name. Only directorGet and directorStatus
   * read a missing row (ErrSpawnNotFound, recognised by its name, never by the
   * client's class) as no row; every other op, and every other error, rejects
   * with the same value: the precheck classifies its get and read-pane errors
   * itself (b.jg5 SRJ-117, SRJ-901; ErrSpawnNotFound takes read-pane's GONE
   * column), the teardown's checked kill reads ErrSpawnNotFound as a success
   * (SRJ-110, SRJ-904), and the answer check counts every list error, CONFIG
   * included, as a failed try (SRJ-906).
   */
  const OP_ERRORS: ReadonlyArray<readonly [string, () => unknown, missingRow: boolean]> = [
    ['ErrSpawnNotFound', () => errSpawnNotFound(), true],
    ['ErrSpawnNotFound by name only (the base AgentDirectorError, as from a client with no class for it)', () => {
      const err = errGeneric(PRECHECK_CALL_GET, ERR_SPAWN_NOT_FOUND_NAME, 'row gone')
      if (Object.getPrototypeOf(err) !== AgentDirectorError.prototype) throw new Error('precondition: no client subclass to match')
      return err
    }, true],
    ['a connection error', () => new Error('AD connection refused'), false],
    ['ErrCallTimeout', () => errCallTimeout(PRECHECK_CALL_GET), false],
    ['ErrTmuxSessionConflict', () => errTmuxSessionConflict(PRECHECK_CALL_READ_PANE, 'not-this-launch'), false],
    ['the unusable-name ErrInternal', () => errUnusableName(), false],
    ['ErrConfigMalformed', () => errConfigMalformed(), false],
    ['ErrTmuxCaptureFailed', () => errTmuxCaptureFailed(), false],
  ]

  /** The ops that read a missing row as no row. */
  const NO_ROW_OPS: ReadonlySet<keyof DirectorOps> = new Set<keyof DirectorOps>(['directorGet', 'directorStatus'])

  test.each(OPS.flatMap((op) => OP_ERRORS.map(([label, make, missingRow]) => [op, label, make, missingRow] as const)))(
    '%s when the Client throws %s: null for a missing row at get or status, else a rejection with the same value',
    async (op, _label, make, missingRow) => {
      const err = make()
      const call = callOp(createDirectorOps(() => fakeClient(err).client), op)
      if (missingRow && NO_ROW_OPS.has(op)) expect(await call).toBeNull()
      else await expect(call).rejects.toBe(err)
    },
  )

  test('directorList makes one list whose request is exactly the service label filter, and answers the Client\'s rows unchanged (b.jg5 SRJ-906)', async () => {
    const { client, calls } = fakeClient()
    expect(await createDirectorOps(() => client).directorList()).toEqual([LIST_ROW])
    expect(calls).toEqual([['list', { label: [SERVICE_LABEL] }]])
    expect(Object.keys(calls[0]![1] as object)).toEqual(['label'])
    assertNoLeak({ calls })
  })

  // b.jg5 SRJ-110, SRJ-904: the kill result goes to the teardown's checked kill as the Client answered it, and the
  // request is the instance ID alone (never include_finished, SRJ-106).
  test.each([
    ['kill_sent true', cannedKillResult(true)],
    ['kill_sent false', cannedKillResult(false)],
    ['no kill_sent (a binary older than Phase 1)', cannedKillResult()],
  ] as const)('directorKill resolves the Client\'s kill result unchanged (%s); its one request is exactly the instance ID', async (_label, result) => {
    const { client, calls } = fakeClient(undefined, result)
    expect(await createDirectorOps(() => client).directorKill(opsId())).toBe(result)
    expect(calls).toEqual([['kill', { claude_instance_id: opsId() }]])
    expect(Object.keys(calls[0]![1] as object)).toEqual(['claude_instance_id'])
  })

  test.each(OPS)('%s rejects with getClient\'s own error when getClient throws (no Client installed)', async (op) => {
    const err = new Error('agent-director client not initialized')
    await expect(callOp(createDirectorOps(() => { throw err }), op)).rejects.toBe(err)
  })

  test('getClient is called on every op (a Client installed later is used); each verb but list gets cscb_<key> as claude_instance_id, read-pane the given n_lines, list the service label filter; get answers the row\'s state, note and launch start, read-pane the pane, list the rows', async () => {
    let installed: DirectorClient | null = null
    let gets = 0
    const ops = createDirectorOps(() => {
      gets++
      if (installed === null) throw new Error('agent-director client not initialized')
      return installed
    })
    await expect(ops.directorStatus(opsId())).rejects.toThrow('agent-director client not initialized')
    const { client, calls } = fakeClient()
    installed = client

    expect(await ops.directorGet(opsId())).toEqual(GET_ROW)
    expect(await ops.directorReadPane(opsId(), PROBE_PANE_READ_LINES)).toBe(FAKE_PANE)
    expect(await ops.directorStatus(opsId())).toEqual({ state: 'working' })
    await ops.directorPause(opsId())
    expect(await ops.directorKill(opsId())).toEqual(cannedKillResult(true))
    expect(await ops.directorList()).toEqual([LIST_ROW])

    expect(gets).toBe(7)
    const req = { claude_instance_id: opsId() }
    expect(calls).toEqual([
      ['get', req],
      ['readPane', { ...req, n_lines: PROBE_PANE_READ_LINES }],
      ['status', req],
      ['pause', req],
      ['kill', req],
      ['list', { label: [SERVICE_LABEL] }],
    ])
    assertNoLeak({ calls })
  })

  test('production deps take directorGet / directorReadPane / directorStatus / directorPause / directorKill / directorList from createDirectorOps(getClient) (static)', () => {
    const code = stripComments(readFileSync(CLI_SOURCE, 'utf-8'))
    expect(code).toMatch(/import\s*\{\s*getClient\s*\}\s*from\s*'\.\/agent-director-client\.ts'/)
    const made = [...code.matchAll(/\bconst\s+(\w+)\s*=\s*createDirectorOps\s*\(\s*getClient\s*\)/g)]
    expect(made).toHaveLength(1)
    const props = objectProperties(code.slice(code.indexOf('const realDeps: CliDeps =')))
    for (const op of OPS) expect(props.get(op)).toBe(`${made[0]![1]}.${op}`)
  })
})

// ---------------------------------------------------------------------------
// stop — b.4dk `--stop-bots` graceful bot teardown
//
// `stop({ stopBots: true })` reuses clean_restart's per-persona pause/poll/kill
// teardown (teardownBots) AFTER stopping the server. Plain `stop()` never
// touches the director verbs — bots survive server restarts.
// ---------------------------------------------------------------------------

describe('stop --stop-bots (b.4dk)', () => {
  test('stopBots: a config load error does NOT block server stop and runs no director verb', async () => {
    const b = makeStopDeps({ loadConfig: () => { throw new Error('config boom') } })
    await expect(createCli(b.deps).stop({ stopBots: true })).rejects.toBeInstanceOf(ExitError)
    expect(b.exitCodes).toEqual([0])
    expect(b.directorCallTimes).toEqual([]) // no get, read-pane, status, pause or kill
  })

  // b.4dk ordering: the server is stopped BEFORE any bot teardown begins, so the
  // live daemon cannot respawn a persona mid-teardown. b.jg5 SRJ-901: the
  // precheck's get and read-pane come before the server stop, so a failed
  // precheck stops nothing.
  test('stopBots: every precheck call precedes the server SIGTERM, which precedes the teardown\'s first status, pause and kill (teardown-first regression guard)', async () => {
    const b = makeLiveStopDeps({
      config: opsConfig({ stop_timeout: 1, exit_timeout: 0 }),
      directorStatus: async () => ({ state: 'waiting' }),
    })
    await expect(createCli(b.deps).stop({ stopBots: true })).rejects.toBeInstanceOf(ExitError)
    const firstServer = b.events.indexOf('server:SIGTERM')
    const at = (verb: string): number[] => b.events.flatMap((e, i) => (e.startsWith(`${verb}:`) ? [i] : []))
    expect(firstServer).toBeGreaterThanOrEqual(0)
    const precheck = [...at(PRECHECK_CALL_GET), ...at(PRECHECK_CALL_READ_PANE)]
    expect(precheck).toHaveLength(2)
    expect(Math.max(...precheck)).toBeLessThan(firstServer)
    for (const verb of ['status', 'pause', 'kill']) {
      expect(at(verb).length).toBeGreaterThan(0)
      expect(Math.min(...at(verb))).toBeGreaterThan(firstServer)
    }
    assertNoLeak({ stderr, events: b.events })
  })

  test.each([[undefined], [{}]])(
    'plain stop(%p) never touches director verbs (bots survive server restarts)',
    async (opts) => {
      const b = makeStopDeps({ directorStatus: async () => ({ state: 'waiting' }) })
      await expect(createCli(b.deps).stop(opts)).rejects.toBeInstanceOf(ExitError)
      expect(b.directorCallTimes).toEqual([]) // no precheck and no teardown
    },
  )
})

// ---------------------------------------------------------------------------
// b.qwo — AD-unreachable teardown must fail LOUDLY, never a silent no-op
//
// Root cause (b.qps / incident-2026-09-18): getClient() threw in the short-lived
// CLI process (no server startup gate) and the error was collapsed into a
// per-bot "no spawn row — skipping". Every bot was skipped and clean_restart
// proceeded to `start`. Now directorStatus errors propagate (null only for
// ErrSpawnNotFound) and fail that persona, which gets its failure line;
// clean_restart and `stop --stop-bots` then exit(1). `stop --stop-bots` never
// starts; clean_restart starts only once agent-director answers its `list`
// (b.jg5 SRJ-906).
// ---------------------------------------------------------------------------

describe('b.qwo — teardown fails loudly when agent-director is unreachable', () => {
  // b.jg5 SRJ-906: agent-director unreachable at the teardown and at the answer check's list: no start.
  test.each([
    ['a connection error', () => new Error('AD connection refused')],
    ['ErrCallTimeout', () => new ErrCallTimeout('status', 35000, 30000)],
  ])('clean_restart exits 1 with no start when directorStatus and the answer check\'s list throw %s — never "no spawn row"', async (_name, makeErr) => {
    const b = makeDeps({ directorStatus: async () => { throw makeErr() }, directorList: async () => { throw makeErr() } })
    await expect(createCli(b.deps).clean_restart()).rejects.toBeInstanceOf(ExitError)
    expect(b.exitCodes).toEqual([1])
    expect(listTimesOf(b)).toHaveLength(PRECHECK_TRIES)
    expect(startedServer(b)).toBe(false)
    expect(b.pauseCalls).toEqual([])
    expect(b.killCalls).toEqual([])
    expect(stderr.join('\n')).not.toContain('no spawn row')
  })

  test('stop --stop-bots exits 1 when directorStatus throws (AD unreachable)', async () => {
    const b = makeStopDeps({ directorStatus: async () => { throw new Error('AD connection refused') } })
    await expect(createCli(b.deps).stop({ stopBots: true })).rejects.toBeInstanceOf(ExitError)
    expect(b.exitCodes).toContain(1)
    expect(stderr.join('\n')).not.toContain('no spawn row')
  })
})

describe('b.qwo — initClient startup gate', () => {
  test('clean_restart calls initClient once, with the configuration\'s call timeout, before any director verb; then the precheck, then the stop spawn, then the teardown', async () => {
    let n = 0
    const b = makeDeps({
      initClient: async () => { /* gate ok */ },
      directorStatus: async () => (++n === 1 ? { state: 'waiting' } : { state: 'ended' }),
    })
    await createCli(b.deps).clean_restart()
    expect(b.initClientCalls).toEqual([DEFAULT_AGENT_DIRECTOR_CALL_TIMEOUT_MS])
    // b.jg5 SRJ-901: init, get, read-pane, the stop spawn, then the teardown's status and pause, then start.
    expect(b.events.filter((e) => e !== 'loadConfig' && e !== 'initLogging' && e !== 'sleep')).toEqual([
      'initClient',
      `${PRECHECK_CALL_GET}:${opsId()}`,
      `${PRECHECK_CALL_READ_PANE}:${opsId()}`,
      'spawnSync:stop',
      `status:${opsId()}`,
      `pause:${opsId()}`,
      `status:${opsId()}`,
      'spawnSync:start',
    ])
    assertNoLeak({ stderr, events: b.events })
  })

  // b.jg5 SRJ-213: an unreadable configuration still builds the client, with
  // the default call timeout, after the failed read; teardown is skipped and
  // the stop's exit code is unchanged.
  test('stop --stop-bots whose configuration cannot be read: the read comes first, then initClient once with the default call timeout; teardown skipped, exit 0', async () => {
    const b = makeStopDeps({
      loadConfig: () => { throw new Error('config boom') },
      initClient: async () => { /* gate ok */ },
      directorStatus: async () => ({ state: 'waiting' }),
    })
    await expect(createCli(b.deps).stop({ stopBots: true })).rejects.toBeInstanceOf(ExitError)
    expect(b.initClientCalls).toEqual([DEFAULT_AGENT_DIRECTOR_CALL_TIMEOUT_MS])
    expect(b.initClientGates).toEqual([FLOOR_EXEMPT_GATE])
    expect(b.events.filter((e) => e === 'loadConfig' || e === 'initClient')).toEqual(['loadConfig', 'initClient'])
    expect(stderr.filter((l) => l.startsWith('[slack] stop --stop-bots: could not load config — skipping bot teardown:'))).toHaveLength(1)
    expect(b.directorCallTimes).toEqual([]) // no get, read-pane, status, pause or kill
    expect(b.exitCodes).toEqual([0])
    assertNoLeak({ stderr, exitCodes: b.exitCodes })
  })

  test.each<[string, (b: Bundle) => Promise<void>]>([
    ['plain stop', (b) => createCli(b.deps).stop()],
    ['credentials <persona>', (b) => createCli(b.deps).credentials([OPS_NAME])],
  ])('%s builds no agent-director client, even with initClient wired (b.jg5 SRJ-203)', async (_label, run) => {
    const b = makeLiveStopDeps({ initClient: async () => { /* gate ok */ } })
    await expect(run(b)).rejects.toBeInstanceOf(ExitError)
    expect(b.exitCodes).toEqual([0])
    expect(b.initClientCalls).toEqual([])
    expect(b.directorCallTimes).toEqual([])
    assertNoLeak({ stderr, exitCodes: b.exitCodes })
  })
})

// ---------------------------------------------------------------------------
// The precheck (b.jg5 SRJ-901; SRJ-117's CLI-precheck column; AC 74)
//
// Before either command stops anything, it reads each persona of the
// configuration the server runs: one `get` of `cscb_<key>` and, for a live
// row, one one-line `read-pane`. A failed precheck stops nothing (no server
// signal, no `stop` spawn, no teardown call, no start), prints one line per
// failing persona and then "nothing was stopped", and exits 1. The verdict
// over each answer (its class and description) is tests/cli-teardown.test.ts's;
// here each failure line is the builder's over that verdict. Every wait runs on
// the bundle's fake clock.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// The two teardown commands, shared by the precheck's and the teardown's cases
// ---------------------------------------------------------------------------

/** A run that settles when the command exits through the fake `exit`. */
const settled = (p: Promise<void>): Promise<void> => p.catch((e) => { if (!(e instanceof ExitError)) throw e })

/** A command: its name, its bundle (a live server for `stop --stop-bots`) and its run. */
type Command = readonly [command: CliTeardownCommand, make: (o?: Overrides) => Bundle, run: (b: Bundle) => Promise<void>]
const COMMANDS: readonly Command[] = [
  [CLI_COMMAND_STOP_BOTS, makeLiveStopDeps, (b) => settled(createCli(b.deps).stop({ stopBots: true }))],
  [CLI_COMMAND_CLEAN_RESTART, makeDeps, (b) => settled(createCli(b.deps).clean_restart())],
]

/** Each row of `rows` for each command: `[command, label, spec, Command]`. */
function forEachCommand<S>(rows: ReadonlyArray<readonly [string, S]>): Array<readonly [CliTeardownCommand, string, S, Command]> {
  return COMMANDS.flatMap((cmd) => rows.map(([label, spec]) => [cmd[0], label, spec, cmd] as const))
}

describe('precheck before anything is stopped (b.jg5 SRJ-901, AC 74)', () => {
  const idOf = (p: CliTeardownPersona): string => personaInstanceId(p.key)

  /** The failure the precheck reports for `error` thrown by `call` (the verdict is tests/cli-teardown.test.ts's). */
  function failureOf(call: PrecheckCall, error: unknown): PrecheckFailure {
    const verdict = precheckVerdictOf({ call, error })
    if (!('errorClass' in verdict)) throw new Error(`precondition: ${call} verdict ${verdict.kind} carries no failure`)
    return verdict
  }

  /** Nothing was stopped: no server signal, no `stop` or `start` spawn, no `status`, `pause` or `kill`, no answer-check `list`; exit 1. */
  function expectNothingStopped(b: Bundle): void {
    expect(b.exitCodes).toEqual([1])
    expect(b.serverSignals).toEqual([])
    expect(b.spawnCalls).toEqual([])
    expect([b.statusCalls, b.pauseCalls, b.killCalls]).toEqual([[], [], []])
    expect(listTimesOf(b)).toEqual([])
  }

  /**
   * The precheck failed for `failures` ([persona, call, thrown value, class
   * shown], in configuration order): nothing stopped, and exactly one line per
   * failing persona from the builder, then the closing line, each printed once.
   */
  function expectPrecheckFailed(
    b: Bundle,
    command: CliTeardownCommand,
    failures: ReadonlyArray<readonly [CliTeardownPersona, PrecheckCall, unknown, AdErrorClass]>,
  ): void {
    expectNothingStopped(b)
    const lines = failures.map(([persona, call, error, shown]) => {
      const failure = failureOf(call, error)
      expect(failure.errorClass).toBe(shown)
      const line = precheckFailureLine(command, persona, failure)
      if (shown === AD_ERROR_CLASS_CONFIG) expect(line).toContain(AD_CONFIG_FILE_DISPLAY_NAME)
      return line
    })
    expect(stderr).toEqual([...lines, precheckNothingStoppedLine(command)])
  }

  /** The precheck passed and the command went on: the server stopped, the teardown read each row; clean_restart started the server. */
  function expectWentOn(b: Bundle, command: CliTeardownCommand): void {
    if (command === CLI_COMMAND_STOP_BOTS) {
      expect(b.serverSignals).toEqual(['SIGTERM'])
      expect(b.exitCodes).toEqual([0])
    } else {
      expect(b.spawnCalls.map((c) => c.args.at(-1))).toEqual(['stop', 'start'])
      expect(b.exitCodes).toEqual([])
    }
    expect(b.statusCalls.length).toBeGreaterThan(0)
    expect(stderr.filter((l) => l.startsWith(`${command}: `))).toEqual([])
  }

  const nOf = <T>(n: number, value: T): T[] => Array.from({ length: n }, () => value)
  const opsPaneReads = (n: number): Array<[string, number]> => nOf(n, [idOf(OPS_PERSONA), PROBE_PANE_READ_LINES])

  // -------------------------------------------------------------------------
  // Step 2: which rows get a read-pane
  // -------------------------------------------------------------------------

  test.each(forEachCommand<string>([...AGENT_DIRECTOR_LIVE_STATES, UNKNOWN_STATE].map((s) => [s, s] as const)))(
    '%s: a %s row is live: one get, then one read-pane of the one-line count; a pane passes and the command goes on',
    async (command, _label, state, [, make, run]) => {
      const b = make({ directorGet: async () => ({ state }) })
      await run(b)
      expect(b.getCalls).toEqual([idOf(OPS_PERSONA)])
      expect(b.readPaneCalls).toEqual(opsPaneReads(1))
      expectWentOn(b, command)
      assertNoLeak({ stderr, consoleErrorArgs: errorSpy.mock.calls })
    },
  )

  test.each(forEachCommand<() => Promise<PrecheckRow | null>>([
    ...[...AGENT_DIRECTOR_DEAD_STATES].map((state) => [`a finished row (${state})`, async () => ({ state })] as const),
    ['no row (null)', async () => null],
    ['no row (ErrSpawnNotFound thrown at the get)', async () => { throw errSpawnNotFound() }],
  ]))('%s: %s is skipped: one get, no read-pane, and the command goes on (AC 74: skips finished rows)', async (command, _label, answer, [, make, run]) => {
    const b = make({ directorGet: answer })
    await run(b)
    expect(b.getCalls).toEqual([idOf(OPS_PERSONA)])
    expect(b.readPaneCalls).toEqual([])
    expectWentOn(b, command)
    assertNoLeak({ stderr, consoleErrorArgs: errorSpy.mock.calls })
  })

  // SRJ-901 step 5 and SRJ-114: a note alone fails nothing; the read-pane decides. SRJ-513 latches only in the server.
  test.each(forEachCommand<PrecheckRow>([
    [`a live row carrying the ${provenanceNote} note`, { state: 'waiting', liveness_note: provenanceNote }],
    ['a pending row with no launch start', { state: AGENT_DIRECTOR_PENDING_STATE }],
  ]))('%s: %s gets its one-line read-pane and passes on a pane (AC 74)', async (command, _label, row, [, make, run]) => {
    const b = make({ directorGet: async () => row })
    await run(b)
    expect(b.readPaneCalls).toEqual(opsPaneReads(1))
    expectWentOn(b, command)
    assertNoLeak({ stderr, consoleErrorArgs: errorSpy.mock.calls })
  })

  // -------------------------------------------------------------------------
  // SRJ-117's CLI-precheck column, one case per cell, at read-pane and at get
  // -------------------------------------------------------------------------

  const PASSES = 'passes'
  const RETRIED = 'is tried PRECHECK_TRIES times, then fails'
  const FAILS = 'fails with no retry'
  const FAILS_AT_ONCE = 'fails after one call (CONFIG)'
  type Cell = { readonly make: () => unknown; readonly outcome: string; readonly shown: AdErrorClass | null }
  const cell = (make: () => unknown, outcome: string, shown: AdErrorClass | null = null): Cell => ({ make, outcome, shown })

  const READ_PANE_CELLS: ReadonlyArray<readonly [string, Cell]> = [
    ['GONE (ErrTmuxCaptureFailed)', cell(() => errTmuxCaptureFailed(), PASSES)],
    ['ErrSpawnNotFound (its GONE column)', cell(() => errSpawnNotFound(), PASSES)],
    ...UNAVAILABLE_FORMS.map(([label, make]) => [`UNAVAILABLE (${label})`, cell(() => make(PRECHECK_CALL_READ_PANE), RETRIED, AD_ERROR_CLASS_UNAVAILABLE)] as const),
    ...CONFLICT_CASES.map((c) => [`CONFLICT (${c})`, cell(() => errTmuxSessionConflict(PRECHECK_CALL_READ_PANE, c), FAILS, AD_ERROR_CLASS_CONFLICT)] as const),
    ['ENVIRONMENT (ErrTmuxNotAvailable)', cell(() => errTmuxNotAvailable(STUB_TMUX_SOCKET_PATH, PRECHECK_CALL_READ_PANE), FAILS, AD_ERROR_CLASS_ENVIRONMENT)],
    ['UNCLASSIFIED (a plain ErrInternal)', cell(() => errInternal(), FAILS, AD_ERROR_CLASS_UNCLASSIFIED)],
    ['UNCLASSIFIED (ErrSchemaMismatch)', cell(() => errSchemaMismatch(), FAILS, AD_ERROR_CLASS_UNCLASSIFIED)],
    ['UNCLASSIFIED (ErrSystemInstallDisappeared)', cell(() => errSystemInstallDisappeared(PRECHECK_CALL_READ_PANE), FAILS, AD_ERROR_CLASS_UNCLASSIFIED)],
    ['UNCLASSIFIED (ErrSpawnNotInteractive, a STATE name other than ErrSpawnNotFound)', cell(() => errSpawnNotInteractive(PRECHECK_CALL_READ_PANE), FAILS, AD_ERROR_CLASS_UNCLASSIFIED)],
    ...UNUSABLE_NAME_FAULTS.map((f) => [`UNUSABLE NAME (the unusable-name ErrInternal, ${f})`, cell(() => errUnusableName(f), FAILS, AD_ERROR_CLASS_UNUSABLE_NAME)] as const),
    ['CONFIG (ErrConfigMalformed)', cell(() => errConfigMalformed(), FAILS_AT_ONCE, AD_ERROR_CLASS_CONFIG)],
  ]

  test.each(forEachCommand(READ_PANE_CELLS))('%s: a live row whose one-line read-pane answers %s', async (command, _label, c, [, make, run]) => {
    const error = c.make()
    const b = make({ directorReadPane: async () => { throw error } })
    await run(b)
    expect(b.getCalls).toEqual([idOf(OPS_PERSONA)])
    expect(b.readPaneCalls).toEqual(opsPaneReads(c.outcome === RETRIED ? PRECHECK_TRIES : 1))
    if (c.outcome === PASSES) expectWentOn(b, command)
    else expectPrecheckFailed(b, command, [[OPS_PERSONA, PRECHECK_CALL_READ_PANE, error, c.shown!]])
    assertNoLeak({ stderr, consoleErrorArgs: errorSpy.mock.calls })
  })

  // A get's UNAVAILABLE is retried and its CONFIG fails at once; every other class fails with no retry and no
  // read-pane, a class SRJ-117 gives a get no meaning for reported as UNCLASSIFIED.
  const GET_CELLS: ReadonlyArray<readonly [string, Cell]> = [
    ...UNAVAILABLE_FORMS.map(([label, make]) => [`UNAVAILABLE (${label})`, cell(() => make(PRECHECK_CALL_GET), RETRIED, AD_ERROR_CLASS_UNAVAILABLE)] as const),
    ['CONFIG (ErrConfigMalformed)', cell(() => errConfigMalformed(), FAILS_AT_ONCE, AD_ERROR_CLASS_CONFIG)],
    ...UNUSABLE_NAME_FAULTS.map((f) => [`UNUSABLE NAME (the unusable-name ErrInternal, ${f})`, cell(() => errUnusableName(f), FAILS, AD_ERROR_CLASS_UNUSABLE_NAME)] as const),
    ['CONFLICT (ErrTmuxSessionConflict)', cell(() => errTmuxSessionConflict(PRECHECK_CALL_GET, 'unrecognised'), FAILS, AD_ERROR_CLASS_CONFLICT)],
    ['ENVIRONMENT (ErrTmuxNotAvailable)', cell(() => errTmuxNotAvailable(undefined, PRECHECK_CALL_GET), FAILS, AD_ERROR_CLASS_ENVIRONMENT)],
    ['UNCLASSIFIED (a plain ErrInternal)', cell(() => errInternal(), FAILS, AD_ERROR_CLASS_UNCLASSIFIED)],
    ['GONE (ErrTmuxCaptureFailed)', cell(() => errTmuxCaptureFailed(undefined, PRECHECK_CALL_GET), FAILS, AD_ERROR_CLASS_UNCLASSIFIED)],
    ['STATE (ErrSpawnNotInteractive)', cell(() => errSpawnNotInteractive(PRECHECK_CALL_GET), FAILS, AD_ERROR_CLASS_UNCLASSIFIED)],
    ['LAUNCH FAILURE (ErrTmuxSessionCreate)', cell(() => errTmuxSessionCreate(PRECHECK_CALL_GET), FAILS, AD_ERROR_CLASS_UNCLASSIFIED)],
    ['DIRECTORY (ErrCwdNotFound)', cell(() => errCwdNotFound(PRECHECK_CALL_GET), FAILS, AD_ERROR_CLASS_UNCLASSIFIED)],
  ]

  test.each(forEachCommand(GET_CELLS))('%s: a get answering %s, and no read-pane follows', async (command, _label, c, [, make, run]) => {
    const error = c.make()
    const b = make({ directorGet: async () => { throw error } })
    await run(b)
    expect(b.getCalls).toEqual(nOf(c.outcome === RETRIED ? PRECHECK_TRIES : 1, idOf(OPS_PERSONA)))
    expect(b.readPaneCalls).toEqual([])
    expectPrecheckFailed(b, command, [[OPS_PERSONA, PRECHECK_CALL_GET, error, c.shown!]])
    assertNoLeak({ stderr, consoleErrorArgs: errorSpy.mock.calls })
  })

  // -------------------------------------------------------------------------
  // Step 3: tries on the injected clock
  // -------------------------------------------------------------------------

  test.each(forEachCommand<PrecheckCall>([
    ['get', PRECHECK_CALL_GET],
    ['read-pane', PRECHECK_CALL_READ_PANE],
  ]))('%s: a %s answering UNAVAILABLE every time is called at t, t + gap and t + 2 gaps on the fake clock, never a fourth time; the persona is named and nothing is stopped (AC 74)', async (command, _label, call, [, make, run]) => {
    const error = errTmuxUnresponsive(call)
    const throwIt = async (): Promise<never> => { throw error }
    const b = make(call === PRECHECK_CALL_GET ? { directorGet: throwIt } : { directorReadPane: throwIt })
    await run(b)
    const times = b.directorCallTimes.filter(([c]) => c.startsWith(`${call}:`)).map(([, at]) => at)
    expect(times).toEqual(Array.from({ length: PRECHECK_TRIES }, (_, i) => i * PRECHECK_TRY_SPACING_MS))
    expect(b.exitTimes).toEqual([(PRECHECK_TRIES - 1) * PRECHECK_TRY_SPACING_MS])
    expectPrecheckFailed(b, command, [[OPS_PERSONA, call, error, AD_ERROR_CLASS_UNAVAILABLE]])
    assertNoLeak({ stderr, consoleErrorArgs: errorSpy.mock.calls })
  })

  test.each(forEachCommand<PrecheckCall>([
    ['get', PRECHECK_CALL_GET],
    ['read-pane', PRECHECK_CALL_READ_PANE],
  ]))('%s: a %s answering UNAVAILABLE, UNAVAILABLE, then its answer passes; only that call is repeated, and the command stops the server and tears down', async (command, _label, call, [, make, run]) => {
    let tries = 0
    const flaky = <T>(answer: T) => async (): Promise<T> => {
      if (++tries < PRECHECK_TRIES) throw errCallTimeout(call)
      return answer
    }
    let reads = 0
    const b = make({
      ...(call === PRECHECK_CALL_GET ? { directorGet: flaky<PrecheckRow | null>(LIVE_ROW) } : { directorReadPane: flaky(FAKE_PANE) }),
      directorStatus: async () => (++reads === 1 ? { state: 'waiting' } : { state: 'ended' }),
    })
    await run(b)
    const calls = (c: PrecheckCall): number => b.directorCallTimes.filter(([e]) => e.startsWith(`${c}:`)).length
    expect([calls(PRECHECK_CALL_GET), calls(PRECHECK_CALL_READ_PANE)]).toEqual(
      call === PRECHECK_CALL_GET ? [PRECHECK_TRIES, 1] : [1, PRECHECK_TRIES],
    )
    expectWentOn(b, command)
    expect(b.pauseCalls).toEqual([idOf(OPS_PERSONA)])
    assertNoLeak({ stderr, consoleErrorArgs: errorSpy.mock.calls })
  })

  // -------------------------------------------------------------------------
  // A failed precheck over several personas
  // -------------------------------------------------------------------------

  test.each(COMMANDS)('%s: of two personas only Beta fails (CONFLICT at its read-pane): only Beta is named, and Alpha is not torn down either', async (command, make, run) => {
    const error = errTmuxSessionConflict(PRECHECK_CALL_READ_PANE, 'not-this-launch', personaTmuxSessionName(BETA_PERSONA.key))
    const b = make({
      config: twoPersonas(),
      directorReadPane: async (id) => { if (id === idOf(BETA_PERSONA)) throw error; return FAKE_PANE },
      directorStatus: async () => ({ state: 'waiting' }),
    })
    await run(b)
    expectOnePrecheckEach(b, [idOf(ALPHA_PERSONA), idOf(BETA_PERSONA)])
    expectPrecheckFailed(b, command, [[BETA_PERSONA, PRECHECK_CALL_READ_PANE, error, AD_ERROR_CLASS_CONFLICT]])
    assertNoLeak({ stderr, consoleErrorArgs: errorSpy.mock.calls })
  })

  test.each(COMMANDS)('%s: both personas fail: one line each in configuration order (Alpha, whose tries end last, first), then one closing line', async (command, make, run) => {
    const alphaError = errTmuxUnresponsive(PRECHECK_CALL_READ_PANE)
    const betaError = errUnusableName()
    const b = make({
      config: twoPersonas(),
      directorGet: async (id) => { if (id === idOf(BETA_PERSONA)) throw betaError; return LIVE_ROW },
      directorReadPane: async () => { throw alphaError },
    })
    await run(b)
    expectPrecheckFailed(b, command, [
      [ALPHA_PERSONA, PRECHECK_CALL_READ_PANE, alphaError, AD_ERROR_CLASS_UNAVAILABLE],
      [BETA_PERSONA, PRECHECK_CALL_GET, betaError, AD_ERROR_CLASS_UNUSABLE_NAME],
    ])
    assertNoLeak({ stderr, consoleErrorArgs: errorSpy.mock.calls })
  })

  test.each(COMMANDS)('%s: CONFIG at Alpha\'s get fails only Alpha, at once, and Beta is still checked: Alpha gets one get and no read-pane, Beta its get and its one-line read-pane (CONFLICT); two lines in configuration order, Alpha\'s naming the agent-director config file, then one closing line', async (command, make, run) => {
    const alphaError = errConfigMalformed()
    const betaError = errTmuxSessionConflict(PRECHECK_CALL_READ_PANE, 'not-this-launch', personaTmuxSessionName(BETA_PERSONA.key))
    const b = make({
      config: twoPersonas(),
      directorGet: async (id) => { if (id === idOf(ALPHA_PERSONA)) throw alphaError; return LIVE_ROW },
      directorReadPane: async (id) => { if (id === idOf(BETA_PERSONA)) throw betaError; return FAKE_PANE },
    })
    await run(b)
    expect([...b.getCalls].sort()).toEqual([idOf(ALPHA_PERSONA), idOf(BETA_PERSONA)].sort())
    expect(b.readPaneCalls).toEqual([[idOf(BETA_PERSONA), PROBE_PANE_READ_LINES]])
    expectPrecheckFailed(b, command, [
      [ALPHA_PERSONA, PRECHECK_CALL_GET, alphaError, AD_ERROR_CLASS_CONFIG],
      [BETA_PERSONA, PRECHECK_CALL_READ_PANE, betaError, AD_ERROR_CLASS_CONFLICT],
    ])
    expect(stderr[0]).toContain(AD_CONFIG_FILE_DISPLAY_NAME)
    assertNoLeak({ stderr, consoleErrorArgs: errorSpy.mock.calls })
  })

  // -------------------------------------------------------------------------
  // Where the lines go, redaction and no side effects
  // -------------------------------------------------------------------------

  test.each(COMMANDS)('%s: the precheck lines are printed only: once each on the terminal, for clean_restart also once each in clean_restart.log, and no file is written (no server.log, no startup-errors.log)', async (command, make, run) => {
    const log: string[] = []
    const error = errTmuxSessionConflict(PRECHECK_CALL_READ_PANE, 'leftover', personaTmuxSessionName(OPS_PERSONA.key))
    const b = make({ directorReadPane: async () => { throw error }, initLogging: redirectTo(log) })
    const before = snapshotTree()
    await run(b)
    const lines = [precheckFailureLine(command, OPS_PERSONA, failureOf(PRECHECK_CALL_READ_PANE, error)), precheckNothingStoppedLine(command)]
    expect(stderr).toEqual(lines)
    if (command === CLI_COMMAND_CLEAN_RESTART) {
      for (const line of lines) expect(log.filter((l) => l === line)).toHaveLength(1)
    } else {
      expect(log).toEqual([])
    }
    expect(snapshotTree()).toEqual(before)
    assertNoLeak({ stderr, log })
  })

  test.each(COMMANDS)('%s: a CONFLICT and an UNCLASSIFIED description carrying fake tokens render redacted; nothing printed leaks', async (command, make, run) => {
    const conflict = errGeneric(PRECHECK_CALL_READ_PANE, ERR_TMUX_SESSION_CONFLICT_NAME, `session refused (${sentinelInMessage('conflict')})`)
    const unclassified = errGeneric(PRECHECK_CALL_READ_PANE, 'ErrNoHandlingInCscb', `refused (${sentinelInMessage('unclassified', APP_TOKEN_PREFIX)})`)
    const b = make({
      config: twoPersonas(),
      directorReadPane: async (id) => { throw id === idOf(ALPHA_PERSONA) ? conflict : unclassified },
    })
    await run(b)
    expectPrecheckFailed(b, command, [
      [ALPHA_PERSONA, PRECHECK_CALL_READ_PANE, conflict, AD_ERROR_CLASS_CONFLICT],
      [BETA_PERSONA, PRECHECK_CALL_READ_PANE, unclassified, AD_ERROR_CLASS_UNCLASSIFIED],
    ])
    expect(stderr.slice(0, 2).every((l) => l.includes(REDACTED_SENTINEL_TAIL))).toBe(true)
    assertNoLeak({ stderr, consoleErrorArgs: errorSpy.mock.calls })
  })

  // SRJ-114, SRJ-115, SRJ-801: the precheck latches nothing, writes no record and never clears a retired-key entry.
  test.each(forEachCommand<Overrides>([
    [`a live row carrying the ${provenanceNote} note (passes)`, { directorGet: async () => ({ state: 'waiting', liveness_note: provenanceNote }) }],
    ['a pending row with no launch start (passes)', { directorGet: async () => ({ state: AGENT_DIRECTOR_PENDING_STATE }) }],
    ['a CONFLICT at the read-pane (fails)', { directorReadPane: async () => { throw errTmuxSessionConflict(PRECHECK_CALL_READ_PANE, 'conflicting-labels') } }],
    ['an UNUSABLE NAME at the get (fails)', { directorGet: async () => { throw errUnusableName('control-character') } }],
  ]))('%s: after %s the state directory is unchanged and the seeded retired-key record byte-identical', async (_command, _label, o, [, make, run]) => {
    writeRetiredKeysRecord(stateDir, { [OPS_PERSONA.key]: { cause: RETIRED_KEY_CAUSE_DESTRUCTIVE_MODIFY, mark: true } })
    const b = make(o)
    const before = snapshotTree() // after make, so the PID file is in it
    await run(b)
    expect(b.getCalls).toEqual([idOf(OPS_PERSONA)])
    expect(snapshotTree()).toEqual(before)
    assertNoLeak({ stderr, consoleErrorArgs: errorSpy.mock.calls })
  })

  // The CLI's clock is pinned under the kill's describe (Date.now and setTimeout only in realDeps) and its tries
  // under callWithCliTries.
  test('src/cli.ts imports nothing from the session manager, the conflict latch or the retired-key record module (static)', () => {
    const code = stripComments(readFileSync(CLI_SOURCE, 'utf-8'))
    const banned = ['./session-manager.ts', './conflict-latch.ts', './retired-keys.ts']
    expect(importedSpecifiers(code).filter((s) => banned.includes(s))).toEqual([])
  })

  // SRJ-613 (E19 note): a pane passes the precheck but proves nothing; the teardown's own calls are the backstop.
  test.each(COMMANDS)('%s: after a precheck whose read-pane answered a pane, the server is stopped and the teardown still makes its own status, pause and kill; a kill answering CONFLICT "not this launch\'s session" fails the teardown (exit 1) with its line naming the session, and latches nothing', async (command, make, run) => {
    const conflict = errTmuxSessionConflict('kill', 'not-this-launch', personaTmuxSessionName(OPS_PERSONA.key))
    const b = make({
      config: opsConfig({ exit_timeout: 0 }),
      directorStatus: async () => ({ state: 'waiting' }),
      directorKill: async () => { throw conflict },
    })
    const before = snapshotTreeExceptTeardownLogs()
    await run(b)
    expect(b.readPaneCalls).toEqual(opsPaneReads(1))
    expect([b.statusCalls, b.pauseCalls, b.killCalls]).toEqual([[idOf(OPS_PERSONA)], [idOf(OPS_PERSONA)], [idOf(OPS_PERSONA)]])
    // stop --stop-bots stays stopped; clean_restart, agent-director answering, starts the server again (b.jg5 SRJ-905, SRJ-906).
    expectTeardownFailed(b, command, [failedReport(command, OPS_PERSONA, conflict, AD_ERROR_CLASS_CONFLICT)])
    expect(snapshotTreeExceptTeardownLogs()).toEqual(before)
    assertNoLeak({ stderr, consoleErrorArgs: errorSpy.mock.calls })
  })
})

// ---------------------------------------------------------------------------
// The teardown's pause by class (b.jg5 SRJ-903, SRJ-119; AC 73's and AC 4's
// unit halves; hatch note E12)
//
// After a passed precheck and the server stop, each persona's teardown reads
// its row, then pauses a live row and decides the pause's answer by class:
// GONE and every other answer escalate to one kill; UNAVAILABLE is tried
// PRECHECK_TRIES times PRECHECK_TRY_SPACING_MS apart on the fake clock, with
// no status read between, then escalates; CONFLICT, ENVIRONMENT, UNUSABLE
// NAME, another ErrInternal and CONFIG fail the persona at once with no kill.
// The verdict per answer is tests/cli-teardown.test.ts's; here each class's
// calls, times, exit and report: a failed pause gives its failure line alone
// (no kill-failure alert), recorded under `cli-teardown-failed`, then the
// last line (b.jg5 SRJ-907, SRJ-909).
// ---------------------------------------------------------------------------

/** A `status` row: the fixture's `directorStatus` answer. */
type StatusRow = { readonly state: string }
const WAITING_ROW: StatusRow = Object.freeze({ state: 'waiting' })
const ENDED_ROW: StatusRow = Object.freeze({ state: 'ended' })

/**
 * Every persona was stopped: `stop --stop-bots` stopped the server and exits
 * 0; `clean_restart` spawned the stop and then the start. Neither took the
 * failure path: no answer-check `list` and no `clean-restart-not-restarted`
 * entry. The report is `reports` alone: none by default, so no line is
 * printed and neither log file is written; a persona stopped with the
 * survivor version has its survivor report and counts as stopped (b.jg5
 * SRJ-904, SRJ-905, SRJ-906; AC 64).
 */
function expectTeardownStopped(b: Bundle, command: CliTeardownCommand, reports: readonly ExpectedReport[] = [], to: ReportDestinations = {}): void {
  expect(listTimesOf(b)).toEqual([])
  if (command === CLI_COMMAND_STOP_BOTS) {
    expect(b.serverSignals).toEqual(['SIGTERM'])
    expect(b.exitCodes).toEqual([0])
  } else {
    expect(b.spawnCalls.map((c) => c.args.at(-1))).toEqual(['stop', 'start'])
    expect(b.exitCodes).toEqual([])
  }
  expect(reports.filter((r) => r.failed)).toEqual([])
  if (reports.length === 0) expect([existsSync(logPath), existsSync(startupErrorsPath())]).toEqual([false, false])
  expectReported(b, command, reports, to)
}

/**
 * At least one persona failed: exit 1 after the server stop, and the report
 * is exactly `reports`, in configuration order, then the last line (b.jg5
 * SRJ-905, SRJ-906, SRJ-907, SRJ-909). `stop --stop-bots` spawns no start and
 * makes no `list`, so the server stays stopped; `clean_restart`, whose
 * fixture `list` answers by default, restarts the server
 * ({@link expectRestarted}) and records no `clean-restart-not-restarted`
 * entry.
 */
function expectTeardownFailed(b: Bundle, command: CliTeardownCommand, reports: readonly ExpectedReport[], to: ReportDestinations = {}): void {
  expect(b.exitCodes).toEqual([1])
  if (command === CLI_COMMAND_STOP_BOTS) {
    expect(b.serverSignals).toEqual(['SIGTERM'])
    expect(b.spawnCalls).toEqual([])
    expect(listTimesOf(b)).toEqual([])
  } else {
    expectRestarted(b)
  }
  expect(reports.some((r) => r.failed)).toBe(true)
  expectReported(b, command, reports, to)
}

/** A pause answer: its builder, what the teardown does with it and the class the classifier gives it. */
type PauseClassCase = readonly [make: () => unknown, outcome: typeof PAUSE_VERDICT_ESCALATE | typeof PAUSE_VERDICT_RETRY | typeof PAUSE_VERDICT_FAIL, errorClass: AdErrorClass]

const PAUSE_VERB = 'pause'

/** SRJ-903's table at the pause, one row per class or form. */
const PAUSE_CLASS_ROWS: ReadonlyArray<readonly [string, PauseClassCase]> = [
  ['GONE (ErrTmuxSendKeys)', [() => errTmuxSendKeys(), PAUSE_VERDICT_ESCALATE, AD_ERROR_CLASS_GONE]],
  ...UNAVAILABLE_FORMS.map(([label, make]) => [`UNAVAILABLE (${label})`, [() => make(PAUSE_VERB), PAUSE_VERDICT_RETRY, AD_ERROR_CLASS_UNAVAILABLE]] as const),
  ...CONFLICT_CASES.map((c) => [`CONFLICT (${c})`, [() => errTmuxSessionConflict(PAUSE_VERB, c), PAUSE_VERDICT_FAIL, AD_ERROR_CLASS_CONFLICT]] as const),
  ['ENVIRONMENT (ErrTmuxNotAvailable, tmux not runnable)', [() => errTmuxNotAvailable(undefined, PAUSE_VERB), PAUSE_VERDICT_FAIL, AD_ERROR_CLASS_ENVIRONMENT]],
  ['ENVIRONMENT (ErrTmuxNotAvailable, socket not accessible)', [() => errTmuxNotAvailable(STUB_TMUX_SOCKET_PATH, PAUSE_VERB), PAUSE_VERDICT_FAIL, AD_ERROR_CLASS_ENVIRONMENT]],
  ['ENVIRONMENT (ErrTmuxNotAvailable, a different tmux server)', [() => errTmuxNotAvailableDifferentServer(STUB_TMUX_SOCKET_PATH, PAUSE_VERB), PAUSE_VERDICT_FAIL, AD_ERROR_CLASS_ENVIRONMENT]],
  ...UNUSABLE_NAME_FAULTS.map((f) => [`UNUSABLE NAME (the unusable-name ErrInternal, ${f})`, [() => errUnusableName(f), PAUSE_VERDICT_FAIL, AD_ERROR_CLASS_UNUSABLE_NAME]] as const),
  ['another ErrInternal (a plain ErrInternal, UNCLASSIFIED)', [() => errInternal(), PAUSE_VERDICT_FAIL, AD_ERROR_CLASS_UNCLASSIFIED]],
  ['CONFIG (ErrConfigMalformed)', [() => errConfigMalformed(), PAUSE_VERDICT_FAIL, AD_ERROR_CLASS_CONFIG]],
  ['ErrPauseTimeout (UNCLASSIFIED)', [() => errPauseTimeout(), PAUSE_VERDICT_ESCALATE, AD_ERROR_CLASS_UNCLASSIFIED]],
  [`${ERR_SCHEMA_MISMATCH_NAME} (a store name)`, [() => errSchemaMismatch(), PAUSE_VERDICT_ESCALATE, AD_ERROR_CLASS_UNCLASSIFIED]],
  ...STORE_OPEN_ERR_NAMES.filter((name) => name !== ERR_SCHEMA_MISMATCH_NAME)
    .map((name) => [`${name} (a store name)`, [() => errUnknownErrorName(name), PAUSE_VERDICT_ESCALATE, AD_ERROR_CLASS_UNCLASSIFIED]] as const),
  ['ErrSystemInstallDisappeared (UNCLASSIFIED)', [() => errSystemInstallDisappeared(PAUSE_VERB), PAUSE_VERDICT_ESCALATE, AD_ERROR_CLASS_UNCLASSIFIED]],
  ['ErrRelayModeOff (another UNCLASSIFIED name)', [() => errRelayModeOff(), PAUSE_VERDICT_ESCALATE, AD_ERROR_CLASS_UNCLASSIFIED]],
  ['STATE (ErrSpawnNotFound)', [() => errSpawnNotFound(), PAUSE_VERDICT_ESCALATE, AD_ERROR_CLASS_STATE]],
  ['STATE (ErrSpawnNotPausable)', [() => errSpawnNotPausable(PAUSE_VERB), PAUSE_VERDICT_ESCALATE, AD_ERROR_CLASS_STATE]],
  ['LAUNCH FAILURE (ErrTmuxSessionCreate)', [() => errTmuxSessionCreate(PAUSE_VERB), PAUSE_VERDICT_ESCALATE, AD_ERROR_CLASS_LAUNCH_FAILURE]],
  ['DIRECTORY (ErrCwdNotFound)', [() => errCwdNotFound(PAUSE_VERB), PAUSE_VERDICT_ESCALATE, AD_ERROR_CLASS_DIRECTORY]],
]

describe('the teardown\'s pause by class (b.jg5 SRJ-903, SRJ-119; AC 73, AC 4)', () => {
  const alphaId = (): string => personaInstanceId(personaKey(ALPHA.name))
  const betaId = (): string => personaInstanceId(personaKey(BETA.name))

  test.each(forEachCommand(PAUSE_CLASS_ROWS))('%s: a live row whose pause answers %s', async (command, _label, [make, outcome, errorClass], [, mk, run]) => {
    const error = make()
    const b = mk({ directorStatus: async () => WAITING_ROW, directorPause: async () => { throw error } })

    await run(b)

    const pauses = callTimesOf(b, 'pause')
    const kills = callTimesOf(b, 'kill')
    // One state read before the pause; no read between pause tries and no poll after a failed pause.
    expect(b.statusCalls).toEqual([opsId()])
    if (outcome === PAUSE_VERDICT_FAIL) {
      expect([pauses.length, kills]).toEqual([1, []])
      // A failed pause carries no kill-failure alert: its line alone, under cli-teardown-failed (b.jg5 SRJ-907, SRJ-909).
      expectTeardownFailed(b, command, [failedReport(command, OPS_PERSONA, error, errorClass)])
    } else {
      // UNAVAILABLE: exactly PRECHECK_TRIES pauses at t, t + gap, t + 2 gaps; then, like every escalation, one kill at once.
      const tries = outcome === PAUSE_VERDICT_RETRY ? PRECHECK_TRIES : 1
      expect(pauses).toEqual(Array.from({ length: tries }, (_, i) => pauses[0]! + i * PRECHECK_TRY_SPACING_MS))
      expect(kills).toEqual([pauses.at(-1)!])
      expectTeardownStopped(b, command)
    }
    assertNoLeak({ stderr, consoleErrorArgs: errorSpy.mock.calls })
  })

  test('the rows reach every class and every pause outcome', () => {
    expect(new Set(PAUSE_CLASS_ROWS.map(([, [, outcome]]) => outcome))).toEqual(new Set([PAUSE_VERDICT_ESCALATE, PAUSE_VERDICT_RETRY, PAUSE_VERDICT_FAIL]))
    expect(new Set(PAUSE_CLASS_ROWS.map(([, [, , errorClass]]) => errorClass))).toEqual(new Set([
      AD_ERROR_CLASS_GONE, AD_ERROR_CLASS_UNAVAILABLE, AD_ERROR_CLASS_CONFLICT, AD_ERROR_CLASS_UNUSABLE_NAME, AD_ERROR_CLASS_CONFIG,
      AD_ERROR_CLASS_ENVIRONMENT, AD_ERROR_CLASS_LAUNCH_FAILURE, AD_ERROR_CLASS_STATE, AD_ERROR_CLASS_DIRECTORY, AD_ERROR_CLASS_UNCLASSIFIED,
    ]))
  })

  test.each(COMMANDS)('%s: a pause answering UNAVAILABLE and then success goes on to the poll, PRECHECK_TRY_SPACING_MS later; a poll reading ended ends the teardown with no kill', async (command, make, run) => {
    const b = make({
      directorStatus: scripted(WAITING_ROW, ENDED_ROW),
      directorPause: scripted<void>(thrown(errTmuxUnresponsive(PAUSE_VERB)), undefined),
    })

    await run(b)

    const pauses = callTimesOf(b, 'pause')
    expect(pauses).toEqual([pauses[0]!, pauses[0]! + PRECHECK_TRY_SPACING_MS])
    expect(callTimesOf(b, 'status')).toEqual([pauses[0]!, pauses[1]! + TEARDOWN_POLL_FIRST_WAIT_MS])
    expect(b.killCalls).toEqual([])
    expectTeardownStopped(b, command)
    assertNoLeak({ stderr, consoleErrorArgs: errorSpy.mock.calls })
  })

  // AC 4's unit half: a launch in progress cannot be paused, and the kill ends it.
  test.each(COMMANDS)('%s: AC 4: a persona pending at its dialog: the state read finds pending, the pause answers ErrSpawnNotPausable and the kill succeeds: one pause, one kill, every persona stopped (clean_restart goes on to its start)', async (command, make, run) => {
    const pending = { state: AGENT_DIRECTOR_PENDING_STATE }
    const b = make({
      directorGet: async () => pending,
      directorStatus: async () => pending,
      directorPause: async () => { throw errSpawnNotPausable(PAUSE_VERB) },
    })

    await run(b)

    expect([b.statusCalls, b.pauseCalls, b.killCalls]).toEqual([[opsId()], [opsId()], [opsId()]])
    expectTeardownStopped(b, command)
    assertNoLeak({ stderr, consoleErrorArgs: errorSpy.mock.calls })
  })

  test.each(COMMANDS)('%s: of two personas, Alpha\'s pause answers CONFLICT: Alpha fails with no kill, and Beta is still paused and torn down', async (command, make, run) => {
    const conflict = errTmuxSessionConflict(PAUSE_VERB, 'leftover', personaTmuxSessionName(personaKey(ALPHA.name)))
    const betaReads = scripted(WAITING_ROW, ENDED_ROW)
    const b = make({
      config: twoPersonas(),
      directorStatus: async (id) => (id === betaId() ? betaReads() : WAITING_ROW),
      directorPause: async (id) => { if (id === alphaId()) throw conflict },
    })

    await run(b)

    expect([...b.pauseCalls].sort()).toEqual([alphaId(), betaId()].sort())
    expect(b.killCalls).toEqual([])
    expect(callTimesOf(b, 'status', betaId())).toHaveLength(2) // the state read, then a poll read of ended
    expectTeardownFailed(b, command, [failedReport(command, personaOf(ALPHA.name), conflict, AD_ERROR_CLASS_CONFLICT)])
    assertNoLeak({ stderr, consoleErrorArgs: errorSpy.mock.calls })
  })

  // E32's SRJ-613 backstop, pause leg: a pane passes the precheck but proves nothing; the pause answers CONFLICT.
  test.each(COMMANDS)('%s: after a precheck whose read-pane answered a pane, a pause answering CONFLICT "not this launch\'s session" fails that persona with no kill; exit 1, nothing is latched, and nothing is written but its server.log line and startup-errors entry', async (command, make, run) => {
    const conflict = errTmuxSessionConflict(PAUSE_VERB, 'not-this-launch', personaTmuxSessionName(personaKey(OPS_NAME)))
    const b = make({ directorStatus: async () => WAITING_ROW, directorPause: async () => { throw conflict } })
    const before = snapshotTreeExceptTeardownLogs()

    await run(b)

    expect(b.readPaneCalls).toEqual([[opsId(), PROBE_PANE_READ_LINES]])
    expect([b.statusCalls, b.pauseCalls, b.killCalls]).toEqual([[opsId()], [opsId()], []])
    expectTeardownFailed(b, command, [failedReport(command, OPS_PERSONA, conflict, AD_ERROR_CLASS_CONFLICT)])
    expect(snapshotTreeExceptTeardownLogs()).toEqual(before)
    assertNoLeak({ stderr, consoleErrorArgs: errorSpy.mock.calls })
  })
})

// ---------------------------------------------------------------------------
// The teardown's state read and poll (b.jg5 SRJ-903, SRJ-908; hatch note E24)
//
// After a successful pause the teardown reads the row on the injected clock,
// the first wait TEARDOWN_POLL_FIRST_WAIT_MS, each later one doubled up to
// TEARDOWN_POLL_MAX_WAIT_MS, the last cut short at exit_timeout, until the
// row is ended, missing or absent; at exit_timeout it kills, and never later.
// The state read before the pause and every poll read fail the persona at
// once on any error but ErrSpawnNotFound, with no retry. The poll reads and
// writes no record and never clears a retired-key entry (SRJ-801).
// ---------------------------------------------------------------------------

describe('the teardown\'s state read and poll on the injected clock (b.jg5 SRJ-903, SRJ-908; hatch note E24)', () => {
  /** The poll's read times after a pause at `pausedAt` with `exitTimeoutS`: the doubling waits, the last cut short at the deadline. */
  function pollReadTimes(pausedAt: number, exitTimeoutS: number): number[] {
    const deadline = pausedAt + exitTimeoutMsOf(exitTimeoutS)
    const times: number[] = []
    let at = pausedAt
    let wait = TEARDOWN_POLL_FIRST_WAIT_MS
    while (at < deadline) {
      at += Math.min(wait, deadline - at)
      times.push(at)
      wait = Math.min(wait * 2, TEARDOWN_POLL_MAX_WAIT_MS)
    }
    return times
  }

  /** exit_timeout values (s): none (the kill at once), one whose waits never reach the maximum, and one that reaches it and is cut short. */
  const EXIT_TIMEOUTS = [0, 1, 10] as const

  test('precondition: the middle exit_timeout\'s waits stay below TEARDOWN_POLL_MAX_WAIT_MS; the longest one\'s reach it and the last is cut short', () => {
    const gapsOf = (exitTimeoutS: number): number[] =>
      pollReadTimes(0, exitTimeoutS).map((at, i, all) => at - (i === 0 ? 0 : all[i - 1]!))
    expect(Math.max(...gapsOf(EXIT_TIMEOUTS[1]))).toBeLessThan(TEARDOWN_POLL_MAX_WAIT_MS)
    const longest = gapsOf(EXIT_TIMEOUTS[2])
    expect(longest).toContain(TEARDOWN_POLL_MAX_WAIT_MS)
    expect(longest.at(-1)!).toBeLessThan(TEARDOWN_POLL_MAX_WAIT_MS)
  })

  test.each(forEachCommand(EXIT_TIMEOUTS.map((s) => [`exit_timeout ${s} s`, s] as const)))('%s: %s, every poll read waiting: the reads follow the doubling schedule, none waits past exit_timeout, and the one kill is made at exit_timeout, never later', async (command, _label, exitTimeoutS, [, make, run]) => {
    const b = make({ config: opsConfig({ exit_timeout: exitTimeoutS }), directorStatus: async () => WAITING_ROW })

    await run(b)

    const [pausedAt] = callTimesOf(b, 'pause')
    const deadline = pausedAt! + exitTimeoutMsOf(exitTimeoutS)
    expect(callTimesOf(b, 'pause')).toHaveLength(1)
    expect(callTimesOf(b, 'status').slice(1)).toEqual(pollReadTimes(pausedAt!, exitTimeoutS))
    expect(callTimesOf(b, 'kill')).toEqual([deadline])
    expect(b.directorCallTimes.filter(([, at]) => at > deadline)).toEqual([])
    expectTeardownStopped(b, command)
    assertNoLeak({ stderr, consoleErrorArgs: errorSpy.mock.calls })
  })

  test.each(forEachCommand<{ state: string } | null | Thrown>([
    ...[...AGENT_DIRECTOR_DEAD_STATES].map((state) => [`a ${state} row`, { state }] as const),
    ['no row (null)', null],
    ['no row (ErrSpawnNotFound thrown)', thrown(errSpawnNotFound())],
  ]))('%s: a poll read finding %s ends the teardown as stopped, with no kill (b.4dk: both commands share one teardown)', async (command, _label, answer, [, make, run]) => {
    const b = make({ directorStatus: scripted<{ state: string } | null>(WAITING_ROW, answer) })

    await run(b)

    const [pausedAt] = callTimesOf(b, 'pause')
    expect(callTimesOf(b, 'status')).toEqual([pausedAt!, pausedAt! + TEARDOWN_POLL_FIRST_WAIT_MS])
    expect(b.killCalls).toEqual([])
    expectTeardownStopped(b, command)
    assertNoLeak({ stderr, consoleErrorArgs: errorSpy.mock.calls })
  })

  /** A `status` read's errors: each fails the persona at once with its class, never retried. */
  const STATUS_ERROR_ROWS: ReadonlyArray<readonly [string, readonly [make: () => unknown, errorClass: AdErrorClass]]> = [
    ['UNAVAILABLE (ErrCallTimeout)', [() => errCallTimeout('status'), AD_ERROR_CLASS_UNAVAILABLE]],
    ['UNAVAILABLE (a plain Error: agent-director unreachable)', [() => new Error('AD connection refused'), AD_ERROR_CLASS_UNAVAILABLE]],
    ['CONFIG (ErrConfigMalformed)', [() => errConfigMalformed(), AD_ERROR_CLASS_CONFIG]],
    ['CONFLICT (ErrTmuxSessionConflict)', [() => errTmuxSessionConflict('status', 'unrecognised'), AD_ERROR_CLASS_CONFLICT]],
    ['UNUSABLE NAME (the unusable-name ErrInternal)', [() => errUnusableName(), AD_ERROR_CLASS_UNUSABLE_NAME]],
    ['UNCLASSIFIED (a plain ErrInternal)', [() => errInternal(), AD_ERROR_CLASS_UNCLASSIFIED]],
    [`UNCLASSIFIED (${ERR_SCHEMA_MISMATCH_NAME})`, [() => errSchemaMismatch(), AD_ERROR_CLASS_UNCLASSIFIED]],
  ]

  test.each(forEachCommand(STATUS_ERROR_ROWS))('%s: the state read before the pause answering %s fails the persona at once: one read, no pause, no kill', async (command, _label, [makeError, errorClass], [, make, run]) => {
    const error = makeError()
    const b = make({ directorStatus: async () => { throw error } })

    await run(b)

    expect([b.statusCalls, b.pauseCalls, b.killCalls]).toEqual([[opsId()], [], []])
    expectTeardownFailed(b, command, [failedReport(command, OPS_PERSONA, error, errorClass)])
    assertNoLeak({ stderr, consoleErrorArgs: errorSpy.mock.calls })
  })

  test.each(forEachCommand(STATUS_ERROR_ROWS))('%s: a poll read answering %s fails the persona at once: no further read and no kill', async (command, _label, [makeError, errorClass], [, make, run]) => {
    const error = makeError()
    const b = make({ directorStatus: scripted<{ state: string }>(WAITING_ROW, thrown(error)) })

    await run(b)

    expect([b.statusCalls, b.pauseCalls, b.killCalls]).toEqual([[opsId(), opsId()], [opsId()], []])
    expectTeardownFailed(b, command, [failedReport(command, OPS_PERSONA, error, errorClass)])
    assertNoLeak({ stderr, consoleErrorArgs: errorSpy.mock.calls })
  })

  // Hatch note E24: the poll is an SRJ-115 site; the CLI never writes retired-keys.json (SRJ-801).
  test.each(forEachCommand([
    ['a seeded retired-key record whose marked key is the persona\'s', true],
    ['no retired-key record', false],
  ] as const))('%s: a teardown whose reads go waiting then ended, with %s: the record is left byte-identical (or none is created) and the state directory is unchanged', async (command, _label, seeded, [, make, run]) => {
    if (seeded) writeRetiredKeysRecord(stateDir, { [personaKey(OPS_NAME)]: { cause: RETIRED_KEY_CAUSE_DESTRUCTIVE_MODIFY, mark: true } })
    const b = make({ directorStatus: scripted(WAITING_ROW, ENDED_ROW) })
    const before = snapshotTree() // after make, so the PID file is in it

    await run(b)

    expect([b.statusCalls, b.pauseCalls, b.killCalls]).toEqual([[opsId(), opsId()], [opsId()], []])
    expectTeardownStopped(b, command)
    expect(existsSync(retiredKeysPath(stateDir))).toBe(seeded)
    expect(snapshotTree()).toEqual(before)
    assertNoLeak({ stderr, consoleErrorArgs: errorSpy.mock.calls })
  })
})

// ---------------------------------------------------------------------------
// The teardown's kill by class (b.jg5 SRJ-904, SRJ-702, SRJ-110; AC 64, AC 73,
// AC 77; hatch notes E12, E16, E20, E24, E32)
//
// After an escalated pause, or at exit_timeout after a successful pause, the
// teardown makes the bounded retry of checked kills on the injected clock: a
// success (either kill_sent, none, ErrSpawnNotFound) stops the persona after
// one kill; UNAVAILABLE is tried KILL_RETRY_TRIES times KILL_RETRY_SPACING_MS
// apart with one status read before each further try; every other answer
// fails the persona at once with the classifier's class, GONE and the other
// unlisted answers included, a CONFIG one naming the config file; a read of
// ended, missing or no row stops the persona with no further kill; a CONFIG
// read fails it with no further kill; any other read, UNUSABLE NAME and a
// pending row with no launch start included, lets the next try go ahead and
// latches nothing. Each try is the checked kill under TEARDOWN_KILL_OPTIONS,
// so a GONE answer is a non-success the retry logs as such and never tries
// again; after a survivor-naming try its end line carries alert=ordinary. The
// mapping of each retry result is tests/cli-teardown.test.ts's. Each case
// checks the persona's report (b.jg5 SRJ-907, SRJ-909): a failure line, then
// the kill-failure alert's ordinary version exactly after an ErrTmuxKillFailed
// that stands or any failure after a survivor-naming try (GONE included),
// quoting the descriptions the retry's decision carries; or, for a persona
// stopped after a survivor-naming try, the survivor version alone, the
// persona counting as stopped (AC 64).
// ---------------------------------------------------------------------------

const KILL_VERB = 'kill'
const STATUS_VERB = 'status'

/** The Ops persona's tmux session, which a CONFLICT answer names (HO C4 Verify). */
const opsSession = (): string => personaTmuxSessionName(personaKey(OPS_NAME))

/** One kill case: the kill's answers and the reads' answers in call order, and what the teardown does. */
interface KillCase {
  /** Each kill's answer in call order, the last repeating; a {@link thrown} answer is thrown. */
  readonly kills: ReadonlyArray<unknown>
  /** Each status read between tries, in call order, the last repeating; default {@link WAITING_ROW}. */
  readonly reads?: ReadonlyArray<StatusRow | null | Thrown>
  /** What every status read before the first kill finds; default {@link WAITING_ROW}. */
  readonly row?: StatusRow
  /** Kills made, then status reads made between them. */
  readonly calls: readonly [kills: number, reads: number]
  /** null: the persona is stopped; else the value it fails with at the kill and the class it is reported under. */
  readonly fails: null | readonly [error: unknown, errorClass: AdErrorClass]
  /** Text the failure line must also carry (the session a CONFLICT names, a store name). */
  readonly names?: readonly string[]
  /** A failed persona's ordinary kill-failure alert: the descriptions it quotes; absent, no alert follows the line. */
  readonly alert?: KillFailureOrdinaryQuotes
  /** A stopped persona's survivor version: the survivor-naming description it quotes; absent, nothing is reported. */
  readonly survivor?: string
}

const stops = (kills: ReadonlyArray<unknown>, calls: KillCase['calls'], reads?: KillCase['reads']): KillCase =>
  ({ kills, calls, fails: null, ...(reads === undefined ? {} : { reads }) })

/** {@link stops} after a survivor-naming first try: the survivor version quoting its description is reported. */
const stopsWithSurvivor = (kills: ReadonlyArray<unknown>, calls: KillCase['calls'], reads?: KillCase['reads']): KillCase =>
  ({ ...stops(kills, calls, reads), survivor: teardownKillFailedDescription(survivorKillFailed()) })

/** A failure after a survivor-naming first try: the ordinary version quoting the survivor-naming description follows the line. */
const failsAfterSurvivor = (kills: ReadonlyArray<unknown>, calls: KillCase['calls'], error: unknown, errorClass: AdErrorClass, reads?: KillCase['reads']): KillCase => ({
  kills: [thrown(survivorKillFailed()), ...kills],
  calls,
  fails: [error, errorClass],
  alert: { earlierSurvivorDescription: teardownKillFailedDescription(survivorKillFailed()) },
  ...(reads === undefined ? {} : { reads }),
})

/**
 * Overrides that reach the kill along `path` and answer `kc`: every status
 * read before the first kill finds `kc.row`, each read after it takes the
 * next of `kc.reads`, and each kill the next of `kc.kills`.
 */
function killCaseOverrides(path: Overrides, kc: KillCase): Overrides {
  let kills = 0
  const killAnswer = scripted<unknown>(...kc.kills)
  const readAnswer = scripted<StatusRow | null>(...(kc.reads ?? [WAITING_ROW]))
  return {
    ...path,
    directorStatus: async () => (kills === 0 ? (kc.row ?? WAITING_ROW) : readAnswer()),
    directorKill: async () => {
      kills++
      return killAnswer()
    },
  }
}

/**
 * From the first kill on, the director calls of the Ops persona are `kills`
 * kills with one status read between each pair (and, when the reads ended
 * the tries, one after the last), each kill KILL_RETRY_SPACING_MS after the
 * one before and each read at the time of the try it comes before; never
 * more than KILL_RETRY_TRIES kills.
 */
function expectKillTries(b: Bundle, [kills, reads]: KillCase['calls']): void {
  const calls = b.directorCallTimes.filter(([call]) => call.endsWith(`:${opsId()}`))
  const tries = calls.slice(calls.findIndex(([call]) => call.startsWith(`${KILL_VERB}:`)))
  const t = tries[0]![1]
  expect(tries).toEqual(Array.from({ length: kills + reads }, (_, i) => [
    `${i % 2 === 0 ? KILL_VERB : STATUS_VERB}:${opsId()}`,
    t + Math.ceil(i / 2) * KILL_RETRY_SPACING_MS,
  ]))
  expect(b.killCalls.length).toBeLessThanOrEqual(KILL_RETRY_TRIES)
}

/** The two ways the teardown reaches its kill: a pause answering GONE, or the poll reaching exit_timeout. */
const KILL_PATHS: ReadonlyArray<readonly [string, () => Overrides]> = [
  ['after a pause answering GONE', () => ({ directorPause: async () => { throw errTmuxSendKeys() } })],
  ['at exit_timeout after a successful pause', () => ({ config: opsConfig({ exit_timeout: 1 }) })],
]

/** Every row of `rows` along each kill path, for each command, labelled `<path>, <lead><row>`. */
function forEachKillPath<T>(rows: ReadonlyArray<readonly [string, () => T]>, lead = '') {
  return forEachCommand(KILL_PATHS.flatMap(([path, overrides]) =>
    rows.map(([label, make]) => [`${path}, ${lead}${label}`, { overrides, make }] as const)))
}

/** The ErrTmuxKillFailed whose description names a surviving pid (b.jg5 SRJ-702). */
const survivorKillFailed = (): unknown => errTmuxKillFailed(opsSession(), 'pane-process-survived')

/** The head of every line the Ops persona's kill retry logs. */
const opsKillLogPrefix = (): string => `[slack] teardownBots: persona ${renderPersonaRef(OPS_NAME, personaKey(OPS_NAME))}`

/** The lines the Ops persona's kill retry logged (each try, read, stop and end), in order. */
const opsKillRetryLines = (): string[] => stderr.filter((l) => l.startsWith(`${opsKillLogPrefix()}: `))

/** A kill answer each try that is no success and is never tried again, with its class (b.jg5 SRJ-904 bullets 3 and 4). */
const FAIL_AT_ONCE_ANSWERS: ReadonlyArray<readonly [string, () => unknown, AdErrorClass, names: readonly string[]]> = [
  ...CONFLICT_CASES.map((c) => [`CONFLICT (${c})`, () => errTmuxSessionConflict(KILL_VERB, c, opsSession()), AD_ERROR_CLASS_CONFLICT, [opsSession()]] as const),
  ['ENVIRONMENT (ErrTmuxNotAvailable, tmux not runnable)', () => errTmuxNotAvailable(undefined, KILL_VERB), AD_ERROR_CLASS_ENVIRONMENT, []],
  ['ENVIRONMENT (ErrTmuxNotAvailable, socket not accessible)', () => errTmuxNotAvailable(STUB_TMUX_SOCKET_PATH, KILL_VERB), AD_ERROR_CLASS_ENVIRONMENT, []],
  ['ENVIRONMENT (ErrTmuxNotAvailable, a different tmux server)', () => errTmuxNotAvailableDifferentServer(STUB_TMUX_SOCKET_PATH, KILL_VERB), AD_ERROR_CLASS_ENVIRONMENT, []],
  ...UNUSABLE_NAME_FAULTS.map((f) => [`UNUSABLE NAME (the unusable-name ErrInternal, ${f})`, () => errUnusableName(f), AD_ERROR_CLASS_UNUSABLE_NAME, []] as const),
  ['UNCLASSIFIED (a plain ErrInternal)', () => errInternal(), AD_ERROR_CLASS_UNCLASSIFIED, []],
  [`UNCLASSIFIED (${ERR_SCHEMA_MISMATCH_NAME}, a store name)`, () => errSchemaMismatch(), AD_ERROR_CLASS_UNCLASSIFIED, [ERR_SCHEMA_MISMATCH_NAME]],
  ...STORE_OPEN_ERR_NAMES.filter((name) => name !== ERR_SCHEMA_MISMATCH_NAME)
    .map((name) => [`UNCLASSIFIED (${name}, a store name)`, () => errUnknownErrorName(name), AD_ERROR_CLASS_UNCLASSIFIED, [name]] as const),
  ['UNCLASSIFIED (ErrSystemInstallDisappeared)', () => errSystemInstallDisappeared(KILL_VERB), AD_ERROR_CLASS_UNCLASSIFIED, []],
  ['UNCLASSIFIED (ErrRelayModeOff, a name CSCB gives no handling)', () => errRelayModeOff(), AD_ERROR_CLASS_UNCLASSIFIED, []],
  ['CONFIG (ErrConfigMalformed) at a try', () => errConfigMalformed(), AD_ERROR_CLASS_CONFIG, []],
]

/** Kill answers SRJ-904 lists under no class of its own: each fails at once with the classifier's class, never UNCLASSIFIED (hatch A3). */
const UNLISTED_ANSWERS: ReadonlyArray<readonly [string, () => unknown, AdErrorClass]> = [
  ['GONE (ErrTmuxSendKeys)', () => errTmuxSendKeys(), AD_ERROR_CLASS_GONE],
  ['GONE (ErrTmuxCaptureFailed)', () => errTmuxCaptureFailed(opsSession(), KILL_VERB), AD_ERROR_CLASS_GONE],
  ['STATE (ErrSpawnNotInteractive, a STATE name other than ErrSpawnNotFound)', () => errSpawnNotInteractive(KILL_VERB), AD_ERROR_CLASS_STATE],
  ['DIRECTORY (ErrCwdNotFound)', () => errCwdNotFound(KILL_VERB), AD_ERROR_CLASS_DIRECTORY],
  ['LAUNCH FAILURE (ErrTmuxSessionCreate)', () => errTmuxSessionCreate(KILL_VERB), AD_ERROR_CLASS_LAUNCH_FAILURE],
]

/** The GONE kill answers of {@link UNLISTED_ANSWERS}, for the lines the retry logs for them. */
const GONE_KILL_ANSWERS: ReadonlyArray<readonly [string, () => unknown]> = UNLISTED_ANSWERS
  .filter(([, , errorClass]) => errorClass === AD_ERROR_CLASS_GONE)
  .map(([label, make]) => [label, make] as const)

/**
 * Every UNAVAILABLE kill answer but ErrTmuxKillFailed: each failure after its
 * tries, with no kill-failure alert (b.jg5 SRJ-907).
 */
const UNAVAILABLE_KILL_ANSWERS: ReadonlyArray<readonly [string, () => unknown]> =
  UNAVAILABLE_FORMS.filter(([label]) => label !== 'ErrTmuxKillFailed').map(([label, make]) => [label, () => make(KILL_VERB)] as const)

/** SRJ-904's kill answers, one row each, with the reads between tries that each one meets. */
const KILL_CLASS_ROWS: ReadonlyArray<readonly [string, () => KillCase]> = [
  // Success forms: one kill, no read.
  ['kill_sent true (a success)', () => stops([cannedKillResult(true)], [1, 0])],
  ['kill_sent false (a success)', () => stops([cannedKillResult(false)], [1, 0])],
  ['no kill_sent from a binary older than Phase 1 (a plain success)', () => stops([cannedKillResult()], [1, 0])],
  ['ErrSpawnNotFound (a success: b.dnt\'s already-gone race)', () => stops([thrown(errSpawnNotFound())], [1, 0])],
  ['ErrSpawnNotFound by name only (a success)', () => stops([thrown(errGeneric(KILL_VERB, ERR_SPAWN_NOT_FOUND_NAME, 'row gone'))], [1, 0])],
  // UNAVAILABLE: KILL_RETRY_TRIES kills, a read before each further one, then the persona fails (b.dnt: agent-director
  // dying mid-teardown fails it loudly).
  ...UNAVAILABLE_KILL_ANSWERS.map(([label, make]) => [`UNAVAILABLE (${label}) on every try`, (): KillCase => {
    const error = make()
    return { kills: [thrown(error)], calls: [KILL_RETRY_TRIES, KILL_RETRY_TRIES - 1], fails: [error, AD_ERROR_CLASS_UNAVAILABLE] }
  }] as const),
  // ErrTmuxKillFailed standing after the tries, one row per description: the ordinary version quotes it (b.jg5 SRJ-907, SRJ-1007).
  ...KILL_FAILED_DESCRIPTIONS.map((d) => [`UNAVAILABLE (ErrTmuxKillFailed, ${d}) on every try`, (): KillCase => {
    const error = errTmuxKillFailed(opsSession(), d)
    return {
      kills: [thrown(error)],
      calls: [KILL_RETRY_TRIES, KILL_RETRY_TRIES - 1],
      fails: [error, AD_ERROR_CLASS_UNAVAILABLE],
      alert: { lastKillFailedDescription: teardownKillFailedDescription(error) },
    }
  }] as const),
  ['UNAVAILABLE (ErrTmuxUnresponsive) and then a success on the 2nd try', () => stops([thrown(errTmuxUnresponsive(KILL_VERB)), cannedKillResult(true)], [2, 1])],
  // Every other answer: one kill, no read, the persona fails at once.
  ...[...FAIL_AT_ONCE_ANSWERS, ...UNLISTED_ANSWERS.map(([label, make, errorClass]) => [label, make, errorClass, []] as const)]
    .map(([label, make, errorClass, names]) => [label, (): KillCase => {
      const error = make()
      return { kills: [thrown(error)], calls: [1, 0], fails: [error, errorClass], names }
    }] as const),
]

/** A first try answering UNAVAILABLE, then each status read between tries. */
const KILL_READ_ROWS: ReadonlyArray<readonly [string, () => KillCase]> = [
  // A finished row or no row: a success with no further kill.
  ...[...AGENT_DIRECTOR_DEAD_STATES].map((state) => [`a read of ${state}`, () => stops([thrown(errTmuxUnresponsive(KILL_VERB))], [1, 1], [{ state }])] as const),
  ['a read finding no row (null)', () => stops([thrown(errTmuxUnresponsive(KILL_VERB))], [1, 1], [null])],
  ['a read answering ErrSpawnNotFound', () => stops([thrown(errTmuxUnresponsive(KILL_VERB))], [1, 1], [thrown(errSpawnNotFound())])],
  // Any other read lets the next try go ahead and latches nothing.
  ...([
    ['a read answering UNAVAILABLE (ErrCallTimeout)', () => thrown(errCallTimeout(STATUS_VERB))],
    ['a read answering UNAVAILABLE (a plain Error)', () => thrown(new Error('AD connection refused'))],
    ...UNUSABLE_NAME_FAULTS.map((f) => [`a read answering UNUSABLE NAME (${f})`, () => thrown(errUnusableName(f))] as const),
    ['a read answering CONFLICT', () => thrown(errTmuxSessionConflict(STATUS_VERB, 'unrecognised', opsSession()))],
    ['a read of a pending row with no launch start', () => cannedStatusResult({ state: AGENT_DIRECTOR_PENDING_STATE, launch_started_at: SAMPLE_LAUNCH_START_NONE })],
  ] as ReadonlyArray<readonly [string, () => StatusRow | Thrown]>).map(([label, read]) => [`${label} (the next try goes ahead)`, (): KillCase => {
    const error = errTmuxUnresponsive(KILL_VERB)
    return { kills: [thrown(error)], reads: [read()], calls: [KILL_RETRY_TRIES, KILL_RETRY_TRIES - 1], fails: [error, AD_ERROR_CLASS_UNAVAILABLE] }
  }] as const),
]

/**
 * A survivor-naming ErrTmuxKillFailed at the first try, then each end of the
 * tries: an end as a success stops the persona with the survivor version
 * (AC 64); any failure, whatever its class, fails it with the ordinary
 * version quoting the survivor-naming description, never the survivor one
 * (b.jg5 SRJ-904 bullet 7, SRJ-907).
 */
const KILL_SURVIVOR_ROWS: ReadonlyArray<readonly [string, () => KillCase]> = [
  ['a read of ended (stopped)', () => stopsWithSurvivor([thrown(survivorKillFailed())], [1, 1], [ENDED_ROW])],
  ['a 2nd try answering kill_sent true (stopped)', () => stopsWithSurvivor([thrown(survivorKillFailed()), cannedKillResult(true)], [2, 1])],
  ['a 2nd try answering kill_sent false (stopped)', () => stopsWithSurvivor([thrown(survivorKillFailed()), cannedKillResult(false)], [2, 1])],
  ['two tries answering ErrTmuxUnresponsive (failed)', (): KillCase => {
    const error = errTmuxUnresponsive(KILL_VERB)
    return failsAfterSurvivor([thrown(error)], [KILL_RETRY_TRIES, KILL_RETRY_TRIES - 1], error, AD_ERROR_CLASS_UNAVAILABLE)
  }],
  ['two tries answering ErrTmuxKillFailed naming no survivor (failed; both descriptions quoted)', (): KillCase => {
    const error = errTmuxKillFailed(opsSession(), 'outlived-exit-wait')
    const kc = failsAfterSurvivor([thrown(error)], [KILL_RETRY_TRIES, KILL_RETRY_TRIES - 1], error, AD_ERROR_CLASS_UNAVAILABLE)
    return { ...kc, alert: { lastKillFailedDescription: teardownKillFailedDescription(error), ...kc.alert } }
  }],
  ['a 2nd try answering CONFLICT (failed)', (): KillCase => {
    const error = errTmuxSessionConflict(KILL_VERB, 'not-this-launch', opsSession())
    return failsAfterSurvivor([thrown(error)], [2, 1], error, AD_ERROR_CLASS_CONFLICT)
  }],
  ['a 2nd try answering CONFIG (failed)', (): KillCase => {
    const error = errConfigMalformed()
    return failsAfterSurvivor([thrown(error)], [2, 1], error, AD_ERROR_CLASS_CONFIG)
  }],
  ['a read answering CONFIG (failed, no further kill)', (): KillCase => {
    const error = errConfigMalformed()
    return failsAfterSurvivor([], [1, 1], error, AD_ERROR_CLASS_CONFIG, [thrown(error)])
  }],
  ['a 2nd try answering UNCLASSIFIED (a plain ErrInternal; failed)', (): KillCase => {
    const error = errInternal()
    return failsAfterSurvivor([thrown(error)], [2, 1], error, AD_ERROR_CLASS_UNCLASSIFIED)
  }],
  // A GONE answer at the 2nd try ends the tries as a failure with its own class, like every unlisted answer.
  ...UNLISTED_ANSWERS.map(([label, make, errorClass]) => [`a 2nd try answering ${label} (failed)`, (): KillCase => {
    const error = make()
    return failsAfterSurvivor([thrown(error)], [2, 1], error, errorClass)
  }] as const),
]

/**
 * Run `kc` along `overrides`' path: its kill tries, its outcome and report
 * (the failure line, followed by the ordinary alert when `kc.alert` is set;
 * or, when stopped, the survivor version when `kc.survivor` is set, else
 * nothing), the exit, a state directory unchanged but for the report's two
 * log files, and no leak.
 */
async function runKillCase(command: CliTeardownCommand, [, mk, run]: Command, overrides: () => Overrides, kc: KillCase): Promise<Bundle> {
  const b = mk(killCaseOverrides(overrides(), kc))
  const before = snapshotTreeExceptTeardownLogs() // after make, so the PID file is in it
  await run(b)
  expectKillTries(b, kc.calls)
  if (kc.fails === null) {
    expectTeardownStopped(b, command, kc.survivor === undefined ? [] : [survivorReport(command, OPS_PERSONA, kc.survivor)])
  } else {
    const [error, errorClass] = kc.fails
    const report = failedReport(command, OPS_PERSONA, error, errorClass, kc.alert)
    expectTeardownFailed(b, command, [report])
    for (const name of kc.names ?? []) expect(report.lines[0]).toContain(name)
  }
  expect(snapshotTreeExceptTeardownLogs()).toEqual(before)
  assertNoLeak({ stderr, consoleErrorArgs: errorSpy.mock.calls, files: writtenTeardownLogs() })
  return b
}

describe('the teardown\'s kill by class (b.jg5 SRJ-904, SRJ-702, SRJ-110; AC 64, AC 73, AC 77)', () => {
  test.each(forEachKillPath(KILL_CLASS_ROWS, 'a kill answering '))('%s: %s', async (command, _label, { overrides, make }, cmd) => {
    await runKillCase(command, cmd, overrides, make())
  })

  test.each(forEachKillPath(KILL_READ_ROWS, 'a first try answering UNAVAILABLE, then '))('%s: %s', async (command, _label, { overrides, make }, cmd) => {
    await runKillCase(command, cmd, overrides, make())
  })

  test.each(forEachKillPath(KILL_SURVIVOR_ROWS, 'a first try answering the survivor-naming ErrTmuxKillFailed, then '))('%s: %s', async (command, _label, { overrides, make }, cmd) => {
    await runKillCase(command, cmd, overrides, make())
  })

  // A GONE answer is the checked kill's GONE non-success under TEARDOWN_KILL_OPTIONS: the retry logs it as that
  // failure, never as a success, and decides the ordinary version after a survivor-naming try.
  test.each(forEachKillPath(GONE_KILL_ANSWERS, 'a kill answering '))('%s: %s: one try line, the GONE failure not tried again; no end line and nothing logged as session-gone', async (command, _label, { overrides, make }, cmd) => {
    const error = make()
    await runKillCase(command, cmd, overrides, { kills: [thrown(error)], calls: [1, 0], fails: [error, AD_ERROR_CLASS_GONE] })
    const outcome = killOutcomeOf({ thrown: error }, TEARDOWN_KILL_OPTIONS)
    expect(opsKillRetryLines()).toEqual([killRetryTryLine(opsKillLogPrefix(), opsId(), 1, KILL_RETRY_TRIES, outcome, KILL_RETRY_NEXT_NOT_RETRIED)])
    expect(stderr.filter((l) => l.includes(KILL_OUTCOME_SESSION_GONE))).toEqual([])
  })

  test.each(forEachKillPath(GONE_KILL_ANSWERS, 'a first try answering the survivor-naming ErrTmuxKillFailed, then a 2nd try answering '))('%s: %s: the 2nd try line is the GONE failure not tried again, and the end line carries it with alert=ordinary', async (command, _label, { overrides, make }, cmd) => {
    const [first, error] = [survivorKillFailed(), make()]
    await runKillCase(command, cmd, overrides, failsAfterSurvivor([thrown(error)], [2, 1], error, AD_ERROR_CLASS_GONE))
    const outcome = killOutcomeOf({ thrown: error }, TEARDOWN_KILL_OPTIONS)
    const lines = opsKillRetryLines()
    expect(lines).toHaveLength(4) // try 1, the read, try 2, the end
    expect(lines[0]).toContain(describeKillOutcome(killOutcomeOf({ thrown: first }, TEARDOWN_KILL_OPTIONS)))
    expect(lines[1]).toContain(`state=${WAITING_ROW.state}`)
    expect(lines.slice(2)).toEqual([
      killRetryTryLine(opsKillLogPrefix(), opsId(), 2, KILL_RETRY_TRIES, outcome, KILL_RETRY_NEXT_NOT_RETRIED),
      killRetryEndLine(opsKillLogPrefix(), opsId(), { outcome, end: KILL_RETRY_END_SETTLED, tries: 2, reads: 1, alert: { kind: KILL_RETRY_ALERT_ORDINARY } }),
    ])
    expect(stderr.filter((l) => l.includes(KILL_OUTCOME_SESSION_GONE))).toEqual([])
  })

  test('the rows reach every class SRJ-904 names at the kill and every unlisted one, a success, a retry, and both reads that end the tries', () => {
    const failed = [...KILL_CLASS_ROWS, ...KILL_SURVIVOR_ROWS].flatMap(([, make]) => {
      const { fails } = make()
      return fails === null ? [] : [fails[1]]
    })
    expect(new Set(failed)).toEqual(new Set([
      AD_ERROR_CLASS_UNAVAILABLE, AD_ERROR_CLASS_CONFLICT, AD_ERROR_CLASS_ENVIRONMENT, AD_ERROR_CLASS_UNUSABLE_NAME, AD_ERROR_CLASS_UNCLASSIFIED,
      AD_ERROR_CLASS_CONFIG, AD_ERROR_CLASS_GONE, AD_ERROR_CLASS_STATE, AD_ERROR_CLASS_DIRECTORY, AD_ERROR_CLASS_LAUNCH_FAILURE,
    ]))
    expect(KILL_CLASS_ROWS.some(([, make]) => make().calls[0] === KILL_RETRY_TRIES)).toBe(true)
    expect(KILL_READ_ROWS.filter(([, make]) => make().fails === null)).not.toEqual([])
  })

  // CONFIG at a status read between tries: no further kill, whatever state the row was last read in. Under
  // TEARDOWN_KILL_RETRY_OPTIONS the retry itself ends the tries (read-config), its read line saying why, and the
  // persona fails as CONFIG, naming the config file.
  test.each(forEachKillPath<{ kc: KillCase; killError: unknown; why: string }>([
    ['a read answering CONFIG on a row last read waiting', () => {
      const [killError, configError] = [errTmuxUnresponsive(KILL_VERB), errConfigMalformed()]
      return {
        killError,
        why: `the row was last read ${WAITING_ROW.state}, and this caller ends the tries on any CONFIG read: no further kill`,
        kc: { kills: [thrown(killError)], reads: [thrown(configError)], calls: [1, 1], fails: [configError, AD_ERROR_CLASS_CONFIG] },
      }
    }],
    ['a read answering CONFIG on a row the state read found pending', () => {
      const [killError, configError] = [errTmuxUnresponsive(KILL_VERB), errConfigMalformed()]
      const row = { state: AGENT_DIRECTOR_PENDING_STATE }
      return {
        killError,
        why: `the row was last read ${AGENT_DIRECTOR_PENDING_STATE}: no further kill`,
        kc: { row, kills: [thrown(killError)], reads: [thrown(configError)], calls: [1, 1], fails: [configError, AD_ERROR_CLASS_CONFIG] },
      }
    }],
    ['a read of a pending row with no launch start, a 2nd try answering UNAVAILABLE, then a read answering CONFIG', () => {
      const [killError, configError] = [errTmuxUnresponsive(KILL_VERB), errConfigMalformed()]
      const pending = cannedStatusResult({ state: AGENT_DIRECTOR_PENDING_STATE, launch_started_at: SAMPLE_LAUNCH_START_NONE })
      return {
        killError,
        why: `the row was last read ${AGENT_DIRECTOR_PENDING_STATE}: no further kill`,
        kc: { kills: [thrown(killError)], reads: [pending, thrown(configError)], calls: [2, 2], fails: [configError, AD_ERROR_CLASS_CONFIG] },
      }
    }],
  ], 'a first try answering UNAVAILABLE, then '))('%s: %s: the tries end (read-config) with no further kill, and the persona fails as CONFIG naming the config file', async (command, _label, { overrides, make }, cmd) => {
    const { kc, killError, why } = make()
    await runKillCase(command, cmd, overrides, kc)
    expect(stderr.filter((l) => l.startsWith(`${command}: `))[0]).toContain(AD_CONFIG_FILE_DISPLAY_NAME)
    const [tries, reads] = kc.calls
    const lines = opsKillRetryLines()
    expect(lines.at(-2)).toContain(why)
    expect(lines.at(-1)).toBe(killRetryEndLine(opsKillLogPrefix(), opsId(), {
      outcome: killOutcomeOf({ thrown: killError }, TEARDOWN_KILL_OPTIONS), end: KILL_RETRY_END_READ_CONFIG, tries, reads, alert: { kind: KILL_RETRY_ALERT_NONE },
    }))
    expect(lines.filter((l) => l.includes('stop before try'))).toEqual([])
  })

  // b.jg5 SRJ-1014 (SRJ-702's lines; hatch note E33): the teardown's kill
  // writes each try line, each between-try status read line and its end line
  // through the kill retry's own builders, with the teardown's prefix; a fake
  // token in a try's or a read's description comes out redacted. The text of
  // each line per outcome kind is tests/kill-retry.test.ts's.
  test.each(forEachKillPath<{ kc: KillCase; first: unknown; expected: string[]; redacted: number }>([
    ['a first try answering UNAVAILABLE, a read answering UNCLASSIFIED, then a try answering CONFLICT, each carrying a fake token', () => {
      const first = errTmuxUnresponsive(KILL_VERB, `no answer (${sentinelInMessage('cli-try-unavailable')})`)
      const readError = errInternal(`the store could not be read (${sentinelInMessage('cli-read-unclassified')})`)
      const conflict = errTmuxSessionConflict(KILL_VERB, 'not-this-launch', sentinelInMessage('cli-try-conflict'))
      const second = killOutcomeOf({ thrown: conflict }, TEARDOWN_KILL_OPTIONS)
      return {
        first,
        kc: { kills: [thrown(first), thrown(conflict)], reads: [thrown(readError)], calls: [2, 1], fails: [conflict, AD_ERROR_CLASS_CONFLICT] },
        expected: [
          killRetryReadLine(opsKillLogPrefix(), opsId(), 2, teardownKillReadOf({ error: readError }), KILL_RETRY_VERDICT_GO, killRetrySeedOfState(WAITING_ROW.state)),
          killRetryTryLine(opsKillLogPrefix(), opsId(), 2, KILL_RETRY_TRIES, second, KILL_RETRY_NEXT_NOT_RETRIED),
          killRetryEndLine(opsKillLogPrefix(), opsId(), { outcome: second, end: KILL_RETRY_END_SETTLED, tries: 2, reads: 1, alert: { kind: KILL_RETRY_ALERT_NONE } }),
        ],
        // Every line quotes a description carrying the fake token: both tries, the read, and the end line's outcome.
        redacted: 4,
      }
    }],
    ['a first try answering UNAVAILABLE carrying a fake token, then a read of ended', () => {
      const first = errTmuxUnresponsive(KILL_VERB, `no answer (${sentinelInMessage('cli-try-finished')})`)
      const finished: AnyKillOutcome = { kind: KILL_OUTCOME_ROW_FINISHED, read: KILL_ROW_FINISHED_ENDED }
      return {
        first,
        kc: stops([thrown(first)], [1, 1], [ENDED_ROW]),
        expected: [
          killRetryReadLine(opsKillLogPrefix(), opsId(), 2, teardownKillReadOf({ row: ENDED_ROW }), KILL_RETRY_VERDICT_FINISHED, killRetrySeedOfState(WAITING_ROW.state)),
          killRetryEndLine(opsKillLogPrefix(), opsId(), { outcome: finished, end: KILL_RETRY_END_ROW_FINISHED, tries: 1, reads: 1, alert: { kind: KILL_RETRY_ALERT_NONE } }),
        ],
        // Only the first try quotes a description.
        redacted: 1,
      }
    }],
  ], ''))('%s: %s: each try, read and end line is the kill retry\'s builder\'s, with the teardown\'s prefix, its descriptions redacted', async (command, _label, { overrides, make }, cmd) => {
    const { kc, first, expected, redacted } = make()
    await runKillCase(command, cmd, overrides, kc)

    const firstOutcome = killOutcomeOf({ thrown: first }, TEARDOWN_KILL_OPTIONS)
    const lines = opsKillRetryLines()
    // The first try is tried again: what follows it has no exported value,
    // so its line is the builder's head for that outcome (shared by every
    // exported form) and none of those forms.
    const forms = ([KILL_RETRY_NEXT_SUCCESS, KILL_RETRY_NEXT_NOT_RETRIED, KILL_RETRY_NEXT_NOT_LIVE] as const).map((next) => killRetryTryLine(opsKillLogPrefix(), opsId(), 1, KILL_RETRY_TRIES, firstOutcome, next))
    let shared = 0
    while (shared < forms[0]!.length && forms.every((form) => form[shared] === forms[0]![shared])) shared++
    expect([lines[0]!.startsWith(forms[0]!.slice(0, shared)), forms.includes(lines[0]!)]).toEqual([true, false])
    expect(lines.slice(1)).toEqual(expected)
    expect(lines.filter((line) => line.includes(REDACTED_SENTINEL_TAIL))).toHaveLength(redacted)
    expect(lines[0]).toContain(REDACTED_SENTINEL_TAIL)
    assertNoLeak({ lines })
  })

  // b.jg5 SRJ-1002, SRJ-909 (AC 64): a CONFLICT or an UNUSABLE NAME at the
  // CLI's kill is printed, logged and recorded (runKillCase checks the
  // three and the unchanged state directory: no latch, no record), and the
  // CLI builds no Slack client and makes no Slack call: no Web API call and
  // no Socket Mode start while the teardown runs.
  test.each(forEachKillPath<{ error: unknown; errorClass: AdErrorClass }>([
    ['CONFLICT (not this launch\'s session)', () => ({ error: errTmuxSessionConflict(KILL_VERB, 'not-this-launch', opsSession()), errorClass: AD_ERROR_CLASS_CONFLICT })],
    ['UNUSABLE NAME', () => ({ error: errUnusableName(), errorClass: AD_ERROR_CLASS_UNUSABLE_NAME })],
  ], 'a kill answering '))('%s: %s: printed, logged and recorded as cli-teardown-failed; no Slack call of any kind', async (command, _label, { overrides, make }, cmd) => {
    const { error, errorClass } = make()
    const apiCall = spyOn(WebClient.prototype, 'apiCall')
    const socketStart = spyOn(SocketModeClient.prototype, 'start')
    try {
      await runKillCase(command, cmd, overrides, { kills: [thrown(error)], calls: [1, 0], fails: [error, errorClass] })
      expect(startupErrorEntries().map((entry) => entry.classLabel)).toEqual([CLI_TEARDOWN_FAILED_LABEL])
      expect([apiCall.mock.calls.length, socketStart.mock.calls.length]).toEqual([0, 0])
    } finally {
      apiCall.mockRestore()
      socketStart.mockRestore()
    }
  })

  // Hatch note E24: the reads between tries are SRJ-115 sites; the CLI never writes retired-keys.json (SRJ-801).
  test.each(COMMANDS)('%s: the reads between kill tries of a key the seeded retired-key record marks leave the record byte-identical', async (command, make, run) => {
    writeRetiredKeysRecord(stateDir, { [personaKey(OPS_NAME)]: { cause: RETIRED_KEY_CAUSE_DESTRUCTIVE_MODIFY, mark: true } })
    const record = new Uint8Array(readFileSync(retiredKeysPath(stateDir)))
    const error = errTmuxUnresponsive(KILL_VERB)
    await runKillCase(command, [command, make, run], KILL_PATHS[0]![1], { kills: [thrown(error)], calls: [KILL_RETRY_TRIES, KILL_RETRY_TRIES - 1], fails: [error, AD_ERROR_CLASS_UNAVAILABLE] })
    expect(new Uint8Array(readFileSync(retiredKeysPath(stateDir))) as Uint8Array).toEqual(record)
  })

  test('static (comments stripped): Date.now and setTimeout appear in src/cli.ts only as realDeps\' now and sleep, and no agent-director error is told apart with instanceof on an Err* class (b.jg5 SRJ-908; hatch notes E12, E20)', () => {
    const code = stripComments(readFileSync(CLI_SOURCE, 'utf-8'))
    const main = indicesOf(/\bif\s*\(\s*import\.meta\.main\s*\)/g, code)
    expect(main).toHaveLength(1)
    const mainBlock = code.slice(...balancedAfter(code, main[0]!, '{', '}'))
    const props = objectProperties(mainBlock.slice(mainBlock.indexOf('const realDeps: CliDeps =')))
    expect(props.get('now')).toMatch(/^\(\)\s*=>\s*Date\.now\(\)$/)
    expect(props.get('sleep')).toMatch(/^\(\s*(\w+)\s*\)\s*=>\s*new\s+Promise<void>\(\s*\(\s*(\w+)\s*\)\s*=>\s*setTimeout\(\s*\2\s*,\s*\1\s*\)\s*\)$/)
    expect(indicesOf(/\bDate\.now\b/g, code)).toHaveLength(1)
    expect(indicesOf(/\bsetTimeout\b/g, code)).toHaveLength(1)
    expect(indicesOf(/\bsetInterval\b/g, code)).toEqual([])
    expect(code.match(/\binstanceof\s+(?:Err[A-Z]\w*|AgentDirectorError)\b/g)).toBeNull()
    expect(code.match(/\binstanceof\s+\w+/g)?.filter((m) => !/\b(?:Error|StartupGateFailedError)$/.test(m))).toEqual([]) // CSCB's own class and Error only
  })
})

// ---------------------------------------------------------------------------
// A human-initiated teardown's kill of a row the server would hold (b.jg5
// SRJ-503, SRJ-513 bullet 2; AC 4, AC 46; hatch notes E16, E32 bullet 2)
//
// The CLI has no latch: a pending row with no launch start gets its pause
// (ErrSpawnNotPausable) and then the ordinary checked kill, and a finished
// row its read alone. Through the stub client, as production wires the
// director ops, every kill request is the instance id alone.
// ---------------------------------------------------------------------------

describe('a human-initiated teardown\'s ordinary kill (b.jg5 SRJ-503, SRJ-513; AC 4, AC 46)', () => {
  /** A pending row with no launch start, as `status` and `get` show it. */
  const pendingNoLaunchStart = (): StatusRow & PrecheckRow =>
    cannedStatusResult({ state: AGENT_DIRECTOR_PENDING_STATE, launch_started_at: SAMPLE_LAUNCH_START_NONE })

  test.each(COMMANDS)('%s: a precheck get and a teardown status reading pending with no launch start: the pause answers ErrSpawnNotPausable and the one kill succeeds with kill_sent false; every persona stopped', async (command, make, run) => {
    const b = make({
      directorGet: async () => pendingNoLaunchStart(),
      directorStatus: async () => pendingNoLaunchStart(),
      directorPause: async () => { throw errSpawnNotPausable(PAUSE_VERB) },
      directorKill: async () => cannedKillResult(false),
    })
    const before = snapshotTree()

    await run(b)

    expect(b.readPaneCalls).toEqual([[opsId(), PROBE_PANE_READ_LINES]])
    expect([b.statusCalls, b.pauseCalls, b.killCalls]).toEqual([[opsId()], [opsId()], [opsId()]])
    expectTeardownStopped(b, command)
    expect(snapshotTree()).toEqual(before)
    assertNoLeak({ stderr, consoleErrorArgs: errorSpy.mock.calls })
  })

  // E32 bullet 2's pending-row leg: the precheck's pane proves nothing; the kill answers CONFLICT.
  test.each(COMMANDS)('%s: the same pending row whose kill answers CONFLICT "not this launch\'s session": that persona fails at once after one kill and no read; exit 1, nothing latched and the seeded retired-key record byte-identical', async (command, make, run) => {
    writeRetiredKeysRecord(stateDir, { [personaKey(OPS_NAME)]: { cause: RETIRED_KEY_CAUSE_DESTRUCTIVE_MODIFY, mark: true } })
    const conflict = errTmuxSessionConflict(KILL_VERB, 'not-this-launch', opsSession())
    const b = make({
      directorGet: async () => pendingNoLaunchStart(),
      directorStatus: async () => pendingNoLaunchStart(),
      directorPause: async () => { throw errSpawnNotPausable(PAUSE_VERB) },
      directorKill: async () => { throw conflict },
    })
    const before = snapshotTreeExceptTeardownLogs()

    await run(b)

    expect([b.statusCalls, b.pauseCalls, b.killCalls]).toEqual([[opsId()], [opsId()], [opsId()]])
    const report = failedReport(command, OPS_PERSONA, conflict, AD_ERROR_CLASS_CONFLICT)
    expectTeardownFailed(b, command, [report])
    expect(report.lines[0]).toContain(opsSession())
    expect(snapshotTreeExceptTeardownLogs()).toEqual(before)
    assertNoLeak({ stderr, consoleErrorArgs: errorSpy.mock.calls })
  })

  describe('through the stub client, as production wires the director ops', () => {
    beforeEach(() => resetClientForTests())
    afterEach(() => resetClientForTests())

    const alphaId = (): string => personaInstanceId(personaKey(ALPHA.name))
    const betaId = (): string => personaInstanceId(personaKey(BETA.name))

    test('stop --stop-bots, Alpha\'s row finished (get and status read ended) and Beta\'s pending with no launch start: Alpha gets its get and its status read and nothing more; Beta its read-pane, pause and one kill whose request is exactly its instance ID, with no include_finished; exit 0 (AC 46)', async () => {
      const log = makeStubCallLog()
      const stateOf = (id: string): string => (id === alphaId() ? ENDED_ROW.state : AGENT_DIRECTOR_PENDING_STATE)
      const client = makeStubClient({
        ...log,
        getFn: (params) => cannedGetResult({ claude_instance_id: params.claude_instance_id, state: stateOf(params.claude_instance_id), launch_started_at: SAMPLE_LAUNCH_START_NONE }),
        readPaneResults: [{ pane: FAKE_PANE }],
        statusFn: (params) => cannedStatusResult({ state: stateOf(params.claude_instance_id), launch_started_at: SAMPLE_LAUNCH_START_NONE }),
        pauseError: errSpawnNotPausable(PAUSE_VERB),
        killResult: cannedKillResult(false),
      })
      setClientForTests(client as unknown as Parameters<typeof setClientForTests>[0])
      const b = makeLiveStopDeps({ config: twoPersonas(), ...createDirectorOps(getClient) })

      await settled(createCli(b.deps).stop({ stopBots: true }))

      const ids = (calls: ReadonlyArray<{ claude_instance_id: string }>): string[] => calls.map((c) => c.claude_instance_id).sort()
      expect(ids(log.getCalls)).toEqual([alphaId(), betaId()].sort())
      expect([ids(log.readPaneCalls), ids(log.statusCalls), ids(log.pauseCalls)]).toEqual([[betaId()], [alphaId(), betaId()].sort(), [betaId()]])
      expect(log.killCalls).toEqual([{ claude_instance_id: betaId() }])
      for (const request of log.killCalls) expect(Object.keys(request)).toEqual(['claude_instance_id'])
      expectTeardownStopped(b, CLI_COMMAND_STOP_BOTS)
      assertNoLeak({ stderr, consoleErrorArgs: errorSpy.mock.calls, log })
    })
  })
})

// ---------------------------------------------------------------------------
// The teardown's report and where each line goes (b.jg5 SRJ-907, SRJ-909,
// SRJ-1013, SRJ-1002; AC 64, AC 73, AC 77; hatch notes E19–E20 bullet 1, E21)
//
// Personas are torn down in parallel; once every one has settled (a teardown
// that rejects included, as a failure), each persona's report is written in
// configuration order: printed (for `clean_restart` through its fatal path,
// so once on the terminal and once in clean_restart.log, the survivor version
// on a successful run included), then its server.log lines, then its
// startup-errors entry; the last line, counting the failed personas only, is
// printed last and only printed. Both writes are best effort: a failed one
// prints one line, leaves the print and the other destination as they are and
// changes no exit status. Both CLI closing sentences of the kill-failure
// alert are reached here, through the CLI (hatch note E21).
// ---------------------------------------------------------------------------

/** A write failure carrying fake tokens: its description, never itself, reaches the one line that reports it. */
const writeError = (): Error => Object.assign(new Error(`disk refused (${sentinelInMessage('write')})`), { code: 'ENOSPC', note: LEAK_SENTINEL })

/** A failing write: the seam's override and which destination it leaves unwritten. */
type WriteFailure = (error: Error) => { readonly overrides: Overrides; readonly to: ReportDestinations }
const WRITE_FAILURES: ReadonlyArray<readonly [string, WriteFailure]> = [
  ['the server.log append throws', (error) => ({ overrides: { appendServerLogLine: () => { throw error } }, to: { serverLog: false } })],
  ['the server.log append answers not written', (error) => ({ overrides: { appendServerLogLine: () => ({ written: false, error }) }, to: { serverLog: false } })],
  ['the startup-errors recorder throws', (error) => ({ overrides: { recordStartupErrorEntry: () => { throw error } }, to: { startupErrors: false } })],
]

describe('the teardown\'s report and where each line goes (b.jg5 SRJ-907, SRJ-909, SRJ-1013; AC 64, AC 73, AC 77)', () => {
  const GAMMA = { name: 'Gamma', channels: [{ id: 'C0GAMMA01', delivery: 'all' as const }] }
  const [alphaP, betaP, gammaP] = [ALPHA.name, BETA.name, GAMMA.name].map(personaOf) as [CliTeardownPersona, CliTeardownPersona, CliTeardownPersona]
  const idOf = (p: CliTeardownPersona): string => personaInstanceId(p.key)
  const sessionOf = (p: CliTeardownPersona): string => personaTmuxSessionName(p.key)

  /** A run's overrides and the reports it gives, in configuration order. */
  interface Scenario {
    readonly overrides: Overrides
    readonly reports: readonly ExpectedReport[]
  }

  /**
   * Alpha's kill answers ErrTmuxKillFailed naming no survivor on every try
   * (failed, with the ordinary version quoting it); Beta's first kill names a
   * survivor and the read after it finds the row ended (stopped, with the
   * survivor version). Both pauses answer GONE.
   */
  function failedAndSurvivor(command: CliTeardownCommand): Scenario {
    const alphaError = errTmuxKillFailed(sessionOf(alphaP), 'outlived-exit-wait')
    const betaSurvivor = errTmuxKillFailed(sessionOf(betaP), 'pane-process-survived')
    let betaKills = 0
    return {
      overrides: {
        config: twoPersonas(),
        directorStatus: async (id) => (id === idOf(betaP) && betaKills > 0 ? ENDED_ROW : WAITING_ROW),
        directorPause: async () => { throw errTmuxSendKeys() },
        directorKill: async (id) => {
          if (id === idOf(alphaP)) throw alphaError
          betaKills++
          throw betaSurvivor
        },
      },
      reports: [
        failedReport(command, alphaP, alphaError, AD_ERROR_CLASS_UNAVAILABLE, { lastKillFailedDescription: teardownKillFailedDescription(alphaError) }),
        survivorReport(command, betaP, teardownKillFailedDescription(betaSurvivor)),
      ],
    }
  }

  /** Alpha is stopped by its kill; Beta's first kill names a survivor and its 2nd succeeds: every persona stopped. */
  function survivorOnly(command: CliTeardownCommand): Scenario {
    const betaSurvivor = errTmuxKillFailed(sessionOf(betaP), 'pane-process-survived')
    const betaKills = scripted<unknown>(thrown(betaSurvivor), cannedKillResult(false))
    return {
      overrides: {
        config: twoPersonas(),
        directorStatus: async () => WAITING_ROW,
        directorPause: async () => { throw errTmuxSendKeys() },
        directorKill: async (id) => (id === idOf(betaP) ? betaKills() : cannedKillResult(true)),
      },
      reports: [survivorReport(command, betaP, teardownKillFailedDescription(betaSurvivor))],
    }
  }

  const SCENARIOS: ReadonlyArray<readonly [string, (command: CliTeardownCommand) => Scenario]> = [
    ['a persona failed with the ordinary version beside one stopped with the survivor version', failedAndSurvivor],
    ['every persona stopped, one with the survivor version', survivorOnly],
  ]

  /** The report's exit and lines: {@link expectTeardownFailed} when any persona failed, else {@link expectTeardownStopped}. */
  function expectRun(b: Bundle, command: CliTeardownCommand, reports: readonly ExpectedReport[], to: ReportDestinations = {}): void {
    if (reports.some((r) => r.failed)) expectTeardownFailed(b, command, reports, to)
    else expectTeardownStopped(b, command, reports, to)
  }

  test.each(COMMANDS)('%s: three personas settling in the reverse of configuration order are reported in configuration order — Alpha\'s failure line and the ordinary version, Beta\'s failure line alone, Gamma\'s survivor version — then the last line counting 2, printed last and neither logged nor recorded; each persona\'s print, server.log lines and entry in turn; exit 1 (clean_restart, agent-director answering, starts the server again)', async (command, make, run) => {
    const alphaError = errTmuxKillFailed(sessionOf(alphaP), 'unverifiable-session-present')
    const betaError = errTmuxSessionConflict(PAUSE_VERB, 'leftover', sessionOf(betaP))
    const gammaSurvivor = errTmuxKillFailed(sessionOf(gammaP), 'pane-process-survived')
    const gammaKills = scripted<unknown>(thrown(gammaSurvivor), cannedKillResult(true))
    const b = make({
      config: makeMultiPersonaConfig([ALPHA, BETA, GAMMA], root),
      directorStatus: async () => WAITING_ROW,
      directorPause: async (id) => { throw id === idOf(betaP) ? betaError : errTmuxSendKeys() },
      directorKill: async (id) => {
        if (id === idOf(alphaP)) throw alphaError
        return gammaKills()
      },
    })

    await run(b)

    // Precondition: Beta settled first (no kill), Gamma next (2 kills), Alpha last (KILL_RETRY_TRIES kills).
    const lastCallOf = (verb: string, p: CliTeardownPersona): number => callTimesOf(b, verb, idOf(p)).at(-1)!
    expect(callTimesOf(b, KILL_VERB, idOf(betaP))).toEqual([])
    expect([callTimesOf(b, KILL_VERB, idOf(alphaP)).length, callTimesOf(b, KILL_VERB, idOf(gammaP)).length]).toEqual([KILL_RETRY_TRIES, 2])
    expect(lastCallOf(PAUSE_VERB, betaP)).toBeLessThan(lastCallOf(KILL_VERB, gammaP))
    expect(lastCallOf(KILL_VERB, gammaP)).toBeLessThan(lastCallOf(KILL_VERB, alphaP))

    const reports = [
      failedReport(command, alphaP, alphaError, AD_ERROR_CLASS_UNAVAILABLE, { lastKillFailedDescription: teardownKillFailedDescription(alphaError) }),
      failedReport(command, betaP, betaError, AD_ERROR_CLASS_CONFLICT),
      survivorReport(command, gammaP, teardownKillFailedDescription(gammaSurvivor)),
    ]
    expectTeardownFailed(b, command, reports)
    const last = teardownNotStoppedLine(command, 2)
    expect(stderr.at(-1)).toBe(last)
    expect(serverLogTexts(b.clock.now())).not.toContain(last)
    expect(startupErrorEntries().map((e) => e.classLabel)).toEqual([PERSONA_KILL_FAILED_LABEL, CLI_TEARDOWN_FAILED_LABEL, PERSONA_KILL_SURVIVOR_LABEL])
    expect(startupErrorEntries().filter((e) => e.message.includes(last))).toEqual([])
    // The alert entries' context names the command (hatch note E19–E20 bullet 1).
    const context = killFailureAlertEntryText('', killFailureCliTeardownEntryContext(command), '')
    expect(context).toContain(command)
    for (const i of [0, 2]) expect(startupErrorEntries()[i]!.message).toContain(context)
    // Both CLI closing sentences reach the terminal (hatch note E21).
    expect(stderr.filter((l) => l.endsWith(KILL_FAILURE_ORDINARY_CLI_TEARDOWN_CLOSING))).toEqual([reports[0]!.lines[1]])
    expect(stderr.filter((l) => l.endsWith(KILL_FAILURE_SURVIVOR_CLI_TEARDOWN_CLOSING))).toEqual([reports[2]!.lines[0]])
    // Per persona in turn: its server.log lines, then its entry.
    const writes = b.events.filter((e) => e === 'appendServerLogLine' || e === 'recordStartupErrorEntry').map((e) => (e === 'appendServerLogLine' ? 'log' : 'entry'))
    expect(writes).toEqual(['log', 'log', 'entry', 'log', 'entry', 'log', 'entry'])
  })

  test.each(COMMANDS)('%s: AC 64: every persona stopped, Alpha after a survivor-naming kill failure and a read of ended: only the survivor version is printed, logged and recorded under persona-kill-survivor; Alpha counts as stopped, so there is no failure line and no last line; stop --stop-bots exits 0 and clean_restart starts the server', async (command, make, run) => {
    const alphaSurvivor = errTmuxKillFailed(sessionOf(alphaP), 'pane-process-survived')
    let alphaKills = 0
    const b = make({
      config: twoPersonas(),
      directorStatus: async (id) => (id === idOf(alphaP) && alphaKills > 0 ? ENDED_ROW : WAITING_ROW),
      directorPause: async () => { throw errTmuxSendKeys() },
      directorKill: async (id) => {
        if (id !== idOf(alphaP)) return cannedKillResult(true)
        alphaKills++
        throw alphaSurvivor
      },
    })

    await run(b)

    expect([b.killCalls.filter((id) => id === idOf(alphaP)), b.killCalls.filter((id) => id === idOf(betaP))]).toEqual([[idOf(alphaP)], [idOf(betaP)]])
    expectTeardownStopped(b, command, [survivorReport(command, alphaP, teardownKillFailedDescription(alphaSurvivor))])
  })

  test.each(forEachCommand(SCENARIOS))('%s: %s: each report line reaches the terminal exactly once and, for clean_restart, clean_restart.log exactly once; nothing else reaches the terminal from clean_restart, whose restart after a failed teardown is log only', async (command, _label, scenario, [, make, run]) => {
    const log: string[] = []
    const { overrides, reports } = scenario(command)
    const b = make({ ...overrides, initLogging: redirectTo(log) })

    await run(b)

    expectRun(b, command, reports)
    const failed = reports.filter((r) => r.failed).length
    const printed = [...reports.flatMap((r) => r.lines), ...(failed > 0 ? [teardownNotStoppedLine(command, failed)] : [])]
    for (const line of printed) expect([line, stderr.filter((l) => l === line).length]).toEqual([line, 1])
    if (command === CLI_COMMAND_CLEAN_RESTART) {
      expect(b.logInits).toEqual([join(stateDir, 'clean_restart.log')])
      for (const line of printed) expect([line, log.filter((l) => l === line).length]).toEqual([line, 1])
      expect(stderr).toHaveLength(printed.length)
    } else {
      expect(log).toEqual([])
    }
    assertNoLeak({ stderr, log, files: writtenTeardownLogs() })
  })

  test.each(forEachCommand(WRITE_FAILURES.flatMap(([failure, fail]) => SCENARIOS.map(([label, scenario]) => [`${failure}, ${label}`, { fail, scenario }] as const))))(
    '%s: %s: every line is still printed, the other destination still written and the exit status unchanged; each failed write is reported in one line naming its error by description only',
    async (command, _label, { fail, scenario }, [, make, run]) => {
      const error = writeError()
      const { overrides, reports } = scenario(command)
      const failure = fail(error)
      const b = make({ ...overrides, ...failure.overrides })

      await run(b)

      expectRun(b, command, reports, failure.to)
      const failedWrites = failure.to.serverLog === false ? reports.flatMap((r) => r.lines).length : reports.length
      const reported = stderr.filter((l) => l.includes(describeThrownValue(error)))
      expect(reported).toHaveLength(failedWrites)
      for (const line of reported) expect(line.startsWith(`[slack] ${command}: `)).toBe(true)
      assertNoLeak({ stderr, consoleErrorArgs: errorSpy.mock.calls, files: writtenTeardownLogs() })
    },
  )

  test.each(COMMANDS)('%s: a persona\'s teardown that rejects (its pause tries\' wait fails) is waited for and fails that persona with the rejection\'s class and description, while the other is still torn down; the last line counts 1', async (command, make, run) => {
    const sleepError = new Error(`the wait broke (${sentinelInMessage('sleep')})`)
    let alphaPaused = false
    const b = make({
      config: twoPersonas(),
      directorStatus: async () => WAITING_ROW,
      directorPause: async (id) => {
        if (id !== idOf(alphaP)) throw errTmuxSendKeys()
        alphaPaused = true
        throw errTmuxUnresponsive(PAUSE_VERB) // UNAVAILABLE: the next try waits on deps.sleep
      },
      sleep: async () => { if (alphaPaused) throw sleepError },
    })

    await run(b)

    expect([b.pauseCalls.filter((id) => id === idOf(alphaP)), b.killCalls]).toEqual([[idOf(alphaP)], [idOf(betaP)]])
    expectTeardownFailed(b, command, [failedReport(command, alphaP, sleepError, AD_ERROR_CLASS_UNAVAILABLE)])
  })

  test('production deps append the teardown\'s lines to server.log in the server\'s state directory through appendLogLine, at the time given, and record its entries with recordStartupError there with no copy on fd 2 (static; b.jg5 SRJ-909)', () => {
    const code = stripComments(readFileSync(CLI_SOURCE, 'utf-8'))
    const main = indicesOf(/\bif\s*\(\s*import\.meta\.main\s*\)/g, code)
    expect(main).toHaveLength(1)
    const mainBlock = code.slice(...balancedAfter(code, main[0]!, '{', '}'))
    const props = objectProperties(mainBlock.slice(mainBlock.indexOf('const realDeps: CliDeps =')))
    expect(props.get('appendServerLogLine')).toMatch(
      /^\(\s*(\w+)\s*,\s*(\w+)\s*\)\s*=>\s*appendLogLine\(\s*join\(\s*resolveServerStateDir\(\)\s*,\s*'server\.log'\s*\)\s*,\s*\1\s*,\s*\2\s*\)$/,
    )
    const record = props.get('recordStartupErrorEntry')
    expect(record).toMatch(/^\(\s*(\w+)\s*,\s*(\w+)\s*\)\s*=>\s*recordStartupError\(\s*\1\s*,\s*\2\s*,\s*undefined\s*,\s*\{[^}]*\}\s*\)$/)
    const options = objectProperties(record!.slice(record!.lastIndexOf('{')))
    expect([...options].sort()).toEqual([['logDir', 'resolveServerStateDir()'], ['omitStderr', 'true']])
  })
})

// ---------------------------------------------------------------------------
// The precheck's and the teardown's bounded cost on the injected clock (b.jg5
// SRJ-908; hatch note E32 bullet 4)
//
// The longest failing paths, each run with calls answering at once and with
// each call taking the call timeout: the precheck's get and read-pane each
// answer UNAVAILABLE twice and then pass; then (a) every pause try answers
// UNAVAILABLE and the kill follows with no poll, (b) the pause succeeds at
// once and the poll reads waiting until exit_timeout, or (c) the pause
// answers UNAVAILABLE on every try but the last and the poll reads waiting
// until exit_timeout; then every kill try answers UNAVAILABLE, every read
// between them failing in (a) and (b) and reading waiting in (c). Run (c)
// reaches every part of teardownBoundMs: the state read, the pause's tries,
// the poll to exit_timeout and the kill's tries with their reads. Each run's
// precheck takes no more than precheckBoundMs, and its teardown, from its
// first status read to the persona's failure, no more than teardownBoundMs,
// each for the call time the run uses (0 for calls answering at once); run
// (c) with calls answering at once takes exactly teardownBoundMs.
// ---------------------------------------------------------------------------

describe('the precheck\'s and the teardown\'s bounded cost on the injected clock (b.jg5 SRJ-908)', () => {
  const CALL_TIMEOUT_MS = DEFAULT_AGENT_DIRECTOR_CALL_TIMEOUT_MS
  const EXIT_TIMEOUT_S = 5

  interface Shape {
    /** How many pause tries answer UNAVAILABLE before one succeeds; PRECHECK_TRIES for every try. */
    readonly pauseFailures: number
    /** Whether each read between the kill tries fails; otherwise it reads `waiting`. */
    readonly killReadsFail: boolean
  }
  const SHAPE_C: Shape = { pauseFailures: PRECHECK_TRIES - 1, killReadsFail: false }
  const SHAPES: ReadonlyArray<readonly [string, Shape]> = [
    ['(a) every pause try UNAVAILABLE, every read between the kill tries failing', { pauseFailures: PRECHECK_TRIES, killReadsFail: true }],
    ['(b) a pause that succeeds and a poll reading waiting to exit_timeout, every read between the kill tries failing', { pauseFailures: 0, killReadsFail: true }],
    ['(c) a pause UNAVAILABLE on every try but the last and a poll reading waiting to exit_timeout, every read between the kill tries waiting', SHAPE_C],
  ]
  const CALL_TIMES = [['calls answering at once', 0], ['each call taking the call timeout', CALL_TIMEOUT_MS]] as const

  /** Run `command` over `shape`, each director call taking `callMs` on the fake clock. */
  async function runShape([, make, run]: Command, shape: Shape, callMs: number): Promise<Bundle> {
    let pauses = 0
    let kills = 0
    const b = make({
      config: opsConfig({ exit_timeout: EXIT_TIMEOUT_S, agent_director_call_timeout_ms: CALL_TIMEOUT_MS }),
      callMs,
      directorGet: scripted<PrecheckRow | null>(thrown(errTmuxUnresponsive(PRECHECK_CALL_GET)), thrown(errTmuxUnresponsive(PRECHECK_CALL_GET)), LIVE_ROW),
      directorReadPane: scripted(thrown(errTmuxUnresponsive(PRECHECK_CALL_READ_PANE)), thrown(errTmuxUnresponsive(PRECHECK_CALL_READ_PANE)), FAKE_PANE),
      directorPause: async () => {
        if (++pauses <= shape.pauseFailures) throw errTmuxUnresponsive(PAUSE_VERB)
      },
      directorStatus: async () => {
        if (kills > 0 && shape.killReadsFail) throw errCallTimeout(STATUS_VERB)
        return WAITING_ROW
      },
      directorKill: async () => {
        kills++
        throw errTmuxUnresponsive(KILL_VERB)
      },
    })
    await run(b)
    return b
  }

  /**
   * The teardown's span on the fake clock: from its first status read to the
   * persona's failure, which is the exit for `stop --stop-bots` and, for
   * `clean_restart`, the answer check's first `list` (b.jg5 SRJ-906), whose
   * cost is bounded on its own below.
   */
  const teardownSpanOf = (b: Bundle): number => (listTimesOf(b)[0] ?? b.exitTimes[0]!) - callTimesOf(b, STATUS_VERB)[0]!

  test.each(forEachCommand(SHAPES.flatMap(([shape, spec]) => CALL_TIMES.map(([timing, callMs]) => [`${shape}, ${timing}`, { shape: spec, callMs }] as const))))(
    '%s: %s, every kill try UNAVAILABLE: the precheck stays within precheckBoundMs and the teardown within teardownBoundMs for the run\'s call time, and each call within its tries',
    async (command, _label, { shape, callMs }, cmd) => {
      const b = await runShape(cmd, shape, callMs)

      expect(b.exitCodes).toEqual([1])
      const [firstGet] = callTimesOf(b, PRECHECK_CALL_GET)
      const lastReadPane = callTimesOf(b, PRECHECK_CALL_READ_PANE).at(-1)!
      expect(lastReadPane + callMs - firstGet!).toBeLessThanOrEqual(precheckBoundMs(callMs))
      const [firstStatus] = callTimesOf(b, STATUS_VERB)
      const teardownCalls = b.directorCallTimes.filter(([call, at]) => call !== LIST_CALL && at >= firstStatus!).length
      const span = teardownSpanOf(b)
      expect(span).toBeLessThanOrEqual(teardownBoundMs(EXIT_TIMEOUT_S, callMs))
      expect(span).toBeGreaterThanOrEqual(teardownCalls * callMs) // each call took its time

      // The path the run took: the precheck's tries, the pause's tries, the
      // poll's reads to exit_timeout (none after an escalated pause), and
      // every kill try with a read between each two.
      const pauseTimes = callTimesOf(b, PAUSE_VERB)
      expect([b.getCalls.length, b.readPaneCalls.length, pauseTimes.length]).toEqual([PRECHECK_TRIES, PRECHECK_TRIES, Math.min(shape.pauseFailures + 1, PRECHECK_TRIES)])
      const polls = shape.pauseFailures < PRECHECK_TRIES
      const pauseEnd = pauseTimes.at(-1)! + callMs
      const [firstKill] = callTimesOf(b, KILL_VERB)
      expect(callTimesOf(b, STATUS_VERB).filter((at) => at >= pauseEnd && at < firstKill!).length > 0).toBe(polls)
      expect(firstKill! - pauseEnd >= exitTimeoutMsOf(EXIT_TIMEOUT_S)).toBe(polls)
      expect(b.killCalls).toHaveLength(KILL_RETRY_TRIES)
      expect(callTimesOf(b, STATUS_VERB).filter((at) => at > firstKill!)).toHaveLength(KILL_RETRY_TRIES - 1)
      // clean_restart's answer check, agent-director answering at once: one list, then the start and the exit.
      if (command === CLI_COMMAND_CLEAN_RESTART) expect(b.exitTimes[0]! - listTimesOf(b)[0]!).toBe(callMs)
      else expect(listTimesOf(b)).toEqual([])
      assertNoLeak({ stderr, consoleErrorArgs: errorSpy.mock.calls })
    },
  )

  test.each(COMMANDS.map((cmd) => [cmd[0], cmd] as const))(
    '%s: run (c) with calls answering at once takes exactly teardownBoundMs, so the bound is reached and not passed',
    async (_command, cmd) => {
      const b = await runShape(cmd, SHAPE_C, 0)

      expect(b.exitCodes).toEqual([1])
      expect(teardownSpanOf(b)).toBe(teardownBoundMs(EXIT_TIMEOUT_S, 0))
    },
  )
})

// ---------------------------------------------------------------------------
// After a failed teardown (b.jg5 SRJ-905, SRJ-906, SRJ-1013; AC 64, AC 73,
// AC 75)
//
// `stop --stop-bots` never starts the server: a failed persona exits 1 with
// the server stopped, no `start` and no `list`. `clean_restart` checks that
// agent-director answers, one `list` of service=cscb rows made at most
// PRECHECK_TRIES times PRECHECK_TRY_SPACING_MS apart on the fake clock, any
// error a failed try, CONFIG included. If it answers, the server is started
// (a start that then fails prints its start-failed line and records nothing
// more); if not, nothing is started and the one not-restarted alert, naming
// every failed persona with its session and class, is printed (the terminal
// once, clean_restart.log once), appended as one server.log line and
// recorded as one `clean-restart-not-restarted` entry. Either way the last
// line follows the restart's outcome and the exit is 1. A teardown that
// stopped every persona, survivor version included, takes none of this
// (expectTeardownStopped: no `list`), and a failed precheck makes no `list`
// (expectNothingStopped).
// ---------------------------------------------------------------------------

describe('after a failed teardown: stop --stop-bots stays stopped, clean_restart restarts or alerts (b.jg5 SRJ-905, SRJ-906, SRJ-1013; AC 64, AC 73, AC 75)', () => {
  const [alphaP, betaP] = [ALPHA.name, BETA.name].map(personaOf) as [CliTeardownPersona, CliTeardownPersona]
  const idOf = (p: CliTeardownPersona): string => personaInstanceId(p.key)
  const sessionOf = (p: CliTeardownPersona): string => personaTmuxSessionName(p.key)

  /** One persona's injected teardown failure: the verb that fails, the value it throws and the class it is reported under. */
  interface InjectedFailure {
    readonly at: typeof PAUSE_VERB | typeof KILL_VERB
    readonly error: unknown
    readonly errorClass: AdErrorClass
  }

  /** SRJ-906's injected failures (AC 73, AC 75): a pause CONFLICT, a pause ENVIRONMENT and a kill UNAVAILABLE on every try. */
  const INJECTED: ReadonlyArray<readonly [string, (p: CliTeardownPersona) => InjectedFailure]> = [
    ['a pause answering CONFLICT', (p) => ({ at: PAUSE_VERB, error: errTmuxSessionConflict(PAUSE_VERB, 'not-this-launch', sessionOf(p)), errorClass: AD_ERROR_CLASS_CONFLICT })],
    ['a pause answering ENVIRONMENT', () => ({ at: PAUSE_VERB, error: errTmuxNotAvailable(undefined, PAUSE_VERB), errorClass: AD_ERROR_CLASS_ENVIRONMENT })],
    ['a kill answering UNAVAILABLE on every try', () => ({ at: KILL_VERB, error: errTmuxUnresponsive(KILL_VERB), errorClass: AD_ERROR_CLASS_UNAVAILABLE })],
  ]
  const [conflictAtPause, environmentAtPause, unavailableAtKill] = INJECTED.map(([, inject]) => inject) as [
    (p: CliTeardownPersona) => InjectedFailure, (p: CliTeardownPersona) => InjectedFailure, (p: CliTeardownPersona) => InjectedFailure,
  ]

  /** A CONFLICT at the pause whose description carries fake tokens: the failure line shows it redacted, the alert not at all. */
  const sentinelConflictAtPause = (): InjectedFailure => ({
    at: PAUSE_VERB,
    error: errGeneric(PAUSE_VERB, ERR_TMUX_SESSION_CONFLICT_NAME, `session refused (${sentinelInMessage('not-restarted')})`),
    errorClass: AD_ERROR_CLASS_CONFLICT,
  })

  /**
   * Every persona's row is live; each failing persona fails as injected, and
   * every other one is stopped by one kill after a pause answering GONE.
   */
  function teardownOverrides(failures: ReadonlyArray<readonly [CliTeardownPersona, InjectedFailure]>): Overrides {
    const failureOf = (id: string, at: InjectedFailure['at']): InjectedFailure | undefined =>
      failures.find(([p, f]) => idOf(p) === id && f.at === at)?.[1]
    return {
      config: makeMultiPersonaConfig(failures.length > 1 ? [ALPHA, BETA] : [ALPHA], root),
      directorStatus: async () => WAITING_ROW,
      directorPause: async (id) => { throw failureOf(id, PAUSE_VERB)?.error ?? errTmuxSendKeys() },
      directorKill: async (id) => {
        const failure = failureOf(id, KILL_VERB)
        if (failure !== undefined) throw failure.error
        return cannedKillResult(true)
      },
    }
  }

  /** The failed personas of `failures` as the not-restarted alert names them. */
  const failedPersonasOf = (failures: ReadonlyArray<readonly [CliTeardownPersona, InjectedFailure]>): CleanRestartFailedPersona[] =>
    failures.map(([persona, f]) => ({ persona, errorClass: f.errorClass }))

  /** Each failed persona's report, in configuration order. */
  const reportsOf = (command: CliTeardownCommand, failures: ReadonlyArray<readonly [CliTeardownPersona, InjectedFailure]>): ExpectedReport[] =>
    failures.map(([persona, f]) => failedReport(command, persona, f.error, f.errorClass))

  /** How many lines had been printed when `start` was spawned: wraps `b`'s spawnSync. */
  function printedAtStart(b: Bundle): () => number {
    const spawn = b.deps.spawnSync
    let printed = -1
    b.deps.spawnSync = (cmd, args) => {
      if (args.at(-1) === 'start') printed = stderr.length
      return spawn(cmd, args)
    }
    return () => printed
  }

  /** `server.log`'s lines as [fake-clock time, text], in order; none when the file was never written. */
  function serverLogLines(): Array<[at: number, text: string]> {
    if (!existsSync(logPath)) return []
    return readFileSync(logPath, 'utf-8').split('\n').filter((l) => l !== '').map((line) => {
      const m = /^\[([^\]]+)\] (.*)$/.exec(line)
      if (m === null) throw new Error(`not a server.log line: ${line}`)
      return [Date.parse(m[1]!), m[2]!]
    })
  }

  /** The answer check's lines for `n` failed `list` tries of `error`, one per try in order (b.jg5 SRJ-906). */
  const listTryLines = (n: number, error: unknown): string[] => {
    const { errorClass, description } = teardownErrorReportOf(error)
    return Array.from({ length: n }, (_, i) => answerCheckFailedTryLine(i + 1, { errorClass, description }))
  }

  /** The lines of `lines` that are answer-check lines of any try of `error`. */
  const answerCheckLinesIn = (lines: readonly string[], error: unknown): string[] => {
    const all = listTryLines(PRECHECK_TRIES, error)
    return lines.filter((l) => all.includes(l))
  }

  /**
   * `clean_restart` started nothing after `failures`, agent-director never
   * answering (b.jg5 SRJ-906, SRJ-1013): only the `stop` spawn, exit 1; on the
   * terminal exactly the failed personas' report lines, then the one
   * not-restarted alert, then the last line, each also once in
   * clean_restart.log; `server.log` holds the report lines at the teardown's
   * end and then the alert as one line at the exit; `startup-errors.log` the
   * personas' entries and then one `clean-restart-not-restarted` entry
   * holding the alert. Answers the alert.
   */
  function expectNotRestarted(b: Bundle, failures: ReadonlyArray<readonly [CliTeardownPersona, InjectedFailure]>, log: readonly string[]): string {
    const reports = reportsOf(CLI_COMMAND_CLEAN_RESTART, failures)
    const alert = cleanRestartNotRestartedAlert(failedPersonasOf(failures))
    const lines = reports.flatMap((r) => r.lines)
    const last = teardownNotStoppedLine(CLI_COMMAND_CLEAN_RESTART, failures.length)
    expect(b.spawnCalls.map((c) => c.args.at(-1))).toEqual(['stop'])
    expect(b.exitCodes).toEqual([1])
    expect(stderr).toEqual([...lines, alert, last])
    for (const line of [...lines, alert, last]) expect([line, log.filter((l) => l === line).length]).toEqual([line, 1])
    const teardownEnd = listTimesOf(b)[0]!
    expect(serverLogLines()).toEqual([...lines.map((l) => [teardownEnd, l] as [number, string]), [b.exitTimes[0]!, alert]])
    expect(startupErrorEntries()).toEqual([...reports.map((r) => r.entry), { classLabel: CLEAN_RESTART_NOT_RESTARTED_LABEL, message: alert }])
    assertNoLeak({ stderr, log, consoleErrorArgs: errorSpy.mock.calls, files: writtenTeardownLogs() })
    return alert
  }

  test.each(forEachCommand(INJECTED))('%s: %s fails the persona: exit 1 naming it, its session and the class, after the server stop; stop --stop-bots spawns no start and makes no list, so the server stays stopped (AC 75); clean_restart makes one list after the teardown, starts the server (AC 73) and prints the last line after the start', async (command, _label, inject, [, make, run]) => {
    const failure = inject(alphaP)
    const b = make(teardownOverrides([[alphaP, failure]]))
    const atStart = printedAtStart(b)

    await run(b)

    const [report] = reportsOf(command, [[alphaP, failure]])
    expectTeardownFailed(b, command, [report!])
    expect(report!.lines[0]).toContain(`: ${failure.errorClass}: `)
    const firstStatus = b.events.indexOf(`${STATUS_VERB}:${idOf(alphaP)}`)
    expect(b.events.indexOf(command === CLI_COMMAND_STOP_BOTS ? 'server:SIGTERM' : 'spawnSync:stop')).toBeLessThan(firstStatus)
    if (command === CLI_COMMAND_CLEAN_RESTART) {
      expect(stderr.indexOf(report!.lines[0]!)).toBeLessThan(atStart())
      expect(stderr.indexOf(teardownNotStoppedLine(command, 1))).toBeGreaterThanOrEqual(atStart())
    }
    assertNoLeak({ stderr, consoleErrorArgs: errorSpy.mock.calls, files: writtenTeardownLogs() })
  })

  test.each(COMMANDS)('%s: two failing personas (Alpha CONFLICT at its pause, Beta UNAVAILABLE at every kill try) are both named, each with its session and class, and the last line counts 2; stop --stop-bots stays stopped, clean_restart makes one list and one start', async (command, make, run) => {
    const failures = [[alphaP, conflictAtPause(alphaP)], [betaP, unavailableAtKill(betaP)]] as const
    const b = make(teardownOverrides(failures))

    await run(b)

    expectTeardownFailed(b, command, reportsOf(command, failures))
    expect(stderr.at(-1)).toBe(teardownNotStoppedLine(command, failures.length))
    assertNoLeak({ stderr, consoleErrorArgs: errorSpy.mock.calls, files: writtenTeardownLogs() })
  })

  test.each(Array.from({ length: PRECHECK_TRIES - 1 }, (_, i) => i + 2))('clean_restart: the list answering UNAVAILABLE before its try %p, then the rows: that many list calls PRECHECK_TRY_SPACING_MS apart from the teardown\'s end, each failed try one line naming its class, then the line before the restart and the start; exit 1', async (tries) => {
    const listError = errCallTimeout(LIST_CALL)
    const failure = environmentAtPause(alphaP)
    const b = makeDeps({
      ...teardownOverrides([[alphaP, failure]]),
      directorList: scripted<readonly never[]>(...Array.from({ length: tries - 1 }, () => thrown(listError)), []),
    })

    await settled(createCli(b.deps).clean_restart())

    const times = listTimesOf(b)
    expect(times).toEqual(Array.from({ length: tries }, (_, i) => callTimesOf(b, PAUSE_VERB, idOf(alphaP))[0]! + i * PRECHECK_TRY_SPACING_MS))
    expect(b.exitTimes).toEqual([times.at(-1)!])
    expectRestarted(b, tries)
    expect(b.exitCodes).toEqual([1])
    const starting = cleanRestartStartingAfterFailedTeardownLine()
    expect(stderr.filter((l) => l === starting)).toHaveLength(1)
    expect(answerCheckLinesIn(stderr, listError)).toEqual(listTryLines(tries - 1, listError))
    expect(stderr.indexOf(starting)).toBeGreaterThan(stderr.lastIndexOf(listTryLines(tries - 1, listError).at(-1)!))
    expect(stderr.indexOf(starting)).toBeLessThan(stderr.indexOf(teardownNotStoppedLine(CLI_COMMAND_CLEAN_RESTART, 1)))
    expect(startupErrorEntries().map((e) => e.classLabel)).not.toContain(CLEAN_RESTART_NOT_RESTARTED_LABEL)
    assertNoLeak({ stderr, consoleErrorArgs: errorSpy.mock.calls, files: writtenTeardownLogs() })
  })

  test('clean_restart: a start that fails after a failed teardown (agent-director answering) prints the start-failed line after the start and before the last line, exits 1 and records no clean-restart-not-restarted entry', async () => {
    const START_STATUS = 3
    const failure = conflictAtPause(alphaP)
    const b = makeDeps({ ...teardownOverrides([[alphaP, failure]]), spawnSyncStatus: START_STATUS })
    const atStart = printedAtStart(b)

    await settled(createCli(b.deps).clean_restart())

    const [report] = reportsOf(CLI_COMMAND_CLEAN_RESTART, [[alphaP, failure]])
    expectRestarted(b)
    expect(b.exitCodes).toEqual([1])
    const failedStart = cleanRestartStartFailedLine(START_STATUS)
    const last = teardownNotStoppedLine(CLI_COMMAND_CLEAN_RESTART, 1)
    expect(stderr.filter((l) => l.startsWith(`${CLI_COMMAND_CLEAN_RESTART}: `) || l === failedStart)).toEqual([...report!.lines, failedStart, last])
    expect(stderr.indexOf(failedStart)).toBeGreaterThanOrEqual(atStart())
    expect(stderr.at(-1)).toBe(last)
    expect(startupErrorEntries()).toEqual([report!.entry])
    expect(serverLogTexts(b.clock.now())).toEqual([...report!.lines])
    assertNoLeak({ stderr, consoleErrorArgs: errorSpy.mock.calls, files: writtenTeardownLogs() })
  })

  test.each<[string, () => unknown]>([
    ['UNAVAILABLE (ErrCallTimeout)', () => errCallTimeout(LIST_CALL)],
    ['UNAVAILABLE (a plain Error: agent-director unreachable)', () => new Error('AD connection refused')],
    ['CONFIG (ErrConfigMalformed), a failed try like any other', () => errConfigMalformed()],
  ])('clean_restart: the list answering %s at every try: exactly PRECHECK_TRIES list calls PRECHECK_TRY_SPACING_MS apart, no start, exit 1; the persona\'s report as ever, then the not-restarted alert printed once, in clean_restart.log once, in server.log once and recorded once, then the last line (AC 73)', async (_label, makeListError) => {
    const log: string[] = []
    const listError = makeListError()
    const failures = [[alphaP, sentinelConflictAtPause()]] as const
    const b = makeDeps({ ...teardownOverrides(failures), directorList: async () => { throw listError }, initLogging: redirectTo(log) })

    await settled(createCli(b.deps).clean_restart())

    const times = listTimesOf(b)
    expect(times).toEqual(Array.from({ length: PRECHECK_TRIES }, (_, i) => times[0]! + i * PRECHECK_TRY_SPACING_MS))
    expect(b.exitTimes).toEqual([times.at(-1)!])
    const alert = expectNotRestarted(b, failures, log)
    // Each failed try is one line in clean_restart.log only; the alert carries no agent-director description.
    expect(answerCheckLinesIn(log, listError)).toEqual(listTryLines(PRECHECK_TRIES, listError))
    expect(answerCheckLinesIn(stderr, listError)).toEqual([])
    expect(log).not.toContain(cleanRestartStartingAfterFailedTeardownLine())
    expect(stderr[0]).toContain(REDACTED_SENTINEL_TAIL)
    expect(alert).not.toContain(REDACTED_SENTINEL_TAIL)
  })

  // SRJ-909's best-effort writes cover the not-restarted alert too: a failed write is one line in clean_restart.log.
  test.each(WRITE_FAILURES)('clean_restart, agent-director never answering, %s: the persona\'s report and the not-restarted alert are still printed once each and the last line is still last; each failed write, the alert\'s included, is reported in one line in clean_restart.log naming its error by description only; the other destination still holds the alert; exit 1', async (_label, fail) => {
    const log: string[] = []
    const error = writeError()
    const failure = fail(error)
    const failures = [[alphaP, conflictAtPause(alphaP)]] as const
    const b = makeDeps({
      ...teardownOverrides(failures),
      directorList: async () => { throw errCallTimeout(LIST_CALL) },
      initLogging: redirectTo(log),
      ...failure.overrides,
    })

    await settled(createCli(b.deps).clean_restart())

    const reports = reportsOf(CLI_COMMAND_CLEAN_RESTART, failures)
    const lines = reports.flatMap((r) => r.lines)
    const alert = cleanRestartNotRestartedAlert(failedPersonasOf(failures))
    const last = teardownNotStoppedLine(CLI_COMMAND_CLEAN_RESTART, failures.length)
    expect(b.spawnCalls.map((c) => c.args.at(-1))).toEqual(['stop'])
    expect(b.exitCodes).toEqual([1])
    expect(stderr).toEqual([...lines, alert, last])
    const reported = log.filter((l) => l.includes(describeThrownValue(error)))
    expect(reported).toHaveLength(failure.to.serverLog === false ? lines.length + 1 : reports.length + 1)
    for (const line of reported) expect(line.startsWith(`[slack] ${CLI_COMMAND_CLEAN_RESTART}: `)).toBe(true)
    expect(serverLogLines().map(([, text]) => text)).toEqual(failure.to.serverLog === false ? [] : [...lines, alert])
    expect(startupErrorEntries()).toEqual(failure.to.startupErrors === false
      ? []
      : [...reports.map((r) => r.entry), { classLabel: CLEAN_RESTART_NOT_RESTARTED_LABEL, message: alert }])
    assertNoLeak({ stderr, log, consoleErrorArgs: errorSpy.mock.calls, files: writtenTeardownLogs() })
  })

  test('clean_restart: two failed personas (Alpha CONFLICT at its pause, Beta UNAVAILABLE at every kill try), agent-director never answering: one not-restarted alert naming both, each with its session and class, the same text printed, logged and recorded (SRJ-906)', async () => {
    const log: string[] = []
    const failures = [[alphaP, conflictAtPause(alphaP)], [betaP, unavailableAtKill(betaP)]] as const
    const b = makeDeps({ ...teardownOverrides(failures), directorList: async () => { throw errCallTimeout(LIST_CALL) }, initLogging: redirectTo(log) })

    await settled(createCli(b.deps).clean_restart())

    expect(listTimesOf(b)).toHaveLength(PRECHECK_TRIES)
    const alert = expectNotRestarted(b, failures, log)
    for (const [persona, f] of failures) {
      expect(alert).toContain(`${renderPersonaRef(persona.name, persona.key)}, session ${JSON.stringify(sessionOf(persona))}: ${f.errorClass}`)
    }
  })

  test('clean_restart: with each call taking the call timeout, the answer check that never hears agent-director ends PRECHECK_TRIES call timeouts and PRECHECK_TRIES - 1 gaps after its first list (b.jg5 SRJ-908)', async () => {
    const callMs = DEFAULT_AGENT_DIRECTOR_CALL_TIMEOUT_MS
    const b = makeDeps({ ...teardownOverrides([[alphaP, conflictAtPause(alphaP)]]), callMs, directorList: async () => { throw errCallTimeout(LIST_CALL) } })

    await settled(createCli(b.deps).clean_restart())

    const times = listTimesOf(b)
    expect(times).toEqual(Array.from({ length: PRECHECK_TRIES }, (_, i) => times[0]! + i * (callMs + PRECHECK_TRY_SPACING_MS)))
    expect(b.exitTimes[0]! - times[0]!).toBe(PRECHECK_TRIES * callMs + (PRECHECK_TRIES - 1) * PRECHECK_TRY_SPACING_MS)
    expect(startedServer(b)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// callWithCliTries: the CLI's one source of "PRECHECK_TRIES calls,
// PRECHECK_TRY_SPACING_MS apart" (b.jg5 SRJ-901, SRJ-903, SRJ-906, SRJ-908)
// ---------------------------------------------------------------------------

describe('callWithCliTries (b.jg5 SRJ-901, SRJ-903, SRJ-906, SRJ-908)', () => {
  const AGAIN = 'again'

  /** Run the tries over `answers` (the last repeating) on a fake clock: the answer, each call's time and each wait. */
  async function runTries(answers: readonly string[]): Promise<{ answer: string; callTimes: number[]; waits: number[] }> {
    const clock = createFakeClock()
    currentClock = clock
    const callTimes: number[] = []
    const waits: number[] = []
    const answer = await callWithCliTries(
      async () => {
        callTimes.push(clock.now())
        return answers[Math.min(callTimes.length - 1, answers.length - 1)]!
      },
      (a) => a.startsWith(AGAIN),
      async (ms) => {
        waits.push(ms)
        await clock.advance(ms)
      },
    )
    return { answer, callTimes, waits }
  }

  /** The times of `n` calls PRECHECK_TRY_SPACING_MS apart from 0. */
  const spaced = (n: number): number[] => Array.from({ length: n }, (_, i) => i * PRECHECK_TRY_SPACING_MS)

  test('an answer that asks for no other try: one call, no wait, that answer', async () => {
    expect(await runTries(['done'])).toEqual({ answer: 'done', callTimes: [0], waits: [] })
  })

  test('an answer that asks for another try every time: PRECHECK_TRIES calls PRECHECK_TRY_SPACING_MS apart, no wait after the last, and the last answer', async () => {
    const answers = Array.from({ length: PRECHECK_TRIES + 1 }, (_, i) => `${AGAIN}-${i + 1}`)
    expect(await runTries(answers)).toEqual({
      answer: answers[PRECHECK_TRIES - 1]!,
      callTimes: spaced(PRECHECK_TRIES),
      waits: Array.from({ length: PRECHECK_TRIES - 1 }, () => PRECHECK_TRY_SPACING_MS),
    })
  })

  test.each(Array.from({ length: PRECHECK_TRIES - 1 }, (_, i) => i + 2))('an answer that stops asking at call %p: that many calls, one wait fewer, and that answer', async (n) => {
    const answers = [...Array.from({ length: n - 1 }, () => AGAIN), 'done']
    expect(await runTries(answers)).toEqual({
      answer: 'done',
      callTimes: spaced(n),
      waits: Array.from({ length: n - 1 }, () => PRECHECK_TRY_SPACING_MS),
    })
  })

  test.each([
    ['the call', 'call'],
    ['the wait', 'sleep'],
  ] as const)('%s rejecting rejects the tries with the same value and makes no further call', async (_label, where) => {
    const failure = new Error('broken')
    let calls = 0
    const run = callWithCliTries(
      async () => {
        calls++
        if (where === 'call') throw failure
        return AGAIN
      },
      (a) => a === AGAIN,
      async () => { throw failure },
    )
    await expect(run).rejects.toBe(failure)
    expect(calls).toBe(1)
  })

  test('static (comments stripped): callWithCliTries waits only through the sleep it is given, PRECHECK_TRY_SPACING_MS at a time, bounded by PRECHECK_TRIES; the precheck\'s, the pause\'s and the answer check\'s tries each go through it with deps.sleep', () => {
    const code = stripComments(readFileSync(CLI_SOURCE, 'utf-8'))
    const bodyOf = (name: string): string => {
      const at = indicesOf(new RegExp(`\\bfunction\\s+${name}\\b`, 'g'), code)
      expect([name, at.length]).toEqual([name, 1])
      return code.slice(...balancedAfter(code, at[0]!, '{', '}'))
    }
    const helper = bodyOf('callWithCliTries')
    expect(helper).toMatch(/\bsleep\(\s*PRECHECK_TRY_SPACING_MS\s*\)/)
    expect(helper).toMatch(/\bPRECHECK_TRIES\b/)
    expect(/\bDate\.now\b|\bsetTimeout\b|\bsetInterval\b|\bdeps\./.test(helper)).toBe(false)
    for (const name of ['precheckTries', 'pauseTries', 'agentDirectorAnswers']) {
      const body = bodyOf(name)
      expect([name, /\bcallWithCliTries\([^]*\bdeps\.sleep\b/.test(body)]).toEqual([name, true])
      expect([name, /\bDate\.now\b|\bsetTimeout\b|\bsetInterval\b|\bPRECHECK_TRY_SPACING_MS\b/.test(body)]).toEqual([name, false])
    }
    expect(bodyOf('agentDirectorAnswers')).toMatch(/\bdeps\.directorList\(\s*\)/)
  })
})

// ---------------------------------------------------------------------------
// stop --stop-bots failure lines (b.av2 SR-10.3, AC 20): a failure CSCB
// authored prints its message; any other thrown value only its description
// ---------------------------------------------------------------------------

describe('stop --stop-bots failure lines (AC 20)', () => {
  /** The stderr lines holding `fragment`, each cut before its first stack frame. */
  const linesWith = (fragment: string): string[] => stderr.filter((l) => l.includes(fragment)).map((l) => l.split(' at ')[0]!)

  // b.jg5 SRJ-203: the error keeps the gate outcome's refusal kind, read from
  // the error itself (never from its label or message text).
  test.each<[StartupGateRefusalKind, string]>([
    [REFUSAL_KIND_CLIENT_TOO_OLD, AD_SYSTEM_INSTALL_TOO_OLD],
    [REFUSAL_KIND_BELOW_PHASE1_FLOOR, AD_BELOW_PHASE1_FLOOR],
    [REFUSAL_KIND_OTHER, AD_SYSTEM_INSTALL_NOT_FOUND],
  ])('StartupGateFailedError built with refusal kind %s (label %s) exposes that kind and that label', (kind, label) => {
    const gateError = new StartupGateFailedError(label, `detail for ${kind}`, kind)
    expect(gateError.refusalKind).toBe(kind)
    expect(gateError.classLabel).toBe(label)
  })

  // b.jg5 SRJ-901, SRJ-902: every gate refusal but the client's too-old one is
  // a precheck failure that stops nothing. The line is the gate's own label and
  // message (CSCB authored them, so they are printed whole).
  test.each(GATE_REFUSAL_BUILDS.filter(([kind]) => kind !== REFUSAL_KIND_CLIENT_TOO_OLD).map(([kind]) => [kind]))(
    'a startup gate refusal of kind %s prints the gate\'s class label and message on the initialization-failed line, then "nothing was stopped"; exit 1, no server signal, no director call',
    async (kind) => {
      const gateError = await wholeGateRefusal(kind)
      const b = makeLiveStopDeps({ initClient: async () => { throw gateError } })

      await expect(createCli(b.deps).stop({ stopBots: true })).rejects.toBeInstanceOf(ExitError)

      expect(stderr).toEqual([stopBotsInitFailed(gateError.message), precheckNothingStoppedLine(CLI_COMMAND_STOP_BOTS)])
      expect(stderr[0]).toContain(`(${gateError.classLabel}): `)
      expect(b.exitCodes).toEqual([1])
      expect(b.serverSignals).toEqual([])
      expect(b.directorCallTimes).toEqual([])
      assertNoLeak({ consoleErrorArgs: errorSpy.mock.calls, stderr })
    },
  )

  test('the floor-exempt gate option appears once in src/cli.ts, at stop --stop-bots\' initClient call, and clean_restart\'s initClient call passes only the call timeout; production initClient is initProductionClient, which hands the caller\'s gate options with its call timeout to the one runStartupGate call and throws StartupGateFailedError with the outcome\'s label, message and refusal kind; realDeps.initClient hands on the call timeout and the gate options, no gate seams (static; b.jg5 SRJ-203, SRJ-213, SRJ-902)', () => {
    const FLOOR_EXEMPT_OPTION: keyof StartupGateOptions = 'skipPhase1Floor'
    const CALL_TIMEOUT_OPTION: keyof StartupGateOptions = 'callTimeoutMs'
    const code = stripComments(readFileSync(CLI_SOURCE, 'utf-8'))
    /** [start, end) of the body of the one `function <name>(` in cli.ts. */
    const bodyOf = (name: string): [number, number] => {
      const at = indicesOf(new RegExp(`\\bfunction\\s+${name}\\s*\\(`, 'g'), code)
      expect([name, at.length]).toEqual([name, 1])
      return balancedAfter(code, at[0]!, '{', '}')
    }
    const within = (at: number, [from, to]: [number, number]): boolean => at >= from && at < to

    // One initClient call in each command's init path: clean_restart's passes
    // only the call timeout (the whole gate), stop --stop-bots' also the gate
    // options, holding only the floor-exempt option, set to true.
    const initCalls = indicesOf(/\bdeps\.initClient\s*\(/g, code)
    expect(initCalls).toHaveLength(2)
    const stopBotsInit = initCalls.filter((at) => within(at, bodyOf('precheckStopBots')))
    const cleanRestartInit = initCalls.filter((at) => within(at, bodyOf('clean_restart')))
    expect([stopBotsInit.length, cleanRestartInit.length]).toEqual([1, 1])
    expect(splitTopLevel(callArguments(code, cleanRestartInit[0]!))).toHaveLength(1)
    const stopBotsArgs = splitTopLevel(callArguments(code, stopBotsInit[0]!))
    expect(stopBotsArgs).toHaveLength(2)
    expect([...objectProperties(stopBotsArgs[1]!)]).toEqual([[FLOOR_EXEMPT_OPTION, 'true']])
    const optionAt = indicesOf(new RegExp(`\\b${FLOOR_EXEMPT_OPTION}\\b`, 'g'), code)
    expect(optionAt).toHaveLength(1)
    expect(within(optionAt[0]!, balancedAfter(code, stopBotsInit[0]!, '(', ')'))).toBe(true)

    // The one runStartupGate call in cli.ts is initProductionClient's, passing
    // its gate seams and an options object of the caller's gate options with
    // the call timeout set after them, so no gate option can replace it.
    const decl = indicesOf(/\bexport\s+async\s+function\s+initProductionClient\s*\(/g, code)
    expect(decl).toHaveLength(1)
    const params = splitTopLevel(callArguments(code, decl[0]!)).map((p) => p.match(/^(\w+)/)?.[1])
    expect(params).toHaveLength(3)
    const [timeoutParam, gateOptionsParam, gateDepsParam] = params
    const body = code.slice(...bodyOf('initProductionClient'))
    expect(callsOf(code, 'runStartupGate')).toHaveLength(1)
    const gateArgs = splitTopLevel(onlyCallArguments(body, 'runStartupGate'))
    expect(gateArgs).toHaveLength(2)
    expect(gateArgs[0]).toBe(gateDepsParam!)
    const longhand = (part: string): string => (/^\w+$/.test(part) ? `${part}: ${part}` : part)
    expect(splitTopLevel(gateArgs[1]!.slice(...balancedAfter(gateArgs[1]!, 0, '{', '}'))).map(longhand)).toEqual([
      `...${gateOptionsParam}`,
      `${CALL_TIMEOUT_OPTION}: ${timeoutParam}`,
    ])

    const outcome = body.match(/\bconst\s+(\w+)\s*=\s*await\s+runStartupGate\s*\(/)?.[1]
    expect(outcome).toBeDefined()
    const thrown = indicesOf(/\bnew\s+StartupGateFailedError\s*\(/g, body)
    expect(thrown).toHaveLength(1)
    expect(splitTopLevel(callArguments(body, thrown[0]!))).toEqual([
      `${outcome}.classLabel`,
      `${outcome}.message`,
      `${outcome}.refusalKind`,
    ])

    // The entry point's deps wire initClient to it, handing on the call
    // timeout and the gate options, and no gate seams.
    const main = indicesOf(/\bif\s*\(\s*import\.meta\.main\s*\)/g, code)
    expect(main).toHaveLength(1)
    const mainBlock = code.slice(...balancedAfter(code, main[0]!, '{', '}'))
    const realDepsAt = mainBlock.indexOf('const realDeps: CliDeps =')
    expect(realDepsAt).toBeGreaterThanOrEqual(0)
    const initClient = objectProperties(mainBlock.slice(realDepsAt)).get('initClient')
    expect(initClient).toMatch(/^\(\s*(\w+)\s*,\s*(\w+)\s*\)\s*=>\s*initProductionClient\(\s*\1\s*,\s*\2\s*\)$/)
  })

  test('a teardown that could not stop a persona prints the persona\'s failure line and then the last line, its count and retry advice; the underlying error, carrying fake tokens, is only described on the failure line (its class named), its message redacted, there and in server.log and startup-errors.log; no other line names the teardown\'s failure; exit 1; nothing logged leaks', async () => {
    const statusError = Object.assign(new Error(`status refused (${sentinelInMessage('status')})`), { code: 'ECONNREFUSED', note: LEAK_SENTINEL })
    const b = makeStopDeps({ directorStatus: async () => { throw statusError } })

    await expect(createCli(b.deps).stop({ stopBots: true })).rejects.toBeInstanceOf(ExitError)

    const report = failedReport(CLI_COMMAND_STOP_BOTS, OPS_PERSONA, statusError, AD_ERROR_CLASS_UNAVAILABLE)
    expectReported(b, CLI_COMMAND_STOP_BOTS, [report])
    expect(stderr.slice(-2)).toEqual([report.lines[0], teardownNotStoppedLine(CLI_COMMAND_STOP_BOTS, 1)])
    expect(report.lines[0]).toContain(`: ${AD_ERROR_CLASS_UNAVAILABLE}: Error code=ECONNREFUSED message="status refused (${REDACTED_SENTINEL_TAIL})"`)
    expect(linesWith('bot teardown failed')).toEqual([])
    expect(b.exitCodes).toEqual([1])
    assertNoLeak({ consoleErrorArgs: errorSpy.mock.calls, stderr, files: writtenTeardownLogs() })
  })

  test('no aggregate teardown failure: TeardownIncompleteError appears nowhere in src/ (static; b.jg5 SRJ-907)', () => {
    const srcDir = resolve(import.meta.dir, '..', 'src')
    const files = (readdirSync(srcDir, { recursive: true }) as string[]).filter((rel) => rel.endsWith('.ts'))
    expect(files).toContain('cli.ts') // the walk is not vacuous
    expect(files.filter((rel) => readFileSync(join(srcDir, rel), 'utf-8').includes('TeardownIncompleteError'))).toEqual([])
  })

  test.each<[string, () => unknown, string]>([
    [
      'a plain Error with a safe code',
      () => Object.assign(new Error(`gate (${sentinelInMessage('msg')})`), { code: 'EACCES', note: LEAK_SENTINEL }),
      `Error code=EACCES message="gate (${REDACTED_SENTINEL_TAIL})"`,
    ],
    [
      'a base AgentDirectorError with a safe errName',
      () => new AgentDirectorError('init', 'ErrGateBroken', `refused (${sentinelInMessage('desc', APP_TOKEN_PREFIX)})`),
      `AgentDirectorError errName=ErrGateBroken message="ErrGateBroken: refused (${REDACTED_SENTINEL_TAIL})"`,
    ],
    // The token-shaped errName is left out of the errName= field and redacted where the message quotes it.
    [
      'a base AgentDirectorError whose errName is token-shaped',
      () => new AgentDirectorError('init', fakeToken(BOT_TOKEN_PREFIX, 'errname'), `refused (${sentinelInMessage('desc', APP_TOKEN_PREFIX)})`),
      `AgentDirectorError message="<redacted-token> refused (${REDACTED_SENTINEL_TAIL})"`,
    ],
    ['a rejected string', () => `down (${sentinelInMessage('str')})`, `string message="down (${REDACTED_SENTINEL_TAIL})"`],
  ])('initClient throwing %s carrying fake tokens → the initialization-failed line names it by description, its message redacted; exit 1; nothing logged leaks', async (_label, makeErr, shown) => {
    const b = makeLiveStopDeps({
      initClient: async () => { throw makeErr() },
      directorStatus: async () => ({ state: 'waiting' }),
    })

    await expect(createCli(b.deps).stop({ stopBots: true })).rejects.toBeInstanceOf(ExitError)

    expect(linesWith('initialization failed')).toEqual([stopBotsInitFailed(shown)])
    expect(stderr.at(-1)).toBe(precheckNothingStoppedLine(CLI_COMMAND_STOP_BOTS))
    expect(b.exitCodes).toEqual([1])
    expect(b.serverSignals).toEqual([])
    expect(b.directorCallTimes).toEqual([])
    assertNoLeak({ consoleErrorArgs: errorSpy.mock.calls, stderr })
  })
})

// ---------------------------------------------------------------------------
// stop --stop-bots on a binary older than Phase 1 (b.jg5 SRJ-902, AC 75's
// part). Its init leaves CSCB's Phase 1 floor out, so on a binary the client
// accepts (OLD_AD_VERSION) the precheck and teardown run through that client.
// Only the client's own too-old refusal, read from the gate's refusal kind and
// never its label or message, stops the server alone: no precheck, no
// teardown, the initialization-failed line carrying the gate's message, then
// onlyServerStoppedLine, and exit 1 whatever the server stop returned. Any
// other init failure stops nothing; clean_restart, whose init runs the whole
// gate, has no such exception. Every gate refusal here is the real gate's,
// over passing seams and the stub client factory: no agent-director binary
// runs.
// ---------------------------------------------------------------------------

describe('stop --stop-bots on a binary older than Phase 1 (b.jg5 SRJ-902, AC 75)', () => {
  beforeEach(() => resetClientForTests())
  afterEach(() => resetClientForTests())

  const twoPersonasAtMaxCallTimeout = (): PersonaConfig =>
    makeMultiPersonaConfig([ALPHA, BETA], root, { exit_timeout: 0, agent_director_call_timeout_ms: MAX_AGENT_DIRECTOR_CALL_TIMEOUT_MS })
  const twoIds = (): string[] => [ALPHA.name, BETA.name].map((name) => personaInstanceId(personaKey(name))).sort()

  const runStopBots = (b: Bundle): Promise<void> =>
    createCli(b.deps).stop({ stopBots: true }).catch((e) => { if (!(e instanceof ExitError)) throw e })

  /**
   * `make`'s bundle for the two personas, wired as production wires it: the
   * director ops over the client singleton (`createDirectorOps(getClient)`)
   * and the production init over passing gate seams and a stub client
   * factory over `build`.
   */
  function productionWired(make: (o?: Overrides) => Bundle, build: StubCreateClientOptions): Bundle {
    return make({
      config: twoPersonasAtMaxCallTimeout(),
      initClient: (callTimeoutMs, gateOptions) =>
        initProductionClient(callTimeoutMs, gateOptions, passingGateSeams(makeStubCreateClient(build))),
      ...createDirectorOps(getClient),
    })
  }

  /** The whole gate's failure outcome for the build of `kind` in GATE_REFUSAL_BUILDS. */
  async function wholeGateFailure(kind: StartupGateRefusalKind): Promise<StartupGateFailure> {
    const outcome = await runStartupGate(passingGateSeams(makeStubCreateClient(GATE_REFUSAL_BUILDS.find(([k]) => k === kind)![1]())))
    if (outcome.ok) {
      resetClientForTests()
      throw new Error(`precondition: the whole gate refuses the ${kind} build`)
    }
    expect(outcome.refusalKind).toBe(kind)
    return outcome
  }

  /** A gate error carrying the label and message of the `from` refusal, but the refusal kind `kind`. */
  const relabelled = async (from: StartupGateRefusalKind, kind: StartupGateRefusalKind): Promise<StartupGateFailedError> => {
    const failure = await wholeGateFailure(from)
    return new StartupGateFailedError(failure.classLabel, failure.message, kind)
  }

  /**
   * Only the server was stopped, sending `signals`: no `get`, `read-pane`,
   * `status`, `pause` or `kill`, no spawn; the init asked for the
   * floor-exempt gate; the initialization-failed line carries `err`'s
   * message, before any server signal, and the last line is
   * onlyServerStoppedLine, with no "nothing was stopped" line; exit 1.
   */
  function expectOnlyServerStopped(b: Bundle, err: StartupGateFailedError, signals: readonly string[]): void {
    expect(b.exitCodes).toEqual([1])
    expect(b.serverSignals).toEqual([...signals])
    expect(b.directorCallTimes).toEqual([])
    expect(b.spawnCalls).toEqual([])
    expect(b.initClientGates).toEqual([FLOOR_EXEMPT_GATE])
    expect(stderr.filter((l) => l.startsWith(stopBotsInitFailed('')))).toEqual([stopBotsInitFailed(err.message)])
    expect(stderr.at(-1)).toBe(onlyServerStoppedLine())
    expect(stderr).not.toContain(precheckNothingStoppedLine(CLI_COMMAND_STOP_BOTS))
    const initAt = b.events.indexOf('initClient')
    expect(initAt).toBeGreaterThanOrEqual(0)
    for (const [i, e] of b.events.entries()) if (e.startsWith('server:')) expect(i).toBeGreaterThan(initAt)
    assertNoLeak({ stderr, consoleErrorArgs: errorSpy.mock.calls })
  }

  // -------------------------------------------------------------------------
  // Through the stub client, as production wires it
  // -------------------------------------------------------------------------

  test('on OLD_AD_VERSION, which the client accepts: the floor-exempt production init installs the stub with the configured call timeout, and per persona the stub gets get, a one-line readPane, status, pause and kill, in that order; the kill result with no kill_sent is a plain success, every persona is stopped and the server too; exit 0 (AC 75)', async () => {
    const log = makeStubCallLog()
    const created: RecordedClientOptions = []
    const client = makeStubClient({
      ...log,
      binaryVersion: OLD_AD_VERSION,
      getFn: (params) => cannedGetResult({ claude_instance_id: params.claude_instance_id }),
      readPaneResults: [{ pane: FAKE_PANE }],
      statusResult: cannedStatusResult({ state: 'waiting' }),
      killResult: cannedKillResult(),
    })
    // Precondition: the kill result is a pre-Phase-1 binary's, with no kill_sent field.
    expect(Object.keys(cannedKillResult())).toEqual([])
    const b = productionWired(makeLiveStopDeps, { client, calls: created })

    await runStopBots(b)

    expect(created.map((c) => c.callTimeoutMs)).toEqual([MAX_AGENT_DIRECTOR_CALL_TIMEOUT_MS])
    expect(b.initClientGates).toEqual([FLOOR_EXEMPT_GATE])
    expect(getClient() as unknown).toBe(client)
    for (const id of twoIds()) {
      const verbs = b.events.filter((e) => e.endsWith(`:${id}`)).map((e) => e.slice(0, -(id.length + 1)))
      expect([id, verbs]).toEqual([id, [PRECHECK_CALL_GET, PRECHECK_CALL_READ_PANE, 'status', 'pause', 'kill']])
    }
    const idsOf = (calls: ReadonlyArray<{ claude_instance_id: string }>): string[] => calls.map((c) => c.claude_instance_id).sort()
    expect([log.getCalls, log.statusCalls, log.pauseCalls, log.killCalls].map(idsOf)).toEqual(Array.from({ length: 4 }, twoIds))
    expect([...log.readPaneCalls].sort((a, c) => a.claude_instance_id.localeCompare(c.claude_instance_id))).toEqual(
      twoIds().map((id) => ({ claude_instance_id: id, n_lines: PROBE_PANE_READ_LINES })),
    )
    expect(stubCallCount(log)).toBe(twoIds().length * 5) // no other verb reached the stub
    expect(b.serverSignals).toEqual(['SIGTERM'])
    expect(b.exitCodes).toEqual([0])
    expect(stderr.filter((l) => /fail/i.test(l))).toEqual([])
    assertNoLeak({ stderr, consoleErrorArgs: errorSpy.mock.calls, created })
  })

  test('the same OLD_AD_VERSION stub under clean_restart, whose init runs the whole gate: CSCB\'s floor refuses it, no stub verb is called, no client is installed, nothing is stopped; exit 1', async () => {
    const log = makeStubCallLog()
    const created: RecordedClientOptions = []
    const client = makeStubClient({ ...log, binaryVersion: OLD_AD_VERSION })
    const b = productionWired(makeDeps, { client, calls: created })

    await expect(createCli(b.deps).clean_restart()).rejects.toBeInstanceOf(ExitError)

    expect(b.initClientGates).toEqual([undefined])
    expect(created.map((c) => c.callTimeoutMs)).toEqual([MAX_AGENT_DIRECTOR_CALL_TIMEOUT_MS])
    expect(stubCallCount(log)).toBe(0)
    expect(() => getClient()).toThrow()
    expect(b.directorCallTimes).toEqual([])
    expect(b.spawnCalls).toEqual([])
    expect(b.exitCodes).toEqual([1])
    const refusal = await wholeGateRefusal(REFUSAL_KIND_BELOW_PHASE1_FLOOR)
    expect(stderr).toEqual([
      agentDirectorInitFailedLine(CLI_COMMAND_CLEAN_RESTART, refusal.message),
      precheckNothingStoppedLine(CLI_COMMAND_CLEAN_RESTART),
    ])
    expect(stderr[0]).toContain(OLD_AD_VERSION)
    assertNoLeak({ stderr, consoleErrorArgs: errorSpy.mock.calls })
  })

  test('a stub client factory throwing the client\'s too-old refusal: the server is stopped, no client is installed and no verb is asked of agent-director, the initialization-failed line names the version found and the version required, then only the server was stopped; exit 1 (AC 75)', async () => {
    const created: RecordedClientOptions = []
    const b = productionWired(makeLiveStopDeps, tooOldBuild(created))

    await runStopBots(b)

    expect(created.map((c) => c.callTimeoutMs)).toEqual([MAX_AGENT_DIRECTOR_CALL_TIMEOUT_MS])
    expect(() => getClient()).toThrow()
    const refusal = await tooOldRefusal()
    expect(refusal.refusalKind).toBe(REFUSAL_KIND_CLIENT_TOO_OLD)
    expectOnlyServerStopped(b, refusal, ['SIGTERM'])
    const initLine = stderr.find((l) => l.startsWith(stopBotsInitFailed('')))!
    expect(initLine).toContain(BELOW_CLIENT_MIN_VERSION)
    expect(initLine).toContain(CLIENT_MIN_VERSION)
  })

  // -------------------------------------------------------------------------
  // The too-old branch, whatever the server stop does
  // -------------------------------------------------------------------------

  test.each<[string, (o: Overrides) => Bundle, readonly string[]]>([
    ['no server running (no PID file)', (o) => makeDeps(o), []],
    ['a stale PID file', makeStopDeps, []],
    ['a live server that stops on SIGTERM', makeLiveStopDeps, ['SIGTERM']],
    [
      'a server that stops only on SIGKILL',
      (o) => {
        const b: Bundle = makeDeps({ serverPid: 4242, config: opsConfig({ stop_timeout: 0 }), isProcessRunning: () => !b.serverSignals.includes('SIGKILL'), ...o })
        return b
      },
      ['SIGTERM', 'SIGKILL'],
    ],
    [
      'a server that survives SIGKILL (the server stop answers 1)',
      (o) => makeDeps({ serverPid: 4242, config: opsConfig({ stop_timeout: 0 }), isProcessRunning: () => true, ...o }),
      ['SIGTERM', 'SIGKILL'],
    ],
    [
      'an unreadable configuration (a live server)',
      (o) => makeLiveStopDeps({ loadConfig: () => { throw new Error('config boom') }, ...o }),
      ['SIGTERM'],
    ],
  ])('the client\'s too-old refusal with %s: only the server stop runs, no director call, the initialization-failed line then only the server was stopped; exit 1', async (_label, make, signals) => {
    const refusal = await tooOldRefusal()
    const b = make({ initClient: async () => { throw refusal } })

    await runStopBots(b)

    expect(b.initClientCalls).toEqual([DEFAULT_AGENT_DIRECTOR_CALL_TIMEOUT_MS])
    expectOnlyServerStopped(b, refusal, signals)
  })

  test('the client\'s too-old refusal with a server stop that throws: the rejection reaches the entry point\'s fatal handler (exit 1), with no "only the server" line and no director call', async () => {
    const refusal = await tooOldRefusal()
    const thrown = new Error('kill refused')
    const b = makeLiveStopDeps({ initClient: async () => { throw refusal } })
    b.deps.kill = () => { throw thrown }

    await expect(createCli(b.deps).stop({ stopBots: true })).rejects.toBe(thrown)

    expect(b.exitCodes).toEqual([])
    expect(b.directorCallTimes).toEqual([])
    expect(stderr).toEqual([stopBotsInitFailed(refusal.message)])
    // The entry point turns stop's rejection into the fatal line and exit 1 (static).
    const code = stripComments(readFileSync(CLI_SOURCE, 'utf-8'))
    const stopAt = indicesOf(/\bcli\.stop\s*\(/g, code)
    expect(stopAt).toHaveLength(1)
    expect(code.slice(stopAt[0]!)).toMatch(/^cli\.stop\(\s*\{\s*stopBots\s*\}\s*\)\.catch\(\s*\(\s*(\w+)\s*\)\s*=>\s*\{[^}]*\bprocess\.exit\(1\)/)
    assertNoLeak({ stderr, consoleErrorArgs: errorSpy.mock.calls })
  })

  // -------------------------------------------------------------------------
  // Keyed on the refusal kind, never the label or the message (SRJ-203)
  // -------------------------------------------------------------------------

  test.each<[string, StartupGateRefusalKind]>([
    ['CSCB\'s floor refusal', REFUSAL_KIND_BELOW_PHASE1_FLOOR],
    ['another construction failure', REFUSAL_KIND_OTHER],
  ])('the client-too-old kind carrying the label and message of %s still stops only the server; exit 1', async (_label, from) => {
    const err = await relabelled(from, REFUSAL_KIND_CLIENT_TOO_OLD)
    const b = makeLiveStopDeps({ initClient: async () => { throw err } })

    await runStopBots(b)

    expectOnlyServerStopped(b, err, ['SIGTERM'])
  })

  test.each<[StartupGateRefusalKind]>([[REFUSAL_KIND_BELOW_PHASE1_FLOOR], [REFUSAL_KIND_OTHER]])(
    'the client\'s too-old label and message with the %s kind is a precheck failure: no server signal, no director call, the initialization-failed line then "nothing was stopped"; exit 1',
    async (kind) => {
      const err = await relabelled(REFUSAL_KIND_CLIENT_TOO_OLD, kind)
      const b = makeLiveStopDeps({ initClient: async () => { throw err } })

      await runStopBots(b)

      expect(b.exitCodes).toEqual([1])
      expect(b.serverSignals).toEqual([])
      expect(b.directorCallTimes).toEqual([])
      expect(stderr).toEqual([stopBotsInitFailed(err.message), precheckNothingStoppedLine(CLI_COMMAND_STOP_BOTS)])
      assertNoLeak({ stderr, consoleErrorArgs: errorSpy.mock.calls })
    },
  )

  // -------------------------------------------------------------------------
  // clean_restart has no too-old exception
  // -------------------------------------------------------------------------

  test.each(GATE_REFUSAL_BUILDS.map(([kind]) => [kind]))(
    'clean_restart, whose init asks for the whole gate, refused with kind %s: no stop spawn, no director call, no start, the initialization-failed line then "nothing was stopped"; exit 1',
    async (kind) => {
      const refusal = await wholeGateRefusal(kind)
      const b = makeLiveStopDeps({ initClient: async () => { throw refusal } })

      await expect(createCli(b.deps).clean_restart()).rejects.toBeInstanceOf(ExitError)

      expect(b.initClientGates).toEqual([undefined])
      expect(b.exitCodes).toEqual([1])
      expect(b.spawnCalls).toEqual([])
      expect(b.serverSignals).toEqual([])
      expect(b.directorCallTimes).toEqual([])
      expect(stderr).toEqual([
        agentDirectorInitFailedLine(CLI_COMMAND_CLEAN_RESTART, refusal.message),
        precheckNothingStoppedLine(CLI_COMMAND_CLEAN_RESTART),
      ])
      assertNoLeak({ stderr, consoleErrorArgs: errorSpy.mock.calls })
    },
  )
})

// ---------------------------------------------------------------------------
// initProductionClient — the production init over the start gate's stubbed
// seams (b.jg5 SRJ-213); never a real agent-director client
// ---------------------------------------------------------------------------

describe('initProductionClient', () => {
  beforeEach(() => resetClientForTests())
  afterEach(() => resetClientForTests())

  test('builds the client with the call timeout it is given and installs it as the singleton', async () => {
    const calls: RecordedClientOptions = []
    const client = makeStubClient()

    await initProductionClient(MAX_AGENT_DIRECTOR_CALL_TIMEOUT_MS, undefined, passingGateSeams(makeStubCreateClient({ client, calls })))

    expect(calls.map((c) => c.callTimeoutMs)).toEqual([MAX_AGENT_DIRECTOR_CALL_TIMEOUT_MS])
    expect(getClient() as unknown).toBe(client)
    assertNoLeak({ stderr })
  })

  test.each<[StartupGateRefusalKind, string, () => StubCreateClientOptions]>([
    [REFUSAL_KIND_CLIENT_TOO_OLD, AD_SYSTEM_INSTALL_TOO_OLD, () => ({ error: errSystemInstallTooOld() })],
    [REFUSAL_KIND_BELOW_PHASE1_FLOOR, AD_BELOW_PHASE1_FLOOR, () => ({ client: makeStubClient({ binaryVersion: OLD_AD_VERSION }) })],
    [REFUSAL_KIND_OTHER, AD_SYSTEM_INSTALL_NOT_FOUND, () => ({ error: errSystemInstallNotFound() })],
  ])('the whole gate (no gate options) refusing with kind %s (label %s): the client was built with the call timeout, the thrown StartupGateFailedError keeps that kind and label, and no client is installed', async (kind, label, stub) => {
    const calls: RecordedClientOptions = []

    const err = await initProductionClient(MIN_AGENT_DIRECTOR_CALL_TIMEOUT_MS, undefined, passingGateSeams(makeStubCreateClient({ ...stub(), calls })))
      .then(() => undefined, (e: unknown) => e)

    expect(calls.map((c) => c.callTimeoutMs)).toEqual([MIN_AGENT_DIRECTOR_CALL_TIMEOUT_MS])
    expect(err).toBeInstanceOf(StartupGateFailedError)
    const gateError = err as StartupGateFailedError
    expect(gateError.refusalKind).toBe(kind)
    expect(gateError.classLabel).toBe(label)
    expect(gateError.message.startsWith(`agent-director startup gate failed (${label}): `)).toBe(true)
    expect(() => getClient()).toThrow()
    assertNoLeak({ stderr, message: gateError.message })
  })

  // b.jg5 SRJ-203, SRJ-902: the gate stop --stop-bots asks for leaves only CSCB's floor out.
  test('with the floor-exempt gate, a client reporting OLD_AD_VERSION (below CSCB\'s floor, accepted by the client) passes: built with the call timeout and installed as the singleton', async () => {
    const calls: RecordedClientOptions = []
    const client = makeStubClient({ binaryVersion: OLD_AD_VERSION })

    await initProductionClient(MAX_AGENT_DIRECTOR_CALL_TIMEOUT_MS, FLOOR_EXEMPT_GATE, passingGateSeams(makeStubCreateClient({ client, calls })))

    expect(calls.map((c) => c.callTimeoutMs)).toEqual([MAX_AGENT_DIRECTOR_CALL_TIMEOUT_MS])
    expect(getClient() as unknown).toBe(client)
    assertNoLeak({ stderr })
  })

  test('with the floor-exempt gate, the client\'s own too-old refusal still fails the gate: the client-too-old kind and label, a message naming the version found and the version required, and no client installed', async () => {
    const calls: RecordedClientOptions = []

    const err = await initProductionClient(MIN_AGENT_DIRECTOR_CALL_TIMEOUT_MS, FLOOR_EXEMPT_GATE, passingGateSeams(makeStubCreateClient(tooOldBuild(calls))))
      .then(() => undefined, (e: unknown) => e)

    expect(calls.map((c) => c.callTimeoutMs)).toEqual([MIN_AGENT_DIRECTOR_CALL_TIMEOUT_MS])
    expect(err).toBeInstanceOf(StartupGateFailedError)
    const gateError = err as StartupGateFailedError
    expect([gateError.refusalKind, gateError.classLabel]).toEqual([REFUSAL_KIND_CLIENT_TOO_OLD, AD_SYSTEM_INSTALL_TOO_OLD])
    expect(gateError.message).toContain(BELOW_CLIENT_MIN_VERSION)
    expect(gateError.message).toContain(CLIENT_MIN_VERSION)
    expect(() => getClient()).toThrow()
    assertNoLeak({ stderr, message: gateError.message })
  })
})

// ---------------------------------------------------------------------------
// credentials <persona> — the setup wizard's credentials command (b.av2 SR-12,
// SR-1.4 part). The script it runs is tests/credentials-command.test.ts's.
// ---------------------------------------------------------------------------

describe('credentials <persona>', () => {
  const opsKey = (): string => personaKey(OPS_NAME)
  const opsCredentials = (): string => join(root, 'personas', opsKey(), 'credentials.json')
  const handedOver = (name: string, path: string): string => `Credentials file of persona ${renderPersonaRef(name)}: ${path}`

  /** Nothing of the server's side was touched: no record or applied-config read, no daemon, no spawn, no agent-director. */
  function expectNoServerSide(b: Bundle): void {
    expect(b.loadPaths).toEqual([])
    expect(b.daemonSpawns).toEqual([])
    expect(b.spawnCalls).toEqual([])
    expect(b.initClientCalls).toEqual([])
    expect([b.statusCalls, b.pauseCalls, b.killCalls]).toEqual([[], [], []])
    expect(b.serverSignals).toEqual([])
  }

  test.each<[string, () => string]>([
    ['its name', () => OPS_NAME],
    ['its key', opsKey],
  ])('found by %s in config.json: names the persona and its file, runs the script for that credentials_file and exits 0 with it', async (_label, target) => {
    const b = makeDeps()

    await expect(createCli(b.deps).credentials([target()])).rejects.toBeInstanceOf(ExitError)

    expect(b.configFileLoads).toEqual([configPath])
    expect(b.credentialsRuns).toEqual([opsCredentials()])
    expect(b.events).toEqual(['loadConfigFile', 'runCredentialsScript'])
    expect(stderr).toEqual([handedOver(OPS_NAME, opsCredentials())])
    expect(b.exitCodes).toEqual([0])
    expectNoServerSide(b)
    assertNoLeak({ stderr })
  })

  test.each([1, 2, 130])("the script's exit status %d is the command's", async (status) => {
    const b = makeDeps({ credentialsScriptStatus: status })

    await expect(createCli(b.deps).credentials([OPS_NAME])).rejects.toBeInstanceOf(ExitError)

    expect(b.credentialsRuns).toEqual([opsCredentials()])
    expect(b.exitCodes).toEqual([status])
  })

  test('a ~/ credentials_file reaches the script expanded under the home directory, as the loader expands it', async () => {
    writeConfigFile(stateDir, makePersonaConfigInput({ personas: [makePersona({ name: OPS_NAME, credentials_file: '~/.config/cscb/ops.json' }, root)] }, root))
    const b = makeDeps()

    await expect(createCli(b.deps).credentials([OPS_NAME])).rejects.toBeInstanceOf(ExitError)

    expect(b.credentialsRuns).toEqual([join(root, '.config', 'cscb', 'ops.json')])
    expect(b.exitCodes).toEqual([0])
  })

  test('the persona comes from config.json as it stands, never the last-applied record: one declared but not yet confirmed is found', async () => {
    // The record holds only Ops Bot; config.json adds "newbie", not yet confirmed.
    writeFileSync(recordPath(), readFileSync(configPath))
    const newbie = makePersona({ name: 'newbie', channels: [{ id: 'C0NEW0001', delivery: 'all' }], permission_prompts: 'C0NEW0001' }, root)
    writeConfigFile(stateDir, makePersonaConfigInput({ personas: [makePersona({ name: OPS_NAME }, root), newbie] }, root))
    const b = makeDeps()

    await expect(createCli(b.deps).credentials(['newbie'])).rejects.toBeInstanceOf(ExitError)

    expect(b.configFileLoads).toEqual([configPath])
    expect(b.credentialsRuns).toEqual([join(root, 'personas', 'newbie', 'credentials.json')])
    expect(b.exitCodes).toEqual([0])
    expectNoServerSide(b)
  })

  test.each<[string, string[]]>([
    ['no persona', []],
    ['two personas', [OPS_NAME, 'another']],
    ['an empty persona', ['']],
  ])('%s: exit 2 with the usage line; nothing loaded or run', async (_label, args) => {
    const b = makeDeps()

    await expect(createCli(b.deps).credentials(args)).rejects.toBeInstanceOf(ExitError)

    expect(stderr).toEqual([CREDENTIALS_USAGE])
    expect(b.exitCodes).toEqual([2])
    expect(b.configFileLoads).toEqual([])
    expect(b.credentialsRuns).toEqual([])
    expectNoServerSide(b)
  })

  test('no persona has that name or key: exit 1, the declared personas listed, the argument never repeated (a token typed there stays off the screen), nothing run', async () => {
    const b = makeDeps()

    await expect(createCli(b.deps).credentials([fakeToken(BOT_TOKEN_PREFIX)])).rejects.toBeInstanceOf(ExitError)

    expect(stderr).toEqual([
      `credentials: no persona in ${configPath} has that name or key; declare it there first (declared: ${renderPersonaRef(OPS_NAME)})`,
    ])
    expect(b.exitCodes).toEqual([1])
    expect(b.credentialsRuns).toEqual([])
    assertNoLeak({ stderr })
  })

  test('with no persona declared, the line says declared: none', async () => {
    writeConfigFile(stateDir, { personas: [] })
    const b = makeDeps()

    await expect(createCli(b.deps).credentials(['anyone'])).rejects.toBeInstanceOf(ExitError)

    expect(stderr).toEqual([`credentials: no persona in ${configPath} has that name or key; declare it there first (declared: none)`])
    expect(b.exitCodes).toEqual([1])
  })

  test.each<[string, () => void]>([
    ['config.json missing', () => rmSync(configPath)],
    ['config.json malformed', () => writeFileSync(configPath, '{ "personas": [')],
    ['a pre-persona config.json', () => writeConfigFile(stateDir, { default_route: { cwd: join(root, 'work') } })],
    [
      'a token pasted into config.json under bot_token',
      () => writeConfigFile(stateDir, { personas: [{ ...makePersona({ name: OPS_NAME }, root), bot_token: fakeToken(BOT_TOKEN_PREFIX) }] }),
    ],
  ])("%s: exit 1 with the loader's error naming the file, no token shown, nothing run", async (_label, prepare) => {
    prepare()
    const b = makeDeps()

    await expect(createCli(b.deps).credentials([OPS_NAME])).rejects.toBeInstanceOf(ExitError)

    expect(stderr).toHaveLength(1)
    expect(stderr[0]).toStartWith(`credentials: cannot read the personas in ${configPath}: loadPersonaConfig: `)
    expect(stderr[0]).toContain(JSON.stringify(configPath))
    expect(b.exitCodes).toEqual([1])
    expect(b.credentialsRuns).toEqual([])
    expectNoServerSide(b)
    assertNoLeak({ stderr })
  })

  test('production wiring (static): the configuration file through loadPersonaConfig, the bash runner, and the script shipped beside src/', () => {
    const code = stripComments(readFileSync(CLI_SOURCE, 'utf-8'))
    const props = objectProperties(code.slice(code.indexOf('const realDeps: CliDeps =')))
    expect(props.get('loadConfigFile')).toBe('(path) => loadPersonaConfig(path)')
    expect(props.get('runCredentialsScript')).toBe('runCredentialsScript')
    expect(code).toMatch(/spawnSync\('bash', \[CREDENTIALS_SCRIPT_PATH, credentialsFile\], \{ stdio: 'inherit' \}\)/)
    expect(CREDENTIALS_SCRIPT_PATH).toBe(resolve(import.meta.dir, '..', 'scripts', 'write-credentials.sh'))
    expect(existsSync(CREDENTIALS_SCRIPT_PATH)).toBe(true)
  })

  test('the real CLI: `credentials` alone prints the usage line and exits 2', () => {
    const result = runCli(['credentials'])

    expect(result.status).toBe(2)
    expect(result.stderr).toBe(`${CREDENTIALS_USAGE}\n`)
    expect(result.stdout).toBe('')
  })

  test('the real CLI: a persona config.json does not declare exits 1 before any script runs, leaving the tree as it was', () => {
    const before = snapshotTree()

    const result = runCli(['credentials', 'nobody'])

    expect(result.status).toBe(1)
    expect(result.stderr).toContain(`credentials: no persona in ${configPath} has that name or key`)
    expect(result.output).not.toContain('bot_token (')
    expect(snapshotTree()).toEqual(before)
  })
})

// ---------------------------------------------------------------------------
// clear-latch <persona>: the entry point and the production dial (b.jg5
// SRJ-509, SRJ-510; AC 47). Each of its rows over injected deps is
// tests/clear-latch.test.ts's; its usage entry is the unknown-subcommand
// block's.
// ---------------------------------------------------------------------------

describe('clear-latch <persona>: entry point and production wiring', () => {
  test('production wiring (static): realDeps dials through dialClearLatch of src/clear-latch.ts with the port and the persona only', () => {
    const code = stripComments(readFileSync(CLI_SOURCE, 'utf-8'))
    const main = indicesOf(/\bif\s*\(\s*import\.meta\.main\s*\)/g, code)
    expect(main).toHaveLength(1)
    const mainBlock = code.slice(...balancedAfter(code, main[0]!, '{', '}'))
    const props = objectProperties(mainBlock.slice(mainBlock.indexOf('const realDeps: CliDeps =')))
    expect(props.get('dialClearLatch')).toMatch(/^\(\s*(\w+)\s*,\s*(\w+)\s*\)\s*=>\s*dialClearLatch\(\s*\1\s*,\s*\2\s*\)$/)
    expect(code).toMatch(/import\s*\{[^}]*\bdialClearLatch\b[^}]*\}\s*from\s*'\.\/clear-latch\.ts'/)
  })

  test('the real CLI: `clear-latch` alone is accepted and prints its own usage line (not the unknown-subcommand usage), exits 2 and leaves the tree as it was', () => {
    const before = snapshotTree()

    const result = runCli([CLEAR_LATCH_COMMAND])

    expect(result.status).toBe(2)
    expect(result.stderr).toBe(`${CLEAR_LATCH_USAGE}\n`)
    expect(result.stdout).toBe('')
    expect(snapshotTree()).toEqual(before)
  })

  test('the real CLI: `clear-latch <name>` with no PID file gets the argument after the subcommand, exits 1 with the no-server line and leaves the tree as it was', () => {
    const before = snapshotTree()

    const result = runCli([CLEAR_LATCH_COMMAND, OPS_NAME])

    expect(result.status).toBe(1)
    expect(result.stderr).toBe(`${clearLatchCliNoServerLine()}\n`)
    expect(result.stdout).toBe('')
    expect(snapshotTree()).toEqual(before)
  })
})

// ---------------------------------------------------------------------------
// The retired-key record: only the server writes it (b.jg5 SRJ-801)
//
// The CLI shares modules with the server (src/reload.ts, src/config.ts), so
// the check is behavioural: each command that acts runs here over a state
// directory with and without a seeded record. The CLI's own imports are also
// checked directly.
// ---------------------------------------------------------------------------

describe('no CLI command writes the retired-key record (b.jg5 SRJ-801)', () => {
  /** What could build a store or write the record; typed against the module, so a rename fails the typecheck. */
  const WRITING_NAMES: ReadonlyArray<keyof typeof RetiredKeysModule> = [
    'loadRetiredKeyStore',
    'readRetiredKeysAtStart',
    'serializeRetiredKeys',
  ]

  /**
   * The record: the Ops persona's key with its mark set (its row, which the
   * stub reports live, would clear the entry on a server read; SRJ-807), and
   * a key with no mark. Answers the file's bytes.
   */
  function seedRecord(): Uint8Array {
    writeRetiredKeysRecord(stateDir, {
      [personaKey(OPS_NAME)]: { cause: RETIRED_KEY_CAUSE_DESTRUCTIVE_MODIFY, mark: true },
      [personaKey('Retired Bot')]: { cause: RETIRED_KEY_CAUSE_REMOVED },
    })
    return new Uint8Array(readFileSync(retiredKeysPath(stateDir)))
  }

  /**
   * A bundle whose configuration is the last-applied record (copied from
   * config.json, both with stop_timeout and exit_timeout 0) read by the real
   * applied-config loader, and whose agent-director verbs are the stub
   * client's through createDirectorOps; its `status` reports every row live.
   */
  function actingDeps(o: Overrides): { b: Bundle; statusCalls: unknown[]; getCalls: unknown[]; readPaneCalls: unknown[] } {
    writeConfigFile(stateDir, makePersonaConfigInput({ personas: [makePersona({ name: OPS_NAME }, root)], stop_timeout: 0, exit_timeout: 0 }, root))
    writeFileSync(recordPath(), readFileSync(configPath))
    const statusCalls: NonNullable<StubClientOptions['statusCalls']> = []
    const getCalls: NonNullable<StubClientOptions['getCalls']> = []
    const readPaneCalls: NonNullable<StubClientOptions['readPaneCalls']> = []
    // The precheck's get reads the marked key's row live (b.jg5 SRJ-114: the CLI applies no clear).
    const client = makeStubClient({
      statusResult: cannedStatusResult({ state: 'waiting' }),
      statusCalls,
      getResult: cannedGetResult({ claude_instance_id: opsId(), state: 'waiting' }),
      getCalls,
      readPaneCalls,
    })
    const ops = createDirectorOps(() => client as unknown as DirectorClient)
    const b = makeDeps({ loadConfig: appliedLoader, ...ops, ...o })
    return { b, statusCalls, getCalls, readPaneCalls }
  }

  /** A server up at the first liveness check and gone after. */
  const upOnce = (): Overrides => {
    let calls = 0
    return { serverPid: 4242, isProcessRunning: () => ++calls === 1 }
  }

  /**
   * A running server with its `server.port` record, whose route answers that
   * the Ops persona's latch was cleared (b.jg5 SRJ-509, SRJ-510); the dial is
   * a stub, so no request is made.
   */
  const clearsOnRunningServer = (): Overrides => {
    writeServerPortRecord(serverPortFilePath(stateDir), { pid: 4242, port: 39_999 })
    const answer: ClearLatchDialAnswer = { status: 200, body: JSON.stringify({ ok: true, persona: OPS_NAME, cleared: true }) }
    return { serverPid: 4242, isProcessRunning: () => true, dialClearLatch: async () => answer }
  }

  const COMMANDS: Array<[string, () => Overrides, (b: Bundle) => Promise<void>, boolean]> = [
    ['start (pre-flight and daemon start)', () => ({}), (b) => createCli(b.deps).start(), false],
    ['stop', upOnce, (b) => createCli(b.deps).stop(), false],
    ['stop --stop-bots', upOnce, (b) => createCli(b.deps).stop({ stopBots: true }), true],
    ['clean_restart', () => ({}), (b) => createCli(b.deps).clean_restart(), true],
    ['credentials <persona>', () => ({}), (b) => createCli(b.deps).credentials([OPS_NAME]), false],
    ['clear-latch <persona> (a running server clears the latch)', clearsOnRunningServer, (b) => createCli(b.deps).clearLatch([OPS_NAME]), false],
  ]

  test.each(COMMANDS.flatMap(([label, overrides, run, readsRows]) => [
    [label, 'a seeded record is left byte-identical', overrides, run, readsRows, true] as const,
    [label, 'with no record none is created', overrides, run, readsRows, false] as const,
  ]))('%s: %s', async (_label, _outcome, overrides, run, readsRows, seeded) => {
    const before = seeded ? seedRecord() : null
    const { b, statusCalls, getCalls, readPaneCalls } = actingDeps(overrides())

    await run(b).catch((err) => { if (!(err instanceof ExitError)) throw err })

    // The command acted: the daemon spawned, the server signalled, the rows
    // prechecked, read and torn down, the script run, or clear-latch's route
    // dialled.
    expect(b.daemonSpawns.length + b.serverSignals.length + b.credentialsRuns.length + b.spawnCalls.length + b.dialCalls.length).toBeGreaterThan(0)
    if (readsRows) {
      expect(getCalls).toEqual([{ claude_instance_id: opsId() }])
      expect(readPaneCalls).toEqual([{ claude_instance_id: opsId(), n_lines: PROBE_PANE_READ_LINES }])
      expect(statusCalls.length).toBeGreaterThan(0)
      expect(b.killCalls).toEqual([opsId()])
    } else {
      expect([getCalls, readPaneCalls, statusCalls]).toEqual([[], [], []])
    }
    const path = retiredKeysPath(stateDir)
    if (before === null) expect(existsSync(path)).toBe(false)
    else expect(new Uint8Array(readFileSync(path)) as Uint8Array).toEqual(before)
  })

  test('src/cli.ts names no store factory, start read or serialiser of the record module, so it imports none (static)', () => {
    const code = stripComments(readFileSync(CLI_SOURCE, 'utf-8'))
    for (const name of WRITING_NAMES) expect([name, indicesOf(new RegExp(`\\b${name}\\b`, 'g'), code)]).toEqual([name, []])
  })
})

// ---------------------------------------------------------------------------
// unknown subcommand — regression for b.8tm (trail subcommand removed), and
// the unadvertised reload gesture (b.av2 SR-8.8, AC 74 cli leg)
// ---------------------------------------------------------------------------

/**
 * The subcommand and flag entries of the usage text, with its wording ignored.
 * Every indented line is an entry, named by its first word: a subcommand
 * outside a `<name> flags:` section, a flag inside one. Anything else (a flag
 * outside a section, a non-flag inside one) is `unexpected`.
 */
function usageEntries(output: string): {
  synopsis: string[]
  listed: string[]
  flags: Record<string, string[]>
  unexpected: string[]
  allFlags: string[]
} {
  const lines = output.split('\n')
  const synopsis = (lines.find((l) => /^Usage:/.test(l))?.match(/<([^>]*)>/)?.[1] ?? '').split('|').filter(Boolean)
  const listed: string[] = []
  const flags: Record<string, string[]> = {}
  const unexpected: string[] = []
  let section: string | undefined
  for (const line of lines) {
    if (/^\S/.test(line)) {
      section = line.match(/^(\S+) flags:\s*$/)?.[1]
      continue
    }
    const name = line.match(/^\s+(\S+)/)?.[1]
    if (name === undefined) continue // a blank line
    const isFlag = name.startsWith('-')
    if (section === undefined && !isFlag) listed.push(name)
    else if (section !== undefined && isFlag) (flags[section] ??= []).push(name)
    else unexpected.push(name)
  }
  const allFlags = [...output.matchAll(/(?:^|\s)(--?[A-Za-z][\w-]*)/g)].map((m) => m[1]!)
  return { synopsis, listed, flags, unexpected, allFlags }
}

/**
 * Run the real CLI script in a child process (b.av2 SR-13.2, b.jg5 SRJ-1302):
 * its env is a direct `hostSafeChildEnv` call, so the child gets the temp HOME
 * (the per-test root by default), a PATH naming no directory (Bun is started
 * by absolute path and the CLI runs nothing by name on these paths), its own
 * TMUX_TMPDIR, the state dir and nothing else from process.env (no token, no
 * agent-director install on HOME or PATH); bounded. Bun's transpiler cache is
 * off, so the child writes nothing under the temp HOME (`.bun/install/cache`)
 * that a tree snapshot would mistake for the CLI's doing.
 */
function runCli(args: string[], home = root) {
  const result = spawnSync(process.execPath, [CLI_SOURCE, ...args], {
    encoding: 'utf-8',
    env: hostSafeChildEnv(home, {
      tools: [],
      extras: { SLACK_STATE_DIR: join(home, 'state'), BUN_RUNTIME_TRANSPILER_CACHE_PATH: '0' },
    }),
    timeout: 15_000,
  })
  // Spawned, and not killed by the time limit, so `status` is the CLI's own exit code.
  expect(result.error).toBeUndefined()
  expect(result.signal).toBeNull()
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '', output: (result.stderr ?? '') + (result.stdout ?? '') }
}

describe('unknown subcommand', () => {
  test('`trail` hits the usage error (non-zero exit; no "trail", retired reconcile flag, token variable or reload wording in usage; AC 74)', () => {
    const result = runCli(['trail'])
    expect(result.status).not.toBe(0)
    const output = result.output
    expect(output).toContain('Usage:')
    expect(output).not.toMatch(/\btrail\b/)
    expect(output).not.toContain('--reconcile-instance-ids')
    expect(output).not.toContain('CSCB_RECONCILE_INSTANCE_IDS')
    for (const name of TOKEN_VARS) expect(output).not.toContain(name)
    expect(output).toContain('start')
    expect(reloadTermsIn(output)).toEqual([])
  })

  test('AC 74, AC 47: no arguments exits non-zero with usage listing exactly start, stop, clean_restart, credentials and clear-latch (with SRJ-509\'s line), and only --stop-bots, under stop, with no reload wording', () => {
    const result = runCli([])

    expect(result.status).not.toBe(0)
    // The printed usage is the exported text, line for line, on stderr only.
    expect(result.stderr).toBe(CLI_USAGE_LINES.map((line) => `${line}\n`).join(''))
    expect(result.stdout).toBe('')
    const usage = usageEntries(result.output)
    expect(usage.synopsis.sort()).toEqual(['clean_restart', 'clear-latch', 'credentials', 'start', 'stop'])
    expect(usage.listed.sort()).toEqual(['clean_restart', 'clear-latch', 'credentials', 'start', 'stop'])
    expect(usage.flags).toEqual({ stop: ['--stop-bots'] })
    expect(usage.unexpected).toEqual([])
    expect(usage.allFlags).toEqual(['--stop-bots'])
    expect(reloadTermsIn(result.output)).toEqual([])
    // b.jg5 SRJ-509: clear-latch's one entry is the exported one (its wording is
    // pinned against SRJ-509's line in tests/clear-latch.test.ts's pin table).
    expect(result.stderr.split('\n').filter((line) => /^\s+clear-latch\b/.test(line))).toEqual([CLEAR_LATCH_USAGE_ENTRY])
  })

  describe('AC 74: hidden subcommands', () => {
    /** The no-argument usage (stderr), captured once in its own temp home. */
    let noArgUsage: string
    beforeAll(() => {
      const home = mkdtempSync(join(tmpdir(), 'cscb-cli-usage-'))
      try {
        noArgUsage = runCli([], home).stderr
        expect(noArgUsage).toStartWith('Usage:')
      } finally {
        rmSync(home, { recursive: true, force: true })
      }
    })

    test.each(['reload', 'apply', 'confirm', 'reload-config', 'Reload', 'apply_config'])(
      'AC 74: hidden subcommand `%s` takes the unknown-subcommand path: non-zero exit, the same usage, nothing else done (a pending file stays put)',
      (spelling) => {
        // A pending change is waiting, so a hidden confirm (pending renamed to
        // apply) or any other touch of it shows in the snapshot.
        writeFileSync(`${configPath}.pending`, readFileSync(configPath))
        const before = snapshotTree()

        const result = runCli([spelling])

        expect(result.status).not.toBe(0)
        expect(result.stderr).toBe(noArgUsage)
        expect(result.stdout).toBe('')
        expect(snapshotTree()).toEqual(before)
      },
    )
  })
})
