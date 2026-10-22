/**
 * tests/ci-run-lifecycle.test.ts — the sharded `/ci` runner's lifecycle
 * (`scripts/ci-run.ts`): the RUN_ID, exit 64, the run
 * directory and the status file, the main entry and its runner log, and the
 * docker command layer's forms; plus the helper behaviour later proofs rest
 * on, `treeSnapshot`'s option and the fake container
 * interface's image rules (unit proof).
 *
 * Every case drives the runner in process through its injected dependencies
 * under its own `mkdtempSync` roots removed in `afterEach`,
 * with `createFakeClock` for every wait. No case starts a real child process,
 * reads `/proc` or a cgroup, runs docker or reaches the network. Status files,
 * runner logs and run directories come from the runner's own writers or the
 * run-directory builder in `tests/test-helpers/ci-run.ts`; expected texts and
 * values come from the runner's exports, never typed.
 *
 * Related lifecycle cases are grouped by behavior.
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
  dockerDownRefusal,
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
  realScriptFileNames,
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
import { BASE_IMAGE } from '../ci-live/lib/docker.ts'

// ===========================================================================
// the RUN_ID, the run directory and the status file; main and
// the runner log; the docker layer's forms; treeSnapshot's option; the fake
// container interface's image rules
// ===========================================================================

describe('shared runner helpers: ci-run lifecycle', () => {
  /** Test data: a RUN_ID of the contract form. */
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
  // The RUN_ID, the run-directory path and the status file
  // -------------------------------------------------------------------------

  describe('the RUN_ID', () => {
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

  describe('the run-directory path', () => {
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

  describe('the status file', () => {
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
  // Main and the runner log (steps 1–2)
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
        worktreeRoot: buildWorktree(root, { scripts: realScriptFileNames().filter(file => !file.includes('-fmk-real-codex')) }).root,
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

    /**
     * What a case must find untouched: no spawn, no docker operation, no signal sent or trapped, no forbidden
     * dependency, no lock directory. A valid run goes on to step 3 , so a case that lets one through names
     * the lists it may spawn in `spawned`, each also the fake's one docker operation for it.
     */
    function expectNothingElseTouched(rig: MainRig, spawned: readonly (readonly string[])[] = []): void {
      expect(rig.recorder.argvs()).toEqual(spawned)
      expect(rig.docker.operations().map((operation) => operation.argv)).toEqual([...spawned])
      expect(rig.signals.signals()).toEqual([])
      expect(rig.source.handlerCount()).toBe(0)
      expect(rig.forbiddenCalls).toEqual([])
      expect(existsSync(rig.lockDir)).toBe(false)
    }

    /** Test data: docker's error when its daemon does not answer, so a valid run is refused at step 3. */
    const DOCKER_DOWN_ERROR = 'Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?'

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

      // The refusal: phase refused, kind null summary, no details; its NOT RUN line in the log.
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
      // The one valid invocation: it goes on to step 3, where docker answering down refuses it.
      ['no arguments', [] as string[], [dockerAnswersArgs()]],
      ['option words', ['--shards', '7'], []],
      ['spaces and quotes', ['--shards', '7', 'two words', "it's", '"quoted"', `a'b"c`], []],
      ['an empty argument and shell characters', ['', '$HOME', '*', 'a;b', '`x`'], []],
      ['control characters', ['tab\there', 'line\nbreak', 'back\\slash'], []],
    ])('the log\'s first line names the RUN_ID, the PID and the /ci arguments as given (%s), and reads back exactly', async (_what, args, spawned) => {
      const rig = makeMainRig()
      rig.docker.fail('version', { stderr: DOCKER_DOWN_ERROR })
      await main([RUN_ID, ...args], rig.deps)
      const runDir = runDirPath(rig.deps.env, RUN_ID)
      expect(logLines(runDir)[0]).toBe(formatRunnerLogFirstLine(RUN_ID, RUNNER_PID, args))
      expect(readRunnerLogFirstLine(runDir)).toEqual({ runId: RUN_ID, pid: RUNNER_PID, args })
      expectNothingElseTouched(rig, spawned)
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
    ])('a valid invocation (%s) on a valid tree goes on to step 3: docker answering down is refused there as the run\'s last act, only `docker version` spawned, nothing signalled or locked', async (_what, args) => {
      const rig = makeMainRig()
      rig.docker.fail('version', { stderr: DOCKER_DOWN_ERROR })
      expect(await main([RUN_ID, ...args], rig.deps)).toBe(REFUSAL_EXIT_STATUS)
      const runDir = runDirPath(rig.deps.env, RUN_ID)
      const basis = { runId: RUN_ID, pid: RUNNER_PID, startMs: START_MS, deadline: statusDeadline(START_MS, BUILD_ALLOWANCE_MINUTES) }
      const refusal = dockerDownRefusal(DOCKER_DOWN_ERROR)
      expect(logLines(runDir)).toEqual([formatRunnerLogFirstLine(RUN_ID, RUNNER_PID, args), refusalLine(refusal)])
      expect(readdirSync(runDir).sort()).toEqual([RUNNER_LOG_FILE_NAME, STATUS_FILE_NAME].sort())
      expect(readStatusFile(runDir)).toEqual(buildRefusedStatus(basis, refusal))
      expect(rig.stderr).toEqual([])
      expectNothingElseTouched(rig, [dockerAnswersArgs()])
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
  // The docker command layer's fixed forms (contributing to)
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
  /** OWNER's text as Terms write it, `<RUN_ID>-<PID>`, typed from the test data rather than formatted by the runner. */
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
     * values (typed from its inputs and the contract, not from a builder) that the
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
          // `--all`: the sweep needs stopped containers too.
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

    test('the container list holds --all, so it lists stopped containers too', async () => {
      const rig = makeDockerRig()
      expect(await listContainers(rig.ctx)).toEqual({ ok: true, value: [] })
      const [list] = rig.recorder.argvs()
      expect(list?.slice(0, 3)).toEqual(['docker', 'container', 'ls'])
      expect(list).toContain('--all')
    })

    test('the state form selects State.Pid, State.OOMKilled, State.ExitCode and HostConfig.Memory', async () => {
      const rig = makeDockerRig()
      rig.fake.addContainer({ name: 'shard-1' })
      expect((await inspectContainerState(rig.ctx, 'shard-1')).ok).toBe(true)
      const formats = recordedFormats(rig.recorder.argvs())
      expect(formats).toHaveLength(1)
      expect(templateOutputs(formats[0]!)).toEqual(expect.arrayContaining(['.State.Pid', '.State.OOMKilled', '.State.ExitCode', '.HostConfig.Memory']))
    })

    test('the inspection form selects exactly fields', async () => {
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
  // The fake container interface follows Docker's image rules (unit proof)
  // -------------------------------------------------------------------------

  describe('the fake container interface follows Docker\'s image rules', () => {
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
  // treeSnapshot's opt-in option
  // -------------------------------------------------------------------------

  describe('treeSnapshot\'s option', () => {
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

    test('a permission change shows with the option', () => {
      const { tree, file } = makeTree()
      const before = treeSnapshot(tree, { extended: true })
      chmodSync(file, 0o600)
      const after = treeSnapshot(tree, { extended: true })
      expect(fieldsOf(before, 'a.txt')[4]).toBe('0644')
      expect(fieldsOf(after, 'a.txt')[4]).toBe('0600')
    })

    test('a change-time change, content and modification time kept, shows with the option', () => {
      // No wall-clock wait for the file system's coarse timestamps: the
      // field is checked against the entry's own change time on each side.
      const { tree, file } = makeTree()
      const before = fieldsOf(treeSnapshot(tree, { extended: true }), 'a.txt')
      expect(before[5]).toBe(String(lstatSync(file).ctimeMs))
      const other = join(dirname(tree), 'extra-link')
      linkSync(file, other)
      unlinkSync(other)
      const after = fieldsOf(treeSnapshot(tree, { extended: true }), 'a.txt')
      expect(after[5]).toBe(String(lstatSync(file).ctimeMs))
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
// the run's images and tags; adds its cases here
// ===========================================================================
//
// to and the part of the contract.
// The cases compose functions directly (section 12 of
// `scripts/ci-run.ts`), in the order will compose them: there is no run
// sequence before . Every case starts from `makeE8Rig`, which wires a
// constructed worktree, a run directory, the spawn recorder, the fake
// container interface, the signal recorder and a fake clock into the runner's
// dependencies, under one `mkdtempSync` root removed in `afterEach`. Non-docker
// children (npm, git, gh, the base-build step) are answered through the rig's
// `answer*` helpers; docker through the fake. A run-level stop is the run
// state's stop record set directly (`rig.recordStop()`), never a signal from
// the signal source. Credentials are `fakeToken` values. This region's
// imports are a namespace or aliased with `e8`, so no other region's import can
// collide with them.

// --- shared setup (.S1) ---

import { createHash as imageCreateHash } from 'node:crypto'
import * as imageFs from 'node:fs'
import { tmpdir as imageTmpdir } from 'node:os'
import * as imagePath from 'node:path'
import * as imageRunner from '../scripts/ci-run.ts'
import * as imageHelper from './test-helpers/ci-run.ts'
import { assertNoLeak as imageAssertNoLeak, fakeToken as imageFakeToken, writtenFile as imageWrittenFile } from './test-helpers/credentials.ts'
import { createFakeClock as imageCreateFakeClock, type FakeClock as ImageFakeClock } from './test-helpers/fake-clock.ts'
import { treeSnapshot as imageTreeSnapshot } from './test-helpers/tree-snapshot.ts'
import { hostSafeChildEnv as baseBuildHostSafeChildEnv, resolveToolDir as baseBuildResolveToolDir } from './test-helpers/host-safe-env.ts'

describe('image preparation: the run\'s images and tags', () => {
  type BaseBuildDeps = imageRunner.BaseBuildDeps
  type DockerContext = imageRunner.DockerContext
  type Owner = imageRunner.Owner
  type ReadBackContext = imageRunner.ReadBackContext
  type RunImagesContext = imageRunner.RunImagesContext
  type RunLevelStop = imageRunner.RunLevelStop
  type RunnerLogSink = imageRunner.RunnerLogSink
  type RunState = imageRunner.RunState
  type ValidatedRun = imageRunner.ValidatedRun
  type BuiltWorktree = imageHelper.BuiltWorktree
  type FakeDocker = imageHelper.FakeDocker
  type SignalRecorder = imageHelper.SignalRecorder
  type SpawnAnswer = imageHelper.SpawnAnswer
  type SpawnRecorder = imageHelper.SpawnRecorder
  type WorktreeOptions = imageHelper.WorktreeOptions

  const {
    AD_TAG_PREFIX,
    AD_VERSION_ARG_PREFIX,
    adInstallScriptReadArgs,
    adTagCheckArgs,
    baseBuildStepArgs,
    buildRefusal,
    GH_AUTH_TOKEN_ARGV,
    ghPersonalConfigDir,
    initialImageState,
    NPM_PROGRAM,
    npmPackArgs,
    npmPackFailedReason,
    npmPackNoTarballReason,
    PACKAGE_DIR_MODE,
    PACKAGE_DIR_NAME,
    PACKAGE_TARBALL_MODE,
    PACKAGE_TARBALL_SUFFIX,
    packageDirFailedReason,
    packPackage,
    RAW_KEY_PREFIX,
    refusalLine,
    SHA256_HEX_LENGTH,
    SPAWN_FAILED_EXIT_STATUS,
    validateRun,
  } = imageRunner
  const { buildWorktree, createFakeDocker, createSignalRecorder, createSpawnRecorder, makeRunDir } = imageHelper

  /** Test data: the run's RUN_ID, of the contract form. */
  const IMAGE_RUN_ID = '20261008t130000z-e8run001'
  /** Test data: the runner's PID. */
  const IMAGE_RUNNER_PID = 5151
  /** Test data: the fake clock's start. */
  const IMAGE_START_MS = Date.UTC(2026, 9, 8, 13, 0, 0)
  /** The run's owner, `<RUN_ID>-<PID>`: its owner label and run-private tags. */
  const IMAGE_OWNER: Owner = { runId: IMAGE_RUN_ID, pid: IMAGE_RUNNER_PID }
  /** The run's secret values, each a `fakeToken` with its own suffix: the key and `GH_TOKEN` in the runner's environment, and the base-build token `gh auth token` answers by default. */
  const IMAGE_SECRETS = {
    key: imageFakeToken(RAW_KEY_PREFIX, 'e8-key'),
    ghToken: imageFakeToken('', 'e8-gh'),
    baseBuildToken: imageFakeToken('', 'e8-base'),
  } as const
  /** Test data: a run-level stop for `rig.recordStop()`, as the run lifecycle's stop path records one. */
  const IMAGE_STOP: RunLevelStop = { kind: 'interrupt', signal: 'SIGTERM' }
  /** Test data: the tarball's file name as `npm pack` names it (`<name>-<version>.tgz`). */
  const IMAGE_TARBALL_NAME = `e8-test-package-1.2.3${PACKAGE_TARBALL_SUFFIX}`
  /** Test data: the tarball's bytes, every byte value, so the digest is over binary content. */
  const IMAGE_TARBALL_BYTES = Uint8Array.from({ length: 1024 }, (_, i) => (i * 7) % 256)
  /** Test data: what `git show <tag>:install.sh` prints by default. */
  const IMAGE_INSTALL_SCRIPT_TEXT = '#!/usr/bin/env bash\n# agent-director install script (test data)\n'
  /** Where `npmPackArgs` puts its destination, read from the builder rather than typed. */
  const NPM_PACK_DESTINATION_AT = npmPackArgs('<destination>').indexOf('<destination>')

  /** How the scripted `npm pack` behaves (`rig.answerNpmPack`). Default: exit 0, writes `IMAGE_TARBALL_BYTES` as `IMAGE_TARBALL_NAME` into the destination its call names, and prints that name. */
  interface NpmPackScript {
    /** The tarball's bytes. */
    readonly bytes?: string | Uint8Array
    /** The file name it prints by default and writes at by default. */
    readonly fileName?: string
    /** What it leaves at `at`: the tarball (default), nothing, a directory, or a symbolic link to a tarball outside the destination. */
    readonly writes?: 'tarball' | 'nothing' | 'directory' | 'symlink'
    /** Where it writes, relative to the destination its call names; default `fileName`. */
    readonly at?: string
    /** Its standard output; default `<fileName>\n`. */
    readonly stdout?: string
    readonly stderr?: string
    /** Default 0. */
    readonly exitCode?: number
    /** It could not be started: its standard error this text, its exit status `SPAWN_FAILED_EXIT_STATUS`; nothing written. */
    readonly notStarted?: string
  }

  /** What a scripted `npm pack` writes when it writes the tarball. */
  interface NpmPackPlan {
    /** `<package dir>/<fileName>`. */
    readonly tarballPath: string
    readonly bytes: Uint8Array
  }

  interface ImageRigOptions {
    /** `buildWorktree`'s options; default the repository's real scripts and Dockerfile lines. */
    readonly worktree?: WorktreeOptions
    /** Over the default environment (`rig.env`); a variable set to undefined is left out. */
    readonly env?: Readonly<Record<string, string | undefined>>
  }

  /** One image preparation case's world. */
  interface ImageRig {
    /** The case's `mkdtempSync` root, removed in `afterEach`; the spawn recorder's side-effect root. */
    readonly root: string
    /** The constructed system temp directory, the environment's `TMPDIR`. */
    readonly tempDir: string
    readonly worktree: BuiltWorktree
    /** `worktree.root`: the runner's `worktreeRoot`, every child's working directory. */
    readonly worktreeRoot: string
    /** The run directory, made 0700 in `tempDir` as step 1 makes it (`makeRunDir`). */
    readonly runDir: string
    /** `<runDir>/package`, not made: step 5 makes it. */
    readonly packageDir: string
    /** The environment's default `CSCB_AD_SRC_DIR`: an empty directory under the root. */
    readonly adSourceDir: string
    readonly clock: ImageFakeClock
    /** Records every spawn; `assertNoFailures()` is checked in `afterEach`. */
    readonly recorder: SpawnRecorder
    /** The fake container interface over `recorder`, answering every docker form. */
    readonly docker: FakeDocker
    /** The runner's `sendSignal`, delivering through `recorder.processes`. */
    readonly signals: SignalRecorder
    /** The runner's environment, with its unset variables left out: `TMPDIR`, `HOME`, `ANTHROPIC_API_KEY`, `GH_TOKEN`, `CSCB_AD_SRC_DIR`, then `options.env`. Holds secrets: never pass it to `assertNoLeak`. */
    readonly env: Readonly<Record<string, string>>
    readonly owner: Owner
    /** Every line written to `log`, in order. */
    readonly logLines: string[]
    /** The runner-log sink every step gets: it appends to `logLines`, writing no file, so the run directory's snapshot stays the step's own. */
    readonly log: RunnerLogSink
    /** A fresh run state: every field empty, `images` from `initialImageState()`. */
    readonly state: RunState
    /** Steps 4, 5 and 12's dependencies: `spawn`, `env`, `worktreeRoot`, `clock`, `sendSignal` (also a `PackageDeps` and a `BaseImageDeps`). */
    readonly deps: BaseBuildDeps
    /** The docker context: `recorder.spawn`, the environment as children get it, the worktree root. */
    readonly dockerContext: DockerContext
    /** 's context, also cleanup's (`RunImageCleanupContext`): `dockerContext`, `signals.sendSignal`, `owner`, `clock`, `log`. */
    readonly imagesContext: RunImagesContext
    /** The read-back's context for a pinned ID: `dockerContext`, `owner`, `log`. */
    readBackContext(pinnedId: string): ReadBackContext
    /** validation's validation of the worktree with these `/ci` arguments (default none) and the rig's environment; throws on a refusal. */
    validate(args?: readonly string[]): ValidatedRun
    /** Sets the run state's stop record (`IMAGE_STOP` by default), as the run lifecycle's stop path does; a stop already recorded is kept. */
    recordStop(stop?: RunLevelStop): void
    /** Replaces the worktree's `docker/Dockerfile.test` with this text (FROM forms `buildWorktree` cannot make). */
    writeTestDockerfile(text: string): void
    /** The base image the worktree's `docker/Dockerfile.test` names now: its first `FROM` line's image, read by the test, not the runner. */
    baseImageName(): string
    /** `v<AD_VERSION>`, from the worktree's `docker/Dockerfile.test.base` as it is now; throws when it sets none. */
    adTag(): string
    /** Adds the base image (`baseImageName()`) to the fake; answers its ID. */
    addBaseImage(): string
    /** Scripts the next `npm pack` into `packageDir` (once); answers where its tarball is and its bytes. */
    answerNpmPack(script?: NpmPackScript): NpmPackPlan
    /** Scripts the tag check `git -C <adSourceDir> rev-parse … refs/tags/<adTag()>` (default: exit 0). */
    answerAdTagCheck(answer?: SpawnAnswer): void
    /** Scripts `git -C <adSourceDir> show <adTag()>:<install.sh>` (default: exit 0, `IMAGE_INSTALL_SCRIPT_TEXT`). */
    answerInstallScriptRead(answer?: SpawnAnswer): void
    /** Scripts `gh auth token`: `personal` answers the lookup with `GH_CONFIG_DIR` at `<HOME>/.config/gh-personal`, `plain` the one without; one left out is unscripted, so its spawn fails loudly. */
    answerGhToken(answers: { readonly personal?: SpawnAnswer; readonly plain?: SpawnAnswer }): void
    /** Scripts every prerequisite check of a missing base to pass: the tag, `install.sh`, and the personal `gh auth token` printing `token` (default `IMAGE_SECRETS.baseBuildToken`); `null`: both lookups exit 1, no token. */
    answerPrerequisites(token?: string | null): void
    /** Scripts `bash <worktree>/scripts/ci-base-build.sh` (default: exit 0 at once). */
    answerBaseBuildStep(answer?: SpawnAnswer): void
  }

  let imageRoots: string[] = []
  let imageRecorders: SpawnRecorder[] = []

  afterEach(() => {
    const built = imageRecorders
    imageRecorders = []
    for (const root of imageRoots) imageFs.rmSync(root, { recursive: true, force: true })
    imageRoots = []
    for (const recorder of built) recorder.assertNoFailures()
  })

  /** Whether two argument lists are the same. */
  function sameArgv(a: readonly string[], b: readonly string[]): boolean {
    return a.length === b.length && a.every((arg, i) => arg === b[i])
  }

  /** A new image preparation rig under a new `mkdtempSync` root (see `ImageRig`). */
  function makeE8Rig(options: ImageRigOptions = {}): ImageRig {
    const root = imageFs.mkdtempSync(imagePath.join(imageTmpdir(), 'ci-run-lifecycle-e8-'))
    imageRoots.push(root)
    const tempDir = imagePath.join(root, 'tmp')
    const home = imagePath.join(root, 'home')
    const adSourceDir = imagePath.join(root, 'agent-director-src')
    for (const dir of [tempDir, home, adSourceDir]) imageFs.mkdirSync(dir)
    const worktree = buildWorktree(root, options.worktree)
    const worktreeRoot = worktree.root
    const runDir = makeRunDir(tempDir, IMAGE_RUN_ID)
    const packageDir = imagePath.join(runDir, PACKAGE_DIR_NAME)

    const clock = imageCreateFakeClock({ start: IMAGE_START_MS })
    const recorder = createSpawnRecorder({ clock, root })
    imageRecorders.push(recorder)
    const docker = createFakeDocker(recorder)
    const signals = createSignalRecorder({ processes: recorder.processes, clock })

    const given: Record<string, string | undefined> = {
      TMPDIR: tempDir,
      HOME: home,
      ANTHROPIC_API_KEY: IMAGE_SECRETS.key,
      GH_TOKEN: IMAGE_SECRETS.ghToken,
      CSCB_AD_SRC_DIR: adSourceDir,
      ...options.env,
    }
    const env: Record<string, string> = {}
    for (const [name, value] of Object.entries(given)) if (value !== undefined) env[name] = value

    const logLines: string[] = []
    const log: RunnerLogSink = (line) => {
      logLines.push(line)
    }
    const state: RunState = {
      firstStop: null,
      baseImage: null,
      baseBuildToken: null,
      packingStartedAtMs: null,
      tarballPath: null,
      packageSha256: null,
      baseBuildStep: null,
      baseBuildRun: null,
      cleanupFailures: [],
      images: initialImageState(),
      imageBuildInProgress: null,
    }
    const deps: BaseBuildDeps = { spawn: recorder.spawn, env, worktreeRoot, clock, sendSignal: signals.sendSignal }
    const dockerContext: DockerContext = { spawn: recorder.spawn, env: { ...env }, cwd: worktreeRoot }
    const imagesContext: RunImagesContext = { docker: dockerContext, sendSignal: signals.sendSignal, owner: IMAGE_OWNER, clock, log }

    const baseImageName = (): string => {
      const text = imageFs.readFileSync(worktree.testDockerfilePath, 'utf-8')
      const from = /^FROM\s+(\S+)/m.exec(text)
      if (from === null) throw new Error('makeE8Rig: the worktree\'s docker/Dockerfile.test has no FROM line')
      return from[1]!
    }
    const adTag = (): string => {
      const text = imageFs.readFileSync(worktree.baseDockerfilePath, 'utf-8')
      const line = text.split('\n').find((candidate) => candidate.startsWith(AD_VERSION_ARG_PREFIX))
      const version = line?.slice(AD_VERSION_ARG_PREFIX.length) ?? ''
      if (version === '') throw new Error('makeE8Rig: the worktree\'s docker/Dockerfile.test.base sets no AD_VERSION')
      return `${AD_TAG_PREFIX}${version}`
    }
    const answerGhToken = (answers: { readonly personal?: SpawnAnswer; readonly plain?: SpawnAnswer }): void => {
      const isLookup = (argv: readonly string[]): boolean => sameArgv(argv, GH_AUTH_TOKEN_ARGV)
      if (answers.personal !== undefined) recorder.answerWhen((r) => isLookup(r.argv) && r.env.GH_CONFIG_DIR === ghPersonalConfigDir(env), answers.personal)
      if (answers.plain !== undefined) recorder.answerWhen((r) => isLookup(r.argv) && r.env.GH_CONFIG_DIR === undefined, answers.plain)
    }

    return {
      root,
      tempDir,
      worktree,
      worktreeRoot,
      runDir,
      packageDir,
      adSourceDir,
      clock,
      recorder,
      docker,
      signals,
      env,
      owner: IMAGE_OWNER,
      logLines,
      log,
      state,
      deps,
      dockerContext,
      imagesContext,
      readBackContext: (pinnedId) => ({ docker: dockerContext, owner: IMAGE_OWNER, pinnedId, log }),
      validate(args = []) {
        const validation = validateRun(args, worktreeRoot, env)
        if (!validation.ok) throw new Error(`makeE8Rig: validation refused: ${refusalLine(validation.refusal)}`)
        return validation.validated
      },
      recordStop(stop = IMAGE_STOP) {
        if (state.firstStop === null) state.firstStop = stop
      },
      writeTestDockerfile(text) {
        imageFs.writeFileSync(worktree.testDockerfilePath, text)
      },
      baseImageName,
      adTag,
      addBaseImage: () => docker.addImage({ tags: [baseImageName()] }),
      answerNpmPack(script = {}) {
        const fileName = script.fileName ?? IMAGE_TARBALL_NAME
        const bytes = typeof script.bytes === 'string' ? new TextEncoder().encode(script.bytes) : (script.bytes ?? IMAGE_TARBALL_BYTES)
        const at = script.at ?? fileName
        const writes = script.writes ?? 'tarball'
        const answer: SpawnAnswer =
          script.notStarted !== undefined
            ? { notStarted: script.notStarted }
            : {
                exitCode: script.exitCode ?? 0,
                stdout: script.stdout ?? `${fileName}\n`,
                ...(script.stderr === undefined ? {} : { stderr: script.stderr }),
                // Fires at the spawn; the runner looks for the tarball only after the result.
                sideEffect: (files, request) => {
                  const path = imagePath.join(request.argv[NPM_PACK_DESTINATION_AT]!, at)
                  if (writes === 'tarball') files.writeFile(path, bytes)
                  else if (writes === 'directory') files.makeDirectory(path)
                  else if (writes === 'symlink') {
                    const target = files.writeFile(imagePath.join(files.root, `outside-${fileName}`), bytes)
                    files.makeDirectory(imagePath.dirname(path))
                    imageFs.symlinkSync(target, path)
                  }
                },
              }
        recorder.answer(npmPackArgs(packageDir), answer, { times: 1 })
        return { tarballPath: imagePath.join(packageDir, fileName), bytes }
      },
      answerAdTagCheck(answer = {}) {
        recorder.answer(adTagCheckArgs(adSourceDir, adTag()), answer)
      },
      answerInstallScriptRead(answer = { stdout: IMAGE_INSTALL_SCRIPT_TEXT }) {
        recorder.answer(adInstallScriptReadArgs(adSourceDir, adTag()), answer)
      },
      answerGhToken,
      answerPrerequisites(token = IMAGE_SECRETS.baseBuildToken) {
        recorder.answer(adTagCheckArgs(adSourceDir, adTag()), {})
        recorder.answer(adInstallScriptReadArgs(adSourceDir, adTag()), { stdout: IMAGE_INSTALL_SCRIPT_TEXT })
        if (token === null) answerGhToken({ personal: { exitCode: 1 }, plain: { exitCode: 1 } })
        else answerGhToken({ personal: { stdout: `${token}\n` } })
      },
      answerBaseBuildStep(answer = {}) {
        recorder.answer(baseBuildStepArgs(worktreeRoot), answer)
      },
    }
  }

  // --- package (.S1) ---

  describe('step 5: the package', () => {
    /** Each output a package case checks for a leak: the stage, the run state, the runner log and every file under the run directory. */
    function packageOutputs(rig: ImageRig, stage: unknown): unknown {
      return { stage, state: rig.state, logLines: rig.logLines, runDir: imageWrittenFile(rig.runDir) }
    }

    test('PACKAGE_TARBALL_MODE is 0444, read-only for all (pin)', () => {
      expect(PACKAGE_TARBALL_MODE).toBe(0o444)
    })

    test('npm pack is spawned once, in the worktree, with the runner\'s environment unchanged and the run\'s package/ (0700) as destination', async () => {
      const rig = makeE8Rig()
      rig.answerNpmPack()
      const stage = await packPackage(rig.deps, rig.runDir, rig.state)
      expect(stage.ok).toBe(true)

      const destination = imagePath.join(rig.runDir, PACKAGE_DIR_NAME)
      const spawns = rig.recorder.spawns()
      expect(spawns.map((s) => ({ argv: s.argv, cwd: s.cwd, env: s.env, ownProcessGroup: s.ownProcessGroup, stdin: s.stdin }))).toEqual([
        { argv: npmPackArgs(destination), cwd: rig.worktreeRoot, env: rig.env, ownProcessGroup: false, stdin: null },
      ])
      const [argv] = rig.recorder.argvs()
      expect(argv?.[0]).toBe(NPM_PROGRAM)
      expect(argv).toContain(destination)
      // npm's own flag: lifecycle scripts skipped, so packing runs no package script in the worktree.
      expect(argv).toContain('--ignore-scripts')
      expect(imageFs.lstatSync(destination).mode & 0o7777).toBe(PACKAGE_DIR_MODE)
      expect(rig.state.packingStartedAtMs).toBe(IMAGE_START_MS)
      expect(rig.docker.operations()).toEqual([])
      expect(rig.logLines).toEqual([])
      imageAssertNoLeak(packageOutputs(rig, stage))
    })

    test('the tarball npm names is left under package/, mode 0444, its bytes unchanged and its recorded SHA-256 the digest of those bytes', async () => {
      const rig = makeE8Rig()
      const plan = rig.answerNpmPack()
      const stage = await packPackage(rig.deps, rig.runDir, rig.state)

      const digest = imageCreateHash('sha256').update(plan.bytes).digest('hex')
      expect(digest).toHaveLength(SHA256_HEX_LENGTH)
      expect(plan.tarballPath).toBe(imagePath.join(rig.runDir, PACKAGE_DIR_NAME, IMAGE_TARBALL_NAME))
      expect(stage).toEqual({ ok: true, packed: { tarballPath: plan.tarballPath, packageSha256: digest } })
      expect([rig.state.tarballPath, rig.state.packageSha256]).toEqual([plan.tarballPath, digest])
      expect(imageFs.readdirSync(rig.packageDir)).toEqual([IMAGE_TARBALL_NAME])
      expect(imageFs.lstatSync(plan.tarballPath).isFile()).toBe(true)
      expect(imageFs.lstatSync(plan.tarballPath).mode & 0o7777).toBe(PACKAGE_TARBALL_MODE)
      expect([...imageFs.readFileSync(plan.tarballPath)]).toEqual([...plan.bytes])
      imageAssertNoLeak(packageOutputs(rig, stage))
    })

    test('packing writes nothing into the worktree: its snapshot, with the option, is the same before and after', async () => {
      const rig = makeE8Rig()
      rig.answerNpmPack()
      const before = imageTreeSnapshot(rig.worktreeRoot, { extended: true })
      const stage = await packPackage(rig.deps, rig.runDir, rig.state)
      expect(stage.ok).toBe(true)
      expect(imageTreeSnapshot(rig.worktreeRoot, { extended: true })).toEqual(before)
      imageAssertNoLeak({ stage, logLines: rig.logLines })
    })

    /** Test data: npm's error output, its last line the one a refusal names. */
    const NPM_ERROR_LINE = 'npm error JSON.parse Invalid package.json: Unexpected end of JSON input'
    const NPM_ERROR_OUTPUT = `npm error code EJSONPARSE\n${NPM_ERROR_LINE}\n`
    /** Test data: why npm could not be started. */
    const NPM_NOT_STARTED = 'spawn npm ENOENT'

    /** One failure form: the scripted `npm pack`; the refusal's reason, from the runner's builder over the row's own data; and that data, each piece of which the reason must hold. */
    const FAILURES: readonly (readonly [string, NpmPackScript, (rig: ImageRig) => { readonly reason: string; readonly names: readonly string[] }])[] = [
      ['a non-zero exit with error output', { exitCode: 1, stdout: '', stderr: NPM_ERROR_OUTPUT, writes: 'nothing' }, () => ({ reason: npmPackFailedReason(1, NPM_ERROR_LINE), names: ['1', NPM_ERROR_LINE] })],
      ['a non-zero exit with no error output', { exitCode: 254, stdout: '', writes: 'nothing' }, () => ({ reason: npmPackFailedReason(254, null), names: ['254'] })],
      ['a non-zero exit after writing and naming a tarball', { exitCode: 1, stderr: NPM_ERROR_OUTPUT }, () => ({ reason: npmPackFailedReason(1, NPM_ERROR_LINE), names: ['1', NPM_ERROR_LINE] })],
      [
        'an npm that could not be started',
        { notStarted: NPM_NOT_STARTED },
        () => ({ reason: npmPackFailedReason(SPAWN_FAILED_EXIT_STATUS, NPM_NOT_STARTED), names: [String(SPAWN_FAILED_EXIT_STATUS), NPM_NOT_STARTED] }),
      ],
      ['exit 0 with no output and no tarball', { stdout: '', writes: 'nothing' }, (rig) => ({ reason: npmPackNoTarballReason(rig.packageDir), names: [rig.packageDir] })],
      ['exit 0 naming a tarball it did not write', { writes: 'nothing' }, (rig) => ({ reason: npmPackNoTarballReason(rig.packageDir), names: [rig.packageDir] })],
      ['exit 0 naming a written file that is not a .tgz', { fileName: 'e8-test-package-1.2.3.tar' }, (rig) => ({ reason: npmPackNoTarballReason(rig.packageDir), names: [rig.packageDir] })],
      [
        'exit 0 naming a tarball outside package/ by a path',
        { at: `../${IMAGE_TARBALL_NAME}`, stdout: `../${IMAGE_TARBALL_NAME}\n` },
        (rig) => ({ reason: npmPackNoTarballReason(rig.packageDir), names: [rig.packageDir] }),
      ],
      ['exit 0 naming a directory', { writes: 'directory' }, (rig) => ({ reason: npmPackNoTarballReason(rig.packageDir), names: [rig.packageDir] })],
      ['exit 0 naming a symbolic link to a tarball', { writes: 'symlink' }, (rig) => ({ reason: npmPackNoTarballReason(rig.packageDir), names: [rig.packageDir] })],
    ]

    test.each(FAILURES)('%s is a not-runnable refusal naming it, with no packageSha256', async (_what, script, expected) => {
      const rig = makeE8Rig()
      rig.answerNpmPack(script)
      const stage = await packPackage(rig.deps, rig.runDir, rig.state)
      const { reason, names } = expected(rig)
      expect(stage).toEqual({ ok: false, refusal: buildRefusal(null, reason) })
      if (!stage.ok) {
        expect(stage.refusal.kind).toBeNull()
        for (const name of names) expect(refusalLine(stage.refusal)).toContain(name)
      }
      expect([rig.state.tarballPath, rig.state.packageSha256]).toEqual([null, null])
      expect(rig.state.packingStartedAtMs).toBe(IMAGE_START_MS)
      expect(rig.recorder.argvs()).toEqual([npmPackArgs(rig.packageDir)])
      imageAssertNoLeak(packageOutputs(rig, stage))
    })

    test('a package/ already in the run directory is a refusal naming it, and npm pack is never spawned', async () => {
      const rig = makeE8Rig()
      imageFs.mkdirSync(rig.packageDir)
      const stage = await packPackage(rig.deps, rig.runDir, rig.state)
      expect(stage.ok).toBe(false)
      if (!stage.ok) {
        expect(stage.refusal.kind).toBeNull()
        expect(stage.refusal.summary.startsWith(packageDirFailedReason(rig.packageDir, ''))).toBe(true)
      }
      expect([rig.state.tarballPath, rig.state.packageSha256]).toEqual([null, null])
      expect(rig.recorder.spawns()).toEqual([])
      imageAssertNoLeak(packageOutputs(rig, stage))
    })
  })

  // --- base image: step 4, the step file, step 12 (.S2-S4) ---

  describe('the base image: step 4, the base-build step and step 12', () => {
    const {
      AD_INSTALL_SCRIPT_PATH,
      AD_SOURCE_DIR_VARIABLE,
      adInstallScriptUnreadableReason,
      adSourceDirUnsetReason,
      adTagMissingReason,
      adVersionMissingReason,
      BASE_BUILD_STEP_PATH,
      BASE_DOCKERFILE_PATH,
      baseBuildTokenBadReason,
      baseBuiltMeanwhileLine,
      baseImageBuildFailedLine,
      baseRecheckFailedLine,
      checkBaseImage,
      DOCKER_PROGRAM,
      GIT_PROGRAM,
      imageBuildFailure,
      runBaseBuild,
      SECRET_MIN_LENGTH,
      secretCredentialSet,
      TEST_DOCKERFILE_PATH,
      testDockerfileFromCountReason,
      testDockerfileFromNameReason,
      testDockerfileUnreadableReason,
    } = imageRunner

    /** A marker standing for a value the test cannot know (an operating-system or daemon error), to split a runner text built around it. */
    const BASE_BUILD_MARK = '<e8b-mark>'
    /** Test data: a base image other than the repository's. */
    const BASE_BUILD_OTHER_BASE = 'e8b-other-base:v99'
    /** Test data: git's error line on a failed read. */
    const BASE_BUILD_GIT_ERROR = 'fatal: e8b test error: no such object'

    /** That `actual` is the runner text `built` (made with `BASE_BUILD_MARK` for the unknown part) around some non-empty value. */
    function expectFramed(actual: string, built: string): void {
      const [head, tail, ...rest] = built.split(BASE_BUILD_MARK)
      expect(rest).toEqual([])
      expect(actual.startsWith(head!)).toBe(true)
      expect(actual.endsWith(tail!)).toBe(true)
      expect(actual.length).toBeGreaterThan(head!.length + tail!.length)
    }

    /** Every spawn that is not docker, in order: the git checks, the token lookups and the base-build step. */
    function nonDockerArgvs(rig: ImageRig): (readonly string[])[] {
      return rig.recorder.argvs().filter((argv) => argv[0] !== DOCKER_PROGRAM)
    }

    /** Every docker operation as its kind and the refs it names. */
    function dockerOperationRefs(rig: ImageRig): { readonly kind: string; readonly refs: readonly string[] }[] {
      return rig.docker.operations().map((op) => ({ kind: op.kind, refs: op.refs }))
    }

    /** The two read-only git checks of a missing base, as the runner builds them. */
    function gitChecks(rig: ImageRig): (readonly string[])[] {
      return [adTagCheckArgs(rig.adSourceDir, rig.adTag()), adInstallScriptReadArgs(rig.adSourceDir, rig.adTag())]
    }

    describe('step 4: the base image\'s name, existence and prerequisites', () => {
      const FROM_FORMS: readonly (readonly [string, string])[] = [
        ['a FROM naming another tag', `FROM ${BASE_BUILD_OTHER_BASE}\n`],
        ['a FROM with a flag and a stage name', `FROM --platform=linux/amd64 ${BASE_BUILD_OTHER_BASE} AS test\n`],
        ['a lower-case from continued onto the next line, after a comment', `# the base\nfrom \\\n  ${BASE_BUILD_OTHER_BASE}\n`],
      ]

      test.each(FROM_FORMS)('%s: the image it names is the one inspected, and found present', async (_form, text) => {
        const rig = makeE8Rig()
        rig.writeTestDockerfile(text)
        rig.docker.addImage({ tags: [BASE_BUILD_OTHER_BASE] })
        const stage = await checkBaseImage(rig.deps, rig.state)
        expect(stage).toEqual({ ok: true, check: { kind: 'present', image: BASE_BUILD_OTHER_BASE }, baseBuildToken: null, secrets: secretCredentialSet(rig.env) })
        expect(dockerOperationRefs(rig)).toEqual([{ kind: 'image-inspect', refs: [BASE_BUILD_OTHER_BASE] }])
        imageAssertNoLeak({ stage: { ...stage, secrets: null }, logLines: rig.logLines })
      })

      test('with the base present the spawn record shows only the existence query: no prerequisite check and no token lookup', async () => {
        const rig = makeE8Rig()
        rig.addBaseImage()
        const before = imageTreeSnapshot(rig.worktreeRoot, { extended: true })
        const stage = await checkBaseImage(rig.deps, rig.state)
        const image = rig.baseImageName()
        expect(stage.ok).toBe(true)
        expect(rig.state.baseImage).toEqual({ kind: 'present', image })
        expect(rig.state.baseBuildToken).toBeNull()
        expect(rig.recorder.spawns()).toHaveLength(1)
        expect(dockerOperationRefs(rig)).toEqual([{ kind: 'image-inspect', refs: [image] }])
        expect(nonDockerArgvs(rig)).toEqual([])
        expect(imageTreeSnapshot(rig.worktreeRoot, { extended: true })).toEqual(before)
        expect(rig.logLines).toEqual([])
        expect(stage.ok && stage.secrets).toEqual(secretCredentialSet(rig.env))
        imageAssertNoLeak({ stage: { ...stage, secrets: null }, logLines: rig.logLines })
      })

      /** Test data: a daemon's one-line error for a failed existence query. */
      const BASE_BUILD_INSPECT_ERROR = 'Error response from daemon: e8b base inspect failure (test data)'
      /** Test data: why docker could not be started. */
      const BASE_BUILD_DOCKER_NOT_STARTED = 'spawn docker ENOENT'

      /** One failed existence query: how it fails, and the error text the refusal must hold. */
      const FAILED_EXISTENCE_QUERIES: readonly (readonly [string, (rig: ImageRig) => void, string])[] = [
        ['docker exits non-zero', (rig) => rig.docker.fail('image-inspect', { stderr: `${BASE_BUILD_INSPECT_ERROR}\n` }), BASE_BUILD_INSPECT_ERROR],
        ['docker cannot be started', (rig) => rig.recorder.answer(imageRunner.imageInspectArgs([rig.baseImageName()]), { notStarted: BASE_BUILD_DOCKER_NOT_STARTED }), BASE_BUILD_DOCKER_NOT_STARTED],
      ]

      test.each(FAILED_EXISTENCE_QUERIES)('an existence query where %s refuses as not runnable, naming the base and the error; no outcome is recorded and no prerequisite check or token lookup is spawned', async (_what, arrange, error) => {
        const rig = makeE8Rig()
        arrange(rig)
        const image = rig.baseImageName()
        const before = imageTreeSnapshot(rig.worktreeRoot, { extended: true })
        const stage = await checkBaseImage(rig.deps, rig.state)

        expect(stage.ok).toBe(false)
        if (!stage.ok) {
          expect([stage.refusal.kind, stage.refusal.details]).toEqual([null, []])
          expectFramed(stage.refusal.summary, imageRunner.baseImageCheckFailedReason(image, BASE_BUILD_MARK))
          expect(stage.refusal.summary).toContain(error)
          expect(refusalLine(stage.refusal)).toContain(image)
        }
        expect([rig.state.baseImage, rig.state.baseBuildToken]).toEqual([null, null])
        expect(rig.recorder.argvs()).toEqual([imageRunner.imageInspectArgs([image])])
        expect(nonDockerArgvs(rig)).toEqual([])
        expect(imageTreeSnapshot(rig.worktreeRoot, { extended: true })).toEqual(before)
        expect(rig.logLines).toEqual([])
        imageAssertNoLeak({ stage, logLines: rig.logLines })
      })

      /** One bad `docker/Dockerfile.test`: how to make it, and the reason, from the runner's builder (`BASE_BUILD_MARK` for an operating-system error). */
      const BAD_TEST_DOCKERFILES: readonly (readonly [string, ImageRigOptions, ((rig: ImageRig) => void) | null, string])[] = [
        ['a missing docker/Dockerfile.test', { worktree: { dockerfiles: { test: 'absent' } } }, null, testDockerfileUnreadableReason(BASE_BUILD_MARK)],
        ['a docker/Dockerfile.test that is a directory', { worktree: { dockerfiles: { test: 'absent' } } }, (rig) => imageFs.mkdirSync(rig.worktree.testDockerfilePath), testDockerfileUnreadableReason(BASE_BUILD_MARK)],
        ['no FROM instruction', {}, (rig) => rig.writeTestDockerfile('# no base\nRUN true\n'), testDockerfileFromCountReason(0)],
        ['two FROM instructions', {}, (rig) => rig.writeTestDockerfile(`FROM ${BASE_BUILD_OTHER_BASE}\nFROM ${BASE_BUILD_OTHER_BASE}-2\n`), testDockerfileFromCountReason(2)],
        ['a FROM naming the image by a variable', {}, (rig) => rig.writeTestDockerfile('FROM ${BASE_BUILD_BASE}\n'), testDockerfileFromNameReason('FROM ${BASE_BUILD_BASE}')],
        ['a FROM naming no image', {}, (rig) => rig.writeTestDockerfile('FROM\n'), testDockerfileFromNameReason('FROM')],
      ]

      test.each(BAD_TEST_DOCKERFILES)('%s refuses as not runnable, naming docker/Dockerfile.test, and spawns nothing', async (_form, options, setup, reason) => {
        const rig = makeE8Rig(options)
        setup?.(rig)
        const stage = await checkBaseImage(rig.deps, rig.state)
        expect(stage.ok).toBe(false)
        if (!stage.ok) {
          expect(stage.refusal.kind).toBeNull()
          expect(stage.refusal.details).toEqual([])
          if (reason.includes(BASE_BUILD_MARK)) expectFramed(stage.refusal.summary, reason)
          else expect(stage.refusal).toEqual(buildRefusal(null, reason))
          expect(refusalLine(stage.refusal)).toContain(TEST_DOCKERFILE_PATH)
        }
        expect(rig.recorder.spawns()).toEqual([])
        expect(rig.state.baseImage).toBeNull()
        imageAssertNoLeak({ stage, logLines: rig.logLines })
      })

      /** A short base-build token, cut from a `fakeToken` value: one character under the minimum. */
      const SHORT_TOKEN = imageFakeToken('', 'e8b-short').slice(0, SECRET_MIN_LENGTH - 1)

      /** One failing prerequisite of a missing base: the rig, its scripted checks, the reason (runner builder), what it must name, and the non-docker spawns up to it. */
      interface FailingPrerequisite {
        readonly options?: ImageRigOptions
        readonly script: (rig: ImageRig) => void
        readonly reason: (rig: ImageRig, image: string) => string
        readonly names: (rig: ImageRig) => readonly string[]
        readonly spawned: (rig: ImageRig) => readonly (readonly string[])[]
      }

      const AD_VERSION_NAMES = (): readonly string[] => [BASE_DOCKERFILE_PATH, AD_VERSION_ARG_PREFIX.slice(0, -1)]
      /** Rewrites the base Dockerfile's `ARG AD_VERSION=<version>` line, its version kept, into a form Docker accepts but the step's `sed -n 's/^ARG AD_VERSION=//p'` does not read. */
      function rewriteAdVersionLine(rig: ImageRig, form: (line: string) => string): void {
        const lines = imageFs.readFileSync(rig.worktree.baseDockerfilePath, 'utf-8').split('\n')
        const at = lines.findIndex((line) => line.startsWith(AD_VERSION_ARG_PREFIX))
        if (at < 0 || lines[at] === AD_VERSION_ARG_PREFIX) throw new Error('rewriteAdVersionLine: the base Dockerfile sets no ARG AD_VERSION=<version>')
        lines[at] = form(lines[at]!)
        imageFs.writeFileSync(rig.worktree.baseDockerfilePath, lines.join('\n'))
      }
      /** A row whose base Dockerfile sets `AD_VERSION` only in a form the step does not read: refused as no `ARG AD_VERSION`, before any git spawn. */
      const unreadAdVersion = (form: (line: string) => string): FailingPrerequisite => ({
        script: (rig) => rewriteAdVersionLine(rig, form),
        reason: (_rig, image) => adVersionMissingReason(image, null),
        names: AD_VERSION_NAMES,
        spawned: () => [],
      })
      const FAILING_PREREQUISITES: readonly (readonly [string, FailingPrerequisite])[] = [
        ['ARG AD_VERSION= indented (Docker reads it; the step\'s sed does not)', unreadAdVersion((line) => `  ${line}`)],
        ['a lower-case arg AD_VERSION= (Docker reads it; the step\'s sed does not)', unreadAdVersion((line) => `arg${line.slice('ARG'.length)}`)],
        ['ARG AD_VERSION empty', { options: { worktree: { dockerfiles: { adVersion: 'empty' } } }, script: () => undefined, reason: (_rig, image) => adVersionMissingReason(image, null), names: AD_VERSION_NAMES, spawned: () => [] }],
        ['ARG AD_VERSION absent', { options: { worktree: { dockerfiles: { adVersion: 'absent' } } }, script: () => undefined, reason: (_rig, image) => adVersionMissingReason(image, null), names: AD_VERSION_NAMES, spawned: () => [] }],
        ['docker/Dockerfile.test.base missing', { options: { worktree: { dockerfiles: { base: 'absent' } } }, script: () => undefined, reason: (_rig, image) => adVersionMissingReason(image, null), names: AD_VERSION_NAMES, spawned: () => [] }],
        [
          'CSCB_AD_SRC_DIR unset',
          { options: { env: { CSCB_AD_SRC_DIR: undefined } }, script: () => undefined, reason: (rig, image) => adSourceDirUnsetReason(image, rig.adTag()), names: (rig) => [AD_SOURCE_DIR_VARIABLE, rig.adTag()], spawned: () => [] },
        ],
        [
          'CSCB_AD_SRC_DIR empty',
          { options: { env: { CSCB_AD_SRC_DIR: '' } }, script: () => undefined, reason: (rig, image) => adSourceDirUnsetReason(image, rig.adTag()), names: (rig) => [AD_SOURCE_DIR_VARIABLE, rig.adTag()], spawned: () => [] },
        ],
        [
          'no tag v<AD_VERSION> in the checkout',
          {
            script: (rig) => rig.answerAdTagCheck({ exitCode: 1, stderr: `${BASE_BUILD_GIT_ERROR}\n` }),
            reason: (rig, image) => adTagMissingReason(image, rig.adSourceDir, rig.adTag(), BASE_BUILD_GIT_ERROR),
            names: (rig) => [AD_SOURCE_DIR_VARIABLE, rig.adSourceDir, rig.adTag(), BASE_BUILD_GIT_ERROR],
            spawned: (rig) => gitChecks(rig).slice(0, 1),
          },
        ],
        [
          'install.sh unreadable at that tag',
          {
            script: (rig) => {
              rig.answerAdTagCheck()
              rig.answerInstallScriptRead({ exitCode: 128, stderr: `${BASE_BUILD_GIT_ERROR}\n` })
            },
            reason: (rig, image) => adInstallScriptUnreadableReason(image, rig.adSourceDir, rig.adTag(), BASE_BUILD_GIT_ERROR),
            names: (rig) => [AD_INSTALL_SCRIPT_PATH, rig.adSourceDir, rig.adTag(), BASE_BUILD_GIT_ERROR],
            spawned: gitChecks,
          },
        ],
        [
          'a base-build token shorter than the minimum',
          {
            script: (rig) => rig.answerPrerequisites(SHORT_TOKEN),
            reason: (_rig, image) => baseBuildTokenBadReason(image),
            names: () => [GH_AUTH_TOKEN_ARGV.join(' '), String(SECRET_MIN_LENGTH)],
            spawned: (rig) => [...gitChecks(rig), GH_AUTH_TOKEN_ARGV],
          },
        ],
      ]

      test.each(FAILING_PREREQUISITES)('a missing base with %s refuses as not runnable, naming the check; git only reads, and the worktree is unchanged', async (_check, row) => {
        const rig = makeE8Rig(row.options)
        row.script(rig)
        const image = rig.baseImageName()
        const worktreeBefore = imageTreeSnapshot(rig.worktreeRoot, { extended: true })
        const sourceBefore = imageTreeSnapshot(rig.adSourceDir, { extended: true })
        const stage = await checkBaseImage(rig.deps, rig.state)

        expect(stage).toEqual({ ok: false, refusal: buildRefusal(null, row.reason(rig, image)) })
        if (!stage.ok) for (const name of [image, ...row.names(rig)]) expect(refusalLine(stage.refusal)).toContain(name)
        expect(rig.state.baseImage).toEqual({ kind: 'missing', image, missingAtMs: IMAGE_START_MS })
        expect(dockerOperationRefs(rig)).toEqual([{ kind: 'image-inspect', refs: [image] }])
        expect(nonDockerArgvs(rig)).toEqual(row.spawned(rig).map((argv) => [...argv]))
        for (const argv of nonDockerArgvs(rig).filter((a) => a[0] === GIT_PROGRAM)) for (const word of ['fetch', 'pull', 'clone']) expect(argv).not.toContain(word)
        expect(imageTreeSnapshot(rig.worktreeRoot, { extended: true })).toEqual(worktreeBefore)
        expect(imageTreeSnapshot(rig.adSourceDir, { extended: true })).toEqual(sourceBefore)
        const outputs = { stage, logLines: rig.logLines }
        imageAssertNoLeak(outputs)
        expect(JSON.stringify(outputs)).not.toContain(SHORT_TOKEN)
      })

      test('a short token is recorded in the run state, though it refuses', async () => {
        const rig = makeE8Rig()
        rig.answerPrerequisites(SHORT_TOKEN)
        expect((await checkBaseImage(rig.deps, rig.state)).ok).toBe(false)
        expect(rig.state.baseBuildToken).toBe(SHORT_TOKEN)
      })

      const EMPTY_TOKEN_RESULTS: readonly (readonly [string, (rig: ImageRig) => void, number])[] = [
        ['both lookups fail', (rig) => rig.answerPrerequisites(null), 2],
        [
          'both lookups print nothing',
          (rig) => {
            rig.answerAdTagCheck()
            rig.answerInstallScriptRead()
            rig.answerGhToken({ personal: { stdout: '' }, plain: { stdout: '\n' } })
          },
          2,
        ],
      ]

      test.each(EMPTY_TOKEN_RESULTS)('an empty token result (%s) does not refuse, and adds no secret', async (_form, script, lookups) => {
        const rig = makeE8Rig()
        script(rig)
        const stage = await checkBaseImage(rig.deps, rig.state)
        expect(stage).toEqual({ ok: true, check: { kind: 'missing', image: rig.baseImageName(), missingAtMs: IMAGE_START_MS }, baseBuildToken: null, secrets: secretCredentialSet(rig.env) })
        expect(rig.state.baseBuildToken).toBeNull()
        expect(nonDockerArgvs(rig).filter((argv) => sameArgv(argv, GH_AUTH_TOKEN_ARGV))).toHaveLength(lookups)
        imageAssertNoLeak({ stage: { ...stage, secrets: null }, logLines: rig.logLines })
      })

      test('a token of exactly SECRET_MIN_LENGTH characters does not refuse', async () => {
        const token = imageFakeToken('', 'e8b-edge').slice(0, SECRET_MIN_LENGTH)
        const rig = makeE8Rig()
        rig.answerPrerequisites(token)
        const stage = await checkBaseImage(rig.deps, rig.state)
        expect(stage.ok).toBe(true)
        expect(rig.state.baseBuildToken).toBe(token)
      })

      test('with every check passing there is no refusal: "missing" is recorded with its fake-clock moment, and the found token joins the secret set', async () => {
        const rig = makeE8Rig()
        rig.answerPrerequisites()
        const advancedMs = 4321
        await rig.clock.advance(advancedMs)
        const image = rig.baseImageName()
        const worktreeBefore = imageTreeSnapshot(rig.worktreeRoot, { extended: true })
        const sourceBefore = imageTreeSnapshot(rig.adSourceDir, { extended: true })
        const stage = await checkBaseImage(rig.deps, rig.state)

        const check = { kind: 'missing', image, missingAtMs: IMAGE_START_MS + advancedMs } as const
        const secrets = secretCredentialSet(rig.env, { baseBuildToken: IMAGE_SECRETS.baseBuildToken })
        expect(stage).toEqual({ ok: true, check, baseBuildToken: IMAGE_SECRETS.baseBuildToken, secrets })
        expect([...secrets].sort()).toEqual([IMAGE_SECRETS.key, IMAGE_SECRETS.ghToken, IMAGE_SECRETS.baseBuildToken].sort())
        expect(rig.state.baseImage).toEqual(check)
        expect(rig.state.baseBuildToken).toBe(IMAGE_SECRETS.baseBuildToken)

        // Only the existence query, the two read-only git checks and one token lookup; every git child in the worktree with the runner's environment.
        expect(dockerOperationRefs(rig)).toEqual([{ kind: 'image-inspect', refs: [image] }])
        expect(nonDockerArgvs(rig)).toEqual([...gitChecks(rig), GH_AUTH_TOKEN_ARGV].map((argv) => [...argv]))
        const gitSpawns = rig.recorder.spawns().filter((s) => s.argv[0] === GIT_PROGRAM)
        expect(gitSpawns.map((s) => ({ cwd: s.cwd, env: s.env, ownProcessGroup: s.ownProcessGroup, stdin: s.stdin }))).toEqual(
          gitSpawns.map(() => ({ cwd: rig.worktreeRoot, env: rig.env, ownProcessGroup: false, stdin: null })),
        )
        for (const s of gitSpawns) for (const word of ['fetch', 'pull', 'clone']) expect(s.argv).not.toContain(word)
        expect(imageTreeSnapshot(rig.worktreeRoot, { extended: true })).toEqual(worktreeBefore)
        expect(imageTreeSnapshot(rig.adSourceDir, { extended: true })).toEqual(sourceBefore)
        expect(rig.logLines).toEqual([])
        imageAssertNoLeak({ check: stage.ok ? stage.check : null, logLines: rig.logLines })
      })
    })

    describe('the base-build step, scripts/ci-base-build.sh: its content and exit contract (step audit)', () => {
      /** The repository's root: the real step is read and run from here. */
      const BASE_BUILD_REPO_ROOT = imagePath.join(import.meta.dir, '..')
      /** The real step, the subject. */
      const STEP_PATH = imagePath.join(BASE_BUILD_REPO_ROOT, BASE_BUILD_STEP_PATH)
      const STEP_TEXT = imageFs.readFileSync(STEP_PATH, 'utf-8')
      /** Test data: the /ci skill, whose base-build commands the step moved. */
      const CI_SKILL_PATH = '.claude/skills/ci/SKILL.md'
      /** Test data: the test image the skill built after the base, untagged (`-t cscb-ci`); no runner export names it. */
      const LEGACY_TEST_IMAGE = 'cscb-ci:latest'
      /** The time limit of each child (the step, or git reading the skill). */
      const BASE_BUILD_CHILD_LIMIT_MS = 10_000
      /** Above the child's limit, so the limit, not the test runner, ends a stuck child. */
      const BASE_BUILD_CASE_TIMEOUT_MS = 30_000
      /** The plain tools the step runs by name, linked into the stub directory. */
      const STEP_PLAIN_TOOLS = ['sed', 'mktemp', 'rm']
      /** The name prefix of the step's install-script context directory, from its own `mktemp -d` line. */
      const CONTEXT_PREFIX = /mktemp -d "\$\{TMPDIR:-\/tmp\}\/([a-z-]+)X+"/.exec(STEP_TEXT)?.[1] ?? ''

      /** A tool's absolute path on the test run's PATH. */
      function toolPath(tool: string): string {
        const dir = baseBuildResolveToolDir(tool)
        if (dir === undefined) throw new Error(`${tool} is not on PATH`)
        return imagePath.join(dir, tool)
      }

      /** A shell text's commands: comment lines and trailing ` # ` comments left out, lines continued by a final `\` joined. */
      function shellCommands(text: string): string[] {
        const commands: string[] = []
        let pending = ''
        for (const raw of text.split('\n')) {
          if (raw.trim().startsWith('#')) continue
          const line = raw.replace(/\s+#\s.*$/, '')
          if (/\\\s*$/.test(line)) {
            pending += `${line.replace(/\\\s*$/, '')} `
            continue
          }
          const command = `${pending}${line}`.trim()
          pending = ''
          if (command !== '') commands.push(command)
        }
        if (pending.trim() !== '') commands.push(pending.trim())
        return commands
      }

      /** What is wrong with a base-build step text: empty when its first line is a shebang, it runs exactly one docker build, of `docker/Dockerfile.test.base`, no image inspect, and never names `cscb-ci:latest`. */
      function baseBuildStepProblems(text: string): string[] {
        const problems: string[] = []
        if (!text.startsWith('#!')) problems.push('the first line is not a shebang')
        const commands = shellCommands(text)
        const builds = commands.filter((command) => /\bdocker\s+(?:image\s+|buildx\s+)?build\b/.test(command))
        if (builds.length !== 1) problems.push(`it runs ${builds.length} docker builds, not one`)
        for (const build of builds) {
          const file = /\s(?:-f|--file)[\s=]+"?([^\s"]+)"?/.exec(build)?.[1] ?? null
          if (file !== BASE_DOCKERFILE_PATH) problems.push(`a docker build builds ${file ?? 'no -f file'}, not ${BASE_DOCKERFILE_PATH}`)
        }
        if (commands.some((command) => /\bdocker\s+(?:image\s+)?inspect\b/.test(command))) problems.push('it runs docker image inspect')
        if (commands.some((command) => /(?<![\w.-])cscb-ci(?::latest)?(?![\w:.-])/.test(command))) problems.push(`it names ${LEGACY_TEST_IMAGE}`)
        return problems
      }

      /** The step with `line` added after its `BASE_TAG=` line, or at its end. */
      function planted(line: string, where: 'after-base-tag' | 'end'): string {
        if (where === 'end') return `${STEP_TEXT.replace(/\n*$/, '\n')}${line}\n`
        return STEP_TEXT.replace(/^(BASE_TAG=.*\n)/m, `$1${line}\n`)
      }

      test('the content audit passes on the real step: a shebang first, one docker build, of docker/Dockerfile.test.base, no image inspect, no docker/Dockerfile.test build and no cscb-ci:latest', () => {
        expect(STEP_TEXT.split('\n')[0]).toMatch(/^#!/)
        expect(baseBuildStepProblems(STEP_TEXT)).toEqual([])
      })

      const PLANTS: readonly (readonly [string, () => string, readonly string[]])[] = [
        ['a second docker build', () => planted(`docker build -f ${BASE_DOCKERFILE_PATH} -t "\${BASE_TAG}" .`, 'end'), ['it runs 2 docker builds, not one']],
        ['a docker image inspect', () => planted('docker image inspect "${BASE_TAG}" >/dev/null 2>&1 || true', 'after-base-tag'), ['it runs docker image inspect']],
        ['a cscb-ci:latest', () => planted(`docker tag "\${BASE_TAG}" ${LEGACY_TEST_IMAGE}`, 'end'), [`it names ${LEGACY_TEST_IMAGE}`]],
        ['a build of docker/Dockerfile.test in place of the base\'s', () => STEP_TEXT.replace(`-f ${BASE_DOCKERFILE_PATH} `, `-f ${TEST_DOCKERFILE_PATH} `), [`a docker build builds ${TEST_DOCKERFILE_PATH}, not ${BASE_DOCKERFILE_PATH}`]],
        ['no shebang', () => STEP_TEXT.slice(STEP_TEXT.indexOf('\n') + 1), ['the first line is not a shebang']],
      ]

      test.each(PLANTS)('the content audit refuses %s planted in the real step', (_plant, plant, problems) => {
        const text = plant()
        expect(text).not.toBe(STEP_TEXT)
        expect(baseBuildStepProblems(text)).toEqual([...problems])
      })

      test('every line but the shebang, header and note is the /ci skill\'s base-build line at the commit the header names, byte for byte, less the three-space list indent and with the current base tag; only the guard, its fi and the test-image build are left out', () => {
        const commit = /commands at ([0-9a-f]{7,40})\b/.exec(STEP_TEXT)?.[1]
        // Test data: fixes the commit the step's lines were moved from.
        expect(commit).toBe('946be79')
        const rig = makeE8Rig()
        const home = rig.env.HOME
        if (home === undefined) throw new Error('the rig has no HOME')
        // A read-only object lookup in this checkout's history, under the rig's HOME, the system git configuration kept out.
        const shown = Bun.spawnSync({
          cmd: [toolPath('git'), 'show', `${commit}:${CI_SKILL_PATH}`],
          cwd: BASE_BUILD_REPO_ROOT,
          env: baseBuildHostSafeChildEnv(home, { tools: ['git'], extras: { GIT_CONFIG_NOSYSTEM: '1' } }),
          stdin: 'ignore',
          stdout: 'pipe',
          stderr: 'pipe',
          timeout: BASE_BUILD_CHILD_LIMIT_MS,
        })
        expect(shown.exitedDueToTimeout ?? false).toBe(false)
        expect(shown.exitCode, `git could not read ${CI_SKILL_PATH} at ${commit} (a shallow clone?)`).toBe(0)
        const skillLines = shown.stdout.toString().split('\n')

        // The skill's bash block holding BASE_TAG.
        const tagAt = skillLines.findIndex((line) => /^\s*BASE_TAG=/.test(line))
        expect(tagAt).toBeGreaterThan(0)
        const open = tagAt - 1 - [...skillLines.slice(0, tagAt)].reverse().findIndex((line) => line.trim().startsWith('```'))
        const close = skillLines.findIndex((line, i) => i > tagAt && line.trim().startsWith('```'))
        expect([open < tagAt && skillLines[open]?.trim().startsWith('```') === true, close > tagAt]).toEqual([true, true])
        const block = skillLines.slice(open + 1, close)
        for (const line of block) expect(line.startsWith('   ')).toBe(true)

        const guardAt = block.findIndex((line) => line.includes('docker image inspect'))
        const guardIndent = /^\s*/.exec(block[guardAt]!)![0]
        const fiAt = block.findIndex((line, i) => i > guardAt && line === `${guardIndent}fi`)
        expect([guardAt > 0, fiAt > guardAt]).toEqual([true, true])
        const leftOut = block.filter((_line, i) => i === guardAt || i >= fiAt)
        expect(leftOut).toHaveLength(3)
        expect(leftOut[2]).toContain(`docker build -f ${TEST_DOCKERFILE_PATH} `)
        const moved = block.filter((_line, i) => i !== guardAt && i < fiAt).map((line) => line.slice(3))
        // The historical tag stays in history; only its value follows a base-image version bump.
        expect(moved.filter((line) => /^BASE_TAG=/.test(line))).toHaveLength(1)
        expect(STEP_TEXT.match(/^BASE_TAG=(\S+)/m)?.[1]).toBe(BASE_IMAGE)
        const current = moved.map((line) => line.replace(/^BASE_TAG=\S+/, `BASE_TAG=${BASE_IMAGE}`))

        // The step's own lines: the shebang, its header and its note, every one a comment at column 0.
        const stepLines = STEP_TEXT.replace(/\n$/, '').split('\n')
        expect(stepLines.filter((line) => !line.startsWith('#'))).toEqual(current)
      })

      /** How the stubs behave in one run of the step. */
      interface StepStubs {
        /** The rig's options (the worktree's base Dockerfile, `CSCB_AD_SRC_DIR`). */
        readonly options?: ImageRigOptions
        /** Leave `CSCB_AD_SRC_DIR` out of the step's environment. */
        readonly noSourceDir?: boolean
        /** The stub git's tag-check exit (default 0). */
        readonly tagExit?: number
        /** The stub git's `show` exit (default 0); non-zero: it writes `BASE_BUILD_GIT_ERROR` to standard error. */
        readonly showExit?: number
        /** The stub docker's exit (default 0). */
        readonly dockerExit?: number
      }

      /** One run of the step under bash in a child. */
      interface StepRun {
        readonly rig: ImageRig
        readonly exitCode: number
        readonly stdout: string
        readonly stderr: string
        /** Each stub call, as its tab-separated fields: the program and its arguments (docker also logs its context, token and PATH lines). */
        readonly calls: readonly (readonly string[])[]
        /** The token the stub gh printed. */
        readonly token: string
      }

      /** Test data: the install script the stub git extracts, on one line. */
      const STUB_INSTALL_TEXT = 'e8b install script (test data)'

      /** A stub program: `bash` lines under a shebang naming the test run's bash, written 0755. */
      function writeStub(dir: string, name: string, lines: readonly string[]): void {
        imageFs.writeFileSync(imagePath.join(dir, name), `#!${toolPath('bash')}\n${lines.join('\n')}\n`, { mode: 0o755 })
      }

      /** The record line every stub writes first: its name and arguments, tab-separated. */
      const RECORD_CALL = (name: string): string => `{ printf "%s" "${name}"; printf "\\t%s" "$@"; printf "\\n"; } >> "$BASE_BUILD_STUB_LOG"`

      /**
       * Runs the real step under bash in a child: a direct `hostSafeChildEnv`
       * call with no tool, its PATH only a stub directory under the rig's root
       * (stub docker, git and gh; links to sed, mktemp and rm), TMPDIR and
       * `CSCB_AD_SRC_DIR` under the root, the rig's worktree as working
       * directory, and a time limit. No real docker, git or gh is reached.
       */
      function runStep(stubs: StepStubs = {}): StepRun {
        const rig = makeE8Rig(stubs.options)
        const home = rig.env.HOME
        if (home === undefined) throw new Error('the rig has no HOME')
        const stubDir = imagePath.join(rig.root, 'e8b-stub-bin')
        imageFs.mkdirSync(stubDir)
        for (const tool of STEP_PLAIN_TOOLS) imageFs.symlinkSync(toolPath(tool), imagePath.join(stubDir, tool))
        const callLog = imagePath.join(rig.root, 'e8b-stub-calls.log')
        imageFs.writeFileSync(callLog, '')
        const token = imageFakeToken('', 'e8b-gh-stub')

        writeStub(stubDir, 'docker', [
          RECORD_CALL('docker'),
          'ctx=""',
          'for arg in "$@"; do case "$arg" in agent-director-install=*) ctx="${arg#agent-director-install=}" ;; esac; done',
          'if [ -n "$ctx" ] && [ -f "$ctx/install.sh" ]; then printf "context\\t%s\\t%s\\n" "$ctx" "$(< "$ctx/install.sh")" >> "$BASE_BUILD_STUB_LOG"; fi',
          'if [ "${GH_TOKEN-}" = "$BASE_BUILD_GH_TOKEN" ]; then printf "gh-token\\tsame\\n" >> "$BASE_BUILD_STUB_LOG"; else printf "gh-token\\tother\\n" >> "$BASE_BUILD_STUB_LOG"; fi',
          'printf "path\\t%s\\n" "$PATH" >> "$BASE_BUILD_STUB_LOG"',
          'exit "$BASE_BUILD_DOCKER_EXIT"',
        ])
        writeStub(stubDir, 'git', [
          RECORD_CALL('git'),
          'case "$3" in',
          '  rev-parse) exit "$BASE_BUILD_GIT_TAG_EXIT" ;;',
          '  show) if [ "$BASE_BUILD_GIT_SHOW_EXIT" != 0 ]; then printf "%s\\n" "$BASE_BUILD_GIT_ERROR" >&2; exit "$BASE_BUILD_GIT_SHOW_EXIT"; fi; printf "%s\\n" "$BASE_BUILD_INSTALL_TEXT" ;;',
          '  *) exit 99 ;;',
          'esac',
        ])
        writeStub(stubDir, 'gh', [
          '{ printf "gh"; printf "\\t%s" "$@"; printf "\\tGH_CONFIG_DIR=%s" "${GH_CONFIG_DIR-<unset>}"; printf "\\n"; } >> "$BASE_BUILD_STUB_LOG"',
          'printf "%s\\n" "$BASE_BUILD_GH_TOKEN"',
        ])

        const extras: Record<string, string> = {
          TMPDIR: rig.tempDir,
          BASE_BUILD_STUB_LOG: callLog,
          BASE_BUILD_GIT_TAG_EXIT: String(stubs.tagExit ?? 0),
          BASE_BUILD_GIT_SHOW_EXIT: String(stubs.showExit ?? 0),
          BASE_BUILD_GIT_ERROR,
          BASE_BUILD_INSTALL_TEXT: STUB_INSTALL_TEXT,
          BASE_BUILD_DOCKER_EXIT: String(stubs.dockerExit ?? 0),
          BASE_BUILD_GH_TOKEN: token,
        }
        if (stubs.noSourceDir !== true) extras[AD_SOURCE_DIR_VARIABLE] = rig.adSourceDir

        const child = Bun.spawnSync({
          cmd: [toolPath('bash'), STEP_PATH],
          cwd: rig.worktreeRoot,
          env: baseBuildHostSafeChildEnv(home, { tools: [], pathDirs: [stubDir], extras }),
          stdin: 'ignore',
          stdout: 'pipe',
          stderr: 'pipe',
          timeout: BASE_BUILD_CHILD_LIMIT_MS,
        })
        expect(child.exitedDueToTimeout ?? false).toBe(false)
        expect(child.signalCode ?? null).toBeNull()
        const calls = imageFs.readFileSync(callLog, 'utf-8').split('\n').filter((line) => line !== '').map((line) => line.split('\t'))
        return { rig, exitCode: child.exitCode, stdout: child.stdout.toString(), stderr: child.stderr.toString(), calls, token }
      }

      /** The calls of one stub program. */
      function callsOf(run: StepRun, name: string): (readonly string[])[] {
        return run.calls.filter((call) => call[0] === name)
      }

      /** The step's install-script context directories left under the rig's TMPDIR. */
      function contextsLeft(run: StepRun): string[] {
        return imageFs.readdirSync(run.rig.tempDir).filter((name) => name.startsWith(CONTEXT_PREFIX))
      }

      /** That a run reached no docker build, left no context directory and printed no secret. */
      function expectNoBuildNoContextNoLeak(run: StepRun): void {
        expect(callsOf(run, DOCKER_PROGRAM)).toEqual([])
        expect(contextsLeft(run)).toEqual([])
        imageAssertNoLeak({ stdout: run.stdout, stderr: run.stderr })
      }

      /** The step's own `non-runnable:` lines, in order, as written in it (`${NAME}` unexpanded). */
      const NON_RUNNABLE_LINES = [...STEP_TEXT.matchAll(/^\s*echo "(non-runnable: [^"]*)" >&2$/gm)].map((m) => m[1]!)

      /** A `non-runnable:` line with its `${NAME}` references expanded from `values`. */
      function expanded(line: string, values: Readonly<Record<string, string>>): string {
        return line.replace(/\$\{([A-Z_]+)\}/g, (_ref, name: string) => {
          const value = values[name]
          if (value === undefined) throw new Error(`no value for \${${name}}`)
          return value
        })
      }

      test('success exits 0 after exactly one docker build, of docker/Dockerfile.test.base; never an image inspect; git only reads, as the runner reads; the context directory is gone and the token is not printed', () => {
        const run = runStep()
        const { rig } = run
        const home = rig.env.HOME ?? ''
        expect(run.exitCode).toBe(0)
        expect(run.stderr).toBe('')

        const dockerCalls = callsOf(run, DOCKER_PROGRAM)
        expect(dockerCalls).toHaveLength(1)
        const build = dockerCalls[0]!
        expect(build[1]).toBe('build')
        expect(build[build.indexOf('-f') + 1]).toBe(BASE_DOCKERFILE_PATH)
        expect(build.some((arg) => arg === 'inspect')).toBe(false)
        expect(build.join(' ')).not.toContain(run.token)

        // The step's git children are the runner's own step-4 forms, and only those.
        expect(callsOf(run, GIT_PROGRAM)).toEqual(gitChecks(rig).map((argv) => [...argv]))
        expect(callsOf(run, 'gh')).toEqual([[...GH_AUTH_TOKEN_ARGV, `GH_CONFIG_DIR=${ghPersonalConfigDir({ HOME: home })}`]])

        // The build got the extracted install script's context under TMPDIR, and the token only in its environment.
        const [context] = run.calls.filter((call) => call[0] === 'context')
        expect(context?.[2]).toBe(STUB_INSTALL_TEXT)
        expect(imagePath.dirname(context?.[1] ?? '')).toBe(rig.tempDir)
        expect(imagePath.basename(context?.[1] ?? '').startsWith(CONTEXT_PREFIX)).toBe(true)
        expect(run.calls.filter((call) => call[0] === 'gh-token')).toEqual([['gh-token', 'same']])
        // The child's PATH is the stub directory alone.
        expect(run.calls.filter((call) => call[0] === 'path')).toEqual([['path', imagePath.join(rig.root, 'e8b-stub-bin')]])

        expect(CONTEXT_PREFIX).not.toBe('')
        expect(contextsLeft(run)).toEqual([])
        imageAssertNoLeak({ stdout: run.stdout, stderr: run.stderr })
      }, BASE_BUILD_CASE_TIMEOUT_MS)

      /** One of the step's own checks failing: how, which of its `non-runnable:` lines it gives, and the git calls before it. */
      const OWN_CHECKS: readonly (readonly [string, StepStubs, number, (run: StepRun) => readonly (readonly string[])[]])[] = [
        ['docker/Dockerfile.test.base sets no ARG AD_VERSION', { options: { worktree: { dockerfiles: { adVersion: 'absent' } } } }, 0, () => []],
        ['CSCB_AD_SRC_DIR is unset', { noSourceDir: true }, 1, () => []],
        ['the checkout has no tag v<AD_VERSION>', { tagExit: 1 }, 2, (run) => gitChecks(run.rig).slice(0, 1)],
        ['install.sh cannot be extracted at that tag', { showExit: 128 }, 3, (run) => gitChecks(run.rig)],
      ]

      test.each(OWN_CHECKS)('%s: exit 1 after its own non-runnable: line, no docker build and no context directory left', (_check, stubs, lineAt, gitCalls) => {
        // One case per non-runnable line of the step's own.
        expect(NON_RUNNABLE_LINES).toHaveLength(OWN_CHECKS.length)
        const run = runStep(stubs)
        const values: Record<string, string> = { CSCB_AD_SRC_DIR: run.rig.adSourceDir }
        if (lineAt > 0) values.AD_TAG = run.rig.adTag()
        expect(run.exitCode).toBe(1)
        expect(run.stdout).toBe('')
        const stderrLines = run.stderr.split('\n').filter((line) => line !== '')
        expect(stderrLines.at(-1)).toBe(expanded(NON_RUNNABLE_LINES[lineAt]!, values))
        expect(stderrLines.filter((line) => line.startsWith('non-runnable:'))).toHaveLength(1)
        expect(callsOf(run, GIT_PROGRAM)).toEqual(gitCalls(run).map((argv) => [...argv]))
        expect(callsOf(run, 'gh')).toEqual([])
        expectNoBuildNoContextNoLeak(run)
      }, BASE_BUILD_CASE_TIMEOUT_MS)

      test('a failing build exits with that build\'s own status, after removing the context directory', () => {
        const status = 17
        const run = runStep({ dockerExit: status })
        expect(run.exitCode).toBe(status)
        expect(run.stderr.split('\n').filter((line) => line.startsWith('non-runnable:'))).toEqual([])
        expect(callsOf(run, DOCKER_PROGRAM)).toHaveLength(1)
        expect(run.calls.filter((call) => call[0] === 'context')).toHaveLength(1)
        expect(contextsLeft(run)).toEqual([])
        imageAssertNoLeak({ stdout: run.stdout, stderr: run.stderr })
      }, BASE_BUILD_CASE_TIMEOUT_MS)
    })

    describe('step 12: the re-check and the base-build step', () => {
      /** Test data: how long the scripted step runs, on the fake clock. */
      const STEP_MS = 90_000
      /** Test data: the step's output, as a quiet build prints it. */
      const STEP_EARLY_LINE = '#1 [internal] load build definition from Dockerfile.test.base'
      const STEP_STDOUT_LINE = `sha256:${'e8'.repeat(32)}`
      const STEP_STDERR_LINE = 'ERROR: failed to solve: e8b test failure'

      /** Step 4 on the rig, every prerequisite passing: the base found missing. */
      async function missingAtStep4(rig: ImageRig): Promise<string> {
        rig.answerPrerequisites()
        const stage = await checkBaseImage(rig.deps, rig.state)
        expect(stage.ok && stage.check.kind).toBe('missing')
        return rig.baseImageName()
      }

      /** The spawns of the base-build step. */
      function stepSpawns(rig: ImageRig): imageHelper.RecordedSpawn[] {
        return rig.recorder.spawns().filter((s) => sameArgv(s.argv, baseBuildStepArgs(rig.worktreeRoot)))
      }

      test('missing at step 4 and still missing at the re-check: the step is spawned once, in its own process group, in the worktree, with the runner\'s environment, its output in the runner log and its start and end on the fake clock', async () => {
        const rig = makeE8Rig()
        const image = await missingAtStep4(rig)
        const startOffsetMs = 60_000
        await rig.clock.advance(startOffsetMs)
        const startedAtMs = IMAGE_START_MS + startOffsetMs
        rig.answerBaseBuildStep({ delayMs: STEP_MS, earlyLines: [STEP_EARLY_LINE], stdout: `${STEP_STDOUT_LINE}\n` })

        const running = runBaseBuild(rig.deps, rig.state, rig.log)
        await rig.clock.flush()
        const [spawned] = stepSpawns(rig)
        expect(spawned).toBeDefined()
        expect(rig.state.baseBuildStep?.pid).toBe(spawned!.pid)
        expect(rig.state.baseBuildRun).toEqual({ startedAtMs, endedAtMs: null })
        await rig.clock.advance(STEP_MS)
        const stage = await running

        const run = { startedAtMs, endedAtMs: startedAtMs + STEP_MS }
        expect(stage).toEqual({ kind: 'built', run })
        expect(rig.state.baseBuildRun).toEqual(run)
        expect(rig.state.baseBuildStep).toBeNull()
        expect(stepSpawns(rig).map((s) => ({ argv: s.argv, cwd: s.cwd, env: s.env, ownProcessGroup: s.ownProcessGroup, atMs: s.atMs }))).toEqual([
          { argv: baseBuildStepArgs(rig.worktreeRoot), cwd: rig.worktreeRoot, env: rig.env, ownProcessGroup: true, atMs: startedAtMs },
        ])
        expect(spawned!.processGroup).toBe(spawned!.pid)
        // The existence query at step 4 and the re-check: both of the base, nothing else from docker.
        expect(dockerOperationRefs(rig)).toEqual([
          { kind: 'image-inspect', refs: [image] },
          { kind: 'image-inspect', refs: [image] },
        ])
        expect(rig.logLines).toEqual([STEP_EARLY_LINE, STEP_STDOUT_LINE])
        imageAssertNoLeak({ stage, logLines: rig.logLines })
      })

      test('missing at step 4, then built by another run before the re-check: the step is not spawned and no base-build run is recorded', async () => {
        const rig = makeE8Rig()
        const image = await missingAtStep4(rig)
        rig.addBaseImage()
        const stage = await runBaseBuild(rig.deps, rig.state, rig.log)
        expect(stage).toEqual({ kind: 'not-run', why: 'present-at-recheck' })
        expect(stepSpawns(rig)).toEqual([])
        expect([rig.state.baseBuildRun, rig.state.baseBuildStep]).toEqual([null, null])
        expect(dockerOperationRefs(rig)).toEqual([
          { kind: 'image-inspect', refs: [image] },
          { kind: 'image-inspect', refs: [image] },
        ])
        expect(rig.logLines).toEqual([baseBuiltMeanwhileLine(image)])
        imageAssertNoLeak({ stage, logLines: rig.logLines })
      })

      test('present at step 4: no re-check inspection and no step', async () => {
        const rig = makeE8Rig()
        rig.addBaseImage()
        const check = await checkBaseImage(rig.deps, rig.state)
        expect(check.ok).toBe(true)
        const stage = await runBaseBuild(rig.deps, rig.state, rig.log)
        expect(stage).toEqual({ kind: 'not-run', why: 'present-at-step-4' })
        expect(dockerOperationRefs(rig)).toEqual([{ kind: 'image-inspect', refs: [rig.baseImageName()] }])
        expect(rig.recorder.spawns()).toHaveLength(1)
        expect([rig.state.baseBuildRun, rig.state.baseBuildStep]).toEqual([null, null])
        expect(rig.logLines).toEqual([])
        imageAssertNoLeak({ check: { ...check, secrets: null }, stage, logLines: rig.logLines })
      })

      test('a re-check that fails is logged, and the step runs: its own build answers for the base', async () => {
        const rig = makeE8Rig()
        const image = await missingAtStep4(rig)
        rig.docker.fail('image-inspect')
        rig.answerBaseBuildStep()
        const stage = await runBaseBuild(rig.deps, rig.state, rig.log)
        expect(stage).toEqual({ kind: 'built', run: { startedAtMs: IMAGE_START_MS, endedAtMs: IMAGE_START_MS } })
        expect(stepSpawns(rig)).toHaveLength(1)
        expect(rig.logLines).toHaveLength(1)
        expectFramed(rig.logLines[0]!, baseRecheckFailedLine(image, BASE_BUILD_MARK))
        imageAssertNoLeak({ stage, logLines: rig.logLines })
      })

      test('a stop recorded before the step starts: the step is not spawned', async () => {
        const rig = makeE8Rig()
        await missingAtStep4(rig)
        rig.recordStop()
        const stage = await runBaseBuild(rig.deps, rig.state, rig.log)
        expect(stage).toEqual({ kind: 'not-run', why: 'stop-recorded' })
        expect(stepSpawns(rig)).toEqual([])
        expect(rig.state.baseBuildRun).toBeNull()
        imageAssertNoLeak({ stage, logLines: rig.logLines })
      })

      test.each([1, 17])('a step exiting %d fails with the exact image-build line naming that code; its output is in the runner log', async (code) => {
        const rig = makeE8Rig()
        await missingAtStep4(rig)
        rig.answerBaseBuildStep({ exitCode: code, stderr: `${STEP_STDERR_LINE}\n` })
        const stage = await runBaseBuild(rig.deps, rig.state, rig.log)
        const run = { startedAtMs: IMAGE_START_MS, endedAtMs: IMAGE_START_MS }
        expect(stage).toEqual({ kind: 'failed', run, exitCode: code, failure: imageBuildFailure(baseImageBuildFailedLine(code)) })
        if (stage.kind === 'failed') {
          expect(stage.failure.line).toBe(baseImageBuildFailedLine(code))
          expect(stage.failure.line).toContain(`(exit ${code})`)
        }
        expect(stepSpawns(rig)).toHaveLength(1)
        expect(rig.state.baseBuildStep).toBeNull()
        expect(rig.logLines).toEqual([STEP_STDERR_LINE])
        imageAssertNoLeak({ stage, logLines: rig.logLines })
      })
    })
  })

  // --- test, drift and retag images (.S5-S6) ---

  describe('step 12: the test image, the drift and retag images and the tag move', () => {
    type BuildOutcome = imageRunner.BuildOutcome
    type Fault = imageRunner.Fault
    type FaultController = imageRunner.FaultController
    type FaultLabelValue = imageRunner.FaultLabelValue
    type RecordedSpawn = imageHelper.RecordedSpawn
    type TestTagReading = imageRunner.TestTagReading

    /** Test data: how long a timed build lasts on the fake clock. */
    const TEST_IMAGE_BUILD_MS = 10_000
    /** Test data: the image ID a programmed test build prints. */
    const TEST_IMAGE_PRINTED_ID = `sha256:${imageCreateHash('sha256').update('e8c printed test image').digest('hex')}`
    /** Test data: a daemon's one-line error for a failed image inspect. */
    const TEST_IMAGE_INSPECT_ERROR = 'Error response from daemon: e8c image inspect failure (test data)'
    /** Test data: a daemon's one-line error for a failed tag move. */
    const TEST_IMAGE_TAG_ERROR = 'Error response from daemon: e8c image tag failure (test data)'
    /** Test data: why docker could not be started. */
    const TEST_IMAGE_DOCKER_NOT_STARTED = 'spawn docker ENOENT'
    /** Test data: the exit status of a failed drift or retag build, apart from `FAILURE_EXIT_STATUS` and the fake's default. */
    const TEST_IMAGE_FAULT_BUILD_EXIT = 4
    /** Test data: the exit status of a failed tag move. */
    const TEST_IMAGE_TAG_EXIT = 3
    /** The `--inject` values that need a fault image: one per role. */
    const TEST_IMAGE_FAULT_IMAGE_VALUES = ['image-drift:1', 'retag'] as const

    /** The run's `-test` tag. */
    const testTag = (): string => imageRunner.formatRunTag(IMAGE_OWNER, 'test')
    /** The owner label's value, `<RUN_ID>-<PID>`. */
    const ownerValue = (): string => imageRunner.formatOwner(IMAGE_OWNER)

    /** The test build as the runner should spawn it for this rig. */
    function testBuildSpec(rig: ImageRig): imageRunner.TestImageBuildSpec {
      return { dockerfilePath: imageRunner.TEST_DOCKERFILE_PATH, contextDir: rig.worktreeRoot, labels: { [imageRunner.OWNER_LABEL]: ownerValue() }, tag: testTag() }
    }

    /** A fault image's build as the runner should spawn it: FROM the `-test` tag, the owner and fault labels, its role's tag. */
    function faultBuildSpec(role: FaultLabelValue): imageRunner.DerivedImageBuildSpec {
      return { from: testTag(), labels: { [imageRunner.OWNER_LABEL]: ownerValue(), [imageRunner.FAULT_LABEL]: role }, tag: imageRunner.formatRunTag(IMAGE_OWNER, role) }
    }

    /** The normalized faults of `/ci --inject <value>...`, through validation's validation as the run lifecycle hands them on. */
    function faultsOf(rig: ImageRig, values: readonly string[]): readonly Fault[] {
      return rig.validate(values.flatMap((value) => ['--inject', value])).invocation.faults
    }

    /** The one fault image role a single `--inject` value needs, from the runner. */
    function roleOf(rig: ImageRig, value: string): FaultLabelValue {
      const roles = imageRunner.faultImageRoles(faultsOf(rig, [value]))
      expect(roles).toHaveLength(1)
      return roles[0]!
    }

    /** T6.S5's pinned-image setup: builds the test image through the runner and answers the pinned ID. */
    async function pinTestImage(rig: ImageRig): Promise<string> {
      const report = await imageRunner.buildTestImage(rig.imagesContext, rig.state)
      expect(report.failure).toBeNull()
      const pinnedId = rig.state.images.pinnedId
      if (pinnedId === null) throw new Error('pinTestImage: the test image was not pinned')
      return pinnedId
    }

    /** A text's lines, without the empty piece after a final line feed. */
    function linesOf(text: string): string[] {
      const lines = text.split('\n')
      if (lines.at(-1) === '') lines.pop()
      return lines
    }

    /** The lines a build wrote, as its result holds them: standard output, then standard error. */
    async function buildOutputLines(spawn: RecordedSpawn): Promise<string[]> {
      const result = await spawn.result
      return [...linesOf(new TextDecoder().decode(result.stdout)), ...linesOf(result.stderr)]
    }

    /** fault injection's real controller over these faults (no assignment is needed for drift and retag). */
    function controllerFor(rig: ImageRig, faults: readonly Fault[]): FaultController {
      return imageRunner.createFaultController({ faults, assignment: [], clock: rig.clock, runDir: rig.runDir, handler: () => undefined })
    }

    /** Hands a fault image's outcome to the controller as the run lifecycle does. */
    function noteFaultBuild(controller: FaultController, role: FaultLabelValue, outcome: BuildOutcome): void {
      if (role === 'drift') controller.noteDriftBuild(outcome)
      else controller.noteRetagBuild(outcome)
    }

    /** The firing record of the fault a role serves. */
    function recordFor(controller: FaultController, role: FaultLabelValue): imageRunner.FiringRecord {
      const kind = role === 'drift' ? 'image-drift' : 'retag'
      const found = controller.records().find((record) => record.fault.kind === kind)
      if (found === undefined) throw new Error(`recordFor: no ${kind} fault`)
      return found
    }

    /** fault injection's reason for a role's failed build, from its exported builder. */
    function buildFailedReason(role: FaultLabelValue, exitCode: number): string {
      return role === 'drift' ? imageRunner.driftBuildFailedReason(exitCode) : imageRunner.retagBuildFailedReason(exitCode)
    }

    /** A role's recorded image ID. */
    function roleId(rig: ImageRig, role: FaultLabelValue): string | null {
      return role === 'drift' ? rig.state.images.driftId : rig.state.images.retagId
    }

    /** Every image's tags, by ID. */
    function tagsById(rig: ImageRig): Record<string, readonly string[]> {
      return Object.fromEntries(rig.docker.images().map((image) => [image.id, image.tags]))
    }

    /** Every output an image case checks for a leak. */
    function imageOutputs(rig: ImageRig, result: unknown): unknown {
      return { result, state: rig.state, logLines: rig.logLines, images: rig.docker.images(), operations: rig.docker.operations(), runDir: imageWrittenFile(rig.runDir) }
    }

    describe('the test image: build and pin', () => {
      test('the test build is spawned once from docker/Dockerfile.test with the worktree as context, in its own process group, its output in the runner log, carrying exactly the run\'s owner label', async () => {
        const rig = makeE8Rig()
        const report = await imageRunner.buildTestImage(rig.imagesContext, rig.state)
        expect(report.outcome.kind).toBe('built')

        const spawns = rig.recorder.spawns()
        expect(spawns).toHaveLength(1)
        const [spawn] = spawns
        expect(spawn!.argv).toEqual(imageRunner.testImageBuildArgs(testBuildSpec(rig)))
        expect(spawn!.argv).toContain(imageRunner.TEST_DOCKERFILE_PATH)
        expect(spawn!.argv.at(-1)).toBe(rig.worktreeRoot)
        expect(spawn!.cwd).toBe(rig.worktreeRoot)
        expect(spawn!.stdin).toBeNull()
        expect(spawn!.ownProcessGroup).toBe(true)
        expect(spawn!.processGroup).not.toBeNull()
        expect(spawn!.processGroup).toBe(spawn!.pid)
        expect(rig.docker.operations('image-build').map((op) => op.processGroup)).toEqual([spawn!.processGroup])

        const pinnedId = rig.state.images.pinnedId!
        expect(rig.docker.image(pinnedId)?.labels).toEqual({ [imageRunner.OWNER_LABEL]: ownerValue() })
        const output = await buildOutputLines(spawn!)
        expect(output.some((line) => line.includes(pinnedId))).toBe(true)
        expect(rig.logLines).toEqual(output)
        expect(rig.state.imageBuildInProgress).toBeNull()
        expect(rig.state.images.buildsStarted).toEqual({ test: true, drift: false, retag: false })
        imageAssertNoLeak(imageOutputs(rig, report))
      })

      test('the pinned ID is the ID the build printed, at the clock\'s moment the build ended, while a tag lookup would answer a decoy; no lookup or listing is made', async () => {
        const rig = makeE8Rig()
        rig.docker.programBuild({ kind: 'built', imageId: TEST_IMAGE_PRINTED_ID, durationMs: TEST_IMAGE_BUILD_MS }, { role: 'test' })
        // As soon as the build has printed its ID (the fake has tagged its image), the -test tag moves to a decoy with the run's owner label.
        let decoyId: string | null = null
        const log: imageRunner.RunnerLogSink = (line) => {
          rig.log(line)
          if (decoyId === null && line.includes(TEST_IMAGE_PRINTED_ID)) decoyId = rig.docker.addImage({ tags: [testTag()], labels: { [imageRunner.OWNER_LABEL]: ownerValue() } })
        }
        const building = imageRunner.buildTestImage({ ...rig.imagesContext, log }, rig.state)
        await rig.clock.advance(TEST_IMAGE_BUILD_MS)
        const report = await building

        expect(report).toEqual({ outcome: { kind: 'built', imageId: TEST_IMAGE_PRINTED_ID }, failure: null })
        expect(decoyId).not.toBeNull()
        expect(decoyId).not.toBe(TEST_IMAGE_PRINTED_ID)
        expect(rig.docker.image(testTag())?.id).toBe(decoyId!)
        expect(rig.state.images.pinnedId).toBe(TEST_IMAGE_PRINTED_ID)
        expect(rig.state.images.pinnedAtMs).toBe(IMAGE_START_MS + TEST_IMAGE_BUILD_MS)
        expect(rig.state.images.builds.test).toEqual({ kind: 'built', imageId: TEST_IMAGE_PRINTED_ID })
        expect(rig.docker.operations().map((op) => op.kind)).toEqual(['image-build'])
        imageAssertNoLeak(imageOutputs(rig, report))
      })

      test.each([[[] as string[]], [['kill:1']]])('with faults %j the run\'s only tag is -test, on the pinned image; no fault image is built and the tag move spawns nothing', async (values) => {
        const rig = makeE8Rig()
        const baseId = rig.addBaseImage()
        const before = tagsById(rig)
        const faults = faultsOf(rig, values)
        expect(imageRunner.faultImageRoles(faults)).toEqual([])

        const pinnedId = await pinTestImage(rig)
        const outcomes = await imageRunner.buildFaultImages(rig.imagesContext, rig.state, faults)
        expect(outcomes).toEqual({ drift: { kind: 'not-built' }, retag: { kind: 'not-built' } })
        const spawned = rig.recorder.spawns().length
        expect(await imageRunner.moveTestTagToRetagImage(rig.imagesContext, rig.state)).toEqual({ kind: 'not-tried' })
        expect(rig.recorder.spawns()).toHaveLength(spawned)

        expect(tagsById(rig)).toEqual({ ...before, [pinnedId]: [testTag()] })
        expect(rig.docker.image(baseId)?.tags).toEqual(before[baseId])
        expect(rig.docker.operations().map((op) => op.kind)).toEqual(['image-build'])
        const images = rig.state.images
        expect([images.driftId, images.retagId, images.retagMoved]).toEqual([null, null, false])
        expect([images.builds.drift, images.builds.retag]).toEqual([{ kind: 'not-built' }, { kind: 'not-built' }])
        expect(images.buildsStarted).toEqual({ test: true, drift: false, retag: false })
        expect(images.tagsMade).toEqual({ test: true, drift: false, retag: false })
        imageAssertNoLeak(imageOutputs(rig, outcomes))
      })

      /** One failed test build: how it fails, its exit status, and whether it was spawned and made its tag. */
      const TEST_BUILD_FAILURES: readonly (readonly [string, (rig: ImageRig) => void, number, { readonly started: boolean; readonly tagMade: boolean }])[] = [
        ['a non-zero exit', (rig) => rig.docker.programBuild({ kind: 'failed', exitCode: 2 }, { role: 'test' }), 2, { started: true, tagMade: false }],
        [
          'docker not started',
          (rig) => rig.recorder.answer(imageRunner.testImageBuildArgs(testBuildSpec(rig)), { notStarted: TEST_IMAGE_DOCKER_NOT_STARTED }),
          SPAWN_FAILED_EXIT_STATUS,
          { started: false, tagMade: false },
        ],
        // The fake always prints an ID for a built image, so this one answers the build's argument list directly: exit 0, no ID in its output.
        ['exit 0 with no image ID in its output', (rig) => rig.recorder.answer(imageRunner.testImageBuildArgs(testBuildSpec(rig)), { stderr: '#1 DONE 0.0s\n' }), 0, { started: true, tagMade: true }],
      ]

      test.each(TEST_BUILD_FAILURES)('a test build with %s is the image build failure line with its exit status, and nothing is pinned', async (_what, arrange, exitCode, expected) => {
        const rig = makeE8Rig()
        arrange(rig)
        const report = await imageRunner.buildTestImage(rig.imagesContext, rig.state)

        const line = imageRunner.testImageBuildFailedLine(exitCode)
        expect(report).toEqual({ outcome: { kind: 'failed', exitCode }, failure: imageRunner.imageBuildFailure(line) })
        expect(report.failure?.line).toBe(line)
        expect(line.startsWith(imageRunner.FAIL_PREFIX)).toBe(true)
        expect(line).toContain(String(exitCode))
        const images = rig.state.images
        expect([images.pinnedId, images.pinnedAtMs]).toEqual([null, null])
        expect(images.builds.test).toEqual({ kind: 'failed', exitCode })
        expect(images.buildsStarted.test).toBe(expected.started)
        expect(images.tagsMade.test).toBe(expected.tagMade)
        expect(rig.state.imageBuildInProgress).toBeNull()
        expect(rig.recorder.spawns()).toHaveLength(1)
        imageAssertNoLeak(imageOutputs(rig, report))
      })

      test('once the stop record is set no build starts: the test build and both fault builds are not-built and the tag move not-tried', async () => {
        const rig = makeE8Rig()
        rig.recordStop()
        const faults = faultsOf(rig, TEST_IMAGE_FAULT_IMAGE_VALUES)
        expect(await imageRunner.buildTestImage(rig.imagesContext, rig.state)).toEqual({ outcome: { kind: 'not-built' }, failure: null })
        expect(await imageRunner.buildFaultImages(rig.imagesContext, rig.state, faults)).toEqual({ drift: { kind: 'not-built' }, retag: { kind: 'not-built' } })
        expect(await imageRunner.moveTestTagToRetagImage(rig.imagesContext, rig.state)).toEqual({ kind: 'not-tried' })
        expect(rig.recorder.spawns()).toEqual([])
        expect(rig.state.images).toEqual(initialImageState())
        imageAssertNoLeak(imageOutputs(rig, null))
      })

      test('a stop recorded after the retag image is built leaves the drift build not-built and the tag move not-tried, spawning nothing more', async () => {
        const rig = makeE8Rig()
        await pinTestImage(rig)
        expect((await imageRunner.buildFaultImage(rig.imagesContext, rig.state, roleOf(rig, 'retag'))).kind).toBe('built')
        const retagId = rig.state.images.retagId
        expect(retagId).not.toBeNull()
        const spawned = rig.recorder.spawns().length
        rig.recordStop()

        expect(await imageRunner.buildFaultImage(rig.imagesContext, rig.state, roleOf(rig, 'image-drift:1'))).toEqual({ kind: 'not-built' })
        expect(await imageRunner.moveTestTagToRetagImage(rig.imagesContext, rig.state)).toEqual({ kind: 'not-tried' })
        expect(rig.recorder.spawns()).toHaveLength(spawned)
        expect(rig.docker.image(testTag())?.id).toBe(rig.state.images.pinnedId!)
        expect([rig.state.images.builds.drift, rig.state.images.retagMoved]).toEqual([{ kind: 'not-built' }, false])
        imageAssertNoLeak(imageOutputs(rig, null))
      })
    })

    describe('the drift and retag images', () => {
      test.each(TEST_IMAGE_FAULT_IMAGE_VALUES.map((value) => [value] as const))('with %s its image is built FROM the -test tag in its own process group, labelled with the owner and its fault value, tagged by its role, its ID from its own output', async (value) => {
        const rig = makeE8Rig()
        const pinnedId = await pinTestImage(rig)
        const role = roleOf(rig, value)
        const logStart = rig.logLines.length
        const opStart = rig.docker.operations().length
        const outcomes = await imageRunner.buildFaultImages(rig.imagesContext, rig.state, faultsOf(rig, [value]))

        const spawn = rig.recorder.spawns().find((s) => s.argv.includes(imageRunner.formatRunTag(IMAGE_OWNER, role)))!
        const spec = faultBuildSpec(role)
        expect(spawn.argv).toEqual(imageRunner.derivedImageBuildArgs(spec))
        expect(spawn.stdin).toBe(imageRunner.derivedImageDockerfile(spec))
        expect(spawn.stdin).toContain(testTag())
        expect(spawn.stdin).not.toContain(pinnedId)
        expect(spawn.ownProcessGroup).toBe(true)
        expect(spawn.processGroup).not.toBeNull()
        expect(spawn.processGroup).toBe(spawn.pid)

        const output = await buildOutputLines(spawn)
        const printed = output.flatMap((line) => imageRunner.BUILD_IMAGE_ID_PATTERN.exec(line)?.[1] ?? [])
        expect(printed).toHaveLength(1)
        const builtId = printed[0]!
        expect(outcomes[role]).toEqual({ kind: 'built', imageId: builtId })
        expect(roleId(rig, role)).toBe(builtId)
        expect(builtId).not.toBe(pinnedId)
        expect(rig.docker.image(builtId)).toEqual({
          id: builtId,
          tags: [imageRunner.formatRunTag(IMAGE_OWNER, role)],
          labels: { [imageRunner.OWNER_LABEL]: ownerValue(), [imageRunner.FAULT_LABEL]: role },
        })
        expect(rig.docker.image(pinnedId)?.tags).toEqual([testTag()])
        expect(rig.logLines.slice(logStart)).toEqual(output)

        const checks = rig.docker.operations().slice(opStart)
        expect(checks.map((op) => op.kind)).toEqual(['image-inspect', 'image-build', 'image-inspect'])
        expect(checks.map((op) => op.refs)).toEqual([[testTag()], [imageRunner.formatRunTag(IMAGE_OWNER, role)], [testTag()]])
        const other = imageRunner.FAULT_LABEL_VALUES.find((candidate) => candidate !== role)!
        expect(outcomes[other]).toEqual({ kind: 'not-built' })
        expect(rig.state.images.buildsStarted[role]).toBe(true)
        expect(rig.state.images.tagsMade[role]).toBe(true)
        expect(imageRunner.shardStartImageId(rig.state.images, true)).toBe(role === 'drift' ? builtId : pinnedId)
        expect(imageRunner.shardStartImageId(rig.state.images, false)).toBe(pinnedId)
        imageAssertNoLeak(imageOutputs(rig, outcomes))
      })

      test('with image-drift and retag both, drift is built first, then retag, and the pinned, drift and retag IDs all differ as the fake reports them', async () => {
        const rig = makeE8Rig()
        const pinnedId = await pinTestImage(rig)
        const faults = faultsOf(rig, ['retag', 'image-drift:1'])
        const outcomes = await imageRunner.buildFaultImages(rig.imagesContext, rig.state, faults)

        const driftTag = imageRunner.formatRunTag(IMAGE_OWNER, 'drift')
        const retagTag = imageRunner.formatRunTag(IMAGE_OWNER, 'retag')
        expect(rig.docker.operations('image-build').map((op) => op.refs)).toEqual([[testTag()], [driftTag], [retagTag]])
        const driftId = rig.state.images.driftId!
        const retagId = rig.state.images.retagId!
        expect(outcomes).toEqual({ drift: { kind: 'built', imageId: driftId }, retag: { kind: 'built', imageId: retagId } })
        expect([rig.docker.image(testTag())?.id, rig.docker.image(driftTag)?.id, rig.docker.image(retagTag)?.id]).toEqual([pinnedId, driftId, retagId])
        expect(new Set([pinnedId, driftId, retagId]).size).toBe(3)
        expect(rig.docker.image(driftId)?.labels[imageRunner.FAULT_LABEL]).toBe('drift')
        expect(rig.docker.image(retagId)?.labels[imageRunner.FAULT_LABEL]).toBe('retag')
        expect(rig.state.images.tagsMade).toEqual({ test: true, drift: true, retag: true })
        imageAssertNoLeak(imageOutputs(rig, outcomes))
      })

      /** One failed fault build: how it fails, and its exit status and whether it was spawned. */
      const FAULT_BUILD_FAILURES: readonly (readonly [string, (rig: ImageRig, role: FaultLabelValue) => void, number, boolean])[] = [
        ['a non-zero exit', (rig, role) => rig.docker.programBuild({ kind: 'failed', exitCode: TEST_IMAGE_FAULT_BUILD_EXIT }, { role }), TEST_IMAGE_FAULT_BUILD_EXIT, true],
        [
          'docker not started',
          (rig, role) => rig.recorder.answer(imageRunner.derivedImageBuildArgs(faultBuildSpec(role)), { notStarted: TEST_IMAGE_DOCKER_NOT_STARTED }),
          SPAWN_FAILED_EXIT_STATUS,
          false,
        ],
      ]
      const FAULT_BUILD_FAILURE_ROWS = TEST_IMAGE_FAULT_IMAGE_VALUES.flatMap((value) => FAULT_BUILD_FAILURES.map(([what, arrange, exitCode, started]) => [value, what, arrange, exitCode, started] as const))

      test.each(FAULT_BUILD_FAILURE_ROWS)('with %s, a build with %s records its failed outcome; E12\'s reason names its exit status; no ID is recorded and no tag is moved', async (value, _what, arrange, exitCode, started) => {
        const rig = makeE8Rig()
        const pinnedId = await pinTestImage(rig)
        const faults = faultsOf(rig, [value])
        const role = roleOf(rig, value)
        arrange(rig, role)
        const outcomes = await imageRunner.buildFaultImages(rig.imagesContext, rig.state, faults)

        expect(outcomes[role]).toEqual({ kind: 'failed', exitCode })
        expect(rig.state.images.builds[role]).toEqual({ kind: 'failed', exitCode })
        expect(roleId(rig, role)).toBeNull()
        expect(rig.state.images.buildsStarted[role]).toBe(started)
        expect(rig.state.images.tagsMade[role]).toBe(false)
        expect(rig.state.imageBuildInProgress).toBeNull()
        expect(rig.docker.image(imageRunner.formatRunTag(IMAGE_OWNER, role))).toBeNull()
        expect(imageRunner.shardStartImageId(rig.state.images, true)).toBe(pinnedId)

        const controller = controllerFor(rig, faults)
        noteFaultBuild(controller, role, outcomes[role])
        const spawned = rig.recorder.spawns().length
        const move = await imageRunner.moveTestTagToRetagImage(rig.imagesContext, rig.state)
        expect(move).toEqual({ kind: 'not-tried' })
        controller.noteTagMove(move)
        expect(rig.recorder.spawns()).toHaveLength(spawned)
        expect(rig.docker.operations('image-tag')).toEqual([])
        expect(rig.docker.image(testTag())?.id).toBe(pinnedId)
        const record = recordFor(controller, role)
        expect([record.state, record.reason]).toEqual(['not-fired', buildFailedReason(role, exitCode)])
        expect(record.reason).toContain(String(exitCode))
        imageAssertNoLeak(imageOutputs(rig, { outcomes, records: controller.records() }))
      })

      /** One way the before-check finds the `-test` tag not naming the pinned ID: arranges it and answers the pinned ID and the reading. */
      const BEFORE_CHECK_MISMATCHES: readonly (readonly [string, (rig: ImageRig) => Promise<{ readonly pinnedId: string; readonly reading: TestTagReading }>])[] = [
        [
          'naming another image',
          async (rig) => {
            const pinnedId = await pinTestImage(rig)
            const decoyId = rig.docker.addImage({ tags: [testTag()], labels: { [imageRunner.OWNER_LABEL]: ownerValue() } })
            return { pinnedId, reading: { kind: 'image', imageId: decoyId } }
          },
        ],
        [
          'naming no image',
          async (rig) => {
            const pinnedId = rig.docker.addImage({ labels: { [imageRunner.OWNER_LABEL]: ownerValue() } })
            rig.state.images = { ...initialImageState(), pinnedId }
            return { pinnedId, reading: { kind: 'missing' } }
          },
        ],
        [
          'that cannot be read',
          async (rig) => {
            const pinnedId = await pinTestImage(rig)
            rig.docker.fail('image-inspect', { stderr: TEST_IMAGE_INSPECT_ERROR })
            return { pinnedId, reading: { kind: 'unreadable', error: TEST_IMAGE_INSPECT_ERROR } }
          },
        ],
      ]
      const BEFORE_CHECK_ROWS = TEST_IMAGE_FAULT_IMAGE_VALUES.flatMap((value) => BEFORE_CHECK_MISMATCHES.map(([what, arrange]) => [value, what, arrange] as const))

      test.each(BEFORE_CHECK_ROWS)('with %s, a -test tag %s before the build starts no build: a failed outcome, one log line, no tag made', async (value, _what, arrange) => {
        const rig = makeE8Rig()
        const { pinnedId, reading } = await arrange(rig)
        const role = roleOf(rig, value)
        const logStart = rig.logLines.length
        const spawnStart = rig.recorder.spawns().length
        const outcome = await imageRunner.buildFaultImage(rig.imagesContext, rig.state, role)

        expect(outcome).toEqual({ kind: 'failed', exitCode: imageRunner.FAILURE_EXIT_STATUS })
        expect(rig.recorder.argvs().slice(spawnStart)).toEqual([imageRunner.imageInspectArgs([testTag()])])
        expect(rig.docker.operations('image-build').map((op) => op.refs)).not.toContainEqual([imageRunner.formatRunTag(IMAGE_OWNER, role)])
        expect(rig.logLines.slice(logStart)).toEqual([imageRunner.testTagCheckFailedLine(role, 'before', testTag(), pinnedId, reading)])
        expect(rig.state.images.builds[role]).toEqual(outcome)
        expect(roleId(rig, role)).toBeNull()
        expect(rig.state.images.buildsStarted[role]).toBe(false)
        expect(rig.state.images.tagsMade[role]).toBe(false)

        const controller = controllerFor(rig, faultsOf(rig, [value]))
        noteFaultBuild(controller, role, outcome)
        expect(recordFor(controller, role).reason).toBe(buildFailedReason(role, imageRunner.FAILURE_EXIT_STATUS))
        imageAssertNoLeak(imageOutputs(rig, { outcome, records: controller.records() }))
      })

      /** One way the after-check finds the `-test` tag not naming the pinned ID, arranged from a fake-clock timer while the build runs; answers the reading. */
      const AFTER_CHECK_MISMATCHES: readonly (readonly [string, (rig: ImageRig) => () => TestTagReading])[] = [
        [
          'moved to another image',
          (rig) => {
            let decoyId: string | null = null
            rig.clock.setTimeout(() => {
              decoyId = rig.docker.addImage({ tags: [testTag()] })
            }, TEST_IMAGE_BUILD_MS / 2)
            return () => ({ kind: 'image', imageId: decoyId! })
          },
        ],
        [
          'that cannot be read',
          (rig) => {
            rig.clock.setTimeout(() => rig.docker.fail('image-inspect', { stderr: TEST_IMAGE_INSPECT_ERROR }), TEST_IMAGE_BUILD_MS / 2)
            return () => ({ kind: 'unreadable', error: TEST_IMAGE_INSPECT_ERROR })
          },
        ],
      ]
      const AFTER_CHECK_ROWS = TEST_IMAGE_FAULT_IMAGE_VALUES.flatMap((value) => AFTER_CHECK_MISMATCHES.map(([what, arrange]) => [value, what, arrange] as const))

      test.each(AFTER_CHECK_ROWS)('with %s, a -test tag %s during the build fails it after: its image is built and tagged but its ID not used, one log line', async (value, _what, arrange) => {
        const rig = makeE8Rig()
        const pinnedId = await pinTestImage(rig)
        const role = roleOf(rig, value)
        rig.docker.programBuild({ kind: 'built', durationMs: TEST_IMAGE_BUILD_MS }, { role })
        const readingOf = arrange(rig)
        const logStart = rig.logLines.length
        const opStart = rig.docker.operations().length
        const building = imageRunner.buildFaultImage(rig.imagesContext, rig.state, role)
        await rig.clock.advance(TEST_IMAGE_BUILD_MS)
        const outcome = await building

        expect(outcome).toEqual({ kind: 'failed', exitCode: imageRunner.FAILURE_EXIT_STATUS })
        expect(rig.docker.operations().slice(opStart).map((op) => op.kind)).toEqual(['image-inspect', 'image-build', 'image-inspect'])
        const built = rig.docker.image(imageRunner.formatRunTag(IMAGE_OWNER, role))
        expect(built).not.toBeNull()
        expect(built?.id).not.toBe(pinnedId)
        expect(built?.labels[imageRunner.FAULT_LABEL]).toBe(role)
        const checkLine = imageRunner.testTagCheckFailedLine(role, 'after', testTag(), pinnedId, readingOf())
        const logged = rig.logLines.slice(logStart)
        expect(logged.at(-1)).toBe(checkLine)
        expect(logged.filter((line) => line === checkLine)).toHaveLength(1)
        expect(rig.state.images.builds[role]).toEqual(outcome)
        expect(roleId(rig, role)).toBeNull()
        expect(rig.state.images.buildsStarted[role]).toBe(true)
        expect(rig.state.images.tagsMade[role]).toBe(true)
        expect(rig.state.imageBuildInProgress).toBeNull()
        expect(imageRunner.shardStartImageId(rig.state.images, true)).toBe(pinnedId)
        expect(await imageRunner.moveTestTagToRetagImage(rig.imagesContext, rig.state)).toEqual({ kind: 'not-tried' })
        expect(rig.docker.operations('image-tag')).toEqual([])

        const controller = controllerFor(rig, faultsOf(rig, [value]))
        noteFaultBuild(controller, role, outcome)
        expect(recordFor(controller, role).reason).toBe(buildFailedReason(role, imageRunner.FAILURE_EXIT_STATUS))
        imageAssertNoLeak(imageOutputs(rig, { outcome, records: controller.records() }))
      })
    })

    describe('the tag move', () => {
      /** Pins the test image and builds the drift and retag images, with the base image and an unrelated image in the fake too; answers the pinned and retag IDs and the faults. */
      async function buildForMove(rig: ImageRig): Promise<{ readonly pinnedId: string; readonly retagId: string; readonly faults: readonly Fault[] }> {
        rig.addBaseImage()
        rig.docker.addImage({ tags: ['e8c-unrelated:latest'] })
        const pinnedId = await pinTestImage(rig)
        const faults = faultsOf(rig, TEST_IMAGE_FAULT_IMAGE_VALUES)
        await imageRunner.buildFaultImages(rig.imagesContext, rig.state, faults)
        const retagId = rig.state.images.retagId
        if (retagId === null) throw new Error('buildForMove: no retag image')
        return { pinnedId, retagId, faults }
      }

      test('the move takes -test onto the retag image\'s ID with one docker image tag, changes no other tag and sets retagMoved; fault injection records retag fired', async () => {
        const rig = makeE8Rig()
        const { pinnedId, retagId, faults } = await buildForMove(rig)
        const before = tagsById(rig)
        const spawnStart = rig.recorder.spawns().length
        const logStart = rig.logLines.length
        const moved = await imageRunner.moveTestTagToRetagImage(rig.imagesContext, rig.state)

        expect(moved).toEqual({ kind: 'moved' })
        expect(rig.state.images.retagMoved).toBe(true)
        expect(rig.recorder.argvs().slice(spawnStart)).toEqual([imageRunner.imageTagArgs(retagId, testTag())])
        expect(rig.docker.operations('image-tag').map((op) => op.refs)).toEqual([[retagId, testTag()]])
        expect(rig.docker.image(testTag())?.id).toBe(retagId)
        const expected = Object.fromEntries(
          Object.entries(before).map(([id, tags]) => [id, [...tags.filter((tag) => tag !== testTag()), ...(id === retagId ? [testTag()] : [])]]),
        )
        expect(tagsById(rig)).toEqual(expected)
        expect(rig.docker.image(pinnedId)?.tags).toEqual([])
        expect(rig.logLines.slice(logStart)).toEqual([])

        const controller = controllerFor(rig, faults)
        controller.noteRetagBuild(rig.state.images.builds.retag)
        controller.noteTagMove(moved)
        expect([recordFor(controller, 'retag').state, recordFor(controller, 'retag').reason]).toEqual(['fired', null])
        imageAssertNoLeak(imageOutputs(rig, { moved, records: controller.records() }))
      })

      /** One failed move: how it fails, its exit status and its error text. */
      const MOVE_FAILURES: readonly (readonly [string, (rig: ImageRig, retagId: string) => void, number, string])[] = [
        ['docker exits non-zero', (rig) => rig.docker.fail('image-tag', { exitCode: TEST_IMAGE_TAG_EXIT, stderr: TEST_IMAGE_TAG_ERROR }), TEST_IMAGE_TAG_EXIT, TEST_IMAGE_TAG_ERROR],
        [
          'docker not started',
          (rig, retagId) => rig.recorder.answer(imageRunner.imageTagArgs(retagId, testTag()), { notStarted: TEST_IMAGE_DOCKER_NOT_STARTED }),
          SPAWN_FAILED_EXIT_STATUS,
          TEST_IMAGE_DOCKER_NOT_STARTED,
        ],
      ]

      test.each(MOVE_FAILURES)('a move where %s is a failed outcome with its exit status, one log line, retagMoved false and every tag unchanged; E12\'s reason names the status', async (_what, arrange, exitCode, error) => {
        const rig = makeE8Rig()
        const { pinnedId, retagId, faults } = await buildForMove(rig)
        arrange(rig, retagId)
        const before = tagsById(rig)
        const logStart = rig.logLines.length
        const moved = await imageRunner.moveTestTagToRetagImage(rig.imagesContext, rig.state)

        expect(moved).toEqual({ kind: 'failed', exitCode })
        expect(rig.state.images.retagMoved).toBe(false)
        expect(rig.logLines.slice(logStart)).toEqual([imageRunner.tagMoveFailedLogLine(testTag(), retagId, exitCode, error)])
        expect(tagsById(rig)).toEqual(before)
        expect(rig.docker.image(testTag())?.id).toBe(pinnedId)

        const controller = controllerFor(rig, faults)
        controller.noteRetagBuild(rig.state.images.builds.retag)
        controller.noteTagMove(moved)
        const record = recordFor(controller, 'retag')
        expect([record.state, record.reason]).toEqual(['not-fired', imageRunner.tagMoveFailedReason(exitCode)])
        expect(record.reason).toContain(String(exitCode))
        imageAssertNoLeak(imageOutputs(rig, { moved, records: controller.records() }))
      })
    })
  })

  // --- read-back (.S7) ---

  describe('step 12: reading the pinned image back', () => {
    const {
      CI_LABEL,
      CI_LABEL_VALUE,
      containerCopyOutArgs,
      containerCreateArgs,
      containerRemoveArgs,
      DOCKER_NO_SUCH_IMAGE_TEXT,
      DURATION_TABLE_PATH,
      IMAGE_TESTS_DIR,
      imageAddedScriptReason,
      imageDurationTableNotRegularText,
      imageMissingScriptReason,
      imageNotRegularEntryReason,
      imagePrerequisiteDifferenceReason,
      INTEGRATION_DIR_PATH,
      NOT_RUN_PREFIX,
      numberFormOf,
      OWNER_LABEL,
      parsePrerequisiteLines,
      readBackArchiveUnreadableText,
      readBackFailedReason,
      readBackIntegrationUnlistableText,
      readBackPinnedImage,
      readContainerCopyFailedText,
      readContainerCreateFailedText,
      readContainerLabels,
      readContainerName,
      readContainerRemovalFailedText,
      removeReadContainerIfPresent,
      TAR_BLOCK_BYTES,
    } = imageRunner
    const { buildTarArchive, durationTableText, minimalScriptText, realScriptFileName } = imageHelper
    type PrerequisiteLine = imageHelper.PrerequisiteLine
    type ReadBackOutcome = imageRunner.ReadBackOutcome
    type DurationTableSource = imageRunner.DurationTableSource
    type OperationKind = imageHelper.FakeDockerOperationKind

    /** Test data: the duration table, a carriage return on its second line and no final line feed, so a text handed on unchanged is visibly so. */
    const TARBALL_TABLE_TEXT = durationTableText({
      kind: 'rows',
      header: null,
      rows: [
        { script: 1, seconds: 40 },
        { script: 3, seconds: 95 },
      ],
      carriageReturns: [2],
      finalNewline: false,
    })
    /** The archive's name for the image's `/tests`: `docker container cp <c>:/tests -` names its entries `tests/...`. */
    const TARBALL_TESTS_ENTRY = IMAGE_TESTS_DIR.slice(1)
    /** Test data: a pinned ID of the right form that no image of the fake has: the image is gone. */
    const TARBALL_GONE_IMAGE_ID = `sha256:${'e8d0'.repeat(16)}`
    /** The read container's operations when its create succeeds: one create, one copy-out of `/tests`, one removal. */
    const READ_KINDS: readonly OperationKind[] = ['container-create', 'container-copy', 'container-remove']

    /** A rig whose worktree carries the region's duration table and these prerequisite lines by script number, without the scripts numbered `without`. */
    function makeReadBackRig(prerequisites: Readonly<Record<number, readonly PrerequisiteLine[]>> = {}, without: readonly number[] = []): ImageRig {
      return makeE8Rig({ worktree: { prerequisites, without, durationTable: { kind: 'text', text: TARBALL_TABLE_TEXT } } })
    }

    /** What an image built from the rig's worktree holds under `/tests`, as `buildTarArchive` entries: `tests/`, `tests/integration/`, every script with its worktree bytes, and the duration table when the worktree has one. */
    function worktreeTestsEntries(rig: ImageRig): Record<string, string | Uint8Array> {
      const entries: Record<string, string | Uint8Array> = { [`${TARBALL_TESTS_ENTRY}/`]: '', [`${INTEGRATION_DIR_PATH}/`]: '' }
      for (const fileName of imageFs.readdirSync(rig.worktree.integrationDir).sort()) {
        entries[`${INTEGRATION_DIR_PATH}/${fileName}`] = imageFs.readFileSync(imagePath.join(rig.worktree.integrationDir, fileName))
      }
      if (imageFs.existsSync(rig.worktree.durationTablePath)) entries[DURATION_TABLE_PATH] = imageFs.readFileSync(rig.worktree.durationTablePath)
      return entries
    }

    /** Adds an image whose `/tests` copies out as `archive`; answers its ID, the pinned ID to read back. */
    function addPinnedImage(rig: ImageRig, archive: Uint8Array): string {
      return rig.docker.addImage({ archives: { [IMAGE_TESTS_DIR]: archive } })
    }

    /** Adds an image identical to the rig's worktree, as `buildTarArchive` writes it; answers its ID. */
    function pinWorktreeImage(rig: ImageRig): string {
      return addPinnedImage(rig, buildTarArchive(worktreeTestsEntries(rig)))
    }

    /** Script `n`'s entry name in the archive, its real file name looked up by number. */
    function inImage(n: number): string {
      return `${INTEGRATION_DIR_PATH}/${realScriptFileName(n)}`
    }

    // Archive forms `buildTarArchive` does not make (PAX and GNU headers, name
    // prefixes, base-256 numbers, links and special files) are written here,
    // header field by header field (POSIX ustar's places, which GNU shares).

    /** One raw tar header and its data. */
    interface TarballTarRecord {
      readonly name: string
      /** The type flag: `0` regular, `1` hard link, `2` symbolic link, `5` directory, `6` FIFO, `x` PAX, `g` PAX global, `L` GNU long name. */
      readonly type: string
      readonly data?: string | Uint8Array
      readonly linkName?: string
      /** The POSIX name prefix field. */
      readonly prefix?: string
      /** GNU's magic, `ustar  `, instead of POSIX's `ustar` and `00`. */
      readonly gnu?: boolean
      /** The size field's 12 bytes as given, instead of the data's length in octal. */
      readonly sizeField?: string | Uint8Array
    }

    const tarballEncoder = new TextEncoder()
    const tarballBytes = (value: string | Uint8Array = ''): Uint8Array => (typeof value === 'string' ? tarballEncoder.encode(value) : value)

    /** A header block for `record`, its checksum summed over its bytes with the checksum field as spaces. */
    function tarballTarHeader(record: TarballTarRecord, size: number): Uint8Array {
      const header = new Uint8Array(TAR_BLOCK_BYTES)
      const put = (offset: number, value: string | Uint8Array): void => header.set(tarballBytes(value), offset)
      put(0, record.name)
      put(100, '0000644\0')
      put(108, '0000000\0')
      put(116, '0000000\0')
      put(124, record.sizeField ?? `${size.toString(8).padStart(11, '0')}\0`)
      put(136, '00000000000\0')
      put(148, '        ')
      put(156, record.type)
      put(157, record.linkName ?? '')
      put(257, record.gnu === true ? 'ustar  \0' : 'ustar\0' + '00')
      put(345, record.prefix ?? '')
      put(148, `${header.reduce((sum, byte) => sum + byte, 0).toString(8).padStart(6, '0')}\0 `)
      return header
    }

    /** A tar archive of `records` in order, each data padded to whole blocks, ended by two zero blocks. */
    function tarballTar(records: readonly TarballTarRecord[]): Uint8Array {
      const blocks: Uint8Array[] = []
      for (const record of records) {
        const data = tarballBytes(record.data)
        blocks.push(tarballTarHeader(record, data.length), data, new Uint8Array((TAR_BLOCK_BYTES - (data.length % TAR_BLOCK_BYTES)) % TAR_BLOCK_BYTES))
      }
      blocks.push(new Uint8Array(2 * TAR_BLOCK_BYTES))
      return new Uint8Array(Buffer.concat(blocks))
    }

    /** PAX records, `<length> <key>=<value>\n` each, the length counting the whole record in bytes. */
    function tarballPaxData(records: Readonly<Record<string, string>>): string {
      return Object.entries(records)
        .map(([key, value]) => {
          const body = tarballEncoder.encode(` ${key}=${value}\n`).length
          let length = body + 1
          while (`${length}`.length + body !== length) length = `${length}`.length + body
          return `${length} ${key}=${value}\n`
        })
        .join('')
    }

    /** The worktree's `/tests` as raw records: directories `5`, files `0`, in `worktreeTestsEntries`' order. */
    function worktreeRecords(rig: ImageRig): TarballTarRecord[] {
      return Object.entries(worktreeTestsEntries(rig)).map(([name, data]): TarballTarRecord => (name.endsWith('/') ? { name, type: '5' } : { name, type: '0', data }))
    }

    /** `records` with the one named `name` replaced by `replacement` (none: left out); throws when none is named so. */
    function withRecord(records: readonly TarballTarRecord[], name: string, ...replacement: TarballTarRecord[]): TarballTarRecord[] {
      if (!records.some((record) => record.name === name)) throw new Error(`withRecord: no record named ${name}`)
      return records.flatMap((record) => (record.name === name ? replacement : [record]))
    }

    /** A regular script record for real script `n` with these prerequisite lines, as the worktree builder writes one. */
    function scriptRecord(n: number, lines: readonly PrerequisiteLine[] = []): TarballTarRecord {
      return { name: inImage(n), type: '0', data: minimalScriptText(realScriptFileName(n), lines) }
    }

    /** The argument lists of a read container whose create succeeded: its create from the pinned ID with exactly its two labels, its copy-out of `/tests` and its removal, all by its name. */
    function readContainerArgvs(rig: ImageRig, pinnedId: string): string[][] {
      const name = readContainerName(rig.owner)
      return [containerCreateArgs(name, readContainerLabels(rig.owner), pinnedId), containerCopyOutArgs(name, IMAGE_TESTS_DIR), containerRemoveArgs(name)]
    }

    /** the read-back spawned exactly one create, the copy-out and the removal, nothing started or run, and no container is left. */
    function expectOneReadContainer(rig: ImageRig, pinnedId: string): void {
      expect(rig.recorder.argvs()).toEqual(readContainerArgvs(rig, pinnedId))
      expect(rig.docker.operations().map((op) => op.kind)).toEqual([...READ_KINDS])
      expect(rig.docker.containers()).toEqual([])
    }

    /** Each output a read-back case checks for a leak: the outcome, the runner log and every file under the run directory. */
    function readBackOutputs(rig: ImageRig, outcome: unknown): unknown {
      return { outcome, logLines: rig.logLines, runDir: imageWrittenFile(rig.runDir) }
    }

    /** The outcome of an image identical to the worktree: its list, prerequisites and run scripts are the validated ones, its table text unchanged. */
    function matchingOutcome(validated: ValidatedRun): ReadBackOutcome {
      return {
        ok: true,
        readBack: { scripts: validated.scripts, prerequisites: validated.prerequisites, runScripts: validated.runScripts, durationTable: { kind: 'text', text: TARBALL_TABLE_TEXT } },
        cleanupFailure: null,
      }
    }

    test('the read container\'s name is cscb-ci-<RUN_ID>-<PID>-read, its labels exactly cscb-ci=1 and the owner, and the copied path /tests (pin)', () => {
      expect(readContainerName(IMAGE_OWNER)).toBe(`cscb-ci-${IMAGE_RUN_ID}-${IMAGE_RUNNER_PID}-read`)
      expect(readContainerLabels(IMAGE_OWNER)).toEqual({ [CI_LABEL]: CI_LABEL_VALUE, [OWNER_LABEL]: `${IMAGE_RUN_ID}-${IMAGE_RUNNER_PID}` })
      expect(IMAGE_TESTS_DIR).toBe('/tests')
    })

    test('an image identical to the worktree is read through one never-started container, removed before the read-back returns; its list, prerequisites and table text are handed on unchanged and nothing is written', async () => {
      const rig = makeReadBackRig({ 3: [{ names: [2] }] })
      const validated = rig.validate()
      const pinnedId = pinWorktreeImage(rig)
      const before = imageTreeSnapshot(rig.root, { extended: true })

      const outcome = await readBackPinnedImage(rig.readBackContext(pinnedId), validated)

      expect(outcome).toEqual(matchingOutcome(validated))
      expect(validated.prerequisites.get(realScriptFileName(3))).toEqual([realScriptFileName(2)])
      expectOneReadContainer(rig, pinnedId)
      expect(imageTreeSnapshot(rig.root, { extended: true })).toEqual(before)
      expect(rig.logLines).toEqual([])
      imageAssertNoLeak(readBackOutputs(rig, outcome))
    })

    test('in a selective run, the run\'s scripts are taken from the image\'s list: the selected script, its prerequisites and test-1', async () => {
      const rig = makeReadBackRig({ 3: [{ names: [2] }] })
      const validated = rig.validate([numberFormOf(3)])
      const outcome = await readBackPinnedImage(rig.readBackContext(pinWorktreeImage(rig)), validated)

      expect(outcome).toEqual(matchingOutcome(validated))
      if (outcome.ok) {
        expect(outcome.readBack.runScripts.map((script) => script.fileName)).toEqual([1, 2, 3].map(realScriptFileName))
        expect(outcome.readBack.scripts).toEqual(validated.scripts)
      }
      imageAssertNoLeak(readBackOutputs(rig, outcome))
    })

    /** Tables scheduling finds unreadable, which is no read-back failure: the image's archive, and the table as scheduling's scheduling input takes it. */
    const UNREADABLE_TABLES: readonly (readonly [string, (rig: ImageRig) => Uint8Array, DurationTableSource])[] = [
      ['no /tests/ci-durations.tsv', (rig) => tarballTar(withRecord(worktreeRecords(rig), DURATION_TABLE_PATH)), { kind: 'missing' }],
      [
        'a symbolic link at /tests/ci-durations.tsv',
        (rig) => tarballTar(withRecord(worktreeRecords(rig), DURATION_TABLE_PATH, { name: DURATION_TABLE_PATH, type: '2', linkName: 'integration' })),
        { kind: 'unreadable', error: imageDurationTableNotRegularText('symlink') },
      ],
      [
        'a directory at /tests/ci-durations.tsv',
        (rig) => tarballTar(withRecord(worktreeRecords(rig), DURATION_TABLE_PATH, { name: `${DURATION_TABLE_PATH}/`, type: '5' })),
        { kind: 'unreadable', error: imageDurationTableNotRegularText('directory') },
      ],
    ]

    test.each(UNREADABLE_TABLES)('an image with %s is no failure: the table is handed to scheduling as missing or unreadable', async (_what, archiveOf, durationTable) => {
      const rig = makeReadBackRig()
      const validated = rig.validate()
      const pinnedId = addPinnedImage(rig, archiveOf(rig))
      const outcome = await readBackPinnedImage(rig.readBackContext(pinnedId), validated)

      expect(outcome).toEqual({
        ok: true,
        readBack: { scripts: validated.scripts, prerequisites: validated.prerequisites, runScripts: validated.runScripts, durationTable },
        cleanupFailure: null,
      })
      expectOneReadContainer(rig, pinnedId)
      expect(rig.logLines).toEqual([])
      imageAssertNoLeak(readBackOutputs(rig, outcome))
    })

    /** One difference between the image and the worktree: the worktree's prerequisite lines and left-out numbers, the image's records from the worktree's, and the one reason expected. */
    interface DifferenceRow {
      readonly prerequisites?: Readonly<Record<number, readonly PrerequisiteLine[]>>
      readonly without?: readonly number[]
      readonly image: (records: readonly TarballTarRecord[]) => readonly TarballTarRecord[]
      readonly reason: (validated: ValidatedRun) => string
      /** What the reason must name besides the script. */
      readonly names?: readonly number[]
    }

    /** Script `n`'s prerequisite difference (default script 3), built by the runner's own reason builder over validation's parse of the image's text. */
    function prerequisiteReason(validated: ValidatedRun, imageLines: readonly PrerequisiteLine[], n = 3): string {
      const fileName = realScriptFileName(n)
      const reason = imagePrerequisiteDifferenceReason(
        fileName,
        validated.prerequisites.get(fileName) ?? [],
        parsePrerequisiteLines(fileName, minimalScriptText(fileName, imageLines)),
        validated.scripts,
      )
      if (reason === null) throw new Error('prerequisiteReason: the lines do not differ')
      return reason
    }

    const DIFFERENCES: readonly (readonly [string, DifferenceRow])[] = [
      ['a script the image lacks', { image: (records) => withRecord(records, inImage(7)), reason: () => imageMissingScriptReason(realScriptFileName(7)) }],
      ['a regular script the worktree lacks', { without: [7], image: (records) => [...records, scriptRecord(7)], reason: () => imageAddedScriptReason(realScriptFileName(7)) }],
      [
        'a script that is a symbolic link in the image',
        {
          image: (records) => withRecord(records, inImage(7), { name: inImage(7), type: '2', linkName: realScriptFileName(1) }),
          reason: () => imageNotRegularEntryReason(realScriptFileName(7), 'symlink'),
        },
      ],
      [
        'a script that is a directory in the image',
        { image: (records) => withRecord(records, inImage(7), { name: `${inImage(7)}/`, type: '5' }), reason: () => imageNotRegularEntryReason(realScriptFileName(7), 'directory') },
      ],
      [
        'a script that is a FIFO in the image',
        { image: (records) => withRecord(records, inImage(7), { name: inImage(7), type: '6' }), reason: () => imageNotRegularEntryReason(realScriptFileName(7), 'other') },
      ],
      [
        'a changed prerequisite line',
        {
          prerequisites: { 3: [{ names: [2] }] },
          image: (records) => withRecord(records, inImage(3), scriptRecord(3, [{ names: [4] }])),
          reason: (validated) => prerequisiteReason(validated, [{ names: [4] }]),
          names: [2, 4],
        },
      ],
      [
        'an added prerequisite line',
        {
          image: (records) => withRecord(records, inImage(3), scriptRecord(3, [{ names: [2] }])),
          reason: (validated) => prerequisiteReason(validated, [{ names: [2] }]),
          names: [2],
        },
      ],
      [
        'a removed prerequisite line',
        {
          prerequisites: { 3: [{ names: [2] }] },
          image: (records) => withRecord(records, inImage(3), scriptRecord(3)),
          reason: (validated) => prerequisiteReason(validated, []),
          names: [2],
        },
      ],
      [
        'a prerequisite line naming no script of the list',
        {
          image: (records) => withRecord(records, inImage(3), scriptRecord(3, [{ names: [numberFormOf(999)] }])),
          reason: (validated) => prerequisiteReason(validated, [{ names: [numberFormOf(999)] }]),
        },
      ],
      [
        'a second prerequisite line',
        {
          prerequisites: { 3: [{ names: [2] }] },
          image: (records) => withRecord(records, inImage(3), scriptRecord(3, [{ names: [2] }, { names: [2] }])),
          reason: (validated) => prerequisiteReason(validated, [{ names: [2] }, { names: [2] }]),
        },
      ],
    ]

    test.each(DIFFERENCES)('%s refuses as not runnable, naming it, with the read container still removed', async (_what, row) => {
      const rig = makeReadBackRig(row.prerequisites, row.without)
      const validated = rig.validate()
      const pinnedId = addPinnedImage(rig, tarballTar(row.image(worktreeRecords(rig))))
      const before = imageTreeSnapshot(rig.root, { extended: true })

      const outcome = await readBackPinnedImage(rig.readBackContext(pinnedId), validated)

      expect(outcome).toEqual({ ok: false, refusal: buildRefusal(null, row.reason(validated)), cleanupFailure: null })
      if (!outcome.ok) {
        expect(refusalLine(outcome.refusal)).toBe(`${NOT_RUN_PREFIX}${outcome.refusal.summary}`)
        for (const n of row.names ?? []) expect(outcome.refusal.summary).toContain(realScriptFileName(n))
      }
      expectOneReadContainer(rig, pinnedId)
      expect(imageTreeSnapshot(rig.root, { extended: true })).toEqual(before)
      expect(rig.logLines).toEqual([])
      imageAssertNoLeak(readBackOutputs(rig, outcome))
    })

    test('every difference is named, one per line, in the stated order: missing (canonical), added (bytewise), not regular (bytewise), prerequisite lines (canonical)', async () => {
      // Canonical and bytewise orders disagree on each pair: 2 < 10 but "test-10" < "test-2", and so on.
      const rig = makeReadBackRig({ 3: [{ names: [2] }], 21: [{ names: [20] }] }, [5, 29])
      const validated = rig.validate()
      let records = worktreeRecords(rig)
      records = withRecord(records, inImage(10))
      records = withRecord(records, inImage(2))
      records = withRecord(records, inImage(12), { name: inImage(12), type: '2', linkName: realScriptFileName(1) })
      records = withRecord(records, inImage(4), { name: `${inImage(4)}/`, type: '5' })
      records = withRecord(records, inImage(3), scriptRecord(3))
      records = withRecord(records, inImage(21), scriptRecord(21, [{ names: [19] }]))
      records = [...records, scriptRecord(5), scriptRecord(29)]
      const pinnedId = addPinnedImage(rig, tarballTar(records))

      const outcome = await readBackPinnedImage(rig.readBackContext(pinnedId), validated)

      const reasons = [
        imageMissingScriptReason(realScriptFileName(2)),
        imageMissingScriptReason(realScriptFileName(10)),
        imageAddedScriptReason(realScriptFileName(29)),
        imageAddedScriptReason(realScriptFileName(5)),
        imageNotRegularEntryReason(realScriptFileName(12), 'symlink'),
        imageNotRegularEntryReason(realScriptFileName(4), 'directory'),
        prerequisiteReason(validated, []),
        prerequisiteReason(validated, [{ names: [19] }], 21),
      ]
      expect(outcome).toEqual({ ok: false, refusal: buildRefusal(null, reasons[0]!, reasons.slice(1)), cleanupFailure: null })
      expect(new Set(reasons).size).toBe(reasons.length)
      expectOneReadContainer(rig, pinnedId)
      imageAssertNoLeak(readBackOutputs(rig, outcome))
    })

    /** Image lines for script 5 that give exactly the worktree's `requires 2 and 4`: no difference. */
    const SAME_PREREQUISITES: readonly (readonly [string, readonly PrerequisiteLine[]])[] = [
      ['the names in another order', [{ names: [4, 2] }]],
      ['file names for number forms', [{ names: [realScriptFileName(2), realScriptFileName(4)] }]],
      ['an added test-1, which is ignored', [{ names: [2, 4, 1] }]],
      ['the line as the header block\'s first line, tab-separated', [{ names: [2, 4], placement: 'second-line', separator: '\t' }]],
    ]

    test.each(SAME_PREREQUISITES)('an image line with %s is no difference: the prerequisites compare as resolved sets', async (_what, lines) => {
      const rig = makeReadBackRig({ 5: [{ names: [2, 4] }] })
      const validated = rig.validate()
      const pinnedId = addPinnedImage(rig, tarballTar(withRecord(worktreeRecords(rig), inImage(5), scriptRecord(5, lines))))
      const outcome = await readBackPinnedImage(rig.readBackContext(pinnedId), validated)
      expect(outcome).toEqual(matchingOutcome(validated))
      expectOneReadContainer(rig, pinnedId)
      imageAssertNoLeak(readBackOutputs(rig, outcome))
    })

    /** Script 5's worktree text, which requires script 4, so a form that lost its content would differ. */
    const scriptFiveText = (): string => minimalScriptText(realScriptFileName(5), [{ names: [4] }])
    /** The base-256 form of a size: the flag byte, then the value big-endian. */
    const base256Size = (size: number): Uint8Array => {
      const field = new Uint8Array(12)
      field[0] = 0x80
      for (let at = 11, rest = size; rest > 0; at -= 1, rest = Math.floor(rest / 256)) field[at] = rest % 256
      return field
    }

    /** Archive forms Docker's tar writer (Go's archive/tar) or other archivers may give, each read exactly as the plain ustar archive is. */
    const ARCHIVE_FORMS: readonly (readonly [string, (records: readonly TarballTarRecord[]) => readonly TarballTarRecord[]])[] = [
      ['names starting with ./', (records) => records.map((record) => ({ ...record, name: `./${record.name}` }))],
      ['no directory entries, the directories implied by the files', (records) => records.filter((record) => record.type !== '5')],
      [
        'names split into the ustar prefix field',
        (records) =>
          records.map((record) => {
            const cut = record.name.lastIndexOf('/', record.name.length - 2)
            return cut < 0 ? record : { ...record, prefix: record.name.slice(0, cut), name: record.name.slice(cut + 1) }
          }),
      ],
      ['GNU headers', (records) => records.map((record) => ({ ...record, gnu: true }))],
      [
        'a GNU long-name header before a script',
        (records) =>
          withRecord(records, inImage(5), { name: '././@LongLink', type: 'L', data: `${inImage(5)}\0`, gnu: true }, { name: 'e8d-truncated-name', type: '0', data: scriptFiveText(), gnu: true }),
      ],
      [
        'a PAX path header before a script',
        (records) => withRecord(records, inImage(5), { name: 'PaxHeaders/e8d', type: 'x', data: tarballPaxData({ path: inImage(5) }) }, { name: 'e8d-placeholder', type: '0', data: scriptFiveText() }),
      ],
      [
        'a PAX size record over a zero size field',
        (records) =>
          withRecord(
            records,
            DURATION_TABLE_PATH,
            { name: 'PaxHeaders/e8d', type: 'x', data: tarballPaxData({ size: `${tarballBytes(TARBALL_TABLE_TEXT).length}` }) },
            { name: DURATION_TABLE_PATH, type: '0', data: TARBALL_TABLE_TEXT, sizeField: `${'0'.repeat(11)}\0` },
          ),
      ],
      ['a PAX global header first', (records) => [{ name: 'pax_global_header', type: 'g', data: tarballPaxData({ comment: 'e8d' }) }, ...records]],
      ['a base-256 size field', (records) => withRecord(records, DURATION_TABLE_PATH, { name: DURATION_TABLE_PATH, type: '0', data: TARBALL_TABLE_TEXT, sizeField: base256Size(tarballBytes(TARBALL_TABLE_TEXT).length) })],
      [
        'a script that is a hard link to a regular file before it',
        (records) => [
          { name: `${TARBALL_TESTS_ENTRY}/e8d-link-target`, type: '0', data: scriptFiveText() },
          ...withRecord(records, inImage(5), { name: inImage(5), type: '1', linkName: `${TARBALL_TESTS_ENTRY}/e8d-link-target` }),
        ],
      ],
      ['a script named twice, first as a symbolic link: the last entry wins', (records) => [{ name: inImage(5), type: '2', linkName: realScriptFileName(1) }, ...records]],
    ]

    test.each(ARCHIVE_FORMS)('an archive with %s reads as the plain ustar archive does: no difference', async (_what, form) => {
      const rig = makeReadBackRig({ 5: [{ names: [4] }] })
      const validated = rig.validate()
      const pinnedId = addPinnedImage(rig, tarballTar(form(worktreeRecords(rig))))
      const outcome = await readBackPinnedImage(rig.readBackContext(pinnedId), validated)
      expect(outcome).toEqual(matchingOutcome(validated))
      expect(validated.prerequisites.get(realScriptFileName(5))).toEqual([realScriptFileName(4)])
      imageAssertNoLeak(readBackOutputs(rig, outcome))
    })

    /** What an outright failure's reason must be: whole, or (when the error is the reader's or Docker's own text) its start from the runner's builders over an empty error, with more after it. */
    type FailureReason = { readonly whole: string } | { readonly startsWith: string; readonly holds?: string }

    /** One outright failure: the fake's arrangement (answering the pinned ID), the reason, and the docker operations spawned. */
    interface OutrightFailureRow {
      readonly arrange: (rig: ImageRig) => string
      readonly reason: (name: string, pinnedId: string) => FailureReason
      readonly kinds: readonly OperationKind[]
    }

    /** Test data: a daemon error over two lines, which a refusal holds on one. */
    const TARBALL_TWO_LINE_ERROR = 'Error response from daemon: e8d failure\n  on a second line'
    const TARBALL_ONE_LINE_ERROR = 'Error response from daemon: e8d failure on a second line'
    const unreadableArchive = (): FailureReason => ({ startsWith: readBackFailedReason(readBackArchiveUnreadableText('')) })
    const unlistable = (): FailureReason => ({ startsWith: readBackFailedReason(readBackIntegrationUnlistableText('')) })
    const copyFailed = (name: string): FailureReason => ({ startsWith: readBackFailedReason(readContainerCopyFailedText(name, '')) })
    const pinRecords = (records: (rig: ImageRig) => readonly TarballTarRecord[]) => (rig: ImageRig) => addPinnedImage(rig, tarballTar(records(rig)))
    const pinBytes = (bytes: (rig: ImageRig) => Uint8Array) => (rig: ImageRig) => addPinnedImage(rig, bytes(rig))
    const tableAndTests = (rig: ImageRig): TarballTarRecord[] => worktreeRecords(rig).filter((record) => !record.name.startsWith(`${INTEGRATION_DIR_PATH}/`))

    const OUTRIGHT_FAILURES: readonly (readonly [string, OutrightFailureRow])[] = [
      [
        'a pinned ID that is not an image ID (nothing spawned)',
        { arrange: () => 'cscb-ci-e8d:latest', reason: (name, id) => ({ startsWith: readBackFailedReason(readContainerCreateFailedText(name, id, '')) }), kinds: [] },
      ],
      [
        'a create that fails because the pinned image is gone',
        {
          arrange: () => TARBALL_GONE_IMAGE_ID,
          reason: (name, id) => ({ startsWith: readBackFailedReason(readContainerCreateFailedText(name, id, '')), holds: DOCKER_NO_SUCH_IMAGE_TEXT }),
          kinds: ['container-create'],
        },
      ],
      [
        'a create that fails with a two-line error',
        {
          arrange: (rig) => {
            rig.docker.fail('container-create', { stderr: TARBALL_TWO_LINE_ERROR })
            return pinWorktreeImage(rig)
          },
          reason: (name, id) => ({ whole: readBackFailedReason(readContainerCreateFailedText(name, id, TARBALL_ONE_LINE_ERROR)) }),
          kinds: ['container-create'],
        },
      ],
      [
        'a create that exits 0 without a container ID (the container removed if present)',
        {
          arrange: (rig) => {
            rig.docker.fail('container-create', { exitCode: 0, stderr: '' })
            return pinWorktreeImage(rig)
          },
          reason: (name, id) => ({ startsWith: readBackFailedReason(readContainerCreateFailedText(name, id, '')) }),
          kinds: ['container-create', 'container-remove'],
        },
      ],
      [
        'a copy that fails with a two-line error',
        {
          arrange: (rig) => {
            rig.docker.fail('container-copy', { stderr: TARBALL_TWO_LINE_ERROR })
            return pinWorktreeImage(rig)
          },
          reason: (name) => ({ whole: readBackFailedReason(readContainerCopyFailedText(name, TARBALL_ONE_LINE_ERROR)) }),
          kinds: READ_KINDS,
        },
      ],
      ['an image with no /tests to copy (never taken for a missing table)', { arrange: (rig) => rig.docker.addImage(), reason: copyFailed, kinds: READ_KINDS }],
      ['a copy that exits 0 with no archive', { arrange: pinBytes(() => new Uint8Array(0)), reason: copyFailed, kinds: READ_KINDS }],
      [
        'an archive whose first header fails its checksum',
        {
          arrange: pinBytes((rig) => {
            const archive = tarballTar(worktreeRecords(rig))
            archive[1] = archive[1]! + 1
            return archive
          }),
          reason: unreadableArchive,
          kinds: READ_KINDS,
        },
      ],
      ['an archive that ends inside a header block', { arrange: pinBytes((rig) => tarballTar(worktreeRecords(rig)).subarray(0, TAR_BLOCK_BYTES + 100)), reason: unreadableArchive, kinds: READ_KINDS }],
      [
        'an archive whose entry data runs past its end',
        { arrange: pinBytes(() => tarballTar([{ name: inImage(1), type: '0', data: 'x'.repeat(TAR_BLOCK_BYTES + 88) }]).subarray(0, 2 * TAR_BLOCK_BYTES)), reason: unreadableArchive, kinds: READ_KINDS },
      ],
      [
        'an archive with a size field that is no number',
        { arrange: pinRecords((rig) => [{ name: inImage(1), type: '0', data: 'x', sizeField: '0000000zzzz\0' }, ...worktreeRecords(rig)]), reason: unreadableArchive, kinds: READ_KINDS },
      ],
      [
        'an archive with a malformed PAX record',
        { arrange: pinRecords((rig) => [{ name: 'PaxHeaders/e8d', type: 'x', data: 'not a record\n' }, ...worktreeRecords(rig)]), reason: unreadableArchive, kinds: READ_KINDS },
      ],
      [
        'an archive with a PAX size that is not a whole number',
        { arrange: pinRecords((rig) => [{ name: 'PaxHeaders/e8d', type: 'x', data: tarballPaxData({ size: '12.5' }) }, ...worktreeRecords(rig)]), reason: unreadableArchive, kinds: READ_KINDS },
      ],
      [
        'an archive with a hard link naming no regular file before it',
        {
          arrange: pinRecords((rig) => withRecord(worktreeRecords(rig), inImage(5), { name: inImage(5), type: '1', linkName: `${TARBALL_TESTS_ENTRY}/e8d-nowhere` })),
          reason: unreadableArchive,
          kinds: READ_KINDS,
        },
      ],
      ['an empty archive: no tests/integration to list', { arrange: pinRecords(() => []), reason: unlistable, kinds: READ_KINDS }],
      ['an archive holding /tests without tests/integration', { arrange: pinRecords(tableAndTests), reason: unlistable, kinds: READ_KINDS }],
      [
        'an archive whose tests/integration is a regular file',
        { arrange: pinRecords((rig) => [...tableAndTests(rig), { name: INTEGRATION_DIR_PATH, type: '0', data: 'x' }]), reason: unlistable, kinds: READ_KINDS },
      ],
      [
        'an archive whose tests/integration is a symbolic link',
        { arrange: pinRecords((rig) => [...tableAndTests(rig), { name: INTEGRATION_DIR_PATH, type: '2', linkName: TARBALL_TESTS_ENTRY }]), reason: unlistable, kinds: READ_KINDS },
      ],
    ]

    test.each(OUTRIGHT_FAILURES)('%s refuses with NOT RUN: test image read-back failed: <error>, on one line', async (_what, row) => {
      const rig = makeReadBackRig()
      const validated = rig.validate()
      const pinnedId = row.arrange(rig)
      const before = imageTreeSnapshot(rig.root, { extended: true })

      const outcome = await readBackPinnedImage(rig.readBackContext(pinnedId), validated)

      expect(outcome.ok).toBe(false)
      if (!outcome.ok) {
        const { refusal } = outcome
        expect([refusal.kind, refusal.details, outcome.cleanupFailure]).toEqual([null, [], null])
        const line = refusalLine(refusal)
        expect(line).toBe(`${NOT_RUN_PREFIX}${refusal.summary}`)
        expect(line).not.toMatch(/[\r\n]/)
        const expected = row.reason(readContainerName(rig.owner), pinnedId)
        if ('whole' in expected) expect(refusal.summary).toBe(expected.whole)
        else {
          expect(refusal.summary.startsWith(expected.startsWith)).toBe(true)
          expect(refusal.summary.length).toBeGreaterThan(expected.startsWith.length)
          if (expected.holds !== undefined) expect(refusal.summary).toContain(expected.holds)
        }
      }
      expect(rig.docker.operations().map((op) => op.kind)).toEqual([...row.kinds])
      expect(rig.docker.operations('container-create').every((op) => op.refs[0] === readContainerName(rig.owner))).toBe(true)
      expect(rig.docker.containers()).toEqual([])
      expect(imageTreeSnapshot(rig.root, { extended: true })).toEqual(before)
      expect(rig.logLines).toEqual([])
      imageAssertNoLeak(readBackOutputs(rig, outcome))
    })

    test.each([
      ['an image that matches', false],
      ['a copy that fails', true],
    ] as const)('a failed read-container removal after %s is a cleanup failure, logged once, never the refusal', async (_what, copyFails) => {
      const rig = makeReadBackRig()
      const validated = rig.validate()
      const pinnedId = pinWorktreeImage(rig)
      const name = readContainerName(rig.owner)
      if (copyFails) rig.docker.fail('container-copy', { stderr: 'Error response from daemon: e8d copy failure' })
      rig.docker.fail('container-remove', { stderr: TARBALL_TWO_LINE_ERROR })

      const outcome = await readBackPinnedImage(rig.readBackContext(pinnedId), validated)

      const cleanupFailure = readContainerRemovalFailedText(name, TARBALL_ONE_LINE_ERROR)
      if (copyFails) {
        expect(outcome).toEqual({
          ok: false,
          refusal: buildRefusal(null, readBackFailedReason(readContainerCopyFailedText(name, 'Error response from daemon: e8d copy failure'))),
          cleanupFailure,
        })
      } else expect(outcome).toEqual({ ...matchingOutcome(validated), cleanupFailure })
      expect(rig.logLines).toEqual([cleanupFailure])
      expect(rig.recorder.argvs()).toEqual(readContainerArgvs(rig, pinnedId))
      imageAssertNoLeak(readBackOutputs(rig, outcome))
    })

    test.each([
      ['present: it is removed by name', true, false],
      ['already gone: no failure, nothing logged', false, false],
      ['present and docker refuses its removal: a cleanup failure, logged once', true, true],
    ] as const)('removing the read container if present (E13\'s end-of-run step 1), when it is %s', async (_what, present, refused) => {
      const rig = makeReadBackRig()
      const name = readContainerName(rig.owner)
      if (present) rig.docker.addContainer({ name, labels: readContainerLabels(rig.owner), running: false })
      if (refused) rig.docker.fail('container-remove', { stderr: TARBALL_TWO_LINE_ERROR })

      const removal = await removeReadContainerIfPresent(rig.dockerContext, rig.owner, rig.log)

      const line = readContainerRemovalFailedText(name, TARBALL_ONE_LINE_ERROR)
      expect(removal).toEqual(refused ? { kind: 'failed', line } : { kind: present ? 'removed' : 'absent' })
      expect(rig.logLines).toEqual(refused ? [line] : [])
      expect(rig.recorder.argvs()).toEqual([containerRemoveArgs(name)])
      expect(rig.docker.containers().map((container) => container.name)).toEqual(refused ? [name] : [])
      imageAssertNoLeak({ removal, logLines: rig.logLines })
    })
  })


  // --- cleanup and the removal-path test (.S8) ---

  describe('image cleanup and the removal-path test', () => {
    const {
      buildFaultImages,
      buildTestImage,
      checkBaseImage,
      CLEANUP_TAG_ORDER,
      cleanupRunImages,
      DOCKER_PROGRAM,
      FAIL_PREFIX,
      formatOwner,
      formatRunTag,
      IMAGE_TESTS_DIR,
      imageListArgs,
      imagePruneArgs,
      imageTagRemovalArgs,
      INTEGRATION_DIR_PATH,
      moveTestTagToRetagImage,
      NOT_RUN_PREFIX,
      OWNER_LABEL,
      PRUNE_ALREADY_RUNNING_TEXT,
      PRUNE_RETRIES,
      PRUNE_RETRY_INTERVAL_MS,
      readBackPinnedImage,
      RUN_TAG_ROLES,
      runBaseBuild,
      runImageCleanupPlan,
    } = imageRunner
    type Fault = imageRunner.Fault
    type ReadBackOutcome = imageRunner.ReadBackOutcome
    type RunImageCleanupReport = imageRunner.RunImageCleanupReport
    type RunTagRole = imageRunner.RunTagRole
    type FakeDockerOperation = imageHelper.FakeDockerOperation

    /** The run's owner label value, `<RUN_ID>-<PID>`. */
    const OWNER_VALUE = formatOwner(IMAGE_OWNER)
    /** The run's own run-private tag of a role. */
    const tagOf = (role: RunTagRole): string => formatRunTag(IMAGE_OWNER, role)
    /** Test data: the pinned image's ID, fixed so two rigs' cleanup commands can be compared. */
    const PINNED_ID = `sha256:${imageCreateHash('sha256').update('e8 cleanup: the pinned image').digest('hex')}`
    /** Test data: another run on the host, with its own owner and tags. */
    const OTHER_OWNER: Owner = { runId: '20261008t120000z-other001', pid: 6262 }
    /** Test data: a lane tag a person or `/ci-live` put on the same image. */
    const LANE_TAG = 'cscb-ci-l4:latest'
    const RETAG: Fault = { kind: 'retag' }
    const DRIFT: Fault = { kind: 'image-drift', shard: 1 }
    /** The filters of the listing cleanup must make, typed from the requirement (untagged, exactly the run's owner label), not taken from the runner's helper. */
    const OWN_UNTAGGED_LISTING = imageListArgs([
      { kind: 'dangling' },
      { kind: 'label', key: OWNER_LABEL, value: OWNER_VALUE },
    ])
    /** Another run's prune lasting this long refuses the run's first two tries; the third, two intervals in, finds the slot free. */
    const PRUNE_BUSY_FOR_TWO_TRIES_MS = PRUNE_RETRY_INTERVAL_MS + PRUNE_RETRY_INTERVAL_MS / 2
    /** Another run's prune lasting this long outlasts every try the run makes. */
    const PRUNE_BUSY_FOR_EVERY_TRY_MS = PRUNE_RETRY_INTERVAL_MS * (PRUNE_RETRIES + 1)

    /** Settles `work` on the rig's fake clock: one event-loop turn lets every pending continuation run, then the next timer fires, until it settles. */
    async function onClock<T>(rig: ImageRig, work: Promise<T>): Promise<T> {
      const box: { outcome: { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: unknown } | null } = { outcome: null }
      work.then(
        (value) => {
          box.outcome = { ok: true, value }
        },
        (error: unknown) => {
          box.outcome = { ok: false, error }
        },
      )
      for (;;) {
        await new Promise<void>((resolve) => setImmediate(resolve))
        const outcome = box.outcome
        if (outcome !== null) {
          if (outcome.ok) return outcome.value
          throw outcome.error
        }
        if (rig.clock.pendingCount() === 0) throw new Error('the work waits on nothing the fake clock holds')
        await rig.clock.runNext()
      }
    }

    /** What `/tests` holds in the pinned image: the worktree's scripts (`matching`), all but the last (`differing`), or no archive, so the copy-out fails (`none`). */
    type PinnedArchive = 'matching' | 'differing' | 'none'

    /** Adds the image the test build will report (`PINNED_ID`, the owner label, `/tests` as `archive` says, and any foreign tags) and programs the next test build to report it. */
    function preparePinnedImage(rig: ImageRig, archive: PinnedArchive = 'matching', foreignTags: readonly string[] = []): void {
      const names = archive === 'differing' ? rig.worktree.scriptFileNames.slice(0, -1) : rig.worktree.scriptFileNames
      const entries = Object.fromEntries(names.map((name) => [`${INTEGRATION_DIR_PATH}/${name}`, imageFs.readFileSync(imagePath.join(rig.worktree.integrationDir, name))]))
      rig.docker.addImage({
        id: PINNED_ID,
        tags: foreignTags,
        labels: { [OWNER_LABEL]: OWNER_VALUE },
        ...(archive === 'none' ? {} : { archives: { [IMAGE_TESTS_DIR]: imageHelper.buildTarArchive(entries) } }),
      })
      rig.docker.programBuild({ kind: 'built', imageId: PINNED_ID }, { role: 'test' })
    }

    /** Step 12 up to the read-back: the test build (pinned to `PINNED_ID`), then the read-back against the worktree. */
    async function buildAndReadBack(rig: ImageRig, archive: PinnedArchive = 'matching', foreignTags: readonly string[] = []): Promise<ReadBackOutcome> {
      preparePinnedImage(rig, archive, foreignTags)
      const built = await buildTestImage(rig.imagesContext, rig.state)
      expect(built.outcome).toEqual({ kind: 'built', imageId: PINNED_ID })
      return readBackPinnedImage(rig.readBackContext(PINNED_ID), rig.validate())
    }

    /** A passing run's images: the build and a matching read-back. */
    async function passingRun(rig: ImageRig, foreignTags: readonly string[] = []): Promise<unknown> {
      const read = await buildAndReadBack(rig, 'matching', foreignTags)
      expect(read.ok).toBe(true)
      return read
    }

    /** A `retag` run: the build, the read-back, the retag build and the tag move (failed when `moveFails`). */
    async function retagRun(rig: ImageRig, moveFails = false, foreignTags: readonly string[] = []): Promise<unknown> {
      const read = await buildAndReadBack(rig, 'matching', foreignTags)
      expect(read.ok).toBe(true)
      const faults = await buildFaultImages(rig.imagesContext, rig.state, [RETAG])
      expect(faults.retag.kind).toBe('built')
      if (moveFails) rig.docker.fail('image-tag')
      const move = await moveTestTagToRetagImage(rig.imagesContext, rig.state)
      expect(move.kind).toBe(moveFails ? 'failed' : 'moved')
      return { read, faults, move }
    }

    /** Ends the build `start` spawns as the run lifecycle's stop path would: the stop record set, then the build's process killed (SIGKILL), its result awaited. */
    async function stopDuringBuild<T>(rig: ImageRig, start: () => Promise<T>): Promise<T> {
      const pending = start()
      for (let turns = 0; rig.state.imageBuildInProgress === null && turns < 10; turns++) await rig.clock.flush()
      const build = rig.state.imageBuildInProgress
      expect(build?.pid).toEqual(expect.any(Number))
      rig.recordStop()
      rig.recorder.processes.makeGone(build!.pid!, 'SIGKILL')
      return pending
    }

    /** One path of the contract list through image preparation's steps, in the run lifecycle's order, and what cleanup must then do. */
    interface RemovalPath {
      readonly name: string
      /** Drives the run's image steps up to cleanup; answers what the run hands its verdict or refusal, which cleanup must leave unchanged. */
      readonly drive: (rig: ImageRig) => Promise<unknown>
      /** Set just before cleanup: failures on demand, another run's prune, a stop timer. */
      readonly beforeCleanup?: (rig: ImageRig) => void
      /** The run's tags cleanup removes, by role, in order. */
      readonly tags: readonly RunTagRole[]
      /** Whether cleanup lists the run's untagged images. */
      readonly lists: boolean
      /** The prunes cleanup spawns (each try counts). */
      readonly prunes: number
      /** The cleanup failures it lists. */
      readonly failures: number
    }

    /** Takes the prune slot with another run's prune lasting `durationMs` on the fake clock. */
    const otherRunPrune = (durationMs: number) => (rig: ImageRig): void => {
      expect(rig.docker.startOtherPrune({ durationMs, owner: formatOwner(OTHER_OWNER) })).toBe(true)
    }

    /** Test data: how long a derived build whose after-check fails runs on the fake clock. */
    const AFTER_CHECK_BUILD_MS = 10_000

    /**
     * A passing run, then the `fault`'s derived build, which exits 0 and makes
     * its tag while the `-test` tag turns unreadable halfway through, so the
     * after-check fails it: its outcome failed, its tag made.
     */
    const afterCheckFailedRun = (fault: Fault) => async (rig: ImageRig): Promise<unknown> => {
      const role: RunTagRole = fault.kind === 'retag' ? 'retag' : 'drift'
      await passingRun(rig)
      rig.docker.programBuild({ kind: 'built', durationMs: AFTER_CHECK_BUILD_MS }, { role })
      rig.clock.setTimeout(() => rig.docker.fail('image-inspect', { stderr: 'Error response from daemon: e8 after-check failure (test data)' }), AFTER_CHECK_BUILD_MS / 2)
      const faults = await buildFaultImages(rig.imagesContext, rig.state, [fault])
      expect(faults[role].kind).toBe('failed')
      expect(rig.state.images.tagsMade[role]).toBe(true)
      expect(rig.docker.image(tagOf(role))).not.toBeNull()
      const move = await moveTestTagToRetagImage(rig.imagesContext, rig.state)
      expect(move).toEqual({ kind: 'not-tried' })
      return { faults, move }
    }

    const REMOVAL_PATHS: readonly RemovalPath[] = [
      { name: 'a pass', drive: (rig) => passingRun(rig), tags: ['test'], lists: true, prunes: 0, failures: 0 },
      { name: 'retag with the tag move done', drive: (rig) => retagRun(rig), tags: ['retag', 'test'], lists: true, prunes: 1, failures: 0 },
      { name: 'retag with the tag move failed', drive: (rig) => retagRun(rig, true), tags: ['retag', 'test'], lists: true, prunes: 0, failures: 0 },
      {
        name: 'a failed drift build',
        drive: async (rig) => {
          await passingRun(rig)
          rig.docker.programBuild({ kind: 'failed' }, { role: 'drift' })
          const faults = await buildFaultImages(rig.imagesContext, rig.state, [DRIFT])
          expect(faults.drift.kind).toBe('failed')
          return faults
        },
        tags: ['test'],
        lists: true,
        prunes: 0,
        failures: 0,
      },
      {
        name: 'a failed retag build',
        drive: async (rig) => {
          await passingRun(rig)
          rig.docker.programBuild({ kind: 'failed' }, { role: 'retag' })
          const faults = await buildFaultImages(rig.imagesContext, rig.state, [RETAG])
          expect(faults.retag.kind).toBe('failed')
          const move = await moveTestTagToRetagImage(rig.imagesContext, rig.state)
          expect(move).toEqual({ kind: 'not-tried' })
          return { faults, move }
        },
        tags: ['test'],
        lists: true,
        prunes: 0,
        failures: 0,
      },
      { name: 'a drift build failed by its after-check', drive: afterCheckFailedRun(DRIFT), tags: ['drift', 'test'], lists: true, prunes: 0, failures: 0 },
      { name: 'a retag build failed by its after-check', drive: afterCheckFailedRun(RETAG), tags: ['retag', 'test'], lists: true, prunes: 0, failures: 0 },
      {
        name: 'a failed test build',
        drive: async (rig) => {
          rig.docker.programBuild({ kind: 'failed' }, { role: 'test' })
          const report = await buildTestImage(rig.imagesContext, rig.state)
          expect(report.failure?.line.startsWith(FAIL_PREFIX)).toBe(true)
          return report
        },
        tags: [],
        lists: true,
        prunes: 0,
        failures: 0,
      },
      {
        name: 'a test build that could not be spawned',
        drive: async (rig) => {
          const buildTag = tagOf('test')
          rig.recorder.answerWhen((request) => request.ownProcessGroup && request.argv.includes(buildTag), { notStarted: 'spawn docker ENOENT' })
          const report = await buildTestImage(rig.imagesContext, rig.state)
          expect(report.outcome.kind).toBe('failed')
          return report
        },
        tags: [],
        lists: false,
        prunes: 0,
        failures: 0,
      },
      {
        name: 'a refusal before the build (step 4)',
        drive: async (rig) => {
          rig.answerAdTagCheck({ exitCode: 128, stderr: 'fatal: Needed a single revision\n' })
          const stage = await checkBaseImage(rig.deps, rig.state)
          expect(stage.ok).toBe(false)
          return stage
        },
        tags: [],
        lists: false,
        prunes: 0,
        failures: 0,
      },
      {
        name: 'a failed base build',
        drive: async (rig) => {
          rig.answerPrerequisites()
          expect((await checkBaseImage(rig.deps, rig.state)).ok).toBe(true)
          rig.answerBaseBuildStep({ exitCode: 1 })
          const stage = await runBaseBuild(rig.deps, rig.state, rig.log)
          expect(stage.kind).toBe('failed')
          return stage
        },
        tags: [],
        lists: false,
        prunes: 0,
        failures: 0,
      },
      {
        name: 'a refusal after the build: a read-back difference',
        drive: async (rig) => {
          const read = await buildAndReadBack(rig, 'differing')
          expect(read.ok).toBe(false)
          return read
        },
        tags: ['test'],
        lists: true,
        prunes: 0,
        failures: 0,
      },
      {
        name: 'a refusal after the build: a read-back failure',
        drive: async (rig) => {
          const read = await buildAndReadBack(rig, 'none')
          expect(read.ok).toBe(false)
          if (!read.ok) expect(imageRunner.refusalLine(read.refusal).startsWith(NOT_RUN_PREFIX)).toBe(true)
          return read
        },
        tags: ['test'],
        lists: true,
        prunes: 0,
        failures: 0,
      },
      {
        name: 'a stop before the test build',
        drive: async (rig) => {
          rig.recordStop()
          const report = await buildTestImage(rig.imagesContext, rig.state)
          expect(report.outcome).toEqual({ kind: 'not-built' })
          return report
        },
        tags: [],
        lists: false,
        prunes: 0,
        failures: 0,
      },
      {
        name: 'a stop during the test build',
        drive: async (rig) => {
          rig.docker.programBuild({ kind: 'hangs' }, { role: 'test' })
          const report = await stopDuringBuild(rig, () => buildTestImage(rig.imagesContext, rig.state))
          expect(report.outcome).toEqual({ kind: 'stopped' })
          return report
        },
        tags: ['test'],
        lists: true,
        prunes: 0,
        failures: 0,
      },
      {
        name: 'a stop during the drift build',
        drive: async (rig) => {
          await passingRun(rig)
          rig.docker.programBuild({ kind: 'hangs' }, { role: 'drift' })
          const faults = await stopDuringBuild(rig, () => buildFaultImages(rig.imagesContext, rig.state, [DRIFT, RETAG]))
          expect(faults).toEqual({ drift: { kind: 'stopped' }, retag: { kind: 'not-built' } })
          return faults
        },
        tags: ['drift', 'test'],
        lists: true,
        prunes: 0,
        failures: 0,
      },
      {
        name: 'a stop during cleanup, while a prune waits to retry',
        drive: (rig) => retagRun(rig),
        beforeCleanup: (rig) => {
          otherRunPrune(PRUNE_BUSY_FOR_TWO_TRIES_MS)(rig)
          rig.clock.setTimeout(() => rig.recordStop(), PRUNE_RETRY_INTERVAL_MS / 2)
        },
        tags: ['retag', 'test'],
        lists: true,
        prunes: 3,
        failures: 0,
      },
      {
        name: 'failed tag removals',
        drive: (rig) => retagRun(rig),
        beforeCleanup: (rig) => rig.docker.fail('image-remove', { times: 'always', stderr: 'Error response from daemon: fake removal failure' }),
        tags: ['retag', 'test'],
        lists: true,
        prunes: 1,
        failures: 2,
      },
      {
        name: 'a failed listing',
        drive: (rig) => retagRun(rig),
        beforeCleanup: (rig) => rig.docker.fail('image-list'),
        tags: ['retag', 'test'],
        lists: true,
        prunes: 0,
        failures: 1,
      },
      {
        name: 'a prune refused as already running on some tries',
        drive: (rig) => retagRun(rig),
        beforeCleanup: otherRunPrune(PRUNE_BUSY_FOR_TWO_TRIES_MS),
        tags: ['retag', 'test'],
        lists: true,
        prunes: 3,
        failures: 0,
      },
      {
        name: 'a prune refused as already running on every try',
        drive: (rig) => retagRun(rig),
        beforeCleanup: otherRunPrune(PRUNE_BUSY_FOR_EVERY_TRY_MS),
        tags: ['retag', 'test'],
        lists: true,
        prunes: PRUNE_RETRIES + 1,
        failures: 1,
      },
    ]

    /** A path by its name. */
    function removalPath(name: string): RemovalPath {
      const path = REMOVAL_PATHS.find((candidate) => candidate.name === name)
      if (path === undefined) throw new Error(`no removal path named ${name}`)
      return path
    }

    /** What one path's cleanup did. */
    interface CleanedPath {
      readonly rig: ImageRig
      readonly outcome: unknown
      readonly report: RunImageCleanupReport
      /** The runner's docker operations cleanup made. */
      readonly cleanupOps: readonly FakeDockerOperation[]
    }

    /**
     * Runs a path, then cleanup, on the fake clock. Checks that cleanup left
     * what the run hands its verdict or refusal, and the image-state record,
     * unchanged; that its runner-log lines are exactly its failure lines, each
     * also in `state.cleanupFailures`; and that no output leaks a secret.
     */
    async function cleanPath(path: RemovalPath, rig: ImageRig = makeE8Rig()): Promise<CleanedPath> {
      const outcome = await onClock(rig, path.drive(rig))
      const handedOn = structuredClone(outcome)
      const images = structuredClone(rig.state.images)
      path.beforeCleanup?.(rig)
      const opsMark = rig.docker.operations().length
      const logMark = rig.logLines.length
      const report = await onClock(rig, cleanupRunImages(rig.imagesContext, rig.state))
      const cleanupOps = rig.docker.operations().slice(opsMark).filter((op) => op.source === 'runner')

      expect(outcome).toEqual(handedOn)
      expect(rig.state.images).toEqual(images)
      expect(rig.state.cleanupFailures).toEqual([...report.failures])
      expect(rig.logLines.slice(logMark)).toEqual([...report.failures])
      for (const line of report.failures) expect(line.startsWith(FAIL_PREFIX) || line.startsWith(NOT_RUN_PREFIX)).toBe(false)
      imageAssertNoLeak({ outcome, report, logLines: rig.logLines, cleanupFailures: rig.state.cleanupFailures, images: rig.state.images, argvs: rig.recorder.argvs() })
      return { rig, outcome, report, cleanupOps }
    }

    /** The image IDs a listing printed. */
    async function listedIds(result: Promise<imageRunner.SpawnResult>): Promise<{ readonly exitCode: number; readonly ids: readonly string[] }> {
      const done = await result
      return { exitCode: done.exitCode, ids: new TextDecoder().decode(done.stdout).split('\n').filter((line) => line !== '') }
    }

    /**
     * The removal-path rules over every docker command the run spawned, read
     * from the spawn recorder and the fake's operation log:
     * - every image removal is `docker image rm <tag>` naming one of the run's
     *   own run-private tags (no ID, no digest, no force);
     * - every prune is the prune form on exactly the run's owner label, after a
     *   listing of untagged images with exactly that label that found one;
     * - no other command removes an image: Docker's own removal words are
     *   checked on every docker argument list the recorder holds, started or
     *   not, so a new removal form fails here.
     */
    async function assertRemovalRules(rig: ImageRig): Promise<void> {
      const ownTags = RUN_TAG_ROLES.map(tagOf)
      // Docker's CLI words for removing images, whatever form the runner might build.
      const removesImages = (argv: readonly string[]): boolean => {
        const [, command, sub] = argv
        return command === 'rmi' || (command === 'image' && ['rm', 'remove', 'prune'].includes(sub ?? '')) || (['system', 'builder'].includes(command ?? '') && sub === 'prune')
      }
      // A force flag in any form: `-f`, a short-flag cluster holding f, `--force` or `--force=<value>`.
      const isForceFlag = (arg: string): boolean => /^(?:-[A-Za-z]*f[A-Za-z]*|--force(?:=.*)?)$/.test(arg)
      for (const argv of rig.recorder.argvs().filter((a) => a[0] === DOCKER_PROGRAM && removesImages(a))) {
        if (argv[2] === 'prune') {
          // The prune form's `--force` only skips Docker's prompt; it is pinned whole, with no `--all`.
          expect([...argv]).toEqual(imagePruneArgs(OWNER_VALUE))
          for (const all of ['--all', '-a']) expect(argv).not.toContain(all)
          continue
        }
        expect(argv.filter(isForceFlag)).toEqual([])
        expect(ownTags.some((tag) => sameArgv(argv, imageTagRemovalArgs(tag)))).toBe(true)
      }
      const started = rig.recorder.spawns().filter((spawn) => spawn.argv[0] === DOCKER_PROGRAM && spawn.pid !== null)
      const ops = rig.docker.operations().filter((op) => op.source === 'runner')
      expect(ops.map((op) => op.argv)).toEqual(started.map((spawn) => spawn.argv))
      for (const [at, op] of ops.entries()) {
        if (!removesImages(op.argv)) {
          expect(['image-remove', 'image-prune']).not.toContain(op.kind)
          continue
        }
        if (op.kind === 'image-remove') {
          expect(op.removalBy).toBe('tag')
          expect(ownTags).toContain(op.refs[0])
          expect(op.argv).toEqual(imageTagRemovalArgs(op.refs[0]!))
          continue
        }
        expect(op.kind).toBe('image-prune')
        expect(op.argv).toEqual(imagePruneArgs(OWNER_VALUE))
        const listingAt = ops.slice(0, at).reduce((last, earlier, i) => (earlier.kind === 'image-list' ? i : last), -1)
        expect(listingAt).toBeGreaterThanOrEqual(0)
        expect(ops[listingAt]!.argv).toEqual(OWN_UNTAGGED_LISTING)
        const listed = await listedIds(started[listingAt]!.result)
        expect(listed.exitCode).toBe(0)
        expect(listed.ids.length).toBeGreaterThan(0)
      }
    }

    test.each(REMOVAL_PATHS.map((path) => [path.name, path] as const))(
      'the removal-path test, %s: every image removal is a run-private tag by name, or an owner-filtered prune after a listing that found one',
      async (_name, path) => {
        const { rig, report, cleanupOps } = await cleanPath(path)
        await assertRemovalRules(rig)
        expect(cleanupOps.filter((op) => op.kind === 'image-remove').map((op) => op.refs[0])).toEqual(path.tags.map(tagOf))
        expect(cleanupOps.filter((op) => op.kind === 'image-list')).toHaveLength(path.lists ? 1 : 0)
        expect(cleanupOps.filter((op) => op.kind === 'image-prune')).toHaveLength(path.prunes)
        expect(report.untagged === null).toBe(!path.lists)
        expect(report.failures).toHaveLength(path.failures)
        if (!path.lists) expect(cleanupOps).toEqual([])
      },
    )

    test('the paths that spawn no test, drift or retag build (a refusal before the build, a failed base build, a stop before it, a build not spawned) make no tag removal, no listing and no prune at any point', async () => {
      for (const name of ['a refusal before the build (step 4)', 'a failed base build', 'a stop before the test build', 'a test build that could not be spawned']) {
        const { rig, report } = await cleanPath(removalPath(name))
        expect(report).toEqual({ tags: [], untagged: null, failures: [] })
        expect(rig.docker.operations().filter((op) => ['image-remove', 'image-list', 'image-prune'].includes(op.kind))).toEqual([])
      }
      expect(runImageCleanupPlan(initialImageState())).toEqual({ tagRoles: [], listUntagged: false })
    })

    test('the tags are removed -drift, -retag, -test, each once by its name; then the pinned image left untagged is pruned and none of the run\'s images remains', async () => {
      expect(CLEANUP_TAG_ORDER).toEqual(['drift', 'retag', 'test'])
      const { rig, report, cleanupOps } = await cleanPath({
        name: 'drift and retag, the move done',
        drive: async (rig) => {
          await passingRun(rig)
          const faults = await buildFaultImages(rig.imagesContext, rig.state, [DRIFT, RETAG])
          expect([faults.drift.kind, faults.retag.kind]).toEqual(['built', 'built'])
          expect(await moveTestTagToRetagImage(rig.imagesContext, rig.state)).toEqual({ kind: 'moved' })
          return faults
        },
        tags: ['drift', 'retag', 'test'],
        lists: true,
        prunes: 1,
        failures: 0,
      })
      await assertRemovalRules(rig)
      const tags = [tagOf('drift'), tagOf('retag'), tagOf('test')]
      expect(cleanupOps.filter((op) => op.kind === 'image-remove').map((op) => op.argv)).toEqual(tags.map((tag) => imageTagRemovalArgs(tag)))
      expect(report.tags).toEqual((['drift', 'retag', 'test'] as const).map((role) => ({ role, removal: { kind: 'removed' as const } })))
      expect(report.untagged).toEqual({ kind: 'pruned', tries: 1 })
      const prune = cleanupOps.find((op) => op.kind === 'image-prune')
      expect(prune?.deleted).toEqual([PINNED_ID])
      expect(rig.docker.images()).toEqual([])
    })

    test('the listing is of untagged images with exactly the run\'s owner label: another run\'s and an unlabelled untagged image are neither listed nor pruned', async () => {
      const rig = makeE8Rig()
      const others = [
        rig.docker.addImage({ labels: { [OWNER_LABEL]: formatOwner(OTHER_OWNER) } }),
        rig.docker.addImage({ labels: { [OWNER_LABEL]: `${OWNER_VALUE}0` } }),
        rig.docker.addImage(),
      ]
      const { cleanupOps } = await cleanPath(removalPath('retag with the tag move done'), rig)
      await assertRemovalRules(rig)
      const listings = cleanupOps.filter((op) => op.kind === 'image-list')
      expect(listings.map((op) => op.argv)).toEqual([OWN_UNTAGGED_LISTING])
      const listingSpawn = rig.recorder.spawns().filter((spawn) => sameArgv(spawn.argv, OWN_UNTAGGED_LISTING))
      expect(listingSpawn).toHaveLength(1)
      expect((await listedIds(listingSpawn[0]!.result)).ids).toEqual([PINNED_ID])
      expect(cleanupOps.filter((op) => op.kind === 'image-prune').map((op) => op.deleted)).toEqual([[PINNED_ID]])
      for (const id of others) expect(rig.docker.image(id)).not.toBeNull()
    })

    test('a listing that finds no untagged image of the run is followed by no prune', async () => {
      const { rig, report, cleanupOps } = await cleanPath(removalPath('a pass'))
      expect(cleanupOps.map((op) => op.kind)).toEqual(['image-remove', 'image-list'])
      expect(report).toEqual({ tags: [{ role: 'test', removal: { kind: 'removed' } }], untagged: { kind: 'none-found' }, failures: [] })
      expect(rig.docker.image(PINNED_ID)).toBeNull()
    })

    test('a prune that leaves the run\'s untagged image because a container still uses it is no cleanup failure', async () => {
      const path = removalPath('retag with the tag move done')
      const rig = makeE8Rig()
      const { report, cleanupOps } = await cleanPath(
        {
          ...path,
          drive: async (r) => {
            const handed = await path.drive(r)
            r.docker.addContainer({ name: 'e8-not-a-run-container', image: PINNED_ID, running: false })
            return handed
          },
        },
        rig,
      )
      const prunes = cleanupOps.filter((op) => op.kind === 'image-prune')
      expect(prunes.map((op) => [op.exitCode, op.deleted])).toEqual([[0, []]])
      expect(report.untagged).toEqual({ kind: 'pruned', tries: 1 })
      expect(report.failures).toEqual([])
      expect(rig.docker.image(PINNED_ID)?.tags).toEqual([])
    })

    test('a failed tag removal is logged and listed as a cleanup failure, and cleanup goes on to the next tag, the listing and the prune', async () => {
      const failing = tagOf('retag')
      const stderr = 'Error response from daemon: fake removal failure of the retag tag'
      const { rig, report, cleanupOps } = await cleanPath({
        ...removalPath('retag with the tag move done'),
        beforeCleanup: (r) => r.docker.fail('image-remove', { stderr, when: (argv) => argv.includes(failing) }),
      })
      await assertRemovalRules(rig)
      expect(cleanupOps.map((op) => [op.kind, op.exitCode])).toEqual([
        ['image-remove', 1],
        ['image-remove', 0],
        ['image-list', 0],
        ['image-inspect', 0],
        ['image-prune', 0],
      ])
      expect(report.tags.map((tag) => tag.removal.kind)).toEqual(['failed', 'removed'])
      expect(report.failures).toHaveLength(1)
      expect(report.failures[0]).toContain(failing)
      expect(report.failures[0]).toContain(stderr)
      expect(rig.docker.image(failing)).not.toBeNull()
    })

    test('a removal Docker answers "No such image" for (a tag a stopped build never made) is no failure', async () => {
      const { report } = await cleanPath(removalPath('a stop during the test build'))
      expect(report).toEqual({ tags: [{ role: 'test', removal: { kind: 'absent' } }], untagged: { kind: 'none-found' }, failures: [] })
    })

    test.each([
      ['drift', 'a drift build failed by its after-check'],
      ['retag', 'a retag build failed by its after-check'],
    ] as const)('a %s build that exited 0 but failed its after-check still has its tag removed by name, before -test, and its image is gone', async (role, pathName) => {
      const { rig, report, cleanupOps } = await cleanPath(removalPath(pathName))
      expect(rig.state.images.builds[role]).toEqual({ kind: 'failed', exitCode: imageRunner.FAILURE_EXIT_STATUS })
      expect(cleanupOps.filter((op) => op.kind === 'image-remove').map((op) => op.argv)).toEqual([imageTagRemovalArgs(tagOf(role)), imageTagRemovalArgs(tagOf('test'))])
      expect(report.tags).toEqual([
        { role, removal: { kind: 'removed' } },
        { role: 'test', removal: { kind: 'removed' } },
      ])
      expect(report.failures).toEqual([])
      expect(rig.docker.image(tagOf(role))).toBeNull()
      expect(rig.docker.images().filter((image) => image.labels[OWNER_LABEL] === OWNER_VALUE)).toEqual([])
    })

    test.each([
      ['refused on the first two tries', PRUNE_BUSY_FOR_TWO_TRIES_MS, 3, false],
      ['refused on every try', PRUNE_BUSY_FOR_EVERY_TRY_MS, PRUNE_RETRIES + 1, true],
    ] as const)('a prune %s is tried again PRUNE_RETRY_INTERVAL_MS apart on the fake clock, at most PRUNE_RETRIES times, and fails only when every try was refused', async (_what, busyMs, tries, fails) => {
      expect(PRUNE_RETRIES).toBeGreaterThanOrEqual(2)
      const { rig, report, cleanupOps } = await cleanPath({ ...removalPath('retag with the tag move done'), beforeCleanup: otherRunPrune(busyMs) })
      const prunes = cleanupOps.filter((op) => op.kind === 'image-prune')
      expect(prunes).toHaveLength(tries)
      expect(prunes.length).toBeLessThanOrEqual(PRUNE_RETRIES + 1)
      expect(prunes.slice(1).map((op, i) => op.atMs - prunes[i]!.atMs)).toEqual(Array.from({ length: tries - 1 }, () => PRUNE_RETRY_INTERVAL_MS))
      expect(prunes.slice(0, -1).every((op) => op.exitCode === 1)).toBe(true)
      expect(prunes.at(-1)!.exitCode).toBe(fails ? 1 : 0)
      if (fails) {
        expect(report.untagged?.kind).toBe('failed')
        expect(report.failures).toHaveLength(1)
        expect(report.failures[0]).toContain(PRUNE_ALREADY_RUNNING_TEXT)
        expect(report.failures[0]).toContain(OWNER_VALUE)
        expect(rig.docker.image(PINNED_ID)).not.toBeNull()
      } else {
        expect(report).toEqual({
          tags: [
            { role: 'retag', removal: { kind: 'removed' } },
            { role: 'test', removal: { kind: 'removed' } },
          ],
          untagged: { kind: 'pruned', tries },
          failures: [],
        })
        expect(rig.docker.image(PINNED_ID)).toBeNull()
      }
    })

    test('a stop recorded during cleanup changes none of its commands: they match the same path without the stop, each tag removed at most once', async () => {
      const stopped = await cleanPath(removalPath('a stop during cleanup, while a prune waits to retry'))
      const unstopped = await cleanPath(removalPath('a prune refused as already running on some tries'))
      expect(stopped.rig.state.firstStop).not.toBeNull()
      expect(unstopped.rig.state.firstStop).toBeNull()
      const commands = (cleaned: CleanedPath): unknown[] => cleaned.cleanupOps.map((op) => [op.argv, op.atMs - cleaned.cleanupOps[0]!.atMs, op.exitCode])
      expect(commands(stopped)).toEqual(commands(unstopped))
      expect(stopped.report).toEqual(unstopped.report)
      const removed = stopped.cleanupOps.filter((op) => op.kind === 'image-remove').map((op) => op.refs[0])
      expect(new Set(removed).size).toBe(removed.length)
      await assertRemovalRules(stopped.rig)
    })

    /** Test data: foreign tags on the pinned ID, which cleanup must leave: a lane tag, and another run's `-test` tag. */
    const FOREIGN_TAGS = [
      ['a lane tag', LANE_TAG],
      ['another run\'s -test tag', formatRunTag(OTHER_OWNER, 'test')],
    ] as const

    test.each(FOREIGN_TAGS.flatMap(([what, tag]) => [
      [what, tag, 'a pass'],
      [what, tag, 'retag with the tag move done'],
    ] as const))('%s (%s) on the pinned ID survives cleanup of %s, with the image', async (_what, foreignTag, pathName) => {
      const path = removalPath(pathName)
      const drive = pathName === 'a pass' ? (r: ImageRig) => passingRun(r, [foreignTag]) : (r: ImageRig) => retagRun(r, false, [foreignTag])
      const { rig, cleanupOps } = await cleanPath({ ...path, drive })
      await assertRemovalRules(rig)
      expect(cleanupOps.some((op) => op.refs.includes(foreignTag))).toBe(false)
      expect(cleanupOps.filter((op) => op.kind === 'image-prune')).toEqual([])
      const image = rig.docker.image(foreignTag)
      expect(image?.id).toBe(PINNED_ID)
      expect(image?.tags).toEqual([foreignTag])
    })
  })
})

// ===========================================================================
// shard containers; adds its cases here
// ===========================================================================
//
// what a shard's one final reading records, and
// the order of the docker operations that retire it, for every way a shard
// ends. Each shard is started through section 13's start entry point
// (`startShard`) over the fake container interface, its cgroup written by
// cgroup builder and found through its main process in the process table; it
// is then read and retired through the run's retirer (`createShardRetirer`).
// The order is proved from the fake's operation log alone, and each cgroup
// read is placed in it by the number of operations made before it. Run-level
// stops are driven as retirement reasons only (performing a stop is ).
// The start's own argument list, credentials, inspection capture and refusals
// are , in tests/ci-run-results.test.ts. The region's imports are
// namespaces and its helpers live inside its describe, so no name can collide
// with another region's.

import * as e9 from '../scripts/ci-run.ts'
import * as shardHelpers from './test-helpers/ci-run.ts'
import * as shardCredentials from './test-helpers/credentials.ts'
import * as shardClock from './test-helpers/fake-clock.ts'

describe('shard management: the final reading and shard retirement ()', () => {
  /** Test data: a RUN_ID of the contract form, and the runner's PID. */
  const RUN_ID = '20261008t120000z-e9retire'
  const OWNER: e9.Owner = { runId: RUN_ID, pid: 5150 }
  /** The fake clock's start. */
  const START_MS = Date.UTC(2026, 9, 8, 12, 0, 0)
  /** How long after its start a shard is read or retired, on the fake clock. */
  const READ_AFTER_MS = 90_000
  /** The run's secret credential: a sentinel-bearing fake, in the runner's environment and secret set only. */
  const API_KEY = shardCredentials.fakeToken(e9.RAW_KEY_PREFIX, 'e9-anthropic-key')
  /** The one signal retirement may send. */
  const SIGKILL: e9.SentSignal = 'SIGKILL'

  // --- .S1: the local retirement fixture (shared .S1 and .S2) ---

  /** Shard k's cgroup files: distinct per shard, and every figure the reading takes non-zero. */
  function figuresOf(shard: number): shardHelpers.ContainerCgroupBytes {
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
    const fileName = shardHelpers.realScriptFileName(1)
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
    readonly container?: Partial<shardHelpers.FakeContainerSpec>
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
    readonly figures: shardHelpers.ContainerCgroupBytes
    /** Its Docker logs as `docker.log` should hold them. */
    readonly dockerLog: string
    readonly shardDir: string
    readonly dockerLogPath: string
  }

  interface RetirementRig {
    readonly clock: shardClock.FakeClock
    readonly recorder: shardHelpers.SpawnRecorder
    readonly docker: shardHelpers.FakeDocker
    readonly tree: shardHelpers.CgroupTree
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
    writeResult(started: StartedShard, spec: shardHelpers.ResultFileSpec): void
  }

  let roots: string[] = []
  let recorders: shardHelpers.SpawnRecorder[] = []
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
        shardCredentials.assertNoLeak(
          {
            lines: rig.lines,
            cleanupFailures: rig.state.cleanupFailures,
            readings: shards.map((shard) => rig.retirer.recordedReading(shard)),
            retirements: shards.map((shard) => rig.retirer.recordedRetirement(shard)),
            runDir: shardCredentials.writtenFile(rig.runDir),
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
    const clock = shardClock.createFakeClock({ start: START_MS })
    const recorder = shardHelpers.createSpawnRecorder({ clock, root })
    recorders.push(recorder)
    const docker = shardHelpers.createFakeDocker(recorder)
    const tree = shardHelpers.createCgroupTree(root)
    const imageId = docker.addImage()
    const runDir = shardHelpers.makeRunDir(root, RUN_ID)
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
    const runAnswers = new Map<string, shardHelpers.FakeRunAnswer>()
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
      const unreadable: shardHelpers.ProcEntry[] = options.membershipUnreadable === true ? ['cgroup'] : []
      const process = { cgroup: shardHelpers.cgroupMembershipLine(cgroupPath), unreadable }
      runAnswers.set(name, run === 'start' ? { kind: 'start', container: { process, logs, ...options.container } } : { kind: 'fail', leavesContainer: run === 'fail-created' })
      if (run === 'start') tree.writeContainer(cgroupPath, figures)
      const result = await e9.startShard(
        { spawn: recorder.spawn, env, worktreeRoot: root, clock },
        {
          owner: OWNER,
          runDir,
          assignment: { shard, assigned: [shardHelpers.realScriptFileName(1)] },
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
        writeFileSync(join(started.shardDir, e9.RESULT_FILE_NAME), shardHelpers.resultFileText(spec))
      },
    }
    rigs.push(rig)
    return rig
  }

  /** A docker operation as an order assertion compares it. */
  interface OperationSummary {
    readonly kind: shardHelpers.FakeDockerOperationKind
    readonly refs: readonly string[]
    readonly signal: e9.SentSignal | null
  }

  function summaryOf(ops: readonly shardHelpers.FakeDockerOperation[]): OperationSummary[] {
    return ops.map((op) => ({ kind: op.kind, refs: op.refs, signal: op.signal }))
  }

  /** order on `ref`: its state read (the final reading), SIGKILL only when `killed`, its logs, its removal. */
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
  // .S1: what one final reading records
  // -------------------------------------------------------------------------

  describe('the final reading', () => {
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

    const STAT = shardHelpers.CGROUP_FILE.stat
    const EVENTS = shardHelpers.CGROUP_FILE.events
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
    ] satisfies [string, shardHelpers.CgroupFileName, shardHelpers.CgroupFileChange, Part[], number][])('%s: only the parts it holds are unreadable, the others keep their values', async (_what, fileName, change, parts, failures) => {
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
  // .S2: the retirement order for every way a shard ends
  // -------------------------------------------------------------------------

  describe('the retirement order', () => {
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
    ] satisfies [string, shardHelpers.ResultFileSpec, e9.RetirementReason][])('a limit retirement of a shard whose result file holds %s', async (_what, resultFile, effective) => {
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
// the run sequence end to end, stops and the end of run; adds its cases here
// ===========================================================================
//
// (to second half,
// interrupt half runner half): the composition itself. Every
// case runs the runner's `main` in process to its end over one constructed
// host (`lifecycleHost`): a `mkdtempSync` root removed in `afterEach` holding the
// system temp directory, the account home with its lock directory (
// builder; `RunnerDeps.lockDir` points at it) and the password file; one fake
// clock, spawn recorder, process table, fake container interface, signal
// recorder, cgroup tree and volume ( readings builder). A run on it
// (`host.run`) has its own worktree of real script names, its own signal
// source and a container plan per shard: what it writes into its
// subdirectory, and when, through the runner's own formatters. Time moves
// only on the fake clock (`lifecycleSettle`). The components' own rules are ;
// these cases assert only order, phases, what the composition records and what
// it leaves. The region's imports are namespaces or `e13`-prefixed aliases.

import { createHash as lifecycleCreateHash } from 'node:crypto'
import * as lifecycleFs from 'node:fs'
import { tmpdir as lifecycleTmpdir } from 'node:os'
import * as lifecyclePath from 'node:path'
import * as e13 from '../scripts/ci-run.ts'
import * as lifecycleHelper from './test-helpers/ci-run.ts'
import * as lifecycleCredentials from './test-helpers/credentials.ts'
import * as lifecycleClock from './test-helpers/fake-clock.ts'
import { treeSnapshot as lifecycleTreeSnapshot } from './test-helpers/tree-snapshot.ts'

describe('the run lifecycle: the composed run (to)', () => {
  type ResultEvent = e13.ResultEvent
  type Results = e13.Results
  type RunStatus = e13.RunStatus

  /** Test data: two RUN_IDs of the contract form and their runners' PIDs. */
  const RUN_ID = '20261008t140000z-e13run01'
  const RUN_PID = 6161
  const OTHER_RUN_ID = '20261008t140000z-e13run02'
  const OTHER_PID = 6262
  /** Test data: the fake clock's start, the runner's start. */
  const START_MS = Date.UTC(2026, 9, 8, 14, 0, 0)
  /** Test data: the runner's user ID. */
  const UID = 1000
  const MS_PER_MINUTE = 60_000
  /** The run's secret values, each a `fakeToken` with its own suffix. */
  const SECRETS = {
    key: lifecycleCredentials.fakeToken(e13.RAW_KEY_PREFIX, 'e13-key'),
    ghToken: lifecycleCredentials.fakeToken('', 'e13-gh'),
    baseBuildToken: lifecycleCredentials.fakeToken('', 'e13-base'),
  } as const
  /** Test data: how long `npm pack`, the test build and a shard's container take on the fake clock. */
  const PACK_MS = 7_000
  const BUILD_MS = 20_000
  const SHARD_RUN_MS = 45_000
  /** Test data: the tarball `npm pack` writes. */
  const TARBALL_NAME = `e13-package-1.0.0${e13.PACKAGE_TARBALL_SUFFIX}`
  const TARBALL_BYTES = Uint8Array.from({ length: 512 }, (_, i) => (i * 13) % 256)
  const TARBALL_SHA256 = lifecycleCreateHash('sha256').update(TARBALL_BYTES).digest('hex')
  /** Test data: each shard's dependency fingerprint, the same in every shard. */
  const FINGERPRINT = lifecycleHelper.hexValue('e13-fingerprint', e13.SHA256_HEX_LENGTH)
  /** Test data: a script's seconds in a result line. */
  const SCRIPT_SECONDS = 12.5
  /** The default worktree: the repository's scripts 1 to 7 by their real names, each estimated at 60 s, so each shard's limit is the floor. */
  const SCRIPT_NUMBERS = [1, 2, 3, 4, 5, 6, 7]
  const LIFECYCLE_MAX_STEPS = 20_000

  // --- .S1: the composed-run factory ---

  /** One thing that happened on the host, in order: a spawn (a docker operation's kind, or any other program) or a dependency read. */
  interface LifecycleEvent {
    readonly runId: string
    readonly atMs: number
    readonly what: string
    readonly argv: readonly string[] | null
    /** Whether the admission lock's flock was held as it happened. */
    readonly lockHeld: boolean
    /** The reservation files in the lock directory as it happened. */
    readonly reservations: readonly string[]
    /** The lock file's holder record as it happened; null when there is no lock file. */
    readonly lockRecord: string | null
    /** The CPUs every reservation in the lock directory holds together, as it happened. */
    readonly reservedCpus: number
    /** The spawning run's status phase as it happened; null before its status file exists. */
    readonly phase: e13.StatusPhase | null
  }

  /** A timer the runner armed through its clock. */
  interface LifecycleRunnerTimer {
    readonly handle: unknown
    readonly delayMs: number
    readonly atMs: number
  }

  /** Dependency failures a case switches on while a run goes. */
  interface LifecycleFaults {
    /** `clock.setTimeout` throws for a delay this accepts. */
    setTimeout: ((delayMs: number) => boolean) | null
    /** `clock.clearTimeout` throws for a timer this accepts. */
    clearTimeout: ((timer: LifecycleRunnerTimer) => boolean) | null
    /** `clock.now` throws this many more times. */
    nowThrows: number
  }

  /** What a shard's container does, from its start. */
  interface LifecycleShardPlan {
    /** Result-file events written at its start (a script in progress). */
    readonly inProgress?: (assigned: readonly string[]) => readonly ResultEvent[]
    /** Alter only inspected performance-guard evidence for integrity controls. */
    readonly performanceMount?: 'missing' | 'writable' | 'foreign'
    /** When it writes its finished result file and evidence and exits; null: it never ends on its own. Default `SHARD_RUN_MS`. */
    readonly endsAfterMs?: number | null
    /** Its finished result file's events; default a pass for each assigned script, then the end marker. */
    readonly finished?: (assigned: readonly string[]) => readonly ResultEvent[]
    /** A script log's text; default one line naming it. */
    readonly scriptLog?: (fileName: string) => string
    /** Its `docker run` fails, leaving its container created, as Docker does. */
    readonly failsToStart?: boolean
  }

  interface LifecycleRunOptions {
    readonly runId?: string
    readonly pid?: number
    readonly args?: readonly string[]
    /** Default: scripts `SCRIPT_NUMBERS`, each estimated at 60 s. */
    readonly worktree?: lifecycleHelper.WorktreeOptions
    /** Step 4 finds the base image missing; its prerequisites pass and the base-build step answers `baseBuildStep`. */
    readonly baseMissing?: boolean
    readonly baseBuildStep?: lifecycleHelper.SpawnAnswer
    /** Replaces `npm pack`'s answer (default: writes the tarball after `PACK_MS`). */
    readonly npmPack?: lifecycleHelper.SpawnAnswer
    /** The test build's program (default: built after `buildMs`, its ID the pinned image's). */
    readonly testBuild?: lifecycleHelper.FakeBuildProgram
    /** How long the default test build takes; default `BUILD_MS`. */
    readonly buildMs?: number
    readonly shard?: (k: number) => LifecycleShardPlan
    /** The password file's text; default the first-match case for the host's home. */
    readonly passwordText?: string
    /** Over the default environment; a variable set to undefined is left out. */
    readonly env?: Readonly<Record<string, string | undefined>>
    /** The pinned image's `/tests` archive; default the worktree's. */
    readonly pinnedArchive?: (worktree: lifecycleHelper.BuiltWorktree) => Uint8Array
    /** How long a shard's `docker run` takes to answer, by its assigned scripts; default 0. */
    readonly dockerRunDelayMs?: (assigned: readonly string[]) => number
    /** Dependencies over the defaults. */
    readonly deps?: Partial<Pick<e13.RunnerDeps, 'readVolume' | 'readPasswordFile' | 'codexLogin'>>
    /** Called after each event of this run is recorded. */
    readonly onEvent?: (event: LifecycleEvent, run: LifecycleRun) => void
  }

  /** One run on the host. */
  interface LifecycleRun {
    readonly runId: string
    readonly pid: number
    readonly owner: e13.Owner
    readonly runDir: string
    readonly worktree: lifecycleHelper.BuiltWorktree
    readonly deps: e13.RunnerDeps
    readonly source: lifecycleHelper.SignalSource
    readonly stderr: string[]
    readonly tarballPath: string
    /** Every distinct `status.json` text seen, in order (read at each spawn, dependency read and clock step). */
    readonly statuses: string[]
    /** Each shard's container start on the clock, by k. */
    readonly shardStarts: Map<number, number>
    /** Each shard's assigned scripts as its `docker run` gave them, by k. */
    readonly assigned: Map<number, readonly string[]>
    /** Every timer the runner armed through its clock, in order. */
    readonly timers: LifecycleRunnerTimer[]
    readonly faults: LifecycleFaults
    /** The runner's timers still pending on the clock. */
    pendingRunnerTimers(): LifecycleRunnerTimer[]
    /** Runs `main` for this run. */
    main(options?: e13.MainOptions): Promise<number>
    /**
     * Runs the run as `main` does (step 1, the traps, then `runSequence` with
     * `createRunStopHooks()` and the hooks removed on every way out), with
     * `extra`'s hooks called after the stop hooks' own (before them at the
     * sequence's end), so a case can act as an end-of-run step begins. Main
     * itself takes no hooks; every other case runs `main`.
     */
    sequence(extra: e13.RunSequenceHooks): Promise<number>
    /** Reads `status.json` and keeps it when it changed. */
    observe(): void
    /** `results.json`, parsed by the runner's parser; null when absent. */
    results(): Results | null
    verdict(): string | null
    logLines(): string[]
    status(): RunStatus | null
  }

  interface LifecycleHost {
    readonly root: string
    readonly tempDir: string
    readonly home: string
    readonly lockDir: string
    readonly lockPath: string
    readonly adSourceDir: string
    readonly clock: lifecycleClock.FakeClock
    readonly recorder: lifecycleHelper.SpawnRecorder
    readonly docker: lifecycleHelper.FakeDocker
    readonly signals: lifecycleHelper.SignalRecorder
    readonly readings: lifecycleHelper.BuiltAdmissionReadings
    readonly lockBuild: lifecycleHelper.BuiltLockDir
    readonly timeline: LifecycleEvent[]
    run(options?: LifecycleRunOptions): LifecycleRun
  }

  interface LifecycleHostOptions {
    readonly lockDir?: Omit<lifecycleHelper.LockDirSpec, 'processes'>
    readonly pod?: lifecycleHelper.PodFigures
    readonly volume?: lifecycleHelper.VolumeFigures | { readonly error: string }
  }

  let lifecycleRoots: string[] = []
  let lifecycleHosts: LifecycleHost[] = []

  afterEach(() => {
    const hosts = lifecycleHosts
    lifecycleHosts = []
    try {
      for (const host of hosts) host.lockBuild.release()
      for (const host of hosts) host.recorder.assertNoFailures()
    } finally {
      for (const root of lifecycleRoots) lifecycleFs.rmSync(root, { recursive: true, force: true })
      lifecycleRoots = []
    }
  })

  /** The pod by default: L 64 GiB, W 6 GiB; room for six shards. */
  const DEFAULT_POD: lifecycleHelper.PodFigures = { limitGib: 64, workingSetGib: 6, anonGib: 3, activeFileGib: 2 }

  function lifecycleDurationTable(numbers: readonly number[]): lifecycleHelper.DurationTableSpec {
    return { kind: 'rows', header: e13.DURATION_TABLE_HEADER, rows: numbers.map((n) => ({ script: n, seconds: 60 })) }
  }

  /** What an image built from `worktree` holds under `/tests`, as archive entries; without the script `omit` when given. */
  function lifecycleTestsArchive(worktree: lifecycleHelper.BuiltWorktree, omit: string | null = null): Uint8Array {
    const testsEntry = e13.IMAGE_TESTS_DIR.slice(1)
    const entries: Record<string, string | Uint8Array> = { [`${testsEntry}/`]: '', [`${e13.INTEGRATION_DIR_PATH}/`]: '' }
    for (const fileName of lifecycleFs.readdirSync(worktree.integrationDir).sort()) {
      if (fileName === omit) continue
      entries[`${e13.INTEGRATION_DIR_PATH}/${fileName}`] = lifecycleFs.readFileSync(lifecyclePath.join(worktree.integrationDir, fileName))
    }
    if (lifecycleFs.existsSync(worktree.durationTablePath)) entries[e13.DURATION_TABLE_PATH] = lifecycleFs.readFileSync(worktree.durationTablePath)
    return lifecycleHelper.buildTarArchive(entries)
  }

  /** A passing result file: a start and a passing end for each assigned script, then the end marker. */
  function lifecyclePassEvents(assigned: readonly string[]): ResultEvent[] {
    return [
      ...assigned.flatMap((fileName): ResultEvent[] => [
        { kind: e13.RESULT_WORD_START, fileName },
        { kind: e13.RESULT_WORD_END, fileName, result: e13.RESULT_WORD_PASS, seconds: SCRIPT_SECONDS },
      ]),
      { kind: e13.RESULT_WORD_DONE },
    ]
  }

  /** Builds a host (see `LifecycleHost`). */
  function lifecycleHost(options: LifecycleHostOptions = {}): LifecycleHost {
    const root = lifecycleFs.mkdtempSync(lifecyclePath.join(lifecycleTmpdir(), 'ci-run-lifecycle-e13-'))
    lifecycleRoots.push(root)
    const tempDir = lifecyclePath.join(root, 'tmp')
    const adSourceDir = lifecyclePath.join(root, 'agent-director-src')
    lifecycleFs.mkdirSync(tempDir)
    lifecycleFs.mkdirSync(adSourceDir)
    const clock = lifecycleClock.createFakeClock({ start: START_MS, flushTurns: 400 })
    const recorder = lifecycleHelper.createSpawnRecorder({ clock, root })
    const docker = lifecycleHelper.createFakeDocker(recorder)
    const signals = lifecycleHelper.createSignalRecorder({ processes: recorder.processes, clock })
    const lockBuild = lifecycleHelper.buildLockDir(root, { ...options.lockDir, processes: recorder.processes })
    const home = lockBuild.home
    if (home === null) throw new Error('lifecycleHost: the lock directory needs its home')
    const readings = lifecycleHelper.buildAdmissionReadings(root, docker, {
      pod: options.pod ?? DEFAULT_POD,
      volume: options.volume ?? { mountPoint: tempDir, usedGib: 20, availableGib: 180 },
    })
    const timeline: LifecycleEvent[] = []
    const runs: LifecycleRun[] = []
    docker.answerRuns((runArguments) => {
      const at = runArguments.findIndex((arg) => e13.IMAGE_ID_PATTERN.test(arg))
      const k = Number(runArguments[at + 1])
      const owner = runs.find((run) => runArguments.includes(e13.shardContainerName(run.owner, k)))
      if (owner === undefined) throw new Error(`lifecycleHost: no run owns ${JSON.stringify(runArguments)}`)
      return shardAnswers.get(owner.runId)!(runArguments.slice(at + 1))
    })
    const shardAnswers = new Map<string, (runnerArguments: readonly string[]) => lifecycleHelper.FakeRunAnswer>()
    const host: LifecycleHost = {
      root,
      tempDir,
      home,
      lockDir: lockBuild.lockDir,
      lockPath: lockBuild.lockPath,
      adSourceDir,
      clock,
      recorder,
      docker,
      signals,
      readings,
      lockBuild,
      timeline,
      run(runOptions = {}) {
        const run = lifecycleNewRun(host, runOptions, (runId, answer) => shardAnswers.set(runId, answer))
        runs.push(run)
        return run
      },
    }
    lifecycleHosts.push(host)
    return host
  }

  /** The lock file's flock and holder record, and the reservations, as they stand. */
  function lifecycleLockState(host: LifecycleHost): Pick<LifecycleEvent, 'lockHeld' | 'reservations' | 'lockRecord' | 'reservedCpus'> {
    const exists = lifecycleFs.existsSync(host.lockPath)
    const reservations = lifecycleFs.existsSync(host.lockDir) ? lifecycleFs.readdirSync(host.lockDir).filter((name) => e13.isReservationFileName(name)).sort() : []
    let reservedCpus = 0
    for (const name of reservations) {
      const parsed = e13.parseReservation(lifecycleFs.readFileSync(lifecyclePath.join(host.lockDir, name), 'utf-8'))
      if (parsed.ok) reservedCpus += parsed.value.cpus
    }
    return {
      lockHeld: exists && lifecycleHelper.probeFlock(host.lockPath) === 'held',
      lockRecord: exists ? lifecycleFs.readFileSync(host.lockPath, 'utf-8') : null,
      reservations,
      reservedCpus,
    }
  }

  function lifecycleNewRun(host: LifecycleHost, options: LifecycleRunOptions, registerShards: (runId: string, answer: (runnerArguments: readonly string[]) => lifecycleHelper.FakeRunAnswer) => void): LifecycleRun {
    const runId = options.runId ?? RUN_ID
    const pid = options.pid ?? RUN_PID
    const owner: e13.Owner = { runId, pid }
    const args = options.args ?? []
    const worktree = lifecycleHelper.buildWorktree(host.root, options.worktree ?? { scripts: SCRIPT_NUMBERS.map((n) => lifecycleHelper.realScriptFileName(n)), durationTable: lifecycleDurationTable(SCRIPT_NUMBERS) })
    const runDir = e13.runDirPath({ TMPDIR: host.tempDir }, runId)
    const packageDir = lifecyclePath.join(runDir, e13.PACKAGE_DIR_NAME)
    const tarballPath = lifecyclePath.join(packageDir, TARBALL_NAME)
    const given: Record<string, string | undefined> = {
      TMPDIR: host.tempDir,
      HOME: host.home,
      ANTHROPIC_API_KEY: SECRETS.key,
      GH_TOKEN: SECRETS.ghToken,
      [e13.AD_SOURCE_DIR_VARIABLE]: host.adSourceDir,
      ...options.env,
    }
    const env: Record<string, string> = {}
    for (const [name, value] of Object.entries(given)) if (value !== undefined) env[name] = value
    const source = lifecycleHelper.createSignalSource({ clock: host.clock })
    const stderr: string[] = []
    const statuses: string[] = []
    const shardStarts = new Map<number, number>()
    const assignedOf = new Map<number, readonly string[]>()
    const timers: LifecycleRunnerTimer[] = []
    const faults: LifecycleFaults = { setTimeout: null, clearTimeout: null, nowThrows: 0 }
    const passwordPath = lifecycleHelper.writePasswordFile(host.root, options.passwordText ?? lifecycleHelper.passwordFileCases(UID, host.home)['first-match'].text, `passwd-${runId}`)
    host.recorder.processes.add(lifecycleHelper.ciRunnerProcess(runId, { pid, worktreeRoot: worktree.root }))

    // The images: the base (unless missing) and the pinned image the test build reports, its /tests the worktree's.
    const baseImage = e13.readBaseImageName(worktree.root)
    if (!baseImage.ok) throw new Error('lifecycleRun: the worktree names no base image')
    if (options.baseMissing !== true && host.docker.image(baseImage.name) === null) host.docker.addImage({ tags: [baseImage.name] })
    const pinnedId = `sha256:${lifecycleHelper.hexValue(`e13-pinned-${runId}`, e13.SHA256_HEX_LENGTH)}`
    const archive = options.pinnedArchive?.(worktree) ?? lifecycleTestsArchive(worktree)
    const testTag = e13.formatRunTag(owner, 'test')
    /** The test build's image comes into being as its build is spawned (the fake then tags it, or leaves it untagged when the build fails). */
    const addPinnedImage = (request: e13.SpawnRequest): void => {
      const testBuild = request.ownProcessGroup && request.stdin === undefined && request.argv.includes(testTag)
      if (testBuild && host.docker.image(pinnedId) === null) {
        host.docker.addImage({ id: pinnedId, labels: { [e13.OWNER_LABEL]: e13.formatOwner(owner) }, archives: { [e13.IMAGE_TESTS_DIR]: archive } })
      }
    }
    host.docker.programBuild(options.testBuild ?? { kind: 'built', imageId: pinnedId, durationMs: options.buildMs ?? BUILD_MS }, { tag: testTag })

    // npm pack, and a missing base's prerequisites and base-build step.
    host.recorder.answer(
      e13.npmPackArgs(packageDir),
      options.npmPack ?? {
        delayMs: PACK_MS,
        stdout: `${TARBALL_NAME}\n`,
        sideEffect: (files) => {
          files.writeFile(tarballPath, TARBALL_BYTES)
        },
      },
    )
    if (options.baseMissing === true) {
      const adVersion = lifecycleFs.readFileSync(worktree.baseDockerfilePath, 'utf-8').split('\n').find((line) => line.startsWith(e13.AD_VERSION_ARG_PREFIX))?.slice(e13.AD_VERSION_ARG_PREFIX.length) ?? ''
      const adTag = `${e13.AD_TAG_PREFIX}${adVersion}`
      host.recorder.answer(e13.adTagCheckArgs(host.adSourceDir, adTag), {})
      host.recorder.answer(e13.adInstallScriptReadArgs(host.adSourceDir, adTag), { stdout: '#!/usr/bin/env bash\n' })
      host.recorder.answerWhen(
        (request) => request.argv.join(' ') === e13.GH_AUTH_TOKEN_ARGV.join(' ') && request.env.GH_CONFIG_DIR === e13.ghPersonalConfigDir(env),
        { stdout: `${SECRETS.baseBuildToken}\n` },
      )
      host.recorder.answer(e13.baseBuildStepArgs(worktree.root), options.baseBuildStep ?? { delayMs: BUILD_MS })
    }

    // Each shard's container: its plan, from the runner arguments its `docker run` carries.
    const invocation = e13.parseCiArguments(args)
    const runFaults = invocation.ok ? invocation.invocation.faults : []
    const runnerArgumentsOf = (runArguments: readonly string[]): readonly string[] => runArguments.slice(runArguments.findIndex((arg) => e13.IMAGE_ID_PATTERN.test(arg)) + 1)
    const assignedIn = (runnerArguments: readonly string[]): string[] => {
      const rest = runnerArguments.slice(2)
      return rest.filter((arg, i) => arg !== '--keep-going' && arg !== e13.RUNNER_FAIL_OPTION && rest[i - 1] !== e13.RUNNER_FAIL_OPTION)
    }
    registerShards(runId, (runnerArguments) => {
      const k = Number(runnerArguments[0])
      const canary = runnerArguments[1]!
      const assigned = assignedIn(runnerArguments)
      const plan = options.shard?.(k) ?? {}
      if (plan.failsToStart === true) return { kind: 'fail', leavesContainer: true }
      const name = e13.shardContainerName(owner, k)
      const shardDir = e13.shardSubdirectoryPath(runDir, k)
      const cgroupPath = `/docker/e13-${e13.formatOwner(owner)}-s${k}`
      host.readings.cgroups.writeContainer(cgroupPath, { currentBytes: 300_000_000 + k, anonBytes: 200_000_000 + k, fileBytes: 50_000_000, inactiveFileBytes: 10_000_000, pidCount: 20 + k, oomKillCount: 0 })
      shardStarts.set(k, host.clock.now())
      assignedOf.set(k, assigned)
      const write = (fileName: string, text: string): void => lifecycleFs.writeFileSync(lifecyclePath.join(shardDir, fileName), text)
      const inProgress = plan.inProgress?.(assigned) ?? []
      if (inProgress.length > 0) write(e13.RESULT_FILE_NAME, lifecycleHelper.resultFileText({ events: inProgress }))
      const endsAfterMs = plan.endsAfterMs === undefined ? SHARD_RUN_MS : plan.endsAfterMs
      if (endsAfterMs !== null) {
        host.clock.setTimeout(() => {
          if (host.docker.container(name)?.running !== true) return
          write(e13.CANARY_FILE_NAME, lifecycleHelper.hexRecordText(canary, e13.CANARY_LENGTH))
          write(e13.PACKAGE_SHA256_FILE_NAME, lifecycleHelper.hexRecordText(TARBALL_SHA256, e13.SHA256_HEX_LENGTH))
          write(e13.DEPENDENCY_FINGERPRINT_FILE_NAME, lifecycleHelper.hexRecordText(FINGERPRINT, e13.SHA256_HEX_LENGTH))
          for (const fileName of assigned) write(`${fileName}${e13.SCRIPT_LOG_SUFFIX}`, plan.scriptLog?.(fileName) ?? `${fileName}: the script's output\n`)
          write(e13.RESULT_FILE_NAME, lifecycleHelper.resultFileText({ events: plan.finished?.(assigned) ?? lifecyclePassEvents(assigned) }))
          host.docker.exitContainer(name, { exitCode: 0 })
        }, endsAfterMs)
      }
      const mounts = e13.shardMounts(runFaults, runDir, k, tarballPath).map((mount) => ({ source: mount.source, target: mount.target, rw: !mount.readOnly }))
      if (plan.performanceMount !== 'missing') mounts.push({ source: lifecyclePath.join(host.lockDir, plan.performanceMount === 'foreign' ? 'foreign.lock' : e13.PERFORMANCE_LOCK_FILE), target: e13.PERFORMANCE_LOCK_TARGET, rw: plan.performanceMount === 'writable' })
      if (assigned.some(file => file.includes('-fmk-real-codex'))) mounts.push({ source: lifecyclePath.join(host.home, '.codex/auth.json'), target: '/run/codex-login/auth.json', rw: true })
      return {
        kind: 'start',
        container: {
          process: { cgroup: lifecycleHelper.cgroupMembershipLine(cgroupPath) },
          logs: { stdout: `${e13.SHARD_DIR_PREFIX}${k}: the container's output\n` },
          inspection: { mounts, pidsLimit: e13.SHARD_PIDS_LIMIT, nanoCpus: e13.CPUS_PER_SHARD * 1e9 },
        },
      }
    })

    let draws = 0
    const record = (what: string, argv: readonly string[] | null): void => {
      run.observe()
      const event: LifecycleEvent = { runId, atMs: host.clock.now(), what, argv, ...lifecycleLockState(host), phase: e13.readStatusFile(runDir)?.phase ?? null }
      host.timeline.push(event)
      options.onEvent?.(event, run)
    }
    const processDeps = host.recorder.processes.deps()
    const clock: e13.RunnerClock = {
      now: () => {
        if (faults.nowThrows > 0) {
          faults.nowThrows -= 1
          throw new Error('e13 clock read failure')
        }
        return host.clock.now()
      },
      setTimeout: (callback, delayMs) => {
        if (faults.setTimeout?.(delayMs) === true) throw new Error('e13 timer failure')
        const handle = host.clock.setTimeout(callback, delayMs)
        timers.push({ handle, delayMs, atMs: host.clock.now() })
        return handle
      },
      clearTimeout: (handle) => {
        const timer = timers.find((armed) => armed.handle === handle)
        if (timer !== undefined && faults.clearTimeout?.(timer) === true) throw new Error('e13 timer cancel failure')
        host.clock.clearTimeout(handle)
      },
    }
    const runHead = e13.containerRunArgs([])
    const forward = (request: e13.SpawnRequest): ReturnType<e13.SpawnFn> => {
      run.observe()
      addPinnedImage(request)
      const opsBefore = host.docker.operations().length
      const spawned = host.recorder.spawn(request)
      const op = host.docker.operations()[opsBefore]
      record(request.argv[0] === e13.DOCKER_PROGRAM && op !== undefined ? op.kind : request.argv[0]!, request.argv)
      return spawned
    }
    const spawn: e13.SpawnFn = (request) => {
      const isRun = options.dockerRunDelayMs !== undefined && runHead.every((arg, i) => request.argv[i] === arg)
      const delay = isRun ? options.dockerRunDelayMs!(assignedIn(runnerArgumentsOf(request.argv))) : 0
      if (delay <= 0) return forward(request)
      // This shard's `docker run` answers `delay` later: it reaches the fake container interface then.
      const result = new Promise<e13.SpawnResult>((resolve) => {
        host.clock.setTimeout(() => {
          void forward(request).result.then(resolve)
        }, delay)
      })
      return { pid: null, processGroup: null, result }
    }
    const deps: e13.RunnerDeps = {
      spawn,
      codexLogin: options.deps?.codexLogin,
      env,
      pid,
      uid: UID,
      worktreeRoot: worktree.root,
      lockDir: host.lockDir,
      readPasswordFile: () => {
        record('password', null)
        return (options.deps?.readPasswordFile ?? lifecycleHelper.passwordFileReader(passwordPath))()
      },
      readCgroupFile: host.readings.cgroups.readCgroupFile,
      readProcCmdline: processDeps.readProcCmdline,
      readProcCwd: processDeps.readProcCwd,
      readProcCgroup: processDeps.readProcCgroup,
      readVolume: (path) => {
        record('volume', null)
        return (options.deps?.readVolume ?? host.readings.volume.readVolume)(path)
      },
      clock,
      randomBytes: (count) => {
        draws += 1
        return Uint8Array.from({ length: count }, (_, i) => (draws * 37 + i * 11 + pid) & 0xff)
      },
      sendSignal: host.signals.sendSignal,
      onSignal: source.onSignal,
      isPidAlive: processDeps.isPidAlive,
      writeStderr: (text) => {
        stderr.push(text)
      },
    }

    const readText = (name: string): string | null => {
      const path = lifecyclePath.join(runDir, name)
      return lifecycleFs.existsSync(path) ? lifecycleFs.readFileSync(path, 'utf-8') : null
    }
    const run: LifecycleRun = {
      runId,
      pid,
      owner,
      runDir,
      worktree,
      deps,
      source,
      stderr,
      tarballPath,
      statuses,
      shardStarts,
      assigned: assignedOf,
      timers,
      faults,
      pendingRunnerTimers() {
        const pending = new Set(host.clock.pending().map((timer) => timer.id))
        return timers.filter((timer) => pending.has((timer.handle as lifecycleClock.FakeTimerHandle).id))
      },
      main: (mainOptions) => e13.main([runId, ...args], deps, mainOptions),
      async sequence(extra) {
        const created = e13.createRunDirectory(runDir)
        if (created.kind !== 'created') throw new Error(`lifecycleRun: the run directory was not created: ${created.kind}`)
        const log = e13.createSealableRunnerLog(e13.createRunnerLog(lifecyclePath.join(runDir, e13.RUNNER_LOG_FILE_NAME)))
        const stopHooks = e13.createRunStopHooks()
        try {
          const context = e13.beginRun(deps, runId, runDir, args, log)
          stopHooks.trap(deps, log)
          return await e13.runSequence(deps, context, {
            onSequenceStart: (seq) => {
              stopHooks.onSequenceStart?.(seq)
              extra.onSequenceStart?.(seq)
            },
            onStep: (seq, step) => {
              stopHooks.onStep?.(seq, step)
              extra.onStep?.(seq, step)
            },
            onShardsScheduled: (seq, schedule) => {
              stopHooks.onShardsScheduled?.(seq, schedule)
              extra.onShardsScheduled?.(seq, schedule)
            },
            onEndOfRunStep: (seq, step) => {
              stopHooks.onEndOfRunStep?.(seq, step)
              extra.onEndOfRunStep?.(seq, step)
            },
            onSequenceEnd: (seq, exitStatus) => {
              extra.onSequenceEnd?.(seq, exitStatus)
              stopHooks.onSequenceEnd?.(seq, exitStatus)
            },
          })
        } finally {
          stopHooks.dispose()
        }
      },
      observe() {
        const text = readText(e13.STATUS_FILE_NAME)
        if (text !== null && statuses.at(-1) !== text) statuses.push(text)
      },
      results() {
        const text = readText(e13.RESULTS_FILE_NAME)
        if (text === null) return null
        const parsed = e13.parseResults(text)
        if (!parsed.ok) throw new Error(`lifecycleRun: results.json does not parse: ${parsed.error}`)
        return parsed.value
      },
      verdict() {
        const text = readText(e13.VERDICT_FILE_NAME)
        return text === null ? null : text.replace(/\n$/, '')
      },
      logLines() {
        const text = readText(e13.RUNNER_LOG_FILE_NAME) ?? ''
        return text === '' ? [] : text.replace(/\n$/, '').split('\n')
      },
      status: () => e13.readStatusFile(runDir),
    }
    return run
  }

  /** Moves the fake clock, one timer at a time, until every run's `main` has resolved; answers their exit statuses. */
  async function lifecycleSettle(host: LifecycleHost, runs: readonly LifecycleRun[], exits: readonly Promise<number>[]): Promise<number[]> {
    const done: (number | undefined)[] = exits.map(() => undefined)
    exits.forEach((exit, i) => {
      void exit.then((status) => {
        done[i] = status
      })
    })
    for (let step = 0; step < LIFECYCLE_MAX_STEPS; step++) {
      await host.clock.flush()
      for (const run of runs) run.observe()
      if (done.every((status) => status !== undefined)) return done as number[]
      if (host.clock.pendingCount() === 0) throw new Error('lifecycleSettle: no run has ended and no timer is pending')
      await host.clock.runNext()
    }
    throw new Error('lifecycleSettle: the runs did not end')
  }

  /** Runs one run's `main` to its end; answers its exit status. */
  async function lifecycleRunToEnd(host: LifecycleHost, run: LifecycleRun, options?: e13.MainOptions): Promise<number> {
    const [exit] = await lifecycleSettle(host, [run], [run.main(options)])
    return exit!
  }

  /**
   * That nothing changes after a run's last act: no runner timer pending, no
   * trap registered, each trapped signal reaching no handler, and an hour on
   * the run directory byte-identical (modes and change times included) with no
   * new event.
   */
  async function lifecycleExpectNothingAfter(host: LifecycleHost, run: LifecycleRun): Promise<void> {
    const before = lifecycleTreeSnapshot(run.runDir, { extended: true })
    const events = host.timeline.length
    expect(run.pendingRunnerTimers()).toEqual([])
    expect(run.source.handlerCount()).toBe(0)
    for (const signal of e13.TRAPPED_SIGNALS) expect(run.source.deliver(signal)).toBe(0)
    await host.clock.advance(60 * MS_PER_MINUTE)
    expect(lifecycleTreeSnapshot(run.runDir, { extended: true })).toEqual(before)
    expect(host.timeline.length).toBe(events)
  }

  /** Every output a run produced, for `assertNoLeak`: its run directory's files, standard error, and the host's timeline. */
  function lifecycleOutputs(host: LifecycleHost, run: LifecycleRun): unknown {
    return { runDir: lifecycleCredentials.writtenFile(run.runDir), stderr: run.stderr, timeline: host.timeline }
  }

  /** Moves the fake clock, timer by timer, up to `toMs` (every timer due by then fires), while the runs go on. */
  async function lifecycleAdvanceTo(host: LifecycleHost, runs: readonly LifecycleRun[], toMs: number): Promise<void> {
    for (let step = 0; step < LIFECYCLE_MAX_STEPS; step++) {
      await host.clock.flush()
      for (const run of runs) run.observe()
      const next = host.clock.pending()[0]
      if (next === undefined || next.dueAt > toMs) break
      await host.clock.runNext()
    }
    if (host.clock.now() < toMs) await host.clock.advanceTo(toMs)
    for (const run of runs) run.observe()
  }

  /** A run's events, in order. */
  function lifecycleEventsOf(host: LifecycleHost, run: LifecycleRun): LifecycleEvent[] {
    return host.timeline.filter((event) => event.runId === run.runId)
  }

  /** What each of a run's events was, in order. */
  function lifecycleWhats(host: LifecycleHost, run: LifecycleRun): string[] {
    return lifecycleEventsOf(host, run).map((event) => event.what)
  }

  /** A list with each run of equal neighbours made one. */
  function lifecycleCollapsed<T>(values: readonly T[]): T[] {
    return values.filter((value, i) => i === 0 || values[i - 1] !== value)
  }

  /** The index of the first event at or after `from` that is `what`; -1 for none. */
  function lifecycleIndexOf(events: readonly LifecycleEvent[], what: string, from = 0): number {
    return events.findIndex((event, i) => i >= from && event.what === what)
  }

  /** The index of the last event that is `what`; -1 for none. */
  function lifecycleLastIndexOf(events: readonly LifecycleEvent[], what: string): number {
    for (let i = events.length - 1; i >= 0; i--) if (events[i]!.what === what) return i
    return -1
  }

  /** Every status the run wrote, as seen, parsed by the runner's parser. */
  function lifecycleStatusesOf(run: LifecycleRun): RunStatus[] {
    return run.statuses.map((text) => {
      const parsed = e13.parseStatus(text)
      if (!parsed.ok) throw new Error(`lifecycleStatusesOf: status.json does not parse: ${parsed.error}`)
      return parsed.value
    })
  }

  /** The status the runner writes for this run in `phase` with the deadline `minutes` from the start. */
  function lifecycleStatus(run: LifecycleRun, phase: 'build' | 'shards' | 'merge', minutes: number): RunStatus {
    return e13.buildStatus({ runId: run.runId, pid: run.pid, startMs: START_MS, deadline: e13.statusDeadline(START_MS, minutes) }, phase)
  }

  /** T, the run's largest shard limit in whole milliseconds, from its results' assignment. */
  function lifecycleLargestLimitMs(results: Results, shardTimeoutMinutes: number | null = null): number {
    return Math.max(...results.shards.map((shard) => e13.shardLimitMs(shard.expectedSeconds, shardTimeoutMinutes)))
  }

  /** The deadline's minutes from the start: B (with the base allowance when missing), then B + T + 15 once scheduled. */
  function lifecycleDeadlineMinutes(baseMissing: boolean, largestLimitMs: number | null): number {
    return e13.runDeadlineOffset({ baseMissing, largestLimitMs }).minutes
  }

  /**
   * The events whose argument lists name shard k's container: by name, or by
   * the ID its start's inspection read named. That inspection is the first
   * after its `docker run` and before the next shard's; a shard that failed to
   * start has none, so it is found by name only.
   */
  function lifecycleShardEvents(host: LifecycleHost, run: LifecycleRun, k: number): LifecycleEvent[] {
    const events = lifecycleEventsOf(host, run)
    const name = e13.shardContainerName(run.owner, k)
    const runAt = events.findIndex((event) => event.what === 'container-run' && event.argv?.includes(name) === true)
    const startRead = runAt < 0 ? undefined : events.slice(runAt + 1).find((event) => event.what === 'container-inspection' || event.what === 'container-run')
    const id = startRead?.what === 'container-inspection' ? (startRead.argv?.at(-1) ?? null) : null
    return events.filter((event) => event.argv !== null && (event.argv.includes(name) || (id !== null && event.argv.includes(id))))
  }

  /** The docker operations a sample makes: the container list (two commands), then one state inspect per running shard. */
  function lifecycleSampleTimes(host: LifecycleHost, run: LifecycleRun): number[] {
    const events = lifecycleEventsOf(host, run)
    const firstRun = lifecycleIndexOf(events, 'container-run')
    return lifecycleCollapsed(events.filter((event, i) => i > firstRun && event.what === 'container-list').map((event) => event.atMs))
  }

  // -------------------------------------------------------------------------
  // .S1: the sequence, phases, run directory and measurements
  // -------------------------------------------------------------------------

  describe('the memory guard: Codex composed safety lifecycle', () => {
    const codexScript = 'test-999-fmk-real-codex.sh'
    function codexRun(host: LifecycleHost, extra: LifecycleRunOptions = {}) {
      const login = lifecycleHelper.makeFakeCodexLogin(host.clock, UID)
      const probe = { uid: UID }
      host.recorder.answerWhen(request => request.argv.includes('id') && request.argv.includes('testuser'), request => ({ stdout: `${probe.uid}\n`, sideEffect: () => { host.docker.addContainer({ name: request.argv[request.argv.indexOf('--name') + 1]!, running: false }) } }))
      const run = host.run({
        worktree: { scripts: [lifecycleHelper.realScriptFileName(1), lifecycleHelper.realScriptFileName(2), codexScript] },
        args: ['--shards', '2'], env: { CODEX_TEST_MODEL: 'inherited-model' }, ...extra,
        deps: { codexLogin: login.deps, ...extra.deps },
      })
      return { run, login, probe }
    }

    test('ordinary selected scripts require no Codex dependencies and record a null model', async () => {
      const host = lifecycleHost(), run = host.run({ args: ['test-2'] })
      await lifecycleRunToEnd(host, run)
      expect(run.verdict()).toMatch(/: PASS$/)
      expect(run.results()?.codexModel).toBeNull()
      expect(run.deps.codexLogin).toBeUndefined()
      lifecycleCredentials.assertNoLeak(lifecycleOutputs(host, run))
    })

    describe('independent tracks and one complete gate', () => {
      test('ordinary work completes under admission while another run holds the login lease', async () => {
        const host = lifecycleHost(), { run, login } = codexRun(host)
        login.busyUntil(Infinity)
        const pending = run.main()
        let observed: unknown
        try {
          // Diagnostic fake-clock horizon, not a native latency assertion. The
          // lease is a barrier: it cannot open merely because time advances.
          await lifecycleAdvanceTo(host, [run], START_MS + 2 * MS_PER_MINUTE)
          const starts = lifecycleEventsOf(host, run).filter(event => event.what === 'container-run')
          const ordinary = [...run.assigned].filter(([, assigned]) => !assigned.includes(codexScript))
          observed = {
            ordinaryAssignments: ordinary.map(([, assigned]) => assigned),
            ordinaryRetired: ordinary.length > 0 && ordinary.every(([k]) => host.docker.container(e13.shardContainerName(run.owner, k)) === null),
            startsHaveReservation: starts.length > 0 && starts.every(event => event.reservations.includes(e13.reservationFileName(run.owner)) && event.reservedCpus > 0),
            loginStarted: [...run.assigned.values()].some(assigned => assigned.includes(codexScript)),
            loginReads: login.reads(),
            verdict: run.verdict(),
          }
        } finally {
          login.busyUntil(host.clock.now())
          await lifecycleSettle(host, [run], [pending])
        }
        // Releasing B must still yield a complete, clean gate, not just A's PASS.
        expect(run.verdict()).toBe(e13.PASS_VERDICT)
        expect(login.releases()).toBe(1)
        expect(lifecycleLeftovers(host, run)).toEqual({ containers: [], images: [], reservations: [] })
        lifecycleCredentials.assertNoLeak(lifecycleOutputs(host, run))
        expect(observed).toEqual({
          ordinaryAssignments: [[lifecycleHelper.realScriptFileName(1), lifecycleHelper.realScriptFileName(2)]],
          ordinaryRetired: true,
          startsHaveReservation: true,
          loginStarted: false,
          loginReads: 0,
          verdict: null,
        })
      })

      test.each([0, 2 * MS_PER_MINUTE])('late login allowance after %i ms wait preserves shards status while ordinary work is still running', async loginWaitMs => {
        const host = lifecycleHost(), { run, login } = codexRun(host, {
          shard: k => ({ endsAfterMs: k === 1 ? 6 * MS_PER_MINUTE : SHARD_RUN_MS }),
        })
        login.busyUntil(START_MS + PACK_MS + BUILD_MS + loginWaitMs)
        const pending = run.main()
        let observed: unknown
        let scheduled: RunStatus | null = null
        let afterLogin: RunStatus | null = null
        let timerDeadlines: number[] = []
        try {
          await lifecycleAdvanceTo(host, [run], START_MS + PACK_MS + BUILD_MS + 1)
          scheduled = run.status()
          // Both immediate and contended login finish before A. The fake-clock
          // horizon observes the real main/stop-hook composition after B retires.
          await lifecycleAdvanceTo(host, [run], START_MS + 4 * MS_PER_MINUTE)
          afterLogin = run.status()
          timerDeadlines = run.pendingRunnerTimers().map(timer => timer.atMs + timer.delayMs)
          observed = {
            ordinaryRunning: host.docker.container(e13.shardContainerName(run.owner, 1))?.running,
            loginRetired: host.docker.container(e13.shardContainerName(run.owner, 2)) === null,
            leaseHeld: login.held(), releases: login.releases(), verdict: run.verdict(),
          }
        } finally { await lifecycleSettle(host, [run], [pending]) }
        expect(run.verdict()).toBe(e13.PASS_VERDICT)
        expect(lifecycleLeftovers(host, run)).toEqual({ containers: [], images: [], reservations: [] })
        lifecycleCredentials.assertNoLeak(lifecycleOutputs(host, run))
        expect(observed).toEqual({ ordinaryRunning: true, loginRetired: true, leaseHeld: false, releases: 1, verdict: null })
        const shardMinutes = lifecycleDeadlineMinutes(false, lifecycleLargestLimitMs(run.results()!))
        const provisionalMinutes = shardMinutes + e13.CODEX_LOGIN_LOCK_WAIT_MS / MS_PER_MINUTE
        const adjustedMinutes = shardMinutes + loginWaitMs / MS_PER_MINUTE
        expect(scheduled).toEqual(lifecycleStatus(run, 'shards', provisionalMinutes))
        // The smaller measured allowance must reach both the reader's status
        // file and the live timer, without moving the active phase backwards.
        expect(afterLogin?.deadline).toEqual(e13.statusDeadline(START_MS, adjustedMinutes))
        expect(timerDeadlines).toContain(START_MS + adjustedMinutes * MS_PER_MINUTE)
        expect(timerDeadlines).not.toContain(START_MS + provisionalMinutes * MS_PER_MINUTE)
        expect(afterLogin?.phase).toBe('shards')
        expect(lifecycleCollapsed(lifecycleStatusesOf(run).map(status => status.phase))).toEqual(['build', 'shards', 'merge'])
        expect(run.status()).toEqual(lifecycleStatus(run, 'merge', adjustedMinutes))
      })

      test('late login allowance retains the shards deadline stop and ordinary shard cause', async () => {
        const host = lifecycleHost()
        const loginWaitMs = 2 * MS_PER_MINUTE
        const shardTimeoutMinutes = 60
        const ordinaryScript = lifecycleHelper.realScriptFileName(2)
        const { run, login } = codexRun(host, {
          args: ['--shards', '2', '--shard-timeout', String(shardTimeoutMinutes)],
          // A starts late enough that the adjusted run deadline precedes its
          // own timeout; B has already finished when the allowance is applied.
          dockerRunDelayMs: assigned => assigned.includes(codexScript) ? 0 : 50 * MS_PER_MINUTE,
          shard: k => k === 1 ? {
            endsAfterMs: null,
            inProgress: () => [{ kind: e13.RESULT_WORD_START, fileName: ordinaryScript }],
          } : {},
        })
        login.busyUntil(START_MS + PACK_MS + BUILD_MS + loginWaitMs)
        expect(await lifecycleRunToEnd(host, run)).toBe(e13.VERDICT_WRITTEN_EXIT_STATUS)
        const adjustedMinutes = lifecycleDeadlineMinutes(false, shardTimeoutMinutes * MS_PER_MINUTE) + loginWaitMs / MS_PER_MINUTE
        const stop = e13.runDeadlineStop('shards', adjustedMinutes)
        const stoppedScript = e13.scriptEndLine(ordinaryScript, 1, e13.stoppedCauseOf(stop))
        const results = run.results()!
        expect(run.verdict()).toBe(e13.runLevelStopLine(stop))
        expect(results.failures.map(failure => failure.line)).toContain(e13.runLevelStopLine(stop))
        expect(results.shards[0]!.end).toBe(stoppedScript)
        expect(results.failures.map(failure => failure.line)).toContain(stoppedScript)
        expect(lifecycleShardEvents(host, run, 1).find(event => event.what === 'container-kill')?.atMs).toBe(START_MS + adjustedMinutes * MS_PER_MINUTE)
        expect(lifecycleShardEvents(host, run, 2).filter(event => event.what === 'container-kill')).toEqual([])
        expect(run.status()).toEqual(lifecycleStatus(run, 'merge', adjustedMinutes))
        expect(login.releases()).toBe(1)
        expect(login.held()).toBe(false)
        expect(lifecycleLeftovers(host, run)).toEqual({ containers: [], images: [], reservations: [] })
        await lifecycleExpectNothingAfter(host, run)
        lifecycleCredentials.assertNoLeak(lifecycleOutputs(host, run))
      })

      test.each([
        ['ordinary failure', 1, false], ['login failure', 2, false],
        ['ordinary missing coverage', 1, true], ['login missing coverage', 2, true],
      ] as const)('%s prevents the combined full gate even when the other track passes', async (_label, badShard, omit) => {
        const host = lifecycleHost(), { run, login } = codexRun(host, {
          shard: k => k !== badShard ? {} : {
            finished: assigned => lifecyclePassEvents(assigned).flatMap(event => {
              if ('fileName' in event && event.fileName === assigned.at(-1)) {
                if (omit) return []
                if (event.kind === 'end') return [{ ...event, result: e13.RESULT_WORD_FAIL }]
              }
              return [event]
            }),
          },
        })
        await lifecycleRunToEnd(host, run)
        expect(run.assigned.size).toBe(2)
        expect(run.verdict()).toMatch(/^FAIL:/)
        expect(login.releases()).toBe(1)
        expect(login.held()).toBe(false)
        expect(lifecycleLeftovers(host, run)).toEqual({ containers: [], images: [], reservations: [] })
        lifecycleCredentials.assertNoLeak(lifecycleOutputs(host, run))
      })

      test('full keep-going preserves gate eligibility only after both tracks pass', async () => {
        const host = lifecycleHost(), { run, login } = codexRun(host, { args: ['--shards', '2', '--keep-going'] })
        await lifecycleRunToEnd(host, run)
        expect(run.verdict()).toBe(e13.PASS_VERDICT)
        expect(run.assigned.size).toBe(2)
        expect(login.releases()).toBe(1)
        expect(lifecycleLeftovers(host, run)).toEqual({ containers: [], images: [], reservations: [] })
        lifecycleCredentials.assertNoLeak(lifecycleOutputs(host, run))
      })

      test.each(['ordinary', 'login'] as const)('keep-going retains an actual %s failure in the combined verdict', async track => {
        const host = lifecycleHost(), { run, login } = codexRun(host, {
          args: ['--shards', '2', '--keep-going'],
          shard: k => k === (track === 'ordinary' ? 1 : 2) ? {
            finished: assigned => lifecyclePassEvents(assigned).map(event => event.kind === 'end' && event.fileName === assigned.at(-1)
              ? { ...event, result: e13.RESULT_WORD_FAIL } : event),
          } : {},
        })
        await lifecycleRunToEnd(host, run)
        expect(run.assigned.size).toBe(2)
        expect(run.verdict()).toMatch(/^FAIL:/)
        expect(login.releases()).toBe(1)
        expect(lifecycleLeftovers(host, run)).toEqual({ containers: [], images: [], reservations: [] })
        lifecycleCredentials.assertNoLeak(lifecycleOutputs(host, run))
      })

      test('cancellation while a measurement holds the guard starts no build and releases the waiting descriptor', async () => {
        const host = lifecycleHost(), run = host.run()
        const opened = e13.openLockFile(lifecyclePath.join(host.lockDir, e13.PERFORMANCE_LOCK_FILE), 'exclusive')
        if (!opened.ok) throw new Error(opened.error)
        expect(opened.value.tryLock()).toEqual({ kind: 'taken' })
        const pending = run.main()
        try {
          await lifecycleAdvanceTo(host, [run], START_MS + MS_PER_MINUTE)
          expect(host.recorder.spawns().some(spawn => spawn.argv[0] === 'npm' || spawn.argv.includes('--detach') || spawn.argv.includes('build'))).toBe(false)
          expect(lifecycleLeftovers(host, run).reservations).toEqual([])
          run.source.deliver('SIGTERM')
          await lifecycleSettle(host, [run], [pending])
          expect(run.verdict()).toMatch(/^FAIL:.*SIGTERM/)
        } finally {
          opened.value.release()
        }
        const next = e13.openLockFile(lifecyclePath.join(host.lockDir, e13.PERFORMANCE_LOCK_FILE), 'exclusive')
        if (!next.ok) throw new Error(next.error)
        try { expect(next.value.tryLock()).toEqual({ kind: 'taken' }) } finally { next.value.release() }
        expect(run.pendingRunnerTimers()).toEqual([])
        expect(lifecycleLeftovers(host, run)).toEqual({ containers: [], images: [], reservations: [] })
        lifecycleCredentials.assertNoLeak(lifecycleOutputs(host, run))
      })

      test.each(['failed-build', 'cancelled-build'] as const)('%s releases the host shared performance guard', async kind => {
        const host = lifecycleHost()
        let sharedObserved = false
        const run = host.run({
          testBuild: kind === 'failed-build' ? { kind: 'failed', durationMs: BUILD_MS } : undefined,
          onEvent: (event, current) => {
            if (event.what !== 'image-build') return
            const path = lifecyclePath.join(host.lockDir, e13.PERFORMANCE_LOCK_FILE)
            const reader = e13.openLockFile(path, 'shared'), writer = e13.openLockFile(path, 'exclusive')
            if (!reader.ok || !writer.ok) throw new Error('fixture lock open failed')
            try {
              expect(reader.value.tryLock()).toEqual({ kind: 'taken' })
              expect(writer.value.tryLock()).toEqual({ kind: 'held' })
              sharedObserved = true
            } finally { reader.value.release(); writer.value.release() }
            if (kind === 'cancelled-build') current.source.deliver('SIGTERM')
          },
        })
        await lifecycleRunToEnd(host, run)
        expect(sharedObserved).toBe(true)
        expect(run.verdict()).toMatch(/^FAIL:/)
        const writer = e13.openLockFile(lifecyclePath.join(host.lockDir, e13.PERFORMANCE_LOCK_FILE), 'exclusive')
        if (!writer.ok) throw new Error(writer.error)
        try { expect(writer.value.tryLock()).toEqual({ kind: 'taken' }) } finally { writer.value.release() }
        expect(lifecycleLeftovers(host, run)).toEqual({ containers: [], images: [], reservations: [] })
        lifecycleCredentials.assertNoLeak(lifecycleOutputs(host, run))
      })

      test.each(['original', 'rotated'] as const)('a late ordinary artifact is scanned for %s login secrets after early lease release', async kind => {
        const host = lifecycleHost()
        const token = lifecycleCredentials.fakeToken('', kind === 'original' ? 'codex-access' : 'pb8-rotated')
        let login: ReturnType<typeof lifecycleHelper.makeFakeCodexLogin>
        const built = codexRun(host, {
          shard: k => ({ endsAfterMs: k === 1 ? 3 * MS_PER_MINUTE : 1_000,
            scriptLog: () => k === 1 ? token : 'safe output' }),
          onEvent: event => {
            if (kind === 'rotated' && event.what === 'container-run' && event.argv?.includes(codexScript)) {
              login.setLogin({ ...login.login(), json: { access_token: token } })
            }
          },
        })
        login = built.login
        const { run } = built
        const pending = run.main()
        await lifecycleAdvanceTo(host, [run], START_MS + 2 * MS_PER_MINUTE)
        expect(login.held()).toBe(false)
        expect(login.releases()).toBe(1)
        expect(run.verdict()).toBeNull()
        // A new owner may use the login now. The old run must scan retained
        // secrets without reading or changing that owner's login.
        const readsAtRelease = login.reads()
        await lifecycleSettle(host, [run], [pending])
        expect(login.reads()).toBe(readsAtRelease)
        expect(run.verdict()).toMatch(/^FAIL:.*secret/)
        expect(lifecycleLeftovers(host, run)).toEqual({ containers: [], images: [], reservations: [] })
        lifecycleCredentials.assertNoLeak({ results: run.results(), verdict: run.verdict(), log: run.logLines(), stderr: run.stderr })
      })

      test.each(['missing', 'writable', 'foreign'] as const)('a %s performance mount prevents a full keep-going gate', async performanceMount => {
        const host = lifecycleHost(), { run, login } = codexRun(host, {
          args: ['--shards', '2', '--keep-going'],
          shard: k => k === 1 ? { performanceMount } : {},
        })
        await lifecycleRunToEnd(host, run)
        expect(run.verdict()).toMatch(/^FAIL:.*performance guard mount/)
        expect(login.held()).toBe(false)
        expect(lifecycleLeftovers(host, run)).toEqual({ containers: [], images: [], reservations: [] })
        lifecycleCredentials.assertNoLeak(lifecycleOutputs(host, run))
      })

      test('final cleanup uncertainty cannot pass even when every script END record passed', async () => {
        const host = lifecycleHost(), run = host.run({
          args: ['--shards', '1', '--keep-going'],
          shard: () => ({
            inProgress: assigned => lifecyclePassEvents(assigned).slice(0, -1),
            endsAfterMs: null,
          }),
        })
        await lifecycleRunToEnd(host, run)
        expect(run.results()!.scripts.every(script => script.result === 'pass')).toBe(true)
        expect(run.results()!.shards.every(shard => !shard.endedNormally)).toBe(true)
        expect(run.verdict()).toMatch(/^FAIL:/)
        expect(lifecycleLeftovers(host, run)).toEqual({ containers: [], images: [], reservations: [] })
        lifecycleCredentials.assertNoLeak(lifecycleOutputs(host, run))
      })

      test('all independent failures and all notrun reasons survive results, summary and the reader codec', async () => {
        const host = lifecycleHost()
        const reasons = ['fail-fast', 'unsafe-cleanup', `dependency:${lifecycleHelper.realScriptFileName(2)}`]
        const run = host.run({ args: ['--shards', '1', '--keep-going'], shard: () => ({
          finished: assigned => [
            ...lifecyclePassEvents(assigned.slice(0, 1)).slice(0, -1),
            ...assigned.slice(1, 3).flatMap(fileName => [
              { kind: 'start' as const, fileName },
              { kind: 'end' as const, fileName, result: 'fail' as const, seconds: SCRIPT_SECONDS },
            ]),
            ...assigned.slice(3, 6).map((fileName, i) => ({ kind: 'notrun' as const, fileName, reason: reasons[i]! })),
            ...lifecyclePassEvents(assigned.slice(6)),
          ],
        }) })
        await lifecycleRunToEnd(host, run)
        expect(run.verdict()).toMatch(/^FAIL:/)
        const results = run.results()!
        const scripts = results.scripts
        expect(scripts.filter(script => script.result === 'fail').map(script => script.script)).toEqual([2, 3].map(lifecycleHelper.realScriptFileName))
        expect(scripts.filter(script => script.result === 'notrun').map(script => script.notrunReason)).toEqual(reasons)
        const summary = lifecycleFs.readFileSync(lifecyclePath.join(run.runDir, e13.SUMMARY_FILE_NAME), 'utf8')
        for (const script of scripts) {
          expect(summary).toContain(`${script.script}: ${script.result}`)
          if (script.result === 'fail') {
            expect(script.failLine).toBe(e13.noFailLineFallback(script.script))
            expect(summary).toContain(script.failLine!)
          }
        }
        for (const reason of reasons) expect(summary).toContain(reason)
        expect(e13.parseResults(lifecycleFs.readFileSync(lifecyclePath.join(run.runDir, e13.RESULTS_FILE_NAME), 'utf8'))).toEqual({ ok: true, value: results })
        expect(lifecycleLeftovers(host, run)).toEqual({ containers: [], images: [], reservations: [] })
        lifecycleCredentials.assertNoLeak(lifecycleOutputs(host, run))
      })

      test('CI-prefixed input reaches the composed runner without assigning host ANTHROPIC variables', async () => {
        const host = lifecycleHost(), run = host.run({ args: ['test-2'] })
        const env = Object.fromEntries(Object.entries(run.deps.env).filter(([name]) => !name.startsWith('ANTHROPIC_')))
        env.CI_ANTHROPIC_API_KEY = SECRETS.key
        env.CI_ANTHROPIC_MODEL = 'test-ci-model'
        const pending = e13.main([run.runId, 'test-2'], { ...run.deps, env })
        await lifecycleSettle(host, [run], [pending])
        expect(run.verdict()).toMatch(/: PASS$/)
        expect(run.verdict()).not.toBe(e13.PASS_VERDICT)
        const shards = host.recorder.spawns().filter(spawn => spawn.argv.includes('--detach'))
        expect(shards.length).toBeGreaterThan(0)
        // Check forwarding without ever putting a credential in an assertion's
        // printable operands or in Docker's argv.
        expect(shards.every(spawn => Object.values(spawn.env).includes(SECRETS.key))).toBe(true)
        expect(shards.every(spawn => !spawn.argv.some(arg => arg.includes(SECRETS.key)))).toBe(true)
        expect(shards.every(spawn => spawn.env.CI_ANTHROPIC_MODEL === 'test-ci-model')).toBe(true)
        expect(host.recorder.spawns().every(spawn => !Object.keys(spawn.env).some(name => name.startsWith('ANTHROPIC_')))).toBe(true)
        expect(Object.keys(env).some(name => name.startsWith('ANTHROPIC_'))).toBe(false)
        expect(lifecycleLeftovers(host, run)).toEqual({ containers: [], images: [], reservations: [] })
        lifecycleCredentials.assertNoLeak(lifecycleOutputs(host, run))
      })
    })

    test('a Codex shard replaces inherited model, isolates its mount and accounts for its extra memory', async () => {
      const host = lifecycleHost(), { run, login } = codexRun(host)
      await lifecycleRunToEnd(host, run)
      expect(run.verdict()).toBe(e13.PASS_VERDICT)
      expect(run.results()?.codexModel).toBe('test/model:1')
      expect(run.assigned.get(2)).toEqual([lifecycleHelper.realScriptFileName(1), codexScript])
      const spawns = host.recorder.spawns().filter(spawn => spawn.argv.includes('--detach'))
      expect(spawns).toHaveLength(2)
      expect(spawns.filter(spawn => spawn.argv.some(arg => arg.includes('/run/codex-login/auth.json')))).toHaveLength(1)
      const codex = spawns.find(spawn => spawn.argv.includes(codexScript))!
      expect(codex.env.CODEX_TEST_MODEL).toBe('test/model:1')
      expect(JSON.parse(codex.env.CODEX_HOST_CONFIG_KEYS!)).toEqual({ version: 1, keys: [['model']] })
      expect(codex.argv.filter((arg, i) => codex.argv[i - 1] === '--env')).toContain('CODEX_HOST_CONFIG_KEYS')
      expect(codex.argv.some(arg => arg.includes(codex.env.CODEX_HOST_CONFIG_KEYS!))).toBe(false)
      expect(codex.argv[codex.argv.indexOf('--ulimit') + 1]).toBe('core=0')
      expect(codex.argv[codex.argv.indexOf('--memory') + 1]).toBe(String(e13.SHARD_MEMORY_CAP_BYTES + 2 * e13.GIB_BYTES))
      const ordinary = spawns.find(spawn => !spawn.argv.includes(codexScript))!
      expect(ordinary.env.CODEX_HOST_CONFIG_KEYS).toBe('')
      expect(ordinary.argv[ordinary.argv.indexOf('--memory') + 1]).toBe(String(e13.SHARD_MEMORY_CAP_BYTES))
      expect(login.reads()).toBeGreaterThanOrEqual(3)
      expect(login.releases()).toBe(1)
      expect(login.held()).toBe(false)
      expect(lifecycleLeftovers(host, run)).toEqual({ containers: [], images: [], reservations: [] })
      lifecycleCredentials.assertNoLeak(lifecycleOutputs(host, run))
    })

    test.each(['missing-config', 'wrong-owner', 'uid-mismatch'] as const)('Codex %s refuses before any login-mounted shard starts', async kind => {
      const host = lifecycleHost(), { run, login, probe } = codexRun(host)
      if (kind === 'missing-config') login.deps.readConfig = () => { throw new Error(lifecycleCredentials.fakeToken('', 'private-config')) }
      if (kind === 'wrong-owner') login.setLogin({ ...login.login(), identity: { ...login.login().identity, uid: UID + 1 } })
      if (kind === 'uid-mismatch') probe.uid = UID + 1
      await lifecycleRunToEnd(host, run)
      expect(run.verdict()).not.toBe(e13.PASS_VERDICT)
      expect(host.recorder.spawns().filter(spawn => spawn.argv.includes('--detach') && spawn.argv.includes(codexScript))).toHaveLength(0)
      expect(lifecycleLeftovers(host, run)).toEqual({ containers: [], images: [], reservations: [] })
      expect(login.held()).toBe(false)
      expect(login.releases()).toBe(kind === 'missing-config' ? 0 : 1)
      lifecycleCredentials.assertNoLeak(lifecycleOutputs(host, run))
    })

    test('Codex interrupt while waiting for another login holder retires ordinary work without starting login work', async () => {
      const host = lifecycleHost(), { run, login } = codexRun(host)
      login.busyUntil(Infinity)
      const pending = run.main()
      await lifecycleAdvanceTo(host, [run], START_MS + 2 * MS_PER_MINUTE)
      expect(login.reads()).toBe(0)
      run.source.deliver('SIGTERM')
      await lifecycleSettle(host, [run], [pending])
      expect(run.verdict()).not.toBe(e13.PASS_VERDICT)
      expect(run.assigned.has(2)).toBe(false)
      expect(login.releases()).toBe(1)
      expect(login.held()).toBe(false)
      expect(lifecycleLeftovers(host, run)).toEqual({ containers: [], images: [], reservations: [] })
      lifecycleCredentials.assertNoLeak(lifecycleOutputs(host, run))
    })

    test('Codex login-lock wait allows ordinary completion without consuming its build/shard deadline', async () => {
      const host = lifecycleHost(), { run, login } = codexRun(host)
      login.busyUntil(host.clock.now() + 20 * 60_000)
      const pending = run.main()
      await host.clock.advance(20 * 60_000 - 1)
      expect(run.assigned.has(1)).toBe(true)
      expect(run.assigned.has(2)).toBe(false)
      expect(login.reads()).toBe(0)
      await host.clock.advance(1)
      await lifecycleSettle(host, [run], [pending])
      expect(run.verdict()).toBe(e13.PASS_VERDICT)
      expect(login.releases()).toBe(1)
      expect(lifecycleLeftovers(host, run)).toEqual({ containers: [], images: [], reservations: [] })
      lifecycleCredentials.assertNoLeak(lifecycleOutputs(host, run))
    })

    test.each(['survivor', 'unreadable'] as const)('Codex %s retirement evidence blocks admission while preserving other containers', async kind => {
      const host = lifecycleHost(), { run, login } = codexRun(host)
      if (kind === 'survivor') host.docker.addContainer({ name: 'earlier-codex-login', labels: { 'cscb.codex-login': 'true' } })
      else host.docker.fail('container-list', { when: argv => argv.includes('label=cscb.codex-login=true') })
      await lifecycleRunToEnd(host, run)
      expect(run.verdict()).not.toBe(e13.PASS_VERDICT)
      expect(run.assigned.has(1)).toBe(true)
      expect(run.assigned.has(2)).toBe(false)
      expect(host.recorder.spawns().some(spawn => spawn.argv.includes('--entrypoint'))).toBe(false)
      expect(login.releases()).toBe(1)
      if (kind === 'survivor') expect(host.docker.container('earlier-codex-login')?.running).toBe(true)
      lifecycleCredentials.assertNoLeak(lifecycleOutputs(host, run))
    })

    test('Codex lock remains held when repeated retirement failures leave its container alive', async () => {
      const host = lifecycleHost(), { run, login } = codexRun(host)
      host.docker.fail('container-remove', { times: 'always', when: argv => argv.some(arg => host.docker.container(arg)?.name === e13.shardContainerName(run.owner, 2)) })
      await lifecycleRunToEnd(host, run)
      expect(run.verdict()).not.toBe(e13.PASS_VERDICT)
      expect(login.held()).toBe(true)
      expect(login.releases()).toBe(0)
      expect(host.docker.container(e13.shardContainerName(run.owner, 2))).not.toBeNull()
      expect(run.logLines().join('\n')).toContain('login lease held until runner exit')
      lifecycleCredentials.assertNoLeak(lifecycleOutputs(host, run))
    })

    test('Codex uid-probe cleanup failure prevents login-mounted shard starts and PASS', async () => {
      const host = lifecycleHost(), { run, login } = codexRun(host)
      host.docker.fail('container-remove', { when: argv => argv.some(arg => arg.endsWith('-uid')) })
      await lifecycleRunToEnd(host, run)
      expect(run.verdict()).not.toBe(e13.PASS_VERDICT)
      expect(run.assigned.has(1)).toBe(true)
      expect(run.assigned.has(2)).toBe(false)
      expect(login.releases()).toBe(1)
      lifecycleCredentials.assertNoLeak(lifecycleOutputs(host, run))
    })

    test.each(['container-remove', 'container-logs'] as const)('Codex retirement %s failure prevents PASS and releases the login lock', async operation => {
      const host = lifecycleHost(), { run, login } = codexRun(host)
      host.docker.fail(operation, { when: argv => argv.some(arg => host.docker.container(arg)?.name === e13.shardContainerName(run.owner, 2)) })
      await lifecycleRunToEnd(host, run)
      expect(run.verdict()).not.toBe(e13.PASS_VERDICT)
      expect(login.releases()).toBe(1)
      expect(login.held()).toBe(false)
      lifecycleCredentials.assertNoLeak(lifecycleOutputs(host, run))
    })

    test.each(['script-failure', 'interrupt', 'login-postcheck', 'original-secret', 'rotated-secret'] as const)('Codex %s retires before postcheck and never produces PASS', async kind => {
      const host = lifecycleHost()
      let login: ReturnType<typeof lifecycleHelper.makeFakeCodexLogin>
      const built = codexRun(host, {
        shard: k => k === 2 ? {
          ...(kind === 'script-failure' ? { finished: assigned => lifecyclePassEvents(assigned).map(event => event.kind === 'end' && event.fileName === codexScript ? { ...event, result: 'fail' as const } : event) } : {}),
          scriptLog: () => kind === 'original-secret' ? lifecycleCredentials.fakeToken('', 'codex-access') : kind === 'rotated-secret' ? lifecycleCredentials.fakeToken('', 'rotated-login') : 'safe script output',
        } : {},
        onEvent: event => {
          if (event.what === 'container-run' && event.argv?.includes(codexScript)) {
            if (kind === 'interrupt') host.clock.setTimeout(() => built.run.source.deliver('SIGTERM'), 1)
            if (kind === 'login-postcheck') login.setLogin({ ...login.login(), identity: { ...login.login().identity, ino: 11 } })
            if (kind === 'rotated-secret') login.setLogin({ ...login.login(), json: { access_token: lifecycleCredentials.fakeToken('', 'rotated-login') } })
          }
        },
      })
      login = built.login
      const { run } = built
      const baseRead = login.deps.readLogin
      let retiredBeforeFinalRead = false
      login.deps.readLogin = path => {
        if (run.assigned.has(2) && host.docker.container(e13.shardContainerName(run.owner, 2))?.running !== true) retiredBeforeFinalRead = true
        return baseRead(path)
      }
      await lifecycleRunToEnd(host, run)
      expect(run.verdict()).not.toBe(e13.PASS_VERDICT)
      expect(retiredBeforeFinalRead).toBe(true)
      expect(login.releases()).toBe(1)
      expect(login.held()).toBe(false)
      expect(lifecycleLeftovers(host, run)).toEqual({ containers: [], images: [], reservations: [] })
      // Secret-scan tests intentionally plant fake secrets in per-script output;
      // assert diagnostics/results are safe, excluding the deliberately rejected artifact.
      if (kind.endsWith('secret')) lifecycleCredentials.assertNoLeak({ stderr: run.stderr, results: run.results(), verdict: run.verdict(), log: run.logLines() })
      else lifecycleCredentials.assertNoLeak(lifecycleOutputs(host, run))
    })
  })

  describe('the sequence, phases, run directory and measurements', () => {
    /** Steps 3–12 of a default full run with its base present, up to the shard starts, as the fake records them. */
    const STEPS_3_TO_12: readonly (readonly string[])[] = [
      ['version'], // step 3: docker answers
      ['image-inspect'], // step 4: the base image
      ['npm'], // step 5: packing
      ['password'], // step 6: the account's home, then the lock
      ['container-list', 'image-list', 'image-list'], // step 7: the sweep
      ['volume', 'container-list'], // step 8: the readings
      ['image-build'], // step 12: the test build
      ['container-create', 'container-copy', 'container-remove', 'container-remove'], // the read-back, then the read container's removal
    ]
    const SHARD_STARTS = Array.from({ length: e13.MAX_SHARDS }, () => ['container-run', 'container-inspection']).flat()

    test('a passing default full run takes steps 3–13 in the contract order: the lock held from the sweep through the readings, the reservation from step 10, the lock free at the build; exit 0', async () => {
      const host = lifecycleHost()
      const run = host.run()
      expect(await lifecycleRunToEnd(host, run)).toBe(e13.VERDICT_WRITTEN_EXIT_STATUS)

      const events = lifecycleEventsOf(host, run)
      const before = STEPS_3_TO_12.flat()
      expect(events.slice(0, before.length + SHARD_STARTS.length).map((event) => event.what)).toEqual([...before, ...SHARD_STARTS])
      const at = (what: string, from = 0): LifecycleEvent => events[lifecycleIndexOf(events, what, from)]!
      const sweep = lifecycleIndexOf(events, 'container-list')
      const readings = lifecycleIndexOf(events, 'container-list', sweep + 1)
      const ownReservation = [e13.reservationFileName(run.owner)]
      // Lock: not held before step 6's take; held, in this run's name, from the sweep through the readings; free from the build on.
      expect(events.slice(0, sweep).every((event) => !event.lockHeld)).toBe(true)
      expect(events.slice(sweep, readings + 1).every((event) => event.lockHeld && event.lockRecord === e13.formatLockHolder(run.owner) && event.reservations.length === 0)).toBe(true)
      expect(events.slice(readings + 1).every((event) => !event.lockHeld)).toBe(true)
      // Reservation and watchdog (step 10) before the lock's release (step 11): the reservation is there at the build, and the first sample comes 30 s after the readings.
      expect(at('image-build').reservations).toEqual(ownReservation)
      expect(lifecycleSampleTimes(host, run)[0]).toBe(events[readings]!.atMs + e13.SAMPLE_INTERVAL_MS)
      // The follow loop, then the end of run: every shard retired, the read container removed, the reservation gone by the image cleanup.
      const lastRetirement = lifecycleLastIndexOf(events, 'container-logs')
      expect(events.slice(lastRetirement + 1).map((event) => event.what)).toEqual([...Array<string>(e13.MAX_SHARDS).fill('container-remove'), 'container-remove', 'image-remove', 'image-list'])
      expect(at('image-remove').reservations).toEqual([])
      expect(run.verdict()).toBe(e13.PASS_VERDICT)
      lifecycleCredentials.assertNoLeak(lifecycleOutputs(host, run))
    })

    test.each([
      [
        'a missing base: its prerequisites read at step 4, the base-build step after the lock\'s release and before the test build',
        { baseMissing: true },
        (events: readonly LifecycleEvent[]) => {
          const step = lifecycleIndexOf(events, 'bash')
          expect(events.slice(0, lifecycleIndexOf(events, 'npm')).map((event) => event.what)).toEqual(['version', 'image-inspect', 'git', 'git', 'gh'])
          expect(events.slice(step - 2, step + 2).map((event) => event.what)).toEqual(['container-list', 'image-inspect', 'bash', 'image-build'])
          expect([events[step]!.lockHeld, events[step]!.reservations.length]).toEqual([false, 1])
        },
      ],
      [
        'image-drift: and retag: the fault images after the read-back and before any shard start, the tag moved after every start was attempted',
        { args: ['--inject', e13.faultText({ kind: 'image-drift', shard: 2 }), '--inject', e13.faultText({ kind: 'retag' })] },
        (events: readonly LifecycleEvent[]) => {
          const readBackEnd = lifecycleIndexOf(events, 'container-remove', lifecycleIndexOf(events, 'container-copy')) + 1
          const firstStart = lifecycleIndexOf(events, 'container-run')
          const checkedBuild = ['image-inspect', 'image-build', 'image-inspect']
          expect(events.slice(readBackEnd + 1, firstStart).map((event) => event.what)).toEqual([...checkedBuild, ...checkedBuild])
          const lastStart = lifecycleLastIndexOf(events, 'container-run')
          expect(events.slice(lastStart + 1, lastStart + 3).map((event) => event.what)).toEqual(['container-inspection', 'image-tag'])
        },
      ],
    ] satisfies [string, LifecycleRunOptions, (events: readonly LifecycleEvent[]) => void][])('%s', async (_what, options, expectOrder) => {
      const host = lifecycleHost()
      const run = host.run(options)
      expect(await lifecycleRunToEnd(host, run)).toBe(e13.VERDICT_WRITTEN_EXIT_STATUS)
      expectOrder(lifecycleEventsOf(host, run))
      lifecycleCredentials.assertNoLeak(lifecycleOutputs(host, run))
    })

    test('phases: build until scheduling, shards from the scheduling write, merge from the end of run; each status written holds the deadline then in force', async () => {
      const host = lifecycleHost()
      const run = host.run()
      await lifecycleRunToEnd(host, run)
      const results = run.results()!
      const scheduled = lifecycleDeadlineMinutes(false, lifecycleLargestLimitMs(results))
      expect(lifecycleStatusesOf(run)).toEqual([lifecycleStatus(run, 'build', e13.BUILD_ALLOWANCE_MINUTES), lifecycleStatus(run, 'shards', scheduled), lifecycleStatus(run, 'merge', scheduled)])
      const events = lifecycleEventsOf(host, run)
      expect(lifecycleCollapsed(events.map((event) => event.phase))).toEqual(['build', 'shards', 'merge'])
      // The first event in phase shards is the first shard start; merge begins after the follow loop's last retirement.
      expect(events.find((event) => event.phase === 'shards')?.what).toBe('container-run')
      expect(events.findIndex((event) => event.phase === 'merge')).toBe(lifecycleLastIndexOf(events, 'container-logs') + e13.MAX_SHARDS + 1)
      lifecycleCredentials.assertNoLeak(lifecycleOutputs(host, run))
    })

    test('a run whose test image build failed goes from build to merge and stays there through its checks, results and cleanup', async () => {
      const host = lifecycleHost()
      const run = host.run({ testBuild: { kind: 'failed', durationMs: BUILD_MS } })
      expect(await lifecycleRunToEnd(host, run)).toBe(e13.VERDICT_WRITTEN_EXIT_STATUS)
      expect(lifecycleStatusesOf(run)).toEqual([lifecycleStatus(run, 'build', e13.BUILD_ALLOWANCE_MINUTES), lifecycleStatus(run, 'merge', e13.BUILD_ALLOWANCE_MINUTES)])
      const events = lifecycleEventsOf(host, run)
      const build = lifecycleIndexOf(events, 'image-build')
      expect(events.slice(build + 1).length).toBeGreaterThan(0)
      expect(events.slice(build + 1).every((event) => event.phase === 'merge')).toBe(true)
      expect(run.verdict()).toBe(e13.testImageBuildFailedLine(1))
      lifecycleCredentials.assertNoLeak(lifecycleOutputs(host, run))
    })

    /** Each shard's finished result file in the script-failure row: shard 2's second script fails. */
    const failingShard = (k: number): LifecycleShardPlan =>
      k !== 2
        ? {}
        : {
            finished: (assigned) => [
              ...lifecyclePassEvents(assigned.slice(0, 1)).slice(0, -1),
              { kind: e13.RESULT_WORD_START, fileName: assigned[1]! },
              { kind: e13.RESULT_WORD_END, fileName: assigned[1]!, result: e13.RESULT_WORD_FAIL, seconds: SCRIPT_SECONDS },
              { kind: e13.RESULT_WORD_DONE },
            ],
          }

    const DIRECTORY_ROWS: [string, LifecycleRunOptions][] = [
      ['a pass', {}],
      ['a script failure', { shard: failingShard }],
    ]
    test.each(DIRECTORY_ROWS)('after %s the run directory holds only entries, with their modes, and no temporary file', async (_what, options) => {
      const host = lifecycleHost()
      const run = host.run(options)
      await lifecycleRunToEnd(host, run)
      const shardDirs = Array.from({ length: e13.MAX_SHARDS }, (_, i) => `${e13.SHARD_DIR_PREFIX}${i + 1}`)
      const files = [e13.RESULTS_FILE_NAME, e13.RUNNER_LOG_FILE_NAME, e13.STATUS_FILE_NAME, e13.SUMMARY_FILE_NAME, e13.VERDICT_FILE_NAME]
      expect(lifecycleFs.readdirSync(run.runDir).sort()).toEqual([e13.PACKAGE_DIR_NAME, ...files, ...shardDirs].sort())
      const mode = (path: string): number => lifecycleFs.lstatSync(path).mode & 0o7777
      const at = (...names: string[]): string => lifecyclePath.join(run.runDir, ...names)
      expect(mode(run.runDir)).toBe(e13.RUN_DIR_MODE)
      expect(mode(at(e13.PACKAGE_DIR_NAME))).toBe(e13.PACKAGE_DIR_MODE)
      expect(lifecycleFs.readdirSync(at(e13.PACKAGE_DIR_NAME))).toEqual([TARBALL_NAME])
      expect(mode(run.tarballPath)).toBe(e13.PACKAGE_TARBALL_MODE)
      for (const dir of shardDirs) expect(mode(at(dir))).toBe(e13.RUN_DIR_MODE)
      for (const file of files) expect(mode(at(file))).toBe(e13.WRITTEN_FILE_MODE)
      for (const dir of shardDirs) expect(lifecycleFs.readdirSync(at(dir))).toContain(e13.DOCKER_LOG_FILE_NAME)
      if (options.shard !== undefined) expect(run.verdict()).not.toBe(e13.PASS_VERDICT)
      lifecycleCredentials.assertNoLeak(lifecycleOutputs(host, run))
    })

    test.each([
      ['present: the base-build time is 0', false],
      ['missing: the base-build step\'s own run', true],
    ])('measurements with the base %s; the build from packing to the pin, each shard from its start to its final reading, the total to the verdict', async (_what, baseMissing) => {
      const host = lifecycleHost()
      const run = host.run({ baseMissing })
      await lifecycleRunToEnd(host, run)
      const verdictAtMs = host.clock.now()
      const events = lifecycleEventsOf(host, run)
      const at = (what: string): number => events[lifecycleIndexOf(events, what)]!.atMs
      const results = run.results()!
      expect(results.timing).toEqual({
        buildSeconds: (at('container-create') - at('npm')) / 1000,
        baseBuildSeconds: baseMissing ? (at('image-build') - at('bash')) / 1000 : 0,
        totalSeconds: (verdictAtMs - START_MS) / 1000,
      })
      for (const shard of results.shards) {
        const finalReading = lifecycleShardEvents(host, run, shard.shard).find((event) => event.what === 'container-logs')!.atMs
        expect(shard.seconds).toBe((finalReading - run.shardStarts.get(shard.shard)!) / 1000)
      }
      expect(run.status()?.startedAt).toBe(new Date(START_MS).toISOString().replace(/\.000Z$/, 'Z'))
      lifecycleCredentials.assertNoLeak(lifecycleOutputs(host, run))
    })
  })

  // -------------------------------------------------------------------------
  // .S2: the follow loop's wiring
  // -------------------------------------------------------------------------

  describe('the follow loop\'s wiring: samples, end markers, limit timers and faults', () => {
    /** The times of the watchdog's samples: each container listing after the readings'. */
    function sampleTimes(host: LifecycleHost, run: LifecycleRun): number[] {
      const events = lifecycleEventsOf(host, run)
      const readings = lifecycleIndexOf(events, 'container-list', lifecycleIndexOf(events, 'container-list') + 1)
      return lifecycleCollapsed(events.filter((event, i) => i > readings && event.what === 'container-list').map((event) => event.atMs))
    }

    /** When shard k's final reading was taken: its retirement's log save, at the same moment. */
    function finalReadingAt(host: LifecycleHost, run: LifecycleRun, k: number): number {
      return lifecycleShardEvents(host, run, k).find((event) => event.what === 'container-logs')!.atMs
    }

    test('samples come every 30 s from the reservation, the build included (no shard read then), until end-of-run step 4 stops them; no 1 s poll without a due timeout: or kill:', async () => {
      const host = lifecycleHost()
      const longBuildMs = 2 * e13.SAMPLE_INTERVAL_MS + 10_000
      const run = host.run({ buildMs: longBuildMs })
      await lifecycleRunToEnd(host, run)
      const events = lifecycleEventsOf(host, run)
      const reservedAt = events[lifecycleIndexOf(events, 'image-build')]!.atMs
      const times = sampleTimes(host, run)
      expect(times).toEqual(times.map((_, i) => reservedAt + (i + 1) * e13.SAMPLE_INTERVAL_MS))
      // The samples during the build list the containers and read no shard.
      const buildEnd = reservedAt + longBuildMs
      const duringBuild = events.filter((event) => event.atMs > reservedAt && event.atMs < buildEnd)
      expect(lifecycleCollapsed(duringBuild.map((event) => event.what))).toEqual(['container-list'])
      // The last sample is the one that found the end markers; the end of run ran at that moment and stopped the watchdog.
      expect(times.at(-1)).toBe(host.clock.now())
      expect(run.pendingRunnerTimers()).toEqual([])
      expect(run.timers.filter((timer) => timer.delayMs === e13.FAULT_POLL_INTERVAL_MS)).toEqual([])
      lifecycleCredentials.assertNoLeak(lifecycleOutputs(host, run))
    })

    test('an end marker written between samples gets its final reading at the next sample; with a timeout: due, the 1 s poll finds it at once', async () => {
      const host = lifecycleHost()
      const timeoutScript = e13.numberFormOf(2)
      const run = host.run({ args: ['--inject', e13.faultText({ kind: 'timeout', script: timeoutScript })] })
      await lifecycleRunToEnd(host, run)
      const polled = [...run.assigned].find(([, assigned]) => assigned.includes(lifecycleHelper.realScriptFileName(2)))![0]
      const times = sampleTimes(host, run)
      for (const k of run.shardStarts.keys()) {
        const endedAt = run.shardStarts.get(k)! + SHARD_RUN_MS
        if (k === polled) {
          expect(finalReadingAt(host, run, k)).toBe(endedAt)
        } else {
          expect(finalReadingAt(host, run, k)).toBe(times.find((time) => time >= endedAt)!)
        }
      }
      expect(run.timers.filter((timer) => timer.delayMs === e13.FAULT_POLL_INTERVAL_MS).length).toBe(SHARD_RUN_MS / e13.FAULT_POLL_INTERVAL_MS)
      lifecycleCredentials.assertNoLeak(lifecycleOutputs(host, run))
    })

    test('a limit fires at its own moment between samples and retires that shard with its limit cause; an earlier shard\'s timer was cancelled; the end of run starts once the last shard ended', async () => {
      const host = lifecycleHost()
      // Two units: test-1 with test-2 (limit at the floor) and test-1 with test-3, whose estimate gives it the longer limit.
      const seconds: Readonly<Record<number, number>> = { 1: 60, 2: 60, 3: 1200 }
      const run = host.run({
        worktree: {
          scripts: [1, 2, 3].map((n) => lifecycleHelper.realScriptFileName(n)),
          durationTable: { kind: 'rows', header: e13.DURATION_TABLE_HEADER, rows: [1, 2, 3].map((n) => ({ script: n, seconds: seconds[n]! })) },
        },
        shard: (k) => (k === 1 ? { endsAfterMs: null } : {}),
      })
      const exit = run.main()
      await lifecycleAdvanceTo(host, [run], START_MS + 10 * MS_PER_MINUTE)
      /** Shard k's limit from its assigned scripts' estimates (scheduling's rule), and the timer the runner armed with it at its start. */
      const limitMs = (k: number): number => e13.shardLimitMs(run.assigned.get(k)!.reduce((sum, fileName) => sum + seconds[e13.fileNameNumber(fileName)!]!, 0), null)
      const limitTimer = (k: number): LifecycleRunnerTimer | undefined => run.timers.find((timer) => timer.atMs === run.shardStarts.get(k) && timer.delayMs === limitMs(k))
      expect(limitMs(1)).toBeGreaterThan(limitMs(2))
      // At 10 min shard 2 has ended (end marker): its limit timer is no longer pending; shard 1's still is.
      expect(lifecycleShardEvents(host, run, 2).some((event) => event.what === 'container-remove')).toBe(true)
      expect(run.pendingRunnerTimers()).toContain(limitTimer(1)!)
      expect(run.pendingRunnerTimers()).not.toContain(limitTimer(2)!)
      await lifecycleSettle(host, [run], [exit])

      const results = run.results()!
      const killedAt = run.shardStarts.get(1)! + limitMs(1)
      const shard1 = lifecycleShardEvents(host, run, 1)
      expect(shard1.find((event) => event.what === 'container-kill')?.atMs).toBe(killedAt)
      expect(sampleTimes(host, run)).not.toContain(killedAt)
      expect(results.shards[0]!.end).toContain(e13.shardCauseText(e13.wallTimeLimitCause(results.shards[0]!.limitMinutes)))
      expect(results.shards[1]!.end).toBe(e13.NORMAL_SHARD_END)
      // The end of run began at the last shard's retirement, the merge switch being its first act.
      const events = lifecycleEventsOf(host, run)
      expect(events.find((event) => event.phase === 'merge')?.atMs).toBe(killedAt)
      lifecycleCredentials.assertNoLeak(lifecycleOutputs(host, run))
    })

    test('a kill: decision is carried out through retirement once a script is in progress, its cause fixed first; a leak: and an image-drift: are recorded fired at their shards\' starts', async () => {
      const host = lifecycleHost()
      const run = host.run({
        args: ['--inject', e13.faultText({ kind: 'kill', shard: 2 }), '--inject', e13.faultText({ kind: 'leak', sourceShard: 1, targetShard: 3 }), '--inject', e13.faultText({ kind: 'image-drift', shard: 4 })],
        shard: (k) => (k === 2 ? { inProgress: (assigned) => [{ kind: e13.RESULT_WORD_START, fileName: assigned[0]! }], endsAfterMs: null } : {}),
      })
      await lifecycleRunToEnd(host, run)
      const results = run.results()!
      const shard2 = lifecycleShardEvents(host, run, 2)
      expect(shard2.find((event) => event.what === 'container-kill')?.atMs).toBe(run.shardStarts.get(2)! + e13.FAULT_POLL_INTERVAL_MS)
      expect(results.shards[1]!.end).toContain(e13.shardCauseText({ kind: 'killed', fixedByRunner: true }))
      const faultFired = e13.integrityFailure('fault-fired', '', null).line
      expect(results.failures.filter((failure) => failure.line.startsWith(faultFired))).toEqual([])
      expect(results.skippedChecks).not.toContain('fault-fired')
      lifecycleCredentials.assertNoLeak(lifecycleOutputs(host, run))
    })
  })

  // -------------------------------------------------------------------------
  // .S3:, two admissions at the same moment (steps 6–11)
  // -------------------------------------------------------------------------

  describe('two default full runs admitted at the same moment against one lock and one set of reservations', () => {
    /** Test data: a RUN_ID for a lock file's dead holder. */
    const DEAD_HOLDER_RUN_ID = '20261008t130000z-e13dead1'

    test.each([
      ['no lock file yet', {}],
      ['a lock file naming a dead holder, no flock held', { lockFile: { holder: { runId: DEAD_HOLDER_RUN_ID, alive: false } } }],
    ] satisfies [string, Omit<lifecycleHelper.LockDirSpec, 'processes'>][])('with %s: exactly one is admitted with 6 shards, the other refused naming it; never both under the lock; the reservations never past the CPUs; the lock free at every build', async (_what, lockDir) => {
      const host = lifecycleHost({ lockDir })
      const first = host.run({ runId: RUN_ID, pid: RUN_PID })
      const second = host.run({ runId: OTHER_RUN_ID, pid: OTHER_PID })
      const exits = await lifecycleSettle(host, [first, second], [first.main(), second.main()])

      const refusedAt = [first, second].findIndex((run) => run.status()?.phase === 'refused')
      expect(refusedAt).toBeGreaterThanOrEqual(0)
      const refused = [first, second][refusedAt]!
      const admitted = [first, second][1 - refusedAt]!
      expect(exits[refusedAt]).toBe(e13.REFUSAL_EXIT_STATUS)
      expect(exits[1 - refusedAt]).toBe(e13.VERDICT_WRITTEN_EXIT_STATUS)
      expect(admitted.results()?.shardCount.admitted).toBe(e13.MAX_SHARDS)
      expect(admitted.verdict()).toBe(e13.PASS_VERDICT)

      // The refusal: CPU, its lines as message gives them, one naming the admitted run by RUN_ID and runner PID.
      const refusal = refused.status()?.refusal
      expect(refusal?.kind).toBe('cpu')
      expect(refusal?.details.some((line) => line.includes(admitted.runId) && line.includes(String(admitted.pid)))).toBe(true)
      expect(refused.logLines().slice(-1 - refusal!.details.length)).toEqual([e13.refusalLine(refusal!), ...refusal!.details])
      expect(refused.verdict()).toBeNull()

      // The lock: every moment it was held, it was held in one run's name; the admitted run's turn, then the refused one's.
      const holders = lifecycleCollapsed(host.timeline.filter((event) => event.lockHeld).map((event) => event.lockRecord))
      expect(holders).toEqual([e13.formatLockHolder(admitted.owner), e13.formatLockHolder(refused.owner)])
      // The reservations: at most the 12 CI CPUs at any moment; the admitted run's alone when the refused run read them.
      expect(Math.max(...host.timeline.map((event) => event.reservedCpus))).toBe(e13.MAX_SHARDS * e13.CPUS_PER_SHARD)
      expect(e13.MAX_SHARDS * e13.CPUS_PER_SHARD).toBeLessThanOrEqual(e13.CI_CPUS)
      const refusedEvents = lifecycleEventsOf(host, refused)
      expect(refusedEvents[lifecycleLastIndexOf(refusedEvents, 'container-list')]!.reservations).toEqual([e13.reservationFileName(admitted.owner)])
      // Released before either run's first build; the refused run built nothing.
      const builds = host.timeline.filter((event) => event.what === 'image-build')
      expect(builds.map((event) => [event.runId, event.lockHeld])).toEqual([[admitted.runId, false]])
      expect(lifecycleLockState(host).lockHeld).toBe(false)
      for (const run of [first, second]) lifecycleCredentials.assertNoLeak(lifecycleOutputs(host, run))
    })
  })

  // -------------------------------------------------------------------------
  // .S4: refusals before and after the build (second half)
  // -------------------------------------------------------------------------

  describe('refusals before and after the build', () => {
    /** Test data: docker's error when its daemon does not answer. */
    const DOCKER_DOWN_ERROR = 'Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?'
    /** Test data: npm's last error line. */
    const NPM_ERROR_LINE = 'npm error e13 pack failure (test data)'
    /** Test data: the volume read's error. */
    const VOLUME_ERROR = 'e13 volume read failure (test data)'
    /** Each step's events, as the passing run makes them: a refusal at a step leaves exactly the events up to it. */
    const UP_TO = {
      dockerCheck: ['version'],
      baseCheck: ['version', 'image-inspect'],
      packing: ['version', 'image-inspect', 'npm'],
      lock: ['version', 'image-inspect', 'npm', 'password'],
      readings: ['version', 'image-inspect', 'npm', 'password', 'container-list', 'image-list', 'image-list', 'volume'],
      admission: ['version', 'image-inspect', 'npm', 'password', 'container-list', 'image-list', 'image-list', 'volume', 'container-list'],
    } as const

    /** One refusal before the build: how the host and run are made, the events up to it, and the refusal (computed by the runner's own builders, or only its kind, the rest read from the run's own files). */
    interface BeforeBuildRow {
      readonly host?: LifecycleHostOptions
      readonly run?: (host: LifecycleHost) => LifecycleRunOptions
      readonly events: readonly string[]
      readonly refusal: (host: LifecycleHost, run: LifecycleRun) => e13.Refusal | e13.RefusalKind
      /** The lock is held by someone else throughout. */
      readonly lockHeldByOther?: boolean
      /** `package/` exists: packing started. */
      readonly packed?: boolean
      readonly setup?: (host: LifecycleHost) => void
    }

    const passwordText = (host: LifecycleHost, which: lifecycleHelper.PasswordFileCase): string => lifecycleHelper.passwordFileCases(UID, host.home)[which].text
    const BEFORE_BUILD: readonly (readonly [string, BeforeBuildRow])[] = [
      ['step 3: docker not answering', { setup: (host) => host.docker.fail('version', { stderr: DOCKER_DOWN_ERROR }), events: UP_TO.dockerCheck, refusal: () => e13.dockerDownRefusal(DOCKER_DOWN_ERROR) }],
      [
        'step 4: a missing base without its build\'s prerequisites',
        {
          run: () => ({ baseMissing: true, env: { [e13.AD_SOURCE_DIR_VARIABLE]: undefined } }),
          events: UP_TO.baseCheck,
          refusal: (_host, run) => {
            const image = e13.readBaseImageName(run.worktree.root)
            const adVersion = lifecycleFs.readFileSync(run.worktree.baseDockerfilePath, 'utf-8').split('\n').find((line) => line.startsWith(e13.AD_VERSION_ARG_PREFIX))!.slice(e13.AD_VERSION_ARG_PREFIX.length)
            return e13.buildRefusal(null, e13.adSourceDirUnsetReason(image.ok ? image.name : '', `${e13.AD_TAG_PREFIX}${adVersion}`))
          },
        },
      ],
      [
        'step 5: npm pack failing',
        { run: () => ({ npmPack: { exitCode: 1, stderr: `npm error code E13\n${NPM_ERROR_LINE}\n` } }), events: UP_TO.packing, packed: true, refusal: () => e13.buildRefusal(null, e13.npmPackFailedReason(1, NPM_ERROR_LINE)) },
      ],
      [
        'step 6: no password-file entry for the user ID',
        {
          run: (host) => ({ passwordText: passwordText(host, 'no-line') }),
          events: UP_TO.lock,
          packed: true,
          refusal: (host) => {
            const resolved = e13.resolveAccountHome({ uid: UID, readPasswordFile: () => ({ ok: true, value: passwordText(host, 'no-line') }) })
            if (resolved.ok) throw new Error('the no-line case resolved a home')
            return resolved.refusal
          },
        },
      ],
      [
        'step 6: the lock still busy after the 30 s wait',
        {
          host: { lockDir: { lockFile: { holder: { runId: OTHER_RUN_ID, alive: true }, held: true } } },
          events: UP_TO.lock,
          packed: true,
          lockHeldByOther: true,
          refusal: (host) => e13.busyLockRefusal(host.lockBuild.holder),
        },
      ],
      [
        'step 8: the volume reading failing',
        {
          host: { volume: { error: VOLUME_ERROR } },
          events: UP_TO.readings,
          packed: true,
          refusal: (host, run) => {
            const reading = e13.readRunVolume({ readVolume: host.readings.volume.readVolume }, run.runDir)
            if (reading.ok) throw new Error('the failing volume was read')
            return e13.failedReadingRefusal(reading)
          },
        },
      ],
      ['step 9: the disk', { host: { volume: { mountPoint: '/e13-volume', usedGib: 199, availableGib: 1 } }, events: UP_TO.admission, packed: true, refusal: () => 'disk' }],
      ['step 9: memory', { host: { pod: { limitGib: 64, workingSetGib: 52, anonGib: 52, activeFileGib: 0 } }, events: UP_TO.admission, packed: true, refusal: () => 'memory' }],
      [
        'step 9: CPU, another live run holding the 12 CI CPUs',
        { host: { lockDir: { reservations: [{ owner: { runId: OTHER_RUN_ID, alive: true }, shards: e13.MAX_SHARDS }] } }, events: UP_TO.admission, packed: true, refusal: () => 'cpu' },
      ],
    ]

    test.each(BEFORE_BUILD)('%s: no later step, nothing held or reserved, no build, listing or prune; the refused status written last, no verdict or results', async (_what, row) => {
      const host = lifecycleHost(row.host)
      row.setup?.(host)
      const run = host.run(row.run?.(host))
      expect(await lifecycleRunToEnd(host, run)).toBe(e13.REFUSAL_EXIT_STATUS)
      expect(lifecycleWhats(host, run)).toEqual([...row.events])
      const expected = row.refusal(host, run)
      const status = run.status()
      expect(status?.phase).toBe('refused')
      if (typeof expected === 'string' || expected === null) expect(status?.refusal?.kind).toBe(expected)
      else expect(status?.refusal).toEqual({ kind: expected.kind, summary: expected.summary, details: expected.details })
      const refusal = status!.refusal!
      expect(run.logLines().slice(-1 - refusal.details.length)).toEqual([e13.refusalLine(refusal), ...refusal.details])
      expect(lifecycleLockState(host).lockHeld).toBe(row.lockHeldByOther === true)
      expect(lifecycleLockState(host).reservations).not.toContain(e13.reservationFileName(run.owner))
      expect(lifecycleFs.readdirSync(run.runDir).sort()).toEqual([...(row.packed === true ? [e13.PACKAGE_DIR_NAME] : []), e13.RUNNER_LOG_FILE_NAME, e13.STATUS_FILE_NAME].sort())
      await lifecycleExpectNothingAfter(host, run)
      lifecycleCredentials.assertNoLeak(lifecycleOutputs(host, run))
    })

    /** The script the image lacks in the read-back difference row. */
    const MISSING_FROM_IMAGE = lifecycleHelper.realScriptFileName(7)
    const AFTER_BUILD: readonly (readonly [string, LifecycleRunOptions, (host: LifecycleHost) => void])[] = [
      ['the read-back finding a difference (a script missing from the image)', { pinnedArchive: (worktree) => lifecycleTestsArchive(worktree, MISSING_FROM_IMAGE) }, () => undefined],
      ['the read-back failing outright (its copy-out failing)', {}, (host) => host.docker.fail('container-copy')],
    ]

    test.each(AFTER_BUILD)('%s: the reservation released, the read container removed, then the image cleanup, the watchdog stopped; no shard starts; the refusal last', async (what, options, setup) => {
      const host = lifecycleHost()
      setup(host)
      const run = host.run(options)
      expect(await lifecycleRunToEnd(host, run)).toBe(e13.REFUSAL_EXIT_STATUS)
      const events = lifecycleEventsOf(host, run)
      const copy = lifecycleIndexOf(events, 'container-copy')
      // After the copy-out: the read-back's own removal, the refusal path's (finding it absent), the test tag, the untagged listing; nothing more.
      expect(events.slice(copy + 1).map((event) => event.what)).toEqual(['container-remove', 'container-remove', 'image-remove', 'image-list'])
      expect(events.slice(copy + 2).every((event) => event.reservations.length === 0 && !event.lockHeld)).toBe(true)
      expect(events.some((event) => event.what === 'container-run')).toBe(false)
      const refusal = run.status()?.refusal
      expect(run.status()?.phase).toBe('refused')
      expect(refusal?.kind).toBeNull()
      if (what.includes('difference')) expect(refusal?.summary).toContain(MISSING_FROM_IMAGE)
      expect(run.logLines().slice(-1 - refusal!.details.length)).toEqual([e13.refusalLine(refusal!), ...refusal!.details])
      expect(host.docker.images().some((image) => image.labels[e13.OWNER_LABEL] === e13.formatOwner(run.owner))).toBe(false)
      await lifecycleExpectNothingAfter(host, run)
      lifecycleCredentials.assertNoLeak(lifecycleOutputs(host, run))
    })

    test('an interrupt delivered while the read-back\'s refusal is being recorded changes nothing: status.json, runner.log and the events byte-identical to a twin run without it; no stop is logged, and nothing follows', async () => {
      const host = lifecycleHost()
      host.docker.fail('container-copy')
      let delivered = 0
      const run = host.run({
        onEvent: (event, self) => {
          if (event.what === 'image-remove') delivered = self.source.deliver('SIGINT')
        },
      })
      expect(await lifecycleRunToEnd(host, run)).toBe(e13.REFUSAL_EXIT_STATUS)
      expect(delivered).toBe(1)
      // The twin: its own host, the same RUN_ID and PID, the same copy-out failure, no interrupt.
      const twinHost = lifecycleHost()
      twinHost.docker.fail('container-copy')
      const twin = twinHost.run()
      expect(await lifecycleRunToEnd(twinHost, twin)).toBe(e13.REFUSAL_EXIT_STATUS)
      expect([twin.runId, twin.pid]).toEqual([run.runId, run.pid])
      const read = (of: LifecycleRun, name: string): string => lifecycleFs.readFileSync(lifecyclePath.join(of.runDir, name), 'utf-8')
      /** Text with its run's `mkdtemp` directories (the worktree, then the host's root) made placeholders, so the two hosts' paths compare equal. */
      const placeheld = (of: LifecycleHost, ran: LifecycleRun, text: string): string => text.replaceAll(ran.worktree.root, '<worktree>').replaceAll(of.root, '<host root>')
      expect(lifecycleFs.readdirSync(run.runDir).sort()).toEqual(lifecycleFs.readdirSync(twin.runDir).sort())
      expect(read(run, e13.STATUS_FILE_NAME)).toBe(read(twin, e13.STATUS_FILE_NAME))
      expect(placeheld(host, run, read(run, e13.RUNNER_LOG_FILE_NAME))).toBe(placeheld(twinHost, twin, read(twin, e13.RUNNER_LOG_FILE_NAME)))
      expect(placeheld(host, run, JSON.stringify(lifecycleEventsOf(host, run)))).toBe(placeheld(twinHost, twin, JSON.stringify(lifecycleEventsOf(twinHost, twin))))
      const refusal = run.status()?.refusal
      expect(run.status()?.phase).toBe('refused')
      expect(refusal?.kind).toBeNull()
      expect(run.logLines().some((line) => line.includes(e13.runLevelStopLine({ kind: 'interrupt', signal: 'SIGINT' })))).toBe(false)
      expect(run.logLines().slice(-1 - refusal!.details.length)).toEqual([e13.refusalLine(refusal!), ...refusal!.details])
      expect(lifecycleWhats(host, run).slice(lifecycleIndexOf(lifecycleEventsOf(host, run), 'image-remove'))).toEqual(['image-remove', 'image-list'])
      await lifecycleExpectNothingAfter(host, run)
      lifecycleCredentials.assertNoLeak(lifecycleOutputs(host, run))
    })
  })

  // -------------------------------------------------------------------------
  // .S5: the run deadline and its timer
  // -------------------------------------------------------------------------

  describe('the run deadline and its timer', () => {
    /** The process group the runner gave a spawn of `what`, and every signal sent to that group. */
    function groupSignals(host: LifecycleHost, run: LifecycleRun, what: string): { readonly processGroup: number; readonly signals: readonly lifecycleHelper.RecordedSignal[] } {
      const event = lifecycleEventsOf(host, run).find((candidate) => candidate.what === what)!
      const spawn = host.recorder.spawns().find((candidate) => candidate.argv.join('\0') === event.argv!.join('\0'))!
      const processGroup = spawn.processGroup!
      return { processGroup, signals: host.signals.signals().filter((signal) => signal.target.kind === 'group' && signal.target.processGroup === processGroup) }
    }

    test.each([
      ['a test build still running at start + B: the `build` form at the 30 min deadline', {}, 'image-build', false],
      ['a missing base\'s build-base step still running at start + B + 60 min: B became 90 min, written in phase build at once', { baseMissing: true, baseBuildStep: { untilSignalled: true } }, 'bash', true],
    ] satisfies [string, LifecycleRunOptions, string, boolean][])('%s; the build\'s group gets SIGKILL at that exact moment', async (_what, options, build, baseMissing) => {
      const host = lifecycleHost()
      const run = host.run({ ...options, testBuild: { kind: 'hangs' } })
      await lifecycleRunToEnd(host, run)
      const minutes = lifecycleDeadlineMinutes(baseMissing, null)
      expect(minutes).toBe(e13.BUILD_ALLOWANCE_MINUTES + (baseMissing ? e13.BASE_BUILD_ALLOWANCE_MINUTES : 0))
      const statuses = [lifecycleStatus(run, 'build', e13.BUILD_ALLOWANCE_MINUTES), ...(baseMissing ? [lifecycleStatus(run, 'build', minutes)] : []), lifecycleStatus(run, 'merge', minutes)]
      expect(lifecycleStatusesOf(run)).toEqual(statuses)
      expect(run.verdict()).toBe(e13.runDeadlineLine('build', minutes))
      expect(run.verdict()).toBe(e13.runLevelStopLine(e13.runDeadlineStop('build', minutes)))
      const { signals } = groupSignals(host, run, build)
      expect(signals.map((signal) => [signal.signal, signal.atMs])).toEqual([['SIGKILL', START_MS + minutes * MS_PER_MINUTE]])
      expect(lifecycleSampleTimes(host, run)).not.toContain(START_MS + minutes * MS_PER_MINUTE)
      lifecycleCredentials.assertNoLeak(lifecycleOutputs(host, run))
    })

    test('pin (contract example, typed here only): a shard still running past start + B + T + 15 min with T = 93.4 min gives the `shards` form, the 138.4 min deadline printed as 138', async () => {
      const host = lifecycleHost()
      // test-1 with test-2: 2352 s expected, so a limit of 93.4 min (T); test-1 with test-3 at the floor.
      const seconds: Readonly<Record<number, number>> = { 1: 52, 2: 2300, 3: 60 }
      const late = lifecycleHelper.realScriptFileName(2)
      const run = host.run({
        worktree: { scripts: [1, 2, 3].map((n) => lifecycleHelper.realScriptFileName(n)), durationTable: { kind: 'rows', header: e13.DURATION_TABLE_HEADER, rows: [1, 2, 3].map((n) => ({ script: n, seconds: seconds[n]! })) } },
        // Its `docker run` answers 50 min in, after B + 15, so its limit comes after the deadline.
        dockerRunDelayMs: (assigned) => (assigned.includes(late) ? 50 * MS_PER_MINUTE : 0),
        shard: (k) => (k === 1 ? { endsAfterMs: null } : {}),
      })
      await lifecycleRunToEnd(host, run)
      const results = run.results()!
      expect(lifecycleLargestLimitMs(results)).toBe(93.4 * MS_PER_MINUTE)
      const minutes = lifecycleDeadlineMinutes(false, lifecycleLargestLimitMs(results))
      expect(minutes).toBeCloseTo(138.4, 10)
      expect(run.verdict()).toBe('FAIL: run deadline: shards still running at the 138 min deadline')
      expect(run.verdict()).toBe(e13.runDeadlineLine('shards', minutes))
      expect(lifecycleStatusesOf(run)).toEqual([lifecycleStatus(run, 'build', e13.BUILD_ALLOWANCE_MINUTES), lifecycleStatus(run, 'shards', minutes), lifecycleStatus(run, 'merge', minutes)])
      expect(lifecycleStatusesOf(run)[1]!.deadline.minutes).toBe(138)
      const deadlineAt = START_MS + e13.runDeadlineOffset({ baseMissing: false, largestLimitMs: lifecycleLargestLimitMs(results) }).ms
      expect(lifecycleShardEvents(host, run, 1).find((event) => event.what === 'container-kill')?.atMs).toBe(deadlineAt)
      lifecycleCredentials.assertNoLeak(lifecycleOutputs(host, run))
    })

    test('a run whose end of run started before its shards were scheduled keeps start + B: the deadline passing during its image cleanup gives the `merge` form', async () => {
      const host = lifecycleHost()
      host.docker.setPruneDuration(40 * MS_PER_MINUTE)
      const run = host.run({ testBuild: { kind: 'failed', durationMs: BUILD_MS } })
      await lifecycleRunToEnd(host, run)
      expect(lifecycleStatusesOf(run)).toEqual([lifecycleStatus(run, 'build', e13.BUILD_ALLOWANCE_MINUTES), lifecycleStatus(run, 'merge', e13.BUILD_ALLOWANCE_MINUTES)])
      expect(run.verdict()).toBe(e13.runDeadlineLine('merge', e13.BUILD_ALLOWANCE_MINUTES))
      const prune = lifecycleEventsOf(host, run).find((event) => event.what === 'image-prune')!
      expect(prune.atMs).toBeLessThan(START_MS + e13.BUILD_ALLOWANCE_MINUTES * MS_PER_MINUTE)
      expect(run.results()?.failures.map((failure) => failure.line)).toContain(e13.testImageBuildFailedLine(1))
      lifecycleCredentials.assertNoLeak(lifecycleOutputs(host, run))
    })

    test('a deadline more than 2^31 − 1 ms away fires at its exact moment, never early: the timer is re-armed in steps, each within the runtime maximum and shorter than the wait, one at a time', async () => {
      // The stop hooks over a run-state record with only what the deadline reads and a stop writes, on a bare fake clock: a composed
      // run would have its watchdog sample every 30 s for the 25 days such a deadline lies away.
      /** The runtime's largest timer delay, 2^31 − 1 ms: a runtime fact, not a runner constant. */
      const MAX_TIMER_DELAY_MS = 2 ** 31 - 1
      const clock = lifecycleClock.createFakeClock({ start: START_MS })
      const source = lifecycleHelper.createSignalSource({ clock })
      const armed: LifecycleRunnerTimer[] = []
      const lines: string[] = []
      const state = e13.createInitialRunState()
      const seq = {
        deps: {
          clock: {
            now: () => clock.now(),
            setTimeout: (callback: () => void, delayMs: number) => {
              const handle = clock.setTimeout(callback, delayMs)
              armed.push({ handle, delayMs, atMs: clock.now() })
              return handle
            },
            clearTimeout: (handle: unknown) => clock.clearTimeout(handle),
          },
          onSignal: source.onSignal,
        },
        run: { basis: { runId: RUN_ID, pid: RUN_PID, startMs: START_MS, deadline: e13.statusDeadline(START_MS, e13.BUILD_ALLOWANCE_MINUTES) } },
        state,
        say: (line: string) => {
          lines.push(line)
        },
        schedule: null as { readonly largestLimitMs: number } | null,
        shards: [],
        waiters: [],
        controller: null,
        endOfRunStarted: false,
        refusalBeingRecorded: false,
        verdictRenamed: false,
        firstStopTiming: null,
      }
      const hooks = e13.createRunStopHooks()
      const sequence = seq as unknown as e13.RunSequence
      hooks.onSequenceStart?.(sequence)
      const largestLimitMs = 2 ** 31 + 12_345
      seq.schedule = { largestLimitMs }
      const scheduledFrom = armed.length
      hooks.onShardsScheduled?.(sequence, seq.schedule as unknown as e13.Schedule)
      const offset = e13.runDeadlineOffset({ baseMissing: false, largestLimitMs })
      const dueAt = START_MS + offset.ms
      expect(offset.ms).toBeGreaterThan(MAX_TIMER_DELAY_MS)
      /** The runner's timers still pending on the clock. */
      const pendingArmed = (): LifecycleRunnerTimer[] => {
        const pending = new Set(clock.pending().map((timer) => timer.id))
        return armed.filter((timer) => pending.has((timer.handle as lifecycleClock.FakeTimerHandle).id))
      }
      while (state.firstStop === null) {
        expect(clock.now()).toBeLessThan(dueAt)
        const pending = pendingArmed()
        expect(pending.length).toBeLessThanOrEqual(1)
        for (const timer of pending) expect(timer.delayMs).toBeLessThanOrEqual(MAX_TIMER_DELAY_MS)
        expect(await clock.runNext()).toBeGreaterThan(0)
      }
      expect(clock.now()).toBe(dueAt)
      expect(state.firstStop).toEqual(e13.runDeadlineStop('shards', offset.minutes))
      expect(seq.run.basis.deadline).toEqual(e13.statusDeadline(START_MS, offset.minutes))
      const steps = armed.slice(scheduledFrom)
      expect(steps.length).toBeGreaterThan(1)
      for (const step of steps) expect(step.delayMs).toBeLessThanOrEqual(MAX_TIMER_DELAY_MS)
      for (const step of steps) expect(step.delayMs).toBeLessThan(dueAt - step.atMs + 1)
      expect(steps[0]!.delayMs).toBeLessThan(offset.ms)
      expect(lines).toHaveLength(1)
      expect(lines[0]!.endsWith(e13.runDeadlineLine('shards', offset.minutes))).toBe(true)
      hooks.dispose()
      expect(source.handlerCount()).toBe(0)
      expect(clock.pendingCount()).toBe(0)
    })
  })

  // -------------------------------------------------------------------------
  // .S6: stops before the end of run
  // -------------------------------------------------------------------------

  describe('stops before the end of run: traps, the first stop, builds\' process groups and', () => {
    const interrupt = (signal: e13.TrappedSignal): e13.RunLevelStop => ({ kind: 'interrupt', signal })
    /** The pod with W above the stop line: 60 of its 64 GiB limit in use. */
    const HIGH_POD: lifecycleHelper.PodFigures = { limitGib: 64, workingSetGib: 60, anonGib: 60, activeFileGib: 0 }

    /** Rewrites the pod's cgroup files to `pod` at `atMs`, so the next sample reads it. */
    function podAt(host: LifecycleHost, pod: lifecycleHelper.PodFigures, atMs: number): void {
      host.clock.setTimeout(() => host.readings.cgroups.writePod('/', lifecycleHelper.podBytes(pod)), atMs - host.clock.now())
    }

    /** The memory watchdog's line for the high pod, with no shard running (the memory guard's builder). */
    function watchdogLineWithNoShards(): string {
      const bytes = lifecycleHelper.podBytes(HIGH_POD)
      const limit = lifecycleHelper.podBytes(DEFAULT_POD).maxBytes as number
      return e13.memoryWatchdogLine(bytes.workingSetBytes, e13.memoryCeiling(limit, []), [])
    }

    /** That every shard the stop found running had its final reading before its SIGKILL, and every shard not ended has the stop's cause. */
    function expectShardsStopped(host: LifecycleHost, run: LifecycleRun, stop: e13.RunLevelStop, notEnded: readonly number[]): void {
      const results = run.results()!
      for (const k of notEnded) {
        expect(results.shards[k - 1]!.end).toContain(e13.shardCauseText(e13.stoppedCauseOf(stop)))
        const whats = lifecycleShardEvents(host, run, k).map((event) => event.what)
        if (run.shardStarts.has(k)) expect(whats.indexOf('container-state')).toBeLessThan(whats.indexOf('container-kill'))
      }
    }

    test.each(e13.TRAPPED_SIGNALS.map((signal) => [signal]))('%s during the shards ends the run with FAIL: interrupted: <signal>: each running shard read, then killed, with the stop\'s cause; the end of run from step 1; the traps removed', async (signal) => {
      const host = lifecycleHost()
      const run = host.run({ shard: () => ({ endsAfterMs: null }) })
      run.source.deliverAt(signal, START_MS + 40_000)
      expect(await lifecycleRunToEnd(host, run)).toBe(e13.VERDICT_WRITTEN_EXIT_STATUS)
      expect(run.verdict()).toBe(e13.runLevelStopLine(interrupt(signal)))
      expectShardsStopped(host, run, interrupt(signal), [1, 2, 3, 4, 5, 6])
      expect(run.status()?.phase).toBe('merge')
      expect(run.results()?.failures[0]?.line).toBe(run.verdict()!)
      await lifecycleExpectNothingAfter(host, run)
      lifecycleCredentials.assertNoLeak(lifecycleOutputs(host, run))
    })

    test.each([
      ['a valid run: the held signal is recorded once the sequence starts, so no step runs', [] as string[]],
      ['an invalid run: the validation refusal drops it', ['--shards', '7']],
    ])('a signal delivered during validation, with %s', async (what, args) => {
      const host = lifecycleHost()
      const run = host.run({ args })
      const exit = await lifecycleRunToEnd(host, run, { onRunLog: () => void run.source.deliver('SIGTERM') })
      expect(run.source.delivered().map((delivery) => delivery.handlers)).toEqual([1])
      expect(lifecycleWhats(host, run)).toEqual([])
      if (what.startsWith('a valid')) {
        expect(exit).toBe(e13.VERDICT_WRITTEN_EXIT_STATUS)
        expect(run.verdict()).toBe(e13.runLevelStopLine(interrupt('SIGTERM')))
        expect(run.results()?.shardCount.reasons).toEqual([e13.ENDED_BEFORE_ADMISSION_REASON])
      } else {
        expect(exit).toBe(e13.REFUSAL_EXIT_STATUS)
        expect(run.status()?.refusal).toEqual({ kind: null, summary: e13.outOfRangeReason('--shards', '7'), details: [] })
        expect(run.logLines().some((line) => line.includes(e13.runLevelStopLine(interrupt('SIGTERM'))))).toBe(false)
      }
      await lifecycleExpectNothingAfter(host, run)
      lifecycleCredentials.assertNoLeak(lifecycleOutputs(host, run))
    })

    /** One first stop and how it is made, then a second stop delivered during the end of run's image cleanup. */
    const FIRST_STOPS: readonly (readonly [string, LifecycleRunOptions, (host: LifecycleHost, run: LifecycleRun) => void, () => string])[] = [
      ['an interrupt', { shard: () => ({ endsAfterMs: null }) }, (_host, run) => run.source.deliverAt('SIGINT', START_MS + 40_000), () => e13.runLevelStopLine(interrupt('SIGINT'))],
      ['the run deadline', { testBuild: { kind: 'hangs' } }, () => undefined, () => e13.runDeadlineLine('build', e13.BUILD_ALLOWANCE_MINUTES)],
      ['the memory watchdog', { testBuild: { kind: 'hangs' } }, (host) => podAt(host, HIGH_POD, START_MS + 10_000), watchdogLineWithNoShards],
    ]

    test.each(FIRST_STOPS)('the first stop wins: %s first; an interrupt during the end of run changes nothing and logs nothing', async (_what, options, makeFirst, firstLine) => {
      const host = lifecycleHost()
      let second = -1
      const run = host.run({
        ...options,
        onEvent: (event, self) => {
          if (event.what === 'image-remove') second = self.source.deliver('SIGHUP')
        },
      })
      makeFirst(host, run)
      await lifecycleRunToEnd(host, run)
      expect(second).toBe(1)
      expect(run.verdict()).toBe(firstLine())
      const stopLines = run.logLines().filter((line) => line.endsWith(firstLine()) || line.endsWith(e13.runLevelStopLine(interrupt('SIGHUP'))))
      expect(stopLines).toHaveLength(1)
      expect(stopLines[0]!.endsWith(firstLine())).toBe(true)
      lifecycleCredentials.assertNoLeak(lifecycleOutputs(host, run))
    })

    test('a stop during admission, the lock held: the lock released, no reservation, the run ended through the end of run in phase merge, `shards: 0 of 6 (ended before admission)`', async () => {
      const host = lifecycleHost()
      const run = host.run({
        onEvent: (event, self) => {
          if (event.what === 'container-list' && event.lockHeld && self.source.delivered().length === 0) self.source.deliver('SIGTERM')
        },
      })
      expect(await lifecycleRunToEnd(host, run)).toBe(e13.VERDICT_WRITTEN_EXIT_STATUS)
      // The sweep in progress ends; no reading follows.
      expect(lifecycleWhats(host, run)).toEqual(['version', 'image-inspect', 'npm', 'password', 'container-list', 'image-list', 'image-list'])
      expect(lifecycleLockState(host)).toEqual({ lockHeld: false, lockRecord: e13.formatLockHolder(run.owner), reservations: [], reservedCpus: 0 })
      expect(host.timeline.every((event) => event.reservations.length === 0)).toBe(true)
      expect(lifecycleStatusesOf(run).map((status) => status.phase)).toEqual(['build', 'merge'])
      expect(run.verdict()).toBe(e13.runLevelStopLine(interrupt('SIGTERM')))
      const results = run.results()!
      expect([results.shardCount.admitted, results.shardCount.started, results.shardCount.reasons]).toEqual([0, 0, [e13.ENDED_BEFORE_ADMISSION_REASON]])
      expect(lifecycleFs.readFileSync(lifecyclePath.join(run.runDir, e13.SUMMARY_FILE_NAME), 'utf-8')).toContain(e13.endedBeforeAdmissionShardCountLine(e13.MAX_SHARDS))
      lifecycleCredentials.assertNoLeak(lifecycleOutputs(host, run))
    })

    test('every build, the base-build step, the test build and the drift and retag builds, is spawned in a process group of its own', async () => {
      const host = lifecycleHost()
      const run = host.run({ baseMissing: true, args: ['--inject', e13.faultText({ kind: 'image-drift', shard: 1 }), '--inject', e13.faultText({ kind: 'retag' })] })
      await lifecycleRunToEnd(host, run)
      const builds = lifecycleEventsOf(host, run).filter((event) => event.what === 'bash' || event.what === 'image-build')
      expect(builds.map((event) => event.what)).toEqual(['bash', 'image-build', 'image-build', 'image-build'])
      for (const event of builds) {
        const spawn = host.recorder.spawns().find((candidate) => candidate.argv.join('\0') === event.argv!.join('\0'))!
        expect([spawn.ownProcessGroup, spawn.processGroup]).toEqual([true, spawn.pid])
      }
      lifecycleCredentials.assertNoLeak(lifecycleOutputs(host, run))
    })

    test.each([
      ['the base-build step', { baseMissing: true, baseBuildStep: { untilSignalled: true } }, 'bash'],
      ['the test build', { testBuild: { kind: 'hangs' } }, 'image-build'],
    ] satisfies [string, LifecycleRunOptions, string][])('a stop during %s sends SIGKILL to its whole process group, writes no image-build failure, and cleanup leaves no run tag or untagged image', async (_what, options, build) => {
      const host = lifecycleHost()
      const run = host.run({
        ...options,
        onEvent: (event, self) => {
          if (event.what === build) self.source.deliverAt('SIGINT', event.atMs + 5_000)
        },
      })
      await lifecycleRunToEnd(host, run)
      const event = lifecycleEventsOf(host, run).find((candidate) => candidate.what === build)!
      const spawn = host.recorder.spawns().find((candidate) => candidate.argv.join('\0') === event.argv!.join('\0'))!
      expect(host.signals.signals().map((signal) => [signal.target, signal.signal, signal.atMs])).toEqual([[{ kind: 'group', processGroup: spawn.processGroup! }, 'SIGKILL', event.atMs + 5_000]])
      expect(run.verdict()).toBe(e13.runLevelStopLine(interrupt('SIGINT')))
      const killed = lifecycleHelper.signalExitStatus('SIGKILL')
      const lines = [...run.results()!.failures.map((failure) => failure.line), ...run.logLines()]
      expect(lines.filter((line) => line.includes(e13.baseImageBuildFailedLine(killed)) || line.includes(e13.testImageBuildFailedLine(killed)))).toEqual([])
      expect(host.docker.images().filter((image) => image.labels[e13.OWNER_LABEL] === e13.formatOwner(run.owner) || image.tags.some((tag) => e13.parseRunTag(tag) !== null))).toEqual([])
      lifecycleCredentials.assertNoLeak(lifecycleOutputs(host, run))
    })

    test('a stop during the shard starts: the running shards read before SIGKILL, a shard not yet created takes the stop\'s cause too', async () => {
      const host = lifecycleHost()
      // Shard 5's `docker run` answers a minute late; the interrupt comes meanwhile, so shard 6 is never created.
      const delayed = lifecycleHelper.realScriptFileName(6)
      const run = host.run({ shard: () => ({ endsAfterMs: null }), dockerRunDelayMs: (assigned) => (assigned.includes(delayed) ? MS_PER_MINUTE : 0) })
      run.source.deliverAt('SIGINT', START_MS + 40_000)
      await lifecycleRunToEnd(host, run)
      const notCreated = [1, 2, 3, 4, 5, 6].filter((k) => !run.shardStarts.has(k))
      expect(notCreated).toHaveLength(1)
      expect(run.results()!.shards[notCreated[0]! - 1]!.seconds).toBeNull()
      expectShardsStopped(host, run, interrupt('SIGINT'), [1, 2, 3, 4, 5, 6])
      expect(host.docker.containers().filter((container) => container.labels[e13.OWNER_LABEL] === e13.formatOwner(run.owner))).toEqual([])
      lifecycleCredentials.assertNoLeak(lifecycleOutputs(host, run))
    })

    test('during the shards: the watchdog\'s line is the verdict, naming the shards; every shard removed and the reservation released', async () => {
      const host = lifecycleHost()
      const run = host.run({ shard: () => ({ endsAfterMs: null }) })
      podAt(host, HIGH_POD, START_MS + 50_000)
      await lifecycleRunToEnd(host, run)
      const noShards = watchdogLineWithNoShards()
      const verdict = run.verdict()!
      expect(verdict.startsWith(noShards.split(e13.NO_SHARDS_RUNNING_TEXT)[0]!)).toBe(true)
      for (let k = 1; k <= e13.MAX_SHARDS; k++) expect(verdict).toContain(`${e13.SHARD_DIR_PREFIX}${k}`)
      expect(run.logLines().filter((line) => line.endsWith(verdict))).toHaveLength(1)
      expectShardsStopped(host, run, { kind: 'memory-watchdog', line: verdict }, [1, 2, 3, 4, 5, 6])
      expect(host.docker.containers()).toEqual([])
      expect(lifecycleLockState(host).reservations).toEqual([])
      lifecycleCredentials.assertNoLeak(lifecycleOutputs(host, run))
    })

    test('during the build: the line says no shards running; schedule-coverage and fault-fired are skipped and named in the summary', async () => {
      const host = lifecycleHost()
      const run = host.run({ testBuild: { kind: 'hangs' } })
      podAt(host, HIGH_POD, START_MS + 10_000)
      await lifecycleRunToEnd(host, run)
      expect(run.verdict()).toBe(watchdogLineWithNoShards())
      expect(run.verdict()!.endsWith(`${e13.NO_SHARDS_RUNNING_TEXT}; reclaimable page cache excluded)`)).toBe(true)
      const skipped: e13.IntegrityCheck[] = ['fault-fired', 'schedule-coverage']
      const results = run.results()!
      for (const check of skipped) expect(results.skippedChecks).toContain(check)
      const summary = lifecycleFs.readFileSync(lifecyclePath.join(run.runDir, e13.SUMMARY_FILE_NAME), 'utf-8')
      for (const check of skipped) expect(summary).toContain(check)
      expect(lifecycleLockState(host).reservations).toEqual([])
      lifecycleCredentials.assertNoLeak(lifecycleOutputs(host, run))
    })

    test('SIGINT with test-23 in progress: FAIL: interrupted: SIGINT, test-23 stopped by interrupt in its shard, and no container-exited cause from the stop\'s SIGKILL', async () => {
      const host = lifecycleHost()
      const testOne = lifecycleHelper.realScriptFileName(1)
      const test23 = lifecycleHelper.realScriptFileName(23)
      const run = host.run({
        worktree: { scripts: [testOne, test23], durationTable: lifecycleDurationTable([1, 23]) },
        shard: () => ({
          inProgress: () => [
            { kind: e13.RESULT_WORD_START, fileName: testOne },
            { kind: e13.RESULT_WORD_END, fileName: testOne, result: e13.RESULT_WORD_PASS, seconds: SCRIPT_SECONDS },
            { kind: e13.RESULT_WORD_START, fileName: test23 },
          ],
          endsAfterMs: null,
        }),
      })
      run.source.deliverAt('SIGINT', START_MS + 60_000)
      await lifecycleRunToEnd(host, run)
      expect(run.verdict()).toBe(e13.runLevelStopLine(interrupt('SIGINT')))
      const stopped = e13.scriptEndLine(test23, 1, e13.stoppedCauseOf(interrupt('SIGINT')))
      const results = run.results()!
      expect(results.shards[0]!.end).toBe(stopped)
      expect(results.failures.map((failure) => failure.line)).toContain(stopped)
      const exited = e13.containerExitedCauseText(lifecycleHelper.signalExitStatus('SIGKILL'))
      expect(JSON.stringify(results).includes(exited)).toBe(false)
      lifecycleCredentials.assertNoLeak(lifecycleOutputs(host, run))
    })
  })

  // -------------------------------------------------------------------------
  // .S7: stops during the end of run and after the verdict
  // -------------------------------------------------------------------------

  describe('stops during the end of run and after the verdict', () => {
    const SIGINT_STOP: e13.RunLevelStop = { kind: 'interrupt', signal: 'SIGINT' }
    const END_OF_RUN_STEPS: readonly e13.EndOfRunStep[] = ['final-readings', 'integrity', 'cleanup', 'watchdog-stop', 'results', 'verdict']

    /** The shard whose container fails to start, so step 1 retires it (its created container) with the stop already recorded or landing. */
    const FAILS_TO_START = 3

    test.each(END_OF_RUN_STEPS.map((step, i) => [i + 1, step] as const))('an interrupt as end-of-run step %i (%s) begins: the sequence carries on, no cause changes (the shard that failed to start keeps its start failure), no check is skipped, status.json stays as written at the merge switch, and the stop line is the verdict and a listed failure', async (_n, target) => {
      const host = lifecycleHost()
      const run = host.run({ shard: (k) => (k === FAILS_TO_START ? { failsToStart: true } : {}) })
      const entered: e13.EndOfRunStep[] = []
      let atVerdictStep: { results: string; summary: string } | null = null
      const read = (name: string): string => lifecycleFs.readFileSync(lifecyclePath.join(run.runDir, name), 'utf-8')
      const [exit] = await lifecycleSettle(host, [run], [
        run.sequence({
          onEndOfRunStep: (_seq, step) => {
            entered.push(step)
            if (step === 'verdict') atVerdictStep = { results: read(e13.RESULTS_FILE_NAME), summary: read(e13.SUMMARY_FILE_NAME) }
            if (step === target) expect(run.source.deliver('SIGINT')).toBe(1)
          },
        }),
      ])
      expect(exit).toBe(e13.VERDICT_WRITTEN_EXIT_STATUS)
      expect(entered).toEqual([...END_OF_RUN_STEPS])
      const line = e13.runLevelStopLine(SIGINT_STOP)
      expect(run.verdict()).toBe(line)
      const results = run.results()!
      expect(results.verdict).toBe(line)
      expect(results.failures).toContainEqual({ line, shard: null })
      expect(lifecycleFs.readFileSync(lifecyclePath.join(run.runDir, e13.SUMMARY_FILE_NAME), 'utf-8')).toContain(line)
      const ends = results.shards.map((shard) => shard.end)
      expect(ends.filter((_end, i) => i !== FAILS_TO_START - 1)).toEqual(Array<string>(e13.MAX_SHARDS - 1).fill(e13.NORMAL_SHARD_END))
      expect(ends[FAILS_TO_START - 1]).toContain(e13.containerFailedToStartCauseText(''))
      expect(ends[FAILS_TO_START - 1]).not.toContain(e13.shardCauseText(e13.stoppedCauseOf(SIGINT_STOP)))
      expect(run.shardStarts.has(FAILS_TO_START)).toBe(false)
      expect(results.skippedChecks).toEqual([])
      // No restart: one merge write, each shard retired once, the images cleaned once.
      expect(lifecycleStatusesOf(run).map((status) => status.phase)).toEqual(['build', 'shards', 'merge'])
      expect(lifecycleFs.readFileSync(lifecyclePath.join(run.runDir, e13.STATUS_FILE_NAME), 'utf-8')).toBe(run.statuses.at(-1)!)
      for (let k = 1; k <= e13.MAX_SHARDS; k++) expect(lifecycleShardEvents(host, run, k).filter((event) => event.what === 'container-remove')).toHaveLength(1)
      expect(lifecycleWhats(host, run).filter((what) => what === 'image-remove')).toHaveLength(1)
      // A stop after step 5 wrote both files: they were written again before the verdict, now with the stop line.
      if (target === 'verdict') {
        const before = atVerdictStep as { results: string; summary: string } | null
        expect(before?.results).toContain(e13.containerFailedToStartCauseText(''))
        expect(before?.results).not.toContain(line)
        expect(before?.summary).not.toContain(line)
      }
      await lifecycleExpectNothingAfter(host, run)
      lifecycleCredentials.assertNoLeak(lifecycleOutputs(host, run))
    })

    test('an interrupt after the verdict\'s rename changes nothing: every file byte-identical and no operation follows', async () => {
      const host = lifecycleHost()
      const run = host.run()
      let atEnd: ReturnType<typeof lifecycleTreeSnapshot> | null = null
      let events = -1
      const [exit] = await lifecycleSettle(host, [run], [
        run.sequence({
          onSequenceEnd: () => {
            atEnd = lifecycleTreeSnapshot(run.runDir, { extended: true })
            events = host.timeline.length
            expect(run.source.deliver('SIGINT')).toBe(1)
          },
        }),
      ])
      expect(exit).toBe(e13.VERDICT_WRITTEN_EXIT_STATUS)
      expect(run.verdict()).toBe(e13.PASS_VERDICT)
      expect(lifecycleTreeSnapshot(run.runDir, { extended: true })).toEqual(atEnd!)
      expect(host.timeline.length).toBe(events)
      expect(run.logLines().some((line) => line.includes(e13.runLevelStopLine(SIGINT_STOP)))).toBe(false)
      await lifecycleExpectNothingAfter(host, run)
      lifecycleCredentials.assertNoLeak(lifecycleOutputs(host, run))
    })
  })

  // -------------------------------------------------------------------------
  // .S8: the end-of-run order, the writers runner half, cleanup on every outcome
  // -------------------------------------------------------------------------

  /** This run's leftovers on the host: its containers, the images carrying its run-private tags or its owner label, and its reservation. */
  function lifecycleLeftovers(host: LifecycleHost, run: LifecycleRun): { containers: string[]; images: string[]; reservations: string[] } {
    const owner = e13.formatOwner(run.owner)
    return {
      containers: host.docker.containers().filter((container) => container.labels[e13.OWNER_LABEL] === owner).map((container) => container.name),
      images: host.docker
        .images()
        .filter((image) => image.labels[e13.OWNER_LABEL] === owner || image.tags.some((tag) => e13.parseRunTag(tag) !== null && e13.formatOwner(e13.parseRunTag(tag)!.owner) === owner))
        .map((image) => image.id),
      reservations: lifecycleLockState(host).reservations.filter((name) => name === e13.reservationFileName(run.owner)),
    }
  }

  const NO_LEFTOVERS = { containers: [], images: [], reservations: [] }

  describe('the end of run: its order, its writers runner half and cleanup on every outcome', () => {
    test('the six steps in order, from one timeline: merge and the remaining shards retired, the read container removed; the checks once every docker.log exists; the reservation, then the images; the watchdog stopped and W read once more; the end files; the verdict last', async () => {
      const host = lifecycleHost()
      const run = host.run({ shard: (k) => (k === 3 ? { failsToStart: true } : {}) })
      const exists = (name: string): boolean => lifecycleFs.existsSync(lifecyclePath.join(run.runDir, name))
      const rootReads = (): number => host.readings.cgroups.reads().filter((read) => read.cgroupPath === '/').length
      const snapshots: Record<string, unknown>[] = []
      const take = (step: string): void => {
        const shardDirs = [1, 2, 3, 4, 5, 6].map((k) => e13.shardSubdirectoryPath(run.runDir, k))
        snapshots.push({
          step,
          phase: run.status()?.phase,
          containers: lifecycleLeftovers(host, run).containers.length,
          readContainer: host.docker.container(e13.readContainerName(run.owner)) !== null,
          dockerLogs: shardDirs.filter((dir) => lifecycleFs.existsSync(lifecyclePath.join(dir, e13.DOCKER_LOG_FILE_NAME))).length,
          reservation: lifecycleLeftovers(host, run).reservations.length,
          images: lifecycleLeftovers(host, run).images.length > 0,
          files: [e13.RESULTS_FILE_NAME, e13.SUMMARY_FILE_NAME, e13.VERDICT_FILE_NAME].filter(exists),
          rootReads: rootReads(),
          samples: host.timeline.filter((event) => event.what === 'container-list').length,
        })
      }
      const [exit] = await lifecycleSettle(host, [run], [run.sequence({ onEndOfRunStep: (_seq, step) => take(step) })])
      take('end')
      expect(exit).toBe(e13.VERDICT_WRITTEN_EXIT_STATUS)
      const [finalReadings, integrity, cleanup, watchdogStop, results, verdict, end] = snapshots as Record<string, unknown>[]
      // Step 1 found shard 3's created container still there; by step 2 the phase is merge, every container is gone, every docker.log saved.
      expect(finalReadings).toMatchObject({ step: 'final-readings', phase: 'shards', containers: 1, readContainer: false, reservation: 1, images: true })
      expect(integrity).toMatchObject({ step: 'integrity', phase: 'merge', containers: 0, dockerLogs: e13.MAX_SHARDS, reservation: 1, images: true, files: [] })
      // Step 3: the reservation, then the images; step 4 finds both gone.
      expect(cleanup).toMatchObject({ step: 'cleanup', reservation: 1, images: true })
      expect(watchdogStop).toMatchObject({ step: 'watchdog-stop', reservation: 0, images: false, files: [] })
      // Step 4: no sample after it, one more W reading (its files read once each).
      expect(results).toMatchObject({ step: 'results', samples: (watchdogStop as { samples: number }).samples, files: [] })
      expect((results as { rootReads: number }).rootReads).toBeGreaterThan((watchdogStop as { rootReads: number }).rootReads)
      expect(end).toMatchObject({ rootReads: (results as { rootReads: number }).rootReads })
      // Steps 5 and 6: the end files, then the verdict last.
      expect(verdict).toMatchObject({ step: 'verdict', files: [e13.RESULTS_FILE_NAME, e13.SUMMARY_FILE_NAME] })
      expect(end).toMatchObject({ step: 'end', files: [e13.RESULTS_FILE_NAME, e13.SUMMARY_FILE_NAME, e13.VERDICT_FILE_NAME] })
      expect(run.results()?.workingSet.after).not.toBeNull()
      lifecycleCredentials.assertNoLeak(lifecycleOutputs(host, run))
    })

    test('the wiring: the controller finalized before the checks, so an injected fail: counts as fired; a planted key makes secret-scan the verdict, and no value reaches results.json, summary.txt, verdict.txt or the runner log', async () => {
      const host = lifecycleHost()
      const fault: e13.Fault = { kind: 'fail', script: e13.numberFormOf(2) }
      const run = host.run({
        args: ['--inject', e13.faultText(fault)],
        shard: (k) => (k === 2 ? { scriptLog: (fileName) => `${fileName}: printed ${SECRETS.key} by mistake\n` } : {}),
      })
      await lifecycleRunToEnd(host, run)
      const results = run.results()!
      expect(run.verdict()!.startsWith(`${e13.injectedVerdictPrefix([fault])}${e13.integrityFailure('secret-scan', '', null).line}`)).toBe(true)
      expect(results.failures.some((failure) => failure.line.includes(e13.STILL_DUE_FIRING_REASON))).toBe(false)
      expect(results.failures.some((failure) => failure.line.startsWith(e13.integrityFailure('fault-fired', '', null).line))).toBe(false)
      const file = (name: string): lifecycleCredentials.WrittenFile => lifecycleCredentials.writtenFile(lifecyclePath.join(run.runDir, name))
      lifecycleCredentials.assertNoLeak({
        results: file(e13.RESULTS_FILE_NAME),
        summary: file(e13.SUMMARY_FILE_NAME),
        verdict: file(e13.VERDICT_FILE_NAME),
        log: file(e13.RUNNER_LOG_FILE_NAME),
        status: file(e13.STATUS_FILE_NAME),
        stderr: run.stderr,
      })
    })

    test('after the verdict nothing is written: no temporary file is left, the run directory stays, and an hour later it is unchanged', async () => {
      const host = lifecycleHost()
      const run = host.run()
      await lifecycleRunToEnd(host, run)
      const names = [e13.STATUS_FILE_NAME, e13.RESULTS_FILE_NAME, e13.SUMMARY_FILE_NAME, e13.VERDICT_FILE_NAME]
      const entries = lifecycleFs.readdirSync(run.runDir)
      for (const name of names) expect(entries).not.toContain(e13.atomicTempFileName(name))
      await lifecycleExpectNothingAfter(host, run)
      expect(lifecycleFs.lstatSync(run.runDir).isDirectory()).toBe(true)
      lifecycleCredentials.assertNoLeak(lifecycleOutputs(host, run))
    })

    /** Each failing shard plan of the script-failure row: shard 1 ends with its second script failed. */
    const scriptFailure = (k: number): LifecycleShardPlan =>
      k === 1
        ? {
            finished: (assigned) => [
              ...lifecyclePassEvents(assigned.slice(0, 1)).slice(0, -1),
              { kind: e13.RESULT_WORD_START, fileName: assigned[1]! },
              { kind: e13.RESULT_WORD_END, fileName: assigned[1]!, result: e13.RESULT_WORD_FAIL, seconds: SCRIPT_SECONDS },
              { kind: e13.RESULT_WORD_DONE },
            ],
          }
        : {}
    const OUTCOMES: readonly (readonly [string, LifecycleRunOptions, (host: LifecycleHost, run: LifecycleRun) => void])[] = [
      ['a pass', {}, () => undefined],
      ['a script failure', { shard: scriptFailure }, () => undefined],
      ['an image-build failure', { testBuild: { kind: 'failed', durationMs: BUILD_MS } }, () => undefined],
      ['an interrupted run', { shard: () => ({ endsAfterMs: null }) }, (_host, run) => run.source.deliverAt('SIGTERM', START_MS + 40_000)],
      [
        'a watchdog stop',
        { shard: () => ({ endsAfterMs: null }) },
        (host) => host.clock.setTimeout(() => host.readings.cgroups.writePod('/', lifecycleHelper.podBytes({ limitGib: 64, workingSetGib: 60, anonGib: 60, activeFileGib: 0 })), 50_000),
      ],
    ]

    test.each(OUTCOMES)('%s releases the reservation and leaves no container, run-private tag or owner-labelled image', async (_what, options, arrange) => {
      const host = lifecycleHost()
      const run = host.run(options)
      arrange(host, run)
      expect(await lifecycleRunToEnd(host, run)).toBe(e13.VERDICT_WRITTEN_EXIT_STATUS)
      expect(lifecycleLeftovers(host, run)).toEqual(NO_LEFTOVERS)
      expect(run.verdict()).toBe(run.results()!.verdict)
      lifecycleCredentials.assertNoLeak(lifecycleOutputs(host, run))
    })
  })

  // -------------------------------------------------------------------------
  // Internal errors and guarded steps
  // -------------------------------------------------------------------------

  describe('internal errors and guarded steps: every way out ends in the verdict or the refusal', () => {
    /** Test data: the message of a dependency that throws. */
    const THROWN = 'e13 dependency failure (thrown)'
    const throwing = (): never => {
      throw new Error(THROWN)
    }

    /** The run's verdict for an internal error: result rendering's line over the run's own scripts. */
    function internalErrorVerdict(run: LifecycleRun, error: string): string {
      const parsed = e13.parseCiArguments([])
      if (!parsed.ok) throw new Error('no arguments did not parse')
      return e13.internalErrorVerdictLine(parsed.invocation, run.worktree.scriptFileNames, error)
    }

    test.each([
      ['the account\'s home lookup (step 6, before the lock)', { readPasswordFile: throwing }, ['version', 'image-inspect', 'npm', 'password'], false],
      ['the readings (step 8, under the lock)', { readVolume: throwing }, ['version', 'image-inspect', 'npm', 'password', 'container-list', 'image-list', 'image-list', 'volume'], true],
    ] satisfies [string, LifecycleRunOptions['deps'], string[], boolean][])('a throw in %s goes through the end of run: phase merge, `shards: 0 of 6 (ended before admission)`, the internal-error verdict, exit 0, the lock released, nothing left behind', async (_what, deps, events, locked) => {
      const host = lifecycleHost()
      const run = host.run({ deps })
      expect(await lifecycleRunToEnd(host, run)).toBe(e13.VERDICT_WRITTEN_EXIT_STATUS)
      expect(lifecycleWhats(host, run)).toEqual(events)
      expect(lifecycleStatusesOf(run).map((status) => status.phase)).toEqual(['build', 'merge'])
      expect(run.verdict()).toBe(internalErrorVerdict(run, THROWN))
      const results = run.results()!
      expect([results.shardCount.admitted, results.shardCount.reasons]).toEqual([0, [e13.ENDED_BEFORE_ADMISSION_REASON]])
      expect(lifecycleFs.readFileSync(lifecyclePath.join(run.runDir, e13.SUMMARY_FILE_NAME), 'utf-8')).toContain(e13.endedBeforeAdmissionShardCountLine(e13.MAX_SHARDS))
      expect(run.logLines().some((line) => line.includes(THROWN))).toBe(true)
      expect(lifecycleLockState(host).lockHeld).toBe(false)
      expect(lifecycleLockState(host).lockRecord).toBe(locked ? e13.formatLockHolder(run.owner) : null)
      expect(lifecycleLeftovers(host, run)).toEqual(NO_LEFTOVERS)
      await lifecycleExpectNothingAfter(host, run)
      lifecycleCredentials.assertNoLeak(lifecycleOutputs(host, run))
    })

    test('a throw after the reservation with a shard running (its limit timer failing to arm) goes through the end of run: that shard read, then killed; no later shard started; the reservation released, the watchdog stopped, the internal-error verdict, exit 0', async () => {
      const host = lifecycleHost()
      const failure = 'e13 timer failure'
      let firstRun: LifecycleEvent | null = null
      const run = host.run({
        shard: () => ({ endsAfterMs: null }),
        onEvent: (event, self) => {
          if (event.what !== 'container-run' || firstRun !== null) return
          firstRun = event
          // The first shard has started: its limit timer (its scripts at the default table's 60 s each), the next timer of that delay, fails to arm (once).
          const limitMs = e13.shardLimitMs(self.assigned.get(1)!.length * 60, null)
          let thrown = false
          self.faults.setTimeout = (delayMs) => {
            if (thrown || delayMs !== limitMs) return false
            thrown = true
            return true
          }
        },
      })
      expect(await lifecycleRunToEnd(host, run)).toBe(e13.VERDICT_WRITTEN_EXIT_STATUS)
      // The reservation was written and shard 1 the only one started when the throw came.
      const started = firstRun as LifecycleEvent | null
      expect(started?.reservations).toEqual([e13.reservationFileName(run.owner)])
      expect([...run.shardStarts.keys()]).toEqual([1])
      expect(lifecycleStatusesOf(run).map((status) => status.phase)).toEqual(['build', 'shards', 'merge'])
      expect(run.verdict()).toBe(internalErrorVerdict(run, failure))
      expect(run.logLines().some((line) => line.includes(failure))).toBe(true)
      // The running shard: its final reading (state inspect) before its SIGKILL, then removed.
      const whats = lifecycleShardEvents(host, run, 1).map((event) => event.what)
      expect(whats.indexOf('container-state')).toBeGreaterThan(-1)
      expect(whats.indexOf('container-state')).toBeLessThan(whats.indexOf('container-kill'))
      expect(whats.indexOf('container-kill')).toBeLessThan(whats.lastIndexOf('container-remove'))
      // Retired by the internal-error path, before the end of run (whose step 1 would retire it otherwise).
      const killRetirement = `${e13.SHARD_DIR_PREFIX}1: retired (kill)`
      expect(run.logLines().filter((line) => line.endsWith(killRetirement))).toHaveLength(1)
      const results = run.results()!
      expect(results.shardCount.admitted).toBe(e13.MAX_SHARDS)
      expect(results.shardCount.started).toBe(1)
      expect(lifecycleLeftovers(host, run)).toEqual(NO_LEFTOVERS)
      expect(lifecycleLockState(host).lockHeld).toBe(false)
      // The watchdog stopped: no runner timer pending.
      expect(run.pendingRunnerTimers()).toEqual([])
      await lifecycleExpectNothingAfter(host, run)
      lifecycleCredentials.assertNoLeak(lifecycleOutputs(host, run))
    })

    /** An untagged image carrying the run's owner label, as a build leaves layers, so the image cleanup lists and prunes. */
    function addOwnerLayer(host: LifecycleHost, owner: e13.Owner): void {
      host.docker.addImage({ labels: { [e13.OWNER_LABEL]: e13.formatOwner(owner) } })
    }

    /** Makes the run's own prune find another one running, so it waits to retry, and its clock fail that wait. */
    function failPruneRetry(host: LifecycleHost, run: LifecycleRun): void {
      host.docker.startOtherPrune({ durationMs: MS_PER_MINUTE, owner: 'e13-no-image-has-this-owner' })
      run.faults.setTimeout = (delayMs) => delayMs === e13.PRUNE_RETRY_INTERVAL_MS
    }

    test('a throw in one step of the refusal path is logged, the later steps still run, and the refusal is still recorded last', async () => {
      const host = lifecycleHost()
      host.docker.fail('container-copy')
      const run = host.run({
        onEvent: (event, self) => {
          if (event.what === 'container-copy') {
            addOwnerLayer(host, self.owner)
            failPruneRetry(host, self)
          }
        },
      })
      expect(await lifecycleRunToEnd(host, run)).toBe(e13.REFUSAL_EXIT_STATUS)
      const events = lifecycleEventsOf(host, run)
      expect(events.slice(lifecycleIndexOf(events, 'container-copy') + 1).map((event) => event.what)).toEqual(['container-remove', 'container-remove', 'image-remove', 'image-list', 'image-inspect', 'image-prune'])
      const refusal = run.status()!.refusal!
      const lines = run.logLines()
      expect(lines.findIndex((line) => line.includes('e13 timer failure'))).toBeGreaterThan(-1)
      expect(lines.slice(-1 - refusal.details.length)).toEqual([e13.refusalLine(refusal), ...refusal.details])
      // The watchdog's stop, after the failed step: its timer gone, no sample after.
      expect(run.pendingRunnerTimers()).toEqual([])
      expect(run.source.handlerCount()).toBe(0)
      lifecycleCredentials.assertNoLeak(lifecycleOutputs(host, run))
    })

    test.each([
      [
        'the end of run\'s image cleanup throws',
        (host: LifecycleHost, run: LifecycleRun): e13.RunSequenceHooks => {
          addOwnerLayer(host, run.owner)
          return { onEndOfRunStep: (_seq, step) => (step === 'cleanup' ? failPruneRetry(host, run) : undefined) }
        },
        (run: LifecycleRun) => run.results()!.verdict,
        'e13 timer failure',
      ],
      [
        'the watchdog\'s stop throws',
        (_host: LifecycleHost, run: LifecycleRun): e13.RunSequenceHooks => ({
          onEndOfRunStep: (_seq, step) => {
            if (step === 'watchdog-stop') run.faults.clearTimeout = (timer) => timer.delayMs === e13.SAMPLE_INTERVAL_MS
          },
        }),
        (run: LifecycleRun) => run.results()!.verdict,
        'e13 timer cancel failure',
      ],
      [
        'the end files\' composition throws, no stop recorded: the internal-error verdict',
        (_host: LifecycleHost, run: LifecycleRun): e13.RunSequenceHooks => ({
          onEndOfRunStep: (_seq, step) => {
            if (step === 'results') run.faults.nowThrows = 1
          },
        }),
        (run: LifecycleRun) => internalErrorVerdict(run, 'e13 clock read failure'),
        'e13 clock read failure',
      ],
      [
        'the end files\' composition throws after an interrupt: the fallback verdict names the stop',
        (_host: LifecycleHost, run: LifecycleRun): e13.RunSequenceHooks => {
          run.source.deliverAt('SIGINT', START_MS + 40_000)
          return {
            onEndOfRunStep: (_seq, step) => {
              if (step === 'results') run.faults.nowThrows = 1
            },
          }
        },
        () => e13.runLevelStopLine({ kind: 'interrupt', signal: 'SIGINT' }),
        'e13 clock read failure',
      ],
    ] satisfies [string, (host: LifecycleHost, run: LifecycleRun) => e13.RunSequenceHooks, (run: LifecycleRun) => string, string][])('%s: the throw is logged and verdict.txt is still written, exit 0', async (_what, arrange, verdict, logged) => {
      const host = lifecycleHost()
      const run = host.run()
      const [exit] = await lifecycleSettle(host, [run], [run.sequence(arrange(host, run))])
      expect(exit).toBe(e13.VERDICT_WRITTEN_EXIT_STATUS)
      expect(run.verdict()).toBe(verdict(run))
      expect(run.logLines().some((line) => line.includes(logged))).toBe(true)
      expect(run.source.handlerCount()).toBe(0)
      lifecycleCredentials.assertNoLeak(lifecycleOutputs(host, run))
    })
  })
})
