"""Isolated notice-driven diagnostic submission and ONE collection after notice.

Usage: python3 spec/tla/ci/fairness-probe/probe.py submit
Then, only after the owner forwards the terminal notice:
  python3 .../probe.py collect --run-dir ABS --completed-job EXACT_JOB_ID
No status calls, waiting, polling, automatic retries, or successor jobs exist.
After a local validation failure, --saved-only revalidates the consumed response
and retained artifacts without another scheduler call or scheduler-file read.
Production and diagnostics share the pending-run guard and lock. This tool never
certifies E1.
"""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import shlex
import shutil
import subprocess
import sys
import uuid

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
JAR_HASH = "32d64fbbc464559fc7192341b27b885fa4eb6b92d1648d2b49fb9cdcb7aacf81"
definition = importlib.util.spec_from_file_location("permission_controller", ROOT / "ci/runner.py")
controller = importlib.util.module_from_spec(definition)
definition.loader.exec_module(controller)


def digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def canonical(value) -> bytes:
    return json.dumps(value, sort_keys=True, separators=(",", ":")).encode() + b"\n"


def write_json(path: Path, value) -> None:
    temporary = path.with_suffix(".tmp")
    with temporary.open("wb") as output:
        output.write(canonical(value))
        output.flush()
        os.fsync(output.fileno())
    temporary.replace(path)


def append_job(value) -> None:
    # Only append; the production runner and another engineer share this file.
    with (ROOT / "ci/jobs.jsonl").open("ab") as output:
        output.write(canonical(value))
        output.flush()
        os.fsync(output.fileno())


def now() -> str:
    return datetime.now(timezone.utc).isoformat()


def require(condition, message: str) -> None:
    if not condition:
        raise ValueError(message)


def rows() -> list[dict]:
    inventory = [
        ("safety", "-", ["TypeOK", "SafetySanity"], [], 600),
        ("delivery_reachable", "NotDelivered", ["NotDelivered"], [], 600),
        ("premise_reachable", "NotPremise", ["NotPremise"], ["NotPremise"], 600),
        ("eventually_delivered", "EventuallyDelivered", ["EventuallyDelivered"], ["EventuallyDelivered"], 1800),
        ("head_taken_in", "HeadTakenIn", ["HeadTakenIn"], ["HeadTakenIn"], 1800),
    ]
    return [dict(cfg=cfg, props=prop, checks=checks, properties=properties,
                 cap_s=cap, spec="PermissionFairness", mode="check", simulation=None,
                 expect="pass" if cfg == "safety" else "violation",
                 what="DIAGNOSTIC ONLY: " + cfg + "; cannot certify E1")
            for cfg, prop, checks, properties, cap in inventory]


def submit_locked(home: Path, executable: str) -> None:
    controller.guard_active(home)
    inputs = controller.verify_pins(ROOT)
    require(digest(ROOT / "tla2tools.jar") == JAR_HASH, "pinned jar hash mismatch")
    require((ROOT / "tla2tools.jar").stat().st_size == 4493033, "pinned jar size mismatch")
    run = "permission-fairness-" + uuid.uuid4().hex
    directory = ROOT / "ci/.runs" / run
    context = directory / "context"
    context.mkdir(parents=True)
    copies = {
        "Dockerfile": ROOT / "jobs/lib/Dockerfile",
        "tlcjob.sh": ROOT / "jobs/lib/tlcjob.sh",
        "worker.py": ROOT / "jobs/lib/job.py",
        "tla2tools.jar": ROOT / "tla2tools.jar",
        "job.py": HERE / "job.py",
        "PermissionFairness.tla": HERE / "PermissionFairness.tla",
    }
    copies.update({f"{row['cfg']}.cfg": HERE / "cfg" / f"{row['cfg']}.cfg" for row in rows()})
    sources = {name: str(source.relative_to(ROOT)) for name, source in copies.items()}
    for name, relative in sources.items():
        controller.stage_input(ROOT, relative, context / name, inputs)
    for row in rows():
        checks = controller.checks_of((context / f"{row['cfg']}.cfg").read_text())
        require(checks["INVARIANT"] + checks["PROPERTY"] == row["checks"]
                and checks["PROPERTY"] == row["properties"], "diagnostic cfg checks differ from plan")
    snapshot = controller.snapshot_id(inputs)
    hashes = controller.seal_context(context, {"rows": rows(), "budget": 6000}, inputs, sources, snapshot)
    state = dict(diagnostic=True, certifies_E1=False, run=run, context=str(context),
                 snapshot=snapshot, inputs=inputs, scheduler=executable,
                 context_hashes=hashes, phase="submitting", outstanding=None,
                 collect_attempted=False, created_at=now())
    write_json(directory / "state.json", state)
    controller.atomic_json(home / "active.json", {"directory": str(directory)})
    with (directory / "submit.json").open("wb") as output:
        reply = subprocess.run([executable, "submit", "--context", str(context),
                                "--name", "omv-permission-fairness", "--channel", "C0B1ZJJLJ9M",
                                "--network", "off", "--memory", "24g", "--cpus", "4",
                                "--timeout", "4h", "--json"],
                               stdout=output, stderr=subprocess.PIPE, check=False)
        output.flush()
        os.fsync(output.fileno())
    require(reply.returncode == 0, f"submit failed/uncertain; do not resubmit: {reply.stderr[:300]!r}")
    response = json.loads((directory / "submit.json").read_text())
    job_id = response.get("id", "")
    require(re.fullmatch(r"[A-Za-z0-9._-]+", job_id), "missing job ID; do not resubmit")
    # Record immediately, including immutable context hashes, before any further checks.
    append_job(dict(time=now(), run=run, job="permission-fairness-diagnostic", id=job_id,
                    snapshot=snapshot, context=str(context), context_hashes=hashes,
                    diagnostic=True, certifies_E1=False))
    state.update(id=job_id, phase="pending", submitted_at=now(),
                 outstanding={"id": job_id, "collect_attempted": False})
    write_json(directory / "state.json", state)
    print(json.dumps(dict(id=job_id, run_dir=str(directory), context=str(context),
                          snapshot=snapshot, jar_sha256=hashes["tla2tools.jar"]), sort_keys=True))
    print("Await the owner's terminal notice. No polling or results reads before that notice.")
    print("TLA_JOBSCHED=" + shlex.quote(executable) + " " + shlex.join(
        ["python3", str(HERE / "probe.py"), "collect", "--run-dir", str(directory),
         "--completed-job", job_id]))
    require(response.get("dispatcher_running") is True and response.get("cpus") == 4
            and response.get("memory", 0) >= 24 * 1024**3
            and response.get("timeout_s", 0) == 14400,
            "submitted limits/dispatcher mismatch; retain context and await notice")


def validate_trace_inventory(traces: list[dict], results: list[dict], worker) -> None:
    inventory = rows()
    indexed = {row["cfg"]: row for row in inventory}
    require({trace.get("cfg") for trace in traces}
            == {row["cfg"] for row in inventory if row["expect"] == "violation"},
            "missing/unexpected diagnostic trace cfg")
    for trace in traces:
        row = indexed[trace["cfg"]]
        require(trace.get("schema") == 1 and trace.get("spec") == row["spec"]
                and trace.get("property") == row["props"], "diagnostic trace target mismatch")
    require(len(results) == len(inventory), "diagnostic row inventory mismatch")
    for row, result in zip(inventory, results):
        observed = sum(trace["cfg"] == row["cfg"] for trace in traces)
        require(result.get("cfg") == row["cfg"] and result.get("checks") == row["checks"]
                and worker.result_matches(row, result.get("result", ""))
                and result.get("trace_count") == observed, "diagnostic row/trace mismatch")
        if row["cfg"] in {"eventually_delivered", "head_taken_in"}:
            require(observed == 1, "expected exactly one lasso per liveness target")


def collect_locked(directory: Path, completed_job: str, home: Path, executable: str | None,
                   *, saved_only: bool = False) -> None:
    require(controller.read_json(home / "active.json")["directory"] == str(directory), "not the active run")
    state_path = directory / "state.json"
    state = json.loads(state_path.read_text())
    require(state["diagnostic"] is True and state["certifies_E1"] is False, "wrong run kind")
    require(state["id"] == completed_job, "wrong job")
    if saved_only:
        require(state["phase"] in {"failed", "collecting"} and state["collect_attempted"] is True,
                "saved-only requires a consumed collection awaiting validation")
        saved = controller.read_json(directory / "evidence.json")
        require(saved.get("id") == completed_job and saved.get("snapshot") == state["snapshot"]
                and all(saved.get(key + "_sha256") == digest(directory / name)
                        for key, name in (("run_log", "run_log"), ("result", "result"),
                                          ("traces", "traces.json"))),
                "saved diagnostic artifacts changed")
    else:
        require(state["phase"] == "pending", "wrong phase")
        require(state["collect_attempted"] is False, "collection was already attempted; do not retry")
        require(state["scheduler"] == executable, "scheduler path changed since submit")
    context = Path(state["context"])
    require(all(digest(context / name) == checksum for name, checksum in state["context_hashes"].items()),
            "submitted context changed")
    if not saved_only:
        # Fail closed even if interrupted; this is the ONLY results call.
        state.update(collect_attempted=True, phase="collecting")
        state["outstanding"]["collect_attempted"] = True
        write_json(state_path, state)
        with (directory / "results.json").open("wb") as output:
            reply = subprocess.run([executable, "results", completed_job, "--json"],
                                   stdout=output, stderr=subprocess.PIPE, check=False)
        require(reply.returncode == 0, "results collection failed; attempt consumed")
    response = json.loads((directory / "results.json").read_text())
    require(response.get("id") == completed_job and response.get("terminal") is True,
            "notice was not terminal; attempt consumed; no polling/retry")
    if not saved_only:
        append_job(dict(time=now(), id=completed_job, run=state["run"], diagnostic=True,
                        event="diagnostic-collected", state=response.get("state")))
    for key in ("result", "run_log"):
        require(response.get("present", {}).get(key) is True, f"missing {key}")
        if not saved_only:
            shutil.copyfile(response["paths"][key], directory / key)
    terminal = json.loads((directory / "result").read_text())
    require(terminal.get("job_id") == completed_job, "wrong terminal job")
    require(all(terminal.get(flag) is False for flag in ("oom_killed", "timed_out", "cancelled")),
            "interrupted diagnostic job")
    require(terminal.get("network") == "off" and terminal.get("memory", 0) >= 24 * 1024**3
            and terminal.get("cpus") == 4 and terminal.get("timeout_s") == 14400
            and terminal.get("secret_names") == [], "scheduler limits/secrets mismatch")
    stats = terminal.get("run_log", {})
    require(stats.get("truncated") is False
            and stats.get("total_bytes") == stats.get("kept_bytes") == (directory / "run_log").stat().st_size,
            "incomplete scheduler log")
    lines = (directory / "run_log").read_text().splitlines()
    verdicts = [json.loads(line[12:]) for line in lines if line.startswith("JOB-VERDICT ")]
    require(len(verdicts) == 1 and lines[-1].startswith("JOB-VERDICT "), "missing final diagnostic verdict")
    verdict = verdicts[0]
    traces = [json.loads(line[6:]) for line in lines if line.startswith("TRACE ")]
    # Preserve the full original graph and behavior, with independently checked
    # trace/config hashes. Nothing is reduced to a list of observed decisions.
    definition = importlib.util.spec_from_file_location("permission_trace_worker", context / "worker.py")
    worker = importlib.util.module_from_spec(definition)
    definition.loader.exec_module(worker)
    worker.verify_inputs(context, controller.read_json(context / "plan.json"))
    previous_worker = sys.modules.get("worker")
    sys.modules["worker"] = worker
    try:
        definition = importlib.util.spec_from_file_location("permission_diagnostic_worker", context / "job.py")
        diagnostic = importlib.util.module_from_spec(definition)
        definition.loader.exec_module(diagnostic)
    finally:
        if previous_worker is None:
            del sys.modules["worker"]
        else:
            sys.modules["worker"] = previous_worker
    indexed = {row["cfg"]: row for row in rows()}
    validate_trace_inventory(traces, verdict.get("rows", []), worker)
    for trace in traces:
        row = indexed[trace["cfg"]]
        require(trace["snapshot"] == state["snapshot"]
                and trace["hashes"] == {"spec": state["context_hashes"]["PermissionFairness.tla"],
                                        "cfg": state["context_hashes"][f"{row['cfg']}.cfg"]},
                "trace snapshot/hash mismatch")
        worker.validate_trace(trace["raw"], counterexample=True, temporal=bool(row["properties"]))
    lassos = [diagnostic.lasso_evidence(trace["raw"], trace["cfg"]) for trace in traces
              if trace["property"] in {"EventuallyDelivered", "HeadTakenIn"}]
    printed_lassos = [json.loads(line[len("LASSO-EVIDENCE "):]) for line in lines
                     if line.startswith("LASSO-EVIDENCE ")]
    require(lassos == printed_lassos and len(lassos) == 2, "missing/mismatched full fairness accounting")
    write_json(directory / "traces.json", traces)
    evidence = dict(diagnostic=True, certifies_E1=False, id=completed_job,
                    snapshot=state["snapshot"], verdict=verdict,
                    run_log_sha256=digest(directory / "run_log"), result_sha256=digest(directory / "result"),
                    traces_sha256=digest(directory / "traces.json"), lassos=lassos)
    write_json(directory / "evidence.json", evidence)
    require(terminal.get("status") == "succeeded" and terminal.get("exit_code") == 0
            and verdict.get("result") == "EXPECTED-DIAGNOSTIC-COUNTEREXAMPLE"
            and verdict.get("certifies_E1") is False and verdict.get("complete") is True
            and verdict.get("snapshot") == state["snapshot"]
            and verdict.get("diagnostic") is True and verdict.get("failed") == []
            and response.get("state") == terminal.get("status"),
            "diagnostic outcome was not the complete expected counterexample; inspect saved evidence")
    state.update(phase="collected", collected_at=now(), outstanding=None)
    write_json(state_path, state)
    print(json.dumps(evidence, sort_keys=True))


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("submit")
    resume = commands.add_parser("collect")
    resume.add_argument("--run-dir", type=Path, required=True)
    resume.add_argument("--completed-job", required=True)
    resume.add_argument("--saved-only", action="store_true",
                        help="validate only retained terminal response/artifacts; never contact scheduler")
    args = parser.parse_args()
    executable = None if args.command == "collect" and args.saved_only else controller.scheduler_path()
    with controller.lock(ROOT) as home:
        if args.command == "submit":
            submit_locked(home, executable)
        else:
            directory = args.run_dir.resolve()
            try:
                collect_locked(directory, args.completed_job, home, executable, saved_only=args.saved_only)
            except BaseException:
                # Release only a consumed, locally saved terminal response. This
                # makes failed diagnostics closable without another results read.
                state = controller.read_json(directory / "state.json")
                result_path = directory / "results.json"
                response = controller.read_json(result_path) if result_path.exists() else {}
                if (state.get("phase") == "collecting" and state.get("collect_attempted") is True
                        and state.get("id") == args.completed_job
                        and response.get("id") == args.completed_job and response.get("terminal") is True):
                    state.update(phase="failed", outstanding=None)
                    write_json(directory / "state.json", state)
                raise


if __name__ == "__main__":
    main()
