import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "@effect/vitest";
import { renderSkill, skillDirectory } from "../scripts/skill.ts";

const sorted = (names: ReadonlyArray<string>) =>
  [...names].sort((left, right) => left.localeCompare(right));

it("keeps skills/effect-actions equal to docs/ (run `vp run docs:sync`)", () => {
  const expected = renderSkill();

  expect(sorted(readdirSync(skillDirectory))).toEqual(sorted(expected.map((file) => file.path)));

  for (const file of expected) {
    expect(readFileSync(join(skillDirectory, file.path), "utf8"), file.path).toBe(file.content);
  }
});

it("links each page of the skill only to pages the skill holds, and to the installed examples", () => {
  const rendered = renderSkill();
  const held = new Set(rendered.map((file) => file.path));

  const missing = rendered.flatMap((file) =>
    Array.from(
      file.content.matchAll(/\]\((?!https?:|mailto:|node_modules\/)([^)#\s]+\.md)/g),
      ([, target = ""]) => target,
    )
      .filter((target) => !held.has(target))
      .map((target) => `${file.path} links ${target}`),
  );

  expect(missing).toEqual([]);
});
