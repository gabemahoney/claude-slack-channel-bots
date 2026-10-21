/** Configured storage persistence and AD transcript-reference diagnostics (b.d6n).
 * Paths, archives and homes are confined to each test's temporary directory. */
import { describe, test, expect, afterEach, beforeEach, spyOn } from 'bun:test'
import { homedir, tmpdir } from 'node:os'
import { mkdtempSync, symlinkSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import {
  resolveJsonlRoots,
  checkMountFstype,
  checkJsonlPersistence,
  runJsonlPersistenceSafeguard,
  runPersonaStorageCheck,
  type JsonlPersistenceSafeguardDeps,
} from '../src/jsonl-persistence-check.ts'
import { personaInstanceId, renderPersonaRef } from '../src/persona-identity.ts'
import { personaConfigDirLabelValue } from '../src/session-manager.ts'
import { type PersonaConfig } from '../src/config.ts'
import type { Client } from 'agent-director'
import { _resetOutageState, initOutageState, getOutageFlags, setOutageFlag, raiseAdConfigMalformed } from '../src/outage-state.ts'
import { buildTempArchiveDb } from './test-helpers/archive-db.ts'
import { makeMultiPersonaConfig, type PersonaSpec } from './test-helpers/persona-config.ts'
import { cannedGetResult, errConfigMalformed, errSpawnNotFound, errTmuxNotAvailable, makeStubClient, type CannedGetResult, type PersonaGetResultOverrides } from './test-helpers/agent-director-stub.ts'
import {
  BOT_TOKEN_PREFIX,
  LEAK_SENTINEL,
  assertNoLeak,
  fakeToken,
  sentinelInMessage,
  REDACTED_SENTINEL_TAIL,
} from './test-helpers/credentials.ts'

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

/**
 * Captures every console.error call's arguments unformatted (errors whole,
 * with message, stack and properties) for the rest of the test, so a leak
 * check sees what the server log would write (restored after it).
 */
function captureErrorArgs(): unknown[][] {
  const calls: unknown[][] = []
  const spy = spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    calls.push(args)
  })
  cleanups.push(() => spy.mockRestore())
  return calls
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
    expect(resolveJsonlRoots(config, home)).toEqual(['/home/user/.claude-corp'])
  })

  test('per-persona claude_config_dir takes precedence over the top-level one', () => {
    const config = makeMultiPersonaConfig(
      [{ claude_config_dir: '/home/user/.claude-a' }, {}], // second inherits the top level
      makeTempDir(),
      { claude_config_dir: '/home/user/.claude-global' },
    )
    const roots = resolveJsonlRoots(config, home)
    expect(roots).toHaveLength(2)
    expect(roots).toContain('/home/user/.claude-a')
    expect(roots).toContain('/home/user/.claude-global')
  })

  test('two personas sharing a per-persona dir dedup to one root', () => {
    const config = makeMultiPersonaConfig(
      [{ claude_config_dir: '/home/user/.claude-shared' }, { claude_config_dir: '/home/user/.claude-shared' }],
      makeTempDir(),
    )
    expect(resolveJsonlRoots(config, home)).toEqual(['/home/user/.claude-shared'])
  })

  test('no config dir anywhere → <home>/.claude default', () => {
    const config = makeMultiPersonaConfig([{}], makeTempDir())
    expect(resolveJsonlRoots(config, home)).toEqual([`${home}/.claude`])
  })

  test('zero personas → <home>/.claude default fallback', () => {
    const config = makeMultiPersonaConfig([], makeTempDir())
    expect(resolveJsonlRoots(config, home)).toEqual([`${home}/.claude`])
  })

  test('home omitted → the OS home default', () => {
    const config = makeMultiPersonaConfig([{}], makeTempDir())
    expect(resolveJsonlRoots(config)).toEqual([join(homedir(), '.claude')])
  })
})

// ---------------------------------------------------------------------------
// Layer 1 — checkMountFstype (longest-prefix + malformed/edge parsing)
// ---------------------------------------------------------------------------

describe('checkMountFstype', () => {
  test.each([
    ['/tmp/some/path/to/dir', 'tmpfs', 'nested under /tmp tmpfs'],
    ['/home/user/.claude', 'ext4', 'nested under /home ext4'],
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
    expect(r.nonPersistent).toEqual(['/tmp/claude'])
    expect(r.warnings).toEqual([])
  })

  test('ramfs root → nonPersistent, no warnings', () => {
    const r = checkJsonlPersistence(configForDir('/mnt/ramfs/claude'), fixture(REALISTIC_MOUNTINFO), home)
    expect(r.nonPersistent).toEqual(['/mnt/ramfs/claude'])
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
    expect(r.warnings).toEqual(['/home/user/.claude'])
  })

  test('unresolvable mount (no root line) → warnings', () => {
    const noRoot = '24 23 8:2 / /home rw,relatime shared:2 - ext4 /dev/sda2 rw\n'
    const r = checkJsonlPersistence(configForDir('/no/matching/mount'), fixture(noRoot), home)
    expect(r.nonPersistent).toEqual([])
    expect(r.warnings).toEqual(['/no/matching/mount'])
  })

  test('multi-root mixed: tmpfs + ext4 classified independently', () => {
    const config = makeMultiPersonaConfig(
      [{ claude_config_dir: '/tmp/claude-tmp' }, { claude_config_dir: '/home/user/.claude-ext4' }],
      makeTempDir(),
    )
    const r = checkJsonlPersistence(config, fixture(REALISTIC_MOUNTINFO), home)
    expect(r.nonPersistent).toEqual(['/tmp/claude-tmp'])
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


function referenceHarness(specs: PersonaSpec[] = [{ name: 'Alpha' }]) {
  const configDir = makeTempDir('reference-config-')
  const config = makeMultiPersonaConfig(specs, makeTempDir(), { claude_config_dir: configDir })
  const errors: Array<{ key: string; message: string }> = []
  const notices: Array<{ key: string; text: string }> = []
  const lookups: Array<{ key: string; instanceId: string }> = []
  function row(key = config.personas[0]!.key, overrides: PersonaGetResultOverrides = {}): CannedGetResult {
    const p = config.personas.find(p => p.key === key)!
    return cannedGetResult({ instance_id: personaInstanceId(key), cwd: p.working_directory,
      labels: { tag_prompt: '1', config_dir: personaConfigDirLabelValue(configDir, home) },
      session_id: 'current-session', jsonl_path: join(configDir, 'ad-opaque-rollout.jsonl'),
      ...overrides }, p, home)
  }
  async function run(deps: Partial<JsonlPersistenceSafeguardDeps> = {}) {
    await runJsonlPersistenceSafeguard(config, (key, text) => { notices.push({ key, text }) }, {
      home, readMountinfo: () => '1 0 8:1 / / rw - ext4 /dev/disk rw',
      getRow: async (key, instanceId) => { lookups.push({ key, instanceId }); return row(key) },
      recordStartupError: (key, message) => { errors.push({ key, message }) }, ...deps,
    })
  }
  return { config, configDir, errors, notices, lookups, row, run }
}

describe('AD transcript references', () => {
  test.each(['present', 'unknown', undefined])('status %s reports AD facts without checking native file health or inventing loss', async status => {
    const h = referenceHarness(), logs = captureErrorLog()
    await h.run({ getRow: async () => h.row(undefined, { transcript_status: status }) })
    expect(h.errors).toEqual([])
    expect(h.notices).toEqual([])
    expect(logs.join('\n')).toContain('jsonl_path=' + h.row().jsonl_path)
    expect(logs.join('\n')).toContain('recorded references do not verify that transcript files remain readable')
    expect(logs.join('\n')).not.toMatch(/history.*LOST|never.created|fresh.spawn/i)
  })
  test('rotated status warns with uncertainty and never promises readable prior sessions', async () => {
    const h = referenceHarness()
    await h.run({ getRow: async () => h.row(undefined, { transcript_status: 'rotated', jsonl_path: '',
      prior_sessions: [{ session_id: 'old', jsonl_path: join(h.configDir, 'missing-history.jsonl') }] }) })
    expect(h.errors).toHaveLength(1)
    expect(h.errors[0]!.key).toBe('jsonl-transcript-reference-warning')
    expect(h.errors[0]!.message).toContain('prior_sessions=1')
    expect(h.notices).toHaveLength(1)
    expect(h.notices[0]!.key).toBe(h.config.personas[0]!.key)
    expect(h.notices[0]!.text).toContain('transcript_status=rotated')
    expect(h.notices[0]!.text).toContain('remain readable is unverified')
    expect(h.notices[0]!.text).not.toMatch(/history.*LOST|never.created/i)
  })
  test.each([0, 4])('Slack archive count %d cannot establish transcript loss or absence', async count => {
    const h = referenceHarness(), logs = captureErrorLog()
    const archive = buildTempArchiveDb(Array.from({ length: count }, (_, i) => ({ channel: h.config.personas[0]!.channels[0]!.id, ts: 2000000000 + i })), 'unrelated')
    cleanups.push(archive.cleanup)
    h.config.message_archive_db = archive.dbPath
    await h.run({ getRow: async () => h.row(undefined, { jsonl_path: '', transcript_status: 'unknown' }) })
    expect(h.errors).toEqual([])
    expect(h.notices).toEqual([])
    expect(logs.join('\n')).not.toMatch(/history.*LOST|never.created|archive.*(?:count|holds|shows)/i)
  })
  test.each(['absent', 'failure', 'rotated'])('one persona %s does not suppress its sibling', async answer => {
    const h = referenceHarness([{ name: 'Alpha' }, { name: 'Beta' }]), logs = captureErrorLog(), keys: string[] = []
    const [a, b] = h.config.personas
    await h.run({ getRow: async key => {
      keys.push(key)
      if (key === a!.key && answer === 'absent') throw errSpawnNotFound()
      if (key === a!.key && answer === 'failure') throw new Error('get failed')
      return h.row(key, { transcript_status: key === a!.key ? 'rotated' : 'present' })
    } })
    expect(keys).toEqual([a!.key, b!.key])
    expect(logs.join('\n')).toContain(renderPersonaRef(b!.name, b!.key))
    expect(h.notices.map(n => n.key)).toEqual(answer === 'rotated' ? [a!.key] : [])
  })
  test('queries exactly each persona instance id', async () => {
    const h = referenceHarness([{ name: 'Alpha' }, { name: 'Beta' }])
    await h.run()
    expect(h.lookups).toEqual(h.config.personas.map(p => ({ key: p.key, instanceId: personaInstanceId(p.key) })))
  })
  test.each(['cwd', 'tag_prompt', 'config_dir'])('a row replaced for %s mismatch produces no transcript warning', async mismatch => {
    const h = referenceHarness(), base = h.row(), logs = captureErrorLog()
    const row = mismatch === 'cwd' ? { ...base, cwd: makeTempDir() } : { ...base, labels: { ...base.labels, [mismatch]: 'different' } }
    await h.run({ getRow: async () => ({ ...row, transcript_status: 'rotated' }) })
    expect(h.errors).toEqual([])
    expect(h.notices).toEqual([])
    expect(logs.join('\n')).toContain('collision ladder will replace this row')
  })
  test('an unresolvable configuration directory skips its row; recovery checks it again', async () => {
    const h = referenceHarness(), logs = captureErrorLog()
    await h.run({ configDirFs: { realpath: () => { throw Object.assign(new Error('mount unavailable'), { code: 'EIO' }) } } })
    expect(h.lookups).toEqual([])
    expect(h.notices).toEqual([])
    expect(logs.join('\n')).toContain('transcript not checked this pass')
    await h.run()
    expect(h.lookups).toHaveLength(1)
  })
  test('a dangling configuration symlink skips AD; another persona is still checked', async () => {
    const h = referenceHarness([{ name: 'Alpha' }, { name: 'Beta' }]), logs = captureErrorLog()
    const link = join(makeTempDir(), 'dangling-config')
    symlinkSync(join(makeTempDir(), 'missing'), link)
    h.config.personas[0]!.claude_config_dir = link
    await h.run()
    expect(h.lookups.map(l => l.key)).toEqual([h.config.personas[1]!.key])
    expect(logs.join('\n')).toContain('transcript not checked this pass')
    expect(h.notices).toEqual([])
  })
  test('a throwing per-persona record sink does not suppress the next persona lookup', async () => {
    const h = referenceHarness([{ name: 'Alpha' }, { name: 'Beta' }]), keys: string[] = [], logs = captureErrorLog()
    await h.run({ getRow: async key => { keys.push(key); return h.row(key, { transcript_status: 'rotated' }) },
      recordStartupError: () => { throw new Error(fakeToken(BOT_TOKEN_PREFIX, 'record-sink')) } })
    expect(keys).toEqual(h.config.personas.map(p => p.key))
    expect(h.notices).toEqual([])
    assertNoLeak(logs)
  })
  test('AD fields and get errors never leak credentials into diagnostics', async () => {
    const h = referenceHarness(), args = captureErrorArgs(), token = fakeToken(BOT_TOKEN_PREFIX, 'ad-transcript')
    await h.run({ getRow: async () => h.row(undefined, { transcript_status: token, jsonl_path: join(h.configDir, token) }) })
    await h.run({ getRow: async () => { throw Object.assign(new TypeError(`AD lookup failed: ${sentinelInMessage('ad-transcript')}`), { code: 'EIO', data: LEAK_SENTINEL }) } })
    const diagnostic = args.flat().join('\n')
    expect(diagnostic).toContain('AD get failed')
    expect(diagnostic).toContain('TypeError code=EIO')
    expect(diagnostic).toContain(`message="AD lookup failed: ${REDACTED_SENTINEL_TAIL}"`)
    assertNoLeak([args, h.errors, h.notices])
  })
})

describe('AD transcript safeguard shutdown', () => {
  test.each([true, 'throw'] as const)('an initial stop (%s) reads no storage or AD state and sends nothing', async stop => {
    const h = referenceHarness()
    let mountReads = 0
    await h.run({
      isShuttingDown: () => {
        if (stop === 'throw') throw new Error('shutdown query unavailable')
        return stop
      },
      readMountinfo: () => { mountReads++; return '1 0 0:1 / / rw - tmpfs tmpfs rw' },
    })
    expect(mountReads).toBe(0)
    expect(h.lookups).toEqual([])
    expect(h.errors).toEqual([])
    expect(h.notices).toEqual([])
  })

  test.each([
    ['rotated', 'true'], ['rotated', 'throw'], ['rejected', 'true'], ['rejected', 'throw'],
  ] as const)('a deferred %s AD answer after a one-shot %s stop has no effects or sibling lookup', async (answer, stop) => {
    const h = referenceHarness([{ name: 'Alpha' }, { name: 'Beta' }])
    const logs = captureErrorLog()
    const held = Promise.withResolvers<CannedGetResult>()
    const keys: string[] = []
    let stopNextQuery = false
    const run = h.run({
      isShuttingDown: () => {
        if (!stopNextQuery) return false
        // Later queries would answer false: the pass must retain this stop.
        stopNextQuery = false
        if (stop === 'throw') throw new Error('shutdown query unavailable')
        return true
      },
      getRow: async key => { keys.push(key); return held.promise },
    })
    expect(keys).toEqual([h.config.personas[0]!.key])
    stopNextQuery = true
    if (answer === 'rejected') held.reject(new Error('late AD failure'))
    else held.resolve(h.row(undefined, { transcript_status: 'rotated' }))
    await run
    expect(keys).toEqual([h.config.personas[0]!.key])
    expect(h.errors).toEqual([])
    expect(h.notices).toEqual([])
    expect(logs.join('\n')).not.toContain('AD get failed')
  })

  test('shutdown begun by resolving the persona directory prevents its AD call', async () => {
    const h = referenceHarness()
    let shuttingDown = false
    await h.run({
      isShuttingDown: () => shuttingDown,
      configDirFs: { realpath: () => { shuttingDown = true; return h.configDir } },
    })
    expect(shuttingDown).toBe(true)
    expect(h.lookups).toEqual([])
    expect(h.errors).toEqual([])
    expect(h.notices).toEqual([])
  })

  test('shutdown begun by the record sink prevents the late notice and next persona lookup', async () => {
    const h = referenceHarness([{ name: 'Alpha' }, { name: 'Beta' }])
    const keys: string[] = []
    let shuttingDown = false
    await h.run({
      isShuttingDown: () => shuttingDown,
      getRow: async key => { keys.push(key); return h.row(key, { transcript_status: 'rotated' }) },
      recordStartupError: (key, message) => { h.errors.push({ key, message }); shuttingDown = true },
    })
    expect(keys).toEqual([h.config.personas[0]!.key])
    expect(h.errors.map(e => e.key)).toEqual(['jsonl-transcript-reference-warning'])
    expect(h.notices).toEqual([])
  })

  test('a live false query preserves storage warnings and rotated-reference notices for both personas', async () => {
    const h = referenceHarness([{ name: 'Alpha' }, { name: 'Beta' }])
    const keys: string[] = []
    await h.run({
      isShuttingDown: () => false,
      readMountinfo: () => '1 0 0:1 / / rw - tmpfs tmpfs rw',
      getRow: async key => { keys.push(key); return h.row(key, { transcript_status: 'rotated' }) },
    })
    const personaKeys = h.config.personas.map(p => p.key)
    expect(keys).toEqual(personaKeys)
    expect(h.errors.map(e => e.key)).toEqual([
      'jsonl-non-persistent', 'jsonl-transcript-reference-warning', 'jsonl-transcript-reference-warning',
    ])
    expect(h.notices.map(n => n.key)).toEqual([...personaKeys, ...personaKeys])
  })
})

describe('AD transcript safeguard shutdown through the default outage wrapper', () => {
  function defaultReadHarness() {
    const h = referenceHarness([{ name: 'Alpha' }, { name: 'Beta' }])
    const held = Promise.withResolvers<CannedGetResult>()
    const ids: string[] = []
    const arms: Array<{ key: string; kind: string }> = []
    const cleared: Array<{ key: string; cls: string }> = []
    const client = makeStubClient()
    client.get = async ({ instance_id }) => {
      ids.push(instance_id)
      if (ids.length === 1) return held.promise
      return h.row(h.config.personas.find(p => personaInstanceId(p.key) === instance_id)!.key)
    }
    _resetOutageState()
    cleanups.push(_resetOutageState)
    initOutageState({
      getClient: () => client as unknown as Client,
      notify: (key, text) => { h.notices.push({ key, text }) },
      triggerSink: { arm: (key, cause) => { arms.push({ key, kind: cause.kind }); return true } },
      onFlagCleared: (key, cls) => { cleared.push({ key, cls }) },
    })
    function run(isShuttingDown: () => boolean) {
      // Deliberately omit getRow: this must exercise defaultGetRow and its wrapper.
      return runJsonlPersistenceSafeguard(h.config, (key, text) => { h.notices.push({ key, text }) }, {
        home, isShuttingDown, readMountinfo: () => '1 0 8:1 / / rw - ext4 /dev/disk rw',
        recordStartupError: (key, message) => { h.errors.push({ key, message }) },
      })
    }
    const flags = () => h.config.personas.map(p => ({ key: p.key, flags: [...getOutageFlags(p.key)].sort() }))
    return { ...h, held, ids, arms, cleared, flags, run }
  }

  const ANSWERS = ['environment', 'config', 'success'] as const
  function lateError(answer: 'environment' | 'config') {
    return Object.assign(answer === 'environment' ? errTmuxNotAvailable(undefined, 'get') : errConfigMalformed(), {
      message: sentinelInMessage('late-default-get'), data: LEAK_SENTINEL,
    })
  }

  test.each(ANSWERS.flatMap(answer => ([true, 'throw'] as const).map(stop => [answer, stop] as const)))(
    'a deferred %s answer after a one-shot %s stop leaves outages, notices and retry scheduling untouched',
    async (answer, stop) => {
      const h = defaultReadHarness(), logs = captureErrorArgs()
      if (answer === 'success') {
        for (const p of h.config.personas) {
          setOutageFlag(p.key, 'ad-unreachable', join(h.configDir, 'agent-director'))
          raiseAdConfigMalformed(p.key, errConfigMalformed())
        }
      }
      const before = h.flags()
      h.notices.length = 0
      logs.length = 0
      let stopNextQuery = false
      let queriesAfterStop = 0
      let sawStop = false
      const run = h.run(() => {
        if (sawStop) queriesAfterStop++
        if (!stopNextQuery) return false
        stopNextQuery = false
        sawStop = true
        if (stop === 'throw') throw new Error(sentinelInMessage('shutdown-query'))
        return true
      })
      const firstId = personaInstanceId(h.config.personas[0]!.key)
      expect(h.ids).toEqual([firstId])
      stopNextQuery = true
      if (answer === 'success') h.held.resolve(h.row(undefined, { transcript_status: 'rotated' }))
      else h.held.reject(lateError(answer))
      await run
      expect(sawStop).toBe(true)
      expect(queriesAfterStop).toBe(0)
      expect(h.ids).toEqual([firstId])
      expect(h.flags()).toEqual(before)
      expect(h.arms).toEqual([])
      expect(h.cleared).toEqual([])
      expect(h.errors).toEqual([])
      expect(h.notices).toEqual([])
      expect(logs).toEqual([])
      assertNoLeak([logs, h.errors, h.notices])
    },
  )

  test.each([...ANSWERS])('a live false guard preserves the default wrapper\'s %s effects and sibling lookup', async answer => {
    const h = defaultReadHarness(), logs = captureErrorArgs()
    const first = h.config.personas[0]!
    if (answer === 'success') {
      setOutageFlag(first.key, 'ad-unreachable', join(h.configDir, 'agent-director'))
      raiseAdConfigMalformed(first.key, errConfigMalformed())
    }
    h.notices.length = 0
    logs.length = 0
    const run = h.run(() => false)
    if (answer === 'success') h.held.resolve(h.row())
    else h.held.reject(lateError(answer))
    await run
    expect(h.ids).toEqual(h.config.personas.map(p => personaInstanceId(p.key)))
    expect(h.errors).toEqual([])
    expect([...getOutageFlags(h.config.personas[1]!.key)]).toEqual([])
    expect(h.notices.map(n => n.key)).toEqual([first.key])
    expect([...getOutageFlags(first.key)]).toEqual(answer === 'success' ? [] : [answer === 'environment' ? 'tmux-unavailable' : 'ad-config-malformed'])
    expect(h.arms).toEqual(answer === 'success' ? [] : [{ key: first.key, kind: answer }])
    expect(h.cleared.map(c => c.cls)).toEqual(answer === 'success' ? ['ad-unreachable', 'ad-config-malformed'] : [])
    expect(logs.flat().join('\n')).toContain(answer === 'success' ? renderPersonaRef(first.name, first.key) : 'AD get failed')
    assertNoLeak([logs, h.errors, h.notices])
  })
})

describe('configured storage directories', () => {
  test('checks the configured directory mount without assuming a projects subdirectory', async () => {
    const h = referenceHarness()
    await h.run({ readMountinfo: () => `1 0 8:1 / / rw - ext4 /dev/disk rw\n2 1 0:1 / ${h.configDir}/projects rw - tmpfs tmpfs rw` })
    expect(h.errors).toEqual([])
    expect(h.notices).toEqual([])
  })
  test('a tmpfs directory warns its persona once; a sibling on persistent storage receives nothing', async () => {
    const aDir = makeTempDir(), bDir = makeTempDir()
    const h = referenceHarness([{ name: 'Alpha', claude_config_dir: aDir }, { name: 'Beta', claude_config_dir: bDir }])
    await h.run({ readMountinfo: () => `1 0 8:1 / / rw - ext4 /dev/disk rw\n2 1 0:1 / ${aDir} rw - tmpfs tmpfs rw` })
    expect(h.errors.map(e => e.key)).toEqual(['jsonl-non-persistent'])
    expect(h.errors[0]!.message).toContain(`root="${aDir}"`)
    expect(h.notices.map(n => n.key)).toEqual([h.config.personas[0]!.key])
  })
  test('apply storage check checks only the supplied persona and never queries AD', () => {
    const h = referenceHarness(), errors: unknown[] = [], notices: unknown[] = [], p = h.config.personas[0]!
    runPersonaStorageCheck(p, (key, text) => { notices.push({ key, text }) }, {
      home, readMountinfo: () => '1 0 0:1 / / rw - ramfs ramfs rw', recordStartupError: (key, message) => { errors.push({ key, message }) },
    })
    expect(errors).toHaveLength(1)
    expect(notices).toHaveLength(1)
    expect(h.lookups).toEqual([])
  })
})
