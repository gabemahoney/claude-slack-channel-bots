/** fault-route admission, startup capture and real SDK disconnect. */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import ts from 'typescript'
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import { loadPersonaConfig, resolvePersonaConfig, type PersonaConfig } from '../src/config.ts'
import {
  _resetRegistry, createPendingSession, createSessionServer, getPendingSession,
  getSessionByPersona, registerMcpSessionId, registerSession, removePendingSession,
  resolveTransportForRequest, unregisterByMcpSessionId,
} from '../src/registry.ts'
import { _buildRestartDisconnectedPersona, startSseKeepAlive, stopAllKeepAliveTimers, stopSseKeepAlive } from '../src/server.ts'
import { handleTestMcpDrop, TEST_MCP_DROP_ROUTE, TEST_MCP_DROP_START_LINE, testMcpDropLine, type TestMcpDropDeps } from '../src/test-mcp-drop.ts'
import { INTERJECT_BODY_CAP_BYTES } from '../src/interject.ts'
import { assertNoLeak, BOT_TOKEN_PREFIX, fakeToken, sentinelInMessage } from './test-helpers/credentials.ts'
import { runInFakeHome } from './test-helpers/fake-home-subprocess.ts'
import { makeMultiPersonaConfig, makePersonaConfigInput, writeConfigFile } from './test-helpers/persona-config.ts'
import { makeReloadHarness } from './test-helpers/reload-harness.ts'

const serverPath = new URL('../src/server.ts', import.meta.url)
const source = ts.createSourceFile('server.ts', readFileSync(serverPath, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
const main = source.statements.find((n): n is ts.FunctionDeclaration => ts.isFunctionDeclaration(n) && n.name?.text === 'main')!
const startup = main.body!.statements.find(n => ts.isVariableStatement(n) && n.declarationList.declarations.some(d => d.name.getText(source) === 'testMcpDropEnabled'))!
const warning = main.body!.statements[main.body!.statements.indexOf(startup) + 1]!
const pending = source.statements.find((n): n is ts.FunctionDeclaration => ts.isFunctionDeclaration(n) && n.name?.text === 'initPendingSession')!
let fetchMethod: ts.MethodDeclaration | undefined
function findFetch(n: ts.Node): void {
  if (ts.isCallExpression(n) && n.expression.getText(source) === 'Bun.serve') {
    const options = n.arguments[0] as ts.ObjectLiteralExpression
    fetchMethod = options.properties.find((p): p is ts.MethodDeclaration => ts.isMethodDeclaration(p) && p.name.getText(source) === 'fetch')
  }
  ts.forEachChild(n, findFetch)
}
findFetch(main)

/** Evaluate the actual production closures with injected holders, without invoking main().
 * The startup and transport callbacks are not reimplemented here; mutations to the
 * production gate, requestIP guard, DELETE path or close callback reach these tests.
 */
function evaluate<T>(code: string, deps: Record<string, unknown>): T {
  const js = ts.transpile(code, { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.None })
  return new Function(...Object.keys(deps), js)(...Object.values(deps)) as T
}

let dir: string
let config: PersonaConfig
let logs: string[]
let closed: string[]
let captured: unknown[]
const transports: WebStandardStreamableHTTPServerTransport[] = []
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mcp-drop-'))
  config = makeMultiPersonaConfig([{ name: 'alpha' }, { name: 'beta' }], dir)
  logs = []; closed = []; captured = []
  _resetRegistry()
})
afterEach(async () => {
  stopAllKeepAliveTimers()
  for (const transport of transports.splice(0)) await transport.close()
  _resetRegistry()
  try { assertNoLeak({ logs, captured }) }
  finally { rmSync(dir, { recursive: true, force: true }) }
})
function request(body: unknown = { persona: config.personas[0]!.key }, method = 'POST', headers?: HeadersInit): Request {
  return new Request(`http://127.0.0.1${TEST_MCP_DROP_ROUTE}`, {
    method, headers,
    ...(['GET', 'HEAD'].includes(method) ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
  })
}
function deps(): TestMcpDropDeps {
  return { getPersonaConfig: () => config, log: line => logs.push(line), disconnect: async key => { closed.push(key) } }
}
async function body(response: Response): Promise<unknown> {
  const value: unknown = await response.json()
  captured.push(value)
  return value
}

describe('test-only drop handler', () => {
  test.each(['127.0.0.1', '::1', '::ffff:127.0.0.1'])('%s closes exactly the configured key and logs its use', async peer => {
    const key = config.personas[1]!.key
    const response = await handleTestMcpDrop(request({ persona: key }), peer, deps())
    expect(response.status).toBe(200)
    expect(await body(response)).toEqual({ ok: true, persona: key })
    expect(closed).toEqual([key])
    expect(logs).toEqual([testMcpDropLine(key)])
  })
  test.each(['GET', 'HEAD', 'PUT', 'DELETE'])('%s is refused without disconnecting', async method => {
    const response = await handleTestMcpDrop(request(undefined, method), '127.0.0.1', deps())
    expect(response.status).toBe(405)
    expect(await body(response)).toEqual({ error: 'Method Not Allowed' })
    expect(closed).toEqual([]); expect(logs).toEqual([])
  })
  test.each(['10.0.0.5', '::ffff:10.0.0.5', 'fe80::1', '', null, undefined])('%p cannot spoof loopback with forwarding headers', async peer => {
    const response = await handleTestMcpDrop(request(undefined, 'POST', {
      'x-forwarded-for': '127.0.0.1', forwarded: 'for="[::1]"', 'x-real-ip': '127.0.0.1',
    }), peer, deps())
    expect(response.status).toBe(403)
    expect(await body(response)).toEqual({ error: 'Forbidden' })
    expect(closed).toEqual([]); expect(logs).toEqual([])
  })
  test.each([
    ['missing persona', {}], ['empty persona', { persona: '' }], ['numeric persona', { persona: 3 }],
    ['null persona', { persona: null }], ['array', []], ['null body', null], ['invalid JSON', 'broken json'],
  ])('invalid input %s closes nothing', async (_label, input) => {
    const response = await handleTestMcpDrop(request(input), '127.0.0.1', deps())
    expect(response.status).toBe(400)
    await body(response)
    expect(closed).toEqual([]); expect(logs).toEqual([])
  })
  test('an unknown key is 404 without echoing an untrusted token-shaped input', async () => {
    const response = await handleTestMcpDrop(request({ persona: fakeToken(BOT_TOKEN_PREFIX, 'unknown-drop-key') }), '127.0.0.1', deps())
    expect(response.status).toBe(404)
    expect(await body(response)).toEqual({ error: 'Persona not found' })
    expect(closed).toEqual([]); expect(logs).toEqual([])
  })
  test('no applied configuration refuses the drop without closing anything', async () => {
    const response = await handleTestMcpDrop(request(), '127.0.0.1', { ...deps(), getPersonaConfig: () => null })
    expect(response.status).toBe(404)
    expect(await body(response)).toEqual({ error: 'Persona not found' })
    expect(closed).toEqual([]); expect(logs).toEqual([])
  })
  test('the body limit counts UTF-8 bytes, accepting the cap and refusing one byte more', async () => {
    const prefix = JSON.stringify({ persona: config.personas[0]!.key, padding: 'é' })
    const exact = prefix.slice(0, -1) + ' '.repeat(INTERJECT_BODY_CAP_BYTES - Buffer.byteLength(prefix)) + '}'
    expect(Buffer.byteLength(exact)).toBe(INTERJECT_BODY_CAP_BYTES)
    const accepted = await handleTestMcpDrop(request(exact), '127.0.0.1', deps())
    expect(accepted.status).toBe(200)
    await body(accepted)
    const refused = await handleTestMcpDrop(request(exact + ' '), '127.0.0.1', deps())
    expect(refused.status).toBe(400)
    expect(await body(refused)).toEqual({ error: 'Request body too large' })
    expect(closed).toEqual([config.personas[0]!.key])
    expect(logs).toHaveLength(1)
  })
  test('a failed disconnect returns a fixed token-safe error and logs the use once', async () => {
    const response = await handleTestMcpDrop(request(), '127.0.0.1', {
      ...deps(), disconnect: async () => { throw new Error(sentinelInMessage('drop failure')) },
    })
    expect(response.status).toBe(500)
    expect(await body(response)).toEqual({ error: 'MCP disconnect failed' })
    expect(logs).toEqual([testMcpDropLine(config.personas[0]!.key)])
  })
})

/** The complete production HTTP callback, including its ordinary 404/MCP paths. */
function listener(start: PersonaConfig) {
  return evaluate<{ fetch(req: Request, peer?: string | null): Promise<Response>; apply(next: PersonaConfig): void }>(`
    let personaConfig = start;
    ${startup.getText(source)}
    ${warning.getText(source)}
    const listener = { ${fetchMethod!.getText(source)} };
    return {
      fetch: (req, peer = '127.0.0.1') => listener.fetch(req, { requestIP: () => peer == null ? null : { address: peer }, timeout: () => {} }),
      apply: next => { personaConfig = next; }
    };
  `, {
    start, console: { error: (line: string) => logs.push(line) },
    TEST_MCP_DROP_ROUTE, TEST_MCP_DROP_START_LINE, handleTestMcpDrop,
    getSessionByPersona, resolveTransportForRequest,
    isHttpVerbose: () => false, CLEAR_LATCH_ROUTE: '/clear-latch',
    unregisterByMcpSessionId, restartDisconnectedPersona: () => {},
  })
}

describe('production startup gate and transport lifecycle', () => {
  test.each([undefined, false, true])('startup value %p controls existence and the one warning', async enabled => {
    const http = listener({ ...config, test_mcp_drop_endpoint: enabled })
    const response = await http.fetch(request())
    expect(response.status).toBe(enabled ? 200 : 404)
    await body(response)
    expect(logs).toEqual(enabled ? [TEST_MCP_DROP_START_LINE, testMcpDropLine(config.personas[0]!.key)] : [])
    if (enabled) {
      expect(TEST_MCP_DROP_START_LINE).toMatch(/test-only.*ON.*not for production use/)
      const second = await http.fetch(request())
      expect(second.status).toBe(200)
      expect(logs.filter(line => line === TEST_MCP_DROP_START_LINE)).toHaveLength(1)
      expect(logs.filter(line => line === testMcpDropLine(config.personas[0]!.key))).toHaveLength(2)
    }
  })
  test('production wiring passes the actual peer, regardless of forwarding headers', async () => {
    const http = listener({ ...config, test_mcp_drop_endpoint: true })
    const response = await http.fetch(request(undefined, 'POST', { 'x-forwarded-for': '127.0.0.1', forwarded: 'for=127.0.0.1' }), '203.0.113.5')
    expect(response.status).toBe(403)
    expect(await body(response)).toEqual({ error: 'Forbidden' })
    expect(logs).toEqual([TEST_MCP_DROP_START_LINE])
  })
  test('SDK DELETE removes only the selected session and schedules its normal recovery once', async () => {
    const restarts: Array<[string, string]> = []
    const recover = _buildRestartDisconnectedPersona({
      getPersona: key => config.personas.find(p => p.key === key),
      scheduleRestart: (key, cwd) => { restarts.push([key, cwd]) },
      isShuttingDown: () => false, isTmuxUnavailable: () => false,
      isRetryArmed: () => false, isLatched: () => false, isWorkInFlight: () => false,
      armRetryTimer: () => {}, log: line => logs.push(line),
    })
    const init = evaluate<() => { pendingId: string; transport: WebStandardStreamableHTTPServerTransport }>(`${pending.getText(source)}; return initPendingSession;`, {
      WebStandardStreamableHTTPServerTransport, createPendingSession, createSessionServer,
      getPendingSession, removePendingSession, unregisterByMcpSessionId,
      startSseKeepAlive, stopSseKeepAlive, restartDisconnectedPersona: recover,
      sessionToolDeps: {}, console: { error: (line: string) => logs.push(line) },
    })
    const sessions = []
    for (const persona of config.personas) {
      const session = init()
      transports.push(session.transport)
      const response = await session.transport.handleRequest(new Request('http://127.0.0.1/mcp', {
        method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {
          protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'drop-unit', version: '1' },
        } }),
      }))
      expect(response.status).toBe(200)
      await response.text()
      const entry = registerSession(persona.working_directory, persona.key, session.pendingId)
      registerMcpSessionId(session.pendingId, persona.key)
      sessions.push({ ...session, entry })
    }
    const [target, other] = sessions
    const http = listener({ ...config, test_mcp_drop_endpoint: true })
    // Refusal must preserve the real registered transport, not merely avoid a mock close.
    for (const [req, peer, status] of [
      [request(), '203.0.113.5', 403],
      [request(undefined, 'GET'), '127.0.0.1', 405],
      [request({ persona: 'missing' }), '127.0.0.1', 404],
    ] as const) {
      const refused = await http.fetch(req, peer)
      expect(refused.status).toBe(status)
      await body(refused)
      expect(target!.entry.connected).toBe(true)
      expect(getSessionByPersona(config.personas[0]!.key)).toBe(target!.entry)
      expect(restarts).toEqual([])
    }
    const response = await http.fetch(request())
    expect(response.status).toBe(200)
    expect(await body(response)).toEqual({ ok: true, persona: config.personas[0]!.key })
    expect(target!.entry.connected).toBe(false)
    expect(getSessionByPersona(config.personas[0]!.key)).toBeUndefined()
    expect(other!.entry.connected).toBe(true)
    expect(getSessionByPersona(config.personas[1]!.key)).toBe(other!.entry)
    expect(restarts).toEqual([[config.personas[0]!.key, config.personas[0]!.working_directory]])
    const stale = await http.fetch(new Request('http://127.0.0.1/mcp', { method: 'DELETE', headers: { 'mcp-session-id': target!.pendingId } }))
    expect(stale.status).toBe(404)
    await body(stale)
    expect((await http.fetch(request())).status).toBe(200)
    expect(restarts).toHaveLength(1)
  })
})

describe('drop configuration and reload', () => {
  test.each([undefined, false, true])('the real file loader accepts %p', enabled => {
    const input = { ...makePersonaConfigInput({}, dir), ...(enabled === undefined ? {} : { test_mcp_drop_endpoint: enabled }) }
    const loaded = loadPersonaConfig(writeConfigFile(dir, input), dir)
    expect(loaded.test_mcp_drop_endpoint).toBe(enabled)
    captured.push(loaded)
  })
  test.each([
    ['null', null], ['zero', 0], ['one', 1], ['string', 'true'], ['object', {}], ['array', []],
    ['token-shaped value', fakeToken(BOT_TOKEN_PREFIX, 'invalid-drop-switch')],
  ])('invalid switch %s is rejected without echoing it', (_label, value) => {
    let failure: unknown
    try { resolvePersonaConfig({ ...makePersonaConfigInput({}, dir), test_mcp_drop_endpoint: value }, dir, dir) }
    catch (error) { failure = error }
    expect(failure).toBeInstanceOf(Error)
    expect((failure as Error).message).toMatch(/test_mcp_drop_endpoint.*boolean/)
    captured.push((failure as Error).message)
  })
  test.each([[false, true], [true, false]])('confirmed reload %p → %p leaves route existence captured at start', async (initial, next) => {
    const h = makeReloadHarness()
    try {
      const alpha = h.persona('alpha')
      h.materialize(alpha)
      h.writeConfig({ personas: [alpha], test_mcp_drop_endpoint: initial })
      const run = await h.startDetecting()
      try {
        const http = listener(run.serverConfig()!)
        h.writeConfig({ personas: [alpha], test_mcp_drop_endpoint: next })
        await run.ticks.tick()
        expect(h.pendingExists()).toBe(true)
        assertNoLeak(run.captured())
        h.confirm()
        await run.ticks.tick()
        expect(run.controller.applied()!.config.test_mcp_drop_endpoint).toBe(next)
        expect(run.serverConfig()!.test_mcp_drop_endpoint).toBe(initial)
        // Challenge the listener with the changed record as well: even a new
        // applied holder must not change the startup-captured route switch.
        http.apply(run.controller.applied()!.config)
        const response = await http.fetch(request({ persona: run.serverConfig()!.personas[0]!.key }))
        expect(response.status).toBe(initial ? 200 : 404)
        await body(response)
        expect(logs.filter(line => line === TEST_MCP_DROP_START_LINE)).toHaveLength(initial ? 1 : 0)
        expect(run.slackPosts()).toEqual([])
      } finally { assertNoLeak(run.captured()) }
    } finally { await h.cleanup() }
  })
  test('importing the handler opens no listener, creates no state and prints nothing', () => {
    const run = runInFakeHome({
      modulePath: new URL('../src/test-mcp-drop.ts', import.meta.url).pathname,
      home: dir, input: null, env: { BUN_RUNTIME_TRANSPILER_CACHE_PATH: '0' },
      call: `process.stdout.write('HANDLER::' + typeof mod.handleTestMcpDrop + '\\n')`,
    })
    expect(run.observedHomedir).toBe(dir)
    expect(run.status).toBe(0)
    expect(run.stdout).toBe(`HOMEDIR::${dir}\nHANDLER::function\n`)
    expect(run.stderr).toBe('')
    expect(readdirSync(dir)).toEqual([])
    captured.push(run)
  })
})
