import { describe, expect, it, onTestFinished } from "vite-plus/test";
import { Cause, Context, Effect, Exit, Layer, Schema, type Scope, Stream } from "effect";
import { Command } from "effect/unstable/cli";
import { HttpRouter } from "effect/unstable/http";
import * as Action from "../src/Action.js";
import * as ActionCli from "../src/ActionCli.js";
import * as ActionHttp from "../src/ActionHttp.js";
import * as ActionMcp from "../src/ActionMcp.js";
import * as ActionToolkit from "../src/ActionToolkit.js";
import { cliServices, logged } from "./cli-services.js";
import { post, rawToolCall } from "./requests.js";
import { serve } from "./serve.js";

class Scopes extends Context.Service<Scopes, ReadonlyArray<string>>()("access-test/Scopes") {}

const Read = Action.make("read", {
  description: "Read the resource",
  access: "read",
  success: Schema.String,
});

const Write = Action.make("write", {
  description: "Change the resource",
  access: "write",
  input: { value: Schema.String },
  success: Schema.String,
});

// The hook answers instead of a handler with a built-in refusal, which every endpoint
// declares, so the binding needs no errors of its own.
const Http = ActionHttp.make([Read, Write]);

/**
 * One rule for a whole surface, read from the contract rather than from a name list. No
 * scopes at all is unauthenticated; a read-only grant is forbidden to write.
 */
const authorize =
  (seen: Array<string>) =>
  (action: Action.Any): Effect.Effect<void, Action.Refusal, Scopes> =>
    Effect.gen(function* () {
      seen.push(action.name);
      const granted = yield* Scopes;

      if (granted.length === 0) return yield* new Action.Unauthenticated({ message: "Sign in." });

      if (action.access === "read") return;

      if (!granted.includes("write")) {
        return yield* new Action.Forbidden({ message: "Requires write." });
      }
    });

/** A fresh implementation per test, with the hook and handler invocations it recorded. */
const make = () => {
  const hooks: Array<string> = [];
  const handlers: Array<string> = [];
  const record = (name: string) => Effect.sync(() => (handlers.push(name), `${name} ok`));

  return {
    hooks,
    handlers,
    app: Action.implement([Read, Write], {
      read: () => record("read"),
      write: () => record("write"),
    }),
  };
};

const readOnly = Layer.succeed(Scopes, ["read"]);

type App = ReturnType<typeof make>["app"];

/** Serve the actions over HTTP with the hook bound to that surface. */
const serveHttp = (app: App, before: ReturnType<typeof authorize>, granted: Layer.Layer<Scopes>) =>
  serve(ActionHttp.layer(Http, app, { before }).pipe(HttpRouter.provideRequest(granted)));

describe("action access", () => {
  it("is declared by every action and derives the MCP read-only hint from it", () => {
    const read: "read" = Read.access;
    const write: "write" = Write.access;

    expect([read, write]).toEqual(["read", "write"]);
    expect(Read.hints).toMatchObject({ readOnly: true, destructive: false });
    expect(Write.hints).toMatchObject({ readOnly: false, destructive: true });
  });

  it("keeps an explicit hint that disagrees with access", () => {
    const advertised = Action.make("advertised", {
      description: "A write the model may call without approval",
      access: "write",
      success: Schema.String,
      hints: { readOnly: true },
    });

    expect(advertised.access).toBe("write");
    expect(advertised.hints).toMatchObject({ readOnly: true, destructive: false });
  });

  it("refuses a value the contract does not define, so plain JavaScript cannot skip a rule", () => {
    expect(() =>
      Action.make("unclassified", {
        description: "Classified by nobody",
        // @ts-expect-error The check exists for callers the compiler never sees.
        access: "admin",
        success: Schema.String,
      }),
    ).toThrow("Invalid access: admin");
  });
});

describe("the pre-handler hook", () => {
  it("runs once before each handler over HTTP and answers as a built-in refusal", async () => {
    const { app, hooks, handlers } = make();
    const web = serveHttp(app, authorize(hooks), readOnly);
    onTestFinished(() => web.dispose());

    const allowed = await web.handler(post("/api/read"));
    expect(allowed.status).toBe(200);
    expect(await allowed.json()).toBe("read ok");

    const refused = await web.handler(post("/api/write", { value: "x" }));
    expect(refused.status).toBe(403);
    // The body is the refusal, encoded by its own schema like a handler's error.
    expect(await refused.json()).toEqual(
      Schema.encodeSync(Action.Forbidden)(new Action.Forbidden({ message: "Requires write." })),
    );

    expect(hooks).toEqual(["read", "write"]);
    expect(handlers).toEqual(["read"]);
  });

  it("answers an unauthenticated refusal with 401", async () => {
    const { app, hooks, handlers } = make();
    const web = serveHttp(app, authorize(hooks), Layer.succeed(Scopes, []));
    onTestFinished(() => web.dispose());

    const refused = await web.handler(post("/api/read"));
    expect(refused.status).toBe(401);
    expect(await refused.json()).toEqual(
      Schema.encodeSync(Action.Unauthenticated)(
        new Action.Unauthenticated({ message: "Sign in." }),
      ),
    );
    expect(hooks).toEqual(["read"]);
    expect(handlers).toEqual([]);
  });

  it("may fail only with a refusal", () => {
    const { app } = make();

    class Other extends Schema.TaggedError<Other>()("Other", {}) {}

    const before = () => Effect.fail(new Other());

    // @ts-expect-error A hook answers only with a built-in refusal, which every surface declares.
    ActionHttp.layer(Http, app, { before });
    // @ts-expect-error The same rule holds for every surface.
    ActionToolkit.make(app, { before });
  });

  it("decodes HTTP input before running either the hook or handler", async () => {
    const { app, hooks, handlers } = make();
    const web = serveHttp(app, authorize(hooks), readOnly);
    onTestFinished(() => web.dispose());

    const invalid = await web.handler(post("/api/write", { value: 42 }));
    expect(invalid.status).toBe(400);
    expect(hooks).toEqual([]);
    expect(handlers).toEqual([]);

    const refused = await web.handler(post("/api/write", { value: "x" }));
    expect(refused.status).toBe(403);
    expect(hooks).toEqual(["write"]);
    expect(handlers).toEqual([]);
  });

  it("runs over MCP, where a refusal is the tool's declared failure", async () => {
    const { app, hooks, handlers } = make();

    const mcp = serve(
      ActionMcp.layerHttp(app, {
        name: "test",
        version: "0",
        before: authorize(hooks),
      }).pipe(HttpRouter.provideRequest(readOnly)),
    );

    onTestFinished(() => mcp.dispose());

    expect(await (await mcp.handler(rawToolCall("read"))).json()).toMatchObject({
      result: { isError: false, structuredContent: { value: "read ok" } },
    });
    expect(await (await mcp.handler(rawToolCall("write", { value: "x" }))).json()).toMatchObject({
      result: {
        isError: true,
        content: [{ type: "text", text: '{"_tag":"Forbidden","message":"Requires write."}' }],
      },
    });

    expect(hooks).toEqual(["read", "write"]);
    expect(handlers).toEqual(["read"]);
  });

  it("runs over the native Toolkit", async () => {
    const { app, hooks, handlers } = make();

    const binding = ActionToolkit.make(app, { before: authorize(hooks) });

    const call = (name: "read" | "write") =>
      Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const tools = yield* binding.toolkit;

            return yield* Stream.runCollect(
              yield* tools.handle(name, name === "write" ? { value: "x" } : {}),
            );
          }).pipe(Effect.provide(binding.layer), Effect.provide(readOnly)),
        ),
      );

    expect(await call("read")).toMatchObject([{ isFailure: false, result: "read ok" }]);

    const refused = await call("write");
    expect(refused).toMatchObject([{ isFailure: true, result: { message: "Requires write." } }]);
    expect(refused[0]?.result).toBeInstanceOf(Action.Forbidden);

    expect(hooks).toEqual(["read", "write"]);
    expect(handlers).toEqual(["read"]);
  });

  it("runs over the CLI, so a local caller supplies its services too", async () => {
    const { app, hooks, handlers } = make();
    const guard = { before: authorize(hooks) };

    const run = <Name extends string, Input, Services, E>(
      command: Command.Command<Name, Input, Services, E, Scope.Scope | Scopes>,
      argv: ReadonlyArray<string>,
    ) =>
      Effect.runPromise(
        Effect.scoped(
          logged(Command.runWith(command, { version: "0" })([...argv]).pipe(Effect.exit)).pipe(
            Effect.provide(cliServices),
            Effect.provide(readOnly),
          ),
        ),
      );

    const [read, output] = await run(ActionCli.command(app, Read, guard), []);
    expect(read._tag).toBe("Success");
    expect(output).toEqual(['"read ok"']);

    const [refused] = await run(ActionCli.command(app, Write, guard), ["--value", "x"]);

    expect(Exit.isFailure(refused) ? Cause.squash(refused.cause) : undefined).toBeInstanceOf(
      Action.Forbidden,
    );

    expect(hooks).toEqual(["read", "write"]);
    expect(handlers).toEqual(["read"]);
  });

  it("is skipped by no action of the surface it is bound to", async () => {
    const { app, hooks } = make();
    const web = serveHttp(app, authorize(hooks), Layer.succeed(Scopes, ["read", "write"]));
    onTestFinished(() => web.dispose());

    expect((await web.handler(post("/api/write", { value: "x" }))).status).toBe(200);
    expect(hooks).toEqual(["write"]);
  });

  it("is bound per HTTP layer, so actions served without it skip it", async () => {
    const hooks: Array<string> = [];
    const handlers: Array<string> = [];
    const record = (name: string) => Effect.sync(() => (handlers.push(name), `${name} ok`));
    const read = Action.implement(Read, () => record("read"));
    const write = Action.implement(Write, () => record("write"));

    // One binding, two layers: only the write layer binds the hook.
    const web = serve(
      Layer.merge(
        ActionHttp.layer(Http, read),
        ActionHttp.layer(Http, write, { before: authorize(hooks) }),
      ).pipe(HttpRouter.provideRequest(readOnly)),
    );

    onTestFinished(() => web.dispose());

    expect((await web.handler(post("/api/read"))).status).toBe(200);
    expect((await web.handler(post("/api/write", { value: "x" }))).status).toBe(403);
    expect(hooks).toEqual(["write"]);
    expect(handlers).toEqual(["read"]);
  });
});
