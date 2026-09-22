import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Schema } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

// Probes of the effective configuration in vite.config.ts, through `vp lint` itself.
// Active-rule cases pair accepted and rejected fixtures; disabled-rule cases assert
// ordinary language features remain accepted through the effective configuration.

// Rule findings carry a `code`; toolchain diagnostics such as an unused directive carry only a message.
const Report = Schema.Struct({
  diagnostics: Schema.Array(
    Schema.Struct({
      code: Schema.optional(Schema.String),
      message: Schema.String,
      filename: Schema.String,
    }),
  ),
});

const decodeReport = Schema.decodeUnknownSync(Schema.fromJsonString(Report));

const root = fileURLToPath(new URL("../../../", import.meta.url));

// Inside the repository so the root vite.config.ts applies; outside every ignore pattern.
const probe = join(root, "tools/oxlint/tests", `probe-${process.pid}-${Date.now()}`);

const lintCodes = (files: Readonly<Record<string, string>>): ReadonlyArray<string> => {
  for (const [name, source] of Object.entries(files)) {
    writeFileSync(join(probe, name), source);
  }

  let stdout: string;

  try {
    stdout = execFileSync("vp", ["lint", "--format", "json", probe], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch (failure) {
    const withOutput = Schema.decodeUnknownSync(Schema.Struct({ stdout: Schema.String }))(failure);
    stdout = withOutput.stdout;
  }

  return decodeReport(stdout.slice(stdout.indexOf("{"))).diagnostics.map(
    (diagnostic) => diagnostic.code ?? diagnostic.message,
  );
};

describe("effective lint configuration", () => {
  beforeEach(() => mkdirSync(probe, { recursive: true }));
  afterEach(() => rmSync(probe, { recursive: true, force: true }));

  it("enforces unknown parameters regardless of their name", () => {
    expect(
      lintCodes({
        "typed.ts": "export const describe = (error: Error): string => error.message;\n",
        "cause.ts": "export const wrap = (cause: unknown): Error => new Error('x', { cause });\n",
      }),
    ).toEqual(["anti-slop(no-unknown-parameters)"]);
  });

  it("recognizes module mocking through the Vite+ test import", () => {
    expect(
      lintCodes({
        "spy.test.ts": "import { vi } from 'vite-plus/test';\n\nexport const spy = vi.fn();\n",
        "mock.test.ts": "import { vi } from 'vite-plus/test';\n\nvi.mock('./users.js');\n",
      }),
    ).toEqual(["anti-slop(no-module-mocking)"]);
  });

  it("allows ordinary typeof narrowing as well as type predicates", () => {
    expect(
      lintCodes({
        "guard.ts":
          "export const isText = (value: unknown): value is string => typeof value === 'string';\n",
        "branch.ts":
          "export const label = (value: string | number) => (typeof value === 'string' ? value : '');\n",
      }),
    ).toEqual([]);
  });

  it("allows intentional compiler-checked widening", () => {
    expect(
      lintCodes({
        "precise.ts": [
          "declare function load(): { readonly id: number };",
          "",
          "type Keys = 'a' | 'b';",
          "",
          "declare function isUser(value: { readonly id: number } | null): value is { readonly id: number };",
          "",
          "const { user } = { user: load() };",
          "",
          "export const widened: unknown = user;",
          "",
          "export const table: { readonly [K in Keys]: number } = { a: 1, b: 2 };",
          "",
          "export const ok = isUser({ id: 1 });",
          "",
        ].join("\n"),
        "widened.ts": [
          "const { user } = { user: { id: 1 } };",
          "",
          "export const widened: unknown = user;",
          "",
        ].join("\n"),
      }),
    ).toEqual([]);
  });

  it("reports an unused disable directive as an error", () => {
    expect(
      lintCodes({
        "used.ts": [
          "// oxlint-disable-next-line anti-slop/no-unknown-parameters -- Probe of a justified directive.",
          "export const describe = (error: unknown): string => String(error);",
          "",
        ].join("\n"),
        "unused.ts": [
          "// oxlint-disable-next-line anti-slop/no-unknown-parameters -- Probe of a stale directive.",
          "export const describe = (error: Error): string => error.message;",
          "",
        ].join("\n"),
      }),
    ).toEqual(["Unused oxlint-disable directive (no problems were reported)."]);
  });

  it("checks maintained JavaScript with the same rules", () => {
    expect(
      lintCodes({
        "typed.mjs":
          "/** @param {string} value */\nexport const label = (value) => value.trim();\n",
        "probe.mjs": "export const copy = [1, 2].reduce((acc, value) => [...acc, value], []);\n",
      }),
    ).toEqual(["oxc(no-accumulating-spread)"]);
  });

  it("keeps the expression-style rules deliberately disabled", () => {
    expect(
      lintCodes({
        "off.ts": [
          "export const doubled = [1, 2, 3].filter((value) => value > 1).map((value) => value * 2);",
          "",
          "export const options = (base: { readonly id: string }, flag: boolean) => ({",
          "  ...base,",
          "  ...(flag ? { flag } : {}),",
          "});",
          "",
          "export const shape = { kind: 'user' };",
          "",
        ].join("\n"),
      }),
    ).toEqual([]);
  });
});
