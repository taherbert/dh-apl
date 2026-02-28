#!/usr/bin/env bash
set -euo pipefail

# Headless publish pipeline: verify data, generate report, publish, verify live site.
# Phases 1-3 are plain bash. Phase 4 uses claude -p for read-only live-site verification.
#
# Usage: scripts/headless-publish.sh [--skip-verify]

SPEC="${SPEC:-vengeance}"
REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || echo "$(cd "$(dirname "$0")/.." && pwd)")"
SKIP_VERIFY=false
PUBLISH_URL="https://jomdarbert.com/$SPEC/"

for arg in "$@"; do
  case "$arg" in
    --skip-verify) SKIP_VERIFY=true ;;
  esac
done

echo "=== Phase 1: Data Verification ==="
if [[ "$SKIP_VERIFY" == "true" ]]; then
  echo "Skipped (--skip-verify)"
else
  SPEC="$SPEC" node "$REPO_ROOT/src/verify.js"
  echo "Verification passed."
fi

echo ""
echo "=== Phase 2: Generate Report ==="
SPEC="$SPEC" node "$REPO_ROOT/src/visualize/report.js" --skip-sims
REPORT_FILE="$REPO_ROOT/results/$SPEC/report/index.html"
if [[ ! -f "$REPORT_FILE" ]]; then
  echo "Error: Report not generated at $REPORT_FILE"
  exit 1
fi
echo "Report generated: $REPORT_FILE"

echo ""
echo "=== Phase 3: Publish to gh-pages ==="
SPEC="$SPEC" bash "$REPO_ROOT/scripts/publish-report.sh" --publish-only

echo ""
echo "=== Phase 4: Live Site Verification ==="
TODAY=$(date -u +"%Y-%m-%d")
VERIFY_PROMPT="Fetch $PUBLISH_URL and verify:
1. The page loads successfully (not a 404 or error page)
2. It contains DPS data (look for DPS numbers or chart data)
3. It contains today's date or a recent date (today is $TODAY)

Report your findings as a short summary. If any check fails, say FAIL and explain why."

if ! command -v claude &>/dev/null; then
  echo "Warning: 'claude' CLI not found. Skipping live-site verification."
  echo "Manually check: $PUBLISH_URL"
  exit 0
fi

echo "Verifying live site with Claude..."
VERIFY_OUTPUT=$(claude -p "$VERIFY_PROMPT" \
  --allowedTools "WebFetch" \
  --output-format text \
  --max-turns 3 \
  --model sonnet)
echo "$VERIFY_OUTPUT"

if echo "$VERIFY_OUTPUT" | grep -qi "FAIL"; then
  echo ""
  echo "WARNING: Live site verification found issues. Check above."
  exit 1
fi

echo ""
echo "=== Publish complete ==="
echo "Live at: $PUBLISH_URL"
