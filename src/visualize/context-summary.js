// Generates condensed JSON summaries of spells and interactions for
// context-efficient loading by LLM analysis sessions. Strips verbose
// fields (raw effects, effect details, family flags, attributes) while
// keeping everything needed for APL reasoning.

import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, "..", "..", "data");

function summarizeSpells(spells) {
  return spells.map((s) => {
    const entry = { id: s.id, name: s.name };
    if (s.school) entry.school = s.school;
    if (s.passive) entry.passive = true;
    if (s.resource) entry.resource = s.resource.cost + " " + s.resource.type;
    if (s.gcd != null) entry.gcd = s.gcd;
    if (s.cooldown) entry.cooldown = s.cooldown;
    if (s.charges) entry.charges = s.charges;
    if (s.duration) entry.duration = s.duration;
    if (s.aoe?.radius) entry.aoeRadius = s.aoe.radius;
    if (s.generates?.length) {
      entry.generates = s.generates.map((g) => g.amount + " " + g.resourceType);
    }
    if (s.categoryCooldown) entry.categoryCooldown = s.categoryCooldown;
    // Prefer resolved description, fall back to raw
    const desc = s.resolvedDescription || s.description;
    if (desc) entry.description = desc.replace(/\n/g, " ");
    return entry;
  });
}

function summarizeInteractions(data) {
  // Keep byTalent and bySpell views but strip effectDetails
  const bySpell = {};
  for (const [id, entry] of Object.entries(data.bySpell)) {
    bySpell[id] = {
      name: entry.name,
      modifiers: entry.modifiers.map((m) => {
        const slim = {
          source: m.source,
          type: m.type,
        };
        if (m.tree) slim.tree = m.tree;
        if (m.heroSpec) slim.heroSpec = m.heroSpec;
        if (m.magnitude) slim.magnitude = m.magnitude;
        if (m.procInfo) slim.procInfo = m.procInfo;
        if (m.application) slim.application = m.application;
        if (m.theoreticalUptime != null)
          slim.theoreticalUptime = m.theoreticalUptime;
        return slim;
      }),
    };
  }

  const byTalent = {};
  for (const [id, entry] of Object.entries(data.byTalent)) {
    byTalent[id] = {
      name: entry.name,
      tree: entry.tree,
      heroSpec: entry.heroSpec || undefined,
      targets: entry.targets.map((t) => {
        const slim = {
          spell: t.spell,
          type: t.type,
        };
        if (t.magnitude) slim.magnitude = t.magnitude;
        if (t.procInfo) slim.procInfo = t.procInfo;
        if (t.theoreticalUptime != null)
          slim.theoreticalUptime = t.theoreticalUptime;
        return slim;
      }),
    };
  }

  return {
    bySpell,
    byTalent,
    talentCategories: data.talentCategories,
    bySetBonus: data.bySetBonus,
  };
}

function generate() {
  const spells = JSON.parse(
    readFileSync(join(DATA_DIR, "spells.json"), "utf-8"),
  );
  const interactions = JSON.parse(
    readFileSync(join(DATA_DIR, "interactions.json"), "utf-8"),
  );

  const spellsSummary = summarizeSpells(spells);
  const interactionsSummary = summarizeInteractions(interactions);

  const spellsOut = join(DATA_DIR, "spells-summary.json");
  const interactionsOut = join(DATA_DIR, "interactions-summary.json");

  writeFileSync(spellsOut, JSON.stringify(spellsSummary, null, 2));
  writeFileSync(interactionsOut, JSON.stringify(interactionsSummary, null, 2));

  const spellsSize = (JSON.stringify(spellsSummary).length / 1024).toFixed(0);
  const ixSize = (JSON.stringify(interactionsSummary).length / 1024).toFixed(0);
  const origSpells = (
    readFileSync(join(DATA_DIR, "spells.json"), "utf-8").length / 1024
  ).toFixed(0);
  const origIx = (
    readFileSync(join(DATA_DIR, "interactions.json"), "utf-8").length / 1024
  ).toFixed(0);

  console.log(
    `Wrote spells-summary.json (${spellsSize}KB, was ${origSpells}KB)`,
  );
  console.log(`Wrote interactions-summary.json (${ixSize}KB, was ${origIx}KB)`);
}

generate();
