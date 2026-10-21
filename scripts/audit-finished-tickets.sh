#!/usr/bin/env bash
#
# scripts/audit-finished-tickets.sh — read-only stranded-work reconciliation.
#
# Pre-release gate (SR-2.6): audit `done` tickets and legacy `finished`
# tickets in the Bugs, Plans and top-level Ideas hives. Ideas/Bugs become done
# on acceptance BEFORE teardown-worktree merges them. Acceptance is valid
# before merge; release requires the accepted work to have reached main.
# `invalid` Bugs need no merge and are excluded from both passes.
#
# STRANDED TICKET: no genuine ID-referencing main commit or matching title,
# and no recognized closure reason or heading. Closure headings are
# `## +closed:out-of-repo <path>` and `## +closed:docs-only`; reason phrases
# are defined in CLOSURE_REASON_PATTERN. Pending-merge / fixed-on-branch notes
# disqualify closure markers when main-commit/title evidence is absent.
# Ideas absorbed into other work need the same landing or closure evidence.
#
# STRANDED BRANCH: an unmerged local/remote branch referencing a done/finished
# ticket, even if its ticket has landing or closure evidence; also an unmerged
# branch with no recognized ticket-ID token. A recognized token with no ticket
# is not flagged. Draft/defined/active tickets are still open work.
#
# READ-ONLY: no ticket writes, fetch, checkout or ref changes. The script reads
# hive Markdown directly and inspects local git history/refs; no bees CLI needed.
# Findings are data to investigate, never a reason to change ticket statuses
# merely to pass the gate. No standing clean baseline is assumed.
#
# Usage: scripts/audit-finished-tickets.sh [REPO_ROOT]
# Hives are located beside this script's checkout. REPO_ROOT changes only the
# git repository inspected, not the hive location. A nested worktree therefore
# needs the canonical checkout location for hive discovery.
# Exit: 0 clean; 1 stranded work; 2 missing hives, git repository or main ref.

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
# hives regardless of the invocation CWD. Nested worktrees are not beside them.
REPO_OF_SCRIPT="$(cd "${SCRIPT_DIR}/.." && pwd)"
PROJECT_DIR="$(cd "${REPO_OF_SCRIPT}/.." && pwd)"

BUGS_HIVE="${PROJECT_DIR}/Bugs"
PLANS_HIVE="${PROJECT_DIR}/Ideas/Plans"
# Ideas top-level tickets (b.dw7): the Ideas hive root itself, holding Ideas
# at Ideas/<id>/. Distinct from PLANS_HIVE (Ideas/Plans/), which the Plans pass
# already covers; the Ideas pass skips that subdirectory so nothing is
# double-reported.
IDEAS_HIVE="${PROJECT_DIR}/Ideas"

if [ ! -d "${BUGS_HIVE}" ] || [ ! -d "${PLANS_HIVE}" ] || [ ! -d "${IDEAS_HIVE}" ]; then
  echo "audit-finished-tickets: could not locate hives. Expected:" >&2
  echo "  Bugs  hive at ${BUGS_HIVE}" >&2
  echo "  Plans hive at ${PLANS_HIVE}" >&2
  echo "  Ideas hive at ${IDEAS_HIVE}" >&2
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

# Apiary acceptance (`done`) and legacy closure (`finished`) share this gate.
is_closed_work() {
  case "$1" in
    done|finished) return 0 ;;
    *) return 1 ;;
  esac
}

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
# an in-repo unmerged pointer. Accepted work may await merge, but that note
# cannot excuse missing landing evidence at release time.
has_anti_marker() {
  grep -qiE 'pending[ -]?(merge|release)|fixed on branch|on branch b\.' "$1"
}

# An out-of-repo closure declares the changed artifact, with a required
# non-space operand: `## +closed:out-of-repo <path>`. The operand is not probed
# on disk; the verdict depends on the recorded declaration, not this machine.
# Matching is line-based and case-insensitive, including inside code fences.
# Quote example headings inline in tickets so they do not count as evidence.
OUT_OF_REPO_MARKER='^#+[[:space:]]+\+closed:out-of-repo[[:space:]]+[^[:space:]]'
has_out_of_repo_marker() {
  grep -qiE "${OUT_OF_REPO_MARKER}" "$1"
}

# Documents-only closure for a product outside every git repository, such as
# Apiary ticket Markdown in the Project Folder: `## +closed:docs-only`.
# Only the explicit heading matches, not loose "docs-only" prose.
DOCS_ONLY_MARKER='^#+[[:space:]]+\+closed:docs-only\b'
has_docs_only_marker() {
  grep -qiE "${DOCS_ONLY_MARKER}" "$1"
}

# Closure reasons match case-insensitive, word-bounded body text. Won't-fix
# accepts straight/typographic/no apostrophe and an optional space or hyphen.
# No-repro, declined fixes and correct behavior are distinct closure reasons.
# Bare `Closed` headings do not qualify. Phrases can match incidental prose;
# use an anchored heading when a declaration must be unambiguous.
CLOSURE_REASON_PATTERN="(^|[^a-z0-9])(no[ -]?repro|not[ -]?reproducible|cannot reproduce|won('|’)?t[ -]?fix|not[ -]a[ -]bug|by design|works as intended|closed as (superseded|abandoned)|superseded by|fully satisfied by|already satisfied)([^a-z0-9]|\$)"

# has_closure_marker <file>
# A recognized, legitimate reason a closed-work ticket has no main commit:
#   (a) an explicit out-of-repo closure marker naming the artifact that was
#       changed (`## +closed:out-of-repo ~/startup/start-all.sh`; see
#       has_out_of_repo_marker) — for fixes that landed outside this repo, or
#   (b) an explicit no-repro / not-reproducible / cannot-reproduce / won't-fix /
#       not-a-bug / by-design / works-as-intended / "closed as
#       superseded|abandoned" / "superseded by" / "fully satisfied by" /
#       "already satisfied" closure note (see CLOSURE_REASON_PATTERN), or
#   (c) an explicit documents-only, outside-the-repo-tree closure marker
#       (`## +closed:docs-only`; see has_docs_only_marker) — for tickets whose
#       product is markdown/docs living outside any git repo.
# Anti-markers disqualify ALL of them — a body that says "documents-only" AND
# "fixed on branch b.x, pending merge" is stranded work, not a closure.
has_closure_marker() {
  local f="$1"
  has_anti_marker "$f" && return 1

  # (c) documents-only product outside every git repository.
  if has_docs_only_marker "$f"; then
    return 0
  fi

  # (a) out-of-repo fix — an explicit marker naming the artifact changed.
  if has_out_of_repo_marker "$f"; then
    return 0
  fi

  # (b) explicit closure note — no-repro / superseded / abandoned / satisfied.
  #
  # A reasonless Closed heading does not qualify.
  if grep -qiE "${CLOSURE_REASON_PATTERN}" "$f"; then
    return 0
  fi

  return 1
}

# ---------------------------------------------------------------------------
# Pass 1 — stranded closed-work tickets (done or legacy finished).
# ---------------------------------------------------------------------------
STRANDED_TICKETS=()

# audit_hive <hive> <hive_label> [skip_subdir]
# Optional third arg names a subdirectory basename to skip (b.dw7): the Ideas
# pass passes "Plans" so Ideas/Plans/ is not re-audited by both the Plans pass
# and the Ideas pass. Not relied upon by accident — Ideas/Plans/Plans.md does
# not exist so audit_hive would skip it anyway — but the skip is explicit so
# scope is a stated decision.
audit_hive() {
  local hive="$1" hive_label="$2" skip_subdir="${3:-}"
  local d id status base file
  for d in "${hive}"/*/; do
    [ -d "${d}" ] || continue
    id="$(basename "${d}")"
    # Explicit no-double-report guard (b.dw7): skip the named subdir hive.
    [ -n "${skip_subdir}" ] && [ "${id}" = "${skip_subdir}" ] && continue
    file="${d}${id}.md"
    [ -f "${file}" ] || continue

    status="$(frontmatter_field "${file}" status)"
    is_closed_work "${status}" || continue

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

    local reason="${status}, but no commit on main lands it"
    if has_anti_marker "${file}"; then
      reason="${status} with an in-repo 'pending merge / fixed on branch' note — the fix never reached main"
    fi
    STRANDED_TICKETS+=("${id}|${hive_label}|${reason}")
  done
}

audit_hive "${BUGS_HIVE}"  "Bugs"
audit_hive "${PLANS_HIVE}" "Plans"
# b.dw7: Ideas top-level tickets, skipping the Plans/ subdirectory already covered
# by the Plans pass above.
audit_hive "${IDEAS_HIVE}" "Ideas" "Plans"

# ---------------------------------------------------------------------------
# Pass 2 — stranded branches.
# ---------------------------------------------------------------------------
# Build a status lookup for every known ticket.
declare -A ID_STATUS=()
# collect_statuses <hive> [skip_subdir]
# Optional skip_subdir (b.dw7): same no-double-count guard as audit_hive. The
# Ideas pass passes "Plans" so Ideas/Plans/ statuses are collected once (by the
# Plans call), not twice. Explicit rather than relying on Ideas/Plans/Plans.md
# being absent. Ideas/index.md is a file, not a dir, so the [ -d ] check already
# skips it.
collect_statuses() {
  local hive="$1" skip_subdir="${2:-}" d id status id_key
  for d in "${hive}"/*/; do
    [ -d "${d}" ] || continue
    id="$(basename "${d}")"
    [ -n "${skip_subdir}" ] && [ "${id}" = "${skip_subdir}" ] && continue
    [ -f "${d}${id}.md" ] || continue
    status="$(frontmatter_field "${d}${id}.md" status)"
    # Key ID_STATUS by the lowercased id so the branch-side lookup — which uses
    # the lowercased token from branch_base — resolves regardless of ref case.
    id_key="$(printf '%s' "${id}" | tr '[:upper:]' '[:lower:]')"
    ID_STATUS["${id_key}"]="${status}"
  done
}
collect_statuses "${BUGS_HIVE}"
collect_statuses "${PLANS_HIVE}"
# Include top-level Ideas; skip Plans/ (collected by the Plans call).
collect_statuses "${IDEAS_HIVE}" "Plans"

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
  # or end of ref. Case-insensitive match; lowered for the ID_STATUS lookup.
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
    if is_closed_work "${tstatus}"; then
      STRANDED_BRANCHES+=("${short}|references ${tstatus} ticket ${tok}; head is not an ancestor of main")
    fi
    # Open tickets and invalid Bugs require no merge. Unknown ticket IDs
    # are also left alone; this pass checks only known closed-work tickets.
  else
    STRANDED_BRANCHES+=("${short}|unmerged and references no known ticket")
  fi
done <<< "$(git_main for-each-ref --format='%(refname)' refs/heads refs/remotes)"

# ---------------------------------------------------------------------------
# Report
# ---------------------------------------------------------------------------
echo "=== Finished-ticket reconciliation audit ==="
echo "Selected statuses: done, finished (legacy); invalid Bugs excluded"
echo "Repo under audit : ${REPO_ROOT}"
echo "Bugs hive        : ${BUGS_HIVE}"
echo "Plans hive       : ${PLANS_HIVE}"
echo "Ideas hive       : ${IDEAS_HIVE}"
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
  echo "close the ticket as no-repro / won't-fix / not-a-bug / by design /"
  echo "works as intended / superseded / abandoned / satisfied-by-other-work,"
  echo "with a pointer, or add an anchored closure marker heading"
  echo "'## +closed:docs-only' or '## +closed:out-of-repo <path>', or"
  echo "delete the merged/dead branch) before releasing."
  exit 1
fi

echo "RESULT: clean — every done/finished ticket is on main or explicitly closed,"
echo "and no unmerged branch references a done/finished ticket."
exit 0
