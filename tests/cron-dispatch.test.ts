/**
 * cron-dispatch.test.ts — Unit tests for src/cron-dispatch.ts (Task 2 on b.he5).
 *
 * The dispatcher delivers one matched CronSchedule via a localhost HTTP POST to
 * the server's own /interject. Per the "Self-Contained Test Servers" pattern in
 * docs/testing-guide.md (and tests/interject.test.ts), we stand up a real
 * `Bun.serve({ port: 0 })` test server, hand its actual bound port to the
 * factory, and record every request (method, path, parsed body, and RAW body
 * text for byte-identity assertions) into a closure array reset each test.
 * Responses are scripted per-channel. Outcomes are read back by parsing the
 * REAL createCronLog temp file into its five space-delimited fields and
 * asserting on structured fields, never on free-text prose.
 *
 * No top-level mock.module (a pretest gate forbids it); no mocks at all. No
 * real sleeps. Never touches ~/.claude/channels/slack/ or any real channel ID.
 *
 * SPDX-License-Identifier: MIT
 */

import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

import { createCronLog } from '../src/cron-log.ts'
import type { CronSchedule } from '../src/crontable.ts'
import { createCronDispatcher } from '../src/cron-dispatch.ts'

// ---------------------------------------------------------------------------
// Test HTTP server — records every request, responds per-channel scriptable.
// ---------------------------------------------------------------------------

interface CapturedRequest {
  method: string
  path: string
  /** Parsed JSON body (best effort). */
  body: { channel?: unknown; message?: unknown; sender?: unknown }
  /** The RAW body text exactly as received — for byte-identity assertions. */
  raw: string
}

const requests: CapturedRequest[] = []

/** Per-channel scripted HTTP status; default 200 when unset. */
let responseByChannel: Map<string, number>

const testServer = Bun.serve({
  port: 0,
  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url)
    const raw = await req.text()
    let body: { channel?: unknown; message?: unknown; sender?: unknown } = {}
    try {
      body = JSON.parse(raw)
    } catch {
      /* leave body empty on parse failure */
    }
    requests.push({ method: req.method, path: url.pathname, body, raw })
    const channel = typeof body.channel === 'string' ? body.channel : ''
    const status = responseByChannel.get(channel) ?? 200
    return new Response(JSON.stringify({ status }), { status })
  },
})

const PORT = testServer.port as number

// ---------------------------------------------------------------------------
// Temp dirs + cron-log helpers
// ---------------------------------------------------------------------------

/** Temp dirs created during a test, torn down in afterEach. */
let tempDirs: string[]

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

/** One parsed cron-log line, split into its five contract fields. */
interface LogLine {
  timestamp: string
  identity: string
  channel: string
  outcome: string
  /** The remaining detail field (key=value tokens then free text). */
  detail: string
}

/** Read + parse the temp cron-log file into structured five-field lines. */
function readLog(logPath: string): LogLine[] {
  let text = ''
  try {
    text = readFileSync(logPath, 'utf-8')
  } catch {
    return []
  }
  return text
    .split('\n')
    .filter((l) => l.length > 0)
    .map((line) => {
      // Five space-delimited fields; detail (5th) may itself contain spaces.
      const parts = line.split(' ')
      const [timestamp, identity, channel, outcome, ...rest] = parts
      return {
        timestamp: timestamp ?? '',
        identity: identity ?? '',
        channel: channel ?? '',
        outcome: outcome ?? '',
        detail: rest.join(' '),
      }
    })
}

/** Extract a `key=value` token's value from a detail field, or undefined. */
function token(detail: string, key: string): string | undefined {
  for (const t of detail.split(' ')) {
    if (t.startsWith(`${key}=`)) return t.slice(key.length + 1)
  }
  return undefined
}

/**
 * Build a dispatcher + real cron-log over fresh temp files. Returns the
 * dispatcher, the log path, and a `lines()` reader. `cronTablePath` defaults to
 * a file inside a fresh temp dir so relative prompt paths resolve there.
 */
function makeHarness(opts: { cronTablePath?: string; port?: number; deliverTimeoutMs?: number } = {}): {
  fire: (s: CronSchedule) => Promise<void>
  logPath: string
  lines: () => LogLine[]
  cronTablePath: string
} {
  const logDir = makeTempDir('cscb-cronlog-test-')
  const logPath = join(logDir, 'cron.log')
  const cronTablePath = opts.cronTablePath ?? join(makeTempDir('cscb-crontab-test-'), 'crontab')
  const cronLog = createCronLog(logPath)
  const dispatcher = createCronDispatcher({
    port: opts.port ?? PORT,
    cronLog,
    cronTablePath,
    // Optional per-request deadline; omitted → factory default (production 3 s).
    ...(opts.deliverTimeoutMs !== undefined ? { deliverTimeoutMs: opts.deliverTimeoutMs } : {}),
  })
  return { fire: dispatcher.fire, logPath, lines: () => readLog(logPath), cronTablePath }
}

// ---------------------------------------------------------------------------
// Schedule factory
// ---------------------------------------------------------------------------

function explicitSchedule(
  promptPath: string,
  channelIds: string[],
  identity = 'cscb-cron:test',
): CronSchedule {
  return {
    identity,
    expression: '* * * * *',
    promptPath,
    channels: { kind: 'explicit', channelIds },
    rawLine: `* * * * * ${promptPath} ${channelIds.join(',')}`,
  }
}

function allBotsSchedule(promptPath: string, identity = 'cscb-cron:test'): CronSchedule {
  return {
    identity,
    expression: '* * * * *',
    promptPath,
    channels: { kind: 'all-bots' },
    rawLine: `* * * * * ${promptPath}`,
  }
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

beforeEach(() => {
  requests.length = 0
  responseByChannel = new Map()
  tempDirs = []
})

afterEach(() => {
  for (const dir of tempDirs) {
    // chmod back so an unreadable-file test dir can be removed.
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      /* best-effort */
    }
  }
})

afterAll(() => {
  testServer.stop()
})

// ---------------------------------------------------------------------------
// 1. All-bots marker
// ---------------------------------------------------------------------------

describe('all-bots marker', () => {
  test('logs one fanout-deferred + 0/0 summary, POSTs nothing, reads no prompt', async () => {
    const h = makeHarness()
    // Point at a nonexistent path: if the code read the prompt it would log
    // prompt-missing. We assert it does NOT, proving no read was attempted.
    const s = allBotsSchedule('/nonexistent/never-read.md')
    await h.fire(s)

    const lines = h.lines()
    const deferred = lines.filter((l) => l.outcome === 'fanout-deferred')
    expect(deferred).toHaveLength(1)
    expect(deferred[0]!.channel).toBe('-')
    expect(deferred[0]!.identity).toBe('cscb-cron:test')

    const summaries = lines.filter((l) => l.outcome === 'summary')
    expect(summaries).toHaveLength(1)
    expect(token(summaries[0]!.detail, 'delivered')).toBe('0')
    expect(token(summaries[0]!.detail, 'failed')).toBe('0')

    // Proof of no read: no prompt-missing/prompt-unreadable line.
    expect(lines.some((l) => l.outcome.startsWith('prompt-'))).toBe(false)

    // Zero requests reached the server.
    expect(requests).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// 2. prompt-missing
// ---------------------------------------------------------------------------

describe('prompt-missing', () => {
  test('nonexistent file → prompt-missing (channel -), 0/N summary, zero POSTs', async () => {
    const dir = makeTempDir('cscb-prompt-test-')
    const promptPath = join(dir, 'gone.md')
    // Never created (or delete to be explicit).
    writeFileSync(promptPath, 'temp')
    unlinkSync(promptPath)

    const h = makeHarness()
    await h.fire(explicitSchedule(promptPath, ['C_A', 'C_B']))

    const lines = h.lines()
    const missing = lines.filter((l) => l.outcome === 'prompt-missing')
    expect(missing).toHaveLength(1)
    expect(missing[0]!.channel).toBe('-')
    expect(token(missing[0]!.detail, 'prompt')).toBe(promptPath)

    const summary = lines.find((l) => l.outcome === 'summary')!
    expect(token(summary.detail, 'delivered')).toBe('0')
    expect(token(summary.detail, 'failed')).toBe('2')

    expect(requests).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// 3. prompt-unreadable
// ---------------------------------------------------------------------------

describe('prompt-unreadable', () => {
  test('unreadable file → prompt-unreadable with errno token, zero POSTs', async () => {
    const dir = makeTempDir('cscb-prompt-test-')
    let promptPath: string

    if (process.getuid?.() === 0) {
      // Running as root: chmod 000 is bypassed. Construct unreadability by
      // pointing at a DIRECTORY — readFileSync on a dir throws EISDIR, which
      // is not ENOENT, so it maps to prompt-unreadable (never silently skipped).
      promptPath = dir
    } else {
      promptPath = join(dir, 'secret.md')
      writeFileSync(promptPath, 'top secret')
      chmodSync(promptPath, 0o000)
    }

    const h = makeHarness()
    await h.fire(explicitSchedule(promptPath, ['C_A']))

    // Restore perms so afterEach cleanup can remove the file.
    if (process.getuid?.() !== 0) chmodSync(promptPath, 0o644)

    const lines = h.lines()
    const unreadable = lines.filter((l) => l.outcome === 'prompt-unreadable')
    expect(unreadable).toHaveLength(1)
    expect(unreadable[0]!.channel).toBe('-')
    expect(token(unreadable[0]!.detail, 'errno')).toBeDefined()

    const summary = lines.find((l) => l.outcome === 'summary')!
    expect(token(summary.detail, 'delivered')).toBe('0')
    expect(token(summary.detail, 'failed')).toBe('1')

    expect(requests).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// 4. Oversize boundary pair — computed from the ACTUAL serialized envelope.
// ---------------------------------------------------------------------------

describe('oversize boundary', () => {
  const CAP = 32768
  const CHANNEL = 'C_BIG'
  const IDENTITY = 'cscb-cron:big'

  /** Byte overhead of the envelope with empty ASCII message content. */
  function envelopeOverhead(): number {
    const empty = JSON.stringify({ channel: CHANNEL, message: '', sender: IDENTITY })
    return new TextEncoder().encode(empty).byteLength
  }

  test('just-under (exactly 32768 bytes) → delivered, full untruncated body received', async () => {
    const overhead = envelopeOverhead()
    // Plain ASCII 'a' → 1 byte each, no JSON escaping, so body byteLength is
    // overhead + content.length. Target exactly CAP.
    const content = 'a'.repeat(CAP - overhead)
    const dir = makeTempDir('cscb-prompt-test-')
    const promptPath = join(dir, 'big.md')
    writeFileSync(promptPath, content)

    const expectedBody = JSON.stringify({ channel: CHANNEL, message: content, sender: IDENTITY })
    expect(new TextEncoder().encode(expectedBody).byteLength).toBe(CAP)

    const h = makeHarness()
    await h.fire(explicitSchedule(promptPath, [CHANNEL], IDENTITY))

    expect(requests).toHaveLength(1)
    // Byte-identity: the raw body the server received IS the expected string.
    expect(requests[0]!.raw).toBe(expectedBody)
    // Content is full and untruncated.
    expect(requests[0]!.body.message).toBe(content)
    expect((requests[0]!.body.message as string).length).toBe(content.length)

    const delivered = h.lines().filter((l) => l.outcome === 'delivered')
    expect(delivered).toHaveLength(1)
  })

  test('just-over (exactly 32769 bytes) → prompt-oversize, NO POST', async () => {
    const overhead = envelopeOverhead()
    const content = 'a'.repeat(CAP + 1 - overhead)
    const dir = makeTempDir('cscb-prompt-test-')
    const promptPath = join(dir, 'toobig.md')
    writeFileSync(promptPath, content)

    const expectedBody = JSON.stringify({ channel: CHANNEL, message: content, sender: IDENTITY })
    expect(new TextEncoder().encode(expectedBody).byteLength).toBe(CAP + 1)

    const h = makeHarness()
    await h.fire(explicitSchedule(promptPath, [CHANNEL], IDENTITY))

    expect(requests).toHaveLength(0)
    const oversize = h.lines().filter((l) => l.outcome === 'prompt-oversize')
    expect(oversize).toHaveLength(1)
    expect(oversize[0]!.channel).toBe(CHANNEL)

    const summary = h.lines().find((l) => l.outcome === 'summary')!
    expect(token(summary.detail, 'delivered')).toBe('0')
    expect(token(summary.detail, 'failed')).toBe('1')
  })
})

// ---------------------------------------------------------------------------
// 5. Response mappings
// ---------------------------------------------------------------------------

describe('HTTP status → outcome mapping', () => {
  test.each([
    [200, 'delivered'],
    [503, 'no-session'],
    [404, 'unknown-channel'],
    [500, 'http-error'],
  ])('status %i → %s', async (status, expectedOutcome) => {
    const dir = makeTempDir('cscb-prompt-test-')
    const promptPath = join(dir, 'p.md')
    writeFileSync(promptPath, 'ping')

    responseByChannel.set('C_X', status as number)
    const h = makeHarness()
    await h.fire(explicitSchedule(promptPath, ['C_X']))

    const lines = h.lines()
    const outcomes = lines.filter((l) => l.channel === 'C_X')
    expect(outcomes).toHaveLength(1)
    expect(outcomes[0]!.outcome).toBe(expectedOutcome)

    // Exactly one POST for every status (no retry, including 503).
    expect(requests).toHaveLength(1)
    expect(requests[0]!.method).toBe('POST')
    expect(requests[0]!.path).toBe('/interject')

    if (status === 500) {
      expect(token(outcomes[0]!.detail, 'status')).toBe('500')
    }
  })

  test('connection refused (dead port) → http-error', async () => {
    // Bind a second server on port 0, capture its port, then stop it — that
    // port is now dead. Never hardcode a port.
    const dead = Bun.serve({ port: 0, fetch: () => new Response('x') })
    const deadPort = dead.port as number
    dead.stop()

    const dir = makeTempDir('cscb-prompt-test-')
    const promptPath = join(dir, 'p.md')
    writeFileSync(promptPath, 'ping')

    const h = makeHarness({ port: deadPort })
    await h.fire(explicitSchedule(promptPath, ['C_DEAD']))

    const line = h.lines().find((l) => l.channel === 'C_DEAD')!
    expect(line.outcome).toBe('http-error')
    // No live server captured a request (requests array untouched by dead port).
    expect(requests).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// 6. Body fidelity on a delivering fire
// ---------------------------------------------------------------------------

describe('body fidelity', () => {
  test('sender === identity, message === file content, channel === target', async () => {
    const dir = makeTempDir('cscb-prompt-test-')
    const promptPath = join(dir, 'msg.md')
    const content = 'Grooming tick: check the queue please.'
    writeFileSync(promptPath, content)

    const h = makeHarness()
    await h.fire(explicitSchedule(promptPath, ['C_FID'], 'cscb-cron:msg'))

    expect(requests).toHaveLength(1)
    expect(requests[0]!.body.sender).toBe('cscb-cron:msg')
    expect(requests[0]!.body.message).toBe(content)
    expect(requests[0]!.body.channel).toBe('C_FID')
  })
})

// ---------------------------------------------------------------------------
// 7. Path resolution — tilde, relative-to-crontable-dir, absolute
// ---------------------------------------------------------------------------

describe('path resolution', () => {
  test('leading ~ expands against homedir (asserted via resolved prompt= token)', async () => {
    // Guaranteed-nonexistent path under $HOME — never created. We assert the
    // prompt-missing detail carries the expandTilde'd absolute path.
    const rand = Math.random().toString(36).slice(2)
    const rel = `.cscb-cron-test-${rand}/missing.md`
    const resolved = join(homedir(), rel)

    const h = makeHarness()
    await h.fire(explicitSchedule(`~/${rel}`, ['C_A']))

    const missing = h.lines().find((l) => l.outcome === 'prompt-missing')!
    expect(token(missing.detail, 'prompt')).toBe(resolved)
    expect(requests).toHaveLength(0)
  })

  test('relative path resolves against dirname(cronTablePath) and delivers its content', async () => {
    // crontab lives at <dir>/crontab; a relative `prompts/foo.md` must resolve
    // to <dir>/prompts/foo.md (the crontable's directory, not CWD or $HOME).
    const tableDir = makeTempDir('cscb-crontab-test-')
    const cronTablePath = join(tableDir, 'crontab')
    const promptsDir = join(tableDir, 'prompts')
    mkdirSync(promptsDir, { recursive: true })
    const content = 'relative prompt body'
    const promptFile = join(promptsDir, 'foo.md')
    writeFileSync(promptFile, content)

    const h = makeHarness({ cronTablePath })
    await h.fire(explicitSchedule('prompts/foo.md', ['C_REL']))

    expect(requests).toHaveLength(1)
    expect(requests[0]!.body.message).toBe(content)
    const line = h.lines().find((l) => l.channel === 'C_REL')!
    expect(token(line.detail, 'prompt')).toBe(promptFile)
  })

  test('absolute path is used as-is and delivers its content', async () => {
    const dir = makeTempDir('cscb-prompt-test-')
    const promptPath = join(dir, 'abs.md')
    const content = 'absolute prompt body'
    writeFileSync(promptPath, content)

    const h = makeHarness()
    await h.fire(explicitSchedule(promptPath, ['C_ABS']))

    expect(requests).toHaveLength(1)
    expect(requests[0]!.body.message).toBe(content)
    const line = h.lines().find((l) => l.channel === 'C_ABS')!
    expect(token(line.detail, 'prompt')).toBe(promptPath)
  })
})

// ---------------------------------------------------------------------------
// 8. Multi-target mixed results
// ---------------------------------------------------------------------------

describe('multi-target mixed fire', () => {
  test('200 + 404 → per-target classes, both attempted, summary delivered=1 failed=1', async () => {
    const dir = makeTempDir('cscb-prompt-test-')
    const promptPath = join(dir, 'multi.md')
    writeFileSync(promptPath, 'multi body')

    responseByChannel.set('C_OK', 200)
    responseByChannel.set('C_404', 404)

    const h = makeHarness()
    await h.fire(explicitSchedule(promptPath, ['C_OK', 'C_404']))

    // Both targets attempted → two requests.
    expect(requests).toHaveLength(2)

    const lines = h.lines()
    expect(lines.find((l) => l.channel === 'C_OK')!.outcome).toBe('delivered')
    expect(lines.find((l) => l.channel === 'C_404')!.outcome).toBe('unknown-channel')

    const summaries = lines.filter((l) => l.outcome === 'summary')
    expect(summaries).toHaveLength(1)
    expect(token(summaries[0]!.detail, 'delivered')).toBe('1')
    expect(token(summaries[0]!.detail, 'failed')).toBe('1')
  })
})

// ---------------------------------------------------------------------------
// 9. Fresh-read — rewrite between fires
// ---------------------------------------------------------------------------

describe('fresh-read', () => {
  test('rewriting the prompt between fires makes the second POST carry new content', async () => {
    const dir = makeTempDir('cscb-prompt-test-')
    const promptPath = join(dir, 'live.md')
    writeFileSync(promptPath, 'first content')

    const h = makeHarness()
    const s = explicitSchedule(promptPath, ['C_FRESH'])

    await h.fire(s)
    writeFileSync(promptPath, 'second content')
    await h.fire(s)

    expect(requests).toHaveLength(2)
    expect(requests[0]!.body.message).toBe('first content')
    expect(requests[1]!.body.message).toBe('second content')
  })
})

// ---------------------------------------------------------------------------
// 10. Deliver deadline — accepting-but-silent peer (b.rvo)
// ---------------------------------------------------------------------------
//
// A peer that ACCEPTS the TCP connection but never responds would hang deliver()
// forever without the AbortSignal.timeout fix — no outcome line, no summary
// line, violating the every-fire-is-logged contract. These tests stand up a
// dedicated Bun.serve whose handler returns a Promise that never settles, hand
// its real bound port to the factory, and drive fire() with a short
// deliverTimeoutMs (100 ms) so the deadline trips fast. The stalled server is
// force-closed (`stop(true)`) in afterEach so an active hung connection cannot
// wedge teardown.
//
// Anti-hang budget: deliverTimeoutMs=100 ms; per-target loop is sequential so
// worst case is targets × 100 ms; each test carries a Bun test-timeout third
// arg (2000 ms) that is ~20× the single-target deadline yet far under the
// suite's default 5 s patience. WITHOUT the fix the never-settling handler means
// fetch never rejects, fire() never returns, and the 2000 ms test timeout fires
// → the test FAILS FAST (it does not hang the suite and it does not pass).

describe('deliver deadline (accepting-but-silent peer)', () => {
  /** Servers whose handler never settles — force-closed after each test. */
  let silentServers: ReturnType<typeof Bun.serve>[]

  beforeEach(() => {
    silentServers = []
  })

  afterEach(() => {
    for (const s of silentServers) {
      // stop(true) force-closes active (hung) connections so teardown cannot
      // block on the never-settling handler.
      try {
        s.stop(true)
      } catch {
        /* best-effort */
      }
    }
  })

  /**
   * Start a server on an ephemeral port whose handler accepts the request and
   * returns a Promise that never resolves. The request is captured so a hung
   * connection is provable, but no Response is ever produced.
   */
  function startSilentServer(): number {
    const server = Bun.serve({
      port: 0,
      fetch(): Promise<Response> {
        // Never settles: the connection stays open, no response is ever sent.
        return new Promise<Response>(() => {})
      },
    })
    silentServers.push(server)
    return server.port as number
  }

  test(
    'wedged peer → fire completes, one http-error with TimeoutError detail, plus summary',
    async () => {
      const silentPort = startSilentServer()

      const dir = makeTempDir('cscb-prompt-test-')
      const promptPath = join(dir, 'p.md')
      writeFileSync(promptPath, 'ping')

      // Short per-request deadline so the wedged peer trips fast (production is
      // 3 s). If fire() ever returns here, the deadline worked.
      const h = makeHarness({ port: silentPort, deliverTimeoutMs: 100 })

      // This await is the anti-hang assertion: without the fix it never resolves
      // and the 2000 ms test timeout below fails the test fast.
      await h.fire(explicitSchedule(promptPath, ['C_WEDGED']))

      const lines = h.lines()

      // Exactly one outcome for the wedged target, classed http-error.
      const wedged = lines.filter((l) => l.channel === 'C_WEDGED')
      expect(wedged).toHaveLength(1)
      expect(wedged[0]!.outcome).toBe('http-error')
      // TimeoutError detail: errno token is the DOMException name (not legacy 23).
      // That token is the behavioral contract; the trailing free text is Bun's
      // runtime-internal timeout prose, so assert only that it is non-empty
      // rather than pinning the exact wording.
      expect(token(wedged[0]!.detail, 'errno')).toBe('TimeoutError')
      expect(wedged[0]!.detail.replace(/\S*errno=\S*/, '').trim().length).toBeGreaterThan(0)

      // Summary line is produced: delivered=0 failed=1.
      const summaries = lines.filter((l) => l.outcome === 'summary')
      expect(summaries).toHaveLength(1)
      expect(token(summaries[0]!.detail, 'delivered')).toBe('0')
      expect(token(summaries[0]!.detail, 'failed')).toBe('1')
    },
    2000,
  )

  test(
    'mixed fire (healthy + wedged) → healthy delivered, wedged http-error, summary counts both',
    async () => {
      const silentPort = startSilentServer()

      const dir = makeTempDir('cscb-prompt-test-')
      const promptPath = join(dir, 'multi.md')
      writeFileSync(promptPath, 'multi body')

      // A dispatcher targets exactly one port, so to exercise one healthy + one
      // wedged target in a SINGLE fire we need one server that answers 200 for
      // the healthy channel and hangs (never settles) for the wedged channel.
      const mixedServer = Bun.serve({
        port: 0,
        async fetch(req: Request): Promise<Response> {
          const raw = await req.text()
          let channel = ''
          try {
            channel = (JSON.parse(raw) as { channel?: unknown }).channel as string
          } catch {
            /* leave channel empty */
          }
          if (channel === 'C_WEDGED') {
            // Never settles for the wedged channel.
            return new Promise<Response>(() => {})
          }
          return new Response(JSON.stringify({ status: 200 }), { status: 200 })
        },
      })
      silentServers.push(mixedServer)
      const mixedPort = mixedServer.port as number

      const h = makeHarness({ port: mixedPort, deliverTimeoutMs: 100 })

      // Healthy target first, wedged second — proves the sequential loop
      // continues past a healthy delivery to attempt (and time out) the wedged
      // one, and that the wedged hang does not swallow the earlier outcome.
      await h.fire(explicitSchedule(promptPath, ['C_OK', 'C_WEDGED']))

      const lines = h.lines()
      expect(lines.find((l) => l.channel === 'C_OK')!.outcome).toBe('delivered')

      const wedged = lines.filter((l) => l.channel === 'C_WEDGED')
      expect(wedged).toHaveLength(1)
      expect(wedged[0]!.outcome).toBe('http-error')
      expect(token(wedged[0]!.detail, 'errno')).toBe('TimeoutError')

      const summaries = lines.filter((l) => l.outcome === 'summary')
      expect(summaries).toHaveLength(1)
      expect(token(summaries[0]!.detail, 'delivered')).toBe('1')
      expect(token(summaries[0]!.detail, 'failed')).toBe('1')
    },
    2000,
  )
})
