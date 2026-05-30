---
name: ci
description: Run Docker-based integration test suite for claude-slack-channel-bots
user-invocable: true
allowed-tools: [Bash]
---

# /ci

Run the integration test suite inside Docker. Builds the image, packs the tarball, starts a container with Claude Code inside, and monitors for pass/fail.

## Step 1 — Preflight

1. Check Docker is running:
   ```bash
   docker info > /dev/null 2>&1
   ```
   If not: "Docker is not running. Start Docker and re-run `/ci`."

2. Check ANTHROPIC_API_KEY is set:
   ```bash
   echo "${ANTHROPIC_API_KEY:?ANTHROPIC_API_KEY is not set}" > /dev/null
   ```
   If missing: "Set ANTHROPIC_API_KEY and re-run `/ci`."

## Step 2 — Pack tarball

From the repo root:
```bash
npm pack
```

Capture the tarball filename (last line of output, e.g. `claude-slack-channel-bots-0.4.0.tgz`).

## Step 3 — Build Docker image

```bash
docker build -f docker/Dockerfile.test -t claude-slack-channel-bots-test .
```

If the build fails, report the error and stop.

## Step 4 — Start container

Bind-mount a host directory into the container at `/home/testuser/.claude/projects`. This is where the in-container Claude writes its JSONL transcript per session; surfacing the directory to the host gives `/ci` a race-free verdict source (the transcript is on durable disk before `tmux kill-session` runs):

```bash
docker rm -f cscb-ci 2>/dev/null || true
TARBALL=<tarball-filename>
HOST_PROJECTS_DIR=/tmp/cscb-ci-projects
rm -rf "${HOST_PROJECTS_DIR}"
mkdir -p "${HOST_PROJECTS_DIR}"
chmod 777 "${HOST_PROJECTS_DIR}"
docker run -d --name cscb-ci \
  -e ANTHROPIC_API_KEY="${ANTHROPIC_API_KEY}" \
  -v "$(pwd)/${TARBALL}:/tmp/package.tgz:ro" \
  -v "${HOST_PROJECTS_DIR}:/home/testuser/.claude/projects" \
  claude-slack-channel-bots-test
```

Tell user: `Container started. Attach with: docker exec -it cscb-ci tmux attach -t ci`

## Step 5 — Monitor

The in-container Claude prints `RELEASE TEST PASSED` (or `TEST FAILED: <title>`) as its terminal verdict, then runs `tmux kill-session -t ci`. The pane is destroyed sub-second after the verdict prints, so pane-grep is a race. Instead, watch for container exit (entrypoint exits once the tmux session is gone) and read the verdict from the JSONL transcript at `${HOST_PROJECTS_DIR}/-test-repo/<session-id>.jsonl` — that file is on durable disk before `tmux kill-session` runs.

Poll container status every 10 seconds until exit, up to 10 minutes (60 polls):

```bash
docker inspect cscb-ci --format='{{.State.Status}}' 2>/dev/null
```

When status becomes `exited`, locate the latest JSONL transcript on the host and extract the verdict from the last assistant message:

```bash
HOST_PROJECTS_DIR=/tmp/cscb-ci-projects
LATEST_JSONL=$(command ls -t "${HOST_PROJECTS_DIR}"/-test-repo/*.jsonl 2>/dev/null | head -1)
if [ -z "${LATEST_JSONL}" ]; then
  echo "No JSONL transcript found under ${HOST_PROJECTS_DIR}/-test-repo/."
  exit 1
fi
ASSISTANT_TEXT=$(jq -r 'select(.type=="assistant") | .message.content[]? | select(.type=="text") | .text' "${LATEST_JSONL}")
echo "${ASSISTANT_TEXT}" | tail -100
```

Look for these signals in `ASSISTANT_TEXT`:
- **`RELEASE TEST PASSED`** — all tests passed
- **`TEST FAILED:`** — a test failed (capture the line for the report)

If neither marker is present in the JSONL transcript after the container exited, treat it as a crash and report (operator can inspect `${LATEST_JSONL}` directly).

## Step 6 — Cleanup

Always clean up after any terminal condition:
```bash
docker rm -f cscb-ci 2>/dev/null || true
```

The host-side `/tmp/cscb-ci-projects` directory is intentionally left on disk after the run so the operator can inspect the JSONL transcript post hoc. The next `/ci` invocation clears it at the start of Step 4.

## Step 7 — Report

**On pass:**
```
✓ Integration tests passed.
```

**On failure:**
```
✗ Integration tests FAILED: <TEST FAILED line>
```

**On timeout (10 min):**
```bash
docker logs cscb-ci --tail 50
docker rm -f cscb-ci
```
Report: "Timed out after 10 minutes. Last logs above. JSONL transcript at /tmp/cscb-ci-projects/-test-repo/."

**On crash (container exited without a verdict marker in the JSONL):**
```bash
docker logs cscb-ci --tail 50
```
Report: "Container exited without emitting a verdict. Last logs above. JSONL transcript at /tmp/cscb-ci-projects/-test-repo/."
