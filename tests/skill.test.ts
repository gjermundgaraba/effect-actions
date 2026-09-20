import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vite-plus/test";
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
