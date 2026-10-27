import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "@effect/vitest";

import manifest from "../package.json" with { type: "json" };
import { captured } from "./support/captured.js";

const declarationSpecifier =
  /^(?:(?:import|export)\b[^;"'`]*?\bfrom\s*|import\s*)"(?<specifier>[^"]+)"/gmu;

const sourceOf = new Map(
  Object.entries(manifest.exports).map(([subpath, source]) => [
    `${manifest.name}${subpath.slice(1)}`,
    source.slice(2),
  ])
);

const isWalked = (specifier: string) =>
  specifier.startsWith(".") || sourceOf.has(specifier);

const modulesOf = (entry: string): ReadonlyMap<string, readonly string[]> => {
  const seen = new Map<string, readonly string[]>();
  const pending = [entry];

  for (let file = pending.pop(); file !== undefined; file = pending.pop()) {
    if (seen.has(file)) {
      continue;
    }

    const specifiers = [
      ...readFileSync(file, "utf-8").matchAll(declarationSpecifier),
    ].map((match) => captured(match, "specifier"));

    seen.set(file, specifiers);

    for (const specifier of specifiers) {
      const source = sourceOf.get(specifier);

      if (source !== undefined) {
        pending.push(source);
      } else if (specifier.startsWith(".")) {
        pending.push(
          path.join(path.dirname(file), specifier.replace(/\.js$/u, ".ts"))
        );
      }
    }
  }

  return seen;
};

const importMapEffectSpecifiers = [
  "effect",
  "effect/http",
  "effect/http-api",
  "effect/rpc",
];

describe("the modules a browser client imports", () => {
  it.each([
    "Action",
    "Event",
    "ActionHttp",
    "ActionRpc",
    "Authentication",
  ] as const)(
    "%s, which a browser client imports, imports no Node or server module, and Effect only through its browser barrels",
    (module) => {
      const entry = manifest.exports[`./${module}`].slice(2);

      const outside = [...modulesOf(entry)].flatMap(([file, specifiers]) =>
        specifiers
          .filter(
            (specifier) =>
              !isWalked(specifier) &&
              !importMapEffectSpecifiers.includes(specifier)
          )
          .map((specifier) => `${file}: ${specifier}`)
      );

      expect(outside).toStrictEqual([]);
      expect(modulesOf(entry).size).toBeGreaterThan(3);
    }
  );

  it.each([
    "examples/quickstart/src/Api.ts",
    "examples/notes-service/src/browser.ts",
    "examples/kitchen-sink/src/Api.ts",
    "examples/kitchen-sink/src/sdk.ts",
    "examples/live-rpc/src/Rpc.ts",
    "examples/kitchen-sink/src/Rpc.ts",
  ])(
    "%s, an application module a browser client imports, imports nothing a browser lacks",
    (entry) => {
      const outside = [...modulesOf(entry)].flatMap(([file, specifiers]) =>
        specifiers
          .filter(
            (specifier) =>
              !isWalked(specifier) &&
              !importMapEffectSpecifiers.includes(specifier)
          )
          .map((specifier) => `${file}: ${specifier}`)
      );

      expect(outside).toStrictEqual([]);
      expect([...modulesOf(entry).keys()]).toContain("src/contract/Action.ts");
    }
  );

  it.each([
    "examples/live-rpc/src/browser.ts",
    "examples/kitchen-sink/src/browser.ts",
  ])(
    "%s, an rpc client, imports nothing a browser lacks but effect/socket, which the import map serves beside the library's",
    (entry) => {
      const outside = [...modulesOf(entry)].flatMap(([file, specifiers]) =>
        specifiers
          .filter(
            (specifier) =>
              !isWalked(specifier) &&
              ![...importMapEffectSpecifiers, "effect/socket"].includes(
                specifier
              )
          )
          .map((specifier) => `${file}: ${specifier}`)
      );

      expect(outside).toStrictEqual([]);
      expect([...modulesOf(entry).keys()]).toContain("src/rpc/ActionRpc.ts");
    }
  );

  it("Action imports no transport, the in-process client included: no HTTP, RPC, MCP, AI toolkit or CLI module", () => {
    const transports = [
      ...modulesOf(manifest.exports["./Action"].slice(2)),
    ].flatMap(([file, specifiers]) =>
      specifiers
        .filter((specifier) =>
          /^effect\/(?:http|http-api|rpc|ai|cli)(?:\/|$)/u.test(specifier)
        )
        .map((specifier) => `${file}: ${specifier}`)
    );

    expect(transports).toStrictEqual([]);
  });
});
