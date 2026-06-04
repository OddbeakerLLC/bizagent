#!/usr/bin/env bash
# run-tests.sh — run every tests/test-*.sh and tally the results.
# NOTE: deliberately no `set -e` — it would abort on the first failing test
# before the tally is printed.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PASS=0
FAIL=0

for t in "$SCRIPT_DIR"/test-*.sh; do
  [ -e "$t" ] || continue
  echo "=== $(basename "$t") ==="
  bash "$t"
  status=$?
  if [ "$status" -eq 0 ]; then
    PASS=$((PASS + 1))
  else
    FAIL=$((FAIL + 1))
  fi
  echo
done

echo "-------------------------------"
echo "passed: $PASS   failed: $FAIL"
[ "$FAIL" -eq 0 ]
