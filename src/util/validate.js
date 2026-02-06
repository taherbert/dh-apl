// Data file validation and staleness detection.
// Validates required fields and checks freshness against simc commit.

import { readFileSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { checkSync } from "../engine/startup.js";
import { dataFile, REFERENCE_DIR } from "../engine/paths.js";

// Schema definitions: filename → required type or validator
const SCHEMAS = {
  "spells.json": {
    type: "array",
    minLength: 50,
    itemFields: ["id", "name"],
  },
  "talents.json": {
    type: "object",
    requiredKeys: ["class", "spec"],
  },
  "raidbots-talents.json": {
    type: "object",
    requiredKeys: ["classNodes", "specNodes", "heroNodes"],
  },
  "interactions.json": {
    type: "object",
    requiredKeys: ["bySpell"],
  },
  "interactions-summary.json": {
    type: "object",
    requiredKeys: ["bySpell", "byTalent"],
  },
  "cpp-interactions.json": {
    type: "object",
    requiredKeys: ["talentAbility", "talentTalent"],
  },
  "cpp-effects-inventory.json": {
    type: "object",
    requiredKeys: ["parseEffects", "compositeOverrides"],
  },
  "cpp-proc-mechanics.json": {
    type: "object",
  },
  "build-theory.json": {
    type: "object",
  },
};

function validateFile(filename) {
  const absPath = dataFile(filename);
  const schema = SCHEMAS[filename];

  if (!existsSync(absPath)) {
    return { valid: false, error: "file not found" };
  }

  let data;
  try {
    data = JSON.parse(readFileSync(absPath, "utf-8"));
  } catch (e) {
    return { valid: false, error: `parse error: ${e.message}` };
  }

  if (!schema) {
    return { valid: true, warning: "no schema defined" };
  }

  if (schema.type === "array") {
    if (!Array.isArray(data)) {
      return { valid: false, error: "expected array" };
    }
    if (schema.minLength && data.length < schema.minLength) {
      return {
        valid: false,
        error: `expected at least ${schema.minLength} items, got ${data.length}`,
      };
    }
    if (schema.itemFields && data.length > 0) {
      const missing = schema.itemFields.filter((f) => !(f in data[0]));
      if (missing.length > 0) {
        return {
          valid: false,
          error: `first item missing fields: ${missing.join(", ")}`,
        };
      }
    }
  }

  if (schema.type === "object") {
    if (typeof data !== "object" || data === null || Array.isArray(data)) {
      return { valid: false, error: "expected object" };
    }
    if (schema.requiredKeys) {
      const missing = schema.requiredKeys.filter((k) => !(k in data));
      if (missing.length > 0) {
        return {
          valid: false,
          error: `missing required keys: ${missing.join(", ")}`,
        };
      }
    }
  }

  return { valid: true };
}

export function validateAll() {
  const results = {};
  for (const relPath of Object.keys(SCHEMAS)) {
    results[relPath] = validateFile(relPath);
  }
  return results;
}

// Staleness: compare data file mtimes against simc HEAD
export function checkStaleness() {
  const sync = checkSync();
  const metaPath = join(REFERENCE_DIR, ".refresh-metadata.json");

  let lastBuildTime = null;
  if (existsSync(metaPath)) {
    try {
      const meta = JSON.parse(readFileSync(metaPath, "utf-8"));
      lastBuildTime = meta.timestamp
        ? new Date(meta.timestamp)
        : statSync(metaPath).mtime;
    } catch {
      // ignore
    }
  }

  const staleFiles = [];
  for (const filename of Object.keys(SCHEMAS)) {
    const absPath = dataFile(filename);
    if (!existsSync(absPath)) {
      staleFiles.push({ file: filename, reason: "missing" });
      continue;
    }

    const mtime = statSync(absPath).mtime;

    // If data file is older than last build metadata, it's stale
    if (lastBuildTime && mtime < lastBuildTime) {
      staleFiles.push({
        file: filename,
        reason: `older than last build (${lastBuildTime.toISOString().slice(0, 10)})`,
      });
    }
  }

  return {
    synced: sync.synced,
    syncReason: sync.reason,
    staleFiles,
    lastBuildTime: lastBuildTime?.toISOString() || null,
    allFresh: staleFiles.length === 0 && sync.synced,
  };
}

// CLI
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  console.log("=== Data Validation ===\n");

  const validation = validateAll();
  let allValid = true;
  for (const [file, result] of Object.entries(validation)) {
    const icon = result.valid ? "OK" : "FAIL";
    const detail = result.error || result.warning || "";
    console.log(`  ${icon}  ${file}${detail ? "  — " + detail : ""}`);
    if (!result.valid) allValid = false;
  }

  console.log("\n=== Staleness Check ===\n");

  const staleness = checkStaleness();
  console.log(
    `  SimC sync: ${staleness.synced ? "up to date" : staleness.syncReason}`,
  );
  console.log(`  Last build: ${staleness.lastBuildTime || "unknown"}`);

  if (staleness.staleFiles.length > 0) {
    console.log(`\n  Stale files:`);
    for (const f of staleness.staleFiles) {
      console.log(`    ${f.file} — ${f.reason}`);
    }
  } else {
    console.log(`  All data files fresh.`);
  }

  if (!allValid || !staleness.allFresh) {
    console.log("\nRun `npm run build-data` to refresh.");
    process.exit(1);
  }
}

export { validateFile, SCHEMAS };
