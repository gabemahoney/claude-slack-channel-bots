/**
 * set-channel-delivery.test.ts — The `set_channel_delivery` tool (b.deo
 * SRI-1304): SRI-501 to SRI-507, SRI-404's tool side, and SRI-902's
 * `persona-channel-delivery-set` pin (AC 14 to AC 16, AC 19, AC 22, AC 24,
 * AC 25).
 *
 * - Listing (SRI-501): every persona's session lists the tool, with the
 *   exported name and descriptions and its two required inputs, the same
 *   definition in both modes.
 * - Resolution (SRI-502): an unmatched session (a persona that is not up
 *   among them), an unapplied key, a retiring key and a session the registry
 *   dropped or replaced get the other tools' refusals, before SRI-503's
 *   order; the handler's stretch from resolution to the store's write has no
 *   await (a source audit of `src/registry.ts`).
 * - Refusals (SRI-503): each rule, its echo rule stated per row, the
 *   known-channel branches, and the order with several causes at once.
 * - Secrecy (SRI-1304, SRI-907): `LEAK_SENTINEL` and a fake token as
 *   `delivery` and as `channel` appear in no tool error.
 * - Accepted calls (SRI-504, SRI-505): the stored record, the result, the
 *   next event decided by it, the same value again, the loop guard, and the
 *   one `persona-channel-delivery-set` line per accepted call (one pin case).
 * - Failed writes (SRI-506, SRI-404's tool side), a store that refuses the
 *   input it would write, and dry run (SRI-507).
 *
 * How the tool is driven: through the reload harness's `run.callTool`
 * (`createSessionServer` over an in-memory MCP client, with each persona's
 * Slack stub and the tool deps bound as server.ts binds them: the mode of
 * the configuration in effect, the run's stored-choice store, the routing's
 * heard set and the applied personas). The routing hears channels through
 * `run.deliver`. Listing, and a session `run.callTool` cannot express (one
 * matched to no persona, a store that is not bound, a stand-in store that
 * refuses its input), go through a direct client opened here over
 * `createSessionServer`, whose deps carry the mode, the run's bindings where
 * there is a run (or the stand-in store), and a Slack stub of its own.
 *
 * "Every stub's call log empty" is read as: no Web API call is added to any
 * stub's log (every persona's, and the direct client's) during a tool call.
 * Deliveries a case makes to set itself up make their own calls (a delivered
 * message's `users.info`) and are not the tool's; a case that delivers
 * nothing keeps every log empty throughout (b.deo SRI-605).
 *
 * Isolation: every file sits under the harness's `mkdtempSync` root, removed
 * by `h.cleanup()`; time comes only from the run's fake clock; the tools'
 * dry-run flag (`SLACK_DRY_RUN`) is saved and cleared before each case and
 * restored after it; `console.error` (the registry's own lines) is captured
 * and restored. Every run's `captured()`, with every tool result and every
 * console line, passes `assertNoLeak` after each case, failures included.
 * Texts come from `src/`'s builders; the one typed wording is the
 * `persona-channel-delivery-set` pin. No `mock.module`.
 *
 * SPDX-License-Identifier: MIT
 */

import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'

import {
  CHANNEL_DELIVERY_FILE_NAME,
  CHANNEL_DELIVERY_SET_INVALID,
  channelDeliveryDeclarationOf,
  channelDeliverySetAction,
  channelDeliveryWriteFailedLine,
} from '../src/channel-delivery.ts'
import {
  CONFIG_FILE_NAME,
  channelModeOf,
  replySettingsOf,
  type ChannelMode,
  type DeliveryMode,
  type Persona,
  type PersonaInput,
} from '../src/config.ts'
import type { Via } from '../src/delivery-decision.ts'
import { errnoSuffix } from '../src/persona-credentials.ts'
import {
  channelDeliverySetCause,
  escapeCause,
  formatPersonaDiagnostic,
  NO_STORED_CHOICE,
  PERSONA_CHANNEL_DELIVERY_SET,
} from '../src/persona-diagnostics.ts'
import { personaKey, renderPersonaRef } from '../src/persona-identity.ts'
import {
  _resetRegistry,
  channelDeliveryChannelRefusal,
  channelDeliveryDeclarativeRefusal,
  channelDeliveryNotStoredText,
  channelDeliverySetResultText,
  channelDeliveryUnreadableRefusal,
  channelDeliveryValueRefusal,
  channelDeliveryWriteFailedText,
  checkPersonaTarget,
  createSessionServer,
  dropPersonaSession,
  personaNotAppliedRefusal,
  registerSession,
  sessionNotMatchedRefusal,
  SET_CHANNEL_DELIVERY_CHANNEL_DESCRIPTION,
  SET_CHANNEL_DELIVERY_DELIVERY_DESCRIPTION,
  SET_CHANNEL_DELIVERY_DESCRIPTION,
  SET_CHANNEL_DELIVERY_TOOL,
  type SessionChannelDeliveryStore,
  type SessionEntry,
  type SessionToolDeps,
} from '../src/registry.ts'
import { declarationOf, channelDeliveryRecordOf, writeChannelDeliveryRecord, type ChannelDeliveryPersonaSeed } from './test-helpers/channel-delivery.ts'
import { APP_TOKEN_PREFIX, BOT_TOKEN_PREFIX, LEAK_SENTINEL, assertNoLeak, fakeToken } from './test-helpers/credentials.ts'
import { LINE_HOLE, lineParts } from './test-helpers/line-parts.ts'
import { makeMultiPersonaConfig } from './test-helpers/persona-config.ts'
import {
  makeReloadHarness,
  NO_RUN_ACTIVITY,
  SLACK_UNREACHABLE,
  type ReloadHarness,
  type ReloadRun,
  type ReloadRunActivity,
  type ReloadRunOptions,
  type ReloadToolResult,
  type ReloadWriteRecord,
  type ReloadRemoveRecord,
  type WriteFailure,
} from './test-helpers/reload-harness.ts'
import {
  asWebClient,
  ENVELOPE_FLAG_FORMS,
  makeChannelMessage,
  makeGroupDmMessage,
  makePrivateChannelMessage,
  makeStubSlack,
  mentionText,
  type EnvelopeOverrides,
  type EventOverrides,
  type SlackEvent,
  type StubSlack,
  type StubWebCall,
} from './test-helpers/slack-stub.ts'
import { balancedAfter, indicesOf, maskLiterals, stripComments } from './test-helpers/source-audit.ts'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Persona P, the caller in every case; Q and R beside it. */
const P = 'papa'
const Q = 'quebec'
const R = 'romeo'
const NAMES = [P, Q, R] as const

/** Each persona's fungible destination: a channel ID, so the loop guard holds it for the others. */
const P_DEST = 'C0PDEST001'
const Q_DEST = 'C0QDEST001'
const R_DEST = 'C0RDEST001'

/** A public channel P hears through the fungible path. */
const PUBLIC = 'C0PUBLIC01'
/** A private channel (`G…`, `group`) P hears through the fungible path. */
const PRIVATE = 'G0PRIVAT01'
/** A channel delivered to P with the envelope's externally shared flag set: never heard. */
const EXT_SHARED = 'C0EXTSHR01'
/** A group DM (`G…`, `mpim`) delivered to P: never heard. */
const GROUP_DM = 'G0GRPDM001'
/** A DM conversation ID. */
const DM_ID = 'D0DIRECT01'
/** Not a channel ID (neither `C…` nor `G…`), from `A-Z0-9` only. */
const MALFORMED = 'Q0NOTACHAN'
/** A `C…` ID no persona has heard. */
const NEVER_HEARD = 'C0NEVERH01'
/** A channel only Q hears. */
const Q_ONLY = 'C0QONLY001'
/** A channel P holds a seeded choice for, never heard this run. */
const SEEDED = 'C0SEEDED01'
/** The author of every message a case delivers. */
const AUTHOR = 'U0AUTHOR01'
/** A `delivery` value that is not `mentions` or `all`, from letters only. */
const BAD_DELIVERY = 'sometimes'
/** Bytes the stored-choice parser refuses: the store is unreadable for the run. */
const UNREADABLE_BYTES = '{'

let h: ReloadHarness
/** Every `console.error` line during the case (the registry's own lines). */
let consoleLines: string[]
let consoleSpy: ReturnType<typeof spyOn>
/** Every tool result and tool error the case collected, for the leak check. */
let toolOutputs: ReloadToolResult[]
/** Every direct client's stub and log, for the leak check. */
let directs: DirectSession[]
let directClients: Client[]
let savedDryRun: string | undefined

beforeEach(() => {
  h = makeReloadHarness()
  consoleLines = []
  toolOutputs = []
  directs = []
  directClients = []
  savedDryRun = process.env['SLACK_DRY_RUN']
  delete process.env['SLACK_DRY_RUN']
  consoleSpy = spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    consoleLines.push(args.map(String).join(' '))
  })
})

afterEach(async () => {
  try {
    const extra = {
      toolOutputs,
      consoleLines,
      direct: directs.map((d) => ({ calls: d.stub.callLog, logs: d.logs })),
    }
    assertNoLeak(extra, 'set-channel-delivery afterEach')
    h.runs.forEach((run, i) => assertNoLeak(run.captured(extra), `set-channel-delivery afterEach run ${i}`))
    // The tool posts nothing, and no case's setup posts either (b.deo SRI-505).
    for (const run of h.runs) expect(run.slackPosts()).toEqual([])
  } finally {
    // Each step runs whatever the one before did: a client that fails to
    // close or a cleanup that throws leaves no mocked console.error, registry
    // entry or dry-run flag to a later suite.
    const closed = await Promise.allSettled(directClients.map((client) => client.close()))
    try {
      await h.cleanup()
    } finally {
      _resetRegistry()
      consoleSpy.mockRestore()
      if (savedDryRun === undefined) delete process.env['SLACK_DRY_RUN']
      else process.env['SLACK_DRY_RUN'] = savedDryRun
    }
    const failed = closed.filter((outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected')
    if (failed.length > 0) throw new AggregateError(failed.map((outcome) => outcome.reason), 'a direct client did not close')
  }
})

/** A fungible persona in file form: `invited.permission_prompts` set to `dest`; with `dual`, also the declarative sections, so the switch can be turned off. */
function fungibleInput(name: string, dest: string, dual: boolean): PersonaInput {
  return dual
    ? h.persona(name, { invited: { permission_prompts: dest } })
    : h.persona(name, { channels: undefined, permission_prompts: undefined, invited: { permission_prompts: dest } })
}

interface FungibleStart {
  /** Put unreadable bytes at the stored-choice path before the start. */
  readonly unreadable?: boolean
  /** Seed a valid record before the start (each entry with its persona's applied declaration). */
  readonly seed?: (inputs: Record<string, PersonaInput>) => Record<string, ChannelDeliveryPersonaSeed>
  /** Personas keep their declarative sections, and detection is started, so `turnSwitchOff` can confirm a change. */
  readonly switchable?: boolean
  /** Register a session for each persona (the default), or none. */
  readonly sessions?: 'register' | 'none'
  readonly run?: ReloadRunOptions
}

interface FungibleRig {
  readonly run: ReloadRun
  readonly inputs: Record<string, PersonaInput>
}

/** P, Q and R in fungible mode from a byte-equal record and configuration file, started (and each session registered unless asked not to). */
async function startFungible(opts: FungibleStart = {}): Promise<FungibleRig> {
  const dual = opts.switchable === true
  const inputs = { [P]: fungibleInput(P, P_DEST, dual), [Q]: fungibleInput(Q, Q_DEST, dual), [R]: fungibleInput(R, R_DEST, dual) }
  const personas = NAMES.map((name) => inputs[name]!)
  h.materialize(...personas)
  const config = { allow_invited_channels: true, personas }
  h.writeRecord(config)
  h.writeConfig(config)
  if (opts.unreadable === true) h.writeChannelDeliveryBytes(UNREADABLE_BYTES)
  if (opts.seed !== undefined) writeChannelDeliveryRecord(h.stateDir, opts.seed(inputs))
  const run = dual ? await h.startDetecting(opts.run) : await h.start(opts.run)
  expect(run.outcome.kind).toBe('applied')
  expect(channelModeOf(run.serverConfig())).toBe('fungible')
  if (opts.sessions !== 'none') for (const name of NAMES) run.registerSession(name)
  return { run, inputs }
}

/** P alone in declarative mode with one listed channel, started, its session registered. */
async function startDeclarative(opts: { unreadable?: boolean } = {}): Promise<{ run: ReloadRun; listed: string }> {
  const p = h.persona(P)
  h.materialize(p)
  h.writeRecord({ personas: [p] })
  h.writeConfig({ personas: [p] })
  if (opts.unreadable === true) h.writeChannelDeliveryBytes(UNREADABLE_BYTES)
  const run = await h.start()
  expect(run.outcome.kind).toBe('applied')
  expect(channelModeOf(run.serverConfig())).toBe('declarative')
  run.registerSession(P)
  return { run, listed: p.channels![0]!.id }
}

/** Confirm a change that turns the switch off (the same personas), so the mode in effect is declarative; the heard sets are kept. */
async function turnSwitchOff(rig: FungibleRig): Promise<void> {
  h.writeConfig({ allow_invited_channels: false, personas: NAMES.map((name) => rig.inputs[name]!) })
  await (await rig.run.confirmPending()).applying
  expect(channelModeOf(rig.run.serverConfig())).toBe('declarative')
}

/** The applied persona named `name` in the configuration in effect. */
function applied(run: ReloadRun, name: string): Persona {
  const found = run.serverConfig()?.personas.find((p) => p.name === name)
  if (found === undefined) throw new Error(`not applied: ${name}`)
  return found
}

/** A plain message (no mention, no broadcast) from `AUTHOR` in `channel`. */
function plainMessage(channel: string, overrides: EventOverrides = {}): SlackEvent {
  return makeChannelMessage({ channel, user: AUTHOR, text: `plain message in ${channel}`, ...overrides })
}

/** Deliver `event` to persona `name` (on its own socket), so the routing decides it and, on the fungible path, hears its channel. */
async function hear(run: ReloadRun, name: string, event: SlackEvent, envelope?: EnvelopeOverrides): Promise<void> {
  await run.deliver(name, event, envelope)
}

/** Call the tool as persona `name` through `run.callTool` (through `session` when given), keeping the result for the leak check. */
async function setDelivery(run: ReloadRun, name: string, args: Record<string, unknown>, session?: SessionEntry): Promise<ReloadToolResult> {
  const result = await run.callTool(name, SET_CHANNEL_DELIVERY_TOOL, args, session)
  toolOutputs.push(result)
  return result
}

/** Call another tool as persona `name` through `run.callTool`, keeping the result for the leak check. */
async function callOther(run: ReloadRun, name: string, tool: string, args: Record<string, unknown>): Promise<ReloadToolResult> {
  const result = await run.callTool(name, tool, args)
  toolOutputs.push(result)
  return result
}

/** The stored-choice file's bytes, or null when there is none. */
function storedChoiceBytes(): Buffer | null {
  return existsSync(h.channelDeliveryFile) ? readFileSync(h.channelDeliveryFile) : null
}

/** The SR-8.1 reload files' bytes (`config.json` among them), each undefined when absent. */
function reloadFiles(): Record<string, Buffer | undefined> {
  return { config: h.readConfig(), lastApplied: h.readRecord(), pending: h.readPending(), apply: h.readApply() }
}

// ---------------------------------------------------------------------------
// The direct client
// ---------------------------------------------------------------------------

/** What a direct client's deps read at each call. */
interface DirectBinding {
  readonly mode: () => ChannelMode
  readonly personas: () => readonly Persona[]
  readonly store: () => SessionChannelDeliveryStore | undefined
}

/** A run's bindings, as its tool deps read them: the mode in effect, the applied personas and the run's store. */
function bindingOf(run: ReloadRun): DirectBinding {
  return {
    mode: () => channelModeOf(run.serverConfig()),
    personas: () => run.serverConfig()?.personas ?? [],
    store: () => run.channelDelivery,
  }
}

interface ListedTool {
  readonly name: string
  readonly description?: string
  readonly inputSchema: unknown
}

/** A direct in-memory MCP client over `createSessionServer`, with a Slack stub of its own and its own log. */
interface DirectSession {
  readonly stub: StubSlack
  readonly logs: string[]
  call(tool: string, args: Record<string, unknown>): Promise<ReloadToolResult>
  listTools(): Promise<ListedTool[]>
}

/** Open a direct client on a session server over `entry`, its deps bound to `binding`. */
async function openDirect(entry: SessionEntry, binding: DirectBinding): Promise<DirectSession> {
  const stub = makeStubSlack({ leakMarker: LEAK_SENTINEL })
  const logs: string[] = []
  const deps: SessionToolDeps = {
    assertSendable: (path) => {
      throw new Error(`set-channel-delivery.test: no file may be sent (${JSON.stringify(path)})`)
    },
    getReplySettings: () => replySettingsOf(null),
    getPersona: (key) => binding.personas().find((p) => p.key === key),
    clientFor: () => asWebClient(stub.web),
    inboxDir: join(h.root, 'direct-inbox'),
    resolveUserName: async (_key, userId) => userId,
    consumeAck: () => false,
    serverPort: 0,
    getChannelMode: binding.mode,
    getChannelDelivery: binding.store,
    getAppliedPersonas: binding.personas,
    log: (line) => void logs.push(line),
  }
  const server = createSessionServer(entry, deps)
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  const client = new Client({ name: 'set-channel-delivery-test', version: '1.0.0' }, { capabilities: {} })
  await client.connect(clientTransport)
  directClients.push(client)
  const session: DirectSession = {
    stub,
    logs,
    async call(tool, args) {
      const raw = (await client.callTool({ name: tool, arguments: args })) as { isError?: boolean; content: Array<{ text?: string }> }
      const result = { isError: raw.isError === true, text: raw.content.map((c) => c.text ?? '').join('\n') }
      toolOutputs.push(result)
      return result
    },
    async listTools() {
      return (await client.listTools()).tools as ListedTool[]
    },
  }
  directs.push(session)
  return session
}

/** A stand-in transport: the tool handlers never touch it. */
function fakeTransport(): SessionEntry['transport'] {
  return { sessionId: undefined, close: async () => {}, handleRequest: async () => new Response() } as unknown as SessionEntry['transport']
}

/** A stand-in MCP server for a registered entry: the tool handlers never touch it. */
function fakeServer(): SessionEntry['server'] {
  return { connect: async () => {}, notification: async () => {} } as unknown as SessionEntry['server']
}

/** A session matched to no persona, as server.ts leaves a refused or unmatched instance's session: no persona key. */
function unmatchedEntry(): SessionEntry {
  return { cwd: '', personaKey: '', transport: fakeTransport(), server: fakeServer(), connected: false, peerPort: 0 }
}

// ---------------------------------------------------------------------------
// Per-call checks
// ---------------------------------------------------------------------------

/** Everything one tool call did, and the files around it. */
interface Observation {
  readonly result: ReloadToolResult
  /** What the run did during the call (`run.since`); nothing when there is no run. */
  readonly activity: ReloadRunActivity
  /** `console.error` lines during the call. */
  readonly console: string[]
  /** The direct client's Slack calls and log lines during the call. */
  readonly direct: { readonly calls: StubWebCall[]; readonly logs: string[] }
  readonly file: { readonly before: Buffer | null; readonly after: Buffer | null }
  readonly reload: { readonly before: Record<string, Buffer | undefined>; readonly after: Record<string, Buffer | undefined> }
}

/** Run `act` (one tool call), with a snapshot of every capture and file before it. */
async function observe(act: () => Promise<ReloadToolResult>, where: { run?: ReloadRun; direct?: DirectSession } = {}): Promise<Observation> {
  const fileBefore = storedChoiceBytes()
  const reloadBefore = reloadFiles()
  const cp = where.run?.checkpoint()
  const consoleAt = consoleLines.length
  const directCallsAt = where.direct?.stub.callLog.length ?? 0
  const directLogsAt = where.direct?.logs.length ?? 0
  const result = await act()
  return {
    result,
    activity: where.run === undefined || cp === undefined ? { ...NO_RUN_ACTIVITY } : where.run.since(cp),
    console: consoleLines.slice(consoleAt),
    direct: {
      calls: where.direct?.stub.callLog.slice(directCallsAt) ?? [],
      logs: where.direct?.logs.slice(directLogsAt) ?? [],
    },
    file: { before: fileBefore, after: storedChoiceBytes() },
    reload: { before: reloadBefore, after: reloadFiles() },
  }
}

/** Observe one `set_channel_delivery` call as persona `name` through `run.callTool`. */
function observeSet(run: ReloadRun, name: string, args: Record<string, unknown>, session?: SessionEntry): Promise<Observation> {
  return observe(() => setDelivery(run, name, args, session), { run })
}

/** No Slack call on any stub, and no other effect but `expected`'s logs and writes. */
function expectOnly(o: Observation, expected: Partial<ReloadRunActivity>): void {
  expect(o.activity).toEqual({ ...NO_RUN_ACTIVITY, ...expected })
  expect(o.console).toEqual([])
  expect(o.direct).toEqual({ calls: [], logs: [] })
  expect(o.reload.after).toEqual(o.reload.before)
}

/**
 * The refused-call check: the tool error `text`; no stored-choice write (no
 * writer call at all) and the file's bytes unchanged (or the file absent, as before); no
 * Slack call on any stub; no line logged; the reload files, `config.json`
 * among them, unchanged.
 */
function expectRefused(o: Observation, text: string): void {
  expect(o.result).toEqual({ isError: true, text })
  expectOnly(o, {})
  expect(o.file.after).toEqual(o.file.before)
}

/** An accepted call: the result `text`, exactly one stored-choice write, exactly the one `line`, no Slack call. */
function expectAccepted(o: Observation, text: string, line: string): void {
  expect(o.result).toEqual({ isError: false, text })
  expectOnly(o, { logs: [line], writes: [h.channelDeliveryWrite(true)] })
}

/** The `persona-channel-delivery-set` line of persona `name`'s call, through the builders. */
function setLine(run: ReloadRun, name: string, channel: string, before: DeliveryMode | undefined, after: DeliveryMode, delivery: DeliveryMode): string {
  const persona = applied(run, name)
  return formatPersonaDiagnostic({
    class: PERSONA_CHANNEL_DELIVERY_SET,
    name: persona.name,
    key: persona.key,
    index: persona.index,
    cause: channelDeliverySetCause(channel, before, after, delivery),
  })
}

/** The result of an accepted call: `stored` for `channel`, at `delivery` from the next event, held by the loop guard or not. */
function setResult(channel: string, stored: DeliveryMode, delivery: DeliveryMode, heldByLoopGuard: boolean): string {
  return channelDeliverySetResultText(channel, stored, { delivery, heldByLoopGuard })
}

/** How many deliveries had reached each persona's session: a checkpoint for `deliveredSince`. */
type DeliveryCheckpoint = Readonly<Record<string, number>>

/** The deliveries each persona's session holds now. */
function deliveryCheckpoint(run: ReloadRun): DeliveryCheckpoint {
  return Object.fromEntries(NAMES.map((name) => [name, run.deliveries(name).length]))
}

/** The checkpoint before any delivery. */
const NO_DELIVERIES: DeliveryCheckpoint = Object.fromEntries(NAMES.map((name) => [name, 0]))

/** What reached every persona's session since `from`, by name: each delivery's channel and `via`. */
function deliveredSince(run: ReloadRun, from: DeliveryCheckpoint): Record<string, Array<[string, string | undefined]>> {
  return Object.fromEntries(NAMES.map((name) => [name, run.deliveries(name).slice(from[name]).map((d): [string, string | undefined] => [d.chat_id, d.via])]))
}

/** Every persona's deliveries: `toP` for P, and nothing for Q or R. */
function onlyToP(toP: Array<[string, string | undefined]>): Record<string, Array<[string, string | undefined]>> {
  return { [P]: toP, [Q]: [], [R]: [] }
}

/** An errno-style error with `code`, as the harness's seams throw. */
function errnoError(code: string): Error {
  return Object.assign(new Error(code), { code })
}

/**
 * `line` is the store's failed-write line for persona `key`'s choice in
 * `channel`: the builder's own text around the store's detail, which holds
 * each errno code (`errnoSuffix`) in order.
 */
function expectWriteFailedLine(line: string, key: string, channel: string, codes: readonly string[]): void {
  const [head, tail] = lineParts((hole) =>
    channelDeliveryWriteFailedLine(h.channelDeliveryFile, channelDeliverySetAction(key, channel), hole, false),
  ) as [string, string]
  expect(line.startsWith(head)).toBe(true)
  expect(line.endsWith(tail)).toBe(true)
  let detail = line.slice(head.length, line.length - tail.length)
  for (const code of codes) {
    const suffix = errnoSuffix(errnoError(code))
    expect(suffix).not.toBe('')
    expect(detail).toContain(suffix)
    detail = detail.slice(detail.indexOf(suffix) + suffix.length)
  }
}

// ---------------------------------------------------------------------------
// S1: listing (SRI-501)
// ---------------------------------------------------------------------------

/**
 * The tool's definition, from `src/`'s exported texts: two required inputs,
 * `channel` (a string) and `delivery` (`mentions` or `all`). Both modes are
 * compared with this one object, so the definition is the same in both.
 */
const EXPECTED_DEFINITION = {
  name: SET_CHANNEL_DELIVERY_TOOL,
  description: SET_CHANNEL_DELIVERY_DESCRIPTION,
  inputSchema: {
    type: 'object',
    properties: {
      channel: { type: 'string', description: SET_CHANNEL_DELIVERY_CHANNEL_DESCRIPTION },
      delivery: { type: 'string', enum: ['mentions', 'all'], description: SET_CHANNEL_DELIVERY_DELIVERY_DESCRIPTION },
    },
    required: ['channel', 'delivery'],
  },
}

describe('every session lists set_channel_delivery, the same in both modes (b.deo SRI-501)', () => {
  test.each<[ChannelMode, () => Promise<ReloadRun>, readonly string[]]>([
    ['fungible', async () => (await startFungible()).run, NAMES],
    ['declarative', async () => (await startDeclarative()).run, [P]],
  ])('%s mode: each persona\'s session lists the tool with its exported name, descriptions and two required inputs, and no Slack call', async (_mode, start, names) => {
    const run = await start()

    for (const name of names) {
      const direct = await openDirect(run.session(name)!, bindingOf(run))
      const cp = run.checkpoint()
      const tools = await direct.listTools()

      const listed = tools.filter((t) => t.name === SET_CHANNEL_DELIVERY_TOOL)
      expect(listed).toEqual([EXPECTED_DEFINITION])
      expect(run.since(cp)).toEqual(NO_RUN_ACTIVITY)
      expect(direct.stub.callLog).toEqual([])
    }
  })
})

// ---------------------------------------------------------------------------
// S2: resolution before the refusal order (SRI-502)
// ---------------------------------------------------------------------------

/**
 * What breaks SRI-502's synchronous stretch in `src/registry.ts`'s
 * comment-stripped code: `setChannelDelivery` declared `async`, an `await`
 * in it before its `store.set(` write, or an `await` in the CallTool handler
 * before it hands the call to `setChannelDelivery`. Empty when the stretch
 * holds.
 */
function synchronousStretchFindings(code: string): string[] {
  const masked = maskLiterals(code)
  const declarations = indicesOf(/(?<![\w$.])function\s+setChannelDelivery\s*\(/g, masked)
  if (declarations.length !== 1) return [`expected one setChannelDelivery declaration, found ${declarations.length}`]
  const at = declarations[0]!
  const findings: string[] = []
  if (/\basync\s+$/.test(masked.slice(Math.max(0, at - 16), at))) findings.push('setChannelDelivery is async')
  const body = masked.slice(...balancedAfter(masked, at, '{', '}'))
  const write = body.indexOf('store.set(')
  if (write < 0) findings.push('setChannelDelivery makes no store.set( write')
  else if (/\bawait\b/.test(body.slice(0, write))) findings.push('an await comes before the store.set( write')
  const handlerAt = masked.indexOf('setRequestHandler(CallToolRequestSchema')
  if (handlerAt < 0) return [...findings, 'no CallTool handler']
  const handler = masked.slice(...balancedAfter(masked, handlerAt, '{', '}'))
  const dispatch = handler.indexOf('setChannelDelivery(')
  if (dispatch < 0) findings.push('the CallTool handler never calls setChannelDelivery')
  else if (/\bawait\b/.test(handler.slice(0, dispatch))) findings.push('an await comes before the CallTool handler calls setChannelDelivery')
  return findings
}

/** `code` with `text` put right after the first `{` that follows `anchor`. */
function insertedAfterBrace(code: string, anchor: string, text: string): string {
  const at = code.indexOf(anchor)
  if (at < 0) throw new Error(`anchor not found: ${anchor}`)
  const brace = code.indexOf('{', at) + 1
  return `${code.slice(0, brace)}${text}${code.slice(brace)}`
}

describe('resolution comes before the refusal order (b.deo SRI-502)', () => {
  test('a session matched to no persona gets the unmatched refusal, the one reply gets for its own name; nothing written, logged or called', async () => {
    const { run } = await startFungible()
    await hear(run, P, plainMessage(PUBLIC))
    const direct = await openDirect(unmatchedEntry(), bindingOf(run))

    expectRefused(
      await observe(() => direct.call(SET_CHANNEL_DELIVERY_TOOL, { channel: PUBLIC, delivery: 'all' }), { run, direct }),
      sessionNotMatchedRefusal(SET_CHANNEL_DELIVERY_TOOL),
    )
    expectRefused(
      await observe(() => direct.call('reply', { chat_id: PUBLIC, text: 'hello' }), { run, direct }),
      sessionNotMatchedRefusal('reply'),
    )
  })

  test('a persona that is not up is never admitted: its instance\'s session, matched to no persona, gets the unmatched refusal while an up persona admitted beside it is accepted', async () => {
    const { run } = await startFungible({ sessions: 'none', run: { slack: { [R]: SLACK_UNREACHABLE } } })
    expect([run.isUp(P), run.isUp(R)]).toEqual([true, false])
    expect(run.admitSession(P).kind).toBe('admitted')
    expect(run.admitSession(R)).toEqual({ kind: 'not-up' })
    expect(run.session(R)).toBeUndefined()
    const direct = await openDirect(unmatchedEntry(), bindingOf(run))

    expectRefused(
      await observe(() => direct.call(SET_CHANNEL_DELIVERY_TOOL, { channel: R_DEST, delivery: 'all' }), { run, direct }),
      sessionNotMatchedRefusal(SET_CHANNEL_DELIVERY_TOOL),
    )

    await hear(run, P, plainMessage(PUBLIC))
    expectAccepted(
      await observeSet(run, P, { channel: PUBLIC, delivery: 'all' }),
      setResult(PUBLIC, 'all', 'all', false),
      setLine(run, P, PUBLIC, undefined, 'all', 'all'),
    )
  })

  test('a key that is no applied persona\'s gets the unapplied refusal, the one reply gets for its own name', async () => {
    const { run } = await startFungible()
    await hear(run, P, plainMessage(PUBLIC))
    run.registerSession('ghost')
    const ghost = personaKey('ghost')

    expectRefused(await observeSet(run, 'ghost', { channel: PUBLIC, delivery: 'all' }), personaNotAppliedRefusal(SET_CHANNEL_DELIVERY_TOOL, ghost))
    expectRefused(
      await observe(() => callOther(run, 'ghost', 'reply', { chat_id: PUBLIC, text: 'hello' }), { run }),
      personaNotAppliedRefusal('reply', ghost),
    )
  })

  test('a retiring key gets the unapplied refusal; once its retiring ends the same call is accepted', async () => {
    const { run } = await startFungible()
    await hear(run, P, plainMessage(PUBLIC))
    const key = personaKey(P)
    const args = { channel: PUBLIC, delivery: 'all' }

    run.channelDelivery.beginRetiring([key])
    expectRefused(await observeSet(run, P, args), personaNotAppliedRefusal(SET_CHANNEL_DELIVERY_TOOL, key))

    run.channelDelivery.endRetiring([key])
    expectAccepted(await observeSet(run, P, args), setResult(PUBLIC, 'all', 'all', false), setLine(run, P, PUBLIC, undefined, 'all', 'all'))
  })

  test.each<[string, (run: ReloadRun) => Promise<void>]>([
    ['dropped by dropPersonaSession', async () => void (await dropPersonaSession(personaKey(P)))],
    ['replaced by a later registration for the same key', async (run) => void run.registerSession(P)],
  ])('a session the registry does not hold (%s) gets the unapplied refusal; the current session is accepted', async (_label, unhold) => {
    const { run } = await startFungible()
    await hear(run, P, plainMessage(PUBLIC))
    const kept = run.session(P)!
    const args = { channel: PUBLIC, delivery: 'all' }

    await unhold(run)
    expect(run.session(P)).not.toBe(kept)
    expectRefused(await observeSet(run, P, args, kept), personaNotAppliedRefusal(SET_CHANNEL_DELIVERY_TOOL, personaKey(P)))

    if (run.session(P) === undefined) run.registerSession(P)
    expectAccepted(await observeSet(run, P, args), setResult(PUBLIC, 'all', 'all', false), setLine(run, P, PUBLIC, undefined, 'all', 'all'))
  })

  test.each<[string, 'unmatched' | 'unapplied', () => Promise<ReloadRun>]>([
    ['an unmatched session in declarative mode', 'unmatched', async () => (await startDeclarative()).run],
    ['an unmatched session with an unreadable store', 'unmatched', async () => (await startFungible({ unreadable: true })).run],
    ['an unapplied key in declarative mode', 'unapplied', async () => (await startDeclarative()).run],
    ['an unapplied key with an unreadable store', 'unapplied', async () => (await startFungible({ unreadable: true })).run],
  ])('%s gets the resolution refusal, not an SRI-503 refusal', async (_label, form, start) => {
    const run = await start()
    const args = { channel: NEVER_HEARD, delivery: BAD_DELIVERY }

    if (form === 'unmatched') {
      const direct = await openDirect(unmatchedEntry(), bindingOf(run))
      expectRefused(await observe(() => direct.call(SET_CHANNEL_DELIVERY_TOOL, args), { run, direct }), sessionNotMatchedRefusal(SET_CHANNEL_DELIVERY_TOOL))
    } else {
      run.registerSession('ghost')
      expectRefused(await observeSet(run, 'ghost', args), personaNotAppliedRefusal(SET_CHANNEL_DELIVERY_TOOL, personaKey('ghost')))
    }
  })

  test('source audit: the handler is not async and nothing is awaited from the call\'s resolution to the store write, and the audit fails on altered source', () => {
    const code = stripComments(readFileSync(join(import.meta.dir, '..', 'src', 'registry.ts'), 'utf-8'))
    expect(synchronousStretchFindings(code)).toEqual([])

    const asyncHandler = code.replace('function setChannelDelivery(', 'async function setChannelDelivery(')
    const awaitBeforeWrite = insertedAfterBrace(code, 'function setChannelDelivery(', ' await null; ')
    const awaitBeforeDispatch = insertedAfterBrace(code, 'setRequestHandler(CallToolRequestSchema', ' await null; ')
    for (const altered of [asyncHandler, awaitBeforeWrite, awaitBeforeDispatch]) {
      expect(altered).not.toBe(code)
      expect(synchronousStretchFindings(altered)).not.toEqual([])
    }
    expect(synchronousStretchFindings(asyncHandler)).toEqual(['setChannelDelivery is async'])
    expect(synchronousStretchFindings(awaitBeforeWrite)).toEqual(['an await comes before the store.set( write'])
    expect(synchronousStretchFindings(awaitBeforeDispatch)).toEqual(['an await comes before the CallTool handler calls setChannelDelivery'])
  })
})

// ---------------------------------------------------------------------------
// S3: rules 1 and 2, and the order (SRI-503, SRI-404 tool side)
// ---------------------------------------------------------------------------

/** SRI-503's rules, by number: the refusal each gives P, built for persona `persona` and the call's values. */
function ruleRefusal(rule: 1 | 2 | 3 | 4, persona: Persona, args: { channel: unknown; delivery: unknown }): string {
  switch (rule) {
    case 1:
      return channelDeliveryDeclarativeRefusal(persona.name, persona.key)
    case 2:
      return channelDeliveryUnreadableRefusal(persona.name, persona.key, h.channelDeliveryFile)
    case 3:
      return channelDeliveryValueRefusal(persona.name, persona.key, args.delivery)
    case 4:
      return channelDeliveryChannelRefusal(persona.name, persona.key, args.channel)
  }
}

describe('rule 1, declarative mode, and rule 2, the store unreadable (b.deo SRI-503, SRI-404 tool side)', () => {
  test.each<[string, (listed: string) => string]>([
    ['the listed channel, which is in its posting scope', (listed) => listed],
    ['an unlisted channel', () => NEVER_HEARD],
  ])('declarative mode: a call for %s gets rule 1\'s refusal; no stored-choice file is created and config.json is unchanged', async (_label, channelOf) => {
    const { run, listed } = await startDeclarative()
    const persona = applied(run, P)
    const channel = channelOf(listed)
    if (channel === listed) expect(checkPersonaTarget(persona, channel, 'post', 'declarative')).toEqual({ allowed: true, kind: 'channel' })

    expectRefused(await observeSet(run, P, { channel, delivery: 'all' }), ruleRefusal(1, persona, { channel, delivery: 'all' }))
    expect(existsSync(h.channelDeliveryFile)).toBe(false)
  })

  test('fungible mode with an unreadable store: a heard channel gets rule 2\'s refusal naming the file; its bytes are unchanged', async () => {
    const { run } = await startFungible({ unreadable: true })
    await hear(run, P, plainMessage(PUBLIC))
    const persona = applied(run, P)

    const o = await observeSet(run, P, { channel: PUBLIC, delivery: 'all' })

    expectRefused(o, ruleRefusal(2, persona, { channel: PUBLIC, delivery: 'all' }))
    expect(o.file.after).toEqual(Buffer.from(UNREADABLE_BYTES))
  })

  test('fungible mode with no store bound: rule 2\'s refusal names the file name', async () => {
    const config = makeMultiPersonaConfig([{ name: P, invited: { permission_prompts: P_DEST } }], h.root, { allow_invited_channels: true })
    const persona = config.personas[0]!
    const entry = registerSession(persona.working_directory, persona.key, fakeTransport(), fakeServer())
    const direct = await openDirect(entry, { mode: () => 'fungible', personas: () => config.personas, store: () => undefined })

    expectRefused(
      await observe(() => direct.call(SET_CHANNEL_DELIVERY_TOOL, { channel: PUBLIC, delivery: 'all' }), { direct }),
      channelDeliveryUnreadableRefusal(persona.name, persona.key, CHANNEL_DELIVERY_FILE_NAME),
    )
  })

  test('the texts carry what the SRD names: the persona in rules 1 to 4; the operator\'s config.json in rule 1; the file and the move-aside-and-restart fix in rule 2; the value not shown, and absent, in rules 3 and 4\'s not-shown forms; the result\'s channel, choice and delivery, with the loop guard and the fungible destination only when held', () => {
    const name = 'Delta Bot'
    const key = personaKey(name)
    const ref = renderPersonaRef(name, key)
    const path = join(h.stateDir, CHANNEL_DELIVERY_FILE_NAME)
    const declarative = channelDeliveryDeclarativeRefusal(name, key)
    const unreadable = channelDeliveryUnreadableRefusal(name, key, path)
    const [beforePath, afterPath] = unreadable.split(JSON.stringify(path)) as [string, string]

    expect(declarative).toContain(ref)
    expect(declarative).toContain('declarative mode')
    expect(declarative).toContain('operator')
    expect(declarative).toContain(CONFIG_FILE_NAME)
    expect(unreadable.split(JSON.stringify(path))).toHaveLength(2)
    expect(beforePath).toContain(ref)
    expect(afterPath).toMatch(/\baside\b.*\brestart/)

    // Rules 3 and 4: the persona in both forms; a value that is not echoable
    // gives the not-shown form, which says so and holds no part of the value.
    const notEchoed = [
      [channelDeliveryValueRefusal, 'all!', 'ALL'],
      [channelDeliveryChannelRefusal, 'c0lowercase1', NEVER_HEARD],
    ] as const
    for (const [refusal, hidden, echoed] of notEchoed) {
      const notShown = refusal(name, key, hidden)
      expect(refusal(name, key, echoed)).toContain(ref)
      expect(notShown).toContain(ref)
      expect(notShown).toBe(refusal(name, key, undefined))
      expect(notShown).toMatch(/\bnot shown\b/)
      expect(notShown.toLowerCase()).not.toContain(hidden.toLowerCase())
    }

    // The result (SRI-504): the channel, the stored choice and the delivery as
    // whole words; the held form also names the loop guard and the fungible
    // destination, the not-held form neither.
    const word = (text: string, w: string): boolean => new RegExp(`\\b${w}\\b`).test(text)
    const held = setResult(Q_DEST, 'all', 'mentions', true)
    const notHeld = setResult(Q_DEST, 'all', 'all', false)
    expect([Q_DEST, 'all', 'mentions', 'fungible destination', 'loop guard'].map((w) => word(held, w))).toEqual([true, true, true, true, true])
    expect([Q_DEST, 'all', 'fungible destination', 'loop guard'].map((w) => word(notHeld, w))).toEqual([true, true, false, false])
    expect(held).not.toBe(notHeld)
  })

  // Each row breaks the rules it names and no other; the first one gives the
  // error. A rule-1 row starts fungible, hears its channel, then a confirmed
  // change turns the switch off (the routing keeps its heard sets across a
  // switch change, b.deo SRI-307, so the channel stays known); a rule-2 row
  // starts over unreadable bytes.
  test.each<[string, { declarative: boolean; unreadable: boolean; badDelivery: boolean; unknownChannel: boolean; first: 1 | 2 | 3 }]>([
    ['1+2', { declarative: true, unreadable: true, badDelivery: false, unknownChannel: false, first: 1 }],
    ['1+3', { declarative: true, unreadable: false, badDelivery: true, unknownChannel: false, first: 1 }],
    ['1+4', { declarative: true, unreadable: false, badDelivery: false, unknownChannel: true, first: 1 }],
    ['2+3', { declarative: false, unreadable: true, badDelivery: true, unknownChannel: false, first: 2 }],
    ['2+4', { declarative: false, unreadable: true, badDelivery: false, unknownChannel: true, first: 2 }],
    ['3+4', { declarative: false, unreadable: false, badDelivery: true, unknownChannel: true, first: 3 }],
    ['1+2+3+4', { declarative: true, unreadable: true, badDelivery: true, unknownChannel: true, first: 1 }],
  ])('order: a call breaking rules %s gets the first rule\'s refusal', async (_rules, row) => {
    const rig = await startFungible({ unreadable: row.unreadable, switchable: true })
    await hear(rig.run, P, plainMessage(PUBLIC))
    if (row.declarative) await turnSwitchOff(rig)
    const args = { channel: row.unknownChannel ? NEVER_HEARD : PUBLIC, delivery: row.badDelivery ? BAD_DELIVERY : 'all' }

    expectRefused(await observeSet(rig.run, P, args), ruleRefusal(row.first, applied(rig.run, P), args))
  })
})

// ---------------------------------------------------------------------------
// S4: rules 3 and 4, their echo rules, and the known channels (SRI-503)
// ---------------------------------------------------------------------------

/** No `delivery` given. */
const MISSING = Symbol('missing')

/** The call's arguments with `channel` and `delivery`, either left out when `MISSING`. */
function argsOf(channel: unknown, delivery: unknown): Record<string, unknown> {
  return {
    ...(channel === MISSING ? {} : { channel }),
    ...(delivery === MISSING ? {} : { delivery }),
  }
}

describe('rule 3, delivery, and rule 4, the channel, with their echo rules (b.deo SRI-503)', () => {
  // Echoed: the SRD's rule, a string matching ECHOABLE_KEY_NAME_RE, stated per row.
  test.each<[string, unknown, boolean]>([
    ['missing', MISSING, false],
    ['a number', 3, false],
    ['null', null, false],
    ['"none"', 'none', true],
    ['"ALL", an echoable wrong value', 'ALL', true],
    ['"all!", a string that is not echoable', 'all!', false],
  ])('delivery %s: rule 3\'s refusal, the value echoed: %p', async (_label, delivery, echoed) => {
    const { run } = await startFungible()
    await hear(run, P, plainMessage(PUBLIC))
    const persona = applied(run, P)
    const notShown = channelDeliveryValueRefusal(persona.name, persona.key, undefined)

    const o = await observeSet(run, P, argsOf(PUBLIC, delivery))

    expectRefused(o, ruleRefusal(3, persona, { channel: PUBLIC, delivery: delivery === MISSING ? undefined : delivery }))
    if (echoed) {
      expect(o.result.text).toContain(JSON.stringify(delivery))
      expect(o.result.text).not.toBe(notShown)
    } else {
      expect(o.result.text).toBe(notShown)
    }
  })

  // Echoed: the SRD's rule, a string of 1 to 24 characters from A-Z0-9, stated per row.
  test.each<[string, unknown, (run: ReloadRun) => Promise<void>, boolean]>([
    ['a C… ID never heard', NEVER_HEARD, async () => {}, true],
    ['a channel only Q has heard', Q_ONLY, async (run) => hear(run, Q, plainMessage(Q_ONLY)), true],
    ['an externally shared channel delivered to P, never heard by the fungible path', EXT_SHARED, async (run) => hear(run, P, plainMessage(EXT_SHARED), ENVELOPE_FLAG_FORMS.true), true],
    ['a group DM (G… from an mpim event) delivered to P', GROUP_DM, async (run) => hear(run, P, makeGroupDmMessage({ channel: GROUP_DM, user: AUTHOR })), true],
    ['a D… ID', DM_ID, async () => {}, true],
    ['a malformed ID', MALFORMED, async () => {}, true],
    ['a missing value', MISSING, async () => {}, false],
    ['a non-string value', 42, async () => {}, false],
    ['exactly 24 echoable characters', `C0${'X'.repeat(22)}`, async () => {}, true],
    ['25 echoable characters', `C0${'X'.repeat(23)}`, async () => {}, false],
    ['a lowercase ID', 'c0lowercase1', async () => {}, false],
    ['the empty string', '', async () => {}, false],
  ])('channel: %s gets rule 4\'s refusal, echoed: %p', async (_label, channel, setUp, echoed) => {
    const { run } = await startFungible()
    await setUp(run)
    const persona = applied(run, P)
    const notShown = channelDeliveryChannelRefusal(persona.name, persona.key, undefined)

    const o = await observeSet(run, P, argsOf(channel, 'all'))

    expectRefused(o, ruleRefusal(4, persona, { channel: channel === MISSING ? undefined : channel, delivery: 'all' }))
    if (echoed) {
      expect(o.result.text).toContain(JSON.stringify(channel))
      expect(o.result.text).not.toBe(notShown)
    } else {
      expect(o.result.text).toBe(notShown)
    }
  })

  test.each<[string, string, (run: ReloadRun) => Promise<void>, DeliveryMode | undefined]>([
    ['a public channel P heard', PUBLIC, (run) => hear(run, P, plainMessage(PUBLIC)), undefined],
    ['a private channel (G… from a group event) P heard', PRIVATE, (run) => hear(run, P, makePrivateChannelMessage({ channel: PRIVATE, user: AUTHOR })), undefined],
    ['a channel known only from P\'s seeded stored choice, not heard this run', SEEDED, async () => {}, 'mentions'],
  ])('%s is known: the call is accepted', async (_label, channel, setUp, seeded) => {
    const { run } = await startFungible({
      seed: seeded === undefined ? undefined : (inputs) => ({
        [personaKey(P)]: { declaration: declarationOf(inputs[P]!), channels: { [channel]: { delivery: seeded } } },
      }),
    })
    if (seeded !== undefined) expect(run.channelDelivery.storedChoice(personaKey(P), channel)).toBe(seeded)
    await setUp(run)

    expectAccepted(await observeSet(run, P, { channel, delivery: 'all' }), setResult(channel, 'all', 'all', false), setLine(run, P, channel, seeded, 'all', 'all'))
  })
})

// ---------------------------------------------------------------------------
// S5: secrecy (SRI-1304, SRI-907)
// ---------------------------------------------------------------------------

describe('LEAK_SENTINEL and a fake token, as delivery and as channel, appear in no tool error (b.deo SRI-1304, SRI-907)', () => {
  test.each<[string, Record<string, unknown>, 3 | 4]>([
    ['LEAK_SENTINEL as delivery', { channel: PUBLIC, delivery: LEAK_SENTINEL }, 3],
    ['a fake bot token as delivery', { channel: PUBLIC, delivery: fakeToken(BOT_TOKEN_PREFIX, 'delivery') }, 3],
    // LEAK_SENTINEL is 1 to 24 characters of A-Z0-9, so rule 4 echoes it bare
    // by design (SRI-503); as `channel` it is passed with a hyphen added, the
    // form a pasted secret would not be echoed in. assertNoLeak matches it in
    // any letter case.
    ['LEAK_SENTINEL in a non-echoable form as channel', { channel: `${LEAK_SENTINEL}-channel`, delivery: 'all' }, 4],
    ['a fake app token as channel', { channel: fakeToken(APP_TOKEN_PREFIX, 'channel'), delivery: 'all' }, 4],
  ])('%s: refused by the rule that inspects it, the value not shown, no leak', async (_label, args, rule) => {
    const { run } = await startFungible()
    await hear(run, P, plainMessage(PUBLIC))
    const persona = applied(run, P)
    const notShown = rule === 3
      ? channelDeliveryValueRefusal(persona.name, persona.key, undefined)
      : channelDeliveryChannelRefusal(persona.name, persona.key, undefined)

    const o = await observeSet(run, P, args)

    expectRefused(o, ruleRefusal(rule, persona, { channel: args['channel'], delivery: args['delivery'] }))
    expect(o.result.text).toBe(notShown)
    assertNoLeak(o.result, 'set_channel_delivery tool error')
    assertNoLeak(run.captured({ result: o.result }), 'set_channel_delivery run')
  })
})

// ---------------------------------------------------------------------------
// S6: accepted calls (SRI-504, SRI-501, SRI-404 tool side)
// ---------------------------------------------------------------------------

describe('an accepted call (b.deo SRI-504, SRI-404 tool side)', () => {
  test('the first accepted call creates the file in one write: P\'s key, the channel, all, set_at from the clock and the applied declaration; the result names the delivery', async () => {
    const { run } = await startFungible()
    await hear(run, P, plainMessage(PUBLIC))
    expect(storedChoiceBytes()).toBeNull()
    const persona = applied(run, P)

    const o = await observeSet(run, P, { channel: PUBLIC, delivery: 'all' })

    expectAccepted(o, setResult(PUBLIC, 'all', 'all', false), setLine(run, P, PUBLIC, undefined, 'all', 'all'))
    expect(o.file.before).toBeNull()
    expect(h.readChannelDelivery()).toEqual(
      channelDeliveryRecordOf({
        [persona.key]: {
          declaration: channelDeliveryDeclarationOf(persona),
          channels: { [PUBLIC]: { delivery: 'all', set_at: new Date(run.clock.now()).toISOString() } },
        },
      }),
    )
  })

  test('the choice decides the next event: a plain message is not delivered before, delivered as receive_all after all, and not delivered after mentions', async () => {
    const { run } = await startFungible()
    await hear(run, P, plainMessage(PUBLIC))
    expect(deliveredSince(run, NO_DELIVERIES)).toEqual(onlyToP([]))

    expectAccepted(await observeSet(run, P, { channel: PUBLIC, delivery: 'all' }), setResult(PUBLIC, 'all', 'all', false), setLine(run, P, PUBLIC, undefined, 'all', 'all'))
    let from = deliveryCheckpoint(run)
    await hear(run, P, plainMessage(PUBLIC))
    expect(deliveredSince(run, from)).toEqual(onlyToP([[PUBLIC, 'receive_all' satisfies Via]]))

    expectAccepted(await observeSet(run, P, { channel: PUBLIC, delivery: 'mentions' }), setResult(PUBLIC, 'mentions', 'mentions', false), setLine(run, P, PUBLIC, 'all', 'mentions', 'mentions'))
    from = deliveryCheckpoint(run)
    await hear(run, P, plainMessage(PUBLIC))
    expect(deliveredSince(run, from)).toEqual(onlyToP([]))
  })

  test('the value already stored is accepted and written again, with a later set_at', async () => {
    const { run } = await startFungible()
    await hear(run, P, plainMessage(PUBLIC))
    const args = { channel: PUBLIC, delivery: 'all' }
    expectAccepted(await observeSet(run, P, args), setResult(PUBLIC, 'all', 'all', false), setLine(run, P, PUBLIC, undefined, 'all', 'all'))
    await run.clock.advance(60_000)

    expectAccepted(await observeSet(run, P, args), setResult(PUBLIC, 'all', 'all', false), setLine(run, P, PUBLIC, 'all', 'all', 'all'))
    expect(h.readChannelDelivery()!.get(personaKey(P))!.channels.get(PUBLIC)).toEqual({
      delivery: 'all',
      set_at: new Date(run.clock.now()).toISOString(),
    })
  })

  test.each<[string, string, DeliveryMode, boolean]>([
    ['Q\'s fungible destination: held at mentions by the loop guard', Q_DEST, 'mentions', true],
    ['P\'s own fungible destination: all, not held', P_DEST, 'all', false],
  ])('P stores all for %s', async (_label, channel, delivery, held) => {
    const { run } = await startFungible()
    await hear(run, P, plainMessage(channel))

    expectAccepted(await observeSet(run, P, { channel, delivery: 'all' }), setResult(channel, 'all', delivery, held), setLine(run, P, channel, undefined, 'all', delivery))
    expect(run.channelDelivery.storedChoice(personaKey(P), channel)).toBe('all')
  })
})

// ---------------------------------------------------------------------------
// S7: the persona-channel-delivery-set line (SRI-505, SRI-902)
// ---------------------------------------------------------------------------

describe('one persona-channel-delivery-set line per accepted call (b.deo SRI-505, SRI-902)', () => {
  // SRI-902 gives no exact text: the one pin of the line, its class label and
  // `none` typed here as the SRD names them; every other case builds the
  // line through the builders (expectAccepted). The built lines of a second
  // call (before `all`, after `mentions`), of the same value again (before
  // and after `all`) and of the loop guard (delivery `mentions`) are asserted
  // by the accepted-call cases above, each call's only logged line.
  test('pin: P\'s first accepted call logs the built line, naming P, the channel, none, all and the delivery after the loop guard, with no message text, user ID or token', async () => {
    const { run } = await startFungible()
    const text = 'a message text the line never carries'
    await hear(run, P, plainMessage(PUBLIC, { text }))
    const persona = applied(run, P)

    const o = await observeSet(run, P, { channel: PUBLIC, delivery: 'all' })

    const line = setLine(run, P, PUBLIC, undefined, 'all', 'all')
    expectAccepted(o, setResult(PUBLIC, 'all', 'all', false), line)
    expect(PERSONA_CHANNEL_DELIVERY_SET).toBe('persona-channel-delivery-set')
    expect(NO_STORED_CHOICE).toBe('none')
    expect(line.startsWith(`[slack] ${PERSONA_CHANNEL_DELIVERY_SET}: personas[${persona.index}] ${renderPersonaRef(persona.name, persona.key)}`)).toBe(true)
    // The line's cause is escaped (escapeCause), so the open parts are split at the escaped marker.
    const parts = formatPersonaDiagnostic({
      class: PERSONA_CHANNEL_DELIVERY_SET,
      name: persona.name,
      key: persona.key,
      index: persona.index,
      cause: channelDeliverySetCause(LINE_HOLE, LINE_HOLE as DeliveryMode, LINE_HOLE as DeliveryMode, LINE_HOLE as DeliveryMode),
    }).split(escapeCause(LINE_HOLE))
    expect(parts).toHaveLength(5)
    // The channel, the choice before (none), after (all) and the delivery after the loop guard (all), each in its place.
    const filled = [PUBLIC, NO_STORED_CHOICE, 'all', 'all']
    expect(parts.map((part, i) => `${part}${filled[i] ?? ''}`).join('')).toBe(line)
    expect(line).not.toContain(text)
    expect(line).not.toContain(AUTHOR)
    assertNoLeak(line, 'persona-channel-delivery-set line')
  })

  test('a run mixing refused and accepted calls logs exactly one line per accepted call, none for a refused one, and posts nothing', async () => {
    const { run } = await startFungible()
    await hear(run, P, plainMessage(PUBLIC))
    const calls: Array<Record<string, unknown>> = [
      { channel: PUBLIC, delivery: BAD_DELIVERY },
      { channel: PUBLIC, delivery: 'all' },
      { channel: NEVER_HEARD, delivery: 'all' },
      { channel: PUBLIC, delivery: 'mentions' },
      { channel: PUBLIC },
    ]
    const cp = run.checkpoint()

    for (const args of calls) await setDelivery(run, P, args)

    expect(run.since(cp).logs).toEqual([
      setLine(run, P, PUBLIC, undefined, 'all', 'all'),
      setLine(run, P, PUBLIC, 'all', 'mentions', 'mentions'),
    ])
    expect(run.since(cp).slackCalls).toEqual([])
    expect(run.slackPosts()).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// S8: a failed write (SRI-506, SRI-404 tool side)
// ---------------------------------------------------------------------------

describe('a failed write (b.deo SRI-506, SRI-404 tool side)', () => {
  /** The tool error a failed write gives P, checked for the persona and the file. */
  function expectWriteFailedError(o: Observation, persona: Persona): void {
    const text = channelDeliveryWriteFailedText(persona.name, persona.key, h.channelDeliveryFile)
    expect(o.result).toEqual({ isError: true, text })
    expect(text).toContain(renderPersonaRef(persona.name, persona.key))
    expect(text).toContain(JSON.stringify(h.channelDeliveryFile))
  }

  /** The one log line of a failed call: the store's, no `persona-channel-delivery-set` line, no Slack call. */
  function expectOneStoreLine(o: Observation, codes: readonly string[], writes: readonly ReloadWriteRecord[], removes: readonly ReloadRemoveRecord[]): void {
    expect(o.activity.logs).toHaveLength(1)
    expectWriteFailedLine(o.activity.logs[0]!, personaKey(P), PUBLIC, codes)
    expect(o.activity.logs[0]!.startsWith(`[slack] ${PERSONA_CHANNEL_DELIVERY_SET}: `)).toBe(false)
    expectOnly(o, { logs: o.activity.logs, writes: [...writes], removes: [...removes] })
  }

  test('a store that refuses the input it would write (its invalid answer, the set_at field): the not-stored tool error, no file, no line, no Slack call', async () => {
    const config = makeMultiPersonaConfig([{ name: P, invited: { permission_prompts: P_DEST } }], h.root, { allow_invited_channels: true })
    const persona = config.personas[0]!
    const entry = registerSession(persona.working_directory, persona.key, fakeTransport(), fakeServer())
    const sets: unknown[][] = []
    const store: SessionChannelDeliveryStore = {
      path: h.channelDeliveryFile,
      readable: true,
      storedChoice: (key, channel) => (key === persona.key && channel === SEEDED ? 'mentions' : undefined),
      storedChannels: (key) => (key === persona.key ? [SEEDED] : []),
      isRetiring: () => false,
      set: (...args) => {
        sets.push(args)
        return { kind: CHANNEL_DELIVERY_SET_INVALID, field: 'set_at' }
      },
    }
    const direct = await openDirect(entry, { mode: () => 'fungible', personas: () => config.personas, store: () => store })

    expectRefused(
      await observe(() => direct.call(SET_CHANNEL_DELIVERY_TOOL, { channel: SEEDED, delivery: 'all' }), { direct }),
      channelDeliveryNotStoredText(persona.name, persona.key, 'set_at'),
    )
    expect(sets).toEqual([[persona.key, SEEDED, 'all', channelDeliveryDeclarationOf(persona)]])
    expect(storedChoiceBytes()).toBeNull()
  })

  test.each<[string, Partial<WriteFailure>, readonly boolean[]]>([
    ['the write fails before the rename', { step: 'renameSync' }, [false]],
    ['the rename is not synced and the write-back succeeds', { step: 'fsyncSync', call: 2 }, [false, true]],
  ])('over a file holding P\'s earlier choice, %s: the tool error, one store line, the file and memory unchanged', async (_label, failure, writes) => {
    const { run } = await startFungible()
    await hear(run, P, plainMessage(PUBLIC))
    await setDelivery(run, P, { channel: PUBLIC, delivery: 'all' })
    const persona = applied(run, P)
    h.failChannelDeliveryWrites(failure)

    const o = await observeSet(run, P, { channel: PUBLIC, delivery: 'mentions' })

    expectWriteFailedError(o, persona)
    expectOneStoreLine(o, ['EIO'], writes.map((ok) => h.channelDeliveryWrite(ok)), [])
    expect(o.file.after).toEqual(o.file.before)
    expect(run.channelDelivery.storedChoice(persona.key, PUBLIC)).toBe('all')
    // Memory unchanged: the next plain message is delivered at all, as before, and
    // a later accepted call's line reports all as the choice before it.
    h.clearChannelDeliveryWriteFailure()
    const from = deliveryCheckpoint(run)
    await hear(run, P, plainMessage(PUBLIC))
    expect(deliveredSince(run, from)).toEqual(onlyToP([[PUBLIC, 'receive_all' satisfies Via]]))
    expectAccepted(await observeSet(run, P, { channel: PUBLIC, delivery: 'mentions' }), setResult(PUBLIC, 'mentions', 'mentions', false), setLine(run, P, PUBLIC, 'all', 'mentions', 'mentions'))
  })

  /** What the store's put-back did with the file it created: nothing to put back, removed it again, or failed to remove it. */
  type PutBack = 'none' | 'removed' | 'remove-failed'

  /** The run's delete call each put-back makes on the stored-choice file. */
  function removesOf(putBack: PutBack): ReloadRemoveRecord[] {
    if (putBack === 'none') return []
    return putBack === 'removed'
      ? [{ path: h.channelDeliveryFile, ok: true, removed: true, unsynced: false }]
      : [{ path: h.channelDeliveryFile, ok: false, removed: undefined, unsynced: false }]
  }

  test.each<[string, { write: Partial<WriteFailure>; remove?: Partial<WriteFailure> }, readonly string[], PutBack]>([
    ['the write fails before the rename: the file stays missing', { write: { step: 'renameSync' } }, ['EIO'], 'none'],
    ['the rename is not synced: the file, absent before, is removed again', { write: { step: 'fsyncSync', call: 2 } }, ['EIO'], 'removed'],
    [
      'the rename is not synced and removing it fails too: the refused choice stays on disk while memory does not hold it',
      { write: { step: 'fsyncSync', call: 2 }, remove: { code: 'EBUSY' } },
      ['EIO', 'EBUSY'],
      'remove-failed',
    ],
  ])('P\'s first call, the file missing: %s', async (_label, failures, codes, putBack) => {
    const { run } = await startFungible()
    await hear(run, P, plainMessage(PUBLIC))
    const persona = applied(run, P)
    h.failChannelDeliveryWrites(failures.write)
    if (failures.remove !== undefined) h.failRemoves(failures.remove)

    const o = await observeSet(run, P, { channel: PUBLIC, delivery: 'all' })

    expectWriteFailedError(o, persona)
    expectOneStoreLine(o, codes, [h.channelDeliveryWrite(false)], removesOf(putBack))
    expect(o.file.before).toBeNull()
    if (putBack === 'remove-failed') expect(h.readChannelDelivery()!.get(persona.key)!.channels.get(PUBLIC)!.delivery).toBe('all')
    else expect(o.file.after).toBeNull()
    expect(run.channelDelivery.storedChoice(persona.key, PUBLIC)).toBeUndefined()
    // Memory holds no choice: the next plain message is not delivered, and a
    // later accepted call's line reports none as the choice before it.
    h.clearChannelDeliveryWriteFailure()
    h.clearRemoveFailure()
    const from = deliveryCheckpoint(run)
    await hear(run, P, plainMessage(PUBLIC))
    expect(deliveredSince(run, from)).toEqual(onlyToP([]))
    expectAccepted(await observeSet(run, P, { channel: PUBLIC, delivery: 'mentions' }), setResult(PUBLIC, 'mentions', 'mentions', false), setLine(run, P, PUBLIC, undefined, 'mentions', 'mentions'))
  })
})

// ---------------------------------------------------------------------------
// S9: dry run (SRI-507)
// ---------------------------------------------------------------------------

describe('dry run: the same rules, the choice stored, no Slack call (b.deo SRI-507)', () => {
  test.each<[string, () => Promise<{ run: ReloadRun; args: Record<string, unknown>; rule: 1 | 4 }>]>([
    ['a declarative-mode call', async () => ({ run: (await startDeclarative()).run, args: { channel: PUBLIC, delivery: 'all' }, rule: 1 })],
    ['a call for an unknown channel', async () => ({ run: (await startFungible()).run, args: { channel: NEVER_HEARD, delivery: 'all' }, rule: 4 })],
  ])('%s gets the same refusal in dry run as outside it', async (_label, start) => {
    const { run, args, rule } = await start()
    const expected = ruleRefusal(rule, applied(run, P), { channel: args['channel'], delivery: args['delivery'] })
    expectRefused(await observeSet(run, P, args), expected)

    process.env['SLACK_DRY_RUN'] = '1'
    expectRefused(await observeSet(run, P, args), expected)
  })

  test('an accepted call in dry run writes the record, returns the result, logs its line and adds no call to any stub\'s log', async () => {
    const { run } = await startFungible()
    // The stubs exist and record calls: a mention delivered to P makes its users.info call.
    const before = run.stub(P).callLog.length
    await hear(run, P, plainMessage(PUBLIC, { text: `${mentionText(run.stub(P).identity.botUserId)} hello` }))
    expect(run.stub(P).callLog.slice(before).map((c) => c.method)).toEqual(['users.info'])
    const recorded = run.stub(P).callLog.length
    process.env['SLACK_DRY_RUN'] = '1'

    expectAccepted(await observeSet(run, P, { channel: PUBLIC, delivery: 'all' }), setResult(PUBLIC, 'all', 'all', false), setLine(run, P, PUBLIC, undefined, 'all', 'all'))
    expect(h.readChannelDelivery()!.get(personaKey(P))!.channels.get(PUBLIC)!.delivery).toBe('all')
    expect(run.stub(P).callLog).toHaveLength(recorded)
  })
})
