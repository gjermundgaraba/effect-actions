// Compile-only assertions, included by `vp check`, on what middleware around and inside
// authenticated routes owes: router middleware feeding a verifier, and a layer's own
// endpoint middleware.
import { Context, Effect, Layer, Schema } from "effect";
import { HttpRouter } from "effect/http";
import { HttpApiMiddleware } from "effect/http-api";
import { expectTypeOf } from "@effect/vitest";
import * as Action from "../src/Action.js";
import * as ActionHttp from "../src/ActionHttp.js";
import * as ActionMcp from "../src/ActionMcp.js";
import * as Testing from "../src/Testing.js";
import { serve } from "./serve.js";
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
} from "./tenant.js";

const routes = Layer.merge(
  ActionHttp.layer(Http, app),
  ActionMcp.layerHttp(app, { name: "tenant", version: "0", authentication: Login }),
).pipe(Layer.provide(authenticate));

type Owed<L extends Layer.Any> = HttpRouter.Request.Only<"Requires", Layer.Services<L>>;

// The verifier's Tenant is owed per request by the routes it authenticates.
expectTypeOf<Owed<typeof routes>>().toEqualTypeOf<Tenant>();

// @ts-expect-error The verifier's Tenant requirement needs request middleware.
void Effect.runPromise(Effect.void.pipe(Effect.provide(Testing.layer(routes))));

// @ts-expect-error A startup Tenant does not provide a request's.
serve(routes.pipe(Layer.provide(Layer.succeed(Tenant, "startup"))));

void Effect.runPromise(
  Effect.void.pipe(Effect.provide(Testing.layer(routes.pipe(Layer.provide(resolveTenant.layer))))),
);

// Native `Layer.provide` feeds an array's members to the routes, not to one another: the
// tenant middleware must come in a later provide than the verifier that reads its Tenant.
const unprovided = ActionHttp.layer(Http, app);

// @ts-expect-error The array leaves the verifier's request Tenant owed.
serve(unprovided.pipe(Layer.provide([authenticate, resolveTenant.layer])));

serve(unprovided.pipe(Layer.provide(authenticate), Layer.provide(resolveTenant.layer)));

/** Names the caller on each response. */
class LogCaller extends HttpApiMiddleware.Service<LogCaller>()("middleware-types/LogCaller") {}

const logged = ActionHttp.layer(Http, app, { middleware: [LogCaller] }).pipe(
  Layer.provide(authenticate),
  Layer.provide(resolveTenant.layer),
);

// The layer owes its middleware's service.
expectTypeOf<LogCaller>().toExtend<Layer.Services<typeof logged>>();

// @ts-expect-error LogCaller is unimplemented.
serve(logged);

serve(logged.pipe(Layer.provide(Layer.succeed(LogCaller, (route) => route))));

class Region extends Context.Service<Region, string>()("middleware-types/Region") {}

/** Requires a request service. */
class NeedsRegion extends HttpApiMiddleware.Service<NeedsRegion, { requires: Region }>()(
  "middleware-types/NeedsRegion",
) {}

/** Requires the identity, which only authentication provides. */
class NeedsActor extends HttpApiMiddleware.Service<NeedsActor, { requires: Actor }>()(
  "middleware-types/NeedsActor",
) {}

/** Provides what an inner middleware requires. */
class GivesRegion extends HttpApiMiddleware.Service<GivesRegion, { provides: Region }>()(
  "middleware-types/GivesRegion",
) {}

/** Needs a client counterpart. */
class ForClient extends HttpApiMiddleware.Service<ForClient>()("middleware-types/ForClient", {
  requiredForClient: true,
}) {}

/** Fails with an error of its own. */
class Fails extends HttpApiMiddleware.Service<Fails>()("middleware-types/Fails", {
  error: Schema.String,
}) {}

// A middleware's own request requirement is owed, unless an outer one provides it.
const region = ActionHttp.layer(Http, app, { middleware: [NeedsRegion] });

expectTypeOf<Owed<typeof region>>().toEqualTypeOf<Region>();

const given = ActionHttp.layer(Http, app, { middleware: [NeedsRegion, GivesRegion] });

// Explicit options naming middleware require the options, which alone install it.
// @ts-expect-error The options are left out.
ActionHttp.layer<typeof Http, typeof app, { readonly middleware: [typeof GivesRegion] }>(Http, app);

// @ts-expect-error No option `prefx`.
ActionHttp.layer(Http, app, { middleware: [], prefx: "/x" });

expectTypeOf<Owed<typeof given>>().toEqualTypeOf<never>();

const late = ActionHttp.layer(Http, app, { middleware: [GivesRegion, NeedsRegion] });

expectTypeOf<Owed<typeof late>>().toEqualTypeOf<Region>();

// An array of unknown order owes what any of them requires.
const shared: ReadonlyArray<typeof NeedsRegion | typeof GivesRegion> = [NeedsRegion, GivesRegion];

const unordered = ActionHttp.layer(Http, app, { middleware: shared });

expectTypeOf<Owed<typeof unordered>>().toEqualTypeOf<Region>();

// Middleware that may be absent provides nothing and owes what any of it requires: options
// typed with middleware they may lack, or chosen by a condition, may install none of it.
const maybeGiven: ActionHttp.LayerOptions<[typeof NeedsRegion, typeof GivesRegion]> = {};

const unsure = ActionHttp.layer(Http, app, maybeGiven);

expectTypeOf<Owed<typeof unsure>>().toEqualTypeOf<Region>();

declare const regional: boolean;

const conditional = ActionHttp.layer(
  Http,
  app,
  regional ? { middleware: [NeedsRegion, GivesRegion] } : {},
);

expectTypeOf<Owed<typeof conditional>>().toEqualTypeOf<Region>();

expectTypeOf<GivesRegion>().toExtend<Layer.Services<typeof conditional>>();

// Middleware always given is exact: an outer one provides what an inner one requires.
const always = { middleware: [NeedsRegion, GivesRegion] } as const;

const exact = ActionHttp.layer(Http, app, always);

expectTypeOf<Owed<typeof exact>>().toBeNever();

// The identity is provided only where every served action is protected.
const mixed = ActionHttp.layer(Http, app, { middleware: [NeedsActor] });

expectTypeOf<Owed<typeof mixed>>().toEqualTypeOf<Actor>();

const ProtectedOnly = ActionHttp.make([Who], { authentication: Login });

const guarded = ActionHttp.layer(ProtectedOnly, app, { middleware: [NeedsActor] });

expectTypeOf<Owed<typeof guarded>>().toEqualTypeOf<never>();

// So is it on a layer whose `actions` lists only protected ones, of a mixed implementation.
const selected = ActionHttp.layer(Http, app, { actions: [Who], middleware: [NeedsActor] });

expectTypeOf<Owed<typeof selected>>().toEqualTypeOf<never>();

// `actions` that may be absent selects every action, so it narrows nothing.
const maybeSelected: ActionHttp.LayerOptions<readonly [typeof NeedsActor], typeof Who> = {
  middleware: [NeedsActor],
};

const unselected = ActionHttp.layer(Http, app, maybeSelected);

expectTypeOf<Owed<typeof unselected>>().toEqualTypeOf<Actor>();

const Elsewhere = Action.make("elsewhere", {
  description: "Bound by no binding here",
  readOnly: true,
  caller: Action.Anyone,
  success: Schema.String,
});

ActionHttp.layer(Http, [app, Action.implement(Elsewhere, () => Effect.succeed("x"))], {
  // @ts-expect-error Listed actions are the binding's.
  actions: [Elsewhere],
});

// A slot that may hold one of several middleware provides nothing, as only one runs.
const oneOf = ActionHttp.layer(Http, app, {
  middleware: [NeedsRegion, regional ? GivesRegion : LogCaller],
});

expectTypeOf<Owed<typeof oneOf>>().toEqualTypeOf<Region>();

// A middleware failing with an error the binding does not declare reaches no client.
// @ts-expect-error Layer middleware fails only with the binding's errors.
ActionHttp.layer(Http, app, { middleware: [Fails] });

class Throttled extends Schema.TaggedError<Throttled>()("Throttled", {}, { httpApiStatus: 429 }) {}

/** A quota keyed by the caller, before decoding, failing with what the binding declares. */
class Quota extends HttpApiMiddleware.Service<Quota, { requires: Actor }>()(
  "middleware-types/Quota",
  { error: Throttled },
) {}

const Limited = ActionHttp.make([Who], { authentication: Login, error: [Throttled] });

const quota = ActionHttp.layer(Limited, app, { middleware: [Quota] });

expectTypeOf<Owed<typeof quota>>().toEqualTypeOf<never>();

// @ts-expect-error Undeclared by this binding.
ActionHttp.layer(Http, app, { middleware: [Quota] });

// Options that may leave `errors` out declare them or none, as the binding has at run time:
// clients decode them, and layer middleware fails only with errors declared either way.
const unsureErrors: ActionHttp.Options<readonly [typeof Throttled]> & {
  readonly authentication: typeof Login;
} = { authentication: Login };

const Unsure = ActionHttp.make([Who], unsureErrors);

expectTypeOf(Unsure.error).toEqualTypeOf<readonly [typeof Throttled] | []>();

expectTypeOf<Throttled>().toExtend<
  Effect.Error<ReturnType<ActionHttp.Client<typeof Unsure>["who"]>>
>();

// @ts-expect-error Undeclared where the options may leave `errors` out.
ActionHttp.layer(Unsure, app, { middleware: [Quota] });

// Inline errors are the tuple given, which surely holds each.
expectTypeOf(Limited.error).toEqualTypeOf<readonly [typeof Throttled]>();

class Busy extends Schema.TaggedError<Busy>()("Busy", {}, { httpApiStatus: 503 }) {}

// A list of unknown length may be empty, a variadic one included, and a slot of either error
// may hold the other.
const unsized: Array<typeof Throttled> = [];

const either: readonly [typeof Throttled | typeof Busy] = [Busy];

const extra: ReadonlyArray<typeof Busy> = [];

const Unsized = ActionHttp.make([Who], { authentication: Login, error: unsized });

const Either = ActionHttp.make([Who], { authentication: Login, error: either });

const Variadic = ActionHttp.make([Who], { authentication: Login, error: [Throttled, ...extra] });

// @ts-expect-error Not surely declared by this binding.
ActionHttp.layer(Unsized, app, { middleware: [Quota] });

// @ts-expect-error Not surely declared by this binding.
ActionHttp.layer(Either, app, { middleware: [Quota] });

// @ts-expect-error Not surely declared by this binding.
ActionHttp.layer(Variadic, app, { middleware: [Quota] });

// Every endpoint declares the built-ins, so any binding's middleware may fail with them.
class Allowlist extends HttpApiMiddleware.Service<Allowlist>()("middleware-types/Allowlist", {
  error: Action.Forbidden,
}) {}

ActionHttp.layer(Http, app, { middleware: [Allowlist] });

// Explicit options naming errors require the argument, which alone holds them.
// @ts-expect-error The options naming errors are not given.
ActionHttp.make<readonly [typeof Public], { readonly error: readonly [typeof Throttled] }>([
  Public,
]);

// @ts-expect-error Layer middleware needs no client counterpart.
ActionHttp.layer(Http, app, { middleware: [ForClient] });
