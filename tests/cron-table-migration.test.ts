/**
 * cron-table-migration.test.ts — The start's preparation of the crontable's
 * default location and its move of a crontable left at the old default (bug
 * b.avm): `prepareDefaultCronTable` and `cronTablePathForStart`
 * (src/cron-table-migration.ts).
 *
 * Bots edit the crontable often, and Claude Code asks the user before every
 * write under `~/.claude`, so the default moved from `<config dir>/crontab`
 * (`~/.claude/channels/slack/crontab`) to `$XDG_CONFIG_HOME/cscb/crontab`
 * (`~/.config/cscb/crontab`). Sections:
 * - When it acts: only when the loader filled in the default
 *   (`cron_table_path_defaulted`) and the default is not the legacy path. Any
 *   `cron_table_path` written in the configuration (through the real loader),
 *   the default's own file and the legacy path included, makes no directory
 *   and moves nothing; with `SLACK_STATE_DIR` set the default is the legacy
 *   path.
 * - The crontable the start runs on (`cronTablePathForStart`): the legacy
 *   path after a failure before the file reached the new path, the
 *   crontable in effect otherwise.
 * - The move: a legacy file alone moves byte-for-byte (one inode, its mode
 *   kept) and leaves a symbolic link to the new path at the old one; the hard
 *   link's fallback, a copy placed from a temporary name, for every
 *   link-unsupported errno (`EXDEV` and the rest).
 * - The new path is never overwritten: both present (the new one wins, the
 *   legacy one is untouched, one WARN), the legacy file's inode number on
 *   another device (another file), and a file that appears at the new path
 *   during the move (before the hard link, before the copy is placed, or
 *   before the link to a legacy link's target).
 * - Neither present: the directory is made and the scheduler's bootstrap
 *   creates the crontable there.
 * - Re-runs: a second start changes nothing and logs nothing, and so does a
 *   new path that links back to the legacy file; a crontable deleted after a
 *   move is re-created and the old path names it again.
 * - Other legacy shapes: a symbolic link to a file elsewhere (`linked`), a
 *   dangling link (`no-legacy`), a directory or a link to one
 *   (`not-regular`), one inode under both names (an interrupted move,
 *   finished as `resumed`).
 * - Failures, injected one file-system operation at a time through
 *   `deps.fs`. Before the file is at the new path (mkdir, with or without a
 *   legacy file; the link beside the legacy path; a hard link refused with
 *   `EACCES`; the new path's link to a legacy link's target refused with
 *   `EACCES`; a copy that fails after creating its file; a legacy file that
 *   changes while it is copied; an lstat that cannot look): one WARN, nothing
 *   changed, no temporary name left, and the start runs on the legacy path.
 *   After it (the swap's rename, or the link that finishes an interrupted
 *   move): one WARN, the start runs on the new path, and the next start
 *   finishes the swap.
 * - Relative prompt paths: `prompts/` beside the legacy crontable moves into
 *   the new folder and its old name becomes a symbolic link to it, so
 *   `prompts/<file>` lines resolve, through the dispatcher's own
 *   `resolvePromptPath`, to the same files; across file systems (`EXDEV`) the
 *   new name links to the old directory, with a WARN; a legacy `prompts` that
 *   is itself a link has the new name link to its directory; a prompt kept
 *   beside the crontable itself gets one WARN naming its absolute path; a
 *   taken `prompts` entry is left alone; a move, an old-name link or a
 *   new-name link that fails is one WARN each.
 * - Hot reload after the move: a line appended through the new path, and one
 *   appended through the legacy symbolic link, each fire on the next tick of
 *   a scheduler reading the new path.
 *
 * Isolation: every case works under its own `mkdtempSync` root, removed in
 * `afterEach`: a fake home holding `.claude/channels/slack` (the legacy
 * directory), with both paths from the real resolvers (`legacyCronTablePath`,
 * `resolveDefaultCronTablePath`) over that home and an explicit environment
 * object, never `process.env`. Failures are injected through `deps.fs`; every
 * other operation is the real file system on the scratch tree. The scheduler
 * runs on a manual clock with a recording dispatcher (no timer fires, no
 * HTTP), as in tests/cron-scheduler-reload.test.ts. Every case's log lines
 * go through `assertNoLeak`.
 *
 * SPDX-License-Identifier: MIT
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  appendFileSync,
  chmodSync,
  copyFileSync,
  constants as fsConstants,
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
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import {
  CRON_MIGRATE_LOG_PREFIX,
  CRON_MIGRATE_WARN_PREFIX,
  CRON_PROMPTS_DIR_NAME,
  CRON_TABLE_CHANGED_DURING_COPY_CAUSE,
  cronPromptsLinkedAcrossFileSystemsLine,
  cronPromptsLinkedLine,
  cronPromptsLinkFailedLine,
  cronPromptsMovedLine,
  cronPromptsMoveFailedLine,
  cronPromptsOldNameLinkFailedLine,
  cronRelativePromptMovedLine,
  cronTableBothExistLine,
  cronTableLinkedLine,
  cronTableMkdirFailedLine,
  cronTableMovedLine,
  cronTableMoveFailedLine,
  cronTableNotRegularLine,
  cronTablePathForStart,
  cronTableSwapFailedLine,
  prepareDefaultCronTable,
  type CronTableEntryStat,
  type CronTableMigrationFs,
  type CronTableMigrationOutcome,
  type CronTablePaths,
} from '../src/cron-table-migration.ts'
import { legacyCronTablePath, resolveDefaultCronTablePath, resolvePersonaConfig } from '../src/config.ts'
import { CRONTABLE_TEMPLATE_HEADER, ensureCrontableExists } from '../src/cron-bootstrap.ts'
import { resolvePromptPath, type CronDispatcher } from '../src/cron-dispatch.ts'
import { createCronLog } from '../src/cron-log.ts'
import { createCronScheduler, type SchedulerClock } from '../src/cron-scheduler.ts'
import type { CronSchedule } from '../src/crontable.ts'
import { assertNoLeak } from './test-helpers/credentials.ts'
import { makePersonaConfigInput } from './test-helpers/persona-config.ts'
import { treeSnapshot } from './test-helpers/tree-snapshot.ts'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/**
 * A legacy crontable's bytes: comments, an absolute and a relative prompt,
 * a CRLF line, a non-ASCII byte and no final newline, so a rewrite of any
 * kind would show.
 */
const LEGACY_BYTES = Buffer.from(
  '# my schedules (café)\n0 9 * * * /abs/prompts/a.md planner\r\n*/5 * * * * prompts/b.md reviewer\n# no newline',
  'utf-8',
)

/** Bytes of a crontable already at the new path. */
const NEW_BYTES = Buffer.from('# the crontable in use\n0 8 * * * /abs/new.md planner\n', 'utf-8')

let root: string
let home: string
let configDir: string
let legacyPath: string
let defaultPath: string
/** Every line the preparation logged in this case. */
let lines: string[]

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cron-table-migration-test-'))
  home = join(root, 'home')
  configDir = join(home, '.claude', 'channels', 'slack')
  mkdirSync(configDir, { recursive: true })
  legacyPath = legacyCronTablePath(configDir)
  // SLACK_STATE_DIR and XDG_CONFIG_HOME unset: the default install's paths.
  defaultPath = resolveDefaultCronTablePath(configDir, home, {})
  lines = []
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
  // The lines carry paths and file-system error text, never a token.
  assertNoLeak(lines, 'cron-table-migration log lines')
})

/** The default's directory, `<home>/.config/cscb`. */
function defaultDir(): string {
  return dirname(defaultPath)
}

/** The paths, the default filled in by the loader and in effect unless overridden. */
function pathsWith(overrides: Partial<CronTablePaths> = {}): CronTablePaths {
  return { inEffect: defaultPath, defaulted: true, defaultPath, legacyPath, ...overrides }
}

/**
 * The paths main() builds from a configuration the real loader resolved with
 * `written` as its top-level keys, under this case's home with
 * `SLACK_STATE_DIR` and `XDG_CONFIG_HOME` unset unless `env` says otherwise.
 */
function pathsFromLoader(written: Record<string, unknown>, env: NodeJS.ProcessEnv = {}): CronTablePaths {
  const config = resolvePersonaConfig({ ...makePersonaConfigInput({}, root), ...written }, configDir, home, { env })
  return {
    inEffect: config.cron_table_path,
    defaulted: config.cron_table_path_defaulted === true,
    defaultPath: resolveDefaultCronTablePath(configDir, home, env),
    legacyPath,
  }
}

/** Run the preparation over this case's paths, its lines into `lines`, with `fs` overriding single operations. */
function prepare(fs?: Partial<CronTableMigrationFs>, paths: CronTablePaths = pathsWith()): CronTableMigrationOutcome {
  return prepareDefaultCronTable(paths, { log: (line) => lines.push(line), fs })
}

/** The crontable a start over the default paths runs on after `outcome`. */
function startPath(outcome: CronTableMigrationOutcome): string {
  return cronTablePathForStart(pathsWith(), outcome)
}

/** An errno-style error, as a failing `node:fs` call throws it. */
function errno(code: string, path: string): NodeJS.ErrnoException {
  const err = new Error(`${code}: injected failure, '${path}'`) as NodeJS.ErrnoException
  err.code = code
  return err
}

/** A `link` that refuses only the legacy file's own hard link with `code` (another file system, say); any other link is real. */
function refuseLegacyLink(code: string): Pick<CronTableMigrationFs, 'link'> {
  return {
    link: (existing, newPath) => {
      if (existing === legacyPath) throw errno(code, newPath)
      linkSync(existing, newPath)
    },
  }
}

/** Write the legacy crontable with `LEGACY_BYTES` and mode 0640; returns its inode. */
function writeLegacy(bytes: Buffer = LEGACY_BYTES): number {
  writeFileSync(legacyPath, bytes)
  chmodSync(legacyPath, 0o640)
  return statSync(legacyPath).ino
}

/**
 * The legacy path is now a symbolic link to the new path, and the new path
 * holds `bytes` as a regular file; no temporary name is left in either
 * directory.
 */
function expectMoved(bytes: Buffer = LEGACY_BYTES): void {
  expect(lstatSync(defaultPath).isFile()).toBe(true)
  expect(readFileSync(defaultPath).equals(bytes)).toBe(true)
  expect(lstatSync(legacyPath).isSymbolicLink()).toBe(true)
  expect(readlinkSync(legacyPath)).toBe(defaultPath)
  expect(readFileSync(legacyPath).equals(bytes)).toBe(true)
  // One name left on the file: the legacy hard link (if any) was replaced by the link.
  expect(statSync(defaultPath).nlink).toBe(1)
  expect(readdirSync(configDir)).toEqual(['crontab'])
  expect(readdirSync(defaultDir())).toEqual(['crontab'])
}

/** The legacy crontable is still the regular file it was, with its bytes. */
function expectLegacyUntouched(inode: number, bytes: Buffer = LEGACY_BYTES): void {
  expect(lstatSync(legacyPath).isFile()).toBe(true)
  expect(statSync(legacyPath).ino).toBe(inode)
  expect(readFileSync(legacyPath).equals(bytes)).toBe(true)
}

/**
 * The legacy path a symbolic link to `<root>/shared/crontab`, which holds
 * `LEGACY_BYTES`; returns the link's target as written and its real path.
 */
function linkLegacyToShared(): { shared: string; target: string } {
  const shared = join(root, 'shared', 'crontab')
  mkdirSync(dirname(shared))
  writeFileSync(shared, LEGACY_BYTES)
  symlinkSync(shared, legacyPath)
  return { shared, target: realpathSync(shared) }
}

/** Nothing was placed: the default's directory is empty, and nothing but the crontable is in the legacy one (no temporary name). */
function expectNothingPlaced(): void {
  expect(readdirSync(defaultDir())).toEqual([])
  expect(readdirSync(configDir)).toEqual(['crontab'])
}

// ---------------------------------------------------------------------------
// When it acts
// ---------------------------------------------------------------------------

describe('prepareDefaultCronTable: only a default the loader filled in is prepared', () => {
  test('cron_table_path left out: the paths main() builds from the loader are the default, flagged as filled in', () => {
    expect(pathsFromLoader({})).toEqual(pathsWith())
    expect(pathsFromLoader({ cron_table_path: null })).toEqual(pathsWith())
  })

  // D-Q1: the server never makes the directory of a path the operator wrote,
  // and never moves a crontable to it, even when it names the default's file.
  test.each<[string, () => string]>([
    ['another path (~ expanded)', () => '~/mine/crontab'],
    ["the default's own file", () => defaultPath],
    ["the default's own file, written with ~", () => '~/.config/cscb/crontab'],
    ['the legacy path', () => legacyPath],
  ])('cron_table_path written as %s: nothing is made, moved or logged, and the start runs on it', (_label, written) => {
    const inode = writeLegacy()
    const paths = pathsFromLoader({ cron_table_path: written() })
    expect(paths.defaulted).toBe(false)
    let mkdirs = 0
    const before = treeSnapshot(home, { extended: true })

    const outcome = prepare({ mkdirp: () => { mkdirs++ } }, paths)

    expect(outcome).toEqual({ kind: 'not-default' })
    expect(mkdirs).toBe(0)
    expect(existsSync(join(home, '.config'))).toBe(false)
    expect(existsSync(join(home, 'mine'))).toBe(false)
    expectLegacyUntouched(inode)
    expect(treeSnapshot(home, { extended: true })).toEqual(before)
    expect(lines).toEqual([])
    expect(cronTablePathForStart(paths, outcome)).toBe(paths.inEffect)
  })

  test('with SLACK_STATE_DIR set the default is the legacy path: nothing is made or moved', () => {
    const inode = writeLegacy()
    const paths = pathsFromLoader({}, { SLACK_STATE_DIR: configDir })
    expect(paths).toEqual({ inEffect: legacyPath, defaulted: true, defaultPath: legacyPath, legacyPath })

    const outcome = prepare(undefined, paths)

    expect(outcome).toEqual({ kind: 'legacy-is-default' })
    expectLegacyUntouched(inode)
    expect(existsSync(join(home, '.config'))).toBe(false)
    expect(lines).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// The crontable the start runs on
// ---------------------------------------------------------------------------

describe('cronTablePathForStart: the legacy path only after a failure before the file reached the new path', () => {
  test.each<[string, CronTableMigrationOutcome, 'in effect' | 'legacy']>([
    ['not-default', { kind: 'not-default' }, 'in effect'],
    ['legacy-is-default', { kind: 'legacy-is-default' }, 'in effect'],
    ['no-legacy', { kind: 'no-legacy' }, 'in effect'],
    ['already-migrated', { kind: 'already-migrated' }, 'in effect'],
    ['moved via a hard link', { kind: 'moved', via: 'link' }, 'in effect'],
    ['moved via a copy', { kind: 'moved', via: 'copy' }, 'in effect'],
    ['an interrupted move finished', { kind: 'moved', via: 'resumed' }, 'in effect'],
    ['linked', { kind: 'linked', target: '/elsewhere/crontab' }, 'in effect'],
    ['both-exist', { kind: 'both-exist' }, 'in effect'],
    ['not-regular', { kind: 'not-regular' }, 'in effect'],
    ['a failed swap (the file is at the new path)', { kind: 'failed', step: 'swap', cause: 'x' }, 'in effect'],
    ['a failed mkdir', { kind: 'failed', step: 'mkdir', cause: 'x' }, 'legacy'],
    ['a failed move', { kind: 'failed', step: 'move', cause: 'x' }, 'legacy'],
    ['an entry that could not be looked at', { kind: 'failed', step: 'unexpected', cause: 'x' }, 'legacy'],
  ])('%s: the %s path', (_label, outcome, which) => {
    expect(startPath(outcome)).toBe(which === 'legacy' ? legacyPath : defaultPath)
  })
})

// ---------------------------------------------------------------------------
// The move
// ---------------------------------------------------------------------------

describe('prepareDefaultCronTable: a legacy crontable alone moves to the new default', () => {
  test('moved byte-for-byte as the same file (mode kept), the legacy path left a symbolic link to it, one information line', () => {
    const inode = writeLegacy()

    expect(prepare()).toEqual({ kind: 'moved', via: 'link' })

    expectMoved()
    expect(statSync(defaultPath).ino).toBe(inode)
    expect(statSync(defaultPath).mode & 0o777).toBe(0o640)
    expect(lines).toEqual([cronTableMovedLine(legacyPath, defaultPath)])
    expect(lines[0]!.startsWith(CRON_MIGRATE_LOG_PREFIX)).toBe(true)
  })

  test.each(['EXDEV', 'EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'EMLINK'])('a hard link refused with %s falls back to a copy: bytes and mode kept, the legacy path linked, no temporary copy left', (code) => {
    const inode = writeLegacy()

    const outcome = prepare(refuseLegacyLink(code))

    expect(outcome).toEqual({ kind: 'moved', via: 'copy' })
    expectMoved()
    expect(statSync(defaultPath).ino).not.toBe(inode)
    expect(statSync(defaultPath).mode & 0o777).toBe(0o640)
    expect(lines).toEqual([cronTableMovedLine(legacyPath, defaultPath)])
  })
})

// ---------------------------------------------------------------------------
// The new path is never overwritten
// ---------------------------------------------------------------------------

describe('prepareDefaultCronTable: a crontable at the new path is never overwritten', () => {
  test('both present: the new one is used, both are left byte-for-byte as they were, one WARN', () => {
    const inode = writeLegacy()
    mkdirSync(defaultDir(), { recursive: true })
    writeFileSync(defaultPath, NEW_BYTES)
    const before = treeSnapshot(home, { extended: true })

    const outcome = prepare()

    expect(outcome).toEqual({ kind: 'both-exist' })
    expect(startPath(outcome)).toBe(defaultPath)
    expect(treeSnapshot(home, { extended: true })).toEqual(before)
    expectLegacyUntouched(inode)
    expect(readFileSync(defaultPath).equals(NEW_BYTES)).toBe(true)
    expect(lines).toEqual([cronTableBothExistLine(legacyPath, defaultPath)])
    expect(lines[0]!.startsWith(CRON_MIGRATE_WARN_PREFIX)).toBe(true)
  })

  // One file is the same inode on the same device: an equal inode number on
  // another file system is another file, so it is neither an interrupted move
  // to finish nor already migrated.
  test('a regular file at the new path with the legacy file\'s inode number on another device is another file: both-exist, the legacy file untouched', () => {
    const inode = writeLegacy()
    mkdirSync(defaultDir(), { recursive: true })
    linkSync(legacyPath, defaultPath)
    const onOtherDevice = (read: (path: string) => CronTableEntryStat) => (path: string): CronTableEntryStat => {
      const s = read(path)
      if (path !== defaultPath) return s
      return {
        dev: s.dev + 1,
        ino: s.ino,
        size: s.size,
        mtimeMs: s.mtimeMs,
        isFile: () => s.isFile(),
        isDirectory: () => s.isDirectory(),
        isSymbolicLink: () => s.isSymbolicLink(),
      }
    }

    const outcome = prepare({ lstat: onOtherDevice((path) => lstatSync(path)), stat: onOtherDevice((path) => statSync(path)) })

    expect(outcome).toEqual({ kind: 'both-exist' })
    expect(startPath(outcome)).toBe(defaultPath)
    expectLegacyUntouched(inode)
    expect(lines).toEqual([cronTableBothExistLine(legacyPath, defaultPath)])
  })

  test('a file that appears at the new path just before its symbolic link to the legacy link\'s target is kept, not overwritten: both-exist', () => {
    const { shared } = linkLegacyToShared()
    const racer = Buffer.from('# a bot created this first\n', 'utf-8')

    const outcome = prepare({
      symlink: (target, path) => {
        if (path === defaultPath) writeFileSync(path, racer)
        symlinkSync(target, path)
      },
    })

    expect(outcome).toEqual({ kind: 'both-exist' })
    expect(startPath(outcome)).toBe(defaultPath)
    expect(lstatSync(defaultPath).isFile()).toBe(true)
    expect(readFileSync(defaultPath).equals(racer)).toBe(true)
    expect(readlinkSync(legacyPath)).toBe(shared)
    expect(readFileSync(shared).equals(LEGACY_BYTES)).toBe(true)
    expect(lines).toEqual([cronTableBothExistLine(legacyPath, defaultPath)])
  })

  test.each<[string, (racer: Buffer) => Partial<CronTableMigrationFs>]>([
    ['the hard link', (racer) => ({
      link: (existing, newPath) => {
        writeFileSync(newPath, racer)
        linkSync(existing, newPath)
      },
    })],
    ['the copy is placed (after EXDEV)', (racer) => ({
      ...refuseLegacyLink('EXDEV'),
      copyExclusive: (src, dest) => {
        copyFileSync(src, dest, fsConstants.COPYFILE_EXCL)
        writeFileSync(defaultPath, racer)
      },
    })],
  ])('a file that appears at the new path just before %s is kept, not overwritten or removed: both-exist, no temporary name left', (_label, racing) => {
    const inode = writeLegacy()
    const racer = Buffer.from('# a bot created this first\n', 'utf-8')

    expect(prepare(racing(racer))).toEqual({ kind: 'both-exist' })

    expect(readFileSync(defaultPath).equals(racer)).toBe(true)
    expect(readdirSync(defaultDir())).toEqual(['crontab'])
    expect(readdirSync(configDir)).toEqual(['crontab'])
    expectLegacyUntouched(inode)
    expect(lines).toEqual([cronTableBothExistLine(legacyPath, defaultPath)])
  })
})

// ---------------------------------------------------------------------------
// Neither present: the bootstrap creates the crontable in the new directory
// ---------------------------------------------------------------------------

/** A manual scheduler clock: `now()` is controlled, timers are captured and never fire. */
interface ManualClock extends SchedulerClock {
  advanceMinutes(n: number): void
}

function makeClock(start: Date): ManualClock {
  let t = start.getTime()
  return {
    now: () => new Date(t),
    setTimeout: ((cb: () => void, ms: number) => ({ cb, ms })) as unknown as SchedulerClock['setTimeout'],
    clearTimeout: (() => {}) as unknown as SchedulerClock['clearTimeout'],
    advanceMinutes(n: number) {
      t += n * 60_000
    },
  }
}

/** A dispatcher that records the prompt path of every fire. */
function makeDispatcher(): CronDispatcher & { paths: string[] } {
  const paths: string[] = []
  return {
    paths,
    async fire(schedule: CronSchedule): Promise<void> {
      paths.push(schedule.promptPath)
    },
  }
}

/** A started scheduler reading `cronTablePath`, its cron log under the root. */
function startScheduler(cronTablePath: string, clock: ManualClock): { dispatcher: ReturnType<typeof makeDispatcher>; scheduler: ReturnType<typeof createCronScheduler> } {
  const dispatcher = makeDispatcher()
  const scheduler = createCronScheduler({ dispatcher, cronLog: createCronLog(join(root, 'cron.log')), cronTablePath, clock })
  scheduler.start()
  return { dispatcher, scheduler }
}

const START = new Date('2026-06-15T10:30:00')

describe('prepareDefaultCronTable: neither crontable present', () => {
  test('the new directory is made, nothing is logged, and the scheduler\'s bootstrap then creates the crontable there', () => {
    // Without the preparation the bootstrap cannot create it: it never makes a directory.
    expect(ensureCrontableExists(defaultPath).outcome).toBe('failed')
    expect(existsSync(defaultDir())).toBe(false)

    const outcome = prepare()

    expect(outcome).toEqual({ kind: 'no-legacy' })
    expect(startPath(outcome)).toBe(defaultPath)
    expect(statSync(defaultDir()).isDirectory()).toBe(true)
    expect(existsSync(defaultPath)).toBe(false)
    expect(existsSync(legacyPath)).toBe(false)
    expect(lines).toEqual([])

    const { scheduler } = startScheduler(defaultPath, makeClock(START))
    scheduler.stop()
    expect(readFileSync(defaultPath, 'utf-8')).toBe(CRONTABLE_TEMPLATE_HEADER)
    // Nothing is created at the legacy path.
    expect(existsSync(legacyPath)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Re-runs
// ---------------------------------------------------------------------------

describe('prepareDefaultCronTable: running it again', () => {
  test('after a move, every later start finds it already done: nothing changes and nothing is logged', () => {
    writeLegacy()
    prepare()
    lines = []
    const before = treeSnapshot(home, { extended: true })

    expect(prepare()).toEqual({ kind: 'already-migrated' })
    expect(prepare()).toEqual({ kind: 'already-migrated' })

    expect(treeSnapshot(home, { extended: true })).toEqual(before)
    expectMoved()
    expect(lines).toEqual([])
  })

  test('a new path that is a symbolic link back to the legacy file is one file under both names: nothing changes and nothing is logged', () => {
    const inode = writeLegacy()
    mkdirSync(defaultDir(), { recursive: true })
    symlinkSync(legacyPath, defaultPath)
    const before = treeSnapshot(home, { extended: true })

    const outcome = prepare()

    expect(outcome).toEqual({ kind: 'already-migrated' })
    expect(startPath(outcome)).toBe(defaultPath)
    expect(treeSnapshot(home, { extended: true })).toEqual(before)
    expectLegacyUntouched(inode)
    expect(readlinkSync(defaultPath)).toBe(legacyPath)
    expect(lines).toEqual([])
  })

  test('a crontable deleted after the move counts as none: the bootstrap re-creates it, and the old path names it again', () => {
    writeLegacy()
    prepare()
    rmSync(defaultPath)
    lines = []

    expect(prepare()).toEqual({ kind: 'no-legacy' })
    expect(lines).toEqual([])
    expect(ensureCrontableExists(defaultPath)).toEqual({ outcome: 'created' })

    expect(readlinkSync(legacyPath)).toBe(defaultPath)
    expect(readFileSync(legacyPath, 'utf-8')).toBe(CRONTABLE_TEMPLATE_HEADER)
    expect(prepare()).toEqual({ kind: 'already-migrated' })
  })
})

// ---------------------------------------------------------------------------
// Other legacy shapes
// ---------------------------------------------------------------------------

describe('prepareDefaultCronTable: other things at the legacy path', () => {
  test('a symbolic link to a crontable elsewhere: the new path links to the same file, the legacy link and the file are left as they are', () => {
    const { shared, target } = linkLegacyToShared()

    expect(prepare()).toEqual({ kind: 'linked', target })

    expect(lstatSync(defaultPath).isSymbolicLink()).toBe(true)
    expect(readlinkSync(defaultPath)).toBe(target)
    expect(readlinkSync(legacyPath)).toBe(shared)
    expect(readFileSync(shared).equals(LEGACY_BYTES)).toBe(true)
    expect(lines).toEqual([cronTableLinkedLine(legacyPath, defaultPath, target)])
    // Both names are one file from here on.
    expect(prepare()).toEqual({ kind: 'already-migrated' })
  })

  test('a dangling symbolic link holds no schedules: nothing is moved or logged', () => {
    symlinkSync(join(root, 'gone'), legacyPath)

    expect(prepare()).toEqual({ kind: 'no-legacy' })

    expect(existsSync(defaultPath)).toBe(false)
    expect(readlinkSync(legacyPath)).toBe(join(root, 'gone'))
    expect(lines).toEqual([])
  })

  test.each<[string, () => void]>([
    ['a directory', () => mkdirSync(legacyPath)],
    ['a symbolic link to a directory', () => symlinkSync(mkdtempSync(join(root, 'dir-')), legacyPath)],
  ])('%s: one WARN, nothing moved', (_label, arrange) => {
    arrange()

    expect(prepare()).toEqual({ kind: 'not-regular' })

    expect(existsSync(defaultPath)).toBe(false)
    expect(lines).toEqual([cronTableNotRegularLine(legacyPath, defaultPath)])
  })

  test('one inode under both names (a move interrupted after placing the file): the next start finishes it', () => {
    const inode = writeLegacy()
    mkdirSync(defaultDir(), { recursive: true })
    linkSync(legacyPath, defaultPath)

    expect(prepare()).toEqual({ kind: 'moved', via: 'resumed' })

    expectMoved()
    expect(statSync(defaultPath).ino).toBe(inode)
    expect(lines).toEqual([cronTableMovedLine(legacyPath, defaultPath)])
  })
})

// ---------------------------------------------------------------------------
// Failures before the file is at the new path: one WARN, nothing changed, the
// start runs on the legacy path
// ---------------------------------------------------------------------------

describe('prepareDefaultCronTable: a step failing before the file is at the new path changes nothing, and the start runs on the legacy path', () => {
  test.each<[string, () => void]>([
    ['with a crontable at the legacy path', () => { writeLegacy() }],
    ['with none there', () => {}],
  ])('the default\'s directory cannot be made, %s: one WARN, nothing moved', (_label, arrange) => {
    arrange()
    const before = treeSnapshot(home, { extended: true })
    let cause = ''

    const outcome = prepare({ mkdirp: (path) => { const err = errno('EACCES', path); cause = err.message; throw err } })

    expect(outcome).toEqual({ kind: 'failed', step: 'mkdir', cause })
    // Not the default, beside which the scheduler's bootstrap could not create a crontable.
    expect(startPath(outcome)).toBe(legacyPath)
    expect(lines).toEqual([cronTableMkdirFailedLine(defaultDir(), legacyPath, cause)])
    expect(lines[0]!.startsWith(CRON_MIGRATE_WARN_PREFIX)).toBe(true)
    expect(treeSnapshot(home, { extended: true })).toEqual(before)
  })

  test('the symbolic link beside the legacy path cannot be made: nothing is linked or copied to the new path', () => {
    const inode = writeLegacy()
    let placements = 0
    let cause = ''

    const outcome = prepare({
      symlink: (_target, path) => { const err = errno('EACCES', path); cause = err.message; throw err },
      link: () => { placements++ },
      copyExclusive: () => { placements++ },
    })

    expect(outcome).toEqual({ kind: 'failed', step: 'move', cause })
    expect(startPath(outcome)).toBe(legacyPath)
    expect(placements).toBe(0)
    expectNothingPlaced()
    expectLegacyUntouched(inode)
    expect(lines).toEqual([cronTableMoveFailedLine(legacyPath, defaultPath, cause)])
  })

  test('a legacy link to a crontable elsewhere whose new-path link cannot be made (EACCES): nothing at the new path, the legacy link left as it is, and the next start links it', () => {
    const { shared, target } = linkLegacyToShared()
    let cause = ''

    const outcome = prepare({
      symlink: (linkTarget, path) => {
        if (path !== defaultPath) return symlinkSync(linkTarget, path)
        const err = errno('EACCES', path)
        cause = err.message
        throw err
      },
    })

    expect(outcome).toEqual({ kind: 'failed', step: 'move', cause })
    expect(startPath(outcome)).toBe(legacyPath)
    expect(readdirSync(defaultDir())).toEqual([])
    expect(readlinkSync(legacyPath)).toBe(shared)
    expect(readFileSync(shared).equals(LEGACY_BYTES)).toBe(true)
    expect(lines).toEqual([cronTableMoveFailedLine(legacyPath, defaultPath, cause)])
    expect(prepare()).toEqual({ kind: 'linked', target })
  })

  test('a hard link refused for another reason (EACCES) is not retried as a copy: nothing at the new path, the legacy file untouched', () => {
    const inode = writeLegacy()
    let copies = 0
    let cause = ''

    const outcome = prepare({
      link: (_existing, newPath) => { const err = errno('EACCES', newPath); cause = err.message; throw err },
      copyExclusive: () => { copies++ },
    })

    expect(outcome).toEqual({ kind: 'failed', step: 'move', cause })
    expect(startPath(outcome)).toBe(legacyPath)
    expect(copies).toBe(0)
    expectNothingPlaced()
    expectLegacyUntouched(inode)
    expect(lines).toEqual([cronTableMoveFailedLine(legacyPath, defaultPath, cause)])
    expect(lines[0]!.startsWith(CRON_MIGRATE_WARN_PREFIX)).toBe(true)
  })

  test('a copy that fails after creating its file leaves no partial crontable, so the next start tries again', () => {
    const inode = writeLegacy()
    let cause = ''
    const failingCopy: Partial<CronTableMigrationFs> = {
      ...refuseLegacyLink('EXDEV'),
      copyExclusive: (_src, dest) => {
        writeFileSync(dest, '# partial', { flag: 'wx' })
        const err = errno('ENOSPC', dest)
        cause = err.message
        throw err
      },
    }

    const outcome = prepare(failingCopy)

    expect(outcome).toEqual({ kind: 'failed', step: 'move', cause })
    expect(startPath(outcome)).toBe(legacyPath)
    expectNothingPlaced()
    expectLegacyUntouched(inode)
    expect(lines).toEqual([cronTableMoveFailedLine(legacyPath, defaultPath, cause)])
    expect(prepare(refuseLegacyLink('EXDEV'))).toEqual({ kind: 'moved', via: 'copy' })
    expectMoved()
  })

  // A bot appending a line while the crontable is copied: the copy lacks it,
  // so it is discarded rather than placed, and no schedule is lost.
  test.each<[string, () => void]>([
    ['a line appended (a bot self-scheduling)', () => appendFileSync(legacyPath, '\n* * * * * /p/new.md planner\n')],
    ['rewritten in place with the same size', () => {
      writeFileSync(legacyPath, Buffer.from(LEGACY_BYTES.toString('utf-8').replace('reviewer', 'reviewes'), 'utf-8'))
      const later = new Date(Date.now() + 60_000)
      utimesSync(legacyPath, later, later)
    }],
    ['replaced by another file (an editor saving it)', () => {
      writeFileSync(join(configDir, 'crontab.saved'), LEGACY_BYTES)
      renameSync(join(configDir, 'crontab.saved'), legacyPath)
    }],
  ])('a legacy file that changes while it is copied (%s): the copy is discarded, nothing is placed, and the next start moves the changed file', (_label, change) => {
    writeLegacy()

    const outcome = prepare({
      ...refuseLegacyLink('EXDEV'),
      copyExclusive: (src, dest) => {
        copyFileSync(src, dest, fsConstants.COPYFILE_EXCL)
        change()
      },
    })

    expect(outcome).toEqual({ kind: 'failed', step: 'move', cause: CRON_TABLE_CHANGED_DURING_COPY_CAUSE })
    expect(startPath(outcome)).toBe(legacyPath)
    expectNothingPlaced()
    expect(lstatSync(legacyPath).isFile()).toBe(true)
    expect(lines).toEqual([cronTableMoveFailedLine(legacyPath, defaultPath, CRON_TABLE_CHANGED_DURING_COPY_CAUSE)])

    const changed = readFileSync(legacyPath)
    lines = []
    expect(prepare(refuseLegacyLink('EXDEV'))).toEqual({ kind: 'moved', via: 'copy' })
    expectMoved(changed)
  })

  test('an entry that cannot be looked at is one WARN, never a throw', () => {
    const inode = writeLegacy()
    let cause = ''

    const outcome = prepare({
      lstat: (path) => {
        if (path !== legacyPath) return lstatSync(path)
        const err = errno('EACCES', path)
        cause = err.message
        throw err
      },
    })

    expect(outcome).toEqual({ kind: 'failed', step: 'unexpected', cause })
    expect(startPath(outcome)).toBe(legacyPath)
    expect(lines).toEqual([cronTableMoveFailedLine(legacyPath, defaultPath, cause)])
    expectNothingPlaced()
    expectLegacyUntouched(inode)
  })
})

// ---------------------------------------------------------------------------
// Failures after the file is at the new path: the start runs on the new path
// ---------------------------------------------------------------------------

describe('prepareDefaultCronTable: the legacy name failing to become a link after the file is at the new path', () => {
  test.each<[string, (fail: (path: string) => never) => Partial<CronTableMigrationFs>, () => void]>([
    [
      'after a hard link, the rename over the legacy path',
      (fail) => ({ rename: (from, to) => (to === legacyPath ? fail(to) : renameSync(from, to)) }),
      () => {},
    ],
    [
      'finishing an interrupted move (one inode under both names), the symbolic link beside the legacy path',
      (fail) => ({ symlink: (_target, path) => fail(path) }),
      () => {
        mkdirSync(defaultDir(), { recursive: true })
        linkSync(legacyPath, defaultPath)
      },
    ],
  ])('%s fails: one WARN, both names stay one file, the start runs on the new path, and the next start finishes the swap', (_label, failing, arrange) => {
    const inode = writeLegacy()
    arrange()
    let cause = ''
    const fail = (path: string): never => {
      const err = errno('EACCES', path)
      cause = err.message
      throw err
    }

    const outcome = prepare(failing(fail))

    expect(outcome).toEqual({ kind: 'failed', step: 'swap', cause })
    expect(startPath(outcome)).toBe(defaultPath)
    expect(lines).toEqual([cronTableSwapFailedLine(legacyPath, defaultPath, cause, true)])
    // The crontable in use holds every schedule, and an append at the old path still reaches it.
    expect(readFileSync(defaultPath).equals(LEGACY_BYTES)).toBe(true)
    expect(statSync(legacyPath).ino).toBe(inode)
    expect(statSync(defaultPath).ino).toBe(inode)
    expect(readdirSync(configDir)).toEqual(['crontab'])
    expect(readdirSync(defaultDir())).toEqual(['crontab'])

    lines = []
    expect(prepare()).toEqual({ kind: 'moved', via: 'resumed' })
    expectMoved()
  })

  test('after a copy, the rename fails: the WARN says the legacy path is a separate copy, the start runs on the new path, and no temporary name is left', () => {
    writeLegacy()
    let cause = ''

    const outcome = prepare({
      ...refuseLegacyLink('EXDEV'),
      rename: (from, to) => {
        if (to !== legacyPath) return renameSync(from, to)
        const err = errno('EACCES', to)
        cause = err.message
        throw err
      },
    })

    expect(outcome).toEqual({ kind: 'failed', step: 'swap', cause })
    expect(startPath(outcome)).toBe(defaultPath)
    expect(lines).toEqual([cronTableSwapFailedLine(legacyPath, defaultPath, cause, false)])
    expect(readFileSync(defaultPath).equals(LEGACY_BYTES)).toBe(true)
    expect(lstatSync(legacyPath).isFile()).toBe(true)
    expect(readdirSync(configDir)).toEqual(['crontab'])
    expect(readdirSync(defaultDir())).toEqual(['crontab'])
  })
})

// ---------------------------------------------------------------------------
// Relative prompt paths
// ---------------------------------------------------------------------------

describe('prepareDefaultCronTable: relative prompt paths after the move', () => {
  const PROMPT_A = '# prompt a\n'
  const BESIDE = '# kept beside the crontable\n'

  /**
   * The legacy directory's `prompts/a.md` and `beside.md`, and a crontable
   * naming them, an absolute and a `~` path, and a relative path that names
   * nothing. With `promptsElsewhere`, the prompts directory is
   * `<root>/shared-prompts` and the legacy `prompts` a symbolic link to it.
   */
  function arrangePrompts(promptsElsewhere = false): { legacyPrompts: string; newPrompts: string; promptsDir: string } {
    const legacyPrompts = join(configDir, CRON_PROMPTS_DIR_NAME)
    const promptsDir = promptsElsewhere ? join(root, 'shared-prompts') : legacyPrompts
    mkdirSync(promptsDir)
    if (promptsElsewhere) symlinkSync(promptsDir, legacyPrompts)
    writeFileSync(join(promptsDir, 'a.md'), PROMPT_A)
    writeFileSync(join(configDir, 'beside.md'), BESIDE)
    writeFileSync(
      legacyPath,
      [
        '# schedules',
        '0 9 * * * prompts/a.md planner',
        `0 10 * * * ${join(configDir, 'beside.md')} planner`,
        '0 11 * * * ~/home-prompt.md planner',
        '0 12 * * * beside.md planner',
        '0 13 * * * never-there.md planner',
        '',
      ].join('\n'),
    )
    return { legacyPrompts, newPrompts: join(defaultDir(), CRON_PROMPTS_DIR_NAME), promptsDir }
  }

  /** The WARN for line 5, whose prompt sits beside the legacy crontable itself. */
  const besideLine = (): string =>
    cronRelativePromptMovedLine(5, 'beside.md', join(configDir, 'beside.md'), join(defaultDir(), 'beside.md'))

  /** The WARN for line 2, when prompts/ was not carried beside the new crontable. */
  const promptsLine = (): string =>
    cronRelativePromptMovedLine(2, 'prompts/a.md', join(configDir, 'prompts', 'a.md'), join(defaultDir(), 'prompts', 'a.md'))

  /** An EACCES thrower that records its message in `causes`. */
  function failer(causes: string[]): (path: string) => never {
    return (path) => {
      const err = errno('EACCES', path)
      causes.push(err.message)
      throw err
    }
  }

  test('prompts/ moves beside the new crontable and its old name links to it, so prompts/<file> names the same file either way; a prompt beside the crontable gets one WARN naming its absolute path', () => {
    const { legacyPrompts, newPrompts } = arrangePrompts()
    const promptInode = statSync(join(legacyPrompts, 'a.md')).ino

    expect(prepare()).toEqual({ kind: 'moved', via: 'link' })

    // The directory itself moved, outside ~/.claude: the same file, not a copy.
    expect(lstatSync(newPrompts).isDirectory()).toBe(true)
    expect(statSync(join(newPrompts, 'a.md')).ino).toBe(promptInode)
    expect(readlinkSync(legacyPrompts)).toBe(newPrompts)
    // The dispatcher's own rule, against the crontable path in effect, and a path through the old name.
    expect(readFileSync(resolvePromptPath('prompts/a.md', defaultPath), 'utf-8')).toBe(PROMPT_A)
    expect(readFileSync(join(legacyPrompts, 'a.md'), 'utf-8')).toBe(PROMPT_A)
    // No temporary name is left in either directory.
    expect(readdirSync(configDir).sort()).toEqual(['beside.md', 'crontab', 'prompts'])
    expect(readdirSync(defaultDir()).sort()).toEqual(['crontab', 'prompts'])
    // The absolute, ~ and never-there lines get no WARN; beside.md (line 5) does.
    expect(lines).toEqual([cronTableMovedLine(legacyPath, defaultPath), cronPromptsMovedLine(legacyPrompts, newPrompts), besideLine()])
    expect(lines[1]!.startsWith(CRON_MIGRATE_LOG_PREFIX)).toBe(true)
    expect(lines[2]!.startsWith(CRON_MIGRATE_WARN_PREFIX)).toBe(true)
  })

  test('the two folders on different file systems (rename EXDEV): the new name links to the old directory instead, with a WARN, and prompts/<file> still resolves', () => {
    const { legacyPrompts, newPrompts } = arrangePrompts()
    let cause = ''

    const outcome = prepare({
      rename: (from, to) => {
        if (from !== legacyPrompts) return renameSync(from, to)
        const err = errno('EXDEV', to)
        cause = err.message
        throw err
      },
    })

    expect(outcome).toEqual({ kind: 'moved', via: 'link' })
    expect(readlinkSync(newPrompts)).toBe(legacyPrompts)
    expect(lstatSync(legacyPrompts).isDirectory()).toBe(true)
    expect(readFileSync(resolvePromptPath('prompts/a.md', defaultPath), 'utf-8')).toBe(PROMPT_A)
    expect(readdirSync(configDir).sort()).toEqual(['beside.md', 'crontab', 'prompts'])
    expect(lines).toEqual([
      cronTableMovedLine(legacyPath, defaultPath),
      cronPromptsLinkedAcrossFileSystemsLine(newPrompts, legacyPrompts, cause),
      besideLine(),
    ])
    expect(lines[1]!.startsWith(CRON_MIGRATE_WARN_PREFIX)).toBe(true)
  })

  test('a legacy prompts that is itself a symbolic link: the new name links to its directory, and the legacy link is left as it is', () => {
    const { legacyPrompts, newPrompts, promptsDir } = arrangePrompts(true)
    const target = realpathSync(promptsDir)

    expect(prepare()).toEqual({ kind: 'moved', via: 'link' })

    expect(readlinkSync(newPrompts)).toBe(target)
    expect(readlinkSync(legacyPrompts)).toBe(promptsDir)
    expect(readFileSync(resolvePromptPath('prompts/a.md', defaultPath), 'utf-8')).toBe(PROMPT_A)
    expect(lines).toEqual([cronTableMovedLine(legacyPath, defaultPath), cronPromptsLinkedLine(newPrompts, target), besideLine()])
  })

  test('a prompts entry already beside the new crontable is left alone, and each prompts/ line that no longer finds its file gets a WARN', () => {
    const { legacyPrompts, newPrompts } = arrangePrompts()
    mkdirSync(newPrompts, { recursive: true })

    prepare()

    expect(lstatSync(newPrompts).isDirectory()).toBe(true)
    expect(readdirSync(newPrompts)).toEqual([])
    expect(lstatSync(legacyPrompts).isDirectory()).toBe(true)
    expect(lines).toEqual([cronTableMovedLine(legacyPath, defaultPath), promptsLine(), besideLine()])
  })

  test.each<[string, (fail: (path: string) => never, legacyPrompts: string, newPrompts: string) => Partial<CronTableMigrationFs>]>([
    ['the symbolic link to it that takes its old name', (fail, _legacyPrompts, newPrompts) => ({
      symlink: (target, path) => (target === newPrompts ? fail(path) : symlinkSync(target, path)),
    })],
    ['the rename (EACCES)', (fail, legacyPrompts) => ({
      rename: (from, to) => (from === legacyPrompts ? fail(to) : renameSync(from, to)),
    })],
  ])('prompts/ cannot be moved because %s fails: one WARN, nothing moved or linked, no temporary name left', (_label, failing) => {
    const { legacyPrompts, newPrompts } = arrangePrompts()
    const causes: string[] = []

    expect(prepare(failing(failer(causes), legacyPrompts, newPrompts))).toEqual({ kind: 'moved', via: 'link' })

    expect(lstatSync(legacyPrompts).isDirectory()).toBe(true)
    expect(readdirSync(legacyPrompts)).toEqual(['a.md'])
    expect(existsSync(newPrompts)).toBe(false)
    expect(readdirSync(configDir).sort()).toEqual(['beside.md', 'crontab', 'prompts'])
    expect(causes).toHaveLength(1)
    expect(lines).toEqual([
      cronTableMovedLine(legacyPath, defaultPath),
      cronPromptsMoveFailedLine(legacyPrompts, newPrompts, causes[0]!),
      promptsLine(),
      besideLine(),
    ])
  })

  test('prompts/ moved but its old name cannot become a link: one WARN; prompts/<file> resolves beside the new crontable, and no temporary name is left', () => {
    const { legacyPrompts, newPrompts } = arrangePrompts()
    const causes: string[] = []
    const fail = failer(causes)

    const outcome = prepare({ rename: (from, to) => (to === legacyPrompts ? fail(to) : renameSync(from, to)) })

    expect(outcome).toEqual({ kind: 'moved', via: 'link' })
    expect(lstatSync(newPrompts).isDirectory()).toBe(true)
    expect(existsSync(legacyPrompts)).toBe(false)
    expect(readFileSync(resolvePromptPath('prompts/a.md', defaultPath), 'utf-8')).toBe(PROMPT_A)
    expect(readdirSync(configDir).sort()).toEqual(['beside.md', 'crontab'])
    expect(causes).toHaveLength(1)
    expect(lines).toEqual([
      cronTableMovedLine(legacyPath, defaultPath),
      cronPromptsOldNameLinkFailedLine(legacyPrompts, newPrompts, causes[0]!),
      besideLine(),
    ])
  })

  test.each<[string, boolean, (fail: (path: string) => never, legacyPrompts: string, newPrompts: string) => Partial<CronTableMigrationFs>]>([
    ['a legacy prompts that is a link to a directory', true, (fail, _legacyPrompts, newPrompts) => ({
      symlink: (target, path) => (path === newPrompts ? fail(path) : symlinkSync(target, path)),
    })],
    ['the fallback after a rename EXDEV', false, (fail, legacyPrompts, newPrompts) => ({
      rename: (from, to) => {
        if (from === legacyPrompts) throw errno('EXDEV', to)
        renameSync(from, to)
      },
      symlink: (target, path) => (path === newPrompts ? fail(path) : symlinkSync(target, path)),
    })],
  ])('the new prompts name failing to link (%s) is one WARN; the crontable still moved', (_label, promptsElsewhere, failing) => {
    const { legacyPrompts, newPrompts, promptsDir } = arrangePrompts(promptsElsewhere)
    const target = promptsElsewhere ? realpathSync(promptsDir) : legacyPrompts
    const causes: string[] = []

    const outcome = prepare(failing(failer(causes), legacyPrompts, newPrompts))

    expect(outcome).toEqual({ kind: 'moved', via: 'link' })
    expect(existsSync(newPrompts)).toBe(false)
    expect(readFileSync(join(legacyPrompts, 'a.md'), 'utf-8')).toBe(PROMPT_A)
    expect(causes).toHaveLength(1)
    expect(lines).toEqual([
      cronTableMovedLine(legacyPath, defaultPath),
      cronPromptsLinkFailedLine(newPrompts, target, causes[0]!),
      promptsLine(),
      besideLine(),
    ])
  })
})

// ---------------------------------------------------------------------------
// Hot reload after the move
// ---------------------------------------------------------------------------

describe('after the move, a scheduler reading the new path picks up an append on its next tick', () => {
  /** The crontable moved, a scheduler started over the new path, and its first tick fired the one line. */
  async function movedAndRunning(clock: ManualClock) {
    writeFileSync(legacyPath, '* * * * * /p/a.md planner\n')
    expect(prepare()).toEqual({ kind: 'moved', via: 'link' })
    const running = startScheduler(defaultPath, clock)
    await running.scheduler.tick()
    expect(running.dispatcher.paths).toEqual(['/p/a.md'])
    return running
  }

  /**
   * Append `line` through `path` and move the file's mtime strictly past the
   * last load (anti-flake: two writes in one second share an mtime, though
   * the size changes anyway). `utimes` follows a symbolic link, as the append does.
   */
  function appendThrough(path: string, line: string, clock: ManualClock): void {
    appendFileSync(path, `${line}\n`)
    const seconds = Math.floor(clock.now().getTime() / 1000) + 5
    utimesSync(path, seconds, seconds)
  }

  test.each<[string, () => string]>([
    ['the new path', () => defaultPath],
    ['the legacy symbolic link (a resumed session\'s CSCB_CRONTABLE_PATH)', () => legacyPath],
  ])('a line appended through %s fires on the next tick', async (_label, through) => {
    const clock = makeClock(START)
    const { dispatcher, scheduler } = await movedAndRunning(clock)

    appendThrough(through(), '* * * * * /p/b.md planner', clock)
    clock.advanceMinutes(1)
    await scheduler.tick()
    scheduler.stop()

    expect(dispatcher.paths).toEqual(['/p/a.md', '/p/a.md', '/p/b.md'])
    // The append wrote the one crontable: the legacy path is still the link to it.
    expect(readlinkSync(legacyPath)).toBe(defaultPath)
    expect(lstatSync(defaultPath).isFile()).toBe(true)
  })
})
