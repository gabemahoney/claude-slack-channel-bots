---
name: release-test
description: Execute integration test plans from the testplans hive. Run inside Docker CI container.
user-invocable: true
allowed-tools: [Bash, mcp__bees__show_ticket, mcp__bees__list_hives, mcp__bees__execute_freeform_query]
---

# /release-test

You are a strict test runner. Execute each test from the testplans hive one at a time.
**Never try to fix problems or work around issues. If something is broken, stop.**

## Step 1 — Fetch test tickets

1. Call `list_hives()` to confirm testplans hive exists
2. Query all tickets in the testplans hive using `execute_freeform_query()`, or call `show_ticket()` on the root bee (b.en1) to get the suite root
3. The test tickets are: any tickets in the hive whose title starts with "Test " — these are the tests to run
4. Load all test ticket details via `show_ticket(all_ids)`
5. Sort tests in topological order by `up_dependencies` (tickets with no deps first, followed by their dependents)

Each ticket has:
- `title`: test name (e.g. "Test 1: ...")
- `body`: full plain English test instructions
- `up_dependencies`: tickets that must run before this one

## Step 2 — Execute tests

For each test in order:

1. Print: `[N/TOTAL] Running: <title>`
2. Read the ticket `body` — it contains instructions on what to install, run, and verify
3. Execute the instructions using Bash commands
4. If all verifications pass: print `[N/TOTAL] PASS: <title>`
5. If anything fails: print `[N/TOTAL] FAIL: <title> — <error>` then go to Step 3

If a test fails, skip all downstream dependents: print `SKIP: <title>` for each.

## Step 3 — On failure

1. Print the FAIL line
2. Print: `TEST FAILED: <title> — <error>`
3. Stop. Do not continue. Do not debug. Do not retry.

## Step 4 — On full pass

After all tests pass:
```
RELEASE TEST PASSED
```
