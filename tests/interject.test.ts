/** /interject validation and real durable acceptance over isolated queue files. */
import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDeliveryPreparation } from '../src/delivery-intake.ts'
import { MESSAGE_RECEIVED, buildDeliveryDiagnostic, deliveryIdentity } from '../src/delivery-notices.ts'
import { createFakeClock } from './test-helpers/fake-clock.ts'
import { handleInterject, INTERJECT_BODY_CAP_BYTES, type InterjectDeps } from '../src/interject.ts'
import { personaKey, renderPersonaRef } from '../src/persona-identity.ts'
import { makeMultiPersonaConfig } from './test-helpers/persona-config.ts'
import { makeQueue, readQueue } from './test-helpers/delivery-queue.ts'
import { indicesOf, stripComments } from './test-helpers/source-audit.ts'
import { assertNoLeak } from './test-helpers/credentials.ts'
import type { PersonaConfig } from '../src/config.ts'
let dir: string, config: PersonaConfig | null, queue: Awaited<ReturnType<typeof makeQueue>>, logs: string[]
const A_NAME = 'Planner Bot', B_NAME = 'reviewer', A_KEY = personaKey(A_NAME), B_KEY = personaKey(B_NAME), NOW_MS = 1700000000123
let failure: boolean
beforeEach(async () => { dir = mkdtempSync(join(tmpdir(), 'interject-')); config = makeMultiPersonaConfig([{name:A_NAME},{name:B_NAME}],dir); queue=await makeQueue(dir,{now:()=>NOW_MS}); logs=[]; failure=false })
afterEach(async () => { assertNoLeak({logs}); await queue.stop(); rmSync(dir,{recursive:true,force:true}) })
function deps(): InterjectDeps { return {getPersonaConfig:()=>config, accept: (key,input)=> failure ? Promise.resolve({status:'failed',error:new Error('EIO')}) : queue.accept(key,input), now:()=>NOW_MS, log:line=>logs.push(line)} }
function interject(body: unknown, opts: { method?: string; remote?: string | null } = {}) { const method=opts.method??'POST'; return handleInterject(new Request('http://127.0.0.1/interject',{method,...(method==='GET'||method==='HEAD'?{}:{body: typeof body==='string'?body:JSON.stringify(body)})}), 'remote' in opts ? opts.remote : '127.0.0.1', deps()) }
function expectNoDelivery() { expect(queue.items(A_KEY)).toEqual([]); expect(queue.items(B_KEY)).toEqual([]) }
const httpServer = Bun.serve({hostname:'127.0.0.1',port:0,fetch:(req,server)=>handleInterject(req,server.requestIP(req)?.address,deps())})
const HTTP_URL = `http://127.0.0.1:${httpServer.port}/interject`
afterAll(()=>httpServer.stop(true))
function bodyOfBytes(bytes: number) {const head='é';const overhead=Buffer.byteLength(JSON.stringify({persona:B_NAME,message:head}));const message=head+'x'.repeat(bytes-overhead);return {text:JSON.stringify({persona:B_NAME,message}),message}}
describe('/interject status table', () => {
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
    expect(queue.items(B_KEY)).toHaveLength(1)
  })

  test.each([
    ['missing persona', { message: 'hi' }],
    ['numeric persona', { persona: 42, message: 'hi' }],
    ['null persona', { persona: null, message: 'hi' }],
    ['object persona', { persona: { name: B_NAME }, message: 'hi' }],
    ['empty persona', { persona: '', message: 'hi' }],
    ['legacy channel-only body', { channel: 'C0TEST002', message: 'hi' }],
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
    ['a channel ID of a persona (channels are not targets)', 'C0TEST002'],
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

})
describe('/interject 32 KB body cap (in-process HTTP, port 0)', () => {
  test('the cap is 32768 bytes', () => {
    expect(INTERJECT_BODY_CAP_BYTES).toBe(32768)
  })

  test('a body of exactly 32768 UTF-8 bytes is accepted and delivered whole', async () => {
    const { text, message } = bodyOfBytes(32768)
    const res = await fetch(HTTP_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: text })
    expect(res.status).toBe(200)
    expect(queue.items(B_KEY)).toHaveLength(1)
    expect(queue.items(B_KEY)[0]!.accepted.text).toBe(message)
    expect(queue.items(A_KEY)).toHaveLength(0)
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
// only the named persona is reached
// ---------------------------------------------------------------------------

describe('/interject reaches only the named persona', () => {
  test.each([
    ['by name', A_NAME],
    ['by key', A_KEY],
  ])("persona A addressed %s → 200 with A's name, one notification on A, none on B", async (_label, persona) => {
    const res = await interject({ persona, message: 'for A only' })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, persona: A_NAME })
    expect(queue.items(A_KEY)).toHaveLength(1)
    expect(queue.items(A_KEY)[0]!.accepted.text).toBe('for A only')
    expect(queue.items(B_KEY)).toHaveLength(0)
    expect(logs.some((l) => l.includes(renderPersonaRef(A_NAME, A_KEY)))).toBe(true)
  })

  test('a request for B reaches only B', async () => {
    const res = await interject({ persona: B_NAME, message: 'for B only' })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, persona: B_NAME })
    expect(queue.items(B_KEY)).toHaveLength(1)
    expect(queue.items(A_KEY)).toHaveLength(0)
  })

  test('a real loopback HTTP request by key reaches only that persona', async () => {
    const res = await fetch(HTTP_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ persona: A_KEY, message: 'over http' }),
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, persona: A_NAME })
    expect(queue.items(A_KEY)).toHaveLength(1)
    expect(queue.items(B_KEY)).toHaveLength(0)
  })
})


test('known persona accepts with exact 200 after durable storage',async () => {
 const result=await interject({persona:A_NAME,message:'queued',sender:'ops'});expect(result.status).toBe(200);expect(await result.json()).toEqual({ok:true,persona:A_NAME});expect(readQueue(dir,A_KEY)).toMatchObject([{kind:'accepted',source:'interject',sender:'ops',text:'queued',ts:'1700000000.123000'}]);expect(queue.items(B_KEY)).toEqual([])
})
test('store failure answers 500 Message not stored, leaves queue and success logs empty',async()=>{failure=true;const result=await interject({persona:A_NAME,message:'queued'});expect(result.status).toBe(500);expect(await result.json()).toEqual({error:'Message not stored'});expectNoDelivery();expect(logs).toEqual([])})
test('identical injected requests remain separate with increasing timestamps and stored excerpt logs',async()=>{for(let i=0;i<2;i++)expect((await interject({persona:B_KEY,message:'repeat'})).status).toBe(200);expect(queue.items(B_KEY).map(i=>i.accepted.ts)).toEqual(['1700000000.123000','1700000000.123001']);expect(logs).toHaveLength(2);expect(logs[0]).toContain('queued for persona');expect(logs[0]).toContain('message="repeat"')})
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

  test('imports handleInterject ./interject.ts', () => {
    expect(SERVER_CODE).toMatch(/import\s*\{[^}]*\bhandleInterject\b[^}]*\}\s*from\s*['"]\.\/interject\.ts['"]/)
  })

  test('the /interject branch returns handleInterject with the request, its remote address and the persona deps', () => {
    const branch = interjectBranch()
    expect(branch).toMatch(/return\s+handleInterject\(\s*req,\s*server\.requestIP\(req\)\?\.address,/)
    expect(branch).toMatch(/getPersonaConfig:\s*\(\)\s*=>\s*personaConfig\b/)
    expect(branch).toMatch(/accept:\s*\(key, input\)\s*=>\s*deliveryPreparation[?!]?\.accept\(key, input\)/)
    expect(branch).not.toContain('notifications/claude/channel')
    expect(branch).not.toContain('getSessionByPersona')
    expect(branch).not.toContain('isPersonaUp')
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

test.each([[undefined, 'interject'], [null, 'interject'], ['', 'interject'], [42, 'interject'], ['script-label', 'script-label']])('sender %p is accepted as %s', async (sender, expected) => {
  expect((await interject({ persona: B_NAME, message: 'prompt', sender })).status).toBe(200)
  expect(queue.items(B_KEY).map(i => i.accepted.sender)).toEqual([expected])
  expect(queue.items(A_KEY)).toEqual([])
})
test('logging follows durable acceptance and keeps the existing 80-character message excerpt', async () => {
  const text = 'x'.repeat(90)
  let logged = false
  const result = await handleInterject(new Request('http://127.0.0.1/interject', { method: 'POST', body: JSON.stringify({ persona: A_NAME, message: text }) }), '127.0.0.1', { ...deps(), log: line => {
    logged = true
    expect(readQueue(dir, A_KEY)).toMatchObject([{ kind: 'accepted', text }])
    expect(line).toBe(`[slack] /interject: queued for persona ${renderPersonaRef(A_NAME, A_KEY)} sender="interject" message="${text.slice(0, 80)}"`)
  } })
  expect(result.status).toBe(200); expect(logged).toBe(true)
})
test('a throwing accept function answers Message not stored with no success log', async () => {
  const result = await handleInterject(new Request('http://127.0.0.1/interject', { method: 'POST', body: JSON.stringify({ persona: A_NAME, message: 'prompt' }) }), '127.0.0.1', { ...deps(), accept: async () => { throw new Error('EIO') } })
  expect(result.status).toBe(500); expect(await result.json()).toEqual({ error: 'Message not stored' }); expectNoDelivery(); expect(logs).toEqual([])
})

// injected acceptance reports after the HTTP answer, without a body.
test('received reporting follows the successful interject response', async () => {
  const clock = createFakeClock(), diagnostics: string[] = []
  let answered = false
  const preparation = createDeliveryPreparation({ queue, clock, clientFor: () => undefined, resolveUserName: async () => '',
    onReceived: (key, item) => {
      expect(answered).toBe(true)
      diagnostics.push(buildDeliveryDiagnostic(MESSAGE_RECEIVED, renderPersonaRef(A_NAME, key), deliveryIdentity(item.accepted)))
    },
  })
  try {
    const response = await handleInterject(new Request('http://127.0.0.1/interject', { method: 'POST', body: JSON.stringify({ persona: A_NAME, message: 'private injected body', sender: 'ops' }) }), '127.0.0.1', { ...deps(), accept: preparation.accept })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: true, persona: A_NAME })
    expect(diagnostics).toEqual([])
    answered = true
    await clock.advance(1)
    expect(diagnostics).toEqual([buildDeliveryDiagnostic(MESSAGE_RECEIVED, renderPersonaRef(A_NAME, A_KEY), deliveryIdentity(queue.items(A_KEY)[0]!.accepted))])
    expect(JSON.stringify(diagnostics)).not.toContain('private injected body')
    expect(queue.items(B_KEY)).toEqual([])
    assertNoLeak({ diagnostics, logs })
  } finally { await preparation.stop() }
})
