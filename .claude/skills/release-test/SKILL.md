---
name: release-test
description: Execute the checked-in integration scenarios in testplans/README.md inside a disposable Docker CI container.
user-invocable: true
allowed-tools: [Bash]
---

# /release-test

Run the scenarios listed in [testplans/README.md](../../../testplans/README.md)
one at a time, in the order given there. Read the local Markdown files with
Bash; no external scenario service is needed.

Run only inside a disposable Docker CI container, never against the host's
HOME or a production install. Preserve each scenario's prerequisites and
assertions. Never print credentials or environment values.

**If anything is broken, stop. Do not fix, work around, debug or retry it.**

## Read the scenarios

1. Read the index and each of the three ordered scenario documents.
2. Check their prerequisites before starting. The index also describes the
   separate resume and live-acceptance scenarios; they are not part of this
   ordered run.
3. Use each document's heading as its test name and its body as the full
   instructions. The preceding scenario must pass before its dependent runs.

## Execute and report

For each scenario:

1. Print `[N/TOTAL] Running: <title>`.
2. Execute its setup, commands and verifications using Bash.
3. On success, print `[N/TOTAL] PASS: <title>`.
4. On failure, print `[N/TOTAL] FAIL: <title> — <error>` and
   `SKIP: <title>` for each remaining dependent scenario. Then print
   `TEST FAILED: <title> — <error>` and stop.

After all three scenarios pass, print:

```text
RELEASE TEST PASSED
```

This manual scenario result does not replace the full `/ci` release gate.
