#!/usr/bin/env bun
/**
 * Private Docker inspection boundary for local harnesses and diagnostics.
 * CLI: bun scripts/safe-docker-inspect.ts docker container inspect NAME
 * Only complete, sanitized JSON (or the fixed Id projection) can leave here.
 * Failure returns empty text plus private sanitized diagnostics; the CLI emits no child errors.
 * This scopes inspection callers; it cannot intercept unrelated shell tools.
 */
import { basename } from 'node:path'

export interface SafeDockerInspectOptions {
  cwd?: string
  env?: NodeJS.ProcessEnv
  /** Hard upper bound 30 seconds, including pipe drainage. */
  timeoutMs?: number
  /** Combined stdout/stderr budget; hard upper bound 16 MiB. */
  maxOutputBytes?: number
  signal?: AbortSignal
}
export interface SafeDockerInspectResult {
  code: number
  text: string
  /** Docker's actual exit, independently of wrapper refusal/timeout codes. */
  actualExitCode: number | null
  /** Sanitized separately from inspection JSON; never contains Config.Env. */
  stderr: string
  timedOut: boolean
  outputTruncated: boolean
}

const ID = /^(?:sha256:)?[0-9a-f]{64}$/
const ANTHROPIC_NAME = /^(?:CI_)?ANTHROPIC_/i
const CREDENTIAL_NAME = /(?:^|_)(?:KEY|TOKEN|SECRET|PASSWORD)$/i
const REF = /^[A-Za-z0-9][A-Za-z0-9_.:/@-]{0,511}$/
const DEFAULT_OUTPUT_BYTES = 4 * 1024 * 1024
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024
const TIMEOUT_MS = 30_000

class InspectionFailure extends Error {
  constructor(readonly code: number) { super() }
}

/** Conservative dispatch: unrecognized inspect spellings must not fall into a streaming runner. */
export function isDockerInspectCommand(argv: readonly string[]): boolean {
  return typeof argv[0] === 'string' && basename(argv[0]) === 'docker' && argv.slice(1).includes('inspect')
}

interface Request { argv: string[]; idOnly: boolean; quotedId: boolean }
function request(argv: readonly string[]): Request | null {
  if (!isDockerInspectCommand(argv)) return null
  let offset: number
  if (argv[1] === 'inspect') offset = 2
  else if ((argv[1] === 'container' || argv[1] === 'image') && argv[2] === 'inspect') offset = 3
  else return null // Global options, other object kinds and arbitrary commands are refused.
  const command = argv.slice(0, offset), refs: string[] = []
  let idOnly = false, quotedId = false, formatted = false, sized = false, typed = false
  for (let i = offset; i < argv.length; i++) {
    const arg = argv[i]!
    if (arg === '--format' || arg === '-f' || arg.startsWith('--format=') || arg.startsWith('-f=')) {
      if (formatted) return null
      const format = arg.includes('=') ? arg.slice(arg.indexOf('=') + 1) : argv[++i]
      // Evaluate this projection ourselves, after redaction. Never pass Go templates to Docker.
      if (format !== '{{.Id}}' && format !== '{{json .Id}}') return null
      idOnly = true; quotedId = format === '{{json .Id}}'; formatted = true
    } else if (arg === '--size' || arg === '-s') {
      if (sized || argv[1] === 'image') return null
      sized = true; command.push('--size')
    } else if (arg === '--type' || arg.startsWith('--type=')) {
      if (typed || offset !== 2) return null
      const type = arg.includes('=') ? arg.slice(arg.indexOf('=') + 1) : argv[++i]
      if (type !== 'container' && type !== 'image') return null
      typed = true; command.push('--type', type)
    } else {
      if (!REF.test(arg)) return null
      refs.push(arg)
    }
  }
  if (refs.length === 0 || refs.length > 64) return null
  return { argv: [...command, ...refs], idOnly, quotedId }
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** All passes stay private. A malformed document never produces a partial result. */
function sanitizedText(raw: string, projection: Pick<Request, 'idOnly' | 'quotedId'>, env: NodeJS.ProcessEnv,
  maxOutputBytes: number, check: () => void): string {
  check()
  const objects: unknown = JSON.parse(raw)
  check()
  if (!Array.isArray(objects) || objects.length === 0 || objects.length > 64
    || objects.some(item => !record(item) || typeof item.Id !== 'string' || !ID.test(item.Id)
      || !record(item.Config) || !Object.hasOwn(item.Config, 'Env'))) throw new Error()
  const values = new Set<string>()
  const add = (value: string) => {
    check()
    if (value !== '') values.add(value)
    if (values.size > 256) throw new Error()
  }
  for (const [name, value] of Object.entries(env)) if ((ANTHROPIC_NAME.test(name) || CREDENTIAL_NAME.test(name)) && value) add(value)
  let nodes = 0
  const visit = (value: unknown, depth: number): void => {
    check()
    if (++nodes > 100_000 || depth > 64) throw new Error()
    if (Array.isArray(value)) { for (const item of value) visit(item, depth + 1); return }
    if (!record(value)) return
    for (const [key, item] of Object.entries(value)) {
      check()
      if (key.toLowerCase() === 'env') {
        if (item === null) continue
        if (!Array.isArray(item)) throw new Error()
        for (const entry of item) {
          check()
          if (++nodes > 100_000) throw new Error()
          if (typeof entry !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*=/.test(entry)) throw new Error()
          const split = entry.indexOf('=')
          const name = entry.slice(0, split)
          // All Env entries are removed. Only secrets/routing values are masked
          // elsewhere: ordinary flag values such as "1" also occur in IDs.
          if (ANTHROPIC_NAME.test(name) || CREDENTIAL_NAME.test(name)) add(entry.slice(split + 1))
        }
      } else if (ANTHROPIC_NAME.test(key)) {
        if (typeof item !== 'string' && item !== null) throw new Error()
        if (typeof item === 'string') add(item)
      } else visit(item, depth + 1)
    }
  }
  visit(objects, 0)
  // JSON text copied into a label/error field can contain escaped values too.
  const masks = new Set<string>()
  const maskStarts = new Map<string, string[]>()
  let patternUnits = 0, work = 0
  const checkpoint = () => { if ((++work & 255) === 0) check() }
  for (const value of values) {
    check()
    // A value larger than the entire permitted result cannot occur in it.
    if (Buffer.byteLength(value) > maxOutputBytes) continue
    for (const secret of [value, JSON.stringify(value).slice(1, -1)]) {
      if (masks.has(secret) || Buffer.byteLength(secret) > maxOutputBytes) continue
      masks.add(secret)
      patternUnits += secret.length
      if (patternUnits > maxOutputBytes) throw new InspectionFailure(75)
      const first = secret[0]!
      const candidates = maskStarts.get(first) ?? []
      candidates.push(secret)
      maskStarts.set(first, candidates)
    }
  }
  for (const candidates of maskStarts.values()) candidates.sort((a, b) => b.length - a.length)
  const matchEnd = (value: string, start: number): number => {
    for (const secret of maskStarts.get(value[start]!) ?? []) {
      checkpoint()
      if (start + secret.length > value.length) continue
      let offset = 1
      // Compare bounded pieces: a long common prefix must not hide the deadline.
      while (offset < secret.length) {
        checkpoint()
        const end = Math.min(offset + 256, secret.length)
        if (!value.startsWith(secret.slice(offset, end), start + offset)) break
        offset = end
      }
      if (offset === secret.length) return start + secret.length
    }
    return start
  }
  let cleanedBytes = 0
  const mask = (value: string) => {
    check()
    const pieces: string[] = []
    const append = (piece: string) => {
      checkpoint()
      cleanedBytes += Buffer.byteLength(piece)
      if (cleanedBytes > maxOutputBytes) throw new InspectionFailure(75)
      pieces.push(piece)
    }
    let plainStart = 0
    // Read only original characters. Replacement markers are never remasked.
    for (let start = 0; start < value.length;) {
      checkpoint()
      const end = matchEnd(value, start)
      if (end !== start) {
        append(value.slice(plainStart, start)); append('[REDACTED]')
        start = end; plainStart = start
      } else start++
    }
    append(value.slice(plainStart))
    check()
    return pieces.join('')
  }
  const clean = (value: unknown): unknown => {
    check()
    if (typeof value === 'string') return mask(value)
    if (Array.isArray(value)) return value.map(clean)
    if (!record(value)) return value
    const result: Record<string, unknown> = Object.create(null)
    for (const [key, item] of Object.entries(value)) {
      check()
      if (key.toLowerCase() === 'env' || ANTHROPIC_NAME.test(key)) continue
      const safeKey = mask(key)
      if (Object.hasOwn(result, safeKey)) throw new Error()
      result[safeKey] = clean(item)
    }
    return result
  }
  const safe = clean(objects) as Record<string, unknown>[]
  const output: string[] = []
  let outputBytes = 0
  const append = (piece: string) => {
    check()
    outputBytes += Buffer.byteLength(piece)
    if (outputBytes > maxOutputBytes) throw new InspectionFailure(75)
    output.push(piece)
  }
  const quoted = (value: string) => {
    append('"')
    // Escape small pieces so even a control-character string cannot allocate
    // an oversized serialization before the byte bound is checked.
    for (let start = 0; start < value.length;) {
      let end = Math.min(start + 1024, value.length)
      const last = value.charCodeAt(end - 1)
      if (end < value.length && last >= 0xd800 && last <= 0xdbff) end++
      append(JSON.stringify(value.slice(start, end)).slice(1, -1))
      start = end
    }
    append('"')
  }
  const render = (value: unknown, depth: number): void => {
    check()
    if (typeof value === 'string') { quoted(value); return }
    if (value === null || typeof value !== 'object') { append(JSON.stringify(value)); return }
    const array = Array.isArray(value)
    const entries = Object.entries(value)
    append(array ? '[' : '{')
    for (let i = 0; i < entries.length; i++) {
      const [key, item] = entries[i]!
      append((i === 0 ? '\n' : ',\n') + '  '.repeat(depth + 1))
      if (!array) { quoted(key); append(': ') }
      render(item, depth + 1)
    }
    if (entries.length) append('\n' + '  '.repeat(depth))
    append(array ? ']' : '}')
  }
  if (projection.idOnly) {
    for (const item of safe) {
      check()
      if (typeof item.Id !== 'string' || !ID.test(item.Id)) throw new Error()
      if (projection.quotedId) quoted(item.Id)
      else append(item.Id)
      append('\n')
    }
  } else { render(safe, 0); append('\n') }
  const text = output.join('')
  // Short/overlapping secrets can also occur in a marker or fixed JSON syntax.
  // Refuse that complete result instead of exposing a value or remasking output.
  for (let start = 0; start < text.length; start++) {
    checkpoint()
    if (matchEnd(text, start) !== start) throw new Error()
  }
  check()
  return text
}

/** Sanitize diagnostics through the same private Env/credential boundary. */
function sanitizedDiagnostic(stderr: string, stdout: Buffer[], env: NodeJS.ProcessEnv, maxOutputBytes: number, complete: boolean): string {
  // Matching complete secret values cannot certify a prefix cut off by a
  // collection limit or cancellation, even when inspection stdout parsed.
  if (!complete) return 'Docker stderr withheld: incomplete inspection cannot certify credential redaction'
  if (!stderr) return ''
  try {
    // stdout may contain additional credential Env entries unavailable to the
    // caller. Keep it private, but visit those entries before masking stderr.
    let inspected: unknown = null
    const raw = Buffer.concat(stdout).toString('utf8')
    if (raw) { try { inspected = JSON.parse(raw) } catch { return 'Docker stderr withheld: incomplete inspection cannot certify credential redaction' } }
    const deadline = performance.now() + 50
    const check = () => { if (performance.now() >= deadline) throw new Error() }
    const rawDiagnostic = JSON.stringify([{ Id: '0'.repeat(64), Config: { Env: [] }, diagnostic: stderr, inspected }])
    const safe = sanitizedText(rawDiagnostic, { idOnly: false, quotedId: false }, env,
      Math.max(maxOutputBytes, Buffer.byteLength(rawDiagnostic) * 2), check)
    return JSON.parse(safe)[0].diagnostic
  } catch { return 'Docker stderr withheld: credential redaction could not be certified' }
}

/**
 * Captures both pipes without a raw sink. Wrapper codes remain compatible:
 * success 0; child failure 1; refused 64; invalid schema 65; output limit 75;
 * timeout 124; aborted 130. Underlying exit and sanitized stderr stay separate.
 * Every failure has empty inspection text; the CLI remains silent on failure.
 */
export async function safeDockerInspect(argv: readonly string[], options: SafeDockerInspectOptions = {}): Promise<SafeDockerInspectResult> {
  const empty = (code: number, stderr = ''): SafeDockerInspectResult => ({ code, text: '', actualExitCode: null, stderr, timedOut: code === 124, outputTruncated: code === 75 })
  try {
    const parsed = request(argv)
    const timeoutMs = options.timeoutMs ?? TIMEOUT_MS
    const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_OUTPUT_BYTES
    if (!parsed || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > TIMEOUT_MS
      || !Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < 1 || maxOutputBytes > MAX_OUTPUT_BYTES) return empty(64, 'Docker inspection request refused')
    if (options.signal?.aborted) return empty(130, 'Docker inspection aborted before launch')
    const deadline = performance.now() + timeoutMs
    const check = () => {
      if (options.signal?.aborted) throw new InspectionFailure(130)
      if (performance.now() >= deadline) throw new InspectionFailure(124)
    }
    const env = { ...(options.env ?? process.env) }
    return await new Promise(resolve => {
      const child = Bun.spawn(parsed.argv, {
        cwd: options.cwd, env, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', detached: true,
      })
      let settled = false, bytes = 0, actualExitCode: number | null = null
      let chunks: Buffer[] = [], errors: Buffer[] = []
      const drained = [false, false]
      let exitTimer: ReturnType<typeof setTimeout> | undefined
      const readers = [child.stdout.getReader(), child.stderr.getReader()]
      const finish = (code: number, text = '') => {
        if (settled) return
        settled = true
        clearTimeout(timer); clearTimeout(exitTimer)
        options.signal?.removeEventListener('abort', abort)
        if (code !== 0) {
          if (child.pid) { try { process.kill(-child.pid, 'SIGKILL') } catch {} }
          try { child.kill('SIGKILL') } catch {}
          // No awaited cancellation: escaped descendants can retain pipes.
          for (const reader of readers) void reader.cancel().catch(() => {})
          child.unref?.()
        }
        const complete = drained.every(Boolean) && code !== 75 && code !== 124 && code !== 130
        const diagnostic = sanitizedDiagnostic(Buffer.concat(errors).toString('utf8'), chunks, env, maxOutputBytes, complete)
        chunks = []; errors = []
        resolve({ code, text, actualExitCode, stderr: diagnostic || (code ? 'Docker inspection failed without stderr; wrapper code ' + code : ''), timedOut: code === 124, outputTruncated: code === 75 })
      }
      const abort = () => finish(130)
      const timer = setTimeout(() => finish(124), timeoutMs)
      options.signal?.addEventListener('abort', abort, { once: true })
      const consume = async (reader: ReadableStreamDefaultReader<Uint8Array>, stdout: boolean) => {
        try {
          while (!settled) {
            const { done, value } = await reader.read()
            if (settled) break
            if (done) { drained[stdout ? 0 : 1] = true; break }
            const available = maxOutputBytes - bytes
            ;(stdout ? chunks : errors).push(Buffer.from(value.subarray(0, Math.max(0, available))))
            bytes += value.byteLength
            if (bytes > maxOutputBytes) { finish(75); return }
          }
        } catch { finish(1) }
        finally { try { reader.releaseLock() } catch {} }
      }
      void child.exited.then(code => {
        actualExitCode = code
        // Let already buffered stderr drain first, but never await inherited
        // pipes indefinitely after a failed Docker process has exited.
        if (code !== 0 && !settled) exitTimer = setTimeout(() => finish(1), 25)
      }, () => finish(1))
      const streams = Promise.all(readers.map((reader, index) => consume(reader, index === 0)))
      void Promise.all([child.exited, streams]).then(([code]) => {
        if (settled) return
        if (code !== 0) { finish(1); return }
        try {
          const raw = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))
          const text = sanitizedText(raw, parsed, env, maxOutputBytes, check)
          if (Buffer.byteLength(text) > maxOutputBytes) finish(75)
          else finish(0, text)
        }
        catch (error) { finish(error instanceof InspectionFailure ? error.code : 65) }
      }, () => finish(1))
      if (options.signal?.aborted) abort()
    })
  } catch { return empty(1, 'Docker inspection could not be launched or collected') }
}

if (import.meta.main) {
  const aborted = new AbortController()
  const interrupt = () => aborted.abort()
  process.on('SIGINT', interrupt); process.on('SIGTERM', interrupt)
  try {
    const result = await safeDockerInspect(process.argv.slice(2), { signal: aborted.signal })
    // No help/error text repeats arguments, environment values, or child output.
    if (result.code === 0 && !aborted.signal.aborted) process.stdout.write(result.text)
    process.exitCode = aborted.signal.aborted ? 130 : result.code
  } finally {
    process.off('SIGINT', interrupt); process.off('SIGTERM', interrupt)
  }
}
