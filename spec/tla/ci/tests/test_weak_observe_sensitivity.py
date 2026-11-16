"""Synthetic proof-parser regressions only; never invoke SANY or TLC."""
from pathlib import Path
import json
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import temporal_sensitivity as temporal

ROOT = Path(__file__).resolve().parents[2]
ROW = dict(cfg="control_weak_observe", cfg_path="ci/cfg/control_weak_observe.cfg",
           spec_path="PersonaDelivery.tla", props="EventuallyDelivered",
           properties=["EventuallyDelivered"], expect="violation")


def fixture(observe_fires=False, illegal=False, other_unfair=False):
    # These are deliberately synthetic records and checker output. The tests
    # exercise causal verdict validation, not original-action model legality.
    behavior = [{"state": {"bug": "weak_observe", "ordinal": i}} for i in range(1, 4)]
    nodes = [[i, r] for i, r in enumerate(behavior, 1)]
    raw = dict(behavior=behavior, counterexample=dict(state=nodes,
        action=[[nodes[i], {}, nodes[(i + 1) % 3]] for i in range(3)]))
    cfg_text = (ROOT / ROW["cfg_path"]).read_text()
    evidence = {"binding": temporal.bindings(ROOT, ROW, raw)}
    for name, correct in [("mutant", False), ("correctCycle", True)]:
        module, cfg, _, _ = temporal.replay_inputs(cfg_text, raw, correct_cycle=correct)
        logs = []
        for pos in range(1, 4):
            enabled = {k: False for k in temporal.FAIR_ACTIONS}
            fired = enabled.copy()
            enabled["observe"] = pos == 1
            fired["observe"] = observe_fires and pos == 1
            if other_unfair:
                enabled["engine"] = True
            logs.append("SENSITIVITY_STATE " + json.dumps(dict(position=pos, enabled=enabled,
                constrained=True, typable=pos == 1, recordMatches=True,
                engineChoice="wait", gateChoice="wait")))
            logs.append("SENSITIVITY_EDGE " + json.dumps(dict(position=pos,
                legal=not (correct and illegal and pos == 2), fired=fired)))
        witness = not correct or observe_fires
        logs.extend(["Error: Temporal property NotWitness was violated.",
                     "Error: The following behavior constitutes a counter-example:"] if witness
                    else ["Model checking completed. No error has been found."])
        logs.append("Finished in 00s")
        log = "\n".join(logs)
        evidence[name] = dict(moduleSha256=temporal.sha(module.encode()),
                             cfgSha256=temporal.sha(cfg.encode()), log=log,
                             logSha256=temporal.sha(log.encode()), exitCode=13 if witness else 0)
    return raw, evidence


class WeakObserveSensitivityTests(unittest.TestCase):
    def test_fair_correct_cycle_remains_refused(self):
        raw, evidence = fixture(observe_fires=True)
        with self.assertRaisesRegex(temporal.SensitivityRefusal, "legal fair target violation under Bug=none"):
            temporal.validate_evidence(ROOT, ROW, raw, evidence)

    def test_only_observation_fairness_discriminates(self):
        raw, evidence = fixture()
        result = temporal.validate_evidence(ROOT, ROW, raw, evidence)
        self.assertEqual(result["kind"], "fairness")
        self.assertEqual(result["omissionStates"], [1])
        self.assertEqual(result["correctCycleIllegalEdges"], [])
        self.assertEqual(result["correctCycleUnfairActions"], ["observe"])

    def test_illegal_edge_cannot_substitute_for_fairness_contrast(self):
        raw, evidence = fixture(illegal=True)
        with self.assertRaisesRegex(temporal.SensitivityRefusal, "WF/SF sensitivity contrast"):
            temporal.validate_evidence(ROOT, ROW, raw, evidence)

    def test_other_fairness_cannot_be_sacrificed(self):
        raw, evidence = fixture(other_unfair=True)
        with self.assertRaisesRegex(temporal.SensitivityRefusal, "original action fairness failed"):
            temporal.validate_evidence(ROOT, ROW, raw, evidence)

    def test_guide_retains_original_relation_target_and_bound(self):
        cfg_text = (ROOT / ROW["cfg_path"]).read_text()
        kind, (module, cfg) = temporal.candidate_search_inputs(cfg_text, {})
        self.assertEqual(kind, "independent-targeted-guide")
        self.assertIn("CandidateNext == Next /\\ TargetedMutationWitnessGuide", module)
        self.assertIn("Fairness /\\ []RestartStateConstraint /\\ ~EventuallyDelivered", module)
        self.assertNotIn("TypableHeadTakeInAssumption", module)
        self.assertIn(temporal.cfg_context(cfg_text)[3], cfg)
        self.assertIn("CONSTRAINT RestartStateConstraint", cfg)

    def test_separate_correct_environment_contrast_still_required(self):
        raw, evidence = fixture()
        with self.assertRaisesRegex(temporal.SensitivityRefusal, "same exogenous schedule"):
            temporal.validate_evidence(ROOT, ROW, raw, evidence, require_contrast=True)


if __name__ == "__main__":
    unittest.main()
