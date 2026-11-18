# Remote access / TLS

Run the BizAgent console over **https** so it works from any device on your
LAN — including the **microphone**. Browsers only expose `getUserMedia` (the
mic) on *secure contexts*: `https://…` or `http://localhost`. A console opened
as `http://<ai-trainer>:8787` from another device shows the mic button
disabled with a "secure context" tooltip — that is browser policy, not a bug.

TLS is opt-in per install (`settings.control_plane.tls.enabled` in
`registry.json`), but **fresh installs enable it by default** and
`scripts/upgrade.sh` enables it on existing installs (opt out with
`BIZAGENT_SKIP_TLS=1` or `--no-tls`).

## The short version (headless box, e.g. ai-trainer)

```bash
# 1. One command: generate a self-signed cert (CN=<hostname>, SANs for
#    localhost + every LAN IP) and enable TLS in registry.json
scripts/setup-tls.sh

# 2. Restart the control plane
scripts/control-plane.sh restart

# 3. From any device on the LAN, open:
#    https://<ai-trainer-LAN-IP>:8787
```

The script prints the exact https URLs, the cert's SHA-256 fingerprint, and
the browser-trust step. `http://localhost:8787` keeps working the whole time.

## Same port, both protocols

The control plane serves **http and https on the same port** (default 8787).
It peeks at the first byte of each connection: a TLS ClientHello starts with
`0x16`, plain HTTP does not, and the connection is routed to the right
server. Consequences:

- `https://<host>:8787` — secure context → mic/STT works from remote devices.
- `http://localhost:8787` — unchanged; health probes, `check-hub-ready.sh`,
  and scripts that speak plain http keep working.
- No second port to open in the firewall, no conflict with llmapi (8788).

## Certificates

### Default: self-signed (generated for you)

`scripts/setup-tls.sh` (no arguments) generates
`<hub>/.bizagent/tls/tls.{crt,key}` with:

- **CN** = the machine's hostname (e.g. `ai-trainer`)
- **SANs** = `DNS:<hostname>`, `DNS:localhost`, `IP:127.0.0.1`, `IP:::1`,
  and every detected LAN IPv4 — modern browsers match on SANs only, so the
  cert is valid for every way you can reach the box.

The key is written with mode `0600`. Re-running the script reuses the
existing cert; `--force` regenerates.

### Bring your own cert

```bash
scripts/setup-tls.sh --cert /etc/ssl/bizagent.crt --key /etc/ssl/bizagent.key
```

The paths are recorded in `registry.json`
(`settings.control_plane.tls.{cert,key}`); the files are not copied or
renewed by BizAgent — renew them with your own tooling and restart the
control plane. Env overrides (highest priority):
`BIZAGENT_TLS_CERT` / `BIZAGENT_TLS_KEY`.

### Trusting a self-signed cert in the browser

Pick one:

1. **One-time bypass** — open the https URL, click *Advanced → Proceed*.
   The page is still a secure context and the mic works. Simplest; the
   warning reappears if the cert changes.
2. **Trust the cert properly (recommended)** — no warning afterwards:
   - **Debian/Ubuntu system store** (covers Chrome/Chromium/Edge):
     ```bash
     sudo cp <hub>/.bizagent/tls/tls.crt /usr/local/share/ca-certificates/bizagent-local.crt
     sudo update-ca-certificates
     ```
   - **Firefox** (own store): Settings → Privacy & Security → Certificates →
     View Certificates → Authorities → Import → pick `tls.crt`.
   - **macOS**: `sudo security add-trusted-cert -d -r trustRoot \
     -k /Library/Keychains/System.keychain <hub>/.bizagent/tls/tls.crt`.

## Configuration reference

`registry.json` → `settings.control_plane.tls`:

| Key       | Meaning                                                        |
|-----------|----------------------------------------------------------------|
| `enabled` | `true` → serve https (plus http on the same port)              |
| `cert`    | Path to the PEM certificate (optional — auto-generates if missing) |
| `key`     | Path to the PEM key (optional — auto-generates if missing)     |

Env overrides: `BIZAGENT_TLS_CERT`, `BIZAGENT_TLS_KEY` (win over registry).
If TLS is enabled but no cert material is configured/readable, the server
generates a self-signed cert on first start into `<hub>/.bizagent/tls/`.

Opt-outs: `BIZAGENT_SKIP_TLS=1` (installer/upgrade) or `--no-tls`
(`scripts/upgrade.sh`). To turn TLS off entirely, set
`settings.control_plane.tls.enabled = false` **and** remove the `cert`/`key`
entries (their mere presence enables TLS), then restart.

## What the operator runs on ai-trainer

```bash
scripts/setup-tls.sh            # cert + registry setting
scripts/control-plane.sh restart
# open https://<ai-trainer>:8787 from any LAN device
```

If the hostname `ai-trainer` resolves on your LAN (e.g. via
`/etc/hosts` or mDNS), `https://ai-trainer:8787` works too — the cert
covers it.

## Troubleshooting

- **Mic still disabled over https** — check the lock icon: if the browser
  blocked the cert and you did *not* proceed, the page is not loaded at all.
  After proceeding, the mic button tooltip shows the real STT state
  (`/api/stt/health`); see the mic-button notes in `README.md`.
- **`ERR_CONNECTION_RESET` / handshake errors** — the cert files may be
  unreadable by the control-plane user; check `logs/control-plane-server.log`
  and re-run `scripts/setup-tls.sh --force`.
- **Cert warning shows the wrong name** — the cert was generated before the
  SAN upgrade or with a different hostname; re-run
  `scripts/setup-tls.sh --force` and re-trust the new cert.
- **Want http only again** — remove `settings.control_plane.tls` from
  `registry.json` and unset `BIZAGENT_TLS_CERT`/`BIZAGENT_TLS_KEY`, restart.
