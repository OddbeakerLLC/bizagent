#!/usr/bin/env bash
# test-dispatch.sh — exercise bizagent-dispatch.sh against a temp fixture tree.
#
# Covers acceptance criteria from the dispatcher spec:
#   AC1  message -> agent launches, does work, archives, reply routed next tick
#   AC2  two messages for one agent -> a single launch drains both
#   AC3  run spanning >1 tick -> next tick does NOT double-launch (live lock holds)
#   AC4  killed mid-run -> unfinished mail stays, stale lock reclaimed, retried
#   AC5  concurrency cap respected under a burst to many agents
#   AC6  idle tick spends ~zero (no CLI launched when no mail)
#
# The dispatcher launches a CLI; we substitute a fake CLI script (BIZAGENT_CLI)
# so no real agent runs. The fake plays whatever "agent" behavior each case needs.
set -u
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DISPATCH_SRC="$SCRIPT_DIR/../scripts/bizagent-dispatch.sh"
ROUTER_SRC="$SCRIPT_DIR/../scripts/router.sh"

TMPROOT="$(mktemp -d)"
trap 'rm -rf "$TMPROOT"' EXIT
fail() { echo "  FAIL: $1"; exit 1; }

# wait_for <seconds> <command...> : poll until command succeeds or timeout
wait_for() {
  local secs="$1"; shift
  local end=$(( $(date +%s) + secs ))
  while [ "$(date +%s)" -lt "$end" ]; do
    if "$@" >/dev/null 2>&1; then return 0; fi
    sleep 0.1
  done
  return 1
}

new_hub() {
  # new_hub <name> -> echoes hub path with scripts + minimal registry
  local hub="$TMPROOT/$1"
  mkdir -p "$hub/scripts" "$hub/inbox" "$hub/outbox" "$hub/logs" "$hub/agents"
  cp "$DISPATCH_SRC" "$hub/scripts/bizagent-dispatch.sh"
  cp "$ROUTER_SRC"   "$hub/scripts/router.sh"
  echo '{"settings":{},"products":[]}' > "$hub/registry.json"
  echo "$hub"
}

new_agent() {
  # new_agent <hub> <slug>
  mkdir -p "$2_x" 2>/dev/null
  mkdir -p "$1/agents/$2/inbox/archive" "$1/agents/$2/outbox"
  cat > "$1/agents/$2/agent.md" <<EOF
# Agent $2
EOF
}

msg() {
  # msg <hub> <slug> <name> <to>
  cat > "$1/agents/$2/inbox/$3" <<EOF
---
from: test
to: ${4:-hub}
date: 2026-06-14
subject: $3
---
body
EOF
}

# A fake CLI that drains the inbox: archives every message, optionally writes a
# reply to outbox. Invocation matches: <cli> <prompt_flag> <extra...> <prompt>
make_fake_cli() {
  # make_fake_cli <path> <behavior>
  #   behavior=drain        : archive all inbox msgs (with a reply for AC1)
  #   behavior=sleep_drain  : sleep, then archive (for AC3/AC5 timing)
  #   behavior=hang         : write PID file then sleep forever (for AC4)
  local path="$1" behavior="$2"
  cat > "$path" <<EOF
#!/usr/bin/env bash
set -u
SLUG="\$BIZAGENT_TEST_SLUG"
HUB="\$BIZAGENT_TEST_HUB"
IB="\$HUB/agents/\$SLUG/inbox"
OB="\$HUB/agents/\$SLUG/outbox"
behavior="$behavior"
case "\$behavior" in
  sleep_drain) sleep "\${BIZAGENT_TEST_SLEEP:-1}";;
  hang)
    echo "\$\$" > "\$HUB/agents/\$SLUG/fakepid"
    ps -o pgid= -p "\$\$" 2>/dev/null | tr -d ' ' > "\$HUB/agents/\$SLUG/fakepgid"
    sleep 600; exit 0;;
esac
shopt -s nullglob
i=0
for m in "\$IB"/*.md; do
  base="\$(basename "\$m")"
  # write a reply addressed to hub (exercises routing on the next tick)
  cat > "\$OB/reply-\$base" <<RPLY
---
from: \$SLUG
to: hub
date: 2026-06-14
subject: reply
---
done \$base
RPLY
  mv "\$m" "\$IB/archive/"
  i=\$((i+1))
done
echo "fake-cli drained \$i for \$SLUG" >&2
EOF
  chmod +x "$path"
}

# The dispatcher's launched wrapper runs the CLI with cwd=HUB and passes prompt
# args; our fake needs to know slug+hub. We export them via a per-run wrapper.
# Simplest: a wrapper CLI that infers slug from the prompt text.
make_wrapper_cli() {
  # make_wrapper_cli <path> <innerbehavior>
  local path="$1" behavior="$2"
  local inner="$path.inner"
  make_fake_cli "$inner" "$behavior"
  cat > "$path" <<EOF
#!/usr/bin/env bash
set -u
# args: <prompt_flag> [extra...] <prompt>  (prompt is always the last arg)
prompt="\${@: -1}"
# extract slug from "You are the '<slug>' agent."
slug="\$(printf '%s' "\$prompt" | sed -n "s/.*You are the '\\([^']*\\)' agent.*/\\1/p")"
export BIZAGENT_TEST_SLUG="\$slug"
export BIZAGENT_TEST_HUB="\$(pwd)"
exec bash "$inner" "\$@"
EOF
  chmod +x "$path"
}

run_tick() {
  # run_tick <hub> <cli> [extra env assignments...]
  local hub="$1" cli="$2"; shift 2
  env BIZAGENT_CLI="$cli" BIZAGENT_CLI_PROMPT_FLAG="-p" BIZAGENT_CLI_EXTRA_ARGS="" \
      "$@" bash "$hub/scripts/bizagent-dispatch.sh" >/dev/null 2>&1
}

# ----------------------------------------------------------------------------
# AC6 — idle tick launches nothing (no mail) and spends ~zero
# ----------------------------------------------------------------------------
{
  HUB="$(new_hub ac6)"
  new_agent "$HUB" alpha
  CLI="$TMPROOT/cli6"
  # a CLI that touches a sentinel if ever called
  cat > "$CLI" <<EOF
#!/usr/bin/env bash
touch "$TMPROOT/ac6-cli-was-called"
EOF
  chmod +x "$CLI"
  run_tick "$HUB" "$CLI"
  [ ! -e "$TMPROOT/ac6-cli-was-called" ] || fail "AC6: CLI launched on an idle tick"
  echo "  ok: AC6 idle tick launches nothing"
}

# ----------------------------------------------------------------------------
# AC1 — message -> launch, work, archive, reply routed next tick
# AC2 — two messages -> single launch drains both
# ----------------------------------------------------------------------------
{
  HUB="$(new_hub ac12)"
  new_agent "$HUB" alpha
  msg "$HUB" alpha 2026-06-14-test-one.md hub
  msg "$HUB" alpha 2026-06-14-test-two.md hub
  CLI="$(printf '%s' "$TMPROOT/cli12")"
  make_wrapper_cli "$CLI" drain

  run_tick "$HUB" "$CLI"
  # detached agent runs async; wait for both archived
  wait_for 10 test -f "$HUB/agents/alpha/inbox/archive/2026-06-14-test-one.md" \
    || fail "AC1/2: message one not archived"
  [ -f "$HUB/agents/alpha/inbox/archive/2026-06-14-test-two.md" ] \
    || fail "AC2: message two not archived (single launch must drain both)"
  [ -z "$(ls -A "$HUB/agents/alpha/inbox" 2>/dev/null | grep -v archive)" ] \
    || fail "AC1: inbox not drained"
  # lock released after run
  wait_for 5 sh -c "[ ! -d \"$HUB/agents/alpha/.lock\" ]" \
    || fail "AC1: lock not released after run"

  # next tick routes the replies (alpha/outbox -> hub/inbox)
  run_tick "$HUB" "$CLI"
  ls "$HUB/inbox"/reply-*.md >/dev/null 2>&1 \
    || fail "AC1: replies not routed to hub inbox on next tick"
  echo "  ok: AC1 launch/work/archive/route"
  echo "  ok: AC2 single launch drains multiple messages"
}

# ----------------------------------------------------------------------------
# AC3 — a run spanning >1 tick must NOT be double-launched
# ----------------------------------------------------------------------------
{
  HUB="$(new_hub ac3)"
  new_agent "$HUB" alpha
  msg "$HUB" alpha 2026-06-14-slow.md hub
  CLI="$TMPROOT/cli3"
  make_wrapper_cli "$CLI" sleep_drain

  # first tick launches a slow run (sleeps ~2s before draining)
  run_tick "$HUB" "$CLI" BIZAGENT_TEST_SLEEP=2
  wait_for 5 test -d "$HUB/agents/alpha/.lock" || fail "AC3: lock not created"
  # capture launched pid
  pid1="$(cat "$HUB/agents/alpha/.lock/pid" 2>/dev/null)"

  # second tick while still running: must skip (lock held by live pid)
  run_tick "$HUB" "$CLI" BIZAGENT_TEST_SLEEP=2
  pid2="$(cat "$HUB/agents/alpha/.lock/pid" 2>/dev/null)"
  [ "$pid1" = "$pid2" ] || fail "AC3: lock pid changed -> a duplicate was launched"
  # message must still be pending (slow run hasn't archived yet)
  [ -f "$HUB/agents/alpha/inbox/2026-06-14-slow.md" ] \
    || fail "AC3: message archived too early (timing) — re-check"

  # let the run finish and archive
  wait_for 10 test -f "$HUB/agents/alpha/inbox/archive/2026-06-14-slow.md" \
    || fail "AC3: slow run never archived"
  echo "  ok: AC3 no duplicate launch while a run holds the lock"
}

# ----------------------------------------------------------------------------
# AC4 — killed mid-run: mail stays, stale lock reclaimed, retried
# ----------------------------------------------------------------------------
{
  HUB="$(new_hub ac4)"
  new_agent "$HUB" alpha
  msg "$HUB" alpha 2026-06-14-crash.md hub
  HANG="$TMPROOT/cli4-hang"
  make_wrapper_cli "$HANG" hang

  run_tick "$HUB" "$HANG"
  wait_for 5 test -f "$HUB/agents/alpha/fakepgid" || fail "AC4: hung agent never started"
  agentpid="$(cat "$HUB/agents/alpha/fakepid")"
  agentpgid="$(cat "$HUB/agents/alpha/fakepgid")"
  # Simulate a hard crash (power loss / SIGKILL of the whole detached session):
  # kill the entire process group so the wrapper's EXIT trap can NOT run and
  # clean the lock. This is what leaves a STALE lock behind to be reclaimed.
  kill -9 -- "-$agentpgid" 2>/dev/null
  wait_for 5 sh -c "! kill -0 $agentpid 2>/dev/null" || fail "AC4: could not kill agent"
  [ -f "$HUB/agents/alpha/inbox/2026-06-14-crash.md" ] \
    || fail "AC4: unfinished message did not stay in inbox"
  [ -d "$HUB/agents/alpha/.lock" ] || fail "AC4: lock unexpectedly gone before reclaim test"

  # Next tick with a working CLI: stale lock (dead pid) must be reclaimed and
  # the message retried + archived.
  GOOD="$TMPROOT/cli4-good"
  make_wrapper_cli "$GOOD" drain
  run_tick "$HUB" "$GOOD"
  wait_for 10 test -f "$HUB/agents/alpha/inbox/archive/2026-06-14-crash.md" \
    || fail "AC4: message not retried/archived after stale-lock reclaim"
  echo "  ok: AC4 crash leaves mail, reclaims stale lock, retries"
}

# ----------------------------------------------------------------------------
# AC4b — lease-based reclaim: a stale lock with a *live* pid but age > lease
#        is still reclaimable. We forge an old start-epoch.
# ----------------------------------------------------------------------------
{
  HUB="$(new_hub ac4b)"
  new_agent "$HUB" alpha
  msg "$HUB" alpha 2026-06-14-lease.md hub
  mkdir -p "$HUB/agents/alpha/.lock"
  # live pid = this test's shell; but start-epoch far in the past
  echo "$$" > "$HUB/agents/alpha/.lock/pid"
  echo "1" > "$HUB/agents/alpha/.lock/start"   # epoch 1 = 1970
  GOOD="$TMPROOT/cli4b"
  make_wrapper_cli "$GOOD" drain
  run_tick "$HUB" "$GOOD" BIZAGENT_LOCK_LEASE_SECS=1800
  wait_for 10 test -f "$HUB/agents/alpha/inbox/archive/2026-06-14-lease.md" \
    || fail "AC4b: expired-lease lock not reclaimed"
  echo "  ok: AC4b expired lease reclaimed even with live pid"
}

# ----------------------------------------------------------------------------
# AC5 — concurrency cap respected under a burst to many agents
# ----------------------------------------------------------------------------
{
  HUB="$(new_hub ac5)"
  for s in a b c d e f; do
    new_agent "$HUB" "$s"
    msg "$HUB" "$s" 2026-06-14-burst.md hub
  done
  CLI="$TMPROOT/cli5"
  make_wrapper_cli "$CLI" sleep_drain
  # cap 2; long enough sleep that all launched agents are concurrently "live"
  run_tick "$HUB" "$CLI" BIZAGENT_MAX_CONCURRENCY=2 BIZAGENT_TEST_SLEEP=3
  # count live locks immediately after the tick
  wait_for 3 sh -c "ls -d \"$HUB\"/agents/*/.lock >/dev/null 2>&1"
  locks=$(ls -d "$HUB"/agents/*/.lock 2>/dev/null | wc -l | tr -d ' ')
  [ "$locks" -le 2 ] || fail "AC5: $locks concurrent runs exceeded cap of 2"
  [ "$locks" -ge 1 ] || fail "AC5: cap blocked everything (expected up to 2 running)"
  echo "  ok: AC5 concurrency cap respected ($locks <= 2 running in burst)"
}

# ----------------------------------------------------------------------------
# Lock mutual exclusion (unit-level): two near-simultaneous ticks, one launch.
# ----------------------------------------------------------------------------
{
  HUB="$(new_hub mutex)"
  new_agent "$HUB" alpha
  msg "$HUB" alpha 2026-06-14-mx.md hub
  CLI="$TMPROOT/climx"
  make_wrapper_cli "$CLI" sleep_drain
  run_tick "$HUB" "$CLI" BIZAGENT_TEST_SLEEP=2 &
  run_tick "$HUB" "$CLI" BIZAGENT_TEST_SLEEP=2 &
  wait
  # exactly one reply should eventually exist (one drain) — message archived once
  wait_for 10 test -f "$HUB/agents/alpha/inbox/archive/2026-06-14-mx.md" \
    || fail "mutex: message never archived"
  replies=$(ls "$HUB/agents/alpha/outbox"/reply-*.md 2>/dev/null | wc -l | tr -d ' ')
  [ "$replies" -le 1 ] || fail "mutex: $replies replies -> message double-processed"
  echo "  ok: lock mutual exclusion (one launch under concurrent ticks)"
}

# ----------------------------------------------------------------------------
# install-dispatch: writes an ABSOLUTE, executable CLI path into .cli, and
# fails loudly when no CLI can be resolved. (Regression: bare "claude" is not
# on PATH under cron/setsid.)
# ----------------------------------------------------------------------------
INSTALL_SRC="$SCRIPT_DIR/../scripts/install-dispatch.sh"
{
  HUB="$(new_hub installcli)"
  cp "$INSTALL_SRC" "$HUB/scripts/install-dispatch.sh"

  # A fake CLI somewhere NOT on the test's PATH; point BIZAGENT_CLI at it by name
  # via an absolute path and confirm .cli records the absolute path verbatim.
  fakebin="$HUB/fakebin"
  mkdir -p "$fakebin"
  printf '#!/usr/bin/env bash\n' > "$fakebin/myclaude"
  chmod +x "$fakebin/myclaude"

  # `print` mode also resolves+writes .cli (resolve runs in cron/systemd modes;
  # for the test we drive resolution directly via systemd mode, which does not
  # require a tty). Use BIZAGENT_CLI as the absolute escape hatch.
  out="$(env BIZAGENT_CLI="$fakebin/myclaude" HOME="$HUB/fakehome" \
        bash "$HUB/scripts/install-dispatch.sh" systemd 2 2>&1)" \
    || fail "install-dispatch: systemd install failed: $out"

  [ -f "$HUB/.cli" ] || fail "install-dispatch: .cli not written"
  # CLI line must be the absolute path we gave
  grep -q "^CLI=$fakebin/myclaude$" "$HUB/.cli" \
    || fail "install-dispatch: .cli CLI= is not the absolute path (got: $(grep '^CLI=' "$HUB/.cli"))"
  # and it must be absolute + executable
  cli_val="$(. "$HUB/.cli"; printf '%s' "$CLI")"
  case "$cli_val" in /*) ;; *) fail "install-dispatch: CLI is not absolute: $cli_val";; esac
  [ -x "$cli_val" ] || fail "install-dispatch: recorded CLI is not executable: $cli_val"

  # systemd unit must export a PATH (belt-and-suspenders)
  unit="$HUB/fakehome/.config/systemd/user/bizagent-dispatch.service"
  [ -f "$unit" ] || fail "install-dispatch: systemd .service not written"
  grep -q "^Environment=PATH=" "$unit" \
    || fail "install-dispatch: systemd unit does not export PATH"
  echo "  ok: install-dispatch writes absolute executable CLI + PATH in unit"
}

# install-dispatch fails LOUDLY (non-zero) when no CLI can be resolved.
{
  HUB="$(new_hub installcli_fail)"
  cp "$INSTALL_SRC" "$HUB/scripts/install-dispatch.sh"
  # A HOME with no .local/bin/<cli> + a bogus BIZAGENT_CLI name that command -v
  # cannot resolve on the (real) PATH. Must exit non-zero before writing .cli.
  if env BIZAGENT_CLI="definitely-not-a-real-cli-xyz" HOME="$HUB/emptyhome" \
       bash "$HUB/scripts/install-dispatch.sh" systemd 2 >/dev/null 2>&1; then
    fail "install-dispatch: expected non-zero exit when CLI cannot be resolved"
  fi
  [ ! -f "$HUB/.cli" ] || fail "install-dispatch: wrote .cli despite unresolved CLI"
  echo "  ok: install-dispatch fails loudly when no CLI resolvable"
}

# install-dispatch: SAFE-BY-DEFAULT — a default install (no opt-in flag, no tty)
# must write an EMPTY CLI_EXTRA_ARGS (no --dangerously-skip-permissions baked in).
{
  HUB="$(new_hub installsafe)"
  cp "$INSTALL_SRC" "$HUB/scripts/install-dispatch.sh"
  fakebin="$HUB/fakebin"; mkdir -p "$fakebin"
  printf '#!/usr/bin/env bash\n' > "$fakebin/myclaude"; chmod +x "$fakebin/myclaude"

  # No --allow-autonomous, non-interactive (output captured = no tty) -> safe.
  out="$(env BIZAGENT_CLI="$fakebin/myclaude" HOME="$HUB/fakehome" \
        bash "$HUB/scripts/install-dispatch.sh" systemd 2 2>&1)" \
    || fail "install-dispatch(safe): install failed: $out"

  [ -f "$HUB/.cli" ] || fail "install-dispatch(safe): .cli not written"
  grep -q '^CLI_EXTRA_ARGS=$' "$HUB/.cli" \
    || fail "install-dispatch(safe): CLI_EXTRA_ARGS not empty (got: $(grep '^CLI_EXTRA_ARGS=' "$HUB/.cli"))"
  if grep -q 'dangerously-skip-permissions' "$HUB/.cli"; then
    fail "install-dispatch(safe): dangerous flag was baked into .cli by default"
  fi
  echo "  ok: install-dispatch default install is safe (empty CLI_EXTRA_ARGS)"
}

# install-dispatch: OPT-IN — with --allow-autonomous the skip-permissions flag is
# written into .cli. Also verify the env opt-in (BIZAGENT_ALLOW_AUTONOMOUS=1).
{
  HUB="$(new_hub installoptin)"
  cp "$INSTALL_SRC" "$HUB/scripts/install-dispatch.sh"
  fakebin="$HUB/fakebin"; mkdir -p "$fakebin"
  printf '#!/usr/bin/env bash\n' > "$fakebin/myclaude"; chmod +x "$fakebin/myclaude"

  out="$(env BIZAGENT_CLI="$fakebin/myclaude" HOME="$HUB/fakehome" \
        bash "$HUB/scripts/install-dispatch.sh" systemd 2 --allow-autonomous 2>&1)" \
    || fail "install-dispatch(opt-in): install failed: $out"
  grep -q '^CLI_EXTRA_ARGS=--dangerously-skip-permissions$' "$HUB/.cli" \
    || fail "install-dispatch(opt-in --allow-autonomous): skip-permissions not written (got: $(grep '^CLI_EXTRA_ARGS=' "$HUB/.cli"))"

  # env-based opt-in, into a fresh hub
  HUB2="$(new_hub installoptinenv)"
  cp "$INSTALL_SRC" "$HUB2/scripts/install-dispatch.sh"
  fakebin2="$HUB2/fakebin"; mkdir -p "$fakebin2"
  printf '#!/usr/bin/env bash\n' > "$fakebin2/myclaude"; chmod +x "$fakebin2/myclaude"
  env BIZAGENT_CLI="$fakebin2/myclaude" HOME="$HUB2/fakehome" BIZAGENT_ALLOW_AUTONOMOUS=1 \
      bash "$HUB2/scripts/install-dispatch.sh" systemd 2 >/dev/null 2>&1 \
    || fail "install-dispatch(opt-in env): install failed"
  grep -q '^CLI_EXTRA_ARGS=--dangerously-skip-permissions$' "$HUB2/.cli" \
    || fail "install-dispatch(opt-in BIZAGENT_ALLOW_AUTONOMOUS): skip-permissions not written"
  echo "  ok: install-dispatch opt-in writes skip-permissions (flag + env)"
}

# install-dispatch: an explicit prior choice in .cli is PRESERVED, not downgraded.
{
  HUB="$(new_hub installpreserve)"
  cp "$INSTALL_SRC" "$HUB/scripts/install-dispatch.sh"
  fakebin="$HUB/fakebin"; mkdir -p "$fakebin"
  printf '#!/usr/bin/env bash\n' > "$fakebin/myclaude"; chmod +x "$fakebin/myclaude"
  # seed .cli with a prior explicit permission choice
  cat > "$HUB/.cli" <<EOF
CLI=$fakebin/myclaude
CLI_PROMPT_FLAG=-p
CLI_EXTRA_ARGS=--dangerously-skip-permissions
EOF
  env HOME="$HUB/fakehome" \
      bash "$HUB/scripts/install-dispatch.sh" systemd 2 >/dev/null 2>&1 \
    || fail "install-dispatch(preserve): install failed"
  grep -q '^CLI_EXTRA_ARGS=--dangerously-skip-permissions$' "$HUB/.cli" \
    || fail "install-dispatch(preserve): prior explicit choice was downgraded"
  echo "  ok: install-dispatch preserves a prior explicit permission choice"
}

# bizagent-dispatch: the in-script default for CLI_EXTRA_ARGS must be EMPTY (the
# dangerous flag is no longer a built-in default).
{
  grep -q '^CLI_EXTRA_ARGS_DEFAULT=""$' "$DISPATCH_SRC" \
    || fail "bizagent-dispatch: CLI_EXTRA_ARGS_DEFAULT is not empty by default"
  echo "  ok: bizagent-dispatch default CLI_EXTRA_ARGS is empty (safe)"
}

# ----------------------------------------------------------------------------
# CLI_EXTRA_ARGS order: extra args must appear BEFORE the prompt, not after.
# A Codex-style invocation is: <cli> exec <extra> "<prompt>"
# Verify the dispatcher places them correctly by capturing the arg list.
# ----------------------------------------------------------------------------
{
  HUB="$(new_hub extraorder)"
  new_agent "$HUB" alpha
  msg "$HUB" alpha 2026-06-14-order.md hub

  ORDER_LOG="$TMPROOT/order.log"
  CLI="$TMPROOT/cli-order"
  cat > "$CLI" <<'EOF'
#!/usr/bin/env bash
# Write all args (one per line) to the order log so the test can inspect.
printf '%s\n' "$@" >> "$BIZAGENT_ORDER_LOG"
# Archive the message so the dispatcher doesn't loop.
IB="$(pwd)/agents/$(cat "$BIZAGENT_ORDER_SLUG_FILE")/inbox"
for m in "$IB"/*.md; do
  [ -f "$m" ] && mv "$m" "$IB/archive/"
done
EOF
  chmod +x "$CLI"

  SLUG_FILE="$TMPROOT/order-slug"
  printf 'alpha' > "$SLUG_FILE"

  env BIZAGENT_CLI="$CLI" BIZAGENT_CLI_PROMPT_FLAG="-p" \
      BIZAGENT_CLI_EXTRA_ARGS="--extra-flag" \
      BIZAGENT_ORDER_LOG="$ORDER_LOG" \
      BIZAGENT_ORDER_SLUG_FILE="$SLUG_FILE" \
      bash "$HUB/scripts/bizagent-dispatch.sh" >/dev/null 2>&1

  wait_for 5 test -f "$ORDER_LOG" || fail "extra-order: fake CLI never ran"
  # The args captured are those AFTER the cli itself: pflag, [extra...], prompt.
  # With BIZAGENT_CLI_PROMPT_FLAG=-p and CLI_EXTRA_ARGS=--extra-flag, the sequence
  # must be:  -p  --extra-flag  <prompt-text>
  # Note: the dispatcher now makes two CLI calls (agent + notification), so we extract
  # only the first call's args (lines 1-3, before the second -p).
  args="$(cat "$ORDER_LOG")"
  first_arg="$(printf '%s' "$args" | head -1)"
  second_arg="$(printf '%s' "$args" | sed -n '2p')"
  third_arg="$(printf '%s' "$args" | sed -n '3p')"
  [ "$first_arg" = "-p" ]           || fail "extra-order: expected -p as arg1, got '$first_arg'"
  [ "$second_arg" = "--extra-flag" ] || fail "extra-order: expected --extra-flag before prompt, got '$second_arg'"
  printf '%s' "$third_arg" | grep -q "You are the" \
    || fail "extra-order: prompt not third arg (got '$third_arg')"
  echo "  ok: CLI_EXTRA_ARGS placed before prompt in dispatch invocation"
}

echo "  ok: bizagent-dispatch.sh"
