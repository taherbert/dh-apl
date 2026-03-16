#!/usr/bin/env node

// Check what other events correlate with Voidfall gain timing
// Hypothesis: soul fragment pickup or damage events trigger Voidfall, not the cast itself

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

  const code = "RBZFhgNGtT6CknPx";
  const fightID = 6;
  const sourceID = 329;

  // Get a window around one of those detached gain bursts
  // The burst at 12616117-12616861 is 2+ seconds after the fracture at 12613966
  // Let's get ALL events from this player in that window
  const windowStart = 12613000;
  const windowEnd = 12618000;

  const data = await graphql(
    `
    query($code: String!) {
      reportData { report(code: $code) {
        allCasts: events(
          fightIDs: [${fightID}]
          startTime: ${windowStart}
          endTime: ${windowEnd}
          dataType: Casts
          sourceID: ${sourceID}
        ) { data }
        allBuffs: events(
          fightIDs: [${fightID}]
          startTime: ${windowStart}
          endTime: ${windowEnd}
          dataType: Buffs
          sourceID: ${sourceID}
        ) { data }
        allDebuffs: events(
          fightIDs: [${fightID}]
          startTime: ${windowStart}
          endTime: ${windowEnd}
          dataType: Debuffs
          sourceID: ${sourceID}
        ) { data }
        allDamage: events(
          fightIDs: [${fightID}]
          startTime: ${windowStart}
          endTime: ${windowEnd}
          dataType: DamageDone
          sourceID: ${sourceID}
        ) { data }
        allHealing: events(
          fightIDs: [${fightID}]
          startTime: ${windowStart}
          endTime: ${windowEnd}
          dataType: Healing
          sourceID: ${sourceID}
        ) { data }
        allResources: events(
          fightIDs: [${fightID}]
          startTime: ${windowStart}
          endTime: ${windowEnd}
          dataType: Resources
          sourceID: ${sourceID}
        ) { data }
      }}
    }
  `,
    { code },
  );

  const report = data.reportData.report;

  // Merge all events
  const allEvents = [
    ...(report.allCasts.data || []).map((e) => ({ ...e, _dt: "Cast" })),
    ...(report.allBuffs.data || []).map((e) => ({ ...e, _dt: "Buff" })),
    ...(report.allDebuffs.data || []).map((e) => ({ ...e, _dt: "Debuff" })),
    ...(report.allDamage.data || []).map((e) => ({ ...e, _dt: "Damage" })),
    ...(report.allHealing.data || []).map((e) => ({ ...e, _dt: "Healing" })),
    ...(report.allResources.data || []).map((e) => ({ ...e, _dt: "Resource" })),
  ].sort((a, b) => a.timestamp - b.timestamp);

  console.log(
    `All events for player ${sourceID} between ${windowStart}-${windowEnd}:\n`,
  );

  for (const e of allEvents) {
    const ability = e.abilityGameID || "?";
    const type = e.type || "?";
    const extra = [];
    if (e.stack) extra.push(`stack=${e.stack}`);
    if (e.amount) extra.push(`amount=${e.amount}`);
    if (e.resourceChange) extra.push(`resourceChange=${e.resourceChange}`);
    if (e.resourceChangeType)
      extra.push(`resourceType=${e.resourceChangeType}`);

    // Highlight voidfall events
    const marker = ability === 1256322 ? " <<<< VOIDFALL" : "";

    console.log(
      `${e.timestamp} [${e._dt}] ${type} ability=${ability}${extra.length ? " " + extra.join(" ") : ""}${marker}`,
    );
  }

  // Also get a wider picture: show the second burst area too
  console.log("\n\n--- Also checking the first burst (around 12581934) ---\n");

  const data2 = await graphql(
    `
    query($code: String!) {
      reportData { report(code: $code) {
        allCasts: events(
          fightIDs: [${fightID}]
          startTime: 12581000
          endTime: 12583500
          dataType: Casts
          sourceID: ${sourceID}
        ) { data }
        allBuffs: events(
          fightIDs: [${fightID}]
          startTime: 12581000
          endTime: 12583500
          dataType: Buffs
          sourceID: ${sourceID}
        ) { data }
        allDamage: events(
          fightIDs: [${fightID}]
          startTime: 12581000
          endTime: 12583500
          dataType: DamageDone
          sourceID: ${sourceID}
        ) { data }
      }}
    }
  `,
    { code },
  );

  const r2 = data2.reportData.report;
  const events2 = [
    ...(r2.allCasts.data || []).map((e) => ({ ...e, _dt: "Cast" })),
    ...(r2.allBuffs.data || []).map((e) => ({ ...e, _dt: "Buff" })),
    ...(r2.allDamage.data || []).map((e) => ({ ...e, _dt: "Damage" })),
  ].sort((a, b) => a.timestamp - b.timestamp);

  for (const e of events2) {
    const ability = e.abilityGameID || "?";
    const type = e.type || "?";
    const extra = [];
    if (e.stack) extra.push(`stack=${e.stack}`);
    if (e.amount) extra.push(`amount=${e.amount}`);
    const marker =
      ability === 1256322
        ? " <<<< VOIDFALL"
        : ability === 263642
          ? " <<<< FRACTURE"
          : "";
    console.log(
      `${e.timestamp} [${e._dt}] ${type} ability=${ability}${extra.length ? " " + extra.join(" ") : ""}${marker}`,
    );
  }
}

main().catch(console.error);
