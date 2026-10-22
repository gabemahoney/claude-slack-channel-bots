/**
 * state-dir-migration.test.ts — The move of the server's state directory from
 * its old defaults, `~/.claude/channels/slack` (up to 0.13) and
 * `<XDG config home>/cscb` (0.14.0, 0.15.0), to the new one,
 * `<XDG config home>/claude-slack-channel-bots`:
 * `prepareStateDir`, `migrateStateDirAtStart`, `resolveCliStateDir` and
 * `resolveCliConfigPath` (src/state-dir-migration.ts).
 *
 * Claude Code asks the user before every write under `~/.claude`, so every
 * unattended change of the runtime configuration stalled on a permission
 * prompt; the default moved out, and the start moves what is at the old
 * default (`L`) to the new one (`N`). Sections:
 * - Paths and the override: `stateDirPaths` and `migrateStateDirAtStart` over
 *   an explicit home and environment; `SLACK_STATE_DIR` set (non-empty) is a
 *   no-op, `XDG_CONFIG_HOME` moves `N` (how it is read is `config.test.ts`'s).
 * - Nothing to move: `L` absent or a dangling link (`no-legacy`); `L` a link
 *   to `N`, or `N` a link to `L` (`already-migrated`); neither logs.
 * - `N` absent: `L` is renamed whole and becomes a symbolic link to `N`.
 * - `N` present (a 0.14.0 host, with crontab and prompts links back
 *   into it): entries absent from `N` move (a file as a hard link, a
 *   directory renamed, a link re-made with an absolute target), entries that
 * are the same in `N` (links, one inode, equal bytes, an empty
 *   directory) are dropped, `L` becomes a symbolic link to `N`.
 * - A conflict (different contents, or different kinds): `N`'s wins, `L`'s
 *   is untouched, one WARN, `pending`, and a later start finishes the move
 *   once the operator settled it.
 * - `L` that cannot be a source: a link to another directory, a file.
 * - Symbolic links in `L`: dangling ones move as they are (or settle against
 * the same dangling target at `N`)`L/crontab` -> `N/crontab`
 *   left after `N/crontab` was deleted is dropped (never made a self-loop),
 *   two links naming each other conflict, a relative link whose target moved
 *   first settles.
 * - A server of the old release running on `L` (a live PID in the regular
 *   file `L/server.pid`, also when `L` is a link to another directory): the
 *   start stops; a stale PID, the process's own PID, unreadable text and a
 *   PID file that is a link do not.
 * - Failures injected one file-system operation at a time through `deps.fs`:
 *   `failed` (stops the start, nothing lost; the hand-fix in the line depends
 *   on whether `N` exists) and `pending` (a WARN, the data is at `N`).
 * - Across file systems (a hard link or a rename answering `EXDEV` and the
 *   other link-unsupported errnos): a checked copy placed from a temporary
 *   name, a directory copied to a temporary name beside its destination,
 *   checked against changes and renamed into place (a failed copy or rename
 *   removes only the temporary copy), a copy of a file that changed discarded.
 * - Never overwriting: a file that appears at `N` mid-move, the renames that
 *   place the old-name link failing, a write through the old name before the
 * final cleanup links from `N` back into `L` (moved over the link).
 * - Re-runs: a second start changes nothing and logs nothing; a pending move
 *   repeats its WARN and changes nothing.
 * - The commands other than the start (`resolveCliStateDir`,
 *   `resolveCliConfigPath`): `L` while an old server runs on it (whatever `N`
 *   holds), or while it is a directory (real, or a link elsewhere) holding a
 *   configuration (or a PID file) and `N` holds no configuration; reads only.
 * - (the last sections of the file): the start from every
 *   release's layout, each seeded the way that release left a host (up to
 * 0.13: only `L1`; 0.14.0: `L1` plus a partial `L2` with links, in
 * the variants left; 0.15.0: a full `L2` and `L1` a link to it), under
 *   both XDG locations, with a rerun and `startupErrorDir` (where a stop is
 *   recorded; for a stop with `N` absent it is the stopping step's directory,
 *   so `N` is never made by the log); L1 repointed straight at `N` after a
 *   0.15.0 move (left alone unless L1 is a link to L2, L2 a link to N, and
 *   L1 really reaches N; silent when L1 is absent; a failure to repoint a
 *   WARN only); and, under `~/.config` only, a conflict at `N`, an old server on
 *   `L1` or `L2`, `SLACK_STATE_DIR`, the multi-step outcome reporting, the
 *   failure line's `SLACK_STATE_DIR` advice (left out for a legacy directory
 *   with no configuration); and `resolveCliStateDir` over the same layouts.
 *
 * Isolation: every case works under its own `mkdtempSync` root, removed in
 * `afterEach`, a fake home with the legacy directory under
 * `.claude/channels/slack`; the real home and the real state directories are
 * never named. The environment is an explicit object, never `process.env`.
 * Failures are injected through `deps.fs`; every other operation is the real
 * file system on the scratch tree. Every case's log lines go through
 * `assertNoLeak`.
 *
 * SPDX-License-Identifier: MIT
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  appendFileSync,
  chmodSync,
  copyFileSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative as relativePath, resolve, sep } from 'node:path'

import { describeThrownValueWithoutStack } from '../src/persona-connection-errors.ts'
import {
  LEGACY_XDG_DIR_NAME,
  STATE_MIGRATE_LOG_PREFIX,
  STATE_MIGRATE_WARN_PREFIX,
  NODE_STATE_DIR_MIGRATION_FS,
  legacyServerStateDir,
  legacyXdgStateDir,
  migrateStateDirAtStart,
  prepareStateDir,
  resolveCliConfigPath,
  resolveCliStateDir,
  stateDirFailedLine,
  stateDirLegacyServerRunningLine,
  stateDirLegacyUnusableLine,
  stateDirMergedLine,
  stateDirMigrationStopsStart,
  stateDirMigrationSteps,
  stateDirPaths,
  stateDirPendingLine,
  stateDirRenamedLine,
  stateDirRepointFailedLine,
  stateDirRepointedLine,
  stateDirStopMessage,
  type StateDirMigrationDeps,
  type StateDirMigrationFs,
  type StateDirMigrationOutcome,
  type StateDirPaths,
} from '../src/state-dir-migration.ts'
import { BOT_TOKEN_PREFIX, assertNoLeak, fakeToken, writeCredentialsFile } from './test-helpers/credentials.ts'
import { treeSnapshot } from './test-helpers/tree-snapshot.ts'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** A configuration in the legacy directory: a non-ASCII byte and no final newline, so a rewrite would show. */
const LEGACY_CONFIG = Buffer.from('{"legacy": "café"}', 'utf-8')

/** A configuration already in the new directory. */
const NEW_CONFIG = Buffer.from('{"new": true}\n', 'utf-8')

let root: string
let home: string
/** The legacy directory `L`. */
let legacyDir: string
/** The new default `N` (no `XDG_CONFIG_HOME`). */
let newDir: string
let paths: StateDirPaths
/** Every line the migration logged in this case. */
let lines: string[]

beforeEach(() => {
  // The real path of the root: a realpath-compared answer is then comparable to the paths built here.
  root = realpathSync(mkdtempSync(join(tmpdir(), 'state-dir-migration-test-')))
  home = join(root, 'home')
  mkdirSync(home, { recursive: true })
  legacyDir = legacyServerStateDir(home)
  newDir = join(home, '.config', 'claude-slack-channel-bots')
  paths = { legacyDir, newDir }
  lines = []
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
  // The lines carry paths and file-system error text, never a token.
  assertNoLeak(lines, 'state-dir-migration log lines')
})

/** Write `content` at `dir/name`, making the directory. */
function put(dir: string, name: string, content: string | Buffer = name): string {
  mkdirSync(dir, { recursive: true })
  const path = join(dir, name)
  writeFileSync(path, content)
  return path
}

/** An errno-style error, as the file system raises. */
function errno(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`${code}: injected by the test`), { code })
}

/** Run the preparation for this case's paths, collecting its lines. */
function run(fs?: Partial<StateDirMigrationFs>, extra: Partial<StateDirMigrationDeps> = {}): StateDirMigrationOutcome {
  return prepareStateDir(paths, { log: (line) => lines.push(line), fs, ...extra })
}

/** The names in a directory, sorted. */
function names(dir: string): string[] {
  return readdirSync(dir).sort()
}

/** Whether `path` is a symbolic link (the link itself, not what it names). */
function isLink(path: string): boolean {
  return lstatSync(path).isSymbolicLink()
}

/** `L` is now a symbolic link to `N`. */
function expectLegacyLinksToNew(): void {
  expect(isLink(legacyDir)).toBe(true)
  expect(readlinkSync(legacyDir)).toBe(newDir)
}

/** A name left by this module's own temporary links and copies. */
const TEMP_NAME = /\.cscb-migrate-/

/** No temporary name is left in `dir`. */
function expectNoTemporaries(dir: string): void {
  expect(readdirSync(dir).filter((name) => TEMP_NAME.test(name))).toEqual([])
}

/** A `link` that cannot reach across: any link whose source lies under L fails with `code`. */
function linkFailingFromLegacy(code: string): (existing: string, created: string) => void {
  return (existing, created) => {
    if (existing.startsWith(legacyDir + sep)) throw errno(code)
    linkSync(existing, created)
  }
}

/** A `rename` that fails with `code` when it renames `from` (as given), and otherwise renames. */
function renameFailingFrom(from: string, code: string): (from: string, to: string) => void {
  return (source, to) => {
    if (source === from) throw errno(code)
    renameSync(source, to)
  }
}

/** A `rename` that fails with `code` when it renames a temporary name of this module (`TEMP_NAME`) to `to`, and otherwise renames. */
function renameFailingFromTemporaryTo(to: string, code: string): (from: string, to: string) => void {
  return (source, target) => {
    if (target === to && TEMP_NAME.test(source)) throw errno(code)
    renameSync(source, target)
  }
}

// ---------------------------------------------------------------------------
// Paths and the override
// ---------------------------------------------------------------------------

describe('stateDirPaths and migrateStateDirAtStart: which directories, and when nothing moves', () => {
  test('the default install: L under ~/.claude/channels, N under ~/.config', () => {
    expect(stateDirPaths(home, {})).toEqual({
      legacyDir: join(home, '.claude', 'channels', 'slack'),
      newDir: join(home, '.config', 'claude-slack-channel-bots'),
    })
  })

  test('SLACK_STATE_DIR set: no paths, nothing to move', () => {
    expect(stateDirPaths(home, { SLACK_STATE_DIR: join(root, 'chosen') })).toBeUndefined()
  })

  test('SLACK_STATE_DIR empty: it names nothing, so the default paths', () => {
    expect(stateDirPaths(home, { SLACK_STATE_DIR: '' })).toEqual({ legacyDir, newDir })
  })

  test('SLACK_STATE_DIR set: overridden, nothing logged, L1, L2 and N untouched, and a PID file in either is not even read', () => {
    put(legacyDir, 'config.json', LEGACY_CONFIG)
    put(legacyDir, 'server.pid', '4242')
    const l2 = legacyXdgStateDir(home, {})
    put(l2, 'config.json', NEW_CONFIG)
    put(l2, 'server.pid', '4243')
    const before = treeSnapshot(root)
    let asked = false

    const result = migrateStateDirAtStart(
      {
        log: (line) => lines.push(line),
        isProcessRunning: () => {
          asked = true
          return true
        },
      },
      home,
      { SLACK_STATE_DIR: join(root, 'chosen') },
    )

    expect(result).toEqual({ paths: undefined, outcome: { kind: 'overridden' }, startupErrorDir: join(root, 'chosen') })
    expect(lines).toEqual([])
    expect(asked).toBe(false)
    expect(treeSnapshot(root)).toEqual(before)
    expect(existsSync(newDir)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Nothing to move
// ---------------------------------------------------------------------------

describe('prepareStateDir: nothing to move', () => {
  test('L absent: no-legacy, nothing logged, nothing made', () => {
    const before = treeSnapshot(root)

    expect(run()).toEqual({ kind: 'no-legacy' })

    expect(lines).toEqual([])
    expect(treeSnapshot(root)).toEqual(before)
    expect(existsSync(newDir)).toBe(false)
  })

  test('L a dangling symbolic link: no-legacy, nothing logged, the link is left', () => {
    mkdirSync(dirname(legacyDir), { recursive: true })
    symlinkSync(join(root, 'gone'), legacyDir)

    expect(run()).toEqual({ kind: 'no-legacy' })

    expect(lines).toEqual([])
    expect(readlinkSync(legacyDir)).toBe(join(root, 'gone'))
    expect(existsSync(newDir)).toBe(false)
  })

  test('L a symbolic link to N: already-migrated, nothing logged, nothing changed', () => {
    put(newDir, 'config.json', NEW_CONFIG)
    mkdirSync(dirname(legacyDir), { recursive: true })
    symlinkSync(newDir, legacyDir)
    const before = treeSnapshot(root)

    expect(run()).toEqual({ kind: 'already-migrated' })

    expect(lines).toEqual([])
    expect(treeSnapshot(root)).toEqual(before)
  })

  test('N a symbolic link to L (the reverse arrangement): already-migrated, nothing logged, nothing changed', () => {
    put(legacyDir, 'config.json', LEGACY_CONFIG)
    mkdirSync(dirname(newDir), { recursive: true })
    symlinkSync(legacyDir, newDir)
    const before = treeSnapshot(root)

    expect(run()).toEqual({ kind: 'already-migrated' })

    expect(lines).toEqual([])
    expect(treeSnapshot(root)).toEqual(before)
  })

  test('the reverse arrangement is not stopped by a live PID in L/server.pid: it is one directory', () => {
    put(legacyDir, 'server.pid', '4242')
    mkdirSync(dirname(newDir), { recursive: true })
    symlinkSync(legacyDir, newDir)

    expect(run(undefined, { isProcessRunning: () => true, ownPid: 1 })).toEqual({ kind: 'already-migrated' })
    expect(lines).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// N absent: the whole directory is renamed
// ---------------------------------------------------------------------------

describe('prepareStateDir: N absent, the whole directory is renamed', () => {
  test('L becomes N with every entry, and L a symbolic link to N; one information line', () => {
    put(legacyDir, 'config.json', LEGACY_CONFIG)
    put(legacyDir, 'config.json.last-applied', '{}')
    put(legacyDir, 'server.log', 'a line\n')
    put(legacyDir, 'crontab', '0 9 * * * prompts/a.md planner\n')
    put(join(legacyDir, 'prompts'), 'a.md', 'do the thing')
    symlinkSync('server.log', join(legacyDir, 'latest.log'))
    const legacyInode = lstatSync(join(legacyDir, 'config.json')).ino

    const outcome = run()

    expect(outcome).toEqual({ kind: 'moved', via: 'rename', entries: [] })
    expect(lines).toEqual([stateDirRenamedLine(legacyDir, newDir)])
    expect(lines[0]!.startsWith(STATE_MIGRATE_LOG_PREFIX)).toBe(true)
    expect(stateDirMigrationStopsStart(outcome)).toBe(false)
    expectLegacyLinksToNew()
    expect(names(newDir)).toEqual(['config.json', 'config.json.last-applied', 'crontab', 'latest.log', 'prompts', 'server.log'])
    expect(readFileSync(join(newDir, 'config.json'))).toEqual(LEGACY_CONFIG)
    expect(lstatSync(join(newDir, 'config.json')).ino).toBe(legacyInode)
    expect(readFileSync(join(newDir, 'prompts', 'a.md'), 'utf-8')).toBe('do the thing')
    expect(readlinkSync(join(newDir, 'latest.log'))).toBe('server.log')
    // The old name still reaches the files.
    expect(readFileSync(join(legacyDir, 'config.json'))).toEqual(LEGACY_CONFIG)
  })

  test("N's parent directory is made when it is missing", () => {
    put(legacyDir, 'config.json', LEGACY_CONFIG)
    expect(existsSync(dirname(newDir))).toBe(false)

    expect(run().kind).toBe('moved')

    expect(statSync(dirname(newDir)).isDirectory()).toBe(true)
  })

  test("N's parent already existing is fine", () => {
    put(legacyDir, 'config.json', LEGACY_CONFIG)
    mkdirSync(dirname(newDir), { recursive: true })
    put(dirname(newDir), 'other-tool.conf', 'not ours')

    expect(run()).toEqual({ kind: 'moved', via: 'rename', entries: [] })
    expect(readFileSync(join(dirname(newDir), 'other-tool.conf'), 'utf-8')).toBe('not ours')
  })
})

// ---------------------------------------------------------------------------
// N present: entries are merged
// ---------------------------------------------------------------------------

describe('prepareStateDir: N present, the entries are merged', () => {
  test('a 0.14.0 host: links into N are dropped, the rest moves, L becomes a link', () => {
    // 0.14.0: the crontab and prompts/ are real in N; L holds links to them and the configuration.
    put(newDir, 'crontab', '0 9 * * * prompts/a.md planner\n')
    put(join(newDir, 'prompts'), 'a.md', 'do the thing')
    mkdirSync(legacyDir, { recursive: true })
    symlinkSync(join(newDir, 'crontab'), join(legacyDir, 'crontab'))
    symlinkSync(join(newDir, 'prompts'), join(legacyDir, 'prompts'))
    put(legacyDir, 'config.json', LEGACY_CONFIG)
    put(legacyDir, 'server.log', 'a line\n')

    const outcome = run()

    expect(outcome).toEqual({ kind: 'moved', via: 'merge', entries: ['config.json', 'server.log'] })
    expect(lines).toEqual([stateDirMergedLine(legacyDir, newDir, ['config.json', 'server.log'])])
    expect(lines[0]!.startsWith(STATE_MIGRATE_LOG_PREFIX)).toBe(true)
    expectLegacyLinksToNew()
    expect(names(newDir)).toEqual(['config.json', 'crontab', 'prompts', 'server.log'])
    expect(readFileSync(join(newDir, 'config.json'))).toEqual(LEGACY_CONFIG)
    expect(readFileSync(join(newDir, 'crontab'), 'utf-8')).toBe('0 9 * * * prompts/a.md planner\n')
    expect(readFileSync(join(newDir, 'prompts', 'a.md'), 'utf-8')).toBe('do the thing')
    expectNoTemporaries(newDir)
    expectNoTemporaries(dirname(legacyDir))
  })

  test('an entry moves as the same file (one inode, mode kept), not a rewrite', () => {
    mkdirSync(newDir, { recursive: true })
    const legacyConfig = put(legacyDir, 'config.json', LEGACY_CONFIG)
    chmodSync(legacyConfig, 0o600)
    const { ino, mtimeMs } = lstatSync(legacyConfig)

    expect(run().kind).toBe('moved')

    const moved = lstatSync(join(newDir, 'config.json'))
    expect(moved.ino).toBe(ino)
    expect(moved.mtimeMs).toBe(mtimeMs)
    expect(moved.mode & 0o777).toBe(0o600)
  })

  test('an entry that is the same in N is dropped: one inode, equal bytes, an empty directory, a link to the same file', () => {
    put(newDir, 'config.json', NEW_CONFIG)
    mkdirSync(legacyDir, { recursive: true })
    linkSync(join(newDir, 'config.json'), join(legacyDir, 'config.json'))
    put(newDir, 'copy.json', NEW_CONFIG)
    put(legacyDir, 'copy.json', NEW_CONFIG)
    mkdirSync(join(newDir, 'empty'))
    mkdirSync(join(legacyDir, 'empty'))
    put(newDir, 'target.txt', 'target')
    symlinkSync(join(newDir, 'target.txt'), join(legacyDir, 'target.txt'))

    const outcome = run()

    expect(outcome).toEqual({ kind: 'moved', via: 'merge', entries: [] })
    expect(lines).toEqual([stateDirMergedLine(legacyDir, newDir, [])])
    expect(lines[0]).toContain('nothing needed to move')
    expectLegacyLinksToNew()
    expect(names(newDir)).toEqual(['config.json', 'copy.json', 'empty', 'target.txt'])
    expect(readFileSync(join(newDir, 'config.json'))).toEqual(NEW_CONFIG)
  })

  test('a directory absent from N is renamed into it with its contents', () => {
    mkdirSync(newDir, { recursive: true })
    put(join(legacyDir, 'sessions'), 'a.json', '{"a":1}')
    put(join(legacyDir, 'sessions', 'nested'), 'b.json', '{"b":2}')

    expect(run()).toEqual({ kind: 'moved', via: 'merge', entries: ['sessions'] })

    expect(readFileSync(join(newDir, 'sessions', 'a.json'), 'utf-8')).toBe('{"a":1}')
    expect(readFileSync(join(newDir, 'sessions', 'nested', 'b.json'), 'utf-8')).toBe('{"b":2}')
    expectLegacyLinksToNew()
    expectNoTemporaries(newDir)
  })

  test('a symbolic link absent from N is re-made with an absolute target, so a relative one still names the same file', () => {
    mkdirSync(newDir, { recursive: true })
    put(legacyDir, 'real.log', 'a line\n')
    symlinkSync('real.log', join(legacyDir, 'latest.log'))

    expect(run()).toEqual({ kind: 'moved', via: 'merge', entries: ['latest.log', 'real.log'] })

    expect(readlinkSync(join(newDir, 'latest.log'))).toBe(resolve(legacyDir, 'real.log'))
    expectLegacyLinksToNew()
  })

  test('a file in N under no name of L is left alone', () => {
    put(newDir, 'only-in-new.txt', 'mine')
    put(legacyDir, 'config.json', LEGACY_CONFIG)

    expect(run().kind).toBe('moved')

    expect(readFileSync(join(newDir, 'only-in-new.txt'), 'utf-8')).toBe('mine')
  })

  test('an empty L merges into N and becomes the link', () => {
    mkdirSync(newDir, { recursive: true })
    mkdirSync(legacyDir, { recursive: true })

    expect(run()).toEqual({ kind: 'moved', via: 'merge', entries: [] })
    expectLegacyLinksToNew()
  })
})

// ---------------------------------------------------------------------------
// Conflicts
// ---------------------------------------------------------------------------

describe('prepareStateDir: a conflicting entry (the new one wins, the old one is untouched)', () => {
  /** Each shape puts something at `x` in both directories and returns a snapshot of the legacy one. */
  const conflicts: [string, () => void][] = [
    [
      'different bytes',
      () => {
        put(legacyDir, 'x', 'old')
        put(newDir, 'x', 'new')
      },
    ],
    [
      'the same size, different bytes',
      () => {
        put(legacyDir, 'x', 'aaa')
        put(newDir, 'x', 'bbb')
      },
    ],
    [
      'a file in L, a directory in N',
      () => {
        put(legacyDir, 'x', 'old')
        mkdirSync(join(newDir, 'x'), { recursive: true })
      },
    ],
    [
      'a directory in L holding files, an empty one in N',
      () => {
        put(join(legacyDir, 'x'), 'f', 'old')
        mkdirSync(join(newDir, 'x'), { recursive: true })
      },
    ],
    [
      'a link to another file in L, a file in N',
      () => {
        mkdirSync(legacyDir, { recursive: true })
        put(root, 'elsewhere', 'elsewhere')
        symlinkSync(join(root, 'elsewhere'), join(legacyDir, 'x'))
        put(newDir, 'x', 'new')
      },
    ],
    [
      'a file in L, a link in N',
      () => {
        put(legacyDir, 'x', 'old')
        put(root, 'elsewhere', 'elsewhere')
        mkdirSync(newDir, { recursive: true })
        symlinkSync(join(root, 'elsewhere'), join(newDir, 'x'))
      },
    ],
  ]

  test.each(conflicts)('%s: pending, one WARN, both untouched', (_label, setup) => {
    setup()
    mkdirSync(newDir, { recursive: true })
    const legacyBefore = treeSnapshot(legacyDir)
    const newBefore = treeSnapshot(newDir)

    const outcome = run()

    expect(outcome).toEqual({ kind: 'pending', entries: [], conflicts: ['x'], leftover: [] })
    expect(lines).toEqual([stateDirPendingLine(legacyDir, newDir, [], ['x'], [])])
    expect(lines[0]!.startsWith(STATE_MIGRATE_WARN_PREFIX)).toBe(true)
    expect(stateDirMigrationStopsStart(outcome)).toBe(false)
    // L stays a real directory; nothing in either changed.
    expect(isLink(legacyDir)).toBe(false)
    expect(treeSnapshot(legacyDir)).toEqual(legacyBefore)
    expect(treeSnapshot(newDir)).toEqual(newBefore)
  })

  test('the entries that did move keep per-file links at the old names, and the WARN names the conflict', () => {
    put(newDir, 'config.json', NEW_CONFIG)
    put(legacyDir, 'config.json', LEGACY_CONFIG)
    put(legacyDir, 'server.log', 'a line\n')

    const outcome = run()

    expect(outcome).toEqual({ kind: 'pending', entries: ['server.log'], conflicts: ['config.json'], leftover: [] })
    expect(lines).toEqual([stateDirPendingLine(legacyDir, newDir, ['server.log'], ['config.json'], [])])
    expect(lines[0]).toContain('"config.json"')
    // N wins; L's configuration is as it was.
    expect(readFileSync(join(newDir, 'config.json'))).toEqual(NEW_CONFIG)
    expect(readFileSync(join(legacyDir, 'config.json'))).toEqual(LEGACY_CONFIG)
    expect(isLink(join(legacyDir, 'config.json'))).toBe(false)
    // The log moved; its old name is a link to the new file.
    expect(readFileSync(join(newDir, 'server.log'), 'utf-8')).toBe('a line\n')
    expect(isLink(join(legacyDir, 'server.log'))).toBe(true)
    expect(readFileSync(join(legacyDir, 'server.log'), 'utf-8')).toBe('a line\n')
    expect(isLink(legacyDir)).toBe(false)
    expectNoTemporaries(legacyDir)
    expectNoTemporaries(newDir)
  })

  test('every conflicting entry is named, in name order', () => {
    put(newDir, 'b.json', 'new b')
    put(newDir, 'a.json', 'new a')
    put(legacyDir, 'b.json', 'old b')
    put(legacyDir, 'a.json', 'old a')

    expect(run()).toEqual({ kind: 'pending', entries: [], conflicts: ['a.json', 'b.json'], leftover: [] })
    expect(lines).toEqual([stateDirPendingLine(legacyDir, newDir, [], ['a.json', 'b.json'], [])])
  })

  test('a second start with the conflict still there repeats the WARN and changes nothing', () => {
    put(newDir, 'config.json', NEW_CONFIG)
    put(legacyDir, 'config.json', LEGACY_CONFIG)
    put(legacyDir, 'server.log', 'a line\n')
    run()
    lines.length = 0
    const before = treeSnapshot(root)

    const outcome = run()

    expect(outcome).toEqual({ kind: 'pending', entries: [], conflicts: ['config.json'], leftover: [] })
    expect(lines).toEqual([stateDirPendingLine(legacyDir, newDir, [], ['config.json'], [])])
    expect(treeSnapshot(root)).toEqual(before)
  })

  test('the retry finishes the move once the operator removed the old conflicting file', () => {
    put(newDir, 'config.json', NEW_CONFIG)
    put(legacyDir, 'config.json', LEGACY_CONFIG)
    put(legacyDir, 'server.log', 'a line\n')
    run()
    lines.length = 0
    rmSync(join(legacyDir, 'config.json'))

    const outcome = run()

    expect(outcome).toEqual({ kind: 'moved', via: 'merge', entries: [] })
    expect(lines).toEqual([stateDirMergedLine(legacyDir, newDir, [])])
    expectLegacyLinksToNew()
    expect(readFileSync(join(newDir, 'config.json'))).toEqual(NEW_CONFIG)
    expect(readFileSync(join(newDir, 'server.log'), 'utf-8')).toBe('a line\n')
  })

  test('the retry finishes the move once the operator made the two files the same', () => {
    put(newDir, 'config.json', NEW_CONFIG)
    put(legacyDir, 'config.json', LEGACY_CONFIG)
    run()
    lines.length = 0
    copyFileSync(join(newDir, 'config.json'), join(legacyDir, 'config.json'))

    expect(run()).toEqual({ kind: 'moved', via: 'merge', entries: [] })
    expectLegacyLinksToNew()
    expect(readFileSync(join(newDir, 'config.json'))).toEqual(NEW_CONFIG)
  })
})

// ---------------------------------------------------------------------------
// L cannot be a source
// ---------------------------------------------------------------------------

describe('prepareStateDir: L that cannot be a source', () => {
  test('L a symbolic link to another directory: legacy-unusable, one WARN naming its target, nothing moved', () => {
    const elsewhere = join(root, 'elsewhere')
    put(elsewhere, 'config.json', LEGACY_CONFIG)
    mkdirSync(dirname(legacyDir), { recursive: true })
    symlinkSync(elsewhere, legacyDir)
    const before = treeSnapshot(root)

    const outcome = run()

    expect(outcome).toEqual({ kind: 'legacy-unusable', reason: 'link-elsewhere' })
    expect(lines).toEqual([stateDirLegacyUnusableLine(legacyDir, newDir, 'link-elsewhere', elsewhere)])
    expect(lines[0]!.startsWith(STATE_MIGRATE_WARN_PREFIX)).toBe(true)
    expect(lines[0]).toContain(`SLACK_STATE_DIR=${elsewhere}`)
    expect(stateDirMigrationStopsStart(outcome)).toBe(false)
    expect(treeSnapshot(root)).toEqual(before)
    expect(existsSync(newDir)).toBe(false)
  })

  test('L not a directory: legacy-unusable, one WARN, nothing moved', () => {
    put(dirname(legacyDir), 'slack', 'a file where a directory should be')
    const before = treeSnapshot(root)

    const outcome = run()

    expect(outcome).toEqual({ kind: 'legacy-unusable', reason: 'not-directory' })
    expect(lines).toEqual([stateDirLegacyUnusableLine(legacyDir, newDir, 'not-directory')])
    expect(lines[0]!.startsWith(STATE_MIGRATE_WARN_PREFIX)).toBe(true)
    expect(stateDirMigrationStopsStart(outcome)).toBe(false)
    expect(treeSnapshot(root)).toEqual(before)
    expect(existsSync(newDir)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// An old server running
// ---------------------------------------------------------------------------

describe('prepareStateDir: a server of the old release running on L', () => {
  const LIVE_PID = 4242

  test('a live PID in L/server.pid: legacy-server-running, the start stops, nothing moved', () => {
    put(legacyDir, 'server.pid', `${LIVE_PID}\n`)
    put(legacyDir, 'config.json', LEGACY_CONFIG)
    const before = treeSnapshot(root)

    const outcome = run(undefined, { isProcessRunning: (pid) => pid === LIVE_PID, ownPid: 1 })

    expect(outcome).toEqual({ kind: 'legacy-server-running', pid: LIVE_PID })
    expect(stateDirMigrationStopsStart(outcome)).toBe(true)
    // The caller logs and records the stop (stateDirStopMessage); the preparation itself logs nothing.
    expect(lines).toEqual([])
    const stop = stateDirStopMessage(paths, outcome)
    expect(stop).toBe(stateDirLegacyServerRunningLine(legacyDir, newDir, LIVE_PID))
    expect(stop.startsWith(STATE_MIGRATE_LOG_PREFIX)).toBe(true)
    expect(stop).toContain(`PID ${LIVE_PID}`)
    lines.push(stop)
    expect(treeSnapshot(root)).toEqual(before)
    expect(existsSync(newDir)).toBe(false)
  })

  test('it stops with N present too, before any entry moves', () => {
    mkdirSync(newDir, { recursive: true })
    put(legacyDir, 'server.pid', String(LIVE_PID))
    put(legacyDir, 'config.json', LEGACY_CONFIG)
    const before = treeSnapshot(root)

    expect(run(undefined, { isProcessRunning: () => true, ownPid: 1 })).toEqual({ kind: 'legacy-server-running', pid: LIVE_PID })
    expect(treeSnapshot(root)).toEqual(before)
  })

  test('the moved server can start once the old one is gone', () => {
    put(legacyDir, 'server.pid', String(LIVE_PID))
    put(legacyDir, 'config.json', LEGACY_CONFIG)
    expect(run(undefined, { isProcessRunning: () => true, ownPid: 1 }).kind).toBe('legacy-server-running')
    lines.length = 0

    expect(run(undefined, { isProcessRunning: () => false, ownPid: 1 })).toEqual({ kind: 'moved', via: 'rename', entries: [] })
    expectLegacyLinksToNew()
  })

  test.each([
    ['a stale PID (no such process)', String(LIVE_PID), { isProcessRunning: () => false, ownPid: 1 }],
    ["the process's own PID", String(LIVE_PID), { isProcessRunning: () => true, ownPid: LIVE_PID }],
    ['text that is not a number', 'not-a-pid', { isProcessRunning: () => true, ownPid: 1 }],
    ['an empty file', '', { isProcessRunning: () => true, ownPid: 1 }],
  ])('%s does not stop the start', (_label, content, deps) => {
    put(legacyDir, 'server.pid', content)

    const outcome = run(undefined, deps)

    expect(outcome.kind).toBe('moved')
    expect(stateDirMigrationStopsStart(outcome)).toBe(false)
  })

  test("a PID file that is a link to N's (an interrupted move) does not stop the start", () => {
    put(newDir, 'server.pid', String(LIVE_PID))
    mkdirSync(legacyDir, { recursive: true })
    symlinkSync(join(newDir, 'server.pid'), join(legacyDir, 'server.pid'))

    expect(run(undefined, { isProcessRunning: () => true, ownPid: 1 })).toEqual({ kind: 'moved', via: 'merge', entries: [] })
  })

  describe('L a symbolic link to another directory (an operator\'s arrangement, which the CLI acts on)', () => {
    /** `L` links to `elsewhere`, which holds a configuration and, when `pid` is given, `server.pid`. */
    function linkElsewhere(pid?: string): string {
      const elsewhere = join(root, 'elsewhere')
      put(elsewhere, 'config.json', LEGACY_CONFIG)
      if (pid !== undefined) put(elsewhere, 'server.pid', pid)
      mkdirSync(dirname(legacyDir), { recursive: true })
      symlinkSync(elsewhere, legacyDir)
      return elsewhere
    }

    test('a live PID in the linked directory: legacy-server-running with that PID, no WARN, nothing moved', () => {
      linkElsewhere(`${LIVE_PID}\n`)
      const before = treeSnapshot(root)

      const outcome = run(undefined, { isProcessRunning: (pid) => pid === LIVE_PID, ownPid: 1 })

      expect(outcome).toEqual({ kind: 'legacy-server-running', pid: LIVE_PID })
      expect(stateDirMigrationStopsStart(outcome)).toBe(true)
      expect(lines).toEqual([])
      expect(stateDirStopMessage(paths, outcome)).toBe(stateDirLegacyServerRunningLine(legacyDir, newDir, LIVE_PID))
      expect(treeSnapshot(root)).toEqual(before)
      expect(existsSync(newDir)).toBe(false)
    })

    test('a live PID with N present too: still legacy-server-running', () => {
      linkElsewhere(String(LIVE_PID))
      mkdirSync(newDir, { recursive: true })

      expect(run(undefined, { isProcessRunning: () => true, ownPid: 1 })).toEqual({ kind: 'legacy-server-running', pid: LIVE_PID })
      expect(lines).toEqual([])
    })

    test.each<[string, string | undefined, Partial<StateDirMigrationDeps>]>([
      ['a stale PID (no such process)', String(LIVE_PID), { isProcessRunning: () => false, ownPid: 1 }],
      ["the process's own PID", String(LIVE_PID), { isProcessRunning: () => true, ownPid: LIVE_PID }],
      ['text that is not a number', 'not-a-pid', { isProcessRunning: () => true, ownPid: 1 }],
      ['an absent PID file', undefined, { isProcessRunning: () => true, ownPid: 1 }],
    ])('%s: legacy-unusable with its one WARN, the start goes on', (_label, pid, deps) => {
      const elsewhere = linkElsewhere(pid)
      const before = treeSnapshot(root)

      const outcome = run(undefined, deps)

      expect(outcome).toEqual({ kind: 'legacy-unusable', reason: 'link-elsewhere' })
      expect(stateDirMigrationStopsStart(outcome)).toBe(false)
      expect(lines).toEqual([stateDirLegacyUnusableLine(legacyDir, newDir, 'link-elsewhere', elsewhere)])
      expect(treeSnapshot(root)).toEqual(before)
    })

    test('a PID file in the linked directory that is itself a link is not an old server', () => {
      const elsewhere = linkElsewhere()
      put(root, 'other.pid', String(LIVE_PID))
      symlinkSync(join(root, 'other.pid'), join(elsewhere, 'server.pid'))

      expect(run(undefined, { isProcessRunning: () => true, ownPid: 1 })).toEqual({ kind: 'legacy-unusable', reason: 'link-elsewhere' })
    })

    test('L a link to N with a live PID in the shared directory: already-migrated, as before', () => {
      put(newDir, 'server.pid', String(LIVE_PID))
      mkdirSync(dirname(legacyDir), { recursive: true })
      symlinkSync(newDir, legacyDir)

      expect(run(undefined, { isProcessRunning: () => true, ownPid: 1 })).toEqual({ kind: 'already-migrated' })
      expect(lines).toEqual([])
    })
  })
})

// ---------------------------------------------------------------------------
// Failures
// ---------------------------------------------------------------------------

describe('prepareStateDir: a step that fails', () => {
  test('N cannot be made (L renamed whole): failed at mkdir, the start stops, L untouched', () => {
    put(legacyDir, 'config.json', LEGACY_CONFIG)
    const before = treeSnapshot(root)

    const outcome = run({
      mkdirp: () => {
        throw errno('EACCES')
      },
    })

    expect(outcome.kind).toBe('failed')
    if (outcome.kind !== 'failed') return
    expect(outcome.step).toBe('mkdir')
    expect(outcome.cause).toContain('EACCES')
    expect(outcome.failures).toEqual([])
    expect(outcome.newDirExists).toBe(false)
    expect(stateDirMigrationStopsStart(outcome)).toBe(true)
    expect(lines).toEqual([stateDirFailedLine(legacyDir, newDir, 'mkdir', outcome.cause, [], false)])
    expect(lines[0]!.startsWith(STATE_MIGRATE_LOG_PREFIX)).toBe(true)
    expect(lines[0]).toContain(`SLACK_STATE_DIR=${legacyDir}`)
    // N is absent, so the hand-fix is the one mv of the whole directory.
    expect(lines[0]).toContain(`mv ${legacyDir} ${newDir} && ln -s ${newDir} ${legacyDir}`)
    expect(treeSnapshot(root)).toEqual(before)
  })

  test('the whole-directory rename refused (not EXDEV): failed at move, naming L, L untouched', () => {
    put(legacyDir, 'config.json', LEGACY_CONFIG)
    const legacyBefore = treeSnapshot(legacyDir)

    const outcome = run({
      rename: () => {
        throw errno('EACCES')
      },
    })

    expect(outcome.kind).toBe('failed')
    if (outcome.kind !== 'failed') return
    expect(outcome.step).toBe('move')
    expect(outcome.failures).toHaveLength(1)
    expect(outcome.failures[0]!.name).toBe('slack')
    expect(outcome.failures[0]!.cause).toContain('EACCES')
    expect(outcome.newDirExists).toBe(false)
    expect(lines).toEqual([outcome.cause])
    expect(outcome.cause).toBe(stateDirFailedLine(legacyDir, newDir, 'move', '', outcome.failures, false))
    expect(outcome.cause).toContain(`mv ${legacyDir} ${newDir} && ln -s ${newDir} ${legacyDir}`)
    expect(stateDirMigrationStopsStart(outcome)).toBe(true)
    expect(treeSnapshot(legacyDir)).toEqual(legacyBefore)
    expect(isLink(legacyDir)).toBe(false)
    expect(readFileSync(join(legacyDir, 'config.json'))).toEqual(LEGACY_CONFIG)
    expect(existsSync(newDir)).toBe(false)
  })

  test('N exists and is not a directory: failed at mkdir, the start stops, L untouched', () => {
    mkdirSync(dirname(newDir), { recursive: true })
    writeFileSync(newDir, 'a file where a directory should be')
    put(legacyDir, 'config.json', LEGACY_CONFIG)
    const before = treeSnapshot(root)

    const outcome = run()

    expect(outcome).toEqual({
      kind: 'failed',
      step: 'mkdir',
      cause: `${newDir} exists and is not a directory`,
      failures: [],
      newDirExists: true,
    })
    // N is there, so a `mv L N` would put L inside it: the hand-fix is per entry.
    expect(lines).toEqual([stateDirFailedLine(legacyDir, newDir, 'mkdir', `${newDir} exists and is not a directory`, [], true)])
    expect(lines[0]).not.toContain(`mv ${legacyDir} ${newDir} &&`)
    expect(treeSnapshot(root)).toEqual(before)
  })

  test('an entry that cannot be linked (EACCES): failed at move naming it, the entry stays whole in L, nothing is half-placed', () => {
    mkdirSync(newDir, { recursive: true })
    put(legacyDir, 'config.json', LEGACY_CONFIG)
    put(legacyDir, 'server.log', 'a line\n')

    const outcome = run({
      link: (existing, created) => {
        if (existing === join(legacyDir, 'config.json')) throw errno('EACCES')
        linkSync(existing, created)
      },
    })

    expect(outcome.kind).toBe('failed')
    if (outcome.kind !== 'failed') return
    expect(outcome.step).toBe('move')
    expect(outcome.failures.map((f) => f.name)).toEqual(['config.json'])
    expect(outcome.failures[0]!.cause).toContain('EACCES')
    expect(outcome.newDirExists).toBe(true)
    expect(lines).toEqual([outcome.cause])
    expect(outcome.cause).toBe(stateDirFailedLine(legacyDir, newDir, 'move', '', outcome.failures, true))
    expect(outcome.cause).toContain('"config.json"')
    // N exists: the per-entry recipe, never the mv of the whole directory.
    expect(outcome.cause).toContain(`(mv ${legacyDir}/<name> ${newDir}/<name>)`)
    expect(outcome.cause).not.toContain(`mv ${legacyDir} ${newDir} &&`)
    expect(stateDirMigrationStopsStart(outcome)).toBe(true)
    // Nothing lost: the configuration is whole in L, absent from N, and no temporary name is left.
    expect(isLink(join(legacyDir, 'config.json'))).toBe(false)
    expect(readFileSync(join(legacyDir, 'config.json'))).toEqual(LEGACY_CONFIG)
    expect(existsSync(join(newDir, 'config.json'))).toBe(false)
    expect(isLink(legacyDir)).toBe(false)
    expectNoTemporaries(legacyDir)
    expectNoTemporaries(newDir)
  })

  test('the start that follows a failed move finishes it', () => {
    mkdirSync(newDir, { recursive: true })
    put(legacyDir, 'config.json', LEGACY_CONFIG)
    expect(
      run({
        link: () => {
          throw errno('EACCES')
        },
      }).kind,
    ).toBe('failed')
    lines.length = 0

    expect(run()).toEqual({ kind: 'moved', via: 'merge', entries: ['config.json'] })
    expectLegacyLinksToNew()
    expect(readFileSync(join(newDir, 'config.json'))).toEqual(LEGACY_CONFIG)
  })

  test('an entry that cannot be compared with its twin in N: failed at move naming it', () => {
    put(newDir, 'config.json', NEW_CONFIG)
    put(legacyDir, 'config.json', LEGACY_CONFIG)

    const outcome = run({
      lstat: (path) => {
        if (path === join(legacyDir, 'config.json')) throw errno('EACCES')
        return lstatSync(path)
      },
    })

    expect(outcome.kind).toBe('failed')
    if (outcome.kind !== 'failed') return
    expect(outcome.step).toBe('move')
    expect(outcome.failures.map((f) => f.name)).toEqual(['config.json'])
    expect(readFileSync(join(legacyDir, 'config.json'))).toEqual(LEGACY_CONFIG)
  })

  test('L that cannot be listed: failed as unexpected, the start stops, nothing changed', () => {
    mkdirSync(newDir, { recursive: true })
    put(legacyDir, 'config.json', LEGACY_CONFIG)
    const before = treeSnapshot(root)

    const outcome = run({
      readdir: (path) => {
        if (path === legacyDir) throw errno('EACCES')
        return readdirSync(path)
      },
    })

    expect(outcome.kind).toBe('failed')
    if (outcome.kind !== 'failed') return
    expect(outcome.step).toBe('unexpected')
    expect(outcome.cause).toContain('EACCES')
    expect(outcome.newDirExists).toBe(true)
    expect(lines).toEqual([stateDirFailedLine(legacyDir, newDir, 'unexpected', outcome.cause, [], true)])
    expect(lines[0]).toContain(`(mv ${legacyDir}/<name> ${newDir}/<name>)`)
    expect(stateDirMigrationStopsStart(outcome)).toBe(true)
    expect(treeSnapshot(root)).toEqual(before)
  })

  test('L that cannot be looked at (not just absent): failed as unexpected, never thrown', () => {
    const outcome = run({
      lstat: () => {
        throw errno('EACCES')
      },
    })

    expect(outcome.kind).toBe('failed')
    if (outcome.kind !== 'failed') return
    expect(outcome.step).toBe('unexpected')
    expect(lines).toHaveLength(1)
    // N cannot be looked at either: an unknown state counts as present, so no mv of the whole directory is advised.
    expect(outcome.newDirExists).toBe(true)
    expect(lines[0]).not.toContain(`mv ${legacyDir} ${newDir} &&`)
  })

  test('L that cannot be looked at while N is absent: failed as unexpected, the mv recipe of the whole directory', () => {
    put(legacyDir, 'config.json', LEGACY_CONFIG)

    const outcome = run({
      lstat: (path) => {
        if (path === legacyDir) throw errno('EACCES')
        return lstatSync(path)
      },
    })

    expect(outcome).toEqual({ kind: 'failed', step: 'unexpected', cause: expect.stringContaining('EACCES'), failures: [], newDirExists: false })
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain(`mv ${legacyDir} ${newDir} && ln -s ${newDir} ${legacyDir}`)
  })

  test('a duplicate that cannot be removed: pending with the leftover named, a WARN, the start goes on', () => {
    put(newDir, 'copy.json', NEW_CONFIG)
    put(legacyDir, 'copy.json', NEW_CONFIG)

    const outcome = run({
      unlink: (path) => {
        if (path === join(legacyDir, 'copy.json')) throw errno('EACCES')
        rmSync(path)
      },
    })

    expect(outcome).toEqual({ kind: 'pending', entries: [], conflicts: [], leftover: ['copy.json'] })
    expect(lines).toEqual([stateDirPendingLine(legacyDir, newDir, [], [], ['copy.json'])])
    expect(lines[0]!.startsWith(STATE_MIGRATE_WARN_PREFIX)).toBe(true)
    expect(stateDirMigrationStopsStart(outcome)).toBe(false)
    expect(isLink(legacyDir)).toBe(false)
    expect(readFileSync(join(legacyDir, 'copy.json'))).toEqual(NEW_CONFIG)
  })

  test('L that cannot be emptied at the end (rmdir refused): pending, one WARN, the data is at N, no temporary link left', () => {
    mkdirSync(newDir, { recursive: true })
    put(legacyDir, 'config.json', LEGACY_CONFIG)

    const outcome = run({
      rmdir: () => {
        throw errno('ENOTEMPTY')
      },
    })

    expect(outcome).toEqual({ kind: 'pending', entries: ['config.json'], conflicts: [], leftover: [] })
    expect(lines).toHaveLength(1)
    expect(lines[0]!.startsWith(STATE_MIGRATE_WARN_PREFIX)).toBe(true)
    expect(lines[0]).toContain('could not be replaced with a symbolic link')
    expect(lines[0]).toContain(`ln -s ${newDir} ${legacyDir}`)
    expect(stateDirMigrationStopsStart(outcome)).toBe(false)
    expect(readFileSync(join(newDir, 'config.json'))).toEqual(LEGACY_CONFIG)
    expectNoTemporaries(dirname(legacyDir))
  })

  /** A `symlink` that fails at the old name because a writer recreated it, with a file in it, in that instant. */
  function symlinkLosingRaceAtLegacyName(): (target: string, path: string) => void {
    return (target, path) => {
      if (path === legacyDir) {
        mkdirSync(path)
        put(path, 'late.log', 'written in that instant\n')
        throw errno('EEXIST')
      }
      symlinkSync(target, path)
    }
  }

  test('the old name recreated in the instant after the whole-directory rename: pending, one WARN, the data is at N', () => {
    put(legacyDir, 'config.json', LEGACY_CONFIG)

    const outcome = run({ symlink: symlinkLosingRaceAtLegacyName() })

    expect(outcome).toEqual({ kind: 'pending', entries: [], conflicts: [], leftover: [] })
    expect(lines).toHaveLength(1)
    expect(lines[0]!.startsWith(STATE_MIGRATE_WARN_PREFIX)).toBe(true)
    expect(lines[0]).toContain('could not be replaced with a symbolic link')
    expect(stateDirMigrationStopsStart(outcome)).toBe(false)
    expect(readFileSync(join(newDir, 'config.json'))).toEqual(LEGACY_CONFIG)
    expect(isLink(legacyDir)).toBe(false)
  })

  test('the next start merges what the recreated old name holds and places the link', () => {
    put(legacyDir, 'config.json', LEGACY_CONFIG)
    run({ symlink: symlinkLosingRaceAtLegacyName() })
    lines.length = 0

    expect(run()).toEqual({ kind: 'moved', via: 'merge', entries: ['late.log'] })

    expect(lines).toEqual([stateDirMergedLine(legacyDir, newDir, ['late.log'])])
    expectLegacyLinksToNew()
    expect(readFileSync(join(newDir, 'late.log'), 'utf-8')).toBe('written in that instant\n')
    expect(readFileSync(join(newDir, 'config.json'))).toEqual(LEGACY_CONFIG)
  })
})

// ---------------------------------------------------------------------------
// Across file systems
// ---------------------------------------------------------------------------

describe('prepareStateDir: across file systems', () => {
  test('the whole-directory rename answering EXDEV: the entries move one by one into a new N, L becomes the link', () => {
    put(legacyDir, 'config.json', LEGACY_CONFIG)
    put(legacyDir, 'server.log', 'a line\n')
    put(join(legacyDir, 'prompts'), 'a.md', 'do the thing')

    const outcome = run({ rename: renameFailingFrom(legacyDir, 'EXDEV') })

    expect(outcome).toEqual({ kind: 'moved', via: 'merge', entries: ['config.json', 'prompts', 'server.log'] })
    expect(lines).toEqual([stateDirMergedLine(legacyDir, newDir, ['config.json', 'prompts', 'server.log'])])
    expectLegacyLinksToNew()
    expect(names(newDir)).toEqual(['config.json', 'prompts', 'server.log'])
    expect(readFileSync(join(newDir, 'config.json'))).toEqual(LEGACY_CONFIG)
    expect(readFileSync(join(newDir, 'prompts', 'a.md'), 'utf-8')).toBe('do the thing')
    expectNoTemporaries(newDir)
  })

  test('a failed N mkdir after an EXDEV rename: failed at mkdir, the start stops', () => {
    put(legacyDir, 'config.json', LEGACY_CONFIG)
    let made = 0

    const outcome = run({
      rename: renameFailingFrom(legacyDir, 'EXDEV'),
      mkdirp: (path) => {
        made += 1
        // The parent is made; the second call, for N itself, fails.
        if (made === 2) throw errno('ENOSPC')
        mkdirSync(path, { recursive: true })
      },
    })

    expect(outcome.kind).toBe('failed')
    if (outcome.kind !== 'failed') return
    expect(outcome.step).toBe('mkdir')
    expect(outcome.cause).toContain('ENOSPC')
    expect(readFileSync(join(legacyDir, 'config.json'))).toEqual(LEGACY_CONFIG)
  })

  test.each(['EXDEV', 'EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'EMLINK'])(
    'a hard link answering %s: the file is copied, checked and placed, its mode and bytes kept, no temporary name left',
    (code) => {
      mkdirSync(newDir, { recursive: true })
      const legacyConfig = put(legacyDir, 'config.json', LEGACY_CONFIG)
      chmodSync(legacyConfig, 0o600)

      const outcome = run({ link: linkFailingFromLegacy(code) })

      expect(outcome).toEqual({ kind: 'moved', via: 'merge', entries: ['config.json'] })
      expect(lines).toEqual([stateDirMergedLine(legacyDir, newDir, ['config.json'])])
      expect(readFileSync(join(newDir, 'config.json'))).toEqual(LEGACY_CONFIG)
      expect(lstatSync(join(newDir, 'config.json')).mode & 0o777).toBe(0o600)
      expectLegacyLinksToNew()
      expect(names(newDir)).toEqual(['config.json'])
    },
  )

  test('a hard link refused for another reason (EACCES) is not worked around by a copy: failed, nothing placed', () => {
    mkdirSync(newDir, { recursive: true })
    put(legacyDir, 'config.json', LEGACY_CONFIG)
    let copies = 0

    const outcome = run({
      link: linkFailingFromLegacy('EACCES'),
      copyFileExclusive: (src, dest) => {
        copies += 1
        copyFileSync(src, dest)
      },
    })

    expect(outcome.kind).toBe('failed')
    expect(copies).toBe(0)
    expect(existsSync(join(newDir, 'config.json'))).toBe(false)
  })

  test('a file that changes while it is copied: the copy is discarded, failed at move, the file stays whole in L', () => {
    mkdirSync(newDir, { recursive: true })
    const legacyConfig = put(legacyDir, 'config.json', LEGACY_CONFIG)

    const outcome = run({
      link: linkFailingFromLegacy('EXDEV'),
      copyFileExclusive: (src, dest) => {
        copyFileSync(src, dest)
        appendFileSync(src, 'a line appended during the copy\n')
      },
    })

    expect(outcome.kind).toBe('failed')
    if (outcome.kind !== 'failed') return
    expect(outcome.step).toBe('move')
    expect(outcome.failures.map((f) => f.name)).toEqual(['config.json'])
    expect(outcome.failures[0]!.cause).toContain('changed while it was being copied')
    expect(existsSync(join(newDir, 'config.json'))).toBe(false)
    expectNoTemporaries(newDir)
    expectNoTemporaries(legacyDir)
    expect(readFileSync(legacyConfig, 'utf-8')).toBe(`${LEGACY_CONFIG.toString('utf-8')}a line appended during the copy\n`)
  })

  test('a directory across file systems (rename answering EXDEV): copied to a temporary name in N, renamed into place, the old one removed', () => {
    mkdirSync(newDir, { recursive: true })
    put(join(legacyDir, 'sessions'), 'a.json', '{"a":1}')
    put(join(legacyDir, 'sessions', 'nested'), 'b.json', '{"b":2}')
    const copied: [string, string][] = []

    const outcome = run({
      rename: renameFailingFrom(join(legacyDir, 'sessions'), 'EXDEV'),
      copyDirExclusive: (src, dest) => {
        copied.push([src, dest])
        NODE_STATE_DIR_MIGRATION_FS.copyDirExclusive(src, dest)
      },
    })

    expect(outcome).toEqual({ kind: 'moved', via: 'merge', entries: ['sessions'] })
    // The copy goes to a temporary name beside the destination, never to the destination itself.
    expect(copied).toHaveLength(1)
    const [copySrc, copyDest] = copied[0]!
    expect(copySrc).toBe(join(legacyDir, 'sessions'))
    expect(dirname(copyDest)).toBe(newDir)
    expect(copyDest).not.toBe(join(newDir, 'sessions'))
    expect(copyDest.slice(newDir.length + 1)).toMatch(/^\.sessions\.cscb-migrate-/)
    expect(names(newDir)).toEqual(['sessions'])
    expect(isLink(join(newDir, 'sessions'))).toBe(false)
    expect(readFileSync(join(newDir, 'sessions', 'a.json'), 'utf-8')).toBe('{"a":1}')
    expect(readFileSync(join(newDir, 'sessions', 'nested', 'b.json'), 'utf-8')).toBe('{"b":2}')
    expectNoTemporaries(newDir)
    expectNoTemporaries(dirname(legacyDir))
    expectLegacyLinksToNew()
  })

  test('a directory copy whose final rename fails: the temporary copy is removed, N has no such entry, the original stays whole in L', () => {
    mkdirSync(newDir, { recursive: true })
    const sessions = join(legacyDir, 'sessions')
    put(sessions, 'a.json', '{"a":1}')
    const dst = join(newDir, 'sessions')

    const outcome = run({
      rename: (from, to) => {
        if (from === sessions) throw errno('EXDEV')
        if (to === dst && TEMP_NAME.test(from)) throw errno('EACCES')
        renameSync(from, to)
      },
    })

    expect(outcome.kind).toBe('failed')
    if (outcome.kind !== 'failed') return
    expect(outcome.step).toBe('move')
    expect(outcome.failures.map((f) => f.name)).toEqual(['sessions'])
    expect(outcome.failures[0]!.cause).toContain('EACCES')
    expect(existsSync(dst)).toBe(false)
    expect(names(newDir)).toEqual([])
    expectNoTemporaries(newDir)
    expectNoTemporaries(legacyDir)
    expect(isLink(sessions)).toBe(false)
    expect(readFileSync(join(sessions, 'a.json'), 'utf-8')).toBe('{"a":1}')
    lines.length = 0

    // The next start, with the rename working again, finishes the move.
    expect(run({ rename: renameFailingFrom(sessions, 'EXDEV') })).toEqual({ kind: 'moved', via: 'merge', entries: ['sessions'] })
    expect(readFileSync(join(dst, 'a.json'), 'utf-8')).toBe('{"a":1}')
  })

  test('an empty directory that appeared at the destination is not removed when the copy fails', () => {
    mkdirSync(newDir, { recursive: true })
    const sessions = join(legacyDir, 'sessions')
    put(sessions, 'a.json', '{"a":1}')
    const dst = join(newDir, 'sessions')

    const outcome = run({
      rename: renameFailingFrom(sessions, 'EXDEV'),
      copyDirExclusive: (_src, dest) => {
        // Something made the destination, empty, since it was looked at; the copy then fails.
        mkdirSync(dst)
        mkdirSync(dest)
        put(dest, 'partial', 'half')
        throw errno('ENOSPC')
      },
    })

    expect(outcome.kind).toBe('failed')
    if (outcome.kind !== 'failed') return
    expect(outcome.failures.map((f) => f.name)).toEqual(['sessions'])
    expect(statSync(dst).isDirectory()).toBe(true)
    expect(readdirSync(dst)).toEqual([])
    expectNoTemporaries(newDir)
    expect(readFileSync(join(sessions, 'a.json'), 'utf-8')).toBe('{"a":1}')
  })

  test('an empty directory that appeared at the destination is not removed when the final rename fails', () => {
    mkdirSync(newDir, { recursive: true })
    const sessions = join(legacyDir, 'sessions')
    put(sessions, 'a.json', '{"a":1}')
    const dst = join(newDir, 'sessions')

    const outcome = run({
      rename: (from, to) => {
        if (from === sessions) throw errno('EXDEV')
        if (to === dst && TEMP_NAME.test(from)) {
          mkdirSync(dst)
          throw errno('EACCES')
        }
        renameSync(from, to)
      },
    })

    expect(outcome.kind).toBe('failed')
    expect(statSync(dst).isDirectory()).toBe(true)
    expect(readdirSync(dst)).toEqual([])
    expectNoTemporaries(newDir)
    expect(readFileSync(join(sessions, 'a.json'), 'utf-8')).toBe('{"a":1}')
  })

  test('a directory copy that fails: only the partial copy is removed, the original stays whole in L, failed at move', () => {
    mkdirSync(newDir, { recursive: true })
    put(join(legacyDir, 'sessions'), 'a.json', '{"a":1}')

    const outcome = run({
      rename: renameFailingFrom(join(legacyDir, 'sessions'), 'EXDEV'),
      copyDirExclusive: (_src, dest) => {
        mkdirSync(dest, { recursive: true })
        put(dest, 'partial', 'half')
        throw errno('ENOSPC')
      },
    })

    expect(outcome.kind).toBe('failed')
    if (outcome.kind !== 'failed') return
    expect(outcome.failures.map((f) => f.name)).toEqual(['sessions'])
    expect(outcome.failures[0]!.cause).toContain('ENOSPC')
    expect(existsSync(join(newDir, 'sessions'))).toBe(false)
    expect(readFileSync(join(legacyDir, 'sessions', 'a.json'), 'utf-8')).toBe('{"a":1}')
    expect(isLink(join(legacyDir, 'sessions'))).toBe(false)
    expectNoTemporaries(legacyDir)
    expectNoTemporaries(newDir)
  })
})

// ---------------------------------------------------------------------------
// A second run
// ---------------------------------------------------------------------------

describe('prepareStateDir: a second run after a finished move', () => {
  const finishedMoves: [string, () => Partial<StateDirMigrationFs> | undefined][] = [
    ['the whole-directory rename', () => undefined],
    [
      'a merge into the existing N',
      () => {
        mkdirSync(newDir, { recursive: true })
        return undefined
      },
    ],
    ['a cross-device move', () => ({ rename: renameFailingFrom(legacyDir, 'EXDEV'), link: linkFailingFromLegacy('EXDEV') })],
  ]

  test.each(finishedMoves)('%s: already-migrated, nothing logged, nothing changed', (_label, prepare) => {
    const fs = prepare()
    put(legacyDir, 'config.json', LEGACY_CONFIG)
    expect(run(fs).kind).toBe('moved')
    lines.length = 0
    const before = treeSnapshot(root)

    expect(run()).toEqual({ kind: 'already-migrated' })

    expect(lines).toEqual([])
    expect(treeSnapshot(root)).toEqual(before)
  })
})

// ---------------------------------------------------------------------------
// Nothing at N is ever overwritten, and a failed step loses nothing
// ---------------------------------------------------------------------------

describe('prepareStateDir: a file that appears at N during the move is never overwritten', () => {
  const LATE = Buffer.from('{"written": "by a writer that got there first"}\n', 'utf-8')

  /**
   * A `link` that makes `dest` with the bytes `LATE` (a writer got there first) and then fails with `EEXIST`,
   * as the real link does; with `code`, a link out of L first fails with it (across file systems).
   */
  function linkLosingRaceAt(dest: string, code?: string): (existing: string, created: string) => void {
    return (existing, created) => {
      if (code !== undefined && existing.startsWith(legacyDir + sep)) throw errno(code)
      if (created === dest) {
        writeFileSync(dest, LATE)
        throw errno('EEXIST')
      }
      linkSync(existing, created)
    }
  }

  test.each([
    ['a hard link', undefined],
    ['a checked copy placed after EXDEV', 'EXDEV'],
  ])('%s: failed at move, both files intact, no temporary name left, and the next start sees a conflict', (_label, code) => {
    mkdirSync(newDir, { recursive: true })
    put(legacyDir, 'config.json', LEGACY_CONFIG)

    const outcome = run({ link: linkLosingRaceAt(join(newDir, 'config.json'), code) })

    expect(outcome.kind).toBe('failed')
    if (outcome.kind !== 'failed') return
    expect(outcome.step).toBe('move')
    expect(outcome.failures.map((f) => f.name)).toEqual(['config.json'])
    expect(outcome.failures[0]!.cause).toContain('EEXIST')
    expect(readFileSync(join(newDir, 'config.json'))).toEqual(LATE)
    expect(isLink(join(legacyDir, 'config.json'))).toBe(false)
    expect(readFileSync(join(legacyDir, 'config.json'))).toEqual(LEGACY_CONFIG)
    expectNoTemporaries(newDir)
    expectNoTemporaries(legacyDir)
    lines.length = 0

    expect(run()).toEqual({ kind: 'pending', entries: [], conflicts: ['config.json'], leftover: [] })
    expect(readFileSync(join(newDir, 'config.json'))).toEqual(LATE)
    expect(readFileSync(join(legacyDir, 'config.json'))).toEqual(LEGACY_CONFIG)
  })

  test('the rename that puts the old-name link in place failing after the file was placed: failed, both names hold the file, the next start settles it', () => {
    mkdirSync(newDir, { recursive: true })
    const legacyConfig = put(legacyDir, 'config.json', LEGACY_CONFIG)
    const { ino } = lstatSync(legacyConfig)

    const outcome = run({ rename: renameFailingFromTemporaryTo(legacyConfig, 'EACCES') })

    expect(outcome.kind).toBe('failed')
    if (outcome.kind !== 'failed') return
    expect(outcome.failures.map((f) => f.name)).toEqual(['config.json'])
    expect(outcome.failures[0]!.cause).toContain('EACCES')
    // The file is at N (one inode with the old name, which is still a file), and nothing is lost.
    expect(readFileSync(join(newDir, 'config.json'))).toEqual(LEGACY_CONFIG)
    expect(lstatSync(join(newDir, 'config.json')).ino).toBe(ino)
    expect(isLink(legacyConfig)).toBe(false)
    expect(readFileSync(legacyConfig)).toEqual(LEGACY_CONFIG)
    expectNoTemporaries(legacyDir)
    expectNoTemporaries(newDir)
    lines.length = 0

    // The second copy is the same inode: redundant, so the move finishes with nothing to move.
    expect(run()).toEqual({ kind: 'moved', via: 'merge', entries: [] })
    expectLegacyLinksToNew()
    expect(readFileSync(join(newDir, 'config.json'))).toEqual(LEGACY_CONFIG)
  })

  test('the same rename failing after a directory was placed: the old name is a link to it again, nothing lost', () => {
    mkdirSync(newDir, { recursive: true })
    put(join(legacyDir, 'sessions'), 'a.json', '{"a":1}')

    const outcome = run({ rename: renameFailingFromTemporaryTo(join(legacyDir, 'sessions'), 'EACCES') })

    expect(outcome.kind).toBe('failed')
    if (outcome.kind !== 'failed') return
    expect(outcome.failures.map((f) => f.name)).toEqual(['sessions'])
    expect(readFileSync(join(newDir, 'sessions', 'a.json'), 'utf-8')).toBe('{"a":1}')
    expect(readlinkSync(join(legacyDir, 'sessions'))).toBe(join(newDir, 'sessions'))
    expect(readFileSync(join(legacyDir, 'sessions', 'a.json'), 'utf-8')).toBe('{"a":1}')
    expectNoTemporaries(legacyDir)
    lines.length = 0

    expect(run()).toEqual({ kind: 'moved', via: 'merge', entries: [] })
    expectLegacyLinksToNew()
  })
})

describe('prepareStateDir: replacing L with the link at the end', () => {
  test('the rename of the link onto L failing: the link is made at L directly, and the move is done', () => {
    mkdirSync(newDir, { recursive: true })
    put(legacyDir, 'config.json', LEGACY_CONFIG)

    const outcome = run({ rename: renameFailingFromTemporaryTo(legacyDir, 'EACCES') })

    expect(outcome).toEqual({ kind: 'moved', via: 'merge', entries: ['config.json'] })
    expect(lines).toEqual([stateDirMergedLine(legacyDir, newDir, ['config.json'])])
    expectLegacyLinksToNew()
    expectNoTemporaries(dirname(legacyDir))
    expect(readFileSync(join(newDir, 'config.json'))).toEqual(LEGACY_CONFIG)
  })

  test('that rename failing and L not made either: pending, one WARN with the ln -s to run, the data at N, L absent, no temporary link', () => {
    mkdirSync(newDir, { recursive: true })
    put(legacyDir, 'config.json', LEGACY_CONFIG)

    const outcome = run({
      rename: renameFailingFromTemporaryTo(legacyDir, 'EACCES'),
      symlink: (target, path) => {
        if (path === legacyDir) throw errno('EEXIST')
        symlinkSync(target, path)
      },
    })

    expect(outcome).toEqual({ kind: 'pending', entries: ['config.json'], conflicts: [], leftover: [] })
    expect(lines).toHaveLength(1)
    expect(lines[0]!.startsWith(STATE_MIGRATE_WARN_PREFIX)).toBe(true)
    expect(lines[0]).toContain('could not be replaced with a symbolic link')
    expect(lines[0]).toContain(`ln -s ${newDir} ${legacyDir}`)
    expect(stateDirMigrationStopsStart(outcome)).toBe(false)
    expect(readFileSync(join(newDir, 'config.json'))).toEqual(LEGACY_CONFIG)
    expect(existsSync(legacyDir)).toBe(false)
    expectNoTemporaries(dirname(legacyDir))
    lines.length = 0

    // With the old name absent the next start finds no legacy directory: it does not restore the link.
    expect(run()).toEqual({ kind: 'no-legacy' })
    expect(lines).toEqual([])
  })

  test('the temporary link not made: pending, one WARN, L still a directory', () => {
    mkdirSync(newDir, { recursive: true })
    mkdirSync(legacyDir, { recursive: true })

    const outcome = run({
      symlink: () => {
        throw errno('EACCES')
      },
    })

    expect(outcome).toEqual({ kind: 'pending', entries: [], conflicts: [], leftover: [] })
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('could not be replaced with a symbolic link')
    expect(statSync(legacyDir).isDirectory()).toBe(true)
    expect(isLink(legacyDir)).toBe(false)
    expectNoTemporaries(dirname(legacyDir))
  })
})

describe('prepareStateDir: a write through the old name during the move is never removed', () => {
  test('the old name\'s link replaced by a file of its own before the final cleanup: pending with that entry left, its bytes kept', () => {
    mkdirSync(newDir, { recursive: true })
    put(legacyDir, 'config.json', LEGACY_CONFIG)
    const legacyConfig = join(legacyDir, 'config.json')

    const outcome = run({
      rename: (from, to) => {
        renameSync(from, to)
        if (to === legacyConfig && TEMP_NAME.test(from)) {
          // A writer's temporary file plus rename, in the instant after the link took the old name.
          rmSync(to)
          writeFileSync(to, 'written through the old name')
        }
      },
    })

    expect(outcome).toEqual({ kind: 'pending', entries: ['config.json'], conflicts: [], leftover: ['config.json'] })
    expect(lines).toEqual([stateDirPendingLine(legacyDir, newDir, ['config.json'], [], ['config.json'])])
    expect(stateDirMigrationStopsStart(outcome)).toBe(false)
    expect(isLink(legacyDir)).toBe(false)
    expect(isLink(legacyConfig)).toBe(false)
    expect(readFileSync(legacyConfig, 'utf-8')).toBe('written through the old name')
    expect(readFileSync(join(newDir, 'config.json'))).toEqual(LEGACY_CONFIG)
  })

  test('a tree that changes while it is copied across file systems: the copy is discarded, failed at move, the source stays whole with the write', () => {
    mkdirSync(newDir, { recursive: true })
    put(join(legacyDir, 'sessions'), 'a.json', '{"a":1}')

    const outcome = run({
      rename: renameFailingFrom(join(legacyDir, 'sessions'), 'EXDEV'),
      copyDirExclusive: (src, dest) => {
        NODE_STATE_DIR_MIGRATION_FS.copyDirExclusive(src, dest)
        appendFileSync(join(src, 'a.json'), '\nwritten during the copy')
      },
    })

    expect(outcome.kind).toBe('failed')
    if (outcome.kind !== 'failed') return
    expect(outcome.failures.map((f) => f.name)).toEqual(['sessions'])
    expect(outcome.failures[0]!.cause).toContain('changed while it was being copied')
    expect(existsSync(join(newDir, 'sessions'))).toBe(false)
    expect(readFileSync(join(legacyDir, 'sessions', 'a.json'), 'utf-8')).toBe('{"a":1}\nwritten during the copy')
    expect(isLink(join(legacyDir, 'sessions'))).toBe(false)
    expectNoTemporaries(legacyDir)
    expectNoTemporaries(newDir)
  })
})

describe("prepareStateDir: cross-file-system links back into L (N/<name> is a link to L/<name>)", () => {
  const CRONTAB = '0 9 * * * prompts/a.md planner\n'

  /** The file to read inside each entry, and what it holds. */
  const INSIDE: Record<string, [string, string]> = {
    crontab: ['crontab', CRONTAB],
    prompts: [join('prompts', 'a.md'), 'do the thing'],
  }

  /** `L/crontab` is the only copy of the file; `N/crontab` links to it. */
  function fileLinkedBack(): void {
    put(legacyDir, 'crontab', CRONTAB)
    mkdirSync(newDir, { recursive: true })
    symlinkSync(join(legacyDir, 'crontab'), join(newDir, 'crontab'))
  }

  /** `L/prompts` is the only copy of the directory; `N/prompts` links to it. */
  function directoryLinkedBack(): void {
    put(join(legacyDir, 'prompts'), 'a.md', 'do the thing')
    mkdirSync(newDir, { recursive: true })
    symlinkSync(join(legacyDir, 'prompts'), join(newDir, 'prompts'))
  }

  const moves: [string, string, () => void, () => Partial<StateDirMigrationFs>][] = [
    ['a file', 'crontab', fileLinkedBack, () => ({})],
    ['a file across file systems', 'crontab', fileLinkedBack, () => ({ link: linkFailingFromLegacy('EXDEV') })],
    ['a directory', 'prompts', directoryLinkedBack, () => ({})],
    ['a directory across file systems', 'prompts', directoryLinkedBack, () => ({ rename: renameFailingFrom(join(legacyDir, 'prompts'), 'EXDEV') })],
  ]

  test.each(moves)('%s: moved over the link, the data survives, L becomes the link', (_label, name, setup, fs) => {
    const [inside, content] = INSIDE[name]!
    setup()

    const outcome = run(fs())

    expect(outcome).toEqual({ kind: 'moved', via: 'merge', entries: [name] })
    expect(lines).toEqual([stateDirMergedLine(legacyDir, newDir, [name])])
    expect(isLink(join(newDir, name))).toBe(false)
    expect(readFileSync(join(newDir, inside), 'utf-8')).toBe(content)
    expectLegacyLinksToNew()
    expect(readFileSync(join(legacyDir, inside), 'utf-8')).toBe(content)
    expectNoTemporaries(newDir)
    expectNoTemporaries(dirname(legacyDir))
  })

  const failures: [string, string, () => void, () => Partial<StateDirMigrationFs>][] = [
    ['a file whose replacing rename fails', 'crontab', fileLinkedBack, () => ({ rename: renameFailingFromTemporaryTo(join(newDir, 'crontab'), 'EACCES') })],
    [
      'a directory whose link cannot be removed',
      'prompts',
      directoryLinkedBack,
      () => ({
        unlink: (path) => {
          if (path === join(newDir, 'prompts')) throw errno('EACCES')
          unlinkSync(path)
        },
      }),
    ],
    ['a directory whose replacing rename fails', 'prompts', directoryLinkedBack, () => ({ rename: renameFailingFromTemporaryTo(join(newDir, 'prompts'), 'EACCES') })],
    [
      'a directory that changes while it is copied across file systems',
      'prompts',
      directoryLinkedBack,
      () => ({
        rename: renameFailingFrom(join(legacyDir, 'prompts'), 'EXDEV'),
        copyDirExclusive: (src, dest) => {
          NODE_STATE_DIR_MIGRATION_FS.copyDirExclusive(src, dest)
          appendFileSync(join(src, 'a.md'), ' and more')
        },
      }),
    ],
  ]

  test.each(failures)('%s: failed at move, the link at N and the only copy in L both intact, no temporary name left, the next start finishes', (_label, name, setup, fs) => {
    setup()

    const outcome = run(fs())

    expect(outcome.kind).toBe('failed')
    if (outcome.kind !== 'failed') return
    expect(outcome.step).toBe('move')
    expect(outcome.failures.map((f) => f.name)).toEqual([name])
    expect(readlinkSync(join(newDir, name))).toBe(join(legacyDir, name))
    expect(isLink(join(legacyDir, name))).toBe(false)
    expectNoTemporaries(newDir)
    expectNoTemporaries(legacyDir)
    expectNoTemporaries(dirname(legacyDir))
    expect(names(legacyDir)).toEqual([name])
    expect(readFileSync(join(legacyDir, INSIDE[name]![0]), 'utf-8')).toContain(INSIDE[name]![1])
    lines.length = 0

    expect(run()).toEqual({ kind: 'moved', via: 'merge', entries: [name] })
    expect(isLink(join(newDir, name))).toBe(false)
    expectLegacyLinksToNew()
  })
})

describe('prepareStateDir: symbolic links in L (dangling, pointing at their own destination, naming each other)', () => {
  test('a dangling link with nothing at N is moved as it is; N holds a link to the same target and a second start is a no-op', () => {
    mkdirSync(newDir, { recursive: true })
    mkdirSync(legacyDir, { recursive: true })
    const gone = join(root, 'nonexistent')
    symlinkSync(gone, join(legacyDir, 'stale-link'))

    const outcome = run()

    expect(outcome).toEqual({ kind: 'moved', via: 'merge', entries: ['stale-link'] })
    expect(lines).toEqual([stateDirMergedLine(legacyDir, newDir, ['stale-link'])])
    expect(isLink(join(newDir, 'stale-link'))).toBe(true)
    expect(readlinkSync(join(newDir, 'stale-link'))).toBe(gone)
    expect(existsSync(gone)).toBe(false)
    expectLegacyLinksToNew()
    expectNoTemporaries(newDir)
    lines.length = 0
    const before = treeSnapshot(root)

    expect(run()).toEqual({ kind: 'already-migrated' })

    expect(lines).toEqual([])
    expect(treeSnapshot(root)).toEqual(before)
  })

  test('a dangling relative link is re-made at N with an absolute target (resolved against L)', () => {
    mkdirSync(newDir, { recursive: true })
    mkdirSync(legacyDir, { recursive: true })
    symlinkSync('missing.log', join(legacyDir, 'latest.log'))

    expect(run()).toEqual({ kind: 'moved', via: 'merge', entries: ['latest.log'] })

    expect(readlinkSync(join(newDir, 'latest.log'))).toBe(resolve(legacyDir, 'missing.log'))
    expectLegacyLinksToNew()
  })

  test("leftovers (L/crontab -> N/crontab and L/prompts -> N/prompts, both deleted at N): dropped, nothing made at N, no self-loop, L becomes the link", () => {
    mkdirSync(newDir, { recursive: true })
    mkdirSync(legacyDir, { recursive: true })
    symlinkSync(join(newDir, 'crontab'), join(legacyDir, 'crontab'))
    symlinkSync(join(newDir, 'prompts'), join(legacyDir, 'prompts'))
    put(legacyDir, 'config.json', LEGACY_CONFIG)

    const outcome = run()

    expect(outcome).toEqual({ kind: 'moved', via: 'merge', entries: ['config.json'] })
    expect(lines).toEqual([stateDirMergedLine(legacyDir, newDir, ['config.json'])])
    expect(names(newDir)).toEqual(['config.json'])
    expect(existsSync(join(newDir, 'crontab'))).toBe(false)
    expect(existsSync(join(newDir, 'prompts'))).toBe(false)
    expectLegacyLinksToNew()
    // Through the old name there is nothing either: the links are gone, not turned into loops.
    expect(names(legacyDir)).toEqual(['config.json'])
    expectNoTemporaries(newDir)
    expectNoTemporaries(dirname(legacyDir))
  })

  test("leftovers with N the only thing in the move: moved with no entries, N stays empty", () => {
    mkdirSync(newDir, { recursive: true })
    mkdirSync(legacyDir, { recursive: true })
    symlinkSync(join(newDir, 'crontab'), join(legacyDir, 'crontab'))

    expect(run()).toEqual({ kind: 'moved', via: 'merge', entries: [] })

    expect(names(newDir)).toEqual([])
    expectLegacyLinksToNew()
  })

  test('L/crontab -> N/crontab with N/crontab -> L/crontab: two links naming each other hold no data, a conflict, both untouched', () => {
    mkdirSync(newDir, { recursive: true })
    mkdirSync(legacyDir, { recursive: true })
    symlinkSync(join(newDir, 'crontab'), join(legacyDir, 'crontab'))
    symlinkSync(join(legacyDir, 'crontab'), join(newDir, 'crontab'))
    const legacyBefore = treeSnapshot(legacyDir)
    const newBefore = treeSnapshot(newDir)

    const outcome = run()

    expect(outcome).toEqual({ kind: 'pending', entries: [], conflicts: ['crontab'], leftover: [] })
    expect(lines).toEqual([stateDirPendingLine(legacyDir, newDir, [], ['crontab'], [])])
    expect(isLink(legacyDir)).toBe(false)
    expect(readlinkSync(join(legacyDir, 'crontab'))).toBe(join(newDir, 'crontab'))
    expect(readlinkSync(join(newDir, 'crontab'))).toBe(join(legacyDir, 'crontab'))
    expect(treeSnapshot(legacyDir)).toEqual(legacyBefore)
    expect(treeSnapshot(newDir)).toEqual(newBefore)
  })

  test('a relative link whose target moves first (L/a.log and L/z.log -> a.log): both move, N/z.log resolves once L is the link, nothing pending', () => {
    mkdirSync(newDir, { recursive: true })
    put(legacyDir, 'a.log', 'a line\n')
    symlinkSync('a.log', join(legacyDir, 'z.log'))

    const outcome = run()

    expect(outcome).toEqual({ kind: 'moved', via: 'merge', entries: ['a.log', 'z.log'] })
    expect(lines).toEqual([stateDirMergedLine(legacyDir, newDir, ['a.log', 'z.log'])])
    expectLegacyLinksToNew()
    expect(isLink(join(newDir, 'a.log'))).toBe(false)
    expect(isLink(join(newDir, 'z.log'))).toBe(true)
    expect(readFileSync(join(newDir, 'z.log'), 'utf-8')).toBe('a line\n')
    expect(readFileSync(join(newDir, 'a.log'), 'utf-8')).toBe('a line\n')
    expectNoTemporaries(newDir)
    lines.length = 0

    expect(run()).toEqual({ kind: 'already-migrated' })
    expect(lines).toEqual([])
  })

  test('a dangling link in L against a different regular file at N: a conflict, both untouched', () => {
    put(newDir, 'x', 'mine')
    mkdirSync(legacyDir, { recursive: true })
    symlinkSync(join(root, 'nonexistent'), join(legacyDir, 'x'))
    const legacyBefore = treeSnapshot(legacyDir)
    const newBefore = treeSnapshot(newDir)

    const outcome = run()

    expect(outcome).toEqual({ kind: 'pending', entries: [], conflicts: ['x'], leftover: [] })
    expect(lines).toEqual([stateDirPendingLine(legacyDir, newDir, [], ['x'], [])])
    expect(treeSnapshot(legacyDir)).toEqual(legacyBefore)
    expect(treeSnapshot(newDir)).toEqual(newBefore)
  })

  test('a dangling link in L against a dangling link to a different target at N: a conflict', () => {
    mkdirSync(newDir, { recursive: true })
    mkdirSync(legacyDir, { recursive: true })
    symlinkSync(join(root, 'gone-one'), join(legacyDir, 'x'))
    symlinkSync(join(root, 'gone-two'), join(newDir, 'x'))

    expect(run()).toEqual({ kind: 'pending', entries: [], conflicts: ['x'], leftover: [] })
    expect(readlinkSync(join(legacyDir, 'x'))).toBe(join(root, 'gone-one'))
    expect(readlinkSync(join(newDir, 'x'))).toBe(join(root, 'gone-two'))
  })

  test('a dangling link in L against a dangling link to the same target at N: redundant, dropped', () => {
    mkdirSync(newDir, { recursive: true })
    mkdirSync(legacyDir, { recursive: true })
    const gone = join(root, 'nonexistent')
    symlinkSync(gone, join(legacyDir, 'x'))
    symlinkSync(gone, join(newDir, 'x'))

    const outcome = run()

    expect(outcome).toEqual({ kind: 'moved', via: 'merge', entries: [] })
    expect(lines).toEqual([stateDirMergedLine(legacyDir, newDir, [])])
    expect(readlinkSync(join(newDir, 'x'))).toBe(gone)
    expectLegacyLinksToNew()
  })

  test('a relative dangling link in L against an absolute dangling link at N to the same place: redundant', () => {
    mkdirSync(newDir, { recursive: true })
    mkdirSync(legacyDir, { recursive: true })
    symlinkSync('missing', join(legacyDir, 'x'))
    symlinkSync(join(legacyDir, 'missing'), join(newDir, 'x'))

    expect(run()).toEqual({ kind: 'moved', via: 'merge', entries: [] })
    expectLegacyLinksToNew()
  })

  test('a link in L to its own destination at N, with a real file there, is dropped and the file is untouched', () => {
    mkdirSync(newDir, { recursive: true })
    mkdirSync(legacyDir, { recursive: true })
    put(newDir, 'real', 'data')
    symlinkSync(join(newDir, 'real'), join(legacyDir, 'real'))

    expect(run()).toEqual({ kind: 'moved', via: 'merge', entries: [] })

    expect(isLink(join(newDir, 'real'))).toBe(false)
    expect(readFileSync(join(newDir, 'real'), 'utf-8')).toBe('data')
    expectLegacyLinksToNew()
  })
})

describe('prepareStateDir: a credentials file in L (its content is never logged)', () => {
  /** A credentials file at `dir/credentials.json`; `tag` makes two of them differ in bytes but not in size. */
  function plantCredentials(dir: string, tag: string): string {
    return writeCredentialsFile(dir, 'credentials.json', { bot_token: fakeToken(BOT_TOKEN_PREFIX, tag) })
  }

  test('one that conflicts with the file of the same size in N: pending naming the file only', () => {
    plantCredentials(newDir, 'new')
    plantCredentials(legacyDir, 'old')

    const outcome = run()

    expect(outcome).toEqual({ kind: 'pending', entries: [], conflicts: ['credentials.json'], leftover: [] })
    expect(lines).toEqual([stateDirPendingLine(legacyDir, newDir, [], ['credentials.json'], [])])
    assertNoLeak(lines, 'the conflict WARN')
  })

  test('one whose move fails: failed naming the file and the cause only', () => {
    mkdirSync(newDir, { recursive: true })
    plantCredentials(legacyDir, 'old')

    const outcome = run({
      link: () => {
        throw errno('EACCES')
      },
    })

    expect(outcome.kind).toBe('failed')
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('"credentials.json"')
    assertNoLeak(lines, 'the failure line')
  })
})

// ---------------------------------------------------------------------------
// The stop decision and its message
// ---------------------------------------------------------------------------

describe('stateDirMigrationStopsStart and stateDirStopMessage', () => {
  const outcomes: [StateDirMigrationOutcome, boolean][] = [
    [{ kind: 'overridden' }, false],
    [{ kind: 'no-legacy' }, false],
    [{ kind: 'already-migrated' }, false],
    [{ kind: 'moved', via: 'rename', entries: [] }, false],
    [{ kind: 'moved', via: 'merge', entries: ['config.json'] }, false],
    [{ kind: 'pending', entries: [], conflicts: ['config.json'], leftover: [] }, false],
    [{ kind: 'legacy-unusable', reason: 'not-directory' }, false],
    [{ kind: 'legacy-unusable', reason: 'link-elsewhere' }, false],
    [{ kind: 'legacy-server-running', pid: 4242 }, true],
    [{ kind: 'failed', step: 'mkdir', cause: 'EACCES', failures: [], newDirExists: false }, true],
    [{ kind: 'failed', step: 'move', cause: 'x', failures: [{ name: 'config.json', cause: 'EACCES' }], newDirExists: true }, true],
    [{ kind: 'failed', step: 'unexpected', cause: 'EACCES', failures: [], newDirExists: true }, true],
  ]

  test.each(outcomes)('%o stops the start: %p', (outcome, stops) => {
    expect(stateDirMigrationStopsStart(outcome)).toBe(stops)
  })

  test.each([
    ['N absent', false, () => `mv ${legacyDir} ${newDir} && ln -s ${newDir} ${legacyDir}`],
    ['N present', true, () => `mv ${legacyDir}/<name> ${newDir}/<name>`],
  ])('the stop message of a failed step with %s is the line with its hand-fix', (_label, newDirExists, recipe) => {
    const message = stateDirStopMessage(paths, { kind: 'failed', step: 'mkdir', cause: 'EACCES', failures: [], newDirExists })

    expect(message).toBe(stateDirFailedLine(legacyDir, newDir, 'mkdir', 'EACCES', [], newDirExists))
    expect(message).toContain(recipe())
  })
})

// ---------------------------------------------------------------------------
// The commands other than the start
// ---------------------------------------------------------------------------

describe('resolveCliStateDir and resolveCliConfigPath: the directory a command acts on before the start moved it', () => {
  const cases: [string, () => void, () => string][] = [
    [
      'L a real directory holding config.json, N absent: L',
      () => {
        put(legacyDir, 'config.json', LEGACY_CONFIG)
      },
      () => legacyDir,
    ],
    [
      'L holding only config.json.last-applied, N absent: L',
      () => {
        put(legacyDir, 'config.json.last-applied', '{}')
      },
      () => legacyDir,
    ],
    [
      'L holding only server.pid (an old server running), N absent: L',
      () => {
        put(legacyDir, 'server.pid', '4242')
      },
      () => legacyDir,
    ],
    [
      'L holding config.json, N existing but without a configuration (the crontab only): L',
      () => {
        put(legacyDir, 'config.json', LEGACY_CONFIG)
        put(newDir, 'crontab', '')
      },
      () => legacyDir,
    ],
    [
      'L holding config.json and N holding config.json: N',
      () => {
        put(legacyDir, 'config.json', LEGACY_CONFIG)
        put(newDir, 'config.json', NEW_CONFIG)
      },
      () => newDir,
    ],
    [
      'L holding config.json and N holding only the last-applied record: N',
      () => {
        put(legacyDir, 'config.json', LEGACY_CONFIG)
        put(newDir, 'config.json.last-applied', '{}')
      },
      () => newDir,
    ],
    [
      'L holding only a log: N',
      () => {
        put(legacyDir, 'server.log', 'a line\n')
      },
      () => newDir,
    ],
    [
      'L an empty directory: N',
      () => {
        mkdirSync(legacyDir, { recursive: true })
      },
      () => newDir,
    ],
    [
      'L absent: N',
      () => {},
      () => newDir,
    ],
    [
      'L a symbolic link to N (migrated): N',
      () => {
        put(newDir, 'config.json', NEW_CONFIG)
        mkdirSync(dirname(legacyDir), { recursive: true })
        symlinkSync(newDir, legacyDir)
      },
      () => newDir,
    ],
    [
      "L a symbolic link to another directory holding the configuration (an operator's arrangement), N absent: L",
      () => {
        put(join(root, 'elsewhere'), 'config.json', LEGACY_CONFIG)
        mkdirSync(dirname(legacyDir), { recursive: true })
        symlinkSync(join(root, 'elsewhere'), legacyDir)
      },
      () => legacyDir,
    ],
    [
      'L a symbolic link to another directory holding only a PID file, N absent: L',
      () => {
        put(join(root, 'elsewhere'), 'server.pid', '4242')
        mkdirSync(dirname(legacyDir), { recursive: true })
        symlinkSync(join(root, 'elsewhere'), legacyDir)
      },
      () => legacyDir,
    ],
    [
      'L a symbolic link to another directory holding a configuration, N holding one too: N',
      () => {
        put(join(root, 'elsewhere'), 'config.json', LEGACY_CONFIG)
        mkdirSync(dirname(legacyDir), { recursive: true })
        symlinkSync(join(root, 'elsewhere'), legacyDir)
        put(newDir, 'config.json', NEW_CONFIG)
      },
      () => newDir,
    ],
    [
      'L a symbolic link to another directory holding only a log: N',
      () => {
        put(join(root, 'elsewhere'), 'server.log', 'a line\n')
        mkdirSync(dirname(legacyDir), { recursive: true })
        symlinkSync(join(root, 'elsewhere'), legacyDir)
      },
      () => newDir,
    ],
    [
      'N a symbolic link to L (the reverse arrangement), L holding the configuration: N, the one directory',
      () => {
        put(legacyDir, 'config.json', LEGACY_CONFIG)
        mkdirSync(dirname(newDir), { recursive: true })
        symlinkSync(legacyDir, newDir)
      },
      () => newDir,
    ],
    [
      'L a dangling symbolic link: N',
      () => {
        mkdirSync(dirname(legacyDir), { recursive: true })
        symlinkSync(join(root, 'gone'), legacyDir)
      },
      () => newDir,
    ],
    [
      'L a file: N',
      () => {
        put(dirname(legacyDir), 'slack', 'a file')
      },
      () => newDir,
    ],
    [
      'L holding a config.json that is a dangling link: N',
      () => {
        mkdirSync(legacyDir, { recursive: true })
        symlinkSync(join(root, 'gone'), join(legacyDir, 'config.json'))
      },
      () => newDir,
    ],
  ]

  test.each(cases)('%s', (_label, setup, expected) => {
    setup()
    const before = treeSnapshot(root)

    expect(resolveCliStateDir(home, {})).toBe(expected())
    expect(resolveCliConfigPath(home, {})).toBe(join(expected(), 'config.json'))
    // Reads only.
    expect(treeSnapshot(root)).toEqual(before)
  })

  test('SLACK_STATE_DIR set: that directory, whatever L and N hold', () => {
    put(legacyDir, 'config.json', LEGACY_CONFIG)
    const chosen = join(root, 'chosen')

    expect(resolveCliStateDir(home, { SLACK_STATE_DIR: chosen })).toBe(chosen)
    expect(resolveCliConfigPath(home, { SLACK_STATE_DIR: chosen })).toBe(join(chosen, 'config.json'))
  })

  test('XDG_CONFIG_HOME set: N is under it, and L still wins while it holds the only configuration', () => {
    const xdgNew = join(root, 'xdg', 'claude-slack-channel-bots')
    put(legacyDir, 'config.json', LEGACY_CONFIG)
    expect(resolveCliStateDir(home, { XDG_CONFIG_HOME: join(root, 'xdg') })).toBe(legacyDir)

    put(xdgNew, 'config.json', NEW_CONFIG)
    expect(resolveCliStateDir(home, { XDG_CONFIG_HOME: join(root, 'xdg') })).toBe(xdgNew)
  })

  describe('an old server running on L (a regular L/server.pid naming a live process)', () => {
    /** `L` holds the PID file; `N` holds a configuration an agent wrote after the upgrade. */
    function legacyWithPidAndNewConfig(): void {
      put(legacyDir, 'server.pid', '4242')
      put(legacyDir, 'config.json', LEGACY_CONFIG)
      put(newDir, 'config.json', NEW_CONFIG)
    }

    test('whatever N holds: L, so stop and clean_restart reach the old server', () => {
      legacyWithPidAndNewConfig()
      const before = treeSnapshot(root)

      expect(resolveCliStateDir(home, {}, undefined, (pid) => pid === 4242)).toBe(legacyDir)
      expect(treeSnapshot(root)).toEqual(before)
    })

    test('a stale PID (no such process): N, which holds the configuration', () => {
      legacyWithPidAndNewConfig()

      expect(resolveCliStateDir(home, {}, undefined, () => false)).toBe(newDir)
    })

    test('a PID file that is a link (an interrupted move) does not count: N', () => {
      put(newDir, 'config.json', NEW_CONFIG)
      put(newDir, 'server.pid', '4242')
      mkdirSync(legacyDir, { recursive: true })
      symlinkSync(join(newDir, 'server.pid'), join(legacyDir, 'server.pid'))

      expect(resolveCliStateDir(home, {}, undefined, () => true)).toBe(newDir)
    })

    test('L a symbolic link to another directory holding the PID file, N holding a configuration: L', () => {
      put(join(root, 'elsewhere'), 'server.pid', '4242')
      mkdirSync(dirname(legacyDir), { recursive: true })
      symlinkSync(join(root, 'elsewhere'), legacyDir)
      put(newDir, 'config.json', NEW_CONFIG)

      expect(resolveCliStateDir(home, {}, undefined, () => true)).toBe(legacyDir)
    })

    test('L a symbolic link to N (migrated): N, the PID file is the new directory\'s own', () => {
      put(newDir, 'server.pid', '4242')
      put(newDir, 'config.json', NEW_CONFIG)
      mkdirSync(dirname(legacyDir), { recursive: true })
      symlinkSync(newDir, legacyDir)

      expect(resolveCliStateDir(home, {}, undefined, () => true)).toBe(newDir)
    })
  })

  test('no configuration anywhere: N, so a command reports the missing configuration at the new default', () => {
    expect(resolveCliStateDir(home, {})).toBe(newDir)
    expect(resolveCliConfigPath(home, {})).toBe(join(newDir, 'config.json'))
  })

  test('L that cannot be looked at: N', () => {
    put(legacyDir, 'config.json', LEGACY_CONFIG)

    expect(
      resolveCliStateDir(home, {}, {
        lstat: () => {
          throw errno('EACCES')
        },
      }),
    ).toBe(newDir)
  })

  test('the start moves L: the command then acts on N', () => {
    put(legacyDir, 'config.json', LEGACY_CONFIG)
    expect(resolveCliStateDir(home, {})).toBe(legacyDir)

    expect(run().kind).toBe('moved')

    expect(resolveCliStateDir(home, {})).toBe(newDir)
    expect(readFileSync(resolveCliConfigPath(home, {}))).toEqual(LEGACY_CONFIG)
  })
})

// ---------------------------------------------------------------------------
// the names, and the start from every release's layout
// ---------------------------------------------------------------------------

/** The three directories of a host: `L1` (up to 0.13), `L2` (0.14.0, 0.15.0) and `N`, with the environment that names them. */
interface Layout {
  l1: string
  l2: string
  n: string
  env: NodeJS.ProcessEnv
}

/** The layout under `<home>/.config` (`xdg` undefined) or under an `XDG_CONFIG_HOME` of `xdg`. */
function layoutFor(xdg?: string): Layout {
  const config = xdg ?? join(home, '.config')
  return {
    l1: legacyServerStateDir(home),
    l2: join(config, 'cscb'),
    n: join(config, 'claude-slack-channel-bots'),
    env: xdg === undefined ? {} : { XDG_CONFIG_HOME: xdg },
  }
}

const CRONTAB_TEXT = '0 9 * * * prompts/daily.md planner\n'
const PROMPT_TEXT = 'do the daily thing\n'

/** What every release's server wrote into its state directory besides the crontab and `prompts/`. */
const SERVER_FILES: Readonly<Record<string, string | Buffer>> = {
  'config.json': LEGACY_CONFIG,
  'config.json.last-applied': '{"last":"applied"}\n',
  'channel-delivery.json': '{"C0AAA":1}\n',
  'server.log': 'a line\n',
  'system-prompt.md': 'be brief\n',
}

function putServerFiles(dir: string): void {
  for (const [name, content] of Object.entries(SERVER_FILES)) put(dir, name, content)
}

/** Up to 0.13: the whole state directory is `L1`; nothing exists at `~/.config`. */
function seedUpTo013(l: Layout): void {
  putServerFiles(l.l1)
}

/**
 * What (0.14.0) left, besides `L1` holding the server's files:
 * - `plain`: the crontab and `prompts/` are real in `L2`, and `L1/crontab` and `L1/prompts` are symbolic links into them;
 * - `crontab-deleted`: the operator deleted `L2/crontab` since, so the link at `L1/crontab` dangles;
 * - `no-crontab-links`: `L2/crontab` was made by the cron bootstrap, with no link at `L1/crontab` (`L1/prompts` still links);
 * - `exdev`: `prompts/` could not move across file systems, so it is real in `L1` and `L2/prompts` links to it
 *   (the fallback `N/prompts` -> `L/prompts` of the migration's own header);
 * - `crontab-outside`: the operator keeps the crontab in a file of their own, and both `L1/crontab` and `L2/crontab`
 *   link to it.
 */
type Seed0140Variant = 'plain' | 'crontab-deleted' | 'no-crontab-links' | 'exdev' | 'crontab-outside'

/** The operator's own crontab file of the `crontab-outside` variant, outside every state directory. */
function outsideCrontab(): string {
  return join(root, 'operator', 'crontab')
}

function seed0140(l: Layout, variant: Seed0140Variant = 'plain'): void {
  putServerFiles(l.l1)
  if (variant === 'crontab-outside') {
    put(dirname(outsideCrontab()), 'crontab', CRONTAB_TEXT)
    mkdirSync(l.l2, { recursive: true })
    symlinkSync(outsideCrontab(), join(l.l2, 'crontab'))
    symlinkSync(outsideCrontab(), join(l.l1, 'crontab'))
  } else {
    put(l.l2, 'crontab', CRONTAB_TEXT)
    if (variant !== 'no-crontab-links') symlinkSync(join(l.l2, 'crontab'), join(l.l1, 'crontab'))
  }
  if (variant === 'exdev') {
    put(join(l.l1, 'prompts'), 'daily.md', PROMPT_TEXT)
    symlinkSync(join(l.l1, 'prompts'), join(l.l2, 'prompts'))
  } else {
    put(join(l.l2, 'prompts'), 'daily.md', PROMPT_TEXT)
    symlinkSync(join(l.l2, 'prompts'), join(l.l1, 'prompts'))
  }
  if (variant === 'crontab-deleted') unlinkSync(join(l.l2, 'crontab'))
}

/** 0.15.0: the whole state directory is `L2`, and `L1` is a symbolic link to it. */
function seed0150(l: Layout): void {
  putServerFiles(l.l2)
  put(l.l2, 'crontab', CRONTAB_TEXT)
  put(join(l.l2, 'prompts'), 'daily.md', PROMPT_TEXT)
  mkdirSync(dirname(l.l1), { recursive: true })
  symlinkSync(l.l2, l.l1)
}

/** The start for `l`, collecting its lines (an old server's PID is 4242, never the test's own). */
function startFor(l: Layout, deps: Partial<StateDirMigrationDeps> = {}): ReturnType<typeof migrateStateDirAtStart> {
  return migrateStateDirAtStart({ log: (line) => lines.push(line), isProcessRunning: () => false, ownPid: 1, ...deps }, home, l.env)
}

/** An old server of PID 4242 is running; no other process is. */
const SERVER_4242: Partial<StateDirMigrationDeps> = { isProcessRunning: (pid) => pid === 4242, ownPid: 1 }

/** The lines that are WARNs. */
function warnings(): string[] {
  return lines.filter((line) => line.startsWith(STATE_MIGRATE_WARN_PREFIX))
}

/**
 * What `N` holds once every file moved: the server's files, the crontab and `prompts/` (each unless `has` says the
 * release never had it; `'linked'` is a crontab that stays a link to the operator's own file), each real.
 */
function expectEverythingAtN(l: Layout, has: { crontab: boolean | 'linked'; prompts: boolean } = { crontab: true, prompts: true }): void {
  for (const [name, content] of Object.entries(SERVER_FILES)) {
    expect(isLink(join(l.n, name))).toBe(false)
    expect(readFileSync(join(l.n, name))).toEqual(Buffer.from(content))
  }
  if (has.prompts) {
    expect(isLink(join(l.n, 'prompts'))).toBe(false)
    expect(readFileSync(join(l.n, 'prompts', 'daily.md'), 'utf-8')).toBe(PROMPT_TEXT)
  }
  if (has.crontab) {
    expect(isLink(join(l.n, 'crontab'))).toBe(has.crontab === 'linked')
    expect(readFileSync(join(l.n, 'crontab'), 'utf-8')).toBe(CRONTAB_TEXT)
  }
  expect(names(l.n)).toEqual([...Object.keys(SERVER_FILES), ...(has.crontab ? ['crontab'] : []), ...(has.prompts ? ['prompts'] : [])].sort())
  expectNoTemporaries(l.n)
}

/** With an absolute `XDG_CONFIG_HOME` nothing is made under `<home>/.config`. */
function expectHomeConfigUntouched(l: Layout): void {
  if (l.env.XDG_CONFIG_HOME === undefined) return
  expect(l.n).toBe(join(l.env.XDG_CONFIG_HOME, 'claude-slack-channel-bots'))
  expect(existsSync(join(home, '.config'))).toBe(false)
}

/** The names `L1` holds that move into `N` in the 0.14.0 merge: the server's files (the links are redundant). */
const MERGED_FROM_L1 = Object.keys(SERVER_FILES).sort()

describe('the names (legacyXdgStateDir, stateDirMigrationSteps, the default state directory)', () => {
  test("the directory 0.14.0 and 0.15.0 used is still 'cscb', for the migration to find", () => {
    expect(LEGACY_XDG_DIR_NAME).toBe('cscb')
    expect(legacyXdgStateDir(home, {})).toBe(join(home, '.config', 'cscb'))
  })

  test.each([
    ['XDG_CONFIG_HOME absolute', { XDG_CONFIG_HOME: '/xdg/conf' }, '/xdg/conf/cscb'],
    ['XDG_CONFIG_HOME empty (ignored)', { XDG_CONFIG_HOME: '' }, '$HOME/.config/cscb'],
    ['XDG_CONFIG_HOME relative (ignored)', { XDG_CONFIG_HOME: 'rel/conf' }, '$HOME/.config/cscb'],
    ['SLACK_STATE_DIR set (it does not move the old default)', { SLACK_STATE_DIR: '/chosen' }, '$HOME/.config/cscb'],
  ])('legacyXdgStateDir: %s', (_label, env, expected) => {
    expect(legacyXdgStateDir(home, env)).toBe(expected.replace('$HOME', home))
  })

  test('the steps: L2 to N (marked as outside the move from ~/.claude), then L1 to N', () => {
    expect(stateDirMigrationSteps(home, {})).toEqual([
      { legacyDir: join(home, '.config', 'cscb'), newDir, legacyIsXdg: true },
      { legacyDir: legacyServerStateDir(home), newDir },
    ])
  })

  test('the steps with an absolute XDG_CONFIG_HOME: L2 and N under it, L1 still under ~/.claude', () => {
    const xdg = join(root, 'xdg')

    expect(stateDirMigrationSteps(home, { XDG_CONFIG_HOME: xdg })).toEqual([
      { legacyDir: join(xdg, 'cscb'), newDir: join(xdg, 'claude-slack-channel-bots'), legacyIsXdg: true },
      { legacyDir: legacyServerStateDir(home), newDir: join(xdg, 'claude-slack-channel-bots') },
    ])
  })

  test('the steps with SLACK_STATE_DIR set: none; empty counts as unset', () => {
    expect(stateDirMigrationSteps(home, { SLACK_STATE_DIR: join(root, 'chosen') })).toBeUndefined()
    expect(stateDirMigrationSteps(home, { SLACK_STATE_DIR: '' })).toHaveLength(2)
  })

  test('the information lines for a move that only renames the folder name the package, not ~/.claude', () => {
    const l2 = join(home, '.config', 'cscb')
    const renamed = stateDirRenamedLine(l2, newDir, true)
    const merged = stateDirMergedLine(l2, newDir, ['crontab'], true)

    for (const line of [renamed, merged]) {
      expect(line.startsWith(STATE_MIGRATE_LOG_PREFIX)).toBe(true)
      expect(line).toContain('named after the package')
      expect(line).not.toContain('outside ~/.claude')
      expect(line).toContain(`${l2} is now a`)
    }
    expect(merged).toContain('moved "crontab" from')
  })

  test('the information lines for the move out of ~/.claude (the default) still say so', () => {
    expect(stateDirRenamedLine(legacyDir, newDir)).toContain('outside ~/.claude')
    expect(stateDirMergedLine(legacyDir, newDir, [])).toContain('outside ~/.claude')
    expect(stateDirRenamedLine(legacyDir, newDir)).toBe(stateDirRenamedLine(legacyDir, newDir, false))
  })

  test('the repoint lines name L1, L2 and N; the WARN says how to repoint by hand', () => {
    const l1 = legacyServerStateDir(home)
    const l2 = join(home, '.config', 'cscb')
    const done = stateDirRepointedLine(l1, l2, newDir)
    const failed = stateDirRepointFailedLine(l1, l2, newDir, 'EACCES')

    expect(done.startsWith(STATE_MIGRATE_LOG_PREFIX)).toBe(true)
    expect(done).toContain(`${l1} was a symbolic link to ${l2}`)
    expect(done).toContain(`${newDir} itself`)
    expect(failed.startsWith(STATE_MIGRATE_WARN_PREFIX)).toBe(true)
    expect(failed).toContain('EACCES')
    expect(failed).toContain(`ln -sfn ${newDir} ${l1}`)
  })

  describe('stateDirFailedLine and the SLACK_STATE_DIR advice', () => {
    const failure = [{ name: 'prompts', cause: 'EACCES' }]

    test('a legacy directory that holds a configuration (the default): the line advises SLACK_STATE_DIR=<it>', () => {
      expect(stateDirFailedLine(legacyDir, newDir, 'move', '', failure, true)).toContain(`set SLACK_STATE_DIR=${legacyDir} to keep the old location`)
      expect(stateDirFailedLine(legacyDir, newDir, 'move', '', failure, true, true)).toBe(stateDirFailedLine(legacyDir, newDir, 'move', '', failure, true))
    })

    test('one that holds none: the same line without the advice, and still ending with the hand-fix', () => {
      const withAdvice = stateDirFailedLine(legacyDir, newDir, 'move', '', failure, true, true)
      const without = stateDirFailedLine(legacyDir, newDir, 'move', '', failure, true, false)

      expect(without).not.toContain('SLACK_STATE_DIR')
      expect(without).toBe(withAdvice.replace(`, or set SLACK_STATE_DIR=${legacyDir} to keep the old location`, ''))
      expect(without.endsWith(`(mv ${legacyDir}/<name> ${newDir}/<name>).`)).toBe(true)
    })

    test.each([
      ['crontab and prompts only (0.14.0\'s L2)', (): void => {
        put(legacyDir, 'crontab', CRONTAB_TEXT)
        put(join(legacyDir, 'prompts'), 'daily.md', PROMPT_TEXT)
      }, false],
      ['a config.json', (): void => void put(legacyDir, 'config.json', LEGACY_CONFIG), true],
      ['only the last-applied record', (): void => void put(legacyDir, 'config.json.last-applied', '{}'), true],
      ['a config.json link that dangles (holds nothing)', (): void => {
        mkdirSync(legacyDir, { recursive: true })
        symlinkSync(join(root, 'gone'), join(legacyDir, 'config.json'))
      }, false],
    ])('a failed step on a legacy directory with %s: legacyHoldsConfig is %p', (_label, seed, holds) => {
      seed()

      const outcome = run({
        rename: () => {
          throw errno('EACCES')
        },
      })

      expect(outcome.kind).toBe('failed')
      if (outcome.kind !== 'failed') return
      expect(outcome.legacyHoldsConfig).toBe(holds ? undefined : false)
      expect(stateDirStopMessage(paths, outcome).includes(`SLACK_STATE_DIR=${legacyDir}`)).toBe(holds)
    })
  })
})

describe.each([
  ['~/.config (XDG_CONFIG_HOME unset)', (): Layout => layoutFor()],
  ['an absolute XDG_CONFIG_HOME', (): Layout => layoutFor(join(root, 'xdg'))],
])('the start, with %s, from the layout each release left', (_where, makeLayout) => {
  let l: Layout
  beforeEach(() => {
    l = makeLayout()
  })

  test('up to 0.13 (only L1): L1 is renamed to N and L1 is a link to it; L2 is not made', () => {
    seedUpTo013(l)

    const result = startFor(l)

    expect(result).toEqual({
      paths: { legacyDir: l.l1, newDir: l.n },
      outcome: { kind: 'moved', via: 'rename', entries: [] },
      startupErrorDir: l.l1,
    })
    expect(lines).toEqual([stateDirRenamedLine(l.l1, l.n)])
    expectEverythingAtN(l, { crontab: false, prompts: false })
    expect(readlinkSync(l.l1)).toBe(l.n)
    expect(existsSync(l.l2)).toBe(false)
    expect(lstatSync(l.n).isDirectory()).toBe(true)
    expectHomeConfigUntouched(l)
  })

  test('0.14.0 (L1 and a partial L2 with the crontab and prompts links): L2 is renamed to N, then L1 is merged; both are links to N', () => {
    seed0140(l)

    const result = startFor(l)

    expect(result).toEqual({
      paths: { legacyDir: l.l1, newDir: l.n },
      outcome: { kind: 'moved', via: 'merge', entries: MERGED_FROM_L1 },
      startupErrorDir: l.l1,
    })
    expect(lines).toEqual([stateDirRenamedLine(l.l2, l.n, true), stateDirMergedLine(l.l1, l.n, MERGED_FROM_L1)])
    expectEverythingAtN(l)
    expect(readlinkSync(l.l2)).toBe(l.n)
    expect(readlinkSync(l.l1)).toBe(l.n)
    // The old names still reach the files (a downgrade, a script that names them).
    expect(readFileSync(join(l.l1, 'crontab'), 'utf-8')).toBe(CRONTAB_TEXT)
    expect(readFileSync(join(l.l1, 'prompts', 'daily.md'), 'utf-8')).toBe(PROMPT_TEXT)
    expect(readFileSync(join(l.l2, 'config.json'))).toEqual(LEGACY_CONFIG)
    expectNoTemporaries(dirname(l.l1))
    expectNoTemporaries(dirname(l.l2))
    expectHomeConfigUntouched(l)
  })

  test('0.14.0 with the crontab deleted (L1/crontab dangles): the link is dropped, never made a self-loop at N, the rest moves', () => {
    seed0140(l, 'crontab-deleted')

    const result = startFor(l)

    expect(result.outcome).toEqual({ kind: 'moved', via: 'merge', entries: MERGED_FROM_L1 })
    expect(lines).toEqual([stateDirRenamedLine(l.l2, l.n, true), stateDirMergedLine(l.l1, l.n, MERGED_FROM_L1)])
    expectEverythingAtN(l, { crontab: false, prompts: true })
    expect(() => lstatSync(join(l.n, 'crontab'))).toThrow()
    expect(readlinkSync(l.l2)).toBe(l.n)
    expect(readlinkSync(l.l1)).toBe(l.n)
    // The deleted crontab stays deleted: no entry at any of the three names.
    expect(existsSync(join(l.l1, 'crontab'))).toBe(false)
    expect(existsSync(join(l.l2, 'crontab'))).toBe(false)
  })

  test.each<[string, Seed0140Variant, { crontab: boolean | 'linked'; prompts: boolean }]>([
    ['no crontab links in L1 (L2/crontab made by the cron bootstrap)', 'no-crontab-links', { crontab: true, prompts: true }],
    ["the cross-file-system fallback (L2/prompts a link to L1's real prompts/)", 'exdev', { crontab: true, prompts: true }],
    ['L1/crontab and L2/crontab both links to one file outside (the crontab stays that link)', 'crontab-outside', { crontab: 'linked', prompts: true }],
  ])('0.14.0, %s: everything ends at N, both old names link to it, no WARN, and a second start changes nothing', (_label, variant, has) => {
    seed0140(l, variant)

    const result = startFor(l)

    expect(result.outcome.kind).toBe('moved')
    expect(stateDirMigrationStopsStart(result.outcome)).toBe(false)
    expect(warnings()).toEqual([])
    expect(lines.length).toBeGreaterThanOrEqual(1)
    expectEverythingAtN(l, has)
    expect(readlinkSync(l.l2)).toBe(l.n)
    expect(readlinkSync(l.l1)).toBe(l.n)
    expect(readFileSync(join(l.l1, 'crontab'), 'utf-8')).toBe(CRONTAB_TEXT)
    expect(readFileSync(join(l.l2, 'prompts', 'daily.md'), 'utf-8')).toBe(PROMPT_TEXT)
    expectNoTemporaries(dirname(l.l1))
    expectNoTemporaries(dirname(l.l2))
    if (variant === 'crontab-outside') expect(readlinkSync(join(l.n, 'crontab'))).toBe(outsideCrontab())
    expectHomeConfigUntouched(l)

    lines.length = 0
    const before = treeSnapshot(root)
    expect(startFor(l).outcome).toEqual({ kind: 'already-migrated' })
    expect(lines).toEqual([])
    expect(treeSnapshot(root)).toEqual(before)
  })

  test('0.15.0 (a full L2, L1 a link to it): L2 is renamed to N, then L1 is repointed straight at N; both are links to N', () => {
    seed0150(l)

    const result = startFor(l)

    expect(result).toEqual({
      paths: { legacyDir: l.l2, newDir: l.n, legacyIsXdg: true },
      outcome: { kind: 'moved', via: 'rename', entries: [] },
      startupErrorDir: l.l2,
    })
    expect(lines).toEqual([stateDirRenamedLine(l.l2, l.n, true), stateDirRepointedLine(l.l1, l.l2, l.n)])
    expectEverythingAtN(l)
    expect(readlinkSync(l.l2)).toBe(l.n)
    // L1 no longer goes through L2, so removing ~/.config/cscb leaves it intact.
    expect(readlinkSync(l.l1)).toBe(l.n)
    expect(readFileSync(join(l.l1, 'config.json'))).toEqual(LEGACY_CONFIG)
    expectNoTemporaries(dirname(l.l1))
    expectHomeConfigUntouched(l)

    rmSync(l.l2)
    expect(readFileSync(join(l.l1, 'config.json'))).toEqual(LEGACY_CONFIG)
  })

  test.each([
    ['up to 0.13', (): void => seedUpTo013(l)],
    ['0.14.0', (): void => seed0140(l)],
    ['0.14.0 with the crontab deleted', (): void => seed0140(l, 'crontab-deleted')],
    ['0.15.0', (): void => seed0150(l)],
  ])('%s, a second start: already-migrated, nothing logged, nothing changed', (_label, seed) => {
    seed()
    expect(startFor(l).outcome.kind).toBe('moved')
    lines.length = 0
    const before = treeSnapshot(root)

    const second = startFor(l)

    expect(second.outcome).toEqual({ kind: 'already-migrated' })
    expect(stateDirMigrationStopsStart(second.outcome)).toBe(false)
    expect(second.startupErrorDir).toBe(l.n)
    expect(lines).toEqual([])
    expect(treeSnapshot(root)).toEqual(before)
  })

  test('an L1 link that is not exactly a link to L2 (here through another link) is the operator\'s own and stays, though it reaches N', () => {
    seed0150(l)
    const mine = join(root, 'operator-link')
    unlinkSync(l.l1)
    symlinkSync(l.l2, mine)
    symlinkSync(mine, l.l1)

    const result = startFor(l)

    expect(result.outcome.kind).toBe('moved')
    expect(lines).toEqual([stateDirRenamedLine(l.l2, l.n, true)])
    expect(readlinkSync(l.l1)).toBe(mine)
    expect(realpathSync(l.l1)).toBe(realpathSync(l.n))
  })

  test('L1 a link to a directory of the operator\'s own: it stays a link to it, with the WARN, and is never repointed', () => {
    put(l.l2, 'config.json', NEW_CONFIG)
    const mine = join(root, 'operator-state')
    put(mine, 'config.json', LEGACY_CONFIG)
    mkdirSync(dirname(l.l1), { recursive: true })
    symlinkSync(mine, l.l1)

    const result = startFor(l)

    expect(result.outcome.kind).toBe('moved')
    expect(lines).toEqual([stateDirRenamedLine(l.l2, l.n, true), stateDirLegacyUnusableLine(l.l1, l.n, 'link-elsewhere', mine)])
    expect(readlinkSync(l.l1)).toBe(mine)
    expect(readFileSync(join(mine, 'config.json'))).toEqual(LEGACY_CONFIG)
  })

  /** No line of the start is the repoint's, and L1 is still the link `target` it was. */
  function expectL1NotRepointed(target: string): void {
    expect(lines).not.toContain(stateDirRepointedLine(l.l1, l.l2, l.n))
    expect(lines.filter((line) => line.includes('repoint'))).toEqual([])
    expect(readlinkSync(l.l1)).toBe(target)
    expectNoTemporaries(dirname(l.l1))
  }

  describe('an L1 link that is not exactly the chain the migration makes (L1 -> L2 -> N) is never repointed', () => {
    test('the reverse setup (L2 a real directory, N a link to L2, L1 a link to L2): no repoint, no line, L2 stays the directory', () => {
      put(l.l2, 'config.json', LEGACY_CONFIG)
      symlinkSync(l.l2, l.n)
      mkdirSync(dirname(l.l1), { recursive: true })
      symlinkSync(l.l2, l.l1)
      const before = treeSnapshot(root)

      const result = startFor(l)

      expect(stateDirMigrationStopsStart(result.outcome)).toBe(false)
      expect(lines).toEqual([])
      expectL1NotRepointed(l.l2)
      expect(isLink(l.l2)).toBe(false)
      expect(readlinkSync(l.n)).toBe(l.l2)
      expect(treeSnapshot(root)).toEqual(before)
    })

    test("L2 and N both links to a directory of the operator's own, L1 a link to L2: no repoint (L2 is not a link to N)", () => {
      const mine = join(root, 'operator-state')
      put(mine, 'config.json', LEGACY_CONFIG)
      mkdirSync(dirname(l.l2), { recursive: true })
      symlinkSync(mine, l.l2)
      symlinkSync(mine, l.n)
      mkdirSync(dirname(l.l1), { recursive: true })
      symlinkSync(l.l2, l.l1)

      const result = startFor(l)

      expect(stateDirMigrationStopsStart(result.outcome)).toBe(false)
      expectL1NotRepointed(l.l2)
      expect(realpathSync(l.l1)).toBe(realpathSync(l.n))
      expect(readlinkSync(l.l2)).toBe(mine)
      expect(readlinkSync(l.n)).toBe(mine)
      expect(readFileSync(join(mine, 'config.json'))).toEqual(LEGACY_CONFIG)
    })

    test('L2 a link that reaches N through another link (not exactly N), L1 a link to L2: no repoint though the real paths match', () => {
      putServerFiles(l.n)
      const hop = join(root, 'operator-link')
      symlinkSync(l.n, hop)
      mkdirSync(dirname(l.l2), { recursive: true })
      symlinkSync(hop, l.l2)
      mkdirSync(dirname(l.l1), { recursive: true })
      symlinkSync(l.l2, l.l1)
      expect(realpathSync(l.l1)).toBe(realpathSync(l.n))

      startFor(l)

      expectL1NotRepointed(l.l2)
      expect(readlinkSync(l.l2)).toBe(hop)
    })

    test('L1, L2 and N all links in a chain and N absent (nothing for L1 to reach): no repoint, no temporary link made', () => {
      mkdirSync(dirname(l.l2), { recursive: true })
      symlinkSync(l.n, l.l2)
      mkdirSync(dirname(l.l1), { recursive: true })
      symlinkSync(l.l2, l.l1)

      const result = startFor(l)

      expect(result.outcome).toEqual({ kind: 'no-legacy' })
      expect(lines).toEqual([])
      expectL1NotRepointed(l.l2)
      expect(existsSync(l.n)).toBe(false)
    })

    test('L1 names L2 only on the page, but really reaches another directory (a symbolic link in its path): no repoint', () => {
      // `~/.claude` is the operator's link to a directory elsewhere, and L1 is a relative link that, resolved
      // lexically from its own directory, names L2, but, resolved by the file system through that link, is a
      // directory of its own beside the operator's.
      // The operator's directory is three levels down, so the relative link cannot climb out of the scratch root.
      const operatorClaude = join(root, 'x', 'y', 'claude')
      mkdirSync(join(operatorClaude, 'channels'), { recursive: true })
      symlinkSync(operatorClaude, join(home, '.claude'))
      const relative = relativePath(dirname(l.l1), l.l2)
      symlinkSync(relative, l.l1)
      const reached = resolve(operatorClaude, 'channels', relative)
      expect(reached).not.toBe(l.l2)
      put(reached, 'config.json', LEGACY_CONFIG)
      putServerFiles(l.n)
      symlinkSync(l.n, l.l2)
      expect(realpathSync(l.l1)).not.toBe(realpathSync(l.n))

      startFor(l)

      expectL1NotRepointed(relative)
      expect(readFileSync(join(reached, 'config.json'))).toEqual(LEGACY_CONFIG)
    })
  })

  test('0.15.0 on a host that never had L1 (a fresh install of 0.15.0: only L2): L2 is renamed to N, L1 stays absent, nothing else is logged, and a second start changes nothing', () => {
    putServerFiles(l.l2)
    put(l.l2, 'crontab', CRONTAB_TEXT)
    put(join(l.l2, 'prompts'), 'daily.md', PROMPT_TEXT)

    const result = startFor(l)

    expect(result).toEqual({
      paths: { legacyDir: l.l2, newDir: l.n, legacyIsXdg: true },
      outcome: { kind: 'moved', via: 'rename', entries: [] },
      startupErrorDir: l.l2,
    })
    expect(lines).toEqual([stateDirRenamedLine(l.l2, l.n, true)])
    expect(warnings()).toEqual([])
    expectEverythingAtN(l)
    expect(readlinkSync(l.l2)).toBe(l.n)
    expect(() => lstatSync(l.l1)).toThrow()
    expect(existsSync(dirname(l.l1))).toBe(false)
    expectNoTemporaries(dirname(l.l2))
    expectHomeConfigUntouched(l)

    lines.length = 0
    const before = treeSnapshot(root)
    const second = startFor(l)

    expect(second.outcome).toEqual({ kind: 'already-migrated' })
    expect(lines).toEqual([])
    expect(treeSnapshot(root)).toEqual(before)
    expect(() => lstatSync(l.l1)).toThrow()
  })

  describe('a failure to repoint L1 (the data is at N): one WARN, the outcome unchanged, never a stop', () => {
    const injections: [string, (l1: string, err: NodeJS.ErrnoException) => Partial<StateDirMigrationFs>][] = [
      [
        'the temporary link beside L1 cannot be made',
        (l1, err) => ({
          symlink: (target, path) => {
            if (TEMP_NAME.test(path) && dirname(path) === dirname(l1)) throw err
            symlinkSync(target, path)
          },
        }),
      ],
      [
        'the rename of the temporary link over L1 fails',
        (l1, err) => ({
          rename: (from, to) => {
            if (to === l1 && TEMP_NAME.test(from)) throw err
            renameSync(from, to)
          },
        }),
      ],
    ]

    test.each(injections)('%s: L1 still reaches N through L2, no temporary name is left, and the next start repoints it', (_label, inject) => {
      seed0150(l)
      const err = errno('EACCES')

      const result = startFor(l, { fs: inject(l.l1, err) })

      expect(result.outcome).toEqual({ kind: 'moved', via: 'rename', entries: [] })
      expect(stateDirMigrationStopsStart(result.outcome)).toBe(false)
      expect(lines).toEqual([stateDirRenamedLine(l.l2, l.n, true), stateDirRepointFailedLine(l.l1, l.l2, l.n, describeThrownValueWithoutStack(err))])
      expect(readlinkSync(l.l2)).toBe(l.n)
      expect(readlinkSync(l.l1)).toBe(l.l2)
      expect(realpathSync(l.l1)).toBe(realpathSync(l.n))
      expectEverythingAtN(l)
      expectNoTemporaries(dirname(l.l1))

      lines.length = 0
      startFor(l)

      expect(lines).toEqual([stateDirRepointedLine(l.l1, l.l2, l.n)])
      expect(readlinkSync(l.l1)).toBe(l.n)
    })
  })

  test('nothing anywhere: no-legacy, nothing logged, nothing made', () => {
    mkdirSync(home, { recursive: true })
    const before = treeSnapshot(root)

    const result = startFor(l)

    expect(result.outcome).toEqual({ kind: 'no-legacy' })
    expect(result.startupErrorDir).toBe(l.n)
    expect(lines).toEqual([])
    expect(treeSnapshot(root)).toEqual(before)
  })
})

describe('the start, with ~/.config, in the other situations', () => {
  let l: Layout
  beforeEach(() => {
    l = layoutFor()
  })

  test('N alone (a fresh install of this release, no old names): no-legacy, nothing logged, nothing changed', () => {
    put(l.n, 'config.json', NEW_CONFIG)
    const before = treeSnapshot(root)

    const result = startFor(l)

    expect(result.outcome).toEqual({ kind: 'no-legacy' })
    expect(result.startupErrorDir).toBe(l.n)
    expect(lines).toEqual([])
    expect(treeSnapshot(root)).toEqual(before)
  })

  describe('a server of an older release running (the start stops before anything moves)', () => {
    test('0.14.0 server on L1, with L2 partial: legacy-server-running on L1; L2 is not renamed under it', () => {
      seed0140(l)
      put(l.l1, 'server.pid', '4242\n')
      const before = treeSnapshot(root)

      const result = startFor(l, SERVER_4242)

      expect(result).toEqual({
        paths: { legacyDir: l.l1, newDir: l.n },
        outcome: { kind: 'legacy-server-running', pid: 4242 },
        startupErrorDir: l.l1,
      })
      expect(stateDirMigrationStopsStart(result.outcome)).toBe(true)
      expect(stateDirStopMessage(result.paths!, result.outcome)).toBe(stateDirLegacyServerRunningLine(l.l1, l.n, 4242))
      expect(lines).toEqual([])
      expect(treeSnapshot(root)).toEqual(before)
      expect(isLink(l.l2)).toBe(false)
      expect(existsSync(l.n)).toBe(false)
    })

    test('0.13 server on L1: legacy-server-running on L1, nothing moved', () => {
      seedUpTo013(l)
      put(l.l1, 'server.pid', '4242\n')
      const before = treeSnapshot(root)

      const result = startFor(l, SERVER_4242)

      expect(result).toEqual({
        paths: { legacyDir: l.l1, newDir: l.n },
        outcome: { kind: 'legacy-server-running', pid: 4242 },
        startupErrorDir: l.l1,
      })
      expect(treeSnapshot(root)).toEqual(before)
    })

    test('0.15.0 server on L2 (L1 a link to it): legacy-server-running on L2, nothing moved, L1 not repointed', () => {
      seed0150(l)
      put(l.l2, 'server.pid', '4242\n')
      const before = treeSnapshot(root)

      const result = startFor(l, SERVER_4242)

      expect(result).toEqual({
        paths: { legacyDir: l.l2, newDir: l.n, legacyIsXdg: true },
        outcome: { kind: 'legacy-server-running', pid: 4242 },
        startupErrorDir: l.l2,
      })
      expect(stateDirStopMessage(result.paths!, result.outcome)).toBe(stateDirLegacyServerRunningLine(l.l2, l.n, 4242))
      expect(treeSnapshot(root)).toEqual(before)
      expect(isLink(l.l2)).toBe(false)
      expect(readlinkSync(l.l1)).toBe(l.l2)
      expect(existsSync(l.n)).toBe(false)
    })

    test('an old server on L1 with N absent and nothing else there: startupErrorDir is the running step\'s directory, and N is never made', () => {
      put(l.l1, 'server.pid', '4242\n')

      const result = startFor(l, SERVER_4242)

      expect(result.outcome).toEqual({ kind: 'legacy-server-running', pid: 4242 })
      expect(result.paths).toEqual({ legacyDir: l.l1, newDir: l.n })
      expect(result.startupErrorDir).toBe(result.paths!.legacyDir)
      expect(existsSync(l.n)).toBe(false)
    })

    test.each([
      ['0.14.0', (): void => seed0140(l), (): string => l.l1],
      ['0.15.0', (): void => seed0150(l), (): string => l.l2],
    ])('%s: a stale PID does not stop the start, and the move goes through', (_label, seed, pidDir) => {
      seed()
      put(pidDir(), 'server.pid', '4242\n')

      const result = startFor(l)

      expect(result.outcome.kind).toBe('moved')
      expect(readlinkSync(l.l2)).toBe(l.n)
    })
  })

  describe('a conflict at N (the new location wins, nothing is overwritten, one WARN)', () => {
    test('0.15.0 with a different config.json already at N: one WARN naming L2, pending, L1 skipped; the next start repeats it and, once settled, finishes and repoints L1', () => {
      seed0150(l)
      put(l.n, 'config.json', NEW_CONFIG)

      const result = startFor(l)

      expect(result.paths).toEqual({ legacyDir: l.l2, newDir: l.n, legacyIsXdg: true })
      expect(result.outcome.kind).toBe('pending')
      if (result.outcome.kind !== 'pending') return
      expect(result.outcome.conflicts).toEqual(['config.json'])
      expect(stateDirMigrationStopsStart(result.outcome)).toBe(false)
      expect(lines).toHaveLength(1)
      expect(lines[0]!.startsWith(STATE_MIGRATE_WARN_PREFIX)).toBe(true)
      expect(lines[0]).toContain(`"config.json" exists both in ${l.l2} and in ${l.n} with different contents`)
      // Nothing overwritten: N's config wins, L2's own is untouched, and neither old name was replaced
      // (L1 is not repointed while L2 does not reach N).
      expect(readFileSync(join(l.n, 'config.json'))).toEqual(NEW_CONFIG)
      expect(readFileSync(join(l.l2, 'config.json'))).toEqual(LEGACY_CONFIG)
      expect(isLink(l.l2)).toBe(false)
      expect(readlinkSync(l.l1)).toBe(l.l2)

      lines.length = 0
      const before = treeSnapshot(root)
      expect(startFor(l).outcome.kind).toBe('pending')
      expect(lines).toHaveLength(1)
      expect(treeSnapshot(root)).toEqual(before)

      // The operator settled it: the old file is removed, the next start finishes.
      lines.length = 0
      unlinkSync(join(l.l2, 'config.json'))
      expect(startFor(l).outcome.kind).toBe('moved')
      expect(readlinkSync(l.l2)).toBe(l.n)
      expect(readlinkSync(l.l1)).toBe(l.n)
      expect(readFileSync(join(l.n, 'config.json'))).toEqual(NEW_CONFIG)
      // Everything else moved when it was pending (its old names are links), so the finish moves nothing.
      expect(lines).toEqual([stateDirMergedLine(l.l2, l.n, [], true), stateDirRepointedLine(l.l1, l.l2, l.n)])
    })

    test('0.14.0 with a different config.json already at N: L2 merges (crontab, prompts), then one WARN naming L1, which stays a directory', () => {
      seed0140(l)
      put(l.n, 'config.json', NEW_CONFIG)

      const result = startFor(l)

      expect(result.paths).toEqual({ legacyDir: l.l1, newDir: l.n })
      expect(result.outcome.kind).toBe('pending')
      if (result.outcome.kind !== 'pending') return
      expect(result.outcome.conflicts).toEqual(['config.json'])
      expect(lines).toHaveLength(2)
      expect(lines[0]).toBe(stateDirMergedLine(l.l2, l.n, ['crontab', 'prompts'], true))
      expect(lines[1]!.startsWith(STATE_MIGRATE_WARN_PREFIX)).toBe(true)
      expect(lines[1]).toContain(`"config.json" exists both in ${l.l1} and in ${l.n} with different contents`)
      expect(readFileSync(join(l.n, 'config.json'))).toEqual(NEW_CONFIG)
      expect(readFileSync(join(l.l1, 'config.json'))).toEqual(LEGACY_CONFIG)
      expect(isLink(l.l1)).toBe(false)
      expect(readlinkSync(l.l2)).toBe(l.n)
      expect(readFileSync(join(l.n, 'crontab'), 'utf-8')).toBe(CRONTAB_TEXT)
    })

    test('up to 0.13 with a different config.json already at N: one WARN naming L1, L2 never made', () => {
      seedUpTo013(l)
      put(l.n, 'config.json', NEW_CONFIG)

      const result = startFor(l)

      expect(result.outcome.kind).toBe('pending')
      expect(lines).toHaveLength(1)
      expect(lines[0]).toContain(`"config.json" exists both in ${l.l1} and in ${l.n}`)
      expect(readFileSync(join(l.n, 'config.json'))).toEqual(NEW_CONFIG)
      expect(readFileSync(join(l.l1, 'config.json'))).toEqual(LEGACY_CONFIG)
      expect(existsSync(l.l2)).toBe(false)
    })
  })

  describe('the outcome of several steps', () => {
    test('the first step that stops the start ends the run, with the paths of that step: L2 failing leaves L1 alone', () => {
      seed0140(l)
      const l1Before = treeSnapshot(l.l1)

      const result = startFor(l, { fs: { rename: renameFailingFrom(l.l2, 'EACCES') } })

      expect(result.outcome.kind).toBe('failed')
      expect(stateDirMigrationStopsStart(result.outcome)).toBe(true)
      expect(result.paths).toEqual({ legacyDir: l.l2, newDir: l.n, legacyIsXdg: true })
      expect(stateDirStopMessage(result.paths!, result.outcome)).toContain(l.l2)
      expect(isLink(l.l1)).toBe(false)
      expect(treeSnapshot(l.l1)).toEqual(l1Before)
      expect(isLink(l.l2)).toBe(false)
    })

    test("0.14.0, L2 failing: the stop is recorded in L1 (startupErrorDir, where the config is), not in L2, and the line does not advise SLACK_STATE_DIR=<L2>", () => {
      seed0140(l)

      const result = startFor(l, { fs: { rename: renameFailingFrom(l.l2, 'EACCES') } })

      expect(result.outcome.kind).toBe('failed')
      expect(result.paths!.legacyDir).toBe(l.l2)
      expect(result.startupErrorDir).toBe(l.l1)
      expect(result.startupErrorDir).not.toBe(result.paths!.legacyDir)
      expect(result.outcome).toMatchObject({ legacyHoldsConfig: false })
      const message = stateDirStopMessage(result.paths!, result.outcome)
      expect(message).toContain(`could not move the state directory from ${l.l2}`)
      expect(message).not.toContain('SLACK_STATE_DIR')
    })

    test('0.15.0, L2 failing: L2 holds the configuration, so it is where the stop is recorded and the line advises SLACK_STATE_DIR=<L2>', () => {
      seed0150(l)

      const result = startFor(l, { fs: { rename: renameFailingFrom(l.l2, 'EACCES') } })

      expect(result.outcome.kind).toBe('failed')
      expect(result.startupErrorDir).toBe(l.l2)
      expect(result.outcome).not.toHaveProperty('legacyHoldsConfig')
      expect(stateDirStopMessage(result.paths!, result.outcome)).toContain(`SLACK_STATE_DIR=${l.l2}`)
      expect(readlinkSync(l.l1)).toBe(l.l2)
    })

    test('a stop with N absent and no configuration anywhere (L1 holds only server.log): the stop is recorded in L1, and N is never made', () => {
      put(l.l1, 'server.log', 'a line\n')
      // The command-line resolution alone would name N, which is not there.
      expect(resolveCliStateDir(home, l.env)).toBe(l.n)

      const result = startFor(l, { fs: { rename: renameFailingFrom(l.l1, 'EACCES') } })

      expect(result.outcome.kind).toBe('failed')
      expect(stateDirMigrationStopsStart(result.outcome)).toBe(true)
      expect(result.paths).toEqual({ legacyDir: l.l1, newDir: l.n })
      expect(result.startupErrorDir).toBe(result.paths!.legacyDir)
      expect(result.startupErrorDir).toBe(l.l1)
      expect(existsSync(l.n)).toBe(false)
      expect(isLink(l.l1)).toBe(false)
      expect(names(l.l1)).toEqual(['server.log'])
    })

    test('a stop with N present and holding the configuration: the stop is recorded in N, as before', () => {
      put(l.n, 'config.json', NEW_CONFIG)
      put(l.l1, 'server.log', 'a line\n')

      const result = startFor(l, {
        fs: {
          link: (existing, created) => {
            if (existing === join(l.l1, 'server.log')) throw errno('EACCES')
            linkSync(existing, created)
          },
        },
      })

      expect(result.outcome.kind).toBe('failed')
      expect(result.paths).toEqual({ legacyDir: l.l1, newDir: l.n })
      expect(result.startupErrorDir).toBe(l.n)
      expect(result.startupErrorDir).not.toBe(result.paths!.legacyDir)
      expect(readFileSync(join(l.n, 'config.json'))).toEqual(NEW_CONFIG)
    })

    test('a stop in L2 with N absent and L2 holding only the crontab: the stop is recorded in L2, and N is never made', () => {
      put(l.l2, 'crontab', CRONTAB_TEXT)

      const result = startFor(l, { fs: { rename: renameFailingFrom(l.l2, 'EACCES') } })

      expect(result.outcome.kind).toBe('failed')
      expect(result.paths).toEqual({ legacyDir: l.l2, newDir: l.n, legacyIsXdg: true })
      expect(result.startupErrorDir).toBe(l.l2)
      expect(existsSync(l.n)).toBe(false)
    })

    test("L1 failing after L2 moved: the failure is returned with L1's paths, L2 stays moved, L1 keeps what did not move, and the advice names L1 (it holds the config)", () => {
      seed0140(l)

      const result = startFor(l, {
        fs: {
          link: (existing, created) => {
            if (existing === join(l.l1, 'config.json')) throw errno('EACCES')
            linkSync(existing, created)
          },
        },
      })

      expect(result.outcome.kind).toBe('failed')
      expect(stateDirMigrationStopsStart(result.outcome)).toBe(true)
      expect(result.paths).toEqual({ legacyDir: l.l1, newDir: l.n })
      // Computed before anything moved: L1, as the CLI and the daemon's log find it until the move is done.
      expect(result.startupErrorDir).toBe(l.l1)
      const message = stateDirStopMessage(result.paths!, result.outcome)
      expect(message).toContain(`could not move the state directory from ${l.l1}`)
      expect(message).toContain(`SLACK_STATE_DIR=${l.l1}`)
      expect(readlinkSync(l.l2)).toBe(l.n)
      expect(isLink(l.l1)).toBe(false)
      expect(readFileSync(join(l.l1, 'config.json'))).toEqual(LEGACY_CONFIG)
    })

    test("L2 a file (unusable) and L1 a directory: the WARN for L2 and the move of L1; moved is what is reported, with L1's paths", () => {
      seedUpTo013(l)
      put(dirname(l.l2), 'cscb', 'a file')

      const result = startFor(l)

      expect(result).toEqual({
        paths: { legacyDir: l.l1, newDir: l.n },
        outcome: { kind: 'moved', via: 'rename', entries: [] },
        startupErrorDir: l.l1,
      })
      expect(lines).toHaveLength(2)
      expect(lines[0]!.startsWith(STATE_MIGRATE_WARN_PREFIX)).toBe(true)
      expect(lines[0]).toContain(l.l2)
      expect(lines[1]).toBe(stateDirRenamedLine(l.l1, l.n))
      expect(readFileSync(l.l2, 'utf-8')).toBe('a file')
    })

    test('L2 pending and L1 a directory of its own (not a link to L2): L1 is still prepared, and pending is what is reported, with L1\'s paths', () => {
      seed0140(l)
      // A different crontab at N: L2's crontab conflicts, so L2 stays a directory; its prompts/ moves.
      const otherCrontab = '0 0 * * * prompts/other.md other\n'
      put(l.n, 'crontab', otherCrontab)

      const result = startFor(l)

      expect(result.paths).toEqual({ legacyDir: l.l1, newDir: l.n })
      expect(result.outcome).toEqual({ kind: 'pending', entries: MERGED_FROM_L1, conflicts: ['crontab'], leftover: [] })
      expect(stateDirMigrationStopsStart(result.outcome)).toBe(false)
      expect(lines).toEqual([
        stateDirPendingLine(l.l2, l.n, ['prompts'], ['crontab'], []),
        stateDirPendingLine(l.l1, l.n, MERGED_FROM_L1, ['crontab'], []),
      ])
      // N's crontab wins; both old crontabs are untouched and L2 and L1 stay directories.
      expect(readFileSync(join(l.n, 'crontab'), 'utf-8')).toBe(otherCrontab)
      expect(readFileSync(join(l.l2, 'crontab'), 'utf-8')).toBe(CRONTAB_TEXT)
      expect(isLink(l.l2)).toBe(false)
      expect(isLink(l.l1)).toBe(false)
      // The server's files reached N through L1's step.
      for (const [name, content] of Object.entries(SERVER_FILES)) expect(readFileSync(join(l.n, name))).toEqual(Buffer.from(content))
      expect(isLink(join(l.n, 'prompts'))).toBe(false)
      expect(readFileSync(join(l.n, 'prompts', 'daily.md'), 'utf-8')).toBe(PROMPT_TEXT)
      // What is left in L1: the old names of what moved (links to N's files) and the crontab link of the conflict.
      expect(names(l.l1)).toEqual([...Object.keys(SERVER_FILES), 'crontab', 'prompts'].sort())
      for (const name of Object.keys(SERVER_FILES)) expect(readlinkSync(join(l.l1, name))).toBe(join(l.n, name))
      expect(readFileSync(join(l.l1, 'crontab'), 'utf-8')).toBe(CRONTAB_TEXT)
    })
  })
})

describe('resolveCliStateDir before the start moved anything (L2 before L1, N once moved)', () => {
  /** Every layout the table seeds, with the directory a command acts on before and after the start. */
  const layouts: [string, (l: Layout) => void, (l: Layout) => string][] = [
    ['up to 0.13', (l) => seedUpTo013(l), (l) => l.l1],
    ['0.14.0 (L2 holds only the crontab and prompts)', (l) => seed0140(l), (l) => l.l1],
    ['0.14.0 with the crontab deleted', (l) => seed0140(l, 'crontab-deleted'), (l) => l.l1],
    ['0.15.0 (L2 holds the configuration, L1 links to it)', (l) => seed0150(l), (l) => l.l2],
  ]

  describe.each([
    ['~/.config', (): Layout => layoutFor()],
    ['an absolute XDG_CONFIG_HOME', (): Layout => layoutFor(join(root, 'xdg'))],
  ])('with %s', (_where, makeLayout) => {
    test.each(layouts)('%s: the directory holding the configuration, reads only; N once the start moved it', (_label, seed, before) => {
      const l = makeLayout()
      seed(l)
      const snapshot = treeSnapshot(root)

      expect(resolveCliStateDir(home, l.env)).toBe(before(l))
      expect(resolveCliConfigPath(home, l.env)).toBe(join(before(l), 'config.json'))
      expect(treeSnapshot(root)).toEqual(snapshot)

      expect(startFor(l).outcome.kind).toBe('moved')

      expect(resolveCliStateDir(home, l.env)).toBe(l.n)
      expect(resolveCliConfigPath(home, l.env)).toBe(join(l.n, 'config.json'))
    })
  })

  test('L2 before L1: with both real directories holding a configuration and N none, L2 wins', () => {
    const l = layoutFor()
    put(l.l1, 'config.json', LEGACY_CONFIG)
    put(l.l2, 'config.json', NEW_CONFIG)

    expect(resolveCliStateDir(home, {})).toBe(l.l2)
  })

  test('L2 holding only a PID file counts as holding the server (as for L1): L2', () => {
    const l = layoutFor()
    put(l.l2, 'server.pid', '4242')
    put(l.l1, 'config.json', LEGACY_CONFIG)

    expect(resolveCliStateDir(home, {})).toBe(l.l2)
  })

  test('N holding a configuration: N, whatever L2 and L1 hold (no old server running)', () => {
    const l = layoutFor()
    put(l.l1, 'config.json', LEGACY_CONFIG)
    put(l.l2, 'config.json', NEW_CONFIG)
    put(l.n, 'config.json', '{"n":1}')

    expect(resolveCliStateDir(home, {})).toBe(l.n)
  })

  test.each([
    ['a dangling link', (l: Layout): void => {
      mkdirSync(dirname(l.l2), { recursive: true })
      symlinkSync(join(root, 'gone'), l.l2)
    }],
    ['a file', (l: Layout): void => {
      put(dirname(l.l2), 'cscb', 'a file')
    }],
    ['an empty directory', (l: Layout): void => {
      mkdirSync(l.l2, { recursive: true })
    }],
  ])('L2 %s is no candidate: L1, which holds the configuration', (_label, makeL2) => {
    const l = layoutFor()
    makeL2(l)
    put(l.l1, 'config.json', LEGACY_CONFIG)

    expect(resolveCliStateDir(home, {})).toBe(l.l1)
  })

  test('L2 a link to N (migrated), L1 a link to L2: N', () => {
    const l = layoutFor()
    put(l.n, 'config.json', NEW_CONFIG)
    mkdirSync(dirname(l.l1), { recursive: true })
    symlinkSync(l.n, l.l2)
    symlinkSync(l.l2, l.l1)

    expect(resolveCliStateDir(home, {})).toBe(l.n)
  })

  test('SLACK_STATE_DIR set: that directory, whatever the three hold', () => {
    const l = layoutFor()
    seed0140(l)
    const chosen = join(root, 'chosen')

    expect(resolveCliStateDir(home, { SLACK_STATE_DIR: chosen })).toBe(chosen)
  })

  describe('an old server running', () => {
    test('on L1 (0.14.0), whatever N and L2 hold: L1, so stop and clean_restart reach it', () => {
      const l = layoutFor()
      seed0140(l)
      put(l.l1, 'server.pid', '4242')
      put(l.n, 'config.json', NEW_CONFIG)
      const before = treeSnapshot(root)

      expect(resolveCliStateDir(home, {}, undefined, (pid) => pid === 4242)).toBe(l.l1)
      expect(treeSnapshot(root)).toEqual(before)
    })

    test('on L2 (0.15.0), whatever N holds: L2', () => {
      const l = layoutFor()
      seed0150(l)
      put(l.l2, 'server.pid', '4242')
      put(l.n, 'config.json', NEW_CONFIG)

      expect(resolveCliStateDir(home, {}, undefined, (pid) => pid === 4242)).toBe(l.l2)
    })

    test('on L1 while L2 holds the configuration too: L1, the live server wins over L2 coming first', () => {
      const l = layoutFor()
      put(l.l1, 'server.pid', '4242')
      put(l.l1, 'config.json', LEGACY_CONFIG)
      put(l.l2, 'config.json', NEW_CONFIG)

      expect(resolveCliStateDir(home, {}, undefined, (pid) => pid === 4242)).toBe(l.l1)
    })

    test('a stale PID: the configuration decides (0.15.0: N holds one, so N)', () => {
      const l = layoutFor()
      seed0150(l)
      put(l.l2, 'server.pid', '4242')
      put(l.n, 'config.json', NEW_CONFIG)

      expect(resolveCliStateDir(home, {}, undefined, () => false)).toBe(l.n)
    })

    test('on the migrated directory (L2 and L1 links to N): N', () => {
      const l = layoutFor()
      put(l.n, 'server.pid', '4242')
      put(l.n, 'config.json', NEW_CONFIG)
      mkdirSync(dirname(l.l1), { recursive: true })
      symlinkSync(l.n, l.l2)
      symlinkSync(l.n, l.l1)

      expect(resolveCliStateDir(home, {}, undefined, () => true)).toBe(l.n)
    })
  })

  test('L2 and L1 that cannot be looked at: N', () => {
    const l = layoutFor()
    seed0150(l)

    expect(
      resolveCliStateDir(home, {}, {
        lstat: () => {
          throw errno('EACCES')
        },
      }),
    ).toBe(l.n)
  })
})
