import { readFileSync } from "node:fs";

import { describe, expect, it } from "@effect/vitest";

const workspace = readFileSync(
  new URL("../pnpm-workspace.yaml", import.meta.url),
  "utf-8"
);

describe("pnpm-workspace.yaml", () => {
  it("names the directories pnpm links Ultracite's skill into, since pnpm otherwise detects an agent and fails the install where none is, as in a Docker build", () => {
    expect(workspace).toMatch(/^skills:\n {2}dirs:\n {4}- \S/mu);
  });
});
