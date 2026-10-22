#!/usr/bin/env python3
"""execute the actual shell runner with harmless scripts, inside CI only.

Mount tests/runner.sh at /source/runner.sh (read-only), this file at /controls.py,
a fresh regular lock file read-only at /run/cscb-ci-performance.lock,
and disposable tmpfs directories at /tmp, /test-results and /test-repo. Run this
driver as root in an existing cscb-ci image with networking disabled. It launches
the runner as testuser (or nobody in a base image); it never launches integration
scenarios or native agents.
The root-owned survivor case is deliberately unkillable by that runner user.
"""
from contextlib import contextmanager
import fcntl
import json
import os
from pathlib import Path
import pwd
import shutil
import signal
import subprocess
import sys
import tempfile
import time
from types import SimpleNamespace


def require(condition, reason):
    if not condition:
        raise AssertionError(reason)


FINAL_CLEANUP_FAILURE = "FAIL: runner.sh: unsafe-cleanup"


def unsafe_cleanup_complete(lines, diagnostic, script_count):
    outcomes = [line for line in lines if line.startswith(("end ", "notrun "))]
    return len(outcomes) == script_count and FINAL_CLEANUP_FAILURE in diagnostic.splitlines()


def require_unsafe_ownership(proc, survivor, lines, diagnostic, *, exclusive=False):
    require(FINAL_CLEANUP_FAILURE in diagnostic.splitlines(), "missing final cleanup failure diagnostic")
    require("done" not in lines, f"unsafe final cleanup emitted normal completion: {lines}")
    require(survivor is not None and survivor.poll() is None, "root-owned survivor was not alive")
    require(proc.poll() is None, "runner released safety ownership by exiting")
    require(not lock_available(fcntl.LOCK_EX), "unsafe final cleanup released the guard")
    require(lock_available(fcntl.LOCK_SH) != exclusive, "unsafe final cleanup changed the guard mode")


def require_retired_guard():
    # Reaped driver-owned children may leave an orphaned flock briefly exiting.
    deadline = time.monotonic() + 5
    while not lock_available(fcntl.LOCK_EX) and time.monotonic() < deadline:
        time.sleep(0.01)
    require(lock_available(fcntl.LOCK_EX), "retirement leaked the performance lease")


@contextmanager
def runner_fixture(prefix):
    try:
        user = pwd.getpwnam("testuser")
    except KeyError:
        user = pwd.getpwnam("nobody")
    with tempfile.TemporaryDirectory(prefix=prefix, dir="/tmp") as scratch:
        root = Path(scratch)
        os.chmod(root, 0o755)
        home = root / "home"
        home.mkdir()
        os.chown(home, user.pw_uid, user.pw_gid)
        tests = root / "tests"
        integration = tests / "integration"
        integration.mkdir(parents=True)
        shutil.copyfile("/source/runner.sh", tests / "runner.sh")
        results = Path("/test-results")
        for entry in results.iterdir():
            if entry.is_dir():
                shutil.rmtree(entry)
            else:
                entry.unlink()
        os.chown(results, user.pw_uid, user.pw_gid)
        modules = Path("/test-repo/node_modules/fixture")
        modules.mkdir(parents=True, exist_ok=True)
        (modules / "package.json").write_text('{"name":"fixture","version":"1.0.0"}\n')
        Path("/tmp/package.tgz").write_bytes(b"runner fixture: no install or native agent\n")

        def become_testuser():
            os.setgroups([])
            os.setgid(user.pw_gid)
            os.setuid(user.pw_uid)

        child_env = {"HOME": str(home), "SLACK_STATE_DIR": str(home / "state"),
                     "PATH": "/usr/bin:/bin", "LC_ALL": "C"}
        fixture = SimpleNamespace(root=root, home=home, tests=tests,
                                  integration=integration, results=results,
                                  child_env=child_env, runner=None, survivor=None)

        def launch(args, log):
            require(fixture.runner is None, "fixture already owns a runner")
            fixture.runner = subprocess.Popen(args, env=child_env, stdout=log,
                                              stderr=subprocess.STDOUT,
                                              start_new_session=True, preexec_fn=become_testuser)
            return fixture.runner

        fixture.launch = launch
        try:
            yield fixture
        finally:
            # Only the driver's own disposable process group and survivor.
            if fixture.runner is not None:
                try:
                    os.killpg(fixture.runner.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                fixture.runner.wait(timeout=5)
            if fixture.survivor is not None:
                fixture.survivor.kill()
                fixture.survivor.wait(timeout=5)
            require_retired_guard()


def run_case(name, keep_going=True, *, orphan=False, unsafe=False,
             bootstrap_failure=False, injected=False, all_pass=False, final_cleanup=False):
    with runner_fixture("runner-pb8-") as fixture:
        root, home, tests = fixture.root, fixture.home, fixture.tests
        integration, results = fixture.integration, fixture.results
        names = {n: f"test-{n}-runner-control.sh" for n in range(1, 7)}
        trace = home / "trace"
        orphan_pid = home / "orphan.pid"
        trigger = home / "root-survivor-request"
        ready = home / "root-survivor-ready"
        if final_cleanup:
            # Synchronize the adversary at the exact final-cleanup boundary in
            # a scratch copy. All production cleanup, result and lock code is
            # unchanged; no production test seam or injected cleanup answer.
            runner_copy = tests / "runner.sh"
            source = runner_copy.read_text()
            boundary = "# Release the performance guard only once even the baseline daemon is gone."
            require(source.count(boundary) == 1, "missing unique final-cleanup boundary")
            barrier = f"touch '{trigger}'\nwhile [[ ! -e '{ready}' ]]; do sleep 0.01; done\n"
            runner_copy.write_text(source.replace(boundary, barrier + boundary))
        bodies = {
            1: "exit 1\n" if bootstrap_failure else "exit 0\n",
            2: "exit 0\n" if all_pass else "exit 1\n",
            3: "exit 0\n", 4: "exit 0\n", 5: "exit 0\n",
            6: "exit 0\n" if all_pass else "exit 1\n",
        }
        if orphan:
            # TERM-resistant child in the disposable namespace. The following
            # independent script refuses to run successfully until it is gone.
            bodies[2] = f"bash -c 'trap \"\" TERM; exec sleep 300' &\nprintf '%s\\n' \"$!\" > '{orphan_pid}'\nexit 1\n"
            bodies[4] = f"""pid=$(cat '{orphan_pid}')
if [[ -r /proc/$pid/stat ]] && [[ $(awk '{{print $3}}' /proc/$pid/stat) != Z ]]; then
    echo 'runner control: preceding child survived cleanup' >&2
    exit 1
fi
exit 0
"""
        if unsafe:
            # The parent creates the root process after the runner's initial
            # baseline, then acknowledges it. No test-only cleanup seam exists.
            bodies[2] = f"touch '{trigger}'\nwhile [[ ! -e '{ready}' ]]; do sleep 0.01; done\nexit 1\n"
        for n, filename in names.items():
            dependency = "# ci-requires: test-2\n" if n == 3 else f"# ci-requires: {names[3]}\n" if n == 5 else ""
            (integration / filename).write_text(
                f"#!/usr/bin/env bash\n{dependency}set -eu\nprintf '%s\\n' '{n}' >> '{trace}'\n{bodies[n]}"
            )
        args = ["bash", str(tests / "runner.sh"), "1", "a" * 32]
        if keep_going:
            args += ["--keep-going"]
        if injected:
            args += ["--fail", names[2]]
        args += list(names.values())

        output = root / "runner-output"
        with output.open("w") as log:
            proc = fixture.launch(args, log)
            # Only a diagnostic bound. Safe completion needs durable done;
            # unsafe completion needs all outcomes and the final diagnostic.
            deadline = time.monotonic() + 20
            lines = []
            while time.monotonic() < deadline:
                if (unsafe or final_cleanup) and trigger.exists() and fixture.survivor is None:
                    fixture.survivor = subprocess.Popen(["sleep", "300"], env=fixture.child_env,
                                                       start_new_session=True)
                    ready.touch()
                result = results / "result.txt"
                lines = result.read_text().splitlines() if result.exists() else []
                if "done" in lines or proc.poll() is not None:
                    break
                if (unsafe or final_cleanup) and unsafe_cleanup_complete(lines, output.read_text(), len(names)):
                    break
                time.sleep(0.01)
            diagnostic = output.read_text().strip()
            if unsafe or final_cleanup:
                require(unsafe_cleanup_complete(lines, diagnostic, len(names)), f"incomplete unsafe cleanup evidence: {lines}")
                require_unsafe_ownership(proc, fixture.survivor, lines, diagnostic)
            else:
                require("done" in lines, f"no durable done event; exit={proc.poll()}; output={diagnostic}")
                require(lines.count("done") == 1 and lines[-1] == "done", "done must occur once, last")
            events = [line.split() for line in lines]
            starts = [event[1] for event in events if event[0] == "start"]
            ends = {event[1]: event[2] for event in events if event[0] == "end"}
            skipped = {event[1]: event[2:] for event in events if event[0] == "notrun"}
            actual = trace.read_text().splitlines() if trace.exists() else []
            require(len(starts) == len(set(starts)), "a script was retried")
            require(len(starts) + len(skipped) == len(names), "every script needs an outcome")
            require(set(starts) == set(ends), "every start needs an end")
            if all_pass:
                require(ends == {file: "pass" for file in names.values()}, f"all-pass control: {lines}")
                require(actual == [str(n) for n in names], f"all-pass execution order: {actual}")
            elif not keep_going:
                require(starts == [names[1], names[2]], f"default must fail fast: {starts}")
                require(ends == {names[1]: "pass", names[2]: "fail"}, f"failure retained: {ends}")
                require(set(skipped) == set(list(names.values())[2:]), f"default notrun coverage: {skipped}")
                require(actual == ["1", "2"], f"default executed later work: {actual}")
            elif bootstrap_failure:
                require(starts == [names[1]] and ends[names[1]] == "fail", "failed bootstrap ran another script")
                require(all(skipped.get(names[n]) == [f"dependency:{names[1]}"] for n in range(2, 7)), f"implicit test-1 dependency reasons: {skipped}")
            elif unsafe:
                require(starts == [names[1], names[2]], f"unsafe cleanup ran later work: {starts}")
                require(ends == {names[1]: "pass", names[2]: "fail"}, f"unsafe failure outcomes: {ends}")
                require(skipped == {names[n]: ["unsafe-cleanup"] for n in range(3, 7)}, f"unsafe cleanup reasons: {skipped}")
                require(actual == ["1", "2"], f"unsafe cleanup executed later work: {actual}")
            else:
                require(starts == [names[1], names[2], names[4], names[6]], f"independent work was not collected: {starts}")
                require(ends == {names[1]: "pass", names[2]: "fail", names[4]: "pass", names[6]: "fail"}, f"all independent outcomes retained: {ends}")
                require(skipped == {names[3]: [f"dependency:{names[2]}"], names[5]: [f"dependency:{names[3]}"]}, f"direct/transitive dependency reasons: {skipped}")
                expected_trace = ["1", "4", "6"] if injected else ["1", "2", "4", "6"]
                require(actual == expected_trace, f"dependency execution or retry: {actual}")
            report = {"case": name, "pass": True, "events": lines, "executed": actual}
            if unsafe or final_cleanup:
                report.update(final_cleanup_diagnostic=FINAL_CLEANUP_FAILURE,
                              done_withheld=True, survivor_alive=True, runner_alive=True,
                              guard_held_until_retirement="shared")
            if final_cleanup:
                report["all_scripts_passed"] = True
    report["guard_free_after_retirement"] = True
    return report



LOCK = "/run/cscb-ci-performance.lock"


def lock_available(mode):
    # A new open description must contend even against this driver's own lock.
    with open(LOCK, "rb") as probe:
        try:
            fcntl.flock(probe, mode | fcntl.LOCK_NB)
        except BlockingIOError:
            return False
        fcntl.flock(probe, fcntl.LOCK_UN)
        return True


def run_performance_case(name, *, failed=False, unsafe=False, cancel=False, cancel_active=False):
    with runner_fixture("runner-lock-pb8-") as fixture:
        root, home, tests = fixture.root, fixture.home, fixture.tests
        integration, results = fixture.integration, fixture.results
        names = {n: f"test-{n}-runner-lock.sh" for n in (1, 2, 32, 33)}
        for n, filename in names.items():
            body = f"touch '{home}/{n}.entered'\n"
            if n in (2, 32, 33):
                body += f"while [[ ! -f '{home}/{n}.release' ]]; do sleep 0.01; done\n"
            body += f"exit {1 if n == 32 and (failed or unsafe) else 0}\n"
            (integration / filename).write_text("#!/usr/bin/env bash\nset -eu\n" + body)
        output = root / "output"
        observed = []
        # Hold a competing ordinary-work lease in an infrastructure process
        # present before the runner snapshots /proc. This is the real shared inode.
        with open(LOCK, "rb") as external, output.open("w") as log:
            fcntl.flock(external, fcntl.LOCK_SH)
            proc = fixture.launch(["bash", str(tests / "runner.sh"), "1", "b" * 32,
                                   "--keep-going", *names.values()], log)
            released = False
            deadline = time.monotonic() + 25
            while time.monotonic() < deadline:
                if (home / "2.entered").exists() and "shared" not in observed:
                    fcntl.flock(external, fcntl.LOCK_UN)
                    require(lock_available(fcntl.LOCK_SH), "ordinary runner excludes shared work")
                    require(not lock_available(fcntl.LOCK_EX), "ordinary runner lacks shared guard")
                    fcntl.flock(external, fcntl.LOCK_SH)
                    observed.append("shared")
                    (home / "2.release").touch()
                # test-32's pre-measurement cleanup is durable evidence that
                # the runner reached the exclusive transition. Our shared
                # lock forbids its body from entering until we release it.
                measurement_log = results / (names[32] + ".log")
                if measurement_log.exists() and "cleanup: verified" in measurement_log.read_text() and not released:
                    require(not (home / "32.entered").exists(), "measurement overlapped ordinary lease")
                    observed.append("waited-for-shared")
                    if cancel:
                        # Container retirement kills the whole owned process
                        # group, including a blocked flock child.
                        os.killpg(proc.pid, signal.SIGKILL)
                        proc.wait(timeout=5)
                        fcntl.flock(external, fcntl.LOCK_UN)
                        released = True
                        require(not (home / "33.entered").exists(), "cancellation ran later work")
                        break
                    fcntl.flock(external, fcntl.LOCK_UN)
                    released = True
                if (home / "32.entered").exists() and "exclusive" not in observed:
                    require(not lock_available(fcntl.LOCK_SH), "measurement admits ordinary work")
                    require(not lock_available(fcntl.LOCK_EX), "measurement admits another measurement")
                    observed.append("exclusive")
                    if cancel_active:
                        os.killpg(proc.pid, signal.SIGKILL)
                        proc.wait(timeout=5)
                        require(not (home / "33.entered").exists(), "active cancellation ran later work")
                        break
                    if unsafe:
                        fixture.survivor = subprocess.Popen(["sleep", "300"], env=fixture.child_env,
                                                           start_new_session=True)
                    (home / "32.release").touch()
                if (home / "33.entered").exists() and "shared-again" not in observed:
                    require(not unsafe, "unsafe measurement cleanup admitted more work")
                    require(lock_available(fcntl.LOCK_SH), "post-measurement work retains exclusive guard")
                    require(not lock_available(fcntl.LOCK_EX), "post-measurement work lacks shared guard")
                    observed.append("shared-again")
                    (home / "33.release").touch()
                result = results / "result.txt"
                lines = result.read_text().splitlines() if result.exists() else []
                if "done" in lines or (unsafe and unsafe_cleanup_complete(lines, output.read_text(), len(names))):
                    events = [line.split() for line in lines]
                    starts = [event[1] for event in events if event[0] == "start"]
                    ends = {event[1]: event[2] for event in events if event[0] == "end"}
                    skipped = {event[1]: event[2:] for event in events if event[0] == "notrun"}
                    executed = [names[n] for n in ((1, 2, 32) if unsafe else names)]
                    require(starts == executed, f"unexpected performance script execution: {starts}")
                    expected_ends = {file: "pass" for file in executed}
                    expected_ends[names[32]] = "fail" if failed or unsafe else "pass"
                    require(ends == expected_ends, f"wrong performance outcomes: {ends}")
                    measurement = [event[2] for event in events if event[:2] == ["end", names[32]]]
                    require(measurement == [expected_ends[names[32]]], "measurement must have exactly one outcome")
                    if unsafe:
                        require(skipped == {names[33]: ["unsafe-cleanup"]}, f"unsafe cleanup reasons: {skipped}")
                        require(not (home / "33.entered").exists(), "unsafe cleanup executed later work")
                        require_unsafe_ownership(proc, fixture.survivor, lines, output.read_text(), exclusive=True)
                    else:
                        require(not skipped, f"safe cleanup skipped work: {skipped}")
                        require(lines.count("done") == 1 and lines[-1] == "done", "done must occur once, last")
                        require(lock_available(fcntl.LOCK_EX), "safe cleanup retained the guard")
                    break
                require(proc.poll() is None, f"runner exited: {output.read_text()}")
                time.sleep(0.01)
            else:
                raise AssertionError(f"runner deadline: {output.read_text()}")
            expected = ["shared", "waited-for-shared"]
            if not cancel:
                expected += ["exclusive"] + ([] if unsafe or cancel_active else ["shared-again"])
            require(observed == expected, f"lock transition evidence: {observed}")
        report = {"case": name, "pass": True, "transitions": observed}
        if unsafe:
            report.update(events=lines, final_cleanup_diagnostic=FINAL_CLEANUP_FAILURE,
                          done_withheld=True, survivor_alive=True, runner_alive=True,
                          guard_held_until_retirement="exclusive")
    report["guard_free_after_retirement"] = True
    return report

def main():
    if not Path("/etc/cscb-ci-image").is_file():
        print("runner controls refuse outside a cscb-ci image", file=sys.stderr)
        return 2
    cases = [
        ("default all-pass control", {"keep_going": False, "all_pass": True}),
        ("default fail-fast control", {"keep_going": False}),
        ("keep-going all-pass", {"all_pass": True}),
        ("late final-cleanup survivor cannot produce normal completion", {"all_pass": True, "final_cleanup": True}),
        ("independent failures and transitive dependency skips", {}),
        ("failed bootstrap blocks all dependents", {"bootstrap_failure": True}),
        ("verified orphan cleanup before independent work", {"orphan": True}),
        ("unremovable survivor blocks continuation", {"unsafe": True}),
        ("injected failure still skips dependents and collects independent work", {"injected": True}),
    ]
    performance_cases = [
        ("shared/exclusive/shared performance isolation", {}),
        ("failed measurement cleans up and continues under shared guard", {"failed": True}),
        ("unsafe measurement retains exclusive guard until retirement", {"unsafe": True}),
        ("cancellation while waiting exclusive releases all lock descriptors", {"cancel": True}),
        ("cancellation during exclusive measurement releases the guard", {"cancel_active": True}),
    ]
    cases = [(run_case, name, options) for name, options in cases] + [
        (run_performance_case, name, options) for name, options in performance_cases]
    if len(sys.argv) > 1:
        cases = [case for case in cases if sys.argv[1] in case[1]]
        require(bool(cases), "unknown control selector")
    failed = 0
    for run, name, options in cases:
        try:
            result = run(name, **options)
        except Exception as error:
            failed += 1
            result = {"case": name, "pass": False, "reason": str(error)}
        print(json.dumps(result), flush=True)
    print(json.dumps({"passed": len(cases) - failed, "failed": failed}))
    return int(failed > 0)


if __name__ == "__main__":
    sys.exit(main())
