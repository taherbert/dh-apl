#!/usr/bin/env node

// Show specific instances where analysis claims 2 stacks from one cast

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

  const data = await graphql(
    `
    query($code: String!) {
      reportData { report(code: $code) {
        buffs: events(fightIDs: [${fightID}] startTime: 0 endTime: 999999999 dataType: Buffs abilityID: 1256322) { data }
        casts: events(fightIDs: [${fightID}] startTime: 0 endTime: 999999999 dataType: Casts abilityID: 263642) { data }
      }}
    }
  `,
    { code },
  );

  const buffs = data.reportData.report.buffs.data;
  const casts = data.reportData.report.casts.data;

  // Filter to sourceID 329 (the player from earlier debug)
  const pBuffs = buffs.filter((b) => b.sourceID === 329);
  const pCasts = casts.filter((c) => c.sourceID === 329);

  const allEvents = [
    ...pCasts.map((e) => ({ ...e, _t: "FRAC" })),
    ...pBuffs.map((e) => ({ ...e, _t: "BUFF" })),
  ].sort((a, b) => a.timestamp - b.timestamp);

  // Show ALL events, highlighting patterns where gains cluster near casts
  console.log("Full event timeline for player 329:");
  console.log("(Showing fracture casts and voidfall buff events)\n");

  let stacks = 0;
  let lastCastTime = null;
  let gainsSinceLastCast = 0;

  for (const e of allEvents) {
    if (e._t === "FRAC") {
      if (lastCastTime !== null && gainsSinceLastCast > 0) {
        console.log(
          `  ^ ${gainsSinceLastCast} gain(s) attributed to previous cast`,
        );
      }
      const delta = lastCastTime ? e.timestamp - lastCastTime : 0;
      console.log(
        `\n${e.timestamp} FRACTURE cast [stacks=${stacks}, delta=${delta}ms]`,
      );
      lastCastTime = e.timestamp;
      gainsSinceLastCast = 0;
    } else {
      const stackInfo = e.stack !== undefined ? ` stack=${e.stack}` : "";
      const prevStacks = stacks;
      if (e.type === "applybuff") stacks = 1;
      else if (e.type === "applybuffstack") stacks = e.stack || stacks + 1;
      else if (e.type === "removebuff") stacks = 0;
      else if (e.type === "removebuffstack") stacks = e.stack || stacks - 1;

      const isGain = e.type === "applybuff" || e.type === "applybuffstack";
      if (isGain) gainsSinceLastCast++;

      const timeSinceCast = lastCastTime ? e.timestamp - lastCastTime : "N/A";
      console.log(
        `  ${e.timestamp} ${e.type}${stackInfo} [${prevStacks}->${stacks}] (${timeSinceCast}ms after cast)${isGain ? " <-- GAIN" : ""}`,
      );
    }
  }

  // Summary
  console.log("\n\n=== Summary ===");
  console.log(`Total fracture casts: ${pCasts.length}`);
  const gains = pBuffs.filter(
    (b) => b.type === "applybuff" || b.type === "applybuffstack",
  );
  console.log(`Total gain events: ${gains.length}`);
  console.log(
    `Gains/cast ratio: ${((gains.length / pCasts.length) * 100).toFixed(1)}%`,
  );

  // Check: how many gains happen BEFORE their nearest fracture cast?
  let gainsBefore = 0;
  let gainsAfter = 0;
  for (const g of gains) {
    // Find nearest fracture cast
    let nearestCast = null;
    let nearestDist = Infinity;
    for (const c of pCasts) {
      const dist = Math.abs(g.timestamp - c.timestamp);
      if (dist < nearestDist) {
        nearestDist = dist;
        nearestCast = c;
      }
    }
    if (nearestCast && g.timestamp < nearestCast.timestamp) gainsBefore++;
    else gainsAfter++;
  }
  console.log(`\nGain events BEFORE nearest cast: ${gainsBefore}`);
  console.log(`Gain events AFTER nearest cast: ${gainsAfter}`);
}

main().catch(console.error);
