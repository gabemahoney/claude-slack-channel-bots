# b.acu / b.aqj change and verification report

This report covers audit A01–A48 and associated AT01–AT09. A49–A51 and section B are excluded. Source milestones: `bc3d70d9`, `5f2f62d4`, `5ef71567`, `e54e638e`; model milestone: `fcb93897`. Owner waiting-only, model-unblock and release instructions supersede the audit's AD-I block and earlier screen-dependent requirements.

## Current contract

Only fresh agent-director `waiting` authorizes delivery, recovery Enter and reconnect text/Enter, with existing persona/up/latch/hold/lifecycle/marker/relay/MCP guards. Refusals retain queued work and existing backoff. Exact own-message transcript receipts alone confirm delivery; no idle/busy/turn/compaction state is inferred. Pane text is never consumed or retained, including diagnostics. Startup/trust autoanswers are removed; AD pre-trust or a human handles dialogs. Pending-row cover, grace/bound and normal retries remain. Authoritative `get` records own-launch identity; the latch observer remains.

Unconfirmed durable own sends receive a persisted `send_kind: enter` recovery attempt under AD waiting/backoff, then a receipt window. Only absent confirmation permits later full retype. Durable accepted work, strict FIFO, one in flight and at-least-once behavior remain; duplicates are possible.

## Audit disposition

| Finding | Disposition |
|---|---|
| A01 | Removed native screen classifier and presentation fixtures; AD waiting/refusals own readiness. |
| A02 | Removed native screen classifier and presentation fixtures; AD waiting/refusals own readiness. |
| A03 | Removed native screen classifier and presentation fixtures; AD waiting/refusals own readiness. |
| A04 | Removed native screen classifier and presentation fixtures; AD waiting/refusals own readiness. |
| A05 | Removed native screen classifier and presentation fixtures; AD waiting/refusals own readiness. |
| A06 | Removed native screen classifier and presentation fixtures; AD waiting/refusals own readiness. |
| A07 | Removed native screen classifier and presentation fixtures; AD waiting/refusals own readiness. |
| A08 | Removed native screen classifier and presentation fixtures; AD waiting/refusals own readiness. |
| A09 | Removed native screen classifier and presentation fixtures; AD waiting/refusals own readiness. |
| A10 | Removed native screen classifier and presentation fixtures; AD waiting/refusals own readiness. |
| A11 | Removed native screen classifier and presentation fixtures; AD waiting/refusals own readiness. |
| A12 | Removed native screen classifier and presentation fixtures; AD waiting/refusals own readiness. |
| A13 | Removed native screen classifier and presentation fixtures; AD waiting/refusals own readiness. |
| A14 | Removed native screen classifier and presentation fixtures; AD waiting/refusals own readiness. |
| A15 | Removed native screen classifier and presentation fixtures; AD waiting/refusals own readiness. |
| A16 | Removed native screen classifier and presentation fixtures; AD waiting/refusals own readiness. |
| A17 | Removed native screen classifier and presentation fixtures; AD waiting/refusals own readiness. |
| A18 | Delivery/reconnect use waiting-only fresh guards; uncertain own sends use durable recovery Enter, backoff and exact receipt wait. |
| A19 | Delivery/reconnect use waiting-only fresh guards; uncertain own sends use durable recovery Enter, backoff and exact receipt wait. |
| A20 | Delivery/reconnect use waiting-only fresh guards; uncertain own sends use durable recovery Enter, backoff and exact receipt wait. |
| A21 | Delivery/reconnect use waiting-only fresh guards; uncertain own sends use durable recovery Enter, backoff and exact receipt wait. |
| A22 | Delivery/reconnect use waiting-only fresh guards; uncertain own sends use durable recovery Enter, backoff and exact receipt wait. |
| A23 | Delivery/reconnect use waiting-only fresh guards; uncertain own sends use durable recovery Enter, backoff and exact receipt wait. |
| A24 | Delivery/reconnect use waiting-only fresh guards; uncertain own sends use durable recovery Enter, backoff and exact receipt wait. |
| A25 | Delivery/reconnect use waiting-only fresh guards; uncertain own sends use durable recovery Enter, backoff and exact receipt wait. |
| A26 | Removed pane/transcript idle fold and its consumers; authoritative AD state and normal retry/reconciliation remain. |
| A27 | Removed pane/transcript idle fold and its consumers; authoritative AD state and normal retry/reconciliation remain. |
| A28 | Removed pane/transcript idle fold and its consumers; authoritative AD state and normal retry/reconciliation remain. |
| A29 | Removed pane/transcript idle fold and its consumers; authoritative AD state and normal retry/reconciliation remain. |
| A30 | Removed pane/transcript idle fold and its consumers; authoritative AD state and normal retry/reconciliation remain. |
| A31 | Removed pane/transcript idle fold and its consumers; authoritative AD state and normal retry/reconciliation remain. |
| A32 | Removed pane/transcript idle fold and its consumers; authoritative AD state and normal retry/reconciliation remain. |
| A33 | Removed pane/transcript idle fold and its consumers; authoritative AD state and normal retry/reconciliation remain. |
| A34 | Removed pane/transcript idle fold and its consumers; authoritative AD state and normal retry/reconciliation remain. |
| A35 | Removed pane/transcript idle fold and its consumers; authoritative AD state and normal retry/reconciliation remain. |
| A36 | Removed pane/transcript idle fold and its consumers; authoritative AD state and normal retry/reconciliation remain. |
| A37 | Removed pane/transcript idle fold and its consumers; authoritative AD state and normal retry/reconciliation remain. |
| A38 | Removed pane/transcript idle fold and its consumers; authoritative AD state and normal retry/reconciliation remain. |
| A39 | Removed pane/transcript idle fold and its consumers; authoritative AD state and normal retry/reconciliation remain. |
| A40 | Removed pane/transcript idle fold and its consumers; authoritative AD state and normal retry/reconciliation remain. |
| A41 | Removed startup/trust autoanswer and pending pane lap; AD pre-trust/human answers, pending grace/bound/retries remain. |
| A42 | Removed startup/trust autoanswer and pending pane lap; AD pre-trust/human answers, pending grace/bound/retries remain. |
| A43 | Removed startup/trust autoanswer and pending pane lap; AD pre-trust/human answers, pending grace/bound/retries remain. |
| A44 | Removed startup/trust autoanswer and pending pane lap; AD pre-trust/human answers, pending grace/bound/retries remain. |
| A45 | Removed Claude native queue/turn reconstruction; exact own-message receipts only. |
| A46 | Removed Codex task-order idle evidence; AD waiting governs retries. |
| A47 | Removed native compaction records as lifecycle events; AD launch/session observations remain. |
| A48 | Removed parsed screen notices, durations and suppression; queue age and AD/refusal/lifecycle facts remain. |
| AT01 | Tests/diagnostics now use AD rows/refusals and independent exact receipts; native pane text/compatibility assertions removed. |
| AT02 | Tests/diagnostics now use AD rows/refusals and independent exact receipts; native pane text/compatibility assertions removed. |
| AT03 | Tests/diagnostics now use AD rows/refusals and independent exact receipts; native pane text/compatibility assertions removed. |
| AT04 | Tests/diagnostics now use AD rows/refusals and independent exact receipts; native pane text/compatibility assertions removed. |
| AT05 | Tests/diagnostics now use AD rows/refusals and independent exact receipts; native pane text/compatibility assertions removed. |
| AT06 | Tests/diagnostics now use AD rows/refusals and independent exact receipts; native pane text/compatibility assertions removed. |
| AT07 | Tests/diagnostics now use AD rows/refusals and independent exact receipts; native pane text/compatibility assertions removed. |
| AT08 | Tests/diagnostics now use AD rows/refusals and independent exact receipts; native pane text/compatibility assertions removed. |
| AT09 | Tests/diagnostics now use AD rows/refusals and independent exact receipts; native pane text/compatibility assertions removed. |

## Remaining outcome-only `readPane` calls

| Call site | Purpose and payload handling |
|---|---|
| `src/cli.ts` teardown reader | CLI teardown probe; discards success payload and returns only AD outcome for checked teardown handling. |
| `src/session-manager.ts` shared own-pane probe | Prompt-row recovery and server teardown consumers; success is an outcome sentinel, never pane contents. Typed AD failure/latch/outage handling remains. |
| `src/session-manager.ts` latch probe | Own-row latch recheck; explicitly discards success payload, uses only AD success/error class. |

The owner explicitly permits these outcome/error-class probes for this scope. They establish no idle/readiness fact. No automatic `expect_pane_sha256` remains. Current direct call inventory: `src/cli.ts:1818`, `src/session-manager.ts:3253`, `src/session-manager.ts:16810`. **PLACEHOLDER — refresh line numbers after final source verification**.

## Model and helper changes

| Path | One-line reason |
|---|---|
| `spec/tla/PersonaDelivery.tla` | Remove screen/idle/compaction-derived readiness; add durable recovery Enter intent and volatile completion identity under waiting-only guards. |
| `spec/tla/PersonaDelivery.tla:RestartStateConstraint` | Expand explicit per-part durable-send prefix from two to four so text/recovery Enter/retype/recovery Enter remain reachable; keep all invariants. |
| `spec/tla/ci/fairness-probe/PermissionFairness.tla` | Use AD waiting/live refusals and model recovery Enter while retaining the original seven fairness obligations and first-text-refusal diagnostic. |
| `spec/tla/ci/check_cardinal.py` | Freeze actual model/runner/config hashes, retain raw logs and independent proofs, and include all76 delivery rows plus8 auxiliary checks in a detached local run. |
| `spec/tla/ci/work_witness.py` | Audit the expanded four-send prefix while independently replaying original actions/fairness/exact receipts. |
| `spec/tla/ci/profile_restart.py` | Retain recoveryAttempt, durable attempt IDs and recovery-enter readings in the projection/dataflow audit. |
| `spec/tla/ci/runner.py` | Declare current AD typing invariant/mutants and four-send reduction metadata. |
| `spec/tla/ci/trace_contract.py` | Validate recovery action divergence and four-send companion counterexamples. |
| `spec/tla/ci/temporal_sensitivity.py` | Keep independent temporal proof guides within current screen-free model and current four-send scope. |
| `spec/tla/ci/suite.tsv` | Retain all76 checks/modes/seeds and describe AD guard targets and expanded recovery prefix. |
| `spec/tla/ci/fairness-probe/job.py` | Validate first-text refusal lassos from AD live guard races without any screen premise. |

## Config changes

| Path | One-line reason |
|---|---|
| `spec/tla/ci/cfg/control_reconnect_running.cfg` | Replace screen-dependent NoTypeIntoText with AD waiting and existing local TypingGuards. |
| `spec/tla/ci/cfg/control_retype_into_text.cfg` | Replace composer-inspection mutant with meaningful AD/local-guard bypass mutant and matching textUnknown/relayOff faults. |
| `spec/tla/ci/cfg/core_head_taken_in.cfg` | Replace screen-dependent NoTypeIntoText with AD waiting and existing local TypingGuards. |
| `spec/tla/ci/cfg/live_agent_input.cfg` | Replace screen-dependent NoTypeIntoText with AD waiting and existing local TypingGuards. |
| `spec/tla/ci/cfg/live_bot_resume.cfg` | Replace screen-dependent NoTypeIntoText with AD waiting and existing local TypingGuards. |
| `spec/tla/ci/cfg/live_bot_sessions.cfg` | Replace screen-dependent NoTypeIntoText with AD waiting and existing local TypingGuards. |
| `spec/tla/ci/cfg/live_calls.cfg` | Replace screen-dependent NoTypeIntoText with AD waiting and existing local TypingGuards. |
| `spec/tla/ci/cfg/live_connection.cfg` | Replace screen-dependent NoTypeIntoText with AD waiting and existing local TypingGuards. |
| `spec/tla/ci/cfg/live_empty_reconnect.cfg` | Replace screen-dependent NoTypeIntoText with AD waiting and existing local TypingGuards. |
| `spec/tla/ci/cfg/live_enter_unknown.cfg` | Replace screen-dependent NoTypeIntoText with AD waiting and existing local TypingGuards. |
| `spec/tla/ci/cfg/live_persona.cfg` | Replace screen-dependent NoTypeIntoText with AD waiting and existing local TypingGuards. |
| `spec/tla/ci/cfg/live_plain.cfg` | Replace screen-dependent NoTypeIntoText with AD waiting and existing local TypingGuards. |
| `spec/tla/ci/cfg/live_screen.cfg` | Replace screen-dependent NoTypeIntoText with AD waiting and existing local TypingGuards. |
| `spec/tla/ci/cfg/live_storage.cfg` | Replace screen-dependent NoTypeIntoText with AD waiting and existing local TypingGuards. |
| `spec/tla/ci/cfg/restart_control_reconnect_running.cfg` | Replace screen-dependent NoTypeIntoText with AD waiting and existing local TypingGuards. |
| `spec/tla/ci/cfg/restart_control_retype_into_text.cfg` | Replace composer-inspection mutant with meaningful AD/local-guard bypass mutant and matching textUnknown/relayOff faults. |
| `spec/tla/ci/cfg/restart_order.cfg` | Replace screen-dependent NoTypeIntoText with AD waiting and existing local TypingGuards. |
| `spec/tla/ci/cfg/restart_order_across.cfg` | Replace screen-dependent NoTypeIntoText with AD waiting and existing local TypingGuards. |
| `spec/tla/ci/cfg/restart_order_bot.cfg` | Replace screen-dependent NoTypeIntoText with AD waiting and existing local TypingGuards. |
| `spec/tla/ci/cfg/restart_order_busy.cfg` | Replace screen-dependent NoTypeIntoText with AD waiting and existing local TypingGuards. |
| `spec/tla/ci/cfg/restart_order_enter.cfg` | Replace screen-dependent NoTypeIntoText with AD waiting and existing local TypingGuards. |
| `spec/tla/ci/cfg/restart_order_simulation.cfg` | Replace screen-dependent NoTypeIntoText with AD waiting and existing local TypingGuards. |
| `spec/tla/ci/cfg/safety_agent_input.cfg` | Replace screen-dependent NoTypeIntoText with AD waiting and existing local TypingGuards. |
| `spec/tla/ci/cfg/safety_bot_resume.cfg` | Replace screen-dependent NoTypeIntoText with AD waiting and existing local TypingGuards. |
| `spec/tla/ci/cfg/safety_bot_sessions.cfg` | Replace screen-dependent NoTypeIntoText with AD waiting and existing local TypingGuards. |
| `spec/tla/ci/cfg/safety_calls.cfg` | Replace screen-dependent NoTypeIntoText with AD waiting and existing local TypingGuards. |
| `spec/tla/ci/cfg/safety_connection.cfg` | Replace screen-dependent NoTypeIntoText with AD waiting and existing local TypingGuards. |
| `spec/tla/ci/cfg/safety_enter_unknown.cfg` | Replace screen-dependent NoTypeIntoText with AD waiting and existing local TypingGuards. |
| `spec/tla/ci/cfg/safety_identical.cfg` | Replace screen-dependent NoTypeIntoText with AD waiting and existing local TypingGuards. |
| `spec/tla/ci/cfg/safety_persona.cfg` | Replace screen-dependent NoTypeIntoText with AD waiting and existing local TypingGuards. |
| `spec/tla/ci/cfg/safety_plain.cfg` | Replace screen-dependent NoTypeIntoText with AD waiting and existing local TypingGuards. |
| `spec/tla/ci/cfg/safety_screen.cfg` | Replace screen-dependent NoTypeIntoText with AD waiting and existing local TypingGuards. |
| `spec/tla/ci/cfg/safety_storage.cfg` | Replace screen-dependent NoTypeIntoText with AD waiting and existing local TypingGuards. |
| `spec/tla/ci/cfg/trace_agent.cfg` | Replace screen-dependent NoTypeIntoText with AD waiting and existing local TypingGuards. |
| `spec/tla/ci/cfg/trace_calls.cfg` | Replace screen-dependent NoTypeIntoText with AD waiting and existing local TypingGuards. |
| `spec/tla/ci/cfg/trace_flapping.cfg` | Replace screen-dependent NoTypeIntoText with AD waiting and existing local TypingGuards. |
| `spec/tla/ci/cfg/trace_identical.cfg` | Replace screen-dependent NoTypeIntoText with AD waiting and existing local TypingGuards. |
| `spec/tla/ci/cfg/trace_lifecycle.cfg` | Replace screen-dependent NoTypeIntoText with AD waiting and existing local TypingGuards. |
| `spec/tla/ci/cfg/trace_screen.cfg` | Replace screen-dependent NoTypeIntoText with AD waiting and existing local TypingGuards. |
| `spec/tla/ci/cfg/trace_storage.cfg` | Replace screen-dependent NoTypeIntoText with AD waiting and existing local TypingGuards. |

## Final trace change inventory

**PLACEHOLDER — fill from the final exporter inventory after export.** List every actual added/rewritten/deleted trace file and one-line reason, including metadata/provenance/coverage changes. The 76 manifest-row plan is not a substitute for the actual-file inventory. Screen-marker-only cases must not remain as readiness evidence. Keep all non-screen no-loss/FIFO/durable-work controls and duplicate witness semantics.

## Verification results

**PLACEHOLDER — final canonical 84-row run (76 manifest + eight auxiliary), run ID/path, frozen input identity, every per-config result and expected-control target, exhaustive versus sampled scope, trace export counts and conformance replay results.** Verification is pending; no current PASS is claimed here.

**PLACEHOLDER — full isolated unit-suite outcome; full `/ci` run ID and verdict; final commit list.** Targeted documentation check with scratch HOME/state ran 2,456 shipped-doc tests: 2,454 passed and two failed. Both remaining failures assert already-published 0.17.0 behavior under Unreleased; the calling agent approved anchoring those tests to the released entry instead of duplicating historical notes. Architecture/link checks passed; `git diff --check` was clean. **PLACEHOLDER — insert the final targeted doc-check result after those test updates.** The documentation worker runs no full suite or CI and makes no commit/merge/push. The calling agent fills these after verification.

## Documentation boundary

Current operator guidance lives in `docs/bots.md` and `docs/troubleshooting.md`; release behavior is under `CHANGELOG.md` Unreleased. Architecture, engineering/testing guides, the model README and affected test READMEs use AD ownership. `.claude/**` is explicitly excluded from edits even if historical prose there remains stale. No source, test code, config or frozen proof input is changed by the documentation worker.
