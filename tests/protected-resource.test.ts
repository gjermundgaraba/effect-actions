import { expect, it, onTestFinished } from "vite-plus/test";
import { Layer } from "effect";
import { HttpRouter, HttpServer, HttpServerResponse } from "effect/unstable/http";
import * as Authentication from "../src/Authentication.js";

it("publishes standalone metadata and a bearer challenge", async () => {
  const resource = "https://api.example.com/mcp?tenant=alice";

  const discovery = Authentication.protectedResource({
    resource,
    authorizationServers: ["https://auth.example.com"],
    scopesSupported: ["admin:read", "admin:write"],
  });

  expect(discovery.metadataUrl).toBe(
    "https://api.example.com/.well-known/oauth-protected-resource/mcp?tenant=alice",
  );
  expect(
    Authentication.protectedResource({
      resource: "https://api.example.com",
      authorizationServers: ["https://auth.example.com"],
    }).metadataUrl,
  ).toBe("https://api.example.com/.well-known/oauth-protected-resource");

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

// Every quoted-string value round-trips through RFC 7230 quoted-string parsing.
const quotedStrings = (header: string) =>
  Object.fromEntries(
    Array.from(
      header.matchAll(/(\w+)="((?:[^"\\]|\\.)*)"/g),
      ([, name, value]): [string, string] => [
        // SAFETY: neither group is optional, so both participate in every match of this pattern.
        name!,
        value!.replace(/\\(.)/g, "$1"),
      ],
    ),
  );

it("quotes and escapes bearer challenge parameters", () => {
  const discovery = Authentication.protectedResource({
    resource: "https://example.com/mcp",
    authorizationServers: ["https://auth.example.com"],
  });

  const value = 'both\\"mixed"\\';

  const header = discovery.challenge({
    error: "insufficient_scope",
    errorDescription: value,
    scope: value,
  });

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

it("escapes a query backslash in the discovery challenge", () => {
  const discovery = Authentication.protectedResource({
    resource: "https://example.com/mcp?tenant=alice\\",
    authorizationServers: ["https://auth.example.com"],
  });

  expect(discovery.challenge({ error: "invalid_token" })).toBe(
    'Bearer resource_metadata="https://example.com/.well-known/oauth-protected-resource/mcp?tenant=alice\\\\", error="invalid_token"',
  );
});

it("matches literal resource paths exactly and delegates other requests to the host", async () => {
  const paths = [
    "/mcp/:tenant*",
    "/mcp/%3Atenant",
    "/mcp/trailing/",
    "/mcp?tenant=alice",
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
    expect(await response.json()).toMatchObject({
      resource: `https://api.example.com${paths[index]}`,
    });
  }

  const representative = discoveries[0];

  if (representative === undefined) throw new Error("Expected a discovery document");
  const head = await web.handler(new Request(representative.metadataUrl, { method: "HEAD" }));
  expect(head.status).toBe(200);
  expect(await head.text()).toBe("");

  const unrelated = await web.handler(
    new Request(`https://api.example.com${prefix}/mcp/unrelated`),
  );

  expect(await unrelated.text()).toBe("host route");

  for (const path of [
    "/mcp/unregistered",
    "/mcp/trailing",
    "/MCP/:tenant*",
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
