/**
 * pane-read.test.ts — the outcome of one `read-pane` of a persona's own row
 * and its class mapper (`src/pane-read.ts`; b.jg5 SRJ-117 over SRJ-104's
 * classes), and the full-read line count the session manager's reads use.
 *
 * One row per value S1 names, each mapped to exactly one outcome by class
 * and by name through `src/ad-error-class.ts`. Every value is built with the
 * stub's builders. Phase-1-only and store-open names come from
 * `src/agent-director-errors.ts` as strings. Kinds, class labels and the line count are
 * imported from `src/`; the line count and the class note are pinned once
 * as literals.
 *
 * Pure: no client, no process, no real timer, no top-level mock.module(), no
 * value import of `Client` or `resolveSystemBinary`.
 *
 * SPDX-License-Identifier: MIT
 */

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  AD_ERROR_CLASS_CONFIG,
  AD_ERROR_CLASS_CONFLICT,
  AD_ERROR_CLASS_DIRECTORY,
  AD_ERROR_CLASS_ENVIRONMENT,
  AD_ERROR_CLASS_GONE,
  AD_ERROR_CLASS_LAUNCH_FAILURE,
  AD_ERROR_CLASS_STATE,
  AD_ERROR_CLASS_UNAVAILABLE,
  AD_ERROR_CLASS_UNCLASSIFIED,
  AD_ERROR_CLASS_UNUSABLE_NAME,
  describeAdFailureForLog,
  type AdErrorClass,
} from '../src/ad-error-class.ts'
import { UNUSABLE_RECORDED_NAME_PHRASE } from '../src/ad-description-phrases.ts'
import {
  ERR_SCHEMA_MIGRATION_REQUIRED_NAME,
  ERR_STORE_OPEN_NAME,
  PHASE1_ONLY_ERR_NAMES,
} from '../src/agent-director-errors.ts'
import {
  FULL_PANE_READ_LINES,
  PANE_READ_ABSENT,
  PANE_READ_CONFIG,
  PANE_READ_CONFLICT,
  PANE_READ_ENVIRONMENT,
  PANE_READ_FAILURE_KINDS,
  PANE_READ_GONE,
  PANE_READ_LATCHED,
  PANE_READ_NOT_READ_LATCHED,
  PANE_READ_PANE,
  PANE_READ_UNAVAILABLE,
  PANE_READ_UNCLASSIFIED,
  PANE_READ_UNUSABLE_NAME,
  paneReadClassNote,
  paneReadFailureOf,
  type PaneReadConflict,
  type PaneReadFailureKind,
  type PaneReadOutcome,
} from '../src/pane-read.ts'
import {
  CONFLICT_CASES,
  STUB_TMUX_SOCKET_PATH,
  UNAVAILABLE_FORMS,
  UNUSABLE_NAME_FAULTS,
  errConfigMalformed,
  errCwdNotFound,
  errInternal,
  errJsonlMissing,
  errRelayModeOff,
  errSchemaMismatch,
  errSpawnNotFound,
  errSpawnNotInteractive,
  errSystemInstallDisappeared,
  errTmuxCaptureFailed,
  errTmuxNotAvailable,
  errTmuxNotAvailableDifferentServer,
  errTmuxSessionConflict,
  errTmuxSessionCreate,
  errTmuxUnresponsive,
  errUnknownErrorName,
  errUnusableName,
} from './test-helpers/agent-director-stub.ts'
import { assertNoLeak, LEAK_SENTINEL, REDACTED_SENTINEL_TAIL, sentinelInMessage } from './test-helpers/credentials.ts'
import { importSource, stripComments } from './test-helpers/source-audit.ts'

const VERB = 'read-pane'

/** One value a `read-pane` can throw: its label, its builder, and the outcome kind and class it maps to. */
type Row = readonly [label: string, make: () => unknown, kind: PaneReadFailureKind, errorClass: AdErrorClass]

const ROWS: readonly Row[] = [
  ['ErrTmuxCaptureFailed', () => errTmuxCaptureFailed(), PANE_READ_GONE, AD_ERROR_CLASS_GONE],
  ['ErrSpawnNotFound', () => errSpawnNotFound(), PANE_READ_ABSENT, AD_ERROR_CLASS_STATE],
  ...CONFLICT_CASES.map((c): Row => [`ErrTmuxSessionConflict (${c})`, () => errTmuxSessionConflict(VERB, c), PANE_READ_CONFLICT, AD_ERROR_CLASS_CONFLICT]),
  ...UNUSABLE_NAME_FAULTS.map((f): Row => [`the unusable-name ErrInternal (${f})`, () => errUnusableName(f), PANE_READ_UNUSABLE_NAME, AD_ERROR_CLASS_UNUSABLE_NAME]),
  ['ErrConfigMalformed', () => errConfigMalformed(), PANE_READ_CONFIG, AD_ERROR_CLASS_CONFIG],
  ['ErrTmuxNotAvailable, tmux not runnable', () => errTmuxNotAvailable(undefined, VERB), PANE_READ_ENVIRONMENT, AD_ERROR_CLASS_ENVIRONMENT],
  ['ErrTmuxNotAvailable, socket not accessible', () => errTmuxNotAvailable(STUB_TMUX_SOCKET_PATH, VERB), PANE_READ_ENVIRONMENT, AD_ERROR_CLASS_ENVIRONMENT],
  ['ErrTmuxNotAvailable, a different tmux server', () => errTmuxNotAvailableDifferentServer(STUB_TMUX_SOCKET_PATH, VERB), PANE_READ_ENVIRONMENT, AD_ERROR_CLASS_ENVIRONMENT],
  ...UNAVAILABLE_FORMS.map(([label, make]): Row => [label, () => make(VERB), PANE_READ_UNAVAILABLE, AD_ERROR_CLASS_UNAVAILABLE]),
  // A Phase-1-only name carried by ErrUnknownErrorName is a later name, never its own class (SRJ-104).
  ...PHASE1_ONLY_ERR_NAMES.map((name): Row => [`ErrUnknownErrorName carrying ${name}`, () => errUnknownErrorName(name), PANE_READ_UNAVAILABLE, AD_ERROR_CLASS_UNAVAILABLE]),
  ['a thrown non-error value', () => 'boom', PANE_READ_UNAVAILABLE, AD_ERROR_CLASS_UNAVAILABLE],
  ['ErrInternal without the unusable-name phrase', () => errInternal(), PANE_READ_UNCLASSIFIED, AD_ERROR_CLASS_UNCLASSIFIED],
  ['ErrSchemaMismatch', () => errSchemaMismatch(), PANE_READ_UNCLASSIFIED, AD_ERROR_CLASS_UNCLASSIFIED],
  ...[ERR_SCHEMA_MIGRATION_REQUIRED_NAME, ERR_STORE_OPEN_NAME].map((name): Row => [name, () => errUnknownErrorName(name), PANE_READ_UNCLASSIFIED, AD_ERROR_CLASS_UNCLASSIFIED]),
  ['ErrSystemInstallDisappeared', () => errSystemInstallDisappeared(VERB), PANE_READ_UNCLASSIFIED, AD_ERROR_CLASS_UNCLASSIFIED],
  ['ErrSpawnNotInteractive (a STATE name other than ErrSpawnNotFound)', () => errSpawnNotInteractive(VERB), PANE_READ_UNCLASSIFIED, AD_ERROR_CLASS_STATE],
  ['ErrTmuxSessionCreate (LAUNCH FAILURE)', () => errTmuxSessionCreate(VERB), PANE_READ_UNCLASSIFIED, AD_ERROR_CLASS_LAUNCH_FAILURE],
  ['ErrCwdNotFound (DIRECTORY)', () => errCwdNotFound(VERB), PANE_READ_UNCLASSIFIED, AD_ERROR_CLASS_DIRECTORY],
  ['ErrRelayModeOff (a name CSCB gives no handling)', () => errRelayModeOff(), PANE_READ_UNCLASSIFIED, AD_ERROR_CLASS_UNCLASSIFIED],
]

/** The kinds whose outcome keeps the thrown value so the caller can latch. */
const KEEPS_ERROR: ReadonlySet<PaneReadFailureKind> = new Set([PANE_READ_CONFLICT, PANE_READ_UNUSABLE_NAME])

describe('paneReadFailureOf: each value a read-pane throws maps to exactly one outcome (b.jg5 SRJ-117, SRJ-104)', () => {
  test.each(ROWS)('%s → its kind and class, the described failure on one line', (_label, make, kind, errorClass) => {
    const value = make()
    const outcome = paneReadFailureOf(value)
    expect([outcome.kind, outcome.errorClass]).toEqual([kind, errorClass])
    expect(outcome.description).toBe(describeAdFailureForLog(value))
    expect(outcome.description.includes('\n')).toBe(false)
    if (KEEPS_ERROR.has(kind)) expect('error' in outcome && outcome.error).toBe(value)
    else expect('error' in outcome).toBe(false)
    assertNoLeak(outcome.description)
  })

  test('the rows reach every failure kind, and the kinds are distinct from each other and from a pane or a latch (GONE is not absent; CONFIG is not GONE)', () => {
    expect(new Set(ROWS.map(([, , kind]) => kind))).toEqual(new Set(PANE_READ_FAILURE_KINDS))
    const kinds = new Set<string>([...PANE_READ_FAILURE_KINDS, PANE_READ_PANE, PANE_READ_LATCHED])
    expect(kinds.size).toBe(PANE_READ_FAILURE_KINDS.length + 2)
  })

  test.each([ERR_SCHEMA_MIGRATION_REQUIRED_NAME, ERR_STORE_OPEN_NAME])('ErrUnknownErrorName carrying %s: the description names the reported name, never the client\'s placeholder (b.jg5 SRJ-104)', (name) => {
    const value = errUnknownErrorName(name)
    const outcome = paneReadFailureOf(value)
    expect(outcome.description.startsWith(`${name} `)).toBe(true)
    expect(outcome.description).not.toContain(value.errName)
  })

  test('an agent-director error whose every property read throws maps as one with no name (UNCLASSIFIED) without throwing', () => {
    const hostile = new Proxy(errTmuxCaptureFailed(), {
      get() {
        throw new Error('hostile read')
      },
    })
    const outcome = paneReadFailureOf(hostile)
    expect([outcome.kind, outcome.errorClass]).toEqual([PANE_READ_UNCLASSIFIED, AD_ERROR_CLASS_UNCLASSIFIED])
    expect(typeof outcome.description).toBe('string')
  })
})

/** One sentinel-bearing value per kind whose own description is rendered, built as the failure's text would carry a secret. */
const SENTINEL_ROWS: readonly (readonly [label: string, make: (secret: string) => unknown, kind: PaneReadFailureKind])[] = [
  ['GONE', (secret) => errTmuxCaptureFailed(secret), PANE_READ_GONE],
  ['CONFLICT', (secret) => errTmuxSessionConflict(VERB, 'pane-not-found', secret), PANE_READ_CONFLICT],
  ['UNAVAILABLE', (secret) => errTmuxUnresponsive(VERB, secret), PANE_READ_UNAVAILABLE],
  ['UNAVAILABLE, not an agent-director error', (secret) => new Error(secret), PANE_READ_UNAVAILABLE],
  ['UNCLASSIFIED', (secret) => errJsonlMissing(secret), PANE_READ_UNCLASSIFIED],
]

describe('a failure outcome\'s description is redacted and on one line', () => {
  test.each(SENTINEL_ROWS)('%s: the secret renders redacted, on one line, and no other property reaches the description', (_label, make, kind) => {
    const value = Object.assign(make(`read failed (${sentinelInMessage('pane')})\nsecond line`) as object, { note: LEAK_SENTINEL })
    const outcome = paneReadFailureOf(value)
    expect(outcome.kind).toBe(kind)
    expect(outcome.description).toContain(REDACTED_SENTINEL_TAIL)
    expect(outcome.description.includes('\n')).toBe(false)
    assertNoLeak(outcome.description)
  })

  test('the unusable-name answer\'s description holds no secret its envelope carries', () => {
    const outcome = paneReadFailureOf(errInternal(`${UNUSABLE_RECORDED_NAME_PHRASE} is empty (${sentinelInMessage('name')})`))
    expect(outcome.kind).toBe(PANE_READ_UNUSABLE_NAME)
    assertNoLeak(outcome.description)
  })
})

describe('outcomes that are not failures', () => {
  test.each<[string, PaneReadOutcome]>([
    ['a pane', { kind: PANE_READ_PANE, pane: '' }],
    ['latched, not read', PANE_READ_NOT_READ_LATCHED],
    ['latched by its CONFLICT', { kind: PANE_READ_LATCHED, cause: paneReadFailureOf(errTmuxSessionConflict(VERB, 'own-id')) as PaneReadConflict }],
  ])('%s is of no failure kind', (_label, outcome) => {
    expect((PANE_READ_FAILURE_KINDS as readonly string[]).includes(outcome.kind)).toBe(false)
  })

  test('the not-read latched outcome carries no cause and is frozen', () => {
    expect(PANE_READ_NOT_READ_LATCHED).toEqual({ kind: PANE_READ_LATCHED })
    expect(Object.isFrozen(PANE_READ_NOT_READ_LATCHED)).toBe(true)
  })
})

// The pins: the session manager's and the server's tests build the full-read
// count and every failed read's `(read-pane class=<CLASS>; ` from these exports.
describe('the full-read line count and the class note', () => {
  test('a full read asks for the last 40 lines', () => {
    expect(FULL_PANE_READ_LINES).toBe(40)
  })

  test('paneReadClassNote names the verb and the failure\'s class', () => {
    expect(paneReadClassNote(paneReadFailureOf(errTmuxCaptureFailed()))).toBe('read-pane class=GONE')
  })
})

describe('src/pane-read.ts source audit', () => {
  const raw = readFileSync(join(import.meta.dir, '..', 'src', 'pane-read.ts'), 'utf8')
  const code = stripComments(raw)

  test('no class is decided by instanceof, and the class comes from the classifier', () => {
    expect(code.match(/\binstanceof\b/g)).toBeNull()
    expect(importSource(code, 'classifyAdError')).toBe('./ad-error-class.ts')
  })

  test('no Phase-1-only error class is named in code, and nothing is imported from agent-director itself or from a module that calls it', () => {
    expect(PHASE1_ONLY_ERR_NAMES.filter((name) => new RegExp(`\\b${name}\\b`).test(code))).toEqual([])
    const sources = [...code.matchAll(/\bfrom\s*(['"])([^'"]+)\1/g)].map((m) => m[2])
    expect(new Set(sources)).toEqual(new Set(['./ad-error-class.ts', './agent-director-errors.ts']))
  })

  test('the module, comments included, holds no ad_pane string', () => {
    expect(raw.includes('ad_pane')).toBe(false)
  })
})
