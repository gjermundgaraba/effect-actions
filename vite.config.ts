import { globSync } from "node:fs";
import { basename } from "node:path";
import { defaultExclude, defineConfig } from "vite-plus";

const publicModules = Object.fromEntries(
  globSync("src/*/*.ts")
    .map((path): [string, string] => [basename(path, ".ts"), path])
    .filter(([module]) => /^[A-Z]/u.test(module)),
);

const sourceOrLintProbe = (glob: string) => [
  `src/${glob}`,
  `tools/oxlint/tests/probe-*/*/src/${glob}`,
];

const packageNameImport = {
  regex: "^@gjermundgaraba/effect-actions",
  message: "Source imports source by relative path.",
};

const anyRelativeImport = ["./**", "../**"];

export default defineConfig({
  staged: {
    "*": "vp check --fix",
  },
  test: {
    include: ["tests/**/*.test.ts", "tools/oxlint/tests/**/*.test.ts"],
    exclude: [...defaultExclude, "tools/oxlint/tests/probe-*/**"],
  },
  pack: {
    entry: publicModules,
    unbundle: true,
    deps: { resolveDepSubpath: true },
    dts: {
      generator: "tsgo",
    },
    exports: { devExports: true },
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
      "tools/oxlint/tests/probe-*/**",
    ],
  },
  lint: {
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
      ...(process.env["LINT_PROBE"] === undefined ? ["tools/oxlint/tests/probe-*/**"] : []),
    ],
    jsPlugins: [
      { name: "anti-slop", specifier: "./tools/oxlint/anti-slop/index.ts" },
      {
        name: "anti-slop-effect",
        specifier: "./tools/oxlint/anti-slop/effect/index.ts",
      },
      { name: "no-comments", specifier: "./tools/oxlint/no-comments/index.ts" },
    ],
    options: {
      typeAware: true,
      typeCheck: true,
      denyWarnings: true,
      reportUnusedDisableDirectives: "deny",
    },
    rules: {
      "oxc/no-accumulating-spread": "error",
      "anti-slop/no-array-filter-map": "off",
      "anti-slop/no-reduce-accumulator-copy": "error",
      "anti-slop/no-chained-type-assertions": "error",
      "anti-slop/no-conditional-empty-object-spread": "off",
      "anti-slop/no-known-value-widening": "error",
      "anti-slop/no-module-mocking": "error",
      "anti-slop/no-object-parameters": "error",
      "anti-slop/no-reflect-apply": "error",
      "anti-slop/no-reflect-get": "error",
      "anti-slop/no-runtime-typeof": ["error", { allowInTypeGuards: true }],
      "anti-slop/no-shape-in-symbol-names": "off",
      "anti-slop/no-unknown-parameters": "error",
      "anti-slop/no-unknown-returns": "error",
      "anti-slop/no-unknown-type-aliases": "error",
      "anti-slop/no-unsafe-dictionary-type": "error",
      "anti-slop/no-widen-then-assert": "off",
      "anti-slop/require-readable-spacing": "error",
      "anti-slop/require-safety-comment-for-type-assertion": "off",
      "typescript/no-unsafe-argument": "error",
      "typescript/no-unsafe-assignment": "error",
      "typescript/no-unsafe-call": "error",
      "typescript/no-unsafe-member-access": "error",
      "typescript/no-unsafe-return": "error",
      "typescript/no-unsafe-type-assertion": "error",
      "anti-slop-effect/no-manual-effect-error-tag": "error",
      "anti-slop-effect/no-manual-tag-comparison": "error",
      "anti-slop-effect/no-manual-tagged-construction": "error",
      "anti-slop-effect/no-service-constructor-imports": "off",
      "anti-slop-effect/prefer-effect-match": "error",
      "no-comments/no-prose-comments": "error",
    },
    overrides: [
      {
        files: sourceOrLintProbe("**"),
        rules: {
          "no-comments/no-prose-comments": ["error", { allowJsDoc: true }],
          "typescript/consistent-type-imports": "error",
          "typescript/no-import-type-side-effects": "error",
          "no-restricted-imports": [
            "error",
            {
              patterns: [
                packageNameImport,
                {
                  group: [
                    ...anyRelativeImport,
                    "!./*.js",
                    "!../[a-z]*/[a-z]*.js",
                    "!../contract/*.js",
                  ],
                  caseSensitive: true,
                  message:
                    "A relative import is ./<file>.js, another domain's private ../<domain>/<file>.js, or the contract's.",
                },
              ],
            },
          ],
        },
      },
      {
        files: sourceOrLintProbe("contract/**"),
        rules: {
          "no-restricted-imports": [
            "error",
            {
              patterns: [
                packageNameImport,
                {
                  group: [...anyRelativeImport, "!./*.js"],
                  message: "src/contract imports nothing outside itself: ./<file>.js alone.",
                },
              ],
            },
          ],
        },
      },
      {
        files: ["examples/**"],
        rules: { "no-comments/no-prose-comments": "off" },
      },
    ],
  },
});
