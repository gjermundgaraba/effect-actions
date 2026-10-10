import { expect, it } from "@effect/vitest";
import { Cause, Effect, Exit, Layer, Option, References, Schema, Stream, Struct } from "effect";
import { RpcClient, RpcSerialization, RpcServer } from "effect/rpc";
import * as Action from "../../src/contract/Action.js";
import * as ActionHttp from "../../src/http/ActionHttp.js";
import * as ActionMcp from "../../src/mcp/ActionMcp.js";
import * as ActionRpc from "../../src/rpc/ActionRpc.js";
import * as ActionToolkit from "../../src/toolkit/ActionToolkit.js";
import * as Testing from "../../src/testing/Testing.js";
import { authenticate } from "../../examples/authentication.js";
import { actors, CurrentActor } from "../../examples/authorization.js";
import { Login } from "../../examples/binding.js";
import { as } from "../support/requests.js";

class Refused extends Schema.TaggedError<Refused>()(
  "Refused",
  { action: Schema.String },
  { httpApiStatus: 409 },
) {}

const Planned = Schema.Literals(["succeed", "fail", "die"]);

const input = { value: Schema.Int, planned: Planned };

const SoloEcho = Action.make("soloEcho", {
  description: "solo",
  readOnly: true,
  caller: Action.Anyone,
  input,
  success: Schema.String,
  error: Refused,
});

const PairEcho = Action.make("pairEcho", {
  description: "pair",
  readOnly: true,
  caller: Action.Anyone,
  input,
  success: Schema.String,
  error: Refused,
});

const PairGuarded = Action.make("pairGuarded", {
  description: "pair, signed in, writing",
  readOnly: false,
  caller: CurrentActor,
  input,
  success: Schema.String,
  error: Refused,
});

const TrioEcho = Action.make("trioEcho", {
  description: "trio",
  readOnly: true,
  caller: Action.Anyone,
  input,
  success: Schema.String,
  error: Refused,
});

const TrioOther = Action.make("trioOther", {
  description: "trio, the other",
  readOnly: true,
  caller: Action.Anyone,
  input,
  success: Schema.String,
  error: Refused,
});

const catalogue = [SoloEcho, PairEcho, PairGuarded, TrioEcho, TrioOther] as const;

const ActionName = Schema.Literals(catalogue.map((action) => action.name));

type ActionName = typeof ActionName.Type;

const contracts = Action.byName(catalogue);

const contractsOf = (names: ReadonlyArray<ActionName> | undefined) =>
  names?.map((name) => contracts[name]);

const actionsOfImplementation = {
  solo: ["soloEcho"],
  pair: ["pairEcho", "pairGuarded"],
  trio: ["trioEcho", "trioOther"],
} satisfies Readonly<Record<string, ReadonlyArray<ActionName>>>;

const implementationNames = Struct.keys(actionsOfImplementation);

const ImplementationName = Schema.Literals(implementationNames);

type ImplementationName = typeof ImplementationName.Type;

const SurfaceKind = Schema.Literals(["http", "mcp", "rpc", "toolkit"]);

type SurfaceKind = typeof SurfaceKind.Type;

type RemoteKind = Exclude<SurfaceKind, "toolkit">;

const Caller = Schema.Literals(["alice", "reader", "anonymous"]);

type Caller = typeof Caller.Type;

type PlannedOutcome = typeof Planned.Type;

const maxSurfaces = 4;

const Scenario = Schema.Struct({
  arrangement: Schema.Literals(["actionLayerAbove", "toolkitBelowRoutes", "routesBelowToolkit"]),
  implementations: Schema.Array(ImplementationName).check(
    Schema.isBetweenLength(1, implementationNames.length),
  ),
  surfaces: Schema.Array(
    Schema.Struct({
      kind: SurfaceKind,
      fresh: Schema.Boolean,
      actions: Schema.NullOr(Schema.Array(ActionName)),
    }),
  ).check(Schema.isBetweenLength(1, maxSurfaces)),
  calls: Schema.Array(
    Schema.Struct({
      action: ActionName,
      via: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: maxSurfaces - 1 })),
      caller: Caller,
      ...input,
    }),
  ),
});

type Scenario = typeof Scenario.Type;

interface ResolvedSurface {
  readonly index: number;
  readonly kind: SurfaceKind;
  readonly fresh: boolean;
  readonly listed: ReadonlyArray<ActionName> | undefined;
  readonly serves: ReadonlyArray<ActionName>;
}

interface ResolvedCall {
  readonly surface: ResolvedSurface;
  readonly action: ActionName;
  readonly caller: Caller;
  readonly value: number;
  readonly planned: PlannedOutcome;
}

const resolve = (scenario: Scenario) => {
  const present = implementationNames.filter((name) => scenario.implementations.includes(name));
  const held = present.flatMap((name) => actionsOfImplementation[name]);

  const surfaces = scenario.surfaces.map((surface, index): ResolvedSurface => {
    const listed =
      surface.actions === null
        ? undefined
        : held.filter((action) => surface.actions?.includes(action) === true);

    return {
      index,
      kind: surface.kind,
      fresh: surface.fresh && (surface.kind === "http" || surface.kind === "mcp"),
      listed,
      serves: listed ?? held,
    };
  });

  const calls = scenario.calls.flatMap((call): ReadonlyArray<ResolvedCall> => {
    const serving = surfaces.filter((surface) => surface.serves.includes(call.action));
    const surface = serving[call.via % Math.max(serving.length, 1)];

    return surface === undefined
      ? []
      : [
          {
            surface,
            action: call.action,
            caller: call.caller,
            value: call.value,
            planned: call.planned,
          },
        ];
  });

  return { arrangement: scenario.arrangement, present, surfaces, calls };
};

type Outcome =
  | `answered ${string}`
  | `failed with ${"Refused" | "Forbidden" | "Unauthenticated"}`
  | "undeclared";

interface Tally {
  acquired: number;
  released: number;
}

const tally = (): Tally => ({ acquired: 0, released: 0 });

const counted = (counter: Tally) =>
  Effect.acquireRelease(
    Effect.sync(() => {
      counter.acquired += 1;
    }),
    () =>
      Effect.sync(() => {
        counter.released += 1;
      }),
  );

const makeImplementations = () => {
  const builders = { solo: tally(), pair: tally(), trio: tally(), pairAuthorizer: tally() };
  const perCall = { handler: tally(), authorizer: tally() };

  const answer =
    (name: ActionName) =>
    ({ value, planned }: { readonly value: number; readonly planned: PlannedOutcome }) =>
      Effect.gen(function* () {
        yield* counted(perCall.handler);

        if (planned === "fail") return yield* new Refused({ action: name });

        if (planned === "die") return yield* Effect.die(`${name} planned a defect`);

        return `${name}:${value}`;
      });

  const solo = Action.implement(SoloEcho, Effect.as(counted(builders.solo), answer("soloEcho")));

  const pair = Action.implement(
    [PairEcho, PairGuarded],
    Effect.as(counted(builders.pair), {
      pairEcho: answer("pairEcho"),
      pairGuarded: answer("pairGuarded"),
    }),
    {
      authorize: Effect.as(counted(builders.pairAuthorizer), () =>
        Effect.gen(function* () {
          yield* counted(perCall.authorizer);
          const actor = yield* CurrentActor;

          if (!actor.permissions.includes("users:write")) {
            return yield* new Action.Forbidden();
          }
        }),
      ),
    },
  );

  const trio = Action.implement(
    [TrioEcho, TrioOther],
    Effect.as(counted(builders.trio), {
      trioEcho: answer("trioEcho"),
      trioOther: answer("trioOther"),
    }),
  );

  return { implementations: { solo, pair, trio }, builders, perCall };
};

const httpBindings = Array.from({ length: maxSurfaces }, (_, index) =>
  ActionHttp.make(catalogue, { prefix: `/h${index}`, authentication: Login }),
);

const Rpc = ActionRpc.make(catalogue, { authentication: Login });

const bindingAt = (index: number) => {
  const binding = httpBindings[index];

  if (binding === undefined) throw new Error(`No HTTP binding for surface ${index}`);

  return binding;
};

const tokenOf = (caller: Caller) => (caller === "anonymous" ? undefined : caller);

const isDeclared = Schema.is(Schema.Union([Refused, Action.Forbidden, Action.Unauthenticated]));

const settle = <E, R>(call: Effect.Effect<string, E, R>): Effect.Effect<Outcome, never, R> =>
  Effect.map(Effect.exit(call), (exit): Outcome =>
    Exit.isSuccess(exit)
      ? `answered ${exit.value}`
      : Option.match(Option.filter(Cause.findErrorOption(exit.cause), isDeclared), {
          onNone: (): Outcome => "undeclared",
          onSome: (error): Outcome => `failed with ${error._tag}`,
        }),
  );

const expectedBuilds = (
  resolved: ReturnType<typeof resolve>,
  implementation: ImplementationName,
  actions: ReadonlyArray<ActionName>,
): number => {
  if (!resolved.present.includes(implementation)) return 0;

  const serving = resolved.surfaces.filter((surface) =>
    surface.serves.some((action) => actions.includes(action)),
  );

  const fresh = serving.filter((surface) => surface.fresh).length;
  const shared = serving.filter((surface) => !surface.fresh);
  const viaRoutes = shared.some((surface) => surface.kind !== "toolkit") ? 1 : 0;
  const viaToolkit = shared.some((surface) => surface.kind === "toolkit") ? 1 : 0;

  switch (resolved.arrangement) {
    case "actionLayerAbove":
      return 1 + fresh;
    case "toolkitBelowRoutes":
      return Math.max(viaRoutes, viaToolkit) + fresh;
    case "routesBelowToolkit":
      return viaRoutes + viaToolkit + fresh;
  }
};

const isProtected = (action: ActionName) => action === "pairGuarded";

const mayWrite = (caller: Caller) => caller === "alice";

const expectedCall = (call: ResolvedCall) => {
  if (isProtected(call.action) && call.caller === "anonymous") {
    return { outcome: "failed with Unauthenticated", authorizer: 0, handler: 0 } as const;
  }

  const authorizer = isProtected(call.action) ? 1 : 0;

  if (isProtected(call.action) && !mayWrite(call.caller)) {
    return { outcome: "failed with Forbidden", authorizer, handler: 0 } as const;
  }

  const outcomes: Readonly<Record<PlannedOutcome, Outcome>> = {
    succeed: `answered ${call.action}:${call.value}`,
    fail: "failed with Refused",
    die: "undeclared",
  };

  return { outcome: outcomes[call.planned], authorizer, handler: 1 };
};

const agrees = (observed: string, modelled: string) =>
  expect(observed, `observed ${observed}\nmodelled ${modelled}`).toBe(modelled);

const quiet = Layer.succeed(References.MinimumLogLevel, "None");

const runScenario = (scenario: Scenario) =>
  Effect.gen(function* () {
    const resolved = resolve(scenario);
    const { implementations, builders, perCall } = makeImplementations();
    const apps = resolved.present.map((name) => implementations[name]);

    const modelBuilds: Readonly<Record<keyof typeof builders, number>> = {
      solo: expectedBuilds(resolved, "solo", actionsOfImplementation.solo),
      pair: expectedBuilds(resolved, "pair", actionsOfImplementation.pair),
      trio: expectedBuilds(resolved, "trio", actionsOfImplementation.trio),
      pairAuthorizer: expectedBuilds(resolved, "pair", ["pairGuarded"]),
    };

    const builderNames = Struct.keys(builders);

    const observedBuilders = () =>
      builderNames
        .map(
          (name) => `${name} built ${builders[name].acquired}, released ${builders[name].released}`,
        )
        .join("; ");

    const modelledBuilders = (graph: "open" | "closed") =>
      builderNames
        .map(
          (name) =>
            `${name} built ${modelBuilds[name]}, released ${graph === "open" ? 0 : modelBuilds[name]}`,
        )
        .join("; ");

    const callReport = (step: number, outcome: Outcome, handler: Tally, authorizer: Tally) =>
      `step ${step}: ${outcome}; handler acquired ${handler.acquired}, released ${handler.released}; authorizer acquired ${authorizer.acquired}, released ${authorizer.released}`;

    const remoteLayer = (surface: ResolvedSurface, kind: RemoteKind) => {
      const options = { actions: contractsOf(surface.listed) };

      switch (kind) {
        case "http":
          return ActionHttp.layer(bindingAt(surface.index), apps, options);
        case "mcp":
          return ActionMcp.layerHttp(apps, {
            name: "builds",
            version: "0",
            path: `/m${surface.index}` as const,
            authentication: Login,
            ...options,
          });
        case "rpc":
          return ActionRpc.layer(Rpc, apps, options).pipe(
            Layer.provide(RpcServer.layerProtocolHttp({ path: `/r${surface.index}` as const })),
            Layer.provide(RpcSerialization.layerJson),
          );
      }
    };

    type RemoteLayer = ReturnType<typeof remoteLayer>;

    const routes = resolved.surfaces
      .flatMap((surface) => {
        if (surface.kind === "toolkit") return [];

        const layer = remoteLayer(surface, surface.kind);

        return [surface.fresh ? Layer.fresh(layer) : layer];
      })
      .reduce<Layer.Layer<never, Layer.Error<RemoteLayer>, Layer.Services<RemoteLayer>>>(
        (all, layer) => Layer.merge(all, layer),
        Layer.empty,
      )
      .pipe(Layer.provide(authenticate));

    const toolkitOf = (surface: ResolvedSurface) =>
      ActionToolkit.make(apps, { actions: contractsOf(surface.listed) });

    type Tools = ReturnType<typeof toolkitOf>;

    const toolkits = new Map(
      resolved.surfaces.flatMap((surface): ReadonlyArray<readonly [number, Tools]> =>
        surface.kind === "toolkit" ? [[surface.index, toolkitOf(surface)]] : [],
      ),
    );

    const callInput = (call: ResolvedCall) => ({ value: call.value, planned: call.planned });

    const viaHttp = (call: ResolvedCall) => {
      const token = tokenOf(call.caller);

      return settle(
        Effect.flatMap(
          ActionHttp.client(bindingAt(call.surface.index), token === undefined ? {} : as(token)),
          (client) => client[call.action](callInput(call)),
        ),
      );
    };

    const viaMcp = (call: ResolvedCall) => {
      const token = tokenOf(call.caller);

      return settle(
        Effect.flatMap(
          Testing.mcpClient(catalogue, {
            url: `/m${call.surface.index}`,
            ...(token === undefined ? {} : as(token)),
          }),
          (client) => client[call.action](callInput(call)),
        ),
      );
    };

    const viaRpc = (call: ResolvedCall) => {
      const token = tokenOf(call.caller);

      return settle(
        Effect.scoped(
          Effect.flatMap(ActionRpc.client(Rpc), (client) =>
            token === undefined
              ? client[call.action](callInput(call))
              : client[call.action](callInput(call)).pipe(
                  RpcClient.withHeaders({ authorization: `Bearer ${token}` }),
                ),
          ),
        ).pipe(
          Effect.provide(
            RpcClient.layerProtocolHttp({ url: `/r${call.surface.index}` }).pipe(
              Layer.provide(RpcSerialization.layerJson),
            ),
          ),
        ),
      );
    };

    const viaToolkit = (
      call: ResolvedCall,
    ): Effect.Effect<Outcome, never, Layer.Success<Tools["layer"]>> => {
      const tools = toolkits.get(call.surface.index);

      if (tools === undefined) throw new Error(`No toolkit at surface ${call.surface.index}`);

      const handled = Effect.flatMap(tools.toolkit, (toolkit) =>
        Effect.flatMap(toolkit.handle(call.action, callInput(call)), Stream.runCollect),
      ).pipe(
        Effect.flatMap(([first]) =>
          first === undefined
            ? Effect.die("A tool call returned no result")
            : first.isFailure
              ? Effect.fail(first.result)
              : Effect.orDie(Schema.decodeUnknownEffect(Schema.String)(first.result)),
        ),
      );

      if (call.caller === "anonymous") {
        // @ts-expect-error -- plain JavaScript calls a protected tool without the identity its type owes
        return settle(handled);
      }

      return settle(handled.pipe(Effect.provideService(CurrentActor, actors[call.caller])));
    };

    const viaRemote = (call: ResolvedCall, kind: RemoteKind) => {
      switch (kind) {
        case "http":
          return viaHttp(call);
        case "mcp":
          return viaMcp(call);
        case "rpc":
          return viaRpc(call);
      }
    };

    const throughRoutes = (call: ResolvedCall) =>
      call.surface.kind === "toolkit"
        ? Effect.die(`No toolkit serves call ${call.action}`)
        : viaRemote(call, call.surface.kind);

    const throughEverySurface = (call: ResolvedCall) =>
      call.surface.kind === "toolkit" ? viaToolkit(call) : viaRemote(call, call.surface.kind);

    const exercise = <R, E>(
      graph: Layer.Layer<R, E>,
      callThrough: (call: ResolvedCall) => Effect.Effect<Outcome, never, R>,
    ) =>
      Effect.scoped(
        Effect.gen(function* () {
          const context = yield* Layer.build(graph.pipe(Layer.provide(quiet)));
          const expectedPerCall = { handler: 0, authorizer: 0 };

          agrees(observedBuilders(), modelledBuilders("open"));

          for (const [step, call] of resolved.calls.entries()) {
            const expected = expectedCall(call);
            const outcome = yield* callThrough(call).pipe(Effect.provideContext(context));

            expectedPerCall.handler += expected.handler;
            expectedPerCall.authorizer += expected.authorizer;

            agrees(
              callReport(step, outcome, perCall.handler, perCall.authorizer),
              callReport(
                step,
                expected.outcome,
                { acquired: expectedPerCall.handler, released: expectedPerCall.handler },
                { acquired: expectedPerCall.authorizer, released: expectedPerCall.authorizer },
              ),
            );
            agrees(observedBuilders(), modelledBuilders("open"));
          }
        }),
      );

    const served = Testing.layer(routes);
    const [firstTools, ...otherTools] = [...toolkits.values()].map((tools) => tools.layer);

    if (firstTools === undefined) {
      yield* exercise(
        resolved.arrangement === "actionLayerAbove"
          ? served.pipe(Layer.provide(Action.layer(apps)))
          : served,
        throughRoutes,
      );
    } else {
      const toolkitLayers = Layer.mergeAll(firstTools, ...otherTools);

      yield* exercise(
        {
          actionLayerAbove: Layer.merge(served, toolkitLayers).pipe(
            Layer.provide(Action.layer(apps)),
          ),
          toolkitBelowRoutes: served.pipe(Layer.provideMerge(toolkitLayers)),
          routesBelowToolkit: toolkitLayers.pipe(Layer.provideMerge(served)),
        }[resolved.arrangement],
        throughEverySurface,
      );
    }

    agrees(observedBuilders(), modelledBuilders("closed"));
  }).pipe(Effect.provide(quiet));

it.effect.prop(
  "builds each implementation once per graph for the surfaces selecting it, and releases every call's and every build's resources",
  { scenario: Scenario },
  ({ scenario }) => runScenario(scenario),
  { timeout: 120_000, arbitrary: { runs: 3000 } },
);
