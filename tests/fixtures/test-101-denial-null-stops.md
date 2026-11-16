# Test 101 null-stop replay

`test-101-denial-null-stops.json` keeps nine projected transcript records from
Bug b.tw6's `artifacts/heavy-0190b/real-agent-failures.jsonl`, original run
`real-1794844444275-4100645` (Claude Code 2.1.280, CSCB 0800e317).

The selected offsets are sidechain 19847, 21847, 33399, 35403 and main 63717,
65683, 71195, 75158, 82002. They preserve the Agent launch/result, denied Bash,
two null-stop finals, premature main Stop, matching completed notification and
subsequent main end. Unused metadata and assistant prose are omitted. IDs,
timestamps, offsets, tool inputs and stop reasons come from the retained records.

The unit replay reconstructs the notification from its retained headers and
synthesizes Slack post/push/update rows in causal order around the recorded
denial, as define-bug's `artifacts/repro-settle/replay.ts` does. It exercises the
real `denialSettled`; it starts no agent and reads no live transcript or credential.
Credential-pattern scanning found no matches in the committed fixture.
