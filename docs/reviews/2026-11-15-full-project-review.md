# Full-project code review — public BizAgent repo (origin/main @ 65c1658)

Reviewer: Agent CR (Craig) · Date: 2026-11-15 · Scope: entire public project

## Executive summary

The core architecture is sound and genuinely well-engineered for its size: atomic state writes with `.bak` recovery, a dispatcher whose provider-queue hold logic (backoff ladder → hold → auto-resume → one-time loud notify) is correctly implemented and well tested, careful error classification in the LLM path (the `err.cause` code handling for connection errors is the kind of thing most projects get wrong), fail-clear model resolution, and an unusually good sitemap/journal discipline. The test suite is large (39 files) and the recent provider-queue-hold and Ollama thinking-level work is solid.

The serious problems cluster in three places:

1. **Security surface vs. defaults.** The control plane defaults to `0.0.0.0` while the architecture doc claims `127.0.0.1`; `/api/health` is unauthenticated and leaks recent agent errors, provider holds, and check details; sessions never expire and session IDs are written to logs in plaintext; login has no rate limiting. Individually each is medium; together on a LAN-exposed default bind they are the project's biggest risk.
2. **XSS in the console.** Two confirmed injection sinks (cross-chat alert badge, library SVG preview) plus one likely (health-banner details). Conversation names are operator-controlled and reach `innerHTML` unescaped.
3. **Installer destructiveness and secret-file hygiene.** A guardless `rm -rf` of an existing non-git install directory, and three different `.bizagent/env` write paths with world-readable windows.

Also notable: template-placeholder drift (`{{PRODUCT_SLUG}}` ships literally in every rendered dispatch prompt; `{{BUSINESS_PRESET_SECTION}}` survives industry-template application), the service worker can serve the wrong app shell offline, and ~21 files of one-off hack scripts and `.backup` cruft are tracked in the public repo root.

Verdict: **Changes requested.** Nothing here is unmaintainable, but the high-severity items (installer `rm -rf`, unauth health exposure + default bind, session lifetime, XSS sinks, placeholder drift) should be fixed before the next release cut.

---

## Critical

None found. (No confirmed remote code execution, secret disclosure in the public tree, or data-loss path reachable without operator misconfiguration. The installer `rm -rf` below is the closest call and is rated high because it requires a typo'd env var to trigger.)

## High

### H1. Guardless `rm -rf` of an existing install directory
- **Files:** `install.sh:1635` (`choose_dir`)
- **What's wrong:** If `$INSTALL_DIR` exists but has no `.git` directory, the installer deletes it (`rm -rf`) after only killing the control plane — no content check, no `BIZAGENT_REINSTALL=1` gate, unlike the reinstall branch which verifies `AGENT.md`. A typo'd or stale `BIZAGENT_DIR` (pointing at `$HOME`, a docs volume, any non-git directory) is destroyed non-interactively.
- **Fix:** Require explicit `BIZAGENT_REINSTALL=1` (or an interactive confirm when a TTY exists) for any wipe of a directory that is non-empty and does not look like a prior partial install (no `install.sh`/`AGENT.md` marker).

### H2. Unauthenticated `/api/health` leaks operational detail and amplifies health checks
- **Files:** `control-plane/server.js:640–668`, `control-plane/lib/health.js`
- **What's wrong:** `/api/health` is deliberately public, but it returns `recent_errors` (agent error text), `provider_queue_holds`, `rate_limit_cooldown_secs`, and full per-check details — internal operational intelligence — to any unauthenticated caller. Worse, when `logs/health.json` is older than 2 minutes, *any* unauthenticated request triggers a full inline `runHealthCheck` (disk scans, process scans): an unauthenticated poller can keep the CPU cost of health checks pinned.
- **Fix:** Split the payload: keep a minimal unauthenticated `{ok, level, safe_mode}` for banner/monitors, and move `recent_errors` / holds / check details behind `requireAuth` (the banner fetch is authenticated anyway). Cap or debounce the inline re-check (serve `level: "unknown"` to unauthenticated callers instead of running checks).

### H3. Sessions never expire; session IDs logged in plaintext
- **Files:** `control-plane/lib/auth.js` (`createSession`, `logEvent` with `session_id`), `control-plane/server.js`
- **What's wrong:** Sessions have `created_at` but no TTL and no pruning — a session cookie (or a log line) is valid forever. `logEvent` writes the full session ID into `logs/*.log`, so anyone who can read the logs (other agents, log viewers, the nightly git push) holds a live credential. Session file also grows unboundedly.
- **Fix:** Add a session TTL (e.g. 30 days, sliding) enforced in `getSession` with pruning on save; stop logging `session_id` (log a truncated hash or nothing); consider rotating the ID on login.

### H4. XSS: cross-chat alert badge interpolates conversation names unescaped
- **Files:** `control-plane/public/app.js:4131–4141` (`renderCrossChatAlerts`)
- **What's wrong:** `el.innerHTML` embeds `target`, `name`, and `destination` (conversation names — operator/user-controlled via the console) directly into an attribute and text with no `bannerEscape`/`escapeHtml`. A conversation named `<img src=x onerror=…>` executes in the operator's console session.
- **Fix:** Escape all three values (`bannerEscape` already exists and escapes quotes); build the button with DOM APIs like the agent rail does.

### H5. XSS: library preview injects raw SVG/document content
- **Files:** `control-plane/public/library.js:456–468`
- **What's wrong:** `bodyEl.innerHTML = <div class="library-diagram">${doc.svg}</div>` and the `.svg`-file branch inject server/agent-supplied SVG or file content raw. Any `.svg` file in a browsed repo (agent-written files are routine here) can carry `<script>`/`onload` — stored XSS in the console origin.
- **Fix:** Sanitize the SVG (strip `<script>`, event-handler attributes, `foreignObject`) before injection, or render via `<img src=…>` / sandboxed iframe. At minimum restrict to the PlantUML server's own output and treat repo `.svg` files as untrusted.

### H6. `{{PRODUCT_SLUG}}` placeholder never substituted in rendered dispatch prompts
- **Files:** `templates/dispatch.md.template:18`, `control-plane/lib/dispatcher.js:1060–1065` (`ensureDispatchPrompt`), `scripts/apply-template.sh:459–462`
- **What's wrong:** The dispatch template's form-request example says `--from {{PRODUCT_SLUG}}`, but both render paths substitute only `{{slug}}/{{agent_md}}/{{inbox}}/{{outbox}}`. Every agent's `.dispatch.md` ships with a literal `{{PRODUCT_SLUG}}` in its instructions — agents copying the example mail the hub from a bogus sender.
- **Fix:** Add `.replace(/\{\{PRODUCT_SLUG\}\}/g, slug)` in `ensureDispatchPrompt` and the apply-template fill (or change the template to reuse `{{slug}}`).

## Medium

### M1. Health banner `details` interpolated unescaped
- **Files:** `control-plane/public/app.js:3971, 4002`
- **What's wrong:** `${c.name}: ${c.detail}` goes into `innerHTML` without escaping. Check details can embed provider error text (partly agent/environment-influenced). Lower risk than H4/H5 but the same sink class.
- **Fix:** `bannerEscape(...)` the joined string.

### M2. Service worker: wrong-shell offline cache + unbounded stale cache
- **Files:** `control-plane/public/sw.js:45–55, 3`, `control-plane/public/index.html`
- **What's wrong:** (a) Every navigation response is cached under the literal key `"/index.html"` — visiting `/library.html` overwrites the cached app shell, so offline `/` can render the library page. (b) `CACHE_NAME` is static (`v1`) while assets are cache-first with `?v=` bust tokens: old-version entries are never evicted (unbounded growth) and any asset whose URL token is *not* bumped (e.g. `/enterprise/enterprise-panel.js`, `/manifest.json` — both referenced without tokens) is pinned stale forever. Pre-cached unversioned `"/app.js"` etc. are dead entries that never match the versioned requests.
- **Fix:** Cache navigations under `req.url`; bump `CACHE_NAME` on shell changes (or version it from the bust token); add bust tokens to `enterprise-panel.js`/`manifest.json`; purge old-versioned entries on activate.

### M3. llmapi caches provider config forever; timeout defaults disagree with the runtime
- **Files:** `llmapi.js` (`createClient`, `TIMEOUT_MS`)
- **What's wrong:** (a) `clients[provider]` captures `apiKey`/`baseURL` at first use and is never invalidated — a key rotated via the console (which updates the CP process env / `.bizagent/env`) never reaches the already-running llmapi; calls keep using the old key with no hint why. (b) llmapi's default `LLMAPI_TIMEOUT_MS` is 120s while the runtime's llmapi-mode client waits 600s — a long local-model generation (e.g. qwen3.8 27B) is aborted at 120s and surfaces as a 502 the runtime then retries into the same wall.
- **Fix:** Re-resolve config per request (or invalidate on file mtime); align the default timeout with the runtime (or document the env pairing loudly in `check-hub-ready` output).

### M4. `registry.example.json` dispatch block omits six tunables the dispatcher reads
- **Files:** `registry.example.json`, `control-plane/lib/dispatcher.js` (`rateLimitCooldownSecs`, `recentErrorTtlSecs`, `failureBackoffLadder`, `maxProviderFailures`, `holdCooldownSecs`, `apiMinIntervalMs`)
- **What's wrong:** The example/schema documents only `poll_seconds/max_concurrency/hub_slots/agent_slots/allow_concurrency/lock_lease_secs`. The other six are read from `settings.dispatch.*` but discoverable only by reading dispatcher source — operators tuning hold behavior (the feature that just bit them) have no documented knob.
- **Fix:** Add the six keys with defaults + comments to `registry.example.json` and assert them in `tests/test-registry-schema.sh`.

### M5. `{{BUSINESS_PRESET_SECTION}}` survives automated industry-template application
- **Files:** `templates/agent.md.template:33`, `scripts/apply-template.sh`
- **What's wrong:** The placeholder is documented as "rendered during onboarding" (hub-memory prompt), but `apply-template.sh` — the automated path — doesn't substitute it, so a template-applied agent's `agent.md` contains the literal placeholder.
- **Fix:** Either substitute it in `apply-template.sh` (from `business-presets.json` / `settings.business_type`) or strip the line with a comment when no preset is set.

### M6. Nightly `git add -A` + push has no secrets guard
- **Files:** `scripts/nightly.sh:195` (`commit_and_push`)
- **What's wrong:** Correctness rests entirely on `.gitignore`. If the ignore rules regress (the exact scenario `factory-reset.sh:377` guards against), the nightly pushes `.bizagent/env` (API keys), journals, and mail to the configured remote — automatically, every night.
- **Fix:** Before `git add -A`, assert `git check-ignore -q .bizagent/env logs` per repo; refuse to commit (loud mail) if not.

### M7. `.bizagent/env` write paths have world-readable windows / no quoting
- **Files:** `install/install.sh:193, 233, 262`, `install.sh:1451` (`write_env_file`), `install.sh:1488` (`write_tools_env_lines`)
- **What's wrong:** Keys are appended before `chmod 600` with no `umask 077` guard (a crash between append and chmod leaves a world-readable key file); the fresh-file heredoc creates the file under the ambient umask; values are written unquoted so keys/paths with spaces or `#` break every `source` of the file; `PLANTUML_SH` paths are concatenated unquoted into the env line.
- **Fix:** One shared helper: `umask 077` → write temp → `chmod 600` → atomic rename; `printf %q` all values.

### M8. Headless install silently binds `0.0.0.0`
- **Files:** `install/install.sh:385`, `control-plane/lib/config.js:310`
- **What's wrong:** Headless mode sets `control_plane.host = 0.0.0.0` with no warning, and the code default is `0.0.0.0` too — while `docs/ARCHITECTURE.md:74` claims the default is `127.0.0.1:8787`. The console (registry, dispatch control, chat) is LAN-exposed by default with cookie auth and no login rate limiting.
- **Fix:** Default to loopback; make `0.0.0.0` opt-in (`BIZAGENT_BIND_ALL=1` or a settings flag) with a printed security notice; fix the ARCHITECTURE doc.

### M9. Login has no rate limiting
- **Files:** `control-plane/server.js` (`/api/login`)
- **What's wrong:** Unlimited brute-force attempts against the single operator account, reachable on the default bind. PBKDF2-210k makes each attempt slow (which also means cheap DoS), but nothing locks out or delays repeated failures.
- **Fix:** In-memory failure counter per source IP with exponential delay + a global cap; log `auth_failed` events (without passwords).

### M10. `factory-reset.sh`: sed injection via slug + hub left stopped on source failure
- **Files:** `scripts/factory-reset.sh:243–253, 415–425`
- **What's wrong:** (a) Slugs are interpolated raw into `sed` replacement expressions — a slug containing `/`, `&`, or `\` corrupts every agent's `.dispatch.md`. (b) `stop_control_plane` runs before `resolve_framework_source`; if resolution/clone fails the hub is left down and the script `die`s without restarting it.
- **Fix:** Escape the replacement (`sed 's/[&/\\]/\\&/g'`) or substitute in node; resolve/clone the replacement source *before* stopping the CP.

### M11. defer pipeline: frontmatter injection + PID-reuse kills
- **Files:** `scripts/lib/defer-fire.sh:225`, `scripts/defer.sh:268, 560–575`
- **What's wrong:** (a) `subject` is written into YAML frontmatter unsanitized — a subject containing newlines injects arbitrary frontmatter fields (`from:`, `to:`, `kind:`) into the delivered message, i.e. in-hub mail spoofing. (b) The sleep-backend cancel/reconcile kills a bare recorded PID after only a `^[0-9]+$` check — PID reuse kills an unrelated process.
- **Fix:** Strip `\r\n` from subject (and validate from/to slugs) at write time; before killing, verify `/proc/<pid>/cmdline` matches `defer-fire.sh <id>`.

### M12. `llmapi.sh` process matching kills unrelated processes
- **Files:** `scripts/llmapi.sh:66` (`find_pids`)
- **What's wrong:** Matches any process whose cmdline contains `*/llmapi.js` — `vim llmapi.js`, `less`, `tail -f` running from the hub root are classified as the service; `stop`/`restart` SIGKILLs them. `control-plane.sh` avoids this by additionally requiring the `serve` argument; llmapi.sh has no equivalent.
- **Fix:** Require `node` + script path as adjacent argv entries (or a pidfile/marker written only by this script).

### M13. Third-party `curl | bash` (grok-cli) unpinned
- **Files:** `install.sh:179` (`install_cli`)
- **What's wrong:** The Grok CLI is installed by piping a third-party repo's install script straight into shell, re-reachable on every reinstall — an unpinned supply-chain code-execution path on the operator's machine.
- **Fix:** Pin a known-good SHA256 and verify before executing, or install from a registry with lockfile integrity; document the trust assumption either way.

### M14. Repo hygiene: one-off hack scripts and backup cruft tracked in the public root
- **Files:** `debug_lines.py`, `fix_bytes.py`, `fix_line.py`, `fix_line2.py`, `insert_line.py`, `insert_line_simple.py`, `update_agents.py`, `update_hub_prompt.py`; `agents/*.agent.md.backup-20260815-174153` (×12), `library/manifest.json.bak-pre-reconcile-2026-08-28`
- **What's wrong:** Eight one-off mutation scripts (e.g. `fix_line.py` rewrites `hub-memory.js` at hardcoded line indices) and 13 backup files are tracked in the public repo — confusing to contributors, embarrassing in a public tree, and a hazard if anyone ever runs them.
- **Fix:** `git rm` all of them; add `*.backup-*`/`*.bak-*` and `fix_*.py`-style patterns to `.gitignore`.

### M15. Sitemap claims a shipped feature that is not in the tree
- **Files:** `sitemap.md` ("Secure paste dialog v1", `POST /api/secrets`, `tests/test-secrets.sh`) vs. `control-plane/server.js` (no such route), `tests/` (no `test-secrets.sh`)
- **What's wrong:** The sitemap's Active Work lists the secrets-paste feature as done with a test; neither exists in the repo. Either the work was lost (never committed/reverted) or the sitemap describes a different tree — either way the project's own context document is wrong, which is exactly how regressions get shipped.
- **Fix:** Reconcile: re-land the feature or correct the sitemap entry; add a publish-check pattern that fails when a sitemap entry references a test file that doesn't exist.

### M16. Composer send failure loses the message silently
- **Files:** `control-plane/public/app.js:~3622–3665` (composer submit), `~3559` (`deleteConversation`)
- **What's wrong:** The submit handler clears the input, then `await api(.../messages)` with no try/catch — on network/5xx failure the typed message is gone and the rejection is unhandled. Same pattern in `deleteConversation` and the conversation-select change handler.
- **Fix:** try/catch around the send: restore the input value on failure and surface one status note; wrap the other unguarded async handlers.

## Low

### L1. `serveStatic` prefix check without path separator
- **Files:** `control-plane/server.js:242` — `file.startsWith(PUBLIC_DIR)` accepts sibling directories sharing the prefix (`…/public-secret`). No such directory exists today; use `PUBLIC_DIR + path.sep` for correctness.

### L2. `ensureUserMessage` applied to all providers
- **Files:** `agent-runtime/src/client.js` (`chatCompletion`), `llmapi.js` — the Ollama-500 workaround appends `(continue)` for every provider, subtly changing request shape for OpenAI/Claude/etc. (prompt-cache keys, provider-side validation). Gate it on `isOllamaProvider` (llmapi's second application is then harmless/idempotent).

### L3. `listProviders()` omits `xai`, `openai`, `openrouter`, `beakernet`
- **Files:** `agent-runtime/src/providers.js:66` — env-key auto-detection never selects those providers even when their keys are set. Align the list with `PROVIDERS` (or derive it).

### L4. `require-node.sh` fallback is 18, docs/code say 22
- **Files:** `scripts/lib/require-node.sh:71` — if a caller sources the file with the env var unset, the check silently weakens to Node 18. Change the fallback to 22.

### L5. Process-management TOCTOU/PID-reuse pattern repeats
- **Files:** `scripts/control-plane.sh:353,377`, `scripts/hub-daemon.sh:47–60`, `scripts/defer.sh` — same class as M11b. One shared "verify `/proc/<pid>/cmdline` matches, then kill" helper would fix all of them; also `flock` the hub-daemon start path (concurrent starts destroy each other's socket).

### L6. `control-plane.sh` sources `~/.bashrc` as env fallback; `status` mutates the pidfile
- **Files:** `scripts/control-plane.sh:20, 236` — sourcing bashrc into a service context pulls interactive-shell side effects; a read-only `status` healing the pidfile masks discovery bugs. Drop the bashrc fallback; write the pidfile only in `start`.

### L7. `wsl-cp-autostart.sh` double-spawn race
- **Files:** `scripts/wsl-cp-autostart.sh:24–27` — two shells opened simultaneously both pass the probes and both start the CP (second dies on EADDRINUSE, noisy log). Wrap the start in `flock` or rely solely on `control-plane.sh`'s own discovery.

### L8. Installer misc
- **Files:** `install.sh:540` (RETURN trap leaks and re-fires `rm -rf` on later returns), `install.sh:133/480` (`eval "$INSTALL $pkg"` — constants today, injection shape tomorrow), `install.sh:1626/1640` (`pkill -f` matches editors/greps), `install/install.sh:344–352` (hub path treated as regex in `grep -v`; unquoted paths in the cron line), `install/install.sh:120` (no-TTY `read` dies mid-install under `set -e`).

### L9. `ks-provenance.sh` `resolve_src` path-traversal existence oracle
- **Files:** `scripts/lib/ks-provenance.sh` (spot-check path) — claim refs like `proj/../../etc/passwd` are joined for an `isfile` check and logged. No content read; still, apply the same realpath-under-project-root check `resolve()` already uses.

### L10. Provider-queue state nits
- **Files:** `control-plane/lib/dispatcher.js` — `recordProviderFailure`/`resumeProviderQueue`/`recordProviderSuccess` rewrite state without preserving `skipped`, so the banner's "N launches skipped" resets on unrelated failure paths; `providerQueueGate` re-reads `registry.json` from disk per provider per tick (cache it per tick); `noteQueueHoldSkip` is an unlocked read-modify-write (lost updates undercount — cosmetic).

### L11. llmapi minor
- **Files:** `llmapi.js` — `/health` unauthenticated (leaks queue depths; fine for loopback, reconsider if the bind ever widens); bearer-token comparison is not timing-safe; queue-saturation depth is sampled before the current request enqueues (off-by-one in the warn threshold).

### L12. Tests: fixed ports, no in-repo known-fail record, coverage gaps
- **Files:** `tests/`
  - Fixed ports (`test-llmapi.sh` 18791/18792, `test-watch.sh` 9876/9877) collide under parallel runs or unlucky services — use the `pick_port` pattern the installer tests already have.
  - The documented "35 passed / 3 failed baseline" lives only in `sitemap.md`; the test files carry no known-fail markers, and `AGENT.md §2` says "Expect all green" — a new contributor cannot tell a regression from baseline. Encode the expected-fail list in `run-tests.sh` (xfail markers + a summary that fails on *unexpected* passes/failures).
  - Coverage gaps: `auth.js`, `forms.js`, `uploads.js`, `tts-proxy.js`, `thinking-logs.js`, `local-time.js`, `profile.js` have no dedicated behavioral tests (some are touched indirectly); `agent-runtime/src/index.js` and `system-prompt.js` are untested directly (loop-guard/client/tools have good coverage). Auth and forms are the two I'd test first — they hold secrets and operator input.

### L13. Cosmetic
- `app.js` `bannerTimeAgo` renders "NaNs ago" when `ts` is missing (`Math.max(1, NaN)`); `renderMessages` force-scrolls to bottom on every apply (yanks the operator's scroll position); `waitForWsReadyOrTimeout` leaks one timeout handle.

## What's good (worth keeping as patterns)

- **Provider-queue hold (65c1658):** the auto-resume path is implemented in both the dispatch gate and the health listing so the banner clears even with no pending mail; `justHeld` gives exactly-once notification; the deliberate omission of `error_key` on the hold-trip message so banner-dedupe can't suppress it is a thoughtful, documented decision. Tests cover the ladder, hold, resume, and success-clear paths.
- **`atomic-state.js` + startup recovery** — tmp+fsync+rename with `.bak` fallback across all state files is the right foundation and clearly load-bearing.
- **Error classification** (`isConnectionError` checking `err.cause.code`, not `err.name`) — rare attention to real SDK behavior; the llmapi/runtime duplication of the helper is acceptable but a shared module would be better.
- **`sanitizeMessages`** — strict field whitelisting with reasoning-payload preservation; the kind of defensive normalization that prevents whole classes of provider 400s.
- **Fail-clear model resolution** in `resolveProvider` (throw instead of silent default).
- **Auth basics done right where they are done:** PBKDF2-210k, timing-safe hash compare, HttpOnly+SameSite cookies, no tokens in URLs or localStorage.
- **Test discipline:** 39 test files including E2E installer smoke tests with fake package managers — unusually strong for a project this size.

## Recommended order of attack

1. H1 (installer `rm -rf` gate) — one-line guard, catastrophic downside.
2. H4/H5/M1 (XSS sinks) — mechanical escapes.
3. H2/H3/M8/M9 (auth/health exposure cluster) — one focused PR: minimal public health payload, session TTL, loopback default, login throttle.
4. H6/M5 (template placeholders) — small, high-annoyance.
5. M6/M7 (secrets hygiene: nightly guard + env-file writer helper).
6. M2/M3 (sw.js, llmapi staleness/timeout).
7. M14/M15 (repo cruft + sitemap reconciliation) — cheap, do anytime.
