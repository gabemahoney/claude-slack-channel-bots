# Native Test101 completion record audit

## Consumed notification shapes

`notification-shapes-source.json` contains bounded verbatim fragments from the
public Linux x64 binaries for **2.1.280, 2.1.296 and 2.1.302**. Each binary's
size and SHA-256 were checked against its release manifest before extracting
byte offsets, lengths and fragment hashes. The fragments are static binary
data, extracted without executing the binaries or using a session or login.

All three versions serialize task notifications with `task-id`, optional
`tool-use-id`, and `status` headers. Their queue consumer preserves the payload
in `attachment.prompt` with `type: queued_command` and `commandMode`; the
attachment renderer maps that prompt to user content, supporting both strings
and text blocks. The pure captured serializers run in unit regressions with
fixture IDs, alongside both consumed record shapes.

The observer requires successful relay denial, the matching denied Bash
result and sidechain completion, then either a completed synchronous Agent
result or an own-session consumed completion notification and main completion.
For either notification shape, a task/agent ID or Agent-call ID must match;
all supplied IDs must agree. Its timestamp must be finite and no earlier than
the denied result and sidechain completion, and its main-stream offset must
follow the Agent launch result. Earlier, unlinked, foreign, failed, ambiguous
and merely enqueued notifications fail. Header extraction excludes summary and
result prose. The observer enforces a bounded timeout and subsequent AD
dialog-refusal acceptance.
Readiness comes from agent-director row state; notification records never
authorize typing.

Retention projects those notification IDs/status from both content locations,
plus attachment identity fields, through the existing secret scrub. It never
retains the prompt, summary, result, image payload or tool arguments.

## Completion observers

Completion observers in `tests/real-agent`, `tests/integration/fixtures` and
`tests/integration/lib` use these evidence sources:

| Observer | Completion evidence |
| --- | --- |
| `test-101-denial-settled.ts` | The only async subagent notification consumer. Uses both consumed shapes and shared header extraction; also supports synchronous completed Agent results. |
| `ai-readback.ts`, `ai-classifier-stop.ts` | Observe parent-linked assistant `end_turn` for exact current-turn answers. Notifications do not certify an assistant answer; receipt handling covers user/queued input. |
| `ac20-diagnostics.ts` | Delegates completion to `completedAIReadback`; no independent native shape assumption. |
| `real-case-assertions.ts` busy-proof | Matches a Bash tool result and assistant terminal stop reasons; it does not wait for an async task notification. |
| `real-scenario.sh` real_wait_idle | Waits for AD `waiting`; no empty-composer or notification interpretation. |
| `test-104-fmk-real-idle-compact.sh` | Uncertain AD text outcome and ordered own-message receipts; no native idle/compaction observation. |
| `codex-evidence.ts`, `codex-ai.ts`, `codex-delivery.ts` | Exact output/receipt assertions provide independent evidence. Operational readiness uses AD state and refusals, never native task ordering. |
