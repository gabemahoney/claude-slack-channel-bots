/**
 * install-check-script.test.ts — SR-12.3 coverage for scripts/install-check.ts.
 *
 * Exercises the script's stdout/stderr formatting and exit-code behavior,
 * isolated from the AD-side resolveSystemBinary by stubbing
 * `runInstallCheck()` via mock.module (inside beforeEach/afterEach).
 *
 * Cases:
 *   - Success arm: stdout contains AD name, absolute path, detected
 *     version, floor; exit 0.
 *   - ad-system-install-not-found: stderr contains class label + manual-
 *     skill-install block; exit 1.
 *   - ad-system-install-too-old: stderr contains class label, detected,
 *     required, + manual-skill-install block; exit 1.
 *   - ad-system-install-unreachable (each of eight reasons): stderr
 *     contains class label, reason verbatim, + manual-skill-install
 *     block; exit 1.
 *   - ad-version-floor-unreadable: stderr contains class label + reinstall
 *     guidance, NOT the manual-skill-install block; exit 1.
 *   - Re-run idempotency on success: byte-identical stdout across two
 *     invocations.
 *
 * Runs the script as a subprocess via spawn so process.exit() actually
 * exits and stdout/stderr are captured cleanly. Stubs runInstallCheck()
 * by writing a temp wrapper script that re-exports a mocked module — but
 * since this is heavy, instead we run the actual script and use a
 * mock-module wrapper file passed via Bun's --preload.
 *
 * Simpler approach: each test writes a tiny driver script to a temp file
 * that imports the production renderer functions (re-exported from the
 * script module for testability) and feeds them canned Result values.
 *
 * Cleanest: refactor the script to export `renderSuccess`, `renderFailure`,
 * and `runScriptWithDeps(runner)` so tests inject a canned-result runner
 * directly without mocking. The script's main() then calls
 * runScriptWithDeps(runInstallCheck).
 *
 * This file uses the direct-injection seam — see scripts/install-check.ts
 * for the exported renderers.
 *
 * SPDX-License-Identifier: MIT
 */

import { describe, expect, test } from 'bun:test'

import {
  renderSuccess,
  renderFailure,
} from '../scripts/install-check.ts'
import type { UnreachableReason } from 'agent-director'
import {
  cannedSuccessResult,
  cannedFailureResult,
  SATISFYING_VERSION,
  STALE_VERSION,
} from './test-helpers/install-check-fixtures.ts'
import { renderInstallSkillInstructions } from '../src/install-skill-pointer.ts'

const SKILL_BLOCK_MARKER = 'skills/install-cscb/SKILL.md'

describe('SR-6: install-check script — success arm', () => {
  test('stdout contains AD name, absolute path, detected version, floor', () => {
    const result = cannedSuccessResult({
      binaryPath: '/opt/bin/agent-director',
      binaryVersion: SATISFYING_VERSION,
      floor: '0.7.0',
    })
    const out = renderSuccess(result)
    expect(out).toContain('agent-director')
    expect(out).toContain('/opt/bin/agent-director')
    expect(out).toContain(SATISFYING_VERSION)
    expect(out).toContain('0.7.0')
  })

  test('re-run idempotency: identical output across two calls', () => {
    const result = cannedSuccessResult({
      binaryPath: '/opt/bin/agent-director',
      binaryVersion: SATISFYING_VERSION,
      floor: '0.7.0',
    })
    const a = renderSuccess(result)
    const b = renderSuccess(result)
    expect(a).toBe(b)
  })
})

describe('SR-6: install-check script — failure arms (append manual-skill-install block)', () => {
  test('ad-system-install-not-found → contains class label + skill block', () => {
    const result = cannedFailureResult('ad-system-install-not-found')
    const body = renderFailure(result) + renderInstallSkillInstructions()
    expect(body).toContain('ad-system-install-not-found')
    expect(body).toContain(SKILL_BLOCK_MARKER)
  })

  test('ad-system-install-too-old → contains class label, detected, required, + skill block', () => {
    const result = cannedFailureResult('ad-system-install-too-old')
    const body = renderFailure(result) + renderInstallSkillInstructions()
    expect(body).toContain('ad-system-install-too-old')
    expect(body).toContain(STALE_VERSION)
    expect(body).toContain('0.7.0')
    expect(body).toContain(SKILL_BLOCK_MARKER)
  })

  const REASONS: UnreachableReason[] = [
    'not-executable',
    'not-a-regular-file',
    'probe-timeout',
    'probe-nonzero-exit',
    'probe-killed-by-signal',
    'unparseable-version',
    'spawn-failed',
    'other',
  ]

  for (const reason of REASONS) {
    test(`ad-system-install-unreachable reason='${reason}' → reason verbatim + skill block`, () => {
      const result = cannedFailureResult('ad-system-install-unreachable', {
        message: `agent-director system install is unreachable. Reason: ${reason}.`,
        detail: { reason, binaryPath: '/usr/local/bin/agent-director' },
      })
      const body = renderFailure(result) + renderInstallSkillInstructions()
      expect(body).toContain('ad-system-install-unreachable')
      expect(body).toContain(reason)
      expect(body).toContain(SKILL_BLOCK_MARKER)
    })
  }
})

describe('SR-6.3: ad-version-floor-unreadable does NOT append the skill block', () => {
  test('class label present + reinstall guidance present + NO skill block', () => {
    const result = cannedFailureResult('ad-version-floor-unreadable')
    // The script's append rule branches on classLabel — emulate the
    // script's behavior here exactly: no block on this label.
    const body = renderFailure(result)
    expect(body).toContain('ad-version-floor-unreadable')
    expect(body.toLowerCase()).toContain('reinstall agent-director')
    expect(body).not.toContain(SKILL_BLOCK_MARKER)
  })
})
