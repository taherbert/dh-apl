// Copies the SimC baseline APL (.simc) into our reference directory.

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SIMC_APL_PATH, config, initSpec } from "../engine/startup.js";
import { parseSpecArg } from "../util/parse-spec-arg.js";
import { REFERENCE_DIR } from "../engine/paths.js";

function main() {
  const specName = config.spec.specName;
  const OUTPUT = join(REFERENCE_DIR, `${specName}-apl.simc`);

  console.log(`Reading APL from: ${SIMC_APL_PATH}`);

  const simc = readFileSync(SIMC_APL_PATH, "utf-8");

  // Count action lines for stats
  const actionLines = simc
    .split("\n")
    .filter((l) => l.match(/^actions[\.\+]*[=+]/));
  const lists = new Set(
    actionLines.map((l) => {
      const m = l.match(/^actions\.(\w+)/);
      return m ? m[1] : "default";
    }),
  );

  writeFileSync(OUTPUT, simc);
  console.log(`Written to: ${OUTPUT}`);
  console.log(`${actionLines.length} action lines`);
  console.log(`Action lists: ${[...lists].join(", ")}`);
}

(async () => {
  await initSpec(parseSpecArg());
  main();
})();
