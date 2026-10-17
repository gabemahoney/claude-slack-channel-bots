/** Decision21(c) observation controls. No model, native binary or integration driver runs here. */
import { describe, expect, test } from 'bun:test'
import { readFileSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { createServer, request, type Server } from 'node:http'
import { spawnSync } from 'node:child_process'
import { AC20_COMPLETION_MS, AC20_DIAGNOSTIC_CEILING_MS, AC20_AFTER_RETRY_MS, AC20_NATIVE_SHA256, observeAC20Completion, nativeDebugProjection, gatewayCorrelations, linkedRetryForStalledRequest, startDiagnosticGateway } from './real-agent/ac20-diagnostics.ts'
import { assertNoLeak, fakeToken, BOT_TOKEN_PREFIX } from './test-helpers/credentials.ts'
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

describe('AC20 original completion deadline and diagnostic-only observation', () => {
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
  test('diagnostic scope precedes intake; only AC20 explicit gate changes its wait', () => {
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

// Run the exact private native function against in-memory child/pipe seams.
// No native executable, subprocess or host configuration is involved.
function nativeSeam(reader: { read(): Promise<{ done: boolean; value?: Uint8Array }>; cancel(): Promise<void> }, code = 17) {
  const begin = source.indexOf('async function native('), end = source.indexOf('\nif (import.meta.main)', begin)
  const rows: Row[] = [], listeners = new Set<string>(), calls: unknown[] = []
  const fakeProcess = { pid: 99, env: { ANTHROPIC_BASE_URL: 'https://example.invalid/base?keep=1' }, exitCode: undefined as number | undefined,
    on: (name: string) => { listeners.add(name) }, off: (name: string) => { listeners.delete(name) } }
  const factory = new Function('readFileSync', 'join', 'integer', 'process', 'Bun', 'sink', 'nativeDebugProjection', 'scope', new Bun.Transpiler({ loader: 'ts' }).transformSync(source.slice(begin, end) + '\nreturn native'))
  const native = factory(() => '{"port":12345}', join, (value: number, max: number) => Number.isSafeInteger(value) && value >= 0 && value <= max, fakeProcess,
    { spawn: (argv: string[], options: unknown) => { calls.push({ argv, options }); return { exited: Promise.resolve(code), stderr: { getReader: () => reader }, kill: () => {} } } },
    () => (row: Row) => rows.push(row), nativeDebugProjection, () => 2)
  return { run: () => native('/owned', '/fake/native', ['--exact-original-arg']), rows, listeners, calls, fakeProcess }
}
describe('native child status and safe failure evidence', () => {
  test('fully captured exit17 retains projected stderr and original native arguments/stdio', async () => {
    let count = 0
    const seam = nativeSeam({ read: async () => count++ === 0 ? { done: false, value: Buffer.from(`[API:timing] first byte after 17ms\nError ${secret}\n`) } : { done: true }, cancel: async () => {} })
    await seam.run(); safe(seam.rows); expect(seam.fakeProcess.exitCode).toBe(17); expect(seam.listeners.size).toBe(0)
    expect(seam.rows.some(row => row.event === 'first_byte' && row.elapsedMs === 17)).toBe(true)
    expect(seam.rows.some(row => row.event === 'unrecognized_withheld')).toBe(true)
    expect(seam.rows.find(row => row.event === 'process_exit')).toMatchObject({ exitCode: 17, case: 2 })
    expect(seam.calls).toEqual([{ argv: ['/fake/native', '--debug-to-stderr', '--exact-original-arg'], options: { stdin: 'inherit', stdout: 'inherit', stderr: 'pipe', env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:12345/base?keep=1' } } }])
  })
  test('unterminated secret stderr is never promoted to a complete diagnostic on exit', async () => {
    let count = 0; const seam = nativeSeam({ read: async () => count++ === 0 ? { done: false, value: Buffer.from(secret.slice(0, 12)) } : { done: true }, cancel: async () => {} })
    await seam.run(); safe(seam.rows); expect(seam.fakeProcess.exitCode).toBe(17)
    expect(seam.rows.find(row => row.reason === 'unterminated_line')).toBeDefined()
  })
})

test('native stderr read failure preserves child exit and a fixed nonempty collection diagnostic', async () => {
  const seam = nativeSeam({ read: async () => { throw new Error(secret) }, cancel: async () => {} })
  let rejected = false
  try { await seam.run() } catch { rejected = true }
  safe(seam.rows)
  expect(rejected).toBe(false)
  expect(seam.fakeProcess.exitCode).toBe(17)
  expect(seam.rows.some(row => row.event === 'capture_withheld' && typeof row.reason === 'string' && row.reason.length > 0)).toBe(true)
  expect(seam.listeners.size).toBe(0)
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
test('retained descendant stderr pipe is bounded and preserves underlying exit with fixed withheld reason', async () => {
  let finish!: (value: { done: boolean }) => void, cancelled = false
  const seam = nativeSeam({ read: () => new Promise(resolve => { finish = resolve }), cancel: async () => { cancelled = true; finish({ done: true }) } })
  await seam.run(); safe(seam.rows); expect(cancelled).toBe(true); expect(seam.fakeProcess.exitCode).toBe(17)
  expect(seam.rows.some(row => row.event === 'capture_withheld' && row.reason === 'stream_collection_incomplete')).toBe(true)
}, 3000)
test('removing the two gated additions restores the exact previously captured scenario bytes', () => {
  expect(scenario.split(caseGate)).toHaveLength(2); expect(scenario.split(waitGate)).toHaveLength(2)
  expect(createHash('sha256').update(scenario.replace(caseGate, '').replace(waitGate, '')).digest('hex')).toBe('4a96b137596887ccbc4705365ad9ac625002aa513015142a1c6bcca91106bef7')
})
