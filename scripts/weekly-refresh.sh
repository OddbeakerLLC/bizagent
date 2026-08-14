#!/usr/bin/env bash
# weekly-refresh.sh
#
# Orchestrates the weekly Knowledge Stack refresh with minimal LLM usage.
# Mechanical steps (timestamp read, company-change detection, per-agent messaging,
# router run, agent spawn/collect, source-doc copy, manifest write, journal bullet)
# are scripted. Only the two judgment steps invoke LLM:
#   1. PTL synthesizing company docs (if changes detected)
#   2. Each product agent deciding "no update vs update" and returning overview
#
# This script replaces the previous approach of running the PTL agent for the
# entire WEEKLY.md flow, which could exceed MAX_ITERATIONS with many products.
#
# Exit codes:
#   0 - success
#   1 - knowledge_stack disabled
#   2 - missing registry or other config error
#   3 - agent spawn/collect failure (continues with remaining agents)
#   4 - company synthesis failure
#
set -u

HUB="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$HUB"

# shellcheck source=lib/log-ts.sh
. "$HUB/scripts/lib/log-ts.sh"

# Timestamp for this run
RUN_TS="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
RUN_DATE="$(date -u +%Y-%m-%d)"

# --- Helper functions -------------------------------------------------------

log() { printf '%s [weekly-refresh] %s\n' "$(bizagent_ts)" "$*"; }
err() { printf '%s [weekly-refresh] ERROR: %s\n' "$(bizagent_ts)" "$*" >&2; }

# Read a value from registry.json using node
registry_get() {
  local path="$1"
  node -e "
    const data = require('./registry.json');
    const parts = '$path'.split('.');
    let val = data;
    for (const p of parts) { val = val?.[p]; }
    console.log(val ?? '');
  " 2>/dev/null
}

# Get list of product slugs from registry
get_product_slugs() {
  node -e "
    const reg = require('./registry.json');
    (reg.products || []).forEach(p => console.log(p.slug));
  " 2>/dev/null
}

# Get last refresh timestamp from MANIFEST.md (or epoch if missing)
get_last_refresh() {
  local manifest="$HUB/knowledge-stack/MANIFEST.md"
  if [[ ! -f "$manifest" ]]; then
    echo "1970-01-01T00:00:00Z"
    return
  fi
  # Extract timestamp from header line
  local ts
  ts="$(grep -m1 '^Last refresh:' "$manifest" 2>/dev/null | sed 's/^Last refresh: //' || true)"
  if [[ -z "$ts" ]]; then
    echo "1970-01-01T00:00:00Z"
  else
    echo "$ts"
  fi
}

# Check if company/ has files newer than last refresh
company_has_newer_files() {
  local last_ts="$1"
  local company_dir="$HUB/company"
  
  if [[ ! -d "$company_dir" ]]; then
    return 1
  fi
  
  # Check for files newer than last_ts
  find "$company_dir" -type f -newermt "$last_ts" 2>/dev/null | head -1 | grep -q .
}

# Check for [Company] journal bullets since last refresh
company_journal_has_changes() {
  local last_ts="$1"
  local journal_dir="$HUB/journal"
  
  if [[ ! -d "$journal_dir" ]]; then
    return 1
  fi
  
  # Convert last_ts to date for comparison
  local last_date
  last_date="$(date -d "$last_ts" +%Y-%m-%d 2>/dev/null || echo "1970-01-01")"
  
  # Find journal files since last_date and check for [Company] bullets
  local found=1
  while IFS= read -r file; do
    [[ -z "$file" ]] && continue
    local file_date
    file_date="$(basename "$file" .md)"
    if [[ "$file_date" > "$last_date" ]] || [[ "$file_date" == "$last_date" ]]; then
      if grep -q '\[Company\]' "$file" 2>/dev/null; then
        found=0
        break
      fi
    fi
  done < <(find "$journal_dir" -name "*.md" -type f 2>/dev/null | sort)
  
  return $found
}

# Write a message to an agent's inbox (via outbox + router)
write_agent_request() {
  local slug="$1"
  local subject="$2"
  local body="$3"
  
  local outbox="$HUB/agents/$slug/outbox"
  local filename="$RUN_DATE-hub-${slug}-ks-refresh.md"
  
  mkdir -p "$outbox"
  
  cat > "$outbox/$filename" <<EOF
---
from: hub
to: $slug
date: $RUN_DATE
subject: $subject
---

$body
EOF
  
  log "Wrote request to $slug outbox: $filename"
}

# Write a message to hub's inbox for company synthesis
write_hub_request() {
  local subject="$1"
  local body="$2"
  
  local inbox="$HUB/inbox"
  local filename="$RUN_DATE-weekly-company-synthesis.md"
  
  mkdir -p "$inbox"
  
  cat > "$inbox/$filename" <<EOF
---
from: weekly-refresh
to: hub
date: $RUN_DATE
subject: $subject
---

$body
EOF
  
  log "Wrote request to hub inbox: $filename"
}

# Run router to move outbox messages to inboxes
run_router() {
  log "Running router..."
  if ! "$HUB/scripts/router.sh" 2>&1; then
    err "Router failed"
    return 1
  fi
  log "Router completed"
  return 0
}

# Spawn an agent and wait for it to complete
# Uses run-agent.sh with a focused prompt
spawn_agent_for_ks() {
  local slug="$1"
  
  log "Spawning agent: $slug"
  
  # The agent's .dispatch.md already tells it to check inbox and process messages
  # We just need to run the agent with a focused prompt
  local prompt="Process your inbox. You have a Knowledge Stack refresh request. Follow the instructions in that message. After processing, archive the message."
  
  if ! "$HUB/scripts/run-agent.sh" "$prompt" 2>&1; then
    err "Agent $slug failed"
    return 1
  fi
  
  log "Agent $slug completed"
  return 0
}

# Spawn hub agent for company synthesis
spawn_hub_for_ks() {
  log "Spawning hub agent for company synthesis..."
  
  local prompt="Process your inbox. You have a weekly company synthesis request. Follow the instructions in that message. After processing, archive the message."
  
  if ! "$HUB/scripts/run-agent.sh" "$prompt" 2>&1; then
    err "Hub agent failed during company synthesis"
    return 1
  fi
  
  log "Hub agent completed"
  return 0
}

# Check if agent replied with "no update"
check_agent_no_update() {
  local slug="$1"
  
  local outbox="$HUB/agents/$slug/outbox"
  
  # Find the most recent reply in the agent's outbox
  local reply_file
  reply_file="$(find "$outbox" -name "*.md" -type f -newermt "$RUN_DATE" 2>/dev/null | sort | tail -1)"
  
  if [[ -z "$reply_file" ]]; then
    # Fall back to any recent file
    reply_file="$(find "$outbox" -name "*.md" -type f -mmin -10 2>/dev/null | sort | tail -1)"
  fi
  
  if [[ -z "$reply_file" ]]; then
    return 1  # No reply found, assume update needed
  fi
  
  # Check for "no update" in the reply
  if grep -qi "no update" "$reply_file" 2>/dev/null; then
    return 0  # No update
  fi
  
  return 1  # Has update
}

# Archive a message from inbox to inbox/archive
archive_inbox_message() {
  local slug="$1"
  
  local inbox="$HUB/agents/$slug/inbox"
  local archive="$inbox/archive"
  
  # Find and archive the KS refresh request
  local msg_file
  msg_file="$(find "$inbox" -maxdepth 1 -name "*ks-refresh*.md" -type f 2>/dev/null | head -1)"
  
  if [[ -z "$msg_file" ]]; then
    # Fall back to any recent message
    msg_file="$(find "$inbox" -maxdepth 1 -name "*.md" -type f -mmin -10 2>/dev/null | head -1)"
  fi
  
  if [[ -n "$msg_file" ]]; then
    mkdir -p "$archive"
    mv "$msg_file" "$archive/"
    log "Archived $slug inbox message: $(basename "$msg_file")"
  fi
}

# Archive hub inbox message
archive_hub_inbox_message() {
  local inbox="$HUB/inbox"
  local archive="$inbox/archive"
  
  local msg_file
  msg_file="$(find "$inbox" -maxdepth 1 -name "*company-synthesis*.md" -type f 2>/dev/null | head -1)"
  
  if [[ -n "$msg_file" ]]; then
    mkdir -p "$archive"
    mv "$msg_file" "$archive/"
    log "Archived hub inbox message: $(basename "$msg_file")"
  fi
}

# Write MANIFEST.md
write_manifest() {
  local stack="$HUB/knowledge-stack"
  local manifest="$stack/MANIFEST.md"
  
  mkdir -p "$stack"
  
  log "Writing MANIFEST.md..."
  
  {
    echo "# Knowledge Stack Manifest"
    echo ""
    echo "Last refresh: $RUN_TS"
    echo ""
    echo "## Files"
    echo ""
    
    # List all files in knowledge-stack with their metadata
    for file in "$stack"/*; do
      [[ -f "$file" ]] || continue
      local basename
      basename="$(basename "$file")"
      
      # Skip MANIFEST.md itself
      [[ "$basename" == "MANIFEST.md" ]] && continue
      
      # Determine owner
      local owner="hub"
      if [[ "$basename" =~ ^([a-z0-9-]+)- ]]; then
        owner="${BASH_REMATCH[1]}"
        # Check if this is a company file
        if [[ "$basename" =~ ^00-company ]]; then
          owner="hub"
        fi
      fi
      
      # Get file date (use file mtime)
      local file_date
      file_date="$(date -r "$file" +%Y-%m-%d 2>/dev/null || echo "$RUN_DATE")"
      
      # Determine source type
      local source="synthesized"
      if [[ "$basename" =~ \.pdf$ ]] || [[ "$basename" =~ \.txt$ ]]; then
        source="copied"
      fi
      
      echo "- $basename | owner: $owner | source: $source | date: $file_date"
    done
  } > "$manifest"
  
  log "MANIFEST.md written"
}

# Append journal bullet
append_journal() {
  local message="$1"
  
  local journal_dir="$HUB/journal"
  local journal_file="$journal_dir/$RUN_DATE.md"
  
  mkdir -p "$journal_dir"
  
  if [[ ! -f "$journal_file" ]]; then
    echo "# $RUN_DATE" > "$journal_file"
    echo "" >> "$journal_file"
  fi
  
  echo "- [Maintenance] $message" >> "$journal_file"
  log "Appended journal bullet"
}

# --- Main flow -------------------------------------------------------------

# 1. Enablement check
ENABLED="$(registry_get 'knowledge_stack.enabled')"
if [[ "$ENABLED" != "true" ]]; then
  log "knowledge_stack disabled, exiting"
  exit 0
fi

# Run the existing weekly.sh for orphan cleanup
log "Running weekly.sh for orphan cleanup..."
"$HUB/scripts/weekly.sh" 2>&1 || err "weekly.sh had errors (continuing)"

# 2. Get last refresh timestamp
LAST_REFRESH="$(get_last_refresh)"
log "Last refresh: $LAST_REFRESH"

# 3. Check for company changes
NEEDS_COMPANY_SYNTHESIS="false"
if company_has_newer_files "$LAST_REFRESH"; then
  NEEDS_COMPANY_SYNTHESIS="true"
  log "Company has newer files"
elif company_journal_has_changes "$LAST_REFRESH"; then
  NEEDS_COMPANY_SYNTHESIS="true"
  log "Journal has [Company] changes"
fi

# 4. Company synthesis (if needed) - invoke PTL agent
if [[ "$NEEDS_COMPANY_SYNTHESIS" == "true" ]]; then
  log "Company changes detected, invoking PTL for synthesis..."
  
  # Write a message to hub's inbox for company synthesis
  write_hub_request "Weekly company synthesis" "Synthesize company Knowledge Stack contribution.

Last refresh: $LAST_REFRESH

Check company/ for files newer than the last refresh and scan journal/ for [Company] bullets since the last refresh.

If there are changes:
- Write 00-company-overview.md to knowledge-stack/
- Write topical files (00-company-mission.md, 00-company-news.md, etc.) as appropriate
- Overwrite prior versions

If no changes, leave existing 00-company-*.md files untouched.

This is a weekly maintenance task. Do not start any product work."
  
  # Spawn hub agent
  if spawn_hub_for_ks; then
    log "Company synthesis completed"
  else
    err "Company synthesis failed (continuing)"
  fi
  
  # Archive the synthesis message
  archive_hub_inbox_message
fi

# 5. Per-agent refresh
UPDATED_SLUGS=""
NO_UPDATE_SLUGS=""
FAILED_SLUGS=""

while IFS= read -r slug; do
  [[ -z "$slug" ]] && continue
  
  log "Processing product: $slug"
  
  # Write request message to agent's outbox
  write_agent_request "$slug" "Refresh your Knowledge Stack contribution. Last refresh: $RUN_DATE." \
    "Review your project(s) for changes since the last Knowledge Stack refresh ($LAST_REFRESH).

If there are meaningful updates:
- Write an overview file (<slug>-overview.md) to knowledge-stack/ with your contribution
- Copy any source documents (PDFs, specs, etc.) to knowledge-stack/ as <slug>-<basename>.<ext>

If no meaningful updates since last refresh, reply with 'no update' and your existing files will be preserved.

This is a weekly maintenance task. Do not start any product work."
  
  # Run router to move message to agent's inbox
  run_router || true
  
  # Spawn the agent
  if spawn_agent_for_ks "$slug"; then
    # Check if agent replied with "no update"
    if check_agent_no_update "$slug"; then
      log "Agent $slug: no update"
      NO_UPDATE_SLUGS="$NO_UPDATE_SLUGS $slug"
    else
      log "Agent $slug: updated"
      UPDATED_SLUGS="$UPDATED_SLUGS $slug"
    fi
    
    # Archive the request message
    archive_inbox_message "$slug"
  else
    err "Failed to spawn agent $slug"
    FAILED_SLUGS="$FAILED_SLUGS $slug"
  fi
  
done < <(get_product_slugs)

# 6. Write MANIFEST.md
write_manifest

# 7. Append journal bullet
JOURNAL_MSG="Refreshed Knowledge Stack."
if [[ -n "$UPDATED_SLUGS" ]]; then
  JOURNAL_MSG="$JOURNAL_MSG Updated:$UPDATED_SLUGS."
fi
if [[ -n "$NO_UPDATE_SLUGS" ]]; then
  JOURNAL_MSG="$JOURNAL_MSG No update:$NO_UPDATE_SLUGS."
fi
if [[ -n "$FAILED_SLUGS" ]]; then
  JOURNAL_MSG="$JOURNAL_MSG Failed:$FAILED_SLUGS."
fi

append_journal "$JOURNAL_MSG"

log "Weekly refresh completed"
exit 0