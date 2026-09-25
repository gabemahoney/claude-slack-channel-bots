/**
 * jsonl-persistence-check.test.ts — Branch-matrix tests for the b.zak startup
 * JSONL-persistence safeguard (src/jsonl-persistence-check.ts), run over the
 * applied personas (b.av2 SR-6.2).
 *
 * Layer 1 (pure): resolveJsonlRoots dedup/precedence, checkMountFstype
 * longest-prefix + malformed/edge parsing, checkJsonlPersistence tmpfs/ramfs
 * classification.
 *
 * Layer 2 (per-persona via runJsonlPersistenceSafeguard with injected deps):
 * every classification branch — healthy, stale-path-loud, lost-loud (archive
 * evidence), idle-quiet, no-row skip, empty-session skip, AD-error-continue,
 * never-throws — plus the logged skip for a row the collision ladder will
 * replace (another cwd, or a missing or changed config_dir label). Notices go through the persona-keyed notice seam; some
 * cases wire it to the real per-persona notifier (b.av2 SR-7.2).
 *
 * Archive evidence (b.av2 SR-7.4): personaArchiveEvidenceScope and the real
 * makeDefaultArchiveCount against temp sqlite archives with several channels —
 * only a persona's `delivery: all` channels count, and a zero count is
 * inconclusive when the persona has a `mentions` channel or DMs on.
 *
 * All external effects are dependency-injected — no mock.module, no real /proc
 * reads. Files (archives, symlinks, homes) live only in mkdtempSync dirs
 * removed after each test.
 *
 * SPDX-License-Identifier: MIT
 */

import { describe, test, expect, afterEach, beforeEach, spyOn } from 'bun:test'
import { homedir, tmpdir } from 'node:os'
import { mkdtempSync, mkdirSync, symlinkSync, existsSync, chmodSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import type { GetResult } from 'agent-director'
import {
  resolveJsonlRoots,
  checkMountFstype,
  checkJsonlPersistence,
  runJsonlPersistenceSafeguard,
  runPersonaStorageCheck,
  makeDefaultArchiveCount,
  personaArchiveEvidenceScope,
  UNATTRIBUTABLE_ZERO_REASON,
  type JsonlPersistenceSafeguardDeps,
} from '../src/jsonl-persistence-check.ts'
import { resolveJsonlPath } from '../src/cozempic.ts'
import { personaInstanceId, renderPersonaRef } from '../src/persona-identity.ts'
import { personaConfigDirLabelValue } from '../src/session-manager.ts'
import { ErrSpawnNotFound } from '../src/agent-director-errors.ts'
import type { Persona, PersonaConfig } from '../src/config.ts'
import { buildTempArchiveDb, type ArchiveRow } from './test-helpers/archive-db.ts'
import { makeMultiPersonaConfig, type PersonaSpec } from './test-helpers/persona-config.ts'
import { makeNotifierHarness } from './test-helpers/persona-notifier.ts'
import { stubOpenedDmId } from './test-helpers/slack-stub.ts'
import { cannedGetResult } from './test-helpers/agent-director-stub.ts'

// ---------------------------------------------------------------------------
// Temp dirs, temp home and console capture — all released after each test
// ---------------------------------------------------------------------------

const cleanups: Array<() => void> = []

/** A fresh mkdtempSync dir, removed after the test. */
function makeTempDir(prefix = 'jsonl-check-test-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

/** Captures console.error lines for the rest of the test (restored after it). */
function captureErrorLog(): string[] {
  const lines: string[] = []
  const spy = spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    lines.push(args.map((a) => (a instanceof Error ? a.message : String(a))).join(' '))
  })
  cleanups.push(() => spy.mockRestore())
  return lines
}

/**
 * Home directory for the test: an unset claude_config_dir resolves under it,
 * and every row's `config_dir` label and the safeguard's `deps.home` use it.
 */
let home = ''

beforeEach(() => {
  home = makeTempDir('jsonl-check-home-')
})

afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!()
})

// ---------------------------------------------------------------------------
// Realistic multi-mount mountinfo fixture
//
// Format per kernel docs:
//   <mountid> <parentid> <major:minor> <root> <mountpoint> <mountopts>
//   [optional fields] - <fstype> <mountsource> <superopts>
// ---------------------------------------------------------------------------

const REALISTIC_MOUNTINFO = `\
23 0 8:1 / / rw,relatime shared:1 - ext4 /dev/sda1 rw,data=ordered
24 23 8:2 / /home rw,relatime shared:2 - ext4 /dev/sda2 rw,data=ordered
25 23 0:20 / /tmp rw,nosuid,nodev shared:3 - tmpfs tmpfs rw,size=4096m
26 23 0:21 / /dev/shm rw,nosuid,nodev shared:4 - tmpfs shm rw,size=65536k
27 23 0:22 / /run rw,nosuid,nodev,noexec shared:5 - tmpfs tmpfs rw
28 27 0:23 / /run/user/1000 rw,nosuid,nodev,relatime shared:6 - tmpfs tmpfs rw,size=8192k
31 23 0:25 / /var/lib/docker/overlay2/abc123/merged rw,relatime shared:9 - overlay overlay rw,lowerdir=/x
32 23 0:26 / /mnt/ramfs rw shared:10 - ramfs ramfs rw
`

const fixture = (content: string): (() => string) => () => content

// ---------------------------------------------------------------------------
// Layer 1 — resolveJsonlRoots (dedup + config-dir precedence)
// ---------------------------------------------------------------------------

describe('resolveJsonlRoots', () => {
  test('personas inheriting one top-level claude_config_dir dedup to one root', () => {
    const config = makeMultiPersonaConfig([{}, {}], makeTempDir(), { claude_config_dir: '/home/user/.claude-corp' })
    expect(resolveJsonlRoots(config, home)).toEqual(['/home/user/.claude-corp/projects'])
  })

  test('per-persona claude_config_dir takes precedence over the top-level one', () => {
    const config = makeMultiPersonaConfig(
      [{ claude_config_dir: '/home/user/.claude-a' }, {}], // second inherits the top level
      makeTempDir(),
      { claude_config_dir: '/home/user/.claude-global' },
    )
    const roots = resolveJsonlRoots(config, home)
    expect(roots).toHaveLength(2)
    expect(roots).toContain('/home/user/.claude-a/projects')
    expect(roots).toContain('/home/user/.claude-global/projects')
  })

  test('two personas sharing a per-persona dir dedup to one root', () => {
    const config = makeMultiPersonaConfig(
      [{ claude_config_dir: '/home/user/.claude-shared' }, { claude_config_dir: '/home/user/.claude-shared' }],
      makeTempDir(),
    )
    expect(resolveJsonlRoots(config, home)).toEqual(['/home/user/.claude-shared/projects'])
  })

  test('no config dir anywhere → <home>/.claude default', () => {
    const config = makeMultiPersonaConfig([{}], makeTempDir())
    expect(resolveJsonlRoots(config, home)).toEqual([`${home}/.claude/projects`])
  })

  test('zero personas → <home>/.claude default fallback', () => {
    const config = makeMultiPersonaConfig([], makeTempDir())
    expect(resolveJsonlRoots(config, home)).toEqual([`${home}/.claude/projects`])
  })

  test('home omitted → the OS home default', () => {
    const config = makeMultiPersonaConfig([{}], makeTempDir())
    expect(resolveJsonlRoots(config)).toEqual([join(homedir(), '.claude', 'projects')])
  })
})

// ---------------------------------------------------------------------------
// Layer 1 — checkMountFstype (longest-prefix + malformed/edge parsing)
// ---------------------------------------------------------------------------

describe('checkMountFstype', () => {
  test.each([
    ['/tmp/some/path/to/dir', 'tmpfs', 'nested under /tmp tmpfs'],
    ['/home/user/.claude/projects', 'ext4', 'nested under /home ext4'],
    ['/var/data', 'ext4', 'falls through to root ext4'],
    ['/var/lib/docker/overlay2/abc123/merged/ws', 'overlay', 'nested under overlay'],
    ['/mnt/ramfs/data', 'ramfs', 'nested under ramfs'],
    ['/run/user/1000/dir', 'tmpfs', 'deepest of two tmpfs mounts wins'],
    ['/home', 'ext4', 'exact mount-point match'],
    ['/', 'ext4', 'root path'],
  ])('%s → %s (%s)', (path, expected) => {
    expect(checkMountFstype(path, fixture(REALISTIC_MOUNTINFO))).toBe(expected)
  })

  test('trailing slash is normalised — same result as without', () => {
    expect(checkMountFstype('/tmp/', fixture(REALISTIC_MOUNTINFO))).toBe(
      checkMountFstype('/tmp', fixture(REALISTIC_MOUNTINFO)),
    )
  })

  test('null when no mount (not even root) covers the path', () => {
    const noRoot = '24 23 8:2 / /home rw,relatime shared:2 - ext4 /dev/sda2 rw\n'
    expect(checkMountFstype('/no/matching/mount', fixture(noRoot))).toBeNull()
  })

  test.each([
    ['', 'empty content'],
    ['this is not mountinfo\nneither is this\n', 'only garbage lines'],
  ])('null (does not throw) for %s (%s)', (content) => {
    expect(() => checkMountFstype('/some/path', fixture(content))).not.toThrow()
    expect(checkMountFstype('/some/path', fixture(content))).toBeNull()
  })

  test('null (does not throw) when the reader itself throws', () => {
    const throws = (): string => { throw new Error('EACCES: permission denied') }
    expect(() => checkMountFstype('/some/path', throws)).not.toThrow()
    expect(checkMountFstype('/some/path', throws)).toBeNull()
  })

  test('line missing the " - " separator is skipped, valid line still matches', () => {
    const bad = '23 0 8:1 / / rw,relatime shared:1 ext4 /dev/sda1 rw\n'
    const content = `${bad}24 23 8:2 / /home rw,relatime shared:2 - ext4 /dev/sda2 rw\n`
    expect(checkMountFstype('/home/user', fixture(content))).toBe('ext4')
  })
})

// ---------------------------------------------------------------------------
// Layer 1 — checkJsonlPersistence (tmpfs/ramfs classification)
// ---------------------------------------------------------------------------

describe('checkJsonlPersistence', () => {
  const configForDir = (dir: string): PersonaConfig =>
    makeMultiPersonaConfig([{ claude_config_dir: dir }], makeTempDir())

  test('tmpfs root → nonPersistent, no warnings', () => {
    const r = checkJsonlPersistence(configForDir('/tmp/claude'), fixture(REALISTIC_MOUNTINFO), home)
    expect(r.nonPersistent).toEqual(['/tmp/claude/projects'])
    expect(r.warnings).toEqual([])
  })

  test('ramfs root → nonPersistent, no warnings', () => {
    const r = checkJsonlPersistence(configForDir('/mnt/ramfs/claude'), fixture(REALISTIC_MOUNTINFO), home)
    expect(r.nonPersistent).toEqual(['/mnt/ramfs/claude/projects'])
    expect(r.warnings).toEqual([])
  })

  test('ext4 root → neither nonPersistent nor warnings', () => {
    const r = checkJsonlPersistence(configForDir('/home/user/.claude'), fixture(REALISTIC_MOUNTINFO), home)
    expect(r.nonPersistent).toEqual([])
    expect(r.warnings).toEqual([])
  })

  test('reader throws → warnings (not nonPersistent), does not throw', () => {
    const throws = (): string => { throw new Error('ENOENT') }
    const r = checkJsonlPersistence(configForDir('/home/user/.claude'), throws, home)
    expect(r.nonPersistent).toEqual([])
    expect(r.warnings).toEqual(['/home/user/.claude/projects'])
  })

  test('unresolvable mount (no root line) → warnings', () => {
    const noRoot = '24 23 8:2 / /home rw,relatime shared:2 - ext4 /dev/sda2 rw\n'
    const r = checkJsonlPersistence(configForDir('/no/matching/mount'), fixture(noRoot), home)
    expect(r.nonPersistent).toEqual([])
    expect(r.warnings).toEqual(['/no/matching/mount/projects'])
  })

  test('multi-root mixed: tmpfs + ext4 classified independently', () => {
    const config = makeMultiPersonaConfig(
      [{ claude_config_dir: '/tmp/claude-tmp' }, { claude_config_dir: '/home/user/.claude-ext4' }],
      makeTempDir(),
    )
    const r = checkJsonlPersistence(config, fixture(REALISTIC_MOUNTINFO), home)
    expect(r.nonPersistent).toEqual(['/tmp/claude-tmp/projects'])
    expect(r.warnings).toEqual([])
  })

  test('never throws with zero personas (home default fallback path)', () => {
    const config = makeMultiPersonaConfig([], makeTempDir())
    expect(() => checkJsonlPersistence(config, fixture(REALISTIC_MOUNTINFO), home)).not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// Layer 2 — runJsonlPersistenceSafeguard per-persona classification
//
// A single persona is exercised at a time. Layer 1 is neutered by supplying a
// readMountinfo fixture whose root is ext4 (never nonPersistent), so recorded
// errors come only from Layer 2. Rows carry the persona's `cwd` and matching
// `config_dir` label (cannedGetResult's persona form under the test's home),
// so they reach the transcript check rather than the collision-ladder skip.
// ---------------------------------------------------------------------------

const CH = 'C_TEST1'
const CONFIG_DIR = '/home/user/.claude' // ext4 in REALISTIC_MOUNTINFO → no Layer-1 noise
const STARTED_AT = '2026-09-20T05:00:00Z'
const STALE_PATH = '/some/other/stale/path.jsonl'

/** The one Layer-2 persona: its working directory yields the `-repo-app` project dir. */
const LAYER2_SPEC: PersonaSpec = {
  name: 'Layer Two Bot',
  working_directory: '/repo/app',
  claude_config_dir: CONFIG_DIR,
  channels: [{ id: CH, delivery: 'all' }],
  permission_prompts: CH,
}

function layer2Config(overrides: Partial<Omit<PersonaConfig, 'personas'>> = {}): PersonaConfig {
  return makeMultiPersonaConfig([LAYER2_SPEC], makeTempDir(), overrides)
}

function layer2Persona(): Persona {
  return layer2Config().personas[0]!
}

/**
 * GetResult fixture with the fields Layer 2 reads, as a spawn of `persona`
 * writes it under the test's home; overridable.
 */
function makeRow(overrides: Partial<GetResult> = {}, persona: Persona = layer2Persona()): GetResult {
  return cannedGetResult(
    {
      state: 'live',
      jsonl_path: `${CONFIG_DIR}/projects/-repo-app/sess-abc.jsonl`,
      claude_session_id: 'sess-abc',
      started_at: STARTED_AT,
      last_seen_at: '2026-09-20T05:10:00Z',
      ...overrides,
    },
    persona,
    home,
  )
}

interface Captured {
  errors: Array<{ key: string; message: string }>
  /** Notices raised through the notice seam: persona key and notice body. */
  notices: Array<{ key: string; text: string }>
}

/**
 * Runs the safeguard with fully-injected deps; returns captured loud signals.
 *
 * `config` overrides the default single-persona Layer-2 config. `withNotify`
 * defaults true (a capturing notice seam); pass false for no seam at all
 * (notify undefined → no notices). Any dep in `deps` overrides the
 * defaults below — including archiveCountSince, so a test can drop it to
 * exercise the REAL makeDefaultArchiveCount against a temp DB.
 */
async function runLayer2(
  deps: Partial<JsonlPersistenceSafeguardDeps>,
  config: PersonaConfig = layer2Config(),
  withNotify = true,
): Promise<Captured> {
  const captured: Captured = { errors: [], notices: [] }
  const notify = withNotify
    ? (key: string, text: string): void => {
        captured.notices.push({ key, text })
      }
    : undefined
  const fullDeps: JsonlPersistenceSafeguardDeps = {
    readMountinfo: fixture(REALISTIC_MOUNTINFO),
    statFn: () => false,
    getRow: async () => makeRow(),
    archiveCountSince: () => null,
    recordStartupError: (key: string, message: string) => {
      captured.errors.push({ key, message })
    },
    home,
    ...deps,
  }
  await runJsonlPersistenceSafeguard(config, notify, fullDeps)
  return captured
}

describe('runJsonlPersistenceSafeguard — Layer 2 classification', () => {
  test('looks up the row by cscb_<key>, the persona key (b.av2 SR-2.2)', async () => {
    const persona = layer2Persona()
    const lookups: Array<[string, string]> = []
    await runLayer2({
      getRow: async (key: string, claudeInstanceId: string) => {
        lookups.push([key, claudeInstanceId])
        return makeRow()
      },
    })
    expect(lookups).toEqual([[persona.key, personaInstanceId(persona.key)]])
    expect(lookups[0][1]).toBe(`cscb_${persona.key}`)
  })

  test('healthy: persisted path exists → quiet (no error, no notice)', async () => {
    const persisted = makeRow().jsonl_path
    const c = await runLayer2({ statFn: (p) => p === persisted })
    expect(c.errors).toEqual([])
    expect(c.notices).toEqual([])
  })

  test('stale-path: persisted missing but fallback exists → LOUD record + persona notice', async () => {
    const row = makeRow()
    const fallback = resolveJsonlPath(row.cwd, row.claude_session_id, CONFIG_DIR)
    // Persisted path differs from fallback so persisted stat is false, fallback true.
    const staleRow = makeRow({ jsonl_path: STALE_PATH })
    const c = await runLayer2({
      getRow: async () => staleRow,
      statFn: (p) => p === fallback,
    })
    expect(c.errors).toHaveLength(1)
    expect(c.errors[0]!.key).toBe('jsonl-transcript-stale-path')
    expect(c.notices).toHaveLength(1)
    expect(c.notices[0]!.key).toBe(layer2Persona().key)
    expect(c.notices[0]!.text).toContain(fallback)
    expect(c.notices[0]!.text).not.toContain('this channel')
  })

  test('lost: both paths missing but archive shows activity since spawn → LOUD record + persona notice', async () => {
    const c = await runLayer2({
      statFn: () => false,
      archiveCountSince: () => 5,
    })
    expect(c.errors).toHaveLength(1)
    expect(c.errors[0]!.key).toBe('jsonl-transcript-lost')
    expect(c.errors[0]!.message).toContain('5 message')
    expect(c.notices).toHaveLength(1)
    expect(c.notices[0]!.key).toBe(layer2Persona().key)
    expect(c.notices[0]!.text).toContain('5 message(s)')
    expect(c.notices[0]!.text).not.toContain('this channel')
  })

  test('idle-since-spawn: both missing, archive count 0 → quiet (no error, no notice)', async () => {
    const c = await runLayer2({ statFn: () => false, archiveCountSince: () => 0 })
    expect(c.errors).toEqual([])
    expect(c.notices).toEqual([])
  })

  test('idle-since-spawn: both missing, archive unconfigured/unreadable (null) → quiet', async () => {
    const c = await runLayer2({ statFn: () => false, archiveCountSince: () => null })
    expect(c.errors).toEqual([])
    expect(c.notices).toEqual([])
  })

  test('no AD row (ErrSpawnNotFound) → quiet skip', async () => {
    const c = await runLayer2({
      getRow: async () => { throw new ErrSpawnNotFound('get', 'ErrSpawnNotFound', 'not found') },
    })
    expect(c.errors).toEqual([])
    expect(c.notices).toEqual([])
  })

  test('row present but empty claude_session_id → quiet skip (nothing to resume)', async () => {
    const c = await runLayer2({ getRow: async () => makeRow({ claude_session_id: '' }) })
    expect(c.errors).toEqual([])
    expect(c.notices).toEqual([])
  })

  test('non-ErrSpawnNotFound AD error → warn + continue (quiet, does not throw)', async () => {
    const c = await runLayer2({
      getRow: async () => { throw new Error('AD unreachable') },
    })
    expect(c.errors).toEqual([])
    expect(c.notices).toEqual([])
  })

  test('per-persona error inside classification is isolated — the next persona is still checked, sweep never throws', async () => {
    // statFn throws for Boom Bot (checked first); the per-persona try/catch
    // must swallow it so Safe Bot is still checked and still goes loud.
    const config = makeMultiPersonaConfig(
      [
        { name: 'Boom Bot', working_directory: '/repo/boom' },
        { name: 'Safe Bot', working_directory: '/repo/safe' },
      ],
      makeTempDir(),
      { claude_config_dir: CONFIG_DIR },
    )
    const [boom, safe] = config.personas
    expect([boom!.name, safe!.name]).toEqual(['Boom Bot', 'Safe Bot'])
    const byKey = new Map(config.personas.map((p) => [p.key, p]))
    const safePaths: string[] = []
    const log = captureErrorLog()
    const c = await runLayer2(
      {
        getRow: async (key: string) => makeRow({}, byKey.get(key)!),
        statFn: (p) => {
          if (p.includes('-repo-boom')) throw new Error('boom')
          if (p.includes('-repo-safe')) safePaths.push(p)
          return false
        },
        archiveCountSince: (_ids, _since, ref) => (ref === renderPersonaRef(safe!.name, safe!.key) ? 2 : 0),
      },
      config,
    )
    // Boom Bot's error was caught and logged against Boom Bot.
    expect(log.filter((l) => l.includes(`unexpected error checking ${renderPersonaRef(boom!.name, boom!.key)}`))).toHaveLength(1)
    // Safe Bot's own fallback path was checked and its loss recorded and noticed.
    expect(safePaths).toHaveLength(1)
    expect(c.errors.map((e) => e.key)).toEqual(['jsonl-transcript-lost'])
    expect(c.errors[0]!.message).toContain(renderPersonaRef(safe!.name, safe!.key))
    expect(c.notices.map((n) => n.key)).toEqual([safe!.key])
  })

  test('persona with no claude_config_dir: its JSONL root, fallback path and row label resolve under deps.home', async () => {
    const config = makeMultiPersonaConfig([{ ...LAYER2_SPEC, claude_config_dir: undefined }], makeTempDir())
    const persona = config.personas[0]!
    const staleRow = makeRow({ jsonl_path: STALE_PATH }, persona)
    const fallback = resolveJsonlPath(staleRow.cwd, staleRow.claude_session_id, join(home, '.claude'))
    // Only the temp home is tmpfs, so Layer 1 flags exactly the root under it.
    const homeTmpfs = `23 0 8:1 / / rw,relatime shared:1 - ext4 /dev/sda1 rw\n25 23 0:20 / ${home} rw shared:3 - tmpfs tmpfs rw\n`
    const c = await runLayer2(
      { readMountinfo: fixture(homeTmpfs), getRow: async () => staleRow, statFn: (p) => p === fallback },
      config,
    )
    expect(c.errors.map((e) => e.key)).toEqual(['jsonl-non-persistent', 'jsonl-transcript-stale-path'])
    expect(c.errors[0]!.message).toContain(`root="${home}/.claude/projects"`)
    expect(c.notices.map((n) => n.key)).toEqual([persona.key, persona.key])
    expect(c.notices[1]!.text).toContain(fallback)
  })

  test('notify undefined (no notice seam): loud error still recorded, no notice', async () => {
    const c = await runLayer2({ statFn: () => false, archiveCountSince: () => 3 }, layer2Config(), false)
    expect(c.errors).toHaveLength(1)
    expect(c.errors[0]!.key).toBe('jsonl-transcript-lost')
    expect(c.notices).toEqual([]) // notify undefined → no notice
  })
})

// ---------------------------------------------------------------------------
// Layer 2 iterates personas, not channels (b.av2 SR-6.2, SR-7.4)
// ---------------------------------------------------------------------------

describe('runJsonlPersistenceSafeguard — one pass per persona', () => {
  test('a persona in several channels gets one row lookup, one count over its `all` channels, one notice', async () => {
    const config = makeMultiPersonaConfig(
      [
        {
          ...LAYER2_SPEC,
          channels: [
            { id: 'C0ALL0001', delivery: 'all' },
            { id: 'C0ALL0002', delivery: 'all' },
            { id: 'C0MENT001', delivery: 'mentions' },
          ],
          permission_prompts: 'C0ALL0001',
        },
      ],
      makeTempDir(),
    )
    const persona = config.personas[0]!
    const h = makeNotifierHarness(config)
    const lookups: Array<[string, string]> = []
    const counts: Array<[readonly string[], number, string]> = []
    const errors: string[] = []
    await runJsonlPersistenceSafeguard(config, h.notifier.notify, {
      readMountinfo: fixture(REALISTIC_MOUNTINFO),
      statFn: () => false,
      getRow: async (key, id) => {
        lookups.push([key, id])
        return makeRow({}, persona)
      },
      archiveCountSince: (ids, since, ref) => {
        counts.push([[...ids], since, ref])
        return 3
      },
      recordStartupError: (key) => {
        errors.push(key)
      },
      home,
    })
    expect(lookups).toEqual([[persona.key, `cscb_${persona.key}`]])
    expect(counts).toEqual([
      [['C0ALL0001', 'C0ALL0002'], Date.parse(STARTED_AT) / 1000, renderPersonaRef(persona.name, persona.key)],
    ])
    expect(errors).toEqual(['jsonl-transcript-lost'])
    const posts = h.posts(persona.key)
    expect(posts).toHaveLength(1)
    expect(posts[0]!.channel).toBe('C0ALL0001')
    expect(posts[0]!.text).toContain('3 message(s)')
  })
})

// ---------------------------------------------------------------------------
// Rows the collision ladder will replace rather than resume or reconnect
// (compareRowToPersona: cwd real path, config_dir label) — logged only. The
// skip line is found by the persona reference plus the reason text, so the
// "stays loud" rows' empty-match checks cannot pass on a reworded ending.
// ---------------------------------------------------------------------------

describe('runJsonlPersistenceSafeguard — rows the collision ladder will replace', () => {
  type RowKind = 'other-cwd' | 'empty-cwd' | 'absent-cwd' | 'no-label' | 'wrong-label' | 'matching' | 'symlinked-cwd'
  type Condition = 'fallback exists' | 'archived rows since spawn'

  /** The reason texts of the skip line (rowReplacementReason): one per guard. */
  const SKIP_REASONS = ['differs from working_directory', 'config_dir label']

  /** A persona whose working directory really exists, plus a sibling dir and a symlink to it. */
  function ladderFixture(): { config: PersonaConfig; persona: Persona; otherWork: string; link: string } {
    const dir = makeTempDir()
    const work = join(dir, 'work')
    const otherWork = join(dir, 'other-work')
    const link = join(dir, 'work-link')
    mkdirSync(work)
    mkdirSync(otherWork)
    symlinkSync(work, link)
    const config = makeMultiPersonaConfig([{ ...LAYER2_SPEC, working_directory: work }], dir)
    return { config, persona: config.personas[0]!, otherWork, link }
  }

  function rowFor(kind: RowKind, fx: ReturnType<typeof ladderFixture>): GetResult {
    const base = makeRow({ jsonl_path: STALE_PATH }, fx.persona)
    const { config_dir: _label, ...labelsWithout } = base.labels
    switch (kind) {
      case 'other-cwd':
        return { ...base, cwd: fx.otherWork }
      case 'empty-cwd':
        return { ...base, cwd: '' }
      case 'absent-cwd': {
        const { cwd: _cwd, ...withoutCwd } = base
        return withoutCwd as GetResult
      }
      case 'no-label':
        return { ...base, labels: labelsWithout }
      case 'wrong-label':
        return { ...base, labels: { ...labelsWithout, config_dir: personaConfigDirLabelValue('/home/user/.claude-other', home) } }
      case 'matching':
        return base
      case 'symlinked-cwd':
        return { ...base, cwd: fx.link }
    }
  }

  /** Deps that would make a matching row loud under `condition`. */
  function loudDeps(condition: Condition): Partial<JsonlPersistenceSafeguardDeps> {
    return condition === 'fallback exists'
      ? { statFn: (p) => p !== STALE_PATH, archiveCountSince: () => null }
      : { statFn: () => false, archiveCountSince: () => 4 }
  }

  async function run(kind: RowKind, condition: Condition) {
    const fx = ladderFixture()
    const h = makeNotifierHarness(fx.config)
    const errors: string[] = []
    const log = captureErrorLog()
    await runJsonlPersistenceSafeguard(fx.config, h.notifier.notify, {
      readMountinfo: fixture(REALISTIC_MOUNTINFO),
      getRow: async () => rowFor(kind, fx),
      recordStartupError: (key) => {
        errors.push(key)
      },
      home,
      ...loudDeps(condition),
    })
    const ref = renderPersonaRef(fx.persona.name, fx.persona.key)
    const ladderLines = log.filter((l) => l.includes(ref) && SKIP_REASONS.some((r) => l.includes(r)))
    return { fx, h, errors, log, ladderLines }
  }

  test.each([
    ['other-cwd', 'fallback exists', 'differs from working_directory'],
    ['other-cwd', 'archived rows since spawn', 'differs from working_directory'],
    // No cwd on the row (empty or absent): printed as `<none>`.
    ['empty-cwd', 'fallback exists', 'row cwd=<none> differs from working_directory='],
    ['absent-cwd', 'archived rows since spawn', 'row cwd=<none> differs from working_directory='],
    ['no-label', 'fallback exists', 'config_dir label missing'],
    ['no-label', 'archived rows since spawn', 'config_dir label missing'],
    ['wrong-label', 'fallback exists', 'config_dir label was='],
    ['wrong-label', 'archived rows since spawn', 'config_dir label was='],
  ] as Array<[RowKind, Condition, string]>)(
    '%s row, %s → one log line, no record, no notice',
    async (kind, condition, reason) => {
      const { fx, h, errors, log, ladderLines } = await run(kind, condition)
      expect(errors).toEqual([])
      expect(h.totalPosts()).toBe(0)
      expect(ladderLines).toHaveLength(1)
      expect(ladderLines[0]).toContain(renderPersonaRef(fx.persona.name, fx.persona.key))
      expect(ladderLines[0]).toContain(reason)
      // A row with no cwd prints `<none>`, never `undefined`.
      expect(log.filter((l) => l.includes('cwd=undefined'))).toEqual([])
      // The transcript was never checked.
      expect(log.filter((l) => l.includes('no transcript'))).toEqual([])
    },
  )

  test.each([
    ['matching', 'fallback exists', 'jsonl-transcript-stale-path'],
    ['matching', 'archived rows since spawn', 'jsonl-transcript-lost'],
    ['symlinked-cwd', 'fallback exists', 'jsonl-transcript-stale-path'],
    ['symlinked-cwd', 'archived rows since spawn', 'jsonl-transcript-lost'],
  ] as Array<[RowKind, Condition, string]>)('%s row, %s → stays loud (%s + one notice)', async (kind, condition, key) => {
    const { fx, h, errors, ladderLines } = await run(kind, condition)
    expect(errors).toEqual([key])
    expect(h.posts(fx.persona.key)).toHaveLength(1)
    expect(ladderLines).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Notice seam wired to the real per-persona notifier (b.av2 SR-7.2)
// ---------------------------------------------------------------------------

describe('runJsonlPersistenceSafeguard — real per-persona notifier', () => {
  test("stale-path notice for A posts once, on A's client, to A's destination, with A's reference; nothing on B's", async () => {
    const personaConfig = makeMultiPersonaConfig([{ name: 'Alpha Bot' }, { name: 'Beta Bot' }], makeTempDir(), {
      claude_config_dir: CONFIG_DIR,
    })
    const a = personaConfig.personas[0]!
    const b = personaConfig.personas[1]!
    // The persona key is distinct from the destination channel, so a notice
    // addressed to the channel ID instead of the key would be dropped.
    expect(a.key).not.toBe(a.permission_prompts)
    const h = makeNotifierHarness(personaConfig)

    const staleRow = makeRow({ jsonl_path: STALE_PATH }, a)
    const fallback = resolveJsonlPath(staleRow.cwd, staleRow.claude_session_id, CONFIG_DIR)
    await runJsonlPersistenceSafeguard(personaConfig, h.notifier.notify, {
      readMountinfo: fixture(REALISTIC_MOUNTINFO),
      statFn: (p) => p === fallback,
      getRow: async (key) => {
        if (key === a.key) return staleRow
        throw new ErrSpawnNotFound('get', 'ErrSpawnNotFound', 'x')
      },
      archiveCountSince: () => null,
      recordStartupError: () => {},
      home,
    })

    const aPosts = h.posts(a.key)
    expect(aPosts).toHaveLength(1)
    expect(aPosts[0]!.channel).toBe(a.permission_prompts)
    expect(aPosts[0]!.text).toContain(renderPersonaRef(a.name, a.key))
    expect(aPosts[0]!.text).toContain(fallback)
    expect(h.posts(b.key)).toEqual([])
    // Posted, not dropped, dry-run or failed: the notifier logged nothing.
    expect(h.logs).toEqual([])
  })

  test("non-persistent-storage warning: a dm persona gets it once in its DM with its contact, on its own client, with the channel persona's text; nothing on the persona off the tmpfs root", async () => {
    const contact = 'U0DELTADM'
    // A (channel) and D (dm) share the tmpfs root /tmp/claude; B is on ext4.
    const config = makeMultiPersonaConfig(
      [
        { name: 'Alpha Bot', claude_config_dir: '/tmp/claude' },
        { name: 'Delta Bot', channels: [], dm: { enabled: true, contact }, permission_prompts: 'dm', claude_config_dir: '/tmp/claude' },
        { name: 'Beta Bot', claude_config_dir: '/home/user/.claude' },
      ],
      makeTempDir(),
    )
    const [a, d, b] = config.personas as [Persona, Persona, Persona]
    const h = makeNotifierHarness(config)
    // Collect the notifier's pending deliveries: a DM post settles only after its conversations.open.
    const pending: Promise<void>[] = []
    const errors: string[] = []
    await runJsonlPersistenceSafeguard(config, (key, text, options) => {
      const p = h.notifier.notify(key, text, options)
      pending.push(p)
      return p
    }, {
      readMountinfo: fixture(REALISTIC_MOUNTINFO),
      statFn: () => true,
      getRow: async () => {
        throw new ErrSpawnNotFound('get', 'ErrSpawnNotFound', 'x')
      },
      archiveCountSince: () => null,
      recordStartupError: (key) => {
        errors.push(key)
      },
      home,
    })
    await Promise.all(pending)

    expect(errors).toEqual(['jsonl-non-persistent'])
    // D: one open with its contact, then one post to the returned D… conversation, both on D's client.
    const dStub = h.stub(d.key)
    expect(dStub.web.callLog.map((c) => c.method)).toEqual(['conversations.open', 'chat.postMessage'])
    expect(dStub.calls.conversationsOpen).toEqual([{ users: contact }])
    const dPosts = h.posts(d.key)
    expect(dPosts).toHaveLength(1)
    expect(Object.keys(dPosts[0]!).sort()).toEqual(['channel', 'text'])
    expect(dPosts[0]!.channel).toBe(stubOpenedDmId(contact))
    const refD = renderPersonaRef(d.name, d.key)
    expect(dPosts[0]!.text).toContain(refD)
    expect(dPosts[0]!.text).toContain('/tmp/claude/projects')
    expect(dPosts[0]!.text).toMatch(/non-persistent filesystem/)
    // A (channel destination) is unchanged: one post to its channel, no open.
    expect(h.stub(a.key).web.callLog.map((c) => c.method)).toEqual(['chat.postMessage'])
    const aPosts = h.posts(a.key)
    expect(aPosts).toEqual([{ channel: a.permission_prompts, text: expect.any(String) }])
    // Same notice text for either destination, apart from the persona reference.
    const refA = renderPersonaRef(a.name, a.key)
    expect(dPosts[0]!.text.replace(refD, '<ref>')).toBe(aPosts[0]!.text.replace(refA, '<ref>'))
    expect(dPosts[0]!.text).not.toContain(refA)
    // B is off the flagged root: nothing on its client.
    expect(h.stub(b.key).callLog).toEqual([])
    expect(h.logs).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Layer 1 loud path through the orchestrator
// ---------------------------------------------------------------------------

describe('runJsonlPersistenceSafeguard — Layer 1 loud path', () => {
  // Layer-2 healthy (statFn true) and no AD rows → the only signals are Layer 1's.
  const quietLayer2: Partial<JsonlPersistenceSafeguardDeps> = {
    statFn: () => true,
    getRow: async () => { throw new ErrSpawnNotFound('get', 'ErrSpawnNotFound', 'x') },
  }

  test('tmpfs root → jsonl-non-persistent recorded + one notice per persona on that root', async () => {
    const config = makeMultiPersonaConfig(
      [
        { name: 'A', claude_config_dir: '/tmp/claude' },
        { name: 'B', claude_config_dir: '/tmp/claude' },
      ],
      makeTempDir(),
    )
    const [a, b] = config.personas
    const c = await runLayer2(quietLayer2, config)
    const nonPersistent = c.errors.filter((e) => e.key === 'jsonl-non-persistent')
    expect(nonPersistent).toHaveLength(1)
    // One notice per persona key whose effective root is flagged (both A and B).
    expect(c.notices.map((n) => n.key).sort()).toEqual([a!.key, b!.key].sort())
    for (const n of c.notices) expect(n.text).not.toContain('this channel')
  })

  test('mixed roots: notice goes ONLY to personas on the flagged tmpfs root; record fires once', async () => {
    // Two personas with different effective JSONL roots; only /tmp/claude is tmpfs.
    // A → /tmp/claude/projects (tmpfs, flagged). B → /home/user/.claude/projects (ext4, clean).
    const config = makeMultiPersonaConfig(
      [
        { name: 'A', claude_config_dir: '/tmp/claude' },
        { name: 'B', claude_config_dir: '/home/user/.claude' },
      ],
      makeTempDir(),
    )
    const c = await runLayer2(quietLayer2, config)
    const nonPersistent = c.errors.filter((e) => e.key === 'jsonl-non-persistent')
    // recordStartupError fires once per flagged root (one tmpfs root here).
    expect(nonPersistent).toHaveLength(1)
    expect(nonPersistent[0]!.message).toContain('/tmp/claude/projects')
    // The notice targets ONLY the persona whose effective root is the flagged root.
    expect(c.notices.map((n) => n.key)).toEqual([config.personas[0]!.key])
    expect(c.notices[0]!.text).toContain('/tmp/claude/projects')
    expect(c.notices[0]!.text).not.toContain('this channel')
  })

  test('unresolvable root → jsonl-persistence-check-warning recorded, no notice', async () => {
    const config = makeMultiPersonaConfig([{ name: 'A', claude_config_dir: '/no/matching/mount' }], makeTempDir())
    const noRoot = '24 23 8:2 / /home rw,relatime shared:2 - ext4 /dev/sda2 rw\n'
    const c = await runLayer2({ ...quietLayer2, readMountinfo: fixture(noRoot) }, config)
    expect(c.errors.map((e) => e.key)).toContain('jsonl-persistence-check-warning')
    expect(c.notices).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// makeDefaultArchiveCount — real temp-sqlite coverage (exercised through the
// safeguard's default archiveCountSince, i.e. NO archiveCountSince injected).
//
// STARTED_AT '2026-09-20T05:00:00Z' → the spawn boundary in epoch seconds. The
// default counter reads config.message_archive_db read-only and counts
// messages in the persona's `all` channels WHERE timestamp > boundary. A
// positive count surfaces as a loud jsonl-transcript-lost record whose message
// embeds the exact count; 0 / null (unconfigured, missing, corrupt) stay
// quiet. statFn is forced false so Layer 2 always reaches the archive-count
// branch.
// ---------------------------------------------------------------------------

const SPAWN_EPOCH = Date.parse(STARTED_AT) / 1000 // 2026-09-20T05:00:00Z

/** Builds a temp archive DB with the given (timestamp, channel) rows; returns its path. */
function makeArchiveDb(rows: ArchiveRow[]): string {
  const built = buildTempArchiveDb(rows, CH)
  cleanups.push(built.cleanup)
  return built.dbPath
}

/** Config whose message_archive_db points at dbPath (undefined → unconfigured). */
function archiveConfig(dbPath: string | undefined): PersonaConfig {
  return layer2Config({ message_archive_db: dbPath })
}

describe('makeDefaultArchiveCount (real temp sqlite, via default archiveCountSince)', () => {
  test('unconfigured message_archive_db → null → quiet (no loud lost signal)', async () => {
    const c = await runLayer2({ statFn: () => false, archiveCountSince: undefined }, archiveConfig(undefined))
    expect(c.errors).toEqual([])
    expect(c.notices).toEqual([])
  })

  test('missing DB file → null → quiet AND the file is not created', async () => {
    const dbPath = join(makeTempDir('jsonl-archive-test-'), 'does-not-exist.db')
    const c = await runLayer2({ statFn: () => false, archiveCountSince: undefined }, archiveConfig(dbPath))
    expect(c.errors).toEqual([])
    expect(c.notices).toEqual([])
    // Read-only counter must never fabricate an empty archive on disk.
    expect(existsSync(dbPath)).toBe(false)
  })

  test('existing DB → counts only rows strictly after the spawn boundary (> excludes the boundary row)', async () => {
    // 1 before, 1 exactly at the boundary (excluded by >), 3 after, plus 1 after
    // for a DIFFERENT channel (must not be counted). Expected count for CH = 3.
    const dbPath = makeArchiveDb([
      { ts: SPAWN_EPOCH - 10 },
      { ts: SPAWN_EPOCH }, // exactly at boundary → excluded
      { ts: SPAWN_EPOCH + 1 },
      { ts: SPAWN_EPOCH + 100 },
      { ts: SPAWN_EPOCH + 9999 },
      { ts: SPAWN_EPOCH + 5, channel: 'OTHER_CH' },
    ])
    const c = await runLayer2({ statFn: () => false, archiveCountSince: undefined }, archiveConfig(dbPath))
    expect(c.errors).toHaveLength(1)
    expect(c.errors[0]!.key).toBe('jsonl-transcript-lost')
    expect(c.errors[0]!.message).toContain('3 message(s)')
    expect(c.notices).toHaveLength(1)
    expect(c.notices[0]!.key).toBe(layer2Persona().key)
    expect(c.notices[0]!.text).toContain('3 message(s)')
    expect(c.notices[0]!.text).not.toContain('this channel')
  })

  test('existing DB with only pre-boundary rows → count 0 → quiet', async () => {
    const dbPath = makeArchiveDb([{ ts: SPAWN_EPOCH - 100 }, { ts: SPAWN_EPOCH }])
    const c = await runLayer2({ statFn: () => false, archiveCountSince: undefined }, archiveConfig(dbPath))
    expect(c.errors).toEqual([])
    expect(c.notices).toEqual([])
  })

  test('corrupt/unreadable DB file → null → quiet (error swallowed)', async () => {
    const dbPath = join(makeTempDir('jsonl-archive-test-'), 'corrupt.db')
    // Not a valid sqlite file → new Database(...).query throws → counter returns null.
    writeFileSync(dbPath, 'this is not a sqlite database, it is plain garbage bytes')
    chmodSync(dbPath, 0o644)
    const c = await runLayer2({ statFn: () => false, archiveCountSince: undefined }, archiveConfig(dbPath))
    expect(c.errors).toEqual([])
    expect(c.notices).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// b.av2 SR-7.4 — which archived messages count as a persona's evidence
//
// Channels: two `all` channels, one `mentions` channel and a DM conversation
// the persona under test may hold, and a channel of another persona.
// ---------------------------------------------------------------------------

const ALL_1 = 'C0ALL0001'
const ALL_2 = 'C0ALL0002'
const MENT = 'C0MENT001'
const DM_CONV = 'D0DM00001'
const OTHER = 'C0OTHER01'

/** `n` archive rows in `channel`, all strictly after the spawn boundary. */
function after(channel: string, n: number): ArchiveRow[] {
  return Array.from({ length: n }, (_, i) => ({ ts: SPAWN_EPOCH + 1 + i, channel }))
}

/** Pre-boundary noise in every channel: never counted by any case. */
const PRE_BOUNDARY: ArchiveRow[] = [ALL_1, ALL_2, MENT, DM_CONV, OTHER].map((channel) => ({
  ts: SPAWN_EPOCH - 1,
  channel,
}))

/** Rows in every channel after the boundary: 1 / 2 / 3 / 4 / 5 per channel. */
const EVERYWHERE: ArchiveRow[] = [
  ...after(ALL_1, 1),
  ...after(ALL_2, 2),
  ...after(MENT, 3),
  ...after(DM_CONV, 4),
  ...after(OTHER, 5),
]

const all = (id: string) => ({ id, delivery: 'all' as const })
const mentions = (id: string) => ({ id, delivery: 'mentions' as const })

/**
 * A config of the persona under test (`spec`) and another persona in OTHER,
 * both matching the rows makeRow builds.
 */
function evidenceConfig(spec: PersonaSpec, dbPath?: string): PersonaConfig {
  return makeMultiPersonaConfig(
    [
      { ...LAYER2_SPEC, ...spec },
      { name: 'Other Bot', working_directory: '/repo/other', channels: [all(OTHER)] },
    ],
    makeTempDir(),
    { claude_config_dir: CONFIG_DIR, ...(dbPath ? { message_archive_db: dbPath } : {}) },
  )
}

describe('personaArchiveEvidenceScope + makeDefaultArchiveCount (real temp sqlite, several channels)', () => {
  test.each([
    {
      name: 'rows in its one `all` channel are counted',
      spec: { channels: [all(ALL_1)] },
      rows: after(ALL_1, 2),
      ids: [ALL_1],
      attributable: true,
      count: 2,
    },
    {
      name: 'rows in two `all` channels are summed',
      spec: { channels: [all(ALL_1), all(ALL_2)] },
      rows: [...after(ALL_1, 2), ...after(ALL_2, 3)],
      ids: [ALL_1, ALL_2],
      attributable: true,
      count: 5,
    },
    {
      name: 'rows only in its `mentions` channel are not counted',
      spec: { channels: [all(ALL_1), mentions(MENT)] },
      rows: after(MENT, 4),
      ids: [ALL_1],
      attributable: false,
      count: 0,
    },
    {
      name: 'rows only in a DM conversation are not counted',
      spec: { channels: [all(ALL_1)], dm: { enabled: true } },
      rows: after(DM_CONV, 4),
      ids: [ALL_1],
      attributable: false,
      count: 0,
    },
    {
      name: "rows in another persona's channel are not counted",
      spec: { channels: [all(ALL_1)] },
      rows: after(OTHER, 4),
      ids: [ALL_1],
      attributable: true,
      count: 0,
    },
    {
      name: 'rows everywhere: only the `all` channels count (1 + 2)',
      spec: { channels: [mentions(MENT), all(ALL_1), all(ALL_2)], dm: { enabled: true } },
      rows: EVERYWHERE,
      ids: [ALL_1, ALL_2],
      attributable: false,
      count: 3,
    },
    {
      name: 'a DM-only persona with no channels counts nothing',
      spec: { channels: [], dm: { enabled: true }, permission_prompts: 'dm' },
      rows: EVERYWHERE,
      ids: [],
      attributable: false,
      count: 0,
    },
  ] as Array<{ name: string; spec: PersonaSpec; rows: ArchiveRow[]; ids: string[]; attributable: boolean; count: number }>)(
    '$name',
    ({ spec, rows, ids, attributable, count }) => {
      const dbPath = makeArchiveDb([...PRE_BOUNDARY, ...rows])
      const persona = evidenceConfig(spec).personas[0]!
      const scope = personaArchiveEvidenceScope(persona)
      expect(scope).toEqual({ channelIds: ids, zeroIsAttributable: attributable })
      const countSince = makeDefaultArchiveCount({ message_archive_db: dbPath })
      expect(countSince(scope.channelIds, SPAWN_EPOCH, renderPersonaRef(persona.name, persona.key))).toBe(count)
    },
  )

  test.each([
    ['unconfigured', (): string | undefined => undefined],
    ['missing-file', (): string | undefined => join(makeTempDir('jsonl-archive-test-'), 'absent.db')],
    [
      'corrupt-file',
      (): string | undefined => {
        const p = join(makeTempDir('jsonl-archive-test-'), 'corrupt.db')
        writeFileSync(p, 'not a sqlite database')
        return p
      },
    ],
  ])('no `all` channels → 0 without opening the %s archive (an `all` channel gives null)', (label, dbPathFor) => {
    const dbPath = dbPathFor()
    const countSince = makeDefaultArchiveCount({ message_archive_db: dbPath })
    expect(countSince([], SPAWN_EPOCH, 'ref')).toBe(0)
    expect(countSince([ALL_1], SPAWN_EPOCH, 'ref')).toBeNull()
    if (label === 'missing-file') expect(existsSync(dbPath!)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// b.av2 SR-7.4 — zero-count interpretation in the safeguard (real sqlite,
// default archive count, real per-persona notifier)
// ---------------------------------------------------------------------------

describe('runJsonlPersistenceSafeguard — zero archive count per SR-7.4', () => {
  async function runEvidence(spec: PersonaSpec, rows: ArchiveRow[]) {
    const dbPath = makeArchiveDb([...PRE_BOUNDARY, ...rows])
    const config = evidenceConfig(spec, dbPath)
    const [persona, other] = config.personas
    const h = makeNotifierHarness(config)
    const errors: Array<{ key: string; message: string }> = []
    const log = captureErrorLog()
    await runJsonlPersistenceSafeguard(config, h.notifier.notify, {
      readMountinfo: fixture(REALISTIC_MOUNTINFO),
      statFn: () => false,
      // Only the persona under test has a row.
      getRow: async (key) => {
        if (key === persona!.key) return makeRow({}, persona!)
        throw new ErrSpawnNotFound('get', 'ErrSpawnNotFound', 'x')
      },
      recordStartupError: (key, message) => {
        errors.push({ key, message })
      },
      home,
    })
    const ref = renderPersonaRef(persona!.name, persona!.key)
    return { persona: persona!, other: other!, h, errors, personaLines: log.filter((l) => l.includes(ref)) }
  }

  test.each([
    ['rows only in its `mentions` channel', { channels: [all(ALL_1), mentions(MENT)] }, after(MENT, 3)],
    ['DMs on and archived rows only in a DM', { channels: [all(ALL_1)], dm: { enabled: true } }, after(DM_CONV, 3)],
    [
      'a DM-only persona with no channels',
      { channels: [], dm: { enabled: true }, permission_prompts: 'dm' },
      after(DM_CONV, 3),
    ],
  ] as Array<[string, PersonaSpec, ArchiveRow[]]>)(
    '%s → zero is inconclusive: no LOST record, no notice, one quiet line',
    async (_label, spec, rows) => {
      const { h, errors, personaLines } = await runEvidence(spec, rows)
      expect(errors).toEqual([])
      expect(h.totalPosts()).toBe(0)
      const inconclusive = personaLines.filter((l) => l.includes('archive evidence is inconclusive'))
      expect(inconclusive).toHaveLength(1)
      expect(inconclusive[0]).toContain(UNATTRIBUTABLE_ZERO_REASON)
    },
  )

  test('a `mentions` channel plus archived `all`-channel rows → LOST record and one notice counting only `all` rows', async () => {
    const { persona, other, h, errors } = await runEvidence(
      { channels: [all(ALL_1), mentions(MENT)] },
      [...after(ALL_1, 2), ...after(MENT, 3), ...after(OTHER, 4)],
    )
    expect(errors.map((e) => e.key)).toEqual(['jsonl-transcript-lost'])
    expect(errors[0]!.message).toContain('2 message(s)')
    const posts = h.posts(persona.key)
    expect(posts).toHaveLength(1)
    expect(posts[0]!.text).toContain('2 message(s)')
    expect(h.posts(other.key)).toEqual([])
  })

  test('an `all`-only persona with DMs off and zero `all` rows → idle-quiet, not inconclusive', async () => {
    const { h, errors, personaLines } = await runEvidence({ channels: [all(ALL_1)] }, after(OTHER, 3))
    expect(errors).toEqual([])
    expect(h.totalPosts()).toBe(0)
    expect(personaLines.filter((l) => l.includes('no archived activity since spawn'))).toHaveLength(1)
    expect(personaLines.filter((l) => l.includes('inconclusive'))).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// runPersonaStorageCheck — Layer 1 for one persona a confirmed apply brings
// up (b.av2 SR-6.2): its own effective JSONL root only, recorded and warned
// about exactly as the start safeguard does; never throws.
// ---------------------------------------------------------------------------

describe('runPersonaStorageCheck — one persona\'s root at apply (b.av2 SR-6.2)', () => {
  /** Run the check for `persona` with a recording notify and startup-error sink. */
  function runFor(
    persona: Persona,
    deps: Partial<Pick<JsonlPersistenceSafeguardDeps, 'readMountinfo' | 'recordStartupError'>> = {},
    notify?: (key: string, text: string) => void,
  ): Captured {
    const captured: Captured = { errors: [], notices: [] }
    runPersonaStorageCheck(persona, notify ?? ((key, text) => void captured.notices.push({ key, text })), {
      readMountinfo: fixture(REALISTIC_MOUNTINFO),
      recordStartupError: (key, message) => void captured.errors.push({ key, message }),
      home,
      ...deps,
    })
    return captured
  }

  /** The Layer 1 signals the start safeguard gives for a config holding only `persona`. */
  async function atStart(persona: Persona, readMountinfo = fixture(REALISTIC_MOUNTINFO)): Promise<Captured> {
    return runLayer2(
      { readMountinfo, statFn: () => true, getRow: async () => { throw new ErrSpawnNotFound('get', 'ErrSpawnNotFound', 'x') } },
      { ...layer2Config(), personas: [persona] },
    )
  }

  test('a non-persistent root: the same jsonl-non-persistent record and warning as at start, to this persona only — not to another persona on the same root', async () => {
    const config = makeMultiPersonaConfig(
      [{ name: 'Alpha Bot', claude_config_dir: '/tmp/claude' }, { name: 'Beta Bot', claude_config_dir: '/tmp/claude' }],
      makeTempDir(),
    )
    const [a] = config.personas as [Persona, Persona]

    const c = runFor(a)

    expect(c.errors.map((e) => e.key)).toEqual(['jsonl-non-persistent'])
    expect(c.errors[0]!.message).toContain('root="/tmp/claude/projects"')
    expect(c.notices.map((n) => n.key)).toEqual([a.key])
    expect(c).toEqual(await atStart(a))
  })

  test.each<[string, string, string | undefined, string[]]>([
    ['on a persistent root: nothing recorded, no warning', '/home/user/.claude', undefined, []],
    ['on an unresolvable root: the jsonl-persistence-check-warning record as at start, no warning', '/no/matching/mount',
      '24 23 8:2 / /home rw,relatime shared:2 - ext4 /dev/sda2 rw\n', ['jsonl-persistence-check-warning']],
  ])('the persona %s, although another persona sits on a tmpfs root', async (_label, dir, mountinfo, recorded) => {
    const config = makeMultiPersonaConfig(
      [{ name: 'Alpha Bot', claude_config_dir: dir }, { name: 'Beta Bot', claude_config_dir: '/tmp/claude' }],
      makeTempDir(),
    )
    const [a] = config.personas as [Persona, Persona]
    const readMountinfo = fixture(mountinfo ?? REALISTIC_MOUNTINFO)

    const c = runFor(a, { readMountinfo })

    expect(c.errors.map((e) => e.key)).toEqual(recorded)
    expect(c.notices).toEqual([])
    expect(c).toEqual(await atStart(a, readMountinfo))
  })

  test('a persona with no claude_config_dir is checked at <home>/.claude/projects under deps.home', () => {
    const config = makeMultiPersonaConfig([{ name: 'Alpha Bot' }], makeTempDir())
    const [a] = config.personas as [Persona]
    const homeOnTmpfs = `${REALISTIC_MOUNTINFO}99 23 0:30 / ${home} rw,relatime shared:11 - tmpfs tmpfs rw\n`

    const c = runFor(a, { readMountinfo: fixture(homeOnTmpfs) })

    expect(c.errors).toEqual([{ key: 'jsonl-non-persistent', message: expect.stringContaining(`root="${home}/.claude/projects"`) }])
    expect(c.notices.map((n) => n.key)).toEqual([a.key])
  })

  test.each<[string, Partial<Pick<JsonlPersistenceSafeguardDeps, 'readMountinfo' | 'recordStartupError'>>, boolean]>([
    ['the startup-error sink throws', { recordStartupError: () => { throw new Error('sink exploded') } }, true],
    ['the notice seam throws', {}, false],
    ['the mountinfo reader throws', { readMountinfo: () => { throw new Error('no /proc') } }, false],
  ])('never throws when %s', (_label, deps, unexpected) => {
    const config = makeMultiPersonaConfig([{ name: 'Alpha Bot', claude_config_dir: '/tmp/claude' }], makeTempDir())
    const [a] = config.personas as [Persona]
    const lines = captureErrorLog()

    expect(() => runFor(a, deps, () => { throw new Error('notify exploded') })).not.toThrow()

    const failedLine = `[slack] Warning: jsonl-persistence-check failed unexpectedly for ${renderPersonaRef(a.name, a.key)} — continuing: Error`
    expect(lines.filter((l) => l.startsWith(failedLine))).toHaveLength(unexpected ? 1 : 0)
  })
})
