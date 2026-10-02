import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Schema } from "effect";
import { afterAll, beforeAll, expect, it } from "@effect/vitest";

// Probes of the effective configuration in vite.config.ts, through one `vp lint` run itself.
// Each case pairs an accepted fixture with one the toolchain must still reject, so a
// passing run proves a rule is registered and active, not merely named.

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

/** Each case's fixtures, and the findings `vp lint` reports in them, as `file: code`. */
const cases = [
  {
    name: "enforces unknown parameters regardless of their name",
    files: {
      "typed.ts": "export const describe = (error: Error): string => error.message;\n",
      "cause.ts": "export const wrap = (cause: unknown): Error => new Error('x', { cause });\n",
    },
    findings: ["cause.ts: anti-slop(no-unknown-parameters)"],
  },
  {
    name: "recognizes module mocking through the repository's test import",
    files: {
      "spy.test.ts": "import { vi } from '@effect/vitest';\n\nexport const spy = vi.fn();\n",
      "mock.test.ts": "import { vi } from '@effect/vitest';\n\nvi.mock('./users.js');\n",
    },
    findings: ["mock.test.ts: anti-slop(no-module-mocking)"],
  },
  {
    name: "allows typeof only inside type predicates",
    files: {
      "guard.ts":
        "export const isText = (value: unknown): value is string => typeof value === 'string';\n",
      "branch.ts":
        "export const label = (value: string | number) => (typeof value === 'string' ? value : '');\n",
    },
    findings: ["branch.ts: anti-slop(no-runtime-typeof)"],
  },
  {
    name: "keeps literal evidence precise without rejecting precise shapes",
    files: {
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
    },
    findings: ["widened.ts: anti-slop(no-known-value-widening)"],
  },
  {
    name: "reports an unused disable directive as an error",
    files: {
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
    },
    findings: ["unused.ts: Unused oxlint-disable directive (no problems were reported)."],
  },
  {
    name: "checks maintained JavaScript with the same rules",
    files: {
      "typed.mjs": "/** @param {string} value */\nexport const label = (value) => value.trim();\n",
      "probe.mjs":
        "/** @param {string | number} value */\nexport const isText = (value) => typeof value === 'string';\n",
    },
    findings: ["probe.mjs: anti-slop(no-runtime-typeof)"],
  },
] as const;

/** Every finding of the one run, as `file: code` within its case's directory. */
let reported: ReadonlyArray<{ readonly directory: string; readonly finding: string }> = [];

beforeAll(() => {
  cases.forEach(({ files }, index) => {
    mkdirSync(join(probe, `${index}`), { recursive: true });

    for (const [name, source] of Object.entries(files)) {
      writeFileSync(join(probe, `${index}`, name), source);
    }
  });

  // A finding is a non-zero exit; the report is on stdout either way.
  const { stdout } = spawnSync("vp", ["lint", "--format", "json", probe], {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });

  reported = decodeReport(stdout.slice(stdout.indexOf("{"))).diagnostics.map((diagnostic) => {
    const file = relative(probe, resolve(root, diagnostic.filename));

    return {
      directory: dirname(file),
      finding: `${basename(file)}: ${diagnostic.code ?? diagnostic.message}`,
    };
  });
});

afterAll(() => rmSync(probe, { recursive: true, force: true }));

it.each(cases.map(({ name, findings }, index) => ({ name, findings, index })))(
  "$name",
  ({ findings, index }) => {
    expect(
      reported.flatMap(({ directory, finding }) => (directory === `${index}` ? [finding] : [])),
    ).toEqual(findings);
  },
);
