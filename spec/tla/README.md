# Per-persona delivery model

E1's canonical scheduler run `18bc2f88a91e4fdaa7c255b9db865ba8` completed all 76 rows in 15 jobs with `CI-VERDICT PASS` on 2026-10-15. The [certificate](ci/verdicts.txt) and [trace coverage](../../tests/fixtures/delivery-traces/coverage.json) bind the same snapshot, `51f184b83ac579cbb718f9d8359a5a5bd04b8723fd46885ec0f89d44fcd004d8`. This implements the model and evidence contract in b.omv SR-15, PRD `t1.omv.ur` R61/AC103 and current SRD `t1.omv.ef`, including owner decisions 13 and 14.

Eight positive rows exhaust their admitted bounded graphs, checking all eleven safety invariants. The one-item, one-part `core_head_taken_in` additionally checks exact `HeadTakenIn` without VIEW or symmetry: 4,891 distinct states, depth 39. These are constrained results, including a maximum of two persisted sends per part; they establish no universal unbounded liveness guarantee. The 28 raw simulations check sampled safety only, and their temporal obligations remain **UNVERIFIED**.

Decision 14's designated exhaustive coverage is `safety_plain` for `NoDrop`, `InOrder`, `OneInFlight`, `DurableAccept` and `ReceiptBacked`, and `core_head_taken_in` for `HeadTakenIn`. The certificate and coverage retain the completed row, source hashes, reduction and job ID for each mapping. The other seven positive exhaustive rows retain two-item/multipart safety coverage; the minimum core establishes no multi-item, multipart, flapping or selected-fault liveness guarantee.

All 38 controls fail their exact targets: 37 mutation/fairness/scheduling controls and one environment-assumption diagnostic. The duplicate witness fails `AtMostOnce` and the premise probe fails `NotPremise`, as required. At-most-once delivery is not a guarantee. E3's runtime engine and conformance replay remain pending; E1 changes no runtime delivery path.

## Files and evidence

| File | Responsibility |
|---|---|
| [PersonaDelivery.tla](PersonaDelivery.tla) | State, pure choices, executed actions, properties, fairness and trace projection |
| [ci/cfg/](ci/cfg/) and [ci/suite.tsv](ci/suite.tsv) | Exact constants, selected checks, reduction directives, modes, seeds and row caps |
| [ci/run_ci.sh](ci/run_ci.sh), [ci/runner.py](ci/runner.py) | Frozen preflight, one-job submission/collection, final certificate |
| [jobs/lib/job.py](jobs/lib/job.py), [jobs/lib/tlcjob.sh](jobs/lib/tlcjob.sh), [jobs/lib/Dockerfile](jobs/lib/Dockerfile) | Scheduler worker and bounded job image |
| [ci/trace_contract.py](ci/trace_contract.py), [ci/temporal_sensitivity.py](ci/temporal_sensitivity.py), [ci/work_witness.py](ci/work_witness.py) | Trace validation, original-step temporal replay/contrasts and separate accepted-work witnesses |
| [ci/local_storage.py](ci/local_storage.py) | Lossless evidence containers and aggregate storage accounting |
| [ci/feasibility_profile.json](ci/feasibility_profile.json), [ci/screen_cfgs.py](ci/screen_cfgs.py) | Reviewed local admission and bounded exploratory screening |
| [PROVENANCE.txt](PROVENANCE.txt), [tla2tools.jar](tla2tools.jar) | Tool origin, adaptations and input pins |
| [ci/verdicts.txt](ci/verdicts.txt) | Complete matching canonical PASS record; source hashes, jobs, modes, reductions and replay bindings |
| [tests/fixtures/delivery-traces/coverage.json](../../tests/fixtures/delivery-traces/coverage.json) | Fixture digests and executed coverage, including core-property and row-mode mappings |
| [tests/delivery-model-verdict.test.ts](../../tests/delivery-model-verdict.test.ts) | Certificate staleness, genuine fixture contract, relocation and failure-path checks |

Certificate SHA-256: `1b474d78d0303ef12f63d84bda842b2e586a3586620bb9c79b7e3b5f6e7bd790`. Coverage SHA-256: `26c6c5a1f72f805dc581eea4929cec98c700a91f6cbcc75923edfccf04ded1b6`. The model hash is `a69aa44354e7a4be7f763af4799991b0cd471f47c6e82e7b92203f628a0081cc`; the pinned jar hash is `32d64fbbc464559fc7192341b27b885fa4eb6b92d1648d2b49fb9cdcb7aacf81`.

The certificate and fixtures are the repository evidence. For deeper local audit, ignored `spec/tla/ci/.runs/18bc2f88a91e4fdaa7c255b9db865ba8/state.json` records `certified=true`, `phase=certified`, `outstanding=null`, all collected results, compressed full logs and SANY preflight. Compact summaries are `spec/tla/ci/.runs/e1-report-evidence/current-canonical-certification.json` and `final-evidence-review.json`; the latter found no discrepancies. Earlier `E1-report.md` and older incomplete-run notices in PROVENANCE are historical evidence on their own snapshots, not the current result. Untracked `.draft` prototypes are not production inputs.

## State and decision map

The single variable `st` describes one persona; personas are independent. `Init` starts with empty durable state and histories, an idle `waiting` bot, no pending observation, and an up server. The `empty-reconnect` scenario instead starts disconnected with other text in the box and a deferred reconnect.

| State | Meaning and model consumers |
|---|---|
| `p` | Durable accepted/fixed items, ordered `sent` attempts, refused attempts, delivered pairs, Slack keys, append records and unfinished torn records; read by queue/head selection, recovery and receipt matching |
| `e` | Volatile phase/target, attempt, observed launch/session/compaction, Enter retries, per-item retypes, timers, append-blocked flag, notices, request and saved key reading |
| `g` | Gate owner (`free`, `delivery`, `reconnect`), stage, deferred/due/typed reconnect flags and its reading |
| `w`, `compact` | Single pending append and queue-compaction prepare/rename/directory-fsync stages; durability is a separate transition from starting a write |
| `a.row`, `a.earlierRow`, `a.actual` | Reported AD state and a prior real reported state, separate from actual `idle`, `busy` or `compacting`; `waiting` does not prove idle |
| `a.screen`, `a.box`, `a.submitted`, `a.input` | Screen abstraction, composer contents/Enter status and ordered agent input queue; duplicate copies remain distinct entries |
| `a.log`, `a.pending`, `a.transcript` | Written transcript records, accepted take-ins awaiting transcript write, and readable/not-yet-written/unreadable status |
| Other `a` fields | Persona presence, bot liveness/up status, relay/marker/MCP, permission/overlay/person/spell conditions, writable queue, launch/session/compaction and reconnect completion |
| `h.accepted`, `h.acked` | Permanent durable-accept and acknowledgement histories |
| `h.everSent`, `h.everDelivered` | Permanent pair histories; neither crash nor compaction clears these definitions of `Sent`/`Delivered` |
| `h.taken`, `h.credited`, `h.credits`, `h.keys` | Actual take-in sequence, credit-once record identities, ordered receipt credits and executed key/guard evidence |
| `faults`, `server`, `starts` | Selected bounded fault counters, server up/crashed status and start count |
| `observation`, `knowledge` | Outstanding external observation and the knowledge snapshot used for pure decisions |
| `transition`, `action`, `outcome`, `expired`, `bugStep` | Executed-edge metadata, timer expiries and mutation sensitivity; not inferred from enabled choices |
| `saved`, `redelivery`, other `h` bookkeeping | Torn-record recovery audit, Slack-redelivery state and reconnect/compaction history |

`HeadPair` is the lowest undelivered part of the lowest open item. Item 1 has `MaxParts` parts; every later item has one actual part. `SelectTarget`, `EngineChoice(k)` and `GateChoice(k)` depend on knowledge, not hidden current agent state. A correct `EngineObserve` installs a reading, and its sequential `EngineStep` consumes that reading; environmental actions may intervene. Owned storage/call completions can continue without another observation. Gate grants take a fresh reading only after the prior one is consumed.

`ReplayKnowledgeOf` exports the decision snapshot appropriate to each state; `gateKnowledge` exports the gate's own knowledge. E3 must preserve this distinction, including frozen receipt records and the saved screen reading used by a key call.

## Action map and E3 handoff

Every row in the following model-side maps has **E3 code path and rule-specific unit test pending**. E3 must export `ENGINE_ACTIONS` equal to the model's 21-name `EngineActions` set and add `tests/delivery-model-conformance.test.ts`; that test is not implemented by E1.

| Engine action | Model effect / executed operator |
|---|---|
| `expireTimers` | Decrement positive abstract timers and export exactly which expired (`EngineStepSuccessful`) |
| `commitAppend` | Complete the single durable append, then advance its continuation (`CommitAppend`) |
| `observeLaunch` | Reset launch/session-sensitive phase and retry state, set settle wait and check prior receipts |
| `observeCompaction` | Notice new compaction and check sent records across retained transcripts |
| `readReceipt` | Start a delivered append for the earliest matching uncredited take-in after the first sent offset |
| `fixText` | Start durable fixed-text append before sending |
| `recordSend` | Start durable first-send/retype record with attempt, transcript offset and lifecycle identity |
| `typeText` | Execute the selected text call under the gate (`TextAttempt` or a call-fault alternative) |
| `pressEnter` | Execute the initial Enter call separately (`EnterAttempt(FALSE)`, `LostEnter` or `CallFault`) |
| `recordRefusal` | Persist the refused attempt before further selection/reuse |
| `recordEnterRetry` | Persist another sent record for an Enter-only retry; it counts toward the two-send constraint |
| `retryEnter` | Execute Enter only (`EnterAttempt(TRUE)` or the selected call fault) |
| `releaseAttempt` | End the receipt wait/attempt and return to ready, permitting gate release |
| `requestGate` | Request delivery ownership; actual grant is a separate gate transition |
| `deferReconnect` | Retain deferred reconnect and re-run it when due |
| `recordNotice` | Persist the once-per-item notice after retyping |
| `leftoverEnter` | Enter-only handling of the just-delivered item's leftover composer copy |
| `stopAbsent` | Consume a decision while absent/down without starting keys |
| `compactQueueRename` | Atomic authoritative queue replacement, preserving open items (`QueueCompactRename`) |
| `compactQueueFinish` | Finish compaction after directory fsync (`QueueCompactFinish`) |
| `ignoreDuplicate` | Clear a stored-key redelivery without queuing it again |

`wait` is a legal pure choice outside `EngineActions`. The five `ControlActions` are `discardInflight`, `dropOldOpen`, `ackBeforeStore`, `storeDuplicateKey` and `assumeDelivered`: respectively remove an open item on startup, drop it at compaction, acknowledge before durability, store a repeated key and mark delivery without receipt. They are mutant decisions, not runtime actions to implement.

| Gate choice / transition | Model meaning |
|---|---|
| `grantDelivery`, `cancelRequest`, `release` / `GateStep` | Revalidate pending operation, grant a fresh reading, cancel an unsafe request, or release ownership |
| `runReconnect` / `ReconnectStep` | Type reconnect text and Enter under its separate empty-screen/positive-idle checks |
| `stealForReconnect` / `ReconnectStep` | Mutant reconnect steals another owner's gate |
| `wait` | No gate action |
| `EngineObserve` | Read current knowledge; `replace_observation` alone can replace an unconsumed read |
| `EngineStep`, `EngineStepSuccessful`, `EngineCallFault` | One chosen sequential operation with successful and selected call-outcome alternatives |

| Environment/storage action | Model effect and trace transition |
|---|---|
| `Accept`, `RedeliverSlack` | Accept Slack/interject/cron into the single writer; stored Slack keys deduplicate across starts |
| `StartWrite`, `CommitAppend`, `AppendFailure`, `QueueWritable` | Begin write, durable return/ack, failed append/backoff and restored writability |
| `TextAttempt`, `EnterAttempt`, `CallFault`, `LostEnter` | Distinct text/Enter outcomes; unknown can have happened or not; lost Enter leaves unsubmitted text |
| `QueueMidTurn` | Move submitted text to ordered input queue and append enqueue, which is not a receipt |
| `AgentTakeIn`, `AgentTurnEnd` | Take composer/queue head into work, then write pending take-ins when the turn ends |
| `AgentOwnTurnStart`, `PermissionOpen`, `PermissionAnswer` | Unbounded own turns and prompt changes; sends are refused while permission may be open |
| `AgentDrop`, `PullBack`, `PersonBox(TRUE/FALSE)` | Drop queued text, pull it into a person's composer, then one submit/clear (`PersonSubmit`/`PersonClear`) |
| `MCPDrop`, `ReconnectDue`, `AgentCompletesReconnect` | Disconnect, health/message/timer due event, and successful asynchronous reconnect completion |
| `OverlayOpen`, `OverlayClose` | Open/close a menu; opening between read and keys may lose text |
| `Unreadable`, `Readable` | Transcript-unreadable/readable spell (`TranscriptUnreadable`/`TranscriptReadable`) |
| `BusyWaiting`, `StaleRead` | Report waiting during actual compaction (`BusyWhileWaiting`), or read a prior reported row |
| `Spell(f,TRUE/FALSE)` | Begin/end `notNow`, `dialogHold`, `relayOff`, `askUser`, `latchHold` (`SpellBegin:f`/`SpellEnd:f`) |
| `BotCrash`, `BotLife(f)`, `BotReady` | Crash; restart/resume/new conversation; become ready after pending launch |
| `BotCompaction` | Compact the bot while retaining prior transcripts |
| `ServerCrash`, `TornAppend`, `ServerStart` | Crash at any eligible boundary; quarantine unfinished append; reconstruct state from durable records |
| `PersonaRemove`, `PersonaReadd` | Stop engine while keeping queue; resume through startup recovery |
| `QueueCompactPrepare`, `QueueCompactRename`, `QueueCompactFinish` | Prepare/fsync temp, rename, directory-fsync finish; crashes can separate stages |
| `SendIsDelivery` | Mutant delivery without transcript evidence |
| `Done` | No-flapping completion stutter only when every accepted item is delivered and server is up |
| `Environment`, `Next` | Unions of the listed actions; `Next` includes observe, engine, gate, reconnect, environment and `Done` |

### Screen and transcript rendering map

All concrete pane fixtures in E3's `working-row-panes.ts` and all transcript-builder assignments below are **pending E3**. The reported rows are `pending`, `waiting`, `working`, `check_permission`, `ask_user`, `ended` and `missing`; they must be rendered independently of actual activity.

| Abstract screen | Meaning / rendering obligation |
|---|---|
| `empty` | Empty composer with no running-turn screen; reconnect may pass its remaining checks |
| `item` | An item's text in composer, including a busy agent with text; use `Text(pair)` for exact text identity |
| `other` | A person's unrelated text; no message/reconnect typing |
| `overlay` | Menu or permission overlay; preserve the separate permission and overlay flags |
| `running` | Busy/running screen with empty composer; first send may pass, reconnect requires the stricter empty-screen rule |

| Abstract transcript record/status | Meaning / transcript-builder obligation |
|---|---|
| `take-in` | Actual user-message acceptance (`pair`, exact `text`, `session`, ordered `taken`); only matching written take-ins after send offset can earn receipt credit |
| `queue-operation:enqueue` | Mid-turn input enqueue; never evidence of delivery |
| `queue-operation:remove:dropped_by_hook` | Explicit loss; excludes Enter-only recovery of that sent copy |
| `queue-operation:remove:cleared_on_cancel`, `queue-operation:remove:not_carried_to_background` | Recognized loss kinds in `NotTakenIn`; render as negative evidence if present |
| `queue-operation:remove:agent_stopped`, `queue-operation:remove:resume_failed` | Recognized agent-stop/resume loss kinds; not positive receipts |
| `queue-operation:popAll`, `queue-operation:popOne` | Pull-back/removal evidence; `PullBack` emits `popOne` |
| `pending` take-in sequence | Taken in but not written yet; an empty composer/`waiting` row does not imply readable receipt |
| `readable`, `not-yet-written`, `unreadable` | Transcript availability; only `unreadable` makes `TranscriptReadable` false |

Only kinds actually emitted earn executed coverage. Recognizing a loss kind is not a claim that every builder/kind is present in the fixture corpus. The agent abstraction covers Claude Code and Codex; Codex's stalled composer is lost Enter, and absent Codex drop/pull-back records provide no positive receipt.

## Properties, fairness and assumptions

Every property below has its **E3 code path and matching rule unit test pending**. The model checks its declared semantics; runtime equivalence remains E3's responsibility.

| Property | Exact model-side rule |
|---|---|
| `TypeOK` | Reported rows/activity/screen/gate domains, marker, queue bound, fault budgets, credit uniqueness and legal decision vocabulary |
| `DurableAccept` | `h.acked` is a subset of durable `h.accepted` |
| `NoDrop` | Every acknowledged item remains in durable accepted state or is historically delivered |
| `ReceiptBacked` | Every credited pair has a matching written `take-in` after its first send offset; delivered history equals credited pairs |
| `InOrder` | Sending any later accepted item requires earlier accepted items' last parts delivered |
| `TranscriptFIFO` | Credited take-ins follow preceding parts and earlier items in take-in order; enqueue is not a receipt |
| `OneInFlight` | No two accepted items are in flight; sending a later part requires the prior part delivered |
| `NoTypeIntoText` | Message keys use a safe saved read (empty/running, waiting/working, relay/marker/MCP/up, no latch/hold); reconnect keys meet `ReconnectGate` |
| `NoRetypeWhileWorking` | Retype key reads waiting, empty composer and missing receipt |
| `GateExclusive` | Each key event's sender owns its gate |
| `NoDuplicateKey` | Retained Slack key sequence has no duplicate |
| `AtMostOnce` | A part appears in actual take-in history at most once; expected-failure witness only |
| `NotPremise` | Negation of exact `Premise`; expected-failure satisfiability probe only |

`EnvTypable` requires the server up; persona present and bot up; no latch/hold; actual idle with reported waiting; relay on; no overlay, permission prompt or person's text; screen empty/item; no not-now or dialog-hold spell; and queue writable. **MCP connection and typing-gate ownership are excluded.** Every launch has the marker by the model assumptions.

The seven original action-fairness conjuncts, each covering all items/parts, are:

```tla
SF_vars(EngineObserve /\ EnvTypable)
WF_vars(EngineStep)
WF_vars(GateStep)
SF_vars(ReconnectStep)
SF_vars(AgentTakeIn)
WF_vars(AgentTurnEnd)
WF_vars(AgentCompletesReconnect)
```

`weak_observe` alone changes the first conjunct to WF for its negative control. Own-turn/prompt flapping actions have no individual fairness obligation; `AgentTurnEnd` still has its listed WF obligation. Fairness on an action only matters while its relevant nonstuttering enabledness condition holds.

Decision 13 adds an explicit **environment ASSUME**, separate from those seven conjuncts:

```tla
TypableHeadTakeInAssumption == \A ip \in Pairs :
  ([]<>(HeadPair(st.p) = ip /\ EnvTypable)) => []<>Taken(ip)
SpecWithoutHeadTakeInAssumption == Init /\ [][Next]_vars /\ Fairness
Spec == SpecWithoutHeadTakeInAssumption /\ TypableHeadTakeInAssumption
```

This temporal assumption is conjoined in `Spec` because TLA+'s module `ASSUME` declaration accepts constant-level formulas. `SF(AgentTakeIn)` alone can be vacuous when every text call is refused before anything reaches the agent. The no-assumption control preserves that zero-bounded-fault permission-starvation behavior with correct choices and all seven fairness rules.

`ReconnectsDue == []<>(st.a.mcp \/ st.g.due)`; `TranscriptReadable == st.a.transcript # "unreadable"`. The four temporal properties have distinct premises:

| Temporal property | Premise and conclusion |
|---|---|
| `EventuallyDelivered` | `Premise == []<>EnvTypable /\ <>[]TranscriptReadable /\ ReconnectsDue`; every accepted item leads to last-part delivery |
| `HeadTakenIn` | `[]<>EnvTypable /\ ReconnectsDue`; every head pair leads to a matching written take-in, without requiring transcript readability |
| `ReconnectNotBlocked` | `[]<>EnvTypable`; deferred reconnect leads to typed reconnect or restored MCP, even without an open item |
| `GateFreeInfinitelyOften` | No additional implication premise: `[]<>(st.g.owner = "free")` |

The specification selection in the per-cfg tables determines whether decision 13 applies. All original mutation controls and their companions select `SpecWithoutHeadTakeInAssumption`; their bugs must not be excused by that assumption. Positive rows, duplicate witness and premise probe select `Spec`.

### Bounds and model assumptions

The module requires `EnterRetries = 4` and at least the sum of budgets for `lostEnter`, `enterRefused`, `enterUnknown`, `textUnknown`; `MaxRetypes` strictly exceeds the sum for `textUnknown`, `agentDrop`, `pullBack`, `botCrash`, `botRestart`, `botResume`, `newConversation`, `serverCrash`, `tornAppend`, `overlay`; and `MaxAgentQueue >= MaxParts + MaxItems * MaxRetypes`. Selected faults have budget one, except `lostEnter` in `Scenario="safety"` has budget two; absent faults have budget zero. Loss guards require unused retype capacity, so the action-guard bound does not prevent recovery from an admitted loss.

The normal floor is two items, `MaxParts >= 2`, at least one launch and two server starts. Only the exact thirteen-constant `SmallCoreBounds` conjunction permits the one-item/one-part core; see its complete row below. `PromptFlapping=TRUE` has no effect if `Flapping=FALSE`. `Done` keeps deadlock checks enabled at true no-flapping completion; deadlocks elsewhere remain errors.

Returned durable appends are never later torn/corrupted; only unfinished writes tear. A person edits only through pull-back then one submit/clear. Stale reads are earlier real reported rows. Startup-dialog answers, marker-less launches/upgrade replacement, multi-persona acknowledgements, Slack key expiry and the actual restart-limit/delay policy are outside this model. It does not assume the transcript is written before an apparently empty waiting composer.

The timers use binary abstract pending/expired values. Trace constants map settle to 1,000 ms, receipt wait to 10,000 ms, retype backoff to 10,000/30,000/60,000/120,000/300,000/900,000 ms, idle-evidence wait to 120,000 ms, Enter delay to 500 ms, Enter-only retry to 2,000 ms and not-now retries to 5,000/10,000/20,000/40,000/60,000 ms. `TAG_MAX_BYTES=1900` and `FULL_PANE_READ_LINES=40`; E3 injects the same constants and advances its fake clock only on the corresponding timer-expiry transitions.

## Reduction scope and nonvacuity

Exactly 33 checking contexts use both `RestartSafetyView` and `RestartStateConstraint`: seven positive safety rows, fourteen invariant companions, ten temporal controls, the duplicate witness and premise probe. Eleven of those contexts declare temporal properties. One core row uses the constraint alone, with **no VIEW or SYMMETRY**. Original `control_retype_into_text` uses VIEW alone, with **no CONSTRAINT**: its original four-Enter-retry recovery path requires six persisted sends to expose the bug, beyond the shared restriction. The remaining 41 rows are RAW, including all 28 simulations. No row uses symmetry or an action constraint.

`RestartStateConstraint` admits only audited constant contexts, at most two persisted `sent` records per actual item/part (including Enter-only retries), binary timers and zero counters for inactive faults. It does not require a particular crash phase or prune every initial state. A third sent append can start while its commit is pruned; raw `WF(EngineStep)` may still demand that commit, leaving no fair constrained continuation at that boundary. Exhaustive claims therefore concern only original fair behaviors admitted within this restricted domain, including for the constraint-only core. They do not establish boundary-totality or unbounded recovery/liveness.

The VIEW retains durable accepted/fixed/sent/refused/delivered/key/torn contents needed for decisions, actual environment, log/pending/input, credits, permanent ever-sent/ever-delivered histories, engine phase/counters/timers, faults and observation state. It omits redundant record metadata, unused bookkeeping and overwritten owned snapshots; reduces key-event history to the three checked key predicates; preserves live saved readings and their key guards; retains full agent state for stale reads and cached transcript readings for unreadability; and keeps fair-edge metadata in temporal contexts. `RestartSentView` keeps item/part/how and non-refused offsets; actual lifecycle IDs stay live. The 22 non-temporal shared contexts and the VIEW-only invariant control make no general fairness-equivalence claim. Binary timers/inactive counters already hold by construction: their constraint clauses do not show new causal savings. Projection field samples are non-additive, and state-graph distinct counts are not liveness-tableau vertices.

Temporal VIEW traces are not positive universal liveness proofs. Each temporal control preserves its concrete original-`Init`/`Next` prefix, cycle and closing edge, original enabled/nonstuttering fairness checks, target and assumption selection. Choice omissions must expose suppressed required fair progress; `weak_observe` needs the WF/SF observation contrast; `replace_observation` needs an executed forbidden replacement edge. Pure-choice invariant controls require mutant/correct choice or target divergence, with an executed divergent transition additionally required for the VIEW-only retype row and fourteen companions.

Temporal mutation controls also carry a separate correct-behavior contrast under matching exogenous events, fault subjects and actual key outcomes, with `Bug="none"`. A labelled RAW contrast may need a third send; it is existential evidence about that environment and cannot relax the mutant's bounds, replace nonvacuity or certify universal progress. The no-assumption diagnostic instead validates its omitted assumption and zero-fault permission-starvation context; requiring a pure decision difference for it or for every fairness/scheduling control would be incorrect.

Two separate canonical accepted-work bundles establish bounded positive nonvacuity. The core bundle has 28 states, accepts item 1 and takes in/receipt-delivers `<<1,1>>` at the exact production core constants; loop 27–28. The probe bundle has 67 states, accepts items 1 and 2 and takes in/receipt-delivers `<<1,1>>`, `<<1,2>>`, `<<2,1>>`; loop 66–67, with its explicitly recorded `Scenario: probe -> liveness` construction derivation. Both search and independent replay use original raw `Init`/`Next` without VIEW, symmetry or pruning constraints, verify every raw state's constraint membership including the closing edge, all seven fairness obligations, decision 13, exact `Premise` and `HeadTakenIn`, and finish within their source row's shared deadline. Each uses one persisted send per part. These are **existential witnesses**, separate from primary checking; neither the empty premise probe nor these bundles supplies a universal progress result.

### Duplicate witness

`witness_duplicates` fails `AtMostOnce` with 10,607 distinct states at depth 34. In [its first fixture](../../tests/fixtures/delivery-traces/witness_duplicates-001.json), the bot reports waiting while actually compacting: the first text/Enter goes into its input queue, whose enqueue is not a receipt. A later empty/waiting read has no receipt and starts a retype at position 25; the queued copy is taken in at 26, the retype commits and types using its saved reading at 27–28, the first take-in is written at 30, and Enter at 33 leads to a second take-in of `<<1,1>>` at 34. Permanent `h.taken` records the duplicate even if compaction removes durable attempt records. This demonstrates why at-least-once permits duplicates; no passing row checks `AtMostOnce`.

`probe_premise` fails `NotPremise` at 13,555 distinct states, depth 29, showing the exact premise can hold. Its primary temporal counterexample is separate from the 67-state nonempty accepted-work witness.

### Restart comparison

The initial five cases in job `j20261015052747-53cc36` each timed out at their then-1,800-second caps with no reported violation. Those counts are incomplete exploration, not passes. The final canonical cases use the separately listed smaller constants, shared projection/constraint and 900-second caps; the difference is not attributable to one field alone.

| Cfg | Initial incomplete distinct | Canonical completed distinct | Canonical seconds |
|---|---:|---:|---:|
| `restart_order` | 29,063,982 | 32,201 | 3.767 |
| `restart_order_across` | 28,127,091 | 61,407 | 5.618 |
| `restart_order_bot` | 44,279,260 | 354,498 | 22.975 |
| `restart_order_enter` | 23,767,844 | 17,416 | 2.469 |
| `restart_order_busy` | 25,912,580 | 214,112 | 18.974 |

The pre-crash case accepts Slack/interject before crash; the across-start case accepts Slack before and cron after start. The bot case isolates new-session restart, and Enter/busy cases isolate their respective selected faults. Crash boundaries remain nondeterministic within admitted prefixes. The larger raw `restart_order_simulation` retains three items and combined server/bot/lost-Enter/busy faults; the five exhaustive split cases do not establish exhaustive combined-fault coverage. The fourteen exact-target companion failures validate sensitivity of the restricted restart checks.

## Trace schema, coverage and runtime handoff

There are 300 genuine fixture JSON files plus `coverage.json`, totaling 25,893,489 bytes. Executed coverage includes all 21 engine actions, 26 bounded faults, four flapping actions (`AgentOwnTurnStart`, `AgentTurnEnd`, `PermissionOpen`, `PermissionAnswer`) and all 38 controls. The 28 simulations provide exactly eight emitted behaviors apiece, 224 total. Coverage comes from executed state differences/edges under proper guards, not merely from cfg fault declarations or enabled actions; identical-text scenarios retain separate items and credit each transcript record once.

TLC emits one `TRACE <json>` line per behavior. Raw schema 1 contains ordered `behavior` records and, for counterexamples, `counterexample.state`/`action` graph endpoints. Every `TraceRecord` includes full state, replay/gate/observation knowledge, choices/selected target, correct choices/target, divergence, constants, timer constants and expiries, executed transition/action/outcome and control class/bug-step. Finite counterexample ALIAS records are preserved; raw temporal/simulation wrappers are projected once by `TraceRecordOf`, including all graph endpoints.

The worker's schema 2 envelope binds raw data to row/spec/cfg, actual mode and simulation parameters, target/description, source hashes and frozen snapshot. Fixture schema 3 is a compact `fixtureContainer` holding exactly one unchanged schema 2 envelope; [rehydrate_fixture](ci/trace_contract.py) supports both schema 3 containers and direct schema 2 inputs. The container records `gzip-base64-json` codec, uncompressed bytes/digest and encoded data, with validation in [local_storage.py](ci/local_storage.py). It preserves the complete raw schema 2 payload, not a lossy trace summary. Decoding a full pass expands about 1.23 GiB, which explains the genuine unit-validation timeout allowance.

Temporal mutation envelopes retain `raw` VIEW evidence separately from `concreteCandidate`, its source binding and `temporalSensitivity` replay/contrast artifacts. Replay uses the declared replay field and complete loop metadata, not a selected prefix or VIEW labels. Core/probe `acceptedWork` bundles preserve raw search/replay evidence and hashes independently. Coverage includes per-row `propertyStatus`, mode, reduction, seeds, jobs and exhaustive classification, plus `coreCoverage`, `acceptedWork`, `restartOrder` and `restartMutations`.

E3 must decode and validate hashes before replay; map knowledge to engine inputs, screens to concrete panes and transcript events to builders; compare normal choices to `EngineChoice`/`GateChoice`, control states to `correctEngineChoice`/`correctGateChoice`; and enforce each control class's sensitivity rule. It must inject the model's retry/timer bounds and fail on action-vocabulary/coverage drift. All code/test/pane/builder mappings in this document remain pending until E3 supplies that runtime conformance test.

## Reproducing submission and notice-driven continuation

Canonical TLC runs on the scheduler with network off, 24 GiB, four CPUs and a four-hour timeout. The pinned jar is a byte-for-byte copy from agent-director revision `2e528eaad12f4b0802e11228ffd0c60deec88bd7`, TLC `2026.09.23.154203`, revision `4260e47`, MIT; see PROVENANCE for source-file digests and adaptations. The manifest has eight columns (`group`, `spec`, `cfg`, `cap_s`, `expect`, `tier`, `what`, `props`); one violation target must match exactly, including normalization of an unnamed temporal violation only for a one-PROPERTY row.

Use a caller-supplied absolute executable `TLA_JOBSCHED` and explicit allow-listed `TLA_CHANNEL`; no channel default exists. From the repository root, replace the scheduler placeholder with its absolute installed path:

```sh
TLA_CHANNEL=C0B1ZJJLJ9M TLA_JOBSCHED=/absolute/path/to/jobsched bun run tla
```

`start` verifies pins and reviewed complete current-source feasibility admission, freezes contexts, runs local SANY parsing/semantic/lint preflight with `tla2sany.SANY -error-codes`, and submits only `core-progress`. It saves the exact command, stdout/stderr, exit and source/jar hashes. SANY is not TLC evidence. The production lock and active-job guard prevent overlapping runs; stage/worker hash maps bind every dependency before execution.

After the owner forwards the terminal notice, use the command printed for that actual pending run/job. A template for one-shot collection is:

```sh
TLA_CHANNEL=C0B1ZJJLJ9M TLA_JOBSCHED=/absolute/path/to/jobsched bash spec/tla/ci/run_ci.sh collect --run-dir /absolute/path/to/run --completed-job jYYYYMMDDHHMMSS-id
```

Then explicitly advance after successful validation:

```sh
TLA_CHANNEL=C0B1ZJJLJ9M TLA_JOBSCHED=/absolute/path/to/jobsched bash spec/tla/ci/run_ci.sh advance --run-dir /absolute/path/to/run
```

Alternatively `resume --run-dir ... --completed-job ...` collects once and advances in the same invocation. Do not poll status/logs, repeat consumed collection or submit a successor before the preceding evidence validates. Do not change pinned inputs mid-run; changed inputs invalidate resume. `failed`, killed, timeout, canceled and checker/storage errors fail closed, and authentic property violations retain their target and full trace.

Each group has at most seven rows, a budget of `sum(cap_s + 20) + 120`, maximum `MAX_BUDGET=14100`, and a 300-second scheduler-limit margin. Run core first (1,940-second group budget), both seven-row restart-mutation groups next (6,560 seconds each), then restart-order (5,640 seconds), then remaining groups in manifest order. All groups must complete anew on the same snapshot.

Only complete `CI-VERDICT PASS` appends a certificate line and exports the validated fixtures. `ci/extract-traces.sh --run-dir /absolute/path/to/run` is the explicit extraction entry point; verification/extraction can replay substantial evidence and should not be used as a cheap status check. `ci/run_ci.sh verify` checks current certification, including original inputs and trace evidence. The certificate pins spec, manifest, cfgs, jar, runner, job image/worker, validators, temporal/accepted-work/storage helpers, profiler and feasibility policy; PROVENANCE itself is also canonical-snapshot input. This README is explanatory, outside that checker input inventory.

Owner-authorized local diagnostics are exploratory only: at most 120 seconds per row, 384 MiB Java heap, one CPU/worker, sequential, with immediate scratch cleanup and compact summaries. They cannot replace canonical scheduler evidence. Keep aggregate `.runs` below 2 GiB; do not retain TLC scratch states, optional JFR/events/DOT dumps or move diagnostics elsewhere to evade the limit. Full required traces remain losslessly compressed and validated.

Settled validation before this documentation pass: 31,499 unit passes, 21 existing skips and zero failures across 157 files (401.51 seconds); the E1 test passed 24/24, including genuine fixtures/relocation (306.262 seconds). Typecheck passed separately (13.917 seconds). The genuine validation test allows 600 seconds for its child process and 605 seconds in Bun; its assertions remain unchanged. The skips are 20 absent-zsh cases and one existing stale-shim regression. Integration is pending after this README pass; these unit/type results do not claim a completed `/ci` run.

## Canonical jobs and per-cfg results

The tables below are transcribed from the frozen manifest/cfgs and collected canonical state, cross-checked with the certificate and coverage. `PASS` means completed checking of all selected properties within that row's admitted domain; `FAIL(target)` is the expected exact counterexample, not a completed exhaustive pass. Temporal failure distinct/depth counts describe the primary state graph, not its liveness tableau or separate concrete candidate. `SIMULATION-OK` is sampled safety only; no exhaustive distinct count is available for simulation. `states checked` is TLC's simulation statistic.

All eight positive exhaustive rows check the eleven safety invariants listed above; only `core_head_taken_in` additionally verifies `HeadTakenIn`. Every `live_*` simulation declares the four temporal properties, all **UNVERIFIED**, while safety and `EmitSimulationTrace` are sampled. Other simulations sample the same eleven safety checks and `EmitSimulationTrace`.

Bounds tuples below are **I/P/L/S/R/E/Q** = `MaxItems` / `MaxParts` / `MaxLaunches` / `MaxServerStarts` / `MaxRetypes` / `EnterRetries` / `MaxAgentQueue`. Flags are **F/P/T** = `Flapping` / `PromptFlapping` / `IdenticalTexts`, written 0/1. Each row lists all seven numeric bounds, all three flags, Scenario, Bug and Faults: together these are the exact thirteen constants. Specification **A** means `Spec` including decision 13; **B** means `SpecWithoutHeadTakeInAssumption`. Scope **VC** means shared VIEW plus constraint; **C** constraint only; **V** VIEW only; **RAW** neither. There is no symmetry. The `cap` and `seconds` columns are separate limits and observations.

| Group | Canonical job ID | Rows | Submitted budget (s) | Result |
|---|---|---:|---:|---|
| `core-progress` | `j20261015221644-0e66af` | 1 | 1,940 | JOB-VERDICT PASS |
| `restart-mutations-1` | `j20261015221739-eb1eb7` | 7 | 6,560 | JOB-VERDICT PASS |
| `restart-mutations-2` | `j20261015221820-b685b4` | 7 | 6,560 | JOB-VERDICT PASS |
| `restart-order` | `j20261015221901-5fa1f3` | 6 | 5,640 | JOB-VERDICT PASS |
| `safety-a` | `j20261015222033-4044b1` | 6 | 11,040 | JOB-VERDICT PASS |
| `safety-b` | `j20261015222203-62f953` | 5 | 9,220 | JOB-VERDICT PASS |
| `liveness-a` | `j20261015222335-fbd604` | 6 | 11,040 | JOB-VERDICT PASS |
| `liveness-b` | `j20261015222513-e5d127` | 5 | 9,220 | JOB-VERDICT PASS |
| `controls-1` | `j20261015222632-6fc104` | 6 | 11,040 | JOB-VERDICT PASS |
| `controls-2` | `j20261015222711-bf9f25` | 6 | 11,040 | JOB-VERDICT PASS |
| `controls-3` | `j20261015222812-ad7b89` | 6 | 11,040 | JOB-VERDICT PASS |
| `controls-4` | `j20261015223159-6e558f` | 5 | 9,220 | JOB-VERDICT PASS |
| `assumption-control` | `j20261015223336-37a1ce` | 1 | 1,940 | JOB-VERDICT PASS |
| `witnesses` | `j20261015223416-511503` | 2 | 3,760 | JOB-VERDICT PASS |
| `traces` | `j20261015223526-3a3415` | 7 | 12,860 | JOB-VERDICT PASS |

Every job used network off, 24 GiB, four CPUs and 14,400-second scheduler timeout; all terminal exits were zero and collection retained untruncated logs. The certificate was written at `2026-10-15T22:43:45.276894+00:00`.

### core-progress

| Cfg | I/P/L/S/R/E/Q | F/P/T | Scenario; Bug | Faults | Spec; scope |
|---|---|---|---|---|---|
| [core_head_taken_in](ci/cfg/core_head_taken_in.cfg) | 1/1/1/2/1/4/2 | 0/1/0 | `probe`; `none` | `{}` | A; C |

| Cfg | Mode / actual result | Distinct | Depth | Seconds / cap | Simulation N/D/S; observed traces; states checked |
|---|---|---:|---:|---:|---|
| `core_head_taken_in` | CHECK / PASS exhaustive | 4,891 | 39 | 4.354 / 1800 | — |

### restart-mutations-1

| Cfg | I/P/L/S/R/E/Q | F/P/T | Scenario; Bug | Faults | Spec; scope |
|---|---|---|---|---|---|
| [restart_control_next_item](ci/cfg/restart_control_next_item.cfg) | 2/2/1/2/1/4/4 | 0/0/0 | `restart-control`; `next_item` | `{}` | B; VC |
| [restart_control_next_part](ci/cfg/restart_control_next_part.cfg) | 2/2/1/2/1/4/4 | 0/0/0 | `restart-control`; `next_part` | `{}` | B; VC |
| [restart_control_send_is_delivery](ci/cfg/restart_control_send_is_delivery.cfg) | 2/2/1/2/1/4/4 | 0/0/0 | `restart-control`; `send_is_delivery` | `{}` | B; VC |
| [restart_control_queue_is_receipt](ci/cfg/restart_control_queue_is_receipt.cfg) | 2/2/1/2/1/4/4 | 0/0/0 | `restart-control`; `queue_is_receipt` | `busyWaiting` | B; VC |
| [restart_control_start_drop](ci/cfg/restart_control_start_drop.cfg) | 2/2/1/2/2/4/6 | 0/0/0 | `restart-control`; `start_drop` | `serverCrash` | B; VC |
| [restart_control_compact_open](ci/cfg/restart_control_compact_open.cfg) | 2/2/1/2/1/4/4 | 0/0/0 | `restart-control`; `compact_open` | `{}` | B; VC |
| [restart_control_early_ack](ci/cfg/restart_control_early_ack.cfg) | 2/2/1/2/1/4/4 | 0/0/0 | `restart-control`; `early_ack` | `{}` | B; VC |

| Cfg | Mode / actual result | Distinct | Depth | Seconds / cap | Simulation N/D/S; observed traces; states checked |
|---|---|---:|---:|---:|---|
| `restart_control_next_item` | CHECK / FAIL(OneInFlight) expected | 937 | 29 | 1.628 / 900 | — |
| `restart_control_next_part` | CHECK / FAIL(OneInFlight) expected | 622 | 27 | 1.722 / 900 | — |
| `restart_control_send_is_delivery` | CHECK / FAIL(ReceiptBacked) expected | 199 | 22 | 1.683 / 900 | — |
| `restart_control_queue_is_receipt` | CHECK / FAIL(TranscriptFIFO) expected | 1,440 | 24 | 1.850 / 900 | — |
| `restart_control_start_drop` | CHECK / FAIL(NoDrop) expected | 569 | 19 | 1.760 / 900 | — |
| `restart_control_compact_open` | CHECK / FAIL(NoDrop) expected | 49 | 9 | 0.728 / 900 | — |
| `restart_control_early_ack` | CHECK / FAIL(DurableAccept) expected | 12 | 8 | 0.590 / 900 | — |

### restart-mutations-2

| Cfg | I/P/L/S/R/E/Q | F/P/T | Scenario; Bug | Faults | Spec; scope |
|---|---|---|---|---|---|
| [restart_control_skip_refused](ci/cfg/restart_control_skip_refused.cfg) | 2/2/1/2/1/4/4 | 0/0/0 | `restart-control`; `skip_refused` | `textRefused` | B; VC |
| [restart_control_start_unsent_head](ci/cfg/restart_control_start_unsent_head.cfg) | 2/2/1/2/2/4/6 | 0/0/0 | `restart-control`; `start_unsent_head` | `serverCrash` | B; VC |
| [restart_control_retype_into_text](ci/cfg/restart_control_retype_into_text.cfg) | 2/2/1/2/2/4/6 | 0/0/0 | `restart-control`; `retype_into_text` | `enterRefused, enterUnknown, lostEnter, busyWaiting, pullBack` | B; VC |
| [restart_control_retype_working](ci/cfg/restart_control_retype_working.cfg) | 2/2/1/2/1/4/4 | 0/0/0 | `restart-control`; `retype_working` | `busyWaiting` | B; VC |
| [restart_control_reconnect_keys](ci/cfg/restart_control_reconnect_keys.cfg) | 2/2/1/2/1/4/4 | 0/0/0 | `restart-control`; `reconnect_keys` | `mcpDrop` | B; VC |
| [restart_control_reconnect_running](ci/cfg/restart_control_reconnect_running.cfg) | 2/2/1/2/1/4/4 | 0/0/0 | `restart-control`; `reconnect_running` | `busyWaiting, mcpDrop` | B; VC |
| [restart_control_duplicate_key](ci/cfg/restart_control_duplicate_key.cfg) | 2/2/1/2/2/4/6 | 0/0/0 | `restart-control`; `duplicate_key` | `serverCrash` | B; VC |

| Cfg | Mode / actual result | Distinct | Depth | Seconds / cap | Simulation N/D/S; observed traces; states checked |
|---|---|---:|---:|---:|---|
| `restart_control_skip_refused` | CHECK / FAIL(InOrder) expected | 1,174 | 28 | 1.722 / 900 | — |
| `restart_control_start_unsent_head` | CHECK / FAIL(InOrder) expected | 4,049 | 28 | 1.821 / 900 | — |
| `restart_control_retype_into_text` | CHECK / FAIL(NoTypeIntoText) expected | 10,416 | 27 | 2.517 / 900 | — |
| `restart_control_retype_working` | CHECK / FAIL(NoRetypeWhileWorking) expected | 2,531 | 26 | 1.909 / 900 | — |
| `restart_control_reconnect_keys` | CHECK / FAIL(GateExclusive) expected | 1,925 | 16 | 1.920 / 900 | — |
| `restart_control_reconnect_running` | CHECK / FAIL(NoTypeIntoText) expected | 85 | 5 | 0.648 / 900 | — |
| `restart_control_duplicate_key` | CHECK / FAIL(NoDuplicateKey) expected | 107 | 9 | 0.821 / 900 | — |

### restart-order

| Cfg | I/P/L/S/R/E/Q | F/P/T | Scenario; Bug | Faults | Spec; scope |
|---|---|---|---|---|---|
| [restart_order](ci/cfg/restart_order.cfg) | 2/2/1/2/2/4/6 | 0/1/0 | `restart-pre`; `none` | `serverCrash` | A; VC |
| [restart_order_across](ci/cfg/restart_order_across.cfg) | 2/2/1/2/2/4/6 | 0/1/0 | `restart-across`; `none` | `serverCrash` | A; VC |
| [restart_order_bot](ci/cfg/restart_order_bot.cfg) | 2/2/2/2/2/4/6 | 0/1/0 | `restart-bot`; `none` | `botRestart` | A; VC |
| [restart_order_enter](ci/cfg/restart_order_enter.cfg) | 2/2/1/2/1/4/4 | 0/1/0 | `restart-enter`; `none` | `lostEnter` | A; VC |
| [restart_order_busy](ci/cfg/restart_order_busy.cfg) | 2/2/1/2/1/4/4 | 0/1/0 | `restart-busy`; `none` | `busyWaiting` | A; VC |
| [restart_order_simulation](ci/cfg/restart_order_simulation.cfg) | 3/2/2/2/3/4/11 | 0/1/0 | `restart-order`; `none` | `botRestart, busyWaiting, lostEnter, serverCrash` | A; RAW |

| Cfg | Mode / actual result | Distinct | Depth | Seconds / cap | Simulation N/D/S; observed traces; states checked |
|---|---|---:|---:|---:|---|
| `restart_order` | CHECK / PASS exhaustive | 32,201 | 82 | 3.767 / 900 | — |
| `restart_order_across` | CHECK / PASS exhaustive | 61,407 | 83 | 5.618 / 900 | — |
| `restart_order_bot` | CHECK / PASS exhaustive | 354,498 | 90 | 22.975 / 900 | — |
| `restart_order_enter` | CHECK / PASS exhaustive | 17,416 | 75 | 2.469 / 900 | — |
| `restart_order_busy` | CHECK / PASS exhaustive | 214,112 | 93 | 18.974 / 900 | — |
| `restart_order_simulation` | RAW SIM / SIMULATION-OK | — | — | 4.001 / 900 | 8/256/111792; 8; 3,103 |

### safety-a

| Cfg | I/P/L/S/R/E/Q | F/P/T | Scenario; Bug | Faults | Spec; scope |
|---|---|---|---|---|---|
| [safety_plain](ci/cfg/safety_plain.cfg) | 2/2/1/2/1/4/4 | 0/1/0 | `safety`; `none` | `{}` | A; VC |
| [safety_calls](ci/cfg/safety_calls.cfg) | 2/2/1/2/2/4/6 | 0/1/0 | `safety`; `none` | `enterRefused, lostEnter, textRefused, textUnknown` | A; RAW |
| [safety_enter_unknown](ci/cfg/safety_enter_unknown.cfg) | 2/2/1/2/1/4/4 | 0/1/0 | `safety`; `none` | `enterUnknown, textRefused` | A; RAW |
| [safety_agent_input](ci/cfg/safety_agent_input.cfg) | 2/2/1/2/3/4/8 | 0/1/0 | `safety`; `none` | `agentDrop, pullBack` | A; VC |
| [safety_bot_resume](ci/cfg/safety_bot_resume.cfg) | 2/2/2/2/3/4/8 | 0/1/0 | `safety`; `none` | `botCrash, botResume` | A; RAW |
| [safety_bot_sessions](ci/cfg/safety_bot_sessions.cfg) | 2/2/3/2/3/4/8 | 0/1/0 | `safety`; `none` | `botRestart, newConversation` | A; RAW |

| Cfg | Mode / actual result | Distinct | Depth | Seconds / cap | Simulation N/D/S; observed traces; states checked |
|---|---|---:|---:|---:|---|
| `safety_plain` | CHECK / PASS exhaustive | 9,279 | 73 | 1.967 / 1800 | — |
| `safety_calls` | RAW SIM / SIMULATION-OK | — | — | 4.138 / 1800 | 8/256/112801; 8; 3,309 |
| `safety_enter_unknown` | RAW SIM / SIMULATION-OK | — | — | 3.596 / 1800 | 8/256/113810; 8; 2,787 |
| `safety_agent_input` | CHECK / PASS exhaustive | 22,113 | 78 | 2.917 / 1800 | — |
| `safety_bot_resume` | RAW SIM / SIMULATION-OK | — | — | 3.595 / 1800 | 8/256/114819; 8; 2,731 |
| `safety_bot_sessions` | RAW SIM / SIMULATION-OK | — | — | 3.592 / 1800 | 8/256/115828; 8; 2,712 |

### safety-b

| Cfg | I/P/L/S/R/E/Q | F/P/T | Scenario; Bug | Faults | Spec; scope |
|---|---|---|---|---|---|
| [safety_storage](ci/cfg/safety_storage.cfg) | 2/2/1/2/3/4/8 | 0/1/0 | `safety`; `none` | `appendFailed, serverCrash, tornAppend` | A; RAW |
| [safety_screen](ci/cfg/safety_screen.cfg) | 2/2/1/2/2/4/6 | 0/1/0 | `safety`; `none` | `busyWaiting, dialogHold, notNow, overlay, unreadable` | A; RAW |
| [safety_connection](ci/cfg/safety_connection.cfg) | 2/2/1/2/1/4/4 | 0/1/0 | `safety`; `none` | `askUser, latchHold, mcpDrop, relayOff, staleRead` | A; RAW |
| [safety_persona](ci/cfg/safety_persona.cfg) | 2/2/1/2/1/4/4 | 0/1/0 | `safety`; `none` | `botCompact, personaRemove` | A; RAW |
| [safety_identical](ci/cfg/safety_identical.cfg) | 2/2/1/2/2/4/6 | 0/1/1 | `safety`; `none` | `busyWaiting, lostEnter, textUnknown` | A; RAW |

| Cfg | Mode / actual result | Distinct | Depth | Seconds / cap | Simulation N/D/S; observed traces; states checked |
|---|---|---:|---:|---:|---|
| `safety_storage` | RAW SIM / SIMULATION-OK | — | — | 3.521 / 1800 | 8/256/116837; 8; 2,772 |
| `safety_screen` | RAW SIM / SIMULATION-OK | — | — | 3.480 / 1800 | 8/256/117846; 8; 2,712 |
| `safety_connection` | RAW SIM / SIMULATION-OK | — | — | 3.590 / 1800 | 8/256/118855; 8; 2,772 |
| `safety_persona` | RAW SIM / SIMULATION-OK | — | — | 3.448 / 1800 | 8/256/119864; 8; 2,745 |
| `safety_identical` | RAW SIM / SIMULATION-OK | — | — | 3.955 / 1800 | 8/256/120873; 8; 3,058 |

### liveness-a

| Cfg | I/P/L/S/R/E/Q | F/P/T | Scenario; Bug | Faults | Spec; scope |
|---|---|---|---|---|---|
| [live_plain](ci/cfg/live_plain.cfg) | 2/2/1/2/1/4/4 | 1/1/0 | `liveness`; `none` | `{}` | A; RAW |
| [live_calls](ci/cfg/live_calls.cfg) | 2/2/1/2/2/4/6 | 1/1/0 | `liveness`; `none` | `enterRefused, lostEnter, textRefused, textUnknown` | A; RAW |
| [live_enter_unknown](ci/cfg/live_enter_unknown.cfg) | 2/2/1/2/1/4/4 | 1/1/0 | `liveness`; `none` | `enterUnknown, textRefused` | A; RAW |
| [live_agent_input](ci/cfg/live_agent_input.cfg) | 2/2/1/2/3/4/8 | 1/1/0 | `liveness`; `none` | `agentDrop, pullBack` | A; RAW |
| [live_bot_resume](ci/cfg/live_bot_resume.cfg) | 2/2/2/2/3/4/8 | 1/1/0 | `liveness`; `none` | `botCrash, botResume` | A; RAW |
| [live_bot_sessions](ci/cfg/live_bot_sessions.cfg) | 2/2/3/2/3/4/8 | 1/1/0 | `liveness`; `none` | `botRestart, newConversation` | A; RAW |

| Cfg | Mode / actual result | Distinct | Depth | Seconds / cap | Simulation N/D/S; observed traces; states checked |
|---|---|---:|---:|---:|---|
| `live_plain` | RAW SIM / SIMULATION-OK; four temporal properties UNVERIFIED | — | — | 5.059 / 1800 | 8/256/121882; 8; 2,608 |
| `live_calls` | RAW SIM / SIMULATION-OK; four temporal properties UNVERIFIED | — | — | 5.070 / 1800 | 8/256/122891; 8; 2,635 |
| `live_enter_unknown` | RAW SIM / SIMULATION-OK; four temporal properties UNVERIFIED | — | — | 5.207 / 1800 | 8/256/123900; 8; 2,587 |
| `live_agent_input` | RAW SIM / SIMULATION-OK; four temporal properties UNVERIFIED | — | — | 5.197 / 1800 | 8/256/124909; 8; 2,542 |
| `live_bot_resume` | RAW SIM / SIMULATION-OK; four temporal properties UNVERIFIED | — | — | 4.051 / 1800 | 8/256/125918; 8; 2,486 |
| `live_bot_sessions` | RAW SIM / SIMULATION-OK; four temporal properties UNVERIFIED | — | — | 4.462 / 1800 | 8/256/126927; 8; 2,558 |

### liveness-b

| Cfg | I/P/L/S/R/E/Q | F/P/T | Scenario; Bug | Faults | Spec; scope |
|---|---|---|---|---|---|
| [live_storage](ci/cfg/live_storage.cfg) | 2/2/1/2/3/4/8 | 1/1/0 | `liveness`; `none` | `appendFailed, serverCrash, tornAppend` | A; RAW |
| [live_screen](ci/cfg/live_screen.cfg) | 2/2/1/2/2/4/6 | 1/1/0 | `liveness`; `none` | `busyWaiting, dialogHold, notNow, overlay, unreadable` | A; RAW |
| [live_connection](ci/cfg/live_connection.cfg) | 2/2/1/2/1/4/4 | 1/1/0 | `liveness`; `none` | `askUser, latchHold, mcpDrop, relayOff, staleRead` | A; RAW |
| [live_persona](ci/cfg/live_persona.cfg) | 2/2/1/2/1/4/4 | 1/1/0 | `liveness`; `none` | `botCompact, personaRemove` | A; RAW |
| [live_empty_reconnect](ci/cfg/live_empty_reconnect.cfg) | 2/2/1/2/3/4/8 | 1/1/0 | `empty-reconnect`; `none` | `overlay, serverCrash` | A; RAW |

| Cfg | Mode / actual result | Distinct | Depth | Seconds / cap | Simulation N/D/S; observed traces; states checked |
|---|---|---:|---:|---:|---|
| `live_storage` | RAW SIM / SIMULATION-OK; four temporal properties UNVERIFIED | — | — | 5.472 / 1800 | 8/256/127936; 8; 2,779 |
| `live_screen` | RAW SIM / SIMULATION-OK; four temporal properties UNVERIFIED | — | — | 5.296 / 1800 | 8/256/128945; 8; 2,730 |
| `live_connection` | RAW SIM / SIMULATION-OK; four temporal properties UNVERIFIED | — | — | 5.516 / 1800 | 8/256/129954; 8; 2,852 |
| `live_persona` | RAW SIM / SIMULATION-OK; four temporal properties UNVERIFIED | — | — | 4.972 / 1800 | 8/256/130963; 8; 2,638 |
| `live_empty_reconnect` | RAW SIM / SIMULATION-OK; four temporal properties UNVERIFIED | — | — | 5.048 / 1800 | 8/256/131972; 8; 2,611 |

### controls-1

| Cfg | I/P/L/S/R/E/Q | F/P/T | Scenario; Bug | Faults | Spec; scope |
|---|---|---|---|---|---|
| [control_next_item](ci/cfg/control_next_item.cfg) | 2/2/3/3/1/4/4 | 0/0/0 | `control`; `next_item` | `{}` | B; RAW |
| [control_next_part](ci/cfg/control_next_part.cfg) | 2/2/3/3/1/4/4 | 0/0/0 | `control`; `next_part` | `{}` | B; RAW |
| [control_send_is_delivery](ci/cfg/control_send_is_delivery.cfg) | 2/2/3/3/1/4/4 | 0/0/0 | `control`; `send_is_delivery` | `{}` | B; RAW |
| [control_queue_is_receipt](ci/cfg/control_queue_is_receipt.cfg) | 2/2/3/3/1/4/4 | 0/0/0 | `control`; `queue_is_receipt` | `busyWaiting` | B; RAW |
| [control_start_drop](ci/cfg/control_start_drop.cfg) | 2/2/3/3/2/4/6 | 0/0/0 | `control`; `start_drop` | `serverCrash` | B; RAW |
| [control_compact_open](ci/cfg/control_compact_open.cfg) | 2/2/3/3/1/4/4 | 0/0/0 | `control`; `compact_open` | `{}` | B; RAW |

| Cfg | Mode / actual result | Distinct | Depth | Seconds / cap | Simulation N/D/S; observed traces; states checked |
|---|---|---:|---:|---:|---|
| `control_next_item` | CHECK / FAIL(OneInFlight) expected | 5,252 | 27 | 1.871 / 1800 | — |
| `control_next_part` | CHECK / FAIL(OneInFlight) expected | 3,100 | 26 | 1.808 / 1800 | — |
| `control_send_is_delivery` | CHECK / FAIL(ReceiptBacked) expected | 495 | 21 | 1.270 / 1800 | — |
| `control_queue_is_receipt` | CHECK / FAIL(TranscriptFIFO) expected | 7,021 | 23 | 2.250 / 1800 | — |
| `control_start_drop` | CHECK / FAIL(NoDrop) expected | 2,277 | 19 | 1.852 / 1800 | — |
| `control_compact_open` | CHECK / FAIL(NoDrop) expected | 63 | 7 | 0.668 / 1800 | — |

### controls-2

| Cfg | I/P/L/S/R/E/Q | F/P/T | Scenario; Bug | Faults | Spec; scope |
|---|---|---|---|---|---|
| [control_early_ack](ci/cfg/control_early_ack.cfg) | 2/2/3/3/1/4/4 | 0/0/0 | `control`; `early_ack` | `{}` | B; RAW |
| [control_skip_refused](ci/cfg/control_skip_refused.cfg) | 2/2/3/3/1/4/4 | 0/0/0 | `control`; `skip_refused` | `textRefused` | B; RAW |
| [control_start_unsent_head](ci/cfg/control_start_unsent_head.cfg) | 2/2/3/3/2/4/6 | 0/0/0 | `control`; `start_unsent_head` | `serverCrash` | B; RAW |
| [control_retype_into_text](ci/cfg/control_retype_into_text.cfg) | 2/2/3/3/1/4/4 | 0/0/0 | `control`; `retype_into_text` | `enterRefused, enterUnknown, lostEnter` | B; V |
| [control_retype_working](ci/cfg/control_retype_working.cfg) | 2/2/3/3/1/4/4 | 0/0/0 | `control`; `retype_working` | `busyWaiting` | B; RAW |
| [control_reconnect_keys](ci/cfg/control_reconnect_keys.cfg) | 2/2/3/3/1/4/4 | 0/0/0 | `control`; `reconnect_keys` | `mcpDrop` | B; RAW |

| Cfg | Mode / actual result | Distinct | Depth | Seconds / cap | Simulation N/D/S; observed traces; states checked |
|---|---|---:|---:|---:|---|
| `control_early_ack` | CHECK / FAIL(DurableAccept) expected | 28 | 7 | 0.607 / 1800 | — |
| `control_skip_refused` | CHECK / FAIL(InOrder) expected | 7,268 | 27 | 2.037 / 1800 | — |
| `control_start_unsent_head` | CHECK / FAIL(InOrder) expected | 34,320 | 28 | 2.874 / 1800 | — |
| `control_retype_into_text` | CHECK / FAIL(NoTypeIntoText) expected | 86,075 | 56 | 7.918 / 1800 | — |
| `control_retype_working` | CHECK / FAIL(NoRetypeWhileWorking) expected | 21,197 | 25 | 2.657 / 1800 | — |
| `control_reconnect_keys` | CHECK / FAIL(GateExclusive) expected | 45,363 | 15 | 3.269 / 1800 | — |

### controls-3

| Cfg | I/P/L/S/R/E/Q | F/P/T | Scenario; Bug | Faults | Spec; scope |
|---|---|---|---|---|---|
| [control_keep_gate](ci/cfg/control_keep_gate.cfg) | 2/2/1/2/1/4/4 | 1/0/0 | `control`; `keep_gate` | `{}` | B; VC |
| [control_hold_gate_mcp_reconnect](ci/cfg/control_hold_gate_mcp_reconnect.cfg) | 2/2/1/2/2/4/6 | 1/0/0 | `control`; `hold_gate_mcp` | `mcpDrop, textUnknown` | B; VC |
| [control_hold_gate_mcp_delivery](ci/cfg/control_hold_gate_mcp_delivery.cfg) | 2/2/1/2/2/4/6 | 1/0/0 | `control`; `hold_gate_mcp` | `mcpDrop, textUnknown` | B; VC |
| [control_no_deferred](ci/cfg/control_no_deferred.cfg) | 2/2/1/2/1/4/4 | 1/0/0 | `control`; `no_deferred` | `mcpDrop` | B; VC |
| [control_reconnect_running](ci/cfg/control_reconnect_running.cfg) | 2/2/3/3/1/4/4 | 0/0/0 | `control`; `reconnect_running` | `busyWaiting, mcpDrop` | B; RAW |
| [control_deferred_only_open](ci/cfg/control_deferred_only_open.cfg) | 2/2/1/2/3/4/8 | 1/0/0 | `empty-reconnect`; `deferred_only_open` | `overlay, serverCrash` | B; VC |

| Cfg | Mode / actual result | Distinct | Depth | Seconds / cap | Simulation N/D/S; observed traces; states checked |
|---|---|---:|---:|---:|---|
| `control_keep_gate` | CHECK / FAIL(GateFreeInfinitelyOften) expected | 365,206 | 66 | 71.220 / 1800 | — |
| `control_hold_gate_mcp_reconnect` | CHECK / FAIL(ReconnectNotBlocked) expected | 12,323 | 24 | 10.299 / 1800 | — |
| `control_hold_gate_mcp_delivery` | CHECK / FAIL(EventuallyDelivered) expected | 228,002 | 40 | 74.064 / 1800 | — |
| `control_no_deferred` | CHECK / FAIL(ReconnectNotBlocked) expected | 11,424 | 29 | 14.375 / 1800 | — |
| `control_reconnect_running` | CHECK / FAIL(NoTypeIntoText) expected | 150 | 5 | 0.599 / 1800 | — |
| `control_deferred_only_open` | CHECK / FAIL(ReconnectNotBlocked) expected | 1,540 | 14 | 4.964 / 1800 | — |

### controls-4

| Cfg | I/P/L/S/R/E/Q | F/P/T | Scenario; Bug | Faults | Spec; scope |
|---|---|---|---|---|---|
| [control_park_retype](ci/cfg/control_park_retype.cfg) | 2/2/1/2/3/4/8 | 1/0/0 | `control`; `park_retype` | `agentDrop, textUnknown` | B; VC |
| [control_unreadable_park](ci/cfg/control_unreadable_park.cfg) | 2/2/1/2/2/4/6 | 1/0/0 | `control`; `unreadable_park` | `textUnknown, unreadable` | B; VC |
| [control_weak_observe](ci/cfg/control_weak_observe.cfg) | 2/2/1/2/1/4/4 | 1/0/0 | `control`; `weak_observe` | `{}` | B; VC |
| [control_replace_observation](ci/cfg/control_replace_observation.cfg) | 2/2/1/2/1/4/4 | 1/0/0 | `control`; `replace_observation` | `{}` | B; VC |
| [control_duplicate_key](ci/cfg/control_duplicate_key.cfg) | 3/2/3/3/2/4/8 | 0/0/0 | `control`; `duplicate_key` | `serverCrash` | B; RAW |

| Cfg | Mode / actual result | Distinct | Depth | Seconds / cap | Simulation N/D/S; observed traces; states checked |
|---|---|---:|---:|---:|---|
| `control_park_retype` | CHECK / FAIL(EventuallyDelivered) expected | 8,552 | 28 | 10.489 / 1800 | — |
| `control_unreadable_park` | CHECK / FAIL(HeadTakenIn) expected | 7,403 | 23 | 10.653 / 1800 | — |
| `control_weak_observe` | CHECK / FAIL(EventuallyDelivered) expected | 6,997 | 31 | 13.312 / 1800 | — |
| `control_replace_observation` | CHECK / FAIL(EventuallyDelivered) expected | 4,343 | 29 | 13.748 / 1800 | — |
| `control_duplicate_key` | CHECK / FAIL(NoDuplicateKey) expected | 231 | 8 | 0.787 / 1800 | — |

### assumption-control

| Cfg | I/P/L/S/R/E/Q | F/P/T | Scenario; Bug | Faults | Spec; scope |
|---|---|---|---|---|---|
| [control_no_head_takein_assumption](ci/cfg/control_no_head_takein_assumption.cfg) | 2/2/1/2/1/4/4 | 1/1/0 | `control-no-assumption`; `none` | `{}` | B; VC |

| Cfg | Mode / actual result | Distinct | Depth | Seconds / cap | Simulation N/D/S; observed traces; states checked |
|---|---|---:|---:|---:|---|
| `control_no_head_takein_assumption` | CHECK / FAIL(HeadTakenIn) expected; EXPECTED-DIAGNOSTIC-COUNTEREXAMPLE | 6,712 | 25 | 5.536 / 1800 | — |

### witnesses

| Cfg | I/P/L/S/R/E/Q | F/P/T | Scenario; Bug | Faults | Spec; scope |
|---|---|---|---|---|---|
| [witness_duplicates](ci/cfg/witness_duplicates.cfg) | 2/2/1/2/1/4/4 | 0/1/0 | `witness`; `none` | `busyWaiting` | A; VC |
| [probe_premise](ci/cfg/probe_premise.cfg) | 2/2/1/2/1/4/4 | 1/1/0 | `probe`; `none` | `{}` | A; VC |

| Cfg | Mode / actual result | Distinct | Depth | Seconds / cap | Simulation N/D/S; observed traces; states checked |
|---|---|---:|---:|---:|---|
| `witness_duplicates` | CHECK / FAIL(AtMostOnce) expected | 10,607 | 34 | 3.744 / 1800 | — |
| `probe_premise` | CHECK / FAIL(NotPremise) expected | 13,555 | 29 | 8.723 / 1800 | — |

### traces

| Cfg | I/P/L/S/R/E/Q | F/P/T | Scenario; Bug | Faults | Spec; scope |
|---|---|---|---|---|---|
| [trace_calls](ci/cfg/trace_calls.cfg) | 3/2/3/3/2/4/8 | 0/1/0 | `trace`; `none` | `enterRefused, enterUnknown, lostEnter, textRefused, textUnknown` | A; RAW |
| [trace_agent](ci/cfg/trace_agent.cfg) | 3/2/3/3/3/4/11 | 0/1/0 | `trace`; `none` | `agentDrop, busyWaiting, pullBack` | A; RAW |
| [trace_lifecycle](ci/cfg/trace_lifecycle.cfg) | 3/2/3/3/5/4/17 | 0/1/0 | `trace`; `none` | `botCompact, botCrash, botRestart, botResume, mcpDrop, newConversation` | A; RAW |
| [trace_storage](ci/cfg/trace_storage.cfg) | 3/2/3/3/3/4/11 | 0/1/0 | `trace`; `none` | `appendFailed, personaRemove, serverCrash, tornAppend` | A; RAW |
| [trace_screen](ci/cfg/trace_screen.cfg) | 3/2/3/3/2/4/8 | 0/1/0 | `trace`; `none` | `askUser, dialogHold, latchHold, notNow, overlay, relayOff, staleRead, unreadable` | A; RAW |
| [trace_flapping](ci/cfg/trace_flapping.cfg) | 3/2/3/3/1/4/5 | 1/1/0 | `trace`; `none` | `busyWaiting, mcpDrop` | A; RAW |
| [trace_identical](ci/cfg/trace_identical.cfg) | 3/2/3/3/2/4/8 | 0/1/1 | `trace`; `none` | `busyWaiting, lostEnter, textUnknown` | A; RAW |

| Cfg | Mode / actual result | Distinct | Depth | Seconds / cap | Simulation N/D/S; observed traces; states checked |
|---|---|---:|---:|---:|---|
| `trace_calls` | RAW SIM / SIMULATION-OK | — | — | 5.922 / 1800 | 8/256/104729; 8; 3,597 |
| `trace_agent` | RAW SIM / SIMULATION-OK | — | — | 4.932 / 1800 | 8/256/105738; 8; 3,148 |
| `trace_lifecycle` | RAW SIM / SIMULATION-OK | — | — | 3.557 / 1800 | 8/256/106747; 8; 3,051 |
| `trace_storage` | RAW SIM / SIMULATION-OK | — | — | 3.859 / 1800 | 8/256/107756; 8; 2,961 |
| `trace_screen` | RAW SIM / SIMULATION-OK | — | — | 3.864 / 1800 | 8/256/108765; 8; 2,963 |
| `trace_flapping` | RAW SIM / SIMULATION-OK | — | — | 3.414 / 1800 | 8/256/109774; 8; 2,664 |
| `trace_identical` | RAW SIM / SIMULATION-OK | — | — | 4.596 / 1800 | 8/256/110783; 8; 3,257 |
