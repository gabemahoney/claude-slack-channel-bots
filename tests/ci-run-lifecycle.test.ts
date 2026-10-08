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
  /** Test data, not a runner constant: the raw Anthropic key's prefix (b.uqm SR-15.1), as tests/ci-run-interface.test.ts builds the key. */
  const RAW_KEY_PREFIX = 'sk-ant-'

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

// ===========================================================================
// E13 (t1.t6s.vd): the run sequence end to end, stops and the end of run; E13 adds its cases here
// ===========================================================================
