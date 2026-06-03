/**
 * install-skill-pointer.ts — Render the manual-fetch instructions block
 * appended to the gate's three system-install typed-error failure messages
 * (SR-4.5, SR-9.3).
 *
 * The block tells the operator where to fetch `skills/install-cscb/SKILL.md`
 * from CSCB's GitHub repo, where to place it under `~/.claude/skills/`, and
 * how to invoke the skill once installed. The skill itself walks the user
 * through the interactive `agent-director` install/upgrade flow.
 *
 * The append-on-three-branches rule lives in `agent-director-startup.ts` —
 * this module only renders. The block is appended verbatim regardless of
 * whether the skill is already installed; the gate cannot detect that and
 * must not try.
 *
 * Public API:
 *   - renderInstallSkillInstructions(): string  — production wrapper; reads
 *     `package.json` once at module init, normalizes `repository.url`, and
 *     renders. Cached for the life of the process.
 *   - renderInstallSkillInstructionsFrom(repositoryUrl): string  — pure
 *     function used by tests to feed synthetic `repository.url` values
 *     without `mock.module`. Throws on missing / non-string / unparseable
 *     input.
 *
 * SPDX-License-Identifier: MIT
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** In-repo path of the install skill — module-local constant, not derived from package.json. */
const IN_REPO_SKILL_PATH = 'skills/install-cscb/SKILL.md'

/** Target path under `~/.claude/skills/` where the user must place SKILL.md. */
const TARGET_SKILL_PATH = '~/.claude/skills/install-cscb/SKILL.md'

/** Literal slash-command the user invokes after installing the skill. */
const SKILL_INVOCATION_COMMAND = '/install-cscb'

/**
 * Normalize a `repository.url` value to a plain `https://github.com/<owner>/<repo>`
 * base URL. Strips a leading `git+` prefix and a trailing `.git` suffix.
 *
 * Throws a CSCB-internal packaging-bug Error when the input cannot be normalized
 * to a `https://github.com/...` form — this is a CSCB bug, not a runtime
 * condition, so failing loudly is correct.
 */
export function normalizeRepositoryUrl(repositoryUrl: string): string {
  let url = repositoryUrl
  if (url.startsWith('git+')) url = url.slice(4)
  if (url.endsWith('.git')) url = url.slice(0, -4)
  if (!url.startsWith('https://github.com/')) {
    throw new Error(
      `install-skill-pointer: repository.url=${repositoryUrl} does not normalize to ` +
        `a https://github.com/<owner>/<repo> base URL — CSCB packaging bug.`,
    )
  }
  return url
}

/**
 * Pure render function. Used by tests with synthetic `repository.url`
 * inputs. The production wrapper below reads `package.json` once and
 * forwards the value here.
 */
export function renderInstallSkillInstructionsFrom(repositoryUrl: string): string {
  if (typeof repositoryUrl !== 'string' || repositoryUrl.length === 0) {
    throw new Error(
      `install-skill-pointer: repository.url is missing or not a string — CSCB packaging bug.`,
    )
  }
  const base = normalizeRepositoryUrl(repositoryUrl)
  const skillUrl = `${base}/blob/main/${IN_REPO_SKILL_PATH}`
  return [
    '',
    'Interactive remediation is available via the install-cscb skill.',
    `Fetch the skill from: ${skillUrl}`,
    `Place it at: ${TARGET_SKILL_PATH}`,
    `Then run: ${SKILL_INVOCATION_COMMAND}`,
  ].join('\n')
}

/**
 * Read this package's `repository.url` once at module init. Throws at module
 * init when the field is missing / non-string — a CSCB packaging bug.
 */
function readRepositoryUrl(): string {
  const moduleDir = dirname(fileURLToPath(import.meta.url))
  const pkgPath = join(moduleDir, '..', 'package.json')
  const raw = readFileSync(pkgPath, 'utf-8')
  const pkg = JSON.parse(raw) as { repository?: { url?: unknown } }
  const url = pkg.repository?.url
  if (typeof url !== 'string' || url.length === 0) {
    throw new Error(
      `install-skill-pointer: package.json repository.url is missing or not a string — CSCB packaging bug.`,
    )
  }
  return url
}

/** Cached production-rendered block. Populated lazily on first call. */
let cachedBlock: string | null = null

/**
 * Production wrapper: render the block using this package's `repository.url`.
 * Cached for the life of the process; idempotent.
 */
export function renderInstallSkillInstructions(): string {
  if (cachedBlock === null) {
    cachedBlock = renderInstallSkillInstructionsFrom(readRepositoryUrl())
  }
  return cachedBlock
}

/**
 * @internal Test-only — reset the cached block so the production wrapper
 * re-reads `package.json` on the next call. Used by the helper's own tests
 * to exercise the cache + the read path.
 */
export function resetCacheForTests(): void {
  cachedBlock = null
}
