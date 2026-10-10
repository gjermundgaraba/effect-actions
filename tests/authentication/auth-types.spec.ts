import { Context, Effect, Layer, Redacted, type Scope } from "effect";
import type { HttpRouter } from "effect/http";
import { type HttpApiMiddleware, HttpApiSecurity } from "effect/http-api";
import { expectTypeOf } from "@effect/vitest";
import * as Action from "../../src/contract/Action.js";
import * as ActionHttp from "../../src/http/ActionHttp.js";
import * as ActionMcp from "../../src/mcp/ActionMcp.js";
import * as ActionToolkit from "../../src/toolkit/ActionToolkit.js";
import * as Authentication from "../../src/authentication/Authentication.js";
import * as Testing from "../../src/testing/Testing.js";
import type { SecurityMiddleware } from "../../src/authentication/provider.js";
import { authenticate } from "../../examples/authentication.js";
import { actors, CurrentActor } from "../../examples/authorization.js";
import { Login } from "../../examples/binding.js";
import { Double, Status } from "../../examples/contracts.js";

declare const erasedImplementation: Action.Implementation<Action.Any, never, never, never>;

class Stranger extends Context.Service<Stranger, string>()("auth-types/Stranger") {}

class Permissions extends Context.Service<Permissions, ReadonlySet<string>>()(
  "auth-types/Permissions",
) {}

const handlers = {
  status: () => Effect.succeed({ service: "pins", users: 0 }),
  double: ({ value }: { readonly value: number }) => Effect.succeed(value * 2),
};

const appNotReadingIdentity = Action.implement([Status, Double], handlers, {
  authorize: Action.allowAll,
});

const guardedByStartupPermissions = Action.implement([Status, Double], handlers, {
  authorize: Effect.map(
    Permissions,
    (permissions) => () =>
      permissions.has("double") ? Effect.void : Effect.fail(new Action.Forbidden()),
  ),
});

const run = <A, E>(layer: Layer.Layer<A, E>) =>
  Effect.runPromise(Effect.void.pipe(Effect.provide(layer)));

export const declarationTypes = () => {
  // @ts-expect-error -- A contract states who may call it.
  Action.make("unclassified", { description: "x", readOnly: true });
  Action.make("classified", { description: "x", readOnly: true, caller: Action.Anyone });

  // @ts-expect-error -- A protected binding names how its identity is verified.
  ActionHttp.make([Double]);
  ActionHttp.make([Double], { authentication: Login });

  const bindPublic = <
    const A extends ReadonlyArray<Action.Any & { readonly caller: typeof Action.Anyone }>,
  >(
    actions: A,
  ) => ActionHttp.make(actions);

  expectTypeOf(bindPublic([Status]).actions).toEqualTypeOf<readonly [typeof Status]>();

  const wrong = Authentication.make("auth-types.Wrong", Stranger);

  Authentication.make("auth-types.Two", Stranger, {
    // @ts-expect-error -- A record of schemes.
    security: { first: HttpApiSecurity.bearer, second: HttpApiSecurity.bearer },
  });
  // @ts-expect-error -- No scheme.
  Authentication.make("auth-types.None", Stranger, { security: {} });

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

  const maybeBasic: Authentication.Options & {
    readonly security?: typeof HttpApiSecurity.basic;
  } = {};

  const MaybeBearer = Authentication.make("auth-types.Maybe", Stranger, maybeBasic);

  Authentication.layer(MaybeBearer, (credential) => {
    expectTypeOf(credential).toEqualTypeOf<
      HttpApiSecurity.Credentials | Redacted.Redacted<string>
    >();

    return Effect.succeed("s");
  });

  // @ts-expect-error -- Explicit options naming a scheme require the options, which alone hold it.
  Authentication.make<
    "auth-types.Gone",
    Stranger,
    string,
    { readonly security: typeof HttpApiSecurity.basic }
  >("auth-types.Gone", Stranger);

  // @ts-expect-error -- No option `securty`.
  Authentication.make("auth-types.Typo", Stranger, { securty: HttpApiSecurity.basic });

  Authentication.layer(Session, () => Effect.succeed("s"), {
    // @ts-expect-error -- Only a Bearer scheme publishes an OAuth protected resource: a cookie names none.
    protectedResource: { resource: "https://a.example", authorizationServers: ["https://as"] },
  });

  // @ts-expect-error -- A descriptor of another identity does not cover the contract.
  ActionHttp.make([Double], { authentication: wrong });

  // @ts-expect-error -- A protected MCP endpoint names its authentication too.
  ActionMcp.layerHttp(appNotReadingIdentity, { name: "missing", version: "0", actions: [Double] });
  ActionMcp.layerHttp(appNotReadingIdentity, {
    name: "named",
    version: "0",
    actions: [Double],
    authentication: Login,
  });
  ActionMcp.layerHttp(appNotReadingIdentity, {
    name: "wrong",
    version: "0",
    actions: [Double],
    // @ts-expect-error -- A protected MCP endpoint names a descriptor of the contract's identity.
    authentication: wrong,
  });

  ActionMcp.layerHttp(erasedImplementation, {
    name: "erased",
    version: "0",
    authentication: Login,
  });
};

export const providerTypes = () => {
  const routes = ActionHttp.layer(
    ActionHttp.make([Double], { authentication: Login }),
    appNotReadingIdentity,
  );

  // @ts-expect-error -- Neither a caller nor a verifier is supplied.
  void run(Testing.layer(routes));
  void run(Testing.layer(routes.pipe(Layer.provide(authenticate))));

  // @ts-expect-error -- A startup identity cannot stand in for the verifier, around the program.
  void run(Testing.layer(routes).pipe(Layer.provide(Layer.succeed(CurrentActor, actors.alice))));
  // @ts-expect-error -- A startup identity provided to the routes cannot stand in for the verifier either.
  void run(Testing.layer(routes.pipe(Layer.provide(Layer.succeed(CurrentActor, actors.alice)))));

  const OtherLogin = Authentication.make("auth-types.OtherLogin", CurrentActor);

  const other = Authentication.layer(OtherLogin, () => Effect.succeed(actors.alice));

  // @ts-expect-error -- Another descriptor's verifier of the same identity is not this binding's.
  void run(Testing.layer(routes.pipe(Layer.provide(other))));

  const otherRoutes = ActionHttp.layer(
    ActionHttp.make([Double], { authentication: OtherLogin }),
    appNotReadingIdentity,
  );

  void run(Testing.layer(otherRoutes.pipe(Layer.provide(other))));
};

export const selectionTypes = () => {
  ActionMcp.layerHttp<typeof appNotReadingIdentity, { readonly actions: readonly [typeof Status] }>(
    appNotReadingIdentity,
    // @ts-expect-error -- The selection the type argument states is absent.
    { name: "lie", version: "0" },
  );
  ActionMcp.layerHttp<typeof appNotReadingIdentity, { readonly actions: readonly [typeof Status] }>(
    appNotReadingIdentity,
    {
      name: "selected",
      version: "0",
      actions: [Status],
    },
  );

  const inProcessCallOwingCaller = Effect.flatMap(
    Action.client(appNotReadingIdentity, { actions: [Double] }),
    (client) => client.double({ value: 2 }),
  ).pipe(Effect.scoped);

  expectTypeOf<Effect.Services<typeof inProcessCallOwingCaller>>().toEqualTypeOf<CurrentActor>();
  // @ts-expect-error -- The contract's identity is owed per call.
  void Effect.runPromise(inProcessCallOwingCaller);
  void Effect.runPromise(
    inProcessCallOwingCaller.pipe(Effect.provideService(CurrentActor, actors.alice)),
  );

  const toolkit = ActionToolkit.make(appNotReadingIdentity, { actions: [Double] });

  const tool = Effect.flatMap(toolkit.toolkit, (tools) =>
    tools.handle("double", { value: 2 }),
  ).pipe(Effect.provide(toolkit.layer));

  // @ts-expect-error -- A protected tool's call owes the caller.
  void Effect.runPromise(tool);
  void Effect.runPromise(tool.pipe(Effect.provideService(CurrentActor, actors.alice)));

  const publicSelection = Action.client(guardedByStartupPermissions, { actions: [Status] });

  const publicStatusCall = Effect.flatMap(publicSelection, (client) => client.status()).pipe(
    Effect.scoped,
  );

  expectTypeOf<Effect.Services<typeof publicSelection>>().toEqualTypeOf<Scope.Scope>();
  expectTypeOf<Effect.Services<typeof publicStatusCall>>().toBeNever();
  void Effect.runPromise(publicStatusCall);

  expectTypeOf<
    Effect.Services<ReturnType<typeof Action.client<typeof guardedByStartupPermissions>>>
  >().toEqualTypeOf<Permissions | Scope.Scope>();

  void run(Testing.layer(ActionHttp.layer(ActionHttp.make([Status]), guardedByStartupPermissions)));
  void run(
    Testing.layer(
      ActionMcp.layerHttp(guardedByStartupPermissions, {
        name: "open",
        version: "0",
        actions: [Status],
      }),
    ),
  );
};

export const publicReaderTypes = () => {
  const publicHandlerReadingIdentity = Action.implement(
    [Status, Double],
    {
      status: () => Effect.as(CurrentActor, { service: "pins", users: 1 }),
      double: handlers.double,
    },
    { authorize: Action.allowAll },
  );

  const routes = ActionHttp.layer(
    ActionHttp.make([Status, Double], { authentication: Login }),
    publicHandlerReadingIdentity,
  ).pipe(Layer.provide(authenticate));

  expectTypeOf<
    HttpRouter.Request.Only<"Requires", Layer.Services<typeof routes>>
  >().toEqualTypeOf<CurrentActor>();
  // @ts-expect-error -- `status` still owes the caller, beside `double`'s authentication.
  void run(Testing.layer(routes));
};

export const securityMiddlewareSpellsEffectsUnexportedMiddlewareMarker = () => {
  expectTypeOf<SecurityMiddleware<Stranger>>().toExtend<HttpApiMiddleware.AnyId>();

  expectTypeOf<
    HttpApiMiddleware.Provides<SecurityMiddleware<Stranger>>
  >().toEqualTypeOf<Stranger>();

  expectTypeOf<HttpApiMiddleware.Requires<SecurityMiddleware<Stranger>>>().toEqualTypeOf<never>();
};
