// Compile-only native Toolkit assertions, included by `vp check`.
import { Context, Effect, Layer, Option, Schema, Stream } from "effect";
import { Tool } from "effect/ai";
import { expectTypeOf } from "@effect/vitest";
import * as Action from "../src/Action.js";
import * as ActionToolkit from "../src/ActionToolkit.js";

class Principal extends Context.Service<Principal, string>()("toolkit-types/Principal") {}

const Named = Action.make("named", {
  description: "A named tool.",
  access: "write",
  success: Schema.String,
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

const app = Action.implement(
  [Named, ServiceFree, Guarded],
  {
    named: () => Effect.map(Principal, (principal) => principal),
    service_free: () => Effect.succeed("free"),
    guarded: () => Effect.map(Principal, (principal) => principal),
  },
  Action.allowAll,
);

const binding = ActionToolkit.make(app);

// Every action is a tool, named after it.
expectTypeOf<keyof typeof binding.toolkit.tools>().toEqualTypeOf<
  "named" | "service_free" | "guarded"
>();

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

const fetched = ActionToolkit.make(
  Action.implement(Fetch, () => Effect.succeed(""), Action.allowAll),
);

// Every tool declares its action's errors plus the built-in ones.
expectTypeOf<Tool.Failure<typeof fetched.toolkit.tools.fetch>>().toEqualTypeOf<
  Gone | Action.BuiltIn
>();

expectTypeOf<Tool.Failure<typeof binding.toolkit.tools.named>>().toEqualTypeOf<Action.BuiltIn>();

class Clock extends Context.Service<Clock, number>()("toolkit-types/Clock") {}

// A hook's services are owed by every call.
const hooked = ActionToolkit.make(
  Action.implement(
    ServiceFree,
    () => Effect.succeed("free"),
    () => Effect.flatMap(Clock, () => Effect.void),
  ),
);

expectTypeOf<
  Tool.HandlerServices<typeof hooked.toolkit.tools.service_free>
>().toEqualTypeOf<Clock>();

export const toolkitTypes = Effect.gen(function* () {
  const tools = yield* binding.toolkit;
  const calls = yield* tools.handle("named", {});
  yield* Stream.runDrain(calls);
  // @ts-expect-error Tool names are exactly the action names.
  tools.handle("renamed", {});
}).pipe(Effect.provide(binding.layer));

// Running the returned stream retains the handler's per-call principal.
expectTypeOf<Effect.Services<typeof toolkitTypes>>().toEqualTypeOf<Principal>();

/** A service-free tool is not widened by sibling handlers of the same implementation. */
export const serviceFreeToolkitCall = Effect.gen(function* () {
  const tools = yield* binding.toolkit;
  const calls = yield* tools.handle("service_free", {});
  yield* Stream.runDrain(calls);
}).pipe(Effect.provide(binding.layer));

expectTypeOf<Effect.Services<typeof serviceFreeToolkitCall>>().toBeNever();

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
  Action.allowAll,
);

const right = Action.implement(
  Right,
  Effect.fail("right-build" as const).pipe(Effect.as(() => Effect.succeed(1))),
  Action.allowAll,
);

const mixed = ActionToolkit.make([left, right]);

// The public layer retains both independently declared acquisition channels.
expectTypeOf<Layer.Error<typeof mixed.layer>>().toEqualTypeOf<"right-build">();

expectTypeOf<Layer.Services<typeof mixed.layer>>().toEqualTypeOf<LeftBuild>();

class SharedBuild extends Context.Service<SharedBuild, string>()("toolkit-types/SharedBuild") {}

// Two actions sharing one builder: the builder is a startup requirement of the toolkit...
const sharing = Action.implement(
  [ServiceFree, Guarded],
  Effect.map(SharedBuild, (value) => ({
    service_free: () => Effect.succeed(value),
    guarded: () => Effect.map(Principal, (principal) => principal),
  })),
  Action.allowAll,
);

const shared = ActionToolkit.make(sharing);

expectTypeOf<Layer.Error<typeof shared.layer>>().toBeNever();

expectTypeOf<Layer.Services<typeof shared.layer>>().toEqualTypeOf<SharedBuild>();

// ...while each tool owes only its own handler's per-call services.
export const sharedCall = Effect.gen(function* () {
  const tools = yield* shared.toolkit;
  yield* Stream.runDrain(yield* tools.handle("service_free", {}));
}).pipe(Effect.provide(shared.layer.pipe(Layer.provide(Layer.succeed(SharedBuild, "s")))));

expectTypeOf<Effect.Services<typeof sharedCall>>().toBeNever();

export const guardedCall = Effect.gen(function* () {
  const tools = yield* shared.toolkit;
  yield* Stream.runDrain(yield* tools.handle("guarded", {}));
}).pipe(Effect.provide(shared.layer.pipe(Layer.provide(Layer.succeed(SharedBuild, "s")))));

// The guarded tool keeps its principal.
expectTypeOf<Effect.Services<typeof guardedCall>>().toEqualTypeOf<Principal>();

// `needsApproval` reads each call of the implementations' own actions, as `before` reads them.
ActionToolkit.make(app, {
  needsApproval: (call) => {
    const name: "named" | "service_free" | "guarded" = call.name;
    const access: "write" = call.action.access;

    return name === "guarded" && access === "write";
  },
});

// @ts-expect-error It is a boolean, or an Effect of one.
ActionToolkit.make(app, { needsApproval: () => "yes" });

// @ts-expect-error One check over the whole call, not the native function of one tool's input.
ActionToolkit.make(app, { needsApproval: () => () => true });

// The Effect form, with Effect's native approval context.
ActionToolkit.make(app, {
  needsApproval: (_, context) => Effect.succeed(context.toolCallId !== ""),
});

// The check requires nothing: it reads the caller with `Effect.serviceOption`.
ActionToolkit.make(app, {
  needsApproval: () => Effect.map(Effect.serviceOption(Principal), Option.isNone),
});

// @ts-expect-error A check requiring the caller would be a requirement no tool states.
ActionToolkit.make(app, { needsApproval: () => Effect.map(Principal, () => true) });

// @ts-expect-error Its Effect cannot fail: a failure would mean no approval needed.
ActionToolkit.make(app, { needsApproval: () => Effect.fail("unavailable") });

const Erase = Action.make("erase", {
  description: "Erase a document.",
  access: "write",
  input: { id: Schema.String, hard: Schema.Boolean },
  success: Schema.String,
});

const eraser = Action.implement(Erase, () => Effect.succeed("erased"), Action.allowAll);

const Read = Action.make("read", {
  description: "Read a document.",
  access: "read",
  input: { path: Schema.String },
  success: Schema.String,
});

const reader = Action.implement(Read, () => Effect.succeed("read"), Action.allowAll);

// Across several implementations, a call's name narrows its input and its action.
ActionToolkit.make([app, eraser, reader], {
  needsApproval: (call) => {
    if (call.name !== "erase") return call.name === "read" && call.input.path.startsWith("/");

    const hard: boolean = call.input.hard;
    const access: "write" = call.action.access;

    return hard && access === "write" && call.input.id !== "draft";
  },
});

// @ts-expect-error An input field only one action has, unnarrowed.
// oxlint-disable-next-line typescript/no-unsafe-return -- Compile-failure fixture: the rejected field yields an error type; nothing runs.
ActionToolkit.make([reader, eraser], { needsApproval: (call) => call.input.hard });

// @ts-expect-error A name no implementation serves.
ActionToolkit.make([reader, eraser], { needsApproval: (call) => call.name === "erased" });

// A helper generic over implementations states a policy every call's action reads, and
// keeps each tool's type.
const writesApproved = <
  const Apps extends Action.AnyImplementation | ReadonlyArray<Action.AnyImplementation>,
>(
  implementations: Apps,
) =>
  ActionToolkit.make(implementations, { needsApproval: (call) => call.action.access === "write" });

expectTypeOf<typeof writesApproved<[typeof app, typeof eraser]>>().toEqualTypeOf<
  (
    implementations: [typeof app, typeof eraser],
  ) => ReturnType<typeof ActionToolkit.make<[typeof app, typeof eraser]>>
>();

// Approval changes no tool's type or requirements.
const approved = ActionToolkit.make(app, { needsApproval: () => true });

expectTypeOf<typeof approved>().toEqualTypeOf<typeof binding>();

// Each call has a scope of its own: what a hook or a handler acquires never asks its caller
// for a `Scope`.
const scoped = ActionToolkit.make(
  Action.implement(
    Named,
    () => Effect.acquireRelease(Effect.succeed("opened"), () => Effect.void),
    () => Effect.asVoid(Effect.acquireRelease(Effect.void, () => Effect.void)),
  ),
);

expectTypeOf<Tool.HandlerServices<typeof scoped.toolkit.tools.named>>().toBeNever();
