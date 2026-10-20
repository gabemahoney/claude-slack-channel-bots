# b.acu / b.aqj change and verification report

This report covers audit A01–A48 and associated AT01–AT09. A49–A51 and section B are excluded. Source milestones: `bc3d70d9`, `5f2f62d4`, `5ef71567`, `e54e638e`, `10486a91`; test restoration milestone: `f99c6d38`; model milestone: `fcb93897`. Owner waiting-only, model-unblock and release instructions supersede the audit's AD-I block and earlier screen-dependent requirements.

## Current contract

Only fresh agent-director `waiting` authorizes delivery, recovery Enter and reconnect text/Enter, with existing persona/up/latch/hold/lifecycle/marker/relay guards; normal delivery text/retypes also require connected MCP, while recovery Enter is allowed with MCP disconnected. Refusals retain queued work and existing backoff. Exact own-message transcript receipts alone confirm delivery; no idle/busy/turn/compaction state is inferred. Pane text is never consumed or retained, including diagnostics. Startup/trust autoanswers are removed; AD pre-trust or a human handles dialogs. Pending-row cover, grace/bound and normal retries remain. Authoritative `get` records own-launch identity; the latch observer remains.

Unconfirmed durable own sends receive a persisted `send_kind: enter` recovery attempt under AD waiting/local guards/backoff, including with MCP disconnected, then a receipt window. `recoverBeforeReconnect` prevents reconnect text from overtaking durable attempts or a successful recovery Enter awaiting its receipt window. Only absent confirmation permits later full retype. Durable accepted work, strict FIFO, one in flight and at-least-once behavior remain; duplicates are possible.

Reconnect records input intent before text. Partial or uncertain input resumes with Enter alone; definite text refusal clears intent. Pending control input blocks delivery keys and retains lifecycle retry ownership even after MCP connects. Launch/session change, terminal/absent rows, teardown and shutdown cancel intent and delayed keys.

Documentation follow-up removes working/waiting pane checks, stale screen-duration notices, native final-pane/composer diagnostics, startup approver/trust Enter instructions and the obsolete `working-tmux-gone`/`waiting-row-pane-gone` evidence rows. Outcome-only prompt-row, latch and teardown probes remain. Final trace/TLC/unit/CI evidence below stays pending.

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
| AT09 | `tests/test-helpers/delivery-model-replay.ts:42` | Model replay parsed native pane fixtures with the production classifier. | Replay now consumes AD observations/refusals and exact receipts; final regenerated trace/conformance evidence remains pending below. |

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
| `spec/tla/PersonaDelivery.tla` | Remove screen/idle/compaction-derived readiness; add durable recovery Enter intent and volatile completion identity under waiting-only guards. |
| `spec/tla/PersonaDelivery.tla:RestartStateConstraint` | Expand explicit per-part durable-send prefix from two to four so text/recovery Enter/retype/recovery Enter remain reachable; keep all invariants. |
| `spec/tla/ci/fairness-probe/PermissionFairness.tla` | Use AD waiting/live refusals and model recovery Enter while retaining the original seven fairness obligations and first-text-refusal diagnostic. |
| `spec/tla/ci/check_cardinal.py` | Freeze actual model/runner/config hashes, retain raw logs and independent proofs, and include all 76 delivery rows plus 8 auxiliary checks in a detached local run. |
| `spec/tla/ci/work_witness.py` | Audit the expanded four-send prefix while independently replaying original actions/fairness/exact receipts. |
| `spec/tla/ci/profile_restart.py` | Retain recoveryAttempt, durable attempt IDs and recovery-enter readings in the projection/dataflow audit. |
| `spec/tla/ci/runner.py` | Declare current AD typing invariant/mutants and four-send reduction metadata. |
| `spec/tla/ci/trace_contract.py` | Validate recovery action divergence and four-send companion counterexamples. |
| `spec/tla/ci/temporal_sensitivity.py` | Keep independent temporal proof guides within current screen-free model and current four-send scope. |
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

**PLACEHOLDER — fill from the final exporter inventory after export.** List every actual added/rewritten/deleted trace file and one-line reason, including metadata/provenance/coverage changes. The 76 manifest-row plan is not a substitute for the actual-file inventory. Screen-marker-only cases must not remain as readiness evidence. Keep all non-screen no-loss/FIFO/durable-work controls and duplicate witness semantics.

## Verification results

**PLACEHOLDER — final canonical 84-row run (76 manifest + eight auxiliary), run ID/path, frozen input identity, every per-config result and expected-control target, exhaustive versus sampled scope, trace export counts and conformance replay results.** Verification is pending; no current PASS is claimed here.

**PLACEHOLDER — full isolated unit-suite outcome; separate runner's full `/ci` run ID and verdict; final commit list.** Per the owner handoff in `/tmp/ci_note.md`, a separate CI runner owns full `/ci` after the branch fix, full isolated units and commits; a local credential-related NOT RUN is not a blocker. The documentation worker runs only targeted documentation checks and makes no commit/merge/push. The calling agent records the unit/commit evidence and the separate runner's CI verdict when available.

Targeted documentation verification: `bun test tests/shipped-docs.test.ts` with scratch launch HOME/state and the host-safety preload passed 2,456 tests, 3,549 assertions, 0 failures in 10.04 s; local log: `/tmp/acu-final-shipped-docs.log`. The owned documentation diff passes `git diff --check`. A stale-reference audit across README, CONTRIBUTING, `docs/*.md`, `tests/README.md` and tracked skills finds no removed readiness/approver symbols or screen-based contract; explicit removal rationale in this report and excluded CI-live collection contracts remain. Outcome-only prompt-row/latch/teardown probes and human diagnostic commands are retained.

## Documentation boundary

Current operator guidance lives in `docs/bots.md` and `docs/troubleshooting.md`; release behavior is under `CHANGELOG.md` Unreleased. Architecture, engineering/testing guides, the model README and affected test READMEs use AD ownership. `.claude/**` is explicitly excluded from edits even if historical prose there remains stale. No source, test code, config or frozen proof input is changed by the documentation worker.
