import { Context, Effect, Layer, Schema } from "effect";
import { HttpRouter } from "effect/http";
import { HttpApiMiddleware } from "effect/http-api";
import { expectTypeOf } from "@effect/vitest";
import * as Action from "../../src/contract/Action.js";
import * as ActionHttp from "../../src/http/ActionHttp.js";
import * as ActionMcp from "../../src/mcp/ActionMcp.js";
import * as Testing from "../../src/testing/Testing.js";
import { serve } from "../support/serve.js";
import {
  Actor,
  app,
  authenticate,
  Http,
  Login,
  Public,
  resolveTenant,
  Tenant,
  Who,
} from "../support/tenant.js";

const tenantVerifiedRoutes = Layer.merge(
  ActionHttp.layer(Http, app),
  ActionMcp.layerHttp(app, { name: "tenant", version: "0", authentication: Login }),
).pipe(Layer.provide(authenticate));

type Owed<L extends Layer.Any> = HttpRouter.Request.Only<"Requires", Layer.Services<L>>;

expectTypeOf<Owed<typeof tenantVerifiedRoutes>>().toEqualTypeOf<Tenant>();

// @ts-expect-error -- The verifier's Tenant requirement needs request middleware.
void Effect.runPromise(Effect.void.pipe(Effect.provide(Testing.layer(tenantVerifiedRoutes))));

// @ts-expect-error -- A startup Tenant does not provide a request's.
serve(tenantVerifiedRoutes.pipe(Layer.provide(Layer.succeed(Tenant, "startup"))));

void Effect.runPromise(
  Effect.void.pipe(
    Effect.provide(Testing.layer(tenantVerifiedRoutes.pipe(Layer.provide(resolveTenant.layer)))),
  ),
);

const verifierOwingTenant = ActionHttp.layer(Http, app);

// @ts-expect-error -- An array's members do not provide to one another, so the verifier's request Tenant stays owed.
serve(verifierOwingTenant.pipe(Layer.provide([authenticate, resolveTenant.layer])));

serve(verifierOwingTenant.pipe(Layer.provide(authenticate), Layer.provide(resolveTenant.layer)));

class LogCallerOnResponse extends HttpApiMiddleware.Service<LogCallerOnResponse>()(
  "middleware-types/LogCaller",
) {}

const logged = ActionHttp.layer(Http, app, { middleware: [LogCallerOnResponse] }).pipe(
  Layer.provide(authenticate),
  Layer.provide(resolveTenant.layer),
);

expectTypeOf<LogCallerOnResponse>().toExtend<Layer.Services<typeof logged>>();

// @ts-expect-error -- LogCallerOnResponse is unimplemented.
serve(logged);

serve(logged.pipe(Layer.provide(Layer.succeed(LogCallerOnResponse, (route) => route))));

class Region extends Context.Service<Region, string>()("middleware-types/Region") {}

class NeedsRegion extends HttpApiMiddleware.Service<NeedsRegion, { requires: Region }>()(
  "middleware-types/NeedsRegion",
) {}

class NeedsActor extends HttpApiMiddleware.Service<NeedsActor, { requires: Actor }>()(
  "middleware-types/NeedsActor",
) {}

class GivesRegion extends HttpApiMiddleware.Service<GivesRegion, { provides: Region }>()(
  "middleware-types/GivesRegion",
) {}

class ForClient extends HttpApiMiddleware.Service<ForClient>()("middleware-types/ForClient", {
  requiredForClient: true,
}) {}

class Fails extends HttpApiMiddleware.Service<Fails>()("middleware-types/Fails", {
  error: Schema.String,
}) {}

const innerNeedsRegion = ActionHttp.layer(Http, app, { middleware: [NeedsRegion] });

expectTypeOf<Owed<typeof innerNeedsRegion>>().toEqualTypeOf<Region>();

const outerGivesRegion = ActionHttp.layer(Http, app, { middleware: [NeedsRegion, GivesRegion] });

// @ts-expect-error -- Explicit options naming middleware require the options, which alone install it.
ActionHttp.layer<typeof Http, typeof app, { readonly middleware: [typeof GivesRegion] }>(Http, app);

// @ts-expect-error -- No option `prefx`.
ActionHttp.layer(Http, app, { middleware: [], prefx: "/x" });

expectTypeOf<Owed<typeof outerGivesRegion>>().toEqualTypeOf<never>();

const innerGivesRegion = ActionHttp.layer(Http, app, { middleware: [GivesRegion, NeedsRegion] });

expectTypeOf<Owed<typeof innerGivesRegion>>().toEqualTypeOf<Region>();

const shared: ReadonlyArray<typeof NeedsRegion | typeof GivesRegion> = [NeedsRegion, GivesRegion];

const unknownOrderOwesAny = ActionHttp.layer(Http, app, { middleware: shared });

expectTypeOf<Owed<typeof unknownOrderOwesAny>>().toEqualTypeOf<Region>();

const maybeGiven: ActionHttp.LayerOptions<[typeof NeedsRegion, typeof GivesRegion]> = {};

const maybeAbsentMiddleware = ActionHttp.layer(Http, app, maybeGiven);

expectTypeOf<Owed<typeof maybeAbsentMiddleware>>().toEqualTypeOf<Region>();

declare const regional: boolean;

const conditionallyGiven = ActionHttp.layer(
  Http,
  app,
  regional ? { middleware: [NeedsRegion, GivesRegion] } : {},
);

expectTypeOf<Owed<typeof conditionallyGiven>>().toEqualTypeOf<Region>();

expectTypeOf<GivesRegion>().toExtend<Layer.Services<typeof conditionallyGiven>>();

const alwaysGiven = { middleware: [NeedsRegion, GivesRegion] } as const;

const alwaysGivenExact = ActionHttp.layer(Http, app, alwaysGiven);

expectTypeOf<Owed<typeof alwaysGivenExact>>().toBeNever();

const mixedActionsOweActor = ActionHttp.layer(Http, app, { middleware: [NeedsActor] });

expectTypeOf<Owed<typeof mixedActionsOweActor>>().toEqualTypeOf<Actor>();

const ProtectedOnly = ActionHttp.make([Who], { authentication: Login });

const protectedOnlyProvidesActor = ActionHttp.layer(ProtectedOnly, app, {
  middleware: [NeedsActor],
});

expectTypeOf<Owed<typeof protectedOnlyProvidesActor>>().toEqualTypeOf<never>();

const protectedActionsSelected = ActionHttp.layer(Http, app, {
  actions: [Who],
  middleware: [NeedsActor],
});

expectTypeOf<Owed<typeof protectedActionsSelected>>().toEqualTypeOf<never>();

const maybeAbsentActions: ActionHttp.LayerOptions<readonly [typeof NeedsActor], typeof Who> = {
  middleware: [NeedsActor],
};

const maybeAbsentActionsSelectEvery = ActionHttp.layer(Http, app, maybeAbsentActions);

expectTypeOf<Owed<typeof maybeAbsentActionsSelectEvery>>().toEqualTypeOf<Actor>();

const Elsewhere = Action.make("elsewhere", {
  description: "Bound by no binding here",
  readOnly: true,
  caller: Action.Anyone,
  success: Schema.String,
});

ActionHttp.layer(Http, [app, Action.implement(Elsewhere, () => Effect.succeed("x"))], {
  // @ts-expect-error -- Listed actions are the binding's.
  actions: [Elsewhere],
});

const slotOfSeveralProvidesNothing = ActionHttp.layer(Http, app, {
  middleware: [NeedsRegion, regional ? GivesRegion : LogCallerOnResponse],
});

expectTypeOf<Owed<typeof slotOfSeveralProvidesNothing>>().toEqualTypeOf<Region>();

// @ts-expect-error -- Layer middleware fails only with the binding's errors, as no client decodes another.
ActionHttp.layer(Http, app, { middleware: [Fails] });

class Throttled extends Schema.TaggedError<Throttled>()("Throttled", {}, { httpApiStatus: 429 }) {}

class CallerQuota extends HttpApiMiddleware.Service<CallerQuota, { requires: Actor }>()(
  "middleware-types/Quota",
  { error: Throttled },
) {}

const Limited = ActionHttp.make([Who], { authentication: Login, error: [Throttled] });

const quota = ActionHttp.layer(Limited, app, { middleware: [CallerQuota] });

expectTypeOf<Owed<typeof quota>>().toEqualTypeOf<never>();

// @ts-expect-error -- Undeclared by this binding.
ActionHttp.layer(Http, app, { middleware: [CallerQuota] });

const maybeAbsentErrors: ActionHttp.Options<readonly [typeof Throttled]> & {
  readonly authentication: typeof Login;
} = { authentication: Login };

const Unsure = ActionHttp.make([Who], maybeAbsentErrors);

expectTypeOf(Unsure.error).toEqualTypeOf<readonly [typeof Throttled] | []>();

expectTypeOf<Throttled>().toExtend<
  Effect.Error<ReturnType<ActionHttp.Client<typeof Unsure>["who"]>>
>();

// @ts-expect-error -- Options that may leave `errors` out may declare none, so the error is undeclared.
ActionHttp.layer(Unsure, app, { middleware: [CallerQuota] });

expectTypeOf(Limited.error).toEqualTypeOf<readonly [typeof Throttled]>();

class Busy extends Schema.TaggedError<Busy>()("Busy", {}, { httpApiStatus: 503 }) {}

const unsized: Array<typeof Throttled> = [];

const either: readonly [typeof Throttled | typeof Busy] = [Busy];

const extra: ReadonlyArray<typeof Busy> = [];

const Unsized = ActionHttp.make([Who], { authentication: Login, error: unsized });

const Either = ActionHttp.make([Who], { authentication: Login, error: either });

const Variadic = ActionHttp.make([Who], { authentication: Login, error: [Throttled, ...extra] });

// @ts-expect-error -- Not surely declared by this binding.
ActionHttp.layer(Unsized, app, { middleware: [CallerQuota] });

// @ts-expect-error -- Not surely declared by this binding.
ActionHttp.layer(Either, app, { middleware: [CallerQuota] });

// @ts-expect-error -- Not surely declared by this binding.
ActionHttp.layer(Variadic, app, { middleware: [CallerQuota] });

class BuiltInFailingAllowlist extends HttpApiMiddleware.Service<BuiltInFailingAllowlist>()(
  "middleware-types/Allowlist",
  {
    error: Action.Forbidden,
  },
) {}

ActionHttp.layer(Http, app, { middleware: [BuiltInFailingAllowlist] });

// @ts-expect-error -- Explicit options naming errors require the argument, which alone holds them.
ActionHttp.make<readonly [typeof Public], { readonly error: readonly [typeof Throttled] }>([
  Public,
]);

// @ts-expect-error -- Layer middleware needs no client counterpart.
ActionHttp.layer(Http, app, { middleware: [ForClient] });
