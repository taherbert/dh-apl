#!/bin/bash
# Refresh all external dependencies: rebuild SimC binary, fetch data, rebuild everything.
# Usage: npm run refresh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(dirname "$SCRIPT_DIR")"
SIMC_DIR="/Users/tom/Documents/GitHub/simc"
SIMC_BRANCH="midnight"

echo "=== Refreshing SimC binary ==="
cd "$SIMC_DIR"
git checkout "$SIMC_BRANCH"
git pull
CORES=$(sysctl -n hw.ncpu 2>/dev/null || nproc 2>/dev/null || echo 4)
make -C engine -j"$CORES"
mkdir -p "$ROOT/bin"
cp engine/simc "$ROOT/bin/simc"
echo "SimC binary updated: $(./engine/simc spell_query=spell.1 2>&1 | head -1)"

echo ""
echo "=== Refreshing data ==="
cd "$ROOT"
npm run build-data

echo ""
echo "=== Extracting SimC references ==="
npm run extract-simc

echo ""
echo "=== Verifying ==="
npm run verify

echo ""
echo "=== Refresh complete ==="
