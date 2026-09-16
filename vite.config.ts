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
      authentication: "src/Authentication.ts",
      testing: "src/Testing.ts",
      "testing/client": "src/TestingClient.ts",
    },
    deps: { resolveDepSubpath: true },
    dts: {
      generator: "tsgo",
    },
    exports: true,
  },
  lint: {
    ignorePatterns: [
      "dist/**",
      "scripts/package-consumer/**",
      "scripts/package-testing-consumer.ts",
    ],
    options: {
      typeAware: true,
      typeCheck: true,
    },
  },
});
