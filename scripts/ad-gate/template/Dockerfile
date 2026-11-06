# ad-gate-job: the shipped claude-slack-channel-bots (CSCB) package against a
# candidate agent-director (AD) build, on CSCB's no-model integration scripts.
#
# Mirrors CSCB's /ci image (docker/Dockerfile.test.base + Dockerfile.test at
# the shipped tag) with these differences:
# - /opt/agent-director holds the CANDIDATE binary, admin tool and install.sh
#   (from ./inputs/ad), not the base's pinned release;
# - release.json names the candidate binary as version/commit and CSCB's own
#   pinned client as client_version/client_tarball; ad-client-check.sh is
#   patched to match (patch-client-check.py);
# - the build fails unless the binary reports the manifest's expected version
#   and, when the manifest records one, a commit starting with its commit;
# - no native Claude Code or Codex, no 0.16.1 downgrade fixture, no global
#   root client: the real-agent scripts are not run;
# - every fixture comes from ./inputs (prepare.sh); the build uses the network
#   only for apt, bun, node and cozempic, and the container runs with none;
#   /test-repo is pre-installed from the same package tarball so test-1's
#   `bun install /tmp/package.tgz` resolves offline;
# - entry.sh first runs the permission filter regression (filter-regression.ts
#   with perm-stub-claude.sh as `claude`): a real candidate row held in a
#   fallen-back permission request past the default 30 s must still be listed
#   by shipped CSCB's list({state:['check_permission']}).
# The kit's driver (scripts/ad-gate/ad-gate.ts) builds one context from this
# template per AD role and submits one job per shard, each with its scripts as
# the command and GATE_FILTER / GATE_DEADLINE_S as --env (entry.sh states them).
# Secrets: none. Nothing here reads or receives a credential.
FROM ubuntu:22.04

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y \
    curl \
    git \
    gosu \
    ca-certificates \
    gnupg \
    python3 \
    python3-pip \
    jq \
    unzip \
    tmux \
    sqlite3 \
    file \
    procps \
    && rm -rf /var/lib/apt/lists/* \
    && printf 'cscb-ci image (ad-gate-job: shipped CSCB vs candidate agent-director)\n' > /etc/cscb-ci-image \
    && chmod 0644 /etc/cscb-ci-image

ARG BUN_VERSION=1.4.2
RUN curl -fsSL https://bun.sh/install | bash -s "bun-v${BUN_VERSION}" && cp /root/.bun/bin/bun /usr/local/bin/bun \
    && bun --version

RUN curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y nodejs \
    && rm -rf /var/lib/apt/lists/*

RUN pip install cozempic

ENV PATH=/opt/agent-director/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
ENV DISABLE_AUTOUPDATER=1
# ad-gate-0172: every script reports; the verdict lands before the 4 h scheduler timeout.
# The driver sets each shard's GATE_DEADLINE_S below its own scheduler timeout.
ENV GATE_KEEP_GOING=1
ENV GATE_DEADLINE_S=13800

COPY inputs /opt/ad-gate/inputs
COPY patch-client-check.py entry.sh filter-regression.ts perm-stub-claude.sh /opt/ad-gate/

# The candidate at the base image's fixed paths, and the older fixtures.
RUN set -eu; \
    IN=/opt/ad-gate/inputs; \
    AD_PIN=$(jq -er '.cscb.ad_client_pin' "${IN}/manifest.json"); \
    EXPECTED=$(jq -r '.candidate.expected_version' "${IN}/manifest.json"); \
    mkdir -p /opt/agent-director/bin /opt/agent-director/admin /opt/agent-director/install \
             /opt/agent-director/client /opt/agent-director/check \
             /opt/agent-director-0.10.0/bin /opt/claude-slack-channel-bots-0.10.0; \
    install -m 0755 "${IN}/ad/agent-director" /opt/agent-director/bin/agent-director; \
    install -m 0755 "${IN}/ad/agent-director-admin" /opt/agent-director/admin/agent-director-admin; \
    install -m 0755 "${IN}/ad/install.sh" /opt/agent-director/install/install.sh; \
    VERSION_JSON=$(/opt/agent-director/bin/agent-director version); \
    CAND_VERSION=$(printf '%s' "${VERSION_JSON}" | jq -er '.version | strings'); \
    CAND_COMMIT=$(printf '%s' "${VERSION_JSON}" | jq -er '.commit | strings'); \
    ADMIN_VERSION=$(/opt/agent-director/admin/agent-director-admin version 2>/dev/null | jq -r '.version // empty' || true); \
    if [ -n "${EXPECTED}" ] && [ "${CAND_VERSION}" != "${EXPECTED}" ]; then \
        echo "ERROR: the candidate binary reports ${CAND_VERSION}, not the expected ${EXPECTED}" >&2; exit 1; \
    fi; \
    MANIFEST_COMMIT=$(jq -r '.candidate.commit // empty' "${IN}/manifest.json"); \
    if [ -n "${MANIFEST_COMMIT}" ]; then \
        case "${CAND_COMMIT}" in \
            "${MANIFEST_COMMIT}"*) ;; \
            *) echo "ERROR: the candidate binary reports commit ${CAND_COMMIT}, not the manifest's ${MANIFEST_COMMIT}" >&2; exit 1 ;; \
        esac; \
    fi; \
    if [ -n "${ADMIN_VERSION}" ] && [ "${ADMIN_VERSION}" != "${CAND_VERSION}" ]; then \
        echo "ERROR: agent-director-admin reports ${ADMIN_VERSION}, the binary ${CAND_VERSION}" >&2; exit 1; \
    fi; \
    CLIENT_TGZ="/opt/agent-director/client/agent-director-${AD_PIN}.tgz"; \
    cp "${IN}/fixtures/agent-director-${AD_PIN}.tgz" "${CLIENT_TGZ}"; \
    BIN_PIN=$(jq -er '.candidate.binary_sha256' "${IN}/manifest.json"); \
    ADMIN_PIN=$(jq -er '.candidate.admin_sha256' "${IN}/manifest.json"); \
    INSTALL_PIN=$(jq -er '.candidate.installer_sha256' "${IN}/manifest.json"); \
    printf '%s  %s\n' "${BIN_PIN}" /opt/agent-director/bin/agent-director \
        "${ADMIN_PIN}" /opt/agent-director/admin/agent-director-admin \
        "${INSTALL_PIN}" /opt/agent-director/install/install.sh | sha256sum --check --status \
        || { echo "ERROR: installed agent-director files differ from the manifest's digests" >&2; exit 1; }; \
    jq -n --arg version "${CAND_VERSION}" --arg commit "${CAND_COMMIT}" \
        --arg binary_sha256 "${BIN_PIN}" --arg admin_sha256 "${ADMIN_PIN}" --arg installer_sha256 "${INSTALL_PIN}" \
        --arg client_version "${AD_PIN}" --arg client_tarball "${CLIENT_TGZ}" \
        --arg client_tarball_sha256 "$(sha256sum "${CLIENT_TGZ}" | cut -d' ' -f1)" \
        '{version: $version, commit: $commit, binary_sha256: $binary_sha256, admin_sha256: $admin_sha256, installer_sha256: $installer_sha256, client_version: $client_version, client_tarball: $client_tarball, client_tarball_sha256: $client_tarball_sha256}' \
        > /opt/agent-director/client/release.json; \
    install -m 0755 "${IN}/fixtures/agent-director-0.10.0" /opt/agent-director-0.10.0/bin/agent-director; \
    cp "${IN}/fixtures/agent-director-0.10.0.tgz" /opt/agent-director-0.10.0/; \
    cp "${IN}/fixtures/claude-slack-channel-bots-0.10.0.tgz" /opt/claude-slack-channel-bots-0.10.0/; \
    /opt/agent-director-0.10.0/bin/agent-director version | jq -e '.version == "0.10.0"' >/dev/null; \
    if [ -f "${IN}/ad/client.tgz" ]; then \
        mkdir -p /opt/ad-gate/candidate-client; \
        tar -xzf "${IN}/ad/client.tgz" -C /opt/ad-gate/candidate-client --strip-components=1 --no-same-owner; \
    fi; \
    cp "${IN}/cscb-src/docker/ad-client-check.sh" /opt/agent-director/check/ad-client-check.sh; \
    python3 /opt/ad-gate/patch-client-check.py /opt/agent-director/check/ad-client-check.sh; \
    chmod 0755 /opt/agent-director/check/ad-client-check.sh /opt/ad-gate/entry.sh /opt/ad-gate/perm-stub-claude.sh; \
    chmod -R a+rX /opt/agent-director /opt/agent-director-0.10.0 /opt/claude-slack-channel-bots-0.10.0 /opt/ad-gate; \
    [ "$(command -v agent-director)" = /opt/agent-director/bin/agent-director ]; \
    echo "candidate agent-director ${CAND_VERSION} (${CAND_COMMIT}) at /opt/agent-director/bin; CSCB's pinned client ${AD_PIN}"

# ad-gate-0172: CSCB v0.18.2's legacy displayed-state fixture (test-43), with
# the pins of v0.18.2's docker/Dockerfile.test.base, from ./inputs.
ARG AD_LEGACY_VERSION=0.17.0
ARG AD_LEGACY_COMMIT=3ece400076aba2e6e675d51fc0533b8430bb8f2f
ARG AD_LEGACY_SHA256=9290d436b03f121df577f317a84166723acc2b3e90d4a2aeed53652cdf93d5fc
ARG AD_LEGACY_ADMIN_SHA256=b6f6eb7c64b1a58ee568c80263f21c68b8a09a58a986525a8c0c073b2f83ad12
ARG AD_LEGACY_INSTALL_SH_SHA256=9bc73dd6542414e06473ac6ef5bc01d9c6943e61fd80708d7e483aafa6aa51cc
RUN set -eu; \
    IN=/opt/ad-gate/inputs/fixtures/legacy; \
    LEGACY_DIR="/opt/agent-director-${AD_LEGACY_VERSION}"; \
    mkdir -p "${LEGACY_DIR}/bin" "${LEGACY_DIR}/admin" "${LEGACY_DIR}/install"; \
    install -m 0755 "${IN}/agent-director" "${LEGACY_DIR}/bin/agent-director"; \
    install -m 0755 "${IN}/agent-director-admin" "${LEGACY_DIR}/admin/agent-director-admin"; \
    install -m 0755 "${IN}/install.sh" "${LEGACY_DIR}/install/install.sh"; \
    printf '%s  %s\n' "${AD_LEGACY_SHA256}" "${LEGACY_DIR}/bin/agent-director" \
        "${AD_LEGACY_ADMIN_SHA256}" "${LEGACY_DIR}/admin/agent-director-admin" \
        "${AD_LEGACY_INSTALL_SH_SHA256}" "${LEGACY_DIR}/install/install.sh" \
        | sha256sum --check --status \
        || { echo "ERROR: legacy agent-director fixture digest mismatch" >&2; exit 1; }; \
    chmod -R a+rX "${LEGACY_DIR}"; \
    for legacy_bin in "${LEGACY_DIR}/bin/agent-director" "${LEGACY_DIR}/admin/agent-director-admin"; do \
        LEGACY_ID=$("${legacy_bin}" version) \
            || { echo "ERROR: legacy fixture version probe failed" >&2; exit 1; }; \
        printf '%s' "${LEGACY_ID}" | jq -e --arg version "${AD_LEGACY_VERSION}" --arg commit "${AD_LEGACY_COMMIT}" \
            '.version == $version and .commit == $commit' >/dev/null \
            || { echo "ERROR: legacy agent-director fixture identity mismatch" >&2; exit 1; }; \
    done; \
    jq -n --arg version "${AD_LEGACY_VERSION}" --arg commit "${AD_LEGACY_COMMIT}" \
        --arg binary_sha256 "${AD_LEGACY_SHA256}" --arg admin_sha256 "${AD_LEGACY_ADMIN_SHA256}" \
        --arg installer_sha256 "${AD_LEGACY_INSTALL_SH_SHA256}" \
        '{version: $version, commit: $commit, binary_sha256: $binary_sha256, admin_sha256: $admin_sha256, installer_sha256: $installer_sha256}' \
        > "${LEGACY_DIR}/release.json"; \
    chmod 0644 "${LEGACY_DIR}/release.json"; \
    echo "agent-director legacy fixture ${AD_LEGACY_VERSION} (${AD_LEGACY_COMMIT}) installed off PATH at ${LEGACY_DIR}"

# CSCB's Dockerfile.test, from the shipped tag's sources.
RUN set -eu; \
    SRC=/opt/ad-gate/inputs/cscb-src; \
    cp "${SRC}/docker/entrypoint.sh" /usr/local/bin/entrypoint.sh; \
    cp -a "${SRC}/tests" /tests; \
    mkdir -p /test-repo; \
    cp -a "${SRC}/testplans" /test-repo/testplans; \
    chmod +x /usr/local/bin/entrypoint.sh /tests/runner.sh /tests/integration/*.sh; \
    touch /run/cscb-ci-performance.lock; \
    useradd -m -s /bin/bash testuser; \
    cp /opt/ad-gate/inputs/cscb/package.tgz /tmp/package.tgz; \
    chmod 0644 /tmp/package.tgz; \
    chown -R testuser:testuser /test-repo

# Warm testuser's bun cache and /test-repo with the shipped package, so the
# offline run's test-1 install has nothing to fetch.
RUN cd /test-repo && gosu testuser bun install /tmp/package.tgz \
    && gosu testuser bun install /tmp/package.tgz \
    && jq -r '.version' /test-repo/node_modules/claude-slack-channel-bots/package.json \
    && jq -r '"agent-director client " + .version' /test-repo/node_modules/agent-director/package.json

WORKDIR /test-repo

ENTRYPOINT ["/opt/ad-gate/entry.sh"]
