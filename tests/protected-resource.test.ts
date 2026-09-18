import { expect, it, onTestFinished } from "vite-plus/test";
import { Layer } from "effect";
import { HttpRouter, HttpServer, HttpServerResponse } from "effect/unstable/http";
import * as Authentication from "../src/Authentication.js";

it.each([
  ["https://api.example.com", "/.well-known/oauth-protected-resource"],
  ["https://api.example.com/", "/.well-known/oauth-protected-resource"],
  ["https://api.example.com?tenant=alice", "/.well-known/oauth-protected-resource?tenant=alice"],
  [
    "https://api.example.com/mcp?tenant=alice",
    "/.well-known/oauth-protected-resource/mcp?tenant=alice",
  ],
  ["https://api.example.com/mcp?", "/.well-known/oauth-protected-resource/mcp?"],
  ["https://api.example.com/api/mcp", "/.well-known/oauth-protected-resource/api/mcp"],
  ["https://api.example.com/api/mcp/", "/.well-known/oauth-protected-resource/api/mcp/"],
])("publishes standalone metadata for %s", async (resource, path) => {
  const discovery = Authentication.protectedResource({
    resource,
    authorizationServers: ["https://auth.example.com"],
    scopesSupported: ["admin:read", "admin:write"],
  });

  expect(discovery.metadataUrl).toBe(`https://api.example.com${path}`);

  const web = HttpRouter.toWebHandler(
    discovery.layer.pipe(Layer.provide(HttpServer.layerServices)),
    { disableLogger: true },
  );

  onTestFinished(() => web.dispose());
  const response = await web.handler(new Request(discovery.metadataUrl));
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toContain("application/json");
  expect(await response.json()).toEqual({
    resource,
    authorization_servers: ["https://auth.example.com"],
    scopes_supported: ["admin:read", "admin:write"],
    bearer_methods_supported: ["header"],
  });
  expect(discovery.challenge()).toBe(`Bearer resource_metadata="${discovery.metadataUrl}"`);
  expect(
    discovery.challenge({
      error: "insufficient_scope",
      errorDescription: "Owner access required",
      scope: "admin:write",
    }),
  ).toBe(
    `Bearer resource_metadata="${discovery.metadataUrl}", error="insufficient_scope", error_description="Owner access required", scope="admin:write"`,
  );
});

it("omits absent optional metadata and serves loopback development URLs", async () => {
  const discovery = Authentication.protectedResource({
    resource: "http://localhost:3000/mcp",
    authorizationServers: ["http://localhost:3000/api/auth"],
  });

  const web = HttpRouter.toWebHandler(
    discovery.layer.pipe(Layer.provide(HttpServer.layerServices)),
    { disableLogger: true },
  );

  onTestFinished(() => web.dispose());
  const metadata = await (await web.handler(new Request(discovery.metadataUrl))).json();
  expect(metadata).not.toHaveProperty("scopes_supported");
  expect(metadata).not.toHaveProperty("resource_name");
});

// Every quoted-string value round-trips through RFC 7230 quoted-string parsing.
const quotedStrings = (header: string) =>
  Object.fromEntries(
    Array.from(header.matchAll(/(\w+)="((?:[^"\\]|\\.)*)"/g), ([, name, value]) => [
      name,
      value?.replace(/\\(.)/g, "$1"),
    ]),
  );

it.each([
  'bad"header',
  "back\\slash",
  'both\\"mixed"\\',
  "read  write",
  "",
  "ünïcödé, and commas",
  '"',
  "\\",
])("quotes and escapes challenge parameter %j instead of rejecting it", (value) => {
  const discovery = Authentication.protectedResource({
    resource: "https://example.com/mcp",
    authorizationServers: ["https://auth.example.com"],
  });

  const header = discovery.challenge({
    error: "insufficient_scope",
    errorDescription: value,
    scope: value,
  });

  expect(header.startsWith("Bearer ")).toBe(true);
  expect(quotedStrings(header)).toEqual({
    resource_metadata: discovery.metadataUrl,
    error: "insufficient_scope",
    error_description: value,
    scope: value,
  });
});

it("percent-encodes quote characters in the discovery challenge URL", () => {
  const discovery = Authentication.protectedResource({
    resource: 'https://example.com/mcp"',
    authorizationServers: ["https://auth.example.com"],
  });

  expect(discovery.challenge()).toBe(
    'Bearer resource_metadata="https://example.com/.well-known/oauth-protected-resource/mcp%22"',
  );
});

it.each([
  ["a\\b", "a\\\\b"],
  ["alice\\", "alice\\\\"],
])("escapes query backslashes in the discovery challenge for %s", async (query, quotedQuery) => {
  const discovery = Authentication.protectedResource({
    resource: `https://example.com/mcp?tenant=${query}`,
    authorizationServers: ["https://auth.example.com"],
  });

  expect(discovery.metadataUrl).toBe(
    `https://example.com/.well-known/oauth-protected-resource/mcp?tenant=${query}`,
  );
  expect(discovery.challenge({ error: "invalid_token" })).toBe(
    `Bearer resource_metadata="https://example.com/.well-known/oauth-protected-resource/mcp?tenant=${quotedQuery}", error="invalid_token"`,
  );

  const web = HttpRouter.toWebHandler(
    discovery.layer.pipe(Layer.provide(HttpServer.layerServices)),
    { disableLogger: true },
  );

  onTestFinished(() => web.dispose());
  const response = await web.handler(new Request(discovery.metadataUrl));
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    resource: `https://example.com/mcp?tenant=${query}`,
  });
});

it("matches literal resource paths exactly and delegates other requests to the host", async () => {
  const paths = [
    "/mcp/:tenant",
    "/mcp/*",
    "/mcp/a*b",
    "/mcp/%3Atenant",
    "/mcp/%2A",
    "/mcp/trailing/",
    "/mcp?tenant=alice",
    "/mcp?tenant=bob",
    "/mcp?tenant=a%2Fb&mode=read",
    "/mcp?",
    "/mcp",
  ];

  const discoveries = paths.map((path) =>
    Authentication.protectedResource({
      resource: `https://api.example.com${path}`,
      authorizationServers: ["https://auth.example.com"],
    }),
  );

  const prefix = "/.well-known/oauth-protected-resource";

  const web = HttpRouter.toWebHandler(
    Layer.mergeAll(
      HttpRouter.add("GET", `${prefix}/mcp/unrelated`, HttpServerResponse.text("host route")),
      HttpRouter.add("POST", `${prefix}/mcp/*`, HttpServerResponse.text("host post")),
      ...discoveries.map((discovery) => discovery.layer),
    ).pipe(Layer.provide(HttpServer.layerServices)),
    { disableLogger: true },
  );

  onTestFinished(() => web.dispose());

  for (const [index, discovery] of discoveries.entries()) {
    const response = await web.handler(new Request(discovery.metadataUrl));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBeNull();
    expect(await response.json()).toMatchObject({
      resource: `https://api.example.com${paths[index]}`,
    });
    const head = await web.handler(new Request(discovery.metadataUrl, { method: "HEAD" }));
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
  }

  const unrelated = await web.handler(
    new Request(`https://api.example.com${prefix}/mcp/unrelated`),
  );

  expect(await unrelated.text()).toBe("host route");

  for (const path of [
    "/mcp/unregistered",
    "/mcp/a/b",
    "/mcp/trailing",
    "/mcp/:other",
    "/MCP/:tenant",
    "/mcp?tenant=carol",
    "/mcp?tenant=alice&extra=1",
    "/mcp?tenant=a/b&mode=read",
  ]) {
    expect((await web.handler(new Request(`https://api.example.com${prefix}${path}`))).status).toBe(
      404,
    );
  }

  const post = await web.handler(
    new Request(`https://api.example.com${prefix}/mcp/:tenant`, { method: "POST" }),
  );

  expect(await post.text()).toBe("host post");
});
