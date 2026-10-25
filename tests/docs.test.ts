import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "@effect/vitest";
import cloudflareManifest from "../packages/cloudflare/package.json" with { type: "json" };
import manifest from "../package.json" with { type: "json" };
import { docsDirectory, examplesDirectory } from "../scripts/skill.ts";

const root = fileURLToPath(new URL("../", import.meta.url));

const read = (path: string) => readFileSync(join(root, path), "utf8");

const markdownIn = (directory: string) =>
  readdirSync(directory)
    .filter((name) => name.endsWith(".md"))
    .map((name) => relative(root, join(directory, name)));

const directoriesIn = (directory: string) =>
  readdirSync(directory).filter((name) => statSync(join(directory, name)).isDirectory());

const examples = directoriesIn(examplesDirectory);

const cloudflare = "packages/cloudflare";

const cloudflareExamples = directoriesIn(join(root, cloudflare, "examples"));

const cloudflareDocsPages = markdownIn(join(root, cloudflare, "docs"));

const docsPages = [...markdownIn(docsDirectory), ...cloudflareDocsPages];

const cloudflarePages = [
  `${cloudflare}/README.md`,
  ...cloudflareDocsPages,
  ...cloudflareExamples.map((example) => `${cloudflare}/examples/${example}/README.md`),
];

const pages = [
  "README.md",
  "examples/README.md",
  ...docsPages,
  ...examples.map((example) => `examples/${example}/README.md`),
  ...cloudflarePages.filter((page) => !docsPages.includes(page)),
];

const withoutCode = (page: string) =>
  read(page).replaceAll(/^[ \t]*\x60{3}[\s\S]*?^[ \t]*\x60{3}/gm, "");

const anchorsOf = (page: string) => {
  const seen = new Map<string, number>();

  return Array.from(withoutCode(page).matchAll(/^#{1,6} +(.+)$/gm), ([, heading = ""]) => {
    const slug = heading
      .trim()
      .toLowerCase()
      .replaceAll(/[^\p{L}\p{N} _-]/gu, "")
      .replaceAll(" ", "-");

    const count = seen.get(slug) ?? 0;

    seen.set(slug, count + 1);

    return count === 0 ? slug : `${slug}-${count}`;
  });
};

const linksOf = (page: string) =>
  Array.from(
    withoutCode(page).matchAll(/\]\((?!https?:|mailto:)([^)#\s]*)(?:#([^)\s]*))?\)/g),
    ([, target = "", anchor]) => ({ target, anchor }),
  );

const snippets = pages.flatMap((page) =>
  Array.from(
    read(page).matchAll(/\x60{3}ts example=(\S+)\n([\s\S]*?)\n\x60{3}/g),
    ([, file = "", code]) => [page, file, code] as const,
  ),
);

const packageOf = (page: string) => (page.startsWith(`${cloudflare}/`) ? `${cloudflare}/` : "");

it.each(snippets)("keeps %s's snippet of examples/%s equal to the file", (page, file, code) => {
  expect(code).toBe(read(`${packageOf(page)}examples/${file}`).trim());
});

it.each(pages)("%s links only to files and headings that exist", (page) => {
  const broken = linksOf(page).flatMap(({ target, anchor }) => {
    const path = target === "" ? page : relative(root, join(root, dirname(page), target));

    if (!existsSync(join(root, path))) return [`${target} does not exist`];

    return anchor === undefined || !path.endsWith(".md") || anchorsOf(path).includes(anchor)
      ? []
      : [`${target}#${anchor} is not a heading of ${path}`];
  });

  expect(broken).toEqual([]);
});

it.each(docsPages)("%s links only inside docs/ and to examples/, which ship with it", (page) => {
  const outside = linksOf(page)
    .map(({ target }) => target)
    .filter((target) => target.startsWith("..") && !target.startsWith("../examples/"));

  expect(outside).toEqual([]);
});

it.each(cloudflarePages)(
  "%s links only inside the cloudflare package, which ships alone",
  (page) => {
    const outside = linksOf(page)
      .map(({ target }) => relative(root, join(root, dirname(page), target)))
      .filter((path) => !path.startsWith(`${cloudflare}/`));

    expect(outside).toEqual([]);
  },
);

it.each(docsPages)("%s names no source path of the library, which does not ship", (page) => {
  const ofAnExample = new RegExp(`(?:${[...examples, ...cloudflareExamples].join("|")})/src/`, "g");

  expect(withoutCode(page).replaceAll(ofAnExample, "")).not.toMatch(/\bsrc\//);
});

it.each(docsPages)("%s fences TypeScript only as a whole example file", (page) => {
  const fences = Array.from(read(page).matchAll(/^\x60{3}ts(.*)$/gm), ([, rest = ""]) => rest);

  for (const rest of fences) expect(rest, page).toMatch(/^ example=\S+$/);
});

it("gives every module page a -failures.md beside it, each entry one line", () => {
  for (const page of docsPages) {
    if (page.endsWith("-failures.md") || page.endsWith("docs/README.md")) continue;

    const own = page.replace(/\.md$/, "-failures.md");

    const failures = existsSync(join(root, own))
      ? own
      : page.replace(/-[a-z-]+\.md$/, "-failures.md");

    const lines = read(failures).split("\n");

    expect(lines.filter((line) => line.startsWith("- ")).length, failures).toBeGreaterThan(0);

    for (const [index, line] of lines.entries()) {
      if (line.startsWith("  ")) expect.fail(`${failures}:${index + 1} continues an entry`);
    }
  }
});

it.each(docsPages)("%s stays below the 16 KB safety margin for tool-output truncation", (page) => {
  expect(Buffer.byteLength(read(page))).toBeLessThan(16_000);
});

it("lists every example in examples/README.md and gives each a README", () => {
  const index = read("examples/README.md");

  for (const example of examples) {
    expect(index, example).toContain(`](${example}/)`);
    expect(existsSync(join(examplesDirectory, example, "README.md")), example).toBe(true);
  }
});

it("installs Effect at the package's peer range in README.md and docs/setup.md", () => {
  const range = manifest.peerDependencies.effect;

  for (const page of ["README.md", "docs/setup.md"]) {
    expect(read(page)).toContain(`effect@${range}`);
    expect(read(page)).toContain(`@effect/platform-node@${range}`);
  }
});

it("installs the cloudflare package beside the core, at its Effect peer range", () => {
  const page = read(`${cloudflare}/README.md`);

  expect(page).toContain(`${manifest.name} ${cloudflareManifest.name}`);
  expect(page).toContain(`effect@${cloudflareManifest.peerDependencies.effect}`);
  expect(cloudflareManifest.peerDependencies.effect).toBe(manifest.peerDependencies.effect);
});

it("gives every module the cloudflare package exports a page and a failures page", () => {
  const modules = Object.keys(cloudflareManifest.exports).flatMap((path) =>
    path === "./package.json" ? [] : [path.slice("./".length)],
  );

  for (const module of modules) {
    expect(cloudflareDocsPages).toContain(`${cloudflare}/docs/${module}.md`);
    expect(cloudflareDocsPages).toContain(`${cloudflare}/docs/${module}-failures.md`);
    expect(read(`${cloudflare}/docs/${module}.md`)).toContain(
      `Import \`${cloudflareManifest.name}/${module}\``,
    );
  }
});

it("lists every module the package exports under docs/setup.md's entry points", () => {
  const section = read("docs/setup.md").split("\n## Entry points\n")[1]?.split("\n## ")[0] ?? "";

  const sentence = section.replaceAll("\n", " ").match(/The modules: [^.]*\./)?.[0] ?? "";

  const listed = Array.from(sentence.matchAll(/`([A-Za-z]+)`/g), ([, name = ""]) => name);

  const modules = Object.keys(manifest.exports).flatMap((path) =>
    path === "./package.json" ? [] : [path.slice("./".length)],
  );

  const byName = (a: string, b: string) => a.localeCompare(b);

  expect(listed.toSorted(byName)).toEqual(modules.toSorted(byName));
});

it.each(["", `${cloudflare}/`])(
  "names, in the JSDoc that ships from %ssrc, only pages and example paths the package holds",
  (pkg) => {
    const sources = readdirSync(join(root, pkg, "src"), { recursive: true, encoding: "utf8" })
      .filter((name) => name.endsWith(".ts"))
      .map((name) => `${pkg}src/${name}`);

    const named = sources.flatMap((source) =>
      Array.from(
        read(source).matchAll(/\x60((?:docs|examples)\/[\w./-]+)\x60/g),
        ([, path = ""]) => ({ source, path }),
      ),
    );

    expect(named.length).toBeGreaterThan(0);
    expect(named.filter(({ path }) => !existsSync(join(root, pkg, path)))).toEqual([]);
  },
);

const exportsOf = (pkg: string, paths: ReadonlyArray<string>) => {
  const sources = readdirSync(join(root, pkg, "src"), { recursive: true, encoding: "utf8" });

  return paths
    .filter((path) => path !== "./package.json")
    .map((path) => {
      const module = path.slice("./".length);
      const file = sources.find((name) => name.endsWith(`/${module}.ts`));

      if (file === undefined) throw new Error(`No public module file for ${pkg}${module}`);

      const source = read(`${pkg}src/${file}`);

      const declared = Array.from(
        source.matchAll(/^export (?:declare )?(?:const|function|interface|type|class) (\w+)/gm),
        ([, name = ""]) => name,
      );

      const listed = Array.from(
        source.matchAll(/^export (?:type )?\{([^}]*)\}/gm),
        ([, body = ""]) =>
          body.split(",").flatMap((entry) => {
            const name =
              entry
                .trim()
                .replace(/^type /, "")
                .split(" as ")
                .at(-1)
                ?.trim() ?? "";

            return name === "" ? [] : [name];
          }),
      );

      return [module, new Set([...declared, ...listed.flat()])] as const;
    });
};

it("names, in the pages and READMEs, only symbols the public modules of both packages export", () => {
  const exported = new Map([
    ...exportsOf("", Object.keys(manifest.exports)),
    ...exportsOf(`${cloudflare}/`, Object.keys(cloudflareManifest.exports)),
  ]);

  const pointer = new RegExp(`\\x60(${Array.from(exported.keys()).join("|")})\\.(\\w+)`, "g");

  const unresolved = pages.flatMap((page) =>
    Array.from(read(page).matchAll(pointer)).flatMap(([, module = "", symbol = ""]) =>
      exported.get(module)?.has(symbol) ? [] : [`${page}: ${module}.${symbol}`],
    ),
  );

  expect(unresolved).toEqual([]);
});
