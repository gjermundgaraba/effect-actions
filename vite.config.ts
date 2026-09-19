import { defineConfig } from "vite-plus";

export default defineConfig({
  staged: {
    "*": "vp check --fix",
  },
  test: {
    include: ["tests/**/*.test.ts", "tools/oxlint/tests/**/*.test.ts"],
  },
  pack: {
    entry: {
      Action: "src/Action.ts",
      ActionGroup: "src/ActionGroup.ts",
      ActionHttp: "src/ActionHttp.ts",
      ActionMcp: "src/ActionMcp.ts",
      Authentication: "src/Authentication.ts",
      Testing: "src/Testing.ts",
      TestingClient: "src/TestingClient.ts",
    },
    // Preserve module boundaries for JS and declarations. Bundled declarations
    // currently emit a dangling __exportAll export with this toolchain.
    unbundle: true,
    deps: { resolveDepSubpath: true },
    dts: {
      generator: "tsgo",
    },
    exports: true,
  },
  fmt: {
    ignorePatterns: [
      ".agent/**",
      ".agents/**",
      ".claude/**",
      ".codex/**",
      ".continue/**",
      ".cursor/**",
      ".gemini/**",
      ".opencode/**",
      ".pi/**",
      ".roo/**",
      ".windsurf/**",
      "tools/oxlint/anti-slop/**",
    ],
  },
  lint: {
    // Lint policy: docs/lint-policy.md. Only build output, agent caches and the
    // vendored plugin are excluded; every owned source, test and script is checked.
    ignorePatterns: [
      "dist/**",
      ".agent/**",
      ".agents/**",
      ".claude/**",
      ".codex/**",
      ".continue/**",
      ".cursor/**",
      ".gemini/**",
      ".opencode/**",
      ".pi/**",
      ".roo/**",
      ".windsurf/**",
      "tools/oxlint/anti-slop/**",
    ],
    jsPlugins: [
      { name: "anti-slop", specifier: "./tools/oxlint/anti-slop/index.ts" },
      {
        name: "anti-slop-effect",
        specifier: "./tools/oxlint/anti-slop/effect/index.ts",
      },
    ],
    options: {
      typeAware: true,
      typeCheck: true,
      denyWarnings: true,
      // An exception that no longer suppresses anything is a defect, not a leftover.
      reportUnusedDisableDirectives: "deny",
    },
    rules: {
      "oxc/no-accumulating-spread": "error",
      // Off: both forms are linear; rewrites change callback order and sparse-array
      // semantics without establishing a performance gain.
      "anti-slop/no-array-filter-map": "off",
      "anti-slop/no-reduce-accumulator-copy": "error",
      "anti-slop/no-chained-type-assertions": "error",
      // Off: conditional spread preserves omission semantics without mutable builders.
      "anti-slop/no-conditional-empty-object-spread": "off",
      "anti-slop/no-known-value-widening": "error",
      "anti-slop/no-module-mocking": "error",
      "anti-slop/no-object-parameters": "error",
      "anti-slop/no-reflect-apply": "error",
      "anti-slop/no-reflect-get": "error",
      // Genuine type predicates decode a value; discrimination of an already typed union
      // takes a narrow explained exception instead.
      "anti-slop/no-runtime-typeof": ["error", { allowInTypeGuards: true }],
      // Off: a substring cannot establish domain ownership; naming is reviewed by people.
      "anti-slop/no-shape-in-symbol-names": "off",
      "anti-slop/no-unknown-parameters": "error",
      "anti-slop/no-unknown-returns": "error",
      "anti-slop/no-unknown-type-aliases": "error",
      "anti-slop/no-unsafe-dictionary-type": "error",
      "anti-slop/no-widen-then-assert": "error",
      "anti-slop/require-readable-spacing": "error",
      "anti-slop/require-safety-comment-for-type-assertion": "error",
      // `any` escape routes the syntactic rules cannot see: untyped JSON, SDK generics,
      // callback registries. Independent of safety comments.
      "typescript/no-unsafe-argument": "error",
      "typescript/no-unsafe-assignment": "error",
      "typescript/no-unsafe-call": "error",
      "typescript/no-unsafe-member-access": "error",
      "typescript/no-unsafe-return": "error",
      "typescript/no-unsafe-type-assertion": "error",
      "anti-slop-effect/no-manual-effect-error-tag": "error",
      "anti-slop-effect/no-manual-tag-comparison": "error",
      "anti-slop-effect/no-manual-tagged-construction": "error",
      "anti-slop-effect/no-service-constructor-imports": "error",
      "anti-slop-effect/prefer-effect-match": "error",
    },
  },
});
