"""Pure JSON-to-TLA replay regressions; never invoke SANY or TLC."""
from pathlib import Path
import re
import sys
import time
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import temporal_sensitivity as temporal
import work_witness


def expand(library, name):
    """Inline only the generated immutable aliases, without evaluating TLA."""
    definitions = dict(line.split(" == ", 1) for line in library.splitlines())

    def resolve(match):
        return re.sub(r"\bReplayValue\d+\b", resolve, definitions[match[0]])

    return re.sub(r"\bReplayValue\d+\b", resolve, name)


class ReplaySerializationTests(unittest.TestCase):
    def assert_serialized(self, value, expected):
        self.assertEqual(temporal.tla(value), expected)
        library, names = temporal.tla_values([value])
        self.assertEqual(expand(library, names[0]), expected)

    def test_empty_memory_sets(self):
        self.assert_serialized(
            {"p": {"held": [], "withdrawn": []}, "h": {"bypassed": []}},
            "[h |-> [bypassed |-> {}],p |-> [held |-> {},withdrawn |-> {}]]")

    def test_nonempty_memory_sets(self):
        self.assert_serialized(
            {"p": {"held": [2, 1], "withdrawn": [3]}},
            "[p |-> [held |-> {1,2},withdrawn |-> {3}]]")

    def test_bypassed_is_a_set_of_ordered_pairs(self):
        self.assert_serialized(
            {"bypassed": [[1, 2], [2, 1]]},
            "[bypassed |-> {<<1,2>>,<<2,1>>}]")

    def test_holds_is_a_set_of_records_in_knowledge(self):
        self.assert_serialized(
            {"knowledge": {"holds": [{"item": 1, "kind": "memory"}],
                           "p": {"held": [1], "withdrawn": []}}},
            '[knowledge |-> [holds |-> {[item |-> 1,kind |-> "memory"]},'
            'p |-> [held |-> {1},withdrawn |-> {}]]]')
        self.assert_serialized({"holds": []}, "[holds |-> {}]")

    def test_boolean_held_readings_stay_booleans(self):
        self.assert_serialized(
            {"a": {"held": True}, "knowledge": {"r": {"held": False}}},
            "[a |-> [held |-> TRUE],knowledge |-> [r |-> [held |-> FALSE]]]")

    def test_shared_values_keep_set_and_tuple_types_separate(self):
        value = {"accepted": [1, 2], "held": [1, 2], "target": [1, 2],
                 "bypassed": [], "records": [], "withdrawn": []}
        library, names = temporal.tla_values([value, value])
        self.assertEqual(names[0], names[1])
        # Empty tuples and sets, and equal nonempty arrays of both types, must
        # not share a ReplayValue even when other snapshots are interned.
        self.assertEqual(expand(library, names[0]),
                         "[accepted |-> {1,2},bypassed |-> {},held |-> {1,2},"
                         "records |-> <<>>,target |-> <<1,2>>,withdrawn |-> {}]")

    def test_duplicate_new_set_members_are_refused(self):
        for field, member in [("held", 1), ("withdrawn", 2),
                              ("bypassed", [1, 2]),
                              ("holds", {"item": 1, "kind": "memory"})]:
            for serialize in (temporal.tla, lambda value: temporal.tla_values([value])):
                with self.subTest(field=field, serialize=serialize):
                    with self.assertRaisesRegex(temporal.SensitivityRefusal,
                                                "duplicate member in state set"):
                        serialize({field: [member, member]})

    def test_both_proof_builders_preserve_nested_state_types(self):
        # A synthetic single-state lasso tests input generation only, not model
        # legality. Actual legality/fairness remains a scheduler TLC gate.
        state = {"p": {"held": [], "withdrawn": []},
                 "h": {"bypassed": [[1, 2]]}, "a": {"held": False},
                 "knowledge": {"holds": [], "r": {"held": True}}}
        record = {"state": state}
        node = [1, record]
        raw = {"behavior": [record],
               "counterexample": {"state": [node], "action": [[node, {}, node]]}}
        cfg = (Path(__file__).resolve().parents[1] / "cfg/control_keep_gate.cfg").read_text()
        modules = [temporal.replay_inputs(cfg, raw)[0],
                   temporal.replay_inputs(cfg, raw, correct_cycle=True)[0],
                   work_witness.replay_inputs("CONSTANTS\n", raw, time.monotonic() + 60)[0]]
        expected = "<<[a |-> [held |-> FALSE],h |-> [bypassed |-> {<<1,2>>}]," \
                   "knowledge |-> [holds |-> {},r |-> [held |-> TRUE]]," \
                   "p |-> [held |-> {},withdrawn |-> {}]]>>"
        for module in modules:
            with self.subTest(module=module.splitlines()[0]):
                library = "\n".join(line for line in module.splitlines()
                                    if re.match(r"ReplayValue\d+ == ", line))
                states = re.search(r"(?m)^ReplayStates == (ReplayValue\d+)$", module)[1]
                self.assertEqual(expand(library, states), expected)


if __name__ == "__main__":
    unittest.main()
