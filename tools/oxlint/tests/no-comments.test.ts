import { describe, it } from "@effect/vitest";
import { RuleTester } from "vite-plus/lint/plugins-dev";
import { noProseCommentsRule } from "../no-comments/rules/no-prose-comments.ts";

RuleTester.describe = describe;

RuleTester.it = it;

const jsDoc = [{ allowJsDoc: true }];

const prose = [{ messageId: "prose" }];

const reasonless = (directive: string) => [
  { messageId: "reasonlessDirective", data: { directive } },
];

const tester = new RuleTester({
  languageOptions: { sourceType: "module", parserOptions: { lang: "ts" } },
});

tester.run("no-prose-comments", noProseCommentsRule, {
  valid: [
    {
      name: "a TypeScript directive with its reason after --",
      code: "// @ts-expect-error -- The argument is required.\nload();\n",
    },
    {
      name: "an oxlint directive with its reason after --",
      code: "// oxlint-disable-next-line anti-slop/no-reflect-get -- Getter semantics.\nload();\n",
    },
    {
      name: "JSDoc on a declaration, a member and a local, with allowJsDoc",
      options: jsDoc,
      code: [
        "/** Options. */",
        "export interface Options {",
        "  /** The base URL. */",
        "  readonly baseUrl: string;",
        "}",
        "/** Loads. */",
        "function load(): number {",
        "  /** The answer. */",
        "  const answer = 42;",
        "  return answer;",
        "}",
        "export const run = load;",
      ].join("\n"),
    },
    {
      name: "a shebang",
      code: "#!/usr/bin/env node\nexport const ready = true;\n",
    },
  ],
  invalid: [
    {
      name: "a line comment of prose, with allowJsDoc",
      options: jsDoc,
      code: "// Loads the user.\nexport const load = () => 1;\n",
      errors: prose,
    },
    {
      name: "a block comment of prose, with allowJsDoc",
      options: jsDoc,
      code: "/* Loads the user. */\nexport const load = () => 1;\n",
      errors: prose,
    },
    {
      name: "a trailing comment of prose",
      code: "export const load = () => 1; // Loads the user.\n",
      errors: prose,
    },
    {
      name: "JSDoc without allowJsDoc",
      code: "/** Options. */\nexport interface Options {\n  /** The base URL. */\n  readonly baseUrl: string;\n}\n",
      errors: [{ messageId: "prose" }, { messageId: "prose" }],
    },
    {
      name: "a TypeScript directive whose reason lacks --",
      code: "// @ts-expect-error The argument is required.\nload();\n",
      errors: reasonless("@ts-expect-error"),
    },
    {
      name: "an oxlint directive without a reason",
      code: "// oxlint-disable-next-line anti-slop/no-reflect-get\nload();\n",
      errors: reasonless("oxlint-disable-next-line anti-slop/no-reflect-get"),
    },
    {
      name: "a block-form TypeScript directive, with allowJsDoc",
      options: jsDoc,
      code: "/* @ts-expect-error -- Probe. */\nload();\n",
      errors: prose,
    },
    {
      name: "an oxlint disable and enable pair",
      code: [
        "// oxlint-disable anti-slop/no-reflect-get -- Getter semantics.",
        "load();",
        "// oxlint-enable anti-slop/no-reflect-get -- Getter semantics end.",
      ].join("\n"),
      errors: [{ messageId: "prose" }, { messageId: "prose" }],
    },
  ],
});
