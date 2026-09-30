/**
 * ad-settings.ts — agent-director's timing settings, read the way
 * agent-director reads them (b.jg5 SRJ-209).
 *
 * Scope: the settings file's path, table and key names, the defaults and
 * minimums, the read with agent-director's rule, the values in effect and
 * `[pause] timeout_seconds` (b.jg5 SRJ-209); the waits derived from the
 * values in effect (G, the alert threshold and B), their whole-minute
 * rendering for notices, and the never-early wait helper that arms a derived
 * wait on an injected clock (b.jg5 SRJ-210). The nine `[tmux]` defaults,
 * `[pause] timeout_seconds`'s 30 s and the three minimums are named here and
 * nowhere else: no other module in `src/` defines one, and no CSCB wait
 * holds one as a fixed value.
 *
 * agent-director offers no interface that reports its effective timing
 * values, so CSCB reads `~/.agent-director/config.toml` itself, under the
 * server process's HOME (`process.env.HOME` at read time, else
 * `os.homedir()`, the source the 0.10.0 client uses for its store path).
 * The file is parsed only with `smol-toml`, integers as `BigInt`, so a TOML
 * integer is told apart from a float such as `60.0` or `6e1`; CSCB never
 * parses TOML by hand. Every value is kept as the `bigint` read, with no
 * precision lost.
 *
 * agent-director's rule, applied to the whole read:
 * - a missing file gives every default; a missing key, or 0, gives that
 *   key's default;
 * - a read is refused when the file exists but cannot be read (a directory,
 *   a non-regular file, over the 64 KiB cap, a permission or I/O error, a
 *   path component that is not a directory) or parsed as TOML, when `tmux`
 *   is not a table, or when one of the nine keys holds a value that is not a
 *   TOML integer, holds a negative value, holds a value above
 *   {@link AD_SETTING_INTEGER_MAX}, or has an effective value below
 *   its minimum ({@link AD_SETTING_MINIMUMS}; the grace period's minimum
 *   comes from the read's effective `create_timeout_ms` and
 *   `pipe_close_wait_ms`, a refused value of either counting as its
 *   default);
 * - other keys and tables are ignored; a misspelt key leaves its default in
 *   force.
 * `[pause] timeout_seconds` is 30 s when the file or the key is missing; a
 * positive TOML integer up to {@link AD_SETTING_INTEGER_MAX} is used as given;
 * any other value (0 included), or a `pause` that is not a table, is "not
 * used" and never refuses the read.
 *
 * A refused read changes no value in effect: the reader keeps the values of
 * its last accepted read (the defaults at startup) and writes one log line
 * per run of refused reads, at the first refused read after start or after
 * an accepted read ({@link buildAdSettingsRefusedReadLine}). The read raises
 * no outage, records no startup error and posts nothing: agent-director's
 * own `ErrConfigMalformed` answers decide that (b.jg5 SRJ-316). No log line
 * or reason carries the parser's message, file text or a string value: a
 * parse failure is reported by position only, a read failure by its errno
 * code, a wrong-typed value by its kind.
 *
 * The file is read through `readPersonaConfigBytes` (`src/config.ts`), the
 * stat-first, size-capped reader, so a FIFO or a device at the path never
 * hangs a read.
 *
 * When: `main()` (`src/server.ts`) calls {@link installAdSettings} once,
 * after the startup gate passes and the start has resolved its
 * configuration, before the start pass. It does the startup read and
 * registers the re-read on the version re-check's tick hook
 * (`onAdVersionRecheckTick`, `src/ad-version-gate.ts`), so the file is read
 * again at each 120 s tick, whatever `health_check_interval` is, and never
 * after that re-check's dispose. The read arms no timer of its own; the only
 * timers this module arms are those of {@link armNeverEarlyWait}, on the
 * clock its caller passes.
 *
 * The derived waits (b.jg5 SRJ-210), in milliseconds:
 * - G, the grace period, is `pending_grace_seconds`;
 * - the alert threshold is the longer of `stopping_window_seconds` and
 *   `starting_session_seconds`, plus {@link AD_ALERT_THRESHOLD_ADDEND_SECONDS};
 * - B, CSCB's launch bound, is the later of {@link DIALOG_READY_TIMEOUT_MS}
 *   (the dialog approver's 300 s cap) and G plus
 *   {@link AD_LAUNCH_BOUND_GRACE_ADDEND_SECONDS}.
 * At agent-director's defaults they are 60 s, 360 s and 300 s. Each is
 * computed exactly from the `bigint` values; a result is a millisecond
 * `number` only when it is at most `Number.MAX_SAFE_INTEGER`, and otherwise
 * {@link AD_WAIT_NEVER_ENDS} (`Infinity`), never a rounded-down number. So a
 * consumer compares the time elapsed with the wait (`elapsed >= wait`) at the
 * moment it checks, and a wait too long for a number never ends early. The
 * accessors ({@link adGraceMsInEffect}, {@link adAlertThresholdMsInEffect},
 * {@link adLaunchBoundMsInEffect}) read the values in effect each time they
 * are called; nothing keeps a copy from the start. A timer longer than
 * `MAX_TIMER_DELAY_MS` (`src/persona-retry-schedule.ts`) fires almost at
 * once, so a consumer that arms a derived wait uses
 * {@link armNeverEarlyWait}, which arms timers no longer than that and runs
 * its callback only once the clock has reached the deadline. Given an
 * accessor rather than a number, it reads the wait in effect again at every
 * timer fire, so a value raised while the wait is armed never ends it early.
 *
 * No side effects at import: nothing is read, armed or logged until
 * {@link installAdSettings}, a reader's `read()` or
 * {@link armNeverEarlyWait} runs. The module makes no agent-director call.
 * It imports neither the agent-director package nor the client,
 * outage-state, notifier or Slack modules.
 *
 * SPDX-License-Identifier: MIT
 */

import { homedir } from 'node:os'
import { join } from 'node:path'

import { parse, TomlError } from 'smol-toml'

import { onAdVersionRecheckTick } from './ad-version-gate.ts'
import {
  FILE_TOO_LARGE_CODE,
  MAX_RELOAD_FILE_SIZE_TEXT,
  PersonaConfigReadError,
  readPersonaConfigBytes,
  type PersonaConfigFs,
} from './config.ts'
import type { PersonaConnectionClock } from './persona-connections.ts'
import { MAX_TIMER_DELAY_MS } from './persona-retry-schedule.ts'

// ---------------------------------------------------------------------------
// Names, defaults and minimums
// ---------------------------------------------------------------------------

/** The settings file's path relative to a home directory. */
export const AD_SETTINGS_RELATIVE_PATH = join('.agent-director', 'config.toml')

/** The table that holds the nine timing keys. */
export const AD_TMUX_TABLE = 'tmux'

/** The table that holds `timeout_seconds`, `pause`'s configured wait. */
export const AD_PAUSE_TABLE = 'pause'

/** `pause`'s configured wait, in {@link AD_PAUSE_TABLE}. */
export const AD_PAUSE_TIMEOUT_KEY = 'timeout_seconds'

/** The nine `[tmux]` keys, in the fixed order the rule checks them. */
export const AD_TMUX_KEYS = [
  'pending_grace_seconds',
  'stopping_window_seconds',
  'starting_session_seconds',
  'sweep_budget_seconds',
  'query_timeout_ms',
  'action_timeout_ms',
  'create_timeout_ms',
  'pipe_close_wait_ms',
  'kill_exit_wait_ms',
] as const

/** One of the nine `[tmux]` keys. */
export type AdTmuxKey = (typeof AD_TMUX_KEYS)[number]

/** A value for each of the nine `[tmux]` keys, as read (seconds or milliseconds, by the key's suffix). */
export type AdTmuxValues = Readonly<Record<AdTmuxKey, bigint>>

/** The defaults: the nine `[tmux]` keys and `[pause] timeout_seconds`, laid out as the file's tables. */
export interface AdSettingsDefaults {
  readonly tmux: AdTmuxValues
  readonly pause: { readonly timeout_seconds: bigint }
}

/** agent-director's defaults (b.jg5 SRJ-209). */
export const DEFAULT_AD_SETTINGS: AdSettingsDefaults = Object.freeze({
  tmux: Object.freeze({
    pending_grace_seconds: 60n,
    stopping_window_seconds: 90n,
    starting_session_seconds: 300n,
    sweep_budget_seconds: 15n,
    query_timeout_ms: 1500n,
    action_timeout_ms: 2000n,
    create_timeout_ms: 5000n,
    pipe_close_wait_ms: 100n,
    // The working default: the release candidate's placeholder, until the
    // Phase 1 release notes state the measured value (E51 re-checks it).
    kill_exit_wait_ms: 5000n,
  }),
  pause: Object.freeze({ timeout_seconds: 30n }),
})

/** The minimums: two fixed ones, and the grace period's floor and addend. */
export interface AdSettingMinimums {
  readonly starting_session_seconds: bigint
  readonly stopping_window_seconds: bigint
  /** `pending_grace_seconds`: the larger of `floor` and ⌈(create_timeout_ms + pipe_close_wait_ms) / 1000⌉ + `addend`. */
  readonly pending_grace_seconds: { readonly floor: bigint; readonly addend: bigint }
}

/** agent-director's minimums (b.jg5 SRJ-209); the six other keys have none. */
export const AD_SETTING_MINIMUMS: AdSettingMinimums = Object.freeze({
  starting_session_seconds: 60n,
  stopping_window_seconds: 30n,
  pending_grace_seconds: Object.freeze({ floor: 30n, addend: 20n }),
})

/**
 * The largest integer agent-director can hold in a setting: 2^63 - 1, the
 * top of Go's `int64` (the nine `[tmux]` fields) and of Go's `int` on its
 * 64-bit builds (`[pause] timeout_seconds`). agent-director's TOML parser
 * refuses the whole file for a larger integer; `smol-toml` reads one as a
 * `BigInt`, so CSCB checks the bound itself: a `[tmux]` value above it
 * refuses the read, a `[pause] timeout_seconds` above it is not used.
 */
export const AD_SETTING_INTEGER_MAX = 2n ** 63n - 1n

const MS_PER_SECOND = 1000n

/** ⌈n / d⌉ for any integer `n` and a positive `d`, exactly. */
function ceilDiv(n: bigint, d: bigint): bigint {
  const q = n / d
  return n % d > 0n ? q + 1n : q
}

/**
 * The grace period's minimum, in seconds, from a `create_timeout_ms` and a
 * `pipe_close_wait_ms`: the larger of 30 and
 * ⌈(create_timeout_ms + pipe_close_wait_ms) / 1000⌉ + 20. Exact for any
 * integer (30 at the defaults; 61 with `create_timeout_ms` 40000).
 */
export function pendingGraceMinimumSeconds(createTimeoutMs: bigint, pipeCloseWaitMs: bigint): bigint {
  const { floor, addend } = AD_SETTING_MINIMUMS.pending_grace_seconds
  const fromTimers = ceilDiv(createTimeoutMs + pipeCloseWaitMs, MS_PER_SECOND) + addend
  return fromTimers > floor ? fromTimers : floor
}

// ---------------------------------------------------------------------------
// The values in effect
// ---------------------------------------------------------------------------

/**
 * `[pause] timeout_seconds` as read: used (a positive integer, or the 30 s
 * default when the file, the table or the key is missing), or not used.
 * `found` describes what was there without its text: an integer as given
 * (`0`, `-5`), an integer above {@link AD_SETTING_INTEGER_MAX} only as
 * `an integer too large for agent-director`, otherwise only the value's kind
 * (`a string`, `a float`, …), or, for a `pause` that is not a table, that
 * kind in place of the table.
 */
export type AdPauseTimeout =
  | { readonly kind: 'used'; readonly seconds: bigint }
  | { readonly kind: 'not-used'; readonly found: string }

/** The settings CSCB acts on: the nine `[tmux]` values in effect and `[pause] timeout_seconds`. */
export interface AdSettingsInEffect {
  readonly tmux: AdTmuxValues
  readonly pauseTimeout: AdPauseTimeout
}

/** The values in effect before any accepted read, and after a missing file: every default. */
export const DEFAULT_AD_SETTINGS_IN_EFFECT: AdSettingsInEffect = Object.freeze({
  tmux: DEFAULT_AD_SETTINGS.tmux,
  pauseTimeout: Object.freeze({ kind: 'used', seconds: DEFAULT_AD_SETTINGS.pause.timeout_seconds }),
})

/** One read's outcome: accepted with the values it gives, or refused with a token-free reason. */
export type AdSettingsReadOutcome =
  | { readonly kind: 'accepted'; readonly values: AdSettingsInEffect }
  | { readonly kind: 'refused'; readonly reason: string }

// ---------------------------------------------------------------------------
// The read and the rule
// ---------------------------------------------------------------------------

/** A parsed TOML table: an object that is neither an array nor a date. */
function isTomlTable(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && !(value instanceof Date)
}

/** A value's kind, never its text: `a string`, `a float`, `an array`, … */
function describeValueKind(value: unknown): string {
  if (typeof value === 'bigint') return 'an integer'
  if (typeof value === 'number') return 'a float'
  if (typeof value === 'string') return 'a string'
  if (typeof value === 'boolean') return 'a boolean'
  if (Array.isArray(value)) return 'an array'
  if (value instanceof Date) return 'a date or time'
  if (isTomlTable(value)) return 'a table'
  return 'a value of another kind'
}

/** A key's own value in a parsed table, or `undefined` when the table does not hold the key itself. */
function ownValue(table: Record<string, unknown>, key: string): unknown {
  return Object.hasOwn(table, key) ? table[key] : undefined
}

/** What a read failure of the file is, from its errno code only (never the error's message). */
function readFailureReason(code: string | undefined): string {
  if (code === FILE_TOO_LARGE_CODE) return `it is larger than the ${MAX_RELOAD_FILE_SIZE_TEXT} limit`
  return `it cannot be read${code !== undefined ? ` (${code})` : ''}`
}

/** A parse failure, by position only: never the parser's message or the file's text. */
function parseFailureReason(failure: TomlError | undefined): string {
  if (failure !== undefined && Number.isInteger(failure.line) && Number.isInteger(failure.column)) {
    return `it is not valid TOML (at line ${failure.line}, column ${failure.column})`
  }
  return 'it is not valid TOML'
}

/** One `[tmux]` key as read: its effective value, and the rule its value breaks, if any. */
interface TmuxKeyRead {
  readonly effective: bigint
  readonly given: 'missing' | 'zero' | 'set'
  readonly problem?: string
}

/** One key's value under the rule: missing or 0 gives the default; not an integer, negative or above {@link AD_SETTING_INTEGER_MAX} is a problem (its default counts as effective). */
function readTmuxKey(table: Record<string, unknown> | undefined, key: AdTmuxKey): TmuxKeyRead {
  const fallback = DEFAULT_AD_SETTINGS.tmux[key]
  const value = table === undefined ? undefined : ownValue(table, key)
  if (value === undefined) return { effective: fallback, given: 'missing' }
  if (typeof value !== 'bigint') {
    return { effective: fallback, given: 'set', problem: `[${AD_TMUX_TABLE}] ${key} is not an integer (it is ${describeValueKind(value)})` }
  }
  if (value < 0n) return { effective: fallback, given: 'set', problem: `[${AD_TMUX_TABLE}] ${key} is ${value}, a negative value` }
  if (value > AD_SETTING_INTEGER_MAX) {
    return { effective: fallback, given: 'set', problem: `[${AD_TMUX_TABLE}] ${key} is too large for agent-director` }
  }
  if (value === 0n) return { effective: fallback, given: 'zero' }
  return { effective: value, given: 'set' }
}

/** How a key's effective value came about, for a minimum's reason. */
function describeEffective(key: AdTmuxKey, read: TmuxKeyRead): string {
  if (read.given === 'missing') return `[${AD_TMUX_TABLE}] ${key} is missing, so its default ${read.effective} applies`
  if (read.given === 'zero') return `[${AD_TMUX_TABLE}] ${key} is 0, so its default ${read.effective} applies`
  return `[${AD_TMUX_TABLE}] ${key} is ${read.effective}`
}

/** The minimum rule for one key, over the read's effective values: the reason it breaks, if any. */
function minimumProblem(key: AdTmuxKey, reads: Readonly<Record<AdTmuxKey, TmuxKeyRead>>): string | undefined {
  const read = reads[key]
  if (key === 'starting_session_seconds' || key === 'stopping_window_seconds') {
    const minimum = AD_SETTING_MINIMUMS[key]
    return read.effective < minimum ? `${describeEffective(key, read)}, below its minimum of ${minimum}` : undefined
  }
  if (key === 'pending_grace_seconds') {
    const create = reads.create_timeout_ms.effective
    const pipe = reads.pipe_close_wait_ms.effective
    const minimum = pendingGraceMinimumSeconds(create, pipe)
    if (read.effective >= minimum) return undefined
    return `${describeEffective(key, read)}, below its minimum of ${minimum}, which create_timeout_ms ${create} and pipe_close_wait_ms ${pipe} set`
  }
  return undefined
}

/** `[pause] timeout_seconds` under its own rule; it never refuses the read. */
function readPauseTimeout(root: Record<string, unknown>): AdPauseTimeout {
  const table = ownValue(root, AD_PAUSE_TABLE)
  if (table === undefined) return DEFAULT_AD_SETTINGS_IN_EFFECT.pauseTimeout
  if (!isTomlTable(table)) return { kind: 'not-used', found: `${describeValueKind(table)} in place of the [${AD_PAUSE_TABLE}] table` }
  const value = ownValue(table, AD_PAUSE_TIMEOUT_KEY)
  if (value === undefined) return DEFAULT_AD_SETTINGS_IN_EFFECT.pauseTimeout
  if (typeof value === 'bigint') {
    if (value > AD_SETTING_INTEGER_MAX) return { kind: 'not-used', found: 'an integer too large for agent-director' }
    return value > 0n ? { kind: 'used', seconds: value } : { kind: 'not-used', found: `${value}` }
  }
  return { kind: 'not-used', found: describeValueKind(value) }
}

/** agent-director's rule over a parsed file: the values it gives, or the first rule broken, in key order. */
function applyAdSettingsRule(root: Record<string, unknown>): AdSettingsReadOutcome {
  const tmux = ownValue(root, AD_TMUX_TABLE)
  if (tmux !== undefined && !isTomlTable(tmux)) {
    return { kind: 'refused', reason: `[${AD_TMUX_TABLE}] is not a table (it is ${describeValueKind(tmux)})` }
  }
  const reads = Object.fromEntries(AD_TMUX_KEYS.map((key) => [key, readTmuxKey(tmux, key)])) as Record<AdTmuxKey, TmuxKeyRead>
  for (const key of AD_TMUX_KEYS) {
    const problem = reads[key].problem ?? minimumProblem(key, reads)
    if (problem !== undefined) return { kind: 'refused', reason: problem }
  }
  const values = Object.freeze(Object.fromEntries(AD_TMUX_KEYS.map((key) => [key, reads[key].effective]))) as AdTmuxValues
  return { kind: 'accepted', values: Object.freeze({ tmux: values, pauseTimeout: readPauseTimeout(root) }) }
}

/** Decodes the file's bytes as strict UTF-8: a byte sequence that is not UTF-8 is refused, never replaced. */
const UTF8_DECODER = new TextDecoder('utf-8', { fatal: true })

/** One read of the file at `path`, under the rule. Never throws. */
function readAdSettingsFile(path: string, fs: Partial<PersonaConfigFs> | undefined): AdSettingsReadOutcome {
  let bytes: Buffer
  try {
    bytes = readPersonaConfigBytes(path, fs)
  } catch (err) {
    const code = err instanceof PersonaConfigReadError ? err.code : undefined
    if (code === 'ENOENT') return { kind: 'accepted', values: DEFAULT_AD_SETTINGS_IN_EFFECT }
    return { kind: 'refused', reason: readFailureReason(code) }
  }
  let text: string
  try {
    text = UTF8_DECODER.decode(bytes)
  } catch {
    return { kind: 'refused', reason: 'it is not valid UTF-8' }
  }
  let root: Record<string, unknown>
  try {
    root = parse(text, { integersAsBigInt: true, useLegacyDate: true })
  } catch (err) {
    return { kind: 'refused', reason: parseFailureReason(err instanceof TomlError ? err : undefined) }
  }
  return applyAdSettingsRule(root)
}

// ---------------------------------------------------------------------------
// The reader: the values in effect and the refused-read run
// ---------------------------------------------------------------------------

/** The prefix of every line this module logs. */
export const AD_SETTINGS_LOG_PREFIX = '[slack] agent-director settings:'

/**
 * The one line of a run of refused reads (b.jg5 SRJ-209), written at the
 * first refused read after start or after an accepted read:
 *
 *   [slack] agent-director settings: the read of "<path>" was refused: <reason>; <kept> stay in effect until a read is accepted (b.jg5 SRJ-209)
 *
 * `<kept>` is `the defaults` when no read has been accepted since start, and
 * `the values of the last accepted read` otherwise. `<reason>` is the
 * reader's token-free reason.
 */
export function buildAdSettingsRefusedReadLine(path: string, reason: string, hadAcceptedRead: boolean): string {
  const kept = hadAcceptedRead ? 'the values of the last accepted read' : 'the defaults'
  return `${AD_SETTINGS_LOG_PREFIX} the read of "${path}" was refused: ${reason}; ${kept} stay in effect until a read is accepted (b.jg5 SRJ-209)`
}

/** The reader's dependencies. */
export interface AdSettingsReaderDeps {
  /** The home directory, read at each read. Production: {@link productionAdSettingsHome}. */
  home: () => string
  /** Overrides for the stat-first reader's file-system calls (`readPersonaConfigBytes`); unset ones use the real file system. */
  fs?: Partial<PersonaConfigFs>
  /** The server log. */
  log: (line: string) => void
}

/** A reader of agent-director's settings file, holding the values in effect. */
export interface AdSettingsReader {
  /**
   * Read the file once, apply the rule and answer the outcome. An accepted
   * read replaces the values in effect and ends a run of refused reads; a
   * refused read changes nothing and writes the run's line if it is the
   * run's first. Never throws.
   */
  read(): AdSettingsReadOutcome
  /** The values in effect: those of the last accepted read, else the defaults. */
  valuesInEffect(): AdSettingsInEffect
}

/** The server's HOME at read time, as the 0.10.0 client finds it: `process.env.HOME`, else `os.homedir()` when it is unset. */
export function productionAdSettingsHome(): string {
  return process.env.HOME ?? homedir()
}

/** Build a reader over injected dependencies. Reads nothing until `read()`. */
export function createAdSettingsReader(deps: AdSettingsReaderDeps): AdSettingsReader {
  let inEffect: AdSettingsInEffect = DEFAULT_AD_SETTINGS_IN_EFFECT
  let hadAcceptedRead = false
  let inRefusedRun = false

  /** One read; `path` is undefined only when the home directory could not be found. */
  function readOnce(): { path: string | undefined; outcome: AdSettingsReadOutcome } {
    let path: string
    try {
      path = join(deps.home(), AD_SETTINGS_RELATIVE_PATH)
    } catch {
      return { path: undefined, outcome: { kind: 'refused', reason: 'the home directory cannot be found' } }
    }
    try {
      return { path, outcome: readAdSettingsFile(path, deps.fs) }
    } catch {
      return { path, outcome: { kind: 'refused', reason: 'the read failed unexpectedly' } }
    }
  }

  return {
    read() {
      const { path, outcome } = readOnce()
      if (outcome.kind === 'accepted') {
        inEffect = outcome.values
        hadAcceptedRead = true
        inRefusedRun = false
        return outcome
      }
      if (!inRefusedRun) {
        inRefusedRun = true
        try {
          deps.log(buildAdSettingsRefusedReadLine(path ?? join('~', AD_SETTINGS_RELATIVE_PATH), outcome.reason, hadAcceptedRead))
        } catch {
          /* non-critical: the log sink failing changes no value */
        }
      }
      return outcome
    },
    valuesInEffect() {
      return inEffect
    },
  }
}

// ---------------------------------------------------------------------------
// The module-level install (server.ts)
// ---------------------------------------------------------------------------

/** The installed reader, if any. */
let installedReader: AdSettingsReader | undefined

/** The installed tick listener's unsubscribe, if any. */
let unsubscribeTick: (() => void) | undefined

/**
 * Build the server's reader (production dependencies, unless others are
 * given), run the startup read once, and register the re-read as a listener
 * on the version re-check's tick hook, so the file is read again only at its
 * 120 s ticks (never after its dispose). `main()` calls it once, after the
 * startup gate passes and the start has resolved its configuration, before
 * the start pass. Its outcome never stops the start. A second install is a
 * logged no-op returning the installed reader.
 */
export function installAdSettings(deps: Partial<AdSettingsReaderDeps> = {}): AdSettingsReader {
  const log = deps.log ?? ((line: string) => console.error(line))
  if (installedReader !== undefined) {
    log(`${AD_SETTINGS_LOG_PREFIX} already installed — ignoring the second install`)
    return installedReader
  }
  const reader = createAdSettingsReader({ home: deps.home ?? productionAdSettingsHome, fs: deps.fs, log })
  installedReader = reader
  reader.read()
  unsubscribeTick = onAdVersionRecheckTick(() => {
    reader.read()
  })
  return reader
}

/** The values in effect of the installed reader; the defaults when nothing is installed. */
export function adSettingsInEffect(): AdSettingsInEffect {
  return installedReader?.valuesInEffect() ?? DEFAULT_AD_SETTINGS_IN_EFFECT
}

/** @internal Test-only: remove the tick listener and forget the installed reader. */
export function resetAdSettingsForTests(): void {
  unsubscribeTick?.()
  unsubscribeTick = undefined
  installedReader = undefined
}

// ---------------------------------------------------------------------------
// The derived waits: G, the alert threshold and B (b.jg5 SRJ-210)
// ---------------------------------------------------------------------------

/**
 * The dialog approver's cap: how long a fresh spawn may take to leave
 * `pending` while `src/session-manager.ts` auto-dismisses pre-session
 * dialogs (300 000 ms). B's floor: B is never shorter than this.
 */
export const DIALOG_READY_TIMEOUT_MS = 5 * 60_000

/** The alert threshold's addend, in seconds, over the longer of `stopping_window_seconds` and `starting_session_seconds`. */
export const AD_ALERT_THRESHOLD_ADDEND_SECONDS = 60n

/** B's addend, in seconds, over G: B is the later of `DIALOG_READY_TIMEOUT_MS` and G plus this. */
export const AD_LAUNCH_BOUND_GRACE_ADDEND_SECONDS = 60n

/**
 * A derived wait that never ends: one whose exact length in milliseconds is
 * above `Number.MAX_SAFE_INTEGER`, so no millisecond `number` holds it
 * exactly. `elapsed >= AD_WAIT_NEVER_ENDS` is false for every elapsed time.
 */
export const AD_WAIT_NEVER_ENDS = Number.POSITIVE_INFINITY

const MS_PER_SECOND_NUMBER = 1000
const MS_PER_MINUTE = 60 * MS_PER_SECOND_NUMBER
const MAX_EXACT_MS = BigInt(Number.MAX_SAFE_INTEGER)

/** An exact millisecond count as a `number`, or {@link AD_WAIT_NEVER_ENDS} when a `number` cannot hold it exactly. */
function exactMs(ms: bigint): number {
  return ms <= MAX_EXACT_MS ? Number(ms) : AD_WAIT_NEVER_ENDS
}

/** G in milliseconds, exact, as a `bigint`. */
function graceMsExact(values: AdSettingsInEffect): bigint {
  return values.tmux.pending_grace_seconds * MS_PER_SECOND
}

/** G, the grace period, in milliseconds: `pending_grace_seconds` (60 000 at the defaults), or {@link AD_WAIT_NEVER_ENDS}. */
export function adGraceMs(values: AdSettingsInEffect): number {
  return exactMs(graceMsExact(values))
}

/**
 * The alert threshold in milliseconds: the longer of `stopping_window_seconds`
 * and `starting_session_seconds`, plus {@link AD_ALERT_THRESHOLD_ADDEND_SECONDS}
 * (360 000 at the defaults), or {@link AD_WAIT_NEVER_ENDS}.
 */
export function adAlertThresholdMs(values: AdSettingsInEffect): number {
  const { stopping_window_seconds: stopping, starting_session_seconds: starting } = values.tmux
  const longer = stopping > starting ? stopping : starting
  return exactMs((longer + AD_ALERT_THRESHOLD_ADDEND_SECONDS) * MS_PER_SECOND)
}

/**
 * B, CSCB's launch bound, in milliseconds: the later of
 * `DIALOG_READY_TIMEOUT_MS` and G plus {@link AD_LAUNCH_BOUND_GRACE_ADDEND_SECONDS}
 * (300 000 at the defaults; 360 000 with `pending_grace_seconds` 300), or
 * {@link AD_WAIT_NEVER_ENDS}.
 */
export function adLaunchBoundMs(values: AdSettingsInEffect): number {
  const floor = BigInt(DIALOG_READY_TIMEOUT_MS)
  const fromGrace = graceMsExact(values) + AD_LAUNCH_BOUND_GRACE_ADDEND_SECONDS * MS_PER_SECOND
  return exactMs(fromGrace > floor ? fromGrace : floor)
}

/** G from the values in effect at the moment of the call ({@link adSettingsInEffect}). */
export function adGraceMsInEffect(): number {
  return adGraceMs(adSettingsInEffect())
}

/** The alert threshold from the values in effect at the moment of the call ({@link adSettingsInEffect}). */
export function adAlertThresholdMsInEffect(): number {
  return adAlertThresholdMs(adSettingsInEffect())
}

/** B from the values in effect at the moment of the call ({@link adSettingsInEffect}). */
export function adLaunchBoundMsInEffect(): number {
  return adLaunchBoundMs(adSettingsInEffect())
}

/**
 * A duration in milliseconds as whole minutes, rounded down (360 000 gives 6,
 * 359 000 gives 5), for a notice that states a derived value; the notice text
 * owns the word "minutes". {@link AD_WAIT_NEVER_ENDS} gives `Infinity`.
 */
export function wholeMinutes(ms: number): number {
  return Math.floor(ms / MS_PER_MINUTE)
}

// ---------------------------------------------------------------------------
// The never-early wait helper (b.jg5 SRJ-210)
// ---------------------------------------------------------------------------

/** The clock and timers {@link armNeverEarlyWait} takes: the timer subset of the persona clock type. */
export type NeverEarlyWaitClock = Pick<PersonaConnectionClock, 'now' | 'setTimeout' | 'clearTimeout'>

/**
 * A derived wait's length in milliseconds: a fixed `number`, or a getter that
 * answers the length in effect each time it is called (for example
 * {@link adLaunchBoundMsInEffect}).
 */
export type NeverEarlyWaitLength = number | (() => number)

/**
 * Arm a derived wait of `waitMs` measured from `startMs` (both in the clock's
 * milliseconds), and run `callback` once when the time elapsed since `startMs`
 * has reached the wait in effect. Answers a cancel.
 *
 * `waitMs` is a fixed number or a getter. A getter is called once while
 * arming and again at every timer fire, so each check and each re-arm uses
 * the value in effect at that moment, never a copy from the arm (b.jg5
 * SRJ-210):
 * - When a timer fires, the callback runs only if `clock.now() - startMs` is
 *   at least the wait in effect. The deadline is checked by that comparison,
 *   never by a sum that could round, so a timer that fires early (or a clock
 *   that moves back) never runs the callback before the deadline, and a wait
 *   raised while armed never ends at the old, shorter deadline.
 * - Otherwise the helper arms one timer for the smaller of the time left under
 *   the wait in effect and `MAX_TIMER_DELAY_MS`; while the wait in effect is
 *   {@link AD_WAIT_NEVER_ENDS}, it arms one timer of `MAX_TIMER_DELAY_MS`.
 * - The helper is not told when the getter's value changes. A wait lowered
 *   between fires is seen at the next fire: the callback runs then if the
 *   lowered deadline has passed, and otherwise the next timer ends at the
 *   lowered deadline. So a lowered wait ends no later than the next fire, at
 *   most `MAX_TIMER_DELAY_MS` after it was lowered, and the helper never polls
 *   more often than the waits in effect require.
 * - A getter that answers NaN at a fire (or throws there) is taken as
 *   {@link AD_WAIT_NEVER_ENDS} for that fire: nothing is thrown from the
 *   timer and nothing is logged, and the helper checks again at the next
 *   fire. The getter should answer a number every time; NaN is only caught
 *   at the arm (below).
 * - At most one timer is pending at a time, and none asks for more than
 *   `MAX_TIMER_DELAY_MS`: a runtime timer longer than that fires almost at
 *   once, so a longer wait runs as a chain of timers.
 * - The callback runs at most once, from a timer, never during this call,
 *   even when the deadline has already passed.
 * - A fixed wait of {@link AD_WAIT_NEVER_ENDS} arms no timer and never runs
 *   the callback, since it cannot change. A getter always keeps one timer
 *   pending until the callback runs or the wait is cancelled, even while it
 *   answers {@link AD_WAIT_NEVER_ENDS}, so a later lower value can end it.
 * - The cancel clears the pending timer and stops the wait; calling it again,
 *   or after the callback ran, does nothing.
 *
 * Throws a `RangeError`, before arming anything, for a `startMs` that is not
 * finite, a fixed `waitMs` that is NaN or a getter whose first value (read
 * while arming) is NaN. A getter that throws while arming throws out of this
 * call, before anything is armed.
 */
export function armNeverEarlyWait(
  clock: NeverEarlyWaitClock,
  startMs: number,
  waitMs: NeverEarlyWaitLength,
  callback: () => void,
): () => void {
  if (!Number.isFinite(startMs)) throw new RangeError(`never-early wait: the start must be a finite time, got ${startMs}`)
  const initialWaitMs = typeof waitMs === 'function' ? waitMs() : waitMs
  if (Number.isNaN(initialWaitMs)) throw new RangeError('never-early wait: the wait must be a number of milliseconds, got NaN')

  let handle: unknown
  let armed = false
  let stopped = false

  /** The wait in effect at a fire; NaN or a throw from a getter reads as never-ends. */
  function waitInEffect(): number {
    if (typeof waitMs !== 'function') return waitMs
    let current: number
    try {
      current = waitMs()
    } catch {
      return AD_WAIT_NEVER_ENDS
    }
    return Number.isNaN(current) ? AD_WAIT_NEVER_ENDS : current
  }

  function arm(currentWaitMs: number): void {
    const left = currentWaitMs - (clock.now() - startMs)
    const delay = Math.min(Math.max(Math.ceil(left), 0), MAX_TIMER_DELAY_MS)
    armed = true
    handle = clock.setTimeout(onTimer, delay)
  }

  function onTimer(): void {
    armed = false
    handle = undefined
    if (stopped) return
    const currentWaitMs = waitInEffect()
    if (clock.now() - startMs >= currentWaitMs) {
      stopped = true
      callback()
      return
    }
    arm(currentWaitMs)
  }

  if (typeof waitMs === 'function' || initialWaitMs !== AD_WAIT_NEVER_ENDS) arm(initialWaitMs)

  return () => {
    if (stopped) return
    stopped = true
    if (armed) {
      armed = false
      clock.clearTimeout(handle)
      handle = undefined
    }
  }
}
