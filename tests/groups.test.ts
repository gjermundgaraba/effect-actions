import { expect, it, onTestFinished } from "vite-plus/test";
import { Context, Effect, Layer, Schema } from "effect";
import {
  HttpRouter,
  HttpServer,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/unstable/http";
import { HttpApi, OpenApi } from "effect/unstable/httpapi";
import { Action, ActionGroup, ActionHttp, ActionMcp } from "../src/index.js";
import { httpClient, mcpRequest } from "../src/Testing.js";

class Tenant extends Context.Service<Tenant, string>()("groups-test/Tenant") {}

const Users = ActionGroup.make(
  "users",
  Action.make("whoAmI", { description: "Current user", success: Schema.String }),
);

const Billing = ActionGroup.make(
  "billing",
  Action.make("invoice", {
    description: "Invoice total",
    input: Schema.Struct({ amount: Schema.FiniteFromString }),
    success: Schema.Finite,
  }),
  Action.make("audit", { description: "MCP only", success: Schema.String, http: false }),
);

const UsersApp = Users.implement(
  Effect.map(Tenant, (tenant) => ({ whoAmI: () => Effect.succeed(`ada@${tenant}`) })),
);

const BillingApp = Billing.implement({
  invoice: ({ amount }) => Effect.succeed(amount * 2),
  audit: () => Effect.succeed("clean"),
});

const Http = ActionHttp.make([Users, Billing], { apiPath: "/api" });

const serve = () => {
  const web = HttpRouter.toWebHandler(
    Layer.mergeAll(
      Http.layer([UsersApp, BillingApp], { openapiPath: "/openapi.json" }),
      ActionMcp.layer([UsersApp, BillingApp], { name: "test", version: "0", path: "/mcp" }),
    ).pipe(Layer.provide(Layer.succeed(Tenant, "acme")), Layer.provide(HttpServer.layerServices)),
    { disableLogger: true },
  );

  onTestFinished(() => web.dispose());

  return web;
};

it("serves several groups through one flat client and one document", async () => {
  const web = serve();

  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const client = yield* httpClient(Http, web.handler);

      return [yield* client.whoAmI(), yield* client.invoice({ amount: 21 })];
    }),
  );

  expect(result).toEqual(["ada@acme", 42]);

  const document = Http.openapi();
  expect(await (await web.handler(new Request("http://localhost/openapi.json"))).json()).toEqual(
    document,
  );
  expect(Object.keys(document.paths)).toEqual(["/api/whoAmI", "/api/invoice"]);
  expect(document.paths["/api/whoAmI"]?.post?.operationId).toBe("users.whoAmI");
  expect(document.paths["/api/invoice"]?.post?.tags).toEqual(["billing"]);
});

it("keeps every group when a host combines separately mounted APIs", () => {
  const combined = HttpApi.make("host")
    .addHttpApi(ActionHttp.make(Users, { apiPath: "/public" }).api)
    .addHttpApi(ActionHttp.make(Billing, { apiPath: "/admin" }).api);

  expect(Object.keys(OpenApi.fromApi(combined).paths)).toEqual([
    "/public/whoAmI",
    "/admin/invoice",
  ]);
});

it("serves several groups as the tools of one MCP endpoint", async () => {
  const web = serve();

  const response = await web.handler(
    mcpRequest({ url: "http://localhost/mcp", method: "tools/list" }),
  );

  const reply = Schema.decodeUnknownSync(
    Schema.Struct({
      result: Schema.Struct({ tools: Schema.Array(Schema.Struct({ name: Schema.String })) }),
    }),
  )(await response.json());

  expect(reply.result.tools.map((tool) => tool.name).sort()).toEqual([
    "audit",
    "invoice",
    "whoAmI",
  ]);
});

const Alpha = Action.make("alpha", { description: "Alpha", success: Schema.String });

const A = ActionGroup.make("a", Alpha);

const post = (path: string) =>
  new Request(`http://localhost${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });

it("never dispatches to a handler its own group did not declare", async () => {
  const B = ActionGroup.make(
    "b",
    Action.make("beta", { description: "Beta", success: Schema.String }),
  );

  const web = HttpRouter.toWebHandler(
    ActionHttp.make([A, B], { apiPath: "/api" })
      .layer(
        [
          A.implement({ alpha: () => Effect.succeed("right") }),
          // The constraint on handler records admits extra keys.
          B.implement({
            beta: () => Effect.succeed("beta"),
            alpha: () => Effect.succeed("wrong group"),
          }),
        ],
        { openapiPath: false },
      )
      .pipe(Layer.provide(HttpServer.layerServices)),
    { disableLogger: true },
  );

  onTestFinished(() => web.dispose());
  expect(await (await web.handler(post("/api/alpha"))).json()).toBe("right");
});

it("pairs implementations with groups by identity, in any order", async () => {
  const web = HttpRouter.toWebHandler(
    Http.layer([BillingApp, UsersApp], { openapiPath: false }).pipe(
      Layer.provide(Layer.succeed(Tenant, "acme")),
      Layer.provide(HttpServer.layerServices),
    ),
    { disableLogger: true },
  );

  onTestFinished(() => web.dispose());
  expect(await (await web.handler(post("/api/whoAmI"))).json()).toBe("ada@acme");

  const lookAlike = ActionGroup.make("other", Alpha).implement({
    alpha: () => Effect.succeed("x"),
  });

  const bound = ActionHttp.make(A, { apiPath: "/api" });

  // @ts-expect-error The group is part of an implementation's type, so this does not compile either.
  expect(() => bound.layer(lookAlike, { openapiPath: false })).toThrow(
    'Implementation of group "other" is not served by this adapter',
  );
  expect(() => Http.layer([UsersApp], { openapiPath: false })).toThrow(
    'Missing implementation for group "billing"',
  );
  expect(() => Http.layer([UsersApp, BillingApp, BillingApp], { openapiPath: false })).toThrow(
    'Duplicate implementation for group "billing"',
  );
});

it("acquires only the implementations a transport serves", async () => {
  const built: Array<string> = [];

  const record = <H>(name: string, handlers: H) =>
    Effect.sync(() => {
      built.push(name);

      return handlers;
    });

  const McpOnly = ActionGroup.make(
    "mcpOnly",
    Action.make("tool", { description: "Tool", success: Schema.String, http: false }),
  );

  const HttpOnly = ActionGroup.make(
    "httpOnly",
    Action.make("route", { description: "Route", success: Schema.String, mcp: false }),
  );

  const apps = [
    McpOnly.implement(record("mcpOnly", { tool: () => Effect.succeed("tool") })),
    HttpOnly.implement(record("httpOnly", { route: () => Effect.succeed("route") })),
  ] as const;

  for (const [routes, expected] of [
    [
      ActionHttp.make([McpOnly, HttpOnly], { apiPath: "/api" }).layer(apps, { openapiPath: false }),
      "httpOnly",
    ],
    [ActionMcp.layer(apps, { name: "test", version: "0", path: "/mcp" }), "mcpOnly"],
  ] as const) {
    built.length = 0;

    const web = HttpRouter.toWebHandler(routes.pipe(Layer.provide(HttpServer.layerServices)), {
      disableLogger: true,
    });

    await web.handler(post("/api/route"));
    await web.dispose();
    expect(built).toEqual([expected]);
  }
});

it("reads only the actions a transport serves", async () => {
  const Web = ActionGroup.make(
    "web",
    Action.make("ping", { description: "HTTP only", success: Schema.String, mcp: false }),
  );

  // Same name on the other transport, with an input that accepts `undefined`.
  const Tools = ActionGroup.make(
    "tools",
    Action.make("ping", {
      description: "MCP only",
      input: Schema.UndefinedOr(Schema.Struct({ value: Schema.optional(Schema.String) })),
      success: Schema.String,
      http: false,
    }),
  );

  const bound = ActionHttp.make([Web, Tools], { apiPath: "/api" });
  const webApp = Web.implement({ ping: () => Effect.succeed("pong") });

  // The unserved group needs no implementation, and giving one changes nothing.
  for (const apps of [
    [webApp],
    [webApp, Tools.implement({ ping: () => Effect.succeed("tool") })],
  ]) {
    const web = HttpRouter.toWebHandler(
      bound.layer(apps, { openapiPath: false }).pipe(Layer.provide(HttpServer.layerServices)),
      { disableLogger: true },
    );

    const result = await Effect.runPromise(
      Effect.flatMap(httpClient(bound, web.handler), (client) => client.ping()),
    );

    await web.dispose();
    expect(result).toBe("pong");
  }

  expect(Object.keys(bound.api.groups)).toEqual(["web"]);
});

it("shares one ordinary array of implementations between the adapters", async () => {
  const apps = [UsersApp, BillingApp].filter(() => true);

  const web = HttpRouter.toWebHandler(
    Layer.mergeAll(
      Http.layer(apps, { openapiPath: false }),
      ActionMcp.layer(apps, { name: "test", version: "0", path: "/mcp" }),
    ).pipe(Layer.provide(Layer.succeed(Tenant, "acme")), Layer.provide(HttpServer.layerServices)),
    { disableLogger: true },
  );

  onTestFinished(() => web.dispose());
  expect(await (await web.handler(post("/api/whoAmI"))).json()).toBe("ada@acme");
  expect(
    (await web.handler(mcpRequest({ url: "http://localhost/mcp", method: "tools/list" }))).status,
  ).toBe(200);
});

it("scopes router middleware to the layer that registers the routes", async () => {
  // Blocks every request of this test; only the pass-through branch keeps it a middleware.
  const blocked = HttpRouter.middleware((next) =>
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;

      if (request.headers["x-allow"] === "yes") return yield* next;

      return HttpServerResponse.text("blocked", { status: 403 });
    }),
  ).layer;

  const groups = Layer.mergeAll(Http.group(UsersApp), Http.group(BillingApp)).pipe(
    Layer.provide(Layer.succeed(Tenant, "acme")),
  );

  const serve = (
    routes: Layer.Layer<
      never,
      never,
      HttpRouter.HttpRouter | Layer.Success<typeof HttpServer.layerServices>
    >,
  ) => {
    const web = HttpRouter.toWebHandler(routes.pipe(Layer.provide(HttpServer.layerServices)), {
      disableLogger: true,
    });

    onTestFinished(() => web.dispose());

    return async () => [
      (await web.handler(new Request("http://localhost/openapi.json"))).status,
      (await web.handler(post("/api/whoAmI"))).status,
    ];
  };

  const root = Http.groups({ openapiPath: "/openapi.json" });

  // Provided to the root alone, it guards the document; the groups are built outside it.
  expect(await serve(root.pipe(Layer.provide(blocked), Layer.provide(groups)))()).toEqual([
    403, 200,
  ]);
  // Provided to one group, it guards that group.
  expect(
    await serve(
      root.pipe(
        Layer.provide(Http.group(UsersApp).pipe(Layer.provide(blocked))),
        Layer.provide(Http.group(BillingApp)),
        Layer.provide(Layer.succeed(Tenant, "acme")),
      ),
    )(),
  ).toEqual([200, 403]);
  // Provided around everything, it guards everything.
  expect(await serve(root.pipe(Layer.provide(groups), Layer.provide(blocked)))()).toEqual([
    403, 403,
  ]);
});

it("serves the bound document from the document route", async () => {
  const web = HttpRouter.toWebHandler(
    Http.layer([UsersApp, BillingApp], { openapiPath: "/openapi.json" }).pipe(
      Layer.provide(Layer.succeed(Tenant, "acme")),
      Layer.provide(HttpServer.layerServices),
    ),
    { disableLogger: true },
  );

  onTestFinished(() => web.dispose());
  expect(await (await web.handler(new Request("http://localhost/openapi.json"))).json()).toEqual(
    Http.openapi(),
  );
});

it("checks each namespace only where it is served", () => {
  const Other = ActionGroup.make(
    "other",
    Action.make("whoAmI", { description: "Collides", success: Schema.String }),
  );

  const again = ActionGroup.make(
    "users",
    Action.make("other", { description: "", success: Schema.String }),
  );

  const aliased = (group: string, action: string) =>
    ActionGroup.make(
      group,
      Action.make(action, { description: "", success: Schema.String, mcp: { name: "same" } }),
    );

  // Routes and client methods are flat; groups are native group identifiers.
  expect(() => ActionHttp.make([Users, Other], { apiPath: "/api" })).toThrow(
    "Duplicate action: whoAmI",
  );
  expect(() => ActionHttp.make([Users, again], { apiPath: "/api" })).toThrow(
    "Duplicate action group: users",
  );

  // MCP aliases are not an HTTP concern, nor are the names of MCP-only actions.
  const one = aliased("one", "first");
  const two = aliased("two", "second");
  expect(() => ActionHttp.make([one, two], { apiPath: "/api" })).not.toThrow();
  expect(() =>
    ActionHttp.make(
      [
        Users,
        ActionGroup.make(
          "tools",
          Action.make("whoAmI", {
            description: "",
            success: Schema.String,
            http: false,
            mcp: { name: "who" },
          }),
        ),
      ],
      { apiPath: "/api" },
    ),
  ).not.toThrow();

  // A group's name is its identity to this adapter, served or not: otherwise an
  // MCP-only namesake could stand in for the group whose routes are missing.
  expect(() =>
    ActionHttp.make(
      [
        Users,
        ActionGroup.make(
          "users",
          Action.make("tool", { description: "", success: Schema.String, http: false }),
        ),
      ],
      { apiPath: "/api" },
    ),
  ).toThrow("Duplicate action group: users");

  // Tools are the MCP namespace; group and action names are not.
  const mcp = { name: "test", version: "0", path: "/mcp" } as const;

  expect(() =>
    ActionMcp.layer(
      [
        one.implement({ first: () => Effect.succeed("a") }),
        two.implement({ second: () => Effect.succeed("b") }),
      ],
      mcp,
    ),
  ).toThrow("Duplicate MCP tool: same");
  expect(() =>
    ActionMcp.layer(
      [
        Users.implement({ whoAmI: () => Effect.succeed("a") }),
        again.implement({ other: () => Effect.succeed("b") }),
      ],
      mcp,
    ),
  ).not.toThrow();
});
