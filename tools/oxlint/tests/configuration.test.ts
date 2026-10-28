import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "@effect/vitest";
import { Schema } from "effect";

const Report = Schema.Struct({
  diagnostics: Schema.Array(
    Schema.Struct({
      code: Schema.optional(Schema.String),
      message: Schema.String,
      filename: Schema.String,
    })
  ),
});

const decodeReport = Schema.decodeUnknownSync(Schema.fromJsonString(Report));

const root = fileURLToPath(new URL("../../../", import.meta.url));

const probe = path.join(
  root,
  "tools/oxlint/tests",
  `probe-${process.pid}-${Date.now()}`
);

const cases = [
  {
    name: "rejects module mocking through the repository's test import",
    files: {
      "users.ts": "export const users = 1;\n",
      "spy.test.ts":
        "import { vi } from '@effect/vitest';\n\nexport const spy = vi.fn<() => void>();\n",
      "mock.test.ts":
        "import { vi } from '@effect/vitest';\n\nvi.mock(import('./users.js'));\n",
    },
    findings: ["mock.test.ts: vitest(no-restricted-vi-methods)"],
  },
  {
    name: "reports an unused disable directive as an error",
    files: {
      "used.ts": [
        "// oxlint-disable-next-line eqeqeq -- Probe of a justified directive.",
        "export const same = (a: number, b: number): boolean => a == b;",
        "",
      ].join("\n"),
      "unused.ts": [
        "// oxlint-disable-next-line eqeqeq -- Probe of a stale directive.",
        "export const same = (a: number, b: number): boolean => a === b;",
        "",
      ].join("\n"),
    },
    findings: [
      "unused.ts: Unused oxlint-disable directive (no problems were reported).",
    ],
  },
  {
    name: "reports every relative import in source but the allowed forms",
    files: {
      "documented.ts": "export const documented = 1;\n",
      "src/contract/Action.ts":
        "/** A contract. */\nexport const action = 1;\n",
      "src/contract/named.ts":
        'export { make } from "@gjermundgaraba/effect-actions/Action";\n',
      "src/contract/outside.ts": 'export { server } from "../mcp/server.js";\n',
      "src/contract/public.ts": 'export { mcp } from "../mcp/ActionMcp.js";\n',
      "src/contract/spelled.ts": 'export { action } from "././Action.js";\n',
      "src/mcp/ActionMcp.ts": "export const mcp = 1;\n",
      "src/authentication/provider.ts": "export const provider = 1;\n",
      "src/http/allowed.ts": [
        'export { action } from "../contract/Action.js";',
        "",
        'export { mcp } from "../mcp/ActionMcp.js";',
        "",
        'export { provider } from "../authentication/provider.js";',
        "",
      ].join("\n"),
      "src/http/named.ts":
        'export { make } from "@gjermundgaraba/effect-actions/Action";\n',
      "src/http/outside.ts":
        'export { documented } from "../../documented.js";\n',
      "src/http/hidden.ts": 'export { server } from "../mcp/server.js";\n',
      "src/http/slashed.ts": 'export { mcp } from "../mcp//ActionMcp.js";\n',
      "src/http/spelled.ts": 'export { mcp } from "./../mcp/ActionMcp.js";\n',
      "src/mcp/server.ts": "export const server = 1;\n",
    },
    findings: [
      "src/contract/named.ts: eslint(no-restricted-imports)",
      "src/contract/outside.ts: eslint(no-restricted-imports)",
      "src/contract/public.ts: eslint(no-restricted-imports)",
      "src/contract/spelled.ts: eslint(no-restricted-imports)",
      "src/http/hidden.ts: eslint(no-restricted-imports)",
      "src/http/named.ts: eslint(no-restricted-imports)",
      "src/http/outside.ts: eslint(no-restricted-imports)",
      "src/http/slashed.ts: eslint(no-restricted-imports)",
      "src/http/spelled.ts: eslint(no-restricted-imports)",
    ],
  },
] as const;

let reported: ReadonlyArray<{
  readonly directory: string;
  readonly finding: string;
}> = [];

describe("the Oxlint configuration", () => {
  beforeAll(() => {
    for (const [index, { files }] of cases.entries()) {
      for (const [name, source] of Object.entries(files)) {
        mkdirSync(path.dirname(path.join(probe, `${index}`, name)), {
          recursive: true,
        });
        writeFileSync(path.join(probe, `${index}`, name), source);
      }
    }

    const { stdout } = spawnSync("vp", ["lint", "--format", "json", probe], {
      cwd: root,
      env: { ...process.env, LINT_PROBE: "1" },
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    });

    reported = decodeReport(stdout.slice(stdout.indexOf("{"))).diagnostics.map(
      (diagnostic) => {
        const [directory = "", ...file] = path
          .relative(probe, path.resolve(root, diagnostic.filename))
          .split(path.sep);

        return {
          directory,
          finding: `${file.join("/")}: ${diagnostic.code ?? diagnostic.message}`,
        };
      }
    );
  });

  afterAll(() => {
    rmSync(probe, { recursive: true, force: true });
  });

  it.each(
    cases.map(({ name, findings }, index) => ({ name, findings, index }))
  )("$name", ({ findings, index }) => {
    expect(
      reported
        .flatMap(({ directory, finding }) =>
          directory === `${index}` ? [finding] : []
        )
        .toSorted()
    ).toStrictEqual(findings);
  });
});
