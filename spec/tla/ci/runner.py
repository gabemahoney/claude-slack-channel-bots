"""Local SANY preflight and notice-driven scheduler-only TLC execution.

start submits one job and exits. resume accepts the exact completed job ID from
an owner-forwarded notice, collects results ONCE and submits at most one successor.
collect saves evidence only; advance explicitly submits the next group (or finishes).
retire preserves a collected partial run as superseded without certification.
There is no status call, log-follow loop, wait, interrupt-time query or retry.
The injected scheduler argument is the fake-scheduler seam for targeted tests;
the command-line path requires the caller's absolute executable TLA_JOBSCHED.
"""
from __future__ import annotations

import argparse
from contextlib import contextmanager
from datetime import datetime, timezone
import fcntl
import hashlib
import importlib.util
import json
import math
import os
from pathlib import Path
import re
import shlex
import shutil
import subprocess
import sys
import uuid

_STORAGE_SPEC = importlib.util.spec_from_file_location("runner_storage", Path(__file__).with_name("local_storage.py"))
storage = importlib.util.module_from_spec(_STORAGE_SPEC)
_STORAGE_SPEC.loader.exec_module(storage)

ROOT = Path(__file__).resolve().parents[1]
JAR_SHA256 = "32d64fbbc464559fc7192341b27b885fa4eb6b92d1648d2b49fb9cdcb7aacf81"
MAX_BUDGET = 14100
LIMIT_MARGIN_S = 300
MIN_MEMORY = 24 * 1024**3
SAFETY = {"DurableAccept", "NoDrop", "ReceiptBacked", "InOrder", "TranscriptFIFO",
          "OneInFlight", "NoTypeIntoText", "NoRetypeWhileWorking", "GateExclusive", "NoDuplicateKey"}
LIVENESS = {"EventuallyDelivered", "HeadTakenIn", "ReconnectNotBlocked", "GateFreeInfinitelyOften"}
CORE = {"NoDrop", "InOrder", "OneInFlight", "DurableAccept", "ReceiptBacked", "HeadTakenIn"}
ORIGINAL_POSITIVES = {prefix + suffix for prefix in ("safety_", "live_") for suffix in
                      ("plain", "calls", "enter_unknown", "agent_input", "bot_resume", "bot_sessions",
                       "storage", "screen", "connection", "persona")}
ORIGINAL_POSITIVES |= {"safety_identical", "live_empty_reconnect"}
# These eight original simulations retain their exact sampling contract.
TRACE_SIMULATIONS = {"trace_" + name: {"num": 8, "depth": 256, "seed": 104729 + i * 1009}
                     for i, name in enumerate(("calls", "agent", "lifecycle", "storage", "screen", "flapping", "identical"))}
# Stable cfg inventory makes omission of a control a preflight error.
CONTROLS = {
    "control_next_item": "OneInFlight", "control_next_part": "OneInFlight",
    "control_send_is_delivery": "ReceiptBacked", "control_queue_is_receipt": "TranscriptFIFO",
    "control_start_drop": "NoDrop", "control_compact_open": "NoDrop",
    "control_early_ack": "DurableAccept", "control_skip_refused": "InOrder",
    "control_start_unsent_head": "InOrder", "control_retype_into_text": "NoTypeIntoText",
    "control_retype_working": "NoRetypeWhileWorking", "control_reconnect_keys": "GateExclusive",
    "control_keep_gate": "GateFreeInfinitelyOften",
    "control_hold_gate_mcp_reconnect": "ReconnectNotBlocked",
    "control_hold_gate_mcp_delivery": "EventuallyDelivered",
    "control_no_deferred": "ReconnectNotBlocked", "control_reconnect_running": "NoTypeIntoText",
    "control_deferred_only_open": "ReconnectNotBlocked", "control_park_retype": "EventuallyDelivered",
    "control_unreadable_park": "HeadTakenIn", "control_weak_observe": "EventuallyDelivered",
    "control_replace_observation": "EventuallyDelivered", "control_duplicate_key": "NoDuplicateKey",
    "control_no_head_takein_assumption": "HeadTakenIn",
}
WITNESS_WHAT = ("witness: duplicates are allowed (at-least-once); this row must keep failing; "
                "never move AtMostOnce into a pass row")
# b.omv SR-15.5: independent exhaustive cases avoid the four-fault Cartesian
# product. Numeric FIFO items (and the first item's two parts) are not symmetric.
RESTART_CASES = {
    "restart_order": ("restart-pre", "serverCrash", 1, 2),
    "restart_order_across": ("restart-across", "serverCrash", 1, 2),
    "restart_order_bot": ("restart-bot", "botRestart", 2, 2),
    "restart_order_enter": ("restart-enter", "lostEnter", 1, 1),
    "restart_order_busy": ("restart-busy", "busyWaiting", 1, 1),
}
# Companion cases reuse every invariant-targeting original mutant. Temporal
# controls remain raw: a safety projection is not a liveness quotient.
RESTART_MUTATIONS = {
    "restart_control_" + cfg.removeprefix("control_"): {
        "original": cfg, "bug": cfg.removeprefix("control_"), "target": target,
        "faults": faults, "retypes": retypes,
    }
    for cfg, target, faults, retypes in (
        ("control_next_item", "OneInFlight", (), 1),
        ("control_next_part", "OneInFlight", (), 1),
        ("control_send_is_delivery", "ReceiptBacked", (), 1),
        ("control_queue_is_receipt", "TranscriptFIFO", ("busyWaiting",), 1),
        ("control_start_drop", "NoDrop", ("serverCrash",), 2),
        ("control_compact_open", "NoDrop", (), 1),
        ("control_early_ack", "DurableAccept", (), 1),
        ("control_skip_refused", "InOrder", ("textRefused",), 1),
        ("control_start_unsent_head", "InOrder", ("serverCrash",), 2),
        ("control_retype_into_text", "NoTypeIntoText", ("enterRefused", "enterUnknown", "lostEnter", "busyWaiting", "pullBack"), 2),
        ("control_retype_working", "NoRetypeWhileWorking", ("busyWaiting",), 1),
        ("control_reconnect_keys", "GateExclusive", ("mcpDrop",), 1),
        ("control_reconnect_running", "NoTypeIntoText", ("busyWaiting", "mcpDrop"), 1),
        ("control_duplicate_key", "NoDuplicateKey", ("serverCrash",), 2),
    )
}
ALL_CONTROLS = {**CONTROLS, **{cfg: item["target"] for cfg, item in RESTART_MUTATIONS.items()}}
RESTART_SIMULATION = "restart_order_simulation"
RESTART_SIMULATION_PARAMETERS = {"num": 8, "depth": 256, "seed": 111792}
RESTART_REDUCTION = {"view": "RestartSafetyView", "constraint": "RestartStateConstraint",
                     "maxSentRecordsPerPair": 2, "binaryTimers": True,
                     "inactiveFaultCounters": 0}
CORE_REDUCTION = {**RESTART_REDUCTION, "view": None,
                  "bounds": {"MaxItems": 1, "MaxParts": 1, "MaxAgentQueue": 2}}
# The original four-Enter-retry mutation needs six durable sends. Its authorized
# projection preserves that path without adopting the companions' state bound.
VIEW_ONLY_CONTROL = "control_retype_into_text"
VIEW_ONLY_REDUCTION = {"view": "RestartSafetyView", "constraint": None}
CFG_KEYWORDS = set("CONSTANT CONSTANTS CONSTRAINT CONSTRAINTS ACTION_CONSTRAINT ACTION_CONSTRAINTS "
                   "INIT NEXT SPECIFICATION VIEW SYMMETRY ALIAS POSTCONDITION CHECK_DEADLOCK "
                   "INVARIANT INVARIANTS PROPERTY PROPERTIES".split())


def restart_reduction(cfg: str | dict) -> dict | None:
    name = cfg.get("cfg") if isinstance(cfg, dict) else cfg
    reduction = (CORE_REDUCTION if name == "core_head_taken_in" else
                 VIEW_ONLY_REDUCTION if name == VIEW_ONLY_CONTROL else RESTART_REDUCTION)
    return dict(reduction) if reduced_cfg(cfg) else None


def reduced_cfg(cfg: str | dict) -> bool:
    if isinstance(cfg, dict):
        if cfg.get("cfg") == "core_head_taken_in":
            return cfg.get("state_reduction") == CORE_REDUCTION
        if cfg.get("cfg") == VIEW_ONLY_CONTROL:
            return cfg.get("state_reduction") == VIEW_ONLY_REDUCTION
        return cfg.get("state_reduction") == RESTART_REDUCTION
    return (cfg in RESTART_CASES or cfg in RESTART_MUTATIONS
            or cfg.startswith(("safety_", "live_", "core_"))
            or (cfg in CONTROLS and CONTROLS[cfg] in LIVENESS)
            or cfg in {"probe_premise", "witness_duplicates", VIEW_ONLY_CONTROL})


def validate_shared_cfg(cfg: str, content: str, mode: str = "check") -> None:
    tokens = cfg_tokens(content)
    if cfg == "core_head_taken_in":
        expected = {"MaxItems": "1", "MaxParts": "1", "MaxLaunches": "1",
                    "MaxServerStarts": "2", "MaxRetypes": "1", "EnterRetries": "4",
                    "MaxAgentQueue": "2", "Faults": "{}", "PromptFlapping": "TRUE",
                    "Flapping": "FALSE", "Bug": '"none"', "Scenario": '"probe"',
                    "IdenticalTexts": "FALSE"}
        require(mode == "check" and tokens.count("CONSTANTS") == 1,
                "core must retain its exact exhaustive bound contract")
        start = tokens.index("CONSTANTS") + 1
        end = start
        while end < len(tokens) and tokens[end] not in CFG_KEYWORDS:
            end += 1
        require(tokens[start:end] == cfg_tokens(" ".join(
            name + " = " + value for name, value in expected.items())),
            "core must retain its exact nonempty bounds and environment")
    if cfg.startswith(("core_", "live_")) and checks_of(content)["PROPERTY"]:
        require(not set(tokens) & {"VIEW", "SYMMETRY"},
                "positive temporal checking cannot use VIEW or SYMMETRY")
    if cfg == VIEW_ONLY_CONTROL:
        # This exact original case is the only VIEW-only exception. Pin its
        # existing constants and execution/trace contract, not a generic mode.
        expected = '''SPECIFICATION SpecWithoutHeadTakeInAssumption
CONSTANTS
  MaxItems = 2
  MaxParts = 2
  MaxLaunches = 3
  MaxServerStarts = 3
  MaxRetypes = 1
  EnterRetries = 4
  MaxAgentQueue = 4
  Faults = {"enterRefused", "enterUnknown", "lostEnter"}
  PromptFlapping = FALSE
  Flapping = FALSE
  Bug = "retype_into_text"
  Scenario = "control"
  IdenticalTexts = FALSE
INVARIANT NoTypeIntoText
VIEW RestartSafetyView
ALIAS TraceView
POSTCONDITION EmitTrace'''
        require(mode == "check" and tokens == cfg_tokens(expected),
                "original retype control must retain its exact VIEW-only contract")
        return
    if reduced_cfg(cfg) or mode == "simulate":
        require(not set(tokens) & {"SYMMETRY", "INIT", "NEXT", "CHECK_DEADLOCK"},
                "normal execution/deadlock checks are required, including raw simulations")
    if (mode == "simulate" and cfg not in RESTART_MUTATIONS and cfg not in CONTROLS
            and not set(tokens) & {"VIEW", "CONSTRAINT", "CONSTRAINTS", "ACTION_CONSTRAINT", "ACTION_CONSTRAINTS"}):
        return
    if not reduced_cfg(cfg):
        require(not set(tokens) & {"VIEW", "CONSTRAINT", "CONSTRAINTS", "ACTION_CONSTRAINT", "ACTION_CONSTRAINTS"},
                "raw control/simulation cannot acquire a reduction")
        return
    require(not set(tokens) & {"SYMMETRY", "CONSTRAINTS", "ACTION_CONSTRAINT", "ACTION_CONSTRAINTS",
                               "INIT", "NEXT", "CHECK_DEADLOCK"},
            "only shared state reduction with normal execution/deadlock checks is allowed")
    reduction = restart_reduction(cfg)
    for directive, operator in (("VIEW", reduction["view"]), ("CONSTRAINT", reduction["constraint"])):
        if operator is None:
            require(directive not in tokens, f"unexpected shared {directive}: {cfg}")
            continue
        require(tokens.count(directive) == 1, f"missing/duplicate shared {directive}: {cfg}")
        start = tokens.index(directive) + 1
        end = start
        while end < len(tokens) and tokens[end] not in CFG_KEYWORDS:
            end += 1
        require(tokens[start:end] == [operator], f"wrong/extra shared {directive}: {cfg}")


def validate_restart_cfg(cfg: str, content: str, mode: str = "check") -> None:
    if cfg not in RESTART_CASES and cfg not in RESTART_MUTATIONS and cfg != RESTART_SIMULATION:
        return
    tokens = cfg_tokens(content)
    require("SYMMETRY" not in tokens,
            "restart FIFO cases cannot quotient ordered item identities")
    raw_simulation = (cfg in RESTART_CASES and mode == "simulate"
                      and not set(tokens) & {"VIEW", "CONSTRAINT", "CONSTRAINTS", "ACTION_CONSTRAINT", "ACTION_CONSTRAINTS"})
    if (cfg in RESTART_CASES or cfg in RESTART_MUTATIONS) and not raw_simulation:
        require(not set(tokens) & {"CONSTRAINTS", "ACTION_CONSTRAINT", "ACTION_CONSTRAINTS"},
                "only the audited restart state constraint is allowed")
        for directive, operator in (("VIEW", RESTART_REDUCTION["view"]),
                                    ("CONSTRAINT", RESTART_REDUCTION["constraint"])):
            require(tokens.count(directive) == 1,
                    f"restart case must use exactly {directive} {operator}: {cfg}")
            # Additional operators after a valid name must not bypass the
            # inventory audit (TLC accepts multiple state constraints).
            start = tokens.index(directive) + 1
            end = start
            while end < len(tokens) and tokens[end] not in CFG_KEYWORDS:
                end += 1
            require(tokens[start:end] == [operator], f"restart {directive} must have exactly its audited operator")
    else:
        require(not set(tokens) & {"VIEW", "CONSTRAINT", "CONSTRAINTS", "ACTION_CONSTRAINT", "ACTION_CONSTRAINTS"},
                "the larger restart simulation must retain the raw state space")
    expected = {"MaxItems": "2", "MaxParts": "2", "MaxServerStarts": "2",
                "EnterRetries": "4", "PromptFlapping": "TRUE", "Flapping": "FALSE",
                "Bug": '"none"', "IdenticalTexts": "FALSE"}
    if cfg == RESTART_SIMULATION:
        expected.update(MaxItems="3", MaxLaunches="2", MaxRetypes="3", MaxAgentQueue="11",
                        Faults='{"botRestart", "busyWaiting", "lostEnter", "serverCrash"}',
                        Scenario='"restart-order"')
    elif cfg in RESTART_MUTATIONS:
        item = RESTART_MUTATIONS[cfg]
        expected.update(MaxLaunches="1", MaxRetypes=str(item["retypes"]),
                        MaxAgentQueue=str(2 + 2 * item["retypes"]),
                        Faults="{" + ", ".join(json.dumps(f) for f in item["faults"]) + "}",
                        Scenario='"restart-control"', Bug=json.dumps(item["bug"]), PromptFlapping="FALSE")
    else:
        scenario, fault, launches, retypes = RESTART_CASES[cfg]
        expected.update(MaxLaunches=str(launches), MaxRetypes=str(retypes),
                        MaxAgentQueue=str(2 + 2 * retypes), Faults='{"' + fault + '"}',
                        Scenario='"' + scenario + '"')
    if cfg in RESTART_MUTATIONS:
        require(not set(tokens) & {"INIT", "NEXT", "CHECK_DEADLOCK"}, "companion execution override forbidden")
        for directive, operator in (("SPECIFICATION", "SpecWithoutHeadTakeInAssumption"),
                                    ("ALIAS", "TraceView"), ("POSTCONDITION", "EmitTrace")):
            require(tokens.count(directive) == 1, f"missing/duplicate companion {directive}")
            start = tokens.index(directive) + 1
            end = start
            while end < len(tokens) and tokens[end] not in CFG_KEYWORDS:
                end += 1
            require(tokens[start:end] == [operator], f"wrong companion {directive}")
    declarations = re.findall(r'^\s*([A-Za-z][A-Za-z0-9_]*)\s*=\s*(.+?)\s*$', content, re.M)
    require(len(declarations) == len(expected)
            and {key: cfg_tokens(value) for key, value in declarations}
            == {key: cfg_tokens(value) for key, value in expected.items()},
            f"restart case bounds/faults/scenario changed: {cfg}")


class Refusal(RuntimeError):
    pass


def require(condition: bool, why: str) -> None:
    if not condition:
        raise Refusal(why)


def now() -> str:
    return datetime.now(timezone.utc).isoformat()


def sha(path: Path) -> str:
    return storage.file_digest(path)


def canonical(value) -> bytes:
    return json.dumps(value, sort_keys=True, separators=(",", ":")).encode()


def atomic_json(path: Path, value) -> None:
    content = canonical(value) + b"\n"
    storage.check(path, len(content) + 4096)
    temporary = path.with_suffix(".tmp")
    require(not path.is_symlink(), "linked JSON output")
    owned = False
    try:
        with storage.regular_file(temporary, "wb") as output:
            owned = True
            output.write(content)
            output.flush()
            os.fsync(output.fileno())
        temporary.replace(path)
    finally:
        if owned:
            temporary.unlink(missing_ok=True)
    directory_fd = os.open(path.parent, os.O_RDONLY)
    try:
        os.fsync(directory_fd)
    finally:
        os.close(directory_fd)


def append_json(path: Path, value) -> None:
    content = canonical(value) + b"\n"
    storage.check(path, len(content) + 4096)
    with path.open("ab") as output:
        output.write(content)
        output.flush()
        os.fsync(output.fileno())


def input_paths(root: Path) -> list[Path]:
    fixed = ["ci/run_ci.sh", "ci/runner.py", "jobs/lib/Dockerfile",
             "jobs/lib/tlcjob.sh", "jobs/lib/job.py", "ci/temporal_sensitivity.py",
             "ci/work_witness.py", "ci/local_storage.py", "tla2tools.jar"]
    files = {root / p for p in fixed}
    for pattern in ("*.tla", "ci/*.py", "ci/*.sh", "ci/*.tsv", "ci/*.json",
                    "ci/cfg/*.cfg", "ci/proof/*.tla", "ci/proof/*.tsv", "ci/proof/cfg/*.cfg",
                    "ci/fairness-probe/*.py", "ci/fairness-probe/*.tla", "ci/fairness-probe/cfg/*.cfg"):
        files.update(root.glob(pattern))
    return sorted(files)


def verify_pins(root: Path) -> dict[str, str]:
    provenance = root / "PROVENANCE.txt"
    require(provenance.is_file(), "missing PROVENANCE.txt")
    pins = {}
    for line in provenance.read_text().splitlines():
        matched = re.fullmatch(r"([a-f0-9]{64})  ([^ ]+)", line)
        if not matched:
            continue
        checksum, name = matched.groups()
        require(name not in pins and ".." not in Path(name).parts and not Path(name).is_absolute(),
                f"duplicate/unsafe pin: {name}")
        pins[name] = checksum
    expected = {str(path.relative_to(root)) for path in input_paths(root)}
    require(set(pins) == expected, f"pin inventory mismatch: {sorted(set(pins) ^ expected)}")
    for name, expected_hash in pins.items():
        path = root / name
        require(path.is_file() and not path.is_symlink(), f"missing/linked input: {name}")
        require(sha(path) == expected_hash, f"SHA-256 mismatch: {name}")
    require(pins["tla2tools.jar"] == JAR_SHA256, "unexpected TLC jar pin")
    require((root / "tla2tools.jar").stat().st_size == 4493033, "unexpected TLC jar size")
    return {**pins, "PROVENANCE.txt": sha(provenance)}


def snapshot_id(inputs: dict[str, str]) -> str:
    return hashlib.sha256(canonical(inputs)).hexdigest()


def cfg_tokens(cfg: str) -> list[str]:
    """Tokenize strings and nested/block/line comments before reading cfgs."""
    tokens = []
    index = 0
    depth = 0
    while index < len(cfg):
        if cfg.startswith("(*", index):
            depth += 1
            index += 2
        elif depth and cfg.startswith("*)", index):
            depth -= 1
            index += 2
        elif depth:
            index += 1
        elif cfg.startswith("\\*", index):
            end = cfg.find("\n", index)
            index = len(cfg) if end < 0 else end + 1
        elif cfg[index].isspace():
            index += 1
        else:
            token = re.match(r'"(?:[^"\\\n]|\\.)*"|[A-Za-z_][A-Za-z0-9_]*|\S', cfg[index:])
            require(token is not None, "unsupported cfg token")
            tokens.append(token[0])
            index += len(token[0])
    require(depth == 0, "unterminated cfg comment")
    return tokens


def checks_of(cfg: str) -> dict[str, list[str]]:
    """Read all indented/plural/multiline checks, rejecting unsupported forms."""
    tokens = cfg_tokens(cfg)
    checks = {"INVARIANT": [], "PROPERTY": []}
    for position, token in enumerate(tokens):
        if token not in {"INVARIANT", "INVARIANTS", "PROPERTY", "PROPERTIES"}:
            continue
        end = position + 1
        while end < len(tokens) and tokens[end] not in CFG_KEYWORDS:
            end += 1
        names = tokens[position + 1:end]
        require(bool(names) and all(re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", name) for name in names),
                "unsupported cfg check declaration")
        checks["PROPERTY" if token.startswith("PROPERT") else "INVARIANT"].extend(names)
    return checks


def specification_of(cfg: str) -> str:
    tokens = cfg_tokens(cfg)
    require(tokens.count("SPECIFICATION") == 1, "cfg needs one specification")
    start = tokens.index("SPECIFICATION") + 1
    require(start < len(tokens) and tokens[start] not in CFG_KEYWORDS
            and (start + 1 == len(tokens) or tokens[start + 1] in CFG_KEYWORDS),
            "unsupported specification declaration")
    return tokens[start]


def simulation_of(what: str) -> dict | None:
    match = re.match(r"simulate num=([1-9][0-9]*) depth=([1-9][0-9]*) seed=([0-9]+); ", what)
    return dict(zip(("num", "depth", "seed"), map(int, match.groups()))) if match else None


def load_manifest(root: Path, proof: bool) -> list[dict]:
    base = root / ("ci/proof" if proof else "ci")
    manifest = base / "suite.tsv"
    require(manifest.is_file(), "delivery suite not implemented yet" if not proof else "missing proof manifest")
    rows = []
    seen = set()
    for number, line in enumerate(manifest.read_text().splitlines(), 1):
        if not line or line.startswith("#"):
            continue
        fields = line.split("\t")
        require(len(fields) == 8, f"manifest line {number}: expected eight columns")
        group, spec, cfg, cap, expect, tier, what, props = fields
        require(bool(re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,35}", group)), "invalid group")
        require(spec == ("TraceProof" if proof else "PersonaDelivery"), "unexpected spec")
        require(bool(re.fullmatch(r"[A-Za-z0-9_]+", cfg)) and cfg not in seen, "invalid/duplicate cfg")
        seen.add(cfg)
        expected_cap = "900" if not proof and (group == "restart-order" or cfg in RESTART_MUTATIONS) else "1800"
        require(cap == expected_cap and tier == "fast" and what != "", "invalid cap/tier/what")
        require(expect in ("pass", "violation"), "invalid expectation")
        require(props == "-" if expect == "pass" else bool(re.fullmatch(r"[A-Za-z0-9_]+", props)),
                "invalid props; a negative row must name one target")
        cfg_path = base / "cfg" / f"{cfg}.cfg"
        require(cfg_path.is_file(), f"missing cfg: {cfg}")
        text = cfg_path.read_text()
        simulation = simulation_of(what)
        mode = "simulate" if simulation else "check"
        if not proof:
            validate_restart_cfg(cfg, text, mode)
        tokens = cfg_tokens(text)
        if proof:
            require(not set(tokens) & {"CONSTRAINT", "CONSTRAINTS", "ACTION_CONSTRAINT", "ACTION_CONSTRAINTS", "VIEW"},
                    "proof harness must stay raw")
        else:
            validate_shared_cfg(cfg, text, mode)
        check_lines = checks_of(text)
        checks = check_lines["INVARIANT"] + check_lines["PROPERTY"]
        if check_lines["PROPERTY"]:
            require("SYMMETRY" not in tokens, "liveness symmetry forbidden")
            if expect == "pass":
                require("VIEW" not in tokens, "positive temporal certification cannot use VIEW")
        if expect == "violation":
            require(checks == [props], f"negative cfg {cfg} must check only {props}")
        else:
            require("AtMostOnce" not in checks and "NotPremise" not in checks, "witness/probe in positive cfg")
        require(not what.startswith("simulate ") or simulation is not None, "unpinned simulation arguments")
        if simulation and expect == "pass":
            require("EmitSimulationTrace" in check_lines["INVARIANT"],
                    "simulation must emit every sampled behavior")
        rows.append({"group": group, "spec": spec, "cfg": cfg, "cap_s": int(cap),
                     "expect": expect, "tier": tier, "what": what, "props": props,
                     "checks": checks, "properties": check_lines["PROPERTY"],
                     "mode": mode, "simulation": simulation,
                     "state_reduction": restart_reduction(cfg) if not proof and set(tokens) & {"VIEW", "CONSTRAINT"} else None,
                     "cfg_path": str(cfg_path.relative_to(root)),
                     "spec_path": f"ci/proof/{spec}.tla" if proof else f"{spec}.tla"})
    require(bool(rows), "empty manifest")
    groups = list(dict.fromkeys(row["group"] for row in rows))
    for group in groups:
        group_rows = [r for r in rows if r["group"] == group]
        require(len(group_rows) <= 7, f"group {group} has more than seven rows")
        require(sum(r["cap_s"] + 20 for r in group_rows) + 120 <= MAX_BUDGET, "group over budget")
    if not proof:
        validate_suite(rows)
    return rows


def validate_suite(rows: list[dict]) -> None:
    indexed = {row["cfg"]: row for row in rows}
    mandatory = ORIGINAL_POSITIVES | set(TRACE_SIMULATIONS) | set(RESTART_CASES) | {RESTART_SIMULATION}
    require(mandatory <= indexed.keys(), f"missing original positive rows: {sorted(mandatory-indexed.keys())}")
    require(all(indexed[cfg]["expect"] == "pass" for cfg in mandatory), "positive row converted to a control")
    for cfg, parameters in TRACE_SIMULATIONS.items():
        require(indexed[cfg]["mode"] == "simulate" and indexed[cfg]["simulation"] == parameters,
                f"original simulation parameters changed: {cfg}")
    for cfg in ORIGINAL_POSITIVES:
        row = indexed[cfg]
        required = SAFETY | {"TypeOK"} | (LIVENESS if cfg.startswith("live_") else set())
        if row["mode"] == "simulate":
            required |= {"EmitSimulationTrace"}
        require(set(row["checks"]) == required and len(row["checks"]) == len(required)
                and set(row["properties"]) == (LIVENESS if cfg.startswith("live_") else set()),
                f"original positive property declarations changed: {cfg}")
    for cfg, prop in ALL_CONTROLS.items():
        require(cfg in indexed and indexed[cfg]["expect"] == "violation"
                and indexed[cfg]["props"] == prop, f"missing/wrong control: {cfg}")
    mutation_groups = ("restart-mutations-1", "restart-mutations-2")
    require(list(dict.fromkeys(r["group"] for r in rows))[:4]
            == ["core-progress", *mutation_groups, "restart-order"],
            "core progress must run first, followed by restart mutation sensitivity and restart order")
    ordered_mutations = list(RESTART_MUTATIONS)
    for index, cfg in enumerate(ordered_mutations):
        row = indexed[cfg]
        require(row["group"] == mutation_groups[index // 7] and row["cap_s"] == 900
                and row["checks"] == [RESTART_MUTATIONS[cfg]["target"]]
                and not row["properties"],
                f"companion mutant must check only its named invariant: {cfg}")
    require({r["cfg"] for r in rows if r["group"] in mutation_groups} == set(RESTART_MUTATIONS),
            "extra/missing restart mutation row")
    witness = [r for r in rows if r["props"] == "AtMostOnce"]
    require(len(witness) == 1 and witness[0]["what"] == WITNESS_WHAT, "duplicate witness missing/wrong")
    require(len([r for r in rows if r["props"] == "NotPremise"]) == 1, "premise probe missing")
    positive_checks = set().union(*(set(r["checks"]) for r in rows if r["expect"] == "pass"))
    require(SAFETY | LIVENESS | {"TypeOK"} <= positive_checks, "positive invariant/liveness definitions missing")
    exhaustive_checks = set().union(*(set(r["checks"]) for r in rows
                                     if r["expect"] == "pass" and r["mode"] == "check"))
    require(CORE <= exhaustive_checks, "core exhaustive checking cases missing")
    restart_rows = [r for r in rows if r["group"] == "restart-order"]
    require({r["cfg"] for r in restart_rows} == set(RESTART_CASES) | {RESTART_SIMULATION},
            "missing/extra restart-order case")
    for row in restart_rows:
        require(row["cap_s"] == 900, "restart cases must use the 900-second checking cap")
        expected_checks = SAFETY | {"TypeOK"}
        if row["mode"] == "simulate":
            expected_checks |= {"EmitSimulationTrace"}
        require(row["expect"] == "pass" and not row["properties"]
                and set(row["checks"]) == expected_checks
                and len(row["checks"]) == len(expected_checks),
                "restart case must check every safety invariant and only simulation must emit traces")
        if row["cfg"] == RESTART_SIMULATION:
            require(row["mode"] == "simulate" and row["simulation"] == RESTART_SIMULATION_PARAMETERS,
                    "original restart simulation parameters changed")
    require(any(r["group"] == "traces" and r["simulation"] for r in rows), "missing pinned trace simulation")


def build_plan(rows: list[dict], proof: bool) -> list[dict]:
    plan = []
    for group in dict.fromkeys(r["group"] for r in rows):
        selected = [r for r in rows if r["group"] == group]
        plan.append({"name": group, "budget": sum(r["cap_s"] + 20 for r in selected) + 120,
                     "rows": selected})
    return plan


def result_matches(row: dict, result: str) -> bool:
    if row["mode"] == "parse":
        return result == "PARSE-OK"
    if row["expect"] == "pass":
        return result == ("SIMULATION-OK" if row["mode"] == "simulate" else "PASS")
    if row["cfg"] in RESTART_MUTATIONS:
        return result == f"FAIL(Invariant_{row['props']}_is_violated)"
    named = re.fullmatch(r"FAIL\((?:Invariant|Action_property|Temporal_property)_([A-Za-z0-9_]+)_(?:is|was)_violated\)", result)
    if named:
        return named[1] == row["props"]
    # Unnamed temporal failure maps ONLY through the cfg's single PROPERTY.
    return (result == "FAIL(Temporal_properties_were_violated)"
            and row["properties"] == [row["props"]] and row["checks"] == [row["props"]])


def validate_row_result(row: dict, result: dict) -> None:
    """Bind a completed result to its actual mode and checked declarations."""
    require(result.get("cfg") == row["cfg"] and result.get("checks") == row["checks"],
            "checked property inventory mismatch")
    require(result.get("mode") == row["mode"] and result.get("simulation") == row["simulation"],
            "result checking mode mismatch")
    require(result_matches(row, result.get("result", "")),
            f"{row['cfg']}: {result.get('result', 'NO-VERDICT')}; expected {row['props']}")
    seconds = result.get("secs")
    require(type(seconds) in (int, float) and math.isfinite(seconds)
            and 0 <= seconds <= row["cap_s"] <= 1800, "row completion exceeds its budget")
    if row["cfg"] in {"probe_premise", "core_head_taken_in"}:
        timing = [result.get(key) for key in ("row_started_monotonic", "row_finished_monotonic", "row_deadline")]
        require(all(type(value) in (int, float) and math.isfinite(value) for value in timing)
                and timing[0] <= timing[1] < timing[2]
                and 0 < timing[2] - timing[0] <= row["cap_s"]
                and seconds == round(timing[1] - timing[0], 3), "invalid original accepted-work row deadline")
    require(result.get("exit_code") in ((0,) if row["expect"] == "pass" else (0, 11, 12, 13)),
            "invalid completed checker exit")
    exhaustive = row["mode"] == "check" and result["result"] == "PASS"
    require(result.get("exhaustive") is exhaustive, "forged exhaustive result")
    expected = {name: ("UNVERIFIED" if row["mode"] == "simulate" and name in row["properties"]
                       else "FAIL" if row["expect"] == "violation" and name == row["props"]
                       else "PASS" if exhaustive else "SAMPLED") for name in row["checks"]}
    require(result.get("propertyStatus") == expected, "result property status mismatch")
    if row["mode"] == "simulate":
        require(result.get("distinct") is None and result.get("depth") is None,
                "simulation cannot report exhaustive graph counts")
        stats = result.get("simulationStats")
        require(isinstance(stats, dict) and stats.get("depthLimit") == row["simulation"]["depth"],
                "missing simulation sample limits")
        if row["expect"] == "pass":
            require(type(stats.get("statesChecked")) is int and stats["statesChecked"] > 0
                    and stats.get("tracesGenerated") == row["simulation"]["num"],
                    "incomplete simulation samples")
    else:
        require(result.get("simulationStats") is None, "exhaustive result has simulation samples")
    if exhaustive:
        require(type(result.get("distinct")) is int and result["distinct"] > 0
                and type(result.get("depth")) is int and result["depth"] > 0,
                "missing completed exhaustive graph counts")


def checked_core_coverage(root: Path, rows: list[dict], completed: list[dict], inputs: dict,
                          directory: Path | None = None) -> dict:
    """Credit only successful exhaustive scheduler rows, using their frozen cfgs."""
    indexed = {row["cfg"]: row for row in rows}
    require(len(indexed) == len(rows), "duplicate canonical rows")
    results = [(job, result) for job in completed for result in job["results"]]
    require(len(results) == len(rows) and len({result["cfg"] for _, result in results}) == len(rows)
            and {result["cfg"] for _, result in results} == set(indexed), "partial completed row inventory")
    source = (root / "PersonaDelivery.tla").read_text()
    require(inputs.get("PersonaDelivery.tla") == sha(root / "PersonaDelivery.tla"), "stale core model")
    for name in SAFETY | LIVENESS | {"TypeOK"}:
        require(re.search(r"^" + name + r"\s*==", source, re.M), f"missing source property: {name}")
    coverage = {name: [] for name in sorted(CORE)}
    contract_spec = importlib.util.spec_from_file_location("core_work_contract", root / "ci/trace_contract.py")
    contract = importlib.util.module_from_spec(contract_spec)
    contract_spec.loader.exec_module(contract)
    worker_spec = importlib.util.spec_from_file_location("core_work_worker", root / "jobs/lib/job.py")
    worker = importlib.util.module_from_spec(worker_spec)
    worker_spec.loader.exec_module(worker)
    accepted_work = {}
    for job, result in results:
        row = indexed[result["cfg"]]
        validate_row_result(row, result)
        if row["cfg"] in worker.WORK_WITNESS_ROWS:
            selected = [trace for trace in retained_traces(directory, job) if trace["cfg"] == row["cfg"]]
            require(len(selected) == 1, "missing/duplicate core coverage accepted-work bundle")
            _, metadata = contract.validate_envelope(
                root, {"inputs": inputs, "snapshot": snapshot_id(inputs), "run": "core-coverage"},
                row, selected[0], worker, result=result)
            accepted_work[row["cfg"]] = metadata["acceptedWork"]
        cfg_path = root / row["cfg_path"]
        require(inputs.get(row["cfg_path"]) == sha(cfg_path), "stale checked cfg")
        content = cfg_path.read_text()
        declared = checks_of(content)
        require(declared["INVARIANT"] + declared["PROPERTY"] == row["checks"]
                and declared["PROPERTY"] == row["properties"], "cfg checked declarations differ from result")
        validate_shared_cfg(row["cfg"], content, row["mode"])
        actual_reduction = restart_reduction(row["cfg"]) if set(cfg_tokens(content)) & {"VIEW", "CONSTRAINT"} else None
        require(row.get("state_reduction") == actual_reduction, "cfg state reduction differs from row")
        if row["expect"] == "pass":
            require(re.search(r'^\s+Bug\s*=\s*"none"\s*$', content, re.M), "positive cfg is a mutant")
        if row["expect"] != "pass" or row["mode"] != "check" or result["result"] != "PASS":
            continue
        specification = specification_of(content)
        for name in CORE & set(row["checks"]):
            require(name in declared["PROPERTY" if name == "HeadTakenIn" else "INVARIANT"],
                    f"wrong core property declaration: {name}")
            if name == "HeadTakenIn":
                require(not set(cfg_tokens(content)) & {"VIEW", "SYMMETRY"},
                        "HeadTakenIn certification requires unprojected states")
                require(specification == "Spec", "HeadTakenIn requires decision 13 specification")
                for operator, expression in (
                        ("Spec", "SpecWithoutHeadTakeInAssumption /\\ TypableHeadTakeInAssumption"),
                        ("SpecWithoutHeadTakeInAssumption", "Init /\\ [][Next]_vars /\\ Fairness")):
                    match = re.search(r"^" + operator + r"\s*==([^\n]+)$", source, re.M)
                    require(match and cfg_tokens(match[1]) == cfg_tokens(expression),
                            "HeadTakenIn specification omits original fairness/decision 13")
            coverage[name].append({"cfg": row["cfg"], "jobId": job["id"], "mode": "check",
                                   "result": "PASS", "specification": specification,
                                   "capSeconds": row["cap_s"], "seconds": result["secs"],
                                   "distinct": result["distinct"], "depth": result["depth"],
                                   "cfgSha256": inputs[row["cfg_path"]],
                                   "specSha256": inputs[row["spec_path"]],
                                   "stateReduction": restart_reduction(row),
                                   **({"acceptedWork": accepted_work[row["cfg"]]} if name == "HeadTakenIn" else {})})
    require(set(accepted_work) == worker.WORK_WITNESS_ROWS, "missing core/probe nonvacuity coverage")
    require(all(coverage.values()), f"missing completed exhaustive core coverage: {sorted(name for name, evidence in coverage.items() if not evidence)}")
    return coverage


def parse_job_log(text: str, job: dict, snapshot: str) -> tuple[list[dict], list[dict]]:
    lines = text.splitlines()
    require(bool(lines) and lines[-1].startswith("JOB-VERDICT "), "missing final JOB-VERDICT")
    require(sum(line.startswith("JOB-VERDICT ") for line in lines) == 1, "duplicate job verdict")
    final = json.loads(lines[-1][12:])
    require(final.get("schema") == 1 and final.get("complete") is True
            and final.get("result") in ("PASS", "FAIL"), "incomplete job")
    require(final.get("snapshot") == snapshot, "job snapshot mismatch")
    worker_spec = importlib.util.spec_from_file_location("delivery_result_worker", Path(__file__).resolve().parents[1] / "jobs/lib/job.py")
    worker = importlib.util.module_from_spec(worker_spec)
    worker_spec.loader.exec_module(worker)
    results = [json.loads(line[4:]) for line in lines if line.startswith("ROW ")]
    row_positions = [index for index, line in enumerate(lines) if line.startswith("ROW ")]
    require(results == final.get("rows"), "row/final verdict mismatch")
    require([r.get("cfg") for r in results] == [r["cfg"] for r in job["rows"]], "row inventory mismatch")
    failed = [row["cfg"] for row, result in zip(job["rows"], results)
              if not result_matches(row, result.get("result", ""))]
    require(final.get("failed") == failed and final["result"] == ("FAIL" if failed else "PASS"),
            "job verdict disagrees with row expectations")
    traces = [json.loads(line[6:]) for line in lines if line.startswith("TRACE ")]
    indexed = {r["cfg"]: r for r in job["rows"]}
    for trace in traces:
        require(isinstance(trace, dict), "bad trace envelope")
        require(trace.get("cfg") in indexed and trace.get("snapshot") == snapshot, "mismatched trace")
        expected_spec = indexed[trace["cfg"]]["spec"]
        require(trace.get("spec") == expected_spec
                and trace.get("schema") == (2 if expected_spec == "PersonaDelivery" else 1),
                "bad trace envelope")
    for index, (row, result) in enumerate(zip(job["rows"], results)):
        validate_row_result(row, result)
        start = row_positions[index - 1] + 1 if index else 0
        # TRACE envelopes were strictly decoded and checked above. Their JSON
        # contains independent helper logs, not primary checker output. Keep
        # one authentic scope for classification, execution mode and counts;
        # full envelope/proof validation still follows during collection.
        segment = lines[start:row_positions[index]]
        require(all(json.loads(line[6:])["cfg"] == row["cfg"]
                    for line in segment if line.startswith("TRACE ")),
                "trace outside its checker row")
        checker_log = "\n".join(line for line in segment if not line.startswith("TRACE "))
        require(worker.classify(checker_log, result["exit_code"], row["mode"]) == result["result"],
                "row result differs from authentic checker output")
        mode_evidence = worker.mode_evidence(row, result["result"], checker_log)
        require(all(result.get(key) == value for key, value in mode_evidence.items()),
                "row mode evidence differs from checker output")
        if result["exhaustive"]:
            counts = re.findall(r"([0-9,]+) states generated, ([0-9,]+) distinct states found, ([0-9,]+) states left on queue", checker_log)
            depth = re.findall(r"depth of the complete state graph search is ([0-9]+)", checker_log)
            require(counts and depth and int(counts[-1][2].replace(",", "")) == 0
                    and int(counts[-1][1].replace(",", "")) == result["distinct"]
                    and int(depth[-1]) == result["depth"], "exhaustive graph differs from checker output")
        observed = len([t for t in traces if t["cfg"] == row["cfg"]])
        require(result.get("trace_count") == observed, "trace count mismatch")
        if row["cfg"] in worker.WORK_WITNESS_ROWS:
            require(observed == 1, "each accepted-work row requires exactly one bundle")
        if row["expect"] == "violation":
            require(observed > 0, "missing structured counterexample")
        if row["mode"] == "simulate" and row["expect"] == "pass":
            require(observed == row["simulation"]["num"], "incomplete simulation trace set")
            require(all(len(trace["raw"]["behavior"]) <= row["simulation"]["depth"] + 1
                        for trace in traces if trace["cfg"] == row["cfg"]), "simulation sample exceeds depth limit")
    return results, traces


def trace_summary(traces):
    digest, size = hashlib.sha256(), 0
    for part in json.JSONEncoder(sort_keys=True, separators=(",", ":")).iterencode(traces):
        content = part.encode()
        size += len(content)
        require(size <= storage.CANONICAL_LOG_LIMIT, "oversized canonical trace inventory")
        digest.update(content)
    return {"schema": 1, "count": len(traces), "bytes": size, "sha256": digest.hexdigest()}


def read_job_log(directory, entry):
    """Read either historical logs or exact original bytes from a compact log."""
    require(directory is not None, "compact evidence requires its run directory")
    identifier = entry["id"]
    require(isinstance(identifier, str) and bool(re.fullmatch(r"[A-Za-z0-9._-]+", identifier)),
            "invalid evidence job ID")
    if "logContainer" in entry:
        require("traces" not in entry and "traceSummary" in entry
                and isinstance(entry["logContainer"], dict)
                and entry["logContainer"].get("path") == identifier + ".run_log.gz",
                "invalid compact collection inventory")
        raw = storage.read_compressed(directory, entry["logContainer"])
    else:
        with storage.regular_file(directory / (identifier + ".run_log")) as source:
            size = os.fstat(source.fileno()).st_size
            require(size <= storage.CANONICAL_LOG_LIMIT, "oversized historical log")
            raw = source.read(size + 1)
            require(len(raw) == size, "historical log changed while reading")
    require(hashlib.sha256(raw).hexdigest() == entry["log_sha256"], "collected log changed")
    return raw.decode("utf-8")


def check_trace_inventory(entry, traces):
    if "traceSummary" in entry:
        require(trace_summary(traces) == entry["traceSummary"], "collected trace inventory changed")
    elif "traces" in entry:
        require(traces == entry["traces"], "collected traces changed")


def retained_traces(directory, entry):
    if "logContainer" not in entry:
        return entry.get("traces", [])
    traces = [json.loads(line[6:]) for line in read_job_log(directory, entry).splitlines()
              if line.startswith("TRACE ")]
    check_trace_inventory(entry, traces)
    return traces


def read_completed(directory, entry, job, snapshot):
    log = read_job_log(directory, entry)
    require(sha(directory / (entry["id"] + ".result")) == entry["result_sha256"],
            "result record changed")
    results, traces = parse_job_log(log, job, snapshot)
    require(results == entry["results"], "collected results changed")
    check_trace_inventory(entry, traces)
    return results, traces


class Scheduler:
    """Production seam deliberately exposes only submit and one-shot results."""
    def __init__(self, executable: str):
        self.executable = executable

    def call(self, args: list[str], capture: Path | None = None) -> dict:
        if capture is None:
            result = subprocess.run([self.executable, *args, "--json"], capture_output=True, text=True, check=False)
            require(result.returncode == 0, f"scheduler {' '.join(args[:2])} failed: {result.stderr[:300]}")
            return json.loads(result.stdout)
        # Persist the exact submit reply before parsing any field. If interrupted,
        # state remains 'submitting', which blocks every new submission.
        with capture.open("wb") as output:
            result = subprocess.run([self.executable, *args, "--json"], stdout=output, stderr=subprocess.PIPE, check=False)
            output.flush()
            os.fsync(output.fileno())
        require(result.returncode == 0, f"scheduler submit refused: {result.stderr[:300]!r}")
        return json.loads(capture.read_text())


@contextmanager
def lock(root: Path):
    home = root / "ci/.runs"
    storage.check(home, storage.LOG_LIMIT)
    home.mkdir(parents=True, exist_ok=True)
    with (home / "lock").open("a") as handle:
        try:
            fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as error:
            raise Refusal("another runner invocation is active") from error
        yield home


def read_json(path: Path):
    return json.loads(path.read_text())


def scheduler_path() -> str:
    value = os.environ.get("TLA_JOBSCHED", "")
    require(bool(value) and Path(value).is_absolute() and Path(value).is_file()
            and os.access(value, os.X_OK), "TLA_JOBSCHED must be a caller-supplied absolute executable path")
    return value


def guard_active(home: Path) -> None:
    """Production and diagnostics share this guard under the same flock."""
    active = home / "active.json"
    if active.exists():
        previous = read_json(Path(read_json(active)["directory"]) / "state.json")
        require(previous["phase"] in ("proof-complete", "certified", "failed", "superseded")
                and previous.get("outstanding") is None,
                "previous run is unresolved; resume its exact completed job after notice")


def stage_input(root: Path, relative: str, target: Path, inputs: dict[str, str]) -> None:
    """Write the verified bytes themselves; never copy a subsequently read file."""
    source = root / relative
    require(source.is_file() and not source.is_symlink(), f"missing/linked staging source: {relative}")
    content = source.read_bytes()
    require(relative in inputs and hashlib.sha256(content).hexdigest() == inputs[relative],
            f"source changed before staging: {relative}")
    storage.check(target, len(content) + 4096)
    target.write_bytes(content)
    require(sha(target) == inputs[relative], f"staged input changed: {relative}")


def sany_clean(returncode: int | None, stdout: str, stderr: str, module: str) -> bool:
    # The pinned SANY main exits ZERO on semantic errors unless -error-codes is
    # supplied. Also require positive semantic/lint completion and no diagnostics
    # so a truncated log, launcher failure or changed CLI cannot silently pass.
    return (returncode == 0 and not stderr.strip()
            and f"Semantic processing of module {module}" in stdout.splitlines()
            and f"Linting of module {module}" in stdout.splitlines()
            and not re.search(r"(?im)^.*\b(?:errors?|aborts?|exceptions?|fatal|warnings?)\b", stdout))


def local_sany(root: Path, directory: Path, state: dict) -> None:
    """Check frozen source bytes locally; never invoke TLC on this host."""
    context = directory / "preflight"
    context.mkdir()
    row = state["rows"][0]
    module = row["spec"]
    sources = {f"{module}.tla": row["spec_path"], "tla2tools.jar": "tla2tools.jar"}
    for name, relative in sources.items():
        stage_input(root, relative, context / name, state["inputs"])
    java = shutil.which("java")
    command = [java or "java", "-cp", "tla2tools.jar", "tla2sany.SANY", "-error-codes", f"{module}.tla"]
    evidence = {"schema": 1, "snapshot": state["snapshot"], "module": module,
                "source_map": sources, "command": command, "cwd": str(context),
                "started": now(), "result": "STARTED"}
    atomic_json(context / "sany.json", evidence)
    stdout_path, stderr_path = context / "sany.stdout", context / "sany.stderr"
    failure = None
    returncode = None
    try:
        require(java is not None, "local SANY requires java on PATH")
        with storage.session(storage.runs_home(directory)) as guard:
            result = guard.run(command, cwd=context, timeout=60, stderr=subprocess.PIPE)
        returncode = result.returncode
        stdout, stderr = result.stdout, result.stderr
    except (Refusal, OSError, subprocess.TimeoutExpired, storage.StorageRefusal) as error:
        failure = str(error)
        stdout, stderr = getattr(error, "output", None) or b"", getattr(error, "stderr", None) or b""
    for path, content in ((stdout_path, stdout), (stderr_path, stderr)):
        storage.check(path, len(content) + 4096)
        with path.open("wb") as stream:
            stream.write(content)
            stream.flush()
            os.fsync(stream.fileno())
    clean = failure is None and sany_clean(returncode, stdout_path.read_text(), stderr_path.read_text(), module)
    evidence.update(finished=now(), exit_code=returncode, failure=failure,
                    result="PASS" if clean else "FAIL",
                    hashes={name: sha(context / name) for name in (*sources, "sany.stdout", "sany.stderr")})
    atomic_json(context / "sany.json", evidence)
    state["sany"] = {"path": str(context / "sany.json"), "sha256": sha(context / "sany.json")}
    state["phase"] = "ready" if clean else "failed"
    atomic_json(directory / "state.json", state)
    require(clean, f"local SANY failed; evidence retained at {context / 'sany.json'}")
    print(f"SANY-VERDICT PASS evidence={context / 'sany.json'}", flush=True)


def verify_local_sany(directory: Path, state: dict) -> None:
    context = directory / "preflight"
    evidence_path = context / "sany.json"
    require(state.get("sany") == {"path": str(evidence_path), "sha256": sha(evidence_path)},
            "local SANY evidence missing/changed")
    evidence = read_json(evidence_path)
    module = state["rows"][0]["spec"]
    sources = {f"{module}.tla": state["rows"][0]["spec_path"], "tla2tools.jar": "tla2tools.jar"}
    require(evidence.get("schema") == 1 and evidence.get("snapshot") == state["snapshot"]
            and evidence.get("result") == "PASS" and evidence.get("failure") is None
            and evidence.get("module") == module and evidence.get("source_map") == sources
            and evidence.get("cwd") == str(context), "invalid local SANY evidence")
    command = evidence.get("command", [])
    require(len(command) == 6 and Path(command[0]).is_absolute()
            and command[1:] == ["-cp", "tla2tools.jar", "tla2sany.SANY", "-error-codes", f"{module}.tla"],
            "invalid local SANY command")
    hashes = {name: sha(context / name) for name in (*sources, "sany.stdout", "sany.stderr")}
    require(evidence.get("hashes") == hashes
            and all(hashes[name] == state["inputs"][relative] for name, relative in sources.items()),
            "local SANY inputs/logs changed")
    require(sany_clean(evidence.get("exit_code"), (context / "sany.stdout").read_text(),
                       (context / "sany.stderr").read_text(), module), "local SANY did not complete cleanly")


def seal_context(context: Path, job: dict, inputs: dict[str, str], sources: dict[str, str], snapshot: str) -> dict:
    require(snapshot_id(inputs) == snapshot, "source snapshot mismatch")
    for name, relative in sources.items():
        require(sha(context / name) == inputs[relative], f"staged hash differs from preflight: {name}")
    atomic_json(context / "plan.json", {**job, "snapshot": snapshot,
                                       "source_inputs": inputs, "source_map": sources})
    hashes = {p.name: sha(p) for p in context.iterdir() if p.is_file()}
    atomic_json(context / "inputs.json", hashes)
    return {**hashes, "inputs.json": sha(context / "inputs.json")}


def show_pending(directory: Path, state: dict) -> None:
    outstanding = state["outstanding"]
    print(f"JOB {outstanding['id']} context={outstanding['context']}")
    command = ["bash", str(ROOT / "ci/run_ci.sh"), "collect", "--run-dir", str(directory),
               "--completed-job", outstanding["id"]]
    print("After the owner forwards the completion notice, run:")
    print("TLA_JOBSCHED=" + shlex.quote(state["scheduler"]) + " TLA_CHANNEL="
          + shlex.quote(state["channel"]) + " " + shlex.join(command))
    print("CI-VERDICT PENDING (one outstanding job; certification pending)")


def verify_feasibility_profile(root: Path, rows: list[dict]) -> None:
    """A reviewed local profile is mandatory BEFORE any scheduler query/submit.

    Local completion never certifies the scheduler suite. An unfinished screen
    cannot be promoted by relabeling it as feasible; improve or decompose it.
    """
    policy = read_json(root / "ci/feasibility_profile.json")
    require(policy.get("schema") == 1 and policy.get("reviewStatus") == "approved",
            "shared reduction needs independent review and SRD amendment before submission")
    relative = Path(policy.get("report", ""))
    require(not relative.is_absolute() and ".." not in relative.parts
            and relative.parts[:2] == ("ci", ".runs"), "invalid local screening evidence path")
    report_path = root / relative
    require(sha(report_path) == policy.get("reportSha256"), "changed local screening evidence")
    report = read_json(report_path)
    require(report.get("kind") == "exploratory-local-screen" and report.get("certification") is False
            and not report.get("partial"), "missing complete local screening inventory")
    current = load_manifest(root, False)
    entries = report.get("rows", [])
    require(len(entries) == len(current) and len({entry["cfg"] for entry in entries}) == len(entries)
            and {entry["cfg"] for entry in entries} == {row["cfg"] for row in current},
            "incomplete local screening inventory")
    # These are the profiler's execution/validation dependencies, not the full
    # certification inventory. Policy/PROVENANCE bytes must be excluded: the
    # approved policy points to this report, and provenance pins that policy.
    # Proof/probe/extraction tools and scheduler launch wrappers are not used by
    # local screens; their independent certification pins still apply.
    checker_paths = {"tla2tools.jar", "ci/screen_cfgs.py", "ci/suite.tsv",
                     "ci/runner.py", "jobs/lib/job.py", "ci/trace_contract.py", "ci/temporal_sensitivity.py",
                     "ci/work_witness.py", "ci/local_storage.py"}
    checker_paths.update(row["spec_path"] for row in current)
    checker_paths.update(row["cfg_path"] for row in current)
    require(all(report.get("sourceInputs", {}).get(path) == sha(root / path) for path in checker_paths),
            "stale local checker inputs")
    indexed = {entry["cfg"]: entry for entry in entries}
    for row in rows:
        entry = indexed[row["cfg"]]
        require(entry.get("finishedExpected") is True and result_matches(row, entry.get("result", ""))
                and entry.get("mode") == row["mode"] and entry.get("simulation") == row["simulation"]
                and not entry.get("traceErrors"),
                f"unresolved local screening result: {row['cfg']}")
        require(entry.get("cfgSha256") == sha(root / row["cfg_path"])
                and entry.get("specSha256") == sha(root / row["spec_path"]), "stale local row")
        if row["mode"] == "check":
            require(entry.get("initialDistinct", 0) > 0, "empty local initial-state set")
        else:
            stats = entry.get("simulationStats", {})
            require(entry.get("exhaustive") is False
                    and entry.get("finalCounts") is None
                    and entry.get("propertyStatus") == {
                        name: ("UNVERIFIED" if name in row["properties"] else
                               "FAIL" if row["expect"] == "violation" else "SAMPLED") for name in row["checks"]},
                    "misleading local simulation evidence")
            if row["expect"] == "pass":
                require(stats.get("tracesGenerated") == row["simulation"]["num"]
                        and stats.get("statesChecked", 0) > 0
                        and stats.get("depthLimit") == row["simulation"]["depth"],
                        "incomplete local simulation samples")
        if row["expect"] == "pass" and row["mode"] == "check":
            require(entry.get("finalCounts") and entry["finalCounts"][2] == 0,
                    "unfinished local positive graph")
        if row["expect"] == "violation" or row["mode"] == "simulate":
            require(entry.get("traceSummaries"), "unvalidated local trace evidence")
        if row["cfg"] in {"probe_premise", "core_head_taken_in"}:
            contract_spec = importlib.util.spec_from_file_location("screened_accepted_work", root / "ci/trace_contract.py")
            contract = importlib.util.module_from_spec(contract_spec)
            contract_spec.loader.exec_module(contract)
            worker_spec = importlib.util.spec_from_file_location("screened_accepted_work_worker", root / "jobs/lib/job.py")
            worker = importlib.util.module_from_spec(worker_spec)
            worker_spec.loader.exec_module(worker)
            traces = storage.retained_envelopes(entry)
            require(len(traces) == 1, "missing/duplicate screened accepted-work witness")
            with storage.session(root / "ci/.runs"):
                _, metadata = contract.validate_envelope(root, {"snapshot": report["snapshot"], "inputs": report["sourceInputs"]},
                                                        row, traces[0], worker, result=entry)
            require(len(entry["traceSummaries"]) == 1
                    and entry["traceSummaries"][0].get("acceptedWork") == metadata["acceptedWork"],
                    "changed screened accepted-work witness")


def submit_next(root: Path, directory: Path, state: dict, scheduler) -> None:
    require(state.get("outstanding") is None, "one job already outstanding")
    require(state["next"] < len(state["plan"]), "no next job")
    verify_local_sany(directory, state)
    if not state.get("proof"):
        try:
            verify_feasibility_profile(root, state["plan"][state["next"]]["rows"])
        except (Refusal, ValueError, KeyError, OSError, TypeError) as error:
            # A concurrent edit after start's precheck can still close the gate.
            # Only an unequivocally unsubmitted initial run may be released;
            # never clear an attempt, job ID or consumed collection.
            if (state.get("phase") == "ready" and state.get("next") == 0
                    and state.get("ids") == [] and state.get("completed") == []
                    and state.get("outstanding") is None and "attempt" not in state):
                state["phase"] = "failed"
                state["failure"] = {"stage": "feasibility", "reason": str(error)}
                atomic_json(directory / "state.json", state)
            raise
    # One preflight read, never a status/log polling loop.
    preflight = scheduler.call(["list"])
    require(preflight.get("summary", {}).get("dispatcher_running") is True,
            "scheduler dispatcher is not running; nothing submitted")
    job = state["plan"][state["next"]]
    context = directory / "contexts" / f"{state['next']:02d}-{job['name']}"
    context.mkdir(parents=True)
    sources = {name: f"jobs/lib/{name}" for name in ("Dockerfile", "tlcjob.sh", "job.py")}
    sources["tla2tools.jar"] = "tla2tools.jar"
    sources["temporal_sensitivity.py"] = "ci/temporal_sensitivity.py"
    sources["work_witness.py"] = "ci/work_witness.py"
    sources["local_storage.py"] = "ci/local_storage.py"
    for row in job["rows"]:
        sources[f"{row['spec']}.tla"] = row["spec_path"]
        sources[f"{row['cfg']}.cfg"] = row["cfg_path"]
    for name, relative in sources.items():
        stage_input(root, relative, context / name, state["inputs"])
    context_hashes = seal_context(context, job, state["inputs"], sources, state["snapshot"])
    state["phase"] = "submitting"
    state["attempt"] = {"job": job["name"], "context": str(context), "context_hashes": context_hashes}
    atomic_json(directory / "state.json", state)
    reply_file = directory / f"submit-{state['next']:02d}.json"
    reply = scheduler.call(["submit", "--context", str(context), "--name", f"omv-{job['name']}",
                            "--channel", state["channel"], "--network", "off", "--memory", "24g",
                            "--cpus", "4", "--timeout", "4h"], reply_file)
    job_id = reply.get("id", "")
    require(bool(re.fullmatch(r"[A-Za-z0-9._-]+", job_id)), "submit returned no job ID; do not resubmit")
    entry = {"time": now(), "run": state["run"], "job": job["name"], "id": job_id,
             "snapshot": state["snapshot"], "context": str(context), "proof": state["proof"]}
    # The ledger is fsynced immediately, before checking limits/dispatcher fields.
    append_json(root / "ci/jobs.jsonl", entry)
    state["ids"].append(job_id)
    state["outstanding"] = {**state["attempt"], "id": job_id, "collect_attempted": False}
    state["phase"] = "pending"
    atomic_json(directory / "state.json", state)
    print(f"SUBMITTED {job_id} context={context}", flush=True)
    limits_ok = (reply.get("dispatcher_running") is True
                 and isinstance(reply.get("memory"), int) and reply["memory"] >= MIN_MEMORY
                 and isinstance(reply.get("timeout_s"), int) and reply["timeout_s"] >= MAX_BUDGET + LIMIT_MARGIN_S
                 and reply.get("cpus") == 4)
    if not limits_ok:
        state["outstanding"]["limits_refused"] = True
        atomic_json(directory / "state.json", state)
    show_pending(directory, state)
    require(limits_ok, "submitted job reported invalid limits/dispatcher; keep context and await its notice")


def collect(root: Path, directory: Path, state: dict, completed: str, scheduler) -> None:
    with storage.session(root / "ci/.runs"):
        _collect(root, directory, state, completed, scheduler)


def _collect(root: Path, directory: Path, state: dict, completed: str, scheduler) -> None:
    outstanding = state.get("outstanding")
    require(state["phase"] == "pending" and outstanding is not None, "run is not pending collection")
    require(outstanding["id"] == completed, "notice job ID differs from outstanding job")
    require(isinstance(completed, str) and bool(re.fullmatch(r"[A-Za-z0-9._-]+", completed)),
            "invalid collection job ID")
    require(not outstanding.get("collect_attempted"), "this job has already been collected/attempted")
    # This known worst-case proof scratch/control peak can be refused before
    # consuming the one permitted results call. Exact log admission follows it.
    storage.check(directory, storage.ENVELOPE_LIMIT + 2 * len(canonical(state)) + 65536)
    # Fail closed on interruption; no automatic or repeat collection, even after
    # an early/manual resume without a completed notice.
    outstanding["collect_attempted"] = True
    state["phase"] = "collecting"
    atomic_json(directory / "state.json", state)
    response = scheduler.call(["results", completed])
    atomic_json(directory / f"results-{completed}.json", response)
    require(response.get("id") == completed and response.get("terminal") is True,
            "results are not terminal; collection consumed; no polling/retry permitted")
    append_json(root / "ci/jobs.jsonl", {"time": now(), "id": completed,
                "run": state["run"], "event": "collected", "state": response.get("state")})
    require(not outstanding.get("limits_refused"), "invalid submitted limits")
    for name, expected in outstanding["context_hashes"].items():
        require(sha(Path(outstanding["context"]) / name) == expected, "submitted context changed")
    paths, present = response.get("paths", {}), response.get("present", {})
    for key in ("run_log", "result"):
        require(present.get(key) is True and Path(paths.get(key, "")).is_file(), f"missing {key}")
    # Admission measures the exact lossless compressed log before any bulk
    # write. Reserve the result copy and both small control-state updates.
    reserve = (storage.ENVELOPE_LIMIT + Path(paths["result"]).stat().st_size
               + 2 * len(canonical(state)) + 65536)
    log_container = storage.compress_file(paths["run_log"], directory / f"{completed}.run_log.gz",
                                          reserve=reserve)
    atomic_json(directory / f"{completed}.log.json", log_container)
    storage.copy_files([(paths["result"], directory / f"{completed}.result")])
    terminal = read_json(directory / f"{completed}.result")
    # A completed worker exits 1 on an expectation mismatch. Retain and inspect
    # its rows for the specific diagnosis; infrastructure failures remain fatal.
    require(response.get("state") in ("succeeded", "failed")
            and terminal.get("job_id") == completed
            and terminal.get("status") == response["state"]
            and (terminal["status"], terminal.get("exit_code")) in (("succeeded", 0), ("failed", 1)),
            f"terminal scheduler failure: {response.get('state')}")
    require(all(terminal.get(flag) is False for flag in ("oom_killed", "timed_out", "cancelled")),
            "terminal result records an interrupted run")
    require(terminal.get("network") == "off" and terminal.get("memory", 0) >= MIN_MEMORY
            and terminal.get("cpus") == 4 and terminal.get("timeout_s", 0) >= MAX_BUDGET + LIMIT_MARGIN_S,
            "applied scheduler limits mismatch")
    require(terminal.get("secret_names") == [], "unexpected secrets in model job")
    stats = terminal.get("run_log", {})
    require(stats.get("truncated") is False
            and stats.get("total_bytes") == stats.get("kept_bytes")
            == log_container["bytes"], "incomplete run log")
    log = storage.read_compressed(directory, log_container).decode("utf-8")
    job = state["plan"][state["next"]]
    results, traces = parse_job_log(log, job, state["snapshot"])
    require(terminal["status"] == "succeeded", "worker verdict/process exit mismatch")
    for trace in traces:
        row = next(r for r in job["rows"] if r["cfg"] == trace["cfg"])
        require(trace.get("spec") == row["spec"] and trace.get("mode") == row["mode"]
                and trace.get("property") == row["props"] and trace.get("simulation") == row["simulation"],
                "trace metadata mismatch")
        require(trace.get("hashes") == {"spec": state["inputs"][row["spec_path"]],
                                        "cfg": state["inputs"][row["cfg_path"]]}, "trace hash mismatch")
    if any(row["cfg"] in {"probe_premise", "core_head_taken_in"}
           or (reduced_cfg(row) and row["expect"] == "violation") for row in job["rows"]):
        import importlib.util
        spec = importlib.util.spec_from_file_location("delivery_mutation_gate", root / "ci/trace_contract.py")
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        module.validate_mutation_group(root, state, job, traces, results)
    state["completed"].append({"job": job["name"], "id": completed, "results": results,
                               "log_sha256": log_container["sha256"], "logContainer": log_container,
                               "result_sha256": sha(directory / f"{completed}.result"),
                               "traceSummary": trace_summary(traces)})
    state["next"] += 1
    state["outstanding"] = None
    state["phase"] = "ready"
    atomic_json(directory / "state.json", state)


def finish(root: Path, directory: Path, state: dict) -> None:
    with storage.session(root / "ci/.runs"):
        _finish(root, directory, state)


def _finish(root: Path, directory: Path, state: dict) -> None:
    require(state["next"] == len(state["plan"]) and state["outstanding"] is None, "incomplete run")
    verify_local_sany(directory, state)
    require(state["plan"] == build_plan(load_manifest(root, state["proof"]), state["proof"]),
            "run plan differs from complete manifest")
    require([job["job"] for job in state["completed"]] == [job["name"] for job in state["plan"]],
            "completed groups differ from complete plan")
    require([job["id"] for job in state["completed"]] == state["ids"]
            and len(set(state["ids"])) == len(state["ids"]), "missing/duplicate associated jobs")
    for plan, completed in zip(state["plan"], state["completed"]):
        read_completed(directory, completed, plan, state["snapshot"])
    if state["proof"]:
        state["phase"] = "proof-complete"
        atomic_json(directory / "state.json", state)
        print("PROOF-VERDICT PASS (exploratory tooling only; E1 remains uncertified)")
        return
    # The delivery model and extractor must land before production certification.
    # This explicit gate prevents the exploratory proof from producing PASS.
    require((root / "ci/trace_contract.py").is_file(), "production trace coverage validator not implemented")
    import importlib.util
    spec = importlib.util.spec_from_file_location("delivery_trace_contract", root / "ci/trace_contract.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    trace_evidence = module.certify_traces(root, state)
    require(verify_pins(root) == state["inputs"], "input change before certification")
    require(not state.get("certified"), "run already certified")
    record = {"verdict": "CI-VERDICT PASS", "schema": 1, "time": now(), "run": state["run"],
              "snapshot": state["snapshot"], "inputs": state["inputs"], "job_ids": state["ids"],
              "sany": state["sany"],
              "trace_evidence": trace_evidence,
              "completed": [{k: v for k, v in job.items() if k != "traces"} for job in state["completed"]]}
    # A crash across the two writes cannot append a duplicate: re-entry into a
    # run without a pending completed ID is refused; this key is an extra audit.
    verdicts = root / "ci/verdicts.txt"
    if verdicts.exists():
        require(not any(json.loads(line).get("run") == state["run"]
                        for line in verdicts.read_text().splitlines()), "duplicate certification")
    append_json(verdicts, record)
    state["certified"] = True
    state["phase"] = "certified"
    atomic_json(directory / "state.json", state)
    print(f"CI-VERDICT PASS ({len(state['rows'])}/{len(state['rows'])} rows, snapshot {state['snapshot']})")


def verify_certificate(root: Path) -> dict:
    """One-byte staleness check used by the Test Writer and future E3 replay."""
    with storage.session(root / "ci/.runs"):
        return _verify_certificate(root)


def _verify_certificate(root: Path) -> dict:
    verdicts = root / "ci/verdicts.txt"
    require(verdicts.is_file() and bool(verdicts.read_text().splitlines()), "no certified suite")
    latest = json.loads(verdicts.read_text().splitlines()[-1])
    require(latest.get("schema") == 1 and latest.get("verdict") == "CI-VERDICT PASS", "invalid certificate")
    inputs = verify_pins(root)
    require(latest.get("inputs") == inputs and latest.get("snapshot") == snapshot_id(inputs), "stale certificate")
    require(bool(latest.get("job_ids")), "certificate has no scheduler jobs")
    require(bool(re.fullmatch(r"[a-f0-9]{32}", latest.get("run", ""))), "invalid certificate run")
    rows = load_manifest(root, False)
    plan = build_plan(rows, False)
    completed = latest.get("completed", [])
    require([job.get("job") for job in completed] == [job["name"] for job in plan]
            and [job.get("id") for job in completed] == latest["job_ids"]
            and len(set(latest["job_ids"])) == len(plan), "partial certificate groups")
    verified_completed = []
    accepted_work = {}
    for job, expected in zip(completed, plan):
        require([result.get("cfg") for result in job["results"]] == [row["cfg"] for row in expected["rows"]],
                "partial certificate group rows")
        directory = root / "ci/.runs" / latest["run"]
        results, traces = read_completed(directory, job, expected, latest["snapshot"])
        verified_completed.append(job if "logContainer" in job else {**job, "traces": traces})
        for row in expected["rows"]:
            if row["cfg"] not in {"probe_premise", "core_head_taken_in"}:
                continue
            selected = [trace for trace in traces if trace["cfg"] == row["cfg"]]
            require(len(selected) == 1, "missing/duplicate certified accepted-work witness")
            contract_spec = importlib.util.spec_from_file_location("certified_accepted_work", root / "ci/trace_contract.py")
            contract = importlib.util.module_from_spec(contract_spec)
            contract_spec.loader.exec_module(contract)
            worker_spec = importlib.util.spec_from_file_location("certified_accepted_work_worker", root / "jobs/lib/job.py")
            worker = importlib.util.module_from_spec(worker_spec)
            worker_spec.loader.exec_module(worker)
            result = next(entry for entry in results if entry["cfg"] == row["cfg"])
            _, metadata = contract.validate_envelope(root, latest, row, selected[0], worker, result=result)
            accepted_work[row["cfg"]] = {"jobId": job["id"], **metadata["acceptedWork"]}
    require(set(accepted_work) == {"probe_premise", "core_head_taken_in"}
            and latest.get("trace_evidence", {}).get("acceptedWork") == accepted_work,
            "certificate core/probe accepted-work witnesses mismatch")
    core = checked_core_coverage(root, rows, verified_completed, inputs, directory=directory)
    require(latest.get("trace_evidence", {}).get("coreCoverage") == core, "certificate core coverage mismatch")
    indexed = {row["cfg"]: row for row in rows}
    modes = {result["cfg"]: {"jobId": job["id"], "mode": result["mode"],
                             "simulation": result["simulation"], "result": result["result"],
                             "exhaustive": result["exhaustive"], "propertyStatus": result["propertyStatus"],
                             "simulationStats": result["simulationStats"],
                             "stateReduction": restart_reduction(indexed[result["cfg"]]),
                             "cfgSha256": inputs[indexed[result["cfg"]]["cfg_path"]]}
             for job in completed for result in job["results"]}
    require(latest.get("trace_evidence", {}).get("rowModes") == modes, "certificate row modes mismatch")
    verify_local_sany(root / "ci/.runs" / latest["run"],
                      {**latest, "rows": [{"spec": "PersonaDelivery", "spec_path": "PersonaDelivery.tla"}]})
    return latest


def close_failed_run(root: Path, directory: Path, state: dict, completed: str) -> None:
    """Retire a consumed failed collection using its saved terminal response.

    No scheduler call is made. This cannot abandon an outstanding job: the exact
    job's one-shot response must already prove it terminal. Raw logs stay intact.
    """
    outstanding = state.get("outstanding")
    require(outstanding is not None and outstanding["id"] == completed
            and outstanding.get("collect_attempted") is True, "no consumed collection for that job")
    response = read_json(directory / f"results-{completed}.json")
    require(response.get("id") == completed and response.get("terminal") is True,
            "cannot close a run without saved terminal evidence")
    append_json(root / "ci/jobs.jsonl", {"event": "run-closed-without-certification", "time": now(),
                                       "run": state["run"], "id": completed})
    state["phase"] = "failed"
    state["outstanding"] = None
    atomic_json(directory / "state.json", state)
    print("CI-VERDICT FAIL (failed run closed; all job evidence retained)")


def verify_collected_prefix(directory: Path, state: dict) -> None:
    """Validate retained evidence against its frozen plan, even after source edits."""
    require(not state.get("certified") and state["phase"] == "ready"
            and state.get("outstanding") is None, "run is not collected and uncertified")
    require(state["snapshot"] == snapshot_id(state["inputs"]), "saved snapshot mismatch")
    require(state["plan"] == build_plan(state["rows"], state["proof"]), "saved plan mismatch")
    require(0 < state["next"] <= len(state["plan"])
            and len(state["completed"]) == state["next"], "no complete collected prefix")
    require([entry["job"] for entry in state["completed"]]
            == [job["name"] for job in state["plan"][:state["next"]]], "collected prefix differs from plan")
    require([entry["id"] for entry in state["completed"]] == state["ids"]
            and len(set(state["ids"])) == len(state["ids"]), "job association mismatch")
    verify_local_sany(directory, state)
    for job, entry in zip(state["plan"], state["completed"]):
        response = read_json(directory / f"results-{entry['id']}.json")
        require(response.get("id") == entry["id"] and response.get("terminal") is True
                and response.get("state") == "succeeded", "missing successful terminal evidence")
        read_completed(directory, entry, job, state["snapshot"])


def retire_partial_run(root: Path, directory: Path, state: dict, reason: str) -> None:
    """Supersede only a successful collected partial snapshot, without querying jobs.

    Current source pins deliberately need not match: retirement cannot certify
    or advance old inputs. Frozen snapshot, plan, SANY and collected evidence are
    checked, retained and recorded; new start must rerun the complete new suite.
    """
    require(bool(reason.strip()) and not state.get("diagnostic"), "retirement requires a reason")
    verify_collected_prefix(directory, state)
    require(state["next"] < len(state["plan"]), "complete runs cannot use partial retirement")
    event = {"event": "run-superseded-without-certification", "time": now(), "run": state["run"],
             "snapshot": state["snapshot"], "job_ids": state["ids"], "completed_groups": state["next"],
             "total_groups": len(state["plan"]), "reason": reason, "certified": False}
    append_json(root / "ci/jobs.jsonl", event)
    state["retirement"] = event
    state["phase"] = "superseded"
    atomic_json(directory / "state.json", state)
    print("CI-VERDICT PARTIAL (superseded without certification; historical PASS evidence retained)")


def main(argv: list[str] | None = None, *, root: Path = ROOT, scheduler=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("operation", nargs="?", choices=("start", "resume", "collect", "advance", "retire", "close", "verify"), default="start")
    parser.add_argument("--print", action="store_true", dest="print_only")
    parser.add_argument("--proof", action="store_true")
    parser.add_argument("--run-dir", type=Path)
    parser.add_argument("--completed-job")
    parser.add_argument("--reason", help="required explanation for superseding a collected partial run")
    args = parser.parse_args(argv)
    try:
        for setting in ("TLA_GROUPS", "TLA_SPEC_DIR", "TLA_SUITE", "TLA_TIER", "TLA_POLL_S"):
            require(setting not in os.environ, f"{setting} overrides are refused; complete pinned suite required")
        executable = scheduler_path()
        inputs = verify_pins(root) if args.operation not in ("close", "retire") else None
        if args.operation == "verify":
            verify_certificate(root)
            print("CERTIFICATE CURRENT")
            return 0
        proof = args.proof
        if args.operation in ("resume", "collect", "close"):
            require(args.run_dir is not None and args.completed_job is not None and not args.proof
                    and not args.print_only and args.reason is None,
                    "resume/collect/close requires --run-dir and --completed-job only")
        elif args.operation in ("advance", "retire"):
            require(args.run_dir is not None and args.completed_job is None and not args.proof and not args.print_only,
                    "advance/retire requires --run-dir and no completed job")
            require(bool(args.reason and args.reason.strip()) if args.operation == "retire" else args.reason is None,
                    "retire requires --reason; advance forbids it")
        else:
            require(args.run_dir is None and args.completed_job is None and args.reason is None,
                    "start/verify cannot take run arguments")
        if args.print_only:
            rows = load_manifest(root, proof)
            print(json.dumps({"snapshot": snapshot_id(inputs), "proof": proof,
                              "jobs": build_plan(rows, proof)}, indent=2))
            return 0
        channel = os.environ.get("TLA_CHANNEL", "")
        require(bool(channel) and bool(re.fullmatch(r"[A-Z0-9]+", channel)), "TLA_CHANNEL is required; no default")
        if scheduler is None:
            scheduler = Scheduler(executable)
        with lock(root) as home:
            active_path = home / "active.json"
            if args.operation == "start":
                guard_active(home)
                rows = load_manifest(root, proof)
                plan = build_plan(rows, proof)
                if not proof:
                    verify_feasibility_profile(root, plan[0]["rows"])
                run_id = uuid.uuid4().hex
                directory = (home / run_id).resolve()
                directory.mkdir()
                state = {"schema": 1, "run": run_id, "phase": "preflight", "proof": proof,
                         "channel": channel, "scheduler": executable, "inputs": inputs, "snapshot": snapshot_id(inputs),
                         "rows": rows, "plan": plan, "next": 0,
                         "ids": [], "outstanding": None, "completed": []}
                atomic_json(directory / "state.json", state)
                atomic_json(active_path, {"directory": str(directory)})
                local_sany(root, directory, state)
            else:
                directory = args.run_dir.resolve()
                require(active_path.exists() and read_json(active_path)["directory"] == str(directory), "not the active run")
                state = read_json(directory / "state.json")
                require(not state.get("diagnostic"), "diagnostic run requires its probe.py collect command")
                if args.operation == "retire":
                    require(state["channel"] == channel and state["scheduler"] == executable,
                            "retirement channel/scheduler changed")
                    retire_partial_run(root, directory, state, args.reason)
                    return 0
                if args.operation == "close":
                    close_failed_run(root, directory, state, args.completed_job)
                    return 0
                require(state["inputs"] == inputs and state["snapshot"] == snapshot_id(inputs), "stale resume: inputs changed")
                require(state["channel"] == channel, "notice channel changed")
                require(state["scheduler"] == executable, "scheduler path changed since start")
                require(state["rows"] == load_manifest(root, state["proof"]), "manifest changed since start")
                require(state["plan"] == build_plan(state["rows"], state["proof"]), "run plan changed since start")
                verify_local_sany(directory, state)
                if args.operation == "advance":
                    require(state["phase"] == "ready" and state.get("outstanding") is None,
                            "advance requires a collected ready run with no outstanding job")
                    verify_collected_prefix(directory, state)
                    append_json(root / "ci/jobs.jsonl", {"event": "advance-authorized", "time": now(),
                                                        "run": state["run"], "snapshot": state["snapshot"]})
                else:
                    collect(root, directory, state, args.completed_job, scheduler)
                if args.operation == "collect":
                    append_json(root / "ci/jobs.jsonl", {"event": "collect-only", "time": now(),
                                "run": state["run"], "id": args.completed_job, "snapshot": state["snapshot"]})
                    print("CI-VERDICT PARTIAL (collected only; explicit advance or retire required)")
                    return 0
            if state["next"] < len(state["plan"]):
                submit_next(root, directory, state, scheduler)
            else:
                finish(root, directory, state)
        return 0
    except (Refusal, ValueError, KeyError, OSError, TypeError) as error:
        print(f"CI-VERDICT FAIL ({error})", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
