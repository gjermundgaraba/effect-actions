import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { expect, it } from "@effect/vitest";
import manifest from "../package.json" with { type: "json" };

const declarationSpecifier = /^(?:(?:import|export)\b[^;"'`]*?\bfrom\s*|import\s*)"([^"]+)"/gm;

const sourceOf = new Map(
  Object.entries(manifest.exports).map(([subpath, source]) => [
    `${manifest.name}${subpath.slice(1)}`,
    source.slice(2),
  ]),
);

const isWalked = (specifier: string) => specifier.startsWith(".") || sourceOf.has(specifier);

const modulesOf = (entry: string): ReadonlyMap<string, ReadonlyArray<string>> => {
  const seen = new Map<string, ReadonlyArray<string>>();
  const pending = [entry];

  for (let file = pending.pop(); file !== undefined; file = pending.pop()) {
    if (seen.has(file)) continue;

    const specifiers = [...readFileSync(file, "utf8").matchAll(declarationSpecifier)].flatMap(
      ([, specifier]) => (specifier === undefined ? [] : [specifier]),
    );

    seen.set(file, specifiers);

    for (const specifier of specifiers) {
      const source = sourceOf.get(specifier);

      if (source !== undefined) pending.push(source);
      else if (specifier.startsWith(".")) {
        pending.push(join(dirname(file), specifier.replace(/\.js$/, ".ts")));
      }
    }
  }

  return seen;
};

const importMapEffectSpecifiers = ["effect", "effect/http", "effect/http-api", "effect/rpc"];

it.each(["Action", "ActionHttp", "ActionRpc", "Authentication"] as const)(
  "%s, which a browser client imports, imports no Node or server module, and Effect only through its browser barrels",
  (module) => {
    const entry = manifest.exports[`./${module}`].slice(2);

    const outside = [...modulesOf(entry)].flatMap(([file, specifiers]) =>
      specifiers
        .filter(
          (specifier) => !isWalked(specifier) && !importMapEffectSpecifiers.includes(specifier),
        )
        .map((specifier) => `${file}: ${specifier}`),
    );

    expect(outside).toEqual([]);
    expect(modulesOf(entry).size).toBeGreaterThan(3);
  },
);

it.each([
  "examples/contracts.ts",
  "examples/authorization.ts",
  "examples/binding.ts",
  "examples/rpc-binding.ts",
])(
  "%s, an application module a browser client imports, imports nothing a browser lacks",
  (entry) => {
    const outside = [...modulesOf(entry)].flatMap(([file, specifiers]) =>
      specifiers
        .filter(
          (specifier) => !isWalked(specifier) && !importMapEffectSpecifiers.includes(specifier),
        )
        .map((specifier) => `${file}: ${specifier}`),
    );

    expect(outside).toEqual([]);
    expect([...modulesOf(entry).keys()]).toContain("src/contract/Action.ts");
  },
);

it("examples/rpc-client.ts imports nothing a browser lacks but effect/socket, which the import map serves beside the library's", () => {
  const outside = [...modulesOf("examples/rpc-client.ts")].flatMap(([file, specifiers]) =>
    specifiers
      .filter(
        (specifier) =>
          !isWalked(specifier) &&
          ![...importMapEffectSpecifiers, "effect/socket"].includes(specifier),
      )
      .map((specifier) => `${file}: ${specifier}`),
  );

  expect(outside).toEqual([]);
  expect([...modulesOf("examples/rpc-client.ts").keys()]).toContain("src/rpc/ActionRpc.ts");
});

it("Action imports no transport, the in-process client included: no HTTP, RPC, MCP, AI toolkit or CLI module", () => {
  const transports = [...modulesOf(manifest.exports["./Action"].slice(2))].flatMap(
    ([file, specifiers]) =>
      specifiers
        .filter((specifier) => /^effect\/(?:http|http-api|rpc|ai|cli)(?:\/|$)/.test(specifier))
        .map((specifier) => `${file}: ${specifier}`),
  );

  expect(transports).toEqual([]);
});
