import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));

export const docsDirectory = path.join(root, "docs");

export const examplesDirectory = path.join(root, "examples");

export const skillDirectory = path.join(root, "skills", "effect-actions");

interface SkillFile {
  readonly path: string;
  readonly content: string;
}

const frontmatter = `---
name: effect-actions
description: >
  Use when implementing, integrating, or testing @gjermundgaraba/effect-actions,
  which defines Effect action contracts once for HTTP, MCP, Effect RPC, native Toolkits, and CLIs.
  These pages follow the repository's main branch, which can be ahead of the latest
  release. Their links to the example applications are paths from the root of a project that
  installs the package, node_modules/@gjermundgaraba/effect-actions/examples/; the same pages at
  the installed version are in node_modules/@gjermundgaraba/effect-actions/docs/.
---

`;

const linkInstalledExamples = (page: string) =>
  page.replaceAll(
    "](../examples/",
    "](node_modules/@gjermundgaraba/effect-actions/examples/"
  );

const linkSkillEntry = (page: string) =>
  page.replaceAll("[README.md](README.md", "[SKILL.md](SKILL.md");

export const renderSkill = (): readonly SkillFile[] =>
  readdirSync(docsDirectory)
    .filter((name) => name.endsWith(".md"))
    .toSorted((left, right) => left.localeCompare(right))
    .map((name) => {
      const content = linkSkillEntry(
        linkInstalledExamples(
          readFileSync(path.join(docsDirectory, name), "utf-8")
        )
      );

      return name === "README.md"
        ? { path: "SKILL.md", content: `${frontmatter}${content}` }
        : { path: name, content };
    });
