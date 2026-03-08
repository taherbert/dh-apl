# Roster Cleanup and Pipeline Hardening

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Eliminate stale build data from the DB and harden the pipeline so old/orphaned builds can never contaminate reports again.

**Architecture:** Three layers of change: (1) `generate()` deletes non-community builds before creating new ones, (2) community builds get proper source labels in their archetype, (3) `loadReportData()` refuses to use stale DB DPS as a fallback. The publish script was already fixed (no more default `--skip-sims`).

**Tech Stack:** Node.js ESM, SQLite (better-sqlite3 via `src/util/db.js`)

---

### Task 1: Add `purgeNonCommunityBuilds()` to db.js

**Files:**

- Modify: `src/util/db.js`

**Step 1: Add the purge function**

Add after `clearAllRosterMembership()` (~line 1016):

```javascript
export function purgeNonCommunityBuilds(s) {
  const db = getDb();
  const result = db
    .prepare(
      "DELETE FROM builds WHERE spec = ? AND source NOT LIKE 'community:%' AND pinned = 0",
    )
    .run(s || spec());
  return result.changes;
}
```

**Step 2: Add a function to clear all DPS columns for a spec**

Add right after the purge function:

```javascript
export function clearAllBuildDps(s) {
  const db = getDb();
  const result = db
    .prepare(
      `
    UPDATE builds SET
      dps_st = NULL, dps_dungeon_route = NULL, dps_small_aoe = NULL, dps_big_aoe = NULL, weighted = NULL,
      simc_dps_st = NULL, simc_dps_dungeon_route = NULL, simc_dps_small_aoe = NULL, simc_dps_big_aoe = NULL, simc_weighted = NULL,
      last_tested_at = NULL
    WHERE spec = ?
  `,
    )
    .run(s || spec());
  return result.changes;
}
```

**Step 3: Verify**

Run: `grep -n "purgeNonCommunity\|clearAllBuildDps" src/util/db.js`
Expected: Both functions present.

**Step 4: Commit**

```
feat: add purgeNonCommunityBuilds and clearAllBuildDps to db.js
```

---

### Task 2: Rewrite `generate()` to purge old builds and reorder phases

**Files:**

- Modify: `src/sim/build-roster.js`

**Step 1: Add imports**

Add `purgeNonCommunityBuilds` and `clearAllBuildDps` to the import block from `../util/db.js` (around line 55).

**Step 2: Rewrite `generate()` (lines 576-658)**

Replace the entire function body with:

```javascript
export function generate() {
  console.log("=== Generating Build Roster ===\n");

  const archetypes = getArchetypes();

  withTransaction(() => {
    // Phase 0: Purge old builds (keep community + pinned)
    const purged = purgeNonCommunityBuilds();
    clearAllRosterMembership();
    console.log(
      `Phase 0: Purged ${purged} old builds, cleared roster membership\n`,
    );

    // Phase 1: Clear all DPS (force fresh sims)
    const cleared = clearAllBuildDps();
    console.log(
      `Phase 1: Cleared DPS on ${cleared} builds (fresh sims required)\n`,
    );

    // Build fingerprint cache for cross-source dedup
    const fingerprints = new Set();

    // Phase 2: Generate 500 cluster builds (50 per tree x apex bucket)
    console.log("Phase 2: Cluster roster");
    const clusterBuilds = generateClusterRoster({ maxRosterSize: 500 });
    let clusterAdded = 0;
    let clusterSkipped = 0;
    let clusterInvalid = 0;

    for (const cb of clusterBuilds) {
      if (!cb.hash) {
        clusterInvalid++;
        continue;
      }

      if (isDuplicateByFingerprint(fingerprints, cb.hash)) {
        clusterSkipped++;
        continue;
      }

      const heroTree = normalizeTreeName(cb.heroTree);
      const ha = heroAbbrev(heroTree);
      const variantTag = cb.variant ? `_${cb.variant}` : "";
      const name = `${ha}_${sanitizeId(cb.template)}${variantTag}_${clusterAdded + 1}`;
      const archetype = `Apex ${cb.apexRank}: ${cb.template}`;

      const validation = validateBuild({ hash: cb.hash });
      if (!validation.valid) clusterInvalid++;

      upsertBuild({
        hash: cb.hash,
        name,
        heroTree,
        archetype,
        source: "cluster",
        inRoster: true,
        validated: validation.valid ? 1 : 0,
        validationErrors: validation.valid ? null : validation.errors,
      });

      addFingerprint(fingerprints, cb.hash);
      clusterAdded++;
    }

    console.log(
      `  Cluster: ${clusterAdded} added, ${clusterSkipped} duplicates${clusterInvalid ? `, ${clusterInvalid} invalid` : ""}`,
    );

    // Phase 3: Import community builds ON TOP of cluster (dedup against cluster)
    console.log("\nPhase 3: Community builds");
    importCommunityUnified(fingerprints, archetypes);

    // Phase 4: Generate display names
    console.log("\nPhase 4: Display names");
    const allRoster = getRosterBuilds();
    generateDisplayNames(allRoster);
    console.log(`  Generated names for ${allRoster.length} builds`);
  });

  // Phase 5: Show structured summary
  console.log("");
  showRoster();
}
```

Key changes from the old version:

- Baseline import removed (not needed for havoc, and if needed it's just another community-style build)
- `purgeNonCommunityBuilds()` deletes old cluster/doe/baseline rows instead of just clearing membership
- `clearAllBuildDps()` wipes DPS on surviving community builds so they also get fresh sims
- Cluster gets full 500 slots; community builds are added on top (not subtracted from 500)

**Step 3: Remove the baseline import call**

If `importBaselineUnified` is only called from `generate()`, leave the function but just remove the call. The baseline concept doesn't apply to havoc's community-build model.

**Step 4: Verify**

Run: `SPEC=havoc npm run roster generate 2>&1 | head -30`
Expected: Shows "Purged N old builds", "Cleared DPS", then cluster + community phases.

**Step 5: Verify build counts**

Run: `SPEC=havoc npm run roster show 2>&1 | tail -20`
Expected: ~500 cluster + 6 community = ~506 total. Even distribution: ~50 per tree/apex bucket.

**Step 6: Verify DB is clean**

Run: `sqlite3 results/havoc/theorycraft.db "SELECT COUNT(*) FROM builds WHERE in_roster = 0 AND source NOT LIKE 'community:%'"`
Expected: 0 (no orphaned non-community builds).

Run: `sqlite3 results/havoc/theorycraft.db "SELECT COUNT(*) FROM builds WHERE weighted IS NOT NULL"`
Expected: 0 (all DPS cleared).

**Step 7: Commit**

```
fix: roster generate purges old builds and clears stale DPS

- Deletes non-community, non-pinned builds instead of just clearing membership
- Clears all DPS columns to force fresh sims
- Cluster builds get full 500 slots; community added on top
- Removes baseline import (use community builds instead)
```

---

### Task 3: Label community builds with source name in archetype

**Files:**

- Modify: `src/sim/build-roster.js` (function `importCommunityUnified`, ~line 495)

**Step 1: Change the archetype for community builds**

In `importCommunityUnified()`, the archetype is set by `classifyBuildArchetype()` which returns generic strings like `Community AR`. Replace the archetype assignment (line 545-549) to include the source label:

Change:

```javascript
// Classify into DoE archetype
const archetype = classifyBuildArchetype(normalizedHash, archetypes, heroTree);
```

To:

```javascript
// Label with source name (wowhead, icy-veins, raidbots, etc.)
const sourceLabel = sourceName.charAt(0).toUpperCase() + sourceName.slice(1);
const archetype = `Community: ${sourceLabel}`;
```

This produces archetypes like `Community: Wowhead`, `Community: Icy-veins`, `Community: Raidbots`.

**Step 2: Verify**

Run: `SPEC=havoc npm run roster generate 2>&1 | grep -i community`
Expected: Shows community builds added.

Run: `sqlite3 results/havoc/theorycraft.db "SELECT name, archetype, source FROM builds WHERE source LIKE 'community:%'"`
Expected: Archetypes like `Community: Wowhead`, `Community: Raidbots`.

**Step 3: Commit**

```
fix: label community builds with source name (wowhead, icy-veins, etc.)
```

---

### Task 4: Harden `loadReportData()` against stale DPS

**Files:**

- Modify: `src/visualize/report.js` (~lines 110-138)

**Step 1: Remove DB DPS fallback**

In `loadReportData()`, change the DPS loading to NOT fall back to DB columns. The report should only use DPS from the current session's sims.

Change lines 117-120:

```javascript
const dps = Object.fromEntries(
  scenarioKeys.map((s) => [s, build.lastDps?.[s] || db?.[`dps_${s}`] || 0]),
);
dps.weighted = build.lastDps?.weighted || db?.weighted || 0;
```

To:

```javascript
const dps = Object.fromEntries(
  scenarioKeys.map((s) => [s, build.lastDps?.[s] || 0]),
);
dps.weighted = build.lastDps?.weighted || 0;
```

**Step 2: Add a warning when data is sparse**

In the `else` (skip-sims) branch at ~line 4689, after loading report data, add a warning if most builds lack DPS:

```javascript
reportData = loadReportData(roster);
const withDps = reportData.builds.filter((b) => b.dps.weighted > 0).length;
console.log(
  `  ${reportData.builds.length} builds loaded (${withDps} with DPS data)`,
);

if (withDps < reportData.builds.length * 0.5) {
  console.error(
    `\n  WARNING: Only ${withDps}/${reportData.builds.length} builds have DPS data.` +
      `\n  Report will be incomplete. Run without --skip-sims to get full data.\n`,
  );
}
```

**Step 3: Verify**

Run: `grep "build.lastDps" src/visualize/report.js`
Expected: No references to `db?.dps_` or `db?.weighted` in the DPS loading.

**Step 4: Commit**

```
fix: report refuses stale DB DPS fallback, warns on sparse data
```

---

### Task 5: Verify the publish script fix

**Files:**

- Verify: `scripts/publish-report.sh`

**Step 1: Confirm the earlier fix is in place**

Run: `grep 'REPORT_ARGS=' scripts/publish-report.sh`
Expected: `REPORT_ARGS=""` (not `--skip-sims`).

Also verify the comment was updated:
Run: `grep 'Parse args' scripts/publish-report.sh`
Expected: `# Parse args - pass everything through to report.js` (no mention of `--skip-sims` default).

**Step 2: No commit needed** (already done earlier in this session).

---

### Task 6: Final validation

**Step 1: Run full roster generation**

Run: `SPEC=havoc npm run roster generate`

Expected output pattern:

```
=== Generating Build Roster ===

Phase 0: Purged N old builds, cleared roster membership
Phase 1: Cleared DPS on N builds (fresh sims required)
Phase 2: Cluster roster
  ...
  Quota distribution: AR/a0:50, AR/a1:50, AR/a2:50, AR/a3:50, AR/a4:50, FS/a0:50, FS/a1:50, FS/a2:50, FS/a3:50, FS/a4:50
  ...
Phase 3: Community builds
  Community: 6 added, ...
Phase 4: Display names
  Generated names for 506 builds
```

**Step 2: Verify DB cleanliness**

Run:

```bash
sqlite3 results/havoc/theorycraft.db "
  SELECT 'total', COUNT(*) FROM builds WHERE spec = 'havoc'
  UNION ALL
  SELECT 'in_roster', COUNT(*) FROM builds WHERE spec = 'havoc' AND in_roster = 1
  UNION ALL
  SELECT 'orphaned', COUNT(*) FROM builds WHERE spec = 'havoc' AND in_roster = 0
  UNION ALL
  SELECT 'with_stale_dps', COUNT(*) FROM builds WHERE spec = 'havoc' AND weighted IS NOT NULL
  UNION ALL
  SELECT 'community', COUNT(*) FROM builds WHERE spec = 'havoc' AND source LIKE 'community:%'
"
```

Expected:

```
total|~506
in_roster|~506
orphaned|0
with_stale_dps|0
community|6
```

**Step 3: Verify community labels**

Run: `sqlite3 results/havoc/theorycraft.db "SELECT name, archetype FROM builds WHERE source LIKE 'community:%'"`

Expected: Each community build has archetype like `Community: Wowhead` or `Community: Raidbots`.

**Step 4: Final commit (if any fixups needed)**

```
chore: verify clean roster state after pipeline hardening
```
