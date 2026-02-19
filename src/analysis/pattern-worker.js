// Worker thread for parallel pattern analysis.
// Each worker gets its own module scope — no _scoreTable contention.

import { parentPort, workerData } from "node:worker_threads";
import { readFileSync, existsSync, writeFileSync } from "node:fs";

const { spec, specConfig } = workerData;

let engineReady = false;
let reinitScoringForBuild,
  simulateApl,
  computeDivergence,
  analyzePatterns,
  resultsFile;

async function ensureEngine() {
  if (engineReady) return;
  const timeline = await import("./optimal-timeline.js");
  reinitScoringForBuild = timeline.reinitScoringForBuild;
  await timeline.initEngine(spec);

  const interp = await import("./apl-interpreter.js");
  simulateApl = interp.simulateApl;
  await interp.initEngine(spec);

  const div = await import("./divergence.js");
  computeDivergence = div.computeDivergence;
  await div.initEngine(spec);

  const patterns = await import("./pattern-analysis.js");
  analyzePatterns = patterns.analyzePatterns;

  const paths = await import("../engine/paths.js");
  resultsFile = paths.resultsFile;

  engineReady = true;
}

parentPort.on("message", async (msg) => {
  try {
    await ensureEngine();

    const { archetype, duration, aplPath, runKey } = msg;

    reinitScoringForBuild(archetype);

    const traceFile = resultsFile(`apl-trace-${runKey}.json`);
    const divFile = resultsFile(`divergences-${runKey}.json`);

    let aplTrace = null;
    let divergences = [];

    if (existsSync(traceFile)) {
      aplTrace = JSON.parse(readFileSync(traceFile, "utf-8"));
    }
    if (existsSync(divFile)) {
      const divData = JSON.parse(readFileSync(divFile, "utf-8"));
      divergences = divData.divergences || [];
    }

    if (!aplTrace) {
      if (!existsSync(aplPath)) {
        parentPort.postMessage({ runKey, skipped: true });
        return;
      }
      const aplText = readFileSync(aplPath, "utf-8");
      aplTrace = simulateApl(aplText, archetype, duration);
    }

    if (divergences.length === 0 && aplTrace) {
      divergences = computeDivergence(aplTrace, archetype);
    }

    const patterns = analyzePatterns(aplTrace, divergences, specConfig);

    writeFileSync(
      resultsFile(`patterns-${runKey}.json`),
      JSON.stringify(patterns, null, 2),
    );

    parentPort.postMessage({
      runKey,
      patterns,
      divergences,
      gcds: patterns.resourceFlow?.gcds?.total || 0,
      divergenceCount: divergences.length,
    });
  } catch (err) {
    parentPort.postMessage({ runKey: msg.runKey, error: err.message });
  }
});
