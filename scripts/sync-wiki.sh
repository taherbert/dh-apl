#!/bin/bash
# Sync SimC wiki documentation to reference/wiki/
# Clones or pulls the simc wiki and copies relevant pages.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(dirname "$SCRIPT_DIR")"
WIKI_CACHE="/tmp/claude/simc-wiki"
WIKI_REPO="https://github.com/simulationcraft/simc.wiki.git"
WIKI_OUTPUT="$ROOT/reference/wiki"

# Pages relevant to APL development (source:destination)
WIKI_PAGES=(
  "ActionLists.md:action-lists.md"
  "Action-List-Conditional-Expressions.md:action-list-expressions.md"
  "Demon-Hunters.md:demon-hunters.md"
  "TextualConfigurationInterface.md:textual-config.md"
  "Options.md:options.md"
  "Equipment.md:equipment.md"
  "Output.md:output.md"
  "SpellQuery.md:spell-query.md"
  "SpellData.md:spell-data.md"
  "StatisticalBehaviour.md:statistical-behaviour.md"
  "ProfileSet.md:profile-sets.md"
  "Coded_flags.md:coded-flags.md"
  "DevelopersDocumentation.md:developer-docs.md"
  "FightingVariance.md:fighting-variance.md"
  "FormulationVsSimulation.md:formulation-vs-simulation.md"
  "HowToBuild.md:how-to-build.md"
  "StatsScaling.md:stats-scaling.md"
  "BuffsAndDebuffs.md:buffs-and-debuffs.md"
  "RaidEvents.md:raid-events.md"
  "Characters.md:characters.md"
  "Enemies.md:enemies.md"
  "ExpansionOptions.md:expansion-options.md"
  "SimcForTanks.md:simc-for-tanks.md"
  "TargetOptions.md:target-options.md"
)

echo "=== Syncing SimC Wiki ==="

# Clone or update wiki repo
if [ -d "$WIKI_CACHE" ]; then
  echo "Updating wiki cache..."
  cd "$WIKI_CACHE"
  git fetch origin
  git reset --hard origin/master
else
  echo "Cloning wiki..."
  mkdir -p "$(dirname "$WIKI_CACHE")"
  git clone --depth 1 "$WIKI_REPO" "$WIKI_CACHE"
fi

cd "$WIKI_CACHE"
WIKI_COMMIT=$(git rev-parse --short HEAD)
echo "Wiki commit: $WIKI_COMMIT"

# Ensure output directory exists
mkdir -p "$WIKI_OUTPUT"

# Copy relevant pages
copied=0
for mapping in "${WIKI_PAGES[@]}"; do
  src="${mapping%%:*}"
  dst="${mapping##*:}"

  if [ -f "$src" ]; then
    # Add source attribution header, skip original title if first line is a heading
    {
      echo "# ${dst%.md}"
      echo ""
      echo "Source: https://github.com/simulationcraft/simc/wiki/${src%.md}"
      echo ""
      first_line=$(head -1 "$src")
      if [[ "$first_line" =~ ^#\  ]]; then
        tail -n +2 "$src"
      else
        cat "$src"
      fi
    } > "$WIKI_OUTPUT/$dst"
    ((copied++))
  else
    echo "Warning: $src not found in wiki"
  fi
done

echo "Copied $copied wiki pages to $WIKI_OUTPUT"
echo "Wiki sync complete"
