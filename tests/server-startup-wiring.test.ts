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
 * - The one destination resolver (SR-7.1): built at module scope and shared
 *   by the persona notifier and the permission poller.
 * - The bring-up controller (SR-6.1, SR-6.4): the start's bring-up, told
 *   every connection status, stored for shutdown and cancelled there before
 *   the connections stop; the health check started only after the start
 *   bring-up returns. Its launch and its live applied set (`appliedPersonas`)
 *   read the applied config at call time (SR-8.6).
 * - The relaunch gate (SR-6.1, SR-6.4): built over the manager and the
 *   bring-up controller and passed to the restart module (`canRestart`), the
 *   restart launch and the health-check work list; the restart delay read
 *   from the applied config; the permission poller not started in dry run.
 * - Not-up personas (SR-6.3, SR-6.4, SR-8.6): the one `isPersonaUp`
 *   predicate (the controller's `isUp` and `isApplied`) handed
 *   to the permission poller, `/interject` and the MCP admission decision;
 *   a refused session disconnected and never registered; the controller's
 *   `onLeftUp` dropping the persona's registered session.
 * - SR-5.2: the file guard handed to the session tools protects every persona
 *   credentials file, as the reload controller lists them.
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
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  balancedAfter,
  callArguments,
  indicesOf,
  insideMain as insideMainOf,
  loadedConfigName,
  objectProperties,
  onlyCallArguments,
  shutdownBody,
  splitTopLevel,
  startResolution,
  stripComments,
} from './test-helpers/source-audit.ts'
import { runInFakeHome } from './test-helpers/fake-home-subprocess.ts'

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
    // holder is set before any status can fire.
    expect(indicesOf(/\.\s*bringUp\s*\(/g, SERVER_CODE)).toEqual([])
    expect(at).toBeLessThan(startResolution(SERVER_CODE).bringUpAt)
    // Right after it is built: the only code between the controller's
    // construction and the assignment is the construction itself.
    const [, callEnd] = balancedAfter(SERVER_CODE, onlyCallOf('createPersonaBringUpController'), '(', ')')
    expect(SERVER_CODE.slice(callEnd + 1, at).trim()).toBe('')
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

  test('the restart module\'s launch passes the gate to launchSession as canLaunch', () => {
    const gate = constOf('createPersonaRelaunchGate')
    expect(onlyCallProps('initRestart').get('launchSession')).toContain('launchSession(')
    const args = onlyCallArgs('launchSession')
    expect(args).toHaveLength(3)
    expect(objectProperties(args[2]!).get('canLaunch')).toBe(gate)
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
      // The child gets only PATH, HOME and SLACK_STATE_DIR (no token, CSCB_*,
      // CLAUDE_* or AGENT_DIRECTOR_* variable) and imports server.ts from an
      // eval script, so server.ts is never the entry point.
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
