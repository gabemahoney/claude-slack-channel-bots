# Per-persona delivery model

CSCB relies on agent-director (AD) for agent state and does not parse an agent's TUI. Delivery, recovery Enter and reconnect require fresh AD `waiting` plus the existing persona, lifecycle, latch, hold, marker, relay and typing-gate guards. Normal delivery text and retypes also require connected MCP; recovery Enter may run while MCP is disconnected. Pane text, native transcript idle/turn ordering and compaction markers are not model observations. Exact own-message transcript receipts confirm delivery; successful key calls do not.

## Files and evidence

| File | Responsibility |
|---|---|
| [PersonaDelivery.tla](PersonaDelivery.tla) | State, engine/gate decisions, actions, invariants, fairness and trace projection. |
| [ci/suite.tsv](ci/suite.tsv), [ci/cfg/](ci/cfg/) | All 76 delivery rows, selected checks, constants, reductions, bounds, simulation seeds and controls. |
| [ci/check_cardinal.py](ci/check_cardinal.py) | Local verification over frozen model/config/helper hashes, raw logs and eight auxiliary checks. |
| [ci/runner.py](ci/runner.py), [ci/run_ci.sh](ci/run_ci.sh) | Canonical scheduler runner and certificate validation. |
| [ci/trace_contract.py](ci/trace_contract.py) | Scheduler trace validation and export. |
| [ci/temporal_sensitivity.py](ci/temporal_sensitivity.py), [ci/work_witness.py](ci/work_witness.py) | Independent original-action temporal checks and accepted-work witnesses. |
| [ci/profile_restart.py](ci/profile_restart.py) | Restart projection/dataflow audit. |
| [ci/fairness-probe/](ci/fairness-probe/) | Seven fairness obligations and first-text-refusal diagnostic. |
| [PROVENANCE.txt](PROVENANCE.txt), [tla2tools.jar](tla2tools.jar) | Tool provenance and current input pins. |
| [ci/local_storage.py](ci/local_storage.py) | Lossless evidence and storage accounting. |
| [ci/feasibility_profile.json](ci/feasibility_profile.json), [ci/screen_cfgs.py](ci/screen_cfgs.py) | Resource admission and exploratory model screening; screening refers to run admission, not terminal text. |
| [delivery-local-evidence.py](../../tests/test-helpers/delivery-local-evidence.py) | Local export and offline validation of input hashes, raw logs, proof bundles and fixture inventory. |
| [coverage.json](../../tests/fixtures/delivery-traces/coverage.json) | Portable local evidence, exact fixture hashes, per-row modes and executed coverage. |

## State and decision map

One persona owns a durable ordered queue, one active delivery target, a typing gate, timers, authoritative AD observations and exact own-message receipt facts. Personas are independent. The runtime map is in [architecture.md](../../docs/architecture.md#delivery-model-code-map). `delivery-policy.ts` exposes the pure engine/gate vocabulary; conformance renders explicit AD and receipt observations and checks production decisions.

An unconfirmed durable own send becomes eligible for a persisted recovery Enter after normal backoff and fresh AD waiting. Its durable attempt identity is retained; the volatile completion identity prevents repeating that recovery step within the same live engine. Enter is followed by a receipt wait, then full retype only while confirmation remains absent. Recovery precedes disconnected reconnect. Server restart forgets volatile identity, never durable accepted work. Refusals retain queued work and existing backoff.

Relaunch observations use AD row transitions into `pending`, `ended` or `missing`, or a changed session ID. Same-session resumes remain visible through AD row transitions. New engine instances start with a recovery check. `MaxLaunches` bounds environment exploration through existing fault counts (`BotLifeCount`); delivery cannot observe a synthetic launch counter or a launch-settle timer. `RestartSafetyView` retains the relaunch flag and frozen observation where future decisions consume them. Native compaction is not an action or lifecycle input. Durable queue compaction is a distinct journal rename/finish operation.

Reconnect records input intent before text. Partial or uncertain input resumes with Enter alone; definite text refusal clears intent. Pending control input blocks delivery keys and retains lifecycle retry ownership even after MCP connects. Launch/session changes, terminal or absent rows, teardown and shutdown cancel intent and delayed keys.

### Outcome-only probes

Three runtime paths use AD pane-read success/error outcomes: CLI teardown in `src/cli.ts`, the shared own-pane probe for prompt-row recovery/server teardown in `src/session-manager.ts`, and the latch probe in `src/session-manager.ts`. They discard the payload. Success does not prove idle or authorize keys; typed errors retain their lifecycle/latch/outage handling. No pane content or pane hash enters delivery policy or diagnostics. Startup/trust dialogs are handled by AD pre-trust or a human.

## Properties, fairness and assumptions

The safety checks include `TypeOK`, `NoDrop`, `InOrder`, `OneInFlight`, `DurableAccept`, `ReceiptBacked`, `TranscriptFIFO`, `NoRetypeWhileWorking`, `GateExclusive`, `NoDuplicateKey` and `TypingGuards`. Typing guards require AD waiting and the existing non-screen requirements. Exact `HeadTakenIn`, eventual delivery and reconnect/gate progress depend on the model's explicit environment assumptions and seven fairness obligations.

At-most-once is not a guarantee: the expected duplicate witness must fail `AtMostOnce`. `NoDuplicateKey` prevents duplicate durable acceptance, but an unconfirmed item can be delivered again. FIFO advances only after an exact own-message take-in and a durable delivered record.

The restart durable-send prefix admits four sends per part so text, recovery Enter, retype and recovery Enter remain reachable. This is an exploration bound, not a production retry cap. Config and fault names such as `*_screen`, `control_retype_into_text`, `control_reconnect_running` and `botCompact` are stable inventory identifiers; their current meanings concern AD observations/refusals and local guards, not terminal presentation or native compaction.

## Verification scope

The manifest has 76 delivery rows:

- Eight positive bounded exhaustive checks: `core_head_taken_in`, five `restart_order*` checks, `safety_plain` and `safety_agent_input`. Guarantees apply only within each config's constraints, bounds and reductions. The core checks `HeadTakenIn` in a small constrained, unprojected scope; restart safety uses `RestartSafetyView` and `RestartStateConstraint`.
- Forty expected counterexamples, including the duplicate witness. A control must fail its specified target, not merely produce any checker error.
- Twenty-eight fixed-seed simulations, each with eight samples at depth 256. Sampled safety does not prove temporal properties. The `live_*` properties remain **UNVERIFIED** by simulation.

Eight auxiliary rows add a bounded exhaustive permission-safety check, six expected safety/temporal/reachability counterexamples, and a proof-parser simulation with two depth-five samples. Independent original-action replay, accepted-work witnesses and temporal contrast bundles are required for the applicable rows. All modes, seeds, expected targets and bounds are defined by the checked-in manifests/configs.

The supplemental pullback witness is an existential finite prefix outside those 84 rows. It supplies genuine `PullBack` fault coverage absent from the fixed-seed samples, with an original-`Next` edge replay and unchanged safety invariants. It makes no liveness claim. The current portable corpus binds 266 traces and 40,776 states, including the 19-state, 18-edge supplemental prefix; executed coverage includes 18 engine actions, 38 negative controls, 26 bounded faults and four flapping actions. The coverage inventory is the source for exact fixture and evidence hashes.

Runtime conformance validates the complete inventory and replays every frozen state through production AD/receipt decisions, including saved observations, expired timers, disconnected-MCP recovery, same-session resumes and changed sessions. It rejects retired launch/settle fields. The FIFO mutation control first requires the original production policy to pass the same fixture before requiring reversed-order selection to fail.

These checks do not prove the entire runtime adapter. In particular, `ModelReconnectStep` abstracts the receipt-window reconciliation guard. The adapter keeps reconciliation blocked while an unconfirmed recovery attempt is outside phase `ready`, has a `receiptWorking` extension, or lacks matching session/recovery-attempt identity. AD `working` extends recovery through a fresh receipt wait after `waiting`; an exact receipt permits early reconnect only after the delivered append is durable. Production engine regressions separately cover lease release after AD read failure, durable receipt completion, failed recovery-intent append/backoff and working-to-waiting receipt-window extension. Native hooks and integration behavior require their separate integration checks.

Local evidence has `certification: false`. Offline validation and conformance establish neither a fresh TLC run nor scheduler certification nor a full `/ci` verdict.

## Reproducing verification

Run commands from the repository root. Use the scratch launch HOME and environment isolation documented in [Running the unit suite](../../tests/README.md#running-the-unit-suite); the host-safety preload must remain enabled.

For offline evidence validation and production replay, without starting Java, TLC or a scheduler:

```sh
python3 -B tests/test-helpers/delivery-local-evidence.py
bun test tests/delivery-model-verdict.test.ts tests/delivery-model-conformance.test.ts
```

The verdict suite uses disposable synthetic evidence and an injected scheduler. It checks missing, empty, malformed, incomplete and stale certificates, changed input bytes, wrong targets and tampered proof artifacts. The conformance suite checks the retained local proof and runtime replay independently.

For a separately authorized fresh local checker run, select a new directory under ignored `spec/tla/ci/.runs/` and an absolute Java executable. For example:

```sh
python3 -B spec/tla/ci/check_cardinal.py \
  --java /absolute/path/to/java \
  --output spec/tla/ci/.runs/delivery-check \
  --seconds 3600 --workers 4 --proofs
```

This command runs TLC locally. It freezes all 107 model/config/helper inputs, retains per-row raw logs and independent proofs, and checks that inputs remain unchanged. Each primary row uses one TLC worker and a 384 MiB heap; `--workers` controls concurrent rows. Independent temporal proof chunks remain limited to 60 seconds. `--cfg` selects a partial diagnostic run and cannot produce exportable complete evidence.

Fixture export additionally requires the authentic launch receipt at the run path with suffix `.launch.json` and the supplemental pullback search/replay bundle under `supplemental/pullback/`; the primary checker does not create these. The launch receipt records actual argv, `rowSeconds`, `workers`, `proofs`, expected delivery/auxiliary row counts and model/temporal-helper hashes, as checked by `launch_budget` in the local evidence helper. The supplemental generator, inputs, raw trace, logs and exact replay artifacts are retained inside the portable supplemental fixture. Reproduce them against the same frozen inputs; do not manufacture receipts or edit proof bytes to satisfy validation.

After a complete successful run and its required evidence are available:

```sh
python3 -B tests/test-helpers/delivery-local-evidence.py \
  --export spec/tla/ci/.runs/delivery-check
```

Export validates before replacing fixtures. Its change inventory is written to ignored `spec/tla/ci/.runs/export-inventories/<sha256-of-resolved-run-path>/trace-changes.json`. Re-exporting the same run retains that run's original inventory baseline; a different run starts from the fixtures present at its first export. Inventories are review aids, not proof inputs. Rerun offline validation and conformance after export.

For scheduler certification, consult `bun run tla --help` and the manifest. The runner requires a caller-supplied absolute executable `TLA_JOBSCHED`; starting jobs also requires `TLA_CHANNEL`. Use `start`, then the emitted completion-driven commands to collect/advance the frozen run. Preserve raw logs, exit codes, input hashes, exact control targets and independent proof artifacts. Do not edit a running snapshot.

The runner writes fresh receipts to ignored `spec/tla/ci/jobs.jsonl` and certificates to ignored `spec/tla/ci/verdicts.txt`; neither ships as a committed claim. With `TLA_JOBSCHED` configured, `bun run tla verify` only validates the latest certificate and its complete supporting evidence. Missing/empty certificates fail with `no certified suite`; changed inputs/snapshots fail, and invalid latest evidence cannot fall back to an older certificate. A clean checkout has no scheduler certificate. Local export does not create one.

`runner.py`'s `input_paths` excludes Markdown and the local export helper. Documentation edits do not change the frozen local proof hashes. `verify_pins` additionally binds `PROVENANCE.txt` for scheduler certificates, so even a provenance prose edit invalidates an older scheduler certificate without changing the model pins or local proof bytes.
