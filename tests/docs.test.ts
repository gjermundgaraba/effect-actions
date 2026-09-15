import { readFileSync } from "node:fs";
import { expect, it } from "vite-plus/test";

it.each([
  ["## Quickstart", "quickstart.ts"],
  ["## HTTP client", "client.ts"],
])("keeps %s aligned with its type-checked source", (heading, file) => {
  const source = readFileSync(new URL(`../examples/${file}`, import.meta.url), "utf8")
    .trim()
    .replace("../src/index.js", "@gjermundgaraba/effect-actions");
  const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
  const section = readme.split(heading)[1];
  const snippet = section?.match(/\x60{3}ts\n([\s\S]*?)\n\x60{3}/)?.[1];
  expect(snippet).toBe(source);
});
