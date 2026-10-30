"""Pure synthetic verifier regressions; these do not establish model legality."""
from pathlib import Path
import json
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import temporal_sensitivity as temporal

ROOT = Path(__file__).resolve().parents[2]
ROW = dict(cfg="control_no_head_takein_assumption",
           cfg_path="ci/cfg/control_no_head_takein_assumption.cfg",
           spec_path="PersonaDelivery.tla", props="HeadTakenIn",
           properties=["HeadTakenIn"], expect="violation")


def fixture(*, permissions=(False, True), taken=False, fault=False, legal=True,
            witness=True, fair=True):
    behavior = [{"constants": {"Scenario": "control-no-assumption"},
                 "state": {"h": {"taken": [[1, 1]] if taken else []},
                           "a": {"permission": permission},
                           "faults": {"textRefused": int(fault)}}}
                for permission in permissions]
    nodes = [[i, r] for i, r in enumerate(behavior, 1)]
    raw = dict(behavior=behavior, counterexample=dict(state=nodes,
        action=[[nodes[i], {}, nodes[(i+1) % 2]] for i in range(2)]))
    module, cfg, _, _ = temporal.replay_inputs((ROOT / ROW["cfg_path"]).read_text(), raw)
    logs = []
    for pos in (1, 2):
        enabled = {key: False for key in temporal.FAIR_ACTIONS}
        fired = enabled.copy()
        enabled["engine"] = not fair
        logs.append("SENSITIVITY_STATE " + json.dumps(dict(position=pos, enabled=enabled,
            constrained=True, typable=pos == 1, recordMatches=True,
            engineChoice="wait", gateChoice="wait")))
        logs.append("SENSITIVITY_EDGE " + json.dumps(dict(position=pos, legal=legal, fired=fired)))
    logs.extend(["Error: Temporal property NotWitness was violated.",
                 "Error: The following behavior constitutes a counter-example:"] if witness else
                ["Model checking completed. No error has been found."])
    log = "\n".join(logs + ["Finished in 00s"])
    evidence = dict(binding=temporal.bindings(ROOT, ROW, raw), mutant=dict(
        moduleSha256=temporal.sha(module.encode()), cfgSha256=temporal.sha(cfg.encode()),
        log=log, logSha256=temporal.sha(log.encode()), exitCode=13 if witness else 0))
    return raw, evidence


class PermissionStarvationTests(unittest.TestCase):
    def test_original_permission_context_accepts(self):
        raw, evidence = fixture()
        self.assertEqual(temporal.validate_evidence(ROOT, ROW, raw, evidence)["kind"],
                         "environment-assumption")

    def test_irrelevant_permission_or_takein_context_still_refused(self):
        for flags in ({"permissions": (False, False)}, {"permissions": (True, True)},
                      {"taken": True}, {"fault": True}):
            with self.subTest(flags=flags):
                raw, evidence = fixture(**flags)
                with self.assertRaisesRegex(temporal.SensitivityRefusal, "permission-starvation"):
                    temporal.validate_evidence(ROOT, ROW, raw, evidence)

    def test_illegal_or_nontarget_candidate_still_refused(self):
        for flags in ({"legal": False}, {"witness": False}):
            with self.subTest(flags=flags):
                raw, evidence = fixture(**flags)
                with self.assertRaisesRegex(temporal.SensitivityRefusal, "authentic complete"):
                    temporal.validate_evidence(ROOT, ROW, raw, evidence)

    def test_original_fairness_still_required(self):
        raw, evidence = fixture(fair=False)
        with self.assertRaisesRegex(temporal.SensitivityRefusal, "original action fairness"):
            temporal.validate_evidence(ROOT, ROW, raw, evidence)

    def test_search_is_independent_of_projected_lasso(self):
        text = (ROOT / ROW["cfg_path"]).read_text()
        kind, (module, cfg) = temporal.candidate_search_inputs(text, {})
        self.assertEqual((kind, (module, cfg)), temporal.candidate_search_inputs(text, {"unrelated": True}))
        self.assertEqual(kind, "independent-targeted-guide")
        self.assertIn("CandidateNext == Next /\\ PermissionStarvationGuide", module)
        self.assertIn("CandidateSpec == Init /\\ [][CandidateNext]_vars", module)
        self.assertIn("Fairness /\\ []RestartStateConstraint /\\ ~HeadTakenIn", module)
        self.assertIn(temporal.cfg_context(text)[3], cfg)
        self.assertIn("CONSTRAINT RestartStateConstraint", cfg)
        self.assertNotIn("TypableHeadTakeInAssumption", module)
        self.assertNotIn("VIEW", cfg)

    def test_no_permission_guide_for_production_spec_or_wrong_scenario(self):
        text = (ROOT / ROW["cfg_path"]).read_text()
        for changed in (text.replace("SpecWithoutHeadTakeInAssumption", "Spec"),
                        text.replace('"control-no-assumption"', '"control"')):
            with self.subTest(changed=changed):
                with self.assertRaisesRegex(temporal.SensitivityRefusal, "unsupported permission"):
                    temporal.permission_starvation_candidate_inputs(changed)

    def test_concrete_search_provenance_cannot_be_relabelled(self):
        raw, _ = fixture()
        envelope = {"raw": raw, "concreteCandidate": raw, "candidateSource": {"kind": "view-label-search"}}
        with self.assertRaisesRegex(temporal.SensitivityRefusal, "source provenance"):
            temporal.validate_candidate_source(ROOT, ROW, envelope)


if __name__ == "__main__":
    unittest.main()
