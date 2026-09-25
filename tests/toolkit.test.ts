import { describe, expect, it } from "vite-plus/test";
import { Cause, Context, Effect, Exit, Layer, Schema, Stream } from "effect";
import * as Action from "../src/Action.js";
import * as ActionToolkit from "../src/ActionToolkit.js";

class Principal extends Context.Service<Principal, string>()("toolkit-test/Principal") {}

describe("ActionToolkit", () => {
  it("uses native action schemas/results, and names tools after actions", async () => {
    const Double = Action.make("double", {
      description: "Double a number.",
      access: "write",
      input: Schema.Struct({ value: Schema.FiniteFromString }),
      success: Schema.Finite,
      hints: { readOnly: true },
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

  it("returns a before hook's refusal as the tool's failure, without running the handler", async () => {
    const Read = Action.make("read", {
      description: "Read",
      access: "read",
      success: Schema.String,
    });

    const Write = Action.make("write", {
      description: "Write",
      access: "write",
      success: Schema.String,
    });

    const ran: Array<string> = [];

    const run = (name: string) =>
      Effect.sync(() => {
        ran.push(name);

        return name;
      });

    const app = Action.implement([Read, Write], {
      read: () => run("read"),
      write: () => run("write"),
    });

    const binding = ActionToolkit.make(app, {
      before: (action) =>
        action.access === "read"
          ? Effect.void
          : Effect.fail(new Action.Forbidden({ message: "Read only." })),
    });

    const [read, write] = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const tools = yield* binding.toolkit;

          return yield* Effect.all(
            (["read", "write"] as const).map((name) =>
              Effect.flatMap(tools.handle(name, {}), Stream.runCollect),
            ),
          );
        }).pipe(Effect.provide(binding.layer)),
      ),
    );

    expect(read).toMatchObject([{ result: "read", isFailure: false }]);
    const refusal = new Action.Forbidden({ message: "Read only." });

    expect(write).toMatchObject([
      {
        result: refusal,
        encodedResult: Schema.encodeSync(Action.Forbidden)(refusal),
        isFailure: true,
      },
    ]);
    expect(ran).toEqual(["read"]);
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
      expect(Cause.pretty(result.anonymous.cause)).toContain(
        "Service not found: toolkit-test/Principal",
      );
    }
  });
});
