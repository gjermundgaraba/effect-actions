import { expect, it, onTestFinished } from "vite-plus/test";
import { Context, Effect, Layer } from "effect";
import { HttpRouter, HttpServerResponse } from "effect/unstable/http";
import * as Action from "../src/Action.js";
import * as Authentication from "../src/Authentication.js";
import { serve } from "./serve.js";

const prefix = "/.well-known/oauth-protected-resource";

class Caller extends Context.Service<Caller, string>()("protected-resource/Caller") {}

it("answers before routing, so authentication provided around it never covers it", async () => {
  const web = serve(
    Layer.mergeAll(
      Authentication.protectedResource({
        resource: "https://api.example.com/mcp",
        authorizationServers: ["https://auth.example.com"],
      }),
      HttpRouter.add("GET", "/private", Effect.map(Caller, HttpServerResponse.text)),
    ).pipe(Layer.provide(Authentication.make(Caller, Effect.fail(new Action.Unauthenticated())))),
  );

  onTestFinished(() => web.dispose());

  expect((await web.handler(new Request(`https://api.example.com${prefix}/mcp`))).status).toBe(200);
  expect((await web.handler(new Request("https://api.example.com/private"))).status).toBe(401);
});

it("publishes standalone metadata at the resource's well-known URL", async () => {
  const resource = "https://api.example.com/mcp?tenant=alice";

  const web = serve(
    Layer.mergeAll(
      Authentication.protectedResource({
        resource,
        authorizationServers: ["https://auth.example.com"],
        scopesSupported: ["admin:read", "admin:write"],
      }),
      Authentication.protectedResource({
        resource: "https://api.example.com",
        authorizationServers: ["https://auth.example.com"],
        resourceName: "Root",
      }),
    ),
  );

  onTestFinished(() => web.dispose());

  const response = await web.handler(
    new Request(`https://api.example.com${prefix}/mcp?tenant=alice`),
  );

  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toContain("application/json");
  expect(await response.json()).toEqual({
    resource,
    authorization_servers: ["https://auth.example.com"],
    scopes_supported: ["admin:read", "admin:write"],
    bearer_methods_supported: ["header"],
  });

  // A resource at the origin's root is discovered at the bare well-known path.
  const root = await web.handler(new Request(`https://api.example.com${prefix}`));
  expect(root.status).toBe(200);
  expect(await root.json()).toEqual({
    resource: "https://api.example.com",
    authorization_servers: ["https://auth.example.com"],
    bearer_methods_supported: ["header"],
    resource_name: "Root",
  });
});

it("matches literal resource paths exactly and delegates other requests to the host", async () => {
  const paths = [
    "/mcp/:tenant*",
    "/mcp/%3Atenant",
    "/mcp/trailing/",
    "/mcp?tenant=alice",
    "/mcp?tenant=a%2Fb&mode=read",
    "/mcp?tenant=alice\\",
    '/mcp"',
    "/mcp?",
    "/mcp",
  ];

  const web = serve(
    Layer.mergeAll(
      HttpRouter.add("GET", `${prefix}/mcp/unrelated`, HttpServerResponse.text("host route")),
      HttpRouter.add("POST", `${prefix}/mcp/*`, HttpServerResponse.text("host post")),
      ...paths.map((path) =>
        Authentication.protectedResource({
          resource: `https://api.example.com${path}`,
          authorizationServers: ["https://auth.example.com"],
        }),
      ),
    ),
  );

  onTestFinished(() => web.dispose());

  // The discovery URL inserts the well-known prefix before the resource's path and query.
  for (const path of paths) {
    const response = await web.handler(new Request(`https://api.example.com${prefix}${path}`));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ resource: `https://api.example.com${path}` });
  }

  const head = await web.handler(
    new Request(`https://api.example.com${prefix}/mcp/:tenant*`, { method: "HEAD" }),
  );

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
