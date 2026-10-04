/**
 * upgrade-forms.ts — the forms an instruction to upgrade or re-install
 * agent-director, or an upgrade or install command, takes (b.jg5 SRJ-208,
 * SRJ-1101). The refusal texts CSCB ships (the startup gate's messages, the
 * README's startup-error list, the debugging and install skills) name the
 * switch-over runbook instead and carry none of them.
 *
 * Each row is a label, a pattern and a synthetic string the pattern must
 * match; check text with its whitespace collapsed (`flat`). A test that needs
 * more forms (the install skill's offers to run a command) appends its own
 * rows. The self-checks over these rows live in shipped-docs.test.ts.
 *
 * The re-install row (E36 T2 ruling; SRJ-1101, HO C8, the E2-gate and E5
 * hatch notes): re-installing the host's agent-director outside the
 * switch-over runbook could bring in Phase 1 without the switch-over, so no
 * text advises it. The row matches "re-install" or "reinstall", in any case,
 * followed within three words of the same clause by `agent-director` (its
 * npm package included, quoted or backticked); it does not match re-installing
 * a Slack app or CSCB itself.
 *
 * `INSTALL_OR_REMOVAL_FORMS` is a second list, for the install check's, the
 * startup gate's and SR-2.5's own messages only (b.jg5 SRJ-208, SRJ-211,
 * SRJ-212; E36 T2): an instruction to install agent-director, other than by
 * following the switch-over runbook (the too-old message's "installed
 * together: install agent-director by following the switch-over runbook",
 * SRJ-208), and the removal or re-creation of a file. The shipped docs are
 * not read against it: the switch-over runbook's publishing-host block sends
 * a host with no agent-director to agent-director's own install. The
 * self-checks over its rows live in install-check.test.ts.
 *
 * Pure: reads nothing, writes nothing.
 *
 * SPDX-License-Identifier: MIT
 */

/** One forbidden form: its label, its pattern, and a synthetic string the pattern matches. */
export type ForbiddenForm = [label: string, pattern: RegExp, sample: string]

/** An upgrade or re-install instruction, or an upgrade or install command, in any refusal text (b.jg5 SRJ-208, SRJ-1101). */
export const UPGRADE_FORMS: readonly ForbiddenForm[] = [
  ['upgrade wording', /\bupgrad(?:e|es|ed|ing)\b/i, 'Upgrade agent-director and retry.'],
  ['"upgrade command" or "install command" wording', /\b(?:upgrade|install)\s+command\b/i, 'run the AD-published install command'],
  ['`install.sh`', /\binstall\.sh\b/, 'run install.sh from the repo'],
  ['`curl`', /\bcurl\b/, 'curl -fsSL https://example.test/install | sh'],
  ['package-manager install', /\b(?:bun|npm|pnpm|yarn)\s+(?:add|install|i)\b/, 'npm install -g agent-director'],
  ['backticked agent-director command line', /`(?:\$\s*|sudo\s+)?agent-director\s+[^\s`][^`]*`/, 'run `sudo agent-director upgrade --yes`'],
  [
    're-install agent-director',
    /\bre-?install(?:s|ed|ing)?(?:\s+[^\s.,;:]+){0,3}?\s+['"`]?agent-director\b/i,
    "Re-install a matching 'agent-director' package and retry.",
  ],
]

/**
 * An instruction to install agent-director, or to remove or recreate a file,
 * in the install check's, the startup gate's or SR-2.5's messages (b.jg5
 * SRJ-208, SRJ-211, SRJ-212; E36 T2). Not for the shipped docs (see the
 * header).
 */
export const INSTALL_OR_REMOVAL_FORMS: readonly ForbiddenForm[] = [
  [
    'install-agent-director instruction',
    /\binstall(?:ing)?\s+(?:the\s+host's\s+)?agent-director\b(?!\s+by\s+following\s+the\s+switch-over\s+runbook\b)/i,
    'Install agent-director (system-wide) and retry.',
  ],
  ['file removal or re-creation', /\b(?:remov(?:e|es|ed|ing)|delet(?:e|es|ed|ing)|recreat(?:e|es|ed|ing)|rm)\b/i, 'or remove the mismatched file'],
]
