#!/usr/bin/env bash
# setup-tls.sh — one-command https setup for the BizAgent control plane console.
#
# Browsers only expose the microphone (getUserMedia) on secure contexts, so a
# console opened from another device over http://<host>:8787 has a disabled
# mic. This script generates (or accepts) a certificate, enables TLS in
# registry.json (settings.control_plane.tls), and prints the https URLs plus
# the browser trust step for self-signed certs.
#
# The control plane serves BOTH protocols on the same port (it sniffs the
# first byte of each connection: a TLS ClientHello starts with 0x16), so
# http://localhost:<port> keeps working after TLS is enabled — health probes,
# scripts, and operator bookmarks do not break.
#
# Usage:
#   scripts/setup-tls.sh [--hub PATH] [--cn NAME] [--ip IP]...
#                        [--cert PATH --key PATH] [--force] [--no-enable] [-y]
#
#   (default)        Generate a self-signed cert into <hub>/.bizagent/tls/
#                    (CN=<hostname>; SANs: hostname, localhost, 127.0.0.1,
#                    ::1, and every detected LAN IPv4 — add more with --ip).
#   --cert/--key     Use an existing cert/key pair instead (paths are recorded
#                    in registry.json; files are NOT copied or renewed here).
#   --no-enable      Generate/record the cert but leave TLS disabled.
#   --force          Regenerate the self-signed cert even if one exists.
#   -y               Non-interactive (no prompts; safe for scripts/upgrades).
#
# Idempotent: re-running without --force reuses the existing cert and only
# ensures the registry setting. Never touches .bizagent/env or secrets.
set -euo pipefail

HUB=""
CN=""
FORCE=0
ENABLE=1
CERT_ARG=""
KEY_ARG=""
EXTRA_IPS=()
YES=0

usage() { sed -n '2,40p' "$0" | sed 's/^# \?//'; exit 2; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --hub) HUB="${2:-}"; shift 2 ;;
    --cn) CN="${2:-}"; shift 2 ;;
    --ip) EXTRA_IPS+=("${2:-}"); shift 2 ;;
    --cert) CERT_ARG="${2:-}"; shift 2 ;;
    --key) KEY_ARG="${2:-}"; shift 2 ;;
    --force) FORCE=1; shift ;;
    --no-enable) ENABLE=0; shift ;;
    -y|--yes) YES=1; shift ;;
    -h|--help) usage ;;
    *) echo "setup-tls.sh: unknown argument: $1 (try --help)" >&2; exit 2 ;;
  esac
done

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [[ -z "$HUB" ]]; then
  HUB="$(cd "$SCRIPT_DIR/.." && pwd)"
else
  HUB="$(cd "$HUB" && pwd)"
fi

[[ -f "$HUB/registry.json" ]] || { echo "setup-tls.sh: no registry.json at $HUB (is this a built hub?)" >&2; exit 1; }
command -v openssl >/dev/null 2>&1 || { echo "setup-tls.sh: openssl not found — install it (e.g. sudo apt install openssl)" >&2; exit 1; }

log() { printf '%s\n' "$*"; }

# --- port (same resolution order as control-plane/lib/config.js) ------------
PORT="${BIZAGENT_PORT:-}"
if [[ -z "$PORT" ]] && command -v node >/dev/null 2>&1; then
  PORT="$(node -e 'try{const r=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));const p=r&&r.settings&&r.settings.control_plane&&r.settings.control_plane.port;if(p)console.log(p)}catch(_e){}' "$HUB/registry.json" 2>/dev/null || true)"
fi
PORT="${PORT:-8787}"

# --- LAN IPv4 detection (node first — the control plane needs it anyway) ----
lan_ips() {
  if command -v node >/dev/null 2>&1; then
    node -e 'const os=require("os");for(const name of Object.keys(os.networkInterfaces()))for(const a of os.networkInterfaces()[name]||[]){if(a.internal||a.family!=="IPv4"||!a.address)continue;if(/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(a.address))console.log(a.address)}' 2>/dev/null || true
  fi
  if command -v hostname >/dev/null 2>&1; then
    hostname -I 2>/dev/null | tr ' ' '\n' | grep -E '^(10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[01])\.)' || true
  fi
}

HOSTNAME_DETECTED="$(hostname 2>/dev/null || uname -n 2>/dev/null || echo localhost)"
CN="${CN:-$HOSTNAME_DETECTED}"

# --- cert material -----------------------------------------------------------
TLS_DIR="$HUB/.bizagent/tls"
mkdir -p "$TLS_DIR"
chmod 700 "$TLS_DIR" 2>/dev/null || true

if [[ -n "$CERT_ARG" || -n "$KEY_ARG" ]]; then
  [[ -n "$CERT_ARG" && -n "$KEY_ARG" ]] || { echo "setup-tls.sh: --cert and --key must be given together" >&2; exit 1; }
  [[ -r "$CERT_ARG" ]] || { echo "setup-tls.sh: cert not readable: $CERT_ARG" >&2; exit 1; }
  [[ -r "$KEY_ARG" ]] || { echo "setup-tls.sh: key not readable: $KEY_ARG" >&2; exit 1; }
  CERT_PATH="$(cd "$(dirname "$CERT_ARG")" && pwd)/$(basename "$CERT_ARG")"
  KEY_PATH="$(cd "$(dirname "$KEY_ARG")" && pwd)/$(basename "$KEY_ARG")"
  log "setup-tls: using provided cert/key pair"
else
  CERT_PATH="$TLS_DIR/tls.crt"
  KEY_PATH="$TLS_DIR/tls.key"
  if [[ -s "$CERT_PATH" && -s "$KEY_PATH" && "$FORCE" -ne 1 ]]; then
    log "setup-tls: reusing existing self-signed cert ($CERT_PATH) — use --force to regenerate"
  else
    # SANs are mandatory for modern browsers (CN alone is ignored).
    SANs=("DNS:$CN" "DNS:localhost" "IP:127.0.0.1" "IP:::1")
    while IFS= read -r ip; do
      [[ -n "$ip" ]] || continue
      entry="IP:$ip"
      found=0
      for s in "${SANs[@]}"; do [[ "$s" == "$entry" ]] && found=1; done
      [[ "$found" -eq 0 ]] && SANs+=("$entry")
    done < <(lan_ips)
    for ip in "${EXTRA_IPS[@]:-}"; do
      [[ -n "$ip" ]] || continue
      SANs+=("IP:$ip")
    done
    SAN_STR="$(IFS=,; echo "${SANs[*]}")"
    if openssl req -x509 -newkey rsa:2048 -nodes \
        -keyout "$KEY_PATH" -out "$CERT_PATH" -days 3650 \
        -subj "/CN=$CN" \
        -addext "subjectAltName=$SAN_STR" >/dev/null 2>&1; then
      :
    else
      # Ancient openssl without -addext: CN-only cert still serves https.
      openssl req -x509 -newkey rsa:2048 -nodes \
        -keyout "$KEY_PATH" -out "$CERT_PATH" -days 3650 \
        -subj "/CN=$CN" >/dev/null 2>&1
    fi
    chmod 600 "$KEY_PATH" 2>/dev/null || true
    log "setup-tls: generated self-signed cert (CN=$CN)"
    log "setup-tls: SANs: $SAN_STR"
  fi
fi

FINGERPRINT="$(openssl x509 -in "$CERT_PATH" -noout -fingerprint -sha256 2>/dev/null | cut -d= -f2- || true)"

# --- enable TLS in registry.json ---------------------------------------------
if [[ "$ENABLE" -eq 1 ]]; then
  if ! node -e '
    const fs = require("fs");
    const p = process.argv[1];
    const cert = process.argv[2];
    const key = process.argv[3];
    const d = JSON.parse(fs.readFileSync(p, "utf8"));
    d.settings = d.settings || {};
    d.settings.control_plane = d.settings.control_plane || {};
    d.settings.control_plane.tls = d.settings.control_plane.tls || {};
    d.settings.control_plane.tls.enabled = true;
    d.settings.control_plane.tls.cert = cert;
    d.settings.control_plane.tls.key = key;
    fs.writeFileSync(p, JSON.stringify(d, null, 2) + "\n");
  ' "$HUB/registry.json" "$CERT_PATH" "$KEY_PATH"; then
    echo "setup-tls.sh: could not update registry.json — enable manually:" >&2
    echo '  settings.control_plane.tls = { "enabled": true, "cert": "...", "key": "..." }' >&2
    exit 1
  fi
  log "setup-tls: TLS enabled in registry.json (settings.control_plane.tls)"
else
  log "setup-tls: --no-enable — cert recorded on disk, TLS left disabled"
fi

# --- summary ------------------------------------------------------------------
log ""
log "Cert:  $CERT_PATH"
log "Key:   $KEY_PATH"
[[ -n "$FINGERPRINT" ]] && log "SHA-256 fingerprint: $FINGERPRINT"
log ""
log "Restart the control plane to pick this up:"
log "  bash $HUB/scripts/control-plane.sh restart"
log ""
log "Then open the console over https from any device on the LAN:"
if command -v node >/dev/null 2>&1; then
  lan_ips | sort -u | while read -r ip; do
    [[ -n "$ip" ]] && log "  https://$ip:$PORT"
  done
fi
log "  https://$CN:$PORT   (if the hostname resolves on your LAN)"
log "  http://localhost:$PORT also keeps working on the same port."
log ""
log "Browser trust (self-signed cert — pick one):"
log "  1. One-time bypass: open the https URL, click through the certificate"
log "     warning (Advanced → Proceed). The page is still a secure context and"
log "     the mic works."
log "  2. Trust the cert properly (no warning, recommended):"
log "     - Debian/Ubuntu (system store, covers Chrome/Chromium/Edge):"
log "       sudo cp $CERT_PATH /usr/local/share/ca-certificates/bizagent-local.crt"
log "       sudo update-ca-certificates"
log "     - Firefox: Settings → Privacy & Security → Certificates → View"
log "       Certificates → Authorities → Import → pick $CERT_PATH"
log "     - macOS: sudo security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain $CERT_PATH"
log "  The cert covers: $CN, localhost, 127.0.0.1, ::1 and this box's LAN IPs."
