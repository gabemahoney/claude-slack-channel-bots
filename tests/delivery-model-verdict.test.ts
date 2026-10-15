/**
 * b.omv SR-15.6 / t3.j2a.di.th.4y: certification and trace handoff boundaries.
 * Synthetic cases use disposable inputs and an in-memory scheduler. They never
 * certify the repository. The separate committed-evidence case deliberately
 * fails until the complete canonical certification exists; do not skip it.
 * E3 owns runtime replay and ENGINE_ACTIONS conformance.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { hostSafeChildEnv } from './test-helpers/host-safe-env.ts'

const repo = join(import.meta.dir, '..')
const scratch: string[] = []
afterEach(() => {
  for (const path of scratch.splice(0)) rmSync(path, { recursive: true, force: true })
})

// Python is the implementation's language. Import its real modules with bytecode
// writes disabled, fence every external process/socket, and pass no ambient env.
// Only the scheduler and SANY seams are substituted in lifecycle cases: no Java,
// checker, scheduler executable, network, agent or production state is reachable.
const harness = String.raw`
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
def audit_portable(event, args):
    if not read_only:
        return
    if event == "open":
        path, mode, flags = args
        runner.require(not isinstance(path, (str, bytes)) or ".runs" not in Path(os.fsdecode(path)).parts,
                       "portable gate accessed ignored runtime evidence")
        runner.require(not flags & (os.O_WRONLY | os.O_RDWR | os.O_CREAT | os.O_TRUNC | os.O_APPEND),
                       "portable gate attempted a write")
    runner.require(event not in {"os.mkdir", "os.remove", "os.rmdir", "os.rename", "os.chmod", "os.link",
                                  "os.symlink", "os.truncate", "os.utime", "fcntl.flock"},
                   "portable gate attempted filesystem mutation/lock: " + event)
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
`

function python(body: string, timeoutMs = 30_000): void {
  const root = mkdtempSync(join(tmpdir(), 'delivery-verdict-unit-'))
  scratch.push(root)
  const home = join(root, 'home')
  mkdirSync(home)
  const result = spawnSync('/usr/bin/python3', ['-B', '-c', `${harness}\n${body}`, repo, root], {
    cwd: repo,
    env: hostSafeChildEnv(home, { tools: [], extras: { TMPDIR: root, SLACK_STATE_DIR: join(home, 'state') } }),
    encoding: 'utf8', timeout: timeoutMs, maxBuffer: 1024 * 1024,
  })
  expect({ status: result.status, signal: result.signal, error: result.error?.message,
    diagnostic: result.status === 0 ? '' : result.stderr + result.stdout }).toEqual({
    status: 0, signal: null, error: undefined, diagnostic: '',
  })
}

describe('delivery certification: synthetic boundaries', () => {
  test('pins cover current model, manifest, every cfg, jar and required sources; each mutation rejects', () => python(String.raw`
root = sandbox()
inputs = runner.verify_pins(root)
assert set(inputs) == {str(p.relative_to(root)) for p in runner.input_paths(root)} | {"PROVENANCE.txt"}
assert inputs["tla2tools.jar"] == runner.JAR_SHA256
assert runner.load_manifest(root, False)
required = [p for p in runner.input_paths(root) if p.suffix != ".cfg"]
for path in required:
    original = path.read_bytes()
    path.write_bytes(original + b" ")
    refuses(lambda: runner.verify_pins(root), "SHA-256 mismatch: " + str(path.relative_to(root)))
    path.write_bytes(original)
assert runner.verify_pins(root) == inputs
`))

  test('exactly one changed cfg byte names the mismatch, and removed or added cfgs fail inventory', () => python(String.raw`
root = sandbox()
history(root, synthetic_record(root))
cfg = sorted((root / "ci/cfg").glob("*.cfg"))[0]
original = cfg.read_bytes()
changed = bytearray(original)
changed[0] ^= 1
assert len(changed) == len(original) and sum(a != b for a, b in zip(original, changed)) == 1
cfg.write_bytes(changed)
refuses(lambda: runner.verify_certificate(root), "SHA-256 mismatch: " + str(cfg.relative_to(root)))
cfg.write_bytes(original)
cfg.unlink()
refuses(lambda: runner.verify_certificate(root), "pin inventory mismatch")
cfg.write_bytes(original)
extra = root / "ci/cfg/unrecorded.cfg"
extra.write_text("SPECIFICATION Spec\n")
refuses(lambda: runner.verify_certificate(root), "pin inventory mismatch")
`))

  test('absent, empty, malformed, incomplete and stale latest evidence cannot use older matching inputs', () => python(String.raw`
root = sandbox()
refuses(lambda: runner.verify_certificate(root), "no certified suite")
history(root)
refuses(lambda: runner.verify_certificate(root), "no certified suite")
older = synthetic_record(root)
cases = [("not-json", "Expecting value"), ({}, "invalid certificate"),
         ({**older, "job_ids": []}, "no scheduler jobs"),
         (older, "partial certificate groups"),
         ({**older, "snapshot": "0" * 64}, "stale certificate"),
         ({**older, "inputs": {k: v for k, v in older["inputs"].items() if not k.endswith(".cfg")}}, "stale certificate")]
for latest, message in cases:
    history(root, older, latest)
    refuses(lambda: runner.verify_certificate(root), message)
`))

  test('production preflight refusals make zero scheduler calls and never start SANY', () => python(String.raw`
root = sandbox()
directory, state = state_for(root)
(root / "ci/.runs/active.json").unlink()
scheduler = Scheduler()
with patch.object(runner, "local_sany", side_effect=forbidden):
    for key, value, message in [("TLA_GROUPS", "partial", "overrides are refused"),
                                ("TLA_CHANNEL", "", "TLA_CHANNEL is required"),
                                ("TLA_JOBSCHED", "relative-path", "caller-supplied absolute")]:
        with patch.dict(os.environ, {key: value}), contextlib.redirect_stderr(io.StringIO()) as err:
            assert runner.main(["start"], root=root, scheduler=scheduler) == 1
            assert message in err.getvalue(), err.getvalue()
    policy = root / "ci/feasibility_profile.json"
    value = json.loads(policy.read_text())
    value["reviewStatus"] = "pending"
    write_json(policy, value)
    repin(root)
    with contextlib.redirect_stderr(io.StringIO()) as err:
        assert runner.main(["start"], root=root, scheduler=scheduler) == 1
        assert "independent review" in err.getvalue(), err.getvalue()
assert scheduler.calls == []
assert not (root / "ci/jobs.jsonl").exists()
`))

  test('dispatcher refusal submits nothing; a pending submission cannot be submitted twice', () => python(String.raw`
root = sandbox()
directory, state = state_for(root)
stopped = Scheduler(dispatcher=False)
refuses(lambda: submit(root, directory, state, stopped), "dispatcher is not running")
assert stopped.calls == [["list"]] and state["ids"] == []
scheduler = Scheduler()
submit(root, directory, state, scheduler)
assert len(scheduler.calls) == 2 and scheduler.calls[0] == ["list"] and scheduler.calls[1][0] == "submit"
args = scheduler.calls[1]
for flag, value in [("--network", "off"), ("--memory", "24g"), ("--cpus", "4"), ("--timeout", "4h")]:
    assert args[args.index(flag) + 1] == value
saved = runner.read_json(directory / "state.json")
assert saved["phase"] == "pending" and saved["outstanding"]["id"] == "synthetic-job"
assert saved["snapshot"] == runner.snapshot_id(saved["inputs"])
refuses(lambda: submit(root, directory, saved, scheduler), "one job already outstanding")
assert len(scheduler.calls) == 2
assert len((root / "ci/jobs.jsonl").read_text().splitlines()) == 1
assert not (root / "ci/verdicts.txt").exists()
`))

  test('persisted resume binds active directory, snapshot, channel, scheduler and exact notice ID before collection', () => python(String.raw`
root = sandbox()
directory, state = state_for(root)
scheduler = Scheduler()
submit(root, directory, state, scheduler)
scheduler.calls.clear()
argv = ["collect", "--run-dir", str(directory), "--completed-job", "synthetic-job"]
mutations = [("snapshot", "0" * 64, "stale resume"), ("channel", "COTHER", "notice channel changed"),
             ("scheduler", "/unused-other", "scheduler path changed")]
with patch.object(runner, "verify_local_sany", return_value=None):
    for key, value, message in mutations:
        saved = copy.deepcopy(state)
        saved[key] = value
        persist(root, directory, saved)
        with contextlib.redirect_stderr(io.StringIO()) as err:
            assert runner.main(argv, root=root, scheduler=scheduler) == 1
            assert message in err.getvalue(), err.getvalue()
    persist(root, directory, state)
    for args, message in [(argv[:-1] + ["other-job"], "notice job ID differs"),
                          (argv[:3], "requires --run-dir and --completed-job")]:
        with contextlib.redirect_stderr(io.StringIO()) as err:
            assert runner.main(args, root=root, scheduler=scheduler) == 1
            assert message in err.getvalue(), err.getvalue()
    write_json(root / "ci/.runs/active.json", {"directory": str(SCRATCH / "other")})
    with contextlib.redirect_stderr(io.StringIO()) as err:
        assert runner.main(argv, root=root, scheduler=scheduler) == 1
        assert "not the active run" in err.getvalue(), err.getvalue()
assert scheduler.calls == []
`))

  test('collect-only consumes one result, retains lossless hash-bound evidence and cannot collect or certify twice', () => python(String.raw`
root = sandbox()
directory, state = state_for(root)
scheduler = Scheduler()
submit(root, directory, state, scheduler)
scheduler.response = response_for(state)
scheduler.calls.clear()
argv = ["collect", "--run-dir", str(directory), "--completed-job", "synthetic-job"]
with patch.object(runner, "verify_local_sany", return_value=None):
    assert runner.main(argv, root=root, scheduler=scheduler) == 0
    saved = runner.read_json(directory / "state.json")
    assert saved["next"] == state["next"] + 1 and saved["outstanding"] is None and saved["phase"] == "ready"
    entry = saved["completed"][0]
    assert "traces" not in entry and entry["traceSummary"]["count"] > 0
    assert runner.read_job_log(directory, entry) == (SCRATCH / "incoming.run_log").read_text()
    assert runner.read_completed(directory, entry, state["plan"][state["next"]], state["snapshot"])[0] == entry["results"]
    with contextlib.redirect_stderr(io.StringIO()) as err:
        assert runner.main(argv, root=root, scheduler=scheduler) == 1
        assert "not pending collection" in err.getvalue(), err.getvalue()
    refuses(lambda: runner.finish(root, directory, saved), "incomplete run")
assert scheduler.calls == [["results", "synthetic-job"]]
assert not (root / "ci/verdicts.txt").exists()
container = directory / entry["logContainer"]["path"]
content = bytearray(container.read_bytes())
content[-1] ^= 1
container.write_bytes(content)
refuses(lambda: runner.read_completed(directory, entry, state["plan"][state["next"]], state["snapshot"]), "invalid canonical gzip", ValueError)
`))

  test.each([
    ['nonterminal', 'not terminal'], ['wrong-id', 'not terminal'],
    ['terminal-failure', 'terminal scheduler failure'], ['interrupted', 'interrupted run'],
    ['missing-log', 'missing run_log'], ['truncated', 'incomplete run log'],
    ['context-changed', 'submitted context changed'],
  ])('collection rejects %s, consumes its sole attempt and never polls', (fault, message) => python(String.raw`
root = sandbox()
directory, state = state_for(root)
scheduler = Scheduler()
submit(root, directory, state, scheduler)
response = response_for(state)
fault, message = ${JSON.stringify(fault)}, ${JSON.stringify(message)}
if fault == "nonterminal": response["terminal"] = False
if fault == "wrong-id": response["id"] = "other-job"
if fault == "missing-log": response["present"]["run_log"] = False
if fault == "context-changed":
    (Path(state["outstanding"]["context"]) / "plan.json").write_text("changed")
terminal_path = Path(response["paths"]["result"])
terminal = runner.read_json(terminal_path)
if fault == "terminal-failure": response["state"] = "cancelled"
if fault == "interrupted": terminal["timed_out"] = True
if fault == "truncated": terminal["run_log"]["truncated"] = True
write_json(terminal_path, terminal)
scheduler.response = response
scheduler.calls.clear()
refuses(lambda: runner.collect(root, directory, state, "synthetic-job", scheduler), message)
saved = runner.read_json(directory / "state.json")
assert saved["phase"] == "collecting" and saved["outstanding"]["collect_attempted"] is True
refuses(lambda: runner.collect(root, directory, saved, "synthetic-job", scheduler), "not pending collection")
assert scheduler.calls == [["results", "synthetic-job"]]
assert not (root / "ci/verdicts.txt").exists()
`))

  test('authentic log boundary rejects missing/incomplete rows and successful-looking terminal errors', () => python(String.raw`
root = sandbox()
_, state = state_for(root)
text, results, traces = job_log(state)
job, snapshot = state["plan"][state["next"]], state["snapshot"]
assert runner.parse_job_log(text, job, snapshot) == (results, traces)
refuses(lambda: runner.parse_job_log(text.rsplit("JOB-VERDICT ", 1)[0], job, snapshot), "missing final JOB-VERDICT")
lines = text.splitlines()
removed = "\n".join(line for line in lines if not line.startswith("ROW "))
refuses(lambda: runner.parse_job_log(removed, job, snapshot), "row/final verdict mismatch")
final = json.loads(lines[-1][12:])
final["complete"] = False
refuses(lambda: runner.parse_job_log("\n".join(lines[:-1] + ["JOB-VERDICT " + json.dumps(final)]), job, snapshot), "incomplete job")
refuses(lambda: runner.parse_job_log("Error: state is not completely specified\n" + text, job, snapshot), "authentic checker output")
refuses(lambda: runner.parse_job_log(text, job, "0" * 64), "job snapshot mismatch")
`))

  test('violations must name the exact target; unnamed temporal failures require the sole matching PROPERTY', () => python(String.raw`
root = sandbox()
row = next(r for r in runner.load_manifest(root, False) if r["properties"] and r["expect"] == "violation")
assert runner.result_matches(row, "FAIL(Temporal_property_" + row["props"] + "_was_violated)")
assert runner.result_matches(row, "FAIL(Temporal_properties_were_violated)")
assert not runner.result_matches(row, "FAIL(Invariant_Unrelated_is_violated)")
for changed in ({"properties": []}, {"properties": ["Unrelated"]},
                {"properties": [row["props"], "Unrelated"]}, {"checks": [row["props"], "Unrelated"]}):
    assert not runner.result_matches({**row, **changed}, "FAIL(Temporal_properties_were_violated)")
result = result_for(row)[1]
result["result"] = "FAIL(Invariant_Unrelated_is_violated)"
refuses(lambda: runner.validate_row_result(row, result), "expected " + row["props"])
# Exercise the full log/result boundary too: matching anonymous output passes
# only with the row's sole PROPERTY, while a named wrong target fails even
# when the final job verdict honestly reports that mismatch.
for output, accepted in [("Error: Temporal properties were violated.\n", True),
                         ("Error: Invariant Unrelated is violated.\n", False)]:
    outcome = worker.classify(output, 12, row["mode"])
    result = {**result_for(row)[1], "result": outcome, "trace_count": 1,
              **worker.mode_evidence(row, outcome, output)}
    snapshot = "synthetic-snapshot"
    trace = {"schema": 2, "cfg": row["cfg"], "spec": row["spec"], "snapshot": snapshot}
    final = {"schema": 1, "complete": True, "snapshot": snapshot, "rows": [result],
             "failed": [] if accepted else [row["cfg"]], "result": "PASS" if accepted else "FAIL"}
    text = output + "TRACE " + json.dumps(trace) + "\nROW " + json.dumps(result) + "\nJOB-VERDICT " + json.dumps(final)
    if accepted:
        assert runner.parse_job_log(text, {"rows": [row]}, snapshot)[0] == [result]
    else:
        refuses(lambda: runner.parse_job_log(text, {"rows": [row]}, snapshot), "expected " + row["props"])
`))

  test('primary checker counts and classification exclude helper logs embedded in structured TRACE', () => python(String.raw`
root = sandbox()
run, row, envelope = envelope_for(root)
row["cap_s"] = 60
primary = ("Model checking completed. No error has been found\n"
           "46351 states generated, 9279 distinct states found, 0 states left on queue\n"
           "The depth of the complete state graph search is 73\n")
# Keep the replay envelope valid and tiny; its opaque helper strings reproduce
# the accepted-work search/replay summaries without a full work-proof bundle.
envelope["raw"]["helperLogs"] = [
    "Model checking completed. No error has been found\n" +
    str(generated) + " states generated, 65 distinct states found, 0 states left on queue\n" +
    "The depth of the complete state graph search is 65\n"
    for generated in (66, 79)]
behavior, _ = contract.validate_envelope(root, run, row, envelope, worker)
assert behavior == envelope["raw"]["behavior"]
result = {**result_for(row)[1], "distinct": 9279, "depth": 73, "trace_count": 1}
job = {"rows": [row]}

def log(output=primary, actual=result, trace=envelope):
    final = {"schema": 1, "complete": True, "snapshot": run["snapshot"],
             "rows": [actual], "failed": [], "result": "PASS"}
    return (output + "TRACE " + json.dumps(trace) + "\nROW " + json.dumps(actual) +
            "\nJOB-VERDICT " + json.dumps(final))

assert runner.parse_job_log(log(), job, run["snapshot"]) == ([result], [envelope])
# Non-primary diagnostic text must not change the row's classification either.
diagnostic = copy.deepcopy(envelope)
diagnostic["raw"]["helperLogs"].append("Exception: independent helper diagnostic")
assert runner.parse_job_log(log(trace=diagnostic), job, run["snapshot"]) == ([result], [diagnostic])
for changed in ({"distinct": 65}, {"depth": 65}):
    # Forge ROW and the final verdict together, so equality of those two records
    # cannot substitute for comparison with the authentic primary graph.
    refuses(lambda: runner.parse_job_log(log(actual={**result, **changed}), job, run["snapshot"]),
            "exhaustive graph differs from checker output")
# A matching helper summary must not rescue unfinished or absent primary data.
matching_helper = copy.deepcopy(envelope)
matching_helper["raw"]["helperLogs"] = [primary]
for output in (primary.replace("0 states left on queue", "1 states left on queue"),
               primary.split("46351 states generated", 1)[0],
               primary.split("The depth", 1)[0]):
    refuses(lambda: runner.parse_job_log(log(output=output, trace=matching_helper), job, run["snapshot"]),
            "exhaustive graph differs from checker output")
refuses(lambda: runner.parse_job_log(log(output=primary.split("\n", 1)[1], trace=matching_helper), job, run["snapshot"]),
        "row result differs from authentic checker output")
# Excluding TRACE from checker text still requires its structured boundary.
for changed, message in [({"schema": 1}, "bad trace envelope"),
                         ({"snapshot": "old"}, "mismatched trace")]:
    refuses(lambda: runner.parse_job_log(log(trace={**envelope, **changed}), job, run["snapshot"]), message)
refuses(lambda: runner.parse_job_log(log().replace("TRACE {", "TRACE !{", 1), job, run["snapshot"]),
        "Expecting value", json.JSONDecodeError)
`))

  test('trace validation rejects malformed replay fields and stale snapshot, hashes or source bytes', () => python(String.raw`
root = sandbox()
run, row, envelope = envelope_for(root)
behavior, metadata = contract.validate_envelope(root, run, row, envelope, worker)
assert behavior == envelope["raw"]["behavior"] and metadata["replayField"] == "raw"
for mutate, message in [
    (lambda e: e.update(schema=1), "schema/snapshot"),
    (lambda e: e.update(snapshot="old"), "schema/snapshot"),
    (lambda e: e["hashes"].update(cfg="0" * 64), "source hashes mismatch"),
    (lambda e: e["raw"].update(behavior=[]), "missing behavior"),
    (lambda e: e["raw"]["behavior"][0].pop("EngineChoice"), "missing ALIAS decisions"),
    (lambda e: e["raw"]["behavior"][0].pop("knowledge"), "missing replay field knowledge"),
    (lambda e: e["raw"]["behavior"][0].update(executedAction="forged"), "projection differs"),
]:
    changed = copy.deepcopy(envelope)
    mutate(changed)
    refuses(lambda: contract.validate_envelope(root, run, row, changed, worker), message)
(root / row["spec_path"]).write_text("changed")
refuses(lambda: contract.validate_envelope(root, run, row, envelope, worker), "trace sources are stale")
`))

  test('temporal extraction requires the complete path and a valid closing lasso reference', () => python(String.raw`
root = sandbox()
run, row, envelope = envelope_for(root, temporal=True)
assert contract.validate_envelope(root, run, row, envelope, worker)[1]["loopStart"] == 2
for change, message in [
    (lambda e: e["raw"]["counterexample"]["action"].pop(), "missing/unexpected lasso edge"),
    (lambda e: e["raw"]["counterexample"]["action"][-1].__setitem__(2, [3, {}]), "invalid graph edge"),
    (lambda e: e["raw"]["counterexample"]["action"].pop(0), "incomplete behavior path"),
]:
    changed = copy.deepcopy(envelope)
    change(changed)
    refuses(lambda: contract.validate_envelope(root, run, row, changed, worker), message)
`))

  test('extractor rejects an apparently complete run whose executed-action coverage is missing', () => python(String.raw`
root = sandbox()
directory, state = state_for(root)
state["next"] = len(state["plan"])
state["ids"] = ["synthetic-" + str(i) for i in range(len(state["plan"]))]
state["completed"] = [{"job": job["name"], "id": identifier}
                      for job, identifier in zip(state["plan"], state["ids"])]
def completed_without_traces(directory, completed, job, snapshot):
    return [result_for(row)[1] for row in job["rows"]], []
def modules(path, name):
    if path.name == "runner.py": return runner
    if path.name == "job.py": return worker
    raise AssertionError("unexpected module " + str(path))
with patch.object(contract, "load_module", side_effect=modules), \
     patch.object(runner, "verify_local_sany", return_value=None), \
     patch.object(runner, "read_completed", side_effect=completed_without_traces):
    refuses(lambda: contract.certify_traces(root, state), "uncovered executed engine actions")
assert not (root.parents[1] / "tests/fixtures/delivery-traces").exists()
assert not (root / "ci/verdicts.txt").exists()
`))

  test('schema 3 fixtures rehydrate the full schema 2 payload and reject corrupted or ambiguous containers', () => python(String.raw`
root = sandbox()
_, _, legacy = envelope_for(root, temporal=True)
legacy["behaviorMetadata"] = {"loopStart": 2, "loopEnd": 2}
compact = {"schema": 3, "fixtureContainer": contract.storage.compact_envelopes([legacy])}
assert contract.rehydrate_fixture(compact) == legacy
assert contract.rehydrate_fixture(legacy) == legacy
refuses(lambda: contract.rehydrate_fixture({**compact, "raw": legacy["raw"]}), "malformed compact fixture")
refuses(lambda: contract.rehydrate_fixture({**legacy, "fixtureContainer": compact["fixtureContainer"]}), "mislabeled as legacy")
damaged = copy.deepcopy(compact)
damaged["fixtureContainer"]["sha256"] = "0" * 64
refuses(lambda: contract.rehydrate_fixture(damaged), "invalid local envelope encoding", ValueError)
`))

  test('portable latest-record gate rejects missing, malformed, partial and stale final records without older fallback', () => python(String.raw`
root = sandbox()
refuses(lambda: readonly(lambda: portable_certificate(root)), "no certified suite")
history(root)
refuses(lambda: readonly(lambda: portable_certificate(root)), "no certified suite")
older = synthetic_record(root)
for latest, message in [("not-json", "Expecting value"), ({}, "invalid certificate"),
                        ({**older, "job_ids": []}, "no scheduler jobs"),
                        (older, "partial certificate groups"),
                        ({**older, "snapshot": "0" * 64}, "stale certificate"),
                        ({**older, "inputs": {k: v for k, v in older["inputs"].items() if not k.endswith(".cfg")}},
                         "stale certificate")]:
    history(root, older, latest)
    refuses(lambda: readonly(lambda: portable_certificate(root)), message)
history(root, older)
cfg = sorted((root / "ci/cfg").glob("*.cfg"))[0]
original = cfg.read_bytes()
changed = bytearray(original)
changed[0] ^= 1
cfg.write_bytes(changed)
refuses(lambda: readonly(lambda: portable_certificate(root)), "SHA-256 mismatch: " + str(cfg.relative_to(root)))
cfg.write_bytes(original)
cfg.unlink()
refuses(lambda: readonly(lambda: portable_certificate(root)), "pin inventory mismatch")
cfg.write_bytes(original)
(root / "ci/cfg/unrecorded.cfg").write_text("SPECIFICATION Spec\n")
refuses(lambda: readonly(lambda: portable_certificate(root)), "pin inventory mismatch")
`))

  test('portable fixture binding succeeds after relocation without runtime files or any repository mutation', () => python(String.raw`
root = sandbox()
run, row, envelope = envelope_for(root, temporal=True)
_, metadata = contract.validate_envelope(root, run, row, envelope, worker)
fixture = {"schema": 3, "fixtureContainer": contract.storage.compact_envelopes([
    {**envelope, "jobId": "synthetic-job", "behaviorMetadata": {**metadata, "bugSteps": []}}])}
path = root / "synthetic-001.json"
path.write_bytes(contract.encoded(fixture))
checksum = runner.sha(path)
before = committed_state(SOURCE)
local_before = committed_state(root)
decoded, original = readonly(lambda: portable_fixture_file(path, checksum, root, run, row, "synthetic-job"))
assert original == envelope
assert decoded["raw"] == envelope["raw"]
relocated = SCRATCH / "elsewhere/spec/tla"
for name in run["inputs"]:
    target = relocated / name
    target.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(root / name, target)
relocated_path = relocated / path.name
shutil.copyfile(path, relocated_path)
assert readonly(lambda: portable_fixture_file(relocated_path, checksum, relocated, run, row, "synthetic-job")) == (decoded, envelope)
assert not (relocated / "ci/.runs").exists()
assert committed_state(SOURCE) == before
assert committed_state(root) == local_before
relocated_path.write_bytes(relocated_path.read_bytes() + b" ")
refuses(lambda: readonly(lambda: portable_fixture_file(relocated_path, checksum, relocated, run, row, "synthetic-job")),
        "committed fixture hash mismatch: synthetic-001.json")
binding = {"traceSummary": runner.trace_summary([envelope])}
runner.check_trace_inventory(binding, [original])
changed = {**original, "what": "changed after certification"}
refuses(lambda: runner.check_trace_inventory(binding, [changed]), "collected trace inventory changed")
for mutate, message in [(lambda e: e.update(jobId="other-job"), "fixture job binding mismatch"),
                        (lambda e: e.update(snapshot="old"), "schema/snapshot"),
                        (lambda e: e["hashes"].update(cfg="0" * 64), "source hashes mismatch"),
                        (lambda e: e["raw"]["counterexample"]["action"].pop(), "missing/unexpected lasso edge")]:
    changed = copy.deepcopy(decoded)
    mutate(changed)
    refuses(lambda: readonly(lambda: portable_fixture(relocated, run, row, changed, "synthetic-job")), message)
# The audit fence fails at the attempted operation, even if a future parser
# unexpectedly reaches for a lock, reconstruction or ignored runtime file.
for call in (lambda: (root / "forbidden-write").write_text("no"),
             lambda: (root / "ci/.runs/ignored").read_text(),
             lambda: runner.verify_certificate(root)):
    refuses(lambda: readonly(call), "portable gate")
assert not (root / "forbidden-write").exists()
assert not (root / "ci/.runs").exists()
`))
})

// Kept outside the synthetic filter: expected to fail while E1 is uncertified.
// Only committed artifacts travel with a checkout. The production CLI audit of
// ignored scheduler logs and absolute-path SANY evidence is a separate gate.
// The complete compact fixture set expands beyond 1 GiB and is checked twice.
// Keep its finite deadline separate from the small synthetic cases' 30s cap.
test('delivery committed evidence: latest PASS binds portable inputs and fixtures after checkout relocation without repository writes', () => python(String.raw`
before = committed_state(SOURCE)
try:
    record = readonly(lambda: portable_certificate(SOURCE))
    relocated = SCRATCH / "relocated-checkout/spec/tla"
    for name in [*record["inputs"], "ci/verdicts.txt"]:
        target = relocated / name
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(SOURCE / name, target)
    shutil.copytree(REPO / "tests/fixtures/delivery-traces",
                    relocated.parents[1] / "tests/fixtures/delivery-traces")
    assert not (relocated / "ci/.runs").exists()
    assert readonly(lambda: portable_certificate(relocated)) == record
    assert not (relocated / "ci/.runs").exists()
finally:
    assert committed_state(SOURCE) == before, "committed evidence/source state changed"
`, 600_000), 605_000)
