# ActionHttpClient

Typed clients for an HTTP binding: one method per action, taking the action's input and
answering with its decoded success. `make` is an Effect client; `promise` is the same client
for code that does not run Effects, such as a browser page. Both are Effect's native
`HttpApiClient`, reshaped.

## API

Import `@gjermundgaraba/effect-actions/ActionHttpClient`.

| API                         | Purpose                                                                                  |
| --------------------------- | ---------------------------------------------------------------------------------------- |
| `make(http, options?)`      | An Effect of the client; requires the native `HttpClient`, as `HttpApiClient.make` does. |
| `promise(http, options?)`   | A Promise client over `fetch`, built synchronously.                                      |
| `Options`, `PromiseOptions` | Where and how requests are sent.                                                         |
| `Client`, `PromiseClient`   | The client's type: `Client<typeof Http>`, `PromiseClient<typeof Http>`.                  |

The client is `client.<action>(input)`, one method per action of the binding.

The options are the native `HttpApiClient.make` options except `transformResponse`; `promise`
adds `fetch`. `transformResponse` may change a call's success, failure or required services,
which the method types cannot follow; wrap `fetch`, use `transformClient`, or use the native
client.

| Option            | Meaning                                                                                                                         |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `baseUrl`         | What routes are resolved against, such as `https://api.example.com`. Omitted: relative routes (the page's origin in a browser). |
| `transformClient` | Wraps the native `HttpClient`. A bearer token: `HttpClient.mapRequest(HttpClientRequest.bearerToken(token))`.                   |
| `fetch`           | `promise` only. The transport. Defaults to the global `fetch`, looked up on each call.                                          |

A method takes the action's decoded input and answers with its decoded success. The argument
may be omitted when `{}` is a valid input, such as for an action declared without `input`
(`client.whoAmI()`) or one whose fields are all optional; omitting it sends `{}`.

## Canonical

Effect code:

```ts
import { Console, Effect } from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/unstable/http";
import * as ActionHttpClient from "@gjermundgaraba/effect-actions/ActionHttpClient";
import { Http } from "./binding.js";

const lookup = Effect.gen(function* () {
  const client = yield* ActionHttpClient.make(Http, {
    baseUrl: "http://127.0.0.1:3000",
    transformClient: HttpClient.mapRequest(HttpClientRequest.bearerToken("alice")),
  });

  const status = yield* client.status();
  const user = yield* client.getUser({ id: "1" });
  const identity = yield* client.whoAmI();

  return { status, user, identity };
});

// `Http` declares the surface's own failures, so the 401 the authentication
// middleware renders arrives as a typed `Unauthenticated`, not a decode error.
const refused = Effect.gen(function* () {
  const client = yield* ActionHttpClient.make(Http, { baseUrl: "http://127.0.0.1:3000" });

  return yield* Effect.flip(client.whoAmI());
});

await Effect.runPromise(
  Effect.all([lookup, refused]).pipe(
    Effect.tap(Console.log),
    Effect.provide(FetchHttpClient.layer),
  ),
);
```

### Promise

For code that does not run Effects, such as a browser page:

```ts
import { HttpClient, HttpClientError, HttpClientRequest } from "effect/unstable/http";
import * as ActionHttpClient from "@gjermundgaraba/effect-actions/ActionHttpClient";
import { Http } from "./binding.js";
import { UserNotFound } from "./contracts.js";

// Promises in, Promises out: for code that does not run Effects, such as a browser page.
// The options are the native `HttpApiClient.make` options plus `fetch`; a bearer token is
// a `transformClient`.
const client = ActionHttpClient.promise(Http, {
  baseUrl: "http://127.0.0.1:3000",
  transformClient: HttpClient.mapRequest(HttpClientRequest.bearerToken("alice")),
});

export const userName = async (id: string): Promise<string> => {
  try {
    return (await client.getUser({ id })).name;
  } catch (error) {
    // A declared error rejects as its own value...
    if (error instanceof UserNotFound) return "(no such user)";

    // ...and what the contract cannot account for as Effect's own `HttpClientError`.
    if (HttpClientError.isHttpClientError(error) && error.response === undefined) {
      return "(server unreachable)";
    }

    throw error;
  }
};
```

Other headers also go through `transformClient` (`HttpClient.mapRequest(HttpClientRequest.setHeader("x-agent", agent))`).
Reacting to a response every call may meet (a proxy's 401), or a token read per call, goes through
`fetch`: `fetch: (input, init) => { const request = new Request(input, init); request.headers.set("authorization", "Bearer " + readToken()); return fetch(request); }`.

## Rules

- A method fails (an Effect) or rejects (a Promise) with exactly what the native client fails with. Declared errors arrive as their decoded values: the action's own and the binding's `errors`. The Effect client types them all; classify a rejection with `instanceof`, its `_tag`, or `Schema.is`.
- Anything the contract does not account for is Effect's own error. `HttpClientError`: the server could not be reached (`response` is `undefined`); or answered with a status no schema declares (`reason._tag` `DecodeError`); or with a declared status whose body did not decode (`StatusCodeError`). `SchemaError`: the input did not encode, or the success body did not decode.
- The library adds no error type of its own and interprets no status. Which failures mean "signed out" or "try again" is the caller's decision.
- Nothing is retried. A failed write may or may not have happened; only a declared error says what the server did.
- Every action of the binding has a method, whether or not a server serves it. An unserved action answers 404 with no body, so its method fails with `HttpClientError`: `DecodeError`, or `StatusCodeError` when the action declares a 404 error, whose body the empty response is not.
- A given argument is sent as given: `null` or `undefined` is the input itself, for a schema that accepts it.
- The client holds no connections or timers. `promise` is synchronous and sends nothing; `make` builds the native client once from the `HttpClient` in context.
- The native client stays available: `HttpApiClient.make(Http.api)` has the same routes, with methods taking `{ payload }` (see [ActionHttp.md](ActionHttp.md)).

## Failure modes

- Fails with `HttpClientError` whose `reason._tag` is `DecodeError` for a 401 or 403: the surface answered with a status the binding does not declare. Add its error to `ActionHttp.make`'s `errors`, and have the middleware encode it. `StatusCodeError` instead: the status is declared, and the body is not that error's encoding.
- Fails with `HttpClientError` whose `reason._tag` is `InvalidUrlError` outside a browser: `baseUrl` is omitted, and there is no page to resolve relative routes against. Set `baseUrl`.
- Type error listing `HttpClient` as an unsatisfied requirement of `make`: provide one, such as `FetchHttpClient.layer`.
- A stubbed global `fetch` is not used by `promise`: `fetch` was passed as an option, which takes precedence.
- Property does not exist on the client: the action is not in the binding.
- `Expected 1 arguments`: `{}` is not a valid input for the action, so it needs its input.
- Type error passing `undefined` to a method whose argument may be omitted: leave the argument out instead.
- Type error passing `{ payload: ... }`: that is the native client's shape. These methods take the input itself.
