#!/bin/bash
set -euo pipefail
[[ -f /etc/cscb-ci-image ]] || { echo 'key-fault-controls requires the CI image' >&2; exit 70; }
# The scenario supplies its guarded scratch root; no native binary is invoked.
[[ -d "${1:-}" && "${HOME}/" == "${1}/"* ]] || exit 70
work=$(mktemp -d "${1}/key-fault-controls.XXXXXX")
cp "${BASH_SOURCE[0]%/*}/agent-director-shim.sh" "${work}/agent-director"
printf '#!/bin/bash\nprintf "forwarded\\n"\n' > "${work}/agent-director.real"
chmod +x "${work}/agent-director" "${work}/agent-director.real"
shim="${work}/agent-director"
faults="${work}/agent-director-shim.faults"
check_send() {
    local expected="$1"; shift
    [[ "$("${shim}" send-keys "$@")" == "${expected}" ]]
}
text() { check_send forwarded --instance-id "$1" --text "<channel message_id=\"$2\">body</channel>" --no-enter; }
enter() { check_send "$2" --instance-id "$1" --key Enter; }
printf 'send-keys key=Enter swallow 1 cscb_target:123.456789\n' > "${faults}"
# Another persona and a queued reminder cannot consume the target's fault.
text cscb_other 123.456789
enter cscb_other forwarded
text cscb_target 999.456789
enter cscb_target forwarded
# A later text replaces the binding; a stale target must not swallow Enter.
text cscb_target 123.456789
text cscb_target 999.456789
enter cscb_target forwarded
# Neither body text nor a different message_id with the same prefix matches.
check_send forwarded --instance-id cscb_target --text '<channel> message_id="123.456789"</channel>' --no-enter
enter cscb_target forwarded
text cscb_target 123.4567890
enter cscb_target forwarded
# Exact target consumes exactly once, and the scope survives count updates.
text cscb_target 123.456789
enter cscb_target '{}'
enter cscb_target forwarded
printf 'send-keys no_enter swallow 2 cscb_target:456.123456\n' > "${faults}"
text cscb_target 999.123456
for n in 1 2; do
    check_send '{}' --instance-id cscb_target --text '<channel message_id="456.123456">body</channel>' --no-enter
done
text cscb_target 456.123456
# Existing four-column rules retain their behavior.
printf 'send-keys key=Enter swallow 1\n' > "${faults}"
enter cscb_other '{}'
enter cscb_other forwarded
[[ "$(grep -c $'^fault\t' "${work}/agent-director-shim.log")" == 4 ]]
echo 'recorded: scoped key-fault controls passed (Enter/text, competing persona/reminder, stale header, body spoof, exact identity, count exhaustion, legacy rule)'
