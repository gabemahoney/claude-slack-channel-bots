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
  fireGroup: (s: CronSchedule[]) => Promise<void>
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
  return {
    fire: dispatcher.fire,
    fireGroup: dispatcher.fireGroup,
    logPath,
    lines: () => readLog(logPath),
    cronTablePath,
  }
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

// ---------------------------------------------------------------------------
// 11. fireGroup — same-channel concatenation (gate answer 3, t2.he5.eu.4q)
// ---------------------------------------------------------------------------
//
// When N schedules match the same minute for the same target channel, ONE
// /interject POST is delivered whose body is the N prompts concatenated in
// crontable line (input) order, separated by exactly "\n\n". The grouped sender
// names every contributor (head full identity + '+<basename>' per tail). Each
// contributing (schedule, channel) pair gets its own outcome line carrying the
// SHARED status, with grouped=N in the free text only when N >= 2. Each schedule
// still gets exactly one summary line counting ITS own targets.

describe('fireGroup same-channel concatenation', () => {
  test('3 schedules → ONE POST, exact ordered body, combined sender, 3 grouped outcomes + 3 summaries', async () => {
    const dir = makeTempDir('cscb-prompt-test-')
    const p1 = join(dir, 'p1.md')
    const p2 = join(dir, 'p2.md')
    const p3 = join(dir, 'p3.md')
    writeFileSync(p1, 'PROMPT-ONE')
    writeFileSync(p2, 'PROMPT-TWO')
    writeFileSync(p3, 'PROMPT-THREE')

    const CHANNEL = 'C_GROUP'
    const h = makeHarness()
    await h.fireGroup([
      explicitSchedule(p1, [CHANNEL], 'cscb-cron:alpha'),
      explicitSchedule(p2, [CHANNEL], 'cscb-cron:beta'),
      explicitSchedule(p3, [CHANNEL], 'cscb-cron:gamma'),
    ])

    // Exactly ONE POST for the shared channel (grouping reduced 3 fires to 1).
    expect(requests).toHaveLength(1)
    const req = requests[0]!
    expect(req.body.channel).toBe(CHANNEL)

    // Exact ordered body: p1 \n\n p2 \n\n p3. An accidental reordering (or a
    // different separator) must fail loudly here.
    expect(req.body.message).toBe('PROMPT-ONE\n\nPROMPT-TWO\n\nPROMPT-THREE')

    // Combined sender: head full identity + '+<basename>' per subsequent
    // contributor (shared cscb-cron: prefix stripped from the tail).
    expect(req.body.sender).toBe('cscb-cron:alpha+beta+gamma')

    const lines = h.lines()

    // Each contributing (schedule, channel) pair gets its OWN outcome line, all
    // sharing the delivered status, all carrying grouped=3.
    const outcomes = lines.filter((l) => l.channel === CHANNEL && l.outcome === 'delivered')
    expect(outcomes).toHaveLength(3)
    const outcomeIdentities = outcomes.map((l) => l.identity).sort()
    expect(outcomeIdentities).toEqual(['cscb-cron:alpha', 'cscb-cron:beta', 'cscb-cron:gamma'])
    for (const l of outcomes) {
      expect(token(l.detail, 'grouped')).toBe('3')
    }

    // One summary per contributing schedule, each counting its own 1 target.
    const summaries = lines.filter((l) => l.outcome === 'summary')
    expect(summaries).toHaveLength(3)
    const summaryIdentities = summaries.map((l) => l.identity).sort()
    expect(summaryIdentities).toEqual(['cscb-cron:alpha', 'cscb-cron:beta', 'cscb-cron:gamma'])
    for (const s of summaries) {
      expect(token(s.detail, 'delivered')).toBe('1')
      expect(token(s.detail, 'failed')).toBe('0')
    }
  })

  test('grouped outcome status is shared across contributors (503 → all no-session, grouped=3)', async () => {
    const dir = makeTempDir('cscb-prompt-test-')
    const p1 = join(dir, 'a.md')
    const p2 = join(dir, 'b.md')
    const p3 = join(dir, 'c.md')
    writeFileSync(p1, 'A')
    writeFileSync(p2, 'B')
    writeFileSync(p3, 'C')

    const CHANNEL = 'C_503'
    responseByChannel.set(CHANNEL, 503)

    const h = makeHarness()
    await h.fireGroup([
      explicitSchedule(p1, [CHANNEL], 'cscb-cron:a'),
      explicitSchedule(p2, [CHANNEL], 'cscb-cron:b'),
      explicitSchedule(p3, [CHANNEL], 'cscb-cron:c'),
    ])

    // Still ONE POST even on failure (no retry, no per-contributor re-send).
    expect(requests).toHaveLength(1)

    const lines = h.lines()
    const outcomes = lines.filter((l) => l.channel === CHANNEL)
    expect(outcomes).toHaveLength(3)
    for (const l of outcomes) {
      expect(l.outcome).toBe('no-session')
      expect(token(l.detail, 'grouped')).toBe('3')
    }

    // Each schedule's own summary counts its single target as failed.
    const summaries = lines.filter((l) => l.outcome === 'summary')
    expect(summaries).toHaveLength(3)
    for (const s of summaries) {
      expect(token(s.detail, 'delivered')).toBe('0')
      expect(token(s.detail, 'failed')).toBe('1')
    }
  })
})

// ---------------------------------------------------------------------------
// 12. fireGroup — mixed-channel grouping (different channels never concatenate)
// ---------------------------------------------------------------------------

describe('fireGroup mixed-channel grouping', () => {
  test('one multi-channel schedule + single-channel siblings → per-channel bodies, never cross-channel concatenation', async () => {
    const dir = makeTempDir('cscb-prompt-test-')
    const pShared = join(dir, 'shared.md')
    const pOnly1 = join(dir, 'only1.md')
    const pOnly2 = join(dir, 'only2.md')
    writeFileSync(pShared, 'SHARED')
    writeFileSync(pOnly1, 'ONLY-C1')
    writeFileSync(pOnly2, 'ONLY-C2')

    // s1 targets BOTH C1 and C2; s2 targets only C1; s3 targets only C2.
    // C1 group (input order): s1, s2 → "SHARED\n\nONLY-C1"
    // C2 group (input order): s1, s3 → "SHARED\n\nONLY-C2"
    const h = makeHarness()
    await h.fireGroup([
      explicitSchedule(pShared, ['C1', 'C2'], 'cscb-cron:shared'),
      explicitSchedule(pOnly1, ['C1'], 'cscb-cron:one'),
      explicitSchedule(pOnly2, ['C2'], 'cscb-cron:two'),
    ])

    // One POST per DISTINCT channel — never a single cross-channel concatenation.
    expect(requests).toHaveLength(2)

    const c1 = requests.find((r) => r.body.channel === 'C1')!
    const c2 = requests.find((r) => r.body.channel === 'C2')!
    expect(c1).toBeDefined()
    expect(c2).toBeDefined()

    // Per-channel bodies concatenated in input order; no other channel's prompt
    // ever leaks in.
    expect(c1.body.message).toBe('SHARED\n\nONLY-C1')
    expect(c1.body.sender).toBe('cscb-cron:shared+one')
    expect(c2.body.message).toBe('SHARED\n\nONLY-C2')
    expect(c2.body.sender).toBe('cscb-cron:shared+two')

    const lines = h.lines()

    // Grouped outcome lines: C1 has {shared, one}, C2 has {shared, two}, each
    // grouped=2.
    const c1Outcomes = lines.filter((l) => l.channel === 'C1' && l.outcome === 'delivered')
    expect(c1Outcomes.map((l) => l.identity).sort()).toEqual(['cscb-cron:one', 'cscb-cron:shared'])
    for (const l of c1Outcomes) expect(token(l.detail, 'grouped')).toBe('2')

    const c2Outcomes = lines.filter((l) => l.channel === 'C2' && l.outcome === 'delivered')
    expect(c2Outcomes.map((l) => l.identity).sort()).toEqual(['cscb-cron:shared', 'cscb-cron:two'])
    for (const l of c2Outcomes) expect(token(l.detail, 'grouped')).toBe('2')

    // Summaries: shared delivered=2 (both channels), one/two delivered=1 each.
    const summaries = lines.filter((l) => l.outcome === 'summary')
    expect(summaries).toHaveLength(3)
    const shared = summaries.find((s) => s.identity === 'cscb-cron:shared')!
    expect(token(shared.detail, 'delivered')).toBe('2')
    expect(token(shared.detail, 'failed')).toBe('0')
    const one = summaries.find((s) => s.identity === 'cscb-cron:one')!
    expect(token(one.detail, 'delivered')).toBe('1')
    const two = summaries.find((s) => s.identity === 'cscb-cron:two')!
    expect(token(two.detail, 'delivered')).toBe('1')
  })
})

// ---------------------------------------------------------------------------
// 13. fireGroup — oversize group falls back to individual delivery
// ---------------------------------------------------------------------------

describe('fireGroup oversize-group fallback', () => {
  const CAP = 32768

  test('concatenated body over cap → one info split line, then individual deliveries in order', async () => {
    const dir = makeTempDir('cscb-prompt-test-')
    const CHANNEL = 'C_OVER'
    const IDENTITY_A = 'cscb-cron:big-a'
    const IDENTITY_B = 'cscb-cron:big-b'

    // Two prompts each comfortably UNDER the cap on their own, but whose
    // concatenation (+ "\n\n" + combined sender envelope) exceeds it. Sizing
    // each at ~20000 ASCII bytes guarantees the individual envelopes are under
    // 32768 while the grouped body is well over.
    const contentA = 'a'.repeat(20000)
    const contentB = 'b'.repeat(20000)
    const pA = join(dir, 'a.md')
    const pB = join(dir, 'b.md')
    writeFileSync(pA, contentA)
    writeFileSync(pB, contentB)

    const h = makeHarness()
    await h.fireGroup([
      explicitSchedule(pA, [CHANNEL], IDENTITY_A),
      explicitSchedule(pB, [CHANNEL], IDENTITY_B),
    ])

    // Fallback: each contributor delivered INDIVIDUALLY (2 separate POSTs), in
    // input order, each carrying only its own content (no concatenation).
    expect(requests).toHaveLength(2)
    expect(requests[0]!.body.channel).toBe(CHANNEL)
    expect(requests[0]!.body.message).toBe(contentA)
    expect(requests[0]!.body.sender).toBe(IDENTITY_A)
    expect(requests[1]!.body.message).toBe(contentB)
    expect(requests[1]!.body.sender).toBe(IDENTITY_B)

    // Each individual body is under the cap.
    for (const r of requests) {
      expect(new TextEncoder().encode(r.raw).byteLength).toBeLessThanOrEqual(CAP)
    }

    const lines = h.lines()

    // Exactly one info line records the split, naming the channel and the exact
    // group size the source emits (`delivering <n> schedules individually`) —
    // not a bare `2`, which any status/byte digit would satisfy.
    const info = lines.filter((l) => l.outcome === 'info')
    expect(info).toHaveLength(1)
    expect(info[0]!.channel).toBe(CHANNEL)
    expect(info[0]!.detail).toContain('delivering 2 schedules individually')

    // Individual deliveries: two delivered outcomes, and because each was a
    // single-contributor POST there is NO grouped= token.
    const delivered = lines.filter((l) => l.channel === CHANNEL && l.outcome === 'delivered')
    expect(delivered).toHaveLength(2)
    for (const l of delivered) {
      expect(token(l.detail, 'grouped')).toBeUndefined()
    }

    // One summary per schedule, each delivered=1 failed=0.
    const summaries = lines.filter((l) => l.outcome === 'summary')
    expect(summaries).toHaveLength(2)
    for (const s of summaries) {
      expect(token(s.detail, 'delivered')).toBe('1')
      expect(token(s.detail, 'failed')).toBe('0')
    }
  })

  test('oversize group where one contributor is itself over cap → that one logs prompt-oversize, sibling still delivers', async () => {
    const dir = makeTempDir('cscb-prompt-test-')
    const CHANNEL = 'C_MIX'
    const IDENTITY_BIG = 'cscb-cron:huge'
    const IDENTITY_OK = 'cscb-cron:tiny'

    // One prompt individually OVER the cap, one small. The group is oversize, so
    // fallback runs; the huge one fails its own cap check (prompt-oversize, no
    // POST), the small one delivers.
    const overhead = new TextEncoder().encode(
      JSON.stringify({ channel: CHANNEL, message: '', sender: IDENTITY_BIG }),
    ).byteLength
    const contentBig = 'a'.repeat(CAP + 1 - overhead)
    const contentOk = 'small'
    const pBig = join(dir, 'huge.md')
    const pOk = join(dir, 'tiny.md')
    writeFileSync(pBig, contentBig)
    writeFileSync(pOk, contentOk)

    const h = makeHarness()
    await h.fireGroup([
      explicitSchedule(pBig, [CHANNEL], IDENTITY_BIG),
      explicitSchedule(pOk, [CHANNEL], IDENTITY_OK),
    ])

    // Only the small sibling actually POSTs; the oversize one never does.
    expect(requests).toHaveLength(1)
    expect(requests[0]!.body.sender).toBe(IDENTITY_OK)
    expect(requests[0]!.body.message).toBe(contentOk)

    const lines = h.lines()

    // Split info line present.
    expect(lines.filter((l) => l.outcome === 'info')).toHaveLength(1)

    // The oversize contributor logs prompt-oversize naming its promptPath.
    const oversize = lines.filter((l) => l.outcome === 'prompt-oversize')
    expect(oversize).toHaveLength(1)
    expect(oversize[0]!.identity).toBe(IDENTITY_BIG)
    expect(oversize[0]!.channel).toBe(CHANNEL)
    expect(token(oversize[0]!.detail, 'prompt')).toBe(pBig)

    // The sibling delivers.
    const delivered = lines.filter((l) => l.channel === CHANNEL && l.outcome === 'delivered')
    expect(delivered).toHaveLength(1)
    expect(delivered[0]!.identity).toBe(IDENTITY_OK)

    // Summaries: huge 0/1, tiny 1/0.
    const summaries = lines.filter((l) => l.outcome === 'summary')
    expect(summaries).toHaveLength(2)
    const big = summaries.find((s) => s.identity === IDENTITY_BIG)!
    expect(token(big.detail, 'delivered')).toBe('0')
    expect(token(big.detail, 'failed')).toBe('1')
    const ok = summaries.find((s) => s.identity === IDENTITY_OK)!
    expect(token(ok.detail, 'delivered')).toBe('1')
    expect(token(ok.detail, 'failed')).toBe('0')
  })
})

// ---------------------------------------------------------------------------
// 14. fireGroup — a prompt-missing schedule is excluded; siblings still deliver
// ---------------------------------------------------------------------------

describe('fireGroup with a prompt-missing sibling', () => {
  test('missing prompt excluded from concatenation, siblings still concatenated/delivered, missing summarized 0/N', async () => {
    const dir = makeTempDir('cscb-prompt-test-')
    const CHANNEL = 'C_SIB'
    const pPresent1 = join(dir, 'present1.md')
    const pPresent2 = join(dir, 'present2.md')
    const pGone = join(dir, 'gone.md')
    writeFileSync(pPresent1, 'PRESENT-ONE')
    writeFileSync(pPresent2, 'PRESENT-TWO')
    // pGone deliberately never created.

    // Order: present1, MISSING, present2 — the missing one sits BETWEEN the two
    // present siblings, so a correct exclusion must still join present1\n\npresent2
    // (the gap must not leave a blank slot or reorder).
    const h = makeHarness()
    await h.fireGroup([
      explicitSchedule(pPresent1, [CHANNEL], 'cscb-cron:one'),
      explicitSchedule(pGone, [CHANNEL], 'cscb-cron:gone'),
      explicitSchedule(pPresent2, [CHANNEL], 'cscb-cron:two'),
    ])

    // One grouped POST for the two present siblings only.
    expect(requests).toHaveLength(1)
    expect(requests[0]!.body.channel).toBe(CHANNEL)
    // The missing schedule is excluded — no empty separator slot, order preserved.
    expect(requests[0]!.body.message).toBe('PRESENT-ONE\n\nPRESENT-TWO')
    expect(requests[0]!.body.sender).toBe('cscb-cron:one+two')

    const lines = h.lines()

    // The missing schedule logs prompt-missing with no channel and is summarized
    // 0/N (N=1 target here).
    const missing = lines.filter((l) => l.outcome === 'prompt-missing')
    expect(missing).toHaveLength(1)
    expect(missing[0]!.identity).toBe('cscb-cron:gone')
    expect(missing[0]!.channel).toBe('-')
    expect(token(missing[0]!.detail, 'prompt')).toBe(pGone)

    const goneSummary = lines.find((l) => l.outcome === 'summary' && l.identity === 'cscb-cron:gone')!
    expect(token(goneSummary.detail, 'delivered')).toBe('0')
    expect(token(goneSummary.detail, 'failed')).toBe('1')

    // The two present siblings share the grouped delivery (grouped=2) and each
    // summarizes 1/0.
    const delivered = lines.filter((l) => l.channel === CHANNEL && l.outcome === 'delivered')
    expect(delivered).toHaveLength(2)
    for (const l of delivered) expect(token(l.detail, 'grouped')).toBe('2')

    const oneSummary = lines.find((l) => l.outcome === 'summary' && l.identity === 'cscb-cron:one')!
    expect(token(oneSummary.detail, 'delivered')).toBe('1')
    const twoSummary = lines.find((l) => l.outcome === 'summary' && l.identity === 'cscb-cron:two')!
    expect(token(twoSummary.detail, 'delivered')).toBe('1')
  })

  test('all-bots schedule inside a group keeps its own fanout-deferred handling; explicit sibling still delivers', async () => {
    const dir = makeTempDir('cscb-prompt-test-')
    const CHANNEL = 'C_AB'
    const pExplicit = join(dir, 'explicit.md')
    writeFileSync(pExplicit, 'EXPLICIT')

    const h = makeHarness()
    await h.fireGroup([
      allBotsSchedule('/nonexistent/never-read.md', 'cscb-cron:allbots'),
      explicitSchedule(pExplicit, [CHANNEL], 'cscb-cron:explicit'),
    ])

    // The explicit sibling delivers; the all-bots one POSTs nothing.
    expect(requests).toHaveLength(1)
    expect(requests[0]!.body.channel).toBe(CHANNEL)
    expect(requests[0]!.body.message).toBe('EXPLICIT')

    const lines = h.lines()

    // All-bots keeps its fanout-deferred line + 0/0 summary, no prompt read.
    const deferred = lines.filter((l) => l.outcome === 'fanout-deferred')
    expect(deferred).toHaveLength(1)
    expect(deferred[0]!.identity).toBe('cscb-cron:allbots')
    expect(lines.some((l) => l.outcome.startsWith('prompt-'))).toBe(false)

    const abSummary = lines.find((l) => l.outcome === 'summary' && l.identity === 'cscb-cron:allbots')!
    expect(token(abSummary.detail, 'delivered')).toBe('0')
    expect(token(abSummary.detail, 'failed')).toBe('0')

    // The explicit sibling delivered — and since it was the SOLE contributor to
    // its channel, no grouped= token.
    const delivered = lines.filter((l) => l.channel === CHANNEL && l.outcome === 'delivered')
    expect(delivered).toHaveLength(1)
    expect(token(delivered[0]!.detail, 'grouped')).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// 15. fire() single-schedule path is byte-identical (no grouped= token)
// ---------------------------------------------------------------------------

describe('single-schedule fire() unchanged by grouping', () => {
  test('fire(s) and fireGroup([s]) both omit grouped= and produce identical outcome/summary shape', async () => {
    const dir = makeTempDir('cscb-prompt-test-')
    const promptPath = join(dir, 'solo.md')
    writeFileSync(promptPath, 'SOLO')

    const CHANNEL = 'C_SOLO'
    const h = makeHarness()

    // fire(s) — the single-schedule public entry.
    await h.fire(explicitSchedule(promptPath, [CHANNEL], 'cscb-cron:solo'))
    // fireGroup([s]) — the same shape, explicitly.
    await h.fireGroup([explicitSchedule(promptPath, [CHANNEL], 'cscb-cron:solo')])

    // Two POSTs, both single-contributor bodies (message === file content, plain
    // identity sender, no combined naming).
    expect(requests).toHaveLength(2)
    for (const r of requests) {
      expect(r.body.message).toBe('SOLO')
      expect(r.body.sender).toBe('cscb-cron:solo')
    }

    const lines = h.lines()
    const delivered = lines.filter((l) => l.channel === CHANNEL && l.outcome === 'delivered')
    expect(delivered).toHaveLength(2)
    // Neither path emits grouped= for a single schedule.
    for (const l of delivered) {
      expect(token(l.detail, 'grouped')).toBeUndefined()
    }

    const summaries = lines.filter((l) => l.outcome === 'summary')
    expect(summaries).toHaveLength(2)
    for (const s of summaries) {
      expect(token(s.detail, 'delivered')).toBe('1')
      expect(token(s.detail, 'failed')).toBe('0')
    }
  })
})

// ---------------------------------------------------------------------------
// 16. resolveTargets dedupe — a duplicate channel in one line's explicit list
// (operator typo `C1,C1`) targets that channel at most ONCE.
// ---------------------------------------------------------------------------

describe('duplicate channel in one schedule', () => {
  test('explicit list `C1,C1` → exactly ONE POST, plain (non-grouped) sender, one outcome, summary 1/0', async () => {
    const dir = makeTempDir('cscb-prompt-test-')
    const CHANNEL = 'C_DUP'
    const promptBody = 'dedupe me'
    const promptPath = join(dir, 'dup.md')
    writeFileSync(promptPath, promptBody)

    const h = makeHarness()
    // Same channel listed twice on one line. Without dedupe the schedule would
    // be its own second contributor to CHANNEL: two POSTs, or one grouped POST
    // with a self-doubled sender (`cscb-cron:dup+dup`).
    await h.fire(explicitSchedule(promptPath, [CHANNEL, CHANNEL], 'cscb-cron:dup'))

    // Exactly ONE POST, carrying the plain single-schedule sender (no `+dup`
    // self-doubling) and the prompt content once (no self-concatenation).
    expect(requests).toHaveLength(1)
    expect(requests[0]!.body.channel).toBe(CHANNEL)
    expect(requests[0]!.body.message).toBe(promptBody)
    expect(requests[0]!.body.sender).toBe('cscb-cron:dup')

    const lines = h.lines()

    // Exactly one delivered outcome line for the channel, with NO grouped=
    // token (single contributor after dedupe).
    const delivered = lines.filter((l) => l.channel === CHANNEL && l.outcome === 'delivered')
    expect(delivered).toHaveLength(1)
    expect(delivered[0]!.identity).toBe('cscb-cron:dup')
    expect(token(delivered[0]!.detail, 'grouped')).toBeUndefined()

    // One summary, delivered=1 failed=0 (one target, not two).
    const summaries = lines.filter((l) => l.outcome === 'summary')
    expect(summaries).toHaveLength(1)
    expect(summaries[0]!.identity).toBe('cscb-cron:dup')
    expect(token(summaries[0]!.detail, 'delivered')).toBe('1')
    expect(token(summaries[0]!.detail, 'failed')).toBe('0')
  })
})
