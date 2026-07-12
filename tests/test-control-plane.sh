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
grep -q "pendingUndispatchedMail(config.hub, 'hub'" "$ROOT/control-plane/lib/dispatcher.js" \
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
grep -q "userInbox" "$ROOT/control-plane/lib/conversations.js" \
  || fail "control plane does not define a user inbox"
grep -q "readUserInboxMessages" "$ROOT/control-plane/lib/conversations.js" \
  || fail "control plane does not relay user inbox messages into conversations"
grep -q "recordUserInboxDelivery" "$ROOT/control-plane/lib/conversations.js" \
  || fail "control plane does not track router-delivered user inbox messages"
! grep -q "user-inbox-deliveries" "$ROOT/control-plane/lib/conversations.js" \
  || fail "user inbox delivery markers are still forgeable filesystem state"
grep -q "recipientSlugs" "$ROOT/control-plane/lib/mail.js" \
  || fail "router does not validate recipients against registry slugs"
grep -q "'user'" "$ROOT/control-plane/lib/mail.js" \
  || fail "router does not accept user as a message recipient"
grep -q "canRouteToUser" "$ROOT/control-plane/lib/mail.js" \
  || fail "router does not restrict user replies to the hub outbox"
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
! grep -q "route result delivered=" "$SERVER" \
  || fail "server still emits noisy route summary logs"
grep -q "syncUserInbox" "$SERVER" \
  || fail "server does not relay user inbox replies into conversations"
grep -q "runTick(config)" "$SERVER" \
  || fail "server does not visibly route/dispatch after user messages"
grep -q "dispatchPendingAgents" "$SERVER" \
  || fail "server does not dispatch pending agents"
grep -q "isAgentActive" "$SERVER" \
  || fail "server does not update agent active state"
! grep -q "/api/activity" "$SERVER" \
  || fail "server still exposes the removed UI activity endpoint"
grep -q "fixed-composer" "$ROOT/control-plane/public/index.html" \
  || fail "UI missing fixed composer"
grep -q "agent-rail" "$ROOT/control-plane/public/index.html" \
  || fail "UI missing agent rail"
grep -q "conversationMenu" "$ROOT/control-plane/public/index.html" \
  || fail "UI missing clear conversation selector"
grep -q "authStatus" "$ROOT/control-plane/public/index.html" \
  || fail "UI missing visible auth status"
! grep -q "activityLog\\|Activity" "$ROOT/control-plane/public/index.html" \
  || fail "UI still exposes the removed Activity field"
grep -q "status-light" "$ROOT/control-plane/public/app.js" \
  || fail "UI missing agent mail status light"
grep -q "Shift.*Enter" "$ROOT/control-plane/public/app.js" \
  || fail "composer does not document Shift+Enter newline behavior"
grep -q "messageInput.*keydown" "$ROOT/control-plane/public/app.js" \
  || fail "Enter does not send messages from the composer"
grep -q "setAuthStatus" "$ROOT/control-plane/public/app.js" \
  || fail "login feedback is not immediate and visible"
grep -q "Credentials were not accepted" "$ROOT/control-plane/public/app.js" \
  || fail "failed login feedback is not human-readable"
grep -q "pollConversation" "$ROOT/control-plane/public/app.js" \
  || fail "UI does not poll conversations for user inbox replies"
! grep -q "renderActivity\\|refreshActivity\\|/api/activity" "$ROOT/control-plane/public/app.js" \
  || fail "UI still renders the removed Activity field"
grep -q "setupHint" "$ROOT/control-plane/public/index.html" \
  || fail "UI missing setup hint element for first-run state"
grep -q "setSetupMode" "$ROOT/control-plane/public/app.js" \
  || fail "UI does not handle first-run setup mode"
grep -q "/api/setup" "$ROOT/control-plane/public/app.js" \
  || fail "UI does not call setup endpoint on first run"
grep -q "needsSetup" "$ROOT/control-plane/public/app.js" \
  || fail "UI does not track setup-required state separately from login"
grep -q "lastMessageCount" "$ROOT/control-plane/public/app.js" \
  || fail "poll does not track last message count to skip unchanged renders"
grep -q "dispatchFingerprint" "$ROOT/control-plane/lib/dispatcher.js" \
  || fail "dispatcher does not fingerprint pending mail"
grep -q "dispatchedAt" "$ROOT/control-plane/lib/dispatcher.js" \
  || fail "dispatcher dispatch markers are not time-limited"
grep -q "dispatchRetrySecs" "$ROOT/control-plane/lib/dispatcher.js" \
  || fail "dispatcher does not retry marked mail after a launch failure window"
grep -q "Math.min(60" "$ROOT/control-plane/lib/dispatcher.js" \
  || fail "dispatcher can suppress failed launches for the full lock lease"
grep -q "pendingUndispatchedMail" "$ROOT/control-plane/lib/dispatcher.js" \
  || fail "dispatcher does not distinguish new mail from already-dispatched mail"
grep -q "markMailDispatched" "$ROOT/control-plane/lib/dispatcher.js" \
  || fail "dispatcher does not mark inbox mail as handled for dispatch"
! grep -q "skipped_handled" "$ROOT/control-plane/lib/dispatcher.js" \
  || fail "dispatcher still logs repeated already-handled inbox items"
grep -q "control-plane.sh" "$ROOT/README.md" \
  || fail "README does not document easy start/stop control-plane command"
[ -x "$ROOT/scripts/control-plane.sh" ] \
  || fail "easy start/stop script missing or not executable"
grep -q "serve --hub" "$ROOT/scripts/control-plane.sh" \
  || fail "start/stop script does not pass the hub path through the control-plane CLI"
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
  TMP2="$(mktemp -d)"
  trap 'rm -rf "$TMP" "$TMP2"' EXIT
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

  cat > "$TMP/outbox/2026-07-09-hub-user.md" <<'MSG'
---
from: hub
to: user
date: 2026-07-09
subject: reply
conversation_id: 2026-07-09-main-abcdef
---
visible reply
MSG
  node "$ROOT/scripts/bizagent-control-plane.js" route-once --hub "$TMP" >/dev/null \
    || fail "route-once failed for hub -> user"
  [ -f "$TMP/user/inbox/2026-07-09-hub-user.md" ] \
    || fail "route-once did not deliver hub -> user"

  cat > "$TMP/agents/alpha/outbox/2026-07-09-alpha-user.md" <<'MSG'
---
from: alpha
to: user
date: 2026-07-09
subject: bad user route
conversation_id: 2026-07-09-main-abcdef
---
agent bypass
MSG
  node "$ROOT/scripts/bizagent-control-plane.js" route-once --hub "$TMP" >/dev/null \
    || fail "route-once rejected agent -> user with non-zero status"
  [ -f "$TMP/agents/alpha/outbox/2026-07-09-alpha-user.md" ] \
    || fail "route-once allowed agent outbox to deliver directly to user"

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
const fs = require('fs');
const path = require('path');
const { routeOutboxes } = require(`${root}/control-plane/lib/mail`);
const {
  createConversation,
  getConversation,
  readUserInboxMessages,
  userInbox,
} = require(`${root}/control-plane/lib/conversations`);
if (getConversation(hub, '../auth') !== null) process.exit(1);
fs.rmSync(userInbox(hub), { recursive: true, force: true });
fs.mkdirSync(userInbox(hub), { recursive: true });
const conv = createConversation(hub, 'Relay Test');
fs.writeFileSync(path.join(userInbox(hub), '2026-07-09-direct-hub-user.md'), `---
from: hub
to: user
date: 2026-07-09
subject: reply
conversation_id: ${conv.id}
---

hello from hub
`);
let relayed = readUserInboxMessages(hub);
if (relayed !== 0) process.exit(2);
let afterDirect = getConversation(hub, conv.id);
if (afterDirect.messages.some((msg) => msg.content === 'hello from hub')) process.exit(3);
fs.writeFileSync(path.join(hub, 'outbox', '2026-07-09-hub-user.md'), `---
from: hub
to: user
date: 2026-07-09
subject: reply
conversation_id: ${conv.id}
---

hello from hub
`);
const routed = routeOutboxes(hub);
if (routed.delivered !== 1) process.exit(4);
relayed = readUserInboxMessages(hub);
if (relayed !== 1) process.exit(5);
const updated = getConversation(hub, conv.id);
if (!updated.messages.some((msg) => msg.role === 'hub' && msg.content === 'hello from hub')) process.exit(6);
if (fs.existsSync(path.join(userInbox(hub), '2026-07-09-hub-user.md'))) process.exit(7);
if (!fs.existsSync(path.join(userInbox(hub), 'archive', '2026-07-09-hub-user.md'))) process.exit(8);
fs.writeFileSync(path.join(userInbox(hub), '2026-07-09-alpha-user.md'), `---
from: alpha
to: user
date: 2026-07-09
subject: spoof
conversation_id: ${conv.id}
---

spoofed reply
`);
const rejected = readUserInboxMessages(hub);
if (rejected !== 0) process.exit(9);
const afterReject = getConversation(hub, conv.id);
if (afterReject.messages.some((msg) => msg.content === 'spoofed reply')) process.exit(10);
NODE
  then
    fail "conversation API path safety or user inbox relay failed"
  fi
  # First-run state: no auth.json → hasAuth false; after initAuth → hasAuth true, verifyLogin works
  if ! node - "$ROOT" "$TMP2" <<'NODE'
const root = process.argv[2];
const hub = process.argv[3];
const { hasAuth, initAuth, verifyLogin } = require(`${root}/control-plane/lib/auth`);
if (hasAuth(hub)) process.exit(1);
initAuth(hub, 'admin', 'testpass');
if (!hasAuth(hub)) process.exit(2);
if (!verifyLogin(hub, 'admin', 'testpass')) process.exit(3);
if (verifyLogin(hub, 'admin', 'wrong')) process.exit(4);
NODE
  then
    fail "first-run auth flow (hasAuth/initAuth/verifyLogin) failed"
  fi
fi

echo "  ok: control-plane"
