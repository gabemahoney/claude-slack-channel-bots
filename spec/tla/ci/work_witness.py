#!/usr/bin/env python3
"""SR-15.3's bounded, existential accepted-work witness, separate from NotPremise.

The probe row's caller supplies its frozen inputs and ONE absolute monotonic
deadline, shared with the probe and all other row work. No job is submitted here.
The finite guide searches original Next; a second run independently evaluates
the original Init, Next, nonstuttering fair actions, assumption and exact Premise
on every raw state and the closing edge. Neither run uses VIEW or CONSTRAINT to
hide states. An offline payload check verifies retained checker evidence; it
does not execute TLC or authenticate arbitrary caller-fabricated checker logs.
"""
from __future__ import annotations

from collections import Counter
import json
import math
from pathlib import Path
import re
import subprocess
import time

import temporal_sensitivity as temporal


class WitnessRefusal(ValueError):
    pass


class WitnessIncomplete(WitnessRefusal):
    pass


def require(condition, message):
    if not condition:
        raise WitnessRefusal(message)


def budget(deadline):
    require(isinstance(deadline, (int, float)) and not isinstance(deadline, bool)
            and math.isfinite(deadline), "absolute monotonic deadline required")
    left = deadline - time.monotonic()
    if left <= 0:
        raise WitnessIncomplete("accepted-work witness exhausted the row deadline")
    return left


CONSTANTS = {"MaxItems": 2, "MaxParts": 2, "MaxLaunches": 1,
             "MaxServerStarts": 2, "MaxRetypes": 1, "EnterRetries": 4,
             "MaxAgentQueue": 4, "Faults": [], "PromptFlapping": True,
             "Flapping": True, "Bug": "none", "Scenario": "probe",
             "IdenticalTexts": False}
CORE_CONSTANTS = dict(CONSTANTS, MaxItems=1, MaxParts=1, MaxAgentQueue=2, Flapping=False)
SCOPE = "existential-accepted-work-within-RestartStateConstraint"

# The guide exercises waiting-only delivery through original Next. Its result
# is independently replayed with every original fairness and progress check.
GUIDE = r'''Guide ==
 CASE st.w.kind # "none" -> EngineStep
 [] st.h.everDelivered = Pairs /\ st.g.owner = "free" /\
    st.a.actual = "idle" /\ Flapping -> AgentOwnTurnStart
 [] st.h.everDelivered = Pairs /\ st.g.owner = "free" /\ ~Flapping -> Done
 [] st.h.accepted # Items /\ st.observation = "none" /\ st.g.owner = "free" -> Accept
 [] st.a.submitted /\ st.a.actual = "idle" -> AgentTakeIn
 [] st.h.everSent = {} /\ st.e.request = "delivery" /\ st.g.owner = "free" -> GateStep
 [] st.a.actual # "idle" /\ (st.e.phase = "text" \/ st.w.kind = "sent" \/
    st.e.request = "granted") -> EngineStep
 [] st.a.actual # "idle" -> AgentTurnEnd
 [] st.g.owner = "delivery" /\ GateChoice(ObservedKnowledge) = "release" -> GateStep
 [] st.e.request = "delivery" /\ st.g.owner = "free" -> GateStep
 [] st.observation = "ready" \/ InternalContinuation -> EngineStep
 [] OTHER -> EngineObserve
'''
GOAL = r'''Fairness /\ TypableHeadTakeInAssumption /\ Premise /\ HeadTakenIn
 /\ []RestartStateConstraint
 /\ <>(st.h.accepted = Items /\ st.h.everDelivered = Pairs
         /\ Pairs \subseteq SeqSet(st.h.taken)
         /\ \A ip \in Pairs : Taken(ip))'''

# The pinned CounterExample exporter can append a duplicate loop-entry state
# followed by an artificial stutter edge. Retain that export separately. Only
# when the terminal record EXACTLY equals the closing target may we omit its
# duplicate occurrence and redirect the preceding edge to the identical node.
# No state value or action label changes; original Next is independently replayed
# on every resulting edge. The existing probe behavior is preserved.
EXPORT = r'''EmitWorkTrace ==
 LET ce == CounterExample
     behavior == ToTrace(ce)
     records == [i \in DOMAIN behavior |-> TraceRecordOf(behavior[i])]
     count == Len(records)
     closing == {a \in ce.action : a[1][1] = count /\ a[3][1] <= count}
     loop == IF Cardinality(closing) = 1
             THEN (CHOOSE a \in closing : TRUE)[3][1] ELSE count
     omit == count > 1 /\ loop < count /\ records[count] = records[loop]
     source == [schema |-> 1,
       counterexample |-> [state |-> {TraceNode(n) : n \in ce.state},
         action |-> {<<TraceNode(a[1]), a[2], TraceNode(a[3])>> : a \in ce.action}],
       behavior |-> records]
     nodes == {n \in ce.state : ~omit \/ n[1] # count}
     edges == {a \in ce.action : ~omit \/ a[1][1] # count}
     result == [schema |-> 1,
       counterexample |-> [state |-> {TraceNode(n) : n \in nodes},
         action |-> {<<TraceNode(a[1]), a[2],
           IF omit /\ a[3][1] = count THEN <<loop,records[loop]>>
           ELSE TraceNode(a[3])>> : a \in edges}],
       behavior |-> IF omit THEN SubSeq(records,1,count-1) ELSE records]
 IN IF ce.state = {} THEN TRUE ELSE
    /\ PrintT("WITNESS_SOURCE_TRACE " \o ToJson(source))
    /\ PrintT("TRACE " \o ToJson(result))
'''


def witness_constants(cfg_text):
    """Accept the frozen probe or core cfg; preserve each declared bound.

    Only the premise probe derives the existing liveness scenario. The core
    witness retains its production constants exactly, including Scenario=probe.
    """
    lines = [line.split(r"\*", 1)[0].strip() for line in cfg_text.splitlines()]
    values, directives = {}, []
    for line in filter(None, lines):
        match = re.fullmatch(r'(\w+)\s*=\s*(\d+|TRUE|FALSE|\{\}|"[^"\n]*")', line)
        if match:
            key, value = match.groups()
            require(key not in values, "duplicate witness constant")
            values[key] = ([] if value == "{}" else True if value == "TRUE" else
                           False if value == "FALSE" else json.loads(value))
        else:
            directives.append(line)
    require(set(values) == set(CONSTANTS)
            and all(type(values[key]) is type(value) for key, value in CONSTANTS.items()),
            "unsupported witness constant types")
    core = values == CORE_CONSTANTS
    require(values == CONSTANTS or core,
            "unsupported witness constants or accepted-work floor")
    invariants = ["TypeOK", "DurableAccept", "NoDrop", "ReceiptBacked", "InOrder",
                  "TranscriptFIFO", "OneInFlight", "TypingGuards",
                  "NoRetypeWhileWorking", "GateExclusive", "NoDuplicateKey"]
    expected = ["SPECIFICATION Spec", "CONSTANTS"]
    expected += (["INVARIANT " + name for name in invariants] + ["PROPERTY HeadTakenIn"]
                 if core else ["PROPERTY NotPremise"])
    expected += ["ALIAS TraceView", "POSTCONDITION EmitTrace"]
    if not core:
        expected += ["VIEW RestartSafetyView"]
    expected += ["CONSTRAINT RestartStateConstraint"]
    require(directives == expected, "not the frozen canonical premise probe or core cfg")
    if not core:
        values = dict(values, Scenario="liveness")
    constants = "CONSTANTS\n" + "".join(
        "  " + key + " = " + temporal.tla(value, key) + "\n"
        for key, value in values.items())
    return values, constants


def search_inputs(constants):
    module = ("---------------- MODULE FairWorkWitness ----------------\n"
              "EXTENDS PersonaDelivery\n" + GUIDE +
              "GuidedNext == Guide /\\ Next\n"
              "GuidedSpec == Init /\\ [][GuidedNext]_vars\n"
              "NotFairWork == ~(" + GOAL + ")\n" + EXPORT +
              "========================================================\n")
    cfg = ("SPECIFICATION GuidedSpec\n" + constants + "PROPERTY NotFairWork\n"
           "ALIAS TraceView\nPOSTCONDITION EmitWorkTrace\n")
    return module, cfg


def replay_inputs(constants, raw, deadline):
    """Full original-action enabledness is independent of the search guide."""
    budget(deadline)
    behavior, loop = temporal.lasso(raw)
    library, (states, records) = temporal.tla_values([[r["state"] for r in behavior], behavior])
    budget(deadline)
    enabled = ",".join(k + " |-> ENABLED <<" + a + ">>_vars"
                       for k, a in temporal.FAIR_ACTIONS.items())
    fired = ",".join(k + " |-> <<" + a + ">>_vars"
                     for k, a in temporal.FAIR_ACTIONS.items())
    module = r'''---------------- MODULE TemporalReplay ----------------
EXTENDS PersonaDelivery
VARIABLE position
''' + library + "\nReplayStates == " + states + "\nReplayRecords == " + records + r'''
ReplaySuccessor == IF position = Len(ReplayStates) THEN ''' + str(loop) + r''' ELSE position+1
ReplayInit == position = 1 /\ st = ReplayStates[position]
ReplayNext == /\ position' = ReplaySuccessor
              /\ st' = ReplayStates[position']
              /\ PrintT("SENSITIVITY_EDGE " \o ToJson(
                   [position |-> position, legal |-> Next,
                    fired |-> [''' + fired + r''']]))
ReplaySpec == ReplayInit /\ [][ReplayNext]_<<st,position>> /\ WF_<<st,position>>(ReplayNext)
Evidence == PrintT("SENSITIVITY_STATE " \o ToJson(
 [position |-> position, enabled |-> [''' + enabled + r'''],
  constrained |-> RestartStateConstraint, typable |-> EnvTypable,
  recordMatches |-> TraceRecord(st) = ReplayRecords[position]]))
NotWitness == ~(Init /\ ''' + GOAL + r''')
========================================================
'''
    return module, "SPECIFICATION ReplaySpec\n" + constants + "INVARIANT Evidence\nPROPERTY NotWitness\n"


def binding(source, cfg, jar, java, deadline):
    budget(deadline)
    paths = {"source": Path(source).resolve(), "inputCfg": Path(cfg).resolve(),
             "jar": Path(jar).resolve(), "java": Path(java).resolve(),
             "helper": Path(__file__).resolve(),
             "temporalHelper": Path(temporal.__file__).resolve()}
    contents = {}
    for key, path in paths.items():
        budget(deadline)
        contents[key] = path.read_bytes()
    require(temporal.sha(contents["helper"]) == LOADED_SOURCE_SHA256,
            "work witness helper changed after import")
    require(temporal.sha(contents["temporalHelper"]) == temporal.LOADED_SOURCE_SHA256,
            "temporal helper changed after import")
    require(all(contents.values()), "empty accepted-work input")
    budget(deadline)
    values, constants = witness_constants(contents["inputCfg"].decode())
    search_module, search_cfg = search_inputs(constants)
    bound = {key + "Sha256": temporal.sha(data) for key, data in contents.items()}
    bound.update(schema=1, scope=SCOPE, constants=values,
                 guideSha256=temporal.sha(GUIDE.encode()),
                 searchModuleSha256=temporal.sha(search_module.encode()),
                 searchCfgSha256=temporal.sha(search_cfg.encode()),
                 cfgDerivation=({"Scenario": {"from": "probe", "to": "liveness"}}
                                if values["Flapping"] else {}))
    budget(deadline)
    return bound, constants, contents["source"]


def raw_coverage(raw, constants, deadline):
    """Structural bounds and actual receipt coverage, never summary booleans."""
    budget(deadline)
    require(constants == CORE_CONSTANTS or constants == dict(CONSTANTS, Scenario="liveness"),
            "unsupported accepted-work coverage bounds")
    items = set(range(1, constants["MaxItems"] + 1))
    pairs = {(item, part) for item in items
             for part in range(1, (constants["MaxParts"] if item == 1 else 1) + 1)}
    behavior, loop = temporal.lasso(raw)
    expected = {k: v for k, v in constants.items() if k != "Bug"}
    maximum = Counter()
    for record in behavior:
        budget(deadline)
        require(record["constants"] == expected and record["control"]["bug"] == "none",
                "trace constants/control mismatch")
        state = record["state"]
        counts = Counter((r["item"], r["part"]) for r in state["p"]["sent"])
        require(set(counts) <= pairs and all(n <= 4 for n in counts.values()),
                "raw state leaves four-persisted-send recovery restriction")
        require(all(type(n) is int and n in {0, 1} for n in state["e"]["timers"].values())
                and all(type(n) is int and n == 0 for n in state["faults"].values()),
                "raw state leaves binary-timer/inactive-fault restriction")
        maximum |= counts
    complete = []
    for index, record in enumerate(behavior, 1):
        state = record["state"]
        if set(state["h"]["accepted"]) != items:
            continue
        if {tuple(ip) for ip in state["h"]["everDelivered"]} != pairs:
            continue
        if not pairs <= {tuple(ip) for ip in state["h"]["taken"]}:
            continue
        # Credits must identify actual take-in records after each first send.
        credited = set()
        for credit in state["h"]["credits"]:
            pair = tuple(credit["pair"])
            number = credit["record"]
            require(type(number) is int and 1 <= number <= len(state["a"]["log"]),
                    "receipt points outside actual transcript")
            receipt = state["a"]["log"][number - 1]
            sends = [send for n, send in enumerate(state["p"]["sent"], 1)
                     if (send["item"], send["part"]) == pair and n not in state["p"]["refused"]]
            require(sends and receipt["kind"] == "take-in" and tuple(receipt["text"]) == pair
                    and number > sends[0]["offset"], "part lacks an actual matching receipt")
            credited.add(pair)
        require(credited == pairs, "delivered work lacks every bounded part's credited receipt")
        complete.append(index)
    require(complete and set(maximum) == pairs, "missing bounded accepted items/taken-in delivered parts")
    budget(deadline)
    return {"loopStart": loop, "loopEnd": len(behavior), "completePositions": complete,
            "accepted": sorted(items), "parts": [list(ip) for ip in sorted(pairs)],
            "maximumPersistedSends": {str(list(ip)): maximum[ip] for ip in sorted(pairs)}}


def exported_lasso(raw, deadline):
    """Independently recompute EmitWorkTrace's duplicate-occurrence mapping.

    An omitted endpoint must equal the entire original loop-entry record. The
    incoming original edge keeps its label and source, and its destination has
    exactly the same state. Replay still has to prove original Next, fairness
    and the complete temporal goal; this mapping certifies none of those.
    """
    budget(deadline)
    behavior, loop = temporal.lasso(raw)
    count = len(behavior)
    if loop == count or behavior[-1] != behavior[loop - 1]:
        return raw
    nodes = {number: record for number, record in raw["counterexample"]["state"]}
    result = dict(raw, behavior=behavior[:-1], counterexample={
        "state": [node for node in raw["counterexample"]["state"] if node[0] != count],
        "action": [[start, label, [loop, nodes[loop]] if end[0] == count else end]
                   for start, label, end in raw["counterexample"]["action"]
                   if start[0] != count]})
    temporal.lasso(result)
    budget(deadline)
    return result


def traces(log, deadline, prefix="TRACE "):
    budget(deadline)
    result = []
    for line in log.splitlines():
        budget(deadline)
        if line.startswith('"' + prefix):
            line = json.loads(line)
        if line.startswith(prefix):
            result.append(json.loads(line[len(prefix):]))
    require(len(result) == 1, "missing/ambiguous raw accepted-work trace")
    budget(deadline)
    return result[0]


def execution_locations(java, jar, directory):
    return {"java": str(Path(java).resolve()), "jar": str(Path(jar).resolve()),
            "workdir": str(Path(directory).resolve())}


def recorded_locations(payload):
    """Validate recorded execution paths without resolving them on this host."""
    locations = payload.get("executionLocations")
    require(isinstance(locations, dict) and set(locations) == {"java", "jar", "workdir"},
            "missing recorded checker execution locations")
    for value in locations.values():
        require(isinstance(value, str) and Path(value).is_absolute()
                and str(Path(value)) == value and ".." not in Path(value).parts,
                "invalid recorded checker execution location")
    require(len(set(locations.values())) == 3, "ambiguous recorded checker execution locations")
    return locations


def check_run(proof, module, cfg, target, java, jar, directory, deadline):
    budget(deadline)
    require(proof.get("argv") == command(java, jar, directory, directory.name == "search")
            and proof.get("moduleSha256") == temporal.sha(module.encode())
            and proof.get("cfgSha256") == temporal.sha(cfg.encode()),
            "missing/stale executed checker inputs")
    log = proof.get("log")
    require(isinstance(log, str) and proof.get("logSha256") == temporal.sha(log.encode()),
            "missing/changed checker log")
    errors = {"Error: Temporal property " + target + " was violated.",
              "Error: The following behavior constitutes a counter-example:"}
    require(proof.get("exitCode") == 13 and "Finished in" in log
            and ("Temporal property " + target + " was violated.") in log
            and all(line in errors for line in log.splitlines() if line.startswith("Error:")),
            "checker did not finish with the designated witness counterexample")
    require(isinstance(proof.get("seconds"), (float, int)) and 0 <= proof["seconds"] <= 120,
            "missing/out-of-budget checker execution")
    times = [proof.get(key) for key in ("startedMonotonic", "finishedMonotonic", "rowDeadline")]
    require(all(type(value) in (int, float) and math.isfinite(value) for value in times)
            and times[0] <= times[1] < times[2]
            and proof["seconds"] == times[1] - times[0],
            "missing execution timing or checker completed after row deadline")
    budget(deadline)


def verify_payload(source, cfg, jar, java, workdir, payload, deadline):
    """Recompute evidence; ignore caller summaries. Does not launch a checker.

    Retained run.log files and raw trace must match the payload. The caller's
    frozen source/jar/helper pins and job artifact provenance remain mandatory.
    """
    budget(deadline)
    directory = Path(workdir).resolve()
    bound, constants, source_bytes = binding(source, cfg, jar, java, deadline)
    require(isinstance(payload, dict) and payload.get("binding") == bound,
            "missing/stale accepted-work evidence")
    locations = recorded_locations(payload)
    raw = payload["raw"]
    summary = raw_coverage(raw, bound["constants"], deadline)
    modules = {"search": search_inputs(constants), "replay": replay_inputs(constants, raw, deadline)}
    budget(deadline)
    for kind, (module, derived_cfg) in modules.items():
        check_run(payload[kind], module, derived_cfg,
                  "NotFairWork" if kind == "search" else "NotWitness",
                  locations["java"], locations["jar"], Path(locations["workdir"]) / kind,
                  deadline)
        require(payload[kind]["rowDeadline"] == payload.get("executionDeadline"),
                "checker did not share the original row deadline")
        require((directory / kind / "run.log").read_bytes() == payload[kind]["log"].encode()
                and (directory / kind / "proof.json").read_bytes() == temporal.canonical(payload[kind])
                and (directory / kind / "PersonaDelivery.tla").read_bytes() == source_bytes
                and (directory / kind / ("FairWorkWitness.tla" if kind == "search" else
                                          "TemporalReplay.tla")).read_text() == module
                and (directory / kind / "witness.cfg").read_text() == derived_cfg,
                "missing/changed retained checker artifacts")
        budget(deadline)
    require(payload["search"]["finishedMonotonic"] <= payload["replay"]["startedMonotonic"],
            "overlapping accepted-work checker processes")
    require(traces(payload["search"]["log"], deadline) == raw
            and (directory / "raw-trace.json").read_bytes() == temporal.canonical(raw),
            "raw trace differs from executed search output")
    source_trace = traces(payload["search"]["log"], deadline, "WITNESS_SOURCE_TRACE ")
    require(exported_lasso(source_trace, deadline) == raw
            and (directory / "search-source-trace.json").read_bytes()
                == temporal.canonical(source_trace),
            "search export changed original states, action labels or lasso mapping")
    proof = temporal.parse_proof(payload["replay"], *modules["replay"],
                                 range(1, summary["loopEnd"] + 1))
    require(all(type(value) is bool for state in proof["states"].values()
                for value in [state["constrained"], state["recordMatches"], state["typable"],
                              *state["enabled"].values()])
            and all(type(value) is bool for edge in proof["edges"].values()
                    for value in [edge["legal"], *edge["fired"].values()]),
            "nonboolean original-action replay evaluation")
    require(proof["witness"] and all(r["legal"] is True for r in proof["edges"].values()),
            "original Init/Next/premise/assumption witness or closing edge failed")
    fair = temporal.fairness(proof, summary["loopStart"], summary["loopEnd"], "none")
    require(all(v["satisfied"] for v in fair.values()), "original-action fairness failed")
    summary.update(scope=SCOPE, fairness=fair, binding=bound,
                   traceSha256=temporal.sha(temporal.canonical(raw)),
                   sourceTraceSha256=temporal.sha(temporal.canonical(source_trace)),
                   terminalDuplicateOmitted=len(source_trace["behavior"]) != summary["loopEnd"],
                   exhaustivePositiveCertification=False)
    budget(deadline)
    return summary


def command(java, jar, directory, search):
    return [str(java), "-Xmx384m", "-XX:MaxDirectMemorySize=128m",
            "-XX:ActiveProcessorCount=1", "-cp", str(jar), "tlc2.TLC",
            "-deadlock", "-workers", "1", "-noGenerateSpecTE", "-metadir",
            str(directory / "states"), "-config", "witness.cfg",
            "FairWorkWitness.tla" if search else "TemporalReplay.tla"]


def write(path, data, deadline):
    budget(deadline)
    temporal.write_bytes(path, data)
    budget(deadline)


def execute(source_bytes, module, cfg, java, jar, directory, deadline, search):
    budget(deadline)
    directory.mkdir(parents=True, exist_ok=False)
    write(directory / "PersonaDelivery.tla", source_bytes, deadline)
    write(directory / ("FairWorkWitness.tla" if search else "TemporalReplay.tla"), module.encode(), deadline)
    write(directory / "witness.cfg", cfg.encode(), deadline)
    locations = execution_locations(java, jar, directory.parent)
    argv = command(locations["java"], locations["jar"], directory, search)
    started = time.monotonic()
    try:
        # Recalculate immediately before launch, after ALL input preparation.
        result = temporal.run_checker(argv, cwd=directory, timeout=min(120, budget(deadline)))
        output, code = result.stdout, result.returncode
    except subprocess.TimeoutExpired as error:
        # subprocess.run kills and reaps its child before this exception returns.
        output, code = error.stdout or b"", None
    finished = time.monotonic()
    elapsed = finished - started
    temporal.write_bytes(directory / "run.log", output)
    proof = {"argv": argv, "seconds": elapsed, "exitCode": code,
             "startedMonotonic": started, "finishedMonotonic": finished, "rowDeadline": deadline,
             "moduleSha256": temporal.sha(module.encode()), "cfgSha256": temporal.sha(cfg.encode()),
             "logSha256": temporal.sha(output), "log": output.decode()}
    # Preserve proof even on timeout/late completion; never manufacture success.
    temporal.write_bytes(directory / "proof.json", temporal.canonical(proof))
    budget(deadline)
    if code is None:
        raise WitnessIncomplete("accepted-work checker exhausted its 120-second proof chunk")
    return proof


def generate_and_verify(source, cfg, jar, java, workdir, deadline):
    """Return {binding, raw, search, replay, summary}; persist all proof artifacts.

    workdir must not exist. The probe/core caller supplies its existing absolute
    row deadline and retains the bundle separately from its primary row trace.
    Errors propagate and cannot count as positive nonvacuity. No TLC scratch is
    removed here, so genuine filesystem errors and partial proofs survive.
    """
    budget(deadline)
    directory = Path(workdir).resolve()
    bound, constants, source_bytes = binding(source, cfg, jar, java, deadline)
    directory.mkdir(parents=True, exist_ok=False)
    locations = execution_locations(java, jar, directory)
    payload = {"binding": bound, "executionDeadline": deadline,
               "executionLocations": locations}
    try:
        module, derived_cfg = search_inputs(constants)
        payload["search"] = execute(source_bytes, module, derived_cfg, java, jar,
                                    directory / "search", deadline, True)
        check_run(payload["search"], module, derived_cfg, "NotFairWork",
                  locations["java"], locations["jar"],
                  directory / "search", deadline)
        payload["raw"] = traces(payload["search"]["log"], deadline)
        source_trace = traces(payload["search"]["log"], deadline, "WITNESS_SOURCE_TRACE ")
        write(directory / "search-source-trace.json", temporal.canonical(source_trace), deadline)
        require(exported_lasso(source_trace, deadline) == payload["raw"],
                "search export changed original states, action labels or lasso mapping")
        budget(deadline)
        write(directory / "raw-trace.json", temporal.canonical(payload["raw"]), deadline)
        raw_coverage(payload["raw"], bound["constants"], deadline)
        module, derived_cfg = replay_inputs(constants, payload["raw"], deadline)
        budget(deadline)
        payload["replay"] = execute(source_bytes, module, derived_cfg, java, jar,
                                    directory / "replay", deadline, False)
        payload["summary"] = verify_payload(source, cfg, jar, java, directory, payload, deadline)
        budget(deadline)
    finally:
        # Failure evidence is retained even when the absolute deadline elapsed.
        temporal.write_bytes(directory / "evidence.json", temporal.canonical(payload))
    budget(deadline)
    return payload


LOADED_SOURCE_SHA256 = temporal.sha(Path(__file__).read_bytes())
