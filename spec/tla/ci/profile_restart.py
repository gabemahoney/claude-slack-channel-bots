"""Offline observations from a retained scheduler log; never executes TLC.

Projection counts describe this finite sample, not the full reachable graph or
causal contributions of individual variables. The larger simulation deliberately
has combined faults and three items; it is not a sample of any two-item case.
"""
from __future__ import annotations

import argparse
from collections import Counter
from copy import deepcopy
import hashlib
import json
from pathlib import Path


KEY_READING_FIELDS = ("row", "relay", "marker", "mcp", "up",
                      "latched", "held")
TRACE_FIELDS = ("transition", "action", "outcome", "expired", "bugStep")
DATAFLOW = {
    "p.accepted/fixed/delivered": "retained: Open/Head/SelectTarget, compaction membership, NoDrop and receipt decisions",
    "p.sent/refused": "retained: attempt reuse, first/latest offsets, retypes after restart, receipt matching and key-call kind",
    "p.keys": "retained: redelivery guard and NoDuplicateKey",
    "p.torn": "retained: RecoverTorn/ServerStart; inert with the five selected single-fault cases",
    "p.records": "omitted: append/filter only; no transition/property reads its contents except its own compaction filter",
    "e.phase/target/attempt/request": "retained: engine dispatch, call ownership, gate grants and continuation",
    "e.recoveryAttempt": "retained: successful recovery Enter identity selects Enter versus full retype; cleared on restart/new launch",
    "relaunch/e.sessionSeen": "retained: AD pending/terminal row transitions or session changes reset/recheck the attempt",
    "e.retypes/noticed/appendBlocked": "retained: retry guards, notice writes, write completion",
    "e.timers": "retained: all pending/expired tests and explicit expiry; already binary, no timer progress is forced",
    "e.keyReading": "projected: KeyReading fields plus receipt-set emptiness are all future KeyEvent inputs",
    "e.receipt/restartCheck": "omitted: initialized/assigned, never read by actions or checked properties",
    "a.earlierRow": "omitted only in scoped VIEW: StaleRead is its only consumer and its budget is zero",
    "a.other fields": "retained: actual/reported row, calls, transcripts, pending take-ins, input queue, lifecycle and fault guards",
    "g.reading": "omitted: written by reconnect, never consumed",
    "g.owner/stage/deferred/due/typed": "retained: gate/reconnect choices and stages; typed also remains for conservative state identity",
    "h.accepted/acked/everSent/everDelivered": "retained: intake source/order, permanent no-drop/FIFO/one-in-flight histories",
    "h.credited/credits": "retained: credit-once receipts, full credit sequence for TranscriptFIFO and ReceiptBacked",
    "h.compactions": "retained: QueueCompactPrepare guard (one prepare cycle)",
    "h.keys": "summarized by accumulated TypingGuards/NoRetypeWhileWorking/GateExclusive truths; future updates only append",
    "h.taken": "summarized by length: AgentTakeIn uses it for transcript ordinal; contents only feed unchecked AtMostOnce",
    "h.reconnectDeferred/reconnectTyped": "omitted: trace-only history booleans; actual deferred/typed gate state retained",
    "knowledge.p/e/g/writer/started/compact/acked": "omitted: StepKnowledge overwrites each before engine evaluation; GateChoice uses current Knowledge",
    "knowledge.bug": "omitted: constant Bug=none in scope",
    "knowledge.r": "retained when an observation, active phase or sent writer can consume it; r.gate always refreshed; unreadable disabled",
    "faults": "retained: selected guard budgets determine future faults; inactive values already zero",
    "server/starts/observation/compact/redelivery/w": "retained: lifecycle, sequential dispatch, compaction stages, redelivery and owned writer continuation",
    "saved": "omitted: append-only quarantine trace history, never read",
    "transition/action/outcome/expired/bugStep": "omitted: last-step output metadata; no future action or safety predicate consumes it",
}


def encoded(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"))


def key_truths(events):
    def reconnect(r):
        return (r["up"] and not r["latched"] and not r["held"] and r["relay"]
                and r["marker"] and r["row"] == "waiting")

    return [all(e["kind"] not in ("text", "retype", "enter") or
                (e["reading"]["row"] == "waiting"
                 and all(e["reading"][k] for k in ("relay", "marker", "mcp", "up"))
                 and not e["reading"]["latched"] and not e["reading"]["held"])
                for e in events)
            and all(e["kind"] != "reconnect" or reconnect(e["reading"]) for e in events),
            all(e["kind"] != "retype" or
                (e["reading"]["row"] == "waiting"
                 and e["missingReceipt"]) for e in events),
            all(e["owner"] == e["gate"] for e in events)]


def reading_is_live(s):
    # Includes phases that can reacquire a gate without a new observation and
    # a sent writer that can commit into text without a new observation.
    return (s["observation"] == "ready" or s["e"]["phase"] in
            ("text", "enter", "recovery-enter", "receipt", "refused") or s["w"]["kind"] == "sent")


def project(state, stages):
    s = deepcopy(state)
    if "trace" in stages:
        for key in TRACE_FIELDS:
            s.pop(key)
    if "owned_snapshot" in stages:
        s["knowledge"] = {"r": s["knowledge"]["r"]}
        s["knowledge"]["r"].pop("gate")  # StepKnowledge refreshes this owned fact.
    if "inactive_reading" in stages and not reading_is_live(state):
        s["knowledge"] = None
    if "inert" in stages:
        s.pop("saved")
        s["p"].pop("records")
        s["a"].pop("earlierRow")
        s["g"].pop("reading")
        s["h"].pop("reconnectDeferred")
        s["h"].pop("reconnectTyped")
        s["e"].pop("restartCheck")
        s["e"].pop("receipt")
    if "key_reading" in stages:
        r = s["e"]["keyReading"]
        s["e"]["keyReading"] = {"reading": {k: r[k] for k in KEY_READING_FIELDS},
                                 "missingReceipt": not r["receipts"]}
    if "key_history" in stages:
        s["h"]["keys"] = key_truths(s["h"]["keys"])
    if "taken_history" in stages:
        s["h"]["taken"] = len(s["h"]["taken"])
    return s


def field_values(value, path=""):
    # Keep sequence/set-valued fields intact; do not mistake sequence indices
    # for state-variable paths or reorder transcript/key/credit sequences.
    if isinstance(value, dict):
        for key, item in value.items():
            yield from field_values(item, f"{path}.{key}" if path else key)
    else:
        yield path, value


def profile(directory):
    run = json.loads((directory / "state.json").read_text())
    job_id, = run["ids"]
    log_path = directory / f"{job_id}.run_log"
    log = log_path.read_bytes()
    rows, envelopes = [], []
    for line in log.decode().splitlines():
        if line.startswith("ROW "):
            rows.append(json.loads(line[4:]))
        elif line.startswith("TRACE "):
            envelopes.append(json.loads(line[6:]))
    assert len(rows) == 6 and len(envelopes) == 8
    assert all(e["cfg"] == "restart_order_simulation" and e["snapshot"] == run["snapshot"]
               and e["simulation"] == {"num": 8, "depth": 256, "seed": 111792} for e in envelopes)
    frozen_spec = directory / "contexts/00-restart-order/PersonaDelivery.tla"
    assert hashlib.sha256(frozen_spec.read_bytes()).hexdigest() == run["inputs"]["PersonaDelivery.tla"]
    states = [record["state"] for e in envelopes for record in e["raw"]["behavior"]]
    values = {}
    for s in states:
        for path, value in field_values(s):
            values.setdefault(path, set()).add(encoded(value))
    count = lambda items: len({encoded(x) for x in items})
    stages = ("trace", "owned_snapshot", "inactive_reading", "inert",
              "key_reading", "key_history", "taken_history")
    projections = {"raw": count(states)}
    for index, stage in enumerate(stages, 1):
        projections[stage] = count(project(s, stages[:index]) for s in states)
    isolated = {stage: count(project(s, {stage}) for s in states) for stage in stages}
    send_counts = [Counter((r["item"], r["part"]) for r in s["p"]["sent"]) for s in states]
    transitions = Counter(record["transition"] for e in envelopes for record in e["raw"]["behavior"][1:])
    components = ("knowledge", "knowledge.p", "knowledge.e", "knowledge.g", "knowledge.r",
                  "e.keyReading", "g.reading", "p.records", "h.keys", "h.taken", "saved")
    def component(s, path):
        for key in path.split("."):
            s = s[key]
        return s
    return {
        "schema": 1, "scope": "offline finite three-item combined-fault simulation sample; not exhaustive",
        "jobId": job_id, "snapshot": run["snapshot"],
        "logSha256": hashlib.sha256(log).hexdigest(),
        "frozenSpecSha256": run["inputs"]["PersonaDelivery.tla"],
        "rowsBefore": rows, "rowsAfter": None,
        "afterStatus": "not measured: no revised model-check job submitted",
        "sample": {"behaviors": len(envelopes), "stateRecords": len(states),
                   "statesPerBehavior": [len(e["raw"]["behavior"]) for e in envelopes],
                   "cumulativeProjectionDistinct": projections,
                   "oneProjectionAtATimeDistinct": isolated,
                   "fieldObservedCardinality": {k: len(v) for k, v in sorted(values.items())},
                   "componentObservedCardinality": {path: count(component(s, path) for s in states) for path in components},
                   "timerValues": sorted({v for s in states for v in s["e"]["timers"].values()}),
                   "inactiveFaultValues": sorted({v for s in states for f,v in s["faults"].items()
                                                   if f not in envelopes[0]["raw"]["behavior"][0]["constants"]["Faults"]}),
                   "observedMaxSentRecordsPerPair": max(max(c.values(), default=0) for c in send_counts),
                   "sampleStatesWithinFourSendBound": sum(max(c.values(), default=0) <= 4 for c in send_counts),
                   "executedTransitionOccurrences": dict(sorted(transitions.items()))},
        "dataflowAudit": DATAFLOW,
        "staticBounds": {"timerValuationsUpperBound": 64,
                         "inactiveFaultValuations": 1, "selectedSingleFaultCounterValues": [0, 1],
                         "sendRecordsPerPairAfterConstraint": 4,
                         "note": "bounds are non-independent and are not causal full-graph state multipliers"},
        "reachabilityAudit": {
            "restriction": "at most four persisted sent records per item/part; continuations beyond a fifth send are excluded",
            "noPhaseGuard": True, "noRequirementFaultAlreadyHappened": True,
            "retainedBoundaries": ["accept/write/ack", "duplicate Slack key after restart", "sent before keys",
                                   "text before Enter", "take-in before transcript", "receipt read before delivered append",
                                   "compaction prepare before rename", "rename before directory fsync", "new bot session",
                                   "lost Enter then recovery Enter", "busy/waiting then recovery Enter and one retype",
                                   "all three FIFO parts delivered"],
            "argument": "each boundary is reachable using up to four send records for its part, covering text, recovery Enter, retype and recovery Enter; the constraint tests no phase, receipt, key, restart or compaction stage",
            "limitation": "structural audit and original sample only; revised scheduler exploration and representative reachability evidence remain pending",
        },
        "interpretation": [
            "No per-field exhaustive contribution is known; single and cumulative sample projections are non-additive.",
            "All six timers are already binary. Their unconstrained product is at most 64 live combinations, not a measured graph multiplier; reconnect remains zero.",
            "Disabled fault counters are already zero by guard budgets; they do not multiply this graph.",
            "Each persisted send affects offsets, recovery, receipt and order decisions.",
            "Frozen knowledge copies owned p/e/g/writer/started/compact/acked values already overwritten by StepKnowledge; only its external reading remains relevant.",
            "Inactive external readings may be cleared only outside ready observations, active attempt phases and sent writers; unreadable/staleRead faults are disabled in these cases.",
            "Saved torn records are trace-only; persistent records feed only their own compaction filter, whose actual queue membership derives from accepted/delivered.",
            "Key history is read only by three universal safety predicates: retain their accumulated truth. Taken history contents feed AtMostOnce (not checked); retain length for transcript ordinals.",
            "Receipt credits, credited offsets, full transcript/input/pending sequences, durable sent/accepted/delivered/keys, permanent sent/delivered histories, counters and timers remain distinct.",
            "The state constraint bounds each part to four persisted sent records, including recovery Enter intents. It is a restricted safety exploration, not a full-model proof.",
        ],
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run-dir", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    evidence = profile(args.run_dir)
    args.output.write_text(json.dumps(evidence, sort_keys=True, indent=2) + "\n")
    print(json.dumps({"output": str(args.output), "sample": evidence["sample"]["cumulativeProjectionDistinct"],
                      "records": evidence["sample"]["stateRecords"], "rowsAfter": None}))


if __name__ == "__main__":
    main()
