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
   BASE_TAG=cscb-ci-base:v6  # bump when docker/Dockerfile.test.base or one of its pins (ARG defaults) changes; package.json is not read
   if ! docker image inspect "${BASE_TAG}" >/dev/null 2>&1; then
     # The agent-director release the base installs: read from
     # docker/Dockerfile.test.base's AD_VERSION (the one place it is set);
     # install.sh is taken from that release's tag, whose SHA-256 that file pins.
     AD_VERSION="$(sed -n 's/^ARG AD_VERSION=//p' docker/Dockerfile.test.base)"
     if [ -z "${AD_VERSION}" ]; then
       echo "non-runnable: docker/Dockerfile.test.base sets no ARG AD_VERSION: run /ci from the repo root" >&2
       exit 1
     fi
     AD_TAG="v${AD_VERSION}"
     # The install script: a read-only extraction from agent-director's source
     # tree (an operator-set checkout, CSCB_AD_SRC_DIR) at the release tag,
     # into a fresh temp directory outside the worktree, passed as the named
     # build context agent-director-install and removed after the build.
     # Nothing is fetched into that checkout: a missing tag is non-runnable.
     if [ -z "${CSCB_AD_SRC_DIR:-}" ]; then
       echo "non-runnable: CSCB_AD_SRC_DIR is unset: set it to a checkout of agent-director's source tree holding the tag ${AD_TAG}" >&2
       exit 1
     fi
     if ! git -C "${CSCB_AD_SRC_DIR}" rev-parse --verify --quiet "refs/tags/${AD_TAG}" >/dev/null; then
       echo "non-runnable: CSCB_AD_SRC_DIR (${CSCB_AD_SRC_DIR}) has no tag ${AD_TAG}: set CSCB_AD_SRC_DIR to a checkout of agent-director's source tree holding that tag (this skill fetches nothing into it)" >&2
       exit 1
     fi
     AD_INSTALL_CTX="$(mktemp -d "${TMPDIR:-/tmp}/cscb-ci-ad-install-XXXXXX")"
     if ! git -C "${CSCB_AD_SRC_DIR}" show "${AD_TAG}:skills/install-agent-director/install.sh" > "${AD_INSTALL_CTX}/install.sh"; then
       rm -rf "${AD_INSTALL_CTX}"
       echo "non-runnable: could not extract skills/install-agent-director/install.sh at ${AD_TAG} from CSCB_AD_SRC_DIR (${CSCB_AD_SRC_DIR}): set CSCB_AD_SRC_DIR to a checkout of agent-director's source tree holding that tag" >&2
       exit 1
     fi
     # The base layer fetches agent-director 0.10.0's binary through GitHub's
     # API with a token; supply one at build time. Prefer the operator's gh CLI token.
     # The token goes in as the BuildKit secret gh_token, read from GH_TOKEN,
     # which is set only in this one command's environment. Never pass it with
     # --build-arg: a build-arg's value is recorded in the image history of the
     # base and of every image built on it, and the build log prints it.
     # --network=host: the base layer fetches bun, the npm packages and the
     # agent-director binaries; on some hosts the default docker bridge network
     # intermittently fails these fetches with SSL/timeout errors even when the
     # host reaches the same URLs fine. Host networking sidesteps that. It only
     # affects this one-time base build, so the blast radius is minimal.
     GH_TOKEN="$(GH_CONFIG_DIR=$HOME/.config/gh-personal gh auth token 2>/dev/null || gh auth token 2>/dev/null || echo "")" \
       docker build --network=host --secret id=gh_token,env=GH_TOKEN --progress=quiet \
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
   the agent-director release pinned by `ARG AD_VERSION` (its binary first on
   `PATH` in `/opt/agent-director/bin`, its operator tool
   `agent-director-admin` off `PATH`, both installed by the release's own
   `install.sh --from-release` from agent-director's GitHub release and
   checked against their pinned SHA-256, the binary's version and commit
   checked too); that install script (off `PATH`); the release's npm client
   tarball (its SHA-256 pinned) and release record; the global
   agent-director client, installed from npm at exactly that version and
   checked by the build with the client-under-test check,
   `docker/ad-client-check.sh` (the one file the base reads from the repo, at
   `/opt/agent-director/check/ad-client-check.sh`, off `PATH`; test-1 runs it
   on the installed package; it changes nothing); agent-director 0.10.0's
   binary (off `PATH`) and client tarball; the pre-persona
   claude-slack-channel-bots 0.10.0 tarball; and the image marker
   `/etc/cscb-ci-image`. All of it is fixed when the base is built: the
   install script comes from agent-director's tree in `CSCB_AD_SRC_DIR` at
   the release tag `v<AD_VERSION>`, checked against the pins in
   `docker/Dockerfile.test.base`. The base reads no `package.json`; an
   existing base keeps what it was built with, so a change to that
   Dockerfile, its pins or `docker/ad-client-check.sh` needs a tag bump, or
   `/ci` keeps testing the old base. No agent-director binary or
   `install.sh` is copied into the repo or installed or run on the host. See
   `docker/README.md` for what the base holds and the base-image bump
   procedure.

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
- The base image (`cscb-ci-base:v6`) must be built and `CSCB_AD_SRC_DIR` is
  unset, it has no tag `v<AD_VERSION>` (the release `docker/Dockerfile.test.base`
  pins), or extracting `skills/install-agent-director/install.sh` at that tag
  fails — instruct the operator to set `CSCB_AD_SRC_DIR` to a checkout of
  agent-director's source tree holding that tag and re-run `/ci`. The skill
  never fetches into that checkout.

`CSCB_AD_SRC_DIR` is not read when the base image already exists. The skill
copies no agent-director binary and no `install.sh` into the repo, and runs
no agent-director binary and no `install.sh` on the host: `install.sh`'s
pinned SHA-256, the release binaries' pinned SHA-256, the binary's version
and commit, and the npm client tarball's pinned SHA-256 are all checked
inside the image build. A failed check stops the base build with an
`ERROR:` line; rerun the build with `--progress=plain` to see it.
