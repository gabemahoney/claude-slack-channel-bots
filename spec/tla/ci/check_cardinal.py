"""Run the complete delivery suite locally after a cardinal-rule model change.

Keeps the manifest's check/simulation modes and seeds. This produces new raw
TLC traces for fixture regeneration, not a scheduler certification. Each row's
bounded result and its actual property scope are retained in report.json.
"""
from __future__ import annotations
import argparse
from concurrent.futures import ThreadPoolExecutor
import gzip
import importlib.util
import hashlib
import json
from pathlib import Path
import re
import shutil
import subprocess
import sys
import time
import runner


def auxiliary_rows(root):
    rows = runner.load_manifest(root, True)
    for row in rows:
        row['auxiliary'] = True
    inventory = [('safety', '-', 'pass'),
                 ('delivery_reachable', 'NotDelivered', 'violation'),
                 ('premise_reachable', 'NotPremise', 'violation'),
                 ('eventually_delivered', 'EventuallyDelivered', 'violation'),
                 ('head_taken_in', 'HeadTakenIn', 'violation')]
    for cfg, prop, expect in inventory:
        path = f'ci/fairness-probe/cfg/{cfg}.cfg'
        checks = runner.checks_of((root / path).read_text())
        rows.append({'cfg': 'permission_' + cfg, 'cfg_path': path,
                     'spec': 'PermissionFairness', 'spec_path': 'ci/fairness-probe/PermissionFairness.tla',
                     'checks': checks['INVARIANT'] + checks['PROPERTY'],
                     'properties': checks['PROPERTY'], 'props': prop,
                     'mode': 'check', 'simulation': None, 'expect': expect,
                     'auxiliary': True})
    return rows


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--java', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--seconds', type=int, default=120)
    parser.add_argument('--workers', type=int, default=2)
    parser.add_argument('--proofs', action='store_true', help='retain independent work/replay/contrast bundles')
    parser.add_argument('--cfg', action='append', help='targeted diagnostic rerun only')
    args = parser.parse_args()
    live_root = runner.ROOT
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=False)
    source_inputs = {}
    root = output / 'source'
    for source_path in runner.input_paths(live_root):
        relative = source_path.relative_to(live_root)
        content = source_path.read_bytes()
        source_inputs[str(relative)] = hashlib.sha256(content).hexdigest()
        frozen = root / relative
        frozen.parent.mkdir(parents=True, exist_ok=True)
        frozen.write_bytes(content)
    rows = runner.load_manifest(root, False) + auxiliary_rows(root)
    if args.cfg:
        unknown = set(args.cfg) - {r['cfg'] for r in rows}
        if unknown:
            parser.error(f'unknown cfgs: {sorted(unknown)}')
        rows = [r for r in rows if r['cfg'] in args.cfg]
    spec = importlib.util.spec_from_file_location('cardinal_worker', root / 'jobs/lib/job.py')
    worker = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(worker)
    sys.modules['worker'] = worker
    permission_spec = importlib.util.spec_from_file_location('cardinal_permission', root / 'ci/fairness-probe/job.py')
    permission_helper = importlib.util.module_from_spec(permission_spec)
    permission_spec.loader.exec_module(permission_helper)
    temporal_spec = importlib.util.spec_from_file_location('cardinal_temporal', root / 'ci/temporal_sensitivity.py')
    temporal_helper = importlib.util.module_from_spec(temporal_spec)
    temporal_spec.loader.exec_module(temporal_helper)
    report = {'certification': False, 'partial': bool(args.cfg), 'rows': [], 'auxiliaryRows': [],
              'expectedRows': sum(not r.get('auxiliary', False) for r in rows),
              'expectedAuxiliaryRows': sum(r.get('auxiliary', False) for r in rows),
              'modelSha256': source_inputs['PersonaDelivery.tla'], 'inputs': source_inputs}

    def check(row):
        directory = output / row['cfg']
        directory.mkdir()
        metadir = directory / 'states'
        argv = [str(args.java.resolve()), '-XX:ActiveProcessorCount=1', '-Xmx384m',
                '-cp', str(root / 'tla2tools.jar'), 'tlc2.TLC', '-noGenerateSpecTE', '-workers', '1',
                '-metadir', str(metadir), '-config', str(root / row['cfg_path'])]
        if row['mode'] == 'simulate':
            sample = row['simulation']
            argv += ['-simulate', f"num={sample['num']}", '-depth', str(sample['depth']),
                     '-seed', str(sample['seed'])]
        argv += [str((root / row['spec_path']).with_suffix(''))]
        started = time.monotonic()
        timeout = False
        log_path = directory / 'run.log'
        with log_path.open('w') as log:
            try:
                result = subprocess.run(argv, cwd=root, stdout=log, stderr=subprocess.STDOUT,
                                        timeout=args.seconds)
                rc = result.returncode
            except subprocess.TimeoutExpired:
                rc, timeout = None, True
        log_sha256 = hashlib.sha256(log_path.read_bytes()).hexdigest()
        text = log_path.read_text()
        violation = re.search(r'(?:Invariant (\w+) is violated|Temporal propert(?:ies were violated|y \w+ was violated))', text)
        temporal = bool(violation and violation[1] is None)
        temporal_names = re.findall(r'Temporal property (\w+) was violated', text)
        expected = row['props'].split(',') if row['props'] != '-' else []
        ok = (not timeout and ((row['expect'] == 'pass' and rc == 0
                               and ('Model checking completed. No error has been found.' in text
                                    or 'The number of states generated:' in text))
                              or (row['expect'] == 'violation' and violation
                                  and ((temporal and temporal_names and set(temporal_names) <= set(expected))
                                       or violation[1] in expected))))
        traces = []
        for line in text.splitlines():
            if line.startswith(chr(34) + 'TRACE '):
                line = json.loads(line)
            if line.startswith('TRACE '):
                traces.append(json.loads(line[6:]))
        ok = ok and worker.result_matches(row, worker.classify(text, rc, row['mode']))
        initial = re.search(r'Finished computing initial states: ([0-9,]+) distinct state', text)
        initial_count = int(initial[1].replace(',', '')) if initial else None
        ok = ok and (row['mode'] == 'simulate' or bool(initial_count))
        if row['mode'] == 'simulate':
            ok = ok and len(traces) == row['simulation']['num']
        proof_error = None
        if ok and row['cfg'] in {'permission_eventually_delivered', 'permission_head_taken_in'}:
            try:
                if len(traces) != 1:
                    raise ValueError('permission diagnostic needs one complete lasso')
                evidence = permission_helper.lasso_evidence(traces[0], row['cfg'])
                (directory / 'permission-lasso.json').write_text(json.dumps(evidence, indent=2)+'\n')
            except Exception as error:
                proof_error = type(error).__name__ + ': ' + str(error)
                ok = False
        if args.proofs and ok:
            try:
                deadline = started + args.seconds
                envelope = {'raw': traces[0] if traces else None}
                if row['cfg'] in worker.WORK_WITNESS_ROWS:
                    helper = worker.load_work_witness(root / 'ci/work_witness.py')
                    worker.attach_accepted_work(helper, root / row['spec_path'], root / row['cfg_path'],
                                                root / 'tla2tools.jar', args.java.resolve(),
                                                directory / 'accepted-work', envelope, started, deadline)
                    if row['cfg'] == 'core_head_taken_in':
                        envelope['raw'] = envelope['acceptedWork']['payload']['raw']
                        traces = [envelope['raw']]
                elif row['cfg'] in runner.ALL_CONTROLS and row['properties']:
                    temporal_helper.attach(root, row, envelope, directory / 'temporal-proof',
                                    args.java.resolve(), deadline=deadline, seconds=60)
                else:
                    envelope = None
                if envelope is not None:
                    (directory / 'proof-envelope.json').write_text(json.dumps(envelope, separators=(',', ':'))+'\n')
            except Exception as error:
                proof_error = type(error).__name__ + ': ' + str(error)
                ok = False
        if traces:
            (directory / 'traces.json').write_text(json.dumps(traces, separators=(',', ':')) + '\n')
        entry = {'cfg': row['cfg'], 'mode': row['mode'], 'expect': row['expect'],
                 'auxiliary': row.get('auxiliary', False),
                 'checks': row['checks'], 'properties': row['properties'], 'simulation': row['simulation'],
                 'argv': argv, 'exitCode': rc, 'timeout': timeout, 'matched': bool(ok),
                 'violation': violation[1] if violation and not temporal else 'temporal' if temporal else None,
                 'seconds': round(time.monotonic()-started, 3), 'traces': len(traces),
                 'proofsRequested': args.proofs, 'proofError': proof_error,
                 'initialDistinct': initial_count,
                 'temporalVerified': (row['mode'] == 'check' and bool(row['properties'])
                                      and row['expect'] == 'pass' and bool(ok)),
                 'temporalCounterexample': temporal_names,
                 'propertyStatus': {p: ('UNVERIFIED' if row['mode'] == 'simulate' else
                                       'VERIFIED' if row['expect'] == 'pass' and ok else
                                       'EXPECTED-COUNTEREXAMPLE' if ok else 'UNVERIFIED')
                                    for p in row['properties']}}
        with log_path.open('rb') as source, gzip.open(str(log_path)+'.gz', 'wb') as archive:
            shutil.copyfileobj(source, archive)
        log_path.unlink()
        entry['logSha256'] = log_sha256
        shutil.rmtree(metadir, ignore_errors=True)
        for scratch in directory.glob('**/states'):
            if scratch.is_dir():
                shutil.rmtree(scratch)
        print(json.dumps(entry), flush=True)
        return entry

    with ThreadPoolExecutor(max_workers=args.workers) as pool:
        for entry in pool.map(check, rows):
            report['auxiliaryRows' if entry['auxiliary'] else 'rows'].append(entry)
            (output / 'report.json').write_text(json.dumps(report, indent=2) + '\n')
    current_inputs = {str(path.relative_to(live_root)): hashlib.sha256(path.read_bytes()).hexdigest()
                      for path in runner.input_paths(live_root)}
    report['inputsUnchanged'] = current_inputs == source_inputs
    (output / 'report.json').write_text(json.dumps(report, indent=2) + '\n')
    raise SystemExit(0 if report['inputsUnchanged'] and
                     all(r['matched'] for r in report['rows'] + report['auxiliaryRows']) else 1)


if __name__ == '__main__':
    main()
