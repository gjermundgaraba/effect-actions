import { Match } from "effect";
import { Cookies, type HttpServerRequest } from "effect/http";
import type * as ActionRpc from "@gjermundgaraba/effect-actions/ActionRpc";

/** A header kept with a socket and sent again under each of its messages' own headers. */
export type Header = readonly [name: string, value: string];

const credentialOf = (
  binding: ActionRpc.Any,
  request: HttpServerRequest.HttpServerRequest,
): ReadonlyArray<Header> => {
  const security = binding.authentication?.security;

  if (security === undefined) return [];

  return Match.value(security).pipe(
    Match.tag("Http", "Basic", () => headersNamed(request, ["authorization"])),
    Match.tag("ApiKey", ({ in: location, key }) =>
      Match.value(location).pipe(
        Match.when("header", () => headersNamed(request, [key])),
        Match.when("cookie", () => {
          const value = request.cookies[key];

          return value === undefined
            ? []
            : [
                [
                  "cookie",
                  Cookies.toCookieHeader(
                    Cookies.fromIterable([Cookies.makeCookieUnsafe(key, value)]),
                  ),
                ] as const,
              ];
        }),
        Match.when("query", () => []),
        Match.exhaustive,
      ),
    ),
    Match.exhaustive,
  );
};

const headersNamed = (
  request: HttpServerRequest.HttpServerRequest,
  names: ReadonlyArray<string>,
): ReadonlyArray<Header> =>
  names.flatMap((name) => {
    const value = request.headers[name.toLowerCase()];

    return value === undefined ? [] : [[name.toLowerCase(), value] as const];
  });

/**
 * What a socket keeps from its upgrade request: the credential the binding's descriptor reads,
 * and the headers listed, as an upgrade request's headers are kept for its socket's messages
 * on a long-lived host.
 */
export const savedOf =
  (binding: ActionRpc.Any, listed: ReadonlyArray<string>) =>
  (request: HttpServerRequest.HttpServerRequest): ReadonlyArray<Header> => [
    ...credentialOf(binding, request),
    ...headersNamed(request, listed),
  ];
