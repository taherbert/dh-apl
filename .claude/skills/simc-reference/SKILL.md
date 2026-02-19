---
description: Look up SimC syntax, expressions, and mechanics from the wiki reference docs. Use when writing APL conditions, checking expression syntax, or understanding SimC features.
argument-hint: "[topic: syntax|expressions|dh|equipment|overrides|profilesets|output|stats|enemies|characters|options|developer|all]"
context: fork
agent: Explore
allowed-tools: Read, Glob, Grep
---

Look up SimC syntax, expressions, and mechanics from the wiki reference docs in `reference/wiki/`.

Read the files matching the requested topic (`$ARGUMENTS`), then return a summary of the most relevant sections.

## Topic → File Mapping

| Topic                  | Files                                                                         |
| ---------------------- | ----------------------------------------------------------------------------- |
| _(empty)_ or `syntax`  | `reference/wiki/action-lists.md`, `reference/wiki/action-list-expressions.md` |
| `expressions`          | `reference/wiki/action-list-expressions.md`                                   |
| `dh` or `demon-hunter` | `reference/wiki/demon-hunters.md`                                             |
| `equipment` or `gear`  | `reference/wiki/equipment.md`                                                 |
| `overrides`            | `reference/wiki/spell-data-overrides.md`                                      |
| `profilesets`          | `reference/wiki/profile-sets.md`                                              |
| `output`               | `reference/wiki/output.md`                                                    |
| `stats`                | `reference/wiki/stats-scaling.md`                                             |
| `enemies`              | `reference/wiki/enemies.md`                                                   |
| `characters`           | `reference/wiki/characters.md`                                                |
| `options`              | `reference/wiki/options.md`                                                   |
| `developer`            | `reference/wiki/developer-docs.md`                                            |
| `all`                  | All files in `reference/wiki/`                                                |
