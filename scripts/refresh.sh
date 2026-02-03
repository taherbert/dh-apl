#!/bin/bash
# Refresh all external dependencies for VDH APL development.
# Rebuilds SimC binary, syncs reference data, and regenerates all data files.
#
# Usage: npm run refresh
#
# Environment variables (optional):
#   SIMC_DIR      - Path to simc repository (default: /Users/tom/Documents/GitHub/simc)
#   SIMC_BRANCH   - Branch to use (default: midnight)
#   SKIP_BUILD    - Set to 1 to skip simc binary rebuild
#   SKIP_WIKI     - Set to 1 to skip wiki sync

set -euo pipefail

# Configuration
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(dirname "$SCRIPT_DIR")"
SIMC_DIR="${SIMC_DIR:-/Users/tom/Documents/GitHub/simc}"
SIMC_BRANCH="${SIMC_BRANCH:-midnight}"
METADATA_FILE="$ROOT/reference/.refresh-metadata.json"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

info() { echo -e "${GREEN}==>${NC} $1"; }
warn() { echo -e "${YELLOW}Warning:${NC} $1"; }
error() { echo -e "${RED}Error:${NC} $1" >&2; }

# Detect CPU cores (cross-platform)
get_cores() {
  if command -v sysctl &>/dev/null; then
    sysctl -n hw.ncpu 2>/dev/null || echo 4
  elif command -v nproc &>/dev/null; then
    nproc 2>/dev/null || echo 4
  else
    echo 4
  fi
}

# Check prerequisites
check_prerequisites() {
  info "Checking prerequisites..."

  if [ ! -d "$SIMC_DIR" ]; then
    error "SimC directory not found: $SIMC_DIR"
    error "Set SIMC_DIR environment variable to your simc repository path"
    exit 1
  fi

  if [ ! -f "$SIMC_DIR/engine/Makefile" ]; then
    error "SimC Makefile not found. Is $SIMC_DIR a valid simc repository?"
    exit 1
  fi

  # Check for uncommitted changes in simc
  cd "$SIMC_DIR"
  if [ -n "$(git status --porcelain)" ]; then
    warn "SimC repository has uncommitted changes"
    git status --short
    echo ""
    if [ -t 0 ]; then
      read -p "Continue anyway? [y/N] " -n 1 -r
      echo
      if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        exit 1
      fi
    else
      warn "Non-interactive mode, proceeding with uncommitted changes"
    fi
  fi

  cd "$ROOT"
}

# Update and build SimC binary
build_simc() {
  if [ "${SKIP_BUILD:-0}" = "1" ]; then
    info "Skipping SimC build (SKIP_BUILD=1)"
    return
  fi

  info "Updating SimC binary..."
  cd "$SIMC_DIR"

  # Checkout and update branch
  git checkout "$SIMC_BRANCH"
  git pull

  # Build
  CORES=$(get_cores)
  info "Building with $CORES cores..."
  make -C engine -j"$CORES"

  # Copy to project bin
  mkdir -p "$ROOT/bin"
  cp engine/simc "$ROOT/bin/simc"

  # Verify build
  local version
  version=$("$ROOT/bin/simc" spell_query=spell.id=1 2>&1 | head -1)
  info "SimC binary updated: $version"

  cd "$ROOT"
}

# Extract reference APL from C++ source
extract_reference_apl() {
  info "Extracting reference APL from C++ source..."
  node "$ROOT/src/extract/apl-from-cpp.js"
}

# Sync wiki documentation
sync_wiki() {
  if [ "${SKIP_WIKI:-0}" = "1" ]; then
    info "Skipping wiki sync (SKIP_WIKI=1)"
    return
  fi

  info "Syncing SimC wiki documentation..."
  bash "$SCRIPT_DIR/sync-wiki.sh"
}

# Rebuild all data files
build_data() {
  info "Rebuilding data pipeline..."
  cd "$ROOT"
  npm run build-data
}

# Generate SpellDataDump
generate_spelldatadump() {
  info "Generating SpellDataDump..."
  node "$ROOT/src/extract/spelldatadump.js"
}

# Extract SimC C++ references
extract_simc_refs() {
  info "Extracting SimC C++ references..."
  npm run extract-simc
}

# Run verification
verify() {
  info "Running verification..."
  npm run verify
}

# Record metadata about this refresh
record_metadata() {
  info "Recording refresh metadata..."

  cd "$SIMC_DIR"
  local simc_commit simc_branch simc_date
  simc_commit=$(git rev-parse HEAD)
  simc_branch=$(git branch --show-current)
  simc_date=$(git log -1 --format=%ci)

  cd "$ROOT"
  local timestamp data_env
  timestamp=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
  data_env=$(node -e "import('./src/config.js').then(c => console.log(c.DATA_ENV))")

  cat > "$METADATA_FILE" << EOF
{
  "refreshed_at": "$timestamp",
  "data_env": "$data_env",
  "simc": {
    "commit": "$simc_commit",
    "branch": "$simc_branch",
    "commit_date": "$simc_date"
  }
}
EOF

  info "Metadata saved to reference/.refresh-metadata.json"
  echo "  SimC commit: ${simc_commit:0:8} ($simc_branch)"
  echo "  Data env: $data_env"
}

# Print summary
print_summary() {
  echo ""
  info "Refresh complete!"
  echo ""
  echo "Updated:"
  echo "  - SimC binary (bin/simc)"
  echo "  - Reference APL (reference/vengeance-apl.simc)"
  echo "  - Wiki docs (reference/wiki/)"
  echo "  - SpellDataDump (reference/spelldatadump-vdh.txt)"
  echo "  - Data files (data/*.json)"
  echo "  - C++ references (reference/simc-talent-variables.json)"
  echo ""
  echo "Next steps:"
  echo "  - Review changes: git diff"
  echo "  - Check iteration state: npm run iterate:status"
}

# Main execution
main() {
  echo "=========================================="
  echo "  VDH APL Data Refresh"
  echo "=========================================="
  echo ""

  check_prerequisites
  build_simc
  extract_reference_apl
  sync_wiki
  build_data
  generate_spelldatadump
  extract_simc_refs
  verify
  record_metadata
  print_summary
}

main "$@"
