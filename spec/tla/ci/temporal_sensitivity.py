#!/usr/bin/env python3
"""Exact concrete-lasso checks for temporal controls, using the original actions.

The caller owns the checker budget and frozen source directory. This module
never submits jobs. A VIEW counterexample is a candidate, not a concrete proof:
replaying only its action/outcome labels does not validate its exported states.
"""
from __future__ import annotations

import hashlib
import json
from pathlib import Path
import re
import subprocess
import sys
import time


class SensitivityRefusal(ValueError):
    pass


class SensitivityIncomplete(SensitivityRefusal):
    """A bounded proof chunk ran out of time, without a semantic verdict."""


def require(condition, message):
    if not condition:
        raise SensitivityRefusal(message)


def canonical(value):
    return (json.dumps(value, sort_keys=True, separators=(",", ":")) + "\n").encode()


def sha(data):
    return hashlib.sha256(data).hexdigest()


def remaining(deadline, seconds):
    left = seconds if deadline is None else min(seconds, deadline - time.monotonic())
    if left <= 0:
        raise SensitivityIncomplete("temporal sensitivity exhausted the row budget")
    return left


def proof_chunk(deadline, seconds, parts=1):
    """Share the original remaining row time, keeping later proofs a turn.

    A chunk is at most sixty seconds, even for canonical 1800-second rows.
    Preparation, validation and cleanup still consume the caller's deadline.
    Explicit smaller diagnostic budgets remain supported.
    """
    require(0 < seconds <= 60 and parts >= 1, "invalid temporal proof budget")
    left = remaining(deadline, 1800) if deadline is not None else seconds
    return min(seconds, left / parts)


def run_checker(argv, *, cwd, timeout):
    """Local screens share their storage watchdog; canonical workers keep theirs."""
    local = sys.modules.get("_tla_local_storage")
    try:
        execute = local.run if local is not None else subprocess.run
        return execute(argv, cwd=cwd, stdout=subprocess.PIPE,
                       stderr=subprocess.STDOUT, timeout=timeout)
    finally:
        if local is not None:
            import shutil
            states = Path(cwd) / "states"
            if states.exists():
                shutil.rmtree(states)


def write_bytes(path, data):
    local = sys.modules.get("_tla_local_storage")
    if local is not None:
        if len(data) > 64 * 1024**2:
            raise ValueError("local helper file limit exceeded")
        local.check(len(data) + 4096)
    path.write_bytes(data)


SET_FIELDS = {"accepted", "fixed", "refused", "delivered", "everSent",
              "everDelivered", "acked", "credited", "expired", "noticed", "receipts",
              "Faults", "engineActions", "controlActions", "expiredTimers"}
FAIR_ACTIONS = {"observe": "EngineObserve /\\ EnvTypable", "engine": "EngineStep",
                "gate": "GateStep", "reconnect": "ReconnectStep",
                "takeIn": "AgentTakeIn", "turnEnd": "AgentTurnEnd",
                "completeReconnect": "AgentCompletesReconnect"}
STRONG = {"observe", "reconnect", "takeIn"}
TARGETS = {"keep_gate": {"GateFreeInfinitelyOften"},
           "hold_gate_mcp": {"ReconnectNotBlocked", "EventuallyDelivered"},
           "no_deferred": {"ReconnectNotBlocked"},
           "deferred_only_open": {"ReconnectNotBlocked"},
           "park_retype": {"EventuallyDelivered"},
           "unreadable_park": {"HeadTakenIn"},
           "weak_observe": {"EventuallyDelivered"},
           "replace_observation": {"EventuallyDelivered"},
           "none": {"HeadTakenIn"}}


def tla(value, field=""):
    """Reconstruct the model's records, sequences and named set fields exactly."""
    if isinstance(value, bool):
        return "TRUE" if value else "FALSE"
    if isinstance(value, int) and not isinstance(value, bool):
        return str(value)
    if isinstance(value, str):
        return json.dumps(value, ensure_ascii=True)
    if isinstance(value, dict):
        require(value and all(re.fullmatch(r"[A-Za-z][A-Za-z0-9_]*", k) for k in value),
                "unsupported state record")
        return "[" + ",".join(k + " |-> " + tla(v, k) for k, v in sorted(value.items())) + "]"
    if isinstance(value, list):
        values = [tla(v) for v in value]
        if field in SET_FIELDS:
            require(len(values) == len(set(values)), "duplicate member in state set")
            return "{" + ",".join(sorted(values)) + "}"
        return "<<" + ",".join(values) + ">>"
    raise SensitivityRefusal("unsupported state value")


def tla_values(values):
    """Share identical immutable snapshots to keep small-heap SANY bounded."""
    definitions, seen = [], {}
    def emit(value, field=""):
        if not isinstance(value, (dict, list)):
            return tla(value, field)
        key = (field in SET_FIELDS, canonical(value))
        if key in seen:
            return seen[key]
        if isinstance(value, dict):
            require(value and all(re.fullmatch(r"[A-Za-z][A-Za-z0-9_]*", k) for k in value),
                    "unsupported state record")
            body = "[" + ",".join(k + " |-> " + emit(v, k) for k, v in sorted(value.items())) + "]"
        else:
            entries = [emit(v) for v in value]
            if field in SET_FIELDS:
                require(len(entries) == len(set(entries)), "duplicate member in state set")
                body = "{" + ",".join(sorted(entries)) + "}"
            else:
                body = "<<" + ",".join(entries) + ">>"
        name = "ReplayValue" + str(len(definitions) + 1)
        definitions.append(name + " == " + body)
        seen[key] = name
        return name
    names = [emit(value) for value in values]
    return "\n".join(definitions), names


def normalize_correct(value):
    """Change captured control identifiers only; retain every saved reading."""
    if isinstance(value, dict):
        return {key: ("none" if key == "bug" else False if key == "bugStep"
                      else normalize_correct(item)) for key, item in value.items()}
    if isinstance(value, list):
        return [normalize_correct(item) for item in value]
    return value


def lasso(raw):
    behavior = raw.get("behavior", [])
    require(behavior, "missing concrete behavior")
    nodes = raw.get("counterexample", {}).get("state", [])
    edges = raw.get("counterexample", {}).get("action", [])
    require(sorted(nodes, key=lambda n: n[0]) == [[i, r] for i, r in enumerate(behavior, 1)],
            "concrete graph/behavior mismatch")
    closing, forward = [], set()
    for edge in edges:
        require(isinstance(edge, list) and len(edge) == 3
                and edge[0] in nodes and edge[2] in nodes and isinstance(edge[1], dict),
                "invalid concrete edge")
        start, end = edge[0][0], edge[2][0]
        if end == start + 1:
            forward.add(start)
        elif start == len(behavior) and 1 <= end <= start:
            closing.append(end)
        else:
            raise SensitivityRefusal("invalid concrete edge order")
    require(len(closing) == 1 and forward == set(range(1, len(behavior)))
            and len(edges) == len(behavior), "incomplete concrete cycle")
    return behavior, closing[0]


def cfg_context(text):
    specs = re.findall(r"^SPECIFICATION (\w+)\s*$", text, re.M)
    targets = re.findall(r"^PROPERTY (\w+)\s*$", text, re.M)
    require(len(specs) == len(targets) == 1
            and specs[0] in {"Spec", "SpecWithoutHeadTakeInAssumption"},
            "unsupported temporal specification/target")
    bug = re.findall(r'^\s+Bug = "([^"\n]+)"\s*$', text, re.M)
    require(len(bug) == 1 and targets[0] in TARGETS.get(bug[0], set()),
            "unknown temporal control/target")
    require(re.findall(r"^CONSTRAINT (\w+)\s*$", text, re.M) == ["RestartStateConstraint"],
            "temporal replay needs the declared constraint")
    require(not re.search(r"^(?:ACTION_CONSTRAINT|SYMMETRY)\b", text, re.M),
            "unsupported temporal reduction")
    constants = text[text.index("CONSTANTS"):]
    constants = constants[:re.search(r"^(?:INVARIANT|PROPERTY|ALIAS|VIEW|CONSTRAINT|POSTCONDITION)\b",
                                   constants, re.M).start()]
    return specs[0], targets[0], bug[0], constants


def replay_inputs(cfg_text, raw, *, correct_cycle=False, positive=False):
    spec, target, bug, constants = cfg_context(cfg_text)
    behavior, loop = lasso(raw)
    states = [r["state"] for r in behavior]
    if correct_cycle or positive:
        states = normalize_correct(states)
        constants = re.sub(r'(^\s+Bug = )"[^"\n]+"', r'\1"none"', constants, flags=re.M)
    first = loop if correct_cycle else 1
    enabled = ",".join(key + " |-> ENABLED <<" + action + ">>_vars"
                       for key, action in FAIR_ACTIONS.items())
    fired = ",".join(key + " |-> <<" + action + ">>_vars"
                     for key, action in FAIR_ACTIONS.items())
    assumption = " /\\ TypableHeadTakeInAssumption" if spec == "Spec" else ""
    init = "Init /\\ " if not correct_cycle else ""
    matches = "TRUE" if correct_cycle else "TraceRecord(st) = ReplayRecords[position]"
    goal = target + " /\\ " + nonvacuity(target) if positive else "~" + target
    # Supporting positive contrasts are RAW existential behaviors. They do not
    # claim positive nonvacuity inside the canonical four-send recovery restriction.
    restriction = "" if positive or correct_cycle else " /\\ []RestartStateConstraint"
    library, (state_name, record_name) = tla_values([states, behavior])
    module = """---------------- MODULE TemporalReplay ----------------
EXTENDS PersonaDelivery
VARIABLE position
""" + library + """
ReplayStates == """ + state_name + """
ReplayRecords == """ + record_name + """
ReplaySuccessor == IF position = Len(ReplayStates) THEN """ + str(loop) + """ ELSE position+1
ReplayInit == position = """ + str(first) + """ /\\ st = ReplayStates[position]
ReplayNext == /\\ position' = ReplaySuccessor
              /\\ st' = ReplayStates[position']
              /\\ PrintT("SENSITIVITY_EDGE " \\o ToJson(
                    [position |-> position, legal |-> [Next]_vars,
                     fired |-> [""" + fired + """ ]]))
ReplaySpec == ReplayInit /\\ [][ReplayNext]_<<st,position>> /\\ WF_<<st,position>>(ReplayNext)
Evidence == PrintT("SENSITIVITY_STATE " \\o ToJson(
 [position |-> position, enabled |-> [""" + enabled + """],
  constrained |-> RestartStateConstraint, typable |-> EnvTypable,
  recordMatches |-> """ + matches + """,
  engineChoice |-> EngineChoice(ReplayKnowledgeOf(st)),
  gateChoice |-> GateChoice(KnowledgeOf(st))]))
NotWitness == ~(""" + init + "Fairness" + assumption + restriction + " /\\ " + goal + """ )
========================================================
"""
    cfg = "SPECIFICATION ReplaySpec\n" + constants + "INVARIANT Evidence\nPROPERTY NotWitness\n"
    return module, cfg, first, loop


def nonvacuity(target):
    if target == "ReconnectNotBlocked":
        return "<>(st.g.deferred /\\ <>(st.g.typed \\/ st.a.mcp))"
    if target == "GateFreeInfinitelyOften":
        return '<>(st.g.owner = "delivery") /\\ <>(st.h.everSent # {})'
    if target == "HeadTakenIn":
        return "[]<>EnvTypable /\\ ReconnectsDue /\\ <>(\\E ip \\in Pairs : Taken(ip))"
    return "Premise /\\ <>(\\E i \\in Items : ItemDelivered(i))"


ADAPTIVE_TRANSITIONS = {"EngineObserve", "EngineStep", "GateStep", "ReconnectStep",
                        "AgentTakeIn", "AgentTurnEnd", "AgentCompletesReconnect", "Done",
                        "QueueCompactRename", "QueueCompactFinish"}


def external_schedule(raw):
    """The same exogenous events, with correct actions and fair responses free.

    Keep even fault outcomes that execute through EngineStep. Taking in text,
    ending a turn and completing reconnect are responses, rather than a demand
    to keep starving a corrected engine at precisely the mutant's key calls.
    """
    behavior, loop = lasso(raw)
    prefix, cycle = [], []
    for pos, before in enumerate(behavior, 1):
        after = behavior[pos if pos < len(behavior) else loop-1]
        old, new = before["state"], after["state"]
        delta = {key: value - old["faults"][key] for key, value in new["faults"].items()}
        if new["transition"] in ADAPTIVE_TRANSITIONS and not any(delta.values()):
            continue
        transition = new["transition"]
        if transition == "AgentDrop" and old["a"]["box"] != [0, 0]:
            subject = old["a"]["box"]
        elif transition in {"AgentDrop", "PullBack"}:
            subject = old["a"]["input"][0]
        elif transition in {"PersonSubmit", "PersonClear", "QueueMidTurn"}:
            subject = old["a"]["box"]
        elif transition in {"EngineStep", "LostEnter"} and any(delta.values()):
            subject = old["e"]["target"]
        elif transition == "Accept":
            subject = [new["w"]["item"], 0]
        else:
            subject = [0, 0]
        # An unknown-outcome fault must keep both its affected item/part and
        # the nondeterministic decision whether keys actually reached the bot.
        arguments = {"subject": subject,
                     "keysOccurred": len(new["h"]["keys"]) > len(old["h"]["keys"])}
        signature = [transition, new["action"], new["outcome"], delta, arguments]
        (prefix if pos < loop else cycle).append(signature)
    return prefix, cycle


def same_schedule(left, right):
    """Decide equality of two finite-prefix/periodic event streams."""
    lp, lc = external_schedule(left)
    rp, rc = external_schedule(right)
    if not lc or not rc:
        return not lc and not rc and lp == rp
    # Product of period lengths bounds the point where both phases repeat.
    count = max(len(lp), len(rp)) + len(lc) * len(rc)
    def event(prefix, cycle, index):
        return prefix[index] if index < len(prefix) else cycle[(index-len(prefix)) % len(cycle)]
    return all(event(lp, lc, i) == event(rp, rc, i) for i in range(count))


def environment_inputs(cfg_text, raw):
    spec, target, _, constants = cfg_context(cfg_text)
    constants = re.sub(r'(^\s+Bug = )"[^"\n]+"', r'\1"none"', constants, flags=re.M)
    prefix, cycle = external_schedule(raw)
    steps = prefix + cycle
    next_pos = str(len(prefix) + 1) if cycle else "Len(EnvironmentSteps)+1"
    assumption = " /\\ TypableHeadTakeInAssumption" if spec == "Spec" else ""
    # The search must consume the prefix and keep executing cyclic events:
    # fairness alone is vacuous if an unconsumed event becomes disabled.
    progress = ("[]<><<ContrastNext /\\ ~AdaptiveTransition>>_<<st,environmentPosition>>"
                if cycle else "<>(environmentPosition = Len(EnvironmentSteps)+1)")
    # Preserve prefix priority. Between recurring untargeted events, prefer
    # productive engine steps instead of branching at every idle window.
    # Removing launch-settle steps otherwise makes the weak-observe contrast
    # search exceed its chunk. Wait/absent choices must still let events run.
    # This selects an existential witness only: exact original-Next replay,
    # the same external schedule, fairness and target checks remain mandatory.
    module = """---------------- MODULE EnvironmentContrast ----------------
EXTENDS PersonaDelivery
VARIABLE environmentPosition
EnvironmentSteps == """ + tla(steps) + """
AdaptiveTransition == st'.transition \\in """ + "{" + ",".join(tla(x) for x in sorted(ADAPTIVE_TRANSITIONS)) + "}" + """
                      /\\ st'.faults = st.faults
EnvironmentSubject ==
 CASE st'.transition = "AgentDrop" /\\ st.a.box # None -> st.a.box
 [] st'.transition \\in {"AgentDrop","PullBack"} -> Head(st.a.input)
 [] st'.transition \\in {"PersonSubmit","PersonClear","QueueMidTurn"} -> st.a.box
 [] st'.transition \\in {"EngineStep","LostEnter"} /\\ st'.faults # st.faults -> st.e.target
 [] st'.transition = "Accept" -> <<st'.w.item,0>>
 [] OTHER -> None
EnvironmentSignature == <<st'.transition,st'.action,st'.outcome,
 [f \\in FaultNames |-> st'.faults[f]-st.faults[f]],
 [subject |-> EnvironmentSubject, keysOccurred |-> Len(st'.h.keys) > Len(st.h.keys)]>>
ScheduledEnvironment == /\\ Next /\\ ~AdaptiveTransition
                        /\\ environmentPosition <= Len(EnvironmentSteps)
                        /\\ EnvironmentSignature = EnvironmentSteps[environmentPosition]
AdaptiveEngine == EngineStep /\\ st'.faults = st.faults
Guide == CASE EnvTypable /\\ ENABLED EngineObserve -> EngineObserve
         [] ENABLED GateStep -> GateStep
         [] ENABLED ReconnectStep -> ReconnectStep
         [] ENABLED AgentCompletesReconnect -> AgentCompletesReconnect
         [] ENABLED ScheduledEnvironment /\\ EnvironmentSteps[environmentPosition][5].subject # None -> ScheduledEnvironment
         [] ENABLED AgentTakeIn -> AgentTakeIn
         [] ENABLED ScheduledEnvironment ->
              IF environmentPosition > """ + str(len(prefix)) + """ /\\
                 EngineChoice(StepKnowledge) \\notin {"wait","stopAbsent"} /\\ ENABLED AdaptiveEngine
              THEN AdaptiveEngine ELSE ScheduledEnvironment
         [] ENABLED AdaptiveEngine -> AdaptiveEngine
         [] ENABLED AgentTurnEnd -> AgentTurnEnd
         [] OTHER -> EngineObserve \\/ Done
ContrastInit == Init /\\ environmentPosition = 1
ContrastNext == /\\ Next /\\ Guide
                /\\ IF AdaptiveTransition THEN environmentPosition' = environmentPosition
                    ELSE /\\ environmentPosition <= Len(EnvironmentSteps)
                         /\\ EnvironmentSignature = EnvironmentSteps[environmentPosition]
                         /\\ environmentPosition' = IF environmentPosition = Len(EnvironmentSteps)
                                                   THEN """ + next_pos + """ ELSE environmentPosition+1
ContrastSpec == ContrastInit /\\ [][ContrastNext]_<<st,environmentPosition>>
                /\\ SF_<<st,environmentPosition>>(ContrastNext /\\ ~AdaptiveTransition)
NotGood == ~(Fairness""" + assumption + " /\\ " + target + " /\\ " + nonvacuity(target) + " /\\ " + progress + """ )
========================================================
"""
    cfg = ("SPECIFICATION ContrastSpec\n" + constants + "PROPERTY NotGood\n"
           "ALIAS TraceView\nPOSTCONDITION EmitTrace\n")
    return module, cfg


def validate_contrast(root, row, raw, evidence):
    contrast = evidence.get("correctEnvironment", {})
    candidate = contrast.get("raw")
    require(isinstance(candidate, dict) and same_schedule(raw, candidate),
            "missing correct behavior under the same exogenous schedule")
    module, cfg, _, _ = replay_inputs((root / row["cfg_path"]).read_text(), candidate, positive=True)
    behavior, loop = lasso(candidate)
    require(contrast.get("scope") == "raw-existential-correct-behavior",
            "correct contrast must declare its raw existential scope")
    proof = parse_proof(contrast["proof"], module, cfg, range(1, len(behavior) + 1), bounded=False)
    require(proof["witness"] and all(r["legal"] for r in proof["edges"].values())
            and all(v["satisfied"] for v in fairness(proof, loop, len(behavior), "none").values()),
            "correct environment contrast is not legal, fair, nonvacuous and target satisfying")
    return {"traceSha256": sha(canonical(candidate)), "loopStart": loop,
            "loopEnd": len(behavior), "sameExogenousSchedule": True,
            "property": row["props"], "nonvacuous": True,
            "scope": "raw-existential-correct-behavior",
            "universalProgress": False, "boundedPositiveNonvacuity": False}


def bindings(root, row, raw):
    require(sha(Path(__file__).read_bytes()) == LOADED_SOURCE_SHA256,
            "temporal helper changed after import")
    cfg = (root / row["cfg_path"]).read_bytes()
    spec, target, bug, _ = cfg_context(cfg.decode())
    require(row["props"] == target and row["properties"] == [target]
            and row["expect"] == "violation", "temporal row target mismatch")
    return {"schema": 1, "cfg": row["cfg"], "target": target, "specification": spec,
            "bug": bug, "traceSha256": sha(canonical(raw)),
            "sourceSha256": sha((root / row["spec_path"]).read_bytes()),
            "cfgSha256": sha(cfg), "jarSha256": sha((root / "tla2tools.jar").read_bytes()),
            "helperSha256": sha(Path(__file__).read_bytes())}


def parse_proof(proof, module, cfg, positions, *, bounded=True):
    require(proof.get("moduleSha256") == sha(module.encode())
            and proof.get("cfgSha256") == sha(cfg.encode()), "changed replay inputs")
    log = proof.get("log", "")
    require(isinstance(log, str) and proof.get("logSha256") == sha(log.encode()),
            "changed replay log")
    if proof.get("exitCode") is None:
        raise SensitivityIncomplete("exact temporal replay exhausted its proof chunk")
    allowed_errors = {"Error: Temporal property NotWitness was violated.",
                      "Error: The following behavior constitutes a counter-example:"}
    require("Finished in" in log and all(line in allowed_errors for line in log.splitlines()
                                         if line.startswith("Error:")),
        "incomplete or erroneous replay")
    violation = "Temporal property NotWitness was violated" in log
    # TLC's pinned jar prints a generic temporal error followed by the property.
    violation = violation or ("Temporal properties were violated" in log
                              and "NotWitness" in log)
    require(proof.get("exitCode") == (13 if violation else 0), "replay exit/result mismatch")
    if not violation:
        require("Model checking completed. No error has been found." in log,
                "replay did not finish exhaustively")
    states, edges = {}, {}
    for line in log.splitlines():
        if line.startswith('"SENSITIVITY_'):
            line = json.loads(line)
        for prefix, destination in (("SENSITIVITY_STATE ", states), ("SENSITIVITY_EDGE ", edges)):
            if line.startswith(prefix):
                record = json.loads(line[len(prefix):])
                pos = record["position"]
                require(pos not in destination or destination[pos] == record,
                        "nondeterministic replay evidence")
                destination[pos] = record
    require(set(states) == set(edges) == set(positions), "incomplete replay evaluations")
    if bounded:
        require(all(r["constrained"] for r in states.values()), "concrete state leaves constraint")
    require(all(r["recordMatches"] for r in states.values()), "exported record differs from original source")
    require(all(set(r["enabled"]) == set(FAIR_ACTIONS) for r in states.values())
            and all(set(r["fired"]) == set(FAIR_ACTIONS) for r in edges.values()),
            "missing original fair actions")
    return {"witness": violation, "states": states, "edges": edges}


def fairness(proof, loop, end, bug):
    result = {}
    for action in FAIR_ACTIONS:
        enabled = [p for p in range(loop, end + 1) if proof["states"][p]["enabled"][action]]
        fired = [p for p in range(loop, end + 1) if proof["edges"][p]["fired"][action]]
        strong = action in STRONG and not (action == "observe" and bug == "weak_observe")
        required = bool(enabled) if strong else len(enabled) == end - loop + 1
        result[action] = {"kind": "SF" if strong else "WF", "enabledPositions": enabled,
                          "firedPositions": fired, "satisfied": not required or bool(fired)}
    return result


def validate_evidence(root, row, raw, evidence, *, require_contrast=False):
    """Recompute the schema and causal gates; do not trust summary booleans."""
    bound = bindings(root, row, raw)
    require(isinstance(evidence, dict) and evidence.get("binding") == bound,
            "missing/stale temporal sensitivity evidence")
    cfg_text = (root / row["cfg_path"]).read_text()
    behavior, loop = lasso(raw)
    end, bug = len(behavior), bound["bug"]
    mutant_inputs = replay_inputs(cfg_text, raw)
    mutant = parse_proof(evidence["mutant"], *mutant_inputs[:2], range(1, end + 1))
    require(mutant["witness"] and all(r["legal"] for r in mutant["edges"].values()),
            "not an authentic complete concrete target counterexample")
    mutant_fairness = fairness(mutant, loop, end, bug)
    require(all(r["satisfied"] for r in mutant_fairness.values()), "original action fairness failed")
    result = {"schema": 1, "binding": bound, "loopStart": loop, "loopEnd": end,
              "fairness": mutant_fairness, "omissionStates": [], "causalCycleEdges": []}
    if bug == "none":
        require(behavior[0]["constants"]["Scenario"] == "control-no-assumption"
                and bound["specification"] == "SpecWithoutHeadTakeInAssumption",
                "wrong environment-assumption control")
        require(not any(r["state"]["h"]["taken"] for r in behavior)
                and {r["state"]["a"]["permission"] for r in behavior[loop-1:]} == {True, False}
                and all(not any(r["state"]["faults"].values()) for r in behavior),
                "missing permission-starvation context")
        result["kind"] = "environment-assumption"
        return result
    def finish(kind, **fields):
        result.update(kind=kind, **fields)
        if require_contrast or "correctEnvironment" in evidence:
            result["correctEnvironment"] = validate_contrast(root, row, raw, evidence)
        return result
    correct_inputs = replay_inputs(cfg_text, raw, correct_cycle=True)
    correct = parse_proof(evidence["correctCycle"], *correct_inputs[:2], range(loop, end + 1), bounded=False)
    require(not (correct["witness"] and all(r["legal"] for r in correct["edges"].values())),
            "same operational cycle is a legal fair target violation under Bug=none")
    cf = fairness(correct, loop, end, "none")
    result["correctFairness"] = cf
    invalid = [p for p in range(loop, end + 1) if not correct["edges"][p]["legal"]]
    result["correctCycleIllegalEdges"] = invalid
    result["correctCycleUnfairActions"] = [k for k, v in cf.items() if not v["satisfied"]]
    if bug == "weak_observe":
        require(not cf["observe"]["satisfied"] and mutant_fairness["observe"]["satisfied"]
                and not invalid and all(v["satisfied"] for k, v in cf.items() if k != "observe"),
                "weak-observe lacks the WF/SF sensitivity contrast")
        return finish("fairness", omissionStates=cf["observe"]["enabledPositions"])
    if bug == "replace_observation":
        wrong = []
        for pos in invalid:
            before = behavior[pos-1]["state"]
            after = behavior[(pos if pos < end else loop-1)]["state"]
            if after["transition"] == "EngineObserve" and (
                    before["observation"] != "none" or
                    (before["e"]["request"] == "delivery" and before["g"]["owner"] == "free")):
                wrong.append(pos)
        require(wrong, "replacement lacks an actual forbidden observation on the cycle")
        return finish("scheduling", causalCycleEdges=wrong)
    # Executed sensitivity must affect the repeating cycle, not an unrelated prefix.
    wrong = []
    for pos in invalid:
        before = behavior[pos-1]
        after = behavior[pos if pos < end else loop-1]
        engine = (after["transition"] == "EngineStep"
                  and after["executedAction"] == before["EngineChoice"]
                  and before["EngineChoice"] != before["correctEngineChoice"])
        gate = (after["transition"] == "GateStep"
                and after["executedAction"] == before["GateChoice"]
                and before["GateChoice"] != before["correctGateChoice"])
        if engine or gate:
            wrong.append(pos)
    if wrong:
        return finish("executed-choice", causalCycleEdges=wrong)
    if bug in {"keep_gate", "hold_gate_mcp"}:
        positions = list(range(loop, end + 1))
        require(cf["gate"]["enabledPositions"] == positions
                and not cf["gate"]["firedPositions"]
                and not mutant_fairness["gate"]["enabledPositions"]
                and all(correct["states"][p]["gateChoice"] == "release" for p in positions)
                and all(behavior[p-1]["state"]["g"]["owner"] == "delivery" for p in positions),
                "release omission is not continuously enabled on the cycle")
        if bug == "hold_gate_mcp":
            require(all(not behavior[p-1]["state"]["a"]["mcp"]
                        and behavior[p-1]["state"]["g"]["deferred"] for p in positions),
                    "MCP hold lacks a pending disconnected reconnect")
        return finish("omitted-release", omissionStates=positions,
                      omittedAction="GateStep", omittedFairness="WF")
    if bug in {"no_deferred", "deferred_only_open"}:
        positions = cf["reconnect"]["enabledPositions"]
        require(positions and not cf["reconnect"]["firedPositions"]
                and not mutant_fairness["reconnect"]["enabledPositions"]
                and all(not r["state"]["a"]["mcp"] and r["state"]["g"]["deferred"]
                        and not r["state"]["g"]["typed"] for r in behavior[loop-1:]),
                "reconnect omission lacks recurrent full-action enabledness")
        if bug == "deferred_only_open":
            initial = behavior[0]["state"]
            require(behavior[0]["constants"]["Scenario"] == "empty-reconnect"
                    and not initial["a"]["mcp"] and initial["g"]["deferred"]
                    and not initial["p"]["accepted"]
                    and all(not r["state"]["p"]["accepted"] for r in behavior[loop-1:]),
                    "empty-queue reconnect lost its obstructed startup context")
        return finish("omitted-reconnect", omissionStates=positions,
                      omittedAction="ReconnectStep", omittedFairness="SF")
    raise SensitivityRefusal("no on-cycle causal executed choice or fair-action omission")


def candidate_inputs(cfg_text, raw):
    """Use VIEW labels to search for a NEW behavior under full original Next.

    This does not assert that the VIEW states have a concrete lifting. Only the
    newly exported candidate can pass the exact replay and causal checks.
    """
    spec, target, _, constants = cfg_context(cfg_text)
    behavior, loop = lasso(raw)
    steps = []
    for position in range(len(behavior)):
        after = behavior[position + 1 if position + 1 < len(behavior) else loop - 1]
        steps.append([after["transition"], after["executedAction"], after["outcome"]])
    stutter = behavior[-1]["state"] == behavior[loop - 1]["state"]
    closing = next(edge for edge in raw["counterexample"]["action"] if edge[2][0] <= edge[0][0])
    closing_action = closing[1].get("name")
    original_closing = closing_action in {
        "EngineObserve", "EngineStep", "EngineStepSuccessful", "GateStep", "ReconnectStep",
        "AgentTakeIn", "AgentTurnEnd", "AgentCompletesReconnect", "AgentOwnTurnStart",
        "PermissionOpen", "PermissionAnswer", "Done"}
    # TLC's VIEW closing edge names the action actually taken, while its target
    # record may retain an unrelated earlier transition label. Guided concrete
    # handoffs instead name their wrapper; use their exported labels as a search
    # hint only. The outer original Next and exact replay remain mandatory.
    closing_expression = ("UNCHANGED st" if stutter else closing_action if original_closing
                          else "(Next /\\ st'.transition = CandidateSteps[position][1]"
                               " /\\ st'.action = CandidateSteps[position][2]"
                               " /\\ st'.outcome = CandidateSteps[position][3])")
    assumption = " /\\ TypableHeadTakeInAssumption" if spec == "Spec" else ""
    module = """---------------- MODULE ConcreteCandidate ----------------
EXTENDS PersonaDelivery
VARIABLE position
CandidateSteps == """ + tla(steps) + """
CandidateInit == Init /\\ position = 1
CandidateNext == /\\ [Next]_vars
                 /\\ position' = IF position = Len(CandidateSteps) THEN """ + str(loop) + """ ELSE position+1
                 /\\ IF position = Len(CandidateSteps) THEN """ + closing_expression + """
                     ELSE /\\ Next
                          /\\ st'.transition = CandidateSteps[position][1]
                          /\\ st'.action = CandidateSteps[position][2]
                          /\\ st'.outcome = CandidateSteps[position][3]
CandidateSpec == CandidateInit /\\ [][CandidateNext]_<<st,position>>
NotConcrete == ~(Fairness""" + assumption + " /\\ []RestartStateConstraint /\\ ~" + target + """ )
========================================================
"""
    return module, ("SPECIFICATION CandidateSpec\n" + constants + "PROPERTY NotConcrete\n"
                    "CONSTRAINT RestartStateConstraint\nALIAS TraceView\nPOSTCONDITION EmitTrace\n")


# Search-only adaptation of the independently audited MutationWitness guide.
# Frozen and pinned with this helper; no dependency on exploratory .runs files.
# The guide never supplies enabledness or fairness to the exact replay proof.
def targeted_candidate_inputs(cfg_text):
    spec, target, bug, constants = cfg_context(cfg_text)
    require(bug in {"park_retype", "unreadable_park", "hold_gate_mcp"}, "unsupported targeted candidate")
    assumption = " /\\ TypableHeadTakeInAssumption" if spec == "Spec" else ""
    module = r'''---------------- MODULE ConcreteCandidate ----------------
EXTENDS PersonaDelivery
TargetedMutationWitnessGuide ==
 CASE st.w.kind # "none" -> EngineStep
 [] st.h.accepted = {} /\ st.observation = "none" -> Accept
 [] st.e.phase = "text" /\ st.faults["textUnknown"] = 0 ->
      EngineCallFault /\ st'.outcome = "textUnknown" /\ st'.a.box = None
 [] Bug = "hold_gate_mcp" /\ st.faults["textUnknown"] > 0 /\
    st.faults["mcpDrop"] = 0 /\ st.g.owner = "delivery" -> MCPDrop
 [] Bug = "park_retype" /\ st.e.retypes[1] >= 1 /\ st.a.box # None /\
    st.faults["agentDrop"] = 0 -> AgentDrop
 [] Bug = "unreadable_park" /\ st.h.everSent # {} /\ st.e.phase = "ready" /\
    st.g.owner = "free" /\ st.a.transcript = "readable" -> Unreadable
 [] st.a.submitted /\ st.a.actual = "idle" -> AgentTakeIn
 [] st.a.actual # "idle" -> AgentTurnEnd
 [] st.g.owner = "delivery" /\ GateChoice(ObservedKnowledge) = "release" -> GateStep
 [] st.e.request = "delivery" /\ st.g.owner = "free" -> GateStep
 [] st.observation = "ready" \/ InternalContinuation -> EngineStep
 [] OTHER -> EngineObserve
CandidateNext == Next /\ TargetedMutationWitnessGuide
CandidateSpec == Init /\ [][CandidateNext]_vars
NotConcrete == ~(Fairness''' + assumption + " /\\ []RestartStateConstraint /\\ ~" + target + " )\n" + "=" * 56 + "\n"
    return module, ("SPECIFICATION CandidateSpec\n" + constants + "PROPERTY NotConcrete\n"
                    "CONSTRAINT RestartStateConstraint\nALIAS TraceView\nPOSTCONDITION EmitTrace\n")


def observation_replacement_candidate_inputs(cfg_text):
    """Exercise replacement of a waiting read before the engine consumes it.

    This only guides the search through original Next actions. Exact replay,
    raw action fairness and the same-schedule correct contrast still decide
    whether the exported candidate establishes the mutation's sensitivity.
    """
    spec, target, bug, constants = cfg_context(cfg_text)
    require(bug == "replace_observation", "unsupported observation candidate")
    assumption = " /\\ TypableHeadTakeInAssumption" if spec == "Spec" else ""
    module = r'''---------------- MODULE ConcreteCandidate ----------------
EXTENDS PersonaDelivery
TargetedMutationWitnessGuide ==
 CASE st.w.kind # "none" -> EngineStep
 [] st.h.accepted = {} /\ st.observation = "none" -> Accept
 [] st.observation = "ready" /\ st.knowledge.r.row = "waiting" /\
    st.a.row = "waiting" /\ EngineChoice(StepKnowledge) = "requestGate" -> AgentOwnTurnStart
 [] st.observation = "ready" /\ st.knowledge.r.row = "waiting" /\
    st.a.row = "working" -> EngineObserve
 [] st.observation = "ready" \/ InternalContinuation -> EngineStep
 [] st.a.actual # "idle" -> AgentTurnEnd
 [] OTHER -> EngineObserve
CandidateNext == Next /\ TargetedMutationWitnessGuide
CandidateSpec == Init /\ [][CandidateNext]_vars
NotConcrete == ~(Fairness''' + assumption + " /\\ []RestartStateConstraint /\\ ~" + target + " )\n" + "=" * 56 + "\n"
    return module, ("SPECIFICATION CandidateSpec\n" + constants + "PROPERTY NotConcrete\n"
                    "CONSTRAINT RestartStateConstraint\nALIAS TraceView\nPOSTCONDITION EmitTrace\n")


def candidate_search_inputs(cfg_text, raw):
    if cfg_context(cfg_text)[2] == "replace_observation":
        return "independent-targeted-guide", observation_replacement_candidate_inputs(cfg_text)
    if cfg_context(cfg_text)[2] in {"park_retype", "unreadable_park", "hold_gate_mcp"}:
        return "independent-targeted-guide", targeted_candidate_inputs(cfg_text)
    return "view-label-search", candidate_inputs(cfg_text, raw)


def search_trace(search, module, cfg):
    require(search.get("moduleSha256") == sha(module.encode())
            and search.get("cfgSha256") == sha(cfg.encode()), "changed candidate guide inputs")
    log = search.get("log", "")
    require(isinstance(log, str) and search.get("logSha256") == sha(log.encode()),
            "changed candidate search log")
    if search.get("exitCode") is None:
        raise SensitivityIncomplete("concrete candidate search exhausted its proof chunk")
    allowed = {"Error: Temporal property NotConcrete was violated.",
               "Error: The following behavior constitutes a counter-example:"}
    require(search.get("exitCode") == 13 and "Finished in" in log
            and "Temporal property NotConcrete was violated" in log
            and all(line in allowed for line in log.splitlines() if line.startswith("Error:")),
            "no complete concrete candidate from search")
    candidates = []
    for line in log.splitlines():
        if line.startswith('"TRACE '):
            line = json.loads(line)
        if line.startswith("TRACE "):
            candidates.append(json.loads(line[6:]))
    require(len(candidates) == 1, "missing or ambiguous candidate search trace")
    return candidates[0]


def validate_candidate_source(root, row, envelope):
    """Bind independent selection to its actual search and both saved traces."""
    raw, candidate = envelope["raw"], envelope["concreteCandidate"]
    source = envelope.get("candidateSource")
    require(isinstance(source, dict), "missing candidate source provenance")
    kind, (module, cfg) = candidate_search_inputs((root / row["cfg_path"]).read_text(), raw)
    require(source.get("schema") == 1 and source.get("kind") == kind
            and source.get("binding") == bindings(root, row, candidate)
            and source.get("viewTraceSha256") == sha(canonical(raw))
            and source.get("viewDisposition") == "retained-not-used-as-concrete-proof",
            "missing/stale candidate source provenance")
    require(search_trace(source.get("search", {}), module, cfg) == candidate,
            "concrete candidate differs from search export")
    return {"kind": kind, "moduleSha256": sha(module.encode()), "cfgSha256": sha(cfg.encode()),
            "viewTraceSha256": source["viewTraceSha256"],
            "viewDisposition": source["viewDisposition"]}


def concretize(root, row, raw, directory, java, *, seconds=4, independent=False, deadline=None):
    seconds = proof_chunk(deadline, seconds)
    remaining(deadline, seconds)
    directory.mkdir(parents=True, exist_ok=False)
    cfg_text = (root / row["cfg_path"]).read_text()
    module, cfg = (candidate_search_inputs(cfg_text, raw)[1] if independent
                   else candidate_inputs(cfg_text, raw))
    write_bytes(directory / "PersonaDelivery.tla", (root / row["spec_path"]).read_bytes())
    write_bytes(directory / "ConcreteCandidate.tla", (module).encode())
    write_bytes(directory / "candidate.cfg", (cfg).encode())
    argv = [str(java), "-Xmx256m", "-XX:ActiveProcessorCount=1", "-cp", str(root / "tla2tools.jar"),
            "tlc2.TLC", "-deadlock", "-workers", "1", "-noGenerateSpecTE",
            "-metadir", str(directory / "states"), "-config", "candidate.cfg", "ConcreteCandidate.tla"]
    started = time.monotonic()
    try:
        process = run_checker(argv, cwd=directory, timeout=remaining(deadline, seconds))
        output, code = process.stdout, process.returncode
    except subprocess.TimeoutExpired as error:
        output, code = error.stdout or b"", None
    write_bytes(directory / "run.log", output)
    search = {"argv": argv, "seconds": time.monotonic() - started, "exitCode": code,
              "moduleSha256": sha(module.encode()), "cfgSha256": sha(cfg.encode()),
              "logSha256": sha(output), "log": output.decode()}
    write_bytes(directory / "search.json", canonical(search))
    candidate = search_trace(search, module, cfg)
    write_bytes(directory / "candidate.json", canonical(candidate))
    remaining(deadline, seconds)
    return candidate


def attach(root, row, envelope, directory, java, *, deadline, seconds=60):
    """Shared frozen worker/screener path, bounded by the original row deadline."""
    remaining(deadline, seconds)
    raw = envelope["raw"]
    # Retain both witnesses, including refused candidates. No relabeling as a
    # proof of projection equivalence or accepting an unrelated park cycle.
    (directory / "view-trace.json").parent.mkdir(parents=True, exist_ok=False)
    write_bytes(directory / "view-trace.json", canonical(raw))
    candidate = concretize(root, row, raw, directory / "candidate", java,
                           seconds=proof_chunk(deadline, seconds, 5),
                           independent=True, deadline=deadline)
    envelope["concreteCandidate"] = candidate
    envelope["candidateSource"] = {
        "schema": 1, "kind": candidate_search_inputs((root / row["cfg_path"]).read_text(), raw)[0],
        "binding": bindings(root, row, candidate), "viewTraceSha256": sha(canonical(raw)),
        "viewDisposition": "retained-not-used-as-concrete-proof",
        "search": json.loads((directory / "candidate/search.json").read_text())}
    validate_candidate_source(root, row, envelope)
    remaining(deadline, seconds)
    needs_contrast = cfg_context((root / row["cfg_path"]).read_text())[2] != "none"
    evidence, _ = check(root, row, candidate, directory / "sensitivity", java,
                        seconds=seconds, contrast=needs_contrast, deadline=deadline)
    remaining(deadline, seconds)
    envelope["temporalSensitivity"] = evidence


def run_replay(root, row, raw, directory, java, *, correct_cycle=False, positive=False, seconds=4, deadline=None):
    """Run one finite exact replay within the caller's remaining row budget."""
    seconds = proof_chunk(deadline, seconds)
    remaining(deadline, seconds)
    directory.mkdir(parents=True, exist_ok=False)
    module, cfg, _, _ = replay_inputs((root / row["cfg_path"]).read_text(), raw,
                                      correct_cycle=correct_cycle, positive=positive)
    write_bytes(directory / "PersonaDelivery.tla", (root / row["spec_path"]).read_bytes())
    write_bytes(directory / "TemporalReplay.tla", (module).encode())
    write_bytes(directory / "replay.cfg", (cfg).encode())
    argv = [str(java), "-Xmx256m", "-XX:ActiveProcessorCount=1", "-cp", str(root / "tla2tools.jar"),
            "tlc2.TLC", "-deadlock", "-workers", "1", "-noGenerateSpecTE",
            "-metadir", str(directory / "states"), "-config", "replay.cfg", "TemporalReplay.tla"]
    started = time.monotonic()
    try:
        process = run_checker(argv, cwd=directory, timeout=remaining(deadline, seconds))
        output, code = process.stdout, process.returncode
    except subprocess.TimeoutExpired as error:
        output, code = error.stdout or b"", None
    write_bytes(directory / "run.log", output)
    log = output.decode()
    proof = {"argv": argv, "seconds": time.monotonic() - started, "exitCode": code,
             "moduleSha256": sha(module.encode()), "cfgSha256": sha(cfg.encode()),
             "logSha256": sha(log.encode()), "log": log}
    remaining(deadline, seconds)
    return proof


def run_environment_contrast(root, row, raw, directory, java, *, seconds=4, deadline=None):
    """Find a separate correct witness; never relabel it as the original lasso.

    A cap or a changed exogenous schedule is unknown and cannot pass the gate.
    The resulting witness is then checked state-for-state by run_replay.
    """
    search_seconds = proof_chunk(deadline, seconds, 4 / 3)
    remaining(deadline, seconds)
    directory.mkdir(parents=True, exist_ok=False)
    module, cfg = environment_inputs((root / row["cfg_path"]).read_text(), raw)
    write_bytes(directory / "PersonaDelivery.tla", (root / row["spec_path"]).read_bytes())
    write_bytes(directory / "EnvironmentContrast.tla", (module).encode())
    write_bytes(directory / "contrast.cfg", (cfg).encode())
    argv = [str(java), "-Xmx256m", "-XX:ActiveProcessorCount=1", "-cp", str(root / "tla2tools.jar"),
            "tlc2.TLC", "-deadlock", "-workers", "1", "-noGenerateSpecTE",
            "-metadir", str(directory / "states"), "-config", "contrast.cfg", "EnvironmentContrast.tla"]
    started = time.monotonic()
    try:
        process = run_checker(argv, cwd=directory, timeout=remaining(deadline, search_seconds))
        output, code = process.stdout, process.returncode
    except subprocess.TimeoutExpired as error:
        output, code = error.stdout or b"", None
    write_bytes(directory / "run.log", output)
    candidates = []
    for line in output.decode().splitlines():
        if line.startswith('"TRACE '):
            line = json.loads(line)
        if line.startswith("TRACE "):
            candidates.append(json.loads(line[6:]))
    evidence = {"argv": argv, "seconds": time.monotonic() - started, "exitCode": code,
                "moduleSha256": sha(module.encode()), "cfgSha256": sha(cfg.encode()),
                "logSha256": sha(output), "log": output.decode()}
    write_bytes(directory / "search.json", canonical(evidence))
    if code is None:
        raise SensitivityIncomplete("correct environment contrast exhausted its proof chunk")
    require(code == 13 and "Temporal property NotGood was violated" in output.decode()
            and len(candidates) == 1, "correct environment contrast capped or not found")
    candidate = candidates[0]
    require(same_schedule(raw, candidate), "correct environment witness changed exogenous schedule")
    proof = run_replay(root, row, candidate, directory / "exact", java, positive=True,
                       seconds=seconds, deadline=deadline)
    remaining(deadline, seconds)
    return {"raw": candidate, "proof": proof, "search": evidence,
            "scope": "raw-existential-correct-behavior"}


def check(root, row, raw, directory, java, *, seconds=4, contrast=False, deadline=None):
    remaining(deadline, seconds)
    evidence = {"binding": bindings(root, row, raw)}
    try:
        evidence["mutant"] = run_replay(root, row, raw, directory / "mutant", java,
                                         seconds=proof_chunk(deadline, seconds, 4), deadline=deadline)
        if evidence["binding"]["bug"] != "none":
            evidence["correctCycle"] = run_replay(root, row, raw, directory / "correct-cycle", java,
                                                  correct_cycle=True,
                                                  seconds=proof_chunk(deadline, seconds, 3), deadline=deadline)
        validate_evidence(root, row, raw, evidence)
        remaining(deadline, seconds)
        if contrast and evidence["binding"]["bug"] != "none":
            evidence["correctEnvironment"] = run_environment_contrast(
                root, row, raw, directory / "environment", java, seconds=seconds,
                deadline=deadline)
        summary = validate_evidence(root, row, raw, evidence, require_contrast=contrast)
    finally:
        directory.mkdir(parents=True, exist_ok=True)
        write_bytes(directory / "evidence.json", canonical(evidence))
    remaining(deadline, seconds)
    return evidence, summary


LOADED_SOURCE_SHA256 = sha(Path(__file__).read_bytes())
