import { defaultExclude, defineConfig } from "vite-plus";
import { pack } from "./tools/pack.ts";

const sourceOrLintProbe = (glob: string) => [
  `src/${glob}`,
  `tools/oxlint/tests/probe-*/*/src/${glob}`,
];

const packageNameImport = {
  regex: "^@gjermundgaraba/effect-actions",
  message: "Source imports source by relative path.",
};

const anyRelativeImport = ["./**", "../**"];

const sharedPrivateFiles = [
  "authentication/provider.js",
  "authentication/refusal.js",
  "stdio/console.js",
];

export default defineConfig({
  staged: {
    "*": "vp check --fix",
  },
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: "effect-actions",
          include: [
            "tests/**/*.test.ts",
            "examples/**/*.test.ts",
            "tools/oxlint/tests/**/*.test.ts",
          ],
          exclude: [...defaultExclude, "tools/oxlint/tests/probe-*/**"],
        },
      },
      "packages/*",
    ],
  },
  pack: pack(),
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
      "skills/effect-actions/**",
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
        files: ["**/*.test.ts", "**/*.spec.ts"],
        rules: {
          "anti-slop-effect/no-manual-tag-comparison": "off",
          "anti-slop-effect/no-manual-tagged-construction": "off",
        },
      },
      {
        files: [...sourceOrLintProbe("**"), "packages/*/src/**"],
        rules: {
          "no-comments/no-prose-comments": ["error", { allowJsDoc: true, allowWhy: true }],
          "typescript/consistent-type-imports": "error",
          "typescript/no-import-type-side-effects": "error",
        },
      },
      {
        files: [
          "vite.config.ts",
          "packages/*/vite.config.ts",
          "tools/oxlint/tests/probe-*/*/vite.config.ts",
        ],
        rules: { "no-comments/no-prose-comments": ["error", { allowWhy: true }] },
      },
      {
        files: [
          "tests/support/**",
          "packages/*/tests/support/**",
          "tools/oxlint/tests/probe-*/*/tests/support/**",
        ],
        rules: { "no-comments/no-prose-comments": ["error", { allowJsDoc: true }] },
      },
      {
        files: sourceOrLintProbe("**"),
        rules: {
          "no-restricted-imports": [
            "error",
            {
              patterns: [
                packageNameImport,
                {
                  group: [
                    ...anyRelativeImport,
                    "!./*.js",
                    "!../[a-z]*/[A-Z]*.js",
                    "!../contract/*.js",
                    ...sharedPrivateFiles.map((file) => `!../${file}`),
                  ],
                  caseSensitive: true,
                  message: `A relative import is ./<file>.js, another domain's public ../<domain>/<Module>.js, the contract's, or a shared private file: ${sharedPrivateFiles.join(", ")}.`,
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
        files: ["packages/*/src/**"],
        rules: {
          "no-restricted-imports": [
            "error",
            {
              patterns: [
                {
                  group: [...anyRelativeImport, "!./*.js", "!../[a-z]*/[A-Z]*.js"],
                  caseSensitive: true,
                  message:
                    "A relative import is ./<file>.js or another domain's public ../<domain>/<Module>.js; the core is imported by its package name.",
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
