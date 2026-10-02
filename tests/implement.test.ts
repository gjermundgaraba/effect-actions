import { describe, expect, it } from "vite-plus/test";
import { Cause, Context, Effect, Exit, Layer, Result, Schema, Stdio } from "effect";
import { Command } from "effect/cli";
import { HttpRouter, HttpServer, HttpServerResponse } from "effect/http";
import { HttpApi, HttpApiClient, HttpApiSecurity, OpenApi } from "effect/http-api";
import * as Action from "../src/Action.js";
import * as ActionCli from "../src/ActionCli.js";
import * as ActionHttp from "../src/ActionHttp.js";
import * as ActionMcp from "../src/ActionMcp.js";
import * as ActionToolkit from "../src/ActionToolkit.js";
import * as Testing from "../src/Testing.js";
import { cliServices } from "./cli-services.js";
import { against, clientLayer, serve as serveRoutes, serveWithContext } from "./serve.js";
import { mcpRequest, post, rawToolCall } from "./requests.js";
import { actors, CurrentActor } from "../examples/authorization.js";
import { Permissions, whoAmI as storedWhoAmI } from "../examples/authorization-built.js";
import { WhoAmI as WhoAmIContract } from "../examples/contracts.js";

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
  Action.allowAll,
);

const billing = Action.implement(
  [Invoice, Audit],
  {
    invoice: ({ amount }) => Effect.succeed(amount * 2),
    audit: () => Effect.succeed("clean"),
  },
  Action.allowAll,
);

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
      make: () =>
        Action.implement(Hello, ({ name }) => Effect.succeed(`hi ${name}`), Action.allowAll),
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
          Action.allowAll,
        ),
      hello: "hi Ada@acme",
      bye: undefined,
    },
    {
      form: "several actions, a record",
      make: () =>
        Action.implement(
          [Hello, Bye],
          {
            hello: ({ name }) => Effect.succeed(`hi ${name}`),
            bye: () => Effect.succeed("bye"),
          },
          Action.allowAll,
        ),
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
          Action.allowAll,
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

  it("returns one implementation of every action it binds, with its actions as its only data", () => {
    const app = Action.implement(
      [Hello, Bye],
      {
        hello: () => Effect.succeed("hi"),
        bye: () => Effect.succeed("bye"),
      },
      Action.allowAll,
    );

    const one = Action.implement(Hello, () => Effect.succeed("hi"), Action.allowAll);

    expect(app.actions).toEqual([Hello, Bye]);
    expect(one.actions).toEqual([Hello]);
    expect(Object.keys(app)).toEqual(["actions"]);
    expect(Object.keys(one)).toEqual(["actions"]);
  });

  it("refuses duplicate actions at implement", () => {
    expect(() =>
      Action.implement([Hello, Hello], { hello: () => Effect.succeed("hi") }, Action.allowAll),
    ).toThrow("Duplicate action: hello");
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
          Action.allowAll,
        ),
    },
    {
      handlers: "a record with an undefined value",
      make: () =>
        Action.implement(
          [Hello, Bye],
          pair((h) => Reflect.set(h, "bye", undefined)),
          Action.allowAll,
        ),
    },
    {
      handlers: "a record with a non-function value",
      make: () =>
        Action.implement(
          [Hello, Bye],
          pair((h) => Reflect.set(h, "bye", "bye")),
          Action.allowAll,
        ),
    },
    {
      handlers: "a record with an inherited method",
      make: () => Action.implement([Hello, Bye], new Inherited(), Action.allowAll),
    },
  ])("throws at implement for $handlers", ({ make }) => {
    expect(make).toThrow("Missing handlers: bye");
  });

  it("dies at layer build, not at a request, for a builder's record missing a key", async () => {
    const app = Action.implement(
      [Hello, Bye],
      Effect.sync(() => pair((h) => Reflect.deleteProperty(h, "bye"))),
      Action.allowAll,
    );

    const handler = handlerOf(ActionHttp.layer(ActionHttp.make([Hello, Bye]), app));

    // Even the action that has a handler is never served by an incomplete record.
    await expect(handler(post("/api/hello", { name: "Ada" }))).rejects.toThrow(
      "Missing handlers: bye",
    );
    expect(await defectOf(ActionToolkit.make(app).layer)).toMatchObject({
      message: "Missing handlers: bye",
    });

    // Building a command checks nothing; running either one builds and checks the whole record.
    for (const [action, args] of [
      [Hello, ["--name", "Ada"]],
      [Bye, []],
    ] as const) {
      const exit = await Command.runWith(ActionCli.command(app, action), { version: "0" })(
        args,
      ).pipe(Effect.provide(cliServices), Effect.runPromiseExit);

      expect(Result.getOrUndefined(Exit.findDefect(exit))).toMatchObject({
        message: "Missing handlers: bye",
      });
    }
  });

  it("refuses a record key that names no action: a plain one at implement", async () => {
    expect(() =>
      Action.implement(
        [Hello],
        {
          hello: () => Effect.succeed("hi"),
          // @ts-expect-error A record names only its actions.
          stale: () => Effect.succeed("stale"),
        },
        Action.allowAll,
      ),
    ).toThrow("Unknown handlers: stale");

    const built = Action.implement(
      [Hello],
      // @ts-expect-error A builder's record names only its actions.
      Effect.succeed({ hello: () => Effect.succeed("hi"), stale: () => Effect.succeed("stale") }),
      Action.allowAll,
    );

    expect(await defectOf(ActionToolkit.make(built).layer)).toMatchObject({
      message: "Unknown handlers: stale",
    });
  });
});

describe("hooks", () => {
  const Hello = Action.make("hello", {
    description: "Greets",
    access: "read",
    success: Schema.String,
  });

  const hello = () => Effect.succeed("hi");
  const missing = "Missing hook: pass an authorization hook, or Action.allowAll";

  class Actor extends Context.Service<Actor, string>()("implement-test/Actor") {}

  it("refuses an implementation that states no hook, as plain JavaScript may write it", async () => {
    // @ts-expect-error Every implementation states who may call.
    expect(() => Action.implement(Hello, hello)).toThrow(missing);
    // @ts-expect-error `undefined` is not a hook.
    expect(() => Action.implement(Hello, hello, undefined)).toThrow(missing);
    // @ts-expect-error Nor is anything else but a function or an Effect building one.
    expect(() => Action.implement(Hello, hello, "allowAll")).toThrow(missing);

    // Left out, a share's hook is its source's; given, it is checked as `implement`'s.
    const app = Action.implement(Hello, hello, Action.allowAll);

    expect(Action.share(Hello, app).actions).toEqual([Hello]);
    // @ts-expect-error Not a hook.
    expect(() => Action.share(Hello, app, null)).toThrow(missing);
    // @ts-expect-error Given, `undefined` is not a hook either.
    expect(() => Action.share(Hello, app, undefined)).toThrow(missing);

    // A built hook is checked when its layer builds, as a builder's record is.
    // @ts-expect-error An Effect building something other than a hook.
    const unbuilt = Action.implement(Hello, hello, Effect.succeed("allowAll"));

    expect(await defectOf(ActionToolkit.make(unbuilt).layer)).toMatchObject({ message: missing });
  });

  it("builds a hook once per layer graph for every surface, and runs what it built per call", async () => {
    const called: Array<string> = [];
    let built = 0;

    const app = Action.implement(
      Hello,
      hello,
      // What the build yields is a startup service; what the hook yields, each call's.
      Effect.gen(function* () {
        const tenant = yield* Tenant;

        built++;

        return () =>
          Effect.flatMap(Actor, (actor) => {
            called.push(`${actor}@${tenant}`);

            return actor === "alice" ? Effect.void : Effect.fail(new Action.Forbidden());
          });
      }),
    );

    const web = serveWithContext(
      Layer.mergeAll(
        ActionHttp.layer(ActionHttp.make([Hello]), app),
        ActionMcp.layerHttp(app, { name: "test", version: "0" }),
      ).pipe(Layer.provide(Layer.succeed(Tenant, "acme"))),
    );

    const as = (actor: string) => (request: Request) =>
      web.handler(request, Context.make(Actor, actor));

    expect(await (await as("alice")(post("/api/hello"))).json()).toBe("hi");
    expect((await as("bob")(post("/api/hello"))).status).toBe(403);
    expect(
      await against(
        as("alice"),
        Effect.flatMap(Testing.mcpClient([Hello]), (mcp) => mcp.hello()),
      ),
    ).toBe("hi");
    expect({ built, called }).toEqual({
      built: 1,
      called: ["alice@acme", "bob@acme", "alice@acme"],
    });
  });
  it("builds a hook passed as a service once for every implementation it guards", async () => {
    const Bye = Action.make("bye", {
      description: "Parts",
      access: "read",
      success: Schema.String,
    });

    let built = 0;

    class Guard extends Context.Service<Guard, Action.Before<Action.Any>>()(
      "implement-test/Guard",
    ) {
      static readonly layer = Layer.effect(
        Guard,
        Effect.sync(() => {
          built++;

          return Action.allowAll;
        }),
      );
    }

    const hi = Action.implement(Hello, hello, Guard);
    const bye = Action.implement(Bye, () => Effect.succeed("bye"), Guard);
    const Both = ActionHttp.make([Hello, Bye]);

    const handler = handlerOf(
      Layer.mergeAll(
        ActionHttp.layer(Both, hi),
        ActionHttp.layer(Both, bye),
        ActionMcp.layerHttp([hi, bye], { name: "test", version: "0" }),
      ).pipe(Layer.provide(Guard.layer)),
    );

    expect(await (await handler(post("/api/hello"))).json()).toBe("hi");
    expect(await (await handler(post("/api/bye"))).json()).toBe("bye");
    expect(built).toBe(1);
  });

  it("serves the documented built hook: its store provided at startup, the actor per call", async () => {
    const Http = ActionHttp.make([WhoAmIContract]);

    const routes = ActionHttp.layer(Http, storedWhoAmI).pipe(
      Layer.provide(Permissions.layerMemory),
      // An identity provided at startup is the documented mistake: the request's still decides.
      Layer.provide(Layer.succeed(CurrentActor, actors.reader)),
    );

    const web = serveWithContext(routes);
    const nobody = { id: "nobody", tenantId: "acme", permissions: [] };

    // The identity per request, as authentication provides it; the store was built at startup.
    const as = (actor: typeof actors.reader | typeof nobody) =>
      web.handler(post("/api/whoAmI"), Context.make(CurrentActor, actor));

    expect(await (await as(actors.reader)).json()).toEqual({ id: "reader", tenantId: "acme" });
    expect((await as(nobody)).status).toBe(403);
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
      Action.allowAll,
    );

    const solo = Action.implement(
      Solo,
      builder("solo", () => Effect.succeed("solo")),
      Action.allowAll,
    );

    return { built, pair, solo };
  };

  type Fixture = ReturnType<typeof fixture>;

  it.each([
    {
      surface: "ActionHttp.layer",
      build: async ({ pair, solo }: Fixture) => {
        const handler = handlerOf(
          ActionHttp.layer(ActionHttp.make([One, Two, Solo]), [solo, pair]),
        );

        expect(await (await handler(post("/api/one"))).json()).toBe(1);
      },
    },
    {
      surface: "ActionMcp.layerHttp",
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
      surface: "ActionMcp.runStdio",
      // A test host with nothing on stdin closes at once, so the server ends.
      build: ({ pair, solo }: Fixture) =>
        Effect.runPromise(
          ActionMcp.runStdio([solo, pair], { name: "test", version: "0" }).pipe(
            Effect.provide(Stdio.layerTest({})),
          ),
        ),
    },
    {
      surface: "ActionToolkit",
      build: ({ pair, solo }: Fixture) =>
        Effect.runPromise(Effect.scoped(Layer.build(ActionToolkit.make([solo, pair]).layer))),
    },
  ])("$surface runs the builder of each implementation it serves once", async ({ build }) => {
    const fixed = fixture();

    await build(fixed);

    expect(fixed.built.sort()).toEqual(["pair", "solo"]);
  });

  it("fails runStdio with a builder's failure, rather than ending as the host closing", async () => {
    class Unavailable extends Schema.TaggedError<Unavailable>()("Unavailable", {}) {}

    const Solo = Action.make("solo", { description: "", access: "read" });

    const failing = Action.implement(
      Solo,
      Effect.as(Effect.fail(new Unavailable()), () => Effect.void),
      Action.allowAll,
    );

    const exit = await Effect.runPromiseExit(
      ActionMcp.runStdio(failing, { name: "test", version: "0" }).pipe(
        Effect.provide(Stdio.layerTest({})),
      ),
    );

    expect(Exit.isFailure(exit) && Cause.squash(exit.cause)).toBeInstanceOf(Unavailable);
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
  it.each([
    { prefix: undefined, mounted: "/api", route: "/api/whoAmI" },
    { prefix: "/", mounted: "/", route: "/whoAmI" },
    { prefix: "/v1/", mounted: "/v1", route: "/v1/whoAmI" },
    { prefix: "/v1/internal", mounted: "/v1/internal", route: "/v1/internal/whoAmI" },
  ] as const)("mounts routes and the document under prefix $prefix", async (mount) => {
    const binding = ActionHttp.make(
      [WhoAmI],
      mount.prefix === undefined ? {} : { prefix: mount.prefix },
    );

    const handler = handlerOf(
      ActionHttp.layer(binding, whoAmI).pipe(Layer.provide(Layer.succeed(Tenant, "acme"))),
    );

    expect(binding.prefix).toBe(mount.mounted);
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

  it("refuses an implementation holding none of its binding's actions, and serves each once", () => {
    const bound = ActionHttp.make([Alpha]);

    const LookAlike = Action.make("alpha", {
      description: "Alpha",
      access: "write",
      success: Schema.String,
    });

    const alpha = Action.implement(Alpha, () => Effect.succeed("x"), Action.allowAll);

    // Pairing is by identity: the same name and schemas do not make it this action.
    expect(() =>
      ActionHttp.layer(
        bound,
        Action.implement(LookAlike, () => Effect.succeed("x"), Action.allowAll),
      ),
    ).toThrow("No action of this implementation is in this HTTP binding: alpha (another contract)");
    expect(() =>
      ActionHttp.layer(
        bound,
        Action.implement(Beta, () => Effect.succeed("x"), Action.allowAll),
      ),
    ).toThrow("No action of this implementation is in this HTTP binding: beta");
    expect(() => ActionHttp.layer(bound, [alpha, alpha])).toThrow("Duplicate served action: alpha");
    expect(() =>
      ActionHttp.layer(bound, [
        alpha,
        Action.implement(Alpha, () => Effect.succeed("y"), Action.allowAll),
      ]),
    ).toThrow("Duplicate served action: alpha");

    const text = () => Effect.succeed("x");

    // Only the names it serves are checked: both implementations hold a `beta` it leaves out.
    expect(() =>
      ActionHttp.layer(ActionHttp.make([Alpha, Audit]), [
        Action.implement([Alpha, Beta], { alpha: text, beta: text }, Action.allowAll),
        Action.implement([Audit, Beta], { audit: text, beta: text }, Action.allowAll),
      ]),
    ).not.toThrow();
  });

  it("serves the actions its binding holds among an implementation's, and no others", async () => {
    let built = 0;
    const hooked: Array<string> = [];

    // One builder for an action HTTP serves and one it leaves to other surfaces.
    const app = Action.implement(
      [Alpha, Beta],
      Effect.sync(() => {
        built++;

        return { alpha: () => Effect.succeed("alpha"), beta: () => Effect.succeed("beta") };
      }),
      (action) =>
        Effect.sync(() => {
          hooked.push(action.name);
        }),
    );

    const web = serveRoutes(
      Layer.mergeAll(
        ActionHttp.layer(ActionHttp.make([Alpha]), app),
        ActionMcp.layerHttp(app, { name: "test", version: "0" }),
      ),
    );

    expect(await (await web.handler(post("/api/alpha"))).json()).toBe("alpha");
    expect((await web.handler(post("/api/beta"))).status).toBe(404);

    const tool = await web.handler(rawToolCall("beta"));

    expect(await tool.json()).toMatchObject({ result: { structuredContent: "beta" } });
    expect({ built, hooked }).toEqual({ built: 1, hooked: ["alpha", "beta"] });
  });

  it("serves one implementation through bindings of its own, each routing what it holds", async () => {
    let built = 0;

    const app = Action.implement(
      [Alpha, Beta, Audit],
      Effect.sync(() => {
        built++;

        return {
          alpha: () => Effect.succeed("alpha"),
          beta: () => Effect.succeed("beta"),
          audit: () => Effect.succeed("audit"),
        };
      }),
      Action.allowAll,
    );

    const Reads = ActionHttp.make([Alpha, Audit], { prefix: "/reads" });
    const Writes = ActionHttp.make([Beta], { prefix: "/writes" });

    const handler = handlerOf(
      Layer.mergeAll(ActionHttp.layer(Reads, app), ActionHttp.layer(Writes, app)),
    );

    const answers = await Promise.all(
      ["/reads/alpha", "/reads/audit", "/writes/beta", "/reads/beta", "/writes/alpha"].map(
        async (path) => {
          const response = await handler(post(path));

          return response.status === 200 ? await response.json() : response.status;
        },
      ),
    );

    expect(answers).toEqual(["alpha", "audit", "beta", 404, 404]);
    expect(built).toBe(1);
  });

  it("serves a route and another contract's tool of the same name side by side", async () => {
    const Search = Action.make("search", {
      description: "Search the site",
      access: "read",
      input: { query: Schema.String },
      success: Schema.String,
    });

    const AgentSearch = Action.make("search", {
      description: "Search the agent's notes",
      access: "read",
      input: { topic: Schema.String },
      success: Schema.String,
    });

    const web = Action.implement(
      Search,
      ({ query }) => Effect.succeed(`site:${query}`),
      Action.allowAll,
    );

    // The agent's `search` is not the binding's: HTTP leaves it, and its name, to MCP.
    const agent = Action.implement(
      [Alpha, AgentSearch],
      {
        alpha: () => Effect.succeed("alpha"),
        search: ({ topic }) => Effect.succeed(`notes:${topic}`),
      },
      Action.allowAll,
    );

    const routes = serveRoutes(
      Layer.mergeAll(
        ActionHttp.layer(ActionHttp.make([Search, Alpha]), [web, agent]),
        ActionMcp.layerHttp(agent, { name: "test", version: "0" }),
      ),
    );

    expect(await (await routes.handler(post("/api/search", { query: "x" }))).json()).toBe("site:x");

    const tool = await routes.handler(rawToolCall("search", { topic: "y" }));

    expect(await tool.json()).toMatchObject({ result: { structuredContent: "notes:y" } });
  });

  it("serves one binding's actions through several layers; an unserved action has no route", async () => {
    const bound = ActionHttp.make([Alpha, Beta, Audit]);

    const handler = handlerOf(
      Layer.mergeAll(
        ActionHttp.layer(
          bound,
          Action.implement(Alpha, () => Effect.succeed("alpha"), Action.allowAll),
        ),
        ActionHttp.layer(
          bound,
          Action.implement(Beta, () => Effect.succeed("beta"), Action.allowAll),
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

    const apps = Action.implement(
      [Find, List],
      {
        find: () => Effect.fail(new Missing()),
        list: () => Effect.fail(new Refused({ reason: "closed" })),
      },
      Action.allowAll,
    );

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

describe("documented security", () => {
  const schemes = {
    bearer: HttpApiSecurity.bearer,
    key: HttpApiSecurity.apiKey({ key: "x-api-key" }),
  };

  const Secured = ActionHttp.make([WhoAmI, Invoice, Audit], {
    security: schemes,
    public: [WhoAmI],
  });

  const Ping = Action.make("ping", { description: "Ping", access: "read", success: Schema.String });

  /** Each operation's security requirements in `document`, by path. */
  const requirements = (document: OpenApi.OpenAPISpec) =>
    Object.fromEntries(
      Object.entries(document.paths).map(([path, item]) => [path, item.post?.security]),
    );

  it("states the schemes on every endpoint but the public ones, any one of them sufficing", () => {
    expect(OpenApi.fromApi(Secured.api).components.securitySchemes).toEqual({
      bearer: { type: "http", scheme: "Bearer" },
      key: { type: "apiKey", name: "x-api-key", in: "header" },
    });
    expect(requirements(OpenApi.fromApi(Secured.api))).toEqual({
      "/api/whoAmI": [],
      "/api/invoice": [{ bearer: [] }, { key: [] }],
      "/api/audit": [{ bearer: [] }, { key: [] }],
    });
    // Without `security` there is nothing to state, `public` or not.
    const open = ActionHttp.make([WhoAmI, Invoice], { public: [WhoAmI] });

    expect(requirements(OpenApi.fromApi(open.api))).toEqual({
      "/api/whoAmI": [],
      "/api/invoice": [],
    });
  });

  it("keeps each binding's schemes in one document for several", () => {
    const combined = HttpApi.make("host")
      .addHttpApi(Secured.api)
      .addHttpApi(ActionHttp.make([Ping], { prefix: "/open" }).api);

    expect(requirements(OpenApi.fromApi(combined))).toEqual({
      "/api/whoAmI": [],
      "/api/invoice": [{ bearer: [] }, { key: [] }],
      "/api/audit": [{ bearer: [] }, { key: [] }],
      "/open/ping": [],
    });

    // One name, two schemes: Effect refuses to document either.
    const conflicting = HttpApi.make("host")
      .addHttpApi(Secured.api)
      .addHttpApi(
        ActionHttp.make([Ping], {
          prefix: "/open",
          security: { bearer: HttpApiSecurity.basic },
        }).api,
      );

    expect(() => OpenApi.fromApi(conflicting)).toThrow("Conflicting OpenAPI security scheme");
  });

  it("enforces nothing: served without authentication, every route answers any caller", async () => {
    const handler = handlerOf(
      ActionHttp.layer(Secured, [whoAmI, billing]).pipe(
        Layer.provide(Layer.succeed(Tenant, "acme")),
      ),
    );

    expect(await (await handler(post("/api/invoice", { amount: "2" }))).json()).toBe(4);
    expect(await (await handler(post("/api/audit"))).json()).toBe("clean");

    // The native client of the documented API calls it as it calls any binding.
    const answers = await Effect.runPromise(
      Effect.gen(function* () {
        const client = yield* HttpApiClient.make(Secured.api, { baseUrl: "http://localhost" });

        return [
          yield* client.whoAmI({ payload: {} }),
          yield* client.invoice({ payload: { amount: 3 } }),
        ];
      }).pipe(Effect.provide(clientLayer(handler))),
    );

    expect(answers).toEqual(["ada@acme", 6]);
  });

  it("refuses a public action outside the binding, as plain JavaScript may pass one", () => {
    expect(() =>
      // @ts-expect-error Only the binding's own actions are public.
      ActionHttp.make([WhoAmI], { security: schemes, public: [Ping] }),
    ).toThrow('Action "ping" is not in this HTTP binding');
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
      Action.implement(First, () => Effect.succeed("a"), Action.allowAll),
      Action.implement(Second, () => Effect.succeed("b"), Action.allowAll),
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
      ActionMcp.layerHttp(
        [whoAmI, Action.implement(Other, () => Effect.succeed("b"), Action.allowAll)],
        options,
      ),
    ).not.toThrow();
  });
});
