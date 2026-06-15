#!/usr/bin/env bash
# install-dispatch.sh
#
# Wire up the event-driven dispatcher to run on a short interval. This is a
# DELIBERATE, MANUAL step — bizagent never enables it for you. Run it once, by
# hand, after you've reviewed scripts/bizagent-dispatch.sh.
#
# Usage:
#   scripts/install-dispatch.sh cron      [interval_minutes]   # default 2
#   scripts/install-dispatch.sh systemd   [interval_minutes]   # user timer, default 2
#   scripts/install-dispatch.sh print     [interval_minutes]   # just show the line(s)
#
# Permission mode (SAFE-BY-DEFAULT):
#   By default this installer writes an EMPTY CLI_EXTRA_ARGS into .cli, so the
#   dispatcher launches agents with NO permission flag. To run truly unattended,
#   the operator must deliberately opt in to autonomous (full-permission) mode:
#     --allow-autonomous  (alias: --skip-permissions)
#         write CLI_EXTRA_ARGS=--dangerously-skip-permissions into .cli so cron-
#         driven agents act without prompting. UNSANDBOXED + FULL PERMISSIONS.
#   With no flag on an interactive terminal you are asked (default: NO). On a
#   non-interactive run (no tty) the safe default (empty) is used unless the flag
#   is given. Recommended hardening if you do opt in: run the CLI inside a sandbox
#   (firejail / bwrap / docker) or pass a tool allowlist (e.g. --allowedTools) via
#   CLI_EXTRA_ARGS instead of blanket skip-permissions.
#
# Bootstrapping note: the very first run must be a manual kick, because nothing
# is dispatching yet:
#   bash scripts/bizagent-dispatch.sh
# After the cron/timer is installed, every subsequent tick is automatic.
#
# Absolute CLI path (important): the dispatcher launches the agent CLI under
# cron's (or a systemd timer's) MINIMAL environment, where the CLI's install
# dir is typically NOT on PATH (e.g. a per-user binary at $HOME/.local/bin).
# A bare command name like "claude" then fails with "command not found" and mail
# silently never drains. So at install time we resolve the CLI to an ABSOLUTE
# path and write it into the hub's `.cli` file (key CLI=), which the dispatcher
# sources. We also export a sane PATH in the generated cron line / timer unit as
# a belt-and-suspenders second line of defense. Override at runtime with the
# BIZAGENT_CLI env var (the escape hatch).
set -u

HUB="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Parse args: positional MODE + INTERVAL, plus an optional opt-in flag that may
# appear anywhere. ALLOW_AUTONOMOUS: 1=opt in (flag given), 0=not given (ask/safe).
ALLOW_AUTONOMOUS=0
POSITIONAL=()
for arg in "$@"; do
  case "$arg" in
    --allow-autonomous|--skip-permissions) ALLOW_AUTONOMOUS=1 ;;
    --*) echo "unknown flag: $arg" >&2; exit 2 ;;
    *) POSITIONAL+=("$arg") ;;
  esac
done
MODE="${POSITIONAL[0]:-print}"
INTERVAL="${POSITIONAL[1]:-2}"

# Env escape hatch (e.g. for non-interactive automation that has decided to opt
# in without passing the flag): BIZAGENT_ALLOW_AUTONOMOUS=1.
case "${BIZAGENT_ALLOW_AUTONOMOUS:-}" in 1|yes|YES|true|TRUE) ALLOW_AUTONOMOUS=1 ;; esac

case "$INTERVAL" in (*[!0-9]*|'') echo "interval must be a whole number of minutes" >&2; exit 2;; esac

# The flag we write into .cli when (and only when) the operator opts in.
SKIP_PERMS_FLAG="--dangerously-skip-permissions"

DISPATCH="$HUB/scripts/bizagent-dispatch.sh"

# A minimal-but-sane PATH for the generated cron line / systemd unit. Cron in
# particular starts with a near-empty PATH; include the common per-user bin dir
# so any helper the CLI shells out to is still findable. The CLI itself is
# launched by absolute path regardless (see resolve_and_write_cli), so this is
# defense in depth, not the primary fix.
SAFE_PATH="$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin"

CRON_LINE="*/$INTERVAL * * * * PATH=$SAFE_PATH; cd $HUB && bash scripts/bizagent-dispatch.sh >> logs/dispatch.log 2>&1"

# resolve_permission_mode : decide what (if anything) goes into CLI_EXTRA_ARGS.
# Echoes the chosen extra-args string (empty = safe default). Safe-by-default:
#   - If --allow-autonomous/--skip-permissions (or BIZAGENT_ALLOW_AUTONOMOUS) was
#     given, return the skip-permissions flag.
#   - Else if a value was ALREADY recorded in .cli (an earlier explicit choice),
#     preserve it (don't silently downgrade an operator's prior decision).
#   - Else if interactive (a tty), warn loudly and ask, defaulting to NO.
#   - Else (non-interactive, no flag, nothing recorded): empty (safe).
# Diagnostics go to stderr so stdout stays just the chosen string.
resolve_permission_mode() {
  local recorded_extra="$1"

  if [ "$ALLOW_AUTONOMOUS" = "1" ]; then
    echo "$SKIP_PERMS_FLAG"
    return 0
  fi

  # Preserve an explicit prior choice (e.g. a previous opt-in install).
  if [ -n "$recorded_extra" ]; then
    echo "$recorded_extra"
    return 0
  fi

  if [ -t 0 ] && [ -t 1 ]; then
    {
      echo
      echo "⚠  AUTONOMOUS DISPATCH — permission mode"
      echo "   The dispatcher launches agents from cron/systemd with NO human at"
      echo "   the keyboard. Granting '$SKIP_PERMS_FLAG' lets those"
      echo "   agents run UNSANDBOXED with FULL PERMISSIONS (edit files, run"
      echo "   commands, reach the network) with no prompt. This is powerful and"
      echo "   risky on a shared or internet-connected machine."
      echo
      echo "   Safer options if you proceed: run the CLI inside a sandbox"
      echo "   (firejail / bwrap / docker), or set CLI_EXTRA_ARGS to a tool"
      echo "   allowlist (e.g. --allowedTools ...) instead of blanket skip."
      echo
      printf "   Enable autonomous full-permission dispatch now? [y/N] "
    } >&2
    local ans=""
    read -r ans
    case "$ans" in
      y|Y|yes|YES) echo "$SKIP_PERMS_FLAG"; return 0 ;;
    esac
  fi

  # Safe default: no permission flag.
  echo ""
}

# resolve_and_write_cli : figure out an ABSOLUTE, executable path to the agent
# CLI and persist it to "$HUB/.cli" as CLI=<abspath>. Resolution order:
#   1. BIZAGENT_CLI env override (the escape hatch), if set
#   2. CLI_CMD already recorded in .cli by the main installer (install.sh)
#   3. `command -v claude`
#   4. $HOME/.local/bin/claude (the common per-user install location)
# Fails LOUDLY (non-zero exit) if nothing executable is found — better a clear
# install error now than mail silently never draining under cron later.
resolve_and_write_cli() {
  local clifile="$HUB/.cli"
  local recorded_cmd="" recorded_flag="" recorded_extra=""

  if [ -f "$clifile" ]; then
    # Read any values the main installer (or a previous run) left behind. Both
    # the CLI_CMD convention (install.sh) and the CLI convention (this file) are
    # honored so we don't lose an operator's earlier choice.
    # shellcheck disable=SC1090
    . "$clifile" 2>/dev/null || true
    recorded_cmd="${CLI:-${CLI_CMD:-}}"
    recorded_flag="${CLI_PROMPT_FLAG:-}"
    recorded_extra="${CLI_EXTRA_ARGS:-}"
  fi

  local candidate="${BIZAGENT_CLI:-${recorded_cmd:-claude}}"

  # Resolve to an absolute path.
  local resolved=""
  case "$candidate" in
    /*) resolved="$candidate" ;;                       # already absolute
    */*) resolved="$(cd "$(dirname "$candidate")" 2>/dev/null && pwd)/$(basename "$candidate")" ;;
    *)  resolved="$(command -v "$candidate" 2>/dev/null || true)" ;;
  esac

  # Last-resort fallback to the common per-user install location.
  if [ -z "$resolved" ] || [ ! -x "$resolved" ]; then
    if [ -x "$HOME/.local/bin/$candidate" ]; then
      resolved="$HOME/.local/bin/$candidate"
    fi
  fi

  if [ -z "$resolved" ] || [ ! -x "$resolved" ]; then
    echo "✗ install-dispatch: could not resolve an executable CLI." >&2
    echo "  Tried: '${candidate}' (via command -v and \$HOME/.local/bin)." >&2
    echo "  The dispatcher runs under cron's minimal PATH, so the CLI must be an" >&2
    echo "  absolute, executable path. Fix one of:" >&2
    echo "    - install the CLI so 'command -v ${candidate}' resolves, or" >&2
    echo "    - re-run with BIZAGENT_CLI=/abs/path/to/cli scripts/install-dispatch.sh ..." >&2
    exit 3
  fi

  # Persist. Default the prompt flag if the file didn't carry one, matching the
  # dispatcher's own default so .cli is self-contained.
  : "${recorded_flag:=-p}"

  # Permission mode is SAFE-BY-DEFAULT: only write the dangerous flag if the
  # operator explicitly opted in (flag/env/prompt) or had already recorded it.
  local extra
  extra="$(resolve_permission_mode "$recorded_extra")"

  cat > "$clifile" <<EOF
# bizagent CLI config — CLI resolved to an absolute path by install-dispatch.sh.
# The dispatcher sources this under cron's minimal env, so CLI MUST be absolute.
# Override at runtime with BIZAGENT_CLI / BIZAGENT_CLI_PROMPT_FLAG / BIZAGENT_CLI_EXTRA_ARGS.
# CLI_EXTRA_ARGS is the permission mode; empty = safe (no auto-permission flag).
CLI=$resolved
CLI_CMD=$resolved
CLI_PROMPT_FLAG=$recorded_flag
CLI_EXTRA_ARGS=$extra
EOF
  echo "Resolved CLI -> $resolved (written to .cli)"
  if [ -n "$extra" ]; then
    echo "Permission mode: AUTONOMOUS — CLI_EXTRA_ARGS=$extra (agents act unprompted)."
  else
    echo "Permission mode: SAFE (CLI_EXTRA_ARGS empty). Unattended dispatch will NOT"
    echo "  act until you choose a permission mode: re-run with --allow-autonomous,"
    echo "  or edit .cli's CLI_EXTRA_ARGS (e.g. a sandbox wrapper or --allowedTools)."
  fi
}

print_cron() {
  echo "# bizagent dispatcher — every $INTERVAL min"
  echo "$CRON_LINE"
}

install_cron() {
  resolve_and_write_cli
  echo "About to add this line to your crontab:"
  echo
  print_cron
  echo
  printf "Proceed? [y/N] "
  read -r ans
  case "$ans" in
    y|Y|yes|YES) ;;
    *) echo "Aborted. Nothing changed."; exit 0;;
  esac
  local existing
  existing="$(crontab -l 2>/dev/null || true)"
  if printf '%s\n' "$existing" | grep -Fq "bizagent-dispatch.sh"; then
    echo "A bizagent-dispatch cron line already exists; leaving it untouched."
    echo "Edit it with: crontab -e"
    exit 0
  fi
  { printf '%s\n' "$existing"; print_cron; } | crontab -
  echo "Installed. Verify with: crontab -l"
  echo "Remember the first manual kick if you haven't run one:"
  echo "  bash scripts/bizagent-dispatch.sh"
}

install_systemd() {
  resolve_and_write_cli
  local unitdir="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
  mkdir -p "$unitdir"
  cat > "$unitdir/bizagent-dispatch.service" <<EOF
[Unit]
Description=bizagent event-driven agent dispatcher (one tick)

[Service]
Type=oneshot
WorkingDirectory=$HUB
# A systemd --user service also starts with a minimal PATH; include the common
# per-user bin dir as defense in depth (the CLI itself is launched by absolute
# path from .cli regardless).
Environment=PATH=$SAFE_PATH
ExecStart=/usr/bin/env bash $DISPATCH
EOF
  cat > "$unitdir/bizagent-dispatch.timer" <<EOF
[Unit]
Description=Run bizagent dispatcher every $INTERVAL min

[Timer]
OnBootSec=1min
OnUnitActiveSec=${INTERVAL}min
AccuracySec=15s
Persistent=true

[Install]
WantedBy=timers.target
EOF
  echo "Wrote:"
  echo "  $unitdir/bizagent-dispatch.service"
  echo "  $unitdir/bizagent-dispatch.timer"
  echo
  echo "Enable it yourself (deliberate step):"
  echo "  systemctl --user daemon-reload"
  echo "  systemctl --user enable --now bizagent-dispatch.timer"
  echo "  loginctl enable-linger \$USER   # keep it running when logged out"
  echo
  echo "First manual kick (bootstrapping):"
  echo "  bash scripts/bizagent-dispatch.sh"
}

case "$MODE" in
  cron)    install_cron ;;
  systemd) install_systemd ;;
  print)   print_cron ;;
  *) echo "usage: $0 {cron|systemd|print} [interval_minutes] [--allow-autonomous]" >&2; exit 2 ;;
esac
