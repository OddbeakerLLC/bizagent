#!/bin/bash
# Commits and pushes. Use this instead of raw git commands.
set -e
cd "$(dirname "$0")"

if [ -z "$1" ]; then
    echo "Usage: $(basename "$0") \"Commit message\""
    exit 1
fi

MSG="$*"

git add -A
git commit -m "$MSG"
git push

echo ""
echo "✅ Deployed $(basename "$(pwd)")"

