"""Owner-authorized bounded LOCAL feasibility screens, never certification.

Each canonical row uses its actual check/simulation mode and unmodified cfg.
All evidence is ignored under .runs; no scheduler command exists in this tool.
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
import resource
import signal
import subprocess
import time

_STORAGE_SPEC = importlib.util.spec_from_file_location("screen_storage", Path(__file__).with_name("local_storage.py"))
storage = importlib.util.module_from_spec(_STORAGE_SPEC)
_STORAGE_SPEC.loader.exec_module(storage)


def module(path, name):
    spec = importlib.util.spec_from_file_location(name, path)
    result = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def write(path, value):
    content = (json.dumps(value, indent=2, sort_keys=True) + "\n").encode()
    if len(content) > storage.FILE_LIMIT:
        raise storage.StorageRefusal("local summary file limit exceeded")
    # Reserve the stop margin for durable compact summaries after child reaping.
    storage.check(path, len(content) + 4096, headroom=0)
    temporary = path.with_suffix(".tmp")
    try:
        with temporary.open("wb") as output:
            output.write(content)
            output.flush()
            os.fsync(output.fileno())
        temporary.replace(path)
    finally:
        temporary.unlink(missing_ok=True)
    fd = os.open(path.parent, os.O_RDONLY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def invalidate(entry, error, reason="local-screen"):
    if "checkerResult" not in entry:
        entry["checkerResult"] = entry.get("result")
    entry.update(result=f"ERROR({reason})", finishedExpected=False,
                 error=f"{type(error).__name__}: {error}"[:1000])
    entry["exhaustive"] = False
    if "propertyStatus" in entry:
        entry["propertyStatus"] = {name: "UNVERIFIED" for name in entry["propertyStatus"]}


def persist_report(output, report):
    """Never retry an oversized report; preserve the last durable evidence by rename."""
    report["submissionAllowed"] = False
    report["unresolved"] = [r["cfg"] for r in report["rows"] if not r["finishedExpected"]]
    try:
        write(output / "report.json", report)
    except (storage.StorageRefusal, OSError) as error:
        previous = output / "report.json"
        retained = None
        if previous.exists():
            retained = {"path": "report-previous.json", "sha256": digest(previous)}
            previous.replace(output / "report-previous.json")
        failure = {"schema": 1, "kind": "exploratory-local-screen", "certification": False,
                   "submissionAllowed": False, "evidenceUnavailable": True,
                   "error": f"{type(error).__name__}: {error}"[:1000], "previousReport": retained,
                   "rows": [{key: entry[key] for key in ("cfg", "result", "finishedExpected", "checkerResult",
                             "seconds", "exitCode", "reaped", "initialDistinct", "finalCounts", "lastProgress",
                             "resourceFailure", "primaryChecker", "exhaustive", "propertyStatus",
                             "row_started_monotonic", "row_deadline", "row_finished_monotonic")
                             if key in entry} for entry in report["rows"]],
                   "unresolved": [entry["cfg"] for entry in report["rows"]]}
        for entry in failure["rows"]:
            invalidate(entry, error, "report-storage")
        write(output / "report.json", failure)
        raise


def cleanup_report(output, report, paths):
    """Cleanup is part of completion; ENOENT is the only benign removal failure."""
    failure = None
    for path in paths:
        try:
            storage.remove(path)
        except BaseException as error:
            failure = failure or error
    if failure is not None:
        if report["rows"]:
            invalidate(report["rows"][-1], failure, "scratch-cleanup")
        report["cleanupError"] = f"{type(failure).__name__}: {failure}"[:1000]
        persist_report(output, report)
        raise failure
    if report["rows"]:
        entry = report["rows"][-1]
        deadline = entry.get("row_deadline")
        if deadline is not None and entry.get("finishedExpected") and time.monotonic() >= deadline:
            entry.setdefault("checkerResult", entry["result"])
            entry.update(result="INCOMPLETE(local-wall-cap)", finishedExpected=False)
            persist_report(output, report)


def freeze_sources(root, frozen):
    # Bootstrap without importing live helpers. Match runner.input_paths and
    # check the inventory again with the frozen runner before executing rows.
    fixed = ("ci/run_ci.sh", "ci/runner.py", "jobs/lib/Dockerfile",
             "jobs/lib/tlcjob.sh", "jobs/lib/job.py", "ci/temporal_sensitivity.py",
             "ci/work_witness.py", "ci/local_storage.py", "tla2tools.jar")
    paths = {root / relative for relative in fixed}
    for pattern in ("*.tla", "ci/*.py", "ci/*.sh", "ci/*.tsv", "ci/*.json",
                    "ci/cfg/*.cfg", "ci/proof/*.tla", "ci/proof/*.tsv", "ci/proof/cfg/*.cfg",
                    "ci/fairness-probe/*.py", "ci/fairness-probe/*.tla", "ci/fairness-probe/cfg/*.cfg"):
        paths.update(root.glob(pattern))
    storage.check(frozen, sum(path.stat().st_size + 4096 for path in paths))
    inputs = {}
    for path in sorted(paths):
        relative = str(path.relative_to(root))
        content = path.read_bytes()
        inputs[relative] = hashlib.sha256(content).hexdigest()
        target = frozen / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        storage.check(target, len(content) + 4096)
        target.write_bytes(content)
        if digest(target) != inputs[relative]:
            raise RuntimeError(f"frozen source changed: {relative}")
    return inputs


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--java", type=Path, required=True)
    parser.add_argument("--seconds", type=float, default=6)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--cfg", action="append", help="optional selected rows; partial reports cannot open the gate")
    args = parser.parse_args()
    if not 1 <= args.seconds <= 120:
        parser.error("local screens require a one-to-120 second hard wall cap")
    root = Path(__file__).resolve().parents[1]
    output = args.output.resolve()
    home = root / "ci/.runs"
    if output == home or home not in output.parents:
        parser.error("local screens must write below ci/.runs")
    with storage.session(home):
        output.mkdir(parents=True, exist_ok=False)
        frozen = output / "source"
        report = {"rows": []}
        try:
            inputs = freeze_sources(root, frozen)
            # Execute the exact recorded screener bytes.
            profiler = module(frozen / "ci/screen_cfgs.py", "frozen_screen")
            report = profiler.run_screen(args, frozen, output, inputs)
        finally:
            # On an exception run_screen already saved its invalidated result.
            if (output / "report.json").exists():
                report = json.loads((output / "report.json").read_text())
            cleanup_report(output, report, [frozen, *[child for child in output.iterdir()
                                                    if child.is_dir() and child != frozen]])



def run_screen(args, root, output, inputs):
    if not 1 <= args.seconds <= 120:
        raise ValueError("local screens require a one-to-120 second hard wall cap")
    runner = module(root / "ci/runner.py", "screen_runner")
    worker = module(root / "jobs/lib/job.py", "screen_worker")
    contract = module(root / "ci/trace_contract.py", "screen_contract")
    sensitivity = module(root / "ci/temporal_sensitivity.py", "screen_sensitivity")
    witness = worker.load_work_witness(root / "ci/work_witness.py")
    frozen_inputs = {str(path.relative_to(root)): digest(path) for path in runner.input_paths(root)}
    if frozen_inputs != inputs:
        raise RuntimeError("frozen input inventory/hashes differ from frozen runner")
    rows = runner.load_manifest(root, False)
    if args.cfg:
        unknown = set(args.cfg) - {row["cfg"] for row in rows}
        if unknown:
            raise SystemExit(f"unknown cfgs: {unknown}")
        rows = [row for row in rows if row["cfg"] in args.cfg]
    snapshot = runner.snapshot_id(inputs)
    report = {"schema": 1, "kind": "exploratory-local-screen", "certification": False,
              "sourceInputs": inputs, "sourceDirectory": str(root), "snapshot": snapshot, "partial": bool(args.cfg),
              "limits": {"wallSeconds": args.seconds, "workers": 1, "heapMiB": 384,
                         "directMemoryMiB": 128, "cpuSeconds": math.ceil(args.seconds),
                         "runsBytes": storage.LIMIT, "headroomBytes": storage.HEADROOM,
                         "fileBytes": storage.FILE_LIMIT, "logBytes": storage.LOG_LIMIT},
              "storagePolicy": "ephemeral-rows-and-source; compact-validated-report",
              "java": str(args.java.resolve()), "javaSha256": digest(args.java), "rows": []}
    java = str(args.java.resolve())
    sany_args = [java, "-Xmx256m", "-cp", "tla2tools.jar", "tla2sany.SANY", "-error-codes", "PersonaDelivery.tla"]
    import sys
    guard = sys.modules[storage.ACTIVE_KEY]
    sany = guard.run(sany_args, cwd=root, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=15)
    guard.check(len(sany.stdout) + len(sany.stderr) + 8192)
    (output / "sany.stdout").write_bytes(sany.stdout)
    (output / "sany.stderr").write_bytes(sany.stderr)
    report["sany"] = {"argv": sany_args, "rc": sany.returncode, "stdoutSha256": digest(output / "sany.stdout"),
                      "stderrSha256": digest(output / "sany.stderr")}
    if sany.returncode or b"Semantic processing of module PersonaDelivery" not in sany.stdout:
        write(output / "report.json", report)
        raise SystemExit("SANY failed; no local TLC started")
    for row in rows:
        started = time.monotonic()
        deadline = started + args.seconds
        # Frozen nested helpers share the absolute row clock through the guard.
        guard.deadline = deadline
        cfg = row["cfg"]
        directory = output / cfg
        entry = None
        child = None
        exit_code = None
        peak_rss = 0
        argv = None
        checker_result = checker_seconds = None
        failure_source = "primary-checker"
        try:
            guard.check(storage.LOG_LIMIT)
            directory.mkdir()
            metadir = directory / "states"
            argv = [java, "-XX:ActiveProcessorCount=1", "-XX:+UseParallelGC", "-Xmx384m", "-XX:MaxDirectMemorySize=128m",
                    "-Dtlc2.TLC.progressInterval=1", "-cp", "tla2tools.jar", "tlc2.TLC", "-workers", "1",
                    "-noGenerateSpecTE", "-seed", "1", "-metadir", str(metadir), "-config", row["cfg_path"], "-fp", "0"]
            if row["simulation"]:
                sim = row["simulation"]
                argv += ["-simulate", f"num={sim['num']}", "-depth", str(sim["depth"]), "-seed", str(sim["seed"])]
            if row["simulation"]:
                # Only the manifest's simulation seed may apply.
                del argv[argv.index("-seed"):argv.index("-seed") + 2]
            argv.append("PersonaDelivery.tla")
            def cpu_limit():
                cap = math.ceil(args.seconds)
                resource.setrlimit(resource.RLIMIT_CPU, (cap, cap))
                storage.child_limits()
            peak_rss = 0
            interrupted = None
            exit_code = None
            with (directory / "run.log").open("wb") as log:
                if time.monotonic() >= deadline:
                    interrupted = "local-wall-cap"
                else:
                    child = subprocess.Popen(argv, cwd=root, stdout=log, stderr=subprocess.STDOUT,
                                             stdin=subprocess.DEVNULL, start_new_session=True, preexec_fn=cpu_limit)
                    try:
                        while child.poll() is None:
                            guard.check()
                            if log.tell() >= storage.LOG_LIMIT:
                                raise storage.StorageRefusal("local checker log limit exceeded", limit_type="capture",
                                                             limit_bytes=storage.LOG_LIMIT, observed_bytes=log.tell())
                            try:
                                status = Path(f"/proc/{child.pid}/status").read_text()
                                match = re.search(r"VmRSS:\s+(\d+)", status)
                                peak_rss = max(peak_rss, int(match[1]) if match else 0)
                            except FileNotFoundError:
                                pass
                            left = deadline - time.monotonic()
                            if left <= 0:
                                interrupted = "local-wall-cap"
                                worker.kill_and_wait(child)
                                break
                            time.sleep(min(0.05, left))
                    finally:
                        worker.kill_and_wait(child)
                    guard.check()
                    if log.tell() >= storage.LOG_LIMIT:
                        raise storage.StorageRefusal("local checker log limit exceeded", limit_type="capture",
                                                     limit_bytes=storage.LOG_LIMIT, observed_bytes=log.tell())
                    exit_code = child.returncode
            checker_seconds = round(time.monotonic() - started, 3)
            if interrupted is None and time.monotonic() >= deadline:
                interrupted = "local-wall-cap"
            elapsed = round(time.monotonic() - started, 3)
            log = (directory / "run.log").read_text(errors="replace")
            storage.remove(metadir)
            result = worker.classify(log, exit_code, row["mode"], interrupted)
            checker_result = result
            failure_source = "trace-processing"
            samples = [{"depth": int(m[1]), "time": m[2], "generated": int(m[3].replace(",", "")),
                        "distinct": int(m[4].replace(",", "")), "queue": int(m[5].replace(",", ""))}
                       for m in re.finditer(r"Progress\((\d+)\) at ([^:]+ \d+:\d+:\d+): ([\d,]+) states generated.*?([\d,]+) distinct states found.*?([\d,]+) states left on queue", log)]
            final_counts = re.findall(r"([\d,]+) states generated, ([\d,]+) distinct states found, ([\d,]+) states left on queue", log)
            init = re.search(r"Finished computing initial states: ([\d,]+) distinct state", log)
            records = []
            trace_errors = []
            summaries = []
            # A successful core check has no counterexample. Its additional fair
            # work lasso is generated separately, after authentic graph completion.
            core_witness = (cfg == "core_head_taken_in" and interrupted is None
                            and worker.result_matches(row, result) and init is not None
                            and int(init[1].replace(",", "")) > 0 and final_counts
                            and int(final_counts[-1][2].replace(",", "")) == 0)
            for line in log.splitlines() + ([None] if core_witness else []):
                try:
                    if line is None:
                        raw = None
                    else:
                        _, raw = worker.normalize_line(line)
                    if raw is None and line is not None:
                        continue
                    envelope = {"schema": 2, "cfg": cfg, "spec": row["spec"], "property": row["props"],
                                "what": row["what"], "snapshot": snapshot, "mode": row["mode"],
                                "simulation": row["simulation"],
                                "hashes": {"spec": inputs[row["spec_path"]], "cfg": inputs[row["cfg_path"]]}, "raw": raw}
                    if row["expect"] == "violation" and row["properties"] and cfg in runner.ALL_CONTROLS:
                        failure_source = "temporal-sensitivity"
                        sensitivity.attach(root, row, envelope, directory / f"temporal-{len(records) + len(trace_errors)}",
                                           java, deadline=deadline)
                    if cfg in worker.WORK_WITNESS_ROWS:
                        if (not worker.result_matches(row, result) or interrupted is not None or records
                                or (cfg == "core_head_taken_in" and line is not None)):
                            raise ValueError("accepted-work witness requires its completed original row")
                        if cfg == "probe_premise":
                            worker.validate_trace(raw, counterexample=True, temporal=True)
                        failure_source = "accepted-work"
                        worker.attach_accepted_work(witness, root / row["spec_path"], root / row["cfg_path"],
                                                    root / "tla2tools.jar", Path(java), directory / "accepted-work",
                                                    envelope, started, deadline)
                        if cfg == "core_head_taken_in":
                            envelope["raw"] = envelope["acceptedWork"]["payload"]["raw"]
                    failure_source = "trace-validation"
                    behavior, metadata = contract.validate_envelope(root, {"snapshot": snapshot, "inputs": inputs},
                                                                     row, envelope, worker, deadline=deadline,
                                                                     result={"row_started_monotonic": started,
                                                                             "row_deadline": deadline,
                                                                             "row_finished_monotonic": time.monotonic()})
                    if runner.reduced_cfg(row):
                        contract.validate_restart_mutation_behavior(row, behavior)
                    bugs = contract.executed_bug_steps(row, behavior, companion=cfg in runner.RESTART_MUTATIONS)
                    if (cfg in runner.ALL_CONTROLS and metadata["controlClass"] == "choice"
                            and not row["properties"] and not bugs):
                        raise ValueError("no executed mutant divergence")
                    if row["properties"] and cfg in runner.ALL_CONTROLS:
                        sensitivity.remaining(deadline, args.seconds)
                    replay_raw = envelope[metadata["replayField"]]
                    summaries.append({"states": len(behavior), "edges": len(replay_raw.get("counterexample", {}).get("action", [])),
                                      "bugEdges": bugs, **metadata})
                    records.append(envelope)
                except (ValueError, KeyError, TypeError, IndexError) as error:
                    # Frozen helpers use the active guard's separately loaded
                    # StorageRefusal class; its telemetry survives that boundary.
                    if isinstance(error, storage.StorageRefusal) or hasattr(error, "telemetry"):
                        raise
                    if isinstance(error, getattr(sensitivity, "SensitivityIncomplete", ())):
                        interrupted = "temporal-sensitivity-budget"
                        result = worker.classify(log, exit_code, row["mode"], interrupted)
                    if isinstance(error, witness.WitnessIncomplete):
                        interrupted = "accepted-work-budget"
                        result = worker.classify(log, exit_code, row["mode"], interrupted)
                    trace_errors.append(str(error))
            failure_source = "row-summary"
            elapsed = round(time.monotonic() - started, 3)
            matched = worker.result_matches(row, result)
            trace_required = row["expect"] == "violation" or row["mode"] == "simulate" or cfg in worker.WORK_WITNESS_ROWS
            trace_ok = not trace_errors and (not trace_required or bool(records))
            if row["mode"] == "simulate" and row["expect"] == "pass":
                stats = worker.mode_evidence(row, result, log)["simulationStats"]
                trace_ok = (trace_ok and len(records) == row["simulation"]["num"]
                            and stats["tracesGenerated"] == row["simulation"]["num"]
                            and bool(stats["statesChecked"])
                            and all(len(record["raw"]["behavior"]) <= row["simulation"]["depth"] + 1 for record in records))
            initial_count = int(init[1].replace(",", "")) if init else None
            finished = interrupted is None and matched and trace_ok and (row["mode"] == "simulate" or bool(initial_count))
            entry = {"cfg": cfg, "argv": argv, "mode": row["mode"], "simulation": row["simulation"],
                     "stateReduction": runner.restart_reduction(row),
                     "constants": contract.cfg_constants((root / row["cfg_path"]).read_text()),
                     "cfgSha256": inputs[row["cfg_path"]], "specSha256": inputs[row["spec_path"]],
                     "result": result, "exitCode": exit_code, "seconds": elapsed, "peakRssKiB": peak_rss,
                     "reaped": child is not None and child.returncode is not None,
                     "runLogBytes": (directory / "run.log").stat().st_size,
                     "runsPeakBytes": guard.peak_bytes,
                     "initialDistinct": initial_count, "samples": samples,
                     "finalCounts": list(map(lambda x:int(x.replace(",", "")), final_counts[-1])) if final_counts and row["mode"] == "check" else None,
                     "growth": {"distinctDelta": samples[-1]["distinct"] - samples[0]["distinct"],
                                "queueDelta": samples[-1]["queue"] - samples[0]["queue"]} if len(samples) > 1 else None,
                     "finishedExpected": finished, "traceErrors": trace_errors, "traceSummaries": summaries,
                     "runLogSha256": digest(directory / "run.log")}
            if cfg in worker.WORK_WITNESS_ROWS:
                entry["validatedEnvelopeContainer"] = storage.compact_envelopes(records)
            cleanup_error = None
            try:
                worker.remove_scratch(metadir)
                if cfg in worker.WORK_WITNESS_ROWS:
                    for kind in ("search", "replay"):
                        worker.remove_scratch(directory / "accepted-work" / kind / "states")
                storage.remove(directory)
            except Exception as error:
                cleanup_error = error
                entry["checkerResult"] = entry["result"]
                entry["result"] = "ERROR(scratch-cleanup)"
                entry["cleanupError"] = f"{type(error).__name__}: {error}"
                entry["finishedExpected"] = False
            if time.monotonic() >= deadline:
                entry["finishedExpected"] = False
                if worker.result_matches(row, entry["result"]):
                    entry["result"] = "INCOMPLETE(local-wall-cap)"
            entry["seconds"] = round(time.monotonic() - started, 3)
            entry.update(row_started_monotonic=started, row_deadline=deadline,
                         row_finished_monotonic=time.monotonic())
            entry.update(worker.mode_evidence(row, entry["result"], log))
            report["rows"].append(entry)
            persist_report(output, report)
            if time.monotonic() >= deadline and entry["finishedExpected"]:
                entry["finishedExpected"] = False
                entry["result"] = "INCOMPLETE(local-wall-cap)"
                entry["seconds"] = round(time.monotonic() - started, 3)
                entry.update(worker.mode_evidence(row, entry["result"], log))
                report["unresolved"] = [r["cfg"] for r in report["rows"] if not r["finishedExpected"]]
                persist_report(output, report)
            if cleanup_error is not None:
                raise cleanup_error
            print(json.dumps({key: entry[key] for key in ("cfg", "result", "initialDistinct", "growth", "finishedExpected", "seconds")}), flush=True)
        except BaseException as error:
            if entry is None:
                telemetry = {"logBytes": None, "initialDistinct": None, "finalCounts": None, "lastProgress": None}
                if (directory / "run.log").exists():
                    with (directory / "run.log").open("rb") as stream:
                        telemetry.update(storage.log_telemetry(stream))
                entry = {"cfg": cfg, "argv": argv, "result": checker_result,
                         "mode": row["mode"], "simulation": row["simulation"],
                         **telemetry, "exitCode": child.returncode if child is not None else None,
                         "reaped": child.returncode is not None if child is not None else None,
                         "peakRssKiB": peak_rss,
                         "row_started_monotonic": started, "row_deadline": deadline}
            entry.update(seconds=round(time.monotonic() - started, 3),
                         row_finished_monotonic=time.monotonic(), runsPeakBytes=guard.peak_bytes)
            if isinstance(error, storage.StorageRefusal) or hasattr(error, "telemetry"):
                entry["primaryChecker"] = {key: entry.get(key) for key in (
                    "argv", "exitCode", "reaped", "initialDistinct", "finalCounts", "lastProgress", "logBytes")}
                entry["primaryChecker"].update(result=checker_result,
                    seconds=checker_seconds if checker_seconds is not None else (
                        entry["seconds"] if failure_source == "primary-checker" and child is not None else None))
                entry["checkerResult"] = checker_result
                entry["resourceFailure"] = {key: (entry.get(key) if failure_source == "primary-checker" else None)
                                            for key in ("seconds", "exitCode", "reaped", "logBytes",
                                                        "initialDistinct", "finalCounts", "lastProgress")}
                entry["resourceFailure"].update({
                                            "source": failure_source,
                                            "argv": None, "stderrBytes": None,
                                            "limitType": None, "limitBytes": None, "observedBytes": None,
                                            **getattr(error, "telemetry", {})})
            if not report["rows"] or report["rows"][-1]["cfg"] != cfg:
                report["rows"].append(entry if entry is not None else {"cfg": cfg, "mode": row["mode"]})
            invalidate(report["rows"][-1], error)
            report["rows"][-1]["propertyStatus"] = {name: "UNVERIFIED" for name in row["checks"]}
            try:
                storage.remove(directory)
            except Exception as cleanup_error:
                report["rows"][-1]["cleanupError"] = f"{type(cleanup_error).__name__}: {cleanup_error}"[:1000]
            # A failed persistence already produced its compact failure record.
            if not isinstance(error, (storage.StorageRefusal, OSError)) or not (output / "report.json").exists():
                persist_report(output, report)
            else:
                saved = json.loads((output / "report.json").read_text())
                if not saved.get("evidenceUnavailable"):
                    persist_report(output, report)
            raise
        finally:
            guard.deadline = None
    print(f"Exploratory evidence: {output / 'report.json'}; independent review and SRD amendment required; no submission", flush=True)
    return report


if __name__ == "__main__":
    main()
