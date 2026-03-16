#!/usr/bin/env node

// Debug: dump all events for one Devourer fight to understand voidfall_building sources

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

  // Use second report from the devourer probe (first was permission denied)
  const code = "LdYWXHCkV98TmjRN";
  const fightID = 5;

  // Get fight info
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
              kill
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
  console.log(
    `Fight: ${fight.name} (${((fight.endTime - fight.startTime) / 1000).toFixed(0)}s)\n`,
  );

  // Get a small window - first 60 seconds
  const windowStart = fight.startTime;
  const windowEnd = fight.startTime + 60000;

  const data = await graphql(
    `
    query($code: String!) {
      reportData { report(code: $code) {
        casts: events(
          fightIDs: [${fightID}] startTime: ${windowStart} endTime: ${windowEnd}
          dataType: Casts sourceClass: "DemonHunter"
        ) { data }
        buffs: events(
          fightIDs: [${fightID}] startTime: ${windowStart} endTime: ${windowEnd}
          dataType: Buffs sourceClass: "DemonHunter"
        ) { data }
        damage: events(
          fightIDs: [${fightID}] startTime: ${windowStart} endTime: ${windowEnd}
          dataType: DamageDone sourceClass: "DemonHunter"
        ) { data }
      }}
    }
  `,
    { code },
  );

  const r = data.reportData.report;
  const allEvents = [
    ...(r.casts.data || []).map((e) => ({ ...e, _dt: "Cast" })),
    ...(r.buffs.data || []).map((e) => ({ ...e, _dt: "Buff" })),
    ...(r.damage.data || []).map((e) => ({ ...e, _dt: "Dmg" })),
  ].sort((a, b) => a.timestamp - b.timestamp);

  // Pick one sourceID that has voidfall events
  const sourceIDs = new Set();
  for (const e of allEvents) {
    if (e.abilityGameID === 1256301 || e.abilityGameID === 1256302) {
      sourceIDs.add(e.sourceID);
    }
  }

  if (sourceIDs.size === 0) {
    console.log(
      "No voidfall events found in this window. Trying full fight...",
    );
    // Try full fight for building events
    const data2 = await graphql(
      `
      query($code: String!) {
        reportData { report(code: $code) {
          building: events(
            fightIDs: [${fightID}] startTime: 0 endTime: 999999999
            dataType: Buffs sourceClass: "DemonHunter"
            abilityID: 1256301
          ) { data }
        }}
      }
    `,
      { code },
    );
    const bEvents = data2.reportData.report.building.data || [];
    console.log(`Total building events in fight: ${bEvents.length}`);
    for (const e of bEvents.slice(0, 5)) {
      sourceIDs.add(e.sourceID);
    }
  }

  console.log(`Source IDs with voidfall: ${[...sourceIDs].join(", ")}\n`);

  // For each source, show timeline filtering to relevant abilities
  const RELEVANT_ABILITIES = new Set([
    473662, // Consume
    1256301, // voidfall_building
    1256302, // voidfall_spending
    1217607, // Void Metamorphosis
    191427, // Metamorphosis (generic)
    200166, // Metamorphosis impact
  ]);

  // Also want to find Void Ray spell ID - look at damage events
  const abilityCount = {};
  for (const e of allEvents) {
    const key = e.abilityGameID;
    abilityCount[key] = (abilityCount[key] || 0) + 1;
  }

  console.log("Top abilities in this window:");
  const sorted = Object.entries(abilityCount).sort((a, b) => b[1] - a[1]);
  for (const [id, count] of sorted.slice(0, 30)) {
    console.log(`  ${id}: ${count} events`);
  }

  // Now show full timeline for one player, focusing on voidfall + potential triggers
  const targetSource = [...sourceIDs][0];
  if (!targetSource) {
    console.log("No target source found");
    return;
  }

  console.log(`\n=== Timeline for sourceID ${targetSource} (first 60s) ===\n`);

  // Get wider event set for this player
  const data3 = await graphql(
    `
    query($code: String!) {
      reportData { report(code: $code) {
        casts: events(
          fightIDs: [${fightID}] startTime: ${windowStart} endTime: ${windowEnd}
          dataType: Casts sourceID: ${targetSource}
        ) { data }
        buffs: events(
          fightIDs: [${fightID}] startTime: ${windowStart} endTime: ${windowEnd}
          dataType: Buffs sourceID: ${targetSource}
        ) { data }
      }}
    }
  `,
    { code },
  );

  const r3 = data3.reportData.report;
  const playerEvents = [
    ...(r3.casts.data || []).map((e) => ({ ...e, _dt: "Cast" })),
    ...(r3.buffs.data || []).map((e) => ({ ...e, _dt: "Buff" })),
  ].sort((a, b) => a.timestamp - b.timestamp);

  let buildingStacks = 0;
  for (const e of playerEvents) {
    const ability = e.abilityGameID;
    const marker =
      ability === 1256301
        ? " <<<< BUILDING"
        : ability === 1256302
          ? " <<<< SPENDING"
          : ability === 473662
            ? " <<<< CONSUME"
            : "";

    const extra = [];
    if (e.stack !== undefined) extra.push(`stack=${e.stack}`);

    if (ability === 1256301) {
      if (e.type === "applybuff") buildingStacks = 1;
      else if (e.type === "applybuffstack")
        buildingStacks = e.stack || buildingStacks + 1;
      else if (e.type === "removebuff") buildingStacks = 0;
    }

    if (marker || e._dt === "Cast") {
      console.log(
        `${e.timestamp - windowStart}ms [${e._dt}] ${e.type} ability=${ability}${extra.length ? " " + extra.join(" ") : ""} [bldg=${buildingStacks}]${marker}`,
      );
    }
  }

  // Now get full fight stats
  console.log("\n\n=== Full fight summary ===\n");

  const fullData = await graphql(
    `
    query($code: String!) {
      reportData { report(code: $code) {
        consumes: events(
          fightIDs: [${fightID}] startTime: 0 endTime: 999999999
          dataType: Casts sourceID: ${targetSource}
          abilityID: 473662
        ) { data nextPageTimestamp }
        building: events(
          fightIDs: [${fightID}] startTime: 0 endTime: 999999999
          dataType: Buffs sourceID: ${targetSource}
          abilityID: 1256301
        ) { data nextPageTimestamp }
        spending: events(
          fightIDs: [${fightID}] startTime: 0 endTime: 999999999
          dataType: Buffs sourceID: ${targetSource}
          abilityID: 1256302
        ) { data nextPageTimestamp }
        allCasts: events(
          fightIDs: [${fightID}] startTime: 0 endTime: 999999999
          dataType: Casts sourceID: ${targetSource}
        ) { data nextPageTimestamp }
      }}
    }
  `,
    { code },
  );

  const fr = fullData.reportData.report;
  const consumes = fr.consumes.data || [];
  const building = fr.building.data || [];
  const spending = fr.spending.data || [];
  const allCasts = fr.allCasts.data || [];

  console.log(`Consume casts: ${consumes.length}`);
  const buildGains = building.filter(
    (e) => e.type === "applybuff" || e.type === "applybuffstack",
  );
  console.log(`Building gain events: ${buildGains.length}`);
  console.log(
    `Building event types: ${JSON.stringify(
      building.reduce((acc, e) => {
        acc[e.type] = (acc[e.type] || 0) + 1;
        return acc;
      }, {}),
    )}`,
  );
  console.log(
    `Spending event types: ${JSON.stringify(
      spending.reduce((acc, e) => {
        acc[e.type] = (acc[e.type] || 0) + 1;
        return acc;
      }, {}),
    )}`,
  );

  // Count all cast ability IDs to find meta, void ray, etc.
  const castAbilities = {};
  for (const e of allCasts) {
    castAbilities[e.abilityGameID] = (castAbilities[e.abilityGameID] || 0) + 1;
  }
  console.log("\nAll cast abilities:");
  for (const [id, count] of Object.entries(castAbilities).sort(
    (a, b) => b[1] - a[1],
  )) {
    console.log(`  ${id}: ${count}`);
  }

  // Timeline: show consume casts and building events interleaved
  console.log("\n=== First 100 events: Consume + Building + Spending ===\n");

  const timeline = [
    ...consumes.map((e) => ({ ...e, _src: "CONSUME" })),
    ...building.map((e) => ({ ...e, _src: "BUILDING" })),
    ...spending.map((e) => ({ ...e, _src: "SPENDING" })),
  ].sort((a, b) => a.timestamp - b.timestamp);

  let stacks = 0;
  let spendActive = false;
  for (const e of timeline.slice(0, 100)) {
    if (e._src === "CONSUME") {
      console.log(
        `${e.timestamp} CONSUME cast [bldg=${stacks}, spend=${spendActive}]`,
      );
    } else if (e._src === "BUILDING") {
      const prev = stacks;
      if (e.type === "applybuff") stacks = 1;
      else if (e.type === "applybuffstack") stacks = e.stack || stacks + 1;
      else if (e.type === "removebuff") stacks = 0;
      const isGain = e.type === "applybuff" || e.type === "applybuffstack";
      console.log(
        `${e.timestamp} BUILDING ${e.type}${e.stack !== undefined ? ` stack=${e.stack}` : ""} [${prev}->${stacks}]${isGain ? " <-- GAIN" : ""}`,
      );
    } else {
      if (e.type === "applybuff") spendActive = true;
      else if (e.type === "removebuff") spendActive = false;
      console.log(`${e.timestamp} SPENDING ${e.type} [active=${spendActive}]`);
    }
  }
}

main().catch(console.error);
