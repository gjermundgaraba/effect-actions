import { describe, expect, it } from "@effect/vitest";
import { Context, Effect, Layer, Redacted, Schema } from "effect";
import { HttpRouter, HttpServerResponse } from "effect/http";
import { HttpApiMiddleware } from "effect/http-api";
import * as Action from "../../src/contract/Action.js";
import * as ActionHttp from "../../src/http/ActionHttp.js";
import * as ActionMcp from "../../src/mcp/ActionMcp.js";
import * as Authentication from "../../src/authentication/Authentication.js";
import { post, rawToolCall, withBearer } from "../support/requests.js";
import { serve } from "../support/serve.js";

const prefix = "/.well-known/oauth-protected-resource";

class Caller extends Context.Service<Caller, string>()("protected-resource/Caller") {}

const Login = Authentication.make("protected-resource.Login", Caller);

const Identify = Action.make("identify", {
  description: "Name the caller.",
  readOnly: true,
  caller: Caller,
  success: Schema.String,
});

const identify = Action.implement(Identify, () => Caller, { authorize: Action.allowAll });

const route = <ROut, E, R>(path: `/${string}`, authentication: Layer.Layer<ROut, E, R>) =>
  ActionHttp.layer(
    ActionHttp.make([Identify], { authentication: Login, prefix: path }),
    identify,
  ).pipe(Layer.provide(authentication));

let routes = 0;

const ownRoutePublishingDiscovery = (
  resource: string,
  options: {
    readonly scopesSupported?: ReadonlyArray<string>;
    readonly resourceName?: string;
  } = {},
) =>
  route(
    `/private/${(routes += 1)}`,
    Authentication.layer(Login, () => Effect.succeed("caller"), {
      protectedResource: {
        resource,
        authorizationServers: ["https://auth.example.com"],
        ...options,
      },
    }),
  );

const refusingEveryRequest = (resource = "https://api.example.com/mcp") =>
  Authentication.layer(Login, () => Effect.fail(new Action.Unauthenticated()), {
    protectedResource: { resource, authorizationServers: ["https://auth.example.com"] },
  });

it("answers before routing, so the authentication publishing it never covers it", async () => {
  const web = serve(route("/private", refusingEveryRequest()));

  expect((await web.handler(new Request(`https://api.example.com${prefix}/mcp`))).status).toBe(200);
  expect((await web.handler(post("/private/identify"))).status).toBe(401);
});

it("escapes a challenge's quoted metadata URL, whose query may hold a backslash", async () => {
  const web = serve(
    route("/private", refusingEveryRequest("https://api.example.com/mcp?tenant=alice\\")),
  );

  const refused = await web.handler(post("/private/identify"));

  expect(refused.headers.get("www-authenticate")).toBe(
    `Bearer resource_metadata="https://api.example.com${prefix}/mcp?tenant=alice\\\\"`,
  );
});

it("publishes discovery for every layer it authenticates, which share one build of it", async () => {
  let built = 0;

  const authenticate = Authentication.layer(
    Login,
    Effect.sync(() => {
      built++;

      return () => Effect.succeed("caller");
    }),
    {
      protectedResource: {
        resource: "https://api.example.com/mcp",
        authorizationServers: ["https://auth.example.com"],
      },
    },
  );

  const web = serve(Layer.mergeAll(route("/a", authenticate), route("/b", authenticate)));

  const response = await web.handler(new Request(`https://api.example.com${prefix}/mcp`));
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ resource: "https://api.example.com/mcp" });
  expect(await (await web.handler(withBearer(post("/b/identify"), "b"))).json()).toBe("caller");
  expect(built).toBe(1);
});

it("publishes discovery once per layer graph, whatever middleware runs around or inside it", async () => {
  class Tenant extends Context.Service<Tenant, string>()("protected-resource/Tenant") {}

  const resolveTenant = HttpRouter.middleware<{ provides: Tenant }>()((route) =>
    Effect.provideService(route, Tenant, "acme"),
  );

  class LogCaller extends HttpApiMiddleware.Service<LogCaller, { requires: Caller }>()(
    "protected-resource/LogCaller",
  ) {}

  const logCaller = Layer.succeed(LogCaller, (route) =>
    Effect.flatMap(Caller, (caller) =>
      Effect.map(route, HttpServerResponse.setHeader("x-caller", caller)),
    ),
  );

  let built = 0;

  const authenticate = Authentication.layer(
    Login,
    Effect.sync(() => {
      built++;

      return (token: Redacted.Redacted<string>) =>
        Effect.map(Tenant, (tenant) => `${Redacted.value(token)}@${tenant}`);
    }),
    {
      protectedResource: {
        resource: "https://api.example.com/mcp",
        authorizationServers: ["https://auth.example.com"],
      },
    },
  );

  const web = serve(
    Layer.mergeAll(
      ActionHttp.layer(ActionHttp.make([Identify], { authentication: Login }), identify, {
        middleware: [LogCaller],
      }),
      ActionMcp.layerHttp(identify, { name: "test", version: "0", authentication: Login }),
    ).pipe(Layer.provide([authenticate, logCaller]), Layer.provide(resolveTenant.layer)),
  );

  const response = await web.handler(new Request(`https://api.example.com${prefix}/mcp`));
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ resource: "https://api.example.com/mcp" });

  const http = await web.handler(withBearer(post("/api/identify"), "alice"));
  expect([await http.json(), http.headers.get("x-caller")]).toEqual(["alice@acme", "alice@acme"]);

  const tool = await web.handler(withBearer(rawToolCall("identify"), "bob"));
  expect(await tool.json()).toMatchObject({ result: { structuredContent: "bob@acme" } });
  expect(built).toBe(1);
});

describe("a resource built at startup", () => {
  class Tenant extends Context.Service<Tenant, string>()("protected-resource/BuiltTenant") {}

  class Resources extends Context.Service<
    Resources,
    Authentication.ProtectedResource | undefined
  >()("protected-resource/Resources") {}

  const resolveTenant = HttpRouter.middleware<{ provides: Tenant }>()((route) =>
    Effect.provideService(route, Tenant, "acme"),
  );

  const resourceFromServiceCountingBuilds = () => {
    const builds = { count: 0 };

    const authentication = Authentication.layer(
      Login,
      (token: Redacted.Redacted<string>) =>
        Effect.map(Tenant, (tenant) => `${Redacted.value(token)}@${tenant}`),
      {
        protectedResource: Effect.map(Resources, (resource) => {
          builds.count += 1;

          return resource;
        }),
      },
    );

    return { builds, authentication };
  };

  const routes = (
    authentication: ReturnType<typeof resourceFromServiceCountingBuilds>["authentication"],
    resource: Authentication.ProtectedResource | undefined,
  ) => {
    const authenticate = authentication.pipe(Layer.provide(Layer.succeed(Resources, resource)));

    return Layer.mergeAll(route("/a", authenticate), route("/b", authenticate)).pipe(
      Layer.provide(resolveTenant.layer),
    );
  };

  it("publishes its discovery and names it in every challenge, built once", async () => {
    const { builds, authentication } = resourceFromServiceCountingBuilds();

    const web = serve(
      routes(authentication, {
        resource: "https://api.example.com/mcp",
        authorizationServers: ["https://auth.example.com"],
        scopesRequired: ["docs:read"],
      }),
    );

    const discovered = await web.handler(new Request(`https://api.example.com${prefix}/mcp`));

    expect(discovered.status).toBe(200);
    expect(await discovered.json()).toMatchObject({ resource: "https://api.example.com/mcp" });

    const anonymous = await web.handler(post("/a/identify"));

    expect([anonymous.status, anonymous.headers.get("www-authenticate")]).toEqual([
      401,
      `Bearer scope="docs:read", resource_metadata="https://api.example.com${prefix}/mcp"`,
    ]);

    const admitted = await web.handler(withBearer(post("/b/identify"), "alice"));

    expect(await admitted.json()).toBe("alice@acme");
    expect(builds.count).toBe(1);
  });

  it("publishes nothing and challenges with a bare Bearer when it builds none", async () => {
    const web = serve(routes(resourceFromServiceCountingBuilds().authentication, undefined));

    const discovered = await web.handler(new Request(`https://api.example.com${prefix}/mcp`));
    const anonymous = await web.handler(post("/a/identify"));

    expect(discovered.status).toBe(404);
    expect([anonymous.status, anonymous.headers.get("www-authenticate")]).toEqual([401, "Bearer"]);
  });

  it("refuses a scopesRequired that is no scope token when its layer builds", async () => {
    const web = serve(
      routes(resourceFromServiceCountingBuilds().authentication, {
        resource: "https://api.example.com/mcp",
        authorizationServers: ["https://auth.example.com"],
        scopesRequired: ["docs read"],
      }),
    );

    await expect(web.handler(post("/a/identify"))).rejects.toThrow(
      'Invalid scope in scopesRequired: "docs read"',
    );
  });

  it("refuses a scopesSupported that is no scope token when its layer builds", async () => {
    const web = serve(
      routes(resourceFromServiceCountingBuilds().authentication, {
        resource: "https://api.example.com/mcp",
        authorizationServers: ["https://auth.example.com"],
        scopesSupported: ["docs:read", "docs write"],
      }),
    );

    await expect(web.handler(post("/a/identify"))).rejects.toThrow(
      'Invalid scope in scopesSupported: "docs write"',
    );
  });
});

describe("discovery across origins", () => {
  const metadata = `https://api.example.com${prefix}/mcp`;
  const origin = "https://ui.example.com";

  const browserExampleCors = HttpRouter.cors({
    allowedOrigins: [origin],
    allowedMethods: ["POST"],
    allowedHeaders: ["Content-Type", "Authorization", "MCP-Protocol-Version"],
  });

  const mcpVersionPreflightFrom = (from: string) =>
    new Request(metadata, {
      method: "OPTIONS",
      headers: {
        origin: from,
        "access-control-request-method": "GET",
        "access-control-request-headers": "mcp-protocol-version",
      },
    });

  const protectedRoutes = route("/private", refusingEveryRequest());

  it("lets any origin read the metadata and preflight it, unless the host's CORS runs first", async () => {
    const corsMergedAfterRoutes = serve(Layer.mergeAll(protectedRoutes, browserExampleCors));

    for (const method of ["GET", "HEAD"]) {
      const read = await corsMergedAfterRoutes.handler(
        new Request(metadata, { method, headers: { origin } }),
      );

      expect([read.status, read.headers.get("access-control-allow-origin")]).toEqual([200, "*"]);
    }

    const allowed = await corsMergedAfterRoutes.handler(mcpVersionPreflightFrom(origin));
    expect(allowed.status).toBe(204);
    expect(allowed.headers.get("access-control-allow-origin")).toBe("*");
    expect(allowed.headers.get("access-control-allow-methods")).toBe("GET, HEAD, OPTIONS");
    expect(allowed.headers.get("access-control-allow-headers")).toBe("mcp-protocol-version");
    expect(allowed.headers.get("vary")).toBe("Access-Control-Request-Headers");

    const corsMergedFirst = serve(Layer.mergeAll(browserExampleCors, protectedRoutes));
    const read = await corsMergedFirst.handler(new Request(metadata, { headers: { origin } }));
    expect([read.status, read.headers.get("access-control-allow-origin")]).toEqual([200, origin]);
  });

  it("lets the host's CORS, where it runs first, answer the preflight and set a read's origin, keeping * where it sets none", async () => {
    const originThePolicyRefuses = "https://other.example.com";

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

    const read = await web.handler(
      new Request(metadata, { headers: { origin: originThePolicyRefuses } }),
    );

    expect([read.status, read.headers.get("access-control-allow-origin")]).toEqual([200, "*"]);

    const refusedPreflight = await web.handler(mcpVersionPreflightFrom(originThePolicyRefuses));
    expect(refusedPreflight.status).toBe(204);
    expect(refusedPreflight.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("answers the preflight at its URL alone, allowing only the headers asked for", async () => {
    const web = serve(route("/private", refusingEveryRequest()));

    const otherPathPreflight = await web.handler(
      new Request(`https://api.example.com${prefix}/other`, { method: "OPTIONS" }),
    );

    expect(otherPathPreflight.status).toBe(404);
    expect(otherPathPreflight.headers.get("access-control-allow-origin")).toBeNull();

    const preflightAskingNoHeader = await web.handler(new Request(metadata, { method: "OPTIONS" }));
    expect(preflightAskingNoHeader.status).toBe(204);
    expect(preflightAskingNoHeader.headers.get("access-control-allow-headers")).toBeNull();
  });
});

it("publishes metadata at the resource's well-known URL", async () => {
  const resource = "https://api.example.com/mcp?tenant=alice";

  const web = serve(
    Layer.mergeAll(
      ownRoutePublishingDiscovery(resource, { scopesSupported: ["admin:read", "admin:write"] }),
      ownRoutePublishingDiscovery("https://api.example.com", { resourceName: "Root" }),
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

  const rootResourceAtBareWellKnownPath = await web.handler(
    new Request(`https://api.example.com${prefix}`),
  );

  expect(rootResourceAtBareWellKnownPath.status).toBe(200);
  expect(await rootResourceAtBareWellKnownPath.json()).toEqual({
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
      ...paths.map((path) => ownRoutePublishingDiscovery(`https://api.example.com${path}`)),
    ),
  );

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
