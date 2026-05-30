---
name: release-test
description: Execute integration test plans from the testplans hive. Run inside Docker CI container.
user-invocable: true
allowed-tools: [Bash, Read, Agent]
---

# /release-test

You are the **orchestrator** for a sequential integration-test suite. You do not
run tests yourself — you spawn one `Agent` subagent per test and parse its
return value. Your only jobs are: enumerate tests, spawn subagents in
dependency order, log verdicts, and emit a single terminal verdict line for
the outer `/ci` harness.

## CRITICAL — Never end a turn without a verdict

The outer `/ci` Monitor polls this in-container Claude session's tmux pane for
exactly one of two terminal lines: `RELEASE TEST PASSED` or
`TEST FAILED: <…>`. If your turn ends for ANY reason before one of those
lines has been printed and the `ci` tmux session has been killed, the outer
harness sees a silent hang and the entire release aborts with no actionable
diagnostic.

**Defensive rule:** Before ending any turn while the suite is in flight, you
MUST have either (a) finished the loop and emitted a terminal verdict, or
(b) emitted `TEST FAILED: <last test attempted> — orchestrator turn ended
without verdict` and killed the `ci` tmux session. If you hit a permission
prompt, a missing tool, an ambiguous state, or anything else that would
otherwise make you stop mid-loop — emit the orchestrator-failure verdict
above and kill the session. Silent turn-end is the worst possible failure
mode.

**Be a strict orchestrator.** Do not fix problems inside subagent output. Do
not retry failed tests. Do not edit code. Your only verbs are: enumerate,
spawn, parse, log, emit verdict, kill session.

## Step 1 — Fetch test tickets

1. Confirm the testplans hive exists:
   ```bash
   bees list-hives | jq '.'
   ```
   Parse `.hives[]` and verify a hive with `normalized_name == "testplans"`
   is present.

2. Query all tickets in the testplans hive:
   ```bash
   bees execute-freeform-query --query-yaml $'stages:\n- [hive=testplans]' | jq '.ticket_ids'
   ```
   Parse the `.ticket_ids` array.

3. Load full details for all test ticket IDs:
   ```bash
   bees show-ticket --ids <id1> <id2> ... | jq '.tickets'
   ```

4. Filter to test tickets — any ticket whose `title` starts with `"Test "`.

5. Sort tests in topological order by `up_dependencies` (tickets with no deps
   first, followed by their dependents). The result is the ordered list of
   test IDs you will hand to subagents one at a time.

Let TOTAL be the length of that ordered list.

## Step 2 — Execute tests via subagents

Loop over the ordered list. For each test in turn (1-indexed N from 1 to TOTAL):

1. Print: `[N/TOTAL] Running: <title>`

2. Spawn an `Agent` subagent with the prompt below. Use the default
   (`general-purpose`) subagent type. The subagent is the runner; you are
   not. Do not pre-read the body. Do not run any of the test's commands
   yourself.

   Subagent prompt (substitute `<test_id>` with the actual ticket ID):

   ```text
   You are executing exactly one integration test from the
   claude-slack-channel-bots testplans hive. The test ticket ID is <test_id>.

   1. Read the ticket with: bees show-ticket --ids <test_id>
   2. Execute every command and verification in the ticket body, in order.
   3. Be a strict runner: do not fix problems, do not work around issues,
      do not retry. If a verification fails, the test fails.

   When done, your reply MUST end with EXACTLY ONE of the following lines
   (and nothing after it — no trailing prose, no fluff, no markdown):

       PASS: <test title>
       FAIL: <test title> — <one-line reason>

   The orchestrator parses your last line. Any other final line is treated
   as a malformed verdict and the test counts as FAIL.
   ```

3. The subagent returns text. Take its LAST non-empty line and classify:

   - Starts with `PASS: ` → log `[N/TOTAL] PASS: <title>` and continue to the
     next test.
   - Starts with `FAIL: ` → log `[N/TOTAL] FAIL: <subagent's reason text>`,
     remember the failing title + reason, and break the loop. For every
     remaining test in the ordered list, print `SKIP: <title>`. Then go to
     Step 3 (failure terminal emission).
   - Anything else → treat as failure. Log
     `[N/TOTAL] FAIL: <title> — subagent returned malformed verdict: <last line truncated>`,
     remember the title + reason, and break the loop with SKIPs as above,
     then go to Step 3.

If the loop completes with every test PASS, go to Step 4.

## Step 3 — On failure (terminal emission)

1. Print: `TEST FAILED: <failing title> — <reason>`
2. Kill the `ci` tmux session so the container exits cleanly. The CI
   entrypoint's outer loop is `while tmux has-session -t ci; do sleep 5; done`,
   so this is what releases the container:
   ```bash
   tmux kill-session -t ci 2>/dev/null || true
   ```
3. Stop. Do not continue. Do not debug. Do not retry.

Without the kill-session, the container hangs until the outer `/ci`
Monitor's 15-minute timeout fires, masking a deterministic failure as a
timeout.

## Step 4 — On full pass (terminal emission)

After every test has returned `PASS:`:

1. Print:
   ```
   RELEASE TEST PASSED
   ```
2. Kill the `ci` tmux session for the same reason as Step 3:
   ```bash
   tmux kill-session -t ci 2>/dev/null || true
   ```
