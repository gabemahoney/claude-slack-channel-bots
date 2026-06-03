#!/usr/bin/env bun
/**
 * scripts/install-check.ts — `bun run install-check` entry point.
 *
 * SR-6: standalone diagnostic command. Calls runInstallCheck() once,
 * renders the result to stdout (success) or stderr (failure), and exits
 * with the appropriate code.
 *
 * Appends the manual-skill-install instructions block to every failure
 * class EXCEPT ad-version-floor-unreadable — that case's remediation is
 * "reinstall agent-director from npm," not "install the install skill."
 *
 * The script MUST NOT prompt for input, MUST NOT run any install command,
 * MUST NOT attempt to fetch the install skill. It is purely diagnostic.
 *
 * Not wired to any npm/bun lifecycle (no preinstall, postinstall, prepare,
 * prepublishOnly). Operator runs it manually via `bun run install-check`.
 *
 * SPDX-License-Identifier: MIT
 */

import { runInstallCheck } from '../src/install-check.ts'
import type { InstallCheckResult } from '../src/install-check.ts'
import { renderInstallSkillInstructions } from '../src/install-skill-pointer.ts'

function renderSuccess(result: InstallCheckResult & { ok: true }): string {
  return [
    'agent-director install check: OK',
    `  binary:  ${result.binaryPath}`,
    `  version: ${result.binaryVersion}`,
    `  floor:   ${result.floor}`,
  ].join('\n')
}

function renderFailure(result: InstallCheckResult & { ok: false }): string {
  const lines = [
    `agent-director install check: FAILED (${result.classLabel})`,
    result.message,
  ]
  if (Object.keys(result.detail).length > 0) {
    lines.push(`  detail: ${JSON.stringify(result.detail)}`)
  }
  return lines.join('\n')
}

async function main(): Promise<void> {
  const result = await runInstallCheck()

  if (result.ok) {
    process.stdout.write(renderSuccess(result) + '\n')
    process.exit(0)
  }

  let body = renderFailure(result)
  // SR-6.3: append the manual-skill-install block to every failure class
  // EXCEPT ad-version-floor-unreadable (the skill can't fix a corrupt AD
  // package; remediation is "reinstall agent-director").
  if (result.classLabel !== 'ad-version-floor-unreadable') {
    body += renderInstallSkillInstructions()
  }
  process.stderr.write(body + '\n')
  process.exit(1)
}

void main()
