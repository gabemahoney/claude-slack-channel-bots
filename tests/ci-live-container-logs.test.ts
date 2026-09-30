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
 *   closing scan);
 * - for each persona A–D, first, before the logs, its tmux pane when `tmux
 *   ls` lists its session `slack_bot_<key>` (`tmux capture-pane -p -J -S
 *   -200`, read only), and after the logs the tail of its Claude transcript:
 *   the newest regular `*.jsonl` directly in the Claude Code project dir of
 *   its working directory (the slug derived as Claude Code derives it), its
 *   last 200 whole lines; each at most its last 2 MiB, whole lines only,
 *   redacted also across Claude Code's own hard wraps (every piece of a
 *   token or registered value a row break with indentation or a border
 *   split, and every 10-character fragment of a registered value), and noted
 *   in `index.txt` as copied, cut, not there or skipped;
 * - a tmux exec gets at most 5 s, and once `tmux ls` or a capture times out
 *   no further pane is captured, so a stuck tmux can't crowd the logs out.
 *
 * The container is a fake. Where the scripts' behaviour matters, the fake
 * runs the real scripts with bash against a `mkdtempSync` tree standing in
 * for the container's file system (no docker), with a fake `tmux` first on
 * PATH that answers from files in another temp dir (the host's tmux, and its
 * production sessions, are never reached). Every bash child gets its
 * environment from `hostSafeChildEnv`: a temp HOME, only the tools the
 * scripts name, and no agent-director on PATH. A caller's wait runs on the
 * shared fake clock. Every secret is a sentinel-bearing fake built at
 * runtime; captured output is checked with `assertNoLeak`.
 *
 * SPDX-License-Identifier: MIT
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { DEFAULT_STORE_PATH } from '../src/agent-director-client.ts'
import { parsePersonaConfigBytes } from '../src/config.ts'
import { expandTilde, personaKey, personaTmuxSessionName } from '../src/persona-identity.ts'
import { DRY_RUN_IDS } from '../ci-live/checks/context.ts'
import {
  CAPTURE_PANE_SCRIPT,
  capturePaneArgv,
  claudeProjectSlug,
  collectContainerLogs,
  CONTAINER_AGENT_DIRECTOR_DIR,
  CONTAINER_CLAUDE_PROJECTS_DIR,
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
  indexHeader,
  lastLines,
  LIST_ROTATED_SCRIPT,
  listRotatedArgv,
  LIST_SESSIONS_SCRIPT,
  listSessionsArgv,
  MAX_ROTATED_SERVER_LOGS,
  OTHER_LOG_FILES,
  PANE_HISTORY_LINES,
  parseLogRead,
  parsePaneRead,
  parseSessionList,
  parseTranscriptRead,
  PERSONA_CAPTURES,
  READ_LOG_SCRIPT,
  READ_TRANSCRIPT_SCRIPT,
  readTranscriptArgv,
  rotatedServerLogs,
  SERVER_LOG,
  SESSION_CAPTURE_MAX_BYTES,
  summarizeLogOutcomes,
  TMUX_EXEC_TIMEOUT_MS,
  TRANSCRIPT_TAIL_LINES,
  wholeLines,
  type ContainerLogsSink,
  type LogOutcome,
  type PersonaCapture,
} from '../ci-live/lib/container-logs.ts'
import type { ExecOptions } from '../ci-live/lib/container.ts'
import { CONTAINER_HOME } from '../ci-live/lib/docker.ts'
import { buildLiveConfig, CONTAINER_STATE_DIR, personaEntryFor, renderConfig } from '../ci-live/lib/live-config.ts'
import { PERSONA_LETTERS, personaName } from '../ci-live/lib/personas.ts'
import { hostSafeChildEnv } from './test-helpers/host-safe-env.ts'
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

function proc(code: number, stdout = '', timedOut = false, stderr = ''): ProcResult {
  return { code, stdout, stderr, timedOut }
}

/** What the container's `tmux ls` answers when no tmux server runs there. */
const NO_TMUX_SERVER = proc(1, '', false, 'no server running on /tmp/tmux-1000/default\n')

/**
 * A fake container's answer to the pane and transcript reads when the
 * container has no tmux server and no transcript: `null` for any other exec.
 */
function noSessions(argv: readonly string[]): ProcResult | null {
  if (argv[3] === 'sessions') return NO_TMUX_SERVER
  if (argv[3] === 'transcript' || argv[3] === 'pane') return proc(3)
  return null
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
 * A fake `tmux`, first on PATH wherever the real scripts run with bash: `ls`
 * prints `$FAKE_TMUX/sessions` (no such file: no server running, exit 1);
 * `has-session -t S` succeeds when `$FAKE_TMUX/pane-S` exists;
 * `capture-pane … -t S` prints that file (`$FAKE_TMUX/capture-fails`: exit
 * 1). Every call's arguments are appended to `$FAKE_TMUX/calls`. Any other
 * subcommand exits 64: nothing here can change a session.
 */
const FAKE_TMUX = [
  '#!/bin/bash',
  'd=$FAKE_TMUX',
  'printf \'%s\\n\' "$*" >> "$d/calls"',
  's=\'\'; prev=\'\'; for a in "$@"; do [ "$prev" = -t ] && s=$a; prev=$a; done',
  'case "$1" in',
  '  ls) if [ -e "$d/sessions" ]; then cat "$d/sessions"; else echo "no server running on /tmp/tmux-fake/default" >&2; exit 1; fi ;;',
  '  has-session) [ -e "$d/pane-$s" ] ;;',
  '  capture-pane) if [ -e "$d/capture-fails" ] || [ ! -e "$d/pane-$s" ]; then exit 1; fi; cat "$d/pane-$s" ;;',
  '  *) exit 64 ;;',
  'esac',
  '',
].join('\n')

/** A temp dir holding the fake tmux (`bin/tmux`), its answers and its calls; also the scripts' TMPDIR. */
function makeTmuxDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ci-live-fake-tmux-'))
  mkdirSync(join(dir, 'bin'))
  writeFileSync(join(dir, 'bin', 'tmux'), FAKE_TMUX)
  chmodSync(join(dir, 'bin', 'tmux'), 0o755)
  return dir
}

/**
 * The tools the real scripts (and the fake tmux) run by name, for
 * `hostSafeChildEnv`; the fake tmux's dir goes first on PATH as a `pathDirs`
 * entry, so every tmux call reaches the fake.
 */
const SCRIPT_TOOLS: readonly string[] = ['bash', 'cat', 'head', 'mktemp', 'rm', 'stat', 'tail']

/** The fake tmux's `pathDirs` entry: its `bin`, first on the scripts' PATH. */
function tmuxBin(tmux: string): string {
  return join(tmux, 'bin')
}

/** The extras a real script runs with here: the fake tmux's dir, and its temp files in that dir. */
function scriptExtras(tmux: string): Record<string, string> {
  return { FAKE_TMUX: tmux, TMPDIR: tmux, LANG: 'C.UTF-8' }
}

/** The fake tmux's calls, one argument string per call. */
function tmuxCalls(tmux: string): string[] {
  try {
    return readFileSync(join(tmux, 'calls'), 'utf-8').split('\n').filter(Boolean)
  } catch {
    return []
  }
}

/** Give the fake tmux these sessions, each with a pane (`null`: listed, but gone by the capture). */
function tmuxSessions(tmux: string, panes: Record<string, string | null>): void {
  writeFileSync(join(tmux, 'sessions'), Object.keys(panes).map((s) => `${s}\n`).join(''))
  for (const [session, pane] of Object.entries(panes)) if (pane !== null) writeFileSync(join(tmux, `pane-${session}`), pane)
}

/**
 * A container whose file system is `root` on the host: every argument under
 * the container home is mapped into it, and the real scripts run with bash,
 * the fake tmux (in `tmux`) first on PATH, under the test's temp `home`.
 */
function bashContainer(root: string, tmux: string) {
  const calls: ExecCall[] = []
  return {
    calls,
    async exec(argv: readonly string[], options?: ExecOptions): Promise<ProcResult> {
      calls.push({ argv, options })
      const mapped = argv.map((a) => (a.startsWith(`${CONTAINER_HOME}/`) ? join(root, a.slice(CONTAINER_HOME.length + 1)) : a))
      const r = Bun.spawnSync([...mapped], {
        stdout: 'pipe',
        stderr: 'pipe',
        env: hostSafeChildEnv(home, { tools: SCRIPT_TOOLS, pathDirs: [tmuxBin(tmux)], extras: scriptExtras(tmux) }),
      })
      return proc(r.exitCode ?? 1, r.stdout.toString(), false, r.stderr.toString())
    },
  }
}

/**
 * A container with no rotated server logs, no tmux server and no
 * transcript, whose read of each path in `held` hangs until the test
 * releases it with that read's result; every other file is not there.
 * `calls` lists `sessions`, `list`, then each path read (the logs', then
 * each transcript dir), in order.
 */
function heldContainer(held: readonly string[], answers: ReadonlyMap<string, ProcResult> = new Map()) {
  const calls: string[] = []
  const waiting = new Map<string, (r: ProcResult) => void>()
  return {
    calls,
    exec(argv: readonly string[]): Promise<ProcResult> {
      if (argv[3] === 'list' || argv[3] === 'sessions') {
        calls.push(argv[3])
        return Promise.resolve(argv[3] === 'list' ? proc(0, '') : NO_TMUX_SERVER)
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

/** Every transcript read after the logs: A–D's transcript dirs. */
const TRANSCRIPT_DIRS = PERSONA_CAPTURES.map((p) => p.transcriptDir)

/** The outcomes of the panes and transcripts when the container has neither. */
const NONE_NOTED = PERSONA_CAPTURES.length * 2

let root: string
let tmux: string
/** Every bash child's HOME: a temp dir the test owns and removes. */
let home: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ci-live-container-logs-'))
  tmux = makeTmuxDir()
  home = mkdtempSync(join(tmpdir(), 'ci-live-container-logs-home-'))
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
  rmSync(tmux, { recursive: true, force: true })
  rmSync(home, { recursive: true, force: true })
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

  test("each persona A–D's pane and transcript: its tmux session as CSCB names it, and the Claude Code project dir of its working directory as the runner's config gives it; every copy has its own plain name", () => {
    expect(PERSONA_CAPTURES.map((p) => p.key)).toEqual(['persona_a', 'persona_b', 'persona_c', 'persona_d'])
    for (const [i, letter] of PERSONA_LETTERS.entries()) {
      const p = PERSONA_CAPTURES[i]
      const entry = personaEntryFor(letter, DRY_RUN_IDS)
      expect(p?.key).toBe(personaKey(entry.name))
      expect(p?.key).toBe(personaName(letter))
      expect(p?.session).toBe(personaTmuxSessionName(personaKey(entry.name)))
      expect(p?.workingDirectory).toBe(expandTilde(entry.working_directory, CONTAINER_HOME))
      expect(p?.transcriptDir).toBe(`${CONTAINER_HOME}/.claude/projects/-home-testuser-cscb-live-${letter}`)
      expect([p?.paneCopy, p?.transcriptCopy]).toEqual([`pane-persona_${letter}.txt`, `transcript-persona_${letter}.jsonl`])
      // No persona sets a claude_config_dir: its Claude keeps its transcripts under the test user's ~/.claude.
      expect(Object.keys(entry)).not.toContain('claude_config_dir')
    }
    expect(CONTAINER_CLAUDE_PROJECTS_DIR).toBe(`${CONTAINER_HOME}/.claude/projects`)
    // The testplan's helpers (tags, tagstext, replies) read a persona's transcript from the same dir.
    const helpers = readFileSync(join(REPO, 'docker', 'live', 'cscb-live-helpers.sh'), 'utf-8')
    expect(helpers).toContain('ls -t ~/.claude/projects/*-cscb-live-"$1"/*.jsonl')
    const names = [SERVER_LOG, ...OTHER_LOG_FILES].map((f) => f.name).concat(PERSONA_CAPTURES.flatMap((p) => [p.paneCopy, p.transcriptCopy]), [CONTAINER_LOGS_INDEX])
    expect(new Set(names).size).toBe(names.length)
    for (const name of names) expect(name).toMatch(/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/)
  })

  test('claudeProjectSlug: every character but an ASCII letter or digit becomes -, as Claude Code names a project dir', () => {
    expect(claudeProjectSlug('/home/testuser/cscb-live/a')).toBe('-home-testuser-cscb-live-a')
    expect(claudeProjectSlug('/home/u/my.proj_x y/é')).toBe('-home-u-my-proj-x-y--')
  })
})

// ---------------------------------------------------------------------------
// Reading one file: the script, and what its output comes to
// ---------------------------------------------------------------------------

describe('reading one file (READ_LOG_SCRIPT with bash, on a temp dir)', () => {
  const read = (path: string, cap: number) => {
    const r = Bun.spawnSync(['bash', '-c', READ_LOG_SCRIPT, 'read', path, String(cap)], {
      stdout: 'pipe',
      stderr: 'pipe',
      env: hostSafeChildEnv(home, { tools: ['bash', 'head', 'stat', 'tail'], extras: { LANG: 'C.UTF-8' } }),
    })
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
    const list = (dir: string) =>
      Bun.spawnSync(['bash', '-c', LIST_ROTATED_SCRIPT, 'list', dir], { stdout: 'pipe', env: hostSafeChildEnv(home, { tools: ['bash'], extras: { LANG: 'C.UTF-8' } }) })
    const r = list(root)
    expect([r.exitCode, r.stdout.toString()]).toEqual([0, 'server.log.1\nserver.log.2\nserver.log.3\n'])
    const none = list(join(root, 'missing'))
    expect([none.exitCode, none.stdout.toString()]).toEqual([0, ''])
  })
})

// ---------------------------------------------------------------------------
// The sessions, a pane and a transcript: the scripts, and what their output comes to
// ---------------------------------------------------------------------------

describe('the pane and transcript scripts', () => {
  const tmuxSubcommands = (script: string): string[] => [...script.matchAll(/\btmux\s+([a-z-]+)/g)].map((m) => m[1] ?? '')

  test('they only read: their tmux subcommands are ls, has-session and capture-pane (-p -J -S -200), never one that sends keys or changes a session', () => {
    expect(tmuxSubcommands(LIST_SESSIONS_SCRIPT)).toEqual(['ls'])
    expect(tmuxSubcommands(CAPTURE_PANE_SCRIPT)).toEqual(['has-session', 'capture-pane'])
    expect(tmuxSubcommands(READ_TRANSCRIPT_SCRIPT)).toEqual([])
    expect(CAPTURE_PANE_SCRIPT).toContain('tmux capture-pane -p -J -S "-$h" -t "$s"')
    expect([PANE_HISTORY_LINES, TRANSCRIPT_TAIL_LINES]).toEqual([200, 200])
  })

  test('one fixed script per read, the session, the directory, the cap and the history as arguments, never in a script', () => {
    expect(listSessionsArgv()).toEqual(['bash', '-c', LIST_SESSIONS_SCRIPT, 'sessions'])
    expect(capturePaneArgv('slack_bot_persona_a', 123)).toEqual(['bash', '-c', CAPTURE_PANE_SCRIPT, 'pane', 'slack_bot_persona_a', '123', '200'])
    const dir = PERSONA_CAPTURES[0]?.transcriptDir ?? ''
    expect(readTranscriptArgv(dir, 456)).toEqual(['bash', '-c', READ_TRANSCRIPT_SCRIPT, 'transcript', dir, '456'])
    for (const script of [LIST_SESSIONS_SCRIPT, CAPTURE_PANE_SCRIPT, READ_TRANSCRIPT_SCRIPT]) {
      for (const text of ['slack_bot_', 'persona_', 'cscb-live', CONTAINER_HOME, '.claude']) expect(script).not.toContain(text)
    }
  })

  const run = (argv: readonly string[]): ProcResult => {
    const r = Bun.spawnSync([...argv], {
      stdout: 'pipe',
      stderr: 'pipe',
      env: hostSafeChildEnv(home, { tools: SCRIPT_TOOLS, pathDirs: [tmuxBin(tmux)], extras: scriptExtras(tmux) }),
      cwd: root,
    })
    return proc(r.exitCode ?? 1, r.stdout.toString(), false, r.stderr.toString())
  }

  test("the scripts' tmux is the fake: the first tmux on their PATH is the fake's, never the host's", () => {
    const r = run(['bash', '-c', 'command -v tmux', 'which'])
    expect([r.code, r.stdout]).toEqual([0, `${join(tmuxBin(tmux), 'tmux')}\n`])
    expect(tmuxCalls(tmux)).toEqual([])
  })

  test('CAPTURE_PANE_SCRIPT (bash, the fake tmux): the session checked, its pane captured and printed as a file, at most its last bytes; its temp file removed', () => {
    tmuxSessions(tmux, { slack_bot_persona_a: 'aaaa\nbbbb\ncccc\n' })
    expect(parsePaneRead(run(capturePaneArgv('slack_bot_persona_a', 100)))).toEqual({ kind: 'read', size: 15, cut: 0, content: 'aaaa\nbbbb\ncccc\n' })
    expect(tmuxCalls(tmux)).toEqual(['has-session -t slack_bot_persona_a', 'capture-pane -p -J -S -200 -t slack_bot_persona_a'])
    // Over the cap: cut as a file is, the byte before the kept part first.
    const cut = parsePaneRead(run(capturePaneArgv('slack_bot_persona_a', 7)))
    expect(cut).toEqual({ kind: 'read', size: 15, cut: 8, content: 'bb\ncccc\n' })
    if (cut.kind !== 'read') throw new Error('unreachable')
    expect(wholeLines(cut.content, cut.cut).text).toBe('cccc\n')
    // Nothing left in the scripts' TMPDIR but the fake's own files.
    expect(readdirSync(tmux).sort()).toEqual(['bin', 'calls', 'pane-slack_bot_persona_a', 'sessions'])
  })

  test('CAPTURE_PANE_SCRIPT: a session gone since tmux ls is not there (exit 3); a capture that fails is exit 7; a session name is an argument, never run', () => {
    tmuxSessions(tmux, { slack_bot_persona_a: 'x\n' })
    expect(parsePaneRead(run(capturePaneArgv('slack_bot_persona_b', 100)))).toEqual({ kind: 'missing' })
    writeFileSync(join(tmux, 'capture-fails'), '')
    expect(parsePaneRead(run(capturePaneArgv('slack_bot_persona_a', 100)))).toEqual({ kind: 'failed', reason: 'tmux capture-pane failed' })
    expect(run(capturePaneArgv('a "b" $(touch pwned) c', 100)).code).toBe(3)
    expect(readdirSync(root)).not.toContain('pwned')
    expect(readdirSync(tmux).filter((f) => f.startsWith('tmp'))).toEqual([])
  })

  test('READ_TRANSCRIPT_SCRIPT (bash): the newest regular *.jsonl directly in the dir, by modification time; never a symlink, a subdirectory\'s, an odd name, a directory or another suffix', () => {
    const dir = join(root, 'project')
    mkdirSync(join(dir, 'session-id', 'subagents'), { recursive: true })
    const at = (path: string, content: string | null, secondsAgo: number): void => {
      if (content !== null) writeFileSync(path, content)
      const t = Date.now() / 1000 - secondsAgo
      utimesSync(path, t, t)
    }
    at(join(dir, 'older.jsonl'), 'older\n', 3600)
    at(join(dir, 'newest.jsonl'), 'newest\n', 600)
    // Each of these is newer than newest.jsonl, and none may be picked.
    at(join(root, 'target'), `${SECRET}\n`, 10)
    symlinkSync(join(root, 'target'), join(dir, 'link.jsonl'))
    at(join(dir, 'session-id', 'subagents', 'agent-1.jsonl'), 'subagent\n', 10)
    at(join(dir, 'odd name.jsonl'), 'odd\n', 10)
    mkdirSync(join(dir, 'dir.jsonl'))
    at(join(dir, 'dir.jsonl'), null, 10)
    at(join(dir, 'notes.txt'), 'notes\n', 10)
    expect(parseTranscriptRead(run(readTranscriptArgv(dir, 100)))).toEqual({ name: 'newest.jsonl', read: { kind: 'read', size: 7, cut: 0, content: 'newest\n' } })
    // Sub-second times count: of two modified within the same second, the later wins.
    const second = Math.floor(Date.now() / 1000) - 300
    const setAt = (name: string, t: number): void => utimesSync(join(dir, name), t, t)
    writeFileSync(join(dir, 'same-second.jsonl'), 'same second\n')
    setAt('newest.jsonl', second + 0.6)
    setAt('same-second.jsonl', second + 0.3)
    expect(parseTranscriptRead(run(readTranscriptArgv(dir, 100))).name).toBe('newest.jsonl')
    setAt('same-second.jsonl', second + 0.9)
    expect(parseTranscriptRead(run(readTranscriptArgv(dir, 100))).name).toBe('same-second.jsonl')
  })

  test('READ_TRANSCRIPT_SCRIPT: no dir or no transcript is not there (exit 3); a symlinked dir is skipped, never followed (exit 4); over the cap, cut as a file is; the dir is an argument, never run', () => {
    expect(parseTranscriptRead(run(readTranscriptArgv(join(root, 'missing'), 100)))).toEqual({ name: null, read: { kind: 'missing' } })
    mkdirSync(join(root, 'empty'))
    expect(parseTranscriptRead(run(readTranscriptArgv(join(root, 'empty'), 100)))).toEqual({ name: null, read: { kind: 'missing' } })
    mkdirSync(join(root, 'real'))
    writeFileSync(join(root, 'real', 't.jsonl'), `${SECRET}\n`)
    symlinkSync(join(root, 'real'), join(root, 'linked'))
    const linked = run(readTranscriptArgv(join(root, 'linked'), 100))
    expect([linked.code, linked.stdout]).toEqual([4, ''])
    expect(parseTranscriptRead(linked)).toEqual({ name: null, read: { kind: 'skipped', reason: 'its directory is a symlink (never followed)' } })
    writeFileSync(join(root, 'real', 't.jsonl'), 'aaaa\nbbbb\ncccc\n')
    expect(parseTranscriptRead(run(readTranscriptArgv(join(root, 'real'), 10)))).toEqual({ name: 't.jsonl', read: { kind: 'read', size: 15, cut: 5, content: '\nbbbb\ncccc\n' } })
    const odd = join(root, 'a "b" $(touch pwned) c')
    mkdirSync(odd)
    writeFileSync(join(odd, 'x.jsonl'), 'ok\n')
    expect(parseTranscriptRead(run(readTranscriptArgv(odd, 100)))).toEqual({ name: 'x.jsonl', read: { kind: 'read', size: 3, cut: 0, content: 'ok\n' } })
    expect(readdirSync(root)).not.toContain('pwned')
  })
})

describe('parseSessionList, parsePaneRead, parseTranscriptRead, lastLines', () => {
  test("parseSessionList: the listed names; no tmux server running (either of tmux's words for it) is no session; any other failure says why, docker's own message never echoed", () => {
    expect(parseSessionList(proc(0, 'slack_bot_persona_a\n\nother\n'))).toEqual(new Set(['slack_bot_persona_a', 'other']))
    expect(parseSessionList(NO_TMUX_SERVER)).toEqual(new Set())
    expect(parseSessionList(proc(1, '', false, 'error connecting to /tmp/tmux-1000/default (No such file or directory)\n'))).toEqual(new Set())
    expect(parseSessionList(proc(1, '', false, `server exited unexpectedly ${SECRET}`))).toBe('docker exec exit 1')
    expect(parseSessionList(proc(1, '', false, 'Error response from daemon: No such container: cscb-live-1-2'))).toBe('the container is gone (docker exec exit 1)')
    expect(parseSessionList(proc(124, 'slack_bot_persona_a\n', true))).toBe('docker exec timed out')
  })

  test('parsePaneRead: exit 7 is a failed capture; the rest as a file', () => {
    expect(parsePaneRead(proc(7))).toEqual({ kind: 'failed', reason: 'tmux capture-pane failed' })
    expect(parsePaneRead(proc(3))).toEqual({ kind: 'missing' })
    expect(parsePaneRead(readOut('pane\n'))).toEqual({ kind: 'read', size: 5, cut: 0, content: 'pane\n' })
    expect(parsePaneRead(proc(7, '', true))).toEqual({ kind: 'failed', reason: 'docker exec timed out' })
  })

  test('parseTranscriptRead: the name line, then the read; a name line that is not a plain *.jsonl name fails it', () => {
    expect(parseTranscriptRead(proc(0, 'abc-1.jsonl\n3 0\nok\n'))).toEqual({ name: 'abc-1.jsonl', read: { kind: 'read', size: 3, cut: 0, content: 'ok\n' } })
    for (const bad of ['3 0\nok\n', '../x.jsonl\n3 0\nok\n', 'x.txt\n3 0\nok\n', '']) {
      expect(parseTranscriptRead(proc(0, bad))).toEqual({ name: null, read: { kind: 'failed', reason: 'no transcript name line' } })
    }
    expect(parseTranscriptRead(proc(0, 'x.jsonl\n'))).toEqual({ name: 'x.jsonl', read: { kind: 'failed', reason: 'no size line' } })
    expect(parseTranscriptRead(proc(3))).toEqual({ name: null, read: { kind: 'missing' } })
    expect(parseTranscriptRead(proc(6))).toEqual({ name: null, read: { kind: 'skipped', reason: 'not readable by the test user' } })
    expect(parseTranscriptRead(proc(4, '', true))).toEqual({ name: null, read: { kind: 'failed', reason: 'docker exec timed out' } })
  })

  test('lastLines: the last whole lines, and how many before them were left out', () => {
    expect(lastLines('', 2)).toEqual({ text: '', older: 0 })
    expect(lastLines('a\nb\n', 2)).toEqual({ text: 'a\nb\n', older: 0 })
    expect(lastLines('a\nb\nc\nd\n', 2)).toEqual({ text: 'c\nd\n', older: 2 })
    expect(lastLines('\n\nx\n', 1)).toEqual({ text: 'x\n', older: 2 })
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
    const container = bashContainer(root, tmux)
    const sink = memSink()
    const outcomes = await collectContainerLogs({ container, redactor: redactor(), sink, writable: () => true, maxBytes: 200 })
    expect(outcomes.map((o) => [o.name, o.status])).toEqual([
      // No tmux server and no transcript in this container: each persona's pane noted as not there first, its transcript last.
      ...PERSONA_CAPTURES.map((p) => [p.paneCopy, 'missing']),
      ['server.log', 'copied'],
      ['server.log.1', 'copied'],
      ['server.log.2', 'skipped'],
      ['startup-errors.log', 'missing'],
      ['cron.log', 'copied'],
      ['permission-trail.jsonl', 'copied'],
      ['boot-start.log', 'copied'],
      ['agent-director-errors.log', 'copied'],
      ['agent-director-ad-trail.jsonl', 'copied'],
      ...PERSONA_CAPTURES.map((p) => [p.transcriptCopy, 'missing']),
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
      "The test container's own logs, and each persona's tmux pane and Claude transcript tail, copied before it was removed or stopped, each redacted: " +
        "a pane is `tmux capture-pane -p -J -S -200` (its last 200 lines of history and its screen; -J joins only the lines tmux wrapped at the pane's width, not Claude Code's own hard wraps), " +
        "a transcript the last 200 lines of the newest *.jsonl in the persona's Claude Code project dir; " +
        'in a pane or a transcript, every fragment of 10 or more characters of a registered value is masked too, and a registered value or a token a row break with indentation or a border split, in each piece; ' +
        'a log at most its last 200 B, a pane or a transcript at most its last 2.0 MiB; ' +
        'whole lines only (a partial first line at a cut and an unterminated last line left out).',
    )
    expect(index[0]).toBe(indexHeader(200, SESSION_CAPTURE_MAX_BYTES))
    expect(index.slice(1)).toEqual([...outcomes.map(describeLogOutcome), ''])
    expect(index).toContain(`pane-persona_a.txt: not there (tmux session slack_bot_persona_a)`)
    expect(index).toContain(`transcript-persona_d.jsonl: not there (${CONTAINER_HOME}/.claude/projects/-home-testuser-cscb-live-d/*.jsonl)`)
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
    const outcomes = await collectContainerLogs({ container: bashContainer(root, tmux), redactor: redactor(), sink, writable: () => true, maxBytes: 60 })
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
    await collectContainerLogs({ container: bashContainer(root, tmux), redactor: redactor(), sink, writable: () => true })
    expect(sink.files.get('server.log')).toBe(`before\nkey: ${REDACTED_SECRET}\nafter ${REDACTED_TOKEN}\n`)
    assertNoLeak([...sink.files.values()])
    // The control: redacted a line at a time, the value's first half would stay.
    const r = redactor()
    expect(text.split('\n').map((l) => r.redact(l)).join('\n')).toContain(LEAK_SENTINEL)
  })

  test('every read is the fixed script as the test user, with the path and the cap as arguments and a time limit (a tmux exec 5 s, a file 30 s); the default cap is 20 MiB', async () => {
    seed()
    const container = bashContainer(root, tmux)
    await collectContainerLogs({ container, redactor: redactor(), sink: memSink(), writable: () => true })
    // First the sessions (no tmux server here, so no pane is read), then the logs, then the transcripts.
    const [sessions, list, ...afterList] = container.calls
    const reads = afterList.slice(0, -PERSONA_CAPTURES.length)
    const transcripts = afterList.slice(-PERSONA_CAPTURES.length)
    expect(sessions?.argv).toEqual(['bash', '-c', LIST_SESSIONS_SCRIPT, 'sessions'])
    expect(list?.argv).toEqual(['bash', '-c', LIST_ROTATED_SCRIPT, 'list', CONTAINER_STATE_DIR])
    const read = [SERVER_LOG.path, STATE('server.log.1'), STATE('server.log.2'), ...OTHER_LOG_FILES.map((f) => f.path)]
    expect(reads.map((c) => c.argv)).toEqual(read.map((path) => ['bash', '-c', READ_LOG_SCRIPT, 'read', path, String(CONTAINER_LOG_MAX_BYTES)]))
    expect(transcripts.map((c) => c.argv)).toEqual(TRANSCRIPT_DIRS.map((dir) => ['bash', '-c', READ_TRANSCRIPT_SCRIPT, 'transcript', dir, String(SESSION_CAPTURE_MAX_BYTES)]))
    expect([CONTAINER_LOG_MAX_BYTES, SESSION_CAPTURE_MAX_BYTES]).toEqual([20 * 1024 * 1024, 2 * 1024 * 1024])
    // No user given: TestContainer.exec runs it as the test user. tmux gets 5 s, a file 30 s.
    expect([TMUX_EXEC_TIMEOUT_MS, CONTAINER_LOG_EXEC_TIMEOUT_MS]).toEqual([5_000, 30_000])
    expect(container.calls.map((c) => c.options)).toEqual([{ timeoutMs: TMUX_EXEC_TIMEOUT_MS }, ...container.calls.slice(1).map(() => ({ timeoutMs: CONTAINER_LOG_EXEC_TIMEOUT_MS }))])
  })

  test('a file that fails (a throw, a docker failure, a timeout) is noted and the others are still copied; nothing throws', async () => {
    const container = {
      async exec(argv: readonly string[]): Promise<ProcResult> {
        const path = argv[4] ?? ''
        const none = noSessions(argv)
        if (none) return none
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
    const container = { exec: async (argv: readonly string[]) => noSessions(argv) ?? (argv[3] === 'list' ? proc(125) : proc(3)) }
    const outcomes = await collectContainerLogs({ container, redactor: redactor(), sink: memSink(), writable: () => true })
    expect(outcomes.at(-1)).toEqual({ name: 'server.log.*', path: STATE('server.log.*'), status: 'failed', reason: 'the rotated server logs could not be listed (docker exec exit 125)' })
    expect(outcomes.filter((o) => o.status === 'missing').length).toBe(NONE_NOTED + 1 + OTHER_LOG_FILES.length)
  })

  test('unexpected names and generations past the cap are noted, not copied', async () => {
    const listed = [...Array.from({ length: MAX_ROTATED_SERVER_LOGS + 1 }, (_, i) => `server.log.${i + 1}`), 'server.log.x y'].join('\n')
    const container = { exec: async (argv: readonly string[]) => noSessions(argv) ?? (argv[3] === 'list' ? proc(0, listed) : proc(3)) }
    const outcomes = await collectContainerLogs({ container, redactor: redactor(), sink: memSink(), writable: () => true })
    expect(outcomes.filter((o) => o.name === 'server.log.*')).toEqual([
      { name: 'server.log.*', path: STATE('server.log.*'), status: 'skipped', reason: '1 entry not named server.log.<generation>' },
      { name: 'server.log.*', path: STATE('server.log.*'), status: 'skipped', reason: `1 generation(s) past the newest ${MAX_ROTATED_SERVER_LOGS}` },
    ])
  })

  test('a copy that cannot be written is noted; the others and the index are still written', async () => {
    seed()
    const sink = memSink({ failOn: 'server.log' })
    const outcomes = await collectContainerLogs({ container: bashContainer(root, tmux), redactor: redactor(), sink, writable: () => true })
    expect(outcomes.find((o) => o.name === 'server.log')).toMatchObject({ status: 'failed', reason: expect.stringContaining('could not be written: Error: EACCES') })
    expect(sink.writes).toContain('cron.log')
    expect(sink.writes.at(-1)).toBe(CONTAINER_LOGS_INDEX)
  })

  test('nothing is written once it is no longer writable (the closing scan has begun), not even the index', async () => {
    seed()
    const sink = memSink()
    let open = true
    const container = bashContainer(root, tmux)
    const wrapped = {
      exec: async (argv: readonly string[], options?: ExecOptions) => {
        const r = await container.exec(argv, options)
        if (argv[4] === STATE('server.log.1')) open = false
        return r
      },
    }
    const outcomes = await collectContainerLogs({ container: wrapped, redactor: redactor(), sink, writable: () => open })
    expect(sink.writes).toEqual(['server.log'])
    expect(outcomes.filter((o) => o.status === 'failed').map((o) => o.name)).toEqual([
      'server.log.1',
      'server.log.2',
      ...OTHER_LOG_FILES.map((f) => f.name),
      ...PERSONA_CAPTURES.map((p) => p.transcriptCopy),
    ])
    // No read once closed: the sessions, the rotated list, server.log and server.log.1 only (no transcript).
    expect(container.calls.map((c) => c.argv[3])).toEqual(['sessions', 'list', 'read', 'read'])
  })
})

describe('collectContainerLogs: the personas\' panes and transcript tails', () => {
  const [A, B, C, D] = PERSONA_CAPTURES as readonly [PersonaCapture, PersonaCapture, PersonaCapture, PersonaCapture]
  /** One transcript line: JSON, its number, and `extra` as its message. */
  const line = (n: number, extra = ''): string => `${JSON.stringify({ n, ...(extra ? { message: extra } : {}) })}\n`

  test("first, each persona's pane when tmux ls lists its session, and its transcript tail (its last 200 whole lines), redacted; each noted in index.txt; then the logs", async () => {
    const pane = `pane top\nsecret ${SECRET}\ntoken ${BOT}\n`
    // C's session is listed but gone by the capture; another session is not a persona's.
    tmuxSessions(tmux, { [A.session]: pane, [C.session]: null, other: 'other pane\n' })
    const whole = Array.from({ length: 250 }, (_, i) => line(i + 1, i === 249 ? `${SECRET} ${APP}` : '')).join('')
    // A prefix of the secret, as a line still being written: it holds the sentinel, and the redactor knows only the whole value.
    const midWrite = `{"n":251,"message":"${SECRET.slice(0, -3)}`
    put(root, `${A.transcriptDir}/0a1b-session.jsonl`, `${whole}${midWrite}`)
    put(root, `${A.transcriptDir}/older.jsonl`, line(0, SECRET))
    const hourAgo = Date.now() / 1000 - 3600
    utimesSync(hostPath(root, `${A.transcriptDir}/older.jsonl`), hourAgo, hourAgo)
    put(root, `${B.transcriptDir}/b.jsonl`, `${line(1)}${line(2)}`)
    // D's project dir is a symlink to a dir holding a transcript: skipped, never followed.
    mkdirSync(join(root, 'elsewhere'))
    writeFileSync(join(root, 'elsewhere', 'x.jsonl'), `${SECRET}\n`)
    mkdirSync(dirname(hostPath(root, D.transcriptDir)), { recursive: true })
    symlinkSync(join(root, 'elsewhere'), hostPath(root, D.transcriptDir))
    put(root, STATE('server.log'), 'server\n')
    const container = bashContainer(root, tmux)
    const sink = memSink()
    const outcomes = await collectContainerLogs({ container, redactor: redactor(), sink, writable: () => true })

    const keptLines = `${whole.split('\n').slice(50, 250).join('\n')}\n`
    const cap = SESSION_CAPTURE_MAX_BYTES
    // The panes, then the logs (server.log first; the others are not there), then the transcripts.
    const logs = 1 + OTHER_LOG_FILES.length
    expect(outcomes.slice(4, 4 + logs).map((o) => o.name)).toEqual([SERVER_LOG.name, ...OTHER_LOG_FILES.map((f) => f.name)])
    expect([...outcomes.slice(0, 5), ...outcomes.slice(4 + logs)]).toEqual([
      { name: A.paneCopy, path: `tmux session ${A.session}`, status: 'copied', size: Buffer.byteLength(pane), kept: Buffer.byteLength(pane), cut: false, cap, unterminated: 0 },
      { name: B.paneCopy, path: `tmux session ${B.session}`, status: 'missing' },
      { name: C.paneCopy, path: `tmux session ${C.session}`, status: 'missing' },
      { name: D.paneCopy, path: `tmux session ${D.session}`, status: 'missing' },
      { ...SERVER_LOG, status: 'copied', size: 7, kept: 7, cut: false, cap: CONTAINER_LOG_MAX_BYTES, unterminated: 0 },
      {
        name: A.transcriptCopy,
        path: `${A.transcriptDir}/0a1b-session.jsonl`,
        status: 'copied',
        size: Buffer.byteLength(`${whole}${midWrite}`),
        kept: Buffer.byteLength(keptLines),
        cut: false,
        cap,
        unterminated: Buffer.byteLength(midWrite),
        older: 50,
      },
      { name: B.transcriptCopy, path: `${B.transcriptDir}/b.jsonl`, status: 'copied', size: 16, kept: 16, cut: false, cap, unterminated: 0, older: 0 },
      { name: C.transcriptCopy, path: `${C.transcriptDir}/*.jsonl`, status: 'missing' },
      { name: D.transcriptCopy, path: `${D.transcriptDir}/*.jsonl`, status: 'skipped', reason: 'its directory is a symlink (never followed)' },
    ])
    expect(outcomes).toHaveLength(4 + logs + 4)
    // The copies: the pane and the last 200 whole lines of A's newest transcript, redacted.
    expect(sink.writes).toEqual([A.paneCopy, 'server.log', A.transcriptCopy, B.transcriptCopy, CONTAINER_LOGS_INDEX])
    expect(sink.files.get(A.paneCopy)).toBe(`pane top\nsecret ${REDACTED_SECRET}\ntoken ${REDACTED_TOKEN}\n`)
    const transcript = sink.files.get(A.transcriptCopy) ?? ''
    expect(transcript).toBe(redactor().redactWrapped(keptLines))
    expect(transcript).toBe(redactor().redact(keptLines))
    expect(transcript.split('\n')).toHaveLength(TRANSCRIPT_TAIL_LINES + 1)
    expect(transcript.startsWith(line(51))).toBe(true)
    expect(transcript.endsWith(line(250, `${REDACTED_SECRET} ${REDACTED_TOKEN}`))).toBe(true)
    expect(sink.files.get(B.transcriptCopy)).toBe(`${line(1)}${line(2)}`)
    assertNoLeak([...sink.files.values()])
    // The reads: the sessions, the listed personas' panes (C's gone since), then the logs, then every transcript.
    expect(container.calls.slice(0, 4).map((c) => c.argv)).toEqual([listSessionsArgv(), capturePaneArgv(A.session, cap), capturePaneArgv(C.session, cap), listRotatedArgv()])
    expect(container.calls.slice(4, 4 + logs).map((c) => c.argv[3])).toEqual(Array.from({ length: logs }, () => 'read'))
    expect(container.calls.slice(4 + logs).map((c) => c.argv)).toEqual(TRANSCRIPT_DIRS.map((dir) => readTranscriptArgv(dir, cap)))
    expect(tmuxCalls(tmux)).toEqual(['ls -F #{session_name}', `has-session -t ${A.session}`, `capture-pane -p -J -S -200 -t ${A.session}`, `has-session -t ${C.session}`])
    // index.txt: one line each.
    const index = sink.files.get(CONTAINER_LOGS_INDEX) ?? ''
    for (const noted of [
      `${A.paneCopy}: copied, ${Buffer.byteLength(pane)} bytes (tmux session slack_bot_persona_a)`,
      `${B.paneCopy}: not there (tmux session slack_bot_persona_b)`,
      `${A.transcriptCopy}: copied, ${Buffer.byteLength(keptLines)} bytes; its last 200 lines, 50 older left out; its unterminated last line (${Buffer.byteLength(midWrite)} bytes, perhaps still being written) left out (${A.transcriptDir}/0a1b-session.jsonl)`,
      `${B.transcriptCopy}: copied, 16 bytes (${B.transcriptDir}/b.jsonl)`,
      `${C.transcriptCopy}: not there (${CONTAINER_HOME}/.claude/projects/-home-testuser-cscb-live-c/*.jsonl)`,
      `${D.transcriptCopy}: skipped: its directory is a symlink (never followed) (${D.transcriptDir}/*.jsonl)`,
    ]) {
      expect(index.split('\n')).toContain(noted)
    }
    expect(summarizeLogOutcomes(outcomes, sink.dir)).toContain('(tmux panes: 1 of 4; transcript tails: 2 of 4)')
  })

  test('a pane or a transcript over its cap (2 MiB by default) is cut to its last whole lines within it; a transcript then keeps its last 200 of those', async () => {
    const numbered = (prefix: string, count: number): string => Array.from({ length: count }, (_, i) => `${prefix} ${String(i + 1).padStart(4, '0')}\n`).join('')
    // 300 ten-byte lines each (3000 bytes) against a 2500-byte cap: the cut falls on a line start, 50 lines in.
    tmuxSessions(tmux, { [A.session]: numbered('pane', 300) })
    put(root, `${A.transcriptDir}/t.jsonl`, numbered('line', 300))
    const sink = memSink()
    const outcomes = await collectContainerLogs({ container: bashContainer(root, tmux), redactor: redactor(), sink, writable: () => true, sessionMaxBytes: 2500 })
    const pane = outcomes.find((o) => o.name === A.paneCopy)
    const transcript = outcomes.find((o) => o.name === A.transcriptCopy)
    expect(pane).toEqual({ name: A.paneCopy, path: `tmux session ${A.session}`, status: 'copied', size: 3000, kept: 2500, cut: true, cap: 2500, unterminated: 0 })
    expect(transcript).toEqual({ name: A.transcriptCopy, path: `${A.transcriptDir}/t.jsonl`, status: 'copied', size: 3000, kept: 2000, cut: true, cap: 2500, unterminated: 0, older: 50 })
    expect(sink.files.get(A.paneCopy)).toBe(numbered('pane', 300).slice(500))
    expect(sink.files.get(A.transcriptCopy)).toBe(numbered('line', 300).slice(1000))
    const index = (sink.files.get(CONTAINER_LOGS_INDEX) ?? '').split('\n')
    expect(index).toContain(`${A.paneCopy}: cut: its last 2.4 KiB (2500 of 3000 bytes), from the first whole line within the 2.4 KiB cap (tmux session ${A.session})`)
    expect(index).toContain(`${A.transcriptCopy}: cut: its last 2.0 KiB (2000 of 3000 bytes), from the first whole line within the 2.4 KiB cap; its last 200 lines, 50 older left out (${A.transcriptDir}/t.jsonl)`)
    // The logs keep their own cap.
    expect(SESSION_CAPTURE_MAX_BYTES).toBe(2 * 1024 * 1024)
  })

  test("tmux ls failing is noted, and then every persona's pane is tried", async () => {
    const panes: string[] = []
    const container = {
      exec: async (argv: readonly string[]): Promise<ProcResult> => {
        if (argv[3] === 'sessions') return proc(1, '', false, `server exited unexpectedly ${SECRET}`)
        if (argv[3] === 'pane') {
          panes.push(argv[4] ?? '')
          return argv[4] === B.session ? readOut('b pane\n') : proc(3)
        }
        return noSessions(argv) ?? proc(argv[3] === 'list' ? 0 : 3)
      },
    }
    const sink = memSink()
    const outcomes = await collectContainerLogs({ container, redactor: redactor(), sink, writable: () => true })
    expect(panes).toEqual(PERSONA_CAPTURES.map((p) => p.session))
    expect(outcomes.filter((o) => o.name.startsWith('pane-')).map((o) => [o.name, o.status])).toEqual([
      [A.paneCopy, 'missing'],
      [B.paneCopy, 'copied'],
      [C.paneCopy, 'missing'],
      [D.paneCopy, 'missing'],
      ['pane-*.txt', 'failed'],
    ])
    const note = "the tmux sessions could not be listed (docker exec exit 1); each persona's pane was tried"
    expect(outcomes.find((o) => o.name === 'pane-*.txt')).toEqual({ name: 'pane-*.txt', path: 'tmux ls', status: 'failed', reason: note })
    expect(sink.files.get(B.paneCopy)).toBe('b pane\n')
    expect((sink.files.get(CONTAINER_LOGS_INDEX) ?? '').split('\n')).toContain(`pane-*.txt: not copied: ${note} (tmux ls)`)
    assertNoLeak([...sink.files.values()])
  })

  test('a pane or a transcript that fails (a throw, a timeout, a copy that cannot be written) is noted, and the others are still copied', async () => {
    const container = {
      exec: async (argv: readonly string[]): Promise<ProcResult> => {
        if (argv[3] === 'sessions') return proc(0, `${A.session}\n${B.session}\n`)
        if (argv[3] === 'pane' && argv[4] === A.session) throw new Error(`spawn failed near ${SECRET}`)
        if (argv[3] === 'pane') return readOut('b pane\n')
        if (argv[3] === 'transcript' && argv[4] === A.transcriptDir) return proc(0, `a.jsonl\n${Buffer.byteLength(`${SECRET}\n`)} 0\n${SECRET}\n`)
        if (argv[3] === 'transcript' && argv[4] === B.transcriptDir) return proc(124, '', true)
        return noSessions(argv) ?? proc(argv[3] === 'list' ? 0 : 3)
      },
    }
    const sink = memSink({ failOn: A.transcriptCopy })
    const outcomes = await collectContainerLogs({ container, redactor: redactor(), sink, writable: () => true })
    const failed = outcomes.filter((o): o is Extract<LogOutcome, { reason: string }> => o.status === 'failed')
    expect(failed.map((o) => [o.name, o.reason.replace(SECRET, '<the secret>')])).toEqual([
      [A.paneCopy, 'Error: spawn failed near <the secret>'],
      [A.transcriptCopy, `could not be written: Error: EACCES: permission denied, open '/results/container-logs/${A.transcriptCopy}'`],
      [B.transcriptCopy, 'docker exec timed out'],
    ])
    expect(sink.writes).toEqual([B.paneCopy, CONTAINER_LOGS_INDEX])
    assertNoLeak(sink.files.get(CONTAINER_LOGS_INDEX))
  })

  test('once no longer writable, no pane is captured and no transcript read', async () => {
    tmuxSessions(tmux, { [A.session]: `x ${SECRET}\n` })
    put(root, `${A.transcriptDir}/a.jsonl`, `${SECRET}\n`)
    const container = bashContainer(root, tmux)
    const sink = memSink()
    const outcomes = await collectContainerLogs({ container, redactor: redactor(), sink, writable: () => false })
    expect(container.calls.map((c) => c.argv[3])).toEqual(['sessions', 'list'])
    const captures = new Set(PERSONA_CAPTURES.flatMap((p) => [p.paneCopy, p.transcriptCopy]))
    expect(outcomes.filter((o) => captures.has(o.name)).map((o) => [o.name, o.status])).toEqual([
      [A.paneCopy, 'failed'],
      [B.paneCopy, 'missing'],
      [C.paneCopy, 'missing'],
      [D.paneCopy, 'missing'],
      ...PERSONA_CAPTURES.map((p) => [p.transcriptCopy, 'failed']),
    ])
    expect(sink.writes).toEqual([])
  })

  /**
   * A container whose `tmux ls` answers `ls` (a timeout when `'timed out'`),
   * whose capture of a session in `stuckPanes` times out and of any other is
   * `pane <session>`, and whose logs and transcripts each hold one line.
   */
  function tmuxContainer(ls: ProcResult | 'timed out', stuckPanes: readonly string[] = []) {
    const calls: Array<{ what: string; timeoutMs: number | undefined }> = []
    return {
      calls,
      async exec(argv: readonly string[], options?: ExecOptions): Promise<ProcResult> {
        const what = argv[3] === 'read' || argv[3] === 'transcript' || argv[3] === 'pane' ? `${argv[3]} ${argv[4]}` : (argv[3] ?? '')
        calls.push({ what, timeoutMs: options?.timeoutMs })
        if (argv[3] === 'sessions') return ls === 'timed out' ? proc(124, '', true) : ls
        if (argv[3] === 'pane') return stuckPanes.includes(argv[4] ?? '') ? proc(124, '', true) : readOut(`pane ${argv[4]}\n`)
        if (argv[3] === 'list') return proc(0, '')
        if (argv[3] === 'transcript') return proc(0, `t.jsonl\n${Buffer.byteLength('{"n":1}\n')} 0\n{"n":1}\n`)
        return readOut('log line\n')
      },
    }
  }

  test(`a stuck tmux: tmux ls timing out (not "no server running") captures no pane, each noted; the logs, then the transcripts, are still copied; each tmux exec gets ${TMUX_EXEC_TIMEOUT_MS / 1000} s`, async () => {
    const container = tmuxContainer('timed out')
    const sink = memSink()
    const outcomes = await collectContainerLogs({ container, redactor: redactor(), sink, writable: () => true })
    expect(container.calls.map((c) => c.what)).toEqual([
      'sessions',
      'list',
      ...[SERVER_LOG, ...OTHER_LOG_FILES].map((f) => `read ${f.path}`),
      ...TRANSCRIPT_DIRS.map((dir) => `transcript ${dir}`),
    ])
    expect(container.calls[0]?.timeoutMs).toBe(TMUX_EXEC_TIMEOUT_MS)
    const notCaptured = 'not captured: tmux ls did not answer within 5 s'
    expect(outcomes.filter((o) => o.name.startsWith('pane-'))).toEqual(
      PERSONA_CAPTURES.map((p) => ({ name: p.paneCopy, path: `tmux session ${p.session}`, status: 'failed', reason: notCaptured })),
    )
    expect(sink.writes).toEqual(['server.log', ...OTHER_LOG_FILES.map((f) => f.name), ...PERSONA_CAPTURES.map((p) => p.transcriptCopy), CONTAINER_LOGS_INDEX])
    expect((sink.files.get(CONTAINER_LOGS_INDEX) ?? '').split('\n')).toContain(`${A.paneCopy}: not copied: ${notCaptured} (tmux session ${A.session})`)
  })

  test('a capture that times out captures no later pane; the ones before it are kept, and a session not listed is still not there', async () => {
    const container = tmuxContainer(proc(0, `${A.session}\n${B.session}\n${D.session}\n`), [B.session])
    const sink = memSink()
    const outcomes = await collectContainerLogs({ container, redactor: redactor(), sink, writable: () => true })
    expect(container.calls.slice(0, 4).map((c) => [c.what, c.timeoutMs])).toEqual([
      ['sessions', TMUX_EXEC_TIMEOUT_MS],
      [`pane ${A.session}`, TMUX_EXEC_TIMEOUT_MS],
      [`pane ${B.session}`, TMUX_EXEC_TIMEOUT_MS],
      ['list', CONTAINER_LOG_EXEC_TIMEOUT_MS],
    ])
    expect(outcomes.filter((o) => o.name.startsWith('pane-')).map((o) => [o.name, o.status, 'reason' in o ? o.reason : ''])).toEqual([
      [A.paneCopy, 'copied', ''],
      [B.paneCopy, 'failed', 'docker exec timed out'],
      [C.paneCopy, 'missing', ''],
      [D.paneCopy, 'failed', `not captured: the capture of ${B.paneCopy} did not answer within 5 s`],
    ])
    expect(sink.files.get(A.paneCopy)).toBe(`pane ${A.session}\n`)
    expect(sink.writes.slice(1, 2)).toEqual(['server.log'])
  })

  test('a tmux exec gets the smaller of 5 s and a shorter file time limit', async () => {
    const container = tmuxContainer(proc(0, `${A.session}\n`))
    await collectContainerLogs({ container, redactor: redactor(), sink: memSink(), writable: () => true, execTimeoutMs: 2_000 })
    expect(container.calls.slice(0, 3).map((c) => [c.what, c.timeoutMs])).toEqual([
      ['sessions', 2_000],
      [`pane ${A.session}`, 2_000],
      ['list', 2_000],
    ])
  })

  test("a pane and a transcript tail go through the redactor's wrap-aware pass (Claude Code's own hard wraps, which -J can't join); a log is redacted as one text", async () => {
    const r = redactor()
    // Split as Claude Code wraps a long line: a line break, then indentation or a `│ ` border. The token's second piece
    // (7 characters) shares no 10-character fragment with a registered value, so it gets a token's mask; `(end)` starts
    // with a character no token holds, so the token's mask stops before it.
    const hardWrapped = [`│ secret: ${SECRET.slice(0, 5)}`, `│ ${SECRET.slice(5)}`, `token: ${BOT.slice(0, 20)}`, `    ${BOT.slice(20)}`, '(end)', ''].join('\n')
    const masked = [`│ secret: ${REDACTED_SECRET}`, `│ ${REDACTED_SECRET}`, `token: ${REDACTED_TOKEN}`, `    ${REDACTED_TOKEN}`, '(end)', ''].join('\n')
    tmuxSessions(tmux, { [A.session]: hardWrapped })
    put(root, `${A.transcriptDir}/t.jsonl`, `{"cut":"${SECRET.slice(0, 12)}…"}\n`)
    // In a log, a token at a row's end does not take the next row's first word with it (the wrap-aware pass's over-masking).
    const log = `token ${BOT}\nnext line\n`
    put(root, STATE('server.log'), log)
    const sink = memSink()
    await collectContainerLogs({ container: bashContainer(root, tmux), redactor: r, sink, writable: () => true })
    expect(sink.files.get(A.paneCopy)).toBe(masked)
    expect(r.redact(hardWrapped)).not.toBe(masked)
    expect(sink.files.get(A.transcriptCopy)).toBe(`{"cut":"${REDACTED_SECRET}…"}\n`)
    expect(sink.files.get('server.log')).toBe(r.redact(log))
    expect(sink.files.get('server.log')).toBe(`token ${REDACTED_TOKEN}\nnext line\n`)
    assertNoLeak([...sink.files.values()])
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
    const container = bashContainer(root, tmux)
    const log = memLog()
    const sink = memSink()
    const collector = new ContainerLogCollector({ redactor: redactor(), sink, log, clock: createFakeClock() })
    await Promise.all([collector.collect(container, CONTAINER_LOGS_WAIT_MS), collector.collect(container, CONTAINER_LOGS_WAIT_MS)])
    await collector.collect(container, CONTAINER_LOGS_WAIT_MS)
    expect(container.calls.filter((c) => c.argv[3] === 'list' || c.argv[3] === 'sessions').length).toBe(2)
    const outcomes = collector.outcomes ?? []
    expect(outcomes.length).toBe(NONE_NOTED + 1 + OTHER_LOG_FILES.length)
    expect(log.lines).toEqual([
      `info container logs: 1 copied, ${NONE_NOTED + OTHER_LOG_FILES.length} not there, 0 skipped, 0 not copied (tmux panes: 0 of 4; transcript tails: 0 of 4), in ${sink.dir} (${CONTAINER_LOGS_INDEX} lists each)`,
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
    // One list and one read per file, however many callers (the sessions first, the transcripts last).
    expect(container.calls).toEqual(['sessions', 'list', SERVER_LOG.path, ...OTHER_LOG_FILES.map((f) => f.path), ...TRANSCRIPT_DIRS])
    expect(sink.writes).toEqual(['server.log', 'cron.log', CONTAINER_LOGS_INDEX])
    expect(sink.files.get('server.log')).toBe(`late ${REDACTED_SECRET}\n`)
    expect(log.lines.filter((l) => l.startsWith('error '))).toEqual([NOT_ALL_COPIED(15)])
    expect(log.lines[1]).toBe(
      `info container logs: 2 copied, ${NONE_NOTED + OTHER_LOG_FILES.length - 1} not there, 0 skipped, 0 not copied (tmux panes: 0 of 4; transcript tails: 0 of 4), in ${sink.dir} (${CONTAINER_LOGS_INDEX} lists each)`,
    )
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
    const container = bashContainer(root, tmux)
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
    await collector.collect(bashContainer(root, tmux), CONTAINER_LOGS_WAIT_MS)
    const dir = join(results, CONTAINER_LOGS_DIR)
    expect(readdirSync(dir).sort()).toEqual([CONTAINER_LOGS_INDEX, 'server.log'])
    expect(readFileSync(join(dir, 'server.log'), 'utf-8')).toBe(`x ${REDACTED_SECRET} ${REDACTED_TOKEN}\n`)
    assertNoLeak(writtenFile(dir))
  })
})
