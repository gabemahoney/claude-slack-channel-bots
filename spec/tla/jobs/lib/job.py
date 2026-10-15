"""Remote TLC worker, adapted from agent-director's pinned tlcjob.sh.

Only main() starts Java. Pure classification/normalization functions are importable
for the Test Writer; importing this module runs no checker or external commands.
"""
from __future__ import annotations

import base64
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import signal
import stat
import shutil
import subprocess
import sys
import time

MAX_BUDGET = 14100
DISKCAP_BYTES = 60000 * 1024 * 1024
LOGCAP_BYTES = 256 * 1024 * 1024
WORK_WITNESS_ROWS = {"probe_premise", "core_head_taken_in"}
WORK_WITNESS_ARTIFACTS = ("raw-trace.json", "search-source-trace.json", "evidence.json", "search/PersonaDelivery.tla",
                          "search/FairWorkWitness.tla", "search/witness.cfg", "search/run.log", "search/proof.json",
                          "replay/PersonaDelivery.tla", "replay/TemporalReplay.tla", "replay/witness.cfg",
                          "replay/run.log", "replay/proof.json", "java-launcher")


def digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def classify(log: str, rc: int, mode: str, interrupted: str | None = None) -> str:
    """Errors/incompletion always beat successful-looking text in a partial log."""
    if interrupted:
        return f"INCOMPLETE({interrupted})"
    if rc in (124, 137, -9):
        return "INCOMPLETE(time-or-memory-budget)"
    if "state is not completely specified" in log:
        return "ERROR(incomplete-state)"
    if re.search(r"^Error: Evaluating postcondition .* failed\.", log, re.M):
        return "ERROR(postcondition-evaluation)"
    if re.search(r"^Error: .*?(?:evaluation failed|could not be evaluated)", log, re.M):
        return "ERROR(evaluation)"
    errors = re.findall(r"^Error: (.*)$", log, re.M)
    violations = []
    for error in errors:
        m = re.fullmatch(r"(Invariant|Action property) ([A-Za-z0-9_]+) is violated\.?", error)
        if m:
            violations.append(f"{m[1].replace(' ', '_')}_{m[2]}_is_violated")
            continue
        m = re.fullmatch(r"Temporal property ([A-Za-z0-9_]+) was violated\.?", error)
        if m:
            violations.append(f"Temporal_property_{m[1]}_was_violated")
            continue
        if re.fullmatch(r"Temporal properties were violated\.?", error):
            violations.append("Temporal_properties_were_violated")
            continue
        # TLC introduces a counterexample with an additional Error: line.
        if error not in ("The behavior up to this point is:",
                         "The following behavior constitutes a counter-example:"):
            return "ERROR(unclassified-TLC-error)"
    if re.search(r"Exception|OutOfMemoryError|StackOverflowError", log):
        return "ERROR(exception)"
    if len(violations) == 1 and rc in (0, 11, 12, 13):
        return f"FAIL({violations[0]})"
    if errors or rc != 0:
        return f"ERROR(rc={rc})"
    if mode == "check" and "Model checking completed. No error has been found" in log:
        return "PASS"
    if mode in ("simulate", "parse") and re.search(
            r"^Progress: [0-9,]+ states checked, [0-9,]+ traces generated \(trace length:", log, re.M
    ) and re.search(r"^Finished in .* at \(.*\)$", log, re.M):
        return "SIMULATION-OK" if mode == "simulate" else "PARSE-OK"
    return "NO-VERDICT"


def normalize_line(line: str) -> tuple[str, dict | None]:
    """PrintT prints a TLA string literal; decode its JSON-compatible escapes."""
    if line.startswith('"TRACE '):
        decoded = json.loads(line)
        if not isinstance(decoded, str) or not decoded.startswith("TRACE "):
            raise ValueError("malformed encoded TRACE line")
        line = decoded
    if line.startswith("TRACE "):
        payload = json.loads(line[6:])
        if not isinstance(payload, dict):
            raise ValueError("TRACE must contain an object")
        return line, payload
    return line, None


def missing_scratch(error: OSError) -> None:
    """TLC removes its metadir concurrently; other filesystem failures are real."""
    if not isinstance(error, FileNotFoundError):
        raise error


def tree_size(path: Path) -> int:
    total = 0
    for directory, _, names in os.walk(path, onerror=missing_scratch):
        for name in names:
            try:
                info = (Path(directory) / name).stat()
            except FileNotFoundError:
                continue
            if stat.S_ISREG(info.st_mode):
                total += info.st_size
    return total


def remove_scratch(path: Path) -> None:
    def onerror(function, name, error_info):
        missing_scratch(error_info[1])
    shutil.rmtree(path, onerror=onerror)


def kill_and_wait(child: subprocess.Popen) -> None:
    try:
        os.killpg(child.pid, signal.SIGKILL)
    except ProcessLookupError:
        # Exit between the watchdog's timeout and kill is normal.
        pass
    finally:
        child.wait()


def verify_inputs(work: Path, plan: dict) -> None:
    """Bind the staged bytes to the controller's verified preflight snapshot."""
    pins = json.loads((work / "inputs.json").read_text())
    sources, inputs = plan["source_map"], plan["source_inputs"]
    if any(row["spec"] == "PersonaDelivery" for row in plan["rows"]):
        for name in ("temporal_sensitivity.py", "work_witness.py", "local_storage.py"):
            if sources.get(name) != "ci/" + name:
                raise ValueError("missing frozen helper: " + name)
    encoded = json.dumps(inputs, sort_keys=True, separators=(",", ":")).encode()
    if hashlib.sha256(encoded).hexdigest() != plan["snapshot"]:
        raise ValueError("source snapshot mismatch")
    if set(pins) != set(sources) | {"plan.json"}:
        raise ValueError("staged inventory differs from source map")
    if any(Path(name).name != name or not (work / name).is_file()
           or (work / name).is_symlink() or digest(work / name) != checksum
           for name, checksum in pins.items()):
        raise ValueError("staged input hash mismatch")
    if any(pins[name] != inputs[relative] for name, relative in sources.items()):
        raise ValueError("staged input differs from source preflight")


def result_matches(row: dict, result: str) -> bool:
    """Keep the remote notice aligned with the controller's target matching."""
    if row["mode"] == "parse":
        return result == "PARSE-OK"
    if row["expect"] == "pass":
        return result == ("SIMULATION-OK" if row["mode"] == "simulate" else "PASS")
    if row["cfg"].startswith("restart_control_"):
        return result == f"FAIL(Invariant_{row['props']}_is_violated)"
    named = re.fullmatch(r"FAIL\((?:Invariant|Action_property|Temporal_property)_([A-Za-z0-9_]+)_(?:is|was)_violated\)", result)
    if named:
        return named[1] == row["props"]
    return (result == "FAIL(Temporal_properties_were_violated)"
            and row["properties"] == [row["props"]] and row["checks"] == [row["props"]])


def mode_evidence(row: dict, result: str, log: str) -> dict:
    """Report what TLC actually checked; simulation never verifies PROPERTY."""
    simulation = row["mode"] == "simulate"
    exhaustive = row["mode"] == "check" and result == "PASS"
    status = {}
    for name in row["checks"]:
        if simulation and name in row["properties"]:
            status[name] = "UNVERIFIED"
        elif result.startswith("FAIL(") and name == row["props"]:
            status[name] = "FAIL"
        elif exhaustive:
            status[name] = "PASS"
        elif simulation and result == "SIMULATION-OK":
            status[name] = "SAMPLED"
        else:
            status[name] = "UNVERIFIED"
    summary = re.findall(r"^Progress: ([0-9,]+) states checked, ([0-9,]+) traces generated \(trace length:", log, re.M)
    sampled = None
    if simulation:
        sampled = {"statesChecked": int(summary[-1][0].replace(",", "")) if summary else None,
                   "tracesGenerated": int(summary[-1][1].replace(",", "")) if summary else None,
                   "depthLimit": row["simulation"]["depth"]}
    return {"mode": row["mode"], "simulation": row["simulation"],
            "exhaustive": exhaustive, "propertyStatus": status, "simulationStats": sampled}


def validate_trace(trace: dict, *, counterexample: bool, temporal: bool) -> None:
    """Reject partial replay evidence; never synthesize decisions or loop edges."""
    behavior = trace.get("behavior")
    if not isinstance(behavior, list) or not behavior:
        raise ValueError("missing behavior")
    if any(not isinstance(s, dict) or not {"EngineChoice", "GateChoice"} <= s.keys()
           for s in behavior):
        raise ValueError("missing ALIAS decisions")
    if not counterexample:
        return
    graph = trace.get("counterexample", {})
    nodes, edges = graph.get("state"), graph.get("action")
    if not isinstance(nodes, list) or not isinstance(edges, list):
        raise ValueError("missing counterexample graph")
    if sorted(nodes, key=lambda n: n[0]) != [[i + 1, s] for i, s in enumerate(behavior)]:
        raise ValueError("counterexample/behavior mismatch")
    forward = set()
    closing = []
    for edge in edges:
        if (not isinstance(edge, list) or len(edge) != 3 or edge[0] not in nodes
                or edge[2] not in nodes or not isinstance(edge[1], dict)):
            raise ValueError("invalid graph edge")
        source, target = edge[0][0], edge[2][0]
        if target == source + 1:
            forward.add(source)
        elif source == len(nodes) and 1 <= target <= source:
            closing.append(edge)
        else:
            raise ValueError("invalid behavior order")
    if forward != set(range(1, len(nodes))) or len(edges) != len(forward) + len(closing):
        raise ValueError("incomplete behavior path")
    if len(closing) != (1 if temporal else 0):
        raise ValueError("missing/unexpected lasso edge")


def load_work_witness(path: Path):
    """Load both helpers from the same frozen directory, including flat staging."""
    def load(source, name):
        spec = importlib.util.spec_from_file_location(name, source)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module
    temporal = load(path.with_name("temporal_sensitivity.py"), "accepted_work_temporal")
    previous = sys.modules.get("temporal_sensitivity")
    sys.modules["temporal_sensitivity"] = temporal
    try:
        return load(path, "accepted_work_witness")
    finally:
        if previous is None:
            del sys.modules["temporal_sensitivity"]
        else:
            sys.modules["temporal_sensitivity"] = previous


def attach_accepted_work(helper, source, cfg, jar, java, directory, envelope, started, deadline):
    """Retain an additional existential bundle within the original row clock."""
    helper.budget(deadline)
    payload = helper.generate_and_verify(source, cfg, jar, java, directory, deadline)
    helper.budget(deadline)
    artifacts = {}
    total = 0
    for name in WORK_WITNESS_ARTIFACTS:
        helper.budget(deadline)
        path = Path(java) if name == "java-launcher" else directory / name
        if not path.is_file() or path.is_symlink():
            raise ValueError("missing/linked accepted-work artifact: " + name)
        content = path.read_bytes()
        total += len(content)
        if total > LOGCAP_BYTES:
            raise ValueError("accepted-work artifacts exceed log budget")
        artifacts[name] = {"sha256": hashlib.sha256(content).hexdigest(),
                           "base64": base64.b64encode(content).decode("ascii")}
    helper.budget(deadline)
    envelope["acceptedWork"] = {"schema": 1, "rowStartedMonotonic": started,
                                "rowDeadline": deadline, "payload": payload, "artifacts": artifacts}


def run_row(work: Path, row: dict, snapshot: str, budget: int) -> dict:
    started = time.monotonic()
    deadline = started + budget
    cfg = row["cfg"]
    log_path = work / "logs" / f"{cfg}.log"
    states = work / "states" / cfg
    states.mkdir(parents=True)
    # One simulation worker makes num the exact trace count and the seed stable.
    # The scheduler job still receives its required four CPUs.
    workers = "1" if row["mode"] in ("simulate", "parse") else "4"
    args = ["java", "-XX:+UseParallelGC", "-Xmx16g", "-XX:MaxDirectMemorySize=6g",
            "-cp", "tla2tools.jar", "tlc2.TLC", "-workers", workers, "-noGenerateSpecTE",
            "-metadir", str(states), "-config", f"{cfg}.cfg"]
    if row["mode"] in ("simulate", "parse"):
        sim = row["simulation"]
        args += ["-simulate", f"num={sim['num']}", "-depth", str(sim["depth"]),
                 "-seed", str(sim["seed"])]
    args.append(f"{row['spec']}.tla")
    interrupted = None
    exit_code = None
    with log_path.open("wb") as output:
        if time.monotonic() >= deadline:
            interrupted = "time-budget"
        else:
            child = subprocess.Popen(args, cwd=work, stdout=output, stderr=subprocess.STDOUT,
                                     stdin=subprocess.DEVNULL, start_new_session=True)
            try:
                while True:
                    left = deadline - time.monotonic()
                    if left <= 0:
                        interrupted = "time-budget"
                        kill_and_wait(child)
                        break
                    try:
                        child.wait(timeout=min(1, left))
                        break
                    except subprocess.TimeoutExpired:
                        if time.monotonic() >= deadline:
                            interrupted = "time-budget"
                        elif tree_size(work) > DISKCAP_BYTES:
                            interrupted = "disk-cap"
                        elif log_path.stat().st_size > LOGCAP_BYTES:
                            interrupted = "log-cap"
                        if interrupted:
                            kill_and_wait(child)
                            break
            finally:
                if child.poll() is None:
                    kill_and_wait(child)
            exit_code = child.returncode
    if interrupted is None and time.monotonic() >= deadline:
        interrupted = "time-budget"
    if tree_size(work) > DISKCAP_BYTES:
        interrupted = "disk-cap"
    elif log_path.stat().st_size > LOGCAP_BYTES:
        interrupted = "log-cap"
    log = log_path.read_text(errors="replace")
    traces = []
    malformed = False
    accepted_directory = work / "logs" / f"{cfg}-accepted-work-0"
    for line in log.splitlines():
        try:
            normalized, trace = normalize_line(line)
        except (ValueError, json.JSONDecodeError):
            malformed = True
            print("TRACE-ERROR malformed structured behavior", flush=True)
            continue
        if trace is None:
            print(normalized, flush=True)
        else:
            try:
                validate_trace(trace, counterexample=row["expect"] == "violation",
                               temporal=bool(row["properties"]))
            except (ValueError, TypeError, KeyError, IndexError) as error:
                malformed = True
                print(f"TRACE-ERROR {error}", flush=True)
            envelope = {
                "schema": 2 if row["spec"] == "PersonaDelivery" else 1, "cfg": cfg, "spec": row["spec"],
                "property": row["props"], "what": row["what"],
                "snapshot": snapshot, "mode": row["mode"],
                "simulation": row.get("simulation"),
                "hashes": {"spec": digest(work / f"{row['spec']}.tla"),
                           "cfg": digest(work / f"{cfg}.cfg")},
                "raw": trace,
            }
            # Run the causal proof inside this row's existing budget. The
            # helper receives flat staged paths, while exported row metadata
            # continues to name the canonical cfg and model.
            temporal = (row["spec"] == "PersonaDelivery" and row["expect"] == "violation" and bool(row["properties"])
                        and cfg.startswith("control_"))
            if temporal and not malformed and result_matches(row, classify(log, exit_code, row["mode"], interrupted)):
                try:
                    spec = importlib.util.spec_from_file_location("frozen_temporal_sensitivity", work / "temporal_sensitivity.py")
                    helper = importlib.util.module_from_spec(spec)
                    spec.loader.exec_module(helper)
                    helper.attach(work, {**row, "cfg_path": f"{cfg}.cfg", "spec_path": f"{row['spec']}.tla"},
                                  envelope, work / "logs" / f"{cfg}-temporal-{len(traces)}", "java",
                                  deadline=deadline)
                    if time.monotonic() >= deadline:
                        raise helper.SensitivityIncomplete("temporal validation exhausted the row budget")
                except (ValueError, OSError, KeyError, TypeError, IndexError) as error:
                    if isinstance(error, getattr(helper, "SensitivityIncomplete", ())):
                        interrupted = "temporal-sensitivity-budget"
                        print(f"TRACE-INCOMPLETE temporal sensitivity: {error}", flush=True)
                    else:
                        malformed = True
                        print(f"TRACE-ERROR temporal sensitivity: {error}", flush=True)
            if (row["spec"] == "PersonaDelivery" and cfg == "probe_premise" and not malformed
                    and result_matches(row, classify(log, exit_code, row["mode"], interrupted))):
                witness = None
                try:
                    witness = load_work_witness(work / "work_witness.py")
                    java = shutil.which("java")
                    if java is None:
                        raise ValueError("missing accepted-work Java executable")
                    attach_accepted_work(witness, work / "PersonaDelivery.tla", work / f"{cfg}.cfg",
                                         work / "tla2tools.jar", Path(java).resolve(), accepted_directory,
                                         envelope, started, deadline)
                    witness.budget(deadline)
                except (ValueError, OSError, KeyError, TypeError, IndexError) as error:
                    if witness is not None and isinstance(error, witness.WitnessIncomplete):
                        interrupted = "accepted-work-budget"
                        print(f"TRACE-INCOMPLETE accepted work: {error}", flush=True)
                    else:
                        malformed = True
                        print(f"TRACE-ERROR accepted work: {error}", flush=True)
            traces.append(envelope)
            print("TRACE " + json.dumps(envelope, sort_keys=True, separators=(",", ":")), flush=True)
    if interrupted is None and time.monotonic() >= deadline:
        interrupted = "time-budget"
    result = classify(log, exit_code, row["mode"], interrupted)
    if malformed:
        result = "ERROR(malformed-trace)"
    # Simulation completion is evidence of finite behaviors, never exhaustive PASS.
    if row["mode"] == "simulate" and result == "SIMULATION-OK":
        stats = mode_evidence(row, result, log)["simulationStats"]
        if (len(traces) != row["simulation"]["num"]
                or stats["tracesGenerated"] != row["simulation"]["num"]
                or not stats["statesChecked"]
                or any(len(trace["raw"]["behavior"]) > row["simulation"]["depth"] + 1 for trace in traces)):
            result = "ERROR(incomplete-simulation-traces)"
    if result.startswith("FAIL(") and not traces:
        result = "ERROR(missing-counterexample-trace)"
    counts = re.findall(r"([0-9,]+) distinct states found", log)
    depth = re.findall(r"depth of the complete state graph search is ([0-9]+)", log)
    final_counts = re.findall(r"([0-9,]+) states generated, ([0-9,]+) distinct states found, ([0-9,]+) states left on queue", log)
    if result == "PASS" and (not counts or not depth or not final_counts
                             or int(final_counts[-1][2].replace(",", "")) != 0):
        result = "ERROR(incomplete-state-graph)"
    if cfg == "core_head_taken_in" and result == "PASS":
        witness = None
        try:
            if traces:
                raise ValueError("unexpected primary core trace")
            witness = load_work_witness(work / "work_witness.py")
            java = shutil.which("java")
            if java is None:
                raise ValueError("missing accepted-work Java executable")
            envelope = {"schema": 2, "cfg": cfg, "spec": row["spec"], "property": row["props"],
                        "what": row["what"], "snapshot": snapshot, "mode": row["mode"],
                        "simulation": row["simulation"],
                        "hashes": {"spec": digest(work / f"{row['spec']}.tla"),
                                   "cfg": digest(work / f"{cfg}.cfg")}}
            attach_accepted_work(witness, work / f"{row['spec']}.tla", work / f"{cfg}.cfg",
                                 work / "tla2tools.jar", Path(java).resolve(), accepted_directory,
                                 envelope, started, deadline)
            envelope["raw"] = envelope["acceptedWork"]["payload"]["raw"]
            witness.budget(deadline)
            traces.append(envelope)
            print("TRACE " + json.dumps(envelope, sort_keys=True, separators=(",", ":")), flush=True)
        except (ValueError, OSError, KeyError, TypeError, IndexError) as error:
            if witness is not None and isinstance(error, witness.WitnessIncomplete):
                result = "INCOMPLETE(accepted-work-budget)"
                print(f"TRACE-INCOMPLETE accepted work: {error}", flush=True)
            else:
                result = "ERROR(accepted-work-witness)"
                print(f"TRACE-ERROR accepted work: {error}", flush=True)
    if (cfg in WORK_WITNESS_ROWS and result_matches(row, result)
            and (len(traces) != 1 or "acceptedWork" not in traces[0])):
        result = "ERROR(missing-accepted-work-witness)"
    evidence = {"cfg": cfg, "result": result, "checks": row["checks"],
            "distinct": int(counts[-1].replace(",", "")) if counts and row["mode"] == "check" else None,
            "depth": int(depth[-1]) if depth and row["mode"] == "check" else None,
            "secs": round(time.monotonic() - started, 3),
            "trace_count": len(traces), "exit_code": exit_code}
    # The complete behavior/graph is now in the retained log and emitted TRACE.
    # TLC's scratch metadir is not evidence and must not accumulate across rows.
    try:
        remove_scratch(states)
        if cfg in WORK_WITNESS_ROWS:
            for kind in ("search", "replay"):
                remove_scratch(accepted_directory / kind / "states")
    except OSError as error:
        # Keep the authentic log/traces/counts and fail this row visibly.
        evidence["checker_result"] = evidence["result"]
        evidence["result"] = "ERROR(scratch-cleanup)"
        evidence["cleanup_error"] = f"{type(error).__name__}: {error}"
    finished = time.monotonic()
    if finished >= deadline and result_matches(row, evidence["result"]):
        evidence["result"] = "INCOMPLETE(time-budget)"
    evidence["secs"] = round(finished - started, 3)
    if cfg in WORK_WITNESS_ROWS:
        evidence.update(row_started_monotonic=started, row_deadline=deadline, row_finished_monotonic=finished)
    evidence.update(mode_evidence(row, evidence["result"], log))
    return evidence


def main() -> int:
    final = {"schema": 1, "result": "ERROR(worker-not-completed)", "rows": []}
    try:
        if os.environ.get("TLA_REMOTE_JOB") != "1" or Path.cwd() != Path("/work"):
            raise ValueError("TLC may run only inside the scheduler job")
        work = Path("/work")
        plan = json.loads((work / "plan.json").read_text())
        verify_inputs(work, plan)
        if not 0 < len(plan["rows"]) <= 7:
            raise ValueError("a job must contain one to seven rows")
        if not 0 < plan["budget"] <= MAX_BUDGET:
            raise ValueError("invalid overall budget")
        (work / "logs").mkdir()
        started = time.monotonic()
        results = final["rows"]
        final["snapshot"] = plan["snapshot"]
        for row in plan["rows"]:
            if not 0 < row["cap_s"] <= 1800:
                raise ValueError("invalid row cap")
            left = int(plan["budget"] - (time.monotonic() - started))
            if left < 30:
                result = {"cfg": row["cfg"], "checks": row["checks"],
                          "result": "SKIPPED(no-budget)"}
            else:
                result = run_row(work, row, plan["snapshot"], min(left, row["cap_s"]))
            results.append(result)
            print("ROW " + json.dumps(result, sort_keys=True, separators=(",", ":")), flush=True)
            print(f"VERDICT {result['cfg']} checks={','.join(result['checks'])} "
                  f"result={result['result']} distinct={result.get('distinct')} "
                  f"depth={result.get('depth')} secs={result.get('secs')}", flush=True)
        failed = [row["cfg"] for row, result in zip(plan["rows"], results)
                  if not result_matches(row, result["result"])]
        final = {"schema": 1, "result": "FAIL" if failed else "PASS", "complete": True,
                 "failed": failed, "snapshot": plan["snapshot"], "rows": results}
    except BaseException as error:
        print(f"WORKER-ERROR {type(error).__name__}: {error}", flush=True)
        final["result"] = "ERROR(worker)"
    # This is unconditionally the final output line, even after an exception.
    print("JOB-VERDICT " + json.dumps(final, sort_keys=True, separators=(",", ":")), flush=True)
    return 0 if final["result"] == "PASS" else 1


if __name__ == "__main__":
    raise SystemExit(main())
