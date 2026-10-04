/**
 * clear-latch.test.ts — `clear-latch` (b.jg5 SRJ-509, SRJ-510): the server's
 * `POST /clear-latch` route, the `server.port` record and their wiring in
 * src/server.ts, and the command's lines, exit codes and request (`createCli`,
 * src/cli.ts).
 *
 * - The route: the real `handleClearLatch` (src/clear-latch.ts) over injected
 *   dependencies, a two-persona config from `makeMultiPersonaConfig`, a
 *   recording clear by hand answering true or false (or held pending, or
 *   rejecting) and a capturing logger. Real loopback requests run over a
 *   port-0 `Bun.serve` bound to 127.0.0.1 (`startClearLatchServer`, below,
 *   used by the route's and the command's loopback cases). The clear by hand
 *   itself, in P's serializer turn with its recovery post, `find-missing` and
 *   retry, is tests/conflict-latch.test.ts's.
 * - The record: write, read and removal in the test's own `mkdtempSync`
 *   directory standing in for the state directory, and the write-failure
 *   line (b.jg5 SRJ-1014) for a failed write whose error carries a fake
 *   token and URL: the path, the safe code and the redacted message.
 * - The wiring: `main()` cannot run in a test, so "the record holds the
 *   server's PID and bound port while it runs and is gone after shutdown" and
 *   the route's delegation are proven by a comment-stripped source audit of
 *   src/server.ts.
 * - The command: `createCli(…).clearLatch` over a local `CliDeps` whose
 *   members `clear-latch` must not use throw (the loaders, spawns, kill,
 *   director verbs, the credentials runner, the client init, `unlinkSync`), a
 *   recording dial with scripted answers, a `createFakeClock` clock and the
 *   same stand-in state directory: one pin table of SRJ-509's seven lines
 *   and its usage-text entry, one
 *   case per row with its exact stderr line and exit code, the PID-checked
 *   `server.port`, the bounded wait, an in-process run against the real
 *   handler and a real loopback run with the production dial. Every run checks
 *   that `clear-latch` writes and removes nothing. The usage text and the
 *   entry point are tests/cli.test.ts's, as is `stop`'s removal of
 *   `server.port` with the PID file.
 * - The production dial: `dialClearLatch` over a recording `ClearLatchRequest`
 *   (`fakeHttp`, below: fake `node:http` request and response emitters) for
 *   its options, body, answer and each way it rejects, and once for real
 *   against the port-0 listener with `HTTP_PROXY`/`http_proxy` naming a
 *   proxy the case holds that answers nothing and counts each connection
 *   (`holdResettingListener`, below), restored in `finally`. The same holder
 *   keeps a stopped server's released port, so the command's "cannot reach"
 *   run never dials a port another process may have taken.
 *
 * Every value compared (the route, the log lines, the causes, the cap, the
 * command's lines and wait) comes from src/; the response bodies are the
 * handler's own literals, and SRJ-509's lines are pinned once, in the pin
 * table. Every argument that must never be repeated is built with
 * `fakeToken`, and `assertNoLeak` runs over every captured line and response
 * body.
 *
 * SPDX-License-Identifier: MIT
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { EventEmitter } from 'node:events'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import type { ClientRequest, IncomingMessage, RequestOptions } from 'node:http'
import { createServer as createTcpServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import {
  CLEAR_LATCH_USAGE,
  CLEAR_LATCH_USAGE_ENTRY,
  CLEAR_LATCH_WAIT_MS,
  clearLatchCliClearedLine,
  clearLatchCliNoPersonaLine,
  clearLatchCliNoServerLine,
  clearLatchCliNotAnsweredLine,
  clearLatchCliNotConfirmedLine,
  clearLatchCliNotLatchedLine,
  clearLatchStatusCause,
  createCli,
  type CliDeps,
} from '../src/cli.ts'
import {
  CLEAR_LATCH_DIAL_HOST,
  CLEAR_LATCH_ROUTE,
  SERVER_PORT_CAUSE_ABSENT,
  SERVER_PORT_CAUSE_MALFORMED,
  SERVER_PORT_CAUSE_OTHER_PID,
  SERVER_PORT_CAUSE_OUT_OF_RANGE,
  SERVER_PORT_CAUSE_UNREADABLE,
  SERVER_PORT_FILE_NAME,
  clearLatchFailedLine,
  clearLatchNotLatchedLine,
  clearLatchRequestOptions,
  clearLatchUnknownPersonaLine,
  clearLatchUrl,
  dialClearLatch,
  handleClearLatch,
  readServerPortRecord,
  removeServerPortRecord,
  serverPortFilePath,
  serverPortRecordText,
  serverPortWriteFailedLine,
  writeServerPortRecord,
  type ClearLatchDeps,
  type ClearLatchDialAnswer,
  type ClearLatchRequest,
  type ServerPortRecord,
} from '../src/clear-latch.ts'
import type { PersonaConfig } from '../src/config.ts'
import { INTERJECT_BODY_CAP_BYTES } from '../src/interject.ts'
import { describeThrownValue } from '../src/persona-connection-errors.ts'
import { personaKey } from '../src/persona-identity.ts'
import { isProcessRunning } from '../src/pid.ts'
import { reloadFilePaths } from '../src/reload.ts'
import {
  BOT_TOKEN_PREFIX,
  LEAK_SENTINEL,
  REDACTED_SENTINEL_TAIL,
  assertNoLeak,
  fakeToken,
  sentinelInMessage,
} from './test-helpers/credentials.ts'
import { createFakeClock, type FakeClock } from './test-helpers/fake-clock.ts'
import { makeMultiPersonaConfig, makePersona, makePersonaConfigInput, writeConfigFile } from './test-helpers/persona-config.ts'
import {
  atMainTopLevel,
  balancedAfter,
  callArguments,
  callsOf,
  forbiddenServerLoads,
  importSource,
  indicesOf,
  insideMain,
  loadedConfigName,
  maskLiterals,
  objectProperties,
  onlyCallArguments,
  shutdownBody,
  splitTopLevel,
  stripComments,
} from './test-helpers/source-audit.ts'

// ---------------------------------------------------------------------------
// Fixture: persona A has a name with capitals and a space (its key is the
// hashed form, so a handler that cleared by name would fail), persona B a
// plain name (its key is its name).
// ---------------------------------------------------------------------------

const A_NAME = 'Planner Bot'
const A_KEY = personaKey(A_NAME)
const B_NAME = 'reviewer'
const B_KEY = personaKey(B_NAME)

/** A target no persona has, shaped like a token typed by mistake (SRJ-509: never repeated). */
const TYPO_TOKEN = fakeToken(BOT_TOKEN_PREFIX, 'typo')

let dir: string
let config: PersonaConfig | null
/** Keys the clear by hand was called with, in order. */
let clearCalls: string[]
/** What the recording clear by hand does for each call. */
let clearAnswer: (key: string) => Promise<boolean>
let logs: string[]
/** Every response body read in the test, for the leak check. */
let bodies: unknown[]

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cscb-clear-latch-'))
  config = makeMultiPersonaConfig([{ name: A_NAME }, { name: B_NAME }], dir)
  clearCalls = []
  clearAnswer = () => Promise.resolve(true)
  logs = []
  bodies = []
})

afterEach(() => {
  assertNoLeak({ logs, bodies })
  rmSync(dir, { recursive: true, force: true })
})

/** The handler's dependencies over the test's current state. */
function deps(): ClearLatchDeps {
  return {
    getPersonaConfig: () => config,
    clearByHand: (key) => {
      clearCalls.push(key)
      return clearAnswer(key)
    },
    log: (line) => logs.push(line),
  }
}

/** Call the handler directly. A string body is sent raw; anything else as JSON. */
function clearLatch(
  body: unknown,
  opts: { method?: string; remote?: string | null | undefined } = {},
): Promise<Response> {
  const method = opts.method ?? 'POST'
  const init: RequestInit = { method, headers: { 'Content-Type': 'application/json' } }
  if (method !== 'GET' && method !== 'HEAD' && body !== undefined) {
    init.body = typeof body === 'string' ? body : JSON.stringify(body)
  }
  const remote = 'remote' in opts ? opts.remote : '127.0.0.1'
  return handleClearLatch(new Request(`http://127.0.0.1${CLEAR_LATCH_ROUTE}`, init), remote, deps())
}

/** The response's status and JSON body; the body is kept for the leak check. */
async function answerOf(res: Response): Promise<{ status: number; body: unknown }> {
  const body: unknown = await res.json()
  bodies.push(body)
  return { status: res.status, body }
}

/** UTF-8 byte length. */
function byteLength(s: string): number {
  return new TextEncoder().encode(s).byteLength
}

/**
 * A body naming persona B of exactly `bytes` UTF-8 bytes, padded in an extra
 * field that opens with a two-byte character, so a character-counting cap
 * would get the boundary wrong.
 */
function bodyOfBytes(bytes: number): string {
  const head = 'é'
  const overhead = byteLength(JSON.stringify({ persona: B_NAME, pad: head }))
  const text = JSON.stringify({ persona: B_NAME, pad: head + 'x'.repeat(bytes - overhead) })
  expect(byteLength(text)).toBe(bytes)
  return text
}

// ---------------------------------------------------------------------------
// The real-server helper: the real handler on a port-0 listener bound to
// 127.0.0.1, handed the request and the caller's address as src/server.ts
// does. Never port 3100. Start it in `beforeAll` and stop it in `afterAll`.
// ---------------------------------------------------------------------------

/** A running `/clear-latch` listener: its bound port, the route's URL and its stop (settled once the port is released). */
interface ClearLatchServer {
  readonly port: number
  readonly url: string
  stop(): Promise<void>
}

/**
 * Serve the real `handleClearLatch` on `127.0.0.1`, port 0. `depsFor` is read
 * at each request, so a test's own state (config, clear answer, logger)
 * applies to the requests it makes.
 */
function startClearLatchServer(depsFor: () => ClearLatchDeps): ClearLatchServer {
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: (req, srv) => handleClearLatch(req, srv.requestIP(req)?.address, depsFor()),
  })
  const port = server.port
  if (port === undefined) throw new Error('startClearLatchServer: no bound port')
  return { port, url: `http://127.0.0.1:${port}${CLEAR_LATCH_ROUTE}`, stop: () => server.stop(true) }
}

/** A loopback TCP listener the case holds: every connection it accepts is counted and closed unanswered. */
interface ResettingListener {
  readonly port: number
  /** How many connections it has accepted. */
  hits(): number
  close(): Promise<void>
}

/**
 * Hold `port` (port 0: a fresh one) on {@link CLEAR_LATCH_DIAL_HOST} with a
 * listener that answers nothing: each connection is counted and destroyed, so
 * a request sent there fails and the case can tell it was sent there. While
 * it is held no other process can take the port. Rejects when the port cannot
 * be bound.
 */
async function holdResettingListener(port = 0): Promise<ResettingListener> {
  let hits = 0
  const listener = createTcpServer((socket) => {
    hits += 1
    socket.destroy()
  })
  await new Promise<void>((resolve, reject) => {
    listener.once('error', reject)
    listener.listen(port, CLEAR_LATCH_DIAL_HOST, () => {
      listener.off('error', reject)
      resolve()
    })
  })
  const address = listener.address()
  if (address === null || typeof address === 'string') throw new Error('holdResettingListener: no bound TCP port')
  return {
    port: address.port,
    hits: () => hits,
    close: () => new Promise<void>((resolve) => listener.close(() => resolve())),
  }
}

// ---------------------------------------------------------------------------
// The route (SRJ-510)
// ---------------------------------------------------------------------------

describe('POST /clear-latch: the route', () => {
  describe('405, 403 and 400: nothing cleared and no line logged', () => {
    test.each([
      ['GET', '127.0.0.1'],
      ['PUT', '127.0.0.1'],
      ['DELETE', '127.0.0.1'],
      ['PATCH', '127.0.0.1'],
      ['GET', '10.0.0.5'],
      ['PUT', '10.0.0.5'],
    ] as const)('%s from %s → 405 (the method is checked before the caller)', async (method, remote) => {
      const answer = await answerOf(await clearLatch({ persona: A_NAME }, { method, remote }))
      expect(answer).toEqual({ status: 405, body: { error: 'Method Not Allowed' } })
      expect(clearCalls).toEqual([])
      expect(logs).toEqual([])
    })

    test.each([['10.0.0.5'], ['192.168.1.20'], ['::ffff:10.0.0.5'], ['fe80::1'], [''], [null], [undefined]])(
      'remote address %p → 403, before the body is read (an invalid body still gets 403)',
      async (remote) => {
        for (const body of [{ persona: A_NAME }, 'not valid json {{{']) {
          const answer = await answerOf(await clearLatch(body, { remote }))
          expect(answer).toEqual({ status: 403, body: { error: 'Forbidden' } })
        }
        expect(clearCalls).toEqual([])
        expect(logs).toEqual([])
      },
    )

    test.each([
      ['missing persona', { other: A_NAME }],
      ['empty persona', { persona: '' }],
      ['numeric persona', { persona: 42 }],
      ['boolean persona', { persona: true }],
      ['null persona', { persona: null }],
      ['object persona', { persona: { name: A_NAME } }],
      ['array persona', { persona: [A_NAME] }],
      ['JSON array body', '[]'],
      ['JSON string body', JSON.stringify(A_NAME)],
      ['JSON number body', '42'],
      ['JSON null body', 'null'],
    ])('%s → 400 naming persona', async (_label, body) => {
      const answer = await answerOf(await clearLatch(body))
      expect(answer).toEqual({ status: 400, body: { error: 'Missing or invalid field: persona (string) required' } })
      expect(clearCalls).toEqual([])
      expect(logs).toEqual([])
    })

    test.each([['not valid json {{{'], ['']])('body %p → 400 Invalid JSON', async (body) => {
      const answer = await answerOf(await clearLatch(body))
      expect(answer).toEqual({ status: 400, body: { error: 'Invalid JSON' } })
      expect(clearCalls).toEqual([])
      expect(logs).toEqual([])
    })

    test('an unreadable body → 400', async () => {
      const stream = new ReadableStream({
        start(controller) {
          controller.error(new Error('the body stream failed'))
        },
      })
      const res = await handleClearLatch(
        new Request(`http://127.0.0.1${CLEAR_LATCH_ROUTE}`, { method: 'POST', body: stream }),
        '127.0.0.1',
        deps(),
      )
      expect(await answerOf(res)).toEqual({ status: 400, body: { error: 'Unreadable request body' } })
      expect(clearCalls).toEqual([])
      expect(logs).toEqual([])
    })

    test.each([
      [INTERJECT_BODY_CAP_BYTES, 200],
      [INTERJECT_BODY_CAP_BYTES + 1, 400],
    ])('a body of %i UTF-8 bytes (the cap is /interject\'s) → %i', async (bytes, status) => {
      const answer = await answerOf(await clearLatch(bodyOfBytes(bytes)))
      expect(answer.status).toBe(status)
      if (status === 400) {
        expect(answer.body).toEqual({ error: 'Request body too large (max 32KB)' })
        expect(clearCalls).toEqual([])
        expect(logs).toEqual([])
      } else {
        expect(clearCalls).toEqual([B_KEY])
      }
    })
  })

  describe('404: the argument is never repeated', () => {
    test.each([
      ['a token typed by mistake', () => TYPO_TOKEN, () => config],
      ['the name in another case', () => A_NAME.toUpperCase(), () => config],
      ["A's key with a trailing space", () => `${A_KEY} `, () => config],
      ['a config with zero personas', () => A_NAME, () => makeMultiPersonaConfig([], dir)],
      ['no persona config loaded', () => TYPO_TOKEN, () => null],
    ])('%s → 404, nothing cleared, one line without the argument', async (_label, target, build) => {
      config = build()
      const persona = target()
      const answer = await answerOf(await clearLatch({ persona }))
      expect(answer).toEqual({ status: 404, body: { error: 'Persona not found in the applied config' } })
      expect(clearCalls).toEqual([])
      expect(logs).toEqual([clearLatchUnknownPersonaLine()])
      expect(JSON.stringify(answer.body)).not.toContain(persona)
      expect(logs[0]).not.toContain(persona)
    })
  })

  describe('200: one clear by hand of that persona, answered with its result', () => {
    test.each([
      ['A by name', A_NAME, A_NAME, A_KEY, true],
      ['A by key', A_KEY, A_NAME, A_KEY, true],
      ['A by name, not latched', A_NAME, A_NAME, A_KEY, false],
      ['B by key, not latched', B_KEY, B_NAME, B_KEY, false],
      ['B by name', B_NAME, B_NAME, B_KEY, true],
    ] as const)('%s → 200 with cleared %p as the clear answered', async (_label, target, name, key, cleared) => {
      clearAnswer = () => Promise.resolve(cleared)
      const answer = await answerOf(await clearLatch({ persona: target }))
      expect(answer).toEqual({ status: 200, body: { ok: true, persona: name, cleared } })
      expect(clearCalls).toEqual([key])
      // A latched persona's clear logs only the clear entry's own line (not this handler's).
      expect(logs).toEqual(cleared ? [] : [clearLatchNotLatchedLine(name, key)])
      const other = name === A_NAME ? [B_NAME, B_KEY] : [A_NAME, A_KEY]
      for (const text of other) expect(JSON.stringify({ body: answer.body, logs })).not.toContain(text)
    })

    test('loopback callers 127.0.0.1, ::1 and ::ffff:127.0.0.1 are each served', async () => {
      for (const remote of ['127.0.0.1', '::1', '::ffff:127.0.0.1']) {
        expect((await answerOf(await clearLatch({ persona: A_NAME }, { remote }))).status).toBe(200)
      }
      expect(clearCalls).toEqual([A_KEY, A_KEY, A_KEY])
    })

    test('the 200 waits for the clear: a pending clear by hand leaves the response unsettled until it settles', async () => {
      const gate = Promise.withResolvers<boolean>()
      const called = Promise.withResolvers<void>()
      clearAnswer = () => {
        called.resolve()
        return gate.promise
      }
      let settled = false
      const pending = clearLatch({ persona: A_KEY }).then((res) => {
        settled = true
        return res
      })
      await called.promise
      for (let i = 0; i < 10; i++) await Promise.resolve()
      expect(settled).toBe(false)
      expect(clearCalls).toEqual([A_KEY])

      gate.resolve(true)
      expect(await answerOf(await pending)).toEqual({ status: 200, body: { ok: true, persona: A_NAME, cleared: true } })
      expect(clearCalls).toEqual([A_KEY])
    })
  })

  describe('500: a clear that fails unexpectedly', () => {
    test.each([
      ['rejects', (err: Error) => Promise.reject(err)],
      ['throws', (err: Error): Promise<boolean> => {
        throw err
      }],
    ])('a clear by hand that %s → 500 and one leak-free line naming the persona', async (_label, fail) => {
      const err = new Error(`clear failed (${sentinelInMessage('clear')})`)
      clearAnswer = () => fail(err)
      const answer = await answerOf(await clearLatch({ persona: A_NAME }))
      expect(answer).toEqual({ status: 500, body: { error: 'Internal Server Error' } })
      expect(clearCalls).toEqual([A_KEY])
      expect(logs).toEqual([clearLatchFailedLine(A_NAME, A_KEY, describeThrownValue(err))])
    })
  })

  describe('a real loopback request (port 0 on 127.0.0.1)', () => {
    let server: ClearLatchServer
    beforeAll(() => {
      server = startClearLatchServer(() => deps())
    })
    afterAll(async () => {
      await server.stop()
    })

    test('a POST naming A by key → 200 with the clear\'s answer; only A is cleared', async () => {
      clearAnswer = () => Promise.resolve(false)
      const res = await fetch(server.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ persona: A_KEY }),
      })
      expect(await answerOf(res)).toEqual({ status: 200, body: { ok: true, persona: A_NAME, cleared: false } })
      expect(clearCalls).toEqual([A_KEY])
      expect(logs).toEqual([clearLatchNotLatchedLine(A_NAME, A_KEY)])
    })
  })
})

// ---------------------------------------------------------------------------
// The server.port record (SRJ-510)
// ---------------------------------------------------------------------------

describe('the server.port record', () => {
  /** The record's path in the test's stand-in state directory. */
  const recordPath = (): string => serverPortFilePath(dir)

  test('it is server.port beside server.pid in the state directory, a JSON object of the PID and port and a newline', () => {
    expect(SERVER_PORT_FILE_NAME).toBe('server.port')
    expect(recordPath()).toBe(join(dir, 'server.port'))
    expect(dirname(recordPath())).toBe(dir)
    expect(serverPortRecordText({ pid: 4242, port: 3101 })).toBe('{"pid":4242,"port":3101}\n')
  })

  test('a write then a read for that PID gives back the PID and port; the file holds exactly the record\'s text and no temporary file is left', () => {
    const record: ServerPortRecord = { pid: process.pid, port: 54321 }
    writeServerPortRecord(recordPath(), record)
    expect(readServerPortRecord(recordPath(), process.pid)).toEqual({ ok: true, record })
    expect(readFileSync(recordPath(), 'utf-8')).toBe(serverPortRecordText(record))
    expect(readdirSync(dir)).toEqual([SERVER_PORT_FILE_NAME])
  })

  test('a second write replaces the first whole (a shorter record leaves no tail of the longer one)', () => {
    writeServerPortRecord(recordPath(), { pid: 1234567, port: 65535 })
    const second: ServerPortRecord = { pid: 7, port: 80 }
    writeServerPortRecord(recordPath(), second)
    expect(readFileSync(recordPath(), 'utf-8')).toBe(serverPortRecordText(second))
    expect(readServerPortRecord(recordPath(), 7)).toEqual({ ok: true, record: second })
    expect(readdirSync(dir)).toEqual([SERVER_PORT_FILE_NAME])
  })

  test('the write is one call of the injected write with the record\'s whole text, and nothing else is written', () => {
    const writes: Array<[string, string]> = []
    const record: ServerPortRecord = { pid: 99, port: 4000 }
    writeServerPortRecord(recordPath(), record, (path, contents) => writes.push([path, contents]))
    expect(writes).toEqual([[recordPath(), serverPortRecordText(record)]])
    expect(readdirSync(dir)).toEqual([])
  })

  // The default write is atomic (a temporary file, then a rename): the two
  // failures below each leave either the earlier record or nothing.
  test('a failed write is rethrown and leaves the earlier record whole', () => {
    const first: ServerPortRecord = { pid: 11, port: 3101 }
    writeServerPortRecord(recordPath(), first)
    mkdirSync(`${recordPath()}.tmp`) // the temporary file cannot be written
    expect(() => writeServerPortRecord(recordPath(), { pid: 12, port: 3102 })).toThrow()
    expect(readServerPortRecord(recordPath(), 11)).toEqual({ ok: true, record: first })
  })

  test('a failed rename is rethrown and removes the temporary file', () => {
    mkdirSync(recordPath())
    writeFileSync(join(recordPath(), 'occupant'), 'x') // a non-empty directory where the record goes
    expect(() => writeServerPortRecord(recordPath(), { pid: 13, port: 3103 })).toThrow()
    expect(readdirSync(dir)).toEqual([SERVER_PORT_FILE_NAME])
  })

  test('the write-failure line names the path and the described error', () => {
    expect(serverPortWriteFailedLine('/state/server.port', 'Error code=EACCES denied')).toBe(
      '[slack] server.port: could not write /state/server.port; clear-latch cannot reach this server until it restarts: Error code=EACCES denied',
    )
  })

  test('a write that fails is rethrown, and the line server.ts logs for it (the record\'s path and the error through describeThrownValue) holds the safe code and the redacted message; nothing leaks (SRJ-1014)', () => {
    // No stack frame, so the described error is known in full.
    const err = Object.assign(new Error(`write refused (${sentinelInMessage('port')})`), { code: 'EACCES', detail: LEAK_SENTINEL, stack: undefined })
    let thrown: unknown
    try {
      writeServerPortRecord(recordPath(), { pid: process.pid, port: 3101 }, () => {
        throw err
      })
    } catch (caught) {
      thrown = caught
    }
    expect(thrown).toBe(err)
    const line = serverPortWriteFailedLine(recordPath(), describeThrownValue(thrown))
    expect(line).toBe(serverPortWriteFailedLine(recordPath(), `Error code=EACCES message="write refused (${REDACTED_SENTINEL_TAIL})"`))
    expect(existsSync(recordPath())).toBe(false)
    logs.push(line)
  })

  describe('a record that cannot be used reads as its cause and never throws', () => {
    const EXPECTED_PID = 4242

    test('an absent file → absent', () => {
      expect(readServerPortRecord(recordPath(), EXPECTED_PID)).toEqual({ ok: false, cause: SERVER_PORT_CAUSE_ABSENT })
    })

    test('a file gone between the existence check and the read (ENOENT) → absent', () => {
      const fs = {
        existsSync: () => true,
        readFileSync: (): string => {
          throw Object.assign(new Error('gone'), { code: 'ENOENT' })
        },
      }
      expect(readServerPortRecord(recordPath(), EXPECTED_PID, fs)).toEqual({ ok: false, cause: SERVER_PORT_CAUSE_ABSENT })
    })

    test.each([
      ['a directory where the file goes (EISDIR)', null],
      ['a read refused (EACCES, injected)', 'EACCES'],
    ])('%s → unreadable', (_label, code) => {
      let read
      if (code === null) {
        mkdirSync(recordPath())
        read = readServerPortRecord(recordPath(), EXPECTED_PID)
      } else {
        read = readServerPortRecord(recordPath(), EXPECTED_PID, {
          existsSync: () => true,
          readFileSync: (): string => {
            throw Object.assign(new Error('denied'), { code })
          },
        })
      }
      expect(read).toEqual({ ok: false, cause: SERVER_PORT_CAUSE_UNREADABLE })
    })

    test.each([
      ['empty', ''],
      ['not JSON', 'not json {{{'],
      ['a token typed into it', `${TYPO_TOKEN}\n`],
      ['a JSON array', '[4242, 3101]'],
      ['JSON null', 'null'],
      ['a JSON number', '3101'],
      ['a JSON string', '"3101"'],
      ['no port', '{"pid":4242}'],
      ['no pid', '{"port":3101}'],
      ['a string port', '{"pid":4242,"port":"3101"}'],
      ['a string pid', '{"pid":"4242","port":3101}'],
      ['a null port', '{"pid":4242,"port":null}'],
    ])('%s → malformed', (_label, text) => {
      writeFileSync(recordPath(), text)
      const read = readServerPortRecord(recordPath(), EXPECTED_PID)
      expect(read).toEqual({ ok: false, cause: SERVER_PORT_CAUSE_MALFORMED })
      bodies.push(read)
    })

    test.each([
      ['port 0', 4242, '0'],
      ['port 65536', 4242, '65536'],
      ['a negative port', 4242, '-80'],
      ['a fractional port', 4242, '80.5'],
      ['an infinite port', 4242, '1e999'],
      ['pid 0', 0, '3101'],
      ['a negative pid', -1, '3101'],
      ['a fractional pid', 1.5, '3101'],
      ['a pid past the safe integers', 2 ** 53, '3101'],
    ])('%s → out of range', (_label, pid, port) => {
      writeFileSync(recordPath(), `{"pid":${pid},"port":${port}}\n`)
      expect(readServerPortRecord(recordPath(), EXPECTED_PID)).toEqual({ ok: false, cause: SERVER_PORT_CAUSE_OUT_OF_RANGE })
    })

    test('a record written by another PID is not used', () => {
      writeServerPortRecord(recordPath(), { pid: EXPECTED_PID + 1, port: 3101 })
      expect(readServerPortRecord(recordPath(), EXPECTED_PID)).toEqual({ ok: false, cause: SERVER_PORT_CAUSE_OTHER_PID })
    })

    test('the causes are CSCB\'s own distinct texts', () => {
      const causes = [
        SERVER_PORT_CAUSE_ABSENT,
        SERVER_PORT_CAUSE_UNREADABLE,
        SERVER_PORT_CAUSE_MALFORMED,
        SERVER_PORT_CAUSE_OUT_OF_RANGE,
        SERVER_PORT_CAUSE_OTHER_PID,
      ]
      expect(new Set(causes).size).toBe(causes.length)
      for (const cause of causes) expect(cause).toContain(SERVER_PORT_FILE_NAME)
    })
  })

  test.each([
    ['port 1', 1],
    ['port 65535', 65535],
  ])('%s is in range; extra keys are ignored', (_label, port) => {
    writeFileSync(recordPath(), `{"pid":4242,"port":${port},"bind":"0.0.0.0","extra":{"x":1}}\n`)
    expect(readServerPortRecord(recordPath(), 4242)).toEqual({ ok: true, record: { pid: 4242, port } })
  })

  test('removal deletes the record, and tolerates an absent file and a refused delete', () => {
    writeServerPortRecord(recordPath(), { pid: 5, port: 3101 })
    removeServerPortRecord(recordPath())
    expect(existsSync(recordPath())).toBe(false)
    expect(() => removeServerPortRecord(recordPath())).not.toThrow()
    const refused = {
      unlinkSync: (): void => {
        throw Object.assign(new Error('denied'), { code: 'EACCES' })
      },
    }
    expect(() => removeServerPortRecord(recordPath(), refused)).not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// The wiring in src/server.ts (static audit) and what src/clear-latch.ts loads
// ---------------------------------------------------------------------------

describe('src/server.ts wires the route and the record (static audit)', () => {
  // Comments stripped, so prose or commented-out code can never satisfy a
  // check; positions are found in the literal-masked text, so a log line that
  // names a call cannot either.
  const SERVER_CODE = stripComments(readFileSync(join(import.meta.dir, '..', 'src', 'server.ts'), 'utf-8'))
  const MASKED = maskLiterals(SERVER_CODE)

  /** Offsets of every call of `name` in the masked code. */
  const calls = (name: string): number[] => callsOf(MASKED, name)
  /** The offset of the only call of `name`; fails unless there is exactly one. */
  function onlyCall(name: string): number {
    const found = calls(name)
    expect(found).toHaveLength(1)
    return found[0]!
  }
  /** The [start, end) of the only call of `name`, its name to its closing parenthesis. */
  function onlyCallSpan(name: string): [number, number] {
    const at = onlyCall(name)
    return [at, balancedAfter(SERVER_CODE, at, '(', ')')[1] + 1]
  }
  /** The initializer text of the only `const <name> = …` declaration (whitespace collapsed, up to the line's end). */
  function constInitializer(name: string): { at: number; init: string } {
    const decls = indicesOf(new RegExp(`\\bconst\\s+${name}\\s*=`, 'g'), MASKED)
    expect(decls).toHaveLength(1)
    const eq = SERVER_CODE.indexOf('=', decls[0]!)
    const end = SERVER_CODE.indexOf('\n', eq)
    return { at: decls[0]!, init: SERVER_CODE.slice(eq + 1, end).replace(/\s+/g, ' ').trim() }
  }

  /** The `/clear-latch` branch of main()'s fetch: from its path test to the next path test. */
  function routeBranch(): { at: number; text: string } {
    const starts = indicesOf(/url\.pathname\s*===\s*CLEAR_LATCH_ROUTE\b/g, MASKED)
    expect(starts).toHaveLength(1)
    const next = MASKED.indexOf('url.pathname', starts[0]! + 1)
    return { at: starts[0]!, text: SERVER_CODE.slice(starts[0]!, next === -1 ? undefined : next) }
  }

  /** The record's path constant: the first argument of the only `writeServerPortRecord(` call. */
  function recordPathName(): string {
    return splitTopLevel(onlyCallArguments(MASKED, 'writeServerPortRecord'))[0]!
  }

  test('the route, the handler, the record\'s calls and the clear by hand are imported from their modules', () => {
    for (const name of ['CLEAR_LATCH_ROUTE', 'handleClearLatch', 'writeServerPortRecord', 'removeServerPortRecord', 'serverPortFilePath', 'serverPortWriteFailedLine']) {
      expect(importSource(SERVER_CODE, name)).toBe('./clear-latch.ts')
    }
    expect(importSource(SERVER_CODE, 'clearByHandOf')).toBe('./session-manager.ts')
    expect(SERVER_CODE).not.toContain(`'${CLEAR_LATCH_ROUTE}'`)
    expect(SERVER_CODE).not.toContain(`'${SERVER_PORT_FILE_NAME}'`)
  })

  test('main()\'s fetch has one /clear-latch branch, before the /mcp-only 404, returning the handler over the request, the caller\'s address and exactly the applied config and the clear by hand', () => {
    const branch = routeBranch()
    expect(insideMain(SERVER_CODE, branch.at)).toBe(true)
    const notMcp = indicesOf(/url\.pathname\s*!==\s*'\/mcp'/g, SERVER_CODE)
    expect(notMcp).toHaveLength(1)
    expect(branch.at).toBeLessThan(notMcp[0]!)

    expect(onlyCall('handleClearLatch')).toBeGreaterThan(branch.at)
    const args = splitTopLevel(callArguments(SERVER_CODE, onlyCall('handleClearLatch')))
    expect(args.slice(0, 2)).toEqual(['req', 'server.requestIP(req)?.address'])
    expect(branch.text).toMatch(/^url\.pathname\s*===\s*CLEAR_LATCH_ROUTE\s*\)\s*\{\s*return\s+handleClearLatch\(/)
    // No up check and no session lookup: a persona that is not up is not refused.
    const props = objectProperties(args[2]!)
    expect([...props.keys()].sort()).toEqual(['clearByHand', 'getPersonaConfig'])
    expect(props.get('getPersonaConfig')).toBe(`() => ${loadedConfigName(SERVER_CODE)}`)
  })

  test('the route\'s clear is clearByHandOf applied once, in main(), to main()\'s one buildLatchRecheck result: no local clear, never the timers holder', () => {
    const branchArgs = splitTopLevel(callArguments(SERVER_CODE, onlyCall('handleClearLatch')))
    const clearDep = objectProperties(branchArgs[2]!).get('clearByHand')!
    expect(clearDep).toMatch(/^[A-Za-z_$][\w$]*$/)
    const binding = constInitializer(clearDep)

    const recheck = onlyCall('buildLatchRecheck')
    const recheckName = /\bconst\s+([\w$]+)\s*=\s*$/.exec(MASKED.slice(Math.max(0, recheck - 80), recheck))?.[1]
    expect(recheckName).toBeDefined()
    expect(binding.init).toBe(`clearByHandOf(${recheckName})`)
    expect(onlyCall('clearByHandOf')).toBeGreaterThan(recheck)
    expect(atMainTopLevel(SERVER_CODE, binding.at)).toBe(true)
    // The binding is named only at its declaration and in the route's dependencies.
    expect(indicesOf(new RegExp(`\\b${clearDep}\\b`, 'g'), MASKED)).toHaveLength(2)
    expect(recheckName).not.toBe('latchRecheckTimers')
    for (const local of ['clearAndRecover', 'runLatchClearSequence', 'LATCH_RECOVERY_REASON_CLEARED_BY_HAND']) {
      expect(MASKED).not.toContain(local)
    }
  })

  test('the record is written once, in main(), after Bun.serve( and before writePidFile, with this PID and the listener\'s bound port', () => {
    const serve = indicesOf(/\bBun\.serve\s*\(/g, MASKED)
    expect(serve).toHaveLength(1)
    const listener = /([\w$]+)\s*=\s*$/.exec(MASKED.slice(Math.max(0, serve[0]! - 40), serve[0]!))?.[1]
    expect(listener).toBeDefined()
    const configuredPort = /\bport\s*:\s*([\w$.]+)/.exec(callArguments(SERVER_CODE, serve[0]!))?.[1]
    expect(configuredPort).toBeDefined()

    const [write] = onlyCallSpan('writeServerPortRecord')
    const pidFile = onlyCall('writePidFile')
    expect(insideMain(SERVER_CODE, write)).toBe(true)
    expect(write).toBeGreaterThan(serve[0]!)
    expect(write).toBeLessThan(pidFile)

    const args = splitTopLevel(callArguments(SERVER_CODE, write))
    expect(args).toHaveLength(2)
    const record = objectProperties(args[1]!)
    expect([...record.keys()].sort()).toEqual(['pid', 'port'])
    expect(record.get('pid')).toBe('process.pid')
    expect(record.get('port')).toBe(`${listener}.port ?? ${configuredPort}`)
  })

  test('the write sits in a try at main()\'s top level whose catch logs one described line and goes on to the PID file', () => {
    const [write, writeEnd] = onlyCallSpan('writeServerPortRecord')
    const tryAt = MASKED.lastIndexOf('try', write)
    expect(MASKED.slice(tryAt, write)).toMatch(/^try\s*\{\s*$/)
    expect(atMainTopLevel(SERVER_CODE, tryAt)).toBe(true)
    const between = SERVER_CODE.slice(writeEnd, onlyCall('writePidFile'))
    const path = recordPathName()
    expect(between).toMatch(
      new RegExp(
        `^\\s*;?\\s*\\}\\s*catch\\s*\\(\\s*(\\w+)\\s*\\)\\s*\\{\\s*console\\.error\\(\\s*serverPortWriteFailedLine\\(\\s*${path}\\s*,\\s*describeThrownValue\\(\\s*\\1\\s*\\)\\s*\\)\\s*\\)\\s*;?\\s*\\}\\s*$`,
      ),
    )
  })

  test('the record\'s path is serverPortFilePath of the PID file\'s own state directory', () => {
    const path = recordPathName()
    const pidFile = onlyCallArguments(MASKED, 'writePidFile').trim()
    const recordInit = constInitializer(path).init
    const pidInit = constInitializer(pidFile).init
    const stateDir = /^serverPortFilePath\(\s*([\w$]+)\s*\)$/.exec(recordInit)?.[1]
    expect(stateDir).toBeDefined()
    expect(pidInit).toBe(`join(${stateDir}, 'server.pid')`)
    expect(calls('serverPortFilePath')).toHaveLength(1)
  })

  test('shutdown() removes the record exactly once, beside the PID file\'s removal, and nothing else in server.ts touches the record\'s path', () => {
    const path = recordPathName()
    const [start, end] = shutdownBody(SERVER_CODE)
    const [remove, removeEnd] = onlyCallSpan('removeServerPortRecord')
    expect(remove).toBeGreaterThan(start)
    expect(remove).toBeLessThan(end)
    expect(callArguments(SERVER_CODE, remove).trim()).toBe(path)
    const pidRemovals = calls('removePidFile').filter((at) => at > start && at < end)
    expect(pidRemovals).toHaveLength(1)
    expect(SERVER_CODE.slice(removeEnd, pidRemovals[0]!)).toMatch(/^\s*;?\s*$/)

    // The path is named at its declaration, the write, the write's failure line and the removal only.
    const uses = indicesOf(new RegExp(`\\b${path}\\b`, 'g'), MASKED)
    const [write, writeEnd] = onlyCallSpan('writeServerPortRecord')
    const [failed, failedEnd] = onlyCallSpan('serverPortWriteFailedLine')
    const declared = constInitializer(path).at
    expect(uses).toHaveLength(4)
    expect(uses.filter((at) => at > declared && at < declared + 40 + path.length)).toHaveLength(1)
    expect(uses.filter((at) => at > write && at < writeEnd)).toHaveLength(1)
    expect(uses.filter((at) => at > failed && at < failedEnd)).toHaveLength(1)
    expect(uses.filter((at) => at > remove && at < removeEnd)).toHaveLength(1)
  })

  test('src/clear-latch.ts, which the CLI imports, loads no server-only or Slack module', () => {
    const { loads, forbidden } = forbiddenServerLoads('clear-latch.ts')
    // Not vacuous: the walk reaches the module it takes the cap and the loopback rule from.
    expect(loads.modules.has('interject.ts')).toBe(true)
    expect(forbidden).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// The command (SRJ-509; SRJ-510's CLI half): `createCli(…).clearLatch` over a
// local `CliDeps`, with `dir` as the server's state directory.
// ---------------------------------------------------------------------------

/** The running server's PID in the stub-dial cases: the default `isProcessRunning` answers true for it alone. */
const SERVER_PID = 4242
/** The port the stub-dial cases' `server.port` records. */
const RECORD_PORT = 41_001

/** What the local `exit` throws, so a run ends where the CLI calls it. */
class ExitSignal extends Error {
  constructor(readonly code: number) {
    super(`exit(${code})`)
  }
}

/** How one `clear-latch` run's dependencies behave. */
interface CliRunOptions {
  /** The dial's answer for each request; a 200 for B, not latched, by default. */
  dial?: (port: number, persona: string) => Promise<ClearLatchDialAnswer>
  /** Which PIDs are running; `SERVER_PID` alone by default. */
  isProcessRunning?: (pid: number) => boolean
  /** The run's fake clock; a fresh `createFakeClock()` by default. */
  fakeClock?: FakeClock
  /** Awaited at the start of each sleep, before the fake clock moves. */
  beforeSleep?: () => Promise<void>
  /** The most one sleep moves the fake clock; the whole sleep by default. */
  maxStepMs?: number
  /** A `now` and `sleep` used in place of the fake clock's (the real loopback run). */
  clock?: Pick<CliDeps, 'now' | 'sleep'>
}

/** One run's outcome: its exit code and stderr lines, and what it asked of its dependencies. */
interface CliRun {
  readonly code: number
  readonly stderr: readonly string[]
  /** Each dial's port and argument, in order. */
  readonly dials: ReadonlyArray<readonly [port: number, persona: string]>
  /** Each path the run checked or read, in order. */
  readonly reads: readonly string[]
  /** The run's clock when it called `exit`. */
  readonly exitAt: number
  /** Each sleep the wait asked for, in ms. */
  readonly sleeps: readonly number[]
}

/** The stderr lines of the current case; the console spy appends every `console.error` call. */
let stderr: string[]
/** Every fake clock the current case built; none may keep a pending timer. */
let clocks: FakeClock[]

/** The stand-in state directory's PID file and record. */
const pidPath = (): string => join(dir, 'server.pid')
const portPath = (): string => serverPortFilePath(dir)

/** A running server: `server.pid` naming `SERVER_PID` and its `server.port` naming `RECORD_PORT`. */
function writeRunningServer(): void {
  writeFileSync(pidPath(), `${SERVER_PID}\n`)
  writeServerPortRecord(portPath(), { pid: SERVER_PID, port: RECORD_PORT })
}

/** A dial that answers `status` and `body` at once. */
const answering = (status: number, body: string) => (): Promise<ClearLatchDialAnswer> => Promise.resolve({ status, body })

/** The route's 200 body for the persona named `name`. */
const okBody = (name: string, cleared: boolean): string => JSON.stringify({ ok: true, persona: name, cleared })

/**
 * Every path under `root`, sorted, with each file's bytes in base64 and null
 * for a directory: two snapshots are equal only when nothing was added,
 * removed or changed.
 */
function snapshotTree(root: string): Record<string, string | null> {
  const entries = (readdirSync(root, { recursive: true }) as string[]).sort()
  return Object.fromEntries(
    entries.map((rel) => {
      const path = join(root, rel)
      return [rel, statSync(path).isFile() ? readFileSync(path, 'base64') : null]
    }),
  )
}

/**
 * Run `clear-latch` with `args` over a local `CliDeps`: the state directory is
 * `dir`; reads are real and recorded; the dial is recorded then scripted;
 * `exit` records and throws `ExitSignal`; every member `clear-latch` must not
 * use throws and is recorded. Fails unless the run ended in exactly one
 * `exit`, used no such member and left `dir` byte-for-byte unchanged
 * (`clear-latch` writes and removes nothing; SRJ-510, hatch A3).
 */
async function runClearLatch(args: readonly string[], o: CliRunOptions = {}): Promise<CliRun> {
  const before = snapshotTree(dir)
  const firstLine = stderr.length
  const fakeClock = o.fakeClock ?? createFakeClock()
  clocks.push(fakeClock)
  const sleeps: number[] = []
  const now = o.clock?.now ?? (() => fakeClock.now())
  const sleep =
    o.clock?.sleep ??
    (async (ms: number): Promise<void> => {
      sleeps.push(ms)
      await o.beforeSleep?.()
      await fakeClock.advance(Math.min(ms, o.maxStepMs ?? ms))
    })
  const dial = o.dial ?? answering(200, okBody(B_NAME, false))
  const dials: Array<[number, string]> = []
  const reads: string[] = []
  const exits: Array<[code: number, at: number]> = []
  const misused: string[] = []
  const unused = (name: string) => (): never => {
    misused.push(name)
    throw new Error(`clear-latch used CliDeps.${name}`)
  }
  const deps: CliDeps = {
    spawnSync: unused('spawnSync'),
    spawnDaemon: unused('spawnDaemon'),
    openLogAppend: unused('openLogAppend'),
    closeFd: unused('closeFd'),
    initLogging: unused('initLogging'),
    existsSync: (path) => {
      reads.push(path)
      return existsSync(path)
    },
    readFileSync: (path) => {
      reads.push(path)
      return readFileSync(path, 'utf-8')
    },
    fileSize: unused('fileSize'),
    readFileFrom: unused('readFileFrom'),
    now,
    sleep,
    unlinkSync: unused('unlinkSync'),
    isProcessRunning: o.isProcessRunning ?? ((pid) => pid === SERVER_PID),
    kill: unused('kill'),
    resolveStateDir: () => dir,
    resolveConfigPath: unused('resolveConfigPath'),
    startServer: unused('startServer'),
    exit: (code): never => {
      exits.push([code, now()])
      throw new ExitSignal(code)
    },
    loadConfig: unused('loadConfig'),
    loadConfigFile: unused('loadConfigFile'),
    runCredentialsScript: unused('runCredentialsScript'),
    initClient: unused('initClient'),
    directorGet: unused('directorGet'),
    directorReadPane: unused('directorReadPane'),
    directorStatus: unused('directorStatus'),
    directorPause: unused('directorPause'),
    directorKill: unused('directorKill'),
    directorList: unused('directorList'),
    appendServerLogLine: unused('appendServerLogLine'),
    recordStartupErrorEntry: unused('recordStartupErrorEntry'),
    dialClearLatch: async (port, persona) => {
      dials.push([port, persona])
      return dial(port, persona)
    },
  }

  const ended = await createCli(deps).clearLatch(args).then(
    () => undefined,
    (err: unknown) => err,
  )
  expect(ended).toBeInstanceOf(ExitSignal)
  expect(exits).toHaveLength(1)
  expect(misused).toEqual([])
  expect(snapshotTree(dir)).toEqual(before)
  const [code, exitAt] = exits[0]!
  return { code, stderr: stderr.slice(firstLine), dials, reads, exitAt, sleeps }
}

describe('clear-latch: the command (SRJ-509; SRJ-510\'s CLI half)', () => {
  let errorSpy: ReturnType<typeof spyOn>

  beforeEach(() => {
    stderr = []
    clocks = []
    errorSpy = spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      stderr.push(args.map(String).join(' '))
    })
  })

  afterEach(() => {
    errorSpy.mockRestore()
    assertNoLeak({ stderr })
    // Every wait ran on its fake clock and none is left behind.
    for (const clock of clocks) expect(clock.pending()).toEqual([])
  })

  describe('SRJ-509\'s lines, pinned once', () => {
    // The only place the lines are written out: each row is the SRD's text
    // with its placeholders filled from the case. Every other case compares
    // with the exported line or builder.
    test.each([
      ['not exactly one non-empty argument', 'Usage: claude-slack-channel-bots clear-latch <persona name or key>', CLEAR_LATCH_USAGE],
      [
        'the general usage text\'s entry',
        "  clear-latch    <persona name or key>: clear a persona's latch (a session conflict, an unusable recorded name or a launch with no recorded start) on the running server",
        CLEAR_LATCH_USAGE_ENTRY,
      ],
      ['no server running', 'clear-latch: no server is running', clearLatchCliNoServerLine()],
      [
        'cannot be reached, a server.port cause',
        `clear-latch: the server did not answer: ${SERVER_PORT_CAUSE_ABSENT}`,
        clearLatchCliNotAnsweredLine(SERVER_PORT_CAUSE_ABSENT),
      ],
      [
        'cannot be reached, an unexpected status (the cause is "HTTP <status>")',
        'clear-latch: the server did not answer: HTTP 500',
        clearLatchCliNotAnsweredLine(clearLatchStatusCause(500)),
      ],
      [
        'did not confirm within the wait',
        "clear-latch: the server did not confirm within 30 s; the clear is queued and may still run. Check this persona's latch in the server log before trying again.",
        clearLatchCliNotConfirmedLine(),
      ],
      [
        'no applied persona has that name or key',
        'clear-latch: no persona in the running configuration has that name or key',
        clearLatchCliNoPersonaLine(),
      ],
      ['latched', 'clear-latch: cleared the latch of persona "reviewer" (key=reviewer)', clearLatchCliClearedLine('reviewer')],
      [
        'latched, a name whose key is hashed',
        `clear-latch: cleared the latch of persona "Planner Bot" (key=${A_KEY})`,
        clearLatchCliClearedLine('Planner Bot'),
      ],
      [
        'not latched',
        'clear-latch: persona "reviewer" (key=reviewer) was not latched; nothing changed',
        clearLatchCliNotLatchedLine('reviewer'),
      ],
    ])('%s', (_row, srd, built) => {
      expect(built).toBe(srd)
    })

    test('the wait is 30000 ms, the "30 s" of the did-not-confirm line', () => {
      expect(CLEAR_LATCH_WAIT_MS).toBe(30_000)
    })
  })

  describe('not exactly one non-empty argument → the usage line, exit 2', () => {
    test.each([
      ['no argument', []],
      ['one empty argument', ['']],
      ['two arguments', [A_NAME, B_NAME]],
      ['an empty argument and a name', ['', A_NAME]],
      ['a token typed twice', [TYPO_TOKEN, TYPO_TOKEN]],
    ])('%s: nothing read or dialled', async (_label, args) => {
      writeRunningServer()
      const run = await runClearLatch(args)
      expect(run).toMatchObject({ code: 2, stderr: [CLEAR_LATCH_USAGE], dials: [], reads: [] })
    })
  })

  describe('no server running → exit 1, no request, nothing removed', () => {
    // A valid server.port for SERVER_PID sits beside each PID file: it is
    // neither read, used nor removed.
    test.each([
      ['the PID file is absent', () => {}, undefined],
      ['the PID file is unreadable (a directory where it goes)', () => mkdirSync(pidPath()), undefined],
      ['the PID file does not hold a number', () => writeFileSync(pidPath(), 'not-a-pid\n'), undefined],
      ['the PID file is stale (its process is not running)', () => writeFileSync(pidPath(), `${SERVER_PID}\n`), () => false],
    ])('%s', async (_label, writePidFile, running) => {
      writeServerPortRecord(portPath(), { pid: SERVER_PID, port: RECORD_PORT })
      writePidFile()
      const run = await runClearLatch([TYPO_TOKEN], running ? { isProcessRunning: running } : {})
      expect(run).toMatchObject({ code: 1, stderr: [clearLatchCliNoServerLine()], dials: [] })
      expect(new Set(run.reads)).toEqual(new Set([pidPath()]))
    })
  })

  describe('the server cannot be reached → exit 1 with the cause', () => {
    test.each([
      [SERVER_PORT_CAUSE_ABSENT, () => {}],
      [SERVER_PORT_CAUSE_UNREADABLE, () => mkdirSync(portPath())],
      [SERVER_PORT_CAUSE_MALFORMED, () => writeFileSync(portPath(), 'not json {{{')],
      [SERVER_PORT_CAUSE_OUT_OF_RANGE, () => writeFileSync(portPath(), `{"pid":${SERVER_PID},"port":0}\n`)],
      [SERVER_PORT_CAUSE_OTHER_PID, () => writeServerPortRecord(portPath(), { pid: SERVER_PID + 1, port: RECORD_PORT })],
    ])('server.port unusable (%s): no request is made', async (cause, writeRecord) => {
      writeFileSync(pidPath(), `${SERVER_PID}\n`)
      writeRecord()
      const run = await runClearLatch([TYPO_TOKEN])
      expect(run).toMatchObject({ code: 1, stderr: [clearLatchCliNotAnsweredLine(cause)], dials: [] })
    })

    test('a record whose PID is not the running server\'s is not used, even while that PID runs too', async () => {
      writeFileSync(pidPath(), `${SERVER_PID}\n`)
      writeServerPortRecord(portPath(), { pid: SERVER_PID + 1, port: RECORD_PORT })
      const run = await runClearLatch([A_NAME], { isProcessRunning: () => true })
      expect(run).toMatchObject({ code: 1, stderr: [clearLatchCliNotAnsweredLine(SERVER_PORT_CAUSE_OTHER_PID)], dials: [] })
    })

    test.each([
      ['a refused connection carrying the sentinel', () => Object.assign(new Error(`connect failed (${sentinelInMessage('dial')})`), { code: 'ECONNREFUSED' }), true],
      ['a fetch TypeError', () => new TypeError('fetch failed'), false],
      ['a thrown string carrying the sentinel', () => `socket closed (${sentinelInMessage('string')})`, true],
    ])('a dial that fails (%s): the failure as describeThrownValue describes it, redacted', async (_label, makeError, carriesSentinel) => {
      writeRunningServer()
      const error = makeError()
      const run = await runClearLatch([A_NAME], { dial: () => Promise.reject(error) })
      expect(run).toMatchObject({
        code: 1,
        stderr: [clearLatchCliNotAnsweredLine(describeThrownValue(error))],
        dials: [[RECORD_PORT, A_NAME]],
      })
      if (carriesSentinel) expect(run.stderr[0]).toContain(REDACTED_SENTINEL_TAIL)
    })

    test.each([
      [201, okBody(B_NAME, true)],
      [400, JSON.stringify({ error: 'Missing or invalid field: persona (string) required' })],
      [403, JSON.stringify({ error: 'Forbidden' })],
      [405, JSON.stringify({ error: 'Method Not Allowed' })],
      [500, JSON.stringify({ error: fakeToken(BOT_TOKEN_PREFIX, 'body') })],
      [500, okBody(B_NAME, true)],
      [503, 'upstream unavailable'],
    ])('an answer with status %i: the cause names the status, never the body', async (status, body) => {
      writeRunningServer()
      const run = await runClearLatch([B_NAME], { dial: answering(status, body) })
      expect(run).toMatchObject({
        code: 1,
        stderr: [clearLatchCliNotAnsweredLine(clearLatchStatusCause(status))],
        dials: [[RECORD_PORT, B_NAME]],
      })
    })

    test.each([
      ['an empty body', ''],
      ['not JSON', 'not json {{{'],
      ['JSON null', 'null'],
      ['a JSON array', JSON.stringify([B_NAME, true])],
      ['no cleared', JSON.stringify({ ok: true, persona: B_NAME })],
      ['a string cleared', JSON.stringify({ ok: true, persona: B_NAME, cleared: 'true' })],
      ['ok false', JSON.stringify({ ok: false, persona: B_NAME, cleared: true })],
      ['no ok', JSON.stringify({ persona: B_NAME, cleared: true })],
      ['an empty persona', JSON.stringify({ ok: true, persona: '', cleared: true })],
      ['a numeric persona', JSON.stringify({ ok: true, persona: 42, cleared: true })],
      ['a token for cleared', JSON.stringify({ ok: true, persona: B_NAME, cleared: fakeToken(BOT_TOKEN_PREFIX, 'cleared') })],
    ])('a malformed 200 (%s): the cause is the status alone', async (_label, body) => {
      writeRunningServer()
      const run = await runClearLatch([B_NAME], { dial: answering(200, body) })
      expect(run).toMatchObject({ code: 1, stderr: [clearLatchCliNotAnsweredLine(clearLatchStatusCause(200))] })
    })
  })

  describe('no answer within CLEAR_LATCH_WAIT_MS → "did not confirm", exit 1 (hatch A3)', () => {
    test('a dial that never answers ends on the fake clock at the bound, never on the cannot-be-reached row', async () => {
      writeRunningServer()
      const run = await runClearLatch([TYPO_TOKEN], { dial: () => new Promise<never>(() => {}) })
      expect(run).toMatchObject({ code: 1, stderr: [clearLatchCliNotConfirmedLine()], dials: [[RECORD_PORT, TYPO_TOKEN]] })
      expect(run.exitAt).toBe(CLEAR_LATCH_WAIT_MS)
    })

    test('a sleep that wakes early is slept again until the clock reaches the bound', async () => {
      writeRunningServer()
      const run = await runClearLatch([A_NAME], { dial: () => new Promise<never>(() => {}), maxStepMs: 7_000 })
      expect(run).toMatchObject({ code: 1, stderr: [clearLatchCliNotConfirmedLine()] })
      expect(run.exitAt).toBe(CLEAR_LATCH_WAIT_MS)
      expect(run.sleeps.length).toBeGreaterThan(1)
    })

    test('an answer or failure that comes after the bound changes nothing: one line, one exit', async () => {
      writeRunningServer()
      const late = Promise.withResolvers<ClearLatchDialAnswer>()
      const run = await runClearLatch([A_NAME], { dial: () => late.promise })
      expect(run).toMatchObject({ code: 1, stderr: [clearLatchCliNotConfirmedLine()] })
      late.resolve({ status: 200, body: okBody(A_NAME, true) })
      for (let i = 0; i < 20; i++) await Promise.resolve()
      expect(stderr).toEqual([clearLatchCliNotConfirmedLine()])
    })

    test('an answer 1 ms before the bound is the answer, not "did not confirm"', async () => {
      writeRunningServer()
      const fakeClock = createFakeClock()
      const dial = (): Promise<ClearLatchDialAnswer> =>
        new Promise((resolve) => {
          fakeClock.setTimeout(() => resolve({ status: 200, body: okBody(A_NAME, true) }), CLEAR_LATCH_WAIT_MS - 1)
        })
      const run = await runClearLatch([A_NAME], { dial, fakeClock })
      expect(run).toMatchObject({ code: 0, stderr: [clearLatchCliClearedLine(A_NAME)] })
      expect(run.exitAt).toBe(CLEAR_LATCH_WAIT_MS - 1)
    })
  })

  describe('an answer → its line', () => {
    test('404 → exit 1 with the no-persona line; the argument is dialled as typed and never printed', async () => {
      writeRunningServer()
      const run = await runClearLatch([TYPO_TOKEN], {
        dial: answering(404, JSON.stringify({ error: 'Persona not found in the applied config' })),
      })
      expect(run).toMatchObject({ code: 1, stderr: [clearLatchCliNoPersonaLine()], dials: [[RECORD_PORT, TYPO_TOKEN]] })
      expect(run.stderr.join('\n')).not.toContain(TYPO_TOKEN)
    })

    test.each([
      ['A by name, latched', A_NAME, A_NAME, true],
      ['A by key, latched', A_KEY, A_NAME, true],
      ['A by key, not latched', A_KEY, A_NAME, false],
      ['B by name, not latched', B_NAME, B_NAME, false],
    ] as const)('200 for %s → exit 0, the name from the answer and its personaKey', async (_label, target, name, cleared) => {
      writeRunningServer()
      const run = await runClearLatch([target], { dial: answering(200, okBody(name, cleared)) })
      const line = cleared ? clearLatchCliClearedLine(name) : clearLatchCliNotLatchedLine(name)
      expect(run).toMatchObject({ code: 0, stderr: [line], dials: [[RECORD_PORT, target]] })
      expect(line).toContain(`(key=${personaKey(name)})`)
      // An answer at once ends the run at once: the wait is a bound, not a delay.
      expect(run.exitAt).toBe(0)
    })

    test.each([
      ['a quote', 'say "hi"', '"say \\"hi\\""'],
      ['a tab', 'tab\there', '"tab\\there"'],
      ['a line break', 'two\nlines', '"two\\nlines"'],
    ])('a name holding %s prints escaped, as renderPersonaRef renders it (hatch A3)', async (_label, name, quoted) => {
      writeRunningServer()
      for (const cleared of [true, false]) {
        const run = await runClearLatch([name], { dial: answering(200, okBody(name, cleared)) })
        const ref = `${quoted} (key=${personaKey(name)})`
        const line = cleared ? clearLatchCliClearedLine(name) : clearLatchCliNotLatchedLine(name)
        expect(run).toMatchObject({ code: 0, stderr: [line] })
        expect(line).toContain(ref)
        expect(line).not.toMatch(/[\t\n]/)
      }
    })
  })

  test('the CLI dials the port in server.port, never the configuration file\'s or the last-applied record\'s, and reads neither', async () => {
    const configPath = writeConfigFile(dir, makePersonaConfigInput({ port: RECORD_PORT + 1, personas: [makePersona({ name: A_NAME }, dir)] }, dir))
    const lastApplied = reloadFilePaths(configPath).lastApplied
    writeFileSync(lastApplied, JSON.stringify(makePersonaConfigInput({ port: RECORD_PORT + 2, personas: [makePersona({ name: A_NAME }, dir)] }, dir)))
    writeRunningServer()
    const run = await runClearLatch([A_NAME], { dial: answering(200, okBody(A_NAME, true)) })
    expect(run).toMatchObject({ code: 0, stderr: [clearLatchCliClearedLine(A_NAME)], dials: [[RECORD_PORT, A_NAME]] })
    expect(new Set(run.reads)).toEqual(new Set([pidPath(), portPath()]))
  })

  describe('against the real handler', () => {
    /**
     * The real `handleClearLatch` answering in process over the file's
     * handler dependencies (`deps()`): `forward` gates when the request
     * reaches it, and `served` is the dial's answer once the handler answers.
     */
    function handlerDial(forward: Promise<void>): {
      dial: (port: number, persona: string) => Promise<ClearLatchDialAnswer>
      served: () => Promise<ClearLatchDialAnswer>
    } {
      let served: Promise<ClearLatchDialAnswer> | undefined
      const dial = (port: number, persona: string): Promise<ClearLatchDialAnswer> => {
        served = (async () => {
          await forward
          const req = new Request(clearLatchUrl(port), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ persona }),
          })
          const res = await handleClearLatch(req, '127.0.0.1', deps())
          return { status: res.status, body: await res.text() }
        })()
        return served
      }
      return {
        dial,
        served: () => {
          if (served === undefined) throw new Error('handlerDial: no request was dialled')
          return served
        },
      }
    }

    test.each([
      ['received before the wait ran out, its clear still waiting in P\'s turn', false],
      ['received only after the wait ran out', true],
    ])('a clear %s still runs once, and the CLI ended on "did not confirm" (SRJ-510; hatch A3)', async (_label, late) => {
      writeRunningServer()
      const gate = Promise.withResolvers<boolean>()
      const received = Promise.withResolvers<void>()
      clearAnswer = () => {
        received.resolve()
        return gate.promise
      }
      const cliEnded = Promise.withResolvers<void>()
      const { dial, served } = handlerDial(late ? cliEnded.promise : Promise.resolve())

      // Early: the wait sleeps only once the clear has been received.
      const run = await runClearLatch([A_NAME], { dial, beforeSleep: late ? undefined : () => received.promise })
      expect(run).toMatchObject({ code: 1, stderr: [clearLatchCliNotConfirmedLine()], dials: [[RECORD_PORT, A_NAME]] })
      expect(clearCalls).toEqual(late ? [] : [A_KEY])

      cliEnded.resolve()
      await received.promise
      gate.resolve(true)
      const answer = await served()
      const body: unknown = JSON.parse(answer.body)
      bodies.push(body)
      expect({ status: answer.status, body }).toEqual({ status: 200, body: { ok: true, persona: A_NAME, cleared: true } })
      expect(clearCalls).toEqual([A_KEY])
      expect(stderr).toEqual([clearLatchCliNotConfirmedLine()])
    })

    test('over real HTTP: the production dial reaches the handler on 127.0.0.1 at the recorded port; once the server stops, the same run cannot reach it (the port held by a listener that answers nothing)', async () => {
      /** The production dial, its failures recorded, with a sleep that ends once the dial has settled (no real timer). */
      function loopback(failures: unknown[]): CliRunOptions {
        const settled = Promise.withResolvers<void>()
        return {
          isProcessRunning,
          dial: (port, persona) =>
            dialClearLatch(port, persona)
              .catch((err: unknown) => {
                failures.push(err)
                throw err
              })
              .finally(() => settled.resolve()),
          clock: { now: () => 0, sleep: () => settled.promise },
        }
      }

      const server = startClearLatchServer(() => deps())
      const port = server.port
      try {
        writeFileSync(pidPath(), `${process.pid}\n`)
        writeServerPortRecord(portPath(), { pid: process.pid, port })
        clearAnswer = () => Promise.resolve(true)
        const live = await runClearLatch([A_NAME], loopback([]))
        expect(live).toMatchObject({ code: 0, stderr: [clearLatchCliClearedLine(A_NAME)], dials: [[port, A_NAME]] })
        expect(clearCalls).toEqual([A_KEY])
      } finally {
        await server.stop()
      }

      // The released port is held at once, so no other process can take it and answer the dial.
      const holder = await holdResettingListener(port)
      try {
        const failures: unknown[] = []
        const gone = await runClearLatch([A_NAME], loopback(failures))
        expect(failures).toHaveLength(1)
        expect(gone).toMatchObject({
          code: 1,
          stderr: [clearLatchCliNotAnsweredLine(describeThrownValue(failures[0]))],
          dials: [[port, A_NAME]],
        })
        expect(clearCalls).toEqual([A_KEY])
        // Not vacuous: the dial went to the recorded port, and found no handler there.
        expect(holder.hits()).toBeGreaterThan(0)
      } finally {
        await holder.close()
      }
    })
  })
})

/** A fake `node:http` request or response: an emitter the case drives. */
type FakeEmitter = EventEmitter

/**
 * A recording `ClearLatchRequest` standing in for `node:http`'s `request`:
 * each call's options and the body its request was ended with, and `respond`,
 * which hands the dial a fake response with `status` and returns it for the
 * case to emit `data`, `end`, `error` or `aborted` on. `throwing` makes the
 * call itself throw.
 */
function fakeHttp(throwing?: unknown): {
  requestFn: ClearLatchRequest
  calls: Array<{ options: RequestOptions; ended: unknown[] }>
  request: () => FakeEmitter
  respond: (status: number) => FakeEmitter
} {
  const calls: Array<{ options: RequestOptions; ended: unknown[] }> = []
  let req: FakeEmitter | undefined
  let onResponse: ((res: IncomingMessage) => void) | undefined
  const requestFn: ClearLatchRequest = (options, cb) => {
    if (throwing !== undefined) throw throwing
    const call = { options, ended: [] as unknown[] }
    calls.push(call)
    onResponse = cb
    req = Object.assign(new EventEmitter(), {
      end: (...args: unknown[]) => {
        call.ended.push(...args)
      },
    })
    return req as unknown as ClientRequest
  }
  return {
    requestFn,
    calls,
    request: () => {
      if (req === undefined) throw new Error('fakeHttp: no request was made')
      return req
    },
    respond: (status) => {
      if (onResponse === undefined) throw new Error('fakeHttp: no request was made')
      const res = Object.assign(new EventEmitter(), { statusCode: status })
      onResponse(res as unknown as IncomingMessage)
      return res
    },
  }
}

describe('dialClearLatch: the production dial', () => {
  /** A persona argument whose UTF-8 byte length differs from its length in characters. */
  const WIDE_NAME = 'Zoë Planner'

  test('one POST of {"persona"} as JSON to the route on 127.0.0.1 at the port, on a connection of its own, answering the status and the body text', async () => {
    const http = fakeHttp()
    const sent = Buffer.from(JSON.stringify({ persona: WIDE_NAME }), 'utf-8')
    expect(sent.byteLength).not.toBe(JSON.stringify({ persona: WIDE_NAME }).length)

    const dialled = dialClearLatch(3101, WIDE_NAME, http.requestFn)
    expect(http.calls).toHaveLength(1)
    const { options, ended } = http.calls[0]!
    expect(options).toEqual(clearLatchRequestOptions(3101, sent.byteLength))
    expect(options).toEqual({
      host: CLEAR_LATCH_DIAL_HOST,
      port: 3101,
      path: CLEAR_LATCH_ROUTE,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': sent.byteLength },
      agent: false,
    })
    // The options name the same place as the route's URL.
    const url = new URL(clearLatchUrl(3101))
    expect<unknown[]>([url.hostname, Number(url.port), url.pathname]).toEqual([options.host, options.port, options.path])
    // The request is ended with the whole body, once.
    expect(ended).toHaveLength(1)
    expect(Buffer.from(ended[0] as Uint8Array).equals(sent)).toBe(true)

    // The answer's body arrives split inside a two-byte character, as a Buffer and then as text.
    const answerBytes = Buffer.from(okBody(WIDE_NAME, true), 'utf-8')
    const split = answerBytes.indexOf(Buffer.from('ë', 'utf-8')) + 1
    const res = http.respond(200)
    res.emit('data', answerBytes.subarray(0, split))
    res.emit('data', answerBytes.subarray(split, split + 3))
    res.emit('data', answerBytes.subarray(split + 3).toString('utf-8'))
    res.emit('end')
    expect(await dialled).toEqual({ status: 200, body: okBody(WIDE_NAME, true) })
  })

  test('a status other than 200 is answered as is, not rejected', async () => {
    const http = fakeHttp()
    const dialled = dialClearLatch(3101, A_NAME, http.requestFn)
    const res = http.respond(404)
    const body = JSON.stringify({ error: 'Persona not found in the applied config' })
    res.emit('data', Buffer.from(body, 'utf-8'))
    res.emit('end')
    expect(await dialled).toEqual({ status: 404, body })
  })

  test.each([
    ['the request call throws', (_http: ReturnType<typeof fakeHttp>, _err: Error) => {}, true],
    ['the request emits error (a failed connection)', (http: ReturnType<typeof fakeHttp>, err: Error) => {
      http.request().emit('error', err)
    }, false],
    ['the response emits error (a failed body read)', (http: ReturnType<typeof fakeHttp>, err: Error) => {
      const res = http.respond(200)
      res.emit('data', Buffer.from('{"ok":', 'utf-8'))
      res.emit('error', err)
    }, false],
  ] as const)('%s → rejects with that error unchanged', async (_label, fail, throwing) => {
    const err = new Error(`connect ECONNREFUSED ${CLEAR_LATCH_DIAL_HOST}:3101`)
    const http = fakeHttp(throwing ? err : undefined)
    const dialled = dialClearLatch(3101, A_NAME, http.requestFn)
    fail(http, err)
    await expect(dialled).rejects.toBe(err)
  })

  test('a response aborted before its end rejects at the abort, with no end: a plain Error of the dial\'s own naming neither the persona nor the body read; the same body ended with no abort is answered', async () => {
    const truncated = okBody(A_NAME, true).slice(0, 8)

    const aborted = fakeHttp()
    const dialled = dialClearLatch(3101, A_NAME, aborted.requestFn)
    const res = aborted.respond(200)
    res.emit('data', Buffer.from(truncated, 'utf-8'))
    res.emit('aborted')
    // No `end` follows: the abort alone settles the dial (a dial waiting for an end would never settle).
    const failure = await dialled.then(
      (answer) => ({ answered: answer }),
      (err: unknown) => err,
    )
    expect(failure).toBeInstanceOf(Error)
    expect(Object.getPrototypeOf(failure)).toBe(Error.prototype)
    const message = (failure as Error).message
    expect({ persona: message.includes(A_NAME), body: message.includes(truncated) }).toEqual({ persona: false, body: false })

    // Control: the same body, ended with no abort, is answered as read.
    const ended = fakeHttp()
    const answered = dialClearLatch(3101, A_NAME, ended.requestFn)
    const endedRes = ended.respond(200)
    endedRes.emit('data', Buffer.from(truncated, 'utf-8'))
    endedRes.emit('end')
    expect(await answered).toEqual({ status: 200, body: truncated })
  })

  test('a proxy in HTTP_PROXY and http_proxy, with no NO_PROXY, is not used: the dial still reaches the real handler on 127.0.0.1 (SRJ-510)', async () => {
    // The runtime's own environment (`Bun.env`): other suites replace `process.env` with a plain
    // copy, which the runtime no longer reads. A variable is unset by blanking it before the
    // delete: a bare delete leaves the runtime's `fetch` on the old proxy, poisoning later suites.
    const env = Bun.env
    const PROXY_VARS = ['HTTP_PROXY', 'http_proxy', 'NO_PROXY', 'no_proxy'] as const
    const saved = new Map(PROXY_VARS.map((name) => [name, env[name]] as const))
    const unset = (name: string): void => {
      env[name] = ''
      delete env[name]
    }
    // The proxy is a listener the case holds, answering nothing: a request sent through it fails, and is counted.
    const proxy = await holdResettingListener()
    const proxyUrl = `http://${CLEAR_LATCH_DIAL_HOST}:${proxy.port}`
    const server = startClearLatchServer(() => deps())
    try {
      env.HTTP_PROXY = proxyUrl
      env.http_proxy = proxyUrl
      unset('NO_PROXY')
      unset('no_proxy')

      // Not vacuous: `fetch` under the same environment goes to the proxy and never reaches the server.
      const viaFetch = await fetch(clearLatchUrl(server.port), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ persona: A_NAME }),
      }).then(
        (res) => res.status,
        (err: unknown) => err,
      )
      expect(viaFetch).toBeInstanceOf(Error)
      expect(clearCalls).toEqual([])
      const proxyHitsByFetch = proxy.hits()
      expect(proxyHitsByFetch).toBeGreaterThan(0)

      const answer = await dialClearLatch(server.port, A_NAME)
      const body: unknown = JSON.parse(answer.body)
      bodies.push(body)
      expect({ status: answer.status, body }).toEqual({ status: 200, body: { ok: true, persona: A_NAME, cleared: true } })
      expect(clearCalls).toEqual([A_KEY])
      // The dial never touched the proxy.
      expect(proxy.hits()).toBe(proxyHitsByFetch)
    } finally {
      await server.stop()
      await proxy.close()
      for (const [name, value] of saved) {
        if (value === undefined) unset(name)
        else env[name] = value
      }
    }
  })
})
