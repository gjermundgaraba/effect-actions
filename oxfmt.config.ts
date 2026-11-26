import ultracite from "ultracite/oxfmt";
import type { OxfmtConfig } from "vite-plus/fmt";

export default {
  ...ultracite,
  ignorePatterns: [
    ...(ultracite.ignorePatterns ?? []),
    "skills/effect-actions/**",
    "tools/oxlint/tests/probe-*/**",
    "AGENTS.md",
  ],
} satisfies OxfmtConfig;
