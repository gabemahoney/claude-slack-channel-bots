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
 * Class label for a host binary whose version cannot be read: an
 * `ErrSystemInstallUnreachable` of any reason, a resolved version that does
 * not parse (reason `unparseable-version`), or any other failure of the
 * install check's resolver call. Shared with the startup gate.
 */
export const AD_SYSTEM_INSTALL_UNREACHABLE = 'ad-system-install-unreachable'

/**
 * Class label for the installed agent-director client's minimum binary version
 * (`min_binary_version` in its `dist/version-floor.json`) that cannot be
 * resolved, read, parsed or used as a version. Written by the install check.
 */
export const AD_VERSION_FLOOR_UNREADABLE = 'ad-version-floor-unreadable'

/**
 * Canonical class labels emitted by the install check. The not-found,
 * too-old and unreachable labels are shared with the startup gate;
 * `AD_BELOW_PHASE1_FLOOR` and `AD_SHIM_CATALOG_INCOMPLETE` are not among
 * them, because only the startup gate writes them.
 */
export type InstallCheckClassLabel =
  | typeof AD_SYSTEM_INSTALL_NOT_FOUND
  | typeof AD_SYSTEM_INSTALL_TOO_OLD
  | typeof AD_SYSTEM_INSTALL_UNREACHABLE
  | typeof AD_VERSION_FLOOR_UNREADABLE
