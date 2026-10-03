/**
 * cli.test.ts — Coverage for the CLI surface (`start`, `stop`,
 * `clean_restart`, `credentials`) at the createCli factory level, with all
 * I/O injected. `credentials <persona>` finds the persona by name or key in
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
 * `unknown subcommand` block (and its hidden-subcommand `beforeAll`) and the
 * two real-CLI tests of `credentials` (a usage error and an unknown persona,
 * neither of which reaches the script), which
 * run the CLI script through `runCli`, whose env is a direct `hostSafeChildEnv`
 * call (temp HOME, no PATH directory, its own TMUX_TMPDIR, plus temp
 * SLACK_STATE_DIR and BUN_RUNTIME_TRANSPILER_CACHE_PATH=0). Waits in `start` and
 * `stop` (the daemon startup wait, the SIGTERM and SIGKILL polls), the
 * precheck's tries and the teardown's pause tries and poll run on the
 * per-test fake clock; none waits in real time, and no case leaves a timer
 * pending.
 *
 * The precheck (b.jg5 SRJ-901): before `stop --stop-bots` or `clean_restart`
 * stops anything, one `get` and, for a live row, one one-line `read-pane` of
 * each persona's `cscb_<key>` (the fixture's `directorGet` and
 * `directorReadPane`, by default a live `waiting` row and a pane). The
 * verdict over each answer is tests/cli-teardown.test.ts's.
 *
 * The teardown (b.jg5 SRJ-903, SRJ-119): after a passed precheck and the
 * server stop, each persona's `status` read, its `pause` decided by class
 * (GONE and every other answer escalate to one kill, UNAVAILABLE is tried
 * three times 2 s apart, CONFLICT, ENVIRONMENT, UNUSABLE NAME, another
 * `ErrInternal` and CONFIG fail with no kill) and the poll after it. The
 * fixture records each director call's fake-clock time, and `scripted`
 * gives a verb its answers in call order. The verdicts per answer are
 * tests/cli-teardown.test.ts's.
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
  CREDENTIALS_SCRIPT_PATH,
  CREDENTIALS_USAGE,
  DAEMON_FAILURE_LOG_LINES,
  DAEMON_STARTUP_POLL_MS,
  DAEMON_STARTUP_WAIT_MS,
  STOP_KILL_WAIT_MS,
  STOP_POLL_MS,
  StartupGateFailedError,
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
  AD_CONFIG_FILE_DISPLAY_NAME,
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
  TEARDOWN_POLL_MAX_WAIT_MS,
  TEARDOWN_STEP_KILL,
  TEARDOWN_STEP_PAUSE,
  TEARDOWN_STEP_POLL,
  TEARDOWN_STEP_STATE_READ,
  onlyServerStoppedLine,
  precheckFailureLine,
  precheckNothingStoppedLine,
  precheckVerdictOf,
  teardownErrorReportOf,
  type CliTeardownCommand,
  type PrecheckCall,
  type PrecheckFailure,
  type PrecheckRow,
  type TeardownStep,
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
  ERR_TMUX_SESSION_CONFLICT_NAME,
  ErrCallTimeout,
  ErrSpawnNotFound,
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
import { getClient, resetClientForTests } from '../src/agent-director-client.ts'
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
import { personaInstanceId, personaKey, personaTmuxSessionName, renderPersonaRef } from '../src/persona-identity.ts'
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
} from './test-helpers/credentials.ts'
import { createFakeClock, type FakeClock } from './test-helpers/fake-clock.ts'
import {
  CONFLICT_CASES,
  SAMPLE_LAUNCH_START_DEFAULT,
  STUB_TMUX_SOCKET_PATH,
  UNAVAILABLE_FORMS,
  UNUSABLE_NAME_FAULTS,
  cannedGetResult,
  cannedKillResult,
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

beforeEach(() => {
  currentClock = null
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
  directorKill?: (id: string) => Promise<void>
  /** `credentials`' loader of the configuration file; default the real `loadPersonaConfig` with the temp root as home. */
  loadConfigFile?: (path: string) => PersonaConfig
  /** The credentials script's exit status the fake runner returns; default 0. */
  credentialsScriptStatus?: number
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
  /** Each director call (`get`, `read-pane`, `status`, `pause`, `kill`) as `<verb>:<id>`, with its fake-clock time. */
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
  /** Record one director call in the event order with its fake-clock time. */
  const directorCall = (call: string): void => {
    events.push(call)
    directorCallTimes.push([call, clock.now()])
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
      await clock.advance(ms)
    },
    unlinkSync: () => { /* the stale PID file stays; nothing reads it again */ },
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
      directorCall(`${PRECHECK_CALL_GET}:${id}`)
      return o.directorGet ? o.directorGet(id) : LIVE_ROW
    },
    directorReadPane: async (id, nLines) => {
      readPaneCalls.push([id, nLines])
      directorCall(`${PRECHECK_CALL_READ_PANE}:${id}`)
      return o.directorReadPane ? o.directorReadPane(id, nLines) : FAKE_PANE
    },
    directorStatus: async (id) => {
      statusCalls.push(id)
      directorCall(`status:${id}`)
      return o.directorStatus ? o.directorStatus(id) : null
    },
    directorPause: async (id) => {
      pauseCalls.push(id)
      directorCall(`pause:${id}`)
      if (o.directorPause) return o.directorPause(id)
    },
    directorKill: async (id) => {
      killCalls.push(id)
      directorCall(`kill:${id}`)
      if (o.directorKill) return o.directorKill(id)
    },
  }
  return {
    deps, clock, exitCodes, exitTimes, spawnCalls, daemonSpawns, logOpens, closedFds, logInits, loadPaths,
    getCalls, readPaneCalls, directorCallTimes, statusCalls, pauseCalls, killCalls,
    serverSignals, events, initClientCalls, initClientGates, configFileLoads, credentialsRuns,
    get startServerCalled() { return startServerCalled },
  }
}

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

/** The start of `stop --stop-bots`' initialization-failed line; the failure's description follows. */
const STOP_BOTS_INIT_FAILED = '[slack] stop --stop-bots: agent-director initialization failed: '

const startedServer = (b: Bundle): boolean => b.spawnCalls.some((c) => c.args.includes('start'))

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

/**
 * The per-persona teardown failure line `teardownBots` logs for the persona
 * named `persona` whose teardown failed at `step` with `error` (b.jg5
 * SRJ-903): the persona, the step, the classifier's class and the reported,
 * redacted description (SRJ-104), as `teardownErrorReportOf` renders them.
 */
function teardownFailureLogLine(persona: string, step: TeardownStep, error: unknown): string {
  const report = teardownErrorReportOf(error)
  return `[slack] teardownBots: agent-director error during teardown of persona ${renderPersonaRef(persona, personaKey(persona))}, ` +
    `step ${step}: ${report.errorClass}: ${report.description}`
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
    expect(code).toMatch(/import\s*\{\s*initLogging\s*\}\s*from\s*'\.\/logging\.ts'/)
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
  const twoPersonas = (): PersonaConfig => makeMultiPersonaConfig([ALPHA, BETA], root)
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

  test('one persona failing loudly still lets the other be torn down; the aggregate counts one persona', async () => {
    const b = makeDeps({
      config: twoPersonas(),
      directorStatus: async (id) => {
        if (id === alphaId()) throw errCallTimeout('status')
        return { state: 'waiting' }
      },
      directorPause: async () => { throw errTmuxSendKeys() }, // GONE: one pause, then the kill (b.jg5 SRJ-903)
    })
    await expect(createCli(b.deps).clean_restart()).rejects.toBeInstanceOf(ExitError)
    expect(b.killCalls).toEqual([betaId()])
    expect(b.exitCodes).toEqual([1])
    expect(stderr.join('\n')).toContain('teardown incomplete for 1 persona(s)')
    expect(startedServer(b)).toBe(false)
  })

  // AC 20 (b.av2 SR-10.3): the pause-escalation, timeout-path "kill failed"
  // and per-persona teardown failure lines log each error's description
  // (b.jg5 SRJ-104: the reported name and redacted description of an
  // agent-director error, else its type, safe code, message through
  // `redactSlackLogText` and frames), never the error itself; the failure
  // line also names the persona, the step and the class (b.jg5 SRJ-903). The
  // errors carry fake tokens (in a message, with a URL); the raw
  // console.error arguments are checked. With a successful pause and
  // `exit_timeout: 0` the poll loop never runs, so the timeout path's kill is
  // reached at once.
  /** {@link teardownFailureLogLine}, cut before its first stack frame. */
  const failureLine = (persona: string, step: TeardownStep, error: unknown): string =>
    teardownFailureLogLine(persona, step, error).split(' at ')[0]!

  test('AC 20: a pause answering UNAVAILABLE on every try and then its escalation kill failing, with errors carrying fake tokens — the pause and teardown lines name each error with its message redacted; clean_restart exits 1; nothing logged leaks', async () => {
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
    expect(line('error during teardown').map((l) => l.split(' at ')[0])).toEqual([failureLine(OPS_NAME, TEARDOWN_STEP_KILL, killError)])
    expect(line('error during teardown')[0]).toContain(`step ${TEARDOWN_STEP_KILL}: ${AD_ERROR_CLASS_UNCLASSIFIED}: ErrKillBroken message="kill refused (${REDACTED_SENTINEL_TAIL})"`)
    expect(b.exitCodes).toEqual([1])
    expect(startedServer(b)).toBe(false)
    assertNoLeak({ consoleErrorArgs: errorSpy.mock.calls, stderr })
  })

  test('AC 20: a timeout-path kill failing with an error carrying fake tokens — the "kill failed" and teardown lines name the error with its message redacted; clean_restart exits 1; nothing logged leaks', async () => {
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
    expect(b.killCalls).toEqual([opsId()])
    expect(line('kill failed').map((l) => l.split(' at ')[0])).toEqual([
      `[slack] teardownBots: kill failed for persona ${ref}: Error code=ECONNRESET message="kill refused (${REDACTED_SENTINEL_TAIL})"`,
    ])
    expect(line('error during teardown').map((l) => l.split(' at ')[0])).toEqual([failureLine(OPS_NAME, TEARDOWN_STEP_KILL, killError)])
    expect(line('error during teardown')[0]).toContain(
      `step ${TEARDOWN_STEP_KILL}: ${AD_ERROR_CLASS_UNAVAILABLE}: Error code=ECONNRESET message="kill refused (${REDACTED_SENTINEL_TAIL})"`,
    )
    expect(b.exitCodes).toEqual([1])
    expect(startedServer(b)).toBe(false)
    assertNoLeak({ consoleErrorArgs: errorSpy.mock.calls, stderr })
  })
})

// ---------------------------------------------------------------------------
// clean_restart — SR-11 Event 12 — pause + poll + escalate
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

  test('pauses + reports cleanly when status transitions to terminal', async () => {
    let n = 0
    const b = makeDeps({
      directorStatus: async () => (++n === 1 ? { state: 'waiting' } : { state: 'ended' }), // precheck → terminal
    })
    await createCli(b.deps).clean_restart()
    expect(b.pauseCalls).toEqual([opsId()])
    expect(b.killCalls).toEqual([])
  })

  test('escalates to kill on a pause failure that escalates (GONE: one pause, then one kill)', async () => {
    const b = makeDeps({
      directorStatus: async () => ({ state: 'waiting' }),
      directorPause: async () => { throw errTmuxSendKeys() },
    })
    await createCli(b.deps).clean_restart()
    expect(b.pauseCalls).toEqual([opsId()])
    expect(b.killCalls).toEqual([opsId()])
  })

  // b.dnt: AD dies between the precheck and the pause. The escalation kill also
  // throws a non-ErrSpawnNotFound error; it rejects into the allSettled
  // aggregate → loud throw → clean_restart exit(1), no start.
  test('b.dnt: escalation kill failing (non-ErrSpawnNotFound) rejects loudly (AD died mid-teardown)', async () => {
    const b = makeDeps({
      directorStatus: async () => ({ state: 'waiting' }),
      directorPause: async () => { throw errTmuxSendKeys() },
      directorKill: async () => { throw errCallTimeout('kill') },
    })
    await expect(createCli(b.deps).clean_restart()).rejects.toBeInstanceOf(ExitError)
    expect(b.killCalls).toEqual([opsId()])
    expect(b.exitCodes).toContain(1)
    expect(startedServer(b)).toBe(false)
  })

  // b.dnt: the benign already-gone ErrSpawnNotFound race stays per-persona handled.
  test('b.dnt: escalation kill failing with ErrSpawnNotFound stays quiet (benign already-gone race)', async () => {
    const b = makeDeps({
      directorStatus: async () => ({ state: 'waiting' }),
      directorPause: async () => { throw errTmuxSendKeys() },
      directorKill: async () => { throw errSpawnNotFound() },
    })
    await createCli(b.deps).clean_restart()
    expect(b.killCalls).toEqual([opsId()])
    expect(b.exitCodes).not.toContain(1)
    expect(startedServer(b)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// clean_restart — clean_restart.log, with fatal lines also on the terminal
// ---------------------------------------------------------------------------

describe('clean_restart — clean_restart.log and the terminal', () => {
  /** An initLogging that sends console.error to `log`, as the real one sends it to the file. */
  const redirectTo = (log: string[]) => (): void => {
    console.error = (...args: unknown[]) => { log.push(formatLine(args)) }
  }

  /** Each case's fatal lines, in order: each terminal line starts with its entry. */
  const FATAL: Array<[string, Overrides, () => string[]]> = [
    ['config load fails', { loadConfig: () => { throw new Error('config boom') } }, () => ['[slack] clean_restart: failed to load config: config boom']],
    // b.jg5 SRJ-901: an initialization failure is a precheck failure; it stops nothing and says so.
    [
      'agent-director initialization fails',
      { initClient: async () => { throw new Error('startup gate failed') } },
      () => [
        '[slack] clean_restart: agent-director initialization failed: startup gate failed',
        precheckNothingStoppedLine(CLI_COMMAND_CLEAN_RESTART),
      ],
    ],
    [
      'teardown fails',
      { directorStatus: async () => { throw new Error('AD connection refused') } },
      () => ['[slack] clean_restart: bot teardown failed — aborting restart: teardownBots: agent-director error'],
    ],
    // stop's non-zero exit is a non-fatal line: log only.
    ['start fails', { spawnSyncStatus: 3 }, () => ['[slack] clean_restart: start failed with exit code 3']],
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
    expect(stderr.filter((l) => l === '[slack] clean_restart: start failed with exit code 3')).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// createDirectorOps — the production director deps (b.qwo, b.dnt)
// ---------------------------------------------------------------------------

describe('createDirectorOps', () => {
  const OPS: Array<keyof DirectorOps> = ['directorGet', 'directorReadPane', 'directorStatus', 'directorPause', 'directorKill']

  /** The `get` row the fake Client answers: a live row carrying a note and a launch start, so each field read shows. */
  const GET_ROW: PrecheckRow = { state: 'pending', liveness_note: provenanceNote, launch_started_at: SAMPLE_LAUNCH_START_DEFAULT }

  /** A fake Client whose verbs record [verb, request] and throw `fail` when given. */
  function fakeClient(fail?: unknown): { client: DirectorClient; calls: Array<[string, unknown]> } {
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
      kill: verb('kill', {}),
    }
    return { client: client as unknown as DirectorClient, calls }
  }

  /** Call `op` on `ops` for the Ops persona; `directorReadPane` with the one-line count. */
  const callOp = (ops: DirectorOps, op: keyof DirectorOps): Promise<unknown> =>
    op === 'directorReadPane' ? ops.directorReadPane(opsId(), PROBE_PANE_READ_LINES) : ops[op](opsId())

  const notFound = (): Error => new ErrSpawnNotFound('status', 'ErrSpawnNotFound', 'row gone')
  const refused = (): Error => new Error('AD connection refused')
  const timeout = (): Error => new ErrCallTimeout('status', 35000, 30000)

  test.each([
    ['directorGet', 'ErrSpawnNotFound', 'resolves null', notFound],
    ['directorGet', 'a connection error', 'rejects', refused],
    ['directorGet', 'ErrCallTimeout', 'rejects', timeout],
    ['directorReadPane', 'ErrSpawnNotFound', 'rejects', notFound],
    ['directorReadPane', 'a connection error', 'rejects', refused],
    ['directorReadPane', 'ErrCallTimeout', 'rejects', timeout],
    ['directorStatus', 'ErrSpawnNotFound', 'resolves null', notFound],
    ['directorStatus', 'a connection error', 'rejects', refused],
    ['directorStatus', 'ErrCallTimeout', 'rejects', timeout],
    ['directorKill', 'ErrSpawnNotFound', 'resolves', notFound],
    ['directorKill', 'a connection error', 'rejects', refused],
    ['directorKill', 'ErrCallTimeout', 'rejects', timeout],
    ['directorPause', 'ErrSpawnNotFound', 'rejects', notFound],
    ['directorPause', 'a connection error', 'rejects', refused],
    ['directorPause', 'ErrCallTimeout', 'rejects', timeout],
  ] as const)('%s when the Client throws %s: %s', async (op, _name, outcome, makeErr) => {
    const err = makeErr()
    const call = callOp(createDirectorOps(() => fakeClient(err).client), op)
    if (outcome === 'rejects') await expect(call).rejects.toBe(err)
    else expect(await call).toBe(outcome === 'resolves null' ? null : undefined)
  })

  // b.jg5 SRJ-117, SRJ-901: the precheck classifies every read-pane error itself (ErrSpawnNotFound takes the GONE
  // column), and every get error but ErrSpawnNotFound; each reaches it as the same value, built by name.
  const PRECHECK_ERRORS: Array<[string, () => unknown]> = [
    ['ErrTmuxSessionConflict', () => errTmuxSessionConflict(PRECHECK_CALL_READ_PANE, 'not-this-launch')],
    ['the unusable-name ErrInternal', () => errUnusableName()],
    ['ErrConfigMalformed', () => errConfigMalformed()],
    ['ErrTmuxCaptureFailed', () => errTmuxCaptureFailed()],
  ]
  test.each([...PRECHECK_ERRORS, ['the stub\'s ErrSpawnNotFound', () => errSpawnNotFound()] as [string, () => unknown]])(
    'directorReadPane rejects with the same value when the Client throws %s',
    async (_label, make) => {
      const err = make()
      await expect(createDirectorOps(() => fakeClient(err).client).directorReadPane(opsId(), PROBE_PANE_READ_LINES)).rejects.toBe(err)
    },
  )

  test.each(PRECHECK_ERRORS)('directorGet rejects with the same value when the Client throws %s', async (_label, make) => {
    const err = make()
    await expect(createDirectorOps(() => fakeClient(err).client).directorGet(opsId())).rejects.toBe(err)
  })

  test('directorGet resolves null for the stub\'s ErrSpawnNotFound (recognised by name)', async () => {
    expect(await createDirectorOps(() => fakeClient(errSpawnNotFound()).client).directorGet(opsId())).toBeNull()
  })

  test.each(OPS)('%s rejects with getClient\'s own error when getClient throws (no Client installed)', async (op) => {
    const err = new Error('agent-director client not initialized')
    await expect(callOp(createDirectorOps(() => { throw err }), op)).rejects.toBe(err)
  })

  test('getClient is called on every op (a Client installed later is used); each verb gets cscb_<key> as claude_instance_id, read-pane the given n_lines; get answers the row\'s state, note and launch start, read-pane the pane', async () => {
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
    await ops.directorKill(opsId())

    expect(gets).toBe(6)
    const req = { claude_instance_id: opsId() }
    expect(calls).toEqual([
      ['get', req],
      ['readPane', { ...req, n_lines: PROBE_PANE_READ_LINES }],
      ['status', req],
      ['pause', req],
      ['kill', req],
    ])
    assertNoLeak({ calls })
  })

  test('production deps take directorGet / directorReadPane / directorStatus / directorPause / directorKill from createDirectorOps(getClient) (static)', () => {
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
  test('stopBots: per-persona pause runs and server still stops', async () => {
    let n = 0
    const b = makeStopDeps({
      directorStatus: async () => (++n === 1 ? { state: 'waiting' } : { state: 'ended' }),
    })
    await expect(createCli(b.deps).stop({ stopBots: true })).rejects.toBeInstanceOf(ExitError)
    expect(b.pauseCalls).toEqual([opsId()])
    expect(b.killCalls).toEqual([])
    expect(b.statusCalls[0]).toBe(opsId())
    expect(b.exitCodes).toContain(0)
  })

  test('stopBots: pause timeout escalates to kill, server still stops', async () => {
    const b = makeStopDeps({ config: opsConfig({ exit_timeout: 0 }), directorStatus: async () => ({ state: 'waiting' }) })
    await expect(createCli(b.deps).stop({ stopBots: true })).rejects.toBeInstanceOf(ExitError)
    expect(b.pauseCalls).toEqual([opsId()])
    expect(b.killCalls).toEqual([opsId()]) // exit_timeout=0 → immediate kill escalation
    expect(b.exitCodes).toContain(0)
  })

  // b.dnt: timeout-path kill failing with a non-benign error rejects into the
  // aggregate → exit(1), not the stale-PID exit(0).
  test('stopBots: timeout-path kill failing (non-ErrSpawnNotFound) rejects loudly (b.dnt)', async () => {
    const b = makeStopDeps({
      config: opsConfig({ exit_timeout: 0 }),
      directorStatus: async () => ({ state: 'waiting' }),
      directorPause: async () => { /* pause succeeds */ },
      directorKill: async () => { throw new ErrCallTimeout('kill', 35000, 30000) },
    })
    await expect(createCli(b.deps).stop({ stopBots: true })).rejects.toBeInstanceOf(ExitError)
    expect(b.pauseCalls).toEqual([opsId()])
    expect(b.killCalls).toEqual([opsId()])
    expect(b.exitCodes).toContain(1)
  })

  // b.dnt: the benign ErrSpawnNotFound race on the timeout path stays quiet.
  test('stopBots: timeout-path kill failing with ErrSpawnNotFound stays quiet, server still stops (b.dnt)', async () => {
    const b = makeStopDeps({
      config: opsConfig({ exit_timeout: 0 }),
      directorStatus: async () => ({ state: 'waiting' }),
      directorPause: async () => { /* pause succeeds */ },
      directorKill: async () => { throw new ErrSpawnNotFound('kill', 'ErrSpawnNotFound', 'row gone') },
    })
    await expect(createCli(b.deps).stop({ stopBots: true })).rejects.toBeInstanceOf(ExitError)
    expect(b.pauseCalls).toEqual([opsId()])
    expect(b.killCalls).toEqual([opsId()])
    expect(b.exitCodes).not.toContain(1)
    expect(b.exitCodes).toContain(0)
  })

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

describe('clean_restart teardown-via-closure regression (b.4dk)', () => {
  test('clean_restart still pauses each live persona (shared teardownBots closure)', async () => {
    let n = 0
    const b = makeDeps({ directorStatus: async () => (++n === 1 ? { state: 'waiting' } : { state: 'ended' }) })
    await createCli(b.deps).clean_restart()
    expect(b.pauseCalls).toEqual([opsId()])
    expect(b.killCalls).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// b.qwo — AD-unreachable teardown must fail LOUDLY, never a silent no-op
//
// Root cause (b.qps / incident-2026-09-18): getClient() threw in the short-lived
// CLI process (no server startup gate) and the error was collapsed into a
// per-bot "no spawn row — skipping". Every bot was skipped and clean_restart
// proceeded to `start`. Now directorStatus errors propagate (null only for
// ErrSpawnNotFound); teardownBots throws an aggregate; clean_restart and
// `stop --stop-bots` exit(1) and never start.
// ---------------------------------------------------------------------------

describe('b.qwo — teardown fails loudly when agent-director is unreachable', () => {
  test.each([
    ['a connection error', () => new Error('AD connection refused')],
    ['ErrCallTimeout', () => new ErrCallTimeout('status', 35000, 30000)],
  ])('clean_restart aborts (exit 1, no start) when directorStatus throws %s — never "no spawn row"', async (_name, makeErr) => {
    const b = makeDeps({ directorStatus: async () => { throw makeErr() } })
    await expect(createCli(b.deps).clean_restart()).rejects.toBeInstanceOf(ExitError)
    expect(b.exitCodes).toContain(1)
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

  // Kill-never-delete: static guard over src/cli.ts — the teardown path must
  // never call a delete/destroy verb on the AD client.
  test('src/cli.ts teardown surface calls no delete/destroy verb (kill-never-delete, static audit)', async () => {
    const src = readFileSync(CLI_SOURCE, 'utf-8')
    // Ban any AD delete verb reachable from teardown: directorDelete, a bare
    // deps.delete(...), or a director*.delete(...)/destroy(...) call. Comment /
    // JSDoc lines are excluded so prose like "never deletes" does not trip it.
    const banned = /\b(directorDelete\b|deps\.delete\s*\(|director\w*\.(delete|destroy)\s*\(|\.deleteSpawn\s*\()/
    const offenders = src
      .split('\n')
      .map((line, i) => ({ lineNo: i + 1, line }))
      .filter(({ line }) => !/^\s*(\*|\/\/)/.test(line))
      .filter(({ line }) => banned.test(line))
    expect(offenders.map((o) => `cli.ts:${o.lineNo}: ${o.line.trim()}`)).toEqual([])
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

  test('clean_restart exits 1 when initClient throws: the initialization-failed line, then "nothing was stopped"; no precheck call, no stop spawn, no teardown, no start', async () => {
    const b = makeDeps({
      initClient: async () => { throw new Error('startup gate failed') },
      directorStatus: async () => ({ state: 'waiting' }),
    })
    await expect(createCli(b.deps).clean_restart()).rejects.toBeInstanceOf(ExitError)
    expect(b.exitCodes).toEqual([1])
    expect(b.spawnCalls).toEqual([]) // neither the stop nor the start spawn
    expect(b.directorCallTimes).toEqual([])
    expect(stderr).toHaveLength(2)
    expect(stderr[0]!.startsWith('[slack] clean_restart: agent-director initialization failed:')).toBe(true)
    expect(stderr[1]).toBe(precheckNothingStoppedLine(CLI_COMMAND_CLEAN_RESTART))
    assertNoLeak({ stderr, consoleErrorArgs: errorSpy.mock.calls })
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

  test('stop --stop-bots exits 1 when initClient throws: the initialization-failed line, then "nothing was stopped"; no server signal, no precheck call, no teardown', async () => {
    const b = makeLiveStopDeps({
      initClient: async () => { throw new Error('startup gate failed') },
      directorStatus: async () => ({ state: 'waiting' }),
    })
    await expect(createCli(b.deps).stop({ stopBots: true })).rejects.toBeInstanceOf(ExitError)
    expect(b.exitCodes).toEqual([1])
    expect(b.serverSignals).toEqual([])
    expect(b.directorCallTimes).toEqual([])
    expect(stderr).toHaveLength(2)
    expect(stderr[0]!.startsWith('[slack] stop --stop-bots: agent-director initialization failed:')).toBe(true)
    expect(stderr[1]).toBe(precheckNothingStoppedLine(CLI_COMMAND_STOP_BOTS))
    assertNoLeak({ stderr, consoleErrorArgs: errorSpy.mock.calls })
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
  type Persona = { readonly name: string; readonly key: string }
  const OPS: Persona = { name: OPS_NAME, key: personaKey(OPS_NAME) }
  const ALPHA_P: Persona = { name: ALPHA.name, key: personaKey(ALPHA.name) }
  const BETA_P: Persona = { name: BETA.name, key: personaKey(BETA.name) }
  const idOf = (p: Persona): string => personaInstanceId(p.key)
  const twoPersonas = (): PersonaConfig => makeMultiPersonaConfig([ALPHA, BETA], root)

  /** A row state CSCB does not know: live (SRJ-901 step 2, hatch A3). */
  const UNKNOWN_STATE = 'a_state_cscb_does_not_know'

  /** The failure the precheck reports for `error` thrown by `call` (the verdict is tests/cli-teardown.test.ts's). */
  function failureOf(call: PrecheckCall, error: unknown): PrecheckFailure {
    const verdict = precheckVerdictOf({ call, error })
    if (!('errorClass' in verdict)) throw new Error(`precondition: ${call} verdict ${verdict.kind} carries no failure`)
    return verdict
  }

  /** Nothing was stopped: no server signal, no `stop` or `start` spawn, no `status`, `pause` or `kill`; exit 1. */
  function expectNothingStopped(b: Bundle): void {
    expect(b.exitCodes).toEqual([1])
    expect(b.serverSignals).toEqual([])
    expect(b.spawnCalls).toEqual([])
    expect([b.statusCalls, b.pauseCalls, b.killCalls]).toEqual([[], [], []])
  }

  /**
   * The precheck failed for `failures` ([persona, call, thrown value, class
   * shown], in configuration order): nothing stopped, and exactly one line per
   * failing persona from the builder, then the closing line, each printed once.
   */
  function expectPrecheckFailed(
    b: Bundle,
    command: CliTeardownCommand,
    failures: ReadonlyArray<readonly [Persona, PrecheckCall, unknown, AdErrorClass]>,
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
  const opsPaneReads = (n: number): Array<[string, number]> => nOf(n, [idOf(OPS), PROBE_PANE_READ_LINES])

  // -------------------------------------------------------------------------
  // Step 2: which rows get a read-pane
  // -------------------------------------------------------------------------

  test.each(forEachCommand<string>([...AGENT_DIRECTOR_LIVE_STATES, UNKNOWN_STATE].map((s) => [s, s] as const)))(
    '%s: a %s row is live: one get, then one read-pane of the one-line count; a pane passes and the command goes on',
    async (command, _label, state, [, make, run]) => {
      const b = make({ directorGet: async () => ({ state }) })
      await run(b)
      expect(b.getCalls).toEqual([idOf(OPS)])
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
    expect(b.getCalls).toEqual([idOf(OPS)])
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
    expect(b.getCalls).toEqual([idOf(OPS)])
    expect(b.readPaneCalls).toEqual(opsPaneReads(c.outcome === RETRIED ? PRECHECK_TRIES : 1))
    if (c.outcome === PASSES) expectWentOn(b, command)
    else expectPrecheckFailed(b, command, [[OPS, PRECHECK_CALL_READ_PANE, error, c.shown!]])
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
    expect(b.getCalls).toEqual(nOf(c.outcome === RETRIED ? PRECHECK_TRIES : 1, idOf(OPS)))
    expect(b.readPaneCalls).toEqual([])
    expectPrecheckFailed(b, command, [[OPS, PRECHECK_CALL_GET, error, c.shown!]])
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
    expectPrecheckFailed(b, command, [[OPS, call, error, AD_ERROR_CLASS_UNAVAILABLE]])
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
    expect(b.pauseCalls).toEqual([idOf(OPS)])
    assertNoLeak({ stderr, consoleErrorArgs: errorSpy.mock.calls })
  })

  // -------------------------------------------------------------------------
  // A failed precheck over several personas
  // -------------------------------------------------------------------------

  test.each(COMMANDS)('%s: of two personas only Beta fails (CONFLICT at its read-pane): only Beta is named, and Alpha is not torn down either', async (command, make, run) => {
    const error = errTmuxSessionConflict(PRECHECK_CALL_READ_PANE, 'not-this-launch', personaTmuxSessionName(BETA_P.key))
    const b = make({
      config: twoPersonas(),
      directorReadPane: async (id) => { if (id === idOf(BETA_P)) throw error; return FAKE_PANE },
      directorStatus: async () => ({ state: 'waiting' }),
    })
    await run(b)
    expectOnePrecheckEach(b, [idOf(ALPHA_P), idOf(BETA_P)])
    expectPrecheckFailed(b, command, [[BETA_P, PRECHECK_CALL_READ_PANE, error, AD_ERROR_CLASS_CONFLICT]])
    assertNoLeak({ stderr, consoleErrorArgs: errorSpy.mock.calls })
  })

  test.each(COMMANDS)('%s: both personas fail: one line each in configuration order (Alpha, whose tries end last, first), then one closing line', async (command, make, run) => {
    const alphaError = errTmuxUnresponsive(PRECHECK_CALL_READ_PANE)
    const betaError = errUnusableName()
    const b = make({
      config: twoPersonas(),
      directorGet: async (id) => { if (id === idOf(BETA_P)) throw betaError; return LIVE_ROW },
      directorReadPane: async () => { throw alphaError },
    })
    await run(b)
    expectPrecheckFailed(b, command, [
      [ALPHA_P, PRECHECK_CALL_READ_PANE, alphaError, AD_ERROR_CLASS_UNAVAILABLE],
      [BETA_P, PRECHECK_CALL_GET, betaError, AD_ERROR_CLASS_UNUSABLE_NAME],
    ])
    assertNoLeak({ stderr, consoleErrorArgs: errorSpy.mock.calls })
  })

  test.each(COMMANDS)('%s: CONFIG at Alpha\'s get fails only Alpha, at once, and Beta is still checked: Alpha gets one get and no read-pane, Beta its get and its one-line read-pane (CONFLICT); two lines in configuration order, Alpha\'s naming the agent-director config file, then one closing line', async (command, make, run) => {
    const alphaError = errConfigMalformed()
    const betaError = errTmuxSessionConflict(PRECHECK_CALL_READ_PANE, 'not-this-launch', personaTmuxSessionName(BETA_P.key))
    const b = make({
      config: twoPersonas(),
      directorGet: async (id) => { if (id === idOf(ALPHA_P)) throw alphaError; return LIVE_ROW },
      directorReadPane: async (id) => { if (id === idOf(BETA_P)) throw betaError; return FAKE_PANE },
    })
    await run(b)
    expect([...b.getCalls].sort()).toEqual([idOf(ALPHA_P), idOf(BETA_P)].sort())
    expect(b.readPaneCalls).toEqual([[idOf(BETA_P), PROBE_PANE_READ_LINES]])
    expectPrecheckFailed(b, command, [
      [ALPHA_P, PRECHECK_CALL_GET, alphaError, AD_ERROR_CLASS_CONFIG],
      [BETA_P, PRECHECK_CALL_READ_PANE, betaError, AD_ERROR_CLASS_CONFLICT],
    ])
    expect(stderr[0]).toContain(AD_CONFIG_FILE_DISPLAY_NAME)
    assertNoLeak({ stderr, consoleErrorArgs: errorSpy.mock.calls })
  })

  // -------------------------------------------------------------------------
  // Where the lines go, redaction and no side effects
  // -------------------------------------------------------------------------

  /** An initLogging that sends console.error to `log`, as the real one sends it to clean_restart.log. */
  const redirectTo = (log: string[]) => (): void => {
    console.error = (...args: unknown[]) => { log.push(formatLine(args)) }
  }

  test.each(COMMANDS)('%s: the precheck lines are printed only: once each on the terminal, for clean_restart also once each in clean_restart.log, and no file is written (no server.log, no startup-errors.log)', async (command, make, run) => {
    const log: string[] = []
    const error = errTmuxSessionConflict(PRECHECK_CALL_READ_PANE, 'leftover', personaTmuxSessionName(OPS.key))
    const b = make({ directorReadPane: async () => { throw error }, initLogging: redirectTo(log) })
    const before = snapshotTree()
    await run(b)
    const lines = [precheckFailureLine(command, OPS, failureOf(PRECHECK_CALL_READ_PANE, error)), precheckNothingStoppedLine(command)]
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
      directorReadPane: async (id) => { throw id === idOf(ALPHA_P) ? conflict : unclassified },
    })
    await run(b)
    expectPrecheckFailed(b, command, [
      [ALPHA_P, PRECHECK_CALL_READ_PANE, conflict, AD_ERROR_CLASS_CONFLICT],
      [BETA_P, PRECHECK_CALL_READ_PANE, unclassified, AD_ERROR_CLASS_UNCLASSIFIED],
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
    writeRetiredKeysRecord(stateDir, { [OPS.key]: { cause: RETIRED_KEY_CAUSE_DESTRUCTIVE_MODIFY, mark: true } })
    const b = make(o)
    const before = snapshotTree() // after make, so the PID file is in it
    await run(b)
    expect(b.getCalls).toEqual([idOf(OPS)])
    expect(snapshotTree()).toEqual(before)
    assertNoLeak({ stderr, consoleErrorArgs: errorSpy.mock.calls })
  })

  test('src/cli.ts imports nothing from the session manager, the conflict latch or the retired-key record module, and its precheck reads no clock but the injected one (static)', () => {
    const code = stripComments(readFileSync(CLI_SOURCE, 'utf-8'))
    const banned = ['./session-manager.ts', './conflict-latch.ts', './retired-keys.ts']
    expect(importedSpecifiers(code).filter((s) => banned.includes(s))).toEqual([])
    for (const name of ['runPrecheck', 'precheckPersona', 'precheckTries', 'precheckStopBots']) {
      const at = indicesOf(new RegExp(`\\bfunction\\s+${name}\\s*\\(`, 'g'), code)
      expect([name, at.length]).toEqual([name, 1])
      const body = code.slice(...balancedAfter(code, at[0]!, '{', '}'))
      expect([name, /\bDate\.now\b|\bsetTimeout\b|\bsetInterval\b/.test(body)]).toEqual([name, false])
    }
    const tries = code.slice(...balancedAfter(code, indicesOf(/\bfunction\s+precheckTries\s*\(/g, code)[0]!, '{', '}'))
    expect(tries).toMatch(/\bdeps\.sleep\(\s*PRECHECK_TRY_SPACING_MS\s*\)/)
  })

  // SRJ-613 (E19 note): a pane passes the precheck but proves nothing; the teardown's own calls are the backstop.
  test.each(COMMANDS)('%s: after a precheck whose read-pane answered a pane, the server is stopped and the teardown still makes its own status, pause and kill; a kill answering CONFLICT "not this launch\'s session" fails the teardown (exit 1) and latches nothing', async (command, make, run) => {
    const b = make({
      config: opsConfig({ exit_timeout: 0 }),
      directorStatus: async () => ({ state: 'waiting' }),
      directorKill: async () => { throw errTmuxSessionConflict('kill', 'not-this-launch', personaTmuxSessionName(OPS.key)) },
    })
    const before = snapshotTree()
    await run(b)
    expect(b.readPaneCalls).toEqual(opsPaneReads(1))
    expect([b.statusCalls, b.pauseCalls, b.killCalls]).toEqual([[idOf(OPS)], [idOf(OPS)], [idOf(OPS)]])
    if (command === CLI_COMMAND_STOP_BOTS) expect(b.serverSignals).toEqual(['SIGTERM'])
    else expect(b.spawnCalls.map((c) => c.args.at(-1))).toEqual(['stop'])
    expect(b.exitCodes).toEqual([1])
    expect(snapshotTree()).toEqual(before)
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
// calls, times, exit and failure line. Until the teardown's own failure lines
// are built, a failure shows as teardownBots' per-persona line and the
// aggregate failure.
// ---------------------------------------------------------------------------

/** A `status` row: the fixture's `directorStatus` answer. */
type StatusRow = { readonly state: string }
const WAITING_ROW: StatusRow = Object.freeze({ state: 'waiting' })
const ENDED_ROW: StatusRow = Object.freeze({ state: 'ended' })

/**
 * Every persona was stopped: `stop --stop-bots` stopped the server and exits
 * 0; `clean_restart` spawned the stop and then the start; no teardown failure
 * was logged.
 */
function expectTeardownStopped(b: Bundle, command: CliTeardownCommand): void {
  if (command === CLI_COMMAND_STOP_BOTS) {
    expect(b.serverSignals).toEqual(['SIGTERM'])
    expect(b.exitCodes).toEqual([0])
  } else {
    expect(b.spawnCalls.map((c) => c.args.at(-1))).toEqual(['stop', 'start'])
    expect(b.exitCodes).toEqual([])
  }
  expect(stderr.filter((l) => l.includes('error during teardown'))).toEqual([])
}

/**
 * The persona named `persona` alone failed, at `step`, with `error` of class
 * `errorClass`: exit 1 after the server stop (`clean_restart` spawns no
 * start); one failure line naming the persona, the step, the class and the
 * reported description, a CONFIG one naming the config file; the aggregate
 * counts one persona.
 */
function expectTeardownFailed(
  b: Bundle,
  command: CliTeardownCommand,
  persona: string,
  step: TeardownStep,
  error: unknown,
  errorClass: AdErrorClass,
): void {
  expect(b.exitCodes).toEqual([1])
  if (command === CLI_COMMAND_STOP_BOTS) expect(b.serverSignals).toEqual(['SIGTERM'])
  else expect(b.spawnCalls.map((c) => c.args.at(-1))).toEqual(['stop'])
  expect(teardownErrorReportOf(error).errorClass).toBe(errorClass)
  const lines = stderr.filter((l) => l.includes('error during teardown'))
  expect(lines).toEqual([teardownFailureLogLine(persona, step, error)])
  if (errorClass === AD_ERROR_CLASS_CONFIG) expect(lines[0]).toContain(AD_CONFIG_FILE_DISPLAY_NAME)
  expect(stderr.join('\n')).toContain('teardown incomplete for 1 persona(s)')
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
      expectTeardownFailed(b, command, OPS_NAME, TEARDOWN_STEP_PAUSE, error, errorClass)
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
      config: makeMultiPersonaConfig([ALPHA, BETA], root),
      directorStatus: async (id) => (id === betaId() ? betaReads() : WAITING_ROW),
      directorPause: async (id) => { if (id === alphaId()) throw conflict },
    })

    await run(b)

    expect([...b.pauseCalls].sort()).toEqual([alphaId(), betaId()].sort())
    expect(b.killCalls).toEqual([])
    expect(callTimesOf(b, 'status', betaId())).toHaveLength(2) // the state read, then a poll read of ended
    expectTeardownFailed(b, command, ALPHA.name, TEARDOWN_STEP_PAUSE, conflict, AD_ERROR_CLASS_CONFLICT)
    assertNoLeak({ stderr, consoleErrorArgs: errorSpy.mock.calls })
  })

  // E32's SRJ-613 backstop, pause leg: a pane passes the precheck but proves nothing; the pause answers CONFLICT.
  test.each(COMMANDS)('%s: after a precheck whose read-pane answered a pane, a pause answering CONFLICT "not this launch\'s session" fails that persona with no kill; exit 1, and nothing is latched or written', async (command, make, run) => {
    const conflict = errTmuxSessionConflict(PAUSE_VERB, 'not-this-launch', personaTmuxSessionName(personaKey(OPS_NAME)))
    const b = make({ directorStatus: async () => WAITING_ROW, directorPause: async () => { throw conflict } })
    const before = snapshotTree()

    await run(b)

    expect(b.readPaneCalls).toEqual([[opsId(), PROBE_PANE_READ_LINES]])
    expect([b.statusCalls, b.pauseCalls, b.killCalls]).toEqual([[opsId()], [opsId()], []])
    expectTeardownFailed(b, command, OPS_NAME, TEARDOWN_STEP_PAUSE, conflict, AD_ERROR_CLASS_CONFLICT)
    expect(snapshotTree()).toEqual(before)
    assertNoLeak({ stderr, consoleErrorArgs: errorSpy.mock.calls })
  })

  test('the teardown reads no clock but the injected one: its functions name no Date.now, setTimeout, setInterval or instanceof; the pause tries wait PRECHECK_TRY_SPACING_MS and the poll waits, through deps.sleep (static; b.jg5 SRJ-908)', () => {
    const code = stripComments(readFileSync(CLI_SOURCE, 'utf-8'))
    const bodyOf = (name: string): string => {
      const at = indicesOf(new RegExp(`\\bfunction\\s+${name}\\s*\\(`, 'g'), code)
      expect([name, at.length]).toEqual([name, 1])
      return code.slice(...balancedAfter(code, at[0]!, '{', '}'))
    }
    for (const name of ['teardownBots', 'teardownPersona', 'teardownStateRead', 'pauseTries', 'teardownKill']) {
      expect([name, /\bDate\.now\b|\bsetTimeout\b|\bsetInterval\b|\binstanceof\b/.test(bodyOf(name))]).toEqual([name, false])
    }
    expect(bodyOf('pauseTries')).toMatch(/\bdeps\.sleep\(\s*PRECHECK_TRY_SPACING_MS\s*\)/)
    expect(bodyOf('teardownPersona')).toMatch(/\bdeps\.sleep\(/)
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
    const deadline = pausedAt + exitTimeoutS * 1000
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
    const deadline = pausedAt! + exitTimeoutS * 1000
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
  ]))('%s: a poll read finding %s ends the teardown as stopped, with no kill', async (command, _label, answer, [, make, run]) => {
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
    expectTeardownFailed(b, command, OPS_NAME, TEARDOWN_STEP_STATE_READ, error, errorClass)
    assertNoLeak({ stderr, consoleErrorArgs: errorSpy.mock.calls })
  })

  test.each(forEachCommand(STATUS_ERROR_ROWS))('%s: a poll read answering %s fails the persona at once: no further read and no kill', async (command, _label, [makeError, errorClass], [, make, run]) => {
    const error = makeError()
    const b = make({ directorStatus: scripted<{ state: string }>(WAITING_ROW, thrown(error)) })

    await run(b)

    expect([b.statusCalls, b.pauseCalls, b.killCalls]).toEqual([[opsId(), opsId()], [opsId()], []])
    expectTeardownFailed(b, command, OPS_NAME, TEARDOWN_STEP_POLL, error, errorClass)
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

      expect(stderr).toEqual([`${STOP_BOTS_INIT_FAILED}${gateError.message}`, precheckNothingStoppedLine(CLI_COMMAND_STOP_BOTS)])
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

  test('an incomplete teardown (TeardownIncompleteError) prints its count and retry advice on the teardown-failed line; the underlying error, carrying fake tokens, is only described on the persona\'s failure line (its step and class named), its message redacted; exit 1; nothing logged leaks', async () => {
    const statusError = Object.assign(new Error(`status refused (${sentinelInMessage('status')})`), { code: 'ECONNREFUSED', note: LEAK_SENTINEL })
    const b = makeStopDeps({ directorStatus: async () => { throw statusError } })

    await expect(createCli(b.deps).stop({ stopBots: true })).rejects.toBeInstanceOf(ExitError)

    expect(stderr.filter((l) => l.includes('bot teardown failed'))).toEqual([
      '[slack] stop --stop-bots: bot teardown failed: teardownBots: agent-director error — teardown incomplete for 1 persona(s); ' +
        'other personas may already have been paused or killed; rows are never deleted, safe to retry',
    ])
    expect(teardownErrorReportOf(statusError).errorClass).toBe(AD_ERROR_CLASS_UNAVAILABLE)
    expect(linesWith('error during teardown')).toEqual([teardownFailureLogLine(OPS_NAME, TEARDOWN_STEP_STATE_READ, statusError).split(' at ')[0]!])
    expect(linesWith('error during teardown')[0]).toContain(`Error code=ECONNREFUSED message="status refused (${REDACTED_SENTINEL_TAIL})"`)
    expect(b.exitCodes).toEqual([1])
    assertNoLeak({ consoleErrorArgs: errorSpy.mock.calls, stderr })
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

    expect(linesWith('initialization failed')).toEqual([`[slack] stop --stop-bots: agent-director initialization failed: ${shown}`])
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

  const twoPersonas = (): PersonaConfig =>
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
      config: twoPersonas(),
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
    expect(stderr.filter((l) => l.startsWith(STOP_BOTS_INIT_FAILED))).toEqual([`${STOP_BOTS_INIT_FAILED}${err.message}`])
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
      `[slack] clean_restart: agent-director initialization failed: ${refusal.message}`,
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
    const initLine = stderr.find((l) => l.startsWith(STOP_BOTS_INIT_FAILED))!
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
    expect(stderr).toEqual([`${STOP_BOTS_INIT_FAILED}${refusal.message}`])
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
      expect(stderr).toEqual([`${STOP_BOTS_INIT_FAILED}${err.message}`, precheckNothingStoppedLine(CLI_COMMAND_STOP_BOTS)])
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
        `[slack] clean_restart: agent-director initialization failed: ${refusal.message}`,
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

  const COMMANDS: Array<[string, () => Overrides, (b: Bundle) => Promise<void>, boolean]> = [
    ['start (pre-flight and daemon start)', () => ({}), (b) => createCli(b.deps).start(), false],
    ['stop', upOnce, (b) => createCli(b.deps).stop(), false],
    ['stop --stop-bots', upOnce, (b) => createCli(b.deps).stop({ stopBots: true }), true],
    ['clean_restart', () => ({}), (b) => createCli(b.deps).clean_restart(), true],
    ['credentials <persona>', () => ({}), (b) => createCli(b.deps).credentials([OPS_NAME]), false],
  ]

  test.each(COMMANDS.flatMap(([label, overrides, run, readsRows]) => [
    [label, 'a seeded record is left byte-identical', overrides, run, readsRows, true] as const,
    [label, 'with no record none is created', overrides, run, readsRows, false] as const,
  ]))('%s: %s', async (_label, _outcome, overrides, run, readsRows, seeded) => {
    const before = seeded ? seedRecord() : null
    const { b, statusCalls, getCalls, readPaneCalls } = actingDeps(overrides())

    await run(b).catch((err) => { if (!(err instanceof ExitError)) throw err })

    // The command acted: the daemon spawned, the server signalled, the rows
    // prechecked, read and torn down, or the script run.
    expect(b.daemonSpawns.length + b.serverSignals.length + b.credentialsRuns.length + b.spawnCalls.length).toBeGreaterThan(0)
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

  test('AC 74: no arguments exits non-zero with usage listing exactly start, stop, clean_restart and credentials, and only --stop-bots, under stop, with no reload wording', () => {
    const result = runCli([])

    expect(result.status).not.toBe(0)
    const usage = usageEntries(result.output)
    expect(usage.synopsis.sort()).toEqual(['clean_restart', 'credentials', 'start', 'stop'])
    expect(usage.listed.sort()).toEqual(['clean_restart', 'credentials', 'start', 'stop'])
    expect(usage.flags).toEqual({ stop: ['--stop-bots'] })
    expect(usage.unexpected).toEqual([])
    expect(usage.allFlags).toEqual(['--stop-bots'])
    expect(reloadTermsIn(result.output)).toEqual([])
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
