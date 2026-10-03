/**
 * startup-errors.test.ts — `recordStartupError`'s `omitStderr` option
 * (`src/startup-errors.ts`; b.jg5 SRJ-909: the CLI records its teardown
 * entries without the fd-2 copy, so each line reaches the terminal once).
 *
 * Each call runs in a child `bun` process (`runInFakeHome`), so everything the
 * call writes to fd 2 is captured whole, however it is written. The child's
 * HOME, state directory and `logDir` are the case's own `mkdtempSync` tree,
 * and the case checks that nothing else was written there.
 *
 * SPDX-License-Identifier: MIT
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { CLI_TEARDOWN_FAILED_LABEL } from '../src/cli-teardown.ts'
import type { StartupErrorOptions } from '../src/startup-errors.ts'
import { assertNoLeak } from './test-helpers/credentials.ts'
import { runInFakeHome } from './test-helpers/fake-home-subprocess.ts'

/** The module under test, by absolute path, for the child to import. */
const STARTUP_ERRORS_SRC = resolve(import.meta.dir, '..', 'src', 'startup-errors.ts')

/** The log file's name inside its directory. */
const LOG_NAME = 'startup-errors.log'

/** An entry message spread over lines, as a failure line followed by an alert is. */
const MESSAGE = 'first line\nsecond line\r\nthird line\rfourth line'

/** `MESSAGE` as the entry carries it: one line. */
const FLAT_MESSAGE = 'first line second line third line fourth line'

let root: string
let home: string
let stateDir: string
let logDir: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'startup-errors-test-'))
  home = join(root, 'home')
  stateDir = join(root, 'state')
  logDir = join(root, 'log')
  mkdirSync(home)
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

/** Run `recordStartupError(CLI_TEARDOWN_FAILED_LABEL, MESSAGE, undefined, options)` in a child; its fd 2 and stdout. */
function record(options: StartupErrorOptions): { stderr: string; stdout: string } {
  const res = runInFakeHome({
    modulePath: STARTUP_ERRORS_SRC,
    call: 'mod.recordStartupError(input.classLabel, input.message, undefined, input.options)',
    input: { classLabel: CLI_TEARDOWN_FAILED_LABEL, message: MESSAGE, options },
    home,
    stateDir,
  })
  expect(res.observedHomedir).toBe(home)
  expect(res.status).toBe(0)
  return { stderr: res.stderr, stdout: res.stdout }
}

/** The lines of `text`, empty ones dropped. */
function linesOf(text: string): string[] {
  return text.split('\n').filter((line) => line.length > 0)
}

/** Fails unless `line` is the one entry: a timestamp, the class in brackets, then the flattened message. */
function expectEntry(line: string | undefined): void {
  expect(line).toMatch(/^\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\] /)
  expect(line!.slice(line!.indexOf('] ') + 2)).toBe(`[${CLI_TEARDOWN_FAILED_LABEL}] ${FLAT_MESSAGE}`)
}

/** Fails unless the case's tree holds nothing but the log directory's one file and the empty home (the child runtime's cache aside). */
function expectNoStrayWrite(): void {
  expect(readdirSync(root).sort()).toEqual(['home', 'log'])
  expect(readdirSync(logDir)).toEqual([LOG_NAME])
  expect(readdirSync(home).filter((e) => e !== '.bun')).toEqual([])
  expect(existsSync(stateDir)).toBe(false)
}

describe("recordStartupError's omitStderr option (b.jg5 SRJ-909)", () => {
  test('with omitStderr: one one-line entry under the given class in logDir, and nothing on fd 2', () => {
    const { stderr, stdout } = record({ logDir, omitStderr: true })
    const logged = linesOf(readFileSync(join(logDir, LOG_NAME), 'utf-8'))

    expect(stderr).toBe('')
    expect(logged).toHaveLength(1)
    expectEntry(logged[0])
    expectNoStrayWrite()
    assertNoLeak({ stderr, stdout, logged })
  })

  test.each<[string, boolean | undefined]>([
    ['omitStderr unset', undefined],
    ['omitStderr false', false],
  ])('with %s: the same one-line entry in logDir and on fd 2, as before', (_label, omitStderr) => {
    const { stderr, stdout } = record(omitStderr === undefined ? { logDir } : { logDir, omitStderr })
    const logged = linesOf(readFileSync(join(logDir, LOG_NAME), 'utf-8'))

    expect(logged).toHaveLength(1)
    expectEntry(logged[0])
    expect(linesOf(stderr)).toEqual(logged)
    expectNoStrayWrite()
    assertNoLeak({ stderr, stdout, logged })
  })

  test('with omitStderr and a logDir that cannot be made: no entry anywhere, and the one-line disk-failure warning still on fd 2', () => {
    const blocker = join(root, 'blocker')
    writeFileSync(blocker, '')
    const { stderr, stdout } = record({ logDir: join(blocker, 'log'), omitStderr: true })

    const warnings = linesOf(stderr)
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain(join(blocker, 'log', LOG_NAME))
    expect(warnings[0]).not.toContain(FLAT_MESSAGE)
    expect(readFileSync(blocker, 'utf-8')).toBe('')
    expect(readdirSync(root).sort()).toEqual(['blocker', 'home'])
    assertNoLeak({ stderr, stdout })
  })
})
