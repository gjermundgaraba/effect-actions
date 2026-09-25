// Compile-only native Toolkit assertions, included by `vp check`.
import { Context, Effect, Layer, Schema, Stream } from "effect";
import { Tool } from "effect/unstable/ai";
import * as Action from "../src/Action.js";
import * as ActionToolkit from "../src/ActionToolkit.js";

class Principal extends Context.Service<Principal, string>()("toolkit-types/Principal") {}

const Aliased = Action.make("original", {
  description: "An aliased tool.",
  access: "write",
  success: Schema.String,
  mcp: { name: "alias", readOnly: true },
});

const Hidden = Action.make("hidden", {
  description: "Not exposed to tools.",
  access: "write",
  success: Schema.String,
  mcp: false,
});

const ServiceFree = Action.make("service_free", {
  description: "Does not need a principal.",
  access: "write",
  success: Schema.String,
});

const app = Action.implement([Aliased, ServiceFree, Hidden], {
  original: () => Effect.map(Principal, (principal) => principal),
  service_free: () => Effect.succeed("free"),
  hidden: () => Effect.map(Principal, (principal) => principal),
});

const binding = ActionToolkit.make(app);

const exactAliasSuccess: Tool.Success<typeof binding.toolkit.tools.alias> = "principal";

void exactAliasSuccess;

// @ts-expect-error Native tool successes retain the action schema's decoded type.
const wrongAliasSuccess: Tool.Success<typeof binding.toolkit.tools.alias> = 1;

void wrongAliasSuccess;

export const toolkitTypes = Effect.gen(function* () {
  const tools = yield* binding.toolkit;
  const calls = yield* tools.handle("alias", {});
  yield* Stream.runDrain(calls);
  // @ts-expect-error Tool names use `mcp.name`, not the action name.
  tools.handle("original", {});
  // @ts-expect-error Tool-disabled actions are absent.
  tools.handle("hidden", {});
}).pipe(Effect.provide(binding.layer));

toolkitTypes satisfies Effect.Effect<unknown, unknown, Principal>;

// @ts-expect-error Running the returned stream retains the handler's per-call principal.
toolkitTypes satisfies Effect.Effect<unknown, unknown, never>;

/** A service-free tool is not widened by active or hidden sibling handlers. */
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

const mixed = ActionToolkit.make([...left, ...right]);

const mixedBuild = Effect.scoped(Layer.build(mixed.layer));

// The public layer retains both independently declared acquisition channels.
mixedBuild satisfies Effect.Effect<unknown, "right-build", LeftBuild>;

const mixedWithLeft = mixedBuild.pipe(Effect.provideService(LeftBuild, "left"));

mixedWithLeft satisfies Effect.Effect<unknown, "right-build", never>;

class SharedBuild extends Context.Service<SharedBuild, string>()("toolkit-types/SharedBuild") {}

// A hidden action sharing its builder with a visible one: the builder is still acquired.
const sharing = Action.implement(
  [ServiceFree, Hidden],
  Effect.map(SharedBuild, (value) => ({
    service_free: () => Effect.succeed(value),
    hidden: () => Effect.map(Principal, (principal) => principal),
  })),
);

const shared = ActionToolkit.make(sharing);

Effect.scoped(Layer.build(shared.layer)) satisfies Effect.Effect<unknown, never, SharedBuild>;

// @ts-expect-error The visible action's builder is a startup requirement, not erased.
Effect.scoped(Layer.build(shared.layer)) satisfies Effect.Effect<unknown, never, never>;

// ...while the hidden handler's per-call principal is absent: it has no tool.
export const sharedCall = Effect.gen(function* () {
  const tools = yield* shared.toolkit;
  yield* Stream.runDrain(yield* tools.handle("service_free", {}));
}).pipe(Effect.provide(shared.layer.pipe(Layer.provide(Layer.succeed(SharedBuild, "s")))));

sharedCall satisfies Effect.Effect<unknown, unknown, never>;

// A builder that serves only a hidden action is never acquired.
const hiddenOnly = ActionToolkit.make(
  Action.implement(
    Hidden,
    Effect.map(SharedBuild, () => () => Effect.succeed("")),
  ),
);

Effect.scoped(Layer.build(hiddenOnly.layer)) satisfies Effect.Effect<unknown, never, never>;
