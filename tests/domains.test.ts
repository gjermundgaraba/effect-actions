import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "@effect/vitest";

const declarationSpecifier =
  /^(?:(?:import|export)\b[^;"'`]*?\bfrom\s*|import\s*)["']\.\.\/([a-z]+)\//gm;

const source = fileURLToPath(new URL("../src/", import.meta.url));

const importsOf = new Map(
  readdirSync(source).map((domain) => [
    domain,
    new Set(
      readdirSync(join(source, domain)).flatMap((file) =>
        Array.from(
          readFileSync(join(source, domain, file), "utf8").matchAll(declarationSpecifier),
          ([, imported = ""]) => imported,
        ),
      ),
    ),
  ]),
);

const reaches = (from: string, to: string) => {
  const seen = new Set<string>();
  const pending = [from];

  for (let domain = pending.pop(); domain !== undefined; domain = pending.pop()) {
    if (domain === to) return true;

    if (seen.has(domain)) continue;

    seen.add(domain);
    pending.push(...(importsOf.get(domain) ?? []));
  }

  return false;
};

it("keeps the domains of src/ free of import cycles, type-only imports included", () => {
  const cyclic = [...importsOf].flatMap(([domain, imported]) =>
    [...imported].filter((other) => reaches(other, domain)).map((other) => `${domain} -> ${other}`),
  );

  expect(cyclic).toEqual([]);
});
