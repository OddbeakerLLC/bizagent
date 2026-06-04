#!/usr/bin/env bash
# onboard.sh <project-path>
#
# Scaffold a project repository so its product agent can manage it:
#   - creates <project>/.agent/journal/   (daily journal entries live here)
#   - creates <project>/sitemap.md        (living structure map, if absent)
#
# Idempotent: safe to run repeatedly. A missing path is a non-fatal skip.
set -u

PROJECT="${1:-}"
if [ -z "$PROJECT" ]; then
  echo "usage: onboard.sh <project-path>" >&2
  exit 2
fi
if [ ! -d "$PROJECT" ]; then
  echo "skip: '$PROJECT' is not a directory" >&2
  exit 0
fi

mkdir -p "$PROJECT/.agent/journal"

SITEMAP="$PROJECT/sitemap.md"
if [ -f "$SITEMAP" ]; then
  echo "onboarded: $PROJECT (already scaffolded)"
  exit 0
fi

NAME="$(basename "$PROJECT")"
TODAY="$(date +%F)"
{
  echo "# ${NAME} — Sitemap"
  echo "_Last updated: ${TODAY}_"
  echo
  echo "## Overview"
  echo "_One paragraph: what this project is and what it does._"
  echo
  echo "## Structure"
  echo '```'
  ( cd "$PROJECT" && find . -maxdepth 2 -type d ! -path '.' ! -path '*/.*' | sort )
  echo '```'
  echo
  echo "## Key Integrations"
  echo "- _none recorded yet_"
  echo
  echo "## Active Work"
  echo "- none"
  echo
  echo "## Known Issues"
  echo "- none"
} > "$SITEMAP"

echo "onboarded: $PROJECT (created .agent/journal, sitemap.md)"
