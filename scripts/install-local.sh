#!/usr/bin/env bash
# scripts/install-local.sh — install this worktree as the globally-linked CSCB build.
#
# Bun 1.3.13's `bun install -g .` (and the equivalent `bun install -g <local-path>`)
# inserts an invalid empty-string dependency key into the global package.json,
# leaving the install partially valid but blocking subsequent global operations
# with `error: Package "@" has a dependency loop`. See CSCB bug b.6vk and
# upstream oven-sh/bun#24207.
#
# Workaround: use `bun add -g file:<abs-path>`, which registers the dependency
# cleanly. This script runs that form after sanitizing any pre-existing
# empty-string entry the global package.json may already contain from a past
# `bun install -g .` run.
set -euo pipefail

# shellcheck disable=SC2154
trap 'rc=$?; if [ $rc -ne 0 ]; then echo "SR-99.0 (uncaught): scripts/$(basename "${BASH_SOURCE[0]}") exited with code $rc at command: ${BASH_COMMAND}. The b.1wi contract requires an SR-X.Y diagnostic for every non-zero exit; that diagnostic is missing because the failing command was not wrapped. Operator recovery: report this trap output verbatim — it identifies the unguarded site so the next /publish run can add the missing wrapper. State of the release is indeterminate; do NOT rerun /publish until the operator has assessed." >&2; fi' EXIT

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
cd "$repo_root"

if ! pkg_name=$(bun -e 'process.stdout.write(JSON.parse(require("node:fs").readFileSync("package.json","utf8")).name)'); then
  echo "[install-local] failed to read package name from package.json via 'bun -e'. Cannot proceed with the global install. Inspect package.json and the bun installation, then rerun 'scripts/install-local.sh'." >&2
  exit 1
fi

global_dir=${BUN_INSTALL_GLOBAL:-${BUN_INSTALL:-$HOME/.bun}/install/global}
global_pkg=$global_dir/package.json

if [[ -f "$global_pkg" ]]; then
  # Strip the bun-1.3.13 empty-string poison entry, and also strip a
  # pre-existing entry for this package so the re-add doesn't leave a
  # duplicate JSON key behind (bun appends rather than replaces).
  GLOBAL_PKG=$global_pkg PKG_NAME=$pkg_name bun -e '
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
      console.log("[install-local] sanitized: " + changed.join(", ") + " in " + p);
    }
  ' || {
    echo "[install-local] sanitize bun -e failed; leaving global package.json untouched and exiting without installing. Inspect $global_pkg manually for the bun-1.3.13 empty-string-key poison, then rerun 'scripts/install-local.sh'." >&2
    exit 0
  }
fi

echo "[install-local] running: bun add -g file:$repo_root"
exec bun add -g "file:$repo_root"
