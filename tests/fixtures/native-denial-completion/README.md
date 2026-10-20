# Native Test101 completion record audit

The adjacent JSON contains verbatim, bounded fragments from the public Linux
x64 native binary, with byte offsets, fragment hashes, release URL and binary
hash. The binary was read as data, not executed. No session or login was used.

Compared against `tests/real-agent/test-101-denial-settled.ts` before the
follow-up 5 gate:

- `MYe` maps non-classifier deny decisions to `permission-rule`; the denial
  emitter retains that kind and the linked tool-result record.
- `Ce` preserves user content, tool-use result and denial flags. `qEt` only
  clips a long original-file field; it preserves Agent result metadata.
- Agent results still identify asynchronous launches with `isAsync`,
  `async_launched` and `agentId`, and synchronous completion with `completed`.
- `li` serializes task and tool-use identifiers and status. `Qxt` queues this
  string as a task notification. These are the links the checker requires.
- The writer preserves sidechain identity, session identity and result
  metadata. Assistant streaming updates still assign `message.stop_reason`.

The follow-up 5 audit covered notification creation but missed its consumed
attachment form. Its original conclusion that no checker change was needed
was incomplete; the follow-up 10 audit below supersedes that conclusion. It does not prove that the failed run emitted a completed assistant
turn, or that notification consumption reached the main transcript: those
transcripts were deleted. Native denial flags include `toolDenialEndsTurn`;
that flag alone is not evidence of both the subagent and main completions
required by Test101. The checker and its bound remain unchanged. The prior
failure therefore remains indeterminate, not a demonstrated category (b).
General failure retention now keeps these flags, stop reasons, notification
links and all main/subagent records without message text for the next run.


## Follow-up 10: both consumed notification shapes

`notification-shapes-source.json` contains bounded verbatim fragments from the
public Linux x64 binaries for **2.1.280, 2.1.296 and 2.1.302**. Each binary's
size and SHA-256 were checked against its release manifest before extracting
byte offsets, lengths and fragment hashes. Binaries were read as data and
removed from scratch; no client, session, login or model was used.

All three versions serialize task notifications with `task-id`, optional
`tool-use-id`, and `status` headers. Their queue consumer preserves the payload
in `attachment.prompt` with `type: queued_command` and `commandMode`; the
attachment renderer maps that prompt to user content, supporting both strings
and text blocks. The pure captured serializers run in unit regressions with
fixture IDs, alongside both consumed record shapes. The prior heavy capture
`real-1792384274314-500326` on 2.1.280 also retained an actual queued attachment
between the denied sidechain's `end_turn` and the main `end_turn` (diagnostic
lines 12, 16, 73, 83). Its prompt was withheld, so it cannot prove notification
identity retroactively.

The observer now requires successful relay denial, the matching denied Bash
result and sidechain completion, then either a completed synchronous Agent
result or an own-session consumed completion notification and main completion.
For either notification shape, a task/agent ID or Agent-call ID must match;
all supplied IDs must agree. Its timestamp must be finite and no earlier than
the denied result and sidechain completion, and its main-stream offset must
follow the Agent launch result. Earlier, unlinked, foreign, failed, ambiguous
and merely enqueued notifications fail. Header extraction excludes summary and
result prose. The existing timeout and subsequent AD dialog-refusal acceptance remain.
Readiness comes from agent-director row state; notification records never
authorize typing.

Retention projects those notification IDs/status from both content locations,
plus attachment identity fields, through the existing secret scrub. It never
retains the prompt, summary, result, image payload or tool arguments.

## Completion-observer sweep

Searched `tests/real-agent`, `tests/integration/fixtures` and
`tests/integration/lib` for task/subagent notifications, async results, native
stop reasons and turn-completion waits:

| Observer | Finding and action |
| --- | --- |
| `test-101-denial-settled.ts` | The only async subagent notification consumer. Changed to both consumed shapes and shared header extraction; synchronous completed Agent results remain supported. |
| `ai-readback.ts`, `ai-classifier-stop.ts` | Observe parent-linked assistant `end_turn` for exact current-turn answers. Notifications do not certify an assistant answer; existing receipt handling already covers user/queued input. No change. |
| `ac20-diagnostics.ts` | Delegates completion to `completedAIReadback`; no independent native shape assumption. No change. |
| `real-case-assertions.ts` busy-proof | Matches a Bash tool result and assistant terminal stop reasons; it does not wait for an async task notification. No change. |
| `real-scenario.sh` real_wait_idle | Waits for AD `waiting`; no empty-composer or notification interpretation. |
| `test-104-fmk-real-idle-compact.sh` | Uncertain AD text outcome and ordered own-message receipts; no native idle/compaction observation. |
| `codex-evidence.ts`, `codex-ai.ts`, `codex-delivery.ts` | Exact output/receipt assertions remain independent evidence. Operational readiness uses AD state and refusals, never native task ordering. |
