import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "@effect/vitest";

import manifest from "../package.json" with { type: "json" };
import { docsDirectory, examplesDirectory } from "../scripts/skill.ts";
import { captured } from "./support/captured.js";

const root = fileURLToPath(new URL("../", import.meta.url));

const read = (file: string) => readFileSync(path.join(root, file), "utf-8");

const markdownIn = (directory: string) =>
  readdirSync(directory)
    .filter((name) => name.endsWith(".md"))
    .map((name) => path.relative(root, path.join(directory, name)));

const directoriesIn = (directory: string) =>
  readdirSync(directory).filter((name) =>
    statSync(path.join(directory, name)).isDirectory()
  );

const examples = directoriesIn(examplesDirectory);

const docsPages = markdownIn(docsDirectory);

const pages = [
  "README.md",
  "examples/README.md",
  ...docsPages,
  ...examples.map((example) => `examples/${example}/README.md`),
];

const byName = (a: string, b: string) => a.localeCompare(b);

const withoutCode = (page: string) =>
  read(page).replaceAll(/^[ \t]*\u0060{3}[\s\S]*?^[ \t]*\u0060{3}/gmu, "");

const anchorsOf = (page: string) => {
  const seen = new Map<string, number>();

  return Array.from(
    withoutCode(page).matchAll(/^#{1,6} +(?<heading>.+)$/gmu),
    (match) => {
      const slug = captured(match, "heading")
        .trim()
        .toLowerCase()
        .replaceAll(/[^\p{L}\p{N} _-]/gu, "")
        .replaceAll(" ", "-");

      const count = seen.get(slug) ?? 0;

      seen.set(slug, count + 1);

      return count === 0 ? slug : `${slug}-${count}`;
    }
  );
};

const linksOf = (page: string) =>
  Array.from(
    withoutCode(page).matchAll(
      /\]\((?!https?:|mailto:)(?<target>[^)#\s]*)(?:#(?<anchor>[^)\s]*))?\)/gu
    ),
    (match) => ({
      target: captured(match, "target"),
      anchor: match.groups?.["anchor"],
    })
  );

const snippets = pages.flatMap((page) =>
  Array.from(
    read(page).matchAll(
      /\u0060{3}ts example=(?<file>\S+)\n(?<code>[\s\S]*?)\n\u0060{3}/gu
    ),
    (match) =>
      [
        page,
        `examples/${captured(match, "file")}`,
        captured(match, "code"),
      ] as const
  )
);

describe("the documentation", () => {
  it.each(snippets)(
    "keeps %s's snippet of %s equal to the file",
    (_, file, code) => {
      expect(code).toBe(read(file).trim());
    }
  );

  it.each(pages)("%s links only to files and headings that exist", (page) => {
    const broken = linksOf(page).flatMap(({ target, anchor }) => {
      const linked =
        target === ""
          ? page
          : path.relative(root, path.join(root, path.dirname(page), target));

      if (!existsSync(path.join(root, linked))) {
        return [`${target} does not exist`];
      }

      return anchor === undefined ||
        !linked.endsWith(".md") ||
        anchorsOf(linked).includes(anchor)
        ? []
        : [`${target}#${anchor} is not a heading of ${linked}`];
    });

    expect(broken).toStrictEqual([]);
  });

  it.each(docsPages)(
    "%s links only inside docs/ and to examples/, which ship with it",
    (page) => {
      const outside = linksOf(page)
        .map(({ target }) => target)
        .filter(
          (target) =>
            target.startsWith("..") && !target.startsWith("../examples/")
        );

      expect(outside).toStrictEqual([]);
    }
  );

  it.each(docsPages)(
    "%s names no source path of the library, which does not ship",
    (page) => {
      const ofAnExample = new RegExp(`(?:${examples.join("|")})/src/`, "gu");

      expect(withoutCode(page).replaceAll(ofAnExample, "")).not.toMatch(
        /\bsrc\//u
      );
    }
  );

  it.each(docsPages)(
    "%s fences TypeScript only as a whole example file",
    (page) => {
      const fences = Array.from(
        read(page).matchAll(/^\u0060{3}ts(?<rest>.*)$/gmu),
        (match) => captured(match, "rest")
      );

      for (const rest of fences) {
        expect(rest, page).toMatch(/^ example=\S+$/u);
      }
    }
  );

  it("gives every module page a -failures.md beside it, each entry one line", () => {
    for (const page of docsPages) {
      if (page.endsWith("-failures.md") || page.endsWith("docs/README.md")) {
        continue;
      }

      const own = page.replace(/\.md$/u, "-failures.md");

      const failures = existsSync(path.join(root, own))
        ? own
        : page.replace(/-[a-z-]+\.md$/u, "-failures.md");

      const lines = read(failures).split("\n");

      expect(
        lines.filter((line) => line.startsWith("- ")).length,
        failures
      ).toBeGreaterThan(0);

      expect(
        lines.flatMap((line, index) =>
          line.startsWith("  ")
            ? [`${failures}:${index + 1} continues an entry`]
            : []
        )
      ).toStrictEqual([]);
    }
  });

  it.each(docsPages)(
    "%s stays below the 16 KB safety margin for tool-output truncation",
    (page) => {
      expect(Buffer.byteLength(read(page))).toBeLessThan(16_000);
    }
  );

  it("lists every example in examples/README.md and gives each a README", () => {
    const index = read("examples/README.md");

    for (const example of examples) {
      expect(index, example).toContain(`](${example}/)`);
      expect(
        existsSync(path.join(examplesDirectory, example, "README.md")),
        example
      ).toBe(true);
    }
  });

  it("installs Effect at the package's peer range in README.md and docs/setup.md", () => {
    const range = manifest.peerDependencies.effect;

    for (const page of ["README.md", "docs/setup.md"]) {
      expect(read(page)).toContain(`effect@${range}`);
      expect(read(page)).toContain(`@effect/platform-node@${range}`);
    }
  });

  it("lists every module the package exports under docs/setup.md's entry points", () => {
    const section =
      read("docs/setup.md")
        .split("\n## Entry points\n")[1]
        ?.split("\n## ")[0] ?? "";

    const sentence =
      /The modules: [^.]*\./u.exec(section.replaceAll("\n", " "))?.[0] ?? "";

    const listed = Array.from(
      sentence.matchAll(/`(?<name>[A-Za-z]+)`/gu),
      (match) => captured(match, "name")
    );

    const modules = Object.keys(manifest.exports).flatMap((exported) =>
      exported === "./package.json" ? [] : [exported.slice("./".length)]
    );

    expect(listed.toSorted(byName)).toStrictEqual(modules.toSorted(byName));
  });

  it("names, in the JSDoc that ships from src, only pages and example paths the package holds", () => {
    const sources = readdirSync(path.join(root, "src"), {
      recursive: true,
      encoding: "utf-8",
    })
      .filter((name) => name.endsWith(".ts"))
      .map((name) => `src/${name}`);

    const named = sources.flatMap((source) =>
      Array.from(
        read(source).matchAll(
          /\u0060(?<shipped>(?:docs|examples)\/[\w./-]+)\u0060/gu
        ),
        (match) => ({ source, shipped: captured(match, "shipped") })
      )
    );

    expect(named.length).toBeGreaterThan(0);
    expect(
      named.filter(({ shipped }) => !existsSync(path.join(root, shipped)))
    ).toStrictEqual([]);
  });
});

const exportsOf = (paths: readonly string[]) => {
  const sources = readdirSync(path.join(root, "src"), {
    recursive: true,
    encoding: "utf-8",
  });

  return paths.flatMap((exported) => {
    if (exported === "./package.json") {
      return [];
    }

    const module = exported.slice("./".length);
    const file = sources.find((name) => name.endsWith(`/${module}.ts`));

    if (file === undefined) {
      throw new Error(`No public module file for ${module}`);
    }

    const source = read(`src/${file}`);

    const declared = Array.from(
      source.matchAll(
        /^export (?:declare )?(?:const|function|interface|type|class) (?<name>\w+)/gmu
      ),
      (match) => captured(match, "name")
    );

    const listed = Array.from(
      source.matchAll(/^export (?:type )?\{(?<body>[^}]*)\}/gmu),
      (match) =>
        captured(match, "body")
          .split(",")
          .flatMap((entry) => {
            const name =
              entry
                .trim()
                .replace(/^type /u, "")
                .split(" as ")
                .at(-1)
                ?.trim() ?? "";

            return name === "" ? [] : [name];
          })
    );

    return [[module, new Set([...declared, ...listed.flat()])] as const];
  });
};

describe("the documented symbols", () => {
  it("names, in the pages and READMEs, only symbols the public modules export", () => {
    const exported = new Map(exportsOf(Object.keys(manifest.exports)));

    const pointer = new RegExp(
      `\\x60(?<module>${[...exported.keys()].join("|")})\\.(?<symbol>\\w+)`,
      "gu"
    );

    const unresolved = pages.flatMap((page) =>
      [...read(page).matchAll(pointer)].flatMap((match) => {
        const module = captured(match, "module");
        const symbol = captured(match, "symbol");

        return exported.get(module)?.has(symbol) === true
          ? []
          : [`${page}: ${module}.${symbol}`];
      })
    );

    expect(unresolved).toStrictEqual([]);
  });
});
