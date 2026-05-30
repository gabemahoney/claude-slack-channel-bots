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
# poisoned global package.json on disk, this file and the publish.sh call
# site should be deleted.
#
# Inputs: none. Reads ${BUN_INSTALL:-$HOME/.bun}/install/global/package.json.
#
# Exit codes:
#   0  always — sanitize is best-effort and never blocks the release.

set -euo pipefail

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
'
