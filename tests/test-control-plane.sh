#!/usr/bin/env bash
# test-control-plane.sh
set -u
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
fail() { echo "  FAIL: $1"; exit 1; }

SERVER="$ROOT/control-plane/server.js"

[ -f "$SERVER" ] || fail "control-plane/server.js missing"
[ -f "$ROOT/control-plane/lib/auth.js" ] || fail "auth module missing"
[ -f "$ROOT/control-plane/lib/dispatcher.js" ] || fail "dispatcher module missing"
[ -f "$ROOT/control-plane/lib/hub-memory.js" ] || fail "hub memory module missing"
[ -f "$ROOT/control-plane/lib/mail.js" ] || fail "mail module missing"
[ -f "$ROOT/control-plane/lib/conversations.js" ] || fail "conversations module missing"
[ -f "$ROOT/control-plane/public/index.html" ] || fail "web UI missing"
[ -f "$ROOT/templates/dispatch.md.template" ] || fail "dispatch prompt template missing"
[ -f "$ROOT/install/bizagent-control-plane.service" ] || fail "control-plane systemd service missing"

grep -q "pbkdf2Sync" "$ROOT/control-plane/lib/auth.js" \
  || fail "auth does not use PBKDF2 password hashing"
grep -q "timingSafeEqual" "$ROOT/control-plane/lib/auth.js" \
  || fail "auth does not use constant-time password comparison"
grep -q "agents/.*/.dispatch.md" "$ROOT/control-plane/lib/dispatcher.js" \
  || fail "dispatcher does not launch from agents/<slug>/.dispatch.md"
grep -q "launchHub" "$ROOT/control-plane/lib/dispatcher.js" \
  || fail "dispatcher does not launch the hub runtime prompt"
grep -q "pendingMail(config.hub, 'hub')" "$ROOT/control-plane/lib/dispatcher.js" \
  || fail "dispatcher does not watch the hub inbox"
grep -q "deriveHubRuntimePrompt" "$ROOT/control-plane/lib/hub-memory.js" \
  || fail "hub runtime prompt is not derived from AGENT.md sections"
grep -q "compactHubSession" "$ROOT/control-plane/lib/hub-memory.js" \
  || fail "hub session memory is not compacted"
grep -q "MAX_STORED_MESSAGES" "$ROOT/control-plane/lib/conversations.js" \
  || fail "conversation storage is not bounded"
grep -q "shouldStartNewConversation" "$ROOT/control-plane/lib/conversations.js" \
  || fail "explicit new-topic requests do not start a fresh session"
grep -q "writeFileUnique" "$ROOT/control-plane/lib/conversations.js" \
  || fail "hub inbox writes are not collision-safe"
grep -q "assertValidConversationId" "$ROOT/control-plane/lib/conversations.js" \
  || fail "conversation ids are not validated before filesystem access"
grep -q "safeConversationFile" "$ROOT/control-plane/lib/conversations.js" \
  || fail "conversation file paths are not constrained to the conversations dir"
grep -q "conversation_id" "$ROOT/control-plane/lib/conversations.js" \
  || fail "hub inbox messages do not identify their conversation"
grep -q "recipientSlugs" "$ROOT/control-plane/lib/mail.js" \
  || fail "router does not validate recipients against registry slugs"
grep -q "writeFileUnique" "$ROOT/control-plane/lib/mail.js" \
  || fail "router delivery is not collision-safe"
grep -q "safeInboxFor" "$ROOT/control-plane/lib/mail.js" \
  || fail "router inbox paths are not constrained to known recipients"
grep -q "ensureHubRuntimePrompt" "$ROOT/scripts/bizagent-control-plane.js" \
  || fail "control-plane CLI does not generate hub runtime prompt"
grep -q "append-hub-turn" "$ROOT/scripts/bizagent-control-plane.js" \
  || fail "control-plane CLI cannot append hub turns to session memory"
grep -q "setInterval(.*6000" "$SERVER" \
  || fail "server does not poll every 6 seconds"
grep -q "routeOutboxes" "$SERVER" \
  || fail "server does not route mail"
grep -q "dispatchPendingAgents" "$SERVER" \
  || fail "server does not dispatch pending agents"
grep -q "isAgentActive" "$SERVER" \
  || fail "server does not update agent active state"
grep -q "fixed-composer" "$ROOT/control-plane/public/index.html" \
  || fail "UI missing fixed composer"
grep -q "agent-rail" "$ROOT/control-plane/public/index.html" \
  || fail "UI missing agent rail"
grep -q "status-light" "$ROOT/control-plane/public/app.js" \
  || fail "UI missing agent mail status light"
grep -q "control-plane" "$ROOT/scripts/router.sh" \
  || fail "router.sh is not a control-plane wrapper"
grep -q "control-plane" "$ROOT/scripts/bizagent-dispatch.sh" \
  || fail "bizagent-dispatch.sh is not a control-plane wrapper"
grep -q "control-plane" "$ROOT/scripts/bizagent-watch.sh" \
  || fail "bizagent-watch.sh is not a control-plane wrapper"
grep -q "ensure_node" "$ROOT/install.sh" \
  || fail "installer does not ensure Node.js"
grep -q "__PORT__" "$ROOT/install/bizagent-control-plane.service" \
  || fail "service template does not expose configurable port"
grep -q "__HOST__" "$ROOT/install/bizagent-control-plane.service" \
  || fail "service template does not expose configurable host"
grep -q "BIZAGENT_PORT" "$ROOT/scripts/install-control-plane.sh" \
  || fail "control-plane installer does not carry port into service"
grep -q "instance_name" "$ROOT/scripts/install-control-plane.sh" \
  || fail "control-plane installer does not derive per-instance service names"
grep -q "sha256" "$ROOT/scripts/install-control-plane.sh" \
  || fail "control-plane installer service name is not path-stable"
grep -q "bizagent-control-plane" "$ROOT/README.md" \
  || fail "README does not document the control plane"
grep -q "^.bizagent/" "$ROOT/.gitignore" \
  || fail ".gitignore does not exclude control-plane runtime state"
grep -q "^agents/\\*/.dispatch.md" "$ROOT/.gitignore" \
  || fail ".gitignore does not exclude generated agent prompts"
grep -q "AGENT.md §§ 3-4" "$ROOT/docs/ARCHITECTURE.md" \
  || fail "architecture does not document hub prompt derivation"
grep -q ".bizagent/hub-session.md" "$ROOT/docs/ARCHITECTURE.md" \
  || fail "architecture does not document compact hub session memory"

if command -v node >/dev/null 2>&1; then
  node --check "$SERVER" || fail "server.js syntax check failed"
  for f in "$ROOT"/control-plane/lib/*.js "$ROOT"/scripts/bizagent-control-plane.js; do
    node --check "$f" || fail "$(basename "$f") syntax check failed"
  done

  TMP="$(mktemp -d)"
  trap 'rm -rf "$TMP"' EXIT
  mkdir -p "$TMP/agents/alpha/inbox/archive" "$TMP/agents/alpha/outbox" "$TMP/agents/beta/inbox/archive" "$TMP/agents/beta/outbox" "$TMP/outbox" "$TMP/inbox" "$TMP/logs"
  cat > "$TMP/registry.json" <<'JSON'
{"settings":{"dispatch":{"max_concurrency":2,"lock_lease_secs":60}},"products":[{"slug":"alpha","name":"Alpha","agent_name":"Agent A","projects":[]},{"slug":"beta","name":"Beta","agent_name":"Agent B","projects":[]}]}
JSON
  cat > "$TMP/agents/alpha/outbox/2026-07-09-alpha-beta.md" <<'MSG'
---
from: alpha
to: beta
date: 2026-07-09
subject: hi
---
hello
MSG
  node "$ROOT/scripts/bizagent-control-plane.js" route-once --hub "$TMP" >/dev/null \
    || fail "route-once failed"
  [ -f "$TMP/agents/beta/inbox/2026-07-09-alpha-beta.md" ] \
    || fail "route-once did not deliver alpha -> beta"

  cat > "$TMP/agents/alpha/outbox/2026-07-09-alpha-traverse.md" <<'MSG'
---
from: alpha
to: ../beta
date: 2026-07-09
subject: bad
---
hello bad
MSG
  node "$ROOT/scripts/bizagent-control-plane.js" route-once --hub "$TMP" >/dev/null \
    || fail "route-once rejected invalid recipient with non-zero status"
  [ -f "$TMP/agents/alpha/outbox/2026-07-09-alpha-traverse.md" ] \
    || fail "route-once moved invalid-recipient mail"

  node "$ROOT/scripts/bizagent-control-plane.js" auth-init --hub "$TMP" --username ceo --password secret >/dev/null \
    || fail "auth-init failed"
  [ -f "$TMP/.bizagent/auth.json" ] || fail "auth-init did not create auth.json"
  if ! node - "$ROOT" "$TMP" <<'NODE'
const root = process.argv[2];
const hub = process.argv[3];
const { getConversation } = require(`${root}/control-plane/lib/conversations`);
if (getConversation(hub, '../auth') !== null) process.exit(1);
NODE
  then
    fail "conversation API accepts path traversal ids"
  fi
fi

echo "  ok: control-plane"
