import { Context, Effect, Schema, SchemaAST } from "effect";
import { Headers, HttpEffect, HttpRouter, HttpServerResponse } from "effect/unstable/http";
import type * as Action from "./Action.js";

export interface Options<A, Errors extends ReadonlyArray<Action.Codec>, R> {
  readonly authenticate: Effect.Effect<A, Errors[number]["Type"], R>;
  readonly errors: Errors;
  readonly headers?: (error: Errors[number]["Type"]) => Headers.Input;
}

/**
 * Authenticate each request and provide its identity to the downstream handler.
 * Only authentication failures are encoded, using each schema's httpApiStatus.
 * Dependencies remain native router request requirements. Acquired resources live
 * until the request scope closes, including while the handler is running.
 */
export const middleware = <I, A, const Errors extends ReadonlyArray<Action.Codec>, R>(
  service: Context.Key<I, A>,
  options: Options<NoInfer<A>, Errors, R>,
) => {
  const errors = options.errors.map((schema) => ({
    matches: Schema.is(schema),
    encode: HttpServerResponse.schemaJson(schema),
    status: SchemaAST.resolveAt<number>("httpApiStatus")(schema.ast) ?? 500,
  }));
  return HttpRouter.middleware<{ provides: I }>()((httpEffect) =>
    options.authenticate.pipe(
      Effect.matchEffect({
        onFailure: (error) => {
          const selected = errors.find((candidate) => candidate.matches(error));
          if (selected === undefined)
            return Effect.die(new Error("Undeclared authentication error"));
          return selected
            .encode(error, {
              status: selected.status,
              ...(options.headers === undefined ? {} : { headers: options.headers(error) }),
            })
            .pipe(Effect.orDie);
        },
        onSuccess: (identity) => Effect.provideService(httpEffect, service, identity),
      }),
      HttpEffect.withPreResponseHandler((_request, response) =>
        Effect.succeed(HttpServerResponse.setHeader(response, "cache-control", "no-store")),
      ),
    ),
  );
};
