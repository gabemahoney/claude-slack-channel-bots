/**
 * registry.test.ts — Persona-keyed MCP session registry and persona-scoped
 * Slack tools (b.av2 SR-6.3, SR-5.1, SR-5.2 wiring, SR-12 instructions part).
 *
 * Tools are driven through the real MCP server (`createSessionServer`) with an
 * in-memory MCP client. Each persona has its own `makeStubSlack` client, so a
 * case can show which persona's client a call landed on. Every path is under
 * the test's own `mkdtempSync` directory; no token literal appears here.
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
import type { WebClient } from '@slack/web-api'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import type { Persona } from '../src/config.ts'
import { assertSendable } from '../src/lib.ts'
import { renderPersonaRef } from '../src/persona-identity.ts'
import {
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
  _resetRegistry,
  type SessionEntry,
  type SessionToolDeps,
} from '../src/registry.ts'
import { trackAck, consumeAck, _resetAckTracker } from '../src/ack-tracker.ts'
import { makeMultiPersonaConfig, makeStandInPersonaConfig } from './test-helpers/persona-config.ts'
import { makeStubSlack, type StubSlack } from './test-helpers/slack-stub.ts'
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

/** Minimal stub for WebStandardStreamableHTTPServerTransport. */
function makeTransport(sessionId?: string): any {
  return { sessionId, handleRequest: () => {}, close: async () => {} }
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
    clientFor: (key) => clients.get(key)?.web as unknown as WebClient | undefined,
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

function refusal(p: Persona, target: string): string {
  return `Persona ${renderPersonaRef(p.name, p.key)} may not target ${JSON.stringify(target)}: it is not one of the persona's configured channels.`
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
// Posting scope
// ---------------------------------------------------------------------------

describe('checkPersonaTarget', () => {
  test.each([
    ['a configured `all` channel', A_ALL, true],
    ['a configured `mentions` channel', A_MENTIONS, true],
    ["another persona's channel", B_CHANNEL, false],
    ['an unconfigured channel', UNCONFIGURED, false],
    ['a D… conversation', 'D0DIRECT1', false],
    ['a U… user ID', 'U0USER001', false],
    ['an empty value', '', false],
  ])('%s → allowed=%p', (_label, target, allowed) => {
    const check = checkPersonaTarget(h.alpha, target)

    expect(check).toEqual(allowed ? { allowed: true } : { allowed: false, message: refusal(h.alpha, target) })
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

  test.each(TOOLS.flatMap((tool) => [B_CHANNEL, UNCONFIGURED, 'D0DIRECT1', 'U0USER001'].map((target) => [tool, target] as const)))(
    '%s to %s is refused with a tool error naming persona and target, and no Slack call',
    async (tool, target) => {
      const session = await openPersonaSession(h.alpha)

      const result = await session.call(tool, TOOL_ARGS[tool](target))

      expect(result.isError).toBe(true)
      expect(result.content[0]!.text).toBe(refusal(h.alpha, target))
      expect(totalSlackCalls()).toBe(0)
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

describe('tool list and instructions', () => {
  test('lists exactly the five tools with their inputs and required inputs unchanged', async () => {
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
  })

  test('instructions carry no pairing or access-control wording and still say to pass chat_id back', async () => {
    const { client } = await openPersonaSession(h.alpha)

    const instructions = client.getInstructions() ?? ''

    expect(instructions).not.toMatch(/pairing|access\.json|\/slack-channel:access|allowlist/i)
    expect(instructions).toContain('Reply with the reply tool — pass chat_id back.')
  })

  // b.av2 SR-12: the tag attributes, the channel via values and persona mentions.
  // Key tokens only, so harmless rewording does not break the case.
  test('instructions name chat_id, user_id, bot_id and via, list the channel via values and say <@ID> reaches a user or persona', async () => {
    const { client } = await openPersonaSession(h.alpha)

    const instructions = client.getInstructions() ?? ''

    for (const token of ['chat_id', 'user_id', 'bot_id', 'via']) expect(instructions).toMatch(new RegExp(`\\b${token}\\b`))
    // The sentence that lists the via values, so a stray word elsewhere cannot satisfy it.
    const viaList = instructions.split('\n').find((line) => /^via\b/.test(line)) ?? ''
    for (const value of ['mention', 'broadcast', 'receive_all_shared', 'receive_all']) {
      expect(viaList).toMatch(new RegExp(`\\b${value} \\(`))
    }
    // E6 adds dm as a via value and flips this expectation.
    expect(viaList).not.toMatch(/\bdm\b/)
    expect(instructions).toMatch(/<@ID>[^\n]*mentions a Slack user or another persona/)
  })

  test('instructions say a message without via is an injected prompt needing no reply unless it asks', async () => {
    const { client } = await openPersonaSession(h.alpha)

    const instructions = client.getInstructions() ?? ''

    expect(instructions).toMatch(/without via is an injected prompt/)
    expect(instructions).toMatch(/no reply unless it asks/)
  })
})
