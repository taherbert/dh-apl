// Shared spec adapter utilities.
// Reusable logic that operates on any spec's config data.
// Spec files provide data; this module provides the algorithms.

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { decodeAllTalents } from "../util/talent-fingerprint.js";

/**
 * Merges spells-summary.json with spec domain overrides to produce ability data.
 * @param {Record<string, number>} spellIds — ability name → spell ID
 * @param {Record<string, Object>} domainOverrides — mechanical values not in spell data
 * @param {Object} resources — { primary: {name, cap}, secondary?: {name, cap} }
 * @param {string} dataDir — path to data/ directory
 * @returns {Readonly<Record<string, Object>>}
 */
export function buildAbilityData(
  spellIds,
  domainOverrides,
  resources,
  dataDir,
) {
  const spellsPath = join(dataDir, "spells-summary.json");

  if (!existsSync(spellsPath)) {
    return Object.freeze({ ...domainOverrides });
  }

  const spells = JSON.parse(readFileSync(spellsPath, "utf-8"));
  const byId = new Map(spells.map((s) => [s.id, s]));

  // Build resource patterns dynamically from spec config
  const resourcePatterns = [];
  if (resources) {
    for (const res of Object.values(resources)) {
      const pattern = new RegExp(
        `(\\d+)\\s*${res.name.replace(/_/g, "\\s*")}`,
        "i",
      );
      resourcePatterns.push({
        name: res.name,
        pattern,
        field: `${res.name}Cost`,
      });
    }
  }

  const result = {};

  for (const [name, spellId] of Object.entries(spellIds)) {
    const spell = byId.get(spellId);
    if (!spell) {
      result[name] = { ...(domainOverrides[name] || {}) };
      continue;
    }

    const entry = {};

    if (spell.charges) {
      if (spell.charges.count > 1) {
        entry.charges = spell.charges.count;
        entry.rechargeCd = spell.charges.cooldown;
        entry.cooldown = 0;
      } else {
        entry.cooldown = spell.charges.cooldown;
      }
    } else if (spell.cooldown) {
      entry.cooldown = spell.cooldown;
    } else {
      entry.cooldown = 0;
    }

    if (spell.duration) entry.duration = spell.duration;
    if (spell.gcd !== undefined) entry.gcd = spell.gcd > 0;

    // Parse resource costs dynamically
    if (spell.resource) {
      for (const { name: resName, pattern, field } of resourcePatterns) {
        const match = spell.resource.match(pattern);
        if (match) entry[field] = parseInt(match[1], 10);
      }
    }

    // Parse resource generation dynamically
    if (spell.generates) {
      for (const gen of spell.generates) {
        for (const { name: resName, pattern } of resourcePatterns) {
          const match = gen.match(pattern);
          if (match) {
            const genField =
              resName === "soul_fragments" ? "fragGen" : `${resName}Gen`;
            entry[genField] = parseInt(match[1], 10);
          }
        }
      }
    }

    Object.assign(entry, domainOverrides[name] || {});
    result[name] = entry;
  }

  return Object.freeze(result);
}

/**
 * Keyword-based hero tree detection from profile/APL text.
 * @param {Record<string, { profileKeywords: string[] }>} heroTrees
 * @param {string} text — profile name or APL text
 * @returns {string|null} tree ID or null
 */
export function matchHeroTreeFromText(heroTrees, text) {
  for (const [treeId, treeConfig] of Object.entries(heroTrees)) {
    for (const keyword of treeConfig.profileKeywords) {
      if (text.toLowerCase().includes(keyword)) {
        return treeId;
      }
    }
  }
  return null;
}

/**
 * Buff-uptime hero tree detection from sim results.
 * @param {Record<string, { keyBuffs: string[] }>} heroTrees
 * @param {Object|Array} workflowResults — sim workflow output
 * @returns {string|null} tree ID or null
 */
export function matchHeroTreeFromBuffs(heroTrees, workflowResults) {
  const scenarios = Array.isArray(workflowResults)
    ? workflowResults
    : workflowResults.scenarios || [];

  for (const scenario of scenarios) {
    if (scenario.error) continue;

    for (const [treeId, treeConfig] of Object.entries(heroTrees)) {
      const hasTreeBuff = treeConfig.keyBuffs.some((buff) => {
        const uptime =
          scenario.buffUptimes?.[buff] ??
          scenario.buffs?.find((b) => b.name === buff)?.uptime;
        return uptime !== undefined && uptime > 0;
      });

      if (hasTreeBuff) return treeId;
    }
  }

  return null;
}

/**
 * Creates a lazy cache with get(builder)/clear() methods.
 * @returns {{ get: (builder: () => T) => T, clear: () => void }}
 */
export function createCache() {
  let cached = null;
  return {
    get(builder) {
      if (!cached) cached = builder();
      return cached;
    },
    clear() {
      cached = null;
    },
  };
}

// ================================================================
// Derivation functions — generate mechanical exports from SPEC_CONFIG
// ================================================================

/**
 * Derives the simc spell_query class filter from cppClassName.
 * Uses cppClassName ("demon_hunter") since className ("demonhunter") lacks word boundaries.
 */
export function deriveClassSpellQuery(config) {
  return `spell.class=${config.cppClassName}`;
}

/**
 * Derives C++ struct patterns from cppClassName.
 * "demon_hunter" → { player: "demon_hunter_t", targetData: "demon_hunter_td_t" }
 */
export function deriveCppStructPatterns(config) {
  return {
    player: `${config.cppClassName}_t`,
    targetData: `${config.cppClassName}_td_t`,
  };
}

/**
 * Derives a spec spell filter predicate from display names.
 * Matches spells named "Vengeance Demon Hunter".
 */
export function deriveSpecSpellFilter(config) {
  const fullName = `${config.displayNames.spec} ${config.displayNames.class}`;
  return (spell) => (spell.name || "") === fullName;
}

/**
 * Derives talent tree regex pattern from specId, cppClassName, and hero tree keys.
 * Matches C++ references like talent.vengeance.X, talent.demon_hunter.X, etc.
 */
export function deriveTalentTreePattern(config) {
  const trees = [
    config.specId,
    config.cppClassName,
    ...Object.keys(config.heroTrees),
  ];
  return new RegExp(`talent\\.(${trees.join("|")})\\.(\\w+)`, "g");
}

/**
 * Derives key spell ID list from spellIds config.
 * Returns [[id, "Display Name"], ...] pairs.
 */
export function deriveKeySpellIds(config) {
  return Object.entries(config.spellIds).map(([name, id]) => {
    const display = name
      .replace(/_/g, " ")
      .replace(/\b\w/g, (c) => c.toUpperCase());
    return [id, display];
  });
}

// ================================================================
// Build/roster utilities — shared across all specs
// ================================================================

/**
 * Flatten scenario-grouped archetypes into a single name->config map.
 * Used by CLI tools (optimal-timeline, divergence, apl-interpreter) that take --build.
 */
export function flattenArchetypes(archetypes) {
  const flat = {};
  for (const [scenario, builds] of Object.entries(archetypes)) {
    if (typeof builds !== "object") continue;
    if (builds.heroTree !== undefined) {
      flat[scenario] = builds;
    } else {
      for (const [name, config] of Object.entries(builds)) {
        flat[name] = { ...config, _scenario: scenario };
      }
    }
  }
  return flat;
}

/**
 * Convert a roster DB row into a state-sim-compatible buildConfig.
 * Decodes the talent hash to derive talent flags.
 */
export function rosterBuildToConfig(dbRow) {
  const { hash, hero_tree, archetype } = dbRow;
  const { specTalents, heroTalents } = decodeAllTalents(hash);

  const talents = {};
  for (const name of [...specTalents, ...heroTalents]) {
    const key = name.toLowerCase().replace(/['']/g, "").replace(/\s+/g, "_");
    talents[key] = true;
  }

  const apexMatch = archetype?.match(/Apex\s+(\d+)/i);
  const apexRank = apexMatch ? parseInt(apexMatch[1], 10) : 0;

  return {
    heroTree: hero_tree,
    apexRank,
    haste: 0.2,
    talents,
    _rosterHash: hash,
    _name: dbRow.name || `${hero_tree}-apex${apexRank}`,
  };
}

/**
 * Select representative builds covering distinct (heroTree x apexRank) axes.
 * Returns one build per combo (first match wins).
 */
function selectRepresentativeBuilds(configs) {
  const seen = new Set();
  const reps = [];
  for (const cfg of configs) {
    const key = `${cfg.heroTree}|${cfg.apexRank}`;
    if (!seen.has(key)) {
      seen.add(key);
      reps.push(cfg);
    }
  }
  return reps;
}

/**
 * Build scenario-grouped analysis configs from roster builds + SPEC_CONFIG scenarios.
 * Returns the same structure as analysisArchetypes for drop-in compatibility.
 */
export function buildAnalysisFromRoster(rosterBuilds, specConfig) {
  const scenarios = specConfig.scenarios;
  if (!scenarios || rosterBuilds.length === 0) return null;

  const allConfigs = rosterBuilds.map((b) => rosterBuildToConfig(b));
  const reps = selectRepresentativeBuilds(allConfigs);
  const result = {};

  for (const [scenarioName, scenarioCfg] of Object.entries(scenarios)) {
    result[scenarioName] = {};
    for (const cfg of reps) {
      const suffix =
        scenarioCfg.target_count > 1 ? `-${scenarioCfg.target_count}t` : "";
      const key = `${cfg._name}${suffix}`;
      result[scenarioName][key] = {
        ...cfg,
        target_count: scenarioCfg.target_count,
      };
    }
  }

  return result;
}
