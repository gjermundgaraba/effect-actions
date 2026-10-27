import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "@effect/vitest";

import { renderSkill, skillDirectory } from "../scripts/skill.ts";
import { captured } from "./support/captured.js";

const sorted = (names: readonly string[]) =>
  names.toSorted((left, right) => left.localeCompare(right));

describe("the effect-actions skill", () => {
  it("keeps skills/effect-actions equal to docs/ (run `vp run docs:sync`)", () => {
    const expected = renderSkill();

    expect(sorted(readdirSync(skillDirectory))).toStrictEqual(
      sorted(expected.map((file) => file.path))
    );

    for (const file of expected) {
      expect(
        readFileSync(path.join(skillDirectory, file.path), "utf-8"),
        file.path
      ).toBe(file.content);
    }
  });

  it("links each page of the skill only to pages the skill holds, and to the installed examples", () => {
    const rendered = renderSkill();
    const held = new Set(rendered.map((file) => file.path));

    const missing = rendered.flatMap((file) =>
      Array.from(
        file.content.matchAll(
          /\]\((?!https?:|mailto:|node_modules\/)(?<target>[^)#\s]+\.md)/gu
        ),
        (match) => captured(match, "target")
      )
        .filter((target) => !held.has(target))
        .map((target) => `${file.path} links ${target}`)
    );

    expect(missing).toStrictEqual([]);
  });
});
