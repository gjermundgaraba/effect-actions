// Renders the agent skill as a copy of `docs/`. Every page is copied unchanged;
// `docs/README.md` becomes `SKILL.md` with the skill frontmatter prepended. The two
// directories have the same layout, so no link needs rewriting.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));

export const docsDirectory = join(root, "docs");

export const skillDirectory = join(root, "skills", "effect-actions");

interface SkillFile {
  /** Relative to the skill directory. */
  readonly path: string;
  readonly content: string;
}

// The skill's header. Its pages follow the main branch, so it sends a project that installs the
// package to the installed version's own docs/.
const frontmatter = `---
name: effect-actions
description: >
  Use when implementing, integrating, or testing @gjermundgaraba/effect-actions,
  which defines Effect action contracts once for HTTP, MCP, native Toolkits, and CLIs.
  These pages follow the repository's main branch, which can be ahead of the latest
  release; where the package is installed, read the same pages in
  node_modules/@gjermundgaraba/effect-actions/docs/, which describe the installed version.
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
