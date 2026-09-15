import { readFileSync } from "node:fs";
import { expect, it } from "vite-plus/test";

it("keeps the README client example aligned with its type-checked source", () => {
  const source = readFileSync(new URL("../examples/client.ts", import.meta.url), "utf8")
    .trim()
    .replace("../src/index.js", "effect-actions");
  const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
  const section = readme.split("### Action-shaped HTTP client")[1];
  const snippet = section?.match(/\x60{3}ts\n([\s\S]*?)\n\x60{3}/)?.[1];
  expect(snippet).toBe(source);
});
