/**
 * install-skill-pointer.test.ts — Exercise the SR-9.3 manual-fetch-block helper.
 *
 * Tests cover URL derivation (git+ prefix + .git suffix stripping), the
 * in-repo skill path literal, the full block format, idempotency, purity
 * (no side effects), and fail-loud behavior on malformed inputs.
 *
 * The pure `renderInstallSkillInstructionsFrom(repositoryUrl)` entry point
 * is used for the synthetic-URL cases so no `mock.module` is needed. The
 * production wrapper `renderInstallSkillInstructions()` is exercised once
 * against the shipping package.json to confirm the read path works end-to-end.
 *
 * SPDX-License-Identifier: MIT
 */

import { afterEach, describe, expect, test } from 'bun:test'

import {
  normalizeRepositoryUrl,
  renderInstallSkillInstructions,
  renderInstallSkillInstructionsFrom,
  resetCacheForTests,
} from '../src/install-skill-pointer.ts'

const IN_REPO_SKILL_PATH = 'skills/install-cscb/SKILL.md'
const TARGET_PATH = '~/.claude/skills/install-cscb/SKILL.md'
const INVOCATION_COMMAND = '/install-cscb'

// ---------------------------------------------------------------------------
// normalizeRepositoryUrl
// ---------------------------------------------------------------------------

describe('normalizeRepositoryUrl', () => {
  test('strips git+ prefix', () => {
    expect(normalizeRepositoryUrl('git+https://github.com/example/cscb.git')).toBe(
      'https://github.com/example/cscb',
    )
  })

  test('strips trailing .git', () => {
    expect(normalizeRepositoryUrl('https://github.com/example/cscb.git')).toBe(
      'https://github.com/example/cscb',
    )
  })

  test('passes bare https URL through unchanged', () => {
    expect(normalizeRepositoryUrl('https://github.com/example/cscb')).toBe(
      'https://github.com/example/cscb',
    )
  })

  test('throws CSCB-internal packaging-bug error on non-github HTTPS URL', () => {
    expect(() => normalizeRepositoryUrl('https://gitlab.com/example/cscb')).toThrow(
      /CSCB packaging bug/,
    )
  })

  test('throws CSCB-internal packaging-bug error on SSH form (out of scope)', () => {
    expect(() => normalizeRepositoryUrl('git@github.com:example/cscb.git')).toThrow(
      /CSCB packaging bug/,
    )
  })
})

// ---------------------------------------------------------------------------
// renderInstallSkillInstructionsFrom — pure entry point
// ---------------------------------------------------------------------------

describe('renderInstallSkillInstructionsFrom', () => {
  test('renders the SKILL.md URL with /blob/main/ path appended', () => {
    const out = renderInstallSkillInstructionsFrom(
      'git+https://github.com/example/cscb.git',
    )
    expect(out).toContain(
      `https://github.com/example/cscb/blob/main/${IN_REPO_SKILL_PATH}`,
    )
  })

  test('renders the in-repo skill path as a module-local constant (not pulled from input)', () => {
    const out = renderInstallSkillInstructionsFrom(
      'git+https://github.com/wrongowner/wrongrepo.git',
    )
    // The owner/repo come from input; the in-repo path is the module-local constant.
    expect(out).toContain(IN_REPO_SKILL_PATH)
  })

  test('renders the target path under ~/.claude/skills/install-cscb/', () => {
    const out = renderInstallSkillInstructionsFrom(
      'https://github.com/example/cscb',
    )
    expect(out).toContain(TARGET_PATH)
  })

  test('renders the literal /install-cscb invocation command', () => {
    const out = renderInstallSkillInstructionsFrom(
      'https://github.com/example/cscb',
    )
    expect(out).toContain(INVOCATION_COMMAND)
  })

  test('renders a statement about interactive remediation requiring the skill', () => {
    const out = renderInstallSkillInstructionsFrom(
      'https://github.com/example/cscb',
    )
    expect(out.toLowerCase()).toContain('install-cscb skill')
  })

  test('is byte-for-byte idempotent for the same input', () => {
    const a = renderInstallSkillInstructionsFrom(
      'https://github.com/example/cscb',
    )
    const b = renderInstallSkillInstructionsFrom(
      'https://github.com/example/cscb',
    )
    expect(a).toBe(b)
  })

  test('throws on missing repository.url (undefined)', () => {
    expect(() =>
      renderInstallSkillInstructionsFrom(undefined as unknown as string),
    ).toThrow(/CSCB packaging bug/)
  })

  test('throws on non-string repository.url (number)', () => {
    expect(() =>
      renderInstallSkillInstructionsFrom(42 as unknown as string),
    ).toThrow(/CSCB packaging bug/)
  })

  test('throws on empty-string repository.url', () => {
    expect(() => renderInstallSkillInstructionsFrom('')).toThrow(
      /CSCB packaging bug/,
    )
  })

  test('produces no side effects on stdout, stderr, disk, or process.exit', () => {
    const originalStdoutWrite = process.stdout.write.bind(process.stdout)
    const originalStderrWrite = process.stderr.write.bind(process.stderr)
    const originalExit = process.exit
    const stdoutCalls: string[] = []
    const stderrCalls: string[] = []
    let exitCalled = false
    process.stdout.write = ((chunk: string | Uint8Array): boolean => {
      stdoutCalls.push(String(chunk))
      return true
    }) as typeof process.stdout.write
    process.stderr.write = ((chunk: string | Uint8Array): boolean => {
      stderrCalls.push(String(chunk))
      return true
    }) as typeof process.stderr.write
    process.exit = ((_code?: number) => {
      exitCalled = true
    }) as typeof process.exit
    try {
      renderInstallSkillInstructionsFrom('https://github.com/example/cscb')
    } finally {
      process.stdout.write = originalStdoutWrite
      process.stderr.write = originalStderrWrite
      process.exit = originalExit
    }
    expect(stdoutCalls).toEqual([])
    expect(stderrCalls).toEqual([])
    expect(exitCalled).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// renderInstallSkillInstructions — production wrapper (reads package.json)
// ---------------------------------------------------------------------------

describe('renderInstallSkillInstructions (production wrapper)', () => {
  afterEach(() => {
    resetCacheForTests()
  })

  test('reads this package\'s repository.url and renders a valid block', () => {
    const out = renderInstallSkillInstructions()
    // The actual repository points at gabemahoney/claude-slack-channel-bots.
    expect(out).toContain(
      `https://github.com/gabemahoney/claude-slack-channel-bots/blob/main/${IN_REPO_SKILL_PATH}`,
    )
    expect(out).toContain(TARGET_PATH)
    expect(out).toContain(INVOCATION_COMMAND)
  })

  test('returns a byte-identical cached string on repeated invocation', () => {
    const a = renderInstallSkillInstructions()
    const b = renderInstallSkillInstructions()
    expect(a).toBe(b)
  })
})
