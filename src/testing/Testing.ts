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
 * The native `HttpClient`, answered by `handler` instead of the network: a web handler the test
 * serves and disposes of, which other tests and raw web `Request`s may share, such as
 * `HttpRouter.toWebHandler(routes.pipe(Layer.provide(HttpServer.layerServices))).handler`. It is
 * the client `layer(routes)` gives, building nothing; most tests want that one, below.
 */
export function layer(
  handler: (request: Request) => Promise<Response>,
): Layer.Layer<HttpClient.HttpClient>;
// Why: The routes overload stays last, since TypeScript reports an argument of neither form against
// the last overload alone.
/**
 * The native `HttpClient`, answered in memory by `routes` instead of the network, for
 * `ActionHttp.client`, `ActionMcp.client` and `HttpClient.execute`. The routes are built with this
 * layer and released with its scope, keep their real authentication, so a client sends its
 * caller's credential, and require what they require under `HttpRouter.serve`: a builder's
 * services, and a per-request service no middleware of theirs provides, a global middleware's
 * included. Guide: `docs/Testing.md` in this package; in an application:
 * `examples/notes-service/test/`. A type error at `it.effect`, such as one naming `Scope`:
 * `docs/Testing-failures.md`.
 *
 * **Gotchas**
 *
 * - Every request on its client reaches the routes, whatever its host: a relative URL resolves against `http://localhost`, and a client given a `baseUrl`, a remote `ActionCli` command's included, runs unchanged.
 * - The client is the layer's own: the program's other HTTP clients get none of its requests, so a fake upstream is another `HttpClient`, provided to the service that calls out.
 * - A service the test reads too is provided around it once, with `Layer.provideMerge`: provided to the routes and again to the test, it is two instances, and the test reads one the handlers never changed.
 * - Requests run in the context it is built in: a `ConfigProvider` or the test clock provided around the test reaches middleware and handlers.
 * - No request is logged: only the cause of a defect, of a result that does not encode or of a failure a route leaves unhandled, as an error on the process console, even under `it.effect`'s `TestConsole`; a client reads it as an empty 500.
 * - It never requires `FileSystem`, `Path`, `HttpPlatform` or `Etag.Generator`: one provided around it is the routes', and `HttpServer.layerServices`' defaults stand in for the rest, whose `FileSystem` is a no-op, so a file the routes read is `NotFound` until `NodeFileSystem.layer` is provided around it.
 * - It answers HTTP requests and cannot upgrade a WebSocket: give an rpc layer `RpcServer.layerProtocolHttp` in the test, and its client `RpcClient.layerProtocolHttp` over this layer.
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
