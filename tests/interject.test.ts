/**
 * interject.test.ts — The `/interject` handler (b.av2 SR-9.1, SR-9.2, SR-10.2,
 * SR-13.1; AC 50's `/interject` leg).
 *
 * Drives the real `handleInterject` from src/interject.ts with injected
 * dependencies: a two-persona config from `makeMultiPersonaConfig`, stub
 * sessions keyed by persona key that capture `notification` calls, a fixed
 * clock and a capturing logger. Most cases call the handler directly; the
 * body-size cap and the loopback check also run over a real HTTP request to a
 * port-0 `Bun.serve` bound to 127.0.0.1 in this process, the way server.ts
 * hands the request over (`server.requestIP(req)?.address`).
 *
 * server.ts cannot be imported (module-scope side effects), so its delegation
 * to the handler and its cron-target resolver are checked statically against
 * its comment-stripped source text.
 *
 * SPDX-License-Identifier: MIT
 */

import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  INTERJECT_BODY_CAP_BYTES,
  handleInterject,
  type InterjectDeps,
  type InterjectSession,
} from '../src/interject.ts'
import type { PersonaConfig } from '../src/config.ts'
import { personaKey, renderPersonaRef } from '../src/persona-identity.ts'
import { makeMultiPersonaConfig } from './test-helpers/persona-config.ts'
import { indicesOf, stripComments } from './test-helpers/source-audit.ts'

// ---------------------------------------------------------------------------
// Fixture: persona A has a name with capitals and a space (so its key is the
// hashed form), persona B a plain `a-z0-9_` name (its key is its name). Their
// channels are the helper's C0TEST001 / C0TEST002, which no key equals.
// ---------------------------------------------------------------------------

const A_NAME = 'Planner Bot'
const A_KEY = personaKey(A_NAME)
const B_NAME = 'reviewer'
const B_KEY = personaKey(B_NAME)

/** Fixed clock: 1_700_000_000.123 s. */
const NOW_MS = 1_700_000_000_123

interface CapturedNotification {
  method: string
  params: { content: string; meta: Record<string, string> }
}

interface StubSession {
  session: InterjectSession
  calls: CapturedNotification[]
}

/** A stub session that records each notification; `result` is what it returns. */
function makeStubSession(connected = true, result: () => Promise<void> = () => Promise.resolve()): StubSession {
  const calls: CapturedNotification[] = []
  const server = {
    notification: (n: CapturedNotification) => {
      calls.push(n)
      return result()
    },
  }
  return { session: { connected, server } as unknown as InterjectSession, calls }
}

let dir: string
let config: PersonaConfig | null
let sessions: Map<string, InterjectSession>
let a: StubSession
let b: StubSession
let logs: string[]

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cscb-interject-'))
  config = makeMultiPersonaConfig([{ name: A_NAME }, { name: B_NAME }], dir)
  a = makeStubSession()
  b = makeStubSession()
  sessions = new Map([
    [A_KEY, a.session],
    [B_KEY, b.session],
  ])
  logs = []
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function deps(): InterjectDeps {
  return {
    getPersonaConfig: () => config,
    getSessionByPersona: (key) => sessions.get(key),
    now: () => NOW_MS,
    log: (line) => logs.push(line),
  }
}

/** Call the handler directly. A string body is sent raw; anything else as JSON. */
function interject(
  body: unknown,
  opts: { method?: string; remote?: string | null | undefined } = {},
): Promise<Response> {
  const method = opts.method ?? 'POST'
  const init: RequestInit = { method, headers: { 'Content-Type': 'application/json' } }
  if (method !== 'GET' && method !== 'HEAD' && body !== undefined) {
    init.body = typeof body === 'string' ? body : JSON.stringify(body)
  }
  const remote = 'remote' in opts ? opts.remote : '127.0.0.1'
  return handleInterject(new Request('http://127.0.0.1/interject', init), remote, deps())
}

function expectNoDelivery(): void {
  expect(a.calls).toHaveLength(0)
  expect(b.calls).toHaveLength(0)
}

// ---------------------------------------------------------------------------
// In-process HTTP path: port 0 on 127.0.0.1, handed over as server.ts does.
// ---------------------------------------------------------------------------

const httpServer = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  fetch: (req, server) => handleInterject(req, server.requestIP(req)?.address, deps()),
})
const HTTP_URL = `http://127.0.0.1:${httpServer.port}/interject`

afterAll(() => {
  httpServer.stop(true)
})

/** UTF-8 byte length. */
function byteLength(s: string): number {
  return new TextEncoder().encode(s).byteLength
}

/**
 * A serialized body for persona B of exactly `bytes` UTF-8 bytes. The message
 * opens with a two-byte character, so the byte count exceeds the character
 * count and a character-counting cap would get the boundary wrong.
 */
function bodyOfBytes(bytes: number): { text: string; message: string } {
  const head = 'é'
  const overhead = byteLength(JSON.stringify({ persona: B_NAME, message: head }))
  const message = head + 'x'.repeat(bytes - overhead)
  const text = JSON.stringify({ persona: B_NAME, message })
  expect(byteLength(text)).toBe(bytes)
  return { text, message }
}

// ---------------------------------------------------------------------------
// SR-9.1 status table
// ---------------------------------------------------------------------------

describe('/interject status table (SR-9.1)', () => {
  test.each([
    ['GET', 405],
    ['PUT', 405],
    ['DELETE', 405],
  ] as const)('%s → %i Method Not Allowed, nothing delivered', async (method, status) => {
    const res = await interject({ persona: B_NAME, message: 'hi' }, { method })
    expect(res.status).toBe(status)
    expect(await res.json()).toEqual({ error: 'Method Not Allowed' })
    expectNoDelivery()
  })

  test.each([
    ['10.0.0.5'],
    ['192.168.1.20'],
    ['::ffff:10.0.0.5'],
    ['fe80::1'],
    [''],
    [null],
    [undefined],
  ])('remote address %p → 403, nothing delivered', async (remote) => {
    const res = await interject({ persona: B_NAME, message: 'hi' }, { remote })
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: 'Forbidden' })
    expectNoDelivery()
  })

  test.each([['127.0.0.1'], ['::1'], ['::ffff:127.0.0.1']])('loopback remote address %s → 200', async (remote) => {
    const res = await interject({ persona: B_NAME, message: 'hi' }, { remote })
    expect(res.status).toBe(200)
    expect(b.calls).toHaveLength(1)
  })

  test.each([
    ['missing persona', { message: 'hi' }],
    ['numeric persona', { persona: 42, message: 'hi' }],
    ['null persona', { persona: null, message: 'hi' }],
    ['object persona', { persona: { name: B_NAME }, message: 'hi' }],
    ['empty persona', { persona: '', message: 'hi' }],
    ['legacy channel-only body (SR-10.2)', { channel: 'C0TEST002', message: 'hi' }],
    ['JSON array body', '[]'],
    ['JSON string body', JSON.stringify(B_NAME)],
    ['JSON number body', '42'],
    ['JSON null body', 'null'],
  ])('%s → 400 naming persona, nothing delivered', async (_label, body) => {
    const res = await interject(body)
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'Missing or invalid field: persona (string) required' })
    expectNoDelivery()
  })

  test.each([
    ['missing message', { persona: B_NAME }],
    ['empty message', { persona: B_NAME, message: '' }],
    ['numeric message', { persona: B_NAME, message: 7 }],
  ])('%s → 400 naming message, nothing delivered', async (_label, body) => {
    const res = await interject(body)
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'Missing or invalid field: message (string) required' })
    expectNoDelivery()
  })

  test('invalid JSON → 400 Invalid JSON, nothing delivered', async () => {
    const res = await interject('not valid json {{{')
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'Invalid JSON' })
    expectNoDelivery()
  })

  test.each([
    ['unknown name', 'nobody'],
    ['a channel ID of a persona (channels are not targets, SR-10.2)', 'C0TEST002'],
    ['the name in another case', 'REVIEWER'],
    ["A's key with a trailing space", `${A_KEY} `],
  ])('%s → 404, nothing delivered', async (_label, persona) => {
    const res = await interject({ persona, message: 'hi' })
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'Persona not found in the applied config' })
    expectNoDelivery()
  })

  test.each([
    ['a config with zero personas', () => makeMultiPersonaConfig([], dir)],
    ['a null applied config', () => null],
  ])('%s → 404 for a persona that exists elsewhere, nothing delivered', async (_label, build) => {
    config = build()
    const res = await interject({ persona: B_NAME, message: 'hi' })
    expect(res.status).toBe(404)
    expectNoDelivery()
  })

  test.each([
    ['no session registered', (): StubSession | undefined => undefined],
    ['a disconnected session', (): StubSession | undefined => makeStubSession(false)],
  ])('%s → 503, nothing delivered', async (_label, build) => {
    const stub = build()
    if (stub) sessions.set(B_KEY, stub.session)
    else sessions.delete(B_KEY)
    const res = await interject({ persona: B_NAME, message: 'hi' })
    expect(res.status).toBe(503)
    expect(await res.json()).toEqual({ error: 'No active session for this persona' })
    expectNoDelivery()
    expect(stub?.calls ?? []).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// Body-size cap, over a real loopback HTTP request
// ---------------------------------------------------------------------------

describe('/interject 32 KB body cap (in-process HTTP, port 0)', () => {
  test('the cap is 32768 bytes', () => {
    expect(INTERJECT_BODY_CAP_BYTES).toBe(32768)
  })

  test('a body of exactly 32768 UTF-8 bytes is accepted and delivered whole', async () => {
    const { text, message } = bodyOfBytes(32768)
    const res = await fetch(HTTP_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: text })
    expect(res.status).toBe(200)
    expect(b.calls).toHaveLength(1)
    expect(b.calls[0]!.params.content).toBe(message)
    expect(a.calls).toHaveLength(0)
  })

  test('a body of 32769 UTF-8 bytes → 413, nothing delivered', async () => {
    const { text } = bodyOfBytes(32769)
    const res = await fetch(HTTP_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: text })
    expect(res.status).toBe(413)
    expect(await res.json()).toEqual({ error: 'Request body too large (max 32KB)' })
    expectNoDelivery()
  })
})

// ---------------------------------------------------------------------------
// AC 50 — only the named persona is reached
// ---------------------------------------------------------------------------

describe('AC 50: /interject reaches only the named persona', () => {
  test.each([
    ['by name', A_NAME],
    ['by key', A_KEY],
  ])("AC 50: persona A addressed %s → 200 with A's name, one notification on A, none on B", async (_label, persona) => {
    const res = await interject({ persona, message: 'for A only' })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, persona: A_NAME })
    expect(a.calls).toHaveLength(1)
    expect(a.calls[0]!.params.content).toBe('for A only')
    expect(b.calls).toHaveLength(0)
    expect(logs.some((l) => l.includes(renderPersonaRef(A_NAME, A_KEY)))).toBe(true)
  })

  test('AC 50: a request for B reaches only B', async () => {
    const res = await interject({ persona: B_NAME, message: 'for B only' })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, persona: B_NAME })
    expect(b.calls).toHaveLength(1)
    expect(a.calls).toHaveLength(0)
  })

  test('AC 50: a real loopback HTTP request by key reaches only that persona', async () => {
    const res = await fetch(HTTP_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ persona: A_KEY, message: 'over http' }),
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, persona: A_NAME })
    expect(a.calls).toHaveLength(1)
    expect(b.calls).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// SR-9.2 — notification shape and meta
// ---------------------------------------------------------------------------

describe('/interject notification meta (SR-9.2)', () => {
  test('method and content unchanged; meta is exactly { user, ts } — no chat_id, message_id or via', async () => {
    await interject({ persona: B_NAME, message: 'Hello from interject', sender: 'cscb-cron:tick' })
    expect(b.calls).toEqual([
      {
        method: 'notifications/claude/channel',
        params: { content: 'Hello from interject', meta: { user: 'cscb-cron:tick', ts: '1700000000.123' } },
      },
    ])
    expect(Object.keys(b.calls[0]!.params.meta).sort()).toEqual(['ts', 'user'])
  })

  test.each([
    ['a custom sender', { sender: 'ops-script' }, 'ops-script'],
    ['an omitted sender', {}, 'interject'],
    ['an empty sender', { sender: '' }, 'interject'],
    ['a non-string sender', { sender: 42 }, 'interject'],
  ])('%s → meta.user %p', async (_label, extra, user) => {
    await interject({ persona: B_NAME, message: 'hi', ...extra })
    expect(b.calls[0]!.params.meta.user).toBe(user)
  })

  // The b.wr5 reply guard treats a ts without six fractional digits as an
  // injected prompt; ts is String(epoch ms / 1000), never a Slack-shaped ts.
  test.each([
    [1_700_000_000_123, '1700000000.123'],
    [1_700_000_000_120, '1700000000.12'],
    [1_700_000_000_000, '1700000000'],
  ])('clock %i ms → ts %p (Unix seconds, never six fractional digits)', async (nowMs, ts) => {
    const res = await handleInterject(
      new Request('http://127.0.0.1/interject', { method: 'POST', body: JSON.stringify({ persona: B_NAME, message: 'hi' }) }),
      '127.0.0.1',
      { ...deps(), now: () => nowMs },
    )
    expect(res.status).toBe(200)
    const meta = b.calls[0]!.params.meta
    expect(meta.ts).toBe(ts)
    expect(Number(meta.ts)).toBe(nowMs / 1000)
    expect(meta.ts).not.toMatch(/\.\d{6}$/)
  })

  test('with the default clock, ts is the current Unix time in seconds and not Slack-shaped', async () => {
    const before = Date.now() / 1000
    const res = await handleInterject(
      new Request('http://127.0.0.1/interject', { method: 'POST', body: JSON.stringify({ persona: B_NAME, message: 'hi' }) }),
      '127.0.0.1',
      { ...deps(), now: undefined },
    )
    const after = Date.now() / 1000
    expect(res.status).toBe(200)
    const ts = b.calls[0]!.params.meta.ts!
    expect(ts).toMatch(/^\d+(\.\d{1,3})?$/)
    expect(Number(ts)).toBeGreaterThanOrEqual(before)
    expect(Number(ts)).toBeLessThanOrEqual(after)
  })

  test('a notification that rejects later still answers 200 and logs the failure with the persona', async () => {
    const failing = makeStubSession(true, () => Promise.reject(new Error('transport closed')))
    sessions.set(B_KEY, failing.session)
    const res = await interject({ persona: B_NAME, message: 'hi' })
    expect(res.status).toBe(200)
    expect(failing.calls).toHaveLength(1)
    await Bun.sleep(0)
    const failure = logs.find((l) => l.includes('failed'))
    expect(failure).toContain(`notification to persona ${renderPersonaRef(B_NAME, B_KEY)} failed`)
  })
})

// ---------------------------------------------------------------------------
// Static wiring: server.ts delegates /interject to the handler module and
// resolves cron targets through resolvePersonaTarget
// ---------------------------------------------------------------------------

describe('server.ts wires /interject and cron targets by persona (static audit)', () => {
  // Comments stripped (see stripComments), so commented-out code or prose
  // naming a call can never satisfy an assertion.
  const SERVER_CODE = stripComments(readFileSync(join(import.meta.dir, '..', 'src', 'server.ts'), 'utf-8'))

  /** The `/interject` branch: from its path test to the next path test. */
  function interjectBranch(): string {
    const starts = indicesOf(/url\.pathname\s*===\s*'\/interject'/g, SERVER_CODE)
    expect(starts).toHaveLength(1)
    const next = SERVER_CODE.indexOf('url.pathname', starts[0]! + 1)
    return SERVER_CODE.slice(starts[0]!, next === -1 ? undefined : next)
  }

  /** The argument text of the only `createCronDispatcher(...)` call, parentheses excluded. */
  function cronDispatcherArguments(): string {
    const calls = indicesOf(/\bcreateCronDispatcher\s*\(/g, SERVER_CODE)
    expect(calls).toHaveLength(1)
    const open = SERVER_CODE.indexOf('(', calls[0]!)
    let depth = 0
    for (let i = open; i < SERVER_CODE.length; i++) {
      if (SERVER_CODE[i] === '(') depth++
      else if (SERVER_CODE[i] === ')' && --depth === 0) return SERVER_CODE.slice(open + 1, i)
    }
    throw new Error('unbalanced createCronDispatcher call')
  }

  test('imports handleInterject from ./interject.ts', () => {
    expect(SERVER_CODE).toMatch(/import\s*\{[^}]*\bhandleInterject\b[^}]*\}\s*from\s*['"]\.\/interject\.ts['"]/)
  })

  test('the /interject branch returns handleInterject with the request, its remote address and the persona deps', () => {
    const branch = interjectBranch()
    expect(branch).toMatch(/return\s+handleInterject\(\s*req,\s*server\.requestIP\(req\)\?\.address,/)
    expect(branch).toMatch(/getPersonaConfig:\s*\(\)\s*=>\s*personaConfig\b/)
    expect(branch).toContain('getSessionByPersona')
    expect(branch).not.toContain('notifications/claude/channel')
  })

  test('the cron dispatcher resolves each target to a persona key against the applied persona config', () => {
    expect(SERVER_CODE).toMatch(
      /import\s*\{[^}]*\bresolvePersonaTarget\b[^}]*\}\s*from\s*['"]\.\/persona-identity\.ts['"]/,
    )
    expect(cronDispatcherArguments()).toMatch(
      /\bresolveTarget\s*:\s*\(\s*target\s*\)\s*=>\s*resolvePersonaTarget\(\s*personaConfig\s*,\s*target\s*\)\s*\?\.\s*key\b/,
    )
  })

  test.each([
    ['Channel not found in routing config'],
    ['No active session for this channel'],
    ['Missing or invalid field: channel'],
  ])('the old inline handler text %p is gone', (text) => {
    expect(SERVER_CODE).not.toContain(text)
  })
})
