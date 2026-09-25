// Compile-only native Toolkit assertions, included by `vp check`.
import { Context, Effect, Layer, Schema, Stream } from "effect";
import { Tool } from "effect/unstable/ai";
import * as Action from "../src/Action.js";
import * as ActionToolkit from "../src/ActionToolkit.js";
import type { Equal } from "./equal.js";

class Principal extends Context.Service<Principal, string>()("toolkit-types/Principal") {}

const Named = Action.make("named", {
  description: "A read-only tool.",
  access: "write",
  success: Schema.String,
  hints: { readOnly: true },
});

const Guarded = Action.make("guarded", {
  description: "Needs a principal.",
  access: "write",
  success: Schema.String,
});

const ServiceFree = Action.make("service_free", {
  description: "Does not need a principal.",
  access: "write",
  success: Schema.String,
});

const app = Action.implement([Named, ServiceFree, Guarded], {
  named: () => Effect.map(Principal, (principal) => principal),
  service_free: () => Effect.succeed("free"),
  guarded: () => Effect.map(Principal, (principal) => principal),
});

const binding = ActionToolkit.make(app);

// Every action is a tool, named after it.
const toolNames: [keyof typeof binding.toolkit.tools] extends ["named" | "service_free" | "guarded"]
  ? ["named" | "service_free" | "guarded"] extends [keyof typeof binding.toolkit.tools]
    ? true
    : false
  : false = true;

void toolNames;

const exactNamedSuccess: Tool.Success<typeof binding.toolkit.tools.named> = "principal";

void exactNamedSuccess;

// @ts-expect-error Native tool successes retain the action schema's decoded type.
const wrongNamedSuccess: Tool.Success<typeof binding.toolkit.tools.named> = 1;

void wrongNamedSuccess;

class Gone extends Schema.TaggedError<Gone>()("Gone", {}) {}

const Fetch = Action.make("fetch", {
  description: "May be gone.",
  access: "read",
  success: Schema.String,
  errors: [Gone],
});

const fetched = ActionToolkit.make(Action.implement(Fetch, () => Effect.succeed(""))).toolkit;

// Every tool declares its action's errors plus the refusals a `before` hook may fail with.
const toolFailures: [
  Equal<Tool.Failure<typeof fetched.tools.fetch>, Gone | Action.Unauthenticated | Action.Forbidden>,
  Equal<Tool.Failure<typeof binding.toolkit.tools.named>, Action.Refusal>,
] = [true, true];

void toolFailures;

class Clock extends Context.Service<Clock, number>()("toolkit-types/Clock") {}

class Unrelated extends Schema.TaggedError<Unrelated>()("Unrelated", {}) {}

// The hook fails only with a refusal, and its services are owed by every call.
const hooked = ActionToolkit.make(app, {
  before: (action) =>
    Effect.flatMap(Clock, () =>
      action.access === "read" ? Effect.void : Effect.fail(new Action.Forbidden()),
    ),
});

const hookedServices: Equal<
  Tool.HandlerServices<typeof hooked.toolkit.tools.service_free>,
  Clock
> = true;

void hookedServices;

// @ts-expect-error A hook may not fail with anything but a refusal.
ActionToolkit.make(app, { before: () => Effect.fail(new Unrelated()) });

export const toolkitTypes = Effect.gen(function* () {
  const tools = yield* binding.toolkit;
  const calls = yield* tools.handle("named", {});
  yield* Stream.runDrain(calls);
  // @ts-expect-error Tool names are exactly the action names.
  tools.handle("renamed", {});
}).pipe(Effect.provide(binding.layer));

toolkitTypes satisfies Effect.Effect<unknown, unknown, Principal>;

// @ts-expect-error Running the returned stream retains the handler's per-call principal.
toolkitTypes satisfies Effect.Effect<unknown, unknown, never>;

/** A service-free tool is not widened by sibling handlers of the same implementation. */
export const serviceFreeToolkitCall = Effect.gen(function* () {
  const tools = yield* binding.toolkit;
  const calls = yield* tools.handle("service_free", {});
  yield* Stream.runDrain(calls);
}).pipe(Effect.provide(binding.layer));

serviceFreeToolkitCall satisfies Effect.Effect<unknown, unknown, never>;

class LeftBuild extends Context.Service<LeftBuild, string>()("toolkit-types/LeftBuild") {}

const Left = Action.make("left", { description: "Left", access: "write", success: Schema.String });

const Right = Action.make("right", {
  description: "Right",
  access: "write",
  success: Schema.Number,
});

const left = Action.implement(
  Left,
  Effect.map(LeftBuild, (value) => () => Effect.succeed(value)),
);

const right = Action.implement(
  Right,
  Effect.fail("right-build" as const).pipe(Effect.as(() => Effect.succeed(1))),
);

const mixed = ActionToolkit.make([left, right]);

const mixedBuild = Effect.scoped(Layer.build(mixed.layer));

// The public layer retains both independently declared acquisition channels.
mixedBuild satisfies Effect.Effect<unknown, "right-build", LeftBuild>;

const mixedWithLeft = mixedBuild.pipe(Effect.provideService(LeftBuild, "left"));

mixedWithLeft satisfies Effect.Effect<unknown, "right-build", never>;

class SharedBuild extends Context.Service<SharedBuild, string>()("toolkit-types/SharedBuild") {}

// Two actions sharing one builder: the builder is a startup requirement of the toolkit...
const sharing = Action.implement(
  [ServiceFree, Guarded],
  Effect.map(SharedBuild, (value) => ({
    service_free: () => Effect.succeed(value),
    guarded: () => Effect.map(Principal, (principal) => principal),
  })),
);

const shared = ActionToolkit.make(sharing);

Effect.scoped(Layer.build(shared.layer)) satisfies Effect.Effect<unknown, never, SharedBuild>;

// @ts-expect-error The builder is a startup requirement, not erased.
Effect.scoped(Layer.build(shared.layer)) satisfies Effect.Effect<unknown, never, never>;

// ...while each tool owes only its own handler's per-call services.
export const sharedCall = Effect.gen(function* () {
  const tools = yield* shared.toolkit;
  yield* Stream.runDrain(yield* tools.handle("service_free", {}));
}).pipe(Effect.provide(shared.layer.pipe(Layer.provide(Layer.succeed(SharedBuild, "s")))));

sharedCall satisfies Effect.Effect<unknown, unknown, never>;

export const guardedCall = Effect.gen(function* () {
  const tools = yield* shared.toolkit;
  yield* Stream.runDrain(yield* tools.handle("guarded", {}));
}).pipe(Effect.provide(shared.layer.pipe(Layer.provide(Layer.succeed(SharedBuild, "s")))));

guardedCall satisfies Effect.Effect<unknown, unknown, Principal>;

// @ts-expect-error The guarded tool keeps its principal.
guardedCall satisfies Effect.Effect<unknown, unknown, never>;
