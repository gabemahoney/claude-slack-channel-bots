#!/bin/bash
# local-only Codex trials. The login is a single mounted file.
set -euo pipefail
[[ -e /etc/cscb-ci-image && -f /run/codex-login/auth.json ]] || exit 2
[[ "${CODEX_TEST_MODEL:-}" =~ ^[A-Za-z0-9._:/-]+$ ]] || exit 64
[[ -n "${CODEX_HOST_CONFIG_KEYS:-}" ]] || exit 64
actual="$(/opt/codex/0.159.2/codex --version)"
[[ "$actual" == 'codex-cli 0.159.2' ]] || exit 1
printf 'recorded: native Codex %s\nrecorded: codex-model %s\n' "$actual" "$CODEX_TEST_MODEL"
[[ "$#" == 15 ]] || exit 64
gosu testuser bun install /tmp/package.tgz > /tmp/real-agent-install.log 2>&1
gosu testuser bun -e 'try { const { decodeCodexHostConfigKeys } = await import("/test-repo/node_modules/claude-slack-channel-bots/src/codex-config-keys.ts"); decodeCodexHostConfigKeys(process.env.CODEX_HOST_CONFIG_KEYS) } catch { console.error("FAIL: Codex host config key projection is missing or invalid"); process.exit(64) }'
gosu testuser /opt/agent-director/check/ad-client-check.sh --package /test-repo/node_modules/claude-slack-channel-bots
declare -A seen
failed=0
for spec in "$@"; do
    IFS=: read -r script trial extra <<< "$spec"
    [[ -z "${extra:-}" && "$trial" =~ ^[123]$ ]] || exit 64
    case "$script" in
        real-agent/test-111-fmk-real-codex-ai-ac11.sh|real-agent/test-112-fmk-real-codex-ai-ac12.sh|real-agent/test-115-fmk-real-codex-ai-ac15.sh|real-agent/test-120-fmk-real-codex-ai-ac20.sh|real-agent/test-206-fmk-real-codex-ai-ac106.sh) ;;
        *) exit 64 ;;
    esac
    [[ -z "${seen[$spec]:-}" ]] || exit 64
    seen[$spec]=1
    log="$(mktemp /tmp/cscb-codex-trial.XXXXXX)"
    rc=0
    # The guarded scenario owns its private HOME, CODEX_HOME and auth symlink.
    gosu testuser env REAL_AGENT_TRIAL="$trial" bash "/tests/$script" > "$log" 2>&1 || rc=$?
    cat "$log"
    status=0
    python3 - "$script" "$trial" "$CODEX_TEST_MODEL" "$rc" "$log" <<'PY' || status=$?
import json,sys
script,trial,model,rc,path=sys.argv[1:]
lines=open(path).read().splitlines()
def unique(prefix):
    values=[line[len(prefix):].strip() for line in lines if line.startswith(prefix)]
    if len(values)!=1: raise ValueError()
    return values[0]
duplicate=None
usage=None
valid=False
try:
    duplicate=int(unique('duplicates:'))
    if duplicate<0: raise ValueError()
    usage=json.loads(unique('tokens:'))
    if not isinstance(usage,dict) or set(usage)!={'input','output','cache_read','cache_creation'}: raise ValueError()
    if any(type(n) is not int or n<0 for n in usage.values()) or usage['input']+usage['output']<=0: raise ValueError()
    if unique('recorded: codex-model ')!=model: raise ValueError()
    if unique('recorded: codex-completed ')!='true': raise ValueError()
    if unique('recorded: codex-auth-symlink ')!='true': raise ValueError()
    valid=True
except (ValueError,TypeError):
    pass
result={'agent':'codex','completed':valid,'script':script,'trial':int(trial),'version':'0.159.2','model':model,'exit':int(rc),
        'reported':valid,'duplicates':duplicate,'tokens':usage}
print('real-agent-result: '+json.dumps(result,separators=(',',':')))
if int(rc)!=0 or not valid: sys.exit(1)
PY
    rm -f "$log"
    if [[ "$status" != 0 ]]; then failed=1; fi
done
exit "$failed"
