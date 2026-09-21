#!/usr/bin/env bash
#
# scripts/audit-finished-tickets.sh — read-only stranded-work reconciliation.
#
# Guardrail for bug b.jaa: a bee must not sit in `finished` while the work it
# describes is neither on `main` nor explicitly closed (ops-only / no-repro /
# superseded, with a pointer). This proved to bite once (b.qps: a finished
# bug's fix lived only on an unmerged branch for months while main kept the
# bug). This script is the cheap enforcement half of the guardrail.
#
# For every `finished` bee in the Bugs and Plans hives it flags:
#
#   * STRANDED TICKET — a finished ticket whose work is NOT reachable from main
#     (no genuine, non-disclaiming commit references its id, and its title does
#     not match a main commit subject) AND whose body carries no recognized
#     closure marker (out-of-repo fix naming a ~/ path + fix language, or an
#     explicit no-repro / superseded / abandoned note). A body that says the
#     fix is "pending merge/release" or "fixed on branch X" is treated as an
#     ANTI-marker — that is exactly the invalid finished state this guards.
#
#   * STRANDED BRANCH — any local/remote branch whose name references a
#     `finished` ticket id but whose head is NOT an ancestor of main; plus any
#     unmerged branch that references no known ticket at all (e.g. no-channels).
#
# READ-ONLY. This script never writes the bees DB, never mutates a ticket, and
# never touches git state (no fetch/checkout/branch ops — only git log, git
# branch, git for-each-ref, git merge-base --is-ancestor, git rev-parse). Hive
# markdown is parsed directly; the bees CLI is NOT required at runtime.
#
# Usage:  scripts/audit-finished-tickets.sh [REPO_ROOT]
#   REPO_ROOT   git repo whose `main` and branches are inspected.
#               Defaults to the main checkout that owns the Bugs/Plans hives
#               (derived from this script's own location). Pass a path to
#               audit a different clone/worktree read-only.
#
# Exit: 0 when clean, non-zero (1) when unexplained stranded work is found.
#
# ============================ CALIBRATION NOTE ============================
# On today's repo this script EXITS NON-ZERO BY DESIGN, and that is NOT a bug
# in this script. Stranded finished tickets are clean (none). The remaining
# debt is one class of finding: a stranded remote branch whose resolution
# requires a push and is therefore reserved for the repo owner — currently
# `origin/no-channels`, tracked on ticket b.gkz and pending the owner's
# decision. A non-zero exit is the correct, expected result until b.gkz lands.
# Do NOT re-list findings here; the script's own output is the inventory, and
# the tracking ticket is the source of truth for what is expected vs. new.
# =========================================================================

set -euo pipefail

# ---------------------------------------------------------------------------
# Locate the hives and the repo under audit.
# ---------------------------------------------------------------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# The hives live one level above the repo checkout:
#   <project>/Bugs
#   <project>/Ideas/Plans
#   <project>/<repo-checkout>/scripts/audit-finished-tickets.sh
# Derive <project> from this script's own location so the audit reads the real
# hives regardless of the invocation CWD or which worktree it runs from.
REPO_OF_SCRIPT="$(cd "${SCRIPT_DIR}/.." && pwd)"
PROJECT_DIR="$(cd "${REPO_OF_SCRIPT}/.." && pwd)"

BUGS_HIVE="${PROJECT_DIR}/Bugs"
PLANS_HIVE="${PROJECT_DIR}/Ideas/Plans"

if [ ! -d "${BUGS_HIVE}" ] || [ ! -d "${PLANS_HIVE}" ]; then
  echo "audit-finished-tickets: could not locate hives. Expected:" >&2
  echo "  Bugs  hive at ${BUGS_HIVE}" >&2
  echo "  Plans hive at ${PLANS_HIVE}" >&2
  echo "Derived project dir '${PROJECT_DIR}' from script location '${SCRIPT_DIR}'." >&2
  echo "This script must live in scripts/ of a repo checked out beside the hives." >&2
  exit 2
fi

# Repo whose git refs/history we inspect (read-only). Defaults to the checkout
# that owns the hives, NOT the worktree the script may be running from — so the
# audit always reflects the canonical main history.
REPO_ROOT="${1:-${PROJECT_DIR}/claude-slack-channel-bots-main}"
if [ ! -d "${REPO_ROOT}/.git" ] && [ ! -f "${REPO_ROOT}/.git" ]; then
  # Fall back to the script's own repo if the conventional main checkout is absent.
  REPO_ROOT="${REPO_OF_SCRIPT}"
fi
if ! git -C "${REPO_ROOT}" rev-parse --git-dir >/dev/null 2>&1; then
  echo "audit-finished-tickets: '${REPO_ROOT}' is not a git repo. Pass a valid REPO_ROOT." >&2
  exit 2
fi

git_main() { git -C "${REPO_ROOT}" "$@"; }

if ! git_main rev-parse --verify main >/dev/null 2>&1; then
  echo "audit-finished-tickets: no 'main' ref in ${REPO_ROOT}; cannot reconcile against main." >&2
  exit 2
fi

# ---------------------------------------------------------------------------
# Pre-compute git history projections once (cheap, read-only).
# ---------------------------------------------------------------------------
# Full commit messages on main, one record per commit, NUL/RS delimited so a
# multi-line body stays in a single awk record.
MAIN_LOG_FULL="$(git_main log main --format='%H%x1e%B%x1f')"
# Normalized main subject lines (lowercase, alnum-collapsed) for title matching.
# Normalize PER LINE so newlines are preserved as record separators — a 4-gram
# must occur within a single commit subject, never straddling the tail of one
# subject and the head of the next. (A whole-stream `tr -cs 'a-z0-9' ' '` would
# collapse the newlines into spaces and let a false 4-word run span subjects.)
MAIN_SUBJECTS_NORM="$(git_main log main --format='%s' \
  | tr '[:upper:]' '[:lower:]' \
  | sed -E 's/[^a-z0-9]+/ /g')"

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

# base_of_id b.qps -> qps  (the id component branches/subtasks share). Handles
# ids of any length (b.qps, b.abcd, ...), not just 3 chars, and lowercases so
# the base is consistent with the lowercased tokens branch_base extracts.
base_of_id() {
  local id="${1#b.}"
  printf '%s' "${id}" | tr '[:upper:]' '[:lower:]'
}

# frontmatter_field <file> <key>  -> value (first match), quotes stripped
frontmatter_field() {
  awk -v key="$2" '
    /^---[[:space:]]*$/ { fm = (fm ? 2 : 1); next }
    fm == 1 {
      if ($0 ~ "^" key ":") {
        sub("^" key ":[[:space:]]*", "")
        gsub(/^["'"'"']|["'"'"']$/, "")
        print
        exit
      }
    }
  ' "$1"
}

# landed_evidence <base>
# Prints the count of commits on main that reference this ticket id (anchored so
# a 3-char base only matches inside a real "<b|tN>.<base>" id, never as a random
# substring) AND are NOT disclaimers. A disclaimer is a commit that names the id
# only to say it was re-implemented elsewhere / predates / no longer applies /
# is superseded / is mere lineage — i.e. does NOT actually land the ticket.
landed_evidence() {
  local base="$1"
  awk -v RS='\x1f' \
      -v pat="[bt][0-9]*[.]${base}([^A-Za-z0-9]|\$)" '
    {
      body = $0
      if (body !~ pat) next
      low = tolower(body)
      # Disclaimer signals — commit references the id without delivering it.
      if (low ~ /lineage/) next
      if (low ~ /predate/) next
      if (low ~ /prior to/) next
      if (low ~ /no longer applies/) next
      if (low ~ /does not apply/) next
      if (low ~ /superseded/) next
      c++
    }
    END { print c + 0 }
  ' <<< "${MAIN_LOG_FULL}"
}

# title_landed <title>
# Returns 0 (true) if a run of 4 consecutive significant title words appears in
# some main commit subject — catches early, id-untagged fixes whose commit
# subject echoes the ticket title (e.g. b.own). Deliberately requires a 4-word
# run so it does not fire on a single shared keyword.
title_landed() {
  local title_norm
  title_norm="$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]' | tr -cs 'a-z0-9' ' ')"
  # shellcheck disable=SC2206
  local words=(${title_norm})
  local n=${#words[@]}
  local i w
  for (( i = 0; i + 3 < n; i++ )); do
    w="${words[i]} ${words[i+1]} ${words[i+2]} ${words[i+3]}"
    if grep -qF -- "${w}" <<< "${MAIN_SUBJECTS_NORM}"; then
      return 0
    fi
  done
  return 1
}

# has_anti_marker <file>
# The body claims the fix is "pending merge/release" or "fixed on branch X" —
# an IN-repo unmerged pointer. This is the invalid finished state b.jaa targets;
# it must never count as a valid closure.
has_anti_marker() {
  grep -qiE 'pending[ -]?(merge|release)|fixed on branch|on branch b\.' "$1"
}

# has_closure_marker <file>
# A recognized, legitimate reason a finished ticket has no main commit:
#   (a) out-of-repo resolution — a ~/ path (startup/.claude/.agent-director)
#       paired with fix/resolution/doc-fix language, or
#   (b) an explicit no-repro / superseded / abandoned closure note.
# Anti-markers disqualify both — "superseded AND FIXED on branch, pending
# release" is stranded work, not a closure.
has_closure_marker() {
  local f="$1"
  has_anti_marker "$f" && return 1

  # (a) out-of-repo fix
  if grep -qE '~/(\.claude|startup|\.agent-director)' "$f" \
     && grep -qiE '\*\*fix|fixed in|fix direction|proposed fix|resolved|resolution|doc fix|purely a doc' "$f"; then
    return 0
  fi

  # (b) no-repro / superseded / abandoned closure
  if grep -qiE 'no[ -]?repro|not[ -]?reproducible|cannot reproduce|wont[ -]?fix|closed as (superseded|abandoned)|## +closed' "$f"; then
    return 0
  fi

  return 1
}

# ---------------------------------------------------------------------------
# Pass 1 — stranded finished tickets.
# ---------------------------------------------------------------------------
STRANDED_TICKETS=()

audit_hive() {
  local hive="$1" hive_label="$2"
  local d id status base file
  for d in "${hive}"/*/; do
    [ -d "${d}" ] || continue
    id="$(basename "${d}")"
    file="${d}${id}.md"
    [ -f "${file}" ] || continue

    status="$(frontmatter_field "${file}" status)"
    [ "${status}" = "finished" ] || continue

    base="$(base_of_id "${id}")"

    # Landed if a genuine (non-disclaiming) commit references it, or its title
    # matches a main commit subject.
    if [ "$(landed_evidence "${base}")" -gt 0 ]; then
      continue
    fi
    if title_landed "$(frontmatter_field "${file}" title)"; then
      continue
    fi

    # Not landed. A legitimate closure marker excuses it; otherwise it's stranded.
    if has_closure_marker "${file}"; then
      continue
    fi

    local reason="finished, but no commit on main lands it"
    if has_anti_marker "${file}"; then
      reason="finished with an in-repo 'pending merge / fixed on branch' note — the fix never reached main"
    fi
    STRANDED_TICKETS+=("${id}|${hive_label}|${reason}")
  done
}

audit_hive "${BUGS_HIVE}"  "Bugs"
audit_hive "${PLANS_HIVE}" "Plans"

# ---------------------------------------------------------------------------
# Pass 2 — stranded branches.
# ---------------------------------------------------------------------------
# Build a lookup of every finished ticket's base component.
declare -A FINISHED_BASES=()
declare -A ID_STATUS=()
collect_statuses() {
  local hive="$1" d id status id_key
  for d in "${hive}"/*/; do
    [ -d "${d}" ] || continue
    id="$(basename "${d}")"
    [ -f "${d}${id}.md" ] || continue
    status="$(frontmatter_field "${d}${id}.md" status)"
    # Key ID_STATUS by the lowercased id so the branch-side lookup — which uses
    # the lowercased token from branch_base — resolves regardless of ref case.
    id_key="$(printf '%s' "${id}" | tr '[:upper:]' '[:lower:]')"
    ID_STATUS["${id_key}"]="${status}"
    if [ "${status}" = "finished" ]; then
      FINISHED_BASES["$(base_of_id "${id}")"]="${id}"
    fi
  done
}
collect_statuses "${BUGS_HIVE}"
collect_statuses "${PLANS_HIVE}"

STRANDED_BRANCHES=()

# Extract a b.xxx id (lowercased, e.g. b.e3f / b.abcd) from a branch ref name.
branch_base() {
  # matches feature/b.e3f, fix/b.k54-trust-dialog, feature/b.abcd, b_oaj,
  # b.a3g, origin/b.a3g, FEATURE/B.E3F ...
  local ref="$1" match
  # Grammar: b<sep><alnum id of 3+ chars> with a proper right boundary — the
  # alnum run is matched whole ( {3,} is greedy ) so a 4+-char id like
  # 'abcd' is captured in full, never truncated to 'abc'; the run naturally
  # stops at the first non-[a-z0-9] char (e.g. the '-' in b.k54-trust-dialog)
  # or end of ref. Case-insensitive match; lowered below so the ID_STATUS /
  # FINISHED_BASES lookups (keyed by lowercase ids) resolve.
  match="$(printf '%s' "${ref}" | grep -oiE 'b[._][a-z0-9]{3,}' | head -1 || true)"
  match="${match//_/.}"
  printf '%s' "${match}" | tr '[:upper:]' '[:lower:]'
}

while IFS= read -r ref; do
  [ -n "${ref}" ] || continue
  # Skip HEAD symbolic refs and main itself.
  case "${ref}" in
    */HEAD|refs/heads/main|refs/remotes/origin/main) continue ;;
  esac

  sha="$(git_main rev-parse "${ref}" 2>/dev/null || true)"
  [ -n "${sha}" ] || continue

  # Only unmerged branches are interesting.
  if git_main merge-base --is-ancestor "${sha}" main 2>/dev/null; then
    continue
  fi

  tok="$(branch_base "${ref}")"        # e.g. b.e3f  (or empty)
  short="${ref#refs/heads/}"
  short="${short#refs/remotes/}"

  if [ -n "${tok}" ]; then
    tstatus="${ID_STATUS[${tok}]:-}"
    if [ "${tstatus}" = "finished" ]; then
      STRANDED_BRANCHES+=("${short}|references finished ticket ${tok}; head is not an ancestor of main")
    fi
    # Branches for non-finished tickets (e.g. b.a3g status=worker) are NOT
    # flagged — the ticket is still open work.
  else
    STRANDED_BRANCHES+=("${short}|unmerged and references no known ticket")
  fi
done <<< "$(git_main for-each-ref --format='%(refname)' refs/heads refs/remotes)"

# ---------------------------------------------------------------------------
# Report
# ---------------------------------------------------------------------------
echo "=== Finished-ticket reconciliation audit ==="
echo "Repo under audit : ${REPO_ROOT}"
echo "Bugs hive        : ${BUGS_HIVE}"
echo "Plans hive       : ${PLANS_HIVE}"
echo

FOUND=0

echo "--- Stranded finished tickets ---"
if [ "${#STRANDED_TICKETS[@]}" -eq 0 ]; then
  echo "  (none)"
else
  FOUND=1
  for entry in "${STRANDED_TICKETS[@]}"; do
    IFS='|' read -r id hive reason <<< "${entry}"
    printf '  [%s] %-6s %s\n' "${hive}" "${id}" "${reason}"
  done
fi
echo

echo "--- Stranded branches ---"
if [ "${#STRANDED_BRANCHES[@]}" -eq 0 ]; then
  echo "  (none)"
else
  FOUND=1
  for entry in "${STRANDED_BRANCHES[@]}"; do
    IFS='|' read -r name reason <<< "${entry}"
    printf '  %-40s %s\n' "${name}" "${reason}"
  done
fi
echo

if [ "${FOUND}" -ne 0 ]; then
  echo "RESULT: stranded work found. Resolve it (land the fix, or explicitly"
  echo "close the ticket as no-repro/superseded/abandoned with a pointer, or"
  echo "delete the merged/dead branch) before releasing."
  exit 1
fi

echo "RESULT: clean — every finished ticket is on main or explicitly closed,"
echo "and no unmerged branch references a finished ticket."
exit 0
