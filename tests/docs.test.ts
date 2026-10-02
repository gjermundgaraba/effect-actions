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

// Documented snippets that must stay byte-identical to a type-checked example: the first
// snippets under the heading, one per file, in order.
const snippets = [
  ["README.md", "## Looks like this", ["quickstart.ts", "quickstart-server.ts"]],
  ["docs/setup.md", "## Minimal program", ["quickstart.ts", "quickstart-server.ts"]],
  ["docs/Action.md", "## Canonical", ["contracts.ts"]],
  ["docs/Action.md", "### Identity and hook", ["authorization.ts"]],
  ["docs/Action.md", "### Implementations", ["handlers.ts"]],
  ["docs/Action.md", "### Built hooks", ["authorization-built.ts"]],
  ["docs/Action.md", "### Client", ["in-process.ts"]],
  ["docs/ActionHttp.md", "## Canonical", ["binding.ts"]],
  ["docs/ActionHttp.md", "### Serving", ["http.ts"]],
  ["docs/ActionHttp.md", "### Client", ["client.ts"]],
  ["docs/ActionHttp.md", "### Promise callers", ["promise-client.ts"]],
  ["docs/Authentication.md", "## Canonical", ["authentication.ts"]],
  ["docs/Authentication.md", "### Combined with other middleware", ["authentication-tenant.ts"]],
  ["docs/Authentication.md", "### One URL for signed-out callers", ["mcp-sign-in.ts"]],
  ["docs/ActionMcp.md", "## Canonical", ["mcp.ts"]],
  ["docs/ActionCli.md", "## Canonical", ["cli.ts"]],
  ["docs/ActionCli.md", "### Over HTTP", ["cli-remote.ts"]],
  ["docs/ActionToolkit.md", "## Canonical", ["toolkit-authorized.ts"]],
  ["docs/ActionToolkit.md", "### Approval", ["toolkit-approval.ts"]],
  ["docs/Testing.md", "## Canonical", ["testing.ts"]],
  ["docs/Testing.md", "### Implementations", ["in-process.ts"]],
  ["docs/Testing.md", "### One caller", ["testing-caller.ts"]],
  ["docs/ActionMcp.md", "### Cross-origin browsers", ["mcp-browser.ts"]],
  ["docs/ActionMcp.md", "### Subprocess", ["mcp-stdio.ts"]],
] as const;

/** An example as a page shows it, importing the published package. */
const documented = (file: string) => published(read(`examples/${file}`).trim());

it.each(snippets)(
  "keeps %s %s aligned with its type-checked source",
  (document, heading, files) => {
    const section = read(document).split(`\n${heading}\n`)[1] ?? "";

    const blocks = Array.from(
      section.matchAll(/\x60{3}ts\n([\s\S]*?)\n\x60{3}/g),
      ([, code]) => code,
    );

    expect(blocks.slice(0, files.length)).toEqual(files.map(documented));
  },
);

// Code copied from a page's canonical example must compile, so every one is an example.
it("pairs every canonical snippet with a type-checked example", () => {
  const pages = readdirSync(docsDirectory).filter((name) =>
    readFileSync(join(docsDirectory, name), "utf8").includes("\n## Canonical\n"),
  );

  const paired = snippets.flatMap(([document, heading]) =>
    heading === "## Canonical" ? [document] : [],
  );

  expect(paired).toEqual(expect.arrayContaining(pages.map((page) => `docs/${page}`)));
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

it("runs the documented client against the quickstart routes", async () => {
  const web = serve(routes);

  const result = await Effect.runPromise(
    greeting.pipe(
      Effect.provideService(FetchHttpClient.Fetch, (input, init) =>
        web.handler(new Request(input, init)),
      ),
    ),
  );

  expect(result).toBe("Hello, Ada!");
});

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
