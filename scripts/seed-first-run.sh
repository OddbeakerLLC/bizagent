#!/usr/bin/env bash
# seed-first-run.sh — queue first-run console conversation + hub inbox seed.
#
# Used by root install.sh handoff and install/install.sh so both paths agree.
# Idempotent: never spawns a second parallel setup chat if a seed already
# exists (inbox, archive, or Welcome conversation).
#
# Usage: scripts/seed-first-run.sh [hub-path]
# Exit 0 always for install soft-fail (prints status); use --strict to exit 1
# when hub is not ready (still writes blocked seed once).
set -uo pipefail

STRICT=0
HUB=""
for arg in "$@"; do
  case "$arg" in
    --strict) STRICT=1 ;;
    -*) echo "unknown flag: $arg" >&2; exit 2 ;;
    *) HUB="$arg" ;;
  esac
done

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Framework tree that ships control-plane/lib (same as HUB on real install).
FRAMEWORK="$(cd "$SCRIPT_DIR/.." && pwd)"
HUB="$(cd "${HUB:-$FRAMEWORK}" && pwd)"
TODAY="$(date -u +%Y-%m-%d)"
INBOX="$HUB/inbox"
ARCHIVE="$HUB/inbox/archive"
MARKER="$HUB/.bizagent/first-run-seeded"
CP_LIB="$FRAMEWORK/control-plane/lib"
# Prefer hub's control-plane when it has conversations.js (normal install).
if [[ -f "$HUB/control-plane/lib/conversations.js" ]]; then
  CP_LIB="$HUB/control-plane/lib"
fi

ok() { printf "  ✓ %s\n" "$1"; }
note() { printf "  %s\n" "$1"; }
warn() { printf "  ! %s\n" "$1"; }

mkdir -p "$INBOX" "$ARCHIVE" "$HUB/.bizagent"

# --- Idempotency: any prior seed or Welcome setup chat → skip ---
seed_already_present() {
  shopt -s nullglob
  local f
  for f in "$INBOX"/*-install-first-run.md "$ARCHIVE"/*-install-first-run.md; do
    [[ -f "$f" ]] && return 0
  done
  shopt -u nullglob
  [[ -f "$MARKER" ]] && return 0
  # Existing Welcome / First-run conversation with messages
  if command -v node >/dev/null 2>&1 && [[ -d "$HUB/.bizagent/conversations" ]]; then
    if node - "$HUB" <<'NODE' 2>/dev/null
const fs = require('fs');
const path = require('path');
const hub = process.argv[2];
const dir = path.join(hub, '.bizagent', 'conversations');
try {
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith('.json')) continue;
    const conv = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
    const n = String(conv.name || '').toLowerCase();
    const msgs = Array.isArray(conv.messages) ? conv.messages : [];
    if ((n === 'welcome' || n.includes('first-run') || n.includes('first run') || n.includes('setup'))
        && msgs.length > 0) {
      process.exit(0);
    }
  }
} catch (_e) { /* ignore */ }
process.exit(1);
NODE
    then
      return 0
    fi
  fi
  return 1
}

if seed_already_present; then
  ok "first-run seed already present — skipping (idempotent)"
  exit 0
fi

# --- Readiness ---
READY=0
if [[ -x "$HUB/scripts/check-hub-ready.sh" ]]; then
  if bash "$HUB/scripts/check-hub-ready.sh" "$HUB"; then
    READY=1
  else
    warn "Hub is not ready to run turns (see check-hub-ready output above)"
  fi
else
  note "check-hub-ready.sh missing — treating as ready"
  READY=1
fi

# --- Registry mode: minimal (fresh install seed) vs already configured ---
MODE="minimal"
if [[ -f "$HUB/registry.json" ]] && command -v node >/dev/null 2>&1; then
  MODE="$(node - "$HUB/registry.json" <<'NODE' 2>/dev/null || echo minimal
const fs = require('fs');
const r = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const org = String(r.org || '').trim();
const products = Array.isArray(r.products) ? r.products : [];
const hasProducts = products.some((p) => p && (p.slug || p.name));
// Installer writes empty org + products=[] — that is MINIMAL, not BUILT.
if (org && hasProducts) {
  process.stdout.write('configured');
} else if (hasProducts) {
  process.stdout.write('configured');
} else {
  process.stdout.write('minimal');
}
NODE
)"
else
  MODE="minimal"
fi

# Detect installer-already-set facts (skip re-ask in interview)
HAS_AUTH=0
[[ -f "$HUB/.bizagent/auth.json" ]] && HAS_AUTH=1
PROVIDER=""
MODEL=""
if [[ -f "$HUB/registry.json" ]] && command -v node >/dev/null 2>&1; then
  PROVIDER="$(node -e 'const r=require(process.argv[1]);const ha=(r.settings&&r.settings.hub_agent)||{};process.stdout.write(String(ha.provider||ha.cliName||"").trim())' "$HUB/registry.json" 2>/dev/null || true)"
  MODEL="$(node -e 'const r=require(process.argv[1]);const ha=(r.settings&&r.settings.hub_agent)||{};process.stdout.write(String(ha.model||"").trim())' "$HUB/registry.json" 2>/dev/null || true)"
fi
HAS_PROVIDER=0
[[ -n "$PROVIDER" && -n "$MODEL" ]] && HAS_PROVIDER=1

# --- Create Welcome conversation + short first bubble (TTS-friendly) ---
CONV_ID=""
WELCOME_BUBBLE=""
if [[ "$MODE" == "configured" ]]; then
  WELCOME_BUBBLE="Welcome back. Your hub is already set up — what do you want to work on?"
else
  WELCOME_BUBBLE="Welcome to BizAgent. I'm your Products Team Lead. What should we call your organization?"
fi

if command -v node >/dev/null 2>&1 && [[ -f "$CP_LIB/conversations.js" ]]; then
  CONV_ID="$(node - "$HUB" "$WELCOME_BUBBLE" "$CP_LIB" <<'NODE' 2>/dev/null || true
const path = require('path');
const hub = process.argv[2];
const bubble = process.argv[3];
const cpLib = process.argv[4];
const {
  createConversation,
  appendMessage,
  setActiveConversation,
  listConversations,
  getConversation,
} = require(path.join(cpLib, 'conversations'));

// Prefer existing empty Welcome if any (race-safe-ish)
const existing = (listConversations(hub) || []).find((c) => {
  const n = String(c.name || '').toLowerCase();
  return n === 'welcome' || n.includes('first-run') || n.includes('first run');
});
let conv;
if (existing) {
  conv = getConversation(hub, existing.id) || createConversation(hub, 'Welcome');
} else {
  conv = createConversation(hub, 'Welcome');
}
const msgs = Array.isArray(conv.messages) ? conv.messages : [];
const hasHub = msgs.some((m) => m && m.role === 'hub' && String(m.content || '').trim());
if (!hasHub) {
  appendMessage(hub, conv.id, 'hub', bubble);
}
try { setActiveConversation(hub, conv.id); } catch (_e) { /* ignore */ }
process.stdout.write(conv.id);
NODE
)"
fi

SEED_FILE="$INBOX/${TODAY}-install-first-run.md"

write_seed() {
  local subject="$1"
  local body="$2"
  {
    printf -- '---\n'
    printf -- 'from: installer\n'
    printf -- 'to: hub\n'
    printf -- 'date: %s\n' "$TODAY"
    printf -- 'subject: %s\n' "$subject"
    if [[ -n "$CONV_ID" ]]; then
      printf -- 'conversation_id: %s\n' "$CONV_ID"
    fi
    printf -- '---\n\n'
    printf -- '%s\n' "$body"
  } > "$SEED_FILE"
  # Marker so re-install after archive still stays idempotent
  {
    printf -- 'seeded_at=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    printf -- 'mode=%s\n' "$MODE"
    printf -- 'conversation_id=%s\n' "${CONV_ID:-}"
  } > "$MARKER"
}

if [[ "$READY" -eq 1 ]]; then
  if [[ "$MODE" == "configured" ]]; then
    BODY=$(cat <<EOF
A bizagent install/reinstall finished on an **already-configured** hub (org and/or products present in registry.json).

## Your job this turn
1. Open/continue the console conversation (conversation_id is stamped above when present).
2. Send a short PTL welcome if the chat does not already show one: welcome back + ask what they want to work on.
3. **Never** rebuild a working hub. **Never** re-enter full AGENT.md §1 interview on a BUILT/configured registry.
4. Soft ops only unless the operator explicitly asks for hub machinery changes.

## Already done by installer (do not re-ask)
- LLM provider/model may already be set (provider=${PROVIDER:-unknown} model=${MODEL:-unknown}).
- Control-plane login: $([[ "$HAS_AUTH" -eq 1 ]] && echo "already initialized" || echo "may still need Create login in UI").
- Public framework remote detach was attempted at install.

Archive this seed after the welcome is in the conversation.
EOF
)
    write_seed "first-run setup" "$BODY"
    ok "first-run seed queued (configured hub — non-destructive welcome only)"
  else
    BODY=$(cat <<EOF
A new bizagent installation just completed. Registry is **minimal** (empty org and no products) — treat as UNBUILT first-run even though registry.json exists as an install seed.

## Your job
1. Continue the **Welcome** console conversation (conversation_id stamped above when present). A short first hub bubble may already be visible — do not duplicate it.
2. Run the approved first-run interview **one question at a time** (AGENT.md §1), then §2 generate. Support **zero repos**: write minimal registry and add products later.
3. Hub-and-spoke stays; default **no** peer messaging unless the operator opts in.

## Interview beats (ask one at a time; skip any already set)
1. Org name (first bubble may already have asked this).
2. Project repo location (parent folder or paths) — or "none yet" for zero-repo.
3. Propose product groupings from scan → confirm names/slugs (skip if zero repos).
4. Agent names per product (skip if zero repos).
5. Peer messaging? (default hub-and-spoke / no).
6. Nightly time (default 23:00).
7. Knowledge Stack on/off + refresh default (enabled true, sunday 01:00).
8. Auto-archive days (default 30).
9. Agent autonomy (maintenance-only default).
10. Private hub remote or local-only.
11. LLM provider + model — **skip if already set** (provider=${PROVIDER:-unset} model=${MODEL:-unset}; key in .bizagent/env).
12. Control-plane login — **skip if auth exists** ($([[ "$HAS_AUTH" -eq 1 ]] && echo "auth.json present — skip" || echo "not set — collect username/password and run auth-init")).
13. Build summary + next steps (cron / CP service / start directing work).

## Constraints
- Prerequisites checked: bizagent-agent runtime, hub provider/model, API key in .bizagent/env (when ready).
- Keep operator-visible replies short (TTS-friendly).
- Never re-seed or start a second parallel setup chat.

Archive this seed after you have welcomed and asked the current primary question (or finished if operator already answered in-thread).
EOF
)
    write_seed "first-run setup" "$BODY"
    ok "first-run seed queued (minimal registry — Welcome → primary-ask flow)"
  fi
  if [[ -n "$CONV_ID" ]]; then
    note "conversation_id=$CONV_ID (Welcome chat + first bubble ready for UI/TTS)"
  else
    warn "could not create Welcome conversation via node — inbox seed only"
  fi
  exit 0
fi

# Not ready — blocked seed (still idempotent via marker)
BODY=$(cat <<EOF
Installation finished but the hub was **NOT** ready to launch (missing provider, model, API key, or agent-runtime deps). Do not run product onboarding until the operator fixes that.

Operator: run \`bash scripts/check-hub-ready.sh\`, fix any ✗ items, restart control plane, then send a console message: "Run first-run setup / interview me and onboard my products."

Registry mode detected: $MODE. When unblocked, follow AGENT.md §1 only if registry is still minimal; if already configured, welcome only — never rebuild.
EOF
)
write_seed "first-run setup blocked" "$BODY"
warn "first-run seed written as BLOCKED (will not usefully execute until ready)"
if [[ "$STRICT" -eq 1 ]]; then
  exit 1
fi
exit 0
