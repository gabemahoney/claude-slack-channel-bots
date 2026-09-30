/**
 * ad-settings.test.ts — agent-director's timing settings, read the way
 * agent-director reads them (b.jg5 SRJ-209, AC 80): the read with
 * agent-director's rule (the 64-bit bound, strict UTF-8 and a home getter
 * that throws included), the values in effect, `[pause] timeout_seconds`, the
 * one line per run of refused reads, the install and its re-read at the
 * version re-check's 120 s ticks (b.jg5 SRJ-204), and source audits of the
 * settings module.
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

import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'

import {
  AD_SETTING_INTEGER_MAX,
  AD_SETTINGS_LOG_PREFIX,
  AD_SETTINGS_RELATIVE_PATH,
  AD_TMUX_KEYS,
  AD_TMUX_TABLE,
  adSettingsInEffect,
  buildAdSettingsRefusedReadLine,
  createAdSettingsReader,
  DEFAULT_AD_SETTINGS_IN_EFFECT,
  installAdSettings,
  pendingGraceMinimumSeconds,
  resetAdSettingsForTests,
  type AdSettingsInEffect,
  type AdSettingsReader,
  type AdSettingsReadOutcome,
  type AdTmuxKey,
  type AdTmuxValues,
} from '../src/ad-settings.ts'
import {
  AD_VERSION_RECHECK_INTERVAL_MS,
  disposeAdVersionRecheck,
  installAdVersionRecheck,
  resetAdVersionRecheckForTests,
} from '../src/ad-version-gate.ts'
import { MAX_RELOAD_FILE_BYTES, type PersonaConfigFs } from '../src/config.ts'
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
import { stripComments } from './test-helpers/source-audit.ts'

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
    if (form.key !== undefined) {
      expect(reason).toContain(form.key)
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

  test.each<[string, Partial<PersonaConfigFs>, string | undefined]>([
    ['a directory', { fstatFile: () => ({ isFile: () => false, isDirectory: () => true }) }, undefined],
    ['a non-regular file', { fstatFile: () => ({ isFile: () => false, isDirectory: () => false }) }, undefined],
    ['a file over the size cap', { fstatFile: () => ({ isFile: () => true, isDirectory: () => false, size: MAX_RELOAD_FILE_BYTES + 1 }) }, undefined],
    ['a permission error', { openFile: () => { throw errnoError('EACCES') } }, undefined],
    ['a path component that is not a directory', { openFile: () => { throw errnoError('ENOTDIR') } }, undefined],
    ['an I/O error on the read', { readFileFd: () => { throw errnoError('EIO') } }, undefined],
    ['bytes that are not valid UTF-8, in a TOML comment', { readFileFd: () => NOT_UTF8_COMMENT_BYTES }, 'it is not valid UTF-8'],
  ])('%s is refused: the defaults stay, one line, no error text', (_label, overrides, expectedReason) => {
    const rig = makeReaderRig(stubFs(overrides))
    const outcome = rig.read()
    const reason = refusedReason(outcome)
    if (expectedReason !== undefined) expect(reason).toBe(expectedReason)
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
  test.each<[string, AdConfigInput]>([
    ['text that is not TOML, a fake token on its offending line', { notToml: true, embed: fakeToken(BOT_TOKEN_PREFIX, 'toml') }],
    ['a [tmux] string value holding a fake token', { tmux: { query_timeout_ms: fakeToken(BOT_TOKEN_PREFIX, 'tmux') } }],
    ['a [pause] string value holding a fake token', { pauseTimeout: fakeToken(BOT_TOKEN_PREFIX, 'pause') }],
  ])('%s', (_label, input) => {
    const rig = makeReaderRig()
    rig.write(input)
    const outcome = rig.read()
    assertNoLeak({ lines: rig.lines, outcome, values: rig.reader.valuesInEffect() })
  })
})

// ---------------------------------------------------------------------------
// Source audits (SRJ-209: one parser, one settings module, no outage path)
// ---------------------------------------------------------------------------

const SRC_DIR = join(import.meta.dir, '..', 'src')
const SETTINGS_MODULE = 'ad-settings.ts'

/** Every `src/` module's comment-stripped code, by file name. */
function srcModules(): Map<string, string> {
  const modules = new Map<string, string>()
  for (const name of readdirSync(SRC_DIR).filter((n) => n.endsWith('.ts')).sort()) {
    modules.set(name, stripComments(readFileSync(join(SRC_DIR, name), 'utf-8')))
  }
  return modules
}

/** The module specifiers `code` imports or re-exports, static or dynamic. */
function importedSpecifiers(code: string): string[] {
  const patterns = [/\bfrom\s*['"]([^'"]+)['"]/g, /\bimport\s*['"]([^'"]+)['"]/g, /\bimport\s*\(\s*['"]([^'"]+)['"]/g, /\brequire\s*\(\s*['"]([^'"]+)['"]/g]
  return patterns.flatMap((re) => [...code.matchAll(re)].map((m) => m[1]!))
}

describe('ad settings: source audits', () => {
  test('smol-toml is imported by the settings module and by no other src/ module', () => {
    const importers = [...srcModules()].filter(([, code]) => importedSpecifiers(code).includes('smol-toml')).map(([name]) => name)
    expect(importers).toEqual([SETTINGS_MODULE])
  })

  test('the settings module imports neither the agent-director package nor the client, outage-state, notifier or Slack modules', () => {
    const specifiers = importedSpecifiers(srcModules().get(SETTINGS_MODULE)!)
    expect(specifiers.length).toBeGreaterThan(0)
    const forbidden = specifiers.filter(
      (s) =>
        s === 'agent-director' ||
        s.startsWith('agent-director/') ||
        /agent-director-client|outage-state|notifier|slack/i.test(s),
    )
    expect(forbidden).toEqual([])
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
// SRD pins: SRJ-209's numbers against the exports (T2 adds SRJ-210's rows here)
// ---------------------------------------------------------------------------

/** One fresh read of a file with `tmux`, under a new temp HOME: its outcome's kind. */
function readKindOf(tmux: Readonly<Partial<Record<AdTmuxKey, AdConfigValue>>>): string {
  const rig = makeReaderRig()
  rig.write({ tmux })
  return rig.read().kind
}

describe('ad settings: SRD pins (b.jg5 SRJ-209)', () => {
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
  ])('%s', (_label, actual, expected) => {
    expect(actual()).toEqual(expected)
  })
})
