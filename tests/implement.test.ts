import { assert, describe, expect, it } from "@effect/vitest";
import { Cause, Context, Effect, Exit, Layer, Schema, Stdio } from "effect";
import * as Action from "../src/Action.js";
import * as ActionCli from "../src/ActionCli.js";
import * as ActionHttp from "../src/ActionHttp.js";
import * as ActionMcp from "../src/ActionMcp.js";
import * as ActionToolkit from "../src/ActionToolkit.js";
import * as Testing from "../src/Testing.js";
import { exec } from "./cli-services.js";
import { defectOf } from "./defect.js";
import { serve, serveWithContext } from "./serve.js";
import { post, send } from "./requests.js";
import { actors, CurrentActor } from "../examples/authorization.js";
import { Permissions, whoAmI as storedWhoAmI } from "../examples/authorization-built.js";
import { WhoAmI as WhoAmIContract } from "../examples/contracts.js";

class Tenant extends Context.Service<Tenant, string>()("implement-test/Tenant") {}

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

    const handler = serve(
      ActionHttp.layer(ActionHttp.make(app.actions), app).pipe(
        Layer.provide(Layer.succeed(Tenant, "acme")),
      ),
    ).handler;

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

  it.effect("dies at layer build, not at a request, for a builder's record missing a key", () =>
    Effect.gen(function* () {
      const app = Action.implement(
        [Hello, Bye],
        Effect.sync(() => pair((h) => Reflect.deleteProperty(h, "bye"))),
        Action.allowAll,
      );

      const routes = ActionHttp.layer(ActionHttp.make([Hello, Bye]), app);

      // Even the action that has a handler is never served by an incomplete record.
      expect(
        yield* defectOf(
          send(post("/api/hello", { name: "Ada" })).pipe(Effect.provide(Testing.layer(routes))),
        ),
      ).toMatchObject({ message: "Missing handlers: bye" });
      expect(yield* defectOf(Layer.build(ActionToolkit.make(app).layer))).toMatchObject({
        message: "Missing handlers: bye",
      });

      // Building a command checks nothing; running either one builds and checks the whole record.
      for (const [action, args] of [
        [Hello, ["--name", "Ada"]],
        [Bye, []],
      ] as const) {
        expect(yield* defectOf(exec(ActionCli.command(app, action), args))).toMatchObject({
          message: "Missing handlers: bye",
        });
      }
    }),
  );

  it.effect("refuses a record key that names no action: a plain one at implement", () =>
    Effect.gen(function* () {
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

      expect(yield* defectOf(Layer.build(ActionToolkit.make(built).layer))).toMatchObject({
        message: "Unknown handlers: stale",
      });
    }),
  );
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

  it.effect("refuses an implementation that states no hook, as plain JavaScript may write it", () =>
    Effect.gen(function* () {
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

      expect(yield* defectOf(Layer.build(ActionToolkit.make(unbuilt).layer))).toMatchObject({
        message: missing,
      });
    }),
  );

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
      await Effect.runPromise(
        Effect.flatMap(Testing.mcpClient([Hello]), (mcp) => mcp.hello()).pipe(
          Effect.provide(Testing.layer(as("alice"))),
        ),
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

    const handler = serve(
      Layer.mergeAll(
        ActionHttp.layer(Both, hi),
        ActionHttp.layer(Both, bye),
        ActionMcp.layerHttp([hi, bye], { name: "test", version: "0" }),
      ).pipe(Layer.provide(Guard.layer)),
    ).handler;

    expect(await (await handler(post("/api/hello"))).json()).toBe("hi");
    expect(await (await handler(post("/api/bye"))).json()).toBe("bye");
    expect(built).toBe(1);
  });

  it("serves the documented built hook: its store provided at startup, the actor per call", async () => {
    const Http = ActionHttp.make([WhoAmIContract]);

    const web = serveWithContext(
      ActionHttp.layer(Http, storedWhoAmI).pipe(Layer.provide(Permissions.layerMemory)),
    );

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

  it.effect.each([
    {
      surface: "ActionHttp.layer",
      build: ({ pair, solo }: Fixture) =>
        Effect.gen(function* () {
          expect(yield* (yield* send(post("/api/one"))).json).toBe(1);
        }).pipe(
          Effect.provide(
            Testing.layer(ActionHttp.layer(ActionHttp.make([One, Two, Solo]), [solo, pair])),
          ),
        ),
    },
    {
      surface: "ActionMcp.layerHttp",
      build: ({ pair, solo }: Fixture) =>
        Effect.gen(function* () {
          const mcp = yield* Testing.mcpClient([One]);

          expect(yield* mcp.one()).toBe(1);
        }).pipe(
          Effect.provide(
            Testing.layer(ActionMcp.layerHttp([solo, pair], { name: "test", version: "0" })),
          ),
        ),
    },
    {
      surface: "ActionMcp.runStdio",
      // A test host with nothing on stdin closes at once, so the server ends.
      build: ({ pair, solo }: Fixture) =>
        ActionMcp.runStdio([solo, pair], { name: "test", version: "0" }).pipe(
          Effect.provide(Stdio.layerTest({})),
        ),
    },
    {
      surface: "ActionToolkit",
      build: ({ pair, solo }: Fixture) => Layer.build(ActionToolkit.make([solo, pair]).layer),
    },
  ])("$surface runs the builder of each implementation it serves once", ({ build }) =>
    Effect.gen(function* () {
      const fixed = fixture();

      yield* build(fixed);

      expect(fixed.built.sort()).toEqual(["pair", "solo"]);
    }),
  );

  it.effect("fails runStdio with a builder's failure, rather than ending as the host closing", () =>
    Effect.gen(function* () {
      class Unavailable extends Schema.TaggedError<Unavailable>()("Unavailable", {}) {}

      const Solo = Action.make("solo", { description: "", access: "read" });

      const failing = Action.implement(
        Solo,
        Effect.as(Effect.fail(new Unavailable()), () => Effect.void),
        Action.allowAll,
      );

      const exit = yield* Effect.exit(
        ActionMcp.runStdio(failing, { name: "test", version: "0" }).pipe(
          Effect.provide(Stdio.layerTest({})),
        ),
      );

      assert(Exit.isFailure(exit));
      expect(Cause.squash(exit.cause)).toBeInstanceOf(Unavailable);
    }),
  );

  it.effect("runs a builder again for a host built separately", () =>
    Effect.gen(function* () {
      const { built, pair } = fixture();
      const toolkit = ActionToolkit.make(pair);

      yield* Effect.scoped(Layer.build(toolkit.layer));
      yield* Effect.scoped(Layer.build(toolkit.layer));

      expect(built).toEqual(["pair", "pair"]);
    }),
  );
});
