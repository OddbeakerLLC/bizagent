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
" || fail "registry.example.json schema check"

echo "  ok: registry-schema"
