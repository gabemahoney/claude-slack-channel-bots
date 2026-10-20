/**
 * b.omv SR-15.6 / t3.j2a.di.th.4y: certification and trace handoff boundaries.
 * Synthetic cases use disposable inputs and an in-memory scheduler. They never
 * certify the repository. Committed local evidence has its own complete-run
 * and independent-proof gate; it never substitutes for scheduler certification.
 * E3 owns runtime replay and ENGINE_ACTIONS conformance.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { hostSafeChildEnv } from './test-helpers/host-safe-env.ts'

import { deliveryEvidencePython } from './test-helpers/delivery-model-evidence.ts'

const repo = join(import.meta.dir, '..')
const scratch: string[] = []
afterEach(() => {
  for (const path of scratch.splice(0)) rmSync(path, { recursive: true, force: true })
})

// Python is the implementation's language. Import its real modules with bytecode
// writes disabled, fence every external process/socket, and pass no ambient env.
// Only the scheduler and SANY seams are substituted in lifecycle cases: no Java,
// checker, scheduler executable, network, agent or production state is reachable.
const harness = deliveryEvidencePython

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

// Local TLC evidence deliberately has a separate gate from scheduler certification.
// Relocation retains every current input/fixture and never accesses ignored runs.
test('delivery committed local evidence binds current inputs and fixtures after checkout relocation without repository writes', () => python(String.raw`
before = committed_state(SOURCE)
try:
    local = load(REPO / "tests/test-helpers/delivery-local-evidence.py", "verdict_local_evidence")
    summary = readonly(local.validate)
    coverage = json.loads((REPO / "tests/fixtures/delivery-traces/coverage.json").read_text())
    assert coverage["certification"] is False
    relocated = SCRATCH / "relocated-checkout/spec/tla"
    for name in coverage["inputs"]:
        target = relocated / name
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(SOURCE / name, target)
    shutil.copytree(REPO / "tests/fixtures/delivery-traces",
                    relocated.parents[1] / "tests/fixtures/delivery-traces")
    local.SOURCE = relocated
    local.DESTINATION = relocated.parents[1] / "tests/fixtures/delivery-traces"
    assert not (relocated / "ci/.runs").exists()
    assert readonly(local.validate) == summary
    assert not (relocated / "ci/.runs").exists()
finally:
    assert committed_state(SOURCE) == before, "committed evidence/source state changed"
`, 600_000), 605_000)

test('local delivery evidence refuses incomplete rows, missing independent proofs and changed retained artifacts', () => python(String.raw`
local = load(REPO / "tests/test-helpers/delivery-local-evidence.py", "refusal_local_evidence")
coverage = json.loads((REPO / "tests/fixtures/delivery-traces/coverage.json").read_text())
rows = local.runner.load_manifest(local.SOURCE, False)
for mutate, message in [
    (lambda report: report.update(certification=True), "not a complete local report"),
    (lambda report: report.update(partial=True), "not a complete local report"),
    (lambda report: report.update(inputsUnchanged=False), "changed local inputs"),
    (lambda report: report.update(modelSha256="0" * 64), "stale local model"),
    (lambda report: report.pop("localLaunch"), "changed local launch provenance"),
    (lambda report: report["localLaunch"].update(sha256="0" * 64), "changed local launch provenance"),
    (lambda report: report["rows"].pop(), "incomplete local manifest"),
    (lambda report: report["auxiliaryRows"].pop(), "incomplete auxiliary manifest"),
    (lambda report: report["rows"][0].update(proofsRequested=False), "missing/failed local proof"),
    (lambda report: report["rows"][0].update(proofError="incomplete witness"), "missing/failed local proof"),
    (lambda report: report["rows"][0].update(matched=False), "unfinished local row"),
    (lambda report: report["auxiliaryRows"][0].update(timeout=True), "unfinished local row"),
    (lambda report: next(row for row in report["rows"] if row["mode"] == "simulate").update(temporalVerified=True), "overstated local temporal verdict"),
]:
    report = copy.deepcopy(coverage["report"])
    mutate(report)
    refuses(lambda: readonly(lambda: local.validate_report(report, rows)), message)

report = copy.deepcopy(coverage["report"])
launch = json.loads(report["localLaunch"]["raw"])
launch["rowSeconds"] -= 1
raw_launch = json.dumps(launch)
report["localLaunch"] = {"raw": raw_launch, "sha256": local.digest(raw_launch.encode())}
refuses(lambda: readonly(lambda: local.validate_report(report, rows)), "changed local launch budget or scope")

def fixture(cfg):
    name = cfg + "-001.json"
    return local.unpack(json.loads((local.DESTINATION / name).read_text()))

core = next(row for row in rows if row["cfg"] == "core_head_taken_in")
envelope = fixture(core["cfg"])
for mutate, message in [
    (lambda e: e.pop("acceptedWork"), "missing accepted-work evidence"),
    (lambda e: e["acceptedWork"]["artifacts"].pop("search/run.log"), "missing accepted-work artifacts"),
    (lambda e: e["acceptedWork"]["artifacts"]["java-launcher"].update(sha256="0" * 64), "changed accepted-work artifact"),
    (lambda e: e.pop("localRowBudgetSeconds"), "changed local row budget"),
    (lambda e: e.update(localRowBudgetSeconds=e["localRowBudgetSeconds"] - 1), "accepted-work row clock changed"),
]:
    changed = copy.deepcopy(envelope)
    mutate(changed)
    refuses(lambda: readonly(lambda: local.metadata(core, changed, coverage["inputs"])), message)

control = next(row for row in rows if row["cfg"] == "control_deferred_only_open")
envelope = fixture(control["cfg"])
for field, message in [("concreteCandidate", "missing separate concrete temporal candidate"),
                       ("candidateSource", "missing candidate source provenance"),
                       ("temporalSensitivity", "missing/stale temporal sensitivity evidence")]:
    changed = copy.deepcopy(envelope)
    changed.pop(field)
    refuses(lambda: readonly(lambda: local.metadata(control, changed, coverage["inputs"])), message)
changed = copy.deepcopy(envelope)
changed["localArtifacts"].pop("sensitivity/mutant/run.log")
refuses(lambda: readonly(lambda: local.validate_temporal_artifacts(control, changed)), "missing/extra temporal proof artifact")
changed = copy.deepcopy(envelope)
changed["localArtifacts"]["sensitivity/mutant/run.log"]["sha256"] = "0" * 64
refuses(lambda: readonly(lambda: local.validate_temporal_artifacts(control, changed)), "changed temporal artifact")

auxiliary = next(row for row in local.cardinal.auxiliary_rows(local.SOURCE) if row["cfg"] == "permission_eventually_delivered")
result = next(row for row in coverage["report"]["auxiliaryRows"] if row["cfg"] == auxiliary["cfg"])
evidence = copy.deepcopy(coverage["auxiliaryEvidence"][auxiliary["cfg"]])
evidence["traces"][0]["behavior"][0]["executedAction"] = "forged"
refuses(lambda: readonly(lambda: local.validate_auxiliary(auxiliary, result, evidence)), "changed auxiliary raw trace")

supplemental = local.unpack(json.loads((local.DESTINATION / local.SUPPLEMENTAL_NAME).read_text()))
changed = copy.deepcopy(supplemental)
changed["supplementalEvidence"]["artifacts"].pop("replay/ExactReplay.tla")
refuses(lambda: readonly(lambda: local.validate_supplemental(changed, coverage["inputs"])), "missing/extra supplemental artifact")

def replace_supplemental_artifact(envelope, name, content):
    evidence = envelope["supplementalEvidence"]
    checksum = local.digest(content)
    evidence["artifacts"][name] = {"sha256": checksum, "base64": base64.b64encode(content).decode()}
    evidence["payload"]["artifacts"][name] = checksum
    return checksum

changed = copy.deepcopy(supplemental)
name = "replay/ExactReplay.tla"
original = base64.b64decode(changed["supplementalEvidence"]["artifacts"][name]["base64"])
content = original.replace(b"Assert(Next,", b"Assert(TRUE,")
assert content != original
changed["supplementalEvidence"]["payload"]["replay"]["moduleSha256"] = replace_supplemental_artifact(changed, name, content)
refuses(lambda: readonly(lambda: local.validate_supplemental(changed, coverage["inputs"])), "changed supplemental checker inputs/log")

changed = copy.deepcopy(supplemental)
name = "replay/run.log"
original = base64.b64decode(changed["supplementalEvidence"]["artifacts"][name]["base64"])
content = original.replace(b"true", b"false", 1)
assert content != original
changed["supplementalEvidence"]["payload"]["replay"]["logSha256"] = replace_supplemental_artifact(changed, name, content)
refuses(lambda: readonly(lambda: local.validate_supplemental(changed, coverage["inputs"])), "missing original-Next supplemental replay proof")
`, 120_000), 125_000)
