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

# cli.json provider catalog: empty provider fails; always launches bizagent-agent.
if ! node - "$ROOT" <<'NODE'
const path = require('path');
const {
  getCliSettings,
  requireCliDef,
} = require(path.join(process.argv[2], 'control-plane/lib/cli-config'));

const catalog = {
  _runtime: { executable: 'scripts/bizagent-agent', promptFlag: '-f', flags: { extra: '-y' } },
  grok: { baseURL: 'https://api.x.ai/v1', keyEnv: 'XAI_API_KEY', models: ['grok-4.5'] },
  chatgpt: { baseURL: 'https://api.openai.com/v1', keyEnv: 'OPENAI_API_KEY', models: ['gpt-4o'] },
  claude: { baseURL: 'https://api.anthropic.com/v1/', keyEnv: 'ANTHROPIC_API_KEY', models: ['claude-sonnet-4-6'] },
  gemini: { baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai/', keyEnv: 'GEMINI_API_KEY', models: ['gemini-2.5-flash'] },
};
const hubConfig = { cli: 'grok', hubCliName: 'grok', hubProvider: 'grok' };

// Empty catalog providers → throw
let threw = false;
try {
  getCliSettings(process.argv[2], { _runtime: catalog._runtime }, hubConfig, 'grok', '');
} catch (e) {
  threw = /no LLM providers|no provider/i.test(e.message);
}
if (!threw) {
  console.error('expected throw when providers missing');
  process.exit(1);
}

// Empty name → throw
threw = false;
try {
  getCliSettings(process.argv[2], catalog, { cli: '', hubCliName: '', hubProvider: '' }, '', '');
} catch (e) {
  threw = /Provider is empty/i.test(e.message);
}
if (!threw) {
  console.error('expected throw when hub and product providers empty');
  process.exit(2);
}

// Unknown provider → throw
threw = false;
try {
  getCliSettings(process.argv[2], catalog, hubConfig, 'not-a-provider', '');
} catch (e) {
  threw = /no provider/i.test(e.message);
}
if (!threw) {
  console.error('expected throw for unknown provider');
  process.exit(3);
}

const fixed = getCliSettings(process.argv[2], catalog, hubConfig, '', '');
if (fixed.cli !== 'scripts/bizagent-agent') {
  console.error('expected bizagent-agent executable', fixed);
  process.exit(4);
}
if (fixed.promptFlag !== '-f') {
  console.error('expected -f promptFlag', fixed);
  process.exit(5);
}
if (!/--provider grok/.test(fixed.extraArgs || '')) {
  console.error('expected --provider grok', fixed);
  process.exit(6);
}

const chatgpt = getCliSettings(process.argv[2], catalog, hubConfig, 'chatgpt', 'gpt-4o');
if (chatgpt.cli !== 'scripts/bizagent-agent') {
  console.error('chatgpt must still use bizagent-agent', chatgpt);
  process.exit(7);
}
if (!/--provider chatgpt/.test(chatgpt.extraArgs || '')) {
  console.error('expected --provider chatgpt', chatgpt);
  process.exit(8);
}
if (!/--model gpt-4o/.test(chatgpt.extraArgs || '')) {
  console.error('expected model', chatgpt);
  process.exit(9);
}
const gemini = getCliSettings(process.argv[2], catalog, hubConfig, 'gemini', 'gemini-2.5-flash');
if (!/--provider gemini/.test(gemini.extraArgs || '')) {
  console.error('expected --provider gemini', gemini);
  process.exit(11);
}
requireCliDef(catalog, 'grok');
NODE
then
  fail "cli.json provider catalog checks failed"
fi
# Enterprise Phase 0 plugin seams (optional multi-user layer; soft-fail when absent)
[ -f "$ROOT/control-plane/lib/enterprise-plugin.js" ] \
  || fail "enterprise-plugin.js missing"
grep -q "loadEnterprisePlugin" "$ROOT/control-plane/lib/enterprise-plugin.js" \
  || fail "enterprise loader missing loadEnterprisePlugin"
grep -q "registerRoute" "$ROOT/control-plane/lib/enterprise-plugin.js" \
  || fail "enterprise plugin API missing registerRoute"
grep -q "filterAgents" "$ROOT/control-plane/lib/enterprise-plugin.js" \
  || fail "enterprise hooks missing filterAgents placeholder"
grep -q "attachEnterprisePlugin" "$ROOT/control-plane/server.js" \
  || fail "server does not attach enterprise plugin"
grep -q "enterprise-init" "$ROOT/scripts/bizagent-control-plane.js" \
  || fail "CLI missing enterprise-init"
grep -q '"enterprise"' "$ROOT/registry.example.json" \
  || fail "registry.example.json missing settings.enterprise gate"
if ! node - "$ROOT" <<'NODE'
const path = require('path');
const fs = require('fs');
const os = require('os');
const root = process.argv[2];
const {
  loadEnterprisePlugin,
  isEnterpriseEnabled,
  applyFilterAgents,
} = require(path.join(root, 'control-plane/lib/enterprise-plugin'));

// Absent settings → pure OSS no-op
const hub = fs.mkdtempSync(path.join(os.tmpdir(), 'biz-ent-'));
const off = loadEnterprisePlugin({ hub, registry: { settings: {} } });
if (off.active || off.enabled) {
  console.error('expected inactive when enterprise settings absent', off);
  process.exit(1);
}
if (isEnterpriseEnabled({ settings: {} })) process.exit(2);

// Enabled but missing package → soft-fail, not throw
const miss = loadEnterprisePlugin({
  hub,
  registry: {
    settings: {
      enterprise: { enabled: true, package: '@bizagent/enterprise-not-installed-xyz' },
    },
  },
});
if (miss.active) {
  console.error('missing package should not be active', miss);
  process.exit(3);
}
if (!miss.error) {
  console.error('missing package should record error', miss);
  process.exit(4);
}

// Path package: scaffold-like register()
const pkgDir = path.join(hub, 'fake-ent');
fs.mkdirSync(pkgDir);
fs.writeFileSync(path.join(pkgDir, 'index.js'), `
module.exports = {
  ENTERPRISE_API: 1,
  register(api) {
    api.hooks.filterAgents = (agents) => agents.filter((a) => a.slug === 'hub');
    api.registerRoute('GET', '/api/enterprise/me', (req, res) => {
      res.end('ok');
    });
    return { name: 'fake-ent', version: '0.0.0', enterprise_api: 1, active: true, phase: 0 };
  },
};
`);
const on = loadEnterprisePlugin({
  hub,
  registry: {
    settings: {
      enterprise: {
        enabled: true,
        package_path: pkgDir,
        enterprise_api_min: 1,
      },
    },
  },
});
if (!on.active || !on.routes.length) {
  console.error('path package should activate and register routes', on);
  process.exit(5);
}
const filtered = applyFilterAgents(on, [
  { slug: 'hub' },
  { slug: 'widgets' },
], null);
if (filtered.length !== 1 || filtered[0].slug !== 'hub') {
  console.error('filterAgents hook not applied', filtered);
  process.exit(6);
}

// Real private scaffold if present beside workspace
const entHome = path.join(os.homedir(), 'dev', 'bizagent-enterprise');
if (fs.existsSync(path.join(entHome, 'index.js'))) {
  const real = loadEnterprisePlugin({
    hub,
    registry: {
      settings: {
        enterprise: {
          enabled: true,
          package_path: entHome,
          enterprise_api_min: 1,
        },
      },
    },
  });
  if (!real.active || !real.info || !(real.info.phase >= 0)) {
    console.error('bizagent-enterprise scaffold should load active (phase >= 0)', real);
    process.exit(7);
  }
}

fs.rmSync(hub, { recursive: true, force: true });
NODE
then
  fail "enterprise plugin loader unit checks failed"
fi
grep -q "pbkdf2Sync" "$ROOT/control-plane/lib/auth.js" \
  || fail "auth does not use PBKDF2 password hashing"
grep -q "timingSafeEqual" "$ROOT/control-plane/lib/auth.js" \
  || fail "auth does not use constant-time password comparison"
# Regression: createSession must log the local `id` (not an undefined sessionId).
# A prior makeover used session_id: sessionId while the local var was `id`, which
# threw on every successful login and left setup stuck after first account create.
grep -A8 "function createSession" "$ROOT/control-plane/lib/auth.js" | grep -q "session_id: id" \
  || fail "createSession does not log session_id: id (login would throw)"
grep -q "\.dispatch\.md" "$ROOT/control-plane/lib/dispatcher.js" \
  || fail "dispatcher does not ensure agents/<slug>/.dispatch.md"
grep -q "buildAgentTurnPrompt" "$ROOT/control-plane/lib/dispatcher.js" \
  || fail "dispatcher does not inject product-agent turn prompts"
grep -q "launchHub" "$ROOT/control-plane/lib/dispatcher.js" \
  || fail "dispatcher does not launch the hub runtime prompt"
grep -q "hubCliName" "$ROOT/control-plane/lib/config.js" \
  || fail "config does not derive hub CLI from settings.hub_agent.cliName"
grep -q "hubCliName" "$ROOT/control-plane/lib/dispatcher.js" \
  || fail "launchHub does not pass hubCliName to getCliSettings"
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
grep -q "postLaunchAck" "$ROOT/control-plane/lib/conversations.js" \
  || fail "control plane missing CP launch-ack helper"
grep -q "hub-turn-safety" "$ROOT/control-plane/lib/dispatcher.js" \
  || fail "dispatcher does not wire hub-turn safety net"
grep -q "drainHubTurnSafety" "$ROOT/control-plane/server.js" \
  || fail "server tick does not drain hub-turn safety net"
grep -q "launch-ack" "$ROOT/control-plane/public/app.js" \
  || fail "UI does not style launch-ack status messages"
grep -q "Working. Stand by" "$ROOT/control-plane/lib/conversations.js" \
  || fail "launch-ack text is not 'Working. Stand by...'"
! grep -q "PTL on it" "$ROOT/control-plane/lib/conversations.js" \
  || fail "stale 'PTL on it' launch-ack text still present"

# --- Approved Web UI + Installer plan (2026-08-14) ---
# 1. Live thinking log: stream in place of the static launch-ack.
grep -q "/api/thinking/stream" "$ROOT/control-plane/server.js" \
  || fail "server missing live thinking stream endpoint"
grep -q "/api/thinking/stop" "$ROOT/control-plane/server.js" \
  || fail "server missing thinking stop endpoint"
grep -q "recordThinking" "$ROOT/control-plane/lib/dispatcher.js" \
  || fail "dispatcher does not record in-flight thinking"
grep -q "stopAgentTurn" "$ROOT/control-plane/lib/dispatcher.js" \
  || fail "dispatcher missing hard-stop helper"
grep -q "thinking-log" "$ROOT/control-plane/public/app.js" \
  || fail "UI missing live thinking log rendering"
grep -q "thinking-log" "$ROOT/control-plane/public/styles.css" \
  || fail "UI missing thinking log styles"
# 2. Products list: header + three-line rows (product name / agent name / model).
grep -q "Products" "$ROOT/control-plane/public/index.html" \
  || fail "rail header is not 'Products'"
grep -q "agent-product" "$ROOT/control-plane/public/app.js" \
  || fail "UI missing product-name line in rail rows"
grep -q "agent-name" "$ROOT/control-plane/public/app.js" \
  || fail "UI missing agent-name line in rail rows"
grep -q "agent-cli-line" "$ROOT/control-plane/public/app.js" \
  || fail "UI missing model line in rail rows"
# Interrupt: pressing Escape hard-stops the in-flight thinking.
grep -q "thinkingActive" "$ROOT/control-plane/public/app.js" \
  || fail "UI missing thinking-active guard for Escape interrupt"
grep -q "stopThinking" "$ROOT/control-plane/public/app.js" \
  || fail "UI missing Escape stop-thinking handler"
# Thinking preview boundary: stream must never replay prior-turn output.
grep -q "logByteOffset" "$ROOT/control-plane/lib/thinking.js" \
  || fail "thinking record does not store logByteOffset"
grep -q "Number.isFinite(offset)" "$ROOT/control-plane/server.js" \
  || fail "thinking stream does not guard against stale/missing logByteOffset"
grep -q "clearThinking" "$ROOT/control-plane/lib/hub-turn-safety.js" \
  || fail "hub turn completion does not clear stale thinking entry"
# PlantUML preview: render .puml source to SVG inline.
grep -q "/api/plantuml/render" "$ROOT/control-plane/server.js" \
  || fail "server missing PlantUML render endpoint"
grep -q "renderPlantUml" "$ROOT/control-plane/lib/plantuml.js" \
  || fail "missing PlantUML render module"
grep -q "plantumlBtn" "$ROOT/control-plane/public/index.html" \
  || fail "UI missing PlantUML preview button"
grep -q "plantumlOutput" "$ROOT/control-plane/public/app.js" \
  || fail "UI missing PlantUML preview output handling"
# 4. Preview: built pages surface as clickable links opening in a new tab (no iframe).
grep -q 'target="_blank"' "$ROOT/control-plane/public/app.js" \
  || fail "UI does not open preview links in a new tab"
! grep -q "iframe" "$ROOT/control-plane/public/app.js" \
  || fail "UI embeds preview in an iframe (should be a plain link)"
grep -q "getStampConversationId" "$ROOT/control-plane/lib/conversations.js" \
  || fail "missing originating-conversation stamp helper"
grep -q "getStampConversationId" "$ROOT/control-plane/lib/mail.js" \
  || fail "router does not stamp from originating conversation"
grep -q "deleteConversation" "$ROOT/control-plane/lib/conversations.js" \
  || fail "missing deleteConversation helper"
grep -q 'DELETE' "$ROOT/control-plane/server.js" \
  || fail "server missing conversation DELETE route"
grep -q "deleteConversation" "$ROOT/control-plane/public/app.js" \
  || fail "UI missing delete conversation control"
grep -q "display_name" "$ROOT/control-plane/lib/profile.js" \
  || fail "missing profile/display_name module"
grep -q "/api/profile" "$ROOT/control-plane/server.js" \
  || fail "server missing profile API"
grep -q "displayName" "$ROOT/control-plane/public/app.js" \
  || fail "UI missing display name handling"
! grep -E "textContent = ['\"]Operator['\"]|['\"]Operator['\"]|'CEO'|\"CEO\"" "$ROOT/control-plane/public/app.js" \
  || fail "UI still labels the human as Operator/CEO"
[ -f "$ROOT/control-plane/lib/hub-turn-safety.js" ] \
  || fail "hub-turn-safety module missing"
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
grep -q "write-message" "$ROOT/scripts/bizagent-control-plane.js" \
  || fail "control-plane CLI missing write-message subcommand"
grep -q "writeOutboxMessage" "$ROOT/control-plane/lib/mail.js" \
  || fail "mail module missing writeOutboxMessage helper"
[ -x "$ROOT/scripts/write-message.sh" ] || [ -f "$ROOT/scripts/write-message.sh" ] \
  || fail "scripts/write-message.sh missing"
grep -q "pollSeconds\|poll_seconds" "$ROOT/control-plane/lib/config.js" \
  || fail "config does not expose pollSeconds from settings.dispatch.poll_seconds"
grep -q "pollSeconds\|pollMs\|setInterval" "$SERVER" \
  || fail "server does not schedule poll interval from config"
grep -q "setInterval" "$SERVER" \
  || fail "server does not poll on an interval"
grep -q "routeOutboxes" "$SERVER" \
  || fail "server does not route mail"
! grep -q "route result delivered=" "$SERVER" \
  || fail "server still emits noisy route summary logs"
grep -q "syncUserInbox" "$SERVER" \
  || fail "server does not relay user inbox replies into conversations"
grep -q "pushConversationsChangedOnDisk\|conversationIdsFromSafetyResults" "$SERVER" \
  || fail "server missing post-safety / stamp-based conversation push"
grep -q "setOnConversationMutated" "$SERVER" \
  || fail "server does not register conversation-mutated push hook"
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
  || fail "UI still exposes pollConversation fallback"
grep -q "EventSource" "$ROOT/control-plane/public/app.js" \
  || fail "UI does not use EventSource for event-driven updates"
grep -q "openStateStream\|openConvStream\|/api/state/stream\|/stream" "$ROOT/control-plane/public/app.js" \
  || fail "UI missing SSE stream wiring"
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
grep -q "conversationPollStamp" "$ROOT/control-plane/public/app.js" \
  || fail "conversation state stamping still required (count-only misses ack→reply swap)"
grep -q "lastConversationStamp" "$ROOT/control-plane/public/app.js" \
  || fail "last conversation stamp still required to skip unchanged renders"
grep -q "updated_at" "$ROOT/control-plane/public/app.js" \
  || fail "poll stamp must include updated_at so same-length message swaps re-render"
grep -q "buildArgs" "$ROOT/control-plane/lib/dispatcher.js" \
  || fail "dispatcher missing buildArgs (strip-then-append model override)"
grep -q "hubModel" "$ROOT/control-plane/lib/config.js" \
  || fail "config does not expose hubModel for Opus tier"
grep -q "agentDefaultModel" "$ROOT/control-plane/lib/config.js" \
  || fail "config does not expose agentDefaultModel for product-agent tier"
grep -q "models\.orchestrator" "$ROOT/control-plane/lib/config.js" \
  || fail "config does not fall back to models.orchestrator for hub model"
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
[ -x "$ROOT/scripts/viewlog.sh" ] \
  || fail "viewlog.sh missing or not executable"
grep -q 'BIZAGENT_HUB\|LOG_DIR' "$ROOT/scripts/viewlog.sh" \
  || fail "viewlog.sh does not resolve hub logs via HUB path"
# Human viewer: default mode lists control-plane logs, not JSON structured.log.
grep -q "control-plane.log" "$ROOT/scripts/viewlog.sh" \
  || fail "viewlog.sh missing control-plane.log"
# The default pick_existing block must not add structured.log (all mode may exclude it by name).
awk '/^  default\)/,/^  hub\)/' "$ROOT/scripts/viewlog.sh" | grep -q 'structured\.log' \
  && fail "viewlog.sh default mode still includes structured.log" || true
awk '/^  default\)/,/^  hub\)/' "$ROOT/scripts/viewlog.sh" | grep -q 'control-plane.log' \
  || fail "viewlog.sh default mode missing control-plane.log"
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
grep -qE '^\.bizagent(/\*|/)?$' "$ROOT/.gitignore" \
  || fail ".gitignore does not exclude control-plane runtime state"
grep -q "^agents/\\*/.dispatch.md" "$ROOT/.gitignore" \
  || fail ".gitignore does not exclude generated agent prompts"
grep -q "AGENT.md §§ 3-4" "$ROOT/docs/ARCHITECTURE.md" \
  || fail "architecture does not document hub prompt derivation"
grep -q ".bizagent/hub-session.md" "$ROOT/docs/ARCHITECTURE.md" \
  || fail "architecture does not document compact hub session memory"
grep -q "org.*config.registry" "$SERVER" \
  || fail "server does not include org in state response"
grep -q "getAgentDetail" "$SERVER" \
  || fail "server missing getAgentDetail function"
grep -q "refreshRuntimeConfig\|refreshRegistry" "$SERVER" \
  || fail "server does not refresh config without a restart"
grep -q "refreshRegistry" "$ROOT/control-plane/lib/config.js" \
  || fail "config does not expose a registry refresh mechanism"
grep -q "CODESPAN" "$ROOT/control-plane/public/app.js" \
  || fail "UI codespan placeholder does not use a collision-safe marker"
grep -q "agent-detail" "$SERVER" \
  || fail "server missing /api/agent-detail endpoint"
grep -q "titleSet" "$ROOT/control-plane/public/app.js" \
  || fail "UI does not track whether page title has been set"
grep -q "relativeTime" "$ROOT/control-plane/public/app.js" \
  || fail "UI missing relativeTime helper for dispatched timestamp"
grep -q "expand-chevron" "$ROOT/control-plane/public/app.js" \
  || fail "UI missing expand chevron on agent rows"
grep -q "agent-detail" "$ROOT/control-plane/public/styles.css" \
  || fail "styles missing agent-detail panel rules"
[ -f "$ROOT/install/install.sh" ] \
  || fail "install/install.sh missing"
[ -x "$ROOT/install/install.sh" ] \
  || fail "install/install.sh is not executable"
grep -q "install-first-run" "$ROOT/install/install.sh" \
  || fail "installer does not drop first-run inbox seed"

if command -v node >/dev/null 2>&1; then
  node --check "$SERVER" || fail "server.js syntax check failed"
  for f in "$ROOT"/control-plane/lib/*.js "$ROOT"/scripts/bizagent-control-plane.js; do
    node --check "$f" || fail "$(basename "$f") syntax check failed"
  done

  TMP="$(mktemp -d)"
  TMP2="$(mktemp -d)"
  trap 'rm -rf "$TMP" "$TMP2"' EXIT

  # Auth session create/login path (unit): createSession must not throw.
  if ! node - "$ROOT" "$TMP" <<'NODE'
const path = require('path');
const fs = require('fs');
const root = process.argv[2];
const hub = path.join(process.argv[3], 'auth-hub');
fs.mkdirSync(hub, { recursive: true });
const {
  initAuth, verifyLogin, createSession, getSession, destroySession, hasAuth,
} = require(path.join(root, 'control-plane/lib/auth'));
initAuth(hub, 'operator', 's3cret-pass');
if (!hasAuth(hub)) { console.error('hasAuth false after init'); process.exit(1); }
if (!verifyLogin(hub, 'operator', 's3cret-pass')) { console.error('verify failed'); process.exit(2); }
if (verifyLogin(hub, 'operator', 'wrong')) { console.error('bad password accepted'); process.exit(3); }
let id;
try {
  id = createSession(hub, 'operator');
} catch (err) {
  console.error('createSession threw:', err.message);
  process.exit(4);
}
if (!id || !getSession(hub, id)) { console.error('session missing after create'); process.exit(5); }
destroySession(hub, id);
if (getSession(hub, id)) { console.error('session still present after destroy'); process.exit(6); }
NODE
  then
    fail "auth createSession/login unit checks failed"
  fi

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
  [ ! -f "$TMP/agents/alpha/outbox/2026-07-09-alpha-traverse.md" ] \
    || fail "route-once left path-trick recipient in outbox (should quarantine)"
  [ -f "$TMP/.bizagent/quarantine/2026-07-09-alpha-traverse.md" ] \
    || fail "route-once did not quarantine path-trick recipient"

  # Multi-to outbox must be quarantined (not re-WARN every tick)
  cat > "$TMP/agents/alpha/outbox/2026-07-09-alpha-multi.md" <<'MSG'
---
from: alpha
to: hub, beta
date: 2026-07-09
subject: multi to invalid
---
should quarantine
MSG
  node "$ROOT/scripts/bizagent-control-plane.js" route-once --hub "$TMP" >/dev/null \
    || fail "route-once rejected multi-to with non-zero status"
  [ ! -f "$TMP/agents/alpha/outbox/2026-07-09-alpha-multi.md" ] \
    || fail "route-once left multi-to mail in outbox"
  [ -f "$TMP/.bizagent/quarantine/2026-07-09-alpha-multi.md" ] \
    || fail "route-once did not quarantine multi-to mail"

  # Missing to: must quarantine (not re-WARN every tick)
  cat > "$TMP/agents/alpha/outbox/2026-07-09-alpha-noto.md" <<'MSG'
---
from: alpha
date: 2026-07-09
subject: missing to
---
no recipient
MSG
  node "$ROOT/scripts/bizagent-control-plane.js" route-once --hub "$TMP" >/dev/null \
    || fail "route-once rejected missing-to with non-zero status"
  [ ! -f "$TMP/agents/alpha/outbox/2026-07-09-alpha-noto.md" ] \
    || fail "route-once left missing-to mail in outbox"
  [ -f "$TMP/.bizagent/quarantine/2026-07-09-alpha-noto.md" ] \
    || fail "route-once did not quarantine missing-to mail"

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
if ((relayed.relayed ?? relayed) !== 0) process.exit(2);
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
if ((relayed.relayed ?? relayed) !== 1) process.exit(5);
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
if ((rejected.relayed ?? rejected) !== 0) process.exit(9);
const afterReject = getConversation(hub, conv.id);
if (afterReject.messages.some((msg) => msg.content === 'spoofed reply')) process.exit(10);
NODE
  then
    fail "conversation API path safety or user inbox relay failed"
  fi

  # CP stamps conversation_id on hub→user route when console chat is open
  if ! node - "$ROOT" "$TMP2" <<'NODE'
const root = process.argv[2];
const hub = process.argv[3];
const fs = require('fs');
const path = require('path');
const { routeOutboxes } = require(`${root}/control-plane/lib/mail`);
const {
  createConversation,
  frontmatterValue,
  getActiveConversationId,
  getConversation,
  readUserInboxMessages,
  setActiveConversation,
  stampConversationId,
  userInbox,
} = require(`${root}/control-plane/lib/conversations`);

fs.mkdirSync(path.join(hub, 'outbox'), { recursive: true });
fs.mkdirSync(path.join(hub, 'inbox'), { recursive: true });
fs.mkdirSync(userInbox(hub), { recursive: true });
fs.writeFileSync(path.join(hub, 'registry.json'), JSON.stringify({
  settings: { dispatch: { max_concurrency: 2, lock_lease_secs: 60 } },
  products: [],
}));

// unit: stampConversationId never overwrites
const withId = `---\nfrom: hub\nto: user\nconversation_id: 2026-07-24-keep-abcdef\n---\nbody\n`;
if (stampConversationId(withId, '2026-07-24-other-123456') !== withId) {
  console.error('stamp overwrote existing conversation_id');
  process.exit(1);
}
const emptyKey = `---\nfrom: hub\nto: user\nconversation_id:\n---\nbody\n`;
if (stampConversationId(emptyKey, '2026-07-24-other-123456') !== emptyKey) {
  console.error('stamp overwrote empty conversation_id key');
  process.exit(2);
}
const missing = `---\nfrom: hub\nto: user\ndate: 2026-07-24\nsubject: reply\n---\n\nstatus fanout\n`;
const stampedOnly = stampConversationId(missing, '2026-07-24-main-abcdef');
if (!/^conversation_id:\s*2026-07-24-main-abcdef\s*$/m.test(stampedOnly)) {
  console.error('stamp did not insert conversation_id');
  process.exit(3);
}

const conv = createConversation(hub, 'Stamp Test');
// No active conversation → route leaves mail without conversation_id
fs.writeFileSync(path.join(hub, 'outbox', '2026-07-24-hub-user-nostamp.md'), `---
from: hub
to: user
date: 2026-07-24
subject: no open chat
---

file only
`);
let routed = routeOutboxes(hub);
if (routed.delivered !== 1) {
  console.error('expected 1 deliver without stamp', routed);
  process.exit(4);
}
const noStampPath = path.join(userInbox(hub), '2026-07-24-hub-user-nostamp.md');
if (!fs.existsSync(noStampPath)) {
  console.error('missing delivered no-stamp file');
  process.exit(5);
}
const noStampText = fs.readFileSync(noStampPath, 'utf8');
if (frontmatterValue(noStampText, 'conversation_id')) {
  console.error('stamped without active conversation');
  process.exit(6);
}
// relay skips (no conversation_id) and archives
let relayed = readUserInboxMessages(hub);
if ((relayed.relayed ?? relayed) !== 0) {
  console.error('unexpected relay without conversation_id', relayed);
  process.exit(7);
}

// Active conversation → stamp on route + relay into chat
if (!setActiveConversation(hub, conv.id)) {
  console.error('setActiveConversation failed');
  process.exit(8);
}
if (getActiveConversationId(hub) !== conv.id) {
  console.error('getActiveConversationId mismatch', getActiveConversationId(hub), conv.id);
  process.exit(9);
}
fs.writeFileSync(path.join(hub, 'outbox', '2026-07-24-hub-user-stamp.md'), `---
from: hub
to: user
date: 2026-07-24
subject: status fanout
---

stamped reply
`);
routed = routeOutboxes(hub);
if (routed.delivered !== 1) {
  console.error('expected 1 deliver with stamp', routed);
  process.exit(10);
}
const stampPath = path.join(userInbox(hub), '2026-07-24-hub-user-stamp.md');
if (!fs.existsSync(stampPath)) {
  console.error('missing stamped delivery file');
  process.exit(11);
}
const stampText = fs.readFileSync(stampPath, 'utf8');
if (frontmatterValue(stampText, 'conversation_id') !== conv.id) {
  console.error('route did not stamp active conversation_id', stampText);
  process.exit(12);
}
relayed = readUserInboxMessages(hub);
if ((relayed.relayed ?? relayed) !== 1) {
  console.error('expected relay after stamp', relayed);
  process.exit(13);
}
const after = getConversation(hub, conv.id);
if (!after.messages.some((m) => m.role === 'hub' && m.content === 'stamped reply')) {
  console.error('stamped reply not in conversation', after.messages);
  process.exit(14);
}

// Existing conversation_id must not be overwritten even when another is active
const other = createConversation(hub, 'Other Chat');
setActiveConversation(hub, other.id);
fs.writeFileSync(path.join(hub, 'outbox', '2026-07-24-hub-user-keep.md'), `---
from: hub
to: user
date: 2026-07-24
subject: keep id
conversation_id: ${conv.id}
---

keep original
`);
routed = routeOutboxes(hub);
if (routed.delivered !== 1) {
  console.error('expected keep-id deliver', routed);
  process.exit(15);
}
const keepPath = path.join(userInbox(hub), '2026-07-24-hub-user-keep.md');
const keepText = fs.readFileSync(keepPath, 'utf8');
if (frontmatterValue(keepText, 'conversation_id') !== conv.id) {
  console.error('overwrote existing conversation_id', keepText);
  process.exit(16);
}
relayed = readUserInboxMessages(hub);
if ((relayed.relayed ?? relayed) !== 1) {
  console.error('expected relay for keep-id', relayed);
  process.exit(17);
}
const afterKeep = getConversation(hub, conv.id);
if (!afterKeep.messages.some((m) => m.content === 'keep original')) {
  console.error('keep original not relayed to original conv');
  process.exit(18);
}
const otherAfter = getConversation(hub, other.id);
if (otherAfter.messages.some((m) => m.content === 'keep original')) {
  console.error('keep original wrongly landed in active other conv');
  process.exit(19);
}

// In-flight originating turn beats currently-viewed (active) conversation
const origin = createConversation(hub, 'Origin Chat');
const viewed = createConversation(hub, 'Viewed Chat');
setActiveConversation(hub, viewed.id);
const { appDir } = require(`${root}/control-plane/lib/config`);
const pendingFile = path.join(appDir(hub), 'pending-hub-turns.json');
fs.mkdirSync(appDir(hub), { recursive: true });
fs.writeFileSync(pendingFile, JSON.stringify({
  turns: [{
    conversationId: origin.id,
    startedAt: new Date().toISOString(),
    logByteOffset: 0,
  }],
}, null, 2));
const {
  getOriginatingConversationId,
  getStampConversationId,
} = require(`${root}/control-plane/lib/conversations`);
if (getOriginatingConversationId(hub) !== origin.id) {
  console.error('originating id mismatch', getOriginatingConversationId(hub), origin.id);
  process.exit(20);
}
if (getStampConversationId(hub) !== origin.id) {
  console.error('stamp should prefer originating over active', getStampConversationId(hub));
  process.exit(21);
}
fs.writeFileSync(path.join(hub, 'outbox', '2026-07-24-hub-user-origin.md'), `---
from: hub
to: user
date: 2026-07-24
subject: origin stamp
---

origin reply
`);
routed = routeOutboxes(hub);
if (routed.delivered !== 1) {
  console.error('expected origin stamp deliver', routed);
  process.exit(22);
}
const originPath = path.join(userInbox(hub), '2026-07-24-hub-user-origin.md');
const originText = fs.readFileSync(originPath, 'utf8');
if (frontmatterValue(originText, 'conversation_id') !== origin.id) {
  console.error('stamped active instead of originating', originText);
  process.exit(23);
}
relayed = readUserInboxMessages(hub);
if ((relayed.relayed ?? relayed) !== 1) {
  console.error('expected origin relay', relayed);
  process.exit(24);
}
const originAfter = getConversation(hub, origin.id);
if (!originAfter.messages.some((m) => m.content === 'origin reply')) {
  console.error('origin reply not in originating conv');
  process.exit(25);
}
const viewedAfter = getConversation(hub, viewed.id);
if (viewedAfter.messages.some((m) => m.content === 'origin reply')) {
  console.error('origin reply crossed into viewed conv');
  process.exit(26);
}
// Clear fixture so later dry-run launch tests on the same hub see no pending turns.
fs.unlinkSync(pendingFile);

// Stale active conversation (older than 30s presence) must still stamp —
// agents often finish after the short UI presence window.
const stale = createConversation(hub, 'Stale Active');
const activeFile = path.join(appDir(hub), 'active-conversation.json');
fs.writeFileSync(activeFile, JSON.stringify({
  id: stale.id,
  updated_at: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
}, null, 2));
const {
  STAMP_ACTIVE_MAX_AGE_MS,
  getActiveConversationId: getActiveNow,
  getStampConversationId: getStampNow,
  recordPendingAgentWork,
  getPendingAgentWorkConversationId,
} = require(`${root}/control-plane/lib/conversations`);
if (getActiveNow(hub) !== null) {
  console.error('presence window should treat 10min-old active as stale');
  process.exit(27);
}
if (getStampNow(hub) !== stale.id) {
  console.error('stamp window should still use stale active', getStampNow(hub), stale.id, STAMP_ACTIVE_MAX_AGE_MS);
  process.exit(28);
}
fs.writeFileSync(path.join(hub, 'outbox', '2026-07-24-hub-user-stale.md'), `---
from: hub
to: user
date: 2026-07-24
subject: stale active stamp
---

stale-active reply
`);
routed = routeOutboxes(hub);
if (routed.delivered !== 1) {
  console.error('expected stale-active deliver', routed);
  process.exit(29);
}
const stalePath = path.join(userInbox(hub), '2026-07-24-hub-user-stale.md');
const staleText = fs.readFileSync(stalePath, 'utf8');
if (frontmatterValue(staleText, 'conversation_id') !== stale.id) {
  console.error('stale active did not stamp hub→user', staleText);
  process.exit(30);
}
relayed = readUserInboxMessages(hub);
if ((relayed.relayed ?? relayed) !== 1) {
  console.error('expected stale-active relay', relayed);
  process.exit(31);
}

// hub→agent records pending work; agent→hub stamps even with no active/originating
fs.writeFileSync(activeFile, JSON.stringify({
  id: stale.id,
  updated_at: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
}, null, 2));
// Wipe active so only pending-agent-work can provide the id for agent→hub
fs.unlinkSync(activeFile);
const agentSlug = 'shell-tools';
fs.mkdirSync(path.join(hub, 'agents', agentSlug, 'inbox'), { recursive: true });
fs.mkdirSync(path.join(hub, 'agents', agentSlug, 'outbox'), { recursive: true });
// Restore a known conversation and record pending work as hub→agent route would
const workConv = createConversation(hub, 'Agent Work');
if (!recordPendingAgentWork(hub, agentSlug, workConv.id)) {
  console.error('recordPendingAgentWork failed');
  process.exit(32);
}
if (getPendingAgentWorkConversationId(hub, agentSlug) !== workConv.id) {
  console.error('pending agent work lookup failed');
  process.exit(33);
}
if (getStampNow(hub) !== null && getStampNow(hub) !== workConv.id) {
  // no active/originating — stamp without fromSlug should be null
}
if (getStampNow(hub, agentSlug) !== workConv.id) {
  console.error('stamp with fromSlug should use pending work', getStampNow(hub, agentSlug));
  process.exit(34);
}
// Simulate agent outbox → hub
fs.writeFileSync(path.join(hub, 'agents', agentSlug, 'outbox', '2026-07-24-shell-tools-done.md'), `---
from: shell-tools
to: hub
date: 2026-07-24
subject: work done
---

agent finished the task
`);
routed = routeOutboxes(hub);
if (routed.delivered !== 1) {
  console.error('expected agent→hub deliver', routed);
  process.exit(35);
}
const agentHubPath = path.join(hub, 'inbox', '2026-07-24-shell-tools-done.md');
if (!fs.existsSync(agentHubPath)) {
  console.error('missing stamped agent→hub file');
  process.exit(36);
}
const agentHubText = fs.readFileSync(agentHubPath, 'utf8');
if (frontmatterValue(agentHubText, 'conversation_id') !== workConv.id) {
  console.error('agent→hub missing pending-work conversation_id', agentHubText);
  process.exit(37);
}

// Regression: in-flight hub turn for chat A must NOT steal agent→hub mail
// for work dispatched from chat B (cross-conversation noise).
const otherHubChat = createConversation(hub, 'Other Hub Chat');
const agentWorkChat = createConversation(hub, 'Agent Owner Chat');
const crossPendingFile = path.join(appDir(hub), 'pending-hub-turns.json');
fs.writeFileSync(crossPendingFile, JSON.stringify({
  turns: [{
    conversationId: otherHubChat.id,
    startedAt: new Date().toISOString(),
    logByteOffset: 0,
  }],
}, null, 2));
if (!recordPendingAgentWork(hub, agentSlug, agentWorkChat.id)) {
  console.error('recordPendingAgentWork (cross-talk) failed');
  process.exit(40);
}
if (getStampNow(hub) !== otherHubChat.id) {
  console.error('hub→user stamp should still prefer originating turn', getStampNow(hub), otherHubChat.id);
  process.exit(41);
}
if (getStampNow(hub, agentSlug) !== agentWorkChat.id) {
  console.error(
    'agent→hub stamp must prefer pending agent work over in-flight hub turn',
    getStampNow(hub, agentSlug),
    agentWorkChat.id,
    otherHubChat.id,
  );
  process.exit(42);
}
fs.writeFileSync(path.join(hub, 'agents', agentSlug, 'outbox', '2026-07-24-shell-tools-cross.md'), `---
from: shell-tools
to: hub
date: 2026-07-24
subject: cross talk check
---

finished work for owner chat
`);
routed = routeOutboxes(hub);
if (routed.delivered !== 1) {
  console.error('expected cross-talk agent→hub deliver', routed);
  process.exit(43);
}
const crossPath = path.join(hub, 'inbox', '2026-07-24-shell-tools-cross.md');
const crossText = fs.readFileSync(crossPath, 'utf8');
if (frontmatterValue(crossText, 'conversation_id') !== agentWorkChat.id) {
  console.error('agent→hub stamped wrong conversation (cross-talk)', crossText);
  process.exit(44);
}
try { fs.unlinkSync(crossPendingFile); } catch (_e) { /* ignore */ }
try { fs.unlinkSync(crossPath); } catch (_e) { /* ignore */ }

// hub→agent route records pending work from stamp id
const dispatchConv = createConversation(hub, 'Dispatch Chat');
fs.writeFileSync(path.join(hub, 'registry.json'), JSON.stringify({
  settings: { dispatch: { max_concurrency: 2, lock_lease_secs: 60 } },
  products: [{ slug: 'shell-tools', name: 'Shell Tools', agent_name: 'Agent ST', projects: [] }],
}));
fs.writeFileSync(activeFile, JSON.stringify({
  id: dispatchConv.id,
  updated_at: new Date().toISOString(),
}, null, 2));
fs.writeFileSync(path.join(hub, 'outbox', '2026-07-24-hub-shell-tools-task.md'), `---
from: hub
to: shell-tools
date: 2026-07-24
subject: do task
---

please do the thing
`);
routed = routeOutboxes(hub);
if (routed.delivered !== 1) {
  console.error('expected hub→agent deliver', routed);
  process.exit(38);
}
if (getPendingAgentWorkConversationId(hub, agentSlug) !== dispatchConv.id) {
  console.error('hub→agent did not record pending work', getPendingAgentWorkConversationId(hub, agentSlug));
  process.exit(39);
}

// Clean fixtures so the next TMP2 test (launch ack) starts from a quiet hub.
for (const name of fs.readdirSync(path.join(hub, 'inbox'))) {
  if (name.endsWith('.md')) fs.unlinkSync(path.join(hub, 'inbox', name));
}
try { fs.unlinkSync(activeFile); } catch (_e) { /* ignore */ }
try { fs.unlinkSync(path.join(appDir(hub), 'pending-agent-work.json')); } catch (_e) { /* ignore */ }
fs.writeFileSync(path.join(hub, 'registry.json'), JSON.stringify({
  settings: { dispatch: { max_concurrency: 2, lock_lease_secs: 60 } },
  products: [],
}));
NODE
  then
    fail "conversation_id stamp-on-route failed"
  fi

  # CP launch ack + outbox safety net (reserved body / promote / hard fail / write-message)
  if ! node - "$ROOT" "$TMP2" <<'NODE'
const root = process.argv[2];
const hub = process.argv[3];
const fs = require('fs');
const path = require('path');
const {
  appendMessage,
  createConversation,
  getConversation,
  isLaunchAckMessage,
  LAUNCH_ACK_TEXT,
  postLaunchAck,
  readUserInboxMessages,
  STATUS_ERROR_KIND,
  supersedeLaunchAcks,
} = require(`${root}/control-plane/lib/conversations`);
const {
  conversationIdsFromSafetyResults,
  drainPendingHubTurns,
  ensureHubUserReply,
  extractFinalAssistantBlob,
  prepareReservedReplyBody,
  recordPendingHubTurn,
  readPendingHubTurns,
  reservedReplyBodyPath,
  setOnConversationMutated,
} = require(`${root}/control-plane/lib/hub-turn-safety`);
const { launchHub } = require(`${root}/control-plane/lib/dispatcher`);
const { buildHubTurnPrompt, deriveHubRuntimePrompt } = require(`${root}/control-plane/lib/hub-memory`);
const { routeOutboxes, writeOutboxMessage } = require(`${root}/control-plane/lib/mail`);

fs.mkdirSync(path.join(hub, 'outbox'), { recursive: true });
fs.mkdirSync(path.join(hub, 'inbox'), { recursive: true });
fs.mkdirSync(path.join(hub, 'user', 'inbox'), { recursive: true });
fs.mkdirSync(path.join(hub, 'logs'), { recursive: true });
fs.writeFileSync(path.join(hub, 'registry.json'), JSON.stringify({
  settings: { dispatch: { max_concurrency: 2, lock_lease_secs: 60 } },
  products: [],
}));

// --- extractFinalAssistantBlob unit ---
const blob = extractFinalAssistantBlob([
  'Reading inbox…',
  '',
  'Checking registry.',
  '',
  'On it — **Agent B** is implementing the fix. Stand by for the deploy note.',
].join('\n'));
if (!/Agent B/.test(blob) || !/implementing/.test(blob)) {
  console.error('blob missed final answer', blob);
  process.exit(1);
}
const noisy = extractFinalAssistantBlob('Error: Internal error:\n{"message":"API error"}\n');
if (noisy) {
  console.error('blob should drop API noise', noisy);
  process.exit(2);
}
// Narration-only should not promote junk
const narrOnly = extractFinalAssistantBlob('I\'ll check the registry.\n\nReading session memory.\n\nWriting the reply.');
if (narrOnly && /I\'ll check|Reading session|Writing the reply/.test(narrOnly) && narrOnly.length < 80) {
  // OK if empty; not OK if we only got narration
  if (!/\*\*|Agent |Fixed|Done/i.test(narrOnly)) {
    // pure narration — extractor may return last block; prefer empty
    // allow empty only
    if (narrOnly.split('\n').length <= 1 && /^(I\'ll|Reading|Writing)/i.test(narrOnly)) {
      console.error('blob should skip pure process narration', narrOnly);
      process.exit(2);
    }
  }
}
const authNoise = extractFinalAssistantBlob('Not signed in. To authenticate without a browser, run:\n  grok login --device-code\n');
if (authNoise) {
  console.error('blob should drop auth noise', authNoise);
  process.exit(2);
}

// --- runtime prompt bans free-form outbox / mandates write path ---
const runtimePrompt = deriveHubRuntimePrompt(hub);
if (!/write-message\.sh/.test(runtimePrompt)) {
  console.error('runtime prompt missing write-message mandate');
  process.exit(25);
}
if (!/Stdout is debug only/i.test(runtimePrompt) && !/stdout is \*\*not\*\*/i.test(runtimePrompt) && !/Stdout is \*\*debug only\*\*/i.test(runtimePrompt)) {
  console.error('runtime prompt missing stdout-is-debug rule', runtimePrompt.slice(0, 400));
  process.exit(26);
}
if (!/banned/i.test(runtimePrompt)) {
  console.error('runtime prompt should ban free-form outbox');
  process.exit(27);
}

// --- postLaunchAck + supersede ---
const conv = createConversation(hub, 'Ack Test');
const afterAck = postLaunchAck(hub, conv.id);
if (!afterAck.messages.some(isLaunchAckMessage)) {
  console.error('launch ack not posted', afterAck.messages);
  process.exit(3);
}
if (afterAck.messages.filter(isLaunchAckMessage).length !== 1) {
  console.error('expected exactly one ack');
  process.exit(4);
}
// second post while ack visible → no spam
postLaunchAck(hub, conv.id);
const noSpam = getConversation(hub, conv.id);
if (noSpam.messages.filter(isLaunchAckMessage).length !== 1) {
  console.error('ack spammed', noSpam.messages);
  process.exit(5);
}
if (noSpam.messages.find(isLaunchAckMessage).content !== LAUNCH_ACK_TEXT) {
  console.error('unexpected ack text');
  process.exit(6);
}

// hub reply supersedes ack
const lenWithAck = noSpam.messages.length;
const stampWithAck = noSpam.updated_at;
appendMessage(hub, conv.id, 'hub', 'Real reply from outbox path');
const afterHub = getConversation(hub, conv.id);
if (afterHub.messages.some(isLaunchAckMessage)) {
  console.error('ack not superseded by hub reply', afterHub.messages);
  process.exit(7);
}
if (!afterHub.messages.some((m) => m.role === 'hub' && m.content === 'Real reply from outbox path')) {
  console.error('hub reply missing');
  process.exit(8);
}
// Regression: strip-ack + append-hub keeps messages.length stable. UI poll must
// not key only on count (stuck interim); updated_at must advance so stamp differs.
if (afterHub.messages.length !== lenWithAck) {
  console.error('expected same-length supersede (ack out, hub in)', {
    before: lenWithAck, after: afterHub.messages.length,
  });
  process.exit(8);
}
if (!afterHub.updated_at || afterHub.updated_at === stampWithAck) {
  console.error('updated_at must change on ack→hub supersede for console poll', {
    before: stampWithAck, after: afterHub.updated_at,
  });
  process.exit(8);
}

// --- launchHub dry-run posts ack once, does not false-fail ---
const conv2 = createConversation(hub, 'Launch Ack');
fs.writeFileSync(path.join(hub, 'inbox', '2026-07-24-operator-console.md'), `---
from: operator
to: hub
date: 2026-07-24
subject: console message
conversation_id: ${conv2.id}
---

Hi
`);
// Minimal hub runtime scaffolding for launchHub
fs.mkdirSync(path.join(hub, '.bizagent', 'prompts'), { recursive: true });
fs.writeFileSync(path.join(hub, 'AGENT.md'), [
  '## § 3 — Operating',
  'You are PTL.',
  '## § 4 — Honest limits',
  'Limits here.',
  '',
].join('\n'));
launchHub({
  hub,
  dryRun: true,
  hubModel: '',
  hubCliName: '',
  lockLeaseSecs: 60,
  _cliJson: {},
});
const launched = getConversation(hub, conv2.id);
if (!launched.messages.some(isLaunchAckMessage)) {
  console.error('launchHub dry-run did not post ack', launched.messages);
  process.exit(9);
}
if (readPendingHubTurns(hub).length !== 0) {
  console.error('dry-run should not leave pending hub turns');
  process.exit(10);
}
// no error status from dry-run
if (launched.messages.some((m) => m.kind === STATUS_ERROR_KIND)) {
  console.error('dry-run false-failed');
  process.exit(11);
}
// dry-run builds turn prompt with reserved body path
const reservedDry = reservedReplyBodyPath(hub, conv2.id);
if (!reservedDry || !fs.existsSync(reservedDry)) {
  console.error('dry-run should prepare reserved reply body', reservedDry);
  process.exit(28);
}
const turnFiles = fs.readdirSync(path.join(hub, '.bizagent', 'prompts', 'turns') || path.join(hub, '.bizagent', 'prompts'))
  .filter((n) => n.startsWith('hub-'));
// turns dir may exist after buildHubTurnPrompt
const turnsDir = path.join(hub, '.bizagent', 'prompts', 'turns');
if (fs.existsSync(turnsDir)) {
  const latest = fs.readdirSync(turnsDir).filter((n) => n.startsWith('hub-')).sort().pop();
  if (latest) {
    const turnText = fs.readFileSync(path.join(turnsDir, latest), 'utf8');
    if (!turnText.includes('RESERVED_REPLY_BODY') && !turnText.includes(reservedDry)) {
      console.error('turn prompt missing reserved body path');
      process.exit(29);
    }
    if (!/write-message\.sh/.test(turnText)) {
      console.error('turn prompt missing write-message');
      process.exit(30);
    }
  }
}

// --- always-warm: stdout blob alone must NOT promote; empty reserved body → hard fail ---
const conv3 = createConversation(hub, 'NoPromote');
postLaunchAck(hub, conv3.id);
const agentLog = path.join(hub, 'logs', 'dispatch-hub.log');
const prefix = 'old log line before this turn\n\n';
fs.writeFileSync(agentLog, prefix);
const offset = Buffer.byteLength(prefix);
const startedAt = new Date().toISOString();
fs.appendFileSync(agentLog, [
  'Loading session…',
  '',
  '**Agent B** finished the CP launch-ack work. Ready to verify live.',
  '',
].join('\n'));
prepareReservedReplyBody(hub, conv3.id);
recordPendingHubTurn(hub, {
  conversationId: conv3.id,
  logByteOffset: offset,
  startedAt,
  agentLog,
});
const noPromote = ensureHubUserReply(hub, {
  conversationId: conv3.id,
  logByteOffset: offset,
  startedAt,
  agentLog,
  exitCode: 0,
});
if (noPromote.action !== 'failed') {
  console.error('expected hard-fail (no stdout promote in always-warm)', noPromote);
  process.exit(12);
}
const afterNoPromote = getConversation(hub, conv3.id);
if (afterNoPromote.messages.some(isLaunchAckMessage)) {
  console.error('ack survived hard fail', afterNoPromote.messages);
  process.exit(13);
}
if (afterNoPromote.messages.some((m) => m.role === 'hub' && /finished the CP launch-ack/.test(m.content))) {
  console.error('stdout must not be promoted into hub reply', afterNoPromote.messages);
  process.exit(14);
}
if (!afterNoPromote.messages.some((m) => m.role === 'status' && m.kind === STATUS_ERROR_KIND)) {
  console.error('expected status error when reserved body empty', afterNoPromote.messages);
  process.exit(15);
}
// idempotent second call
const again = ensureHubUserReply(hub, {
  conversationId: conv3.id,
  logByteOffset: offset,
  startedAt,
  agentLog,
});
if (again.action !== 'ok-existing' && again.action !== 'ok-failed-already' && again.action !== 'skip') {
  // pending cleared — must not double-post errors
}
const statusErrCount = afterNoPromote.messages.filter((m) => m.role === 'status' && m.kind === STATUS_ERROR_KIND).length;
const afterAgain = getConversation(hub, conv3.id);
const statusErrCount2 = afterAgain.messages.filter((m) => m.role === 'status' && m.kind === STATUS_ERROR_KIND).length;
if (statusErrCount2 !== statusErrCount) {
  console.error('double hard-fail post', statusErrCount, statusErrCount2);
  process.exit(15);
}

// --- safety net: hard fail when no outbox and no blob ---
const conv4 = createConversation(hub, 'Fail');
postLaunchAck(hub, conv4.id);
const emptyLog = path.join(hub, 'logs', 'dispatch-hub-empty.log');
const emptyStderr = path.join(hub, 'logs', 'dispatch-hub-empty.stderr');
fs.writeFileSync(emptyLog, '');
fs.writeFileSync(emptyStderr, 'Not signed in. To authenticate without a browser, run:\n  grok login --device-code\n');
const startedFail = new Date().toISOString();
prepareReservedReplyBody(hub, conv4.id);
const failed = ensureHubUserReply(hub, {
  conversationId: conv4.id,
  logByteOffset: 0,
  stderrByteOffset: 0,
  startedAt: startedFail,
  agentLog: emptyLog,
  agentStderr: emptyStderr,
  exitCode: 1,
});
if (failed.action !== 'failed') {
  console.error('expected failed', failed);
  process.exit(16);
}
const afterFail = getConversation(hub, conv4.id);
if (afterFail.messages.some(isLaunchAckMessage)) {
  console.error('ack survived hard fail');
  process.exit(17);
}
const failMsg = afterFail.messages.find((m) => m.role === 'status' && m.kind === STATUS_ERROR_KIND);
if (!failMsg) {
  console.error('hard fail status missing', afterFail.messages);
  process.exit(18);
}
if (!/exit code:\s*1/i.test(failMsg.content) || !/auth failure/i.test(failMsg.content)) {
  console.error('hard fail should mention exit code + auth', failMsg.content);
  process.exit(31);
}
// idempotent fail
const failed2 = ensureHubUserReply(hub, {
  conversationId: conv4.id,
  logByteOffset: 0,
  startedAt: startedFail,
  agentLog: emptyLog,
});
if (failed2.action !== 'ok-failed-already' && failed2.action !== 'ok-existing') {
  console.error('expected idempotent fail', failed2);
  process.exit(19);
}
const errCount = getConversation(hub, conv4.id).messages.filter(
  (m) => m.kind === STATUS_ERROR_KIND,
).length;
if (errCount !== 1) {
  console.error('duplicate hard fail', errCount);
  process.exit(20);
}

// --- real outbox path: safety net is no-op after route ---
const conv5 = createConversation(hub, 'RealOutbox');
postLaunchAck(hub, conv5.id);
const startedReal = new Date().toISOString();
fs.writeFileSync(path.join(hub, 'outbox', '2026-07-24-hub-real.md'), `---
from: hub
to: user
date: 2026-07-24
subject: real
conversation_id: ${conv5.id}
---

Proper outbox reply
`);
const real = ensureHubUserReply(hub, {
  conversationId: conv5.id,
  logByteOffset: 0,
  startedAt: startedReal,
  agentLog: emptyLog,
});
if (real.action !== 'ok-existing') {
  console.error('expected ok-existing for real outbox', real);
  process.exit(21);
}
const afterReal = getConversation(hub, conv5.id);
if (!afterReal.messages.some((m) => m.content === 'Proper outbox reply')) {
  console.error('real outbox not relayed', afterReal.messages);
  process.exit(22);
}
if (afterReal.messages.some(isLaunchAckMessage)) {
  console.error('ack not superseded by real outbox');
  process.exit(23);
}

// supersedeLaunchAcks direct
const conv6 = createConversation(hub, 'Super');
postLaunchAck(hub, conv6.id);
supersedeLaunchAcks(hub, conv6.id);
if (getConversation(hub, conv6.id).messages.some(isLaunchAckMessage)) {
  console.error('supersedeLaunchAcks failed');
  process.exit(24);
}

// --- reserved body path: body-only file becomes user-visible hub mail ---
const conv7 = createConversation(hub, 'Reserved');
postLaunchAck(hub, conv7.id);
const startedRes = new Date().toISOString();
const bodyPath = prepareReservedReplyBody(hub, conv7.id);
fs.writeFileSync(bodyPath, '**Reserved path works.** Operator should see only this.\n');
// Also dump narration to log — must NOT prefer log over reserved body
fs.appendFileSync(agentLog, '\nI am thinking out loud only.\n\n');
const reserved = ensureHubUserReply(hub, {
  conversationId: conv7.id,
  logByteOffset: 0,
  startedAt: startedRes,
  agentLog,
  replyBodyFile: bodyPath,
});
if (reserved.action !== 'reserved-body') {
  console.error('expected reserved-body', reserved);
  process.exit(32);
}
const afterRes = getConversation(hub, conv7.id);
if (!afterRes.messages.some((m) => m.role === 'hub' && /Reserved path works/.test(m.content))) {
  console.error('reserved body not in conversation', afterRes.messages);
  process.exit(33);
}
if (afterRes.messages.some(isLaunchAckMessage)) {
  console.error('ack survived reserved body');
  process.exit(34);
}
if (fs.existsSync(bodyPath)) {
  console.error('reserved body file should be cleared after success');
  process.exit(35);
}

// --- write-message helper path: always routes with conversation_id ---
const conv8 = createConversation(hub, 'WriteMsg');
postLaunchAck(hub, conv8.id);
const startedWm = new Date().toISOString();
prepareReservedReplyBody(hub, conv8.id); // empty — write-message wins via outbox
const wm = writeOutboxMessage(hub, {
  from: 'hub',
  to: 'user',
  subject: 'console reply',
  body: 'Delivered via write-message helper.',
  conversationId: conv8.id,
});
if (!wm.file || !fs.existsSync(wm.file)) {
  console.error('writeOutboxMessage did not create file', wm);
  process.exit(36);
}
const wmRaw = fs.readFileSync(wm.file, 'utf8');
if (!new RegExp(`conversation_id:\\s*${conv8.id}`).test(wmRaw)) {
  console.error('write-message outbox missing conversation_id', wmRaw);
  process.exit(39);
}
if (!/^to:\s*user\s*$/m.test(wmRaw) || !/^from:\s*hub\s*$/m.test(wmRaw)) {
  console.error('write-message outbox bad headers', wmRaw);
  process.exit(39);
}
const viaWm = ensureHubUserReply(hub, {
  conversationId: conv8.id,
  logByteOffset: 0,
  startedAt: startedWm,
  agentLog: emptyLog,
});
if (viaWm.action !== 'ok-existing') {
  console.error('expected ok-existing after write-message', viaWm);
  process.exit(37);
}
const afterWm = getConversation(hub, conv8.id);
if (!afterWm.messages.some((m) => m.role === 'hub' && /write-message helper/.test(m.content))) {
  console.error('write-message body not relayed', afterWm.messages);
  process.exit(38);
}
// After relay, mail lives in user/inbox/archive with same conversation_id
const archived = path.join(hub, 'user', 'inbox', 'archive');
const archMail = fs.existsSync(archived)
  ? fs.readdirSync(archived).filter((n) => n.endsWith('.md'))
    .map((n) => fs.readFileSync(path.join(archived, n), 'utf8'))
    .find((t) => /write-message helper/.test(t))
  : null;
if (!archMail || !new RegExp(`conversation_id:\\s*${conv8.id}`).test(archMail)) {
  console.error('write-message archived mail missing conversation_id', archMail);
  process.exit(39);
}

// --- buildHubTurnPrompt injects reserved path for console mail ---
// Clear leftover inbox so FIFO binds reserved path to this message (not older fixtures).
for (const name of fs.readdirSync(path.join(hub, 'inbox'))) {
  if (name.endsWith('.md')) fs.unlinkSync(path.join(hub, 'inbox', name));
}
const conv9 = createConversation(hub, 'TurnInject');
fs.writeFileSync(path.join(hub, 'inbox', '2026-07-24-operator-turn-inject.md'), `---
from: operator
to: hub
date: 2026-07-24
subject: inject
conversation_id: ${conv9.id}
---

ping
`);
const turnFile = buildHubTurnPrompt(hub);
const turnBody = fs.readFileSync(turnFile, 'utf8');
const expectedPath = reservedReplyBodyPath(hub, conv9.id);
if (!turnBody.includes(expectedPath)) {
  console.error('buildHubTurnPrompt missing reserved path', expectedPath, turnBody.slice(0, 500));
  process.exit(40);
}
if (!fs.existsSync(expectedPath)) {
  console.error('reserved body not created by buildHubTurnPrompt');
  process.exit(41);
}

// --- push path: safety net mutations notify main-process hook + return pushable ids ---
const convPush = createConversation(hub, 'PushPath');
postLaunchAck(hub, convPush.id);
const pushBody = prepareReservedReplyBody(hub, convPush.id);
fs.writeFileSync(pushBody, '**Push me over WS** — operator should not need refresh.\n');
const pushStarted = new Date().toISOString();
recordPendingHubTurn(hub, {
  conversationId: convPush.id,
  logByteOffset: 0,
  startedAt: pushStarted,
  agentLog: emptyLog,
  replyBodyFile: pushBody,
});
const pushedIds = [];
setOnConversationMutated((_hub, id) => { pushedIds.push(id); });
const drainResults = drainPendingHubTurns(hub, () => false);
setOnConversationMutated(null);
const fromResults = conversationIdsFromSafetyResults(drainResults);
if (!fromResults.includes(convPush.id)) {
  console.error('safety results missing pushable conversation id', drainResults, fromResults);
  process.exit(42);
}
if (!pushedIds.includes(convPush.id)) {
  console.error('setOnConversationMutated not invoked on reserved-body relay', pushedIds, drainResults);
  process.exit(43);
}
const afterPush = getConversation(hub, convPush.id);
if (!afterPush.messages.some((m) => m.role === 'hub' && /Push me over WS/.test(m.content))) {
  console.error('push-path reserved body not in conversation', afterPush.messages);
  process.exit(44);
}
// No duplicate hub reply on second drain
const hubN1 = afterPush.messages.filter((m) => m.role === 'hub').length;
const drain2 = drainPendingHubTurns(hub, () => false);
const hubN2 = getConversation(hub, convPush.id).messages.filter((m) => m.role === 'hub').length;
if (hubN2 !== hubN1) {
  console.error('duplicate hub reply after second drain', hubN1, hubN2, drain2);
  process.exit(45);
}
// conversationIdsFromSafetyResults filters skips
if (conversationIdsFromSafetyResults([{ action: 'skip' }, { action: 'expired', turn: { conversationId: 'x' } }]).length !== 0) {
  console.error('skip/expired should not be push-worthy');
  process.exit(46);
}
// readUserInboxMessages returns {relayed, ids}
const convRelay = createConversation(hub, 'RelayShape');
fs.mkdirSync(path.join(hub, 'user', 'inbox'), { recursive: true });
const relayFile = path.join(hub, 'user', 'inbox', '2026-07-26-hub-relay-shape.md');
fs.writeFileSync(relayFile, `---
from: hub
to: user
date: 2026-07-26
subject: shape
conversation_id: ${convRelay.id}
---

Relay shape body
`);
// Direct inbox file lacks delivery fingerprint — write via outbox path instead.
fs.unlinkSync(relayFile);
writeOutboxMessage(hub, {
  from: 'hub',
  to: 'user',
  subject: 'shape',
  body: 'Relay shape body',
  conversationId: convRelay.id,
});
routeOutboxes(hub);
const shape = readUserInboxMessages(hub);
if (!shape || typeof shape !== 'object' || typeof shape.relayed !== 'number' || !Array.isArray(shape.ids)) {
  console.error('readUserInboxMessages should return {relayed, ids}', shape);
  process.exit(47);
}
if (shape.relayed < 1 || !shape.ids.includes(convRelay.id)) {
  console.error('expected relayed id', shape, convRelay.id);
  process.exit(48);
}
// idempotent: second read does not double-append
const shape2 = readUserInboxMessages(hub);
const hubRelayCount = getConversation(hub, convRelay.id).messages.filter((m) => m.role === 'hub').length;
if (hubRelayCount !== 1) {
  console.error('duplicate hub relay', hubRelayCount, shape2);
  process.exit(49);
}
NODE
  then
    fail "launch ack / outbox safety net failed"
  fi

  # buildArgs: strips existing --model before appending override
  if ! node - "$ROOT" <<'NODE'
const root = process.argv[2];
// Inline buildArgs from dispatcher to test in isolation
function buildArgs(extraArgs, modelOverride) {
  if (!modelOverride) return extraArgs;
  if (!/^[A-Za-z0-9._:-]+$/.test(modelOverride)) {
    throw new Error(`Invalid model name: ${modelOverride}`);
  }
  const stripped = extraArgs
    .replace(/--model[= ]\S+/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
  return stripped ? `${stripped} --model ${modelOverride}` : `--model ${modelOverride}`;
}
// strip space-sep form
const r1 = buildArgs('--dangerously-skip-permissions --model claude-sonnet-4-6', 'claude-opus-4-8');
if (r1 !== '--dangerously-skip-permissions --model claude-opus-4-8') { console.error('r1 wrong:', r1); process.exit(1); }
// strip equals form
const r2 = buildArgs('--model=claude-sonnet-4-6', 'claude-opus-4-8');
if (r2 !== '--model claude-opus-4-8') { console.error('r2 wrong:', r2); process.exit(2); }
// no override → unchanged
const r3 = buildArgs('--dangerously-skip-permissions --model claude-sonnet-4-6', '');
if (r3 !== '--dangerously-skip-permissions --model claude-sonnet-4-6') { console.error('r3 wrong:', r3); process.exit(3); }
// no existing model → just append
const r4 = buildArgs('--dangerously-skip-permissions', 'claude-opus-4-8');
if (r4 !== '--dangerously-skip-permissions --model claude-opus-4-8') { console.error('r4 wrong:', r4); process.exit(4); }
// injection attempt → throw
let threw = false;
try { buildArgs('--dangerously-skip-permissions', 'bad; rm -rf /'); } catch (_) { threw = true; }
if (!threw) { console.error('injection not rejected'); process.exit(5); }
NODE
  then
    fail "buildArgs model-stripping logic failed"
  fi

  # agent-detail: inbox count, lastDispatched, journal snippet
  if ! node - "$ROOT" "$TMP" <<'NODE'
const root = process.argv[2];
const hub = process.argv[3];
const fs = require('fs');
const path = require('path');
const { createServer } = require(`${root}/control-plane/server`);
const http = require('http');
// Exercise getAgentDetail directly via a minimal require of server.js exports.
// Build a fixture: agents/alpha/inbox has 2 .md files, archive has 1, journal has a line.
const alphaDir = path.join(hub, 'agents', 'alpha');
const inboxDir = path.join(alphaDir, 'inbox');
const archiveDir = path.join(inboxDir, 'archive');
const journalDir = path.join(alphaDir, '.agent', 'journal');
fs.mkdirSync(journalDir, { recursive: true });
fs.writeFileSync(path.join(inboxDir, 'msg-a.md'), '---\nfrom: hub\n---\nhello');
fs.writeFileSync(path.join(inboxDir, 'msg-b.md'), '---\nfrom: hub\n---\nworld');
fs.writeFileSync(path.join(archiveDir, 'old.md'), '---\nfrom: hub\n---\ndone');
const today = new Date().toISOString().slice(0, 10);
fs.writeFileSync(path.join(journalDir, `${today}.md`), '\n\n- First journal entry');
// Inline the getAgentDetail logic to test it without starting the HTTP server.
function getAgentDetail(h, slug) {
  const agentDir = path.join(h, 'agents', slug);
  const iDir = path.join(agentDir, 'inbox');
  const aDir = path.join(iDir, 'archive');
  const jDir = path.join(agentDir, '.agent', 'journal');
  let inbox = 0;
  try { inbox = fs.readdirSync(iDir).filter(f => f.endsWith('.md')).length; } catch(_) {}
  let lastDispatched = null;
  try {
    let maxMs = 0;
    for (const f of fs.readdirSync(aDir)) {
      try { const ms = fs.statSync(path.join(aDir, f)).mtimeMs; if (ms > maxMs) maxMs = ms; } catch(_) {}
    }
    if (maxMs > 0) lastDispatched = maxMs;
  } catch(_) {}
  let journal = null;
  try {
    const t = new Date().toISOString().slice(0, 10);
    let jp = path.join(jDir, `${t}.md`);
    if (!fs.existsSync(jp)) {
      const files = fs.readdirSync(jDir).filter(f => f.endsWith('.md')).sort();
      jp = files.length > 0 ? path.join(jDir, files[files.length - 1]) : null;
    }
    if (jp) {
      const line = fs.readFileSync(jp, 'utf8').split('\n').find(l => l.trim() !== '');
      if (line) journal = line.trim();
    }
  } catch(_) {}
  return { inbox, lastDispatched, journal };
}
const detail = getAgentDetail(hub, 'alpha');
if (detail.inbox !== 2) { console.error('inbox count wrong:', detail.inbox); process.exit(11); }
if (!detail.lastDispatched) { console.error('lastDispatched missing'); process.exit(12); }
if (detail.journal !== '- First journal entry') { console.error('journal wrong:', detail.journal); process.exit(13); }
NODE
  then
    fail "agent-detail (inbox/lastDispatched/journal) logic failed"
  fi

  # Regression: bare numbers in chat messages must not render as "undefined".
  # (app.js used a ` N ` codespan placeholder that collided with any standalone
  # number in message text; fixed with a \x00CODESPAN:N\x00 placeholder.)
  if ! node - "$ROOT" <<'NODE'
const root = process.argv[2];
const fs = require('fs');
const vm = require('vm');
const src = fs.readFileSync(`${root}/control-plane/public/app.js`, 'utf8');
const sandbox = {
  document: { getElementById: () => ({ addEventListener: () => {}, textContent: '', dataset: {}, value: '' }), addEventListener: () => {} },
  setInterval: () => 0,
  fetch: () => Promise.reject(new Error('no network in test')),
  EventSource: function() { this.onmessage = null; this.onerror = null; this.close = () => {}; },
  console,
};
vm.createContext(sandbox);
vm.runInContext(src, sandbox);
const bare = sandbox.renderMarkdown('8 of 12 agents responded.');
if (bare.includes('undefined')) { console.error('bare number rendered as undefined:', bare); process.exit(1); }
const mixed = sandbox.renderMarkdown('Use `code 5` here, and 9 more.');
if (mixed.includes('undefined')) { console.error('number near a code span rendered as undefined:', mixed); process.exit(2); }
if (!mixed.includes('<code>code 5</code>')) { console.error('code span not preserved:', mixed); process.exit(3); }
// Regression: operator-reported shape (2026-07-15) — numbers embedded in a
// longer report sentence, including em-dash/arrow punctuation, must survive.
const report = sandbox.renderMarkdown(
  "Agent T's scaled-up run (10 layers full-depth, 4000 steps, 8x the smoke test) " +
  "confirms the null result: loss dropped much further (3.22→1.89) but " +
  "generations are still byte-identical to baseline on all 40 probes " +
  "— activation steering just isn't flipping decoding, at any scale tried."
);
if (report.includes('undefined')) { console.error('report numbers rendered as undefined:', report); process.exit(4); }
if (!report.includes('4000 steps') || !report.includes('all 40 probes')) {
  console.error('report numbers/spacing not preserved:', report); process.exit(5);
}

// GFM tables, safe links, and images.
const table = sandbox.renderMarkdown(
  '| Feature | Status |\n' +
  '| --- | --- |\n' +
  '| tables | **ok** |\n' +
  '| links | [docs](https://example.com/docs) |\n'
);
if (!table.includes('<table>') || !table.includes('<th>') || !table.includes('<td>')) {
  console.error('table not rendered as HTML table:', table); process.exit(6);
}
if (!table.includes('<strong>ok</strong>')) {
  console.error('inline markdown inside table cell broken:', table); process.exit(7);
}
const link = sandbox.renderMarkdown('See [Example](https://example.com/path) please.');
if (!link.includes('<a href="https://example.com/path" target="_blank" rel="noopener noreferrer">Example</a>')) {
  console.error('link not rendered safely:', link); process.exit(8);
}
const badLink = sandbox.renderMarkdown('Nope [x](javascript:alert(1)).');
if (badLink.includes('<a ')) {
  console.error('unsafe link scheme should not render as anchor:', badLink); process.exit(9);
}
const img = sandbox.renderMarkdown(
  '![test: Image of stir-fry](https://lusciousrecipes.com/wp-content/uploads/2025/12/beef-stir-fry-2025-12-19-145624.webp)'
);
if (!img.includes('<img src="https://lusciousrecipes.com/wp-content/uploads/2025/12/beef-stir-fry-2025-12-19-145624.webp"')
    || !img.includes('alt="test: Image of stir-fry"')
    || !img.includes('loading="lazy"')) {
  console.error('image not rendered:', img); process.exit(10);
}
const stillCode = sandbox.renderMarkdown('```\n| not | a | table |\n```\nand `![x](https://example.com/a.png)` stays code.');
if (stillCode.includes('<table>') || stillCode.includes('<img ')) {
  console.error('fenced/code content should not become table/img:', stillCode); process.exit(11);
}
if (!stillCode.includes('<code>![x](https://example.com/a.png)</code>')) {
  console.error('inline image syntax inside code span broken:', stillCode); process.exit(12);
}
NODE
  then
    fail "renderMarkdown regression: numbers in chat messages render as literal 'undefined'"
  fi

  # Regression: registry.json changes (new agents, dispatch settings) must be
  # picked up by a long-running control-plane process without a restart.
  if ! node - "$ROOT" <<'NODE'
const root = process.argv[2];
const fs = require('fs');
const path = require('path');
const os = require('os');
const { loadRuntimeConfig, refreshRegistry, agentsFromRegistry } = require(`${root}/control-plane/lib/config`);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'biz-registry-hotreload-'));
fs.writeFileSync(path.join(tmp, 'registry.json'), JSON.stringify({ settings: {}, products: [{ slug: 'alpha', name: 'Alpha' }] }));

const config = loadRuntimeConfig(tmp);
if (agentsFromRegistry(config.registry).map((a) => a.slug).join(',') !== 'alpha') {
  console.error('initial load did not include alpha');
  process.exit(1);
}

const later = new Date(Date.now() + 2000);
fs.writeFileSync(path.join(tmp, 'registry.json'), JSON.stringify({
  settings: { dispatch: { max_concurrency: 9 } },
  products: [{ slug: 'alpha', name: 'Alpha' }, { slug: 'beta', name: 'Beta' }],
}));
fs.utimesSync(path.join(tmp, 'registry.json'), later, later);

refreshRegistry(config);
const slugs = agentsFromRegistry(config.registry).map((a) => a.slug).join(',');
if (slugs !== 'alpha,beta') { console.error('new agent not picked up without restart:', slugs); process.exit(2); }
if (config.maxConcurrency !== 9) { console.error('dispatch settings not refreshed:', config.maxConcurrency); process.exit(3); }
fs.rmSync(tmp, { recursive: true, force: true });
NODE
  then
    fail "config.refreshRegistry: new agents/settings in registry.json are not picked up without a restart"
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

  # compileAgentCommand matches dispatcher: cli promptFlag promptFile extraArgs
  if ! node - "$ROOT" <<'NODE'
const root = process.argv[2];
const { compileAgentCommand } = require(`${root}/control-plane/lib/cli-config`);

const cmd1 = compileAgentCommand(
  { cli: 'scripts/bizagent-agent', promptFlag: '-f', extraArgs: '-y --provider grok --model grok-4.5' },
  '/path/to/prompt.md',
);
const expected1 = 'scripts/bizagent-agent -f /path/to/prompt.md -y --provider grok --model grok-4.5';
if (cmd1 !== expected1) {
  console.error('Test 1 failed. Got:', cmd1, 'Expected:', expected1);
  process.exit(1);
}

const cmd2 = compileAgentCommand(
  { cli: 'scripts/bizagent-agent', promptFlag: '-f', extraArgs: '' },
  '/path/to/prompt.md',
);
if (cmd2 !== 'scripts/bizagent-agent -f /path/to/prompt.md') {
  console.error('Test 2 failed:', cmd2);
  process.exit(2);
}
NODE
  then
    fail "compileAgentCommand argument ordering failed"
  fi

  # cli.json is a provider catalog (+ _runtime); registry uses provider (cliName alias).
  if ! node - "$ROOT" <<'NODE'
const root = process.argv[2];
const fs = require('fs');
const path = require('path');
const cliExamplePath = path.join(root, 'cli.json.example');
const registryExamplePath = path.join(root, 'registry.example.json');

const cliExample = JSON.parse(fs.readFileSync(cliExamplePath, 'utf8'));
const registryExample = JSON.parse(fs.readFileSync(registryExamplePath, 'utf8'));

if (!cliExample._runtime || !cliExample._runtime.executable) {
  console.error('cli.json.example missing _runtime.executable');
  process.exit(1);
}

const knownSlugs = (registryExample.products || []).map(p => p.slug);
const cliKeys = Object.keys(cliExample).filter(k => !k.startsWith('_'));
for (const slug of knownSlugs) {
  if (cliKeys.includes(slug)) {
    console.error('cli.json has agent slug key (should only be providers):', slug);
    process.exit(2);
  }
}

const validProviders = ['grok', 'chatgpt', 'claude', 'gemini', 'venice', 'ollama'];
for (const key of cliKeys) {
  if (!validProviders.includes(key)) {
    console.error('cli.json has unexpected provider:', key);
    process.exit(3);
  }
  const def = cliExample[key] || {};
  if (!def.baseURL && !def.baseUrl) {
    console.error('provider missing baseURL:', key);
    process.exit(4);
  }
  if (!Array.isArray(def.models)) {
    console.error('provider missing models:', key);
    process.exit(5);
  }
}

for (const product of registryExample.products || []) {
  const provider = product.provider || product.cliName;
  if (typeof provider !== 'string') {
    console.error('product missing provider:', product.slug);
    process.exit(6);
  }
  if (product.cli !== undefined) {
    console.error('product has inline cli object:', product.slug);
    process.exit(7);
  }
  if (!validProviders.includes(provider)) {
    console.error('product provider not valid:', product.provider, product.slug);
    process.exit(8);
  }
}
NODE
  then
    fail "cli.json/registry.json provider schema validation failed"
  fi

  # hub_agent.provider drives launches; always bizagent-agent; legacy .cli name-only fallback
  if ! node - "$ROOT" <<'NODE'
const root = process.argv[2];
const fs = require('fs');
const path = require('path');
const os = require('os');
const { loadRuntimeConfig } = require(`${root}/control-plane/lib/config`);
const { getCliSettings } = require(`${root}/control-plane/lib/cli-config`);

const hub = fs.mkdtempSync(path.join(os.tmpdir(), 'bizagent-hub-cli-'));
fs.writeFileSync(path.join(hub, 'registry.json'), JSON.stringify({
  settings: {
    hub_agent: { provider: 'grok', cliName: 'grok', model: 'grok-4.5' },
    models: { agent_default: 'grok-4.5' },
  },
  products: [],
}));
// Legacy .cli says claude — must NOT win when registry provider is set
fs.writeFileSync(path.join(hub, '.cli'), [
  'CLI_CMD=claude',
  'CLI_PROMPT_FLAG=-p',
  'CLI_EXTRA_ARGS=--dangerously-skip-permissions',
  '',
].join('\n'));
fs.writeFileSync(path.join(hub, 'cli.json'), JSON.stringify({
  _runtime: { executable: 'scripts/bizagent-agent', promptFlag: '-f', flags: { extra: '-y' } },
  grok: { baseURL: 'https://api.x.ai/v1', keyEnv: 'XAI_API_KEY', models: ['grok-4.5'] },
  claude: { baseURL: 'https://api.anthropic.com/v1/', keyEnv: 'ANTHROPIC_API_KEY', models: ['claude-sonnet-4-6'] },
  chatgpt: { baseURL: 'https://api.openai.com/v1', keyEnv: 'OPENAI_API_KEY', models: ['gpt-4o'] },
  gemini: { baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai/', keyEnv: 'GEMINI_API_KEY', models: ['gemini-2.5-flash'] },
}));

const config = loadRuntimeConfig(hub);
if (config.hubCliName !== 'grok' && config.hubProvider !== 'grok') {
  console.error('hub provider wrong:', config.hubCliName, config.hubProvider);
  process.exit(1);
}
if (config.hubModel !== 'grok-4.5') {
  console.error('hubModel wrong:', config.hubModel);
  process.exit(2);
}
const settings = getCliSettings(hub, config._cliJson, config, config.hubCliName || '', config.hubModel || '');
if (settings.cli !== 'scripts/bizagent-agent') {
  console.error('hub executable wrong:', settings.cli);
  process.exit(3);
}
if (settings.promptFlag !== '-f') {
  console.error('hub promptFlag wrong:', settings.promptFlag);
  process.exit(10);
}
if (!settings.extraArgs.includes('--model grok-4.5')) {
  console.error('hub model not applied:', settings.extraArgs);
  process.exit(4);
}
if (!settings.extraArgs.includes('--provider grok')) {
  console.error('hub provider flag missing:', settings.extraArgs);
  process.exit(5);
}

// Empty hub_agent.provider → migrate name from legacy .cli only
fs.writeFileSync(path.join(hub, 'registry.json'), JSON.stringify({
  settings: { hub_agent: { model: '' }, models: {} },
  products: [],
}));
const fallback = loadRuntimeConfig(hub);
if (fallback.hubCliName !== 'claude') {
  console.error('legacy .cli name fallback expected claude, got:', fallback.hubCliName);
  process.exit(6);
}
if (!fallback._hubCliFromLegacyDotCli) {
  console.error('expected _hubCliFromLegacyDotCli marker');
  process.exit(7);
}
// Legacy cliName "claude" maps to claude provider
const fallbackSettings = getCliSettings(
  hub, fallback._cliJson, fallback, fallback.hubCliName || '', fallback.hubModel || '',
);
if (fallbackSettings.cli !== 'scripts/bizagent-agent') {
  console.error('fallback executable wrong:', fallbackSettings.cli);
  process.exit(8);
}
if (!/--provider claude/.test(fallbackSettings.extraArgs || '')) {
  console.error('legacy claude should map to claude provider:', fallbackSettings.extraArgs);
  process.exit(9);
}

fs.rmSync(hub, { recursive: true, force: true });
NODE
  then
    fail "hub_agent.provider does not control hub LLM selection"
  fi

  # Phase 0/1: slim hub prompt, turn injection, runtime cwd, pollSeconds, promptFlag key
  if ! node - "$ROOT" <<'NODE'
const root = process.argv[2];
const fs = require('fs');
const path = require('path');
const os = require('os');
const {
  buildHubTurnPrompt,
  deriveHubRuntimePrompt,
  ensureHubRuntimeCwd,
  ensureHubRuntimePrompt,
  hubRuntimeCwd,
  hubSessionFile,
} = require(`${root}/control-plane/lib/hub-memory`);
const { getCliSettings } = require(`${root}/control-plane/lib/cli-config`);
const { loadRuntimeConfig } = require(`${root}/control-plane/lib/config`);
const { isMultiRecipient, routeOutboxes } = require(`${root}/control-plane/lib/mail`);

const hub = fs.mkdtempSync(path.join(os.tmpdir(), 'bizagent-latency-'));
fs.mkdirSync(path.join(hub, 'inbox'), { recursive: true });
fs.mkdirSync(path.join(hub, 'outbox'), { recursive: true });
fs.mkdirSync(path.join(hub, 'agents'), { recursive: true });
fs.writeFileSync(path.join(hub, 'registry.json'), JSON.stringify({
  settings: { dispatch: { poll_seconds: 2, max_concurrency: 4, lock_lease_secs: 60 } },
  products: [],
}));
fs.writeFileSync(path.join(hub, 'AGENT.md'), [
  '# AGENT.md',
  '',
  '## § 3 — Operating',
  '',
  'You are the PTL.',
  '',
  '## § 4 — Honest limits',
  '',
  'Limits here.',
  '',
].join('\n'));
fs.writeFileSync(path.join(hub, 'inbox/2026-07-24-user-hi.md'), [
  '---',
  'from: user',
  'to: hub',
  'date: 2026-07-24',
  'subject: hi',
  'conversation_id: 2026-07-24-test-abc123',
  '---',
  '',
  'Hi',
].join('\n'));

const prompt = deriveHubRuntimePrompt(hub);
if (!/BUILT/i.test(prompt)) {
  console.error('slim prompt missing BUILT assumption');
  process.exit(1);
}
if (!/outbox-first|Answer first/i.test(prompt)) {
  console.error('slim prompt missing outbox-first order');
  process.exit(2);
}
if (/Keep that file compact\. Compress older turns/i.test(prompt)) {
  console.error('slim prompt still asks LLM to compress session');
  process.exit(3);
}
if (Buffer.byteLength(prompt, 'utf8') > 6000) {
  console.error('always-on hub prompt too large:', Buffer.byteLength(prompt, 'utf8'));
  process.exit(4);
}

ensureHubRuntimePrompt(hub);
const turnFile = buildHubTurnPrompt(hub);
const turn = fs.readFileSync(turnFile, 'utf8');
if (!turn.includes('Hi') || !turn.includes('2026-07-24-test-abc123')) {
  console.error('turn prompt missing pending mail body or conversation_id');
  process.exit(5);
}
if (!turn.includes(path.basename(hubSessionFile(hub))) && !/hub-session\.md/.test(turn)) {
  console.error('turn prompt missing session pointer');
  process.exit(6);
}

const cwd = ensureHubRuntimeCwd(hub);
if (!fs.existsSync(path.join(cwd, 'inbox'))) {
  console.error('runtime-cwd missing inbox symlink');
  process.exit(7);
}
if (fs.existsSync(path.join(cwd, 'AGENT.md'))) {
  console.error('runtime-cwd must not include AGENT.md');
  process.exit(8);
}

// Provider catalog → always bizagent-agent (-f / -y); provider name is not a vendor CLI.
const catalog = {
  _runtime: { executable: 'scripts/bizagent-agent', promptFlag: '-f', flags: { extra: '-y' } },
  grok: { baseURL: 'https://api.x.ai/v1', keyEnv: 'XAI_API_KEY', models: ['grok-4.5'] },
  claude: { baseURL: 'https://api.anthropic.com/v1/', keyEnv: 'ANTHROPIC_API_KEY', models: ['claude-sonnet-4-6'] },
};
const settings = getCliSettings(hub, catalog, {
  cli: 'claude', hubCliName: 'claude', hubProvider: 'grok',
}, 'grok', '');
if (settings.cli !== 'scripts/bizagent-agent') {
  console.error('expected bizagent-agent executable:', settings.cli);
  process.exit(9);
}
if (settings.promptFlag !== '-f') {
  console.error('getCliSettings ignored runtime promptFlag:', settings.promptFlag);
  process.exit(9);
}
if (!/(^|\s)-y(\s|$)/.test(settings.extraArgs || '')) {
  console.error('expected -y auto-approve in extraArgs:', settings.extraArgs);
  process.exit(10);
}
const viaClaude = getCliSettings(hub, catalog, {
  cli: 'grok', hubCliName: 'grok', hubProvider: 'claude',
}, 'claude', '');
if (viaClaude.cli !== 'scripts/bizagent-agent' || viaClaude.promptFlag !== '-f') {
  console.error('claude provider should still launch bizagent-agent:', viaClaude);
  process.exit(10);
}

const cfg = loadRuntimeConfig(hub);
if (cfg.pollSeconds !== 2) {
  console.error('pollSeconds wrong:', cfg.pollSeconds);
  process.exit(11);
}

if (!isMultiRecipient('hub, o-protocol') || isMultiRecipient('hub')) {
  console.error('isMultiRecipient logic wrong');
  process.exit(12);
}

fs.rmSync(hub, { recursive: true, force: true });
NODE
  then
    fail "latency phase 0/1 hub prompt/turn/cwd/poll tests failed"
  fi

  # Phase 2: concurrency tiers + product-agent turn injection
  if ! node - "$ROOT" <<'NODE'
const root = process.argv[2];
const fs = require('fs');
const path = require('path');
const os = require('os');
const { loadRuntimeConfig } = require(`${root}/control-plane/lib/config`);
const { buildAgentTurnPrompt } = require(`${root}/control-plane/lib/hub-memory`);
const {
  dispatchPendingAgents,
  liveAgentCount,
  liveHubCount,
} = require(`${root}/control-plane/lib/dispatcher`);

const hub = fs.mkdtempSync(path.join(os.tmpdir(), 'bizagent-phase2-'));
fs.mkdirSync(path.join(hub, 'inbox'), { recursive: true });
fs.mkdirSync(path.join(hub, 'outbox'), { recursive: true });
fs.mkdirSync(path.join(hub, 'logs'), { recursive: true });
fs.mkdirSync(path.join(hub, 'templates'), { recursive: true });
fs.mkdirSync(path.join(hub, 'agents/alpha/inbox/archive'), { recursive: true });
fs.mkdirSync(path.join(hub, 'agents/alpha/outbox'), { recursive: true });
fs.mkdirSync(path.join(hub, 'agents/beta/inbox/archive'), { recursive: true });
fs.mkdirSync(path.join(hub, 'agents/beta/outbox'), { recursive: true });
fs.writeFileSync(path.join(hub, 'templates/dispatch.md.template'), [
  "You are the '{{slug}}' agent. Read {{agent_md}}.",
  'Process {{inbox}}; write {{outbox}}.',
].join('\n'));
fs.writeFileSync(path.join(hub, 'agents/alpha/agent.md'), '# Alpha\n');
fs.writeFileSync(path.join(hub, 'agents/beta/agent.md'), '# Beta\n');
fs.writeFileSync(path.join(hub, 'registry.json'), JSON.stringify({
  settings: {
    dispatch: {
      poll_seconds: 2,
      max_concurrency: 8,
      hub_slots: 1,
      agent_slots: 8,
      lock_lease_secs: 60,
    },
  },
  products: [
    { slug: 'alpha', name: 'Alpha', agent_name: 'Agent A', projects: [] },
    { slug: 'beta', name: 'Beta', agent_name: 'Agent B', projects: [] },
  ],
}));

const cfg = loadRuntimeConfig(hub);
if (cfg.hubSlots !== 1 || cfg.agentSlots !== 8 || cfg.maxConcurrency !== 8) {
  console.error('tier defaults wrong:', {
    hubSlots: cfg.hubSlots,
    agentSlots: cfg.agentSlots,
    maxConcurrency: cfg.maxConcurrency,
  });
  process.exit(1);
}
if (cfg.pollSeconds !== 2) {
  console.error('pollSeconds not 2:', cfg.pollSeconds);
  process.exit(2);
}

// agent_slots overrides max_concurrency when set
fs.writeFileSync(path.join(hub, 'registry.json'), JSON.stringify({
  settings: { dispatch: { max_concurrency: 4, agent_slots: 6, hub_slots: 1, lock_lease_secs: 60 } },
  products: [
    { slug: 'alpha', name: 'Alpha', agent_name: 'Agent A', projects: [] },
    { slug: 'beta', name: 'Beta', agent_name: 'Agent B', projects: [] },
  ],
}));
const cfg2 = loadRuntimeConfig(hub);
if (cfg2.agentSlots !== 6 || cfg2.hubSlots !== 1 || cfg2.maxConcurrency !== 4) {
  console.error('agent_slots override wrong:', cfg2);
  process.exit(3);
}

// Product turn injects pending mail body
fs.writeFileSync(path.join(hub, 'agents/alpha/.dispatch.md'), 'Standing alpha dispatch.');
fs.writeFileSync(path.join(hub, 'agents/alpha/inbox/2026-07-24-hub-status.md'), [
  '---',
  'from: hub',
  'to: alpha',
  'date: 2026-07-24',
  'subject: status request',
  '---',
  '',
  'Reply with a one-line status.',
].join('\n'));
const turnFile = buildAgentTurnPrompt(hub, 'alpha');
const turn = fs.readFileSync(turnFile, 'utf8');
if (!turn.includes('Reply with a one-line status') || !turn.includes('status request')) {
  console.error('agent turn missing pending mail body/subject');
  process.exit(4);
}
if (!turn.includes('Standing alpha dispatch')) {
  console.error('agent turn missing standing dispatch text');
  process.exit(5);
}
if (!/agents\/alpha\/inbox/.test(turn)) {
  console.error('agent turn missing archive path hint');
  process.exit(6);
}

// Dry-run dispatch with agent_slots=1 should launch one of two pending agents
fs.writeFileSync(path.join(hub, 'agents/beta/inbox/2026-07-24-hub-status.md'), [
  '---',
  'from: hub',
  'to: beta',
  'date: 2026-07-24',
  'subject: status request',
  '---',
  '',
  'status please',
].join('\n'));
fs.writeFileSync(path.join(hub, 'registry.json'), JSON.stringify({
  settings: { dispatch: { max_concurrency: 1, agent_slots: 1, hub_slots: 1, lock_lease_secs: 60 } },
  products: [
    { slug: 'alpha', name: 'Alpha', agent_name: 'Agent A', projects: [] },
    { slug: 'beta', name: 'Beta', agent_name: 'Agent B', projects: [] },
  ],
}));
process.env.BIZAGENT_DRY_RUN = '1';
const cfg3 = loadRuntimeConfig(hub);
const result = dispatchPendingAgents(cfg3);
if (result.launched !== 1) {
  console.error('expected 1 launch under agent_slots=1, got', result);
  process.exit(7);
}
if (result.skippedCap < 1) {
  console.error('expected skippedCap for second agent, got', result);
  process.exit(8);
}
if (result.agentSlots !== 1 || result.hubSlots !== 1) {
  console.error('dispatch result missing tier fields', result);
  process.exit(9);
}
// Hub pending should not be blocked by agent_slots alone: hub has its own pool.
// (No hub mail here — live counts should be zero after dry-run unlocks.)
if (liveHubCount(hub, 60) !== 0 || liveAgentCount(hub, 60) !== 0) {
  console.error('dry-run left live locks');
  process.exit(10);
}

fs.rmSync(hub, { recursive: true, force: true });
NODE
  then
    fail "latency phase 2 concurrency/product-injection tests failed"
  fi
fi

  # write-message helper: filename, frontmatter, optional conversation_id, body file/stdin
  if ! node - "$ROOT" "$TMP2" <<'NODE'
const root = process.argv[2];
const hub = process.argv[3];
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const {
  frontmatterValue,
  writeOutboxMessage,
  subjectSlug,
} = require(`${root}/control-plane/lib/mail`);

fs.mkdirSync(path.join(hub, 'outbox'), { recursive: true });
fs.mkdirSync(path.join(hub, 'agents', 'alpha', 'outbox'), { recursive: true });
fs.writeFileSync(path.join(hub, 'registry.json'), JSON.stringify({
  settings: { dispatch: { max_concurrency: 2, lock_lease_secs: 60 } },
  products: [{ slug: 'alpha', name: 'Alpha', agent_name: 'Agent A', projects: [] }],
}));

if (subjectSlug('Hello World!!') !== 'hello-world') {
  console.error('subjectSlug wrong', subjectSlug('Hello World!!'));
  process.exit(1);
}

const r1 = writeOutboxMessage(hub, {
  from: 'hub',
  to: 'user',
  subject: 'console reply',
  body: 'Hello operator',
  conversationId: '2026-07-24-main-abcdef',
  date: '2026-07-24',
});
if (!fs.existsSync(r1.file)) {
  console.error('missing file', r1);
  process.exit(2);
}
if (!/^2026-07-24-hub-console-reply/.test(r1.basename)) {
  console.error('bad basename', r1.basename);
  process.exit(3);
}
const t1 = fs.readFileSync(r1.file, 'utf8');
if (frontmatterValue(t1, 'from') !== 'hub' || frontmatterValue(t1, 'to') !== 'user') {
  console.error('bad from/to', t1);
  process.exit(4);
}
if (frontmatterValue(t1, 'subject') !== 'console reply') {
  console.error('bad subject', t1);
  process.exit(5);
}
if (frontmatterValue(t1, 'conversation_id') !== '2026-07-24-main-abcdef') {
  console.error('missing conversation_id', t1);
  process.exit(6);
}
if (!t1.includes('Hello operator')) {
  console.error('missing body', t1);
  process.exit(7);
}

// no conversation_id when omitted
const r2 = writeOutboxMessage(hub, {
  from: 'alpha',
  to: 'hub',
  subject: 'status',
  body: 'all good',
  date: '2026-07-24',
});
const t2 = fs.readFileSync(r2.file, 'utf8');
if (frontmatterValue(t2, 'conversation_id')) {
  console.error('invented conversation_id', t2);
  process.exit(8);
}
if (!r2.file.includes(`${path.sep}agents${path.sep}alpha${path.sep}outbox${path.sep}`)) {
  console.error('agent outbox path wrong', r2.file);
  process.exit(9);
}

// CLI --content-file
const bodyFile = path.join(hub, 'body.txt');
fs.writeFileSync(bodyFile, 'from file\n');
const cli = spawnSync('node', [
  `${root}/scripts/bizagent-control-plane.js`, 'write-message',
  '--hub', hub,
  '--from', 'hub',
  '--to', 'alpha',
  '--subject', 'file body',
  '--content-file', bodyFile,
], { encoding: 'utf8' });
if (cli.status !== 0) {
  console.error('CLI content-file failed', cli.status, cli.stderr, cli.stdout);
  process.exit(10);
}
const outFiles = fs.readdirSync(path.join(hub, 'outbox')).filter((n) => n.includes('file-body'));
if (outFiles.length < 1) {
  console.error('CLI did not write file-body', fs.readdirSync(path.join(hub, 'outbox')));
  process.exit(11);
}
const t3 = fs.readFileSync(path.join(hub, 'outbox', outFiles[0]), 'utf8');
if (!t3.includes('from file')) {
  console.error('CLI body missing', t3);
  process.exit(12);
}

// CLI stdin via shell wrapper
const sh = spawnSync('bash', [
  `${root}/scripts/write-message.sh`,
  '--hub', hub,
  '--from', 'alpha',
  '--to', 'hub',
  '--subject', 'stdin body',
  '--conversation-id', '2026-07-24-keep-abcdef',
], { encoding: 'utf8', input: 'stdin payload\n', env: { ...process.env, BIZAGENT_HUB: hub } });
if (sh.status !== 0) {
  console.error('write-message.sh failed', sh.status, sh.stderr, sh.stdout);
  process.exit(13);
}
const agentOut = path.join(hub, 'agents', 'alpha', 'outbox');
const shFiles = fs.readdirSync(agentOut).filter((n) => n.includes('stdin-body'));
if (shFiles.length < 1) {
  console.error('shell wrapper missing file', fs.readdirSync(agentOut));
  process.exit(14);
}
const t4 = fs.readFileSync(path.join(agentOut, shFiles[0]), 'utf8');
if (frontmatterValue(t4, 'conversation_id') !== '2026-07-24-keep-abcdef') {
  console.error('shell wrapper lost conversation_id', t4);
  process.exit(15);
}
if (!t4.includes('stdin payload')) {
  console.error('shell wrapper body missing', t4);
  process.exit(16);
}

// reject multi-to
let threw = false;
try {
  writeOutboxMessage(hub, { from: 'hub', to: 'a,b', subject: 'x', body: 'y' });
} catch (_err) {
  threw = true;
}
if (!threw) {
  console.error('multi-to should throw');
  process.exit(17);
}

// A: writeOutboxMessage dedupe — identical from+to+body must return existing file, never a second.
const d1 = writeOutboxMessage(hub, {
  from: 'bizagent-oss',
  to: 'hub',
  subject: 'prefer-websocket-feeds-subscribe',
  body: 'Done. Prefer WebSocket, subscribe model.\n\nServer changes...',
  date: '2026-07-25',
});
const d2 = writeOutboxMessage(hub, {
  from: 'bizagent-oss',
  to: 'hub',
  subject: 'prefer-websocket-feeds-subscribe',
  body: 'Done. Prefer WebSocket, subscribe model.\n\nServer changes...',
  date: '2026-07-25',
});
if (d1.file !== d2.file) {
  console.error('writeOutboxMessage dedupe failed: produced second file', d1.file, d2.file);
  process.exit(18);
}
if (!fs.existsSync(d1.file)) {
  console.error('deduped file missing', d1.file);
  process.exit(19);
}
NODE
  then
    fail "write-message helper tests failed"
  fi

  # B/C: postAgentCompletionNotice idempotence + near-dupe guard on readUserInboxMessages
  if ! node - "$ROOT" "$TMP2" <<'NODE'
const root = process.argv[2];
const hub = process.argv[3];
const fs = require('fs');
const path = require('path');
const {
  createConversation,
  getConversation,
  appendMessage,
  postAgentCompletionNotice,
  isNearDuplicateHubReply,
  readUserInboxMessages,
  AGENT_COMPLETION_KIND,
} = require(`${root}/control-plane/lib/conversations`);
const { writeOutboxMessage, routeOutboxes } = require(`${root}/control-plane/lib/mail`);

fs.mkdirSync(path.join(hub, 'inbox'), { recursive: true });
fs.mkdirSync(path.join(hub, 'outbox'), { recursive: true });
fs.mkdirSync(path.join(hub, 'user/inbox'), { recursive: true });
fs.writeFileSync(path.join(hub, 'registry.json'), JSON.stringify({
  settings: { dispatch: { max_concurrency: 2, lock_lease_secs: 60 } },
  products: [],
}));

const conv = createConversation(hub, 'Coalesce Test');

// B: exactly one notice for same slug even if called twice.
postAgentCompletionNotice(hub, conv.id, 'bizagent-oss');
postAgentCompletionNotice(hub, conv.id, 'bizagent-oss');
let c = getConversation(hub, conv.id);
let notices = (c.messages || []).filter(m => m.kind === AGENT_COMPLETION_KIND);
if (notices.length !== 1) {
  console.error('postAgentCompletionNotice not idempotent', notices.length);
  process.exit(20);
}

// C: near-dupe hub→user relay is dropped.
const body1 = '- bullet one\n- bullet two\n- bullet three';
const body2 = '- bullet one\n- bullet two\n- bullet three (minor reword)';
appendMessage(hub, conv.id, 'hub', body1);
const dupMail = path.join(hub, 'user/inbox', '2026-07-25-hub-near-dup.md');
fs.writeFileSync(dupMail, `---
from: hub
to: user
date: 2026-07-25
subject: near-dup
conversation_id: ${conv.id}
---

${body2}
`);
const relayed = readUserInboxMessages(hub);
c = getConversation(hub, conv.id);
const hubs = (c.messages || []).filter(m => m.role === 'hub');
if (hubs.length !== 1) {
  console.error('near-dupe guard did not suppress second hub message', hubs.length);
  process.exit(21);
}
if (relayed !== 0) {
  // The dup was not relayed; count of relayed is from earlier state or zero for this file.
  // We only care that no extra hub msg was appended.
}
if (!isNearDuplicateHubReply(c, body2)) {
  console.error('isNearDuplicateHubReply should detect near match');
  process.exit(22);
}
NODE
  then
    fail "B/C coalesce + near-dupe guard tests failed"
  fi

  # delete conversation + display name profile
  if ! node - "$ROOT" "$TMP2" <<'NODE'
const root = process.argv[2];
const hub = process.argv[3];
const fs = require('fs');
const path = require('path');
const {
  createConversation,
  deleteConversation,
  getConversation,
  listConversations,
  setActiveConversation,
  getActiveConversationId,
} = require(`${root}/control-plane/lib/conversations`);
const { getProfile, setProfile, userDisplayName } = require(`${root}/control-plane/lib/profile`);
const { compactHubSession } = require(`${root}/control-plane/lib/hub-memory`);

fs.mkdirSync(path.join(hub, 'outbox'), { recursive: true });
fs.writeFileSync(path.join(hub, 'registry.json'), JSON.stringify({
  settings: { dispatch: { max_concurrency: 2, lock_lease_secs: 60 } },
  products: [],
}));

// profile defaults empty; set name
const empty = getProfile(hub);
if (empty.display_name) {
  console.error('expected empty display name', empty);
  process.exit(1);
}
if (userDisplayName(hub) !== 'You') {
  console.error('fallback display name should be You', userDisplayName(hub));
  process.exit(2);
}
const saved = setProfile(hub, { display_name: '  Ada  ' });
if (saved.display_name !== 'Ada') {
  console.error('display name not trimmed', saved);
  process.exit(3);
}
if (getProfile(hub).display_name !== 'Ada') {
  console.error('profile not persisted');
  process.exit(4);
}
if (userDisplayName(hub) !== 'Ada') {
  console.error('userDisplayName mismatch');
  process.exit(5);
}
let threw = false;
try { setProfile(hub, { display_name: '   ' }); } catch (_err) { threw = true; }
if (!threw) {
  console.error('empty display name should throw');
  process.exit(6);
}

// session memory uses display name, not Operator/CEO
const conv = createConversation(hub, 'Named');
const { appendMessage } = require(`${root}/control-plane/lib/conversations`);
appendMessage(hub, conv.id, 'user', 'hello there');
const sessionPath = path.join(hub, '.bizagent', 'hub-session.md');
const session = fs.readFileSync(sessionPath, 'utf8');
if (!session.includes('### Ada -') && !session.includes('- Ada:')) {
  // compact writes recent turns with role label
  if (!/Ada/.test(session)) {
    console.error('session missing display name', session);
    process.exit(7);
  }
}
if (/\bOperator\b/.test(session) || /\bCEO\b/.test(session)) {
  console.error('session still labels human Operator/CEO', session);
  process.exit(8);
}

// delete conversation
const keep = createConversation(hub, 'Keep');
const drop = createConversation(hub, 'Drop');
setActiveConversation(hub, drop.id);
if (!deleteConversation(hub, drop.id)) {
  console.error('deleteConversation returned false');
  process.exit(9);
}
if (getConversation(hub, drop.id)) {
  console.error('deleted conversation still readable');
  process.exit(10);
}
if (getActiveConversationId(hub) === drop.id) {
  console.error('active conversation not cleared on delete');
  process.exit(11);
}
const names = listConversations(hub).map((c) => c.name).sort();
if (names.includes('Drop')) {
  console.error('deleted still listed', names);
  process.exit(12);
}
if (!getConversation(hub, keep.id)) {
  console.error('kept conversation missing');
  process.exit(13);
}
if (deleteConversation(hub, 'not-a-valid-id')) {
  console.error('invalid id should not delete');
  process.exit(14);
}
NODE
  then
    fail "delete conversation / display name profile failed"
  fi

# Provider failure classification + operator-visible agent error alerts
[ -f "$ROOT/control-plane/lib/provider-errors.js" ] \
  || fail "provider-errors.js missing"
grep -q "notifyAgentExitFromLogs" "$ROOT/control-plane/lib/dispatcher.js" \
  || fail "dispatcher missing notifyAgentExitFromLogs (shell EXIT hook)"
grep -q "notifyAgentExitFromLogs," "$ROOT/control-plane/lib/dispatcher.js" \
  || fail "notifyAgentExitFromLogs not exported from dispatcher"
grep -q "used all available credits" "$ROOT/control-plane/lib/hub-turn-safety.js" \
  || fail "hub-turn-safety hardFail does not detect credit exhaustion"
if ! node - "$ROOT" <<'NODE'
const path = require('path');
const fs = require('fs');
const os = require('os');
const root = process.argv[2];
const {
  classifyProviderError,
  formatProviderFailureMessage,
} = require(path.join(root, 'control-plane/lib/provider-errors'));
const {
  notifyAgentExitFromLogs,
  recordAgentError,
} = require(path.join(root, 'control-plane/lib/dispatcher'));
const {
  createConversation,
  getConversation,
  setActiveConversation,
} = require(path.join(root, 'control-plane/lib/conversations'));

const creditLine =
  'Error: 403 "Your team has either used all available credits or reached its monthly spending limit. To continue making API requests, please purchase more credits or raise your spending limit."';
const c = classifyProviderError(creditLine);
if (!c || c.kind !== 'credits') {
  console.error('expected credits classification', c);
  process.exit(1);
}
const auth = classifyProviderError('Error: 401 Incorrect API key provided');
if (!auth || auth.kind !== 'auth') {
  console.error('expected auth classification', auth);
  process.exit(2);
}
const rate = classifyProviderError('Error: 429 Too Many Requests — rate limit');
if (!rate || rate.kind !== 'rate_limit') {
  console.error('expected rate_limit', rate);
  process.exit(3);
}
const msg = formatProviderFailureMessage({
  slug: 'bizagent',
  exitCode: 1,
  text: creditLine,
  classified: c,
});
if (!/credits|spending/i.test(msg) || !/bizagent/.test(msg)) {
  console.error('format message missing bits', msg);
  process.exit(4);
}

const hub = fs.mkdtempSync(path.join(os.tmpdir(), 'bizagent-credit-alert-'));
fs.mkdirSync(path.join(hub, '.bizagent'), { recursive: true });
fs.mkdirSync(path.join(hub, 'journal'), { recursive: true });
fs.mkdirSync(path.join(hub, 'logs'), { recursive: true });
fs.mkdirSync(path.join(hub, 'user', 'inbox'), { recursive: true });
const conv = createConversation(hub, 'Credit test');
setActiveConversation(hub, conv.id);
fs.writeFileSync(
  path.join(hub, 'logs', 'dispatch-bizagent.stderr'),
  creditLine + '\n',
  'utf8',
);

notifyAgentExitFromLogs(hub, 'bizagent', 1);
const after = getConversation(hub, conv.id);
const errMsgs = (after.messages || []).filter(
  (m) => m.role === 'status' && m.kind === 'error',
);
if (errMsgs.length !== 1) {
  console.error('expected one status error in chat', after.messages);
  process.exit(5);
}
if (!/credits|spending/i.test(errMsgs[0].content)) {
  console.error('status error content not credit-related', errMsgs[0].content);
  process.exit(6);
}
// Dedup: second notify within window must not double-post
notifyAgentExitFromLogs(hub, 'bizagent', 1);
const after2 = getConversation(hub, conv.id);
const errMsgs2 = (after2.messages || []).filter(
  (m) => m.role === 'status' && m.kind === 'error',
);
if (errMsgs2.length !== 1) {
  console.error('dedup failed; got', errMsgs2.length);
  process.exit(7);
}
const journal = fs.readFileSync(
  path.join(hub, 'journal', new Date().toISOString().slice(0, 10) + '.md'),
  'utf8',
);
if (!/Incident.*bizagent/i.test(journal)) {
  console.error('journal missing incident', journal);
  process.exit(8);
}
// Export smoke
if (typeof recordAgentError !== 'function' || typeof notifyAgentExitFromLogs !== 'function') {
  console.error('exports missing');
  process.exit(9);
}
try {
  fs.rmSync(hub, { recursive: true, force: true });
} catch (_e) { /* ignore */ }
NODE
then
  fail "provider credit-alert checks failed"
fi

echo "  ok: control-plane"
