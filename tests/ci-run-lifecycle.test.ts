/**
 * tests/ci-run-lifecycle.test.ts — the sharded `/ci` runner's lifecycle
 * (`scripts/ci-run.ts`; b.uqm SR-21.6): the RUN_ID, exit 64, the run
 * directory and the status file, the main entry and its runner log, and the
 * docker command layer's forms; plus the helper behaviour later proofs rest
 * on, `treeSnapshot`'s option (b.uqm SR-21.3) and the fake container
 * interface's image rules (b.uqm SR-23.6's unit proof).
 *
 * Every case drives the runner in process through its injected dependencies
 * (b.uqm SR-21.1), under its own `mkdtempSync` roots removed in `afterEach`,
 * with `createFakeClock` for every wait. No case starts a real child process,
 * reads `/proc` or a cgroup, runs docker or reaches the network. Status files,
 * runner logs and run directories come from the runner's own writers or the
 * run-directory builder in `tests/test-helpers/ci-run.ts`; expected texts and
 * values come from the runner's exports, never typed.
 *
 * Regions, one per Epic that adds to this file (Plan b.t6s), in this order:
 * E1, E8, E9, E13. Each Epic writes only inside its own region.
 *
 * SPDX-License-Identifier: MIT
 */

import { afterEach, describe, expect, test } from 'bun:test'
import {
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  atomicTempFileName,
  beginRun,
  BUILD_ALLOWANCE_MINUTES,
  buildRefusal,
  buildRefusedStatus,
  buildStatus,
  checkDockerAnswers,
  containerCopyOutArgs,
  containerCreateArgs,
  containerInspectionArgs,
  containerKillArgs,
  containerListArgs,
  containerLogsArgs,
  containerRemoveArgs,
  containerRunArgs,
  containerStateInspectArgs,
  copyOutOfContainer,
  createContainer,
  createRunnerLog,
  DEFAULT_TEMP_DIR,
  derivedImageBuildArgs,
  derivedImageDockerfile,
  DOCKER_RUN_LOG_PREFIX,
  dockerAnswersArgs,
  dockerRunLogLine,
  existingPathLine,
  FAILURE_EXIT_STATUS,
  formatOwner,
  formatRunnerLogFirstLine,
  formatRunTag,
  imageInspectArgs,
  imageListArgs,
  imagePruneArgs,
  imageTagArgs,
  imageTagRemovalArgs,
  inspectContainerState,
  inspectImage,
  isRunId,
  killContainer,
  listContainers,
  listImages,
  main,
  outOfRangeReason,
  OWNER_LABEL,
  ownerLabel,
  parseUtcTimeMs,
  PRUNE_ALREADY_RUNNING_TEXT,
  pruneUntaggedImages,
  RAW_KEY_PREFIX,
  readContainerInspection,
  readContainerLogs,
  readRunnerLogFirstLine,
  readStatusFile,
  recordRefusal,
  REDACTION_PLACEHOLDER,
  REFUSAL_EXIT_STATUS,
  refusalLine,
  removeContainer,
  removeImageTag,
  RUN_DIR_MODE,
  RUN_DIR_PREFIX,
  RUN_TAG_REPOSITORY,
  RUN_TAG_ROLES,
  runContainer,
  runDirPath,
  runIdTimeMs,
  RUNNER_LOG_FILE_NAME,
  STATUS_FILE_NAME,
  STATUS_FORMAT_VERSION,
  statusDeadline,
  STOPPED_AFTER_VALIDATION_TEXT,
  startDerivedImageBuild,
  startTestImageBuild,
  tagImage,
  TEST_DOCKERFILE_PATH,
  testImageBuildArgs,
  USAGE_EXIT_STATUS,
  USAGE_PREFIX,
  usageLine,
  writeStatusFile,
  type DerivedImageBuildSpec,
  type DockerContext,
  type ImageListFilter,
  type Owner,
  type RefusalKind,
  type RunnerClock,
  type RunnerDeps,
  type RunnerLogWriter,
  type RunStatus,
  type SpawnRequest,
  type SpawnResult,
  type StatusPhase,
  type TestImageBuildSpec,
} from '../scripts/ci-run.ts'
import {
  buildTarArchive,
  buildWorktree,
  createFakeDocker,
  createSignalRecorder,
  createSignalSource,
  createSpawnRecorder,
  makeRunDir,
  makeStatus,
  runDirIn,
  signalExitStatus,
  writeStatus,
  type FakeDocker,
  type FakeDockerOperationKind,
  type SignalRecorder,
  type SignalSource,
  type SpawnRecorder,
  type StatusFileChange,
} from './test-helpers/ci-run.ts'
import { assertNoLeak, BOT_TOKEN_PREFIX, fakeToken, writtenFile } from './test-helpers/credentials.ts'
import { createFakeClock, type FakeClock } from './test-helpers/fake-clock.ts'
import { treeSnapshot } from './test-helpers/tree-snapshot.ts'

// ===========================================================================
// E1 (t1.t6s.te): the RUN_ID, the run directory and the status file; main and
// the runner log; the docker layer's forms; treeSnapshot's option; the fake
// container interface's image rules
// ===========================================================================

describe('E1: ci-run lifecycle', () => {
  /** Test data: a RUN_ID of SR-5.1's form. */
  const RUN_ID = '20261008t120000z-demo0001'
  /** Test data: the runner's PID. */
  const RUNNER_PID = 4242
  /** The runner's start: not a whole second, so rounding down shows. */
  const START_MS = Date.UTC(2026, 9, 8, 12, 0, 0) + 750
  const OWNER: Owner = { runId: RUN_ID, pid: RUNNER_PID }
  const [TEST_ROLE, DRIFT_ROLE, RETAG_ROLE] = RUN_TAG_ROLES
  const MS_PER_MINUTE = 60_000

  let roots: string[] = []
  let recorders: SpawnRecorder[] = []

  afterEach(() => {
    const built = recorders
    recorders = []
    for (const root of roots) rmSync(root, { recursive: true, force: true })
    roots = []
    for (const recorder of built) recorder.assertNoFailures()
  })

  /** A new `mkdtempSync` root, removed in `afterEach`. */
  function newRoot(): string {
    const root = mkdtempSync(join(tmpdir(), 'ci-run-lifecycle-'))
    roots.push(root)
    return root
  }

  /** A spawn recorder on `clock` whose spawns must all be answered, checked in `afterEach`. */
  function newRecorder(clock: FakeClock, root?: string): SpawnRecorder {
    const recorder = createSpawnRecorder({ clock, ...(root === undefined ? {} : { root }) })
    recorders.push(recorder)
    return recorder
  }

  /** A UTC time as an independent formatter writes it, `YYYY-MM-DDTHH:MM:SSZ`, from whole epoch seconds. */
  function utcOfEpochSeconds(epochSeconds: number): string {
    return new Date(epochSeconds * 1000).toISOString().replace(/\.000Z$/, 'Z')
  }

  // -------------------------------------------------------------------------
  // The RUN_ID, the run-directory path and the status file (b.uqm SR-5.1, SR-5.2)
  // -------------------------------------------------------------------------

  describe('the RUN_ID (SR-5.1)', () => {
    test.each([
      ['an ordinary moment', RUN_ID, Date.UTC(2026, 9, 8, 12, 0, 0)],
      ['a leap day', '20240229t235959z-a1b2c3d4', Date.UTC(2024, 1, 29, 23, 59, 59)],
      ['the first second of a year, an all-digit suffix', '20270101t000000z-00000000', Date.UTC(2027, 0, 1, 0, 0, 0)],
      ['an all-letter suffix', '20261231t235959z-abcdefgh', Date.UTC(2026, 11, 31, 23, 59, 59)],
    ])('accepts %s, and its time is the moment it names', (_what, runId, timeMs) => {
      expect(isRunId(runId)).toBe(true)
      expect(runIdTimeMs(runId)).toBe(timeMs)
    })

    test.each([
      ['a day the month does not have', '20260431t120000z-demo0001'],
      ['February 29 of a common year', '20250229t120000z-demo0001'],
      ['day 0', '20261000t120000z-demo0001'],
      ['month 13', '20261308t120000z-demo0001'],
      ['month 0', '20260008t120000z-demo0001'],
      ['hour 24', '20261008t240000z-demo0001'],
      ['minute 60', '20261008t126000z-demo0001'],
      ['second 60', '20261008t120060z-demo0001'],
      ['an uppercase T', '20261008T120000z-demo0001'],
      ['an uppercase Z', '20261008t120000Z-demo0001'],
      ['a suffix one short', '20261008t120000z-demo001'],
      ['a suffix one long', '20261008t120000z-demo00001'],
      ['an uppercase suffix', '20261008t120000z-DEMO0001'],
      ['no t', '20261008120000z-demo0001'],
      ['no z', '20261008t120000-demo0001'],
      ['no hyphen', '20261008t120000zdemo0001'],
      ['a leading space', ` ${RUN_ID}`],
      ['a trailing line feed', `${RUN_ID}\n`],
      ['an empty string', ''],
    ])('refuses %s, which has no time', (_what, value) => {
      expect(isRunId(value)).toBe(false)
      expect(runIdTimeMs(value)).toBeNull()
    })
  })

  describe('the run-directory path (SR-5.1)', () => {
    const NAME = `${RUN_DIR_PREFIX}${RUN_ID}`

    test.each([
      ['TMPDIR set', { TMPDIR: '/constructed/tmp' }, `/constructed/tmp/${NAME}`],
      ['TMPDIR with a trailing slash', { TMPDIR: '/constructed/tmp/' }, `/constructed/tmp/${NAME}`],
      ['TMPDIR with several trailing slashes', { TMPDIR: '/constructed/tmp//' }, `/constructed/tmp/${NAME}`],
      ['TMPDIR the root', { TMPDIR: '/' }, `/${NAME}`],
      ['TMPDIR holding a .. it keeps', { TMPDIR: '/constructed/../tmp' }, `/constructed/../tmp/${NAME}`],
      ['TMPDIR empty', { TMPDIR: '' }, `${DEFAULT_TEMP_DIR}/${NAME}`],
      ['TMPDIR unset', {}, `${DEFAULT_TEMP_DIR}/${NAME}`],
      ['TMP and TEMP set but TMPDIR not', { TMP: '/constructed/a', TEMP: '/constructed/b' }, `${DEFAULT_TEMP_DIR}/${NAME}`],
    ])('%s gives the cscb-ci-<RUN_ID> directory there', (_what, env, expected) => {
      expect(runDirPath(env, RUN_ID)).toBe(expected)
    })

    test('a value that is no RUN_ID never reaches a path', () => {
      expect(() => runDirPath({ TMPDIR: '/constructed/tmp' }, `../${RUN_ID}`)).toThrow()
    })
  })

  describe('the status file (SR-5.2)', () => {
    /** A run directory in a new root's constructed temp directory. */
    function newRunDir(): string {
      return makeRunDir(newRoot(), RUN_ID)
    }

    function statusOf(phase: StatusPhase, kind: RefusalKind = null, details: readonly string[] = []): RunStatus {
      const refusal = phase === 'refused' ? { kind, reason: refusalLine({ kind, summary: 'the refusal summary', details: [] }), details } : undefined
      return makeStatus({ runId: RUN_ID, pid: RUNNER_PID, startMs: START_MS, deadlineMinutes: BUILD_ALLOWANCE_MINUTES, phase, ...(refusal === undefined ? {} : { refusal }) })
    }

    function writtenKeys(runDir: string): { top: string[]; deadline: string[]; refusal: string[] | null } {
      const json = JSON.parse(readFileSync(join(runDir, STATUS_FILE_NAME), 'utf-8')) as Record<string, Record<string, unknown>>
      return {
        top: Object.keys(json),
        deadline: Object.keys(json.deadline),
        refusal: json.refusal === undefined ? null : Object.keys(json.refusal),
      }
    }

    const COMMON_KEYS = ['version', 'runId', 'pid', 'startedAt', 'phase', 'deadline']
    const DEADLINE_KEYS = ['utc', 'epochSeconds', 'minutes']

    test.each(['build', 'shards', 'merge'] as const)('phase %s holds exactly the common keys, no refusal', (phase) => {
      const runDir = newRunDir()
      writeStatus(runDir, statusOf(phase))
      expect(writtenKeys(runDir)).toEqual({ top: COMMON_KEYS, deadline: DEADLINE_KEYS, refusal: null })
      expect(readStatusFile(runDir)?.phase).toBe(phase)
    })

    test.each([null, 'memory', 'disk', 'cpu'] as const)('phase refused of kind %p adds exactly the refusal, its summary without NOT RUN or the kind', (kind) => {
      const runDir = newRunDir()
      writeStatus(runDir, statusOf('refused', kind, ['detail one', 'detail two']))
      expect(writtenKeys(runDir)).toEqual({ top: [...COMMON_KEYS, 'refusal'], deadline: DEADLINE_KEYS, refusal: ['kind', 'summary', 'details'] })
      expect(readStatusFile(runDir)?.refusal).toEqual({ kind, summary: 'the refusal summary', details: ['detail one', 'detail two'] })
    })

    test('startedAt is the start in UTC rounded down to the second; the deadline is the start plus the build allowance', () => {
      const runDir = newRunDir()
      writeStatus(runDir, statusOf('build'))
      const status = readStatusFile(runDir)
      const deadlineSeconds = Math.floor((START_MS + BUILD_ALLOWANCE_MINUTES * MS_PER_MINUTE) / 1000)
      expect(status?.startedAt).toBe('2026-10-08T12:00:00Z')
      expect(status?.deadline).toEqual({ utc: utcOfEpochSeconds(deadlineSeconds), epochSeconds: deadlineSeconds, minutes: BUILD_ALLOWANCE_MINUTES })
    })

    test.each([
      [84.5, 85],
      [138.4, 138],
    ])('a deadline %p minutes from the start holds %p whole minutes and the moment in whole seconds', (minutes, whole) => {
      const deadline = statusDeadline(START_MS, minutes)
      const seconds = Math.floor((START_MS + minutes * MS_PER_MINUTE) / 1000)
      expect(deadline).toEqual({ utc: utcOfEpochSeconds(seconds), epochSeconds: seconds, minutes: whole })
      expect(parseUtcTimeMs(deadline.utc)).toBe(seconds * 1000)
    })

    test('each write replaces the file whole: a new file in its place, no temporary file left', () => {
      const runDir = newRunDir()
      const path = writeStatus(runDir, statusOf('build'))
      const before = statSync(path).ino
      expect(writeStatusFile(runDir, statusOf('shards'))).toEqual({ ok: true })
      expect(statSync(path).ino).not.toBe(before)
      expect(readdirSync(runDir)).toEqual([STATUS_FILE_NAME])
      expect(readStatusFile(runDir)).toEqual(statusOf('shards'))
    })

    test.each([
      ['a status its parser would refuse (PID 0)', (_runDir: string) => ({ ...statusOf('merge'), pid: 0 }) as RunStatus],
      [
        'a temporary-file path that cannot be written',
        (runDir: string) => {
          mkdirSync(join(runDir, atomicTempFileName(STATUS_FILE_NAME)))
          return statusOf('merge')
        },
      ],
    ])('a failed write (%s) leaves the previous file as it was', (_what, prepare) => {
      const runDir = newRunDir()
      const path = writeStatus(runDir, statusOf('build'))
      const before = { text: readFileSync(path, 'utf-8'), ino: statSync(path).ino }
      const result = writeStatusFile(runDir, prepare(runDir))
      expect(result.ok).toBe(false)
      expect({ text: readFileSync(path, 'utf-8'), ino: statSync(path).ino }).toEqual(before)
      expect(readStatusFile(runDir)).toEqual(statusOf('build'))
    })

    const MALFORMED: readonly (readonly [string, () => RunStatus, StatusFileChange])[] = [
      ['unparseable', () => statusOf('build'), { kind: 'unparseable' }],
      ['another version', () => statusOf('build'), { kind: 'version', version: STATUS_FORMAT_VERSION + 1 }],
      ['the version as a string', () => statusOf('build'), { kind: 'version', version: String(STATUS_FORMAT_VERSION) }],
      ['no deadline', () => statusOf('build'), { kind: 'drop-key', key: 'deadline' }],
      ['no startedAt', () => statusOf('build'), { kind: 'drop-key', key: 'startedAt' }],
      ['an extra key', () => statusOf('build'), { kind: 'set-key', key: 'extra', value: 1 }],
      ['an unknown phase', () => statusOf('build'), { kind: 'set-key', key: 'phase', value: 'done' }],
      ['a refusal outside phase refused', () => statusOf('build'), { kind: 'set-key', key: 'refusal', value: buildRefusal(null, 'the refusal summary') }],
      ['phase refused with no refusal', () => statusOf('refused'), { kind: 'drop-key', key: 'refusal' }],
      ['a refusal of an unknown kind', () => statusOf('refused'), { kind: 'set-key', key: 'refusal', value: { kind: 'other', summary: 'x', details: [] } }],
      ['a detail holding a line break', () => statusOf('refused'), { kind: 'set-key', key: 'refusal', value: { kind: null, summary: 'x', details: ['a\nb'] } }],
      ['a runId that is no RUN_ID', () => statusOf('build'), { kind: 'set-key', key: 'runId', value: 'not-a-run-id' }],
      ['PID 0', () => statusOf('build'), { kind: 'set-key', key: 'pid', value: 0 }],
      ['startedAt not a UTC time', () => statusOf('build'), { kind: 'set-key', key: 'startedAt', value: '2026-10-08 12:00:00' }],
      [
        'deadline.utc and epochSeconds naming different moments',
        () => statusOf('build'),
        {
          kind: 'edit',
          what: 'epochSeconds one more',
          edit: (valid) => {
            const json = JSON.parse(valid) as RunStatus
            return `${JSON.stringify({ ...json, deadline: { ...json.deadline, epochSeconds: json.deadline.epochSeconds + 1 } }, null, 2)}\n`
          },
        },
      ],
      ['a deadline with an extra key', () => statusOf('build'), { kind: 'edit', what: 'deadline key added', edit: (valid) => valid.replace('"minutes"', '"seconds": 1,\n    "minutes"') }],
    ]

    test.each(MALFORMED)('a status file with %s counts as no status file', (_what, status, change) => {
      const runDir = newRunDir()
      writeStatus(runDir, status(), change)
      expect(readStatusFile(runDir)).toBeNull()
    })

    test('a missing status file is no status file; one naming another PID is still read, with its PID', () => {
      const runDir = newRunDir()
      expect(readStatusFile(runDir)).toBeNull()
      writeStatus(runDir, statusOf('build'), { kind: 'pid', pid: RUNNER_PID + 1 })
      expect(readStatusFile(runDir)?.pid).toBe(RUNNER_PID + 1)
    })
  })

  // -------------------------------------------------------------------------
  // Main and the runner log (b.uqm SR-5.1, SR-5.3 steps 1–2, SR-5.4, SR-5.8)
  // -------------------------------------------------------------------------

  describe('main and the runner log', () => {
    /** Main's whole world for one case: every dependency a fake that records, or refuses, its use. */
    interface MainRig {
      readonly root: string
      readonly tempDir: string
      readonly lockDir: string
      readonly clock: FakeClock
      readonly recorder: SpawnRecorder
      readonly docker: FakeDocker
      readonly signals: SignalRecorder
      readonly source: SignalSource
      /** Each forbidden dependency that was called, by name. */
      readonly forbiddenCalls: string[]
      /** Each `writeStderr` text, in order. */
      readonly stderr: string[]
      readonly deps: RunnerDeps
    }

    function makeMainRig(options: { readonly clock?: RunnerClock } = {}): MainRig {
      const root = newRoot()
      const tempDir = join(root, 'tmp')
      mkdirSync(tempDir)
      const lockDir = join(root, 'lock')
      const clock = createFakeClock({ start: START_MS })
      const recorder = newRecorder(clock)
      const docker = createFakeDocker(recorder)
      const signals = createSignalRecorder({ processes: recorder.processes, clock })
      const source = createSignalSource({ clock })
      const forbiddenCalls: string[] = []
      const stderr: string[] = []
      const forbidden =
        (name: string) =>
        (): never => {
          forbiddenCalls.push(name)
          throw new Error(`${name} must not be called`)
        }
      const deps: RunnerDeps = {
        spawn: recorder.spawn,
        env: { TMPDIR: tempDir, ANTHROPIC_API_KEY: fakeToken(RAW_KEY_PREFIX, 'raw'), GH_TOKEN: fakeToken('', 'gh') },
        pid: RUNNER_PID,
        uid: 1000,
        worktreeRoot: buildWorktree(root).root,
        lockDir,
        readPasswordFile: forbidden('readPasswordFile'),
        readCgroupFile: forbidden('readCgroupFile'),
        readProcCmdline: forbidden('readProcCmdline'),
        readProcCwd: forbidden('readProcCwd'),
        readProcCgroup: forbidden('readProcCgroup'),
        readVolume: forbidden('readVolume'),
        clock: options.clock ?? clock,
        randomBytes: forbidden('randomBytes'),
        sendSignal: signals.sendSignal,
        onSignal: source.onSignal,
        isPidAlive: forbidden('isPidAlive'),
        writeStderr: (text) => {
          stderr.push(text)
        },
      }
      return { root, tempDir, lockDir, clock, recorder, docker, signals, source, forbiddenCalls, stderr, deps }
    }

    /** What a case must find untouched: no spawn, no docker operation, no signal sent or trapped, no forbidden dependency, no lock directory. */
    function expectNothingElseTouched(rig: MainRig): void {
      expect(rig.recorder.spawns()).toEqual([])
      expect(rig.docker.operations()).toEqual([])
      expect(rig.signals.signals()).toEqual([])
      expect(rig.source.handlerCount()).toBe(0)
      expect(rig.forbiddenCalls).toEqual([])
      expect(existsSync(rig.lockDir)).toBe(false)
    }

    function logLines(runDir: string): string[] {
      const text = readFileSync(join(runDir, RUNNER_LOG_FILE_NAME), 'utf-8')
      expect(text.endsWith('\n')).toBe(true)
      return text.slice(0, -1).split('\n')
    }

    test.each([
      ['no argument', [] as string[]],
      ['a first argument that is no RUN_ID', ['not-a-run-id', '--shards', '2']],
      ['a RUN_ID with an uppercase marker', ['20261008T120000Z-demo0001']],
      ['an empty first argument', ['']],
    ])('%s exits 64 with one usage line naming it, and creates nothing', async (_what, argv) => {
      const rig = makeMainRig()
      const before = treeSnapshot(rig.root, { extended: true })
      expect(await main(argv, rig.deps)).toBe(USAGE_EXIT_STATUS)
      expect(rig.stderr).toEqual([`${usageLine(argv[0])}\n`])
      expect(rig.stderr[0]?.startsWith(USAGE_PREFIX)).toBe(true)
      if (argv[0] !== undefined && argv[0] !== '') expect(rig.stderr[0]).toContain(argv[0])
      expect(treeSnapshot(rig.root, { extended: true })).toEqual(before)
      expectNothingElseTouched(rig)
      assertNoLeak({ stderr: rig.stderr, tempDir: writtenFile(rig.tempDir) })
    })

    test.each([
      ['a directory', (rig: MainRig) => void makeRunDir(rig.tempDir, RUN_ID)],
      ['a file', (rig: MainRig) => writeFileSync(runDirIn(rig.tempDir, RUN_ID), 'not a run directory\n')],
      ['a dangling symlink', (rig: MainRig) => symlinkSync(join(rig.root, 'nowhere'), runDirIn(rig.tempDir, RUN_ID))],
      [
        'a symlink to a directory',
        (rig: MainRig) => {
          mkdirSync(join(rig.root, 'elsewhere'))
          symlinkSync(join(rig.root, 'elsewhere'), runDirIn(rig.tempDir, RUN_ID))
        },
      ],
    ])('%s already at the run directory path exits 1 with one line naming the path, writing nothing', async (_what, place) => {
      const rig = makeMainRig()
      place(rig)
      const runDir = runDirPath(rig.deps.env, RUN_ID)
      const before = treeSnapshot(rig.root, { extended: true })
      expect(await main([RUN_ID, '--shards', '2'], rig.deps)).toBe(FAILURE_EXIT_STATUS)
      expect(rig.stderr).toEqual([`${existingPathLine(runDir)}\n`])
      expect(rig.stderr[0]).toContain(runDir)
      expect(treeSnapshot(rig.root, { extended: true })).toEqual(before)
      expectNothingElseTouched(rig)
      // Nothing was written (the snapshot is unchanged), so standard error is all there is to check;
      // `writtenFile` follows links and cannot take the dangling one.
      assertNoLeak({ stderr: rig.stderr })
    })

    test('--shards 7: step 1 runs before validation, then the refusal is recorded as the run\'s last act', async () => {
      const rig = makeMainRig()
      const args = ['--shards', '7']
      const runDir = runDirPath(rig.deps.env, RUN_ID)
      const seen: { atStepOneEnd?: { status: RunStatus | null; log: string[] } } = {}
      const status = await main([RUN_ID, ...args], rig.deps, {
        onRunLog: () => {
          seen.atStepOneEnd = { status: readStatusFile(runDir), log: logLines(runDir) }
        },
      })
      expect(status).toBe(REFUSAL_EXIT_STATUS)

      // Step 1, before any validation: the run directory, the status file in phase build, the log's first line.
      const basis = { runId: RUN_ID, pid: RUNNER_PID, startMs: START_MS, deadline: statusDeadline(START_MS, BUILD_ALLOWANCE_MINUTES) }
      const firstLine = formatRunnerLogFirstLine(RUN_ID, RUNNER_PID, args)
      expect(seen.atStepOneEnd).toEqual({ status: buildStatus(basis, 'build'), log: [firstLine] })

      // The directory: in the constructed temp directory, mode 0700, holding only the status file and the log.
      expect(dirname(runDir)).toBe(rig.tempDir)
      expect(lstatSync(runDir).isDirectory()).toBe(true)
      expect(lstatSync(runDir).mode & 0o7777).toBe(RUN_DIR_MODE)
      expect(readdirSync(runDir).sort()).toEqual([RUNNER_LOG_FILE_NAME, STATUS_FILE_NAME].sort())

      // The refusal: phase refused, kind null, SR-2.2's summary, no details; its NOT RUN line in the log.
      const refusal = buildRefusal(null, outOfRangeReason('--shards', '7'))
      expect(readStatusFile(runDir)).toEqual(buildRefusedStatus(basis, refusal))
      expect(readStatusFile(runDir)?.refusal).toEqual({ kind: null, summary: outOfRangeReason('--shards', '7'), details: [] })
      expect(logLines(runDir)).toEqual([firstLine, refusalLine(refusal)])
      expect(rig.stderr).toEqual([])

      // Nothing changes after the refusal: no timer left, and time passing writes nothing.
      const after = treeSnapshot(rig.tempDir, { extended: true })
      expect(rig.clock.pendingCount()).toBe(0)
      await rig.clock.advance(BUILD_ALLOWANCE_MINUTES * MS_PER_MINUTE)
      expect(treeSnapshot(rig.tempDir, { extended: true })).toEqual(after)
      expectNothingElseTouched(rig)
      assertNoLeak({ stderr: rig.stderr, runDir: writtenFile(runDir) })
    })

    test('recordRefusal writes every log line while the status file is still in phase build, and replaces it with phase refused last', () => {
      const rig = makeMainRig()
      const runDir = runDirPath(rig.deps.env, RUN_ID)
      mkdirSync(runDir)
      const inner = createRunnerLog(join(runDir, RUNNER_LOG_FILE_NAME))
      // Each log call, of any kind, records the status file's phase as it stands at that call.
      const phaseAtEachLogCall: (StatusPhase | null)[] = []
      const phaseNow = (): StatusPhase | null => readStatusFile(runDir)?.phase ?? null
      const log: RunnerLogWriter = Object.assign(
        (line: string) => {
          phaseAtEachLogCall.push(phaseNow())
          inner(line)
        },
        {
          path: inner.path,
          childOutput: (text: string) => {
            phaseAtEachLogCall.push(phaseNow())
            inner.childOutput(text)
          },
          error: (err: unknown, context?: string) => {
            phaseAtEachLogCall.push(phaseNow())
            inner.error(err, context)
          },
          redactValues: (values: Iterable<string>) => inner.redactValues(values),
        },
      )
      const args = ['--shards', '7']
      const run = beginRun(rig.deps, RUN_ID, runDir, args, log)
      const refusal = buildRefusal('memory', 'the refusal summary', ['detail one', 'detail two'])

      expect(recordRefusal(run, refusal)).toBe(REFUSAL_EXIT_STATUS)
      // beginRun's first line, then the NOT RUN line and each detail: every one written with the status file in phase build.
      expect(phaseAtEachLogCall).toEqual(['build', 'build', 'build', 'build'])
      expect(logLines(runDir)).toEqual([formatRunnerLogFirstLine(RUN_ID, RUNNER_PID, args), refusalLine(refusal), 'detail one', 'detail two'])
      expect(readStatusFile(runDir)).toEqual(buildRefusedStatus(run.basis, refusal))
      expect(readStatusFile(runDir)?.phase).toBe('refused')
      expectNothingElseTouched(rig)
    })

    test.each([
      ['no arguments', [] as string[]],
      ['option words', ['--shards', '7']],
      ['spaces and quotes', ['--shards', '7', 'two words', "it's", '"quoted"', `a'b"c`]],
      ['an empty argument and shell characters', ['', '$HOME', '*', 'a;b', '`x`']],
      ['control characters', ['tab\there', 'line\nbreak', 'back\\slash']],
    ])('the log\'s first line names the RUN_ID, the PID and the /ci arguments as given (%s), and reads back exactly', async (_what, args) => {
      const rig = makeMainRig()
      await main([RUN_ID, ...args], rig.deps)
      const runDir = runDirPath(rig.deps.env, RUN_ID)
      expect(logLines(runDir)[0]).toBe(formatRunnerLogFirstLine(RUN_ID, RUNNER_PID, args))
      expect(readRunnerLogFirstLine(runDir)).toEqual({ runId: RUN_ID, pid: RUNNER_PID, args })
      expectNothingElseTouched(rig)
      assertNoLeak({ stderr: rig.stderr, runDir: writtenFile(runDir) })
    })

    test('a dependency that throws once the run directory exists is written to the runner log before main returns 1', async () => {
      const clock = createFakeClock({ start: START_MS })
      const throwingClock: RunnerClock = {
        now: () => {
          throw new Error('fake clock failure')
        },
        setTimeout: (callback, delayMs) => clock.setTimeout(callback, delayMs),
        clearTimeout: (handle) => clock.clearTimeout(handle),
      }
      const rig = makeMainRig({ clock: throwingClock })
      const args = ['--shards', '2']
      expect(await main([RUN_ID, ...args], rig.deps)).toBe(FAILURE_EXIT_STATUS)
      const runDir = runDirPath(rig.deps.env, RUN_ID)
      const [first, error, ...frames] = logLines(runDir)
      expect(first).toBe(formatRunnerLogFirstLine(RUN_ID, RUNNER_PID, args))
      expect(error).toBe('error: Error: fake clock failure')
      expect(frames.length).toBeGreaterThan(0)
      for (const frame of frames) expect(frame).toMatch(/^\s+at /)
      expect(rig.stderr).toEqual([])
      expectNothingElseTouched(rig)
      assertNoLeak({ stderr: rig.stderr, runDir: writtenFile(runDir) })
    })

    test.each([
      ['no arguments', [] as string[]],
      ['--shards 2', ['--shards', '2']],
    ])('a valid invocation (%s) on a valid tree stops after validation: one error line, exit 1, nothing spawned, signalled or locked', async (_what, args) => {
      const rig = makeMainRig()
      expect(await main([RUN_ID, ...args], rig.deps)).toBe(FAILURE_EXIT_STATUS)
      const runDir = runDirPath(rig.deps.env, RUN_ID)
      expect(logLines(runDir)).toEqual([formatRunnerLogFirstLine(RUN_ID, RUNNER_PID, args), `error: ${STOPPED_AFTER_VALIDATION_TEXT}`])
      expect(readdirSync(runDir).sort()).toEqual([RUNNER_LOG_FILE_NAME, STATUS_FILE_NAME].sort())
      expect(readStatusFile(runDir)?.phase).toBe('build')
      expect(rig.stderr).toEqual([])
      expectNothingElseTouched(rig)
      assertNoLeak({ stderr: rig.stderr, runDir: writtenFile(runDir) })
    })

    test('redaction is off until switched on; then every line, child output included, has each value replaced whole', () => {
      const runDir = makeRunDir(newRoot(), RUN_ID)
      const log = createRunnerLog(join(runDir, RUNNER_LOG_FILE_NAME))
      const short = fakeToken(BOT_TOKEN_PREFIX, 'short')
      const long = `${short}-longer`
      log(`before the switch: ${short}`)
      log.redactValues([short, long, ''])
      log(`a line with ${short} and ${long}`)
      log.childOutput(`child output ${long}\nchild error ${short}\n`)
      log.error(new Error(`failed with ${short}`), 'a step')
      const [before, ...after] = logLines(runDir)
      expect(before).toBe(`before the switch: ${short}`)
      expect(after.slice(0, 4)).toEqual([
        `a line with ${REDACTION_PLACEHOLDER} and ${REDACTION_PLACEHOLDER}`,
        `child output ${REDACTION_PLACEHOLDER}`,
        `child error ${REDACTION_PLACEHOLDER}`,
        `error: a step: Error: failed with ${REDACTION_PLACEHOLDER}`,
      ])
      for (const line of after.slice(4)) expect(line).toMatch(/^\s+at /)
      assertNoLeak({ after })
    })
  })

  // -------------------------------------------------------------------------
  // The docker command layer's fixed forms (contributing to b.uqm SR-10.4)
  // -------------------------------------------------------------------------

  /** The docker layer over the spawn recorder and the fake container interface. */
  interface DockerRig {
    readonly root: string
    readonly clock: FakeClock
    readonly recorder: SpawnRecorder
    readonly fake: FakeDocker
    readonly signals: SignalRecorder
    readonly ctx: DockerContext
  }

  function makeDockerRig(): DockerRig {
    const root = newRoot()
    const clock = createFakeClock({ start: START_MS })
    const recorder = newRecorder(clock, root)
    const fake = createFakeDocker(recorder)
    const signals = createSignalRecorder({ processes: recorder.processes, clock })
    return { root, clock, recorder, fake, signals, ctx: { spawn: recorder.spawn, env: {}, cwd: root } }
  }

  const runTag = (role: (typeof RUN_TAG_ROLES)[number], owner: Owner = OWNER): string => formatRunTag(owner, role)
  const OTHER_OWNER: Owner = { runId: '20261007t090000z-other001', pid: 777 }
  /** OWNER's text as b.uqm's Terms write it, `<RUN_ID>-<PID>`, typed from the test data rather than formatted by the runner. */
  const OWNER_TEXT = `${RUN_ID}-${RUNNER_PID}`

  describe('the docker layer (one fixed form per operation)', () => {
    /** The `--format` template of each recorded argument list that has one. */
    function recordedFormats(argvs: readonly (readonly string[])[]): string[] {
      return argvs.flatMap((argv) => {
        const at = argv.indexOf('--format')
        return at < 0 ? [] : [argv[at + 1]!]
      })
    }

    /**
     * What a Go template writes out, read by the test itself rather than the
     * runner: each `json` action's operand and each lone `{{<selector>}}`, a
     * `$m.Field` inside `{{range $i, $m := .X}}` read as `.X[].Field`.
     */
    function templateOutputs(format: string): string[] {
      const rangeOf = new Map<string, string>()
      const outputs: string[] = []
      for (const match of format.matchAll(/\{\{(.*?)\}\}/g)) {
        const action = match[1]!.trim()
        const words = action.split(/\s+/)
        const range = /^range (?:\$\w+, )?(\$\w+) := (\.\S+)$/.exec(action)
        if (range !== null) rangeOf.set(range[1]!, `${range[2]}[]`)
        else if (words[0] === 'json') outputs.push(words.slice(1).join(' ').replace(/^\$\w+(?=\.|$)/, (name) => rangeOf.get(name) ?? name))
        else if (words.length === 1 && /^[.$]/.test(words[0]!)) outputs.push(words[0]!)
      }
      return outputs
    }

    /** Selectors that write a whole object, environment and all, rather than chosen fields. */
    const WHOLE_OBJECTS = ['.', '$', '.Config', '.HostConfig', '.State', '.NetworkSettings', '.Mounts', '.Mounts[]', '.GraphDriver', '.ContainerConfig', '.Metadata', '.RootFS']

    /**
     * One operation: its setup and call, checking its answer; answers the
     * argument lists it must spawn, the fake's operation kinds, and its own
     * values (typed from its inputs and the SRD, not from a builder) that the
     * recorded lists must hold as whole arguments.
     */
    interface DockerRow {
      readonly name: string
      readonly build?: boolean
      readonly run: (rig: DockerRig) => Promise<{
        readonly argvs: readonly (readonly string[])[]
        readonly kinds: readonly FakeDockerOperationKind[]
        readonly values: readonly string[]
      }>
    }

    const ROWS: DockerRow[] = [
      {
        name: 'the docker-answers check',
        run: async ({ fake, ctx }) => {
          fake.setServerVersion('1.2.3')
          expect(await checkDockerAnswers(ctx)).toEqual({ ok: true, value: '1.2.3' })
          return { argvs: [dockerAnswersArgs()], kinds: ['version'], values: ['version'] }
        },
      },
      {
        name: 'the container list, stopped containers and label values included',
        run: async ({ fake, ctx }) => {
          const running = fake.addContainer({ name: 'running-one', labels: { [OWNER_LABEL]: formatOwner(OWNER) } })
          const stopped = fake.addContainer({ name: 'stopped-one', running: false, labels: { [OWNER_LABEL]: formatOwner(OTHER_OWNER) } })
          const answer = await listContainers(ctx)
          expect(answer.ok && answer.value.map((c) => [c.id, c.name, c.running, c.labels[OWNER_LABEL]])).toEqual([
            [running, 'running-one', true, formatOwner(OWNER)],
            [stopped, 'stopped-one', false, formatOwner(OTHER_OWNER)],
          ])
          // `--all`: the sweep needs stopped containers too (SR-6.4).
          return { argvs: [containerListArgs(), containerStateInspectArgs([running, stopped])], kinds: ['container-list', 'container-state'], values: ['--all', running, stopped] }
        },
      },
      {
        name: 'the state inspect: State.Pid, State.OOMKilled, the exit code and the cap',
        run: async ({ fake, ctx }) => {
          // A cap no runner constant has, so the answer can only come from the container.
          const capBytes = 3 * 2 ** 30
          const id = fake.addContainer({ name: 'shard-1', memoryBytes: capBytes, labels: { k: 'v' } })
          const answer = await inspectContainerState(ctx, 'shard-1')
          expect(answer).toEqual({
            ok: true,
            value: { id, name: 'shard-1', status: 'running', running: true, pid: fake.container(id)!.pid, oomKilled: false, exitCode: 0, memoryCapBytes: capBytes, labels: { k: 'v' } },
          })
          return { argvs: [containerStateInspectArgs(['shard-1'])], kinds: ['container-state'], values: ['shard-1'] }
        },
      },
      {
        name: 'the inspection form',
        run: async ({ fake, ctx }) => {
          fake.addContainer({ name: 'shard-1', labels: { k: 'v' }, inspection: { networkMode: 'none', pidsLimit: 64 } })
          const answer = await readContainerInspection(ctx, 'shard-1')
          expect(answer.ok && [answer.value.name, answer.value.networkMode, answer.value.pidsLimit, answer.value.labels]).toEqual(['shard-1', 'none', 64, { k: 'v' }])
          return { argvs: [containerInspectionArgs('shard-1')], kinds: ['container-inspection'], values: ['shard-1'] }
        },
      },
      {
        name: 'create',
        run: async ({ fake, ctx }) => {
          fake.addImage({ tags: [runTag(TEST_ROLE)] })
          const labels = { [OWNER_LABEL]: formatOwner(OWNER), k: 'v' }
          const answer = await createContainer(ctx, 'read-back', labels, runTag(TEST_ROLE))
          expect(answer).toEqual({ ok: true, value: fake.container('read-back')!.id })
          expect(fake.container('read-back')?.running).toBe(false)
          return {
            argvs: [containerCreateArgs('read-back', labels, runTag(TEST_ROLE))],
            kinds: ['container-create'],
            values: ['read-back', `${OWNER_LABEL}=${OWNER_TEXT}`, 'k=v', runTag(TEST_ROLE)],
          }
        },
      },
      {
        name: 'copy-out as an archive',
        run: async ({ fake, ctx }) => {
          const archive = buildTarArchive({ 'out.txt': 'copied\n' })
          fake.addContainer({ name: 'read-back', running: false, archives: { '/out': archive } })
          expect(await copyOutOfContainer(ctx, 'read-back', '/out')).toEqual({ ok: true, value: archive })
          return { argvs: [containerCopyOutArgs('read-back', '/out')], kinds: ['container-copy'], values: ['read-back:/out', '-'] }
        },
      },
      {
        name: 'kill with its signal',
        run: async ({ fake, ctx }) => {
          fake.addContainer({ name: 'shard-1' })
          expect(await killContainer(ctx, 'shard-1', 'SIGKILL')).toEqual({ ok: true, value: null })
          expect(fake.container('shard-1')?.running).toBe(false)
          return { argvs: [containerKillArgs('shard-1', 'SIGKILL')], kinds: ['container-kill'], values: ['shard-1', 'SIGKILL'] }
        },
      },
      {
        name: 'logs',
        run: async ({ fake, ctx }) => {
          fake.addContainer({ name: 'shard-1', logs: { stdout: 'out line\n', stderr: 'err line\n' } })
          expect(await readContainerLogs(ctx, 'shard-1')).toEqual({ ok: true, value: 'out line\nerr line\n' })
          return { argvs: [containerLogsArgs('shard-1')], kinds: ['container-logs'], values: ['shard-1'] }
        },
      },
      {
        name: 'remove',
        run: async ({ fake, ctx }) => {
          fake.addContainer({ name: 'shard-1', running: false })
          expect(await removeContainer(ctx, 'shard-1')).toEqual({ ok: true, value: null })
          expect(fake.container('shard-1')).toBeNull()
          return { argvs: [containerRemoveArgs('shard-1')], kinds: ['container-remove'], values: ['shard-1'] }
        },
      },
      {
        name: 'docker run',
        run: async ({ fake, ctx }) => {
          fake.addImage({ tags: [runTag(TEST_ROLE)] })
          const runArguments = ['--name', 'shard-1', runTag(TEST_ROLE), 'true']
          const outcome = await runContainer(ctx, runArguments, () => ({ ok: true }), () => undefined)
          expect(outcome).toEqual({ kind: 'started', containerId: fake.container('shard-1')!.id })
          return { argvs: [containerRunArgs(runArguments)], kinds: ['container-run'], values: runArguments }
        },
      },
      {
        name: 'the one-name image inspect',
        run: async ({ fake, ctx }) => {
          const labels = { [OWNER_LABEL]: formatOwner(OWNER) }
          const id = fake.addImage({ tags: [runTag(TEST_ROLE)], labels })
          expect(await inspectImage(ctx, runTag(TEST_ROLE))).toEqual({ ok: true, value: { id, tags: [runTag(TEST_ROLE)], labels } })
          return { argvs: [imageInspectArgs([runTag(TEST_ROLE)])], kinds: ['image-inspect'], values: [runTag(TEST_ROLE)] }
        },
      },
      {
        name: 'the image list filtered on the owner label: tags and owner-label values',
        run: async ({ fake, ctx }) => {
          const tagged = fake.addImage({ tags: [runTag(TEST_ROLE)], labels: { [OWNER_LABEL]: formatOwner(OWNER) } })
          const other = fake.addImage({ labels: { [OWNER_LABEL]: formatOwner(OTHER_OWNER) } })
          fake.addImage({ tags: ['unlabelled:latest'] })
          const filters: ImageListFilter[] = [{ kind: 'label', key: OWNER_LABEL, value: null }]
          expect(await listImages(ctx, filters)).toEqual({
            ok: true,
            value: [
              { id: tagged, tags: [runTag(TEST_ROLE)], ownerLabel: formatOwner(OWNER) },
              { id: other, tags: [], ownerLabel: formatOwner(OTHER_OWNER) },
            ],
          })
          return { argvs: [imageListArgs(filters), imageInspectArgs([tagged, other])], kinds: ['image-list', 'image-inspect'], values: [`label=${OWNER_LABEL}`, tagged, other] }
        },
      },
      {
        name: 'the image list of one owner\'s untagged images',
        run: async ({ fake, ctx }) => {
          fake.addImage({ tags: [runTag(TEST_ROLE)], labels: { [OWNER_LABEL]: formatOwner(OWNER) } })
          const untagged = fake.addImage({ labels: { [OWNER_LABEL]: formatOwner(OWNER) } })
          fake.addImage({ labels: { [OWNER_LABEL]: formatOwner(OTHER_OWNER) } })
          const filters: ImageListFilter[] = [{ kind: 'dangling' }, { kind: 'label', key: OWNER_LABEL, value: formatOwner(OWNER) }]
          expect(await listImages(ctx, filters)).toEqual({ ok: true, value: [{ id: untagged, tags: [], ownerLabel: formatOwner(OWNER) }] })
          return {
            argvs: [imageListArgs(filters), imageInspectArgs([untagged])],
            kinds: ['image-list', 'image-inspect'],
            values: ['dangling=true', `label=${OWNER_LABEL}=${OWNER_TEXT}`, untagged],
          }
        },
      },
      {
        name: 'tag removal by name',
        run: async ({ fake, ctx }) => {
          fake.addImage({ tags: [runTag(TEST_ROLE), runTag(DRIFT_ROLE)] })
          expect(await removeImageTag(ctx, runTag(DRIFT_ROLE))).toEqual({ ok: true, value: null })
          expect(fake.image(runTag(TEST_ROLE))?.tags).toEqual([runTag(TEST_ROLE)])
          return { argvs: [imageTagRemovalArgs(runTag(DRIFT_ROLE))], kinds: ['image-remove'], values: [runTag(DRIFT_ROLE)] }
        },
      },
      {
        name: 'tag',
        run: async ({ fake, ctx }) => {
          const id = fake.addImage({ tags: [runTag(TEST_ROLE)] })
          expect(await tagImage(ctx, id, runTag(RETAG_ROLE))).toEqual({ ok: true, value: null })
          expect(fake.image(runTag(RETAG_ROLE))?.id).toBe(id)
          return { argvs: [imageTagArgs(id, runTag(RETAG_ROLE))], kinds: ['image-tag'], values: [id, runTag(RETAG_ROLE)] }
        },
      },
      {
        name: 'the test-image build',
        build: true,
        run: async ({ fake, ctx, signals }) => {
          const spec: TestImageBuildSpec = { dockerfilePath: TEST_DOCKERFILE_PATH, contextDir: '.', labels: { [OWNER_LABEL]: formatOwner(OWNER) }, tag: runTag(TEST_ROLE) }
          const lines: string[] = []
          const build = startTestImageBuild(ctx, signals.sendSignal, spec, (line) => lines.push(line))
          expect(await build.result).toEqual({ kind: 'built', imageId: fake.image(runTag(TEST_ROLE))!.id })
          expect(lines.length).toBeGreaterThan(0)
          return { argvs: [testImageBuildArgs(spec)], kinds: ['image-build'], values: [TEST_DOCKERFILE_PATH, `${OWNER_LABEL}=${OWNER_TEXT}`, runTag(TEST_ROLE), '.'] }
        },
      },
      {
        name: 'the derived-image build from standard input',
        build: true,
        run: async ({ fake, ctx, signals, recorder }) => {
          fake.addImage({ tags: [runTag(TEST_ROLE)] })
          const spec: DerivedImageBuildSpec = { from: runTag(TEST_ROLE), labels: { k: 'drift' }, tag: runTag(DRIFT_ROLE) }
          const build = startDerivedImageBuild(ctx, signals.sendSignal, spec, () => undefined)
          expect(await build.result).toEqual({ kind: 'built', imageId: fake.image(runTag(DRIFT_ROLE))!.id })
          expect(recorder.spawns()[0]?.stdin).toBe(derivedImageDockerfile(spec))
          return { argvs: [derivedImageBuildArgs(spec)], kinds: ['image-build'], values: ['k=drift', runTag(DRIFT_ROLE), '-'] }
        },
      },
      {
        name: 'the owner-filtered prune',
        run: async ({ fake, ctx }) => {
          const untagged = fake.addImage({ labels: { [OWNER_LABEL]: formatOwner(OWNER) } })
          expect(await pruneUntaggedImages(ctx, formatOwner(OWNER))).toEqual({ kind: 'done' })
          expect(fake.image(untagged)).toBeNull()
          return { argvs: [imagePruneArgs(formatOwner(OWNER))], kinds: ['image-prune'], values: [`label=${OWNER_LABEL}=${OWNER_TEXT}`] }
        },
      },
    ]

    test.each(ROWS)('$name: spawns exactly its form, holding its own values, which the fake answers', async (row) => {
      const rig = makeDockerRig()
      const { argvs, kinds, values } = await row.run(rig)
      const recorded = rig.recorder.argvs()
      expect(recorded).toEqual(argvs)
      // The row's own values, typed apart from the builders, each a whole argument of a recorded list.
      expect(recorded.flat()).toEqual(expect.arrayContaining([...values]))
      expect(rig.fake.operations().map((op) => [op.kind, op.exitCode])).toEqual(kinds.map((kind) => [kind, 0]))
      // Only the builds start in a process group of their own.
      expect(rig.recorder.spawns().map((spawn) => spawn.ownProcessGroup)).toEqual(argvs.map(() => row.build === true))
      // No list names an environment field, and no format writes a whole object (which would carry the environment).
      for (const argv of recorded) expect(argv.join(' ')).not.toMatch(/\.Env\b|\bEnv\b/)
      for (const format of recordedFormats(recorded)) {
        const outputs = templateOutputs(format)
        expect(outputs.length).toBeGreaterThan(0)
        expect(outputs.filter((output) => WHOLE_OBJECTS.includes(output) || /^\$\w*$/.test(output))).toEqual([])
      }
    })

    test('the container list holds --all, so it lists stopped containers too (SR-6.4)', async () => {
      const rig = makeDockerRig()
      expect(await listContainers(rig.ctx)).toEqual({ ok: true, value: [] })
      const [list] = rig.recorder.argvs()
      expect(list?.slice(0, 3)).toEqual(['docker', 'container', 'ls'])
      expect(list).toContain('--all')
    })

    test('the state form selects State.Pid, State.OOMKilled, State.ExitCode and HostConfig.Memory (SR-10.6)', async () => {
      const rig = makeDockerRig()
      rig.fake.addContainer({ name: 'shard-1' })
      expect((await inspectContainerState(rig.ctx, 'shard-1')).ok).toBe(true)
      const formats = recordedFormats(rig.recorder.argvs())
      expect(formats).toHaveLength(1)
      expect(templateOutputs(formats[0]!)).toEqual(expect.arrayContaining(['.State.Pid', '.State.OOMKilled', '.State.ExitCode', '.HostConfig.Memory']))
    })

    test('the inspection form selects exactly SR-10.5\'s fields', async () => {
      const rig = makeDockerRig()
      rig.fake.addContainer({ name: 'shard-1' })
      expect((await readContainerInspection(rig.ctx, 'shard-1')).ok).toBe(true)
      const formats = recordedFormats(rig.recorder.argvs())
      expect(formats).toHaveLength(1)
      const sr105 = [
        '.Name', // name
        '.Image', // image ID
        '.Mounts[].Source', // mounts: source,
        '.Mounts[].Destination', // target,
        '.Mounts[].RW', // read-only
        '.HostConfig.NetworkMode', // network mode
        '.HostConfig.PidMode', // PID mode
        '.HostConfig.IpcMode', // IPC mode
        '.HostConfig.Privileged', // privileged flag
        '.HostConfig.Memory', // memory limit
        '.HostConfig.MemorySwap', // memory-swap limit
        '.HostConfig.PidsLimit', // PID limit
        '.HostConfig.NanoCpus', // CPU limit
        '.Config.Labels', // labels
        '.HostConfig.AutoRemove', // the self-removal setting
      ]
      expect([...templateOutputs(formats[0]!)].sort()).toEqual([...sr105].sort())
    })

    test.each([
      ['an image ID', `sha256:${'ab'.repeat(32)}`],
      ['a digest', `${RUN_TAG_REPOSITORY}@sha256:${'ab'.repeat(32)}`],
      ['a foreign tag', 'cscb-ci:latest'],
      ['another repository\'s tag of the run-private shape', `cscb-ci-l4:${formatOwner(OWNER)}-${TEST_ROLE}`],
      ['a run-private tag of an unknown role', `${RUN_TAG_REPOSITORY}:${formatOwner(OWNER)}-other`],
    ])('tag removal refuses %s and spawns nothing', async (_what, argument) => {
      const rig = makeDockerRig()
      expect(() => imageTagRemovalArgs(argument)).toThrow()
      const answer = await removeImageTag(rig.ctx, argument)
      expect(answer.ok).toBe(false)
      expect(!answer.ok && answer.exitCode).toBeNull()
      expect(rig.recorder.spawns()).toEqual([])
    })

    test('a removal is never forced, and the prune holds exactly one owner-label filter and no -a', () => {
      const removal = imageTagRemovalArgs(runTag(TEST_ROLE))
      const prune = imagePruneArgs(formatOwner(OWNER))
      expect(removal.filter((arg) => arg.startsWith('-'))).toEqual([])
      expect(prune.filter((arg) => arg.includes(OWNER_LABEL))).toEqual([`label=${ownerLabel(OWNER)}`])
      expect(prune).not.toContain('-a')
      expect(prune).not.toContain('--all')
    })

    test('a docker run list is checked, then logged as one line equal to it, then spawned', async () => {
      const rig = makeDockerRig()
      rig.fake.addImage({ tags: [runTag(TEST_ROLE)] })
      const runDir = makeRunDir(rig.root, RUN_ID)
      const log = createRunnerLog(join(runDir, RUNNER_LOG_FILE_NAME))
      const events: string[] = []
      const runArguments = ['--name', 'shard-1', runTag(TEST_ROLE), 'true']
      const checked: (readonly string[])[] = []
      const outcome = await runContainer(
        rig.ctx,
        runArguments,
        (argv) => {
          checked.push(argv)
          events.push(`check with ${rig.recorder.spawns().length} spawned`)
          return { ok: true }
        },
        (line) => {
          events.push(`log with ${rig.recorder.spawns().length} spawned`)
          log(line)
        },
      )
      expect(outcome.kind).toBe('started')
      expect(events).toEqual(['check with 0 spawned', 'log with 0 spawned'])
      const spawned = rig.recorder.argvs()
      expect(checked).toEqual([containerRunArgs(runArguments)])
      expect(spawned).toEqual([containerRunArgs(runArguments)])
      const lines = readFileSync(join(runDir, RUNNER_LOG_FILE_NAME), 'utf-8').split('\n').filter((line) => line !== '')
      expect(lines).toEqual([dockerRunLogLine(spawned[0]!)])
      expect(JSON.parse(lines[0]!.slice(DOCKER_RUN_LOG_PREFIX.length))).toEqual(spawned[0])
    })

    test.each([
      ['refuses it', () => ({ ok: false as const, reason: 'the list holds a secret value' }), 'the list holds a secret value'],
      [
        'throws',
        () => {
          throw new Error('check broke')
        },
        null,
      ],
    ])('a docker run list whose check %s is neither logged nor spawned', async (_what, check, reason) => {
      const rig = makeDockerRig()
      const logged: string[] = []
      const outcome = await runContainer(rig.ctx, ['--name', 'shard-1', 'image', 'true'], check, (line) => logged.push(line))
      expect(outcome.kind).toBe('refused')
      if (reason !== null) expect(outcome).toEqual({ kind: 'refused', reason })
      expect(logged).toEqual([])
      expect(rig.recorder.spawns()).toEqual([])
    })

    test('ending a build sends SIGKILL to its own group once; after it settles, end() signals nothing and answers no-such-process', async () => {
      const rig = makeDockerRig()
      const spec: TestImageBuildSpec = { dockerfilePath: TEST_DOCKERFILE_PATH, contextDir: '.', labels: {}, tag: runTag(TEST_ROLE) }
      rig.fake.programBuild({ kind: 'hangs' }, { role: TEST_ROLE })
      const hanging = startTestImageBuild(rig.ctx, rig.signals.sendSignal, spec, () => undefined)
      expect(hanging.processGroup).toBe(hanging.pid)
      expect(hanging.processGroup).toBe(rig.recorder.spawns()[0]!.processGroup)
      expect(hanging.end()).toBe('delivered')
      expect(await hanging.result).toEqual({ kind: 'ended', exitCode: signalExitStatus('SIGKILL') })
      expect(rig.signals.signals().map((s) => [s.target, s.signal])).toEqual([[{ kind: 'group', processGroup: hanging.processGroup! }, 'SIGKILL']])
      expect(hanging.end()).toBe('no-such-process')

      const built = startTestImageBuild(rig.ctx, rig.signals.sendSignal, spec, () => undefined)
      expect((await built.result).kind).toBe('built')
      expect(built.end()).toBe('no-such-process')
      expect(rig.signals.signals()).toHaveLength(1)
    })

    test.each([
      ['an image ID', `sha256:${'ab'.repeat(32)}`],
      ['a foreign tag', 'cscb-ci:latest'],
    ])('a derived build only starts from a run-private tag: %s is refused and nothing is spawned', async (_what, from) => {
      const rig = makeDockerRig()
      const spec: DerivedImageBuildSpec = { from, labels: {}, tag: runTag(DRIFT_ROLE) }
      expect(() => derivedImageDockerfile(spec)).toThrow()
      const build = startDerivedImageBuild(rig.ctx, rig.signals.sendSignal, spec, () => undefined)
      expect(build.pid).toBeNull()
      expect(build.end()).toBe('no-such-process')
      const result = await build.result
      expect(result.kind === 'failed' && result.exitCode).toBeNull()
      expect(rig.recorder.spawns()).toEqual([])
    })
  })

  // -------------------------------------------------------------------------
  // The fake container interface follows Docker's image rules (b.uqm SR-23.6's unit proof)
  // -------------------------------------------------------------------------

  describe('the fake container interface follows Docker\'s image rules (SR-23.6)', () => {
    /** Spawns one argument list of the docker layer's forms straight at the fake, and awaits its end. */
    function spawnDocker(rig: DockerRig, argv: readonly string[], extra: Partial<SpawnRequest> = {}): Promise<SpawnResult> {
      return rig.recorder.spawn({ argv, env: {}, cwd: rig.root, ownProcessGroup: false, ...extra }).result
    }

    /** `docker image rm <ref>`: the tag-removal form with `ref` as its one operand (an ID in place of the tag for the by-ID cases). */
    function imageRemovalOf(ref: string): string[] {
      return [...imageTagRemovalArgs(runTag(TEST_ROLE)).slice(0, -1), ref]
    }

    /** Every image with its sorted tags. */
    function imageState(fake: FakeDocker): { id: string; tags: string[] }[] {
      return fake.images().map((image) => ({ id: image.id, tags: [...image.tags].sort() }))
    }

    function testBuild(tag: string, labels: Record<string, string>): string[] {
      return testImageBuildArgs({ dockerfilePath: TEST_DOCKERFILE_PATH, contextDir: '.', labels, tag })
    }

    test('two identical builds give one image ID; a build with a label of its own gets another', async () => {
      const rig = makeDockerRig()
      const owned = { [OWNER_LABEL]: formatOwner(OWNER) }
      for (const [tag, labels] of [
        [runTag(TEST_ROLE, OTHER_OWNER), {}],
        [runTag(DRIFT_ROLE, OTHER_OWNER), {}],
        [runTag(TEST_ROLE), owned],
      ] as const) {
        expect((await spawnDocker(rig, testBuild(tag, labels), { ownProcessGroup: true })).exitCode).toBe(0)
      }
      const plain = rig.fake.image(runTag(TEST_ROLE, OTHER_OWNER))!.id
      expect(rig.fake.image(runTag(DRIFT_ROLE, OTHER_OWNER))!.id).toBe(plain)
      expect(rig.fake.image(runTag(TEST_ROLE))!.id).not.toBe(plain)
      expect(imageState(rig.fake)).toEqual([
        { id: plain, tags: [runTag(DRIFT_ROLE, OTHER_OWNER), runTag(TEST_ROLE, OTHER_OWNER)].sort() },
        { id: rig.fake.image(runTag(TEST_ROLE))!.id, tags: [runTag(TEST_ROLE)] },
      ])
    })

    test('a removal by ID is refused while two tags name the image; with one tag left it removes that tag and deletes the image', async () => {
      const rig = makeDockerRig()
      const id = rig.fake.addImage({ tags: [runTag(TEST_ROLE), runTag(RETAG_ROLE)] })
      expect((await spawnDocker(rig, imageRemovalOf(id))).exitCode).not.toBe(0)
      expect(imageState(rig.fake)).toEqual([{ id, tags: [runTag(RETAG_ROLE), runTag(TEST_ROLE)].sort() }])
      expect((await spawnDocker(rig, imageRemovalOf(runTag(RETAG_ROLE)))).exitCode).toBe(0)
      expect(imageState(rig.fake)).toEqual([{ id, tags: [runTag(TEST_ROLE)] }])
      expect((await spawnDocker(rig, imageRemovalOf(id))).exitCode).toBe(0)
      expect(imageState(rig.fake)).toEqual([])
      expect(rig.fake.removals().map((op) => [op.removalBy, op.untagged, op.deleted])).toEqual([
        ['id', [], []],
        ['tag', [runTag(RETAG_ROLE)], []],
        ['id', [runTag(TEST_ROLE)], [id]],
      ])
    })

    test('removing a tag by name removes that tag only; removing the last tag deletes the image', async () => {
      const rig = makeDockerRig()
      const id = rig.fake.addImage({ tags: [runTag(TEST_ROLE), runTag(DRIFT_ROLE)] })
      const other = rig.fake.addImage({ tags: [runTag(TEST_ROLE, OTHER_OWNER)] })
      expect((await spawnDocker(rig, imageTagRemovalArgs(runTag(DRIFT_ROLE)))).exitCode).toBe(0)
      expect(imageState(rig.fake)).toEqual([
        { id, tags: [runTag(TEST_ROLE)] },
        { id: other, tags: [runTag(TEST_ROLE, OTHER_OWNER)] },
      ])
      expect((await spawnDocker(rig, imageTagRemovalArgs(runTag(TEST_ROLE)))).exitCode).toBe(0)
      expect(imageState(rig.fake)).toEqual([{ id: other, tags: [runTag(TEST_ROLE, OTHER_OWNER)] }])
    })

    test('removing the last tag is refused while a container, even a stopped one, uses the image', async () => {
      const rig = makeDockerRig()
      const id = rig.fake.addImage({ tags: [runTag(TEST_ROLE)] })
      rig.fake.addContainer({ name: 'stopped-user', image: id, running: false })
      expect((await spawnDocker(rig, imageTagRemovalArgs(runTag(TEST_ROLE)))).exitCode).not.toBe(0)
      expect(imageState(rig.fake)).toEqual([{ id, tags: [runTag(TEST_ROLE)] }])
    })

    test('docker tag moves a tag off an image a container uses', async () => {
      const rig = makeDockerRig()
      const used = rig.fake.addImage({ tags: [runTag(TEST_ROLE)] })
      rig.fake.addContainer({ name: 'shard-1', image: used })
      const target = rig.fake.addImage()
      expect((await spawnDocker(rig, imageTagArgs(target, runTag(TEST_ROLE)))).exitCode).toBe(0)
      expect(imageState(rig.fake)).toEqual([
        { id: used, tags: [] },
        { id: target, tags: [runTag(TEST_ROLE)] },
      ])
    })

    test('a label-filtered prune removes only the unused untagged images of exactly that value; an in-use one goes once its container is gone', async () => {
      const rig = makeDockerRig()
      const owned = { [OWNER_LABEL]: formatOwner(OWNER) }
      const unused = rig.fake.addImage({ labels: owned })
      const tagged = rig.fake.addImage({ labels: owned, tags: [runTag(TEST_ROLE)] })
      const inUse = rig.fake.addImage({ labels: owned })
      rig.fake.addContainer({ name: 'stopped-user', image: inUse, running: false })
      const otherValue = rig.fake.addImage({ labels: { [OWNER_LABEL]: formatOwner(OTHER_OWNER) } })
      const unlabelled = rig.fake.addImage()
      const prune = imagePruneArgs(formatOwner(OWNER))

      expect((await spawnDocker(rig, prune)).exitCode).toBe(0)
      expect(imageState(rig.fake).map((image) => image.id)).toEqual([tagged, inUse, otherValue, unlabelled])

      expect((await spawnDocker(rig, containerRemoveArgs('stopped-user'))).exitCode).toBe(0)
      expect((await spawnDocker(rig, prune)).exitCode).toBe(0)
      expect(imageState(rig.fake).map((image) => image.id)).toEqual([tagged, otherValue, unlabelled])
      expect(rig.fake.operations('image-prune').map((op) => op.deleted)).toEqual([[unused], [inUse]])
    })

    test.each([
      ['another prune of the runner\'s', 'runner'],
      ['another client\'s prune', 'other'],
    ] as const)('a prune that arrives while %s runs fails with the refusal text and removes nothing', async (_what, first) => {
      const rig = makeDockerRig()
      const durationMs = 5_000
      rig.fake.setPruneDuration(durationMs)
      const unused = rig.fake.addImage({ labels: { [OWNER_LABEL]: formatOwner(OWNER) } })
      const prune = imagePruneArgs(formatOwner(OWNER))
      const running = first === 'runner' ? spawnDocker(rig, prune) : null
      if (first === 'other') expect(rig.fake.startOtherPrune({ owner: formatOwner(OTHER_OWNER), durationMs })).toBe(true)

      const refused = await spawnDocker(rig, prune)
      expect(refused.exitCode).not.toBe(0)
      expect(refused.stderr).toContain(PRUNE_ALREADY_RUNNING_TEXT)
      expect(imageState(rig.fake).map((image) => image.id)).toEqual([unused])
      expect(rig.fake.operations('image-prune').at(-1)?.deleted).toEqual([])

      await rig.clock.advance(durationMs)
      if (running !== null) expect((await running).exitCode).toBe(0)
      expect(rig.fake.isPruneRunning()).toBe(false)
    })

    test('the operation log keeps each removal\'s argument as given, each listing\'s filters and each stop\'s signal', async () => {
      const rig = makeDockerRig()
      const id = rig.fake.addImage({ tags: [runTag(TEST_ROLE)] })
      rig.fake.addImage({ tags: [runTag(DRIFT_ROLE)] })
      rig.fake.addContainer({ name: 'shard-1' })
      rig.fake.addContainer({ name: 'shard-2', running: false })
      const digest = `${RUN_TAG_REPOSITORY}@sha256:${'cd'.repeat(32)}`
      const filters: ImageListFilter[] = [{ kind: 'dangling' }, { kind: 'label', key: OWNER_LABEL, value: formatOwner(OWNER) }, { kind: 'reference', pattern: `${RUN_TAG_REPOSITORY}:*` }]
      const listArgv = imageListArgs(filters)
      const prune = imagePruneArgs(formatOwner(OWNER))

      await spawnDocker(rig, imageTagRemovalArgs(runTag(DRIFT_ROLE)))
      await spawnDocker(rig, imageRemovalOf(id))
      await spawnDocker(rig, imageRemovalOf(digest))
      await spawnDocker(rig, listArgv)
      await spawnDocker(rig, containerKillArgs('shard-1', 'SIGTERM'))
      await spawnDocker(rig, prune)
      await spawnDocker(rig, containerRemoveArgs('shard-2'))

      expect(rig.fake.removals().map((op) => [op.kind, op.refs, op.removalBy, op.filters])).toEqual([
        ['image-remove', [runTag(DRIFT_ROLE)], 'tag', []],
        ['image-remove', [id], 'id', []],
        ['image-remove', [digest], 'digest', []],
        ['image-prune', [], null, [prune[prune.length - 1]!]],
        ['container-remove', ['shard-2'], null, []],
      ])
      expect(rig.fake.operations('image-list').map((op) => op.filters)).toEqual([listArgv.slice(imageListArgs([]).length).filter((_, i) => i % 2 === 1)])
      expect(rig.fake.operations('container-kill').map((op) => [op.refs, op.signal])).toEqual([[['shard-1'], 'SIGTERM']])
      expect(rig.fake.operations().map((op) => op.kind)).toEqual(['image-remove', 'image-remove', 'image-remove', 'image-list', 'container-kill', 'image-prune', 'container-remove'])
    })
  })

  // -------------------------------------------------------------------------
  // treeSnapshot's opt-in option (b.uqm SR-21.3)
  // -------------------------------------------------------------------------

  describe('treeSnapshot\'s option (SR-21.3)', () => {
    /** A whole-second modification time every built entry gets, so a restored time compares exactly. */
    const FIXED_SECONDS = Math.floor(Date.UTC(2026, 0, 1) / 1000)

    interface Tree {
      readonly root: string
      readonly tree: string
      readonly outside: string
      readonly file: string
    }

    /** `tree/` (a file, a subdirectory with a file, a symlink to a directory outside the tree) and `outside/` beside it, under one root. */
    function makeTree(): Tree {
      const root = newRoot()
      const tree = join(root, 'tree')
      const outside = join(root, 'outside')
      mkdirSync(join(tree, 'sub'), { recursive: true })
      mkdirSync(outside)
      writeFileSync(join(outside, 'target.txt'), 'outside content\n')
      const file = join(tree, 'a.txt')
      writeFileSync(file, 'hello\n', { mode: 0o644 })
      chmodSync(file, 0o644)
      writeFileSync(join(tree, 'sub', 'b.txt'), 'nested\n')
      symlinkSync(outside, join(tree, 'link'))
      utimesSync(file, FIXED_SECONDS, FIXED_SECONDS)
      return { root, tree, outside, file }
    }

    /** One entry's snapshot line, split into its fields. */
    function fieldsOf(lines: readonly string[], path: string): string[] {
      const line = lines.find((candidate) => candidate.startsWith(`${path}:`))
      if (line === undefined) throw new Error(`no snapshot line for ${path}`)
      return line.split(':')
    }

    /** Waits, by the wall clock, until the file system's coarse timestamps have moved past `path`'s change time, so a later change shows as a new ctime. */
    function pastTimestampGranularity(path: string): void {
      const ctimeMs = lstatSync(path).ctimeMs
      while (Date.now() <= ctimeMs + 25) Bun.sleepSync(5)
    }

    test('a permission change shows with the option', () => {
      const { tree, file } = makeTree()
      const before = treeSnapshot(tree, { extended: true })
      chmodSync(file, 0o600)
      const after = treeSnapshot(tree, { extended: true })
      expect(fieldsOf(before, 'a.txt')[4]).toBe('0644')
      expect(fieldsOf(after, 'a.txt')[4]).toBe('0600')
    })

    test('a change-time change, content and modification time kept, shows with the option', () => {
      const { tree, file } = makeTree()
      pastTimestampGranularity(file)
      const before = fieldsOf(treeSnapshot(tree, { extended: true }), 'a.txt')
      const other = join(dirname(tree), 'extra-link')
      linkSync(file, other)
      unlinkSync(other)
      const after = fieldsOf(treeSnapshot(tree, { extended: true }), 'a.txt')
      expect(after[5]).not.toBe(before[5])
      expect([...after.slice(0, 5), after[6]]).toEqual([...before.slice(0, 5), before[6]])
    })

    test('a same-size content change, modification time restored, shows with the option', () => {
      const { tree, file } = makeTree()
      const before = fieldsOf(treeSnapshot(tree, { extended: true }), 'a.txt')
      writeFileSync(file, 'HELLO\n')
      utimesSync(file, FIXED_SECONDS, FIXED_SECONDS)
      const after = fieldsOf(treeSnapshot(tree, { extended: true }), 'a.txt')
      expect(after.slice(0, 4)).toEqual(before.slice(0, 4))
      expect(after[6]).not.toBe(before[6])
    })

    test('a read that changes only the access time leaves the option\'s snapshot unchanged', () => {
      const { tree, file } = makeTree()
      // An access time older than the modification time, so the read (relatime) moves it.
      utimesSync(file, FIXED_SECONDS - 3600, FIXED_SECONDS)
      const atimeBefore = lstatSync(file).atimeMs
      const before = treeSnapshot(tree, { extended: true })
      expect(treeSnapshot(tree, { extended: true })).toEqual(before)
      readFileSync(file)
      expect(lstatSync(file).atimeMs).not.toBe(atimeBefore)
      expect(treeSnapshot(tree, { extended: true })).toEqual(before)
    })

    test('without the option the same tree holds no permission bits, change time or digest', () => {
      const { tree } = makeTree()
      const plain = treeSnapshot(tree)
      const extended = treeSnapshot(tree, { extended: true })
      expect(plain.map((line) => line.split(':').length)).toEqual(plain.map((line) => (line.startsWith('.:') ? 2 : 4)))
      expect(extended.map((line) => line.split(':').slice(0, line.startsWith('.:') ? 2 : 4).join(':'))).toEqual(plain)
      expect(fieldsOf(extended, 'a.txt')).toHaveLength(7)
    })

    test.each([false, true])('a symlink is listed and not followed (option %p)', (extended) => {
      const { tree, outside } = makeTree()
      const before = treeSnapshot(tree, { extended })
      const link = fieldsOf(before, 'link')
      expect(link.slice(0, 3)).toEqual(['link', 'l', outside])
      expect(link).toHaveLength(extended ? 6 : 4)
      expect(before.filter((line) => line.startsWith('link/'))).toEqual([])
      writeFileSync(join(outside, 'target.txt'), 'changed outside\n')
      writeFileSync(join(outside, 'new.txt'), 'new\n')
      expect(treeSnapshot(tree, { extended })).toEqual(before)
    })
  })
})

// ===========================================================================
// E8 (t1.t6s.7t): the run's images and tags; E8 adds its cases here
// ===========================================================================

// ===========================================================================
// E9 (t1.t6s.5x): shard containers; E9 adds its cases here
// ===========================================================================
//
// E9 T4 (b.uqm SR-10.6, AC 54): what a shard's one final reading records, and
// the order of the docker operations that retire it, for every way a shard
// ends. Each shard is started through section 13's start entry point
// (`startShard`) over the fake container interface, its cgroup written by E6's
// cgroup builder and found through its main process in the process table; it
// is then read and retired through the run's retirer (`createShardRetirer`).
// The order is proved from the fake's operation log alone, and each cgroup
// read is placed in it by the number of operations made before it. Run-level
// stops are driven as retirement reasons only (performing a stop is E13's).
// The start's own argument list, credentials, inspection capture and refusals
// are T5's, in tests/ci-run-results.test.ts. The region's imports are
// namespaces and its helpers live inside its describe, so no name can collide
// with another region's.

import * as e9 from '../scripts/ci-run.ts'
import * as e9Helpers from './test-helpers/ci-run.ts'
import * as e9Credentials from './test-helpers/credentials.ts'
import * as e9Clock from './test-helpers/fake-clock.ts'

describe('E9: the final reading and shard retirement (b.t6s E9 T4; b.uqm SR-10.6, AC 54)', () => {
  /** Test data: a RUN_ID of SR-5.1's form, and the runner's PID. */
  const RUN_ID = '20261008t120000z-e9retire'
  const OWNER: e9.Owner = { runId: RUN_ID, pid: 5150 }
  /** The fake clock's start. */
  const START_MS = Date.UTC(2026, 9, 8, 12, 0, 0)
  /** How long after its start a shard is read or retired, on the fake clock. */
  const READ_AFTER_MS = 90_000
  /** The run's secret credential: a sentinel-bearing fake, in the runner's environment and secret set only. */
  const API_KEY = e9Credentials.fakeToken(e9.RAW_KEY_PREFIX, 'e9-anthropic-key')
  /** The one signal retirement may send. */
  const SIGKILL: e9.SentSignal = 'SIGKILL'

  // --- T4.S1: the local retirement fixture (shared by T4.S1 and T4.S2) ---

  /** Shard k's cgroup files: distinct per shard, and every figure the reading takes non-zero. */
  function figuresOf(shard: number): e9Helpers.ContainerCgroupBytes {
    return {
      currentBytes: 900_000_000 + shard,
      anonBytes: 600_000_000 + shard * 1_000,
      fileBytes: 200_000_000 + shard * 1_000,
      inactiveFileBytes: 50_000_000,
      pidCount: 30 + shard,
      oomKillCount: shard + 1,
    }
  }

  /** Shard k's Docker logs, as the fake gives them. */
  function logsOf(shard: number): { readonly stdout: string; readonly stderr: string } {
    return { stdout: `shard ${shard} container standard output\n`, stderr: `shard ${shard} container standard error\n` }
  }

  /** Assigned script 1's `start` and `end` lines, its real file name from the repository's listing. */
  function ranEvents(): e9.ResultEvent[] {
    const fileName = e9Helpers.realScriptFileName(1)
    return [
      { kind: e9.RESULT_WORD_START, fileName },
      { kind: e9.RESULT_WORD_END, fileName, result: e9.RESULT_WORD_PASS, seconds: 12.5 },
    ]
  }
  const DONE_EVENT: e9.ResultEvent = { kind: e9.RESULT_WORD_DONE }

  interface StartOptions {
    /** How its `docker run` answers: started (default), failed leaving the container created, or failed leaving none. */
    readonly run?: 'start' | 'fail-created' | 'fail-none'
    /** Fields of the started container over the fake's defaults. */
    readonly container?: Partial<e9Helpers.FakeContainerSpec>
    /** Its main process's `/proc/<pid>/cgroup` cannot be read. */
    readonly membershipUnreadable?: boolean
    /** The run's secret set also holds its container name, so the start's list check refuses its list. */
    readonly secretIsName?: boolean
  }

  /** A shard as the fixture started it. */
  interface StartedShard {
    readonly shard: number
    readonly result: e9.ShardStartResult
    readonly name: string
    /** What the retirer's docker operations name: its full ID when it started, else its name. */
    readonly ref: string
    readonly cgroupPath: string
    readonly figures: e9Helpers.ContainerCgroupBytes
    /** Its Docker logs as `docker.log` should hold them. */
    readonly dockerLog: string
    readonly shardDir: string
    readonly dockerLogPath: string
  }

  interface RetirementRig {
    readonly clock: e9Clock.FakeClock
    readonly recorder: e9Helpers.SpawnRecorder
    readonly docker: e9Helpers.FakeDocker
    readonly tree: e9Helpers.CgroupTree
    readonly root: string
    readonly runDir: string
    /** Every runner-log line, the start's and the retirer's. */
    readonly lines: string[]
    readonly state: { readonly cleanupFailures: string[] }
    readonly retirer: e9.ShardRetirer
    /** For each cgroup read the retirer made, how many docker operations had been made before it. */
    readonly opsAtCgroupRead: number[]
    start(shard: number, options?: StartOptions): Promise<StartedShard>
    /** Writes the shard's `result.txt` through the result-file builder. */
    writeResult(started: StartedShard, spec: e9Helpers.ResultFileSpec): void
  }

  let roots: string[] = []
  let recorders: e9Helpers.SpawnRecorder[] = []
  let rigs: RetirementRig[] = []

  afterEach(() => {
    const built = recorders
    const checked = rigs
    recorders = []
    rigs = []
    try {
      // Everything each run logged, recorded and wrote, failure paths included, holds no credential.
      for (const rig of checked) {
        const shards = [1, 2, 3]
        e9Credentials.assertNoLeak(
          {
            lines: rig.lines,
            cleanupFailures: rig.state.cleanupFailures,
            readings: shards.map((shard) => rig.retirer.recordedReading(shard)),
            retirements: shards.map((shard) => rig.retirer.recordedRetirement(shard)),
            runDir: e9Credentials.writtenFile(rig.runDir),
          },
          'e9 run',
        )
      }
    } finally {
      for (const root of roots) rmSync(root, { recursive: true, force: true })
      roots = []
    }
    for (const recorder of built) recorder.assertNoFailures()
  })

  /**
   * A run with no shard yet: a constructed root, a fake clock, a spawn
   * recorder with the fake container interface, a cgroup tree, a run
   * directory, a runner log collected in order, the run's state, one canary
   * source and one retirer. The runner's environment holds the fake key;
   * `afterEach` leak-checks what the run logged, recorded and wrote.
   */
  function newRig(): RetirementRig {
    const root = mkdtempSync(join(tmpdir(), 'ci-run-lifecycle-e9-'))
    roots.push(root)
    const clock = e9Clock.createFakeClock({ start: START_MS })
    const recorder = e9Helpers.createSpawnRecorder({ clock, root })
    recorders.push(recorder)
    const docker = e9Helpers.createFakeDocker(recorder)
    const tree = e9Helpers.createCgroupTree(root)
    const imageId = docker.addImage()
    const runDir = e9Helpers.makeRunDir(root, RUN_ID)
    const lines: string[] = []
    const log: e9.RunnerLogSink = (line) => {
      lines.push(line)
    }
    const state = { cleanupFailures: [] as string[] }
    const env = { ANTHROPIC_API_KEY: API_KEY }
    let draws = 0
    const canaries = e9.createShardCanaryDrawer((count) => {
      draws += 1
      return Uint8Array.from({ length: count }, (_, index) => (draws * 37 + index) & 0xff)
    })
    const runAnswers = new Map<string, e9Helpers.FakeRunAnswer>()
    docker.answerRuns((runArguments) => {
      for (const [name, answer] of runAnswers) if (runArguments.includes(name)) return answer
      throw new Error(`no run answer for ${JSON.stringify(runArguments)}`)
    })
    const opsAtCgroupRead: number[] = []
    const retirer = e9.createShardRetirer({
      deps: {
        spawn: recorder.spawn,
        env,
        worktreeRoot: root,
        clock,
        readCgroupFile: (cgroupPath, fileName) => {
          opsAtCgroupRead.push(docker.operations().length)
          return tree.readCgroupFile(cgroupPath, fileName)
        },
        readProcCgroup: recorder.processes.deps().readProcCgroup,
      },
      runDir,
      log,
      state,
    })

    async function start(shard: number, options: StartOptions = {}): Promise<StartedShard> {
      const name = e9.shardContainerName(OWNER, shard)
      const cgroupPath = `/docker/e9-shard-${shard}`
      const figures = figuresOf(shard)
      const logs = logsOf(shard)
      const run = options.run ?? 'start'
      const unreadable: e9Helpers.ProcEntry[] = options.membershipUnreadable === true ? ['cgroup'] : []
      const process = { cgroup: e9Helpers.cgroupMembershipLine(cgroupPath), unreadable }
      runAnswers.set(name, run === 'start' ? { kind: 'start', container: { process, logs, ...options.container } } : { kind: 'fail', leavesContainer: run === 'fail-created' })
      if (run === 'start') tree.writeContainer(cgroupPath, figures)
      const result = await e9.startShard(
        { spawn: recorder.spawn, env, worktreeRoot: root, clock },
        {
          owner: OWNER,
          runDir,
          assignment: { shard, assigned: [e9Helpers.realScriptFileName(1)] },
          failFileNames: [],
          faults: [],
          pinnedImageId: imageId,
          driftImageId: null,
          tarballPath: join(root, 'package', 'cscb-ci.tgz'),
          secretValues: options.secretIsName === true ? [API_KEY, name] : [API_KEY],
          canaries,
          log,
        },
      )
      const shardDir = e9.shardSubdirectoryPath(runDir, shard)
      return {
        shard,
        result,
        name,
        ref: result.containerId ?? name,
        cgroupPath,
        figures,
        dockerLog: run === 'start' ? `${logs.stdout}${logs.stderr}` : '',
        shardDir,
        dockerLogPath: join(shardDir, e9.DOCKER_LOG_FILE_NAME),
      }
    }

    const rig: RetirementRig = {
      clock,
      recorder,
      docker,
      tree,
      root,
      runDir,
      lines,
      state,
      retirer,
      opsAtCgroupRead,
      start,
      writeResult(started, spec) {
        writeFileSync(join(started.shardDir, e9.RESULT_FILE_NAME), e9Helpers.resultFileText(spec))
      },
    }
    rigs.push(rig)
    return rig
  }

  /** A docker operation as an order assertion compares it. */
  interface OperationSummary {
    readonly kind: e9Helpers.FakeDockerOperationKind
    readonly refs: readonly string[]
    readonly signal: e9.SentSignal | null
  }

  function summaryOf(ops: readonly e9Helpers.FakeDockerOperation[]): OperationSummary[] {
    return ops.map((op) => ({ kind: op.kind, refs: op.refs, signal: op.signal }))
  }

  /** b.uqm SR-10.6's order on `ref`: its state read (the final reading), SIGKILL only when `killed`, its logs, its removal. */
  function retirementOrder(ref: string, killed: boolean): OperationSummary[] {
    return [
      { kind: 'container-state', refs: [ref], signal: null },
      ...(killed ? [{ kind: 'container-kill' as const, refs: [ref], signal: SIGKILL }] : []),
      { kind: 'container-logs', refs: [ref], signal: null },
      { kind: 'container-remove', refs: [ref], signal: null },
    ]
  }

  type Retired = Extract<e9.ShardRetirement, { readonly kind: 'retired' }>

  function retiredOf(retirement: e9.ShardRetirement): Retired {
    if (retirement.kind !== 'retired') throw new Error(`shard-${retirement.shard} was not retired: ${retirement.kind}`)
    return retirement
  }

  /** A started shard after `READ_AFTER_MS`, with the operation and log-line counts before what follows. */
  async function startedShard(rig: RetirementRig, shard: number, options: StartOptions = {}): Promise<StartedShard> {
    const started = await rig.start(shard, options)
    expect(started.result.start.kind).toBe('started')
    expect(started.result.containerCreated).toBe(true)
    await rig.clock.advance(READ_AFTER_MS)
    return started
  }

  /** The reading of a running shard whose every part was read. */
  function fullReading(started: StartedShard, oomKilled: boolean, status: string): e9.ShardFinalReading {
    return {
      shard: started.shard,
      atMs: START_MS + READ_AFTER_MS,
      final: { oomKilled, oomKillCount: started.figures.oomKillCount, anonBytes: started.figures.anonBytes, fileBytes: started.figures.fileBytes },
      status,
      running: true,
      exitCode: null,
      failedReadings: [],
    }
  }

  /** Each failed reading has exactly one runner-log line, naming what failed, why, and `unreadable`. */
  function expectOneLinePerFailedReading(reading: e9.ShardFinalReading, lines: readonly string[]): void {
    expect(lines).toHaveLength(reading.failedReadings.length)
    reading.failedReadings.forEach((failed, index) => {
      const line = lines[index] ?? ''
      expect(line.startsWith(`${e9.SHARD_DIR_PREFIX}${reading.shard}:`)).toBe(true)
      expect(line).toContain(failed.what)
      expect(line).toContain(failed.error)
      expect(line).toContain(e9.UNREADABLE_READING)
    })
  }

  // -------------------------------------------------------------------------
  // T4.S1: what one final reading records (b.uqm SR-10.6)
  // -------------------------------------------------------------------------

  describe('the final reading (SR-10.6)', () => {
    test.each([false, true])('a running shard\'s reading records State.OOMKilled %p, the kill count, anon and file as constructed, and writes no line', async (oomKilled) => {
      const rig = newRig()
      const started = await startedShard(rig, 1, { container: { oomKilled } })
      const status = rig.docker.container(started.ref)?.status
      const opsFrom = rig.docker.operations().length
      const linesFrom = rig.lines.length

      const reading = await rig.retirer.finalReading(started.result)

      expect(reading).toEqual(fullReading(started, oomKilled, status ?? ''))
      expect(rig.retirer.recordedReading(1)).toEqual(reading)
      expect(summaryOf(rig.docker.operations().slice(opsFrom))).toEqual([{ kind: 'container-state', refs: [started.ref], signal: null }])
      expect(rig.opsAtCgroupRead.length).toBeGreaterThan(0)
      expect(rig.lines.slice(linesFrom)).toEqual([])
    })

    const STAT = e9Helpers.CGROUP_FILE.stat
    const EVENTS = e9Helpers.CGROUP_FILE.events
    type Part = 'oomKillCount' | 'anonBytes' | 'fileBytes'
    test.each([
      // The failed readings: one per failed file read, or one per key a readable file lacks.
      ['memory.events removed', EVENTS, { kind: 'removed' }, ['oomKillCount'], 1],
      ['memory.events garbled', EVENTS, { kind: 'garbled' }, ['oomKillCount'], 1],
      ['memory.events without its oom_kill line', EVENTS, { kind: 'without-key', key: 'oom_kill' }, ['oomKillCount'], 1],
      ['memory.stat removed', STAT, { kind: 'removed' }, ['anonBytes', 'fileBytes'], 1],
      ['memory.stat garbled', STAT, { kind: 'garbled' }, ['anonBytes', 'fileBytes'], 2],
      ['memory.stat without its anon line', STAT, { kind: 'without-key', key: 'anon' }, ['anonBytes'], 1],
      ['memory.stat without its file line', STAT, { kind: 'without-key', key: 'file' }, ['fileBytes'], 1],
    ] satisfies [string, e9Helpers.CgroupFileName, e9Helpers.CgroupFileChange, Part[], number][])('%s: only the parts it holds are unreadable, the others keep their values', async (_what, fileName, change, parts, failures) => {
      const rig = newRig()
      const started = await startedShard(rig, 1, { container: { oomKilled: true } })
      const status = rig.docker.container(started.ref)?.status ?? ''
      rig.tree.change(started.cgroupPath, fileName, change)
      const linesFrom = rig.lines.length

      const reading = await rig.retirer.finalReading(started.result)

      const full = fullReading(started, true, status)
      const final = { ...full.final }
      for (const part of parts) final[part] = e9.UNREADABLE_READING
      expect(reading).toEqual({ ...full, final, failedReadings: expect.any(Array) })
      if (reading === null) throw new Error('no reading')
      expect(reading.failedReadings).toHaveLength(failures)
      for (const failed of reading.failedReadings) {
        expect(failed.shard).toBe(1)
        expect(failed.what).toContain(started.name)
        expect(failed.what).toContain(fileName)
      }
      expectOneLinePerFailedReading(reading, rig.lines.slice(linesFrom))
    })

    test('its main process\'s cgroup membership unreadable: the three cgroup parts are unreadable, State.OOMKilled keeps its value', async () => {
      const rig = newRig()
      const started = await startedShard(rig, 1, { container: { oomKilled: true }, membershipUnreadable: true })
      const status = rig.docker.container(started.ref)?.status ?? ''
      const linesFrom = rig.lines.length

      const reading = await rig.retirer.finalReading(started.result)

      const full = fullReading(started, true, status)
      expect(reading).toEqual({
        ...full,
        final: { oomKilled: true, oomKillCount: e9.UNREADABLE_READING, anonBytes: e9.UNREADABLE_READING, fileBytes: e9.UNREADABLE_READING },
        failedReadings: [{ shard: 1, what: expect.stringContaining(started.name), error: expect.any(String) }],
      })
      if (reading === null) throw new Error('no reading')
      expect(rig.tree.reads()).toEqual([])
      expectOneLinePerFailedReading(reading, rig.lines.slice(linesFrom))
    })

    test.each([
      ['Docker fails the state read', 'daemon'],
      ['Docker answers State.OOMKilled in a form the layer cannot parse', 'unparseable'],
    ] as const)('%s: every part, the status and whether it runs are unreadable, and no cgroup file is read', async (_what, how) => {
      const rig = newRig()
      const started = await startedShard(rig, 1, how === 'unparseable' ? { container: { stateReadings: [{ oomKilled: e9.UNREADABLE_READING }] } } : {})
      if (how === 'daemon') rig.docker.fail('container-state')
      const linesFrom = rig.lines.length

      const reading = await rig.retirer.finalReading(started.result)

      expect(reading).toEqual({
        shard: 1,
        atMs: START_MS + READ_AFTER_MS,
        final: { oomKilled: e9.UNREADABLE_READING, oomKillCount: e9.UNREADABLE_READING, anonBytes: e9.UNREADABLE_READING, fileBytes: e9.UNREADABLE_READING },
        status: e9.UNREADABLE_READING,
        running: e9.UNREADABLE_READING,
        exitCode: null,
        failedReadings: [
          { shard: 1, what: expect.stringContaining(started.name), error: expect.any(String) },
          { shard: 1, what: expect.stringContaining(started.name), error: expect.any(String) },
        ],
      })
      if (reading === null) throw new Error('no reading')
      expect(rig.opsAtCgroupRead).toEqual([])
      expectOneLinePerFailedReading(reading, rig.lines.slice(linesFrom))
    })

    test.each([
      ['after its end marker', true, 0, false],
      ['without its end marker', false, 3, true],
    ])('a container that exited on its own %s: State.OOMKilled and the exit code are recorded, the cgroup parts are unreadable, and nothing throws', async (_what, marker, exitCode, oomKilled) => {
      const rig = newRig()
      const started = await startedShard(rig, 1)
      rig.writeResult(started, { events: marker ? [...ranEvents(), DONE_EVENT] : ranEvents().slice(0, 1) })
      rig.docker.exitContainer(started.ref, { exitCode, oomKilled })
      const status = rig.docker.container(started.ref)?.status ?? ''
      const linesFrom = rig.lines.length

      const reading = await rig.retirer.finalReading(started.result)

      expect(reading).toEqual({
        shard: 1,
        atMs: START_MS + READ_AFTER_MS,
        final: { oomKilled, oomKillCount: e9.UNREADABLE_READING, anonBytes: e9.UNREADABLE_READING, fileBytes: e9.UNREADABLE_READING },
        status,
        running: false,
        exitCode,
        failedReadings: [{ shard: 1, what: expect.stringContaining(started.name), error: expect.any(String) }],
      })
      expect(e9.EXITED_CONTAINER_STATUSES as readonly string[]).toContain(status)
      if (reading === null) throw new Error('no reading')
      expect(rig.opsAtCgroupRead).toEqual([])
      expectOneLinePerFailedReading(reading, rig.lines.slice(linesFrom))
    })

    test('asking twice, one after the other, gives the first reading and makes no new read', async () => {
      const rig = newRig()
      const started = await startedShard(rig, 1)
      expect(rig.retirer.recordedReading(1)).toBeNull()
      const first = await rig.retirer.finalReading(started.result)
      const opsAfter = rig.docker.operations().length
      const readsAfter = rig.tree.reads().length
      const linesAfter = rig.lines.length
      await rig.clock.advance(READ_AFTER_MS)

      const second = await rig.retirer.finalReading(started.result)

      expect(second).toBe(first)
      expect(rig.retirer.recordedReading(1)).toBe(first)
      expect(rig.docker.operations()).toHaveLength(opsAfter)
      expect(rig.tree.reads()).toHaveLength(readsAfter)
      expect(rig.lines).toHaveLength(linesAfter)
    })

    test('asking twice at once makes one state read and gives both requests the same reading', async () => {
      const rig = newRig()
      const started = await startedShard(rig, 1)
      const opsFrom = rig.docker.operations().length

      const [first, second] = await Promise.all([rig.retirer.finalReading(started.result), rig.retirer.finalReading(started.result)])

      expect(second).toBe(first)
      expect(summaryOf(rig.docker.operations().slice(opsFrom))).toEqual([{ kind: 'container-state', refs: [started.ref], signal: null }])
    })
  })

  // -------------------------------------------------------------------------
  // T4.S2: the retirement order for every way a shard ends (AC 54)
  // -------------------------------------------------------------------------

  describe('the retirement order (SR-10.6, AC 54)', () => {
    type Ending = 'running' | 'exited' | 'created'
    test.each([
      ['its end marker written, its container still running', 'running', true, { kind: 'end-marker' }],
      ['its wall-time limit', 'running', false, { kind: 'limit' }],
      ['a kill:<k> fault', 'running', false, { kind: 'kill' }],
      ['an interrupt', 'running', false, { kind: 'run-level-stop', by: 'interrupt' }],
      ['the memory watchdog', 'running', false, { kind: 'run-level-stop', by: 'memory-watchdog' }],
      ['the run deadline', 'running', false, { kind: 'run-level-stop', by: 'run-deadline' }],
      ['its container exiting on its own after its end marker', 'exited', true, { kind: 'exited' }],
      ['its container exiting on its own without its end marker', 'exited', false, { kind: 'exited' }],
      ['a container created but never started, at a run-level stop', 'created', false, { kind: 'run-level-stop', by: 'interrupt' }],
    ] satisfies [string, Ending, boolean, e9.RetirementReason][])('%s: the final reading, SIGKILL only while it runs, docker.log, then removal', async (_what, ending, marker, reason) => {
      const rig = newRig()
      const started = await rig.start(1, ending === 'created' ? { run: 'fail-created' } : {})
      expect(started.result.containerCreated).toBe(true)
      expect(started.result.start.kind).toBe(ending === 'created' ? 'failed-to-start' : 'started')
      if (marker) rig.writeResult(started, { events: [...ranEvents(), DONE_EVENT] })
      if (ending === 'exited') rig.docker.exitContainer(started.ref, { exitCode: 0 })
      await rig.clock.advance(READ_AFTER_MS)
      const opsFrom = rig.docker.operations().length
      const running = ending === 'running'

      const retirement = await rig.retirer.retire(started.result, reason)

      const ops = rig.docker.operations().slice(opsFrom)
      expect(summaryOf(ops)).toEqual(retirementOrder(started.ref, running))
      expect(ops.flatMap((op) => (op.signal === null ? [] : [op.signal]))).toEqual(running ? [SIGKILL] : [])
      // The reading's cgroup reads came right after its state read, before any later step.
      expect([...new Set(rig.opsAtCgroupRead)]).toEqual(running ? [opsFrom + 1] : [])
      const reading = rig.retirer.recordedReading(1)
      if (reading === null) throw new Error('no reading recorded')
      expect(reading.running).toBe(running)
      expect(retirement).toEqual({
        kind: 'retired',
        shard: 1,
        requested: reason,
        reason,
        reading,
        kill: { kind: running ? 'sent' : 'not-running' },
        logSave: { kind: 'saved', path: started.dockerLogPath },
        removal: { kind: 'removed' },
      })
      expect(rig.retirer.recordedRetirement(1)).toBe(retirement)
      expect(readFileSync(started.dockerLogPath, 'utf-8')).toBe(started.dockerLog)
      expect(rig.docker.container(started.ref)).toBeNull()
      expect(rig.state.cleanupFailures).toEqual([])
    })

    test('shards retired at once each get their own reading before their own removal, and nothing but SIGKILL is sent', async () => {
      const rig = newRig()
      const shards = [await rig.start(1), await rig.start(2), await rig.start(3)]
      rig.docker.exitContainer(shards[1]!.ref, { exitCode: 1 })
      const reasons: e9.RetirementReason[] = [{ kind: 'limit' }, { kind: 'exited' }, { kind: 'run-level-stop', by: 'memory-watchdog' }]
      const opsFrom = rig.docker.operations().length

      await Promise.all(shards.map((started, index) => rig.retirer.retire(started.result, reasons[index]!)))

      const ops = rig.docker.operations().slice(opsFrom)
      expect(ops.every((op) => op.signal === null || op.signal === SIGKILL)).toBe(true)
      shards.forEach((started, index) => {
        const own = ops.filter((op) => op.refs.includes(started.ref))
        expect(summaryOf(own)).toEqual(retirementOrder(started.ref, index !== 1))
        expect(readFileSync(started.dockerLogPath, 'utf-8')).toBe(started.dockerLog)
        expect(rig.retirer.recordedReading(started.shard)?.shard).toBe(started.shard)
      })
      expect(ops).toHaveLength(11)
    })

    test.each([
      ['a complete done line: retired at its end marker, with a runner-log line', { events: [...ranEvents(), DONE_EVENT] }, { kind: 'end-marker' }],
      ['a done line still being written, without its line feed: still a limit retirement', { events: ranEvents(), partial: { event: DONE_EVENT } }, { kind: 'limit' }],
    ] satisfies [string, e9Helpers.ResultFileSpec, e9.RetirementReason][])('a limit retirement of a shard whose result file holds %s', async (_what, resultFile, effective) => {
      const rig = newRig()
      const started = await startedShard(rig, 1)
      rig.writeResult(started, resultFile)
      const opsFrom = rig.docker.operations().length
      const linesFrom = rig.lines.length

      const retirement = retiredOf(await rig.retirer.retire(started.result, { kind: 'limit' }))

      expect(retirement.requested).toEqual({ kind: 'limit' })
      expect(retirement.reason).toEqual(effective)
      expect(retiredOf(rig.retirer.recordedRetirement(1) ?? retirement).reason).toEqual(effective)
      expect(summaryOf(rig.docker.operations().slice(opsFrom))).toEqual(retirementOrder(started.ref, true))
      const markerLines = rig.lines.slice(linesFrom).filter((line) => line.startsWith(`${e9.SHARD_DIR_PREFIX}1:`) && line.includes(e9.RESULT_FILE_NAME))
      expect(markerLines).toHaveLength(effective.kind === 'end-marker' ? 1 : 0)
    })

    test.each([
      ['a docker run that failed and left no container', { run: 'fail-none' }, 'none'],
      ['a docker run argument list the secret check refused', { secretIsName: true }, 'none'],
      ['a docker run refused because another container holds its name', {}, 'holder'],
    ] satisfies [string, StartOptions, 'none' | 'holder'][])('%s: no container, no reading, no docker operation and no runner-log line', async (_what, options, holder) => {
      const rig = newRig()
      const name = e9.shardContainerName(OWNER, 1)
      if (holder === 'holder') rig.docker.addContainer({ name, running: false })
      const started = await rig.start(1, options)
      expect(started.result.containerCreated).toBe(false)
      expect(started.result.start.nameInUse).toBe(holder === 'holder')
      const opsFrom = rig.docker.operations().length
      const linesFrom = rig.lines.length
      const reason: e9.RetirementReason = { kind: 'run-level-stop', by: 'memory-watchdog' }

      const retirement = await rig.retirer.retire(started.result, reason)
      const reading = await rig.retirer.finalReading(started.result)

      expect(retirement).toEqual({ kind: 'no-container', shard: 1, requested: reason, reason })
      expect(reading).toBeNull()
      expect(rig.retirer.recordedReading(1)).toBeNull()
      expect(rig.retirer.recordedRetirement(1)).toBe(retirement)
      expect(rig.docker.operations().slice(opsFrom)).toEqual([])
      expect(rig.lines.slice(linesFrom)).toEqual([])
      expect(existsSync(started.dockerLogPath)).toBe(false)
      if (holder === 'holder') expect(rig.docker.container(name)).not.toBeNull()
    })

    test('a failed start whose container Docker does not know: one state read, one runner-log line, no reading and nothing retired', async () => {
      const rig = newRig()
      // The start's own check of what its failed run left fails, so the container counts as created.
      rig.docker.fail('container-state')
      const started = await rig.start(1, { run: 'fail-none' })
      expect(started.result.containerCreated).toBe(true)
      const opsFrom = rig.docker.operations().length
      const linesFrom = rig.lines.length

      const retirement = await rig.retirer.retire(started.result, { kind: 'limit' })
      const reading = await rig.retirer.finalReading(started.result)

      expect(retirement).toEqual({ kind: 'no-container', shard: 1, requested: { kind: 'limit' }, reason: { kind: 'limit' } })
      expect(reading).toBeNull()
      expect(rig.retirer.recordedReading(1)).toBeNull()
      expect(summaryOf(rig.docker.operations().slice(opsFrom))).toEqual([{ kind: 'container-state', refs: [started.name], signal: null }])
      const lines = rig.lines.slice(linesFrom)
      expect(lines).toHaveLength(1)
      expect(lines[0]?.startsWith(`${e9.SHARD_DIR_PREFIX}1:`)).toBe(true)
      expect(lines[0]).toContain(started.name)
      expect(existsSync(started.dockerLogPath)).toBe(false)
    })

    test('a started shard whose container vanished: an all-unreadable reading, not running, no SIGKILL, no docker.log and nothing to remove', async () => {
      const rig = newRig()
      const started = await startedShard(rig, 1)
      rig.docker.exitContainer(started.ref, { exitCode: 0 })
      // Removed by another client, through the same fake.
      const removed = await e9.removeContainer({ spawn: rig.recorder.spawn, env: {}, cwd: rig.root }, started.ref)
      expect(removed.ok).toBe(true)
      const opsFrom = rig.docker.operations().length
      const linesFrom = rig.lines.length

      const retirement = retiredOf(await rig.retirer.retire(started.result, { kind: 'kill' }))

      expect(retirement.reading).toEqual({
        shard: 1,
        atMs: START_MS + READ_AFTER_MS,
        final: { oomKilled: e9.UNREADABLE_READING, oomKillCount: e9.UNREADABLE_READING, anonBytes: e9.UNREADABLE_READING, fileBytes: e9.UNREADABLE_READING },
        status: e9.UNREADABLE_READING,
        running: false,
        exitCode: null,
        failedReadings: [
          { shard: 1, what: expect.stringContaining(started.name), error: expect.any(String) },
          { shard: 1, what: expect.stringContaining(started.name), error: expect.any(String) },
        ],
      })
      expect(retirement.kill).toEqual({ kind: 'not-running' })
      expect(retirement.logSave).toEqual({ kind: 'absent' })
      expect(retirement.removal).toEqual({ kind: 'absent' })
      expect(summaryOf(rig.docker.operations().slice(opsFrom))).toEqual(retirementOrder(started.ref, false))
      expect(existsSync(started.dockerLogPath)).toBe(false)
      expect(rig.state.cleanupFailures).toEqual([])
      const lines = rig.lines.slice(linesFrom)
      // One line per failed reading, then the absent docker.log's.
      expect(lines).toHaveLength(retirement.reading.failedReadings.length + 1)
      expect(lines.at(-1)).toContain(e9.DOCKER_LOG_FILE_NAME)
      expect(lines.at(-1)).toContain(started.name)
    })

    test.each([
      ['a limit retirement of a running container: SIGKILL sent', 'running', { kind: 'limit' }, true],
      ['a run-level stop of a running container: SIGKILL sent', 'running', { kind: 'run-level-stop', by: 'run-deadline' }, true],
      ['an exit on its own: no SIGKILL', 'exited', { kind: 'exited' }, false],
    ] satisfies [string, 'running' | 'exited', e9.RetirementReason, boolean][])('whether it runs unreadable, %s', async (_what, ending, reason, killed) => {
      const rig = newRig()
      const started = await startedShard(rig, 1)
      if (ending === 'exited') rig.docker.exitContainer(started.ref, { exitCode: 0 })
      rig.docker.fail('container-state')
      const opsFrom = rig.docker.operations().length

      const retirement = retiredOf(await rig.retirer.retire(started.result, reason))

      expect(retirement.reading.running).toBe(e9.UNREADABLE_READING)
      expect(retirement.kill).toEqual({ kind: killed ? 'sent' : 'not-running' })
      expect(summaryOf(rig.docker.operations().slice(opsFrom))).toEqual(retirementOrder(started.ref, killed))
      expect(retirement.removal).toEqual({ kind: 'removed' })
    })

    test('a failed removal is written to the runner log and listed as a cleanup failure', async () => {
      const rig = newRig()
      const started = await startedShard(rig, 1)
      const refusal = 'Error response from daemon: constructed removal refusal'
      rig.docker.fail('container-remove', { stderr: refusal })
      const opsFrom = rig.docker.operations().length
      const linesFrom = rig.lines.length

      const retirement = retiredOf(await rig.retirer.retire(started.result, { kind: 'limit' }))

      expect(summaryOf(rig.docker.operations().slice(opsFrom))).toEqual(retirementOrder(started.ref, true))
      if (retirement.removal.kind !== 'failed') throw new Error(`removal: ${retirement.removal.kind}`)
      const { line } = retirement.removal
      expect(line).toContain(started.name)
      expect(line).toContain(started.ref)
      expect(line).toContain(refusal)
      expect(rig.lines.slice(linesFrom)).toEqual([line])
      expect(rig.state.cleanupFailures).toEqual([line])
      expect(retirement.logSave).toEqual({ kind: 'saved', path: started.dockerLogPath })
    })

    test.each([
      ['Docker fails to give its logs', 'logs'],
      ['docker.log cannot be written', 'write'],
    ] as const)('a failed log save (%s) is written to the runner log, and its removal still follows', async (_what, how) => {
      const rig = newRig()
      const started = await startedShard(rig, 1)
      if (how === 'logs') rig.docker.fail('container-logs')
      else mkdirSync(started.dockerLogPath)
      const opsFrom = rig.docker.operations().length
      const linesFrom = rig.lines.length

      const retirement = retiredOf(await rig.retirer.retire(started.result, { kind: 'kill' }))

      expect(summaryOf(rig.docker.operations().slice(opsFrom))).toEqual(retirementOrder(started.ref, true))
      expect(retirement.logSave.kind).toBe('failed')
      expect(retirement.removal).toEqual({ kind: 'removed' })
      expect(rig.docker.container(started.ref)).toBeNull()
      const lines = rig.lines.slice(linesFrom)
      expect(lines).toHaveLength(1)
      expect(lines[0]).toContain(e9.DOCKER_LOG_FILE_NAME)
      expect(rig.state.cleanupFailures).toEqual([])
      if (how === 'logs') expect(existsSync(started.dockerLogPath)).toBe(false)
    })

    test('a failed SIGKILL is written to the runner log but is no cleanup failure, and its removal still follows', async () => {
      const rig = newRig()
      const started = await startedShard(rig, 1)
      rig.docker.fail('container-kill')
      const opsFrom = rig.docker.operations().length
      const linesFrom = rig.lines.length

      const retirement = retiredOf(await rig.retirer.retire(started.result, { kind: 'run-level-stop', by: 'interrupt' }))

      expect(summaryOf(rig.docker.operations().slice(opsFrom))).toEqual(retirementOrder(started.ref, true))
      expect(retirement.kill.kind).toBe('failed')
      expect(retirement.logSave).toEqual({ kind: 'saved', path: started.dockerLogPath })
      // Still running, so Docker refuses the unforced removal: that, not the kill, is the cleanup failure.
      if (retirement.removal.kind !== 'failed') throw new Error(`removal: ${retirement.removal.kind}`)
      expect(rig.state.cleanupFailures).toEqual([retirement.removal.line])
      const lines = rig.lines.slice(linesFrom)
      expect(lines).toHaveLength(2)
      expect(lines[0]).toContain(started.name)
      expect(lines[0]).not.toBe(retirement.removal.line)
      expect(lines[1]).toBe(retirement.removal.line)
    })

    test('retiring a shard again, for another reason, gives the first retirement and makes no operation', async () => {
      const rig = newRig()
      const started = await startedShard(rig, 1)
      const first = await rig.retirer.retire(started.result, { kind: 'limit' })
      const opsAfter = rig.docker.operations().length
      const linesAfter = rig.lines.length

      const again = await rig.retirer.retire(started.result, { kind: 'run-level-stop', by: 'interrupt' })
      const reading = await rig.retirer.finalReading(started.result)

      expect(again).toBe(first)
      expect(reading).toBe(retiredOf(first).reading)
      expect(rig.docker.operations()).toHaveLength(opsAfter)
      expect(rig.lines).toHaveLength(linesAfter)
    })

    test('a limit retirement, a run-level stop and a reading request at once share one reading and one set of operations', async () => {
      const rig = newRig()
      const started = await startedShard(rig, 1)
      const opsFrom = rig.docker.operations().length

      const [byLimit, byStop, reading] = await Promise.all([
        rig.retirer.retire(started.result, { kind: 'limit' }),
        rig.retirer.retire(started.result, { kind: 'run-level-stop', by: 'run-deadline' }),
        rig.retirer.finalReading(started.result),
      ])

      expect(byStop).toBe(byLimit)
      expect(retiredOf(byLimit).reason).toEqual({ kind: 'limit' })
      expect(reading).not.toBeNull()
      expect(retiredOf(byLimit).reading).toBe(reading as e9.ShardFinalReading)
      expect(summaryOf(rig.docker.operations().slice(opsFrom))).toEqual(retirementOrder(started.ref, true))
    })

    test('a reading taken before the retirement is the retirement\'s reading: Docker\'s state is read once', async () => {
      const rig = newRig()
      const started = await startedShard(rig, 1)
      const opsFrom = rig.docker.operations().length
      const reading = await rig.retirer.finalReading(started.result)

      const retirement = retiredOf(await rig.retirer.retire(started.result, { kind: 'kill' }))

      expect(reading).not.toBeNull()
      expect(retirement.reading).toBe(reading as e9.ShardFinalReading)
      expect(summaryOf(rig.docker.operations().slice(opsFrom))).toEqual(retirementOrder(started.ref, true))
    })
  })
})

// ===========================================================================
// E13 (t1.t6s.vd): the run sequence end to end, stops and the end of run; E13 adds its cases here
// ===========================================================================
