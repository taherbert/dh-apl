// Parses --spec <name> from CLI args or SPEC from env.
// No default — throws if neither is set.

import { parseArgs } from "node:util";

export function parseSpecArg() {
  // Check env first
  if (process.env.SPEC) return process.env.SPEC;

  // Parse --spec from argv (strict: false to allow other flags)
  try {
    const { values } = parseArgs({
      options: { spec: { type: "string" } },
      strict: false,
    });
    if (values.spec) return values.spec;
  } catch {
    // parseArgs can throw on malformed args — fall through
  }

  throw new Error(
    "Spec not specified. Use --spec <name> or set SPEC env var.\n" +
      "  Example: SPEC=vengeance node src/engine/startup-cli.js\n" +
      "  Example: node src/engine/startup-cli.js --spec vengeance",
  );
}
