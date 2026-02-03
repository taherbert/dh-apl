import { readFileSync, writeFileSync } from "fs";

const spells = JSON.parse(readFileSync("data/spells.json", "utf-8"));
const interactions = JSON.parse(
  readFileSync("data/interactions.json", "utf-8"),
);

// Collect all spell IDs referenced in interactions
const referencedIds = new Set();

for (const i of interactions.interactions) {
  referencedIds.add(i.source.id);
  referencedIds.add(i.target.id);
}

for (const [id, entry] of Object.entries(interactions.byTalent)) {
  referencedIds.add(parseInt(id));
  for (const target of entry.targets || []) {
    referencedIds.add(target.spellId);
  }
}

for (const [id, entry] of Object.entries(interactions.bySpell)) {
  referencedIds.add(parseInt(id));
  for (const mod of entry.modifiers || []) {
    if (mod.sourceId) referencedIds.add(mod.sourceId);
  }
}

const unreferenced = spells.filter(function (s) {
  return !referencedIds.has(s.id);
});

console.log("Total spells:", spells.length);
console.log("Referenced spell IDs:", referencedIds.size);
console.log("Unreferenced spells:", unreferenced.length);
console.log("");

// Categorize unreferenced spells
const categories = {
  passive_mastery: [],
  internal_variant: [],
  utility: [],
  movement: [],
  buff_only: [],
  proc_triggered: [],
  uncategorized: [],
};

function categorizeSpell(spell) {
  const name = spell.name.toLowerCase();

  if (name.includes("mastery")) {
    return "passive_mastery";
  }
  if (spell.passive && !spell.talentEntry) {
    return "proc_triggered";
  }
  if (
    name.includes("imprison") ||
    name.includes("darkness") ||
    name.includes("consume magic")
  ) {
    return "utility";
  }
  if (name.includes("infernal strike") || name.includes("vengeful retreat")) {
    return "movement";
  }
  if (
    spell.effects?.some(function (e) {
      return e.type?.includes("Apply Aura");
    }) &&
    !spell.effects?.some(function (e) {
      return e.type?.includes("Damage");
    })
  ) {
    return "buff_only";
  }
  return "uncategorized";
}

for (const spell of unreferenced) {
  categories[categorizeSpell(spell)].push(spell);
}

console.log("Categories:");
for (const [cat, items] of Object.entries(categories)) {
  if (items.length > 0) {
    console.log(`  ${cat}: ${items.length}`);
  }
}

console.log("\nUncategorized spells:");
categories.uncategorized.slice(0, 50).forEach(function (s) {
  console.log(
    `  - ${s.name} (${s.id}) - ${s.talentEntry ? "talent" : "non-talent"}`,
  );
});
if (categories.uncategorized.length > 50) {
  console.log(`  ... and ${categories.uncategorized.length - 50} more`);
}

// Generate markdown report
function formatSpellList(spellList) {
  if (spellList.length === 0) return "_None_";
  return spellList
    .map(function (s) {
      return `- ${s.name} (${s.id})`;
    })
    .join("\n");
}

function formatUncategorizedSpell(s) {
  const desc = (s.resolvedDescription || s.description || "").slice(0, 150);
  return `### ${s.name} (${s.id})
- **Talent:** ${s.talentEntry ? "Yes" : "No"}
- **Passive:** ${s.passive}
- **Description:** ${desc}${desc.length >= 150 ? "..." : ""}
`;
}

const report = `# Unreferenced Spell Audit

Generated: ${new Date().toISOString()}

## Summary

- **Total spells:** ${spells.length}
- **Referenced spell IDs:** ${referencedIds.size}
- **Unreferenced spells:** ${unreferenced.length}

## Categories

| Category | Count | Status |
|----------|-------|--------|
| Passive/Mastery | ${categories.passive_mastery.length} | Expected |
| Utility | ${categories.utility.length} | Expected |
| Movement | ${categories.movement.length} | Expected |
| Buff-only | ${categories.buff_only.length} | Expected |
| Proc/Triggered | ${categories.proc_triggered.length} | Expected |
| Uncategorized | ${categories.uncategorized.length} | Review |

## Expected Gaps (No Action Needed)

These spells don't require damage/resource interactions:

### Passive/Mastery
${formatSpellList(categories.passive_mastery)}

### Utility
${formatSpellList(categories.utility)}

### Movement
${formatSpellList(categories.movement)}

### Buff-only (Defensive/Aura)
${formatSpellList(categories.buff_only)}

### Proc/Triggered (Internal)
${formatSpellList(categories.proc_triggered)}

## Uncategorized (Potential Issues)

These spells may need review:

${categories.uncategorized.map(formatUncategorizedSpell).join("\n") || "_None_"}
`;

writeFileSync("results/unreferenced-spell-audit.md", report);
console.log("\nWrote results/unreferenced-spell-audit.md");
