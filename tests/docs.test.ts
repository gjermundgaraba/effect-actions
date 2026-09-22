import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it, onTestFinished } from "vite-plus/test";
import { Effect, Layer } from "effect";
import { FetchHttpClient, HttpRouter, HttpServer } from "effect/unstable/http";
import { routes } from "../examples/quickstart.js";
import { routes as browserRoutes } from "../examples/mcp-browser.js";
import { greeting } from "../examples/quickstart-client.js";
import { docsDirectory } from "../scripts/skill.ts";
import { mcpRequest } from "../src/Testing.js";

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

// Documented snippets that must stay byte-identical to a type-checked example.
it.each([
  ["README.md", "## Looks like this", "quickstart.ts"],
  ["docs/README.md", "## Minimal program", "quickstart.ts"],
  ["docs/ActionHttp.md", "### Client", "quickstart-client.ts"],
  ["docs/ActionCli.md", "## Canonical", "cli.ts"],
  ["docs/ActionCliClient.md", "## Canonical", "cli-client.ts"],
  ["docs/ActionCliClient.md", "### Options", "cli-client-options.ts"],
  ["docs/ActionCatalog.md", "## Canonical", "catalog.ts"],
  ["docs/ActionToolkit.md", "## Canonical", "toolkit-authorized.ts"],
  ["docs/Testing.md", "## API", "testing-http-client.ts"],
  ["docs/Testing.md", "## Canonical", "testing.ts"],
  ["docs/ActionMcp.md", "### Cross-origin browsers", "mcp-browser.ts"],
  ["docs/ActionMcp.md", "### Subprocess", "mcp-stdio.ts"],
])("keeps %s %s aligned with its type-checked source", (document, heading, file) => {
  const source = read(`examples/${file}`)
    .trim()
    .replace(/"\.\.\/src\/(\w+)\.js"/g, '"@gjermundgaraba/effect-actions/$1"');

  const section = read(document).split(`\n${heading}\n`)[1];
  const snippet = section?.match(/\x60{3}ts\n([\s\S]*?)\n\x60{3}/)?.[1];
  expect(snippet).toBe(source);
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
  const web = HttpRouter.toWebHandler(routes.pipe(Layer.provide(HttpServer.layerServices)), {
    disableLogger: true,
  });

  onTestFinished(() => web.dispose());

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
  const web = HttpRouter.toWebHandler(browserRoutes.pipe(Layer.provide(HttpServer.layerServices)), {
    disableLogger: true,
  });

  onTestFinished(() => web.dispose());

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
      url: "http://localhost/mcp",
      method: "tools/call",
      params: { name: "greet", arguments: { name: "Ada" } },
      headers: { origin: "https://ui.example.com" },
    }),
  );

  expect(response.status).toBe(200);
  expect(response.headers.get("access-control-allow-origin")).toBe("https://ui.example.com");
  expect(await response.json()).toMatchObject({
    result: { structuredContent: { value: "Hello, Ada!" } },
  });
});
