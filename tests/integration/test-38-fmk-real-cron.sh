#!/usr/bin/env bash
# real native Claude; all state belongs to this container.
set -euo pipefail
TEST_NAME="test-38-fmk-real-cron"
source "$(dirname "$0")/lib/scenario.sh"
source "$(dirname "$0")/lib/real-scenario.sh"
CASE_ASSERT="${SCENARIO_FIXTURES}/real-case-assertions.ts"
case_assert() { bun "${CASE_ASSERT}" "$1" "${SLACK_STATE_DIR}" "${REAL_KEY}" "${SCENARIO_AD_SHIM_LOG}" "${HOME}/.claude/projects" "${@:2}"; }
real_prepare
real_persona cron
# Bind exactly the container's non-loopback IPv4 interface. A wildcard
# listener would also accept the obsolete localhost cron dispatch.
CRON_BIND="$(python3 - <<'ADDRESS'
import fcntl,socket,struct
addresses=[]
with socket.socket(socket.AF_INET,socket.SOCK_DGRAM) as s:
 for _,name in socket.if_nameindex():
  if name=='lo': continue
  try: address=socket.inet_ntoa(fcntl.ioctl(s.fileno(),0x8915,struct.pack('256s',name.encode()))[20:24])
  except OSError: continue
  if not address.startswith('127.'): addresses.append(address)
assert len(addresses)==1, 'expected one non-loopback IPv4 interface'
print(addresses[0])
ADDRESS
)"
real_write_config "$(jq -cn --arg bind "${CRON_BIND}" '{session_restart_delay:0,bind:$bind}')"
# Its bot connects to that same interface; scenario.sh's ordinary MCP input
# names localhost, which intentionally has no listener in this case.
jq -n --arg url "http://${CRON_BIND}:${SCENARIO_PORT}/mcp" '{mcpServers:{"slack-channel-router":{type:"http",url:$url}}}' > "${HOME}/.claude/slack-mcp.json"
real_start_stub
start_server --live
python3 - "${CRON_BIND}" "${SCENARIO_PORT}" <<'LISTENER'
import pathlib,socket,struct,sys
address,port=sys.argv[1],int(sys.argv[2])
listeners=[]
for row in pathlib.Path('/proc/net/tcp').read_text().splitlines()[1:]:
 fields=row.split()
 ip,p=fields[1].split(':')
 if fields[3]=='0A' and int(p,16)==port: listeners.append(socket.inet_ntoa(struct.pack('<I',int(ip,16))))
assert listeners==[address], 'server is not bound only to the non-loopback interface'
for target in ('127.0.0.1','::1'):
 family=socket.AF_INET6 if ':' in target else socket.AF_INET
 with socket.socket(family,socket.SOCK_STREAM) as s:
  s.settimeout(1)
  assert s.connect_ex((target,port))!=0, 'loopback listener exists'
print('recorded: cron listener only on '+address+'; IPv4/IPv6 loopback refused')
LISTENER
real_wait_launch "${REAL_KEY}"
real_ad pause --instance-id "$(real_instance "${REAL_KEY}")" >/dev/null
printf 'scheduled real fire\n' > "${SCENARIO_ROOT}/scheduled.prompt"
printf '* * * * * %s %s\n' "${SCENARIO_ROOT}/scheduled.prompt" "${REAL_NAME}" > "${SLACK_STATE_DIR}/crontab"
# Real minute boundaries, no timer injection and no coalescing.
wait_until 180 'three real minute fires were not stored' case_assert accepted 3
printf '' > "${SLACK_STATE_DIR}/crontab"
case_assert cron 3
stop_server
start_server --live
real_wait_launch "${REAL_KEY}"
real_wait_delivery "${REAL_KEY}" 3

case_assert launches
real_finish "${REAL_KEY}"
echo "PASS: ${TEST_NAME}"
