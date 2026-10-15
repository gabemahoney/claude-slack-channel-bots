"""Bound local .runs storage; canonical checker artifacts remain separate.

The 256 MiB stop margin covers polling latency and small summary writes. This
is an admission/watchdog budget, not a filesystem quota against other writers.
"""
from __future__ import annotations

from contextlib import contextmanager
import base64
import fcntl
import gzip
import hashlib
import json
import os
from pathlib import Path
import resource
import re
import shutil
import signal
import stat
import subprocess
import sys
import tempfile
import time
import zlib

LIMIT = 2 * 1024**3
HEADROOM = 256 * 1024**2
FILE_LIMIT = 128 * 1024**2
LOG_LIMIT = 128 * 1024**2
ACTIVE_KEY = "_tla_local_storage"
ENVELOPE_LIMIT = 256 * 1024**2
# Limits for canonical collection are independent of the local child file cap.
CANONICAL_LOG_LIMIT = 1024**3
CHUNK = 1024**2


class StorageRefusal(ValueError):
    def __init__(self, message, *, limit_type=None, limit_bytes=None, observed_bytes=None):
        super().__init__(message)
        self.telemetry = {"limitType": limit_type, "limitBytes": limit_bytes,
                          "observedBytes": observed_bytes}


def log_telemetry(stream):
    """Read only small ends of even an oversized log before deleting scratch."""
    size = os.fstat(stream.fileno()).st_size
    stream.seek(0)
    head = stream.read(65536)
    stream.seek(max(0, size - 65536))
    text = (head + b"\n" + stream.read(65536)).decode(errors="replace")
    counts = re.findall(r"([\d,]+) states generated, ([\d,]+) distinct states found, ([\d,]+) states left on queue", text)
    initial = re.search(r"Finished computing initial states: ([\d,]+) distinct state", text)
    progress = re.findall(r"Progress\((\d+)\) at ([^\n]+)", text)
    return {"logBytes": size, "initialDistinct": int(initial[1].replace(",", "")) if initial else None,
            "finalCounts": [int(n.replace(",", "")) for n in counts[-1]] if counts else None,
            "lastProgress": progress[-1][1][:1000] if progress else None}


def runs_home(path):
    candidates = [p for p in (Path(path).resolve(), *Path(path).resolve().parents) if p.name == ".runs"]
    return candidates[-1] if candidates else None


def footprint(path):
    """Count both allocated and apparent bytes (including sparse files)."""
    allocated = apparent = 0
    def failed(error):
        raise error
    for directory, _, names in os.walk(path, onerror=failed):
        for name in [".", *names]:
            try:
                info = (Path(directory) / name).lstat()
            except FileNotFoundError:
                continue  # TLC concurrently removes scratch files.
            allocated += info.st_blocks * 512
            apparent += info.st_size
    return max(allocated, apparent)


def check(path, incoming=0, *, limit=LIMIT, headroom=HEADROOM):
    active = sys.modules.get(ACTIVE_KEY)
    if active is not None and (limit, headroom) == (LIMIT, HEADROOM):
        limit, headroom = active.limit, active.headroom
    home = runs_home(path)
    if home is None and active is not None:
        home = active.home
    observed = footprint(home) if home is not None and home.exists() else 0
    if observed + incoming >= limit - headroom:
        raise StorageRefusal("local .runs storage budget exhausted; remove unneeded diagnostics before retrying",
                             limit_type="runs-budget", limit_bytes=limit - headroom,
                             observed_bytes=observed + incoming)
    return observed


def regular_file(path, mode="rb"):
    """Never follow a symlink in any component of an evidence path."""
    path = Path(path).absolute()
    if ".." in path.parts:
        raise StorageRefusal("escaping evidence path")
    flags = os.O_RDONLY | os.O_NONBLOCK if mode == "rb" else os.O_WRONLY | os.O_CREAT | os.O_EXCL
    directory = os.open(path.anchor, os.O_RDONLY | os.O_DIRECTORY)
    try:
        for component in path.parts[1:-1]:
            child = os.open(component, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=directory)
            os.close(directory)
            directory = child
        fd = os.open(path.name, flags | os.O_NOFOLLOW, 0o600, dir_fd=directory)
    finally:
        os.close(directory)
    if not stat.S_ISREG(os.fstat(fd).st_mode):
        os.close(fd)
        raise StorageRefusal("evidence is not a regular file")
    return os.fdopen(fd, mode)


def file_digest(path):
    digest = hashlib.sha256()
    with regular_file(path) as source:
        before = os.fstat(source.fileno())
        remaining = before.st_size
        while remaining:
            content = source.read(min(CHUNK, remaining))
            if not content:
                raise StorageRefusal("evidence shrank during hashing")
            digest.update(content)
            remaining -= len(content)
        after = os.fstat(source.fileno())
        if (source.read(1) or (before.st_size, before.st_mtime_ns, before.st_ctime_ns)
                != (after.st_size, after.st_mtime_ns, after.st_ctime_ns)):
            raise StorageRefusal("evidence changed during hashing")
    return digest.hexdigest()


def _compress(source, output=None, *, target=None, reserve=0, maximum=None):
    compressor = zlib.compressobj(9, zlib.DEFLATED, 16 + zlib.MAX_WBITS)
    raw_hash, packed_hash = hashlib.sha256(), hashlib.sha256()
    size = packed_size = 0
    while content := source.read(CHUNK):
        size += len(content)
        if size > CANONICAL_LOG_LIMIT:
            raise StorageRefusal("canonical log expansion limit exceeded")
        raw_hash.update(content)
        packed = compressor.compress(content)
        packed_size += len(packed)
        packed_hash.update(packed)
        if output is not None:
            if maximum is not None and packed_size > maximum:
                raise StorageRefusal("canonical source grew during compression")
            check(target, len(packed) + reserve + 4096)
            output.write(packed)
    packed = compressor.flush()
    packed_size += len(packed)
    packed_hash.update(packed)
    if output is not None:
        if maximum is not None and packed_size > maximum:
            raise StorageRefusal("canonical source grew during compression")
        check(target, len(packed) + reserve + 4096)
        output.write(packed)
    return {"schema": 1, "codec": "gzip", "bytes": size, "sha256": raw_hash.hexdigest(),
            "storedBytes": packed_size, "storedSha256": packed_hash.hexdigest()}


def compress_file(source, target, *, reserve=0):
    """Measure exact compressed incoming bytes before writing; retain the input.

    Both passes use one open descriptor and compare all lengths/hashes and file
    metadata. A failed write removes only this call's exclusive partial file.
    """
    target = Path(target)
    temporary = target.with_name(target.name + ".partial")
    owned = False
    with regular_file(source) as stream:
        before = os.fstat(stream.fileno())
        if before.st_size > CANONICAL_LOG_LIMIT:
            raise StorageRefusal("oversized canonical log")
        reference = _compress(stream)
        check(target, reference["storedBytes"] + reserve + 8192)
        if target.exists() or target.is_symlink():
            raise StorageRefusal("canonical log already exists")
        stream.seek(0)
        try:
            with regular_file(temporary, "wb") as output:
                owned = True
                observed = _compress(stream, output, target=target, reserve=reserve,
                                     maximum=reference["storedBytes"])
                after = os.fstat(stream.fileno())
                if (reference != observed or (before.st_size, before.st_mtime_ns, before.st_ctime_ns)
                        != (after.st_size, after.st_mtime_ns, after.st_ctime_ns)):
                    raise StorageRefusal("canonical source changed during compression")
                output.flush()
                os.fsync(output.fileno())
            check(target, reserve + 4096)
            temporary.replace(target)
            return {**reference, "path": target.name}
        finally:
            if owned:
                temporary.unlink(missing_ok=True)


def read_compressed(directory, reference):
    """Decode a single exact gzip member with bounded output and dual hashes."""
    if not isinstance(reference, dict) or set(reference) != {
            "schema", "codec", "bytes", "sha256", "storedBytes", "storedSha256", "path"}:
        raise StorageRefusal("malformed canonical log reference")
    size, stored = reference["bytes"], reference["storedBytes"]
    name = reference["path"]
    if (reference["schema"] != 1 or reference["codec"] != "gzip"
            or type(size) is not int or not 0 <= size <= CANONICAL_LOG_LIMIT
            or type(stored) is not int or not 0 < stored <= CANONICAL_LOG_LIMIT + CHUNK
            or not isinstance(name, str) or name in ("", ".", "..") or Path(name).name != name
            or not all(isinstance(reference[key], str) and re.fullmatch(r"[a-f0-9]{64}", reference[key])
                       for key in ("sha256", "storedSha256"))):
        raise StorageRefusal("unsupported/oversized canonical log reference")
    raw_hash, packed_hash = hashlib.sha256(), hashlib.sha256()
    decoder = zlib.decompressobj(16 + zlib.MAX_WBITS)
    raw = bytearray()
    with regular_file(Path(directory) / name) as source:
        before = os.fstat(source.fileno())
        if before.st_size != stored:
            raise StorageRefusal("canonical container length changed")
        try:
            remaining = stored
            while remaining:
                content = source.read(min(CHUNK, remaining))
                if not content:
                    raise StorageRefusal("canonical container shrank while reading")
                remaining -= len(content)
                packed_hash.update(content)
                block = decoder.decompress(content, size - len(raw) + 1)
                raw.extend(block)
                raw_hash.update(block)
                if len(raw) > size or decoder.unconsumed_tail or decoder.unused_data:
                    raise StorageRefusal("canonical container overflow/trailing content")
        except zlib.error as error:
            raise StorageRefusal("invalid canonical gzip") from error
        after = os.fstat(source.fileno())
        if (source.read(1) or (before.st_size, before.st_mtime_ns, before.st_ctime_ns)
                != (after.st_size, after.st_mtime_ns, after.st_ctime_ns)):
            raise StorageRefusal("canonical container changed while reading")
    if (len(raw) != size or not decoder.eof or raw_hash.hexdigest() != reference["sha256"]
            or packed_hash.hexdigest() != reference["storedSha256"]):
        raise StorageRefusal("canonical container truncated/changed")
    return bytes(raw)


def remove(path):
    if Path(path).is_symlink():
        raise StorageRefusal("refusing linked local scratch directory")
    try:
        shutil.rmtree(path)
    except FileNotFoundError:
        pass


def compact_envelopes(envelopes):
    """Losslessly retain canonical JSON; all original artifact bytes/hashes survive."""
    raw = json.dumps(envelopes, sort_keys=True, separators=(",", ":")).encode()
    if len(raw) > ENVELOPE_LIMIT:
        raise StorageRefusal("local envelope expansion limit exceeded")
    data = base64.b64encode(gzip.compress(raw, mtime=0)).decode("ascii")
    if len(data) > FILE_LIMIT:
        raise StorageRefusal("local compact envelope limit exceeded")
    return {"schema": 1, "codec": "gzip-base64-json", "bytes": len(raw),
            "sha256": hashlib.sha256(raw).hexdigest(), "data": data}


def retained_envelopes(entry):
    """Decode only bounded, hash-bound local containers; workers retain schema 2."""
    packed = entry.get("validatedEnvelopeContainer")
    if packed is None:
        return entry.get("validatedEnvelopes", [])  # Historical local reports.
    if "validatedEnvelopes" in entry or not isinstance(packed, dict) or set(packed) != {
            "schema", "codec", "bytes", "sha256", "data"}:
        raise StorageRefusal("malformed local envelope container")
    size = packed["bytes"]
    if (packed["schema"] != 1 or packed["codec"] != "gzip-base64-json"
            or type(size) is not int or not 0 <= size <= ENVELOPE_LIMIT
            or not isinstance(packed["data"], str) or len(packed["data"]) > FILE_LIMIT):
        raise StorageRefusal("oversized/unsupported local envelope container")
    try:
        compressed = base64.b64decode(packed["data"], validate=True)
        decoder = zlib.decompressobj(16 + zlib.MAX_WBITS)
        raw = decoder.decompress(compressed, size + 1)
        if (len(raw) != size or not decoder.eof or decoder.unused_data
                or decoder.unconsumed_tail or hashlib.sha256(raw).hexdigest() != packed["sha256"]):
            raise StorageRefusal("changed/oversized local envelope content")
        envelopes = json.loads(raw)
        if not isinstance(envelopes, list) or json.dumps(
                envelopes, sort_keys=True, separators=(",", ":")).encode() != raw:
            raise StorageRefusal("noncanonical local envelope content")
        return envelopes
    except (ValueError, zlib.error) as error:
        raise StorageRefusal("invalid local envelope encoding") from error


def copy_files(pairs):
    """Admit the entire exact collection, then bound each write and detect growth."""
    opened, pending = [], []
    try:
        for source, target in pairs:
            stream = regular_file(source)
            opened.append((stream, Path(target), os.fstat(stream.fileno())))
            if not stat.S_ISREG(opened[-1][2].st_mode):
                raise StorageRefusal("collection source is not a regular file")
        for _, target, _ in opened:
            if target.exists() or target.is_symlink():
                raise StorageRefusal("collection target already exists")
            check(target, sum(info.st_size + 4096 for _, _, info in opened))
        for stream, target, before in opened:
            temporary = target.with_name(target.name + ".copy")
            with regular_file(temporary, "wb") as output:
                pending.append((temporary, target))
                remaining = before.st_size
                while remaining:
                    content = stream.read(min(1024**2, remaining))
                    if not content:
                        raise StorageRefusal("collection source shrank during copy")
                    check(target, len(content) + 4096)
                    output.write(content)
                    output.flush()
                    remaining -= len(content)
                after = os.fstat(stream.fileno())
                if (stream.read(1) or (before.st_size, before.st_mtime_ns, before.st_ctime_ns)
                        != (after.st_size, after.st_mtime_ns, after.st_ctime_ns)):
                    raise StorageRefusal("collection source changed during copy")
                os.fsync(output.fileno())
        for temporary, target in pending:
            temporary.replace(target)
    finally:
        for stream, _, _ in opened:
            stream.close()
        for temporary, _ in pending:
            temporary.unlink(missing_ok=True)


def child_limits():
    resource.setrlimit(resource.RLIMIT_FSIZE, (FILE_LIMIT, FILE_LIMIT))


class Guard:
    def __init__(self, home, *, limit=LIMIT, headroom=HEADROOM):
        self.home = Path(home)
        self.limit, self.headroom = limit, headroom
        self.deadline = None
        self.peak_bytes = 0

    def check(self, incoming=0):
        observed = check(self.home, incoming, limit=self.limit, headroom=self.headroom)
        self.peak_bytes = max(self.peak_bytes, observed)

    def run(self, argv, *, cwd, timeout, deadline=None, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, **kwargs):
        """Bound capture and scratch growth, always kill/reap the owned group."""
        started = time.monotonic()
        deadline = min(value for value in (started + timeout, deadline, self.deadline)
                       if value is not None)
        def budget():
            if time.monotonic() >= deadline:
                raise subprocess.TimeoutExpired(argv, timeout)
        budget()
        try:
            self.check(LOG_LIMIT * (2 if stderr == subprocess.PIPE else 1))
        except StorageRefusal as error:
            error.telemetry.update(seconds=round(time.monotonic() - started, 3), exitCode=None,
                                   reaped=None, logBytes=None, initialDistinct=None,
                                   finalCounts=None, lastProgress=None)
            raise
        budget()
        if stdout != subprocess.PIPE or stderr not in (subprocess.PIPE, subprocess.STDOUT):
            raise StorageRefusal("local checker requires bounded captured output")
        with tempfile.TemporaryFile(dir=cwd) as output, tempfile.TemporaryFile(dir=cwd) as errors:
            budget()
            child = subprocess.Popen(argv, cwd=cwd, stdout=output,
                                     stderr=errors if stderr == subprocess.PIPE else subprocess.STDOUT,
                                     stdin=subprocess.DEVNULL, start_new_session=True,
                                     preexec_fn=child_limits, **kwargs)
            failure = None
            try:
                while True:
                    self.check()
                    observed = os.fstat(output.fileno()).st_size + os.fstat(errors.fileno()).st_size
                    if observed >= LOG_LIMIT:
                        raise StorageRefusal("local checker log limit exceeded", limit_type="capture",
                                             limit_bytes=LOG_LIMIT, observed_bytes=observed)
                    code = child.poll()
                    if time.monotonic() >= deadline:
                        os.killpg(child.pid, signal.SIGKILL)
                        child.wait()
                        output.seek(0)
                        errors.seek(0)
                        raise subprocess.TimeoutExpired(argv, timeout, output=output.read(LOG_LIMIT),
                                                        stderr=errors.read(LOG_LIMIT))
                    if code is not None:
                        break
                    time.sleep(min(0.05, max(0, deadline - time.monotonic())))
            except BaseException as error:
                failure = error
                raise
            finally:
                # Also reap descendants left behind by a completed launcher.
                try:
                    os.killpg(child.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                child.wait()
                if failure is not None:
                    telemetry = {**log_telemetry(output), "stderrBytes": os.fstat(errors.fileno()).st_size,
                                 "seconds": round(time.monotonic() - started, 3),
                                 "exitCode": child.returncode, "reaped": child.returncode is not None}
                    telemetry.update(getattr(failure, "telemetry", {}))
                    failure.telemetry = telemetry
            observed = os.fstat(output.fileno()).st_size + os.fstat(errors.fileno()).st_size
            if observed >= LOG_LIMIT:
                error = StorageRefusal("local checker log limit exceeded", limit_type="capture",
                                       limit_bytes=LOG_LIMIT, observed_bytes=observed)
                error.telemetry.update(log_telemetry(output), stderrBytes=os.fstat(errors.fileno()).st_size,
                                       seconds=round(time.monotonic() - started, 3),
                                       exitCode=child.returncode, reaped=True)
                raise error
            output.seek(0)
            errors.seek(0)
            budget()
            result = subprocess.CompletedProcess(argv, code, output.read(),
                                                 errors.read() if stderr == subprocess.PIPE else None)
        budget()
        return result


@contextmanager
def session(home):
    """One local screen/preflight writer at a time, including frozen helpers."""
    # Frozen helpers live beneath the real .runs tree. Their synthetic ci/.runs
    # path must share the outer budget/lock and put reconstruction there.
    home = runs_home(home) or Path(home)
    previous = sys.modules.get(ACTIVE_KEY)
    if previous is not None:
        if previous.home.resolve() != home.resolve():
            raise StorageRefusal("different active local storage root")
        previous.check()
        yield previous
        return
    home.mkdir(parents=True, exist_ok=True)
    with (home / ".local-storage.lock").open("a") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as error:
            raise StorageRefusal("another local screen/preflight owns the storage budget") from error
        previous_term = signal.getsignal(signal.SIGTERM)
        def cancelled(signum, frame):
            raise SystemExit(128 + signum)
        signal.signal(signal.SIGTERM, cancelled)
        guard = Guard(home)
        sys.modules[ACTIVE_KEY] = guard
        try:
            guard.check()
            yield guard
        finally:
            signal.signal(signal.SIGTERM, previous_term)
            if previous is None:
                sys.modules.pop(ACTIVE_KEY, None)
            else:
                sys.modules[ACTIVE_KEY] = previous
