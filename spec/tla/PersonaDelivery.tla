--------------------------- MODULE PersonaDelivery ---------------------------
EXTENDS Naturals, Integers, Sequences, FiniteSets, TLC, TLCExt, Json

\* All I/O is environment state. EngineChoice is a pure function of Knowledge;
\* in particular it cannot consult actual activity, future call outcomes, or a
\* transcript which was not part of the preceding observation.
CONSTANTS MaxItems, MaxParts, MaxLaunches, MaxServerStarts, MaxRetypes,
          EnterRetries, MaxAgentQueue, Faults, Flapping, PromptFlapping, Bug, Scenario,
          IdenticalTexts

Items == 1..MaxItems
Parts == 1..MaxParts
Last(i) == IF i = 1 THEN MaxParts ELSE 1
Pairs == UNION {{<<i,p>> : p \in 1..Last(i)} : i \in Items}
None == <<0,0>>
Rows == {"pending", "waiting", "working", "check_permission", "ask_user",
         "ended", "missing"}
Activities == {"idle", "busy", "compacting"}
Screens == {"empty", "item", "other", "overlay", "running"}
FaultNames == {"lostEnter", "textRefused", "textUnknown", "enterRefused",
 "enterUnknown", "agentDrop", "pullBack", "mcpDrop", "botCrash", "botRestart",
 "botResume", "newConversation", "botCompact", "serverCrash", "tornAppend",
 "appendFailed", "unreadable", "busyWaiting", "notNow", "dialogHold",
 "personaRemove", "overlay", "relayOff", "staleRead", "askUser", "latchHold"}
Budget(f) == IF f \notin Faults THEN 0
             ELSE IF f = "lostEnter" /\ Scenario = "safety" THEN 2 ELSE 1
LossFaults == <<"textUnknown", "agentDrop", "pullBack", "botCrash",
 "botRestart", "botResume", "newConversation", "serverCrash", "tornAppend",
 "overlay">>
RECURSIVE BudgetSum(_)
BudgetSum(fs) == IF Len(fs) = 0 THEN 0
                ELSE Budget(Head(fs)) + BudgetSum(Tail(fs))
UnsubmittedFaults == <<"lostEnter", "enterRefused", "enterUnknown", "textUnknown">>
\* Owner-authorized minimum nonempty core; all other contexts keep >=2 bounds.
SmallCoreBounds ==
 /\ MaxItems = 1 /\ MaxParts = 1 /\ MaxAgentQueue = 2
 /\ MaxLaunches = 1 /\ MaxServerStarts = 2 /\ MaxRetypes = 1
 /\ EnterRetries = 4 /\ Faults = {} /\ ~Flapping /\ PromptFlapping
 /\ Bug = "none" /\ Scenario = "probe" /\ ~IdenticalTexts
ASSUME /\ ((MaxItems >= 2 /\ MaxParts >= 2) \/ SmallCoreBounds)
       /\ MaxLaunches >= 1 /\ MaxServerStarts >= 2
       /\ EnterRetries = 4 /\ EnterRetries >= BudgetSum(UnsubmittedFaults)
       /\ MaxRetypes > BudgetSum(LossFaults)
       /\ MaxAgentQueue >= MaxParts + MaxItems * MaxRetypes
       /\ Faults \subseteq FaultNames
       /\ Flapping \in BOOLEAN /\ PromptFlapping \in BOOLEAN
       /\ IdenticalTexts \in BOOLEAN
\* Assumptions: a returned append is never subsequently torn or corrupted;
\* only an unfinished append can tear. A person's box edits are pull-back,
\* followed by one submit or clear. Stale reads are earlier real row states.
\* Every modeled launch carries tag_prompt=1. No startup-dialog answers or
\* multi-persona acknowledgments are modeled. A busy/waiting box need not imply
\* that an earlier take-in is already in the transcript. The abstract agent is
\* both Claude Code and Codex; Codex's stalled composer is lost Enter and its
\* absence of drop/pull-back records supplies no positive receipt.

TimerNames == {"settle", "receipt", "backoff", "idleEvidence", "enterDelay",
               "notNow", "reconnect"}
TimerConstants == [LAUNCH_SETTLE_MS |-> 1000, RECEIPT_WAIT_MS |-> 10000,
 RETYPE_BACKOFF_MS |-> <<10000,30000,60000,120000,300000,900000>>,
 IDLE_EVIDENCE_MAX_WAIT_MS |-> 120000, ENTER_DELAY_MS |-> 500,
 ENTER_ONLY_RETRY_MS |-> 2000, NOT_NOW_RETRY_MS |-> <<5000,10000,20000,40000,60000>>,
 TAG_MAX_BYTES |-> 1900, FULL_PANE_READ_LINES |-> 40]
ZeroTimers == [t \in TimerNames |-> 0]
Text(ip) == IF IdenticalTexts /\ ip = <<2,1>> THEN <<1,1>> ELSE ip
Min(S) == CHOOSE x \in S : \A y \in S : x <= y
Max(S) == CHOOSE x \in S : \A y \in S : x >= y
SeqSet(q) == {q[n] : n \in 1..Len(q)}
Filter(q, S) == SelectSeq(q, LAMBDA x : x \in S)
PairOf(a) == <<a.item,a.part>>
Record(kind, ip, attempt, how, launch, session, offset, receipt) ==
 [kind |-> kind, item |-> ip[1], part |-> ip[2], attempt |-> attempt,
  how |-> how, launch |-> launch, session |-> session, offset |-> offset,
  receipt |-> receipt]
EmptyWrite == Record("none",None,0,"none",0,0,0,0)
EmptyReading == [row |-> "missing", screen |-> "empty", box |-> None,
 relay |-> TRUE, marker |-> TRUE, mcp |-> FALSE, up |-> TRUE,
 latched |-> FALSE, held |-> FALSE, readable |-> TRUE, receipts |-> {},
 idleEvidence |-> FALSE, launch |-> 0, session |-> 0, compactions |-> 0,
 gate |-> "free", offset |-> 0, records |-> <<>>]
InitialEngine == [phase |-> "ready", target |-> None, attempt |-> 0,
 launchSeen |-> 0, sessionSeen |-> 0, compactionSeen |-> 0, enterRetries |-> 0,
 retypes |-> [i \in Items |-> 0], timers |-> ZeroTimers,
 restartCheck |-> TRUE, receipt |-> 0, lastDelivered |-> None,
 appendBlocked |-> FALSE, noticed |-> {}, request |-> "none", keyReading |-> EmptyReading]
InitialPersistent == [accepted |-> {}, fixed |-> {}, sent |-> <<>>, refused |-> {},
 delivered |-> {}, keys |-> <<>>, records |-> <<>>, torn |-> <<>>]
InitialGate == [owner |-> "free", stage |-> "none", deferred |-> FALSE,
 due |-> FALSE, typed |-> FALSE, reading |-> EmptyReading]
SeedKnowledge == [p |-> InitialPersistent, e |-> InitialEngine,
 r |-> EmptyReading, g |-> InitialGate, writer |-> EmptyWrite,
 bug |-> Bug, started |-> 1, compact |-> "none", acked |-> {}]
VARIABLE st
vars == <<st>>

Sent(i,p) == <<i,p>> \in st.h.everSent
Delivered(i,p) == <<i,p>> \in st.h.everDelivered
ItemDelivered(i) == Delivered(i,Last(i))
InFlight(i) == (\E p \in 1..Last(i) : Sent(i,p)) /\ ~ItemDelivered(i)
Open(p) == {i \in p.accepted : <<i,Last(i)>> \notin p.delivered}
OpenParts(p,i) == {j \in 1..Last(i) : <<i,j>> \notin p.delivered}
HeadOf(p) == IF Open(p) = {} THEN 0 ELSE Min(Open(p))
HeadPair(p) == LET i == HeadOf(p)
              IN IF i = 0 THEN None ELSE <<i,Min(OpenParts(p,i))>>
PriorDelivered(p) == IF p.delivered = {} THEN None
 ELSE CHOOSE ip \in p.delivered : \A jp \in p.delivered :
                   ip[1]*MaxParts+ip[2] >= jp[1]*MaxParts+jp[2]
Made(p,ip) == {n \in 1..Len(p.sent) : PairOf(p.sent[n]) = ip /\
                    n \notin p.refused}
HasSent(p,ip) == Made(p,ip) # {}
NewAttempt(p) == IF Len(p.sent) > 0 /\ Len(p.sent) \in p.refused
                 THEN Len(p.sent) ELSE Len(p.sent)+1
AppendUnique(q,r) == IF r \in SeqSet(q) THEN q ELSE Append(q,r)
AppendSent(p,r) == IF NewAttempt(p) <= Len(p.sent)
                   THEN [p.sent EXCEPT ![NewAttempt(p)] = r] ELSE Append(p.sent,r)
RecoverTorn(p) ==
 IF Len(p.torn) > 0 /\ Head(p.torn).kind = "sent"
 THEN AppendSent(p,[Head(p.torn) EXCEPT !.how = "unknown-torn", !.attempt = NewAttempt(p)])
 ELSE p.sent
RetypesFor(p,i) == Cardinality({n \in 1..Len(p.sent) : n \notin p.refused /\
                                 p.sent[n].item = i /\ p.sent[n].how = "retype"})
\* A latest refused attempt slot may be reused. Its no-key pair is retained
\* in the canonical record set until queue compaction; everSent is permanent.
\* Repeated equal no-key records have the same abstract value. This finite
\* quotient does not bound flapping; its adequacy is a certification obligation.
ReceiptCandidates(p, credited, log) ==
 {n \in 1..Len(log) : n \notin credited /\
   \E ip \in Pairs : ip \notin p.delivered /\ HasSent(p,ip) /\ Text(ip) = log[n].text /\
      n > p.sent[Min(Made(p,ip))].offset /\
      (log[n].kind = "take-in" \/
       (Bug = "queue_is_receipt" /\ log[n].kind = "queue-operation:enqueue"))}
ReadOf(s) == [row |-> s.a.row, screen |-> s.a.screen, box |-> s.a.box,
 relay |-> s.a.relay, marker |-> s.a.marker, mcp |-> s.a.mcp,
 up |-> s.a.up /\ s.a.present, latched |-> s.a.latched,
 held |-> s.a.held, readable |-> s.a.transcript # "unreadable",
 receipts |-> IF s.a.transcript = "unreadable" THEN {}
              ELSE ReceiptCandidates(s.p,s.h.credited,s.a.log),
 idleEvidence |-> s.a.transcript # "unreadable" /\ s.a.tailEnded /\ s.a.input = <<>>,
 launch |-> s.a.launch, session |-> s.a.session, compactions |-> s.a.compactions,
 gate |-> s.g.owner, offset |-> Len(s.a.log),
 \* Stat can supply EOF while contents are unreadable. Preserve only transcript
 \* records already returned by a successful read in that case, including loss
 \* evidence; unreadability never discloses newly appended transcript contents.
 records |-> IF s.a.transcript = "unreadable" THEN s.knowledge.r.records ELSE s.a.log]
ReadEnvironment == ReadOf(st)
KnowledgeOf(s) == [p |-> s.p, e |-> s.e, r |-> ReadOf(s),
 g |-> s.g, writer |-> s.w, bug |-> Bug, started |-> s.starts, compact |-> s.compact, acked |-> s.h.acked]

Knowledge == KnowledgeOf(st)

\* Only external readings are frozen until consumed. Our writer, durable queue,
\* call outcomes, gate ownership and timers remain current even when a failure
\* or gate step happens between EngineObserve and EngineStep. Updating these
\* owned facts never replaces the external observation.
StepKnowledgeOf(s) ==
 [p |-> s.p, e |-> s.e,
  r |-> [s.knowledge.r EXCEPT !.gate = s.g.owner],
  g |-> s.g, writer |-> s.w, bug |-> s.knowledge.bug,
  started |-> s.starts, compact |-> s.compact, acked |-> s.h.acked]
StepKnowledge == StepKnowledgeOf(st)
\* Writer and compaction completions need no bot reading, including an accepted
\* append before the bot is up. Calls and receipt timers finish an owned attempt
\* without waiting for another typable observation. After release, a new call
\* requires a new observation and a new grant.
InternalContinuationOf(s) == s.w.kind # "none" \/
 s.compact \in {"prepared","renamed"} \/
 (s.g.owner = "delivery" /\
  (s.e.request = "granted" \/
   s.e.phase \in {"text","enter","retry","receipt","refused"}))

InternalContinuation == InternalContinuationOf(st)
ReplayKnowledgeOf(s) == IF s.observation = "ready" \/ InternalContinuationOf(s)
                        THEN StepKnowledgeOf(s) ELSE KnowledgeOf(s)

FirstSendGate(r,e) == r.up /\ ~r.latched /\ ~r.held /\ r.marker /\ r.relay /\
 r.mcp /\ r.row \in {"waiting","working"} /\
 r.screen \in {"empty","running"} /\ e.timers.settle = 0
RetypeGate(r,e) == FirstSendGate(r,e) /\ r.row = "waiting" /\
 r.screen = "empty" /\ r.receipts = {} /\ e.timers.backoff = 0 /\
 (r.idleEvidence \/ e.timers.idleEvidence = 0)
ReconnectGate(r) == r.up /\ ~r.latched /\ ~r.held /\ r.relay /\ r.marker /\
 r.screen = "empty" /\ (r.row = "waiting" \/
       (r.row = "working" /\ r.idleEvidence))
OwnText(r,ip) == r.screen = "item" /\ Text(r.box) = Text(ip)
\* A drop or pull-back after the latest non-refused send rules out Enter-only
\* recovery of that copy. Use returned transcript records, never a.person.
\* A later send has a new offset, so old loss evidence does not poison it.
NotTakenIn(k,ip) == HasSent(k.p,ip) /\
 \E n \in 1..Len(k.r.records) :
  n > k.p.sent[Max(Made(k.p,ip))].offset /\
  k.r.records[n].text = Text(ip) /\
  k.r.records[n].kind \in {"queue-operation:remove:dropped_by_hook",
   "queue-operation:remove:cleared_on_cancel",
   "queue-operation:remove:not_carried_to_background",
   "queue-operation:remove:agent_stopped", "queue-operation:remove:resume_failed",
   "queue-operation:popAll", "queue-operation:popOne"}
\* The transcript records returned by the preceding read are frozen in k.r.
FrozenReceipt(k,ip) == {n \in k.r.receipts : k.r.records[n].text = Text(ip) /\
                       n > k.p.sent[Min(Made(k.p,ip))].offset /\
                       (k.r.records[n].kind = "take-in" \/ k.bug = "queue_is_receipt")}
ReadWithRecords == ReadEnvironment
ObservedKnowledge == Knowledge

EngineActions == {"expireTimers", "commitAppend", "observeLaunch", "observeCompaction", "readReceipt",
 "fixText", "recordSend", "typeText", "pressEnter", "recordRefusal",
 "recordEnterRetry", "retryEnter", "releaseAttempt", "requestGate",
 "deferReconnect", "recordNotice", "leftoverEnter", "stopAbsent",
 "compactQueueRename", "compactQueueFinish", "ignoreDuplicate"}
ControlActions == {"discardInflight", "dropOldOpen", "ackBeforeStore",
                   "storeDuplicateKey", "assumeDelivered"}
SelectTarget(k) ==
 LET head == HeadPair(k.p)
     later == {i \in Open(k.p) : i > head[1]}
     unsent == {i \in Open(k.p) : \A p \in 1..Last(i) : ~HasSent(k.p,<<i,p>>)}
 IN IF head = None THEN None
    ELSE IF k.bug \in {"next_item","skip_refused"} /\ later # {} /\
           (HasSent(k.p,head) \/ k.p.refused # {})
         THEN <<Min(later),1>>
    ELSE IF k.bug = "start_unsent_head" /\ k.started > 1 /\ unsent # {}
         THEN <<Min(unsent),1>>
    ELSE IF k.bug = "next_part" /\ head[2] < Last(head[1]) /\ HasSent(k.p,head)
         THEN <<head[1],head[2]+1>> ELSE head
EngineChoice(k) ==
 LET ip == SelectTarget(k)
     receipt == IF ip = None \/ ~HasSent(k.p,ip) THEN {}
                ELSE FrozenReceipt(k,ip)
     retype == ip # None /\ HasSent(k.p,ip)
     retryGate == IF k.bug = "retype_into_text"
                  THEN k.r.up /\ k.r.mcp /\ k.r.row = "waiting"
                  ELSE IF k.bug = "retype_working"
                       THEN FirstSendGate(k.r,k.e) /\ k.r.receipts = {}
                       ELSE RetypeGate(k.r,k.e)
 IN CASE k.bug = "start_drop" /\ k.started > 1 /\ ip # None /\ HasSent(k.p,ip) -> "discardInflight"
 [] k.compact = "prepared" -> IF k.bug = "compact_open" THEN "dropOldOpen" ELSE "compactQueueRename"
 [] k.writer.kind = "accepted" /\ k.writer.how = "slack-redelivery" ->
      IF k.bug = "duplicate_key" THEN "storeDuplicateKey" ELSE "ignoreDuplicate"
 [] k.bug = "early_ack" /\ k.writer.kind = "accepted" /\
    k.writer.item \notin k.acked -> "ackBeforeStore"
 [] k.compact = "renamed" -> "compactQueueFinish"
 [] k.writer.kind # "none" ->
      IF ~k.e.appendBlocked \/ k.e.timers.backoff = 0 THEN "commitAppend"
      ELSE "expireTimers"
 [] ~k.r.up -> "stopAbsent"
 [] k.r.launch # k.e.launchSeen \/ k.r.session # k.e.sessionSeen -> "observeLaunch"
 [] k.r.compactions # k.e.compactionSeen -> "observeCompaction"
 [] k.e.phase = "text" -> IF k.r.gate = "delivery" THEN "typeText"
                            ELSE IF k.r.gate = "free" THEN "requestGate" ELSE "wait"
 [] k.e.phase \in {"enter","retry"} /\ NotTakenIn(k,k.e.target) -> "releaseAttempt"
 [] k.e.phase = "enter" /\ k.e.timers.enterDelay = 0 ->
      IF k.r.gate = "delivery" THEN "pressEnter"
      ELSE IF k.r.gate = "free" THEN "requestGate" ELSE "wait"
 [] k.e.phase = "retry" /\ k.e.timers.enterDelay = 0 ->
      IF k.r.gate = "delivery" THEN "retryEnter"
      ELSE IF k.r.gate = "free" THEN "requestGate" ELSE "wait"
 [] k.e.phase = "refused" -> "recordRefusal"
 [] k.bug = "send_is_delivery" /\ k.e.phase = "receipt" -> "assumeDelivered"
 [] ip # None /\ receipt # {} -> "readReceipt"
 [] k.e.phase = "receipt" /\ k.e.timers.receipt = 0 -> "releaseAttempt"
 [] k.e.phase = "ready" /\ k.e.lastDelivered # None /\ OwnText(k.r,k.e.lastDelivered) /\
    ~NotTakenIn(k,k.e.lastDelivered) /\
    k.r.row \in {"waiting","working"} /\
    k.r.gate \in {"free","delivery"} ->
      IF k.r.gate = "free" THEN "requestGate" ELSE "leftoverEnter"
 [] ip # None /\ ip[1] \notin k.p.fixed -> "fixText"
 [] ip # None /\ k.e.phase = "ready" /\ k.r.row \in {"waiting","working"} /\
    OwnText(k.r,ip) /\ k.e.enterRetries < EnterRetries /\
    ~NotTakenIn(k,ip) /\
    k.e.timers.enterDelay = 0 /\ k.r.gate \in {"free","delivery"} ->
      IF k.r.gate = "free" THEN "requestGate" ELSE "recordEnterRetry"
 [] k.g.deferred /\ ~k.r.mcp /\ k.g.due /\ k.r.gate = "free" -> "deferReconnect"
 [] ip # None /\ k.e.phase = "ready" /\ k.e.timers.notNow = 0 /\
    (IF retype THEN retryGate ELSE FirstSendGate(k.r,k.e)) /\
    (~retype \/ k.e.retypes[ip[1]] < MaxRetypes) /\
    ~(k.bug = "park_retype" /\ k.e.retypes[ip[1]] >= 1) /\
    ~(k.bug = "unreadable_park" /\ ~k.r.readable /\ retype) /\
    ~(k.bug = "hold_gate_mcp" /\ retype /\ ~k.r.mcp) ->
        IF k.r.gate = "delivery" THEN "recordSend" ELSE "requestGate"
 [] k.bug = "hold_gate_mcp" /\ retype /\ ~k.r.mcp /\
    k.r.gate = "free" -> "requestGate"
 [] ip # None /\ retype /\ k.e.retypes[ip[1]] >= 1 /\
    ip[1] \notin k.e.noticed -> "recordNotice"
 [] \E t \in TimerNames : k.e.timers[t] > 0 -> "expireTimers"
 [] OTHER -> "wait"

\* A ready-phase request is only an intention. Revalidate it against the gate
\* controller's current external read before granting or keeping an unused
\* lease. An append of sent, or an active call/receipt wait, already belongs to
\* an attempt and can complete. The MCP-holding mutant deliberately bypasses
\* this validation so its two negative controls retain their meaning.
DeliveryLeaseNeeded(k) ==
 k.e.request = "granted" \/
 k.e.phase \in {"text","enter","retry","receipt"} \/
 k.writer.kind = "sent" \/
 (k.bug = "hold_gate_mcp" /\ ~k.r.mcp /\
  HeadPair(k.p) # None /\ HasSent(k.p,HeadPair(k.p)))
DeliveryOperationReady(k) ==
 EngineChoice([k EXCEPT !.r.gate = "delivery"]) \in
   {"recordSend","recordEnterRetry","leftoverEnter"}
DeliveryLeaseBlocked(k) ==
 k.e.appendBlocked \/ ~k.r.up \/ k.r.latched \/ k.r.held

GateChoice(k) ==
 CASE k.g.owner = "delivery" /\
      DeliveryLeaseBlocked(k) -> "release"
 [] k.bug = "reconnect_keys" /\ k.g.owner = "delivery" /\
      k.g.deferred /\ k.g.due /\ ReconnectGate(k.r) -> "stealForReconnect"
 [] k.g.owner = "delivery" /\ ~DeliveryLeaseNeeded(k) /\
      ~(k.bug = "keep_gate" \/ (k.bug = "hold_gate_mcp" /\ ~k.r.mcp)) -> "release"
 [] k.g.owner = "free" /\ k.e.request = "delivery" ->
      IF (DeliveryLeaseNeeded(k) \/ DeliveryOperationReady(k)) /\ ~DeliveryLeaseBlocked(k)
      THEN "grantDelivery" ELSE "cancelRequest"
 [] k.g.owner = "reconnect" /\ k.g.stage = "done" -> "release"
 [] k.g.owner = "free" /\ k.g.deferred /\ k.g.due /\ ~k.r.mcp /\
      k.bug # "no_deferred" /\
      (k.bug # "deferred_only_open" \/ Open(k.p) # {}) /\
      (IF k.bug = "reconnect_running" THEN
         k.r.screen \in {"empty","running"} /\ k.r.row \in {"waiting","working"}
       ELSE ReconnectGate(k.r)) -> "runReconnect"
 [] OTHER -> "wait"

EngineDecisionDiverges(k) == k.bug \notin {"none","weak_observe","replace_observation"} /\
 (EngineChoice(k) # EngineChoice([k EXCEPT !.bug = "none"]) \/
  (EngineChoice(k) \in {"fixText","recordSend","recordEnterRetry","readReceipt","recordNotice"} /\
   SelectTarget(k) # SelectTarget([k EXCEPT !.bug = "none"])))
GateDecisionDiverges(k) == k.bug \notin {"none","weak_observe","replace_observation"} /\
 GateChoice(k) # GateChoice([k EXCEPT !.bug = "none"])

Init == st = [
 p |-> InitialPersistent,
 e |-> InitialEngine,
 g |-> [InitialGate EXCEPT !.deferred = Scenario = "empty-reconnect",
                         !.due = Scenario = "empty-reconnect"], w |-> EmptyWrite,
 a |-> [row |-> "waiting", earlierRow |-> "waiting", actual |-> "idle",
        screen |-> IF Scenario = "empty-reconnect" THEN "other" ELSE "empty",
        box |-> None, submitted |-> FALSE,
        input |-> <<>>, log |-> <<>>, pending |-> <<>>,
        transcript |-> "readable", relay |-> TRUE, marker |-> TRUE,
        mcp |-> Scenario # "empty-reconnect", present |-> TRUE,
        up |-> TRUE, latched |-> FALSE, held |-> FALSE,
        permission |-> FALSE, overlay |-> FALSE, person |-> Scenario = "empty-reconnect",
        writable |-> TRUE, tailEnded |-> TRUE,
        notNow |-> FALSE, dialogHold |-> FALSE, botAlive |-> TRUE,
        launch |-> 1, session |-> 1, compactions |-> 0, reconnectRunning |-> FALSE],
 h |-> [accepted |-> {}, acked |-> {}, everSent |-> {}, everDelivered |-> {},
        taken |-> <<>>, credited |-> {}, credits |-> <<>>, keys |-> <<>>,
        reconnectDeferred |-> FALSE, reconnectTyped |-> FALSE, compactions |-> 0],
 faults |-> [f \in FaultNames |-> 0], server |-> "up", starts |-> 1,
 observation |-> "none", knowledge |-> SeedKnowledge,
 compact |-> "none", saved |-> <<>>, redelivery |-> FALSE, transition |-> "Init",
 action |-> "none", expired |-> {}, outcome |-> "none", bugStep |-> FALSE]
\* SeedKnowledge supplies an empty external reading until EngineObserve. Only
\* owned storage continuations can use it before the first external observation.

CanFault(f) == st.faults[f] < Budget(f)
HeadRetypes == IF HeadOf(st.p) = 0 THEN 0 ELSE st.e.retypes[HeadOf(st.p)]
CanLose == HeadRetypes < MaxRetypes
Active == st.server = "up" /\ st.a.present
Work == Open(st.p) # {} \/ st.w.kind # "none" \/ st.g.deferred \/
        st.g.owner # "free" \/ st.e.lastDelivered # None \/
        st.compact \in {"prepared","renamed"}
Mark(name,action,outcome,bug) ==
 /\ st'.transition = name /\ st'.action = action
 /\ st'.outcome = outcome /\ st'.expired = {} /\ st'.bugStep = bug

EngineObserve ==
 /\ Active /\ Work
 /\ (st.observation = "none" \/ Bug = "replace_observation")
 \* The request already consumed its read. Complete/cancel the gate handoff
 \* before observing again, so repeated observations cannot starve WF(GateStep).
 /\ (st.e.request # "delivery" \/ st.g.owner # "free" \/ Bug = "replace_observation")
 /\ st' = [st EXCEPT !.knowledge = ObservedKnowledge,
                     !.observation = "ready", !.transition = "EngineObserve",
                     !.action = "observe", !.expired = {}, !.outcome = IF st.observation = "ready" THEN "reading-replaced" ELSE "reading",
                     !.bugStep = FALSE]

StartWrite(r,after) ==
 /\ st.w.kind = "none" /\ st.compact \in {"none","done"}
 /\ st' = [st EXCEPT !.w = r, !.e.phase = after,
                     !.e.keyReading = IF r.kind = "sent" THEN StepKnowledge.r ELSE @,
                     !.e.request = IF r.kind \in {"sent","delivered"} THEN "none" ELSE @,
                     !.observation = "none", !.transition = "EngineStep",
                     !.action = EngineChoice(StepKnowledge), !.expired = {},
                     !.outcome = "append-started", !.bugStep = EngineDecisionDiverges(StepKnowledge)]

CommitAppend ==
 LET r == st.w ip == PairOf(r) n == NewAttempt(st.p)
     ack == IF r.kind = "accepted" THEN {r.item} ELSE {}
     send == IF r.kind = "sent" THEN {ip} ELSE {}
     delivered == IF r.kind = "delivered" THEN {ip} ELSE {}
     credit == IF r.kind = "delivered" /\ r.receipt > 0
               THEN {r.receipt} ELSE {}
 IN /\ r.kind # "none" /\ st.a.writable
    /\ st' = [st EXCEPT
      !.p.records = AppendUnique(@,r),
      !.p.accepted = @ \cup ack,
      !.p.fixed = IF r.kind = "fixed" THEN @ \cup {r.item} ELSE @,
      !.p.sent = IF r.kind = "sent" THEN AppendSent(st.p,r) ELSE @,
      !.p.refused = IF r.kind = "refused" THEN @ \cup {r.attempt}
                   ELSE IF r.kind = "sent" THEN @ \ {n} ELSE @,
      !.p.delivered = @ \cup delivered,
      !.p.keys = IF r.kind = "accepted" /\ r.how \in {"slack","slack-redelivery"}
                 THEN Append(@,IF r.how = "slack-redelivery" THEN 1 ELSE r.item) ELSE @,
      !.h.accepted = @ \cup ack, !.h.acked = @ \cup ack,
      !.h.everSent = @ \cup send, !.h.everDelivered = @ \cup delivered,
      !.h.credited = @ \cup credit,
      !.h.credits = IF r.kind = "delivered" THEN
                     Append(@,[pair |-> ip, record |-> r.receipt]) ELSE @,
      !.e.appendBlocked = FALSE,
      !.e.phase = CASE r.kind = "sent" -> IF r.how = "enter" THEN "retry" ELSE "text"
                 [] r.kind = "refused" -> "ready"
                 [] OTHER -> st.e.phase,
      !.e.target = IF r.kind = "sent" THEN ip ELSE @,
      !.e.attempt = IF r.kind = "sent" THEN n ELSE @,
      !.e.enterRetries = IF r.kind = "sent" /\ r.how = "enter" THEN @+1
                        ELSE IF r.kind = "sent" THEN 0 ELSE @,
      !.e.retypes[r.item] = IF r.kind = "sent" /\ r.how = "retype" THEN @+1
         ELSE IF r.kind = "refused" /\ st.p.sent[r.attempt].how = "retype" THEN @-1 ELSE @,
      !.e.noticed = IF r.kind = "noticed" THEN @ \cup {r.item} ELSE @,
      !.e.lastDelivered = IF r.kind = "delivered" THEN ip
         ELSE IF r.kind = "accepted" /\ Open(st.p) = {} THEN PriorDelivered(st.p) ELSE @,
      !.e.restartCheck = IF r.kind = "delivered" THEN FALSE ELSE @,
      !.e.request = IF r.kind = "sent" THEN "none" ELSE @,
      !.e.timers.receipt = IF r.kind = "sent" THEN 1 ELSE @,
      !.e.timers.backoff = IF r.kind = "sent" THEN 1 ELSE @,
      !.e.timers.idleEvidence = IF r.kind = "sent" THEN 1 ELSE @,
      !.e.timers.enterDelay = IF r.kind = "sent" /\ r.how = "enter" THEN 1 ELSE @,
      !.w = EmptyWrite, !.observation = "none", !.transition = "EngineStep",
      !.action = EngineChoice(StepKnowledge), !.expired = {}, !.outcome = "fsynced-and-returned",
      !.bugStep = EngineDecisionDiverges(StepKnowledge)]

AppendFailure ==
 /\ Active /\ st.w.kind # "none" /\ CanFault("appendFailed")
 /\ st' = [st EXCEPT !.faults["appendFailed"] = @+1,
     !.e.appendBlocked = st.w.kind # "accepted",
     !.w = IF st.w.kind = "accepted" THEN EmptyWrite ELSE @,
     !.a.writable = FALSE, !.e.timers.backoff = 1, !.e.request = "none",
     !.transition = "AppendFailed", !.action = "fault", !.expired = {},
     !.outcome = "queue-unwritable", !.bugStep = FALSE]

QueueWritable ==
 /\ ~st.a.writable
 /\ st' = [st EXCEPT !.a.writable = TRUE, !.transition = "QueueWritable",
     !.action = "environment", !.expired = {}, !.outcome = "writable-again", !.bugStep = FALSE]

Accept ==
 LET i == IF st.h.accepted = {} THEN 1 ELSE 1+Max(st.h.accepted)
     \* b.omv SR-15.5: the across-start case uses two items, so item 2
     \* represents the original post-start cron acceptance, not item 3.
     how == IF i = 1 THEN "slack"
            ELSE IF i = 2 /\ Scenario # "restart-across" THEN "interject"
            ELSE "cron"
 IN /\ Active /\ st.w.kind = "none" /\ st.observation = "none" /\ i \in Items
    /\ st.compact \in {"none","done"}
    /\ (IF Scenario \in {"restart-order", "restart-pre"}
          THEN IF i <= 2 THEN st.starts = 1 ELSE st.starts > 1
          ELSE IF Scenario = "restart-across"
               THEN IF i = 1 THEN st.starts = 1 ELSE st.starts > 1
               ELSE TRUE)
    /\ (Scenario # "empty-reconnect" \/ st.a.mcp)
    /\ st' = [st EXCEPT !.w = Record("accepted",<<i,1>>,0,how,0,0,0,0),
       !.g.deferred = IF how = "slack" /\ ~st.a.mcp THEN TRUE ELSE @,
       !.g.due = IF how = "slack" /\ ~st.a.mcp THEN TRUE ELSE @,
       !.transition = "Accept", !.action = "intake", !.expired = {},
       !.outcome = how, !.bugStep = FALSE]
RedeliverSlack ==
 \* keys is a sequence so NoDuplicateKey can detect repeated persisted keys.
 \* Membership checks its values; a tuple itself is not a TLA+ set.
 /\ Active /\ st.w.kind = "none" /\ st.observation = "none" /\ st.compact \in {"none","done"} /\ 1 \in SeqSet(st.p.keys)
 /\ ~st.redelivery /\ st.starts > 1
 /\ Cardinality(st.h.accepted) < MaxItems
 /\ LET i == Cardinality(st.h.accepted)+1
    IN st' = [st EXCEPT !.w = Record("accepted",<<i,1>>,0,"slack-redelivery",0,0,0,0),
      !.redelivery = TRUE, !.transition = "RedeliverSlack", !.action = "intake", !.expired = {},
      !.outcome = "duplicate-received", !.bugStep = FALSE]

KeyReading(r) == [row |-> r.row, screen |-> r.screen, relay |-> r.relay,
 marker |-> r.marker, mcp |-> r.mcp, up |-> r.up, latched |-> r.latched,
 held |-> r.held, idleEvidence |-> r.idleEvidence]
KeyEvent(kind,owner,r,ip) == [kind |-> kind, owner |-> owner,
 gate |-> st.g.owner, reading |-> KeyReading(r), pair |-> ip,
 missingReceipt |-> r.receipts = {}]
TextAttempt ==
 LET r == st.e.keyReading ip == st.e.target
     how == st.p.sent[st.e.attempt].how
     refuses == st.a.permission \/ st.a.notNow \/ st.a.dialogHold \/
                st.a.row \notin {"waiting","working"}
 IN /\ st.e.phase = "text"
    /\ st.g.owner = "delivery"
    /\ (~st.a.overlay \/ CanLose)
    /\ st' = [st EXCEPT !.e.phase = IF refuses THEN "refused" ELSE "enter", !.e.request = "none",
       !.e.timers.enterDelay = IF refuses THEN 0 ELSE 1,
       !.e.timers.notNow = IF refuses THEN 1 ELSE 0,
       !.a.box = IF refuses \/ st.a.overlay THEN @ ELSE ip,
       !.a.screen = IF refuses \/ st.a.overlay THEN @ ELSE "item",
       !.h.keys = IF refuses THEN @ ELSE Append(@,KeyEvent(how,"delivery",r,ip)),
       !.observation = "none", !.transition = "EngineStep", !.action = "typeText",
       !.expired = {}, !.outcome = IF refuses THEN "refused" ELSE
                                 IF st.a.overlay THEN "done-text-lost" ELSE "done",
       !.bugStep = FALSE]

EnterAttempt(retry) ==
 LET refuses == st.a.permission \/ st.a.notNow \/ st.a.dialogHold
 IN /\ st.e.phase = IF retry THEN "retry" ELSE "enter"
    /\ st.g.owner = "delivery"
    /\ st' = [st EXCEPT !.e.phase = "receipt", !.e.timers.receipt = 1,
       !.e.timers.enterDelay = 1,
       !.e.timers.notNow = IF refuses THEN 1 ELSE @,
       !.a.submitted = IF refuses \/ st.a.box = None THEN @ ELSE TRUE,
       !.h.keys = IF refuses THEN @ ELSE
           Append(@,KeyEvent("enter","delivery",st.e.keyReading,st.e.target)),
       !.observation = "none", !.transition = "EngineStep",
       !.action = IF retry THEN "retryEnter" ELSE "pressEnter", !.expired = {},
       !.outcome = IF refuses THEN "refused" ELSE "done", !.bugStep = FALSE]

QueueCompactRename ==
 /\ Active /\ st.compact = "prepared" /\ st.w.kind = "none"
 /\ LET keep == {r \in SeqSet(st.p.records) : r.item \in Open(st.p) /\
                    ~(r.kind = "refused" \/
                      (r.kind = "sent" /\ r.attempt \in st.p.refused))}
        drop == IF Bug = "compact_open" THEN Open(st.p) ELSE {}
    IN st' = [st EXCEPT !.p.records = Filter(@,keep),
       !.p.accepted = (Open(st.p) \ drop), !.p.fixed = @ \cap (Open(st.p) \ drop),
       !.compact = "renamed", !.observation = "none",
       !.transition = "QueueCompactRename", !.action = EngineChoice(StepKnowledge),
       !.expired = {}, !.outcome = "atomic-rename", !.bugStep = EngineDecisionDiverges(StepKnowledge)]
QueueCompactFinish ==
 /\ Active /\ st.compact = "renamed"
 /\ st' = [st EXCEPT !.compact = "done", !.observation = "none", !.transition = "QueueCompactFinish",
     !.action = "compactQueueFinish", !.expired = {}, !.outcome = "directory-fsynced", !.bugStep = FALSE]

SendIsDelivery ==
 /\ Bug = "send_is_delivery" /\ Active /\ st.e.phase = "receipt"
 /\ st.e.target # None
 /\ st' = [st EXCEPT !.h.everDelivered = @ \cup {st.e.target},
     !.p.delivered = @ \cup {st.e.target},
     !.observation = "none", !.transition = "CountSendAsDelivery", !.action = "assumeDelivered", !.expired = {},
     !.outcome = "unbacked-delivery", !.bugStep = TRUE]

EngineStepSuccessful ==
 /\ Active /\ (st.observation = "ready" \/ InternalContinuation)
 /\ LET k == StepKnowledge choice == EngineChoice(k) ip == SelectTarget(k)
    IN CASE choice \in {"compactQueueRename","dropOldOpen"} -> QueueCompactRename
    [] choice = "assumeDelivered" -> SendIsDelivery
    [] choice = "ackBeforeStore" ->
       st' = [st EXCEPT !.h.acked = @ \cup {st.w.item},
         !.observation = "none", !.transition = "EngineStep", !.action = choice,
         !.expired = {}, !.outcome = "acked-before-fsync", !.bugStep = TRUE]
    [] choice = "discardInflight" ->
       st' = [st EXCEPT !.p.accepted = @ \ {ip[1]},
         !.observation = "none", !.transition = "EngineStep", !.action = choice,
         !.expired = {}, !.outcome = "inflight-discarded", !.bugStep = TRUE]
    [] choice = "ignoreDuplicate" ->
       st' = [st EXCEPT !.w = EmptyWrite, !.observation = "none",
         !.transition = "EngineStep", !.action = choice,
         !.expired = {}, !.outcome = "duplicate-ignored", !.bugStep = FALSE]
    [] choice = "storeDuplicateKey" -> CommitAppend
    [] choice = "compactQueueFinish" -> QueueCompactFinish
    [] choice = "commitAppend" -> CommitAppend
    [] choice = "fixText" -> StartWrite(Record("fixed",ip,0,"none",0,0,0,0),"ready")
    [] choice = "recordSend" ->
       StartWrite(Record("sent",ip,NewAttempt(st.p),
          IF HasSent(k.p,ip) THEN "retype" ELSE "text",
          k.r.launch,k.r.session,k.r.offset,0),"ready")
    [] choice = "recordEnterRetry" ->
       StartWrite(Record("sent",ip,NewAttempt(st.p),"enter",
          k.r.launch,k.r.session,k.r.offset,0),"ready")
    [] choice = "recordRefusal" ->
       StartWrite(Record("refused",st.e.target,st.e.attempt,"none",0,0,0,0),"refused")
    [] choice = "recordNotice" ->
       StartWrite(Record("noticed",ip,0,"none",0,0,0,0),st.e.phase)
    [] choice = "readReceipt" ->
       StartWrite(Record("delivered",ip,0,"none",0,0,0,
                        Min(FrozenReceipt(k,ip))),"ready")
    [] choice = "typeText" -> TextAttempt
    [] choice = "pressEnter" -> EnterAttempt(FALSE)
    [] choice = "retryEnter" -> EnterAttempt(TRUE)
    [] choice = "expireTimers" ->
       st' = [st EXCEPT !.e.timers = [t \in TimerNames |-> IF st.e.timers[t] > 0 THEN st.e.timers[t]-1 ELSE 0],
         !.observation = "none", !.transition = "EngineStep", !.action = choice,
         !.expired = {t \in TimerNames : k.e.timers[t] > 0},
         !.outcome = "timer-expiry", !.bugStep = FALSE]
    [] choice = "observeLaunch" ->
       st' = [st EXCEPT !.e.launchSeen = k.r.launch, !.e.sessionSeen = k.r.session,
         !.e.restartCheck = TRUE, !.e.phase = "ready", !.e.request = "none", !.e.timers.settle = 1,
         !.e.timers.backoff = 0, !.e.enterRetries = 0,
         !.observation = "none", !.transition = "EngineStep", !.action = choice,
         !.expired = {}, !.outcome = "restart-receipt-check", !.bugStep = FALSE]
    [] choice = "observeCompaction" ->
       st' = [st EXCEPT !.e.compactionSeen = k.r.compactions,
         !.e.restartCheck = TRUE, !.observation = "none",
         !.transition = "EngineStep", !.action = choice,
         !.expired = {}, !.outcome = "check-all-sent-transcripts", !.bugStep = FALSE]
    [] choice = "requestGate" ->
       st' = [st EXCEPT !.e.request = "delivery", !.observation = "none",
         !.transition = "EngineStep", !.action = choice, !.expired = {},
         !.outcome = "gate-requested", !.bugStep = EngineDecisionDiverges(StepKnowledge)]
    [] choice = "releaseAttempt" ->
       st' = [st EXCEPT !.e.phase = "ready", !.e.request = "none",
         !.observation = "none", !.transition = "EngineStep", !.action = choice,
         !.expired = {}, !.outcome = "receipt-wait-ended", !.bugStep = FALSE]
    [] choice = "deferReconnect" ->
       st' = [st EXCEPT !.g.deferred = TRUE, !.observation = "none",
         !.transition = "EngineStep", !.action = choice, !.expired = {},
         !.outcome = "rerun-due", !.bugStep = FALSE]
    [] choice = "leftoverEnter" ->
       st' = [st EXCEPT !.e.request = "none", !.e.target = st.e.lastDelivered,
         !.e.phase = "retry", !.e.lastDelivered = None,
         !.observation = "none", !.transition = "EngineStep", !.action = choice,
         !.expired = {}, !.outcome = "leftover-copy", !.bugStep = FALSE]
    [] OTHER -> st' = [st EXCEPT
         !.e.request = IF st.e.request = "granted" THEN "none" ELSE @,
         !.observation = "none", !.transition = "EngineStep",
         !.action = choice, !.expired = {}, !.outcome = "waiting", !.bugStep = FALSE]

GateStep ==
 /\ Active
 /\ LET choice == GateChoice(ObservedKnowledge)
    IN /\ choice \in {"release","grantDelivery","cancelRequest"}
       \* A grant starts a new sequential read only after the prior one was
       \* consumed. Its fresh gate read is the pending operation's snapshot.
       /\ (choice = "grantDelivery" => st.observation = "none")
       /\ st' = [st EXCEPT !.g.owner = IF choice = "grantDelivery" THEN "delivery" ELSE "free",
          !.g.stage = "none",
          !.e.request = IF choice = "grantDelivery" THEN "granted" ELSE "none",
          !.knowledge = IF choice = "grantDelivery" THEN ObservedKnowledge ELSE @,
          !.observation = IF choice = "grantDelivery" THEN "ready" ELSE @,
          !.transition = "GateStep", !.action = choice, !.expired = {},
          !.outcome = "gate-changed", !.bugStep = GateDecisionDiverges(ObservedKnowledge)]

ReconnectStep ==
 /\ Active /\ ~st.a.mcp /\ st.g.deferred /\ st.g.due
 /\ GateChoice(ObservedKnowledge) \in {"runReconnect","stealForReconnect"}
 /\ Bug # "no_deferred"
 /\ (Bug # "deferred_only_open" \/ Open(st.p) # {})
 /\ (st.g.owner = "free" \/ st.g.owner = "reconnect" \/ Bug = "reconnect_keys")
 /\ LET r == ReadEnvironment
        pass == IF Bug = "reconnect_running" THEN
                  r.screen \in {"empty","running"} /\ r.row \in {"waiting","working"}
                ELSE ReconnectGate(r)
    IN /\ pass
       /\ st' = [st EXCEPT !.g.owner = "reconnect", !.g.stage = "done",
          !.g.typed = TRUE, !.g.deferred = FALSE, !.g.due = FALSE,
          !.g.reading = r, !.a.reconnectRunning = TRUE,
          !.h.keys = Append(@,[KeyEvent("reconnect","reconnect",r,None) EXCEPT
                 !.gate = IF st.g.owner = "free" THEN "reconnect" ELSE st.g.owner]),
          !.h.reconnectTyped = TRUE,
          !.transition = "ReconnectStep", !.action = "reconnectTextAndEnter",
          !.expired = {}, !.outcome = "typed", !.bugStep = GateDecisionDiverges(ObservedKnowledge)]
AgentCompletesReconnect ==
 /\ st.a.reconnectRunning
 /\ st' = [st EXCEPT !.a.mcp = TRUE, !.a.reconnectRunning = FALSE,
     !.g.deferred = FALSE, !.g.due = FALSE,
     !.transition = "AgentCompletesReconnect", !.action = "environment",
     !.expired = {}, !.outcome = "connected", !.bugStep = FALSE]
ReconnectDue ==
 /\ Active /\ ~st.a.mcp /\ ~st.g.due
 /\ st' = [st EXCEPT !.g.deferred = TRUE, !.g.due = TRUE, !.g.typed = FALSE,
     !.h.reconnectDeferred = TRUE,
     !.transition = "ReconnectDue", !.action = "health-or-message-or-timer",
     !.expired = {"reconnect"}, !.outcome = "deferred", !.bugStep = FALSE]

TranscriptEvent(kind,ip,taken) == [kind |-> kind, text |-> Text(ip),
 pair |-> ip, session |-> st.a.session, taken |-> taken]
QueueMidTurn ==
 /\ st.a.box # None /\ st.a.submitted /\ st.a.actual # "idle"
 /\ Len(st.a.input) < MaxAgentQueue
 /\ st' = [st EXCEPT !.a.input = Append(@,st.a.box),
     !.a.log = Append(@,TranscriptEvent("queue-operation:enqueue",st.a.box,0)),
     !.a.box = None, !.a.submitted = FALSE, !.a.screen = "running",
     !.transition = "QueueMidTurn", !.action = "environment", !.expired = {},
     !.outcome = "enqueued-not-receipt", !.bugStep = FALSE]
AgentTakeIn ==
 /\ st.a.botAlive /\ ~st.a.permission /\ ~st.a.overlay
 /\ st.a.actual = "idle"
 /\ (Len(st.a.input) > 0 \/ (st.a.box # None /\ st.a.submitted))
 /\ LET fromQueue == Len(st.a.input) > 0
        ip == IF fromQueue THEN Head(st.a.input) ELSE st.a.box
        n == Len(st.h.taken)+1
    IN st' = [st EXCEPT !.a.input = IF fromQueue THEN Tail(@) ELSE @,
       !.a.box = IF fromQueue THEN @ ELSE None,
       !.a.submitted = IF fromQueue THEN @ ELSE FALSE,
       !.a.actual = "busy", !.a.tailEnded = FALSE, !.a.earlierRow = st.a.row, !.a.row = "working",
       !.a.screen = IF fromQueue /\ st.a.box # None THEN "item" ELSE "running",
       !.a.pending = Append(@,TranscriptEvent("take-in",ip,n)),
       !.h.taken = Append(@,ip),
       !.transition = "AgentTakeIn", !.action = "environment", !.expired = {},
       !.outcome = "take-in-not-yet-written", !.bugStep = FALSE]
AgentTurnEnd ==
 /\ st.a.actual \in {"busy","compacting"} /\ ~st.a.permission
 /\ st' = [st EXCEPT !.a.actual = "idle", !.a.tailEnded = TRUE, !.a.earlierRow = st.a.row,
     !.a.row = "waiting", !.a.log = @ \o st.a.pending, !.a.pending = <<>>,
     !.a.screen = IF st.a.overlay THEN "overlay" ELSE
                  IF st.a.box # None THEN "item" ELSE "empty",
     !.transition = "AgentTurnEnd", !.action = "environment", !.expired = {},
     !.outcome = "transcript-written", !.bugStep = FALSE]

\* Flapping is unbounded and unfair; these actions append no history. The
\* permission guard is checked when a key call executes, after EngineObserve.
\* Original mutant cfgs disable only prompt flapping to isolate their bugs
\* from generic permission starvation; their own-turn flapping stays enabled.
\* Positive liveness cfgs and the no-assumption control retain prompt flapping.
AgentOwnTurnStart ==
 /\ Flapping /\ st.a.actual = "idle" /\ st.a.botAlive /\ ~st.a.permission
 /\ st' = [st EXCEPT !.a.actual = "busy", !.a.earlierRow = st.a.row,
     !.a.row = "working", !.a.screen = IF st.a.box = None THEN "running" ELSE "item",
     !.transition = "AgentOwnTurnStart", !.action = "flapping", !.expired = {},
     !.outcome = "turn-started", !.bugStep = FALSE]
PermissionOpen ==
 /\ Flapping /\ PromptFlapping /\ ~st.a.permission /\ st.a.botAlive
 /\ st' = [st EXCEPT !.a.permission = TRUE, !.a.earlierRow = st.a.row,
     !.a.row = "check_permission", !.a.screen = "overlay",
     !.transition = "PermissionOpen", !.action = "flapping", !.expired = {},
     !.outcome = "guard-refuses-keys", !.bugStep = FALSE]
PermissionAnswer ==
 /\ Flapping /\ PromptFlapping /\ st.a.permission
 /\ st' = [st EXCEPT !.a.permission = FALSE, !.a.earlierRow = st.a.row,
     !.a.row = IF st.a.actual = "idle" THEN "waiting" ELSE "working",
     !.a.screen = IF st.a.overlay THEN "overlay" ELSE IF st.a.box # None THEN "item"
                 ELSE IF st.a.actual = "idle" THEN "empty" ELSE "running",
     !.transition = "PermissionAnswer", !.action = "flapping", !.expired = {},
     !.outcome = "answered", !.bugStep = FALSE]

CallFault(f) ==
 /\ Active /\ CanFault(f)
 /\ st.g.owner = "delivery"
 /\ (IF f \in {"textRefused","textUnknown"} THEN st.e.phase = "text"
     ELSE st.e.phase \in {"enter","retry"})
 /\ (f # "textUnknown" \/ CanLose)
 /\ LET text == f \in {"textRefused","textUnknown"}
        unknown == f \in {"textUnknown","enterUnknown"}
    IN \E typed \in BOOLEAN :
       /\ (~unknown => ~typed)
       /\ st' = [st EXCEPT !.faults[f] = @+1,
          !.e.phase = IF f = "textRefused" THEN "refused" ELSE "receipt",
          !.e.timers.receipt = 1, !.e.timers.notNow = 1,
          !.a.box = IF text /\ typed /\ ~st.a.overlay THEN st.e.target ELSE @,
          !.a.screen = IF text /\ typed /\ ~st.a.overlay THEN "item" ELSE @,
          !.a.submitted = IF ~text /\ typed /\ st.a.box # None THEN TRUE ELSE @,
          !.h.keys = IF typed THEN Append(@,KeyEvent(
                 IF text THEN st.p.sent[st.e.attempt].how ELSE "enter",
                 "delivery",st.e.keyReading,st.e.target)) ELSE @,
          !.observation = "none", !.transition = "EngineStep",
          !.action = IF text THEN "typeText" ELSE
                     IF st.e.phase = "retry" THEN "retryEnter" ELSE "pressEnter",
          !.expired = {}, !.outcome = f, !.bugStep = FALSE]
LostEnter ==
 /\ Active /\ CanFault("lostEnter") /\ st.e.phase \in {"enter","retry"}
 /\ st.g.owner = "delivery"
 /\ st' = [st EXCEPT !.faults["lostEnter"] = @+1,
     !.e.phase = "receipt", !.e.timers.receipt = 1,
     !.h.keys = Append(@,KeyEvent("enter","delivery",st.e.keyReading,st.e.target)),
     !.observation = "none", !.transition = "LostEnter",
     !.action = IF st.e.phase = "retry" THEN "retryEnter" ELSE "pressEnter",
     !.expired = {}, !.outcome = "done-enter-lost", !.bugStep = FALSE]

AgentDrop ==
 /\ CanFault("agentDrop") /\ CanLose
 /\ st.a.box # None \/ Len(st.a.input) > 0
 /\ LET ip == IF st.a.box # None THEN st.a.box ELSE Head(st.a.input)
    IN st' = [st EXCEPT !.faults["agentDrop"] = @+1,
       !.a.box = None, !.a.input = <<>>, !.a.submitted = FALSE,
       !.a.screen = IF st.a.actual = "idle" THEN "empty" ELSE "running",
       !.a.log = Append(@,TranscriptEvent("queue-operation:remove:dropped_by_hook",ip,0)),
       !.transition = "AgentDrop", !.action = "fault", !.expired = {},
       !.outcome = "not-taken-in", !.bugStep = FALSE]
PullBack ==
 /\ CanFault("pullBack") /\ CanLose /\ ~st.a.person
 /\ Len(st.a.input) > 0
 /\ st' = [st EXCEPT !.faults["pullBack"] = @+1,
     !.a.box = Head(st.a.input), !.a.input = Tail(@), !.a.submitted = FALSE,
     !.a.person = TRUE, !.a.screen = "item",
     !.a.log = Append(@,TranscriptEvent("queue-operation:popOne",Head(st.a.input),0)),
     !.transition = "PullBack", !.action = "fault", !.expired = {},
     !.outcome = "person-holds-copy", !.bugStep = FALSE]
PersonBox(submit) ==
 /\ st.a.person
 /\ (submit \/ CanLose) /\ (~submit \/ st.a.box # None)
 /\ st' = [st EXCEPT !.a.person = FALSE,
     !.a.submitted = submit,
     !.a.box = IF submit THEN @ ELSE None,
     !.a.screen = IF submit THEN "item" ELSE
                  IF st.a.actual = "idle" THEN "empty" ELSE "running",
     !.transition = IF submit THEN "PersonSubmit" ELSE "PersonClear",
     !.action = "environment", !.expired = {}, !.outcome = "person-finished",
     !.bugStep = FALSE]

MCPDrop ==
 /\ CanFault("mcpDrop") /\ st.a.mcp
 /\ st' = [st EXCEPT !.faults["mcpDrop"] = @+1, !.a.mcp = FALSE,
     !.g.deferred = TRUE, !.g.due = TRUE, !.g.typed = FALSE, !.h.reconnectDeferred = TRUE,
     !.transition = "MCPDrop", !.action = "fault", !.expired = {},
     !.outcome = "disconnected", !.bugStep = FALSE]
OverlayOpen ==
 /\ CanFault("overlay") /\ CanLose /\ ~st.a.overlay
 /\ st' = [st EXCEPT !.faults["overlay"] = @+1,
     !.a.overlay = TRUE, !.a.screen = "overlay",
     !.transition = "OverlayOpen", !.action = "fault", !.expired = {},
     !.outcome = "overlay-open", !.bugStep = FALSE]
OverlayClose ==
 /\ st.a.overlay
 /\ st' = [st EXCEPT !.a.overlay = FALSE,
     !.a.screen = IF st.a.permission THEN "overlay" ELSE IF st.a.box # None THEN "item"
                 ELSE IF st.a.actual = "idle" THEN "empty" ELSE "running",
     !.transition = "OverlayClose", !.action = "environment", !.expired = {},
     !.outcome = "overlay-closed", !.bugStep = FALSE]
Unreadable ==
 /\ CanFault("unreadable") /\ st.a.transcript # "unreadable"
 /\ st' = [st EXCEPT !.faults["unreadable"] = @+1,
     !.a.transcript = "unreadable", !.transition = "TranscriptUnreadable",
     !.action = "fault", !.expired = {}, !.outcome = "unreadable", !.bugStep = FALSE]
Readable ==
 /\ st.a.transcript = "unreadable"
 /\ st' = [st EXCEPT !.a.transcript = "readable", !.transition = "TranscriptReadable",
     !.action = "environment", !.expired = {}, !.outcome = "readable", !.bugStep = FALSE]
BusyWaiting ==
 /\ CanFault("busyWaiting") /\ st.a.botAlive /\ ~st.a.permission
 /\ st' = [st EXCEPT !.faults["busyWaiting"] = @+1,
     !.a.actual = "compacting", !.a.earlierRow = st.a.row, !.a.row = "waiting",
     !.a.screen = IF st.a.box = None THEN "running" ELSE "item",
     !.transition = "BusyWhileWaiting", !.action = "fault", !.expired = {},
     !.outcome = "reported-waiting-actually-compacting", !.bugStep = FALSE]
StaleRead ==
 /\ Active /\ CanFault("staleRead") /\ st.observation = "none" /\ Work
 /\ st' = [st EXCEPT !.faults["staleRead"] = @+1,
     !.knowledge = [ObservedKnowledge EXCEPT !.r.row = st.a.earlierRow],
     !.observation = "ready", !.transition = "StaleRead", !.action = "observe",
     !.expired = {}, !.outcome = "earlier-reported-state", !.bugStep = FALSE]

Spell(f,on) ==
 /\ (IF on THEN CanFault(f) ELSE
       CASE f = "notNow" -> st.a.notNow
         [] f = "dialogHold" -> st.a.dialogHold
         [] f = "relayOff" -> ~st.a.relay
         [] f = "askUser" -> st.a.row = "ask_user"
         [] OTHER -> st.a.latched \/ st.a.held)
 /\ st' = [st EXCEPT !.faults[f] = IF on THEN @+1 ELSE @,
     !.a.notNow = IF f = "notNow" THEN on ELSE @,
     !.a.dialogHold = IF f = "dialogHold" THEN on ELSE @,
     !.a.relay = IF f = "relayOff" THEN ~on ELSE @,
     !.a.latched = IF f = "latchHold" THEN on ELSE @,
     !.a.held = IF f = "latchHold" THEN on ELSE @,
     !.a.earlierRow = IF f = "askUser" THEN st.a.row ELSE @,
     !.a.row = IF f = "askUser" THEN IF on THEN "ask_user" ELSE "waiting" ELSE @,
     !.transition = IF on THEN "SpellBegin:" \o f ELSE "SpellEnd:" \o f,
     !.action = IF on THEN "fault" ELSE "environment", !.expired = {},
     !.outcome = f, !.bugStep = FALSE]

BotCrash ==
 /\ CanFault("botCrash") /\ CanLose /\ st.a.botAlive
 /\ st' = [st EXCEPT !.faults["botCrash"] = @+1,
     !.a.botAlive = FALSE, !.a.up = FALSE, !.a.actual = "idle", !.a.earlierRow = st.a.row,
     !.a.row = IF st.a.launch % 2 = 0 THEN "missing" ELSE "ended", !.a.box = None, !.a.input = <<>>, !.a.submitted = FALSE,
     !.a.screen = "empty", !.a.mcp = FALSE, !.a.reconnectRunning = FALSE,
     !.transition = "BotCrash", !.action = "fault", !.expired = {},
     !.outcome = "ended", !.bugStep = FALSE]
BotLife(f) ==
 /\ CanFault(f) /\ CanLose /\ st.a.launch < MaxLaunches
 /\ (f # "botResume" \/ ~st.a.botAlive)
 /\ st' = [st EXCEPT !.faults[f] = @+1,
     !.a.launch = @+1,
     !.a.session = IF f = "botResume" THEN @ ELSE @+1,
     !.a.botAlive = TRUE, !.a.up = FALSE, !.a.actual = "idle", !.a.tailEnded = FALSE, !.a.earlierRow = st.a.row,
     !.a.row = "pending", !.a.box = None, !.a.input = <<>>, !.a.submitted = FALSE,
     !.a.screen = "empty", !.a.mcp = FALSE, !.a.reconnectRunning = FALSE,
     !.a.transcript = IF f = "botResume" THEN @ ELSE "not-yet-written",
     !.g.deferred = TRUE, !.g.due = TRUE, !.g.typed = FALSE, !.h.reconnectDeferred = TRUE,
     !.transition = CASE f = "botRestart" -> "BotRestart" [] f = "botResume" -> "BotResume"
                    [] OTHER -> "NewConversation",
     !.action = "fault", !.expired = {}, !.outcome = "launch-pending", !.bugStep = FALSE]
BotReady ==
 /\ st.a.botAlive /\ st.a.row = "pending"
 /\ st' = [st EXCEPT !.a.earlierRow = "pending", !.a.row = "waiting", !.a.up = TRUE, !.a.tailEnded = TRUE,
     !.a.transcript = IF @ = "not-yet-written" THEN "readable" ELSE @,
     !.transition = "BotReady", !.action = "environment", !.expired = {},
     !.outcome = "launch-ready", !.bugStep = FALSE]
BotCompaction ==
 /\ CanFault("botCompact") /\ st.a.botAlive
 /\ st' = [st EXCEPT !.faults["botCompact"] = @+1,
     !.a.actual = "compacting", !.a.earlierRow = st.a.row, !.a.row = "waiting",
     !.a.compactions = @+1,
     !.transition = "BotCompaction", !.action = "fault", !.expired = {},
     !.outcome = "prior-transcripts-kept", !.bugStep = FALSE]

ServerCrash ==
 /\ st.server = "up" /\ CanFault("serverCrash") /\ CanLose
 /\ st.starts < MaxServerStarts
 \* These guards scope acceptance counts only. No attempt/receipt/compaction
 \* phase is excluded: every crash boundary remains nondeterministic.
 /\ (IF Scenario \in {"restart-order", "restart-pre"}
       THEN {1,2} \subseteq st.h.accepted
       ELSE IF Scenario = "restart-across" THEN 1 \in st.h.accepted ELSE TRUE)
 /\ st' = [st EXCEPT !.faults["serverCrash"] = @+1,
     !.server = "crashed", !.e = InitialEngine, !.g = InitialGate,
     !.w = EmptyWrite, !.observation = "none",
     !.compact = IF @ = "prepared" THEN "none" ELSE @,
     !.transition = "ServerCrash", !.action = "fault", !.expired = {},
     !.outcome = "durable-records-and-history-kept", !.bugStep = FALSE]
TornAppend ==
 /\ Active /\ st.w.kind # "none" /\ CanFault("tornAppend") /\ CanLose
 /\ st.starts < MaxServerStarts
 /\ st' = [st EXCEPT !.faults["tornAppend"] = @+1,
     !.p.torn = Append(@,st.w), !.server = "crashed", !.w = EmptyWrite,
     !.e = InitialEngine, !.g = InitialGate, !.observation = "none",
     !.transition = "TornAppend", !.action = "fault", !.expired = {},
     !.outcome = "unfinished-record-quarantined-on-start", !.bugStep = FALSE]
ServerStart ==
 /\ st.server = "crashed" /\ st.starts < MaxServerStarts
 /\ LET drop == {}
    IN st' = [st EXCEPT !.server = "up", !.starts = @+1,
       !.p.accepted = @ \ drop,
       !.p.sent = RecoverTorn(st.p),
       !.p.refused = IF Len(st.p.torn) > 0 /\ Head(st.p.torn).kind = "sent"
                    THEN @ \ {NewAttempt(st.p)} ELSE @,
       !.e = [InitialEngine EXCEPT !.retypes = [i \in Items |-> RetypesFor(st.p,i)],
                  !.lastDelivered = IF Open(st.p) = {} THEN None ELSE PriorDelivered(st.p)],
       !.g = [InitialGate EXCEPT !.deferred = ~st.a.mcp, !.due = ~st.a.mcp],
       !.h.reconnectDeferred = @ \/ ~st.a.mcp,
       !.saved = @ \o st.p.torn, !.p.torn = <<>>, !.compact = "none",
       !.observation = "none", !.transition = "ServerStart", !.action = "environment",
       !.expired = {"settle","backoff"}, !.outcome = "recovered",
       !.bugStep = FALSE]
PersonaRemove ==
 /\ Active /\ CanFault("personaRemove") /\ CanLose
 /\ st' = [st EXCEPT !.faults["personaRemove"] = @+1,
     !.a.present = FALSE, !.e = InitialEngine, !.g = InitialGate, !.w = EmptyWrite,
     !.observation = "none", !.transition = "PersonaRemove", !.action = "fault",
     !.expired = {}, !.outcome = "queue-kept", !.bugStep = FALSE]
PersonaReadd ==
 /\ st.server = "up" /\ ~st.a.present
 /\ st' = [st EXCEPT !.a.present = TRUE,
     !.e = [InitialEngine EXCEPT !.retypes = [i \in Items |-> RetypesFor(st.p,i)],
                  !.lastDelivered = IF Open(st.p) = {} THEN None ELSE PriorDelivered(st.p)],
     !.g = [InitialGate EXCEPT !.deferred = ~st.a.mcp, !.due = ~st.a.mcp],
     !.observation = "none", !.transition = "PersonaReadd", !.action = "environment",
     !.expired = {"settle","backoff"}, !.outcome = "start-as-recovery", !.bugStep = FALSE]

\* Queue compaction has one prepare/rename/directory-fsync cycle. Only rename
\* changes the authoritative file. A crash on either side is a separate step.
QueueCompactPrepare ==
 /\ Active /\ st.compact = "none" /\ st.w.kind = "none"
 /\ st.observation = "none" /\ st.h.compactions < 1
 /\ st' = [st EXCEPT !.compact = "prepared", !.h.compactions = @+1,
     !.transition = "QueueCompactPrepare", !.action = "writer", !.expired = {},
     !.outcome = "temp-fsynced", !.bugStep = FALSE]


Done ==
 /\ ~Flapping /\ st.server = "up"
 /\ \A i \in st.h.accepted : ItemDelivered(i)
 /\ st' = [st EXCEPT !.transition = "Done", !.action = "stutter",
     !.expired = {}, !.outcome = "complete", !.bugStep = FALSE]

Environment ==
 \/ Accept \/ RedeliverSlack \/ AppendFailure \/ QueueWritable
 \/ QueueMidTurn \/ AgentTakeIn \/ AgentTurnEnd \/ AgentCompletesReconnect
 \/ ReconnectDue \/ AgentDrop \/ PullBack \/ PersonBox(TRUE) \/ PersonBox(FALSE)
 \/ MCPDrop \/ OverlayOpen \/ OverlayClose \/ Unreadable \/ Readable
 \/ BusyWaiting \/ StaleRead \/ BotCrash \/ BotLife("botRestart")
 \/ BotLife("botResume") \/ BotLife("newConversation") \/ BotReady \/ BotCompaction
 \/ ServerCrash \/ TornAppend \/ ServerStart \/ PersonaRemove \/ PersonaReadd
 \/ QueueCompactPrepare
 \/ \E f \in {"notNow","dialogHold","relayOff","askUser","latchHold"} :
       Spell(f,TRUE) \/ Spell(f,FALSE)
 \/ AgentOwnTurnStart \/ PermissionOpen \/ PermissionAnswer
 
\* Text/Enter outcomes are alternatives of the one sequential engine step;
\* none is allowed to consume a reading before EngineChoice selects that call.
EngineCallFault ==
 /\ (st.observation = "ready" \/ InternalContinuation)
 /\ EngineChoice(StepKnowledge) \in {"typeText","pressEnter","retryEnter"}
 /\ (LostEnter \/ \E f \in {"textRefused","textUnknown","enterRefused","enterUnknown"} : CallFault(f))
EngineStep == EngineStepSuccessful \/ EngineCallFault
Next == EngineObserve \/ EngineStep \/ GateStep \/ ReconnectStep
        \/ Environment \/ Done

EnvTypable == st.server = "up" /\ st.a.present /\ st.a.up /\
 ~st.a.latched /\ ~st.a.held /\ st.a.actual = "idle" /\ st.a.row = "waiting" /\
 st.a.relay /\ ~st.a.overlay /\ ~st.a.permission /\ ~st.a.person /\
 st.a.screen \in {"empty","item"} /\ ~st.a.notNow /\ ~st.a.dialogHold /\
 st.a.writable
TranscriptReadable == st.a.transcript # "unreadable"
ReconnectsDue == []<>(st.a.mcp \/ st.g.due)
Premise == []<>EnvTypable /\ <>[]TranscriptReadable /\ ReconnectsDue
EventuallyDelivered == Premise =>
                      (\A i \in Items : (i \in st.h.accepted) ~> ItemDelivered(i))
Taken(ip) == \E n \in 1..Len(st.a.log) : st.a.log[n].kind = "take-in" /\
              st.a.log[n].text = Text(ip) /\ HasSent(st.p,ip) /\
              n > st.p.sent[Min(Made(st.p,ip))].offset
\* ASSUME (owner decision 13): recurrent typability of a particular head part
\* entails eventual take-in. This is an explicit temporal environment premise,
\* including acceptance opportunities before text has reached the box. Merely
\* repeating SF(AgentTakeIn) would be vacuous when every text call is refused.
\* TLA+'s ASSUME declaration accepts constant formulas, so this dynamic ASSUME
\* is legally conjoined in Spec instead. It is absent from the raw control Spec.
TypableHeadTakeInAssumption == \A ip \in Pairs :
 ([]<>(HeadPair(st.p) = ip /\ EnvTypable)) => []<>Taken(ip)
HeadTakenIn == ([]<>EnvTypable /\ ReconnectsDue) =>
              (\A ip \in Pairs : (HeadPair(st.p) = ip) ~> Taken(ip))
ReconnectNotBlocked == ([]<>EnvTypable) =>
                        (st.g.deferred ~> (st.g.typed \/ st.a.mcp))
GateFreeInfinitelyOften == []<>(st.g.owner = "free")
NotPremise == ~Premise

DurableAccept == st.h.acked \subseteq st.h.accepted
NoDrop == \A i \in st.h.acked : i \in st.p.accepted \/ ItemDelivered(i)
ReceiptBacked ==
 /\ (\A c \in SeqSet(st.h.credits) :
      c.record \in 1..Len(st.a.log) /\ st.a.log[c.record].kind = "take-in" /\
      Text(c.pair) = st.a.log[c.record].text /\
      HasSent(st.p,c.pair) /\
      c.record > st.p.sent[Min(Made(st.p,c.pair))].offset)
 /\ st.h.everDelivered = {c.pair : c \in SeqSet(st.h.credits)}
InOrder == \A i,j \in st.h.accepted : i < j =>
                ((\E p \in 1..Last(j) : Sent(j,p)) => ItemDelivered(i))
TranscriptFIFO == \A n \in 1..Len(st.h.credits) :
 LET c == st.h.credits[n]
 IN /\ c.record \in 1..Len(st.a.log)
    /\ st.a.log[c.record].kind = "take-in"
    /\ (c.pair[2] > 1 =>
         \E m \in 1..(n-1) : st.h.credits[m].pair = <<c.pair[1],c.pair[2]-1>> /\
           st.a.log[st.h.credits[m].record].taken < st.a.log[c.record].taken)
    /\ \A i \in st.h.accepted : i < c.pair[1] =>
        \E m \in 1..(n-1) : st.h.credits[m].pair = <<i,Last(i)>> /\
           st.a.log[st.h.credits[m].record].taken < st.a.log[c.record].taken
OneInFlight == /\ \A i,j \in st.h.accepted : i # j => ~(InFlight(i) /\ InFlight(j))
               /\ \A ip \in Pairs : ip[2] > 1 =>
                         (Sent(ip[1],ip[2]) => Delivered(ip[1],ip[2]-1))
NoTypeIntoText == \A event \in SeqSet(st.h.keys) :
 LET r == event.reading
 IN /\ event.kind \in {"text","retype"} =>
        r.screen \in {"empty","running"} /\ r.row \in {"waiting","working"} /\
        r.relay /\ r.marker /\ r.mcp /\ r.up /\ ~r.latched /\ ~r.held
    /\ event.kind = "reconnect" => ReconnectGate(r)
NoRetypeWhileWorking == \A event \in SeqSet(st.h.keys) :
 event.kind = "retype" => event.reading.row = "waiting" /\
 event.reading.screen = "empty" /\ event.missingReceipt
GateExclusive == \A event \in SeqSet(st.h.keys) : event.owner = event.gate
NoDuplicateKey == Len(st.p.keys) = Cardinality(SeqSet(st.p.keys))
AtMostOnce == \A ip \in Pairs : Cardinality({n \in 1..Len(st.h.taken) :
                                           st.h.taken[n] = ip}) <= 1
TypeOK == /\ st.a.row \in Rows /\ st.a.actual \in Activities /\ st.a.screen \in Screens
          /\ st.g.owner \in {"free","delivery","reconnect"}
          /\ st.a.marker = TRUE /\ Len(st.a.input) <= MaxAgentQueue
          /\ Len(st.h.credits) = Cardinality(st.h.credited)
          /\ \A f \in FaultNames : st.faults[f] <= Budget(f)
          /\ EngineChoice(ObservedKnowledge) \in EngineActions \cup ControlActions \cup {"wait"}

\* Owner-authorized shared checking reduction; larger simulations stay raw.
RestartPositiveScope ==
 /\ Scenario \in {"restart-pre", "restart-across", "restart-bot",
                   "restart-enter", "restart-busy"}
 /\ MaxItems = 2 /\ MaxParts = 2 /\ ~Flapping /\ Bug = "none"
 /\ ~IdenticalTexts
 /\ Faults \subseteq {"serverCrash", "botRestart", "lostEnter", "busyWaiting"}

\* Exact audited Bug/fault contexts for companion sensitivity checks. Their
\* Scenario has ordinary acceptance/restart guards, as the original controls:
\* no fault or engine phase is required by the constraint. Every fault retains
\* budget one; all original mutant choice/action/receipt rules are reused.
RestartMutationBugs == {"next_item", "next_part", "send_is_delivery",
 "queue_is_receipt", "start_drop", "compact_open", "early_ack", "skip_refused",
 "start_unsent_head", "retype_into_text", "retype_working", "reconnect_keys",
 "reconnect_running", "duplicate_key"}
RestartMutationFaults ==
 CASE Bug \in {"next_item","next_part","send_is_delivery","compact_open","early_ack"} -> {}
 [] Bug \in {"queue_is_receipt","retype_working"} -> {"busyWaiting"}
 [] Bug \in {"start_drop","start_unsent_head","duplicate_key"} -> {"serverCrash"}
 [] Bug = "skip_refused" -> {"textRefused"}
 [] Bug = "retype_into_text" -> {"enterRefused","enterUnknown","lostEnter","busyWaiting","pullBack"}
 [] Bug = "reconnect_keys" -> {"mcpDrop"}
 [] Bug = "reconnect_running" -> {"busyWaiting","mcpDrop"}
 [] OTHER -> {}
RestartMutationScope ==
 /\ Scenario = "restart-control" /\ Bug \in RestartMutationBugs
 /\ MaxItems = 2 /\ MaxParts = 2 /\ MaxServerStarts = 2 /\ MaxLaunches = 1
 /\ ~Flapping /\ ~PromptFlapping /\ ~IdenticalTexts /\ EnterRetries = 4
 /\ Faults = RestartMutationFaults
 /\ MaxRetypes = (IF "serverCrash" \in Faults \/ "pullBack" \in Faults THEN 2 ELSE 1)
 /\ MaxAgentQueue = MaxParts + MaxItems * MaxRetypes
\* Owner expansion: ordinary safety/temporal/witness contexts are audited
\* below. Scope is constant, accepts Init, and never demands a fault or phase.
SharedCheckScope ==
 /\ Scenario \in {"safety", "identical", "liveness", "empty-reconnect",
                     "control", "control-no-assumption", "probe", "witness"}
 /\ MaxItems >= 2 /\ MaxParts >= 2 /\ MaxServerStarts >= 2
 /\ Faults \subseteq FaultNames
RestartCheckScope == RestartPositiveScope \/ RestartMutationScope \/ SharedCheckScope
                     \/ SmallCoreBounds

\* This is an explicit restriction, not an invariant or progress assumption:
\* each part has its first durable send plus at most one additional durable
\* send (Enter-only retry OR retype). Every attempt phase and crash boundary
\* remains enabled inside that prefix. Continuing after a third send is outside
\* the checked scope. Binary timers and zero inactive fault counts already hold
\* by construction; listing them audits the intended domain, not new savings.
RestartStateConstraint ==
 /\ RestartCheckScope
 /\ \A ip \in Pairs :
      Cardinality({n \in 1..Len(st.p.sent) : PairOf(st.p.sent[n]) = ip}) <= 2
 /\ \A t \in TimerNames : st.e.timers[t] \in {0,1}
 /\ \A f \in FaultNames \ Faults : st.faults[f] = 0

WithoutFields(r, fields) == [key \in (DOMAIN r) \ fields |-> r[key]]
\* A saved send reading can only add a text/retype key event. Preserve exactly
\* the two safety facts consumed by that event, including unsafe mutant reads.
\* Enter events inspect neither fact; a later text send replaces this reading.
RestartKeyProof(r) ==
 <<r.screen \in {"empty","running"} /\ r.row \in {"waiting","working"} /\
   r.relay /\ r.marker /\ r.mcp /\ r.up /\ ~r.latched /\ ~r.held,
   r.row = "waiting" /\ r.screen = "empty" /\ r.receipts = {}>>
RestartKeyProofLive == st.e.phase = "text" \/
 (st.w.kind = "sent" /\ st.w.how # "enter")
\* Attempt identity is the durable sequence index. Only non-refused offsets
\* are read; reusing a refused slot replaces its entire record before any read.
RestartSentView(p) ==
 [n \in 1..Len(p.sent) |->
   [item |-> p.sent[n].item, part |-> p.sent[n].part,
    how |-> p.sent[n].how,
    offset |-> IF n \in p.refused THEN 0 ELSE p.sent[n].offset]]
\* Writer/torn launch and session are copied into durable records but never
\* branch recovery or an action. Actual and observed lifecycle IDs stay live.
\* Init and Record fix the record domains; every update/reset preserves them.
\* These constructors therefore equal field removal on every reachable state.
RestartWriteView(r) == [kind |-> r.kind, item |-> r.item, part |-> r.part,
    attempt |-> r.attempt, how |-> r.how, offset |-> r.offset,
    receipt |-> r.receipt]
\* An unconsumed observation and an active attempt keep their external read.
\* Retain it even while the gate is free: a request can reacquire the gate and
\* resume an attempt without EngineObserve. A sent writer can likewise commit
\* into text/retry. In the remaining ready phase, owned accepted/fixed/notice
\* writers and compaction ignore the external read; any transition that can
\* make it live again first takes a fresh observation. Unreadability is disabled
\* here, so ReadOf never consults an inactive cached transcript.
RestartReadingLive == st.observation = "ready" \/
 st.e.phase \in {"text", "enter", "retry", "receipt", "refused"} \/
 st.w.kind = "sent"

\* Only two fair actions can change solely omitted owned snapshots/metadata.
\* Canonical full tuples preserve both nonstuttering and fair-edge labels:
\* stopAbsent repeats stutter only at its canonical tuple; a replacement read
\* writes current owned snapshots, so only its canonical tuple can stutter.
RestartTemporalContext == Flapping \/ Scenario = "probe"
RestartFairMetadata ==
 CASE st.transition = "EngineStep" /\ st.action = "stopAbsent" /\
      st.expired = {} /\ st.outcome = "waiting" /\ ~st.bugStep -> "stopAbsent"
 [] st.transition = "EngineObserve" /\ st.action = "observe" /\
    st.expired = {} /\ st.outcome = "reading-replaced" /\ ~st.bugStep -> "replaced"
 [] OTHER -> "other"
RestartSafetyView ==
 IF ~RestartCheckScope THEN st
 ELSE
 [p |-> [accepted |-> st.p.accepted, fixed |-> st.p.fixed, sent |-> RestartSentView(st.p),
    refused |-> st.p.refused, delivered |-> st.p.delivered, keys |-> st.p.keys,
    torn |-> [n \in 1..Len(st.p.torn) |-> RestartWriteView(st.p.torn[n])]],
  e |-> [phase |-> st.e.phase, target |-> st.e.target, attempt |-> st.e.attempt,
    launchSeen |-> st.e.launchSeen, sessionSeen |-> st.e.sessionSeen, compactionSeen |-> st.e.compactionSeen,
    enterRetries |-> st.e.enterRetries, retypes |-> st.e.retypes, timers |-> st.e.timers,
    lastDelivered |-> st.e.lastDelivered, appendBlocked |-> st.e.appendBlocked, noticed |-> st.e.noticed,
    request |-> st.e.request, keyReading |-> IF RestartKeyProofLive
       THEN RestartKeyProof(st.e.keyReading) ELSE "inactive"],
  a |-> IF "staleRead" \in Faults THEN st.a ELSE [row |-> st.a.row, actual |-> st.a.actual, screen |-> st.a.screen,
    box |-> st.a.box, submitted |-> st.a.submitted, input |-> st.a.input,
    log |-> st.a.log, pending |-> st.a.pending, transcript |-> st.a.transcript,
    relay |-> st.a.relay, marker |-> st.a.marker, mcp |-> st.a.mcp,
    present |-> st.a.present, up |-> st.a.up, latched |-> st.a.latched,
    held |-> st.a.held, permission |-> st.a.permission, overlay |-> st.a.overlay,
    person |-> st.a.person, writable |-> st.a.writable, tailEnded |-> st.a.tailEnded,
    notNow |-> st.a.notNow, dialogHold |-> st.a.dialogHold, botAlive |-> st.a.botAlive,
    launch |-> st.a.launch, session |-> st.a.session, compactions |-> st.a.compactions,
    reconnectRunning |-> st.a.reconnectRunning],
  g |-> [owner |-> st.g.owner, stage |-> st.g.stage, deferred |-> st.g.deferred,
    due |-> st.g.due, typed |-> st.g.typed],
  h |-> [accepted |-> st.h.accepted, acked |-> st.h.acked, everSent |-> st.h.everSent,
    everDelivered |-> st.h.everDelivered, credited |-> st.h.credited, credits |-> st.h.credits,
    keys |-> <<NoTypeIntoText, NoRetypeWhileWorking, GateExclusive>>, compactions |-> st.h.compactions],
  \* ReadOf consults cached records even with no live attempt. Keep the whole
  \* external reading for unreadable contexts, before/during/after the spell.
  reading |-> IF RestartReadingLive \/ "unreadable" \in Faults
              THEN [row |-> st.knowledge.r.row, screen |-> st.knowledge.r.screen, box |-> st.knowledge.r.box,
    relay |-> st.knowledge.r.relay, marker |-> st.knowledge.r.marker, mcp |-> st.knowledge.r.mcp,
    up |-> st.knowledge.r.up, latched |-> st.knowledge.r.latched, held |-> st.knowledge.r.held,
    readable |-> st.knowledge.r.readable, receipts |-> st.knowledge.r.receipts, idleEvidence |-> st.knowledge.r.idleEvidence,
    launch |-> st.knowledge.r.launch, session |-> st.knowledge.r.session, compactions |-> st.knowledge.r.compactions,
    offset |-> st.knowledge.r.offset, records |-> st.knowledge.r.records] ELSE "inactive",
  faults |-> st.faults, server |-> st.server, starts |-> st.starts,
  observation |-> st.observation, compact |-> st.compact,
  redelivery |-> st.redelivery, w |-> RestartWriteView(st.w),
  temporalStep |-> IF RestartTemporalContext
     THEN RestartFairMetadata ELSE "inactive"]
\* Projection audit: StepKnowledge overwrites owned snapshots before choices.
\* A grant installs a fresh read only with observation=none, marks it ready,
\* and changes retained request/owner; the granted request keeps a finite
\* runnable continuation even if the external prompt changes. EngineObserve
\* cannot replace it in the correct model. Starting sent clears the grant token;
\* waiting consumes it, so no unused lease can wait for another external read.
\* Pending free-gate requests pause observations until grant/cancel; otherwise
\* observing repeatedly could disable the grant guard and starve WF(GateStep).
\* ReadOf's cached records remain retained whenever unreadability is enabled;
\* earlierRow remains retained with staleRead. Live external reads, keyReading
\* guards, operational state, log/pending/input, credits, timers and faults stay.
\* h.keys is consumed only by the three universal predicate summaries.
\* h.taken is derivable as the ordered take-in pair events in a.log concatenated
\* with a.pending: TakeIn appends both, TurnEnd moves pending into log, and no
\* action discards either. AtMostOnce and take-in ordinals therefore survive.
\* p.records, saved, g.reading, e.restartCheck/e.receipt and reconnect history
\* have no consumers. Their writes accompany retained operational changes.
\* The three-valued marker preserves the only metadata-only fair transitions,
\* including identical replacement observations. Every action staling an owned
\* observation snapshot also replaces metadata, so canonical replacement marks
\* current owned snapshots. Equal projected edges retain fair label membership,
\* not merely valuations of temporal state atoms. EngineStep enabledness uses
\* the selected branch (including CommitAppend's writable guard); GateStep's
\* grant guard uses retained observation. The other fair actions change retained
\* owner/request, due/deferred, actual/pending, actual/log, or reconnectRunning.
\* Temporal predicates, seven fairness conjuncts and decision13 stay unchanged.
\* The two-send constraint restricts behaviors: the third sent append may start
\* but its commit is pruned while raw WF(EngineStep) still demands it. Such a
\* boundary has no fair constrained continuation. This is no unrestricted proof.
\* Local profiles are exploratory; concrete fair accepted-work witnesses and
\* original-relation lasso replay are separate nonvacuity/soundness obligations.

Fairness ==
 /\ (IF Bug = "weak_observe" THEN WF_vars(EngineObserve /\ EnvTypable)
                              ELSE SF_vars(EngineObserve /\ EnvTypable))
 /\ WF_vars(EngineStep) /\ WF_vars(GateStep) /\ SF_vars(ReconnectStep)
 /\ SF_vars(AgentTakeIn) /\ WF_vars(AgentTurnEnd) /\ WF_vars(AgentCompletesReconnect)
\* Original mutation controls use this raw seven-fairness specification, with
\* PromptFlapping=FALSE. No temporal assumption can excuse a mutant that parks
\* a head item or prevents reconnect. The new no-assumption control alone uses
\* the raw specification with permission flapping and correct choices.
SpecWithoutHeadTakeInAssumption == Init /\ [][Next]_vars /\ Fairness
Spec == SpecWithoutHeadTakeInAssumption /\ TypableHeadTakeInAssumption

ControlClass == IF Scenario = "control-no-assumption" THEN "environment-assumption"
                ELSE IF Bug = "weak_observe" THEN "fairness"
                ELSE IF Bug = "replace_observation" THEN "scheduling"
                ELSE IF Bug = "none" THEN "correct" ELSE "choice"
TraceRecord(s) == [schema |-> 1, model |-> "PersonaDelivery", state |-> s,
 knowledge |-> ReplayKnowledgeOf(s), gateKnowledge |-> KnowledgeOf(s),
 observationKnowledge |-> s.knowledge,
 EngineChoice |-> EngineChoice(ReplayKnowledgeOf(s)),
 GateChoice |-> GateChoice(KnowledgeOf(s)),
 selectedTarget |-> SelectTarget(ReplayKnowledgeOf(s)),
 correctSelectedTarget |-> SelectTarget([ReplayKnowledgeOf(s) EXCEPT !.bug = "none"]),
 correctEngineChoice |-> EngineChoice([ReplayKnowledgeOf(s) EXCEPT !.bug = "none"]),
 correctGateChoice |-> GateChoice([KnowledgeOf(s) EXCEPT !.bug = "none"]),
 decisionDivergence |-> EngineDecisionDiverges(ReplayKnowledgeOf(s)) \/ GateDecisionDiverges(KnowledgeOf(s)),
 engineActions |-> EngineActions, controlActions |-> ControlActions,
 transition |-> s.transition, executedAction |-> s.action, outcome |-> s.outcome,
 expiredTimers |-> s.expired, timerConstants |-> TimerConstants,
 constants |-> [MaxItems |-> MaxItems, MaxParts |-> MaxParts,
  MaxLaunches |-> MaxLaunches, MaxServerStarts |-> MaxServerStarts,
  MaxRetypes |-> MaxRetypes, EnterRetries |-> EnterRetries,
  MaxAgentQueue |-> MaxAgentQueue, Faults |-> Faults, Flapping |-> Flapping,
  PromptFlapping |-> PromptFlapping,
  Scenario |-> Scenario, IdenticalTexts |-> IdenticalTexts],
 control |-> [bug |-> Bug, class |-> ControlClass, bugStep |-> s.bugStep]]
TraceView == TraceRecord(st)

\* Pinned TLC aliases finite CounterExample states before the postcondition,
\* but temporal CounterExample and simulation Trace states retain the raw st.
\* Preserve an existing ALIAS record; project only a raw state wrapper. Apply
\* the same normalization to all endpoints and ordered behavior states.
TraceRecordOf(s) == IF "st" \in DOMAIN s THEN TraceRecord(s.st) ELSE s
TraceNode(n) == <<n[1], TraceRecordOf(n[2])>>
EmitTrace ==
 LET ce == CounterExample
     behavior == ToTrace(ce)
     projected == [state |-> {TraceNode(n) : n \in ce.state},
                   action |-> {<<TraceNode(a[1]), a[2], TraceNode(a[3])>>
                                : a \in ce.action}]
 IN IF ce.state = {} THEN TRUE ELSE
     PrintT("TRACE " \o ToJson([schema |-> 1,
       counterexample |-> projected,
       behavior |-> [i \in DOMAIN behavior |-> TraceRecordOf(behavior[i])]]))

\* Simulation's postcondition has no current state. Defer this invariant's
\* side effect until the chosen successor at the requested final depth.
EmitSimulationTrace ==
 IF TLCGet("level") = TLCGet("config").depth + 1
 THEN TLCDefer(
   LET behavior == Trace
   IN PrintT("TRACE " \o ToJson([schema |-> 1,
     behavior |-> [i \in DOMAIN behavior |-> TraceRecordOf(behavior[i])]])))
 ELSE TRUE
=============================================================================
