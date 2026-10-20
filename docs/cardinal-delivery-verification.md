# b.acu / b.aqj change and verification report

This report covers audit A01–A48 and associated AT01–AT09. A49–A51 and section B are excluded. Source milestones: `bc3d70d9`, `5f2f62d4`, `5ef71567`, `e54e638e`, `10486a91`; test restoration milestone: `f99c6d38`; model milestone: `fcb93897`. Owner waiting-only, model-unblock and release instructions supersede the audit's AD-I block and earlier screen-dependent requirements.

## Current contract

Only fresh agent-director `waiting` authorizes delivery, recovery Enter and reconnect text/Enter, with existing persona/up/latch/hold/lifecycle/marker/relay guards; normal delivery text/retypes also require connected MCP, while recovery Enter is allowed with MCP disconnected. Refusals retain queued work and existing backoff. Exact own-message transcript receipts alone confirm delivery; no idle/busy/turn/compaction state is inferred. Pane text is never consumed or retained, including diagnostics. Startup/trust autoanswers are removed; AD pre-trust or a human handles dialogs. Pending-row cover, grace/bound and normal retries remain. Authoritative `get` records own-launch identity; the latch observer remains.

Unconfirmed durable own sends receive a persisted `send_kind: enter` recovery attempt under AD waiting/local guards/backoff, including with MCP disconnected, then a receipt window. `recoverBeforeReconnect` prevents reconnect text from overtaking durable attempts or a successful recovery Enter awaiting its receipt window. Only absent confirmation permits later full retype. Durable accepted work, strict FIFO, one in flight and at-least-once behavior remain; duplicates are possible.

Receipt-window fix `7e80d089` keeps reconciliation blocked after an AD read failure releases the lease: an unconfirmed current attempt requires phase `ready`, no `receiptWorking` extension and matching launch/session/recovery-attempt identity. AD `working` extends recovery through a fresh full receipt wait after `waiting`; an exact receipt permits early reconnect only after its `delivered` append is durable. Four production engine regressions check timeout/lease release, durable receipt completion, failed recovery-intent append/backoff and working-to-waiting extension. `ModelReconnectStep` abstracts reconciliation and does not verify this adapter-level receipt-window guard.

Reconnect records input intent before text. Partial or uncertain input resumes with Enter alone; definite text refusal clears intent. Pending control input blocks delivery keys and retains lifecycle retry ownership even after MCP connects. Launch/session change, terminal/absent rows, teardown and shutdown cancel intent and delayed keys.

Documentation follow-up removes working/waiting pane checks, stale screen-duration notices, native final-pane/composer diagnostics, startup approver/trust Enter instructions and the obsolete `working-tmux-gone`/`waiting-row-pane-gone` evidence rows. Outcome-only prompt-row, latch and teardown probes remain. The prior local model, trace, conformance and unit results are recorded below. External CI failed at `712013d9` and again at repair baseline `3a6f2300`; both repair rounds and their verification limits are recorded separately below.

## Audit disposition

Original references below are from `cardinal-audit-report.md` at audited revision `a01d092d`; they identify the removed checks, not current source locations.

| Finding | Original file:line reference | Removed check | Current disposition |
|---|---|---|---|
| A01 | `src/delivery-screen.ts:5`, `:8`, `:128`, `:133`, `:141`, `:145`, `:148` | Claude terminal-control stripping, box geometry and prompt-marker composer classification. | Deleted `delivery-screen.ts` and its presentation fixtures; fresh AD waiting/refusals govern delivery. |
| A02 | `src/delivery-screen.ts:16` | Version-specific `l>` residue, rule width, NBSP prompt and manual-footer repair. | Deleted the rendering repair with the classifier; native version changes require no CSCB presentation patch. |
| A03 | `src/delivery-screen.ts:140` | Claude footer-prefix whitelist that classified unknown footers as menus. | Deleted footer interpretation; AD state and typed refusals supply the action contract. |
| A04 | `src/delivery-screen.ts:24`, `:136`, `:157` | Menu inference from cancel/select/confirm/navigation wording and screen regions. | Deleted screen-region/menu matching; AD row/refusal handling retains queued work. |
| A05 | `src/delivery-screen.ts:117` | Claude placeholder wording treated as an empty composer. | Deleted placeholder recognition; no displayed text establishes readiness or draft ownership. |
| A06 | `src/delivery-screen.ts:151`, `:158`, `:164` | Codex prompt location, continuation indentation and composer/footer splitting. | Deleted Codex screen extraction; no pane payload enters delivery observations. |
| A07 | `src/delivery-screen.ts:85` | Codex model/effort status-row matching and blank-row layout. | Deleted model/status-format recognition; fresh AD waiting governs typing. |
| A08 | `src/delivery-screen.ts:120` | Two hardcoded Codex placeholders treated as empty input. | Deleted placeholder matching; no native placeholder compatibility list remains. |
| A09 | `src/delivery-screen.ts:31`, `:154` | Codex slash-popup inference from prompt, commands, indentation and option count. | Deleted popup detection; AD refusals defer the durable item under existing backoff. |
| A10 | `src/delivery-screen.ts:48`, `:53`, `:57` | Codex `@` chooser inference from insert/filter hints, Skill suffix and options. | Deleted chooser parsing and its native fixtures; only AD outcomes govern action. |
| A11 | `src/delivery-screen.ts:48`, `:53`, `:58` | Codex `$` chooser inference from exact hints and Skill/App row layout. | Deleted chooser parsing and its native fixtures; no selector layout is interpreted. |
| A12 | `src/delivery-screen.ts:69`, `:155` | Shortcuts overlay inference from exact close/keymap/heading strings. | Deleted overlay recognition; no native screen text is an input guard. |
| A13 | `src/delivery-screen.ts:157` | Sub-agent viewing text interpreted as an input prohibition. | Deleted focus-text parsing; AD waiting and refusals govern the permitted target operation. |
| A14 | `src/delivery-screen.ts:25`, `:149`, `:168` | Running-turn inference from spinners, ellipses, thinking/tokens and interrupt wording. | Deleted running-screen classification; `working` never authorizes delivery or reconnect keys. |
| A15 | `src/delivery-screen.ts:124` | Draft prefix matching to identify the queued part as CSCB-owned text. | Deleted draft-prefix ownership; persisted attempt identity authorizes recovery Enter and exact receipts confirm delivery. |
| A16 | `src/delivery-screen.ts:125` | Any pasted-text marker treated as CSCB-owned input when an own-text argument existed. | Deleted pasted-marker ownership; durable unconfirmed sends receive guarded recovery Enter. |
| A17 | `src/delivery-screen.ts:100`, `:125` | Alternative space/newline joins used to equate wrapped screen text with own input. | Deleted wrapping reconstruction; exact transcript receipt matching remains independent of presentation. |
| A18 | `src/delivery-engine.ts:213`, `:223`, `:224`, `:243`, `:370` | Delivery pane reads and repeated parsed-screen checks before text/Enter. | Removed all delivery pane reads; each key uses fresh AD waiting plus existing local guards and the persona lease. |
| A19 | `src/delivery-engine.ts:226`, `:229`; `src/delivery-policy.ts:89`; `src/delivery-engine.ts:412` | Completed-item screen matching followed by Enter to clear an apparent duplicate draft. | Removed leftover-draft cleanup; recovery Enter is tied to an unconfirmed durable attempt, never a completed item screen match. |
| A20 | `src/delivery-engine.ts:232` | Enter-retry allowance reset when parsed composer text changed. | Removed screen-change counters; durable recovery attempts, backoff and receipt windows own retries. |
| A21 | `src/delivery-policy.ts:64` | First-send allowance for `working` plus parsed empty/running and a settled timer. | First sends require fresh AD waiting, connected MCP and local guards; the settle timer only schedules attempts. |
| A22 | `src/delivery-policy.ts:67` | Retype gated on screen-empty and inferred idle or a 120-second idle-proof timeout. | Removed both inferred idle and `IDLE_EVIDENCE_MAX_WAIT_MS`; missing receipts, AD waiting/local guards and existing backoff govern retypes after recovery Enter. |
| A23 | `src/delivery-policy.ts:49`, `:91`; `src/delivery-engine.ts:381`, `:414` | Enter-only retry authorized by an own-draft screen classification. | Persist `send_kind: enter` before recovery keys; fresh AD waiting/local guards permit recovery even with MCP disconnected, followed by a receipt window. |
| A24 | `src/delivery-engine.ts:210`, `:403`, `:407`; `src/delivery-constants.ts:2` | Byte-count-derived `ceil(part bytes / 1000) + 2` Enter allowance and screen-gated input heuristics. | Removed the byte-count Enter allowance; retained 1 s launch settling and 500 ms text-to-Enter pacing as local scheduling, never readiness or confirmation. Each key still revalidates AD waiting/local guards. |
| A25 | `src/delivery-policy.ts:70`; `src/session-manager.ts:4195` | Reconnect on `working` justified by CSCB transcript/pane idle evidence. | Reconnect requires fresh AD waiting; durable recovery and pending control-input intent prevent overtaking existing work. |
| A26 | `src/session-manager.ts:5694`, `:5808` | Second busy classifier matching spinner, elapsed time, arrows and thinking text. | Deleted the session-manager classifier; AD rows determine working/waiting. |
| A27 | `src/session-manager.ts:5703`, `:5810` | Bottom-12-line interrupt/cancel scan used to infer busy. | Removed the pane scan; no footer wording changes health or reconnect readiness. |
| A28 | `src/session-manager.ts:5717`, `:5811` | API retry/rate-limit/proxy/gateway/attempt-count text treated as a running turn. | Removed provider-text state inference; AD status/refusals remain authoritative. |
| A29 | `src/session-manager.ts:5731`, `:5739`, `:5758`, `:5775` | Numbered-dialog inference from borders, selection markers and hardcoded prompt wording. | Deleted dialog parsing; AD prompt rows/refusals govern recovery and remaining startup prompts await a human. |
| A30 | `src/session-manager.ts:5801` | Unknown nonblank presentation defaulted to idle through the Claude screen adapter. | Deleted the default-idle fallback and shared native screen adapter; unknown AD observations do not authorize typing. |
| A31 | `src/session-transcript.ts:51`, `:154`, `:212` | Assistant stop reasons interpreted as turn completion/idle. | Removed the turn-ended parser; transcripts only confirm exact own-message delivery. |
| A32 | `src/session-transcript.ts:104`, `:134`, `:216` | Native request-interrupted wording treated as a completed turn. | Removed interruption-text state inference; AD waiting alone supplies the row-state prerequisite. |
| A33 | `src/session-transcript.ts:118`, `:146`, `:214` | Stop-hook attachment names and Stop events treated as an open turn. | Removed hook-order state inference; Stop transcript records do not decide readiness. |
| A34 | `src/session-transcript.ts:195` | Backward native transcript-tail fold over queue/sidechain/bookkeeping records to derive open/ended/empty. | Removed the native state fold; exact own-message receipt scanning remains, without idle/busy conclusions. |
| A35 | `src/session-manager.ts:5849`; `src/session-transcript.ts:87` | Stable pane plus transcript path/device/inode/size/mtime and ended-turn evidence accumulated as sustained idle. | Removed positive-idle/stable-prompt accumulation; filesystem metadata supplies no agent-state proof. |
| A36 | `src/session-manager.ts:5936`, `:5957`, `:6026`, `:6125`, `:6167`, `:6175` | Working-row startup wait allowed recovery after 60 seconds of sampled pane/transcript idle. | Removed sampling and positive-idle override; AD working remains working and the bounded wait/reconciliation follows AD outcomes. |
| A37 | `src/session-manager.ts:6354`, `:6384`, `:6399`, `:6419`, `:6435` | Health/restart fold permitted reconnect after inferred idle or reported sustained parsed prompts. | Removed the fold and parsed-prompt durations; fresh AD rows and typed outcomes drive recovery and prompt-row handling. |
| A38 | `src/session-manager.ts:6491`, `:6547` | Waiting-row pane check overrode AD when a pane appeared busy or prompted. | Removed `checkWaitingRowPane`; fresh AD waiting and existing local guards/refusals own reconnect readiness. |
| A39 | `src/session-manager.ts:4173`, `:4183`, `:4190`, `:4194`, `:4208`, `:4221` | Final reconnect composer/menu/running check and optional working fold before text/Enter. | Removed final pane checks; reconnect persists intent before text, revalidates AD waiting for each key and resumes uncertain input with Enter alone. |
| A40 | `src/server.ts:3258`, `:3262`; `src/session-manager.ts:6573`; `src/health-check.ts:627` | Parsed menu holds and stored idle runs bypassed ordinary health/reconnect timing. | Removed inferred menu holds and idle acceleration; retained ordinary two-tick health scheduling and AD/refusal retry ownership. |
| A41 | `src/session-manager.ts:3536`, `:4456`, `:4463`, `:4920` | Startup trust detection from menu/numbered-dialog classifiers and exact folder/developer wording. | Deleted the startup detector; AD pre-trust handles supported trust setup and a human answers remaining prompts. |
| A42 | `src/pending-row.ts:1173`, `:1750`; `src/session-manager.ts:3554`, `:3595` | Pending-row pane lap chose automatic Enter from a trust-dialog predicate. | Removed the pane lap/typing branch; pending-row cover, grace/bound and normal retries remain without automatic answers. |
| A43 | `src/session-manager.ts:5399`, `:5410`, `:5416` | Autonomous approver read 40 pane lines and sent Enter to accept a selected startup option. | Deleted the autonomous approver and its automatic keys; remaining startup dialogs require a human. |
| A44 | `src/session-manager.ts:4237`, `:4245`, `:4246`, `:4253` | Startup typing callback independently reread/reparsed a pane before answering. | Removed `withStartupTyping` and its callback path; no startup pane read or automatic answer remains. |
| A45 | `src/delivery-receipt.ts:163`, `:166`, `:174` | Claude enqueue/dequeue/remove/pop reconstruction combined with turn-ended parsing as idle evidence. | Removed native queue/turn reconstruction; Claude transcript records serve only exact own-message receipts. |
| A46 | `src/delivery-receipt.ts:56`, `:57`, `:179` | Codex task-start/task-complete order or no observed start treated as idle. | Removed task-order idle evidence; retypes use AD waiting, existing guards/backoff and exact receipt absence. |
| A47 | `src/delivery-receipt.ts:60`, `:184`; `src/delivery-policy.ts:81`; `src/delivery-engine.ts:350` | Native compact/microcompact transcript records treated as lifecycle events. | Removed compaction event detection/consumption; authoritative AD launch/session observations retain lifecycle recovery. |
| A48 | `src/delivery-engine.ts:457`; `src/delivery-lifecycle.ts:74`; `src/delivery-notices.ts:27`, `:143`, `:171` | Parsed menu/input states supplied notices, screen-blocked durations and reconnect/delivery suppression. | Removed parsed-screen notices, durations and suppression; queue age, retypes and AD/refusal/lifecycle facts retain ordinary notice episodes. |
| AT01 | `tests/integration/fixtures/real-observations.ts:20`, `:25`, `:30`; `tests/integration/lib/real-scenario.sh:167`, `:175`, `:187` | Real Claude progression required parsed empty/non-running composer beside AD waiting; diagnostics classified panes. | Harness progression uses AD waiting/refusals and independent exact receipt assertions; native pane capture/classification is removed. |
| AT02 | `tests/real-agent/codex-delivery.ts:221`, `:230`, `:355`, `:365` | Codex menu/overlay trials awaited parsed popup kinds and exact visible draft text. | Removed native menu/draft compatibility trials; Codex controls exercise AD outcomes and durable recovery with exact receipts. |
| AT03 | `tests/real-agent/codex-delivery.ts:252`, `:303` | Parsed empty Codex composer authorized scenario/launch progression. | Removed composer readiness checks; AD waiting governs harness progression. |
| AT04 | `tests/real-agent/codex-delivery.ts:239` | Codex task-order `idle()` authorized the next harness action. | Removed operational task-order idle; retain independent completed-output assertions solely as test oracles. |
| AT05 | `tests/real-agent/codex-delivery.ts:464` | Crash injection waited for parsed visible text to establish its boundary. | Crash/fault boundaries use the durable send journal and AD shim outcomes; recovery is checked against exact own receipts. |
| AT06 | `tests/integration/fixtures/real-case-assertions.ts:99`, `:396` | Spinner plus Compacting regex and marker controls asserted active native compaction. | Removed compaction marker assertions/fixtures; Test 104 instead injects an uncertain AD text outcome and verifies three ordered exact receipts without capability skips. |
| AT07 | `tests/real-agent/ai-failure-diagnostics.ts:93`, `:166`; `tests/real-agent/codex-delivery.ts:635` | Failure projector parsed borders, residue, footer and prompt glyphs to retain selected pane rows. | Removed native pane content from failure evidence; safe structured transcript/error metadata remains. |
| AT08 | `tests/integration/fixtures/transcript-receipts.ts:311`, `:368`, `:374` | Delivery failure evidence invoked the production classifier to report own/input/running. | Removed screen classifications from failure projections; retain AD outcomes, queue facts and safe exact receipt evidence. |
| AT09 | `tests/test-helpers/delivery-model-replay.ts:42` | Model replay parsed native pane fixtures with the production classifier. | Replay now consumes AD observations/refusals and exact receipts; all 266 regenerated traces and 40,778 states replay successfully, as recorded below. |

## Remaining outcome-only `readPane` calls

| Call site | Purpose and payload handling |
|---|---|
| `src/cli.ts` teardown reader | CLI teardown probe; discards success payload and returns only AD outcome for checked teardown handling. |
| `src/session-manager.ts` shared own-pane probe | Prompt-row recovery and server teardown consumers; success is an outcome sentinel, never pane contents. Typed AD failure/latch/outage handling remains. |
| `src/session-manager.ts` latch probe | Own-row latch recheck; explicitly discards success payload, uses only AD success/error class. |

The owner explicitly permits these outcome/error-class probes for this scope. They establish no idle/readiness fact. No automatic `expect_pane_sha256` remains. Current direct call inventory: `src/cli.ts:1818`, `src/session-manager.ts:3255`, `src/session-manager.ts:16812` (verified with `git grep -n 'readPane(' -- src`).

## Model and helper changes

| Path | One-line reason |
|---|---|
| `spec/tla/PROVENANCE.txt` | Refresh 49 stale input hashes and add the `ci/check_cardinal.py` pin; all 107 current/frozen inputs match, while historical provenance remains explicitly historical. |
| `spec/tla/README.md` | Describe AD-owned readiness, durable Enter recovery, current local evidence and its exhaustive/sampled and certification limits. |
| `spec/tla/PersonaDelivery.tla` | Remove screen/idle/compaction-derived readiness; add durable recovery Enter intent and volatile completion identity under waiting-only guards; `727c6e64` models recovery Enter before disconnected reconnect. |
| `spec/tla/PersonaDelivery.tla:RestartStateConstraint` | Expand explicit per-part durable-send prefix from two to four so text/recovery Enter/retype/recovery Enter remain reachable; keep all invariants. |
| `spec/tla/ci/fairness-probe/PermissionFairness.tla` | Use AD waiting/live refusals and model recovery Enter while retaining the original seven fairness obligations and first-text-refusal diagnostic. |
| `spec/tla/ci/check_cardinal.py` | Freeze actual model/runner/config hashes, retain raw logs and independent proofs, and include all 76 delivery rows plus 8 auxiliary checks in a detached local run. |
| `spec/tla/ci/work_witness.py` | Audit the expanded four-send prefix while independently replaying original actions/fairness/exact receipts. |
| `spec/tla/ci/profile_restart.py` | Retain recoveryAttempt, durable attempt IDs and recovery-enter readings in the projection/dataflow audit. |
| `spec/tla/ci/runner.py` | Declare current AD typing invariant/mutants and four-send reduction metadata. |
| `spec/tla/ci/trace_contract.py` | Validate recovery action divergence and four-send companion counterexamples. |
| `spec/tla/ci/temporal_sensitivity.py` | Keep independent temporal proof guides within current screen-free model and four-send scope; `727c6e64` adapts recovery scheduling, and `a30bf265` targets the causal observation-replacement search while preserving original-action replay, fairness and the exact-environment contrast. |
| `spec/tla/ci/suite.tsv` | Retain all 76 checks/modes/seeds and describe AD guard targets and expanded recovery prefix. |
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

The tracked [actual-file inventory](../tests/test-helpers/cardinal-trace-changes.json) contains **302 paths**, each with its change kind and one-line reason: 266 rewritten, 35 deleted and one added. The rewritten paths are 265 canonical trace files plus `coverage.json`; the added path is `supplemental_pullback-001.json`. All 302 paths match the actual fixture diff from audited revision `a01d092d`; this inventory is separate from the 76 manifest rows.

Canonical traces were regenerated from the waiting-only AD model with independent proof bundles. Deleted samples have no corresponding trace in the actual current TLC output. `coverage.json` binds model/input hashes, raw logs, per-row proof/auxiliary evidence, the supplemental witness and executed coverage. Screen-marker-only observations supply no readiness evidence; non-screen no-loss/FIFO/durable-work controls and the expected duplicate witness remain.

## Verification results

### Canonical local evidence and scope

The retained canonical local run is [cardinal-final-causal-proof-20261020T054736Z/report.json](../spec/tla/ci/.runs/cardinal-final-causal-proof-20261020T054736Z/report.json). All **76 delivery rows plus eight auxiliary rows (84 total)** match their expected results, with zero unexpected checker errors, timeouts or proof errors. Expected counterexamples are successful negative controls, not product failures. The report records `partial: false`, `inputsUnchanged: true` and **`certification: false`**; this is local TLC/replay evidence and establishes no scheduler certificate.

All **107 inputs** match current files, frozen source bytes, report hashes and provenance pins. The earlier pin refresh replaced 49 stale hashes and added the missing `ci/check_cardinal.py` pin. The model SHA-256 is `a4a3d8784998a853337c64f3c98016a2ccac71669d13d908f07887c35290266d`; the temporal-helper SHA-256 is `ddfe487624d5465b8daab0b0e605bfa33271fda75b19e672e1461be099c904d5`. All 84 retained compressed raw logs also match their recorded hashes. Pruned diagnostic directories are not current evidence.

The delivery manifest has eight passing exhaustive checks, 40 expected counterexamples and 28 sampled simulations. The eight exhaustive positives are `core_head_taken_in`, five `restart_order*` checks, `safety_plain` and `safety_agent_input`; their guarantees apply only within each checked config's bounds, constraints and reductions. `core_head_taken_in` verifies `HeadTakenIn` in its small constrained, unprojected scope under the original seven fairness rules and explicit environment assumptions. Restart safety uses `RestartSafetyView`/`RestartStateConstraint`, including the four-send durable prefix; that prefix is a model bound, never a production retry cap.

The 28 delivery simulations retain eight samples each, depth 256 and their exact seeds. The `live_*` simulations leave temporal properties **UNVERIFIED**; sampled safety does not prove liveness. Auxiliary evidence adds one passing bounded exhaustive permission-safety check, six expected safety/temporal/reachability counterexamples, and two depth-five proof-parser simulation samples. Independent original-action replay, accepted-work and temporal contrast bundles are retained where required. The row tables below preserve each config's actual mode, selected target, exit and expected outcome.

### Delivery row results

| Config | Actual scope / sample | Selected checks or expected target | Matched result / exit |
|---|---|---|---|
| `core_head_taken_in` | bounded exhaustive | `TypeOK`, `DurableAccept`, `NoDrop`, `ReceiptBacked`, `InOrder`, `TranscriptFIFO`, `OneInFlight`, `TypingGuards`, `NoRetypeWhileWorking`, `GateExclusive`, `NoDuplicateKey`, `HeadTakenIn` | expected pass; 0 |
| `restart_control_next_item` | finite counterexample | `OneInFlight` | expected violation; 12 |
| `restart_control_next_part` | finite counterexample | `OneInFlight` | expected violation; 12 |
| `restart_control_send_is_delivery` | finite counterexample | `ReceiptBacked` | expected violation; 12 |
| `restart_control_queue_is_receipt` | finite counterexample | `TranscriptFIFO` | expected violation; 12 |
| `restart_control_start_drop` | finite counterexample | `NoDrop` | expected violation; 12 |
| `restart_control_compact_open` | finite counterexample | `NoDrop` | expected violation; 12 |
| `restart_control_early_ack` | finite counterexample | `DurableAccept` | expected violation; 12 |
| `restart_control_skip_refused` | finite counterexample | `InOrder` | expected violation; 12 |
| `restart_control_start_unsent_head` | finite counterexample | `InOrder` | expected violation; 12 |
| `restart_control_retype_into_text` | finite counterexample | `TypingGuards` | expected violation; 12 |
| `restart_control_retype_working` | finite counterexample | `NoRetypeWhileWorking` | expected violation; 12 |
| `restart_control_reconnect_keys` | finite counterexample | `GateExclusive` | expected violation; 12 |
| `restart_control_reconnect_running` | finite counterexample | `TypingGuards` | expected violation; 12 |
| `restart_control_duplicate_key` | finite counterexample | `NoDuplicateKey` | expected violation; 12 |
| `restart_order` | bounded exhaustive | `TypeOK`, `DurableAccept`, `NoDrop`, `ReceiptBacked`, `InOrder`, `TranscriptFIFO`, `OneInFlight`, `TypingGuards`, `NoRetypeWhileWorking`, `GateExclusive`, `NoDuplicateKey` | expected pass; 0 |
| `restart_order_across` | bounded exhaustive | `TypeOK`, `DurableAccept`, `NoDrop`, `ReceiptBacked`, `InOrder`, `TranscriptFIFO`, `OneInFlight`, `TypingGuards`, `NoRetypeWhileWorking`, `GateExclusive`, `NoDuplicateKey` | expected pass; 0 |
| `restart_order_bot` | bounded exhaustive | `TypeOK`, `DurableAccept`, `NoDrop`, `ReceiptBacked`, `InOrder`, `TranscriptFIFO`, `OneInFlight`, `TypingGuards`, `NoRetypeWhileWorking`, `GateExclusive`, `NoDuplicateKey` | expected pass; 0 |
| `restart_order_enter` | bounded exhaustive | `TypeOK`, `DurableAccept`, `NoDrop`, `ReceiptBacked`, `InOrder`, `TranscriptFIFO`, `OneInFlight`, `TypingGuards`, `NoRetypeWhileWorking`, `GateExclusive`, `NoDuplicateKey` | expected pass; 0 |
| `restart_order_busy` | bounded exhaustive | `TypeOK`, `DurableAccept`, `NoDrop`, `ReceiptBacked`, `InOrder`, `TranscriptFIFO`, `OneInFlight`, `TypingGuards`, `NoRetypeWhileWorking`, `GateExclusive`, `NoDuplicateKey` | expected pass; 0 |
| `restart_order_simulation` | sampled: 8 × depth 256, seed 111792 | sampled safety; no temporal claim | expected pass; 0 |
| `safety_plain` | bounded exhaustive | `TypeOK`, `DurableAccept`, `NoDrop`, `ReceiptBacked`, `InOrder`, `TranscriptFIFO`, `OneInFlight`, `TypingGuards`, `NoRetypeWhileWorking`, `GateExclusive`, `NoDuplicateKey` | expected pass; 0 |
| `safety_calls` | sampled: 8 × depth 256, seed 112801 | sampled safety; no temporal claim | expected pass; 0 |
| `safety_enter_unknown` | sampled: 8 × depth 256, seed 113810 | sampled safety; no temporal claim | expected pass; 0 |
| `safety_agent_input` | bounded exhaustive | `TypeOK`, `DurableAccept`, `NoDrop`, `ReceiptBacked`, `InOrder`, `TranscriptFIFO`, `OneInFlight`, `TypingGuards`, `NoRetypeWhileWorking`, `GateExclusive`, `NoDuplicateKey` | expected pass; 0 |
| `safety_bot_resume` | sampled: 8 × depth 256, seed 114819 | sampled safety; no temporal claim | expected pass; 0 |
| `safety_bot_sessions` | sampled: 8 × depth 256, seed 115828 | sampled safety; no temporal claim | expected pass; 0 |
| `safety_storage` | sampled: 8 × depth 256, seed 116837 | sampled safety; no temporal claim | expected pass; 0 |
| `safety_screen` | sampled: 8 × depth 256, seed 117846 | sampled safety; no temporal claim | expected pass; 0 |
| `safety_connection` | sampled: 8 × depth 256, seed 118855 | sampled safety; no temporal claim | expected pass; 0 |
| `safety_persona` | sampled: 8 × depth 256, seed 119864 | sampled safety; no temporal claim | expected pass; 0 |
| `safety_identical` | sampled: 8 × depth 256, seed 120873 | sampled safety; no temporal claim | expected pass; 0 |
| `live_plain` | sampled: 8 × depth 256, seed 121882 | sampled safety; `EventuallyDelivered` UNVERIFIED, `HeadTakenIn` UNVERIFIED, `ReconnectNotBlocked` UNVERIFIED, `GateFreeInfinitelyOften` UNVERIFIED | expected pass; 0 |
| `live_calls` | sampled: 8 × depth 256, seed 122891 | sampled safety; `EventuallyDelivered` UNVERIFIED, `HeadTakenIn` UNVERIFIED, `ReconnectNotBlocked` UNVERIFIED, `GateFreeInfinitelyOften` UNVERIFIED | expected pass; 0 |
| `live_enter_unknown` | sampled: 8 × depth 256, seed 123900 | sampled safety; `EventuallyDelivered` UNVERIFIED, `HeadTakenIn` UNVERIFIED, `ReconnectNotBlocked` UNVERIFIED, `GateFreeInfinitelyOften` UNVERIFIED | expected pass; 0 |
| `live_agent_input` | sampled: 8 × depth 256, seed 124909 | sampled safety; `EventuallyDelivered` UNVERIFIED, `HeadTakenIn` UNVERIFIED, `ReconnectNotBlocked` UNVERIFIED, `GateFreeInfinitelyOften` UNVERIFIED | expected pass; 0 |
| `live_bot_resume` | sampled: 8 × depth 256, seed 125918 | sampled safety; `EventuallyDelivered` UNVERIFIED, `HeadTakenIn` UNVERIFIED, `ReconnectNotBlocked` UNVERIFIED, `GateFreeInfinitelyOften` UNVERIFIED | expected pass; 0 |
| `live_bot_sessions` | sampled: 8 × depth 256, seed 126927 | sampled safety; `EventuallyDelivered` UNVERIFIED, `HeadTakenIn` UNVERIFIED, `ReconnectNotBlocked` UNVERIFIED, `GateFreeInfinitelyOften` UNVERIFIED | expected pass; 0 |
| `live_storage` | sampled: 8 × depth 256, seed 127936 | sampled safety; `EventuallyDelivered` UNVERIFIED, `HeadTakenIn` UNVERIFIED, `ReconnectNotBlocked` UNVERIFIED, `GateFreeInfinitelyOften` UNVERIFIED | expected pass; 0 |
| `live_screen` | sampled: 8 × depth 256, seed 128945 | sampled safety; `EventuallyDelivered` UNVERIFIED, `HeadTakenIn` UNVERIFIED, `ReconnectNotBlocked` UNVERIFIED, `GateFreeInfinitelyOften` UNVERIFIED | expected pass; 0 |
| `live_connection` | sampled: 8 × depth 256, seed 129954 | sampled safety; `EventuallyDelivered` UNVERIFIED, `HeadTakenIn` UNVERIFIED, `ReconnectNotBlocked` UNVERIFIED, `GateFreeInfinitelyOften` UNVERIFIED | expected pass; 0 |
| `live_persona` | sampled: 8 × depth 256, seed 130963 | sampled safety; `EventuallyDelivered` UNVERIFIED, `HeadTakenIn` UNVERIFIED, `ReconnectNotBlocked` UNVERIFIED, `GateFreeInfinitelyOften` UNVERIFIED | expected pass; 0 |
| `live_empty_reconnect` | sampled: 8 × depth 256, seed 131972 | sampled safety; `EventuallyDelivered` UNVERIFIED, `HeadTakenIn` UNVERIFIED, `ReconnectNotBlocked` UNVERIFIED, `GateFreeInfinitelyOften` UNVERIFIED | expected pass; 0 |
| `control_next_item` | finite counterexample | `OneInFlight` | expected violation; 12 |
| `control_next_part` | finite counterexample | `OneInFlight` | expected violation; 12 |
| `control_send_is_delivery` | finite counterexample | `ReceiptBacked` | expected violation; 12 |
| `control_queue_is_receipt` | finite counterexample | `TranscriptFIFO` | expected violation; 12 |
| `control_start_drop` | finite counterexample | `NoDrop` | expected violation; 12 |
| `control_compact_open` | finite counterexample | `NoDrop` | expected violation; 12 |
| `control_early_ack` | finite counterexample | `DurableAccept` | expected violation; 12 |
| `control_skip_refused` | finite counterexample | `InOrder` | expected violation; 12 |
| `control_start_unsent_head` | finite counterexample | `InOrder` | expected violation; 12 |
| `control_retype_into_text` | finite counterexample | `TypingGuards` | expected violation; 12 |
| `control_retype_working` | finite counterexample | `NoRetypeWhileWorking` | expected violation; 12 |
| `control_reconnect_keys` | finite counterexample | `GateExclusive` | expected violation; 12 |
| `control_keep_gate` | temporal counterexample | `GateFreeInfinitelyOften` | expected violation; 13 |
| `control_hold_gate_mcp_reconnect` | temporal counterexample | `ReconnectNotBlocked` | expected violation; 13 |
| `control_hold_gate_mcp_delivery` | temporal counterexample | `EventuallyDelivered` | expected violation; 13 |
| `control_no_deferred` | temporal counterexample | `ReconnectNotBlocked` | expected violation; 13 |
| `control_reconnect_running` | finite counterexample | `TypingGuards` | expected violation; 12 |
| `control_deferred_only_open` | temporal counterexample | `ReconnectNotBlocked` | expected violation; 13 |
| `control_park_retype` | temporal counterexample | `EventuallyDelivered` | expected violation; 13 |
| `control_unreadable_park` | temporal counterexample | `HeadTakenIn` | expected violation; 13 |
| `control_weak_observe` | temporal counterexample | `EventuallyDelivered` | expected violation; 13 |
| `control_replace_observation` | temporal counterexample | `EventuallyDelivered` | expected violation; 13 |
| `control_duplicate_key` | finite counterexample | `NoDuplicateKey` | expected violation; 12 |
| `control_no_head_takein_assumption` | temporal counterexample | `HeadTakenIn` | expected violation; 13 |
| `witness_duplicates` | finite counterexample | `AtMostOnce` | expected violation; 12 |
| `probe_premise` | temporal counterexample | `NotPremise` | expected violation; 13 |
| `trace_calls` | sampled: 8 × depth 256, seed 104729 | sampled safety; no temporal claim | expected pass; 0 |
| `trace_agent` | sampled: 8 × depth 256, seed 105738 | sampled safety; no temporal claim | expected pass; 0 |
| `trace_lifecycle` | sampled: 8 × depth 256, seed 106747 | sampled safety; no temporal claim | expected pass; 0 |
| `trace_storage` | sampled: 8 × depth 256, seed 107756 | sampled safety; no temporal claim | expected pass; 0 |
| `trace_screen` | sampled: 8 × depth 256, seed 108765 | sampled safety; no temporal claim | expected pass; 0 |
| `trace_flapping` | sampled: 8 × depth 256, seed 109774 | sampled safety; no temporal claim | expected pass; 0 |
| `trace_identical` | sampled: 8 × depth 256, seed 110783 | sampled safety; no temporal claim | expected pass; 0 |

### Auxiliary row results

| Config | Actual scope / sample | Selected checks or expected target | Matched result / exit |
|---|---|---|---|
| `proof_simulation` | sampled: 2 × depth 5, seed 104729 | proof trace parser; `EmitSimulationTrace`; no temporal claim | expected pass; 0 |
| `proof_safety` | finite counterexample | `SafetyProbe` | expected violation; 12 |
| `proof_temporal` | temporal counterexample | `TemporalProbe` | expected violation; 13 |
| `permission_safety` | bounded exhaustive | `TypeOK`, `SafetySanity` | expected pass; 0 |
| `permission_delivery_reachable` | finite counterexample | `NotDelivered` | expected violation; 12 |
| `permission_premise_reachable` | temporal counterexample | `NotPremise` | expected violation; 13 |
| `permission_eventually_delivered` | temporal counterexample | `EventuallyDelivered` | expected violation; 13 |
| `permission_head_taken_in` | temporal counterexample | `HeadTakenIn` | expected violation; 13 |

### Supplemental witness and runtime conformance

The separately retained [pullback evidence](../spec/tla/ci/.runs/cardinal-final-causal-proof-20261020T054736Z/supplemental/pullback/evidence.json) proves an existential finite prefix of **21 states and 20 original-action edges**, including a genuine `PullBack` fault absent from the fixed-seed manifest samples. Its search and exact replay use the same frozen model, input config and unchanged safety invariants; exact replay exits 0. It is outside the canonical 84 rows and makes **no liveness claim**.

The [coverage inventory](../tests/fixtures/delivery-traces/coverage.json) binds **266 traces and 40,778 states**: 265 canonical traces/40,757 states plus the supplemental 21-state trace. Replay covers 38 executed controls, all 18 engine actions, 26 faults and four flapping actions. Legacy fault/config identifiers such as `botCompact` and `*_screen` are retained inventory names; they do not authorize native compaction or terminal-derived state.

The isolated targeted run of `tests/delivery-model-conformance.test.ts` and `tests/delivery-model-verdict.test.ts` passed **29 tests, zero failures, 54 assertions in 80.42 s**, including 23 scheduler-boundary cases. Conformance replays every frozen state through production AD/receipt decisions, checks independent/saved observations and expired timers, exercises recovery with disconnected MCP, and detects an isolated FIFO policy mutation. The boundary cases use injected evidence and do not run a scheduler. Both files also pass in the retained final full-unit log.

An independent final validator review checked all 107 input hashes, 266 fixtures, 84 raw logs and the actual 302-file inventory, including refusal of tampered evidence; it returned no findings. This checks evidence integrity and runtime conformance within the recorded scopes, without extending the model to adapter behavior.

### Source/test reviews and full units before the CI repair

Apiary 3.0.6 was installed after work began. The owner requested fresh whole-branch `$code-review` and `$test-review` with the engineering guide's cardinal rules taking precedence over every spec. Blocking findings were fixed and follow-up reviews returned no findings: receipt-window guard `7e80d089`, integration/test repairs `5ad238f7` and `c282c98f`, model/trace evidence `ea90dab5`, and final assertion correction `0d680462`. The sole ignored documentation review item is the unrelated pre-existing `docs/bots.md` error-conditions table relocation, outside this bug's scope.

Test work retains all four conflict-latch matrices, Claude/Codex prior-session receipt-window and cached-unreadable-file controls, and structured AD/hook/journal integration evidence. `real-key-recovery-proof.test.ts` checks durable recovery and persona-scoped shim/backoff controls; scenario commands additionally require the shared exact-receipt audit. The adapter receipt-window guard is **not directly TLC-verified**: `ModelReconnectStep` abstracts it, and the four production engine regressions described above cover lease release, durable receipt completion, recovery-intent append/backoff and working-to-waiting extension.

The final isolated full unit run passed **30,928 tests, skipped 21 and failed zero**, with 194,924 assertions: 30,949 tests across 181 files in **182.02 s**. Its retained local log is `/tmp/acu-full-units-final306-green.log`. The first full attempt passed 30,927 tests with one stale reconnect expectation; `0d680462` corrects it to assert the exact Enter-only retry after an uncertain reconnect text outcome. That file then passed 577 tests, and the complete final rerun produced the green result above. Final `bun run typecheck` (`tsc --noEmit`) and `git diff --check` also passed, as recorded by the calling agent.

### External CI at `712013d9`: FAIL

The external runner tested `712013d984cfa601517f5cb4491e53374b508bb7`. Across the full run and two selective diagnostics, **41 scripts were attempted: 30 passed and 11 failed**. The full gate remains **FAIL**. The selective runs complete coverage and are not independent gate passes. The owner's `/tmp/acu_ci_fix.md` records these results; retained runner artifacts are under `/run/openclaw/horde/cscb-ci-<run id>`.

| Run ID | Scope | Result |
|---|---|---|
| `20261020t065929z-5eb1zv8p` | Full CI | FAIL: tests 0, 17, 18, 19, 26 and 41 failed; 20 scripts were initially unexecuted. |
| `20261020t073737z-a6vejbcb` | Selective diagnostic | FAIL: tests 15, 22 and 35 failed; five newly selected scripts passed, 12 remained unexecuted. |
| `20261020t080358z-vyxrh33a` | Selective diagnostic | FAIL: source recovery in tests 32 and 33 failed; ten newly selected scripts passed, completing coverage. |

The runner classified tests 32/33 as source recovery stalls: after a worker kill, recovery Enter returned AD `GONE`, but restart delay zero or a stale `waiting` row prevented recovery and left durable work blocked for 180 seconds. The other nine failures were test/fixture mismatches. Its initial test-26 diagnosis was provisional, and test 41's sanitized refusal was class `other`; the exact native refusal reason remains unknown.

### First CI repair, completed at `3a6f2300`

The delivery engine now preserves a key's actual AD `GONE` evidence for its launch, bars further keys, releases the lifecycle lease and hands recovery to `recoverDeliveryGone` in `session-manager.ts`. That adapter starts the existing checked AD live-row recovery sequence detached from the engine tick; it does not await a sequence that can join launch/reconnect or teardown. Recovery therefore continues with restart delay zero and a stale `waiting` row, while existing applied/up, latch, hold, outage, cap and launch-identity guards remain.

The engine retains a delayed handoff; normal retry ownership may retry a refused sequence. A source-review P1 found that a hold could outlive the original AD session and let retained `GONE` evidence target its replacement. The rework forces a fresh AD `get` before delayed/retried handoff, discards evidence on lifecycle-launch, session or launch-timestamp change, retains work on refused reads and rechecks local guards after the await. Reconnect retries use the same serialized engine tick. An active sequence holds delivery and suppresses deferred reconnect re-arming until it can complete.

A subsequent source-review P2 found that fresh `ErrSpawnNotFound` could leave retained `GONE` blocking the durable queue. The engine now calls the server’s `recoverAbsent` adapter, which transfers recovery through the existing retry controller’s `runNow` even with restart delay zero; only `RAN` or `ARMED` clears retained evidence. `RUNNING` or `CLOSED` retains ownership because an overlapping retry can stop on an older row. The controller re-reads AD before acting and preserves guards and refusal backoff, so a replacement appearing after transfer receives no stale kill or launch.

This repairs adapter ownership without changing the pure delivery policy, lifecycle module or model. No fresh TLC result or adapter-level TLC coverage is claimed. All prior model inputs, evidence, trace inventory and 57 audit dispositions remain intact.

| Failed test | Repair and behavior rationale |
|---|---|
| 0 — harness self-check | Initialize/iterate the supported `at-once` reporting fixture so every `REFIRE_PID` lookup exists under `nounset`; retired UI modes cannot leave phantom re-fire entries. |
| 15 — prefix neighbour | Expect the `at-once` neighbour's own SessionStart and `waiting` row, then require unchanged hook and session identity to prove CSCB left it untouched. |
| 17 — launch pending | Permit scheduled/deferred recovery diagnostics while pending; structured call/post checks still prohibit launch, pane reads and keys during the hold. |
| 18 — wedged | Align both audit streams from the originating uncertain text through the first successful Enter, including intervening refusals after the unwedge mark, with matching AD waiting/outcome records and unchanged identity; retained input must not be retyped after an uncertain outcome. |
| 19 — reuse | Give the fixture an explicit bounded two-second report delay so the authoritative sampler can observe the pending hold. |
| 22 — wrong server | Require zero automatic startup key calls; the reporting fixture starts itself, and remaining startup dialogs await a human. |
| 26 — timing settings | Release the persistent lost-create fault only after the first exact timeout/pending-get proof, allowing a healthy next launch; AD transition records and checked recovery govern progress rather than sampler timing. |
| 35 — real restarts | Require AD to report a new native session before replacement assertions, so the old live row and historical MCP log cannot satisfy the wait. |
| 41 — real Codex | Stop all observation owners and verify AD retirement before spawning the gate in the shared workdir; the original native refusal's exact reason remains unknown. |

The retained baseline experiment ran the new production recovery regression against `712013d9`'s three source files with an additive export solely for import compatibility: **one pass, five failures** (`/tmp/acu-gone-ci-baseline.log`). With the fixed source, the same six cases passed (`/tmp/acu-gone-ci-fixed.log`). The three focused source suites passed **2,663 tests, zero failures** (`/tmp/acu-gone-three-suites.log`). The Test Writer handoff additionally reports **1,411 passing stub tests**, a subsequent **764-test** final stub run, and real/control checks of **206 and 357 passing tests**. These local checks do not establish a native integration gate result.

The test-review P2 concerned test 18 selecting calls and outcomes at different unwedge boundaries. Its rework uses the same first successful Enter for both streams; seven controls exercise the actual selector, including post-mark refusals and rejected launch/caller/guard changes. The source P1 rework adds 11 regressions covering fresh reads, unannounced session/timestamp replacements, absent/refused reads, guards changed during reads, serialized reconnect retries and eventual recovery. Exhausted-kill coverage uses `KILL_RETRY_TRIES`. That rework's focused Test Writer run passed **885 tests across two files, zero failures**.

The absent-row P2 rework adds seven cases using the real retry controller: permanent `get`/`status` absence with delay zero through tick and reconnect, exact-receipt FIFO drain, replacement before the controller acts, rejected transfer, changed up/launch guards and AD status refusal/backoff. Its initial run passed **127 delivery-engine tests** and typecheck. Nine subsequent ownership regressions exercise the actual extracted server callback, all four `runNow` outcomes, stale-launch rejection, real pending-only retry overlap through tick/reconnect and exact-receipt FIFO drain. The old callback fails three negative-control cases; the final focused run passed **1,069 tests**.

Closing source and test reviews returned no findings, including the complete three-file source repair, the final nine ownership regressions and the startup-wiring assertion correction. The documentation review covered the entire changed repair diff and surrounding contracts and returned no findings; it did not review the complete unchanged architecture and testing guides. No substantive current review finding was ignored; the unrelated historical documentation item above remains recorded.

The final isolated full unit rerun passed **31,014 tests, skipped 21 and failed zero** across **181 files in 180.81 s**. Retained evidence: `/tmp/acu-ci-repair-full-units-green.log` and JUnit `/tmp/acu-ci-repair-full-units-green.xml`. The preceding full attempt passed 31,013 tests, skipped 21 and failed one in 182.10 s: a stale global guard-count assertion in `tests/server-startup-wiring.test.ts`. The correction checks all four guard calls while retaining the restart gate; its focused run passed **282 tests**, fresh review found no findings, and the complete rerun produced the green result above.

The **29 conformance/verdict tests** passed. Final typecheck (`/tmp/acu-ci-repair-green-typecheck.log`) and whitespace checks passed. The earlier 30,928-pass full-unit result belongs to the pre-repair branch; no new TLC run or proof claim is made. Per `/tmp/ci_note.md` and `/tmp/acu_ci_fix.md`, the separate credentialed runner owns the repair's CI rerun. **No post-repair CI pass is claimed.** No merge or push is performed.

### Branch commits

These are the historical source/test commits after audited revision `a01d092d` through `0d680462`, grouped by bug and shared milestones. Documentation handoff commit `712013d9` followed them and was the external CI target above. The completed repair commits are listed separately below; no future documentation commit hash is asserted here.

| Group | Commit | Change |
|---|---|---|
| b.acu | `bc3d70d9` | WIP b.acu: remove pane-based typing and startup answers |
| b.acu | `5ef71567` | b.acu: retain own-launch bookkeeping from AD row reads |
| b.acu | `1377d6b0` | WIP b.acu: replace native screen fixtures with AD contract tests |
| b.acu | `f99c6d38` | b.acu: preserve non-screen recovery and lifecycle coverage |
| b.acu | `399148e8` | b.acu: document every audit removal and AD-owned readiness |
| b.acu | `a30bf265` | b.acu: target the observation replacement temporal control |
| b.acu | `c282c98f` | b.acu: replace remaining agent-pane tests and restore latch matrices |
| b.acu | `ea90dab5` | b.acu: regenerate AD-state conformance traces with verified evidence |
| b.aqj | `5f2f62d4` | WIP b.aqj: gate typing on AD waiting and retain receipt-only confirmation |
| b.aqj | `e54e638e` | b.aqj: recover unconfirmed sends through recorded Enter attempts |
| b.aqj | `e37ee853` | b.aqj: reconcile pending input before reconnecting |
| b.aqj | `10486a91` | b.aqj: prevent reconnect recovery from awaiting itself |
| b.aqj | `727c6e64` | b.aqj: model recovery Enter before disconnected reconnect |
| b.aqj | `7e80d089` | b.aqj: preserve recovery receipt windows after lease release |
| b.aqj | `5ad238f7` | b.aqj: verify durable Enter recovery without requiring a retype |
| b.aqj | `0d680462` | b.aqj: assert Enter-only retry after uncertain reconnect text |
| shared | `fcb93897` | WIP b.acu b.aqj: model AD-only readiness and durable Enter recovery |
| shared | `eee87067` | WIP b.acu b.aqj: document AD-owned delivery and remove obsolete screen rules |

| CI repair group | Commit | Change |
|---|---|---|
| b.aqj | `a8d802a8` | Recover GONE delivery attempts through checked AD recovery; preserve absent-row ownership and audit uncertain reconnect input. |
| b.acu | `be4e9dbf` | Align CI fixtures with AD-owned launch and retirement state. |

### Documentation verification before the CI repair

The pre-repair targeted documentation run, `bun test tests/shipped-docs.test.ts`, used an isolated scratch launch HOME/state and the host-safety preload. It passed **2,456 tests, zero failures and 3,549 assertions in 10.01 s**; retained local log: `/tmp/acu-docs-final-evidence-shipped.log`. Its documentation diff passed `git diff --check`. All 57 audit rows and their original references remain, every changed tracked `spec/tla` path has a one-line reason, and all 302 actual trace/coverage changes are linked. Current repair validation and external CI status are recorded above.

The earlier stale-reference audit across README, CONTRIBUTING, `docs/*.md`, `tests/README.md` and tracked skills found no removed readiness/approver symbols or screen-based contract; explicit removal rationale in this report and excluded CI-live collection contracts remain. Outcome-only prompt-row/latch/teardown probes and human diagnostic commands are retained. Review of the customer-facing pages found no additional operator changes needed after the existing AD-owned guidance and release notes.

### First repair documentation verification

The documentation-only diff passes `git diff --check`. A structural comparison against `712013d9` confirms all 57 audit rows and the prior model/helper/config/trace inventory and canonical evidence sections are unchanged, with all three failed CI run IDs and nine repair rationales present. Architecture and testing guidance now describe the GONE/absent-row handoffs, retry ownership and authoritative fixture boundaries; customer-facing guidance needs no additional operator action for this repair.

After final evidence completion, the scoped `bun test tests/shipped-docs.test.ts` run passed **2,456 tests, zero failures and 3,549 assertions in 9.71 s**, using a scratch launch HOME/state, stripped token/persona/Claude config environment and the host-safety preload (`/tmp/acu-docs-ci-final-shipped.log`). At that first repair handoff, local validation was complete and the external rerun was pending; its result is recorded below.

### External CI at `3a6f2300`: FAIL

The second external round tested `3a6f2300d11f095844e8a15536e5cf84344529a8`. Cumulative coverage was **41 scripts attempted, 36 passed and five failed**: tests 17, 18, 26, 32 and 33. The full gate remains **FAIL**; selective diagnostics complete coverage without establishing a gate pass. The owner's `/tmp/acu_ci_fix2.md` records the results, with artifacts under `/run/openclaw/horde/cscb-ci-<run id>`.

| Run ID | Scope | Result |
|---|---|---|
| `20261020t094021z-x3gvvuzk` | Full CI | FAIL: 28 passed, tests 17/18/26 failed, ten not run. |
| `20261020t102148z-qz52lbba` | Isolated test-17 confirmation | FAIL: the same pending-row reporting timeout recurred; original/confirmation elapsed times were 222.339/221.791 s. |
| `20261020t102642z-68mhcxa6` | Selective keep-going | FAIL: eight passed, tests 32/33 failed, zero selected scripts not run; cumulative coverage reached 36 pass/five fail. |

The runner initially classified 17/32/33 provisionally. Test 32 delivered 13 of 20 fault-burst items by 174 s, leaving seven open at the unchanged 180-second bound; item spacing was 12–14 s. Test 33 confirmed all four deliveries but rejected a 60,616 ms text gap against its less-than-60-second assertion. The local investigations below establish the causes without claiming a new integration run.

### Second CI repair: causes and local evidence

The repair is committed separately as `e0af28a4` (b.aqj: receipt-wait cleanup and retry-stage assertions) and `d866076a` (b.acu: launch-response faults, fixture helper and AD audit evidence). The source/test HEAD is `d866076a6142df71bc933fc296ac88f6bc7c093a`; this documentation update records no later commit.

| Failed test | One-line root cause and repair |
|---|---|
| 32 — real FIFO order | `receiptWorking` survived a durable `delivered` append, so the next FIFO head inherited an extra 10-second receipt wait; clear the flag/deadline only after append success and clear the old flag on launch change. |
| 33 — real keys | The text-gap oracle omitted two guarded retry stages: 30 s + 500 ms text/Enter delay + 30 s is 60,500 ms deterministically; assert each durable recovery stage and its AD/launch/fault identity instead. |
| 17 — launch pending | The slow-create timeout left AD without pane identity, so SessionStart/re-fire hooks were ignored and G=60 expired before find-missing adoption; replace that fixture with successful-launch response loss after AD saves identity. |
| 18 — wedged | The scenario called undefined local helper `tmux_session_value`; use supported scenario tmux metadata helpers and validate session/pane/process identity with executable controls. |
| 26 — timing settings | The audit read only `ad.spawn.state_transition`, omitting missing-state evidence from `ad.find_missing.tick`; merge both by exact instance/time and retain latest-terminal-state and read-before-launch guards. |

The five added source lines change only adapter receipt bookkeeping in `src/delivery-engine.ts`. Four production regressions cover 20 FIFO items, 20 multipart parts, failed delivered-append durability and launch replacement; all four fail against baseline `3a6f2300` (`/tmp/acu-ci2-baseline-tests.log`). A deterministic 20-item reproduction gives 13-second baseline spacing and six open at 180 s, versus 3-second fixed spacing with all 20 delivered by 60.5 s. Test 32's bound is unchanged. The reproduction and native CI have different receipt/AD timing, hence different remaining-item counts.

Test 33 now requires the durable Enter/retype/Enter/retype sequence for the same part/session/launch, AD first-waiting evidence, actual persona key calls and the swallowed text fault's matching process ID. Stage assertions require the reset 10-second wait and both 30-second waits, plus the guarded Enter delay; this verifies reset behavior rather than merely widening a wall-clock bound. No production backoff value changes.

An isolated actual agent-director 0.12 experiment reproduced test 17's missing-identity/hook-ignore/adoption sequence, establishing a fixture contract failure without a CSCB source defect. The replacement shim targets one persona and launch verb, calls real AD first, consumes its rule only after success and returns the authentic launch-timeout `ErrTmuxUnresponsive` envelope; collisions and launch errors pass through without consuming the rule. The 23-second report delay, G=60, retry schedule and combined polling deadline are unchanged.

The final test-17 review caught a send-keys uncertainty envelope that classified as UNAVAILABLE but did not close the production launch-timeout window. The dedicated launch envelope fixes that finding. Executable shim controls now decode the reply through the real client and production classifier, require timeout-window ownership for plain spawn, reuse spawn and resume, and reject the old envelope as a negative control; `unknown-typed` is unchanged. The closing review returned no findings.

The focused pacing run passed **767 tests** (`/tmp/acu-ci2-pacing-focused.log`); known fixture/assertion repairs passed **796 tests** (`/tmp/acu-known-tests.log`). Pending-fixture focused checks passed **1,399 tests** (`/tmp/acu-ci2-pending-fixture-focused.log`), followed by **18 scoped controls** (`/tmp/acu-ci2-pending-fixture-final.log`). After the launch-envelope correction, the final focused run passed **2,342 tests, zero failures and 5,699 assertions in 11.40 s** (`/tmp/acu-ci2-launch-envelope-focused.log`). Typecheck and shell syntax checks passed. These local checks establish no native CI verdict.

All closing source and test reviews returned no findings, including the final test-17 follow-up. The three-file documentation diff and relevant context review also returned no findings; it did not reread the large unchanged portions of the architecture and testing guides.

The final full isolated unit run passed **31,092 tests, 21 skipped, zero failures and 196,306 assertions across 181 files in 182.25 s**, including all **29 model conformance/verdict tests**. Evidence is in `/tmp/acu-ci2-full-units.log` and `/tmp/acu-ci2-full-units.xml`; typecheck passed (`/tmp/acu-ci2-typecheck.log`) and whitespace checks passed. The **31,014-pass** result above belongs to the first repair at `3a6f2300`.

The earlier scoped documentation audit passed **2,456 tests, zero failures and 3,549 assertions in 9.83 s** (`/tmp/acu-ci2-docs-shipped.log`), with a scratch launch HOME/state, stripped token/persona/Claude config environment and the host-safety preload. Structural checks preserve all 57 audit rows and retained model evidence; all three second-round run IDs and five root causes are present, and model/trace/config files have no diff. Customer-facing delivery and agent-director guidance requires no additional operator action.

After completing the evidence update, the final scoped `bun test tests/shipped-docs.test.ts` run passed **2,456 tests, zero failures and 3,549 assertions in 9.57 s** (`/tmp/acu-ci2-docs-final-shipped.log`), with the same scratch launch HOME/state, environment stripping and host-safety preload. Final documentation whitespace and structural checks passed; local validation is complete.

All 57 audit dispositions, frozen model inputs, traces and retained TLC evidence remain unchanged. The passing conformance replay is no fresh TLC run or adapter-level proof. Per the owner's explicit instruction, CI is not run locally; the separate runner's rerun is still pending, and the recorded external gate remains FAIL at `3a6f2300`. No CI pass, merge or push is claimed.

## Documentation boundary

Current operator guidance lives in `docs/bots.md` and `docs/troubleshooting.md`; release behavior is under `CHANGELOG.md` Unreleased. Architecture, engineering/testing guides, the model README and affected test READMEs use AD ownership. `.claude/**` is explicitly excluded from edits even if historical prose there remains stale. No source, test code, config or frozen proof input is changed by the documentation worker.
