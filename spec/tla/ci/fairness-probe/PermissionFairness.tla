-------------------------- MODULE PermissionFairness --------------------------
EXTENDS Naturals, Sequences, TLC, TLCExt, Json

\* DIAGNOSTIC ONLY: a one-persona, one-item, one-part restriction of SR-15.
\* This cannot certify E1 or replace its production suite/bounds. Item names
\* the already durably accepted head; Item=1 is a symmetry-free finite instance.
\* Server/persona/relay/marker/queue are healthy, launch settle has elapsed,
\* MCP stays connected, and the transcript stays readable. No bounded fault
\* occurs: no lost text, overlay, unknown/refused-call fault, or busy-waiting
\* fault is modeled. Permission refusals arise ONLY from the live AD guard
\* during SR-15.3's unbounded, unfair turn/permission flapping. They consume
\* no fault budget, do not increment retypes, and do not change everSent back.
\*
\* Durable appends include fsync atomically. 'attempt' is the latest sent /
\* refused pair; older refused pairs are quotiented away as SR-3.5 compaction
\* permits, with accepted/everSent/delivered retained. Thus indefinitely many
\* refused *first* sends are finite-state, without inventing an attempt limit.
\* There is no crash/append failure here, so splitting append and fsync adds
\* only intermediate steps. A take-in writes its transcript atomically; this
\* restriction preserves the no-take-in refusal counterexample being probed.
\* To focus this diagnostic on refused FIRST TEXT calls, own-turn starts and
\* prompt opens are restricted to before any text has been accepted. There is
\* no bound on their number there. An accepted-text branch instead completes
\* with no new prompt openings; delivery_reachable checks that branch. This
\* is an explicit restriction of allowed environment behavior, not a claim
\* that SR-15 bounds prompt scheduling or that Enter starvation is impossible.
\*
\* EngineObserve freezes a reading until EngineStep consumes it. GateStep
\* uses live knowledge, as the production gate does. EngineChoice is pure
\* and deterministic. Text/Enter inspect permission again at execution:
\* a waiting row reading never bypasses agent-director's live dialog guard.
\* To isolate that race, this diagnostic restricts observation scheduling to
\* EnvTypable moments. Every resulting behavior is still admissible to the
\* unrestricted read action. In particular the fairness action Observe /\
\* EnvTypable has EXACTLY the same enabling. This favors healthy readings;
\* it removes the separate stale-reading starvation lasso. No refusal is
\* forced: the text may still be accepted. The successful-path probe checks
\* that delivery remains reachable in this same transition model.
\* Retry/receipt/Enter-delay durations are finite 0/1 timer abstractions;
\* expiry is an EngineStep, not an added fairness assumption. No retype is
\* needed in this no-loss model: text remains in the box until take-in.
CONSTANT Item
Items == {Item}
Pair == <<Item, 1>>
Pairs == {Pair}
None == <<0, 0>>
VARIABLE st
vars == <<st>>

ReadingOf(s) == [phase |-> s.phase, gate |-> s.gate, request |-> s.request,
  timer |-> s.timer, taken |-> s.taken, made |-> s.made, recovery |-> s.recovery,
  delivered |-> s.delivered, row |-> s.row,
  permission |-> s.permission, mcp |-> s.mcp]
SeedReading == [phase |-> "ready", gate |-> "free", request |-> FALSE,
  timer |-> 0, taken |-> FALSE, made |-> FALSE, recovery |-> FALSE, delivered |-> FALSE,
  row |-> "waiting", permission |-> FALSE, mcp |-> TRUE]
CanType(k) == k.row = "waiting" /\ ~k.permission /\ k.mcp
EngineChoice(k) ==
 CASE k.taken /\ ~k.delivered -> "recordDelivery"
 [] k.phase = "cooldown" -> "expireRetryTimer"
 [] k.phase = "receipt" /\ k.timer > 0 -> "expireReceiptTimer"
 [] k.phase = "receipt" -> "releaseAttempt"
 [] k.phase = "text" -> "typeText"
 [] k.phase = "enter" /\ k.timer > 0 -> "expireEnterTimer"
 [] k.phase = "enter" -> "pressEnter"
 [] k.phase = "recovery-enter" -> "pressEnter"
 [] k.phase = "refused" -> "recordRefusal"
 [] k.phase = "ready" /\ k.gate = "delivery" /\ k.request /\ CanType(k) ->
      IF k.made /\ ~k.recovery THEN "recordRecoveryEnter" ELSE "recordSend"
 [] k.phase = "ready" /\ k.gate = "free" /\ CanType(k) -> "requestGate"
 [] OTHER -> "wait"
GateChoice(k) ==
 CASE k.gate = "free" /\ k.request -> "grantDelivery"
 [] k.gate = "delivery" /\
    (k.phase \in {"cooldown", "done"} \/
     (k.phase \in {"ready"} /\ ~k.request)) -> "releaseDelivery"
 [] OTHER -> "wait"
LiveAcceptsKeys == ~st.permission /\ st.row = "waiting"
EnvTypable == st.actual = "idle" /\ st.row = "waiting" /\ ~st.permission
Work == ~st.delivered \/ st.gate # "free"

Init == st = [accepted |-> Items, acked |-> Items, attempt |-> "none",
  everSent |-> FALSE, delivered |-> FALSE, made |-> FALSE, recovery |-> FALSE, retypes |-> 0,
  phase |-> "ready", timer |-> 0, request |-> FALSE, gate |-> "free",
  observation |-> "none", reading |-> SeedReading, keyReading |-> SeedReading,
  actual |-> "idle", row |-> "waiting", permission |-> FALSE,
  box |-> "empty", submitted |-> FALSE, taken |-> FALSE,
  mcp |-> TRUE, reconnectPending |-> FALSE,
  keySafe |-> TRUE, refusalSeen |-> FALSE,
  transition |-> "Init", action |-> "init", outcome |-> "durably-accepted"]

EngineObserve ==
 /\ Work /\ st.observation = "none" /\ EnvTypable
 /\ st' = [st EXCEPT !.reading = ReadingOf(st), !.observation = "ready",
     !.transition = "EngineObserve", !.action = "observe", !.outcome = "reading"]

EngineStep ==
 /\ Work /\ st.observation = "ready"
 /\ LET choice == EngineChoice(st.reading)
        consumes == [st EXCEPT !.observation = "none",
                      !.transition = "EngineStep", !.action = choice]
    IN st' = CASE
      choice = "requestGate" -> [consumes EXCEPT !.request = TRUE,
                                  !.outcome = "gate-requested"]
   [] choice = "recordSend" -> [consumes EXCEPT !.attempt = "sent",
       !.everSent = TRUE, !.phase = "text", !.request = FALSE, !.recovery = FALSE,
       !.keyReading = st.reading,
       !.outcome = "sent-record-durable"]
   [] choice = "recordRecoveryEnter" -> [consumes EXCEPT !.attempt = "enter",
       !.phase = "recovery-enter", !.request = FALSE,
       !.keyReading = st.reading, !.outcome = "recovery-enter-intent-durable"]
   [] choice = "typeText" ->
       IF LiveAcceptsKeys
       THEN [consumes EXCEPT !.phase = "enter", !.timer = 1,
              !.box = "item", !.made = TRUE,
              !.keySafe = st.gate = "delivery" /\
                          CanType(st.keyReading) /\ ~st.permission,
              !.outcome = "text-accepted"]
       ELSE [consumes EXCEPT !.phase = "refused",
              !.refusalSeen = TRUE, !.outcome = "permission-refused-text"]
   [] choice = "recordRefusal" -> [consumes EXCEPT !.attempt = "refused",
       !.phase = "cooldown", !.timer = 1, !.outcome = "refused-record-durable"]
   [] choice = "expireRetryTimer" -> [consumes EXCEPT !.phase = "ready",
       !.timer = 0, !.outcome = "retry-timer-expired"]
   [] choice \in {"expireEnterTimer", "expireReceiptTimer"} ->
       [consumes EXCEPT !.timer = 0, !.outcome = "timer-expired"]
   [] choice = "releaseAttempt" -> [consumes EXCEPT !.phase = "ready",
       !.request = FALSE, !.outcome = "receipt-wait-ended"]
   [] choice = "pressEnter" ->
       [consumes EXCEPT !.phase = "receipt", !.timer = 1,
         !.recovery = IF st.phase = "recovery-enter" /\ LiveAcceptsKeys THEN TRUE ELSE @,
         !.submitted = IF LiveAcceptsKeys /\ st.box = "item" THEN TRUE ELSE @,
         !.keySafe = IF LiveAcceptsKeys THEN st.gate = "delivery" ELSE @,
         !.outcome = IF LiveAcceptsKeys THEN "enter-accepted" ELSE "permission-refused-enter"]
   [] choice = "recordDelivery" -> [consumes EXCEPT !.delivered = TRUE,
       !.attempt = "delivered", !.phase = "done", !.request = FALSE,
       !.outcome = "receipt-backed-delivered-record-durable"]
   [] OTHER -> [consumes EXCEPT !.outcome = "wait"]

GateStep ==
 /\ GateChoice(ReadingOf(st)) # "wait"
 /\ st' = [st EXCEPT !.gate = IF st.gate = "free" THEN "delivery" ELSE "free",
       !.transition = "GateStep", !.action = GateChoice(ReadingOf(st)),
       !.outcome = "gate-changed"]

\* These are the actual named fairness actions, disabled in the connected
\* restriction, rather than removed fairness conjuncts or a premise on MCP.
ReconnectStep ==
 /\ ~st.mcp /\ st.gate = "free" /\ ~st.reconnectPending
 /\ st.row = "waiting" /\ ~st.permission
 /\ st' = [st EXCEPT !.reconnectPending = TRUE,
       !.transition = "ReconnectStep", !.action = "reconnect", !.outcome = "typed"]
AgentCompletesReconnect ==
 /\ st.reconnectPending /\ ~st.mcp
 /\ st' = [st EXCEPT !.mcp = TRUE, !.reconnectPending = FALSE,
       !.transition = "AgentCompletesReconnect", !.action = "environment",
       !.outcome = "connected"]
AgentTakeIn ==
 /\ st.box = "item" /\ st.submitted /\ st.actual = "idle" /\ ~st.permission
 /\ st' = [st EXCEPT !.box = "empty", !.submitted = FALSE, !.taken = TRUE,
       !.actual = "busy", !.row = "working", !.transition = "AgentTakeIn",
       !.action = "environment", !.outcome = "take-in-transcript-written"]
AgentTurnEnd ==
 /\ st.actual = "busy" /\ ~st.permission
 /\ st' = [st EXCEPT !.actual = "idle", !.row = "waiting",
       !.transition = "AgentTurnEnd", !.action = "environment", !.outcome = "turn-ended"]
AgentOwnTurnStart ==
 /\ st.actual = "idle" /\ ~st.permission /\ ~st.made
 /\ st' = [st EXCEPT !.actual = "busy", !.row = "working",
       !.transition = "AgentOwnTurnStart", !.action = "flapping", !.outcome = "own-turn"]
PermissionOpen ==
 /\ st.actual = "busy" /\ ~st.permission /\ ~st.made
 /\ st' = [st EXCEPT !.permission = TRUE, !.row = "check_permission",
       !.transition = "PermissionOpen", !.action = "flapping", !.outcome = "prompt-open"]
PermissionAnswer ==
 /\ st.permission
 /\ st' = [st EXCEPT !.permission = FALSE, !.row = "working",
       !.transition = "PermissionAnswer", !.action = "flapping", !.outcome = "prompt-answered"]

Next == EngineObserve \/ EngineStep \/ GateStep \/ ReconnectStep \/ AgentTakeIn
        \/ AgentTurnEnd \/ AgentCompletesReconnect \/ AgentOwnTurnStart
        \/ PermissionOpen \/ PermissionAnswer
TranscriptReadable == TRUE
ReconnectsDue == []<>(st.mcp \/ st.reconnectPending)
Premise == []<>EnvTypable /\ <>[]TranscriptReadable /\ ReconnectsDue
ItemDelivered(i) == i = Item /\ st.delivered
HeadPair == IF st.delivered THEN None ELSE Pair
Taken(ip) == ip = Pair /\ st.taken
EventuallyDelivered == Premise =>
    (\A i \in Items : (i \in st.accepted) ~> ItemDelivered(i))
HeadTakenIn == ([]<>EnvTypable /\ ReconnectsDue) =>
    (\A ip \in Pairs : (HeadPair = ip) ~> Taken(ip))
NotPremise == ~Premise
NotDelivered == ~st.delivered

TypeOK ==
 /\ st.accepted = Items /\ st.acked = Items /\ st.retypes = 0
 /\ st.phase \in {"ready", "text", "enter", "recovery-enter", "refused", "cooldown", "receipt", "done"}
 /\ st.attempt \in {"none", "sent", "enter", "refused", "delivered"}
 /\ st.gate \in {"free", "delivery"} /\ st.observation \in {"none", "ready"}
 /\ st.actual \in {"idle", "busy"}
 /\ st.row \in {"waiting", "working", "check_permission"}
 /\ st.box \in {"empty", "item"} /\ st.timer \in 0..1
 /\ \A b \in {st.everSent, st.delivered, st.made, st.recovery, st.request, st.permission,
               st.submitted, st.taken, st.mcp, st.reconnectPending,
               st.keySafe, st.refusalSeen} : b \in BOOLEAN
SafetySanity ==
 /\ st.acked \subseteq st.accepted
 /\ st.delivered => st.taken /\ st.everSent /\ st.made
 /\ st.taken => st.made /\ st.everSent
 /\ st.made => st.box = "item" \/ st.taken
 /\ st.submitted => st.box = "item"
 /\ st.phase = "cooldown" => st.attempt = "refused" /\ ~st.made
 /\ st.keySafe /\ st.mcp /\ ~st.reconnectPending
 /\ (st.permission <=> st.row = "check_permission")
 /\ (st.actual = "idle" <=> st.row = "waiting")

\* Exactly SR-15.3's seven conjuncts; no extra fairness, constraints,
\* forced permission answers, bounded prompt schedule, or accepted-send rule.
Fairness ==
 /\ SF_vars(EngineObserve /\ EnvTypable)
 /\ WF_vars(EngineStep)
 /\ WF_vars(GateStep)
 /\ SF_vars(ReconnectStep)
 /\ SF_vars(AgentTakeIn)
 /\ WF_vars(AgentTurnEnd)
 /\ WF_vars(AgentCompletesReconnect)
Spec == Init /\ [][Next]_vars /\ Fairness

\* Verified pinned-jar TraceProof export pattern: project the ORIGINAL graph
\* nodes as well as ToTrace, retaining the full edge set and closing lasso.
TraceViewOf(s) == s @@ [EngineChoice |-> IF s.st.observation = "ready"
                                      THEN EngineChoice(s.st.reading) ELSE "observe",
                       GateChoice |-> GateChoice(ReadingOf(s.st))]
TraceView == TraceViewOf([st |-> st])
TraceNode(n) == <<n[1], TraceViewOf(n[2])>>
EmitTrace ==
 LET ce == CounterExample
     behavior == ToTrace(ce)
     projected == [state |-> {TraceNode(n) : n \in ce.state},
                   action |-> {<<TraceNode(a[1]), a[2], TraceNode(a[3])>>
                               : a \in ce.action}]
 IN IF ce.state = {} THEN TRUE ELSE
    PrintT("TRACE " \o ToJson([schema |-> 0,
      purpose |-> "DIAGNOSTIC-permission-fairness-not-E1-certification",
      counterexample |-> projected,
      behavior |-> [i \in DOMAIN behavior |-> TraceViewOf(behavior[i])]]))
=============================================================================
