#!/usr/bin/env bash
# Local SANY, scheduler-only TLC. Collect only after a completion notice; no polling.
# collect --run-dir DIR --completed-job ID saves only. advance --run-dir DIR
# explicitly continues. retire --run-dir DIR --reason TEXT supersedes a collected
# partial run without certification, preserving frozen evidence for review.
set -euo pipefail
exec python3 "$(dirname "${BASH_SOURCE[0]}")/runner.py" "$@"
