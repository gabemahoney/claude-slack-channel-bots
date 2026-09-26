/**
 * ci-live-container-logs.test.ts — Tests for the copy of the /ci-live test
 * container's own logs into the results (bug b.1cx, `ci-live/lib/container-logs.ts`).
 *
 * The rules under test:
 * - the files copied are CSCB's server.log and its rotated generations,
 *   startup-errors.log, cron.log and permission-trail.jsonl from the state
 *   dir the helpers call `$S`, the boot start's `~/cscb-live/boot-start.log`,
 *   and agent-director's errors.log and ad-trail.jsonl from the test user's
 *   `~/.agent-director/`, where the package, the entrypoint and
 *   agent-director write them;
 * - a file is read with one `docker exec` of a fixed script, its path and the
 *   cap as arguments; at most its last 20 MiB are read, and a copy keeps only
 *   whole lines: the partial line at a cut is dropped (so no tail of a secret
 *   survives), and so is an unterminated last line, one perhaps still being
 *   written (so no prefix of a secret survives), which is reported; a missing
 *   file is noted, a symlink or anything but a regular file is skipped, never
 *   followed;
 * - each copy goes through the redactor as one text, so a registered value
 *   spanning a line break is masked too; the copies are written mode 600 in a
 *   mode-700 `container-logs/`, beside `index.txt`, which notes each copied,
 *   cut, missing, skipped or failed file and each unterminated last line;
 * - a failure to copy one file never stops the others and never throws;
 * - the collector copies once, however many callers ask, each waiting at most
 *   its own bound on the collector's clock while the copy goes on (a later
 *   caller joins the copy in flight), and writes nothing once sealed (the
 *   closing scan).
 *
 * The container is a fake. Where the scripts' behaviour matters, the fake
 * runs the real scripts with bash against a `mkdtempSync` tree standing in
 * for the container's file system (no docker). A caller's wait runs on the
 * shared fake clock. Every secret is a sentinel-bearing fake built at
 * runtime; captured output is checked with `assertNoLeak`.
 *
 * SPDX-License-Identifier: MIT
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { DEFAULT_STORE_PATH } from '../src/agent-director-client.ts'
import { parsePersonaConfigBytes } from '../src/config.ts'
import { DRY_RUN_IDS } from '../ci-live/checks/context.ts'
import {
  collectContainerLogs,
  CONTAINER_AGENT_DIRECTOR_DIR,
  CONTAINER_CSCB_LIVE_DIR,
  CONTAINER_LOG_EXEC_TIMEOUT_MS,
  CONTAINER_LOG_MAX_BYTES,
  CONTAINER_LOGS_DIR,
  CONTAINER_LOGS_INDEX,
  CONTAINER_LOGS_URGENT_WAIT_MS,
  CONTAINER_LOGS_WAIT_MS,
  ContainerLogCollector,
  containerLogsSink,
  describeLogOutcome,
  execFailure,
  LIST_ROTATED_SCRIPT,
  MAX_ROTATED_SERVER_LOGS,
  OTHER_LOG_FILES,
  parseLogRead,
  READ_LOG_SCRIPT,
  rotatedServerLogs,
  SERVER_LOG,
  wholeLines,
  type ContainerLogsSink,
  type LogOutcome,
} from '../ci-live/lib/container-logs.ts'
import type { ExecOptions } from '../ci-live/lib/container.ts'
import { CONTAINER_HOME } from '../ci-live/lib/docker.ts'
import { buildLiveConfig, CONTAINER_STATE_DIR, renderConfig } from '../ci-live/lib/live-config.ts'
import type { ProcResult } from '../ci-live/lib/proc.ts'
import { Redactor, REDACTED_SECRET, REDACTED_TOKEN } from '../ci-live/lib/redact.ts'
import { createFakeClock } from './test-helpers/fake-clock.ts'
import { APP_TOKEN_PREFIX, assertNoLeak, BOT_TOKEN_PREFIX, fakeToken, LEAK_SENTINEL, writtenFile } from './test-helpers/credentials.ts'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const REPO = join(import.meta.dir, '..')

/** A password-like known secret (27 bytes): not token-shaped, so only the known-value rule masks it. */
const SECRET = `hunter-${LEAK_SENTINEL}-pw`
/** A known secret that spans a line break: only a redaction of the whole text sees it whole. */
const SPLIT_SECRET = `split-${LEAK_SENTINEL}\nsecret-tail`
const BOT = fakeToken(BOT_TOKEN_PREFIX, 'bot')
const APP = fakeToken(APP_TOKEN_PREFIX, 'app')

function redactor(): Redactor {
  const r = new Redactor()
  r.addSecret(SECRET)
  r.addSecret(SPLIT_SECRET)
  return r
}

function proc(code: number, stdout = '', timedOut = false): ProcResult {
  return { code, stdout, stderr: '', timedOut }
}

/** What READ_LOG_SCRIPT prints for an uncut file holding `text`. */
function readOut(text: string): ProcResult {
  return proc(0, `${Buffer.byteLength(text)} 0\n${text}`)
}

/** An in-memory sink: the copies by name, and every write in order. */
function memSink(opts: { failOn?: string } = {}): ContainerLogsSink & { files: Map<string, string>; writes: string[] } {
  const files = new Map<string, string>()
  const writes: string[] = []
  return {
    dir: '/results/container-logs',
    files,
    writes,
    write(name, content) {
      if (name === opts.failOn) throw new Error(`EACCES: permission denied, open '/results/container-logs/${name}'`)
      if (files.has(name)) throw new Error(`EEXIST: ${name}`)
      writes.push(name)
      files.set(name, content)
    },
  }
}

function memLog() {
  const lines: string[] = []
  return {
    lines,
    info: (m: string) => void lines.push(`info ${m}`),
    detail: (m: string) => void lines.push(`detail ${m}`),
    error: (m: string) => void lines.push(`error ${m}`),
  }
}

interface ExecCall {
  argv: readonly string[]
  options: ExecOptions | undefined
}

/**
 * A container whose file system is `root` on the host: every argument under
 * the container home is mapped into it, and the real scripts run with bash.
 */
function bashContainer(root: string) {
  const calls: ExecCall[] = []
  return {
    calls,
    async exec(argv: readonly string[], options?: ExecOptions): Promise<ProcResult> {
      calls.push({ argv, options })
      const mapped = argv.map((a) => (a.startsWith(`${CONTAINER_HOME}/`) ? join(root, a.slice(CONTAINER_HOME.length + 1)) : a))
      const r = Bun.spawnSync([...mapped], { stdout: 'pipe', stderr: 'pipe' })
      return proc(r.exitCode ?? 1, r.stdout.toString())
    },
  }
}

/**
 * A container with no rotated server logs, whose read of each path in `held`
 * hangs until the test releases it with that read's result; every other file
 * is not there. `calls` lists `list`, then each path read, in order.
 */
function heldContainer(held: readonly string[], answers: ReadonlyMap<string, ProcResult> = new Map()) {
  const calls: string[] = []
  const waiting = new Map<string, (r: ProcResult) => void>()
  return {
    calls,
    exec(argv: readonly string[]): Promise<ProcResult> {
      if (argv[3] === 'list') {
        calls.push('list')
        return Promise.resolve(proc(0, ''))
      }
      const path = argv[4] ?? ''
      calls.push(path)
      if (held.includes(path)) return new Promise<ProcResult>((resolve) => waiting.set(path, resolve))
      return Promise.resolve(answers.get(path) ?? proc(3))
    },
    release(path: string, r: ProcResult): void {
      const resolve = waiting.get(path)
      if (!resolve) throw new Error(`no read of ${path} is waiting`)
      waiting.delete(path)
      resolve(r)
    },
  }
}

/** The host path of a container path under the fake's root. */
function hostPath(root: string, containerPath: string): string {
  return join(root, containerPath.slice(CONTAINER_HOME.length + 1))
}

function put(root: string, containerPath: string, content: string): void {
  const path = hostPath(root, containerPath)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content)
}

const STATE = (name: string) => `${CONTAINER_STATE_DIR}/${name}`
const AD = (name: string) => `${CONTAINER_AGENT_DIRECTOR_DIR}/${name}`
const BOOT_START = `${CONTAINER_CSCB_LIVE_DIR}/boot-start.log`

let root: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ci-live-container-logs-'))
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// Which files
// ---------------------------------------------------------------------------

describe('the files copied', () => {
  test("server.log (with its rotated generations), startup-errors.log, cron.log and permission-trail.jsonl from $S, the boot start's boot-start.log, and agent-director's errors.log and ad-trail.jsonl", () => {
    expect(SERVER_LOG).toEqual({ name: 'server.log', path: STATE('server.log') })
    expect(OTHER_LOG_FILES).toEqual([
      { name: 'startup-errors.log', path: STATE('startup-errors.log') },
      { name: 'cron.log', path: STATE('cron.log') },
      { name: 'permission-trail.jsonl', path: STATE('permission-trail.jsonl') },
      { name: 'boot-start.log', path: BOOT_START },
      { name: 'agent-director-errors.log', path: AD('errors.log') },
      { name: 'agent-director-ad-trail.jsonl', path: AD('ad-trail.jsonl') },
    ])
    // Every copy has its own name.
    const names = [SERVER_LOG, ...OTHER_LOG_FILES].map((f) => f.name)
    expect(new Set(names).size).toBe(names.length)
  })

  test("the state dir is the helpers' $S under the test user's home, boot-start.log is where the entrypoint's boot start logs, and agent-director's dir is that home's ~/.agent-director, the store CSCB pins", () => {
    const helpers = readFileSync(join(REPO, 'docker', 'live', 'cscb-live-helpers.sh'), 'utf-8')
    expect(helpers).toContain('\nS=~/.claude/channels/slack\n')
    expect(CONTAINER_STATE_DIR).toBe(`${CONTAINER_HOME}/.claude/channels/slack`)
    // The boot start runs as the test user, so its $HOME is CONTAINER_HOME.
    const entrypoint = readFileSync(join(REPO, 'docker', 'live', 'entrypoint.sh'), 'utf-8')
    expect(entrypoint).toContain('claude-slack-channel-bots start >> "$HOME/cscb-live/boot-start.log" 2>&1')
    expect(CONTAINER_CSCB_LIVE_DIR).toBe(`${CONTAINER_HOME}/cscb-live`)
    expect(CONTAINER_AGENT_DIRECTOR_DIR).toBe(`${CONTAINER_HOME}/.agent-director`)
    expect(DEFAULT_STORE_PATH.replace(/^~\//, `${CONTAINER_HOME}/`)).toBe(`${CONTAINER_AGENT_DIRECTOR_DIR}/state.db`)
  })

  test("the package writes those names in the state dir, and the runner's config, loaded by the package's own loader, puts cron.log beside config.json", () => {
    const src = (f: string) => readFileSync(join(REPO, 'src', f), 'utf-8')
    expect(src('cli.ts')).toContain("join(stateDir, 'server.log')")
    expect(src('logging.ts')).toContain('renameSync(path, `${path}.1`)')
    expect(src('startup-errors.ts')).toContain("join(logDir, 'startup-errors.log')")
    expect(src('permission-trail.ts')).toContain("TRAIL_FILENAME = 'permission-trail.jsonl'")
    // config.json lives in $S, so $S is the config dir the default cron_log_path resolves against.
    const loaded = parsePersonaConfigBytes(renderConfig(buildLiveConfig(DRY_RUN_IDS)), STATE('config.json'), CONTAINER_STATE_DIR, { home: CONTAINER_HOME })
    expect(loaded.cron_log_path).toBe(join(CONTAINER_STATE_DIR, 'cron.log'))
    expect(OTHER_LOG_FILES.find((f) => f.name === 'cron.log')?.path).toBe(loaded.cron_log_path)
  })
})

// ---------------------------------------------------------------------------
// Reading one file: the script, and what its output comes to
// ---------------------------------------------------------------------------

describe('reading one file (READ_LOG_SCRIPT with bash, on a temp dir)', () => {
  const read = (path: string, cap: number) => {
    const r = Bun.spawnSync(['bash', '-c', READ_LOG_SCRIPT, 'read', path, String(cap)], { stdout: 'pipe', stderr: 'pipe' })
    return proc(r.exitCode ?? 1, r.stdout.toString())
  }

  test('a file within the cap: its size, no cut, and all of it', () => {
    writeFileSync(join(root, 'f'), 'aaaa\nbbbb\ncccc\n')
    expect(parseLogRead(read(join(root, 'f'), 100))).toEqual({ kind: 'read', size: 15, cut: 0, content: 'aaaa\nbbbb\ncccc\n' })
    expect(parseLogRead(read(join(root, 'f'), 15))).toEqual({ kind: 'read', size: 15, cut: 0, content: 'aaaa\nbbbb\ncccc\n' })
  })

  test('a file over the cap, cut inside a line: the byte before the kept part comes first, and only whole lines are kept', () => {
    writeFileSync(join(root, 'f'), 'aaaa\nbbbb\ncccc\n')
    const r = parseLogRead(read(join(root, 'f'), 7))
    expect(r).toEqual({ kind: 'read', size: 15, cut: 8, content: 'bb\ncccc\n' })
    if (r.kind !== 'read') throw new Error('unreachable')
    expect(wholeLines(r.content, r.cut)).toEqual({ text: 'cccc\n', unterminated: 0 })
  })

  test('a file over the cap, cut exactly at a line start: that whole line is kept', () => {
    writeFileSync(join(root, 'f'), 'aaaa\nbbbb\ncccc\n')
    const r = parseLogRead(read(join(root, 'f'), 10))
    expect(r).toEqual({ kind: 'read', size: 15, cut: 5, content: '\nbbbb\ncccc\n' })
    if (r.kind !== 'read') throw new Error('unreachable')
    expect(wholeLines(r.content, r.cut)).toEqual({ text: 'bbbb\ncccc\n', unterminated: 0 })
  })

  test('at most the cap is kept, whatever the size', () => {
    const line = `${'x'.repeat(48)}\n`
    writeFileSync(join(root, 'f'), line.repeat(1000))
    const r = parseLogRead(read(join(root, 'f'), 1234))
    if (r.kind !== 'read') throw new Error(`not read: ${JSON.stringify(r)}`)
    const kept = wholeLines(r.content, r.cut).text
    expect([r.size, r.cut, kept.length <= 1234, kept.startsWith(line), kept.endsWith(line)]).toEqual([49_000, 49_000 - 1234, true, true, true])
  })

  test('missing: exit 3; a symlink (to a regular file too), a directory: exit 4, never followed', () => {
    writeFileSync(join(root, 'real'), `${SECRET}\n`)
    symlinkSync(join(root, 'real'), join(root, 'link'))
    symlinkSync(join(root, 'nowhere'), join(root, 'dangling'))
    mkdirSync(join(root, 'dir'))
    const outcomes = ['missing', 'link', 'dangling', 'dir'].map((f) => read(join(root, f), 100))
    expect(outcomes.map((r) => r.code)).toEqual([3, 4, 4, 4])
    expect(outcomes.map((r) => r.stdout)).toEqual(['', '', '', ''])
    expect(outcomes.map((r) => parseLogRead(r).kind)).toEqual(['missing', 'skipped', 'skipped', 'skipped'])
  })

  test('the path and the cap are arguments: a path with spaces, quotes or $ is read as it is, never run', () => {
    const odd = join(root, 'a "b" $(touch pwned) c')
    writeFileSync(odd, 'ok\n')
    expect(parseLogRead(read(odd, 100))).toEqual({ kind: 'read', size: 3, cut: 0, content: 'ok\n' })
    expect(readdirSync(root)).not.toContain('pwned')
  })
})

describe('parseLogRead', () => {
  test.each([
    ['not there', proc(3), { kind: 'missing' }],
    ['not a regular file', proc(4), { kind: 'skipped', reason: 'not a regular file (a symlink is never followed)' }],
    ['not readable', proc(6), { kind: 'skipped', reason: 'not readable by the test user' }],
    ['no size', proc(5), { kind: 'failed', reason: 'docker exec exit 5' }],
    ['docker failed (the container is gone)', proc(1), { kind: 'failed', reason: 'docker exec exit 1' }],
    ['timed out', proc(124, '12 0\npartial', true), { kind: 'failed', reason: 'docker exec timed out' }],
    ['no size line at all', proc(0, ''), { kind: 'failed', reason: 'no size line' }],
    ['a size line that is not two numbers', proc(0, '12 x\nabc'), { kind: 'failed', reason: 'no size line' }],
    ['a cut past the size', proc(0, '5 9\nabc'), { kind: 'failed', reason: 'a cut past the size' }],
    ['an empty file', proc(0, '0 0\n'), { kind: 'read', size: 0, cut: 0, content: '' }],
  ] as const)('%s', (_what, r, expected) => {
    expect(parseLogRead(r)).toEqual(expected as never)
  })

  test("a stopped or removed container is named as such, docker's own message never echoed", () => {
    const withStderr = (code: number, stderr: string): ProcResult => ({ code, stdout: '', stderr, timedOut: false })
    const notRunning = withStderr(1, `Error response from daemon: container 0123abc is not running ${SECRET}`)
    const gone = withStderr(1, `Error response from daemon: No such container: cscb-live-1-2 ${SECRET}`)
    expect([parseLogRead(notRunning), parseLogRead(gone)]).toEqual([
      { kind: 'failed', reason: 'the container is not running (docker exec exit 1)' },
      { kind: 'failed', reason: 'the container is gone (docker exec exit 1)' },
    ])
    expect(execFailure(withStderr(126, `OCI runtime exec failed ${SECRET}`))).toBe('docker exec exit 126')
  })
})

describe('wholeLines', () => {
  test('no cut: every line; a cut: up to the first line break dropped, the tail of a secret the cut split with it; no line break at all: nothing', () => {
    expect(wholeLines('a\nb\n', 0)).toEqual({ text: 'a\nb\n', unterminated: 0 })
    // The tail holds the sentinel, and no redactor would recognise it: it goes with its partial line.
    const tail = SECRET.slice(3)
    const cut = wholeLines(`${tail} and more\nwhole\n`, 3)
    expect(cut).toEqual({ text: 'whole\n', unterminated: 0 })
    assertNoLeak(cut)
    expect(wholeLines('\nwhole\n', 3)).toEqual({ text: 'whole\n', unterminated: 0 })
    expect(wholeLines('one long line cut in the middle', 3)).toEqual({ text: '', unterminated: 0 })
  })

  test('an unterminated last line is left out and its bytes counted, with and without a cut, so no prefix of a secret is kept', () => {
    // A prefix of the secret (24 bytes) holds the sentinel; the redactor knows only the whole value.
    const prefix = SECRET.slice(0, -3)
    const kept = [
      wholeLines(`a\nb\n${prefix}`, 0),
      wholeLines(`tail\nkept\n${prefix}`, 3),
      wholeLines(prefix, 0),
      wholeLines(`tail\n${prefix}`, 3),
    ]
    expect(kept).toEqual([
      { text: 'a\nb\n', unterminated: 24 },
      { text: 'kept\n', unterminated: 24 },
      { text: '', unterminated: 24 },
      { text: '', unterminated: 24 },
    ])
    assertNoLeak(kept)
    // Counted in bytes, not characters.
    expect(wholeLines('a\ncafé', 0)).toEqual({ text: 'a\n', unterminated: 5 })
  })
})

describe('rotatedServerLogs', () => {
  test('numbered generations in order, the newest (server.log.1) first, then another suffix by name; duplicates and blank lines ignored', () => {
    const r = rotatedServerLogs('server.log.10\nserver.log.2\n\nserver.log.bak\nserver.log.1\nserver.log.2\n')
    expect(r.files.map((f) => f.name)).toEqual(['server.log.1', 'server.log.2', 'server.log.10', 'server.log.bak'])
    expect(r.files[0]).toEqual({ name: 'server.log.1', path: STATE('server.log.1') })
    expect([r.unexpected, r.beyondCap]).toEqual([0, 0])
  })

  test('a name that is not a plain server.log.<suffix> is counted, never copied', () => {
    const r = rotatedServerLogs('server.log.\nserver.log.a b\nserver.log../x\nserver.log.1\nother.log\n')
    expect(r.files.map((f) => f.name)).toEqual(['server.log.1'])
    expect(r.unexpected).toBe(4)
  })

  test(`at most ${MAX_ROTATED_SERVER_LOGS} generations, the newest; the rest counted`, () => {
    const listed = Array.from({ length: MAX_ROTATED_SERVER_LOGS + 2 }, (_, i) => `server.log.${i + 1}`).reverse().join('\n')
    const r = rotatedServerLogs(listed)
    expect(r.files.map((f) => f.name)).toEqual(Array.from({ length: MAX_ROTATED_SERVER_LOGS }, (_, i) => `server.log.${i + 1}`))
    expect(r.beyondCap).toBe(2)
  })

  test('LIST_ROTATED_SCRIPT lists every server.log.* entry (a symlink included, for the read to skip), and nothing for a missing dir', () => {
    writeFileSync(join(root, 'server.log'), 'a\n')
    writeFileSync(join(root, 'server.log.1'), 'b\n')
    symlinkSync(join(root, 'server.log'), join(root, 'server.log.2'))
    symlinkSync(join(root, 'nowhere'), join(root, 'server.log.3'))
    const list = (dir: string) => Bun.spawnSync(['bash', '-c', LIST_ROTATED_SCRIPT, 'list', dir], { stdout: 'pipe' })
    const r = list(root)
    expect([r.exitCode, r.stdout.toString()]).toEqual([0, 'server.log.1\nserver.log.2\nserver.log.3\n'])
    const none = list(join(root, 'missing'))
    expect([none.exitCode, none.stdout.toString()]).toEqual([0, ''])
  })
})

// ---------------------------------------------------------------------------
// The copy
// ---------------------------------------------------------------------------

describe('collectContainerLogs', () => {
  /** One 42-byte cron.log line holding the secret. */
  const cronLine = (n: number) => `cron line ${String(n).padStart(3, '0')} ${SECRET}\n`

  /**
   * A container tree with every kind of file: a secret in server.log, the
   * trail and boot-start.log, a symlink, a cron.log of 40 lines (1680 bytes)
   * over a 200-byte cap, a missing startup-errors.log.
   */
  function seed(): void {
    put(root, STATE('server.log'), `line one ${SECRET}\ntoken ${BOT}\n`)
    put(root, STATE('server.log.1'), `rotated ${APP}\n`)
    put(root, STATE('permission-trail.jsonl'), `{"raw_error_message":"${SECRET}"}\n`)
    put(root, STATE('cron.log'), Array.from({ length: 40 }, (_, i) => cronLine(i)).join(''))
    put(root, BOOT_START, `boot start ${SECRET}\n`)
    put(root, AD('errors.log'), '')
    put(root, AD('ad-trail.jsonl'), '{"event":"ad.spawn"}\n')
    symlinkSync(hostPath(root, `${CONTAINER_HOME}/.config/cscb/persona_a-credentials.json`), hostPath(root, STATE('server.log.2')))
    put(root, `${CONTAINER_HOME}/.config/cscb/persona_a-credentials.json`, `{"bot_token":"${BOT}"}\n`)
  }

  test('copies each file redacted (boot-start.log included), notes the cut, the missing and the skipped file, and writes index.txt last', async () => {
    seed()
    const container = bashContainer(root)
    const sink = memSink()
    const outcomes = await collectContainerLogs({ container, redactor: redactor(), sink, writable: () => true, maxBytes: 200 })
    expect(outcomes.map((o) => [o.name, o.status])).toEqual([
      ['server.log', 'copied'],
      ['server.log.1', 'copied'],
      ['server.log.2', 'skipped'],
      ['startup-errors.log', 'missing'],
      ['cron.log', 'copied'],
      ['permission-trail.jsonl', 'copied'],
      ['boot-start.log', 'copied'],
      ['agent-director-errors.log', 'copied'],
      ['agent-director-ad-trail.jsonl', 'copied'],
    ])
    expect(sink.writes).toEqual([
      'server.log',
      'server.log.1',
      'cron.log',
      'permission-trail.jsonl',
      'boot-start.log',
      'agent-director-errors.log',
      'agent-director-ad-trail.jsonl',
      CONTAINER_LOGS_INDEX,
    ])
    expect(sink.files.get('server.log')).toBe(`line one ${REDACTED_SECRET}\ntoken ${REDACTED_TOKEN}\n`)
    expect(sink.files.get('server.log.1')).toBe(`rotated ${REDACTED_TOKEN}\n`)
    expect(sink.files.get('permission-trail.jsonl')).toBe(`{"raw_error_message":"${REDACTED_SECRET}"}\n`)
    expect(sink.files.get('boot-start.log')).toBe(`boot start ${REDACTED_SECRET}\n`)
    expect(sink.files.get('agent-director-ad-trail.jsonl')).toBe('{"event":"ad.spawn"}\n')
    // cron.log: the 200-byte cap starts 10 bytes into line 35 (byte 1480), so lines 36 to 39 are kept: 4 × 42 = 168 bytes.
    expect(sink.files.get('cron.log')).toBe([36, 37, 38, 39].map((n) => `cron line 0${n} ${REDACTED_SECRET}\n`).join(''))
    const cron = outcomes.find((o) => o.name === 'cron.log')
    expect(cron).toEqual({ name: 'cron.log', path: STATE('cron.log'), status: 'copied', size: 1680, kept: 168, cut: true, cap: 200, unterminated: 0 })
    // Nothing of the symlink's target, anywhere.
    assertNoLeak([...sink.files.values()])
    // index.txt: its header, then one line per outcome, in order.
    const index = (sink.files.get(CONTAINER_LOGS_INDEX) ?? '').split('\n')
    expect(index[0]).toBe(
      "The test container's own logs, copied before it was removed or stopped: each redacted, each file at most its last 200 B, whole lines only (a partial first line at a cut and an unterminated last line left out).",
    )
    expect(index.slice(1)).toEqual([...outcomes.map(describeLogOutcome), ''])
    expect(index).toContain(`server.log: copied, ${Buffer.byteLength(`line one ${SECRET}\ntoken ${BOT}\n`)} bytes (${STATE('server.log')})`)
    expect(index).toContain(`server.log.2: skipped: not a regular file (a symlink is never followed) (${STATE('server.log.2')})`)
    expect(index).toContain(`startup-errors.log: not there (${STATE('startup-errors.log')})`)
    expect(index).toContain(`cron.log: cut: its last 168 B (168 of 1680 bytes), from the first whole line within the 200 B cap (${STATE('cron.log')})`)
  })

  test('an unterminated last line (one perhaps still being written) is left out and reported, with and without a cut; no prefix of a secret is kept', async () => {
    // A prefix of the secret: it holds the sentinel, and the redactor knows only the whole value.
    const midWrite = `mid-write ${SECRET.slice(0, -3)}`
    put(root, STATE('server.log'), `whole line\n${midWrite}`)
    put(root, STATE('cron.log'), `${'x'.repeat(40)}\nkept line\n${midWrite}`)
    const sink = memSink()
    const outcomes = await collectContainerLogs({ container: bashContainer(root), redactor: redactor(), sink, writable: () => true, maxBytes: 60 })
    // server.log: 45 bytes, within the cap. cron.log: 85 bytes, cut 25 bytes into its first line.
    expect([sink.files.get('server.log'), sink.files.get('cron.log')]).toEqual(['whole line\n', 'kept line\n'])
    expect(outcomes.filter((o) => o.status === 'copied')).toEqual([
      { ...SERVER_LOG, status: 'copied', size: 45, kept: 11, cut: false, cap: 60, unterminated: 34 },
      { name: 'cron.log', path: STATE('cron.log'), status: 'copied', size: 85, kept: 10, cut: true, cap: 60, unterminated: 34 },
    ])
    const index = sink.files.get(CONTAINER_LOGS_INDEX) ?? ''
    expect(index).toContain(`server.log: copied, 11 bytes; its unterminated last line (34 bytes, perhaps still being written) left out (${STATE('server.log')})`)
    expect(index).toContain(
      `cron.log: cut: its last 10 B (10 of 85 bytes), from the first whole line within the 60 B cap; its unterminated last line (34 bytes, perhaps still being written) left out (${STATE('cron.log')})`,
    )
    assertNoLeak([...sink.files.values()])
  })

  test('each copy is redacted as one text: a registered value spanning a line break is masked whole', async () => {
    const text = `before\nkey: ${SPLIT_SECRET}\nafter ${BOT}\n`
    put(root, STATE('server.log'), text)
    const sink = memSink()
    await collectContainerLogs({ container: bashContainer(root), redactor: redactor(), sink, writable: () => true })
    expect(sink.files.get('server.log')).toBe(`before\nkey: ${REDACTED_SECRET}\nafter ${REDACTED_TOKEN}\n`)
    assertNoLeak([...sink.files.values()])
    // The control: redacted a line at a time, the value's first half would stay.
    const r = redactor()
    expect(text.split('\n').map((l) => r.redact(l)).join('\n')).toContain(LEAK_SENTINEL)
  })

  test('every read is the fixed script as the test user, with the path and the cap as arguments and a time limit; the default cap is 20 MiB', async () => {
    seed()
    const container = bashContainer(root)
    await collectContainerLogs({ container, redactor: redactor(), sink: memSink(), writable: () => true })
    const [list, ...reads] = container.calls
    expect(list?.argv).toEqual(['bash', '-c', LIST_ROTATED_SCRIPT, 'list', CONTAINER_STATE_DIR])
    const read = [SERVER_LOG.path, STATE('server.log.1'), STATE('server.log.2'), ...OTHER_LOG_FILES.map((f) => f.path)]
    expect(reads.map((c) => c.argv)).toEqual(read.map((path) => ['bash', '-c', READ_LOG_SCRIPT, 'read', path, String(CONTAINER_LOG_MAX_BYTES)]))
    expect(CONTAINER_LOG_MAX_BYTES).toBe(20 * 1024 * 1024)
    // No user given: TestContainer.exec runs it as the test user.
    expect(container.calls.map((c) => c.options)).toEqual(container.calls.map(() => ({ timeoutMs: CONTAINER_LOG_EXEC_TIMEOUT_MS })))
  })

  test('a file that fails (a throw, a docker failure, a timeout) is noted and the others are still copied; nothing throws', async () => {
    const container = {
      async exec(argv: readonly string[]): Promise<ProcResult> {
        const path = argv[4] ?? ''
        if (argv[3] === 'list') return proc(0, 'server.log.1\n')
        if (path.endsWith('/server.log')) throw new Error(`spawn failed near ${SECRET}`)
        if (path.endsWith('/server.log.1')) return proc(124, '', true)
        if (path.endsWith('/cron.log')) return proc(1)
        return readOut('ok\n')
      },
    }
    const sink = memSink()
    const outcomes = await collectContainerLogs({ container, redactor: redactor(), sink, writable: () => true })
    const failed = outcomes.filter((o): o is Extract<LogOutcome, { reason: string }> => o.status === 'failed')
    expect(failed.map((o) => [o.name, o.reason.replace(SECRET, '<the secret>')])).toEqual([
      ['server.log', 'Error: spawn failed near <the secret>'],
      ['server.log.1', 'docker exec timed out'],
      ['cron.log', 'docker exec exit 1'],
    ])
    expect(sink.writes).toEqual(['startup-errors.log', 'permission-trail.jsonl', 'boot-start.log', 'agent-director-errors.log', 'agent-director-ad-trail.jsonl', CONTAINER_LOGS_INDEX])
    // The index goes through the redactor too.
    assertNoLeak(sink.files.get(CONTAINER_LOGS_INDEX))
  })

  test('a rotated list that fails is noted; the other files are still copied', async () => {
    const container = { exec: async (argv: readonly string[]) => (argv[3] === 'list' ? proc(125) : proc(3)) }
    const outcomes = await collectContainerLogs({ container, redactor: redactor(), sink: memSink(), writable: () => true })
    expect(outcomes.at(-1)).toEqual({ name: 'server.log.*', path: STATE('server.log.*'), status: 'failed', reason: 'the rotated server logs could not be listed (docker exec exit 125)' })
    expect(outcomes.filter((o) => o.status === 'missing').length).toBe(1 + OTHER_LOG_FILES.length)
  })

  test('unexpected names and generations past the cap are noted, not copied', async () => {
    const listed = [...Array.from({ length: MAX_ROTATED_SERVER_LOGS + 1 }, (_, i) => `server.log.${i + 1}`), 'server.log.x y'].join('\n')
    const container = { exec: async (argv: readonly string[]) => (argv[3] === 'list' ? proc(0, listed) : proc(3)) }
    const outcomes = await collectContainerLogs({ container, redactor: redactor(), sink: memSink(), writable: () => true })
    expect(outcomes.filter((o) => o.name === 'server.log.*')).toEqual([
      { name: 'server.log.*', path: STATE('server.log.*'), status: 'skipped', reason: '1 entry not named server.log.<generation>' },
      { name: 'server.log.*', path: STATE('server.log.*'), status: 'skipped', reason: `1 generation(s) past the newest ${MAX_ROTATED_SERVER_LOGS}` },
    ])
  })

  test('a copy that cannot be written is noted; the others and the index are still written', async () => {
    seed()
    const sink = memSink({ failOn: 'server.log' })
    const outcomes = await collectContainerLogs({ container: bashContainer(root), redactor: redactor(), sink, writable: () => true })
    expect(outcomes.find((o) => o.name === 'server.log')).toMatchObject({ status: 'failed', reason: expect.stringContaining('could not be written: Error: EACCES') })
    expect(sink.writes).toContain('cron.log')
    expect(sink.writes.at(-1)).toBe(CONTAINER_LOGS_INDEX)
  })

  test('nothing is written once it is no longer writable (the closing scan has begun), not even the index', async () => {
    seed()
    const sink = memSink()
    let open = true
    const container = bashContainer(root)
    const wrapped = {
      exec: async (argv: readonly string[], options?: ExecOptions) => {
        const r = await container.exec(argv, options)
        if (argv[4] === STATE('server.log.1')) open = false
        return r
      },
    }
    const outcomes = await collectContainerLogs({ container: wrapped, redactor: redactor(), sink, writable: () => open })
    expect(sink.writes).toEqual(['server.log'])
    expect(outcomes.filter((o) => o.status === 'failed').map((o) => o.name)).toEqual(['server.log.1', 'server.log.2', ...OTHER_LOG_FILES.map((f) => f.name)])
    // No read once closed.
    expect(container.calls.length).toBe(3)
  })
})

// ---------------------------------------------------------------------------
// One copy per run
// ---------------------------------------------------------------------------

describe('ContainerLogCollector', () => {
  const NOT_ALL_COPIED = (s: number) => `error container logs: not all copied within ${s} s; going on without them (what is copied before the results are written is kept)`
  const STILL_COPYING = `error container logs: still copying when the results were written; nothing more is copied (${CONTAINER_LOGS_DIR}/ holds what was)`

  test('copies once, however many callers ask; logs a summary (stdout and run.log) and one line per file (run.log), none leaking', async () => {
    put(root, STATE('server.log'), `x ${SECRET}\n`)
    const container = bashContainer(root)
    const log = memLog()
    const sink = memSink()
    const collector = new ContainerLogCollector({ redactor: redactor(), sink, log, clock: createFakeClock() })
    await Promise.all([collector.collect(container, CONTAINER_LOGS_WAIT_MS), collector.collect(container, CONTAINER_LOGS_WAIT_MS)])
    await collector.collect(container, CONTAINER_LOGS_WAIT_MS)
    expect(container.calls.filter((c) => c.argv[3] === 'list').length).toBe(1)
    const outcomes = collector.outcomes ?? []
    expect(outcomes.length).toBe(1 + OTHER_LOG_FILES.length)
    expect(log.lines).toEqual([
      `info container logs: 1 copied, ${OTHER_LOG_FILES.length} not there, 0 skipped, 0 not copied, in ${sink.dir} (${CONTAINER_LOGS_INDEX} lists each)`,
      ...outcomes.map((o) => `detail container logs: ${describeLogOutcome(o)}`),
    ])
    assertNoLeak(log.lines)
  })

  test('no container started: nothing to copy, said once', async () => {
    const log = memLog()
    const sink = memSink()
    const collector = new ContainerLogCollector({ redactor: redactor(), sink, log, clock: createFakeClock() })
    await collector.collect(null, CONTAINER_LOGS_WAIT_MS)
    await collector.collect(null, CONTAINER_LOGS_WAIT_MS)
    expect([log.lines, sink.writes, collector.outcomes]).toEqual([['info container logs: none to copy (no test container was started)'], [], null])
  })

  test("a caller waits at most its bound on the clock (a memory watchdog stop's 15 s); the copy goes on, writing each file it finishes, and a later caller joins it (no second list)", async () => {
    const container = heldContainer([SERVER_LOG.path, STATE('cron.log')])
    const log = memLog()
    const sink = memSink()
    const clock = createFakeClock()
    const collector = new ContainerLogCollector({ redactor: redactor(), sink, log, clock })
    let returned = false
    const first = collector.collect(container, CONTAINER_LOGS_URGENT_WAIT_MS).then(() => {
      returned = true
    })
    await clock.advance(CONTAINER_LOGS_URGENT_WAIT_MS - 1)
    expect([returned, clock.pending().map((t) => t.delayMs)]).toEqual([false, [CONTAINER_LOGS_URGENT_WAIT_MS]])
    await clock.advance(1)
    expect(returned).toBe(true)
    await first
    expect([log.lines, sink.writes, collector.outcomes, clock.pendingCount()]).toEqual([[NOT_ALL_COPIED(15)], [], null, 0])
    // The hung read answers after the caller stopped waiting: the copy goes on and writes it.
    container.release(SERVER_LOG.path, readOut(`late ${SECRET}\n`))
    await clock.flush()
    expect(sink.writes).toEqual(['server.log'])
    // A later caller waits for that same copy, on its own bound.
    let joined = false
    const second = collector.collect(container, CONTAINER_LOGS_WAIT_MS).then(() => {
      joined = true
    })
    await clock.flush()
    expect([joined, clock.pending().map((t) => t.delayMs)]).toEqual([false, [CONTAINER_LOGS_WAIT_MS]])
    container.release(STATE('cron.log'), readOut('cron\n'))
    await clock.flush()
    expect(joined).toBe(true)
    await second
    // One list and one read per file, however many callers.
    expect(container.calls).toEqual(['list', SERVER_LOG.path, ...OTHER_LOG_FILES.map((f) => f.path)])
    expect(sink.writes).toEqual(['server.log', 'cron.log', CONTAINER_LOGS_INDEX])
    expect(sink.files.get('server.log')).toBe(`late ${REDACTED_SECRET}\n`)
    expect(log.lines.filter((l) => l.startsWith('error '))).toEqual([NOT_ALL_COPIED(15)])
    expect(log.lines[1]).toBe(`info container logs: 2 copied, ${OTHER_LOG_FILES.length - 1} not there, 0 skipped, 0 not copied, in ${sink.dir} (${CONTAINER_LOGS_INDEX} lists each)`)
    expect(clock.pendingCount()).toBe(0)
    assertNoLeak([log.lines, [...sink.files.values()]])
  })

  test('a file finished before the seal is kept; once sealed, a copy still going writes and logs nothing more', async () => {
    const container = heldContainer([STATE('startup-errors.log')], new Map([[SERVER_LOG.path, readOut('early\n')]]))
    const log = memLog()
    const sink = memSink()
    const clock = createFakeClock()
    const collector = new ContainerLogCollector({ redactor: redactor(), sink, log, clock })
    const first = collector.collect(container, CONTAINER_LOGS_URGENT_WAIT_MS)
    await clock.advance(CONTAINER_LOGS_URGENT_WAIT_MS)
    await first
    expect([sink.writes, log.lines]).toEqual([['server.log'], [NOT_ALL_COPIED(15)]])
    collector.seal()
    expect(log.lines).toEqual([NOT_ALL_COPIED(15), STILL_COPYING])
    // The hung read comes back after the seal: nothing more is written or logged, not even the index.
    container.release(STATE('startup-errors.log'), readOut('late\n'))
    await clock.flush()
    await collector.collect(container, CONTAINER_LOGS_WAIT_MS)
    expect([sink.writes, log.lines.length, container.calls.filter((c) => c === 'list').length]).toEqual([['server.log'], 2, 1])
  })

  test('sealed before any copy: collect does nothing', async () => {
    const container = bashContainer(root)
    const log = memLog()
    const collector = new ContainerLogCollector({ redactor: redactor(), sink: memSink(), log, clock: createFakeClock() })
    collector.seal()
    await collector.collect(container, CONTAINER_LOGS_WAIT_MS)
    expect([container.calls.length, log.lines]).toEqual([0, []])
  })
})

// ---------------------------------------------------------------------------
// The real sink
// ---------------------------------------------------------------------------

describe('containerLogsSink (real file system)', () => {
  test('writes into <results>/container-logs/, the dir mode 700 and each copy mode 600; never over a copy; only a plain name', () => {
    const sink = containerLogsSink(root)
    expect(sink.dir).toBe(join(root, CONTAINER_LOGS_DIR))
    sink.write('server.log', 'a\n')
    sink.write('server.log.1', 'b\n')
    expect(statSync(sink.dir).mode & 0o777).toBe(0o700)
    expect(['server.log', 'server.log.1'].map((f) => statSync(join(sink.dir, f)).mode & 0o777)).toEqual([0o600, 0o600])
    expect(readFileSync(join(sink.dir, 'server.log'), 'utf-8')).toBe('a\n')
    expect(() => sink.write('server.log', 'again\n')).toThrow()
    for (const bad of ['../x', 'a/b', '.hidden', '', `${'a'.repeat(101)}`]) expect(() => sink.write(bad, 'x')).toThrow('a container log copy needs a plain file name')
    expect(readdirSync(sink.dir).sort()).toEqual(['server.log', 'server.log.1'])
  })

  test('end to end on the real file system: a collector with the real sink (and its default clock) leaves only redacted copies', async () => {
    put(root, STATE('server.log'), `x ${SECRET} ${BOT}\n`)
    const results = join(root, 'results')
    mkdirSync(results, { mode: 0o700 })
    // The default (real) clock: the copy settles long before the bound, whose timer is then cleared, so nothing waits in real time.
    const collector = new ContainerLogCollector({ redactor: redactor(), sink: containerLogsSink(results), log: memLog() })
    await collector.collect(bashContainer(root), CONTAINER_LOGS_WAIT_MS)
    const dir = join(results, CONTAINER_LOGS_DIR)
    expect(readdirSync(dir).sort()).toEqual([CONTAINER_LOGS_INDEX, 'server.log'])
    expect(readFileSync(join(dir, 'server.log'), 'utf-8')).toBe(`x ${REDACTED_SECRET} ${REDACTED_TOKEN}\n`)
    assertNoLeak(writtenFile(dir))
  })
})
