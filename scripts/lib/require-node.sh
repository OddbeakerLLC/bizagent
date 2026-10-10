#!/usr/bin/env bash
# require-node.sh — fail early if Node is missing or below the BizAgent minimum.
#
# Usage (from a hub root or any script that knows HUB/ROOT):
#   # shellcheck source=require-node.sh
#   source "$ROOT/scripts/lib/require-node.sh"
#   bizagent_require_node
#
# Or execute directly (exits non-zero on failure):
#   bash scripts/lib/require-node.sh
#
# Why 18: agent-runtime package.json engines.node is ">=18.0.0" (Active LTS floor).
# Distro Node on older Ubuntu/WSL is often 12/16 and can pass "node is present"
# then break at runtime — especially WSL on older Windows 10.
#
# Env:
#   BIZAGENT_MIN_NODE_MAJOR  override minimum major version (default 18)

# shellcheck disable=SC2034
BIZAGENT_MIN_NODE_MAJOR="${BIZAGENT_MIN_NODE_MAJOR:-18}"

bizagent_node_version_line() {
  # Prints e.g. v18.20.4 or empty if node missing/unusable.
  if ! command -v node >/dev/null 2>&1; then
    return 1
  fi
  node -v 2>/dev/null || node --version 2>/dev/null || true
}

bizagent_node_major() {
  # Prints major int from vX.Y.Z; empty on parse failure.
  local ver major
  ver="$(bizagent_node_version_line)" || return 1
  ver="${ver#v}"
  major="${ver%%.*}"
  [[ "$major" =~ ^[0-9]+$ ]] || return 1
  printf '%s\n' "$major"
}

bizagent_require_node_message() {
  local detected="$1"
  local min_major="$2"
  cat <<EOF
Node.js ${detected} is too old (need v${min_major}+).

Detected: ${detected}
Required: v${min_major}.0.0 or newer

This machine/setup may not run BizAgent until Node is upgraded.
Older distro packages (common on WSL / Ubuntu 20.04) often ship Node 12 or 16,
which can look "installed" then fail when the control plane or agent-runtime starts.

Fix (WSL / Ubuntu / Debian) — pick one:

  # NodeSource current LTS (recommended on WSL)
  curl -fsSL https://deb.nodesource.com/setup_lts.x | sudo -E bash -
  sudo apt-get install -y nodejs

  # or nvm (user-local, no sudo)
  curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
  # restart shell, then:
  nvm install --lts
  nvm use --lts

Then confirm:  node -v   # should print v${min_major}.x or newer
and re-run the installer / start command.
EOF
}

bizagent_require_node() {
  local min_major detected major
  min_major="${BIZAGENT_MIN_NODE_MAJOR:-18}"

  if ! command -v node >/dev/null 2>&1; then
    printf '%s\n' "Node.js not found on PATH (need v${min_major}+)." >&2
    printf '%s\n' "Install Node ${min_major} LTS or newer, then retry." >&2
    printf '%s\n' "WSL/Ubuntu: curl -fsSL https://deb.nodesource.com/setup_lts.x | sudo -E bash - && sudo apt-get install -y nodejs" >&2
    printf '%s\n' "Or nvm: https://github.com/nvm-sh/nvm#installing-and-updating then: nvm install --lts" >&2
    return 1
  fi

  detected="$(bizagent_node_version_line)"
  detected="${detected:-unknown}"
  if ! major="$(bizagent_node_major)"; then
    printf '%s\n' "Could not parse Node version (${detected}); need v${min_major}+." >&2
    bizagent_require_node_message "$detected" "$min_major" >&2
    return 1
  fi

  if [[ "$major" -lt "$min_major" ]]; then
    bizagent_require_node_message "$detected" "$min_major" >&2
    return 1
  fi

  return 0
}

# Direct execution
if [[ "${BASH_SOURCE[0]:-}" == "$0" ]]; then
  bizagent_require_node
  exit $?
fi
