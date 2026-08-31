#!/usr/bin/env bash
# test-registry-schema.sh
set -u
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EX="$SCRIPT_DIR/../registry.example.json"
fail() { echo "  FAIL: $1"; exit 1; }

python3 -c "
import json, sys
cfg = json.load(open('$EX'))
ks = cfg.get('knowledge_stack')
assert ks is not None, 'missing knowledge_stack block'
assert ks.get('enabled') is True, 'enabled should default to true in the example'
assert ks.get('refresh_day') == 'sunday', 'refresh_day should be sunday'
assert ks.get('refresh_time') == '01:00', 'refresh_time should be 01:00'
settings = cfg.get('settings') or {}
mcp = settings.get('mcp')
assert mcp is not None, 'missing settings.mcp block in example'
assert mcp.get('enabled') is False, 'mcp.enabled should default false in example'
assert isinstance(mcp.get('servers'), list), 'mcp.servers should be a list'
if mcp.get('servers'):
    s0 = mcp['servers'][0]
    for k in ('name', 'transport', 'command'):
        assert k in s0, f'mcp.servers[0] missing {k}'
    assert s0.get('transport') == 'stdio', 'v1 example transport should be stdio'
" || fail "registry.example.json schema check"

echo "  ok: registry-schema"
