#!/usr/bin/env node

// Verify: what does WCL actually show when voidfall_building hits max stacks?
// Does it show applybuffstack to 3, or just removebuff?
// This determines whether our expire_at_max_stack fix is correct.

import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

function loadEnv() {
  const envPath = resolve(ROOT, ".env");
  const lines = readFileSync(envPath, "utf-8").split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    process.env[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
  }
}
loadEnv();

let accessToken = null;
async function authenticate() {
  const resp = await fetch("https://www.warcraftlogs.com/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: process.env.WCL_CLIENT_ID,
      client_secret: process.env.WCL_CLIENT_SECRET,
    }),
  });
  accessToken = (await resp.json()).access_token;
}

async function graphql(query, variables = {}) {
  const resp = await fetch("https://www.warcraftlogs.com/api/v2/client", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({ query, variables }),
  });
  const result = await resp.json();
  if (result.errors) throw new Error(JSON.stringify(result.errors));
  return result.data;
}

async function main() {
  await authenticate();
  console.log("Authenticated\n");

  // Try both Devourer and Vengeance
  const reports = [
    {
      code: "LdYWXHCkV98TmjRN",
      fightID: 5,
      label: "Devourer",
      castAbility: 473662,
    },
  ];

  // Find a Vengeance report - try M+ dungeons and raids
  const encounters = [
    // S1 M+ dungeons
    112526, 12811, 12874, 12915, 10658, 361753, 61209, 12805,
    // S1 raid
    3176, 3177, 3178, 3179, 3180, 3181, 3182, 3183, 3306,
    // Beta dungeons
    162526, 62811, 62874, 62915, 60658, 411753, 111209, 62805,
    // Beta raid
    53176, 53177, 53178, 53179, 53180, 53181, 53306, 53182, 53183,
  ];
  for (const encId of encounters) {
    try {
      const rankData = await graphql(`
        query { worldData { encounter(id: ${encId}) {
          characterRankings(specName: "Vengeance" className: "DemonHunter" metric: dps leaderboard: Any page: 1)
        }}}
      `);
      const rankings =
        rankData.worldData.encounter?.characterRankings?.rankings || [];
      const r = rankings.find((r) => r.report?.code && r.report?.fightID);
      if (r) {
        reports.push({
          code: r.report.code,
          fightID: r.report.fightID,
          label: `Vengeance (enc ${encId}, ${r.name})`,
          castAbility: 263642,
        });
        console.log(`Found Vengeance report from enc ${encId}`);
        break;
      }
    } catch (_) {}
  }

  if (reports.length === 1) {
    console.log("WARNING: No Vengeance rankings found from any encounter");
  }

  for (const rpt of reports) {
    console.log(`\n========== ${rpt.label} ==========`);
    console.log(`Report: ${rpt.code}, fight ${rpt.fightID}\n`);
    await analyzeReport(rpt.code, rpt.fightID, rpt.castAbility);
  }
}

async function analyzeReport(code, fightID, castAbilityId) {
  // Get fight times
  const fightData = await graphql(
    `
      query ($code: String!) {
        reportData {
          report(code: $code) {
            fights {
              id
              startTime
              endTime
              name
            }
          }
        }
      }
    `,
    { code },
  );

  const fight = fightData.reportData.report.fights.find(
    (f) => f.id === fightID,
  );
  if (!fight) {
    console.log("Fight not found");
    return;
  }

  // Get ALL building + spending + cast events for this fight
  // For Vengeance, castAbilityId=263642 (Fracture). For Devourer, 473662 (Consume).
  const extraDevourQuery =
    castAbilityId === 473662
      ? `
        devours: events(
          fightIDs: [${fightID}] startTime: ${fight.startTime} endTime: ${fight.endTime}
          dataType: Casts sourceClass: "DemonHunter" abilityID: 1217610
        ) { data }`
      : "";
  const data = await graphql(
    `
    query($code: String!) {
      reportData { report(code: $code) {
        casts: events(
          fightIDs: [${fightID}] startTime: ${fight.startTime} endTime: ${fight.endTime}
          dataType: Casts sourceClass: "DemonHunter" abilityID: ${castAbilityId}
        ) { data }${extraDevourQuery}
        building: events(
          fightIDs: [${fightID}] startTime: ${fight.startTime} endTime: ${fight.endTime}
          dataType: Buffs sourceClass: "DemonHunter" abilityID: 1256301
        ) { data }
        spending: events(
          fightIDs: [${fightID}] startTime: ${fight.startTime} endTime: ${fight.endTime}
          dataType: Buffs sourceClass: "DemonHunter" abilityID: 1256302
        ) { data }
      }}
    }
  `,
    { code },
  );

  const r = data.reportData.report;
  const allEvents = [
    ...(r.casts.data || []).map((e) => ({ ...e, _src: "cast" })),
    ...(r.devours?.data || []).map((e) => ({ ...e, _src: "cast" })),
    ...(r.building.data || []).map((e) => ({ ...e, _src: "building" })),
    ...(r.spending.data || []).map((e) => ({ ...e, _src: "spending" })),
  ].sort((a, b) => a.timestamp - b.timestamp);

  // Pick the first sourceID that has building events
  const sourceIDs = new Set();
  for (const e of allEvents) {
    if (e._src === "building") sourceIDs.add(e.sourceID);
  }

  if (sourceIDs.size === 0) {
    console.log("No building events found - this player may not have Voidfall");
    return;
  }

  // For each sourceID, analyze building->spending transitions
  for (const sid of sourceIDs) {
    const playerEvents = allEvents.filter((e) => e.sourceID === sid);
    console.log(`\n=== sourceID ${sid} ===`);

    // Count building event types
    const buildingEvents = playerEvents.filter((e) => e._src === "building");
    const typeCounts = {};
    for (const e of buildingEvents) {
      typeCounts[e.type] = (typeCounts[e.type] || 0) + 1;
    }
    console.log("Building event types:", JSON.stringify(typeCounts));

    // Check: what's the max stack value we see in applybuffstack events?
    const stackValues = buildingEvents
      .filter((e) => e.type === "applybuffstack" && e.stack !== undefined)
      .map((e) => e.stack);
    if (stackValues.length > 0) {
      console.log(
        `Stack values seen in applybuffstack: ${[...new Set(stackValues)].sort().join(", ")}`,
      );
      console.log(`Max stack seen: ${Math.max(...stackValues)}`);
    }

    // KEY TEST: Look at every building removebuff event.
    // For each, check what happened at the same timestamp.
    const removebuffs = buildingEvents.filter((e) => e.type === "removebuff");
    console.log(`\nTotal building removebuff events: ${removebuffs.length}`);

    let withSpendingStart = 0;
    let withFractureCast = 0;
    let withApplybuffstack = 0;
    let withBothFractureAndSpending = 0;

    for (const rb of removebuffs) {
      const ts = rb.timestamp;
      const sameTs = playerEvents.filter((e) => e.timestamp === ts && e !== rb);

      const hasSpendStart = sameTs.some(
        (e) => e._src === "spending" && e.type === "applybuff",
      );
      const hasFracture = sameTs.some(
        (e) => e._src === "cast" && e.type === "cast",
      );
      const hasApplybuffstack = sameTs.some(
        (e) => e._src === "building" && e.type === "applybuffstack",
      );

      if (hasSpendStart) withSpendingStart++;
      if (hasFracture) withFractureCast++;
      if (hasApplybuffstack) withApplybuffstack++;
      if (hasSpendStart && hasFracture) withBothFractureAndSpending++;
    }

    console.log(
      `  With spending applybuff at same timestamp: ${withSpendingStart}`,
    );
    console.log(
      `  With Consume/Devour cast at same timestamp: ${withFractureCast}`,
    );
    console.log(
      `  With applybuffstack at same timestamp: ${withApplybuffstack}`,
    );
    console.log(
      `  With BOTH Fracture + spending start: ${withBothFractureAndSpending}`,
    );

    // Show first 5 building->spending transitions in detail
    console.log("\n--- First 10 building removebuff events (detailed) ---");
    let shown = 0;
    for (const rb of removebuffs) {
      if (shown >= 10) break;
      const ts = rb.timestamp;
      const window = playerEvents.filter(
        (e) => Math.abs(e.timestamp - ts) <= 50,
      );

      console.log(`\n  Timestamp ${ts - fight.startTime}ms:`);
      for (const e of window) {
        const marker = e === rb ? " <-- THIS REMOVEBUFF" : "";
        console.log(
          `    [${e._src}] ${e.type}${e.stack !== undefined ? ` stack=${e.stack}` : ""}${marker}`,
        );
      }
      shown++;
    }

    // Walk events in order, tracking building stacks, and categorize each removebuff
    let stacks = 0;
    let spendActive = false;
    const removebuffDetails = [];

    for (const e of playerEvents) {
      if (e._src === "building") {
        if (e.type === "applybuff") {
          stacks = 1;
        } else if (e.type === "applybuffstack") {
          stacks = e.stack || stacks + 1;
        } else if (e.type === "removebuff") {
          const ts = e.timestamp;
          const sameTs = playerEvents.filter(
            (ev) => ev.timestamp === ts && ev !== e,
          );
          const hasSpendStart = sameTs.some(
            (ev) => ev._src === "spending" && ev.type === "applybuff",
          );
          const hasCast = sameTs.some(
            (ev) => ev._src === "cast" && ev.type === "cast",
          );
          const hasStack3 = sameTs.some(
            (ev) =>
              ev._src === "building" &&
              ev.type === "applybuffstack" &&
              ev.stack === 3,
          );
          removebuffDetails.push({
            ts: ts - fight.startTime,
            stacksBefore: stacks,
            hasSpendStart,
            hasCast,
            hasStack3,
          });
          stacks = 0;
        } else if (e.type === "removebuffstack") {
          stacks = e.stack || Math.max(0, stacks - 1);
        }
      } else if (e._src === "spending") {
        if (e.type === "applybuff") spendActive = true;
        else if (e.type === "removebuff") spendActive = false;
      }
    }

    // Group by stacks-before and conversion type
    console.log("\n--- Removebuff breakdown by stacks before removal ---");
    const groups = {};
    for (const d of removebuffDetails) {
      const key = `stacks=${d.stacksBefore}`;
      if (!groups[key])
        groups[key] = {
          total: 0,
          withSpend: 0,
          withStack3: 0,
          withCastNoStack: 0,
          noCastNoStack: 0,
          naturalExpiry: 0,
        };
      const g = groups[key];
      g.total++;
      if (!d.hasSpendStart) {
        g.naturalExpiry++;
      } else {
        g.withSpend++;
        if (d.hasStack3) g.withStack3++;
        else if (d.hasCast) g.withCastNoStack++;
        else g.noCastNoStack++;
      }
    }

    for (const [key, g] of Object.entries(groups).sort()) {
      console.log(`\n  ${key}: ${g.total} removebuffs`);
      console.log(`    Natural expiry (no spending): ${g.naturalExpiry}`);
      console.log(`    Conversions to spending: ${g.withSpend}`);
      if (g.withSpend > 0) {
        console.log(
          `      With applybuffstack=3 (visible stack gain): ${g.withStack3}`,
        );
        console.log(`      With cast but NO stack event: ${g.withCastNoStack}`);
        console.log(
          `      No cast, no stack event (guaranteed): ${g.noCastNoStack}`,
        );
      }
    }

    // Special focus: stacks=2 removebuffs with cast but no applybuffstack
    // These are the suspected hidden procs
    const hiddenProcs = removebuffDetails.filter(
      (d) =>
        d.stacksBefore === 2 && d.hasSpendStart && d.hasCast && !d.hasStack3,
    );
    console.log(
      `\n--- CRITICAL: stacks=2 conversions with cast but no applybuffstack: ${hiddenProcs.length} ---`,
    );
    if (hiddenProcs.length > 0) {
      console.log(
        "These are likely procs at stack 2 where WCL did NOT emit applybuffstack=3",
      );
      for (const d of hiddenProcs.slice(0, 5)) {
        const window = playerEvents.filter(
          (ev) => Math.abs(ev.timestamp - (d.ts + fight.startTime)) <= 100,
        );
        console.log(`\n  ${d.ts}ms (stacks before: ${d.stacksBefore}):`);
        for (const ev of window) {
          console.log(
            `    [${ev._src}] ${ev.type}${ev.stack !== undefined ? ` stack=${ev.stack}` : ""}`,
          );
        }
      }
    }

    // Also: stacks=1 removebuffs with cast but no applybuffstack
    // These could be procs at stack 1 going 1->2->3 in one step? Or 1->3 directly?
    const stack1hidden = removebuffDetails.filter(
      (d) =>
        d.stacksBefore === 1 && d.hasSpendStart && d.hasCast && !d.hasStack3,
    );
    console.log(
      `\n--- stacks=1 conversions with cast but no applybuffstack: ${stack1hidden.length} ---`,
    );

    // stacks=3 should be impossible (already at max before removebuff)
    const stack3rm = removebuffDetails.filter((d) => d.stacksBefore === 3);
    console.log(
      `\nstacks=3 before removebuff (from applybuffstack=3 at same ts): ${stack3rm.length}`,
    );

    // --- PROC RATE VERIFICATION ---
    // Since Fracture/Consume is the ONLY trigger (user confirmed for Vengeance),
    // every building gain = a proc. Count procs and eligible trials.
    console.log("\n=== PROC RATE VERIFICATION ===");

    // Recount procs using corrected methodology
    let verifyStacks = 0;
    let verifySpending = false;
    const verifyByStack = {};
    let verifyEligible = 0;
    let verifyProcs = 0;
    let verifySkipped = 0;
    const verifyEligibleByStack = {};

    // Pre-compute: timestamps with BOTH applybuffstack AND removebuff (for same source)
    const buildEvents = playerEvents.filter((e) => e._src === "building");
    const tsWithBothStackAndRemove = new Set();
    for (let i = 0; i < buildEvents.length - 1; i++) {
      if (
        buildEvents[i].type === "applybuffstack" &&
        buildEvents[i + 1].type === "removebuff" &&
        buildEvents[i].timestamp === buildEvents[i + 1].timestamp
      ) {
        tsWithBothStackAndRemove.add(buildEvents[i].timestamp);
      }
    }

    for (const e of playerEvents) {
      if (e._src === "cast" && e.type === "cast") {
        if (verifySpending) {
          verifySkipped++;
        } else {
          if (!verifyEligibleByStack[verifyStacks])
            verifyEligibleByStack[verifyStacks] = 0;
          verifyEligibleByStack[verifyStacks]++;
          verifyEligible++;
        }
      } else if (e._src === "building") {
        if (e.type === "applybuff") {
          if (!verifyByStack[0]) verifyByStack[0] = 0;
          verifyByStack[0]++;
          verifyProcs++;
          verifyStacks = 1;
        } else if (e.type === "applybuffstack") {
          const prev = (e.stack || verifyStacks + 1) - 1;
          if (!verifyByStack[prev]) verifyByStack[prev] = 0;
          verifyByStack[prev]++;
          verifyProcs++;
          verifyStacks = e.stack || verifyStacks + 1;
        } else if (e.type === "removebuff") {
          // Hidden conversion: removebuff + spending start at same timestamp
          // but NO applybuffstack at same timestamp (prevents double counting)
          const ts = e.timestamp;
          const hasSpendStart = playerEvents.some(
            (ev) =>
              ev.timestamp === ts &&
              ev._src === "spending" &&
              ev.type === "applybuff",
          );
          const alreadyCounted = tsWithBothStackAndRemove.has(ts);

          if (hasSpendStart && !alreadyCounted && verifyStacks > 0) {
            if (!verifyByStack[verifyStacks]) verifyByStack[verifyStacks] = 0;
            verifyByStack[verifyStacks]++;
            verifyProcs++;
            console.log(
              `  Hidden proc detected at stacks=${verifyStacks}, ts=${ts - fight.startTime}ms`,
            );
          }
          verifyStacks = 0;
        } else if (e.type === "removebuffstack") {
          verifyStacks = e.stack || Math.max(0, verifyStacks - 1);
        }
      } else if (e._src === "spending") {
        if (e.type === "applybuff" || e.type === "applybuffstack") {
          verifySpending = true;
        } else if (e.type === "removebuff") {
          verifySpending = false;
        }
      }
    }

    console.log(
      `\nTotal eligible: ${verifyEligible} (skipped ${verifySkipped} during spending)`,
    );
    console.log(`Total procs: ${verifyProcs}`);
    console.log(
      `Overall rate: ${((verifyProcs / verifyEligible) * 100).toFixed(1)}%`,
    );
    console.log(`\nBy stack:`);
    for (const [stack, procs] of Object.entries(verifyByStack).sort(
      (a, b) => a[0] - b[0],
    )) {
      const elig = verifyEligibleByStack[stack] || 0;
      console.log(
        `  Stack ${stack}: ${procs}/${elig} = ${elig > 0 ? ((procs / elig) * 100).toFixed(1) : "N/A"}%`,
      );
    }

    // Also check: do we ever see applybuffstack to stack 3?
    const stack3events = buildingEvents.filter(
      (e) => e.type === "applybuffstack" && e.stack === 3,
    );
    console.log(
      `\n\napplybuffstack events with stack=3: ${stack3events.length}`,
    );
    if (stack3events.length > 0) {
      console.log(
        "WCL DOES show applybuffstack to 3 - expire_at_max_stack fix may be WRONG",
      );
      // Show a few
      for (const e of stack3events.slice(0, 5)) {
        const ts = e.timestamp;
        const nearby = playerEvents.filter(
          (ev) => Math.abs(ev.timestamp - ts) <= 50,
        );
        console.log(`\n  Timestamp ${ts - fight.startTime}ms (stack=3 event):`);
        for (const n of nearby) {
          console.log(
            `    [${n._src}] ${n.type}${n.stack !== undefined ? ` stack=${n.stack}` : ""}`,
          );
        }
      }
    } else {
      console.log(
        "WCL does NOT show applybuffstack to 3 - expire_at_max_stack fix is NEEDED",
      );
    }
  }
}

main().catch(console.error);
