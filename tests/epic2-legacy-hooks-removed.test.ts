/**
 * epic2-legacy-hooks-removed.test.ts — b.hdk regression guard.
 *
 * Asserts that the Epic-2 legacy hook install instructions removed in b.hdk
 * do NOT re-appear in shipping artifacts. Each test would fail against the
 * pre-fix state and passes against the post-fix state.
 *
 *   1. package.json `files` array does NOT contain "hooks/"
 *   2. hooks/ directory does NOT exist at the repo root
 *   3. skills/setup-slack-channel-bots/SKILL.md has no hook install instructions
 *   4. README.md has no hook install instructions outside the upgrade-notes section,
 *      and the new ## Upgrading from pre-Epic-2 section exists
 *   5. docs/architecture.md describes the .sh files only as deleted/absent
 *
 * SPDX-License-Identifier: MIT
 */

import { describe, test, expect } from 'bun:test'
import { readFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'

const REPO_ROOT = resolve(import.meta.dir, '..')

function read(relPath: string): string {
  return readFileSync(resolve(REPO_ROOT, relPath), 'utf-8')
}

// ---------------------------------------------------------------------------
// 1. package.json — "hooks/" must not appear in the `files` array
// ---------------------------------------------------------------------------

describe('b.hdk: package.json has no hooks/ in files array', () => {
  test('"hooks/" is absent from the files array', () => {
    const pkg = JSON.parse(read('package.json')) as { files?: string[] }
    expect(pkg.files ?? []).not.toContain('hooks/')
  })
})

// ---------------------------------------------------------------------------
// 2. hooks/ directory must not exist at repo root
// ---------------------------------------------------------------------------

describe('b.hdk: hooks/ directory does not exist at repo root', () => {
  test('hooks/ directory is absent', () => {
    const hooksDir = resolve(REPO_ROOT, 'hooks')
    expect(existsSync(hooksDir)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// 3. SKILL.md — no hook install instructions
//
// After the fix, permission-relay.sh / ask-relay.sh still appear in the
// *verification* section (Step 8 tells operators to check for orphan entries).
// That is intentional. The banned patterns are install-instruction forms:
//   - cp ... permission-relay.sh / ask-relay.sh
//   - ln -sf ... permission-relay.sh / ask-relay.sh
//   - chmod +x ~/.claude/hooks/permission-relay.sh (or ask-relay.sh)
//   - "type": "command" block paired with the .sh paths
//   - "matcher": "PermissionRequest" paired with the .sh paths
//   - cp "$(npm root -g)/claude-slack-channel-bots/hooks/... copy-from-package
// ---------------------------------------------------------------------------

describe('b.hdk: SKILL.md has no legacy hook install instructions', () => {
  const skill = read('skills/setup-slack-channel-bots/SKILL.md')

  test('no `cp` install command targeting permission-relay.sh', () => {
    // Matches e.g.  cp ... permission-relay.sh
    expect(skill).not.toMatch(/\bcp\b[^\n]*permission-relay\.sh/)
  })

  test('no `cp` install command targeting ask-relay.sh', () => {
    expect(skill).not.toMatch(/\bcp\b[^\n]*ask-relay\.sh/)
  })

  test('no `ln -sf` command targeting permission-relay.sh', () => {
    expect(skill).not.toMatch(/\bln\s+-sf\b[^\n]*permission-relay\.sh/)
  })

  test('no `ln -sf` command targeting ask-relay.sh', () => {
    expect(skill).not.toMatch(/\bln\s+-sf\b[^\n]*ask-relay\.sh/)
  })

  test('no `chmod +x` targeting the legacy hook paths', () => {
    // Covers ~/.claude/hooks/permission-relay.sh and ask-relay.sh
    expect(skill).not.toMatch(/chmod\s+\+x[^\n]*(permission-relay|ask-relay)\.sh/)
  })

  test('no copy-from-package-root pattern (npm root -g)', () => {
    // The old form: cp "$(npm root -g)/claude-slack-channel-bots/hooks/..."
    expect(skill).not.toMatch(/npm root -g[^\n]*hooks\//)
  })

  test('no JSON "type":"command" block wiring the .sh relay hooks', () => {
    // Matches e.g.  "command": "~/.claude/hooks/permission-relay.sh"
    expect(skill).not.toMatch(/"command"\s*:\s*"[^"]*permission-relay\.sh"/)
    expect(skill).not.toMatch(/"command"\s*:\s*"[^"]*ask-relay\.sh"/)
  })

  test('no "matcher":"PermissionRequest" block paired with .sh hook paths', () => {
    // Option A: the "command" key pointing at permission-relay.sh (test at line 94 above)
    // already catches any re-introduced settings.json install block, because every such
    // block MUST have a "command" entry. The original regex was single-line and would
    // miss real JSON where the keys are on separate lines, so we drop it here and rely
    // on the "command" assertion above as the authoritative guard for this regression.
    expect(skill).not.toMatch(/"matcher"\s*:\s*"PermissionRequest"[\s\S]{0,300}permission-relay\.sh/)
  })
})

// ---------------------------------------------------------------------------
// 4. README.md — no hook install instructions; upgrade section exists
//
// The README has a legitimate "Upgrading from pre-Epic-2" section that tells
// operators to *delete* old files. Deletion commands are fine — we only ban
// install (cp / ln / chmod) instructions for these hooks.
// The "## Upgrading from pre-Epic-2" heading must be present.
// ---------------------------------------------------------------------------

describe('b.hdk: README.md has no legacy hook install instructions', () => {
  const readme = read('README.md')

  test('## Upgrading from pre-Epic-2 section exists', () => {
    // Anchored regex so the heading must be an exact complete line (no extra text appended).
    expect(readme).toMatch(/^## Upgrading from pre-Epic-2 \(v0\.5\.x → v0\.6\.x\)$/m)
  })

  test('no `cp` install command targeting permission-relay.sh', () => {
    expect(readme).not.toMatch(/\bcp\b[^\n]*permission-relay\.sh/)
  })

  test('no `cp` install command targeting ask-relay.sh', () => {
    expect(readme).not.toMatch(/\bcp\b[^\n]*ask-relay\.sh/)
  })

  test('no `ln -sf` command targeting permission-relay.sh', () => {
    expect(readme).not.toMatch(/\bln\s+-sf\b[^\n]*permission-relay\.sh/)
  })

  test('no `ln -sf` command targeting ask-relay.sh', () => {
    expect(readme).not.toMatch(/\bln\s+-sf\b[^\n]*ask-relay\.sh/)
  })

  test('no `chmod +x` targeting the legacy hook paths', () => {
    expect(readme).not.toMatch(/chmod\s+\+x[^\n]*(permission-relay|ask-relay)\.sh/)
  })

  test('no copy-from-package-root pattern (npm root -g)', () => {
    expect(readme).not.toMatch(/npm root -g[^\n]*hooks\//)
  })
})

// ---------------------------------------------------------------------------
// 5. docs/architecture.md — .sh files described only as deleted/absent
//
// Line 34 legitimately lists them as "deleted files from the pre-Epic-2
// architecture". That's the one allowed mention. We assert that every line
// referencing these filenames contains at least one of the historical markers
// that confirms they are described as gone, not active.
// ---------------------------------------------------------------------------

describe('b.hdk: architecture.md describes .sh hooks as deleted, not active', () => {
  test('every line mentioning permission-relay.sh or ask-relay.sh uses a historical/deleted framing', () => {
    const lines = read('docs/architecture.md').split('\n')
    const HISTORICAL_MARKERS = [
      'deleted',
      'removed',
      'absent',
      'no longer',
      'pre-Epic-2',
      'not shipped',
    ]

    const offending: Array<{ lineNumber: number; text: string }> = []
    lines.forEach((text, i) => {
      if (!/(permission-relay|ask-relay)\.sh/.test(text)) return
      const lower = text.toLowerCase()
      const isHistorical = HISTORICAL_MARKERS.some((m) => lower.includes(m))
      if (!isHistorical) {
        offending.push({ lineNumber: i + 1, text: text.trim() })
      }
    })

    expect(offending).toEqual([])
  })
})
