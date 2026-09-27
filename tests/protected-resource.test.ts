import { expect, it, onTestFinished } from "vite-plus/test";
import { Context, Effect, Layer } from "effect";
import { HttpRouter, HttpServerResponse } from "effect/unstable/http";
import * as Action from "../src/Action.js";
import * as Authentication from "../src/Authentication.js";
import { serve } from "./serve.js";

const prefix = "/.well-known/oauth-protected-resource";

class Caller extends Context.Service<Caller, string>()("protected-resource/Caller") {}

let routes = 0;

/**
 * A route of its own authenticated as the protected resource `resource`, which publishes
 * the resource's discovery.
 */
const published = (
  resource: string,
  options: {
    readonly scopesSupported?: ReadonlyArray<string>;
    readonly resourceName?: string;
  } = {},
) =>
  HttpRouter.add("GET", `/private/${(routes += 1)}`, HttpServerResponse.text("private")).pipe(
    Layer.provide(
      Authentication.make(Caller, Effect.succeed("caller"), {
        resource,
        authorizationServers: ["https://auth.example.com"],
        ...options,
      }),
    ),
  );

it("answers before routing, so the authentication publishing it never covers it", async () => {
  const web = serve(
    HttpRouter.add("GET", "/private", Effect.map(Caller, HttpServerResponse.text)).pipe(
      Layer.provide(
        Authentication.make(Caller, Effect.fail(new Action.Unauthenticated()), {
          resource: "https://api.example.com/mcp",
          authorizationServers: ["https://auth.example.com"],
        }),
      ),
    ),
  );

  onTestFinished(() => web.dispose());

  expect((await web.handler(new Request(`https://api.example.com${prefix}/mcp`))).status).toBe(200);

  const refused = await web.handler(new Request("https://api.example.com/private"));
  expect(refused.status).toBe(401);
  // The challenge names the metadata URL, and no error code, credentials or not.
  expect(refused.headers.get("www-authenticate")).toBe(
    `Bearer resource_metadata="https://api.example.com${prefix}/mcp"`,
  );

  const invalid = await web.handler(
    new Request("https://api.example.com/private", { headers: { authorization: "Bearer x" } }),
  );

  expect(invalid.headers.get("www-authenticate")).toBe(refused.headers.get("www-authenticate"));
});

it("publishes discovery for every layer it authenticates, which may share it", async () => {
  const authenticate = Authentication.make(Caller, Effect.succeed("caller"), {
    resource: "https://api.example.com/mcp",
    authorizationServers: ["https://auth.example.com"],
  });

  const web = serve(
    Layer.mergeAll(
      HttpRouter.add("GET", "/a", HttpServerResponse.text("a")).pipe(Layer.provide(authenticate)),
      HttpRouter.add("GET", "/b", HttpServerResponse.text("b")).pipe(Layer.provide(authenticate)),
    ),
  );

  onTestFinished(() => web.dispose());

  const response = await web.handler(new Request(`https://api.example.com${prefix}/mcp`));
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ resource: "https://api.example.com/mcp" });
  expect(await (await web.handler(new Request("https://api.example.com/b"))).text()).toBe("b");
});

it("publishes metadata at the resource's well-known URL", async () => {
  const resource = "https://api.example.com/mcp?tenant=alice";

  const web = serve(
    Layer.mergeAll(
      published(resource, { scopesSupported: ["admin:read", "admin:write"] }),
      published("https://api.example.com", { resourceName: "Root" }),
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
      ...paths.map((path) => published(`https://api.example.com${path}`)),
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
