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
  Action.make("whoAmI", { description: "Current user", access: "write", success: Schema.String }),
);

const Billing = ActionGroup.make(
  { name: "billing" },
  Action.make("invoice", {
    description: "Invoice total",
    access: "write",
    input: Schema.Struct({ amount: Schema.FiniteFromString }),
    success: Schema.Finite,
  }),
  Action.make("audit", { description: "Audit", access: "write", success: Schema.String }),
);

const UsersApp = Users.implement(
  Effect.map(Tenant, (tenant) => ({ whoAmI: () => Effect.succeed(`ada@${tenant}`) })),
);

const BillingApp = Billing.implement({
  invoice: ({ amount }) => Effect.succeed(amount * 2),
  audit: () => Effect.succeed("clean"),
});

const Http = ActionHttp.make({ apiPath: "/api" }, Users, Billing);

const OpenApiPaths = Schema.Struct({ paths: Schema.Record(Schema.String, Schema.Json) });

const serve = () => {
  const web = HttpRouter.toWebHandler(
    Layer.mergeAll(
      Http.layer([UsersApp]),
      Http.layer([BillingApp]),
      ActionMcp.layerHttp([UsersApp, BillingApp], {
        name: "test",
        version: "0",
        path: "/mcp",
      }),
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
  expect(Object.keys(document.paths)).toEqual([
    "/api/users/whoAmI",
    "/api/billing/invoice",
    "/api/billing/audit",
  ]);
  expect(document.paths["/api/users/whoAmI"]?.post?.operationId).toBe("users.whoAmI");
  expect(document.paths["/api/billing/invoice"]?.post?.tags).toEqual(["billing"]);
});

it("serves the binding's OpenAPI document under its API path or a chosen one", async () => {
  // A route like any other: the middleware provided to its layer covers it.
  const refuseAnonymous = HttpRouter.middleware((httpEffect) =>
    Effect.flatMap(HttpServerRequest.HttpServerRequest, (request) =>
      request.headers.authorization === undefined
        ? Effect.succeed(HttpServerResponse.empty({ status: 401 }))
        : httpEffect,
    ),
  );

  const web = HttpRouter.toWebHandler(
    Layer.mergeAll(
      Http.openApi(),
      Http.openApi("/openapi.json").pipe(Layer.provide(refuseAnonymous.layer)),
    ).pipe(Layer.provide(HttpServer.layerServices)),
    { disableLogger: true },
  );

  onTestFinished(() => web.dispose());

  const served = await web.handler(new Request("http://localhost/api/openapi.json"));
  expect(served.status).toBe(200);
  expect(served.headers.get("content-type")).toContain("application/json");
  expect(await served.json()).toEqual(JSON.parse(JSON.stringify(OpenApi.fromApi(Http.api))));
  expect((await web.handler(new Request("http://localhost/openapi.json"))).status).toBe(401);

  const authorized = await web.handler(
    new Request("http://localhost/openapi.json", { headers: { authorization: "Bearer any" } }),
  );

  expect(
    Object.keys(Schema.decodeUnknownSync(OpenApiPaths)(await authorized.json()).paths),
  ).toEqual(["/api/users/whoAmI", "/api/billing/invoice", "/api/billing/audit"]);
});

it("preserves action APIs composed into a native host API", () => {
  const combined = HttpApi.make("host")
    .addHttpApi(ActionHttp.make({ apiPath: "/public" }, Users).api)
    .addHttpApi(ActionHttp.make({ apiPath: "/admin" }, Billing).api);

  expect(Object.keys(OpenApi.fromApi(combined).paths)).toEqual([
    "/public/users/whoAmI",
    "/admin/billing/invoice",
    "/admin/billing/audit",
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

const Alpha = Action.make("alpha", {
  description: "Alpha",
  access: "write",
  success: Schema.String,
});

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
    Action.make("beta", { description: "Beta", access: "write", success: Schema.String }),
  );

  const bound = ActionHttp.make({ apiPath: "/api" }, A, B);

  const handler = handlerOf(
    Layer.mergeAll(
      bound.layer([A.implement({ alpha: () => Effect.succeed("right") })]),
      // The constraint on handler records admits extra keys.
      bound.layer([
        B.implement({
          beta: () => Effect.succeed("beta"),
          alpha: () => Effect.succeed("wrong group"),
        }),
      ]),
    ),
  );

  expect(await (await handler(post("/api/a/alpha"))).json()).toBe("right");
});

it("namespaces equal HTTP action names by group", async () => {
  const left = ActionGroup.make(
    { name: "left" },
    Action.make("echo", { description: "Left", access: "write", success: Schema.String }),
  );

  const right = ActionGroup.make(
    { name: "right" },
    Action.make("echo", { description: "Right", access: "write", success: Schema.String }),
  );

  const http = ActionHttp.make({ apiPath: "/api" }, left, right);

  const handler = handlerOf(
    http.layer([
      left.implement({ echo: () => Effect.succeed("left") }),
      right.implement({ echo: () => Effect.succeed("right") }),
    ]),
  );

  expect(await (await handler(post("/api/left/echo"))).json()).toBe("left");
  expect(await (await handler(post("/api/right/echo"))).json()).toBe("right");
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
  expect(() => bound.layer([lookAlike])).toThrow(
    'Implementation of group "a" is not served by this adapter',
  );
  // @ts-expect-error The group is part of an implementation's type, so this does not compile either.
  expect(() => bound.layer([other])).toThrow(
    'Implementation of group "other" is not served by this adapter',
  );
});

it("acquires only the implementations MCP serves", async () => {
  const built: Array<string> = [];

  const record = <H>(name: string, handlers: H) =>
    Effect.sync(() => {
      built.push(name);

      return handlers;
    });

  const Tools = ActionGroup.make(
    { name: "tools" },
    Action.make("tool", { description: "Tool", access: "write", success: Schema.String }),
  );

  const Hidden = ActionGroup.make(
    { name: "hidden" },
    Action.make("route", {
      description: "Route",
      access: "write",
      success: Schema.String,
      mcp: false,
    }),
  );

  const web = HttpRouter.toWebHandler(
    ActionMcp.layerHttp(
      [
        Tools.implement(record("tools", { tool: () => Effect.succeed("tool") })),
        Hidden.implement(record("hidden", { route: () => Effect.succeed("route") })),
      ],
      { name: "test", version: "0", path: "/mcp" },
    ).pipe(Layer.provide(HttpServer.layerServices)),
    { disableLogger: true },
  );

  onTestFinished(() => web.dispose());
  await web.handler(mcpRequest({ url: "http://localhost/mcp", method: "tools/list" }));
  expect(built).toEqual(["tools"]);
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
  const users = Http.layer([UsersApp]).pipe(tenant);
  const billing = Http.layer([BillingApp]);

  // The document is an ordinary route over the native API, so it takes middleware like any other.
  const document = HttpRouter.add(
    "GET",
    "/openapi.json",
    HttpServerResponse.jsonUnsafe(OpenApi.fromApi(Http.api)),
  );

  const statuses = async (handler: (request: Request) => Promise<Response>) => [
    (await handler(new Request("http://localhost/openapi.json"))).status,
    (await handler(post("/api/users/whoAmI"))).status,
    (await handler(post("/api/billing/invoice"))).status,
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
    Action.make("find", {
      description: "Find",
      access: "write",
      success: Schema.String,
      errors: [Missing],
    }),
    Action.make("list", { description: "List", access: "write", success: Schema.String }),
  );

  expect(Guarded.actions.map((action) => action.errors)).toEqual([[Missing, Refused], [Refused]]);

  const app = Guarded.implement({
    find: () => Effect.fail(new Missing()),
    list: () => Effect.fail(new Refused({ reason: "closed" })),
  });

  const bound = ActionHttp.make({ apiPath: "/api" }, Guarded);

  const handler = handlerOf(
    Layer.mergeAll(
      bound.layer([app]),
      ActionMcp.layerHttp([app], {
        name: "test",
        version: "0",
        path: "/mcp",
      }),
    ),
  );

  expect((await handler(post("/api/guarded/find"))).status).toBe(404);
  const refused = await handler(post("/api/guarded/list"));
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
  expect(OpenApi.fromApi(bound.api).paths["/api/guarded/list"]?.post?.responses).toHaveProperty(
    "403",
  );
});

it("checks each namespace only where it is served", () => {
  const Other = ActionGroup.make(
    { name: "other" },
    Action.make("whoAmI", { description: "Collides", access: "write", success: Schema.String }),
  );

  const again = ActionGroup.make(
    { name: "users" },
    Action.make("other", { description: "", access: "write", success: Schema.String }),
  );

  const aliased = (group: string, action: string) =>
    ActionGroup.make(
      { name: group },
      Action.make(action, {
        description: "",
        access: "write",
        success: Schema.String,
        mcp: { name: "same" },
      }),
    );

  // Group namespaces make same action names unambiguous.
  expect(() => ActionHttp.make({ apiPath: "/api" }, Users, Other)).not.toThrow();
  expect(() => ActionHttp.make({ apiPath: "/api" }, Users, again)).toThrow(
    "Duplicate action group: users",
  );

  // MCP aliases are not an HTTP concern.
  const one = aliased("one", "first");
  const two = aliased("two", "second");
  expect(() => ActionHttp.make({ apiPath: "/api" }, one, two)).not.toThrow();

  // Tools are the MCP namespace; group and action names are not.
  const mcp = {
    name: "test",
    version: "0",
    path: "/mcp",
  } as const;

  expect(() =>
    ActionMcp.layerHttp(
      [
        one.implement({ first: () => Effect.succeed("a") }),
        two.implement({ second: () => Effect.succeed("b") }),
      ],
      mcp,
    ),
  ).toThrow("Duplicate MCP tool: same");
  expect(() =>
    ActionMcp.layerHttp(
      [
        Users.implement({ whoAmI: () => Effect.succeed("a") }),
        again.implement({ other: () => Effect.succeed("b") }),
      ],
      mcp,
    ),
  ).not.toThrow();
});

it("projects every group's contracts into one map keyed by group and action", () => {
  const contracts = ActionGroup.contracts(Users, Billing);

  expect(Object.keys(contracts)).toEqual(["users.whoAmI", "billing.invoice", "billing.audit"]);

  // Each entry keeps its own contract, so a caller reads the exact action.
  const audit: "audit" = contracts["billing.audit"].name;
  const access: "write" = contracts["users.whoAmI"].access;

  expect([audit, access]).toEqual(["audit", "write"]);
  expect(contracts["billing.invoice"]).toBe(Billing.actions[0]);

  // @ts-expect-error The key set is derived from the groups, so a typo cannot compile.
  void contracts["users.missing"];

  expect(() => ActionGroup.contracts(Users, Users)).toThrow("Duplicate contract group: users");
});
