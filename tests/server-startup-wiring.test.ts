/**
 * server-startup-wiring.test.ts — The server's start-up wiring after the
 * loader switch (b.av2 SR-3.1, SR-10.2, SR-8.7, SR-13.2).
 *
 * - SR-3.1: no Slack client is built and no token is read at module scope in
 *   src/server.ts; the connection manager is built inside main().
 * - SR-10.2: `SLACK_BOT_TOKEN` / `SLACK_APP_TOKEN` are neither required nor
 *   read by the server; only src/cli.ts still names them.
 * - SR-8.7: the `MCP_HOST` / `MCP_PORT` fallback is gone; main() loads the
 *   required config file through the persona loader and exits on failure.
 * - SR-13.2: importing src/server.ts touches nothing under HOME. Before the
 *   switch the import read the token variables (exiting without them) and
 *   created `~/.claude/channels/slack`; main() now creates the state and
 *   inbox directories.
 * - The connection seams (SR-3.1, SR-3.4, SR-4.1, SR-7.2): the manager's dry
 *   run and up→flush listener, `connections = <manager>`, `clientFor` and
 *   `identityFor` over the connection view, the routing's identity, client and
 *   archive seams, and the archive writer's per-persona resolver source.
 * - The relaunch gate (SR-6.1): built over the manager and passed to the
 *   restart launch and the health-check work list; the restart delay read
 *   from the applied config; the permission poller not started in dry run.
 * - SR-5.2: the file guard handed to the session tools protects every persona
 *   credentials file.
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
  loadedConfigName,
  objectProperties,
  onlyCallArguments,
  splitTopLevel,
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

/** [start, end) of main()'s body in the code. */
function mainBody(): [number, number] {
  const decl = SERVER_CODE.search(/\bexport\s+async\s+function\s+main\s*\(\s*\)/)
  expect(decl).toBeGreaterThan(-1)
  return balancedAfter(SERVER_CODE, SERVER_CODE.indexOf(')', decl), '{', '}')
}

function insideMain(offset: number): boolean {
  const [start, end] = mainBody()
  return offset > start && offset < end
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
// Static audit: the persona loader (SR-1.7, SR-8.7)
// ---------------------------------------------------------------------------

describe('main() loads the persona config through the persona loader (SR-1.7, SR-8.7)', () => {
  test('imports loadStartPersonaConfig and no route loader from the config module', () => {
    const configImports = [...SERVER_CODE.matchAll(/import\s*\{([^}]*)\}\s*from\s*['"]\.\/config\.ts['"]/g)]
    expect(configImports).toHaveLength(1)
    const names = configImports[0]![1]!.split(',').map((n) => n.trim().replace(/^type\s+/, ''))
    expect(names).toContain('loadStartPersonaConfig')
    for (const routeName of ['loadConfig', 'resolveConfig', 'applyDefaults', 'validateConfig']) {
      expect(names).not.toContain(routeName)
    }
    // No route type either (the removed route config types all contained "Rout").
    expect(names.filter((n) => /rout/i.test(n))).toEqual([])
  })

  test('loads CONFIG_PATH (the server config path) once, inside main(), and exits 1 when loading fails', () => {
    expect(SERVER_CODE).toMatch(/\bconst\s+CONFIG_PATH\s*=\s*resolveServerConfigPath\s*\(\s*\)/)
    expect(insideMain(onlyCallOf('loadStartPersonaConfig'))).toBe(true)
    // The call is the whole try block, and its catch exits.
    const guarded = SERVER_CODE.search(
      /try\s*\{\s*\w+\s*=\s*loadStartPersonaConfig\s*\(\s*CONFIG_PATH\s*\)\s*;?\s*\}\s*catch\s*\([^)]*\)\s*\{/,
    )
    expect(guarded).toBeGreaterThan(-1)
    const catchBody = SERVER_CODE.slice(...balancedAfter(SERVER_CODE, SERVER_CODE.indexOf('catch', guarded), '{', '}'))
    expect(catchBody).toMatch(/\bprocess\.exit\s*\(\s*1\s*\)/)
  })

  test.each([
    ['the PID file', 'writePidFile'],
    ['the template install', 'installSlackChannelBotTemplate'],
    ['the connection manager', 'createPersonaConnectionManager'],
    ['Bun.serve', 'Bun\\.serve'],
    ['the per-persona bring-up', 'startupSessionManager'],
  ])('loads the config BEFORE %s', (_label, anchor) => {
    const load = onlyCallOf('loadStartPersonaConfig')
    const later = callsOf(anchor)
    expect(later.length).toBeGreaterThan(0)
    for (const at of later) expect(load).toBeLessThan(at)
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
    ['the per-persona bring-up', 'startupSessionManager'],
  ])('installs it BEFORE %s', (_label, anchor) => {
    const [install] = indicesOf(INSTALL, SERVER_CODE)
    expect(install).toBeDefined()
    expect(install!).toBeLessThan(onlyCallOf(anchor))
  })
})

// ---------------------------------------------------------------------------
// Static audit: the bring-up gets the loaded config and its deps (SR-6.1)
// ---------------------------------------------------------------------------

describe('startupSessionManager runs the SR-6.1 bring-up over the loaded persona config', () => {
  test('gets the loaded persona config and bring-up deps over the connection manager, with dry run passed through', () => {
    const args = onlyCallArguments(SERVER_CODE, 'startupSessionManager')
    expect(args.split(',')[0]!.trim()).toBe(loadedConfigName(SERVER_CODE))

    const bringUpAt = args.search(/\bbringUp\s*:\s*\{/)
    expect(bringUpAt).toBeGreaterThan(-1)
    const bringUp = args.slice(...balancedAfter(args, bringUpAt, '{', '}'))
    expect(bringUp).toMatch(new RegExp(`\\bconnections\\s*:\\s*${constOf('createPersonaConnectionManager')}\\b`))
    expect(bringUp).toMatch(/\bdryRun\s*:\s*isDryRun\s*\(\s*\)/)
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
  test('the connection manager takes dry run from isDryRun() and flushes, on each up, the notifier every persona notice goes through', () => {
    const notifier = constOf('createPersonaNotifier')
    // The notices' notifier: the session manager's sink and the outage state's notify.
    expect(onlyCallArgs('setSessionNotifier')).toEqual([`${notifier}.notify`])
    expect(onlyCallProps('initOutageState').get('notify')).toContain(`${notifier}.notify(`)

    const props = onlyCallProps('createPersonaConnectionManager')
    expect(props.get('dryRun')).toBe('isDryRun()')
    expect(props.get('onStatus')).toBe(`createPersonaUpFlushListener(${notifier})`)
  })

  test('main() points the lookups at the manager: `connections = <manager>` once, inside main(), before the bring-up', () => {
    const manager = constOf('createPersonaConnectionManager')
    const assigns = assignmentsTo('connections')
    expect(assigns.map((a) => a.value)).toEqual([manager])
    expect(insideMain(assigns[0]!.at)).toBe(true)
    expect(assigns[0]!.at).toBeGreaterThan(onlyCallOf('createPersonaConnectionManager'))
    expect(assigns[0]!.at).toBeLessThan(onlyCallOf('startupSessionManager'))
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
    expect(props.get('getBotUserId')).toMatch(/^\((\w+)\) => identityFor\(\1\)\?\.botUserId$/)
    expect(props.get('clientFor')).toBe('clientFor')
    expect(props.get('archive')).toMatch(/^\((\w+), (\w+)\) => archiveWrite\?\.\(\1, \2\)$/)
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
  test('the relaunch gate is built once, inside main(), over the connection manager', () => {
    constOf('createPersonaRelaunchGate')
    expect(insideMain(onlyCallOf('createPersonaRelaunchGate'))).toBe(true)
    expect(onlyCallArgs('createPersonaRelaunchGate')[0]).toBe(constOf('createPersonaConnectionManager'))
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
    const loaded = loadedConfigName(SERVER_CODE)
    const applied = [...SERVER_CODE.matchAll(new RegExp(`\\bconst\\s+(\\w+)(?:\\s*:\\s*\\w+)?\\s*=\\s*${loaded}\\s*(?:;|\\n)`, 'g'))]
    expect(applied).toHaveLength(1)
    expect(insideMain(applied[0]!.index!)).toBe(true)
    expect(applied[0]!.index!).toBeGreaterThan(onlyCallOf('loadStartPersonaConfig'))
    expect(onlyCallProps('initRestart').get('getRestartDelay')).toBe(`() => ${applied[0]![1]}.session_restart_delay`)
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
  test('assertSendable builds its protected list from the applied personas and the config path per call, and the session tools get it with clientFor', () => {
    expect(SERVER_CODE).toMatch(/import\s*\{[^}]*\bassertSendable\s+as\s+libAssertSendable\b[^}]*\}\s*from\s*['"]\.\/lib\.ts['"]/)
    const fn = SERVER_CODE.search(/\bfunction\s+assertSendable\s*\(/)
    expect(fn).toBeGreaterThan(-1)
    const body = SERVER_CODE.slice(...balancedAfter(SERVER_CODE, fn, '{', '}'))
    const list = body.match(/\bconst\s+(\w+)\s*=\s*credentialsFilesToProtect\s*\(/)
    expect(list).not.toBeNull()
    expect(splitTopLevel(callArguments(body, list!.index!))).toEqual([`${loadedConfigName(SERVER_CODE)}?.personas ?? []`, 'CONFIG_PATH'])
    const guard = body.search(/\blibAssertSendable\s*\(/)
    expect(guard).toBeGreaterThan(-1)
    expect(splitTopLevel(callArguments(body, guard))).toEqual(['filePath', 'resolve(STATE_DIR)', 'resolve(INBOX_DIR)', list![1]])

    const deps = SERVER_CODE.search(/\bconst\s+sessionToolDeps\s*:\s*SessionToolDeps\s*=\s*\{/)
    expect(deps).toBeGreaterThan(-1)
    const props = objectProperties(SERVER_CODE.slice(SERVER_CODE.indexOf('=', deps)))
    expect(props.get('assertSendable')).toBe('assertSendable')
    expect(props.get('clientFor')).toBe('clientFor')
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
