# Native attachment membership: decision 24

`six-ms.json` projects clocks, byte offsets, UUID links, attachment types and
stop reasons from run `real-1792351999727-2797927`, Claude Code 2.1.296, AC11
trial 2, case 12. Source: the retained `real-agent-failures.jsonl` in
`/tmp/omv-final5-heavy-y8e6xev4`. The five setup records are at 1792356158065;
their parent receipt is at 1792356158071. The native completion is at
1792356171015. No message text, tool arguments/results, credentials or config
values are copied here.

`tests/real-ai-classifier-stop.test.ts` reuses these clocks, offsets and links
with synthetic input, journal and reply bodies. Untimed metadata is recorded
in the fixture but omitted from this replay; separate controls exercise its
exact informational shapes. This regression proves the checker accepts the
captured ancestry, not that the paid trial's original answer was correct.
Ordinary and AC15 controls cover all eight allowed setup attachment types, an earlier
turn (both a wrong parent and a timestamp at/before its last finite timestamp),
no receipt link, untimed prior bookkeeping, stale offsets, and unchanged exact
clocks for other records. Existing controls cover duplicate UUIDs, cycles, foreign sessions,
sidechains, queued commands and late forbidden actions. Preparation leads of
1, 5, 6 and 2000 ms pass when structural membership holds.

`ac23-resume.json` projects the clocks, offsets, UUID links, native record types
and stop reasons from AC23 trial 1 in `real-1792374703137-1207869`, Claude
2.1.296. Source: `/tmp/omv-final12-heavy-skgkpnm_/real-agent-failures.jsonl`.
The resumed receipt is at offset 78964; its linked `skill_listing` is at 79949,
stamped 1 ms earlier. Shutdown `cost-state`, `last-prompt` and
`file-history-snapshot` records have no timestamp. The previous turn's final
finite timestamp belongs to `turn_duration` at offset 76861. Both ordinary
read-back and AC15 controls replay this shape with synthetic input, journal,
and reply text, and reject a floor at/after the attachment or a parent from
the earlier turn. All eight setup types also retain their floor and ancestry
controls with untimed bookkeeping interposed. This proves the amended checker
behavior; the original paid resume reply's correctness remains unverified.
Current-exchange validation still rejects untimed records outside the existing
five exact informational shapes; the amendment changes only floor selection.

`claude-304-deferred-tools.json` retains the receipt-to-completion chain from
Claude 2.1.304, AC11 trial 1, run `real-1792509656324-1284261` (source:
`/tmp/rel1-gate-304/matrix/real-agent-failures.jsonl`). The assistant at offset
124302 is stamped 1792515606863; its `deferred_tools_record` parent is stamped
1792515606864. Both `deferred_tools_delta` and `deferred_tools_record` belong
to the setup family. Setup records must prove membership, but do not anchor
child timestamps: the nearest non-setup ancestor and receipt set the exact
floor. Controls replay this ancestry for ordinary read-back, AC11 and AC15,
reject backward assistant/tool-result clocks and extra real tool calls, and
also accept a larger setup lead without introducing a fixed tolerance.

`claude-304-api-request-blob.json` records the observed field shape from that
run's AC11 trial 1, offset 117952: an untimed blob containing an assistant
`ToolSearch` tool-use block. Hash, session, ID and arguments are synthetic.
The kind can carry actions, so it remains outside the blanket informational
allowlist. AC11 still rejects it. AC15 now validates request echoes separately,
as described below, and rejects every embedded forbidden action.

`claude-304-ac15-request-echoes.json` inventories all nine retained blobs from
run `real-1792519134421-3860158`. Each trial contains four user text blocks,
a system string, and a user tool-result/text pair. The last repeats the exact
ID of the earlier native `ToolSearch` result; none of these nine contains a
`tool_use`. Bodies and nested result content used in tests are synthetic.

The checksum-matched native 2.1.304 binary (SHA-256 recorded in the fixture)
confirms the interpretation: `Kvt` builds `blobCandidates` from outgoing
`params.messages` (or its privacy-cut subset), hashes canonical messages, and
removes `cache_control` from the saved copies. `appendRequestReplayRecords`
writes candidates missing from the transcript hash index, followed by an
`api-request` whose tail references their hashes. These are request-replay
context records, not separate executions. The builder and writer are at byte
offsets 245545319 and 245713043 in that exact binary.

AC15 requires the four-field native blob envelope, an untimed non-transcript
record, a hex digest, a recognized message role and understood content shapes.
It recursively checks all embedded `tool_use`/`server_tool_use` objects before
exempting the echo from time ordering. Only reply and native `ToolSearch`
tool uses pass. Tool references inside results are definitions, not calls.
Malformed/unknown content, extra envelope fields and forbidden actions still
fail; an echo supplies neither receipt nor readback/completion evidence.

## Timestamp sweep

Scope: all of `tests/real-agent`, `tests/integration`, and
`scripts/real-agent-matrix.ts`, for Claude transcripts and Codex rollouts.
Searches covered skew/tolerance/jitter names, timestamp/`at`/time arithmetic,
numeric millisecond bounds, and shell wait definitions and uses. Fixture
generation arithmetic was distinguished from predicates on observed records.

| Location | Figure and classification | Action |
| --- | --- | --- |
| `tests/real-agent/ai-readback.ts`, `nativeTime`, ordinary read-back and `assertAC15Exchange` | 5 ms before receipt/immediate parent, six native attachment types. **Jitter guess**, not an SRD pass bound. This was the only allowance found on native transcript/rollout clocks. | Replaced at both call sites by decision 24: receipt ancestry, offset after receipt predecessor, time strictly after the previous turn's last record with a finite timestamp (2026-10-19 amendment); untimed bookkeeping does not set the floor. Regressions above. |
| `tests/real-agent/codex-evidence.ts`, `completedCodexTurn`; `codex-delivery.ts`, completion polling | 180000 ms from the send through native completion. **Real completion bound**, SR-14.6 and AI completion decisions 19/21. Exact send/receipt/assistant/turn-ID checks have no jitter allowance. | Unchanged. |
| `tests/real-agent/ai-scenario.sh`, read-back waits; `ac20-diagnostics.ts`, `AC20_COMPLETION_MS` | 180 s / 180000 ms completed exact read-back deadline. **Real pass bound**, SR-14.6 and decision 21. Ordinary Claude uses observable polling; AC20 separately records the deadline. | Unchanged. |
| `tests/integration/fixtures/transcript-receipts.ts`, latency | p95 typing start <=2000 ms and delivery <=10000 ms. **Real pass bounds**, AC76 / SR-14.3–4; no subtraction from a native timestamp to admit an earlier record. | Unchanged. |
| `tests/integration/fixtures/real-case-assertions.ts`, retry/launch/Enter checks | 10000/30000/60000 ms retype spacing (SR-6.4), restart spacing reset below 60000 ms, 1000 ms launch settle (SR-5.2), 500 ms text/Enter pause (SR-5.4). **Real behavioral bounds**, on journal/shim/server times, not native clock tolerances. | Unchanged. |

Other numeric timing matches are not native timestamp allowances:

- `codex-delivery.ts`'s >=1000 ms unsubmitted-text observation is a measured
  no-turn research interval, not timestamp skew or an SRD latency pass bound.
  It cannot turn missing evidence into receipt/completion evidence.
- `real-scenario.sh` defines delivery/launch/compaction waits of 180/300/120 s
  (SR-14.6), and native idle-compaction observation up to 2700 s (decision 16).
  `codex-delivery.ts` and `codex-crash-barrier.ts` also bound operational waits
  at 180000 ms. These deadlines do not adjust native timestamps.
- `ac20-diagnostics.ts`'s 60000 ms post-retry/post-late-completion grace,
  2100000 ms diagnostic ceiling and 1000 ms vanished-process observation are
  diagnostic-only (decision 21). No path after the 180000 ms deadline passes.
- `scripts/real-agent-matrix.ts` has process/job termination and auth-lease
  retirement waits, not native transcript comparisons.
- `test-24-fmk-stuck-launch.sh` permits 0.5 s in an approver **server-log**
  comparison; `test-17-fmk-launch-pending.sh` permits +/-2 s on stub server
  health ticks; `test-6-missing-working-dir.sh` has scheduling margins.
  These are legacy stub/server timing tolerances, outside native transcript
  or rollout membership. Decision 24's UUID/receipt rule cannot apply to them.
- Scenario polling, stub lifecycle grace, switch-over call deadlines and
  generated synthetic control timestamps are not native acceptance skew.

All receipt/send-window, classifier-stop and busy-tool checks otherwise use
exact timestamp comparisons. No Codex jitter guess was found.
