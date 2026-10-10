/**
 * cron-scheduler-wiring.test.ts — Static audit (b.he5 E2 wiring guard;
 * b.av2 SR-11 cron semantics, SR-8.7 applied config).
 *
 * main() cannot run in a unit test (the agent-director startup gate, a real
 * port, real Slack connections), so the SRD invariant "the cron scheduler
 * starts only AFTER the HTTP server is listening, from main(), and is stopped
 * on shutdown" cannot be exercised behaviorally. This follows the repo
 * precedent for exactly that situation: tests/jsonl-safeguard-wiring.test.ts —
 * a content-anchored static audit of src/server.ts source text (import shape +
 * relative call-site ordering via indexOf; never line numbers).
 *
 * These assertions FAIL if the scheduler start call is dropped or reordered
 * before Bun.serve(), if the shutdown-path stop call disappears, if the cron
 * wiring runs before main() has an applied config, or if it stops reading the
 * applied config (its log and table paths, and the dispatcher's target
 * resolution). The applied config is the one `<loaded> = <outcome>.config`
 * after the reload controller's start resolution (the last-applied record, or
 * the config file when there is none); a refused start exits before that
 * assignment (pinned, with the start's assignment rule, in
 * tests/server-startup-wiring.test.ts).
 *
 * Bug b.avm: main() prepares the crontable's default location
 * (`prepareDefaultCronTable`, which also moves a crontable left at the old
 * default) once, in its own statement list, after the start's assignment and
 * before the first await after it, the start sweep, the start bring-up (so
 * before any launch takes CSCB_CRONTABLE_PATH) and the scheduler; over the
 * applied config's crontable, the loader's `cron_table_path_defaulted` and
 * config.ts's two resolvers over the config file's directory, with only a log
 * (the real file system). The crontable the start runs on
 * (`cronTablePathForStart` over the preparation's outcome) replaces only the
 * applied config's `cron_table_path`, in both the applied and the start-time
 * config, before the same anchors. What the two do is tested in
 * tests/cron-table-migration.test.ts.
 *
 * SPDX-License-Identifier: MIT
 */

import { describe, test, expect } from 'bun:test'
import { readFileSync } from 'node:fs'
import {
  atMainTopLevel,
  callArguments,
  cronTableStartOverride,
  importSource,
  indicesOf,
  maskLiterals,
  objectProperties,
  shutdownBody,
  splitTopLevel,
  srcModules,
  startResolution,
  stripComments,
} from './test-helpers/source-audit.ts'
import type * as ConfigModule from '../src/config.ts'
import type { PersonaConfig } from '../src/config.ts'
import type * as CronTableMigrationModule from '../src/cron-table-migration.ts'
import type { CronTableMigrationDeps, CronTablePaths } from '../src/cron-table-migration.ts'

/** server.ts with every comment removed (see stripComments). */
const SERVER_CODE = stripComments(readFileSync(new URL('../src/server.ts', import.meta.url), 'utf-8'))

/** The cron calls main() makes to build the scheduler. */
const CRON_BUILDERS = ['createCronLog', 'createCronDispatcher', 'createCronScheduler']

describe('server.ts wires the cron scheduler', () => {
  test('imports createCronScheduler from the cron-scheduler module', () => {
    // The import regex subsumes a bare `toContain` name check. Read the
    // comment-stripped code, so a commented-out import cannot satisfy it.
    expect(SERVER_CODE).toMatch(
      /import\s*\{[^}]*createCronScheduler[^}]*\}\s*from\s*['"]\.\/cron-scheduler\.ts['"]/,
    )
  })

  test('starts the scheduler AFTER the Bun.serve() call site', () => {
    // Anchor on `Bun.serve({` (the actual server construction) — NOT a bare
    // `Bun.serve(`, which would first match the `ReturnType<typeof Bun.serve>`
    // type annotation near the top of the file and defeat the ordering check.
    // Read the comment-stripped code, and check EVERY start call (`?.` and `!.`
    // included), so an extra early start cannot hide behind a later one.
    const serveIdx = SERVER_CODE.indexOf('Bun.serve({')
    const starts = indicesOf(/\bcronScheduler[?!]?\.start\s*\(/g, SERVER_CODE)
    expect(serveIdx).toBeGreaterThan(-1)
    expect(starts.length).toBeGreaterThan(0)
    for (const startIdx of starts) expect(startIdx).toBeGreaterThan(serveIdx)
  })

  test('builds and starts the cron wiring only once main() has the applied config: every call follows `<loaded> = <outcome>.config`', () => {
    // A refused start exits before that assignment (server-startup-wiring
    // pins the exit), so nothing after it runs on a refused start.
    const { assignAt } = startResolution(SERVER_CODE)
    const calls = [
      ...CRON_BUILDERS.flatMap((call) => indicesOf(new RegExp(`\\b${call}\\s*\\(`, 'g'), SERVER_CODE)),
      ...indicesOf(/\bcronScheduler[?!]?\.start\s*\(/g, SERVER_CODE),
    ]
    expect(calls.length).toBeGreaterThanOrEqual(CRON_BUILDERS.length + 1)
    for (const at of calls) expect(at).toBeGreaterThan(assignAt)
  })

  test('builds the cron log, dispatcher and scheduler from the applied persona config', () => {
    // The config the start resolution applied (b.av2 SR-8.7). The dispatcher
    // resolves each fire's target against it (b.av2 SR-11). The builders run
    // after `<loaded> = <outcome>.config` (the previous test), so reading
    // <loaded> there is reading the applied config, never the edited file.
    const { loaded } = startResolution(SERVER_CODE)
    for (const call of CRON_BUILDERS) {
      const at = SERVER_CODE.search(new RegExp(`\\b${call}\\s*\\(`))
      expect(at).toBeGreaterThan(-1)
      const args = callArguments(SERVER_CODE, at)
      expect(args).toMatch(new RegExp(`\\b${loaded}\\.cron_(?:log|table)_path\\b`))
    }
    expect(callArguments(SERVER_CODE, SERVER_CODE.search(/\bcreateCronDispatcher\s*\(/))).toMatch(
      new RegExp(`\\bresolveTarget\\s*:[^,]*\\bresolvePersonaTarget\\s*\\(\\s*${loaded}\\s*,`),
    )
  })

  test('stops the scheduler inside the shutdown() function body', () => {
    // Bound the shutdown function body by its braces in the comment-stripped
    // code. Anchoring on content (not line numbers) keeps the audit robust to
    // edits elsewhere, and stripping comments keeps a commented-out stop from
    // satisfying it.
    const shutdown = SERVER_CODE.slice(...shutdownBody(SERVER_CODE))
    // The stop call must live within the shutdown region; a bare presence check
    // elsewhere in the file would not prove it runs on the shutdown path.
    expect(shutdown).toMatch(/\bcronScheduler[?!]?\.stop\s*\(/)
  })
})

// ---------------------------------------------------------------------------
// Bug b.avm: the start prepares the default crontable location (and moves a
// crontable left at the old default) before anything takes the path
// ---------------------------------------------------------------------------

/**
 * The start's preparation, the pure choice of the crontable the start runs on,
 * and the two resolvers it is given; typed against their modules, so a rename
 * fails the typecheck.
 */
const PREPARE: keyof typeof CronTableMigrationModule = 'prepareDefaultCronTable'
const FOR_START: keyof typeof CronTableMigrationModule = 'cronTablePathForStart'
const DEFAULT_RESOLVER: keyof typeof ConfigModule = 'resolveDefaultCronTablePath'
const LEGACY_RESOLVER: keyof typeof ConfigModule = 'legacyCronTablePath'
/** The preparation's path and dependency members, and the loader's flag; renaming one fails the typecheck. */
const PATH_MEMBERS: Array<keyof CronTablePaths> = ['inEffect', 'defaulted', 'defaultPath', 'legacyPath']
const DEPS_LOG: keyof CronTableMigrationDeps = 'log'
const TABLE_PATH: keyof PersonaConfig = 'cron_table_path'
const DEFAULTED_FLAG: keyof PersonaConfig = 'cron_table_path_defaulted'

/** The offset of the preparation's only call in server.ts; fails unless there is exactly one. */
function preparation(): number {
  const calls = indicesOf(new RegExp(`\\b${PREPARE}\\s*\\(`, 'g'), SERVER_CODE)
  expect(calls).toHaveLength(1)
  return calls[0]!
}

/**
 * How main() wires the preparation, read from server.ts (each piece found
 * exactly once, or the call fails):
 *
 *     const <paths>: CronTablePaths = { … }
 *     const <forStart> = cronTablePathForStart(<paths>, prepareDefaultCronTable(<paths>, { log }))
 *     if (<forStart> !== <loaded>.cron_table_path) {
 *       <loaded> = { ...<loaded>, cron_table_path: <forStart> }
 *       <start-time> = <loaded>
 *     }
 *
 * (the last block located by `cronTableStartOverride`). Returns the names and
 * the offsets of the three statements.
 */
function startCronWiring(): {
  paths: string
  pathsAt: number
  forStart: string
  forStartAt: number
  startTime: string
  overrideAt: number
} {
  const forStartDecls = [...SERVER_CODE.matchAll(new RegExp(`\\bconst\\s+(\\w+)\\s*=\\s*${FOR_START}\\s*\\(`, 'g'))]
  expect(forStartDecls).toHaveLength(1)
  expect(indicesOf(new RegExp(`(?<![\\w.$])${FOR_START}\\s*\\(`, 'g'), SERVER_CODE)).toHaveLength(1)
  const forStart = forStartDecls[0]![1]!
  const forStartAt = forStartDecls[0]!.index!
  const forStartArgs = splitTopLevel(callArguments(SERVER_CODE, forStartAt + forStartDecls[0]![0].lastIndexOf(FOR_START)))
  expect(forStartArgs).toHaveLength(2)
  const paths = forStartArgs[0]!
  expect(paths).toMatch(/^\w+$/)
  // The preparation's only call is the second argument, over the same paths.
  expect(forStartArgs[1]).toMatch(new RegExp(`^${PREPARE}\\(${paths}, \\{`))

  const pathsDecls = [...SERVER_CODE.matchAll(new RegExp(`\\bconst\\s+${paths}\\s*(?::\\s*CronTablePaths\\s*)?=\\s*\\{`, 'g'))]
  expect(pathsDecls).toHaveLength(1)

  // The override replaces the applied config's crontable with this choice.
  const override = cronTableStartOverride(SERVER_CODE)
  expect(override.path).toBe(forStart)
  return {
    paths,
    pathsAt: pathsDecls[0]!.index!,
    forStart,
    forStartAt,
    startTime: override.startTime,
    overrideAt: override.at,
  }
}

describe('main() prepares the default crontable once, behind no branch, after the start resolves and before anything takes the crontable path (bug b.avm)', () => {
  test('imports the preparation and the start path\'s choice from their module; the paths, the choice over the preparation\'s outcome and the override are each a statement of main()\'s own statement list (so in dry run too)', () => {
    expect(importSource(SERVER_CODE, PREPARE)).toBe('./cron-table-migration.ts')
    expect(importSource(SERVER_CODE, FOR_START)).toBe('./cron-table-migration.ts')
    const { pathsAt, forStartAt, overrideAt } = startCronWiring()
    preparation()
    for (const at of [pathsAt, forStartAt, overrideAt]) expect(atMainTopLevel(SERVER_CODE, at)).toBe(true)
    expect(pathsAt).toBeLessThan(forStartAt)
    expect(forStartAt).toBeLessThan(overrideAt)
  })

  test('no other src file calls it', () => {
    const callers = [...srcModules()]
      .filter(([, code]) => new RegExp(`(?<![\\w.$]|function\\s+)${PREPARE}\\s*\\(`).test(code))
      .map(([name]) => name)
    expect(callers.filter((name) => name !== 'cron-table-migration.ts')).toEqual(['server.ts'])
  })

  test('compares the applied config\'s crontable, and whether the loader filled it in, with the default and legacy paths config.ts resolves over the config file\'s directory, as the loader does, and logs to console.error over the real file system', () => {
    const { loaded } = startResolution(SERVER_CODE)
    const { paths, pathsAt } = startCronWiring()
    const members = objectProperties(SERVER_CODE.slice(pathsAt))
    expect([...members.keys()]).toEqual(PATH_MEMBERS)
    expect(members.get('inEffect')).toBe(`${loaded}.${TABLE_PATH}`)
    // Absent on a hand-built configuration reads as false: nothing is prepared.
    expect(members.get('defaulted')).toBe(`${loaded}.${DEFAULTED_FLAG} === true`)
    // No home or environment argument: the OS home and process.env, as the start's loader reads them.
    expect(members.get('defaultPath')).toBe(`${DEFAULT_RESOLVER}(dirname(CONFIG_PATH))`)
    expect(members.get('legacyPath')).toBe(`${LEGACY_RESOLVER}(dirname(CONFIG_PATH))`)
    expect(importSource(SERVER_CODE, DEFAULT_RESOLVER)).toBe('./config.ts')
    expect(importSource(SERVER_CODE, LEGACY_RESOLVER)).toBe('./config.ts')
    // The loader's configuration directory is the start's config file's (reload's paths over CONFIG_PATH).
    expect(SERVER_CODE).toMatch(/\breloadFilePaths\(\s*CONFIG_PATH\s*\)/)

    const args = splitTopLevel(callArguments(SERVER_CODE, preparation()))
    expect(args).toHaveLength(2)
    expect(args[0]).toBe(paths)
    // Only a log: no file-system override, so production runs on the real file system.
    const deps = objectProperties(args[1]!)
    expect([...deps.keys()]).toEqual([DEPS_LOG])
    expect(deps.get(DEPS_LOG)).toMatch(/^\(\s*(\w+)\s*\)\s*=>\s*console\.error\(\s*\1\s*\)$/)
  })

  // A preparation that failed before the file reached the default location
  // leaves the schedules at the old path, so the start runs there: the
  // scheduler, the dispatcher and every launch's CSCB_CRONTABLE_PATH read the
  // applied config's cron_table_path, and a confirmed apply keeps the
  // start-time config's server-wide settings (configInEffect).
  test('writes the crontable the start runs on into the applied config, changing only its cron_table_path, and into the start-time applied config (the one variable set to <loaded> after the start assignment)', () => {
    const { loaded, assignAt } = startResolution(SERVER_CODE)
    const { startTime, overrideAt } = startCronWiring()
    const startTimeAssigns = [...SERVER_CODE.matchAll(new RegExp(`(?<![\\w.$])${startTime}\\s*=(?![=>])\\s*([^\\n;]*)`, 'g'))]
    expect(startTimeAssigns.map((m) => m[1]!.trim())).toEqual([loaded, loaded])
    expect(startTimeAssigns[0]!.index!).toBeGreaterThan(assignAt)
    expect(startTimeAssigns[0]!.index!).toBeLessThan(overrideAt)
    expect(atMainTopLevel(SERVER_CODE, startTimeAssigns[0]!.index!)).toBe(true)
    // The only place server.ts writes a cron_table_path.
    expect(indicesOf(new RegExp(`\\b${TABLE_PATH}\\s*:`, 'g'), maskLiterals(SERVER_CODE))).toEqual([
      SERVER_CODE.indexOf(`${TABLE_PATH}:`, overrideAt),
    ])
  })

  test('runs AFTER the applied config\'s start assignment (<loaded> = <outcome>.config)', () => {
    const { assignAt } = startResolution(SERVER_CODE)
    expect(startCronWiring().pathsAt).toBeGreaterThan(assignAt)
    expect(preparation()).toBeGreaterThan(assignAt)
  })

  // The first await after the start's assignment: a shutdown begun during it
  // returns from main() early. Text inside literals never counts.
  const firstAwaitAfterStart = (): number[] =>
    indicesOf(/\bawait\b/g, maskLiterals(SERVER_CODE)).filter((at) => at > startResolution(SERVER_CODE).assignAt).slice(0, 1)

  test.each<[string, () => number[]]>([
    ['the first await after the start\'s assignment', firstAwaitAfterStart],
    ['the start sweep (reconcileOrphans)', () => indicesOf(/\breconcileOrphans\s*\(/g, SERVER_CODE)],
    ['the start bring-up, so before any launch takes CSCB_CRONTABLE_PATH (<controller>.runStartBringUp)', () => [startResolution(SERVER_CODE).bringUpAt]],
    ['the scheduler\'s construction and its bootstrap (createCronScheduler, cronScheduler.start)', () => [
      ...indicesOf(/\bcreateCronScheduler\s*\(/g, SERVER_CODE),
      ...indicesOf(/\bcronScheduler[?!]?\.start\s*\(/g, SERVER_CODE),
    ]],
  ])('runs, with the override of the start\'s crontable, BEFORE %s', (_label, anchors) => {
    const later = anchors()
    expect(later.length).toBeGreaterThan(0)
    const { overrideAt } = startCronWiring()
    for (const at of later) {
      expect(preparation()).toBeLessThan(at)
      expect(overrideAt).toBeLessThan(at)
    }
  })
})
