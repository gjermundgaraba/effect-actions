import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { Schema } from "effect";
import { afterAll, beforeAll, expect, it } from "@effect/vitest";

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

const probe = join(root, "tools/oxlint/tests", `probe-${process.pid}-${Date.now()}`);

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
    name: "bans prose comments while keeping reasoned directives",
    files: {
      "named.ts": [
        "// oxlint-disable-next-line anti-slop/no-unknown-parameters -- Probe of a justified directive.",
        "export const describe = (error: unknown): string => String(error);",
        "",
      ].join("\n"),
      "prose.ts":
        "// Describes an error.\nexport const describe = (error: Error): string => error.message;\n",
    },
    findings: ["prose.ts: no-comments(no-prose-comments)"],
  },
  {
    name: "allows JSDoc in source alone, and there reports every relative import but the allowed forms",
    files: {
      "documented.ts": "/** A constant. */\nexport const documented = 1;\n",
      "src/contract/Action.ts": "/** A contract. */\nexport const action = 1;\n",
      "src/contract/named.ts": 'export * as Action from "@gjermundgaraba/effect-actions/Action";\n',
      "src/contract/outside.ts": 'export { protocol } from "../mcp/protocol.js";\n',
      "src/contract/spelled.ts": 'export { action } from "././Action.js";\n',
      "src/mcp/ActionMcp.ts": "export const mcp = 1;\n",
      "src/mcp/protocol.ts": "export const protocol = 1;\n",
      "src/http/allowed.ts": [
        'export { action } from "../contract/Action.js";',
        "",
        'export { protocol } from "../mcp/protocol.js";',
        "",
      ].join("\n"),
      "src/http/inline.ts": [
        'import { type protocol } from "../mcp/protocol.js";',
        "",
        "export type Inline = typeof protocol;",
        "",
      ].join("\n"),
      "src/http/named.ts": 'export * as Action from "@gjermundgaraba/effect-actions/Action";\n',
      "src/http/outside.ts": 'export { documented } from "../../documented.js";\n',
      "src/http/public.ts": 'export { mcp } from "../mcp/ActionMcp.js";\n',
      "src/http/slashed.ts": 'export { protocol } from "../mcp//protocol.js";\n',
      "src/http/spelled.ts": 'export { protocol } from "./../mcp/protocol.js";\n',
      "src/http/typed.ts": 'export type Protocol = typeof import("../mcp/protocol.js");\n',
    },
    findings: [
      "documented.ts: no-comments(no-prose-comments)",
      "src/contract/named.ts: eslint(no-restricted-imports)",
      "src/contract/outside.ts: eslint(no-restricted-imports)",
      "src/contract/spelled.ts: eslint(no-restricted-imports)",
      "src/http/inline.ts: typescript(no-import-type-side-effects)",
      "src/http/named.ts: eslint(no-restricted-imports)",
      "src/http/outside.ts: eslint(no-restricted-imports)",
      "src/http/public.ts: eslint(no-restricted-imports)",
      "src/http/slashed.ts: eslint(no-restricted-imports)",
      "src/http/spelled.ts: eslint(no-restricted-imports)",
      "src/http/typed.ts: typescript(consistent-type-imports)",
    ],
  },
] as const;

let reported: ReadonlyArray<{ readonly directory: string; readonly finding: string }> = [];

beforeAll(() => {
  cases.forEach(({ files }, index) => {
    for (const [name, source] of Object.entries(files)) {
      mkdirSync(dirname(join(probe, `${index}`, name)), { recursive: true });
      writeFileSync(join(probe, `${index}`, name), source);
    }
  });

  const { stdout } = spawnSync("vp", ["lint", "--format", "json", probe], {
    cwd: root,
    env: { ...process.env, LINT_PROBE: "1" },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });

  reported = decodeReport(stdout.slice(stdout.indexOf("{"))).diagnostics.map((diagnostic) => {
    const [directory = "", ...file] = relative(probe, resolve(root, diagnostic.filename)).split(
      sep,
    );

    return { directory, finding: `${file.join("/")}: ${diagnostic.code ?? diagnostic.message}` };
  });
});

afterAll(() => rmSync(probe, { recursive: true, force: true }));

it.each(cases.map(({ name, findings }, index) => ({ name, findings, index })))(
  "$name",
  ({ findings, index }) => {
    expect(
      reported
        .flatMap(({ directory, finding }) => (directory === `${index}` ? [finding] : []))
        .toSorted(),
    ).toEqual(findings);
  },
);
