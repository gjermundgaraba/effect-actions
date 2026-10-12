import { Context, Effect, Layer, Option, Schema, Stream } from "effect";
import { Tool } from "effect/ai";
import { expectTypeOf } from "@effect/vitest";
import * as Action from "../../src/contract/Action.js";
import * as ActionToolkit from "../../src/toolkit/ActionToolkit.js";

class Principal extends Context.Service<Principal, string>()("toolkit-types/Principal") {}

const Named = Action.make("named", {
  description: "A named tool.",
  readOnly: false,
  caller: Principal,
  success: Schema.String,
});

const Guarded = Action.make("guarded", {
  description: "Needs a principal.",
  readOnly: false,
  caller: Principal,
  success: Schema.String,
});

const ServiceFree = Action.make("service_free", {
  description: "Does not need a principal.",
  readOnly: false,
  caller: Action.Anyone,
  success: Schema.String,
});

const app = Action.implement(
  [Named, ServiceFree, Guarded],
  {
    named: () => Effect.map(Principal, (principal) => principal),
    service_free: () => Effect.succeed("free"),
    guarded: () => Effect.map(Principal, (principal) => principal),
  },
  { authorize: Action.allowAll },
);

const binding = ActionToolkit.make(app);

expectTypeOf<keyof typeof binding.toolkit.tools>().toEqualTypeOf<
  "named" | "service_free" | "guarded"
>();

const exactNamedSuccess: Tool.Success<typeof binding.toolkit.tools.named> = "principal";

void exactNamedSuccess;

// @ts-expect-error -- Native tool successes retain the action schema's decoded type.
const wrongNamedSuccess: Tool.Success<typeof binding.toolkit.tools.named> = 1;

void wrongNamedSuccess;

class Gone extends Schema.TaggedError<Gone>()("Gone", {}) {}

const Fetch = Action.make("fetch", {
  description: "May be gone.",
  readOnly: true,
  caller: Action.Anyone,
  success: Schema.String,
  error: [Gone],
});

const fetched = ActionToolkit.make(Action.implement(Fetch, () => Effect.succeed("")));

expectTypeOf<Tool.Failure<typeof fetched.toolkit.tools.fetch>>().toEqualTypeOf<
  Gone | Action.BuiltIn
>();

expectTypeOf<Tool.Failure<typeof binding.toolkit.tools.named>>().toEqualTypeOf<Action.BuiltIn>();

class Clock extends Context.Service<Clock, number>()("toolkit-types/Clock") {}

const authorizeReadingClock = ActionToolkit.make(
  Action.implement(Guarded, () => Effect.succeed("guarded"), {
    authorize: () => Effect.flatMap(Clock, () => Effect.void),
  }),
);

expectTypeOf<
  Tool.HandlerServices<typeof authorizeReadingClock.toolkit.tools.guarded>
>().toEqualTypeOf<Clock | Principal>();

export const namedCallOwingPrincipal = Effect.gen(function* () {
  const tools = yield* binding.toolkit;
  const calls = yield* tools.handle("named", {});
  yield* Stream.runDrain(calls);
  // @ts-expect-error -- Tool names are exactly the action names.
  tools.handle("renamed", {});
}).pipe(Effect.provide(binding.layer));

expectTypeOf<Effect.Services<typeof namedCallOwingPrincipal>>().toEqualTypeOf<Principal>();

export const serviceFreeCallUnwidenedBySiblings = Effect.gen(function* () {
  const tools = yield* binding.toolkit;
  const calls = yield* tools.handle("service_free", {});
  yield* Stream.runDrain(calls);
}).pipe(Effect.provide(binding.layer));

expectTypeOf<Effect.Services<typeof serviceFreeCallUnwidenedBySiblings>>().toBeNever();

class LeftBuild extends Context.Service<LeftBuild, string>()("toolkit-types/LeftBuild") {}

const Left = Action.make("left", {
  description: "Left",
  readOnly: false,
  caller: Action.Anyone,
  success: Schema.String,
});

const Right = Action.make("right", {
  description: "Right",
  readOnly: false,
  caller: Action.Anyone,
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

expectTypeOf<Layer.Error<typeof mixed.layer>>().toEqualTypeOf<"right-build">();

expectTypeOf<Layer.Services<typeof mixed.layer>>().toEqualTypeOf<LeftBuild>();

class SharedBuild extends Context.Service<SharedBuild, string>()("toolkit-types/SharedBuild") {}

const sharingOneBuilder = Action.implement(
  [ServiceFree, Guarded],
  Effect.map(SharedBuild, (value) => ({
    service_free: () => Effect.succeed(value),
    guarded: () => Effect.map(Principal, (principal) => principal),
  })),
  { authorize: Action.allowAll },
);

const shared = ActionToolkit.make(sharingOneBuilder);

expectTypeOf<Layer.Error<typeof shared.layer>>().toBeNever();

expectTypeOf<Layer.Services<typeof shared.layer>>().toEqualTypeOf<SharedBuild>();

export const serviceFreeCallOwingOnlyItsOwn = Effect.gen(function* () {
  const tools = yield* shared.toolkit;
  yield* Stream.runDrain(yield* tools.handle("service_free", {}));
}).pipe(Effect.provide(shared.layer.pipe(Layer.provide(Layer.succeed(SharedBuild, "s")))));

expectTypeOf<Effect.Services<typeof serviceFreeCallOwingOnlyItsOwn>>().toBeNever();

export const guardedCallKeepingPrincipal = Effect.gen(function* () {
  const tools = yield* shared.toolkit;
  yield* Stream.runDrain(yield* tools.handle("guarded", {}));
}).pipe(Effect.provide(shared.layer.pipe(Layer.provide(Layer.succeed(SharedBuild, "s")))));

expectTypeOf<Effect.Services<typeof guardedCallKeepingPrincipal>>().toEqualTypeOf<Principal>();

ActionToolkit.make(app, {
  needsApproval: (call) => {
    const name: "named" | "service_free" | "guarded" = call.name;
    const readOnly: false = call.action.readOnly;

    return name === "guarded" && !readOnly;
  },
});

const ruleWrittenApartFromMake = (
  call: ActionToolkit.ToolCall<typeof Named | typeof ServiceFree | typeof Guarded>,
) => {
  if (call.name !== "guarded") return false;
  const action: typeof Guarded = call.action;

  return !action.readOnly;
};

ActionToolkit.make(app, { needsApproval: ruleWrittenApartFromMake });

// @ts-expect-error -- It is a boolean, or an Effect of one.
ActionToolkit.make(app, { needsApproval: () => "yes" });

// @ts-expect-error -- One check over the whole call, not the native function of one tool's input.
ActionToolkit.make(app, { needsApproval: () => () => true });

ActionToolkit.make(app, {
  needsApproval: (_, context) => Effect.succeed(context.toolCallId !== ""),
});

ActionToolkit.make(app, {
  needsApproval: () => Effect.map(Effect.serviceOption(Principal), Option.isNone),
});

// @ts-expect-error -- A check requiring the caller would be a requirement no tool states.
ActionToolkit.make(app, { needsApproval: () => Effect.map(Principal, () => true) });

// @ts-expect-error -- Its Effect cannot fail: a failure would mean no approval needed.
ActionToolkit.make(app, { needsApproval: () => Effect.fail("unavailable") });

const Erase = Action.make("erase", {
  description: "Erase a document.",
  readOnly: false,
  caller: Action.Anyone,
  input: { id: Schema.String, hard: Schema.Boolean },
  success: Schema.String,
});

const eraser = Action.implement(Erase, () => Effect.succeed("erased"));

const Read = Action.make("read", {
  description: "Read a document.",
  readOnly: true,
  caller: Action.Anyone,
  input: { path: Schema.String },
  success: Schema.String,
});

const reader = Action.implement(Read, () => Effect.succeed("read"));

ActionToolkit.make([app, eraser, reader], {
  needsApproval: (call) => {
    if (call.name !== "erase") return call.name === "read" && call.input.path.startsWith("/");

    const hard: boolean = call.input.hard;
    const readOnly: false = call.action.readOnly;

    return hard && !readOnly && call.input.id !== "draft";
  },
});

// @ts-expect-error -- An input field only one action has, unnarrowed.
// oxlint-disable-next-line typescript/no-unsafe-return -- Compile-failure fixture: the rejected field yields an error type; nothing runs.
ActionToolkit.make([reader, eraser], { needsApproval: (call) => call.input.hard });

// @ts-expect-error -- A name no implementation serves.
ActionToolkit.make([reader, eraser], { needsApproval: (call) => call.name === "erased" });

const genericHelperApprovingWrites = <
  const Apps extends Action.AnyImplementation | ReadonlyArray<Action.AnyImplementation>,
>(
  implementations: Apps,
) => ActionToolkit.make(implementations, { needsApproval: (call) => !call.action.readOnly });

expectTypeOf<typeof genericHelperApprovingWrites<[typeof app, typeof eraser]>>().toEqualTypeOf<
  (
    implementations: [typeof app, typeof eraser],
  ) => ReturnType<typeof ActionToolkit.make<[typeof app, typeof eraser]>>
>();

const withApproval = ActionToolkit.make(app, { needsApproval: () => true });

expectTypeOf<typeof withApproval>().toEqualTypeOf<typeof binding>();

const acquiringWithoutOwingScope = ActionToolkit.make(
  Action.implement(
    Named,
    () => Effect.acquireRelease(Effect.succeed("opened"), () => Effect.void),
    {
      authorize: () => Effect.asVoid(Effect.acquireRelease(Effect.void, () => Effect.void)),
    },
  ),
);

expectTypeOf<
  Tool.HandlerServices<typeof acquiringWithoutOwingScope.toolkit.tools.named>
>().toEqualTypeOf<Principal>();

const listed = ActionToolkit.make(app, {
  actions: [ServiceFree, Named],
  needsApproval: (call) => {
    const name: "guarded" | "named" | "service_free" = call.name;

    return name === "named";
  },
});

expectTypeOf<keyof typeof listed.toolkit.tools>().toEqualTypeOf<"named" | "service_free">();

expectTypeOf<typeof listed.toolkit.tools.service_free>().toEqualTypeOf<
  typeof binding.toolkit.tools.service_free
>();

const unlistedImplementationUnbuilt = ActionToolkit.make([left, right], { actions: [Right] });

expectTypeOf<keyof typeof unlistedImplementationUnbuilt.toolkit.tools>().toEqualTypeOf<"right">();

expectTypeOf<Layer.Services<typeof unlistedImplementationUnbuilt.layer>>().toBeNever();

expectTypeOf<
  Layer.Error<typeof unlistedImplementationUnbuilt.layer>
>().toEqualTypeOf<"right-build">();

// @ts-expect-error -- An action none of the implementations holds.
ActionToolkit.make(app, { actions: [Left] });

// @ts-expect-error -- No option `needsAproval`.
ActionToolkit.make(app, { needsAproval: () => true });

// @ts-expect-error -- No option `needsAproval`.
ActionToolkit.make(app, { actions: [Named], needsAproval: () => true });

const erasedApp: Action.AnyImplementation = app;

expectTypeOf<
  Layer.Services<
    ReturnType<
      typeof ActionToolkit.make<typeof erasedApp, { readonly actions: readonly [typeof Named] }>
    >["layer"]
  >
>().toBeUnknown();
