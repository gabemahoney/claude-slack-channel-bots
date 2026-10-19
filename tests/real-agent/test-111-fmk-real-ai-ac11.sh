#!/usr/bin/env bash
# b.omv SR-14.4: one independent Opus 5.5 trial; matrix invokes trials 1,2,3.
set -euo pipefail
TEST_NAME="test-111-fmk-real-ai-ac11"
AI_CRITERION=11
source "$(dirname "$0")/ai-scenario.sh"
