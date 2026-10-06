import { type Context, Effect, Option } from "effect";
import type { HttpRouter, HttpServerResponse } from "effect/http";
import type { HttpApiMiddleware, HttpApiSecurity } from "effect/http-api";
import type * as Action from "../Action.js";
import type { Protected, ServedRequest, Serving } from "./implementation.js";
import { type Refusal, Unauthenticated } from "./errors.js";

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
  /** The native security middleware's implementation, keyed by its scheme. */
  readonly middleware: Readonly<
    Record<string, (route: Response, options: { readonly credential: Credential }) => Response>
  >;
  /**
   * A protected HTTP route as it leaves the layer's middleware, a step-up refusal it fails with
   * answered with its challenge under Bearer; as it is under another scheme.
   */
  readonly stepUp: HttpApiMiddleware.HttpApiMiddleware<never, never, never>;
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
 * What `Authentication.make` declares: its name, the identity it authenticates and its
 * scheme. The `~` keys are the library's own wiring, which no host composes.
 */
export interface Descriptor<I, A, S extends Security, Name extends string = string> {
  readonly name: Name;
  readonly service: Context.Key<I, A>;
  readonly security: S;
  readonly "~provider": Context.Key<Provider<I, Name>, Runtime>;
  readonly "~middleware": Context.Key<SecurityMiddleware<I, Name>, unknown>;
  /** An MCP request's verified identity, which a protected tool's call promotes. */
  readonly "~verified": Context.Key<never, unknown>;
}

export type Any = Descriptor<unknown, unknown, Security>;

export type Identity<A extends Action.Any> = [A] extends [never]
  ? never
  : A["auth"] extends Context.Key<infer I, unknown>
    ? I
    : never;

/**
 * The identity a descriptor for `A` must authenticate: `unknown` for an erased action, whose
 * key is known only at run time, where `assertAuthentication` checks it.
 */
type Covered<A extends Action.Any> =
  Exclude<A["auth"], "public"> extends Context.Key<infer I, unknown> ? I : never;

export type Required<A extends Action.Any> = [Protected<A>] extends [never]
  ? { readonly authentication?: Any }
  : { readonly authentication: Descriptor<Covered<Protected<A>>, unknown, Security> };

export type ProviderOf<D> =
  D extends Descriptor<infer I, unknown, Security, infer Name> ? Provider<I, Name> : never;

/** All protected actions on a surface use the descriptor's single identity key. */
export type Matching<A extends Action.Any, D> =
  unknown extends Covered<Protected<A>>
    ? unknown
    : [
          Exclude<
            Covered<Protected<A>>,
            D extends Descriptor<infer I, unknown, Security> ? I : never
          >,
        ] extends [never]
      ? unknown
      : { readonly "Authentication descriptor does not cover every protected action": never };

/** Keep public requirements separate, without rescanning all handlers for every action. */
export type RemoteRequest<App, A extends Action.Any> =
  | ServedRequest<App, Extract<A, { readonly auth: "public" }>>
  | Exclude<ServedRequest<App, Protected<A>>, Identity<Protected<A>>>;

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
    if (action.auth !== "public" && (auth === undefined || action.auth.key !== auth.service.key)) {
      throw new Error(
        `Protected action '${action.name}' requires its matching authentication descriptor`,
      );
    }
  }
};

/** Remote promotion happens at tool entry, before shared dispatch, never in local calls. */
export const promote = <A, E, R>(
  auth: Any,
  run: Effect.Effect<A, E, R>,
): Effect.Effect<A, E | Unauthenticated, R> =>
  Effect.flatMap(
    Effect.serviceOption(auth["~verified"]),
    (actor): Effect.Effect<A, E | Unauthenticated, R> =>
      Option.isSome(actor)
        ? Effect.provideService(run, auth.service, actor.value)
        : Effect.fail(new Unauthenticated({ message: "Authentication is required." })),
  );
