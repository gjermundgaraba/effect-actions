// Renders the agent skill as a copy of `docs/`. Every page is copied unchanged;
// `docs/README.md` becomes `SKILL.md` with the skill frontmatter prepended. The two
// directories have the same layout, so no link needs rewriting.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const root = fileURLToPath(new URL("../", import.meta.url));

export const docsDirectory = join(root, "docs");

export const skillDirectory = join(root, "skills", "effect-actions");

export interface SkillFile {
  /** Relative to the skill directory. */
  readonly path: string;
  readonly content: string;
}

export const frontmatter = `---
name: effect-actions
description: >
  Reference for @gjermundgaraba/effect-actions. Use when defining Effect action contracts
  (Action, ActionGroup), serving them over HTTP or MCP, projecting them into an Effect AI
  Toolkit or a CLI, exporting a catalog, wiring Authentication middleware, calling an
  ActionHttp binding with HttpApiClient, or testing those adapters in memory.
---

`;

export const renderSkill = (): ReadonlyArray<SkillFile> =>
  readdirSync(docsDirectory)
    .filter((name) => name.endsWith(".md"))
    .sort((left, right) => left.localeCompare(right))
    .map((name) => {
      const content = readFileSync(join(docsDirectory, name), "utf8");

      return name === "README.md"
        ? { path: "SKILL.md", content: `${frontmatter}${content}` }
        : { path: name, content };
    });
