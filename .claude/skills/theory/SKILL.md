---
description: Manage theories in the theorycrafting database. List, show, create, revise, or summarize theories.
argument-hint: "[list|show <id>|create|revise <id>|summary]"
allowed-tools: Bash, Read, Write, Glob, Grep
---

# Theory Management

Manage theories in the theorycrafting database. Theories are high-level mechanical insights with causal reasoning that drive hypothesis generation.

## Usage

`/theory [list|show <id>|create|revise <id>|summary]`

Arguments: $ARGUMENTS

## Commands

### list (default)

Show all active theories with their confidence levels and hypothesis counts.

```bash
SPEC=$SPEC node -e "
  import { initSpec } from './src/engine/startup.js';
  import { parseSpecArg } from './src/util/parse-spec-arg.js';
  import { getTheories, getHypotheses } from './src/util/db.js';
  await initSpec(parseSpecArg());
  const theories = getTheories({ status: 'active' });
  for (const t of theories) {
    const hyps = getHypotheses({ theoryId: t.id });
    const pending = hyps.filter(h => h.status === 'pending').length;
    const tested = hyps.filter(h => h.status !== 'pending').length;
    console.log(\`T\${t.id} [\${t.confidence.toFixed(2)}] \${t.title}\`);
    console.log(\`   \${t.category || 'uncategorized'} | \${pending} pending, \${tested} tested\`);
  }
"
```

### show <id>

Show a theory with its full chain, hypotheses, and iteration results.

Use `getTheoryWithHypotheses(id)` from `src/analyze/theory.js`.

### create

Interactive theory creation. Ask for:

1. Title (short descriptive name)
2. Reasoning (full causal chain)
3. Category (resource_flow, cooldown_alignment, talent_interaction, state_machine)
4. Initial confidence (0.0 - 1.0, default 0.5)

Write to DB via `createTheory()` from `src/analyze/theory.js`.

### revise <id>

Revise an existing theory. Read the current theory, ask what changed, create a child theory that supersedes the parent. Uses `reviseTheory()` from `src/analyze/theory.js`.

### summary

Show counts by status (active, validated, refuted, superseded) and overall confidence distribution.

## Execution

1. Parse `$ARGUMENTS` to determine subcommand
2. Set SPEC from environment or `--spec` flag
3. Initialize spec: `await initSpec(parseSpecArg())`
4. Execute the appropriate subcommand
5. Display results in a readable format
