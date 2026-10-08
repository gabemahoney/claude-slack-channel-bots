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
