/** Decision21(c) observation controls. No model, native binary or integration driver runs here. */
import { describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, request, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AC20_AFTER_RETRY_MS, AC20_COMPLETION_MS, AC20_DIAGNOSTIC_CEILING_MS, AC20_NATIVE_SHA256, gatewayCorrelations, linkedRetryForStalledRequest, nativeDebugProjection, observeAC20Completion, parseNativeProcessStat, startDiagnosticGateway } from './real-agent/ac20-diagnostics.ts'
import { assertNoLeak, BOT_TOKEN_PREFIX, fakeToken } from './test-helpers/credentials.ts'
import { hostSafeChildEnv } from './test-helpers/host-safe-env.ts'

type Row = Parameters<Parameters<typeof nativeDebugProjection>[0]>[0]
const source = readFileSync(join(import.meta.dir, 'real-agent/ac20-diagnostics.ts'), 'utf8')
const shell = readFileSync(join(import.meta.dir, 'real-agent/ac20-diagnostics.sh'), 'utf8')
const scenario = readFileSync(join(import.meta.dir, 'real-agent/ai-scenario.sh'), 'utf8')
const secret = fakeToken(BOT_TOKEN_PREFIX, 'ac20')
function safe(value: unknown) {
  // Boolean assertions cannot print any full or partial injected credential.
  expect(JSON.stringify(value).includes(secret.slice(0, 12))).toBe(false)
  expect(JSON.stringify(value).includes(JSON.stringify(secret).slice(1, 13))).toBe(false)
  assertNoLeak(value)
}
async function observe(options: { initial?: number; start?: number; completion?: number; retry?: number; crossing?: number } = {}) {
  let now = options.initial ?? 0, checks = 0
  const rows: Row[] = []
  const result = await observeAC20Completion({ startMs: options.start ?? 0, now: () => now, sleep: async ms => { now += ms },
    completed: async () => { checks++; if (options.crossing) now += options.crossing; return options.completion !== undefined && now >= options.completion },
    retryObserved: () => options.retry !== undefined && now >= options.retry ? options.retry : undefined, emit: row => rows.push(row), caseNumber: 1 })
  safe(rows); return { result, now, rows, checks }
}

describe('original completion deadline and diagnostic-only observation', () => {
  test.each([0, 179000, 180000])('completion at %i stays within the original assertion', async completion => {
    const result = await observe({ completion }); expect(result.result).toBe(true); expect(result.now).toBe(completion)
    expect(result.rows.at(-1)?.event).toBe('completed_within_180s'); expect(result.rows.some(row => row.event === 'failed_180s')).toBe(false)
  })
  test.each([180001, 181000, 600000])('completion at %i can never repair failure', async completion => {
    const result = await observe({ completion }); expect(result.result).toBe(false)
    const late = result.rows.find(row => row.event === 'late_completion_diagnostic_only')!
    expect(result.now).toBe(Number(late.atMs) + 60000)
    expect(result.rows.filter(row => row.event === 'failed_180s')).toHaveLength(1)
    expect(result.rows.some(row => row.event === 'completed_within_180s')).toBe(false)
  })
  test('no linked retry or completion reaches the 35-minute hard ceiling', async () => {
    const result = await observe(); expect(result.result).toBe(false); expect(result.now).toBe(2100000)
    expect(result.rows.at(-1)).toMatchObject({ event: 'diagnostic_ceiling_reached', reason: 'no_certified_earlier_stop' })
    expect([AC20_COMPLETION_MS, AC20_DIAGNOSTIC_CEILING_MS, AC20_AFTER_RETRY_MS]).toEqual([180000, 2100000, 60000])
  })
  test.each([181000, 600000, 2099000])('linked retry %i stops only at grace or hard ceiling', async retry => {
    const result = await observe({ retry }); expect(result.result).toBe(false); expect(result.now).toBe(Math.min(retry + 60000, 2100000))
  })
  test('helper startup does not restart a wait whose assertion already expired', async () => {
    const result = await observe({ initial: 200000, completion: 200000 }); expect(result.result).toBe(false)
    expect(result.rows[0]).toMatchObject({ startMs: 0, deadlineMs: 180000, ceilingMs: 2100000 })
    expect(result.rows.at(-1)?.event).toBe('grace_complete_after_late_completion'); expect(result.now).toBe(260000)
  })
  test('completion oracle crossing the deadline cannot return success', async () => {
    const result = await observe({ initial: 179999, crossing: 2, completion: 180000 })
    expect(result.result).toBe(false); expect(result.rows.some(row => row.event === 'completed_within_180s')).toBe(false)
  })
  test.each([-1, NaN, Infinity, 0.5, 1])('invalid or future start %s rejects', async startMs => {
    await expect(observeAC20Completion({ startMs, now: () => 0, sleep: async () => {}, completed: async () => false, retryObserved: () => undefined, emit: () => {}, caseNumber: 1 })).rejects.toThrow('wait start unavailable')
  })
})

describe('strict native stderr projection', () => {
  const project = (chunks: Uint8Array[]) => {
    const rows: Row[] = []; const projection = nativeDebugProjection(row => rows.push(row), () => ({ atMs: 42, case: 1, process: 7 }))
    for (const chunk of chunks) projection.push(chunk)
    projection.end(); safe(rows); return rows
  }
  test('only audited event names and numeric error/timing fields survive', () => {
    const lines = ['2026-10-17T12:00:00.000Z [DEBUG] [API:timing] dispatching to azure model=private-model', 'Stream started - received first chunk', '[API:timing] first byte after 123ms', 'Slow first byte: no stream chunk 180.5s after request sent (attempt 2)', `[Anthropic SDK INFO] [${secret}] connection timed out (retrying, 2 attempts remaining)`, `[Anthropic SDK INFO] [${secret}] connection timed out - error; no more retries left`]
    const rows = project([Buffer.from(lines.join('\n') + '\n')])
    expect(rows.map(row => row.event)).toEqual(['dispatch', 'first_chunk', 'first_byte', 'slow_first_byte', 'retry_scheduled', 'request_timeout'])
    expect(rows[2]).toEqual({ source: 'native', atMs: 42, case: 1, process: 7, event: 'first_byte', elapsedMs: 123 })
    expect(rows[3]).toMatchObject({ elapsedMs: 180500, attempt: 2 })
    expect(JSON.stringify(rows).includes('private-model')).toBe(false)
  })
  test.each(['raw', 'escaped', 'unicode'])('every split of %s unsafe input is withheld before output', kind => {
    const text = kind === 'raw' ? secret : kind === 'escaped' ? JSON.stringify(secret + '\n"\\').slice(1, -1) : [...secret].map(c => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0')).join('')
    const input = Buffer.from('Error: ' + text + '\n[API:timing] first byte after 9ms\n' + text)
    for (let split = 0; split <= input.length; split++) {
      const rows = project([input.subarray(0, split), input.subarray(split)])
      expect(rows.map(row => row.event)).toEqual(['first_byte', 'capture_withheld', 'unrecognized_withheld'])
      expect(rows[1]?.reason).toBe('unterminated_line')
    }
  })
  test.each([16385, 65536, 300000])('line overflow %i bytes cannot leak a prefix or contaminate next line', length => {
    const rows = project([Buffer.from(secret + 'z'.repeat(length) + '\nStream started - received first chunk\n')])
    expect(rows.some(row => row.reason === 'line_limit')).toBe(true); expect(rows.at(-1)?.event).toBe('first_chunk')
  })
  test('invalid encoding and unterminated known messages remain withheld', () => {
    expect(project([Buffer.from([0xff, 10]), Buffer.from('Stream started - received first chunk')]).map(row => row.reason)).toEqual(['invalid_encoding', 'unterminated_line'])
  })
  test.each(['[API:timing] first byte after -1ms', '[API:timing] first byte after 999999999ms', 'Slow first byte: no stream chunk 1s after request sent (attempt 0)', '[Anthropic SDK ERROR] unsafe', '[API:timing] first byte after 1ms extra'])('unknown diagnostic form %s is never a safe error field', line => {
    expect(project([Buffer.from(line + ' ' + secret + '\n')])).toEqual([{ source: 'native', atMs: 42, case: 1, process: 7, event: 'unrecognized_withheld', lines: 1 }])
  })
})

describe('positive retry linkage only', () => {
  test('only same ID and case with an increasing explicit counter shares a logical request', () => {
    const correlate = gatewayCorrelations(); const first = correlate(secret, '0', 1), linked = correlate(secret, '1', 1)
    safe([first, linked]); expect(linked).toEqual({ logicalRequest: first.logicalRequest, retryCount: 1, linkedRetry: true })
    expect(correlate('new-id', '2', 1).linkedRetry).toBe(false); expect(correlate(secret, '2', 2).linkedRetry).toBe(false)
  })
  test.each([undefined, '', '-1', '1.5', ' 1', '1000', secret])('missing/malformed retry count never proves linkage', count => {
    const correlate = gatewayCorrelations(); correlate('id', '0', 1); const result = correlate('id', count, 1); safe(result); expect(result.linkedRetry).toBe(false); expect(result.retryCount).toBeUndefined()
  })
  test.each(['0', '1'])('equal or decreasing counter %s is a new unknown request', count => {
    const correlate = gatewayCorrelations(); correlate('id', '1', 1); expect(correlate('id', count, 1).linkedRetry).toBe(false)
  })
  test('absent, oversized and evicted IDs cannot certify a retry', () => {
    for (const id of [undefined, 'a'.repeat(257)]) { const c = gatewayCorrelations(); c(id, '0', 1); expect(c(id, '1', 1).linkedRetry).toBe(false) }
    const c = gatewayCorrelations(); c('old', '0', 1); for (let i = 0; i < 4096; i++) c(String(i), '0', 1)
    expect(c('old', '1', 1).linkedRetry).toBe(false)
  })
  const row = (event: string, atMs: number, logicalRequest = 1, caseNumber = 1): Row => ({ source: 'gateway', event, atMs, case: caseNumber, logicalRequest })
  test('retry must follow deadline and belong to the still-open request for this case', () => {
    const base = [row('request_start', 1), row('request_start', 2, 2), row('stream_end', 3, 2)]
    expect(linkedRetryForStalledRequest([...base, row('client_retry', 181000)], 1, 180000)).toBe(181000)
    for (const candidate of [row('client_retry', 180000), row('client_retry', 181000, 2), row('client_retry', 181000, 1, 2), row('request_start', 181000, 3)])
      expect(linkedRetryForStalledRequest([...base, candidate], 1, 180000)).toBeUndefined()
  })
  test.each(['stream_end', 'upstream_aborted', 'upstream_stream_error', 'upstream_request_error', 'client_aborted', 'client_cancelled'])('closed %s request cannot be a stalled target', event => {
    expect(linkedRetryForStalledRequest([row('request_start', 1), row(event, 2), row('client_retry', 181000)], 1, 180000)).toBeUndefined()
  })
})

const listen = (server: Server) => new Promise<number>(resolve => server.listen(0, '127.0.0.1', () => resolve((server.address() as { port: number }).port)))
const close = async (server: Server) => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) }
const exchange = (port: number, path: string, body: Buffer, headers: Record<string, string> = {}) => new Promise<{ status: number; headers: string[]; body: Buffer }>((resolve, reject) => {
  const req = request({ hostname: '127.0.0.1', port, path, method: 'POST', headers: { ...headers, 'Content-Length': String(body.length) }, agent: false }, res => {
    const chunks: Buffer[] = []; res.on('data', chunk => chunks.push(chunk)); res.on('end', () => resolve({ status: res.statusCode!, headers: res.rawHeaders, body: Buffer.concat(chunks) })); res.on('error', reject)
  }); req.on('error', reject); req.end(body)
})
describe('passive local diagnostic gateway', () => {
  test('preserves request bytes/path/query/headers and response status/headers/stream without extra attempts', async () => {
    const rows: Row[] = []; let calls = 0, captured: { method?: string; path?: string; headers: string[]; body: Buffer } | undefined
    const body = Buffer.from(JSON.stringify({ text: secret, value: '\u0000\n' })), response = Buffer.from(secret + '\nstream\u0000tail')
    const upstream = createServer((req, res) => { calls++; const chunks: Buffer[] = []; req.on('data', chunk => chunks.push(chunk)); req.on('end', () => {
      captured = { method: req.method, path: req.url, headers: req.rawHeaders, body: Buffer.concat(chunks) }
      res.writeHead(429, 'Quota Limited', ['Content-Type', 'application/octet-stream', 'X-Duplicate', 'one', 'X-Duplicate', 'two', 'Retry-After', '10'])
      res.write(response.subarray(0, 8)); setTimeout(() => res.end(response.subarray(8)), 5)
    }) })
    const upstreamPort = await listen(upstream), proxy = startDiagnosticGateway(new URL(`http://127.0.0.1:${upstreamPort}/ignored-base`), row => rows.push(row), () => 2)
    try {
      const result = await exchange(await listen(proxy), '/v1/messages?raw=%2F%26&second=1', body, { Authorization: secret, 'X-Client-Request-Id': secret, 'X-Stainless-Retry-Count': '0', 'X-Custom': 'unchanged' })
      safe(rows); expect(calls).toBe(1); expect(captured?.method).toBe('POST'); expect(captured?.path).toBe('/v1/messages?raw=%2F%26&second=1')
      expect(captured?.body.equals(body)).toBe(true); expect(captured?.headers.includes(secret)).toBe(true); expect(captured?.headers.includes(`127.0.0.1:${upstreamPort}`)).toBe(true)
      expect(result.status).toBe(429); expect(result.body.equals(response)).toBe(true); expect(result.headers.filter(value => value === 'X-Duplicate')).toHaveLength(2)
      expect(rows.filter(row => row.event === 'request_start')).toHaveLength(1); expect(rows.some(row => row.event === 'client_retry')).toBe(false)
      expect(rows.find(row => row.event === 'response_status')?.status).toBe(429); expect(rows.at(-1)?.event).toBe('stream_end')
      expect(proxy.requestTimeout).toBe(0); expect(proxy.timeout).toBe(0)
    } finally { await close(proxy); await close(upstream) }
  })
  test('redirect response is returned without following or retrying it', async () => {
    let calls = 0; const rows: Row[] = []; const upstream = createServer((req, res) => { calls++; req.resume(); res.writeHead(307, { Location: '/other' }); res.end('redirect') })
    const proxy = startDiagnosticGateway(new URL(`http://127.0.0.1:${await listen(upstream)}`), row => rows.push(row), () => 1)
    try { const result = await exchange(await listen(proxy), '/original', Buffer.alloc(0)); safe(rows); expect(result.status).toBe(307); expect(calls).toBe(1) }
    finally { await close(proxy); await close(upstream) }
  })
  test('upstream failure exposes only fixed error metadata and triggers no retry', async () => {
    let calls = 0; const rows: Row[] = []; const upstream = createServer((req) => { calls++; req.socket.destroy(new Error(secret)) })
    const proxy = startDiagnosticGateway(new URL(`http://127.0.0.1:${await listen(upstream)}`), row => rows.push(row), () => 1)
    try { let failed = false; try { await exchange(await listen(proxy), '/', Buffer.alloc(0)) } catch { failed = true }; safe(rows); expect(failed).toBe(true); expect(calls).toBe(1); expect(rows.some(row => row.event === 'upstream_request_error')).toBe(true) }
    finally { await close(proxy); await close(upstream) }
  })
  test('client cancellation reaches upstream without consuming or retrying the rest of a stream', async () => {
    const rows: Row[] = []; let calls = 0, upstreamClosed!: () => void; const stopped = new Promise<void>(resolve => { upstreamClosed = resolve })
    const upstream = createServer((req, res) => { calls++; req.resume(); res.write('first'); res.on('close', upstreamClosed) })
    const proxy = startDiagnosticGateway(new URL(`http://127.0.0.1:${await listen(upstream)}`), row => rows.push(row), () => 1)
    try {
      const port = await listen(proxy)
      await new Promise<void>((resolve, reject) => { const req = request({ hostname: '127.0.0.1', port, agent: false }, res => { res.once('data', () => { res.destroy(); resolve() }); res.on('error', () => {}) }); req.on('error', reject); req.end() })
      await stopped; safe(rows); expect(calls).toBe(1); expect(rows.some(row => row.event === 'client_cancelled')).toBe(true)
    } finally { await close(proxy); await close(upstream) }
  })
  test('slow consumer receives a large stream byte-for-byte through pipe backpressure', async () => {
    const payload = Buffer.alloc(4 * 1024 * 1024, 97), rows: Row[] = []; let calls = 0, blocked = 0
    const upstream = createServer((req, res) => { calls++; req.resume(); let offset = 0; const pump = () => { while (offset < payload.length) { const next = Math.min(offset + 32768, payload.length), chunk = payload.subarray(offset, next); offset = next; if (!res.write(chunk)) { blocked++; res.once('drain', pump); return } }; res.end() }; pump() })
    const proxy = startDiagnosticGateway(new URL(`http://127.0.0.1:${await listen(upstream)}`), row => rows.push(row), () => 1)
    try {
      const port = await listen(proxy); const received = await new Promise<Buffer>((resolve, reject) => { const req = request({ hostname: '127.0.0.1', port, agent: false }, res => { const chunks: Buffer[] = []; res.pause(); setTimeout(() => res.resume(), 15); res.on('data', chunk => chunks.push(chunk)); res.on('end', () => resolve(Buffer.concat(chunks))); res.on('error', reject) }); req.on('error', reject); req.end() })
      safe(rows); expect(received.equals(payload)).toBe(true); expect(blocked).toBeGreaterThan(0); expect(calls).toBe(1)
    } finally { await close(proxy); await close(upstream) }
  })
  test.each(['ftp://example.invalid', 'http://name:password@example.invalid'])('unsafe upstream configuration rejects before listening', url => {
    expect(() => startDiagnosticGateway(new URL(url), () => {}, () => 1)).toThrow('configuration unavailable')
  })
})

describe('scenario and original oracle wiring', () => {
  test('diagnostic scope precedes intake; only explicit gate changes its wait', () => {
    const scope = scenario.indexOf('real_ac20_diagnostic_case "${n}"'), push = scenario.indexOf('slack_stub_push "${REAL_LABEL}" "${EVENT}"'), delivery = scenario.indexOf('real_wait_delivery "${REAL_KEY}" "${n}"'), wait = scenario.indexOf('real_ac20_diagnostic_readback "${EXPECTED}/${n}.json" "${n}"')
    expect(scope).toBeGreaterThan(0); expect(scope).toBeLessThan(push); expect(push).toBeLessThan(delivery); expect(delivery).toBeLessThan(wait)
    expect(scenario.match(/\[\[ "\$\{AI_CRITERION\}" == 20 && "\$\{REAL_AGENT_AC20_DIAGNOSTICS:-\}" == decision21c \]\]/g)).toHaveLength(2)
    expect(scenario).toContain('wait_until 180 "AC${AI_CRITERION} field read-back ${n} (${CASE_DIAGNOSTIC}) missing/wrong" ai_readback "${EXPECTED}/${n}.json" "${n}"')
  })
  test.each([0, 17])('isolated shell readback captures wait start before Bun and preserves oracle only on exit %i success', exit => {
    const home = mkdtempSync(join(tmpdir(), 'ac20-shell-'))
    try {
      const functionText = shell.slice(shell.indexOf('real_ac20_diagnostic_readback()'), shell.indexOf('real_ac20_diagnostics_report()'))
      const script = `set -eu\nREAL_AGENT_AC20_DIAGNOSTICS=decision21c\nAC20_DIAGNOSTIC_HELPER=helper\nAC20_DIAGNOSTIC_DIR=owned\nSLACK_STATE_DIR=state\nREAL_KEY=persona\nSCENARIO_AD_SHIM_LOG=shim\n_scenario_now_ms() { printf 'clock\\n' >&2; printf '123456'; }\nbun() { printf 'bun:%s:%s:%s\\n' "$2" "$4" "$AI_CRITERION"; return ${exit}; }\nfail() { printf 'fixed-failure\\n'; exit 1; }\nai_readback() { printf 'original-oracle:%s:%s\\n' "$1" "$2"; }\n${functionText}\nreal_ac20_diagnostic_readback expected.json 2\n`
      const result = spawnSync('bash', ['-c', script], { env: hostSafeChildEnv(home, { tools: ['bash'] }), encoding: 'utf8', timeout: 5000 })
      safe([result.stdout, result.stderr]); expect(result.status).toBe(exit === 0 ? 0 : 1); expect(result.stderr).toBe('clock\n')
      expect(result.stdout).toBe(`bun:wait:123456:20\n${exit === 0 ? 'original-oracle:expected.json:2' : 'fixed-failure'}\n`)
    } finally { rmSync(home, { recursive: true, force: true }) }
  })
  test('observer invokes the exact ordinary completedAIReadback after receipt ownership audit', () => {
    const closure = source.slice(source.indexOf('const completed = async'), source.indexOf('const retryObserved ='))
    const invoke = new Function('transcriptFiles', 'readTranscripts', 'receiptJournal', 'auditReceipts', 'personaTranscripts', 'readFileSync', 'join', 'completedAIReadback', 'root', 'adapters', 'state', 'key', 'shim', 'caseNumber', 'expected', 'process', new Bun.Transpiler({ loader: 'ts' }).transformSync(closure + '\nreturn completed'))
    const calls: string[] = [], paths = ['owned'], all = {}, journal = {}, own = {}, adapters = {}, expected = {}; let reject = false
    const completed = invoke((value: unknown) => { expect(value).toBe('root'); return paths }, (p: unknown, a: unknown) => { expect(p).toBe(paths); expect(a).toBe(adapters); return all }, () => journal,
      (args: unknown, entries: unknown, a: unknown) => { calls.push('audit'); expect(args).toEqual({ stateDir: 'state', key: 'key', shimLog: 'shim', transcripts: paths }); expect(entries).toBe(all); expect(a).toBe(adapters) },
      () => own, () => 'line\n', join, (args: unknown) => { calls.push('oracle'); expect(args).toEqual({ seq: 2, expected, journal, own, adapters, model: 'azure/openai/gpt-6-astra' }); if (reject) throw new Error('ordinary oracle rejects') }, 'root', adapters, 'state', 'key', 'shim', 2, expected, { env: { REAL_AGENT_MODEL_PIN: 'azure/openai/gpt-6-astra' } })
    return (async () => { expect(await completed()).toBe(true); expect(calls).toEqual(['audit', 'oracle']); reject = true; expect(await completed()).toBe(false) })()
  })
})

describe('audited native296 request policy fixture', () => {
  const directory = join(import.meta.dir, 'fixtures/ac20-diagnostics')
  const provenanceBytes = readFileSync(join(directory, 'native296-provenance.json'))
  const provenance = JSON.parse(provenanceBytes.toString())
  test('exact captured provenance binds all twelve native fragments to the audited binary', () => {
    expect(createHash('sha256').update(provenanceBytes).digest('hex')).toBe('c1a2a8de6422ecebd61952a09281ae43dd3f976c6d5a728fd615137aaae02370')
    expect(provenance.binarySha256).toBe(AC20_NATIVE_SHA256); expect(provenance.binaryBytes).toBe(257068216)
    expect(provenance.hostBinaryExecuted).toBe(false); expect(provenance.fragments).toHaveLength(12)
    for (const fragment of provenance.fragments) {
      const bytes = readFileSync(join(directory, fragment.file))
      expect(bytes.length).toBe(fragment.bytes); expect(createHash('sha256').update(bytes).digest('hex')).toBe(fragment.sha256)
      expect(Number.isSafeInteger(fragment.binaryOffset) && fragment.binaryOffset >= 0 && fragment.binaryOffset + bytes.length <= provenance.binaryBytes).toBe(true)
    }
  })
  test('captured main calls disable SDK retries and use outer retries; request ordinal alone proves nothing', () => {
    const sdk = readFileSync(join(directory, 'native296-main-sdk-retries-disabled.txt'), 'utf8')
    const outer = readFileSync(join(directory, 'native296-main-outer-retry-loop.txt'), 'utf8')
    expect(sdk).toContain('maxRetries:0'); expect(outer).toContain('ybe(')
    expect(provenance).toMatchObject({ defaultApiTimeoutMs: 600000, byteIdleClampMaximumMs: 1800000, mainModelSdkRetries: 0, nativeOuterRetryLoop: true })
  })
})

const nativeFunction = source.slice(source.indexOf('async function native('), source.indexOf('\n/** /proc', source.indexOf('async function native(')))
const identityFunctions = source.slice(source.indexOf('export function parseNativeProcessStat'), source.indexOf('\n/** The shell starts'))
const collectorFunction = source.slice(source.indexOf('async function collectNative('), source.indexOf('\nif (import.meta.main)'))
const integer = (value: unknown, max = Number.MAX_SAFE_INTEGER) => Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= max
function launchSeam(options: { ready?: unknown; appearsAt?: number; alive?: boolean; returns?: boolean; port?: unknown } = {}) {
  let now = 0, execs = 0; const killed: number[] = [], replaced = {}
  const environment = { ANTHROPIC_BASE_URL: 'https://example.invalid/base?keep=1', AC20_TEST_SECRET: secret, KEEP: 'same' }
  let arguments_: unknown, forwarded: Record<string, string> | undefined
  const native = new Function('readFileSync', 'join', 'integer', 'process', 'Bun', 'existsSync', 'Date', 'nativeProcessIdentity', new Bun.Transpiler({ loader: 'ts' }).transformSync(nativeFunction + '\nreturn native'))(
    (path: string) => path.endsWith('gateway-ready.json') ? JSON.stringify({ port: options.port ?? 12345 }) : now < (options.appearsAt ?? 0) ? (() => { throw new Error('collector not ready') })() : JSON.stringify(options.ready ?? { pid: 100, nativePid: 99, started: '111' }),
    join, integer, { pid: 99, env: environment, kill: (pid: number) => { killed.push(pid); if (options.alive === false) throw new Error('collector not live') }, execve: (binary: string, args: string[], env: Record<string, string>) => { execs++; arguments_ = { binary, args }; forwarded = env; if (!options.returns) throw replaced } },
    { sleep: async (ms: number) => { now += ms } }, () => now >= (options.appearsAt ?? 0), { now: () => now }, () => ({ state: 'S', started: '111' }))
  return { run: async () => { let execReplaced = false, failed = false; try { await native('/owned', '/owned/stand-in', ['--original', 'space arg']) } catch (error) { execReplaced = error === replaced; failed = !execReplaced }; return { execReplaced, failed } },
    state: () => ({ now, execs, killed, arguments_, environmentPreserved: forwarded !== undefined && Object.keys(environment).every(key => key === 'ANTHROPIC_BASE_URL' || forwarded![key] === environment[key as keyof typeof environment]), gatewayChangedOnly: forwarded?.ANTHROPIC_BASE_URL === 'http://127.0.0.1:12345/base?keep=1' }) }
}
function collectorSeam(options: { chunks?: Buffer[]; readFailure?: boolean; pending?: boolean; nativePid?: number; vanish?: boolean; state?: string; implementation?: string; releaseAfter?: number; initialState?: string } = {}) {
  let now = 0, cancelled = 0, index = 0, pendingResolve: ((value: { done: boolean }) => void) | undefined
  const renames: Array<[string, string]> = []; let identityReads = 0
  const rows: Row[] = [], writes: Array<{ path: string; value: unknown; options: unknown }> = []
  const reader = { read: async () => { if (options.readFailure) throw new Error(secret); if (index < (options.chunks?.length ?? 0)) return { done: false, value: options.chunks![index++] }; if (options.pending) return new Promise<{ done: boolean }>(resolve => { pendingResolve = resolve }); return { done: true } }, cancel: async () => { cancelled++; pendingResolve?.({ done: true }) } }
  const collect = new Function('integer', 'process', 'sink', 'nativeDebugProjection', 'scope', 'Bun', 'writeFileSync', 'join', 'Date', 'renameSync', 'nativeProcessIdentity', new Bun.Transpiler({ loader: 'ts' }).transformSync((options.implementation ? options.implementation.slice(options.implementation.indexOf('async function collectNative('), options.implementation.indexOf('\nif (import.meta.main)')) : collectorFunction) + '\nreturn collectNative'))(
    integer, { pid: 100, kill: () => { if (options.vanish) throw new Error('gone') } }, () => (row: Row) => rows.push(row), nativeDebugProjection, () => 2,
    { stdin: { stream: () => ({ getReader: () => reader }) }, sleep: async (ms: number) => { now += ms; if (options.releaseAfter !== undefined && now >= options.releaseAfter) pendingResolve?.({ done: true }) } }, (path: string, data: string, settings: unknown) => writes.push({ path, value: JSON.parse(data), options: settings }), join, { now: () => now }, (from: string, to: string) => renames.push([from, to]), () => { identityReads++; if (identityReads === 1 && options.initialState) { if (options.initialState === 'missing') return undefined; if (options.initialState === 'EACCES') throw new Error(secret); return { state: options.initialState, started: '111' } }; if (identityReads > 1) { if (options.vanish || options.state === 'gone') return undefined; if (options.state === 'EACCES') { if (identityReads > 2) throw new Error(secret); return { state: 'S', started: '111' } }; if (options.state) return { state: options.state === 'reused' ? 'S' : options.state, started: options.state === 'reused' ? '222' : '111' } }; return { state: 'S', started: '111' } })
  return { run: () => collect('/owned', options.nativePid ?? 99), rows, writes, renames, state: () => ({ now, cancelled }) }
}
describe('PID-preserving native launcher and strict collector handshake', () => {
  test('execs only after readiness, preserving argv and environment without projecting credentials', async () => {
    const seam = launchSeam({ appearsAt: 200 }); expect(await seam.run()).toEqual({ execReplaced: true, failed: false })
    const state = seam.state(); safe(state); expect(state).toMatchObject({ now: 200, execs: 1, killed: [100], environmentPreserved: true, gatewayChangedOnly: true, arguments_: { binary: '/owned/stand-in', args: ['/owned/stand-in', '--debug-to-stderr', '--original', 'space arg'] } })
  })
  test.each([{ pid: 0, nativePid: 99 }, { pid: -1, nativePid: 99 }, { pid: 1.5, nativePid: 99 }, { pid: '100', nativePid: 99 }, { pid: 100, nativePid: 98 }, {}])('invalid collector readiness %j cannot launch native', async ready => {
    const seam = launchSeam({ ready }); expect(await seam.run()).toEqual({ execReplaced: false, failed: true }); expect(seam.state().execs).toBe(0)
  })
  test('missing readiness has a five-second bound and never execs', async () => {
    const seam = launchSeam({ appearsAt: 6000 }); expect((await seam.run()).failed).toBe(true); expect(seam.state()).toMatchObject({ now: 5000, execs: 0 })
  })
  test('a dead collector or an execve return fails closed', async () => {
    const dead = launchSeam({ alive: false }); expect((await dead.run()).failed).toBe(true); expect(dead.state().execs).toBe(0)
    const returned = launchSeam({ returns: true }); expect((await returned.run()).failed).toBe(true); expect(returned.state().execs).toBe(1)
  })
  test.each([0, -1, 100, 0.5, NaN])('collector refuses impossible/self PID %s before readiness', async nativePid => {
    const seam = collectorSeam({ nativePid }); await expect(seam.run()).rejects.toThrow('native identity unavailable'); expect(seam.writes).toEqual([]); expect(seam.rows).toEqual([])
  })
  test('collector announces readiness only with an opened pipe and reports exit as unknown', async () => {
    const seam = collectorSeam({ chunks: [Buffer.from(`[API:timing] first byte after 17ms\nError ${secret}\n`)] }); await seam.run(); safe([seam.rows, seam.writes])
    expect(seam.writes).toEqual([{ path: '/owned/native-99.ready-100.next', value: { pid: 100, nativePid: 99, started: '111' }, options: { mode: 0o600, flag: 'wx' } }]); expect(seam.renames).toEqual([['/owned/native-99.ready-100.next', '/owned/native-99.ready']])
    expect(seam.rows[0]).toMatchObject({ event: 'process_exit_unknown', reason: 'exec_identity_preserved', process: 99 })
    expect(seam.rows.some(row => row.event === 'first_byte' && row.elapsedMs === 17)).toBe(true)
    expect(seam.rows.some(row => row.event === 'process_exit' || 'exitCode' in row)).toBe(false)
    expect(seam.rows.some(row => row.event === 'unrecognized_withheld')).toBe(true); expect(seam.state().cancelled).toBe(1)
  })
  test('collector read failure retains a fixed diagnostic, never its raw error or invented native status', async () => {
    const seam = collectorSeam({ readFailure: true }); await seam.run(); safe(seam.rows)
    expect(seam.rows.some(row => row.event === 'capture_withheld' && row.reason === 'stream_collection_incomplete')).toBe(true)
    expect(seam.rows.some(row => 'exitCode' in row)).toBe(false); expect(seam.state().cancelled).toBe(1)
  })
  test('a vanished pane cannot leave a descendant pipe open beyond the one-second drain bound', async () => {
    const seam = collectorSeam({ chunks: [Buffer.from(secret.slice(0, 12))], pending: true, vanish: true }); await seam.run(); safe(seam.rows)
    expect(seam.state().now).toBeGreaterThanOrEqual(1000); expect(seam.state().now).toBeLessThanOrEqual(1200); expect(seam.state().cancelled).toBe(1)
    expect(seam.rows.some(row => row.reason === 'stream_collection_incomplete')).toBe(true); expect(seam.rows.some(row => row.reason === 'unterminated_line')).toBe(true)
  })
})

async function processIdentityProbe(mode: 'exec' | 'spawn') {
  const home = mkdtempSync(join(tmpdir(), 'ac20-identity-'))
  try {
    const fixture = join(import.meta.dir, 'fixtures/ac20-diagnostics'), old = readFileSync(join(fixture, 'spawn-launcher.before.ts.txt'), 'utf8')
    const privateSource = mode === 'exec' ? nativeFunction + '\n' + identityFunctions + '\n' + collectorFunction : old
    const projection = source.slice(source.indexOf('export function nativeDebugProjection'), source.indexOf('/** Only an explicit SDK')).replace('export function', 'function')
    const scopeAndSink = source.slice(source.indexOf('function scope('), source.indexOf('/** Bounded complete-line'))
    const helper = join(home, 'helper.ts'), standIn = join(home, 'stand-in'), wrapper = join(home, 'wrapper.sh')
    const digest = createHash('sha256').update(secret).digest('hex')
    writeFileSync(standIn, `#!${process.execPath}\nimport {createHash} from 'node:crypto';import{fstatSync}from'node:fs';console.log(JSON.stringify({nativePid:process.pid,parentPid:process.ppid,args:process.argv.slice(2),credentialUnchanged:createHash('sha256').update(process.env.AC20_TEST_SECRET??'').digest('hex')===${JSON.stringify(digest)},gatewayCorrect:process.env.ANTHROPIC_BASE_URL==='http://127.0.0.1:12345/base?keep=1',stderrPipe:fstatSync(2).isFIFO()}));process.stderr.write('[API:timing] first byte after 17ms\\nError '+process.env.AC20_TEST_SECRET+'\\n'+process.env.AC20_TEST_SECRET?.slice(0,12));process.exit(17)\n`, { mode: 0o700 })
    writeFileSync(helper, `import {readFileSync,appendFileSync,writeFileSync,existsSync,renameSync} from 'node:fs';import{join}from'node:path';const integer=${integer.toString()};\n${scopeAndSink}\n${projection}\n${privateSource}\nconst [command,directory,...args]=process.argv.slice(2);if(command==='collect')await collectNative(directory!,Number(args[0]));else await native(directory!,process.env.OWNED_STAND_IN!,args.slice(1));\n`)
    writeFileSync(join(home, 'gateway-ready.json'), '{"port":12345}'); writeFileSync(join(home, 'scope.json'), '{"case":1}')
    const actualWrapper = shell.slice(shell.indexOf('#!/usr/bin/env bash\n'), shell.indexOf('\nWRAPPER'))
    const command = mode === 'exec' ? actualWrapper.slice(actualWrapper.indexOf('\n') + 1) : 'exec bun "$AC20_DIAGNOSTIC_HELPER" native "$AC20_DIAGNOSTIC_DIR" /opt/claude-code/2.1.296/claude "$@"'
    writeFileSync(wrapper, `printf '{"panePid":%s}\\n' "$$"\n${command}\n`)
    const child = spawnSync('bash', [wrapper, '--original', 'space arg'], { env: hostSafeChildEnv(home, { tools: ['bash', 'bun'], extras: { AC20_DIAGNOSTIC_HELPER: helper, AC20_DIAGNOSTIC_DIR: home, OWNED_STAND_IN: standIn, ANTHROPIC_BASE_URL: 'https://example.invalid/base?keep=1', AC20_TEST_SECRET: secret } }), encoding: 'utf8', timeout: 7000 })
    safe([child.stdout, child.stderr]); expect(child.error).toBeUndefined(); expect(child.status).toBe(17); expect(child.stderr).toBe('')
    const [pane, native] = child.stdout.trim().split('\n').map(line => JSON.parse(line))
    const log = join(home, `native-${pane.panePid}.jsonl`)
    for (let i = 0; i < 100; i++) { if (existsSync(log) && readFileSync(log, 'utf8').includes('unterminated_line')) break; await Bun.sleep(10) }
    const rows = readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line)); safe(rows)
    return { pane, native, rows }
  } finally { rmSync(home, { recursive: true, force: true }) }
}
test('actual execve and anonymous collector pipe preserve pane PID, native argv, credentials and safe evidence', async () => {
  const result = await processIdentityProbe('exec'); expect(result.native.nativePid).toBe(result.pane.panePid)
  expect(result.native).toMatchObject({ args: ['--debug-to-stderr', '--original', 'space arg'], credentialUnchanged: true, gatewayCorrect: true, stderrPipe: true })
  expect(result.rows.some(row => row.event === 'process_exit_unknown')).toBe(true); expect(result.rows.some(row => 'exitCode' in row)).toBe(false)
  expect(result.rows.some(row => row.event === 'first_byte')).toBe(true); expect(result.rows.some(row => row.reason === 'unterminated_line')).toBe(true)
})
test('captured pre-repair Bun.spawn leaves native below pane PID and fails the AD identity association', async () => {
  const result = await processIdentityProbe('spawn'); expect(result.native.nativePid === result.pane.panePid).toBe(false); expect(result.native.parentPid).toBe(result.pane.panePid)
  const directory = join(import.meta.dir, 'fixtures/ac20-diagnostics'), metadata = JSON.parse(readFileSync(join(directory, 'launcher-provenance.json'), 'utf8'))
  expect(createHash('sha256').update(readFileSync(join(directory, 'spawn-launcher.before.ts.txt'))).digest('hex')).toBe(metadata.capturedFunctionSHA256)
})

const caseGate = '        if [[ "${AI_CRITERION}" == 20 && "${REAL_AGENT_AC20_DIAGNOSTICS:-}" == decision21c ]]; then\n            real_ac20_diagnostic_case "${n}"\n        fi\n'
const waitGate = '        elif [[ "${AI_CRITERION}" == 20 && "${REAL_AGENT_AC20_DIAGNOSTICS:-}" == decision21c ]]; then\n            real_ac20_diagnostic_readback "${EXPECTED}/${n}.json" "${n}"\n'
test.each([[20, 'decision21c', 1], [20, '', 1], [20, 'other', 2], [12, 'decision21c', 1], [11, 'decision21c', 3]])('extracted intake/wait branch executes AC%i gate=%s case=%i only as authorized', (criterion, gate, seq) => {
  const home = mkdtempSync(join(tmpdir(), 'ac20-branch-'))
  try {
    const begin = scenario.indexOf(caseGate), end = scenario.indexOf('        real_wait_idle "${REAL_KEY}"', begin), branch = scenario.slice(begin, end)
    const script = `set -eu\nAI_CRITERION=${criterion}\nREAL_AGENT_AC20_DIAGNOSTICS=${gate}\nn=${seq}\nREAL_LABEL=label\nEVENT=event\nREAL_KEY=key\nEXPECTED=expected\nCASE_DIAGNOSTIC=case\nreal_ac20_diagnostic_case() { printf 'scope:%s\\n' "$1"; }\nslack_stub_push() { printf 'intake\\n'; }\nreal_wait_delivery() { printf 'delivery\\n'; }\nreal_ac20_diagnostic_readback() { printf 'diagnostic:%s:%s\\n' "$1" "$2"; }\nwait_until() { printf 'ordinary:%s:%s\\n' "$1" "$3"; }\n${branch}\n`
    const result = spawnSync('bash', ['-c', script], { env: hostSafeChildEnv(home, { tools: ['bash'] }), encoding: 'utf8', timeout: 5000 })
    safe([result.stdout, result.stderr]); expect(result.status).toBe(0); expect(result.stderr).toBe('')
    const enabled = criterion === 20 && gate === 'decision21c'
    expect(result.stdout).toBe(`${enabled ? `scope:${seq}\n` : ''}intake\ndelivery\n${enabled ? `diagnostic:expected/${seq}.json:${seq}` : `ordinary:180:${criterion === 11 && seq === 3 ? 'ai_spoof_readback' : 'ai_readback'}`}\n`)
  } finally { rmSync(home, { recursive: true, force: true }) }
})
test('removing diagnostic additions preserves the approved AD-state-only scenario bytes', () => {
  expect(scenario.split(caseGate)).toHaveLength(2); expect(scenario.split(waitGate)).toHaveLength(2)
  expect(createHash('sha256').update(scenario.replace(caseGate, '').replace(waitGate, '')).digest('hex')).toBe('e7db0b966873a660553d314ba53e0144d4f7d035b654d890caa1bdfa8516a273')
})

function procStat(pid: number, state = 'S', started = '111', comm = 'native ) spaced') {
  return `${pid} (${comm}) ${[state, ...Array(18).fill('0'), started, '0'].join(' ')}\n`
}
test.each(['R', 'S', 'Z', 'X', 'x'])('process stat parses state %s and exact start identity despite parentheses/whitespace comm', state => {
  expect(parseNativeProcessStat(procStat(99, state, '12345678901234567890'), 99)).toEqual({ state, started: '12345678901234567890' })
})
test.each(['', '99 missing parentheses', procStat(98), procStat(99, '?'), procStat(99, 'S', '-1'), '99 (name) S 0'])('malformed/mismatched proc stat %s is rejected without using cmdline or environment', text => {
  expect(() => parseNativeProcessStat(text, 99)).toThrow('process identity unavailable')
})
test.each(['gone', 'Z', 'X', 'x', 'reused', 'EACCES'])('held descendant pipe is withheld and bounded after native %s', async state => {
  const seam = collectorSeam({ state, chunks: [Buffer.from(secret.slice(0, 12))], pending: true }); await seam.run(); safe(seam.rows)
  expect(seam.state().now).toBeLessThanOrEqual(1200); expect(seam.state().cancelled).toBe(1)
  expect(seam.rows.some(row => row.reason === 'stream_collection_incomplete')).toBe(true)
  expect(seam.rows.some(row => row.reason === 'unterminated_line')).toBe(true)
})
test('stale readiness with a different native start identity cannot exec', async () => {
  const seam = launchSeam({ ready: { pid: 100, nativePid: 99, started: 'old' } }); expect((await seam.run()).failed).toBe(true); expect(seam.state().execs).toBe(0)
})
async function publishWhileLaunching(implementation: string) {
  const first = implementation.indexOf('async function native('), native = implementation.slice(first, implementation.indexOf('\n/**', first))
  const collector = implementation.slice(implementation.indexOf('async function collectNative('), implementation.indexOf('\nif (import.meta.main)'))
  const files = new Map<string, string>([['/owned/gateway-ready.json', '{"port":12345}']]); let launched: Promise<unknown> | undefined, replaced = false
  const replacement = {}, fields = ['readFileSync', 'writeFileSync', 'renameSync', 'existsSync', 'join', 'integer', 'process', 'Bun', 'Date', 'sink', 'nativeDebugProjection', 'scope', 'nativeProcessIdentity']
  const common: Record<string, unknown> = { readFileSync: (path: string) => { if (!files.has(path)) throw new Error('not yet published'); return files.get(path) }, existsSync: (path: string) => files.has(path), join, integer,
    Bun: { sleep: async () => {}, stdin: { stream: () => ({ getReader: () => ({ read: async () => ({ done: true }), cancel: async () => {} }) }) } }, Date: { now: () => 0 }, sink: () => () => {}, nativeDebugProjection, scope: () => 1, nativeProcessIdentity: () => ({ state: 'S', started: '111' }) }
  let launch!: () => Promise<unknown>
  common.writeFileSync = (path: string, data: string) => {
    // Model the observable empty/truncated interval of a direct open/write.
    files.set(path, ''); launched ??= launch(); files.set(path, data)
  }
  common.renameSync = (from: string, to: string) => { files.set(to, files.get(from)!); files.delete(from) }
  const build = (body: string, process_: unknown, name: string) => new Function(...fields, new Bun.Transpiler({ loader: 'ts' }).transformSync(body + `\nreturn ${name}`))(...fields.map(field => field === 'process' ? process_ : common[field]))
  const launcher = build(native, { pid: 99, env: { ANTHROPIC_BASE_URL: 'https://example.invalid' }, kill: () => {}, execve: () => { throw replacement } }, 'native')
  launch = async () => { try { await launcher('/owned', '/owned/stand-in', []) } catch (error) { replaced = error === replacement } }
  await build(collector, { pid: 100, kill: () => {} }, 'collectNative')('/owned', 99)
  await launched; return replaced
}
test('atomic readiness publication prevents the actual pre-repair empty-file launch race', async () => {
  const before = readFileSync(join(import.meta.dir, 'fixtures/ac20-diagnostics/exec-launcher.before-p2.ts.txt'), 'utf8')
  expect(await publishWhileLaunching(before)).toBe(false)
  expect(await publishWhileLaunching(source)).toBe(true)
})
test('retained native296 network-none proof binds actual accepted AD readiness without executing AD in units', () => {
  const directory = join(import.meta.dir, 'fixtures/ac20-diagnostics'), metadata = JSON.parse(readFileSync(join(directory, 'launcher-provenance.json'), 'utf8')), bytes = readFileSync(join(directory, 'native-ad-proof.json'))
  expect(createHash('sha256').update(bytes).digest('hex')).toBe(metadata.nativeADProofSHA256)
  const proof = JSON.parse(bytes.toString()); safe(proof)
  expect(proof).toMatchObject({ nativeVersion: '2.1.296', nativeSha256: AC20_NATIVE_SHA256, paneExecutable: '/opt/claude-code/2.1.296/claude', status: { state: 'waiting' }, network: 'none', ignoredHooks: 0, paneGrandparentHooks: 0, caseInputs: 0 })
  expect(proof.sessionStart).toHaveLength(1); expect(proof.sessionStart[0]).toMatchObject({ event_name: 'SessionStart', upsert_outcome: 'updated' })
})
test.each(['Z', 'reused'])('captured old collector mistakes %s PID for live; repaired collector drains within bound', async state => {
  const before = readFileSync(join(import.meta.dir, 'fixtures/ac20-diagnostics/exec-launcher.before-p2.ts.txt'), 'utf8')
  const metadata = JSON.parse(readFileSync(join(import.meta.dir, 'fixtures/ac20-diagnostics/launcher-provenance.json'), 'utf8'))
  expect(createHash('sha256').update(before).digest('hex')).toBe(metadata.beforeP2SourceSHA256)
  const old = collectorSeam({ implementation: before, state, pending: true, releaseAfter: 2000 }); await old.run(); safe(old.rows)
  expect(old.state().now).toBeGreaterThanOrEqual(2000); expect(old.rows.some(row => row.reason === 'stream_collection_incomplete')).toBe(false)
  const fixed = collectorSeam({ state, pending: true, releaseAfter: 2000 }); await fixed.run(); safe(fixed.rows)
  expect(fixed.state().now).toBeLessThanOrEqual(1200); expect(fixed.rows.some(row => row.reason === 'stream_collection_incomplete')).toBe(true)
})
test.each(['Z', 'X', 'x', 'missing', 'EACCES'])('collector cannot publish readiness for initial native %s identity', async initialState => {
  const seam = collectorSeam({ initialState }); let refused = false
  try { await seam.run() } catch { refused = true }
  safe([seam.rows, seam.writes]); expect(refused).toBe(true); expect(seam.writes).toEqual([]); expect(seam.rows).toEqual([])
})
test('native metadata storage reaches its byte cap once and cannot persist arbitrary debug bytes', () => {
  const lines: string[] = [], start = source.indexOf('function sink('), end = source.indexOf('/** Bounded complete-line')
  const make = new Function('appendFileSync', 'join', 'Date', new Bun.Transpiler({ loader: 'ts' }).transformSync(source.slice(start, end) + '\nreturn sink'))((directory: string, line: string) => lines.push(line), join, { now: () => 0 })
  const projection = nativeDebugProjection(make('/owned', 'metadata.jsonl'), () => ({ atMs: 0, case: 1, process: 99 }))
  projection.push(Buffer.from(('[API:timing] first byte after 1ms\n').repeat(10000) + secret + '\n')); projection.end(); safe(lines)
  expect(lines.reduce((count, line) => count + Buffer.byteLength(line), 0)).toBeLessThan(256 * 1024 + 256)
  expect(lines.map(line => JSON.parse(line)).filter(row => row.reason === 'metadata_limit')).toHaveLength(1)
})
test('retained offline zombie proof reports UNKNOWN and a bounded withheld collection, without claiming a native model result', () => {
  const directory = join(import.meta.dir, 'fixtures/ac20-diagnostics'), bytes = readFileSync(join(directory, 'zombie-held-pipe-proof.json')), metadata = JSON.parse(readFileSync(join(directory, 'launcher-provenance.json'), 'utf8'))
  expect(createHash('sha256').update(bytes).digest('hex')).toBe(metadata.zombieHeldPipeProofSHA256)
  const proof = JSON.parse(bytes.toString()); safe(proof)
  expect(proof).toMatchObject({ offline: true, network: 'none', targetWasSyntheticShellNotNativeModel: true, targetStateBeforeReap: 'Z', collectorExit: 0, nativeExitClaim: 'UNKNOWN', collectionIncompleteWithheld: true, stderrBytes: 0 })
  expect(proof.collectorElapsedMs).toBeLessThan(proof.descendantPipeHoldMs)
})
