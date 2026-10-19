#!/bin/sh
set -eu
exec python3 "$(dirname "$0")/trace_contract.py" "$@"
