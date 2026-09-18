/**
 * jsonl-persistence-check.test.ts — Branch-matrix tests for the pure module.
 *
 * Covers SR-24.4 conservative semantics:
 *   - resolveJsonlRoots: dedup matrix (global-only, per-route-only, mixed,
 *     none→homedir default, two routes sharing one dir)
 *   - checkMountFstype: longest-prefix matching over a realistic multi-mount
 *     fixture, correct fstype field extraction, null on no match / malformed / empty
 *   - checkJsonlPersistence: tmpfs→nonPersistent; ramfs (distinct case);
 *     ext4→both empty; reader throws→warnings; unparseable→warnings;
 *     multi-root mixed (one tmpfs + one ext4) classified independently
 *
 * No mock.module. No real /proc reads or filesystem writes.
 *
 * SPDX-License-Identifier: MIT
 */

import { describe, test, expect } from 'bun:test'
import { homedir } from 'node:os'
import {
  resolveJsonlRoots,
  checkMountFstype,
  checkJsonlPersistence,
} from '../src/jsonl-persistence-check.ts'
import { makeRoutingConfig } from './test-helpers/routing-config.ts'

// ---------------------------------------------------------------------------
// Realistic multi-mount mountinfo fixture
//
// Format per kernel docs:
//   <mountid> <parentid> <major:minor> <root> <mountpoint> <mountopts>
//   [optional fields] - <fstype> <mountsource> <superopts>
//
// This fixture is intentionally multi-layered: root /, a nested /home mount,
// a /tmp tmpfs, a /dev/shm tmpfs, a /run/user/1000 tmpfs, an overlay at
// /var/lib/docker/overlay2/xxx/merged, and a ramfs at /mnt/ramfs. Longest-
// prefix matching must pick the deepest matching mount.
// ---------------------------------------------------------------------------

const REALISTIC_MOUNTINFO = `\
23 0 8:1 / / rw,relatime shared:1 - ext4 /dev/sda1 rw,data=ordered
24 23 8:2 / /home rw,relatime shared:2 - ext4 /dev/sda2 rw,data=ordered
25 23 0:20 / /tmp rw,nosuid,nodev shared:3 - tmpfs tmpfs rw,size=4096m
26 23 0:21 / /dev/shm rw,nosuid,nodev shared:4 - tmpfs shm rw,size=65536k
27 23 0:22 / /run rw,nosuid,nodev,noexec shared:5 - tmpfs tmpfs rw
28 27 0:23 / /run/user/1000 rw,nosuid,nodev,relatime shared:6 - tmpfs tmpfs rw,size=8192k
29 23 0:24 / /proc rw,nosuid,nodev,noexec,relatime shared:7 - proc proc rw
30 23 0:10 / /sys rw,nosuid,nodev,noexec,relatime shared:8 - sysfs sysfs rw
31 23 0:25 / /var/lib/docker/overlay2/abc123/merged rw,relatime shared:9 - overlay overlay rw,lowerdir=/xxx,upperdir=/yyy,workdir=/zzz
32 23 0:26 / /mnt/ramfs rw shared:10 - ramfs ramfs rw
`

// ---------------------------------------------------------------------------
// resolveJsonlRoots — dedup matrix
// ---------------------------------------------------------------------------

describe('resolveJsonlRoots', () => {
  test('global claude_config_dir only — all routes use global dir', () => {
    const config = makeRoutingConfig({
      routes: {
        C001: { cwd: '/repo/a' },
        C002: { cwd: '/repo/b' },
      },
      claude_config_dir: '/home/user/.claude-corp',
    })
    const roots = resolveJsonlRoots(config)
    // Both routes share the same effectiveConfigDir → one deduplicated root
    expect(roots).toEqual(['/home/user/.claude-corp/projects'])
  })

  test('per-route claude_config_dir only — no global dir, routes have their own', () => {
    const config = makeRoutingConfig({
      routes: {
        C001: { cwd: '/repo/a', claude_config_dir: '/home/user/.claude-a' },
        C002: { cwd: '/repo/b', claude_config_dir: '/home/user/.claude-b' },
      },
      claude_config_dir: undefined,
    })
    const roots = resolveJsonlRoots(config)
    expect(roots).toHaveLength(2)
    expect(roots).toContain('/home/user/.claude-a/projects')
    expect(roots).toContain('/home/user/.claude-b/projects')
  })

  test('mixed: some routes have per-route dir, others fall back to global', () => {
    const config = makeRoutingConfig({
      routes: {
        C001: { cwd: '/repo/a', claude_config_dir: '/home/user/.claude-per-route' },
        C002: { cwd: '/repo/b' }, // falls back to global
      },
      claude_config_dir: '/home/user/.claude-global',
    })
    const roots = resolveJsonlRoots(config)
    expect(roots).toHaveLength(2)
    expect(roots).toContain('/home/user/.claude-per-route/projects')
    expect(roots).toContain('/home/user/.claude-global/projects')
  })

  test('no routes and no global dir → homedir default fallback', () => {
    const config = makeRoutingConfig({
      routes: {},
      claude_config_dir: undefined,
    })
    const roots = resolveJsonlRoots(config)
    expect(roots).toEqual([`${homedir()}/.claude/projects`])
  })

  test('two routes sharing the same per-route dir → deduplicated to one root', () => {
    const sharedDir = '/home/user/.claude-shared'
    const config = makeRoutingConfig({
      routes: {
        C001: { cwd: '/repo/a', claude_config_dir: sharedDir },
        C002: { cwd: '/repo/b', claude_config_dir: sharedDir },
      },
    })
    const roots = resolveJsonlRoots(config)
    expect(roots).toHaveLength(1)
    expect(roots[0]).toBe(`${sharedDir}/projects`)
  })

  test('single route with no global and no per-route dir → homedir default', () => {
    const config = makeRoutingConfig({
      routes: {
        C001: { cwd: '/repo/a' },
      },
      claude_config_dir: undefined,
    })
    const roots = resolveJsonlRoots(config)
    expect(roots).toEqual([`${homedir()}/.claude/projects`])
  })
})

// ---------------------------------------------------------------------------
// checkMountFstype — longest-prefix matching + field extraction
// ---------------------------------------------------------------------------

describe('checkMountFstype', () => {
  function fixture(content: string): () => string {
    return () => content
  }

  test('matches tmpfs for /tmp/some/path (nested under /tmp mount)', () => {
    const fstype = checkMountFstype('/tmp/some/path/to/dir', fixture(REALISTIC_MOUNTINFO))
    expect(fstype).toBe('tmpfs')
  })

  test('matches ext4 for /home/user/.claude/projects (nested under /home mount)', () => {
    const fstype = checkMountFstype('/home/user/.claude/projects', fixture(REALISTIC_MOUNTINFO))
    expect(fstype).toBe('ext4')
  })

  test('matches ext4 for /var/data (under root ext4, no deeper match)', () => {
    const fstype = checkMountFstype('/var/data', fixture(REALISTIC_MOUNTINFO))
    expect(fstype).toBe('ext4')
  })

  test('matches overlay for path nested under the overlay mount point', () => {
    const fstype = checkMountFstype(
      '/var/lib/docker/overlay2/abc123/merged/workspace',
      fixture(REALISTIC_MOUNTINFO),
    )
    expect(fstype).toBe('overlay')
  })

  test('matches ramfs for /mnt/ramfs/data', () => {
    const fstype = checkMountFstype('/mnt/ramfs/data', fixture(REALISTIC_MOUNTINFO))
    expect(fstype).toBe('ramfs')
  })

  test('matches deepest: /run/user/1000/dir is under /run/user/1000 (tmpfs), not /run (tmpfs)', () => {
    // Both /run and /run/user/1000 are tmpfs, but the deepest match wins
    const fstype = checkMountFstype('/run/user/1000/dir', fixture(REALISTIC_MOUNTINFO))
    expect(fstype).toBe('tmpfs')
  })

  test('returns null when no mount covers the path', () => {
    // /nonexistent is not under any mount in the fixture (except root — but root IS /)
    // Actually root covers everything; test with content that has no root line
    const noRootMountinfo = `\
24 23 8:2 / /home rw,relatime shared:2 - ext4 /dev/sda2 rw
`
    const fstype = checkMountFstype('/no/matching/mount', fixture(noRootMountinfo))
    // /no/matching/mount has no prefix match in this fixture
    expect(fstype).toBeNull()
  })

  test('returns null for malformed/empty content — does not throw', () => {
    const fstype = checkMountFstype('/some/path', fixture(''))
    expect(fstype).toBeNull()
  })

  test('returns null for content with only malformed lines — does not throw', () => {
    const badContent = 'this is not mountinfo\nneither is this\n'
    const fstype = checkMountFstype('/some/path', fixture(badContent))
    expect(fstype).toBeNull()
  })

  test('returns null when reader throws — does not throw', () => {
    const throws = (): string => { throw new Error('EACCES: permission denied') }
    const fstype = checkMountFstype('/some/path', throws)
    expect(fstype).toBeNull()
  })

  test('handles exact mount point match (path === mountpoint)', () => {
    const fstype = checkMountFstype('/home', fixture(REALISTIC_MOUNTINFO))
    expect(fstype).toBe('ext4')
  })

  test('handles root path /', () => {
    const fstype = checkMountFstype('/', fixture(REALISTIC_MOUNTINFO))
    expect(fstype).toBe('ext4')
  })

  test('trailing slash on dir path normalised — matches same as without trailing slash', () => {
    const withSlash = checkMountFstype('/tmp/', fixture(REALISTIC_MOUNTINFO))
    const withoutSlash = checkMountFstype('/tmp', fixture(REALISTIC_MOUNTINFO))
    expect(withSlash).toBe(withoutSlash)
  })

  test('line missing the " - " separator is skipped without throwing', () => {
    const badLine = '23 0 8:1 / / rw,relatime shared:1 ext4 /dev/sda1 rw\n'
    const goodContent = `${badLine}24 23 8:2 / /home rw,relatime shared:2 - ext4 /dev/sda2 rw\n`
    const fstype = checkMountFstype('/home/user', fixture(goodContent))
    expect(fstype).toBe('ext4')
  })
})

// ---------------------------------------------------------------------------
// checkJsonlPersistence — branch matrix
// ---------------------------------------------------------------------------

describe('checkJsonlPersistence', () => {
  function fixture(content: string): () => string {
    return () => content
  }

  // Single-route config whose root falls on /tmp (tmpfs in the fixture)
  function makeTmpfsConfig() {
    return makeRoutingConfig({
      routes: {
        C001: { cwd: '/repo', claude_config_dir: '/tmp/claude-config' },
      },
      claude_config_dir: undefined,
    })
  }

  // Single-route config whose root falls on /mnt/ramfs
  function makeRamfsConfig() {
    return makeRoutingConfig({
      routes: {
        C001: { cwd: '/repo', claude_config_dir: '/mnt/ramfs/claude-config' },
      },
      claude_config_dir: undefined,
    })
  }

  // Single-route config whose root falls on /home (ext4 in the fixture)
  function makeExt4Config() {
    return makeRoutingConfig({
      routes: {
        C001: { cwd: '/repo', claude_config_dir: '/home/user/.claude' },
      },
      claude_config_dir: undefined,
    })
  }

  test('tmpfs root → nonPersistent contains the root, warnings empty', () => {
    const result = checkJsonlPersistence(makeTmpfsConfig(), fixture(REALISTIC_MOUNTINFO))
    expect(result.nonPersistent).toEqual(['/tmp/claude-config/projects'])
    expect(result.warnings).toEqual([])
  })

  test('ramfs root (distinct case) → nonPersistent contains the root, warnings empty', () => {
    const result = checkJsonlPersistence(makeRamfsConfig(), fixture(REALISTIC_MOUNTINFO))
    expect(result.nonPersistent).toEqual(['/mnt/ramfs/claude-config/projects'])
    expect(result.warnings).toEqual([])
  })

  test('ext4 root → both nonPersistent and warnings are empty', () => {
    const result = checkJsonlPersistence(makeExt4Config(), fixture(REALISTIC_MOUNTINFO))
    expect(result.nonPersistent).toEqual([])
    expect(result.warnings).toEqual([])
  })

  test('reader throws → root goes into warnings, not nonPersistent, and does not throw', () => {
    const throws = (): string => { throw new Error('ENOENT: no such file or directory') }
    const result = checkJsonlPersistence(makeExt4Config(), throws)
    // checkMountFstype returns null on reader error → root treated as warning
    expect(result.nonPersistent).toEqual([])
    expect(result.warnings).toEqual(['/home/user/.claude/projects'])
  })

  test('unparseable mountinfo → root goes into warnings (fstype resolves to null)', () => {
    const unparseable = (): string => 'this is completely unparseable content\n'
    const result = checkJsonlPersistence(makeExt4Config(), unparseable)
    expect(result.nonPersistent).toEqual([])
    expect(result.warnings).toHaveLength(1)
    expect(result.warnings[0]).toBe('/home/user/.claude/projects')
  })

  test('multi-root mixed: one tmpfs root + one ext4 root classified independently', () => {
    const config = makeRoutingConfig({
      routes: {
        C001: { cwd: '/repo/a', claude_config_dir: '/tmp/claude-tmp' },
        C002: { cwd: '/repo/b', claude_config_dir: '/home/user/.claude-ext4' },
      },
      claude_config_dir: undefined,
    })
    const result = checkJsonlPersistence(config, fixture(REALISTIC_MOUNTINFO))
    expect(result.nonPersistent).toEqual(['/tmp/claude-tmp/projects'])
    expect(result.warnings).toEqual([])
  })

  test('multi-root: one ext4 + one warning (unresolvable mount) — each root classified per-root', () => {
    const config = makeRoutingConfig({
      routes: {
        C001: { cwd: '/repo/a', claude_config_dir: '/home/user/.claude-ext4' },
        C002: { cwd: '/repo/b', claude_config_dir: '/no/matching/mount/dir' },
      },
      claude_config_dir: undefined,
    })
    // /no/matching/mount/dir has no mount in REALISTIC_MOUNTINFO's non-root
    // But root (/) is present → actually ext4. Let's use fixture without root:
    const noRootMountinfo = `\
24 23 8:2 / /home rw,relatime shared:2 - ext4 /dev/sda2 rw,data=ordered
`
    const result = checkJsonlPersistence(config, fixture(noRootMountinfo))
    expect(result.nonPersistent).toEqual([])
    // /home/user/.claude-ext4/projects is under /home → ext4 → not in warnings
    // /no/matching/mount/dir/projects has no mount → null → in warnings
    expect(result.warnings).toEqual(['/no/matching/mount/dir/projects'])
  })

  test('two roots both on tmpfs → both in nonPersistent', () => {
    const config = makeRoutingConfig({
      routes: {
        C001: { cwd: '/repo/a', claude_config_dir: '/tmp/claude-a' },
        C002: { cwd: '/repo/b', claude_config_dir: '/dev/shm/claude-b' },
      },
      claude_config_dir: undefined,
    })
    const result = checkJsonlPersistence(config, fixture(REALISTIC_MOUNTINFO))
    expect(result.nonPersistent).toHaveLength(2)
    expect(result.nonPersistent).toContain('/tmp/claude-a/projects')
    expect(result.nonPersistent).toContain('/dev/shm/claude-b/projects')
    expect(result.warnings).toEqual([])
  })

  test('never throws even when config has no routes (fallback path)', () => {
    const config = makeRoutingConfig({ routes: {}, claude_config_dir: undefined })
    // Homedir default: root falls under whichever mount covers homedir
    expect(() => checkJsonlPersistence(config, fixture(REALISTIC_MOUNTINFO))).not.toThrow()
  })
})
