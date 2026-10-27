import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "@effect/vitest";

import { captured } from "./support/captured.js";

const declarationSpecifier =
  /^(?:(?:import|export)\b[^;"'`]*?\bfrom\s*|import\s*)["']\.\.\/(?<domain>[a-z]+)\//gmu;

const source = fileURLToPath(new URL("../src/", import.meta.url));

const importsOf = new Map(
  readdirSync(source).map((domain) => [
    domain,
    new Set(
      readdirSync(path.join(source, domain)).flatMap((file) =>
        Array.from(
          readFileSync(path.join(source, domain, file), "utf-8").matchAll(
            declarationSpecifier
          ),
          (match) => captured(match, "domain")
        )
      )
    ),
  ])
);

const reaches = (from: string, to: string) => {
  const seen = new Set<string>();
  const pending = [from];

  for (
    let domain = pending.pop();
    domain !== undefined;
    domain = pending.pop()
  ) {
    if (domain === to) {
      return true;
    }

    if (seen.has(domain)) {
      continue;
    }

    seen.add(domain);
    pending.push(...(importsOf.get(domain) ?? []));
  }

  return false;
};

describe("the domains of src/", () => {
  it("import one another without cycles, type-only imports included", () => {
    const cyclic = [...importsOf].flatMap(([domain, imported]) =>
      [...imported].flatMap((other) =>
        reaches(other, domain) ? [`${domain} -> ${other}`] : []
      )
    );

    expect(cyclic).toStrictEqual([]);
  });
});
