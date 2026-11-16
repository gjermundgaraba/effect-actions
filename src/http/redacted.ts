import { Function, Match } from "effect";
import type { HttpApi } from "effect/http-api";

import type { Any as Authentication } from "../authentication/provider.js";

/**
 * Where an API key scheme sends its credential, for `HttpApi.RedactedNames`: a span records a
 * request's query, and a header that the host's `TracerHeaderFilter` admits, as sent unless it
 * is named there or by Effect's defaults, which already cover `Authorization` and `Cookie`.
 */
export const credentialNames = (
  authentication: Authentication | undefined
): HttpApi.RedactedNames["Service"] =>
  authentication === undefined
    ? {}
    : Match.value(authentication.security).pipe(
        Match.tag("ApiKey", ({ in: placement, key }) =>
          Match.value(placement).pipe(
            Match.when("query", () => ({ query: [key] })),
            Match.when("header", () => ({ headers: [key] })),
            Match.when("cookie", Function.constant({})),
            Match.exhaustive
          )
        ),
        Match.tag("Http", "Basic", Function.constant({})),
        Match.exhaustive
      );
