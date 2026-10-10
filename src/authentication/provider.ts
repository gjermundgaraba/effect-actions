import { type Context, Effect, Option } from "effect";
import type { HttpRouter, HttpServerResponse } from "effect/http";
import type { HttpApiMiddleware, HttpApiSecurity } from "effect/http-api";
import type * as Action from "../contract/Action.js";
import { Anyone } from "../contract/rules.js";
import type { Protected, ServedRequest, Serving } from "../contract/implementation.js";
import { type Refusal, Unauthenticated } from "../contract/errors.js";

/** One native security scheme: Bearer unless a descriptor names another. */
export type Security = HttpApiSecurity.HttpApiSecurity;

/** What a native scheme decodes: a `Redacted` token or key, or Basic credentials. */
export type Credential = HttpApiSecurity.HttpApiSecurity.Type<Security>;

/** The provider of a descriptor's verifier: a type of its own, apart from the actor. */
export interface Provider<I, Name extends string = string> {
  readonly "~effect-actions/Authentication": I;
  readonly "~effect-actions/Authentication/Name": Name;
}

/**
 * The native security middleware a descriptor's protected endpoints carry, which provides
 * the identity: an identifier of its own, which no `Authentication.layer` provides, so only
 * `ActionHttp.layer` satisfies it, from the provider.
 */
export interface SecurityMiddleware<I, Name extends string = string> {
  readonly "~effect-actions/Authentication/Security": Name;
  readonly "~effect/http-api/HttpApiMiddleware": {
    readonly provides: I;
    readonly requires: never;
    readonly error: never;
    readonly clientError: never;
    readonly requiredForClient: false;
  };
}

type Response = Effect.Effect<HttpServerResponse.HttpServerResponse, unknown, unknown>;

export interface Runtime {
  /** The descriptor the provider was built from, the one a binding naming it must hold. */
  readonly descriptor: unknown;
  /**
   * The verifier itself, for a surface answering refusals its own way, such as RPC: the
   * credential to the identity, or a refusal, or an error the descriptor declares. An empty
   * credential, as the native decoder gives an absent one, is refused without reaching it.
   */
  readonly authenticate: (credential: Credential) => Effect.Effect<unknown, unknown, unknown>;
  /** The native security middleware's implementation, keyed by its scheme. */
  readonly middleware: Readonly<
    Record<string, (route: Response, options: { readonly credential: Credential }) => Response>
  >;
  /**
   * A protected HTTP route as it leaves the layer's middleware, a step-up refusal it fails with
   * answered with its challenge under Bearer; as it is under another scheme.
   */
  readonly stepUp: HttpApiMiddleware.HttpApiMiddleware<never, never, never>;
  /**
   * An MCP endpoint's request: decoded here, and a protected tool's call promotes what it
   * verified. Where `optional`, a request presenting no credential, which the scheme decodes as
   * empty, passes signed out.
   */
  readonly http: <E, R>(
    route: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>,
    optional: boolean,
  ) => Effect.Effect<HttpServerResponse.HttpServerResponse, E, R | HttpRouter.Provided>;
  /**
   * A route of the host's own: the request is decoded here, the route gets the identity
   * itself, and a refusal it fails with is answered as an action route's.
   */
  readonly route: <E, R>(
    route: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>,
  ) => Effect.Effect<
    HttpServerResponse.HttpServerResponse,
    Exclude<E, Refusal>,
    HttpRouter.Provided
  >;
}

/**
 * What an erased verifier fails with, a refusal or an error its descriptor declares: a value
 * of a declared schema either way, as the built-in refusals are schemas too.
 */
export type VerifierFailure = Action.Errors[number]["Type"];

/**
 * What `Authentication.make` declares: its name, the identity it authenticates, its scheme,
 * and what its verifier may fail with besides a refusal. The `~` keys are the library's own
 * wiring, which no host composes.
 */
export interface Descriptor<
  I,
  A,
  S extends Security,
  Name extends string = string,
  E extends Action.Errors = readonly [],
> {
  readonly name: Name;
  readonly identity: Context.Key<I, A>;
  readonly security: S;
  /**
   * What its verifier may fail with besides a refusal, as a list: every protected endpoint
   * declares it, and every remote surface sends it with its status.
   */
  readonly error: E;
  readonly "~provider": Context.Key<Provider<I, Name>, Runtime>;
  readonly "~middleware": Context.Key<SecurityMiddleware<I, Name>, unknown>;
  /** An MCP request's verified identity, which a protected tool's call promotes. */
  readonly "~verified": Context.Key<never, unknown>;
}

/**
 * Any descriptor `make` returns, named so a package emitting declarations can export one, and a
 * binding name one.
 */
export type Any = Descriptor<unknown, unknown, Security, string, Action.Errors>;

export type Identity<A extends Action.Any> = [A] extends [never]
  ? never
  : A["caller"] extends Context.Key<infer I, unknown>
    ? I
    : never;

/**
 * The identity a descriptor for `A` must authenticate: `unknown` for an erased action, whose
 * key is known only at run time, where `assertAuthentication` checks it.
 */
type Covered<A extends Action.Any> =
  Exclude<A["caller"], typeof Anyone> extends Context.Key<infer I, unknown> ? I : never;

export type Required<A extends Action.Any> = [Protected<A>] extends [never]
  ? { readonly authentication?: Any }
  : {
      readonly authentication: Descriptor<
        Covered<Protected<A>>,
        unknown,
        Security,
        string,
        Action.Errors
      >;
    };

export type ProviderOf<D> =
  D extends Descriptor<infer I, unknown, Security, infer Name, Action.Errors>
    ? Provider<I, Name>
    : never;

/** Actions a binding takes without options: public ones, as a protected one names its descriptor. */
export type PublicOnly<Actions extends ReadonlyArray<Action.Any>> = [
  Exclude<Actions[number], { readonly caller: typeof Anyone }>,
] extends [never]
  ? unknown
  : { readonly "Protected actions take options naming their authentication": never };

/** The descriptor options `O` name, where they always name one. */
export type DescriptorOf<O> = [O] extends [{ readonly authentication: infer D extends Any }]
  ? D
  : undefined;

/** All protected actions on a surface use the descriptor's single identity key. */
export type Matching<A extends Action.Any, D> =
  unknown extends Covered<Protected<A>>
    ? unknown
    : [
          Exclude<
            Covered<Protected<A>>,
            D extends Descriptor<infer I, unknown, Security, string, Action.Errors> ? I : never
          >,
        ] extends [never]
      ? unknown
      : { readonly "Authentication descriptor does not cover every protected action": never };

/** Keep public requirements separate, without rescanning all handlers for every action. */
export type RemoteRequest<App, A extends Action.Any> =
  | ServedRequest<App, Extract<A, { readonly caller: typeof Anyone }>>
  | Exclude<ServedRequest<App, Protected<A>>, Identity<Protected<A>>>;

/**
 * What a call of `A` under the descriptor `D` may fail with from its verifier: the errors `D`
 * declares, for a protected action; none for a public one, which nothing verifies.
 */
export type VerifierError<A extends Action.Any, D> = A["caller"] extends typeof Anyone
  ? never
  : D extends { readonly error: infer E extends Action.Errors }
    ? E[number]
    : never;

export type ServedProvider<App, A extends Action.Any, D> = [Protected<Serving<App, A>>] extends [
  never,
]
  ? never
  : ProviderOf<D>;

export const assertAuthentication = (
  actions: ReadonlyArray<Action.Any>,
  auth: Any | undefined,
): void => {
  for (const action of actions) {
    if (
      action.caller !== Anyone &&
      (auth === undefined || action.caller.key !== auth.identity.key)
    ) {
      throw new Error(
        `Protected action '${action.name}' requires its matching authentication descriptor`,
      );
    }
  }
};

/**
 * The provider of `auth`, as a surface serving a binding that names it reads it: a provider of
 * another descriptor of the same name, built apart, may differ in what its verifier fails
 * with, so it is refused.
 */
export const providerOf = (auth: Any): Effect.Effect<Runtime, never, Provider<unknown>> =>
  Effect.flatMap(Effect.service(auth["~provider"]), (provider) =>
    provider.descriptor === auth
      ? Effect.succeed(provider)
      : Effect.die(
          new Error(
            `Authentication "${auth.name}": the binding's descriptor is not its provider's; build both from one descriptor`,
          ),
        ),
  );

/** Remote promotion happens at tool entry, before shared dispatch, never in local calls. */
export const promote = <A, E, R>(
  auth: Any,
  run: Effect.Effect<A, E, R>,
): Effect.Effect<A, E | Unauthenticated, R> =>
  Effect.flatMap(
    Effect.serviceOption(auth["~verified"]),
    (actor): Effect.Effect<A, E | Unauthenticated, R> =>
      Option.isSome(actor)
        ? Effect.provideService(run, auth.identity, actor.value)
        : Effect.fail(new Unauthenticated()),
  );
