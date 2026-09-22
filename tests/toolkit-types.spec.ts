// Compile-only native Toolkit assertions, included by `vp check`.
import { Context, Effect, Layer, Schema, Stream } from "effect";
import { Tool } from "effect/unstable/ai";
import * as Action from "../src/Action.js";
import * as ActionGroup from "../src/ActionGroup.js";
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

const app = ActionGroup.make({ name: "types" }, Aliased, ServiceFree, Hidden).implement({
  original: () => Effect.map(Principal, (principal) => principal),
  service_free: () => Effect.succeed("free"),
  hidden: () => Effect.map(Principal, (principal) => principal),
});

const binding = ActionToolkit.make([app]);

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

const left = ActionGroup.make({ name: "left" }, Left).implement(
  Effect.map(LeftBuild, (value) => ({ left: () => Effect.succeed(value) })),
);

const right = ActionGroup.make({ name: "right" }, Right).implement(
  Effect.fail("right-build" as const).pipe(Effect.as({ right: () => Effect.succeed(1) })),
);

const mixed = ActionToolkit.make([left, right]);

const mixedBuild = Effect.scoped(Layer.build(mixed.layer));

// The public layer retains both independently declared acquisition channels.
mixedBuild satisfies Effect.Effect<unknown, "right-build", LeftBuild>;

const mixedWithLeft = mixedBuild.pipe(Effect.provideService(LeftBuild, "left"));

mixedWithLeft satisfies Effect.Effect<unknown, "right-build", never>;
