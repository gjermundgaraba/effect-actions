import { McpProtocol } from "effect/unstable/ai";
import { expect, it, onTestFinished } from "vite-plus/test";
import { Context, Effect, Layer, Schema } from "effect";
import {
  HttpRouter,
  HttpServer,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/unstable/http";
import { HttpApi, OpenApi } from "effect/unstable/httpapi";
import * as Action from "../src/Action.js";
import * as ActionGroup from "../src/ActionGroup.js";
import * as ActionHttp from "../src/ActionHttp.js";
import * as ActionMcp from "../src/ActionMcp.js";
import { httpClient, mcpRequest } from "../src/Testing.js";

class Tenant extends Context.Service<Tenant, string>()("groups-test/Tenant") {}

const Users = ActionGroup.make(
  { name: "users" },
  Action.make("whoAmI", { description: "Current user", success: Schema.String }),
);

const Billing = ActionGroup.make(
  { name: "billing" },
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

const Http = ActionHttp.make({ apiPath: "/api" }, Users, Billing);

const serve = () => {
  const web = HttpRouter.toWebHandler(
    Layer.mergeAll(
      Http.layer(UsersApp),
      Http.layer(BillingApp),
      ActionMcp.layer(
        { protocols: [McpProtocol.v2026_07_28], name: "test", version: "0", path: "/mcp" },
        UsersApp,
        BillingApp,
      ),
    ).pipe(Layer.provide(Layer.succeed(Tenant, "acme")), Layer.provide(HttpServer.layerServices)),
    { disableLogger: true },
  );

  onTestFinished(() => web.dispose());

  return web;
};

it("serves several groups through one native grouped client and one document", async () => {
  const web = serve();

  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const client = yield* httpClient(Http.api, web.handler);

      return [
        yield* client.users.whoAmI({ payload: {} }),
        yield* client.billing.invoice({ payload: { amount: 21 } }),
      ];
    }),
  );

  expect(result).toEqual(["ada@acme", 42]);

  const document = OpenApi.fromApi(Http.api);
  expect(Object.keys(document.paths)).toEqual(["/api/whoAmI", "/api/invoice"]);
  expect(document.paths["/api/whoAmI"]?.post?.operationId).toBe("users.whoAmI");
  expect(document.paths["/api/invoice"]?.post?.tags).toEqual(["billing"]);
});

it("keeps every group when a host combines separately mounted APIs", () => {
  const combined = HttpApi.make("host")
    .addHttpApi(ActionHttp.make({ apiPath: "/public" }, Users).api)
    .addHttpApi(ActionHttp.make({ apiPath: "/admin" }, Billing).api);

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

const A = ActionGroup.make({ name: "a" }, Alpha);

const post = (path: string) =>
  new Request(`http://localhost${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });

const handlerOf = <E>(
  routes: Layer.Layer<
    never,
    E,
    HttpRouter.HttpRouter | Layer.Success<typeof HttpServer.layerServices>
  >,
) => {
  const web = HttpRouter.toWebHandler(routes.pipe(Layer.provide(HttpServer.layerServices)), {
    disableLogger: true,
  });

  onTestFinished(() => web.dispose());

  return web.handler;
};

it("never dispatches to a handler its own group did not declare", async () => {
  const B = ActionGroup.make(
    { name: "b" },
    Action.make("beta", { description: "Beta", success: Schema.String }),
  );

  const bound = ActionHttp.make({ apiPath: "/api" }, A, B);

  const handler = handlerOf(
    Layer.mergeAll(
      bound.layer(A.implement({ alpha: () => Effect.succeed("right") })),
      // The constraint on handler records admits extra keys.
      bound.layer(
        B.implement({
          beta: () => Effect.succeed("beta"),
          alpha: () => Effect.succeed("wrong group"),
        }),
      ),
    ),
  );

  expect(await (await handler(post("/api/alpha"))).json()).toBe("right");
});

it("mounts only implementations of the groups it was made with", () => {
  const lookAlike = ActionGroup.make({ name: "a" }, Alpha).implement({
    alpha: () => Effect.succeed("x"),
  });

  const other = ActionGroup.make({ name: "other" }, Alpha).implement({
    alpha: () => Effect.succeed("x"),
  });

  const bound = ActionHttp.make({ apiPath: "/api" }, A);

  // Pairing is by identity: the same name and actions do not make it this group.
  expect(() => bound.layer(lookAlike)).toThrow(
    'Implementation of group "a" is not served by this adapter',
  );
  // @ts-expect-error The group is part of an implementation's type, so this does not compile either.
  expect(() => bound.layer(other)).toThrow(
    'Implementation of group "other" is not served by this adapter',
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
    { name: "mcpOnly" },
    Action.make("tool", { description: "Tool", success: Schema.String, http: false }),
  );

  const HttpOnly = ActionGroup.make(
    { name: "httpOnly" },
    Action.make("route", { description: "Route", success: Schema.String, mcp: false }),
  );

  const mcpOnly = McpOnly.implement(record("mcpOnly", { tool: () => Effect.succeed("tool") }));
  const httpOnly = HttpOnly.implement(record("httpOnly", { route: () => Effect.succeed("route") }));
  const bound = ActionHttp.make({ apiPath: "/api" }, McpOnly, HttpOnly);

  for (const [routes, expected] of [
    [Layer.mergeAll(bound.layer(mcpOnly), bound.layer(httpOnly)), "httpOnly"],
    [
      ActionMcp.layer(
        { protocols: [McpProtocol.v2026_07_28], name: "test", version: "0", path: "/mcp" },
        mcpOnly,
        httpOnly,
      ),
      "mcpOnly",
    ],
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
    { name: "web" },
    Action.make("ping", { description: "HTTP only", success: Schema.String, mcp: false }),
  );

  // Same name on the other transport, with an input that accepts `undefined`.
  const Tools = ActionGroup.make(
    { name: "tools" },
    Action.make("ping", {
      description: "MCP only",
      input: Schema.UndefinedOr(Schema.Struct({ value: Schema.optional(Schema.String) })),
      success: Schema.String,
      http: false,
    }),
  );

  const bound = ActionHttp.make({ apiPath: "/api" }, Web, Tools);
  const handler = handlerOf(bound.layer(Web.implement({ ping: () => Effect.succeed("pong") })));

  const result = await Effect.runPromise(
    Effect.flatMap(httpClient(bound.api, handler), (client) => client.web.ping({ payload: {} })),
  );

  expect(result).toBe("pong");
  expect(Object.keys(bound.api.groups)).toEqual(["web"]);
});

it("scopes router middleware to the layer it is provided to", async () => {
  // Blocks every request of this test; only the pass-through branch keeps it a middleware.
  const blocked = HttpRouter.middleware((next) =>
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;

      if (request.headers["x-allow"] === "yes") return yield* next;

      return HttpServerResponse.text("blocked", { status: 403 });
    }),
  ).layer;

  const tenant = Layer.provide(Layer.succeed(Tenant, "acme"));
  const users = Http.layer(UsersApp).pipe(tenant);
  const billing = Http.layer(BillingApp);

  // The document is an ordinary route over the native API, so it takes middleware like any other.
  const document = HttpRouter.add(
    "GET",
    "/openapi.json",
    HttpServerResponse.jsonUnsafe(OpenApi.fromApi(Http.api)),
  );

  const statuses = async (handler: (request: Request) => Promise<Response>) => [
    (await handler(new Request("http://localhost/openapi.json"))).status,
    (await handler(post("/api/whoAmI"))).status,
    (await handler(post("/api/invoice"))).status,
  ];

  // Each layer registers its own routes, so a guard covers exactly what it is provided to.
  expect(
    await statuses(
      handlerOf(Layer.mergeAll(document.pipe(Layer.provide(blocked)), users, billing)),
    ),
  ).toEqual([403, 200, 400]);
  expect(
    await statuses(
      handlerOf(Layer.mergeAll(document, users.pipe(Layer.provide(blocked)), billing)),
    ),
  ).toEqual([200, 403, 400]);
  expect(
    await statuses(
      handlerOf(Layer.mergeAll(document, users, billing).pipe(Layer.provide(blocked))),
    ),
  ).toEqual([403, 403, 403]);
});

it("adds a group's errors to every action, on both transports", async () => {
  class Refused extends Schema.TaggedError<Refused>()(
    "Refused",
    { reason: Schema.String },
    { httpApiStatus: 403 },
  ) {}

  class Missing extends Schema.TaggedError<Missing>()("Missing", {}, { httpApiStatus: 404 }) {}

  const Guarded = ActionGroup.make(
    { name: "guarded", errors: [Refused] },
    Action.make("find", { description: "Find", success: Schema.String, errors: [Missing] }),
    Action.make("list", { description: "List", success: Schema.String }),
  );

  expect(Guarded.actions.map((action) => action.errors)).toEqual([[Missing, Refused], [Refused]]);

  const app = Guarded.implement({
    find: () => Effect.fail(new Missing()),
    list: () => Effect.fail(new Refused({ reason: "closed" })),
  });

  const bound = ActionHttp.make({ apiPath: "/api" }, Guarded);

  const handler = handlerOf(
    Layer.mergeAll(
      bound.layer(app),
      ActionMcp.layer(
        { protocols: [McpProtocol.v2026_07_28], name: "test", version: "0", path: "/mcp" },
        app,
      ),
    ),
  );

  expect((await handler(post("/api/find"))).status).toBe(404);
  const refused = await handler(post("/api/list"));
  expect(refused.status).toBe(403);
  expect(await refused.json()).toEqual(
    Schema.encodeSync(Refused)(new Refused({ reason: "closed" })),
  );

  const tool = await handler(
    mcpRequest({
      url: "http://localhost/mcp",
      method: "tools/call",
      params: { name: "list", arguments: {} },
    }),
  );

  // A TaggedError without a message is shown as its encoding.
  const reply: unknown = await tool.json();
  expect(reply).toMatchObject({
    result: {
      isError: true,
      content: [{ type: "text", text: '{"_tag":"Refused","reason":"closed"}' }],
    },
  });
  expect(reply).not.toHaveProperty("result.structuredContent");
  expect(OpenApi.fromApi(bound.api).paths["/api/list"]?.post?.responses).toHaveProperty("403");
});

it("checks each namespace only where it is served", () => {
  const Other = ActionGroup.make(
    { name: "other" },
    Action.make("whoAmI", { description: "Collides", success: Schema.String }),
  );

  const again = ActionGroup.make(
    { name: "users" },
    Action.make("other", { description: "", success: Schema.String }),
  );

  const aliased = (group: string, action: string) =>
    ActionGroup.make(
      { name: group },
      Action.make(action, { description: "", success: Schema.String, mcp: { name: "same" } }),
    );

  // Routes are flat; native clients retain group namespaces.
  expect(() => ActionHttp.make({ apiPath: "/api" }, Users, Other)).toThrow(
    "Duplicate action: whoAmI",
  );
  expect(() => ActionHttp.make({ apiPath: "/api" }, Users, again)).toThrow(
    "Duplicate action group: users",
  );

  // MCP aliases are not an HTTP concern, nor are the names of MCP-only actions.
  const one = aliased("one", "first");
  const two = aliased("two", "second");
  expect(() => ActionHttp.make({ apiPath: "/api" }, one, two)).not.toThrow();
  expect(() =>
    ActionHttp.make(
      { apiPath: "/api" },
      Users,
      ActionGroup.make(
        { name: "tools" },
        Action.make("whoAmI", {
          description: "",
          success: Schema.String,
          http: false,
          mcp: { name: "who" },
        }),
      ),
    ),
  ).not.toThrow();

  // A group's name is its identity to this adapter, served or not: otherwise an
  // MCP-only namesake could stand in for the group whose routes are missing.
  expect(() =>
    ActionHttp.make(
      { apiPath: "/api" },
      Users,
      ActionGroup.make(
        { name: "users" },
        Action.make("tool", { description: "", success: Schema.String, http: false }),
      ),
    ),
  ).toThrow("Duplicate action group: users");

  // Tools are the MCP namespace; group and action names are not.
  const mcp = {
    protocols: [McpProtocol.v2026_07_28],
    name: "test",
    version: "0",
    path: "/mcp",
  } as const;

  expect(() =>
    ActionMcp.layer(
      mcp,
      one.implement({ first: () => Effect.succeed("a") }),
      two.implement({ second: () => Effect.succeed("b") }),
    ),
  ).toThrow("Duplicate MCP tool: same");
  expect(() =>
    ActionMcp.layer(
      mcp,
      Users.implement({ whoAmI: () => Effect.succeed("a") }),
      again.implement({ other: () => Effect.succeed("b") }),
    ),
  ).not.toThrow();
});
