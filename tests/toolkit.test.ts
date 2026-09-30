import { describe, expect, it } from "vite-plus/test";
import { Cause, Context, Effect, Exit, Layer, Schema, Stream } from "effect";
import { AiError, LanguageModel, Tool, Toolkit } from "effect/ai";
import * as Action from "../src/Action.js";
import * as ActionToolkit from "../src/ActionToolkit.js";

class Principal extends Context.Service<Principal, string>()("toolkit-test/Principal") {}

describe("ActionToolkit", () => {
  it("marks the tools a model needs approval for, which LanguageModel asks for instead of calling", async () => {
    const calls: string[] = [];

    const input = { id: Schema.String };

    const Read = Action.make("read", {
      description: "Read",
      access: "read",
      input,
      success: Schema.String,
    });

    const Erase = Action.make("erase", {
      description: "Erase",
      access: "write",
      input,
      success: Schema.String,
    });

    const app = Action.implement(
      [Read, Erase],
      {
        read: ({ id }) => Effect.sync(() => (calls.push(`read ${id}`), "read")),
        erase: ({ id }) => Effect.sync(() => (calls.push(`erase ${id}`), "erased")),
      },
      Action.allowAll,
    );

    // A write needs approval, except of a draft: the native function of each call's input.
    const binding = ActionToolkit.make(app, {
      needsApproval: (action) => action.access === "write" && (({ id }) => id !== "draft"),
    });

    expect(binding.toolkit.tools.read.needsApproval).toBe(false);
    // No tool needs approval unless the host says so: the native tool's own default.
    expect(ActionToolkit.make(app).toolkit.tools.erase.needsApproval).toBeUndefined();

    // A model that calls the tools at once.
    const model = LanguageModel.make({
      generateText: () =>
        Effect.succeed([
          { type: "tool-call", id: "1", name: "read", params: { id: "a" } },
          { type: "tool-call", id: "2", name: "erase", params: { id: "draft" } },
          { type: "tool-call", id: "3", name: "erase", params: { id: "final" } },
        ] as const),
      streamText: () => Stream.empty,
    });

    const response = await Effect.runPromise(
      Effect.scoped(
        LanguageModel.generateText({ prompt: "go", toolkit: binding.toolkit }).pipe(
          Effect.provide(binding.layer),
          Effect.provideServiceEffect(LanguageModel.LanguageModel, model),
        ),
      ),
    );

    expect(response.content.filter((part) => part.type === "tool-approval-request")).toMatchObject([
      { toolCallId: "3" },
    ]);
    expect(response.toolResults).toMatchObject([
      { name: "read", result: "read" },
      { name: "erase", result: "erased" },
    ]);
    expect(calls).toEqual(["read a", "erase draft"]);
  });

  it("decodes with the action's schemas, returns native results, and names tools after actions", async () => {
    const Double = Action.make("double", {
      description: "Double a number.",
      access: "write",
      input: Schema.Struct({ value: Schema.FiniteFromString }),
      success: Schema.Finite,
    });

    const double = Action.implement(
      Double,
      ({ value }) => Effect.succeed(value * 2),
      Action.allowAll,
    );

    const binding = ActionToolkit.make(double);

    expect(Object.keys(binding.toolkit.tools)).toEqual(["double"]);

    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const tools = yield* binding.toolkit;
          const calls = yield* tools.handle("double", { value: "21" });

          return yield* Stream.runCollect(calls);
        }).pipe(Effect.provide(binding.layer)),
      ),
    );

    expect(result).toMatchObject([{ result: 42, encodedResult: 42, isFailure: false }]);
  });

  it("takes and gives each tool's JSON encoding, as a model speaks, and decodes it for the handler", async () => {
    const received: unknown[] = [];

    const Schedule = Action.make("schedule", {
      description: "Schedule a reminder.",
      access: "write",
      input: { at: Schema.Date, note: Schema.optional(Schema.String) },
      success: Schema.BigInt,
    });

    const binding = ActionToolkit.make(
      Action.implement(
        Schedule,
        (input) =>
          Effect.sync(() => {
            received.push(input);

            return 42n;
          }),
        Action.allowAll,
      ),
    );

    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const tools = yield* binding.toolkit;

          return yield* Stream.runCollect(
            yield* tools.handle("schedule", { at: "2026-09-29T00:00:00.000Z", note: null }),
          );
        }).pipe(Effect.provide(binding.layer)),
      ),
    );

    expect(received).toEqual([{ at: new Date("2026-09-29T00:00:00.000Z"), note: undefined }]);
    expect(result).toMatchObject([{ result: 42n, encodedResult: "42", isFailure: false }]);
    expect(JSON.stringify(result[0]?.encodedResult)).toBe('"42"');
  });

  it("returns a declared error as the tool's failure, its own value", async () => {
    class NotFound extends Schema.TaggedError<NotFound>()("NotFound", { id: Schema.String }) {}

    const Find = Action.make("find", {
      description: "Find a note.",
      access: "read",
      input: { id: Schema.String },
      success: Schema.String,
      errors: [NotFound],
    });

    const binding = ActionToolkit.make(
      Action.implement(Find, ({ id }) => Effect.fail(new NotFound({ id })), Action.allowAll),
    );

    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const tools = yield* binding.toolkit;

          return yield* Stream.runCollect(yield* tools.handle("find", { id: "n1" }));
        }).pipe(Effect.provide(binding.layer)),
      ),
    );

    const notFound = new NotFound({ id: "n1" });

    expect(result).toMatchObject([
      { result: notFound, encodedResult: Schema.encodeSync(NotFound)(notFound) },
    ]);
    expect(result[0]?.isFailure).toBe(true);
  });

  it("returns arguments that do not decode as a parameter failure, running neither hook nor handler", async () => {
    const ran: string[] = [];

    const Echo = Action.make("echo", {
      description: "Echo a number.",
      access: "read",
      input: { value: Schema.Finite },
      success: Schema.Finite,
    });

    const binding = ActionToolkit.make(
      Action.implement(
        Echo,
        ({ value }) => Effect.sync(() => (ran.push("handler"), value)),
        () => Effect.sync(() => void ran.push("hook")),
      ),
    );

    const [returned] = await Effect.runPromise(
      Effect.scoped(
        Effect.flatMap(binding.toolkit, (tools) =>
          Effect.flatMap(tools.handle("echo", { value: "one" }), Stream.runCollect),
        ).pipe(Effect.provide(binding.layer)),
      ),
    );

    expect(returned).toMatchObject({ isFailure: true, failureOrigin: "parameters" });
    expect(AiError.isAiError(returned?.result) && returned.result.reason._tag).toBe(
      "ToolParameterValidationError",
    );
    expect(ran).toEqual([]);
  });

  it("fills in an identity provided to layer for a call without one; a call's own wins", async () => {
    const Who = Action.make("who", {
      description: "Current principal",
      access: "read",
      success: Schema.String,
    });

    const binding = ActionToolkit.make(Action.implement(Who, () => Principal, Action.allowAll));

    // What the docs warn against: an identity provided at startup.
    const startup = binding.layer.pipe(Layer.provide(Layer.succeed(Principal, "startup")));

    const call = Effect.flatMap(binding.toolkit, (tools) =>
      Effect.flatMap(tools.handle("who", {}), Stream.runCollect),
    );

    const [own, lacking] = await Effect.runPromise(
      // @ts-expect-error The second call lacks the Principal its tool requires.
      Effect.scoped(
        Effect.all([call.pipe(Effect.provideService(Principal, "caller")), call]).pipe(
          Effect.provide(startup),
        ),
      ),
    );

    expect(own).toMatchObject([{ result: "caller" }]);
    expect(lacking).toMatchObject([{ result: "startup" }]);
  });

  it("keeps each toolkit's handlers its own beside another with tools of the same names", async () => {
    const Secret = Action.make("secret", {
      description: "A secret.",
      access: "read",
      success: Schema.String,
    });

    const guarded = Action.implement(
      Secret,
      () => Effect.succeed("secret"),
      () => Effect.fail(new Action.Forbidden()),
    );

    // The same action behind a hook letting everyone through.
    const guardedTools = ActionToolkit.make(guarded);
    const openTools = ActionToolkit.make(Action.share(Secret, guarded, Action.allowAll));

    // Merged either way, each toolkit runs its own implementation's hook.
    for (const layers of [
      Layer.mergeAll(guardedTools.layer, openTools.layer),
      Layer.mergeAll(openTools.layer, guardedTools.layer),
    ]) {
      const [refused, answered] = await Effect.runPromise(
        Effect.scoped(
          Effect.forEach([guardedTools, openTools], ({ toolkit }) =>
            Effect.flatMap(toolkit, (handled) =>
              Effect.flatMap(handled.handle("secret", {}), Stream.runCollect),
            ),
          ).pipe(Effect.provide(layers)),
        ),
      );

      expect(refused).toMatchObject([{ isFailure: true }]);
      expect(answered).toMatchObject([{ isFailure: false, result: "secret" }]);
    }
  });

  it("merges with native tools into one toolkit a model calls", async () => {
    const Double = Action.make("double", {
      description: "Double a number.",
      access: "read",
      input: { value: Schema.Finite },
      success: Schema.Finite,
    });

    const actions = ActionToolkit.make(
      Action.implement(Double, ({ value }) => Effect.succeed(value * 2), Action.allowAll),
    );

    const Now = Tool.make("now", { success: Schema.Finite });
    const native = Toolkit.make(Now);

    const model = LanguageModel.make({
      generateText: () =>
        Effect.succeed([
          { type: "tool-call", id: "1", name: "double", params: { value: 21 } },
          { type: "tool-call", id: "2", name: "now", params: {} },
        ] as const),
      streamText: () => Stream.empty,
    });

    const response = await Effect.runPromise(
      Effect.scoped(
        LanguageModel.generateText({
          prompt: "go",
          toolkit: Toolkit.merge(actions.toolkit, native),
        }).pipe(
          Effect.provide(
            Layer.mergeAll(actions.layer, native.toLayer({ now: () => Effect.succeed(7) })),
          ),
          Effect.provideServiceEffect(LanguageModel.LanguageModel, model),
        ),
      ),
    );

    expect(response.toolResults).toMatchObject([
      { name: "double", result: 42 },
      { name: "now", result: 7 },
    ]);
  });

  it("releases a builder's resources with the layer", async () => {
    let acquired = 0;
    let released = 0;
    const One = Action.make("one", { description: "One", access: "write", success: Schema.Number });
    const Two = Action.make("two", { description: "Two", access: "write", success: Schema.Number });

    const app = Action.implement(
      [One, Two],
      Effect.acquireRelease(
        Effect.sync(() => {
          acquired++;

          return { one: () => Effect.succeed(1), two: () => Effect.succeed(2) };
        }),
        () => Effect.sync(() => released++),
      ),
      Action.allowAll,
    );

    const binding = ActionToolkit.make(app);

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const tools = yield* binding.toolkit;
          const calls = yield* tools.handle("two", {});
          yield* Stream.runDrain(calls);
          expect(acquired).toBe(1);
        }).pipe(Effect.provide(binding.layer)),
      ),
    );

    expect(released).toBe(1);
  });

  it("resolves a native tool's principal per invocation from one shared handler layer", async () => {
    const Who = Action.make("who", {
      description: "Current principal",
      access: "write",
      success: Schema.String,
    });

    let acquired = 0;

    const app = Action.implement(
      Who,
      Effect.sync(() => {
        acquired++;

        return () => Principal;
      }),
      Action.allowAll,
    );

    const binding = ActionToolkit.make(app);

    const result = await Effect.runPromise(
      // @ts-expect-error Deliberately omit Principal to verify it cannot leak from another invocation.
      Effect.scoped(
        Effect.gen(function* () {
          // Build handler resources once, without an invocation principal.
          const services = yield* Layer.build(binding.layer);
          expect(acquired).toBe(1);

          const call = (principal: string) =>
            Effect.gen(function* () {
              const tools = yield* binding.toolkit;
              const stream = yield* tools.handle("who", {});

              return yield* Stream.runCollect(stream);
            }).pipe(Effect.provide(services), Effect.provideService(Principal, principal));

          const [alice, bob] = yield* Effect.all([call("alice"), call("bob")], {
            concurrency: "unbounded",
          });

          const anonymous = yield* Effect.exit(
            Effect.gen(function* () {
              const tools = yield* binding.toolkit;
              const stream = yield* tools.handle("who", {});

              return yield* Stream.runCollect(stream);
            }).pipe(Effect.provide(services)),
          );

          return { alice, bob, anonymous };
        }),
      ),
    );

    expect(result.alice).toMatchObject([{ result: "alice" }]);
    expect(result.bob).toMatchObject([{ result: "bob" }]);
    expect(acquired).toBe(1);
    expect(Exit.isFailure(result.anonymous)).toBe(true);

    if (Exit.isFailure(result.anonymous)) {
      expect(Cause.pretty(result.anonymous.cause)).toContain("toolkit-test/Principal");
    }
  });
});
