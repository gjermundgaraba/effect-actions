import { defaultExclude, defineConfig } from "vite-plus";

import fmt from "./oxfmt.config.ts";
import lint from "./oxlint.config.ts";
import { pack } from "./tools/pack.ts";

export default defineConfig({
  fmt,
  lint,
  pack: pack(),
  staged: {
    "*": "vp check --fix",
  },
  test: {
    projects: [
      {
        extends: true,
        test: {
          exclude: [...defaultExclude, "tools/oxlint/tests/probe-*/**"],
          include: [
            "tests/**/*.test.ts",
            "examples/**/*.test.ts",
            "tools/oxlint/tests/**/*.test.ts",
          ],
          name: "effect-actions",
        },
      },
      "packages/*",
      "packages/*/examples/*",
    ],
  },
});
