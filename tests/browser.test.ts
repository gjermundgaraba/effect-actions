import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { expect, it } from "vite-plus/test";

/** The modules `entry` imports, itself included, following relative imports. */
const modulesOf = (entry: string): ReadonlyMap<string, ReadonlyArray<string>> => {
  const seen = new Map<string, ReadonlyArray<string>>();
  const pending = [entry];

  for (let file = pending.pop(); file !== undefined; file = pending.pop()) {
    if (seen.has(file)) continue;

    const specifiers = [
      ...readFileSync(file, "utf8").matchAll(/^(?:import|export)\b[^;"]*"([^"]+)"/gms),
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

// A browser client imports `Action` and `ActionHttp`: they and what they import must load
// there, so none imports anything specific to Node or a server platform.
it.each(["src/Action.ts", "src/ActionHttp.ts"])("%s imports nothing a browser lacks", (entry) => {
  const platform = [...modulesOf(entry)].flatMap(([file, specifiers]) =>
    specifiers
      .filter(
        (specifier) => specifier.startsWith("node:") || specifier.startsWith("@effect/platform"),
      )
      .map((specifier) => `${file}: ${specifier}`),
  );

  expect(platform).toEqual([]);
  // It followed the imports: the check is not vacuous.
  expect(modulesOf(entry).size).toBeGreaterThan(3);
});

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
