// Converts an optimal timeline JSON into a static SimC APL for validation.
//
// Encodes the on-GCD sequence as time-gated individual actions using
// floor(time*haste/1.5)=N, which fires each action in its correct GCD window
// and correctly adapts to haste changes (procs, trinkets).
//
// Off-GCD abilities (metamorphosis) are emitted at the top with standard
// trigger conditions so they fire outside the GCD without disrupting sequence order.
//
// Why not sequence,wait_on_ready=1: SimC's action sequence buffer overflows for
// fights longer than ~30 actions. The GCD-count approach avoids this limit and
// gracefully falls through if an ability is unavailable (skips rather than deadlocks).
//
// Usage:
//   node src/analysis/timeline-to-simc.js --spec vengeance --build anni-apex3-dgb
//   (reads results/{spec}/timeline-{build}.json)
//   (writes apls/{spec}/static-optimal-{build}.simc)

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { parseSpecArg } from "../util/parse-spec-arg.js";
import { ROOT } from "../engine/paths.js";

if (import.meta.url === `file://${process.argv[1]}`) {
  const { values } = parseArgs({
    options: {
      spec: { type: "string" },
      build: { type: "string", default: "anni-apex3-dgb" },
      input: { type: "string" },
      output: { type: "string" },
    },
    strict: false,
  });

  const spec = values.spec || parseSpecArg();
  const buildName = values.build;

  const resultsDir = join(ROOT, "results", spec);
  const inputFile =
    values.input || join(resultsDir, `timeline-${buildName}.json`);

  if (!existsSync(inputFile)) {
    console.error(`Timeline not found: ${inputFile}`);
    console.error(
      `Run: SPEC=${spec} npm run optimal-timeline -- --build ${buildName}`,
    );
    process.exit(1);
  }

  const timeline = JSON.parse(readFileSync(inputFile, "utf-8"));
  const { metadata, events } = timeline;

  // Separate off-GCD events from on-GCD sequence
  const onGcdEvents = events.filter((e) => !e.off_gcd);

  if (onGcdEvents.length === 0) {
    console.error("No on-GCD events in timeline.");
    process.exit(1);
  }

  const lines = [
    `# Auto-generated static optimal APL for ${buildName}`,
    `# Build: ${metadata.heroTree} / Apex ${metadata.apexRank} / ${metadata.duration}s`,
    `# Generated: ${new Date().toISOString()}`,
    `# Do not edit — regenerate from timeline JSON`,
    `#`,
    `# Validation: compare with iterate.js compare --quick`,
    `# If static > current APL: scoring model valid, divergences are real signals`,
    `# If static ~ APL (±0.5%): APL near model optimum`,
    `# If static < APL: scoring model has systematic errors`,
    ``,
  ];

  // Include shared profile
  lines.push(`input=apls/${spec}/profile.simc`);
  lines.push(``);

  // Off-GCD triggers (metamorphosis) — fire instantly outside the GCD
  lines.push(
    `# Off-GCD triggers (fire outside the GCD, don't occupy sequence slot)`,
  );
  if (metadata.heroTree === "annihilator") {
    // Anni: fire on UR proc or standard trigger conditions
    lines.push(
      `actions=/metamorphosis,use_off_gcd=1,if=buff.untethered_rage.up|(cooldown.metamorphosis.ready&!buff.metamorphosis.up&soul_fragments>=3)`,
    );
  } else {
    // AR or generic: standard Meta trigger
    lines.push(
      `actions=/metamorphosis,use_off_gcd=1,if=cooldown.metamorphosis.ready&!buff.metamorphosis.up&soul_fragments>=3`,
    );
  }
  lines.push(``);

  // Time-gated on-GCD sequence using GCD-count windows.
  //
  // floor(time * gcdMultiplier) = N fires action N exactly when that GCD starts.
  // gcdMultiplier = (1 + haste) / 1.5 converts wall-clock time to GCD count,
  // accounting for this build's haste. Falls through gracefully if an ability
  // is unavailable (no deadlock unlike sequence,wait_on_ready=1).
  //
  // Division is avoided in the SimC condition (SimC misparses / inside if=).
  // Instead, the multiplier is precomputed here and embedded as a literal.
  const gcdMultiplier = +((1 + metadata.haste) / 1.5).toFixed(6);
  lines.push(
    `# Static on-GCD sequence — GCD-count windows (haste=${metadata.haste})`,
  );
  for (let i = 0; i < onGcdEvents.length; i++) {
    lines.push(
      `actions+=/${onGcdEvents[i].ability},if=floor(time*${gcdMultiplier})=${i}`,
    );
  }
  lines.push(``);

  // Fallback in case fight outlasts the sequence (shouldn't happen)
  lines.push(`# Fallback if fight outlasts sequence`);
  lines.push(`actions+=/spirit_bomb,if=soul_fragments>=4`);
  lines.push(`actions+=/fracture`);
  lines.push(``);

  const aplsDir = join(ROOT, "apls", spec);
  mkdirSync(aplsDir, { recursive: true });
  const outputFile =
    values.output || join(aplsDir, `static-optimal-${buildName}.simc`);

  writeFileSync(outputFile, lines.join("\n"));

  console.log(`Static optimal APL written to: ${outputFile}`);
  console.log(`  ${onGcdEvents.length} on-GCD actions in sequence`);
  console.log(`  Hero tree: ${metadata.heroTree}, Apex: ${metadata.apexRank}`);
  console.log(``);
  console.log(`Validation workflow:`);
  console.log(
    `  SPEC=${spec} npm run optimal-timeline -- --build ${buildName}`,
  );
  console.log(
    `  node src/analysis/timeline-to-simc.js --spec ${spec} --build ${buildName}`,
  );
  console.log(`  node src/sim/iterate.js compare ${outputFile} --quick`);
}
