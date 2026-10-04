---
name: ci
description: Run CSCB integration tests inside docker. Returns PASS or FAIL.
user-invocable: true
allowed-tools: [Bash]
---

# /ci

This suite never connects to Slack. The live Slack acceptance run against the
test workspace is `/ci-live` (`.claude/skills/ci-live/SKILL.md`).

## Procedure

1. `RUN_ID=$(date +%s)`
2. `npm pack` from repo root; capture tarball filename.
3. Lazy-build the base image, then build the top image:
   ```bash
   BASE_TAG=cscb-ci-base:v5  # bump when docker/Dockerfile.test.base or one of its pins (ARG defaults) changes; package.json is not read
   if ! docker image inspect "${BASE_TAG}" >/dev/null 2>&1; then
     # The commit install.sh is taken from: read from docker/Dockerfile.test.base's
     # AD_INSTALL_SH_COMMIT (the one place it is set), whose SHA-256 that file pins.
     AD_INSTALL_SH_COMMIT="$(sed -n 's/^ARG AD_INSTALL_SH_COMMIT=//p' docker/Dockerfile.test.base)"
     if [ -z "${AD_INSTALL_SH_COMMIT}" ]; then
       echo "non-runnable: docker/Dockerfile.test.base sets no ARG AD_INSTALL_SH_COMMIT: run /ci from the repo root" >&2
       exit 1
     fi
     # The release candidate: an operator-set directory (CSCB_AD_RC_DIR), passed
     # as the named build context agent-director-rc. The build reads only
     # SHA256SUMS, agent-director-linux-amd64 and agent-director-0.10.0.tgz from
     # it and checks them (sums, version, commit); nothing from it is copied
     # into the repo or run on the host.
     if [ -z "${CSCB_AD_RC_DIR:-}" ]; then
       echo "non-runnable: CSCB_AD_RC_DIR is unset: set it to agent-director's release-candidate directory" >&2
       exit 1
     fi
     for f in SHA256SUMS agent-director-linux-amd64 agent-director-0.10.0.tgz; do
       if [ ! -f "${CSCB_AD_RC_DIR}/${f}" ]; then
         echo "non-runnable: CSCB_AD_RC_DIR (${CSCB_AD_RC_DIR}) holds no ${f}: set CSCB_AD_RC_DIR to agent-director's release-candidate directory" >&2
         exit 1
       fi
     done
     # The install script: a read-only extraction from agent-director's source
     # tree (an operator-set checkout, CSCB_AD_SRC_DIR) at the pinned commit,
     # into a fresh temp directory outside the worktree, passed as the named
     # build context agent-director-install and removed after the build.
     if [ -z "${CSCB_AD_SRC_DIR:-}" ]; then
       echo "non-runnable: CSCB_AD_SRC_DIR is unset: set it to a checkout of agent-director's source tree holding commit ${AD_INSTALL_SH_COMMIT}" >&2
       exit 1
     fi
     AD_INSTALL_CTX="$(mktemp -d "${TMPDIR:-/tmp}/cscb-ci-ad-install-XXXXXX")"
     if ! git -C "${CSCB_AD_SRC_DIR}" show "${AD_INSTALL_SH_COMMIT}:skills/install-agent-director/install.sh" > "${AD_INSTALL_CTX}/install.sh"; then
       rm -rf "${AD_INSTALL_CTX}"
       echo "non-runnable: could not extract skills/install-agent-director/install.sh at ${AD_INSTALL_SH_COMMIT} from CSCB_AD_SRC_DIR (${CSCB_AD_SRC_DIR}): set CSCB_AD_SRC_DIR to a checkout of agent-director's source tree holding that commit" >&2
       exit 1
     fi
     # The base layer fetches agent-director 0.10.0's binary from a private GitHub
     # release; supply a token at build time. Prefer the operator's gh CLI token.
     # The token goes in as the BuildKit secret gh_token, read from GH_TOKEN,
     # which is set only in this one command's environment. Never pass it with
     # --build-arg: a build-arg's value is recorded in the image history of the
     # base and of every image built on it, and the build log prints it.
     # --network=host: the base layer fetches bun, the npm tarballs and the
     # agent-director binary; on some hosts the default docker bridge network
     # intermittently fails these fetches with SSL/timeout errors even when the
     # host reaches the same URLs fine. Host networking sidesteps that. It only
     # affects this one-time base build, so the blast radius is minimal.
     GH_TOKEN="$(GH_CONFIG_DIR=$HOME/.config/gh-personal gh auth token 2>/dev/null || gh auth token 2>/dev/null || echo "")" \
       docker build --network=host --secret id=gh_token,env=GH_TOKEN --progress=quiet \
       --build-context agent-director-rc="${CSCB_AD_RC_DIR}" \
       --build-context agent-director-install="${AD_INSTALL_CTX}" \
       -f docker/Dockerfile.test.base -t "${BASE_TAG}" .
     BASE_BUILD_STATUS=$?
     rm -rf "${AD_INSTALL_CTX}"
     [ "${BASE_BUILD_STATUS}" -eq 0 ] || exit "${BASE_BUILD_STATUS}"
   fi
   docker build -f docker/Dockerfile.test -t cscb-ci .
   ```
   The base image is built once per host; `docker/Dockerfile.test`'s `FROM`
   line pins the same tag — keep them in sync. It holds no CSCB source: apt
   packages (among them `sqlite3` and `file`), bun, nodejs and cozempic;
   agent-director's release candidate (its binary first on `PATH` in
   `/opt/agent-director-rc/bin`, its client tarball and release record), its
   install script (off `PATH`); the global agent-director client, the
   release candidate's, installed from its tarball and checked by the build
   with the client-under-test check, `docker/rc-client-check.sh` (the one
   file the base reads from the repo, at
   `/opt/agent-director-rc/check/rc-client-check.sh`, off `PATH`; test-1
   runs it on the installed package); agent-director 0.10.0's binary (off `PATH`)
   and client tarball; the pre-persona claude-slack-channel-bots 0.10.0
   tarball; and the image marker `/etc/cscb-ci-image`. All of it is fixed when the base is built: the
   release candidate comes from the directory in `CSCB_AD_RC_DIR` and the
   install script from agent-director's tree in `CSCB_AD_SRC_DIR` at the
   Dockerfile's `ARG AD_INSTALL_SH_COMMIT`, both
   checked against the pins in `docker/Dockerfile.test.base`. The base reads
   no `package.json`; an existing base keeps what it was built with, so a
   change to that Dockerfile, its pins or `docker/rc-client-check.sh` needs a
   tag bump, or `/ci` keeps
   testing the old base. Nothing from the release candidate is copied into
   the repo or installed or run on the host. See `docker/README.md` for what
   the base holds and the base-image bump procedure.

   The base build needs BuildKit (docker's default builder since 23.0; check
   with `docker buildx version`) for the `--secret` flag and the Dockerfile's
   secret mount. `--progress=quiet` hides the build's step output; if the base
   build fails, rerun the same command with `--progress=plain` in its place to
   see which step failed and why (the token is a secret mount, so it is never
   in that output). Never echo `GH_TOKEN` or print the build's environment.
4. `RESULTS_DIR=$(mktemp -d -t cscb-ci-${RUN_ID}-XXXXXX)` — outside the repo working tree so `/publish prepare`'s SR-2.1 cleanliness check stays happy. Respects `$TMPDIR`; falls back to `/tmp`.
5. ```bash
   docker run --rm --name cscb-ci-${RUN_ID} \
     -v ${RESULTS_DIR}:/test-results \
     -v ${PWD}/<TARBALL>:/tmp/package.tgz:ro \
     --env ANTHROPIC_API_KEY \
     --env ANTHROPIC_BASE_URL \
     --env ANTHROPIC_MODEL \
     cscb-ci
   ```
6. Container exits when `/tests/runner.sh` exits.
7. Read first line of `${RESULTS_DIR}/verdict.txt`:
   - `PASS` → exit 0, report `✓ Integration tests passed.`
   - `FAIL: …` → relay the verdict line verbatim, **and echo the path** `${RESULTS_DIR}` so the operator can inspect the verdict + docker logs after the fact. Exit 1.
   - File missing or first line is neither → exit 1 with
     `test container did not write verdict.txt` and include
     `docker logs cscb-ci-${RUN_ID}` tail in the report. Echo `${RESULTS_DIR}` path so the operator can inspect.
8. Cleanup: `docker rm cscb-ci-${RUN_ID} 2>/dev/null || true`. On `PASS`, also `rm -rf "${RESULTS_DIR}"`. On `FAIL` or missing-verdict, **leave `${RESULTS_DIR}` for operator inspection** — the operator removes it once they're done debugging.

## Non-runnable conditions

- Docker is not running (`docker info` fails) — instruct operator to start
  Docker and re-run `/ci`.
- `ANTHROPIC_API_KEY` is not set in the environment. The bot Claudes
  spawned by the daemon-under-test cannot use Claude Code's OAuth and need
  an API key. This can be either a raw `sk-ant-api…` key (which authenticates
  directly against `api.anthropic.com`) or a gateway credential (e.g. NVIDIA
  InferenceHub), in which case `ANTHROPIC_BASE_URL` and `ANTHROPIC_MODEL`
  must also be set so the bot Claudes hit the gateway rather than
  `api.anthropic.com`. The `docker run` step passes all three through when
  present; when `ANTHROPIC_BASE_URL` is absent, Claude Code defaults to
  `api.anthropic.com`, preserving raw-key behavior. To find a raw key, read
  Claude Code's own stored key:
  ```bash
  export ANTHROPIC_API_KEY="$(jq -r .primaryApiKey ~/.claude.json)"
  ```
  If `primaryApiKey` is null/absent and no gateway credential is exported, the
  operator has not provisioned an API key — instruct them to do so before
  re-running `/ci`. When invoking `/ci` from a worker spawned via
  `agent-director`, pass the credential through on the spawn command — the
  worker session does not inherit the orchestrator's env — with
  `--extra-env ANTHROPIC_API_KEY="$KEY"`, and for a gateway credential also
  `--extra-env ANTHROPIC_BASE_URL="$BASE_URL" --extra-env ANTHROPIC_MODEL="$MODEL"`.
- `ANTHROPIC_API_KEY` is set to a gateway credential but `ANTHROPIC_BASE_URL`
  is unset. A key that does not start with `sk-ant-` (e.g. an NVIDIA
  InferenceHub credential) is not a raw Anthropic key and cannot authenticate
  against `api.anthropic.com`; without `ANTHROPIC_BASE_URL` the bot Claudes
  default to that host and fail mid-run with opaque 401s. This is non-runnable:
  instruct the operator to also export `ANTHROPIC_BASE_URL` and `ANTHROPIC_MODEL`
  for the gateway (passing all three through on the `agent-director` spawn as
  above) before re-running `/ci`.
- `npm pack` fails — instruct operator to run `npm install` and re-run `/ci`.
- The base image (`cscb-ci-base:v5`) must be built and `CSCB_AD_RC_DIR` is
  unset, or its directory lacks `SHA256SUMS`, `agent-director-linux-amd64` or
  `agent-director-0.10.0.tgz` — instruct the operator to set `CSCB_AD_RC_DIR`
  to agent-director's release-candidate directory and re-run `/ci`.
- The base image must be built and `CSCB_AD_SRC_DIR` is unset, or extracting
  `skills/install-agent-director/install.sh` at the pinned commit
  (`AD_INSTALL_SH_COMMIT`) from it fails — instruct the operator to set
  `CSCB_AD_SRC_DIR` to a checkout of agent-director's source tree holding that
  commit and re-run `/ci`.

Neither variable is read when the base image already exists. The skill copies
no release-candidate file and no `install.sh` into the repo, and runs no
release-candidate binary and no `install.sh` on the host: the base build
checks the sums, the version and the commit, and `install.sh`'s pinned
SHA-256, inside the image build. A failed check stops the base build with an
`ERROR:` line; rerun the build with `--progress=plain` to see it.
