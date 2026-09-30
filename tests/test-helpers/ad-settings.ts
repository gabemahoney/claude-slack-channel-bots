/**
 * ad-settings.ts — agent-director's settings file for tests (b.jg5 SRJ-1304):
 * `writeAgentDirectorConfig`, the shared table of refused forms and the
 * defaults and minimums, re-exported from `src/ad-settings.ts`.
 *
 * `writeAgentDirectorConfig(home, input)` writes `.agent-director/config.toml`
 * (the relative path `src/ad-settings.ts` exports) under a temp HOME. Every
 * well-formed file goes through smol-toml's serializer with
 * `numbersAsFloat: true`: a `bigint` is written as a TOML integer and a plain
 * number as a float, so `60` given as a number is written `60.0` and parses
 * back as a float (without that option the serializer writes it as `60`, and
 * the float case would never be produced). No TOML is written by hand. The
 * one raw-text write is the not-TOML form: fixed text smol-toml refuses,
 * with the caller's text on its first (offending) line, so a leak case can
 * put a fake token there.
 *
 * `REFUSED_AD_CONFIG_FORMS` is SRJ-1304's list of refused forms, one entry
 * each, for `test.each`. Every threshold in it is derived from
 * `DEFAULT_AD_SETTINGS`, `AD_SETTING_MINIMUMS` and
 * `pendingGraceMinimumSeconds`, never typed, so a change to a default or a
 * minimum moves every form with it.
 *
 * The helper refuses the real home and any directory not under the OS temp
 * directory (host safety, b.jg5 SRJ-1301): it never writes under the real
 * `~/.agent-director`. It holds no module-scope state and starts no process.
 *
 * SPDX-License-Identifier: MIT
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

import { stringify } from 'smol-toml'

import {
  AD_PAUSE_TABLE,
  AD_PAUSE_TIMEOUT_KEY,
  AD_SETTING_MINIMUMS,
  AD_SETTINGS_RELATIVE_PATH,
  AD_TMUX_TABLE,
  DEFAULT_AD_SETTINGS,
  pendingGraceMinimumSeconds,
  type AdTmuxKey,
} from '../../src/ad-settings.ts'
import { isRealHome, isUnder, osTempDir } from './host-safe-env.ts'

export { AD_SETTING_MINIMUMS, DEFAULT_AD_SETTINGS } from '../../src/ad-settings.ts'

/**
 * A value as written: a `bigint` is a TOML integer, a plain number a float
 * (`60` is written `60.0`), a string a string.
 */
export type AdConfigValue = bigint | number | string

/** A well-formed settings file, as its tables. */
export interface AdConfigTables {
  /** The `[tmux]` table: any subset of the nine keys; omitted when undefined. */
  readonly tmux?: Readonly<Partial<Record<AdTmuxKey, AdConfigValue>>>
  /** `[pause] timeout_seconds`; the `[pause]` table is omitted when undefined. */
  readonly pauseTimeout?: AdConfigValue
  /**
   * Extra keys in `[tmux]` (a misspelt key, an unknown key), written beside
   * the nine.
   */
  readonly extraTmuxKeys?: Readonly<Record<string, AdConfigValue>>
  /**
   * Extra top-level entries, written after `[tmux]` and `[pause]` and
   * replacing either (an ignored table, or `tmux` or `pause` given as a
   * value instead of a table).
   */
  readonly extra?: Readonly<Record<string, unknown>>
}

/** Text that is not TOML; `embed` goes on its offending first line. */
export interface AdConfigNotToml {
  readonly notToml: true
  readonly embed?: string
}

/** What `writeAgentDirectorConfig` writes. */
export type AdConfigInput = AdConfigTables | AdConfigNotToml

/** The fixed start of the not-TOML form: a bare word where TOML needs `key =`. */
const NOT_TOML_TEXT = 'this file is not TOML at all'

function isNotToml(input: AdConfigInput): input is AdConfigNotToml {
  return (input as AdConfigNotToml).notToml === true
}

/** The file's text: the not-TOML form's fixed text, else smol-toml's serialization. */
function renderAdConfig(input: AdConfigInput): string {
  if (isNotToml(input)) return `${NOT_TOML_TEXT} ${input.embed ?? ''}\n`
  const root: Record<string, unknown> = {}
  if (input.tmux !== undefined || input.extraTmuxKeys !== undefined) {
    root[AD_TMUX_TABLE] = { ...input.tmux, ...input.extraTmuxKeys }
  }
  if (input.pauseTimeout !== undefined) root[AD_PAUSE_TABLE] = { [AD_PAUSE_TIMEOUT_KEY]: input.pauseTimeout }
  Object.assign(root, input.extra)
  return stringify(root, { numbersAsFloat: true })
}

/**
 * Write agent-director's settings file under `home` and answer its path.
 * Creates `.agent-director/`. Throws, writing nothing, when `home` is the real
 * home or is not under the OS temp directory.
 */
export function writeAgentDirectorConfig(home: string, input: AdConfigInput): string {
  const tempDir = osTempDir()
  const absoluteHome = resolve(home)
  if (isRealHome(absoluteHome)) {
    throw new Error('writeAgentDirectorConfig: refusing the real home; pass a mkdtempSync HOME')
  }
  if (absoluteHome === tempDir || !isUnder(absoluteHome, tempDir)) {
    throw new Error('writeAgentDirectorConfig: the home must be a directory under the OS temp directory')
  }
  const path = join(absoluteHome, AD_SETTINGS_RELATIVE_PATH)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, renderAdConfig(input))
  return path
}

/** Milliseconds per second, to turn a grace period into a timer that raises its minimum. */
const MS_PER_SECOND = 1000n

/**
 * A `create_timeout_ms` that raises the grace period's minimum above
 * `pending_grace_seconds`'s default: the default grace in milliseconds, so
 * ⌈(it + pipe_close_wait_ms) / 1000⌉ is at least the default grace, and the
 * minimum's addend puts it above.
 */
export const RAISED_CREATE_TIMEOUT_MS = DEFAULT_AD_SETTINGS.tmux.pending_grace_seconds * MS_PER_SECOND

/** The grace period's minimum with {@link RAISED_CREATE_TIMEOUT_MS} and the default pipe-close wait. */
export const RAISED_GRACE_MINIMUM_SECONDS = pendingGraceMinimumSeconds(
  RAISED_CREATE_TIMEOUT_MS,
  DEFAULT_AD_SETTINGS.tmux.pipe_close_wait_ms,
)

/** One refused form of SRJ-1304. */
export interface RefusedAdConfigForm {
  /** What makes the read refused. */
  readonly name: string
  /** What the file holds. */
  readonly input: AdConfigInput
  /** The key the refusal concerns; undefined for text that is not TOML. */
  readonly key: AdTmuxKey | undefined
}

/**
 * SRJ-1304's refused forms, each of which agent-director refuses: text that
 * is not TOML, a string, a float, a zero-fraction float, a negative value,
 * each fixed minimum broken by one, a `pending_grace_seconds` one below the
 * minimum a raised `create_timeout_ms` gives, and that raised
 * `create_timeout_ms` with `pending_grace_seconds` left missing or 0 (its
 * default, below the raised minimum).
 */
export const REFUSED_AD_CONFIG_FORMS: readonly RefusedAdConfigForm[] = Object.freeze([
  { name: 'text that is not TOML', input: { notToml: true }, key: undefined },
  {
    name: 'a string value',
    input: { tmux: { query_timeout_ms: String(DEFAULT_AD_SETTINGS.tmux.query_timeout_ms) } },
    key: 'query_timeout_ms',
  },
  {
    name: 'a float value',
    input: { tmux: { action_timeout_ms: Number(DEFAULT_AD_SETTINGS.tmux.action_timeout_ms) + 0.5 } },
    key: 'action_timeout_ms',
  },
  {
    name: 'a float with a zero fraction',
    input: { tmux: { pending_grace_seconds: Number(DEFAULT_AD_SETTINGS.tmux.pending_grace_seconds) } },
    key: 'pending_grace_seconds',
  },
  {
    name: 'a negative value',
    input: { tmux: { sweep_budget_seconds: -DEFAULT_AD_SETTINGS.tmux.sweep_budget_seconds } },
    key: 'sweep_budget_seconds',
  },
  {
    name: 'stopping_window_seconds below its minimum',
    input: { tmux: { stopping_window_seconds: AD_SETTING_MINIMUMS.stopping_window_seconds - 1n } },
    key: 'stopping_window_seconds',
  },
  {
    name: 'starting_session_seconds below its minimum',
    input: { tmux: { starting_session_seconds: AD_SETTING_MINIMUMS.starting_session_seconds - 1n } },
    key: 'starting_session_seconds',
  },
  {
    name: 'pending_grace_seconds below the minimum a raised create_timeout_ms gives',
    input: {
      tmux: { create_timeout_ms: RAISED_CREATE_TIMEOUT_MS, pending_grace_seconds: RAISED_GRACE_MINIMUM_SECONDS - 1n },
    },
    key: 'pending_grace_seconds',
  },
  {
    name: 'a raised create_timeout_ms with pending_grace_seconds missing',
    input: { tmux: { create_timeout_ms: RAISED_CREATE_TIMEOUT_MS } },
    key: 'pending_grace_seconds',
  },
  {
    name: 'a raised create_timeout_ms with pending_grace_seconds 0',
    input: { tmux: { create_timeout_ms: RAISED_CREATE_TIMEOUT_MS, pending_grace_seconds: 0n } },
    key: 'pending_grace_seconds',
  },
])
