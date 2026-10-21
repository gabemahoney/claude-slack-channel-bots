# b.d6n delivery model verification

This follow-up aligns the release-1 model with b.d6n's removal of synthetic delivery launch IDs and the launch-settle timer. The owner authorized changes to `spec/tla` and the frozen delivery traces. The implementation baseline is `8d076a6b`, rebased on release 1 (`dc7966fe`).

Delivery still requires AD `waiting` and the existing non-screen guards. A relaunch observation comes from a transition into AD `pending`, `ended` or `missing`, or a changed `session_id`. A same-session resume is therefore visible through its row transition. New engine instances start with a recovery check, without inventing a bot identity.

The definitions of durability, no loss, FIFO, one-in-flight, receipt-backed advancement, key deduplication and typing guards are unchanged. Environment premises, fairness, fault budgets, configuration bounds, manifest modes, seeds and expected violations are unchanged. `NoDuplicateKey` prevents duplicate durable acceptance; the existing `AtMostOnce` negative witness still documents possible repeated delivery after an uncertain outcome.

## Model and replay changes

| File | One-line reason |
|---|---|
| `spec/tla/PersonaDelivery.tla` | Remove launch IDs from readings, engine state and journal records; replace them with the AD row/session relaunch predicate and remove settle timers, guards and expiry metadata. |
| `spec/tla/ci/profile_restart.py` | Describe the retained relaunch flag and session observation in the restart projection audit. |
| `spec/tla/ci/fairness-probe/PermissionFairness.tla` | Remove the obsolete settle-elapsed assumption from the diagnostic's comment; its state and transitions are unchanged. |
| `spec/tla/ci/temporal_sensitivity.py` | Prefer productive engine steps between recurring untargeted events to keep the no-settle contrast search within its proof chunk, retaining exact original-action, schedule, fairness and property validation. |
| `spec/tla/PROVENANCE.txt` | Refresh current input pins while preserving earlier reports as historical evidence. |
| `spec/tla/README.md` | Point to the b.d6n verification result and explain the AD-only relaunch boundary. |
| `tests/test-helpers/delivery-model-replay.ts` | Reject retired launch/settle fields and count actual same-session resumes and session changes while replaying production decisions. |
| `tests/delivery-model-conformance.test.ts` | Require both lifecycle cases and verify the correct policy passes before requiring the FIFO mutant to fail. |
| `docs/architecture.md`, `docs/testing-guide.md` | Replace the obsolete model handoff with the AD row/session contract and current verification references. |

`MaxLaunches` remains an exploration bound with its original values. `BotLifeCount` derives that bound from existing fault counters and chooses the existing terminal-row variant; it is never exposed in delivery knowledge or persisted as an identity. `RestartSafetyView` retains the relaunch flag and frozen relaunch observation wherever future decisions consume them.

No configuration, invariant, fairness obligation, proof helper or manifest expectation was relaxed. The local checker freezes 107 inputs before execution and rejects changes during the run.

## Trace inventory

The complete path-by-path inventory is [bd6n-trace-changes.json](../tests/test-helpers/bd6n-trace-changes.json). Each changed trace has one reason and before/after SHA-256 hashes. Release 1's [cardinal-trace-changes.json](../tests/test-helpers/cardinal-trace-changes.json) remains its historical inventory.

Traces are regenerated from actual TLC output, including original-action accepted-work witnesses, temporal control proofs, raw counterexample graphs and the independent finite pullback replay. They are not edited to agree with production choices.

## Verification

All **84/84 rows matched their expected results**: 76 delivery-manifest rows and eight auxiliary checks. The manifest retains 8 passing bounded exhaustive checks, 40 expected counterexamples and 28 fixed-seed simulation rows. Every required independent proof completed. All 107 current/frozen input hashes agree; `partial: false`, `inputsUnchanged: true`, `certification: false`.

The regenerated corpus contains **266 traces and 40,776 states**, including the 19-state, 18-edge supplemental pullback prefix. Its 267 changed fixture files each have a one-line reason and before/after hash in the linked inventory. Coverage retains all 18 engine actions, 38 negative controls, 26 bounded faults and four flapping actions.

The local checker used four concurrent rows, one TLC worker and a 384 MiB heap per primary row, with a 3,600-second row budget and unchanged 60-second maximum temporal proof chunks. The longest completed row took 1,432.620 seconds. No simulation is presented as a temporal proof.

| Binding | SHA-256 |
|---|---|
| `PersonaDelivery.tla` | `22316e7dd97487a3d05dbd41c6b27c420f4cae86bf3c632ae00a632210091949` |
| `ci/temporal_sensitivity.py` | `352af19a6d0d8492adccbcf79297f6437c46c7dc35b83cd8a46cc12007da90ab` |
| Original complete report | `bda2ba25da2ca4caa67b60a82ab4039d2e1a101f24e053d011b77a0fae13ea9e` |

Runtime conformance passed **4/4 tests**, including every frozen-state replay and the production FIFO mutation control, in 27.14 seconds (`/tmp/bd6n-model-conformance.log`). The original policy passes the same fixture before the reversed-order mutant is rejected for a production choice/target mismatch; the FIFO sensitivity finding is cleared.

The complete isolated unit suite passed **31,047 tests, 21 skipped, zero failures**, with 196,202 assertions across 179 files in 182.62 seconds (`/tmp/bd6n-model-full-units.log`). Both runs used a scratch HOME/state and the repository's host-safety guard, with ambient token/persona/Claude-config overrides removed. The existing skips remain; no test was disabled for this update.

`bun run typecheck`, `bun run check:mocks` (262 files, zero violations) and whitespace checks passed. The requested test-review found no important issues in the changed replay/conformance tests and fixtures. The final audit also verified every trace inventory hash against its Git baseline/current file, unchanged invariant/fairness/bound definitions and configurations, and an unchanged release-1 trace inventory and `.claude` tree.

### Complete row results

| Configuration | Mode | Expected check/result | Actual exit | Verdict |
|---|---|---|---|---|
| `core_head_taken_in` | check | pass | 0 | matched |
| `restart_control_next_item` | check | OneInFlight | 12 | matched |
| `restart_control_next_part` | check | OneInFlight | 12 | matched |
| `restart_control_send_is_delivery` | check | ReceiptBacked | 12 | matched |
| `restart_control_queue_is_receipt` | check | TranscriptFIFO | 12 | matched |
| `restart_control_start_drop` | check | NoDrop | 12 | matched |
| `restart_control_compact_open` | check | NoDrop | 12 | matched |
| `restart_control_early_ack` | check | DurableAccept | 12 | matched |
| `restart_control_skip_refused` | check | InOrder | 12 | matched |
| `restart_control_start_unsent_head` | check | InOrder | 12 | matched |
| `restart_control_retype_into_text` | check | TypingGuards | 12 | matched |
| `restart_control_retype_working` | check | NoRetypeWhileWorking | 12 | matched |
| `restart_control_reconnect_keys` | check | GateExclusive | 12 | matched |
| `restart_control_reconnect_running` | check | TypingGuards | 12 | matched |
| `restart_control_duplicate_key` | check | NoDuplicateKey | 12 | matched |
| `restart_order` | check | pass | 0 | matched |
| `restart_order_across` | check | pass | 0 | matched |
| `restart_order_bot` | check | pass | 0 | matched |
| `restart_order_enter` | check | pass | 0 | matched |
| `restart_order_busy` | check | pass | 0 | matched |
| `restart_order_simulation` | simulate | pass | 0 | matched |
| `safety_plain` | check | pass | 0 | matched |
| `safety_calls` | simulate | pass | 0 | matched |
| `safety_enter_unknown` | simulate | pass | 0 | matched |
| `safety_agent_input` | check | pass | 0 | matched |
| `safety_bot_resume` | simulate | pass | 0 | matched |
| `safety_bot_sessions` | simulate | pass | 0 | matched |
| `safety_storage` | simulate | pass | 0 | matched |
| `safety_screen` | simulate | pass | 0 | matched |
| `safety_connection` | simulate | pass | 0 | matched |
| `safety_persona` | simulate | pass | 0 | matched |
| `safety_identical` | simulate | pass | 0 | matched |
| `live_plain` | simulate | pass | 0 | matched |
| `live_calls` | simulate | pass | 0 | matched |
| `live_enter_unknown` | simulate | pass | 0 | matched |
| `live_agent_input` | simulate | pass | 0 | matched |
| `live_bot_resume` | simulate | pass | 0 | matched |
| `live_bot_sessions` | simulate | pass | 0 | matched |
| `live_storage` | simulate | pass | 0 | matched |
| `live_screen` | simulate | pass | 0 | matched |
| `live_connection` | simulate | pass | 0 | matched |
| `live_persona` | simulate | pass | 0 | matched |
| `live_empty_reconnect` | simulate | pass | 0 | matched |
| `control_next_item` | check | OneInFlight | 12 | matched |
| `control_next_part` | check | OneInFlight | 12 | matched |
| `control_send_is_delivery` | check | ReceiptBacked | 12 | matched |
| `control_queue_is_receipt` | check | TranscriptFIFO | 12 | matched |
| `control_start_drop` | check | NoDrop | 12 | matched |
| `control_compact_open` | check | NoDrop | 12 | matched |
| `control_early_ack` | check | DurableAccept | 12 | matched |
| `control_skip_refused` | check | InOrder | 12 | matched |
| `control_start_unsent_head` | check | InOrder | 12 | matched |
| `control_retype_into_text` | check | TypingGuards | 12 | matched |
| `control_retype_working` | check | NoRetypeWhileWorking | 12 | matched |
| `control_reconnect_keys` | check | GateExclusive | 12 | matched |
| `control_keep_gate` | check | GateFreeInfinitelyOften | 13 | matched |
| `control_hold_gate_mcp_reconnect` | check | ReconnectNotBlocked | 13 | matched |
| `control_hold_gate_mcp_delivery` | check | EventuallyDelivered | 13 | matched |
| `control_no_deferred` | check | ReconnectNotBlocked | 13 | matched |
| `control_reconnect_running` | check | TypingGuards | 12 | matched |
| `control_deferred_only_open` | check | ReconnectNotBlocked | 13 | matched |
| `control_park_retype` | check | EventuallyDelivered | 13 | matched |
| `control_unreadable_park` | check | HeadTakenIn | 13 | matched |
| `control_weak_observe` | check | EventuallyDelivered | 13 | matched |
| `control_replace_observation` | check | EventuallyDelivered | 13 | matched |
| `control_duplicate_key` | check | NoDuplicateKey | 12 | matched |
| `control_no_head_takein_assumption` | check | HeadTakenIn | 13 | matched |
| `witness_duplicates` | check | AtMostOnce | 12 | matched |
| `probe_premise` | check | NotPremise | 13 | matched |
| `trace_calls` | simulate | pass | 0 | matched |
| `trace_agent` | simulate | pass | 0 | matched |
| `trace_lifecycle` | simulate | pass | 0 | matched |
| `trace_storage` | simulate | pass | 0 | matched |
| `trace_screen` | simulate | pass | 0 | matched |
| `trace_flapping` | simulate | pass | 0 | matched |
| `trace_identical` | simulate | pass | 0 | matched |
| `proof_simulation` | simulate | pass | 0 | matched |
| `proof_safety` | check | SafetyProbe | 12 | matched |
| `proof_temporal` | check | TemporalProbe | 13 | matched |
| `permission_safety` | check | pass | 0 | matched |
| `permission_delivery_reachable` | check | NotDelivered | 12 | matched |
| `permission_premise_reachable` | check | NotPremise | 13 | matched |
| `permission_eventually_delivered` | check | EventuallyDelivered | 13 | matched |
| `permission_head_taken_in` | check | HeadTakenIn | 13 | matched |

The final run directory is `spec/tla/ci/.runs/bd6n-model-verified-20261020`.

The committed coverage report and compressed fixtures retain portable proof artifacts and source bindings. This is local TLC evidence with `certification: false`, not scheduler certification. Bounded exhaustive checks, sampled simulations and the finite supplemental witness retain their separate scopes. No `/ci`, merge or push is part of this follow-up.
