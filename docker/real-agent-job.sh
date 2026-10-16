#!/bin/bash
# One contained matrix job (b.omv SR-14.4/14.6). No /test-results artifacts.
set -euo pipefail
[[ -e /etc/cscb-ci-image ]] || exit 2
version="$1"
latest="$2"
shift 2
[[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || exit 64
if [[ "$latest" == 1 && ! -x "/opt/claude-code/$version/claude" ]]; then
    # Latest was resolved once by the coordinator, never resolved again here.
    bash /opt/cscb-ci/install-real-agents.sh "$version"
fi
actual="$("/opt/claude-code/$version/claude" --version)"
[[ "${actual%% *}" == "$version" ]] || exit 1
printf 'recorded: matrix native Claude %s\n' "$actual"
export REAL_AGENT_CLAUDE_VERSION="$version"
export REAL_AGENT_OPUS_MODEL
export ANTHROPIC_API_KEY ANTHROPIC_BASE_URL ANTHROPIC_MODEL
# Each scenario creates its own HOME/store/socket and minimal permissions;
# the root job never launches a bot, AD or tmux itself.
gosu testuser bun install /tmp/package.tgz > /tmp/real-agent-install.log 2>&1
gosu testuser /opt/agent-director/check/ad-client-check.sh --package /test-repo/node_modules/claude-slack-channel-bots
for spec in "$@"; do
    IFS=: read -r script trial model_kind <<< "$spec"
    [[ "$script" =~ ^(integration|real-agent)/test-[0-9]+-fmk-real-[a-z0-9-]+\.sh$ && "$trial" =~ ^[123]$ ]] || exit 64
    model="$ANTHROPIC_MODEL"
    if [[ "$model_kind" == opus ]]; then model="$REAL_AGENT_OPUS_MODEL"; fi
    log="/tmp/real-agent-script.log"
    rc=0
    gosu testuser env REAL_AGENT_TRIAL="$trial" ANTHROPIC_MODEL="$model" bash "/tests/$script" > "$log" 2>&1 || rc=$?
    cat "$log"
    python3 - "$script" "$trial" "$version" "$model" "$rc" "$log" <<'PY'
import json,sys
script,trial,version,model,rc,path=sys.argv[1:]
lines=open(path).read().splitlines()
duplicates=[l[len('duplicates:'):].strip() for l in lines if l.startswith('duplicates:')]
tokens=[l[len('tokens:'):].strip() for l in lines if l.startswith('tokens:')]
duplicate=None
usage=None
try:
    if len(duplicates)!=1: raise ValueError()
    value=int(duplicates[0])
    if value<0: raise ValueError()
    duplicate=value
except (ValueError,TypeError):
    pass
try:
    if len(tokens)!=1: raise ValueError()
    value=json.loads(tokens[0])
    if not isinstance(value,dict) or set(value)!={'input','output','cache_read','cache_creation'}: raise ValueError()
    if any(type(n) is not int or n<0 for n in value.values()): raise ValueError()
    usage=value
except (ValueError,TypeError):
    pass
valid=duplicate is not None and usage is not None
result={'script':script,'trial':int(trial),'version':version,'model':model,'exit':int(rc),
        'reported':valid,'duplicates':duplicate,'tokens':usage}
print('real-agent-result: '+json.dumps(result,separators=(',',':')))
if int(rc)!=0 or not valid: sys.exit(1)
PY
    rm -f "$log"
done
