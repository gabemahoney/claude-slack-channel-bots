#!/bin/sh
# This entry point belongs only to the scheduler's container.
set -eu
test "${TLA_REMOTE_JOB:-}" = 1
test "$(pwd)" = /work
exec python3 /work/job.py
