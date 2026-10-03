import { describe, expect, it } from "@effect/vitest";
import { Context, Effect, Layer } from "effect";
import { HttpRouter, HttpServerResponse } from "effect/http";
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
      Authentication.make(Caller, Effect.succeed(Effect.succeed("caller")), {
        resource,
        authorizationServers: ["https://auth.example.com"],
        ...options,
      }).layer,
    ),
  );

/** Authentication refusing every request, as the protected resource `resource`. */
const refusing = (resource = "https://api.example.com/mcp") =>
  Authentication.make(Caller, Effect.succeed(Effect.fail(new Action.Unauthenticated())), {
    resource,
    authorizationServers: ["https://auth.example.com"],
  });

it("answers before routing, so the authentication publishing it never covers it", async () => {
  const web = serve(
    HttpRouter.add("GET", "/private", Effect.map(Caller, HttpServerResponse.text)).pipe(
      Layer.provide(refusing().layer),
    ),
  );

  expect((await web.handler(new Request(`https://api.example.com${prefix}/mcp`))).status).toBe(200);
  expect((await web.handler(new Request("https://api.example.com/private"))).status).toBe(401);
});

it("escapes a challenge's quoted metadata URL, whose query may hold a backslash", async () => {
  const web = serve(
    HttpRouter.add("GET", "/private", Effect.map(Caller, HttpServerResponse.text)).pipe(
      Layer.provide(refusing("https://api.example.com/mcp?tenant=alice\\").layer),
    ),
  );

  const refused = await web.handler(new Request("https://api.example.com/private"));

  expect(refused.headers.get("www-authenticate")).toBe(
    `Bearer resource_metadata="https://api.example.com${prefix}/mcp?tenant=alice\\\\"`,
  );
});

it("publishes discovery for every layer it authenticates, which share one build of it", async () => {
  let built = 0;

  // Discovery is published where the middleware is built, so one build publishes it once.
  const authenticate = Authentication.make(
    Caller,
    Effect.sync(() => {
      built++;

      return Effect.succeed("caller");
    }),
    {
      resource: "https://api.example.com/mcp",
      authorizationServers: ["https://auth.example.com"],
    },
  ).layer;

  const web = serve(
    Layer.mergeAll(
      HttpRouter.add("GET", "/a", HttpServerResponse.text("a")).pipe(Layer.provide(authenticate)),
      HttpRouter.add("GET", "/b", HttpServerResponse.text("b")).pipe(Layer.provide(authenticate)),
    ),
  );

  const response = await web.handler(new Request(`https://api.example.com${prefix}/mcp`));
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ resource: "https://api.example.com/mcp" });
  expect(await (await web.handler(new Request("https://api.example.com/b"))).text()).toBe("b");
  expect(built).toBe(1);
});

it("publishes discovery from every composition of its middleware", async () => {
  class Tenant extends Context.Service<Tenant, string>()("protected-resource/Tenant") {}

  const resolveTenant = HttpRouter.middleware<{ provides: Tenant }>()((route) =>
    Effect.provideService(route, Tenant, "acme"),
  );

  const logCaller = HttpRouter.middleware()((route) =>
    Effect.flatMap(Caller, (caller) =>
      Effect.map(route, HttpServerResponse.setHeader("x-caller", caller)),
    ),
  );

  const authentication = (resource: string) =>
    Authentication.make(
      Caller,
      Effect.succeed(Effect.map(Tenant, (tenant) => `caller@${tenant}`)),
      {
        resource,
        authorizationServers: ["https://auth.example.com"],
      },
    );

  // With middleware combined before it, and with middleware combined after it too: each
  // build publishes its resource.
  const web = serve(
    Layer.mergeAll(
      HttpRouter.add("GET", "/a", Effect.map(Caller, HttpServerResponse.text)).pipe(
        Layer.provide(authentication("https://api.example.com/a").combine(resolveTenant).layer),
      ),
      HttpRouter.add("GET", "/b", Effect.map(Caller, HttpServerResponse.text)).pipe(
        Layer.provide(
          logCaller.combine(authentication("https://api.example.com/b").combine(resolveTenant))
            .layer,
        ),
      ),
    ),
  );

  for (const path of ["/a", "/b"]) {
    const response = await web.handler(new Request(`https://api.example.com${prefix}${path}`));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ resource: `https://api.example.com${path}` });
  }

  const b = await web.handler(new Request("https://api.example.com/b"));
  expect([await b.text(), b.headers.get("x-caller")]).toEqual(["caller@acme", "caller@acme"]);
});

describe("discovery across origins", () => {
  const metadata = `https://api.example.com${prefix}/mcp`;
  const origin = "https://ui.example.com";

  /** The host's CORS for its own routes, as the browser example configures it. */
  const cors = HttpRouter.cors({
    allowedOrigins: [origin],
    allowedMethods: ["POST"],
    allowedHeaders: ["Content-Type", "Authorization", "MCP-Protocol-Version"],
  });

  /** The preflight of a read from `from` sending the MCP protocol version. */
  const preflight = (from: string) =>
    new Request(metadata, {
      method: "OPTIONS",
      headers: {
        origin: from,
        "access-control-request-method": "GET",
        "access-control-request-headers": "mcp-protocol-version",
      },
    });

  const protectedRoutes = HttpRouter.add(
    "GET",
    "/private",
    HttpServerResponse.text("private"),
  ).pipe(Layer.provide(refusing().layer));

  it("lets any origin read the metadata and preflight it, unless the host's CORS runs first", async () => {
    // CORS merged after the authenticated routes: discovery answers before it runs.
    const after = serve(Layer.mergeAll(protectedRoutes, cors));

    for (const method of ["GET", "HEAD"]) {
      const read = await after.handler(new Request(metadata, { method, headers: { origin } }));
      expect([read.status, read.headers.get("access-control-allow-origin")]).toEqual([200, "*"]);
    }

    const allowed = await after.handler(preflight(origin));
    expect(allowed.status).toBe(204);
    expect(allowed.headers.get("access-control-allow-origin")).toBe("*");
    expect(allowed.headers.get("access-control-allow-methods")).toBe("GET, HEAD, OPTIONS");
    expect(allowed.headers.get("access-control-allow-headers")).toBe("mcp-protocol-version");
    expect(allowed.headers.get("vary")).toBe("Access-Control-Request-Headers");

    // CORS merged first runs first: the host's own policy applies.
    const before = serve(Layer.mergeAll(cors, protectedRoutes));
    const read = await before.handler(new Request(metadata, { headers: { origin } }));
    expect([read.status, read.headers.get("access-control-allow-origin")]).toEqual([200, origin]);
  });

  it("lets the host's CORS, where it runs first, answer the preflight and set a read's origin, keeping * where it sets none", async () => {
    // A policy of several origins sets none for an origin it refuses.
    const refused = "https://other.example.com";

    const web = serve(
      Layer.mergeAll(
        HttpRouter.cors({ allowedOrigins: [origin, "https://admin.example.com"] }),
        protectedRoutes,
      ),
    );

    const allowed = await web.handler(new Request(metadata, { headers: { origin } }));
    expect([allowed.status, allowed.headers.get("access-control-allow-origin")]).toEqual([
      200,
      origin,
    ]);

    // A refused origin's read keeps discovery's own `*`; the policy refuses its preflight.
    const read = await web.handler(new Request(metadata, { headers: { origin: refused } }));
    expect([read.status, read.headers.get("access-control-allow-origin")]).toEqual([200, "*"]);

    const refusedPreflight = await web.handler(preflight(refused));
    expect(refusedPreflight.status).toBe(204);
    expect(refusedPreflight.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("answers the preflight at its URL alone, allowing only the headers asked for", async () => {
    const web = serve(
      HttpRouter.add("GET", "/private", HttpServerResponse.text("private")).pipe(
        Layer.provide(refusing().layer),
      ),
    );

    // Another path's preflight is the host's.
    const other = await web.handler(
      new Request(`https://api.example.com${prefix}/other`, { method: "OPTIONS" }),
    );

    expect(other.status).toBe(404);
    expect(other.headers.get("access-control-allow-origin")).toBeNull();

    // A preflight asking for no header allows the metadata's methods alone.
    const bare = await web.handler(new Request(metadata, { method: "OPTIONS" }));
    expect(bare.status).toBe(204);
    expect(bare.headers.get("access-control-allow-headers")).toBeNull();
  });
});

it("publishes metadata at the resource's well-known URL", async () => {
  const resource = "https://api.example.com/mcp?tenant=alice";

  const web = serve(
    Layer.mergeAll(
      published(resource, { scopesSupported: ["admin:read", "admin:write"] }),
      published("https://api.example.com", { resourceName: "Root" }),
    ),
  );

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
