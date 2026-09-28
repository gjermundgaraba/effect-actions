import { describe, expect, it } from "vite-plus/test";
import { Context, Effect, Exit, Layer, Result, Schema, Stdio, Stream } from "effect";
import { HttpRouter, HttpServer, HttpServerResponse } from "effect/http";
import { HttpApi, OpenApi } from "effect/http-api";
import * as Action from "../src/Action.js";
import * as ActionHttp from "../src/ActionHttp.js";
import * as ActionMcp from "../src/ActionMcp.js";
import * as ActionToolkit from "../src/ActionToolkit.js";
import * as Testing from "../src/Testing.js";
import { against, httpClient, serve as serveRoutes } from "./serve.js";
import { mcpRequest, post, rawToolCall } from "./requests.js";

/** The defect building `layer` dies with; `undefined` when it builds or fails. */
const defectOf = async <A, E>(layer: Layer.Layer<A, E>) =>
  Result.getOrUndefined(
    Exit.findDefect(await Effect.runPromiseExit(Effect.scoped(Layer.build(layer)))),
  );

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

type Routes<E> = Layer.Layer<
  never,
  E,
  HttpRouter.HttpRouter | Layer.Success<typeof HttpServer.layerServices>
>;

const handlerOf = <E>(routes: Routes<E>) => serveRoutes(routes).handler;

const serve = () =>
  handlerOf(
    Layer.mergeAll(
      ActionHttp.layer(Http, whoAmI),
      ActionHttp.layer(Http, billing),
      ActionMcp.layerHttp([whoAmI, billing], { name: "test", version: "0" }),
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
    const app = make();

    const handler = handlerOf(
      ActionHttp.layer(ActionHttp.make(app.actions), app).pipe(
        Layer.provide(Layer.succeed(Tenant, "acme")),
      ),
    );

    expect(await (await handler(post("/api/hello", { name: "Ada" }))).json()).toBe(hello);

    if (bye !== undefined) expect(await (await handler(post("/api/bye"))).json()).toBe(bye);
  });

  it("returns one implementation of every action it binds", () => {
    const app = Action.implement([Hello, Bye], {
      hello: () => Effect.succeed("hi"),
      bye: () => Effect.succeed("bye"),
    });

    expect(app.actions).toEqual([Hello, Bye]);
    expect(Action.implement(Hello, () => Effect.succeed("hi")).actions).toEqual([Hello]);
  });

  it("refuses duplicate actions at implement", () => {
    expect(() => Action.implement([Hello, Hello], { hello: () => Effect.succeed("hi") })).toThrow(
      "Duplicate action: hello",
    );
  });

  // The types require a function for every action; plain JavaScript, a cast or a record
  // changed after it was typed can still bind something else. A plain record is checked
  // at implement; a builder's record when its layer builds, which then dies.
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
  ])("throws at implement for $handlers", ({ make }) => {
    expect(make).toThrow("Missing handlers: bye");
  });

  it("dies at layer build, not at a request, for a builder's record missing a key", async () => {
    const app = Action.implement(
      [Hello, Bye],
      Effect.sync(() => pair((h) => Reflect.deleteProperty(h, "bye"))),
    );

    const handler = handlerOf(ActionHttp.layer(ActionHttp.make([Hello, Bye]), app));

    // Even the action that has a handler is never served by an incomplete record.
    await expect(handler(post("/api/hello", { name: "Ada" }))).rejects.toThrow(
      "Missing handlers: bye",
    );
    expect(await defectOf(ActionToolkit.make(app).layer)).toMatchObject({
      message: "Missing handlers: bye",
    });
  });

  it("refuses a record key that names no action: a plain one at implement", async () => {
    expect(() =>
      Action.implement([Hello], {
        hello: () => Effect.succeed("hi"),
        // @ts-expect-error A record names only its actions.
        stale: () => Effect.succeed("stale"),
      }),
    ).toThrow("Unknown handlers: stale");

    const built = Action.implement(
      [Hello],
      // @ts-expect-error A builder's record names only its actions.
      Effect.succeed({ hello: () => Effect.succeed("hi"), stale: () => Effect.succeed("stale") }),
    );

    expect(await defectOf(ActionToolkit.make(built).layer)).toMatchObject({
      message: "Unknown handlers: stale",
    });
  });
});

describe("builder acquisition", () => {
  const One = Action.make("one", { description: "One", access: "write", success: Schema.Number });
  const Two = Action.make("two", { description: "Two", access: "write", success: Schema.Number });

  const Solo = Action.make("solo", {
    description: "Solo",
    access: "write",
    success: Schema.String,
  });

  // Two builders, each recording its runs.
  const fixture = () => {
    const built: Array<string> = [];

    const builder = <H>(name: string, handlers: H) =>
      Effect.sync(() => {
        built.push(name);

        return handlers;
      });

    const pair = Action.implement(
      [One, Two],
      builder("pair", { one: () => Effect.succeed(1), two: () => Effect.succeed(2) }),
    );

    const solo = Action.implement(
      Solo,
      builder("solo", () => Effect.succeed("solo")),
    );

    return { built, pair, solo };
  };

  type Fixture = ReturnType<typeof fixture>;

  it.each([
    {
      adapter: "ActionHttp.layer",
      build: async ({ pair, solo }: Fixture) => {
        const handler = handlerOf(
          ActionHttp.layer(ActionHttp.make([One, Two, Solo]), [solo, pair]),
        );

        expect(await (await handler(post("/api/one"))).json()).toBe(1);
      },
    },
    {
      adapter: "ActionMcp.layerHttp",
      build: async ({ pair, solo }: Fixture) => {
        const handler = handlerOf(
          ActionMcp.layerHttp([solo, pair], { name: "test", version: "0" }),
        );

        expect(
          await against(
            handler,
            Effect.flatMap(Testing.mcpClient([One]), (mcp) => mcp.one()),
          ),
        ).toBe(1);
      },
    },
    {
      adapter: "ActionMcp.runStdio",
      // A test host with nothing on stdin closes at once, so the server ends.
      build: ({ pair, solo }: Fixture) =>
        Effect.runPromise(
          ActionMcp.runStdio([solo, pair], { name: "test", version: "0" }).pipe(
            Effect.provide(Stdio.layerTest({})),
          ),
        ),
    },
    {
      adapter: "ActionToolkit",
      build: ({ pair, solo }: Fixture) =>
        Effect.runPromise(Effect.scoped(Layer.build(ActionToolkit.make([solo, pair]).layer))),
    },
  ])("$adapter runs the builder of each implementation it serves once", async ({ build }) => {
    const fixed = fixture();

    await build(fixed);

    expect(fixed.built.sort()).toEqual(["pair", "solo"]);
  });

  it("runs a builder again for a host built separately", async () => {
    const { built, pair } = fixture();
    const toolkit = ActionToolkit.make(pair);

    await Effect.runPromise(Effect.scoped(Layer.build(toolkit.layer)));
    await Effect.runPromise(Effect.scoped(Layer.build(toolkit.layer)));

    expect(built).toEqual(["pair", "pair"]);
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
    { prefix: undefined, route: "/api/whoAmI" },
    { prefix: "/", route: "/whoAmI" },
    { prefix: "/v1/", route: "/v1/whoAmI" },
    { prefix: "/v1/internal", route: "/v1/internal/whoAmI" },
  ] as const)("mounts routes and the document under prefix $prefix", async (mount) => {
    const binding = ActionHttp.make(
      [WhoAmI],
      mount.prefix === undefined ? {} : { prefix: mount.prefix },
    );

    const handler = handlerOf(
      ActionHttp.layer(binding, whoAmI).pipe(Layer.provide(Layer.succeed(Tenant, "acme"))),
    );

    expect(await (await handler(post(mount.route))).json()).toBe("ada@acme");
    expect(Object.keys(OpenApi.fromApi(binding.api).paths)).toEqual([mount.route]);
  });

  it.each([
    ["/api", "/api/whoAmI", "api"],
    ["/v2/api", "/v2/api/whoAmI", "v2/api"],
    ["/", "/whoAmI", "/"],
  ] as const)("tags the group under prefix %s with its mount path", (prefix, route, tag) => {
    const document = OpenApi.fromApi(ActionHttp.make([WhoAmI, Invoice, Audit], { prefix }).api);

    expect(document.tags.map(({ name }) => name)).toEqual([tag]);
    expect(document.paths[route]?.post?.tags).toEqual([tag]);
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

    // The root's group is not the `/actions` binding's, although both would read `actions`.
    const rooted = HttpApi.make("host")
      .addHttpApi(ActionHttp.make([WhoAmI], { prefix: "/" }).api)
      .addHttpApi(ActionHttp.make([Invoice], { prefix: "/actions" }).api);

    expect(Object.keys(OpenApi.fromApi(rooted).paths)).toEqual(["/whoAmI", "/actions/invoice"]);
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
    expect(() =>
      ActionHttp.layer(
        bound,
        Action.implement(LookAlike, () => Effect.succeed("x")),
      ),
    ).toThrow('Action "alpha" is not in this HTTP binding');
    expect(() =>
      ActionHttp.layer(
        bound,
        // @ts-expect-error An action outside the binding is part of the implementation's type.
        Action.implement(Beta, () => Effect.succeed("x")),
      ),
    ).toThrow('Action "beta" is not in this HTTP binding');
    expect(() => ActionHttp.layer(bound, [alpha, alpha])).toThrow("Duplicate served action: alpha");
    expect(() =>
      ActionHttp.layer(bound, [alpha, Action.implement(Alpha, () => Effect.succeed("y"))]),
    ).toThrow("Duplicate served action: alpha");
  });

  it("serves one binding's actions through several layers; an unserved action has no route", async () => {
    const bound = ActionHttp.make([Alpha, Beta, Audit]);

    const handler = handlerOf(
      Layer.mergeAll(
        ActionHttp.layer(
          bound,
          Action.implement(Alpha, () => Effect.succeed("alpha")),
        ),
        ActionHttp.layer(
          bound,
          Action.implement(Beta, () => Effect.succeed("beta")),
        ),
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

    const users = ActionHttp.layer(Http, whoAmI).pipe(Layer.provide(Layer.succeed(Tenant, "acme")));
    const invoices = ActionHttp.layer(Http, billing);

    const statuses = async (handler: (request: Request) => Promise<Response>) => [
      (await handler(post("/api/whoAmI"))).status,
      (await handler(post("/api/invoice", { amount: "2" }))).status,
    ];

    // Each layer registers its own routes, so a guard covers exactly what it is provided to.
    expect(
      await statuses(handlerOf(Layer.mergeAll(users.pipe(Layer.provide(blocked)), invoices))),
    ).toEqual([403, 200]);
    expect(
      await statuses(handlerOf(Layer.mergeAll(users, invoices.pipe(Layer.provide(blocked))))),
    ).toEqual([200, 403]);
    expect(
      await statuses(handlerOf(Layer.mergeAll(users, invoices).pipe(Layer.provide(blocked)))),
    ).toEqual([403, 403]);
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
      Layer.mergeAll(
        ActionHttp.layer(bound, apps),
        ActionMcp.layerHttp(apps, { name: "test", version: "0" }),
      ),
    );

    expect((await handler(post("/api/find"))).status).toBe(404);
    const refused = await handler(post("/api/list"));
    expect(refused.status).toBe(403);
    expect(await refused.json()).toEqual(
      Schema.encodeSync(Refused)(new Refused({ reason: "closed" })),
    );

    const tool = await handler(rawToolCall("list"));

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

    const response = await handler(mcpRequest({ method: "tools/list" }));

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

    expect(
      await against(
        handler,
        Effect.flatMap(Testing.mcpClient([WhoAmI]), (mcp) => mcp.whoAmI()),
      ),
    ).toBe("ada@acme");
  });

  it("names each tool after its action, and checks names where tools are served", () => {
    const same = () =>
      Action.make("same", { description: "", access: "write", success: Schema.String });

    const First = same();
    const Second = same();

    // Two contracts may share a name; whoever serves both refuses them.
    expect(() => ActionHttp.make([First, Second])).toThrow("Duplicate action: same");

    const apps = [
      Action.implement(First, () => Effect.succeed("a")),
      Action.implement(Second, () => Effect.succeed("b")),
    ];

    const options = { name: "test", version: "0" };
    expect(() => ActionMcp.layerHttp(apps, options)).toThrow("Duplicate MCP tool: same");
    expect(() => ActionMcp.runStdio(apps, options)).toThrow("Duplicate MCP tool: same");
    expect(() => ActionToolkit.make(apps)).toThrow("Duplicate tool: same");

    const Other = Action.make("other", {
      description: "",
      access: "write",
      success: Schema.String,
    });

    expect(() =>
      ActionMcp.layerHttp([whoAmI, Action.implement(Other, () => Effect.succeed("b"))], options),
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
