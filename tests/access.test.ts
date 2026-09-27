import { describe, expect, it, onTestFinished } from "vite-plus/test";
import { Cause, Context, Effect, Exit, Layer, Schema, type Scope, Stream } from "effect";
import { Command } from "effect/unstable/cli";
import { Tool } from "effect/unstable/ai";
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
 * One rule for a whole implementation, read from the contract rather than from a name list. No
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
    app: Action.implement(
      [Read, Write],
      {
        read: () => record("read"),
        write: () => record("write"),
      },
      authorize(hooks),
    ),
  };
};

const readOnly = Layer.succeed(Scopes, ["read"]);

type App = ReturnType<typeof make>["app"];

/** Serve the actions over HTTP, granting `granted` to every request. */
const serveHttp = (app: App, granted: Layer.Layer<Scopes>) =>
  serve(ActionHttp.layer(Http, app).pipe(HttpRouter.provideRequest(granted)));

describe("action access", () => {
  it("is declared by every action, and is the only source of a tool's read-only hint", () => {
    const read: "read" = Read.access;
    const write: "write" = Write.access;

    expect([read, write]).toEqual(["read", "write"]);
    expect(Read.hints).toMatchObject({ destructive: false });
    expect(Write.hints).toMatchObject({ destructive: true });

    const { tools } = ActionToolkit.make(make().app).toolkit;
    expect(Context.get(tools.read.annotations, Tool.Readonly)).toBe(true);
    expect(Context.get(tools.write.annotations, Tool.Readonly)).toBe(false);

    Action.make("advertised", {
      description: "A write the model may call without approval",
      access: "write",
      success: Schema.String,
      // @ts-expect-error A tool is read-only exactly when its action reads.
      hints: { readOnly: true },
    });
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
    const web = serveHttp(app, readOnly);
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

  it("decodes HTTP input before running either the hook or handler", async () => {
    const { app, hooks, handlers } = make();
    const web = serveHttp(app, readOnly);
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
      ActionMcp.layerHttp(app, { name: "test", version: "0" }).pipe(
        HttpRouter.provideRequest(readOnly),
      ),
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

    const binding = ActionToolkit.make(app);

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
    const refusal = new Action.Forbidden({ message: "Requires write." });

    // The refusal itself, encoded like a declared error.
    expect(refused).toMatchObject([
      {
        isFailure: true,
        result: refusal,
        encodedResult: Schema.encodeSync(Action.Forbidden)(refusal),
      },
    ]);
    expect(refused[0]?.result).toBeInstanceOf(Action.Forbidden);

    expect(hooks).toEqual(["read", "write"]);
    expect(handlers).toEqual(["read"]);
  });

  it("runs over the CLI, so a local caller supplies its services too", async () => {
    const { app, hooks, handlers } = make();

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

    const [read, output] = await run(ActionCli.command(app, Read), []);
    expect(read._tag).toBe("Success");
    expect(output).toEqual(['"read ok"']);

    const [refused] = await run(ActionCli.command(app, Write), ["--value", "x"]);

    expect(Exit.isFailure(refused) ? Cause.squash(refused.cause) : undefined).toBeInstanceOf(
      Action.Forbidden,
    );

    expect(hooks).toEqual(["read", "write"]);
    expect(handlers).toEqual(["read"]);
  });

  it("is skipped by no action of its implementation", async () => {
    const { app, hooks } = make();
    const web = serveHttp(app, Layer.succeed(Scopes, ["read", "write"]));
    onTestFinished(() => web.dispose());

    expect((await web.handler(post("/api/write", { value: "x" }))).status).toBe(200);
    expect(hooks).toEqual(["write"]);
  });

  it("is bound per implementation, so implementations without it skip it", async () => {
    const hooks: Array<string> = [];
    const handlers: Array<string> = [];
    const record = (name: string) => Effect.sync(() => (handlers.push(name), `${name} ok`));
    const read = Action.implement(Read, () => record("read"));
    const write = Action.implement(Write, () => record("write"), authorize(hooks));

    // One layer: only the write implementation has the hook.
    const web = serve(
      ActionHttp.layer(Http, [read, write]).pipe(HttpRouter.provideRequest(readOnly)),
    );

    onTestFinished(() => web.dispose());

    expect((await web.handler(post("/api/read"))).status).toBe(200);
    expect((await web.handler(post("/api/write", { value: "x" }))).status).toBe(403);
    expect(hooks).toEqual(["write"]);
    expect(handlers).toEqual(["read"]);
  });
});
