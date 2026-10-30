#!/usr/bin/env python3
"""Finite original-Next deferReconnect coverage; no temporal/certification claim.

Generation runs only in the authorized scheduler container. Offline verification
reconstructs both checker inputs and checks retained logs; it starts no process.
"""
from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import math
import os
from pathlib import Path
import re
import subprocess
import time

CFG = "ci/cfg/live_empty_reconnect.cfg"
SELF = "ci/reconnect_coverage.py"
SCOPE = "existential finite original-Init/Next prefix; no fairness or liveness claim"
NAME = "supplemental_reconnect-001.json"
GUIDE = r'''Guide == IF st.observation = "none" THEN EngineObserve ELSE EngineStepSuccessful
GuidedNext == Guide /\ Next
NoDeferReconnect == st.action # "deferReconnect"
'''
FILES = {"input.cfg", "raw-trace.json", "reconnect_coverage.py", "temporal_sensitivity.py",
         "search/PersonaDelivery.tla", "search/ReconnectCoverage.tla", "search/witness.cfg", "search/run.log",
         "replay/PersonaDelivery.tla", "replay/ReconnectReplay.tla", "replay/replay.cfg", "replay/run.log"}


def require(condition, message):
    if not condition:
        raise ValueError(message)


def sha(data):
    return hashlib.sha256(data).hexdigest()


def canonical(value):
    return (json.dumps(value, sort_keys=True, separators=(",", ":")) + "\n").encode()


def temporal(root):
    spec = importlib.util.spec_from_file_location("reconnect_temporal", root / "ci/temporal_sensitivity.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def cfg_parts(text):
    lines = text.splitlines()
    require(lines[0] == "SPECIFICATION Spec", "changed reconnect input specification")
    end = next(i for i, line in enumerate(lines) if line.startswith("INVARIANT "))
    constants = "\n".join(lines[1:end]) + "\n"
    require('  Scenario = "empty-reconnect"' in lines and '  Bug = "none"' in lines,
            "reconnect witness requires the original correct empty-reconnect scenario")
    invariants = "\n".join(line for line in lines[end:] if line.startswith("INVARIANT ")
                           and line != "INVARIANT EmitSimulationTrace") + "\n"
    return constants, invariants


def search_inputs(text):
    constants, invariants = cfg_parts(text)
    module = ("---------------- MODULE ReconnectCoverage ----------------\nEXTENDS PersonaDelivery\n"
              + GUIDE + "========================================================\n")
    cfg = ("INIT Init\nNEXT GuidedNext\n" + constants + invariants
           + "INVARIANT NoDeferReconnect\nALIAS TraceView\nPOSTCONDITION EmitTrace\n")
    return module, cfg


def replay_inputs(root, text, raw):
    constants, invariants = cfg_parts(text)
    library, (states, records) = temporal(root).tla_values(
        [[record["state"] for record in raw["behavior"]], raw["behavior"]])
    module = r'''---------------- MODULE ReconnectReplay ----------------
EXTENDS PersonaDelivery
VARIABLE position
{library}
ReplayStates == {states}
ReplayRecords == {records}
ReplayInit == position = 1 /\ st = ReplayStates[1]
ReplayNext ==
 /\ position < Len(ReplayStates)
 /\ position' = position + 1
 /\ st' = ReplayStates[position']
 /\ PrintT("RECONNECT_EDGE " \o ToJson([position |-> position, legal |-> Next]))
 /\ Assert(Next, "reconnect coverage has an illegal original Next edge")
ReplayEvidence ==
 /\ PrintT("RECONNECT_STATE " \o ToJson([position |-> position,
      initial |-> IF position = 1 THEN Init ELSE TRUE,
      recordMatches |-> TraceRecord(st) = ReplayRecords[position]]))
 /\ (position = 1 => Init)
 /\ TraceRecord(st) = ReplayRecords[position]
ReplayGoal == position # Len(ReplayStates) \/
 (st.transition = "EngineStep" /\ st.action = "deferReconnect" /\ st.outcome = "rerun-due")
========================================================
'''.replace("{library}", library).replace("{states}", states).replace("{records}", records)
    cfg = ("INIT ReplayInit\nNEXT ReplayNext\n" + constants + invariants
           + "INVARIANT ReplayEvidence\nINVARIANT ReplayGoal\n")
    return module, cfg


def events(log, prefix):
    lines = [json.loads(line) if line.startswith('"' + prefix) else line for line in log.splitlines()]
    return [json.loads(line[len(prefix):]) for line in lines if line.startswith(prefix)]


def check_behavior(raw):
    behavior = raw["behavior"]
    require(len(behavior) == 5, "reconnect prefix must contain five original states")
    require([r["transition"] for r in behavior] ==
            ["Init", "EngineObserve", "EngineStep", "EngineObserve", "EngineStep"]
            and [r["executedAction"] for r in behavior] ==
            ["none", "observe", "observeLaunch", "observe", "deferReconnect"],
            "reconnect action was not executed on the intended prefix")
    require(all(r["control"] == {"bug": "none", "class": "correct", "bugStep": False}
                and r["constants"] == behavior[0]["constants"] for r in behavior),
            "changed reconnect correct semantics")
    before, after = behavior[-2:]
    a, b = before["state"], after["state"]
    require(a != b and a["observation"] == "ready" and b["observation"] == "none"
            and a["g"]["deferred"] is True and a["g"]["due"] is True
            and a["g"]["owner"] == "free" and a["a"]["mcp"] is False
            and a["knowledge"]["r"]["mcp"] is False
            and a["knowledge"]["r"]["relaunch"] is False
            and not a["p"]["accepted"] and a["w"]["kind"] == "none"
            and before["EngineChoice"] == "deferReconnect"
            and after["outcome"] == "rerun-due", "missing observed, nonstuttering reconnect edge")
    nodes = raw["counterexample"]["state"]
    edges = raw["counterexample"]["action"]
    require(sorted(nodes, key=lambda n: n[0]) == [[i, r] for i, r in enumerate(behavior, 1)]
            and len(edges) == 4 and sorted((e[0][0], e[2][0]) for e in edges) == [(1, 2), (2, 3), (3, 4), (4, 5)]
            and all(e[0] in nodes and e[2] in nodes for e in edges), "changed reconnect finite trace graph")
    return {"stateCount": 5, "edgeCount": 4, "deferReconnectPositions": [5]}


def verify(root, payload, artifacts, inputs):
    require(payload.get("schema") == 1 and payload.get("kind") == "supplemental-reconnect-prefix"
            and payload.get("scope") == SCOPE and payload.get("inputs") == inputs,
            "changed reconnect provenance")
    require(set(artifacts) == set(payload.get("artifacts", {})) == FILES,
            "missing/extra reconnect artifact")
    for name, content in artifacts.items():
        require(sha(content) == payload["artifacts"][name], "changed reconnect artifact: " + name)
    for name, source in {"input.cfg": CFG, "reconnect_coverage.py": SELF,
                         "temporal_sensitivity.py": "ci/temporal_sensitivity.py",
                         "search/PersonaDelivery.tla": "PersonaDelivery.tla",
                         "replay/PersonaDelivery.tla": "PersonaDelivery.tla"}.items():
        require(artifacts[name] == (root / source).read_bytes() and sha(artifacts[name]) == inputs[source],
                "changed reconnect source: " + name)
    binding = payload.get("binding", {})
    require(set(binding) == {"jarSha256", "javaSha256", "guideSha256"}
            and binding["jarSha256"] == inputs["tla2tools.jar"]
            and binding["guideSha256"] == sha(GUIDE.encode())
            and re.fullmatch(r"[0-9a-f]{64}", binding["javaSha256"]), "changed reconnect bindings")
    raw = payload["raw"]
    require(artifacts["raw-trace.json"] == canonical(raw), "changed reconnect raw trace")
    summary = check_behavior(raw)
    text = artifacts["input.cfg"].decode()
    for kind, (module, cfg) in {"search": search_inputs(text), "replay": replay_inputs(root, text, raw)}.items():
        filename = "ReconnectCoverage.tla" if kind == "search" else "ReconnectReplay.tla"
        cfgname = "witness.cfg" if kind == "search" else "replay.cfg"
        proof, log = payload[kind], artifacts[kind + "/run.log"].decode()
        require(artifacts[kind + "/" + filename] == module.encode()
                and artifacts[kind + "/" + cfgname] == cfg.encode()
                and proof["moduleSha256"] == sha(module.encode()) and proof["cfgSha256"] == sha(cfg.encode())
                and proof["logSha256"] == sha(log.encode()) and "Finished in" in log
                and proof["timeout"] is False and type(proof["seconds"]) in (int, float)
                and math.isfinite(proof["seconds"]) and 0 <= proof["seconds"] <= 60
                and proof["argv"][-3:] == ["-config", cfgname, filename]
                and not re.search(r"Exception|OutOfMemoryError|StackOverflowError|Evaluation error", log),
                "changed/incomplete reconnect checker proof")
        errors = [line for line in log.splitlines() if line.startswith("Error:")]
        if kind == "search":
            require(proof["exitCode"] == 12 and errors == ["Error: Invariant NoDeferReconnect is violated.",
                    "Error: The behavior up to this point is:"] and events(log, "TRACE ") == [raw],
                    "missing genuine reconnect search trace")
        else:
            require(proof["exitCode"] == 0 and not errors and "Model checking completed. No error has been found." in log
                    and canonical(events(log, "RECONNECT_STATE ")) == canonical([dict(position=i, initial=True, recordMatches=True) for i in range(1, 6)])
                    and canonical(events(log, "RECONNECT_EDGE ")) == canonical([dict(position=i, legal=True) for i in range(1, 5)]),
                    "missing original-Init/Next reconnect replay proof")
    require(payload.get("summary") == summary, "changed reconnect coverage summary")
    return {"kind": payload["kind"], "scope": SCOPE, **summary}


def execute(output, kind, module, cfg, source, java, jar):
    directory = output / kind
    directory.mkdir()
    filename = "ReconnectCoverage.tla" if kind == "search" else "ReconnectReplay.tla"
    cfgname = "witness.cfg" if kind == "search" else "replay.cfg"
    (directory / filename).write_text(module)
    (directory / cfgname).write_text(cfg)
    (directory / "PersonaDelivery.tla").write_bytes(source)
    argv = [str(java), "-Xmx384m", "-XX:ActiveProcessorCount=1", "-cp", str(jar), "tlc2.TLC",
            "-workers", "1", "-deadlock", "-noGenerateSpecTE", "-metadir", str(directory / "states"),
            "-config", cfgname, filename]
    started = time.monotonic()
    timed_out = False
    try:
        result = subprocess.run(argv, cwd=directory, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=60)
        code, log = result.returncode, result.stdout
    except subprocess.TimeoutExpired as error:
        code, log, timed_out = None, error.stdout or b"", True
    (directory / "run.log").write_bytes(log)
    proof = dict(argv=argv, exitCode=code, timeout=timed_out, seconds=time.monotonic() - started,
                 moduleSha256=sha(module.encode()), cfgSha256=sha(cfg.encode()), logSha256=sha(log))
    (directory / "proof.json").write_bytes(canonical(proof))
    print(json.dumps(dict(event="reconnect-coverage-checker", kind=kind, **proof)), flush=True)
    require(not timed_out, "reconnect coverage checker timed out")
    return proof


def generate(root, output, java):
    require(os.environ.get("TLA_REMOTE_JOB") == "1", "reconnect coverage generation requires scheduler container")
    import runner
    runner.verify_pins(root)
    inputs = {str(p.relative_to(root)): sha(p.read_bytes()) for p in runner.input_paths(root)}
    output.mkdir(parents=True)
    text, source = (root / CFG).read_text(), (root / "PersonaDelivery.tla").read_bytes()
    for name, path in {"input.cfg": CFG, "reconnect_coverage.py": SELF,
                       "temporal_sensitivity.py": "ci/temporal_sensitivity.py"}.items():
        (output / name).write_bytes((root / path).read_bytes())
    search = execute(output, "search", *search_inputs(text), source, java, root / "tla2tools.jar")
    traces = events((output / "search/run.log").read_text(), "TRACE ")
    require(len(traces) == 1, "reconnect search must export exactly one trace")
    raw = traces[0]
    (output / "raw-trace.json").write_bytes(canonical(raw))
    replay = execute(output, "replay", *replay_inputs(root, text, raw), source, java, root / "tla2tools.jar")
    artifacts = {name: (output / name).read_bytes() for name in FILES}
    payload = dict(schema=1, kind="supplemental-reconnect-prefix", scope=SCOPE, inputs=inputs,
                   binding=dict(jarSha256=inputs["tla2tools.jar"], javaSha256=sha(java.read_bytes()), guideSha256=sha(GUIDE.encode())),
                   raw=raw, search=search, replay=replay, summary=check_behavior(raw),
                   artifacts={name: sha(data) for name, data in artifacts.items()})
    summary = verify(root, payload, artifacts, inputs)
    require(all(sha((root / name).read_bytes()) == digest for name, digest in inputs.items()), "reconnect inputs changed")
    (output / "evidence.json").write_bytes(canonical(payload))
    print(json.dumps(dict(event="reconnect-coverage-verified", **summary)), flush=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--java", type=Path, required=True)
    args = parser.parse_args()
    generate(Path(__file__).resolve().parents[1], args.output.resolve(), args.java.resolve())
