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
 *   4. The release tooling (the promote script, its skill and the registry
 *      install runbook) no longer expects `access.json` (SR-12).
 *   5. The internal docs (engineering guide, architecture) name none of the
 *      retired access terms, and `access.json` only in the one allowed note
 *      that a leftover file is ignored and left in place (SR-12).
 *   6. README's Release section does not mention `access.json`. The rest of
 *      README is audited by tests/shipped-docs.test.ts.
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

const ACCESS_JSON = /access\.json/i

describe('the release tooling no longer expects access.json', () => {
  test.each([
    'scripts/publish-promote.sh',
    '.claude/skills/publish-promote/SKILL.md',
    'docs/registry-install-runbook.md',
  ])('%s names no access.json', (file) => {
    expect(hitsOf([file], ACCESS_JSON)).toEqual([])
  })
})

const INTERNAL_DOCS = ['docs/engineering-guide.md', 'docs/architecture.md']

/**
 * Terms the internal docs must not name at all, case-insensitively. They avoid
 * "pairing" even in a negation, so no exception is needed for it. `gate(` is
 * anchored at a word start so `runAgentDirectorStartupGate()` does not match,
 * and matches any argument list (`gate()`, `gate(event)`).
 */
const INTERNAL_DOC_TERMS: [string, RegExp][] = [
  ['allowFrom', /allowFrom/i],
  ['dmPolicy', /dmPolicy/i],
  ['SLACK_ACCESS_MODE', /SLACK_ACCESS_MODE/i],
  ['gate()', /\bgate\(/i],
  ['pairing', /pairing/i],
]

/** The one allowed statement about a leftover `access.json`, verbatim. */
const IGNORED_NOTE = /\bignored and left in place\b/i

/** A negation that would turn the allowed statement into its opposite. */
const NEGATION = /\b(not|never|no longer)\b/i

/**
 * `file:line` for every `access.json` mention in `files` other than the one
 * allowed note: the server reads and writes no such file, so the internal docs
 * may say a leftover `access.json` is "ignored and left in place", and nothing
 * else about it. The exception is judged per clause, not per line, because an
 * architecture entry is one long line. A clause ends at `.`, `;` or `:`
 * followed by whitespace, or at a table-cell `|`, so a colon-led or tabulated
 * description of the file cannot borrow the phrase from a neighbouring clause
 * or cell. The clause naming the file must say "ignored and left in place"
 * exactly (a looser "ignored" or "left in place" also passes sentences like
 * "unknown keys in it are ignored" or "a failed write is left in place"), and
 * must not also say "not", "never" or "no longer".
 */
function accessJsonOutsideIgnoredNote(files: string[]): string[] {
  return files.flatMap((file) =>
    readFileSync(join(REPO_ROOT, file), 'utf-8')
      .split('\n')
      .flatMap((text, i) =>
        text
          .split(/(?<=[.;:])\s+|\|/)
          .some((clause) => ACCESS_JSON.test(clause) && (!IGNORED_NOTE.test(clause) || NEGATION.test(clause)))
          ? [`${file}:${i + 1}`]
          : [],
      ),
  )
}

describe('the internal docs describe no retired access model', () => {
  for (const file of INTERNAL_DOCS) {
    test.each(INTERNAL_DOC_TERMS)(`${file} names no %s`, (_term, re) => {
      expect(hitsOf([file], re)).toEqual([])
    })

    test(`${file} names access.json only to say a leftover one is ignored and left in place`, () => {
      expect(accessJsonOutsideIgnoredNote([file])).toEqual([])
    })
  }
})

/**
 * The 0-based line range `[start, end)` of the Markdown section whose heading
 * at `level` (`##` = 2) matches `title`, heading line included, up to the next
 * heading at that level or higher; `start` is -1 when absent. Lines inside a
 * ``` or ~~~ fence are not headings, so a `# comment` in a shell block does not
 * end the section. Mirrors `markdownSection` in tests/shipped-docs.test.ts,
 * returning line numbers so a failure can name `README.md:<line>`.
 */
function markdownSectionRange(lines: string[], level: number, title: RegExp): { start: number; end: number } {
  const heading = new RegExp(`^(#{1,${level}})\\s+(.*?)\\s*$`)
  let inFence = false
  let start = -1
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*(```|~~~)/.test(lines[i])) inFence = !inFence
    if (inFence) continue
    const m = heading.exec(lines[i])
    if (!m) continue
    if (start >= 0) return { start, end: i }
    if (m[1].length === level && title.test(m[2])) start = i
  }
  return { start, end: lines.length }
}

describe("README's Release section", () => {
  test('names no access.json', () => {
    const lines = readFileSync(join(REPO_ROOT, 'README.md'), 'utf-8').split('\n')
    const { start, end } = markdownSectionRange(lines, 2, /^Release\b/)
    // Fail loudly rather than pass on an empty section when the heading moves.
    if (start === -1) throw new Error('README.md has no "## Release" heading; the Release-section guard cannot locate it')
    const section = lines.slice(start, end)
    expect(section.length).toBeGreaterThan(1)
    expect(section.flatMap((text, i) => (ACCESS_JSON.test(text) ? [`README.md:${start + i + 1}`] : []))).toEqual([])
  })
})
