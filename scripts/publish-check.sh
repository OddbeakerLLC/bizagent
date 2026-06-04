#!/usr/bin/env bash
# publish-check.sh — Guard the PUBLIC bizagent framework repo against leaking
# any private/operational content. Wired as a pre-push hook (see below) and safe
# to run by hand at any time. Exits non-zero and lists offenders if anything matches.
#
# Install the hook:  ln -sf ../../scripts/publish-check.sh .git/hooks/pre-push
#
# The author-in-this-repo model should already keep operational data out; this is
# the backstop that turns "nobody noticed" into a stop. It exists because the
# operational hub was once pushed to a public repo and no check caught it.
#
# Patterns come in two layers:
#   1. Generic markers below — private IP ranges, key material, session-id shapes.
#      These are non-identifying and safe to ship in the public repo.
#   2. Your own operator-specific markers — hostnames, domains, usernames, public
#      IPs, project codenames. These MUST NOT live in this tracked file (that would
#      leak the very strings we're guarding). Put them in a local, gitignored file:
#        scripts/publish-check.patterns   (one extended-regex per line; # = comment)
#      See scripts/publish-check.patterns.example for the format.
set -u
cd "$(git rev-parse --show-toplevel)" 2>/dev/null || exit 2

# Generic private / infra / credential markers — safe to publish (not operator-specific).
PATTERNS='user_[a-z0-9]{12,}|192\.168\.|10\.[0-9]+\.[0-9]+\.|172\.(1[6-9]|2[0-9]|3[01])\.|id_rsa|BEGIN [A-Z ]*PRIVATE KEY'

# Layer in operator-specific markers from the local, gitignored patterns file.
LOCAL_PATTERNS="scripts/publish-check.patterns"
if [ -f "$LOCAL_PATTERNS" ]; then
  while IFS= read -r line; do
    # Skip blank lines and comments.
    case "$line" in ''|'#'*) continue ;; esac
    PATTERNS="$PATTERNS|$line"
  done < "$LOCAL_PATTERNS"
fi

# Scan tracked files only; never flag this script or the example (they hold pattern text).
hits=$(git grep -nIE "$PATTERNS" -- . \
  ':(exclude)scripts/publish-check.sh' \
  ':(exclude)scripts/publish-check.patterns.example' 2>/dev/null)

if [ -n "$hits" ]; then
  echo "✗ publish-check FAILED — private/operational content in the framework tree:" >&2
  echo "$hits" >&2
  echo "" >&2
  echo "Refusing to publish. Remove the above before pushing to the public repo." >&2
  exit 1
fi

echo "✓ publish-check passed — no private/operational markers in the tracked tree."
exit 0
