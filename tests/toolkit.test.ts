import { describe, expect, it } from "vite-plus/test";
import { Cause, Context, Effect, Exit, Layer, Schema, Stream } from "effect";
import * as Action from "../src/Action.js";
import * as ActionGroup from "../src/ActionGroup.js";
import * as ActionToolkit from "../src/ActionToolkit.js";

class Principal extends Context.Service<Principal, string>()("toolkit-test/Principal") {}

describe("ActionToolkit", () => {
  it("uses native action schemas/results, aliases MCP names, and excludes disabled tools", async () => {
    const Double = Action.make("double", {
      description: "Double a number.",
      access: "write",
      input: Schema.Struct({ value: Schema.FiniteFromString }),
      success: Schema.Finite,
      mcp: { name: "double_value", readOnly: true },
    });

    const Hidden = Action.make("hidden", {
      description: "Not a tool.",
      access: "write",
      success: Schema.String,
      mcp: false,
    });

    const app = ActionGroup.make({ name: "math" }, Double, Hidden).implement({
      double: ({ value }) => Effect.succeed(value * 2),
      hidden: () => Effect.succeed("hidden"),
    });

    const binding = ActionToolkit.make({}, app);

    expect(Object.keys(binding.toolkit.tools)).toEqual(["double_value"]);

    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const tools = yield* binding.toolkit;
          const calls = yield* tools.handle("double_value", { value: "21" });

          return yield* Stream.runCollect(calls);
        }).pipe(Effect.provide(binding.layer)),
      ),
    );

    expect(result).toMatchObject([{ result: 42, encodedResult: 42, isFailure: false }]);
  });

  it("acquires a multi-tool implementation once and releases it with the layer", async () => {
    let acquired = 0;
    let released = 0;
    const One = Action.make("one", { description: "One", access: "write", success: Schema.Number });
    const Two = Action.make("two", { description: "Two", access: "write", success: Schema.Number });

    const app = ActionGroup.make({ name: "count" }, One, Two).implement(
      Effect.acquireRelease(
        Effect.sync(() => {
          acquired++;

          return { one: () => Effect.succeed(1), two: () => Effect.succeed(2) };
        }),
        () => Effect.sync(() => released++),
      ),
    );

    const binding = ActionToolkit.make({}, app);

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

    const app = ActionGroup.make({ name: "principal" }, Who).implement(
      Effect.sync(() => {
        acquired++;

        return { who: () => Principal };
      }),
    );

    const binding = ActionToolkit.make({}, app);

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
      expect(Cause.pretty(result.anonymous.cause)).toContain(
        "Service not found: toolkit-test/Principal",
      );
    }
  });
});
