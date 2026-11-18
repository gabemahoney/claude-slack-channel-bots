#!/usr/bin/env python3
"""Job-local change to docker/ad-client-check.sh (the copy in this image only).

The CSCB CI image pairs one agent-director version for both the npm client and
the binary. This job pairs CSCB's own pinned client with a candidate binary,
which CSCB's runtime gate accepts (binary >= PHASE1_FLOOR_VERSION). So the
release record carries the candidate binary as version/commit, and the pinned
client as client_version; steps 2 and 5 check each against its own field.
Every other step is unchanged. Each edit must match exactly once.

ad-gate-0172: CSCB v0.18.2's check already reads client_version itself (and
adds a binary_sha256 check in step 5), keeping its own plain-release check of
the runtime version. When every edit's result is already present exactly once
and the client-equals-runtime comparison is gone, the file is used as is.

b.nkw: CSCB v0.19.0's check (b.r6d) tests both versions against VERSION_RE,
which is the plain-release pattern unless the release record sets
candidate_overlay (/ci --ad-candidate-dist), which widens it to pre-releases
and skips the --package pin check. The gate accepts only plain X.Y.Z
candidates, so the job pins CANDIDATE=false: plain releases only, the pin
check always on, as in v0.18.2-v0.18.7.
"""
import sys

path = sys.argv[1]
text = open(path).read()
edits = [
    ('AD_TGZ_SHA256=$(record_field client_tarball_sha256)\n',
     'AD_TGZ_SHA256=$(record_field client_tarball_sha256)\nAD_CLIENT_VERSION=$(record_field client_version)\n'),
    ('[[ "${AD_VERSION}" =~ ${PLAIN_RELEASE_RE} ]]',
     '[[ "${AD_CLIENT_VERSION}" =~ ${PLAIN_RELEASE_RE} ]]'),
    ('[ "${CLIENT_VERSION}" = "${AD_VERSION}" ]',
     '[ "${CLIENT_VERSION}" = "${AD_CLIENT_VERSION}" ]'),
]
native = [
    'AD_CLIENT_VERSION=$(record_field client_version)\n',
    '[[ "${AD_CLIENT_VERSION}" =~ ${PLAIN_RELEASE_RE} ]]',
    '[ "${CLIENT_VERSION}" = "${AD_CLIENT_VERSION}" ]',
]
overlay_native = [
    'AD_CLIENT_VERSION=$(record_field client_version)\n',
    'VERSION_RE="${PLAIN_RELEASE_RE}"\n',
    '[[ "${AD_VERSION}" =~ ${VERSION_RE} ]]',
    '[[ "${AD_CLIENT_VERSION}" =~ ${VERSION_RE} ]]',
    '[ "${CLIENT_VERSION}" = "${AD_CLIENT_VERSION}" ]',
]
overlay_edit = ("CANDIDATE=$(jq -r '.candidate_overlay // false' \"${RELEASE_RECORD}\")\n",
                'CANDIDATE=false\n')
if text.count('candidate_overlay') > 0:
    if not (all(text.count(s) == 1 for s in overlay_native) and text.count(edits[2][0]) == 0
            and text.count(overlay_edit[0]) == 1 and text.count('candidate_overlay') == 1
            and text.count('VERSION_RE=') == 2):
        sys.exit("ERROR: patch-client-check: ad-client-check.sh reads candidate_overlay, but not in v0.19.0's form")
    open(path, 'w').write(text.replace(*overlay_edit))
    print("patch-client-check: ad-client-check.sh pairs the record's client_version with the client; candidate overlay off (plain releases only)")
    sys.exit(0)
if all(text.count(s) == 1 for s in native) and text.count(edits[2][0]) == 0:
    print("patch-client-check: ad-client-check.sh already pairs the record's client_version with the client; unchanged")
    sys.exit(0)
for old, new in edits:
    n = text.count(old)
    if n != 1:
        sys.exit(f"ERROR: patch-client-check: expected 1 match of {old.strip()!r}, found {n}")
    text = text.replace(old, new)
open(path, 'w').write(text)
print("patch-client-check: ad-client-check.sh pairs the pinned client with the candidate binary")
