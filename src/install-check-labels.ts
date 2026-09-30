/**
 * install-check-labels.ts — the agent-director install-check class labels.
 *
 * A leaf module: it imports nothing, so `src/ad-version-gate.ts` takes the
 * labels from here and never imports `src/install-check.ts` (which imports
 * `agent-director`); the two modules must not import each other.
 * `src/install-check.ts` re-exports every value and type here, so its
 * importers keep working.
 *
 * SPDX-License-Identifier: MIT
 */

/** Class label for "no agent-director system install found"; shared with the startup gate. */
export const AD_SYSTEM_INSTALL_NOT_FOUND = 'ad-system-install-not-found'

/**
 * Class label for the client's own too-old refusal (`ErrSystemInstallTooOld`,
 * a binary below the client's minimum); shared with the startup gate.
 */
export const AD_SYSTEM_INSTALL_TOO_OLD = 'ad-system-install-too-old'

/**
 * Class label for CSCB's own Phase 1 floor refusal: a binary the client admits
 * whose version is below `PHASE1_FLOOR_VERSION` or does not parse (b.jg5
 * SRJ-203, SRJ-1013). Written by the startup gate.
 */
export const AD_BELOW_PHASE1_FLOOR = 'ad-below-phase1-floor'

/**
 * Class label for the startup gate's error-catalogue refusal: the client's
 * dist declares no class for one or more of the error names CSCB requires
 * (b.jg5 SRJ-102, SRJ-1013). Written by the startup gate.
 */
export const AD_SHIM_CATALOG_INCOMPLETE = 'ad-shim-catalog-incomplete'

/**
 * Canonical class labels emitted by the install check. The not-found and
 * too-old labels are shared with the startup gate; `AD_BELOW_PHASE1_FLOOR` and
 * `AD_SHIM_CATALOG_INCOMPLETE` are not among them, because only the startup
 * gate writes them.
 */
export type InstallCheckClassLabel =
  | typeof AD_SYSTEM_INSTALL_NOT_FOUND
  | typeof AD_SYSTEM_INSTALL_TOO_OLD
  | 'ad-system-install-unreachable'
  | 'ad-version-floor-unreadable'
