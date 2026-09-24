/**
 * jsonl-persistence-check.test.ts — Branch-matrix tests for the b.zak startup
 * JSONL-persistence safeguard (src/jsonl-persistence-check.ts).
 *
 * Layer 1 (pure): resolveJsonlRoots dedup/precedence, checkMountFstype
 * longest-prefix + malformed/edge parsing, checkJsonlPersistence tmpfs/ramfs
 * classification.
 *
 * Layer 2 (per-persona via runJsonlPersistenceSafeguard with injected deps):
 * every classification branch — healthy, stale-path-loud, lost-loud (archive
 * evidence), idle-quiet, no-row skip, empty-session skip, AD-error-continue,
 * never-throws. Notices go through the persona-keyed notice seam; one case
 * wires it to the real per-persona notifier (b.av2 SR-7.2).
 *
 * All external effects are dependency-injected — no mock.module, no real /proc
 * reads, no filesystem writes.
 *
 * SPDX-License-Identifier: MIT
 */

import { describe, test, expect, afterEach } from 'bun:test'
import { homedir, tmpdir } from 'node:os'
import { mkdtempSync, existsSync, chmodSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import type { GetResult } from 'agent-director'
import {
  resolveJsonlRoots,
  checkMountFstype,
  checkJsonlPersistence,
  runJsonlPersistenceSafeguard,
  type JsonlPersistenceSafeguardDeps,
} from '../src/jsonl-persistence-check.ts'
import { resolveJsonlPath } from '../src/cozempic.ts'
import { personaInstanceId, renderPersonaRef } from '../src/persona-identity.ts'
import { ErrSpawnNotFound } from '../src/agent-director-errors.ts'
import { makeRoutingConfig } from './test-helpers/routing-config.ts'
import type { RoutingConfig } from '../src/config.ts'
import { buildTempArchiveDb, type ArchiveRow } from './test-helpers/archive-db.ts'
import { makeMultiPersonaConfig } from './test-helpers/persona-config.ts'
import { makeNotifierHarness } from './test-helpers/persona-notifier.ts'

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
  test('global claude_config_dir only — routes dedup to one root', () => {
    const config = makeRoutingConfig({
      routes: { C001: { cwd: '/repo/a' }, C002: { cwd: '/repo/b' } },
      claude_config_dir: '/home/user/.claude-corp',
    })
    expect(resolveJsonlRoots(config)).toEqual(['/home/user/.claude-corp/projects'])
  })

  test('per-route claude_config_dir takes precedence over global', () => {
    const config = makeRoutingConfig({
      routes: {
        C001: { cwd: '/repo/a', claude_config_dir: '/home/user/.claude-a' },
        C002: { cwd: '/repo/b' }, // falls back to global
      },
      claude_config_dir: '/home/user/.claude-global',
    })
    const roots = resolveJsonlRoots(config)
    expect(roots).toHaveLength(2)
    expect(roots).toContain('/home/user/.claude-a/projects')
    expect(roots).toContain('/home/user/.claude-global/projects')
  })

  test('two routes sharing a per-route dir dedup to one root', () => {
    const config = makeRoutingConfig({
      routes: {
        C001: { cwd: '/repo/a', claude_config_dir: '/home/user/.claude-shared' },
        C002: { cwd: '/repo/b', claude_config_dir: '/home/user/.claude-shared' },
      },
    })
    expect(resolveJsonlRoots(config)).toEqual(['/home/user/.claude-shared/projects'])
  })

  test('no config dir anywhere → homedir default', () => {
    const config = makeRoutingConfig({ routes: { C001: { cwd: '/repo/a' } }, claude_config_dir: undefined })
    expect(resolveJsonlRoots(config)).toEqual([`${homedir()}/.claude/projects`])
  })

  test('no routes at all → homedir default fallback', () => {
    const config = makeRoutingConfig({ routes: {}, claude_config_dir: undefined })
    expect(resolveJsonlRoots(config)).toEqual([`${homedir()}/.claude/projects`])
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
  const configForDir = (dir: string): RoutingConfig =>
    makeRoutingConfig({ routes: { C001: { cwd: '/repo', claude_config_dir: dir } }, claude_config_dir: undefined })

  test('tmpfs root → nonPersistent, no warnings', () => {
    const r = checkJsonlPersistence(configForDir('/tmp/claude'), fixture(REALISTIC_MOUNTINFO))
    expect(r.nonPersistent).toEqual(['/tmp/claude/projects'])
    expect(r.warnings).toEqual([])
  })

  test('ramfs root → nonPersistent, no warnings', () => {
    const r = checkJsonlPersistence(configForDir('/mnt/ramfs/claude'), fixture(REALISTIC_MOUNTINFO))
    expect(r.nonPersistent).toEqual(['/mnt/ramfs/claude/projects'])
    expect(r.warnings).toEqual([])
  })

  test('ext4 root → neither nonPersistent nor warnings', () => {
    const r = checkJsonlPersistence(configForDir('/home/user/.claude'), fixture(REALISTIC_MOUNTINFO))
    expect(r.nonPersistent).toEqual([])
    expect(r.warnings).toEqual([])
  })

  test('reader throws → warnings (not nonPersistent), does not throw', () => {
    const throws = (): string => { throw new Error('ENOENT') }
    const r = checkJsonlPersistence(configForDir('/home/user/.claude'), throws)
    expect(r.nonPersistent).toEqual([])
    expect(r.warnings).toEqual(['/home/user/.claude/projects'])
  })

  test('unresolvable mount (no root line) → warnings', () => {
    const noRoot = '24 23 8:2 / /home rw,relatime shared:2 - ext4 /dev/sda2 rw\n'
    const r = checkJsonlPersistence(configForDir('/no/matching/mount'), fixture(noRoot))
    expect(r.nonPersistent).toEqual([])
    expect(r.warnings).toEqual(['/no/matching/mount/projects'])
  })

  test('multi-root mixed: tmpfs + ext4 classified independently', () => {
    const config = makeRoutingConfig({
      routes: {
        C001: { cwd: '/a', claude_config_dir: '/tmp/claude-tmp' },
        C002: { cwd: '/b', claude_config_dir: '/home/user/.claude-ext4' },
      },
      claude_config_dir: undefined,
    })
    const r = checkJsonlPersistence(config, fixture(REALISTIC_MOUNTINFO))
    expect(r.nonPersistent).toEqual(['/tmp/claude-tmp/projects'])
    expect(r.warnings).toEqual([])
  })

  test('never throws with no routes (homedir fallback path)', () => {
    const config = makeRoutingConfig({ routes: {}, claude_config_dir: undefined })
    expect(() => checkJsonlPersistence(config, fixture(REALISTIC_MOUNTINFO))).not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// Layer 2 — runJsonlPersistenceSafeguard per-persona classification
//
// A single stand-in persona (key = channel ID under the route->persona
// adapter) is exercised at a time. Layer 1 is neutered by supplying a
// readMountinfo fixture whose root is ext4 (never nonPersistent), so recorded
// errors come only from Layer 2.
// ---------------------------------------------------------------------------

const CH = 'C_TEST1'
const CONFIG_DIR = '/home/user/.claude' // ext4 in REALISTIC_MOUNTINFO → no Layer-1 noise

function layer2Config(): RoutingConfig {
  return makeRoutingConfig({
    routes: { [CH]: { cwd: '/repo/app', claude_config_dir: CONFIG_DIR } },
    claude_config_dir: undefined,
    message_archive_db: '/tmp/archive.db',
  })
}

/** GetResult fixture with the fields Layer 2 reads; overridable. */
function makeRow(overrides?: Partial<GetResult>): GetResult {
  return {
    claude_instance_id: personaInstanceId(CH),
    parent_id: '',
    state: 'live',
    cwd: '/repo/app',
    tmux_session_name: 'slack_bot_' + CH,
    claude_args: [],
    relay_mode: '',
    jsonl_path: '/home/user/.claude/projects/-repo-app/sess-abc.jsonl',
    claude_session_id: 'sess-abc',
    labels: {},
    started_at: '2026-09-20T05:00:00Z',
    last_seen_at: '2026-09-20T05:10:00Z',
    ...overrides,
  }
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
  config: RoutingConfig = layer2Config(),
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
    ...deps,
  }
  await runJsonlPersistenceSafeguard(config, notify, fullDeps)
  return captured
}

describe('runJsonlPersistenceSafeguard — Layer 2 classification', () => {
  test('looks up the row by cscb_<key>, the stand-in key being the channel ID (b.av2 SR-2.2)', async () => {
    const lookups: Array<[string, string]> = []
    await runLayer2({
      getRow: async (key: string, claudeInstanceId: string) => {
        lookups.push([key, claudeInstanceId])
        return makeRow()
      },
    })
    expect(lookups).toEqual([[CH, personaInstanceId(CH)]])
    expect(lookups[0][1]).toBe('cscb_C_TEST1')
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
    const staleRow = makeRow({ jsonl_path: '/some/other/stale/path.jsonl' })
    const c = await runLayer2({
      getRow: async () => staleRow,
      statFn: (p) => p === fallback,
    })
    expect(c.errors).toHaveLength(1)
    expect(c.errors[0]!.key).toBe('jsonl-transcript-stale-path')
    expect(c.notices).toHaveLength(1)
    expect(c.notices[0]!.key).toBe(CH)
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
    expect(c.notices[0]!.key).toBe(CH)
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

  test('per-persona error inside classification is isolated — sweep never throws', async () => {
    // statFn throws for one persona; safeguard must swallow and complete.
    const config = makeRoutingConfig({
      routes: {
        BOOMCH: { cwd: '/repo/boom', claude_config_dir: CONFIG_DIR },
        SAFECH: { cwd: '/repo/safe', claude_config_dir: CONFIG_DIR },
      },
      claude_config_dir: undefined,
      message_archive_db: '/tmp/archive.db',
    })
    let safeRan = false
    await expect(
      runLayer2(
        {
          getRow: async (key: string) => makeRow({ cwd: key === 'BOOMCH' ? '/repo/boom' : '/repo/safe' }),
          // statFn throws unexpectedly for BOOMCH's paths; the orchestrator's
          // per-persona try/catch must swallow it so SAFECH still runs.
          statFn: (p) => {
            if (p.includes('-repo-boom')) throw new Error('boom')
            safeRan = true
            return false
          },
          archiveCountSince: () => 0,
        },
        config,
      ),
    ).resolves.toBeDefined() // resolves (no throw) despite BOOMCH's internal error
    expect(safeRan).toBe(true)
  })

  test('notify undefined (no notice seam): loud error still recorded, no notice', async () => {
    const c = await runLayer2({ statFn: () => false, archiveCountSince: () => 3 }, layer2Config(), false)
    expect(c.errors).toHaveLength(1)
    expect(c.errors[0]!.key).toBe('jsonl-transcript-lost')
    expect(c.notices).toEqual([]) // notify undefined → no notice
  })
})

// ---------------------------------------------------------------------------
// Notice seam wired to the real per-persona notifier (b.av2 SR-7.2)
// ---------------------------------------------------------------------------

describe('runJsonlPersistenceSafeguard — real per-persona notifier', () => {
  let dir: string | undefined
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true })
    dir = undefined
  })

  test("stale-path notice for A posts once, on A's client, to A's destination, with A's reference; nothing on B's", async () => {
    dir = mkdtempSync(join(tmpdir(), 'jsonl-notifier-test-'))
    const personaConfig = makeMultiPersonaConfig([{ name: 'Alpha Bot' }, { name: 'Beta Bot' }], dir)
    const a = personaConfig.personas[0]!
    const b = personaConfig.personas[1]!
    // The persona key is distinct from the destination channel, so a notice
    // addressed to the channel ID instead of the key would be dropped.
    expect(a.key).not.toBe(a.permission_prompts)
    const h = makeNotifierHarness(personaConfig)

    // Under the adapter the safeguard iterates the routing config's keys: key
    // each route by its persona key.
    const config = makeRoutingConfig({
      routes: {
        [a.key]: { cwd: '/repo/app', claude_config_dir: CONFIG_DIR },
        [b.key]: { cwd: '/repo/app', claude_config_dir: CONFIG_DIR },
      },
      claude_config_dir: undefined,
    })
    const staleRow = makeRow({ jsonl_path: '/some/other/stale/path.jsonl' })
    const fallback = resolveJsonlPath(staleRow.cwd, staleRow.claude_session_id, CONFIG_DIR)
    await runJsonlPersistenceSafeguard(config, h.notifier.notify, {
      readMountinfo: fixture(REALISTIC_MOUNTINFO),
      statFn: (p) => p === fallback,
      getRow: async (key) => {
        if (key === a.key) return staleRow
        throw new ErrSpawnNotFound('get', 'ErrSpawnNotFound', 'x')
      },
      archiveCountSince: () => null,
      recordStartupError: () => {},
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
    const config = makeRoutingConfig({
      routes: {
        A: { cwd: '/repo/a', claude_config_dir: '/tmp/claude' },
        B: { cwd: '/repo/b', claude_config_dir: '/tmp/claude' },
      },
      claude_config_dir: undefined,
    })
    const c = await runLayer2(quietLayer2, config)
    const nonPersistent = c.errors.filter((e) => e.key === 'jsonl-non-persistent')
    expect(nonPersistent).toHaveLength(1)
    // One notice per persona key whose effective root is flagged (both A and B).
    expect(c.notices.map((n) => n.key).sort()).toEqual(['A', 'B'])
    for (const n of c.notices) expect(n.text).not.toContain('this channel')
  })

  test('mixed roots: notice goes ONLY to personas on the flagged tmpfs root; record fires once', async () => {
    // Two routes with different effective JSONL roots; only /tmp/claude is tmpfs.
    // A → /tmp/claude/projects (tmpfs, flagged). B → /home/user/.claude/projects (ext4, clean).
    const config = makeRoutingConfig({
      routes: {
        A: { cwd: '/repo/a', claude_config_dir: '/tmp/claude' },
        B: { cwd: '/repo/b', claude_config_dir: '/home/user/.claude' },
      },
      claude_config_dir: undefined,
    })
    const c = await runLayer2(quietLayer2, config)
    const nonPersistent = c.errors.filter((e) => e.key === 'jsonl-non-persistent')
    // recordStartupError fires once per flagged root (one tmpfs root here).
    expect(nonPersistent).toHaveLength(1)
    expect(nonPersistent[0]!.message).toContain('/tmp/claude/projects')
    // The notice targets ONLY the persona whose effective root is the flagged root.
    expect(c.notices.map((n) => n.key)).toEqual(['A'])
    expect(c.notices[0]!.text).toContain('/tmp/claude/projects')
    expect(c.notices[0]!.text).not.toContain('this channel')
  })

  test('unresolvable root → jsonl-persistence-check-warning recorded, no notice', async () => {
    const config = makeRoutingConfig({
      routes: { A: { cwd: '/repo/a', claude_config_dir: '/no/matching/mount' } },
      claude_config_dir: undefined,
    })
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
// makeRow().started_at is '2026-09-20T05:00:00Z' → the spawn boundary in epoch
// seconds. The default counter reads config.message_archive_db read-only and
// counts messages WHERE channel_id = ? AND timestamp > boundary. A positive
// count surfaces as a loud jsonl-transcript-lost record whose message embeds the
// exact count; 0 / null (unconfigured, missing, corrupt) stay quiet. statFn is
// forced false so Layer 2 always reaches the archive-count branch.
// ---------------------------------------------------------------------------

const SPAWN_EPOCH = Date.parse(makeRow().started_at) / 1000 // 2026-09-20T05:00:00Z

// Cleanup handles for temp archive dirs built during this suite (drained in afterEach).
const archiveCleanups: Array<() => void> = []

/** Builds a temp archive DB with the given (timestamp, channel) rows; returns its path. */
function makeArchiveDb(rows: ArchiveRow[]): string {
  const built = buildTempArchiveDb(rows, CH)
  archiveCleanups.push(built.cleanup)
  return built.dbPath
}

/** Config whose message_archive_db points at dbPath (undefined → unconfigured). */
function archiveConfig(dbPath: string | undefined): RoutingConfig {
  return makeRoutingConfig({
    routes: { [CH]: { cwd: '/repo/app', claude_config_dir: CONFIG_DIR } },
    claude_config_dir: undefined,
    message_archive_db: dbPath,
  })
}

describe('makeDefaultArchiveCount (real temp sqlite, via default archiveCountSince)', () => {
  afterEach(() => {
    while (archiveCleanups.length > 0) archiveCleanups.pop()!()
  })

  test('unconfigured message_archive_db → null → quiet (no loud lost signal)', async () => {
    const c = await runLayer2({ statFn: () => false, archiveCountSince: undefined }, archiveConfig(undefined))
    expect(c.errors).toEqual([])
    expect(c.notices).toEqual([])
  })

  test('missing DB file → null → quiet AND the file is not created', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jsonl-archive-test-'))
    const dbPath = join(dir, 'does-not-exist.db')
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
    expect(c.notices[0]!.key).toBe(CH)
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
    const dir = mkdtempSync(join(tmpdir(), 'jsonl-archive-test-'))
    const dbPath = join(dir, 'corrupt.db')
    // Not a valid sqlite file → new Database(...).query throws → counter returns null.
    writeFileSync(dbPath, 'this is not a sqlite database, it is plain garbage bytes')
    chmodSync(dbPath, 0o644)
    const c = await runLayer2({ statFn: () => false, archiveCountSince: undefined }, archiveConfig(dbPath))
    expect(c.errors).toEqual([])
    expect(c.notices).toEqual([])
  })
})
