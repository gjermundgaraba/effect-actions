import { defineConfig } from "oxfmt";
import ultracite from "ultracite/oxfmt";

export default defineConfig({
  ...ultracite,
  ignorePatterns: [
    ...(ultracite.ignorePatterns ?? []),
    // `vp run docs:sync` generates the skill from docs/.
    "skills/effect-actions/**",
    // `wrangler types` writes it.
    "packages/cloudflare/examples/chat-rooms/src/env.d.ts",
    // The import-fence test writes its probes here mid-run.
    "tools/oxlint/tests/probe-*/**",
    // `vp config` writes the Vite+ block of AGENTS.md on every install; Ultracite would rewrap it.
    "AGENTS.md",
  ],
});
