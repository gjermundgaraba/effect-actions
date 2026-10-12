import { assert, describe, expect, it } from "@effect/vitest";
import { Cause, Context, Effect, Exit, Layer, Redacted, Schema, Stdio } from "effect";
import * as Action from "../../src/contract/Action.js";
import * as ActionCli from "../../src/cli/ActionCli.js";
import * as ActionHttp from "../../src/http/ActionHttp.js";
import * as ActionMcp from "../../src/mcp/ActionMcp.js";
import * as ActionToolkit from "../../src/toolkit/ActionToolkit.js";
import * as Authentication from "../../src/authentication/Authentication.js";
import * as Testing from "../../src/testing/Testing.js";
import { exec } from "../support/cli-services.js";
import { defectOf } from "../support/defect.js";
import { serve } from "../support/serve.js";
import { as, post, send, withBearer } from "../support/requests.js";
import { authenticate } from "../../examples/authentication.js";
import { CurrentActor } from "../../examples/authorization.js";
import { Login } from "../../examples/binding.js";
import { Permissions, whoAmI as storedWhoAmI } from "../../examples/authorization-built.js";
import { WhoAmI as WhoAmIContract } from "../../examples/contracts.js";

class Tenant extends Context.Service<Tenant, string>()("implement-test/Tenant") {}

describe("implement", () => {
  const Hello = Action.make("hello", {
    description: "Greets",
    readOnly: false,
    caller: Action.Anyone,
    input: { name: Schema.String },
    success: Schema.String,
  });

  const Bye = Action.make("bye", {
    description: "Parts",
    readOnly: false,
    caller: Action.Anyone,
    success: Schema.String,
  });

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

    const handler = serve(
      ActionHttp.layer(ActionHttp.make(app.actions), app).pipe(
        Layer.provide(Layer.succeed(Tenant, "acme")),
      ),
    ).handler;

    expect(await (await handler(post("/api/hello", { name: "Ada" }))).json()).toBe(hello);

    if (bye !== undefined) expect(await (await handler(post("/api/bye"))).json()).toBe(bye);
  });

  it("returns one implementation of every action it binds, with its actions as its only data", () => {
    const app = Action.implement([Hello, Bye], {
      hello: () => Effect.succeed("hi"),
      bye: () => Effect.succeed("bye"),
    });

    const one = Action.implement(Hello, () => Effect.succeed("hi"));

    expect(app.actions).toEqual([Hello, Bye]);
    expect(one.actions).toEqual([Hello]);
    expect(Object.keys(app)).toEqual(["actions"]);
    expect(Object.keys(one)).toEqual(["actions"]);
  });

  it("refuses duplicate actions at implement", () => {
    expect(() => Action.implement([Hello, Hello], { hello: () => Effect.succeed("hi") })).toThrow(
      "Duplicate action: hello",
    );
  });

  const record = () => ({ hello: () => Effect.succeed("hi"), bye: () => Effect.succeed("bye") });

  const pair = (change: (handlers: ReturnType<typeof record>) => boolean) => {
    const handlers = record();
    change(handlers);

    return handlers;
  };

  class OwnHelloInheritedBye {
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
      make: () => Action.implement([Hello, Bye], new OwnHelloInheritedBye()),
    },
  ])("throws at implement for $handlers", ({ make }) => {
    expect(make).toThrow("Missing handlers: bye");
  });

  it.effect(
    "dies when its layer builds or a command runs, not at a request, for a builder's record missing a key",
    () =>
      Effect.gen(function* () {
        const app = Action.implement(
          [Hello, Bye],
          Effect.sync(() => pair((h) => Reflect.deleteProperty(h, "bye"))),
        );

        const routes = ActionHttp.layer(ActionHttp.make([Hello, Bye]), app);

        expect(
          yield* defectOf(
            send(post("/api/hello", { name: "Ada" })).pipe(Effect.provide(Testing.layer(routes))),
          ),
        ).toMatchObject({ message: "Missing handlers: bye" });
        expect(yield* defectOf(Layer.build(ActionToolkit.make(app).layer))).toMatchObject({
          message: "Missing handlers: bye",
        });

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
        Action.implement([Hello], {
          hello: () => Effect.succeed("hi"),
          // @ts-expect-error -- A record names only its actions.
          stale: () => Effect.succeed("stale"),
        }),
      ).toThrow("Unknown handlers: stale");

      const built = Action.implement(
        [Hello],
        // @ts-expect-error -- A builder's record names only its actions.
        Effect.succeed({ hello: () => Effect.succeed("hi"), stale: () => Effect.succeed("stale") }),
      );

      expect(yield* defectOf(Layer.build(ActionToolkit.make(built).layer))).toMatchObject({
        message: "Unknown handlers: stale",
      });
    }),
  );
});

describe("authorization", () => {
  const Hello = Action.make("hello", {
    description: "Greets",
    readOnly: true,
    caller: CurrentActor,
    success: Schema.String,
  });

  const hello = () => Effect.succeed("hi");
  const missing = "Protected actions require authorize, or Action.allowAll";
  const notAFunction = "Missing authorize: pass an authorization function, or Action.allowAll";

  it.effect(
    "refuses an implementation of protected actions stating no authorize, as plain JavaScript may write it",
    () =>
      Effect.gen(function* () {
        // @ts-expect-error -- A protected action's implementation states who may call.
        expect(() => Action.implement(Hello, hello)).toThrow(missing);
        // @ts-expect-error -- Nor may its options leave it out.
        expect(() => Action.implement(Hello, hello, {})).toThrow(missing);
        // @ts-expect-error -- `undefined` is not an authorizer.
        expect(() => Action.implement(Hello, hello, { authorize: undefined })).toThrow(missing);
        // @ts-expect-error -- Nor is anything else but a function or an Effect building one.
        expect(() => Action.implement(Hello, hello, { authorize: "allowAll" })).toThrow(
          notAFunction,
        );

        // @ts-expect-error -- An Effect building something other than an authorizer.
        const unbuilt = Action.implement(Hello, hello, { authorize: Effect.succeed("allowAll") });

        expect(yield* defectOf(Layer.build(ActionToolkit.make(unbuilt).layer))).toMatchObject({
          message: notAFunction,
        });
      }),
  );

  it("refuses an authorize given to public actions alone, which would never run", () => {
    const Open = Action.make("open", { description: "", readOnly: true, caller: Action.Anyone });

    expect(() =>
      // @ts-expect-error -- A public-only target takes no authorize.
      Action.implement(Open, () => Effect.void, { authorize: Action.allowAll }),
    ).toThrow("A public-only target takes no authorize");
  });

  it("builds authorize once per layer graph for every surface, and runs what it built per call", async () => {
    const called: Array<string> = [];
    let built = 0;

    const app = Action.implement(Hello, hello, {
      authorize: Effect.gen(function* () {
        const tenant = yield* Tenant;

        built++;

        return () =>
          Effect.flatMap(CurrentActor, ({ id }) => {
            called.push(`${id}@${tenant}`);

            return id === "alice" ? Effect.void : Effect.fail(new Action.Forbidden());
          });
      }),
    });

    const web = serve(
      Layer.mergeAll(
        ActionHttp.layer(ActionHttp.make([Hello], { authentication: Login }), app),
        ActionMcp.layerHttp(app, { name: "test", version: "0", authentication: Login }),
      ).pipe(Layer.provide([authenticate, Layer.succeed(Tenant, "acme")])),
    );

    expect(await (await web.handler(withBearer(post("/api/hello"), "alice"))).json()).toBe("hi");
    expect((await web.handler(withBearer(post("/api/hello"), "bob"))).status).toBe(403);
    expect(
      await Effect.runPromise(
        Effect.flatMap(Testing.mcpClient([Hello], as("alice")), (mcp) => mcp.hello()).pipe(
          Effect.provide(Testing.layer(web.handler)),
        ),
      ),
    ).toBe("hi");
    expect({ built, called }).toEqual({
      built: 1,
      called: ["alice@acme", "bob@acme", "alice@acme"],
    });
  });

  it("builds authorize passed as a service once for every implementation it guards", async () => {
    const Bye = Action.make("bye", {
      description: "Parts",
      readOnly: true,
      caller: CurrentActor,
      success: Schema.String,
    });

    let built = 0;

    class Guard extends Context.Service<Guard, Action.Authorize<Action.Any>>()(
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

    const hi = Action.implement(Hello, hello, { authorize: Guard });
    const bye = Action.implement(Bye, () => Effect.succeed("bye"), { authorize: Guard });
    const Both = ActionHttp.make([Hello, Bye], { authentication: Login });

    const handler = serve(
      Layer.mergeAll(
        ActionHttp.layer(Both, hi),
        ActionHttp.layer(Both, bye),
        ActionMcp.layerHttp([hi, bye], { name: "test", version: "0", authentication: Login }),
      ).pipe(Layer.provide([authenticate, Guard.layer])),
    ).handler;

    expect(await (await handler(withBearer(post("/api/hello"), "alice"))).json()).toBe("hi");
    expect(await (await handler(withBearer(post("/api/bye"), "alice"))).json()).toBe("bye");
    expect(built).toBe(1);
  });

  it("serves the documented built authorizer: its store provided at startup, the actor per call", async () => {
    const Http = ActionHttp.make([WhoAmIContract], { authentication: Login });

    const tokenAsActorWithoutPermissions = Authentication.layer(
      Login,
      (token: Redacted.Redacted<string>) =>
        Effect.succeed({ id: Redacted.value(token), tenantId: "acme", permissions: [] }),
    );

    const web = serve(
      ActionHttp.layer(Http, storedWhoAmI).pipe(
        Layer.provide([tokenAsActorWithoutPermissions, Permissions.layerMemory]),
      ),
    );

    const callAs = (token: string) => web.handler(withBearer(post("/api/whoAmI"), token));

    expect(await (await callAs("reader")).json()).toEqual({ id: "reader", tenantId: "acme" });
    expect((await callAs("nobody")).status).toBe(403);
  });
});

describe("builder acquisition", () => {
  const One = Action.make("one", {
    description: "One",
    readOnly: false,
    caller: Action.Anyone,
    success: Schema.Number,
  });

  const Two = Action.make("two", {
    description: "Two",
    readOnly: false,
    caller: Action.Anyone,
    success: Schema.Number,
  });

  const Solo = Action.make("solo", {
    description: "Solo",
    readOnly: false,
    caller: Action.Anyone,
    success: Schema.String,
  });

  const twoRecordingBuilders = () => {
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

  type Fixture = ReturnType<typeof twoRecordingBuilders>;

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
      const fixed = twoRecordingBuilders();

      yield* build(fixed);

      expect(fixed.built.sort()).toEqual(["pair", "solo"]);
    }),
  );

  it.effect("fails runStdio with a builder's failure, rather than ending as the host closing", () =>
    Effect.gen(function* () {
      class Unavailable extends Schema.TaggedError<Unavailable>()("Unavailable", {}) {}

      const Solo = Action.make("solo", { description: "", readOnly: true, caller: Action.Anyone });

      const failing = Action.implement(
        Solo,
        Effect.as(Effect.fail(new Unavailable()), () => Effect.void),
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
      const { built, pair } = twoRecordingBuilders();
      const toolkit = ActionToolkit.make(pair);

      yield* Effect.scoped(Layer.build(toolkit.layer));
      yield* Effect.scoped(Layer.build(toolkit.layer));

      expect(built).toEqual(["pair", "pair"]);
    }),
  );
});
