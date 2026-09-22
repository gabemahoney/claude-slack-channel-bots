#!/usr/bin/env bash
#
# /publish SR-7.1 / SR-7.2 — sanitize bun-1.3.13 poison from the operator's
# global package.json before reinstalling claude-slack-channel-bots from
# npm. Removes:
#   - any empty-string ("") dependency key (the bun-1.3.13 artifact)
#   - any pre-existing claude-slack-channel-bots dependency entry (so the
#     reinstall is a clean real-copy install, not a no-op merge against a
#     stale entry from a previous /publish or install-local.sh symlink farm)
#
# This script mirrors the sanitize logic in scripts/install-local.sh on
# purpose — do NOT invent a separate sanitizer.
#
# SUNSET: This script exists to work around a defect in bun 1.3.13's global
# install. When the dev fleet is on a bun release that no longer writes the
# empty-string key (≥ 1.3.14 once that ships) AND no operator still has a
# poisoned global package.json on disk, this file and the publish-promote.sh
# call site should be deleted.
#
# Inputs: none. Reads ${BUN_INSTALL:-$HOME/.bun}/install/global/package.json.
#
# Exit codes:
#   0  always — sanitize is best-effort and never blocks the release.

set -euo pipefail

# This trap deliberately lacks the SR_GUARDED_EXIT guard the other release
# scripts carry (b.vqy): every deliberate exit here is `exit 0` (sanitize is
# best-effort by contract), so the rc-ne-0 test alone already excludes them
# and the trap can only fire on a genuinely unguarded failure.
# shellcheck disable=SC2154
trap 'rc=$?; if [ $rc -ne 0 ]; then echo "SR-99.0 (uncaught): scripts/$(basename "${BASH_SOURCE[0]}") exited with code $rc at command: ${BASH_COMMAND}. The b.1wi contract requires an SR-X.Y diagnostic for every non-zero exit; that diagnostic is missing because the failing command was not wrapped. Operator recovery: report this trap output verbatim — it identifies the unguarded site so the next /publish run can add the missing wrapper. State of the release is indeterminate; do NOT rerun /publish until the operator has assessed." >&2; fi' EXIT

# Runtime sunset check: if bun is past the 1.3.13 defect, the empty-string
# poison can't reproduce. Skip the sanitize (warn once so operators on old
# bun know to upgrade or that the script is now dead).
BUN_VERSION="$(bun --version 2>/dev/null | head -n1 | tr -d '[:space:]' || true)"
if [ -n "${BUN_VERSION}" ]; then
  if BUN_VERSION="${BUN_VERSION}" node -e "
    const v = process.env.BUN_VERSION.split('.').map(Number);
    const t = [1,3,14];
    const cmp = (v[0]-t[0]) || (v[1]-t[1]) || (v[2]-t[2]);
    process.exit(cmp >= 0 ? 0 : 1)
  " 2>/dev/null; then
    echo "[publish] sanitize-global: bun ${BUN_VERSION} is past the 1.3.13 defect — skipping sanitize. (This script and its call site at publish-promote.sh:190 can be deleted once no operator host runs bun < 1.3.14.)" >&2
    exit 0
  fi
fi

# SCOPE (b.r6x, deliberate): this script sanitizes the CANONICAL prefix only —
# `${BUN_INSTALL:-$HOME/.bun}/install/global` — and does not look for, or touch,
# an install living in any other bun prefix, even one that is shadowing this one
# on PATH. Three reasons:
#   1. Purpose. The only job here is to de-poison the manifest that the very next
#      step (publish-promote.sh SR-7.3 `bun install -g`) is about to install
#      into. Promote never installs into any other prefix, so no other prefix's
#      manifest can affect that install.
#   2. Blast radius. This script is best-effort and exits 0 unconditionally, so
#      nothing downstream can react to a mistake it makes. A script with that
#      contract must not mutate state outside the one directory it owns —
#      silently rewriting a manifest in some unrelated prefix would be exactly
#      the sort of unrecoverable side effect the always-exit-0 contract makes
#      invisible.
#   3. Division of labour. Detecting a shadowing install in another prefix is
#      publish-promote.sh's SR-7.0 / SR-7.4 job, and it REPORTS rather than
#      mutates — it names the shadowing path, the PATH shim, and the exact manual
#      remediation, and leaves the deletion to a human.
# The expansion below is correct as written (with BUN_INSTALL unset, ~/.bun is
# bun's default global prefix): b.r6x's defect was the missing shadow check, not
# a miscomputed prefix. Do not "fix" it.
GLOBAL_DIR="${BUN_INSTALL:-$HOME/.bun}/install/global"
GLOBAL_PKG="${GLOBAL_DIR}/package.json"

if [ ! -f "${GLOBAL_PKG}" ]; then
  exit 0
fi

GLOBAL_PKG="${GLOBAL_PKG}" PKG_NAME="claude-slack-channel-bots" bun -e '
  const fs = require("node:fs");
  const p = process.env.GLOBAL_PKG;
  const name = process.env.PKG_NAME;
  const j = JSON.parse(fs.readFileSync(p, "utf8"));
  const changed = [];
  if (j.dependencies) {
    if (Object.prototype.hasOwnProperty.call(j.dependencies, "")) {
      delete j.dependencies[""];
      changed.push("empty-string entry");
    }
    if (name && Object.prototype.hasOwnProperty.call(j.dependencies, name)) {
      delete j.dependencies[name];
      changed.push("pre-existing " + name + " entry");
    }
  }
  if (changed.length) {
    fs.writeFileSync(p, JSON.stringify(j, null, 2) + "\n");
    console.log("[publish] sanitized: " + changed.join(", ") + " in " + p);
  }
' || {
  echo "[publish] sanitize-global: bun -e failed; leaving global package.json untouched and continuing" >&2
  exit 0
}
