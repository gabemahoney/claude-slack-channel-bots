# Claude Code 2.1.302 Test101 record audit

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

This audit establishes no renamed completion record that warrants a checker
change. It does not prove that the failed run emitted a completed assistant
turn, or that notification consumption reached the main transcript: those
transcripts were deleted. Native denial flags include `toolDenialEndsTurn`;
that flag alone is not evidence of both the subagent and main completions
required by Test101. The checker and its bound remain unchanged. The prior
failure therefore remains indeterminate, not a demonstrated category (b).
General failure retention now keeps these flags, stop reasons, notification
links and all main/subagent records without message text for the next run.
