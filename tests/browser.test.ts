import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { expect, it } from "@effect/vitest";

/** The modules `entry` imports, itself included, following relative imports. */
const modulesOf = (entry: string): ReadonlyMap<string, ReadonlyArray<string>> => {
  const seen = new Map<string, ReadonlyArray<string>>();
  const pending = [entry];

  for (let file = pending.pop(); file !== undefined; file = pending.pop()) {
    if (seen.has(file)) continue;

    // The specifier of each import or export declaration that has one, and of no other
    // string: no quote or semicolon comes before its `from`.
    const specifiers = [
      ...readFileSync(file, "utf8").matchAll(
        /^(?:(?:import|export)\b[^;"'`]*?\bfrom\s*|import\s*)"([^"]+)"/gm,
      ),
    ].flatMap(([, specifier]) => (specifier === undefined ? [] : [specifier]));

    seen.set(file, specifiers);

    for (const specifier of specifiers) {
      if (specifier.startsWith(".")) {
        pending.push(join(dirname(file), specifier.replace(/\.js$/, ".ts")));
      }
    }
  }

  return seen;
};

/** The Effect specifiers a browser client imports: all a page's import map has to serve. */
const browserEffect = ["effect", "effect/http", "effect/http-api"];

// A browser client imports `Action` and `ActionHttp`: they and what they import must load
// there, so none imports anything specific to Node or a server platform, and Effect only
// through the barrels above, since a page whose import map serves them bundles a second copy
// of Effect for any other specifier.
it.each(["src/Action.ts", "src/ActionHttp.ts", "src/Authentication.ts"])(
  "%s imports nothing a browser lacks",
  (entry) => {
    const outside = [...modulesOf(entry)].flatMap(([file, specifiers]) =>
      specifiers
        .filter((specifier) => !specifier.startsWith(".") && !browserEffect.includes(specifier))
        .map((specifier) => `${file}: ${specifier}`),
    );

    expect(outside).toEqual([]);
    // It followed the imports: the check is not vacuous.
    expect(modulesOf(entry).size).toBeGreaterThan(3);
  },
);

// A browser client imports its contracts, their identity declarations and the binding: the
// application's own modules must load there too.
it.each(["examples/contracts.ts", "examples/authorization.ts", "examples/binding.ts"])(
  "%s imports nothing a browser lacks",
  (entry) => {
    const outside = [...modulesOf(entry)].flatMap(([file, specifiers]) =>
      specifiers
        .filter((specifier) => !specifier.startsWith(".") && !browserEffect.includes(specifier))
        .map((specifier) => `${file}: ${specifier}`),
    );

    expect(outside).toEqual([]);
    // It followed the imports into the library: the check is not vacuous.
    expect([...modulesOf(entry).keys()]).toContain("src/Action.ts");
  },
);

// Contracts import no transport code, the in-process client among them: `Action` loads no
// server or client of HTTP, MCP, the AI toolkit or the CLI.
it("src/Action.ts imports no transport", () => {
  const transports = [...modulesOf("src/Action.ts")].flatMap(([file, specifiers]) =>
    specifiers
      .filter((specifier) => /^effect\/(?:http|http-api|ai|cli)(?:\/|$)/.test(specifier))
      .map((specifier) => `${file}: ${specifier}`),
  );

  expect(transports).toEqual([]);
});
