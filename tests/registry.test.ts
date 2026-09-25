/**
 * registry.test.ts — Persona-keyed MCP session registry, not-up session
 * admission and drop, and persona-scoped Slack tools (b.av2 SR-6.3, SR-6.4,
 * SR-5.1, SR-5.2 wiring, SR-12 instructions part).
 *
 * Tools are driven through the real MCP server (`createSessionServer`) with an
 * in-memory MCP client. Each persona has its own `makeStubSlack` client, so a
 * case can show which persona's client a call landed on. Every path is under
 * the test's own `mkdtempSync` directory; no token literal appears here.
 * The not-up block (b.av2 SR-6.3, SR-6.4) brings personas up through the real
 * bring-up controller on the real connection manager (stub Slack, fake clock)
 * and drives the real admission decision, up predicate and session drop.
 * The global `fetch` is stubbed for every test (it throws unless a test sets
 * `h.fetchHandler`), so no test reaches the network, and every tool result
 * and log line is leak-checked in `afterEach`.
 *
 * SPDX-License-Identifier: MIT
 */

import { describe, test, expect, beforeEach, afterEach, spyOn } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import type { Persona } from '../src/config.ts'
import { assertSendable } from '../src/lib.ts'
import { renderPersonaRef } from '../src/persona-identity.ts'
import {
  createNotUpSessionDropper,
  createPersonaBringUpController,
  describePersonaNotUp,
  type PersonaBringUpController,
} from '../src/persona-bringup-controller.ts'
import { createPersonaUpPredicate } from '../src/persona-start.ts'
import {
  closePendingSession,
  decideSessionAdmission,
  dropPersonaSession,
  type SessionAdmission,
  registerSession,
  unregisterSession,
  unregisterByMcpSessionId,
  getSessionByPersona,
  registerMcpSessionId,
  resolveTransportForRequest,
  createPendingSession,
  getPendingSession,
  removePendingSession,
  getAllPendingSessions,
  createSessionServer,
  matchPersonaByRootsPath,
  checkPersonaTarget,
  isSlackHostedFileUrl,
  type PersonaTargetAction,
  type PersonaTargetCheck,
  _resetRegistry,
  type SessionEntry,
  type SessionToolDeps,
} from '../src/registry.ts'
import { trackAck, consumeAck, _resetAckTracker } from '../src/ack-tracker.ts'
import { makeMultiPersonaConfig, makeStandInPersonaConfig } from './test-helpers/persona-config.ts'
import {
  asWebClient,
  makeStubSlack,
  openedDm,
  stubOpenedDmId,
  type StubSlack,
  type StubSlackOptions,
  type StubWebCall,
  type StubWebMethod,
  type WebApiOutcome,
} from './test-helpers/slack-stub.ts'
import { makeConnectionHarness, type ConnectionHarness } from './test-helpers/persona-connection-harness.ts'
import {
  BOT_TOKEN_PREFIX,
  LEAK_SENTINEL,
  assertNoLeak,
  fakeToken,
  writeCredentialsFile,
  writtenFile,
} from './test-helpers/credentials.ts'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/**
 * Minimal stub for WebStandardStreamableHTTPServerTransport. `closeCalls`
 * counts `close()`; `onClose` runs inside it, to observe the registry then.
 */
function makeTransport(sessionId?: string, onClose?: () => void): any {
  const transport = {
    sessionId,
    closeCalls: 0,
    handleRequest: () => {},
    close: async () => {
      transport.closeCalls++
      onClose?.()
    },
  }
  return transport
}

/** What an HTTP request carrying MCP session ID `id` is routed to. */
function routed(id: string) {
  return resolveTransportForRequest(new Request('http://localhost/mcp', { headers: { 'mcp-session-id': id } }))
}

/** Minimal stub for MCP Server. */
function makeServer(): any {
  return { connect: async () => {}, notification: () => {} }
}

/** A pending-session entry stub, as server.ts builds before roots are known. */
function makePendingStub(): SessionEntry {
  return { cwd: '', personaKey: '', transport: makeTransport(), server: makeServer(), connected: false, peerPort: 0 }
}

const A_ALL = 'C0ALPHA01'
const A_MENTIONS = 'C0ALPHA02'
const B_CHANNEL = 'C0BETA001'
const UNCONFIGURED = 'C0NOPE001'
const MSG_TS = '1700000000.000100'

type ToolName = 'reply' | 'react' | 'edit_message' | 'fetch_messages' | 'download_attachment'
type ToolResult = { isError?: boolean; content: Array<{ type: string; text: string }> }

/** Arguments for each tool aimed at `target`. */
const TOOL_ARGS: Record<ToolName, (target: string) => Record<string, unknown>> = {
  reply: (t) => ({ chat_id: t, text: 'hello' }),
  react: (t) => ({ chat_id: t, message_id: MSG_TS, emoji: 'thumbsup' }),
  edit_message: (t) => ({ chat_id: t, message_id: MSG_TS, text: 'edited' }),
  fetch_messages: (t) => ({ channel: t }),
  download_attachment: (t) => ({ chat_id: t, message_id: MSG_TS }),
}

/** The capture array each tool's first Slack call lands in. */
const TOOL_CAPTURE: Record<ToolName, keyof StubSlack['calls']> = {
  reply: 'postMessage',
  react: 'reactionsAdd',
  edit_message: 'update',
  fetch_messages: 'conversationsHistory',
  download_attachment: 'conversationsReplies',
}

const TOOLS = Object.keys(TOOL_ARGS) as ToolName[]

/** Every Slack call recorded on a stub, across all capture arrays. */
function slackCallCount(stub: StubSlack): number {
  return Object.values(stub.calls).reduce((n, list) => n + list.length, 0)
}

interface Harness {
  dir: string
  stateDir: string
  inboxDir: string
  credentialsFile: string
  /** Persona A: 'Alpha Bot', channels A_ALL (all) and A_MENTIONS (mentions). */
  alpha: Persona
  /** Persona B: 'Beta Bot', channel B_CHANNEL. */
  beta: Persona
  /** The persona lookup behind `deps.getPersona`; edit between calls. */
  personas: Map<string, Persona>
  /** Per-persona stubs behind `deps.clientFor`; edit between calls. */
  clients: Map<string, StubSlack>
  alphaToken: string
  deps: SessionToolDeps
  /** console.error lines captured during the test. */
  lines: string[]
  /** Every tool result returned through `openSession`; leak-checked in `afterEach`. */
  results: ToolResult[]
  /** Every `fetch` call made during the test (the global `fetch` is stubbed for every test). */
  fetches: FetchCall[]
  /** Answers each stubbed `fetch`; throws by default, so no test can reach the network. */
  fetchHandler: (url: string) => Response | Promise<Response>
}

/** One stubbed `fetch` call: its URL, `Authorization` header and `redirect` mode. */
interface FetchCall {
  url: string
  auth: string | null
  redirect: RequestRedirect | undefined
}

const realFetch = globalThis.fetch

let h: Harness
let openClients: Client[] = []
let savedDryRun: string | undefined
let consoleSpy: ReturnType<typeof spyOn> | undefined

function makeHarness(): Harness {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'registry-test-')))
  const config = makeMultiPersonaConfig(
    [
      { name: 'Alpha Bot', channels: [{ id: A_ALL, delivery: 'all' }, { id: A_MENTIONS, delivery: 'mentions' }] },
      { name: 'Beta Bot', channels: [{ id: B_CHANNEL, delivery: 'all' }] },
    ],
    dir,
  )
  const [alpha, beta] = config.personas as [Persona, Persona]
  for (const p of config.personas) mkdirSync(p.working_directory, { recursive: true })
  const stateDir = join(dir, 'state')
  const inboxDir = join(stateDir, 'inbox')
  mkdirSync(inboxDir, { recursive: true })
  const credentialsFile = writeCredentialsFile(dir, 'alpha-credentials.json')
  const alphaToken = fakeToken(BOT_TOKEN_PREFIX, 'alpha')
  const personas = new Map(config.personas.map((p) => [p.key, p]))
  const clients = new Map<string, StubSlack>([
    [alpha.key, makeStubSlack({ token: alphaToken, leakMarker: LEAK_SENTINEL })],
    [beta.key, makeStubSlack({ token: fakeToken(BOT_TOKEN_PREFIX, 'beta'), leakMarker: LEAK_SENTINEL })],
  ])
  const deps: SessionToolDeps = {
    assertSendable: (p) => assertSendable(p, stateDir, inboxDir, [credentialsFile]),
    getAccess: () => ({ dmPolicy: 'pairing' as const, allowFrom: [], channels: {}, pending: {}, ackReaction: 'eyes' }),
    getPersona: (key) => personas.get(key),
    clientFor: (key) => {
      const stub = clients.get(key)
      return stub ? asWebClient(stub.web) : undefined
    },
    inboxDir,
    resolveUserName: async (_key, userId) => userId,
    consumeAck,
    serverPort: 0,
  }
  return {
    dir, stateDir, inboxDir, credentialsFile, alpha, beta, personas, clients, alphaToken, deps,
    lines: [],
    results: [],
    fetches: [],
    fetchHandler: () => {
      throw new Error('unexpected fetch in registry.test.ts')
    },
  }
}

/** Open an in-memory MCP client on a session server built over `entry`. */
async function openSession(entry: SessionEntry, deps: SessionToolDeps = h.deps) {
  const server = createSessionServer(entry, deps)
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  const client = new Client({ name: 'test-client', version: '1.0.0' }, { capabilities: {} })
  await client.connect(clientTransport)
  openClients.push(client)
  return {
    client,
    call: async (name: string, args: Record<string, unknown>) => {
      const result = (await client.callTool({ name, arguments: args })) as ToolResult
      h.results.push(result)
      return result
    },
  }
}

/** Register persona `p`'s session and open a client on it. */
function openPersonaSession(p: Persona) {
  return openSession(registerSession(p.working_directory, p.key, makeTransport(), makeServer()))
}

function stubOf(p: Persona): StubSlack {
  return h.clients.get(p.key)!
}

function totalSlackCalls(): number {
  return [...h.clients.values()].reduce((n, s) => n + slackCallCount(s), 0)
}

/** Why `checkPersonaTarget` refuses a target (b.av2 SR-5.1). */
const WHY = {
  channel: "it is not one of the persona's configured channels.",
  dmsOff: 'DMs are off for this persona (dm.enabled is false).',
  userId: 'this tool needs a conversation ID (a channel ID or a D… DM conversation ID), not a user ID.',
} as const

function refusal(p: Persona, target: string, why: string = WHY.channel): string {
  return `Persona ${renderPersonaRef(p.name, p.key)} may not target ${JSON.stringify(target)}: ${why}`
}

/** Every Web API method called on any persona's stub, in call order per stub. */
function allCallLogs(): Record<string, StubWebMethod[]> {
  return Object.fromEntries([...h.clients].map(([key, stub]) => [key, stub.callLog.map((c) => c.method)]))
}

/** No persona's stub saw any Web API call. */
function expectNoSlackCall(): void {
  expect(allCallLogs()).toEqual(Object.fromEntries([...h.clients.keys()].map((key) => [key, []])))
}

/**
 * Apply `p` with its DMs switch set to `on` (and any other overrides, `dm`
 * fields such as `contact` included) as the persona `getPersona` returns now.
 */
function applyPersona(p: Persona, on: boolean, overrides: Partial<Persona> = {}): Persona {
  const applied: Persona = { ...p, ...overrides, dm: { ...p.dm, ...overrides.dm, enabled: on } }
  h.personas.set(p.key, applied)
  return applied
}

beforeEach(() => {
  _resetRegistry()
  _resetAckTracker()
  savedDryRun = process.env['SLACK_DRY_RUN']
  delete process.env['SLACK_DRY_RUN']
  h = makeHarness()
  consoleSpy = spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    h.lines.push(args.map(String).join(' '))
  })
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input)
    h.fetches.push({ url, auth: new Headers(init?.headers).get('Authorization'), redirect: init?.redirect })
    return h.fetchHandler(url)
  }) as typeof fetch
})

afterEach(async () => {
  for (const c of openClients) await c.close()
  openClients = []
  consoleSpy?.mockRestore()
  if (savedDryRun === undefined) delete process.env['SLACK_DRY_RUN']
  else process.env['SLACK_DRY_RUN'] = savedDryRun
  globalThis.fetch = realFetch
  rmSync(h.dir, { recursive: true, force: true })
  assertNoLeak({ lines: h.lines, results: h.results }, 'registry.test afterEach')
})

// ---------------------------------------------------------------------------
// Registry CRUD, keyed by persona
// ---------------------------------------------------------------------------

describe('registerSession / unregisterSession / getSessionByPersona', () => {
  test('registers a session under its persona key', () => {
    const entry = registerSession('/tmp/a', 'persona_a', makeTransport(), makeServer())

    expect(entry.cwd).toBe('/tmp/a')
    expect(entry.personaKey).toBe('persona_a')
    expect(entry.connected).toBe(true)
    expect(getSessionByPersona('persona_a')).toBe(entry)
  })

  test('re-registering the same persona replaces the session and marks the old one disconnected', () => {
    const first = registerSession('/tmp/a', 'persona_a', makeTransport(), makeServer())
    const second = registerSession('/tmp/b', 'persona_a', makeTransport(), makeServer())

    expect(second).not.toBe(first)
    expect(getSessionByPersona('persona_a')).toBe(second)
    expect(first.connected).toBe(false)
  })

  test('re-registration after unregister yields a connected session', () => {
    registerSession('/tmp/a', 'persona_a', makeTransport(), makeServer())
    unregisterSession('persona_a')

    expect(registerSession('/tmp/a', 'persona_a', makeTransport(), makeServer()).connected).toBe(true)
  })

  test('unregisterSession removes the session; unknown keys are a no-op', () => {
    registerSession('/tmp/a', 'persona_a', makeTransport(), makeServer())
    unregisterSession('persona_a')

    expect(getSessionByPersona('persona_a')).toBeUndefined()
    expect(() => unregisterSession('nonexistent')).not.toThrow()
  })

  test('getSessionByPersona misses an unregistered key', () => {
    expect(getSessionByPersona('persona_unknown')).toBeUndefined()
  })

  test('stale close: closing the replaced MCP session leaves the newer session registered and connected', () => {
    registerSession('/tmp/a', 'persona_a', makeTransport('mcp-old'), makeServer())
    registerMcpSessionId('mcp-old', 'persona_a')
    const newer = registerSession('/tmp/a', 'persona_a', makeTransport('mcp-new'), makeServer())
    registerMcpSessionId('mcp-new', 'persona_a')

    expect(unregisterByMcpSessionId('mcp-old')).toBeUndefined()

    expect(getSessionByPersona('persona_a')).toBe(newer)
    expect(newer.connected).toBe(true)
    expect(resolveTransportForRequest(new Request('http://localhost/mcp', { headers: { 'mcp-session-id': 'mcp-new' } }))).toBe(newer)
  })

  test('closing the current MCP session unregisters it and returns the persona key', () => {
    const entry = registerSession('/tmp/a', 'persona_a', makeTransport('mcp-1'), makeServer())
    registerMcpSessionId('mcp-1', 'persona_a')

    expect(unregisterByMcpSessionId('mcp-1')).toBe('persona_a')
    expect(entry.connected).toBe(false)
    expect(getSessionByPersona('persona_a')).toBeUndefined()
  })
})

describe('b.xnf regression — persona-keyed isolation', () => {
  test('two personas sharing a cwd keep distinct live sessions', () => {
    const a = registerSession('/tmp/shared', 'persona_a', makeTransport(), makeServer())
    const b = registerSession('/tmp/shared', 'persona_b', makeTransport(), makeServer())

    expect(getSessionByPersona('persona_a')).toBe(a)
    expect(getSessionByPersona('persona_b')).toBe(b)
    expect(a.connected).toBe(true)
    expect(b.connected).toBe(true)
  })

  test('an unregistered key does not find a session that shares its cwd', () => {
    registerSession('/tmp/shared', 'persona_real', makeTransport(), makeServer())

    expect(getSessionByPersona('persona_hijacker')).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// resolveTransportForRequest
// ---------------------------------------------------------------------------

describe('resolveTransportForRequest', () => {
  const req = (id?: string) => new Request('http://localhost/mcp', { headers: id ? { 'mcp-session-id': id } : {} })

  test('init request (no Mcp-Session-Id) → null; unknown ID → undefined', () => {
    expect(resolveTransportForRequest(req())).toBeNull()
    expect(resolveTransportForRequest(req('unknown-uuid'))).toBeUndefined()
  })

  test('known ID → the registered entry; disconnected → undefined', () => {
    const entry = registerSession('/tmp/a', 'persona_a', makeTransport(), makeServer())
    registerMcpSessionId('uuid-1', 'persona_a')

    expect(resolveTransportForRequest(req('uuid-1'))).toBe(entry)
    entry.connected = false
    expect(resolveTransportForRequest(req('uuid-1'))).toBeUndefined()
  })

  test('pending ID → the pending entry; after promotion → the registered entry', () => {
    const pending = createPendingSession('pend-1', makeTransport(), makeServer())
    expect(resolveTransportForRequest(req('pend-1'))).toBe(pending)

    const entry = registerSession('/tmp/p', 'persona_p', 'pend-1')
    registerMcpSessionId('pend-1', 'persona_p')
    expect(resolveTransportForRequest(req('pend-1'))).toBe(entry)
  })
})

// ---------------------------------------------------------------------------
// Pending sessions and promotion
// ---------------------------------------------------------------------------

describe('pending sessions', () => {
  test('create / get / remove / list / reset', () => {
    const transport = makeTransport()
    const server = makeServer()
    const entry = createPendingSession('pid-1', transport, server)
    createPendingSession('pid-2', makeTransport(), makeServer())

    expect(entry.transport).toBe(transport)
    expect(entry.server).toBe(server)
    expect(typeof entry.createdAt).toBe('number')
    expect(getPendingSession('pid-1')).toBe(entry)
    expect(getPendingSession('no-such-id')).toBeUndefined()
    expect(getAllPendingSessions().map((e) => e.pendingId).sort()).toEqual(['pid-1', 'pid-2'])

    removePendingSession('pid-1')
    expect(getPendingSession('pid-1')).toBeUndefined()
    expect(() => removePendingSession('nonexistent')).not.toThrow()

    _resetRegistry()
    expect(getAllPendingSessions()).toEqual([])
  })

  test.each<[string, boolean]>([
    ['resolves', false],
    ['rejects (the failure is ignored)', true],
  ])("closePendingSession removes the pending entry, then stops the keep-alive, then closes the transport, whose close %s; the other pending session and a persona's registered session are untouched", async (_label, closeRejects) => {
    const steps: string[] = []
    const transport = {
      close: async () => {
        steps.push('close')
        if (closeRejects) throw new Error('close failed')
      },
    }
    createPendingSession('pid-closed', transport as any, makeServer())
    const other = createPendingSession('pid-other', makeTransport(), makeServer())
    const registeredA = registerSession(h.alpha.working_directory, h.alpha.key, makeTransport('mcp-alpha'), makeServer())

    await closePendingSession('pid-closed', transport, {
      removePending: (id) => {
        steps.push(`removePending ${id}`)
        removePendingSession(id)
      },
      stopKeepAlive: (t) => void steps.push(t === transport ? 'stopKeepAlive' : 'stopKeepAlive (another transport)'),
    })

    expect(steps).toEqual(['removePending pid-closed', 'stopKeepAlive', 'close'])
    expect(getPendingSession('pid-closed')).toBeUndefined()
    expect(getPendingSession('pid-other')).toBe(other)
    expect(getSessionByPersona(h.alpha.key)).toBe(registeredA)
    expect(registeredA.connected).toBe(true)
  })

  test('stub-less promotion creates a fresh entry under the persona key and removes the pending entry', () => {
    const transport = makeTransport()
    const server = makeServer()
    createPendingSession('stubless', transport, server)

    const entry = registerSession('/tmp/sl', 'persona_sl', 'stubless')

    expect(entry).toEqual({ cwd: '/tmp/sl', personaKey: 'persona_sl', transport, server, connected: true, peerPort: 0 })
    expect(getSessionByPersona('persona_sl')).toBe(entry)
    expect(getPendingSession('stubless')).toBeUndefined()
  })

  test('promotion throws for an unknown pending ID', () => {
    expect(() => registerSession('/tmp/bad', 'persona_bad', 'nonexistent-pending-id')).toThrow()
  })

  test('promotion mutates the pending stub in place and sets the persona key', () => {
    const stub = makePendingStub()
    createPendingSession('pid-stub', makeTransport(), makeServer(), stub)

    const entry = registerSession(h.alpha.working_directory, h.alpha.key, 'pid-stub')

    expect(entry).toBe(stub)
    expect(stub.personaKey).toBe(h.alpha.key)
    expect(stub.cwd).toBe(h.alpha.working_directory)
    expect(stub.connected).toBe(true)
  })

  test('a server built on a pending stub refuses tools until promotion, then uses the promoted persona client', async () => {
    const stub = makePendingStub()
    const session = await openSession(stub)
    createPendingSession('pid-live', makeTransport(), makeServer(), stub)

    const before = await session.call('reply', TOOL_ARGS.reply(A_ALL))
    expect(before.isError).toBe(true)
    expect(before.content[0]!.text).toBe('Tool "reply" refused: this session is not matched to a persona.')
    expect(totalSlackCalls()).toBe(0)

    registerSession(h.alpha.working_directory, h.alpha.key, 'pid-live')
    const after = await session.call('reply', TOOL_ARGS.reply(A_ALL))

    expect(after.isError).toBeUndefined()
    expect(stubOf(h.alpha).calls.postMessage).toHaveLength(1)
    expect(slackCallCount(stubOf(h.beta))).toBe(0)
  })

  test('stand-in persona (key = channel ID) promoted from a pending stub replies to its channel', async () => {
    const standIn = makeStandInPersonaConfig({ C0STAND01: {} }, h.dir).personas[0]!
    h.personas.set(standIn.key, standIn)
    h.clients.set(standIn.key, makeStubSlack({ token: fakeToken(BOT_TOKEN_PREFIX, 'standin') }))
    const stub = makePendingStub()
    const session = await openSession(stub)
    createPendingSession('pid-standin', makeTransport(), makeServer(), stub)
    registerSession(standIn.working_directory, standIn.key, 'pid-standin')

    const result = await session.call('reply', TOOL_ARGS.reply('C0STAND01'))

    expect(result.isError).toBeUndefined()
    expect(h.clients.get('C0STAND01')!.calls.postMessage.map((c) => c.channel)).toEqual(['C0STAND01'])
  })
})

// ---------------------------------------------------------------------------
// Roots cwd → persona matching (real path)
// ---------------------------------------------------------------------------

describe('matchPersonaByRootsPath', () => {
  /** Personas A and B with real dirs, C with a nonexistent one; returns the roots path for a case. */
  function setup() {
    const missing = join(h.dir, 'missing-wd')
    const personaC: Persona = { ...h.beta, index: 2, name: 'Gamma Bot', key: 'gamma_bot', working_directory: missing }
    const personas = [h.alpha, h.beta, personaC]
    mkdirSync(join(h.alpha.working_directory, 'child'))
    symlinkSync(h.alpha.working_directory, join(h.dir, 'alpha-link'))
    mkdirSync(join(h.dir, 'unconfigured'))
    return { personas, missing, personaC }
  }

  test.each<[string, (s: ReturnType<typeof setup>) => string, 'alpha' | 'beta' | 'gamma' | 'none']>([
    ['the exact working directory', () => h.alpha.working_directory, 'alpha'],
    ['a symlink to the working directory', () => join(h.dir, 'alpha-link'), 'alpha'],
    ['a symlink with a trailing slash', () => `${join(h.dir, 'alpha-link')}/`, 'alpha'],
    ['a symlinked path with a `..` segment', () => `${join(h.dir, 'alpha-link')}/child/..`, 'alpha'],
    ['a nonexistent path, compared lexically', (s) => join(s.missing, 'sub', '..'), 'gamma'],
    ["another persona's working directory", () => h.beta.working_directory, 'beta'],
    ['an unconfigured directory', () => join(h.dir, 'unconfigured'), 'none'],
  ])('%s', (_label, rootsPath, expected) => {
    const s = setup()
    const logs: string[] = []
    const matched = matchPersonaByRootsPath(rootsPath(s), s.personas, { log: (l) => logs.push(l) })
    const want = { alpha: h.alpha, beta: h.beta, gamma: s.personaC, none: undefined }[expected]

    expect(matched?.key).toBe(want?.key)
    expect(logs).toEqual([])
  })

  test('two personas sharing one real path (one via a symlink) match nothing and log exactly one line', () => {
    const link = join(h.dir, 'alpha-link')
    symlinkSync(h.alpha.working_directory, link)
    const twin: Persona = { ...h.beta, working_directory: link }
    const logs: string[] = []

    const matched = matchPersonaByRootsPath(h.alpha.working_directory, [h.alpha, twin], { log: (l) => logs.push(l) })

    expect(matched).toBeUndefined()
    expect(logs).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// Not-up personas: admission and session drop (b.av2 SR-6.3, SR-6.4)
//
// The admission decision and the drop run through their real imports. The
// refusal of a registration is checked here with a stubbed up query and cause;
// the other cases use the server's composition: the real bring-up controller on
// the real connection manager (stub Slack, fake clock), `createPersonaUpPredicate`
// over both as the up query (its truth table is in
// tests/persona-relaunch-gate.test.ts), `describePersonaNotUp` of the controller's state for
// the refusal line, and `createNotUpSessionDropper` over `dropPersonaSession` as
// the controller's `onLeftUp`. Each not-up cause through the real start pass, and
// a running persona's reopen (refused, in flight, retrying or succeeding), are in
// tests/persona-connections.test.ts (`bring-up outcomes (E5)`). What
// handleInitialized does with a refusal is `closePendingSession` (tested in
// `pending sessions` above); server.ts's call of it is pinned in
// tests/server-startup-wiring.test.ts.
// ---------------------------------------------------------------------------

describe('not-up personas: MCP session admission and drop (b.av2 SR-6.3, SR-6.4)', () => {
  interface Started {
    c: ConnectionHarness
    alpha: Persona
    beta: Persona
    controller: PersonaBringUpController
    /** Keys the controller launched after a retry. */
    launches: string[]
    /** `decideSessionAdmission` as handleInitialized calls it. */
    admit: (rootsPath: string) => SessionAdmission
  }

  interface StartOptions {
    dryRun?: boolean
    stubOptions?: Readonly<Record<string, StubSlackOptions>>
    /** Breaks Alpha Bot after its files are written and before any bring-up. */
    breakAlpha?: (alpha: Persona) => void
  }

  let started: Started[] = []

  afterEach(async () => {
    for (const s of started) s.controller.cancelAll()
    await Promise.all(started.map((s) => s.c.manager.stopAll()))
    for (const s of started) {
      expect(s.c.clock.pendingCount()).toBe(0)
      assertNoLeak({ managerLines: s.c.lines }, 'registry.test not-up harness')
    }
    started = []
  })

  /** Alpha Bot and Beta Bot brought up (steps 1–3) through the server's wiring; see the block comment. */
  async function start(opts: StartOptions = {}): Promise<Started> {
    const c = makeConnectionHarness([{ name: 'Alpha Bot' }, { name: 'Beta Bot' }], join(h.dir, 'bring-up'), {
      files: true,
      dryRun: opts.dryRun,
      stubOptions: opts.stubOptions,
    })
    const [alpha, beta] = c.personas as [Persona, Persona]
    opts.breakAlpha?.(alpha)
    const log = (line: string) => void h.lines.push(line)
    const launches: string[] = []
    const controller = createPersonaBringUpController({
      connections: c.manager,
      dryRun: opts.dryRun ?? false,
      log,
      clock: c.clock,
      launch: async (persona) => void launches.push(persona.key),
      onLeftUp: createNotUpSessionDropper({ drop: dropPersonaSession, log }),
    })
    c.onStatus = (key, status) => controller.onConnectionStatus(key, status)
    const isPersonaUp = createPersonaUpPredicate(c.manager, controller)
    const admit = (rootsPath: string) =>
      decideSessionAdmission(rootsPath, c.personas, {
        isPersonaUp,
        describeNotUp: (key) => describePersonaNotUp(controller.state(key)),
        log,
      })
    const s: Started = { c, alpha, beta, controller, launches, admit }
    started.push(s)
    for (const persona of c.personas) await controller.bringUp(persona, c.personas)
    return s
  }

  /** A pending session with a stub entry, as initPendingSession creates it. */
  function pendingFor(id: string) {
    const stub = makePendingStub()
    const transport = makeTransport(id)
    const pending = createPendingSession(id, transport, makeServer(), stub)
    return { pending, stub, transport }
  }

  /** handleInitialized's admitted branch: promote the pending session and map its MCP session ID. */
  function promote(p: Persona, pendingId: string): SessionEntry {
    const entry = registerSession(realpathSync(p.working_directory), p.key, pendingId)
    registerMcpSessionId(pendingId, p.key)
    return entry
  }

  /** A registered session for `p` under MCP session ID `id`. */
  function registered(p: Persona, id: string, onClose?: () => void): SessionEntry {
    const entry = registerSession(p.working_directory, p.key, makeTransport(id, onClose), makeServer())
    registerMcpSessionId(id, p.key)
    return entry
  }

  function refusedLine(p: Persona, why: string): string {
    return `[slack] Session refused: persona ${renderPersonaRef(p.name, p.key)} is not up (${why}) — not registered; its instance is kept and may register once the persona is up`
  }

  const rmDir = (a: Persona) => rmSync(a.working_directory, { recursive: true, force: true })

  test("a not-up persona's session is refused with exactly one line naming it and its cause; its older registered session is kept and the pending one is neither promoted nor mapped; an up persona is admitted with no line", () => {
    const existing = registered(h.alpha, 'mcp-alpha-old')
    const { pending, stub, transport } = pendingFor('mcp-alpha-new')
    const lines: string[] = []
    const decide = (p: Persona) =>
      decideSessionAdmission(p.working_directory, [h.alpha, h.beta], {
        isPersonaUp: (key) => key === h.beta.key,
        describeNotUp: (key) => `broken: the cause for ${key}`,
        log: (line) => void lines.push(line),
      })

    expect(decide(h.alpha)).toEqual({ kind: 'not-up', persona: h.alpha })
    expect(lines).toEqual([refusedLine(h.alpha, `broken: the cause for ${h.alpha.key}`)])
    // The decision acts on nothing: the older session stays registered and
    // routed, and the refused one is neither promoted nor mapped.
    expect(getSessionByPersona(h.alpha.key)).toBe(existing)
    expect(existing.connected).toBe(true)
    expect(existing.transport).not.toBe(transport)
    expect((existing.transport as any).closeCalls).toBe(0)
    expect(routed('mcp-alpha-old')).toBe(existing)
    expect(routed('mcp-alpha-new')).toBe(pending)
    expect(stub.personaKey).toBe('')

    expect(decide(h.beta)).toEqual({ kind: 'admitted', persona: h.beta })
    expect(lines).toHaveLength(1)
    assertNoLeak({ lines })
  })

  test('a persona still serving on its connection whose bring-up outcome is unknown to the controller (cancelled) is refused', async () => {
    const s = await start()
    s.controller.cancel(s.alpha.key)
    expect(s.c.manager.status(s.alpha.key)?.state).toBe('up')
    const linesBefore = h.lines.length

    expect(s.admit(s.alpha.working_directory)).toEqual({ kind: 'not-up', persona: s.alpha })
    expect(h.lines.slice(linesBefore)).toEqual([refusedLine(s.alpha, 'its bring-up has not run')])
    expect(s.admit(s.beta.working_directory)).toEqual({ kind: 'admitted', persona: s.beta })
  })

  test('directory-broken: a roots path under the missing working directory cannot be resolved; it maps to that persona only, is refused and nothing throws', async () => {
    const s = await start({ breakAlpha: rmDir })
    const wd = s.alpha.working_directory

    for (const rootsPath of [wd, `${wd}/`, join(wd, 'gone', '..')]) {
      let admission: SessionAdmission | undefined
      expect(() => {
        admission = s.admit(rootsPath)
      }).not.toThrow()
      expect(admission).toEqual({ kind: 'not-up', persona: s.alpha })
    }
    expect(getSessionByPersona(s.alpha.key)).toBeUndefined()
    expect(getSessionByPersona(s.beta.key)).toBeUndefined()
  })

  test('a healthy persona beside a not-up one is admitted, promoted in place and replaced by a newer session exactly as before', async () => {
    const s = await start({ breakAlpha: (a) => rmSync(a.credentials_file) })
    const first = pendingFor('mcp-beta-1')
    expect(s.admit(s.beta.working_directory)).toEqual({ kind: 'admitted', persona: s.beta })
    expect(promote(s.beta, 'mcp-beta-1')).toBe(first.stub)

    const second = pendingFor('mcp-beta-2')
    expect(s.admit(s.beta.working_directory)).toEqual({ kind: 'admitted', persona: s.beta })
    expect(promote(s.beta, 'mcp-beta-2')).toBe(second.stub)

    expect(getSessionByPersona(s.beta.key)).toBe(second.stub)
    expect(first.stub.connected).toBe(false)
    expect(unregisterByMcpSessionId('mcp-beta-1')).toBeUndefined()
    expect(routed('mcp-beta-2')).toBe(second.stub)
    expect(getSessionByPersona(s.alpha.key)).toBeUndefined()
  })

  // The directory-broken counterpart (with the surviving row reused) is in
  // tests/persona-connections.test.ts's surviving-instance cases.
  test('a persona refused while Slack is unreachable comes up on its own retry timer once Slack answers, and its next registration is admitted, with no restart', async () => {
    const s = await start({ stubOptions: { 'Alpha Bot': { authTest: [{ kind: 'network' }] } } })
    expect(s.admit(s.alpha.working_directory).kind).toBe('not-up')

    await s.c.clock.advance(5_000)

    expect(s.controller.state(s.alpha.key)?.outcome).toBe('up')
    expect(s.launches).toEqual([s.alpha.key])
    const { stub } = pendingFor('mcp-alpha')
    expect(s.admit(s.alpha.working_directory)).toEqual({ kind: 'admitted', persona: s.alpha })
    expect(promote(s.alpha, 'mcp-alpha')).toBe(stub)
    expect(routed('mcp-alpha')).toBe(stub)
  })

  test('dry run: an up persona is admitted and a directory-broken one is refused', async () => {
    const s = await start({ dryRun: true, breakAlpha: rmDir })

    expect(s.admit(s.alpha.working_directory)).toEqual({ kind: 'not-up', persona: s.alpha })
    expect(s.admit(s.beta.working_directory)).toEqual({ kind: 'admitted', persona: s.beta })
  })

  // -------------------------------------------------------------------------
  // dropPersonaSession and the controller's leaving-up notification
  // -------------------------------------------------------------------------

  test("dropPersonaSession removes A's entry and every MCP session ID mapped to A before closing A's transport, so the close finds nothing to restart; B is untouched", async () => {
    const atClose: unknown[] = []
    registered(h.alpha, 'mcp-alpha-old')
    const a = registered(h.alpha, 'mcp-alpha', () => {
      // What onsessionclosed and the SSE abort would see at this moment.
      atClose.push(getSessionByPersona(h.alpha.key), routed('mcp-alpha'), a.connected, unregisterByMcpSessionId('mcp-alpha'))
    })
    const b = registered(h.beta, 'mcp-beta')

    expect(await dropPersonaSession(h.alpha.key)).toBe(true)

    expect(atClose).toEqual([undefined, undefined, false, undefined])
    expect((a.transport as any).closeCalls).toBe(1)
    expect(getSessionByPersona(h.alpha.key)).toBeUndefined()
    expect(routed('mcp-alpha-old')).toBeUndefined()
    expect(getSessionByPersona(h.beta.key)).toBe(b)
    expect(b.connected).toBe(true)
    expect((b.transport as any).closeCalls).toBe(0)
    expect(routed('mcp-beta')).toBe(b)
  })

  test('dropPersonaSession for a persona with no registered session does nothing and resolves false', async () => {
    const b = registered(h.beta, 'mcp-beta')

    expect(await dropPersonaSession(h.alpha.key)).toBe(false)

    expect(getSessionByPersona(h.beta.key)).toBe(b)
    expect(b.connected).toBe(true)
    expect((b.transport as any).closeCalls).toBe(0)
    expect(routed('mcp-beta')).toBe(b)
  })

  test("after A's session is dropped, a new session from A's working directory is refused while A is not up and admitted once the up query reports A up", async () => {
    registered(h.alpha, 'mcp-alpha')
    await dropPersonaSession(h.alpha.key)
    let up = false
    const decide = () => decideSessionAdmission(h.alpha.working_directory, [h.alpha, h.beta], { isPersonaUp: () => up })

    expect(decide()).toEqual({ kind: 'not-up', persona: h.alpha })
    // Without describeNotUp or log: the line has no cause and goes to console.error.
    expect(h.lines.filter((l) => l.startsWith('[slack] Session refused'))).toEqual([
      `[slack] Session refused: persona ${renderPersonaRef(h.alpha.name, h.alpha.key)} is not up — not registered; its instance is kept and may register once the persona is up`,
    ])
    up = true
    expect(decide()).toEqual({ kind: 'admitted', persona: h.alpha })
  })

  test('a persona that stops being up with no registered session drops nothing and logs no drop line', async () => {
    const s = await start()
    const b = registered(s.beta, 'mcp-beta')
    s.c.stub(s.alpha).script.connect.push({ kind: 'platform', error: 'token_revoked' })

    s.c.stub(s.alpha).socket.drop()
    await s.c.clock.flush()

    expect(s.controller.state(s.alpha.key)?.outcome).toBe('broken')
    expect(h.lines.filter((l) => l.includes('MCP session dropped'))).toEqual([])
    expect(getSessionByPersona(s.beta.key)).toBe(b)
    expect((b.transport as any).closeCalls).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// Posting scope
// ---------------------------------------------------------------------------

describe('checkPersonaTarget', () => {
  const D = 'D0DIRECT1'
  const U = 'U0USER001'
  const W = 'W0USER002'
  /** An allowed target's kind, or the reason for its refusal. */
  type Expected = 'channel' | 'dm' | 'user' | { why: string }

  function expectedCheck(persona: Persona, target: string, expected: Expected): PersonaTargetCheck {
    return typeof expected === 'string'
      ? { allowed: true, kind: expected }
      : { allowed: false, message: refusal(persona, target, expected.why) }
  }

  // Persona A (channels A_ALL and A_MENTIONS) with its DMs switch at `dms`.
  // A refusal names A and the target (the full message, so the reason is pinned too).
  test.each<[string, string, boolean, PersonaTargetAction, Expected]>([
    ['a configured `all` channel, DMs off', A_ALL, false, 'act', 'channel'],
    ['a configured `mentions` channel, DMs on', A_MENTIONS, true, 'post', 'channel'],
    ["another persona's channel, DMs on", B_CHANNEL, true, 'post', { why: WHY.channel }],
    ['an unconfigured channel, DMs off', UNCONFIGURED, false, 'post', { why: WHY.channel }],
    ['an unconfigured channel, DMs on', UNCONFIGURED, true, 'act', { why: WHY.channel }],
    ['a D… conversation, DMs on, post', D, true, 'post', 'dm'],
    ['a D… conversation, DMs on, act', D, true, 'act', 'dm'],
    ['a D… conversation, DMs off, post', D, false, 'post', { why: WHY.dmsOff }],
    ['a D… conversation, DMs off, act', D, false, 'act', { why: WHY.dmsOff }],
    ['a U… user ID, DMs on, post (open the DM first)', U, true, 'post', 'user'],
    ['a W… user ID, DMs on, post (open the DM first)', W, true, 'post', 'user'],
    ['a U… user ID, DMs off, post', U, false, 'post', { why: WHY.dmsOff }],
    ['a U… user ID, DMs on, act', U, true, 'act', { why: WHY.userId }],
    // DMs off, a user ID gets the DMs-off reason on every tool (never steered to a D… that is refused too).
    ['a W… user ID, DMs off, act', W, false, 'act', { why: WHY.dmsOff }],
    // A comma-separated user list would open a group DM; the anchored user-ID pattern refuses it.
    ['a comma-separated user list, DMs on, post', 'U0USER001,U0USER003', true, 'post', { why: WHY.channel }],
    ['a D… ID with trailing junk, DMs on', 'D0DIRECT1,C0NOPE001', true, 'act', { why: WHY.channel }],
    ['a G… group DM, DMs on', 'G0GROUP01', true, 'post', { why: WHY.channel }],
    ['a lower-case d… ID, DMs on', 'd0direct1', true, 'post', { why: WHY.channel }],
    ['an empty value, DMs on', '', true, 'post', { why: WHY.channel }],
  ])('%s', (_label, target, dms, action, expected) => {
    const persona = applyPersona(h.alpha, dms)

    const check = checkPersonaTarget(persona, target, action)

    expect(check).toEqual(expectedCheck(persona, target, expected))
  })
})

describe('tool posting scope (through the MCP server)', () => {
  test.each(TOOLS.flatMap((tool) => [A_ALL, A_MENTIONS].map((target) => [tool, target] as const)))(
    "%s to A's channel %s passes and lands on A's client only",
    async (tool, target) => {
      const session = await openPersonaSession(h.alpha)

      const result = await session.call(tool, TOOL_ARGS[tool](target))

      expect(result.isError).toBeUndefined()
      const captured = stubOf(h.alpha).calls[TOOL_CAPTURE[tool]] as Array<{ channel?: string }>
      expect(captured.map((c) => c.channel)).toEqual([target])
      expect(slackCallCount(stubOf(h.beta))).toBe(0)
    },
  )

  // DM targets (D…, U…, W…) are in `DM targets` below. The DMs switch does not widen the channel scope.
  test.each(
    TOOLS.flatMap((tool) =>
      [B_CHANNEL, UNCONFIGURED, 'G0GROUP01'].flatMap((target) => (['off', 'on'] as const).map((dms) => [tool, target, dms] as const)),
    ),
  )(
    '%s to %s with DMs %s is refused with a tool error naming persona and target, and no Slack call',
    async (tool, target, dms) => {
      applyPersona(h.alpha, dms === 'on')
      const session = await openPersonaSession(h.alpha)

      const result = await session.call(tool, TOOL_ARGS[tool](target))

      expect(result.isError).toBe(true)
      expect(result.content[0]!.text).toBe(refusal(h.alpha, target))
      expectNoSlackCall()
    },
  )

  test('reply posts carry no username or icon override', async () => {
    const session = await openPersonaSession(h.alpha)

    await session.call('reply', { chat_id: A_ALL, text: 'hi', thread_ts: MSG_TS })

    expect(stubOf(h.alpha).calls.postMessage).toEqual([
      { channel: A_ALL, text: 'hi', thread_ts: MSG_TS, unfurl_links: false, unfurl_media: false },
    ])
    expect(Object.keys(stubOf(h.alpha).calls.postMessage[0]!)).toEqual(
      expect.not.arrayContaining(['username', 'icon_emoji', 'icon_url']),
    )
  })
})

// ---------------------------------------------------------------------------
// DM targets, gated by the persona's DMs switch (b.av2 SR-5.1)
// ---------------------------------------------------------------------------

describe('DM targets (through the MCP server)', () => {
  const D = 'D0DIRECT1'
  const U = 'U0USER001'
  const W = 'W0USER002'
  /** The persona's operator contact (`dm.contact`). */
  const OPERATOR = 'U0OPER001'
  /** The conversation a scripted `conversations.open` returns. */
  const OPENED = 'D0OPENED1'
  const ACT_TOOLS = TOOLS.filter((t) => t !== 'reply')
  const ref = () => renderPersonaRef(h.alpha.name, h.alpha.key)

  // With DMs off every D…/U…/W… target on every tool gets the DMs-off reason,
  // the operator's own contact ID included.
  test.each(TOOLS.flatMap((tool) => [D, OPERATOR, W].map((target) => [tool, target, WHY.dmsOff] as const)))(
    'AC 36: DMs off, %s to %s is refused with a tool error naming persona and target, and no Slack call on any client',
    async (tool, target, why) => {
      const persona = applyPersona(h.alpha, false, { dm: { enabled: false, contact: OPERATOR } })
      expect(persona.dm).toEqual({ enabled: false, contact: OPERATOR })
      const session = await openPersonaSession(h.alpha)

      const result = await session.call(tool, TOOL_ARGS[tool](target))

      expect(result.isError).toBe(true)
      expect(result.content[0]!.text).toBe(refusal(h.alpha, target, why))
      expectNoSlackCall()
    },
  )

  test("AC 37: DMs on, a reply in the delivered DM posts there through the persona's own client and removes its ack there", async () => {
    applyPersona(h.alpha, true)
    trackAck(D, MSG_TS)
    const session = await openPersonaSession(h.alpha)

    const result = await session.call('reply', { chat_id: D, text: 'hi', message_id: MSG_TS })

    expect(result.isError).toBeUndefined()
    expect(result.content[0]!.text).toStartWith(`Sent 1 message(s) to ${D} [ts: `)
    expect(stubOf(h.alpha).callLog).toEqual([
      { method: 'chat.postMessage', args: { channel: D, text: 'hi', thread_ts: undefined, unfurl_links: false, unfurl_media: false } },
      { method: 'reactions.remove', args: { channel: D, timestamp: MSG_TS, name: 'eyes' } },
    ])
    expect(stubOf(h.beta).callLog).toEqual([])
  })

  // The ack is tracked on the opened conversation in both rows; only the row
  // that passes message_id removes it, there, after the post.
  test.each<[string, string, Record<string, unknown>, StubWebCall[]]>([
    [U, 'no message_id', {}, []],
    [
      W,
      'with message_id, removing the ack in the opened DM',
      { message_id: MSG_TS },
      [{ method: 'reactions.remove', args: { channel: OPENED, timestamp: MSG_TS, name: 'eyes' } }],
    ],
  ])(
    "AC 38: DMs on, a reply to user %s (%s) opens the DM on the persona's own client, then posts to the returned conversation",
    async (user, _label, extraArgs, afterPost) => {
      applyPersona(h.alpha, true)
      stubOf(h.alpha).script.open.push(openedDm(OPENED))
      trackAck(OPENED, MSG_TS)
      const session = await openPersonaSession(h.alpha)

      const result = await session.call('reply', { chat_id: user, text: 'hello there', ...extraArgs })

      expect(result.isError).toBeUndefined()
      expect(result.content[0]!.text).toStartWith(`Sent 1 message(s) to ${OPENED} (the DM with ${user}) [ts: `)
      // The persona's own Web client's log (the one `clientFor` hands the tools).
      expect(stubOf(h.alpha).web.callLog).toEqual([
        { method: 'conversations.open', args: { users: user } },
        {
          method: 'chat.postMessage',
          args: { channel: OPENED, text: 'hello there', thread_ts: undefined, unfurl_links: false, unfurl_media: false },
        },
        ...afterPost,
      ])
      expect(stubOf(h.beta).callLog).toEqual([])
    },
  )

  test('AC 38: a multi-chunk reply with a file to a user ID opens the DM once and sends every chunk and the file there', async () => {
    applyPersona(h.alpha, true)
    stubOf(h.alpha).script.open.push(openedDm(OPENED))
    const file = join(h.inboxDir, 'out.txt')
    writeFileSync(file, 'data')
    const deps: SessionToolDeps = { ...h.deps, getAccess: () => ({ ...h.deps.getAccess(), textChunkLimit: 5 }) }
    const session = await openSession(registerSession(h.alpha.working_directory, h.alpha.key, makeTransport(), makeServer()), deps)

    const result = await session.call('reply', { chat_id: U, text: 'one\ntwo\nthree', files: [file] })

    expect(result.isError).toBeUndefined()
    const log = stubOf(h.alpha).callLog
    expect(log.map((c) => c.method)).toEqual(['conversations.open', 'chat.postMessage', 'chat.postMessage', 'chat.postMessage', 'filesUploadV2'])
    expect(stubOf(h.alpha).calls.postMessage.map((c) => [c.channel, (c as { text?: string }).text])).toEqual([[OPENED, 'one'], [OPENED, 'two'], [OPENED, 'three']])
    expect(stubOf(h.alpha).calls.filesUploadV2).toEqual([{ channel_id: OPENED, file }] as any)
    expect(stubOf(h.beta).callLog).toEqual([])
  })

  test.each(ACT_TOOLS)("DMs on, %s on a D… conversation passes the scope check and acts there through the persona's client", async (tool) => {
    applyPersona(h.alpha, true)
    const session = await openPersonaSession(h.alpha)

    const result = await session.call(tool, TOOL_ARGS[tool](D))

    expect(result.isError).toBeUndefined()
    const captured = stubOf(h.alpha).calls[TOOL_CAPTURE[tool]] as Array<{ channel?: string }>
    expect(captured.map((c) => c.channel)).toEqual([D])
    expect(stubOf(h.alpha).callLog.map((c) => c.method)).not.toContain('conversations.open')
    expect(stubOf(h.beta).callLog).toEqual([])
  })

  test.each(ACT_TOOLS)(
    'DMs on, %s given a user ID is refused with a tool error and no Slack call (no conversations.open)',
    async (tool) => {
      applyPersona(h.alpha, true)
      const session = await openPersonaSession(h.alpha)

      const result = await session.call(tool, TOOL_ARGS[tool](U))

      expect(result.isError).toBe(true)
      expect(result.content[0]!.text).toBe(refusal(h.alpha, U, WHY.userId))
      expectNoSlackCall()
    },
  )

  test.each<[string, WebApiOutcome[], string]>([
    [
      'missing_scope (the im:write re-install hint)',
      [{ kind: 'platform', error: 'missing_scope' }],
      " (missing_scope). The persona's Slack app lacks the im:write scope; add it and re-install the app.",
    ],
    ['user_not_found', [{ kind: 'platform', error: 'user_not_found' }], ' (user_not_found).'],
    ['an answer with no conversation ID', [{ kind: 'ok', result: { channel: { id: '' } } }], ' (Slack returned no conversation ID).'],
  ])('DMs on, a reply to a user ID whose conversations.open fails with %s → tool error, nothing posted, token-safe', async (_label, open, tail) => {
    applyPersona(h.alpha, true)
    stubOf(h.alpha).script.open.push(...open)
    const session = await openPersonaSession(h.alpha)

    const result = await session.call('reply', { chat_id: U, text: 'hello' })

    expect(result.isError).toBe(true)
    expect(result.content[0]!.text).toBe(`Tool "reply" failed for persona ${ref()}: could not open a DM with "${U}"${tail}`)
    expect(stubOf(h.alpha).callLog.map((c) => c.method)).toEqual(['conversations.open'])
    expect(stubOf(h.beta).callLog).toEqual([])
    assertNoLeak({ result, lines: h.lines })
  })

  test('DMs on, a reply to a user ID whose post fails after the open → tool error naming the user and the opened conversation, no retry, token-safe', async () => {
    applyPersona(h.alpha, true)
    stubOf(h.alpha).script.open.push(openedDm(OPENED))
    stubOf(h.alpha).script.post.push({ kind: 'platform', error: 'not_in_channel' })
    const session = await openPersonaSession(h.alpha)

    const result = await session.call('reply', TOOL_ARGS.reply(U))

    const failedFor = `Tool "reply" failed for persona ${ref()} on DM target "${U}" (conversation ${OPENED})`
    expect(result.isError).toBe(true)
    expect(result.content[0]!.text).toBe(`${failedFor}: the tool call failed (not_in_channel).`)
    expect(h.lines.filter((l) => l.startsWith(`[slack] ${failedFor}: `))).toHaveLength(1)
    expect(stubOf(h.alpha).callLog.map((c) => c.method)).toEqual(['conversations.open', 'chat.postMessage'])
    expect(stubOf(h.beta).callLog).toEqual([])
    assertNoLeak({ result, lines: h.lines })
  })

  test('DMs on, a reply to a user ID with a refused file (state directory, outside the inbox) → tool error before any Slack call (no conversations.open)', async () => {
    applyPersona(h.alpha, true)
    const file = join(h.stateDir, 'state.json')
    writeFileSync(file, '{}')
    const session = await openPersonaSession(h.alpha)

    const result = await session.call('reply', { chat_id: U, text: 'hello', files: [file] })

    expect(result.isError).toBe(true)
    expect(result.content[0]!.text).toBe(
      `Blocked: cannot send files from state directory (${h.stateDir}). Only files in inbox/ are sendable.`,
    )
    expectNoSlackCall()
  })

  test('DMs on, two replies to the same user open the DM twice (no cache) and post each time to the opened conversation', async () => {
    applyPersona(h.alpha, true)
    const session = await openPersonaSession(h.alpha)

    const first = await session.call('reply', TOOL_ARGS.reply(U))
    const second = await session.call('reply', TOOL_ARGS.reply(U))

    expect([first.isError, second.isError]).toEqual([undefined, undefined])
    expect(stubOf(h.alpha).callLog.map((c) => [c.method, c.args])).toEqual([
      ['conversations.open', { users: U }],
      ['chat.postMessage', expect.objectContaining({ channel: stubOpenedDmId(U) })],
      ['conversations.open', { users: U }],
      ['chat.postMessage', expect.objectContaining({ channel: stubOpenedDmId(U) })],
    ])
  })

  test('DMs on, a D… conversation Slack refuses (channel_not_found) → tool error naming the DM target, with no open fallback or retry', async () => {
    applyPersona(h.alpha, true)
    stubOf(h.alpha).script.post.push({ kind: 'platform', error: 'channel_not_found' })
    const session = await openPersonaSession(h.alpha)

    const result = await session.call('reply', TOOL_ARGS.reply(D))

    expect(result.isError).toBe(true)
    expect(result.content[0]!.text).toBe(
      `Tool "reply" failed for persona ${ref()} on DM target "${D}": the tool call failed (channel_not_found).`,
    )
    expect(stubOf(h.alpha).callLog.map((c) => c.method)).toEqual(['chat.postMessage'])
    assertNoLeak({ result, lines: h.lines })
  })

  test('AC 40 / AC 41 (registry leg): a zero-channel persona with DMs on answers its DM in place and is refused on any channel', async () => {
    const persona = applyPersona(h.alpha, true, { channels: [], permission_prompts: 'dm', dm: { enabled: true, contact: OPERATOR } })
    expect(persona.dm).toEqual({ enabled: true, contact: OPERATOR })
    const session = await openPersonaSession(h.alpha)

    const inDm = await session.call('reply', TOOL_ARGS.reply(D))
    const refused = await Promise.all([A_ALL, B_CHANNEL].map((c) => session.call('reply', TOOL_ARGS.reply(c))))

    expect(inDm.isError).toBeUndefined()
    expect(refused.map((r) => [r.isError, r.content[0]!.text])).toEqual([
      [true, refusal(h.alpha, A_ALL)],
      [true, refusal(h.alpha, B_CHANNEL)],
    ])
    expect(stubOf(h.alpha).callLog.map((c) => [c.method, (c.args as { channel?: string }).channel])).toEqual([['chat.postMessage', D]])
    expect(stubOf(h.beta).callLog).toEqual([])
  })

  test("dm.enabled is read at call time: turning A's DMs off between two replies to the same user refuses the second", async () => {
    applyPersona(h.alpha, true)
    const session = await openPersonaSession(h.alpha)
    const first = await session.call('reply', TOOL_ARGS.reply(U))

    applyPersona(h.alpha, false)
    const second = await session.call('reply', TOOL_ARGS.reply(U))

    expect(first.isError).toBeUndefined()
    expect(second.isError).toBe(true)
    expect(second.content[0]!.text).toBe(refusal(h.alpha, U, WHY.dmsOff))
    expect(stubOf(h.alpha).callLog.map((c) => [c.method, (c.args as { channel?: string }).channel])).toEqual([
      ['conversations.open', undefined],
      ['chat.postMessage', stubOpenedDmId(U)],
    ])
  })
})

describe('dry run (SLACK_DRY_RUN=1)', () => {
  beforeEach(() => {
    process.env['SLACK_DRY_RUN'] = '1'
  })

  test.each(TOOLS)('%s to a configured channel returns the dry-run result with no Slack call', async (tool) => {
    const session = await openPersonaSession(h.alpha)

    const result = await session.call(tool, TOOL_ARGS[tool](A_ALL))

    expect(result.isError).toBeUndefined()
    expect(result.content[0]!.text).toStartWith('[dry-run]')
    expect(totalSlackCalls()).toBe(0)
  })

  test.each(['D0DIRECT1', 'U0USER001'])('DMs off, a reply to %s is still refused (scope runs before dry run)', async (target) => {
    const session = await openPersonaSession(h.alpha)

    const result = await session.call('reply', TOOL_ARGS.reply(target))

    expect(result.isError).toBe(true)
    expect(result.content[0]!.text).toBe(refusal(h.alpha, target, WHY.dmsOff))
    expectNoSlackCall()
  })

  test.each([
    ['D0DIRECT1', '[dry-run] Would send message to D0DIRECT1'],
    ['U0USER001', '[dry-run] Would open a DM with U0USER001 and send message there'],
  ])('DMs on, a reply to %s returns the dry-run result and makes no Slack call (no conversations.open)', async (target, text) => {
    applyPersona(h.alpha, true)
    const session = await openPersonaSession(h.alpha)

    const result = await session.call('reply', TOOL_ARGS.reply(target))

    expect(result.isError).toBeUndefined()
    expect(result.content[0]!.text).toBe(text)
    expectNoSlackCall()
  })

  test.each(TOOLS)('%s to an unconfigured channel is still refused (scope runs before dry run)', async (tool) => {
    const session = await openPersonaSession(h.alpha)

    const result = await session.call(tool, TOOL_ARGS[tool](UNCONFIGURED))

    expect(result.isError).toBe(true)
    expect(result.content[0]!.text).toBe(refusal(h.alpha, UNCONFIGURED))
  })
})

// ---------------------------------------------------------------------------
// Call-time resolution and refusals
// ---------------------------------------------------------------------------

describe('call-time resolution', () => {
  test("swapping A's client between calls sends the second call through the new client", async () => {
    const session = await openPersonaSession(h.alpha)
    const first = stubOf(h.alpha)
    await session.call('reply', TOOL_ARGS.reply(A_ALL))

    const replacement = makeStubSlack({ token: fakeToken(BOT_TOKEN_PREFIX, 'alpha-2') })
    h.clients.set(h.alpha.key, replacement)
    await session.call('reply', TOOL_ARGS.reply(A_ALL))

    expect(first.calls.postMessage).toHaveLength(1)
    expect(replacement.calls.postMessage).toHaveLength(1)
  })

  test("changing A's channel list between calls to the same target changes the outcome", async () => {
    const session = await openPersonaSession(h.alpha)
    expect((await session.call('reply', TOOL_ARGS.reply(A_MENTIONS))).isError).toBeUndefined()

    h.personas.set(h.alpha.key, { ...h.alpha, channels: [{ id: A_ALL, delivery: 'all' }] })
    const second = await session.call('reply', TOOL_ARGS.reply(A_MENTIONS))

    expect(second.isError).toBe(true)
    expect(second.content[0]!.text).toBe(refusal(h.alpha, A_MENTIONS))
    expect(stubOf(h.alpha).calls.postMessage).toHaveLength(1)
  })

  test.each<[string, () => void, (p: Persona) => string]>([
    [
      'the persona lookup no longer returns the key',
      () => h.personas.delete(h.alpha.key),
      (p) => `Tool "reply" refused: persona key=${p.key} is not an applied persona.`,
    ],
    [
      'clientFor returns nothing for the persona',
      () => h.clients.delete(h.alpha.key),
      (p) => `Tool "reply" refused: the Slack client for persona ${renderPersonaRef(p.name, p.key)} is not available.`,
    ],
  ])('%s → tool error and no Slack call', async (_label, breakIt, message) => {
    const alphaStub = stubOf(h.alpha)
    const session = await openPersonaSession(h.alpha)
    breakIt()

    const result = await session.call('reply', TOOL_ARGS.reply(A_ALL))

    expect(result.isError).toBe(true)
    expect(result.content[0]!.text).toBe(message(h.alpha))
    expect(slackCallCount(alphaStub) + totalSlackCalls()).toBe(0)
  })

  test('download_attachment with no bot token on the client → tool error and no Slack call', async () => {
    h.clients.set(h.alpha.key, makeStubSlack({ token: '' }))
    const session = await openPersonaSession(h.alpha)

    const result = await session.call('download_attachment', TOOL_ARGS.download_attachment(A_ALL))

    expect(result.isError).toBe(true)
    expect(result.content[0]!.text).toBe(
      `Tool "download_attachment" refused: the Slack bot token for persona ${renderPersonaRef(h.alpha.name, h.alpha.key)} is not available.`,
    )
    expect(totalSlackCalls()).toBe(0)
  })
})

describe('Slack call failures', () => {
  test.each<[ToolName, 'post' | 'history' | 'replies', { kind: 'platform'; error: string } | { kind: 'network' }, string]>([
    ['reply', 'post', { kind: 'platform', error: 'not_in_channel' }, ' (not_in_channel)'],
    ['reply', 'post', { kind: 'network' }, ''],
    ['fetch_messages', 'history', { kind: 'platform', error: 'channel_not_found' }, ' (channel_not_found)'],
    ['download_attachment', 'replies', { kind: 'platform', error: 'missing_scope' }, ' (missing_scope)'],
  ])('%s with a failing %s (%o) → token-safe tool error', async (tool, queue, outcome, reason) => {
    stubOf(h.alpha).script[queue].push(outcome)
    const session = await openPersonaSession(h.alpha)

    const result = await session.call(tool, TOOL_ARGS[tool](A_ALL))

    expect(result.isError).toBe(true)
    expect(result.content[0]!.text).toBe(
      `Tool "${tool}" failed for persona ${renderPersonaRef(h.alpha.name, h.alpha.key)}: the tool call failed${reason}.`,
    )
    assertNoLeak({ result, lines: h.lines })
  })
})

// ---------------------------------------------------------------------------
// download_attachment: the bearer token goes only to https://files.slack.com
// ---------------------------------------------------------------------------

describe('isSlackHostedFileUrl', () => {
  test.each<[string, unknown, boolean]>([
    ['an https files.slack.com URL', 'https://files.slack.com/files-pri/T0-F0/a.txt', true],
    ['one with a query string', 'https://files.slack.com/files-pri/T0-F0/a.txt?pub_secret=x', true],
    ['an upper-case host', 'https://FILES.SLACK.COM/a.txt', true],
    ['the explicit default port', 'https://files.slack.com:443/a.txt', true],
    ['http:', 'http://files.slack.com/a.txt', false],
    ['a lookalike host (suffix)', 'https://files.slack.com.evil.example/a.txt', false],
    ['a lookalike host (prefix)', 'https://evilfiles.slack.com/a.txt', false],
    ['another Slack host', 'https://slack.com/a.txt', false],
    ['a third-party host naming files.slack.com in its path', 'https://evil.example/files.slack.com/a.txt', false],
    ['a non-default port', 'https://files.slack.com:8443/a.txt', false],
    ['userinfo (user and password)', 'https://u:p@files.slack.com/a.txt', false],
    ['userinfo (user only)', 'https://u@files.slack.com/a.txt', false],
    ['no scheme (unparseable)', 'files.slack.com/a.txt', false],
    ['free text (unparseable)', 'not a url', false],
    ['an empty string', '', false],
    ['undefined', undefined, false],
    ['null', null, false],
    ['a number', 42, false],
    ['a URL object', new URL('https://files.slack.com/a.txt'), false],
  ])('%s → %p', (_label, url, expected) => {
    expect(isSlackHostedFileUrl(url)).toBe(expected)
  })
})

describe('download_attachment', () => {
  const FILES = 'https://files.slack.com'
  /** A query string on every fixture URL; it must never reach a result or a log. */
  const QUERY = `?pub_secret=${LEAK_SENTINEL}`

  const outPath = (name: string) => join(h.inboxDir, `1700000000_000100_${name}`)
  const slackFile = (id: string, name: string) => ({ id, name, url_private_download: `${FILES}/files-pri/T0-${id}/${name}${QUERY}` })
  const redirect = (location?: string) => new Response(null, { status: 302, headers: location ? { Location: location } : {} })
  const ref = () => renderPersonaRef(h.alpha.name, h.alpha.key)
  const notHosted = (label: string) =>
    `Tool "download_attachment" refused: file ${label} is not hosted by Slack, so persona ${ref()}'s bot token is not sent for it (only https://files.slack.com is trusted).`
  const redirectRefusal = (label: string, why: string) =>
    `Tool "download_attachment" refused: file ${label} ${why}; persona ${ref()}'s bot token is only sent to https://files.slack.com.`
  const OFFSITE = 'redirected away from https://files.slack.com, so it is not hosted by Slack'

  /** Script the message's files on A's stub and call download_attachment on A's session. */
  async function download(files: Array<Record<string, unknown>>) {
    stubOf(h.alpha).script.replies.push({ kind: 'ok', result: { messages: [{ ts: MSG_TS, files }] } })
    const session = await openPersonaSession(h.alpha)
    return session.call('download_attachment', TOOL_ARGS.download_attachment(A_ALL))
  }

  /** Every fetch went to https://files.slack.com with A's bearer token and manual redirects. */
  function expectTokenOnlySentToSlackFiles() {
    for (const f of h.fetches) {
      expect(new URL(f.url).origin).toBe(FILES)
      expect(f.auth === `Bearer ${h.alphaToken}`).toBe(true)
      expect(f.redirect).toBe('manual')
    }
  }

  function expectNoUrlQuery(result: ToolResult) {
    expect(JSON.stringify({ result, lines: h.lines })).not.toContain('pub_secret')
  }

  test("sends A's bot token as the bearer to files.slack.com and writes only into the inbox", async () => {
    h.fetchHandler = () => new Response('file-body')

    const result = await download([slackFile('F0FILE001', 'report.txt')])

    expect(result.isError).toBeUndefined()
    expect(result.content[0]!.text).toBe(`Downloaded 1 file(s):\n${outPath('report.txt')}`)
    expect(h.fetches.map((f) => f.url)).toEqual([`${FILES}/files-pri/T0-F0FILE001/report.txt${QUERY}`])
    expectTokenOnlySentToSlackFiles()
    expect(readFileSync(outPath('report.txt'), 'utf-8')).toBe('file-body')
    expect(readdirSync(h.inboxDir)).toEqual(['1700000000_000100_report.txt'])
    expect(slackCallCount(stubOf(h.beta))).toBe(0)
    expectNoUrlQuery(result)
    assertNoLeak({ result, lines: h.lines, inbox: writtenFile(h.inboxDir) })
  })

  test.each<[string, Array<Record<string, unknown>>, string]>([
    ['an is_external file on a files.slack.com URL', [{ ...slackFile('F0EXT0001', 'e.txt'), is_external: true }], 'F0EXT0001'],
    ["a mode: 'external' file on a files.slack.com URL", [{ ...slackFile('F0EXT0002', 'e.txt'), mode: 'external' }], 'F0EXT0002'],
    ['an external file with no URL', [{ id: 'F0EXT0003', name: 'e.txt', is_external: true }], 'F0EXT0003'],
    [
      'a third-party URL (malformed file ID → labelled by position)',
      [{ id: 'not/an id', name: 'x.txt', url_private_download: `https://example.com/x.txt${QUERY}` }],
      '#1',
    ],
    [
      'a Slack-hosted file followed by a lookalike-host url_private',
      [slackFile('F0FILE001', 'a.txt'), { name: 'b.txt', url_private: `https://files.slack.com.evil.example/b.txt${QUERY}` }],
      '#2',
    ],
  ])('%s → the whole call is refused before any fetch', async (_label, files, label) => {
    h.fetchHandler = () => new Response('file-body')

    const result = await download(files)

    expect(result.isError).toBe(true)
    expect(result.content[0]!.text).toBe(notHosted(label))
    expect(h.fetches).toEqual([])
    expect(readdirSync(h.inboxDir)).toEqual([])
    expectNoUrlQuery(result)
  })

  test('a same-origin redirect is followed with the token and the file is downloaded', async () => {
    h.fetchHandler = (url) =>
      url.includes('/download/') ? new Response('file-body') : redirect('/files-pri/T0-F0FILE001/download/report.txt')

    const result = await download([slackFile('F0FILE001', 'report.txt')])

    expect(result.isError).toBeUndefined()
    expect(result.content[0]!.text).toBe(`Downloaded 1 file(s):\n${outPath('report.txt')}`)
    expect(h.fetches.map((f) => f.url)).toEqual([
      `${FILES}/files-pri/T0-F0FILE001/report.txt${QUERY}`,
      `${FILES}/files-pri/T0-F0FILE001/download/report.txt`,
    ])
    expectTokenOnlySentToSlackFiles()
    expect(readFileSync(outPath('report.txt'), 'utf-8')).toBe('file-body')
    expectNoUrlQuery(result)
  })

  test.each([
    ['another host', 'https://evil.example/report.txt'],
    ['a lookalike host', 'https://files.slack.com.evil.example/report.txt'],
    ['http: on the Slack host', 'http://files.slack.com/report.txt'],
    ['a non-default port on the Slack host', 'https://files.slack.com:8443/report.txt'],
  ])('a redirect to %s is refused and never fetched', async (_label, location) => {
    h.fetchHandler = () => redirect(location)

    const result = await download([slackFile('F0FILE001', 'report.txt')])

    expect(result.isError).toBe(true)
    expect(result.content[0]!.text).toBe(redirectRefusal('F0FILE001', OFFSITE))
    expect(h.fetches.map((f) => f.url)).toEqual([`${FILES}/files-pri/T0-F0FILE001/report.txt${QUERY}`])
    expectTokenOnlySentToSlackFiles()
    expect(readdirSync(h.inboxDir)).toEqual([])
    expectNoUrlQuery(result)
  })

  test.each([
    [3, true],
    [4, false],
  ])('%p same-origin redirects → downloaded=%p, after exactly 4 fetches', async (hops, downloaded) => {
    h.fetchHandler = (url) => {
      const n = Number(new URL(url).pathname.split('/').pop())
      return n < hops ? redirect(`/hop/${n + 1}`) : new Response('file-body')
    }

    const result = await download([{ id: 'F0FILE001', name: 'report.txt', url_private_download: `${FILES}/hop/0${QUERY}` }])

    expect(h.fetches).toHaveLength(4)
    expectTokenOnlySentToSlackFiles()
    if (downloaded) {
      expect(result.isError).toBeUndefined()
      expect(result.content[0]!.text).toBe(`Downloaded 1 file(s):\n${outPath('report.txt')}`)
    } else {
      expect(result.isError).toBe(true)
      expect(result.content[0]!.text).toBe(redirectRefusal('F0FILE001', 'redirected more than 3 times'))
      expect(readdirSync(h.inboxDir)).toEqual([])
    }
    expectNoUrlQuery(result)
  })

  test('a 3xx with no Location skips the file → "Failed to download any files."', async () => {
    h.fetchHandler = () => redirect()

    const result = await download([slackFile('F0FILE001', 'report.txt')])

    expect(result.isError).toBeUndefined()
    expect(result.content[0]!.text).toBe('Failed to download any files.')
    expect(h.fetches).toHaveLength(1)
    expectTokenOnlySentToSlackFiles()
    expect(readdirSync(h.inboxDir)).toEqual([])
  })

  test('a redirect refusal after an earlier file was written lists the already-downloaded path', async () => {
    h.fetchHandler = (url) => (url.includes('/b.txt') ? redirect('https://evil.example/b.txt') : new Response('a-body'))

    const result = await download([slackFile('F0FILE001', 'a.txt'), slackFile('F0FILE002', 'b.txt')])

    expect(result.isError).toBe(true)
    expect(result.content[0]!.text).toBe(
      `${redirectRefusal('F0FILE002', OFFSITE)} Already downloaded before this refusal:\n${outPath('a.txt')}`,
    )
    expect(h.fetches.map((f) => f.url)).toEqual([
      `${FILES}/files-pri/T0-F0FILE001/a.txt${QUERY}`,
      `${FILES}/files-pri/T0-F0FILE002/b.txt${QUERY}`,
    ])
    expectTokenOnlySentToSlackFiles()
    expect(readFileSync(outPath('a.txt'), 'utf-8')).toBe('a-body')
    expect(readdirSync(h.inboxDir)).toEqual(['1700000000_000100_a.txt'])
    expectNoUrlQuery(result)
  })

  test('a non-Slack failure (fetch network error) → the generic "tool call failed" wording, token-safe', async () => {
    h.fetchHandler = () => {
      throw new TypeError(`fetch failed ${LEAK_SENTINEL}`)
    }

    const result = await download([slackFile('F0FILE001', 'report.txt')])

    expect(result.isError).toBe(true)
    expect(result.content[0]!.text).toBe(`Tool "download_attachment" failed for persona ${ref()}: the tool call failed.`)
    expect(h.fetches).toHaveLength(1)
    expect(readdirSync(h.inboxDir)).toEqual([])
    expectNoUrlQuery(result)
    assertNoLeak({ result, lines: h.lines })
  })
})

// ---------------------------------------------------------------------------
// fetch_messages: persona-keyed user names, history and thread replies
// ---------------------------------------------------------------------------

describe('fetch_messages', () => {
  const M1 = { ts: '1700000000.000100', user: 'U1', text: 'first' }
  const M2 = { ts: '1700000000.000200', user: 'U2', text: 'second' }

  test.each<[string, Record<string, unknown>, 'history' | 'replies', typeof M1[], 'conversationsHistory' | 'conversationsReplies', Record<string, unknown>]>([
    ['conversations.history (newest first, returned oldest first)', {}, 'history', [M2, M1], 'conversationsHistory', { channel: A_ALL, limit: 20 }],
    ['conversations.replies for thread_ts', { thread_ts: MSG_TS }, 'replies', [M1, M2], 'conversationsReplies', { channel: A_ALL, ts: MSG_TS, limit: 20 }],
  ])("%s: names resolved through A's persona key", async (_label, extra, queue, messages, capture, callArgs) => {
    stubOf(h.alpha).script[queue].push({ kind: 'ok', result: { messages } })
    const resolved: Array<[string, string]> = []
    const deps: SessionToolDeps = {
      ...h.deps,
      resolveUserName: async (key, userId) => {
        resolved.push([key, userId])
        return `name-${userId}`
      },
    }
    const session = await openSession(registerSession(h.alpha.working_directory, h.alpha.key, makeTransport(), makeServer()), deps)

    const result = await session.call('fetch_messages', { channel: A_ALL, ...extra })

    expect(result.isError).toBeUndefined()
    expect(JSON.parse(result.content[0]!.text)).toEqual([
      { ts: M1.ts, user: 'name-U1', user_id: 'U1', text: 'first' },
      { ts: M2.ts, user: 'name-U2', user_id: 'U2', text: 'second' },
    ])
    expect(resolved).toEqual([[h.alpha.key, 'U1'], [h.alpha.key, 'U2']])
    const calls = stubOf(h.alpha).calls
    expect(calls[capture]).toEqual([callArgs] as any)
    expect(calls.conversationsHistory.length + calls.conversationsReplies.length).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// reply: file guard wiring and uploads
// ---------------------------------------------------------------------------

describe('reply files', () => {
  test('a credentials file is refused before any Slack call', async () => {
    const session = await openPersonaSession(h.alpha)

    const result = await session.call('reply', { chat_id: A_ALL, text: 'here', files: [h.credentialsFile] })

    expect(result.isError).toBe(true)
    expect(result.content[0]!.text).toBe(`Blocked: cannot send ${h.credentialsFile} — it is a persona credentials file.`)
    expect(totalSlackCalls()).toBe(0)
    assertNoLeak({ result, lines: h.lines })
  })

  test('a sendable file is uploaded through the persona client after the text', async () => {
    const file = join(h.inboxDir, 'out.txt')
    writeFileSync(file, 'data')
    const session = await openPersonaSession(h.alpha)

    const result = await session.call('reply', { chat_id: A_ALL, text: 'here', files: [file], thread_ts: MSG_TS })

    expect(result.isError).toBeUndefined()
    expect(stubOf(h.alpha).calls.postMessage).toHaveLength(1)
    expect(stubOf(h.alpha).calls.filesUploadV2).toEqual([{ channel_id: A_ALL, file, thread_ts: MSG_TS }] as any)
    expect(slackCallCount(stubOf(h.beta))).toBe(0)
    expect(existsSync(file)).toBe(true)
  })

  test('a symlink re-pointed at a credentials file while the text posts is refused at its upload', async () => {
    const plain = join(h.inboxDir, 'out.txt')
    writeFileSync(plain, 'data')
    const benign = join(h.inboxDir, 'benign.txt')
    writeFileSync(benign, 'benign')
    const link = join(h.inboxDir, 'link.txt')
    symlinkSync(benign, link)
    const stub = stubOf(h.alpha)
    const post = stub.web.chat.postMessage
    let postedTs = ''
    stub.web.chat.postMessage = (async (args: Parameters<typeof post>[0]) => {
      rmSync(link)
      symlinkSync(h.credentialsFile, link)
      const res = await post(args)
      postedTs = res.ts as string
      return res
    }) as typeof post
    const session = await openPersonaSession(h.alpha)

    const result = await session.call('reply', { chat_id: A_ALL, text: 'here', files: [plain, link] })

    expect(result.isError).toBe(true)
    expect(result.content[0]!.text).toBe(
      `Blocked: cannot send ${link} — it is a persona credentials file. ` +
        `The reply text was already posted (1 message(s) to ${A_ALL} [ts: ${postedTs}]); ` +
        '1 of 2 file(s) were uploaded before this refusal.',
    )
    expect(postedTs).not.toBe('')
    expect(stub.calls.postMessage).toHaveLength(1)
    expect(stub.calls.filesUploadV2).toEqual([{ channel_id: A_ALL, file: plain }] as any)
    assertNoLeak({ result, lines: h.lines })
  })
})

// ---------------------------------------------------------------------------
// Ack reaction removal
// ---------------------------------------------------------------------------

describe('reply — ack reaction removal', () => {
  test("a tracked ack is removed once, through the persona's client", async () => {
    trackAck(A_ALL, MSG_TS)
    const session = await openPersonaSession(h.alpha)

    await session.call('reply', { chat_id: A_ALL, text: 'first', message_id: MSG_TS })
    await session.call('reply', { chat_id: A_ALL, text: 'second', message_id: MSG_TS })

    expect(stubOf(h.alpha).calls.reactionsRemove).toEqual([{ channel: A_ALL, timestamp: MSG_TS, name: 'eyes' }])
    expect(slackCallCount(stubOf(h.beta))).toBe(0)
  })

  test('a failing reactions.remove does not fail the reply', async () => {
    trackAck(A_ALL, MSG_TS)
    stubOf(h.alpha).web.reactions.remove = async () => {
      throw new Error('reaction_not_found')
    }
    const session = await openPersonaSession(h.alpha)

    const result = await session.call('reply', { chat_id: A_ALL, text: 'hi', message_id: MSG_TS })

    expect(result.isError).toBeUndefined()
    expect(result.content[0]!.text).toStartWith('Sent 1 message(s)')
  })

  test.each([
    ['no ack tracked', false, { chat_id: A_ALL, text: 'hi', message_id: MSG_TS }],
    ['reply without message_id', true, { chat_id: A_ALL, text: 'hi' }],
  ])('%s → no reactions.remove call', async (_label, tracked, args) => {
    if (tracked) trackAck(A_ALL, MSG_TS)
    const session = await openPersonaSession(h.alpha)

    await session.call('reply', args)

    expect(stubOf(h.alpha).calls.reactionsRemove).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Tool list and MCP instructions
// ---------------------------------------------------------------------------

/**
 * Reload wording no MCP tool or instruction text may carry (b.av2 SR-8.8). The
 * same list as cli.test.ts's, kept local to each file on purpose.
 */
const RELOAD_TERMS: readonly (string | RegExp)[] = [/reload/i, 'config.json.apply', 'config.json.pending', '.apply', '.pending']

/** The listed reload terms found in `text`, as written in `RELOAD_TERMS`. */
function reloadTermsIn(text: string): string[] {
  return RELOAD_TERMS.filter((t) => (typeof t === 'string' ? text.includes(t) : t.test(text))).map(String)
}

describe('tool list and instructions', () => {
  test('lists exactly the five tools with their inputs and required inputs unchanged; no tool name, description or input schema text carries reload wording (AC 74)', async () => {
    const { client } = await openPersonaSession(h.alpha)

    const { tools } = await client.listTools()

    expect(
      Object.fromEntries(
        tools.map((t) => [t.name, { properties: Object.keys(t.inputSchema.properties ?? {}), required: t.inputSchema.required }]),
      ),
    ).toEqual({
      reply: { properties: ['chat_id', 'text', 'thread_ts', 'files', 'message_id'], required: ['chat_id', 'text'] },
      react: { properties: ['chat_id', 'message_id', 'emoji'], required: ['chat_id', 'message_id', 'emoji'] },
      edit_message: { properties: ['chat_id', 'message_id', 'text'], required: ['chat_id', 'message_id', 'text'] },
      fetch_messages: { properties: ['channel', 'limit', 'thread_ts'], required: ['channel'] },
      download_attachment: { properties: ['chat_id', 'message_id'], required: ['chat_id', 'message_id'] },
    })
    // b.av2 SR-8.8: the whole tool definition (name, description, every schema
    // property name and description), so a reload tool or hint can't slip in.
    expect(Object.fromEntries(tools.map((t) => [t.name, reloadTermsIn(JSON.stringify(t))]))).toEqual(
      Object.fromEntries(tools.map((t) => [t.name, []])),
    )
  })

  test.each(['reload', 'apply_config'])(
    'AC 74: calling a `%s` tool is refused as unknown, with no Slack call and nothing leaked',
    async (name) => {
      const { client } = await openPersonaSession(h.alpha)

      const outcome = await client.callTool({ name, arguments: { chat_id: A_ALL } }).then(
        (result) => ({ result: result as ToolResult, error: undefined as unknown }),
        (error: unknown) => ({ result: undefined, error }),
      )

      // The unknown-tool refusal itself, as a tool error or a protocol
      // not-found error; any other tool error (a hidden tool refusing) fails.
      if (outcome.error === undefined) {
        expect(outcome.result?.isError).toBe(true)
        expect(outcome.result?.content.map((c) => c.text)).toEqual([expect.stringMatching(/unknown tool/i)])
      } else {
        expect(String(outcome.error)).toMatch(/unknown tool|not found/i)
      }
      expectNoSlackCall()
      expect(h.fetches).toEqual([])
      assertNoLeak({ outcome, lines: h.lines })
    },
  )

  test('AC 74: instructions carry no reload wording', async () => {
    const { client } = await openPersonaSession(h.alpha)

    const instructions = client.getInstructions() ?? ''

    expect(instructions).toContain('chat_id')
    expect(reloadTermsIn(instructions)).toEqual([])
  })

  test('instructions carry no pairing or access-control wording and still say to pass chat_id back', async () => {
    const { client } = await openPersonaSession(h.alpha)

    const instructions = client.getInstructions() ?? ''

    expect(instructions).not.toMatch(/pairing|access\.json|\/slack-channel:access|allowlist/i)
    expect(instructions).toContain('Reply with the reply tool — pass chat_id back.')
  })

  // b.av2 SR-12: the tag attributes, the via values (channel and dm) and persona mentions.
  // Key tokens only, so harmless rewording does not break the case.
  test('instructions name chat_id, user_id, bot_id and via, list the channel and dm via values and say <@ID> reaches a user or persona', async () => {
    const { client } = await openPersonaSession(h.alpha)

    const instructions = client.getInstructions() ?? ''

    for (const token of ['chat_id', 'user_id', 'bot_id', 'via']) expect(instructions).toMatch(new RegExp(`\\b${token}\\b`))
    // The sentence that lists the via values, so a stray word elsewhere cannot satisfy it.
    const viaList = instructions.split('\n').find((line) => /^via\b/.test(line)) ?? ''
    for (const value of ['mention', 'broadcast', 'receive_all_shared', 'receive_all']) {
      expect(viaList).toMatch(new RegExp(`\\b${value} \\(`))
    }
    // E6: dm (a direct message to the persona) is a via value too.
    expect(viaList).toMatch(/\bdm \(/)
    expect(instructions).toMatch(/<@ID>[^\n]*mentions a Slack user or another persona/)
  })

  // b.av2 SR-5.1 / SR-12: the reply targets. Key phrases only.
  test('instructions name a DM conversation and a user ID as reply targets and say a persona with DMs off has no DM target', async () => {
    const { client } = await openPersonaSession(h.alpha)

    const instructions = client.getInstructions() ?? ''

    expect(instructions).toMatch(/DMs are on[^\n]*reply in a DM conversation[^\n]*\(a D\.\.\. chat_id\)/)
    expect(instructions).toMatch(/pass a user ID \(U\.\.\. or W\.\.\.\) as reply's chat_id/)
    expect(instructions).toMatch(/DMs are off, you have no DM target/)
  })

  test('instructions say a message without via is an injected prompt needing no reply unless it asks', async () => {
    const { client } = await openPersonaSession(h.alpha)

    const instructions = client.getInstructions() ?? ''

    expect(instructions).toMatch(/without via is an injected prompt/)
    expect(instructions).toMatch(/no reply unless it asks/)
  })
})
