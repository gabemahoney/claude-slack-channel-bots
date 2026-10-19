#!/usr/bin/env bash
# b.omv SR-14.4: one independent Opus 5.5 trial; matrix invokes trials 1,2,3.
set -euo pipefail
TEST_NAME="test-115-fmk-real-ai-ac15"
AI_CRITERION=15
source "$(dirname "$0")/ai-scenario.sh"
