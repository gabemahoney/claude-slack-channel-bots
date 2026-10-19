# Native idle-compaction captures

These are read-only source fragments from official Linux x64 releases, not
executables or manufactured acceptance records. Each provenance file records
the release URL, manifest checksum, binary checksum and size, and every
fragment's binary offset, fixture offset, length and SHA-256. Capture verifies
the downloaded binary against its release manifest without executing it.

## 2.1.303 audit

The official binary is 285,809,912 bytes, SHA-256
`375988f457756524234695cf2d8f64ace99c5f68682e47ea24862a843c191450`.
All 32 dependencies audited for 2.1.302 were located at unique binary offsets.
Thirty-one are byte-identical. The environment-parser fragment changes only
the helper declaration and export from `u6s` to `u5s`. Its parsing behavior is
unchanged. The complete captured fixture is 18,822 bytes, SHA-256
`717f69dcd8cadddaa156571f5ea85cdc6bdb3a231923a1e337b2cfb9a5917636`.

The unchanged dependencies establish the same capability rules:

- The typed minimum-token setting retains the native 100,000-token floor.
- Actual fetched rollout values and disabling settings determine eligibility;
  a missing rollout is an investigation failure.
- Ordinary idle compaction needs a one-hour cache. Its clamped timer fraction
  is 0.5–0.95, with a default of 0.9. Only a timer within the existing
  45-minute observation bound is eligible.
- `compact_on_return` performs background precomputation without a compaction
  start event. Application waits until the one-hour cache expires, so that
  mode cannot satisfy the 45-minute observation bound.
- Typed cache-TTL overrides, settings precedence, remote precompute gating,
  cache expiry, request clock, background-event suppression and application
  guards are unchanged.

The recognizer requires all 31 shared fingerprints and the exact audited
parser fingerprint for either release. It records which profile matched.
It does not accept arbitrary renamed identifiers, a version number alone,
missing fragments or unknown policy changes. Unknown implementations fail
closed. Real scenarios still read their installed binary and actual rollout;
these captures never supply scenario capability data.

`native-idle-compaction.before303.ts.txt` preserves the previous detector for
the regression demonstrating its rejection of the captured 2.1.303 bytes.
Tests also mutate each dependency and verify unchanged mode, timing, setting
and override outcomes against the 2.1.302 capture.
