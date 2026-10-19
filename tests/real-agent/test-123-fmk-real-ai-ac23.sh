#!/usr/bin/env bash
# b.omv SR-14.4: one independent Opus 5.5 trial; matrix invokes trials 1,2,3.
set -euo pipefail
TEST_NAME="test-123-fmk-real-ai-ac23"
AI_CRITERION=23
source "$(dirname "$0")/ai-scenario.sh"
