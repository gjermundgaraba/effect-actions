import { describe, expect, it } from "vite-plus/test";
import { Cause, Context, Effect, Exit, Layer, Schema, Stream } from "effect";
import { LanguageModel } from "effect/unstable/ai";
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

    const app = Action.implement([Read, Erase], {
      read: ({ id }) => Effect.sync(() => (calls.push(`read ${id}`), "read")),
      erase: ({ id }) => Effect.sync(() => (calls.push(`erase ${id}`), "erased")),
    });

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

  it("uses native action schemas/results, and names tools after actions", async () => {
    const Double = Action.make("double", {
      description: "Double a number.",
      access: "write",
      input: Schema.Struct({ value: Schema.FiniteFromString }),
      success: Schema.Finite,
    });

    const double = Action.implement(Double, ({ value }) => Effect.succeed(value * 2));

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
      Action.implement(Find, ({ id }) => Effect.fail(new NotFound({ id }))),
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
