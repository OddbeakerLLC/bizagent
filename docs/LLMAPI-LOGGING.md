# llmapi logging

llmapi emits one JSON line per significant event on stdout. Nothing sensitive
is logged: never message bodies, API keys, or auth headers; error strings are
truncated to 300 chars.

## Where the log lives

- **Started via `scripts/llmapi.sh` (nohup fallback):** appended to
  `logs/llmapi.log` in the hub root.
- **Run as the systemd user unit** (`bizagent-llmapi-<instance>.service`):
  stdout goes to the journal — tail it with:

  ```bash
  journalctl --user -u bizagent-llmapi-<instance>.service -f
  ```

  (Instance name is printed by `scripts/install-llmapi.sh`; `scripts/llmapi.sh status`
  shows the active unit.)

Tail the file route:

```bash
tail -f logs/llmapi.log | jq .
```

## Verbosity

Verbose by default while llmapi is in development. Tone down (or up) with
`LLMAPI_LOG_LEVEL` in `.bizagent/env` — `debug` | `info` (default) | `warn` |
`error`. `debug` adds per-request detail (health polls, catalog reads).

## Events

| Event | Level | Meaning |
| --- | --- | --- |
| `service_start` | info | listen address/port, concurrency, retry/timeout config, pid |
| `service_stop` | info | SIGINT/SIGTERM graceful close, uptime |
| `service_skip_port_in_use` | info | another instance owns the port (cron-safe exit 0) |
| `service_error` | error | server-level failure |
| `request_in` / `request_out` | info | route, provider/model when known, mapped status, latency_ms (`/health` polls are debug-level) |
| `provider_queue_created` | info | a provider was added to the queue list (first request for it): provider, concurrency, min_interval_ms |
| `provider_selected` | info | routing decision per chat completion: provider + model |
| `provider_fallback` | warn | `/v1/models` live fetch failed → static catalog fallback, with reason |
| `provider_retry` | warn | transient provider failure: attempt, max_retries, backoff delay_ms, reason tag (honors Retry-After) |
| `request_error` | warn/error | mapped HTTP status + provider_status + type + timeout flag (validation 400s, auth rejections via `auth_rejected`, provider errors, unreachable) |
| `auth_rejected` | warn | missing/invalid bearer token on `/v1/*` |
| `queue_saturation` / `queue_recovered` | warn/info | per-provider queue depth crossed `LLMAPI_QUEUE_WARN_DEPTH` (default 5) / drained back below |
