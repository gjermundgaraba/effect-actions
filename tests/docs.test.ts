import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { FetchHttpClient } from "effect/http";
import { routes } from "../examples/quickstart-server.js";
import { routes as browserRoutes } from "../examples/mcp-browser.js";
import { greeting } from "../examples/quickstart-client.js";
import manifest from "../package.json" with { type: "json" };
import { published } from "../scripts/published.mjs";
import { docsDirectory } from "../scripts/skill.ts";
import { mcpRequest } from "./requests.js";
import { serve } from "./serve.js";

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

/** README.md and every page of docs/, which the skill copies. */
const pages = [
  "README.md",
  ...readdirSync(docsDirectory)
    .filter((name) => name.endsWith(".md"))
    .map((name) => `docs/${name}`),
];

/** An example as a page shows it, importing the published package. */
const documented = (file: string) => published(read(`examples/${file}`).trim());

// A snippet fenced as `ts example=<file>` stays byte-identical to that type-checked example.
const snippets = pages.flatMap((page) =>
  Array.from(
    read(page).matchAll(/\x60{3}ts example=(\S+)\n([\s\S]*?)\n\x60{3}/g),
    ([, file = "", code]) => [page, file, code] as const,
  ),
);

it.each(snippets)(
  "keeps %s's snippet of %s aligned with its type-checked source",
  (_, file, code) => {
    expect(code).toBe(documented(file));
  },
);

// Code copied from a page's canonical example must compile: the first snippet of every
// Canonical section is an example. A snippet without the mark, such as a fragment, is not
// checked.
it("marks every canonical snippet as a type-checked example", () => {
  const unmarked = pages.filter((page) => {
    const [, section] = read(page).split("\n## Canonical\n");

    return (
      section !== undefined &&
      !/^[^\x60]*(?:\x60[^\x60]+\x60[^\x60]*)*\x60{3}ts example=/.test(section)
    );
  });

  expect(unmarked).toEqual([]);
});

// The install commands name the peer range, the one place a page states it.
it("installs Effect at the package's peer range", () => {
  const range = manifest.peerDependencies.effect;

  for (const page of ["README.md", "docs/setup.md"]) {
    expect(read(page)).toContain(`effect@${range}`);
    expect(read(page)).toContain(`@effect/platform-node@${range}`);
  }
});

// The entry points a consumer imports are the modules the package exports, each once.
it("lists every module the package exports under docs/setup.md's entry points", () => {
  const section = read("docs/setup.md").split("\n## Entry points\n")[1] ?? "";

  const [block = ""] = Array.from(
    section.matchAll(/\x60{3}ts\n([\s\S]*?)\n\x60{3}/g),
    ([, code]) => code,
  );

  const modules = Object.keys(manifest.exports).flatMap((path) =>
    path === "./package.json" ? [] : [path.slice("./".length)],
  );

  expect(block.split("\n").toSorted()).toEqual(
    modules.map((module) => `import * as ${module} from "${manifest.name}/${module}";`).toSorted(),
  );
});

// Docs describe behavior, and ship as the skill: no page names this repository's sources.
it("names no source path in docs/", () => {
  for (const page of readdirSync(docsDirectory)) {
    expect(read(`docs/${page}`), page).not.toMatch(/\bsrc\//);
  }
});

// The examples README is their one index.
it("lists every example in examples/README.md", () => {
  const index = read("examples/README.md");

  const examples = readdirSync(new URL("../examples/", import.meta.url)).filter((name) =>
    name.endsWith(".ts"),
  );

  for (const example of examples) expect(index, example).toContain(`](${example})`);
});

// Notes are cited by title, so CONTRIBUTING.md's index names each note in design/ by its own.
it("indexes every design note in CONTRIBUTING.md by its title", () => {
  const indexed = Array.from(
    read("CONTRIBUTING.md").matchAll(/^- \[(.+)\]\(design\/(.+)\)$/gm),
    ([, title, file]) => `${file}: ${title}`,
  );

  const notes = readdirSync(new URL("../design/", import.meta.url)).map(
    (file) => `${file}: ${read(`design/${file}`).split("\n")[0]?.replace(/^# /, "")}`,
  );

  expect(indexed.toSorted()).toEqual(notes.toSorted());
});

// The skill is a copy of docs/, so every relative link must resolve inside docs/.
it("keeps relative links in docs/ inside docs/", () => {
  const pages = readdirSync(docsDirectory).filter((name) => name.endsWith(".md"));

  for (const page of pages) {
    const links = readFileSync(join(docsDirectory, page), "utf8").matchAll(
      /\]\((?!https?:|#)([^)#]+)(?:#[^)]*)?\)/g,
    );

    for (const [, target] of links) {
      expect(target, `${page} links to ${target}`).not.toMatch(/^\.\.?\//);
      expect(existsSync(join(docsDirectory, target ?? "")), `${page} links to ${target}`).toBe(
        true,
      );
    }
  }
});

it.effect("runs the documented client against the quickstart routes", () =>
  Effect.gen(function* () {
    const web = serve(routes);

    const result = yield* greeting.pipe(
      Effect.provideService(FetchHttpClient.Fetch, (input, init) =>
        web.handler(new Request(input, init)),
      ),
    );

    expect(result).toBe("Hello, Ada!");
  }),
);

it("serves browser preflight and MCP calls with the documented CORS configuration", async () => {
  const web = serve(browserRoutes);

  const preflight = await web.handler(
    new Request("http://localhost/mcp", {
      method: "OPTIONS",
      headers: {
        origin: "https://ui.example.com",
        "access-control-request-method": "POST",
        "access-control-request-headers":
          "authorization,content-type,mcp-protocol-version,mcp-method,mcp-name",
      },
    }),
  );

  expect(preflight.status).toBe(204);
  expect(preflight.headers.get("access-control-allow-origin")).toBe("https://ui.example.com");
  expect(preflight.headers.get("access-control-allow-methods")).toBe("POST");
  expect(preflight.headers.get("access-control-allow-headers")?.toLowerCase()).toContain(
    "authorization",
  );

  const response = await web.handler(
    mcpRequest({
      method: "tools/call",
      params: { name: "greet", arguments: { name: "Ada" } },
      headers: { origin: "https://ui.example.com" },
    }),
  );

  expect(response.status).toBe(200);
  expect(response.headers.get("access-control-allow-origin")).toBe("https://ui.example.com");
  expect(await response.json()).toMatchObject({
    result: { structuredContent: "Hello, Ada!" },
  });
});
