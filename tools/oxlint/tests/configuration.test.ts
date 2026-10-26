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

const tagAssertions = [
  "import { assert, expect } from '@effect/vitest';",
  "import type { Tracer } from 'effect';",
  "",
  "export const check = (status: Tracer.SpanStatus) => {",
  "  assert(status._tag === 'Ended');",
  "  expect(status).toMatchObject({ _tag: 'Ended' });",
  "",
  "  return status.exit;",
  "};",
  "",
].join("\n");

const cases = [
  {
    name: "allows tag assertions in runtime and type tests while retaining the rules elsewhere",
    files: {
      "tags.test.ts": tagAssertions,
      "tags.spec.ts": tagAssertions,
      "tags.ts": tagAssertions,
    },
    findings: [
      "tags.ts: anti-slop-effect(no-manual-tag-comparison)",
      "tags.ts: anti-slop-effect(no-manual-tagged-construction)",
    ],
  },
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
    name: "allows JSDoc, an unexported declaration's included, and a Why: comment in source alone, and there reports every relative import but the allowed forms",
    files: {
      "documented.ts": "/** A constant. */\nexport const documented = 1;\n",
      "reasoned.ts": "// Why: A reason.\nexport const reasoned = 1;\n",
      "src/contract/Action.ts": "/** A contract. */\nexport const action = 1;\n",
      "src/contract/named.ts": 'export * as Action from "@gjermundgaraba/effect-actions/Action";\n',
      "src/contract/outside.ts": 'export { server } from "../mcp/server.js";\n',
      "src/contract/public.ts": 'export { mcp } from "../mcp/ActionMcp.js";\n',
      "src/contract/spelled.ts": 'export { action } from "././Action.js";\n',
      "src/mcp/ActionMcp.ts": "export const mcp = 1;\n",
      "src/authentication/provider.ts": "export const provider = 1;\n",
      "src/http/allowed.ts": [
        "// Why: A reason.",
        'export { action } from "../contract/Action.js";',
        "",
        'export { mcp } from "../mcp/ActionMcp.js";',
        "",
        'export { provider } from "../authentication/provider.js";',
        "",
      ].join("\n"),
      "src/http/inline.ts": [
        'import { type mcp } from "../mcp/ActionMcp.js";',
        "",
        "export type Inline = typeof mcp;",
        "",
      ].join("\n"),
      "src/http/named.ts": 'export * as Action from "@gjermundgaraba/effect-actions/Action";\n',
      "src/http/outside.ts": 'export { documented } from "../../documented.js";\n',
      "src/http/private.ts": "/** Private. */\nconst hidden = 1;\n\nexport const shown = hidden;\n",
      "src/http/hidden.ts": 'export { server } from "../mcp/server.js";\n',
      "src/http/slashed.ts": 'export { mcp } from "../mcp//ActionMcp.js";\n',
      "src/http/spelled.ts": 'export { mcp } from "./../mcp/ActionMcp.js";\n',
      "src/http/typed.ts": 'export type Mcp = typeof import("../mcp/ActionMcp.js");\n',
      "src/mcp/server.ts": "export const server = 1;\n",
    },
    findings: [
      "documented.ts: no-comments(no-prose-comments)",
      "reasoned.ts: no-comments(no-prose-comments)",
      "src/contract/named.ts: eslint(no-restricted-imports)",
      "src/contract/outside.ts: eslint(no-restricted-imports)",
      "src/contract/public.ts: eslint(no-restricted-imports)",
      "src/contract/spelled.ts: eslint(no-restricted-imports)",
      "src/http/hidden.ts: eslint(no-restricted-imports)",
      "src/http/inline.ts: typescript(no-import-type-side-effects)",
      "src/http/named.ts: eslint(no-restricted-imports)",
      "src/http/outside.ts: eslint(no-restricted-imports)",
      "src/http/slashed.ts: eslint(no-restricted-imports)",
      "src/http/spelled.ts: eslint(no-restricted-imports)",
      "src/http/typed.ts: typescript(consistent-type-imports)",
    ],
  },
  {
    name: "allows JSDoc on a shared test helper in tests/support, and no Why: comment or comment in a test",
    files: {
      "tests/support/documented.ts": "/** A helper. */\nexport const documented = 1;\n",
      "tests/support/reasoned.ts": "// Why: A reason.\nexport const reasoned = 1;\n",
      "tests/documented.test.ts": "/** A helper. */\nexport const documented = 1;\n",
    },
    findings: [
      "tests/documented.test.ts: no-comments(no-prose-comments)",
      "tests/support/reasoned.ts: no-comments(no-prose-comments)",
    ],
  },
  {
    name: "allows a Why: comment in a Vite config, and no other comment there",
    files: {
      "vite.config.ts":
        "// Why: A reason.\nexport const reasoned = 1;\n\n// A note.\nexport const noted = 1;\n",
    },
    findings: ["vite.config.ts: no-comments(no-prose-comments)"],
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
