/**
 * ci-run-admission.test.ts — Tests for the sharded `/ci` runner's admission
 * (`scripts/ci-run.ts`; b.uqm SR-6, SR-21.6).
 *
 * One region per Epic that adds to this file, in this fixed order; each lane
 * writes only inside its own region (Plan b.t6s, "One runner file"):
 *
 *   E1 (t1.t6s.te): owners and liveness, labels and run-private tags, the
 *       reservation format and its names, and the lock probe E5 and E6 use;
 *   E5 (t1.t6s.ec): the admission lock, reservations and the sweep;
 *   E6 (t1.t6s.6s): the readings, `/ci-live` detection, the fits and the
 *       refusal messages.
 *
 * Isolation (b.uqm SR-21.7): every file a case touches sits under its own
 * `mkdtempSync` root, removed in `afterEach`. No case takes the real admission
 * lock, reads `.config/cscb-ci` in a real home, reads the host's `/proc` or
 * cgroup files, starts a child process or runs docker: processes come from
 * the fake process table (`tests/test-helpers/ci-run.ts`), and the lock probe
 * is tried only on a lock file inside the case's own root. No case
 * hand-writes a reservation (each is the runner's serializer's text, or that
 * text with one named change) or types a runner constant's value.
 *
 * SPDX-License-Identifier: MIT
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  CI_LABEL,
  CI_LABEL_VALUE,
  containerLabelOwner,
  CPUS_PER_SHARD,
  formatOwner,
  formatRunTag,
  imageLabelOwner,
  isOwnerAlive,
  isReservationFileName,
  isRunnerCommandLine,
  MAX_SHARDS,
  OPTION_RANGE_MIN,
  OWNER_LABEL,
  ownerLabel,
  parseOwner,
  parseReservation,
  parseRunTag,
  RESERVATION_FILE_SUFFIX,
  RESERVATION_FORMAT_VERSION,
  reservationFileName,
  reservationOwnerFromFileName,
  reservationTempFileName,
  RUN_TAG_REPOSITORY,
  RUN_TAG_ROLES,
  RUNNER_PATH_SUFFIX,
  serializeReservation,
  SHARD_MEMORY_CAP_BYTES,
  type LabelledOwner,
  type Owner,
  type Reservation,
  type RunKind,
} from '../scripts/ci-run.ts'
import {
  changedJsonText,
  ciLiveRunnerProcess,
  ciRunnerProcess,
  createProcessTable,
  holdFlock,
  otherProcess,
  probeFlock,
  type FakeProcessTable,
  type FlockHolder,
  type JsonFileChange,
} from './test-helpers/ci-run.ts'
import { treeSnapshot } from './test-helpers/tree-snapshot.ts'

// ---------------------------------------------------------------------------
// E1 (t1.t6s.te): owners, labels and run-private tags, the reservation format
// and its names, and the lock probe
// ---------------------------------------------------------------------------

describe('E1: owners, the reservation format and the lock probe', () => {
  /** Test data: a RUN_ID (its suffix holds no hyphen; the RUN_ID itself does) and another run's. */
  const RUN_ID = '20261008t120000z-abcd1234'
  const OTHER_RUN_ID = '20261008t120001z-wxyz5678'
  /** Test data: a RUN_ID of RUN_ID_PATTERN's shape naming no real moment (February 30). */
  const IMPOSSIBLE_RUN_ID = '20260230t120000z-abcd1234'
  /** Test data: SR-6.1's fixed name. */
  const LOCK_FILE_NAME = 'admission.lock'

  let root: string
  let processes: FakeProcessTable
  let holders: FlockHolder[]

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'ci-run-admission-'))
    processes = createProcessTable()
    holders = []
  })

  afterEach(() => {
    for (const holder of holders) holder.release()
    rmSync(root, { recursive: true, force: true })
  })

  /** A live `/ci` runner of `runId` in the process table, as its owner. */
  function liveOwner(runId = RUN_ID): Owner {
    return { runId, pid: processes.add(ciRunnerProcess(runId, { worktreeRoot: root })) }
  }

  /** An owner whose PID no process has. */
  function goneOwner(runId = OTHER_RUN_ID): Owner {
    return { runId, pid: processes.allocatePid() }
  }

  /** The runner path a command line holds, under the case's root (nothing is created there). */
  function runnerPath(): string {
    return join(root, RUNNER_PATH_SUFFIX)
  }

  // --- Owners (b.uqm Terms, SR-6.3) ---

  describe('owners, <RUN_ID>-<PID>', () => {
    test('an owner formats as <RUN_ID>-<PID> and parses back from the right, despite the RUN_ID\'s own hyphen', () => {
      const owner: Owner = { runId: RUN_ID, pid: 4242 }
      const text = formatOwner(owner)
      expect(text).toBe(`${RUN_ID}-4242`)
      expect(parseOwner(text)).toEqual(owner)
    })

    test('the owner label is <owner label>=<owner> and its value parses back to the owner', () => {
      const owner: Owner = { runId: RUN_ID, pid: 7 }
      const label = ownerLabel(owner)
      expect(label).toBe(`${OWNER_LABEL}=${formatOwner(owner)}`)
      expect(parseOwner(label.slice(OWNER_LABEL.length + 1))).toEqual(owner)
    })

    test.each([
      ['empty', ''],
      ['a RUN_ID alone', RUN_ID],
      ['a PID alone', '4242'],
      ['no PID after the hyphen', `${RUN_ID}-`],
      ['a PID of 0', `${RUN_ID}-0`],
      ['a PID with a leading zero', `${RUN_ID}-042`],
      ['a negative PID', `${RUN_ID}--1`],
      ['a PID that is not a whole number', `${RUN_ID}-1.5`],
      ['a PID with a letter', `${RUN_ID}-12a`],
      ['a PID with a trailing line feed', `${RUN_ID}-12\n`],
      ['a PID beyond a safe integer', `${RUN_ID}-99999999999999999999`],
      ['a RUN_ID in upper case', `${RUN_ID.toUpperCase()}-12`],
      ['a RUN_ID naming no real moment', `${IMPOSSIBLE_RUN_ID}-12`],
      ['a reservation file name, suffix and all', `${RUN_ID}-12${RESERVATION_FILE_SUFFIX}`],
    ])('a malformed owner is refused: %s', (_name, text) => {
      expect(parseOwner(text)).toBeNull()
    })
  })

  describe('liveness: an owner is alive only when its PID is live and runs the /ci runner with its RUN_ID next', () => {
    /** Each row builds its owner from the case's process table; true when SR-6.3 calls the owner alive. */
    const rows: [string, () => Owner, boolean][] = [
      ['a live /ci runner with the owner\'s RUN_ID', () => liveOwner(), true],
      [
        'a live /ci runner with more arguments after the RUN_ID',
        () => ({ runId: RUN_ID, pid: processes.add(ciRunnerProcess(RUN_ID, { worktreeRoot: root, args: ['--shards', String(MAX_SHARDS)] })) }),
        true,
      ],
      ['a live runner started by the relative runner path', () => ({ runId: RUN_ID, pid: processes.add(otherProcess(['bun', RUNNER_PATH_SUFFIX, RUN_ID])) }), true],
      ['a PID no process has', () => goneOwner(RUN_ID), false],
      [
        'a /ci runner that has gone',
        () => {
          const owner = liveOwner()
          processes.makeGone(owner.pid)
          return owner
        },
        false,
      ],
      [
        'a PID reused by another program',
        () => {
          const owner = liveOwner()
          processes.makeGone(owner.pid)
          processes.add(otherProcess(['sleep', '600'], { pid: owner.pid }))
          return owner
        },
        false,
      ],
      [
        'a PID reused by a /ci runner with another RUN_ID',
        () => {
          const owner = liveOwner()
          processes.makeGone(owner.pid)
          processes.add(ciRunnerProcess(OTHER_RUN_ID, { worktreeRoot: root, pid: owner.pid }))
          return owner
        },
        false,
      ],
      ['a live /ci runner with another RUN_ID, asked for this RUN_ID', () => ({ runId: RUN_ID, pid: liveOwner(OTHER_RUN_ID).pid }), false],
      ['a live /ci-live runner', () => ({ runId: RUN_ID, pid: processes.add(ciLiveRunnerProcess({ worktreeRoot: root, args: [RUN_ID] })) }), false],
      [
        'an argument between the runner path and the RUN_ID',
        () => ({ runId: RUN_ID, pid: processes.add(otherProcess(['bun', runnerPath(), `--shards=${OPTION_RANGE_MIN}`, RUN_ID])) }),
        false,
      ],
      ['the RUN_ID before the runner path', () => ({ runId: RUN_ID, pid: processes.add(otherProcess(['bun', RUN_ID, runnerPath()])) }), false],
      ['the runner path with nothing after it', () => ({ runId: RUN_ID, pid: processes.add(otherProcess(['bun', runnerPath()])) }), false],
      [
        'an argument that only holds the runner path, not ending in it',
        () => ({ runId: RUN_ID, pid: processes.add(otherProcess(['bun', `${runnerPath()}.bak`, RUN_ID])) }),
        false,
      ],
      [
        'a live /ci runner whose command line cannot be read',
        () => ({ runId: RUN_ID, pid: processes.add(ciRunnerProcess(RUN_ID, { worktreeRoot: root, unreadable: ['cmdline'] })) }),
        false,
      ],
    ]

    test.each(rows)('%s: alive is %p', (_name, build, alive) => {
      expect(isOwnerAlive(build(), processes.deps())).toBe(alive)
    })

    test('a command line is the runner\'s when any runner-path argument is followed by the RUN_ID, and only then', () => {
      const path = runnerPath()
      expect(isRunnerCommandLine(['bun', path, OTHER_RUN_ID, path, RUN_ID], RUN_ID)).toBe(true)
      expect(isRunnerCommandLine(['bun', path, OTHER_RUN_ID, RUN_ID], RUN_ID)).toBe(false)
      expect(isRunnerCommandLine([], RUN_ID)).toBe(false)
    })
  })

  describe('labels: a container\'s and an image\'s owner', () => {
    /** Each row gives the labels for a live and a gone owner, and the answer it expects for them. */
    type LabelRow = [string, (live: Owner, gone: Owner) => Record<string, string> | null, (live: Owner, gone: Owner) => LabelledOwner]

    const ciLabels = (owner?: string): Record<string, string> =>
      owner === undefined ? { [CI_LABEL]: CI_LABEL_VALUE } : { [CI_LABEL]: CI_LABEL_VALUE, [OWNER_LABEL]: owner }

    const containerRows: LabelRow[] = [
      ['a cscb-ci=1 container of a live owner', (live) => ciLabels(formatOwner(live)), (live) => ({ kind: 'alive', owner: live })],
      ['a cscb-ci=1 container of a dead owner', (_live, gone) => ciLabels(formatOwner(gone)), (_live, gone) => ({ kind: 'dead', owner: gone })],
      ['a cscb-ci=1 container without an owner label', () => ciLabels(), () => ({ kind: 'dead', owner: null })],
      ['a cscb-ci=1 container with an empty owner label', () => ciLabels(''), () => ({ kind: 'dead', owner: null })],
      ['a cscb-ci=1 container with a malformed owner label', () => ciLabels(RUN_ID), () => ({ kind: 'dead', owner: null })],
      ['a container without labels', () => null, () => ({ kind: 'no-run' })],
      ['a container with no label at all', () => ({}), () => ({ kind: 'no-run' })],
      ['a container with a live owner label but no cscb-ci label', (live) => ({ [OWNER_LABEL]: formatOwner(live) }), () => ({ kind: 'no-run' })],
      [
        'a container whose cscb-ci label has another value',
        (live) => ({ [CI_LABEL]: `${CI_LABEL_VALUE}0`, [OWNER_LABEL]: formatOwner(live) }),
        () => ({ kind: 'no-run' }),
      ],
    ]

    const imageRows: LabelRow[] = [
      ['an image of a live owner', (live) => ({ [OWNER_LABEL]: formatOwner(live) }), (live) => ({ kind: 'alive', owner: live })],
      ['an image of a dead owner', (_live, gone) => ({ [OWNER_LABEL]: formatOwner(gone) }), (_live, gone) => ({ kind: 'dead', owner: gone })],
      ['an image with an empty owner label', () => ({ [OWNER_LABEL]: '' }), () => ({ kind: 'dead', owner: null })],
      ['an image with a malformed owner label', () => ({ [OWNER_LABEL]: `${RUN_ID}-0` }), () => ({ kind: 'dead', owner: null })],
      ['an image without labels', () => null, () => ({ kind: 'no-run' })],
      ['an image with other labels only', () => ciLabels(), () => ({ kind: 'no-run' })],
    ]

    test.each(containerRows)('%s', (_name, labels, expected) => {
      const live = liveOwner()
      const gone = goneOwner()
      expect(containerLabelOwner(labels(live, gone), processes.deps())).toEqual(expected(live, gone))
    })

    test.each(imageRows)('%s', (_name, labels, expected) => {
      const live = liveOwner()
      const gone = goneOwner()
      expect(imageLabelOwner(labels(live, gone), processes.deps())).toEqual(expected(live, gone))
    })
  })

  describe('run-private tags, cscb-ci-run:<RUN_ID>-<PID>-<role>', () => {
    test.each(RUN_TAG_ROLES.map((role) => [role]))('a %s tag formats in the run-private shape and parses to its owner and role', (role) => {
      const owner: Owner = { runId: RUN_ID, pid: 4242 }
      const tag = formatRunTag(owner, role)
      expect(tag).toBe(`${RUN_TAG_REPOSITORY}:${formatOwner(owner)}-${role}`)
      expect(parseRunTag(tag)).toEqual({ owner, role })
    })

    test.each([
      ['the base tag', 'cscb-ci:latest'],
      ['the base image\'s tag', 'cscb-ci-base:v6'],
      ['/ci-live\'s tag', 'cscb-ci-live:latest'],
      ['a lane tag', 'cscb-ci-l5:m5'],
      ['another repository with the run-private tail', `${RUN_TAG_REPOSITORY}x:${RUN_ID}-12-${RUN_TAG_ROLES[0]}`],
      ['a repository with a registry in front', `registry.example/${RUN_TAG_REPOSITORY}:${RUN_ID}-12-${RUN_TAG_ROLES[0]}`],
      ['an unknown role', `${RUN_TAG_REPOSITORY}:${RUN_ID}-12-build`],
      ['a role in upper case', `${RUN_TAG_REPOSITORY}:${RUN_ID}-12-${RUN_TAG_ROLES[0].toUpperCase()}`],
      ['no role', `${RUN_TAG_REPOSITORY}:${RUN_ID}-12`],
      ['no PID', `${RUN_TAG_REPOSITORY}:${RUN_ID}-${RUN_TAG_ROLES[0]}`],
      ['a malformed PID', `${RUN_TAG_REPOSITORY}:${RUN_ID}-012-${RUN_TAG_ROLES[0]}`],
      ['a RUN_ID naming no real moment', `${RUN_TAG_REPOSITORY}:${IMPOSSIBLE_RUN_ID}-12-${RUN_TAG_ROLES[0]}`],
    ])('a tag of another shape is no run-private tag: %s', (_name, tag) => {
      expect(parseRunTag(tag)).toBeNull()
    })
  })

  // --- The reservation (b.uqm SR-6.2) ---

  /** A reservation of `shards` shards for `owner`, its figures from the runner's constants: N × the cap, 2 × N. */
  function reservationFor(owner: Owner, shards: number, kind: RunKind): Reservation {
    return {
      version: RESERVATION_FORMAT_VERSION,
      runId: owner.runId,
      pid: owner.pid,
      shards,
      memoryBytes: shards * SHARD_MEMORY_CAP_BYTES,
      cpus: shards * CPUS_PER_SHARD,
      kind,
    }
  }

  describe('reservation names, <RUN_ID>-<PID>.json', () => {
    const owner: Owner = { runId: RUN_ID, pid: 4242 }

    test('a reservation\'s name is its owner and the suffix, and names its owner back', () => {
      const name = reservationFileName(owner)
      expect(name).toBe(`${formatOwner(owner)}${RESERVATION_FILE_SUFFIX}`)
      expect(isReservationFileName(name)).toBe(true)
      expect(reservationOwnerFromFileName(name)).toEqual(owner)
    })

    test('the temporary file a reservation is written through is not a reservation name', () => {
      const temp = reservationTempFileName(owner)
      expect(temp).not.toBe(reservationFileName(owner))
      expect(isReservationFileName(temp)).toBe(false)
      expect(reservationOwnerFromFileName(temp)).toBeNull()
    })

    test.each([
      ['the lock file', () => LOCK_FILE_NAME],
      ['the owner without the suffix', () => formatOwner(owner)],
      ['the suffix in upper case', () => `${formatOwner(owner)}${RESERVATION_FILE_SUFFIX.toUpperCase()}`],
      ['a RUN_ID without a PID', () => `${RUN_ID}${RESERVATION_FILE_SUFFIX}`],
      ['a malformed PID', () => `${RUN_ID}-042${RESERVATION_FILE_SUFFIX}`],
      ['a RUN_ID naming no real moment', () => `${IMPOSSIBLE_RUN_ID}-12${RESERVATION_FILE_SUFFIX}`],
      ['an unrelated file', () => 'notes.txt'],
    ])('a name beside the lock that is no reservation name: %s', (_name, name) => {
      expect(isReservationFileName(name())).toBe(false)
      expect(reservationOwnerFromFileName(name())).toBeNull()
    })
  })

  describe('the reservation format', () => {
    const owner: Owner = { runId: RUN_ID, pid: 4242 }
    const validText = (): string => serializeReservation(reservationFor(owner, MAX_SHARDS, 'full'))

    test.each([['full' as RunKind], ['selective' as RunKind]])('a %s run\'s reservation serializes to exactly SR-6.2\'s keys, in order, and parses back', (kind) => {
      const reservation = reservationFor(owner, OPTION_RANGE_MIN, kind)
      const text = serializeReservation(reservation)
      expect(Object.keys(JSON.parse(text) as object)).toEqual(['version', 'runId', 'pid', 'shards', 'memoryBytes', 'cpus', 'kind'])
      expect(parseReservation(text)).toEqual({ ok: true, value: reservation })
    })

    test('the serializer refuses a reservation of another shape, so no reservation is written that its parser refuses', () => {
      const extra = { ...reservationFor(owner, MAX_SHARDS, 'full'), extra: true } as Reservation
      expect(() => serializeReservation(extra)).toThrow()
    })

    /** Each row: a named change to a valid reservation's text, and the key the parser's refusal names (null for none). */
    const refusals: [string, JsonFileChange, string | null][] = [
      ['unparseable content', { kind: 'unparseable' }, null],
      ['an array, not an object', { kind: 'edit', what: 'an array', edit: (valid) => `[${valid}]` }, null],
      ['another version', { kind: 'version', version: RESERVATION_FORMAT_VERSION + 1 }, 'version'],
      ['the version as a string', { kind: 'version', version: String(RESERVATION_FORMAT_VERSION) }, 'version'],
      ['an extra key', { kind: 'set-key', key: 'extra', value: 0 }, 'extra'],
      ['no version', { kind: 'drop-key', key: 'version' }, 'version'],
      ['no runId', { kind: 'drop-key', key: 'runId' }, 'runId'],
      ['no pid', { kind: 'drop-key', key: 'pid' }, 'pid'],
      ['no shards', { kind: 'drop-key', key: 'shards' }, 'shards'],
      ['no memoryBytes', { kind: 'drop-key', key: 'memoryBytes' }, 'memoryBytes'],
      ['no cpus', { kind: 'drop-key', key: 'cpus' }, 'cpus'],
      ['no kind', { kind: 'drop-key', key: 'kind' }, 'kind'],
      ['a runId that is a number', { kind: 'set-key', key: 'runId', value: 1 }, 'runId'],
      ['a runId that is no RUN_ID', { kind: 'set-key', key: 'runId', value: RUN_ID.toUpperCase() }, 'runId'],
      ['a runId naming no real moment', { kind: 'set-key', key: 'runId', value: IMPOSSIBLE_RUN_ID }, 'runId'],
      ['a pid that is a string', { kind: 'set-key', key: 'pid', value: String(owner.pid) }, 'pid'],
      ['a pid of 0', { kind: 'set-key', key: 'pid', value: 0 }, 'pid'],
      ['shards that are not a whole number', { kind: 'set-key', key: 'shards', value: 1.5 }, 'shards'],
      ['memoryBytes below 0', { kind: 'set-key', key: 'memoryBytes', value: -1 }, 'memoryBytes'],
      ['cpus that are a string', { kind: 'set-key', key: 'cpus', value: String(CPUS_PER_SHARD) }, 'cpus'],
      ['another kind', { kind: 'set-key', key: 'kind', value: 'injected' }, 'kind'],
    ]

    test.each(refusals)('a reservation with %s is refused', (_name, change, key) => {
      const parsed = parseReservation(changedJsonText(validText(), change))
      expect(parsed.ok).toBe(false)
      if (!parsed.ok && key !== null) expect(parsed.error).toContain(key)
    })
  })

  // --- The lock probe (tests/test-helpers/ci-run.ts, section 3), on a lock file in the case's root only ---

  describe('the lock probe', () => {
    /** A lock file in the case's own root, with some content and a mode of its own. */
    function makeLockFile(): string {
      const path = join(root, 'probe.lock')
      writeFileSync(path, `${formatOwner({ runId: RUN_ID, pid: 4242 })}\n`)
      chmodSync(path, 0o640)
      return path
    }

    function hold(path: string): FlockHolder {
      const holder = holdFlock(path)
      holders.push(holder)
      return holder
    }

    test('an unlocked file probes free, and the probe changes neither its content, its mode nor its times', () => {
      const path = makeLockFile()
      const before = treeSnapshot(root, { extended: true })
      expect(probeFlock(path)).toBe('free')
      expect(probeFlock(path)).toBe('free')
      expect(treeSnapshot(root, { extended: true })).toEqual(before)
    })

    test('a file probes held while a holder holds it and free after its release, the file unchanged throughout', () => {
      const path = makeLockFile()
      const before = treeSnapshot(root, { extended: true })
      const holder = hold(path)
      expect(probeFlock(path)).toBe('held')
      // The probe takes nothing: a second probe still finds the holder's lock.
      expect(probeFlock(path)).toBe('held')
      holder.release()
      expect(probeFlock(path)).toBe('free')
      expect(treeSnapshot(root, { extended: true })).toEqual(before)
    })

    test('a second holder is refused while the first holds the file, and takes it after the release', () => {
      const path = makeLockFile()
      const first = hold(path)
      expect(() => holdFlock(path)).toThrow()
      first.release()
      hold(path)
      expect(probeFlock(path)).toBe('held')
    })

    test('probing a missing file throws rather than answering free', () => {
      expect(() => probeFlock(join(root, 'missing.lock'))).toThrow()
    })
  })
})

// ---------------------------------------------------------------------------
// E5 (t1.t6s.ec): the admission lock, reservations and the sweep
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// E6 (t1.t6s.6s): the readings, /ci-live detection, the fits and the refusal
// messages
// ---------------------------------------------------------------------------
//
// Admission (b.uqm SR-6.5 to SR-6.8, SR-7.1, SR-7.2) and the runner's copies of
// `/ci-live`'s rules (SR-21.5), tested in process through the runner's injected
// dependencies. Every reading is constructed under the case's own
// `mkdtempSync` root (tests/test-helpers/ci-run.ts, section 9): the cgroup
// tree stands for `/sys/fs/cgroup`, a temp home holds `/ci-live`'s config
// directory, and the runner's environment names a temp directory under the
// root through `TMPDIR`, so no case reads the host's cgroups, a real home's
// `.config`, `/ci-live`'s real locks or the real `/tmp`. The one child process
// (the `os.tmpdir()` pin) gets a direct `hostSafeChildEnv` call and a time
// limit. E6's imports sit here, in its own region; names E1's imports above
// already bring in are used from there.

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { basename, dirname, relative } from 'node:path'
import ts from 'typescript'

import { CONTAINER_LABEL, CONTAINER_LABEL_KEY, CONTAINER_MEMORY, CONTAINER_PREFIX, parseMemorySize } from '../ci-live/lib/docker.ts'
import { CHROME_PSS_LIMIT_BYTES, HOST_WORKING_SET_LIMIT_BYTES } from '../ci-live/lib/memory-watchdog.ts'
import { defaultConfigDir, dryRunLockFile, realRunLockFile } from '../ci-live/lib/paths.ts'
import { isLiveRunnerPid, lockPid } from '../ci-live/lib/run-lock.ts'
import {
  ADMISSION_MARGIN_BYTES,
  BLOCKING_EVERY_RUN_TEXT,
  canChooseShards,
  childEnvironment,
  CI_CONTAINER_NAME_PREFIX,
  CI_CPUS,
  CI_LIVE_CEILING_SOURCE_TEXT,
  CI_LIVE_CHROME_LIMIT_BYTES,
  CI_LIVE_CONFIG_DIR_SUBPATH,
  CI_LIVE_CONTAINER_LABEL,
  CI_LIVE_CONTAINER_LABEL_VALUE,
  CI_LIVE_CONTAINER_MEMORY_BYTES,
  CI_LIVE_CONTAINER_PREFIX,
  CI_LIVE_DIR_NAME,
  CI_LIVE_DRY_RUN_LOCK_PREFIX,
  CI_LIVE_DRY_RUN_LOCK_SUFFIX,
  CI_LIVE_ENTRY_FILE_NAME,
  CI_LIVE_LOCK_READ_MAX_BYTES,
  CI_LIVE_REAL_RUN_LOCK_FILE_NAME,
  CI_LIVE_RUN_COMMITMENT_BYTES,
  CI_LIVE_RUNNER_ALLOWANCE_BYTES,
  CI_LIVE_TEMP_DIR_VARIABLES,
  CI_LIVE_WORKING_SET_LIMIT_BYTES,
  CI_NEVER_REMOVES_TEXT,
  CI_SWEEP_REMOVES_TEXT,
  ciLiveDryRunLockPath,
  ciLiveLockPid,
  ciLiveRealRunLockPath,
  ciLiveTempDir,
  cpuFits,
  CPU_REFUSAL_ADVICE,
  decideAdmission,
  DISK_CHECK_ALLOWANCE_BYTES,
  DISK_LINE_PERCENT,
  DISK_REFUSAL_ADVICE,
  diskFits,
  DOCKER_STORAGE_NOTE,
  ENDED_BEFORE_ADMISSION_REASON,
  endedBeforeAdmissionShardCountLine,
  failedReadingRefusal,
  formatGib,
  formatShardCountLine,
  GIB_BYTES,
  isCiLiveRunnerPid,
  LARGEST_FITTING_SHARDS_PREFIX,
  LEGACY_RESULTS_DIR_PATTERN,
  listResultsDirectories,
  MEMORY_CEILING_PERCENT,
  MEMORY_REFUSAL_ADVICE,
  memoryCeiling,
  memoryFits,
  NO_FITTING_SHARDS_TEXT,
  NO_LIVE_RESERVATION_TEXT,
  NO_OTHER_CI_RUN_HOLDS_CPUS_TEXT,
  NO_RESULTS_DIRECTORIES_TEXT,
  NO_VALID_OWNER_LABEL_TEXT,
  NOT_RUN_PREFIX,
  NOTHING_ELSE_COUNTED_TEXT,
  parseCiArguments,
  PART_UNREADABLE_TEXT,
  POD_LIMIT_CEILING_SOURCE_TEXT,
  readContainerFigures,
  readContainerMemory,
  readPodMemory,
  readPodWorkingSet,
  refusalLine,
  RESULTS_LISTING_FAILED_TEXT,
  RUN_DIR_PREFIX,
  takeFullAdmissionReadings,
  UNCAPPED_CI_CONTAINER_TEXT,
  UNCAPPED_LABELLED_CONTAINER_TEXT,
  UNKNOWN_TEMP_DIR_TEXT,
  workingSetRestBytes,
  type AdmissionDecision,
  type AdmissionFigures,
  type AdmissionReading,
  type AdmissionRequest,
  type AdmissionStepInput,
  type BlockingContainer,
  type CiLiveRunSeen,
  type Invocation,
  type MemoryCommitment,
  type ReadingResult,
  type Refusal,
  type ReservationListing,
  type ResultsDirectoryLister,
  type ShardCountLineInput,
  type VolumeReading,
} from '../scripts/ci-run.ts'
import {
  addCiLiveContainer,
  addCiLiveLockHolder,
  badReservationFile,
  buildAdmissionReadings,
  CGROUP_FILE,
  CGROUP_UNLIMITED,
  ciLiveLockText,
  ciShardLabels,
  createFakeDocker,
  createSpawnRecorder,
  failedReservationListing,
  gibToBytes,
  listedReservation,
  makeCiLiveConfigOverride,
  makeCiLiveHome,
  makeDryRunLock,
  makeResultsDir,
  realScriptFileName,
  reservationListing,
  resultsDirName,
  runDirIn,
  stubReservationReader,
  type AdmissionReadingsSpec,
  type BuiltAdmissionReadings,
  type CiLiveHome,
  type CiLiveLockHolder,
  type ContainerGibFigures,
  type FakeDocker,
  type PodFigures,
  type SpawnRecorder,
  type StubReservationReader,
} from './test-helpers/ci-run.ts'
import { assertNoLeak, fakeToken } from './test-helpers/credentials.ts'
import { createFakeClock } from './test-helpers/fake-clock.ts'
import { hostSafeChildEnv } from './test-helpers/host-safe-env.ts'

describe('E6: admission readings, /ci-live, commitments, fits and refusals', () => {
  /** Test data: this run's RUN_ID, the runner's user ID, and the host's pod limit L in GiB (the PRD's 64 GiB container cgroup). */
  const RUN_ID = '20261008t130000z-e6run001'
  const RUNNER_UID = 4321
  const POD_LIMIT_GIB = 64
  /** Test data: owners of other `/ci` runs, live and dead by the stub reader's listing. */
  const LIVE_OWNER: Owner = { runId: '20261008t110000z-live0001', pid: 52001 }
  const OTHER_LIVE_OWNER: Owner = { runId: '20261008t113000z-live0002', pid: 52002 }
  const DEAD_OWNER: Owner = { runId: '20261008t100000z-dead0001', pid: 52003 }
  /** Test data: a volume well below the disk line. */
  const IDLE_VOLUME_GIB = { usedGib: 10, availableGib: 90 }
  /** C at the factory's L with no `/ci-live` run (pinned on its own in T7.S1); called inside cases, never at load. */
  const podCeilingBytes = (): number => memoryCeiling(gibToBytes(POD_LIMIT_GIB), []).bytes
  /** C at the factory's L, and `/ci-live`'s 40 GiB line (pinned in T7.S3), as the messages print them; called inside cases, never at load. */
  const podCeilingGibText = (): string => formatGib(podCeilingBytes())
  const ciLiveCeilingGibText = (): string => formatGib(CI_LIVE_WORKING_SET_LIMIT_BYTES)

  let root: string
  let recorders: SpawnRecorder[]

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'ci-run-admission-e6-'))
    recorders = []
  })

  afterEach(() => {
    try {
      for (const recorder of recorders) recorder.assertNoFailures()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  // --- The admission-deps factory ---

  /** What a case changes from the factory's defaults; every figure in GiB. */
  interface AdmissionSpec {
    /** The namespace root (default: L of 64 GiB, W of 0). */
    readonly pod?: PodFigures
    readonly runnerCgroup?: AdmissionReadingsSpec['runnerCgroup']
    /** The run directory's volume (default: well below the disk line). */
    readonly volume?: AdmissionReadingsSpec['volume']
    /** Containers with their cgroups (default: none). */
    readonly containers?: readonly ContainerGibFigures[]
    /** What the stub reservation reader lists (default: nothing). */
    readonly reservations?: ReservationListing
  }

  /** The runner's admission dependencies over constructed readings. */
  interface AdmissionRig {
    /** The rig's own directory under the case's root. */
    readonly dir: string
    /** The system temp directory the environment names (`TMPDIR`). */
    readonly tempDir: string
    readonly ciLive: CiLiveHome
    /** The runner's environment: fake credentials and a temp directory under the root. Cases may add to it before reading. */
    readonly env: Record<string, string | undefined>
    readonly recorder: SpawnRecorder
    readonly docker: FakeDocker
    readonly processes: FakeProcessTable
    readonly built: BuiltAdmissionReadings
    readonly reader: StubReservationReader
    readonly input: AdmissionStepInput
    /** The readings step. */
    take(): Promise<AdmissionReading<AdmissionFigures>>
    /** The readings step's figures; throws when a reading failed. */
    figures(): Promise<AdmissionFigures>
    /** The disk message's results-directory listing, over the rig's environment. */
    readonly listResultsDirs: ResultsDirectoryLister
  }

  /**
   * Builds the runner's admission dependencies from constructed readings, in
   * a new directory under the case's root: at E1's starting cap, an L of
   * 64 GiB and W of 0, nothing else counted (no reservations, no `/ci-live`
   * activity, no `cscb-ci*` containers) and an idle volume, with a runner
   * environment holding fake credentials. Any of them can be overridden.
   */
  function makeAdmission(spec: AdmissionSpec = {}): AdmissionRig {
    const dir = mkdtempSync(join(root, 'rig-'))
    const clock = createFakeClock()
    const recorder = createSpawnRecorder({ clock, root: dir })
    recorders.push(recorder)
    const docker = createFakeDocker(recorder)
    const tempDir = join(dir, 'tmp')
    mkdirSync(tempDir)
    const built = buildAdmissionReadings(dir, docker, {
      pod: spec.pod ?? { limitGib: POD_LIMIT_GIB },
      ...(spec.runnerCgroup === undefined ? {} : { runnerCgroup: spec.runnerCgroup }),
      volume: spec.volume ?? { mountPoint: tempDir, ...IDLE_VOLUME_GIB },
      containers: spec.containers ?? [],
    })
    const ciLive = makeCiLiveHome(dir)
    const env: Record<string, string | undefined> = {
      HOME: ciLive.home,
      TMPDIR: tempDir,
      ANTHROPIC_API_KEY: fakeToken('', 'anthropic'),
      GH_TOKEN: fakeToken('', 'gh'),
    }
    const reader = stubReservationReader(spec.reservations)
    const proc = recorder.processes.deps()
    const input: AdmissionStepInput = {
      deps: {
        readCgroupFile: built.deps.readCgroupFile,
        readVolume: built.deps.readVolume,
        readProcCgroup: proc.readProcCgroup,
        readProcCmdline: proc.readProcCmdline,
        readProcCwd: proc.readProcCwd,
        env,
        uid: RUNNER_UID,
      },
      docker: { spawn: recorder.spawn, env: childEnvironment(env), cwd: dir },
      runDir: runDirIn(tempDir, RUN_ID),
      lockDir: join(dir, 'lock'),
      readReservations: reader.read,
      home: ciLive.home,
    }
    const take = (): Promise<AdmissionReading<AdmissionFigures>> => takeFullAdmissionReadings(input)
    return {
      dir,
      tempDir,
      ciLive,
      env,
      recorder,
      docker,
      processes: recorder.processes,
      built,
      reader,
      input,
      take,
      async figures() {
        const taken = await take()
        if (!taken.ok) throw new Error(`a reading failed: ${taken.what}: ${taken.error}`)
        return taken.value
      },
      listResultsDirs: () => listResultsDirectories(env),
    }
  }

  /** Writes the real-run lock naming a new process of the given kind; answers its PID. */
  function holdRealRunLock(rig: AdmissionRig, holder: CiLiveLockHolder = 'runner-by-path'): number {
    const pid = addCiLiveLockHolder(rig.processes, holder)
    writeFileSync(rig.ciLive.realRunLock, ciLiveLockText(pid))
    return pid
  }

  /** Writes the dry-run lock, naming a new process of the given kind, in a temp directory `TMPDIR` names; answers its PID and path. */
  function holdDryRunLock(rig: AdmissionRig, holder: CiLiveLockHolder = 'runner-by-path'): { readonly pid: number; readonly path: string } {
    const pid = addCiLiveLockHolder(rig.processes, holder)
    const lock = makeDryRunLock(rig.dir, { uid: RUNNER_UID, spellings: { TMPDIR: 'set' }, lockIn: 'TMPDIR', lockText: ciLiveLockText(pid) })
    Object.assign(rig.env, lock.env)
    if (lock.lockPath === null) throw new Error('holdDryRunLock: no lock was written')
    return { pid, path: lock.lockPath }
  }

  /** A run's invocation and its admission request at the starting cap; `units` is u, and the effective N is the smaller of r and u, at least 1 (E2's rule, b.uqm SR-3.4). */
  function requestFor(args: readonly string[], units: number): { readonly invocation: Invocation; readonly request: AdmissionRequest } {
    const parsed = parseCiArguments(args)
    if (!parsed.ok) throw new Error(`requestFor: ${JSON.stringify(args)} does not parse`)
    const requestedShards = parsed.invocation.shards ?? MAX_SHARDS
    return {
      invocation: parsed.invocation,
      request: {
        requestedShards,
        units,
        effectiveShards: Math.min(requestedShards, Math.max(OPTION_RANGE_MIN, units)),
        canChooseShards: canChooseShards(parsed.invocation),
        capBytes: SHARD_MEMORY_CAP_BYTES,
      },
    }
  }

  /** A default full run (`/ci` with no arguments): at least r scheduling units, so its effective N is r. */
  const defaultFullRun = (): AdmissionRequest => requestFor([], MAX_SHARDS).request

  /** The decision's refusal, or a failure naming what was decided instead. */
  function refusalOf(decision: AdmissionDecision): Refusal {
    if (decision.kind !== 'refused') throw new Error(`expected a refusal, got ${decision.shards} shard(s)`)
    return decision.refusal
  }

  /** A refusal's lines as the reader prints them: the first line, then each detail. */
  function refusalLines(refusal: Refusal): string[] {
    return [refusalLine(refusal), ...refusal.details]
  }

  /** A successful reading of `value`. */
  const okReading = <T,>(value: T): ReadingResult<T> => ({ ok: true, value })

  // -------------------------------------------------------------------------
  // T7.S1: pod memory, the ceiling and container figures (b.uqm SR-7.1, SR-7.2; AC 26)
  // -------------------------------------------------------------------------

  describe('pod memory, the ceiling and container figures (b.uqm SR-7.1, SR-7.2)', () => {
    test('L and W come from the namespace root, not from a cgroup on the runner\'s own path with a smaller limit', () => {
      const rig = makeAdmission({
        pod: { limitGib: POD_LIMIT_GIB, workingSetGib: 30, anonGib: 12, activeFileGib: 15, inactiveFileGib: 4 },
        runnerCgroup: { path: '/kubepods/runner', pod: { limitGib: 8, workingSetGib: 3, anonGib: 1, activeFileGib: 1, inactiveFileGib: 1 } },
      })
      const { pod } = rig.built
      expect(rig.built.runnerCgroup?.pod.maxBytes).toBeLessThan(pod.maxBytes as number)

      expect(readPodMemory(rig.input.deps)).toEqual(
        okReading({ limitBytes: pod.maxBytes as number, workingSet: { bytes: pod.workingSetBytes, anonBytes: pod.anonBytes, activeFileBytes: pod.activeFileBytes } }),
      )
      expect(new Set(rig.built.cgroups.reads().map((read) => read.cgroupPath))).toEqual(new Set(['/']))
    })

    test.each([
      ['W splits into anon, active page cache and the rest, which add up to W', { limitGib: POD_LIMIT_GIB, workingSetGib: 30.5, anonGib: 12.25, activeFileGib: 15, inactiveFileGib: 4 }],
      ['W is floored at 0 when inactive_file is larger than memory.current', { limitGib: POD_LIMIT_GIB, currentGib: 1, anonGib: 0.5, activeFileGib: 0.25, inactiveFileGib: 3 }],
    ] satisfies [string, PodFigures][])('%s', (_name, figures) => {
      const rig = makeAdmission({ pod: figures })
      const { pod } = rig.built
      const read = readPodWorkingSet(rig.input.deps)

      expect(read).toEqual(okReading({ bytes: pod.workingSetBytes, anonBytes: pod.anonBytes, activeFileBytes: pod.activeFileBytes }))
      if (!read.ok) return
      expect(workingSetRestBytes(read.value)).toBe(pod.restBytes)
      if (pod.restBytes > 0) expect(read.value.anonBytes + read.value.activeFileBytes + workingSetRestBytes(read.value)).toBe(read.value.bytes)
      else expect(read.value.bytes).toBe(0)
    })

    /** A `/ci-live` run as a ceiling takes it. */
    const activeRun = (): CiLiveRunSeen => ({ via: 'real-run-lock', what: join(root, 'run.lock'), pid: 4242 })

    test('C is 85% of L in whole bytes, rounded down', () => {
      const limitBytes = gibToBytes(POD_LIMIT_GIB)
      const scaledLimit = BigInt(limitBytes) * BigInt(MEMORY_CEILING_PERCENT)
      // The rounding shows at this L: 85% of it is not a whole byte count.
      expect(scaledLimit % BigInt(100)).not.toBe(BigInt(0))

      const ceiling = memoryCeiling(limitBytes, [])
      expect(Number.isSafeInteger(ceiling.bytes)).toBe(true)
      expect(BigInt(ceiling.bytes) * BigInt(100) <= scaledLimit).toBe(true)
      expect(scaledLimit < BigInt(ceiling.bytes + 1) * BigInt(100)).toBe(true)
      expect(ceiling.source).toEqual({ kind: 'pod-limit', limitBytes })
    })

    test.each([
      ['85% of L above the 40 GiB line: C is the 40 GiB line', 48, true],
      ['85% of L below the 40 GiB line: C stays 85% of L', 47, false],
    ])('while /ci-live is active, %s', (_name, limitGib, lowered) => {
      const limitBytes = gibToBytes(limitGib)
      const runs = [activeRun()]
      const podCeiling = memoryCeiling(limitBytes, []).bytes
      expect(podCeiling > CI_LIVE_WORKING_SET_LIMIT_BYTES).toBe(lowered)

      expect(memoryCeiling(limitBytes, runs)).toEqual(
        lowered
          ? { bytes: CI_LIVE_WORKING_SET_LIMIT_BYTES, source: { kind: 'ci-live', runs } }
          : { bytes: podCeiling, source: { kind: 'pod-limit', limitBytes } },
      )
    })

    test('a container\'s figures are each read from its own cgroup\'s file, and every read lies under the case\'s root', () => {
      const rig = makeAdmission({
        containers: [{ name: `${CI_CONTAINER_NAME_PREFIX}-figures`, capGib: 2, memoryGib: 1.5, anonGib: 1.25, fileGib: 0.75, inactiveFileGib: 0.5, pidCount: 37, oomKillCount: 2 }],
      })
      const [container] = rig.built.containers
      if (container === undefined || container.figures === null) throw new Error('the container was not built')
      const { figures } = container

      expect(readContainerFigures(rig.input.deps, container)).toEqual({
        memoryBytes: okReading(figures.currentBytes - figures.inactiveFileBytes),
        anonBytes: okReading(figures.anonBytes),
        fileBytes: okReading(figures.fileBytes),
        pidCount: okReading(figures.pidCount),
        oomKillCount: okReading(figures.oomKillCount),
      })
      const reads = rig.built.cgroups.reads()
      expect(reads.length).toBeGreaterThan(0)
      for (const read of reads) {
        expect(read.cgroupPath).toBe(container.cgroupPath)
        expect(read.path?.startsWith(`${rig.built.cgroups.dir}/`)).toBe(true)
      }
    })

    test.each([
      ['Docker\'s cgroupfs layout on this host', '/docker'],
      ['a parent named unlike Docker\'s layout', '/kubepods.slice/odd-parent.scope'],
    ])('a container cgroup under %s is found through the container\'s main PID', (_name, parent) => {
      const rig = makeAdmission({ containers: [{ name: `${CI_CONTAINER_NAME_PREFIX}-parent`, capGib: 2, memoryGib: 0.75, parent }] })
      const [container] = rig.built.containers
      if (container === undefined) throw new Error('the container was not built')

      expect(container.cgroupPath.startsWith(`${parent}/`)).toBe(true)
      expect(readContainerMemory(rig.input.deps, container)).toEqual(okReading(gibToBytes(0.75)))
    })

    test('an exited container, its main PID 0, gives a failed reading for every figure', () => {
      const rig = makeAdmission({ containers: [{ name: `${CI_CONTAINER_NAME_PREFIX}-exited`, capGib: 2, running: false }] })
      const [container] = rig.built.containers
      if (container === undefined) throw new Error('the container was not built')
      expect(container.pid).toBe(0)

      const figures = readContainerFigures(rig.input.deps, container)
      for (const figure of Object.values(figures)) {
        expect(figure.ok).toBe(false)
        if (!figure.ok) expect(figure.what).toContain(container.name)
      }
      expect(rig.built.cgroups.reads()).toEqual([])
    })
  })

  // -------------------------------------------------------------------------
  // T7.S2: the admission readings and failed readings (b.uqm SR-6.5; AC 26, AC 33's admission half)
  // -------------------------------------------------------------------------

  describe('the admission readings and failed readings (b.uqm SR-6.5)', () => {
    /** W of 35.5 GiB: anon, active page cache and the rest, with inactive page cache outside it. */
    const BUSY_POD: PodFigures = { limitGib: POD_LIMIT_GIB, workingSetGib: 35.5, anonGib: 14, activeFileGib: 18.5, inactiveFileGib: 3 }

    test('a successful readings step collects L, the volume, the running cscb-ci* and cscb-ci=1 containers, the valid reservations and the /ci-live activity, and nothing else', async () => {
      const live = listedReservation({ owner: LIVE_OWNER, shards: 2, ownerAlive: true })
      const dead = listedReservation({ owner: DEAD_OWNER, shards: 1, ownerAlive: false })
      const deadBad = badReservationFile({ owner: OTHER_LIVE_OWNER, ownerAlive: false, change: { kind: 'unparseable' } })
      const shard = `${CI_CONTAINER_NAME_PREFIX}-live-shard-1`
      const uncapped = `${CI_CONTAINER_NAME_PREFIX}-scratch`
      const labelledForeignName = 'builder-labelled'
      const rig = makeAdmission({
        pod: BUSY_POD,
        reservations: reservationListing({ valid: [live, dead], bad: [deadBad] }),
        containers: [
          { name: shard, labels: ciShardLabels(LIVE_OWNER), capGib: 2, memoryGib: 1.25 },
          { name: uncapped, capGib: null, memoryGib: 0.5 },
          { name: labelledForeignName, labels: { [CI_LABEL]: CI_LABEL_VALUE }, capGib: 3, memoryGib: 0.25 },
          { name: `${CI_CONTAINER_NAME_PREFIX}-stopped`, labels: ciShardLabels(LIVE_OWNER), capGib: 2, running: false },
          { name: 'postgres', capGib: 4, memoryGib: 1 },
        ],
      })
      const ciLivePid = rig.processes.allocatePid()
      const ciLiveContainer = addCiLiveContainer(rig.docker, { ownerPid: ciLivePid })

      const { readings } = await rig.figures()

      expect(readings.podLimitBytes).toBe(rig.built.pod.maxBytes as number)
      expect(readings.volume).toEqual(rig.built.volumeReading as VolumeReading)
      expect(rig.built.volume.paths()).toEqual([rig.input.runDir])
      expect(readings.containers.map(({ name, labels, memoryCapBytes, currentMemory }) => ({ name, labels, memoryCapBytes, currentMemory }))).toEqual([
        { name: shard, labels: ciShardLabels(LIVE_OWNER), memoryCapBytes: gibToBytes(2), currentMemory: okReading(gibToBytes(1.25)) },
        { name: uncapped, labels: {}, memoryCapBytes: null, currentMemory: okReading(gibToBytes(0.5)) },
        { name: labelledForeignName, labels: { [CI_LABEL]: CI_LABEL_VALUE }, memoryCapBytes: gibToBytes(3), currentMemory: okReading(gibToBytes(0.25)) },
      ])
      expect(readings.reservations).toEqual([live, dead])
      expect(rig.reader.lockDirs()).toEqual([rig.input.lockDir])
      expect(readings.ciLive.runs).toEqual([{ via: 'container', what: ciLiveContainer.name, pid: ciLivePid }])
    })

    test('the W read at admission is the run\'s before reading, split into anon and active page cache', async () => {
      const rig = makeAdmission({ pod: BUSY_POD })
      const { pod } = rig.built

      const { readings } = await rig.figures()

      expect(readings.beforeWorkingSet).toEqual({ bytes: pod.workingSetBytes, anonBytes: pod.anonBytes, activeFileBytes: pod.activeFileBytes })
    })

    /** Test data: the errors constructed failures report. */
    const VOLUME_ERROR = 'statfs failed: EIO: i/o error'
    const LISTING_ERROR = 'Cannot connect to the Docker daemon at unix:///var/run/docker.sock'
    const RESERVATIONS_ERROR = 'EACCES: permission denied, scandir'
    /** Test data: `memory.stat`'s key for inactive page cache (the kernel's name). */
    const INACTIVE_FILE_KEY = 'inactive_file'
    const BROKEN_CONTAINER = `${CI_CONTAINER_NAME_PREFIX}-broken-cgroup`

    /** One failed reading: its refusal kind, the case's spec, how the reading is broken after the build, and the names the refusal must hold. */
    interface FailedReadingRow {
      readonly kind: 'disk' | 'memory'
      readonly spec?: AdmissionSpec
      readonly breakIt?: (rig: AdmissionRig) => void
      /** What the readings step reads through, when not the rig's own dependencies. */
      readonly readThrough?: (rig: AdmissionRig) => AdmissionStepInput
      readonly names: (rig: AdmissionRig) => readonly string[]
    }

    const failedReadings: [string, FailedReadingRow][] = [
      ['the volume\'s statistics', { kind: 'disk', spec: { volume: { error: VOLUME_ERROR } }, names: (rig) => [rig.input.runDir, VOLUME_ERROR] }],
      [
        'the namespace root\'s memory.current missing',
        { kind: 'memory', breakIt: (rig) => rig.built.cgroups.change('/', CGROUP_FILE.current, { kind: 'removed' }), names: () => [CGROUP_FILE.current] },
      ],
      ['memory.stat garbled', { kind: 'memory', breakIt: (rig) => rig.built.cgroups.change('/', CGROUP_FILE.stat, { kind: 'garbled' }), names: () => [CGROUP_FILE.stat] }],
      [
        'memory.stat without inactive_file',
        {
          kind: 'memory',
          breakIt: (rig) => rig.built.cgroups.change('/', CGROUP_FILE.stat, { kind: 'without-key', key: INACTIVE_FILE_KEY }),
          names: () => [CGROUP_FILE.stat, INACTIVE_FILE_KEY],
        },
      ],
      ['memory.max of max: a namespace root with no limit', { kind: 'memory', spec: { pod: { limitGib: CGROUP_UNLIMITED } }, names: () => [CGROUP_FILE.max] }],
      ['the container listing', { kind: 'memory', breakIt: (rig) => rig.docker.fail('container-list', { stderr: LISTING_ERROR }), names: () => [LISTING_ERROR] }],
      [
        'a listed container\'s cgroup file missing',
        {
          kind: 'memory',
          spec: { containers: [{ name: BROKEN_CONTAINER, capGib: 2, memoryGib: 1 }] },
          breakIt: (rig) => rig.built.cgroups.change(rig.built.containers[0]!.cgroupPath, CGROUP_FILE.current, { kind: 'removed' }),
          names: () => [BROKEN_CONTAINER, CGROUP_FILE.current],
        },
      ],
      [
        'a listed container that stops while it is read: its main process is gone',
        {
          kind: 'memory',
          spec: { containers: [{ name: BROKEN_CONTAINER, capGib: 2, memoryGib: 1 }] },
          // Listed running, its main process gone by the time its cgroup is looked up.
          readThrough: (rig) => {
            const { pid } = rig.built.containers[0]!
            const readProcCgroup: AdmissionStepInput['deps']['readProcCgroup'] = (asked) => (asked === pid ? { kind: 'gone' } : rig.input.deps.readProcCgroup(asked))
            return { ...rig.input, deps: { ...rig.input.deps, readProcCgroup } }
          },
          names: (rig) => [BROKEN_CONTAINER, String(rig.built.containers[0]!.pid)],
        },
      ],
      [
        'a bad reservation file whose owner is alive',
        {
          kind: 'memory',
          spec: { reservations: reservationListing({ bad: [badReservationFile({ owner: LIVE_OWNER, ownerAlive: true, change: { kind: 'version', version: RESERVATION_FORMAT_VERSION + 1 } })] }) },
          names: (rig) => [join(rig.input.lockDir, reservationFileName(LIVE_OWNER))],
        },
      ],
      [
        'the reservation listing',
        { kind: 'memory', spec: { reservations: failedReservationListing(RESERVATIONS_ERROR) }, names: (rig) => [rig.input.lockDir, RESERVATIONS_ERROR] },
      ],
      ['a /ci-live real-run lock that exists but is not a regular file', { kind: 'memory', breakIt: (rig) => mkdirSync(rig.ciLive.realRunLock), names: (rig) => [rig.ciLive.realRunLock] }],
      [
        'a /ci-live real-run lock larger than any PID it could hold',
        { kind: 'memory', breakIt: (rig) => writeFileSync(rig.ciLive.realRunLock, '1'.repeat(CI_LIVE_LOCK_READ_MAX_BYTES + 1)), names: (rig) => [rig.ciLive.realRunLock] },
      ],
      [
        'a /ci-live dry-run lock that exists but is not a regular file',
        {
          kind: 'memory',
          breakIt: (rig) => mkdirSync(ciLiveDryRunLockPath(rig.env, RUNNER_UID)),
          names: (rig) => [ciLiveDryRunLockPath(rig.env, RUNNER_UID)],
        },
      ],
    ]

    test.each(failedReadings)('a failed reading refuses the run, of its kind and naming what failed: %s', async (_name, row) => {
      const rig = makeAdmission(row.spec)
      row.breakIt?.(rig)

      const taken = await takeFullAdmissionReadings(row.readThrough?.(rig) ?? rig.input)

      expect(taken.ok).toBe(false)
      if (taken.ok) return
      expect(taken.kind).toBe(row.kind)
      const refusal = failedReadingRefusal(taken)
      const line = refusalLine(refusal)
      expect(line).toBe(`${NOT_RUN_PREFIX}${row.kind}: could not read ${taken.what}: ${taken.error}`)
      expect(refusal.details).toEqual([])
      for (const name of row.names(rig)) expect(line).toContain(name)
      assertNoLeak({ refusal, line })
    })
  })

  // -------------------------------------------------------------------------
  // T7.S3: the runner's /ci-live copies and E6's constants, pinned (b.uqm SR-6.6, SR-21.5)
  // -------------------------------------------------------------------------
  //
  // Paths here are only compared as strings: no case reads, stats or locks a
  // path a rule produces. With every temp variable unset the rule names
  // `/ci-live`'s real dry-run lock under `/tmp`, which is never touched.

  describe('the runner\'s /ci-live copies, pinned against /ci-live and Bun (b.uqm SR-6.6, SR-21.5)', () => {
    /** Test data: a home and a directory that are only ever strings, and a user ID whose digits appear nowhere else in the lock's name. */
    const PIN_HOME = '/pin-home/account'
    const PIN_DIR = '/pin-dir/config'
    const PIN_UID = 4321
    /** `/ci-live`'s dry-run lock name for PIN_UID, split at the user ID. */
    const [dryRunNameHead, dryRunNameTail] = basename(dryRunLockFile(PIN_DIR, PIN_UID)).split(String(PIN_UID))

    /**
     * One pin per exported constant of the runner's section 10: its name, its
     * value, and what it must equal. The runner's copies of `/ci-live`'s rules
     * and figures are checked against `/ci-live`'s own exports; every other
     * constant against the PRD's or SRD's value, typed only here.
     */
    const E6_CONSTANT_PINS: readonly (readonly [string, unknown, unknown])[] = [
      // The runner's copies of /ci-live's three figures (b.uqm SR-6.6, SR-7.1), in bytes.
      ['CI_LIVE_CONTAINER_MEMORY_BYTES', CI_LIVE_CONTAINER_MEMORY_BYTES, parseMemorySize(CONTAINER_MEMORY)],
      ['CI_LIVE_CHROME_LIMIT_BYTES', CI_LIVE_CHROME_LIMIT_BYTES, CHROME_PSS_LIMIT_BYTES],
      ['CI_LIVE_WORKING_SET_LIMIT_BYTES', CI_LIVE_WORKING_SET_LIMIT_BYTES, HOST_WORKING_SET_LIMIT_BYTES],
      // Their sum with the runner allowance: the PRD's 13 GiB per active /ci-live run.
      ['CI_LIVE_RUN_COMMITMENT_BYTES', CI_LIVE_RUN_COMMITMENT_BYTES, 13 * GIB_BYTES],
      // The runner's copies of /ci-live's lock paths and names.
      ['CI_LIVE_CONFIG_DIR_SUBPATH', CI_LIVE_CONFIG_DIR_SUBPATH, relative(PIN_HOME, defaultConfigDir(PIN_HOME))],
      ['CI_LIVE_REAL_RUN_LOCK_FILE_NAME', CI_LIVE_REAL_RUN_LOCK_FILE_NAME, basename(realRunLockFile(PIN_DIR))],
      ['CI_LIVE_DRY_RUN_LOCK_PREFIX', CI_LIVE_DRY_RUN_LOCK_PREFIX, dryRunNameHead],
      ['CI_LIVE_DRY_RUN_LOCK_SUFFIX', CI_LIVE_DRY_RUN_LOCK_SUFFIX, dryRunNameTail],
      ['CI_LIVE_TEMP_DIR_VARIABLES', CI_LIVE_TEMP_DIR_VARIABLES, ['TMPDIR', 'TMP', 'TEMP']],
      // The runner's copies of /ci-live's container label and name.
      ['CI_LIVE_CONTAINER_LABEL', CI_LIVE_CONTAINER_LABEL, CONTAINER_LABEL_KEY],
      ['CI_LIVE_CONTAINER_LABEL_VALUE', CI_LIVE_CONTAINER_LABEL_VALUE, CONTAINER_LABEL.slice(`${CONTAINER_LABEL_KEY}=`.length)],
      ['CI_LIVE_CONTAINER_PREFIX', CI_LIVE_CONTAINER_PREFIX, CONTAINER_PREFIX],
      // The runner test's directory and entry file: `isLiveRunnerPid` types both as literals and exports neither. The runner builds its
      // runner-test patterns from these two, so the runner-test table below, which compares its answers with `isLiveRunnerPid`'s, checks them in use too.
      ['CI_LIVE_DIR_NAME', CI_LIVE_DIR_NAME, 'ci-live'],
      ['CI_LIVE_ENTRY_FILE_NAME', CI_LIVE_ENTRY_FILE_NAME, 'run.ts'],
      // The runner's own bound on a lock read: a PID of at most ten digits fits well inside it.
      ['CI_LIVE_LOCK_READ_MAX_BYTES', CI_LIVE_LOCK_READ_MAX_BYTES, 64],
      // Readings and the shard-count line (b.uqm SR-6.5, SR-6.7).
      ['CI_CONTAINER_NAME_PREFIX', CI_CONTAINER_NAME_PREFIX, 'cscb-ci'],
      ['ENDED_BEFORE_ADMISSION_REASON', ENDED_BEFORE_ADMISSION_REASON, 'ended before admission'],
      // Refusal messages (b.uqm SR-6.8).
      [
        'MEMORY_REFUSAL_ADVICE',
        MEMORY_REFUSAL_ADVICE,
        "what to do: finish or kill idle agent-director workers and confirm their tmux sessions are gone; stop the other CI runs or builds listed; then re-run /ci. Page cache cannot be dropped in this pod and is reclaimed only by the kernel. A re-run is worthwhile once the sysadmin monitor's reading is back below its 85% warn line, or once W is back below the ceiling.",
      ],
      ['DISK_REFUSAL_ADVICE', DISK_REFUSAL_ADVICE, 'what to do: remove results directories and other large files that are not needed on that volume, then re-run.'],
      ['DOCKER_STORAGE_NOTE', DOCKER_STORAGE_NOTE, "Docker's images live on /var/lib/docker, which this check does not count."],
      ['CPU_REFUSAL_ADVICE', CPU_REFUSAL_ADVICE, 'what to do: wait for or cancel a listed run (signal its runner PID), or re-run with a --shards value that fits.'],
      ['POD_LIMIT_CEILING_SOURCE_TEXT', POD_LIMIT_CEILING_SOURCE_TEXT, "the sysadmin monitor's warn line"],
      ['CI_LIVE_CEILING_SOURCE_TEXT', CI_LIVE_CEILING_SOURCE_TEXT, "/ci-live's working-set stop line"],
      ['LARGEST_FITTING_SHARDS_PREFIX', LARGEST_FITTING_SHARDS_PREFIX, 'largest --shards value that fits now: '],
      ['NO_FITTING_SHARDS_TEXT', NO_FITTING_SHARDS_TEXT, 'no --shards value fits now, not even 1'],
      ['LEGACY_RESULTS_DIR_PATTERN', LEGACY_RESULTS_DIR_PATTERN, /^cscb-ci-[0-9]+-[A-Za-z0-9]{6}$/],
      ['BLOCKING_EVERY_RUN_TEXT', BLOCKING_EVERY_RUN_TEXT, 'blocking every run'],
      ['UNCAPPED_CI_CONTAINER_TEXT', UNCAPPED_CI_CONTAINER_TEXT, 'an uncapped cscb-ci* container'],
      ['NO_LIVE_RESERVATION_TEXT', NO_LIVE_RESERVATION_TEXT, 'with no live reservation'],
      ['UNCAPPED_LABELLED_CONTAINER_TEXT', UNCAPPED_LABELLED_CONTAINER_TEXT, 'an uncapped container labelled cscb-ci=1 with no live reservation'],
      ['NO_VALID_OWNER_LABEL_TEXT', NO_VALID_OWNER_LABEL_TEXT, 'no valid owner label'],
      ['CI_NEVER_REMOVES_TEXT', CI_NEVER_REMOVES_TEXT, '/ci never removes it'],
      ['CI_SWEEP_REMOVES_TEXT', CI_SWEEP_REMOVES_TEXT, "a later /ci run's sweep removes it once its owner is dead"],
      ['NOTHING_ELSE_COUNTED_TEXT', NOTHING_ELSE_COUNTED_TEXT, 'nothing else is counted'],
      ['NO_OTHER_CI_RUN_HOLDS_CPUS_TEXT', NO_OTHER_CI_RUN_HOLDS_CPUS_TEXT, 'no other /ci run holds CPUs'],
      ['NO_RESULTS_DIRECTORIES_TEXT', NO_RESULTS_DIRECTORIES_TEXT, 'no /ci results directories in'],
      ['RESULTS_LISTING_FAILED_TEXT', RESULTS_LISTING_FAILED_TEXT, 'could not be listed'],
      ['PART_UNREADABLE_TEXT', PART_UNREADABLE_TEXT, 'part of it could not be read'],
      ['UNKNOWN_TEMP_DIR_TEXT', UNKNOWN_TEMP_DIR_TEXT, '(unknown)'],
    ]

    /** The runner's section 10 banner and the next one: E6's constants are exported between them. */
    const SECTION_10_BANNER = /^\/\/ 10\. Admission readings and fit \(E6\)$/m
    const SECTION_11_BANNER = /^\/\/ 11\. Memory guard \(E7\)$/m

    /** The names of the `export const` declarations in the runner's section 10. */
    function exportedSection10Constants(): string[] {
      const source = readFileSync(join(import.meta.dir, '..', RUNNER_PATH_SUFFIX), 'utf-8')
      const start = source.search(SECTION_10_BANNER)
      const end = source.search(SECTION_11_BANNER)
      if (start < 0 || end < start) throw new Error('the runner has no section 10 and 11 banners in order')
      const file = ts.createSourceFile('ci-run.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
      const names: string[] = []
      for (const statement of file.statements) {
        const at = statement.getStart(file)
        if (at < start || at >= end || !ts.isVariableStatement(statement)) continue
        const exported = (ts.getModifiers(statement) ?? []).some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)
        if (!exported || (statement.declarationList.flags & ts.NodeFlags.Const) === 0) continue
        for (const declaration of statement.declarationList.declarations) {
          if (ts.isIdentifier(declaration.name)) names.push(declaration.name.text)
        }
      }
      return names
    }

    test.each(E6_CONSTANT_PINS)('pins %s', (_name, actual, expected) => {
      expect(actual).toEqual(expected)
    })

    test('every exported constant of the runner\'s section 10 has exactly one pin case', () => {
      const pinned = E6_CONSTANT_PINS.map(([name]) => name)
      expect(new Set(pinned).size).toBe(pinned.length)
      expect([...exportedSection10Constants()].sort()).toEqual([...pinned].sort())
    })

    test.each([
      ['a home', '/pin-home/account'],
      ['a home with a trailing slash', '/pin-home/account/'],
      ['a home with repeated slashes', '/pin-home//account'],
      ['the root as home', '/'],
    ])('the real-run lock path for %s is /ci-live\'s', (_name, home) => {
      expect(ciLiveRealRunLockPath(home)).toBe(realRunLockFile(defaultConfigDir(home)))
    })

    test.each([
      ['a directory', '/pin-tmp/dir', 1000],
      ['a directory with a trailing slash', '/pin-tmp/dir/', 0],
      ['a directory with repeated slashes', '/pin-tmp//dir', 65534],
      ['the root', '/', 4294967294],
    ])('the dry-run lock path for %s and user ID %p is /ci-live\'s', (_name, tempDir, uid) => {
      expect(ciLiveDryRunLockPath({ TMPDIR: tempDir }, uid)).toBe(dryRunLockFile(tempDir, uid))
    })

    // --- The dry-run lock's directory against Bun's own os.tmpdir(), in a child process ---

    /** How a row spells one temp variable: unset, empty, a directory under the root (as is, with a trailing slash, or with repeated slashes), or `/`. */
    type TempSpelling = 'unset' | 'empty' | 'set' | 'trailing-slash' | 'repeated-slashes' | 'root'
    type TempVariable = (typeof CI_LIVE_TEMP_DIR_VARIABLES)[number]
    const [TMPDIR_VAR, TMP_VAR, TEMP_VAR] = CI_LIVE_TEMP_DIR_VARIABLES

    /** The child's program: it only prints Bun's `os.tmpdir()`. */
    const PRINT_TMPDIR = 'process.stdout.write(require("node:os").tmpdir())'
    /** The child's time limit. */
    const CHILD_TIME_LIMIT_MS = 10_000

    const tempDirRows: [string, Partial<Record<TempVariable, TempSpelling>>][] = [
      ['everything unset', {}],
      ['everything empty', { [TMPDIR_VAR]: 'empty', [TMP_VAR]: 'empty', [TEMP_VAR]: 'empty' }],
      ...CI_LIVE_TEMP_DIR_VARIABLES.flatMap((variable): [string, Partial<Record<TempVariable, TempSpelling>>][] => [
        [`${variable} set`, { [variable]: 'set' }],
        [`${variable} with a trailing slash`, { [variable]: 'trailing-slash' }],
        [`${variable} empty, the others unset`, { [variable]: 'empty' }],
        [`${variable} the root, /`, { [variable]: 'root' }],
      ]),
      [`${TMPDIR_VAR} with repeated slashes, inside and trailing`, { [TMPDIR_VAR]: 'repeated-slashes' }],
      [`${TEMP_VAR} with repeated slashes, inside and trailing`, { [TEMP_VAR]: 'repeated-slashes' }],
      [`${TMPDIR_VAR} first: all three set`, { [TMPDIR_VAR]: 'set', [TMP_VAR]: 'set', [TEMP_VAR]: 'set' }],
      [`${TMPDIR_VAR} first: the root before a set ${TMP_VAR}`, { [TMPDIR_VAR]: 'root', [TMP_VAR]: 'set' }],
      [`${TMP_VAR} next: ${TMPDIR_VAR} empty, ${TMP_VAR} and ${TEMP_VAR} set`, { [TMPDIR_VAR]: 'empty', [TMP_VAR]: 'set', [TEMP_VAR]: 'set' }],
      [`${TMP_VAR} next: ${TMPDIR_VAR} unset, ${TMP_VAR} and ${TEMP_VAR} set`, { [TMP_VAR]: 'set', [TEMP_VAR]: 'set' }],
      [`${TEMP_VAR} last: ${TMPDIR_VAR} unset and ${TMP_VAR} empty`, { [TMP_VAR]: 'empty', [TEMP_VAR]: 'set' }],
      [`${TEMP_VAR} last: ${TMPDIR_VAR} and ${TMP_VAR} empty, ${TEMP_VAR} with a trailing slash`, { [TMPDIR_VAR]: 'empty', [TMP_VAR]: 'empty', [TEMP_VAR]: 'trailing-slash' }],
    ]

    /** A row's variables: each set one's value, every directory under the case's root (made), apart from `/`. */
    function tempVariables(spellings: Partial<Record<TempVariable, TempSpelling>>): Record<string, string> {
      const vars: Record<string, string> = {}
      for (const variable of CI_LIVE_TEMP_DIR_VARIABLES) {
        const spelling = spellings[variable] ?? 'unset'
        if (spelling === 'unset') continue
        const name = `temp-${variable.toLowerCase()}`
        const dir = join(root, name)
        if (spelling !== 'empty' && spelling !== 'root') mkdirSync(dir, { recursive: true })
        vars[variable] =
          spelling === 'empty' ? '' : spelling === 'root' ? '/' : spelling === 'set' ? dir : spelling === 'trailing-slash' ? `${dir}/` : `${root}//${name}//`
      }
      return vars
    }

    test.each(tempDirRows)(
      'the dry-run lock path is /ci-live\'s for the directory Bun\'s os.tmpdir() gives a child with the same environment: %s',
      (_name, spellings) => {
        const vars = tempVariables(spellings)

        // The case's root is the child's HOME and holds every directory the row names, apart from `/`.
        const child = spawnSync(process.execPath, ['-e', PRINT_TMPDIR], {
          cwd: root,
          encoding: 'utf-8',
          timeout: CHILD_TIME_LIMIT_MS,
          env: hostSafeChildEnv(root, { tools: [], extras: { ...vars, BUN_RUNTIME_TRANSPILER_CACHE_PATH: '0' } }),
        })

        expect(child.error).toBeUndefined()
        expect(child.signal).toBeNull()
        expect(child.status).toBe(0)
        const bunTempDir = child.stdout
        expect(bunTempDir).not.toBe('')
        expect(ciLiveTempDir(vars)).toBe(bunTempDir)
        expect(ciLiveDryRunLockPath(vars, RUNNER_UID)).toBe(dryRunLockFile(bunTempDir, RUNNER_UID))
      },
      CHILD_TIME_LIMIT_MS + 5_000,
    )

    // --- The PID a lock names, and the runner test ---

    test.each([
      ['plain digits', '4242'],
      ['digits and a trailing line feed', '4242\n'],
      ['digits and trailing whitespace', '4242 \t\n'],
      ['leading whitespace', ' 4242'],
      ['two numbers', '4242 4243'],
      ['two lines of numbers', '4242\n4243\n'],
      ['empty text', ''],
      ['no text: the file is missing', null],
      ['letters', 'abc'],
      ['digits then letters', '4242abc'],
      ['a leading zero', '04242'],
      ['ten digits', '4294967295'],
      ['more than ten digits', '12345678901'],
      ['0', '0'],
      ['a negative number', '-4242'],
    ])('the PID a lock\'s text names is lockPid\'s: %s', (_name, text) => {
      expect(ciLiveLockPid(text)).toBe(lockPid(text))
    })

    /** Test data: a worktree root for command lines and working directories (never read). */
    const WORKTREE = '/pin-worktree'
    const CI_LIVE_CWD = `${WORKTREE}/ci-live`
    const RUNNER_CMDLINE = 'bun ci-live/run.ts '

    test.each([
      ['ci-live/run.ts by a relative path', 4242, RUNNER_CMDLINE, WORKTREE, true],
      ['ci-live/run.ts by an absolute path', 4242, `bun ${WORKTREE}/ci-live/run.ts `, '/', true],
      ['ci-live/run.ts with arguments', 4242, 'bun ci-live/run.ts --dry-run --checks 3 ', WORKTREE, true],
      ['ci-live/run.ts at the very end of the command line', 4242, 'bun ci-live/run.ts', WORKTREE, true],
      ['ci-live\\run.ts with a backslash', 4242, 'bun ci-live\\run.ts ', WORKTREE, true],
      ['a bare run.ts in a ci-live working directory', 4242, 'bun run.ts ', CI_LIVE_CWD, true],
      ['a bare run.ts with arguments in a ci-live working directory', 4242, 'bun run.ts --dry-run ', CI_LIVE_CWD, true],
      ['a bare ./run.ts in a ci-live working directory', 4242, 'bun ./run.ts ', CI_LIVE_CWD, true],
      ['a bare run.ts in another working directory', 4242, 'bun run.ts ', WORKTREE, false],
      ['a bare run.ts whose working directory cannot be read', 4242, 'bun run.ts ', null, false],
      ['ci-live/run.tsx', 4242, 'bun ci-live/run.tsx ', WORKTREE, false],
      ['a bare run.tsx in a ci-live working directory', 4242, 'bun run.tsx ', CI_LIVE_CWD, false],
      ['a /ci runner', 4242, `bun ${WORKTREE}/${RUNNER_PATH_SUFFIX} ${RUN_ID} `, WORKTREE, false],
      ['another program', 4242, 'sleep 600 ', WORKTREE, false],
      ['a gone PID: no command line', 4242, null, null, false],
      ['a PID of 0', 0, RUNNER_CMDLINE, WORKTREE, false],
      ['a PID below 0', -4242, RUNNER_CMDLINE, WORKTREE, false],
      ['a PID that is not whole', 4242.5, RUNNER_CMDLINE, WORKTREE, false],
    ] satisfies [string, number, string | null, string | null, boolean][])(
      'the runner test answers as isLiveRunnerPid does: %s',
      (_name, pid, cmdline, cwd, runner) => {
        const readCmdline = (): string | null => cmdline
        const readCwd = (): string | null => cwd
        expect(isLiveRunnerPid(pid, readCmdline, readCwd)).toBe(runner)
        expect(isCiLiveRunnerPid(pid, readCmdline, readCwd)).toBe(runner)
      },
    )
  })

  // -------------------------------------------------------------------------
  // T7.S4: /ci-live detection and its untouched lock files (b.uqm SR-6.6; AC 18)
  // -------------------------------------------------------------------------

  describe('/ci-live detection and its untouched lock files (b.uqm SR-6.6)', () => {
    const activeRows: [string, (rig: AdmissionRig) => CiLiveRunSeen[]][] = [
      [
        'a held real-run lock',
        (rig) => [{ via: 'real-run-lock', what: rig.ciLive.realRunLock, pid: holdRealRunLock(rig) }],
      ],
      [
        'a held real-run lock whose runner was started as a bare run.ts in its ci-live directory',
        (rig) => [{ via: 'real-run-lock', what: rig.ciLive.realRunLock, pid: holdRealRunLock(rig, 'bare-runner-in-ci-live') }],
      ],
      [
        'a held dry-run lock in the directory the runner\'s environment names',
        (rig) => {
          const { pid, path } = holdDryRunLock(rig)
          return [{ via: 'dry-run-lock', what: path, pid }]
        },
      ],
      [
        'a running cscb-live=1 container with no lock',
        (rig) => {
          const pid = rig.processes.allocatePid()
          return [{ via: 'container', what: addCiLiveContainer(rig.docker, { ownerPid: pid }).name, pid }]
        },
      ],
    ]

    test.each(activeRows)('%s shows an active /ci-live run', async (_name, setUp) => {
      const rig = makeAdmission()
      const expected = setUp(rig)

      const figures = await rig.figures()

      expect(figures.readings.ciLive.runs).toEqual(expected)
    })

    const inactiveRows: [string, (rig: AdmissionRig) => void][] = [
      ['no lock file and no container', () => undefined],
      ['a real-run lock naming a gone PID', (rig) => holdRealRunLock(rig, 'gone')],
      ['a real-run lock naming a live /ci runner', (rig) => holdRealRunLock(rig, 'ci-runner')],
      ['a real-run lock naming another program', (rig) => holdRealRunLock(rig, 'other-program')],
      ['a real-run lock naming a bare run.ts started outside a ci-live directory', (rig) => holdRealRunLock(rig, 'bare-runner-elsewhere')],
      ['a real-run lock naming no PID', (rig) => writeFileSync(rig.ciLive.realRunLock, 'not a pid\n')],
      ['a dry-run lock naming a gone PID', (rig) => holdDryRunLock(rig, 'gone')],
      ['a dry-run lock naming another program', (rig) => holdDryRunLock(rig, 'other-program')],
      [
        'a held dry-run lock in TMP\'s directory while TMPDIR names another',
        (rig) => {
          const pid = addCiLiveLockHolder(rig.processes, 'runner-by-path')
          const lock = makeDryRunLock(rig.dir, { uid: RUNNER_UID, spellings: { TMPDIR: 'set', TMP: 'set' }, lockIn: 'TMP', lockText: ciLiveLockText(pid) })
          Object.assign(rig.env, lock.env)
        },
      ],
      ['a stopped cscb-live=1 container', (rig) => addCiLiveContainer(rig.docker, { ownerPid: rig.processes.allocatePid(), running: false })],
    ]

    test.each(inactiveRows)('%s shows no active run, adds 0 bytes and leaves C at 85% of L', async (_name, setUp) => {
      const rig = makeAdmission()
      setUp(rig)

      const figures = await rig.figures()

      expect(figures.readings.ciLive).toEqual({ runs: [], heldLocks: [], loneContainers: [] })
      expect(figures.commitments.items).toEqual([])
      expect(figures.commitments.totalBytes).toBe(0)
      expect(figures.ceiling.source.kind).toBe('pod-limit')
    })

    test('CSCB_LIVE_CONFIG_DIR never moves the real-run lock: a held run.lock in the directory it names is not seen, the default one is', async () => {
      const rig = makeAdmission()
      const pid = addCiLiveLockHolder(rig.processes, 'runner-by-path')
      const override = makeCiLiveConfigOverride(rig.dir, ciLiveLockText(pid))
      Object.assign(rig.env, override.env)

      expect((await rig.figures()).readings.ciLive.runs).toEqual([])

      writeFileSync(rig.ciLive.realRunLock, ciLiveLockText(pid))
      expect((await rig.figures()).readings.ciLive.runs).toEqual([{ via: 'real-run-lock', what: rig.ciLive.realRunLock, pid }])
    })

    test('$HOME never names the home (b.uqm SR-6.1): a held run.lock in the home $HOME names is not seen, the one in the home admission is given is', async () => {
      const rig = makeAdmission()
      const pid = addCiLiveLockHolder(rig.processes, 'runner-by-path')
      const decoy = makeCiLiveHome(join(rig.dir, 'decoy'), ciLiveLockText(pid))
      rig.env.HOME = decoy.home
      expect(decoy.home).not.toBe(rig.input.home)
      expect(existsSync(rig.ciLive.realRunLock)).toBe(false)

      expect((await rig.figures()).readings.ciLive).toEqual({ runs: [], heldLocks: [], loneContainers: [] })

      writeFileSync(rig.ciLive.realRunLock, ciLiveLockText(pid))
      expect((await rig.figures()).readings.ciLive.runs).toEqual([{ via: 'real-run-lock', what: rig.ciLive.realRunLock, pid }])
    })

    test.each([
      ['both locks held by live /ci-live runners and flock-held while admission reads them', true],
      ['neither lock file present', false],
    ])('an admission that reads both locks leaves each unchanged, neither takes nor waits on a lock on it, and holds none: %s', async (_name, held) => {
      const rig = makeAdmission()
      const heldPaths = held ? [rig.ciLive.realRunLock, holdDryRunLock(rig).path] : []
      if (held) writeFileSync(rig.ciLive.realRunLock, ciLiveLockText(addCiLiveLockHolder(rig.processes, 'runner-by-path')))
      const lockPaths = [rig.ciLive.realRunLock, ciLiveDryRunLockPath(rig.env, RUNNER_UID)]
      const watched = [rig.ciLive.configDir, dirname(lockPaths[1]!)]
      for (const dir of watched) expect(dir.startsWith(`${rig.dir}/`)).toBe(true)
      // As a live /ci-live run holds them: a runner that tried to lock either would fail or block here.
      const holders: FlockHolder[] = []
      try {
        if (held) for (const path of lockPaths) holders.push(holdFlock(path))
        const before = watched.map((dir) => treeSnapshot(dir, { extended: true }))

        // Admission completes: every reading succeeds (`figures` throws on a failed one) and a decision is made.
        const figures = await rig.figures()
        decideAdmission(figures, defaultFullRun(), rig.listResultsDirs)

        expect(figures.readings.ciLive.heldLocks.map((lock) => lock.path)).toEqual(heldPaths)
        expect(watched.map((dir) => treeSnapshot(dir, { extended: true }))).toEqual(before)
      } finally {
        for (const holder of holders) holder.release()
      }
      for (const path of lockPaths) {
        if (held) expect(probeFlock(path)).toBe('free')
        else expect(existsSync(path)).toBe(false)
        expect(rig.recorder.argvs().some((argv) => argv.some((arg) => arg.includes(path)))).toBe(false)
      }
      expect(rig.docker.removals()).toEqual([])
      expect(rig.built.volume.paths()).toEqual([rig.input.runDir])
      for (const read of rig.built.cgroups.reads()) expect(read.path?.startsWith(`${rig.built.cgroups.dir}/`)).toBe(true)
    })
  })

  // -------------------------------------------------------------------------
  // T7.S5: the memory commitments and the CPU in use (b.uqm SR-6.6; AC 18's counting)
  // -------------------------------------------------------------------------

  describe('what admission counts (b.uqm SR-6.6)', () => {
    /** One active `/ci-live` run: the sum of the runner's three copied figures. */
    const PER_CI_LIVE_RUN_BYTES = CI_LIVE_CONTAINER_MEMORY_BYTES + CI_LIVE_CHROME_LIMIT_BYTES + CI_LIVE_RUNNER_ALLOWANCE_BYTES
    /** A shard container of LIVE_OWNER that has stopped: never counted against its reservation. */
    const STOPPED_LIVE_SHARD: ContainerGibFigures = { name: `${CI_CONTAINER_NAME_PREFIX}-live-shard-stopped`, labels: ciShardLabels(LIVE_OWNER), capGib: 2, running: false }

    test.each([
      ['a live reservation counts its memory less its owner\'s running shard containers\' current memory', 3, [1.5, 1], true],
      ['a live reservation counts 0 when its running shard containers\' memory exceeds it', 1, [2.5], true],
      ['a reservation whose owner is dead counts nothing', 3, [], false],
    ] satisfies [string, number, number[], boolean][])('%s', async (_name, shards, shardMemoryGib, alive) => {
      const listed = listedReservation({ owner: LIVE_OWNER, shards, ownerAlive: alive })
      const shardContainers = shardMemoryGib.map(
        (memoryGib, index): ContainerGibFigures => ({ name: `${CI_CONTAINER_NAME_PREFIX}-live-shard-${index + 1}`, labels: ciShardLabels(LIVE_OWNER), capGib: 2, memoryGib }),
      )
      const rig = makeAdmission({ reservations: reservationListing({ valid: [listed] }), containers: [...shardContainers, STOPPED_LIVE_SHARD] })

      const { commitments } = await rig.figures()

      if (!alive) {
        expect(commitments.items).toEqual([])
        expect(commitments.totalBytes).toBe(0)
        return
      }
      const shardMemoryBytes = shardMemoryGib.reduce((sum, memoryGib) => sum + gibToBytes(memoryGib), 0)
      const countedBytes = Math.max(0, listed.reservation.memoryBytes - shardMemoryBytes)
      expect(commitments.items).toEqual([
        { kind: 'reservation', fileName: listed.fileName, reservation: listed.reservation, shardContainers: shardContainers.map(({ name }) => name), shardMemoryBytes, countedBytes },
      ])
      expect(commitments.totalBytes).toBe(countedBytes)
    })

    /** One counted `/ci-live` run, as a row expects it. */
    interface ExpectedCiLiveRun {
      readonly run: CiLiveRunSeen
      readonly ownContainers: readonly string[]
    }

    const ciLiveRows: [string, (rig: AdmissionRig) => ExpectedCiLiveRun[]][] = [
      ['a held real-run lock', (rig) => [{ run: { via: 'real-run-lock', what: rig.ciLive.realRunLock, pid: holdRealRunLock(rig) }, ownContainers: [] }]],
      [
        'a held dry-run lock',
        (rig) => {
          const { pid, path } = holdDryRunLock(rig)
          return [{ run: { via: 'dry-run-lock', what: path, pid }, ownContainers: [] }]
        },
      ],
      [
        'a held real-run lock and a held dry-run lock: a real run and a dry run count twice',
        (rig) => {
          const realPid = holdRealRunLock(rig)
          const dry = holdDryRunLock(rig)
          return [
            { run: { via: 'real-run-lock', what: rig.ciLive.realRunLock, pid: realPid }, ownContainers: [] },
            { run: { via: 'dry-run-lock', what: dry.path, pid: dry.pid }, ownContainers: [] },
          ]
        },
      ],
      [
        'a lone running cscb-live=1 container',
        (rig) => {
          const pid = rig.processes.allocatePid()
          return [{ run: { via: 'container', what: addCiLiveContainer(rig.docker, { ownerPid: pid }).name, pid }, ownContainers: [] }]
        },
      ],
      [
        'a held lock with its own container, named with the lock\'s PID: counted once',
        (rig) => {
          const pid = holdRealRunLock(rig)
          const own = addCiLiveContainer(rig.docker, { ownerPid: pid })
          return [{ run: { via: 'real-run-lock', what: rig.ciLive.realRunLock, pid }, ownContainers: [own.name] }]
        },
      ],
      [
        'a held lock and a container carrying another PID: counted twice',
        (rig) => {
          const pid = holdRealRunLock(rig)
          const otherPid = rig.processes.allocatePid()
          const other = addCiLiveContainer(rig.docker, { ownerPid: otherPid })
          return [
            { run: { via: 'real-run-lock', what: rig.ciLive.realRunLock, pid }, ownContainers: [] },
            { run: { via: 'container', what: other.name, pid: otherPid }, ownContainers: [] },
          ]
        },
      ],
      [
        'an older runner\'s bare-named cscb-live container on its own: counted once, with no PID',
        (rig) => [{ run: { via: 'container', what: addCiLiveContainer(rig.docker, { form: 'bare' }).name, pid: null }, ownContainers: [] }],
      ],
    ]

    test.each(ciLiveRows)('/ci-live: %s', async (_name, setUp) => {
      const rig = makeAdmission()
      const expected = setUp(rig)

      const { commitments } = await rig.figures()

      expect(commitments.items).toEqual(expected.map(({ run, ownContainers }) => ({ kind: 'ci-live', run, ownContainers, countedBytes: PER_CI_LIVE_RUN_BYTES })))
      expect(commitments.totalBytes).toBe(expected.length * PER_CI_LIVE_RUN_BYTES)
    })

    const ORPHAN = `${CI_CONTAINER_NAME_PREFIX}-orphan-shard`
    const SCRATCH = `${CI_CONTAINER_NAME_PREFIX}-scratch`

    test.each([
      [
        'a running cscb-ci=1 container with no live reservation counts its cap',
        { name: ORPHAN, labels: ciShardLabels(DEAD_OWNER), capGib: 2.5, memoryGib: 1 },
        [{ kind: 'labelled-container', name: ORPHAN, owner: DEAD_OWNER, countedBytes: gibToBytes(2.5) }],
        [],
      ],
      [
        'an unlabelled cscb-ci* container counts its cap',
        { name: SCRATCH, capGib: 3, memoryGib: 1 },
        [{ kind: 'unlabelled-container', name: SCRATCH, owner: null, countedBytes: gibToBytes(3) }],
        [],
      ],
      [
        'an unlabelled cscb-ci* container with no cap blocks every run and is named, with no owner',
        { name: SCRATCH, capGib: null, memoryGib: 1 },
        [],
        [{ name: SCRATCH, labelled: false, owner: null }],
      ],
      [
        'a cscb-ci=1 container with no live reservation and no cap blocks every run too, with the owner its label names',
        { name: ORPHAN, labels: ciShardLabels(DEAD_OWNER), capGib: null, memoryGib: 1 },
        [],
        [{ name: ORPHAN, labelled: true, owner: DEAD_OWNER }],
      ],
      [
        'a cscb-ci=1 container with no owner label and no cap blocks every run, with no owner',
        { name: ORPHAN, labels: { [CI_LABEL]: CI_LABEL_VALUE }, capGib: null, memoryGib: 1 },
        [],
        [{ name: ORPHAN, labelled: true, owner: null }],
      ],
    ] satisfies [string, ContainerGibFigures, MemoryCommitment[], BlockingContainer[]][])('containers: %s; admission removes none', async (_name, container, items, blocking) => {
      const rig = makeAdmission({ containers: [container] })

      const figures = await rig.figures()
      decideAdmission(figures, defaultFullRun(), rig.listResultsDirs)

      expect(figures.commitments.items).toEqual(items)
      expect(figures.commitments.blocking).toEqual(blocking)
      expect(figures.commitments.totalBytes).toBe(items.length === 0 ? 0 : gibToBytes(container.capGib as number))
      expect(rig.docker.removals()).toEqual([])
      expect(rig.docker.operations('container-kill')).toEqual([])
      expect(rig.docker.container(container.name)?.running).toBe(true)
    })

    test('the CPUs counted are the live reservations\' only: a dead owner\'s reservation and /ci-live add none', async () => {
      const full = listedReservation({ owner: LIVE_OWNER, shards: 2, ownerAlive: true })
      const selective = listedReservation({ owner: OTHER_LIVE_OWNER, shards: 1, kind: 'selective', ownerAlive: true })
      const dead = listedReservation({ owner: DEAD_OWNER, shards: 3, ownerAlive: false })
      const rig = makeAdmission({ reservations: reservationListing({ valid: [full, selective, dead] }) })
      holdRealRunLock(rig)
      addCiLiveContainer(rig.docker, { ownerPid: rig.processes.allocatePid() })

      const { commitments } = await rig.figures()

      expect(commitments.reservedCpus).toBe(full.reservation.cpus + selective.reservation.cpus)
    })
  })

  // -------------------------------------------------------------------------
  // T7.S6: the fits, choosing N and the shard-count line (b.uqm SR-6.7; AC 16, AC 18's W cases, AC 20, AC 35's decision)
  // -------------------------------------------------------------------------

  describe('the fits, choosing N and the shard-count line (b.uqm SR-6.7)', () => {
    /** An unlabelled, capped `cscb-ci*` container: one counted commitment. */
    const CAPPED_SCRATCH = `${CI_CONTAINER_NAME_PREFIX}-capped-scratch`
    /** A pod at the factory's L whose W is exactly `bytes`. */
    const podWithWorkingSet = (bytes: number): PodFigures => ({ limitGib: POD_LIMIT_GIB, workingSetGib: bytes / GIB_BYTES })
    /** A pod at the factory's L whose W is `gib` GiB. */
    const podAt = (gib: number): PodFigures => ({ limitGib: POD_LIMIT_GIB, workingSetGib: gib })
    /** The admitted decision, or a failure naming the refusal. */
    function admittedOf(decision: AdmissionDecision): Extract<AdmissionDecision, { kind: 'admitted' }> {
      if (decision.kind !== 'admitted') throw new Error(`expected an admission, got ${refusalLine(decision.refusal)}`)
      return decision
    }

    // --- Boundaries ---

    test.each([
      [OPTION_RANGE_MIN, 0, true],
      [OPTION_RANGE_MIN, 1, false],
      [MAX_SHARDS, 0, true],
      [MAX_SHARDS, 1, false],
    ])('the memory fit at %p shard(s), W + commitments + N × cap + margin %p byte(s) over C: fits is %p', async (shards, overBytes, fits) => {
      const commitmentGib = 3
      const ceiling = podCeilingBytes()
      const exactW = ceiling - gibToBytes(commitmentGib) - shards * SHARD_MEMORY_CAP_BYTES - ADMISSION_MARGIN_BYTES
      const rig = makeAdmission({ pod: podWithWorkingSet(exactW + overBytes), containers: [{ name: CAPPED_SCRATCH, capGib: commitmentGib }] })

      const figures = await rig.figures()

      expect(figures.ceiling.bytes).toBe(ceiling)
      expect(figures.commitments.totalBytes).toBe(gibToBytes(commitmentGib))
      expect(memoryFits(figures, shards, SHARD_MEMORY_CAP_BYTES)).toBe(fits)
    })

    test('a blocking container fails the memory fit whatever the readings, so the run is refused for memory', async () => {
      const rig = makeAdmission({ containers: [{ name: `${CI_CONTAINER_NAME_PREFIX}-uncapped`, capGib: null }] })

      const figures = await rig.figures()
      const decision = decideAdmission(figures, defaultFullRun(), rig.listResultsDirs)

      expect(figures.readings.beforeWorkingSet.bytes).toBe(0)
      expect(memoryFits(figures, OPTION_RANGE_MIN, SHARD_MEMORY_CAP_BYTES)).toBe(false)
      expect(decision.kind === 'refused' ? decision.failedLimits : decision.kind).toEqual(['memory'])
    })

    /** A 100 GiB volume, and the used bytes at which used + the 1 GiB allowance reaches the disk line exactly. */
    const VOLUME_TOTAL_BYTES = gibToBytes(100)
    const DISK_LINE_USED_BYTES = (VOLUME_TOTAL_BYTES * DISK_LINE_PERCENT) / 100 - DISK_CHECK_ALLOWANCE_BYTES

    test.each([
      ['1 byte below the disk line after adding 1 GiB: admitted', -1, true],
      ['at the disk line: refused with kind disk', 0, false],
    ])('the disk fit, %s', async (_name, offsetBytes, fits) => {
      expect(Number.isSafeInteger(DISK_LINE_USED_BYTES)).toBe(true)
      const usedBytes = DISK_LINE_USED_BYTES + offsetBytes
      const rig = makeAdmission({
        volume: { mountPoint: join(root, 'volume'), usedGib: usedBytes / GIB_BYTES, availableGib: (VOLUME_TOTAL_BYTES - usedBytes) / GIB_BYTES },
      })

      const figures = await rig.figures()
      const decision = decideAdmission(figures, defaultFullRun(), rig.listResultsDirs)

      expect(figures.readings.volume.usedBytes).toBe(usedBytes)
      expect(diskFits(figures.readings.volume)).toBe(fits)
      if (fits) expect(admittedOf(decision).shards).toBe(MAX_SHARDS)
      else {
        expect(decision.kind === 'refused' ? decision.failedLimits : decision.kind).toEqual(['disk'])
        expect(refusalOf(decision).kind).toBe('disk')
      }
    })

    test.each([
      [OPTION_RANGE_MIN, 0, true],
      [OPTION_RANGE_MIN, CPUS_PER_SHARD, false],
      [4, 0, true],
      [4, CPUS_PER_SHARD, false],
    ])(`the CPU fit at %p shard(s), other runs' CPUs + ${CPUS_PER_SHARD}N = ${CI_CPUS} + %p: fits is %p`, (shards, overCpus, fits) => {
      const reservedCpus = CI_CPUS - CPUS_PER_SHARD * shards + overCpus
      expect(cpuFits(reservedCpus, shards)).toBe(fits)
    })

    // --- Choosing N ---

    test('a run with neither --shards nor --inject takes the largest N that passes both fits', async () => {
      const rig = makeAdmission({ pod: podAt(44) })
      const { invocation, request } = requestFor([], MAX_SHARDS)

      const figures = await rig.figures()
      const decision = admittedOf(decideAdmission(figures, request, rig.listResultsDirs))

      expect(canChooseShards(invocation)).toBe(true)
      // SR-6.7's gate eligibility holds by construction; E13 proves it.
      expect(memoryFits(figures, decision.shards, SHARD_MEMORY_CAP_BYTES)).toBe(true)
      expect(memoryFits(figures, decision.shards + 1, SHARD_MEMORY_CAP_BYTES)).toBe(false)
      expect(decision.shards).toBeLessThan(request.effectiveShards)
    })

    test.each([
      ['--shards 4 where 6 would fit: exactly 4', ['--shards', '4'], 40, 4],
      ['--shards 6 where only 4 fit: refused, never cut to 4', ['--shards', '6'], 44, null],
      ['--inject where 6 fit: exactly the effective N', ['--inject', 'kill:1'], 40, MAX_SHARDS],
      ['--inject where only 4 fit: refused, never cut to 4', ['--inject', 'kill:1'], 44, null],
    ] satisfies [string, string[], number, number | null][])('a run given --shards or --inject takes exactly its effective N or is refused: %s', async (_name, args, workingSetGib, shards) => {
      const rig = makeAdmission({ pod: podAt(workingSetGib) })
      const { invocation, request } = requestFor(args, MAX_SHARDS)

      const decision = decideAdmission(await rig.figures(), request, rig.listResultsDirs)

      expect(canChooseShards(invocation)).toBe(false)
      if (shards !== null) expect(admittedOf(decision).shards).toBe(shards)
      else {
        expect(decision.kind === 'refused' ? [decision.judgedShards, decision.failedLimits] : decision.kind).toEqual([request.effectiveShards, ['memory']])
      }
    })

    test('a default run that fits at no N is refused, judged at 1 shard', async () => {
      const rig = makeAdmission({ pod: podAt(53) })

      const decision = decideAdmission(await rig.figures(), defaultFullRun(), rig.listResultsDirs)

      expect(decision.kind === 'refused' ? [decision.judgedShards, decision.failedLimits, decision.figures.largestFittingShards] : decision.kind).toEqual([OPTION_RANGE_MIN, ['memory'], null])
    })

    test.each([
      ['an effective N above r', { requestedShards: 2, units: MAX_SHARDS, effectiveShards: 3 }],
      ['an effective N above the larger of 1 and the units', { requestedShards: MAX_SHARDS, units: 2, effectiveShards: 3 }],
      ['an effective N of 0', { requestedShards: MAX_SHARDS, units: MAX_SHARDS, effectiveShards: 0 }],
    ])('admission throws for an inconsistent request: %s', async (_name, fields) => {
      const rig = makeAdmission()
      const figures = await rig.figures()
      expect(() => decideAdmission(figures, { ...defaultFullRun(), ...fields }, rig.listResultsDirs)).toThrow()
    })

    // --- The worked examples, pinned: at the 2 GiB cap with nothing else counted (b.uqm SR-6.7; AC 16, AC 18) ---

    test('pin: W = 42.3 GiB gives a default full run 5 shards, shards: 5 of 6 with its memory reason', async () => {
      const rig = makeAdmission({ pod: podAt(42.3) })

      const decision = admittedOf(decideAdmission(await rig.figures(), defaultFullRun(), rig.listResultsDirs))
      const line = formatShardCountLine(decision.line)

      expect(decision.shards).toBe(5)
      expect(line).toBe('shards: 5 of 6 (memory: 11.1 GiB free under the 54.4 GiB ceiling)')
      assertNoLeak({ line })
    })

    test('pin: W = 42.3 GiB refuses --shards 6, naming 5 as the largest value that fits', async () => {
      const rig = makeAdmission({ pod: podAt(42.3) })

      const refusal = refusalOf(decideAdmission(await rig.figures(), requestFor(['--shards', '6'], MAX_SHARDS).request, rig.listResultsDirs))

      expect(refusalLine(refusal)).toBe('NOT RUN: memory: 6 shard(s) need 12.0 GiB; 11.1 GiB fits under the 54.4 GiB ceiling')
      expect(refusal.details).toContain(`${LARGEST_FITTING_SHARDS_PREFIX}5`)
      assertNoLeak({ refusal })
    })

    test('pin: W = 33.1 GiB gives a default full run 6 shards', async () => {
      const rig = makeAdmission({ pod: podAt(33.1) })

      const decision = admittedOf(decideAdmission(await rig.figures(), defaultFullRun(), rig.listResultsDirs))
      const line = formatShardCountLine(decision.line)

      expect(decision.shards).toBe(6)
      expect(line).toBe('shards: 6 of 6')
      assertNoLeak({ line })
    })

    test('pin: with a held /ci-live real-run lock, W = 20 GiB gives 3 shards (20 + 13 + 6 + 1 = 40)', async () => {
      const rig = makeAdmission({ pod: podAt(20) })
      holdRealRunLock(rig)

      const decision = admittedOf(decideAdmission(await rig.figures(), defaultFullRun(), rig.listResultsDirs))
      const line = formatShardCountLine(decision.line)

      expect(decision.shards).toBe(3)
      expect(line).toBe('shards: 3 of 6 (memory: 6.0 GiB free under the 40.0 GiB ceiling)')
      assertNoLeak({ line })
    })

    test('pin: with a held /ci-live real-run lock, W = 33 GiB is refused, naming the /ci-live run, the 40 GiB ceiling and its source, and that no shard count fits', async () => {
      const rig = makeAdmission({ pod: podAt(33) })
      const pid = holdRealRunLock(rig)

      const refusal = refusalOf(decideAdmission(await rig.figures(), defaultFullRun(), rig.listResultsDirs))

      expect(refusalLine(refusal)).toBe('NOT RUN: memory: 1 shard(s) need 2.0 GiB; 0.0 GiB fits under the 40.0 GiB ceiling')
      const ceilingLine = refusal.details.find((detail) => detail.includes(CI_LIVE_CEILING_SOURCE_TEXT))
      expect(ceilingLine).toBeDefined()
      for (const named of ['40.0 GiB', rig.ciLive.realRunLock, String(pid)]) expect(ceilingLine).toContain(named)
      expect(refusal.details).toContain(NO_FITTING_SHARDS_TEXT)
      assertNoLeak({ refusal })
    })

    // --- AC 20: /ci test-23 beside an active full run ---

    test.each([
      ['beside a live 5-shard full run it is admitted with 1 shard when memory fits', 5, true],
      ['beside a live 6-shard full run it is refused for CPU, naming that run', 6, false],
    ])('/ci test-23 %s', async (_name, otherShards, admitted) => {
      const other = listedReservation({ owner: LIVE_OWNER, shards: otherShards, ownerAlive: true })
      const shardContainers = Array.from(
        { length: otherShards },
        (_, index): ContainerGibFigures => ({ name: `${CI_CONTAINER_NAME_PREFIX}-live-shard-${index + 1}`, labels: ciShardLabels(LIVE_OWNER), capGib: 2, memoryGib: 1 }),
      )
      const rig = makeAdmission({ pod: podAt(30), reservations: reservationListing({ valid: [other] }), containers: shardContainers })
      const { request } = requestFor([realScriptFileName(23)], 1)

      const figures = await rig.figures()
      const decision = decideAdmission(figures, request, rig.listResultsDirs)

      expect(request.canChooseShards).toBe(true)
      expect(memoryFits(figures, OPTION_RANGE_MIN, SHARD_MEMORY_CAP_BYTES)).toBe(true)
      if (admitted) {
        expect(admittedOf(decision).shards).toBe(OPTION_RANGE_MIN)
        return
      }
      const refusal = refusalOf(decision)
      expect(refusal.kind).toBe('cpu')
      expect(decision.kind === 'refused' ? decision.failedLimits : decision.kind).toEqual(['cpu'])
      expect(refusal.details.some((detail) => detail.includes(LIVE_OWNER.runId))).toBe(true)
      assertNoLeak({ refusal })
    })

    // --- Every form of the shard-count line ---

    /** A line input: n, r and u, the reasons given, f, C and h. */
    const lineInput = (fields: Partial<ShardCountLineInput> & Pick<ShardCountLineInput, 'shards' | 'requestedShards'>): ShardCountLineInput => ({
      units: MAX_SHARDS,
      reasons: [],
      freeBytes: 0,
      ceilingBytes: gibToBytes(50),
      reservedCpus: 0,
      ...fields,
    })

    test.each([
      ['n = r: no reasons', lineInput({ shards: 4, requestedShards: 4 }), 'shards: 4 of 4'],
      ['n = r: no reasons even when one is given', lineInput({ shards: 4, requestedShards: 4, reasons: ['memory'] }), 'shards: 4 of 4'],
      ['the scheduling-unit reason', lineInput({ shards: 3, requestedShards: 5, units: 3, reasons: ['units'] }), 'shards: 3 of 5 (3 scheduling unit(s))'],
      [
        'the memory reason, f to one decimal place',
        lineInput({ shards: 2, requestedShards: 6, reasons: ['memory'], freeBytes: gibToBytes(3.96) }),
        'shards: 2 of 6 (memory: 4.0 GiB free under the 50.0 GiB ceiling)',
      ],
      ['the memory reason with f at 0', lineInput({ shards: 1, requestedShards: 6, reasons: ['memory'] }), 'shards: 1 of 6 (memory: 0.0 GiB free under the 50.0 GiB ceiling)'],
      ['the CPU reason', lineInput({ shards: 1, requestedShards: 6, reasons: ['cpu'], reservedCpus: 10 }), `shards: 1 of 6 (cpu: 10 of ${CI_CPUS} CI CPUs in use)`],
      [
        'every reason, in the order units, memory, CPU whatever order they are given in',
        lineInput({ shards: 2, requestedShards: 6, units: 4, reasons: ['cpu', 'memory', 'units'], freeBytes: gibToBytes(5.5), reservedCpus: 6 }),
        `shards: 2 of 6 (4 scheduling unit(s), memory: 5.5 GiB free under the 50.0 GiB ceiling, cpu: 6 of ${CI_CPUS} CI CPUs in use)`,
      ],
    ] satisfies [string, ShardCountLineInput, string][])('the shard-count line: %s', (_name, input, expected) => {
      const line = formatShardCountLine(input)
      expect(line).toBe(expected)
      assertNoLeak({ line })
    })

    test.each([
      ['a default run', []],
      ['a run given --shards', ['--shards', '3']],
      ['a run given --inject', ['--inject', 'kill:1']],
    ] satisfies [string, string[]][])('the shard-count line of a run that ended before admission: %s', (_name, args) => {
      const { request } = requestFor(args, MAX_SHARDS)
      const line = endedBeforeAdmissionShardCountLine(request.requestedShards)
      expect(line).toBe(`shards: 0 of ${request.requestedShards} (ended before admission)`)
      assertNoLeak({ line })
    })

    test.each([
      ['memory alone fails at n + 1', 44, 0, ['memory']],
      ['CPU alone fails at n + 1', 0, 2, ['cpu']],
      ['memory and CPU both fail at n + 1', 40, 2, ['memory', 'cpu']],
    ] satisfies [string, number, number, ('memory' | 'cpu')[]][])('a chosen N gives only the limits that fail at n + 1, n being the N chosen: %s', async (_name, workingSetGib, otherShards, failing) => {
      const valid = otherShards === 0 ? [] : [listedReservation({ owner: LIVE_OWNER, shards: otherShards, ownerAlive: true })]
      const rig = makeAdmission({ pod: podAt(workingSetGib), reservations: reservationListing({ valid }) })
      // f is C - W - the other runs' reservations (no shard containers run) - the margin; h is their CPUs; n the most shards both allow.
      const freeBytes = podCeilingBytes() - rig.built.pod.workingSetBytes - valid.reduce((sum, { reservation }) => sum + reservation.memoryBytes, 0) - ADMISSION_MARGIN_BYTES
      const heldCpus = valid.reduce((sum, { reservation }) => sum + reservation.cpus, 0)
      const shards = Math.min(MAX_SHARDS, Math.floor(freeBytes / SHARD_MEMORY_CAP_BYTES), Math.floor((CI_CPUS - heldCpus) / CPUS_PER_SHARD))
      const reasons = {
        memory: `memory: ${formatGib(freeBytes)} GiB free under the ${podCeilingGibText()} GiB ceiling`,
        cpu: `cpu: ${heldCpus} of ${CI_CPUS} CI CPUs in use`,
      }

      const decision = admittedOf(decideAdmission(await rig.figures(), defaultFullRun(), rig.listResultsDirs))
      const line = formatShardCountLine(decision.line)

      expect(shards).toBeLessThan(MAX_SHARDS)
      expect(line).toBe(`shards: ${shards} of ${MAX_SHARDS} (${failing.map((reason) => reasons[reason]).join(', ')})`)
      assertNoLeak({ line })
    })

    test.each([
      ['/ci --shards 4 test-3 test-23 gives shards: 2 of 4 (2 scheduling unit(s))', () => ['--shards', '4', realScriptFileName(3), realScriptFileName(23)], 2, 48, 'shards: 2 of 4 (2 scheduling unit(s))'],
      ['an --inject run over 3 units', () => ['--inject', 'kill:1'], 3, 46, 'shards: 3 of 6 (3 scheduling unit(s))'],
    ] satisfies [string, () => string[], number, number, string][])(
      'a --shards or --inject run that reached admission shows only the unit reason, though memory would not fit one more shard: %s',
      async (_name, args, units, workingSetGib, expected) => {
        const rig = makeAdmission({ pod: podAt(workingSetGib) })
        const { request } = requestFor(args(), units)

        const figures = await rig.figures()
        const decision = admittedOf(decideAdmission(figures, request, rig.listResultsDirs))
        const line = formatShardCountLine(decision.line)

        expect(memoryFits(figures, decision.shards + 1, SHARD_MEMORY_CAP_BYTES)).toBe(false)
        expect(line).toBe(expected)
        assertNoLeak({ line })
      },
    )
  })

  // -------------------------------------------------------------------------
  // T7.S7: refusal messages (b.uqm SR-6.8; AC 34, AC 35's message)
  // -------------------------------------------------------------------------

  describe('refusal messages (b.uqm SR-6.8)', () => {
    /** Test data: the volume's mount point, a label only. */
    const MOUNT = '/data-volume'
    /** A volume of 100 GiB with `usedGib` used. */
    const volumeAt = (usedGib: number): AdmissionSpec['volume'] => ({ mountPoint: MOUNT, usedGib, availableGib: 100 - usedGib })
    /** A volume over the disk line. */
    const FULL_VOLUME = volumeAt(90)
    /** Whether this process is root, which reads a directory whatever its mode. */
    const isRoot = process.getuid?.() === 0

    /** Every `<x> GiB` figure of a message has one decimal place; the disk summary's `this run's 1 GiB` is SR-6.8's own wording. */
    function expectGibToOneDecimal(lines: readonly string[]): void {
      const allowance = `this run's ${DISK_CHECK_ALLOWANCE_BYTES / GIB_BYTES} GiB`
      for (const line of lines) {
        for (const match of line.replace(allowance, '').matchAll(/(\d+(?:\.\d+)?) GiB/g)) expect(match[1]).toMatch(/^\d+\.\d$/)
      }
    }

    /** Checks every message: GiB figures to one decimal place, and no credential leaks. */
    function checkMessage(refusal: Refusal): string[] {
      const lines = refusalLines(refusal)
      expectGibToOneDecimal(lines)
      assertNoLeak({ refusal, lines })
      return lines
    }

    /** The one detail line that holds `marker`. */
    function detailWith(refusal: Refusal, marker: string): string {
      const found = refusal.details.filter((detail) => detail.includes(marker))
      expect(found).toHaveLength(1)
      return found[0] ?? ''
    }

    // --- Memory ---

    /** Test data: the `--shards` value a refused row asks for. */
    const REQUESTED_SHARDS = 3

    test.each([
      ['a default run, judged at 1 shard', [], { workingSetGib: 52.5, anonGib: 20, activeFileGib: 30 }, OPTION_RANGE_MIN],
      ['a --shards run, judged at its effective N', ['--shards', String(REQUESTED_SHARDS)], { workingSetGib: 48, anonGib: 18, activeFileGib: 28 }, REQUESTED_SHARDS],
      ['an --inject run, judged at its effective N', ['--inject', 'kill:1'], { workingSetGib: 45, anonGib: 15, activeFileGib: 27.5 }, MAX_SHARDS],
    ] satisfies [string, string[], Omit<PodFigures, 'limitGib'>, number][])(
      'the memory refusal of %s: its first line, W split, nothing else counted, the margin and cap, the largest value that fits and the advice',
      async (_name, args, pod, judged) => {
        const rig = makeAdmission({ pod: { limitGib: POD_LIMIT_GIB, ...pod } })
        // Nothing else is counted and no CPUs are held, so f is C - W - the margin, and the largest value that fits is the most f holds.
        const freeBytes = podCeilingBytes() - rig.built.pod.workingSetBytes - ADMISSION_MARGIN_BYTES
        const largest = Math.min(MAX_SHARDS, Math.floor(freeBytes / SHARD_MEMORY_CAP_BYTES))

        const refusal = refusalOf(decideAdmission(await rig.figures(), requestFor(args, MAX_SHARDS).request, rig.listResultsDirs))
        checkMessage(refusal)

        expect(largest).toBeLessThan(judged)
        expect(refusalLine(refusal)).toBe(
          `${NOT_RUN_PREFIX}memory: ${judged} shard(s) need ${formatGib(judged * SHARD_MEMORY_CAP_BYTES)} GiB; ${formatGib(freeBytes)} GiB fits under the ${podCeilingGibText()} GiB ceiling`,
        )
        const w = rig.built.pod
        const split = detailWith(refusal, `anon ${formatGib(w.anonBytes)} GiB`)
        for (const part of [`${formatGib(w.workingSetBytes)} GiB`, `active page cache ${formatGib(w.activeFileBytes)} GiB`, `the rest ${formatGib(w.restBytes)} GiB`]) expect(split).toContain(part)
        detailWith(refusal, NOTHING_ELSE_COUNTED_TEXT)
        const margin = detailWith(refusal, 'margin')
        for (const part of [`${formatGib(ADMISSION_MARGIN_BYTES)} GiB`, 'cap', `${formatGib(SHARD_MEMORY_CAP_BYTES)} GiB`]) expect(margin).toContain(part)
        expect(refusal.details).toContain(largest < OPTION_RANGE_MIN ? NO_FITTING_SHARDS_TEXT : `${LARGEST_FITTING_SHARDS_PREFIX}${largest}`)
        expect(refusal.details.at(-1)).toBe(MEMORY_REFUSAL_ADVICE)
      },
    )

    test.each([
      ['85% of the pod limit', 53, () => ({ marker: POD_LIMIT_CEILING_SOURCE_TEXT, named: [`${podCeilingGibText()} GiB, ${MEMORY_CEILING_PERCENT}% of the ${formatGib(gibToBytes(POD_LIMIT_GIB))} GiB pod limit, ${POD_LIMIT_CEILING_SOURCE_TEXT}`] })],
      [
        '/ci-live\'s line, shown by the real-run lock and its PID',
        30,
        (rig: AdmissionRig) => ({ marker: CI_LIVE_CEILING_SOURCE_TEXT, named: [`${ciLiveCeilingGibText()} GiB, ${CI_LIVE_CEILING_SOURCE_TEXT}`, rig.ciLive.realRunLock, String(holdRealRunLock(rig))] }),
      ],
      [
        '/ci-live\'s line, shown by the dry-run lock and its PID',
        30,
        (rig: AdmissionRig) => {
          const { pid, path } = holdDryRunLock(rig)
          return { marker: CI_LIVE_CEILING_SOURCE_TEXT, named: [`${ciLiveCeilingGibText()} GiB, ${CI_LIVE_CEILING_SOURCE_TEXT}`, path, String(pid)] }
        },
      ],
      [
        '/ci-live\'s line, shown by a cscb-live=1 container and its PID',
        30,
        (rig: AdmissionRig) => {
          const pid = rig.processes.allocatePid()
          const { name } = addCiLiveContainer(rig.docker, { ownerPid: pid })
          return { marker: CI_LIVE_CEILING_SOURCE_TEXT, named: [`${ciLiveCeilingGibText()} GiB, ${CI_LIVE_CEILING_SOURCE_TEXT}`, name, String(pid)] }
        },
      ],
    ] satisfies [string, number, (rig: AdmissionRig) => { marker: string; named: string[] }][])('the memory refusal names the ceiling and its source: %s', async (_name, workingSetGib, setUp) => {
      const rig = makeAdmission({ pod: { limitGib: POD_LIMIT_GIB, workingSetGib } })
      const { marker, named } = setUp(rig)

      const refusal = refusalOf(decideAdmission(await rig.figures(), defaultFullRun(), rig.listResultsDirs))
      checkMessage(refusal)

      const ceilingLine = detailWith(refusal, marker)
      for (const part of named) expect(ceilingLine).toContain(part)
    })

    test('the memory refusal lists each counted run and container with its GiB, and each uncapped container as blocking every run: an unlabelled one /ci never removes, a labelled one a later sweep removes', async () => {
      const live = listedReservation({ owner: LIVE_OWNER, shards: 2, ownerAlive: true })
      const liveShard = `${CI_CONTAINER_NAME_PREFIX}-live-shard-1`
      const orphan = `${CI_CONTAINER_NAME_PREFIX}-orphan-shard`
      const scratch = `${CI_CONTAINER_NAME_PREFIX}-capped-scratch`
      const uncapped = `${CI_CONTAINER_NAME_PREFIX}-uncapped`
      /** Uncapped cscb-ci=1 containers with no live reservation: with a valid owner label, with none, and with a malformed one. */
      const blockedOwned = `${CI_CONTAINER_NAME_PREFIX}-blocked-owned`
      const blockedUnowned = `${CI_CONTAINER_NAME_PREFIX}-blocked-unowned`
      const blockedMisowned = `${CI_CONTAINER_NAME_PREFIX}-blocked-misowned`
      const rig = makeAdmission({
        pod: { limitGib: POD_LIMIT_GIB, workingSetGib: 10 },
        reservations: reservationListing({ valid: [live] }),
        containers: [
          { name: liveShard, labels: ciShardLabels(LIVE_OWNER), capGib: 2, memoryGib: 1.5 },
          { name: orphan, labels: ciShardLabels(DEAD_OWNER), capGib: 2.5, memoryGib: 1 },
          { name: scratch, capGib: 3, memoryGib: 1 },
          { name: uncapped, capGib: null, memoryGib: 1 },
          { name: blockedOwned, labels: ciShardLabels(DEAD_OWNER), capGib: null, memoryGib: 1 },
          { name: blockedUnowned, labels: { [CI_LABEL]: CI_LABEL_VALUE }, capGib: null, memoryGib: 1 },
          { name: blockedMisowned, labels: { [CI_LABEL]: CI_LABEL_VALUE, [OWNER_LABEL]: 'not-an-owner' }, capGib: null, memoryGib: 1 },
        ],
      })
      const pid = holdRealRunLock(rig)

      const figures = await rig.figures()
      const refusal = refusalOf(decideAdmission(figures, defaultFullRun(), rig.listResultsDirs))
      checkMessage(refusal)

      expect(refusal.kind).toBe('memory')
      detailWith(refusal, `${formatGib(figures.commitments.totalBytes)} GiB`)
      expect(detailWith(refusal, LIVE_OWNER.runId)).toContain(`${formatGib(live.reservation.memoryBytes - gibToBytes(1.5))} GiB`)
      expect(detailWith(refusal, `${formatGib(CI_LIVE_RUN_COMMITMENT_BYTES)} GiB`)).toContain(String(pid))
      expect(detailWith(refusal, orphan)).toContain(`${formatGib(gibToBytes(2.5))} GiB`)
      expect(detailWith(refusal, scratch)).toContain(`${formatGib(gibToBytes(3))} GiB`)
      const blocking = detailWith(refusal, uncapped)
      for (const part of [BLOCKING_EVERY_RUN_TEXT, UNCAPPED_CI_CONTAINER_TEXT, CI_NEVER_REMOVES_TEXT]) expect(blocking).toContain(part)
      for (const [name, owner] of [
        [blockedOwned, `owner ${formatOwner(DEAD_OWNER)}`],
        [blockedUnowned, NO_VALID_OWNER_LABEL_TEXT],
        [blockedMisowned, NO_VALID_OWNER_LABEL_TEXT],
      ] as const) {
        const labelled = detailWith(refusal, name)
        expect(labelled).toBe(`${BLOCKING_EVERY_RUN_TEXT}: container ${name}, ${UNCAPPED_LABELLED_CONTAINER_TEXT} (${owner}); ${CI_SWEEP_REMOVES_TEXT}`)
        expect(labelled).not.toContain(CI_NEVER_REMOVES_TEXT)
      }
      expect(refusal.details).toContain(NO_FITTING_SHARDS_TEXT)
      expect(rig.docker.removals()).toEqual([])
    })

    // --- Disk ---

    test.each([
      ['p and q rounded up to the nearest tenth', 90.26, '90.3', '91.3'],
      ['p and q rounded down to the nearest tenth', 84.04, '84.0', '85.0'],
    ])('the disk refusal\'s first line, %s, then the volume\'s used and total GiB, the advice and the Docker note', async (_name, usedGib, p, q) => {
      const rig = makeAdmission({ volume: volumeAt(usedGib) })

      const refusal = refusalOf(decideAdmission(await rig.figures(), defaultFullRun(), rig.listResultsDirs))
      checkMessage(refusal)

      expect(refusalLine(refusal)).toBe(
        `${NOT_RUN_PREFIX}disk: ${MOUNT} is ${p}% used; this run's ${DISK_CHECK_ALLOWANCE_BYTES / GIB_BYTES} GiB would take it to ${q}%, at or over /ci's ${DISK_LINE_PERCENT}% disk line`,
      )
      const volume = rig.built.volumeReading as VolumeReading
      const usage = detailWith(refusal, `${formatGib(volume.usedBytes)} GiB`)
      expect(usage).toContain(`${formatGib(volume.usedBytes + volume.availableBytes)} GiB`)
      expect(refusal.details.slice(-2)).toEqual([DISK_REFUSAL_ADVICE, DOCKER_STORAGE_NOTE])
    })

    test('the disk refusal lists the new-style and legacy results directories, largest first with their sizes, and nothing else', async () => {
      const rig = makeAdmission({ volume: FULL_VOLUME })
      const { tempDir } = rig
      const legacy = makeResultsDir(tempDir, { style: 'legacy', bytes: gibToBytes(5) })
      const newer = makeResultsDir(tempDir, { style: 'new', runId: '20261007t090000z-kept0001', bytes: gibToBytes(3) })
      // A link inside it to the 5 GiB legacy directory, which sizing must not follow.
      const linked = makeResultsDir(tempDir, { style: 'new', runId: '20261007t080000z-kept0002', bytes: gibToBytes(1), linkOut: legacy })
      const excluded = [
        makeResultsDir(tempDir, { style: 'new', runId: '20261007t070000z-link0003', bytes: gibToBytes(4), kind: 'symlink' }),
        join(tempDir, resultsDirName({ style: 'legacy', digits: '1759900000', six: 'zzzzzz', bytes: 0 })),
        join(tempDir, `${RUN_DIR_PREFIX}notes`),
      ]
      writeFileSync(excluded[1]!, 'a file named like a results directory\n')
      mkdirSync(excluded[2]!)

      const refusal = refusalOf(decideAdmission(await rig.figures(), defaultFullRun(), rig.listResultsDirs))
      checkMessage(refusal)

      const listed = [legacy, newer, linked].map((path) => refusal.details.findIndex((detail) => detail.includes(path)))
      expect(listed.every((index) => index >= 0)).toBe(true)
      expect([...listed].sort((a, b) => a - b)).toEqual(listed)
      expect(refusal.details[listed[0]!]).toContain(`${formatGib(gibToBytes(5))} GiB`)
      expect(refusal.details[listed[1]!]).toContain(`${formatGib(gibToBytes(3))} GiB`)
      expect(refusal.details[listed[2]!]).toContain(`${formatGib(gibToBytes(1))} GiB`)
      for (const path of excluded) expect(refusal.details.some((detail) => detail.includes(path))).toBe(false)
    })

    test.each([
      [
        'no results directory in the temp directory',
        (rig: AdmissionRig) => ({ lister: rig.listResultsDirs, named: [`${NO_RESULTS_DIRECTORIES_TEXT} ${rig.tempDir}`] }),
      ],
      [
        'a temp directory that cannot be listed',
        (rig: AdmissionRig) => {
          rig.env.TMPDIR = join(rig.dir, 'missing-temp-dir')
          return { lister: rig.listResultsDirs, named: [rig.env.TMPDIR, RESULTS_LISTING_FAILED_TEXT] }
        },
      ],
      [
        'a lister that throws',
        () => ({
          lister: (): never => {
            throw new Error('listing exploded')
          },
          named: [UNKNOWN_TEMP_DIR_TEXT, RESULTS_LISTING_FAILED_TEXT],
        }),
      ],
    ] satisfies [string, (rig: AdmissionRig) => { lister: ResultsDirectoryLister; named: string[] }][])('the disk refusal still lists what it can: %s', async (_name, setUp) => {
      const rig = makeAdmission({ volume: FULL_VOLUME })
      const { lister, named } = setUp(rig)

      const refusal = refusalOf(decideAdmission(await rig.figures(), defaultFullRun(), lister))
      checkMessage(refusal)

      const line = detailWith(refusal, named[0]!)
      for (const part of named) expect(line).toContain(part)
      expect(refusal.details.slice(-2)).toEqual([DISK_REFUSAL_ADVICE, DOCKER_STORAGE_NOTE])
    })

    test.skipIf(isRoot)('the disk refusal gives a results directory it can size only in part as a lower bound (skipped as root, which reads any directory)', async () => {
      const rig = makeAdmission({ volume: FULL_VOLUME })
      const dir = makeResultsDir(rig.tempDir, { style: 'new', runId: '20261007t090000z-part0001', bytes: gibToBytes(2) })
      const locked = join(dir, 'locked')
      mkdirSync(locked)
      chmodSync(locked, 0o000)
      try {
        const refusal = refusalOf(decideAdmission(await rig.figures(), defaultFullRun(), rig.listResultsDirs))
        checkMessage(refusal)

        const line = detailWith(refusal, dir)
        for (const part of [PART_UNREADABLE_TEXT, locked]) expect(line).toContain(part)
      } finally {
        chmodSync(locked, 0o700)
      }
    })

    // --- CPU ---

    test.each([
      [
        'a --shards run beside a full and a selective run',
        ['--shards', String(REQUESTED_SHARDS)],
        () => [listedReservation({ owner: LIVE_OWNER, shards: 3, ownerAlive: true }), listedReservation({ owner: OTHER_LIVE_OWNER, shards: 1, kind: 'selective', ownerAlive: true })],
        REQUESTED_SHARDS,
      ],
      [
        'a default run beside a full-width run, judged at 1 shard',
        [],
        () => [listedReservation({ owner: LIVE_OWNER, shards: MAX_SHARDS, ownerAlive: true })],
        OPTION_RANGE_MIN,
      ],
    ] satisfies [string, string[], () => ReturnType<typeof listedReservation>[], number][])(
      'the CPU refusal of %s: its first line, each active run with its five fields, the largest value that fits and the advice',
      async (_name, args, reservations, judged) => {
        const valid = reservations()
        const rig = makeAdmission({ reservations: reservationListing({ valid }) })
        // W is 0, so memory allows every N: the largest value that fits is the most shards the CI CPUs the other runs leave free allow.
        const heldCpus = valid.reduce((sum, { reservation }) => sum + reservation.cpus, 0)
        const largest = Math.min(MAX_SHARDS, Math.floor((CI_CPUS - heldCpus) / CPUS_PER_SHARD))

        const refusal = refusalOf(decideAdmission(await rig.figures(), requestFor(args, MAX_SHARDS).request, rig.listResultsDirs))
        checkMessage(refusal)

        expect(largest).toBeLessThan(judged)
        expect(refusalLine(refusal)).toBe(
          `${NOT_RUN_PREFIX}cpu: ${judged} shard(s) need ${judged * CPUS_PER_SHARD} CPUs; active /ci runs hold ${heldCpus} of the ${CI_CPUS} CI CPUs`,
        )
        for (const { reservation } of valid) {
          const line = detailWith(refusal, reservation.runId)
          for (const part of [`${reservation.pid}`, `${reservation.shards} shard`, `${reservation.cpus} CPUs`, reservation.kind]) expect(line).toContain(part)
        }
        expect(refusal.details).toContain(largest < OPTION_RANGE_MIN ? NO_FITTING_SHARDS_TEXT : `${LARGEST_FITTING_SHARDS_PREFIX}${largest}`)
        expect(refusal.details.at(-1)).toBe(CPU_REFUSAL_ADVICE)
      },
    )

    // --- Several limits at once ---

    /** The index of the one detail line that opens with `<kind>: `; -1 when none does. */
    function partIndex(refusal: Refusal, kind: 'disk' | 'cpu'): number {
      const found = refusal.details.flatMap((detail, index) => (detail.startsWith(`${kind}: `) ? [index] : []))
      expect(found.length).toBeLessThanOrEqual(1)
      return found[0] ?? -1
    }

    test('memory, disk and CPU all failing: memory gives the kind and summary, then disk and CPU follow as <kind>: <summary> lines with their details, in that order', async () => {
      const rig = makeAdmission({
        pod: { limitGib: POD_LIMIT_GIB, workingSetGib: 45 },
        volume: FULL_VOLUME,
        reservations: reservationListing({ valid: [listedReservation({ owner: LIVE_OWNER, shards: 6, ownerAlive: true })] }),
      })

      const decision = decideAdmission(await rig.figures(), defaultFullRun(), rig.listResultsDirs)
      const refusal = refusalOf(decision)
      checkMessage(refusal)

      expect(decision.kind === 'refused' ? decision.failedLimits : decision.kind).toEqual(['memory', 'disk', 'cpu'])
      expect(refusal.kind).toBe('memory')
      const disk = partIndex(refusal, 'disk')
      const cpu = partIndex(refusal, 'cpu')
      expect(refusal.details[disk]).toStartWith(`disk: ${MOUNT} is `)
      expect(refusal.details[cpu]).toBe(`cpu: ${OPTION_RANGE_MIN} shard(s) need ${OPTION_RANGE_MIN * CPUS_PER_SHARD} CPUs; active /ci runs hold ${MAX_SHARDS * CPUS_PER_SHARD} of the ${CI_CPUS} CI CPUs`)
      const order = [MEMORY_REFUSAL_ADVICE, refusal.details[disk]!, DISK_REFUSAL_ADVICE, DOCKER_STORAGE_NOTE, refusal.details[cpu]!, CPU_REFUSAL_ADVICE].map((line) =>
        refusal.details.indexOf(line),
      )
      expect(order.every((index) => index >= 0)).toBe(true)
      expect([...order].sort((a, b) => a - b)).toEqual(order)
      expect(refusal.details.at(-1)).toBe(CPU_REFUSAL_ADVICE)
    })

    test.each([
      ['memory and CPU', [], 45, volumeAt(10), 6, ['memory', 'cpu'], false],
      ['memory and disk', [], 53, FULL_VOLUME, 0, ['memory', 'disk'], false],
      // Disk does not depend on N, so the CPU part still names the largest --shards value the memory and CPU fits allow.
      ['disk and CPU, the CPU part still naming a value that fits', ['--shards', '4'], 0, FULL_VOLUME, 3, ['disk', 'cpu'], true],
    ] satisfies [string, string[], number, AdmissionSpec['volume'], number, ('memory' | 'disk' | 'cpu')[], boolean][])(
      'two limits failing keep the order memory, disk, CPU: %s',
      async (_name, args, workingSetGib, volume, otherShards, failed, namesLargest) => {
        const valid = otherShards === 0 ? [] : [listedReservation({ owner: LIVE_OWNER, shards: otherShards, ownerAlive: true })]
        const rig = makeAdmission({ pod: { limitGib: POD_LIMIT_GIB, workingSetGib }, volume, reservations: reservationListing({ valid }) })

        const decision = decideAdmission(await rig.figures(), requestFor(args, MAX_SHARDS).request, rig.listResultsDirs)
        const refusal = refusalOf(decision)
        checkMessage(refusal)

        expect(decision.kind === 'refused' ? decision.failedLimits : decision.kind).toEqual(failed)
        expect(refusal.kind).toBe(failed[0]!)
        const second = failed[1] as 'disk' | 'cpu'
        expect(partIndex(refusal, second)).toBeGreaterThan(0)
        expect(partIndex(refusal, second === 'disk' ? 'cpu' : 'disk')).toBe(-1)
        if (namesLargest) {
          // W is 0, so memory allows every N: the largest value is the most shards the CI CPUs the other run leaves free allow.
          const heldCpus = valid.reduce((sum, { reservation }) => sum + reservation.cpus, 0)
          const largest = Math.min(MAX_SHARDS, Math.floor((CI_CPUS - heldCpus) / CPUS_PER_SHARD))
          const cpu = partIndex(refusal, 'cpu')
          expect(refusal.details.slice(cpu)).toContain(`${LARGEST_FITTING_SHARDS_PREFIX}${largest}`)
        }
      },
    )

    test('a run that can choose its N is judged at 1 shard: refused for memory there, its CPU fit passing at 1 though it would fail at its effective N, it lists memory only', async () => {
      const other = listedReservation({ owner: LIVE_OWNER, shards: 3, ownerAlive: true })
      const rig = makeAdmission({ pod: { limitGib: POD_LIMIT_GIB, workingSetGib: 48 }, reservations: reservationListing({ valid: [other] }) })
      const request = defaultFullRun()

      const decision = decideAdmission(await rig.figures(), request, rig.listResultsDirs)
      const refusal = refusalOf(decision)
      checkMessage(refusal)

      expect(cpuFits(other.reservation.cpus, OPTION_RANGE_MIN)).toBe(true)
      expect(cpuFits(other.reservation.cpus, request.effectiveShards)).toBe(false)
      expect(decision.kind === 'refused' ? [decision.judgedShards, decision.failedLimits] : decision.kind).toEqual([OPTION_RANGE_MIN, ['memory']])
      expect(refusalLine(refusal)).toStartWith(`${NOT_RUN_PREFIX}memory: ${OPTION_RANGE_MIN} shard(s) need `)
      expect(partIndex(refusal, 'cpu')).toBe(-1)
    })
  })
})
