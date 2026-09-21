import { describe, expect, it, onTestFinished } from "vite-plus/test";
import { Console, Context, Effect, Layer, Schema, type Scope, Stream } from "effect";
import { Command } from "effect/unstable/cli";
import * as Action from "../src/Action.js";
import * as ActionCatalog from "../src/ActionCatalog.js";
import * as ActionCli from "../src/ActionCli.js";
import * as ActionGroup from "../src/ActionGroup.js";
import * as ActionToolkit from "../src/ActionToolkit.js";
import { mcpRequest } from "../src/Testing.js";
import { capturingConsole, cliServices } from "./cli-services.js";
import { makeTestHttp, makeTestMcp, testMcpUrl } from "./server.js";
import { post } from "./requests.js";

class Scopes extends Context.Service<Scopes, ReadonlyArray<string>>()("access-test/Scopes") {}

class InsufficientScope extends Schema.TaggedError<InsufficientScope>()(
  "InsufficientScope",
  { required: Schema.String },
  { httpApiStatus: 403 },
) {}

const Read = Action.make("read", {
  description: "Read the resource",
  access: "read",
  success: Schema.String,
});

const Write = Action.make("write", {
  description: "Change the resource",
  access: "write",
  success: Schema.String,
});

const Group = ActionGroup.make({ name: "resource", errors: [InsufficientScope] }, Read, Write);

const mcpCall = (name: string) =>
  mcpRequest({ url: testMcpUrl, method: "tools/call", params: { name, arguments: {} } });

/** One rule for a whole group, read from the contract rather than from a name list. */
const authorize =
  (seen: Array<string>) =>
  (action: Action.Any): Effect.Effect<void, InsufficientScope, Scopes> =>
    Effect.gen(function* () {
      seen.push(action.name);

      if (action.access === "read") return;
      const granted = yield* Scopes;

      if (!granted.includes("write")) return yield* new InsufficientScope({ required: "write" });
    });

/** A fresh implementation per test, with the hook and handler invocations it recorded. */
const make = () => {
  const hooks: Array<string> = [];
  const handlers: Array<string> = [];
  const record = (name: string) => Effect.sync(() => (handlers.push(name), `${name} ok`));

  return {
    hooks,
    handlers,
    app: Group.implement(
      { read: () => record("read"), write: () => record("write") },
      { before: authorize(hooks) },
    ),
  };
};

const readOnly = Layer.succeed(Scopes, ["read"]);

describe("action access", () => {
  it("defaults to write and derives the MCP read-only hint from it", () => {
    const unclassified = Action.make("unclassified", {
      description: "Nobody classified this one",
      success: Schema.String,
    });

    expect(unclassified.access).toBe("write");
    expect(unclassified.mcp).toMatchObject({ readOnly: false, destructive: true });
    expect(Read.mcp).toMatchObject({ readOnly: true, destructive: false });
    expect(Write.mcp).toMatchObject({ readOnly: false, destructive: true });
  });

  it("keeps an explicit hint that disagrees, and keeps access without a tool", () => {
    const advertised = Action.make("advertised", {
      description: "A write the model may call without approval",
      access: "write",
      success: Schema.String,
      mcp: { readOnly: true },
    });

    const local = Action.make("local", {
      description: "No tool projection at all",
      access: "read",
      success: Schema.String,
      mcp: false,
    });

    expect(advertised.access).toBe("write");
    expect(advertised.mcp).toMatchObject({ readOnly: true, destructive: false });
    expect(local.access).toBe("read");
    expect(local.mcp).toBe(false);
  });

  it("carries access into the offline catalog", () => {
    expect(ActionCatalog.make(Group).actions.map(({ name, access }) => [name, access])).toEqual([
      ["read", "read"],
      ["write", "write"],
    ]);
  });
});

describe("the pre-handler hook", () => {
  it("runs once before each handler over HTTP and answers as a declared error", async () => {
    const { app, hooks, handlers } = make();
    const web = makeTestHttp(app, readOnly);
    onTestFinished(() => web.dispose());

    const allowed = await web.handler(post("/api/actions/resource/read"));
    expect(allowed.status).toBe(200);
    expect(await allowed.json()).toBe("read ok");

    const refused = await web.handler(post("/api/actions/resource/write"));
    expect(refused.status).toBe(403);
    // The body is the hook's error, encoded by its own schema like a handler's.
    expect(Schema.decodeUnknownSync(InsufficientScope)(await refused.json()).required).toBe(
      "write",
    );

    expect(hooks).toEqual(["read", "write"]);
    expect(handlers).toEqual(["read"]);
  });

  it("runs over MCP, where a refusal is the tool's declared failure", async () => {
    const { app, hooks, handlers } = make();
    const mcp = makeTestMcp(app, readOnly);
    onTestFinished(() => mcp.dispose());

    expect(await (await mcp.handler(mcpCall("read"))).json()).toMatchObject({
      result: { isError: false, structuredContent: { value: "read ok" } },
    });
    expect(await (await mcp.handler(mcpCall("write"))).json()).toMatchObject({
      result: {
        isError: true,
        content: [{ type: "text", text: '{"_tag":"InsufficientScope","required":"write"}' }],
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

            return yield* Stream.runCollect(yield* tools.handle(name, {}));
          }).pipe(Effect.provide(binding.layer), Effect.provide(readOnly)),
        ),
      );

    expect(await call("read")).toMatchObject([{ isFailure: false, result: "read ok" }]);

    const refused = await call("write");
    expect(refused).toMatchObject([{ isFailure: true, result: { required: "write" } }]);
    expect(refused[0]?.result).toBeInstanceOf(InsufficientScope);

    expect(hooks).toEqual(["read", "write"]);
    expect(handlers).toEqual(["read"]);
  });

  it("runs over the CLI, so a local caller supplies its services too", async () => {
    const { app, hooks, handlers } = make();
    const output: string[] = [];

    const run = <Name extends string, Input, Context, E>(
      command: Command.Command<Name, Input, Context, E, Scope.Scope | Scopes>,
    ) =>
      Effect.runPromise(
        Effect.scoped(
          Command.runWith(command, { version: "0" })([]).pipe(
            Effect.provide(cliServices),
            Effect.provide(readOnly),
            Effect.provideService(Console.Console, capturingConsole(output)),
            Effect.exit,
          ),
        ),
      );

    expect((await run(ActionCli.command(app, "read")))._tag).toBe("Success");
    expect(output).toEqual(['"read ok"']);
    expect((await run(ActionCli.command(app, "write")))._tag).toBe("Failure");

    expect(hooks).toEqual(["read", "write"]);
    expect(handlers).toEqual(["read"]);
  });

  it("is skipped by no surface: every action of the group is checked", async () => {
    const { app, hooks } = make();
    const web = makeTestHttp(app, Layer.succeed(Scopes, ["read", "write"]));
    onTestFinished(() => web.dispose());

    expect((await web.handler(post("/api/actions/resource/write"))).status).toBe(200);
    expect(hooks).toEqual(["write"]);
  });
});
