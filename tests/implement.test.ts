import { describe, expect, it, onTestFinished } from "vite-plus/test";
import { Context, Effect, Layer, Schema, Stdio, Stream } from "effect";
import {
  HttpRouter,
  HttpServer,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/unstable/http";
import { HttpApi, OpenApi } from "effect/unstable/httpapi";
import * as Action from "../src/Action.js";
import * as ActionHttp from "../src/ActionHttp.js";
import * as ActionMcp from "../src/ActionMcp.js";
import * as ActionToolkit from "../src/ActionToolkit.js";
import { httpClient, mcpCall, mcpRequest } from "../src/Testing.js";
import { post } from "./requests.js";

class Tenant extends Context.Service<Tenant, string>()("implement-test/Tenant") {}

const WhoAmI = Action.make("whoAmI", {
  description: "Current user",
  access: "write",
  success: Schema.String,
});

const Invoice = Action.make("invoice", {
  description: "Invoice total",
  access: "write",
  input: { amount: Schema.FiniteFromString },
  success: Schema.Finite,
});

const Audit = Action.make("audit", {
  description: "Audit",
  access: "write",
  success: Schema.String,
});

const whoAmI = Action.implement(
  WhoAmI,
  Effect.map(Tenant, (tenant) => () => Effect.succeed(`ada@${tenant}`)),
);

const billing = Action.implement([Invoice, Audit], {
  invoice: ({ amount }) => Effect.succeed(amount * 2),
  audit: () => Effect.succeed("clean"),
});

const Http = ActionHttp.make([WhoAmI, Invoice, Audit]);

const OpenApiPaths = Schema.Struct({ paths: Schema.Record(Schema.String, Schema.Json) });

type Routes<E> = Layer.Layer<
  never,
  E,
  HttpRouter.HttpRouter | Layer.Success<typeof HttpServer.layerServices>
>;

const handlerOf = <E>(routes: Routes<E>) => {
  const web = HttpRouter.toWebHandler(routes.pipe(Layer.provide(HttpServer.layerServices)), {
    disableLogger: true,
  });

  onTestFinished(() => web.dispose());

  return web.handler;
};

const serve = () =>
  handlerOf(
    Layer.mergeAll(
      Http.layer(whoAmI),
      Http.layer(billing),
      ActionMcp.layerHttp([...whoAmI, ...billing], { name: "test", version: "0" }),
    ).pipe(Layer.provide(Layer.succeed(Tenant, "acme"))),
  );

describe("implement", () => {
  const Hello = Action.make("hello", {
    description: "Greets",
    access: "write",
    input: { name: Schema.String },
    success: Schema.String,
  });

  const Bye = Action.make("bye", { description: "Parts", access: "write", success: Schema.String });

  it.each([
    {
      form: "one action, a handler",
      make: () => Action.implement(Hello, ({ name }) => Effect.succeed(`hi ${name}`)),
      hello: "hi Ada",
      bye: undefined,
    },
    {
      form: "one action, a builder",
      make: () =>
        Action.implement(
          Hello,
          Effect.map(
            Tenant,
            (tenant) =>
              ({ name }) =>
                Effect.succeed(`hi ${name}@${tenant}`),
          ),
        ),
      hello: "hi Ada@acme",
      bye: undefined,
    },
    {
      form: "several actions, a record",
      make: () =>
        Action.implement([Hello, Bye], {
          hello: ({ name }) => Effect.succeed(`hi ${name}`),
          bye: () => Effect.succeed("bye"),
        }),
      hello: "hi Ada",
      bye: "bye",
    },
    {
      form: "several actions, a builder",
      make: () =>
        Action.implement(
          [Hello, Bye],
          Effect.gen(function* () {
            const tenant = yield* Tenant;

            return {
              hello: ({ name }) => Effect.succeed(`hi ${name}@${tenant}`),
              bye: () => Effect.succeed(`bye@${tenant}`),
            };
          }),
        ),
      hello: "hi Ada@acme",
      bye: "bye@acme",
    },
  ])("binds $form", async ({ make, hello, bye }) => {
    const apps = make();

    const handler = handlerOf(
      ActionHttp.make(apps.map((app) => app.action))
        .layer(apps)
        .pipe(Layer.provide(Layer.succeed(Tenant, "acme"))),
    );

    expect(await (await handler(post("/api/hello", { name: "Ada" }))).json()).toBe(hello);

    if (bye !== undefined) expect(await (await handler(post("/api/bye"))).json()).toBe(bye);
  });

  it("returns one implementation per action, each bound to its contract", () => {
    const apps = Action.implement([Hello, Bye], {
      hello: () => Effect.succeed("hi"),
      bye: () => Effect.succeed("bye"),
    });

    expect(apps.map((app) => app.action)).toEqual([Hello, Bye]);
    expect(Action.implement(Hello, () => Effect.succeed("hi")).map((app) => app.action)).toEqual([
      Hello,
    ]);
  });

  it("refuses duplicate actions at implement", () => {
    expect(() => Action.implement([Hello, Hello], { hello: () => Effect.succeed("hi") })).toThrow(
      "Duplicate action: hello",
    );
  });

  // The types require a function for every action; plain JavaScript, a cast or a record
  // changed after it was typed can still bind something else. Nothing is checked until
  // an adapter builds, and then the build dies.
  const record = () => ({ hello: () => Effect.succeed("hi"), bye: () => Effect.succeed("bye") });

  const pair = (change: (handlers: ReturnType<typeof record>) => boolean) => {
    const handlers = record();
    change(handlers);

    return handlers;
  };

  // `hello` is an own property; `bye` is inherited from the prototype.
  class Inherited {
    readonly hello = () => Effect.succeed("hi");

    bye() {
      return Effect.succeed("bye");
    }
  }

  it.each([
    {
      handlers: "a record missing a key",
      make: () =>
        Action.implement(
          [Hello, Bye],
          pair((h) => Reflect.deleteProperty(h, "bye")),
        ),
    },
    {
      handlers: "a record with an undefined value",
      make: () =>
        Action.implement(
          [Hello, Bye],
          pair((h) => Reflect.set(h, "bye", undefined)),
        ),
    },
    {
      handlers: "a record with a non-function value",
      make: () =>
        Action.implement(
          [Hello, Bye],
          pair((h) => Reflect.set(h, "bye", "bye")),
        ),
    },
    {
      handlers: "a record with an inherited method",
      make: () => Action.implement([Hello, Bye], new Inherited()),
    },
    {
      handlers: "a builder's record missing a key",
      make: () =>
        Action.implement(
          [Hello, Bye],
          Effect.sync(() => pair((h) => Reflect.deleteProperty(h, "bye"))),
        ),
    },
  ])("dies at layer build, not at implement or a request, for $handlers", async ({ make }) => {
    const apps = make();
    const handler = handlerOf(ActionHttp.make([Hello, Bye]).layer(apps));

    // Even the action that has a handler is never served by an incomplete record.
    await expect(handler(post("/api/hello", { name: "Ada" }))).rejects.toThrow(
      "Missing handler: bye",
    );
  });

  it("dies at layer build for a record key that names no action", async () => {
    const plain = Action.implement([Hello], {
      hello: () => Effect.succeed("hi"),
      // @ts-expect-error A record names only its actions.
      stale: () => Effect.succeed("stale"),
    });

    const built = Action.implement(
      [Hello],
      // @ts-expect-error A builder's record names only its actions.
      Effect.succeed({ hello: () => Effect.succeed("hi"), stale: () => Effect.succeed("stale") }),
    );

    for (const apps of [plain, built]) {
      const toolkit = ActionToolkit.make(apps);

      await expect(Effect.runPromise(Effect.scoped(Layer.build(toolkit.layer)))).rejects.toThrow(
        "Unknown handlers: stale",
      );
    }
  });
});

describe("builder acquisition", () => {
  const One = Action.make("one", { description: "One", access: "write", success: Schema.Number });
  const Two = Action.make("two", { description: "Two", access: "write", success: Schema.Number });

  const Hidden = Action.make("hidden", {
    description: "Hidden",
    access: "write",
    success: Schema.String,
    mcp: false,
  });

  const Shown = Action.make("shown", {
    description: "Shown",
    access: "write",
    success: Schema.String,
  });

  const Unlisted = Action.make("unlisted", {
    description: "Unlisted",
    access: "write",
    success: Schema.String,
    mcp: false,
  });

  // Three builders: two tools, one hidden action, and a tool with a hidden sibling.
  const fixture = () => {
    const built: Array<string> = [];

    const builder = <H>(name: string, handlers: H) =>
      Effect.sync(() => {
        built.push(name);

        return handlers;
      });

    const [one, two] = Action.implement(
      [One, Two],
      builder("pair", { one: () => Effect.succeed(1), two: () => Effect.succeed(2) }),
    );

    const [hidden] = Action.implement(
      Hidden,
      builder("hidden", () => Effect.succeed("hidden")),
    );

    const [shown, unlisted] = Action.implement(
      [Shown, Unlisted],
      builder("mixed", {
        shown: () => Effect.succeed("shown"),
        unlisted: () => Effect.succeed(""),
      }),
    );

    if (
      one === undefined ||
      two === undefined ||
      hidden === undefined ||
      shown === undefined ||
      unlisted === undefined
    ) {
      throw new Error("Missing implementations");
    }

    // Implementations of one builder, listed apart and out of order.
    return { built, apps: [unlisted, two, hidden, shown, one] as const };
  };

  type Apps = ReturnType<typeof fixture>["apps"];

  it.each([
    {
      adapter: "Http.layer",
      // HTTP serves every action it receives, hidden from MCP or not.
      built: ["hidden", "mixed", "pair"],
      build: async (apps: Apps) => {
        const handler = handlerOf(ActionHttp.make(apps.map((app) => app.action)).layer(apps));
        expect(await (await handler(post("/api/one"))).json()).toBe(1);
      },
    },
    {
      adapter: "ActionMcp.layerHttp",
      built: ["mixed", "pair"],
      build: async (apps: Apps) => {
        const handler = handlerOf(ActionMcp.layerHttp(apps, { name: "test", version: "0" }));
        expect(await mcpCall(handler, { url: "http://localhost/mcp", name: "one" })).toEqual({
          isError: false,
          value: 1,
        });
      },
    },
    {
      adapter: "ActionMcp.layerStdio",
      built: ["mixed", "pair"],
      build: (apps: Apps) =>
        Effect.runPromise(
          Effect.scoped(
            Layer.build(
              ActionMcp.layerStdio(apps, { name: "test", version: "0" }).pipe(
                Layer.provide(Stdio.layerTest({})),
              ),
            ),
          ),
        ),
    },
    {
      adapter: "ActionToolkit",
      built: ["mixed", "pair"],
      build: (apps: Apps) =>
        Effect.runPromise(Effect.scoped(Layer.build(ActionToolkit.make(apps).layer))),
    },
  ])(
    "$adapter runs each builder once, and only if it serves one of its actions",
    async ({ build, built: expected }) => {
      const { built, apps } = fixture();

      await build(apps);

      expect(built.sort()).toEqual(expected);
    },
  );

  it("runs a builder once per layer that serves any of its actions", async () => {
    const { built, apps } = fixture();
    const [, two, , , one] = apps;
    const binding = ActionHttp.make([One, Two]);

    const handler = handlerOf(
      Layer.mergeAll(
        binding.layer([one]),
        binding.layer([two]),
        ActionMcp.layerHttp([one, two], { name: "test", version: "0" }),
      ),
    );

    expect(await (await handler(post("/api/two"))).json()).toBe(2);
    expect(built).toEqual(["pair", "pair", "pair"]);
  });
});

describe("HTTP bindings", () => {
  it("serves a list at the top level of its client and document", async () => {
    const handler = serve();

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const client = yield* httpClient(Http, handler);

        return [yield* client.whoAmI(), yield* client.invoice({ amount: 21 })];
      }),
    );

    expect(result).toEqual(["ada@acme", 42]);

    const document = OpenApi.fromApi(Http.api);
    expect(Object.keys(document.paths)).toEqual(["/api/whoAmI", "/api/invoice", "/api/audit"]);
    expect(document.paths["/api/whoAmI"]?.post?.operationId).toBe("whoAmI");
  });

  it.each([
    { prefix: undefined, route: "/api/whoAmI", document: "/api/openapi.json" },
    { prefix: "/", route: "/whoAmI", document: "/openapi.json" },
    { prefix: "/v1/", route: "/v1/whoAmI", document: "/v1/openapi.json" },
    { prefix: "/v1/internal", route: "/v1/internal/whoAmI", document: "/v1/internal/openapi.json" },
  ] as const)("mounts routes and the document under prefix $prefix", async (mount) => {
    const binding = ActionHttp.make(
      [WhoAmI],
      mount.prefix === undefined ? {} : { prefix: mount.prefix },
    );

    const handler = handlerOf(
      Layer.mergeAll(binding.layer(whoAmI), binding.openApi()).pipe(
        Layer.provide(Layer.succeed(Tenant, "acme")),
      ),
    );

    expect(await (await handler(post(mount.route))).json()).toBe("ada@acme");

    const document = await handler(new Request(`http://localhost${mount.document}`));
    expect(document.status).toBe(200);
    expect(
      Object.keys(Schema.decodeUnknownSync(OpenApiPaths)(await document.json()).paths),
    ).toEqual([mount.route]);
  });

  it("serves the binding's OpenAPI document under its prefix or a chosen path", async () => {
    // A route like any other: the middleware provided to its layer covers it.
    const refuseAnonymous = HttpRouter.middleware((httpEffect) =>
      Effect.flatMap(HttpServerRequest.HttpServerRequest, (request) =>
        request.headers.authorization === undefined
          ? Effect.succeed(HttpServerResponse.empty({ status: 401 }))
          : httpEffect,
      ),
    );

    const handler = handlerOf(
      Layer.mergeAll(
        Http.openApi(),
        Http.openApi("/openapi.json").pipe(Layer.provide(refuseAnonymous.layer)),
      ),
    );

    const served = await handler(new Request("http://localhost/api/openapi.json"));
    expect(served.status).toBe(200);
    expect(served.headers.get("content-type")).toContain("application/json");
    expect(await served.json()).toEqual(JSON.parse(JSON.stringify(OpenApi.fromApi(Http.api))));
    expect((await handler(new Request("http://localhost/openapi.json"))).status).toBe(401);

    const authorized = await handler(
      new Request("http://localhost/openapi.json", { headers: { authorization: "Bearer any" } }),
    );

    expect(
      Object.keys(Schema.decodeUnknownSync(OpenApiPaths)(await authorized.json()).paths),
    ).toEqual(["/api/whoAmI", "/api/invoice", "/api/audit"]);
  });

  it("preserves action APIs composed into a native host API", () => {
    const combined = HttpApi.make("host")
      .addHttpApi(ActionHttp.make([WhoAmI], { prefix: "/public" }).api)
      .addHttpApi(ActionHttp.make([Invoice, Audit], { prefix: "/admin" }).api);

    expect(Object.keys(OpenApi.fromApi(combined).paths)).toEqual([
      "/public/whoAmI",
      "/admin/invoice",
      "/admin/audit",
    ]);
  });

  const Alpha = Action.make("alpha", {
    description: "Alpha",
    access: "write",
    success: Schema.String,
  });

  const Beta = Action.make("beta", {
    description: "Beta",
    access: "write",
    success: Schema.String,
  });

  it("mounts only implementations of the actions it was made with, each once", () => {
    const bound = ActionHttp.make([Alpha]);

    const LookAlike = Action.make("alpha", {
      description: "Alpha",
      access: "write",
      success: Schema.String,
    });

    const alpha = Action.implement(Alpha, () => Effect.succeed("x"));

    // Pairing is by identity: the same name and schemas do not make it this action.
    expect(() => bound.layer(Action.implement(LookAlike, () => Effect.succeed("x")))).toThrow(
      'Action "alpha" is not in this HTTP binding',
    );
    expect(() =>
      // @ts-expect-error An action outside the binding is part of the implementation's type.
      bound.layer(Action.implement(Beta, () => Effect.succeed("x"))),
    ).toThrow('Action "beta" is not in this HTTP binding');
    expect(() => bound.layer([...alpha, ...alpha])).toThrow("Duplicate served action: alpha");
    expect(() =>
      bound.layer([...alpha, ...Action.implement(Alpha, () => Effect.succeed("y"))]),
    ).toThrow("Duplicate served action: alpha");
  });

  it("serves one binding's actions through several layers; an unserved action has no route", async () => {
    const bound = ActionHttp.make([Alpha, Beta, Audit]);

    const handler = handlerOf(
      Layer.mergeAll(
        bound.layer(Action.implement(Alpha, () => Effect.succeed("alpha"))),
        bound.layer(Action.implement(Beta, () => Effect.succeed("beta"))),
      ),
    );

    expect(await (await handler(post("/api/alpha"))).json()).toBe("alpha");
    expect(await (await handler(post("/api/beta"))).json()).toBe("beta");
    expect((await handler(post("/api/audit"))).status).toBe(404);
    // The document still describes the whole binding.
    expect(Object.keys(OpenApi.fromApi(bound.api).paths)).toEqual([
      "/api/alpha",
      "/api/beta",
      "/api/audit",
    ]);
  });

  it("scopes router middleware to the layer it is provided to", async () => {
    // Replaces the response of every route it covers.
    const blocked = HttpRouter.middleware((route) =>
      Effect.as(route, HttpServerResponse.text("blocked", { status: 403 })),
    ).layer;

    const users = Http.layer(whoAmI).pipe(Layer.provide(Layer.succeed(Tenant, "acme")));
    const invoices = Http.layer(billing);
    const document = Http.openApi();

    const statuses = async (handler: (request: Request) => Promise<Response>) => [
      (await handler(new Request("http://localhost/api/openapi.json"))).status,
      (await handler(post("/api/whoAmI"))).status,
      (await handler(post("/api/invoice", { amount: "2" }))).status,
    ];

    // Each layer registers its own routes, so a guard covers exactly what it is provided to.
    expect(
      await statuses(
        handlerOf(Layer.mergeAll(document.pipe(Layer.provide(blocked)), users, invoices)),
      ),
    ).toEqual([403, 200, 200]);
    expect(
      await statuses(
        handlerOf(Layer.mergeAll(document, users.pipe(Layer.provide(blocked)), invoices)),
      ),
    ).toEqual([200, 403, 200]);
    expect(
      await statuses(
        handlerOf(Layer.mergeAll(document, users, invoices).pipe(Layer.provide(blocked))),
      ),
    ).toEqual([403, 403, 403]);
  });

  it("declares a shared error array on every action that spreads it, on both transports", async () => {
    class Refused extends Schema.TaggedError<Refused>()(
      "Refused",
      { reason: Schema.String },
      { httpApiStatus: 403 },
    ) {}

    class Missing extends Schema.TaggedError<Missing>()("Missing", {}, { httpApiStatus: 404 }) {}

    const shared = [Refused] as const;

    const Find = Action.make("find", {
      description: "Find",
      access: "write",
      success: Schema.String,
      errors: [Missing, ...shared],
    });

    const List = Action.make("list", {
      description: "List",
      access: "write",
      success: Schema.String,
      errors: [...shared],
    });

    const apps = Action.implement([Find, List], {
      find: () => Effect.fail(new Missing()),
      list: () => Effect.fail(new Refused({ reason: "closed" })),
    });

    const bound = ActionHttp.make([Find, List]);

    const handler = handlerOf(
      Layer.mergeAll(bound.layer(apps), ActionMcp.layerHttp(apps, { name: "test", version: "0" })),
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
});

describe("MCP registration", () => {
  it("serves several implementations as the tools of one endpoint", async () => {
    const handler = serve();

    const response = await handler(
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

    expect(await mcpCall(handler, { url: "http://localhost/mcp", name: "whoAmI" })).toEqual({
      isError: false,
      value: "ada@acme",
    });
  });

  it("checks tool names where tools are served, and nowhere else", () => {
    const aliased = (name: string) =>
      Action.make(name, {
        description: "",
        access: "write",
        success: Schema.String,
        mcp: { name: "same" },
      });

    const First = aliased("first");
    const Second = aliased("second");

    // MCP aliases are not an HTTP concern.
    expect(() => ActionHttp.make([First, Second])).not.toThrow();

    // Tool names are checked by each tool surface; action names are not tool names.
    const apps = [
      ...Action.implement(First, () => Effect.succeed("a")),
      ...Action.implement(Second, () => Effect.succeed("b")),
    ];

    const options = { name: "test", version: "0" };
    expect(() => ActionMcp.layerHttp(apps, options)).toThrow("Duplicate MCP tool: same");
    expect(() => ActionMcp.layerStdio(apps, options)).toThrow("Duplicate MCP tool: same");
    expect(() => ActionToolkit.make(apps)).toThrow("Duplicate MCP tool: same");

    const Other = Action.make("other", {
      description: "",
      access: "write",
      success: Schema.String,
    });

    expect(() =>
      ActionMcp.layerHttp(
        [...whoAmI, ...Action.implement(Other, () => Effect.succeed("b"))],
        options,
      ),
    ).not.toThrow();
  });

  it("returns a tool's success through the native Toolkit from a shared builder", async () => {
    const shared = Action.implement(
      [Invoice, Audit],
      Effect.map(Tenant, (tenant) => ({
        invoice: ({ amount }: { readonly amount: number }) => Effect.succeed(amount * 2),
        audit: () => Effect.succeed(`clean@${tenant}`),
      })),
    );

    const toolkit = ActionToolkit.make(shared);

    const results = await Effect.runPromise(
      Effect.gen(function* () {
        const tools = yield* toolkit.toolkit;
        const invoice = yield* Stream.runCollect(yield* tools.handle("invoice", { amount: "5" }));
        const audit = yield* Stream.runCollect(yield* tools.handle("audit", {}));

        return [...invoice, ...audit].map((result) => result.result);
      }).pipe(Effect.provide(toolkit.layer.pipe(Layer.provide(Layer.succeed(Tenant, "acme"))))),
    );

    expect(results).toEqual([10, "clean@acme"]);
  });
});
