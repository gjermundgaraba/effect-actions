import { describe, it } from "vite-plus/test";
import { RuleTester } from "vite-plus/lint/plugins-dev";
import { noKnownValueWideningRule } from "../anti-slop/rules/no-known-value-widening.ts";
import { noModuleMockingRule } from "../anti-slop/rules/no-module-mocking.ts";
import { noRuntimeTypeofRule } from "../anti-slop/rules/no-runtime-typeof.ts";
import { noUnknownParametersRule } from "../anti-slop/rules/no-unknown-parameters.ts";

// Regression tests for the local corrections recorded in ../anti-slop/UPSTREAM.md.
// Each probe pairs an accepted case with a case the rule must still reject.

RuleTester.describe = describe;

RuleTester.it = it;

const tester = new RuleTester({
  languageOptions: { sourceType: "module", parserOptions: { lang: "ts" } },
});

tester.run("no-unknown-parameters", noUnknownParametersRule, {
  valid: [
    "function describe(error: Error): string { return error.message; }",
    "function isUser(value: unknown): value is { id: string } { return typeof value === 'object'; }",
  ],
  invalid: [
    {
      name: "a parameter named cause receives the same enforcement as any other spelling",
      code: "function wrap(cause: unknown): Error { return new Error('x', { cause }); }",
      errors: [{ messageId: "unknownParameter", data: { parameter: "cause" } }],
    },
    {
      code: "function describe(error: unknown): string { return String(error); }",
      errors: [{ messageId: "unknownParameter", data: { parameter: "error" } }],
    },
  ],
});

tester.run("no-module-mocking", noModuleMockingRule, {
  valid: [
    "import { vi } from 'vite-plus/test'; vi.fn();",
    "import { vi } from 'vite-plus/test'; vi.spyOn(console, 'log');",
  ],
  invalid: [
    {
      name: "the Vite+ re-export of vi is recognized",
      code: "import { vi } from 'vite-plus/test'; vi.mock('./users.js');",
      errors: [{ messageId: "moduleMock" }],
    },
    {
      code: "import { vi } from 'vitest'; vi.doMock('./users.js');",
      errors: [{ messageId: "moduleMock" }],
    },
  ],
});

tester.run("no-runtime-typeof", noRuntimeTypeofRule, {
  valid: [
    {
      name: "a type predicate may probe its subject when allowed",
      code: "function isText(value: unknown): value is string { return typeof value === 'string'; }",
      options: [{ allowInTypeGuards: true }],
    },
  ],
  invalid: [
    {
      name: "outside a type predicate typeof is still rejected when predicates are allowed",
      code: "function label(value: string | number) { return typeof value === 'string' ? value : ''; }",
      options: [{ allowInTypeGuards: true }],
      errors: [{ messageId: "runtimeTypeof" }],
    },
    {
      code: "function isText(value: unknown): value is string { return typeof value === 'string'; }",
      errors: [{ messageId: "runtimeTypeof" }],
    },
  ],
});

tester.run("no-known-value-widening", noKnownValueWideningRule, {
  valid: [
    {
      name: "a destructured binding carries its own property's evidence, not the object's",
      code: [
        "declare function load(): { readonly id: string };",
        "const { user } = { user: load() };",
        "const widened: unknown = user;",
      ].join("\n"),
    },
    {
      name: "an element selected from an array literal carries only that element's evidence",
      code: [
        "declare function load(): number;",
        "const [first] = [load(), 2];",
        "const widened: unknown = first;",
      ].join("\n"),
    },
    {
      name: "a spread may supply or override the selected property",
      code: [
        "declare const extra: { readonly user: number };",
        "const { user } = { user: { id: 1 }, ...extra };",
        "const widened: unknown = user;",
      ].join("\n"),
    },
    {
      name: "a dynamic key may be the selected property and override it",
      code: [
        "declare const dynamic: string;",
        "declare function load(): { readonly id: number };",
        "const { user } = { user: { id: 1 }, [dynamic]: load() };",
        "const widened: unknown = user;",
      ].join("\n"),
    },
    {
      name: "a precise inline object keeps its inference",
      code: "const settings = { retries: 3 }; const copy = { ...settings };",
    },
    {
      name: "a mapped type over a finite key set is a precise shape",
      code: "type Keys = 'a' | 'b'; const table: { readonly [K in Keys]: number } = { a: 1, b: 2 };",
    },
    {
      name: "a typed predicate call does not widen its argument",
      code: [
        "declare function isUser(value: { readonly id: number } | null): value is { readonly id: number };",
        "const candidate = { id: 1 };",
        "const ok = isUser(candidate);",
      ].join("\n"),
    },
  ],
  invalid: [
    {
      name: "a destructured literal property is still known evidence",
      code: ["const { user } = { user: { id: 1 } };", "const widened: unknown = user;"].join("\n"),
      errors: [{ messageId: "widening" }],
    },
    {
      name: "an element that is a literal is still known evidence",
      code: ["const [first] = [{ id: 1 }, 2];", "const widened: unknown = first;"].join("\n"),
      errors: [{ messageId: "widening" }],
    },
    {
      code: "const settings = { retries: 3 }; const widened: Record<string, unknown> = settings;",
      errors: [{ messageId: "widening" }],
    },
    {
      name: "a mapped type over string is still an open dictionary",
      code: "const table: { [K in string]: number } = { a: 1, b: 2 };",
      errors: [{ messageId: "widening" }],
    },
  ],
});
