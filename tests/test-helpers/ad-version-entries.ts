/**
 * ad-version-entries.ts — the shared check of a runtime version re-check's
 * startup-errors entry (b.jg5 SRJ-205, SRJ-208, SRJ-1013; hatch A3): of
 * either class (`ad-below-phase1-floor`, `ad-system-install-too-old`), it
 * points to the debug skill and to neither the switch-over runbook nor the
 * install skill, and carries no instruction to upgrade or install
 * agent-director. Used by tests/ad-version-gate.test.ts (the re-check's
 * record) and tests/startup-errors.test.ts (the entry the real recorder
 * writes).
 *
 * Pure: reads nothing, writes nothing.
 *
 * SPDX-License-Identifier: MIT
 */

import { expect } from 'bun:test'

import {
  DEBUG_SKILL_PATH,
  DEBUG_SKILL_RUNTIME_STOP_POINTER,
  PHASE1_RUNBOOK_SECTION_TITLE,
  PHASE1_SWITCH_OVER_INSTRUCTION,
  RUNTIME_RECHECK_PHRASE,
} from '../../src/ad-version-gate.ts'
import { renderInstallSkillInstructions } from '../../src/install-skill-pointer.ts'
import { flat } from './markdown.ts'
import { UPGRADE_FORMS } from './upgrade-forms.ts'

/**
 * Assert a runtime re-check's entry `message`, of either class, names the
 * runtime phrase and points to the debug skill (its runtime-stop pointer and
 * path), names neither the switch-over runbook (its section, the startup
 * gate's instruction, the words) nor any line of the install skill's block,
 * and carries no instruction to upgrade or install agent-director
 * (`UPGRADE_FORMS`), its whitespace collapsed (`flat`).
 */
export function expectRuntimeEntryPointsToDebugSkill(message: string): void {
  for (const text of [RUNTIME_RECHECK_PHRASE, DEBUG_SKILL_RUNTIME_STOP_POINTER, DEBUG_SKILL_PATH]) expect(message).toContain(text)
  for (const text of [PHASE1_RUNBOOK_SECTION_TITLE, PHASE1_SWITCH_OVER_INSTRUCTION]) expect(message).not.toContain(text)
  for (const line of renderInstallSkillInstructions().split('\n').filter((line) => line !== '')) expect(message).not.toContain(line)
  const text = flat(message)
  expect(text).not.toMatch(/switch-over runbook/i)
  expect(text).not.toMatch(/\binstall agent-director\b/i)
  expect(text).not.toMatch(/\bupgrade agent-director\b/i)
  for (const [, pattern] of UPGRADE_FORMS) expect(text).not.toMatch(pattern)
}
