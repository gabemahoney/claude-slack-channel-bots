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
 * lock, reads `.config/cscb-ci` in a real home, reads another process's
 * `/proc` entries or the host's cgroup files, or runs docker: processes come
 * from the fake process table (`tests/test-helpers/ci-run.ts`), and the lock
 * probe is tried only on a lock file inside the case's own root. A process
 * reads only its own `/proc/self`. Children are only `bun -e` scripts, each
 * started with a direct `hostSafeChildEnv` under the case's root, killed at a
 * time limit and in `afterEach`. No case hand-writes a reservation (each is
 * the runner's serializer's text, or that text with one named change) or types
 * a runner constant's value, but for the one pin case of b.uqm SR-6.1's lock
 * path, which types the two names SR-6.1 states.
 *
 * SPDX-License-Identifier: MIT
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
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
// E5's names, kept apart from E1's above.
import {
  accountHomeFrom,
  accountHomeRefusal,
  admissionLockDir,
  admissionLockPath,
  buildReservation,
  busyLockRefusal,
  CI_LIVE_CONTAINER_LABEL,
  CI_LIVE_CONTAINER_LABEL_VALUE,
  formatLockHolder,
  imageListArgs,
  LOCK_DIR_SUBPATH,
  LOCK_FILE_NAME,
  LOCK_POLL_MS,
  LOCK_WAIT_MS,
  ownerLabelledUntaggedImageFilters,
  ownerUntaggedImageFilters,
  parseLockHolder,
  PRUNE_ALREADY_RUNNING_TEXT,
  PRUNE_RETRIES,
  PRUNE_RETRY_INTERVAL_MS,
  readReservations,
  REAL_PASSWORD_FILE,
  removeOwnerUntaggedImages,
  removeReservation,
  resolveAccountHome,
  RUN_DIR_MODE,
  runTaggedImageFilters,
  sweepLeftovers,
  takeAdmissionLock,
  writeReservation,
  WRITTEN_FILE_MODE,
  type AccountHomeResolution,
  type AdmissionLock,
  type DockerContext,
  type LockTake,
  type Refusal,
  type ReservationRequest,
  type RunnerDeps,
  type SpawnFn,
} from '../scripts/ci-run.ts'
import {
  buildLockDir,
  buildRunDirectory,
  createFakeDocker,
  createSpawnRecorder,
  passwordFileCases,
  passwordFileReader,
  writePasswordFile,
  writeUnreadablePasswordFile,
  type BuiltLockDir,
  type BuiltReservation,
  type FakeDocker,
  type FakeDockerOperation,
  type LockDirSpec,
  type ReservationFileChange,
  type SpawnRecorder,
} from './test-helpers/ci-run.ts'
import { assertNoLeak } from './test-helpers/credentials.ts'
import { createFakeClock, type FakeClock } from './test-helpers/fake-clock.ts'
import { hostSafeChildEnv, passwdHomeFrom } from './test-helpers/host-safe-env.ts'
import { callsOf, stripComments } from './test-helpers/source-audit.ts'

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

// --- E5 lane A (T5.S1–S3): the account's home, the lock and reservations ---

describe('E5: the account\'s home, the admission lock and reservations', () => {
  /** Test data: the runner's user ID in the constructed password files. */
  const UID = 4242
  /** Test data: an absolute home used only to name the password-file cases at registration; nothing is read or written there. */
  const CASE_NAMING_HOME = '/nonexistent/e5-case-naming-home'
  /** Test data: RUN_IDs whose owners' names sort EARLY < HOLDER < TAKER < LATE. */
  const EARLY_RUN_ID = '20261008t120000z-e5early0'
  const HOLDER_RUN_ID = '20261008t125900z-e5holder'
  const TAKER_RUN_ID = '20261008t130000z-e5taker0'
  const LATE_RUN_ID = '20261008t140000z-e5late00'
  /** Test data: an owner no process table holds, named inside another owner's reservation file. */
  const STRANGER: Owner = { runId: '20261008t150000z-e5strang', pid: 4243 }
  /** A child process's time limit (it is killed at it), and the time limit of a case that starts one. */
  const CHILD_TIME_LIMIT_MS = 5_000
  const CHILD_CASE_TIMEOUT_MS = 15_000
  /** Test data: libc's flock operations (`<sys/file.h>`) for the child scripts; the runner keeps its own private. */
  const FLOCK_EXCLUSIVE = 2
  const FLOCK_NON_BLOCKING = 4
  const FLOCK_UNLOCK = 8

  /**
   * The other taker in the two-takes cases: loads flock, says `ready`, waits for
   * a line, then opens the lock file (creating it, as the runner may at that
   * moment) and tries an exclusive flock once, answering `taken` or `held`. It
   * holds what it took until its input ends, then unlocks and says `released`.
   */
  const RACING_CHILD_SCRIPT = `
const { dlopen, FFIType } = require('bun:ffi')
const { openSync, constants } = require('node:fs')
const libc = dlopen('libc.so.6', { flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 } })
const input = Bun.stdin.stream().getReader()
;(async () => {
  console.log('ready')
  await input.read()
  const fd = openSync(process.env.CHILD_LOCK_PATH, constants.O_RDWR | constants.O_CREAT, 0o600)
  const taken = libc.symbols.flock(fd, ${FLOCK_EXCLUSIVE} | ${FLOCK_NON_BLOCKING}) === 0
  console.log(taken ? 'taken' : 'held')
  while (!(await input.read()).done) {}
  if (taken) libc.symbols.flock(fd, ${FLOCK_UNLOCK})
  console.log('released')
})()
`

  /**
   * The child in the no-inheritance case: lists its own open descriptors
   * (`/proc/self/fd`, the child's own) and the ones that are the lock file,
   * then, on a fresh descriptor opened after the listing, whether the flock is
   * held; one JSON line.
   */
  const DESCRIPTOR_CHILD_SCRIPT = `
const { readdirSync, readlinkSync, openSync } = require('node:fs')
const { dlopen, FFIType } = require('bun:ffi')
const lockPath = process.env.CHILD_LOCK_PATH
const names = readdirSync('/proc/self/fd')
const onLock = []
for (const name of names) {
  let target = null
  try { target = readlinkSync('/proc/self/fd/' + name) } catch {}
  if (target === lockPath) onLock.push(Number(name))
}
const libc = dlopen('libc.so.6', { flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 } })
const fd = openSync(lockPath, 'r')
const held = libc.symbols.flock(fd, ${FLOCK_EXCLUSIVE} | ${FLOCK_NON_BLOCKING}) !== 0
console.log(JSON.stringify({ listed: names.length, onLock, held }))
`

  /** A take in progress: its outcome once it settles. */
  interface PendingTake {
    outcome: LockTake | undefined
  }

  /** A child process started by `startChild`. */
  interface ChildRig {
    /** Its next stdout line; throws, with its stderr, when it ends first. */
    next(): Promise<string>
    write(text: string): void
    /** Ends its input. */
    end(): void
    readonly exited: Promise<number>
  }

  let root: string
  let processes: FakeProcessTable
  let clock: FakeClock
  let builts: BuiltLockDir[]
  let takes: PendingTake[]
  let children: { kill(signal?: number | NodeJS.Signals): void; readonly exited: Promise<number> }[]

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'ci-run-admission-e5a-'))
    processes = createProcessTable()
    clock = createFakeClock()
    builts = []
    takes = []
    children = []
  })

  afterEach(async () => {
    for (const child of children) child.kill('SIGKILL')
    await Promise.all(children.map((child) => child.exited))
    // Every take still waiting ends at the wait's end, busy or taken, so none keeps its descriptor open.
    await clock.advance(LOCK_WAIT_MS)
    for (const take of takes) if (take.outcome?.kind === 'taken') take.outcome.lock.release()
    for (const built of builts) built.release()
    rmSync(root, { recursive: true, force: true })
  })

  /** A lock directory under the case's root, its owners in the case's process table; its held flock is released in `afterEach`. */
  function build(spec: LockDirSpec = {}): BuiltLockDir {
    const built = buildLockDir(root, { processes, ...spec })
    builts.push(built)
    return built
  }

  /** A live `/ci` runner taking the lock, as its owner. */
  function taker(runId = TAKER_RUN_ID): Owner {
    return { runId, pid: processes.add(ciRunnerProcess(runId, { worktreeRoot: root })) }
  }

  /** Starts a take on the case's fake clock; a lock it takes is released in `afterEach`. */
  function startTake(lockDir: string, holder: Owner): PendingTake {
    const take: PendingTake = { outcome: undefined }
    takes.push(take)
    void takeAdmissionLock(lockDir, holder, clock).then((outcome) => {
      take.outcome = outcome
    })
    return take
  }

  /** A take that must settle with no clock advance and no timer left pending. */
  async function takeAtOnce(lockDir: string, holder: Owner): Promise<LockTake> {
    const before = clock.now()
    const take = startTake(lockDir, holder)
    await clock.flush()
    expect(clock.now()).toBe(before)
    expect(clock.pendingCount()).toBe(0)
    if (take.outcome === undefined) throw new Error('the take did not settle without a clock advance')
    return take.outcome
  }

  function takenLock(outcome: LockTake | undefined): AdmissionLock {
    if (outcome?.kind !== 'taken') throw new Error(`expected the lock taken, found ${JSON.stringify(outcome)}`)
    return outcome.lock
  }

  /** Starts `bun -e script` with a host-safe environment (HOME and TMPDIR under the case's root) and a time limit; ended in `afterEach`. */
  function startChild(script: string, lockPath: string): ChildRig {
    const home = join(root, 'child-home')
    const tempDir = join(root, 'child-tmp')
    mkdirSync(home, { recursive: true })
    mkdirSync(tempDir, { recursive: true })
    const child = Bun.spawn([process.execPath, '-e', script], {
      env: hostSafeChildEnv(home, { tools: [], extras: { TMPDIR: tempDir, CHILD_LOCK_PATH: lockPath } }),
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
      timeout: CHILD_TIME_LIMIT_MS,
      killSignal: 'SIGKILL',
    })
    children.push(child)
    const reader = child.stdout.getReader()
    const decoder = new TextDecoder()
    let buffered = ''
    return {
      async next() {
        for (;;) {
          const at = buffered.indexOf('\n')
          if (at >= 0) {
            const line = buffered.slice(0, at)
            buffered = buffered.slice(at + 1)
            return line
          }
          const chunk = await reader.read()
          if (chunk.done) throw new Error(`the child ended before a line; stdout ${JSON.stringify(buffered)}, stderr ${JSON.stringify(await new Response(child.stderr).text())}`)
          buffered += decoder.decode(chunk.value, { stream: true })
        }
      },
      write(text) {
        child.stdin.write(text)
        void child.stdin.flush()
      },
      end() {
        void child.stdin.end()
      },
      exited: child.exited,
    }
  }

  /** The valid reservation a built file holds, parsed by the runner's parser. */
  function parsedReservation(built: BuiltReservation): Reservation {
    if (built.text === null) throw new Error(`${built.fileName} is no file`)
    const parsed = parseReservation(built.text)
    if (!parsed.ok) throw new Error(`${built.fileName} is no valid reservation: ${parsed.error}`)
    return parsed.value
  }

  /** The parser's refusal of a built file's text: the reason the reader gives for it. */
  function parserRefusal(text: string | null): string {
    if (text === null) throw new Error('a link has no text')
    const parsed = parseReservation(text)
    if (parsed.ok) throw new Error('the text parses')
    return parsed.error
  }

  /** A refusal for the account's home: kind null, naming the user ID and the password file. */
  function expectNamesUidAndPasswordFile(refusal: Refusal): void {
    expect(refusal.kind).toBeNull()
    const text = [refusal.summary, ...refusal.details].join('\n')
    expect(text).toMatch(new RegExp(`\\b${UID}\\b`))
    expect(text).toContain(REAL_PASSWORD_FILE)
    assertNoLeak(refusal)
  }

  // --- T5.S1: the account's home from the password file, the lock path, and the pin case (b.uqm SR-6.1, SR-21.5) ---

  describe('the account\'s home from the password file', () => {
    const caseRows = Object.values(passwordFileCases(UID, CASE_NAMING_HOME))
    const homeCases = caseRows.filter((row) => row.finding === 'home').map((row) => [row.label, row.name] as const)
    const refusedCases = caseRows.filter((row) => row.finding !== 'home').map((row) => [row.label, row.name] as const)

    /** The account's home a case's password file gives, read through the injected dependency. */
    function resolveFrom(text: string): AccountHomeResolution {
      return resolveAccountHome({ uid: UID, readPasswordFile: passwordFileReader(writePasswordFile(root, text)) })
    }

    test.each(homeCases)('the first line for the user ID decides: %s', (_label, name) => {
      const home = join(root, 'account-home')
      const row = passwordFileCases(UID, home)[name]
      expect(resolveFrom(row.text)).toEqual({ ok: true, home })
    })

    test.each(refusedCases)('not runnable, naming the user ID and /etc/passwd: %s', (_label, name) => {
      const row = passwordFileCases(UID, join(root, 'account-home'))[name]
      const finding = row.finding
      if (finding === 'home') throw new Error(`${name} gives a home`)
      const resolved = resolveFrom(row.text)
      expect(resolved).toEqual({ ok: false, refusal: accountHomeRefusal(UID, { kind: finding }) })
      if (!resolved.ok) expectNamesUidAndPasswordFile(resolved.refusal)
    })

    test('not runnable, naming the user ID and /etc/passwd: a password file that cannot be read', () => {
      const readPasswordFile = passwordFileReader(writeUnreadablePasswordFile(root))
      const read = readPasswordFile()
      if (read.ok) throw new Error('the unreadable password file was read')
      const resolved = resolveAccountHome({ uid: UID, readPasswordFile })
      expect(resolved).toEqual({ ok: false, refusal: accountHomeRefusal(UID, { kind: 'unreadable', error: read.error }) })
      if (!resolved.ok) expectNamesUidAndPasswordFile(resolved.refusal)
    })

    test('the lock is .config/cscb-ci/admission.lock under the password-file home, not under the HOME the injected environment names', async () => {
      const home = join(root, 'account-home')
      mkdirSync(home)
      const envHome = join(root, 'env-home')
      mkdirSync(envHome)
      const deps: Pick<RunnerDeps, 'uid' | 'readPasswordFile' | 'env'> = {
        uid: UID,
        readPasswordFile: passwordFileReader(writePasswordFile(root, passwordFileCases(UID, home)['first-match'].text)),
        env: { HOME: envHome },
      }
      const resolved = resolveAccountHome(deps)
      if (!resolved.ok) throw new Error(`no home: ${resolved.refusal.summary}`)
      expect(resolved.home).toBe(home)
      const lockDir = admissionLockDir(resolved.home)
      expect(lockDir).toBe(join(home, LOCK_DIR_SUBPATH))
      expect(admissionLockPath(lockDir)).toBe(join(home, LOCK_DIR_SUBPATH, LOCK_FILE_NAME))
      takenLock(await takeAtOnce(lockDir, taker()))
      expect(statSync(join(home, LOCK_DIR_SUBPATH, LOCK_FILE_NAME)).isFile()).toBe(true)
      expect(readdirSync(envHome)).toEqual([])
    })

    test('pin (b.uqm SR-6.1): the lock path under the account\'s home is .config/cscb-ci/admission.lock, the one path every worktree\'s runner takes', () => {
      expect([LOCK_DIR_SUBPATH, LOCK_FILE_NAME]).toEqual(['.config/cscb-ci', 'admission.lock'])
    })

    test('the runner reads the account\'s home from neither homedir nor userInfo of node:os', () => {
      const code = stripComments(readFileSync(join(import.meta.dir, '..', RUNNER_PATH_SUFFIX), 'utf-8'))
      expect(callsOf(code, 'homedir')).toEqual([])
      expect(callsOf(code, 'userInfo')).toEqual([])
      // Nor by another name: neither is named at all, so no import, alias or os.<name>() call reaches them.
      expect(code).not.toMatch(/\b(?:homedir|userInfo)\b/)
    })

    test('pin (b.uqm SR-21.5): the runner\'s password-file rule gives what passwdHomeFrom gives, row for row, a home or none', () => {
      const rows = [0, 1, UID].flatMap((uid) => Object.values(passwordFileCases(uid, join(root, `home-${uid}`))).map((row) => ({ uid, text: row.text, label: `${uid}: ${row.label}`, home: row.home })))
      // A user ID that is no user ID gives no home by either rule.
      rows.push({ uid: -1, text: passwordFileCases(UID, join(root, 'home'))['first-match'].text, label: '-1: no user ID', home: undefined })
      expect(rows.some((row) => row.home === undefined)).toBe(true)
      expect(rows.map((row) => [row.label, accountHomeFrom(row.text, row.uid)])).toEqual(rows.map((row) => [row.label, passwdHomeFrom(row.text, row.uid)]))
      expect(rows.map((row) => [row.label, accountHomeFrom(row.text, row.uid)])).toEqual(rows.map((row) => [row.label, row.home]))
    })
  })

  // --- T5.S2: the admission lock (b.uqm SR-6.1, SR-6.8's busy lock) ---

  describe('the admission lock', () => {
    test('a missing lock directory and lock file are created 0700 and 0600', async () => {
      const built = build({ layout: 'home-only' })
      expect(existsSync(built.lockDir)).toBe(false)
      takenLock(await takeAtOnce(built.lockDir, taker()))
      expect(statSync(built.lockDir).mode & 0o777).toBe(RUN_DIR_MODE)
      expect(statSync(built.lockPath).isFile()).toBe(true)
      expect(statSync(built.lockPath).mode & 0o777).toBe(WRITTEN_FILE_MODE)
    })

    test('after a take, the lock file records the taker\'s RUN_ID and PID', async () => {
      const built = build()
      const holder = taker()
      takenLock(await takeAtOnce(built.lockDir, holder))
      const text = readFileSync(built.lockPath, 'utf-8')
      expect(text).toBe(formatLockHolder(holder))
      expect(parseLockHolder(text)).toEqual(holder)
    })

    test('after a release, a fresh take succeeds at once, and the lock file stays in place', async () => {
      const built = build()
      const first = takenLock(await takeAtOnce(built.lockDir, taker()))
      first.release()
      expect(probeFlock(built.lockPath)).toBe('free')
      const second = taker(LATE_RUN_ID)
      takenLock(await takeAtOnce(built.lockDir, second))
      expect(readFileSync(built.lockPath, 'utf-8')).toBe(formatLockHolder(second))
    })

    describe('the wait, with a flock held on another descriptor', () => {
      test('the take still waits just before the lock wait ends, and at its end gives the busy refusal naming the RUN_ID and PID the file records', async () => {
        const built = build({ lockFile: { holder: { runId: HOLDER_RUN_ID, alive: true }, held: true } })
        const holder = built.holder
        if (holder === null) throw new Error('no holder recorded')
        const take = startTake(built.lockDir, taker())
        await clock.advance(LOCK_WAIT_MS - 1)
        expect(take.outcome).toBeUndefined()
        expect(clock.pendingCount()).toBe(1)
        await clock.advance(1)
        expect(take.outcome).toEqual({ kind: 'busy', holder, refusal: busyLockRefusal(holder) })
        if (take.outcome?.kind !== 'busy') throw new Error('not busy')
        const refusal = take.outcome.refusal
        expect(refusal.kind).toBeNull()
        expect(refusal.summary).toContain(holder.runId)
        expect(refusal.summary).toMatch(new RegExp(`\\b${holder.pid}\\b`))
        assertNoLeak(refusal)
        // The refused take wrote nothing and left the holder's flock alone.
        expect<string | null>(readFileSync(built.lockPath, 'utf-8')).toBe(built.lockText)
        expect(probeFlock(built.lockPath)).toBe('held')
      })

      test('a release during the wait lets the take succeed at its next try', async () => {
        const built = build({ lockFile: { holder: { runId: HOLDER_RUN_ID, alive: true }, held: true } })
        const holder = taker()
        const take = startTake(built.lockDir, holder)
        await clock.advance(2 * LOCK_POLL_MS)
        expect(take.outcome).toBeUndefined()
        built.release()
        await clock.advance(LOCK_POLL_MS)
        takenLock(take.outcome)
        expect(clock.now()).toBeLessThan(LOCK_WAIT_MS)
        expect(readFileSync(built.lockPath, 'utf-8')).toBe(formatLockHolder(holder))
      })

      test.each([['cut' as const], ['empty' as const], ['second-line' as const]])('a garbled holder record (%s) gives the busy refusal naming an unknown holder', async (change) => {
        const built = build({ lockFile: { holder: { runId: HOLDER_RUN_ID, alive: true }, change, held: true } })
        const take = startTake(built.lockDir, taker())
        await clock.advance(LOCK_WAIT_MS)
        expect(take.outcome).toEqual({ kind: 'busy', holder: null, refusal: busyLockRefusal(null) })
        assertNoLeak(take.outcome)
      })
    })

    test.each([
      ['a dead holder', false],
      ['a live /ci runner', true],
    ])('the flock alone decides: a lock file naming %s, with no flock held, is taken with no clock advance', async (_name, alive) => {
      const built = build({ lockFile: { holder: { runId: HOLDER_RUN_ID, alive } } })
      const holder = taker()
      takenLock(await takeAtOnce(built.lockDir, holder))
      expect(readFileSync(built.lockPath, 'utf-8')).toBe(formatLockHolder(holder))
    })

    /** The lock directories a child process and the runner contend for. */
    const CONTENDED: [string, LockDirSpec][] = [
      ['with no lock file yet', {}],
      ['when the file names a dead holder and no flock is held', { lockFile: { holder: { runId: HOLDER_RUN_ID, alive: false } } }],
    ]

    test.each(CONTENDED)(
      'two takes at once, a child process\'s and the runner\'s, never hold the lock together, %s',
      async (_name, spec) => {
        const built = build(spec)
        const child = startChild(RACING_CHILD_SCRIPT, built.lockPath)
        expect(await child.next()).toBe('ready')
        // Both go now: the child on reading its line, the runner's first try within this call (so the runner nearly always wins; the case below fixes the other order).
        child.write('go\n')
        const holder = taker()
        const take = startTake(built.lockDir, holder)
        const answer = await child.next()
        expect(['taken', 'held']).toContain(answer)
        await clock.flush()
        let childHolds = answer === 'taken'
        const holders = (): number => [childHolds, take.outcome?.kind === 'taken'].filter(Boolean).length
        expect(holders()).toBe(1)
        // A loser that is the runner keeps waiting while the child holds it.
        await clock.advance(LOCK_POLL_MS)
        expect(holders()).toBe(1)
        child.end()
        expect(await child.next()).toBe('released')
        childHolds = false
        expect(await child.exited).toBe(0)
        await clock.advance(LOCK_POLL_MS)
        takenLock(take.outcome)
        expect(readFileSync(built.lockPath, 'utf-8')).toBe(formatLockHolder(holder))
      },
      CHILD_CASE_TIMEOUT_MS,
    )

    test.each(CONTENDED)(
      'when a child process takes the flock first, the runner\'s take waits on the fake clock, writes nothing, and succeeds at its next try after the child lets go, %s',
      async (_name, spec) => {
        const built = build(spec)
        const child = startChild(RACING_CHILD_SCRIPT, built.lockPath)
        expect(await child.next()).toBe('ready')
        // The child goes alone: it holds the flock before the runner's take starts.
        child.write('go\n')
        expect(await child.next()).toBe('taken')
        expect(probeFlock(built.lockPath)).toBe('held')
        const record = readFileSync(built.lockPath, 'utf-8')
        const holder = taker()
        const take = startTake(built.lockDir, holder)
        await clock.flush()
        expect(take.outcome).toBeUndefined()
        expect(clock.pendingCount()).toBe(1)
        await clock.advance(2 * LOCK_POLL_MS)
        expect(take.outcome).toBeUndefined()
        expect(clock.pendingCount()).toBe(1)
        expect(readFileSync(built.lockPath, 'utf-8')).toBe(record)
        child.end()
        expect(await child.next()).toBe('released')
        expect(await child.exited).toBe(0)
        // Nothing moves until the take's next try on the fake clock.
        await clock.flush()
        expect(take.outcome).toBeUndefined()
        await clock.advance(LOCK_POLL_MS)
        takenLock(take.outcome)
        expect(clock.now()).toBe(3 * LOCK_POLL_MS)
        expect(readFileSync(built.lockPath, 'utf-8')).toBe(formatLockHolder(holder))
      },
      CHILD_CASE_TIMEOUT_MS,
    )

    test(
      'a child started while the lock is held holds no descriptor of the lock file, and finds the lock held',
      async () => {
        const built = build()
        takenLock(await takeAtOnce(built.lockDir, taker()))
        const child = startChild(DESCRIPTOR_CHILD_SCRIPT, realpathSync(built.lockPath))
        const report = JSON.parse(await child.next()) as { listed: number; onLock: number[]; held: boolean }
        expect(await child.exited).toBe(0)
        // The child listed its own descriptors (so an inherited one would show), none of them the lock file.
        expect(report.listed).toBeGreaterThan(0)
        expect(report.onLock).toEqual([])
        expect(report.held).toBe(true)
        expect(probeFlock(built.lockPath)).toBe('held')
      },
      CHILD_CASE_TIMEOUT_MS,
    )

    test('the runner opens the lock file close-on-exec: its one descriptor in this process carries O_CLOEXEC', async () => {
      /** Test data: Linux's `O_CLOEXEC` (`<asm-generic/fcntl.h>`), which neither `node:fs` nor `node:os` constants export; the runner keeps its own private. */
      const LINUX_O_CLOEXEC = 0o2000000
      const built = build({ layout: 'home-only' })
      const lock = takenLock(await takeAtOnce(built.lockDir, taker()))
      const lockPath = realpathSync(built.lockPath)
      // This process's own descriptors (Bun.spawn closes every descriptor above 2 in a child, so only this one shows the runner's flag).
      const onLock = readdirSync('/proc/self/fd').filter((name) => {
        try {
          return realpathSync(`/proc/self/fd/${name}`) === lockPath
        } catch {
          return false
        }
      })
      expect(onLock).toHaveLength(1)
      const flagsLine = readFileSync(`/proc/self/fdinfo/${onLock[0]}`, 'utf-8').split('\n').find((line) => line.startsWith('flags:'))
      if (flagsLine === undefined) throw new Error(`no flags line in /proc/self/fdinfo/${onLock[0]}`)
      const flags = Number.parseInt(flagsLine.slice('flags:'.length).trim(), 8)
      expect(flags & LINUX_O_CLOEXEC).toBe(LINUX_O_CLOEXEC)
      lock.release()
    })
  })

  // --- T5.S3: reservations, written, removed and read (b.uqm SR-6.2) ---

  describe('reservations', () => {
    const OWNER: Owner = { runId: TAKER_RUN_ID, pid: 4242 }

    describe('writing', () => {
      test.each([
        ['full' as RunKind, MAX_SHARDS],
        ['selective' as RunKind, OPTION_RANGE_MIN],
      ])('a %s run of %p shards writes <RUN_ID>-<PID>.json holding exactly the stated keys and values', (kind, shards) => {
        const built = build({ layout: 'bare' })
        expect(writeReservation(built.lockDir, { owner: OWNER, shards, memoryCapBytes: SHARD_MEMORY_CAP_BYTES, kind })).toEqual({ ok: true })
        const fileName = `${formatOwner(OWNER)}${RESERVATION_FILE_SUFFIX}`
        expect(readdirSync(built.lockDir)).toEqual([fileName])
        const text = readFileSync(join(built.lockDir, fileName), 'utf-8')
        expect(Object.keys(JSON.parse(text) as object).sort()).toEqual(['cpus', 'kind', 'memoryBytes', 'pid', 'runId', 'shards', 'version'])
        expect(parseReservation(text)).toEqual({
          ok: true,
          value: {
            version: RESERVATION_FORMAT_VERSION,
            runId: OWNER.runId,
            pid: OWNER.pid,
            shards,
            memoryBytes: shards * SHARD_MEMORY_CAP_BYTES,
            cpus: CPUS_PER_SHARD * shards,
            kind,
          },
        })
      })

      test('a leftover temporary file of the write is never read as a reservation, and the write leaves none behind', () => {
        const built = build({ layout: 'bare', unrelated: [{ kind: 'reservation-temp', owner: { owner: OWNER } }] })
        expect(readReservations(built.lockDir, processes.deps())).toEqual({ kind: 'listed', valid: [], bad: [] })
        expect(writeReservation(built.lockDir, { owner: OWNER, shards: OPTION_RANGE_MIN, memoryCapBytes: SHARD_MEMORY_CAP_BYTES, kind: 'full' })).toEqual({ ok: true })
        expect(readdirSync(built.lockDir)).toEqual([reservationFileName(OWNER)])
      })

      /** Each row: what fails, and the lock directory it gives (built under the case's root) with the request to write. */
      const failures: [string, () => { lockDir: string; request: ReservationRequest }][] = [
        ['the lock directory is missing', () => ({ lockDir: join(root, 'missing'), request: { owner: OWNER, shards: OPTION_RANGE_MIN, memoryCapBytes: SHARD_MEMORY_CAP_BYTES, kind: 'full' } })],
        [
          'a directory stands at the temporary file\'s name',
          () => {
            const built = build({ layout: 'bare' })
            mkdirSync(join(built.lockDir, reservationTempFileName(OWNER)))
            return { lockDir: built.lockDir, request: { owner: OWNER, shards: OPTION_RANGE_MIN, memoryCapBytes: SHARD_MEMORY_CAP_BYTES, kind: 'full' } }
          },
        ],
        [
          'the serializer refuses the reservation (shards not a whole number)',
          () => ({ lockDir: build({ layout: 'bare' }).lockDir, request: { owner: OWNER, shards: OPTION_RANGE_MIN + 0.5, memoryCapBytes: SHARD_MEMORY_CAP_BYTES, kind: 'full' } }),
        ],
      ]

      test.each(failures)('a write that fails is reported and leaves no reservation-named file: %s', (_name, setUp) => {
        const { lockDir, request } = setUp()
        const written = writeReservation(lockDir, request)
        if (written.ok) throw new Error('the write did not fail')
        expect(written.error).toContain(join(lockDir, reservationFileName(OWNER)))
        expect(written.error).not.toMatch(/[\r\n]/)
        assertNoLeak(written.error)
        expect(existsSync(join(lockDir, reservationFileName(OWNER)))).toBe(false)
      })
    })

    describe('removing', () => {
      test('the remover deletes only the given owner\'s file', () => {
        const built = build({
          lockFile: { holder: { runId: HOLDER_RUN_ID, alive: false } },
          reservations: [{ owner: { runId: EARLY_RUN_ID, alive: true } }, { owner: { runId: LATE_RUN_ID, alive: false } }],
          unrelated: [{ kind: 'file' }],
        })
        const [removed, kept] = built.reservations
        if (removed === undefined || kept === undefined) throw new Error('two reservations expected')
        const namesBefore = readdirSync(built.lockDir)
        const lines: string[] = []
        expect(removeReservation(built.lockDir, removed.owner, (line) => lines.push(line))).toEqual({ kind: 'removed' })
        expect(lines).toEqual([])
        expect(readdirSync(built.lockDir).sort()).toEqual(namesBefore.filter((name) => name !== removed.fileName).sort())
        expect<string | null>(readFileSync(kept.path, 'utf-8')).toBe(kept.text)
        expect<string | null>(readFileSync(built.lockPath, 'utf-8')).toBe(built.lockText)
      })

      test('a file already gone is no failure', () => {
        const built = build({ reservations: [{ owner: { runId: EARLY_RUN_ID, alive: true } }] })
        const before = treeSnapshot(root, { extended: true })
        const lines: string[] = []
        expect(removeReservation(built.lockDir, OWNER, (line) => lines.push(line))).toEqual({ kind: 'absent' })
        expect(lines).toEqual([])
        expect(treeSnapshot(root, { extended: true })).toEqual(before)
      })

      test('a removal that fails is logged and returned as a cleanup failure', () => {
        const built = build({ layout: 'bare' })
        const path = join(built.lockDir, reservationFileName(OWNER))
        // A directory at the reservation's name: unlinking it fails, whoever runs the case.
        mkdirSync(path)
        const lines: string[] = []
        const removal = removeReservation(built.lockDir, OWNER, (line) => lines.push(line))
        if (removal.kind !== 'failed') throw new Error(`expected a failure, found ${removal.kind}`)
        expect(removal.line).toContain(path)
        expect(removal.line).not.toMatch(/[\r\n]/)
        expect(lines).toEqual([removal.line])
        assertNoLeak(lines)
        expect(existsSync(path)).toBe(true)
      })
    })

    describe('reading', () => {
      test('every reservation is returned, in file-name order, with its owner\'s liveness', () => {
        const built = build({
          reservations: [
            { owner: { runId: LATE_RUN_ID, alive: false }, shards: OPTION_RANGE_MIN, kind: 'selective' },
            { owner: { runId: EARLY_RUN_ID, alive: true }, shards: MAX_SHARDS, kind: 'full' },
          ],
        })
        const [late, early] = built.reservations
        if (late === undefined || early === undefined) throw new Error('two reservations expected')
        expect(readReservations(built.lockDir, processes.deps())).toEqual({
          kind: 'listed',
          valid: [
            {
              fileName: early.fileName,
              owner: early.owner,
              ownerAlive: true,
              reservation: buildReservation({ owner: early.owner, shards: MAX_SHARDS, memoryCapBytes: SHARD_MEMORY_CAP_BYTES, kind: 'full' }),
            },
            {
              fileName: late.fileName,
              owner: late.owner,
              ownerAlive: false,
              reservation: buildReservation({ owner: late.owner, shards: OPTION_RANGE_MIN, memoryCapBytes: SHARD_MEMORY_CAP_BYTES, kind: 'selective' }),
            },
          ],
          bad: [],
        })
      })

      test('a reservation gone between the listing and its read counts as absent, with no error', () => {
        const built = build({ reservations: [{ owner: { runId: EARLY_RUN_ID, alive: true } }], vanishing: { owner: { runId: LATE_RUN_ID, alive: true } } })
        const [early] = built.reservations
        const vanishing = built.vanishing
        if (early === undefined || vanishing === null) throw new Error('a reservation and a vanishing one expected')
        expect(readReservations(built.lockDir, vanishing.probe(processes.deps()))).toEqual({
          kind: 'listed',
          valid: [{ fileName: early.fileName, owner: early.owner, ownerAlive: true, reservation: parsedReservation(early) }],
          bad: [],
        })
        // The probe's first call removed it, so the read really found it gone.
        expect(existsSync(vanishing.path)).toBe(false)
      })

      /** Each row: a bad file's change, and the reason the reader gives for it (from the file's built text). */
      const badFiles: [string, ReservationFileChange, (text: string | null) => string][] = [
        ['unparseable content', { kind: 'unparseable' }, parserRefusal],
        ['another version', { kind: 'version', version: RESERVATION_FORMAT_VERSION + 1 }, parserRefusal],
        ['another shape (an extra key)', { kind: 'set-key', key: 'extra', value: 0 }, parserRefusal],
        ['another owner\'s reservation under this owner\'s name', { kind: 'owner', owner: STRANGER }, () => expect.stringContaining(formatOwner(STRANGER))],
        ['a link at the name, not a regular file', { kind: 'dangling-link' }, () => expect.any(String)],
      ]
      const badRows = badFiles.flatMap(([name, change, reason]) => [true, false].map((alive) => [name, alive, change, reason] as const))

      test.each(badRows)('a bad file (%s), its owner alive: %p, comes back bad, naming that file, and stays in place', (_name, alive, change, reason) => {
        const built = build({ reservations: [{ owner: { runId: EARLY_RUN_ID, alive }, change }] })
        const [bad] = built.reservations
        if (bad === undefined) throw new Error('a reservation expected')
        const listing = readReservations(built.lockDir, processes.deps())
        expect(listing).toEqual({ kind: 'listed', valid: [], bad: [{ fileName: bad.fileName, owner: bad.owner, ownerAlive: alive, reason: reason(bad.text) }] })
        if (listing.kind === 'listed') {
          expect(listing.bad[0]?.reason).not.toMatch(/[\r\n]/)
          assertNoLeak(listing.bad)
        }
        expect(lstatSync(bad.path, { throwIfNoEntry: false })).toBeDefined()
      })

      test.each([
        ['is missing', () => join(root, 'missing')],
        [
          'is a regular file',
          () => {
            const path = join(root, 'lock-dir-file')
            writeFileSync(path, '')
            return path
          },
        ],
      ])('a lock directory that %s cannot be listed, and yields the listing failure', (_name, lockDir) => {
        const listing = readReservations(lockDir(), processes.deps())
        expect(listing).toEqual({ kind: 'failed', error: expect.any(String) })
        if (listing.kind === 'failed') {
          expect(listing.error).not.toBe('')
          expect(listing.error).not.toMatch(/[\r\n]/)
          assertNoLeak(listing.error)
        }
      })

      test('files beside the lock that are no reservations, the lock file among them, are never reported and are left in place', () => {
        const built = build({
          lockFile: { holder: { runId: HOLDER_RUN_ID, alive: true } },
          reservations: [{ owner: { runId: EARLY_RUN_ID, alive: true } }],
          unrelated: [
            { kind: 'file' },
            { kind: 'json-no-owner', owner: { runId: LATE_RUN_ID, alive: true } },
            { kind: 'reservation-temp', owner: { runId: LATE_RUN_ID, alive: true } },
            { kind: 'directory' },
          ],
        })
        const [early] = built.reservations
        if (early === undefined) throw new Error('a reservation expected')
        const before = treeSnapshot(root, { extended: true })
        expect(readReservations(built.lockDir, processes.deps())).toEqual({
          kind: 'listed',
          valid: [{ fileName: early.fileName, owner: early.owner, ownerAlive: true, reservation: parsedReservation(early) }],
          bad: [],
        })
        expect(treeSnapshot(root, { extended: true })).toEqual(before)
      })
    })
  })
})

// --- E5 lane B (T5.S4–S5): the sweep ---

describe('E5: the sweep of dead runs\' leftovers', () => {
  /** Test data: the RUN_ID every owner of a case names, and the RUN_ID another run's runner holds. */
  const RUN_ID = '20261008t130000z-sweep001'
  const OTHER_RUN_ID = '20261008t130001z-other002'
  /** Test data: the daemon's error for a failure on demand, on one line. */
  const DAEMON_ERROR = 'Error response from daemon: fake sweep failure'
  /** Test data: an owner label value of no owner's shape (a PID of 0). */
  const MALFORMED_OWNER = `${RUN_ID}-0`
  /** Test data: a lane's tag, and the tags of other repositories (the base image, its base, `/ci-live`'s image, a lane's). */
  const LANE_TAG = 'cscb-ci-l5:m5'
  const FOREIGN_TAGS = ['cscb-ci:latest', 'cscb-ci-base:v6', 'cscb-ci-live:latest', LANE_TAG]
  /** Test data: a tag in the run-private repository that is no run-private tag (a PID with a leading zero). */
  const MALFORMED_RUN_TAG = `${RUN_TAG_REPOSITORY}:${RUN_ID}-012-${RUN_TAG_ROLES[0]}`

  let root: string
  let clock: FakeClock
  let recorder: SpawnRecorder
  let fake: FakeDocker
  let processes: FakeProcessTable
  let logLines: string[]

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'ci-run-sweep-'))
    clock = createFakeClock()
    recorder = createSpawnRecorder({ clock, root })
    fake = createFakeDocker(recorder)
    processes = recorder.processes
    logLines = []
  })

  afterEach(() => {
    try {
      recorder.assertNoFailures()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  const sameArgv = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((arg, index) => arg === b[index])

  // --- Owners and their leftovers ---

  /** b.uqm SR-6.3's owner states: three dead ones, and the one live one (a `/ci` runner with the owner's own RUN_ID). */
  type OwnerState = 'gone' | 'not-a-runner' | 'other-run-id' | 'live'

  /** An owner in `state`; its process, if it has one, is in the process table the spawn recorder shares. */
  function ownerIn(state: OwnerState): Owner {
    switch (state) {
      case 'gone':
        return { runId: RUN_ID, pid: processes.allocatePid() }
      case 'not-a-runner':
        return { runId: RUN_ID, pid: processes.add(otherProcess(['sleep', '600'])) }
      case 'other-run-id':
        return { runId: RUN_ID, pid: processes.add(ciRunnerProcess(OTHER_RUN_ID, { worktreeRoot: root })) }
      case 'live':
        return { runId: RUN_ID, pid: processes.add(ciRunnerProcess(RUN_ID, { worktreeRoot: root })) }
    }
  }

  /** One owner's leftovers of every kind, each carrying its owner label: a running and a stopped `cscb-ci=1` container, its reservation, an image per run-private tag role, and an untagged image. */
  interface Leftovers {
    readonly owner: Owner
    readonly containers: readonly string[]
    readonly reservation: string
    readonly tags: readonly string[]
    readonly untaggedImage: string
  }

  /** What of an owner's leftovers is still there. */
  interface LeftoversPresent {
    readonly containers: readonly boolean[]
    readonly reservation: boolean
    readonly tags: readonly boolean[]
    readonly untaggedImage: boolean
  }

  /** `owner`'s run-private tags, one per role. */
  const runTagsOf = (owner: Owner): string[] => RUN_TAG_ROLES.map((role) => formatRunTag(owner, role))

  /** An image per run-private tag of `owner`, each labelled with its owner; answers the tags. */
  function addTaggedImages(owner: Owner): string[] {
    const tags = runTagsOf(owner)
    for (const tag of tags) fake.addImage({ tags: [tag], labels: { [OWNER_LABEL]: formatOwner(owner) } })
    return tags
  }

  /** An untagged image carrying the owner label `value`; answers the value. */
  function addUntaggedImage(value: string): string {
    fake.addImage({ labels: { [OWNER_LABEL]: value } })
    return value
  }

  /** Builds the lock directory with each owner's reservation (then `spec`'s own entries), then each owner's containers and images. */
  function leaveLeftovers(owners: readonly Owner[], spec: LockDirSpec = {}): { readonly lock: BuiltLockDir; readonly leftovers: Leftovers[] } {
    const lock = buildLockDir(root, { ...spec, reservations: [...owners.map((owner) => ({ owner: { owner } })), ...(spec.reservations ?? [])] })
    const leftovers = owners.map((owner, index): Leftovers => {
      const labels = { [CI_LABEL]: CI_LABEL_VALUE, [OWNER_LABEL]: formatOwner(owner) }
      const containers = [true, false].map((running) => fake.addContainer({ name: `shard-${owner.pid}-${running ? 'running' : 'stopped'}`, running, labels }))
      const tags = addTaggedImages(owner)
      const untaggedImage = fake.addImage({ labels: { [OWNER_LABEL]: formatOwner(owner) } })
      return { owner, containers, reservation: lock.reservations[index]!.path, tags, untaggedImage }
    })
    return { lock, leftovers }
  }

  function presentOf(left: Leftovers): LeftoversPresent {
    return {
      containers: left.containers.map((id) => fake.container(id) !== null),
      reservation: existsSync(left.reservation),
      tags: left.tags.map((tag) => fake.image(tag) !== null),
      untaggedImage: fake.image(left.untaggedImage) !== null,
    }
  }

  function allPresent(left: Leftovers, present: boolean): LeftoversPresent {
    return { containers: left.containers.map(() => present), reservation: present, tags: left.tags.map(() => present), untaggedImage: present }
  }

  // --- Driving the sweep ---

  function dockerContext(spawn: SpawnFn = recorder.spawn): DockerContext {
    return { spawn, env: {}, cwd: root }
  }

  /** Settles `work` on the fake clock: one event-loop turn lets every pending continuation run, then the next timer fires, until it settles. */
  async function onClock<T>(work: Promise<T>): Promise<T> {
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
      if (clock.pendingCount() === 0) throw new Error('the work waits on nothing the fake clock holds')
      await clock.runNext()
    }
  }

  /** Runs the sweep over `lockDir` on the fake clock, its log into `logLines`; checks the log and the failure list for leaks and answers the list. */
  async function sweep(lockDir: string, docker: DockerContext = dockerContext()): Promise<readonly string[]> {
    const failures = await onClock(
      sweepLeftovers({
        docker,
        lockDir,
        probe: processes.deps(),
        clock,
        log: (line) => {
          logLines.push(line)
        },
      }),
    )
    assertNoLeak({ logLines, failures })
    return failures
  }

  // --- T5.S4: scope, owners, order and failed steps (b.uqm SR-6.4, SR-6.3; AC 24, AC 25) ---

  describe('scope and owners', () => {
    const OWNER_ROWS: [string, OwnerState, boolean][] = [
      ['a gone PID', 'gone', false],
      ['a live PID that is no /ci runner', 'not-a-runner', false],
      ['a /ci runner with another RUN_ID', 'other-run-id', false],
      ['a /ci runner with the owner\'s own RUN_ID', 'live', true],
    ]

    test.each(OWNER_ROWS)('an owner that is %s: its containers, reservation, run-private tags and untagged image are kept: %p', async (_name, state, kept) => {
      const owner = ownerIn(state)
      const { lock, leftovers } = leaveLeftovers([owner, ownerIn('live')])
      expect(await sweep(lock.lockDir)).toEqual([])
      expect(presentOf(leftovers[0]!)).toEqual(allPresent(leftovers[0]!, kept))
      // A live owner's leftovers beside it are always kept.
      expect(presentOf(leftovers[1]!)).toEqual(allPresent(leftovers[1]!, true))
      expect(logLines).toEqual([])
    })

    test.each([
      ['no owner label', null, true],
      ['no owner label', null, false],
      ['an empty owner label', '', true],
      ['an empty owner label', '', false],
      ['a malformed owner label', MALFORMED_OWNER, true],
      ['a malformed owner label', MALFORMED_OWNER, false],
    ] as [string, string | null, boolean][])('a cscb-ci=1 container with %s is removed (running: %p)', async (_name, ownerValue, running) => {
      const lock = buildLockDir(root)
      const labels: Record<string, string> = ownerValue === null ? { [CI_LABEL]: CI_LABEL_VALUE } : { [CI_LABEL]: CI_LABEL_VALUE, [OWNER_LABEL]: ownerValue }
      const id = fake.addContainer({ name: 'shard-1', running, labels })
      expect(await sweep(lock.lockDir)).toEqual([])
      expect(fake.container(id)).toBeNull()
      // A running one is killed with SIGKILL before its removal, which is never forced.
      const steps = fake.operations().filter((op) => op.kind === 'container-kill' || op.kind === 'container-remove')
      type Step = [FakeDockerOperation['kind'], FakeDockerOperation['signal']]
      const kill: Step[] = running ? [['container-kill', 'SIGKILL']] : []
      const expected: Step[] = [...kill, ['container-remove', null]]
      expect(steps.map((op) => [op.kind, op.signal])).toEqual(expected)
    })

    test.each([
      ['unparseable', { kind: 'unparseable' }],
      ['of another version', { kind: 'version', version: RESERVATION_FORMAT_VERSION + 1 }],
      ['of another shape', { kind: 'set-key', key: 'extra', value: 0 }],
    ] as [string, JsonFileChange][])('a reservation that is %s is removed when its owner is dead, and kept when its owner lives', async (_name, change) => {
      const lock = buildLockDir(root, { reservations: [ownerIn('gone'), ownerIn('live')].map((owner) => ({ owner: { owner }, change })) })
      expect(await sweep(lock.lockDir)).toEqual([])
      expect(lock.reservations.map((reservation) => existsSync(reservation.path))).toEqual([false, true])
    })

    test('an untagged image with a malformed owner label is removed', async () => {
      const lock = buildLockDir(root)
      const image = fake.addImage({ labels: { [OWNER_LABEL]: MALFORMED_OWNER } })
      expect(await sweep(lock.lockDir)).toEqual([])
      expect(fake.image(image)).toBeNull()
    })

    test('it never touches /ci-live\'s containers, containers without cscb-ci=1, foreign or malformed tags, tagged or unlabelled images, the entries beside the lock, or a run directory', async () => {
      const dead = ownerIn('gone')
      const deadLabel = { [OWNER_LABEL]: formatOwner(dead) }
      const { lock, leftovers } = leaveLeftovers([dead], {
        lockFile: { holder: { owner: ownerIn('live') } },
        unrelated: [
          { kind: 'file', text: 'kept\n' },
          { kind: 'json-no-owner', owner: { owner: dead } },
          { kind: 'reservation-temp', owner: { owner: dead } },
          { kind: 'directory' },
        ],
      })
      const containers = [
        fake.addContainer({ name: 'ci-live-shard', labels: { [CI_LIVE_CONTAINER_LABEL]: CI_LIVE_CONTAINER_LABEL_VALUE, [CI_LABEL]: CI_LABEL_VALUE, ...deadLabel } }),
        fake.addContainer({ name: `${CI_LABEL}-lookalike`, labels: deadLabel }),
        fake.addContainer({ name: `${CI_LABEL}-lookalike-stopped`, running: false, labels: deadLabel }),
      ]
      const images = [
        // Tagged images, each carrying the dead owner's label.
        ...[...FOREIGN_TAGS, MALFORMED_RUN_TAG].map((tag) => fake.addImage({ tags: [tag], labels: deadLabel })),
        // Untagged images without the owner label.
        fake.addImage(),
        fake.addImage({ labels: { [CI_LABEL]: CI_LABEL_VALUE } }),
      ]
      // A run directory of the dead owner's run, in a constructed system temp directory.
      const tempDir = join(root, 'tmp')
      mkdirSync(tempDir)
      buildRunDirectory(tempDir, { runId: dead.runId, runnerLog: { pid: dead.pid } })
      const deadReservationName = reservationFileName(dead)
      const untouched = (): unknown => ({
        containers: containers.map((id) => fake.container(id)),
        images: images.map((id) => fake.image(id)),
        besideTheLock: treeSnapshot(lock.lockDir, { extended: true }).filter((line) => !line.startsWith('.:') && !line.startsWith(`${deadReservationName}:`)),
        tempDir: treeSnapshot(tempDir, { extended: true }),
      })
      const before = untouched()

      expect(await sweep(lock.lockDir)).toEqual([])
      expect(presentOf(leftovers[0]!)).toEqual(allPresent(leftovers[0]!, false))
      expect(untouched()).toEqual(before)
    })

    test('it removes dead owners\' containers, then their reservations, then their tags, then their untagged images', async () => {
      const owners = [ownerIn('gone'), ownerIn('not-a-runner')]
      const { lock, leftovers } = leaveLeftovers(owners)
      const reservationsLeft: number[] = []
      const watching: SpawnFn = (request) => {
        reservationsLeft.push(leftovers.filter((left) => existsSync(left.reservation)).length)
        return recorder.spawn(request)
      }
      expect(await sweep(lock.lockDir, dockerContext(watching))).toEqual([])
      for (const left of leftovers) expect(presentOf(left)).toEqual(allPresent(left, false))

      const ownerListings = owners.map((owner) => imageListArgs(ownerUntaggedImageFilters(formatOwner(owner))))
      const stepOf = (op: FakeDockerOperation): string | null => {
        if (op.kind === 'container-kill' || op.kind === 'container-remove') return 'containers'
        if (op.kind === 'image-remove') return 'tags'
        if (op.kind === 'image-prune' || (op.kind === 'image-list' && ownerListings.some((argv) => sameArgv(op.argv, argv)))) return 'untagged images'
        return null
      }
      const operations = fake.operations()
      expect(operations).toHaveLength(reservationsLeft.length)
      // The reservations step is seen as the spawn after which the dead owners' reservations are gone.
      const steps: string[] = []
      const see = (step: string | null): void => {
        if (step !== null && steps.at(-1) !== step) steps.push(step)
      }
      let left = owners.length
      operations.forEach((op, index) => {
        if (reservationsLeft[index]! < left) {
          left = reservationsLeft[index]!
          see('reservations')
        }
        see(stepOf(op))
      })
      expect(left).toBe(0)
      expect(steps).toEqual(['containers', 'reservations', 'tags', 'untagged images'])
    })
  })

  describe('failed steps: each is logged and listed, and the sweep goes on without refusing', () => {
    /** Each row arranges one failure for a dead owner's leftovers, and answers the check of its one cleanup-failure line and what of the leftovers it leaves. */
    type FailedStepRow = [string, (left: Leftovers, lock: BuiltLockDir) => { readonly check: (line: string) => void; readonly kept: LeftoversPresent }]

    const ROWS: FailedStepRow[] = [
      [
        'the container listing',
        (left) => {
          fake.fail('container-list', { stderr: DAEMON_ERROR })
          return {
            check: (line) => expect(line).toBe(`listing ${CI_LABEL}=${CI_LABEL_VALUE} containers for the sweep failed: ${DAEMON_ERROR}`),
            kept: { ...allPresent(left, false), containers: [true, true] },
          }
        },
      ],
      [
        'the tag listing',
        (left) => {
          fake.fail('image-list', { stderr: DAEMON_ERROR, when: (argv) => sameArgv(argv, imageListArgs(runTaggedImageFilters())) })
          return {
            check: (line) => expect(line).toBe(`listing ${RUN_TAG_REPOSITORY} image tags for the sweep failed: ${DAEMON_ERROR}`),
            kept: { ...allPresent(left, false), tags: left.tags.map(() => true) },
          }
        },
      ],
      [
        'a stopped container\'s removal',
        (left) => {
          const id = left.containers[1]!
          const name = fake.container(id)!.name
          fake.fail('container-remove', { stderr: DAEMON_ERROR, when: (argv) => argv.includes(id) })
          return { check: (line) => expect(line).toBe(`removing container ${name} (${id}) failed: ${DAEMON_ERROR}`), kept: { ...allPresent(left, false), containers: [false, true] } }
        },
      ],
      [
        'a running container\'s kill, and so its removal',
        (left) => {
          const id = left.containers[0]!
          const name = fake.container(id)!.name
          fake.fail('container-kill', { stderr: DAEMON_ERROR, when: (argv) => argv.includes(id) })
          return {
            check: (line) => {
              expect(line.startsWith(`removing container ${name} (${id}) failed: `)).toBe(true)
              expect(line.endsWith(` (its kill failed first: ${DAEMON_ERROR})`)).toBe(true)
            },
            kept: { ...allPresent(left, false), containers: [true, false] },
          }
        },
      ],
      [
        'a reservation\'s removal',
        (left, lock) => {
          // A directory at another dead owner's reservation name: read as a bad reservation, and its removal fails.
          const path = join(lock.lockDir, reservationFileName(ownerIn('gone')))
          mkdirSync(path)
          return {
            check: (line) => {
              expect(line.startsWith(`removing reservation ${path} failed: `)).toBe(true)
              expect(existsSync(path)).toBe(true)
            },
            kept: allPresent(left, false),
          }
        },
      ],
      [
        'a tag\'s removal',
        (left) => {
          const tag = left.tags[0]!
          fake.fail('image-remove', { stderr: DAEMON_ERROR, when: (argv) => argv.includes(tag) })
          return { check: (line) => expect(line).toBe(`removing image tag ${tag} failed: ${DAEMON_ERROR}`), kept: { ...allPresent(left, false), tags: left.tags.map((_, index) => index === 0) } }
        },
      ],
    ]

    test.each(ROWS)('a failed %s', async (_name, arrange) => {
      const { lock, leftovers } = leaveLeftovers([ownerIn('gone')])
      const left = leftovers[0]!
      const { check, kept } = arrange(left, lock)
      const failures = await sweep(lock.lockDir)
      expect(failures).toHaveLength(1)
      check(failures[0]!)
      expect(logLines).toEqual([...failures])
      expect(presentOf(left)).toEqual(kept)
    })
  })

  // --- T5.S5: the removal path and the prune retry (b.uqm SR-9.3, SR-6.4) ---

  describe('the removal path: tag names only, owner-filtered prunes after a listing, the retry', () => {
    /** Test data: a prune's confirmation-skip flag and its filter option, the only options a prune may carry (no `--all`). */
    const PRUNE_OPTIONS = ['--force', '--filter']

    /**
     * Reads every docker command the spawn recorder kept and checks the
     * removal rules: an image removal names one dead owner's run-private tag
     * (never an ID or a digest) and carries no option, so it is never forced;
     * a container removal carries no option; every prune is limited to
     * untagged images and filtered on one owner label value of `pruned` (in
     * order, each value's tries together), after a listing of exactly that
     * value's untagged images that exited 0 and listed each of the value's
     * untagged image IDs (taken before the sweep).
     */
    async function assertRemovalShapes(deadTags: ReadonlySet<string>, pruned: readonly PrunedValue[]): Promise<void> {
      const operations = fake.operations().filter((op) => op.source === 'runner')
      // The runner's operations are its spawns, one for one, so an operation's place among them finds its spawn's output.
      const spawns = recorder.spawns()
      expect(operations.map((op) => op.argv)).toEqual(spawns.map((spawn) => spawn.argv))
      const options = (argv: readonly string[]): string[] => argv.filter((arg) => arg.startsWith('-'))
      for (const op of operations) {
        if (op.kind === 'image-remove') {
          expect(op.removalBy).toBe('tag')
          expect(deadTags.has(op.argv.at(-1)!)).toBe(true)
          expect(options(op.argv)).toEqual([])
        } else if (op.kind === 'container-remove') {
          expect(options(op.argv)).toEqual([])
        } else if (op.kind === 'image-prune') {
          expect(options(op.argv)).toEqual(PRUNE_OPTIONS)
        }
      }
      const prunes = operations.filter((op) => op.kind === 'image-prune')
      expect([...new Set(prunes.map((op) => op.filters.join(' ')))]).toEqual(pruned.map(({ value }) => `label=${OWNER_LABEL}=${value}`))
      for (const prune of prunes) {
        const { value, imageIds } = pruned.find((candidate) => prune.filters[0] === `label=${OWNER_LABEL}=${candidate.value}`)!
        const listing = operations.find((op) => op.kind === 'image-list' && sameArgv(op.argv, imageListArgs(ownerUntaggedImageFilters(value))))
        if (listing === undefined) throw new Error(`no listing of ${value}'s untagged images`)
        expect(listing.index).toBeLessThan(prune.index)
        expect(listing.exitCode).toBe(0)
        const listed = new TextDecoder().decode((await spawns[operations.indexOf(listing)]!.result).stdout)
        expect(imageIds.length).toBeGreaterThan(0)
        for (const id of imageIds) expect(listed.split('\n')).toContain(id)
      }
    }

    /** An owner label value the sweep prunes, and the untagged images carrying it before the sweep. */
    interface PrunedValue {
      readonly value: string
      readonly imageIds: readonly string[]
    }

    /** Each value, sorted, with the untagged images carrying it now; call it before the sweep. */
    function untaggedImagesOf(values: readonly string[]): PrunedValue[] {
      const untagged = fake.images().filter((image) => image.tags.length === 0)
      return [...values].sort().map((value) => ({ value, imageIds: untagged.filter((image) => image.labels[OWNER_LABEL] === value).map((image) => image.id) }))
    }

    /** Each row builds its leftovers and answers the dead owners' run-private tags and the owner label values whose untagged images the sweep prunes. */
    type RemovalScenario = [string, () => { readonly deadTags: readonly string[]; readonly prunedValues: readonly string[] }]

    const SCENARIOS: RemovalScenario[] = [
      ['dead owners with run-private tags only', () => ({ deadTags: [ownerIn('gone'), ownerIn('other-run-id')].flatMap(addTaggedImages), prunedValues: [] })],
      ['dead owners with untagged images only', () => ({ deadTags: [], prunedValues: [ownerIn('gone'), ownerIn('not-a-runner')].map((owner) => addUntaggedImage(formatOwner(owner))) })],
      [
        'dead owners with both',
        () => {
          const owners = [ownerIn('gone'), ownerIn('other-run-id')]
          return { deadTags: owners.flatMap(addTaggedImages), prunedValues: owners.map((owner) => addUntaggedImage(formatOwner(owner))) }
        },
      ],
      ['an untagged image with a malformed owner label', () => ({ deadTags: [], prunedValues: [addUntaggedImage(MALFORMED_OWNER)] })],
      [
        'a live owner beside dead ones',
        () => {
          const live = ownerIn('live')
          addTaggedImages(live)
          addUntaggedImage(formatOwner(live))
          const dead = ownerIn('not-a-runner')
          return { deadTags: addTaggedImages(dead), prunedValues: [addUntaggedImage(formatOwner(dead))] }
        },
      ],
    ]

    test.each(SCENARIOS)('%s: every removal names a dead owner\'s tag, and every prune one dead owner\'s label after its listing', async (_name, build) => {
      const lock = buildLockDir(root)
      const { deadTags, prunedValues } = build()
      const pruned = untaggedImagesOf(prunedValues)
      expect(await sweep(lock.lockDir)).toEqual([])
      await assertRemovalShapes(new Set(deadTags), pruned)
      expect(fake.operations('image-remove').map((op) => op.argv.at(-1)).sort()).toEqual([...deadTags].sort())
    })

    test('an image carrying a dead owner\'s run-private tag and a foreign tag keeps the foreign tag, and the image', async () => {
      const lock = buildLockDir(root)
      const dead = ownerIn('gone')
      // The first role is the test image's: a live run's `-test` tag.
      const liveTestTag = formatRunTag(ownerIn('live'), RUN_TAG_ROLES[0])
      const [deadTestTag, deadDriftTag] = [formatRunTag(dead, RUN_TAG_ROLES[0]), formatRunTag(dead, RUN_TAG_ROLES[1])]
      const withLaneTag = fake.addImage({ tags: [deadTestTag, LANE_TAG] })
      const withLiveTag = fake.addImage({ tags: [deadDriftTag, liveTestTag] })
      expect(await sweep(lock.lockDir)).toEqual([])
      expect(fake.image(withLaneTag)?.tags).toEqual([LANE_TAG])
      expect(fake.image(withLiveTag)?.tags).toEqual([liveTestTag])
      expect(fake.operations('image-remove').map((op) => [op.untagged, op.deleted])).toEqual([
        [[deadDriftTag], []],
        [[deadTestTag], []],
      ])
      await assertRemovalShapes(new Set([deadTestTag, deadDriftTag]), [])
    })

    test.each([
      // The other prune ends just before the second try, so the retries stop at the first accepted one.
      ['accepted on its second try', PRUNE_RETRY_INTERVAL_MS - 1, 2, true],
      ['accepted on its last try', PRUNE_RETRIES * PRUNE_RETRY_INTERVAL_MS - 1, PRUNE_RETRIES + 1, true],
      ['refused on every try', (PRUNE_RETRIES + 1) * PRUNE_RETRY_INTERVAL_MS, PRUNE_RETRIES + 1, false],
    ] as [string, number, number, boolean][])('a prune refused as already running is tried again, PRUNE_RETRY_INTERVAL_MS apart: %s', async (_name, otherPruneMs, triesMade, accepted) => {
      const lock = buildLockDir(root)
      const value = addUntaggedImage(formatOwner(ownerIn('gone')))
      const image = fake.images()[0]!.id
      const pruned = untaggedImagesOf([value])
      // Another run's prune holds Docker's one prune slot; its owner value is on no image, so it deletes nothing.
      expect(fake.startOtherPrune({ durationMs: otherPruneMs, owner: formatOwner(ownerIn('gone')) })).toBe(true)
      const failures = await sweep(lock.lockDir)

      // The first try and the retries made, on the fake clock: up to PRUNE_RETRIES more, none after an accepted one.
      const tries = fake.operations('image-prune').filter((op) => op.source === 'runner')
      expect(tries).toHaveLength(triesMade)
      expect(tries.map((op) => op.atMs)).toEqual(Array.from({ length: triesMade }, (_, index) => index * PRUNE_RETRY_INTERVAL_MS))
      expect(tries.map((op) => op.exitCode === 0)).toEqual(Array.from({ length: triesMade }, (_, index) => accepted && index === triesMade - 1))
      expect(fake.image(image) === null).toBe(accepted)
      if (accepted) {
        expect(failures).toEqual([])
      } else {
        expect(failures).toHaveLength(1)
        const line = failures[0]!
        expect(line.startsWith(`pruning untagged images labelled ${OWNER_LABEL}=${value} failed: `)).toBe(true)
        expect(line).toContain(` ${triesMade} `)
        expect(line.endsWith(PRUNE_ALREADY_RUNNING_TEXT)).toBe(true)
      }
      expect(logLines).toEqual([...failures])
      await assertRemovalShapes(new Set(), pruned)
    })

    test.each([
      [
        'the sweep\'s listing of owner-labelled untagged images',
        (_value: string) => ({ argv: imageListArgs(ownerLabelledUntaggedImageFilters()), line: `listing untagged images labelled ${OWNER_LABEL} for the sweep failed: ${DAEMON_ERROR}` }),
      ],
      [
        'listing of one dead owner\'s untagged images',
        (value: string) => ({ argv: imageListArgs(ownerUntaggedImageFilters(value)), line: `listing untagged images labelled ${OWNER_LABEL}=${value} failed: ${DAEMON_ERROR}` }),
      ],
    ] as [string, (value: string) => { readonly argv: readonly string[]; readonly line: string }][])('a failed %s is logged and listed, and no prune follows it', async (_name, failing) => {
      const lock = buildLockDir(root)
      const value = addUntaggedImage(formatOwner(ownerIn('gone')))
      const { argv, line } = failing(value)
      fake.fail('image-list', { stderr: DAEMON_ERROR, when: (given) => sameArgv(given, argv) })
      expect(await sweep(lock.lockDir)).toEqual([line])
      expect(logLines).toEqual([line])
      expect(fake.operations('image-prune')).toEqual([])
      expect(fake.images()).toHaveLength(1)
    })

    test('known gap against b.uqm SR-6.3/SR-6.4: an untagged image with an empty owner label is selected but never pruned, and each sweep logs one cleanup failure', async () => {
      // SR-6.3/SR-6.4 call this image a dead run's leftover to remove, but E1's
      // image-list filter builder refuses an empty label value, so the owner's
      // listing fails before any prune. This case pins today's behaviour;
      // closing the gap needs E1's filter builders changed (the orchestrator's
      // decision), and then this case changes with them.
      const lock = buildLockDir(root)
      addUntaggedImage('')
      const failures = await sweep(lock.lockDir)
      expect(failures).toHaveLength(1)
      expect(failures[0]!.startsWith(`listing untagged images labelled ${OWNER_LABEL}= failed: `)).toBe(true)
      expect(logLines).toEqual([...failures])
      expect(fake.operations('image-prune')).toEqual([])
      expect(fake.images()).toHaveLength(1)
    })

    test('a prune that leaves a dead owner\'s untagged image because a container uses it is no failure', async () => {
      const lock = buildLockDir(root)
      addUntaggedImage(formatOwner(ownerIn('gone')))
      const image = fake.images()[0]!.id
      // It carries its image's owner label but not cscb-ci=1, so it is no run's container and the sweep keeps it.
      const user = fake.addContainer({ name: 'not-a-shard', image })
      expect(await sweep(lock.lockDir)).toEqual([])
      expect(fake.operations('image-prune').map((op) => [op.exitCode, op.deleted])).toEqual([[0, []]])
      expect(fake.image(image)).not.toBeNull()
      expect(fake.container(user)).not.toBeNull()
    })

    test('when the listing of a dead owner\'s untagged images finds none, no prune is spawned', async () => {
      const dead = ownerIn('gone')
      // Its only image is tagged, so no untagged image carries its label.
      addTaggedImages(dead)
      const removal = await onClock(
        removeOwnerUntaggedImages(dockerContext(), formatOwner(dead), clock, (line) => {
          logLines.push(line)
        }),
      )
      expect(removal).toEqual({ kind: 'none-found' })
      expect(fake.operations().map((op) => op.kind)).toEqual(['image-list'])
      expect(logLines).toEqual([])
      assertNoLeak({ logLines, removal })
    })
  })
})

// ---------------------------------------------------------------------------
// E6 (t1.t6s.6s): the readings, /ci-live detection, the fits and the refusal
// messages
// ---------------------------------------------------------------------------
