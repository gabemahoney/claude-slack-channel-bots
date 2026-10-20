# Per-persona delivery model

The b.acu/b.aqj revision models agent-director as the authority for typing readiness. Delivery, recovery Enter and reconnect require AD `waiting` plus existing non-screen guards. Pane text, native transcript idle/turn ordering and compaction markers are not model observations.

**Verification pending.** The final canonical local run contains 84 rows: 76 delivery-manifest rows and eight auxiliary checks. Results, source hashes, exhaustive/sampled coverage and the regenerated trace inventory must be filled into [the change and verification report](../../docs/cardinal-delivery-verification.md) after export. Earlier `ci/verdicts.txt` and frozen fixture evidence do not certify the edited model. Do not report pending work as a pass.

## Files and evidence

| File | Responsibility |
|---|---|
| [PersonaDelivery.tla](PersonaDelivery.tla) | State, engine/gate decisions, actions, invariants, fairness and trace projection. |
| [ci/suite.tsv](ci/suite.tsv), [ci/cfg/](ci/cfg/) | All 76 manifest rows, selected checks, constants, reductions, bounds, simulation seeds and controls. |
| [ci/check_cardinal.py](ci/check_cardinal.py) | Detached local verification over frozen model/config/helper hashes, with raw logs and eight auxiliary checks. |
| [ci/runner.py](ci/runner.py), [ci/run_ci.sh](ci/run_ci.sh) | Existing canonical scheduler runner and evidence validation. |
| [ci/trace_contract.py](ci/trace_contract.py) | Trace validation and export. |
| [ci/temporal_sensitivity.py](ci/temporal_sensitivity.py), [ci/work_witness.py](ci/work_witness.py) | Independent original-action temporal checks and accepted-work witnesses. |
| [ci/profile_restart.py](ci/profile_restart.py) | Restart projection/dataflow audit. |
| [ci/fairness-probe/](ci/fairness-probe/) | Seven fairness obligations and first-text-refusal diagnostic. |
| [PROVENANCE.txt](PROVENANCE.txt), [tla2tools.jar](tla2tools.jar) | Tool and input provenance for the published scheduler workflow. |
| [ci/local_storage.py](ci/local_storage.py) | Lossless evidence and storage accounting. |
| [ci/feasibility_profile.json](ci/feasibility_profile.json), [ci/screen_cfgs.py](ci/screen_cfgs.py) | Resource admission and exploratory model screening; the filename refers to run admission, not terminal text. |

## State and decision map

One persona owns a durable ordered queue, one active delivery target, a typing gate, timers, authoritative AD observations and exact own-message receipt facts. Personas are independent; no model observation reconstructs native agent state from text.

The runtime map is in [architecture.md](../../docs/architecture.md#delivery-model-code-map-bomv-sr-156). `delivery-policy.ts` exposes the pure engine/gate vocabulary; conformance renders explicit AD and receipt observations and checks production decisions without native screen adapters.

An unconfirmed durable own send becomes eligible for a persisted recovery Enter after normal backoff and fresh AD waiting. Its durable attempt identity is retained; the volatile completion identity prevents repeating that recovery step within the same live engine. Enter is followed by a receipt wait, then full retype only while confirmation remains absent. Server restart forgets volatile identity, never durable accepted work.

Bot launch/session changes are authoritative lifecycle observations. Native compaction is not an action or lifecycle input. Durable queue compaction remains a distinct journal rename/finish operation.

## Properties, fairness and assumptions

Keep `NoDrop`, `InOrder`, `OneInFlight`, `DurableAccept`, `ReceiptBacked`, `TranscriptFIFO`, `NoRetypeWhileWorking`, `GateExclusive` and `NoDuplicateKey`. `TypingGuards` replaces the former screen-specific guard property with AD waiting and existing non-screen requirements. Exact `HeadTakenIn`, eventual delivery and reconnect/gate progress retain their explicit environment and fairness assumptions.

At-most-once is not a guarantee: the expected duplicate witness must continue to fail `AtMostOnce`. An unconfirmed item can be delivered again. A successful key call is never a receipt; FIFO advances only after an exact own-message take-in and durable delivered record.

Bounded exhaustive results apply only within each config's stated bounds/reductions. Sampled simulation safety does not prove temporal properties. The restart durable-send prefix now admits four sends per part so text, recovery Enter, retype and recovery Enter remain reachable; this is a bounded exploration limit, not a production retry cap.

Config filenames such as `*_screen`, `control_retype_into_text` and `control_reconnect_running` remain stable inventory identifiers. Their current faults/targets cover AD row/refusal and local guards, not native presentation. [The verification report](../../docs/cardinal-delivery-verification.md) lists each changed model/helper/config with a reason and reserves the final per-trace inventory.

## Reproducing verification

Use the checked-in runner's help and manifest for supported invocation, resources and output. Freeze the model/config/helper inputs before starting a run and preserve the raw logs, exit codes, source hashes, expected-control targets and independent proof artifacts. Do not edit a running snapshot or reuse an earlier certificate for changed inputs.

`runner.py`'s `input_paths` excludes Markdown. Documentation updates do not change the frozen proof input hashes; edits to model/config/helper code do. Final export, conformance and full-suite results are recorded separately in the linked report.
