"""Pure unit checks. All constructed logs/states below are synthetic, not TLC evidence."""
import contextlib
import copy
import importlib.util
import io
import json
from pathlib import Path
import subprocess
import sys
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "ci"))
import reconnect_coverage as reconnect
import runner


def load(path, name):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def synthetic_raw():
    behavior = []
    for i, (transition, action, observation) in enumerate([
            ("Init", "none", "none"), ("EngineObserve", "observe", "ready"),
            ("EngineStep", "observeLaunch", "none"), ("EngineObserve", "observe", "ready"),
            ("EngineStep", "deferReconnect", "none")]):
        state = dict(observation=observation, g=dict(deferred=True, due=True, owner="free"),
                     a=dict(mcp=False), knowledge=dict(r=dict(mcp=False, relaunch=False)),
                     p=dict(accepted=[]), w=dict(kind="none"), faults=dict(mcpDrop=0), syntheticPosition=i)
        behavior.append(dict(state=state, transition=transition, executedAction=action,
                             control=dict(bug="none", **{"class": "correct"}, bugStep=False),
                             constants=dict(synthetic=True), EngineChoice="deferReconnect", outcome="rerun-due"))
    nodes = [[i, record] for i, record in enumerate(behavior, 1)]
    return dict(schema=1, behavior=behavior, counterexample=dict(state=nodes,
                action=[[a, "synthetic-action", b] for a, b in zip(nodes, nodes[1:])]))


def synthetic_bundle():
    raw = synthetic_raw()
    inputs = {str(p.relative_to(ROOT)): reconnect.sha(p.read_bytes()) for p in runner.input_paths(ROOT)}
    artifacts = {"input.cfg": (ROOT / reconnect.CFG).read_bytes(),
                 "reconnect_coverage.py": (ROOT / reconnect.SELF).read_bytes(),
                 "temporal_sensitivity.py": (ROOT / "ci/temporal_sensitivity.py").read_bytes(),
                 "raw-trace.json": reconnect.canonical(raw)}
    payload = dict(schema=1, kind="supplemental-reconnect-prefix", scope=reconnect.SCOPE,
                   inputs=inputs, raw=raw, summary=reconnect.check_behavior(raw),
                   binding=dict(jarSha256=inputs["tla2tools.jar"], javaSha256="0" * 64,
                                guideSha256=reconnect.sha(reconnect.GUIDE.encode())))
    text = artifacts["input.cfg"].decode()
    for kind, (module, cfg) in dict(search=reconnect.search_inputs(text),
                                    replay=reconnect.replay_inputs(ROOT, text, raw)).items():
        filename = "ReconnectCoverage.tla" if kind == "search" else "ReconnectReplay.tla"
        cfgname = "witness.cfg" if kind == "search" else "replay.cfg"
        log = ("Error: Invariant NoDeferReconnect is violated.\nError: The behavior up to this point is:\nTRACE "
               + json.dumps(raw) + "\n") if kind == "search" else (
                   "Model checking completed. No error has been found.\n" +
                   "\n".join("RECONNECT_STATE " + json.dumps(dict(position=i, initial=True, recordMatches=True)) for i in range(1, 6)) + "\n" +
                   "\n".join("RECONNECT_EDGE " + json.dumps(dict(position=i, legal=True)) for i in range(1, 5)) + "\n")
        log += "Finished in 0s\n"
        artifacts.update({kind + "/PersonaDelivery.tla": (ROOT / "PersonaDelivery.tla").read_bytes(),
                          kind + "/" + filename: module.encode(), kind + "/" + cfgname: cfg.encode(),
                          kind + "/run.log": log.encode()})
        payload[kind] = dict(moduleSha256=reconnect.sha(module.encode()), cfgSha256=reconnect.sha(cfg.encode()),
                             logSha256=reconnect.sha(log.encode()), timeout=False, seconds=0.1,
                             argv=["synthetic-no-execution", "-config", cfgname, filename], exitCode=12 if kind == "search" else 0)
    payload["artifacts"] = {name: reconnect.sha(value) for name, value in artifacts.items()}
    return payload, artifacts, inputs


class ReconnectCoverageTests(unittest.TestCase):
    def test_finite_inputs_preserve_constants_safety_and_original_edges(self):
        cfg = (ROOT / reconnect.CFG).read_text()
        constants, invariants = reconnect.cfg_parts(cfg)
        search, derived = reconnect.search_inputs(cfg)
        replay, replay_cfg = reconnect.replay_inputs(ROOT, cfg, synthetic_raw())
        self.assertIn(constants + invariants, derived)
        self.assertIn(constants + invariants, replay_cfg)
        self.assertIn("INIT Init\nNEXT GuidedNext", derived)
        self.assertIn("GuidedNext == Guide /\\ Next", search)
        self.assertIn("(position = 1 => Init)", replay)
        self.assertIn('Assert(Next, "reconnect coverage has an illegal original Next edge")', replay)
        for text in (derived, replay_cfg):
            self.assertNotIn("PROPERTY ", text)  # Explicit finite scope, never a liveness proof.
            self.assertNotIn("VIEW ", text)
            self.assertNotIn("CONSTRAINT ", text)

    def test_synthetic_verifier_contract_without_processes(self):
        payload, artifacts, inputs = synthetic_bundle()
        with patch.object(subprocess, "run", side_effect=AssertionError("offline verification started a process")):
            self.assertEqual(reconnect.verify(ROOT, payload, artifacts, inputs)["deferReconnectPositions"], [5])

    def test_decision_without_execution_and_stutter_are_rejected(self):
        for mutation in (lambda r: r["behavior"][-1].update(executedAction="wait"),
                         lambda r: r["behavior"][-1].update(state=copy.deepcopy(r["behavior"][-2]["state"])),
                         lambda r: r["behavior"][-2]["state"]["knowledge"]["r"].update(relaunch=True),
                         lambda r: r["counterexample"]["action"].pop()):
            raw = synthetic_raw()
            mutation(raw)
            with self.assertRaises(ValueError):
                reconnect.check_behavior(raw)

    def test_rehashed_bad_proof_flags_and_scope_fail_closed(self):
        for mutate in (lambda p: p["search"].update(exitCode=0),
                       lambda p: p["replay"].update(exitCode=12),
                       lambda p: p["replay"].update(timeout=True),
                       lambda p: p["replay"].update(seconds=61),
                       lambda p: p["replay"].update(seconds=float("nan")),
                       lambda p: p.update(scope="universal progress"),
                       lambda p: p["inputs"].update(unbound="0" * 64)):
            payload, artifacts, inputs = synthetic_bundle()
            payload = copy.deepcopy(payload)
            mutate(payload)
            with self.assertRaises(ValueError):
                reconnect.verify(ROOT, payload, artifacts, inputs)

    def test_rehashed_false_missing_and_nonboolean_original_proofs_rejected(self):
        for old, new in ((b'"legal": true', b'"legal": false'),
                         (b'"legal": true', b'"legal": 1'),
                         (b'"initial": true', b'"initial": false'),
                         (b'"recordMatches": true', b'"recordMatches": false'),
                         (b'RECONNECT_EDGE ', b'OMITTED_EDGE '),
                         (b'Finished in', b'Unfinished')):
            payload, artifacts, inputs = synthetic_bundle()
            log = artifacts["replay/run.log"].replace(old, new, 1)
            artifacts["replay/run.log"] = log
            payload["artifacts"]["replay/run.log"] = payload["replay"]["logSha256"] = reconnect.sha(log)
            with self.subTest(old=old, new=new), self.assertRaises(ValueError):
                reconnect.verify(ROOT, payload, artifacts, inputs)

    def test_changed_source_or_generated_inputs_rejected(self):
        for name in ("input.cfg", "search/PersonaDelivery.tla", "search/ReconnectCoverage.tla",
                     "replay/replay.cfg", "raw-trace.json", "reconnect_coverage.py"):
            payload, artifacts, inputs = synthetic_bundle()
            artifacts[name] += b"\n"
            payload["artifacts"][name] = reconnect.sha(artifacts[name])
            with self.subTest(name=name), self.assertRaises(ValueError):
                reconnect.verify(ROOT, payload, artifacts, inputs)

    def test_host_generation_refused_before_process_or_write(self):
        with patch.dict(reconnect.os.environ, {}, clear=True), \
             patch.object(subprocess, "run", side_effect=AssertionError("host checker")), \
             patch.object(Path, "mkdir", side_effect=AssertionError("host write")):
            with self.assertRaisesRegex(ValueError, "scheduler container"):
                reconnect.generate(ROOT, Path("/unused"), Path("/unused-java"))

    def test_summary_counts_only_executed_unequal_state_correct_edges(self):
        local = load(ROOT.parents[1] / "tests/test-helpers/delivery-local-evidence.py", "reconnect_local_test")
        for mutate, present in ((lambda r: None, True),
                               (lambda r: r["behavior"][-1].update(executedAction="wait"), False),
                               (lambda r: r["behavior"][-1].update(state=copy.deepcopy(r["behavior"][-2]["state"])), False),
                               (lambda r: r["behavior"][-1]["control"].update({"class": "choice"}), False)):
            raw = synthetic_raw()
            mutate(raw)
            summary = local.new_summary()
            summary["expectedFaults"] = set()
            local.summary_add(summary, {"cfg": "synthetic-unit-test"}, raw)
            self.assertEqual("deferReconnect" in summary["actions"], present)
            stream = io.StringIO()
            with contextlib.redirect_stdout(stream), self.assertRaisesRegex(ValueError, "missing executed coverage"):
                local.finish_summary(summary, diagnostics=True)
            event = json.loads(stream.getvalue())
            self.assertEqual("deferReconnect" in event["actions"]["executed"], present)
            if present:
                self.assertEqual(event["actionSources"]["deferReconnect"][0]["position"], 5)

    def test_offline_validation_summary_preserves_single_json_stdout_contract(self):
        local = load(ROOT.parents[1] / "tests/test-helpers/delivery-local-evidence.py", "reconnect_quiet_test")
        summary = local.new_summary()
        for actual, expected in (("actions", "expectedActions"), ("faults", "expectedFaults"), ("flaps", "expectedFlaps")):
            summary[actual] = summary[expected].copy()
        summary["controls"] = set(local.runner.ALL_CONTROLS)
        stream = io.StringIO()
        with contextlib.redirect_stdout(stream):
            result = local.finish_summary(summary)
        self.assertEqual(stream.getvalue(), "")
        self.assertNotIn("_actionSources", result)


if __name__ == "__main__":
    unittest.main()
