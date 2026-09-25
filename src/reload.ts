/**
 * reload.ts — The reload controller: the last-applied record and the start
 * rules (b.av2 SR-8.1, SR-8.7, SR-13.1).
 *
 * Saving `config.json` does not change what runs. The server keeps a byte
 * copy of the last applied configuration, `config.json.last-applied` (the
 * record), beside the configuration file, and every start runs it:
 *
 * - record present: its bytes are read once and validated in record mode
 *   (`parsePersonaConfigBytes`), where a real-path collision is left to the
 *   bring-up (b.av2 SR-1.5). The configuration file is not read to decide
 *   what runs. A record that cannot be read or validated stops the start; the
 *   line names the record and says that deleting it makes the next start
 *   apply the configuration file;
 * - no record: the configuration file's bytes are read once and validated in
 *   default mode. A missing, unreadable or invalid file (a pre-persona file
 *   gets the SR-1.7 conversion error) stops the start. A valid file's bytes
 *   are written to the record with the durable writer before anything is
 *   applied; a failed write stops the start (`reload-record-write-failed`),
 *   including one whose record reached the disk but whose directory could
 *   not be synced (that line says the next start will run the record).
 *
 * Credentials files are never read here: the start bring-up reads them as
 * they stand, so a credentials change made while the server was down takes
 * effect at the start. An empty `personas` array is a valid applied set.
 *
 * The controller (`createReloadController`) is built with every dependency
 * injected, as `createCronScheduler` is: the SR-8.1 paths, the durable
 * writer, the log sink, the lifecycle operations (the start bring-up pass
 * today), and the tick driver and Slack client factory that later work binds
 * (the detection tick, applying a confirmed change). It keeps the applied
 * bytes and configuration in memory. `readAppliedPersonaConfig` is the
 * CLI's read-only resolver over the same rules.
 *
 * Importable without side effects (b.av2 SR-13.1): importing it creates no
 * timer or Slack client, reads no file or environment variable and logs
 * nothing. No line it logs carries a token or file content. Its output goes
 * to the server log only, never to Slack (b.av2 SR-7.2).
 *
 * SPDX-License-Identifier: MIT
 */

import { dirname, resolve } from 'node:path'

import { durableWriteFileSync, DurableWriteUnsyncedError } from './atomic-write.ts'
import {
  configFileReadFailureMessage,
  credentialsFilesToProtect,
  isMissingConfigCode,
  parsePersonaConfigBytes,
  PersonaConfigReadError,
  readPersonaConfigBytes,
  type Persona,
  type PersonaConfig,
  type PersonaConfigFs,
} from './config.ts'
import { errnoSuffix } from './persona-credentials.ts'
import { expandTilde } from './persona-identity.ts'
import type { PersonaSlackClientFactory } from './persona-slack-clients.ts'

// ---------------------------------------------------------------------------
// Diagnostic classes (b.av2 SR-10.3)
// ---------------------------------------------------------------------------

/**
 * The last-applied record could not be written. At a start without a record,
 * the server does not start and nothing is applied.
 */
export const RELOAD_RECORD_WRITE_FAILED = 'reload-record-write-failed'

/**
 * Every reload diagnostic class label, in a fixed order. Kept apart from the
 * persona classes (`PERSONA_DIAGNOSTIC_CLASSES`): a reload line is about the
 * configuration, not one persona.
 */
export const RELOAD_DIAGNOSTIC_CLASSES = [RELOAD_RECORD_WRITE_FAILED] as const

/** A reload diagnostic class label (closed set). */
export type ReloadDiagnosticClass = (typeof RELOAD_DIAGNOSTIC_CLASSES)[number]

// ---------------------------------------------------------------------------
// Reload files (b.av2 SR-8.1)
// ---------------------------------------------------------------------------

/** Appended to the configuration file's name: the pending-change preview. */
export const PENDING_FILE_SUFFIX = '.pending'

/** Appended to the configuration file's name: the confirmation name. */
export const APPLY_FILE_SUFFIX = '.apply'

/** Appended to the configuration file's name: the last-applied record. */
export const LAST_APPLIED_FILE_SUFFIX = '.last-applied'

/** The configuration file and the three reload files beside it (b.av2 SR-8.1). */
export interface ReloadFilePaths {
  /** The configuration file, e.g. `<dir>/config.json`. */
  config: string
  /** `<dir>/config.json.pending`: the preview, present only while a change is pending. */
  pending: string
  /** `<dir>/config.json.apply`: the confirmation name. */
  apply: string
  /** `<dir>/config.json.last-applied`: a byte copy of the last applied configuration. */
  lastApplied: string
}

/**
 * The reload files for the configuration file at `configPath`: in the same
 * directory, named by appending `.pending`, `.apply` and `.last-applied` to
 * its name. Pure: touches no file.
 */
export function reloadFilePaths(configPath: string): ReloadFilePaths {
  return {
    config: configPath,
    pending: configPath + PENDING_FILE_SUFFIX,
    apply: configPath + APPLY_FILE_SUFFIX,
    lastApplied: configPath + LAST_APPLIED_FILE_SUFFIX,
  }
}

// ---------------------------------------------------------------------------
// Dependencies
// ---------------------------------------------------------------------------

/** One pass of the detection tick. */
export type ReloadTick = () => Promise<void>

/**
 * Drives the detection tick: one serialized, self-re-arming timer in
 * production, a manual driver in tests. Bound by the detection tick's work;
 * nothing arms it yet.
 */
export interface ReloadTickDriver {
  /** Run `tick` repeatedly, never two passes at once. */
  start(tick: ReloadTick): void
  /** Stop running it. Idempotent. */
  stop(): void
}

/**
 * The per-persona lifecycle operations the controller drives. `startBringUp`
 * is the start pass; the others are bound by the work that first applies a
 * confirmed change, and nothing calls them yet.
 */
export interface ReloadLifecycleOps {
  /**
   * The start bring-up pass over the whole applied set: every persona's
   * bring-up and, for each persona that is up, its launch. Resolves once
   * every persona has an outcome (production: `startupSessionManager` over
   * the bring-up controller).
   */
  startBringUp(applied: PersonaConfig): Promise<unknown>
  /** Bring up one persona a confirmed change added. */
  bringUp?(persona: Persona, applied: PersonaConfig): Promise<unknown>
  /** Tear down one persona a confirmed change removed or destructively modified. */
  teardown?(persona: Persona): Promise<unknown>
  /** Reconnect one persona with its changed credentials file. */
  reconnectCredentials?(persona: Persona, applied: PersonaConfig): Promise<unknown>
  /** Apply one persona's modified settings without tearing it down. */
  updateInPlace?(persona: Persona, previous: Persona, applied: PersonaConfig): Promise<unknown>
}

/**
 * Writes bytes atomically and durably (`durableWriteFileSync` in production).
 * Throws on failure: a `DurableWriteUnsyncedError` when the bytes reached the
 * path but its directory could not be synced, any other error when the path
 * was left unchanged.
 */
export type ReloadFileWriter = (path: string, bytes: Uint8Array) => void

/** Dependencies of `createReloadController`. */
export interface ReloadControllerDeps {
  /** The configuration file and its reload files (`reloadFilePaths`). */
  paths: ReloadFilePaths
  /** The lifecycle operations; `startBringUp` is required. */
  lifecycle: ReloadLifecycleOps
  /** Receives each `[slack]` line the controller logs (the server log). */
  log: (line: string) => void
  /** The durable writer; `durableWriteFileSync` by default. */
  write?: ReloadFileWriter
  /** The detection tick's driver; bound by the detection tick's work. */
  tickDriver?: ReloadTickDriver
  /** The Slack client factory; bound by the work that applies a confirmed change. */
  slackClientFactory?: PersonaSlackClientFactory
  /** Home directory for every `~` in the configuration; the OS home by default. */
  home?: string
  /**
   * File-system overrides for reading the record and the configuration file
   * (`readPersonaConfigBytes`, which reads only a regular file); unset
   * operations use the real file system.
   */
  configFs?: Partial<PersonaConfigFs>
}

// ---------------------------------------------------------------------------
// Start resolution
// ---------------------------------------------------------------------------

/** Where the applied configuration came from. */
export type AppliedConfigSource = 'record' | 'config'

/** The applied configuration and the exact bytes it was validated from. */
export interface AppliedConfiguration {
  config: PersonaConfig
  /** The bytes that were read and validated; the record holds exactly these. */
  bytes: Uint8Array
  source: AppliedConfigSource
}

/** The outcome of `resolveStart`. */
export type ReloadStartOutcome =
  | ({ kind: 'applied' } & AppliedConfiguration)
  | {
      kind: 'refused'
      /** Which file stopped the start. */
      source: AppliedConfigSource
      /** The SR-10.3 class, when the refusal has one. */
      class: ReloadDiagnosticClass | undefined
      /** The line that was logged. */
      line: string
    }

/** Start of the line for a refused start whose configuration file cannot be used. */
const CONFIG_REFUSAL_PREFIX = '[slack] Fatal: configuration error — '

/** Start of the line for a refused start whose last-applied record cannot be used. */
const RECORD_REFUSAL_PREFIX = '[slack] Fatal: last-applied record error — '

/** A configuration chosen by the start rules, or why none can be. */
type Selection =
  | { ok: true; applied: AppliedConfiguration }
  | { ok: false; source: AppliedConfigSource; message: string }

/**
 * `cause` followed by the deletion hint: names the record and says that
 * deleting it makes the next start apply the configuration file.
 */
function recordFailureMessage(paths: ReloadFilePaths, cause: string): string {
  return (
    `${cause} Deleting the last-applied record "${paths.lastApplied}" makes the next start ` +
    `apply the configuration file "${paths.config}" as it stands.`
  )
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * The start rules' choice, reading each file at most once and writing
 * nothing: the record in record mode when it exists, otherwise the
 * configuration file in default mode. A record is absent only when reading
 * it fails because it (or an ancestor) does not exist; any other read failure
 * (a directory, a FIFO or a device included) is a record that cannot be read.
 * Each file is read through `readPersonaConfigBytes`, so a path that is not a
 * regular file is never read and cannot hang the start.
 */
function selectConfiguration(
  paths: ReloadFilePaths,
  home: string | undefined,
  fs: Partial<PersonaConfigFs> | undefined,
): Selection {
  const configDir = dirname(paths.config)

  let recordBytes: Buffer | undefined
  try {
    recordBytes = readPersonaConfigBytes(paths.lastApplied, fs)
  } catch (err) {
    const code = err instanceof PersonaConfigReadError ? err.code : undefined
    if (!isMissingConfigCode(code)) {
      const cause = `The last-applied record "${paths.lastApplied}" cannot be read${code !== undefined ? ` (${code})` : ''}.`
      return { ok: false, source: 'record', message: recordFailureMessage(paths, cause) }
    }
  }
  if (recordBytes !== undefined) {
    try {
      const config = parsePersonaConfigBytes(recordBytes, paths.lastApplied, configDir, { home, record: true })
      return { ok: true, applied: { config, bytes: recordBytes, source: 'record' } }
    } catch (err) {
      return { ok: false, source: 'record', message: recordFailureMessage(paths, errorMessage(err)) }
    }
  }

  let configBytes: Buffer
  try {
    configBytes = readPersonaConfigBytes(paths.config, fs)
  } catch (err) {
    const code = err instanceof PersonaConfigReadError ? err.code : undefined
    return { ok: false, source: 'config', message: configFileReadFailureMessage(paths.config, code) }
  }
  try {
    const config = parsePersonaConfigBytes(configBytes, paths.config, configDir, { home })
    return { ok: true, applied: { config, bytes: configBytes, source: 'config' } }
  } catch (err) {
    return { ok: false, source: 'config', message: errorMessage(err) }
  }
}

// ---------------------------------------------------------------------------
// Controller
// ---------------------------------------------------------------------------

/** The reload controller handle. */
export interface ReloadController {
  /**
   * Resolve the start (b.av2 SR-8.7): choose the record or the configuration
   * file, write the record when there was none, and keep the applied bytes
   * and configuration. A refusal is logged here, as one line, and nothing is
   * applied. Reads no credentials file. Call once, before anything consumes
   * the configuration; a second call throws.
   */
  resolveStart(): ReloadStartOutcome
  /**
   * The start bring-up pass over the applied set, through the injected
   * `lifecycle.startBringUp`. Call once, after `resolveStart` returned
   * `applied` and after the server's pre-launch steps; any other call throws.
   * Resolves when the pass returns.
   */
  runStartBringUp(): Promise<void>
  /** The applied configuration and its bytes, once the start resolved `applied`. */
  applied(): AppliedConfiguration | undefined
  /**
   * The credentials files the file guard must refuse (b.av2 SR-5.2): the
   * applied set's `credentials_file` paths, plus every `credentials_file`
   * string in the `personas` entries of the configuration file as it stands
   * now (`credentialsFilesToProtect`). Reads the configuration file on every
   * call, whatever the start phase. A missing, non-regular or non-JSON file
   * adds none. Reads no credentials file and never throws.
   */
  protectedCredentialsFiles(): string[]
}

/** Where the controller is in the start. */
type StartPhase = 'unresolved' | 'refused' | 'applied' | 'bringing-up' | 'brought-up'

/**
 * Create the reload controller. Creating it reads, writes, logs and arms
 * nothing. `resolveStart` does the start's reads, write and log line;
 * `protectedCredentialsFiles` reads the configuration file on each call, at
 * any phase, and writes and logs nothing.
 */
export function createReloadController(deps: ReloadControllerDeps): ReloadController {
  const { paths, lifecycle } = deps
  const write = deps.write ?? durableWriteFileSync
  let phase: StartPhase = 'unresolved'
  let appliedState: AppliedConfiguration | undefined

  function refuse(source: AppliedConfigSource, cls: ReloadDiagnosticClass | undefined, line: string): ReloadStartOutcome {
    phase = 'refused'
    deps.log(line)
    return { kind: 'refused', source, class: cls, line }
  }

  function resolveStart(): ReloadStartOutcome {
    if (phase !== 'unresolved') throw new Error('reload: resolveStart may be called only once')
    const selection = selectConfiguration(paths, deps.home, deps.configFs)
    if (!selection.ok) {
      const prefix = selection.source === 'record' ? RECORD_REFUSAL_PREFIX : CONFIG_REFUSAL_PREFIX
      return refuse(selection.source, undefined, prefix + selection.message)
    }
    const { applied } = selection
    if (applied.source === 'config') {
      try {
        write(paths.lastApplied, applied.bytes)
      } catch (err) {
        if (err instanceof DurableWriteUnsyncedError) {
          // The rename happened: the record is on disk and the next start runs
          // it. Say so, rather than "cannot write".
          return refuse(
            'config',
            RELOAD_RECORD_WRITE_FAILED,
            `[slack] ${RELOAD_RECORD_WRITE_FAILED}: the last-applied record "${paths.lastApplied}" was written but its ` +
              `directory could not be synced${errnoSuffix(err)}, so it may not survive a crash, and the next start ` +
              `will run it; the server does not start`,
          )
        }
        return refuse(
          'config',
          RELOAD_RECORD_WRITE_FAILED,
          `[slack] ${RELOAD_RECORD_WRITE_FAILED}: cannot write the last-applied record "${paths.lastApplied}"` +
            `${errnoSuffix(err)}; the server does not start and nothing is applied`,
        )
      }
      deps.log(`[slack] No last-applied record: recorded the configuration file "${paths.config}" as "${paths.lastApplied}"`)
    } else {
      deps.log(`[slack] Starting from the last-applied record "${paths.lastApplied}"`)
    }
    phase = 'applied'
    appliedState = applied
    return { kind: 'applied', ...applied }
  }

  async function runStartBringUp(): Promise<void> {
    if (phase !== 'applied' || appliedState === undefined) {
      throw new Error('reload: the start bring-up runs once, after the start resolved an applied configuration')
    }
    phase = 'bringing-up'
    try {
      await lifecycle.startBringUp(appliedState.config)
    } finally {
      phase = 'brought-up'
    }
  }

  return {
    resolveStart,
    runStartBringUp,
    applied: () => appliedState,
    protectedCredentialsFiles: () =>
      credentialsFilesToProtect(appliedState?.config.personas ?? [], paths.config, deps.home, deps.configFs),
  }
}

// ---------------------------------------------------------------------------
// CLI resolver
// ---------------------------------------------------------------------------

/**
 * The configuration the CLI takes its settings and persona set from (b.av2
 * SR-8.7): the last-applied record beside `configPath` when it exists
 * (validated in record mode, so a record with a real-path collision still
 * resolves), otherwise the configuration file. Read-only: never writes,
 * rewrites or deletes the record or any other reload file. A record that
 * exists but cannot be read or validated throws, naming the record with the
 * deletion hint; it never falls back to the configuration file. A
 * configuration-file failure throws with the start's wording.
 *
 * @param configPath  The configuration file the server loads; `~` is expanded under `home`.
 * @param home        Home directory for every `~`; the OS home by default.
 * @param fs          File-system overrides for the reads (`readPersonaConfigBytes`);
 *   the real file system by default.
 */
export function readAppliedPersonaConfig(
  configPath: string,
  home?: string,
  fs?: Partial<PersonaConfigFs>,
): PersonaConfig {
  const selection = selectConfiguration(reloadFilePaths(resolve(expandTilde(configPath, home))), home, fs)
  if (!selection.ok) throw new Error(selection.message)
  return selection.applied.config
}
