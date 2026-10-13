import {
  Cause,
  Console,
  Context,
  Effect,
  ErrorReporter,
  FileSystem,
  Layer,
  Option,
  Path,
  type Scope,
} from "effect";
import {
  Etag,
  type HttpClient,
  HttpEffect,
  HttpPlatform,
  HttpRouter,
  type HttpServerRequest,
} from "effect/http";
import { clientOf, type Served } from "./memory.js";

/**
 * For a web handler the test already owns; most tests want `layer(routes)`, below, with
 * `ActionHttp.client` and `ActionMcp.client`. The native `HttpClient`, answered by `handler`
 * instead of the network: a web handler the test serves, which other tests may share, such as
 * `HttpRouter.toWebHandler(routes.pipe(Layer.provide(HttpServer.layerServices))).handler`,
 * the routes' platform services provided, as `layer(routes)` provides them itself. It is the
 * client `layer(routes)` gives, without building anything: the test owns the handler, and
 * disposes of it.
 */
export function layer(
  handler: (request: Request) => Promise<Response>,
): Layer.Layer<HttpClient.HttpClient>;
// Why: The routes overload stays last, since TypeScript reports an argument of neither form against
// the last overload alone.
/**
 * The native `HttpClient`, answered in memory by `routes` instead of the network: provide
 * it to `ActionHttp.client` and to `ActionMcp.client`. The routes are built with this layer and
 * released with its scope, without request logs: only the cause of a defect, of a result that
 * does not encode or of a failure a route of your own leaves unhandled is logged, as an error,
 * where a server's request logger would show it, on the process console even under `it.effect`
 * and its `TestConsole`. What they still require is this layer's, as
 * under `HttpRouter.serve`: a builder's services, and a per-request service no middleware of
 * theirs provides, including one a global middleware reads. The routes keep their real
 * authentication: a client sends its caller's credential. Provided around it, the test
 * program shares them. It never requires
 * the platform services, `FileSystem`, `Path`, `HttpPlatform` and `Etag.Generator`: one
 * provided around it is the routes' too, and `HttpServer.layerServices`' defaults stand in for
 * the rest, whose `FileSystem` is a no-op. A relative URL resolves against `http://localhost`.
 * The client is the layer's own: the program's other HTTP clients get none of its requests,
 * and it none of theirs.
 * Guide: `docs/Testing.md` in this package; in an application: `examples/notes-service/test/`.
 * A type error at `it.effect`, such as one naming `Scope`: `docs/Testing-failures.md`.
 */
export function layer<A, E, R>(
  routes: Layer.Layer<A, E, R>,
): Layer.Layer<
  HttpClient.HttpClient,
  E,
  Exclude<
    | HttpRouter.Request.Without<R>
    | HttpRouter.Request.Only<"Requires", R>
    | HttpRouter.Request.Only<"GlobalRequires", R>,
    Served
  >
>;
export function layer(
  routes: Layer.Layer<unknown, unknown, unknown> | ((request: Request) => Promise<Response>),
): Layer.Layer<HttpClient.HttpClient, unknown, unknown> {
  if (!Layer.isLayer(routes)) return clientOf(routes);

  return Layer.unwrap(
    Effect.gen(function* () {
      const fileSystem = Option.getOrElse(yield* Effect.serviceOption(FileSystem.FileSystem), () =>
        FileSystem.makeNoop({}),
      );

      const platform = yield* Layer.build(
        Layer.fresh(
          Layer.mergeAll(HttpPlatform.layer, Path.layer, Etag.layerWeak).pipe(
            Layer.provideMerge(Layer.succeed(FileSystem.FileSystem, fileSystem)),
          ),
        ),
      );

      const context = Context.merge(platform, yield* Effect.context<never>());

      const app = yield* HttpRouter.toHttpEffect(routes).pipe(Effect.provideContext(context));

      return clientOf(
        HttpEffect.toWebHandlerWith<never, HttpServerRequest.HttpServerRequest | Scope.Scope>(
          context,
        )(
          Effect.tapCause(app, (cause) =>
            isReported(cause)
              ? Effect.logError(cause).pipe(
                  Effect.provideService(Console.Console, globalThis.console),
                )
              : Effect.void,
          ),
        ),
      );
    }),
  );
}

// Why: A server's request logger shows the cause of an empty 500, and a test runs none: the
// cause is logged here, or a test sees a status and nothing else. Only a failure that reaches
// the router unhandled, so a 404 or a refusal stays silent, as every request that succeeds
// does. Rejected: Effect's request logger, a line for every request of every test. The log is
// given the process console: `it.effect` provides a `TestConsole`, which would keep it from
// the test's output.
const isReported = (cause: Cause.Cause<unknown>): boolean =>
  cause.reasons.some(
    (reason) =>
      (Cause.isFailReason(reason) && !ErrorReporter.isIgnored(reason.error)) ||
      (Cause.isDieReason(reason) && !ErrorReporter.isIgnored(reason.defect)),
  );
