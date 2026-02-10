#!/usr/bin/env node
// CLI wrapper for startup.js — separate file to avoid TLA circular import
// deadlock (startup.js → spec adapter → startup.js).

import { parseSpecArg } from "../util/parse-spec-arg.js";
import { initSpec, reportStatus, checkSync } from "./startup.js";

await initSpec(parseSpecArg());
console.log(reportStatus());
const sync = checkSync();
if (!sync.synced) {
  console.log("\nRun `npm run refresh` to rebuild from upstream.");
}
