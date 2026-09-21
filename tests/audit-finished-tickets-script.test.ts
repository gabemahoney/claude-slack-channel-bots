/**
 * audit-finished-tickets-script.test.ts — coverage for
 * scripts/audit-finished-tickets.sh (bug b.jaa guardrail).
 *
 * The script is a read-only stranded-work reconciliation: for every `finished`
 * bee in the Bugs/Plans hives it flags tickets whose fix is neither on main nor
 * explicitly closed, plus unmerged branches referencing finished tickets. It
 * exits non-zero when stranded work is found, zero when clean.
 *
 * Testing strategy — FIXTURES, no real repo/hives touched:
 *   The script derives its hive paths (<project>/Bugs, <project>/Ideas/Plans)
 *   and its default REPO_ROOT from its OWN on-disk location (BASH_SOURCE), and
 *   takes REPO_ROOT as an optional $1. There is no env/arg override for the
 *   hive paths. So each test builds a self-contained fixture *project* tree:
 *
 *       <proj>/<repo>/scripts/audit-finished-tickets.sh   (copy of the script)
 *       <proj>/Bugs/<id>/<id>.md                          (fixture tickets)
 *       <proj>/Ideas/Plans/<id>/<id>.md
 *
 *   and a real scratch git repo at <proj>/<repo> with a `main` branch. The
 *   copied script then resolves BUGS_HIVE/PLANS_HIVE from its copied location
 *   and audits the scratch git history. We invoke it as
 *   `bash <copied-script> <repo>` so REPO_ROOT points at the fixture repo.
 *
 * Follows repo conventions (see tests/stop-hook-bootstrap.test.ts):
 *   - mkdtempSync per-test temp dirs, afterEach rmSync cleanup
 *   - spawnSync for the subprocess, real fs, no mocks
 *   - absolute script path via fileURLToPath so CWD is irrelevant
 *
 * Regression sentinel: the test
 *   "finished ticket with no main commit and no closure marker → flagged"
 * FAILS if the flagging logic is removed/broken (script would exit 0) and
 * PASSES with the guardrail intact.
 *
 * SPDX-License-Identifier: MIT
 */

import { describe, test, expect, afterEach } from 'bun:test'
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  copyFileSync,
  rmSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

/** Absolute path to the script under test — CWD-independent. */
const SCRIPT_SRC = fileURLToPath(
  new URL('../scripts/audit-finished-tickets.sh', import.meta.url),
)

/**
 * Absolute path to this worktree's repo root (the checkout that holds the
 * post-fix script in its working tree and the PRE-fix script at git HEAD). Used
 * only by the regression-proof test to recover the committed pre-fix source.
 */
const WORKTREE_ROOT = fileURLToPath(new URL('..', import.meta.url))

const cleanups: Array<() => void> = []
afterEach(() => {
  while (cleanups.length) cleanups.pop()!()
})

/** git helper that runs in the fixture repo and throws on failure. */
function git(repo: string, args: string[]): string {
  const r = spawnSync('git', args, {
    cwd: repo,
    encoding: 'utf8',
    // Let the machine's managed git identity hook/helper resolve author &
    // committer from the repo-local `identity.account` we declare below — do
    // not force GIT_AUTHOR_*/GIT_COMMITTER_* here or the pre-commit identity
    // hook rejects the mismatch.
    env: { ...process.env },
  })
  if (r.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`)
  }
  return r.stdout
}

interface Ticket {
  id: string
  hive: 'Bugs' | 'Plans'
  status: string
  title?: string
  body?: string
}

interface Fixture {
  proj: string
  repo: string
  script: string
}

/**
 * Build a fixture project tree with a scratch git repo and the given tickets.
 * `commitSubjects` become individual commits on `main` (in order) so tests can
 * simulate a landed fix by naming the ticket id / title in a subject or body.
 */
function makeFixture(opts: {
  tickets: Ticket[]
  commits?: Array<{ subject: string; body?: string }>
  /**
   * Name of the repo checkout dir under <proj>. Defaults to 'repo'. Pass
   * 'claude-slack-channel-bots-main' to exercise the script's default-REPO_ROOT
   * fallback (invoked with NO $1, the script derives this conventional checkout).
   */
  repoName?: string
}): Fixture {
  const proj = mkdtempSync(join(tmpdir(), 'audit-fix-'))
  cleanups.push(() => rmSync(proj, { recursive: true, force: true }))

  const repo = join(proj, opts.repoName ?? 'repo')
  const scriptsDir = join(repo, 'scripts')
  mkdirSync(scriptsDir, { recursive: true })
  const script = join(scriptsDir, 'audit-finished-tickets.sh')
  copyFileSync(SCRIPT_SRC, script)

  // Both hive roots must exist or the script exits 2 ("could not locate hives"),
  // even when a test only populates one of them.
  mkdirSync(join(proj, 'Bugs'), { recursive: true })
  mkdirSync(join(proj, 'Ideas', 'Plans'), { recursive: true })

  // Hives beside the repo, as the script expects (<project>/{Bugs,Ideas/Plans}).
  for (const t of opts.tickets) {
    const hiveRoot =
      t.hive === 'Bugs' ? join(proj, 'Bugs') : join(proj, 'Ideas', 'Plans')
    const dir = join(hiveRoot, t.id)
    mkdirSync(dir, { recursive: true })
    const title = t.title ?? `fixture ticket ${t.id}`
    const fm = [
      '---',
      `id: ${t.id}`,
      'type: bee',
      `title: ${JSON.stringify(title)}`,
      `status: ${t.status}`,
      "schema_version: '0.1'",
      '---',
      '',
      t.body ?? `# ${title}\n`,
      '',
    ].join('\n')
    writeFileSync(join(dir, `${t.id}.md`), fm)
  }

  // Scratch git repo with a main branch and at least one commit.
  git(repo, ['init', '-q'])
  // Pin a repo-local identity so fixture commits resolve to a sanctioned
  // account (repo-local `identity.account` wins first in the resolution order;
  // see ~/.claude/skills/github-config/SKILL.md) — NOT a hook bypass, the
  // machine's pre-commit identity hook still runs and passes. The neutral
  // placeholder email keeps a real address out of a checked-in fixture; the
  // hook self-corrects it on the first commit (see the retry-once below).
  git(repo, ['config', 'identity.account', 'work'])
  git(repo, ['config', 'user.name', 'Fixture'])
  git(repo, ['config', 'user.email', 'fixture@example.com'])
  git(repo, ['checkout', '-q', '-b', 'main'])
  writeFileSync(join(repo, 'README'), 'fixture\n')
  git(repo, ['add', 'README'])
  // Retry-once: on identity-enforcing hosts the pre-commit hook sees the
  // placeholder user.email as a config value (not an env/CLI override), so per
  // github-config SKILL.md outcome #2 it rewrites the repo's user.email to the
  // resolved identity and blocks exactly once ("Re-run the commit; it will
  // pass."). The identical retry then succeeds. On hosts without enforcement
  // the first commit succeeds and the catch is dead code. Do not simplify away.
  try {
    git(repo, ['commit', '-q', '-m', 'initial commit'])
  } catch {
    git(repo, ['commit', '-q', '-m', 'initial commit'])
  }
  for (const c of opts.commits ?? []) {
    const msg = c.body ? `${c.subject}\n\n${c.body}` : c.subject
    // Same retry-once as the initial commit above (see note there).
    try {
      git(repo, ['commit', '-q', '--allow-empty', '-m', msg])
    } catch {
      git(repo, ['commit', '-q', '--allow-empty', '-m', msg])
    }
  }

  return { proj, repo, script }
}

interface RunResult {
  status: number | null
  stdout: string
  stderr: string
}

/**
 * A ticket body mirroring the b.tso defect-2 shape: a ~/ path quoted ONLY in an
 * unrelated anchor-table evidence row (describing where the server keeps state),
 * with fix/resolution language present ELSEWHERE in the body but never connected
 * to the path — no same-line pairing and no closure section around the path.
 * The pre-fix heuristic laundered this as an out-of-repo closure; the tightened
 * one must not. Used by both the fixture-run test and the direct regression
 * proof so they exercise byte-identical input.
 */
function incidentalPathBody(): string {
  return (
    '# anchor refresh over the b.4vj docs\n\n' +
    '## Anchor table\n\n' +
    '| doc anchor | code anchor | note |\n' +
    '| --- | --- | --- |\n' +
    '| PRD `:53` | `src/server.ts:148` | the state directory `~/.claude/channels/slack/` |\n\n' +
    '## Notes\n\n' +
    'This resolved the wording; the resolution is a proposed fix to the prose.\n' +
    'No out-of-repo product was touched — the ~/ path above is only evidence of\n' +
    'where the running server keeps its state, quoted from the PRD.\n'
  )
}

/** Run the (copied) audit script against the fixture repo. */
function runAudit(fx: Fixture): RunResult {
  const r = spawnSync('bash', [fx.script, fx.repo], {
    encoding: 'utf8',
    env: { ...process.env },
  })
  return { status: r.status, stdout: r.stdout, stderr: r.stderr }
}

/**
 * Run the copied script with NO $1 — exercises the documented default REPO_ROOT
 * derivation: it first tries <project>/claude-slack-channel-bots-main and, when
 * that conventional checkout is absent, falls back to the script's own repo.
 */
function runAuditNoArg(fx: Fixture): RunResult {
  const r = spawnSync('bash', [fx.script], {
    encoding: 'utf8',
    env: { ...process.env },
  })
  return { status: r.status, stdout: r.stdout, stderr: r.stderr }
}

/**
 * Shared scaffolding for the two "pre-fix vs post-fix verdict flip" regression
 * proofs (b.fta's ERE-lesson pin and b.zjm's connected-heuristic pin). Recovers
 * the genuine PRE-fix script from an IMMUTABLE pinned SHA (never HEAD — once a
 * fix commits, HEAD carries the post-fix script and vacuously breaks the
 * comparison) and drops it beside the post-fix copy inside the SAME fixture
 * project (`fx.repo/scripts/<name>`) so both scripts resolve identical hive
 * paths and audit the same scratch git history.
 *
 * Fails loudly if the pinned commit is unreachable (shallow / partial clone) —
 * never a silent pass. The `sanity` guards assert the recovered source truly is
 * the OLD form (contains the pre-fix tokens, lacks the post-fix ones), so the
 * proof cannot go vacuous. Against the pinned SHA these hold forever regardless
 * of HEAD.
 *
 * Returns the absolute path to the written pre-fix script; the caller invokes it
 * with `bash <path> <fx.repo>` and asserts the pre-fix verdict.
 */
function recoverPreFixScript(
  fx: Fixture,
  sha: string,
  name: string,
  sanity: { contains: string[]; lacks: string[] },
): string {
  const realPreFix = spawnSync(
    'git',
    ['show', `${sha}:scripts/audit-finished-tickets.sh`],
    { cwd: WORKTREE_ROOT, encoding: 'utf8' },
  )
  expect(
    realPreFix.status,
    `could not recover pre-fix script from pinned commit ${sha} (shallow clone?)`,
  ).toBe(0)
  for (const needle of sanity.contains) {
    expect(realPreFix.stdout).toContain(needle)
  }
  for (const needle of sanity.lacks) {
    expect(realPreFix.stdout).not.toContain(needle)
  }
  const preFixScript = join(fx.repo, 'scripts', name)
  writeFileSync(preFixScript, realPreFix.stdout)
  return preFixScript
}

describe('audit-finished-tickets.sh — landed vs stranded finished tickets', () => {
  test('finished ticket with a main commit mentioning its id → clean, exit 0', () => {
    const fx = makeFixture({
      tickets: [{ id: 'b.aaa', hive: 'Bugs', status: 'finished' }],
      commits: [{ subject: 'fix(core): land b.aaa properly' }],
    })
    const r = runAudit(fx)
    expect(r.stdout).toContain('(none)')
    expect(r.status).toBe(0)
  })

  test('finished ticket with no main commit and no closure marker → flagged, exit non-zero [SENTINEL]', () => {
    const fx = makeFixture({
      tickets: [{ id: 'b.bbb', hive: 'Bugs', status: 'finished' }],
      // no commit references b.bbb
    })
    const r = runAudit(fx)
    expect(r.stdout).toContain('b.bbb')
    expect(r.stdout).toContain('no commit on main lands it')
    expect(r.status).not.toBe(0)
  })

  test('finished ticket with an out-of-repo closure marker (~/startup + fix language) → not flagged', () => {
    const fx = makeFixture({
      tickets: [
        {
          id: 'b.ccc',
          hive: 'Bugs',
          status: 'finished',
          body:
            '# out of repo fix\n\n' +
            '**Fix**: resolved in `~/startup/start-all.sh` outside this repo.\n',
        },
      ],
    })
    const r = runAudit(fx)
    expect(r.stdout).not.toContain('b.ccc')
    expect(r.status).toBe(0)
  })

  test('finished ticket with a no-repro closure → not flagged', () => {
    const fx = makeFixture({
      tickets: [
        {
          id: 'b.ddd',
          hive: 'Bugs',
          status: 'finished',
          body: '# closed\n\nClosed as no-repro after investigation; cannot reproduce.\n',
        },
      ],
    })
    const r = runAudit(fx)
    expect(r.stdout).not.toContain('b.ddd')
    expect(r.status).toBe(0)
  })

  test("body says 'pending merge/release' → flagged even with an out-of-repo path + fix language present", () => {
    const fx = makeFixture({
      tickets: [
        {
          id: 'b.eee',
          hive: 'Bugs',
          status: 'finished',
          body:
            '# stranded\n\n' +
            // Include an otherwise-valid closure marker to prove the anti-marker wins.
            '**Fix**: resolved in `~/startup/start-all.sh`.\n' +
            'Also fixed on branch b.zzz; pending merge/release.\n',
        },
      ],
    })
    const r = runAudit(fx)
    expect(r.stdout).toContain('b.eee')
    // The anti-marker branch produces the "pending merge / fixed on branch" reason.
    expect(r.stdout).toContain('never reached main')
    expect(r.status).not.toBe(0)
  })

  // Regression guard for the collect_statuses `set -euo pipefail` defect: a
  // non-finished ticket that sorts alphabetically LAST in a hive must not abort
  // the script. The fix restructured the marker line into an `if`, so a
  // non-finished ticket no longer returns 1 as the function's last command.
  // Non-finished tickets are ignored entirely and the run exits 0 clean.
  test('non-finished (open / worker / pupa) tickets are ignored entirely → clean, exit 0', () => {
    const fx = makeFixture({
      tickets: [
        { id: 'b.op1', hive: 'Bugs', status: 'open' },
        { id: 'b.wk1', hive: 'Bugs', status: 'worker' },
        { id: 'b.pu1', hive: 'Plans', status: 'pupa' },
      ],
      // no commits reference any of them; only 'finished' should ever be flagged
    })
    const r = runAudit(fx)
    expect(r.stdout).not.toContain('b.op1')
    expect(r.stdout).not.toContain('b.wk1')
    expect(r.stdout).not.toContain('b.pu1')
    expect(r.status).toBe(0)
  })

  test('short-id substring safety: b.1qs is NOT landed by a commit mentioning a longer id containing 1qs', () => {
    // A commit for a different, longer id whose base contains "1qs" as a
    // substring must not anchor-match b.1qs. The anchored pattern requires the
    // base to be the terminal id token, so "b.x1qs"/"b.1qsx" do not count.
    const fx = makeFixture({
      tickets: [{ id: 'b.1qs', hive: 'Bugs', status: 'finished' }],
      commits: [
        { subject: 'fix: work on b.x1qs and b.1qsz — unrelated ids' },
        { subject: 'chore: mention 1qs bare token without an id prefix' },
      ],
    })
    const r = runAudit(fx)
    // b.1qs still has no genuine anchored commit → must be flagged as stranded.
    expect(r.stdout).toContain('b.1qs')
    expect(r.status).not.toBe(0)
  })

  test('anchored match DOES land when the exact id token appears', () => {
    // Complement to the substring-safety case: proves anchoring is not so tight
    // that a legitimate exact-id commit fails to land the ticket.
    const fx = makeFixture({
      tickets: [{ id: 'b.1qs', hive: 'Bugs', status: 'finished' }],
      commits: [{ subject: 'fix(daemon): resolve b.1qs restart path' }],
    })
    const r = runAudit(fx)
    expect(r.stdout).not.toContain('b.1qs')
    expect(r.status).toBe(0)
  })

  test('title 4-gram rescue: an id-untagged commit whose subject echoes the title lands the ticket', () => {
    const fx = makeFixture({
      tickets: [
        {
          id: 'b.ttl',
          hive: 'Bugs',
          status: 'finished',
          title: 'clean restart reconnects sessions incorrectly',
        },
      ],
      // No id mention, but a 4-consecutive-word run of the title.
      commits: [{ subject: 'clean restart reconnects sessions — proper respawn' }],
    })
    const r = runAudit(fx)
    expect(r.stdout).not.toContain('b.ttl')
    expect(r.status).toBe(0)
  })

  test('title 3-gram is NOT enough: subject sharing only 3 consecutive title words → still flagged', () => {
    // Proves the 4-gram threshold: a subject that echoes only THREE consecutive
    // significant title words must not rescue the ticket. Break the run at the
    // 4th word so no 4-word window of the title occurs in any subject.
    const fx = makeFixture({
      tickets: [
        {
          id: 'b.3gm',
          hive: 'Bugs',
          status: 'finished',
          title: 'clean restart reconnects sessions incorrectly',
        },
      ],
      // "clean restart reconnects" matches, but the 4th word diverges → no
      // 4-consecutive-word run of the title lands here.
      commits: [{ subject: 'clean restart reconnects nothing else at all' }],
    })
    const r = runAudit(fx)
    expect(r.stdout).toContain('b.3gm')
    expect(r.stdout).toContain('no commit on main lands it')
    expect(r.status).not.toBe(0)
  })

  test('4-gram must not straddle two subjects: tail-of-one + head-of-next → still flagged', () => {
    // Locks in the per-line title-normalization fix. The title's 4-word run is
    // split across two ADJACENT commit subjects (last two words end subject A,
    // first two words begin subject B). A whole-stream normalization would
    // collapse the newline between them and forge a false 4-word match; the
    // per-line normalization keeps them separate, so the ticket stays flagged.
    const fx = makeFixture({
      tickets: [
        {
          id: 'b.str',
          hive: 'Bugs',
          status: 'finished',
          title: 'alpha beta gamma delta',
        },
      ],
      commits: [
        { subject: 'unrelated work alpha beta' }, // tail: ...alpha beta
        { subject: 'gamma delta more unrelated' }, // head: gamma delta...
      ],
    })
    const r = runAudit(fx)
    expect(r.stdout).toContain('b.str')
    expect(r.stdout).toContain('no commit on main lands it')
    expect(r.status).not.toBe(0)
  })

  test('disclaimer commit does NOT land the ticket (mentions id only to say superseded)', () => {
    const fx = makeFixture({
      tickets: [{ id: 'b.dsc', hive: 'Bugs', status: 'finished' }],
      commits: [
        { subject: 'note: b.dsc superseded by other work', body: 'no longer applies' },
      ],
    })
    const r = runAudit(fx)
    expect(r.stdout).toContain('b.dsc')
    expect(r.status).not.toBe(0)
  })
})

describe('audit-finished-tickets.sh — documents-only closure marker (b.zjm defect 1)', () => {
  // AC 1: a documents-only ticket whose product lives outside any git repo,
  // carrying the explicit `## +closed:docs-only` marker, has no main commit but
  // is a legitimate closure — NOT stranded.
  test('finished ticket with `## +closed:docs-only` marker and no main commit → not flagged', () => {
    const fx = makeFixture({
      tickets: [
        {
          id: 'b.doc',
          hive: 'Bugs',
          status: 'finished',
          body:
            '# wording pass over the b.4vj PRD/SRD\n\n' +
            'Refreshed the Apiary ticket markdown under `Ideas/b.4vj/…`. The\n' +
            'project root is not a git repo, so no commit on main can land this.\n\n' +
            '## +closed:docs-only\n\n' +
            'Product is documents outside any git repository.\n',
        },
      ],
      // no commit references b.doc
    })
    const r = runAudit(fx)
    expect(r.stdout).not.toContain('b.doc')
    expect(r.status).toBe(0)
  })

  // AC 2: the docs-only marker is STILL disqualified by has_anti_marker — a body
  // that claims documents-only AND "pending merge"/"fixed on branch b.x" is
  // stranded work, not a closure. The body also QUOTES a ~/ path in the marker
  // section's prose: this additionally proves the (a)-section exclusion, since the
  // anti-marker forces has_closure_marker to bail before EITHER the (c) docs-only
  // branch or an (a) out-of-repo branch could fire — neither the marker heading
  // nor the quoted path may launder it.
  test.each([
    ['pending merge', 'The fix is pending merge/release.'],
    ['fixed on branch b.x', 'Also fixed on branch b.zzz.'],
  ])(
    '`## +closed:docs-only` + quoted ~/ path + anti-marker (%s) → still flagged',
    (_label, antiLine) => {
      const fx = makeFixture({
        tickets: [
          {
            id: 'b.dam',
            hive: 'Bugs',
            status: 'finished',
            body:
              '# documents-only closure\n\n' +
              '## +closed:docs-only\n\n' +
              'Product is documents outside any git repository; state lives in\n' +
              '`~/.claude/channels/slack/`, quoted only as evidence.\n' +
              `${antiLine}\n`,
          },
        ],
      })
      const r = runAudit(fx)
      expect(r.stdout).toContain('b.dam')
      expect(r.status).not.toBe(0)
    },
  )

  // AC 4: the docs-only class must pass EVEN for the b.tso incidental-path shape.
  // A body that quotes a ~/ path in an unrelated evidence row with fix-ish
  // language elsewhere (incidentalPathBody — the exact shape the tightened
  // out-of-repo heuristic now REJECTS as an (a)-closure) is nonetheless a
  // legitimate closure when it also carries the explicit `## +closed:docs-only`
  // marker. This proves the docs-only marker is evaluated FIRST and that the
  // marker heading does not itself open an (a)-section around the quoted path —
  // the ticket passes for the right reason (the marker), not incidentally.
  test('`## +closed:docs-only` marker + b.tso incidental-path body → not flagged (docs-only class)', () => {
    const fx = makeFixture({
      tickets: [
        {
          id: 'b.tso',
          hive: 'Bugs',
          status: 'finished',
          body: incidentalPathBody() + '\n## +closed:docs-only\n\nProduct is documents outside any git repository.\n',
        },
      ],
    })
    const r = runAudit(fx)
    expect(r.stdout).not.toContain('b.tso')
    expect(r.status).toBe(0)
  })

  // The marker must be the explicit heading, not loose prose. A body that only
  // says "documents only" / "docs-only" in ordinary text does NOT match, so a
  // genuinely stranded docs ticket without the deliberate heading stays flagged.
  test('loose "docs-only" prose (no `## +closed:docs-only` heading) → still flagged', () => {
    const fx = makeFixture({
      tickets: [
        {
          id: 'b.los',
          hive: 'Bugs',
          status: 'finished',
          body:
            '# a docs-only change\n\n' +
            'This was documents only; a docs-only wording pass, nothing more.\n',
        },
      ],
    })
    const r = runAudit(fx)
    expect(r.stdout).toContain('b.los')
    expect(r.stdout).toContain('no commit on main lands it')
    expect(r.status).not.toBe(0)
  })
})

describe('audit-finished-tickets.sh — branch (b) closure vocabulary (b.fta)', () => {
  // AC (b.fta): a bare, reasonless `## Closed` heading must NOT by itself
  // satisfy branch (b). This is the load-bearing behavior change: the pre-fix
  // ERE `## +closed` alternative quantified the preceding SPACE, so it matched
  // ANY `## Closed …` heading (unanchored, case-insensitively) — silently
  // covering for the missing reason vocabulary. With that alternative removed, a
  // closure now requires a STATED reason. The fixture body has no ~/ path and no
  // `## +closed:docs-only` marker, so it can only pass via branch (b); since it
  // does not, and no commit lands it, it is flagged as stranded.
  test('bare reasonless `## Closed` heading does NOT satisfy branch (b) → flagged', () => {
    const fx = makeFixture({
      tickets: [
        {
          id: 'b.bcl',
          hive: 'Bugs',
          status: 'finished',
          body:
            '# fixture ticket b.bcl\n\n' +
            '## Closed 2026-09-20 — no separate work required\n',
        },
      ],
    })
    const r = runAudit(fx)
    expect(r.stdout).toContain('b.bcl')
    expect(r.stdout).toContain('no commit on main lands it')
    expect(r.status).not.toBe(0)
  })

  // AC (b.fta): each widened alternative — modeled on the real phrasing of the
  // three legitimately-closed tickets b.49f/b.vfx/b.3kr — DOES satisfy branch
  // (b), so a reasoned closure with no main commit is NOT flagged. Includes a
  // case-insensitivity case (`## CLOSED … superseded by`) proving grep -i covers
  // the uppercase heading, and the b.49f `## Closed … fully satisfied by` and
  // b.3kr `already satisfied` shapes.
  test.each([
    [
      'fully satisfied by (b.49f shape)',
      '## Closed 2026-09-20 — fully satisfied by b.q53, no separate work required',
    ],
    [
      'superseded by, uppercase heading (b.vfx shape)',
      '## CLOSED 2026-09-20 — superseded by b.en2, verified against every acceptance criterion',
    ],
    [
      'already satisfied (b.3kr shape)',
      '## Closed 2026-09-20 — already satisfied, no work required',
    ],
  ])(
    'widened branch (b) alternative %s → recognized closure, not flagged',
    (_label, heading) => {
      const fx = makeFixture({
        tickets: [
          {
            id: 'b.wid',
            hive: 'Bugs',
            status: 'finished',
            body: `# fixture ticket b.wid\n\n${heading}\n`,
          },
        ],
      })
      const r = runAudit(fx)
      expect(r.stdout).not.toContain('b.wid')
      expect(r.status).toBe(0)
    },
  )

  // AC (b.fta): word-boundedness. The widened alternatives are anchored on
  // non-alnum boundaries via the `(^|[^a-z0-9])…([^a-z0-9]|$)` idiom, so an
  // incidental substring embedding must NOT match. "unsuperseded by" contains
  // "superseded by" but is preceded by an alnum char ("n"), so the leading
  // boundary fails and no closure is recognized → the ticket stays flagged.
  test('incidental substring "unsuperseded by" does NOT match branch (b) → flagged', () => {
    const fx = makeFixture({
      tickets: [
        {
          id: 'b.wbb',
          hive: 'Bugs',
          status: 'finished',
          body:
            '# fixture ticket b.wbb\n\n' +
            'This ticket was unsuperseded by anything and remains real work.\n',
        },
      ],
    })
    const r = runAudit(fx)
    expect(r.stdout).toContain('b.wbb')
    expect(r.stdout).toContain('no commit on main lands it')
    expect(r.status).not.toBe(0)
  })

  // AC (b.fta) — the b.qps anti-marker invariant. Each widened alternative, when
  // the body ALSO carries an anti-marker (`pending merge` / `fixed on branch
  // b.x`), must STILL be flagged: has_anti_marker is checked FIRST in
  // has_closure_marker and disqualifies everything. Widening the closure
  // vocabulary must not weaken this. One case per widened alternative — enough
  // to show each newly-recognized reason is still disqualified by an anti-marker
  // (the ticket AC). The anti-marker SHAPE is alternated across the three cases
  // so both shapes still appear here; anti-marker-shape precedence itself is
  // already covered exhaustively by the b.dam (~line 481) and b.eee (~line 296)
  // test.each blocks, so a full 3×2 cross product would be redundant.
  test.each([
    ['fully satisfied by', 'The fix is pending merge/release.'],
    ['superseded by', 'Also fixed on branch b.zzz.'],
    ['already satisfied', 'The fix is pending merge/release.'],
  ])(
    'widened alternative "%s" + anti-marker (%s) → still flagged (b.qps invariant)',
    (reason, antiLine) => {
      const fx = makeFixture({
        tickets: [
          {
            id: 'b.qai',
            hive: 'Bugs',
            status: 'finished',
            body:
              '# fixture ticket b.qai\n\n' +
              `## Closed 2026-09-20 — ${reason} b.other, verified.\n` +
              `${antiLine}\n`,
          },
        ],
      })
      const r = runAudit(fx)
      expect(r.stdout).toContain('b.qai')
      // has_anti_marker wins → the "never reached main" reason, not a closure.
      expect(r.stdout).toContain('never reached main')
      expect(r.status).not.toBe(0)
    },
  )

  // AC (b.fta): a bare `## +closed` LITERAL heading must NOT satisfy branch (b)
  // in the post-fix script either — the alternative was REMOVED, not fixed. The
  // only intentional docs-only closure route is `## +closed:docs-only` via
  // branch (c). A bare `## +closed` (no `:docs-only` suffix, no reason
  // vocabulary, no ~/ path) is not a closure → the ticket is flagged.
  test('bare `## +closed` literal heading (no :docs-only) does NOT satisfy branch (b) → flagged', () => {
    const fx = makeFixture({
      tickets: [
        {
          id: 'b.plc',
          hive: 'Bugs',
          status: 'finished',
          body: '# fixture ticket b.plc\n\n## +closed\n\nsome trailing prose.\n',
        },
      ],
    })
    const r = runAudit(fx)
    expect(r.stdout).toContain('b.plc')
    expect(r.stdout).toContain('no commit on main lands it')
    expect(r.status).not.toBe(0)
  })

  // AC (b.fta) — ERE-lesson regression pin. Directly demonstrates the verdict
  // FLIP for a bare, reasonless `## Closed` heading, recovering the genuine
  // PRE-FIX script from the IMMUTABLE pinned commit a9173fa (the mainline commit
  // immediately before this fix, permanently in repo history) — NOT HEAD, which
  // would carry the post-fix script once this lands and vacuously break the
  // comparison. Pre-fix: the ERE `## +closed` quantifier bug matches any
  // `## Closed …` heading, so the ticket is laundered as closed (exit 0, not
  // flagged). Post-fix: that alternative is removed, a reasonless heading is no
  // longer a closure, so the ticket is flagged (exit non-zero). This pins the
  // lesson so nobody "restores" `## +closed` as a regression. If the pinned
  // commit is unreachable (shallow / partial clone) the recovery fails loudly.
  test('the removed `## +closed` quantifier bug CHANGES the verdict: pre-fix launders a bare `## Closed` yet FLAGS a literal `## +closed`, post-fix flags both [regression proof]', () => {
    // Two fixture tickets in the SAME project so both scripts audit one history:
    //   b.ere — a bare, reasonless `## Closed` heading. This is what the ERE
    //           `## +closed` alternative silently laundered pre-fix: the `+`
    //           quantified the SPACE, so `## +closed` matched "## " followed by
    //           one-or-more spaces then "closed", i.e. ANY `## Closed …` heading.
    //   b.plt — a LITERAL `## +closed` heading body. This is the ERE lesson the
    //           ticket AC names: a literal `## +closed` is NOT matched by the old
    //           pattern (a literal "+" is a quantifier there, never a "+"), so
    //           the pre-fix script must FLAG b.plt — proving the old pattern
    //           never matched the literal. Post-fix the alternative is gone
    //           entirely, so a literal `## +closed` (no `:docs-only`) is likewise
    //           flagged.
    const bareClosedBody =
      '# fixture ticket b.ere\n\n' +
      '## Closed 2026-09-20 — no separate work required\n'
    const literalPlusBody =
      '# fixture ticket b.plt\n\n## +closed\n\nsome trailing prose.\n'
    const fx = makeFixture({
      tickets: [
        {
          id: 'b.ere',
          hive: 'Bugs',
          status: 'finished',
          title: 'reasonless closed heading',
          body: bareClosedBody,
        },
        {
          id: 'b.plt',
          hive: 'Bugs',
          status: 'finished',
          title: 'literal plus-closed heading',
          body: literalPlusBody,
        },
      ],
    })

    // Recover the genuine PRE-fix script from the immutable pinned commit
    // a9173fa (the mainline commit immediately before this fix). Sanity: its
    // branch (b) still carries the buggy `## +closed` alternative and lacks the
    // widened reason vocabulary, else the proof is vacuous.
    const preFixScript = recoverPreFixScript(fx, 'a9173fa', 'audit-prefix-ere.sh', {
      contains: ['## +closed'],
      lacks: ['fully satisfied by', 'already satisfied'],
    })

    // Pre-fix run. The `## +closed` quantifier bug matches the bare `## Closed`
    // heading → b.ere laundered as closed (NOT flagged). But a LITERAL `## +closed`
    // heading is NOT matched by that same pattern (the "+" is a quantifier, not a
    // literal plus) → b.plt is NOT laundered and IS flagged. Because b.plt strands,
    // the pre-fix run exits non-zero overall — so the meaningful assertion is
    // per-ticket: b.ere absent (laundered) yet b.plt present (flagged).
    const pre = spawnSync('bash', [preFixScript, fx.repo], {
      encoding: 'utf8',
      env: { ...process.env },
    })
    expect(pre.stdout).not.toContain('b.ere')
    expect(pre.stdout).toContain('b.plt')
    // Sentinel: if the pre-fix pattern is ever misread as matching the literal
    // (proof gone vacuous), b.plt would be laundered and this fails.
    expect(pre.status).not.toBe(0)

    // Post-fix (the working-tree script the fixture copied in): the alternative
    // is removed → neither a reasonless `## Closed` nor a literal `## +closed`
    // (no `:docs-only`) is a closure → BOTH flagged, exit non-zero.
    const post = runAudit(fx)
    expect(post.stdout).toContain('b.ere')
    expect(post.stdout).toContain('b.plt')
    expect(post.status).not.toBe(0)
  })
})

describe('audit-finished-tickets.sh — tightened out-of-repo heuristic (b.zjm defect 2)', () => {
  // AC 5 / regression for defect 2: a finished ticket that merely QUOTES a ~/
  // path in an unrelated evidence line (an anchor-table row, mirroring b.tso),
  // with fix-ish language elsewhere in the body but no genuine connected
  // closure, IS stranded. The pre-fix script paired any ~/ path anywhere with
  // fix language anywhere and laundered this as an out-of-repo closure; the
  // tightened heuristic requires the two to be connected (same line or same
  // closure section), so it is now correctly flagged.
  //
  // Regression property verified out-of-band: this exact fixture body run
  // through the pre-fix script (git show HEAD:scripts/audit-finished-tickets.sh)
  // exits 0 / NOT flagged, and through the post-fix script exits 1 / flagged.
  // See the "PRE-FIX REGRESSION PROOF" test below which asserts both directly.
  test('~/ path in an unrelated anchor-table row + fix language elsewhere, no connected closure → flagged', () => {
    const fx = makeFixture({
      tickets: [
        {
          id: 'b.inc',
          hive: 'Bugs',
          status: 'finished',
          body: incidentalPathBody(),
        },
      ],
    })
    const r = runAudit(fx)
    expect(r.stdout).toContain('b.inc')
    expect(r.stdout).toContain('no commit on main lands it')
    expect(r.status).not.toBe(0)
  })

  // Positive case for the tightened branch (a), isolating the SAME-LINE rule (i):
  // when the ~/ path and the fix language are connected on the same line the
  // out-of-repo closure is recognized and the ticket is NOT flagged. The heading
  // is deliberately NEUTRAL ("# background notes") so it opens no closure section
  // — if rule (i) regressed, the section rule (ii) could not silently rescue this
  // ticket, and it would flag. This isolates rule (i) rather than duplicating the
  // b.ccc test (whose `# out of repo fix` heading opens a section via rule ii).
  test('~/ path + fix language on the SAME line (neutral heading) → recognized closure, not flagged', () => {
    const fx = makeFixture({
      tickets: [
        {
          id: 'b.sam',
          hive: 'Bugs',
          status: 'finished',
          body:
            '# background notes\n\n' +
            '**Fix (2026-09-19):** `~/startup/start-all.sh` now resolved outside this repo.\n',
        },
      ],
    })
    const r = runAudit(fx)
    expect(r.stdout).not.toContain('b.sam')
    expect(r.status).toBe(0)
  })

  // Positive case, section variant isolating the SECTION rule (ii): the ~/ path
  // lives inside a recognized closure/fix SECTION (its `## Fix` heading names the
  // fix), which is the shape of the genuine out-of-repo closures
  // (b.mk7/b.mp5/b.s3x/b.xx7). The path line itself carries NO resolution
  // vocabulary ("Lives in … outside any repo."), so it cannot trip the same-line
  // rule (i) — only the surrounding section can excuse it. This isolates rule (ii)
  // rather than passing incidentally via rule (i).
  test('~/ path inside a `## Fix` closure section (path line has no fix words) → recognized closure, not flagged', () => {
    const fx = makeFixture({
      tickets: [
        {
          id: 'b.sec',
          hive: 'Bugs',
          status: 'finished',
          body:
            '# some out of repo work\n\n' +
            'Background prose with no path here.\n\n' +
            '## Fix\n\n' +
            'Lives in `~/.agent-director/config`, outside any repo.\n',
        },
      ],
    })
    const r = runAudit(fx)
    expect(r.stdout).not.toContain('b.sec')
    expect(r.status).toBe(0)
  })

  // Guard for the code-fence handling in out_of_repo_fix_connected: a fenced
  // `# heading` sample must NOT open a closure section around a bare ~/ path.
  // Here the only ~/ path sits in an unrelated evidence row and the sole
  // "heading" that could open a fix section is inside a ``` code fence, so no
  // genuine connection exists → the ticket stays flagged.
  test('fenced `# Fix` sample does not open a closure section around an incidental ~/ path → flagged', () => {
    const fx = makeFixture({
      tickets: [
        {
          id: 'b.fen',
          hive: 'Bugs',
          status: 'finished',
          body:
            '# investigation notes\n\n' +
            '| anchor | file | note |\n' +
            '| --- | --- | --- |\n' +
            '| PRD `:53` | `src/server.ts:148` | state dir `~/.claude/channels/slack/` |\n\n' +
            'Example of the heading style we use in closures:\n\n' +
            '```md\n' +
            '## Fix\n' +
            'resolution goes here\n' +
            '```\n\n' +
            'No genuine closure was written for this ticket.\n',
        },
      ],
    })
    const r = runAudit(fx)
    expect(r.stdout).toContain('b.fen')
    expect(r.status).not.toBe(0)
  })

  // Word-boundary guard for the round-2 section-keyword change: section-opening
  // keywords must match as WHOLE words on non-alnum boundaries, so a heading
  // whose text merely CONTAINS "fix"/"resolv" as a substring — "Prefix routing",
  // "Unfixed items", "Resolver notes" — must NOT open a closure section. Here the
  // only ~/ path sits under such a heading, with fix-ish language present
  // ELSEWHERE (an unconnected line), and no same-line pairing. Neither rule (i)
  // nor rule (ii) may excuse it → still flagged.
  test.each([
    '## Prefix routing',
    '## Unfixed items',
    '## Resolver notes',
  ])(
    'substring-only heading %s does not open a closure section around a ~/ path → flagged',
    (heading) => {
      const fx = makeFixture({
        tickets: [
          {
            id: 'b.wbd',
            hive: 'Bugs',
            status: 'finished',
            body:
              '# investigation notes\n\n' +
              'A genuine fix was proposed but never connected to any path.\n\n' +
              `${heading}\n\n` +
              'State lives in `~/.claude/channels/slack/`, quoted here as evidence.\n',
          },
        ],
      })
      const r = runAudit(fx)
      expect(r.stdout).toContain('b.wbd')
      expect(r.stdout).toContain('no commit on main lands it')
      expect(r.status).not.toBe(0)
    },
  )

  // PRE-FIX REGRESSION PROOF. Directly demonstrates the AC-5 property: the SAME
  // incidental-path body is laundered (exit 0, not flagged) by the PRE-FIX
  // script and correctly flagged (exit non-zero) by the POST-FIX script. The
  // pre-fix script is recovered from an IMMUTABLE pinned commit (5522f1b, the
  // mainline commit immediately before this fix, permanently in repo history),
  // so this asserts the behavioral change rather than merely asserting the
  // post-fix behavior. Pinning to a fixed SHA (rather than HEAD) keeps the proof
  // valid after the fix is committed — HEAD would then point at the post-fix
  // script and vacuously break the comparison. The two sanity `not.toContain`
  // assertions below guard against a vacuous proof: they confirm the recovered
  // source truly is the OLD form. If the pinned commit is unreachable (shallow /
  // partial clone), git show fails and the test fails loudly — never a silent pass.
  test('the tightened heuristic CHANGES the verdict: pre-fix launders, post-fix flags [regression proof]', () => {
    const fx = makeFixture({
      tickets: [
        {
          id: 'b.inc',
          hive: 'Bugs',
          status: 'finished',
          title: 'anchor refresh',
          body: incidentalPathBody(),
        },
      ],
    })

    // Recover the genuine PRE-fix script from the immutable pinned commit
    // (5522f1b) rather than HEAD (see recoverPreFixScript). Sanity: the recovered
    // source must be the OLD form (no docs-only marker, no connected-heuristic
    // helper — uses the two independent greps), else the proof is vacuous.
    const preFixScript = recoverPreFixScript(fx, '5522f1b', 'audit-prefix.sh', {
      contains: [],
      lacks: ['out_of_repo_fix_connected', '+closed:docs-only'],
    })

    // The incidental-path body was written onto the fixture ticket by
    // makeFixture (body: incidentalPathBody()), so both scripts audit the same
    // ticket markdown — no hand-rolled frontmatter duplicating makeFixture.

    // Pre-fix: the two-independent-greps heuristic launders the incidental path
    // → b.inc NOT flagged, exit 0 (clean).
    const pre = spawnSync('bash', [preFixScript, fx.repo], {
      encoding: 'utf8',
      env: { ...process.env },
    })
    expect(pre.stdout).not.toContain('b.inc')
    expect(pre.status).toBe(0)

    // Post-fix (the working-tree script the fixture copied in): connected
    // heuristic rejects the incidental path → b.inc flagged, exit non-zero.
    const post = runAudit(fx)
    expect(post.stdout).toContain('b.inc')
    expect(post.status).not.toBe(0)
  })
})

describe('audit-finished-tickets.sh — stranded branches', () => {
  test('branch referencing a finished ticket, head NOT ancestor of main → flagged; merged → not flagged', () => {
    // Two finished tickets; b.brn gets an unmerged branch, b.mrg gets a merged one.
    const fx = makeFixture({
      tickets: [
        { id: 'b.brn', hive: 'Bugs', status: 'finished' },
        { id: 'b.mrg', hive: 'Bugs', status: 'finished' },
      ],
      // give both a landing commit so the TICKET pass stays clean; only the
      // BRANCH pass is under test here.
      commits: [
        { subject: 'fix: land b.brn' },
        { subject: 'fix: land b.mrg' },
      ],
    })

    // Unmerged branch off an earlier point, one commit ahead of main.
    const firstSha = git(fx.repo, ['rev-list', '--max-parents=0', 'main']).trim()
    git(fx.repo, ['checkout', '-q', '-b', 'feature/b.brn', firstSha])
    git(fx.repo, ['commit', '-q', '--allow-empty', '-m', 'wip b.brn on branch'])

    // Merged branch: points at a commit that IS reachable from main.
    const mainSha = git(fx.repo, ['rev-parse', 'main']).trim()
    git(fx.repo, ['branch', 'feature/b.mrg', mainSha])
    git(fx.repo, ['checkout', '-q', 'main'])

    const r = runAudit(fx)
    // Unmerged branch flagged...
    expect(r.stdout).toContain('feature/b.brn')
    expect(r.stdout).toContain('not an ancestor of main')
    // ...merged branch NOT flagged.
    expect(r.stdout).not.toContain('feature/b.mrg')
    expect(r.status).not.toBe(0)
  })

  test('unmerged branch referencing NO known ticket → flagged as unknown-ticket', () => {
    const fx = makeFixture({
      tickets: [{ id: 'b.kno', hive: 'Bugs', status: 'finished' }],
      commits: [{ subject: 'fix: land b.kno' }],
    })
    const firstSha = git(fx.repo, ['rev-list', '--max-parents=0', 'main']).trim()
    git(fx.repo, ['checkout', '-q', '-b', 'no-ticket-feature', firstSha])
    git(fx.repo, ['commit', '-q', '--allow-empty', '-m', 'orphan work'])
    git(fx.repo, ['checkout', '-q', 'main'])

    const r = runAudit(fx)
    expect(r.stdout).toContain('no-ticket-feature')
    expect(r.stdout).toContain('references no known ticket')
    expect(r.status).not.toBe(0)
  })

  // branch_base fix: an id longer than 3 chars AND a mixed-case ref must still
  // resolve to the lowercased finished-ticket id (b.xyzq) and get flagged. A
  // pre-fix branch_base (3-char-only, no lowercasing) would miss this branch.
  test('mixed-case, 4-char-id branch for a finished ticket → flagged', () => {
    const fx = makeFixture({
      tickets: [{ id: 'b.xyzq', hive: 'Bugs', status: 'finished' }],
      commits: [{ subject: 'fix: land b.xyzq' }], // keep the TICKET pass clean
    })
    const firstSha = git(fx.repo, ['rev-list', '--max-parents=0', 'main']).trim()
    git(fx.repo, ['checkout', '-q', '-b', 'FEATURE/B.XYZQ', firstSha])
    git(fx.repo, ['commit', '-q', '--allow-empty', '-m', 'wip on branch'])
    git(fx.repo, ['checkout', '-q', 'main'])

    const r = runAudit(fx)
    expect(r.stdout).toContain('FEATURE/B.XYZQ')
    expect(r.stdout).toContain('references finished ticket b.xyzq')
    expect(r.status).not.toBe(0)
  })

  // Companion guard for the same collect_statuses fix: a lone non-finished
  // ticket sorts last in its hive but no longer aborts the script before the
  // branch pass runs, so its branch is correctly left alone.
  test('branch for a NON-finished ticket (worker) is NOT flagged', () => {
    const fx = makeFixture({
      tickets: [{ id: 'b.wrk', hive: 'Plans', status: 'worker' }],
    })
    const firstSha = git(fx.repo, ['rev-list', '--max-parents=0', 'main']).trim()
    git(fx.repo, ['checkout', '-q', '-b', 'b.wrk', firstSha])
    git(fx.repo, ['commit', '-q', '--allow-empty', '-m', 'ongoing work'])
    git(fx.repo, ['checkout', '-q', 'main'])

    const r = runAudit(fx)
    // The branch names a known but non-finished ticket → left alone entirely.
    expect(r.stdout).not.toContain('b.wrk')
    expect(r.status).toBe(0)
  })
})

describe('audit-finished-tickets.sh — exit codes & REPO_ROOT resolution', () => {
  test('missing Plans hive dir → exit 2 (misconfiguration) with a hive diagnostic', () => {
    const fx = makeFixture({
      tickets: [{ id: 'b.cfg', hive: 'Bugs', status: 'finished' }],
    })
    // Remove the Plans hive dir the fixture always creates → the script's
    // "could not locate hives" guard must fire and fail closed with exit 2,
    // distinct from the exit-1 "stranded work found" path.
    rmSync(join(fx.proj, 'Ideas', 'Plans'), { recursive: true, force: true })

    const r = runAudit(fx)
    expect(r.status).toBe(2)
    expect(r.stderr).toContain('could not locate hives')
    expect(r.stderr).toContain('Plans hive at')
  })

  test('default REPO_ROOT: no $1, conventional main checkout absent → falls back to own repo and audits', () => {
    // repoName defaults to 'repo', so <proj>/claude-slack-channel-bots-main does
    // NOT exist. Invoked with NO argument, the script tries that conventional
    // path, finds it absent, and falls back to REPO_OF_SCRIPT (the copied repo).
    // The audit must still run correctly against that repo's main history.
    const fx = makeFixture({
      tickets: [
        { id: 'b.dr1', hive: 'Bugs', status: 'finished' }, // no commit → flagged
        { id: 'b.dr2', hive: 'Bugs', status: 'finished' }, // landed → clean
      ],
      commits: [{ subject: 'fix: land b.dr2' }],
    })
    const r = runAuditNoArg(fx)
    // It audited the fallback repo: b.dr1 stranded, b.dr2 landed.
    expect(r.stdout).toContain('b.dr1')
    expect(r.stdout).not.toContain('b.dr2')
    expect(r.status).toBe(1)
    // The report header shows it resolved to the script's own repo, not a bogus
    // conventional path.
    expect(r.stdout).toContain(fx.repo)
  })
})

describe('audit-finished-tickets.sh — read-only invariant', () => {
  /**
   * The script must NEVER write: not the git repo, not the hive markdown. We
   * snapshot the fixture repo's porcelain status + HEAD and a content hash of
   * every hive file before and after a run and assert equality.
   */
  test('a run mutates neither the git repo nor the hive files', () => {
    const fx = makeFixture({
      tickets: [
        { id: 'b.ro1', hive: 'Bugs', status: 'finished' }, // will be flagged
        { id: 'b.ro2', hive: 'Plans', status: 'finished' },
      ],
    })

    const hiveFiles = [
      join(fx.proj, 'Bugs', 'b.ro1', 'b.ro1.md'),
      join(fx.proj, 'Ideas', 'Plans', 'b.ro2', 'b.ro2.md'),
    ]
    const before = {
      status: git(fx.repo, ['status', '--porcelain']),
      head: git(fx.repo, ['rev-parse', 'HEAD']),
      refs: git(fx.repo, ['for-each-ref', '--format=%(refname) %(objectname)']),
      files: hiveFiles.map((f) => readFileSync(f, 'utf8')),
    }

    const r = runAudit(fx)
    expect(r.status).not.toBe(0) // it did do its job (flagged stranded work)

    const after = {
      status: git(fx.repo, ['status', '--porcelain']),
      head: git(fx.repo, ['rev-parse', 'HEAD']),
      refs: git(fx.repo, ['for-each-ref', '--format=%(refname) %(objectname)']),
      files: hiveFiles.map((f) => readFileSync(f, 'utf8')),
    }

    expect(after.status).toBe(before.status)
    expect(after.head).toBe(before.head)
    expect(after.refs).toBe(before.refs)
    expect(after.files).toEqual(before.files)
  })
})
