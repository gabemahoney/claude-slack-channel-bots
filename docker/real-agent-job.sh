#!/bin/bash
# One contained matrix job (b.omv SR-14.4/14.6). No /test-results artifacts.
set -euo pipefail
[[ -e /etc/cscb-ci-image ]] || exit 2
version="$1"
latest="$2"
shift 2
keep_going=0
if [[ "${1:-}" == --keep-going ]]; then keep_going=1; shift; fi
[[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || exit 64
if [[ ! -x "/opt/claude-code/$version/claude" ]]; then
    # The coordinator supplies an exact version, whether explicitly selected or
    # resolved from latest once. Never resolve a moving version in this job.
    bash /opt/cscb-ci/install-real-agents.sh "$version"
fi
actual="$("/opt/claude-code/$version/claude" --version)"
[[ "${actual%% *}" == "$version" ]] || exit 1
printf 'recorded: matrix native Claude %s\n' "$actual"
export REAL_AGENT_CLAUDE_VERSION="$version"
[[ -n "${ANTHROPIC_MODEL:-}" ]] || exit 64
# Decision 19: only AI invocations may use an explicitly selected model.
# Refusal fallback stays disabled; a classifier stop never selects a model.
default_model="$ANTHROPIC_MODEL"
ai_model="${REAL_AGENT_AI_MODEL-$default_model}"
for selected_model in "$default_model" "$ai_model"; do
    [[ "$selected_model" =~ ^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,255}$ && "$selected_model" != *$'\n'* && "$selected_model" != *$'\r'* ]] || exit 64
done
export CLAUDE_CODE_DISABLE_REFUSAL_FALLBACK=1
export ANTHROPIC_API_KEY ANTHROPIC_BASE_URL
# Each scenario creates its own HOME/store/socket and minimal permissions;
# the root job never launches a bot, AD or tmux itself.
gosu testuser bun install /tmp/package.tgz > /tmp/real-agent-install.log 2>&1
gosu testuser /opt/agent-director/check/ad-client-check.sh --package /test-repo/node_modules/claude-slack-channel-bots
failed=0
for spec in "$@"; do
    IFS=: read -r script trial model_kind <<< "$spec"
    [[ "$script" =~ ^(integration|real-agent)/test-[0-9]+-fmk-real-[a-z0-9-]+\.sh$ && "$trial" =~ ^[123]$ && "$model_kind" =~ ^(default|opus)$ ]] || exit 64
    model="$default_model"
    if [[ "$model_kind" == opus ]]; then model="$ai_model"; fi
    printf 'recorded: matrix invocation %s trial=%s model=%s; refusal fallback disabled\n' "$script" "$trial" "$model"
    log="/tmp/real-agent-script.log"
    rc=0
    gosu testuser env REAL_AGENT_TRIAL="$trial" ANTHROPIC_MODEL="$model" REAL_AGENT_MODEL_PIN="$model" bash "/tests/$script" > "$log" 2>&1 || rc=$?
    cat "$log"
    status=0
    python3 - "$script" "$trial" "$version" "$model" "$rc" "$log" <<'PY' || status=$?
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
    if [[ "$status" != 0 ]]; then
        failed=1
        if [[ "$keep_going" != 1 ]]; then exit 1; fi
    fi
done
exit "$failed"
