"""Scheduler-only DIAGNOSTIC; never produces an E1 certification verdict.

The existing worker.py is copied byte-for-byte from jobs/lib/job.py. It supplies
the already exercised pinned-jar invocation, classification and complete graph
validation; this wrapper does not change the production runner or its manifest.
"""
from __future__ import annotations

import json
import os
from pathlib import Path
import time

from worker import normalize_line, result_matches, run_row, validate_trace, verify_inputs


def fair_enabled(s: dict) -> dict[str, bool]:
    work = not s["delivered"] or s["gate"] != "free"
    env = s["actual"] == "idle" and s["row"] == "waiting" and not s["permission"]
    release = (s["phase"] in {"cooldown", "done"}
               or (s["phase"] in {"ready", "boxed"} and not s["request"]))
    return {
        "EngineObserve": work and s["observation"] == "none" and env,
        "EngineStep": work and s["observation"] == "ready",
        "GateStep": ((s["gate"] == "free" and s["request"])
                     or (s["gate"] == "delivery" and release)),
        "ReconnectStep": (not s["mcp"] and s["gate"] == "free" and not s["reconnectPending"]
                          and s["actual"] == "idle" and not s["permission"] and s["box"] == "empty"),
        "AgentTakeIn": (s["box"] == "item" and s["submitted"]
                        and s["actual"] == "idle" and not s["permission"]),
        "AgentTurnEnd": s["actual"] == "busy" and not s["permission"],
        "AgentCompletesReconnect": s["reconnectPending"] and not s["mcp"],
    }


def lasso_evidence(trace: dict, cfg: str) -> dict:
    """Check all seven fairness obligations over the full recurring graph."""
    validate_trace(trace, counterexample=True, temporal=True)
    edges = trace["counterexample"]["action"]
    closing = [edge for edge in edges if edge[2][0] <= edge[0][0]]
    if len(closing) != 1:
        raise ValueError("expected one lasso closing edge")
    start = closing[0][2][0]
    cycle = trace["behavior"][start - 1:]
    cycle_edges = [edge for edge in edges if edge[0][0] >= start]
    env = lambda s: s["actual"] == "idle" and s["row"] == "waiting" and not s["permission"]
    if not any(env(node["st"]) for node in cycle):
        raise ValueError("counterexample cycle does not satisfy recurrent EnvTypable")
    # made/taken/delivered are monotone in this restriction. Check the prefix
    # too: this diagnostic must never hide a previously accepted text/Enter.
    if any(node["st"]["made"] or node["st"]["taken"] or node["st"]["delivered"]
           or node["st"]["submitted"] or node["st"]["box"] != "empty"
           or not node["st"]["mcp"] or node["st"]["retypes"] != 0
           or node["st"]["enterRetries"] != 0 for node in trace["behavior"]):
        raise ValueError("requested first-text-refusal trace accepted text or consumed retry budget")
    # All modeled actions set transition. Stuttering retains that old label;
    # it is not evidence that the named action ran on the closing edge.
    executed = [edge for edge in cycle_edges if edge[0][1]["st"] != edge[2][1]["st"]]
    transitions = {edge[2][1]["st"]["transition"] for edge in executed}
    if not {"EngineStep", "GateStep", "AgentTurnEnd", "AgentOwnTurnStart",
            "PermissionOpen", "PermissionAnswer"} <= transitions:
        raise ValueError("missing live-guard/flapping/fair-action evidence")
    outcomes = {edge[2][1]["st"]["outcome"] for edge in executed}
    if "permission-refused-text" not in outcomes or "permission-refused-enter" in outcomes:
        raise ValueError("loop must witness first-text refusals, with no refused Enter loop")
    if not all(node["st"]["everSent"] for node in cycle):
        raise ValueError("head does not remain in flight throughout the cycle")
    enabled = [fair_enabled(node["st"]) for node in cycle]
    strengths = dict(EngineObserve="SF", EngineStep="WF", GateStep="WF", ReconnectStep="SF",
                     AgentTakeIn="SF", AgentTurnEnd="WF", AgentCompletesReconnect="WF")
    fairness = {}
    for action, strength in strengths.items():
        flags = [state[action] for state in enabled]
        occurrences = [edge for edge in executed if edge[2][1]["st"]["transition"] == action
                       and fair_enabled(edge[0][1]["st"])[action]]
        obliged = any(flags) if strength == "SF" else all(flags)
        if obliged and not occurrences:
            raise ValueError(f"cycle violates {strength}({action})")
        fairness[action] = dict(strength=strength, enabled_states=sum(flags),
                                taken_edges=len(occurrences), satisfied=True,
                                obligation=("taken" if occurrences else "disabled-somewhere" if strength == "WF"
                                            else "disabled-everywhere"))
    return {"cfg": cfg, "loop_start": start, "loop_states": len(cycle),
            "closing_edge": [closing[0][0][0], closing[0][2][0]],
            "transitions": sorted(transitions), "outcomes": sorted(outcomes), "fairness": fairness,
            "EnvTypable_recurs": True, "TranscriptReadable_always": True,
            "MCP_connected_always": True, "ReconnectsDue": True,
            "AgentTakeIn_disabled_on_loop": True, "text_accepted_ever": False,
            "enter_retries_used": 0, "EnterRetries": 4, "bounded_faults": 0, "retypes": 0}


def permission_lasso(work: Path, row: dict) -> dict:
    """Check the exported cycle itself; do not infer a cycle from console text."""
    traces = []
    for line in (work / "logs" / f"{row['cfg']}.log").read_text().splitlines():
        _, trace = normalize_line(line)
        if trace is not None:
            traces.append(trace)
    if len(traces) != 1:
        raise ValueError("expected one complete temporal counterexample")
    trace = traces[0]
    return lasso_evidence(trace, row["cfg"])


def main() -> int:
    final = {"schema": 1, "diagnostic": True, "certifies_E1": False,
             "result": "ERROR(diagnostic-worker)", "rows": []}
    try:
        if os.environ.get("TLA_REMOTE_JOB") != "1" or Path.cwd() != Path("/work"):
            raise ValueError("TLC may run only in the scheduler container")
        work = Path("/work")
        plan = json.loads((work / "plan.json").read_text())
        verify_inputs(work, plan)
        if len(plan["rows"]) != 5 or not 0 < plan["budget"] <= 14100:
            raise ValueError("invalid diagnostic plan")
        (work / "logs").mkdir()
        started = time.monotonic()
        for row in plan["rows"]:
            if not 0 < row["cap_s"] <= 1800:
                raise ValueError("invalid row budget")
            left = int(plan["budget"] - (time.monotonic() - started))
            if left < 30:
                raise ValueError("diagnostic budget exhausted")
            result = run_row(work, row, plan["snapshot"], min(left, row["cap_s"]))
            final["rows"].append(result)
            print("ROW " + json.dumps(result, sort_keys=True, separators=(",", ":")), flush=True)
            if row["props"] in {"EventuallyDelivered", "HeadTakenIn"}:
                evidence = permission_lasso(work, row)
                print("LASSO-EVIDENCE " + json.dumps(evidence, sort_keys=True,
                                                    separators=(",", ":")), flush=True)
        failed = [row["cfg"] for row, result in zip(plan["rows"], final["rows"])
                  if not result_matches(row, result["result"])]
        final.update(result=("ERROR(unexpected-diagnostic-outcome)" if failed
                             else "EXPECTED-DIAGNOSTIC-COUNTEREXAMPLE"),
                     snapshot=plan["snapshot"], complete=True, failed=failed)
    except BaseException as error:
        print(f"DIAGNOSTIC-ERROR {type(error).__name__}: {error}", flush=True)
    print("JOB-VERDICT " + json.dumps(final, sort_keys=True, separators=(",", ":")), flush=True)
    return 0 if final["result"] == "EXPECTED-DIAGNOSTIC-COUNTEREXAMPLE" else 1


if __name__ == "__main__":
    raise SystemExit(main())
