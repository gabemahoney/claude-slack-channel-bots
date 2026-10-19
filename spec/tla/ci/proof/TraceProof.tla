------------------------------ MODULE TraceProof ------------------------------
EXTENDS Naturals, Sequences, TLC, TLCExt, Json

\* Exploratory scheduler-only proof of the pinned jar's structured trace APIs.
\* This module proves no delivery requirements and can never certify E1.
VARIABLE step
vars == <<step>>
Init == step = 0
Next == step' = IF step < 3 THEN step + 1 ELSE step
Spec == Init /\ [][Next]_vars /\ WF_vars(Next)
SafetyProbe == step < 2
TemporalProbe == <>[](step < 3)
\* A single record projection serves ALIAS and both JSON export paths. TLC's
\* temporal CounterExample contains original states, not the console ALIAS.
TraceViewOf(s) == s @@ [EngineChoice |-> IF s.step < 3 THEN "advance" ELSE "wait",
                      GateChoice |-> IF s.step = 0 THEN "free" ELSE "held"]
TraceView == TraceViewOf([step |-> step])
TraceNode(n) == <<n[1], TraceViewOf(n[2])>>
EmitTrace ==
    LET ce == CounterExample
        behavior == ToTrace(ce)
        projected == [state |-> {TraceNode(n) : n \in ce.state},
                      action |-> {<<TraceNode(a[1]), a[2], TraceNode(a[3])>>
                                   : a \in ce.action}]
    IN IF ce.state = {} THEN TRUE ELSE
        PrintT("TRACE " \o ToJson([schema |-> 0,
                                  purpose |-> "pinned-jar-trace-proof",
                                  counterexample |-> projected,
                                  behavior |-> [i \in DOMAIN behavior |-> TraceViewOf(behavior[i])]]))

\* Simulation postconditions run once with no state. Defer this invariant's
\* side effect until TLC chooses the successor at the requested final depth.
\* The probe branches to detect exporting unchosen candidates as extra traces.
SimulationNext == step' \in {step + 1, step + 2}
SimulationSpec == Init /\ [][SimulationNext]_vars
EmitSimulationTrace ==
    IF TLCGet("level") = TLCGet("config").depth + 1
    THEN TLCDefer(
        LET behavior == Trace
        IN PrintT("TRACE " \o ToJson([schema |-> 0,
                                      purpose |-> "pinned-jar-trace-proof",
                                      behavior |-> [i \in DOMAIN behavior |-> TraceViewOf(behavior[i])]])))
    ELSE TRUE
=============================================================================
