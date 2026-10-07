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
 * Its held-directory block (b.jg5 SRJ-810, SRJ-1505) installs a real
 * old-life hold set in the session manager and gives the admission its
 * production held-directory query (`oldLifeHeldDirectory`): a session from a
 * held directory is refused as held, whichever persona names it, with one
 * line naming the directory and every held id, before any persona is
 * matched; a throwing query refuses as held.
 * The tool-list block also holds b.jg5 SRJ-511 (AC 47): no tool definition
 * and not the instructions a session receives name `clear-latch`.
 * Per channel mode (b.deo SRI-601, SRI-602, SRI-604, SRI-202): the harness's
 * mode seam (`h.mode`, read by `h.modeDeps.getChannelMode` at each call) and
 * a fungible-mode persona (`applyFungibleAlpha`) drive the posting scope per
 * mode, directly and through the MCP server, dry run included; the mode read
 * at each call; Slack's refusals as tool errors in fungible mode; the
 * declarative section never read in fungible mode, through the real loader
 * too; and one instructions text in both modes. `h.deps` binds no mode
 * reader, so every case that opens a session on it runs in declarative mode.
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
import {
  channelModeOf,
  DEFAULT_REPLY_CHUNK_LIMIT,
  DEFAULT_REPLY_CHUNK_MODE,
  loadPersonaConfig,
  MCP_SERVER_NAME,
  type ChannelEntry,
  type ChannelMode,
  type Persona,
  type ReplySettings,
} from '../src/config.ts'
import { assertSendable } from '../src/lib.ts'
import { personaInstanceId, renderPersonaRef } from '../src/persona-identity.ts'
import { describeThrownValue } from '../src/persona-connection-errors.ts'
import {
  createOldLifeHoldSet,
  OLD_LIFE_HOLD_CAUSE_APPLY_STEP_1,
  OLD_LIFE_HOLD_END_READ_ENDED,
  type OldLifeHold,
  type OldLifeHoldSet,
} from '../src/retired-keys.ts'
import { _resetOldLifeHolds, oldLifeHeldDirectory, setOldLifeHolds } from '../src/session-manager.ts'
import {
  createNotUpSessionDropper,
  createPersonaBringUpController,
  describePersonaNotUp,
  type PersonaBringUpController,
} from '../src/persona-bringup-controller.ts'
import { checkPersonaConfigDir } from '../src/persona-bringup.ts'
import { createPersonaUpPredicate } from '../src/persona-start.ts'
import {
  closePendingSession,
  decideSessionAdmission,
  dropPersonaSession,
  sessionHeldRefusalLine,
  type SessionAdmission,
  type SessionAdmissionOptions,
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
  FUNGIBLE_TARGET_REFUSAL,
  isSlackHostedFileUrl,
  MCP_INSTRUCTIONS,
  SET_CHANNEL_DELIVERY_TOOL,
  slackRefusalToolErrorText,
  type PersonaTargetAction,
  type PersonaTargetCheck,
  _resetRegistry,
  type SessionEntry,
  type SessionToolDeps,
} from '../src/registry.ts'
import { trackAck, consumeAck, _resetAckTracker } from '../src/ack-tracker.ts'
import {
  makeFungiblePersona,
  makeMultiPersonaConfig,
  makeStandInPersonaConfig,
  writeConfigFile,
  type PersonaSpec,
} from './test-helpers/persona-config.ts'
import {
  asWebClient,
  makeStubSlack,
  openedDm,
  stubOpenedDmId,
  type StubSlack,
  type StubSlackOptions,
  type StubSlackScript,
  type StubWebCall,
  type StubWebMethod,
  type WebApiOutcome,
} from './test-helpers/slack-stub.ts'
import { makeConnectionHarness, type ConnectionHarness } from './test-helpers/persona-connection-harness.ts'
import {
  BOT_TOKEN_PREFIX,
  LEAK_SENTINEL,
  REDACTED_SENTINEL_TAIL,
  assertNoLeak,
  fakeToken,
  sentinelInMessage,
  writeCredentialsFile,
  writtenFile,
} from './test-helpers/credentials.ts'
import { reloadTermsIn } from './test-helpers/reload-terms.ts'
import { clearLatchTermsIn } from './test-helpers/clear-latch-terms.ts'

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
  /** The session tool deps; no channel-mode reader is bound, so declarative mode. */
  deps: SessionToolDeps
  /** The channel mode `modeDeps.getChannelMode` returns at each call; set it between calls. */
  mode: ChannelMode
  /** `deps` with a channel-mode reader bound to `mode` (b.deo SRI-201, SRI-601). */
  modeDeps: SessionToolDeps
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

/**
 * The server-wide reply settings the harness's `getReplySettings` returns
 * (b.av2 SR-1.6): an ack reaction set, and the config's chunking defaults.
 */
const REPLY_SETTINGS: ReplySettings = {
  ack_reaction: 'eyes',
  reply_chunk_limit: DEFAULT_REPLY_CHUNK_LIMIT,
  reply_chunk_mode: DEFAULT_REPLY_CHUNK_MODE,
}

/**
 * The harness's session tool deps with `overrides` applied over
 * `REPLY_SETTINGS`. Pass `ack_reaction: undefined` for no reaction configured.
 */
function depsWithReplySettings(overrides: Partial<ReplySettings>): SessionToolDeps {
  const settings: ReplySettings = { ...REPLY_SETTINGS, ...overrides }
  return { ...h.deps, getReplySettings: () => settings }
}

/**
 * The bring-up controller's claude_config_dir check against a scratch home
 * `<base>/home` holding a real `.claude`, so no bring-up here depends on the
 * process home (a dangling `$HOME/.claude` would hold every persona).
 */
function configDirCheckUnder(base: string): (persona: Persona) => ReturnType<typeof checkPersonaConfigDir> {
  const home = join(base, 'home')
  mkdirSync(join(home, '.claude'), { recursive: true })
  return (persona) => checkPersonaConfigDir(persona, { home })
}

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
    getReplySettings: () => REPLY_SETTINGS,
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
  const harness: Harness = {
    dir, stateDir, inboxDir, credentialsFile, alpha, beta, personas, clients, alphaToken, deps,
    mode: 'declarative',
    modeDeps: { ...deps, getChannelMode: () => harness.mode },
    lines: [],
    results: [],
    fetches: [],
    fetchHandler: () => {
      throw new Error('unexpected fetch in registry.test.ts')
    },
  }
  return harness
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

/**
 * Alpha Bot as the loader resolves it in fungible mode (b.deo SRI-102), with
 * its DMs switch set to `on`: no `channels` and no top-level
 * `permission_prompts` in force, and its destination from `invited`. `spec`
 * sets further fields; its `channels` or `permission_prompts` stand for a
 * declarative section beside the fungible one, which fungible mode never
 * reads (b.deo SRI-202). Applied as the persona `getPersona` returns at the
 * next call, under Alpha's key, so its tools land on Alpha's stub.
 */
function applyFungibleAlpha(on: boolean, spec: PersonaSpec = {}): Persona {
  const config = makeMultiPersonaConfig(
    [{ name: h.alpha.name, invited: { permission_prompts: A_ALL }, ...spec, dm: { enabled: on } }],
    h.dir,
    { allow_invited_channels: true },
  )
  const persona = config.personas[0]!
  expect(persona.key).toBe(h.alpha.key)
  h.personas.set(persona.key, persona)
  return persona
}

/** Register persona `p`'s session and open a client on it whose deps read the mode seam (`h.mode`). */
function openModeSession(p: Persona) {
  return openSession(registerSession(p.working_directory, p.key, makeTransport(), makeServer()), h.modeDeps)
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
      checkConfigDir: configDirCheckUnder(join(h.dir, 'bring-up')),
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

  // -------------------------------------------------------------------------
  // A directory held for an old life (b.jg5 SRJ-810 bullet 1, SRJ-1505; AC 53)
  //
  // As main() wires it: one real hold set (`createOldLifeHoldSet`) installed
  // in the session manager (`setOldLifeHolds`), whose held-directory query
  // (`oldLifeHeldDirectory`) handleInitialized gives `decideSessionAdmission`
  // beside the real up predicate. Holds are begun on the set directly, as
  // apply step 1 and the start sweep begin them; how they begin and end is
  // tests/old-life-wait.test.ts's.
  // -------------------------------------------------------------------------

  describe('b.jg5 SRJ-810, SRJ-1505: a session opened from a directory held for an old life is registered as no persona\'s, whichever persona names it', () => {
    let holds: OldLifeHoldSet

    beforeEach(() => {
      holds = createOldLifeHoldSet({ log: (line) => void h.lines.push(line) })
      setOldLifeHolds(holds)
    })

    afterEach(() => {
      _resetOldLifeHolds()
    })

    /** Begin a hold on `instanceId` (old key `oldKey`) at `directory`, as apply step 1 does. */
    function hold(instanceId: string, oldKey: string, directory: string): OldLifeHold {
      return holds.begin({ instanceId, oldKey, directory, cause: OLD_LIFE_HOLD_CAUSE_APPLY_STEP_1 })
    }

    /** What the admission logged and answered for `rootsPath`, with the production query (or `heldDirectory`). */
    function admitHeld(
      s: Started,
      rootsPath: string,
      heldDirectory: SessionAdmissionOptions['heldDirectory'] = oldLifeHeldDirectory,
    ): { admission: SessionAdmission; lines: string[]; upAsked: string[] } {
      const lines: string[] = []
      const upAsked: string[] = []
      const isPersonaUp = createPersonaUpPredicate(s.c.manager, s.controller)
      const admission = decideSessionAdmission(rootsPath, s.c.personas, {
        isPersonaUp: (key) => {
          upAsked.push(key)
          return isPersonaUp(key)
        },
        describeNotUp: (key) => describePersonaNotUp(s.controller.state(key)),
        log: (line) => void lines.push(line),
        heldDirectory,
      })
      h.lines.push(...lines)
      return { admission, lines, upAsked }
    }

    /** The answer and the one line for a session from `directory`, held for `ids`. */
    function heldOutcome(directory: string, ids: readonly string[]): { admission: SessionAdmission; lines: string[] } {
      const real = realpathSync(directory)
      return { admission: { kind: 'held', directory: real, instanceIds: ids }, lines: [sessionHeldRefusalLine(real, ids)] }
    }

    /** The beta persona, in another directory and up, is still admitted with no line. */
    function expectBetaAdmitted(s: Started): void {
      const beta = admitHeld(s, s.beta.working_directory)
      expect(beta.admission).toEqual({ kind: 'admitted', persona: s.beta })
      expect(beta.lines).toEqual([])
    }

    test.each<{ label: string; up: boolean; held: (s: Started) => { id: string; oldKey: string; directory: string } }>([
      {
        label: "the old key's own persona, up, names D",
        up: true,
        held: (s) => ({ id: personaInstanceId(s.alpha.key), oldKey: s.alpha.key, directory: s.alpha.working_directory }),
      },
      {
        label: "the old key's own persona, not up (broken), names D",
        up: false,
        held: (s) => ({ id: personaInstanceId(s.alpha.key), oldKey: s.alpha.key, directory: s.alpha.working_directory }),
      },
      {
        label: 'a different persona, up, now names D (the old key is a retired one)',
        up: true,
        held: (s) => ({ id: personaInstanceId('retired_bot'), oldKey: 'retired_bot', directory: s.alpha.working_directory }),
      },
      {
        label: 'no persona names D',
        up: true,
        held: () => {
          const directory = join(h.dir, 'unconfigured-held')
          mkdirSync(directory)
          return { id: personaInstanceId('retired_bot'), oldKey: 'retired_bot', directory }
        },
      },
    ])('$label: refused as held with exactly one line naming D by its real path and the old instance id; no persona is asked whether it is up; beta, up in its own directory, is still admitted', async ({ up, held }) => {
      const s = await start(up ? {} : { breakAlpha: (a) => rmSync(a.credentials_file) })
      expect(s.controller.state(s.alpha.key)?.outcome).toBe(up ? 'up' : 'broken')
      const { id, oldKey, directory } = held(s)
      hold(id, oldKey, directory)

      const result = admitHeld(s, directory)

      expect({ admission: result.admission, lines: result.lines }).toEqual(heldOutcome(directory, [id]))
      expect(result.lines[0]).toContain(JSON.stringify(realpathSync(directory)))
      expect(result.lines[0]).toContain(JSON.stringify(id))
      // The held check comes before any persona is matched or asked whether it is up.
      expect(result.upAsked).toEqual([])
      expect(getSessionByPersona(s.alpha.key)).toBeUndefined()
      expectBetaAdmitted(s)
    })

    test('two holds on D (two old instance ids) refuse it with one line naming both ids, in begin order', async () => {
      const s = await start()
      const ids = [personaInstanceId(s.alpha.key), personaInstanceId('retired_bot')]
      hold(ids[0]!, s.alpha.key, s.alpha.working_directory)
      hold(ids[1]!, 'retired_bot', s.alpha.working_directory)

      const result = admitHeld(s, s.alpha.working_directory)

      expect({ admission: result.admission, lines: result.lines }).toEqual(heldOutcome(s.alpha.working_directory, ids))
      for (const id of ids) expect(result.lines[0]).toContain(JSON.stringify(id))
      expectBetaAdmitted(s)
    })

    test('D reached through a symlink, and a hold begun through a symlink with the session from D itself: both refused as held, naming D by its real path', async () => {
      const s = await start()
      const link = join(h.dir, 'alpha-link')
      symlinkSync(s.alpha.working_directory, link)
      const id = personaInstanceId(s.alpha.key)
      hold(id, s.alpha.key, s.alpha.working_directory)

      for (const rootsPath of [link, `${link}/`, join(link, 'child-gone', '..')]) {
        const result = admitHeld(s, rootsPath)
        expect({ admission: result.admission, lines: result.lines }).toEqual(heldOutcome(s.alpha.working_directory, [id]))
      }

      holds.end(id, OLD_LIFE_HOLD_END_READ_ENDED)
      const other = personaInstanceId('retired_bot')
      hold(other, 'retired_bot', link)
      const result = admitHeld(s, s.alpha.working_directory)
      expect({ admission: result.admission, lines: result.lines }).toEqual(heldOutcome(s.alpha.working_directory, [other]))
      expectBetaAdmitted(s)
    })

    test('a missing D compares by its lexical path: a session from it, with or without a trailing slash or a `..` segment, is refused as held, never as not up, and nothing throws', async () => {
      const s = await start({ breakAlpha: rmDir })
      const wd = s.alpha.working_directory
      expect(existsSync(wd)).toBe(false)
      const id = personaInstanceId(s.alpha.key)
      hold(id, s.alpha.key, wd)

      for (const rootsPath of [wd, `${wd}/`, join(wd, 'gone', '..')]) {
        let result: ReturnType<typeof admitHeld> | undefined
        expect(() => {
          result = admitHeld(s, rootsPath)
        }).not.toThrow()
        expect(result!.admission).toEqual({ kind: 'held', directory: wd, instanceIds: [id] })
        expect(result!.lines).toEqual([sessionHeldRefusalLine(wd, [id])])
      }
      expectBetaAdmitted(s)
    })

    test.each<{ label: string; up: boolean }>([
      { label: 'an up persona naming D is admitted with no line', up: true },
      { label: "a persona naming D that is not up is refused with today's not-up line", up: false },
    ])('once the hold ends, a session from D is decided as before: $label', async ({ up }) => {
      const s = await start(up ? {} : { breakAlpha: (a) => rmSync(a.credentials_file) })
      const id = personaInstanceId(s.alpha.key)
      hold(id, s.alpha.key, s.alpha.working_directory)
      expect(admitHeld(s, s.alpha.working_directory).admission.kind).toBe('held')

      holds.end(id, OLD_LIFE_HOLD_END_READ_ENDED)
      const result = admitHeld(s, s.alpha.working_directory)

      if (up) {
        expect(result.admission).toEqual({ kind: 'admitted', persona: s.alpha })
        expect(result.lines).toEqual([])
      } else {
        expect(result.admission).toEqual({ kind: 'not-up', persona: s.alpha })
        expect(result.lines).toEqual([refusedLine(s.alpha, describePersonaNotUp(s.controller.state(s.alpha.key)))])
      }
    })

    test('the held check comes before persona matching: two personas sharing D match nothing and the matcher would log a line, but a hold on D answers held with the one refusal line only', async () => {
      const s = await start()
      const link = join(h.dir, 'alpha-twin-link')
      symlinkSync(s.alpha.working_directory, link)
      const twin: Persona = { ...s.beta, working_directory: link }
      const personas = [s.alpha, twin]
      const id = personaInstanceId('retired_bot')
      const decide = () => {
        const lines: string[] = []
        const admission = decideSessionAdmission(s.alpha.working_directory, personas, {
          isPersonaUp: () => true,
          log: (line) => void lines.push(line),
          heldDirectory: oldLifeHeldDirectory,
        })
        h.lines.push(...lines)
        return { admission, lines }
      }
      // Not held yet: the matcher's ambiguity, one line of its own.
      const before = decide()
      expect(before.admission).toEqual({ kind: 'unmatched' })
      expect(before.lines).toHaveLength(1)

      hold(id, 'retired_bot', s.alpha.working_directory)

      expect(decide()).toEqual(heldOutcome(s.alpha.working_directory, [id]))
    })

    test('a held-directory query that throws refuses the session as held (fail safe), at its real path with no id, in one line naming what it threw; an up persona is not admitted', async () => {
      const s = await start()
      const failure = new Error('hold set unreadable')
      const result = admitHeld(s, s.alpha.working_directory, () => {
        throw failure
      })

      const real = realpathSync(s.alpha.working_directory)
      expect(result.admission).toEqual({ kind: 'held', directory: real, instanceIds: [] })
      expect(result.lines).toEqual([sessionHeldRefusalLine(real, [], describeThrownValue(failure))])
      expect(result.upAsked).toEqual([])
      expect(getSessionByPersona(s.alpha.key)).toBeUndefined()
    })

    test('the query is asked with the roots real path; an answer of undefined, or one naming no id, is not held, and the persona is decided as before', async () => {
      const s = await start()
      const link = join(h.dir, 'alpha-link')
      symlinkSync(s.alpha.working_directory, link)
      const asked: string[] = []
      const answers = [undefined, { directory: s.alpha.working_directory, instanceIds: [] }]
      for (const answer of answers) {
        const result = admitHeld(s, link, (path) => {
          asked.push(path)
          return answer
        })
        expect(result.admission).toEqual({ kind: 'admitted', persona: s.alpha })
        expect(result.lines).toEqual([])
      }
      expect(asked).toEqual([realpathSync(s.alpha.working_directory), realpathSync(s.alpha.working_directory)])
    })

    test('with no held-directory query given, a hold changes nothing: the decisions are as before', async () => {
      const s = await start({ breakAlpha: (a) => rmSync(a.credentials_file) })
      hold(personaInstanceId(s.alpha.key), s.alpha.key, s.alpha.working_directory)
      hold(personaInstanceId('retired_bot'), 'retired_bot', s.beta.working_directory)
      const linesBefore = h.lines.length

      expect(s.admit(s.alpha.working_directory)).toEqual({ kind: 'not-up', persona: s.alpha })
      expect(s.admit(s.beta.working_directory)).toEqual({ kind: 'admitted', persona: s.beta })
      expect(h.lines.slice(linesBefore)).toEqual([refusedLine(s.alpha, describePersonaNotUp(s.controller.state(s.alpha.key)))])
    })
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
    trackAck(h.alpha.key, D, MSG_TS)
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

  // Alpha's ack is tracked on the opened conversation in both rows; only the row
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
      trackAck(h.alpha.key, OPENED, MSG_TS)
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
    const deps = depsWithReplySettings({ reply_chunk_limit: 5 })
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
// Posting scope per channel mode (b.av2 SR-5.1; b.deo SRI-601, SRI-202)
//
// The mode comes through the harness's mode seam: `h.modeDeps` reads `h.mode`
// at each call. The target-refusal describes above open their sessions on `h.deps`,
// which binds no reader, and make three-argument `checkPersonaTarget` calls:
// they stay the proof for an absent mode.
// ---------------------------------------------------------------------------

const DM_CONV = 'D0DIRECT1'
const USER_U = 'U0USER001'
const USER_W = 'W0USER002'
const GROUP_DM = 'G0GROUP01'
const MALFORMED_ID = 'X0NOTANID'
/** The conversation a scripted `conversations.open` returns. */
const OPENED_DM = 'D0OPENED1'

/** An allowed target's kind, or the reason for its refusal. */
type ScopeExpected = 'channel' | 'dm' | 'user' | { why: string }

/** One target of the per-mode table, with its outcome for each DMs setting and action. */
interface ScopeRow {
  label: string
  target: string
  expected: (dms: boolean, action: PersonaTargetAction) => ScopeExpected
  /** A DM target (`D…` or a user ID): its outcome is the declarative one in fungible mode too. */
  dmTarget?: boolean
}

/** A `D…` conversation's outcome, the same in both modes (b.av2 SR-5.1). */
const dmConversationOutcome = (dms: boolean): ScopeExpected => (dms ? 'dm' : { why: WHY.dmsOff })

/** A user ID's outcome, the same in both modes (b.av2 SR-5.1). */
const userIdOutcome = (dms: boolean, action: PersonaTargetAction): ScopeExpected =>
  !dms ? { why: WHY.dmsOff } : action === 'post' ? 'user' : { why: WHY.userId }

const notListed = (): ScopeExpected => ({ why: WHY.channel })
const neitherChannelNorDm = (): ScopeExpected => ({ why: FUNGIBLE_TARGET_REFUSAL })
const anyChannel = (): ScopeExpected => 'channel'

/** SRI-601's six targets, decided by Alpha Bot's listed channels in declarative mode. */
const DECLARATIVE_SCOPE_ROWS: readonly ScopeRow[] = [
  { label: 'a listed channel', target: A_ALL, expected: anyChannel },
  { label: 'an unlisted C… channel', target: UNCONFIGURED, expected: notListed },
  { label: 'a G… ID', target: GROUP_DM, expected: notListed },
  { label: 'a malformed ID', target: MALFORMED_ID, expected: notListed },
  { label: 'a D… conversation', target: DM_CONV, expected: dmConversationOutcome, dmTarget: true },
  { label: 'a U… user ID', target: USER_U, expected: userIdOutcome, dmTarget: true },
]

/** Targets fungible mode refuses as neither a channel ID nor an allowed DM target (b.deo SRI-601). */
const FUNGIBLE_OTHER_TARGETS: ReadonlyArray<readonly [label: string, target: string]> = [
  ['a malformed ID', MALFORMED_ID],
  ['an empty value', ''],
  ['a lower-case ID', 'c0nope001'],
  ['a comma-separated list', `${UNCONFIGURED},${B_CHANNEL}`],
  ['a D… ID with trailing text', `${DM_CONV},${UNCONFIGURED}`],
]

/** SRI-601's six targets plus a `W…` user ID and the other refused shapes, in fungible mode. */
const FUNGIBLE_SCOPE_ROWS: readonly ScopeRow[] = [
  { label: 'a listed channel', target: A_ALL, expected: anyChannel },
  { label: 'an unlisted C… channel', target: UNCONFIGURED, expected: anyChannel },
  { label: 'a G… ID', target: GROUP_DM, expected: anyChannel },
  { label: 'a D… conversation', target: DM_CONV, expected: dmConversationOutcome, dmTarget: true },
  { label: 'a U… user ID', target: USER_U, expected: userIdOutcome, dmTarget: true },
  { label: 'a W… user ID', target: USER_W, expected: userIdOutcome, dmTarget: true },
  ...FUNGIBLE_OTHER_TARGETS.map(([label, target]): ScopeRow => ({ label, target, expected: neitherChannelNorDm })),
]

/** Each row × DMs off and on × `post` and `act`, in `mode`. */
function scopeCases(mode: ChannelMode, rows: readonly ScopeRow[]) {
  return rows.flatMap((row) =>
    [false, true].flatMap((dms) =>
      (['post', 'act'] as const).map((action) => ({ ...row, mode, dms, dmsLabel: dms ? 'on' : 'off', action })),
    ),
  )
}

/** The check `checkPersonaTarget` gives `persona` for `target` when the expected outcome is `expected`. */
function scopeCheck(persona: Persona, target: string, expected: ScopeExpected): PersonaTargetCheck {
  return typeof expected === 'string'
    ? { allowed: true, kind: expected }
    : { allowed: false, message: refusal(persona, target, expected.why) }
}

// b.av2 SR-5.1; b.deo SRI-601: the table over mode × target × dm.enabled ×
// action. Alpha Bot lists A_ALL and A_MENTIONS in both modes, so a fungible
// row's outcome shows the persona's list is not what decides there. Every
// refusal is checked by its full message.
describe('checkPersonaTarget per channel mode (b.av2 SR-5.1; b.deo SRI-601)', () => {
  test.each([...scopeCases('declarative', DECLARATIVE_SCOPE_ROWS), ...scopeCases('fungible', FUNGIBLE_SCOPE_ROWS)])(
    '$mode: $label, DMs $dmsLabel, $action',
    ({ mode, target, dms, action, expected, dmTarget }) => {
      const persona = applyPersona(h.alpha, dms)

      const check = checkPersonaTarget(persona, target, action, mode)

      expect(check).toEqual(scopeCheck(persona, target, expected(dms, action)))
      if (dmTarget && mode === 'fungible') expect(check).toEqual(checkPersonaTarget(persona, target, action, 'declarative'))
    },
  )

  // b.deo SRI-601 gives the fungible refusal's content, not its text: it says
  // the target is neither a channel ID nor an allowed DM target. `refusal`
  // pins the persona and the target around it.
  test('the fungible refusal says the target is neither a channel ID nor an allowed DM target', () => {
    expect(FUNGIBLE_TARGET_REFUSAL).toContain('neither a channel ID')
    expect(FUNGIBLE_TARGET_REFUSAL).toContain('nor an allowed DM target')
  })
})

// b.av2 SR-5.1; b.deo SRI-601: the five Slack tools of a fungible-mode
// persona, through the MCP server.
describe('tool posting scope in fungible mode (through the MCP server; b.av2 SR-5.1, b.deo SRI-601)', () => {
  const ACT_TOOLS = TOOLS.filter((t) => t !== 'reply')

  beforeEach(() => {
    h.mode = 'fungible'
  })

  test.each(TOOLS.flatMap((tool) => [UNCONFIGURED, GROUP_DM].map((target) => [tool, target] as const)))(
    "%s to the unlisted %s passes and lands on the persona's own client only",
    async (tool, target) => {
      applyFungibleAlpha(false)
      const session = await openModeSession(h.alpha)

      const result = await session.call(tool, TOOL_ARGS[tool](target))

      expect(result.isError).toBeUndefined()
      const captured = stubOf(h.alpha).calls[TOOL_CAPTURE[tool]] as Array<{ channel?: string }>
      expect(captured.map((c) => c.channel)).toEqual([target])
      expect(stubOf(h.alpha).callLog).toHaveLength(1)
      expect(stubOf(h.beta).callLog).toEqual([])
    },
  )

  test.each([
    ...TOOLS.flatMap((tool) =>
      FUNGIBLE_OTHER_TARGETS.map(([label, target]) => ({ tool, label, target, dms: true, why: FUNGIBLE_TARGET_REFUSAL as string })),
    ),
    ...TOOLS.flatMap((tool) => [
      { tool, label: 'a D… conversation, DMs off', target: DM_CONV, dms: false, why: WHY.dmsOff as string },
      { tool, label: 'a U… user ID, DMs off', target: USER_U, dms: false, why: WHY.dmsOff as string },
    ]),
    ...ACT_TOOLS.map((tool) => ({ tool, label: 'a W… user ID, DMs on', target: USER_W, dms: true, why: WHY.userId as string })),
  ])('$tool to $label is refused with a tool error naming persona and target, and no Slack call on any stub', async ({ tool, target, dms, why }) => {
    const persona = applyFungibleAlpha(dms)
    const session = await openModeSession(h.alpha)

    const result = await session.call(tool, TOOL_ARGS[tool](target))

    expect(result.isError).toBe(true)
    expect(result.content[0]!.text).toBe(refusal(persona, target, why))
    expectNoSlackCall()
  })

  test("a reply to a user ID with DMs on opens the DM on the persona's own client, then posts to the opened conversation", async () => {
    applyFungibleAlpha(true)
    stubOf(h.alpha).script.open.push(openedDm(OPENED_DM))
    const session = await openModeSession(h.alpha)

    const result = await session.call('reply', TOOL_ARGS.reply(USER_U))

    expect(result.isError).toBeUndefined()
    expect(stubOf(h.alpha).callLog).toEqual([
      { method: 'conversations.open', args: { users: USER_U } },
      { method: 'chat.postMessage', args: expect.objectContaining({ channel: OPENED_DM }) },
    ])
    expect(stubOf(h.beta).callLog).toEqual([])
  })
})

// b.av2 SR-5.1; b.deo SRI-201, SRI-601: the mode is read at each call, with
// the persona, and an absent reader is declarative mode.
describe('the channel mode at each call (b.av2 SR-5.1; b.deo SRI-201, SRI-601)', () => {
  test('flipping the mode between calls to the same unlisted channel flips the outcome', async () => {
    const session = await openModeSession(h.alpha)
    const outcomes: Array<[boolean | undefined, string]> = []
    for (const mode of ['declarative', 'fungible', 'declarative'] as const) {
      h.mode = mode
      const result = await session.call('reply', TOOL_ARGS.reply(UNCONFIGURED))
      outcomes.push([result.isError, result.isError ? result.content[0]!.text : ''])
    }

    expect(outcomes).toEqual([
      [true, refusal(h.alpha, UNCONFIGURED)],
      [undefined, ''],
      [true, refusal(h.alpha, UNCONFIGURED)],
    ])
    expect(stubOf(h.alpha).calls.postMessage.map((c) => c.channel)).toEqual([UNCONFIGURED])
  })

  test('a deps object with no mode reader decides as declarative mode, even for a persona in fungible shape', async () => {
    const persona = applyFungibleAlpha(true)
    h.mode = 'fungible'
    expect(h.deps.getChannelMode).toBeUndefined()
    const session = await openPersonaSession(h.alpha)

    const results = []
    for (const target of [UNCONFIGURED, A_ALL, MALFORMED_ID]) results.push(await session.call('reply', TOOL_ARGS.reply(target)))

    expect(results.map((r) => [r.isError, r.content[0]!.text])).toEqual([
      [true, refusal(persona, UNCONFIGURED, WHY.channel)],
      [true, refusal(persona, A_ALL, WHY.channel)],
      [true, refusal(persona, MALFORMED_ID, WHY.channel)],
    ])
    expectNoSlackCall()
  })
})

// b.av2 SR-5.1; b.deo SRI-601: the scope check runs before the dry-run
// branch in fungible mode too.
describe('dry run in fungible mode (SLACK_DRY_RUN=1; b.av2 SR-5.1, b.deo SRI-601)', () => {
  beforeEach(() => {
    process.env['SLACK_DRY_RUN'] = '1'
    h.mode = 'fungible'
  })

  test.each(TOOLS)('%s to an unlisted channel returns the dry-run result with no Slack call', async (tool) => {
    applyFungibleAlpha(false)
    const session = await openModeSession(h.alpha)

    const result = await session.call(tool, TOOL_ARGS[tool](UNCONFIGURED))

    expect(result.isError).toBeUndefined()
    expect(result.content[0]!.text).toStartWith('[dry-run]')
    expectNoSlackCall()
  })

  test.each(TOOLS.flatMap((tool) => FUNGIBLE_OTHER_TARGETS.map(([label, target]) => [tool, label, target] as const)))(
    '%s to %s gets the fungible refusal, not the dry-run result, and no Slack call',
    async (tool, _label, target) => {
      const persona = applyFungibleAlpha(true)
      const session = await openModeSession(h.alpha)

      const result = await session.call(tool, TOOL_ARGS[tool](target))

      expect(result.isError).toBe(true)
      expect(result.content[0]!.text).toBe(refusal(persona, target, FUNGIBLE_TARGET_REFUSAL))
      expectNoSlackCall()
    },
  )
})

// b.av2 SR-1.2, SR-5.1; b.deo SRI-202, SRI-601: in fungible mode the outbound
// outcome never depends on the declarative section (`channels`, the top-level
// `permission_prompts`), even one holding a D… conversation or a malformed
// value, which declarative mode would allow as listed channels.
describe('fungible mode never reads the declarative section on the outbound path (b.av2 SR-1.2, SR-5.1; b.deo SRI-202, SRI-601)', () => {
  /** A declarative section beside the fungible one: a listed channel, a D… conversation and a malformed value. */
  const DECLARATIVE_SECTION: ChannelEntry[] = [
    { id: A_ALL, delivery: 'all' },
    { id: DM_CONV, delivery: 'all' },
    { id: MALFORMED_ID, delivery: 'mentions' },
  ]

  /** Every fungible-row target × DMs off and on × `post` and `act`, as fungible mode decides it for `persona`. */
  function fungibleOutcomes(persona: Persona): Record<string, PersonaTargetCheck> {
    return Object.fromEntries(
      scopeCases('fungible', FUNGIBLE_SCOPE_ROWS).map(({ label, target, dms, dmsLabel, action }) => [
        `${label}, DMs ${dmsLabel}, ${action}`,
        checkPersonaTarget({ ...persona, dm: { ...persona.dm, enabled: dms } }, target, action, 'fungible'),
      ]),
    )
  }

  /** `persona` applied as Alpha Bot; replies to an unlisted channel, the section's D… entry and its malformed entry. */
  async function replyOutcomes(persona: Persona): Promise<Array<[boolean | undefined, string]>> {
    h.personas.set(persona.key, persona)
    const session = await openModeSession(h.alpha)
    const results: Array<[boolean | undefined, string]> = []
    for (const target of [UNCONFIGURED, DM_CONV, MALFORMED_ID]) {
      const result = await session.call('reply', TOOL_ARGS.reply(target))
      results.push([result.isError, result.isError ? result.content[0]!.text : ''])
    }
    return results
  }

  test('a resolved persona whose channels hold a listed channel, a D… conversation and a malformed value is decided as one with no channels', async () => {
    const withSection = applyFungibleAlpha(false, { channels: DECLARATIVE_SECTION, permission_prompts: MALFORMED_ID })
    const without = applyFungibleAlpha(false)
    expect(withSection.channels).toEqual(DECLARATIVE_SECTION)
    expect(without.channels).toEqual([])

    expect(fungibleOutcomes(withSection)).toEqual(fungibleOutcomes(without))

    h.mode = 'fungible'
    const expected: Array<[boolean | undefined, string]> = [
      [undefined, ''],
      [true, refusal(without, DM_CONV, WHY.dmsOff)],
      [true, refusal(without, MALFORMED_ID, FUNGIBLE_TARGET_REFUSAL)],
    ]
    expect(await replyOutcomes(withSection)).toEqual(expected)
    expect(await replyOutcomes(without)).toEqual(expected)
    // In declarative mode the same persona's section is read: its D… and
    // malformed entries are listed channels there.
    h.mode = 'declarative'
    expect((await replyOutcomes(withSection)).map(([isError]) => isError)).toEqual([true, undefined, undefined])
  })

  test('a configuration whose channels and top-level permission_prompts are malformed loads in fungible mode through the real loader, and its outbound outcomes are those of a persona with no declarative section', async () => {
    const home = join(h.dir, 'home')
    mkdirSync(home)
    const load = (name: string, persona: unknown) => {
      const dir = join(h.dir, name)
      mkdirSync(dir)
      return loadPersonaConfig(writeConfigFile(dir, { allow_invited_channels: true, personas: [persona] }), home)
    }
    const clean = makeFungiblePersona({ name: h.alpha.name }, h.dir)
    const malformedChannels = [{ id: DM_CONV, delivery: 'sometimes' }, 'not-an-entry', { id: 42 }]
    const malformed = load('malformed', { ...clean, channels: malformedChannels, permission_prompts: 42 })
    const plain = load('plain', clean)
    expect(channelModeOf(malformed)).toBe('fungible')
    const withSection = malformed.personas[0]!
    const without = plain.personas[0]!
    expect(withSection.key).toBe(h.alpha.key)
    // The malformed section reached the loader, as written, and resolved to none.
    expect(withSection.sections.channels).toEqual(malformedChannels)
    expect(withSection.sections.permission_prompts).toBe(42)
    expect(withSection.channels).toEqual([])
    expect(withSection.permission_prompts).toBeUndefined()

    expect(fungibleOutcomes(withSection)).toEqual(fungibleOutcomes(without))

    h.mode = 'fungible'
    const expected: Array<[boolean | undefined, string]> = [
      [undefined, ''],
      [true, refusal(without, DM_CONV, WHY.dmsOff)],
      [true, refusal(without, MALFORMED_ID, FUNGIBLE_TARGET_REFUSAL)],
    ]
    expect(await replyOutcomes(withSection)).toEqual(expected)
    expect(await replyOutcomes(without)).toEqual(expected)
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

// b.av2 SR-5.1; b.deo SRI-602: in fungible mode Slack enforces membership, so
// its refusal of a call on a channel target reaches the persona as a tool
// error naming the tool, the persona, the channel and Slack's code, built by
// `slackRefusalToolErrorText`. DM targets in either mode, and declarative
// mode, keep the declarative text (pinned by "Slack call failures" and "DM targets"
// above, whose sessions bind no mode reader). Every scripted failure carries
// the leak marker (Alpha's stub is built with it).
describe("Slack's refusals as tool errors in fungible mode (b.av2 SR-5.1; b.deo SRI-602)", () => {
  /** The stub's script queue each tool's one Slack call takes. */
  const TOOL_QUEUE: Record<ToolName, keyof StubSlackScript> = {
    reply: 'post',
    react: 'reactionsAdd',
    edit_message: 'update',
    fetch_messages: 'history',
    download_attachment: 'replies',
  }
  const CODES = ['not_in_channel', 'channel_not_found'] as const

  /** The error the Slack library throws for `outcome`, from a throwaway stub carrying the leak marker. */
  async function libraryError(outcome: WebApiOutcome): Promise<Error & { original?: { code?: string } }> {
    const probe = makeStubSlack({ token: fakeToken(BOT_TOKEN_PREFIX, 'probe'), leakMarker: LEAK_SENTINEL, post: [outcome] })
    return probe.web.chat.postMessage({ channel: UNCONFIGURED, text: 'probe' }).then(
      () => {
        throw new Error('the probe call was expected to fail')
      },
      (err: unknown) => err as Error,
    )
  }

  /** The library's own message text, before the leak marker's suffix. */
  function libraryText(err: Error): string {
    const cut = err.message.indexOf(' (')
    return cut === -1 ? err.message : err.message.slice(0, cut)
  }

  /** The `[slack]` lines naming `channel`; each must hold the thrown message only redacted. */
  function linesNaming(channel: string): string[] {
    return h.lines.filter((l) => l.startsWith('[slack] ') && l.includes(JSON.stringify(channel)))
  }

  beforeEach(() => {
    h.mode = 'fungible'
  })

  test.each(TOOLS.flatMap((tool) => CODES.map((code) => [tool, code] as const)))(
    '%s on an unlisted channel Slack refuses with %s → the builder\'s tool error naming the persona, the channel and the code; token-safe',
    async (tool, code) => {
      const persona = applyFungibleAlpha(false)
      const outcome: WebApiOutcome = { kind: 'platform', error: code }
      stubOf(h.alpha).script[TOOL_QUEUE[tool]].push(outcome)
      const session = await openModeSession(h.alpha)

      const result = await session.call(tool, TOOL_ARGS[tool](UNCONFIGURED))

      const text = result.content[0]!.text
      expect(result.isError).toBe(true)
      expect(text).toBe(slackRefusalToolErrorText(tool, persona, UNCONFIGURED, code))
      for (const element of [renderPersonaRef(persona.name, persona.key), UNCONFIGURED, code]) expect(text).toContain(element)
      expect(text).not.toContain(libraryText(await libraryError(outcome)))
      expect(stubOf(h.alpha).callLog).toHaveLength(1)
      expect(stubOf(h.beta).callLog).toEqual([])
      const logged = linesNaming(UNCONFIGURED)
      expect(logged).toHaveLength(1)
      expect(logged[0]).toContain(code)
      expect(logged[0]).toContain(REDACTED_SENTINEL_TAIL)
      assertNoLeak({ result, lines: h.lines })
    },
  )

  test.each(TOOLS)(
    '%s on an unlisted channel whose call fails with no platform code (network) → the builder\'s no-code form, naming the persona and the channel and no code',
    async (tool) => {
      const persona = applyFungibleAlpha(false)
      const outcome: WebApiOutcome = { kind: 'network' }
      stubOf(h.alpha).script[TOOL_QUEUE[tool]].push(outcome)
      const session = await openModeSession(h.alpha)

      const result = await session.call(tool, TOOL_ARGS[tool](UNCONFIGURED))

      const text = result.content[0]!.text
      const thrown = await libraryError(outcome)
      expect(result.isError).toBe(true)
      expect(text).toBe(slackRefusalToolErrorText(tool, persona, UNCONFIGURED, undefined))
      for (const element of [renderPersonaRef(persona.name, persona.key), UNCONFIGURED]) expect(text).toContain(element)
      expect(text).not.toContain(libraryText(thrown))
      expect(thrown.original?.code).toBeString()
      expect(text).not.toContain(thrown.original!.code!)
      const logged = linesNaming(UNCONFIGURED)
      expect(logged).toHaveLength(1)
      // The safe head of the thrown value's description: its type and the library's code.
      const safeHead = describeThrownValue(thrown).split(' message=')[0]!
      const libraryCode = (thrown as { code?: unknown }).code
      expect(libraryCode).toBeString()
      expect(safeHead).toStartWith(thrown.constructor.name)
      expect(safeHead).toContain(`code=${libraryCode}`)
      expect(logged[0]).toContain(safeHead)
      expect(logged[0]).toContain(REDACTED_SENTINEL_TAIL)
      assertNoLeak({ result, lines: h.lines })
    },
  )

  /**
   * A reply to `target` from Alpha's session over `deps`, with `open` and a
   * failing post scripted on its stub: its result and the lead (up to the
   * thrown value's description) of each `[slack]` line it logged.
   */
  async function failedReply(deps: SessionToolDeps, target: string, open: WebApiOutcome[]) {
    stubOf(h.alpha).script.open.push(...open)
    stubOf(h.alpha).script.post.push({ kind: 'platform', error: 'not_in_channel' })
    const session = await openSession(registerSession(h.alpha.working_directory, h.alpha.key, makeTransport(), makeServer()), deps)
    const linesBefore = h.lines.length
    const result = await session.call('reply', TOOL_ARGS.reply(target))
    const leads = h.lines
      .slice(linesBefore)
      .filter((l) => l.startsWith('[slack] '))
      .map((l) => l.slice(0, l.indexOf(': ')))
    return { result, leads }
  }

  test.each<[string, string, WebApiOutcome[]]>([
    ['a user ID whose post fails after the open', USER_U, [openedDm(OPENED_DM)]],
    ['a D… conversation', DM_CONV, []],
  ])('a reply to %s fails with the DM failure text a session with no mode reader gets', async (_label, target, open) => {
    const persona = applyFungibleAlpha(true)

    const unbound = await failedReply(h.deps, target, open)
    const fungible = await failedReply(h.modeDeps, target, open)

    expect(fungible.result.isError).toBe(true)
    expect(fungible.leads).toHaveLength(1)
    expect(fungible).toEqual(unbound)
    expect(fungible.result.content[0]!.text).not.toBe(slackRefusalToolErrorText('reply', persona, target, 'not_in_channel'))
    expect(fungible.result.content[0]!.text).toContain(JSON.stringify(target))
    assertNoLeak({ unbound, fungible })
  })

  test.each(TOOLS)(
    "declarative mode with the reader bound: %s on a listed channel Slack refuses keeps the text a session with no mode reader gets",
    async (tool) => {
      h.mode = 'declarative'
      const run = async (deps: SessionToolDeps) => {
        stubOf(h.alpha).script[TOOL_QUEUE[tool]].push({ kind: 'platform', error: 'not_in_channel' })
        const session = await openSession(registerSession(h.alpha.working_directory, h.alpha.key, makeTransport(), makeServer()), deps)
        return session.call(tool, TOOL_ARGS[tool](A_ALL))
      }

      const unbound = await run(h.deps)
      const bound = await run(h.modeDeps)

      expect(bound.isError).toBe(true)
      expect(bound).toEqual(unbound)
      expect(bound.content[0]!.text).not.toBe(slackRefusalToolErrorText(tool, h.alpha, A_ALL, 'not_in_channel'))
      assertNoLeak({ unbound, bound })
    },
  )
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
    ['a third-party url_private', [{ id: 'F0EXT0004', name: 'x.txt', url_private: `https://example.com/x.txt${QUERY}` }], 'F0EXT0004'],
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
    ['a protocol-relative URL on another host', '//evil.example/x'],
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

  test.each<[string, (url: string) => Response, string[]]>([
    ['a 302 with no Location', () => redirect(), [`${FILES}/files-pri/T0-F0FILE001/report.txt${QUERY}`]],
    [
      'a 404 on the first request',
      () => new Response('not found', { status: 404 }),
      [`${FILES}/files-pri/T0-F0FILE001/report.txt${QUERY}`],
    ],
    [
      'a same-origin 302 that then returns 404',
      (url) =>
        url.includes('/download/')
          ? new Response('not found', { status: 404 })
          : redirect('/files-pri/T0-F0FILE001/download/report.txt'),
      [`${FILES}/files-pri/T0-F0FILE001/report.txt${QUERY}`, `${FILES}/files-pri/T0-F0FILE001/download/report.txt`],
    ],
  ])('%s skips the file → "Failed to download any files."', async (_label, handler, fetched) => {
    h.fetchHandler = handler

    const result = await download([slackFile('F0FILE001', 'report.txt')])

    expect(result.isError).toBeUndefined()
    expect(result.content[0]!.text).toBe('Failed to download any files.')
    expect(h.fetches.map((f) => f.url)).toEqual(fetched)
    expectTokenOnlySentToSlackFiles()
    expect(readdirSync(h.inboxDir)).toEqual([])
    expectNoUrlQuery(result)
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

  test('a non-Slack failure (fetch network error) → the generic "tool call failed" wording, token-safe; the log line keeps the message redacted', async () => {
    // The leak sentinel sits inside a fake token and a URL: the log line keeps
    // the message redacted, the tool result never quotes it.
    h.fetchHandler = () => {
      throw new TypeError(`fetch failed (${sentinelInMessage('fetch')})`)
    }

    const result = await download([slackFile('F0FILE001', 'report.txt')])

    expect(result.isError).toBe(true)
    expect(result.content[0]!.text).toBe(`Tool "download_attachment" failed for persona ${ref()}: the tool call failed.`)
    expect(h.fetches).toHaveLength(1)
    expect(readdirSync(h.inboxDir)).toEqual([])
    expectNoUrlQuery(result)
    expect(h.lines.filter((l) => l.includes(`TypeError message="fetch failed (${REDACTED_SENTINEL_TAIL})"`))).toHaveLength(1)
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

/** Register persona `p`'s session and open a client on it over `overrides` of `REPLY_SETTINGS`. */
function openWithSettings(p: Persona, overrides: Partial<ReplySettings> = {}) {
  return openSession(registerSession(p.working_directory, p.key, makeTransport(), makeServer()), depsWithReplySettings(overrides))
}

/** Beta Bot also lists A_ALL, so both personas may reply in one shared channel (E4). */
function shareAlphaChannelWithBeta(): void {
  applyPersona(h.beta, h.beta.dm.enabled, { channels: [...h.beta.channels, { id: A_ALL, delivery: 'all' }] })
}

/** The one `reactions.remove` a reply to MSG_TS in A_ALL makes, with the harness's `eyes`. */
const REMOVE_EYES = { channel: A_ALL, timestamp: MSG_TS, name: 'eyes' }

// The reaction name comes from the server-wide `ack_reaction` setting through
// the injected `getReplySettings` (b.av2 SR-1.6). The tracker is keyed by
// (persona, conversation, ts) (b.av2 SR-4.5): a reply consumes only its own
// persona's entry and removes the reaction through its own client.
describe('reply — ack reaction removal', () => {
  test.each<[string, Partial<ReplySettings>, string]>([
    ['the harness default', {}, 'eyes'],
    ['another configured name', { ack_reaction: 'hourglass' }, 'hourglass'],
  ])("a tracked ack is removed once, by the server-wide ack_reaction name (%s), through the persona's client; a second reply does not remove it again", async (_label, overrides, name) => {
    trackAck(h.alpha.key, A_ALL, MSG_TS)
    const session = await openWithSettings(h.alpha, overrides)

    await session.call('reply', { chat_id: A_ALL, text: 'first', message_id: MSG_TS })
    await session.call('reply', { chat_id: A_ALL, text: 'second', message_id: MSG_TS })

    expect(stubOf(h.alpha).calls.reactionsRemove).toEqual([{ channel: A_ALL, timestamp: MSG_TS, name }])
    expect(slackCallCount(stubOf(h.beta))).toBe(0)
  })

  test('a failing reactions.remove does not fail the reply', async () => {
    trackAck(h.alpha.key, A_ALL, MSG_TS)
    stubOf(h.alpha).web.reactions.remove = async () => {
      throw new Error('reaction_not_found')
    }
    const session = await openPersonaSession(h.alpha)

    const result = await session.call('reply', { chat_id: A_ALL, text: 'hi', message_id: MSG_TS })

    expect(result.isError).toBeUndefined()
    expect(result.content[0]!.text).toStartWith('Sent 1 message(s)')
  })

  // Each row tracks an entry for Alpha Bot, so a reply that ignored the
  // message, the missing message_id or the missing setting would remove it.
  test.each<[string, string, Partial<ReplySettings>, Record<string, unknown>]>([
    ['an ack tracked for another message only', '1700000000.000999', {}, { chat_id: A_ALL, text: 'hi', message_id: MSG_TS }],
    ['reply without message_id', MSG_TS, {}, { chat_id: A_ALL, text: 'hi' }],
    ['no ack_reaction configured', MSG_TS, { ack_reaction: undefined }, { chat_id: A_ALL, text: 'hi', message_id: MSG_TS }],
  ])('%s → the reply posts and no reactions.remove call', async (_label, trackedTs, overrides, args) => {
    trackAck(h.alpha.key, A_ALL, trackedTs)
    const session = await openWithSettings(h.alpha, overrides)

    const result = await session.call('reply', args)

    expect(result.isError).toBeUndefined()
    expect(stubOf(h.alpha).calls.postMessage).toHaveLength(1)
    expect(stubOf(h.alpha).calls.reactionsRemove).toEqual([])
    expect(stubOf(h.beta).callLog).toEqual([])
  })

  test("two personas tracking one message: A's reply removes only A's reaction, through A's client, then B's reply removes only B's, through B's", async () => {
    shareAlphaChannelWithBeta()
    trackAck(h.alpha.key, A_ALL, MSG_TS)
    trackAck(h.beta.key, A_ALL, MSG_TS)
    const alpha = await openWithSettings(h.alpha)
    const beta = await openWithSettings(h.beta)

    await alpha.call('reply', { chat_id: A_ALL, text: 'from alpha', message_id: MSG_TS })

    expect(stubOf(h.alpha).calls.reactionsRemove).toEqual([REMOVE_EYES])
    expect(stubOf(h.beta).calls.reactionsRemove).toEqual([])

    await beta.call('reply', { chat_id: A_ALL, text: 'from beta', message_id: MSG_TS })

    expect(stubOf(h.alpha).calls.reactionsRemove).toEqual([REMOVE_EYES])
    expect(stubOf(h.beta).calls.reactionsRemove).toEqual([REMOVE_EYES])
    expect(stubOf(h.beta).calls.postMessage.map((c) => c.channel)).toEqual([A_ALL])
  })

  test("a reply whose message_id only another persona tracked removes nothing on any client; that persona's own reply still removes it", async () => {
    shareAlphaChannelWithBeta()
    trackAck(h.beta.key, A_ALL, MSG_TS)
    const alpha = await openWithSettings(h.alpha)
    const beta = await openWithSettings(h.beta)

    const result = await alpha.call('reply', { chat_id: A_ALL, text: 'from alpha', message_id: MSG_TS })

    expect(result.isError).toBeUndefined()
    expect(stubOf(h.alpha).calls.reactionsRemove).toEqual([])
    expect(stubOf(h.beta).callLog).toEqual([])

    await beta.call('reply', { chat_id: A_ALL, text: 'from beta', message_id: MSG_TS })

    expect(stubOf(h.alpha).calls.reactionsRemove).toEqual([])
    expect(stubOf(h.beta).calls.reactionsRemove).toEqual([REMOVE_EYES])
  })

  // Beta Bot also tracks the message, so a reply that removed per chunk would
  // show a second removal even if it consumed another persona's entry.
  test('a multi-chunk reply carrying a tracked message_id removes the reaction exactly once, after its first chunk', async () => {
    shareAlphaChannelWithBeta()
    trackAck(h.alpha.key, A_ALL, MSG_TS)
    trackAck(h.beta.key, A_ALL, MSG_TS)
    const session = await openWithSettings(h.alpha, { reply_chunk_limit: 5 })

    const result = await session.call('reply', { chat_id: A_ALL, text: 'one\ntwo\nthree', message_id: MSG_TS })

    expect(result.content[0]!.text).toStartWith(`Sent 3 message(s) to ${A_ALL}`)
    expect(stubOf(h.alpha).callLog.map((c) => c.method)).toEqual([
      'chat.postMessage',
      'reactions.remove',
      'chat.postMessage',
      'chat.postMessage',
    ])
    expect(stubOf(h.alpha).calls.reactionsRemove).toEqual([REMOVE_EYES])
    expect(stubOf(h.beta).callLog).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Reply chunking by the server-wide settings
// ---------------------------------------------------------------------------

const LINE_A = 'a'.repeat(1999)
const LINE_B = 'b'.repeat(1999)
const LINE_C = 'c'.repeat(1999)
/** 25 characters on four lines. */
const PHONETIC = 'alpha\nbravo\ncharlie\ndelta'

// `reply_chunk_limit` and `reply_chunk_mode` come from the server-wide settings
// (b.av2 SR-1.6, SR-5.2); `{}` keeps the harness's, which are the config's
// defaults (4000, `newline`). `chunkText`'s own edge cases are in server.test.ts.
describe('reply — chunking by the server-wide settings', () => {
  test.each<[string, Partial<ReplySettings>, string, string[]]>([
    ['no chunk settings, 5999 characters on three lines: split on newlines', {}, `${LINE_A}\n${LINE_B}\n${LINE_C}`, [`${LINE_A}\n${LINE_B}`, LINE_C]],
    ['no chunk settings, exactly 4000 characters: one post', {}, `${LINE_A}\n${'b'.repeat(2000)}`, [`${LINE_A}\n${'b'.repeat(2000)}`]],
    ['length, limit 12: split at exactly 12 characters', { reply_chunk_mode: 'length', reply_chunk_limit: 12 }, PHONETIC, ['alpha\nbravo\n', 'charlie\ndelt', 'a']],
    ['newline, limit 12: split on newlines, lines that fit kept together', { reply_chunk_mode: 'newline', reply_chunk_limit: 12 }, PHONETIC, ['alpha\nbravo', 'charlie', 'delta']],
  ])('%s', async (_label, overrides, text, expected) => {
    const { reply_chunk_limit: limit, reply_chunk_mode: mode } = { ...REPLY_SETTINGS, ...overrides }
    const session = await openWithSettings(h.alpha, overrides)

    const result = await session.call('reply', { chat_id: A_ALL, text })

    expect(result.isError).toBeUndefined()
    expect(result.content[0]!.text).toStartWith(`Sent ${expected.length} message(s) to ${A_ALL}`)
    const posts = stubOf(h.alpha).calls.postMessage as Array<{ channel: string; text: string }>
    expect(posts.map((p) => p.text)).toEqual(expected)
    expect(posts.map((p) => p.channel)).toEqual(expected.map(() => A_ALL))
    expect(posts.filter((p) => p.text.length > limit)).toEqual([])
    // `newline` mode drops the newline it splits at; `length` mode drops nothing.
    expect(posts.map((p) => p.text).join(mode === 'newline' ? '\n' : '')).toBe(text)
    expect(stubOf(h.beta).callLog).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Tool list and MCP instructions
// ---------------------------------------------------------------------------

describe('tool list and instructions', () => {
  // b.deo SRI-501: six tools, the five Slack tools with their inputs and
  // `set_channel_delivery` with `channel` and `delivery`, both required.
  test('lists exactly the six tools with their inputs and required inputs unchanged; no tool name, description or input schema text carries reload wording (AC 74)', async () => {
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
      [SET_CHANNEL_DELIVERY_TOOL]: { properties: ['channel', 'delivery'], required: ['channel', 'delivery'] },
    })
    // b.av2 SR-8.8: the whole tool definition (name, description, every schema
    // property name and description), so a reload tool or hint can't slip in.
    expect(Object.fromEntries(tools.map((t) => [t.name, reloadTermsIn(JSON.stringify(t))]))).toEqual(
      Object.fromEntries(tools.map((t) => [t.name, []])),
    )
  })

  // b.jg5 SRJ-511 (AC 47): the clear-latch command is the operator's alone. The
  // whole serialized definition of every tool (name, description, every schema
  // property name and description) and the instructions the session receives
  // carry no spelling of it (tests/test-helpers/clear-latch-terms.ts); a
  // failure names the tool, or the instructions, and the terms found.
  test('SRJ-511 (AC 47): no tool definition and not the instructions the session receives name clear-latch in any spelling', async () => {
    const { client } = await openPersonaSession(h.alpha)

    const { tools } = await client.listTools()
    const instructions = client.getInstructions()

    expect(tools.length).toBeGreaterThan(0)
    expect(typeof instructions).toBe('string')
    expect({
      tools: Object.fromEntries(tools.map((t) => [t.name, clearLatchTermsIn(JSON.stringify(t))])),
      instructions: clearLatchTermsIn(instructions ?? ''),
    }).toEqual({
      tools: Object.fromEntries(tools.map((t) => [t.name, []])),
      instructions: [],
    })
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

  // The content audit (reload wording, AC 74; forbidden terms, AC 46) reads
  // MCP_INSTRUCTIONS in shipped-docs.test.ts; this pins that a session sends
  // exactly that string, so the audit reads what instances receive.
  test('a session sends exactly MCP_INSTRUCTIONS as its instructions', async () => {
    const { client } = await openPersonaSession(h.alpha)

    expect(client.getInstructions()).toBe(MCP_INSTRUCTIONS)
  })

  test('the example tag in the instructions carries source="<MCP server name>", as the harness renders it', () => {
    expect(MCP_INSTRUCTIONS).toContain(`source="${MCP_SERVER_NAME}"`)
  })

  test('instructions still say to pass chat_id back', async () => {
    const { client } = await openPersonaSession(h.alpha)

    const instructions = client.getInstructions() ?? ''

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

// b.av2 SR-12; b.deo SRI-604: one instructions text for every session, in
// both channel modes, so its elements are checked once, on that text. Key
// phrases only, each within one line, and the tool named through
// SET_CHANNEL_DELIVERY_TOOL. The DM text is the DM cases' above; the tool
// list, the clear-latch check and the content audits are elsewhere.
describe('session instructions in both channel modes (b.av2 SR-12; b.deo SRI-604)', () => {
  /** `text` matched literally inside a pattern. */
  const literal = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

  /** The instructions a session for Alpha Bot receives when opened with the mode seam at `mode`. */
  async function instructionsIn(mode: ChannelMode): Promise<string | undefined> {
    h.mode = mode
    if (mode === 'fungible') applyFungibleAlpha(false)
    else h.personas.set(h.alpha.key, h.alpha)
    const { client } = await openModeSession(h.alpha)
    return client.getInstructions()
  }

  test('a session opened in fungible mode and one opened in declarative mode each receive exactly MCP_INSTRUCTIONS', async () => {
    const fungible = await instructionsIn('fungible')
    const declarative = await instructionsIn('declarative')

    expect(fungible).toBe(MCP_INSTRUCTIONS)
    expect(declarative).toBe(MCP_INSTRUCTIONS)
    expect(fungible).toBe(declarative!)
  })

  test('the text says where the persona may act, with invited channels off and on, and that the channel-delivery tool sets how closely the persona listens in a channel, called when someone there asks', () => {
    expect(MCP_INSTRUCTIONS).toMatch(/every channel message you receive comes from a channel you may act in/)
    expect(MCP_INSTRUCTIONS).toMatch(/invited channels off[^\n]*the channels your persona is configured into/)
    expect(MCP_INSTRUCTIONS).toMatch(/invited channels on[^\n]*any channel your persona's Slack app is a member of[^\n]*Slack refuses the others/)
    expect(MCP_INSTRUCTIONS).toMatch(
      new RegExp(`${literal(SET_CHANNEL_DELIVERY_TOOL)} sets how closely you listen in a channel[^\\n]*when someone in that channel asks`),
    )
  })
})
