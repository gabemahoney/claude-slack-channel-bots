#!/usr/bin/env bash
# scripts/ci-base-build.sh: the /ci base-image build step (b.uqm SR-9.2, SR-19.5).
#
# The /ci skill's base-build commands at 946be79, moved here unchanged: the
# BASE_TAG assignment, then every line inside the skill's guard that built the
# base only when no image had that tag. Each moved line is the skill's, byte
# for byte, without the code block's three-space list indentation. The guard
# line, its closing line and the test-image build after it are left out, so
# this step builds the base image alone and never tags the test image. Only
# these header lines and the one marked note below are new.
#
# The /ci runner (scripts/ci-run.ts) runs it in step 12, only when the base
# was missing at step 4 and is still missing just before the step: in a
# process group of its own, with the worktree root as its working directory,
# the runner's environment, and its output in the runner log.
#
# Exit status: 0 when the base build succeeded; 1 after one of its own
# `non-runnable:` lines on standard error; otherwise the base build command's
# own non-zero status.
BASE_TAG=cscb-ci-base:v6  # bump when docker/Dockerfile.test.base or one of its pins (ARG defaults) changes; package.json is not read
# (note) The skill's guard stood here: the runner checks that the base is
# missing before it runs this step, so every line below always runs.
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
