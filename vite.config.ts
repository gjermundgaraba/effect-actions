import { defineConfig } from "vite-plus";

export default defineConfig({
  staged: {
    "*": "vp check --fix",
  },
  test: {
    include: ["tests/**/*.test.ts"],
  },
  pack: {
    entry: {
      index: "src/index.ts",
      Action: "src/Action.ts",
      ActionGroup: "src/ActionGroup.ts",
      http: "src/ActionHttp.ts",
      mcp: "src/ActionMcp.ts",
    },
    deps: { resolveDepSubpath: true },
    dts: {
      generator: "tsgo",
    },
    exports: true,
  },
  lint: {
    ignorePatterns: ["docs/research/**", "dist/**"],
    options: {
      typeAware: true,
      typeCheck: true,
    },
  },
  fmt: {},
});
