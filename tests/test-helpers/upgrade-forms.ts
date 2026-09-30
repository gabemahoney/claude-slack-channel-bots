/**
 * upgrade-forms.ts — the forms an instruction to upgrade agent-director, or
 * an upgrade or install command, takes (b.jg5 SRJ-208). The refusal texts
 * CSCB ships (the startup gate's messages, the README's startup-error list,
 * the debugging and install skills) name the switch-over runbook instead and
 * carry none of them.
 *
 * Each row is a label, a pattern and a synthetic string the pattern must
 * match; check text with its whitespace collapsed (`flat`). A test that needs
 * more forms (the install skill's offers to run a command) appends its own
 * rows. The self-checks over these rows live in shipped-docs.test.ts.
 *
 * Pure: reads nothing, writes nothing.
 *
 * SPDX-License-Identifier: MIT
 */

/** One forbidden form: its label, its pattern, and a synthetic string the pattern matches. */
export type ForbiddenForm = [label: string, pattern: RegExp, sample: string]

/** An upgrade instruction or an upgrade or install command, in any refusal text (b.jg5 SRJ-208). */
export const UPGRADE_FORMS: readonly ForbiddenForm[] = [
  ['upgrade wording', /\bupgrad(?:e|es|ed|ing)\b/i, 'Upgrade agent-director and retry.'],
  ['"upgrade command" or "install command" wording', /\b(?:upgrade|install)\s+command\b/i, 'run the AD-published install command'],
  ['`install.sh`', /\binstall\.sh\b/, 'run install.sh from the repo'],
  ['`curl`', /\bcurl\b/, 'curl -fsSL https://example.test/install | sh'],
  ['package-manager install', /\b(?:bun|npm|pnpm|yarn)\s+(?:add|install|i)\b/, 'npm install -g agent-director'],
  ['backticked agent-director command line', /`(?:\$\s*|sudo\s+)?agent-director\s+[^\s`][^`]*`/, 'run `sudo agent-director upgrade --yes`'],
]
