/** b.6cg regression-first contract. Real route/CLI/queue/engine; only disk,
 * transport and the clock are injected. Import the new route within each
 * case so its absence fails that case, without preventing test collection. */
import { afterEach, describe, expect, spyOn, test } from 'bun:test'
import { EventEmitter } from 'node:events'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import type { ClientRequest, IncomingMessage, RequestOptions } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createCli, type CliDeps } from '../src/cli.ts'
import { createPersonaUpPredicate } from '../src/persona-start.ts'
import { INTERJECT_BODY_CAP_BYTES } from '../src/interject.ts'
import { SERVER_PORT_CAUSE_ABSENT, SERVER_PORT_CAUSE_UNREADABLE, SERVER_PORT_CAUSE_MALFORMED, SERVER_PORT_CAUSE_OUT_OF_RANGE, SERVER_PORT_CAUSE_OTHER_PID } from '../src/clear-latch.ts'
import { describeThrownValue } from '../src/persona-connection-errors.ts'
import { personaKey } from '../src/persona-identity.ts'
import { makeMultiPersonaConfig } from './test-helpers/persona-config.ts'
import { makeEngineHarness, type EngineHarness } from './test-helpers/delivery-engine.ts'
import { deliveredRecord, queuePath, slackInput } from './test-helpers/delivery-queue.ts'
import { holdFirstSync } from './test-helpers/durable-io.ts'
import { createFakeClock } from './test-helpers/fake-clock.ts'
import { assertNoLeak, BOT_TOKEN_PREFIX, fakeToken, LEAK_SENTINEL, sentinelInMessage } from './test-helpers/credentials.ts'
import { onlyCallArguments, stripComments } from './test-helpers/source-audit.ts'

const subject = () => import('../src/abandon-message.ts')
const ts = '1700000000.000001', nextTs = '1700000000.000002'
const typo = () => fakeToken(BOT_TOKEN_PREFIX, 'operator-typo')
const engines: EngineHarness[] = [], dirs: string[] = []
const captured: unknown[] = []
afterEach(async () => {
  try { assertNoLeak(captured.splice(0)) }
  finally {
    for (const e of engines.splice(0)) await e.cleanup()
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  }
})

async function routeFixture(queueFs?: NonNullable<Parameters<typeof makeEngineHarness>[0]>['queueFs']) {
  const e = await makeEngineHarness({ keys: ['alpha', 'beta'], queueFs }); engines.push(e)
  const config = makeMultiPersonaConfig([{ name: 'alpha' }, { name: 'beta' }], e.root)
  const logs: string[] = [], calls: Array<[string, number]> = []
  const isUp = createPersonaUpPredicate({ status: () => ({ state: 'up', identity: { botUserId: 'U0BOT001', botId: 'B0BOT001' } }) }, {
    isApplied: key => e.p(key).applied, isUp: key => e.p(key).up,
  })
  const deps = {
    getPersonaConfig: () => config, isUp, queue: e.queue,
    abandonHead: (key: string, seq: number) => { calls.push([key, seq]); return e.engine.abandonHead(key, seq) },
    log: (line: string) => logs.push(line),
  }
  await e.queue.accept('alpha', slackInput({ text: 'PRIVATE abandoned text' }))
  await e.queue.accept('alpha', slackInput({ text: 'later', ts: nextTs, key: { chat_id: 'C0TEST001', ts: nextTs } }))
  async function request(body: unknown = { persona: 'alpha', ts }, method = 'POST', remote: string | null | undefined = '127.0.0.1') {
    const mod = await subject()
    const req = new Request(`http://127.0.0.1${mod.ABANDON_MESSAGE_ROUTE}`, {
      method, ...(method === 'GET' || method === 'HEAD' ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
    })
    const res = await mod.handleAbandonMessage(req, remote, deps)
    const answer = { status: res.status, body: await res.json() }
    captured.push(answer, logs)
    expect(JSON.stringify(answer)).not.toContain('PRIVATE abandoned text')
    return answer
  }
  return { e, config, deps, request, calls, logs }
}

describe('b.6cg POST /abandon-message', () => {
  test.each(['delivered', 'abandoned'] as const)('same-ts head revision wins over an earlier %s revision', async closed => {
    const r = await routeFixture()
    if (closed === 'delivered') {
      await r.e.queue.append('alpha', { v: 1, kind: 'fixed', seq: 1, parts: ['original'] })
      await r.e.queue.append('alpha', deliveredRecord())
    } else expect(await r.e.queue.abandon('alpha', 1, 1)).toBe('abandoned')
    const revision = await r.e.queue.accept('alpha', slackInput({ ts, key: { chat_id: 'C0TEST001', ts, edited_ts: nextTs } }))
    expect(revision.status).toBe('accepted')
    if (revision.status === 'failed') throw new Error('revision fixture store failed')
    // The open revision is not head yet; its older closed copy must not mask it.
    expect(await r.request()).toEqual({ status: 409, body: { reason: 'not-head', head_ts: nextTs } })
    expect(await r.e.queue.abandon('alpha', 2, 2)).toBe('abandoned')
    expect(await r.request()).toEqual({ status: 200, body: { ok: true, persona: 'alpha', seq: revision.seq } })
    expect(r.e.queue.item('alpha', revision.seq!)!.abandoned).toBeDefined()
    expect(await r.request()).toEqual({ status: 409, body: { reason: 'already-abandoned' } })
    expect(r.e.queue.item('alpha', 1)!.delivered).toBe(closed === 'delivered')
    expect(r.e.keyCalls()).toEqual([])
  })

  test.each(['GET', 'PUT', 'DELETE'])('%s is 405 before locality or body checks', async method => {
    const r = await routeFixture()
    expect((await r.request({ persona: typo(), ts }, method, '192.0.2.1')).status).toBe(405)
    expect(r.calls).toEqual([]); expect(r.logs).toEqual([])
  })
  test.each(['192.0.2.1', '::2', '', null])('remote %s is 403 and cannot mutate or leak input', async remote => {
    const r = await routeFixture()
    expect((await r.request({ persona: typo(), ts }, 'POST', remote)).status).toBe(403)
    expect(r.calls).toEqual([]); expect(r.logs).toEqual([])
  })
  test.each([
    '{', 'null', '[]', '{}', { persona: '', ts }, { persona: 1, ts }, { persona: 'alpha' },
    ...['1', '1.1', '1.12345', '1.1234567', '-1.123456', '1e2.123456', '1.123456\n', ' 1.123456', 1, null].map(ts => ({ persona: 'alpha', ts })),
  ])('invalid JSON or persona/ts shape %j is 400', async body => {
    const r = await routeFixture()
    expect((await r.request(body)).status).toBe(400)
    expect(r.calls).toEqual([]); expect(r.logs).toEqual([])
  })
  test.each([0, 1])('the UTF-8 body cap boundary +%i bytes', async extra => {
    const r = await routeFixture()
    const start = JSON.stringify({ persona: 'alpha', ts, pad: 'é' })
    const body = start.replace('é', 'é' + 'x'.repeat(INTERJECT_BODY_CAP_BYTES - Buffer.byteLength(start) + extra))
    expect(Buffer.byteLength(body)).toBe(INTERJECT_BODY_CAP_BYTES + extra)
    expect((await r.request(body)).status).toBe(extra ? 400 : 200)
    expect(r.calls).toHaveLength(extra ? 0 : 1)
  })
  test('unknown persona is 404, without echoing the argument', async () => {
    const r = await routeFixture()
    expect((await r.request({ persona: typo(), ts })).status).toBe(404)
    expect(r.calls).toEqual([])
    expect(r.e.queue.openCount('alpha')).toBe(2)
  })
  test.each(['name', 'key'] as const)('a non-key persona name resolves by %s to the engine key', async target => {
    const name = 'Planner Bot', key = personaKey(name)
    const e = await makeEngineHarness({ keys: [key] }); engines.push(e)
    const config = makeMultiPersonaConfig([{ name }], e.root)
    const item = await e.accept('head', key)
    e.p(key).held = true
    const mod = await subject(), calls: Array<[string, number]> = []
    const response = await mod.handleAbandonMessage(new Request(`http://127.0.0.1${mod.ABANDON_MESSAGE_ROUTE}`, { method: 'POST',
      body: JSON.stringify({ persona: target === 'name' ? name : key, ts: item.accepted.ts }) }), '127.0.0.1', {
      getPersonaConfig: () => config,
      isUp: createPersonaUpPredicate({ status: () => ({ state: 'up', identity: { botUserId: 'U0BOT001', botId: 'B0BOT001' } }) }, {
        isUp: k => e.p(k).up, isApplied: k => e.p(k).applied,
      }), queue: e.queue,
      abandonHead: (k: string, seq: number) => { calls.push([k, seq]); return e.engine.abandonHead(k, seq) }, log: (line: string) => captured.push(line),
    })
    const body = await response.json(); captured.push(body)
    expect(response.status).toBe(200); expect(body).toEqual({ ok: true, persona: name, seq: item.accepted.seq })
    expect(calls).toEqual([[key, item.accepted.seq]])
  })
  test.each(['not-applied', 'not-up'] as const)('%s persona is 409 persona-down', async state => {
    const r = await routeFixture()
    if (state === 'not-applied') r.e.p().applied = false
    else r.e.p().up = false
    expect(await r.request()).toEqual({ status: 409, body: { reason: 'persona-down' } })
    expect(r.calls).toEqual([])
    expect(r.e.queue.openCount('alpha')).toBe(2)
    await r.e.queue.accept('beta', slackInput())
    expect(await r.request({ persona: 'beta', ts })).toEqual({ status: 200, body: { ok: true, persona: 'beta', seq: 1 } })
    expect(r.calls).toEqual([['beta', 1]])
    expect(r.e.queue.openCount('alpha')).toBe(2)
    expect(r.e.queue.openCount('beta')).toBe(0)
  })
  test.each(['latched', 'held'] as const)('an up but %s persona may be abandoned', async hold => {
    const r = await routeFixture(); r.e.p()[hold] = true
    expect(await r.request()).toEqual({ status: 200, body: { ok: true, persona: 'alpha', seq: 1 } })
    expect(r.e.queue.item('alpha', 1)!.abandoned).toBeDefined()
    expect(r.e.keyCalls()).toEqual([])
  })
  test.each(['127.0.0.1', '::1', '::ffff:127.0.0.1'])('loopback %s succeeds once and repeat is already-abandoned', async remote => {
    const r = await routeFixture()
    expect(await r.request({ persona: 'alpha', ts }, 'POST', remote)).toEqual({ status: 200, body: { ok: true, persona: 'alpha', seq: 1 } })
    expect(await r.request()).toEqual({ status: 409, body: { reason: 'already-abandoned' } })
    expect(r.e.records().filter(x => x.kind === 'abandoned')).toHaveLength(1)
  })
  test.each(['unknown-item', 'not-head', 'delivered', 'busy'] as const)('409 %s is a real queue/engine refusal', async reason => {
    const r = await routeFixture()
    let selected = ts, release: (() => void) | undefined
    if (reason === 'unknown-item') selected = '9999999999.999999'
    if (reason === 'not-head') selected = nextTs
    if (reason === 'delivered') {
      await r.e.queue.append('alpha', { v: 1, kind: 'fixed', seq: 1, parts: ['fixed'] })
      await r.e.queue.append('alpha', deliveredRecord())
    }
    if (reason === 'busy') release = r.e.lifecycle.acquire('alpha', 'delivery')
    const before = r.e.records()
    try {
      expect(await r.request({ persona: 'alpha', ts: selected })).toEqual({ status: 409, body: { reason, ...(reason === 'not-head' ? { head_ts: ts } : {}) } })
      expect(r.e.records()).toEqual(before)
    } finally { release?.() }
  })
  test('200 waits for the abandoned record fsync; an append failure returns one leak-free 500 line', async () => {
    const gate = holdFirstSync(path => path.endsWith('/queue/alpha.jsonl'), { armed: false })
    const r = await routeFixture(gate.io.fs)
    await subject() // Fail on the absent route before arming an unreleaseable hold.
    gate.state.armed = true
    let settled = false
    const pending = r.request().finally(() => { settled = true })
    await gate.reached()
    try {
      expect(settled).toBe(false)
      expect(r.e.queue.item('alpha', 1)!.abandoned).toBeUndefined()
      expect(r.e.queue.openCount('alpha')).toBe(2)
    } finally { gate.gate.fail(Object.assign(new Error(sentinelInMessage('abandon append')), { code: 'ENOSPC', privateDetail: LEAK_SENTINEL })) }
    expect(await pending).toEqual({ status: 500, body: { error: 'Internal Server Error' } })
    expect(r.logs).toHaveLength(1)
    expect(r.logs[0]).toContain('ENOSPC')
    expect(r.logs[0]).toContain('message=')
    expect(r.e.queue.item('alpha', 1)!.abandoned).toBeUndefined()
    assertNoLeak(r.logs)
  })
  test('successful response follows fsync and a reopened journal already excludes A', async () => {
    const gate = holdFirstSync(path => path.endsWith('/queue/alpha.jsonl'), { armed: false })
    const r = await routeFixture(gate.io.fs)
    await subject(); gate.state.armed = true
    let settled = false
    const pending = r.request().finally(() => { settled = true })
    await gate.reached()
    try { expect(settled).toBe(false) } finally { gate.gate.release() }
    expect(await pending).toEqual({ status: 200, body: { ok: true, persona: 'alpha', seq: 1 } })
    r.e.p().held = true
    await r.e.restartServer()
    expect(r.e.queue.item('alpha', 1)!.abandoned).toBeDefined()
    expect(r.e.queue.openCount('alpha')).toBe(1)
    expect(readFileSync(queuePath(r.e.root), 'utf8')).toContain('PRIVATE abandoned text')
  })
  test('server delegates the new route with its production persona-up predicate', async () => {
    const mod = await subject()
    const source = stripComments(readFileSync(join(import.meta.dir, '../src/server.ts'), 'utf8'))
    expect(source).toContain('handleAbandonMessage')
    expect(source).toContain('ABANDON_MESSAGE_ROUTE')
    expect(onlyCallArguments(source, 'handleAbandonMessage')).toMatch(/isUp:\s*isPersonaUp/)
    expect(mod.ABANDON_MESSAGE_ROUTE).toBe('/abandon-message')
  })
})

type DialAnswer = { status: number; body: string }
type CliOptions = { pid?: string | null; port?: string | null; running?: boolean; unreadablePort?: boolean; dial?: (port: number, persona: string, ts: string) => Promise<DialAnswer> }
async function command(args: readonly string[], options: CliOptions = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'abandon-cli-')); dirs.push(dir)
  const clock = createFakeClock(), start = clock.now()
  const files = new Map<string, string>()
  if (options.pid !== null) files.set(join(dir, 'server.pid'), options.pid ?? '1234')
  if (options.port !== null) files.set(join(dir, 'server.port'), options.port ?? JSON.stringify({ pid: 1234, port: 41234 }))
  const lines: string[] = [], stdout: string[] = [], reads: string[] = [], misused: string[] = [], calls: Array<[number, string, string]> = []
  const unused = (name: string) => (): never => { misused.push(name); throw new Error(`unexpected CLI dependency: ${name}`) }
  class Exit extends Error { constructor(readonly code: number) { super('test exit') } }
  const deps: CliDeps = {
    spawnSync: unused('spawnSync'), spawnDaemon: unused('spawnDaemon'), openLogAppend: unused('openLogAppend'), closeFd: unused('closeFd'), initLogging: unused('initLogging'),
    existsSync: path => { reads.push(path); return files.has(path) },
    readFileSync: path => { reads.push(path); if (options.unreadablePort && path.endsWith('server.port')) throw new Error(sentinelInMessage('read')); return files.get(path)! },
    fileSize: unused('fileSize'), readFileFrom: unused('readFileFrom'), now: clock.now,
    sleep: async ms => { await clock.advance(Math.min(ms, 7000)) },
    unlinkSync: unused('unlinkSync'), isProcessRunning: pid => options.running !== false && pid === 1234,
    kill: unused('kill'), resolveStateDir: () => dir, resolveConfigPath: unused('resolveConfigPath'), startServer: unused('startServer'), exit: code => { throw new Exit(code) },
    loadConfig: unused('loadConfig'), loadConfigFile: unused('loadConfigFile'), runCredentialsScript: unused('runCredentialsScript'), initClient: unused('initClient'),
    directorGet: unused('directorGet'), directorReadPane: unused('directorReadPane'), directorStatus: unused('directorStatus'), directorPause: unused('directorPause'), directorKill: unused('directorKill'), directorList: unused('directorList'),
    appendServerLogLine: unused('appendServerLogLine'), recordStartupErrorEntry: unused('recordStartupErrorEntry'), dialClearLatch: unused('dialClearLatch'),
    dialAbandonMessage: async (port: number, persona: string, ts: string) => {
      calls.push([port, persona, ts])
      return options.dial ? options.dial(port, persona, ts) : { status: 200, body: JSON.stringify({ ok: true, persona: 'alpha', seq: 1 }) }
    },
  }
  const err = spyOn(console, 'error').mockImplementation((...args) => { lines.push(args.map(String).join(' ')) })
  const out = spyOn(console, 'log').mockImplementation((...args) => { stdout.push(args.map(String).join(' ')) })
  try {
    const cli = createCli(deps)
    expect(typeof cli.abandonMessage).toBe('function')
    const ended = await cli.abandonMessage(args).then(() => undefined, (err: unknown) => err)
    expect(ended).toBeInstanceOf(Exit)
    expect(misused).toEqual([]); expect(stdout).toEqual([])
    expect(lines).toHaveLength(1); expect(clock.pending()).toEqual([])
    assertNoLeak({ lines, stdout })
    return { code: (ended as Exit).code, lines, calls, reads, elapsed: clock.now() - start }
  } finally { err.mockRestore(); out.mockRestore(); captured.push(lines, stdout) }
}

describe('b.6cg abandon-message CLI', () => {
  test('the abandon confirmation bound is 30 seconds', async () => {
    expect((await subject()).ABANDON_MESSAGE_WAIT_MS).toBe(30_000)
  })
  test.each([[], ['alpha'], ['alpha', ts, 'extra'], ['', ts], ['alpha', ''], ['alpha', '1.2'], ['alpha', '1.123456\n']].map(args => ({ args })))('usage %j is exit 2 before any state read', async ({ args }) => {
    const r = await command(args)
    expect(r.code).toBe(2)
    expect(r.lines).toEqual(['Usage: claude-slack-channel-bots abandon-message <persona name or key> <ts>'])
    expect(r.reads).toEqual([]); expect(r.calls).toEqual([])
  })
  test.each([{ pid: null }, { pid: 'not-a-pid' }, { running: false }])('no running server %j is exit 1', async options => {
    const r = await command([typo(), ts], options)
    expect(r.code).toBe(1); expect(r.lines).toEqual(['abandon-message: no server is running']); expect(r.calls).toEqual([])
  })
  test.each([
    [{ port: null }, SERVER_PORT_CAUSE_ABSENT], [{ unreadablePort: true }, SERVER_PORT_CAUSE_UNREADABLE],
    [{ port: '{' }, SERVER_PORT_CAUSE_MALFORMED], [{ port: '{"pid":1234,"port":0}' }, SERVER_PORT_CAUSE_OUT_OF_RANGE],
    [{ port: '{"pid":99,"port":41234}' }, SERVER_PORT_CAUSE_OTHER_PID],
  ] as const)('server.port %j yields its fixed cause, no request or argument echo', async (options, cause) => {
    const r = await command([typo(), ts], options)
    expect(r.code).toBe(1); expect(r.lines).toEqual([`abandon-message: the server did not answer: ${cause}`]); expect(r.calls).toEqual([])
  })
  test.each([400, 403, 405, 500, 503, 200])('unexpected or malformed HTTP %i is exit 1 and never prints the body', async status => {
    const r = await command([typo(), ts], { dial: async () => ({ status, body: typo() }) })
    expect(r.code).toBe(1); expect(r.lines).toEqual([`abandon-message: the server did not answer: HTTP ${status}`]); expect(r.calls).toHaveLength(1)
  })
  test.each([
    { ok: false, persona: 'alpha', seq: 1 }, { ok: true, persona: '', seq: 1 }, { ok: true, persona: 'alpha' },
    ...[0, -1, 1.5, '1'].map(seq => ({ ok: true, persona: 'alpha', seq })),
  ])('malformed success %j grants no confirmation', async body => {
    const r = await command([typo(), ts], { dial: async () => ({ status: 200, body: JSON.stringify(body) }) })
    expect(r.code).toBe(1); expect(r.lines).toEqual(['abandon-message: the server did not answer: HTTP 200'])
  })
  test('an unrecognized refusal or unsafe head ts is reported by HTTP status without echoing it', async () => {
    for (const body of [{ reason: typo() }, { reason: 'not-head', head_ts: typo() }]) {
      const r = await command([typo(), ts], { dial: async () => ({ status: 409, body: JSON.stringify(body) }) })
      expect(r.code).toBe(1); expect(r.lines).toEqual(['abandon-message: the server did not answer: HTTP 409'])
    }
  })
  test('ECONNREFUSED prints its redacted cause and exits 1', async () => {
    const error = Object.assign(new Error(sentinelInMessage('connection refused')), { code: 'ECONNREFUSED', privateDetail: LEAK_SENTINEL })
    const r = await command([typo(), ts], { dial: async () => { throw error } })
    expect(r.code).toBe(1); expect(r.lines).toEqual([`abandon-message: the server did not answer: ${describeThrownValue(error)}`])
  })
  test('no confirmation in 30 seconds of injected time exits 1 without retrying', async () => {
    const r = await command([typo(), ts], { dial: () => new Promise(() => {}) })
    expect(r.code).toBe(1); expect(r.elapsed).toBe((await subject()).ABANDON_MESSAGE_WAIT_MS); expect(r.calls).toHaveLength(1)
    expect(r.lines).toEqual(['abandon-message: the server did not confirm within 30 s; the request may still run. Check the server log before trying again.'])
  })
  test.each([
    [404, {}, 'no persona in the running configuration has that name or key'],
    [409, { reason: 'persona-down' }, 'the persona is not up; nothing abandoned'],
    [409, { reason: 'unknown-item' }, 'no queued message has that ts'],
    [409, { reason: 'delivered' }, 'the message was already delivered; nothing abandoned'],
    [409, { reason: 'not-head', head_ts: ts }, `the message is not the head; the head has ts ${ts}`],
    [409, { reason: 'already-abandoned' }, 'the message was already abandoned; nothing changed'],
    [409, { reason: 'busy' }, 'a key operation is in flight; retry after it finishes'],
  ] as const)('HTTP %i %j produces the exact refusal line and exit 1', async (status, body, line) => {
    const r = await command([typo(), nextTs], { dial: async () => ({ status, body: JSON.stringify(body) }) })
    expect(r.code).toBe(1); expect(r.lines).toEqual([`abandon-message: ${line}`]); expect(r.calls).toHaveLength(1)
  })
  test('durable success exits 0 using the confirmed answer without echoing the persona argument', async () => {
    const r = await command([typo(), ts])
    expect(r.code).toBe(0)
    expect(r.lines).toEqual(['abandon-message: abandoned message 1 for persona "alpha" (key=alpha); its text is kept'])
    expect(r.calls).toEqual([[41234, typo(), ts]])
  })
  test('production dial is node:http loopback POST with agent:false and only persona/ts in its body', async () => {
    const mod = await subject()
    const request = new EventEmitter() as ClientRequest, response = new EventEmitter() as IncomingMessage
    const calls: RequestOptions[] = [], bodies: string[] = []
    request.end = ((body: Buffer) => { bodies.push(body.toString('utf8')); return request }) as ClientRequest['end']
    const pending = mod.dialAbandonMessage(41234, 'alpha', ts, (options: RequestOptions, receive: (response: IncomingMessage) => void) => {
      calls.push(options); receive(response); return request
    })
    response.statusCode = 200
    response.emit('data', JSON.stringify({ ok: true, persona: 'alpha', seq: 1 })); response.emit('end')
    expect(await pending).toEqual({ status: 200, body: JSON.stringify({ ok: true, persona: 'alpha', seq: 1 }) })
    expect(calls).toEqual([{ host: '127.0.0.1', port: 41234, path: '/abandon-message', method: 'POST', agent: false,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(bodies[0]!) } }])
    expect(bodies.map(b => JSON.parse(b))).toEqual([{ persona: 'alpha', ts }])
    assertNoLeak({ calls, bodies })
  })
  test('the CLI entry point wires its production dial and passes only the command arguments', async () => {
    const mod = await subject()
    expect(mod.ABANDON_MESSAGE_COMMAND).toBe('abandon-message')
    const code = stripComments(readFileSync(join(import.meta.dir, '../src/cli.ts'), 'utf8'))
    expect(code).toMatch(/dialAbandonMessage:\s*\(\s*(\w+)\s*,\s*(\w+)\s*,\s*(\w+)\s*\)\s*=>\s*dialAbandonMessage\(\s*\1\s*,\s*\2\s*,\s*\3\s*\)/)
    expect(code).toMatch(/cli\.abandonMessage\(process\.argv\.slice\(3\)\)/)
  })
})
