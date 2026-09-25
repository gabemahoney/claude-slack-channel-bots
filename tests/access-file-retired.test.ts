/**
 * access-file-retired.test.ts — Regression guard for the retired access.json
 * model (b.av2 SR-10.1, SR-10.2 access rows; AC 17).
 *
 * The server no longer reads or writes `access.json`, and there is no
 * allowlist, pairing or `SLACK_ACCESS_MODE` static mode. This guard keeps them
 * from coming back:
 *
 *   1. No `.ts` file under src/ names any of the retired terms.
 *   2. No file under skills/ names any of them.
 *   3. The old config skill (skills/claude-slack-channels-config) is gone and
 *      the debugging skill (skills/debug-slack-channel-bots/SKILL.md) that
 *      replaced it exists.
 *
 * It reads repository files only and writes nothing. A failure lists every
 * offending `file:line` for the term named in the test title.
 *
 * SPDX-License-Identifier: MIT
 */

import { describe, expect, test } from 'bun:test'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'

const REPO_ROOT = resolve(import.meta.dir, '..')

/**
 * The retired terms, matched case-insensitively, so every spelling
 * (`Pairing`, `PAIRING_CODE`, `dmPairing`) matches.
 */
const RETIRED_TERMS: [string, RegExp][] = [
  ['access.json', /access\.json/i],
  ['allowFrom', /allowFrom/i],
  ['pairing', /pairing/i],
  ['SLACK_ACCESS_MODE', /SLACK_ACCESS_MODE/i],
]

/** Every file under the repo-relative `dir`, recursively, as repo-relative paths. */
function filesUnder(dir: string): string[] {
  const walk = (abs: string): string[] =>
    readdirSync(abs)
      .sort()
      .flatMap((entry) => {
        const path = join(abs, entry)
        return statSync(path).isDirectory() ? walk(path) : [path]
      })
  return walk(join(REPO_ROOT, dir)).map((abs) => relative(REPO_ROOT, abs).split(sep).join('/'))
}

const SCOPES: [string, string[]][] = [
  ['src/ (.ts files)', filesUnder('src').filter((file) => file.endsWith('.ts'))],
  ['skills/ (every file)', filesUnder('skills')],
]

/** `file:line` for every line of each file in `files` that matches `re`. */
function hitsOf(files: string[], re: RegExp): string[] {
  return files.flatMap((file) =>
    readFileSync(join(REPO_ROOT, file), 'utf-8')
      .split('\n')
      .flatMap((text, i) => (re.test(text) ? [`${file}:${i + 1}`] : [])),
  )
}

describe('retired access terms stay out of src/ and skills/', () => {
  test('both scopes hold files to audit', () => {
    for (const [, files] of SCOPES) expect(files.length).toBeGreaterThan(0)
  })

  for (const [scope, files] of SCOPES) {
    test.each(RETIRED_TERMS)(`no file in ${scope} names %s`, (_term, re) => {
      expect(hitsOf(files, re)).toEqual([])
    })
  }
})

describe('the config skill is replaced by the debugging skill', () => {
  test('skills/claude-slack-channels-config does not exist', () => {
    expect(existsSync(join(REPO_ROOT, 'skills/claude-slack-channels-config'))).toBe(false)
  })

  test('skills/debug-slack-channel-bots/SKILL.md exists', () => {
    expect(existsSync(join(REPO_ROOT, 'skills/debug-slack-channel-bots/SKILL.md'))).toBe(true)
  })
})
