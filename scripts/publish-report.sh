#!/usr/bin/env bash
set -euo pipefail

# Publish the report dashboard to GitHub Pages (gh-pages branch).
# Usage: npm run report:publish [-- --skip-sims] [-- --fidelity quick|standard|confirm]
#
# Multi-spec: each spec publishes to its own subdirectory ($SPEC/index.html).
# A root index.html landing page is auto-generated listing all published specs.
# Worktree-safe: uses a temp clone to push to gh-pages without
# touching the current working tree or branch.

SPEC="${SPEC:-vengeance}"
REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || echo "$(cd "$(dirname "$0")/.." && pwd)")"
REPORT_FILE="$REPO_ROOT/results/$SPEC/report/index.html"
STAGING="${TMPDIR:-/tmp}/gh-pages-staging"
REMOTE_URL="$(git remote get-url origin)"
CNAME_DOMAIN="${CNAME_DOMAIN:-$SPEC.jomdarbert.com}"

# Parse args - pass everything through to report.js, default to --skip-sims
PUBLISH_ONLY=false
REPORT_ARGS="--skip-sims"
CUSTOM_ARGS=()
for arg in "$@"; do
  if [[ "$arg" == "--publish-only" ]]; then
    PUBLISH_ONLY=true
  else
    CUSTOM_ARGS+=("$arg")
  fi
done
if [[ ${#CUSTOM_ARGS[@]} -gt 0 ]]; then
  REPORT_ARGS="${CUSTOM_ARGS[*]}"
fi

if [[ "$PUBLISH_ONLY" == "true" ]]; then
  echo "=== Skipping report generation (--publish-only) ==="
else
  echo "=== Generating $SPEC report ==="
  SPEC="$SPEC" node "$REPO_ROOT/src/visualize/report.js" $REPORT_ARGS
fi

if [[ ! -f "$REPORT_FILE" ]]; then
  echo "Error: Report not found at $REPORT_FILE"
  exit 1
fi

echo "=== Publishing $SPEC to gh-pages ==="

# Use a temp clone to avoid worktree conflicts
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

# Migrate legacy layout: bare index.html at root -> vengeance/index.html
if [[ -f index.html && ! -d vengeance && ! -d havoc ]]; then
  echo "Migrating legacy layout: root index.html -> vengeance/index.html"
  mkdir -p vengeance
  git mv index.html vengeance/index.html
fi

# Copy report into spec subdirectory
mkdir -p "$SPEC"
cp "$REPORT_FILE" "$SPEC/index.html"
git add "$SPEC/index.html"

# Generate root landing page by scanning for published spec directories
SPECS=()
for dir in */; do
  dir="${dir%/}"
  [[ "$dir" == .* ]] && continue
  if [[ -f "$dir/index.html" ]]; then
    SPECS+=("$dir")
  fi
done

cat > index.html << 'LANDING_EOF'
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>DH APL Reports</title>
<script>
// Subdomain routing: vengeance.jomdarbert.com -> /vengeance/
(function() {
  var host = location.hostname;
  var parts = host.split('.');
  if (parts.length >= 3) {
    var sub = parts[0];
    if (sub !== 'www' && location.pathname === '/') {
      location.replace('/' + sub + '/');
    }
  }
})();
</script>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #0a0a0f; color: #e0e0e0; min-height: 100vh; display: flex; align-items: center; justify-content: center; }
  .container { text-align: center; padding: 2rem; }
  h1 { font-size: 1.8rem; margin-bottom: 0.5rem; color: #fff; }
  p { color: #888; margin-bottom: 2rem; }
  .specs { display: flex; gap: 1.5rem; justify-content: center; flex-wrap: wrap; }
  a.spec { display: block; padding: 1.5rem 2.5rem; background: #161622; border: 1px solid #2a2a3a; border-radius: 8px; color: #c0c0ff; text-decoration: none; font-size: 1.2rem; text-transform: capitalize; transition: border-color 0.2s, background 0.2s; }
  a.spec:hover { border-color: #6060ff; background: #1a1a2e; }
</style>
</head>
<body>
<div class="container">
<h1>Demon Hunter APL Reports</h1>
<p>Select a spec</p>
<div class="specs">
LANDING_EOF

for s in "${SPECS[@]}"; do
  echo "  <a class=\"spec\" href=\"https://$s.$CNAME_DOMAIN/\">$s</a>" >> index.html
done

cat >> index.html << 'LANDING_EOF'
</div>
</div>
</body>
</html>
LANDING_EOF

git add index.html

# 404.html with subdomain routing (GitHub Pages serves this for missing paths)
cat > 404.html << 'FOUROHFOUR_EOF'
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>DH APL Reports</title>
<script>
(function() {
  var host = location.hostname;
  var parts = host.split('.');
  if (parts.length >= 3) {
    var sub = parts[0];
    if (sub !== 'www') {
      location.replace('/' + sub + '/');
      return;
    }
  }
  location.replace('/');
})();
</script>
</head>
<body></body>
</html>
FOUROHFOUR_EOF
git add 404.html

# Write CNAME
echo "$CNAME_DOMAIN" > CNAME
git add CNAME

TIMESTAMP="$(date -u +"%Y-%m-%d %H:%M UTC")"
git commit -m "Publish $SPEC report - $TIMESTAMP" --quiet --allow-empty

git push origin gh-pages --quiet

echo "=== Pushed to gh-pages ==="

# Clean up
rm -rf "$STAGING"

echo "Done. $SPEC report published to /$SPEC/ on gh-pages."
