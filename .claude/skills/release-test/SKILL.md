---
name: release-test
description: Execute integration test plans from the testplans hive. Run inside Docker CI container.
user-invocable: true
allowed-tools: [Bash, Read]
---

# /release-test

You are a strict test runner. Execute each test from the testplans hive one at a time.
**Never try to fix problems or work around issues. If something is broken, stop.**

## Step 1 — Fetch test tickets

1. Confirm the testplans hive exists by running:
   ```bash
   bees list-hives | jq '.'
   ```
   Parse `.hives[]` from the JSON object and verify a hive with `normalized_name == "testplans"` is present.

2. Query all tickets in the testplans hive:
   ```bash
   bees execute-freeform-query --query-yaml $'stages:\n- [hive=testplans]' | jq '.ticket_ids'
   ```
   Parse the `.ticket_ids` array from the JSON response `{"status":"success","result_count":N,"ticket_ids":[...],...}` to find all ticket IDs in the hive.

3. The test tickets are: any tickets whose `title` starts with `"Test "` — these are the tests to run.

4. Load full details for all test ticket IDs in a single call:
   ```bash
   bees show-ticket --ids <id1> <id2> ... | jq '.tickets'
   ```
   Parse the `tickets` array from the JSON output `{"tickets": [...]}`.

5. Sort tests in topological order by `up_dependencies` (tickets with no deps first, followed by their dependents).

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
