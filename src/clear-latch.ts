/**
 * clear-latch.ts — The `clear-latch` command's names, the server's
 * `POST /clear-latch` request handler, the `server.port` record and the
 * CLI's request to the route (b.jg5 SRJ-509, SRJ-510, SRJ-511).
 *
 * The route and the command are for the operator only (SRJ-511): no MCP
 * tool, no text of the MCP instructions, no tool description and no notice
 * may name them. Every user of the names imports the one spelling below.
 *
 * The route (SRJ-510) answers on the server's MCP listener, loopback only,
 * as `/interject` does:
 *
 *   405  any method but POST
 *   403  a remote address other than 127.0.0.1, ::1 or ::ffff:127.*
 *   400  a UTF-8 body over INTERJECT_BODY_CAP_BYTES, invalid JSON, or a
 *        missing, empty or non-string `persona`
 *   404  no applied persona has that name or key (the argument is never
 *        repeated, SRJ-509: it may be a token typed by mistake)
 *   500  the clear rejected unexpectedly (one leak-free line)
 *   200  `{ ok: true, persona: <name>, cleared: true | false }` once the
 *        clear has run in the persona's lifecycle serializer turn; the
 *        bypassing `find-missing` and the retry follow without being awaited
 *
 * The CLI dials `127.0.0.1` at the port in `server.port` (`dialClearLatch`,
 * the production dial; `parseClearLatchAnswer` reads a 200's body), directly
 * and never through a proxy the environment names, so a server whose `bind`
 * gives it no `127.0.0.1` listener cannot be reached by `clear-latch`.
 *
 * `server.port` is the server's own record of its PID and its listener's
 * bound port, `{"pid":<pid>,"port":<port>}` and a newline, written in one
 * atomic write once the listener is up, beside `server.pid` in the state
 * directory. It is removed wherever the PID file is: at the server's
 * shutdown, beside a stale PID file in `checkPidConflict` (`src/pid.ts`) and
 * in the CLI's `stopServer` (`src/cli.ts`). The CLI uses it only when the PID
 * it holds is the running server's.
 *
 * Side-effect free: importing this module reads no file, environment variable
 * or config, binds nothing and logs nothing. The persona config, the clear and
 * the logger are injected per call, and the file-system calls of the record's
 * write, read and removal and the dial's `node:http` request are injectable. `src/cli.ts`
 * imports it, so it loads no server-only module: the clear by hand and its
 * "cleared by hand" reason are bound by the server and handed in.
 *
 * Log lines (none for 400, 403 or 405; a latched persona's clear logs only the
 * clear entry's own line):
 *
 *   [slack] clear-latch: persona "<name>" (key=<key>) was not latched; nothing changed
 *   [slack] clear-latch: no persona in the applied configuration has the requested name or key; nothing cleared
 *   [slack] clear-latch: the clear of persona "<name>" (key=<key>) failed: <error>
 *   [slack] server.port: could not write <path>; clear-latch cannot reach this server until it restarts: <error>
 *
 * SPDX-License-Identifier: MIT
 */

import { existsSync, readFileSync, unlinkSync } from 'node:fs'
import { request as httpRequest, type ClientRequest, type IncomingMessage, type RequestOptions } from 'node:http'
import { join } from 'node:path'
import type { Persona } from './config.ts'
import { atomicWriteFileSync } from './atomic-write.ts'
import { INTERJECT_BODY_CAP_BYTES, isLocalAddress } from './interject.ts'
import { describeThrownValue } from './persona-connection-errors.ts'
import { renderPersonaRef, resolvePersonaTarget } from './persona-identity.ts'

// ---------------------------------------------------------------------------
// Names
// ---------------------------------------------------------------------------

/** The CLI subcommand that clears one persona's latch on the running server. */
export const CLEAR_LATCH_COMMAND = 'clear-latch'

/** The route on the server's MCP listener the command calls. */
export const CLEAR_LATCH_ROUTE = '/clear-latch'

/** The address the CLI dials: the server's listener on loopback, as the scheduled-prompt dispatcher dials it. */
export const CLEAR_LATCH_DIAL_HOST = '127.0.0.1'

/** The record's file name, in the server's state directory beside `server.pid`. */
export const SERVER_PORT_FILE_NAME = 'server.port'

/** The record's path in the state directory `stateDir`. */
export function serverPortFilePath(stateDir: string): string {
  return join(stateDir, SERVER_PORT_FILE_NAME)
}

// ---------------------------------------------------------------------------
// The server.port record
// ---------------------------------------------------------------------------

/** What `server.port` holds: the server's PID and its listener's bound port. */
export interface ServerPortRecord {
  readonly pid: number
  readonly port: number
}

/** The highest TCP port. */
const MAX_PORT = 65535

/** The record's file content: the JSON object and a newline. Pure. */
export function serverPortRecordText(record: ServerPortRecord): string {
  return JSON.stringify({ pid: record.pid, port: record.port }) + '\n'
}

/**
 * Write `record` to `path` in one atomic write (`atomicWriteFileSync`:
 * `<path>.tmp`, then a rename). A failure is rethrown, the temporary file
 * removed; the caller decides the log line ({@link serverPortWriteFailedLine}).
 *
 * @param write  The atomic write; `atomicWriteFileSync` by default.
 */
export function writeServerPortRecord(
  path: string,
  record: ServerPortRecord,
  write: (path: string, contents: string) => void = atomicWriteFileSync,
): void {
  write(path, serverPortRecordText(record))
}

/**
 * The line a failed record write logs; the server keeps running. `error` is
 * the failure as `describeThrownValue` describes it. Pure.
 */
export function serverPortWriteFailedLine(path: string, error: string): string {
  return `[slack] server.port: could not write ${path}; ${CLEAR_LATCH_COMMAND} cannot reach this server until it restarts: ${error}`
}

/** The record is absent. */
export const SERVER_PORT_CAUSE_ABSENT = 'server.port is absent'
/** The record exists but could not be read. */
export const SERVER_PORT_CAUSE_UNREADABLE = 'server.port could not be read'
/** The record is not a JSON object holding a numeric `pid` and `port`. */
export const SERVER_PORT_CAUSE_MALFORMED = 'server.port is malformed'
/** The record's PID is not a positive integer, or its port not an integer from 1 to 65535. */
export const SERVER_PORT_CAUSE_OUT_OF_RANGE = 'server.port holds a PID or port out of range'
/** The record names a PID other than the running server's. */
export const SERVER_PORT_CAUSE_OTHER_PID = 'server.port was written by another process'

/**
 * Why a `server.port` cannot be used. Each is CSCB's own text and never
 * carries file content, so the CLI's `<cause>` cannot leak what the file
 * holds.
 */
export type ServerPortUnusableCause =
  | typeof SERVER_PORT_CAUSE_ABSENT
  | typeof SERVER_PORT_CAUSE_UNREADABLE
  | typeof SERVER_PORT_CAUSE_MALFORMED
  | typeof SERVER_PORT_CAUSE_OUT_OF_RANGE
  | typeof SERVER_PORT_CAUSE_OTHER_PID

/** A read of `server.port`: the record, or why it cannot be used. */
export type ServerPortRead =
  | { readonly ok: true; readonly record: ServerPortRecord }
  | { readonly ok: false; readonly cause: ServerPortUnusableCause }

/** The file-system calls the read makes, in the shape of `CliDeps`'s. */
export interface ServerPortReadFs {
  existsSync(path: string): boolean
  /** The file as UTF-8 text. */
  readFileSync(path: string): string
}

/** The real calls, looked up at call time. */
const NODE_READ_FS: ServerPortReadFs = {
  existsSync: (path) => existsSync(path),
  readFileSync: (path) => readFileSync(path, 'utf-8'),
}

/** True for an errno-style error with code ENOENT. */
function isAbsentError(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 'ENOENT'
}

/** True for a positive safe integer. */
function isPositiveInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0
}

/**
 * Read the record at `path` for the running server whose PID is
 * `expectedPid`: the record, or why it cannot be used: absent, unreadable,
 * malformed, a field out of range, or written by another PID. Never throws.
 *
 * @param fs  The file-system calls; the real ones by default.
 */
export function readServerPortRecord(path: string, expectedPid: number, fs: ServerPortReadFs = NODE_READ_FS): ServerPortRead {
  let text: string
  try {
    if (!fs.existsSync(path)) return { ok: false, cause: SERVER_PORT_CAUSE_ABSENT }
    text = fs.readFileSync(path)
  } catch (err) {
    return { ok: false, cause: isAbsentError(err) ? SERVER_PORT_CAUSE_ABSENT : SERVER_PORT_CAUSE_UNREADABLE }
  }
  if (typeof text !== 'string') return { ok: false, cause: SERVER_PORT_CAUSE_UNREADABLE }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return { ok: false, cause: SERVER_PORT_CAUSE_MALFORMED }
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return { ok: false, cause: SERVER_PORT_CAUSE_MALFORMED }
  const { pid, port } = parsed as { pid?: unknown; port?: unknown }
  if (typeof pid !== 'number' || typeof port !== 'number') return { ok: false, cause: SERVER_PORT_CAUSE_MALFORMED }
  if (!isPositiveInteger(pid) || !isPositiveInteger(port) || port > MAX_PORT) return { ok: false, cause: SERVER_PORT_CAUSE_OUT_OF_RANGE }
  if (pid !== expectedPid) return { ok: false, cause: SERVER_PORT_CAUSE_OTHER_PID }
  return { ok: true, record: { pid, port } }
}

/** The file-system call the removal makes. */
export interface ServerPortRemoveFs {
  unlinkSync(path: string): void
}

/** The real call, looked up at call time. */
const NODE_REMOVE_FS: ServerPortRemoveFs = {
  unlinkSync: (path) => unlinkSync(path),
}

/**
 * Remove the record at `path`, best effort: an absent file is success, and
 * any other failure is ignored, as for the PID file. Never throws.
 *
 * @param fs  The file-system call; the real one by default.
 */
export function removeServerPortRecord(path: string, fs: ServerPortRemoveFs = NODE_REMOVE_FS): void {
  try {
    fs.unlinkSync(path)
  } catch {
    /* ignore: best effort, absent included */
  }
}

// ---------------------------------------------------------------------------
// The CLI's request
// ---------------------------------------------------------------------------

/** The route's answer as the CLI's dial gets it: the HTTP status and the body text. */
export interface ClearLatchDialAnswer {
  readonly status: number
  readonly body: string
}

/**
 * The request call the production dial makes, in the shape of `node:http`'s
 * `request(options, onResponse)`: it returns the request, which the dial ends
 * with the body.
 */
export type ClearLatchRequest = (options: RequestOptions, onResponse: (res: IncomingMessage) => void) => ClientRequest

/** The URL the CLI posts to: the route on `127.0.0.1` at `port`. Pure. */
export function clearLatchUrl(port: number): string {
  return `http://${CLEAR_LATCH_DIAL_HOST}:${port}${CLEAR_LATCH_ROUTE}`
}

/**
 * The options of the production dial's one request (the URL of
 * {@link clearLatchUrl}) for `bodyBytes` bytes of JSON body: a `POST` to the
 * route on `127.0.0.1` at `port`, on a connection of its own (no agent, so no
 * pooled socket keeps the CLI alive), and no timeout. Pure.
 */
export function clearLatchRequestOptions(port: number, bodyBytes: number): RequestOptions {
  return {
    host: CLEAR_LATCH_DIAL_HOST,
    port,
    path: CLEAR_LATCH_ROUTE,
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': bodyBytes },
    agent: false,
  }
}

/**
 * The production dial of the `clear-latch` command (b.jg5 SRJ-510): one
 * `POST` of `{ "persona": <persona> }` to the route on `127.0.0.1` at `port`,
 * answering the status and the body text once the whole body is read.
 *
 * It goes through `node:http`'s `request`, straight to the loopback address:
 * unlike `fetch`, which sends the request to the proxy that `HTTP_PROXY` names
 * when `NO_PROXY` does not exempt `127.0.0.1`, it reads no proxy environment
 * variable, so the persona argument (perhaps a token typed by mistake) never
 * leaves the host. A failed connection, request or body read rejects with the
 * runtime's error. It sets no timeout of its own: the CLI bounds the wait for
 * it on its injected clock, so a dial cut short never stands in for that
 * wait. Logs nothing, the body included.
 *
 * @param requestFn  The request; `node:http`'s `request`, looked up at call time, by default.
 */
export function dialClearLatch(
  port: number,
  persona: string,
  requestFn: ClearLatchRequest = (options, onResponse) => httpRequest(options, onResponse),
): Promise<ClearLatchDialAnswer> {
  const body = Buffer.from(JSON.stringify({ persona }), 'utf-8')
  return new Promise<ClearLatchDialAnswer>((resolve, reject) => {
    let req: ClientRequest
    try {
      req = requestFn(clearLatchRequestOptions(port, body.byteLength), (res) => {
        const chunks: Buffer[] = []
        res.on('data', (chunk: Buffer | string) => {
          chunks.push(typeof chunk === 'string' ? Buffer.from(chunk, 'utf-8') : chunk)
        })
        res.on('error', reject)
        res.on('aborted', () => reject(new Error('the response was aborted before its end')))
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf-8') }))
      })
      req.on('error', reject)
      req.end(body)
    } catch (err) {
      reject(err)
    }
  })
}

/** A well-formed 200 answer: the applied persona's name and whether it was latched. */
export interface ClearLatchAnswer {
  readonly persona: string
  readonly cleared: boolean
}

/**
 * The 200 answer's body `text` (`{ ok: true, persona: <name>, cleared:
 * true | false }`), or null when it is malformed: not JSON, not an object,
 * `ok` not `true`, `persona` not a non-empty string or `cleared` not a
 * boolean. Pure; never throws.
 */
export function parseClearLatchAnswer(text: string): ClearLatchAnswer | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null
  const { ok, persona, cleared } = parsed as { ok?: unknown; persona?: unknown; cleared?: unknown }
  if (ok !== true || typeof persona !== 'string' || persona === '' || typeof cleared !== 'boolean') return null
  return { persona, cleared }
}

// ---------------------------------------------------------------------------
// The route's handler
// ---------------------------------------------------------------------------

/** The persona fields the handler reads. */
export type ClearLatchPersona = Pick<Persona, 'name' | 'key'>

/** Dependencies of `handleClearLatch`, injected per call. */
export interface ClearLatchDeps {
  /**
   * The current applied persona config, read once per request. Null only
   * before the server has loaded its configuration: every target is then
   * unknown (404).
   */
  getPersonaConfig: () => { personas: readonly ClearLatchPersona[] } | null
  /**
   * The clear by hand of the persona with this key: settles with whether it
   * was latched once the clear has run in its lifecycle serializer turn, and
   * leaves what follows the clear running. The server binds it over its
   * latch re-check, with the "cleared by hand" reason.
   */
  clearByHand: (key: string) => Promise<boolean>
  /** Line logger. Defaults to `console.error`. */
  log?: (line: string) => void
}

/** The line for a persona that was not latched. Pure. */
export function clearLatchNotLatchedLine(name: string, key: string): string {
  return `[slack] ${CLEAR_LATCH_COMMAND}: persona ${renderPersonaRef(name, key)} was not latched; nothing changed`
}

/** The line for a request that named no applied persona; it never carries the argument. Pure. */
export function clearLatchUnknownPersonaLine(): string {
  return `[slack] ${CLEAR_LATCH_COMMAND}: no persona in the applied configuration has the requested name or key; nothing cleared`
}

/** The line for a clear that rejected; `error` is the rejection as `describeThrownValue` describes it. Pure. */
export function clearLatchFailedLine(name: string, key: string, error: string): string {
  return `[slack] ${CLEAR_LATCH_COMMAND}: the clear of persona ${renderPersonaRef(name, key)} failed: ${error}`
}

/** A JSON response with the given status. */
function jsonResponse(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

/** `log(line)`, a throw swallowed. */
function safeLog(log: (line: string) => void, line: string): void {
  try {
    log(line)
  } catch {
    /* a failing log changes no answer */
  }
}

/**
 * Handle one `POST /clear-latch` request (b.jg5 SRJ-510). `remoteAddress` is
 * the caller's address (from `server.requestIP(req)`); absent means not local
 * (403). Checks, in order: the method, the loopback rule, the body cap, the
 * JSON, the `persona` field and its resolution against the applied config;
 * then exactly one call of `deps.clearByHand` with the resolved key, awaited
 * with no bound of its own, and the 200 answer with its result. A persona
 * that is not up is not refused. Never throws.
 */
export async function handleClearLatch(
  req: Request,
  remoteAddress: string | null | undefined,
  deps: ClearLatchDeps,
): Promise<Response> {
  if (req.method !== 'POST') return jsonResponse(405, { error: 'Method Not Allowed' })
  if (!isLocalAddress(remoteAddress ?? '')) return jsonResponse(403, { error: 'Forbidden' })

  let bodyText: string
  try {
    bodyText = await req.text()
  } catch {
    return jsonResponse(400, { error: 'Unreadable request body' })
  }
  if (new TextEncoder().encode(bodyText).byteLength > INTERJECT_BODY_CAP_BYTES) {
    return jsonResponse(400, { error: 'Request body too large (max 32KB)' })
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(bodyText)
  } catch {
    return jsonResponse(400, { error: 'Invalid JSON' })
  }
  const target = typeof parsed === 'object' && parsed !== null ? (parsed as { persona?: unknown }).persona : undefined
  if (typeof target !== 'string' || !target) {
    return jsonResponse(400, { error: 'Missing or invalid field: persona (string) required' })
  }

  const log = deps.log ?? ((line: string) => console.error(line))
  const persona = resolvePersonaTarget(deps.getPersonaConfig(), target)
  if (!persona) {
    safeLog(log, clearLatchUnknownPersonaLine())
    return jsonResponse(404, { error: 'Persona not found in the applied config' })
  }

  let cleared: boolean
  try {
    cleared = await deps.clearByHand(persona.key)
  } catch (err) {
    safeLog(log, clearLatchFailedLine(persona.name, persona.key, describeThrownValue(err)))
    return jsonResponse(500, { error: 'Internal Server Error' })
  }
  if (!cleared) safeLog(log, clearLatchNotLatchedLine(persona.name, persona.key))
  return jsonResponse(200, { ok: true, persona: persona.name, cleared })
}
