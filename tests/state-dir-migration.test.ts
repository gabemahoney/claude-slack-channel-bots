/**
 * state-dir-migration.test.ts — The move of the server's state directory from
 * its old default, `~/.claude/channels/slack`, to the new one,
 * `<XDG config home>/cscb` (bug b.fc4): `prepareStateDir`,
 * `migrateStateDirAtStart`, `resolveCliStateDir` and `resolveCliConfigPath`
 * (src/state-dir-migration.ts).
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
 * - `N` present (a 0.14.0 host, with b.avm's crontab and prompts links back
 *   into it): entries absent from `N` move (a file as a hard link, a
 *   directory renamed, a link re-made with an absolute target), entries that
 *   are the same in `N` (b.avm links, one inode, equal bytes, an empty
 *   directory) are dropped, `L` becomes a symbolic link to `N`.
 * - A conflict (different contents, or different kinds): `N`'s wins, `L`'s
 *   is untouched, one WARN, `pending`, and a later start finishes the move
 *   once the operator settled it.
 * - `L` that cannot be a source: a link to another directory, a file.
 * - Symbolic links in `L`: dangling ones move as they are (or settle against
 *   the same dangling target at `N`), b.avm's `L/crontab` -> `N/crontab`
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
 *   final cleanup; b.avm's links from `N` back into `L` (moved over the link).
 * - Re-runs: a second start changes nothing and logs nothing; a pending move
 *   repeats its WARN and changes nothing.
 * - The commands other than the start (`resolveCliStateDir`,
 *   `resolveCliConfigPath`): `L` while an old server runs on it (whatever `N`
 *   holds), or while it is a directory (real, or a link elsewhere) holding a
 *   configuration (or a PID file) and `N` holds no configuration; reads only.
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
import { dirname, join, resolve, sep } from 'node:path'

import {
  STATE_MIGRATE_LOG_PREFIX,
  STATE_MIGRATE_WARN_PREFIX,
  NODE_STATE_DIR_MIGRATION_FS,
  legacyServerStateDir,
  migrateStateDirAtStart,
  prepareStateDir,
  resolveCliConfigPath,
  resolveCliStateDir,
  stateDirFailedLine,
  stateDirLegacyServerRunningLine,
  stateDirLegacyUnusableLine,
  stateDirMergedLine,
  stateDirMigrationStopsStart,
  stateDirPaths,
  stateDirPendingLine,
  stateDirRenamedLine,
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
  newDir = join(home, '.config', 'cscb')
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
      newDir: join(home, '.config', 'cscb'),
    })
  })

  test('SLACK_STATE_DIR set: no paths, nothing to move', () => {
    expect(stateDirPaths(home, { SLACK_STATE_DIR: join(root, 'chosen') })).toBeUndefined()
  })

  test('SLACK_STATE_DIR empty: it names nothing, so the default paths', () => {
    expect(stateDirPaths(home, { SLACK_STATE_DIR: '' })).toEqual({ legacyDir, newDir })
  })

  test('SLACK_STATE_DIR set: overridden, nothing logged, L and N untouched, and a PID file in L is not even read', () => {
    put(legacyDir, 'config.json', LEGACY_CONFIG)
    put(legacyDir, 'server.pid', '4242')
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

    expect(result).toEqual({ paths: undefined, outcome: { kind: 'overridden' } })
    expect(lines).toEqual([])
    expect(asked).toBe(false)
    expect(treeSnapshot(root)).toEqual(before)
    expect(existsSync(newDir)).toBe(false)
  })

  test('no SLACK_STATE_DIR: the directories of the environment are migrated', () => {
    put(legacyDir, 'config.json', LEGACY_CONFIG)

    const result = migrateStateDirAtStart({ log: (line) => lines.push(line) }, home, {})

    expect(result.paths).toEqual(paths)
    expect(result.outcome).toEqual({ kind: 'moved', via: 'rename', entries: [] })
    expect(readFileSync(join(newDir, 'config.json'))).toEqual(LEGACY_CONFIG)
  })

  test('XDG_CONFIG_HOME set: L moves to <XDG_CONFIG_HOME>/cscb', () => {
    const xdgNew = join(root, 'xdg', 'cscb')
    put(legacyDir, 'config.json', LEGACY_CONFIG)

    const result = migrateStateDirAtStart({ log: (line) => lines.push(line) }, home, { XDG_CONFIG_HOME: join(root, 'xdg') })

    expect(result.paths).toEqual({ legacyDir, newDir: xdgNew })
    expect(result.outcome).toEqual({ kind: 'moved', via: 'rename', entries: [] })
    expect(readFileSync(join(xdgNew, 'config.json'))).toEqual(LEGACY_CONFIG)
    expect(readlinkSync(legacyDir)).toBe(xdgNew)
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
  test('a 0.14.0 host: b.avm links into N are dropped, the rest moves, L becomes a link', () => {
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

describe("prepareStateDir: b.avm's cross-file-system links back into L (N/<name> is a link to L/<name>)", () => {
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

  test("b.avm's leftovers (L/crontab -> N/crontab and L/prompts -> N/prompts, both deleted at N): dropped, nothing made at N, no self-loop, L becomes the link", () => {
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

  test("b.avm's leftovers with N the only thing in the move: moved with no entries, N stays empty", () => {
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
    const xdgNew = join(root, 'xdg', 'cscb')
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
