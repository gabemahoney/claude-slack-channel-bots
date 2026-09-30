/**
 * server-startup-wiring.test.ts — The server's start-up wiring after the
 * loader switch (b.av2 SR-3.1, SR-10.2, SR-8.7, SR-13.2).
 *
 * - SR-3.1: no Slack client is built and no token is read at module scope in
 *   src/server.ts; the connection manager is built inside main().
 * - SR-10.2: `SLACK_BOT_TOKEN` / `SLACK_APP_TOKEN` are neither required nor
 *   read by the server; only src/cli.ts still names them.
 * - SR-8.7: the `MCP_HOST` / `MCP_PORT` fallback is gone; main() resolves the
 *   start through the reload controller (the last-applied record when there
 *   is one, else the required config file), exits on a refused start, sets
 *   the applied config from the outcome, and requests the start bring-up from
 *   the controller, whose lifecycle runs `startupSessionManager` over the
 *   config the controller hands it.
 * - SR-13.2: importing src/server.ts touches nothing under HOME. Before the
 *   switch the import read the token variables (exiting without them) and
 *   created `~/.claude/channels/slack`; main() now creates the state and
 *   inbox directories.
 * - The connection seams (SR-3.1, SR-3.4, SR-4.1, SR-7.2): the manager's dry
 *   run and up→flush listener, `connections = <manager>`, `clientFor` and
 *   `identityFor` over the connection view, the routing's identity, client,
 *   archive and notice (`notify`, the persona notifier's, SR-7.3) seams, and
 *   the archive writer's per-persona resolver source.
 * - The integration suite's Slack API base URL override (E14 Task 4):
 *   `CSCB_SLACK_API_URL` resolved once in main(), before the manager is
 *   built, from `process.env`, and passed to it as `slackApiUrl`; no other
 *   src file names the variable.
 * - The one destination resolver (SR-7.1): built at module scope and shared
 *   by the persona notifier and the permission poller.
 * - The bring-up controller (SR-6.1, SR-6.4): the start's bring-up, told
 *   every connection status, stored for shutdown and cancelled there before
 *   the connections stop; the health check started only after the start
 *   bring-up returns. Its launch and its live applied set (`appliedPersonas`)
 *   read the applied config at call time (SR-8.6). Bug b.g57: it checks a
 *   persona's claude_config_dir before its Slack step, and re-checks a held
 *   one, with the launch's own check (`checkLaunchConfigDir`), which the
 *   reload preview also gets for an added persona; its
 *   connections are the whole manager, whose `stop` closes a held persona's
 *   connection; its `holdForConfigDir` is the session
 *   manager's hook for an unresolvable one, installed before any launch path,
 *   and the restart module's kill adapter gets `getAppliedPersona`.
 * - The relaunch gate (SR-6.1, SR-6.4): built over the manager and the
 *   bring-up controller and passed to the restart module (`canRestart`), the
 *   restart launch and the health-check work list; the restart delay read
 *   from the applied config; the permission poller not started in dry run.
 * - Not-up personas (SR-6.3, SR-6.4, SR-8.6): the one `isPersonaUp`
 *   predicate (the controller's `isUp` and `isApplied`) handed
 *   to the permission poller, `/interject`, the MCP admission decision and
 *   the persona routing's lost-message branch;
 *   a refused session disconnected and never registered; the controller's
 *   `onLeftUp` dropping the persona's registered session.
 * - SR-5.2: the file guard handed to the session tools protects every persona
 *   credentials file, as the reload controller lists them.
 * - b.jg5 SRJ-203 (AC 20): the agent-director startup gate is called once,
 *   awaited, with no argument, after only the directory creations and the
 *   unhandledRejection install and before the PID check and every later step;
 *   server.ts never names the gate's floor-exempt option, so its start always
 *   runs the Phase 1 floor.
 * - b.jg5 SRJ-204 / SRJ-205: the runtime agent-director version re-check is
 *   installed once, in the statement right after the gate, behind no branch
 *   and with no `health_check_interval` or clock of its own, over the gate's
 *   version, agent-director's `resolveSystemBinary` and `recordStartupError`;
 *   its stop first arms the shutdown deadline (`armShutdownDeadline`, with
 *   the stop's code, `process.exit` and no clock or deadline override; AC
 *   21) and sets `process.exitCode` to that code (nothing else in server.ts
 *   names it), then runs `shutdown` with the code the re-check passes;
 *   `shutdown` disposes it, exits with its code (the signals pass none, so 0,
 *   and arm no deadline) and makes no agent-director call. main() returns
 *   before `Bun.serve`, the start bring-up, the health check and the
 *   detection tick when a shutdown began during an earlier await.
 * - b.jg5 SRJ-209: agent-director's timing settings install
 *   (`installAdSettings`) is called once, with no argument (so the file is
 *   read under the process's own HOME), in main()'s own statement list with
 *   its result dropped, after the startup gate and the start's configuration
 *   resolution and before the start bring-up; nothing else in server.ts
 *   builds a reader, registers on the re-check's tick, or names the settings
 *   file or the TOML parser.
 * - b.jg5 SRJ-213: the call-timeout start step (`_runCallTimeoutStartStep`)
 *   is called once, awaited, in main()'s own statement list (so in dry run
 *   too), after the startup gate (still called once with no argument), the
 *   start's configuration resolution and the settings install, and before the
 *   template install and the start bring-up, with the start-time applied
 *   config as its only argument; it is on no tick and no timer.
 * - b.jg5 SRJ-301 / SRJ-305: one UNAVAILABLE retry controller is built in
 *   main()'s own statement list on the production clock, held in the one
 *   module-scope handle, and installed as the trigger sink of the one
 *   `initOutageState` call before the start bring-up and the restart module;
 *   its action is the full-mode retry action over `runRestartRetry`,
 *   `getAppliedPersona`, the relaunch gate, the restart cap, the restart
 *   module's shutdown flag, `isLaunchInFlight` and the session manager's
 *   row read `readPersonaRowState` (SRJ-303); the restart module's arm hook
 *   (`armRetryTimer`) arms it with the read-error cause (SRJ-314); shutdown
 *   closes it once, right after `cancelAllRestartTimers`, after the
 *   shutting-down flag and before the HTTP server stops.
 * - b.jg5 SRJ-314 / SRJ-115: the restart module's pending deferral
 *   (`deferPendingRow`) is bound to server.ts's one module-scope
 *   `deferPendingRow` (no import, local shadow or second declaration), passed
 *   the persona's key and the reading's `launchStartedAt`.
 * - b.jg5 SRJ-1016: the one set of per-persona notice episodes is built once,
 *   imported from the episodes module, in main()'s own statement list, before
 *   the retry controller, the restart module, the start bring-up and the
 *   health check, on the production clock, with the module-scope persona
 *   notifier's `notify` as its sink, and held in the one module-scope handle
 *   assigned in main(); shutdown closes them once, through that handle,
 *   before it first yields (every episode ends, every alert check is
 *   cancelled, and no episode begins again).
 * - b.jg5 SRJ-307 / SRJ-310 / SRJ-306: the one tmux-unresponsive condition is
 *   built once, in main()'s own statement list, over that episodes instance,
 *   after the retry controller; it is the condition sink of the one
 *   `initOutageState` call (beside the trigger sink, before the start
 *   bring-up); the health check's and the full-mode retry action's
 *   `endTmuxUnresponsive` hooks end it (with the tick's `live` reading and the
 *   retry's own reading), the retry action gets the connectedness and stream
 *   probes the health check reads, and its condition-end hook is the retry
 *   controller's `conditionEnded` for the tmux-unresponsive condition.
 * - b.jg5 SRJ-308 / SRJ-309 / SRJ-210: the condition's onset entries are
 *   bound to the health check's tick-end hook (`onTickEnd`, with the tick's
 *   start read by `now` on the notice episodes' own clock) and to the retry
 *   controller's per-fire observer (`onRetryFire`), and are called nowhere
 *   else; its mode is read at each check from the applied config holder's
 *   `health_check_interval` (the field `startHealthCheck` starts the tick
 *   with), and its alert threshold is E6's `adAlertThresholdMsInEffect`
 *   itself, never a value taken once; its alert is cancelled only by the
 *   teardown's retry-timer stop (pinned in tests/reload-wiring.test.ts) and
 *   by shutdown's close of the episodes.
 *
 * Why part of this file is a static audit: main() cannot run in a unit test
 * (the agent-director startup gate, a real port, real Slack connections), so
 * its wiring is pinned by auditing the comment-stripped source text, anchored
 * on content and never on line numbers (the tests/jsonl-safeguard-wiring
 * precedent). Import-time behaviour is proven for real, in a child `bun`
 * process with a temp HOME that imports the module (never runs it as the
 * entry point, so `import.meta.main` is false and main() never runs).
 *
 * SPDX-License-Identifier: MIT
 */

import { describe, test, expect, afterEach } from 'bun:test'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  atMainTopLevel,
  balancedAfter,
  callArguments,
  importSource,
  indicesOf,
  insideMain as insideMainOf,
  loadedConfigName,
  mainBody,
  objectProperties,
  onlyCallArguments,
  shutdownBody,
  splitTopLevel,
  startResolution,
  stripComments,
} from './test-helpers/source-audit.ts'
import { runInFakeHome } from './test-helpers/fake-home-subprocess.ts'
import { makeStubCallLog } from './test-helpers/agent-director-stub.ts'
import type { runAgentDirectorStartupGate, StartupGateOptions } from '../src/agent-director-startup.ts'
import { AD_VERSION_RECHECK_STOP_EXIT_CODE, type AdVersionRecheckDeps } from '../src/ad-version-gate.ts'
import type { ShutdownDeadlineDeps } from '../src/shutdown-deadline.ts'
import { AD_SETTINGS_RELATIVE_PATH } from '../src/ad-settings.ts'
import type * as AdSettingsModule from '../src/ad-settings.ts'
import type * as AdVersionGateModule from '../src/ad-version-gate.ts'
import type * as AdStartupModule from '../src/agent-director-startup.ts'
import type * as ServerModule from '../src/server.ts'
import type { RestartDeps } from '../src/restart.ts'
import type { PendingLivenessReading } from '../src/liveness-reading.ts'
import type * as PersonaEpisodesModule from '../src/persona-episodes.ts'
import type {
  PersonaEpisodes,
  PersonaEpisodesDeps,
  TmuxUnresponsiveCondition,
  TmuxUnresponsiveConditionDeps,
} from '../src/persona-episodes.ts'
import type * as UnavailableRetryModule from '../src/unavailable-retry.ts'
import type { FullModeRetryDeps, UnavailableRetryController, UnavailableRetryDeps } from '../src/unavailable-retry.ts'
import type * as LivenessReadingModule from '../src/liveness-reading.ts'
import type { HealthCheckDeps } from '../src/health-check.ts'
import type { OutageStateDeps } from '../src/outage-state.ts'
import type * as PersonaConnectionsModule from '../src/persona-connections.ts'
import type * as PersonaNotifierModule from '../src/persona-notifier.ts'
import type { PersonaNotifier } from '../src/persona-notifier.ts'
import type { PersonaConfig } from '../src/config.ts'

const SRC_DIR = fileURLToPath(new URL('../src/', import.meta.url))
const SERVER_PATH = join(SRC_DIR, 'server.ts')

/** server.ts with every comment removed (see stripComments). */
const SERVER_CODE = stripComments(readFileSync(SERVER_PATH, 'utf-8'))

/** Offsets of every code call of `name` in server.ts. */
function callsOf(name: string): number[] {
  return indicesOf(new RegExp(`\\b${name}\\s*\\(`, 'g'), SERVER_CODE)
}

/** The offset of the only code call of `name`; fails unless there is exactly one. */
function onlyCallOf(name: string): number {
  const calls = callsOf(name)
  expect(calls).toHaveLength(1)
  return calls[0]!
}

/** The top-level arguments of the only code call of `name` (whitespace collapsed). */
function onlyCallArgs(name: string): string[] {
  return splitTopLevel(onlyCallArguments(SERVER_CODE, name))
}

/** The top-level properties of the object literal passed to the only call of `name`. */
function onlyCallProps(name: string): Map<string, string> {
  return objectProperties(onlyCallArguments(SERVER_CODE, name))
}

/** The name `const <name> = <call>(` binds, for the only such declaration; fails unless there is exactly one. */
function constOf(call: string): string {
  const decls = [...SERVER_CODE.matchAll(new RegExp(`\\bconst\\s+(\\w+)(?:\\s*:\\s*[\\w<>, ]+)?\\s*=\\s*${call}\\s*\\(`, 'g'))]
  expect(decls.map((m) => m[1])).toHaveLength(1)
  return decls[0]![1]!
}

/** `name` is declared exactly once in server.ts (no local shadow, no second instance). */
function declaredOnce(name: string): void {
  expect(indicesOf(new RegExp(`\\b(?:let|const|var|function)\\s+${name}\\b`, 'g'), SERVER_CODE)).toHaveLength(1)
}

/** Offsets of every plain assignment to `name` (`name = …`, not `==`, not a declaration or property). */
function assignmentsTo(name: string): Array<{ at: number; value: string }> {
  return [...SERVER_CODE.matchAll(new RegExp(`(?<![\\w.$]|(?:let|const|var)\\s+)${name}\\s*=(?![=>])\\s*([^\\n;]*)`, 'g'))]
    .map((m) => ({ at: m.index!, value: m[1]!.trim() }))
}

/** Whether `offset` lies inside main()'s body in server.ts. */
function insideMain(offset: number): boolean {
  return insideMainOf(SERVER_CODE, offset)
}

/** Every `.ts` file under src/, as [repo-relative path, source text]. */
function srcFiles(dir = SRC_DIR): Array<[string, string]> {
  const out: Array<[string, string]> = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) out.push(...srcFiles(full))
    else if (full.endsWith('.ts')) out.push([`src/${relative(SRC_DIR, full)}`, readFileSync(full, 'utf-8')])
  }
  return out
}

// ---------------------------------------------------------------------------
// Static audit: no module-scope Slack client or token read
// ---------------------------------------------------------------------------

describe('server.ts builds no Slack client and reads no token itself (SR-3.1, SR-10.2, SR-8.7)', () => {
  test.each(['loadTokens', 'SLACK_BOT_TOKEN', 'SLACK_APP_TOKEN', 'MCP_HOST', 'MCP_PORT', 'routingConfig'])(
    'server.ts code never names %s',
    (name) => {
      expect(indicesOf(new RegExp(`\\b${name}\\b`, 'g'), SERVER_CODE)).toEqual([])
    },
  )

  test('constructs no WebClient or SocketModeClient and imports Slack library types only', () => {
    expect(indicesOf(/\bnew\s+(?:WebClient|SocketModeClient)\b/g, SERVER_CODE)).toEqual([])
    // A static import of a Slack package must be `import type`; `[^'"]` keeps
    // a match inside one import statement.
    const valueImports = [...SERVER_CODE.matchAll(/\bimport\s+(type\s+)?[^'"]*?\bfrom\s*['"](@slack\/[\w-]+)['"]/g)]
      .filter((m) => m[1] === undefined)
      .map((m) => m[2])
    expect(valueImports).toEqual([])
    expect(indicesOf(/\b(?:import|require)\s*\(\s*['"]@slack\//g, SERVER_CODE)).toEqual([])
  })

  test('builds the persona connection manager once, inside main()', () => {
    expect(insideMain(onlyCallOf('createPersonaConnectionManager'))).toBe(true)
  })

  test('no file under src/ other than cli.ts names a token variable', () => {
    const offenders = srcFiles()
      .filter(([path]) => path !== 'src/cli.ts')
      .filter(([, source]) => /\bSLACK_(?:BOT|APP)_TOKEN\b/.test(stripComments(source)))
      .map(([path]) => path)
    expect(offenders).toEqual([])
  })

  test('no file under src/ references the deleted route→persona adapter module', () => {
    expect(existsSync(join(SRC_DIR, 'route-persona-adapter.ts'))).toBe(false)
    const offenders = srcFiles()
      .filter(([, source]) => /route-persona-adapter/.test(source))
      .map(([path]) => path)
    expect(offenders).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Static audit: the start resolution (SR-1.7, SR-8.7)
// ---------------------------------------------------------------------------

describe('main() resolves the start through the reload controller and exits on a refused start (SR-1.7, SR-8.7)', () => {
  test('imports createReloadController and reloadFilePaths from the reload module, and neither the start loader nor a route loader from the config module', () => {
    expect(SERVER_CODE).toMatch(
      /import\s*\{[^}]*\bcreateReloadController\b[^}]*\}\s*from\s*['"]\.\/reload\.ts['"]/,
    )
    expect(SERVER_CODE).toMatch(/import\s*\{[^}]*\breloadFilePaths\b[^}]*\}\s*from\s*['"]\.\/reload\.ts['"]/)
    const configImports = [...SERVER_CODE.matchAll(/import\s*\{([^}]*)\}\s*from\s*['"]\.\/config\.ts['"]/g)]
    expect(configImports).toHaveLength(1)
    const names = configImports[0]![1]!.split(',').map((n) => n.trim().replace(/^type\s+/, ''))
    // The start never reads the config file around the controller.
    for (const loader of ['loadStartPersonaConfig', 'loadPersonaConfig', 'parsePersonaConfigBytes', 'readPersonaConfigBytes']) {
      expect(names).not.toContain(loader)
      expect(callsOf(loader)).toEqual([])
    }
    for (const routeName of ['loadConfig', 'resolveConfig', 'applyDefaults', 'validateConfig']) {
      expect(names).not.toContain(routeName)
    }
    // No route type either (the removed route config types all contained "Rout").
    expect(names.filter((n) => /rout/i.test(n))).toEqual([])
  })

  test('builds the controller once, inside main(), over CONFIG_PATH\'s reload files (the server config path), and resolves the start once', () => {
    expect(SERVER_CODE).toMatch(/\bconst\s+CONFIG_PATH\s*=\s*resolveServerConfigPath\s*\(\s*\)/)
    // startResolution pins one resolveStart and one runStartBringUp, both
    // called on this controller.
    const { createAt, resolveAt } = startResolution(SERVER_CODE)
    expect(onlyCallOf('createReloadController')).toBe(createAt)
    expect(insideMain(createAt)).toBe(true)
    expect(insideMain(resolveAt)).toBe(true)
    expect(onlyCallProps('createReloadController').get('paths')).toBe('reloadFilePaths(CONFIG_PATH)')
  })

  test('a refused start exits 1 right after the resolution, before the applied config is set; on the start path the outcome\'s config is the only applied config, and nothing re-reads the config file into it', () => {
    const { controller, outcome, loaded, resolveAt, assignAt, bringUpAt } = startResolution(SERVER_CODE)
    // `const <outcome> = <controller>.resolveStart()`, then the refusal exit as
    // the whole `if`, then `<loaded> = <outcome>.config`: nothing in between.
    const sequence = new RegExp(
      `\\bconst\\s+${outcome}\\s*=\\s*${controller}\\s*\\.\\s*resolveStart\\s*\\(\\s*\\)\\s*;?\\s*` +
        `if\\s*\\(\\s*${outcome}\\s*\\.\\s*kind\\s*===\\s*'refused'\\s*\\)\\s*\\{?\\s*process\\s*\\.\\s*exit\\s*\\(\\s*1\\s*\\)\\s*;?\\s*\\}?\\s*` +
        `${loaded}\\s*=\\s*${outcome}\\s*\\.\\s*config\\b`,
      'g',
    )
    expect(indicesOf(sequence, SERVER_CODE)).toHaveLength(1)
    // The start path, from the resolution to the start bring-up request (where
    // every start pass reads the applied config), assigns it once: from the
    // outcome. A later assignment outside that window (a confirmed apply,
    // E12/E13) is not the start's.
    const assigns = assignmentsTo(loaded)
    expect(assigns.filter(({ at }) => at > resolveAt && at < bringUpAt).map(({ at }) => at)).toEqual([assignAt])
    // No assignment anywhere reads the config file (the import test above
    // also bans every config loader from server.ts).
    for (const { value } of assigns) {
      expect(value).not.toMatch(/\bCONFIG_PATH\b|\breadFileSync\b|\b(?:load|parse|read)\w*Config\w*\s*\(/)
    }
  })

  test('the start resolution comes AFTER the PID check, so a duplicate start never writes the record', () => {
    const { resolveAt } = startResolution(SERVER_CODE)
    expect(resolveAt).toBeGreaterThan(onlyCallOf('checkPidConflict'))
  })

  test.each([
    ['the PID file', 'writePidFile'],
    ['the template install', 'installSlackChannelBotTemplate'],
    ['the connection manager', 'createPersonaConnectionManager'],
    ['Bun.serve', 'Bun\\.serve'],
    ['the per-persona bring-up', 'runStartBringUp'],
  ])('sets the applied config BEFORE %s', (_label, anchor) => {
    const { assignAt } = startResolution(SERVER_CODE)
    const later = callsOf(anchor)
    expect(later.length).toBeGreaterThan(0)
    for (const at of later) expect(assignAt).toBeLessThan(at)
  })
})

// ---------------------------------------------------------------------------
// Static audit: the unhandledRejection handler (SR-3.3)
// ---------------------------------------------------------------------------

describe('main() installs the unhandledRejection handler before any persona connects (SR-3.3)', () => {
  const INSTALL = /\bprocess\.on\s*\(\s*['"]unhandledRejection['"]\s*,\s*createUnhandledRejectionHandler\s*\(/g

  test('installs createUnhandledRejectionHandler from the connection-errors module, once, inside main() and never at module scope', () => {
    expect(SERVER_CODE).toMatch(
      /import\s*\{[^}]*\bcreateUnhandledRejectionHandler\b[^}]*\}\s*from\s*['"]\.\/persona-connection-errors\.ts['"]/,
    )
    const installs = indicesOf(INSTALL, SERVER_CODE)
    expect(installs).toHaveLength(1)
    // Any other mention of the event (a second install in another form) must
    // also sit inside main().
    for (const at of indicesOf(/['"]unhandledRejection['"]/g, SERVER_CODE)) expect(insideMain(at)).toBe(true)
  })

  test.each([
    ['the connection manager is built', 'createPersonaConnectionManager'],
    ['the per-persona bring-up (the start bring-up request)', 'runStartBringUp'],
  ])('installs it BEFORE %s', (_label, anchor) => {
    const [install] = indicesOf(INSTALL, SERVER_CODE)
    expect(install).toBeDefined()
    expect(install!).toBeLessThan(onlyCallOf(anchor))
  })
})

// ---------------------------------------------------------------------------
// Static audit: the agent-director startup gate runs first (b.jg5 SRJ-203)
// ---------------------------------------------------------------------------

describe('main() runs the agent-director startup gate before any other work, always with the Phase 1 floor (b.jg5 SRJ-203, AC 20)', () => {
  /** The gate's floor-exempt option; typed against the gate's options, so a rename fails the typecheck. */
  const FLOOR_EXEMPT_OPTION: keyof StartupGateOptions = 'skipPhase1Floor'

  /** Offset of the only `runAgentDirectorStartupGate(` call; fails unless there is exactly one. */
  const gateCall = (): number => onlyCallOf('runAgentDirectorStartupGate')

  test('imports runAgentDirectorStartupGate from the startup module and calls it exactly once, awaited, in main()\'s own statement list, with no argument', () => {
    expect(importSource(SERVER_CODE, 'runAgentDirectorStartupGate')).toBe('./agent-director-startup.ts')
    const at = gateCall()
    const awaitAt = SERVER_CODE.slice(0, at).search(/\bawait\s+$/)
    expect(awaitAt).toBeGreaterThanOrEqual(0)
    expect(atMainTopLevel(SERVER_CODE, awaitAt)).toBe(true)
    expect(onlyCallArguments(SERVER_CODE, 'runAgentDirectorStartupGate').trim()).toBe('')
  })

  test('server.ts never names the floor-exempt option and never calls runStartupGate, so the server\'s start always runs the Phase 1 floor', () => {
    expect(indicesOf(new RegExp(`\\b${FLOOR_EXEMPT_OPTION}\\b`, 'g'), SERVER_CODE)).toEqual([])
    expect(callsOf('runStartupGate')).toEqual([])
  })

  test.each([
    ['the PID check', 'checkPidConflict'],
    ['the start resolution', 'resolveStart'],
    ['the connection manager', 'createPersonaConnectionManager'],
    ['Bun.serve', 'Bun\\.serve'],
    ['the start bring-up', 'runStartBringUp'],
  ])('calls it BEFORE %s', (_label, anchor) => {
    const later = callsOf(anchor)
    expect(later.length).toBeGreaterThan(0)
    for (const at of later) expect(gateCall()).toBeLessThan(at)
  })

  test('inside main(), only the state and inbox directory creations and the unhandledRejection handler install come before it', () => {
    const [mainStart] = mainBody(SERVER_CODE)
    // The gate statement starts at its `await`, or at a single
    // `const <name> = ` that binds the gate's result (E3 reads its `adVersion`
    // for the runtime re-check). Only that binding is admitted: any other code
    // before the gate is still left in `before` and fails the check below.
    const gateStatement = SERVER_CODE.slice(0, gateCall()).search(/(?:\bconst\s+[A-Za-z_$][\w$]*\s*=\s*)?\bawait\s+$/)
    const before = SERVER_CODE.slice(mainStart, gateStatement)
    // Cut out each expected statement: every `mkdirSync(…)` call and the
    // guarded install `if (!unhandledRejectionHandlerInstalled) { … }`.
    const cuts: Array<[number, number]> = []
    const dirs: string[] = []
    for (const at of indicesOf(/\bmkdirSync\s*\(/g, before)) {
      const [argsStart, argsEnd] = balancedAfter(before, at, '(', ')')
      dirs.push(splitTopLevel(before.slice(argsStart, argsEnd))[0]!)
      cuts.push([at, argsEnd + 1])
    }
    const guards = indicesOf(/\bif\s*\(\s*!\s*unhandledRejectionHandlerInstalled\s*\)\s*\{/g, before)
    expect(guards).toHaveLength(1)
    const [, guardEnd] = balancedAfter(before, guards[0]!, '{', '}')
    const guardBlock = before.slice(guards[0]!, guardEnd + 1)
    expect(indicesOf(/\bprocess\.on\s*\(\s*['"]unhandledRejection['"]\s*,\s*createUnhandledRejectionHandler\s*\(/g, guardBlock)).toHaveLength(1)
    cuts.push([guards[0]!, guardEnd + 1])

    expect(dirs.sort()).toEqual(['INBOX_DIR', 'STATE_DIR'])
    const rest = cuts
      .sort((a, b) => b[0] - a[0])
      .reduce((text, [from, to]) => text.slice(0, from) + text.slice(to), before)
    expect(rest.replace(/[\s;]/g, '')).toBe('')
  })
})

// ---------------------------------------------------------------------------
// Static audit: the runtime agent-director version re-check (b.jg5 SRJ-204,
// SRJ-205)
//
// What the re-check does (its 120 s timer, each outcome, the stop calling
// `stop(AD_VERSION_RECHECK_STOP_EXIT_CODE)` once, dispose) is driven through
// its real module in tests/ad-version-gate.test.ts. What only server.ts holds
// is where main() installs it, what it is given, and what shutdown does.
// ---------------------------------------------------------------------------

describe('main() installs the runtime agent-director version re-check right after the startup gate, and shutdown disposes it and makes no agent-director call (b.jg5 SRJ-204, SRJ-205)', () => {
  /** The gate result's version field; typed against the gate, so a rename fails the typecheck. */
  const GATE_VERSION_FIELD: keyof Awaited<ReturnType<typeof runAgentDirectorStartupGate>> = 'adVersion'

  /** The options main() passes, and only those: no `clock` (real timers), no interval of its own. */
  const INSTALL_OPTIONS: ReadonlyArray<keyof AdVersionRecheckDeps> = [
    'baselineVersion',
    'log',
    'recordStartupError',
    'resolveSystemBinary',
    'stop',
  ]

  /**
   * The options the stop passes to armShutdownDeadline, and only those: no
   * `clock` (real timers) and no `deadlineMs` (the module's constant).
   */
  const ARM_OPTIONS: ReadonlyArray<keyof ShutdownDeadlineDeps> = ['exit', 'exitCode', 'log']

  /** A parameter name at the start of an arrow function: `(x) =>` or `x =>`. */
  const ARROW_PARAM = /^\(?\s*([A-Za-z_$][\w$]*)\s*\)?\s*=>/

  /**
   * Whether the code at `offset` in the block body `body` starts one of that
   * block's own statements, run on every pass: inside no nested bracket, and
   * not the brace-less body of an `if`, `else`, `while` or `for`. String and
   * template literals are blanked first, so a bracket inside one (a log
   * line's "(see …)") never counts.
   */
  function statementOfBlock(body: string, offset: number): boolean {
    const code = body.replace(/'(?:\\.|[^'\\\n])*'|"(?:\\.|[^"\\\n])*"|`(?:\\.|[^`\\])*`/g, (lit) => `"${' '.repeat(lit.length - 2)}"`)
    const before = code.slice(0, offset)
    let depth = 0
    for (const ch of before) {
      if ('({['.includes(ch)) depth++
      else if (')}]'.includes(ch)) depth--
    }
    if (depth !== 0) return false
    const prior = before.trimEnd()
    if (/\belse$/.test(prior)) return false
    if (!prior.endsWith(')')) return true
    // After a `)`: refuse it when that closes a branch or loop header.
    for (const header of indicesOf(/\b(?:if|while|for)\s*\(/g, prior)) {
      if (balancedAfter(code, header, '(', ')')[1] === prior.length - 1) return false
    }
    return true
  }

  /** The body text of `shutdown()` in server.ts. */
  const shutdownCode = (): string => SERVER_CODE.slice(...shutdownBody(SERVER_CODE))

  /** Offsets in `code` of every `process.exit(` call. */
  const exitsIn = (code: string): number[] => indicesOf(/\bprocess\s*\.\s*exit\s*\(/g, code)

  /** Offsets in `code` of every plain `shutdown(` call. */
  const shutdownCallsIn = (code: string): number[] => indicesOf(/(?<![\w.$])shutdown\s*\(/g, code)

  test('imports installAdVersionRecheck and disposeAdVersionRecheck from the version gate module and resolveSystemBinary from agent-director, and declares none of them itself', () => {
    expect(importSource(SERVER_CODE, 'installAdVersionRecheck')).toBe('./ad-version-gate.ts')
    expect(importSource(SERVER_CODE, 'disposeAdVersionRecheck')).toBe('./ad-version-gate.ts')
    expect(importSource(SERVER_CODE, 'resolveSystemBinary')).toBe('agent-director')
    expect(importSource(SERVER_CODE, 'recordStartupError')).toBe('./startup-errors.ts')
    for (const name of ['installAdVersionRecheck', 'disposeAdVersionRecheck', 'resolveSystemBinary', 'recordStartupError']) {
      expect([name, indicesOf(new RegExp(`\\b(?:let|const|var|function)\\s+${name}\\b`, 'g'), SERVER_CODE)]).toEqual([name, []])
    }
  })

  test('installs it exactly once, in main()\'s own statement list (behind no branch), in the statement right after the awaited startup gate and before the PID check', () => {
    const at = onlyCallOf('installAdVersionRecheck')
    // The import and this call are the only mentions: no second install in
    // another form (an alias, a callback).
    expect(indicesOf(/\binstallAdVersionRecheck\b/g, SERVER_CODE)).toHaveLength(2)
    expect(atMainTopLevel(SERVER_CODE, at)).toBe(true)
    const gate = onlyCallOf('runAgentDirectorStartupGate')
    expect(at).toBeGreaterThan(gate)
    // Right after: nothing but the gate call itself sits between the two.
    const [, gateEnd] = balancedAfter(SERVER_CODE, gate, '(', ')')
    expect(SERVER_CODE.slice(gateEnd + 1, at).replace(/[\s;]/g, '')).toBe('')
    const pidChecks = callsOf('checkPidConflict')
    expect(pidChecks.length).toBeGreaterThan(0)
    for (const pid of pidChecks) expect(at).toBeLessThan(pid)
  })

  test('its options are exactly the resolve, the baseline, the record hook, the stop and the log: no clock and nothing that names health_check_interval', () => {
    const props = onlyCallProps('installAdVersionRecheck')
    expect([...props.keys()].sort()).toEqual([...INSTALL_OPTIONS])
    expect(onlyCallArguments(SERVER_CODE, 'installAdVersionRecheck')).not.toMatch(/\bhealth_check_interval\b/)
  })

  test('its baseline version is the gate\'s result by name: `const <gate> = await runAgentDirectorStartupGate()`, then baselineVersion: <gate>.adVersion', () => {
    const decls = [...SERVER_CODE.matchAll(/\bconst\s+([A-Za-z_$][\w$]*)\s*=\s*await\s+runAgentDirectorStartupGate\s*\(/g)]
    expect(decls).toHaveLength(1)
    expect(onlyCallProps('installAdVersionRecheck').get('baselineVersion')).toBe(`${decls[0]![1]}.${GATE_VERSION_FIELD}`)
  })

  test('its resolve is agent-director\'s resolveSystemBinary, its record hook recordStartupError and its log the server log', () => {
    const props = onlyCallProps('installAdVersionRecheck')
    expect(props.get('resolveSystemBinary')).toBe('resolveSystemBinary')
    expect(props.get('recordStartupError')).toBe('recordStartupError')
    expect(props.get('log')).toMatch(/^\((\w+)\) => console\.error\(\1\)$/)
  })

  // The re-check calls `stop(AD_VERSION_RECHECK_STOP_EXIT_CODE)` (driven in
  // tests/ad-version-gate.test.ts); this case pins that main()'s stop hands
  // that code on untouched, to shutdown and to the exit of a rejected shutdown.
  test('its stop runs shutdown with the exit code the re-check passes (AD_VERSION_RECHECK_STOP_EXIT_CODE, non-zero), and a rejected shutdown still exits with it', () => {
    expect(AD_VERSION_RECHECK_STOP_EXIT_CODE).not.toBe(0)
    const stop = onlyCallProps('installAdVersionRecheck').get('stop')
    expect(stop).toBeDefined()
    const param = stop!.match(ARROW_PARAM)
    expect(param).not.toBeNull()
    const code = param![1]!
    const calls = shutdownCallsIn(stop!)
    expect(calls).toHaveLength(1)
    const args = splitTopLevel(callArguments(stop!, calls[0]!))
    expect(args).toHaveLength(2)
    expect(args[1]).toBe(code)
    // The shutdown promise's rejection is caught with an exit on the same code.
    const [, callEnd] = balancedAfter(stop!, calls[0]!, '(', ')')
    expect(stop!.slice(callEnd + 1)).toMatch(/^\s*\.\s*catch\s*\(/)
    const exits = exitsIn(stop!)
    expect(exits).toHaveLength(1)
    expect(splitTopLevel(callArguments(stop!, exits[0]!))).toEqual([code])
  })

  // No outside party ends a re-check stop (the CLI's SIGKILL follows only its
  // own stop), so the stop arms the fallback exit before it runs shutdown.
  // What the deadline does is driven in tests/shutdown-deadline.test.ts; this
  // case pins that only this stop arms it, first, with the stop's code, the
  // real exit and the module's own clock and deadline.
  test('its stop arms the shutdown deadline first (SRJ-205, AC 21): the one armShutdownDeadline call, from shutdown-deadline.ts, with the stop\'s exit code, process.exit, the server log and no clock or deadline override; the signals and shutdown arm none', () => {
    expect(importSource(SERVER_CODE, 'armShutdownDeadline')).toBe('./shutdown-deadline.ts')
    expect(indicesOf(/\b(?:let|const|var|function)\s+armShutdownDeadline\b/g, SERVER_CODE)).toEqual([])
    // The import and the one call are its only mentions: no alias, no second arm.
    expect(indicesOf(/\barmShutdownDeadline\b/g, SERVER_CODE)).toHaveLength(2)
    onlyCallOf('armShutdownDeadline')

    const stop = onlyCallProps('installAdVersionRecheck').get('stop')
    expect(stop).toBeDefined()
    const code = stop!.match(ARROW_PARAM)![1]!
    // The first statement of the stop's body, behind no branch, so it runs
    // before the stop's shutdown call.
    const body = stop!.slice(...balancedAfter(stop!, stop!.indexOf('=>'), '{', '}'))
    expect(body.trimStart()).toMatch(/^armShutdownDeadline\s*\(/)
    const arms = indicesOf(/(?<![\w.$])armShutdownDeadline\s*\(/g, stop!)
    expect(arms).toHaveLength(1)
    const shutdowns = shutdownCallsIn(stop!)
    expect(shutdowns).toHaveLength(1)
    expect(arms[0]!).toBeLessThan(shutdowns[0]!)

    const args = splitTopLevel(callArguments(stop!, arms[0]!))
    expect(args).toHaveLength(1)
    const props = objectProperties(args[0]!)
    expect([...props.keys()].sort()).toEqual([...ARM_OPTIONS])
    expect(props.get('exitCode')).toBe(code)
    expect(props.get('exit')).toMatch(/^process\s*\.\s*exit(?:\s*\.\s*bind\s*\(\s*process\s*\))?$/)
    expect(props.get('log')).toMatch(/^\((\w+)\) => console\.error\(\1\)$/)

    for (const signal of ['SIGTERM', 'SIGINT']) {
      const handlers = indicesOf(new RegExp(`\\bprocess\\s*\\.\\s*(?:on|once)\\s*\\(\\s*['"]${signal}['"]`, 'g'), SERVER_CODE)
      expect(handlers).toHaveLength(1)
      expect([signal, indicesOf(/\barmShutdownDeadline\b/g, callArguments(SERVER_CODE, handlers[0]!))]).toEqual([signal, []])
    }
    expect(indicesOf(/\barmShutdownDeadline\b/g, shutdownCode())).toEqual([])
  })

  // A shutdown that hangs on a promise with no open handle behind it lets the
  // process run out of work and exit on its own, before the unref'd deadline
  // can fire; that exit carries `process.exitCode`. So the stop sets it to its
  // own code before it runs shutdown, and nothing else in server.ts touches it
  // (a signal's shutdown exits 0 through `shutdown`'s own exit).
  test('its stop sets process.exitCode to the stop\'s exit code, as a statement of its body, before its shutdown call; nothing else in server.ts names process.exitCode', () => {
    const exitCodeRefs = indicesOf(/\bprocess\s*\.\s*exitCode\b/g, SERVER_CODE)
    expect(exitCodeRefs).toHaveLength(1)
    const [argsStart, argsEnd] = balancedAfter(SERVER_CODE, onlyCallOf('installAdVersionRecheck'), '(', ')')
    expect(exitCodeRefs[0]! > argsStart && exitCodeRefs[0]! < argsEnd).toBe(true)

    const stop = onlyCallProps('installAdVersionRecheck').get('stop')
    expect(stop).toBeDefined()
    const code = stop!.match(ARROW_PARAM)![1]!
    const [bodyStart, bodyEnd] = balancedAfter(stop!, stop!.indexOf('=>'), '{', '}')
    const body = stop!.slice(bodyStart, bodyEnd)
    const sets = [...body.matchAll(/\bprocess\s*\.\s*exitCode\s*=(?!=)\s*([^;\s]+)/g)]
    expect(sets).toHaveLength(1)
    expect(sets[0]![1]).toBe(code)
    expect(statementOfBlock(body, sets[0]!.index!)).toBe(true)
    const shutdowns = shutdownCallsIn(body)
    expect(shutdowns).toHaveLength(1)
    expect(sets[0]!.index!).toBeLessThan(shutdowns[0]!)

    for (const signal of ['SIGTERM', 'SIGINT']) {
      const handlers = indicesOf(new RegExp(`\\bprocess\\s*\\.\\s*(?:on|once)\\s*\\(\\s*['"]${signal}['"]`, 'g'), SERVER_CODE)
      expect(handlers).toHaveLength(1)
      expect([signal, indicesOf(/\bexitCode\b/g, callArguments(SERVER_CODE, handlers[0]!))]).toEqual([signal, []])
    }
    expect(indicesOf(/\bprocess\s*\.\s*exitCode\b/g, shutdownCode())).toEqual([])
  })

  // The stop can come while main() is still starting up (the re-check's
  // timer is armed before the PID check). shutdown() stops what it finds, so
  // main() must not start the HTTP server, the start bring-up, the health
  // check or the detection tick once a shutdown has begun. main() can only
  // observe that after it resumes from an await, so each of those calls needs
  // an `if (shuttingDown) return` between the last await before it and the
  // call. Every `await` in main()'s text counts, a closure's included, so the
  // rule errs strict.
  test.each<[string, (controller: string) => RegExp]>([
    ['the HTTP server (Bun.serve)', () => /\bBun\s*\.\s*serve\s*\(/g],
    ['the start bring-up (<controller>.runStartBringUp)', (controller) => new RegExp(`\\b${controller}\\s*\\.\\s*runStartBringUp\\s*\\(`, 'g')],
    ['the health check (startHealthCheck)', () => /(?<![\w.$])startHealthCheck\s*\(/g],
    ['the reload detection tick (<controller>.startDetection)', (controller) => new RegExp(`\\b${controller}\\s*\\.\\s*startDetection\\s*\\(`, 'g')],
    ['the boot template install (installSlackChannelBotTemplate)', () => /(?<![\w.$])installSlackChannelBotTemplate\s*\(/g],
  ])('main() starts %s only if no shutdown has begun: an `if (shuttingDown) return` in main()\'s own statement list after the last await before the call', (_what, callPattern) => {
    const [start, end] = mainBody(SERVER_CODE)
    const calls = indicesOf(callPattern(startResolution(SERVER_CODE).controller), SERVER_CODE)
    expect(calls).toHaveLength(1)
    const at = calls[0]!
    expect(at > start && at < end).toBe(true)
    // The call's own `await`, when it has one, is not an await before it.
    const own = SERVER_CODE.slice(start, at).match(/\bawait\s*$/)
    const callStart = own ? at - own[0].length : at
    const awaits = indicesOf(/\bawait\b/g, SERVER_CODE).filter((a) => a > start && a < callStart)
    expect(awaits.length).toBeGreaterThan(0)
    const lastAwait = awaits[awaits.length - 1]!
    const guards = indicesOf(/\bif\s*\(\s*shuttingDown\s*\)\s*return\b/g, SERVER_CODE)
      .filter((g) => g > lastAwait && g < callStart && atMainTopLevel(SERVER_CODE, g))
    expect(guards.length).toBeGreaterThan(0)
  })

  test('shutdown disposes the re-check exactly once, with no argument, before its first await and before it exits', () => {
    const [start, end] = shutdownBody(SERVER_CODE)
    const at = onlyCallOf('disposeAdVersionRecheck')
    expect(at > start && at < end).toBe(true)
    expect(onlyCallArguments(SERVER_CODE, 'disposeAdVersionRecheck').trim()).toBe('')
    // Before shutdown first yields, so no re-check starts while it closes things.
    const firstAwait = SERVER_CODE.slice(start, end).search(/\bawait\b/)
    expect(firstAwait).toBeGreaterThan(-1)
    expect(at).toBeLessThan(start + firstAwait)
    const exits = exitsIn(SERVER_CODE).filter((exit) => exit > start && exit < end)
    expect(exits.length).toBeGreaterThan(0)
    for (const exit of exits) expect(at).toBeLessThan(exit)
  })

  test('shutdown(reason, exitCode = 0) ends by exiting with its exit code, and exits nowhere else', () => {
    const decl = SERVER_CODE.search(/\basync\s+function\s+shutdown\s*\(/)
    expect(decl).toBeGreaterThan(-1)
    const params = splitTopLevel(callArguments(SERVER_CODE, decl))
    expect(params).toHaveLength(2)
    const exitParam = params[1]!.match(/^([A-Za-z_$][\w$]*)\s*(?::\s*number\s*)?=\s*0$/)
    expect(exitParam).not.toBeNull()
    const code = shutdownCode()
    const exits = exitsIn(code)
    expect(exits).toHaveLength(1)
    expect(splitTopLevel(callArguments(code, exits[0]!))).toEqual([exitParam![1]])
    const [, exitEnd] = balancedAfter(code, exits[0]!, '(', ')')
    expect(code.slice(exitEnd + 1).replace(/[\s;]/g, '')).toBe('')
  })

  test.each(['SIGTERM', 'SIGINT'])('the %s handler runs shutdown with no non-zero exit code', (signal) => {
    const handlers = indicesOf(new RegExp(`\\bprocess\\s*\\.\\s*(?:on|once)\\s*\\(\\s*['"]${signal}['"]`, 'g'), SERVER_CODE)
    expect(handlers).toHaveLength(1)
    const handler = splitTopLevel(callArguments(SERVER_CODE, handlers[0]!))[1]
    expect(handler).toBeDefined()
    const calls = shutdownCallsIn(handler!)
    expect(calls).toHaveLength(1)
    const args = splitTopLevel(callArguments(handler!, calls[0]!))
    // A reason alone (the default exit code 0) or an explicit 0.
    expect(args.length === 1 || (args.length === 2 && args[1] === '0')).toBe(true)
  })

  test('shutdown makes no agent-director call: no client, no detection wrapper, no resolve and no verb the stub client records', () => {
    const code = shutdownCode()
    for (const name of ['getClient', 'withOutageDetection', 'withSpawnDetection', 'resolveSystemBinary']) {
      expect([name, indicesOf(new RegExp(`\\b${name}\\s*\\(`, 'g'), code)]).toEqual([name, []])
    }
    // The verbs: every key of the stub client's call log, less its `Calls` suffix.
    const keys = Object.keys(makeStubCallLog())
    const verbs = keys.map((key) => key.replace(/Calls$/, ''))
    expect(verbs.length).toBeGreaterThan(0)
    expect(verbs.every((verb, i) => verb !== keys[i] && verb !== '')).toBe(true)
    for (const verb of verbs) {
      // A method call (`x.verb(`, `x?.verb(`) or a plain one.
      expect([verb, indicesOf(new RegExp(`(?<![\\w$])${verb}\\s*\\(`, 'g'), code)]).toEqual([verb, []])
    }
  })
})

// ---------------------------------------------------------------------------
// Static audit: agent-director's timing settings are read at start, and again
// only on the version re-check's tick (b.jg5 SRJ-209)
//
// What the install does (the startup read, the re-read after each 120 s
// re-check tick whatever health_check_interval is, none after the re-check's
// dispose, the file under the process's HOME) is driven through its real
// module in tests/ad-settings.test.ts. What only server.ts holds is where
// main() calls it, with what, and that nothing else in server.ts reads the
// file.
// ---------------------------------------------------------------------------

describe('main() installs agent-director\'s settings read once, after the startup gate and the start\'s configuration resolution and before the start bring-up, under the process\'s own HOME (b.jg5 SRJ-209)', () => {
  /** The install; typed against its module, so a rename fails the typecheck. */
  const INSTALL: keyof typeof AdSettingsModule = 'installAdSettings'

  /**
   * What would read the settings, or re-read them, other than through the
   * install: a reader of its own, the reader's production HOME, the file's
   * path, and a listener of its own on the re-check's tick. Typed against
   * their modules, so a rename fails the typecheck.
   */
  const OTHER_READ_NAMES: ReadonlyArray<keyof typeof AdSettingsModule | keyof typeof AdVersionGateModule> = [
    'createAdSettingsReader',
    'productionAdSettingsHome',
    'AD_SETTINGS_RELATIVE_PATH',
    'onAdVersionRecheckTick',
  ]

  /** src/ad-settings.ts with every comment removed. */
  const AD_SETTINGS_CODE = stripComments(readFileSync(join(SRC_DIR, 'ad-settings.ts'), 'utf-8'))

  test('imports the install from the settings module and declares it nowhere itself; the import and one call are its only mentions', () => {
    expect(importSource(SERVER_CODE, INSTALL)).toBe('./ad-settings.ts')
    expect(indicesOf(new RegExp(`\\b(?:let|const|var|function)\\s+${INSTALL}\\b`, 'g'), SERVER_CODE)).toEqual([])
    // No second install in another form (an alias, a callback, a timer).
    expect(indicesOf(new RegExp(`\\b${INSTALL}\\b`, 'g'), SERVER_CODE)).toHaveLength(2)
    onlyCallOf(INSTALL)
  })

  test('calls it in main()\'s own statement list, behind no branch (so in dry run too), as a statement of its own whose result is dropped', () => {
    const at = onlyCallOf(INSTALL)
    expect(atMainTopLevel(SERVER_CODE, at)).toBe(true)
    // Nothing before it on its statement: no binding of the reader it
    // returns (which could be read again on a timer), no await, no operand.
    const before = SERVER_CODE.slice(0, at).trimEnd()
    expect(before).not.toMatch(/(?:[=(,:?&|!+\-*/<>[.]|\b(?:return|await|void|yield|new|typeof|throw|delete))$/)
  })

  test.each<[string, () => number]>([
    ['the startup gate (runAgentDirectorStartupGate)', () => onlyCallOf('runAgentDirectorStartupGate')],
    ['the start resolution (<controller>.resolveStart)', () => startResolution(SERVER_CODE).resolveAt],
    ['the applied config\'s start assignment (<loaded> = <outcome>.config)', () => startResolution(SERVER_CODE).assignAt],
  ])('calls it AFTER %s', (_label, anchor) => {
    expect(onlyCallOf(INSTALL)).toBeGreaterThan(anchor())
  })

  test('calls it BEFORE the start bring-up (<controller>.runStartBringUp)', () => {
    expect(onlyCallOf(INSTALL)).toBeLessThan(startResolution(SERVER_CODE).bringUpAt)
  })

  test('passes no argument, so the read takes its production dependencies: the file under the server process\'s own HOME, and no HOME, health_check_interval or persona value from the configuration', () => {
    expect(onlyCallArguments(SERVER_CODE, INSTALL).trim()).toBe('')
  })

  test('nothing else in server.ts reads the settings: no reader or tick listener of its own, no production HOME, and neither the settings file nor the TOML parser named', () => {
    for (const name of OTHER_READ_NAMES) {
      expect([name, indicesOf(new RegExp(`\\b${name}\\b`, 'g'), SERVER_CODE)]).toEqual([name, []])
    }
    for (const path of [AD_SETTINGS_RELATIVE_PATH, basename(AD_SETTINGS_RELATIVE_PATH)]) {
      expect([path, SERVER_CODE.includes(path)]).toEqual([path, false])
    }
    // The parser package is the one the settings module imports its parse from.
    const parser = importSource(AD_SETTINGS_CODE, 'parse')
    expect(parser).toBeDefined()
    expect(indicesOf(new RegExp(`['"\`]${parser}['"\`]`, 'g'), SERVER_CODE)).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Static audit: the call-timeout start step runs once per start, right after
// the settings read and before the start pass (b.jg5 SRJ-213)
//
// What the step does (one startup check, then the persona client built with
// the setting's value, a warning never stopping the start) is driven through
// the exported step in tests/server.test.ts, and the check and the need in
// tests/ad-settings.test.ts. What only server.ts holds is where main() calls
// the step, with what, and that nothing calls it again.
// ---------------------------------------------------------------------------

describe('main() runs the call-timeout start step once, after the startup gate, the start\'s configuration resolution and the settings read, and before the template install and the start bring-up, over the start-time config (b.jg5 SRJ-213)', () => {
  /** The step, the check it runs and the persona-client builder; typed against their modules, so a rename fails the typecheck. */
  const STEP: keyof typeof ServerModule = '_runCallTimeoutStartStep'
  const CHECK: keyof typeof AdSettingsModule = 'checkAdCallTimeoutAtStartup'
  const BUILD: keyof typeof AdStartupModule = 'buildPersonaClientOrExit'
  const SETTINGS_INSTALL: keyof typeof AdSettingsModule = 'installAdSettings'

  /** Offsets of every code call of the step (its declaration excluded). */
  const stepCalls = (): number[] =>
    indicesOf(new RegExp(`(?<![\\w.$]|\\bfunction\\s+)${STEP}\\s*\\(`, 'g'), SERVER_CODE)

  /** Offset of the only call of the step; fails unless there is exactly one. */
  const stepCall = (): number => {
    const calls = stepCalls()
    expect(calls).toHaveLength(1)
    return calls[0]!
  }

  /** [start, end) of the step's own body in server.ts. */
  const stepBody = (): [number, number] => {
    const decls = indicesOf(new RegExp(`\\bexport\\s+async\\s+function\\s+${STEP}\\s*\\(`, 'g'), SERVER_CODE)
    expect(decls).toHaveLength(1)
    const [, paramsEnd] = balancedAfter(SERVER_CODE, decls[0]!, '(', ')')
    return balancedAfter(SERVER_CODE, paramsEnd, '{', '}')
  }

  test('server.ts declares the step once and calls it exactly once, awaited, in main()\'s own statement list (behind no branch, so in dry run too); its declaration and that call are its only mentions', () => {
    expect(indicesOf(new RegExp(`\\b${STEP}\\b`, 'g'), SERVER_CODE)).toHaveLength(2)
    stepBody()
    const at = stepCall()
    expect(insideMain(at)).toBe(true)
    const awaitAt = SERVER_CODE.slice(0, at).search(/\bawait\s+$/)
    expect(awaitAt).toBeGreaterThanOrEqual(0)
    expect(atMainTopLevel(SERVER_CODE, awaitAt)).toBe(true)
  })

  test('the startup gate is still called exactly once, with no argument, and before the step: its version probe keeps the client\'s default call timeout', () => {
    expect(onlyCallArguments(SERVER_CODE, 'runAgentDirectorStartupGate').trim()).toBe('')
    expect(onlyCallOf('runAgentDirectorStartupGate')).toBeLessThan(stepCall())
  })

  test.each<[string, () => number]>([
    ['the start resolution (<controller>.resolveStart)', () => startResolution(SERVER_CODE).resolveAt],
    ['the applied config\'s start assignment (<loaded> = <outcome>.config)', () => startResolution(SERVER_CODE).assignAt],
    ['the settings install (installAdSettings)', () => onlyCallOf(SETTINGS_INSTALL)],
  ])('calls it AFTER %s', (_label, anchor) => {
    expect(stepCall()).toBeGreaterThan(anchor())
  })

  test.each<[string, () => number[]]>([
    ['the template install (installSlackChannelBotTemplate)', () => callsOf('installSlackChannelBotTemplate')],
    ['the start bring-up (<controller>.runStartBringUp)', () => [startResolution(SERVER_CODE).bringUpAt]],
  ])('calls it BEFORE %s', (_label, anchors) => {
    const later = anchors()
    expect(later.length).toBeGreaterThan(0)
    for (const at of later) expect(stepCall()).toBeLessThan(at)
  })

  // The start-time applied config: the variable set once, from the start
  // outcome's config, and never replaced (a confirmed apply replaces the
  // applied persona set, `<loaded>`, not it). So the step takes the
  // configuration the start resolved, never a loader, the file or a literal.
  test('passes one argument, the start-time applied config: a variable whose only assignment is `= <loaded>`, after the start assignment and before the step, and which no declaration initializes', () => {
    const { loaded, assignAt } = startResolution(SERVER_CODE)
    const args = splitTopLevel(callArguments(SERVER_CODE, stepCall()))
    expect(args).toHaveLength(1)
    const config = args[0]!
    expect(config).toMatch(/^[A-Za-z_$][\w$]*$/)
    const assigns = assignmentsTo(config)
    expect(assigns.map(({ value }) => value)).toEqual([loaded])
    expect(assigns[0]!.at).toBeGreaterThan(assignAt)
    expect(assigns[0]!.at).toBeLessThan(stepCall())
    expect(indicesOf(new RegExp(`\\b(?:let|const|var)\\s+${config}\\b\\s*(?:!?\\s*:[^=;\\n]*)?=(?![=>])`, 'g'), SERVER_CODE)).toEqual([])
  })

  test('the step and the check are on no tick and no timer: no tick listener, interval, timeout or microtask in server.ts names the step, the check or the persona-client builder, and the check runs only inside the step', () => {
    for (const hook of ['onAdVersionRecheckTick', 'setInterval', 'setTimeout', 'queueMicrotask']) {
      for (const at of callsOf(hook)) {
        const args = callArguments(SERVER_CODE, at)
        for (const name of [STEP, CHECK, BUILD]) {
          expect([hook, name, indicesOf(new RegExp(`\\b${name}\\b`, 'g'), args)]).toEqual([hook, name, []])
        }
      }
    }
    // The check: one call in server.ts, inside the step's body, which itself
    // registers nothing on a tick or a timer.
    const [bodyStart, bodyEnd] = stepBody()
    const checks = indicesOf(new RegExp(`(?<![\\w.$])${CHECK}\\s*\\(`, 'g'), SERVER_CODE)
    expect(checks).toHaveLength(1)
    expect(checks[0]! > bodyStart && checks[0]! < bodyEnd).toBe(true)
    const body = SERVER_CODE.slice(bodyStart, bodyEnd)
    for (const hook of ['onAdVersionRecheckTick', 'setInterval', 'setTimeout', 'queueMicrotask', 'installAdVersionRecheck']) {
      expect([hook, indicesOf(new RegExp(`\\b${hook}\\b`, 'g'), body)]).toEqual([hook, []])
    }
  })

  // main() passes the step no deps, so these defaults are what production
  // runs; tests/server.test.ts drives the step only with injected ones.
  test('the step\'s production defaults (PRODUCTION_CALL_TIMEOUT_START_STEP_DEPS), declared once and spread first into the step\'s deps: buildPersonaClient hands the call timeout to buildPersonaClientOrExit, valuesInEffect is adSettingsInEffect, log writes to console.error', () => {
    const decls = indicesOf(/^const\s+PRODUCTION_CALL_TIMEOUT_START_STEP_DEPS\b[^=]*=\s*\{/gm, SERVER_CODE)
    expect(decls).toHaveLength(1)
    const props = objectProperties(SERVER_CODE.slice(SERVER_CODE.indexOf('=', decls[0]!)))
    expect([...props.keys()]).toEqual(['buildPersonaClient', 'valuesInEffect', 'log'])
    expect(props.get('buildPersonaClient')).toMatch(new RegExp(`^\\(\\s*(\\w+)\\s*\\)\\s*=>\\s*${BUILD}\\(\\s*\\1\\s*\\)$`))
    const inEffect: keyof typeof AdSettingsModule = 'adSettingsInEffect'
    expect(props.get('valuesInEffect')).toBe(inEffect)
    expect(props.get('log')).toMatch(/^\(\s*(\w+)\s*\)\s*=>\s*console\.error\(\s*\1\s*\)$/)
    expect(assignmentsTo('PRODUCTION_CALL_TIMEOUT_START_STEP_DEPS')).toEqual([])

    const body = SERVER_CODE.slice(...stepBody())
    expect(body).toMatch(/\{\s*\.\.\.PRODUCTION_CALL_TIMEOUT_START_STEP_DEPS\s*,\s*\.\.\.deps\s*\}/)
  })
})

// ---------------------------------------------------------------------------
// Static audit: the bring-up gets the loaded config and the bring-up
// controller; shutdown cancels the controller's retries (SR-6.1, SR-6.4)
// ---------------------------------------------------------------------------

describe('startupSessionManager runs the SR-6.1 bring-up over the loaded persona config through the bring-up controller, which shutdown cancels (SR-6.1, SR-6.4)', () => {
  test('is the reload controller\'s start bring-up: it gets the applied config the controller supplies and, as its bring-up, the bring-up controller', () => {
    // The only startupSessionManager call is the whole body of the controller's
    // lifecycle `startBringUp`, and its first argument is that closure's
    // parameter: the controller's applied config (the record's at a start
    // from the record), never the module-level config or a config read again
    // from the file. main() requests the pass with no argument, so the
    // controller supplies the config.
    const { createAt, bringUpAt, controller } = startResolution(SERVER_CODE)
    const lifecycle = objectProperties(callArguments(SERVER_CODE, createAt)).get('lifecycle')
    expect(lifecycle).toBeDefined()
    const startBringUp = objectProperties(lifecycle!).get('startBringUp')
    expect(startBringUp).toBeDefined()
    const arrow = startBringUp!.match(/^\(?\s*(\w+)\s*\)?\s*=>\s*startupSessionManager\s*\(/)
    expect(arrow).not.toBeNull()
    // The call is the tail of the body: nothing follows its closing bracket.
    const [, close] = balancedAfter(startBringUp!, arrow![0].length - 1, '(', ')')
    expect(close).toBe(startBringUp!.length - 1)
    const [start, end] = balancedAfter(SERVER_CODE, createAt, '(', ')')
    const at = onlyCallOf('startupSessionManager')
    expect(at > start && at < end).toBe(true)

    const args = onlyCallArgs('startupSessionManager')
    expect(args).toHaveLength(2)
    expect(args[0]).toBe(arrow![1])
    const options = objectProperties(args[1]!)
    expect([...options.keys()]).toEqual(['bringUp'])
    expect(options.get('bringUp')).toBe(constOf('createPersonaBringUpController'))

    expect(insideMain(bringUpAt)).toBe(true)
    expect(SERVER_CODE.slice(bringUpAt)).toMatch(/^runStartBringUp\s*\(\s*\)/)
    expect(SERVER_CODE.slice(0, bringUpAt)).toMatch(new RegExp(`\\bawait\\s+${controller}\\s*\\.\\s*$`))
  })

  test('the health check starts only after the start bring-up returns: one startHealthCheck, inside main(), after the awaited runStartBringUp(), at the applied config\'s interval', () => {
    // The previous test pins `await <controller>.runStartBringUp()`, so a call
    // after it in main() runs once the pass has returned. The reload detection
    // tick (b.av2 SR-8.2) follows the same rule.
    const { bringUpAt, loaded } = startResolution(SERVER_CODE)
    const at = onlyCallOf('startHealthCheck')
    expect(insideMain(at)).toBe(true)
    expect(at).toBeGreaterThan(bringUpAt)
    expect(onlyCallArgs('startHealthCheck')).toEqual([`${loaded}.health_check_interval`])
  })

  test('the bring-up controller is built once, inside main(), over the connection manager, with dry run passed through and spawnForPersona over the applied config as its launch', () => {
    const at = onlyCallOf('createPersonaBringUpController')
    expect(insideMain(at)).toBe(true)
    expect(at).toBeGreaterThan(onlyCallOf('createPersonaConnectionManager'))
    // Built before the start bring-up runs startupSessionManager with it.
    expect(at).toBeLessThan(startResolution(SERVER_CODE).bringUpAt)

    const props = onlyCallProps('createPersonaBringUpController')
    // The whole manager, so a claude_config_dir hold (bug b.g57) can close
    // the persona's connection with its `stop`.
    expect(props.get('connections')).toBe(constOf('createPersonaConnectionManager'))
    expect(props.get('dryRun')).toBe('isDryRun()')
    // b.av2 SR-8.6: the launch reads the applied config at call time (a
    // confirmed apply's step 1 swaps it), falling back to the start-time one.
    const loaded = loadedConfigName(SERVER_CODE)
    const launch = props.get('launch')
    expect(launch).toMatch(new RegExp(`^\\((\\w+)\\) => spawnForPersona\\(\\1, ${loaded} \\?\\? (\\w+), false\\)$`))
    // The fallback is the start-time applied config getRestartDelay reads.
    const appliedName = launch!.match(/\?\? (\w+), false\)$/)![1]
    expect(appliedName).not.toBe(loaded)
    expect(onlyCallProps('initRestart').get('getRestartDelay')).toBe(`() => ${appliedName}.session_restart_delay`)
  })

  // b.av2 SR-8.6: optional in the controller's type, so only this audit makes
  // sure production binds it. Without it every known persona counts as
  // applied: a removed persona's retry would still launch it, and a re-check
  // would use the set it was brought up with (the E11 stale-set carry).
  test('the bring-up controller reads the live applied persona set: appliedPersonas is () => <applied config>?.personas ?? []', () => {
    const props = onlyCallProps('createPersonaBringUpController')
    const loaded = loadedConfigName(SERVER_CODE)
    expect(props.get('appliedPersonas')).toBe(`() => ${loaded}?.personas ?? []`)
    // The same module-level holder the start sets and the reload controller's onApplied swaps.
    expect(SERVER_CODE).toMatch(new RegExp(`^let\\s+${loaded}\\s*:\\s*PersonaConfig\\s*\\|\\s*null\\s*=\\s*null\\s*$`, 'm'))
  })

  test('main() stores the controller for the manager\'s status listener and for shutdown: `bringUps = <controller>` once, inside main(), right after it is built and before anything connects', () => {
    expect(SERVER_CODE).toMatch(/^let\s+bringUps\s*:\s*PersonaBringUpController\s*\|\s*undefined\s*$/m)
    const controller = constOf('createPersonaBringUpController')
    const assigns = assignmentsTo('bringUps')
    expect(assigns.map((a) => a.value)).toEqual([controller])
    const at = assigns[0]!.at
    expect(insideMain(at)).toBe(true)
    expect(at).toBeGreaterThan(onlyCallOf('createPersonaBringUpController'))
    // Nothing connects before the start pass: server.ts never calls a
    // connection manager's bringUp itself, the controller does, from
    // startupSessionManager (the reload controller's start bring-up). So the
    // holder is set before any status can fire. The one `.bringUp(` in
    // server.ts is the reload controller's `lifecycle.bringUp` member (a
    // confirmed apply's step 6), which runs only after the start; what it
    // forwards to is pinned in tests/reload-wiring.test.ts.
    const bringUpCalls = indicesOf(/\.\s*bringUp\s*\(/g, SERVER_CODE)
    expect(bringUpCalls).toHaveLength(1)
    const [optionsStart, optionsEnd] = balancedAfter(SERVER_CODE, onlyCallOf('createReloadController'), '(', ')')
    expect(bringUpCalls[0]!).toBeGreaterThan(optionsStart)
    expect(bringUpCalls[0]!).toBeLessThan(optionsEnd)
    const lifecycle = objectProperties(onlyCallProps('createReloadController').get('lifecycle') ?? '')
    expect(indicesOf(/\.\s*bringUp\s*\(/g, lifecycle.get('bringUp') ?? '')).toHaveLength(1)
    expect(at).toBeLessThan(startResolution(SERVER_CODE).bringUpAt)
    // Right after it is built: the only code between the controller's
    // construction and the assignment is the construction itself.
    const [, callEnd] = balancedAfter(SERVER_CODE, onlyCallOf('createPersonaBringUpController'), '(', ')')
    expect(SERVER_CODE.slice(callEnd + 1, at).trim()).toBe('')
  })

  // Bug b.g57: an unresolvable claude_config_dir is a retrying state the
  // bring-up controller holds, with no Slack connection. Both bindings are
  // optional (the controller's `checkConfigDir` defaults to a check against
  // the OS home and file system, and with no hook a launch only logs and
  // launches nothing), so only this audit makes sure production wires them:
  // without the hook a persona whose directory stops resolving after it came
  // up would keep its connection and never be launched once the directory
  // resolves; with another check, the check before its Slack step or the
  // re-check could pass a directory the launch then refuses.
  test('bug b.g57: the bring-up controller checks and re-checks a persona\'s claude_config_dir with the launch\'s own check, checkLaunchConfigDir from the session manager', () => {
    expect(onlyCallProps('createPersonaBringUpController').get('checkConfigDir')).toBe('checkLaunchConfigDir')
    expect(importSource(SERVER_CODE, 'checkLaunchConfigDir')).toBe('./session-manager.ts')
    expect(indicesOf(/\b(?:let|const|var|function)\s+checkLaunchConfigDir\b/g, SERVER_CODE)).toEqual([])
  })

  // Bug b.g57: the reload preview lists an added persona whose
  // claude_config_dir cannot be resolved. Its `checkConfigDir` is optional
  // (default: a check against the OS home and file system), so only this
  // audit makes sure the preview resolves the directory with the same check
  // the persona's bring-up and launch will use; with another check the
  // preview could promise a persona that is then held, or warn about one
  // that comes up.
  test('bug b.g57: the reload preview checks an added persona\'s claude_config_dir with the launch\'s own check, checkLaunchConfigDir from the session manager', () => {
    expect(onlyCallProps('createReloadController').get('checkConfigDir')).toBe('checkLaunchConfigDir')
    expect(importSource(SERVER_CODE, 'checkLaunchConfigDir')).toBe('./session-manager.ts')
    expect(indicesOf(/\b(?:let|const|var|function)\s+checkLaunchConfigDir\b/g, SERVER_CODE)).toEqual([])
  })

  test('bug b.g57: a launch hands an unresolvable claude_config_dir to the bring-up controller: setConfigDirUnresolvableHook(<controller>.holdForConfigDir) once, on every start, after `bringUps = <controller>` and before any launch path is wired', () => {
    const controller = constOf('createPersonaBringUpController')
    const at = onlyCallOf('setConfigDirUnresolvableHook')
    expect(onlyCallArgs('setConfigDirUnresolvableHook')).toEqual([`${controller}.holdForConfigDir`])
    expect(importSource(SERVER_CODE, 'setConfigDirUnresolvableHook')).toBe('./session-manager.ts')
    expect(indicesOf(/\b(?:let|const|var|function)\s+setConfigDirUnresolvableHook\b/g, SERVER_CODE)).toEqual([])
    // In main()'s own statement list, so dry run included and behind no branch.
    expect(atMainTopLevel(SERVER_CODE, at)).toBe(true)
    const handoff = assignmentsTo('bringUps')
    expect(handoff).toHaveLength(1)
    expect(at).toBeGreaterThan(handoff[0]!.at)
    // Before the restart module (its launches) and the start bring-up (the
    // start's launches) can launch anything.
    expect(at).toBeLessThan(onlyCallOf('initRestart'))
    expect(at).toBeLessThan(startResolution(SERVER_CODE).bringUpAt)
  })

  test('shutdown cancels every persona\'s bring-up retry, once, before the Slack connections stop', () => {
    const [start, end] = shutdownBody(SERVER_CODE)
    const inShutdown = (at: number) => at > start && at < end

    const cancels = indicesOf(/\bbringUps\s*\?\.\s*cancelAll\s*\(\s*\)/g, SERVER_CODE)
    expect(cancels).toHaveLength(1)
    expect(inShutdown(cancels[0]!)).toBe(true)

    const stops = indicesOf(/\bconnections\s*\?\.\s*stopAll\s*\(\s*\)/g, SERVER_CODE)
    expect(stops).toHaveLength(1)
    expect(inShutdown(stops[0]!)).toBe(true)
    expect(cancels[0]!).toBeLessThan(stops[0]!)
  })
})

// ---------------------------------------------------------------------------
// Static audit: the persona connection seams (SR-3.1, SR-3.4, SR-4.1, SR-7.2)
//
// The seams themselves (clientFor, the identity getter, the up→flush listener,
// the event router, the archive source) are driven through the real connection
// manager in tests/persona-connection-wiring.test.ts; what only main() and the
// module scope hold is which seam gets which argument.
// ---------------------------------------------------------------------------

describe('server.ts wires the persona connection seams (SR-3.1, SR-3.4, SR-4.1, SR-7.2)', () => {
  test('the connection manager takes dry run from isDryRun() and, on each status, flushes on up the notifier every persona notice goes through and tells the bring-up controller', () => {
    const notifier = constOf('createPersonaNotifier')
    // The notices' notifier: the session manager's sink and the outage state's notify.
    expect(onlyCallArgs('setSessionNotifier')).toEqual([`${notifier}.notify`])
    expect(onlyCallProps('initOutageState').get('notify')).toContain(`${notifier}.notify(`)

    const props = onlyCallProps('createPersonaConnectionManager')
    expect(props.get('dryRun')).toBe('isDryRun()')
    expect(props.get('onStatus')).toStartWith('composePersonaStatusListeners(')
    const listeners = onlyCallArgs('composePersonaStatusListeners')
    expect(listeners).toHaveLength(2)
    expect(listeners[0]).toBe(`createPersonaUpFlushListener(${notifier})`)
    // The controller is built after (and over) the manager, so the listener
    // reaches it through the module-scope holder, never the local const (which
    // would be in its temporal dead zone when the manager is built).
    expect(listeners[1]).toMatch(/^\((\w+), (\w+)\) => bringUps\?\.onConnectionStatus\(\1, \2\)$/)
    expect(listeners[1]).not.toContain(constOf('createPersonaBringUpController'))
  })

  test('the Slack API base URL override (E14 Task 4): resolved once, inside main(), from process.env with the manager’s log, before the manager is built, and passed to it as slackApiUrl', () => {
    expect(importSource(SERVER_CODE, 'resolveSlackApiUrlOverride')).toBe('./persona-slack-clients.ts')
    const resolveAt = onlyCallOf('resolveSlackApiUrlOverride')
    expect(insideMain(resolveAt)).toBe(true)
    expect(resolveAt).toBeLessThan(onlyCallOf('createPersonaConnectionManager'))
    const managerProps = onlyCallProps('createPersonaConnectionManager')
    expect(onlyCallArgs('resolveSlackApiUrlOverride')).toEqual(['process.env', managerProps.get('log')!])
    expect(managerProps.get('log')).toBe('(line) => console.error(line)')
    expect(managerProps.get('slackApiUrl')).toBe(constOf('resolveSlackApiUrlOverride'))
  })

  test('only persona-slack-clients.ts names CSCB_SLACK_API_URL or its constant; no other src file reads the variable', () => {
    const offenders = srcFiles()
      .filter(([path]) => path !== 'src/persona-slack-clients.ts')
      .filter(([, source]) => /\bCSCB_SLACK_API_URL\b|\bSLACK_API_URL_OVERRIDE_ENV\b/.test(stripComments(source)))
      .map(([path]) => path)
    expect(offenders).toEqual([])
  })

  test('the notifier and the permission poller share one destination resolver: createPersonaDestinations built once, at module scope, and passed as `destinations` to both (b.av2 SR-7.1)', () => {
    const resolver = constOf('createPersonaDestinations')
    expect(insideMain(onlyCallOf('createPersonaDestinations'))).toBe(false)
    expect(onlyCallProps('createPersonaNotifier').get('destinations')).toBe(resolver)
    expect(onlyCallProps('startPermissionPoller').get('destinations')).toBe(resolver)
  })

  test('main() points the lookups at the manager: `connections = <manager>` once, inside main(), before the bring-up', () => {
    const manager = constOf('createPersonaConnectionManager')
    const assigns = assignmentsTo('connections')
    expect(assigns.map((a) => a.value)).toEqual([manager])
    expect(insideMain(assigns[0]!.at)).toBe(true)
    expect(assigns[0]!.at).toBeGreaterThan(onlyCallOf('createPersonaConnectionManager'))
    expect(assigns[0]!.at).toBeLessThan(startResolution(SERVER_CODE).bringUpAt)
  })

  test('clientFor and identityFor are the persona-start lookups over the connection view of `connections` and the loaded config', () => {
    const view = SERVER_CODE.search(/\bconst\s+connectionView\b[^=]*=\s*\{/)
    expect(view).toBeGreaterThan(-1)
    const viewProps = objectProperties(SERVER_CODE.slice(SERVER_CODE.indexOf('=', view)))
    expect([...viewProps.keys()].sort()).toEqual(['identity', 'status', 'webClient'])
    for (const [query, value] of viewProps) {
      expect(value).toMatch(new RegExp(`^\\((\\w+)\\) => connections\\?\\.${query}\\(\\1\\)$`))
    }

    const loaded = loadedConfigName(SERVER_CODE)
    expect(constOf('createPersonaClientLookup')).toBe('clientFor')
    expect(onlyCallArgs('createPersonaClientLookup')).toEqual(['connectionView', `() => ${loaded}`])
    expect(constOf('createPersonaIdentityLookup')).toBe('identityFor')
    expect(onlyCallArgs('createPersonaIdentityLookup')).toEqual(['connectionView', `() => ${loaded}`])
  })

  test('the persona routing reads bot identities through identityFor, clients through clientFor and archives through archiveWrite', () => {
    const props = onlyCallProps('createPersonaRouting')
    expect(props.get('getBotIdentity')).toBe('identityFor')
    expect(props.has('getBotUserId')).toBe(false)
    expect(props.get('clientFor')).toBe('clientFor')
    expect(props.get('archive')).toMatch(/^\((\w+), (\w+)\) => archiveWrite\?\.\(\1, \2\)$/)
  })

  test('the persona routing raises lost-message notices through the one persona notifier\'s notify (b.av2 SR-7.3), with every argument passed on', () => {
    const notifier = constOf('createPersonaNotifier')
    const notify = onlyCallProps('createPersonaRouting').get('notify')
    expect(notify).toBeDefined()
    if (notify === `${notifier}.notify`) {
      // Read at build time: the notifier must already exist (no temporal dead zone at import).
      expect(onlyCallOf('createPersonaRouting')).toBeGreaterThan(onlyCallOf('createPersonaNotifier'))
    } else {
      // Read at call time, so the routing may be built before the notifier.
      expect(notify).toMatch(new RegExp(`^\\((\\w+), (\\w+), (\\w+)\\) => ${notifier}\\.notify\\(\\1, \\2, \\3\\)$`))
    }
  })

  test('archiveWrite is set only inside main(), to the persona archive writer over the name resolver source on clientFor', () => {
    const assigns = assignmentsTo('archiveWrite')
    expect(assigns.length).toBeGreaterThan(0)
    for (const { at } of assigns) expect(insideMain(at)).toBe(true)
    const writers = assigns.filter((a) => a.value !== 'undefined')
    expect(writers).toHaveLength(1)
    expect(writers[0]!.value).toStartWith('createPersonaArchiveWriter(')
    const call = SERVER_CODE.indexOf('createPersonaArchiveWriter', writers[0]!.at)
    const args = splitTopLevel(callArguments(SERVER_CODE, call))
    expect(args).toHaveLength(3)
    expect(args[1]).toBe('createPersonaNameResolverSource(clientFor)')
  })
})

// ---------------------------------------------------------------------------
// Static audit: only a serving persona is relaunched; the restart delay
// ---------------------------------------------------------------------------

describe('server.ts gates every relaunch on the persona\'s connection (SR-6.1) and reads the restart delay from the applied config', () => {
  test('the relaunch gate is built once, inside main(), over the connection manager and the bring-up controller\'s outcomes', () => {
    constOf('createPersonaRelaunchGate')
    const at = onlyCallOf('createPersonaRelaunchGate')
    expect(insideMain(at)).toBe(true)
    expect(at).toBeGreaterThan(onlyCallOf('createPersonaBringUpController'))
    const args = onlyCallArgs('createPersonaRelaunchGate')
    expect(args).toHaveLength(3)
    expect(args[0]).toBe(constOf('createPersonaConnectionManager'))
    expect(args[2]).toBe(constOf('createPersonaBringUpController'))
  })

  test('the restart module asks the gate before it touches a persona: canRestart is the gate (b.av2 SR-6.4)', () => {
    expect(onlyCallProps('initRestart').get('canRestart')).toBe(constOf('createPersonaRelaunchGate'))
  })

  test('the restart module\'s launch passes the live applied config (read at call time, SR-8.6) and the gate to launchSession as canLaunch', () => {
    const gate = constOf('createPersonaRelaunchGate')
    expect(onlyCallProps('initRestart').get('launchSession')).toContain('launchSession(')
    const args = onlyCallArgs('launchSession')
    expect(args).toHaveLength(3)
    // The live applied set a confirmed reload swaps, never the start-time config.
    expect(args[1]).toBe(loadedConfigName(SERVER_CODE))
    expect(objectProperties(args[2]!).get('canLaunch')).toBe(gate)
  })

  // Bug b.g57: the adapter's persona lookup is optional; without it a restart
  // of a persona whose claude_config_dir no longer resolves would kill its
  // instance ahead of a launch that cannot be made.
  test('bug b.g57: the restart module\'s kill is the kill adapter over the live applied persona lookup, getAppliedPersona', () => {
    expect(onlyCallProps('initRestart').get('killSession')).toBe('_buildKillSessionAdapter(getAppliedPersona)')
    // The only adapter built (its declaration aside): no other kill path without the lookup.
    expect(indicesOf(/(?<![\w.$]|function\s+)_buildKillSessionAdapter\s*\(/g, SERVER_CODE)).toHaveLength(1)
    // getAppliedPersona reads the holder at call time (pinned in tests/reload-wiring.test.ts).
    expect(indicesOf(/\bfunction\s+getAppliedPersona\s*\(/g, SERVER_CODE)).toHaveLength(1)
  })

  test('the health check\'s work list is built over the loaded config with the gate', () => {
    expect(onlyCallProps('initHealthCheck').get('getPersonas')).toContain('buildPersonaWorkList(')
    expect(onlyCallArgs('buildPersonaWorkList')).toEqual([loadedConfigName(SERVER_CODE), constOf('createPersonaRelaunchGate')])
  })

  test('getRestartDelay reads session_restart_delay from the config main() loaded', () => {
    const { loaded, assignAt, createAt } = startResolution(SERVER_CODE)
    const delay = onlyCallProps('initRestart').get('getRestartDelay')?.match(/^\(\) => (\w+)\.session_restart_delay$/)
    expect(delay).not.toBeNull()
    // The start-time config: declared once, inside main(), before the reload
    // controller (whose onApplied also reads it), and assigned exactly once,
    // from the loaded config, after the start resolution set it.
    const startTime = delay![1]!
    const decls = [...SERVER_CODE.matchAll(new RegExp(`\\b(?:let|const|var)\\s+${startTime}\\b[^\\n]*`, 'g'))]
    expect(decls.map((d) => d[0].trim())).toEqual([`let ${startTime}!: PersonaConfig`])
    expect(insideMain(decls[0]!.index!)).toBe(true)
    expect(decls[0]!.index!).toBeLessThan(createAt)
    const assignments = assignmentsTo(startTime)
    expect(assignments.map((a) => a.value)).toEqual([loaded])
    expect(insideMain(assignments[0]!.at)).toBe(true)
    expect(assignments[0]!.at).toBeGreaterThan(assignAt)
  })
})

// ---------------------------------------------------------------------------
// Static audit: the UNAVAILABLE retry timers (b.jg5 SRJ-301, SRJ-305)
//
// A trigger reaches a persona's retry timer only through the controller
// main() installs as the outage state's trigger sink, so the install must
// come before the start bring-up's launches (the first attempts that can arm
// one); shutdown stops every timer. What the controller does (the waits, the
// stop rules, close refusing later arms) is driven on a fake clock in
// tests/unavailable-retry.test.ts; the teardown's stop is pinned in
// tests/reload-wiring.test.ts. Pinned here: placement, and which production
// function backs each of the full-mode retry action's stop and in-flight
// reads, and what the restart module's arm hook arms.
// ---------------------------------------------------------------------------

describe('main() installs one UNAVAILABLE retry controller as the trigger sink before the start bring-up, and shutdown stops every retry timer (b.jg5 SRJ-301, SRJ-305)', () => {
  test('the controller is built exactly once, in main()\'s own statement list (not at module scope, behind no branch), on the production clock, and handed to the module-scope handle shutdown reads', () => {
    const at = onlyCallOf('createUnavailableRetryController')
    const controller = constOf('createUnavailableRetryController')
    const decl = SERVER_CODE.search(new RegExp(`\\bconst\\s+${controller}\\s*=\\s*createUnavailableRetryController\\s*\\(`))
    expect(decl).toBeLessThan(at)
    expect(atMainTopLevel(SERVER_CODE, decl)).toBe(true)
    expect(importSource(SERVER_CODE, 'createUnavailableRetryController')).toBe('./unavailable-retry.ts')
    expect(indicesOf(/\b(?:let|const|var|function)\s+createUnavailableRetryController\b/g, SERVER_CODE)).toEqual([])

    // The production clock: none given (the controller's default is the
    // system clock), or the system clock by name.
    const clock = onlyCallProps('createUnavailableRetryController').get('clock')
    expect([undefined, 'SYSTEM_PERSONA_CONNECTION_CLOCK']).toContain(clock)
    if (clock !== undefined) expect(importSource(SERVER_CODE, clock)).toBe('./persona-connections.ts')

    // The one handle shutdown reads: a module-scope `let`, assigned only
    // this controller, once, in main()'s own statement list after it is built.
    const handles = [...SERVER_CODE.matchAll(/^let\s+(\w+)\s*:\s*UnavailableRetryController\s*\|\s*undefined\s*$/gm)]
    expect(handles).toHaveLength(1)
    const handle = handles[0]![1]!
    expect(insideMain(handles[0]!.index!)).toBe(false)
    const assigned = assignmentsTo(handle)
    expect(assigned.map((a) => a.value)).toEqual([controller])
    expect(atMainTopLevel(SERVER_CODE, assigned[0]!.at)).toBe(true)
    expect(assigned[0]!.at).toBeGreaterThan(at)
  })

  test('it is the trigger sink of the one initOutageState call, in main()\'s own statement list, after the controller is built and before the start bring-up and the restart module', () => {
    const controller = constOf('createUnavailableRetryController')
    const install = onlyCallOf('initOutageState')
    expect(onlyCallProps('initOutageState').get('triggerSink')).toBe(controller)
    expect(atMainTopLevel(SERVER_CODE, install)).toBe(true)
    expect(install).toBeGreaterThan(onlyCallOf('createUnavailableRetryController'))
    expect(install).toBeLessThan(startResolution(SERVER_CODE).bringUpAt)
    expect(install).toBeLessThan(onlyCallOf('initRestart'))
    // Nothing else names a trigger sink in server.ts.
    expect(indicesOf(/\btriggerSink\b/g, SERVER_CODE)).toHaveLength(1)
  })

  test('shutdown stops every retry timer exactly once, with the shutdown reason: after the shutting-down flag is raised, right after cancelAllRestartTimers, and before the HTTP server stops', () => {
    const [start, end] = shutdownBody(SERVER_CODE)
    const inShutdown = (at: number) => at > start && at < end
    const handle = SERVER_CODE.match(/^let\s+(\w+)\s*:\s*UnavailableRetryController\s*\|\s*undefined\s*$/m)![1]!

    const closes = indicesOf(new RegExp(`\\b${handle}\\s*\\?\\.\\s*close\\s*\\(\\s*UNAVAILABLE_RETRY_STOP_SHUTDOWN\\s*\\)`, 'g'), SERVER_CODE)
    expect(closes).toHaveLength(1)
    const at = closes[0]!
    expect(inShutdown(at)).toBe(true)
    expect(importSource(SERVER_CODE, 'UNAVAILABLE_RETRY_STOP_SHUTDOWN')).toBe('./unavailable-retry.ts')
    // No other stop of every timer anywhere in server.ts.
    expect(indicesOf(new RegExp(`\\b${handle}\\s*[?!]?\\.\\s*(?:close|stopAll)\\s*\\(`, 'g'), SERVER_CODE)).toEqual([at])
    const controller = constOf('createUnavailableRetryController')
    expect(indicesOf(new RegExp(`\\b${controller}\\s*[?!]?\\.\\s*(?:close|stopAll)\\s*\\(`, 'g'), SERVER_CODE)).toEqual([])

    // After the flag is raised (so no launch that meets UNAVAILABLE after it
    // is mistaken for live work), beside the restart timers' cancel.
    const raises = indicesOf(/(?<![\w.$])shuttingDown\s*=\s*true\b/g, SERVER_CODE)
    expect(raises).toHaveLength(1)
    expect(inShutdown(raises[0]!)).toBe(true)
    expect(at).toBeGreaterThan(raises[0]!)
    const cancels = indicesOf(/(?<![\w.$])cancelAllRestartTimers\s*\(\s*\)/g, SERVER_CODE).filter(inShutdown)
    expect(cancels).toHaveLength(1)
    expect(SERVER_CODE.slice(balancedAfter(SERVER_CODE, cancels[0]!, '(', ')')[1] + 1, at).replace(/[\s;]/g, '')).toBe('')

    // Before the HTTP server stops, and before shutdown first yields.
    const httpStops = indicesOf(/\bhttpServer\s*\.\s*stop\s*\(/g, SERVER_CODE).filter(inShutdown)
    expect(httpStops).toHaveLength(1)
    expect(at).toBeLessThan(httpStops[0]!)
    const firstAwait = SERVER_CODE.slice(start, end).search(/\bawait\b/)
    expect(firstAwait).toBeGreaterThan(-1)
    expect(at).toBeLessThan(start + firstAwait)
  })

  // A stub for any of these dependencies type-checks, so only this audit
  // makes sure production binds the real one: a stub in-flight or cap read
  // would still launch over an in-flight launch or past the cap. Only these
  // members are pinned, not the full key set.
  test('the controller\'s action is the full-mode retry action over the restart module\'s retry entry, the live applied persona lookup, the relaunch gate, the restart cap, the restart module\'s shutdown flag, the session manager\'s isLaunchInFlight and its row read (readPersonaRowState)', () => {
    expect(onlyCallProps('createUnavailableRetryController').get('action')!.startsWith('createFullModeRetryAction(')).toBe(true)
    expect(importSource(SERVER_CODE, 'createFullModeRetryAction')).toBe('./unavailable-retry.ts')
    const props = onlyCallProps('createFullModeRetryAction')

    expect(props.get('retry')).toBe('runRestartRetry')
    expect(importSource(SERVER_CODE, 'runRestartRetry')).toBe('./restart.ts')

    // getAppliedPersona reads the holder at call time (pinned in tests/reload-wiring.test.ts).
    expect(props.get('appliedPersona')).toBe('getAppliedPersona')

    const gate = constOf('createPersonaRelaunchGate')
    // The gate itself, or a call-time wrapper around it (the gate is declared
    // after the controller is built).
    const canRelaunch = props.get('canRelaunch')!
    expect(canRelaunch === gate || new RegExp(`^\\(?(\\w+)\\)? => ${gate}\\(\\1\\)$`).test(canRelaunch)).toBe(true)

    expect(props.get('isAtCap')).toMatch(/^\(?(\w+)\)? => backoffIsAtCap\(\1, RESTART_FAILURE_CAP\)$/)
    expect(importSource(SERVER_CODE, 'backoffIsAtCap')).toBe('./backoff.ts')
    expect(importSource(SERVER_CODE, 'RESTART_FAILURE_CAP')).toBe('./restart.ts')

    expect(props.get('isShuttingDown')).toBeDefined()
    expect(props.get('isShuttingDown')).toBe(onlyCallProps('initRestart').get('isShuttingDown')!)

    expect(props.get('isInFlight')).toBe('isLaunchInFlight')
    expect(importSource(SERVER_CODE, 'isLaunchInFlight')).toBe('./session-manager.ts')

    // b.jg5 SRJ-303, SRJ-115: a pending-only retry's row read is the session
    // manager's, one `status` call through the outage wrapper.
    expect(props.get('readRow')).toBe('readPersonaRowState')
    expect(importSource(SERVER_CODE, 'readPersonaRowState')).toBe('./session-manager.ts')
  })

  // b.jg5 SRJ-314: the restart module's arm hook is optional (absent, nothing
  // is armed), so a production wiring that dropped it, or bound it to a stub
  // or another controller, would type-check and pass every behaviour suite
  // while an `unknown` liveness reading armed no retry. What the hook's call
  // does is tested in tests/restart.test.ts; pinned here: its binding.
  test('the restart module\'s arm hook (armRetryTimer) arms this controller for the persona it is given, with the read-error cause (b.jg5 SRJ-314, SRJ-301)', () => {
    const controller = constOf('createUnavailableRetryController')
    const hook = onlyCallProps('initRestart').get('armRetryTimer')
    expect(hook).toBeDefined()
    // `(key) => { <controller>.arm(key, { kind: UNAVAILABLE_RETRY_CAUSE_READ_ERROR }) }`,
    // or the same call as an expression body; the parameter's name is free.
    const arm = `${controller}\\.arm\\(\\1, \\{ kind: UNAVAILABLE_RETRY_CAUSE_READ_ERROR \\}\\)`
    expect(hook).toMatch(new RegExp(`^\\(?(\\w+)\\)? => (?:\\{ ${arm};? \\}|${arm})$`))
    expect(importSource(SERVER_CODE, 'UNAVAILABLE_RETRY_CAUSE_READ_ERROR')).toBe('./unavailable-retry.ts')
    // The controller is built before the restart module is initialised.
    expect(onlyCallOf('createUnavailableRetryController')).toBeLessThan(onlyCallOf('initRestart'))
  })
})

// ---------------------------------------------------------------------------
// Static audit: b.jg5 SRJ-314 / SRJ-115 — the restart module's `pending`
// deferral is server.ts's one `deferPendingRow`
//
// `RestartDeps.deferPendingRow` is optional (absent, a `pending` liveness
// reading defers silently), so a production wiring that dropped it, bound it
// to a stub or dropped the reading's launch start would type-check and pass
// every behaviour suite while the deferral line lost the launch start or went
// unlogged. What the deferral does is tested in tests/restart.test.ts and
// tests/server.test.ts; pinned here: its binding.
// ---------------------------------------------------------------------------

describe('main() binds the restart module\'s pending deferral (deferPendingRow) to server.ts\'s one deferPendingRow, with the reading\'s launch start (b.jg5 SRJ-314, SRJ-115)', () => {
  // Tied to src by type: renaming the member or the reading's field fails the typecheck.
  const DEP: keyof RestartDeps = 'deferPendingRow'
  const LAUNCH_FIELD: keyof PendingLivenessReading = 'launchStartedAt'

  test('the hook passes its own key and the reading\'s launch start to the one module-scope deferPendingRow', () => {
    const hook = onlyCallProps('initRestart').get(DEP)
    expect(hook).toBeDefined()
    // `(key, reading) => { deferPendingRow(key, reading.launchStartedAt) }`,
    // or the same call as an expression body; the parameters' names are free.
    const call = `${DEP}\\(\\1, \\2\\.${LAUNCH_FIELD}\\)`
    expect(hook).toMatch(new RegExp(`^\\((\\w+), (\\w+)\\) => (?:\\{ ${call};? \\}|${call})$`))
    // Not an import, and declared once, at module scope.
    expect(importSource(SERVER_CODE, DEP)).toBeUndefined()
    expect(indicesOf(new RegExp(`\\b(?:function|const|let|var)\\s+${DEP}\\b`, 'g'), SERVER_CODE)).toHaveLength(1)
    expect(indicesOf(new RegExp(`^(?:export )?function ${DEP}\\(`, 'gm'), SERVER_CODE)).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// Static audit: b.jg5 SRJ-1016 — the one set of per-persona notice episodes
//
// The episodes' clock is optional (absent, the system clock) and any sink
// type-checks, so a production wiring on a fake clock, with a sink that
// bypasses the persona notifier, built twice (two latches for one episode),
// behind a branch or after the start pass (a first launch's notice with no
// latch to reach) would pass every behaviour suite. What the episodes do is
// tested in tests/persona-episodes.test.ts and the teardown's forget in
// tests/persona-lifecycle.test.ts and tests/reload-wiring.test.ts; pinned
// here: the build, its dependencies and shutdown's close. A forget-all in its
// place would end every episode but leave a later begin open: a launch still
// in flight at shutdown could open an episode and arm an alert check after it.
// ---------------------------------------------------------------------------

describe('main() builds the one set of per-persona notice episodes before the start pass, on the production clock, with the persona notifier as its sink, and shutdown closes them (b.jg5 SRJ-1016, SRJ-309)', () => {
  // Tied to src by type: renaming any of these fails the typecheck.
  const FACTORY: keyof typeof PersonaEpisodesModule = 'createPersonaEpisodes'
  const SINK: keyof PersonaEpisodesDeps = 'sink'
  const CLOCK: keyof PersonaEpisodesDeps = 'clock'
  const FORGET_ALL: keyof PersonaEpisodes = 'forgetAll'
  const CLOSE: keyof PersonaEpisodes = 'close'
  const SYSTEM_CLOCK: keyof typeof PersonaConnectionsModule = 'SYSTEM_PERSONA_CONNECTION_CLOCK'
  const NOTIFIER_FACTORY: keyof typeof PersonaNotifierModule = 'createPersonaNotifier'
  const NOTIFY: keyof PersonaNotifier = 'notify'

  /** The one module-scope `let <handle>: PersonaEpisodes | undefined` shutdown reads. */
  const HANDLE = /^let\s+(\w+)\s*:\s*PersonaEpisodes\s*\|\s*undefined\s*$/gm

  test('the instance is built exactly once, in main()\'s own statement list (not at module scope, behind no branch), before the retry controller, initRestart, the start bring-up and initHealthCheck, and handed to the module-scope handle shutdown reads', () => {
    const at = onlyCallOf(FACTORY)
    const episodes = constOf(FACTORY)
    const decl = SERVER_CODE.search(new RegExp(`\\bconst\\s+${episodes}\\s*=\\s*${FACTORY}\\s*\\(`))
    expect(decl).toBeGreaterThan(-1)
    expect(decl).toBeLessThan(at)
    expect(atMainTopLevel(SERVER_CODE, decl)).toBe(true)
    expect(importSource(SERVER_CODE, FACTORY)).toBe('./persona-episodes.ts')
    expect(indicesOf(new RegExp(`\\b(?:let|const|var|function)\\s+${FACTORY}\\b`, 'g'), SERVER_CODE)).toEqual([])

    // Before every poster can reach it: the retry controller (whose retries
    // post), the restart module, the start bring-up (the first launches) and
    // the health check.
    const { bringUpAt } = startResolution(SERVER_CODE)
    for (const later of [onlyCallOf('createUnavailableRetryController'), onlyCallOf('initRestart'), bringUpAt, onlyCallOf('initHealthCheck')]) {
      expect(at).toBeLessThan(later)
    }

    // The one handle shutdown reads: a module-scope `let`, assigned only this
    // instance, once, in main()'s own statement list, after it is built and
    // before the start bring-up.
    const handles = [...SERVER_CODE.matchAll(HANDLE)]
    expect(handles).toHaveLength(1)
    expect(insideMain(handles[0]!.index!)).toBe(false)
    const assigned = assignmentsTo(handles[0]![1]!)
    expect(assigned.map((a) => a.value)).toEqual([episodes])
    expect(atMainTopLevel(SERVER_CODE, assigned[0]!.at)).toBe(true)
    expect(assigned[0]!.at).toBeGreaterThan(at)
    expect(assigned[0]!.at).toBeLessThan(bringUpAt)
  })

  test('its clock is the production default and its sink is the module-scope persona notifier\'s notify', () => {
    const props = onlyCallProps(FACTORY)

    // The production clock: none given (the factory's default is the system
    // clock), or the system clock by name.
    const clock = props.get(CLOCK)
    expect<Array<string | undefined>>([undefined, SYSTEM_CLOCK]).toContain(clock)
    if (clock !== undefined) expect(importSource(SERVER_CODE, clock)).toBe('./persona-connections.ts')

    // The one persona notifier, the module-scope const the outage state and
    // the session manager's notices also go through; not a local of main().
    const notifier = constOf(NOTIFIER_FACTORY)
    expect(insideMain(onlyCallOf(NOTIFIER_FACTORY))).toBe(false)
    expect(indicesOf(new RegExp(`\\b(?:let|const|var|function)\\s+${notifier}\\b`, 'g'), SERVER_CODE)).toHaveLength(1)

    // `<notifier>.notify`, or `(key, text) => { void <notifier>.notify(key, text) }`
    // or the same call as an expression body; the parameters' names are free.
    const call = `(?:void )?${notifier}\\.${NOTIFY}\\(\\1, \\2\\)`
    expect(props.get(SINK)).toMatch(new RegExp(`^(?:${notifier}\\.${NOTIFY}|\\((\\w+), (\\w+)\\) => (?:\\{ ${call};? \\}|${call}))$`))
  })

  test('shutdown closes the episodes exactly once, through the handle, before it first yields, and nothing forgets them all', () => {
    const [start, end] = shutdownBody(SERVER_CODE)
    const handle = SERVER_CODE.match(new RegExp(HANDLE.source, 'm'))![1]!

    const closes = indicesOf(new RegExp(`\\b${handle}\\s*\\?\\.\\s*${CLOSE}\\s*\\(\\s*\\)`, 'g'), SERVER_CODE)
    expect(closes).toHaveLength(1)
    const at = closes[0]!
    expect(at > start && at < end).toBe(true)
    // No other close anywhere in server.ts, through the handle or the instance,
    // and no forget-all (which would leave a later begin open).
    const episodes = constOf(FACTORY)
    expect(indicesOf(new RegExp(`\\b(?:${handle}|${episodes})\\s*[?!]?\\.\\s*${CLOSE}\\s*\\(`, 'g'), SERVER_CODE)).toEqual([at])
    expect(indicesOf(new RegExp(`\\.\\s*${FORGET_ALL}\\s*\\(`, 'g'), SERVER_CODE)).toEqual([])

    // Before shutdown first yields, so a stalled await never keeps an episode open.
    const firstAwait = SERVER_CODE.slice(start, end).search(/\bawait\b/)
    expect(firstAwait).toBeGreaterThan(-1)
    expect(at).toBeLessThan(start + firstAwait)
  })
})

// ---------------------------------------------------------------------------
// Static audit: b.jg5 SRJ-307 / SRJ-310 / SRJ-306 — the tmux-unresponsive
// condition's production bindings
//
// Every hook that starts or ends the condition is optional with a no-op
// default (`OutageStateDeps.conditionSink`, `HealthCheckDeps.
// endTmuxUnresponsive`, `FullModeRetryDeps.endTmuxUnresponsive` and its two
// probes, `TmuxUnresponsiveConditionDeps.conditionEnded`), so a production
// wiring that dropped one, bound it to a no-op or a local shadow, built a
// second condition, or installed the sink after the start pass would
// type-check and pass every behaviour suite while a refusal started nothing,
// a healthy tick or retry ended nothing, or an end never reached the retry
// timer. What each hook does is tested in tests/tmux-unresponsive.test.ts,
// tests/outage-state.test.ts, tests/health-check.test.ts and
// tests/unavailable-retry.test.ts; pinned here: the bindings.
// ---------------------------------------------------------------------------

describe('main() builds the one tmux-unresponsive condition over the notice episodes, installs it as the condition sink before the start pass, and binds the tick\'s and the retry\'s ends to it and its end to the retry controller (b.jg5 SRJ-307, SRJ-310, SRJ-306)', () => {
  // Tied to src by type: renaming any of these fails the typecheck.
  const FACTORY: keyof typeof PersonaEpisodesModule = 'createTmuxUnresponsiveCondition'
  const EPISODES_FACTORY: keyof typeof PersonaEpisodesModule = 'createPersonaEpisodes'
  const EPISODES: keyof TmuxUnresponsiveConditionDeps = 'episodes'
  const CONDITION_ENDED: keyof TmuxUnresponsiveConditionDeps = 'conditionEnded'
  const END: keyof TmuxUnresponsiveCondition = 'end'
  const END_TICK: keyof typeof PersonaEpisodesModule = 'TMUX_UNRESPONSIVE_END_TICK'
  const END_RETRY: keyof typeof PersonaEpisodesModule = 'TMUX_UNRESPONSIVE_END_RETRY'
  const CONDITION_SINK: keyof OutageStateDeps = 'conditionSink'
  const TRIGGER_SINK: keyof OutageStateDeps = 'triggerSink'
  const TICK_HOOK: keyof HealthCheckDeps = 'endTmuxUnresponsive'
  const RETRY_HOOK: keyof FullModeRetryDeps = 'endTmuxUnresponsive'
  const RETRY_CONNECTED: keyof FullModeRetryDeps = 'isSessionConnected'
  const RETRY_STREAM: keyof FullModeRetryDeps = 'hasSessionStream'
  const TICK_STREAM: keyof HealthCheckDeps = 'hasSessionStream'
  const CONTROLLER_END: keyof UnavailableRetryController = 'conditionEnded'
  const RETRY_CONDITION: keyof typeof UnavailableRetryModule = 'UNAVAILABLE_RETRY_CONDITION_TMUX_UNRESPONSIVE'
  const LIVE: keyof typeof LivenessReadingModule = 'LIVENESS_LIVE'

  test('the condition is built exactly once, in main()\'s own statement list (not at module scope, behind no branch), over the one notice episodes instance, after the retry controller and before the start bring-up, initRestart and initHealthCheck', () => {
    const at = onlyCallOf(FACTORY)
    const condition = constOf(FACTORY)
    declaredOnce(condition)
    const decl = SERVER_CODE.search(new RegExp(`\\bconst\\s+${condition}\\s*=\\s*${FACTORY}\\s*\\(`))
    expect(decl).toBeGreaterThan(-1)
    expect(decl).toBeLessThan(at)
    expect(atMainTopLevel(SERVER_CODE, decl)).toBe(true)
    expect(importSource(SERVER_CODE, FACTORY)).toBe('./persona-episodes.ts')
    expect(indicesOf(new RegExp(`\\b(?:let|const|var|function)\\s+${FACTORY}\\b`, 'g'), SERVER_CODE)).toEqual([])

    // Over the one episodes instance (so the condition is that instance's
    // tmux-unresponsive episode, forgotten by a teardown and at shutdown).
    const episodes = constOf(EPISODES_FACTORY)
    declaredOnce(episodes)
    expect(onlyCallProps(FACTORY).get(EPISODES)).toBe(episodes)
    expect(at).toBeGreaterThan(onlyCallOf(EPISODES_FACTORY))

    // After the controller its end hook reports to; before every path that
    // can start or end it.
    expect(at).toBeGreaterThan(onlyCallOf('createUnavailableRetryController'))
    const { bringUpAt } = startResolution(SERVER_CODE)
    for (const later of [onlyCallOf('initRestart'), bringUpAt, onlyCallOf('initHealthCheck')]) {
      expect(at).toBeLessThan(later)
    }
  })

  test('it is the condition sink of the one initOutageState call, beside the retry controller\'s trigger sink, in main()\'s own statement list after it is built and before the start bring-up and initRestart', () => {
    const condition = constOf(FACTORY)
    const install = onlyCallOf('initOutageState')
    const props = onlyCallProps('initOutageState')
    expect(props.get(CONDITION_SINK)).toBe(condition)
    expect(props.get(TRIGGER_SINK)).toBe(constOf('createUnavailableRetryController'))
    expect(atMainTopLevel(SERVER_CODE, install)).toBe(true)
    expect(install).toBeGreaterThan(onlyCallOf(FACTORY))
    expect(install).toBeLessThan(startResolution(SERVER_CODE).bringUpAt)
    expect(install).toBeLessThan(onlyCallOf('initRestart'))
    // Nothing else names a condition sink in server.ts.
    expect(indicesOf(new RegExp(`\\b${CONDITION_SINK}\\b`, 'g'), SERVER_CODE)).toHaveLength(1)
  })

  test('the health check\'s end hook ends this condition for the persona it is given, with the tick reason and the live reading', () => {
    const condition = constOf(FACTORY)
    const hook = onlyCallProps('initHealthCheck').get(TICK_HOOK)
    expect(hook).toBeDefined()
    // `(key) => { <condition>.end(key, TMUX_UNRESPONSIVE_END_TICK, LIVENESS_LIVE) }`,
    // or the same call as an expression body; the parameter's name is free.
    const call = `${condition}\\.${END}\\(\\1, ${END_TICK}, ${LIVE}\\)`
    expect(hook).toMatch(new RegExp(`^\\(?(\\w+)\\)? => (?:\\{ ${call};? \\}|${call})$`))
    expect(importSource(SERVER_CODE, END_TICK)).toBe('./persona-episodes.ts')
    expect(importSource(SERVER_CODE, LIVE)).toBe('./liveness-reading.ts')
  })

  test('the full-mode retry action\'s end hook ends this condition for the persona it is given, with the retry reason and the retry\'s own reading, over the connectedness and stream probes the health check reads', () => {
    const condition = constOf(FACTORY)
    const props = onlyCallProps('createFullModeRetryAction')
    const hook = props.get(RETRY_HOOK)
    expect(hook).toBeDefined()
    // `(key, reading) => { <condition>.end(key, TMUX_UNRESPONSIVE_END_RETRY, reading) }`,
    // or the same call as an expression body; the parameters' names are free.
    const call = `${condition}\\.${END}\\(\\1, ${END_RETRY}, \\2\\)`
    expect(hook).toMatch(new RegExp(`^\\((\\w+), (\\w+)\\) => (?:\\{ ${call};? \\}|${call})$`))
    expect(importSource(SERVER_CODE, END_RETRY)).toBe('./persona-episodes.ts')

    // Absent, either probe answers "not connected" and a retry ends nothing:
    // the registry entry's connected flag, and the one stream probe the
    // health check also reads.
    expect(props.get(RETRY_CONNECTED)).toMatch(/^\(?(\w+)\)? => getSessionByPersona\(\1\)\?\.connected === true$/)
    expect(importSource(SERVER_CODE, 'getSessionByPersona')).toBe('./registry.ts')
    expect(props.get(RETRY_STREAM)).toBe('hasSessionStream')
    expect(onlyCallProps('initHealthCheck').get(TICK_STREAM)).toBe(props.get(RETRY_STREAM))
    expect(importSource(SERVER_CODE, 'hasSessionStream')).toBe('./persona-routing.ts')
  })

  test('the tick\'s and the retry\'s hooks are the only ends server.ts calls on the condition', () => {
    const condition = constOf(FACTORY)
    const ends = indicesOf(new RegExp(`\\b${condition}\\s*[?!]?\\.\\s*${END}\\s*\\(`, 'g'), SERVER_CODE)
    expect(ends).toHaveLength(2)
    const tickHook = onlyCallProps('initHealthCheck').get(TICK_HOOK)!
    const retryHook = onlyCallProps('createFullModeRetryAction').get(RETRY_HOOK)!
    const endCall = new RegExp(`\\b${condition}\\.${END}\\(`, 'g')
    expect((tickHook.match(endCall) ?? []).length + (retryHook.match(endCall) ?? []).length).toBe(2)
  })

  test('the condition\'s end hook is the retry controller\'s condition-end entry, for the persona it is given, the tmux-unresponsive condition and the end\'s reading', () => {
    const controller = constOf('createUnavailableRetryController')
    declaredOnce(controller)
    const hook = onlyCallProps(FACTORY).get(CONDITION_ENDED)
    expect(hook).toBeDefined()
    // `(key, reading) => <controller>.conditionEnded(key, UNAVAILABLE_RETRY_CONDITION_TMUX_UNRESPONSIVE, reading)`,
    // or the same call in a block body; the parameters' names are free.
    const call = `${controller}\\.${CONTROLLER_END}\\(\\1, ${RETRY_CONDITION}, \\2\\)`
    expect(hook).toMatch(new RegExp(`^\\((\\w+), (\\w+)\\) => (?:\\{ (?:return )?${call};? \\}|${call})$`))
    expect(importSource(SERVER_CODE, RETRY_CONDITION)).toBe('./unavailable-retry.ts')
    // No other report of a condition's end anywhere in server.ts.
    expect(indicesOf(new RegExp(`\\.\\s*${CONTROLLER_END}\\s*\\(`, 'g'), SERVER_CODE)).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// Static audit: b.jg5 SRJ-308 / SRJ-309 / SRJ-210 — the tmux-unresponsive
// condition's onset hooks, mode, alert threshold and alert stops
//
// The health check's tick-end hook and clock (`HealthCheckDeps.onTickEnd`,
// `now`), the retry controller's per-fire observer (`UnavailableRetryDeps.
// onRetryFire`) and the condition's mode and threshold accessors
// (`TmuxUnresponsiveConditionDeps.healthCheckOn`, `alertThresholdMs`) are all
// optional: absent, no onset is ever posted, the mode is "on" and no alert
// check is armed. So a production wiring that dropped one, bound it to a
// no-op, a local shadow or another instance, read the tick's start on a clock
// other than the one the first refusal is read on, or copied the mode or the
// threshold once would type-check and pass every behaviour suite. What each
// entry does is tested in tests/tmux-unresponsive.test.ts,
// tests/health-check.test.ts and tests/unavailable-retry.test.ts; the
// teardown's alert cancel in tests/reload-wiring.test.ts; shutdown's close in
// the SRJ-1016 describe above. Pinned here: the bindings.
// ---------------------------------------------------------------------------

describe('main() binds the tmux-unresponsive condition\'s onset to the tick\'s end and to each retry fire, reads its mode and alert threshold at each check, and cancels its alert only at a teardown\'s timer stop and at shutdown (b.jg5 SRJ-308, SRJ-309, SRJ-210)', () => {
  // Tied to src by type: renaming any of these fails the typecheck.
  const FACTORY: keyof typeof PersonaEpisodesModule = 'createTmuxUnresponsiveCondition'
  const EPISODES_FACTORY: keyof typeof PersonaEpisodesModule = 'createPersonaEpisodes'
  const EPISODES_CLOCK: keyof PersonaEpisodes = 'clock'
  const ONSET_AT_TICK: keyof TmuxUnresponsiveCondition = 'onsetAtTick'
  const ONSET_AT_RETRY: keyof TmuxUnresponsiveCondition = 'onsetAtRetry'
  const CANCEL_ALERT: keyof TmuxUnresponsiveCondition = 'cancelAlert'
  const MODE: keyof TmuxUnresponsiveConditionDeps = 'healthCheckOn'
  const THRESHOLD: keyof TmuxUnresponsiveConditionDeps = 'alertThresholdMs'
  const TICK_END: keyof HealthCheckDeps = 'onTickEnd'
  const TICK_NOW: keyof HealthCheckDeps = 'now'
  const RETRY_FIRE: keyof UnavailableRetryDeps = 'onRetryFire'
  const THRESHOLD_IN_EFFECT: keyof typeof AdSettingsModule = 'adAlertThresholdMsInEffect'
  const INTERVAL: keyof PersonaConfig = 'health_check_interval'

  test('the health check\'s tick-end hook is the condition\'s tick onset entry, given the tick\'s start, and the tick reads its start on the notice episodes\' own clock', () => {
    const condition = constOf(FACTORY)
    declaredOnce(condition)
    const props = onlyCallProps('initHealthCheck')

    // `(t) => <condition>.onsetAtTick(t)` (block or expression body), or the
    // entry itself; the parameter's name is free.
    const call = `${condition}\\.${ONSET_AT_TICK}\\(\\1\\)`
    expect(props.get(TICK_END)).toMatch(
      new RegExp(`^(?:${condition}\\.${ONSET_AT_TICK}|\\(?(\\w+)\\)? => (?:\\{ ${call};? \\}|${call}))$`),
    )

    // The clock the condition reads its first refusal on (the episodes'),
    // read at each tick: not the system clock by another name, not a value.
    const episodes = constOf(EPISODES_FACTORY)
    declaredOnce(episodes)
    expect(props.get(TICK_NOW)).toMatch(new RegExp(`^\\(\\) => ${episodes}\\.${EPISODES_CLOCK}\\.now\\(\\)$`))
  })

  test('the retry controller\'s per-fire observer is the condition\'s retry onset entry, given the persona and the fire time', () => {
    const condition = constOf(FACTORY)
    declaredOnce(condition)
    const hook = onlyCallProps('createUnavailableRetryController').get(RETRY_FIRE)
    expect(hook).toBeDefined()
    // `(key, firedAt) => <condition>.onsetAtRetry(key, firedAt)` (block or
    // expression body); the parameters' names are free. Only a wrapper: the
    // condition is declared after the controller is built.
    const call = `${condition}\\.${ONSET_AT_RETRY}\\(\\1, \\2\\)`
    expect(hook).toMatch(new RegExp(`^\\((\\w+), (\\w+)\\) => (?:\\{ ${call};? \\}|${call})$`))
  })

  test('the two onset entries are called only from those two bindings', () => {
    const condition = constOf(FACTORY)
    for (const [entry, binding] of [
      [ONSET_AT_TICK, onlyCallProps('initHealthCheck').get(TICK_END)!],
      [ONSET_AT_RETRY, onlyCallProps('createUnavailableRetryController').get(RETRY_FIRE)!],
    ]) {
      expect([entry, indicesOf(new RegExp(`\\.\\s*${entry}\\b`, 'g'), SERVER_CODE).length]).toEqual([entry, 1])
      expect(binding).toContain(`${condition}.${entry}`)
    }
  })

  test('the mode is read at each check from the applied config holder\'s health_check_interval (the field startHealthCheck starts the tick with), with the start-time config as the fallback', () => {
    const mode = onlyCallProps(FACTORY).get(MODE)
    expect(mode).toBeDefined()
    // `() => (<holder> ?? <start-time>).health_check_interval !== 0`: read
    // at call time, never a value or a copy of the holder taken once.
    const loaded = loadedConfigName(SERVER_CODE)
    const m = mode!.match(new RegExp(`^\\(\\) => \\(${loaded} \\?\\? (\\w+)\\)\\.${INTERVAL} !== 0$`))
    expect(m).not.toBeNull()
    // The fallback is the start-time applied config the bring-up launch and
    // the restart delay read (pinned in the bring-up describe above).
    const launch = onlyCallProps('createPersonaBringUpController').get('launch')!
    expect(launch.match(/\?\? (\w+), false\)$/)![1]).toBe(m![1])
    expect(m![1]).not.toBe(loaded)
    // The same field the tick is started with.
    expect(onlyCallArgs('startHealthCheck')).toEqual([`${loaded}.${INTERVAL}`])
  })

  test('the alert threshold is E6\'s accessor of the threshold in effect itself, imported from ad-settings, never called (a value taken once) or shadowed in server.ts', () => {
    expect(onlyCallProps(FACTORY).get(THRESHOLD)).toBe(THRESHOLD_IN_EFFECT)
    expect(importSource(SERVER_CODE, THRESHOLD_IN_EFFECT)).toBe('./ad-settings.ts')
    expect(indicesOf(new RegExp(`\\b(?:let|const|var|function)\\s+${THRESHOLD_IN_EFFECT}\\b`, 'g'), SERVER_CODE)).toEqual([])
    expect(indicesOf(new RegExp(`\\b${THRESHOLD_IN_EFFECT}\\s*\\(`, 'g'), SERVER_CODE)).toEqual([])
  })

  test('the alert is cancelled only by the teardown\'s retry-timer stop (server.ts\'s one cancelAlert call, inside createPersonaLifecycle\'s stopRetryTimer) and by shutdown\'s close of the episodes', () => {
    const condition = constOf(FACTORY)
    const cancels = indicesOf(new RegExp(`\\.\\s*${CANCEL_ALERT}\\s*\\(`, 'g'), SERVER_CODE)
    expect(cancels).toHaveLength(1)
    const stopRetryTimer = onlyCallProps('createPersonaLifecycle').get('stopRetryTimer')!
    expect(stopRetryTimer).toMatch(new RegExp(`\\b${condition}\\.${CANCEL_ALERT}\\(`))
    // That one call lies inside createPersonaLifecycle's argument.
    const lifecycleAt = onlyCallOf('createPersonaLifecycle')
    const [argsStart, argsEnd] = balancedAfter(SERVER_CODE, lifecycleAt, '(', ')')
    expect(cancels[0]! > argsStart && cancels[0]! < argsEnd).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Static audit: b.f2b — a stale `working` row must not strand a persona
//
// The health check's b.f2b dependencies are optional (a test deps object
// without them keeps the old behaviour), and so is nothing else that ends a
// not-connected episode, so only these audits make sure production binds
// them: the launch-in-flight skip, the delay-0 not-connected notice read from
// the same restart delay the restart module uses, the pending working-row
// evidence, the end of the episode on a healthy tick and when the persona's
// MCP session registers, and the reconnect adapter's persona lookup (without
// it a fresh session's transcript is never found). What each does is tested in tests/health-check.test.ts and
// tests/session-manager.test.ts.
// ---------------------------------------------------------------------------

describe('server.ts wires the b.f2b stale-working-row recovery', () => {
  test('the health check gets the session manager\'s isLaunchInFlight, hasPendingWorkingRowEvidence, notifyDisconnectedWithAutoRestartDisabled and forgetNotConnectedEpisode, and reads session_restart_delay 0 from the config the restart module reads', () => {
    const props = onlyCallProps('initHealthCheck')
    for (const [dep, value] of [
      ['isLaunchInFlight', 'isLaunchInFlight'],
      ['hasPendingWorkingRowEvidence', 'hasPendingWorkingRowEvidence'],
      ['notifyNotConnected', 'notifyDisconnectedWithAutoRestartDisabled'],
      // A healthy tick ends the persona's not-connected episode.
      ['endNotConnectedEpisode', 'forgetNotConnectedEpisode'],
    ] as const) {
      expect([dep, props.get(dep)]).toEqual([dep, value])
      expect([value, importSource(SERVER_CODE, value)]).toEqual([value, './session-manager.ts'])
    }
    const delay = onlyCallProps('initRestart').get('getRestartDelay')?.match(/^\(\) => (\w+)\.session_restart_delay$/)
    expect(delay).not.toBeNull()
    expect(props.get('isAutoRestartDisabled')).toBe(`() => ${delay![1]}.session_restart_delay === 0`)
  })

  test('the restart module\'s reconnect is the reconnect adapter over the live applied persona lookup, getAppliedPersona, which locates a working row\'s transcript under the persona\'s claude_config_dir', () => {
    expect(onlyCallProps('initRestart').get('reconnectSession')).toBe('_buildReconnectSessionAdapter(getAppliedPersona)')
    // The only adapter built (its declaration aside): no reconnect path without the lookup.
    expect(indicesOf(/(?<![\w.$]|function\s+)_buildReconnectSessionAdapter\s*\(/g, SERVER_CODE)).toHaveLength(1)
  })

  test('handleInitialized ends the persona\'s not-connected episode once its session is registered: forgetNotConnectedEpisode(persona.key), the session manager\'s, right after registerSession', () => {
    const decl = SERVER_CODE.search(/\basync\s+function\s+handleInitialized\s*\(/)
    expect(decl).toBeGreaterThan(-1)
    const [, paramsEnd] = balancedAfter(SERVER_CODE, decl, '(', ')')
    const [start, end] = balancedAfter(SERVER_CODE, paramsEnd + 1, '{', '}')
    const forget = onlyCallOf('forgetNotConnectedEpisode')
    expect(forget > start && forget < end).toBe(true)
    expect(onlyCallArgs('forgetNotConnectedEpisode')).toEqual(['persona.key'])
    const register = onlyCallOf('registerSession')
    expect(register > start && register < forget).toBe(true)
    expect(importSource(SERVER_CODE, 'forgetNotConnectedEpisode')).toBe('./session-manager.ts')
  })
})

// ---------------------------------------------------------------------------
// Static audit: a persona that is not up is refused service (SR-6.3, SR-6.4)
//
// The admission decision, the drop and the up predicate are driven through
// their real imports in tests/registry.test.ts; what only server.ts holds is
// which call gets the predicate, the drop listener, and what handleInitialized
// does with a refused session.
// ---------------------------------------------------------------------------

describe('server.ts refuses service to a persona that is not up (b.av2 SR-6.3, SR-6.4)', () => {
  /** [start, end) of the body of `async function <name>(…)`. */
  function asyncFunctionBody(name: string): [number, number] {
    const decl = SERVER_CODE.search(new RegExp(`\\basync\\s+function\\s+${name}\\s*\\(`))
    expect(decl).toBeGreaterThan(-1)
    const [, paramsEnd] = balancedAfter(SERVER_CODE, decl, '(', ')')
    return balancedAfter(SERVER_CODE, paramsEnd + 1, '{', '}')
  }

  // b.av2 SR-8.6: `isApplied` is optional in PersonaUpQuery (a query without it
  // counts every key as applied), so this audit is what makes sure production
  // binds it: a removed persona must stop being up for MCP admission, the
  // permission poller and /interject from a confirmed apply's step 1 on.
  test('isPersonaUp is built once, at module scope, from createPersonaUpPredicate over the connection view and the controller\'s isUp and isApplied (both false before main() builds it); server.ts has no up check of its own', () => {
    expect(constOf('createPersonaUpPredicate')).toBe('isPersonaUp')
    expect(insideMain(onlyCallOf('createPersonaUpPredicate'))).toBe(false)
    const args = onlyCallArgs('createPersonaUpPredicate')
    expect(args).toHaveLength(2)
    expect(args[0]).toBe('connectionView')
    const outcomes = objectProperties(args[1]!)
    expect([...outcomes.keys()]).toEqual(['isUp', 'isApplied'])
    expect(outcomes.get('isUp')).toMatch(/^\((\w+)\) => bringUps\?\.isUp\(\1\) \?\? false$/)
    expect(outcomes.get('isApplied')).toMatch(/^\((\w+)\) => bringUps\?\.isApplied\(\1\) \?\? false$/)
    // Never called directly, and no serving check copied in.
    expect(callsOf('isPersonaUp')).toEqual([])
    expect(indicesOf(/\bisPersonaClientServing\b/g, SERVER_CODE)).toEqual([])
  })

  test('the permission poller, /interject and the MCP admission decision each get isPersonaUp', () => {
    expect(onlyCallProps('startPermissionPoller').get('isPersonaUp')).toBe('isPersonaUp')
    const interject = onlyCallArgs('handleInterject')
    expect(interject).toHaveLength(3)
    expect(objectProperties(interject[2]!).get('isPersonaUp')).toBe('isPersonaUp')
    expect(onlyCallProps('decideSessionAdmission').get('isPersonaUp')).toBe('isPersonaUp')
  })

  // `isPersonaUp` is optional in PersonaRoutingDeps (without it every
  // persona counts as up), so only this audit makes sure production binds it:
  // a message that reaches a persona which is no longer up (it stopped being
  // up mid-dispatch, or the old half of a destructive modify) must get the
  // not-up notice and no restart.
  test('the persona routing gets the one isPersonaUp predicate, built before it, so a lost message for a persona that is not up restarts nothing', () => {
    expect(onlyCallProps('createPersonaRouting').get('isPersonaUp')).toBe('isPersonaUp')
    // Read when the routing is built: the predicate must already exist.
    expect(onlyCallOf('createPersonaRouting')).toBeGreaterThan(onlyCallOf('createPersonaUpPredicate'))
  })

  test('handleInitialized decides admission over the roots path and the loaded personas, with the controller\'s not-up description, and no longer matches personas itself', () => {
    const [start, end] = asyncFunctionBody('handleInitialized')
    const at = onlyCallOf('decideSessionAdmission')
    expect(at > start && at < end).toBe(true)
    expect(callsOf('matchPersonaByRootsPath')).toEqual([])

    const args = onlyCallArgs('decideSessionAdmission')
    expect(args).toHaveLength(3)
    expect(args[0]).toBe('rootsPath')
    expect(args[1]).toBe(`${loadedConfigName(SERVER_CODE)}?.personas ?? []`)
    const props = objectProperties(args[2]!)
    expect(props.get('describeNotUp')).toBe('describePersonaNotUpByKey')
    expect(props.get('log')).toMatch(/^\((\w+)\) => console\.error\(\1\)$/)
    const describe = SERVER_CODE.search(/\bfunction\s+describePersonaNotUpByKey\s*\(/)
    expect(describe).toBeGreaterThan(-1)
    const [, paramsEnd] = balancedAfter(SERVER_CODE, describe, '(', ')')
    const body = SERVER_CODE.slice(...balancedAfter(SERVER_CODE, paramsEnd + 1, '{', '}')).trim()
    expect(body).toMatch(/^return describePersonaNotUp\(bringUps\?\.state\((\w+)\)\)$/)
  })

  /** The top-level arguments of every `closePendingSession(…)` call in `code`, in order. */
  function closeCallsIn(code: string): string[][] {
    return indicesOf(/(?<![\w.$])closePendingSession\s*\(/g, code).map((at) => splitTopLevel(callArguments(code, at)))
  }

  /** A hand-rolled pending close: the pieces `closePendingSession` does, called directly. */
  const HAND_ROLLED_CLOSE = /\bremovePendingSession\s*\(|\bstopSseKeepAlive\s*\(|\.close\s*\(/

  test('pendingSessionCloseDeps is one module-scope object wiring exactly removePending: removePendingSession and stopKeepAlive: stopSseKeepAlive, and closePendingSession is the registry\'s', () => {
    expect(SERVER_CODE).toMatch(/import\s*\{[^}]*\bclosePendingSession\b[^}]*\}\s*from\s*['"]\.\/registry\.ts['"]/)
    expect(SERVER_CODE).not.toMatch(/\bfunction\s+closePendingSession\b|\b(?:const|let|var)\s+closePendingSession\b/)

    const decls = indicesOf(/^const\s+pendingSessionCloseDeps\b[^=]*=\s*\{/gm, SERVER_CODE)
    expect(decls).toHaveLength(1)
    expect(indicesOf(/\b(?:const|let|var)\s+pendingSessionCloseDeps\b/g, SERVER_CODE)).toEqual(decls)
    const props = objectProperties(SERVER_CODE.slice(SERVER_CODE.indexOf('=', decls[0]!)))
    expect([...props.entries()]).toEqual([
      ['removePending', 'removePendingSession'],
      ['stopKeepAlive', 'stopSseKeepAlive'],
    ])
    expect(assignmentsTo('pendingSessionCloseDeps')).toEqual([])
  })

  test('a refused or unmatched session is closed through closePendingSession(pendingId, <pending>.transport, pendingSessionCloseDeps), awaited, and handleInitialized returns before it could be promoted or mapped', () => {
    const [start, end] = asyncFunctionBody('handleInitialized')
    const code = SERVER_CODE.slice(start, end)
    const decl = code.match(/\bconst\s+(\w+)\s*=\s*decideSessionAdmission\s*\(/)
    expect(decl).not.toBeNull()
    const admission = decl![1]!
    const guards = indicesOf(new RegExp(`\\bif\\s*\\(\\s*${admission}\\.kind\\s*!==\\s*'admitted'\\s*\\)\\s*\\{`, 'g'), code)
    expect(guards).toHaveLength(1)
    const [blockStart, blockEnd] = balancedAfter(code, guards[0]!, '{', '}')
    const block = code.slice(blockStart, blockEnd)

    const pending = block.match(/\bconst\s+(\w+)\s*=\s*getPendingSession\s*\(\s*pendingId\s*\)/)
    expect(pending).not.toBeNull()
    const p = pending![1]!
    expect(block).toMatch(new RegExp(`\\bif\\s*\\(\\s*${p}\\s*\\)\\s*await\\s+closePendingSession\\s*\\(`))
    expect(closeCallsIn(block)).toEqual([['pendingId', `${p}.transport`, 'pendingSessionCloseDeps']])
    expect(block).not.toMatch(HAND_ROLLED_CLOSE)
    expect(block.trim()).toMatch(/\breturn\s*;?$/)
    // Nothing in the refusal registers the session.
    expect(block).not.toMatch(/\bregisterSession\s*\(|\bregisterMcpSessionId\s*\(/)
    // Only after the guard is the session promoted and mapped (the admitted persona).
    for (const call of ['registerSession', 'registerMcpSessionId']) {
      const at = indicesOf(new RegExp(`\\b${call}\\s*\\(`, 'g'), code)
      expect(at).toHaveLength(1)
      expect(at[0]!).toBeGreaterThan(blockEnd)
    }
    expect(code.slice(blockEnd)).toMatch(new RegExp(`\\bconst\\s*\\{\\s*persona\\s*\\}\\s*=\\s*${admission}\\b`))
  })

  /**
   * The body of each of handleInitialized's other close branches, and the
   * pending entry whose transport it must close.
   */
  const OTHER_CLOSE_BRANCHES: Array<[string, (code: string) => { block: string; entry: string }]> = [
    [
      'the SSE stream never opened',
      (code) => {
        const wait = code.match(/\bconst\s+(\w+)\s*=\s*await\s+waitForSseStream\s*\(\s*(\w+)\.transport\s*\)/)
        expect(wait).not.toBeNull()
        const guard = code.search(new RegExp(`\\bif\\s*\\(\\s*!\\s*${wait![1]}\\s*\\)\\s*\\{`))
        expect(guard).toBeGreaterThan(-1)
        return { block: code.slice(...balancedAfter(code, guard, '{', '}')), entry: wait![2]! }
      },
    ],
    [
      'roots/list failed',
      (code) => {
        const list = code.search(/\.listRoots\s*\(/)
        expect(list).toBeGreaterThan(-1)
        const tryAt = indicesOf(/\btry\s*\{/g, code).filter((at) => at < list).pop()!
        const [, tryEnd] = balancedAfter(code, tryAt, '{', '}')
        expect(list).toBeLessThan(tryEnd)
        const rest = code.slice(tryEnd + 1)
        expect(rest).toMatch(/^\s*catch\s*\([^)]*\)\s*\{/)
        return pendingBranch(rest.slice(...balancedAfter(rest, rest.indexOf(')'), '{', '}')))
      },
    ],
    [
      'the client reported no roots',
      (code) => {
        const guard = code.search(/\bif\s*\(\s*!\s*\w+\.length\s*\)\s*\{/)
        expect(guard).toBeGreaterThan(-1)
        return pendingBranch(code.slice(...balancedAfter(code, guard, '{', '}')))
      },
    ],
  ]

  /** A branch that re-reads the pending entry (`const <p> = getPendingSession(pendingId)`) and closes it only when present. */
  function pendingBranch(block: string): { block: string; entry: string } {
    const pending = block.match(/\bconst\s+(\w+)\s*=\s*getPendingSession\s*\(\s*pendingId\s*\)/)
    expect(pending).not.toBeNull()
    expect(block).toMatch(new RegExp(`\\bif\\s*\\(\\s*${pending![1]}\\s*\\)\\s*await\\s+closePendingSession\\s*\\(`))
    return { block, entry: pending![1]! }
  }

  test.each(OTHER_CLOSE_BRANCHES)('when %s, handleInitialized closes the pending session through closePendingSession with pendingSessionCloseDeps, awaited, and returns', (_label, branchOf) => {
    const [start, end] = asyncFunctionBody('handleInitialized')
    const { block, entry } = branchOf(SERVER_CODE.slice(start, end))
    expect(closeCallsIn(block)).toEqual([['pendingId', `${entry}.transport`, 'pendingSessionCloseDeps']])
    expect(block).toMatch(/\bawait\s+closePendingSession\s*\(/)
    expect(block).not.toMatch(HAND_ROLLED_CLOSE)
    expect(block.trim()).toMatch(/\breturn\s*;?$/)
  })

  test('handleInitialized has no other close path: exactly the four closePendingSession calls, and no direct pending remove, keep-alive stop or transport close', () => {
    const [start, end] = asyncFunctionBody('handleInitialized')
    const code = SERVER_CODE.slice(start, end)
    const calls = closeCallsIn(code)
    expect(calls).toHaveLength(OTHER_CLOSE_BRANCHES.length + 1)
    for (const args of calls) {
      expect(args).toHaveLength(3)
      expect(args[0]).toBe('pendingId')
      expect(args[2]).toBe('pendingSessionCloseDeps')
    }
    expect(code).not.toMatch(HAND_ROLLED_CLOSE)
  })

  test('the bring-up controller\'s onLeftUp drops the persona\'s MCP session through createNotUpSessionDropper over dropPersonaSessionAndKeepAlive, which stops the keep-alive and then calls dropPersonaSession', () => {
    expect(onlyCallProps('createPersonaBringUpController').get('onLeftUp')).toStartWith('createNotUpSessionDropper(')
    const dropper = onlyCallProps('createNotUpSessionDropper')
    expect([...dropper.keys()].sort()).toEqual(['drop', 'log'])
    expect(dropper.get('drop')).toBe('dropPersonaSessionAndKeepAlive')
    expect(dropper.get('log')).toMatch(/^\((\w+)\) => console\.error\(\1\)$/)

    const [start, end] = asyncFunctionBody('dropPersonaSessionAndKeepAlive')
    const body = SERVER_CODE.slice(start, end)
    const session = body.match(/\bconst\s+(\w+)\s*=\s*getSessionByPersona\s*\(\s*(\w+)\s*\)/)
    expect(session).not.toBeNull()
    const [, s, key] = session!
    const stop = body.search(new RegExp(`\\bstopSseKeepAlive\\s*\\(\\s*${s}\\.transport\\s*\\)`))
    const drop = body.search(new RegExp(`\\breturn\\s+dropPersonaSession\\s*\\(\\s*${key}\\s*\\)`))
    expect(stop).toBeGreaterThan(-1)
    expect(drop).toBeGreaterThan(stop)
    // The one drop call in server.ts.
    const drops = callsOf('dropPersonaSession')
    expect(drops).toHaveLength(1)
    expect(drops[0]! > start && drops[0]! < end).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Static audit: start-up side effects (SR-13.2) and dry run (SR-3.4)
// ---------------------------------------------------------------------------

describe('main() owns the start-up side effects', () => {
  test('creates the state and inbox directories inside main(), before the PID check and the PID file', () => {
    const calls = callsOf('mkdirSync')
    expect(calls.map((at) => splitTopLevel(callArguments(SERVER_CODE, at))[0]).sort()).toEqual(['INBOX_DIR', 'STATE_DIR'])
    for (const at of calls) {
      expect(insideMain(at)).toBe(true)
      expect(at).toBeLessThan(onlyCallOf('checkPidConflict'))
      expect(at).toBeLessThan(onlyCallOf('writePidFile'))
    }
  })

  test('starts the permission poller only outside dry run (the else branch of `if (isDryRun())`)', () => {
    const poller = onlyCallOf('startPermissionPoller')
    const inElse = indicesOf(/\bif\s*\(\s*isDryRun\s*\(\s*\)\s*\)\s*\{/g, SERVER_CODE).some((at) => {
      const [, thenEnd] = balancedAfter(SERVER_CODE, at, '{', '}')
      if (!/^\s*else\s*\{/.test(SERVER_CODE.slice(thenEnd + 1))) return false
      const [elseStart, elseEnd] = balancedAfter(SERVER_CODE, thenEnd + 1, '{', '}')
      return poller > elseStart && poller < elseEnd
    })
    expect(inElse).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Static audit: the file guard refuses every persona credentials file (SR-5.2)
// ---------------------------------------------------------------------------

describe('server.ts\'s file guard refuses every persona credentials file (b.av2 SR-5.2; E3 Task 5 carry)', () => {
  test('assertSendable builds its protected list per call from the reload controller (the applied personas and the config file), with the config file\'s paths before main() builds it, and the session tools get it with clientFor', () => {
    expect(SERVER_CODE).toMatch(/import\s*\{[^}]*\bassertSendable\s+as\s+libAssertSendable\b[^}]*\}\s*from\s*['"]\.\/lib\.ts['"]/)
    const fn = SERVER_CODE.search(/\bfunction\s+assertSendable\s*\(/)
    expect(fn).toBeGreaterThan(-1)
    const body = SERVER_CODE.slice(...balancedAfter(SERVER_CODE, fn, '{', '}'))
    const list = body.match(
      /\bconst\s+(\w+)\s*=\s*reloadController\s*\?\.\s*protectedCredentialsFiles\s*\(\s*\)\s*\?\?\s*credentialsFilesToProtect\s*\(/,
    )
    expect(list).not.toBeNull()
    const fallback = list!.index! + list![0].lastIndexOf('credentialsFilesToProtect')
    expect(splitTopLevel(callArguments(body, fallback))).toEqual(['[]', 'CONFIG_PATH'])
    // The holder is the module-scope controller main() builds, set once, inside
    // main(), before the MCP server (and so any session tool) can run.
    expect(SERVER_CODE).toMatch(/^let\s+reloadController\s*:\s*ReloadController\s*\|\s*undefined\s*$/m)
    const { controller } = startResolution(SERVER_CODE)
    const holder = assignmentsTo('reloadController')
    expect(holder.map((a) => a.value)).toEqual([controller])
    expect(insideMain(holder[0]!.at)).toBe(true)
    expect(holder[0]!.at).toBeLessThan(onlyCallOf('Bun\\.serve'))
    const guard = body.search(/\blibAssertSendable\s*\(/)
    expect(guard).toBeGreaterThan(-1)
    expect(splitTopLevel(callArguments(body, guard))).toEqual(['filePath', 'resolve(STATE_DIR)', 'resolve(INBOX_DIR)', list![1]])

    const deps = SERVER_CODE.search(/\bconst\s+sessionToolDeps\s*:\s*SessionToolDeps\s*=\s*\{/)
    expect(deps).toBeGreaterThan(-1)
    const props = objectProperties(SERVER_CODE.slice(SERVER_CODE.indexOf('=', deps)))
    expect(props.get('assertSendable')).toBe('assertSendable')
    expect(props.get('clientFor')).toBe('clientFor')
  })

  // The 64 KiB cap exempts one read: the file guard's read of the config file,
  // so an oversized config still protects the credentials files it names
  // (behaviour in tests/config.test.ts). Every other reader (the start, the
  // record, the pending and apply files, the reload tick) must stay capped;
  // this audit fails if any other call site passes the option.
  test('readPersonaConfigBytes is called uncapped only by credentialsFilesToProtect, and nothing outside config.ts names the option', () => {
    const files = srcFiles().map(([path, source]) => [path, stripComments(source)] as const)
    expect(files.filter(([path, code]) => path !== 'src/config.ts' && /\buncapped\b/.test(code)).map(([path]) => path)).toEqual([])

    const withOptions = files.flatMap(([path, code]) =>
      indicesOf(/(?<![\w.$]|function\s+)readPersonaConfigBytes\s*\(/g, code)
        .map((at) => ({ path, code, at, args: splitTopLevel(callArguments(code, at)) }))
        .filter((call) => call.args.length > 2),
    )
    expect(withOptions.map((c) => [c.path, c.args[2]])).toEqual([['src/config.ts', '{ uncapped: true }']])
    const { code, at } = withOptions[0]!
    const guard = code.search(/\bexport\s+function\s+credentialsFilesToProtect\s*\(/)
    expect(guard).toBeGreaterThan(-1)
    const [bodyStart, bodyEnd] = balancedAfter(code, balancedAfter(code, guard, '(', ')')[1], '{', '}')
    expect(at).toBeGreaterThan(bodyStart)
    expect(at).toBeLessThan(bodyEnd)
  })
})

// ---------------------------------------------------------------------------
// Import-time behaviour, in a child process with a temp HOME (SR-13.2)
// ---------------------------------------------------------------------------

/**
 * Every path created under `home`, relative to it, except Bun's own
 * transpiler cache (`.bun/install/cache`), which the child runtime writes for
 * any module it loads under a fresh HOME, whatever the module does.
 */
function createdUnder(home: string, dir = home): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    const rel = relative(home, full)
    const bunCache = ['.bun', join('.bun', 'install'), join('.bun', 'install', 'cache')]
    if (rel.startsWith(join('.bun', 'install', 'cache') + '/')) continue
    if (!bunCache.includes(rel)) out.push(rel)
    if (statSync(full).isDirectory()) out.push(...createdUnder(home, full))
  }
  return out
}

describe('importing src/server.ts has no side effect (SR-3.1, SR-10.2, SR-13.2)', () => {
  let home: string | undefined

  afterEach(() => {
    if (home) rmSync(home, { recursive: true, force: true })
    home = undefined
  })

  test(
    'with a temp HOME and no token variables, the import completes, exits 0, installs no rejection handler, prints no token error and creates nothing under HOME',
    () => {
      home = mkdtempSync(join(tmpdir(), 'cscb-server-import-'))
      const stateDir = join(home, 'state')
      // The child's env comes from hostSafeChildEnv: only HOME, PATH,
      // TMUX_TMPDIR, SLACK_STATE_DIR and FAKE_HOME_INPUT_JSON (no token,
      // CSCB_*, CLAUDE_* or AGENT_DIRECTOR_* variable). It imports server.ts
      // from an eval script, so server.ts is never the entry point.
      const res = runInFakeHome({
        modulePath: SERVER_PATH,
        call: `process.stdout.write('IMPORTED::' + typeof mod.main + ' LISTENERS::' + process.listenerCount('unhandledRejection') + '\\n')`,
        input: null,
        home,
        stateDir,
        timeoutMs: 60_000,
      })

      expect(res.observedHomedir).toBe(home)
      // The import finished (no exit on the way) and installed no rejection handler.
      expect(res.stdout).toContain('IMPORTED::function LISTENERS::0')
      expect(res.status).toBe(0)
      expect(`${res.stdout}\n${res.stderr}`).not.toMatch(/SLACK_(?:BOT|APP)_TOKEN/)
      expect(existsSync(stateDir)).toBe(false)
      expect(createdUnder(home)).toEqual([])
    },
    90_000,
  )
})
