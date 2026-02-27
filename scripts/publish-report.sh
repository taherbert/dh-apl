#!/usr/bin/env bash
set -euo pipefail

# Publish the report dashboard to GitHub Pages (gh-pages branch).
# Usage: npm run report:publish [-- --skip-sims] [-- --fidelity quick|standard|confirm]
#
# Worktree-safe: uses a temp clone to push to gh-pages without
# touching the current working tree or branch.

SPEC="${SPEC:-vengeance}"
REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || echo "$(cd "$(dirname "$0")/.." && pwd)")"
REPORT_FILE="$REPO_ROOT/results/$SPEC/report/index.html"
STAGING="${TMPDIR:-/private/tmp/claude/claude-501}/gh-pages-staging"
REMOTE_URL="$(git remote get-url origin)"

# Parse args — pass everything through to report.js, default to --skip-sims
REPORT_ARGS="--skip-sims"
if [[ $# -gt 0 ]]; then
  REPORT_ARGS="$*"
fi

echo "=== Generating report ==="
SPEC="$SPEC" node "$REPO_ROOT/src/visualize/report.js" $REPORT_ARGS

if [[ ! -f "$REPORT_FILE" ]]; then
  echo "Error: Report not found at $REPORT_FILE"
  exit 1
fi

echo "=== Publishing to gh-pages ==="

# Use a temp bare clone to avoid worktree conflicts
rm -rf "$STAGING"
mkdir -p "$STAGING"
cd "$STAGING"

git init --quiet
git remote add origin "$REMOTE_URL"

# Fetch existing gh-pages if it exists
if git ls-remote --exit-code --heads origin gh-pages >/dev/null 2>&1; then
  git fetch origin gh-pages --quiet
  git checkout -b gh-pages FETCH_HEAD --quiet
else
  git checkout --orphan gh-pages --quiet
fi

# Clean and copy report
git rm -rf --quiet . 2>/dev/null || true
cp "$REPORT_FILE" index.html
echo "${PUBLISH_DOMAIN:-vengeance.jomdarbert.com}" > CNAME
git add index.html CNAME

TIMESTAMP="$(date -u +"%Y-%m-%d %H:%M UTC")"
git commit -m "Update report dashboard — $TIMESTAMP" --quiet --allow-empty

git push origin gh-pages --quiet

echo "=== Pushed to gh-pages ==="

# Clean up
rm -rf "$STAGING"

echo "Done. Report will be live at https://taherbert.github.io/dh-apl/"
