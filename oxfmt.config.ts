import { defineConfig } from "oxfmt";
import ultracite from "ultracite/oxfmt";

export default defineConfig({
  ...ultracite,
  ignorePatterns: [
    ...(ultracite.ignorePatterns ?? []),
    "skills/effect-actions/**",
    "packages/cloudflare/examples/chat-rooms/src/env.d.ts",
    "tools/oxlint/tests/probe-*/**",
    "AGENTS.md",
  ],
});
