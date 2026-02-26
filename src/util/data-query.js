// CLI data query tool — targeted lookups into data files.
//
// Usage:
//   npm run data:query -- spell <name-or-id>
//   npm run data:query -- talent <name-or-id>
//   npm run data:query -- interaction <spell-name-or-id>
//   npm run data:query -- search <term>

import { readFileSync } from "node:fs";
import { parseSpecArg } from "./parse-spec-arg.js";
import { initSpec } from "../engine/startup.js";
import { dataFile } from "../engine/paths.js";

await initSpec(parseSpecArg());

// Strip --spec and its value from argv before extracting command
const argv = process.argv.slice(2);
const filtered = argv.filter(
  (a, i) => a !== "--spec" && argv[i - 1] !== "--spec",
);
const [cmd, ...rest] = filtered;
const query = rest.join(" ").toLowerCase().trim();

if (!cmd || !query) {
  console.error(`Usage:
  npm run data:query -- spell <name-or-id>
  npm run data:query -- talent <name-or-id>
  npm run data:query -- interaction <spell-name-or-id>
  npm run data:query -- search <term>`);
  process.exit(1);
}

function loadJSON(filename) {
  return JSON.parse(readFileSync(dataFile(filename), "utf-8"));
}

function fuzzyMatch(text, q) {
  if (!text) return 0;
  const lower = text.toLowerCase();
  if (lower === q) return 2;
  if (lower.includes(q)) return 1;
  return 0;
}

function formatOutput(label, results) {
  if (!results || (Array.isArray(results) && results.length === 0)) {
    console.log(`No results for "${query}"`);
    return;
  }
  console.log(`--- ${label} ---`);
  console.log(JSON.stringify(results, null, 2));
}

function collectTalents(talents) {
  const all = [];
  if (talents.class?.talents) all.push(...talents.class.talents);
  if (talents.spec?.talents) all.push(...talents.spec.talents);
  if (talents.hero) {
    for (const tree of Object.values(talents.hero)) {
      if (tree.talents) all.push(...tree.talents);
    }
  }
  return all;
}

switch (cmd) {
  case "spell": {
    const spells = loadJSON("spells-summary.json");
    const idNum = parseInt(query, 10);

    let matches;
    if (!isNaN(idNum)) {
      matches = spells.filter((s) => s.id === idNum);
    } else {
      matches = spells
        .map((s) => ({ ...s, _score: fuzzyMatch(s.name, query) }))
        .filter((s) => s._score > 0)
        .sort((a, b) => b._score - a._score)
        .map(({ _score, ...s }) => s);
    }
    formatOutput(`Spells matching "${query}"`, matches.slice(0, 10));
    if (matches.length > 10) console.log(`... and ${matches.length - 10} more`);
    break;
  }

  case "talent": {
    const talents = loadJSON("talents.json");
    const idNum = parseInt(query, 10);
    const allTalents = collectTalents(talents);

    let matches;
    if (!isNaN(idNum)) {
      matches = allTalents.filter(
        (t) =>
          t.nodeId === idNum ||
          t.entryId === idNum ||
          t.spellId === idNum ||
          t.definitionId === idNum,
      );
    } else {
      matches = allTalents
        .map((t) => ({
          ...t,
          _score: Math.max(
            fuzzyMatch(t.name, query),
            fuzzyMatch(t.spellName, query),
          ),
        }))
        .filter((t) => t._score > 0)
        .sort((a, b) => b._score - a._score)
        .map(({ _score, ...t }) => t);
    }
    formatOutput(`Talents matching "${query}"`, matches.slice(0, 10));
    if (matches.length > 10) console.log(`... and ${matches.length - 10} more`);
    break;
  }

  case "interaction": {
    const interactions = loadJSON("interactions-summary.json");
    const spells = loadJSON("spells-summary.json");
    const idNum = parseInt(query, 10);

    // Find matching spell IDs — interactions are keyed by spell ID strings
    const matchingIds = new Set();
    if (!isNaN(idNum)) {
      matchingIds.add(String(idNum));
    } else {
      for (const s of spells) {
        if (fuzzyMatch(s.name, query) > 0) {
          matchingIds.add(String(s.id));
        }
      }
    }

    const results = {};
    for (const id of matchingIds) {
      if (interactions.bySpell?.[id]) {
        const entry = interactions.bySpell[id];
        results[`${entry.name || id} (${id})`] = entry;
      }
    }

    // Also search byTalent
    if (interactions.byTalent) {
      const talentMatches = {};
      for (const [id, data] of Object.entries(interactions.byTalent)) {
        if (
          fuzzyMatch(data.name, query) > 0 ||
          (!isNaN(idNum) && id === String(idNum))
        ) {
          talentMatches[`${data.name || id} (${id})`] = data;
        }
      }
      if (Object.keys(talentMatches).length > 0) {
        results._talentInteractions = talentMatches;
      }
    }

    if (Object.keys(results).length === 0) {
      formatOutput(`Interactions for "${query}"`, []);
    } else {
      formatOutput(`Interactions for "${query}"`, results);
    }
    break;
  }

  case "search": {
    const spells = loadJSON("spells-summary.json");
    const talents = loadJSON("talents.json");

    const spellMatches = spells
      .filter((s) => {
        const text =
          `${s.name} ${s.description || ""} ${s.school || ""}`.toLowerCase();
        return text.includes(query);
      })
      .slice(0, 5)
      .map(({ id, name, cooldown, resource, description }) => ({
        id,
        name,
        cooldown,
        resource,
        description,
      }));

    const allTalents = collectTalents(talents);
    const talentMatches = allTalents
      .filter((t) => {
        const text =
          `${t.name} ${t.spellName || ""} ${t.description || ""}`.toLowerCase();
        return text.includes(query);
      })
      .slice(0, 5)
      .map(({ nodeId, name, spellId, type, description }) => ({
        nodeId,
        name,
        spellId,
        type,
        description: description?.slice(0, 150),
      }));

    if (spellMatches.length) formatOutput("Spells", spellMatches);
    if (talentMatches.length) formatOutput("Talents", talentMatches);
    if (!spellMatches.length && !talentMatches.length) {
      console.log(`No results for "${query}"`);
    }
    break;
  }

  default:
    console.error(
      `Unknown command: ${cmd}. Use: spell, talent, interaction, search`,
    );
    process.exit(1);
}
