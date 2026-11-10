#!/usr/bin/env bash
# test-installer-hygiene.sh — static gate for installer failure hygiene.
#
# CR audit (2026-11-09) found the installers reporting success without
# probing, warning instead of dying on required steps, and discarding stderr
# on final attempts. This test locks in the fixes:
#   1. no `2>/dev/null` on the final attempt of a required action
#   2. warns about required components must be followed by die/non-zero
#      (or sit on an explicit soft-fail allowlist)
#   3. "ok … started/installed/finished" claims must be preceded by a real
#      probe (kill -0, /dev/tcp, /health, command -v, …)
#   4. provider catalog copies (installer dict, registry-seed heredoc,
#      cli.json.example, control-plane PROVIDER_CATALOG) must be identical
set -u
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
fail() { echo "  FAIL: $1"; exit 1; }

INSTALL="$ROOT/install.sh"
INSTALL_CP="$ROOT/install/install.sh"
TTS="$ROOT/scripts/install-oddbeaker-tts.sh"
CP="$ROOT/scripts/control-plane.sh"
READY="$ROOT/scripts/check-hub-ready.sh"

for f in "$INSTALL" "$INSTALL_CP" "$TTS" "$CP" "$READY"; do
  [[ -f "$f" ]] || fail "missing file: $f"
  bash -n "$f" || fail "bash -n failed: $f"
done

# --- 1. no 2>/dev/null on the final attempt of a required action -------------
# Required actions whose stderr must surface (with the real cause), never be
# discarded. Best-effort probes/cleanup are fine and not matched here.
REQUIRED_ACTION='git clone|npm install|pip install|apt-get install|apt install|dnf install|pacman -S|zypper install|brew install|pkg_install|\$INSTALL [a-z]+ |\$INSTALL cronie'
for f in "$INSTALL" "$INSTALL_CP" "$TTS" "$CP"; do
  while IFS= read -r line; do
    [[ -n "$line" ]] || continue
    fail "$f: required action discards stderr: $line"
  done < <(grep -nE "$REQUIRED_ACTION" "$f" | grep '2>/dev/null')
done

# Targeted: the CR'd instances stay fixed.
grep -q 'clone_err="$(git clone --quiet -- "$BIZAGENT_SOURCE" "$INSTALL_DIR" 2>&1)"' "$INSTALL" \
  || fail "install.sh clone does not capture git stderr"
grep -q 'git said: ' "$INSTALL" \
  || fail "install.sh clone die does not append the git error"
grep -q 'clone_err="$(git clone --quiet --branch "$TTS_REF" -- "$src" "$TTS_DIR" 2>&1)"' "$TTS" \
  || fail "install-oddbeaker-tts.sh first clone attempt still discards stderr"
! grep -nE 'git clone .*2>/dev/null' "$TTS" \
  || fail "install-oddbeaker-tts.sh still has a stderr-discarding git clone"

# --- 2. required steps die, they do not warn-and-continue --------------------
grep -q '|| die "control-plane npm install failed (hard dependency)' "$INSTALL" \
  || fail "install.sh root npm install is not a hard dependency"
grep -q '|| die "agent-runtime npm install failed (hard dependency)' "$INSTALL" \
  || fail "install.sh agent-runtime npm install is not a hard dependency"
grep -q 'die "Could not ensure cli.json provider catalog' "$INSTALL" \
  || fail "install.sh cli.json seed failure does not die"
grep -q 'REGISTRY SEED DEGRADED' "$INSTALL" \
  || fail "install.sh registry cp fallback is not reported as a failure"
grep -qE 'cp "\$src" "\$dest" 2>/dev/null; then' "$INSTALL" \
  || fail "install.sh registry cp fallback is not guarded"
grep -q 'die "Could not seed registry.json' "$INSTALL" \
  || fail "install.sh registry seed failure does not die when the fallback also fails"
! grep -q 'warn "Unknown BIZAGENT_PROVIDER' "$INSTALL" \
  || fail "install.sh unknown BIZAGENT_PROVIDER still warns instead of dying"
grep -q 'die "Unknown BIZAGENT_PROVIDER' "$INSTALL" \
  || fail "install.sh unknown BIZAGENT_PROVIDER does not die with valid values"
grep -q 'die "BIZAGENT_API_KEY was rejected' "$INSTALL" \
  || fail "install.sh rejected BIZAGENT_API_KEY does not die (bad key must not be written)"
! grep -q 'warn "BIZAGENT_API_KEY was rejected' "$INSTALL" \
  || fail "install.sh rejected BIZAGENT_API_KEY still only warns"
grep -q 'install it manually (Debian/Ubuntu: sudo apt-get install cron) and re-run' "$INSTALL" \
  || fail "install.sh ensure_cron does not die with manual-install guidance"
grep -q 'remote remove origin' "$INSTALL" \
  || fail "install.sh detach-framework-remote failure does not print the manual command"
! grep -q 'detach-framework-remote.sh" "$INSTALL_DIR" || true' "$INSTALL" \
  || fail "install.sh detach-framework-remote still swallows failure with || true"
grep -q 'exit 3' "$TTS" \
  || fail "install-oddbeaker-tts.sh soft_fail exits 0 — callers cannot tell failure from success"

# install/install.sh mirrors
grep -q 'die "Unknown BIZAGENT_PROVIDER' "$INSTALL_CP" \
  || fail "install/install.sh unknown BIZAGENT_PROVIDER does not die"
grep -q 'die "BIZAGENT_API_KEY was rejected' "$INSTALL_CP" \
  || fail "install/install.sh rejected BIZAGENT_API_KEY does not die"
grep -q 'REGISTRY SEED DEGRADED' "$INSTALL_CP" \
  || fail "install/install.sh registry cp fallback is not reported as a failure"
grep -q 'die "Could not seed registry.json' "$INSTALL_CP" \
  || fail "install/install.sh registry seed failure does not die"
grep -q '|| die "control-plane npm install failed (hard dependency)' "$INSTALL_CP" \
  || fail "install/install.sh control-plane npm install is not a hard dependency"
grep -q '|| die "agent-runtime npm install failed (hard dependency)' "$INSTALL_CP" \
  || fail "install/install.sh agent-runtime npm install is not a hard dependency"
! grep -q "<<'PY' 2>/dev/null || cp " "$INSTALL_CP" \
  || fail "install/install.sh registry seed still swallows the python error entirely"
! grep -q "except Exception:.*pass" "$INSTALL_CP" \
  || fail "install/install.sh headless patch still swallows errors with a bare pass"

# handoff: port-wait failure must print the log tail and exit 1 — the
# "Open this URL" block must be unreachable on failure (both installers).
for f in "$INSTALL" "$INSTALL_CP"; do
  grep -q 'did not respond on port' "$f" || fail "$f: no port-wait failure message"
  grep -q 'control-plane-server.log' "$f" || fail "$f: port-wait failure does not name the log"
  grep -q 'answering on port' "$f" || fail "$f: no probed ok line for the control plane port"
  grep -q 'llmapi answering at' "$f" || fail "$f: handoff does not probe llmapi /health before printing the URL"
done
awk '/did not respond on port/{inblk=1} inblk && /exit 1/{found=1; exit} END{exit !found}' "$INSTALL" \
  || fail "install.sh handoff port-wait failure does not exit 1"
awk '/did not respond on port/{inblk=1} inblk && /exit 1/{found=1; exit} END{exit !found}' "$INSTALL_CP" \
  || fail "install/install.sh port-wait failure does not exit 1"

# control-plane.sh: "port not accepting" is a failure, not a success line.
grep -q 'FAILED to start: pid $pid alive but port $port not accepting' "$CP" \
  || fail "control-plane.sh still reports success when the port never accepts"
grep -q 'return "$start_rc"' "$CP" \
  || fail "control-plane.sh start does not return non-zero on failed readiness"

# check-hub-ready.sh: keyless (optionalKey) providers must not be blocked.
grep -q 'optionalKey: entry.optionalKey === true' "$READY" \
  || fail "check-hub-ready.sh does not emit optionalKey from the resolved cli.json entry"
grep -q 'optional for $PROVIDER (keyless OK)' "$READY" \
  || fail "check-hub-ready.sh does not skip the key check for optionalKey providers"

# The live hub's operator cli.json must not ship in fresh clones — a tracked
# cli.json made every fresh install inherit this hub's custom provider entries
# (unresolvable <ollama-host> baseURL) instead of seeding from cli.json.example.
! git -C "$ROOT" ls-files --error-unmatch cli.json >/dev/null 2>&1 \
  || fail "cli.json is still tracked — fresh installs must seed from cli.json.example"
grep -qE '^cli\.json$' "$ROOT/.gitignore" \
  || fail ".gitignore must ignore operator cli.json"

# --- generic warn scan -------------------------------------------------------
# Every warn in the installers must be either followed by a die/non-zero exit
# within a few lines, or sit on the soft-fail allowlist below (optional
# components whose failure is explicitly reported and survivable).
SOFT_FAIL='TTS|tts|health probe|Health watchdog|WSL|wsl|curl not found|Homebrew|cron\.|service cron|detach|remove public origin|check it manually|may only be reachable|browser speechSynthesis|stays optional|voice in|Re-run|API key|BIZAGENT_AUTO_UPDATE|Enter 1|re-enter|Please enter|existing registry|welcome seed|seed-first-run|llmapi service unit|as a process'
scan_warns() {
  local f="$1"
  local n text window
  while IFS=: read -r n text; do
    [[ -n "$n" ]] || continue
    if printf '%s' "$text" | grep -qE "$SOFT_FAIL"; then continue; fi
    window="$(sed -n "$((n + 1)),$((n + 10))p" "$f")"
    if printf '%s' "$window" | grep -qE 'die |exit 1|return 1|\|\| install_exit'; then continue; fi
    fail "$f:$n: warn about a required component without a following die: $text"
  done < <(grep -nE '(^|[[:space:](&|])warn "' "$f")
}
scan_warns "$INSTALL"
scan_warns "$INSTALL_CP"

# --- generic ok-claim probe scan --------------------------------------------
# An ok claiming something started/installed/finished must be preceded (within
# 25 lines) by an actual probe: liveness, TCP, /health, command -v, version,
# or the guarded command whose exit code the ok reports.
PROBE='kill -0|/dev/tcp|/health|command -v|have |curl|systemctl|systemd_active|find_pids|dot -V|java -version|node -v|npm -v|crontab|pgrep|find_plantuml_bin|validate_api_key|git clone|npm install|python3|cp "|bash "'
scan_oks() {
  local f="$1"
  local n text window
  while IFS=: read -r n text; do
    [[ -n "$n" ]] || continue
    printf '%s' "$text" | grep -qE 'ok "(.*)(started|installed|installed and enabled|finished|answering|answering on port)' || continue
    window="$(sed -n "$((n > 25 ? n - 25 : 1)),$((n - 1))p" "$f")"
    # probe may sit on the same line, before the ok (e.g. `have java && { ok … }`)
    window="${text%%ok *}
$window"
    if printf '%s' "$window" | grep -qE "$PROBE"; then continue; fi
    fail "$f:$n: ok success-claim without a preceding probe: $text"
  done < <(grep -nE '(^|[[:space:](&|])ok "' "$f")
}
scan_oks "$INSTALL"
scan_oks "$INSTALL_CP"

# --- 4. provider catalog copies must be identical ----------------------------
python3 - "$ROOT" <<'PY'
import ast, json, re, subprocess, sys
root = sys.argv[1]
failures = []

install_sh = open(f"{root}/install.sh").read()
example = json.load(open(f"{root}/cli.json.example"))
catalog = json.loads(subprocess.run(
    ["node", "-e", "console.log(JSON.stringify(require(process.argv[1]).PROVIDER_CATALOG))", f"{root}/control-plane/lib/cli-config.js"],
    capture_output=True, text=True, check=True).stdout)

m = re.search(r"defaults = \{(.*?)\n    \}", install_sh, re.S)
if not m:
    failures.append("install.sh: provider defaults dict not found")
    defaults = {}
else:
    defaults = ast.literal_eval("{" + m.group(1) + "}")

m = re.search(r"PROVIDER_DEFAULT_MODEL = \{(.*?)\}", install_sh, re.S)
if not m:
    failures.append("install.sh: PROVIDER_DEFAULT_MODEL dict not found")
    model_defaults = {}
else:
    model_defaults = ast.literal_eval("{" + m.group(1) + "}")

for provider, ex in example.items():
    if provider.startswith("_"):
        continue
    for name, src in (("cli.json.example", ex), ("PROVIDER_CATALOG", catalog.get(provider)), ("installer defaults", defaults.get(provider))):
        if src is None:
            failures.append(f"{provider}: missing from {name}")
            continue
        for key in ("label", "baseURL", "keyEnv", "models", "optionalKey"):
            if key in ex or key in src:
                if ex.get(key) != src.get(key):
                    failures.append(f"{provider}.{key}: {name}={src.get(key)!r} != cli.json.example={ex.get(key)!r}")
    first = (ex.get("models") or [""])[0]
    if model_defaults.get(provider) != first:
        failures.append(f"{provider}: registry-seed default model {model_defaults.get(provider)!r} != first cli.json.example model {first!r}")

if failures:
    print("\n".join(failures))
    sys.exit(1)
PY
[[ $? -eq 0 ]] || fail "provider catalog copies drifted apart (installer dict / registry-seed heredoc / cli.json.example / PROVIDER_CATALOG)"

echo "  ok: installer hygiene"
