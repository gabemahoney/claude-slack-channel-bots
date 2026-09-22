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
# For every `finished` bee in the Bugs, Plans, AND Ideas (top-level) hives it
# flags:
#
# DECISION (b.dw7): idea-hive top-level bees ARE held to the same standard as
# Bugs and Plans. An idea can legitimately be "finished" by being absorbed into
# an Epic/plan that landed — but that is exactly what the branch-(b) closure
# vocabulary already expresses ("fully satisfied by <plan>", "superseded by
# <id>", with a pointer). Absorption is therefore not a reason to exempt the
# hive; it is only a reason the closure note is easy to write. Exempting Ideas/
# would make the b.qps failure mode (finished, nothing on main, no stated
# reason) permanently invisible in the one location where it actually occurred
# seven times. Scope is a stated decision, not an accident of which paths got
# hard-coded.
#
#   * STRANDED TICKET — a finished ticket whose work is NOT reachable from main
#     (no genuine, non-disclaiming commit references its id, and its title does
#     not match a main commit subject) AND whose body carries no recognized
#     closure marker: the explicit out-of-repo marker `## +closed:out-of-repo
#     <path>` naming the artifact changed outside this repo, an explicit
#     no-repro / won't-fix / not-a-bug / superseded / abandoned /
#     satisfied-by-other-work note ("superseded by", "fully satisfied by",
#     "already satisfied"), or the explicit documents-only
#     `## +closed:docs-only` marker (product lives outside any git repo, so no
#     main commit is possible). A body that says the fix is "pending
#     merge/release" or "fixed on branch X" is treated as an ANTI-marker — that
#     is exactly the invalid finished state this guards, and it disqualifies
#     every closure marker above.
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
#               Defaults to the main checkout that owns the Bugs/Plans/Ideas hives
#               (derived from this script's own location). Pass a path to
#               audit a different clone/worktree read-only.
#
# Exit: 0 when clean, non-zero (1) when unexplained stranded work is found.
#
# ============================ CALIBRATION NOTE ============================
# On today's repo this script EXITS 0 with zero findings. There is no known
# expected debt left in either class, so a non-zero exit is a NEW, real finding
# to investigate — not a pre-existing condition to wave past. Read any output
# by finding CLASS, not by ticket id:
#
#   * Stranded finished tickets. A finished ticket is expected to be excused by
#     exactly one of: a genuine main commit (id-referencing or title-matching),
#     the explicit `## +closed:out-of-repo <path>` marker for a fix that landed
#     outside this repo, an explicit
#     no-repro/won't-fix/not-a-bug/superseded/abandoned/satisfied-by-other-work
#     note ("superseded by", "fully satisfied by", "already satisfied"), or the documents-only
#     `## +closed:docs-only` marker for work whose product lives outside any git
#     repo. A finished ticket matching none of these is a real finding. Note the
#     documents-only class exists because the project root itself is not a git
#     repo — Apiary ticket markdown there can be legitimately finished with no
#     main commit possible.
#
#   * Stranded branches. There is no expected stranded-branch debt anymore. The
#     last one (`origin/no-channels`) was retired under b.gkz: its commits were
#     published as tag `archive/no-channels` and the branch was then deleted. A
#     stranded-branch finding now means genuinely new stranded work — unmerged
#     commits that either belong on main or need an archive tag plus deletion.
#
# Do NOT re-list findings here: the script's own output is the inventory, and
# the tracking ticket for any finding is the source of truth for expected vs
# new. (b.gkz is named above only as the historical resolution of the last
# known finding, not as a standing exception to this rule.)
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
# Ideas top-level bees (b.dw7): the Ideas hive root itself, holding bee tickets
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

# OUT-OF-REPO closure marker (b.jpw defect 2, AC-3).
#
# A deliberate, greppable heading that a ticket carries when its fix landed in a
# file OUTSIDE this repository (e.g. `~/startup/start-all.sh`, the bots' append
# system prompt at `~/.claude/channels/slack/system-prompt.md`), so no commit on
# main can ever land it. The heading NAMES the out-of-repo artifact:
#
#     ## +closed:out-of-repo ~/startup/start-all.sh
#
# WHY A MARKER AND NOT THE OLD INFERENCE. Branch (a) used to *infer* an
# out-of-repo closure from prose: a ~/ path "connected to" fix/resolution
# language (same line, or inside a heading whose text named a fix). Two rounds
# of tightening (same-line, then same-section, then excluding the docs-only
# heading) each closed one accidental match and left the shape intact — an
# inference over natural language, which fails in BOTH directions:
#
#   * False positive, the one that matters. b.mqd's body says the out-of-repo
#     mitigation "lives outside this repo in `~/.claude/channels/slack/
#     system-prompt.md` … flagged but NOT actioned here". The sentence states
#     the work was declined; the heuristic read "~/ path + fix language" and
#     returned success. A gate that reads a refusal as a closure is not a gate.
#     No amount of further tightening fixes this, because the prose that says
#     "we did it" and the prose that says "we declined to do it" are lexically
#     the same modulo a negation the matcher cannot see.
#   * Ongoing fragility. Every ticket that merely *quotes* a ~/ path near the
#     word "fix" is a latent accidental pass (b.tso already was one).
#
# So branch (a) becomes a DECLARATION, exactly mirroring the design decision
# already recorded for `## +closed:docs-only` below (see the DOCS_ONLY_MARKER
# comment): an anchored, purpose-built heading beat loose phrasing there for the
# same reason it does here — the token does not occur in ordinary writing, it
# cannot be produced by accident, and it records that a human decided the ticket
# is closed rather than that a regex found two words near each other. Prose
# alone no longer passes a ticket; the author must state the claim.
#
# The heading must be followed by a non-space operand — the marker is required
# to NAME the artifact, so the evidence is specific ("which file?") and reviewable
# rather than a bare "trust me". The operand is intentionally NOT validated as a
# `~/` path: a legitimate out-of-repo product may live at an absolute path or in
# another repo, and the audit has no business enumerating those shapes.
#
# AC-4: the operand is NEVER stat-ed, hashed, or otherwise probed on disk. This
# audit is a release gate that must give the same verdict on any machine; a check
# against the current box's $HOME would pass or fail for reasons having nothing
# to do with the ticket. The marker is self-contained evidence — a signed
# statement by the closer, auditable by reading the ticket — not a filesystem
# measurement.
#
# Design intent, line-based matching: the marker is a plain line-oriented grep,
# so a marker line quoted inside a ``` code fence WOULD match. That is accepted
# deliberately — it mirrors the pre-existing DOCS_ONLY_MARKER's identical
# line-based behavior (out of scope to change here), and the `+closed:out-of-repo`
# token cannot occur by accident except in a ticket that documents this syntax.
# Anyone quoting the syntax in a ticket body should use inline backticks, which
# are not line-anchored headings and therefore do not match.
OUT_OF_REPO_MARKER='^#+[[:space:]]+\+closed:out-of-repo[[:space:]]+[^[:space:]]'
has_out_of_repo_marker() {
  grep -qiE "${OUT_OF_REPO_MARKER}" "$1"
}

# DOCS-ONLY out-of-repo closure marker (defect-1 class).
#
# A deliberate, greppable heading that a documents-only ticket carries when its
# product lives OUTSIDE any git repository (e.g. Apiary ticket markdown under
# Ideas/b.4vj/… at the non-repo project root), so no commit on main can ever
# land it. This is the escape hatch for the "no main commit ⇒ stranded" default,
# for a class the in-repo model genuinely cannot represent.
#
# The marker is a heading line of the exact form (case-insensitive):
#     ## +closed:docs-only
# It is a purpose-built heading for this class. (Note: it does NOT reuse the
# pre-existing branch-(b) alternative `## +closed`, whose ERE `+` quantifies the
# preceding SPACE — that pattern matches `## closed` / `##  closed`, never a
# literal `+closed` heading, so it never recognized this marker. Branch (b) is
# pre-existing and left untouched; this heading is matched only by
# has_docs_only_marker via the anchored DOCS_ONLY_MARKER pattern below.)
# It is deliberately
# hard to trip by accident — it is a section heading, not loose prose, and the
# `+closed:docs-only` token does not occur in ordinary writing. Loose phrases
# like "documents only" or "docs-only" in body text do NOT match; only the
# explicit heading does.
DOCS_ONLY_MARKER='^#+[[:space:]]+\+closed:docs-only\b'
has_docs_only_marker() {
  grep -qiE "${DOCS_ONLY_MARKER}" "$1"
}

# CLOSURE_REASON_PATTERN — branch (b) reason vocabulary.
#
# Each alternative is a REASON a finished ticket legitimately has no main commit.
# All of them share one word-boundary frame: `(^|[^a-z0-9]) … ([^a-z0-9]|$)`.
# ERE has no \b, so boundaries are anchored on non-alnum characters; grep -i
# makes [a-z0-9] cover the uppercase forms, so `## CLOSED WON'T-FIX` matches.
#
# WON'T-FIX SPELLINGS (b.jpw defect 1, AC-1). This alternative used to read
# `wont[ -]?fix` — the one spelling a human almost never writes. b.mqd's own
# owner ruling is headed `## CLOSED WON'T-FIX` and was unmatchable; b.jam was
# flagged as stranded work purely because of its wording, and the operator's
# workaround was to append a second heading spelled `wont-fix` to appease the
# regex. A gate whose accepted vocabulary excludes the common spelling of a
# phrase it claims to accept teaches operators to add boilerplate instead of
# reading the finding. `won('|’)?t[ -]?fix` now covers `wont fix`, `wont-fix`,
# `won't fix`, `won't-fix`, `WON'T-FIX` and the typographic `won’t fix` (U+2019).
# The apostrophe is itself a non-alnum character, but it sits INSIDE the
# alternative, never at an edge, so the surrounding boundary frame is unaffected:
# the left boundary is still tested before `w` and the right boundary after `x`.
# An alternation `('|’)` is used rather than a bracket class so the multi-byte
# U+2019 is matched as one unit regardless of the ambient locale.
#
# NOT-A-BUG / BY DESIGN / WORKS AS INTENDED (b.jpw AC-2 — ADDED, decision
# recorded here). These are recognized closure reasons because they are
# semantically distinct from the two neighbours already in the list:
#   * no-repro   = the reported behaviour could not be OBSERVED.
#   * won't-fix  = the behaviour was observed and a fix was DECLINED.
#   * not-a-bug / by design / works as intended = the behaviour was observed and
#     is CORRECT. Nothing was declined and nothing failed to reproduce.
# Forcing that third verdict to be spelled as one of the first two would make the
# closure note lie about what was decided. The real instance is b.jam (closed
# 2026-09-22): its closure was worded `CLOSED NOT-A-BUG`, the gate refused the
# wording, and the ticket read as stranded work. The hyphenated `not-a-bug` form
# is accepted alongside the spaced one (`not[ -]a[ -]bug`) because that is
# literally how b.jam was written.
#
# SCOPE LIMIT (non-goal, carried from the header): this widens the SPELLINGS of
# phrases on the list and adds three named reasons. It does not loosen the list
# into unanchored prose. The removed `## +closed` alternative — whose ERE `+`
# quantified a space and so silently matched any `## Closed …` heading anywhere
# in a body — is the failure this list exists to avoid; a bare, reasonless
# `## Closed` heading still does NOT satisfy branch (b).
#
# Branch (b) is deliberately PROSE-LEVEL vocabulary, not an anchored marker: it
# matches these phrases wherever they appear in the body, the same way the
# long-standing `superseded by` / `already satisfied` alternatives do. A
# sentence like "I won't fix the typo in passing" therefore DOES match. That is
# accepted, with eyes open: branch (b)'s job is to recognize a stated reason in a
# human-written closure note, and it has never been the load-bearing guard
# against a wrongly-finished ticket — the anti-marker check (which disqualifies
# every branch) and the requirement of a main commit are. Tickets whose closure
# must be unambiguous carry an anchored marker instead: `## +closed:docs-only`
# (branch (c)) or `## +closed:out-of-repo <path>` (branch (a)). The same caveat
# applies to `by design`, which is the most prose-like of the three additions.
CLOSURE_REASON_PATTERN="(^|[^a-z0-9])(no[ -]?repro|not[ -]?reproducible|cannot reproduce|won('|’)?t[ -]?fix|not[ -]a[ -]bug|by design|works as intended|closed as (superseded|abandoned)|superseded by|fully satisfied by|already satisfied)([^a-z0-9]|\$)"

# has_closure_marker <file>
# A recognized, legitimate reason a finished ticket has no main commit:
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

  # (c) documents-only, outside-the-repo-tree closure. Evaluated FIRST so a
  # ticket carrying the explicit `## +closed:docs-only` marker passes for the
  # right reason (the marker). Branches (a) and (c) are now both anchored
  # markers on distinct, non-overlapping tokens, so this ordering is no longer
  # load-bearing the way it was against the old prose heuristic — it is kept so
  # each marker remains the stated reason its own class passes.
  if has_docs_only_marker "$f"; then
    return 0
  fi

  # (a) out-of-repo fix — an explicit marker naming the artifact changed.
  if has_out_of_repo_marker "$f"; then
    return 0
  fi

  # (b) explicit closure note — no-repro / superseded / abandoned / satisfied.
  #
  # The closure vocabulary is deliberately widened to the phrasing actually used
  # by legitimately-closed tickets (b.49f "fully satisfied by", b.vfx
  # "superseded by", b.3kr "already satisfied"), each as a WORD-BOUNDED
  # alternative. awk/ERE have no \b, so boundaries are anchored on non-alnum
  # (^/$ or a non-[a-z0-9] char). grep -i makes the [a-z0-9] class cover the
  # uppercase forms too, so "## CLOSED … superseded by" still matches.
  #
  # The former `## +closed` alternative is REMOVED. Its ERE `+` quantified the
  # preceding SPACE, so it never matched a literal `## +closed` heading — it
  # matched any `## Closed …` heading (case-insensitively, unanchored, even
  # mid-prose), which is exactly the accidental match that silently covered for
  # the missing reason-vocabulary above. Its apparent intent (an explicit
  # closed-heading marker) is now served two ways that are both intentional:
  # the deliberate anchored `## +closed:docs-only` marker (branch (c),
  # has_docs_only_marker) for docs-only work, and these word-bounded
  # reason-vocabulary alternatives for reasoned closures. A bare, reasonless
  # `## Closed` heading must NOT satisfy branch (b) — a closure needs a stated
  # reason, and each alternative carries one. See CLOSURE_REASON_PATTERN.
  if grep -qiE "${CLOSURE_REASON_PATTERN}" "$f"; then
    return 0
  fi

  return 1
}

# ---------------------------------------------------------------------------
# Pass 1 — stranded finished tickets.
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
# b.dw7: Ideas top-level bees, skipping the Plans/ subdirectory already covered
# by the Plans pass above.
audit_hive "${IDEAS_HIVE}" "Ideas" "Plans"

# ---------------------------------------------------------------------------
# Pass 2 — stranded branches.
# ---------------------------------------------------------------------------
# Build a lookup of every finished ticket's base component.
declare -A FINISHED_BASES=()
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
    if [ "${status}" = "finished" ]; then
      FINISHED_BASES["$(base_of_id "${id}")"]="${id}"
    fi
  done
}
collect_statuses "${BUGS_HIVE}"
collect_statuses "${PLANS_HIVE}"
# b.dw7: Ideas top-level tickets so a branch referencing a finished Ideas ticket
# is reconciled (previously tstatus="" ⇒ silently skipped). Skip Plans/ (already
# collected by the Plans call).
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

echo "RESULT: clean — every finished ticket is on main or explicitly closed,"
echo "and no unmerged branch references a finished ticket."
exit 0
