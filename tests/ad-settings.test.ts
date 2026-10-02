/**
 * ad-settings.test.ts — agent-director's timing settings, read the way
 * agent-director reads them (b.jg5 SRJ-209, AC 80): the read with
 * agent-director's rule (the 64-bit bound, strict UTF-8 and a home getter
 * that throws included), the values in effect, `[pause] timeout_seconds`, the
 * one line per run of refused reads, the install and its re-read at the
 * version re-check's 120 s ticks (b.jg5 SRJ-204), and source audits of the
 * settings module. Then the waits derived from the values in effect
 * (b.jg5 SRJ-210, AC 80): G, the alert threshold and B, their accessors at
 * check time, the never-early wait helper beyond the timer maximum and with
 * a getter it reads again at every fire, and whole-minute rendering. Then
 * agent-director's verb ceilings, the call timeout's need and the startup
 * check that warns when `agent_director_call_timeout_ms` does not exceed it
 * (b.jg5 SRJ-213, AC 80): each ceiling against its formula written out here,
 * the need, and the check's one line through a capturing log sink.
 *
 * Every config file is written by `writeAgentDirectorConfig`
 * (`tests/test-helpers/ad-settings.ts`, b.jg5 SRJ-1304) under a
 * `mkdtempSync` HOME removed in `afterEach`, and read by a reader whose home
 * getter answers that HOME. Every default, minimum, key name, path and
 * interval is imported from `src/` or the helper; the SRD's numbers are
 * stated once, in the pin table at the end, so a change to a default or a
 * minimum leaves every other case valid.
 *
 * The tick cases install E3's re-check on `createFakeClock` with a passing
 * `makeStubResolveSystemBinary` and no health check: the re-check's timer is
 * the only one armed. No process, no real HOME, no real timer, no top-level
 * mock.module(), no value import of `Client` or `resolveSystemBinary`.
 * Module state (the installed reader, the re-check and its listeners) is
 * reset in `afterEach`.
 *
 * SPDX-License-Identifier: MIT
 */

import { afterEach, describe, expect, spyOn, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import {
  AD_ALERT_THRESHOLD_ADDEND_SECONDS,
  AD_CALL_TIMEOUT_NEED_MARGIN_MS,
  AD_CEILING_VERBS,
  AD_LAUNCH_BOUND_GRACE_ADDEND_SECONDS,
  AD_LAUNCH_CEILING_VERBS,
  AD_PAUSE_TABLE,
  AD_PAUSE_TIMEOUT_KEY,
  AD_SETTING_INTEGER_MAX,
  AD_SETTINGS_LOG_PREFIX,
  AD_SETTINGS_RELATIVE_PATH,
  AD_TMUX_KEYS,
  AD_TMUX_TABLE,
  AD_WAIT_NEVER_ENDS,
  adAlertThresholdMs,
  adAlertThresholdMsInEffect,
  adCallTimeoutNeed,
  adGraceMs,
  adGraceMsInEffect,
  adLaunchBoundMs,
  adLaunchBoundMsInEffect,
  adSettingsInEffect,
  adVerbCeilingsMs,
  armNeverEarlyWait,
  buildAdSettingsRefusedReadLine,
  checkAdCallTimeoutAtStartup,
  createAdSettingsReader,
  DEFAULT_AD_SETTINGS_IN_EFFECT,
  DIALOG_READY_TIMEOUT_MS,
  installAdSettings,
  pendingGraceMinimumSeconds,
  productionAdSettingsHome,
  resetAdSettingsForTests,
  wholeMinutes,
  type AdCeilingVerb,
  type AdSettingsInEffect,
  type AdSettingsReader,
  type AdSettingsReadOutcome,
  type AdTmuxKey,
  type AdTmuxValues,
  type NeverEarlyWaitClock,
  type NeverEarlyWaitLength,
} from '../src/ad-settings.ts'
import {
  AD_VERSION_RECHECK_INTERVAL_MS,
  disposeAdVersionRecheck,
  installAdVersionRecheck,
  PHASE1_RUNBOOK_SECTION_TITLE,
  resetAdVersionRecheckForTests,
} from '../src/ad-version-gate.ts'
import {
  CONFIG_NOT_REGULAR_FILE_CODE,
  DEFAULT_AGENT_DIRECTOR_CALL_TIMEOUT_MS,
  MAX_RELOAD_FILE_BYTES,
  MAX_RELOAD_FILE_SIZE_TEXT,
  type PersonaConfigFs,
  type ServerSettings,
} from '../src/config.ts'
import { MAX_TIMER_DELAY_MS } from '../src/persona-retry-schedule.ts'
import {
  AD_SETTING_MINIMUMS,
  DEFAULT_AD_SETTINGS,
  RAISED_CREATE_TIMEOUT_MS,
  RAISED_GRACE_MINIMUM_SECONDS,
  REFUSED_AD_CONFIG_FORMS,
  writeAgentDirectorConfig,
  type AdConfigInput,
  type AdConfigValue,
} from './test-helpers/ad-settings.ts'
import {
  errSystemInstallNotFound,
  makeStubResolveSystemBinary,
  type StubResolveSystemBinaryOutcome,
} from './test-helpers/agent-director-stub.ts'
import { OLD_AD_VERSION, PHASE1_RC_VERSION } from './test-helpers/agent-director-versions.ts'
import { assertNoLeak, BOT_TOKEN_PREFIX, fakeToken } from './test-helpers/credentials.ts'
import { createFakeClock, type FakeClock } from './test-helpers/fake-clock.ts'
import { osTempDir } from './test-helpers/host-safe-env.ts'
import {
  importSource,
  importedSpecifiers,
  runtimeLoads,
  srcModules,
  type RuntimeLoads,
} from './test-helpers/source-audit.ts'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Temp HOMEs made in the running test; removed in `afterEach`. */
const tempDirs: string[] = []

/** Fake clocks made in the running test; each case ends with no timer pending (it disposes the re-check, or the re-check stopped). */
const clocks: FakeClock[] = []

afterEach(() => {
  const leftPending = clocks.splice(0).map((clock) => clock.pendingCount())
  resetAdSettingsForTests()
  resetAdVersionRecheckForTests()
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  expect(leftPending.filter((count) => count !== 0)).toEqual([])
})

function makeHome(): string {
  const home = mkdtempSync(join(osTempDir(), 'ad-settings-test-'))
  tempDirs.push(home)
  return home
}

/** A reader over a temp HOME, with a capturing log sink and a count of reads (each read asks for the home once). */
interface ReaderRig {
  readonly home: string
  /** The settings file's path under the HOME. */
  readonly path: string
  readonly lines: string[]
  readonly reader: AdSettingsReader
  write(input: AdConfigInput): void
  read(): AdSettingsReadOutcome
  readCount(): number
}

function makeReaderRig(fs?: Partial<PersonaConfigFs>): ReaderRig {
  const home = makeHome()
  const lines: string[] = []
  let reads = 0
  const reader = createAdSettingsReader({
    home: () => {
      reads += 1
      return home
    },
    fs,
    log: (line) => { lines.push(line) },
  })
  return {
    home,
    path: join(home, AD_SETTINGS_RELATIVE_PATH),
    lines,
    reader,
    write: (input) => { writeAgentDirectorConfig(home, input) },
    read: () => reader.read(),
    readCount: () => reads,
  }
}

const DEFAULT_TMUX: AdTmuxValues = DEFAULT_AD_SETTINGS.tmux
const DEFAULT_PAUSE_SECONDS = DEFAULT_AD_SETTINGS.pause.timeout_seconds
/** A `[pause] timeout_seconds` other than the default. */
const CHANGED_PAUSE_SECONDS = DEFAULT_PAUSE_SECONDS * 2n

/**
 * Every key moved `step` above its default, the grace period raised to the
 * minimum the moved timers give when needed: nine values agent-director
 * accepts, none equal to its default.
 */
function shiftedTmux(step: bigint): Record<AdTmuxKey, bigint> {
  const tmux = Object.fromEntries(AD_TMUX_KEYS.map((key) => [key, DEFAULT_TMUX[key] + step])) as Record<AdTmuxKey, bigint>
  const minimum = pendingGraceMinimumSeconds(tmux.create_timeout_ms, tmux.pipe_close_wait_ms)
  if (tmux.pending_grace_seconds < minimum) tmux.pending_grace_seconds = minimum
  return tmux
}

const CHANGED_TMUX = shiftedTmux(1n)
const CHANGED_AGAIN_TMUX = shiftedTmux(2n)

/** The defaults with some keys replaced. */
function tmuxWith(overrides: Partial<Record<AdTmuxKey, bigint>>): AdTmuxValues {
  return { ...DEFAULT_TMUX, ...overrides }
}

/** Values in effect with `[pause] timeout_seconds` used. */
function inEffect(tmux: AdTmuxValues, pauseSeconds: bigint = DEFAULT_PAUSE_SECONDS): AdSettingsInEffect {
  return { tmux, pauseTimeout: { kind: 'used', seconds: pauseSeconds } }
}

/** The changed values, with a changed pause, as a file and as the values in effect it gives. */
const CHANGED_FILE: AdConfigInput = { tmux: CHANGED_TMUX, pauseTimeout: CHANGED_PAUSE_SECONDS }
const CHANGED_IN_EFFECT = inEffect(CHANGED_TMUX, CHANGED_PAUSE_SECONDS)

/**
 * The changed values with `key` left out, and what the file gives: `key` at
 * its default. With the grace period left out the timers stay at their
 * defaults, so its default still meets its minimum.
 */
function changedWithout(key: AdTmuxKey): { file: Partial<Record<AdTmuxKey, bigint>>; expected: AdTmuxValues } {
  const file: Partial<Record<AdTmuxKey, bigint>> = { ...CHANGED_TMUX }
  delete file[key]
  if (key === 'pending_grace_seconds') {
    file.create_timeout_ms = DEFAULT_TMUX.create_timeout_ms
    file.pipe_close_wait_ms = DEFAULT_TMUX.pipe_close_wait_ms
  }
  return { file, expected: { ...DEFAULT_TMUX, ...file } }
}

/** Assert a read was refused and answer its reason. */
function refusedReason(outcome: AdSettingsReadOutcome): string {
  expect(outcome.kind).toBe('refused')
  return outcome.kind === 'refused' ? outcome.reason : ''
}

// ---------------------------------------------------------------------------
// Accepted reads (SRJ-209: a missing file, a missing key or 0 gives the default)
// ---------------------------------------------------------------------------

describe('ad settings: accepted reads', () => {
  test('with no file the values are the defaults, [pause] timeout_seconds included, and no line is written', () => {
    const rig = makeReaderRig()
    const outcome = rig.read()
    expect(outcome).toEqual({ kind: 'accepted', values: DEFAULT_AD_SETTINGS_IN_EFFECT })
    expect(rig.reader.valuesInEffect()).toEqual(inEffect(DEFAULT_TMUX))
    expect(rig.lines).toEqual([])
  })

  test.each<[string, AdConfigInput]>([
    ['an empty file', {}],
    ['a file with no [tmux] table', { extra: { other: { note: 'ignored' } } }],
    ['an empty [tmux] table', { tmux: {} }],
  ])('%s gives the defaults', (_label, input) => {
    const rig = makeReaderRig()
    rig.write(input)
    expect(rig.read()).toEqual({ kind: 'accepted', values: inEffect(DEFAULT_TMUX) })
    expect(rig.lines).toEqual([])
  })

  test('nine changed values at or above their minimums are used as given', () => {
    const rig = makeReaderRig()
    rig.write({ tmux: CHANGED_TMUX })
    expect(rig.read()).toEqual({ kind: 'accepted', values: inEffect(CHANGED_TMUX) })
    expect(rig.lines).toEqual([])
  })

  test.each(AD_TMUX_KEYS.map((key) => [key]))('%s missing gives its default; the other keys are used as given', (key) => {
    const rig = makeReaderRig()
    const { file, expected } = changedWithout(key)
    rig.write({ tmux: file })
    expect(rig.read()).toEqual({ kind: 'accepted', values: inEffect(expected) })
  })

  test.each(AD_TMUX_KEYS.map((key) => [key]))('%s set to 0 gives its default; the other keys are used as given', (key) => {
    const rig = makeReaderRig()
    const { file, expected } = changedWithout(key)
    rig.write({ tmux: { ...file, [key]: 0n } })
    expect(rig.read()).toEqual({ kind: 'accepted', values: inEffect(expected) })
  })

  test.each(AD_TMUX_KEYS.map((key) => [key]))('%s alone, set to a value other than its default, is used as given', (key) => {
    const rig = makeReaderRig()
    rig.write({ tmux: { [key]: CHANGED_TMUX[key] } })
    expect(rig.read()).toEqual({ kind: 'accepted', values: inEffect(tmuxWith({ [key]: CHANGED_TMUX[key] })) })
  })

  test.each<[AdTmuxKey, bigint]>([
    ['starting_session_seconds', AD_SETTING_MINIMUMS.starting_session_seconds],
    ['stopping_window_seconds', AD_SETTING_MINIMUMS.stopping_window_seconds],
    ['pending_grace_seconds', pendingGraceMinimumSeconds(DEFAULT_TMUX.create_timeout_ms, DEFAULT_TMUX.pipe_close_wait_ms)],
  ])('%s at its minimum (%p) is used', (key, minimum) => {
    const rig = makeReaderRig()
    rig.write({ tmux: { [key]: minimum } })
    expect(rig.read()).toEqual({ kind: 'accepted', values: inEffect(tmuxWith({ [key]: minimum })) })
  })

  test('pending_grace_seconds at the minimum a raised create_timeout_ms gives is used', () => {
    const rig = makeReaderRig()
    const raised = { create_timeout_ms: RAISED_CREATE_TIMEOUT_MS, pending_grace_seconds: RAISED_GRACE_MINIMUM_SECONDS }
    rig.write({ tmux: raised })
    expect(rig.read()).toEqual({ kind: 'accepted', values: inEffect(tmuxWith(raised)) })
  })

  test.each<[string, AdConfigInput]>([
    ['another table, holding values of every kind', { tmux: CHANGED_TMUX, extra: { other: { text: 'x', float: 0.5, negative: -1n } } }],
    ['an unknown [tmux] key holding a string', { tmux: CHANGED_TMUX, extraTmuxKeys: { unknown_key: 'x' } }],
    ['another [pause] key', { tmux: CHANGED_TMUX, extra: { pause: { other_key: 'x' } } }],
  ])('%s is ignored', (_label, input) => {
    const rig = makeReaderRig()
    rig.write(input)
    expect(rig.read()).toEqual({ kind: 'accepted', values: inEffect(CHANGED_TMUX) })
    expect(rig.lines).toEqual([])
  })

  test('a misspelt key is ignored and leaves its default in force', () => {
    const rig = makeReaderRig()
    rig.write({ extraTmuxKeys: { pending_grace_second: CHANGED_TMUX.pending_grace_seconds } })
    expect(rig.read()).toEqual({ kind: 'accepted', values: inEffect(DEFAULT_TMUX) })
  })
})

// ---------------------------------------------------------------------------
// Refused reads (SRJ-209: refused forms keep the last accepted values, one line per run)
// ---------------------------------------------------------------------------

const REFUSED_FORM_ROWS = REFUSED_AD_CONFIG_FORMS.map((form) => [form.name, form] as const)

describe('ad settings: refused reads', () => {
  test.each(REFUSED_FORM_ROWS)('%s: refused after an accepted read, the last accepted values stay, one line names the path and the reason', (_name, form) => {
    const rig = makeReaderRig()
    rig.write(CHANGED_FILE)
    rig.read()
    rig.write(form.input)
    const reason = refusedReason(rig.read())
    expect(rig.reader.valuesInEffect()).toEqual(CHANGED_IN_EFFECT)
    expect(rig.lines).toEqual([buildAdSettingsRefusedReadLine(rig.path, reason, true)])
    expect(rig.lines[0]!.startsWith(AD_SETTINGS_LOG_PREFIX)).toBe(true)
    expect(rig.lines[0]).toContain(`"${rig.path}"`)
    expect(rig.lines[0]).toContain(reason)
    if (form.key !== undefined) {
      expect(reason).toContain(form.key)
      expect(rig.lines[0]).toContain(form.key)
    } else {
      expect(reason).toContain('TOML')
      for (const key of AD_TMUX_KEYS) expect(reason).not.toContain(key)
    }
  })

  test.each(REFUSED_FORM_ROWS)('%s: refused at startup, the defaults stay, with one line', (_name, form) => {
    const rig = makeReaderRig()
    rig.write(form.input)
    const reason = refusedReason(rig.read())
    expect(rig.reader.valuesInEffect()).toEqual(DEFAULT_AD_SETTINGS_IN_EFFECT)
    expect(rig.lines).toEqual([buildAdSettingsRefusedReadLine(rig.path, reason, false)])
  })

  test('the line says the defaults stay before any accepted read, and the last accepted values after one', () => {
    const [before, after] = [false, true].map((had) => buildAdSettingsRefusedReadLine('p', 'r', had))
    expect(before).not.toBe(after)
    expect(before).toContain('the defaults')
    expect(after).toContain('the last accepted read')
  })

  test.each<[string, AdTmuxKey, AdConfigValue]>([
    ['create_timeout_ms as a float', 'create_timeout_ms', Number(RAISED_CREATE_TIMEOUT_MS)],
    ['create_timeout_ms as a string', 'create_timeout_ms', String(RAISED_CREATE_TIMEOUT_MS)],
    ['pipe_close_wait_ms as a float', 'pipe_close_wait_ms', Number(RAISED_CREATE_TIMEOUT_MS)],
  ])('a refused %s counts as its default in the grace minimum: the reason names it, not the grace period', (_label, key, value) => {
    const rig = makeReaderRig()
    rig.write({ tmux: { [key]: value } })
    const reason = refusedReason(rig.read())
    expect(reason).toContain(key)
    expect(reason).not.toContain('pending_grace_seconds')
  })

  test('[tmux] given as a value instead of a table is refused', () => {
    const rig = makeReaderRig()
    rig.write({ extra: { tmux: CHANGED_TMUX.pending_grace_seconds } })
    expect(refusedReason(rig.read())).toContain('[tmux]')
    expect(rig.reader.valuesInEffect()).toEqual(DEFAULT_AD_SETTINGS_IN_EFFECT)
    expect(rig.lines).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// Read failures, through the file-system seam (SRJ-209: only a missing file gives the defaults)
// ---------------------------------------------------------------------------

/** A descriptor number the seam hands out; never a real one. */
const FAKE_FD = -1

/** An errno-style error whose message carries a fake token, which must never reach a line or a reason. */
function errnoError(code: string): Error {
  return Object.assign(new Error(`stub fs failure ${fakeToken(BOT_TOKEN_PREFIX, code)}`), { code })
}

/** A seam that opens nothing real: every call is stubbed, with `overrides` on top. */
function stubFs(overrides: Partial<PersonaConfigFs>): Partial<PersonaConfigFs> {
  return {
    openFile: () => FAKE_FD,
    fstatFile: () => ({ isFile: () => true, isDirectory: () => false }),
    readFileFd: () => Buffer.alloc(0),
    closeFile: () => {},
    ...overrides,
  }
}

/**
 * A TOML comment holding a byte sequence that is not UTF-8 (a lead byte
 * followed by an ASCII byte). Decoded leniently it would be a valid, empty
 * TOML file, so only the strict decode refuses it.
 */
const NOT_UTF8_COMMENT_BYTES = Buffer.concat([Buffer.from('# '), Buffer.from([0xc3, 0x28]), Buffer.from('\n')])

describe('ad settings: read failures', () => {
  test('not found through the seam gives the defaults and no line', () => {
    const rig = makeReaderRig(stubFs({ openFile: () => { throw errnoError('ENOENT') } }))
    expect(rig.read()).toEqual({ kind: 'accepted', values: DEFAULT_AD_SETTINGS_IN_EFFECT })
    expect(rig.lines).toEqual([])
  })

  test.each<[string, Partial<PersonaConfigFs>, string]>([
    ['a directory', { fstatFile: () => ({ isFile: () => false, isDirectory: () => true }) }, 'EISDIR'],
    ['a non-regular file', { fstatFile: () => ({ isFile: () => false, isDirectory: () => false }) }, CONFIG_NOT_REGULAR_FILE_CODE],
    ['a file over the size cap', { fstatFile: () => ({ isFile: () => true, isDirectory: () => false, size: MAX_RELOAD_FILE_BYTES + 1 }) }, MAX_RELOAD_FILE_SIZE_TEXT],
    ['a permission error', { openFile: () => { throw errnoError('EACCES') } }, 'EACCES'],
    ['a path component that is not a directory', { openFile: () => { throw errnoError('ENOTDIR') } }, 'ENOTDIR'],
    ['an I/O error on the read', { readFileFd: () => { throw errnoError('EIO') } }, 'EIO'],
    ['bytes that are not valid UTF-8, in a TOML comment', { readFileFd: () => NOT_UTF8_COMMENT_BYTES }, 'it is not valid UTF-8'],
  ])('%s is refused: the defaults stay, one line giving the cause (%p), no error text', (_label, overrides, cause) => {
    const rig = makeReaderRig(stubFs(overrides))
    const outcome = rig.read()
    const reason = refusedReason(outcome)
    expect(reason).toContain(cause)
    expect(rig.lines[0]).toContain(cause)
    expect(rig.reader.valuesInEffect()).toEqual(DEFAULT_AD_SETTINGS_IN_EFFECT)
    expect(rig.lines).toEqual([buildAdSettingsRefusedReadLine(rig.path, reason, false)])
    expect(rig.lines[0]).not.toContain('stub fs failure')
    assertNoLeak({ lines: rig.lines, outcome })
  })

  test('a home getter that throws is refused: the last values stay, one line names the settings path under ~, no error text', () => {
    const home = makeHome()
    writeAgentDirectorConfig(home, CHANGED_FILE)
    const lines: string[] = []
    let homeThrows = false
    const reader = createAdSettingsReader({
      home: () => {
        if (homeThrows) throw new Error(`stub home failure ${fakeToken(BOT_TOKEN_PREFIX, 'home')}`)
        return home
      },
      log: (line) => { lines.push(line) },
    })
    reader.read()
    homeThrows = true
    const outcome = reader.read()
    expect(outcome).toEqual({ kind: 'refused', reason: 'the home directory cannot be found' })
    expect(reader.valuesInEffect()).toEqual(CHANGED_IN_EFFECT)
    expect(lines).toEqual([buildAdSettingsRefusedReadLine(join('~', AD_SETTINGS_RELATIVE_PATH), refusedReason(outcome), true)])
    expect(lines[0]).not.toContain('stub home failure')
    assertNoLeak({ lines, outcome })
  })

  test('a directory at the settings path on the real file system is refused after an accepted read: the last values stay', () => {
    const rig = makeReaderRig()
    rig.write(CHANGED_FILE)
    rig.read()
    rmSync(rig.path)
    mkdirSync(rig.path)
    const reason = refusedReason(rig.read())
    expect(rig.reader.valuesInEffect()).toEqual(CHANGED_IN_EFFECT)
    expect(rig.lines).toEqual([buildAdSettingsRefusedReadLine(rig.path, reason, true)])
  })
})

// ---------------------------------------------------------------------------
// Runs of refused reads, and when a change takes effect (SRJ-209)
// ---------------------------------------------------------------------------

describe('ad settings: runs of refused reads', () => {
  test('refused reads after start log once, whatever their reasons', () => {
    const rig = makeReaderRig()
    const [first, second] = REFUSED_AD_CONFIG_FORMS
    rig.write(first!.input)
    const firstReason = refusedReason(rig.read())
    rig.write(second!.input)
    const secondReason = refusedReason(rig.read())
    rig.read()
    expect(secondReason).not.toBe(firstReason)
    expect(rig.lines).toEqual([buildAdSettingsRefusedReadLine(rig.path, firstReason, false)])
  })

  test('refused, accepted, refused logs twice, and the accepted read in between takes effect', () => {
    const rig = makeReaderRig()
    const form = REFUSED_AD_CONFIG_FORMS[0]!
    rig.write(form.input)
    const reason = refusedReason(rig.read())
    rig.write(CHANGED_FILE)
    expect(rig.read()).toEqual({ kind: 'accepted', values: CHANGED_IN_EFFECT })
    rig.write(form.input)
    rig.read()
    expect(rig.reader.valuesInEffect()).toEqual(CHANGED_IN_EFFECT)
    expect(rig.lines).toEqual([
      buildAdSettingsRefusedReadLine(rig.path, reason, false),
      buildAdSettingsRefusedReadLine(rig.path, reason, true),
    ])
  })

  test('a change is used from the next read, not before', () => {
    const rig = makeReaderRig()
    rig.write(CHANGED_FILE)
    rig.read()
    rig.write({ tmux: CHANGED_AGAIN_TMUX })
    expect(rig.reader.valuesInEffect()).toEqual(CHANGED_IN_EFFECT)
    rig.read()
    expect(rig.reader.valuesInEffect()).toEqual(inEffect(CHANGED_AGAIN_TMUX))
  })

  test('a file removed after an accepted read gives the defaults at the next read, with no line', () => {
    const rig = makeReaderRig()
    rig.write(CHANGED_FILE)
    rig.read()
    rmSync(rig.path)
    expect(rig.read()).toEqual({ kind: 'accepted', values: DEFAULT_AD_SETTINGS_IN_EFFECT })
    expect(rig.reader.valuesInEffect()).toEqual(DEFAULT_AD_SETTINGS_IN_EFFECT)
    expect(rig.lines).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// The 64-bit bound (SRJ-209: agent-director holds each setting in a 64-bit integer)
// ---------------------------------------------------------------------------

/** `key` at `value`, with the grace period raised to the minimum the timers then give, when they raise it. */
function tmuxWithKeyAt(key: AdTmuxKey, value: bigint): AdTmuxValues {
  const tmux: Record<AdTmuxKey, bigint> = { ...DEFAULT_TMUX, [key]: value }
  const minimum = pendingGraceMinimumSeconds(tmux.create_timeout_ms, tmux.pipe_close_wait_ms)
  if (tmux.pending_grace_seconds < minimum) tmux.pending_grace_seconds = minimum
  return tmux
}

const TMUX_KEY_ROWS = AD_TMUX_KEYS.map((key) => [key])

describe('ad settings: the 64-bit bound', () => {
  test.each(TMUX_KEY_ROWS)('%s at AD_SETTING_INTEGER_MAX is accepted and used as given', (key) => {
    const rig = makeReaderRig()
    const tmux = tmuxWithKeyAt(key, AD_SETTING_INTEGER_MAX)
    rig.write({ tmux })
    expect(rig.read()).toEqual({ kind: 'accepted', values: inEffect(tmux) })
    expect(rig.lines).toEqual([])
  })

  test('all nine keys and [pause] timeout_seconds at AD_SETTING_INTEGER_MAX are accepted: the grace minimum stays exact at the bound', () => {
    const rig = makeReaderRig()
    const tmux = Object.fromEntries(AD_TMUX_KEYS.map((key) => [key, AD_SETTING_INTEGER_MAX])) as AdTmuxValues
    rig.write({ tmux, pauseTimeout: AD_SETTING_INTEGER_MAX })
    expect(rig.read()).toEqual({ kind: 'accepted', values: inEffect(tmux, AD_SETTING_INTEGER_MAX) })
    expect(rig.lines).toEqual([])
  })

  test.each(TMUX_KEY_ROWS)('%s at AD_SETTING_INTEGER_MAX + 1 is refused as too large: the last values stay, one line', (key) => {
    const rig = makeReaderRig()
    rig.write(CHANGED_FILE)
    rig.read()
    rig.write({ tmux: tmuxWithKeyAt(key, AD_SETTING_INTEGER_MAX + 1n) })
    const reason = refusedReason(rig.read())
    expect(reason).toBe(`[${AD_TMUX_TABLE}] ${key} is too large for agent-director`)
    expect(rig.reader.valuesInEffect()).toEqual(CHANGED_IN_EFFECT)
    expect(rig.lines).toEqual([buildAdSettingsRefusedReadLine(rig.path, reason, true)])
  })
})

// ---------------------------------------------------------------------------
// [pause] timeout_seconds (SRJ-209: for SRJ-213's check only; never refuses the read)
// ---------------------------------------------------------------------------

describe('ad settings: [pause] timeout_seconds', () => {
  test.each<[string, AdConfigInput | undefined]>([
    ['no file', undefined],
    ['a file with no [pause] table', { tmux: CHANGED_TMUX }],
    ['a [pause] table with no timeout_seconds', { tmux: CHANGED_TMUX, extra: { pause: { other_key: 1n } } }],
  ])('%s gives the default', (_label, input) => {
    const rig = makeReaderRig()
    if (input !== undefined) rig.write(input)
    rig.read()
    expect(rig.reader.valuesInEffect().pauseTimeout).toEqual({ kind: 'used', seconds: DEFAULT_PAUSE_SECONDS })
  })

  test.each<[string, bigint]>([
    ['a positive integer', CHANGED_PAUSE_SECONDS],
    ['AD_SETTING_INTEGER_MAX', AD_SETTING_INTEGER_MAX],
  ])('%s is used as given', (_label, seconds) => {
    const rig = makeReaderRig()
    rig.write({ pauseTimeout: seconds })
    rig.read()
    expect(rig.reader.valuesInEffect().pauseTimeout).toEqual({ kind: 'used', seconds })
  })

  test.each<[string, AdConfigInput, string | undefined]>([
    ['0', { tmux: CHANGED_TMUX, pauseTimeout: 0n }, String(0n)],
    ['a negative value', { tmux: CHANGED_TMUX, pauseTimeout: -CHANGED_PAUSE_SECONDS }, String(-CHANGED_PAUSE_SECONDS)],
    ['a string', { tmux: CHANGED_TMUX, pauseTimeout: String(CHANGED_PAUSE_SECONDS) }, undefined],
    ['a float', { tmux: CHANGED_TMUX, pauseTimeout: Number(CHANGED_PAUSE_SECONDS) }, undefined],
    ['[pause] given as a value instead of a table', { tmux: CHANGED_TMUX, extra: { pause: CHANGED_PAUSE_SECONDS } }, undefined],
    ['an integer above AD_SETTING_INTEGER_MAX', { tmux: CHANGED_TMUX, pauseTimeout: AD_SETTING_INTEGER_MAX + 1n }, 'an integer too large for agent-director'],
  ])('%s is not used; the nine [tmux] values are accepted and no line is written', (_label, input, found) => {
    const rig = makeReaderRig()
    rig.write(input)
    const outcome = rig.read()
    expect(outcome.kind).toBe('accepted')
    const values = rig.reader.valuesInEffect()
    expect(values.tmux).toEqual(CHANGED_TMUX)
    expect(values.pauseTimeout.kind).toBe('not-used')
    if (found !== undefined) expect(values.pauseTimeout).toEqual({ kind: 'not-used', found })
    expect(rig.lines).toEqual([])
  })

  test('a refused read keeps the last accepted [pause] timeout_seconds', () => {
    const rig = makeReaderRig()
    rig.write(CHANGED_FILE)
    rig.read()
    rig.write({ ...REFUSED_AD_CONFIG_FORMS[1]!.input, pauseTimeout: DEFAULT_PAUSE_SECONDS * 3n })
    refusedReason(rig.read())
    expect(rig.reader.valuesInEffect().pauseTimeout).toEqual({ kind: 'used', seconds: CHANGED_PAUSE_SECONDS })
  })
})

// ---------------------------------------------------------------------------
// The install and the re-read at the version re-check's ticks (SRJ-209, SRJ-204)
// ---------------------------------------------------------------------------

/** E3's re-check installed on a fake clock, and the settings installed over a temp HOME after it (as `main()` does). */
interface TickRig {
  readonly clock: FakeClock
  readonly home: string
  readonly lines: string[]
  readonly reader: AdSettingsReader
  /** Timers pending just before the settings install. */
  readonly pendingBeforeInstall: number
  write(input: AdConfigInput): void
  readCount(): number
}

function makeTickRig(opts: { initial?: AdConfigInput; outcomes?: readonly StubResolveSystemBinaryOutcome[] } = {}): TickRig {
  const clock = createFakeClock()
  clocks.push(clock)
  installAdVersionRecheck({
    resolveSystemBinary: makeStubResolveSystemBinary(opts.outcomes ? { outcomes: opts.outcomes } : {}),
    baselineVersion: PHASE1_RC_VERSION,
    recordStartupError: () => {},
    stop: () => {},
    log: () => {},
    clock,
  })
  const home = makeHome()
  if (opts.initial !== undefined) writeAgentDirectorConfig(home, opts.initial)
  const lines: string[] = []
  let reads = 0
  const pendingBeforeInstall = clock.pendingCount()
  const reader = installAdSettings({
    home: () => {
      reads += 1
      return home
    },
    log: (line) => { lines.push(line) },
  })
  return {
    clock,
    home,
    lines,
    reader,
    pendingBeforeInstall,
    write: (input) => { writeAgentDirectorConfig(home, input) },
    readCount: () => reads,
  }
}

describe('ad settings: install and the re-read at each 120 s re-check tick', () => {
  test('with nothing installed the accessor answers the defaults', () => {
    expect(adSettingsInEffect()).toEqual(DEFAULT_AD_SETTINGS_IN_EFFECT)
  })

  test("the production home getter answers process.env.HOME, not Bun's launch-time os.homedir()", () => {
    expect(homedir()).not.toBe(process.env.HOME)
    expect(productionAdSettingsHome()).toBe(process.env.HOME!)
  })

  test('the install reads once, at once, arms no timer of its own, and the accessor answers what it read', () => {
    const rig = makeTickRig({ initial: CHANGED_FILE })
    expect(rig.readCount()).toBe(1)
    expect(adSettingsInEffect()).toEqual(CHANGED_IN_EFFECT)
    expect(rig.clock.pendingCount()).toBe(rig.pendingBeforeInstall)
    disposeAdVersionRecheck()
  })

  test('a file changed after start takes effect at the first tick, not before', async () => {
    const rig = makeTickRig({ initial: CHANGED_FILE })
    rig.write({ tmux: CHANGED_AGAIN_TMUX })
    await rig.clock.advance(AD_VERSION_RECHECK_INTERVAL_MS - 1)
    expect(rig.readCount()).toBe(1)
    expect(adSettingsInEffect()).toEqual(CHANGED_IN_EFFECT)
    await rig.clock.advance(1)
    expect(rig.readCount()).toBe(2)
    expect(adSettingsInEffect()).toEqual(inEffect(CHANGED_AGAIN_TMUX))
    disposeAdVersionRecheck()
  })

  test('consecutive refused ticks keep the values and log once', async () => {
    const rig = makeTickRig({ initial: CHANGED_FILE })
    rig.write(REFUSED_AD_CONFIG_FORMS[0]!.input)
    await rig.clock.advance(AD_VERSION_RECHECK_INTERVAL_MS * 3)
    expect(rig.readCount()).toBe(4)
    expect(adSettingsInEffect()).toEqual(CHANGED_IN_EFFECT)
    expect(rig.lines).toHaveLength(1)
    disposeAdVersionRecheck()
  })

  test('a tick whose re-check could not run still re-reads', async () => {
    const rig = makeTickRig({ initial: CHANGED_FILE, outcomes: [{ throws: errSystemInstallNotFound() }] })
    rig.write({ tmux: CHANGED_AGAIN_TMUX })
    await rig.clock.advance(AD_VERSION_RECHECK_INTERVAL_MS)
    expect(rig.readCount()).toBe(2)
    expect(adSettingsInEffect()).toEqual(inEffect(CHANGED_AGAIN_TMUX))
    disposeAdVersionRecheck()
  })

  test('a stopping tick does not re-read', async () => {
    const rig = makeTickRig({ initial: CHANGED_FILE, outcomes: [{ version: OLD_AD_VERSION }] })
    rig.write({ tmux: CHANGED_AGAIN_TMUX })
    await rig.clock.advance(AD_VERSION_RECHECK_INTERVAL_MS * 2)
    expect(rig.readCount()).toBe(1)
    expect(adSettingsInEffect()).toEqual(CHANGED_IN_EFFECT)
  })

  test("after the re-check's dispose nothing more is read", async () => {
    const rig = makeTickRig({ initial: CHANGED_FILE })
    await rig.clock.advance(AD_VERSION_RECHECK_INTERVAL_MS)
    expect(rig.readCount()).toBe(2)
    disposeAdVersionRecheck()
    rig.write({ tmux: CHANGED_AGAIN_TMUX })
    await rig.clock.advance(AD_VERSION_RECHECK_INTERVAL_MS * 3)
    expect(rig.readCount()).toBe(2)
    expect(adSettingsInEffect()).toEqual(CHANGED_IN_EFFECT)
  })

  test('a second install is a logged no-op that returns the installed reader and reads nothing', async () => {
    const rig = makeTickRig({ initial: CHANGED_FILE })
    const secondLines: string[] = []
    let secondReads = 0
    const second = installAdSettings({
      home: () => {
        secondReads += 1
        return rig.home
      },
      log: (line) => { secondLines.push(line) },
    })
    expect(second).toBe(rig.reader)
    expect(secondLines).toHaveLength(1)
    await rig.clock.advance(AD_VERSION_RECHECK_INTERVAL_MS)
    expect(secondReads).toBe(0)
    expect(rig.readCount()).toBe(2)
    disposeAdVersionRecheck()
  })
})

// ---------------------------------------------------------------------------
// Leak safety (b.av2 SR-10.3): no file text, string value or parser text in a line or a reason
// ---------------------------------------------------------------------------

describe('ad settings: no file text reaches a line or an outcome', () => {
  test.each<[string, 'refused with one line' | '[pause] timeout_seconds not used', AdConfigInput]>([
    ['text that is not TOML, a fake token on its offending line', 'refused with one line', { notToml: true, embed: fakeToken(BOT_TOKEN_PREFIX, 'toml') }],
    ['a [tmux] string value holding a fake token', 'refused with one line', { tmux: { query_timeout_ms: fakeToken(BOT_TOKEN_PREFIX, 'tmux') } }],
    ['a [pause] string value holding a fake token', '[pause] timeout_seconds not used', { pauseTimeout: fakeToken(BOT_TOKEN_PREFIX, 'pause') }],
  ])('%s: %s, and no fake token in it', (_label, path, input) => {
    const rig = makeReaderRig()
    rig.write(input)
    const outcome = rig.read()
    if (path === 'refused with one line') {
      expect(outcome.kind).toBe('refused')
      expect(rig.lines).toHaveLength(1)
    } else {
      expect(rig.reader.valuesInEffect().pauseTimeout.kind).toBe('not-used')
    }
    assertNoLeak({ lines: rig.lines, outcome, values: rig.reader.valuesInEffect() })
  })
})

// ---------------------------------------------------------------------------
// Source audits (SRJ-209: one parser, one settings module, no outage path)
// ---------------------------------------------------------------------------

const SETTINGS_MODULE = 'ad-settings.ts'

/** `src/` modules the settings module must never load: the session manager, the agent-director client, outage-state and the notifier. */
const FORBIDDEN_SETTINGS_LOADS = /^(?:session-manager|agent-director-client|outage-state)\.ts$|notifier/

/**
 * Every forbidden load in `loads`, as its import chain: a module
 * `FORBIDDEN_SETTINGS_LOADS` names; a Slack module, one named for Slack that
 * imports anything (a Slack-named module with no imports at all, such as the
 * pure log redactor, loads no Slack library); the agent-director package; or
 * an `@slack/` package.
 */
function forbiddenSettingsLoads(modules: Map<string, string>, loads: RuntimeLoads): string[] {
  const forbiddenModules = [...loads.modules]
    .filter(([name]) => FORBIDDEN_SETTINGS_LOADS.test(name) || (/slack/i.test(name) && importedSpecifiers(modules.get(name)!).length > 0))
    .map(([, chain]) => chain.join(' -> '))
  const forbiddenPackages = loads.packages
    .filter(({ specifier: s }) => s === 'agent-director' || s.startsWith('agent-director/') || s.startsWith('@slack/'))
    .map(({ chain, specifier }) => `${chain.join(' -> ')} -> ${specifier}`)
  return [...forbiddenModules, ...forbiddenPackages]
}

/** The `src/` modules whose code declares `name` (`const`, `let`, `var`, `function`, `class` or `enum`). */
function declarersOf(modules: Map<string, string>, name: string): string[] {
  const declaration = new RegExp(`\\b(?:const|let|var|function|class|enum)\\s+${name}\\b`)
  return [...modules].filter(([, code]) => declaration.test(code)).map(([file]) => file)
}

describe('ad settings: source audits', () => {
  test('smol-toml is imported by the settings module and by no other src/ module', () => {
    const importers = [...srcModules()].filter(([, code]) => importedSpecifiers(code).includes('smol-toml')).map(([name]) => name)
    expect(importers).toEqual([SETTINGS_MODULE])
  })

  test('the settings module loads, through its runtime imports in src/, neither the session manager nor the agent-director package, the client, outage-state, notifier or Slack modules', () => {
    const modules = srcModules()
    const loads = runtimeLoads(modules, SETTINGS_MODULE)
    expect(loads.modules.size).toBeGreaterThan(1)
    expect(loads.packages.map((p) => p.specifier)).toContain('smol-toml')
    expect(forbiddenSettingsLoads(modules, loads)).toEqual([])
  })

  test('DIALOG_READY_TIMEOUT_MS is declared, as an exported const, only in the settings module; the session manager imports it from there', () => {
    const modules = srcModules()
    expect(declarersOf(modules, 'DIALOG_READY_TIMEOUT_MS')).toEqual([SETTINGS_MODULE])
    expect(modules.get(SETTINGS_MODULE)!).toMatch(/\bexport\s+const\s+DIALOG_READY_TIMEOUT_MS\s*=/)
    expect(importSource(modules.get('session-manager.ts')!, 'DIALOG_READY_TIMEOUT_MS')).toBe(`./${SETTINGS_MODULE}`)
  })

  test('no other src/ module holds one of the nine key names as a string literal', () => {
    const holders: string[] = []
    for (const [name, code] of srcModules()) {
      if (name === SETTINGS_MODULE) continue
      for (const key of AD_TMUX_KEYS) {
        if (new RegExp(`['"\`]${key}['"\`]`).test(code)) holders.push(`${name}: ${key}`)
      }
    }
    expect(holders).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// The derived waits (SRJ-210): G, the alert threshold and B
// ---------------------------------------------------------------------------

/** Milliseconds per second and per minute: unit conversions only. */
const MS_PER_SECOND = 1000n
const MS_PER_MINUTE = Number(MS_PER_SECOND) * 60

/** G, the alert threshold and B, in milliseconds. */
interface DerivedWaits {
  readonly grace: number
  readonly threshold: number
  readonly bound: number
}

/** The three waits `src/ad-settings.ts` derives from `values`. */
function derivedWaits(values: AdSettingsInEffect): DerivedWaits {
  return { grace: adGraceMs(values), threshold: adAlertThresholdMs(values), bound: adLaunchBoundMs(values) }
}

/** The three waits the accessors answer from the values in effect now. */
function derivedWaitsInEffect(): DerivedWaits {
  return { grace: adGraceMsInEffect(), threshold: adAlertThresholdMsInEffect(), bound: adLaunchBoundMsInEffect() }
}

/** An exact millisecond count as a number, or the never-ending wait when a number cannot hold it exactly. */
function exactOrNeverEnds(ms: bigint): number {
  return ms <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(ms) : AD_WAIT_NEVER_ENDS
}

/** SRJ-210's waits for `tmux`, computed here from the addends and `DIALOG_READY_TIMEOUT_MS`. */
function expectedWaits(tmux: AdTmuxValues): DerivedWaits {
  const { pending_grace_seconds: grace, stopping_window_seconds: stopping, starting_session_seconds: starting } = tmux
  const longer = stopping > starting ? stopping : starting
  const fromGrace = (grace + AD_LAUNCH_BOUND_GRACE_ADDEND_SECONDS) * MS_PER_SECOND
  const cap = BigInt(DIALOG_READY_TIMEOUT_MS)
  return {
    grace: exactOrNeverEnds(grace * MS_PER_SECOND),
    threshold: exactOrNeverEnds((longer + AD_ALERT_THRESHOLD_ADDEND_SECONDS) * MS_PER_SECOND),
    bound: exactOrNeverEnds(fromGrace > cap ? fromGrace : cap),
  }
}

/** One fresh read of a file with `tmux` under a new temp HOME: the values in effect after it, which must be accepted. */
function acceptedValuesOf(tmux: Readonly<Partial<Record<AdTmuxKey, bigint>>>): AdSettingsInEffect {
  const rig = makeReaderRig()
  rig.write({ tmux })
  expect(rig.read().kind).toBe('accepted')
  return rig.reader.valuesInEffect()
}

/** The dialog approver's cap in whole seconds. */
const APPROVER_CAP_SECONDS = BigInt(DIALOG_READY_TIMEOUT_MS) / MS_PER_SECOND
/** The grace period at which G plus B's addend is exactly the approver's cap. */
const GRACE_AT_APPROVER_CAP = APPROVER_CAP_SECONDS - AD_LAUNCH_BOUND_GRACE_ADDEND_SECONDS

/** A file that moves all three waits off their defaults: B above the approver's cap, stopping_window_seconds the longer window. */
const WAITS_CHANGED_TMUX = tmuxWith({
  pending_grace_seconds: APPROVER_CAP_SECONDS,
  stopping_window_seconds: DEFAULT_TMUX.starting_session_seconds + 1n,
})

describe('ad settings: the derived waits G, the alert threshold and B', () => {
  test.each<[string, Partial<Record<AdTmuxKey, bigint>> | undefined]>([
    ['the defaults (no file)', undefined],
    ['pending_grace_seconds, stopping_window_seconds and starting_session_seconds all written', WAITS_CHANGED_TMUX],
    ['starting_session_seconds the longer window', {
      stopping_window_seconds: AD_SETTING_MINIMUMS.stopping_window_seconds,
      starting_session_seconds: AD_SETTING_MINIMUMS.starting_session_seconds,
    }],
    ['stopping_window_seconds the longer window', { stopping_window_seconds: DEFAULT_TMUX.starting_session_seconds + 1n }],
    ['the two windows equal', { stopping_window_seconds: DEFAULT_TMUX.starting_session_seconds }],
    ["G plus the addend exactly the approver's cap", { pending_grace_seconds: GRACE_AT_APPROVER_CAP }],
  ])('%s', (_label, tmux) => {
    const rig = makeReaderRig()
    if (tmux !== undefined) rig.write({ tmux })
    expect(rig.read().kind).toBe('accepted')
    expect(derivedWaits(rig.reader.valuesInEffect())).toEqual(expectedWaits(tmuxWith(tmux ?? {})))
  })

  test.each<[string, bigint, (waits: DerivedWaits) => number]>([
    ["below the approver's cap, B is DIALOG_READY_TIMEOUT_MS", GRACE_AT_APPROVER_CAP - 1n, () => DIALOG_READY_TIMEOUT_MS],
    ["above the approver's cap, B is G plus the addend", GRACE_AT_APPROVER_CAP + 1n, (waits) => waits.grace + Number(AD_LAUNCH_BOUND_GRACE_ADDEND_SECONDS * MS_PER_SECOND)],
  ])('%s', (_label, grace, expectedBound) => {
    const waits = derivedWaits(acceptedValuesOf({ pending_grace_seconds: grace }))
    expect(waits.bound).toBe(expectedBound(waits))
  })
})

// ---------------------------------------------------------------------------
// Check time (SRJ-210: a threshold or bound is checked against the values in effect when CSCB checks it)
// ---------------------------------------------------------------------------

describe('ad settings: the derived waits at check time', () => {
  test('with nothing installed the accessors answer the waits of the defaults', () => {
    expect(derivedWaitsInEffect()).toEqual(expectedWaits(DEFAULT_TMUX))
  })

  test('after an accepted read at a tick the accessors answer the new waits, and not before', async () => {
    const rig = makeTickRig()
    const before = expectedWaits(DEFAULT_TMUX)
    const after = expectedWaits(WAITS_CHANGED_TMUX)
    for (const name of ['grace', 'threshold', 'bound'] as const) expect(after[name]).not.toBe(before[name])
    expect(derivedWaitsInEffect()).toEqual(before)
    rig.write({ tmux: WAITS_CHANGED_TMUX })
    await rig.clock.advance(AD_VERSION_RECHECK_INTERVAL_MS - 1)
    expect(derivedWaitsInEffect()).toEqual(before)
    await rig.clock.advance(1)
    expect(derivedWaitsInEffect()).toEqual(after)
    disposeAdVersionRecheck()
  })

  test('a refused read at a tick: the accessors still answer the last accepted waits', async () => {
    const rig = makeTickRig({ initial: { tmux: WAITS_CHANGED_TMUX } })
    rig.write(REFUSED_AD_CONFIG_FORMS[0]!.input)
    await rig.clock.advance(AD_VERSION_RECHECK_INTERVAL_MS)
    expect(rig.readCount()).toBe(2)
    expect(rig.lines).toHaveLength(1)
    expect(derivedWaitsInEffect()).toEqual(expectedWaits(WAITS_CHANGED_TMUX))
    disposeAdVersionRecheck()
  })
})

// ---------------------------------------------------------------------------
// Beyond the timer maximum (SRJ-210: a setting too large for the timers never ends a wait early)
// ---------------------------------------------------------------------------

/** A fake clock the `afterEach` checks for pending timers. */
function trackedClock(): FakeClock {
  const clock = createFakeClock()
  clocks.push(clock)
  return clock
}

/** A grace period whose wait is more than twice `MAX_TIMER_DELAY_MS`, so a never-early wait chains at least three timers. */
const HUGE_GRACE_SECONDS = (BigInt(MAX_TIMER_DELAY_MS) * 2n) / MS_PER_SECOND + 1n
/** The largest grace period whose wait in milliseconds a number holds exactly. */
const LARGEST_EXACT_GRACE_SECONDS = BigInt(Number.MAX_SAFE_INTEGER) / MS_PER_SECOND

/** G read from a file whose grace period is {@link HUGE_GRACE_SECONDS}. */
function hugeGraceMs(): number {
  const grace = adGraceMs(acceptedValuesOf({ pending_grace_seconds: HUGE_GRACE_SECONDS }))
  expect(grace).toBeGreaterThan(MAX_TIMER_DELAY_MS * 2)
  expect(Number.isFinite(grace)).toBe(true)
  return grace
}

/** The pending timers' requested delays; asserts at most one is pending and none asks more than `MAX_TIMER_DELAY_MS`. */
function expectOneClampedTimerAtMost(clock: FakeClock): void {
  expect(clock.pendingCount()).toBeLessThanOrEqual(1)
  for (const timer of clock.pending()) expect(timer.delayMs).toBeLessThanOrEqual(MAX_TIMER_DELAY_MS)
}

/**
 * Fire a never-early wait's chain one timer at a time until its callback has
 * run (`firedAt` is not empty) or `wait` has elapsed in timer fires: before
 * each fire exactly one timer is pending and none asks more than
 * `MAX_TIMER_DELAY_MS`.
 */
async function runChainUntilFired(clock: FakeClock, firedAt: readonly number[], wait: number): Promise<void> {
  const stepBudget = Math.ceil(wait / MAX_TIMER_DELAY_MS) + 1
  for (let step = 0; firedAt.length === 0 && step < stepBudget; step++) {
    expectOneClampedTimerAtMost(clock)
    expect(clock.pendingCount()).toBe(1)
    await clock.runNext()
  }
}

describe('ad settings: a derived wait beyond the timer maximum', () => {
  test('the hazard: a plain timer of G on the same clock fires after 1 ms', async () => {
    const grace = hugeGraceMs()
    const clock = trackedClock()
    let fired = 0
    clock.setTimeout(() => { fired += 1 }, grace)
    await clock.advance(1)
    expect(fired).toBe(1)
  })

  test.each<[string, number]>([
    ['armed at the start', 0],
    ['armed after the start, beyond the timer maximum', MAX_TIMER_DELAY_MS + 1],
  ])('%s: not fired past the timer maximum, fired once exactly at G, never a pending timer above the maximum', async (_label, armedAfter) => {
    const grace = hugeGraceMs()
    const clock = trackedClock()
    const start = clock.now()
    await clock.advance(armedAfter)
    const firedAt: number[] = []
    armNeverEarlyWait(clock, start, grace, () => { firedAt.push(clock.now()) })
    expectOneClampedTimerAtMost(clock)
    expect(clock.pendingCount()).toBe(1)
    await clock.advance(MAX_TIMER_DELAY_MS + 1)
    expect(firedAt).toEqual([])
    await runChainUntilFired(clock, firedAt, grace)
    expect(firedAt).toEqual([start + grace])
    expect(clock.pendingCount()).toBe(0)
    await clock.advance(MAX_TIMER_DELAY_MS)
    expect(firedAt).toHaveLength(1)
  })

  test.each<[string, AdTmuxKey, bigint, readonly (keyof DerivedWaits)[]]>([
    ['pending_grace_seconds at AD_SETTING_INTEGER_MAX: G and B never end', 'pending_grace_seconds', AD_SETTING_INTEGER_MAX, ['grace', 'bound']],
    ['pending_grace_seconds one above the largest exact grace: G and B never end', 'pending_grace_seconds', LARGEST_EXACT_GRACE_SECONDS + 1n, ['grace', 'bound']],
    ['pending_grace_seconds at the largest exact grace: G is exact, B never ends', 'pending_grace_seconds', LARGEST_EXACT_GRACE_SECONDS, ['bound']],
    ['stopping_window_seconds at AD_SETTING_INTEGER_MAX: the threshold never ends', 'stopping_window_seconds', AD_SETTING_INTEGER_MAX, ['threshold']],
    ['starting_session_seconds at AD_SETTING_INTEGER_MAX: the threshold never ends', 'starting_session_seconds', AD_SETTING_INTEGER_MAX, ['threshold']],
  ])('%s', (_label, key, value, neverEnding) => {
    const waits = derivedWaits(acceptedValuesOf({ [key]: value }))
    expect(waits).toEqual(expectedWaits(tmuxWith({ [key]: value })))
    for (const name of Object.keys(waits) as (keyof DerivedWaits)[]) {
      expect(waits[name] === AD_WAIT_NEVER_ENDS).toBe(neverEnding.includes(name))
      expect(Number.MAX_VALUE >= waits[name]).toBe(!neverEnding.includes(name))
    }
    if (key === 'pending_grace_seconds' && !neverEnding.includes('grace')) expect(waits.grace).toBe(Number(value * MS_PER_SECOND))
  })

  test('a wait that never ends arms no timer and never runs the callback', async () => {
    const grace = adGraceMs(acceptedValuesOf({ pending_grace_seconds: AD_SETTING_INTEGER_MAX }))
    const clock = trackedClock()
    let fired = 0
    const cancel = armNeverEarlyWait(clock, clock.now(), grace, () => { fired += 1 })
    expect(clock.pendingCount()).toBe(0)
    await clock.advance(MAX_TIMER_DELAY_MS * 3)
    expect(fired).toBe(0)
    cancel()
    expect(clock.pendingCount()).toBe(0)
  })

  test('cancel mid-chain leaves no timer pending and the callback never runs; a second cancel does nothing', async () => {
    const grace = hugeGraceMs()
    const clock = trackedClock()
    let fired = 0
    const cancel = armNeverEarlyWait(clock, clock.now(), grace, () => { fired += 1 })
    await clock.advance(MAX_TIMER_DELAY_MS + 1)
    expect(clock.pendingCount()).toBe(1)
    cancel()
    expect(clock.pendingCount()).toBe(0)
    cancel()
    expect(clock.pendingCount()).toBe(0)
    await clock.advance(grace)
    expect(fired).toBe(0)
  })

  test('cancel after the callback ran does nothing: another timer on the clock stays pending', async () => {
    const grace = adGraceMs(DEFAULT_AD_SETTINGS_IN_EFFECT)
    const clock = trackedClock()
    let fired = 0
    const cancel = armNeverEarlyWait(clock, clock.now(), grace, () => { fired += 1 })
    await clock.advance(grace)
    expect(fired).toBe(1)
    let otherFired = 0
    clock.setTimeout(() => { otherFired += 1 }, grace)
    cancel()
    cancel()
    expect(clock.pendingCount()).toBe(1)
    await clock.advance(grace)
    expect([fired, otherFired]).toEqual([1, 1])
  })

  test('timers that fire early never run the callback before the deadline', async () => {
    const grace = adGraceMs(DEFAULT_AD_SETTINGS_IN_EFFECT)
    const clock = trackedClock()
    const halving: NeverEarlyWaitClock = {
      now: () => clock.now(),
      setTimeout: (callback, delayMs) => clock.setTimeout(callback, Math.floor(delayMs / 2)),
      clearTimeout: (handle) => { clock.clearTimeout(handle) },
    }
    const start = clock.now()
    const firedAt: number[] = []
    armNeverEarlyWait(halving, start, grace, () => { firedAt.push(clock.now()) })
    await clock.advance(grace - 1)
    expect(firedAt).toEqual([])
    await clock.advance(1)
    expect(firedAt).toEqual([start + grace])
    expect(clock.pendingCount()).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// armNeverEarlyWait's contract: bad input, no synchronous callback
// ---------------------------------------------------------------------------

describe('ad settings: armNeverEarlyWait arming', () => {
  test.each<[string, number, NeverEarlyWaitLength]>([
    ['a NaN start', Number.NaN, adGraceMs(DEFAULT_AD_SETTINGS_IN_EFFECT)],
    ['an infinite start', Number.POSITIVE_INFINITY, adGraceMs(DEFAULT_AD_SETTINGS_IN_EFFECT)],
    ['a negative infinite start', Number.NEGATIVE_INFINITY, adGraceMs(DEFAULT_AD_SETTINGS_IN_EFFECT)],
    ['a NaN wait', 0, Number.NaN],
    ['a getter whose first value is NaN', 0, () => Number.NaN],
  ])('%s throws a RangeError and arms nothing', (_label, start, wait) => {
    const clock = trackedClock()
    let fired = 0
    expect(() => armNeverEarlyWait(clock, start, wait, () => { fired += 1 })).toThrow(RangeError)
    expect(clock.pendingCount()).toBe(0)
    expect(fired).toBe(0)
  })

  test.each<[string, number]>([
    ['a wait of 0', 0],
    ['a deadline already passed', adGraceMs(DEFAULT_AD_SETTINGS_IN_EFFECT)],
  ])('%s: the callback does not run during the arm, and runs once from the next timer', async (_label, wait) => {
    const clock = trackedClock()
    await clock.advance(wait * 2)
    let fired = 0
    armNeverEarlyWait(clock, 0, wait, () => { fired += 1 })
    expect(fired).toBe(0)
    expect(clock.pendingCount()).toBe(1)
    await clock.runNext()
    expect(fired).toBe(1)
    expect(clock.pendingCount()).toBe(0)
  })

  test('a getter whose deadline already passed at the arm: the callback does not run during the arm, and runs once from the next timer', async () => {
    const wait = adGraceMs(DEFAULT_AD_SETTINGS_IN_EFFECT)
    const clock = trackedClock()
    await clock.advance(wait * 2)
    let fired = 0
    armNeverEarlyWait(clock, 0, () => wait, () => { fired += 1 })
    expect(fired).toBe(0)
    expect(clock.pendingCount()).toBe(1)
    await clock.runNext()
    expect(fired).toBe(1)
    expect(clock.pendingCount()).toBe(0)
    await clock.advance(MAX_TIMER_DELAY_MS)
    expect(fired).toBe(1)
  })

  test('a getter that throws at the arm: the error propagates out of the arm and nothing is armed', async () => {
    const clock = trackedClock()
    const failure = new Error('stub wait getter failure at the arm')
    let fired = 0
    let caught: unknown
    try {
      armNeverEarlyWait(clock, clock.now(), () => { throw failure }, () => { fired += 1 })
    } catch (error) {
      caught = error
    }
    expect(caught).toBe(failure)
    expect(clock.pendingCount()).toBe(0)
    await clock.advance(MAX_TIMER_DELAY_MS)
    expect(fired).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// A getter wait (SRJ-210: the wait in effect is read again at every timer fire)
// ---------------------------------------------------------------------------

/** A wait getter the test steers: from the next call it answers `set`'s value, or throws after `set('throws')`. */
interface SteeredWait {
  readonly get: () => number
  set(next: number | 'throws'): void
}

function steeredWait(initial: number): SteeredWait {
  let current: number | 'throws' = initial
  return {
    get: () => {
      if (current === 'throws') throw new Error('stub wait getter failure')
      return current
    },
    set: (next) => { current = next },
  }
}

/** G at the defaults: the short wait the getter cases arm with. */
const DEFAULT_GRACE_MS = adGraceMs(DEFAULT_AD_SETTINGS_IN_EFFECT)

describe('ad settings: armNeverEarlyWait with a getter, read at every fire', () => {
  test.each<[string, () => number]>([
    ['to a longer wait under the timer maximum', () => adAlertThresholdMs(DEFAULT_AD_SETTINGS_IN_EFFECT)],
    ['to a wait beyond the timer maximum', hugeGraceMs],
  ])('raised while armed %s: no callback at the old deadline, once exactly at the new one', async (_label, raisedWait) => {
    const raised = raisedWait()
    expect(raised).toBeGreaterThan(DEFAULT_GRACE_MS)
    const clock = trackedClock()
    const start = clock.now()
    const wait = steeredWait(DEFAULT_GRACE_MS)
    const firedAt: number[] = []
    armNeverEarlyWait(clock, start, wait.get, () => { firedAt.push(clock.now()) })
    await clock.advance(DEFAULT_GRACE_MS - 1)
    wait.set(raised)
    await clock.advance(1)
    expect(firedAt).toEqual([])
    await runChainUntilFired(clock, firedAt, raised)
    expect(firedAt).toEqual([start + raised])
    expect(clock.pendingCount()).toBe(0)
  })

  test('lowered between fires to a deadline already passed: ends at the next fire, not before', async () => {
    const clock = trackedClock()
    const start = clock.now()
    const wait = steeredWait(hugeGraceMs())
    const firedAt: number[] = []
    armNeverEarlyWait(clock, start, wait.get, () => { firedAt.push(clock.now()) })
    await clock.advance(DEFAULT_GRACE_MS)
    wait.set(DEFAULT_GRACE_MS)
    const nextFire = start + MAX_TIMER_DELAY_MS
    expect(clock.pending().map((timer) => timer.dueAt)).toEqual([nextFire])
    await clock.advanceTo(nextFire - 1)
    expect(firedAt).toEqual([])
    await clock.advanceTo(nextFire)
    expect(firedAt).toEqual([nextFire])
    expect(clock.pendingCount()).toBe(0)
  })

  test('lowered between fires to a deadline after the next fire: the next timer is armed for it and the wait ends exactly there', async () => {
    const clock = trackedClock()
    const start = clock.now()
    const huge = hugeGraceMs()
    const lowered = MAX_TIMER_DELAY_MS + DEFAULT_GRACE_MS
    expect(lowered).toBeLessThan(huge)
    const wait = steeredWait(huge)
    const firedAt: number[] = []
    armNeverEarlyWait(clock, start, wait.get, () => { firedAt.push(clock.now()) })
    await clock.advance(DEFAULT_GRACE_MS)
    wait.set(lowered)
    await clock.advanceTo(start + MAX_TIMER_DELAY_MS)
    expect(firedAt).toEqual([])
    expect(clock.pending().map((timer) => timer.dueAt)).toEqual([start + lowered])
    await clock.advanceTo(start + lowered - 1)
    expect(firedAt).toEqual([])
    await clock.advanceTo(start + lowered)
    expect(firedAt).toEqual([start + lowered])
    expect(clock.pendingCount()).toBe(0)
  })

  test('a getter at AD_WAIT_NEVER_ENDS keeps one timer of the maximum pending and never runs the callback; lowering it later ends the wait', async () => {
    const clock = trackedClock()
    const wait = steeredWait(AD_WAIT_NEVER_ENDS)
    const firedAt: number[] = []
    armNeverEarlyWait(clock, clock.now(), wait.get, () => { firedAt.push(clock.now()) })
    for (let fire = 0; fire < 3; fire++) {
      expect(clock.pending().map((timer) => timer.delayMs)).toEqual([MAX_TIMER_DELAY_MS])
      await clock.runNext()
    }
    expect(firedAt).toEqual([])
    const [nextTimer] = clock.pending()
    expect(clock.pending().map((timer) => timer.delayMs)).toEqual([MAX_TIMER_DELAY_MS])
    wait.set(DEFAULT_GRACE_MS)
    await clock.runNext()
    expect(firedAt).toEqual([nextTimer!.dueAt])
    expect(clock.pendingCount()).toBe(0)
  })

  test('cancel mid-chain with a getter at AD_WAIT_NEVER_ENDS: no timer pending after it and the callback never runs', async () => {
    const clock = trackedClock()
    const wait = steeredWait(AD_WAIT_NEVER_ENDS)
    const firedAt: number[] = []
    const cancel = armNeverEarlyWait(clock, clock.now(), wait.get, () => { firedAt.push(clock.now()) })
    await clock.runNext()
    await clock.runNext()
    expect(clock.pendingCount()).toBe(1)
    cancel()
    expect(clock.pendingCount()).toBe(0)
    wait.set(DEFAULT_GRACE_MS)
    await clock.advance(MAX_TIMER_DELAY_MS * 3)
    expect(firedAt).toEqual([])
    expect(clock.pendingCount()).toBe(0)
  })

  test.each<[string, () => number, boolean]>([
    ['the deadline already passed at that fire', () => DEFAULT_GRACE_MS, true],
    ['the deadline not yet passed at that fire', hugeGraceMs, false],
  ])('a getter that calls the cancel while it runs at a fire, %s: the callback never runs and no timer is left pending', async (_label, waitAtFire, deadlinePassed) => {
    const waitMs = waitAtFire()
    const clock = trackedClock()
    const start = clock.now()
    let calls = 0
    let cancel: () => void = () => {}
    const getter = (): number => {
      calls += 1
      if (calls === 2) cancel()
      return waitMs
    }
    const firedAt: number[] = []
    cancel = armNeverEarlyWait(clock, start, getter, () => { firedAt.push(clock.now()) })
    expect([calls, clock.pendingCount()]).toEqual([1, 1])
    await clock.runNext()
    expect(calls).toBe(2)
    expect(clock.now() - start >= waitMs).toBe(deadlinePassed)
    expect(firedAt).toEqual([])
    expect(clock.pendingCount()).toBe(0)
    await clock.advance(waitMs)
    expect(firedAt).toEqual([])
    expect(calls).toBe(2)
    expect(clock.pendingCount()).toBe(0)
  })

  test.each<[string, number | 'throws']>([
    ['answers NaN', Number.NaN],
    ['throws', 'throws'],
  ])('a getter that %s at a fire: nothing thrown or logged, re-armed at the maximum, and the wait ends once a valid value returns', async (_label, bad) => {
    const consoleSpies = (['log', 'warn', 'error'] as const).map((method) => spyOn(console, method))
    try {
      const clock = trackedClock()
      const start = clock.now()
      const wait = steeredWait(DEFAULT_GRACE_MS)
      const firedAt: number[] = []
      armNeverEarlyWait(clock, start, wait.get, () => { firedAt.push(clock.now()) })
      wait.set(bad)
      expect(await clock.advance(DEFAULT_GRACE_MS)).toBe(1)
      expect(firedAt).toEqual([])
      expect(clock.pending().map((timer) => [timer.scheduledAt, timer.delayMs])).toEqual([[start + DEFAULT_GRACE_MS, MAX_TIMER_DELAY_MS]])
      wait.set(DEFAULT_GRACE_MS)
      await clock.runNext()
      expect(firedAt).toEqual([start + DEFAULT_GRACE_MS + MAX_TIMER_DELAY_MS])
      expect(clock.pendingCount()).toBe(0)
      for (const spy of consoleSpies) expect(spy).not.toHaveBeenCalled()
    } finally {
      for (const spy of consoleSpies) spy.mockRestore()
    }
  })

  test('wired to adGraceMsInEffect: an accepted read at a tick raising pending_grace_seconds mid-wait ends the wait at the raised G, not the armed one', async () => {
    const intervalSeconds = BigInt(AD_VERSION_RECHECK_INTERVAL_MS) / MS_PER_SECOND
    const armedTmux = tmuxWith({ pending_grace_seconds: intervalSeconds * 2n })
    const raisedTmux = tmuxWith({ pending_grace_seconds: intervalSeconds * 3n })
    const [armedGrace, raisedGrace] = [armedTmux, raisedTmux].map((tmux) => adGraceMs(inEffect(tmux)))
    expect(armedGrace!).toBeGreaterThan(AD_VERSION_RECHECK_INTERVAL_MS)
    const rig = makeTickRig({ initial: { tmux: armedTmux } })
    expect(adGraceMsInEffect()).toBe(armedGrace!)
    const start = rig.clock.now()
    const firedAt: number[] = []
    armNeverEarlyWait(rig.clock, start, adGraceMsInEffect, () => { firedAt.push(rig.clock.now()) })
    rig.write({ tmux: raisedTmux })
    await rig.clock.advance(AD_VERSION_RECHECK_INTERVAL_MS)
    expect(adGraceMsInEffect()).toBe(raisedGrace!)
    await rig.clock.advanceTo(start + raisedGrace! - 1)
    expect(firedAt).toEqual([])
    await rig.clock.advanceTo(start + raisedGrace!)
    expect(firedAt).toEqual([start + raisedGrace!])
    disposeAdVersionRecheck()
  })
})

// ---------------------------------------------------------------------------
// Whole minutes (SRJ-210: a notice gives a derived value in whole minutes, rounded down)
// ---------------------------------------------------------------------------

describe('ad settings: whole minutes, rounded down', () => {
  const thresholdAtDefaults = adAlertThresholdMs(DEFAULT_AD_SETTINGS_IN_EFFECT)
  test.each<[string, number]>([
    ['the threshold at the defaults', thresholdAtDefaults],
    ['the threshold at the defaults less one second', thresholdAtDefaults - Number(MS_PER_SECOND)],
    ['B at the defaults', adLaunchBoundMs(DEFAULT_AD_SETTINGS_IN_EFFECT)],
    ['the threshold with starting_session_seconds at twice its minimum', adAlertThresholdMs(inEffect(tmuxWith({
      starting_session_seconds: AD_SETTING_MINIMUMS.starting_session_seconds * 2n,
    })))],
    ['one millisecond under a minute', MS_PER_MINUTE - 1],
    ['a wait that never ends', AD_WAIT_NEVER_ENDS],
  ])('%s', (_label, ms) => {
    expect(wholeMinutes(ms)).toBe(Math.floor(ms / MS_PER_MINUTE))
  })
})

// ---------------------------------------------------------------------------
// The verb ceilings (SRJ-213; ADSRD SR-13.2)
// ---------------------------------------------------------------------------

/** One fresh read of `input` under a new temp HOME: the values in effect after it, which must be accepted. */
function acceptedValuesOfFile(input: AdConfigInput): AdSettingsInEffect {
  const rig = makeReaderRig()
  rig.write(input)
  expect(rig.read().kind).toBe('accepted')
  return rig.reader.valuesInEffect()
}

/** The larger of a list of exact values. */
function maxOf(values: readonly bigint[]): bigint {
  return values.reduce((largest, value) => (value > largest ? value : largest))
}

/**
 * A verb's ceiling paths (ADSRD SR-13.2), written out here from the record's
 * Q, A, C, W, E and B; the ceiling is the largest path. `pause` counts its
 * wait only when `[pause] timeout_seconds` is used.
 */
function ceilingPaths(verb: AdCeilingVerb, values: AdSettingsInEffect): bigint[] {
  const {
    query_timeout_ms: q,
    action_timeout_ms: a,
    create_timeout_ms: c,
    pipe_close_wait_ms: w,
    kill_exit_wait_ms: e,
    sweep_budget_seconds: b,
  } = values.tmux
  const pauseWaitMs = values.pauseTimeout.kind === 'used' ? values.pauseTimeout.seconds * MS_PER_SECOND : 0n
  switch (verb) {
    case 'kill':
      return [2n * q + 2n * a + e + 4n * w, 3n * q + 2n * a + 5n * w]
    case 'read-pane':
      return [3n * q + a + 4n * w]
    case 'send-keys':
      return [3n * q + 2n * a + 5n * w]
    case 'pause':
      return [3n * q + 2n * a + 5n * w + pauseWaitMs]
    case 'resume':
    case 'spawn-with-reuse':
    case 'plain-spawn':
      return [q + c + 2n * a + 4n * w, 2n * q + c + 3n * w]
    case 'find-missing':
    case 'expire':
      return [b * MS_PER_SECOND + q + w]
  }
}

/** A verb's ceiling by the formula written out here. */
function formulaCeiling(verb: AdCeilingVerb, values: AdSettingsInEffect): bigint {
  return maxOf(ceilingPaths(verb, values))
}

const CEILING_VERBS: readonly AdCeilingVerb[] = AD_CEILING_VERBS.map(({ verb }) => verb)
/** The verbs CSCB calls: every verb but `expire` (pinned below). */
const CSCB_CEILING_VERBS: readonly AdCeilingVerb[] = AD_CEILING_VERBS.filter(({ cscbCalls }) => cscbCalls).map(({ verb }) => verb)

/** The need by the formula written out here: the largest ceiling among the verbs CSCB calls, plus the margin. */
function formulaNeed(values: AdSettingsInEffect): bigint {
  return maxOf(CSCB_CEILING_VERBS.map((verb) => formulaCeiling(verb, values))) + AD_CALL_TIMEOUT_NEED_MARGIN_MS
}

/**
 * A query timeout above both E - W and 2A + W, so each two-path verb's second
 * path is the larger: derived from the defaults, never typed.
 */
const RAISED_QUERY_TIMEOUT_MS = DEFAULT_TMUX.kill_exit_wait_ms + 2n * DEFAULT_TMUX.action_timeout_ms + DEFAULT_TMUX.pipe_close_wait_ms
const RAISED_QUERY_IN_EFFECT = inEffect(tmuxWith({ query_timeout_ms: RAISED_QUERY_TIMEOUT_MS }))

/** SRJ-213's worked inputs: `create_timeout_ms` 40000 with the grace period at the minimum it gives (61), and a pause wait of 60. */
const WORKED_CREATE_TIMEOUT_MS = 40000n
const WORKED_TMUX = {
  create_timeout_ms: WORKED_CREATE_TIMEOUT_MS,
  pending_grace_seconds: pendingGraceMinimumSeconds(WORKED_CREATE_TIMEOUT_MS, DEFAULT_TMUX.pipe_close_wait_ms),
}
const WORKED_PAUSE_SECONDS = 60n

const TWO_PATH_VERBS: readonly AdCeilingVerb[] = ['kill', 'resume', 'spawn-with-reuse', 'plain-spawn']

describe('ad settings: the verb ceilings (b.jg5 SRJ-213)', () => {
  test.each(CEILING_VERBS.map((verb) => [verb]))('%s: its ceiling equals its formula at the defaults, with Q raised and with every value changed', (verb) => {
    const valueSets = [DEFAULT_AD_SETTINGS_IN_EFFECT, RAISED_QUERY_IN_EFFECT, CHANGED_IN_EFFECT]
    expect(valueSets.map((values) => adVerbCeilingsMs(values)[verb])).toEqual(valueSets.map((values) => formulaCeiling(verb, values)))
  })

  test.each(TWO_PATH_VERBS.map((verb) => [verb]))('%s: its first path sets the ceiling at the defaults, its second path with Q raised', (verb) => {
    const [firstAtDefaults, secondAtDefaults] = ceilingPaths(verb, DEFAULT_AD_SETTINGS_IN_EFFECT)
    const [firstRaised, secondRaised] = ceilingPaths(verb, RAISED_QUERY_IN_EFFECT)
    expect([firstAtDefaults! > secondAtDefaults!, secondRaised! > firstRaised!]).toEqual([true, true])
    expect([adVerbCeilingsMs(DEFAULT_AD_SETTINGS_IN_EFFECT)[verb], adVerbCeilingsMs(RAISED_QUERY_IN_EFFECT)[verb]]).toEqual([firstAtDefaults!, secondRaised!])
  })

  test.each<[string, AdSettingsInEffect, bigint]>([
    ['the default wait', DEFAULT_AD_SETTINGS_IN_EFFECT, DEFAULT_PAUSE_SECONDS * MS_PER_SECOND],
    ['a wait of 60', inEffect(DEFAULT_TMUX, WORKED_PAUSE_SECONDS), WORKED_PAUSE_SECONDS * MS_PER_SECOND],
    ['an unused value (0): no wait', { tmux: DEFAULT_TMUX, pauseTimeout: { kind: 'not-used', found: String(0n) } }, 0n],
  ])("pause is send-keys' ceiling plus [pause] timeout_seconds: %s", (_label, values, waitMs) => {
    const ceilings = adVerbCeilingsMs(values)
    expect(ceilings.pause - ceilings['send-keys']).toBe(waitMs)
  })

  test.each<[string, AdSettingsInEffect]>([
    ['at the defaults', DEFAULT_AD_SETTINGS_IN_EFFECT],
    ['with Q raised', RAISED_QUERY_IN_EFFECT],
    ['with create_timeout_ms 40000', inEffect(tmuxWith(WORKED_TMUX))],
  ])("a plain spawn's ceiling, and a reuse's, equals resume's %s", (_label, values) => {
    const ceilings = adVerbCeilingsMs(values)
    expect([ceilings['spawn-with-reuse'], ceilings['plain-spawn']]).toEqual([ceilings.resume, ceilings.resume])
  })

  test('expire is the one verb CSCB does not call, so it never sets the need', () => {
    expect(AD_CEILING_VERBS.filter(({ cscbCalls }) => !cscbCalls).map(({ verb }) => verb)).toEqual(['expire'])
  })

  test('the launch row the warning line names is resume, spawn-with-reuse and plain-spawn, in that order', () => {
    expect(AD_LAUNCH_CEILING_VERBS).toEqual(['resume', 'spawn-with-reuse', 'plain-spawn'])
  })
})

// ---------------------------------------------------------------------------
// The need (SRJ-213: the largest ceiling among the verbs CSCB calls, plus the margin)
// ---------------------------------------------------------------------------

/** A sweep budget whose ceiling is above every other ceiling at the defaults: derived, never typed. */
const SWEEP_LARGEST_SECONDS = maxOf(CSCB_CEILING_VERBS.map((verb) => formulaCeiling(verb, DEFAULT_AD_SETTINGS_IN_EFFECT))) / MS_PER_SECOND + 1n

/** The four unused forms of `[pause] timeout_seconds` SRJ-213's check names (0 is the SRD's worked input). */
const UNUSED_PAUSE_FORMS: readonly (readonly [string, AdConfigValue])[] = [
  ['0', 0n],
  ['a negative value', -CHANGED_PAUSE_SECONDS],
  ['a string', String(CHANGED_PAUSE_SECONDS)],
  ['a float', Number(CHANGED_PAUSE_SECONDS)],
]

/** `values`' unused pause description; fails the case when the pause value is used. */
function unusedPauseFound(values: AdSettingsInEffect): string {
  expect(values.pauseTimeout.kind).toBe('not-used')
  return values.pauseTimeout.kind === 'not-used' ? values.pauseTimeout.found : ''
}

describe('ad settings: the call timeout need (b.jg5 SRJ-213)', () => {
  test.each<[string, () => AdSettingsInEffect, AdCeilingVerb]>([
    ['at the defaults (an empty file): pause', () => acceptedValuesOfFile({}), 'pause'],
    [
      'create_timeout_ms 40000 and pending_grace_seconds 61, read from the file: resume, whose launch ceiling a reuse and a plain spawn share',
      () => acceptedValuesOfFile({ tmux: WORKED_TMUX }),
      'resume',
    ],
    ['[pause] timeout_seconds 60, read from the file: pause, with the larger wait', () => acceptedValuesOfFile({ pauseTimeout: WORKED_PAUSE_SECONDS }), 'pause'],
    ["the sweep's ceiling the largest: find-missing, never expire", () => acceptedValuesOfFile({ tmux: { sweep_budget_seconds: SWEEP_LARGEST_SECONDS } }), 'find-missing'],
  ])('%s sets it', (_label, valuesOf, verb) => {
    const values = valuesOf()
    const need = adCallTimeoutNeed(values)
    expect(need).toEqual({ needMs: formulaCeiling(verb, values) + AD_CALL_TIMEOUT_NEED_MARGIN_MS, setBy: { kind: 'verb', verb } })
    expect(need.needMs).toBe(formulaNeed(values))
  })

  test.each(UNUSED_PAUSE_FORMS)('[pause] timeout_seconds %s, read from the file: the unused value sets it, and pause counts without a wait', (_label, pauseTimeout) => {
    const values = acceptedValuesOfFile({ pauseTimeout })
    expect(adCallTimeoutNeed(values)).toEqual({ needMs: formulaNeed(values), setBy: { kind: 'unused-pause-value', found: unusedPauseFound(values) } })
  })
})

// ---------------------------------------------------------------------------
// The startup call-timeout check (SRJ-213: one warning line, never a refusal)
// ---------------------------------------------------------------------------

/** The setting the check sizes, typed against the configuration. */
const CALL_TIMEOUT_SETTING = 'agent_director_call_timeout_ms' satisfies keyof ServerSettings

/** What one check wrote to a capturing log sink, and what it answered. */
interface CheckRun {
  readonly lines: string[]
  readonly returned: string | undefined
}

function runCheck(callTimeoutMs: number, values: AdSettingsInEffect): CheckRun {
  const lines: string[] = []
  const returned = checkAdCallTimeoutAtStartup(callTimeoutMs, { log: (line) => { lines.push(line) }, valuesInEffect: () => values })
  return { lines, returned }
}

/** The ceiling `line` names, as written (`pause`, or `resume/spawn-with-reuse/plain-spawn`), or `undefined` when it names none. */
function namedCeiling(line: string): string | undefined {
  return /\(the (\S+) ceiling plus/.exec(line)?.[1]
}

/** Asserts `run` wrote exactly one line, answered it, and that it names the setting, its value, the need and the runbook; answers the line. */
function oneLine(run: CheckRun, callTimeoutMs: number, needMs: bigint): string {
  expect(run.lines).toHaveLength(1)
  const line = run.lines[0]!
  expect(run.returned).toBe(line)
  expect(line.startsWith(`${AD_SETTINGS_LOG_PREFIX} ${CALL_TIMEOUT_SETTING} is ${callTimeoutMs}`)).toBe(true)
  expect(line).toContain(`${needMs} ms`)
  expect(line).toContain(`"${PHASE1_RUNBOOK_SECTION_TITLE}"`)
  return line
}

/** Asserts `run` wrote exactly one line naming the ceiling `ceiling` and the margin; answers the line. */
function expectVerbLine(run: CheckRun, callTimeoutMs: number, needMs: bigint, ceiling: string): string {
  const line = oneLine(run, callTimeoutMs, needMs)
  expect(namedCeiling(line)).toBe(ceiling)
  expect(line).toContain(`${AD_CALL_TIMEOUT_NEED_MARGIN_MS} ms`)
  return line
}

/** Asserts `run` wrote exactly one line naming the unused pause value and no ceiling. */
function expectUnusedPauseLine(run: CheckRun, callTimeoutMs: number, needMs: bigint, found: string): void {
  const line = oneLine(run, callTimeoutMs, needMs)
  expect(line).toContain(`[${AD_PAUSE_TABLE}] ${AD_PAUSE_TIMEOUT_KEY} holds ${found},`)
  expect(namedCeiling(line)).toBeUndefined()
  expect(CEILING_VERBS.filter((verb) => line.includes(`the ${verb} ceiling`))).toEqual([])
}

/** Runs `body` with `process.exit`, `setTimeout` and `setInterval` spied; answers how often each was called. */
function withExitAndTimersSpied(body: () => void): { exit: number; setTimeout: number; setInterval: number } {
  const exit = spyOn(process, 'exit').mockImplementation((() => undefined) as never)
  const timeout = spyOn(globalThis, 'setTimeout')
  const interval = spyOn(globalThis, 'setInterval')
  try {
    body()
    return { exit: exit.mock.calls.length, setTimeout: timeout.mock.calls.length, setInterval: interval.mock.calls.length }
  } finally {
    for (const spy of [exit, timeout, interval]) spy.mockRestore()
  }
}

describe('ad settings: the startup call-timeout check (b.jg5 SRJ-213)', () => {
  test('at the defaults the imported default gives no line', () => {
    expect(runCheck(DEFAULT_AGENT_DIRECTOR_CALL_TIMEOUT_MS, DEFAULT_AD_SETTINGS_IN_EFFECT)).toEqual({ lines: [], returned: undefined })
  })

  test.each<[string, bigint, boolean]>([
    ['1 ms below the need', -1n, true],
    ['equal to the need', 0n, true],
    ['1 ms above the need', 1n, false],
  ])('at the defaults, a setting %s: one line naming pause, or none above it', (_label, offset, warns) => {
    const { needMs } = adCallTimeoutNeed(DEFAULT_AD_SETTINGS_IN_EFFECT)
    const setting = Number(needMs + offset)
    const run = runCheck(setting, DEFAULT_AD_SETTINGS_IN_EFFECT)
    if (warns) expectVerbLine(run, setting, needMs, 'pause')
    else expect(run).toEqual({ lines: [], returned: undefined })
  })

  test('create_timeout_ms 40000 and pending_grace_seconds 61 with the default setting: one line naming the launch row by all three verbs, never resume alone', () => {
    const values = acceptedValuesOfFile({ tmux: WORKED_TMUX })
    const { needMs, setBy } = adCallTimeoutNeed(values)
    expect(setBy).toEqual({ kind: 'verb', verb: 'resume' })
    expect(BigInt(DEFAULT_AGENT_DIRECTOR_CALL_TIMEOUT_MS) <= needMs).toBe(true)
    const line = expectVerbLine(runCheck(DEFAULT_AGENT_DIRECTOR_CALL_TIMEOUT_MS, values), DEFAULT_AGENT_DIRECTOR_CALL_TIMEOUT_MS, needMs, AD_LAUNCH_CEILING_VERBS.join('/'))
    expect(line).not.toContain('the resume ceiling')
  })

  test.each(UNUSED_PAUSE_FORMS)('[pause] timeout_seconds %s: exactly one line naming the unused value, above the need and at it', (_label, pauseTimeout) => {
    const values = acceptedValuesOfFile({ pauseTimeout })
    const found = unusedPauseFound(values)
    const { needMs } = adCallTimeoutNeed(values)
    expect(BigInt(DEFAULT_AGENT_DIRECTOR_CALL_TIMEOUT_MS) > needMs).toBe(true)
    for (const setting of [DEFAULT_AGENT_DIRECTOR_CALL_TIMEOUT_MS, Number(needMs)]) {
      expectUnusedPauseLine(runCheck(setting, values), setting, needMs, found)
    }
  })

  test.each<[string, AdConfigInput]>([
    ['a line naming a verb', { tmux: WORKED_TMUX }],
    ['a line naming an unused pause value', { pauseTimeout: 0n }],
  ])('%s, on the installed values: nothing thrown, no exit, no value changed, no timer, nothing run at the 120 s ticks', async (_label, initial) => {
    const rig = makeTickRig({ initial })
    const before = adSettingsInEffect()
    const { needMs } = adCallTimeoutNeed(before)
    const pendingBefore = rig.clock.pendingCount()
    const lines: string[] = []
    const calls = withExitAndTimersSpied(() => {
      for (const setting of [DEFAULT_AGENT_DIRECTOR_CALL_TIMEOUT_MS, Number(needMs)]) {
        expect(() => checkAdCallTimeoutAtStartup(setting, { log: (line) => { lines.push(line) } })).not.toThrow()
      }
    })
    expect(calls).toEqual({ exit: 0, setTimeout: 0, setInterval: 0 })
    expect(lines).toHaveLength(2)
    expect(adSettingsInEffect()).toBe(before)
    expect([rig.readCount(), rig.clock.pendingCount()]).toEqual([1, pendingBefore])
    await rig.clock.advance(AD_VERSION_RECHECK_INTERVAL_MS * 2)
    expect(rig.readCount()).toBe(3)
    expect(lines).toHaveLength(2)
    disposeAdVersionRecheck()
  })

  test('a log sink that throws, or values that cannot be read, never make the check throw', () => {
    const { needMs } = adCallTimeoutNeed(DEFAULT_AD_SETTINGS_IN_EFFECT)
    const setting = Number(needMs)
    const expected = runCheck(setting, DEFAULT_AD_SETTINGS_IN_EFFECT)
    expect(expected.lines).toHaveLength(1)
    const throwingLog = { log: () => { throw new Error('stub log sink failure') }, valuesInEffect: () => DEFAULT_AD_SETTINGS_IN_EFFECT }
    expect(checkAdCallTimeoutAtStartup(setting, throwingLog)).toBe(expected.lines[0]!)
    const lines: string[] = []
    const throwingValues = { log: (line: string) => { lines.push(line) }, valuesInEffect: (): AdSettingsInEffect => { throw new Error('stub values failure') } }
    expect(checkAdCallTimeoutAtStartup(setting, throwingValues)).toBeUndefined()
    expect(lines).toEqual([])
  })

  test('a [pause] string value holding a fake token: the line names its kind and holds no token', () => {
    const values = acceptedValuesOfFile({ pauseTimeout: fakeToken(BOT_TOKEN_PREFIX, 'call-timeout') })
    const found = unusedPauseFound(values)
    const run = runCheck(DEFAULT_AGENT_DIRECTOR_CALL_TIMEOUT_MS, values)
    expectUnusedPauseLine(run, DEFAULT_AGENT_DIRECTOR_CALL_TIMEOUT_MS, adCallTimeoutNeed(values).needMs, found)
    assertNoLeak({ run, values })
  })
})

// ---------------------------------------------------------------------------
// SRD pins: SRJ-209's, SRJ-210's and SRJ-213's numbers against the exports
// ---------------------------------------------------------------------------

/** One fresh read of a file with `tmux`, under a new temp HOME: its outcome's kind. */
function readKindOf(tmux: Readonly<Partial<Record<AdTmuxKey, AdConfigValue>>>): string {
  const rig = makeReaderRig()
  rig.write({ tmux })
  return rig.read().kind
}

/** The ceilings at the defaults. */
const defaultCeilings = (): ReturnType<typeof adVerbCeilingsMs> => adVerbCeilingsMs(DEFAULT_AD_SETTINGS_IN_EFFECT)

describe('ad settings: SRD pins (b.jg5 SRJ-209, SRJ-210, SRJ-213)', () => {
  test.each<[string, () => unknown, unknown]>([
    ['the settings file path', () => AD_SETTINGS_RELATIVE_PATH, join('.agent-director', 'config.toml')],
    [
      'the nine [tmux] keys and their defaults',
      () => DEFAULT_AD_SETTINGS.tmux,
      {
        pending_grace_seconds: 60n,
        stopping_window_seconds: 90n,
        starting_session_seconds: 300n,
        sweep_budget_seconds: 15n,
        query_timeout_ms: 1500n,
        action_timeout_ms: 2000n,
        create_timeout_ms: 5000n,
        pipe_close_wait_ms: 100n,
        kill_exit_wait_ms: 5000n,
      },
    ],
    ['[pause] timeout_seconds default', () => DEFAULT_AD_SETTINGS.pause.timeout_seconds, 30n],
    ['starting_session_seconds minimum', () => AD_SETTING_MINIMUMS.starting_session_seconds, 60n],
    ['stopping_window_seconds minimum', () => AD_SETTING_MINIMUMS.stopping_window_seconds, 30n],
    ['pending_grace_seconds minimum: floor and addend', () => AD_SETTING_MINIMUMS.pending_grace_seconds, { floor: 30n, addend: 20n }],
    ['pending_grace_seconds minimum at the default timers', () => pendingGraceMinimumSeconds(5000n, 100n), 30n],
    ['pending_grace_seconds minimum with create_timeout_ms 40000', () => pendingGraceMinimumSeconds(40000n, 100n), 61n],
    ['stopping_window_seconds 10 is refused', () => readKindOf({ stopping_window_seconds: 10n }), 'refused'],
    ['starting_session_seconds 30 is refused', () => readKindOf({ starting_session_seconds: 30n }), 'refused'],
    ['create_timeout_ms 40000 with pending_grace_seconds 60 is refused', () => readKindOf({ create_timeout_ms: 40000n, pending_grace_seconds: 60n }), 'refused'],
    ['create_timeout_ms 40000 with pending_grace_seconds missing is refused', () => readKindOf({ create_timeout_ms: 40000n }), 'refused'],
    ['create_timeout_ms 40000 with pending_grace_seconds 0 is refused', () => readKindOf({ create_timeout_ms: 40000n, pending_grace_seconds: 0n }), 'refused'],
    ['create_timeout_ms 40000 with pending_grace_seconds 61 is accepted', () => readKindOf({ create_timeout_ms: 40000n, pending_grace_seconds: 61n }), 'accepted'],
    ['60.0 (a float) is refused', () => readKindOf({ pending_grace_seconds: 60 }), 'refused'],
    ['the largest setting integer: 2^63 - 1, the top of Go int64', () => AD_SETTING_INTEGER_MAX, 9223372036854775807n],
    ['sweep_budget_seconds 9223372036854775807 is accepted', () => readKindOf({ sweep_budget_seconds: 9223372036854775807n }), 'accepted'],
    ['sweep_budget_seconds 9223372036854775808 is refused', () => readKindOf({ sweep_budget_seconds: 9223372036854775808n }), 'refused'],
    ['the alert threshold addend', () => AD_ALERT_THRESHOLD_ADDEND_SECONDS, 60n],
    ["B's addend over G", () => AD_LAUNCH_BOUND_GRACE_ADDEND_SECONDS, 60n],
    ["the dialog approver's cap, B's floor", () => DIALOG_READY_TIMEOUT_MS, 300_000],
    ['G, the threshold and B at the defaults: 60 s, 360 s, 300 s', () => derivedWaits(acceptedValuesOf({})), { grace: 60_000, threshold: 360_000, bound: 300_000 }],
    [
      'G, the threshold and B with 120 / 30 / 120: 120 s, 180 s, 300 s',
      () => derivedWaits(acceptedValuesOf({ pending_grace_seconds: 120n, stopping_window_seconds: 30n, starting_session_seconds: 120n })),
      { grace: 120_000, threshold: 180_000, bound: 300_000 },
    ],
    ['B with pending_grace_seconds 300: 360 s', () => adLaunchBoundMs(acceptedValuesOf({ pending_grace_seconds: 300n })), 360_000],
    ['the threshold at the defaults in whole minutes', () => wholeMinutes(adAlertThresholdMs(DEFAULT_AD_SETTINGS_IN_EFFECT)), 6],
    ['B at the defaults in whole minutes', () => wholeMinutes(adLaunchBoundMs(DEFAULT_AD_SETTINGS_IN_EFFECT)), 5],
    ['359 s in whole minutes', () => wholeMinutes(359_000), 5],
    ['180 s in whole minutes', () => wholeMinutes(180_000), 3],
    ['59.999 s in whole minutes', () => wholeMinutes(59_999), 0],
    ['the kill ceiling at the defaults: 12.4 s', () => defaultCeilings().kill, 12_400n],
    ['the read-pane ceiling at the defaults: 6.9 s', () => defaultCeilings()['read-pane'], 6_900n],
    ['the send-keys ceiling at the defaults: 9 s', () => defaultCeilings()['send-keys'], 9_000n],
    ['the pause ceiling at the defaults: 9 s plus 30 s', () => defaultCeilings().pause, 39_000n],
    [
      'the resume, reuse and plain-spawn ceiling at the defaults: 10.9 s',
      () => [defaultCeilings().resume, defaultCeilings()['spawn-with-reuse'], defaultCeilings()['plain-spawn']],
      [10_900n, 10_900n, 10_900n],
    ],
    ['the find-missing and expire ceiling at the defaults: 16.6 s', () => [defaultCeilings()['find-missing'], defaultCeilings().expire], [16_600n, 16_600n]],
    ["the need's margin: 15 s", () => AD_CALL_TIMEOUT_NEED_MARGIN_MS, 15_000n],
    ['the need at the defaults: 54 s, set by pause', () => adCallTimeoutNeed(DEFAULT_AD_SETTINGS_IN_EFFECT), { needMs: 54_000n, setBy: { kind: 'verb', verb: 'pause' } }],
    [
      'the need with create_timeout_ms 40000 and pending_grace_seconds 61: 60.9 s, set by the launch ceiling (resume)',
      () => adCallTimeoutNeed(acceptedValuesOfFile({ tmux: { create_timeout_ms: 40000n, pending_grace_seconds: 61n } })),
      { needMs: 60_900n, setBy: { kind: 'verb', verb: 'resume' } },
    ],
    [
      'the need with [pause] timeout_seconds 60: 84 s, set by pause',
      () => adCallTimeoutNeed(acceptedValuesOfFile({ pauseTimeout: 60n })),
      { needMs: 84_000n, setBy: { kind: 'verb', verb: 'pause' } },
    ],
  ])('%s', (_label, actual, expected) => {
    expect(actual()).toEqual(expected)
  })
})
