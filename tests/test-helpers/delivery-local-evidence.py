"""Portable replay evidence for an owner-authorized local TLC model rerun.

This is deliberately separate from the scheduler certificate validator. It
never grants a scheduler verdict. Independent temporal and accepted-work
bundles retain their original local provenance and are checked offline.
Export only complete successful manifest runs; unit validation starts no tool.
"""
from __future__ import annotations
import argparse
import base64
import gzip
import hashlib
import importlib.util
import json
from pathlib import Path
import re
import sys
import time
from unittest.mock import patch

REPO = Path(__file__).resolve().parents[2]
SOURCE = REPO / "spec/tla"
DESTINATION = REPO / "tests/fixtures/delivery-traces"
SUPPLEMENTAL_NAME = "supplemental_pullback-001.json"


def load(path, name):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


runner = load(SOURCE / "ci/runner.py", "local_delivery_runner")
sys.modules["runner"] = runner
contract = load(SOURCE / "ci/trace_contract.py", "local_delivery_contract")
worker = load(SOURCE / "jobs/lib/job.py", "local_delivery_worker")
sys.modules["worker"] = worker
cardinal = load(SOURCE / "ci/check_cardinal.py", "local_delivery_cardinal")
permission = load(SOURCE / "ci/fairness-probe/job.py", "local_delivery_permission")


def require(condition, reason):
    if not condition:
        raise ValueError(reason)


def encoded(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":")).encode()


def digest(data):
    return hashlib.sha256(data).hexdigest()


def inputs():
    return {str(p.relative_to(SOURCE)): digest(p.read_bytes()) for p in runner.input_paths(SOURCE)}


def pack(envelope):
    raw = encoded([envelope])
    return {"schema": 3, "fixtureContainer": {"schema": 1, "codec": "gzip-base64-json",
            "bytes": len(raw), "sha256": digest(raw),
            "data": base64.b64encode(gzip.compress(raw, mtime=0)).decode()}}


def unpack(stored):
    container = stored["fixtureContainer"]
    require(stored["schema"] == 3 and container["codec"] == "gzip-base64-json", "invalid fixture container")
    raw = gzip.decompress(base64.b64decode(container["data"], validate=True))
    require(len(raw) == container["bytes"] and digest(raw) == container["sha256"], "changed fixture container")
    envelopes = json.loads(raw)
    require(len(envelopes) == 1, "unexpected fixture count")
    return envelopes[0]


def retain_artifacts(directory):
    return {str(path.relative_to(directory)): {"sha256": digest(path.read_bytes()),
            "base64": base64.b64encode(path.read_bytes()).decode()}
            for path in sorted(directory.rglob("*")) if path.is_file()} if directory.exists() else {}


def validate_temporal_artifacts(row, envelope):
    artifacts = envelope["localArtifacts"]
    if "temporalSensitivity" not in envelope:
        require(not artifacts, "unexpected temporal artifacts")
        return
    helper = load(SOURCE / "ci/temporal_sensitivity.py", "local_delivery_temporal")
    raw, candidate = envelope["raw"], envelope["concreteCandidate"]
    sensitivity, selection = envelope["temporalSensitivity"], envelope["candidateSource"]
    source, cfg = (SOURCE / row["spec_path"]).read_bytes(), (SOURCE / row["cfg_path"]).read_text()
    _, (module, derived) = helper.candidate_search_inputs(cfg, raw)
    canonical = helper.canonical
    expected = {"view-trace.json": canonical(raw), "candidate/PersonaDelivery.tla": source,
                "candidate/ConcreteCandidate.tla": module.encode(), "candidate/candidate.cfg": derived.encode(),
                "candidate/run.log": selection["search"]["log"].encode(),
                "candidate/search.json": canonical(selection["search"]), "candidate/candidate.json": canonical(candidate),
                "sensitivity/evidence.json": canonical(sensitivity)}

    def replay(prefix, trace, proof, **flags):
        module, derived, _, _ = helper.replay_inputs(cfg, trace, **flags)
        expected.update({prefix + "/PersonaDelivery.tla": source, prefix + "/TemporalReplay.tla": module.encode(),
                         prefix + "/replay.cfg": derived.encode(), prefix + "/run.log": proof["log"].encode()})

    replay("sensitivity/mutant", candidate, sensitivity["mutant"])
    if "correctCycle" in sensitivity:
        replay("sensitivity/correct-cycle", candidate, sensitivity["correctCycle"], correct_cycle=True)
    if "correctEnvironment" in sensitivity:
        contrast = sensitivity["correctEnvironment"]
        module, derived = helper.environment_inputs(cfg, candidate)
        expected.update({"sensitivity/environment/PersonaDelivery.tla": source,
                         "sensitivity/environment/EnvironmentContrast.tla": module.encode(),
                         "sensitivity/environment/contrast.cfg": derived.encode(),
                         "sensitivity/environment/run.log": contrast["search"]["log"].encode(),
                         "sensitivity/environment/search.json": canonical(contrast["search"])})
        replay("sensitivity/environment/exact", contrast["raw"], contrast["proof"], positive=True)
    require(set(artifacts) == set(expected), "missing/extra temporal proof artifact")
    for name, content in expected.items():
        artifact = artifacts[name]
        require(set(artifact) == {"sha256", "base64"}
                and base64.b64decode(artifact["base64"], validate=True) == content
                and artifact["sha256"] == digest(content), "changed temporal artifact: " + name)


def validate_auxiliary(row, result, evidence):
    traces = evidence["traces"]
    require(len(traces) == result["traces"], "missing auxiliary traces")
    require([digest(encoded(raw)) for raw in traces] == result["rawTraceSha256s"], "changed auxiliary raw trace")
    for raw in traces:
        worker.validate_trace(raw, counterexample=row["expect"] == "violation", temporal=bool(row["properties"]))
    if row["cfg"] in {"permission_eventually_delivered", "permission_head_taken_in"}:
        require(len(traces) == 1 and evidence["permissionLasso"] == permission.lasso_evidence(traces[0], row["cfg"]),
                "changed permission fairness lasso")
    else:
        require(evidence["permissionLasso"] is None, "unexpected permission fairness evidence")


def accepted_work(root, run, row, envelope, worker, **_):
    """Run the real witness verifier against retained bytes, without writes."""
    helper = worker.load_work_witness(root / "ci/work_witness.py")
    evidence = envelope.get("acceptedWork", {})
    require(set(evidence) == {"schema", "rowStartedMonotonic", "rowDeadline", "payload", "artifacts"}
            and evidence["schema"] == 1, "missing accepted-work evidence")
    started, end = evidence["rowStartedMonotonic"], evidence["rowDeadline"]
    require(type(started) in (int, float) and type(end) in (int, float)
            and end - started == row["local_row_budget_s"], "accepted-work row clock changed")
    payload, artifacts = evidence["payload"], evidence["artifacts"]
    require(payload["executionDeadline"] == end, "accepted-work deadline changed")
    for kind in ("search", "replay"):
        require(payload[kind]["rowDeadline"] == end and payload[kind]["startedMonotonic"] >= started,
                "accepted-work checker outside row clock")
    require(set(artifacts) == set(worker.WORK_WITNESS_ARTIFACTS), "missing accepted-work artifacts")
    retained = {}
    virtual = Path("/__delivery_retained_work__")
    for name, artifact in artifacts.items():
        require(set(artifact) == {"sha256", "base64"}, "invalid accepted-work artifact")
        content = base64.b64decode(artifact["base64"], validate=True)
        require(digest(content) == artifact["sha256"], "changed accepted-work artifact: " + name)
        retained[str(virtual / name)] = content
    require(retained[str(virtual / "evidence.json")] == helper.temporal.canonical(payload), "changed accepted-work payload")
    require((payload["raw"] == envelope["raw"]) == (row["cfg"] == "core_head_taken_in"),
            "accepted-work witness confused with premise probe")

    class RetainedPath(type(Path())):
        def read_bytes(self):
            if self.is_relative_to(virtual):
                require(str(self) in retained, "unretained accepted-work file: " + str(self))
                return retained[str(self)]
            return super().read_bytes()

        def read_text(self, encoding=None, errors=None):
            return self.read_bytes().decode(encoding or "utf8", errors or "strict")

    with patch.object(helper, "Path", RetainedPath):
        summary = helper.verify_payload(root / row["spec_path"], root / row["cfg_path"],
                                        root / "tla2tools.jar", virtual / "java-launcher", virtual,
                                        payload, time.monotonic() + 120)
    require(summary == payload["summary"], "changed accepted-work summary")
    expected = ([1], [[1, 1]]) if row["cfg"] == "core_head_taken_in" else ([1, 2], [[1, 1], [1, 2], [2, 1]])
    require((summary["accepted"], summary["parts"]) == expected
            and summary["exhaustivePositiveCertification"] is False
            and len(summary["fairness"]) == 7, "wrong accepted-work scope")
    return {**summary, "boundedPositiveNonvacuity": True, "universalProgress": False,
            "artifactHashes": {name: value["sha256"] for name, value in artifacts.items()}}


def metadata(row, envelope, source_inputs, row_budget=None):
    budget = envelope.get("localRowBudgetSeconds")
    require(type(budget) is int and 0 < budget <= 3600
            and (row_budget is None or budget == row_budget), "changed local row budget")
    # The local checker's --seconds overrides scheduler manifest budgets.
    # Preserve the genuine clock and bind it to that retained launch argument.
    row = {**row, "local_row_budget_s": budget}
    run = {"inputs": source_inputs, "snapshot": runner.snapshot_id(source_inputs)}
    with patch.object(contract, "validate_accepted_work", accepted_work):
        behavior, result = contract.validate_envelope(SOURCE, run, row, envelope, worker)
    if runner.reduced_cfg(row):
        contract.validate_restart_mutation_behavior(row, behavior)
    bugs = contract.executed_bug_steps(row, behavior, companion=row["cfg"] in runner.RESTART_MUTATIONS)
    for record in envelope["raw"]["behavior"] + (behavior if result["replayField"] != "raw" else []):
        for knowledge in (record["knowledge"], record["gateKnowledge"], record["observationKnowledge"]):
            for reading in (knowledge["r"], knowledge["e"]["keyReading"], knowledge["g"]["reading"]):
                require(not ({"screen", "box", "idleEvidence"} & reading.keys()), "native state in AD reading")
    if row["cfg"] in runner.ALL_CONTROLS and not row["properties"] and result["controlClass"] == "choice":
        require(bugs, "no executed control divergence: " + row["cfg"])
    return {**result, "bugSteps": bugs}


def summary_add(summary, row, raw):
    behavior = raw["behavior"]
    summary["traces"] += 1
    summary["states"] += len(behavior)
    if row["cfg"] in runner.ALL_CONTROLS:
        summary["controls"].add(row["cfg"])
    for before, after in zip(behavior, behavior[1:]):
        if before["state"] == after["state"]:
            continue
        if after["control"]["class"] == "correct" and after["executedAction"] in summary["expectedActions"]:
            summary["actions"].add(after["executedAction"])
        if after["transition"] in summary["expectedFlaps"]:
            summary["flaps"].add(after["transition"])
        for fault in summary["expectedFaults"]:
            delta = after["state"]["faults"][fault] - before["state"]["faults"][fault]
            require(delta in (0, 1), "invalid fault edge")
            if delta:
                summary["faults"].add(fault)


def new_summary():
    source = (SOURCE / "PersonaDelivery.tla").read_text()
    return {"traces": 0, "states": 0, "controls": set(), "actions": set(), "faults": set(), "flaps": set(),
            "expectedActions": contract.inventory(source, "EngineActions"),
            "expectedFaults": contract.inventory(source, "FaultNames"),
            "expectedFlaps": {"AgentOwnTurnStart", "AgentTurnEnd", "PermissionOpen", "PermissionAnswer"}}


def supplemental_inputs(cfg_text, raw):
    """Independently reconstruct the finite original-Next coverage proof."""
    helper = load(SOURCE / "ci/temporal_sensitivity.py", "supplemental_temporal")
    lines = cfg_text.splitlines()
    require(lines[0] == "SPECIFICATION Spec", "changed supplemental specification")
    end = next(i for i, line in enumerate(lines) if line.startswith("INVARIANT "))
    constants = "\n".join(lines[1:end]) + "\n"
    invariants = "\n".join(line for line in lines[end:]
        if line.startswith("INVARIANT ") and line != "INVARIANT EmitSimulationTrace") + "\n"
    guide = r'''Guide ==
 CASE Len(st.a.input) > 0 -> PullBack
 [] st.a.box # None /\ st.a.submitted /\ st.a.actual # "idle" -> QueueMidTurn
 [] st.w.kind # "none" -> EngineStepSuccessful
 [] st.h.accepted = {} -> Accept
 [] st.faults["busyWaiting"] = 0 -> BusyWaiting
 [] st.g.owner = "delivery" /\ GateChoice(ObservedKnowledge) = "release" -> GateStep
 [] st.e.request = "delivery" /\ st.g.owner = "free" -> GateStep
 [] st.observation = "ready" \/ InternalContinuation -> EngineStepSuccessful
 [] OTHER -> EngineObserve
'''
    search = ("---------------- MODULE PullBackWitness ----------------\nEXTENDS PersonaDelivery\n" + guide
        + 'GuidedNext == Guide /\\ Next\nNoPullBack == st.faults["pullBack"] = 0\n'
        + "========================================================\n")
    library, (states, records) = helper.tla_values([[r["state"] for r in raw["behavior"]], raw["behavior"]])
    replay = r'''---------------- MODULE ExactReplay ----------------
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
 /\ PrintT("PULLBACK_EDGE " \o ToJson([position |-> position, legal |-> Next]))
 /\ Assert(Next, "supplemental prefix has an illegal original Next edge")
ReplayEvidence ==
 /\ PrintT("PULLBACK_STATE " \o ToJson([position |-> position,
      initial |-> IF position = 1 THEN Init ELSE TRUE,
      recordMatches |-> TraceRecord(st) = ReplayRecords[position]]))
 /\ (position = 1 => Init)
 /\ TraceRecord(st) = ReplayRecords[position]
ReplayGoal == position # Len(ReplayStates) \/ st.faults["pullBack"] = 1
========================================================
'''.replace("{library}", library).replace("{states}", states).replace("{records}", records)
    return guide, {
        "search": (search, "INIT Init\nNEXT GuidedNext\n" + constants + invariants
            + "INVARIANT NoPullBack\nALIAS TraceView\nPOSTCONDITION EmitTrace\n"),
        "replay": (replay, "INIT ReplayInit\nNEXT ReplayNext\n" + constants + invariants
            + "INVARIANT ReplayEvidence\nINVARIANT ReplayGoal\n")}


def validate_supplemental(envelope, source_inputs):
    require(envelope.get("schema") == 2 and envelope.get("cfg") == "supplemental_pullback"
        and envelope.get("spec") == "PersonaDelivery" and envelope.get("mode") == "check"
        and envelope.get("certification") is False and envelope.get("snapshot") == runner.snapshot_id(source_inputs)
        and envelope.get("behaviorMetadata") == {"replayField": "raw", "controlClass": "correct", "bugSteps": []},
        "changed supplemental identity")
    evidence = envelope.get("supplementalEvidence", {})
    payload, stored = evidence.get("payload", {}), evidence.get("artifacts", {})
    names = {"generate.py", "temporal_sensitivity.py", "input.cfg", "raw-trace.json",
        "search/PersonaDelivery.tla", "search/PullBackWitness.tla", "search/witness.cfg", "search/run.log",
        "replay/PersonaDelivery.tla", "replay/ExactReplay.tla", "replay/replay.cfg", "replay/run.log"}
    require(set(stored) == set(payload.get("artifacts", {})) == names, "missing/extra supplemental artifact")
    artifacts = {}
    for name, artifact in stored.items():
        require(set(artifact) == {"sha256", "base64"}, "changed supplemental artifact")
        content = base64.b64decode(artifact["base64"], validate=True)
        require(digest(content) == artifact["sha256"] == payload["artifacts"][name], "changed supplemental artifact: " + name)
        artifacts[name] = content
    raw = envelope["raw"]
    require(payload.get("schema") == 1 and payload.get("kind") == "supplemental-pullback-prefix"
        and payload.get("scope") == "existential finite original-Next prefix; outside canonical rows; no liveness claim"
        and payload.get("identity") == {"inputs": source_inputs, "currentMatches": True, "frozenMatches": True}
        and payload.get("raw") == raw and envelope.get("rawSha256") == digest(encoded(raw))
        and artifacts["raw-trace.json"] == encoded(raw) + b"\n", "changed supplemental provenance")
    for name, source in (("input.cfg", "ci/cfg/trace_agent.cfg"),
        ("temporal_sensitivity.py", "ci/temporal_sensitivity.py"),
        ("search/PersonaDelivery.tla", "PersonaDelivery.tla"), ("replay/PersonaDelivery.tla", "PersonaDelivery.tla")):
        require(digest(artifacts[name]) == source_inputs[source] and artifacts[name] == (SOURCE / source).read_bytes(),
            "changed supplemental frozen source")
    worker.validate_trace(raw, counterexample=True, temporal=False)
    guide, modules = supplemental_inputs(artifacts["input.cfg"].decode(), raw)
    binding = payload.get("binding", {})
    require(set(binding) == {"modelSha256", "inputCfgSha256", "jarSha256", "javaSha256",
        "generatorSha256", "temporalHelperSha256", "guideSha256"}
        and binding["modelSha256"] == source_inputs["PersonaDelivery.tla"]
        and binding["inputCfgSha256"] == source_inputs["ci/cfg/trace_agent.cfg"]
        and binding["jarSha256"] == source_inputs["tla2tools.jar"]
        and binding["temporalHelperSha256"] == source_inputs["ci/temporal_sensitivity.py"]
        and binding["generatorSha256"] == digest(artifacts["generate.py"])
        and binding["guideSha256"] == digest(guide.encode())
        and re.fullmatch(r"[0-9a-f]{64}", binding["javaSha256"]), "changed supplemental source bindings")

    def events(log, prefix):
        decoded = [json.loads(line) if line.startswith('"' + prefix) else line for line in log.splitlines()]
        return [json.loads(line[len(prefix):]) for line in decoded if line.startswith(prefix)]

    for kind, (module, cfg) in modules.items():
        filename = "PullBackWitness.tla" if kind == "search" else "ExactReplay.tla"
        cfgname = "witness.cfg" if kind == "search" else "replay.cfg"
        proof, log = payload[kind], artifacts[kind + "/run.log"].decode()
        require(artifacts[kind + "/" + filename] == module.encode() and artifacts[kind + "/" + cfgname] == cfg.encode()
            and proof["moduleSha256"] == digest(module.encode()) and proof["cfgSha256"] == digest(cfg.encode())
            and proof["logSha256"] == digest(log.encode()) and "Finished in" in log
            and type(proof["seconds"]) in (int, float) and 0 <= proof["seconds"] <= 60
            and proof["argv"][-3:] == ["-config", cfgname, filename]
            and not re.search(r"Exception|OutOfMemoryError|StackOverflowError|Evaluation error", log),
            "changed supplemental checker inputs/log")
        errors = [line for line in log.splitlines() if line.startswith("Error:")]
        if kind == "search":
            require(proof["exitCode"] == 12 and errors == ["Error: Invariant NoPullBack is violated.",
                "Error: The behavior up to this point is:"] and events(log, "TRACE ") == [raw],
                "missing genuine supplemental search trace")
        else:
            count = len(raw["behavior"])
            require(proof["exitCode"] == 0 and not errors and "Model checking completed. No error has been found." in log
                and events(log, "PULLBACK_STATE ") == [dict(position=i, initial=True, recordMatches=True) for i in range(1, count + 1)]
                and events(log, "PULLBACK_EDGE ") == [dict(position=i, legal=True) for i in range(1, count)],
                "missing original-Next supplemental replay proof")
    behavior, positions = raw["behavior"], []
    for i, (before, after) in enumerate(zip(behavior, behavior[1:]), 2):
        require(before["control"]["bug"] == after["control"]["bug"] == "none"
            and not before["control"]["bugStep"] and not after["control"]["bugStep"]
            and before["constants"] == after["constants"], "changed supplemental correct semantics")
        if after["state"]["faults"]["pullBack"] > before["state"]["faults"]["pullBack"]:
            require(after["transition"] == "PullBack", "missing executed supplemental PullBack")
            positions.append(i)
    summary = {"stateCount": len(behavior), "edgeCount": len(behavior) - 1, "pullBackPositions": positions,
        "faults": {f: max(r["state"]["faults"][f] for r in behavior) for f in behavior[0]["state"]["faults"]}}
    require(positions and behavior[0]["state"]["faults"]["pullBack"] == 0
        and behavior[-1]["state"]["faults"]["pullBack"] == 1 and payload.get("summary") == summary,
        "changed supplemental coverage")
    return {"kind": payload["kind"], "scope": payload["scope"], **summary}


def finish_summary(summary):
    for actual, expected in (("actions", "expectedActions"), ("faults", "expectedFaults"), ("flaps", "expectedFlaps")):
        require(summary[actual] == summary[expected], "missing executed coverage: " + actual + " " + str(sorted(summary[expected]-summary[actual])))
    require(summary["controls"] == set(runner.ALL_CONTROLS), "missing control traces")
    return {key: sorted(value) if isinstance(value, set) else value for key, value in summary.items() if not key.startswith("expected")}


def launch_budget(report):
    retained = report.get("localLaunch", {})
    require(set(retained) == {"raw", "sha256"} and isinstance(retained["raw"], str)
            and digest(retained["raw"].encode()) == retained["sha256"], "changed local launch provenance")
    launch = json.loads(retained["raw"])
    budget, workers, argv = launch.get("rowSeconds"), launch.get("workers"), launch.get("argv", [])
    require(type(budget) is int and 0 < budget <= 3600 and type(workers) is int and workers > 0
            and argv.count("--seconds") == argv.count("--workers") == argv.count("--proofs") == 1
            and argv[argv.index("--seconds") + 1] == str(budget)
            and argv[argv.index("--workers") + 1] == str(workers)
            and launch.get("proofs") is True and "--cfg" not in argv
            and launch.get("expectedRows") == report["expectedRows"]
            and launch.get("expectedAuxiliaryRows") == report["expectedAuxiliaryRows"]
            and launch.get("modelSha256") == report["modelSha256"]
            and launch.get("helperSha256") == report["inputs"]["ci/temporal_sensitivity.py"],
            "changed local launch budget or scope")
    return budget


def validate_report(report, rows):
    require(report.get("certification") is False and report.get("partial") is False, "not a complete local report")
    require(report.get("inputsUnchanged") is True and report.get("inputs") == inputs(), "changed local inputs")
    require(report["modelSha256"] == digest((SOURCE / "PersonaDelivery.tla").read_bytes()), "stale local model")
    launch_budget(report)
    require([r["cfg"] for r in report["rows"]] == [r["cfg"] for r in rows], "incomplete local manifest")
    auxiliary = cardinal.auxiliary_rows(SOURCE)
    require(report.get("expectedRows") == len(rows) and report.get("expectedAuxiliaryRows") == len(auxiliary)
            and [r["cfg"] for r in report["auxiliaryRows"]] == [r["cfg"] for r in auxiliary], "incomplete auxiliary manifest")
    checked = {prop for row in rows if row["mode"] == "check" and row["expect"] == "pass" for prop in row["checks"]}
    require(runner.CORE <= checked, "missing core safety/progress checks")
    for result, row in zip(report["rows"] + report["auxiliaryRows"], rows + auxiliary):
        require(result["matched"] is True and result["timeout"] is False, "unfinished local row: " + row["cfg"])
        require(result.get("proofsRequested") is True and result.get("proofError") is None,
                "missing/failed local proof: " + row["cfg"])
        require(row["expect"] != "violation" or result["traces"] >= 1, "missing local counterexample")
        require(row["cfg"] not in worker.WORK_WITNESS_ROWS or result["traces"] == 1, "missing accepted-work bundle")
        require(all(result[key] == row[key] for key in ("mode", "expect", "checks", "properties", "simulation")), "changed local row")
        require(result.get("temporalVerified") is (row["mode"] == "check" and bool(row["properties"])
                and row["expect"] == "pass"), "overstated local temporal verdict")
        if row["mode"] == "simulate":
            require(result["traces"] == row["simulation"]["num"]
                    and all(v == "UNVERIFIED" for v in result["propertyStatus"].values()), "simulation overstated")
        else:
            require(bool(result["initialDistinct"]), "vacuous local check")
            expected_status = "VERIFIED" if row["expect"] == "pass" else "EXPECTED-COUNTEREXAMPLE"
            require(result["propertyStatus"] == {prop: expected_status for prop in row["properties"]}, "overstated local property status")
        text = result["logSummary"]
        require(worker.result_matches(row, worker.classify(text, result["exitCode"], row["mode"])),
                "local checker result differs from report: " + row["cfg"])
        require("Finished in " in text and not re.search(r"Exception|OutOfMemoryError|StackOverflowError|Evaluation error", text), "incomplete/error local log")
        if row["expect"] == "pass":
            require(result["exitCode"] == 0 and ("Model checking completed. No error has been found." in text
                    if row["mode"] == "check" else "The number of states generated:" in text), "local pass has no verdict")
            require(not re.search(r"(?:Invariant \w+ is violated|Temporal propert.*violated)", text), "unexpected local violation")
        else:
            require(result["exitCode"] in (11, 12, 13) and any(
                f"Invariant {prop} is violated" in text or f"Temporal property {prop} was violated" in text
                for prop in row["props"].split(",")), "local log has no expected counterexample: " + row["cfg"])


def export(directory):
    report = json.loads((directory / "report.json").read_text())
    rows = runner.load_manifest(SOURCE, False)
    report["sourceReportSha256"] = digest((directory / "report.json").read_bytes())
    launch_raw = directory.with_suffix(".launch.json").read_bytes()
    report["localLaunch"] = {"raw": launch_raw.decode(), "sha256": digest(launch_raw)}
    require(report.get("inputsUnchanged") is True, "local run is not complete")
    for name, checksum in report["inputs"].items():
        require(digest((directory / "source" / name).read_bytes()) == checksum, "changed frozen input: " + name)
    for result in report["rows"] + report["auxiliaryRows"]:
        log_path = directory / result["cfg"] / "run.log"
        raw_log = log_path.read_bytes() if log_path.exists() else gzip.decompress(log_path.with_suffix(".log.gz").read_bytes())
        initial = re.search(r"Finished computing initial states: ([0-9,]+) distinct state", raw_log.decode())
        require(result["initialDistinct"] == (int(initial[1].replace(",", "")) if initial else None),
                "local initial-state count differs from original log")
        require(digest(raw_log) == result["logSha256"], "changed original local log")
        result["sourceLogSha256"] = digest(raw_log)
        exported = []
        for line in raw_log.decode().splitlines():
            if line.startswith('"TRACE '):
                line = json.loads(line)
            if line.startswith("TRACE "):
                exported.append(digest(encoded(json.loads(line[6:]))))
        if result["cfg"] == "core_head_taken_in":
            proof = json.loads((directory / result["cfg"] / "proof-envelope.json").read_text())
            result["rawTraceSha256s"] = [digest(encoded(proof["acceptedWork"]["payload"]["raw"]))]
        else:
            require(len(exported) == result["traces"], "trace count differs from original log")
            result["rawTraceSha256s"] = exported
        result["logSummary"] = "\n".join(line for line in raw_log.decode().splitlines()
                                                if not line.startswith(('"TRACE ', 'TRACE ')))
    validate_report(report, rows)
    row_budget = launch_budget(report)
    source_inputs = inputs()
    fixtures, summary = {}, new_summary()
    for row, result in zip(rows, report["rows"]):
        path = directory / row["cfg"] / "traces.json"
        traces = json.loads(path.read_text()) if path.exists() else []
        require(len(traces) == result["traces"], "local trace count mismatch")
        require([digest(encoded(raw)) for raw in traces] == result["rawTraceSha256s"], "raw trace differs from original export")
        result["sourceTracesSha256"] = digest(path.read_bytes()) if traces else None
        for index, raw in enumerate(traces, 1):
            proof_path = directory / row["cfg"] / "proof-envelope.json"
            proof = json.loads(proof_path.read_text()) if proof_path.exists() else {}
            requires_proof = row["cfg"] in worker.WORK_WITNESS_ROWS or (row["cfg"] in runner.ALL_CONTROLS and row["properties"])
            require(bool(proof) == bool(requires_proof) and (not proof or proof["raw"] == raw), "missing/changed proof envelope")
            if requires_proof:
                expected_keys = {"raw", "acceptedWork"} if row["cfg"] in worker.WORK_WITNESS_ROWS else {
                    "raw", "concreteCandidate", "candidateSource", "temporalSensitivity"}
                require(set(proof) == expected_keys, "changed local proof envelope inventory")
            envelope = {"schema": 2, "cfg": row["cfg"], "spec": row["spec"], "mode": row["mode"],
                        "certification": False, "raw": raw, "rawSha256": digest(encoded(raw)),
                        "snapshot": runner.snapshot_id(source_inputs), "simulation": row["simulation"],
                        "what": row["what"], "property": row["props"], **proof,
                        "localRowBudgetSeconds": row_budget,
                        "hashes": {key: source_inputs[row[key + "_path"]] for key in ("spec", "cfg")},
                        "localArtifacts": retain_artifacts(directory / row["cfg"] / "temporal-proof")}
            envelope["behaviorMetadata"] = metadata(row, envelope, source_inputs, row_budget)
            validate_temporal_artifacts(row, envelope)
            fixtures[f"{row['cfg']}-{index:03d}.json"] = pack(envelope)
            summary_add(summary, row, envelope[envelope["behaviorMetadata"]["replayField"]])
    auxiliary_evidence = {}
    for row, result in zip(cardinal.auxiliary_rows(SOURCE), report["auxiliaryRows"]):
        path = directory / row["cfg"] / "traces.json"
        traces = json.loads(path.read_text()) if path.exists() else []
        evidence_path = directory / row["cfg"] / "permission-lasso.json"
        auxiliary_evidence[row["cfg"]] = {"traces": traces,
            "permissionLasso": json.loads(evidence_path.read_text()) if evidence_path.exists() else None}
        validate_auxiliary(row, result, auxiliary_evidence[row["cfg"]])
    supplemental_directory = directory / "supplemental/pullback"
    supplemental_payload = json.loads((supplemental_directory / "evidence.json").read_text())
    supplemental_envelope = {"schema": 2, "cfg": "supplemental_pullback", "spec": "PersonaDelivery",
        "mode": "check", "certification": False, "raw": supplemental_payload["raw"],
        "rawSha256": digest(encoded(supplemental_payload["raw"])),
        "snapshot": runner.snapshot_id(source_inputs),
        "behaviorMetadata": {"replayField": "raw", "controlClass": "correct", "bugSteps": []},
        "supplementalEvidence": {"payload": supplemental_payload,
            "artifacts": {name: {"sha256": digest((supplemental_directory / name).read_bytes()),
                "base64": base64.b64encode((supplemental_directory / name).read_bytes()).decode()}
                for name in supplemental_payload["artifacts"]}}}
    supplemental_summary = validate_supplemental(supplemental_envelope, source_inputs)
    fixtures[SUPPLEMENTAL_NAME] = pack(supplemental_envelope)
    summary_add(summary, {"cfg": "supplemental_pullback"}, supplemental_envelope["raw"])
    totals = finish_summary(summary)
    coverage = {"schema": 3, "evidenceKind": "local-tlc-replay", "certification": False,
                "limitations": ["Local TLC execution; no scheduler certification or scheduler artifact provenance"],
                "auxiliaryEvidence": auxiliary_evidence,
                "supplementalEvidence": {SUPPLEMENTAL_NAME: supplemental_summary},
                "inputs": source_inputs, "report": report, "summary": totals,
                "engineActions": totals["actions"], "boundedFaults": totals["faults"],
                "flappingActions": totals["flaps"], "controls": totals["controls"],
                "fixtures": {name: digest(encoded(value) + b"\n") for name, value in sorted(fixtures.items())}}
    # Stage/validate everything above before replacing any previous evidence.
    DESTINATION.mkdir(exist_ok=True)
    previous = {p.name for p in DESTINATION.iterdir()}
    # Keep inventories in ignored storage, keyed by the resolved run directory.
    # Re-exporting that run retains its baseline; a new run starts from the
    # fixtures present at its first export, never an earlier run's inventory.
    run_key = digest(str(directory.resolve()).encode())
    changes_path = SOURCE / "ci/.runs/export-inventories" / run_key / "trace-changes.json"
    changes_path.parent.mkdir(parents=True, exist_ok=True)
    original = {entry["file"].rsplit("/", 1)[-1] for entry in json.loads(changes_path.read_text())
                if entry["change"] != "added"} if changes_path.exists() else previous
    inventory_path = directory.parent / "cardinal-recovery-inventory.json"
    reasons = {entry["cfg"]: entry["reason"] for entry in json.loads(inventory_path.read_text())["traceRegeneration"]} if inventory_path.exists() else {}
    changes = []
    for name, value in {**fixtures, "coverage.json": coverage}.items():
        changes.append({"file": "tests/fixtures/delivery-traces/" + name,
                        "change": "rewritten" if name in original else "added",
                        "reason": ("Add separately proven original-Next PullBack prefix to cover the genuine fault missed by the fixed-seed manifest traces."
                        if name == SUPPLEMENTAL_NAME else reasons.get(name.rsplit("-", 1)[0], "Regenerated from complete waiting-only AD model run with retained independent local proofs."))
                        if name != "coverage.json" else "Bind all 76 delivery rows, 8 auxiliary rows and proof bundles to unchanged current/frozen inputs."})
        (DESTINATION / name).write_bytes(encoded(value) + b"\n")
    for name in original - set(fixtures) - {"coverage.json"}:
        changes.append({"file": "tests/fixtures/delivery-traces/" + name, "change": "deleted",
                        "reason": reasons.get(name.rsplit("-", 1)[0], "Regenerate from the current AD model.")
                        + " Delete this superseded sample because the actual TLC output has no corresponding trace."})
    for name in previous - set(fixtures) - {"coverage.json"}:
        (DESTINATION / name).unlink()
    changes_path.write_bytes(encoded(sorted(changes, key=lambda c: c["file"])) + b"\n")
    print(json.dumps({"summary": totals, "superseded": sorted(previous - set(fixtures) - {"coverage.json"})}))


def validate():
    coverage = json.loads((DESTINATION / "coverage.json").read_text())
    require(coverage.get("schema") == 3 and coverage.get("evidenceKind") == "local-tlc-replay"
            and coverage.get("certification") is False, "not local replay evidence")
    require(coverage["inputs"] == inputs(), "stale local replay inputs")
    rows = runner.load_manifest(SOURCE, False)
    validate_report(coverage["report"], rows)
    row_budget = launch_budget(coverage["report"])
    require(set(coverage["fixtures"]) | {"coverage.json"} == {p.name for p in DESTINATION.iterdir()}, "changed fixture inventory")
    summary, selected = new_summary(), {row["cfg"]: [] for row in rows}
    trace_hashes = {row["cfg"]: [] for row in rows}
    by_cfg = {row["cfg"]: row for row in rows}
    require(set(coverage.get("supplementalEvidence", {})) == {SUPPLEMENTAL_NAME}
            and SUPPLEMENTAL_NAME in coverage["fixtures"], "missing supplemental fault coverage")
    for name, checksum in sorted(coverage["fixtures"].items()):
        require(re.fullmatch(r"[A-Za-z0-9_-]+-[0-9]{3}\.json", name), "unsafe fixture name")
        raw_bytes = (DESTINATION / name).read_bytes()
        require(digest(raw_bytes) == checksum, "changed frozen fixture")
        envelope = unpack(json.loads(raw_bytes))
        if name == SUPPLEMENTAL_NAME:
            require(validate_supplemental(envelope, coverage["inputs"]) == coverage["supplementalEvidence"][name],
                    "changed supplemental coverage summary")
            summary_add(summary, {"cfg": "supplemental_pullback"}, envelope["raw"])
            continue
        row = by_cfg[name.rsplit("-", 1)[0]]
        require(envelope["cfg"] == row["cfg"] and envelope["spec"] == row["spec"]
                and envelope["mode"] == row["mode"] and envelope["certification"] is False, "changed fixture identity")
        require(envelope["hashes"] == {key: coverage["inputs"][row[key + "_path"]] for key in ("spec", "cfg")}, "stale fixture sources")
        raw = envelope["raw"]
        require(digest(encoded(raw)) == envelope["rawSha256"], "changed raw trace")
        require(envelope["behaviorMetadata"] == metadata(row, envelope, coverage["inputs"], row_budget), "changed replay metadata")
        validate_temporal_artifacts(row, envelope)
        summary_add(summary, row, envelope[envelope["behaviorMetadata"]["replayField"]])
        selected[row["cfg"]].append(name)
        trace_hashes[row["cfg"]].append(envelope["rawSha256"])
    for row, result in zip(rows, coverage["report"]["rows"]):
        require(selected[row["cfg"]] == [f"{row['cfg']}-{i:03d}.json" for i in range(1, result["traces"]+1)], "incomplete trace row")
        require(trace_hashes[row["cfg"]] == result["rawTraceSha256s"], "changed original raw trace inventory")
    auxiliary = cardinal.auxiliary_rows(SOURCE)
    require(set(coverage["auxiliaryEvidence"]) == {row["cfg"] for row in auxiliary}, "changed auxiliary inventory")
    for row, result in zip(auxiliary, coverage["report"]["auxiliaryRows"]):
        validate_auxiliary(row, result, coverage["auxiliaryEvidence"][row["cfg"]])
    summary = finish_summary(summary)
    require(summary == coverage["summary"], "changed executed coverage")
    for actual, expected in (("actions", "engineActions"), ("faults", "boundedFaults"), ("flaps", "flappingActions"), ("controls", "controls")):
        require(summary[actual] == coverage[expected], "changed coverage inventory")
    return {key: len(value) if isinstance(value, list) else value for key, value in summary.items()}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--export", type=Path)
    args = parser.parse_args()
    if args.export:
        export(args.export)
    else:
        print(json.dumps(validate()))
