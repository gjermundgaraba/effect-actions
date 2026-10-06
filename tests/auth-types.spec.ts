// Compile-only pins, included by `vp check`, on the identity a contract declares: required on
// every contract, verified remotely by its named descriptor's provider alone, owed per call in
// process, and never owed by a selection of public actions. Each refusal sits beside the form
// that compiles, so it fails for the reason it names.
import { Context, Effect, Layer, Redacted, Schema, type Scope } from "effect";
import type { HttpRouter } from "effect/http";
import { type HttpApiMiddleware, HttpApiSecurity } from "effect/http-api";
import { expectTypeOf } from "@effect/vitest";
import * as Action from "../src/Action.js";
import * as ActionHttp from "../src/ActionHttp.js";
import * as ActionMcp from "../src/ActionMcp.js";
import * as ActionToolkit from "../src/ActionToolkit.js";
import * as Authentication from "../src/Authentication.js";
import * as Testing from "../src/Testing.js";
import type { SecurityMiddleware } from "../src/internal/authentication.js";
import { authenticate } from "../examples/authentication.js";
import { actors, CurrentActor } from "../examples/authorization.js";
import { Login } from "../examples/binding.js";
import { Double, Status } from "../examples/contracts.js";

/** An implementation of any actions, owing nothing. */
declare const erased: Action.Implementation<Action.Any, never, never, never>;

class Stranger extends Context.Service<Stranger, string>()("auth-types/Stranger") {}

class Permissions extends Context.Service<Permissions, ReadonlySet<string>>()(
  "auth-types/Permissions",
) {}

class RateLimited extends Schema.TaggedError<RateLimited>()(
  "RateLimited",
  { retryAfter: Schema.Finite },
  { httpApiStatus: 429 },
) {}

class Limited extends Action.Check<Limited>()("auth-types/Limited", {
  error: RateLimited,
  requires: CurrentActor,
}) {}

const Rename = Action.make("rename", {
  description: "Rename, within the caller's limit.",
  access: "write",
  auth: CurrentActor,
  checks: [Limited],
  input: { name: Schema.String },
  success: Schema.String,
});

const handlers = {
  status: () => Effect.succeed({ service: "pins", users: 0 }),
  double: ({ value }: { readonly value: number }) => Effect.succeed(value * 2),
};

// `double` is protected, and neither its handler nor the authorizer reads the identity.
const app = Action.implement([Status, Double], handlers, { authorize: Action.allowAll });

// The same actions behind an authorizer built from a startup service.
const guarded = Action.implement([Status, Double], handlers, {
  authorize: Effect.map(
    Permissions,
    (permissions) => () =>
      permissions.has("double") ? Effect.void : Effect.fail(new Action.Forbidden()),
  ),
});

/** Run a program served by `layer`, which must owe nothing. */
const run = <A, E>(layer: Layer.Layer<A, E>) =>
  Effect.runPromise(Effect.void.pipe(Effect.provide(layer)));

export const declarationTypes = () => {
  // @ts-expect-error A contract states who may call it.
  Action.make("unclassified", { description: "x", access: "read" });
  Action.make("classified", { description: "x", access: "read", auth: "public" });

  // @ts-expect-error A protected binding names how its identity is verified.
  ActionHttp.make([Double]);
  ActionHttp.make([Double], { authentication: Login });

  // A helper generic in public actions binds them without options.
  const bindPublic = <const A extends ReadonlyArray<Action.Any & { readonly auth: "public" }>>(
    actions: A,
  ) => ActionHttp.make(actions);

  expectTypeOf(bindPublic([Status]).actions).toEqualTypeOf<readonly [typeof Status]>();

  const wrong = Authentication.make("auth-types.Wrong", Stranger);

  // A descriptor names one native scheme, Bearer unless it names another: never a record.
  Authentication.make("auth-types.Two", Stranger, {
    // @ts-expect-error A record of schemes.
    security: { first: HttpApiSecurity.bearer, second: HttpApiSecurity.bearer },
  });
  // @ts-expect-error No scheme.
  Authentication.make("auth-types.None", Stranger, { security: {} });

  // Its verifier takes what the scheme decodes: a session cookie's value, Basic credentials.
  const Session = Authentication.make("auth-types.Session", Stranger, {
    security: HttpApiSecurity.apiKey({ in: "cookie", key: "session" }),
  });

  Authentication.layer(Session, (session) => {
    expectTypeOf(session).toEqualTypeOf<Redacted.Redacted<string>>();

    return Effect.succeed(Redacted.value(session));
  });

  const Basic = Authentication.make("auth-types.Basic", Stranger, {
    security: HttpApiSecurity.basic,
  });

  Authentication.layer(Basic, (credentials) => {
    expectTypeOf(credentials).toEqualTypeOf<HttpApiSecurity.Credentials>();

    return Effect.succeed(credentials.username);
  });

  // A scheme that may be left out may be Bearer, as at run time: the verifier takes either.
  const maybeBasic: Authentication.Options & {
    readonly security?: typeof HttpApiSecurity.basic;
  } = {};

  const Maybe = Authentication.make("auth-types.Maybe", Stranger, maybeBasic);

  Authentication.layer(Maybe, (credential) => {
    expectTypeOf(credential).toEqualTypeOf<
      HttpApiSecurity.Credentials | Redacted.Redacted<string>
    >();

    return Effect.succeed("s");
  });

  // @ts-expect-error Explicit options naming a scheme require the options, which alone hold it.
  Authentication.make<
    "auth-types.Gone",
    Stranger,
    string,
    { readonly security: typeof HttpApiSecurity.basic }
  >("auth-types.Gone", Stranger);

  // @ts-expect-error No option `securty`.
  Authentication.make("auth-types.Typo", Stranger, { securty: HttpApiSecurity.basic });

  // Only a Bearer scheme publishes an OAuth protected resource.
  Authentication.layer(Session, () => Effect.succeed("s"), {
    // @ts-expect-error A cookie names no OAuth resource.
    protectedResource: { resource: "https://a.example", authorizationServers: ["https://as"] },
  });

  // @ts-expect-error A descriptor of another identity does not cover the contract.
  ActionHttp.make([Double], { authentication: wrong });

  // @ts-expect-error A protected MCP endpoint names its authentication too.
  ActionMcp.layerHttp(app, { name: "missing", version: "0", actions: [Double] });
  ActionMcp.layerHttp(app, {
    name: "named",
    version: "0",
    actions: [Double],
    authentication: Login,
  });
  ActionMcp.layerHttp(app, {
    name: "wrong",
    version: "0",
    actions: [Double],
    // @ts-expect-error And a descriptor of the contract's identity.
    authentication: wrong,
  });

  // Erased actions may be any: any descriptor is taken, and checked when the layer is made.
  ActionMcp.layerHttp(erased, { name: "erased", version: "0", authentication: Login });
};

export const providerTypes = () => {
  const routes = ActionHttp.layer(ActionHttp.make([Double], { authentication: Login }), app);

  // @ts-expect-error Neither a caller nor a verifier is supplied.
  void run(Testing.layer(routes));
  void run(Testing.layer(routes.pipe(Layer.provide(authenticate))));

  // @ts-expect-error A startup identity cannot stand in for the verifier, around the program.
  void run(Testing.layer(routes).pipe(Layer.provide(Layer.succeed(CurrentActor, actors.alice))));
  // @ts-expect-error Nor provided to the routes.
  void run(Testing.layer(routes.pipe(Layer.provide(Layer.succeed(CurrentActor, actors.alice)))));

  const OtherLogin = Authentication.make("auth-types.OtherLogin", CurrentActor);

  const other = Authentication.layer(OtherLogin, () => Effect.succeed(actors.alice));

  // @ts-expect-error Another descriptor's verifier of the same identity is not this binding's.
  void run(Testing.layer(routes.pipe(Layer.provide(other))));

  const otherRoutes = ActionHttp.layer(
    ActionHttp.make([Double], { authentication: OtherLogin }),
    app,
  );

  void run(Testing.layer(otherRoutes.pipe(Layer.provide(other))));
};

export const selectionTypes = () => {
  // An explicit options type, the second type argument as documented, narrows only as far as
  // the options given satisfy it.
  ActionMcp.layerHttp<typeof app, { readonly actions: readonly [typeof Status] }>(
    app,
    // @ts-expect-error The selection the type argument states is absent.
    { name: "lie", version: "0" },
  );
  ActionMcp.layerHttp<typeof app, { readonly actions: readonly [typeof Status] }>(app, {
    name: "selected",
    version: "0",
    actions: [Status],
  });

  // In process, the caller is owed by every call, even one nothing reads it in.
  const local = Effect.flatMap(Action.client(app, { actions: [Double] }), (client) =>
    client.double({ value: 2 }),
  ).pipe(Effect.scoped);

  expectTypeOf<Effect.Services<typeof local>>().toEqualTypeOf<CurrentActor>();
  // @ts-expect-error The contract's identity is owed per call.
  void Effect.runPromise(local);
  void Effect.runPromise(local.pipe(Effect.provideService(CurrentActor, actors.alice)));

  const toolkit = ActionToolkit.make(app, { actions: [Double] });

  const tool = Effect.flatMap(toolkit.toolkit, (tools) =>
    tools.handle("double", { value: 2 }),
  ).pipe(Effect.provide(toolkit.layer));

  // @ts-expect-error A protected tool's call owes the caller.
  void Effect.runPromise(tool);
  void Effect.runPromise(tool.pipe(Effect.provideService(CurrentActor, actors.alice)));

  // A selection of public actions owes no caller, and builds no authorizer.
  const open = Action.client(guarded, { actions: [Status] });
  const status = Effect.flatMap(open, (client) => client.status()).pipe(Effect.scoped);

  expectTypeOf<Effect.Services<typeof open>>().toEqualTypeOf<Scope.Scope>();
  expectTypeOf<Effect.Services<typeof status>>().toBeNever();
  void Effect.runPromise(status);

  // With its protected action, it builds the authorizer.
  expectTypeOf<Effect.Services<ReturnType<typeof Action.client<typeof guarded>>>>().toEqualTypeOf<
    Permissions | Scope.Scope
  >();

  // Over HTTP and MCP, without authentication.
  void run(Testing.layer(ActionHttp.layer(ActionHttp.make([Status]), guarded)));
  void run(
    Testing.layer(ActionMcp.layerHttp(guarded, { name: "open", version: "0", actions: [Status] })),
  );
};

export const publicReaderTypes = () => {
  // A public handler reading the identity owes it per request: the protected sibling's
  // authentication never provides it to a public route.
  const mixed = Action.implement(
    [Status, Double],
    {
      status: () => Effect.as(CurrentActor, { service: "pins", users: 1 }),
      double: handlers.double,
    },
    { authorize: Action.allowAll },
  );

  const routes = ActionHttp.layer(
    ActionHttp.make([Status, Double], { authentication: Login }),
    mixed,
  ).pipe(Layer.provide(authenticate));

  expectTypeOf<
    HttpRouter.Request.Only<"Requires", Layer.Services<typeof routes>>
  >().toEqualTypeOf<CurrentActor>();
  // @ts-expect-error `status` still owes the caller, beside `double`'s authentication.
  void run(Testing.layer(routes));
};

export const checkTypes = () => {
  // The declaration, never the callback, decides what a check fails with and reads per call.
  class Unexpected extends Schema.TaggedError<Unexpected>()("Unexpected", {}) {}

  const unexpected = Effect.succeed(() => Effect.fail(new Unexpected()));
  const limited = Effect.succeed(() => Effect.fail(new RateLimited({ retryAfter: 1 })));

  // @ts-expect-error `Limited` declares `RateLimited` alone.
  Layer.effect(Limited, unexpected);
  Layer.effect(Limited, limited);

  const stranger = Effect.succeed(() => Effect.asVoid(Stranger));
  const actor = Effect.succeed(() => Effect.asVoid(CurrentActor));

  // @ts-expect-error `Limited` reads `CurrentActor` per call, not `Stranger`.
  Layer.effect(Limited, stranger);
  Layer.effect(Limited, actor);

  // A callback that builds nothing, given as it is, is checked the same way.
  // @ts-expect-error `Limited` reads `CurrentActor` per call, not `Stranger`.
  Layer.succeed(Limited, () => Effect.asVoid(Stranger));
  Layer.succeed(Limited, () => Effect.asVoid(CurrentActor));

  // The callback receives any action, never its input.
  Layer.effect(
    Limited,
    Effect.succeed((action) => {
      expectTypeOf(action).toEqualTypeOf<Action.Any>();

      return Effect.void;
    }),
  );

  // A check's error is its actions' own: listed in their errors and decoded by every client.
  type Client = ActionHttp.Client<ActionHttp.Binding<[typeof Rename]>>;

  expectTypeOf<
    Extract<Effect.Error<ReturnType<Client["rename"]>>, RateLimited>
  >().toEqualTypeOf<RateLimited>();
  expectTypeOf<
    Extract<(typeof Rename.errors)[number]["Type"], RateLimited>
  >().toEqualTypeOf<RateLimited>();
};

// A descriptor's security middleware spells Effect's middleware marker, which Effect does not
// export: should Effect's change, these fail, rather than its endpoints owing what it provides.
expectTypeOf<SecurityMiddleware<Stranger>>().toExtend<HttpApiMiddleware.AnyId>();

expectTypeOf<HttpApiMiddleware.Provides<SecurityMiddleware<Stranger>>>().toEqualTypeOf<Stranger>();

expectTypeOf<HttpApiMiddleware.Requires<SecurityMiddleware<Stranger>>>().toEqualTypeOf<never>();
