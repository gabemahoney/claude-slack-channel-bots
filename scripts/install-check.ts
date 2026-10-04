#!/usr/bin/env bun
/**
 * scripts/install-check.ts — `bun run install-check` entry point.
 *
 * SR-6: standalone diagnostic command. Calls runInstallCheck() once,
 * renders the result to stdout (success) or stderr (failure), and exits
 * with the appropriate code.
 *
 * Success (exit 0) prints the OK block (binary, version, the client's
 * minimum). When the binary is below CSCB's Phase 1 floor, the result carries
 * the Phase 1 note (b.jg5 SRJ-212) and the block ends with it: the server
 * refuses to start on that binary until agent-director Phase 1 is installed,
 * see the switch-over runbook section. A binary that meets the floor prints
 * the block alone. The note line's label is `INSTALL_CHECK_NOTE_LABEL`.
 *
 * Appends the manual-skill-install instructions block to every failure
 * class EXCEPT ad-version-floor-unreadable — that case's remediation is
 * "check the agent-director npm package installed with CSCB" with the
 * switch-over runbook section (`CLIENT_PACKAGE_REMEDY` in
 * `src/install-check.ts`), not "install the install skill."
 *
 * The script MUST NOT prompt for input, MUST NOT run any install command,
 * MUST NOT attempt to fetch the install skill. It is purely diagnostic.
 *
 * Not wired to any npm/bun lifecycle (no preinstall, postinstall, prepare,
 * prepublishOnly). Operator runs it manually via `bun run install-check`.
 *
 * SPDX-License-Identifier: MIT
 */

import { AD_VERSION_FLOOR_UNREADABLE, runInstallCheck } from '../src/install-check.ts'
import type { InstallCheckResult } from '../src/install-check.ts'
import { renderInstallSkillInstructions } from '../src/install-skill-pointer.ts'

/**
 * The label the OK block's Phase 1 note line starts with, after its indent
 * (b.jg5 SRJ-212). The install skill relays the note found under this label
 * (SRJ-1110).
 */
export const INSTALL_CHECK_NOTE_LABEL = 'note:'

/** The OK block, then the Phase 1 note when the result carries one. */
export function renderSuccess(result: InstallCheckResult & { ok: true }): string {
  const lines = [
    'agent-director install check: OK',
    `  binary:  ${result.binaryPath}`,
    `  version: ${result.binaryVersion}`,
    `  floor:   ${result.floor}`,
  ]
  if (result.note !== undefined) {
    lines.push(`  ${INSTALL_CHECK_NOTE_LABEL}    ${result.note}`)
  }
  return lines.join('\n')
}

export function renderFailure(result: InstallCheckResult & { ok: false }): string {
  const lines = [
    `agent-director install check: FAILED (${result.classLabel})`,
    result.message,
  ]
  if (Object.keys(result.detail).length > 0) {
    lines.push(`  detail: ${JSON.stringify(result.detail)}`)
  }
  return lines.join('\n')
}

export async function main(): Promise<void> {
  const result = await runInstallCheck()

  if (result.ok) {
    process.stdout.write(renderSuccess(result) + '\n')
    process.exit(0)
  }

  let body = renderFailure(result)
  // SR-6.3: append the manual-skill-install block to every failure class
  // EXCEPT ad-version-floor-unreadable (the skill can't fix a corrupt AD
  // package; remediation is checking the agent-director npm package
  // installed with CSCB, with the switch-over runbook section).
  if (result.classLabel !== AD_VERSION_FLOOR_UNREADABLE) {
    body += renderInstallSkillInstructions()
  }
  process.stderr.write(body + '\n')
  process.exit(1)
}

if (import.meta.main) {
  void main()
}
