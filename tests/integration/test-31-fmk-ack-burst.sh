#!/usr/bin/env bash
# b.omv SR-13.6 / AC75: 1,000 distinct Slack events, all submitted without
# awaiting any acknowledgement. The silent stub never reports in or opens
# MCP, so there is no model or message typing. Production timers apply.
# PASS intentionally leaves exactly 1,000 outstanding items until cleanup.
# Store p99 and real-agent delivery latency have separate proofs.
set -euo pipefail
TEST_NAME="test-31-fmk-ack-burst"
# shellcheck source=lib/scenario.sh
source "$(dirname "$0")/lib/scenario.sh"

for tool in bun jq python3 tmux; do
    command -v "${tool}" > /dev/null || fail "${tool} not on PATH"
done
STARTED="$(date +%s)"
PERSONA="${SCENARIO_TAG}_burst"
KEY="$(persona_key "${PERSONA}")"
WORK="$(make_workdir burst)"
LABEL="${SCENARIO_TAG}burst"
CHANNEL="C0${SCENARIO_TAG^^}BURST"
HUMAN="U0${SCENARIO_TAG^^}HUMAN"
PRINTER="${SCENARIO_FIXTURES}/fmk-texts.ts"
RECEIVED="$(bun "${PRINTER}" MESSAGE_RECEIVED)" || fail "cannot print received label"
DELIVERED="$(bun "${PRINTER}" MESSAGE_DELIVERED)" || fail "cannot print delivered label"
QUEUED_REACTION="$(bun "${PRINTER}" DEFAULT_QUEUED_ACK_REACTION)" || fail "cannot print queued reaction"
DELIVERED_REACTION="$(bun "${PRINTER}" DEFAULT_ACK_REACTION)" || fail "cannot print delivered reaction"
SESSION="$(bun "${PRINTER}" personaTmuxSessionName "${KEY}")" || fail "cannot print session name"
INSTANCE="$(bun "${PRINTER}" personaInstanceId "${KEY}")" || fail "cannot print instance id"
stub_mode "${WORK}" "${STUB_MODE_SILENT}"

CREDS="${SCENARIO_ROOT}/credentials.json"
printf '{"bot_token":"%s","app_token":"%s"}\n' "$(fake_token bot "${LABEL}")" "$(fake_token app "${LABEL}")" \
    | write_file "${CREDS}" 600
STUB_DIR="${SCENARIO_ROOT}/slack-stub"
mkdir "${STUB_DIR}"
SCENARIO_SLACK_RECORD="${STUB_DIR}/record.jsonl"
jq -n --arg token_label "${LABEL}" '{tokens:[{suffix:$token_label,label:$token_label,auth:"ok",connections:"ok"}],
    default:{auth:"invalid_auth",connections:"invalid_auth"}}' | write_file "${STUB_DIR}/control.json"
bun "${SCENARIO_FIXTURES}/slack-stub-server.ts" --record "${SCENARIO_SLACK_RECORD}" \
    --control "${STUB_DIR}/control.json" --ready-file "${STUB_DIR}/ready.json" > "${STUB_DIR}/out" 2>&1 &
SLACK_STUB_PID=$!
track_pid "${SLACK_STUB_PID}"
wait_for_file "${STUB_DIR}/ready.json" 20 "Slack stub never became ready"
export CSCB_SLACK_API_URL="$(jq -r '.api_url' "${STUB_DIR}/ready.json")"
[[ "${CSCB_SLACK_API_URL}" =~ ^http://127\.0\.0\.1:[0-9]+/api/$ ]] || fail "stub URL is not loopback"
SCENARIO_SLACK_STUB_URL="${CSCB_SLACK_API_URL%/api/}"
jq -n --arg name "${PERSONA}" --arg creds "${CREDS}" --arg work "${WORK}" --arg channel "${CHANNEL}" \
    --argjson port "${SCENARIO_PORT}" '{personas:[{name:$name,credentials_file:$creds,working_directory:$work,
      channels:[{id:$channel,delivery:"all"}],permission_prompts:$channel,dm:{enabled:false}}],
      bind:"127.0.0.1",port:$port,health_check_interval:0,exit_timeout:5}' | write_config

start_server --live
wait_for_log "$(completion_match 1)" 150 "silent persona startup never completed"
silent_worker() {
    local pid
    pid="$("${SCENARIO_REAL_TMUX}" display-message -p -t "=${SESSION}:" '#{pane_pid}' 2> /dev/null)" || return 1
    grep -qzxF -- "${SCENARIO_BIN}/claude" "/proc/${pid}/cmdline" 2> /dev/null
}
wait_until 20 "the silent stub worker never started" silent_worker
ad_capture status --instance-id "${INSTANCE}"
(( AD_RC == 0 )) || fail "cannot read silent worker status"
jq -e '.state == "pending" and (.launch_started_at | type == "string" and length > 0)' "${AD_OUT}" > /dev/null \
    || fail "the silent worker reported in or has no launch"

# All fetches are created before Promise.all waits. HTTP responses prove
# submission only; no ACK record is consulted until all 1,000 are submitted.
# Its records contain only correlation metadata, never event bodies/tokens.
cat > "${SCENARIO_ROOT}/submit.ts" << 'EOF'
const [url, label, channel, user, output] = process.argv.slice(2)
const base = Math.floor(Date.now() / 1000)
const intended = Array.from({length: 1000}, (_, i) => ({channel, ts: `${base}.${String(i + 1).padStart(6, '0')}`}))
const requests = intended.map(async item => {
  const response = await fetch(`${url}/_push`, {
    method: 'POST', headers: {'content-type': 'application/json'}, signal: AbortSignal.timeout(30_000),
    body: JSON.stringify({label, event: {type: 'message', channel, channel_type: 'channel', user,
      ts: item.ts, text: `ack burst ${item.ts}`}}),
  })
  const result = await response.json()
  if (!response.ok || result.ok !== true || typeof result.envelope_id !== 'string' || typeof result.event_id !== 'string') {
    throw new Error('burst submission refused or missing correlation identity')
  }
  return {...item, envelope_id: result.envelope_id, event_id: result.event_id}
})
const submitted = await Promise.all(requests)
await Bun.write(output, submitted.map(item => JSON.stringify(item)).join('\n') + '\n')
EOF
bun "${SCENARIO_ROOT}/submit.ts" "${SCENARIO_SLACK_STUB_URL}" "${LABEL}" "${CHANNEL}" "${HUMAN}" \
    "${SCENARIO_ROOT}/submitted.jsonl" || fail "burst submission failed"

# Poll only for positive completion. A generous observation bound never
# relaxes the per-event 3,000 ms measurement from pre-send to actual ACK.
burst_acked() {
    jq -se --arg token_label "${LABEL}" '[.[] | select(.event == "ws-message" and .label == $token_label)] | length >= 1000' \
        "${SCENARIO_SLACK_RECORD}" > /dev/null
}
wait_until 30 "not all 1,000 actual WebSocket ACKs arrived" burst_acked
# Reactions are detached from envelope ACKs. Wait for successful queued adds,
# then compare their exact identities; ACK timing remains measured above.
burst_reacted() {
    jq -se --arg token_label "${LABEL}" --arg name "${QUEUED_REACTION}" \
        '[.[] | select(.event == "api" and .method == "reactions.add" and .label == $token_label and .name == $name and .answer == "ok")] | length >= 1000' \
        "${SCENARIO_SLACK_RECORD}" > /dev/null
}
wait_until 30 "not all 1,000 queued reactions completed" burst_reacted
queue_accepted "${KEY}" > "${SCENARIO_ROOT}/accepted.jsonl"
python3 - "${SCENARIO_ROOT}/submitted.jsonl" "${SCENARIO_SLACK_RECORD}" "${SCENARIO_ROOT}/accepted.jsonl" \
    "${SLACK_STATE_DIR}/queue/${KEY}.jsonl" "${LABEL}" "${CHANNEL}" "${HUMAN}" "${QUEUED_REACTION}" "${DELIVERED_REACTION}" << 'EOF' \
    || fail "burst ACK timing, identity or outstanding queue proof failed"
import collections, json, math, sys, uuid
submitted_path, stub_path, accepted_path, journal_path, label, channel, human, queued, delivered = sys.argv[1:]
def read(path):
    with open(path) as f:
        return [json.loads(line) for line in f if line.strip()]
submitted, stub, accepted, journal = map(read, (submitted_path, stub_path, accepted_path, journal_path))
assert len(submitted) == 1000, "wrong input count"
envelopes = [s["envelope_id"] for s in submitted]
assert len(set(envelopes)) == len(set(s["event_id"] for s in submitted)) == 1000, "duplicate submission IDs"
intended = {(s["channel"], s["ts"]) for s in submitted}
assert len(intended) == 1000 and {s["channel"] for s in submitted} == {channel}, "invalid intended message set"
pushes = [r for r in stub if r["event"] == "push"]
acks = [r for r in stub if r["event"] == "ws-message"]
assert not any(r["event"] == "push-refused" for r in stub), "a push was refused"
for rows in (pushes, acks):
    assert len(rows) == 1000 and collections.Counter(r.get("envelope_id") for r in rows) == collections.Counter(envelopes), "missing, duplicate or mismatched envelope"
assert {(p["channel"], p["event_ts"]) for p in pushes} == intended, "sent event set differs"
by_id = {a["envelope_id"]: a for a in acks}
latencies = []
for push in pushes:
    ack = by_id[push["envelope_id"]]
    assert isinstance(push.get("connection_id"), str), "missing/invalid socket identity"
    uuid.UUID(push["connection_id"])
    assert push["label"] == ack["label"] == label and push["connection_id"] == ack["connection_id"], "ACK from wrong socket"
    assert push["event_type"] == "message" and push["channel_type"] == "channel", "wrong event kind"
    assert push["seq"] < ack["seq"], "ACK precedes send evidence"
    start, end = push.get("sent_mono_ms"), ack.get("ack_mono_ms")
    assert all(type(t) in (int, float) and math.isfinite(t) and t >= 0 for t in (start, end)), "missing/invalid monotonic clock"
    elapsed = end - start
    latencies.append(elapsed)
# Collect every matched ACK before applying the deadline, so a failure
# retains the full burst rather than stopping at the first slow event.
# Only numeric timing metadata is logged, never message bodies or tokens.
maximum = max(latencies)
p95 = sorted(latencies)[math.ceil(len(latencies) * .95) - 1]
over_limit = sum(elapsed > 3000 for elapsed in latencies)
negative = sum(elapsed < 0 for elapsed in latencies)
print("ACK burst elapsed_ms (push order): " + json.dumps([round(elapsed, 3) for elapsed in latencies], separators=(",", ":")), flush=True)
timing = f"acked={len(latencies)} max_ms={maximum:.3f} p95_ms={p95:.3f} over_limit={over_limit} negative={negative}"
print(f"ACK burst timing: {timing}", flush=True)
assert over_limit == negative == 0, f"ACK outside deadline: {timing} (limit_ms=3000)"
assert len(accepted) == 1000 and len({a["seq"] for a in accepted}) == 1000, "wrong distinct queue count"
assert collections.Counter((a.get("channel"), a.get("ts")) for a in accepted) == collections.Counter(intended), "queue set differs"
assert all(a.get("source") == "slack" and a.get("user") == human and a.get("via") == "receive_all" for a in accepted), "wrong acceptance identity"
# With no sent or delivered record, all 1,000 accepted items are outstanding;
# a compacted key or an extra accepted row would invalidate that proof.
assert len([r for r in journal if r["kind"] == "accepted"]) == 1000, "unexpected compacted/extra acceptance"
assert not any(r["kind"] in ("sent", "delivered", "refused") for r in journal), "message typing/delivery occurred"
reactions = [r for r in stub if r["event"] == "api" and r.get("method") == "reactions.add"]
assert queued != delivered, "stage defaults must distinguish queued from delivered"
assert len(reactions) == 1000, "missing or duplicate queued reactions"
assert all(r.get("name") == queued and r.get("label") == label and r.get("answer") == "ok" for r in reactions), "failed, foreign or premature delivered reaction"
assert collections.Counter((r.get("channel"), r.get("timestamp")) for r in reactions) == collections.Counter(intended), "queued reaction set differs"
assert not any(r["event"] == "api" and r.get("method") == "reactions.remove" for r in stub), "queued reaction removed before reply/delivery"
print(f"ACK burst: sent=1000 acked=1000 outstanding=1000 max_ms={maximum:.3f} p95_ms={p95:.3f} over_limit={over_limit}")
EOF

# Positive ACK and queued-reaction completion settle these checks; no quiet sleep.
[[ "$(cscb_ad_count send-keys)" == 0 ]] || fail "CSCB typed into the silent worker"
[[ "$(count_log "$(matcher "[slack] Session connected:")")" == 0 ]] || fail "silent worker opened MCP"
# Received reporting follows ACK submission; wait for that positive evidence.
RECEIVED_MATCH="$(matcher "[slack] ${RECEIVED}: persona=\"${PERSONA}\" (key=${KEY}) ")"
wait_for_count "${RECEIVED_MATCH}" 1000 30 "missing received diagnostics"
[[ "$(count_log "${RECEIVED_MATCH}")" == 1000 ]] || fail "unexpected received diagnostic count"
[[ "$(count_log "$(matcher "[slack] ${DELIVERED}:")")" == 0 ]] || fail "a message was delivered"

stop_server --stop-bots
port_closed "${SCENARIO_PORT}" || fail "server port remains open"
stop_tracked_pid "${SLACK_STUB_PID}" 10 "Slack stub did not stop"
queue_accepted "${KEY}" > "${SCENARIO_ROOT}/accepted-after-stop.jsonl"
cmp -s "${SCENARIO_ROOT}/accepted.jsonl" "${SCENARIO_ROOT}/accepted-after-stop.jsonl" \
    || fail "the 1,000 outstanding items changed during shutdown"
[[ "$(count_token_like "${SLACK_STATE_DIR}"/server.log* "${SCENARIO_SLACK_RECORD}" \
    "${SCENARIO_ROOT}/submitted.jsonl")" == 0 ]] || fail "token-like data leaked into evidence"
assert_no_server_tmux
assert_no_cscb_include_finished
assert_no_cscb_delete
echo "PASS: ${TEST_NAME} ($(( $(date +%s) - STARTED ))s; 1000 outstanding items allowed)"
