import ultracite from "ultracite/oxfmt";
import type { OxfmtConfig } from "vite-plus/fmt";

export default {
  ...ultracite,
  ignorePatterns: [
    ...(ultracite.ignorePatterns ?? []),
    "skills/effect-actions/**",
    "packages/cloudflare/examples/chat-rooms/src/env.d.ts",
    "tools/oxlint/tests/probe-*/**",
    "AGENTS.md",
  ],
} satisfies OxfmtConfig;
