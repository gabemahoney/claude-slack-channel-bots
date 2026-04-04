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

3. Check the bees MCP server is running (the container needs it to read test plans):
   ```bash
   curl -sf http://127.0.0.1:8000/health > /dev/null 2>&1
   ```
   If not running, start it:
   ```bash
   bees serve --http > /tmp/bees_server.log 2>&1 &
   ```
   Wait up to 10 seconds for it to become healthy:
   ```bash
   for i in $(seq 1 10); do curl -sf http://127.0.0.1:8000/health && break || sleep 1; done
   ```

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

```bash
TARBALL=<tarball-filename>
docker run -d --name cscb-ci \
  -e ANTHROPIC_API_KEY="${ANTHROPIC_API_KEY}" \
  -e BEES_MCP_URL="http://host.docker.internal:8000" \
  -v "$(pwd)/${TARBALL}:/tmp/package.tgz:ro" \
  --add-host host.docker.internal:host-gateway \
  claude-slack-channel-bots-test
```

Tell user: `Container started. Attach with: docker exec -it cscb-ci tmux attach -t ci`

## Step 5 — Monitor

Poll every 30 seconds until timeout (10 minutes = 20 polls):

```bash
docker exec cscb-ci tmux capture-pane -t ci -p -S -50 2>/dev/null
```

Look for these signals in the output:
- **`RELEASE TEST PASSED`** — all tests passed
- **`TEST FAILED:`** — a test failed (capture the line for the report)

Also check if container crashed:
```bash
docker inspect cscb-ci --format='{{.State.Status}}' 2>/dev/null
```
If status is `exited`, grab logs and report crash.

## Step 6 — Cleanup

Always clean up after any terminal condition:
```bash
docker rm -f cscb-ci 2>/dev/null || true
```

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
Report: "Timed out after 10 minutes. Last logs above."

**On crash:**
```bash
docker logs cscb-ci --tail 50
```
Report: "Container crashed. Last logs above."
