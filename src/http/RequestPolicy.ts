import { Effect } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";

/** The public address and additional browser origins accepted by the policy. */
export interface Options {
  /**
   * The origin browsers reach this app at. The application has already validated it;
   * its `host` (with port, when the scheme's default is not used) must equal the Host
   * header, and its `origin` is the one Origin accepted by default.
   */
  readonly publicUrl: URL;
  /**
   * Origins accepted besides the public one, compared exactly. For a desktop shell
   * whose renderer has a private scheme, such as `wtf://app`. No wildcards.
   */
  readonly allowedOrigins?: readonly string[];
}

const uncheckedProbePath = "/healthz";

/** One request, as a Node `upgrade` handler or a router middleware sees it. */
export interface Request {
  /** The request target: `/a?b` or an absolute URL. Only its path is read. */
  readonly target: string;
  readonly host: string | undefined;
  readonly origin: string | undefined;
}

const pathOf = (target: string): string => {
  const authority = target.indexOf("://");
  const start = authority === -1 ? 0 : target.indexOf("/", authority + 3);

  if (start === -1) {
    return "/";
  }

  const rest = target.slice(start);
  const stop = rest.search(/[?#]/u);

  return stop === -1 ? rest : rest.slice(0, stop);
};

const forbidden = HttpServerResponse.text("Forbidden", { status: 403 });

/**
 * Build a Host/Origin policy once at startup. `allows` takes no services, so a
 * raw request or Node upgrade handler applies the same rule as the router.
 * The middleware answers refused requests with status 403 and text `Forbidden`.
 *
 * **Gotchas**
 * - `/healthz` is unchecked, including its query and fragment; do not serve application data there.
 * - Provide `middleware.layer` to every route layer to protect; it is not global middleware.
 * - This checks browser request headers, not caller identity; access control belongs to the application or its network.
 */
export const make = (options: Options) => {
  const { host } = options.publicUrl;

  const origins = new Set([
    options.publicUrl.origin,
    ...(options.allowedOrigins ?? []),
  ]);

  const allows = (request: Request): boolean => {
    if (pathOf(request.target) === uncheckedProbePath) {
      return true;
    }

    if (request.host !== host) {
      return false;
    }

    return request.origin === undefined || origins.has(request.origin);
  };

  return {
    allows,
    middleware: HttpRouter.middleware((httpEffect) =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;

        const permitted = allows({
          target: request.originalUrl,
          host: request.headers["host"],
          origin: request.headers["origin"],
        });

        return permitted ? yield* httpEffect : forbidden;
      })
    ),
  };
};

/** A pure request decision and the matching native router middleware. */
export type Policy = ReturnType<typeof make>;
