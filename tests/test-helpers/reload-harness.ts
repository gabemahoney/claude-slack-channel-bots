/**
 * test-helpers/reload-harness.ts — The shared reload harness (b.av2 SR-13.4):
 * the reload controller (`src/reload.ts`) over a temp configuration directory,
 * a manual tick driver, a lifecycle recorder and the real bring-up checks.
 *
 * `makeReloadHarness(opts?)` builds, under one fresh `mkdtempSync` root
 * (real-path resolved, so symlink comparisons hold):
 *
 * - `h.dir`: the configuration directory. It holds only the SR-8.1 files,
 *   named in `h.paths` (`config`, `pending`, `apply`, `lastApplied`, from
 *   `reloadFilePaths`), so `h.configDirEntries()` shows exactly what the
 *   controller left there (no temporary sibling, no stray file);
 * - `h.home`: a temp home handed to the controller, so a `~` in a
 *   test-written configuration expands under it, never the operator's home;
 * - persona fixtures: `h.persona(name, overrides?)` is a file-form persona
 *   (`makePersona`) with its own `all` channel and its credentials file and
 *   working directory under `<root>/personas/<key>/`. Nothing is created on
 *   disk until the test asks: `h.writeCredentials(persona)` writes a valid
 *   file (mode 0600, through `writeCredentialsFile`) holding a fresh
 *   sentinel-bearing token set and returns it (each call rotates: the tokens
 *   differ from every earlier set); `h.writeCredentialsContent(persona, c)`
 *   writes invalid or hand-shaped content; `h.makeWorkingDirectory(persona)`
 *   creates the directory; `h.materialize(...personas)` does both for each.
 *   `h.tokens(name)` is the persona's latest valid set;
 * - configuration and record files: `h.writeConfig(input)` and
 *   `h.writeRecord(input)` write `input` as JSON in the same format (so the
 *   same input gives byte-identical files) and return the bytes;
 *   `h.writeConfigBytes` / `h.writeRecordBytes` write raw bytes (syntax
 *   errors, pre-persona shapes); `h.readConfig()` / `h.readRecord()` read
 *   them back (undefined when absent); `h.remove(path)` deletes a path and
 *   `h.replaceWithDirectory(path)` puts a directory there (unreadable as a
 *   file even as root). Every helper refuses a path outside the root;
 * - edits between ticks (detection, b.av2 SR-8.2, SR-8.3):
 *   - config: `h.writeConfig` / `h.writeConfigBytes`, `h.deleteConfig()`,
 *     `h.replaceWithDirectory(h.paths.config)`;
 *   - credentials: `h.writeCredentials(persona)` rotates to a new valid set,
 *     `h.writeCredentialsContent(persona, c)` writes invalid content,
 *     `h.deleteCredentials(persona)`, `h.makeCredentialsUnreadable(persona)`
 *     (a directory), `h.makeFifo(path)` (guard with `mkfifoAvailable()`);
 *     `h.saveCredentials(persona)` returns a function restoring the file's
 *     exact bytes (or its absence, or the unreadable directory) and its token
 *     set, to revert an edit;
 *     `h.readCredentialsBytes(persona)`, and `h.credentialsDigestOf(persona)`,
 *     the production reader's digest or marker for the file as it stands, to
 *     compare with `run.bringUps.credentialsDigest(key)` (never print it);
 *   - the pending file: `h.pendingExists()`, `h.readPending()` /
 *     `h.readPendingText()` (undefined unless a regular file),
 *     `h.pendingFingerprint()` (`parsePendingFingerprint`), and
 *     `h.writePendingBytes(b)` for a leftover or hand-placed file;
 * - the write-failure seam: `h.failWrites({ step?, code?, call? })` makes the
 *   controller's durable writer (`durableWriteFileSync` over an fs seam, as
 *   in production) throw an errno-style error at that `DurableWriteFs` call
 *   (default `openSync`, `EIO`) until `h.clearWriteFailure()`: every call of
 *   the step, or only its `call`-th call (1-based, counted from
 *   `failWrites`), e.g. `{ step: 'fsyncSync', call: 2 }` for the directory
 *   fsync after the rename. `h.failRemoves(...)` / `h.clearRemoveFailure()`
 *   do the same for the controller's durable delete (`durableUnlinkSync`
 *   over its own seam, default `unlinkSync`; `{ step: 'fsyncSync' }` fails
 *   the directory fsync after the unlink). The two seams count calls apart.
 *   File permissions are never the seam: the suite may run as root.
 *
 * A run (`h.build(opts?)`, or `h.start(opts?)` = build, `resolveStart`, then
 * `runStartBringUp` when the start resolved `applied`) is one server start.
 * `h.start` arms no detection tick; `h.startDetecting(opts?)` = `h.start`
 * then `run.startDetection()`, as `main()` does, and throws when nothing was
 * armed (to test a refused or early `startDetection`, call it yourself).
 * Each run builds, fresh:
 *
 * - `run.connections`: `makeConnectionHarness` over the personas the harness
 *   wrote credentials for, registering each one's latest token set with a new
 *   `makeStubSlackFactory` (so a start after a rotation routes the rotated
 *   tokens), the real connection manager and a fake clock (`run.clock`).
 *   `opts.slack` scripts a persona's stub by name: unscripted it comes up,
 *   `SLACK_UNREACHABLE` leaves it `retrying` (for good, however far the clock
 *   advances) and `SLACK_AUTH_REJECTED` (`invalid_auth`) leaves it `broken`;
 *   each holds the digest of the credentials bytes its bring-up read. A
 *   record in which two personas share one `credentials_file` (e.g.
 *   `h.persona('bravo', { credentials_file: alpha.credentials_file })`) leaves
 *   both `broken`, each holding the digest of its own path's bytes: the file
 *   is read (stat-first) only to be hashed, never parsed, and no token from
 *   it reaches a Slack client.
 *   `opts.dryRun` reaches the manager, the bring-up controller and the reload
 *   controller as a flag (`process.env` is never read or set);
 *   `opts.configFs` overrides the controller's file-system seam for reading
 *   the record, the configuration file and the pending file
 *   (`PersonaConfigFs`); `opts.credentialsFs` overrides the detection tick's
 *   credentials reads (`CredentialsFs`, e.g. an `fstatFile` reporting a FIFO);
 * - `run.bringUps`: the real `createPersonaBringUpController` over that
 *   manager and clock, so the start runs the real credentials check, the real
 *   working-directory check and the real-path "no other applied persona"
 *   rule. `opts.bringUpFs` overrides its file-system seam;
 * - `run.lifecycle`: the recorder. Its `ops` are the controller's
 *   `ReloadLifecycleOps`. The start pass (`startBringUp`) brings every
 *   applied persona up at once through `run.bringUps` and launches each one
 *   that ends `up`; a launch is only recorded (nothing is spawned).
 *   `bringUp` does the same for one persona; `teardown` cancels the persona's
 *   bring-up and stops its connection; `reconnectCredentials` and
 *   `updateInPlace` are recorded only. Every call is a `ReloadLifecycleRecord`
 *   in call order (`records`, `of(op)`, `keys(op)`); a bring-up record gets
 *   its `result` (outcome `up`/`broken`/`retrying` and each failure's class)
 *   when it resolves (`outcome(key)`, `classes(key)`). `startPasses` holds the
 *   applied configuration of each start pass; `holdStartPass()` keeps the
 *   next start pass from resolving until the returned release is called, or
 *   makes it reject once `release.fail(err)` is called (a start pass that
 *   throws after its bring-ups and launches);
 * - `run.ticks`: a manual `ReloadTickDriver`. Nothing runs until the test
 *   calls `tick()` or `ticks(n)` (each awaited until the pass settles; `tick`
 *   rejects when nothing is armed); no real timer is ever armed. `armed`,
 *   `startCalls`, `stopCalls` and `ticksRun` show how the controller used it.
 *   `opts.tickDriver` swaps in another driver (the production one on
 *   `run.clock`) for the single 5 s cadence case; `run.ticks` is then unused;
 * - `run.controller`: the real `createReloadController` over `h.paths`, the
 *   recorder's ops, the seam writer and remover, `run.ticks`, the dry-run
 *   flag, `heldCredentialsDigest` bound to `run.bringUps.credentialsDigest`
 *   (as `server.ts` binds it; `opts.heldCredentialsDigest` wraps that lookup,
 *   e.g. to make it throw so a detection pass fails), the stub factory and
 *   `h.home`.
 *   `run.resolveStart()` calls its `resolveStart` and keeps the outcome as
 *   `run.outcome`; `run.startDetection()` calls its `startDetection`;
 * - captures: `run.logs` is the one `[slack]` stream (reload controller,
 *   bring-up controller and connection manager lines, in order), and
 *   `run.logsOf(label)` its lines starting `[slack] <label>: ` (a class such
 *   as `RELOAD_NOTHING_PENDING`, or `'reload'` for the unclassed failures);
 *   `run.writes` every call of the controller's writer (path, success);
 *   `run.removes` every call of its durable delete as what happened to the
 *   file (`ok`: it is gone; `removed`: this call removed it; `unsynced`: it
 *   was removed but the directory sync failed, so the delete threw although
 *   the file is gone; see `ReloadRemoveRecord`); `run.pendingWrites()` /
 *   `run.pendingRemoves()` those on `h.paths.pending`;
 *   `run.slackCalls()` every Web API call by persona key and
 *   `run.slackPosts()` the `chat.postMessage` calls among them;
 *   `run.captured(extra?)` gathers the logs, statuses, lifecycle records,
 *   outcome, writer and delete calls, Slack calls and every file the run's
 *   writer wrote that still exists (as `writtenFile`, so the pending file is
 *   checked) for `assertNoLeak`. Files the test itself wrote are left out, so
 *   a test-written malformed file that holds `LEAK_SENTINEL` does not fail
 *   the check;
 * - "nothing happened": `const cp = run.checkpoint()`, drive ticks, then
 *   `run.since(cp)` is every log line, writer and delete call, lifecycle
 *   record (any op, any `via`), Slack client build and Web API call made
 *   since. `expect(run.since(cp)).toEqual(NO_RUN_ACTIVITY)` shows the ticks
 *   did nothing at all; `run.since(cp).lifecycle` alone is `[]` for "no
 *   lifecycle call from a tick" (AC 55). Bring-up retries run only when the
 *   test advances `run.clock`, so they never mix into a stretch of ticks.
 *
 * Call `await h.cleanup()` in `afterEach`: it stops every run (detection,
 * bring-up retries, connections) and removes the root. A test that must show
 * no timer is left calls `await run.stop()` and checks
 * `run.clock.pendingCount()`.
 *
 * Isolation (b.av2 SR-13.2): every path is explicit and under the root; the
 * harness reads and sets no environment variable, never resolves the
 * operator's home, builds no real Slack client, arms no real timer and holds
 * no token literal. It spawns nothing but `mkfifo` (in `mkfifoAvailable` and
 * `h.makeFifo`).
 *
 * SPDX-License-Identifier: MIT
 */

import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'

import {
  durableUnlinkSync,
  DurableUnlinkUnsyncedError,
  durableWriteFileSync,
  type DurableWriteFs,
} from '../../src/atomic-write.ts'
import type { Persona, PersonaConfig, PersonaConfigFs, PersonaInput } from '../../src/config.ts'
import type { PersonaBringUpFs } from '../../src/persona-bringup.ts'
import {
  createPersonaBringUpController,
  type PersonaBringUpController,
  type PersonaBringUpOutcome,
  type PersonaBringUpResultSummary,
} from '../../src/persona-bringup-controller.ts'
import {
  credentialsDigest,
  PersonaSlackTokens,
  readCredentialsFile,
  type CredentialsDigest,
  type CredentialsFs,
} from '../../src/persona-credentials.ts'
import { personaKey } from '../../src/persona-identity.ts'
import { composePersonaStatusListeners } from '../../src/persona-start.ts'
import { parsePendingFingerprint } from '../../src/reload-fingerprint.ts'
import {
  createReloadController,
  reloadFilePaths,
  type ReloadController,
  type ReloadFilePaths,
  type ReloadLifecycleOps,
  type ReloadStartOutcome,
  type ReloadTick,
  type ReloadTickDriver,
} from '../../src/reload.ts'
import {
  APP_TOKEN_PREFIX,
  BOT_TOKEN_PREFIX,
  fakeToken,
  writeCredentialsFile,
  writtenFile,
  type CredentialsOverrides,
} from './credentials.ts'
import type { FakeClock } from './fake-clock.ts'
import { makePersona } from './persona-config.ts'
import { makeConnectionHarness, type ConnectionHarness } from './persona-connection-harness.ts'
import type { StubSlack, StubSlackFactory, StubSlackOptions, StubWebCall } from './slack-stub.ts'

// ---------------------------------------------------------------------------
// Scripted Slack outcomes for a start
// ---------------------------------------------------------------------------

/**
 * `opts.slack` scripts that put a persona in each held-content state at the
 * start (pass under the persona's name, e.g. `{ slack: { bravo:
 * SLACK_UNREACHABLE } }`). Unscripted, a persona with a valid credentials
 * file and working directory comes up (`up`).
 *
 * - `SLACK_UNREACHABLE`: every `auth.test` fails with a network error, so the
 *   persona ends `retrying` and stays so however far `run.clock` advances;
 * - `SLACK_AUTH_REJECTED`: `auth.test` answers `invalid_auth` (a named auth
 *   error), so the persona ends `broken` with its credentials held.
 *
 * Either way the bring-up read the credentials file, so the persona holds
 * its digest (`run.bringUps.credentialsDigest(key)`).
 */
export const SLACK_UNREACHABLE: StubSlackOptions = Object.freeze({
  authTest: Object.freeze(Array.from({ length: 1_000 }, () => ({ kind: 'network' as const }))),
})

/** See `SLACK_UNREACHABLE`. */
export const SLACK_AUTH_REJECTED: StubSlackOptions = Object.freeze({
  authTest: Object.freeze([{ kind: 'platform' as const, error: 'invalid_auth' }]),
})

let mkfifoProbe: boolean | undefined

/**
 * Whether `mkfifo` is available here (probed once). Guard a real-FIFO case
 * with `test.skipIf(!mkfifoAvailable())`, the reason in the test name.
 */
export function mkfifoAvailable(): boolean {
  mkfifoProbe ??= spawnSync('mkfifo', ['--version']).status === 0
  return mkfifoProbe
}

// ---------------------------------------------------------------------------
// Manual tick driver
// ---------------------------------------------------------------------------

/**
 * A `ReloadTickDriver` driven by the test. Like the production driver it is
 * single-use: the first `start` arms the tick; a later `start`, or a `start`
 * after `stop`, is counted but arms nothing.
 */
export interface ManualTickDriver extends ReloadTickDriver {
  /** Every `start` call, armed or not. */
  readonly startCalls: number
  /** Every `stop` call. */
  readonly stopCalls: number
  /** A tick is registered and the driver is not stopped. */
  readonly armed: boolean
  /** Ticks run so far through `tick` / `ticks`. */
  readonly ticksRun: number
  /** Run the armed tick once and wait until it settles (after any tick still running). Throws if nothing is armed. */
  tick(): Promise<void>
  /** Run `n` ticks one after another, each settled before the next. */
  ticks(n: number): Promise<void>
}

/** Build a manual tick driver; see `ManualTickDriver`. */
export function createManualTickDriver(): ManualTickDriver {
  let registered: ReloadTick | undefined
  let stopped = false
  let startCalls = 0
  let stopCalls = 0
  let ticksRun = 0
  let last: Promise<void> = Promise.resolve()

  const driver: ManualTickDriver = {
    start(tick) {
      startCalls++
      if (registered === undefined && !stopped && startCalls === 1) registered = tick
    },
    stop() {
      stopCalls++
      stopped = true
      registered = undefined
    },
    get startCalls() {
      return startCalls
    },
    get stopCalls() {
      return stopCalls
    },
    get armed() {
      return registered !== undefined
    },
    get ticksRun() {
      return ticksRun
    },
    tick() {
      const tick = registered
      if (tick === undefined) {
        return Promise.reject(new Error('reload-harness: no tick is armed (the driver was never started, or was stopped)'))
      }
      ticksRun++
      const run = last.then(() => tick())
      last = run.catch(() => undefined)
      return run
    },
    async ticks(n) {
      for (let i = 0; i < n; i++) await driver.tick()
    },
  }
  return driver
}

// ---------------------------------------------------------------------------
// Lifecycle recorder
// ---------------------------------------------------------------------------

/** A per-persona lifecycle call the recorder saw. */
export type ReloadLifecycleOp = 'bring-up' | 'launch' | 'teardown' | 'reconnect' | 'update-in-place'

/**
 * What caused it: the start pass (`start`), the bring-up controller's own
 * retry (`retry`, launches only), or a lifecycle op the controller called for
 * one persona (`apply`).
 */
export type ReloadLifecycleVia = 'start' | 'retry' | 'apply'

/** One lifecycle call, in call order. Holds no token. */
export interface ReloadLifecycleRecord {
  readonly op: ReloadLifecycleOp
  readonly key: string
  readonly via: ReloadLifecycleVia
  /** Bring-up only: the controller's summary, set once the bring-up resolved. */
  result?: PersonaBringUpResultSummary
}

export interface ReloadLifecycleRecorder {
  /** The lifecycle operations the reload controller receives. */
  readonly ops: Required<ReloadLifecycleOps>
  /** Every per-persona call, in call order. */
  readonly records: readonly ReloadLifecycleRecord[]
  /** The applied configuration of each `startBringUp` call, in order. */
  readonly startPasses: readonly PersonaConfig[]
  /** The records of one op, in call order. */
  of(op: ReloadLifecycleOp): ReloadLifecycleRecord[]
  /** The persona keys of one op's records, in call order. */
  keys(op: ReloadLifecycleOp): string[]
  /** The outcome of the persona's latest resolved bring-up record; undefined if none resolved. */
  outcome(key: string): PersonaBringUpOutcome | undefined
  /** The failure classes of the persona's latest resolved bring-up record (credentials, directory, Slack order). */
  classes(key: string): string[]
  /**
   * Keep the next start pass from resolving (after its bring-ups and
   * launches) until the returned function is called, or make it reject with
   * `err` once its `fail(err)` is called.
   */
  holdStartPass(): StartPassHold
}

/** `holdStartPass()`'s handle: call it to let the held start pass return, or `fail(err)` to make it throw `err`. */
export interface StartPassHold {
  (): void
  fail(err: Error): void
}

// ---------------------------------------------------------------------------
// Write-failure seam
// ---------------------------------------------------------------------------

/** A `DurableWriteFs` call the seam can fail. */
export type DurableWriteStep = keyof DurableWriteFs

/** An injected write failure: every call of `step` (or only its `call`-th) throws an error with `code`. */
export interface WriteFailure {
  step: DurableWriteStep
  /** An errno code such as `EIO`, `ENOSPC` or `EROFS`. */
  code: string
  /** Fail only this call of `step` (1-based, counted from `failWrites`); every call when unset. */
  call?: number
}

/** One call of the controller's writer. */
export interface ReloadWriteRecord {
  readonly path: string
  /** Whether the durable write returned without throwing. */
  readonly ok: boolean
}

/**
 * One call of the controller's durable delete (`durableUnlinkSync` over the
 * remove seam), recorded as what happened to the file:
 * - `{ ok: true, removed: true, unsynced: false }`: removed and its directory synced;
 * - `{ ok: true, removed: false, unsynced: false }`: the path was already absent;
 * - `{ ok: true, removed: true, unsynced: true }`: removed, but the directory
 *   open or fsync failed after the unlink (`DurableUnlinkUnsyncedError`, which
 *   the delete threw on to the controller): the file IS gone;
 * - `{ ok: false, removed: undefined, unsynced: false }`: any other throw; the
 *   file is still there.
 */
export interface ReloadRemoveRecord {
  readonly path: string
  /** Whether the file is gone after the call (removed, durably or not, or already absent). */
  readonly ok: boolean
  /** True when this call removed a file, false when the path was already absent; undefined when the unlink itself failed. */
  readonly removed: boolean | undefined
  /** The file was removed but its directory could not be synced (the delete threw `DurableUnlinkUnsyncedError`). */
  readonly unsynced: boolean
}

/** Positions in a run's captures, taken by `run.checkpoint()`; compare with `run.since(cp)`. */
export interface ReloadRunCheckpoint {
  readonly logs: number
  readonly writes: number
  readonly removes: number
  readonly lifecycle: number
  readonly slackBuilds: number
  /** Web API calls so far, per persona key. */
  readonly slackCalls: Readonly<Record<string, number>>
}

/** What a run did since a checkpoint (`run.since(cp)`). */
export interface ReloadRunActivity {
  /** `[slack]` lines logged since (reload, bring-up and manager). */
  logs: string[]
  /** Calls of the controller's writer since. */
  writes: ReloadWriteRecord[]
  /** Calls of the controller's durable delete since. */
  removes: ReloadRemoveRecord[]
  /** Lifecycle records made since (any op, any `via`). */
  lifecycle: ReloadLifecycleRecord[]
  /** Slack clients the stub factory built since (connection manager or reload controller). */
  slackBuilds: number
  /** Web API calls made since, on any persona's stub. */
  slackCalls: StubWebCall[]
}

/**
 * A run that did nothing: `expect(run.since(cp)).toEqual(NO_RUN_ACTIVITY)`
 * shows a stretch of ticks logged, wrote, deleted, called a lifecycle op,
 * built a Slack client and called Slack not at all (AC 55).
 */
export const NO_RUN_ACTIVITY: Readonly<ReloadRunActivity> = Object.freeze({
  logs: [],
  writes: [],
  removes: [],
  lifecycle: [],
  slackBuilds: 0,
  slackCalls: [],
})

// ---------------------------------------------------------------------------
// Runs
// ---------------------------------------------------------------------------

export interface ReloadRunOptions {
  /** Dry run, passed as a flag to the connection manager and the bring-up controller. */
  dryRun?: boolean
  /** Per-persona-name stub options (scripted Slack outcomes); the leak marker is always on. */
  slack?: Readonly<Record<string, StubSlackOptions>>
  /** Overrides for the bring-up controller's file-system seam (credentials and working-directory checks). */
  bringUpFs?: Partial<PersonaBringUpFs>
  /** Overrides for the reload controller's file-system seam (reading the record, the configuration file and the pending file). */
  configFs?: Partial<PersonaConfigFs>
  /**
   * Overrides for the detection tick's credentials reads (`CredentialsFs`,
   * e.g. an `fstatFile` reporting a FIFO). The bring-up's own credentials
   * reads use `bringUpFs`.
   */
  credentialsFs?: Partial<CredentialsFs>
  /**
   * Replace the manual tick driver the controller gets (`run.ticks` is then
   * never armed). Only for the one case that shows the production driver's
   * first pass comes 5 s after `startDetection`: pass
   * `({ clock, log }) => createReloadTickDriver({ clock, log })`, which runs on
   * the run's fake clock (`run.clock`), never a real timer. Every other
   * reload test drives ticks through `run.ticks`.
   */
  tickDriver?: (deps: { clock: FakeClock; log: (line: string) => void }) => ReloadTickDriver
  /**
   * Wrap the reload controller's held-digest lookup: called with the persona
   * key and the default lookup (`run.bringUps.credentialsDigest`), e.g. to
   * throw and so fail a detection pass.
   */
  heldCredentialsDigest?: (
    key: string,
    held: (key: string) => CredentialsDigest | undefined,
  ) => CredentialsDigest | undefined
}

/** One server start over the harness's files; see the file comment. */
export interface ReloadRun {
  /** The real reload controller. */
  readonly controller: ReloadController
  /** The real bring-up controller the start pass drives. */
  readonly bringUps: PersonaBringUpController
  /** The connection harness: the real manager over the stub factory. */
  readonly connections: ConnectionHarness
  /** The stub factory the manager and the reload controller build Slack clients from. */
  readonly slack: StubSlackFactory
  /** The fake clock of the manager and the bring-up controller's retries. */
  readonly clock: FakeClock
  readonly ticks: ManualTickDriver
  readonly lifecycle: ReloadLifecycleRecorder
  /** The `[slack]` stream: every line the reload controller, bring-up controller and manager logged, in order. */
  readonly logs: string[]
  /** Every call of the controller's writer, in order. */
  readonly writes: readonly ReloadWriteRecord[]
  /** Every call of the controller's durable delete, in order. */
  readonly removes: readonly ReloadRemoveRecord[]
  /** The latest `run.resolveStart()` outcome (also set by `h.start`). */
  readonly outcome: ReloadStartOutcome | undefined
  /** `controller.resolveStart()`, keeping the outcome as `outcome`. */
  resolveStart(): ReloadStartOutcome
  /** `controller.startDetection()`: whether it armed the tick on `run.ticks`. */
  startDetection(): boolean
  /** The writer calls on `h.paths.pending`, in order. */
  pendingWrites(): ReloadWriteRecord[]
  /** The delete calls on `h.paths.pending`, in order. */
  pendingRemoves(): ReloadRemoveRecord[]
  /**
   * The logged lines of one diagnostic class or prefix label: those starting
   * `[slack] <label>: `, e.g. `logsOf(RELOAD_NOTHING_PENDING)`,
   * `logsOf(RELOAD_PREVIEW)`, or `logsOf('reload')` for the unclassed
   * `[slack] reload: …` lines (write, delete and tick failures).
   */
  logsOf(label: string): string[]
  /** Where every capture stands now; see `since`. */
  checkpoint(): ReloadRunCheckpoint
  /** Everything captured after `cp` (compare with `NO_RUN_ACTIVITY` for "did nothing"). */
  since(cp: ReloadRunCheckpoint): ReloadRunActivity
  /** The stub of the persona with this name. Throws in dry run or for a persona with no written credentials. */
  stub(name: string): StubSlack
  /** Every Web API call on every registered persona's stub, by persona key. */
  slackCalls(): Record<string, StubWebCall[]>
  /** Every `chat.postMessage` call on any persona's stub. */
  slackPosts(): StubWebCall[]
  /** Everything captured, plus `extra`, for `assertNoLeak`; written files as `writtenFile`. */
  captured(extra?: Record<string, unknown>): Record<string, unknown>
  /** Stop detection (`controller.stopDetection()`, which stops `run.ticks`), cancel every bring-up retry and stop every connection. Idempotent. */
  stop(): Promise<void>
}

/** A run whose start was resolved (and brought up when applied) by `h.start`. */
export interface StartedReloadRun extends ReloadRun {
  readonly outcome: ReloadStartOutcome
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

export interface ReloadHarnessOptions {
  /** Directory to create the root in; the OS temp directory by default. */
  parentDir?: string
}

/** A persona as far as the file helpers need it. */
export type ReloadPersonaFiles = Pick<PersonaInput, 'name' | 'credentials_file' | 'working_directory'>

export interface ReloadHarness {
  /** The `mkdtempSync` root (real path); every other path is under it. */
  readonly root: string
  /** The configuration directory: only the SR-8.1 files live here. */
  readonly dir: string
  /** The temp home handed to the controller for `~` expansion. */
  readonly home: string
  /** `reloadFilePaths(<dir>/config.json)`. */
  readonly paths: ReloadFilePaths
  /** The persona key of `name` (`personaKey`). */
  key(name: string): string
  /** A file-form persona named `name`: its own `all` channel, DMs off, paths under `<root>/personas/<key>/`. */
  persona(name: string, overrides?: Partial<PersonaInput>): PersonaInput
  /** Write `input` as JSON to `paths.config`; returns the bytes written. */
  writeConfig(input: unknown): Buffer
  /** Write raw bytes to `paths.config`; returns them. */
  writeConfigBytes(bytes: string | Uint8Array): Buffer
  /** Write `input` as JSON to `paths.lastApplied`, in `writeConfig`'s format; returns the bytes written. */
  writeRecord(input: unknown): Buffer
  /** Write raw bytes to `paths.lastApplied`; returns them. */
  writeRecordBytes(bytes: string | Uint8Array): Buffer
  /** The configuration file's bytes, or undefined when it does not exist. */
  readConfig(): Buffer | undefined
  /** The record's bytes, or undefined when it does not exist. */
  readRecord(): Buffer | undefined
  /** Delete a file or directory under the root (absent is fine). */
  remove(path: string): void
  /** Replace whatever is at `path` (under the root) with an empty directory. */
  replaceWithDirectory(path: string): void
  /** The names in the configuration directory, sorted. */
  configDirEntries(): string[]
  /** Write a valid credentials file for `persona` with a fresh token set; returns the set (never print it). */
  writeCredentials(persona: Pick<ReloadPersonaFiles, 'name' | 'credentials_file'>): PersonaSlackTokens
  /** Write `content` (see `CredentialsOverrides`) as `persona`'s credentials file; returns its path. */
  writeCredentialsContent(persona: Pick<ReloadPersonaFiles, 'credentials_file'>, content: CredentialsOverrides): string
  /** The latest token set `writeCredentials` wrote for the persona named `name`. Throws if none. */
  tokens(name: string): PersonaSlackTokens
  /** Create the persona's working directory; returns its path. */
  makeWorkingDirectory(persona: Pick<ReloadPersonaFiles, 'working_directory'>): string
  /** `writeCredentials` and `makeWorkingDirectory` for each persona. */
  materialize(...personas: ReloadPersonaFiles[]): void
  /**
   * Snapshot the persona's credentials file (its bytes, its absence, or an
   * empty directory at its path as `makeCredentialsUnreadable` leaves it) and
   * latest token set; the returned function puts both back exactly (a file
   * with mode 0600), e.g. to revert a rotation.
   */
  saveCredentials(persona: Pick<ReloadPersonaFiles, 'name' | 'credentials_file'>): () => void
  /** Delete the persona's credentials file (absent is fine). */
  deleteCredentials(persona: Pick<ReloadPersonaFiles, 'credentials_file'>): void
  /** Put an empty directory at the persona's credentials path: unreadable as a file, even as root. */
  makeCredentialsUnreadable(persona: Pick<ReloadPersonaFiles, 'credentials_file'>): void
  /** The credentials file's bytes, or undefined when it does not exist. */
  readCredentialsBytes(persona: Pick<ReloadPersonaFiles, 'credentials_file'>): Buffer | undefined
  /**
   * The digest or marker the production reader gives the persona's
   * credentials file as it stands (`credentialsDigest(readCredentialsFile(…))`),
   * to compare with `run.bringUps.credentialsDigest(key)`. Never print it.
   */
  credentialsDigestOf(persona: Pick<ReloadPersonaFiles, 'credentials_file'>): CredentialsDigest
  /** Delete `paths.config` (absent is fine). */
  deleteConfig(): void
  /** Replace whatever is at `path` (under the root) with a FIFO (`mkfifo`); guard the test with `mkfifoAvailable()`. */
  makeFifo(path: string): void
  /** Whether `paths.pending` exists (as anything). */
  pendingExists(): boolean
  /** `paths.pending`'s bytes, or undefined when it is not a readable file. */
  readPending(): Buffer | undefined
  /** `paths.pending` as UTF-8 text, or undefined when it is not a readable file. */
  readPendingText(): string | undefined
  /** The fingerprint `paths.pending` records (`parsePendingFingerprint`), or undefined when absent or not in the pending layout. */
  pendingFingerprint(): string | undefined
  /** Write raw bytes to `paths.pending` (a leftover or hand-placed file); returns them. */
  writePendingBytes(bytes: string | Uint8Array): Buffer
  /** Make the controller's durable writer fail (default every `openSync` call, `EIO`) until cleared. */
  failWrites(failure?: Partial<WriteFailure>): void
  /** Let the controller's durable writer succeed again. */
  clearWriteFailure(): void
  /**
   * Make the controller's durable delete fail (default every `unlinkSync`
   * call, `EIO`) until cleared: its own seam, counted apart from
   * `failWrites`. `{ step: 'fsyncSync' }` fails the directory fsync after
   * the unlink (the file is then gone).
   */
  failRemoves(failure?: Partial<WriteFailure>): void
  /** Let the controller's durable delete succeed again. */
  clearRemoveFailure(): void
  /** Build a run without resolving its start. */
  build(opts?: ReloadRunOptions): ReloadRun
  /** Build a run, resolve its start and, when applied, run the start bring-up pass. */
  start(opts?: ReloadRunOptions): Promise<StartedReloadRun>
  /**
   * `start`, then `run.startDetection()`, as `main()` does. Throws when the
   * tick was not armed (a refused start); use `start` and
   * `run.startDetection()` to test that.
   */
  startDetecting(opts?: ReloadRunOptions): Promise<StartedReloadRun>
  /** Every run built, in order. */
  readonly runs: readonly ReloadRun[]
  /** Stop every run and remove the root. */
  cleanup(): Promise<void>
}

/** First part of every channel ID `h.persona` assigns. */
const CHANNEL_ID_STEM = 'C0RLD'

/** An errno-style error for the write-failure seam. */
function injectedWriteError(failure: WriteFailure): Error {
  return Object.assign(new Error(`${failure.code}: reload-harness injected ${failure.step} failure`), {
    code: failure.code,
  })
}

/** A `DurableWriteFs` over the real calls, each failing while the armed failure names it. */
interface FailureSeam {
  readonly fs: DurableWriteFs
  fail(failure?: Partial<WriteFailure>): void
  clear(): void
}

function makeFailureSeam(defaultStep: DurableWriteStep): FailureSeam {
  let failure: WriteFailure | undefined
  /** Calls of `failure.step` since `fail`. */
  let failingStepCalls = 0

  function seamCall<A extends unknown[], R>(step: DurableWriteStep, call: (...args: A) => R): (...args: A) => R {
    return (...args) => {
      if (failure?.step === step) {
        failingStepCalls++
        if (failure.call === undefined || failure.call === failingStepCalls) throw injectedWriteError(failure)
      }
      return call(...args)
    }
  }

  return {
    fs: {
      openSync: seamCall('openSync', (path: string, flags: string) => openSync(path, flags)),
      writeSync: seamCall('writeSync', (fd: number, buffer: Uint8Array, offset: number, length: number) =>
        writeSync(fd, buffer, offset, length),
      ),
      fsyncSync: seamCall('fsyncSync', (fd: number) => fsyncSync(fd)),
      closeSync: seamCall('closeSync', (fd: number) => closeSync(fd)),
      renameSync: seamCall('renameSync', (from: string, to: string) => renameSync(from, to)),
      unlinkSync: seamCall('unlinkSync', (path: string) => unlinkSync(path)),
    },
    fail(f = {}) {
      failure = { step: f.step ?? defaultStep, code: f.code ?? 'EIO', call: f.call }
      failingStepCalls = 0
    },
    clear() {
      failure = undefined
    },
  }
}

/** Build the harness described in the file comment. */
export function makeReloadHarness(opts: ReloadHarnessOptions = {}): ReloadHarness {
  const root = realpathSync(mkdtempSync(join(opts.parentDir ?? tmpdir(), 'reload-harness-')))
  const dir = join(root, 'config')
  const home = join(root, 'home')
  mkdirSync(dir)
  mkdirSync(home)
  const paths = reloadFilePaths(join(dir, 'config.json'))

  const channels = new Map<string, string>()
  const tokensByName = new Map<string, PersonaSlackTokens>()
  const credentialWrites = new Map<string, number>()
  const runs: ReloadRun[] = []

  /** `path`, resolved, if it is strictly under the root; throws otherwise. */
  function inside(path: string): string {
    const full = resolve(root, path)
    const rel = relative(root, full)
    if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
      throw new Error(`reload-harness: path must be under the harness root, got ${JSON.stringify(path)}`)
    }
    return full
  }

  function serialize(input: unknown): Buffer {
    return Buffer.from(JSON.stringify(input, null, 2), 'utf-8')
  }

  function writeBytes(path: string, bytes: string | Uint8Array): Buffer {
    const buf = typeof bytes === 'string' ? Buffer.from(bytes, 'utf-8') : Buffer.from(bytes)
    writeFileSync(inside(path), buf)
    return buf
  }

  function readIfPresent(path: string): Buffer | undefined {
    return existsSync(path) ? readFileSync(path) : undefined
  }

  /** A regular file's bytes; undefined when absent or not a regular file (a directory, a FIFO: never opened). */
  function readFileIfPresent(path: string): Buffer | undefined {
    try {
      if (!statSync(path).isFile()) return undefined
    } catch {
      return undefined
    }
    return readFileSync(path)
  }

  const writeSeam = makeFailureSeam('openSync')
  const removeSeam = makeFailureSeam('unlinkSync')

  function build(runOpts: ReloadRunOptions = {}): ReloadRun {
    const dryRun = runOpts.dryRun ?? false
    const connections = makeConnectionHarness(
      [...tokensByName.keys()].map((name) => ({ name })),
      root,
      { dryRun, stubOptions: runOpts.slack, tokens: Object.fromEntries(tokensByName) },
    )
    const logs = connections.lines
    const log = (line: string) => void logs.push(line)
    const records: ReloadLifecycleRecord[] = []
    const startPasses: PersonaConfig[] = []
    const writes: ReloadWriteRecord[] = []
    const removes: ReloadRemoveRecord[] = []
    let startHold: Promise<void> | undefined
    let outcome: ReloadStartOutcome | undefined

    function record(op: ReloadLifecycleOp, key: string, via: ReloadLifecycleVia): ReloadLifecycleRecord {
      const entry: ReloadLifecycleRecord = { op, key, via }
      records.push(entry)
      return entry
    }

    const bringUps = createPersonaBringUpController({
      connections: {
        bringUp: (persona, tokens) => connections.connections.bringUp(persona, tokens),
        status: (key) => connections.manager.status(key),
      },
      clock: connections.clock,
      dryRun,
      log,
      fs: runOpts.bringUpFs,
      launch: async (persona) => void record('launch', persona.key, 'retry'),
    })
    connections.onStatus = composePersonaStatusListeners((key, status) => bringUps.onConnectionStatus(key, status))

    /** One persona's bring-up through the real controller, then its recorded launch when up. */
    async function bringUpAndLaunch(persona: Persona, applied: PersonaConfig, via: ReloadLifecycleVia): Promise<void> {
      const entry = record('bring-up', persona.key, via)
      entry.result = await bringUps.bringUp(persona, applied.personas)
      if (entry.result.outcome === 'up') record('launch', persona.key, via)
    }

    const ops: Required<ReloadLifecycleOps> = {
      async startBringUp(applied) {
        startPasses.push(applied)
        connections.config = applied
        await Promise.all(applied.personas.map((persona) => bringUpAndLaunch(persona, applied, 'start')))
        if (startHold !== undefined) await startHold
      },
      async bringUp(persona, applied) {
        connections.config = applied
        await bringUpAndLaunch(persona, applied, 'apply')
      },
      async teardown(persona) {
        record('teardown', persona.key, 'apply')
        bringUps.cancel(persona.key)
        await connections.manager.stop(persona.key)
      },
      async reconnectCredentials(persona) {
        record('reconnect', persona.key, 'apply')
      },
      async updateInPlace(persona) {
        record('update-in-place', persona.key, 'apply')
      },
    }

    function latestResolvedBringUp(key: string): ReloadLifecycleRecord | undefined {
      return records.filter((r) => r.op === 'bring-up' && r.key === key && r.result !== undefined).at(-1)
    }

    const lifecycle: ReloadLifecycleRecorder = {
      ops,
      records,
      startPasses,
      of: (op) => records.filter((r) => r.op === op),
      keys: (op) => records.filter((r) => r.op === op).map((r) => r.key),
      outcome: (key) => latestResolvedBringUp(key)?.result?.outcome,
      classes: (key) => latestResolvedBringUp(key)?.result?.failures.map((f) => f.class) ?? [],
      holdStartPass() {
        let release!: () => void
        let fail!: (err: Error) => void
        startHold = new Promise<void>((done, reject) => {
          release = done
          fail = reject
        })
        // Handled here too, so a `fail` before the pass reaches its await is no unhandled rejection.
        startHold.catch(() => undefined)
        return Object.assign(() => release(), { fail })
      },
    }

    const ticks = createManualTickDriver()
    const controller = createReloadController({
      paths,
      lifecycle: ops,
      log,
      write: (path, bytes) => {
        try {
          durableWriteFileSync(path, bytes, writeSeam.fs)
        } catch (err) {
          writes.push({ path, ok: false })
          throw err
        }
        writes.push({ path, ok: true })
      },
      remove: (path) => {
        let removed: boolean
        try {
          removed = durableUnlinkSync(path, removeSeam.fs)
        } catch (err) {
          const unsynced = err instanceof DurableUnlinkUnsyncedError
          removes.push(unsynced ? { path, ok: true, removed: true, unsynced } : { path, ok: false, removed: undefined, unsynced })
          throw err
        }
        removes.push({ path, ok: true, removed, unsynced: false })
        return removed
      },
      tickDriver: runOpts.tickDriver?.({ clock: connections.clock, log }) ?? ticks,
      dryRun,
      heldCredentialsDigest: (key) => {
        const held = (k: string) => bringUps.credentialsDigest(k)
        return runOpts.heldCredentialsDigest === undefined ? held(key) : runOpts.heldCredentialsDigest(key, held)
      },
      credentialsFs: runOpts.credentialsFs,
      slackClientFactory: connections.slack.factory,
      home,
      configFs: runOpts.configFs,
    })

    function slackCalls(): Record<string, StubWebCall[]> {
      if (dryRun) return {}
      return Object.fromEntries(connections.personas.map((p) => [p.key, [...connections.slack.persona(p.key).callLog]]))
    }

    function checkpoint(): ReloadRunCheckpoint {
      return {
        logs: logs.length,
        writes: writes.length,
        removes: removes.length,
        lifecycle: records.length,
        slackBuilds: connections.slack.builds.length,
        slackCalls: Object.fromEntries(Object.entries(slackCalls()).map(([key, calls]) => [key, calls.length])),
      }
    }

    function since(cp: ReloadRunCheckpoint): ReloadRunActivity {
      return {
        logs: logs.slice(cp.logs),
        writes: writes.slice(cp.writes),
        removes: removes.slice(cp.removes),
        lifecycle: records.slice(cp.lifecycle),
        slackBuilds: connections.slack.builds.length - cp.slackBuilds,
        slackCalls: Object.entries(slackCalls()).flatMap(([key, calls]) => calls.slice(cp.slackCalls[key] ?? 0)),
      }
    }

    let stopped = false
    const run: ReloadRun = {
      controller,
      bringUps,
      connections,
      slack: connections.slack,
      clock: connections.clock,
      ticks,
      lifecycle,
      logs,
      writes,
      removes,
      get outcome() {
        return outcome
      },
      resolveStart() {
        outcome = controller.resolveStart()
        return outcome
      },
      startDetection: () => controller.startDetection(),
      pendingWrites: () => writes.filter((w) => w.path === paths.pending),
      pendingRemoves: () => removes.filter((r) => r.path === paths.pending),
      logsOf: (label) => logs.filter((line) => line.startsWith(`[slack] ${label}: `)),
      checkpoint,
      since,
      stub: (name) => connections.slack.persona(personaKey(name)),
      slackCalls,
      slackPosts: () => Object.values(slackCalls()).flat().filter((c) => c.method === 'chat.postMessage'),
      captured: (extra = {}) => ({
        logs,
        statuses: connections.statuses,
        lifecycle: records,
        outcome,
        writes,
        removes,
        slack: slackCalls(),
        written: [...new Set(writes.filter((w) => w.ok).map((w) => w.path))]
          .filter((path) => existsSync(path))
          .map((path) => writtenFile(path)),
        ...extra,
      }),
      async stop() {
        if (stopped) return
        stopped = true
        controller.stopDetection()
        bringUps.cancelAll()
        await connections.manager.stopAll()
      },
    }
    runs.push(run)
    return run
  }

  const h: ReloadHarness = {
    root,
    dir,
    home,
    paths,
    key: (name) => personaKey(name),
    persona(name, overrides = {}) {
      let channel = channels.get(name)
      if (channel === undefined) {
        channel = `${CHANNEL_ID_STEM}${String(channels.size + 1).padStart(3, '0')}`
        channels.set(name, channel)
      }
      return makePersona({ name, channels: [{ id: channel, delivery: 'all' }], permission_prompts: channel, ...overrides }, root)
    },
    writeConfig: (input) => writeBytes(paths.config, serialize(input)),
    writeConfigBytes: (bytes) => writeBytes(paths.config, bytes),
    writeRecord: (input) => writeBytes(paths.lastApplied, serialize(input)),
    writeRecordBytes: (bytes) => writeBytes(paths.lastApplied, bytes),
    readConfig: () => readIfPresent(paths.config),
    readRecord: () => readIfPresent(paths.lastApplied),
    remove: (path) => rmSync(inside(path), { recursive: true, force: true }),
    replaceWithDirectory(path) {
      const full = inside(path)
      rmSync(full, { recursive: true, force: true })
      mkdirSync(full, { recursive: true })
    },
    configDirEntries: () => readdirSync(dir).sort(),
    writeCredentials(persona) {
      const key = personaKey(persona.name)
      const n = (credentialWrites.get(key) ?? 0) + 1
      credentialWrites.set(key, n)
      const tokens = new PersonaSlackTokens(
        fakeToken(BOT_TOKEN_PREFIX, `${key}-bot-${n}`),
        fakeToken(APP_TOKEN_PREFIX, `${key}-app-${n}`),
      )
      writeCredentialsFile(root, relative(root, inside(persona.credentials_file)), {
        bot_token: tokens.botToken,
        app_token: tokens.appToken,
      })
      tokensByName.set(persona.name, tokens)
      return tokens
    },
    writeCredentialsContent: (persona, content) =>
      writeCredentialsFile(root, relative(root, inside(persona.credentials_file)), content),
    tokens(name) {
      const tokens = tokensByName.get(name)
      if (tokens === undefined) throw new Error(`reload-harness: no credentials written for ${JSON.stringify(name)}`)
      return tokens
    },
    makeWorkingDirectory(persona) {
      const full = inside(persona.working_directory)
      mkdirSync(full, { recursive: true })
      return full
    },
    materialize(...personas) {
      for (const persona of personas) {
        h.writeCredentials(persona)
        h.makeWorkingDirectory(persona)
      }
    },
    saveCredentials(persona) {
      const path = inside(persona.credentials_file)
      const bytes = readFileIfPresent(path)
      const wasDirectory = bytes === undefined && existsSync(path) && statSync(path).isDirectory()
      const tokens = tokensByName.get(persona.name)
      return () => {
        rmSync(path, { recursive: true, force: true })
        if (wasDirectory) mkdirSync(path, { recursive: true })
        if (bytes !== undefined) {
          mkdirSync(dirname(path), { recursive: true })
          writeFileSync(path, bytes, { mode: 0o600 })
          chmodSync(path, 0o600)
        }
        if (tokens === undefined) tokensByName.delete(persona.name)
        else tokensByName.set(persona.name, tokens)
      }
    },
    deleteCredentials: (persona) => h.remove(persona.credentials_file),
    makeCredentialsUnreadable: (persona) => h.replaceWithDirectory(persona.credentials_file),
    readCredentialsBytes: (persona) => readFileIfPresent(inside(persona.credentials_file)),
    credentialsDigestOf: (persona) => credentialsDigest(readCredentialsFile(inside(persona.credentials_file))),
    deleteConfig: () => h.remove(paths.config),
    makeFifo(path) {
      const full = inside(path)
      rmSync(full, { recursive: true, force: true })
      mkdirSync(dirname(full), { recursive: true })
      const made = spawnSync('mkfifo', [full])
      if (made.status !== 0) throw new Error('reload-harness: mkfifo failed (guard the test with mkfifoAvailable())')
    },
    pendingExists: () => existsSync(paths.pending),
    readPending: () => readFileIfPresent(paths.pending),
    readPendingText: () => readFileIfPresent(paths.pending)?.toString('utf-8'),
    pendingFingerprint() {
      const text = h.readPendingText()
      return text === undefined ? undefined : parsePendingFingerprint(text)
    },
    writePendingBytes: (bytes) => writeBytes(paths.pending, bytes),
    failWrites: (failure) => writeSeam.fail(failure),
    clearWriteFailure: () => writeSeam.clear(),
    failRemoves: (failure) => removeSeam.fail(failure),
    clearRemoveFailure: () => removeSeam.clear(),
    build,
    async start(runOpts) {
      const run = build(runOpts)
      const outcome = run.resolveStart()
      if (outcome.kind === 'applied') await run.controller.runStartBringUp()
      return run as StartedReloadRun
    },
    async startDetecting(runOpts) {
      const run = await h.start(runOpts)
      if (!run.startDetection()) {
        throw new Error(`reload-harness: startDetection() armed nothing (start outcome: ${run.outcome.kind})`)
      }
      return run
    },
    runs,
    async cleanup() {
      for (const run of runs) await run.stop()
      rmSync(root, { recursive: true, force: true })
    },
  }
  return h
}
