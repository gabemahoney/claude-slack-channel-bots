/** Shared read-only E1 evidence validator; the synthetic verdict suite owns
 * its boundary matrix; E3 composes it for certified runtime replay. */
export const deliveryEvidencePython = String.raw`
import base64, contextlib, copy, hashlib, importlib.util, io, json, os, re, shutil, socket, subprocess, sys
from pathlib import Path
from unittest.mock import patch

REPO, SCRATCH = map(Path, sys.argv[1:3])
SOURCE = REPO / "spec/tla"

def load(path, name):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module

def forbidden(*args, **kwargs):
    raise AssertionError("external process/network call forbidden in delivery unit tests")

subprocess.Popen = forbidden
socket.socket = forbidden
runner = load(SOURCE / "ci/runner.py", "unit_delivery_runner")
contract = load(SOURCE / "ci/trace_contract.py", "unit_delivery_contract")
worker = load(SOURCE / "jobs/lib/job.py", "unit_delivery_worker")

def refuses(call, message, kind=Exception):
    try:
        call()
    except kind as error:
        assert message in str(error), (message, type(error).__name__, str(error))
    else:
        raise AssertionError("expected rejection: " + message)

def write_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value) + "\n")

def repin(root):
    (root / "PROVENANCE.txt").write_text("".join(
        runner.sha(path) + "  " + str(path.relative_to(root)) + "\n"
        for path in runner.input_paths(root)))
    return runner.verify_pins(root)

def sandbox():
    root = SCRATCH / "repo/spec/tla"
    root.mkdir(parents=True)
    for source in runner.input_paths(SOURCE):
        target = root / source.relative_to(SOURCE)
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source, target)
    repin(root)
    return root

def synthetic_record(root):
    # Intentionally incomplete, test-only certificate-shaped data. Never an
    # assertion that a scheduler ran, and never written outside this scratch.
    inputs = runner.verify_pins(root)
    return {"schema": 1, "verdict": "CI-VERDICT PASS", "run": "a" * 32,
            "time": "2000-01-01T00:00:00+00:00",
            "sany": {"path": "/synthetic/preflight/sany.json", "sha256": "0" * 64},
            "snapshot": runner.snapshot_id(inputs), "inputs": inputs,
            "job_ids": ["synthetic-job"], "completed": []}

def history(root, *records):
    (root / "ci/verdicts.txt").write_text("".join(
        (entry if isinstance(entry, str) else json.dumps(entry)) + "\n" for entry in records))

class Scheduler:
    def __init__(self, response=None, dispatcher=True):
        self.calls, self.response, self.dispatcher = [], response, dispatcher
    def call(self, args, capture=None):
        self.calls.append(args[:])
        if args == ["list"]:
            return {"summary": {"dispatcher_running": self.dispatcher}}
        if args[0] == "submit":
            assert capture is not None
            reply = {"id": "synthetic-job", "dispatcher_running": True,
                     "network": "off", "memory": runner.MIN_MEMORY,
                     "cpus": 4, "timeout_s": runner.MAX_BUDGET + runner.LIMIT_MARGIN_S}
            write_json(capture, reply)
            return reply
        if args == ["results", "synthetic-job"]:
            assert self.response is not None
            return copy.deepcopy(self.response)
        raise AssertionError("unexpected scheduler call (poll/retry?): " + repr(args))

def state_for(root):
    rows = runner.load_manifest(root, False)
    inputs = runner.verify_pins(root)
    directory = root / "ci/.runs" / ("b" * 32)
    directory.mkdir(parents=True)
    executable = SCRATCH / "unused-scheduler"
    executable.write_text("stub; must never execute\n")
    executable.chmod(0o700)
    os.environ["TLA_JOBSCHED"] = str(executable)
    os.environ["TLA_CHANNEL"] = "CUNITTEST"
    state = {"schema": 1, "run": directory.name, "phase": "ready", "proof": False,
             "channel": "CUNITTEST", "scheduler": str(executable), "inputs": inputs,
             "snapshot": runner.snapshot_id(inputs), "rows": rows,
             "plan": runner.build_plan(rows, False), "next": 0, "ids": [],
             "outstanding": None, "completed": []}
    # Exercise a real positive/simulation group without manufacturing mutation
    # replay proofs. Earlier groups are deliberately absent, so this temporary
    # partial state can never satisfy the complete certification gate.
    state["next"] = next(i for i, job in enumerate(state["plan"])
                         if all(row["expect"] == "pass" for row in job["rows"])
                         and any(row["mode"] == "simulate" for row in job["rows"]))
    persist(root, directory, state)
    return directory, state

def persist(root, directory, state):
    write_json(directory / "state.json", state)
    write_json(root / "ci/.runs/active.json", {"directory": str(directory)})

def submit(root, directory, state, scheduler):
    # Local SANY and reviewed feasibility are separate obligations. These two
    # seams allow lifecycle tests to stage/hash real inputs without a checker.
    with patch.object(runner, "verify_local_sany", return_value=None), \
         patch.object(runner, "verify_feasibility_profile", return_value=None):
        runner.submit_next(root, directory, state, scheduler)

def result_for(row):
    outcome = ("SIMULATION-OK" if row["mode"] == "simulate" else "PASS") if row["expect"] == "pass" \
              else "FAIL(Invariant_" + row["props"] + "_is_violated)"
    log = "Model checking completed. No error has been found\n2 states generated, 2 distinct states found, 0 states left on queue\nThe depth of the complete state graph search is 2\n"
    if row["mode"] == "simulate":
        log = "Progress: 2 states checked, " + str(row["simulation"]["num"]) + " traces generated (trace length: 2)\nFinished in 1s at (synthetic)\n"
    if row["expect"] == "violation":
        log = "Error: Invariant " + row["props"] + " is violated.\n"
    result = {"cfg": row["cfg"], "checks": row["checks"], "result": outcome,
              "secs": 1, "exit_code": 0 if row["expect"] == "pass" else 12,
              "distinct": 2 if row["mode"] == "check" else None,
              "depth": 2 if row["mode"] == "check" else None,
              "trace_count": row["simulation"]["num"] if row["mode"] == "simulate" else 0,
              **worker.mode_evidence(row, outcome, log)}
    return log, result

def job_log(state):
    lines, results, traces = [], [], []
    for row in state["plan"][state["next"]]["rows"]:
        log, result = result_for(row)
        assert row["expect"] == "pass", "collection control uses a positive group"
        lines.append(log.rstrip())
        for _ in range(result["trace_count"]):
            envelope = {"schema": 2, "cfg": row["cfg"], "spec": row["spec"],
                        "snapshot": state["snapshot"], "mode": row["mode"],
                        "simulation": row["simulation"], "property": row["props"],
                        "raw": {"behavior": [{}]},
                        "hashes": {"spec": state["inputs"][row["spec_path"]],
                                   "cfg": state["inputs"][row["cfg_path"]]}}
            traces.append(envelope)
            lines.append("TRACE " + json.dumps(envelope))
        results.append(result)
        lines.append("ROW " + json.dumps(result))
    final = {"schema": 1, "complete": True, "result": "PASS", "failed": [],
             "snapshot": state["snapshot"], "rows": results}
    lines.append("JOB-VERDICT " + json.dumps(final))
    return "\n".join(lines) + "\n", results, traces

def response_for(state):
    text, _, _ = job_log(state)
    log, result = SCRATCH / "incoming.run_log", SCRATCH / "incoming.result"
    log.write_text(text)
    terminal = {"job_id": "synthetic-job", "status": "succeeded", "exit_code": 0,
                "oom_killed": False, "timed_out": False, "cancelled": False,
                "network": "off", "memory": runner.MIN_MEMORY, "cpus": 4,
                "timeout_s": runner.MAX_BUDGET + runner.LIMIT_MARGIN_S, "secret_names": [],
                "run_log": {"truncated": False, "total_bytes": log.stat().st_size,
                            "kept_bytes": log.stat().st_size}}
    write_json(result, terminal)
    return {"id": "synthetic-job", "terminal": True, "state": "succeeded",
            "paths": {"run_log": str(log), "result": str(result)},
            "present": {"run_log": True, "result": True}}

def envelope_for(root, temporal=False):
    # Tiny original test inputs, not copied scheduler traces or certification.
    cfg = root / "ci/cfg/synthetic.cfg"
    cfg.write_text('SPECIFICATION Spec\nCONSTANTS\n  Scenario = "traces"\n  Bug = "none"\n  Faults = {}\n' +
                   ('PROPERTY EventuallyDelivered\n' if temporal else 'INVARIANT NoDrop\n'))
    spec = root / "Synthetic.tla"
    spec.write_text('EngineActions == {"Deliver"}\nFaultNames == {"fault"}\n')
    target = "EventuallyDelivered" if temporal else "NoDrop"
    row = {"cfg": "synthetic", "cfg_path": "ci/cfg/synthetic.cfg", "spec": "PersonaDelivery",
           "spec_path": "Synthetic.tla", "mode": "check", "simulation": None,
           "what": "synthetic boundary", "props": target, "state_reduction": None,
           "expect": "violation" if temporal else "pass", "checks": [target],
           "properties": [target] if temporal else []}
    constants = contract.cfg_constants(cfg.read_text())
    behavior = []
    for action in ("Init", "Deliver"):
        state = {"transition": action, "action": action, "outcome": "ok", "expired": [],
                 "e": {"timers": {}}, "faults": {"fault": 0}}
        behavior.append({"schema": 1, "model": "PersonaDelivery", "state": state,
                         "knowledge": {}, "gateKnowledge": {}, "observationKnowledge": {},
                         "timerConstants": {}, "constants": {k: v for k, v in constants.items() if k != "Bug"},
                         "control": {"class": "correct", "bug": "none", "bugStep": False},
                         "EngineChoice": action, "GateChoice": "none", "correctEngineChoice": action,
                         "correctGateChoice": "none", "transition": action, "executedAction": action,
                         "outcome": "ok", "expiredTimers": []})
    nodes = [[i + 1, record] for i, record in enumerate(behavior)]
    raw = {"schema": 1, "behavior": behavior}
    if temporal:
        raw["counterexample"] = {"state": nodes, "action": [[nodes[0], {}, nodes[1]], [nodes[1], {}, nodes[1]]]}
    inputs = {"Synthetic.tla": runner.sha(spec), "ci/cfg/synthetic.cfg": runner.sha(cfg)}
    run = {"inputs": inputs, "snapshot": runner.snapshot_id(inputs)}
    envelope = {"schema": 2, "snapshot": run["snapshot"], "property": target,
                **{k: row[k] for k in ("cfg", "spec", "mode", "simulation", "what")},
                "hashes": {"spec": inputs["Synthetic.tla"], "cfg": inputs["ci/cfg/synthetic.cfg"]}, "raw": raw}
    return run, row, envelope

# SR-15.6 checks the committed serialization. The CLI's full canonical audit
# additionally needs ignored scheduler/SANY files and reconstructs work proofs;
# those are separate obligations, never prerequisites for this portable gate.
def portable_fixture(root, record, row, fixture, identifier):
    envelope = contract.rehydrate_fixture(fixture)
    runner.require(envelope.get("jobId") == identifier, "fixture job binding mismatch")
    runner.require(envelope.get("schema") == 2 and envelope.get("snapshot") == record["snapshot"],
                   "trace schema/snapshot mismatch")
    runner.require(all(envelope.get(key) == row[key] for key in ("cfg", "spec", "mode", "simulation", "what"))
                   and envelope.get("property") == row["props"], "trace row metadata mismatch")
    runner.require(envelope.get("hashes") == {key: record["inputs"][row[key + "_path"]]
                                            for key in ("spec", "cfg")}, "trace source hashes mismatch")
    runner.require(all(runner.sha(root / row[key + "_path"]) == value for key, value in envelope["hashes"].items()),
                   "trace sources are stale")
    worker.validate_trace(envelope.get("raw", {}), counterexample=row["expect"] == "violation",
                          temporal=bool(row["properties"]))
    metadata = envelope.get("behaviorMetadata", {})
    replay = metadata.get("replayField")
    runner.require(replay in ("raw", "concreteCandidate") and isinstance(metadata.get("bugSteps"), list),
                   "missing fixture replay metadata")
    if replay == "concreteCandidate":
        worker.validate_trace(envelope.get(replay, {}), counterexample=True, temporal=True)
        for field, key in (("raw", "viewTraceSha256"), (replay, "concreteCandidateSha256")):
            runner.require(metadata.get(key) == hashlib.sha256(contract.encoded(envelope[field])).hexdigest(),
                           "fixture replay digest mismatch")
    # Retain the actual job trace separately from exporter-added metadata. Its
    # canonical hash binds even proof payloads that this unit does not re-prove.
    return envelope, {key: value for key, value in envelope.items() if key not in ("jobId", "behaviorMetadata")}

def portable_fixture_file(path, checksum, root, record, row, identifier):
    runner.require(not path.is_symlink() and runner.sha(path) == checksum,
                   "committed fixture hash mismatch: " + path.name)
    fixture = runner.read_json(path)
    runner.require(path.read_bytes() == contract.encoded(fixture), "noncanonical committed fixture")
    return portable_fixture(root, record, row, fixture, identifier)

def portable_certificate(root):
    verdicts = root / "ci/verdicts.txt"
    runner.require(verdicts.is_file() and bool(verdicts.read_text().splitlines()), "no certified suite")
    record = json.loads(verdicts.read_text().splitlines()[-1])
    runner.require(isinstance(record, dict) and record.get("schema") == 1
                   and record.get("verdict") == "CI-VERDICT PASS", "invalid certificate")
    inputs = runner.verify_pins(root)
    runner.require(record.get("inputs") == inputs and record.get("snapshot") == runner.snapshot_id(inputs),
                   "stale certificate")
    runner.require(isinstance(record.get("run"), str) and re.fullmatch(r"[a-f0-9]{32}", record["run"])
                   and isinstance(record.get("time"), str) and bool(record["time"]), "invalid certificate identity")
    sany = record.get("sany", {})
    runner.require(isinstance(sany.get("path"), str) and sany["path"].endswith("/preflight/sany.json")
                   and re.fullmatch(r"[a-f0-9]{64}", sany.get("sha256", "")), "missing SANY attestation")
    rows = runner.load_manifest(root, False)
    plan = runner.build_plan(rows, False)
    completed = record.get("completed", [])
    ids = record.get("job_ids", [])
    runner.require(bool(ids), "certificate has no scheduler jobs")
    runner.require(all(isinstance(i, str) and re.fullmatch(r"[A-Za-z0-9._-]+", i) for i in ids)
                   and len(set(ids)) == len(plan)
                   and [job.get("job") for job in completed] == [job["name"] for job in plan]
                   and [job.get("id") for job in completed] == ids, "partial certificate groups")
    destination = root.parents[1] / "tests/fixtures/delivery-traces"
    coverage = runner.read_json(destination / "coverage.json")
    runner.require(coverage == record.get("trace_evidence") and coverage.get("schema") == 2
                   and coverage.get("snapshot") == record["snapshot"] and coverage.get("jobIds") == ids,
                   "committed coverage differs from certificate")
    inventory = coverage.get("fixtures", {})
    runner.require(bool(inventory) and set(inventory) | {"coverage.json"}
                   == {path.name for path in destination.iterdir()}, "committed fixture inventory mismatch")
    by_cfg, modes, witnesses = {row["cfg"]: [] for row in rows}, {}, {}
    jobs = {row["cfg"]: job["id"] for expected, job in zip(plan, completed) for row in expected["rows"]}
    for name in inventory:
        runner.require(re.fullmatch(r"[A-Za-z0-9_-]+-[0-9]{3}\.json", name), "unsafe fixture name")
        cfg = name.rsplit("-", 1)[0]
        runner.require(cfg in by_cfg, "unexpected fixture cfg")
        by_cfg[cfg].append(name)
    # Decode one scheduler group at a time; do not retain the entire expanded
    # fixture suite in memory or copy ignored canonical logs into a unit run.
    for expected, job in zip(plan, completed):
        results = job.get("results", [])
        runner.require([result.get("cfg") for result in results] == [row["cfg"] for row in expected["rows"]],
                       "partial certificate group rows")
        traces = []
        for row, result in zip(expected["rows"], results):
            runner.validate_row_result(row, result)
            selected = sorted(by_cfg[row["cfg"]])
            count = result.get("trace_count")
            runner.require(type(count) is int and count == len(selected)
                           and selected == [f"{row['cfg']}-{n:03d}.json" for n in range(1, count + 1)],
                           "committed trace count/order mismatch")
            runner.require((row["expect"] != "violation" or count > 0)
                           and (row["mode"] != "simulate" or row["expect"] != "pass" or count == row["simulation"]["num"])
                           and (row["cfg"] not in worker.WORK_WITNESS_ROWS or count == 1), "incomplete committed traces")
            for name in selected:
                envelope, original = portable_fixture_file(destination / name, inventory[name], root, record, row, job["id"])
                traces.append(original)
                if row["cfg"] in worker.WORK_WITNESS_ROWS:
                    witnesses[row["cfg"]] = envelope
            modes[row["cfg"]] = {"jobId": job["id"], **{key: result[key] for key in
                ("mode", "simulation", "result", "exhaustive", "propertyStatus", "simulationStats")},
                "stateReduction": runner.restart_reduction(row), "cfgSha256": inputs[row["cfg_path"]]}
        runner.require("traceSummary" in job or "traces" in job, "missing certified trace binding")
        runner.check_trace_inventory(job, traces)
        for key in ("log_sha256", "result_sha256"):
            runner.require(re.fullmatch(r"[a-f0-9]{64}", job.get(key, "")), "missing retained evidence digest")
    runner.require(coverage.get("rowModes") == modes, "certificate row modes mismatch")
    for key, required in (("restartOrder", set(runner.RESTART_CASES) | {runner.RESTART_SIMULATION}),
                          ("restartMutations", set(runner.RESTART_MUTATIONS))):
        entries = coverage.get(key, {})
        runner.require(set(entries) == required, "incomplete committed coverage: " + key)
        for cfg, entry in entries.items():
            runner.require(all(entry.get(field) == modes[cfg][field] for field in
                               ("jobId", "result", "stateReduction", "cfgSha256")), "restart summary binding mismatch")
    for key, expected in (("engineActions", contract.inventory((root / "PersonaDelivery.tla").read_text(), "EngineActions")),
                          ("boundedFaults", contract.inventory((root / "PersonaDelivery.tla").read_text(), "FaultNames")),
                          ("flappingActions", {"AgentOwnTurnStart", "AgentTurnEnd", "PermissionOpen", "PermissionAnswer"}),
                          ("controls", set(runner.ALL_CONTROLS))):
        runner.require(coverage.get(key) == sorted(expected), "incomplete committed coverage: " + key)
    accepted = coverage.get("acceptedWork", {})
    runner.require(set(accepted) == worker.WORK_WITNESS_ROWS, "missing accepted-work summaries")
    for cfg in worker.WORK_WITNESS_ROWS:
        envelope = witnesses[cfg]
        evidence = envelope.get("acceptedWork", {})
        summary = envelope["behaviorMetadata"].get("acceptedWork", {})
        artifacts = evidence.get("artifacts", {})
        runner.require(set(artifacts) == set(worker.WORK_WITNESS_ARTIFACTS), "incomplete accepted-work artifacts")
        for name, artifact in artifacts.items():
            content = base64.b64decode(artifact["base64"], validate=True)
            runner.require(hashlib.sha256(content).hexdigest() == artifact["sha256"], "changed accepted-work artifact")
            if name == "evidence.json":
                runner.require(content == contract.encoded(evidence["payload"]), "changed accepted-work payload")
        runner.require(accepted[cfg] == {"jobId": jobs[cfg], **summary}
                       and summary == {**evidence["payload"]["summary"], "boundedPositiveNonvacuity": True,
                                       "universalProgress": False, "artifactHashes": summary.get("artifactHashes")}
                       and summary.get("artifactHashes") == {name: value["sha256"] for name, value in artifacts.items()}
                       and summary.get("boundedPositiveNonvacuity") is True
                       and summary.get("universalProgress") is False
                       and summary.get("exhaustivePositiveCertification") is False,
                       "accepted-work summary binding mismatch")
    core = coverage.get("coreCoverage", {})
    runner.require(set(core) == runner.CORE and all(core.values()), "incomplete exhaustive core coverage")
    for prop, entries in core.items():
        for entry in entries:
            mode = modes[entry["cfg"]]
            runner.require(mode["exhaustive"] is True and mode["propertyStatus"].get(prop) == "PASS"
                           and entry["jobId"] == mode["jobId"] and entry["cfgSha256"] == mode["cfgSha256"]
                           and entry["specSha256"] == inputs["PersonaDelivery.tla"], "invalid exhaustive core coverage")
    return record

read_only = False
scratch_evidence = False
scratch_relative_open = None
def scratch_path(path, dir_fd=None):
    if isinstance(path, int):
        path = os.readlink('/proc/self/fd/' + str(path))
    else:
        path = os.fsdecode(path)
        if not os.path.isabs(path) and dir_fd is not None and dir_fd != -1:
            path = os.path.join(os.readlink('/proc/self/fd/' + str(dir_fd)), path)
    return Path(path).resolve().is_relative_to(SCRATCH.resolve())

def audit_portable(event, args):
    if not read_only:
        return
    if event == "open":
        path, mode, flags = args
        writable = scratch_evidence and (scratch_path(path) or path == scratch_relative_open)
        runner.require(not isinstance(path, (str, bytes)) or ".runs" not in Path(os.fsdecode(path)).parts or writable
                       or (scratch_evidence and scratch_relative_open is not None and path == '.runs'),
                       "portable gate accessed ignored runtime evidence")
        runner.require(not flags & (os.O_WRONLY | os.O_RDWR | os.O_CREAT | os.O_TRUNC | os.O_APPEND) or writable,
                       "portable gate attempted a write")
    if event in {"os.mkdir", "os.remove", "os.rmdir", "os.rename", "os.chmod", "os.link",
                  "os.symlink", "os.truncate", "os.utime", "fcntl.flock"}:
        # Accepted-work verification reconstructs retained artifacts and locks
        # its bounded local store. Only that call may mutate this run's scratch;
        # committed sources, fixtures and ignored .runs remain inaccessible.
        dir_fd = args[2] if event in {"os.mkdir", "os.chmod", "os.utime"} and len(args) > 2 else args[1] if event in {"os.remove", "os.rmdir"} and len(args) > 1 else None
        allowed = scratch_evidence and scratch_path(args[0], dir_fd)
        if event in {"os.rename", "os.link", "os.symlink"}:
            allowed = False
        runner.require(allowed, "portable gate attempted filesystem mutation/lock: " + event)
sys.addaudithook(audit_portable)

def readonly(call):
    global read_only
    read_only = True
    try:
        return call()
    finally:
        read_only = False

def committed_state(root):
    paths = set(runner.input_paths(root)) | {root / "PROVENANCE.txt", root / "ci/verdicts.txt"}
    fixtures = root.parents[1] / "tests/fixtures/delivery-traces"
    if fixtures.exists():
        paths.update(fixtures.iterdir())
    return {str(path): (path.stat().st_mode, path.stat().st_size, path.stat().st_mtime_ns, runner.sha(path))
            if path.is_file() else None for path in paths}

def validate_committed_envelope(record, row, envelope):
    if row['cfg'] not in worker.WORK_WITNESS_ROWS:
        return readonly(lambda: contract.validate_envelope(SOURCE, record, row, envelope, worker))
    global scratch_evidence
    result = next(result for job in record['completed'] for result in job['results'] if result['cfg'] == row['cfg'])
    original_session = contract.storage.session
    original_file = contract.storage.regular_file
    def scratch_file(path, mode='rb'):
        global scratch_relative_open
        previous = scratch_relative_open
        try:
            # regular_file traverses absolute parent fds with O_NOFOLLOW and
            # opens this basename relative to its verified scratch directory.
            if scratch_path(path):
                scratch_relative_open = Path(path).name
            return original_file(path, mode)
        finally:
            scratch_relative_open = previous
    before = committed_state(SOURCE)
    scratch_evidence = True
    try:
        # Redirect only reconstruction storage, retaining all artifact hashes,
        # canonical row timing, complete temporal verification and budget checks.
        with patch.object(contract.storage, 'session', lambda _: original_session(SCRATCH / 'accepted-work/.runs')), \
             patch.object(contract.storage, 'regular_file', scratch_file):
            return readonly(lambda: contract.validate_envelope(SOURCE, record, row, envelope, worker, result=result))
    finally:
        scratch_evidence = False
        assert committed_state(SOURCE) == before, 'accepted-work validator changed committed inputs'
`
