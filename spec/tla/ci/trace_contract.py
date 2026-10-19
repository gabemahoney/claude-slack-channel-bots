"""Validate scheduler trace evidence and export deterministic E3 fixtures.

No checker or scheduler is invoked here. Evidence is accepted only for a complete
run with the exact current input snapshot; coverage counts executed edges.
"""
from __future__ import annotations

import argparse
import base64
import hashlib
import importlib.util
import json
from pathlib import Path
import re
import sys
import tempfile
import time

_STORAGE_SPEC = importlib.util.spec_from_file_location("trace_storage", Path(__file__).with_name("local_storage.py"))
storage = importlib.util.module_from_spec(_STORAGE_SPEC)
_STORAGE_SPEC.loader.exec_module(storage)


class TraceRefusal(ValueError):
    pass


def require(condition, why):
    if not condition:
        raise TraceRefusal(why)


def encoded(value):
    return (json.dumps(value, sort_keys=True, separators=(",", ":")) + "\n").encode()


def digest(path):
    return storage.file_digest(path)


def load_module(path, name):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def inventory(source, name):
    match = re.search(r"^" + name + r"\s*==\s*\{([^}]+)\}", source, re.M)
    require(match is not None, f"missing source inventory {name}")
    return set(re.findall(r'"([^"\n]+)"', match[1]))


def cfg_constants(text):
    constants = {}
    for name, token in re.findall(r'^\s+([A-Za-z][A-Za-z0-9_]*)\s*=\s*("[^"\n]*"|TRUE|FALSE|[0-9]+|\{[^}]*\})', text, re.M):
        require(name not in constants, "duplicate cfg constant")
        if token.startswith("{"):
            value = sorted(re.findall(r'"([^"\n]+)"', token))
        elif token in ("TRUE", "FALSE"):
            value = token == "TRUE"
        else:
            value = json.loads(token)
        constants[name] = value
    return constants


def validate_constants(actual, expected, fault_names):
    """Only Faults is a TLA set; JSON arrays elsewhere retain their order."""
    for constants in (actual, expected):
        faults = constants.get("Faults")
        require(isinstance(faults, list) and all(isinstance(fault, str) for fault in faults),
                "Faults must encode a set of strings")
        require(len(faults) == len(set(faults)) and set(faults) <= fault_names,
                "Faults has duplicate or unknown members")
    require(set(actual["Faults"]) == set(expected["Faults"]),
            "trace Faults differ from cfg")
    require(encoded({key: value for key, value in actual.items() if key != "Faults"})
            == encoded({key: value for key, value in expected.items() if key != "Faults"}),
            "trace constants differ from cfg")


def validate_accepted_work(root, run, row, envelope, worker, *, deadline=None, result=None):
    """Recheck retained scheduler artifacts offline; this never starts Java/TLC.

    The execution deadline remains the original row's. A separate bounded
    collection deadline limits file validation after that remote clock expired.
    The retained launcher is read only for its digest, never made executable.
    """
    with storage.session(root / "ci/.runs"):
        return _validate_accepted_work(root, run, row, envelope, worker, deadline=deadline, result=result)


def _validate_accepted_work(root, run, row, envelope, worker, *, deadline=None, result=None):
    require((row["cfg"], row["props"], row["expect"], row["mode"]) in {
        ("probe_premise", "NotPremise", "violation", "check"),
        ("core_head_taken_in", "-", "pass", "check")}, "wrong accepted-work row")
    expected_checks = (["TypeOK", "DurableAccept", "NoDrop", "ReceiptBacked", "InOrder",
                        "TranscriptFIFO", "OneInFlight", "NoTypeIntoText", "NoRetypeWhileWorking",
                        "GateExclusive", "NoDuplicateKey", "HeadTakenIn"]
                       if row["cfg"] == "core_head_taken_in" else ["NotPremise"])
    require(row["checks"] == expected_checks and row["properties"] == [expected_checks[-1]],
            "accepted-work row changed its original checked declarations")
    for name in ("ci/work_witness.py", "ci/temporal_sensitivity.py", "ci/local_storage.py", "tla2tools.jar"):
        require(run["inputs"].get(name) == digest(root / name), "stale accepted-work dependency: " + name)
    helper = worker.load_work_witness(root / "ci/work_witness.py")
    deadline = time.monotonic() + 120 if deadline is None else deadline
    helper.budget(deadline)
    evidence = envelope.get("acceptedWork")
    require(isinstance(evidence, dict) and set(evidence) == {
        "schema", "rowStartedMonotonic", "rowDeadline", "payload", "artifacts"}
        and evidence["schema"] == 1, "missing separate canonical accepted-work evidence")
    started, original_deadline = evidence["rowStartedMonotonic"], evidence["rowDeadline"]
    require(type(started) in (int, float) and type(original_deadline) in (int, float)
            and 0 < original_deadline - started <= row["cap_s"], "accepted work reset the row clock")
    payload = evidence["payload"]
    require(isinstance(payload, dict) and payload.get("executionDeadline") == original_deadline,
            "accepted work did not use the original row deadline")
    for kind in ("search", "replay"):
        proof = payload.get(kind, {})
        require(proof.get("rowDeadline") == original_deadline
                and type(proof.get("startedMonotonic")) in (int, float)
                and proof["startedMonotonic"] >= started, "accepted-work proof outside original row")
    if result is not None:
        require(result.get("row_started_monotonic") == started and result.get("row_deadline") == original_deadline
                and payload["replay"].get("finishedMonotonic", original_deadline)
                <= result.get("row_finished_monotonic", started) < original_deadline,
                "accepted-work execution timing differs from retained row result")
    if run.get("run"):
        require(result is not None, "canonical accepted-work validation needs its retained row result")
        locations = helper.recorded_locations(payload)
        require(locations["jar"] == "/work/tla2tools.jar"
                and locations["workdir"] == f"/work/logs/{row['cfg']}-accepted-work-0"
                and Path(locations["java"]).name == "java", "wrong canonical accepted-work execution roots")
    artifacts = evidence["artifacts"]
    require(isinstance(artifacts, dict) and set(artifacts) == set(worker.WORK_WITNESS_ARTIFACTS),
            "missing/extra retained accepted-work artifacts")
    local = sys.modules[storage.ACTIVE_KEY]
    incoming = 0
    for name in worker.WORK_WITNESS_ARTIFACTS:
        helper.budget(deadline)
        require(isinstance(name, str) and not Path(name).is_absolute() and ".." not in Path(name).parts,
                "invalid accepted-work artifact path")
        artifact = artifacts[name]
        require(isinstance(artifact, dict) and set(artifact) == {"sha256", "base64"}
                and isinstance(artifact["base64"], str), "malformed accepted-work artifact")
        text = artifact["base64"]
        require(len(text) <= worker.LOGCAP_BYTES * 4 // 3 + 4,
                "oversized accepted-work artifact")
        require(len(text) % 4 == 0 and re.fullmatch(r"[A-Za-z0-9+/]*={0,2}", text) is not None,
                "malformed accepted-work base64 size")
        incoming += len(text) // 4 * 3 - (len(text) - len(text.rstrip("=")))
    require(0 <= incoming <= worker.LOGCAP_BYTES, "oversized accepted-work artifact inventory")
    local.check(incoming + 4096 * (len(artifacts) + 2))
    with tempfile.TemporaryDirectory(prefix="accepted-work-", dir=local.home) as temporary:
        directory = Path(temporary)
        total = 0
        for name in worker.WORK_WITNESS_ARTIFACTS:
            helper.budget(deadline)
            artifact = artifacts[name]
            require(isinstance(artifact, dict) and set(artifact) == {"sha256", "base64"}
                    and isinstance(artifact["base64"], str), "malformed accepted-work artifact")
            require(len(artifact["base64"]) <= worker.LOGCAP_BYTES * 4 // 3 + 4,
                    "oversized accepted-work artifact")
            content = base64.b64decode(artifact["base64"], validate=True)
            local.check(len(content) + 4096)
            total += len(content)
            require(total <= worker.LOGCAP_BYTES and hashlib.sha256(content).hexdigest() == artifact["sha256"],
                    "changed/oversized accepted-work artifact: " + name)
            path = directory / name
            path.parent.mkdir(parents=True, exist_ok=True)
            with storage.regular_file(path, "wb") as output:
                output.write(content)
        require((directory / "evidence.json").read_bytes() == helper.temporal.canonical(payload),
                "retained accepted-work payload changed")
        worker.validate_trace(payload.get("raw", {}), counterexample=True, temporal=True)
        if row["cfg"] == "probe_premise":
            require(payload["raw"] != envelope["raw"], "empty premise probe is not accepted-work evidence")
        else:
            require(payload["raw"] == envelope["raw"], "core witness trace differs from its bundle")
        summary = helper.verify_payload(root / row["spec_path"], root / row["cfg_path"],
                                        root / "tla2tools.jar", directory / "java-launcher", directory,
                                        payload, deadline)
        require(summary.get("exhaustivePositiveCertification") is False
                and len(summary.get("fairness", {})) == 7, "misleading accepted-work scope")
        expected_accepted, expected_parts = (([1], [[1, 1]]) if row["cfg"] == "core_head_taken_in"
                                              else ([1, 2], [[1, 1], [1, 2], [2, 1]]))
        require(summary.get("accepted") == expected_accepted and summary.get("parts") == expected_parts,
                "accepted-work coverage differs from the exact core/probe bounds")
        summary = {**summary, "boundedPositiveNonvacuity": True, "universalProgress": False,
                   "artifactHashes": {name: artifacts[name]["sha256"] for name in worker.WORK_WITNESS_ARTIFACTS}}
    helper.budget(deadline)
    return summary


def validate_envelope(root, run, row, envelope, worker, *, deadline=None, result=None):
    runner = load_module(root / "ci/runner.py", "delivery_runner_for_envelope")
    content = (root / row["cfg_path"]).read_text()
    runner.validate_restart_cfg(row["cfg"], content, row["mode"])
    runner.validate_shared_cfg(row["cfg"], content, row["mode"])
    reduction = (runner.restart_reduction(row["cfg"])
                 if set(runner.cfg_tokens(content)) & {"VIEW", "CONSTRAINT"} else None)
    require(row.get("state_reduction") == reduction, "trace row state reduction differs from cfg")
    require(envelope.get("schema") == 2 and envelope.get("snapshot") == run["snapshot"],
            "trace schema/snapshot mismatch")
    require(all(envelope.get(name) == row[name] for name in ("cfg", "spec", "mode", "simulation", "what")),
            "trace row metadata mismatch")
    require(envelope.get("property") == row["props"], "trace property mismatch")
    expected_hashes = {"spec": run["inputs"][row["spec_path"]],
                       "cfg": run["inputs"][row["cfg_path"]]}
    require(envelope.get("hashes") == expected_hashes, "trace source hashes mismatch")
    require(all(digest(root / row[k + "_path"]) == v for k, v in expected_hashes.items()),
            "trace sources are stale")
    raw = envelope.get("raw", {})
    require(raw.get("schema") == 1, "bad raw trace schema")
    worker.validate_trace(raw, counterexample=row["expect"] == "violation", temporal=bool(row["properties"]))
    constants = cfg_constants((root / row["cfg_path"]).read_text())
    fault_names = inventory((root / row["spec_path"]).read_text(), "FaultNames")
    expected_class = ("environment-assumption" if constants["Scenario"] == "control-no-assumption"
                      else "fairness" if constants["Bug"] == "weak_observe"
                      else "scheduling" if constants["Bug"] == "replace_observation"
                      else "correct" if constants["Bug"] == "none" else "choice")
    temporal_control = row["expect"] == "violation" and row["properties"] and expected_class != "correct"
    view_raw = raw
    if temporal_control:
        raw = envelope.get("concreteCandidate")
        require(isinstance(raw, dict) and raw.get("schema") == 1,
                "missing separate concrete temporal candidate")
        worker.validate_trace(raw, counterexample=True, temporal=True)
    else:
        require("concreteCandidate" not in envelope and "temporalSensitivity" not in envelope
                and "candidateSource" not in envelope,
                "unexpected temporal candidate or evidence")
    behavior = raw["behavior"]
    for record in (view_raw["behavior"] + behavior if temporal_control else behavior):
        require(record.get("schema") == 1 and record.get("model") == "PersonaDelivery", "wrong model record")
        for key in ("state", "knowledge", "gateKnowledge", "observationKnowledge", "timerConstants", "constants", "control"):
            require(isinstance(record.get(key), dict), f"missing replay field {key}")
        require(all(isinstance(record.get(key), str) for key in
                    ("EngineChoice", "GateChoice", "correctEngineChoice", "correctGateChoice", "transition", "executedAction", "outcome")),
                "missing replay decisions or transition metadata")
        require(isinstance(record.get("expiredTimers"), list), "missing timer expiries")
        require("Bug" not in record["constants"], "Bug must come from control metadata")
        validate_constants({**record["constants"], "Bug": record["control"].get("bug")},
                           constants, fault_names)
        require(record["control"].get("class") == expected_class
                and isinstance(record["control"].get("bugStep"), bool), "control metadata mismatch")
        state = record["state"]
        require(record["transition"] == state["transition"] and record["executedAction"] == state["action"]
                and record["outcome"] == state["outcome"] and record["expiredTimers"] == state["expired"],
                "transition projection differs from state")
        require(set(record["expiredTimers"]) <= set(state["e"]["timers"]), "unknown expired timer")
        require(record["timerConstants"] == behavior[0]["timerConstants"], "timer constants changed")
    # Graph edges retain the lasso's complete prefix, closing edge and stutter.
    graph = raw.get("counterexample", {})
    closing = [edge for edge in graph.get("action", []) if edge[2][0] <= edge[0][0]]
    metadata = {"schema": 2,
                      "violationPosition": len(behavior) if row["expect"] == "violation" else None,
                      "loopStart": closing[0][2][0] if closing else None,
                      "loopEnd": closing[0][0][0] if closing else None,
                      "stuttering": bool(closing and closing[0][0][1] == closing[0][2][1]),
                      "controlClass": expected_class}
    if temporal_control:
        helper = root / "ci/temporal_sensitivity.py"
        require(run["inputs"].get("ci/temporal_sensitivity.py") == digest(helper),
                "temporal sensitivity helper is not in the frozen inputs")
        sensitivity = load_module(helper, "delivery_temporal_sensitivity")
        metadata["candidateSource"] = sensitivity.validate_candidate_source(root, row, envelope)
        metadata["temporalSensitivity"] = sensitivity.validate_evidence(
            root, row, raw, envelope.get("temporalSensitivity"), require_contrast=True)
        metadata["candidateKind"] = "independent-concrete-witness"
        metadata["replayField"] = "concreteCandidate"
        metadata["viewTraceSha256"] = hashlib.sha256(encoded(view_raw)).hexdigest()
        metadata["concreteCandidateSha256"] = hashlib.sha256(encoded(raw)).hexdigest()
    else:
        metadata["replayField"] = "raw"
    if row["cfg"] == runner.VIEW_ONLY_CONTROL:
        metadata["traceSha256"] = hashlib.sha256(encoded(raw)).hexdigest()
        metadata["maxEnterRetries"] = max(record["state"]["e"]["enterRetries"] for record in behavior)
        metadata["maxPersistedSendsPerPair"] = max((
            sum(sent["item"] == item["item"] and sent["part"] == item["part"]
                for sent in record["state"]["p"]["sent"])
            for record in behavior for item in record["state"]["p"]["sent"]), default=0)
    if row["cfg"] in worker.WORK_WITNESS_ROWS:
        if row["cfg"] == "probe_premise":
            metadata["probeBoundedPositiveNonvacuity"] = False
        metadata["acceptedWork"] = validate_accepted_work(root, run, row, envelope, worker,
                                                         deadline=deadline, result=result)
    else:
        require("acceptedWork" not in envelope, "accepted-work evidence attached to another row")
    return behavior, metadata


def validate_restart_mutation_behavior(row, behavior):
    """Require the full negative prefix, including its violating state, in scope.

    TLC checks invariants on boundary successors before pruning constraints.
    A violation on a third-send boundary is therefore insufficient for this
    sensitivity claim and is refused even if the worker named the right target.
    The authorized original retype control has only a VIEW and keeps its full
    retry prefix; it makes none of these companion constraint claims.
    """
    if row["cfg"] == "control_retype_into_text":
        require(row.get("state_reduction") == {"view": "RestartSafetyView", "constraint": None},
                "original retype control has incorrect VIEW-only metadata")
        return
    for record in behavior:
        state = record["state"]
        counts = {}
        for sent in state["p"]["sent"]:
            pair = (sent["item"], sent["part"])
            counts[pair] = counts.get(pair, 0) + 1
        require(all(count <= 2 for count in counts.values()),
                f"companion counterexample leaves two-send constraint: {row['cfg']}")
        require(all(value in (0, 1) for value in state["e"]["timers"].values()),
                "companion counterexample has nonbinary timer")
        require(all(value == 0 for name, value in state["faults"].items()
                    if name not in record["constants"]["Faults"]),
                "companion counterexample has inactive fault")


def executed_bug_steps(row, behavior, *, companion=False):
    """Locate executed choice/target divergences using the pre-edge readings."""
    bug_edges, marked_edges = [], []
    for index, (before, after) in enumerate(zip(behavior, behavior[1:]), 1):
        if before["state"] == after["state"]:
            continue
        engine_ran = after["executedAction"] == before["EngineChoice"]
        gate_ran = ((after["transition"] == "GateStep"
                     and after["executedAction"] == before["GateChoice"])
                    or (after["transition"] == "ReconnectStep"
                        and after["executedAction"] == "reconnectTextAndEnter"
                        and before["GateChoice"] in ("runReconnect", "stealForReconnect")))
        target_diff = (after["executedAction"] in
                       {"fixText", "recordSend", "recordEnterRetry", "readReceipt", "recordNotice"}
                       and before["selectedTarget"] != before["correctSelectedTarget"])
        diverged = ((engine_ran and (before["EngineChoice"] != before["correctEngineChoice"] or target_diff))
                    or (gate_ran and before["GateChoice"] != before["correctGateChoice"]))
        if diverged:
            bug_edges.append(index)
        if companion and after["control"]["bugStep"]:
            require(diverged, f"companion bugStep has no executed divergence: {row['cfg']}")
            marked_edges.append(index)
    if companion:
        require(marked_edges, f"missing executed companion bugStep: {row['cfg']}")
    return bug_edges


def validate_mutation_group(root, run, job, traces, results=None):
    """Gate advancement before renewed positives, using genuine saved traces."""
    worker = load_module(root / "jobs/lib/job.py", "delivery_worker_for_mutation_gate")
    runner = load_module(root / "ci/runner.py", "delivery_runner_for_mutation_gate")
    for row in job["rows"]:
        if row["cfg"] not in worker.WORK_WITNESS_ROWS and (not runner.reduced_cfg(row) or row["expect"] != "violation"):
            continue
        selected = [trace for trace in traces if trace["cfg"] == row["cfg"]]
        require(selected, "missing companion counterexample")
        if row["cfg"] in worker.WORK_WITNESS_ROWS:
            require(len(selected) == 1, "each accepted-work row requires exactly one bundle")
        for envelope in selected:
            result = next((entry for entry in results or [] if entry["cfg"] == row["cfg"]), None)
            behavior, metadata = validate_envelope(root, run, row, envelope, worker, result=result)
            validate_restart_mutation_behavior(row, behavior)
            companion = row["cfg"] in runner.RESTART_MUTATIONS
            if companion:
                require(metadata["controlClass"] == "choice", "companion must be a safety choice mutant")
            bugs = executed_bug_steps(row, behavior, companion=companion)
            if (row["cfg"] in runner.ALL_CONTROLS and metadata["controlClass"] == "choice"
                    and not row["properties"]):
                require(bugs, f"no executed mutant divergence: {row['cfg']}")


def collect_evidence(root, run):
    with storage.session(root / "ci/.runs"):
        return _collect_evidence(root, run)


def _collect_evidence(root, run):
    runner = load_module(root / "ci/runner.py", "delivery_runner_for_traces")
    worker = load_module(root / "jobs/lib/job.py", "delivery_worker_for_traces")
    require(not run.get("proof") and not run.get("diagnostic"), "exploratory evidence cannot certify delivery")
    require(run.get("outstanding") is None and run.get("phase") in ("ready", "certified"), "run not complete")
    require(runner.verify_pins(root) == run["inputs"]
            and runner.snapshot_id(run["inputs"]) == run["snapshot"], "stale run inputs")
    rows = runner.load_manifest(root, False)
    plan = runner.build_plan(rows, False)
    require(run["rows"] == rows and run["plan"] == plan and run["next"] == len(plan), "partial or changed suite")
    require([job["job"] for job in run["completed"]] == [job["name"] for job in plan], "missing completed groups")
    require([job["id"] for job in run["completed"]] == run["ids"]
            and len(set(run["ids"])) == len(run["ids"]), "job association mismatch")
    source = (root / "PersonaDelivery.tla").read_text()
    engine_actions, faults = inventory(source, "EngineActions"), inventory(source, "FaultNames")
    flapping = {"AgentOwnTurnStart", "AgentTurnEnd", "PermissionOpen", "PermissionAnswer"}
    actions_seen, faults_seen, flapping_seen, controls_seen = set(), set(), set(), set()
    fixtures, restart_evidence, mutation_evidence = {}, {}, {}
    accepted_work = {}
    row_modes = {}
    directory = root / "ci/.runs" / run["run"]
    runner.verify_local_sany(directory, run)
    for job, completed in zip(plan, run["completed"]):
        results, traces = runner.read_completed(directory, completed, job, run["snapshot"])
        for row in job["rows"]:
            result = next(entry for entry in results if entry["cfg"] == row["cfg"])
            row_modes[row["cfg"]] = {"jobId": completed["id"], "mode": row["mode"],
                                     "simulation": row["simulation"], "result": result["result"],
                                     "exhaustive": result["exhaustive"],
                                     "propertyStatus": result["propertyStatus"],
                                     "simulationStats": result["simulationStats"],
                                     "stateReduction": runner.restart_reduction(row),
                                     "cfgSha256": run["inputs"][row["cfg_path"]]}
            if row["group"] == "restart-order":
                result = next(entry for entry in results if entry["cfg"] == row["cfg"])
                restart_evidence[row["cfg"]] = {
                    "jobId": completed["id"], "mode": row["mode"],
                    "exhaustive": result["exhaustive"], "simulation": row["simulation"],
                    "scope": ("constrained restart safety" if row["mode"] == "check"
                              else "constrained sampled restart safety") if runner.restart_reduction(row)
                             else "raw larger simulation",
                    "stateReduction": runner.restart_reduction(row), "capSeconds": row["cap_s"],
                    "result": result["result"], "distinct": result["distinct"], "depth": result["depth"],
                    "constants": cfg_constants((root / row["cfg_path"]).read_text()),
                    "cfgSha256": run["inputs"][row["cfg_path"]],
                }
            if row["cfg"] in runner.RESTART_MUTATIONS:
                result = next(entry for entry in results if entry["cfg"] == row["cfg"])
                mutation_evidence[row["cfg"]] = {
                    "jobId": completed["id"], "result": result["result"],
                    "target": row["props"], "stateReduction": runner.restart_reduction(row),
                    "constants": cfg_constants((root / row["cfg_path"]).read_text()),
                    "cfgSha256": run["inputs"][row["cfg_path"]],
                }
            selected = [trace for trace in traces if trace["cfg"] == row["cfg"]]
            for number, envelope in enumerate(selected, 1):
                behavior, metadata = validate_envelope(root, run, row, envelope, worker, result=result)
                if row["cfg"] in worker.WORK_WITNESS_ROWS:
                    require(row["cfg"] not in accepted_work and len(selected) == 1, "duplicate accepted-work witness")
                    accepted_work[row["cfg"]] = {"jobId": completed["id"], **metadata["acceptedWork"]}
                if runner.reduced_cfg(row):
                    validate_restart_mutation_behavior(row, behavior)
                bug_edges = executed_bug_steps(row, behavior, companion=row["cfg"] in runner.RESTART_MUTATIONS)
                for index, (before, after) in enumerate(zip(behavior, behavior[1:]), 1):
                    if before["state"] == after["state"]:
                        continue
                    # Count actions which ran, never advertised EngineActions.
                    if after["control"]["class"] == "correct" and after["executedAction"] in engine_actions:
                        actions_seen.add(after["executedAction"])
                    if after["transition"] in flapping:
                        flapping_seen.add(after["transition"])
                    for fault in faults:
                        delta = after["state"]["faults"][fault] - before["state"]["faults"][fault]
                        require(delta in (0, 1), "invalid fault budget transition")
                        if delta:
                            faults_seen.add(fault)
                if row["cfg"] in runner.ALL_CONTROLS:
                    controls_seen.add(row["cfg"])
                    if metadata["controlClass"] == "choice" and not row["properties"]:
                        require(bug_edges, f"no finite choice divergence in {row['cfg']}")
                fixture = {**envelope, "jobId": completed["id"], "behaviorMetadata": {**metadata, "bugSteps": bug_edges}}
                fixtures[f"{row['cfg']}-{number:03d}.json"] = {
                    "schema": 3, "fixtureContainer": storage.compact_envelopes([fixture])}
    require(actions_seen == engine_actions, f"uncovered executed engine actions: {sorted(engine_actions-actions_seen)}")
    require(faults_seen == faults, f"uncovered bounded faults: {sorted(faults-faults_seen)}")
    require(flapping_seen == flapping, f"uncovered flapping actions: {sorted(flapping-flapping_seen)}")
    require(controls_seen == set(runner.ALL_CONTROLS), "missing control counterexamples")
    require(set(mutation_evidence) == set(runner.RESTART_MUTATIONS), "missing restart sensitivity evidence")
    require(all(entry["stateReduction"] == runner.RESTART_REDUCTION
                and runner.result_matches(next(row for row in rows if row["cfg"] == cfg), entry["result"])
                for cfg, entry in mutation_evidence.items()), "restart sensitivity gate incomplete")
    require(set(restart_evidence) == set(runner.RESTART_CASES) | {runner.RESTART_SIMULATION},
            "missing restart-order row evidence")
    require(all((restart_evidence[cfg]["stateReduction"] == runner.RESTART_REDUCTION
                 or not restart_evidence[cfg]["exhaustive"])
                and runner.result_matches(next(row for row in rows if row["cfg"] == cfg), restart_evidence[cfg]["result"])
                for cfg in runner.RESTART_CASES), "restart checks/simulations incomplete")
    require(not restart_evidence[runner.RESTART_SIMULATION]["exhaustive"]
            and restart_evidence[runner.RESTART_SIMULATION]["stateReduction"] is None
            and restart_evidence[runner.RESTART_SIMULATION]["result"] == "SIMULATION-OK",
            "large restart simulation must not be credited as exhaustive")
    core_coverage = runner.checked_core_coverage(root, rows, run["completed"], run["inputs"], directory=directory)
    require(set(accepted_work) == worker.WORK_WITNESS_ROWS, "missing canonical core/probe accepted-work witnesses")
    coverage = {"schema": 2, "snapshot": run["snapshot"], "jobIds": run["ids"],
                "acceptedWork": accepted_work,
                "coreCoverage": core_coverage, "rowModes": row_modes,
                "engineActions": sorted(actions_seen), "boundedFaults": sorted(faults_seen),
                "flappingActions": sorted(flapping_seen), "controls": sorted(controls_seen),
                "restartOrder": restart_evidence, "restartMutations": mutation_evidence,
                "fixtures": {name: hashlib.sha256(encoded(value)).hexdigest() for name, value in sorted(fixtures.items())}}
    return coverage, fixtures


def certify_traces(root, run):
    with storage.session(root / "ci/.runs"):
        return _certify_traces(root, run)


def rehydrate_fixture(fixture):
    """E3: decode schema 3 JSON; schema 2 fixtures remain directly replayable."""
    require(isinstance(fixture, dict), "fixture is not a JSON object")
    if fixture.get("schema") == 2:
        require("fixtureContainer" not in fixture, "compact fixture mislabeled as legacy")
        return fixture
    require(fixture.get("schema") == 3, "unsupported fixture schema")
    require(set(fixture) == {"schema", "fixtureContainer"}, "malformed compact fixture")
    envelopes = storage.retained_envelopes({"validatedEnvelopeContainer": fixture["fixtureContainer"]})
    require(len(envelopes) == 1 and isinstance(envelopes[0], dict) and envelopes[0].get("schema") == 2,
            "invalid compact fixture payload")
    return envelopes[0]


def _certify_traces(root, run):
    coverage, fixtures = collect_evidence(root, run)
    destination = root.parents[1] / "tests/fixtures/delivery-traces"
    destination.mkdir(parents=True, exist_ok=True)
    expected = set(fixtures) | {"coverage.json"}
    require(not {path.name for path in destination.iterdir()} - expected, "unexpected preexisting fixture files")
    # Account the entire export before writing any fixture, including atomic
    # replacements. Export never expands the accepted-work/raw trace payloads.
    storage.check(root / "ci/.runs", sum(len(encoded(value)) + 4096
                  for value in [*fixtures.values(), coverage]))
    runner = load_module(root / "ci/runner.py", "delivery_fixture_writer")
    for name, fixture in {**fixtures, "coverage.json": coverage}.items():
        path = destination / name
        require(not path.is_symlink(), "linked fixture output")
        runner.atomic_json(path, fixture)
    return coverage


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run-dir", required=True, type=Path)
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[1]
    run = json.loads((args.run_dir / "state.json").read_text())
    require(args.run_dir.resolve() == root / "ci/.runs" / run["run"], "run directory mismatch")
    coverage = certify_traces(root, run)
    print(f"TRACE-COVERAGE PASS ({len(coverage['fixtures'])} fixtures, snapshot {run['snapshot']})")


if __name__ == "__main__":
    try:
        main()
    except (ValueError, OSError, KeyError, TypeError, IndexError) as error:
        print(f"TRACE-COVERAGE FAIL ({error})", file=sys.stderr)
        raise SystemExit(1)
