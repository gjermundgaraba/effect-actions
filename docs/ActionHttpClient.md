# ActionHttpClient

A typed client for an HTTP binding: one method per action, taking the action's input and
answering with its decoded success. It is Effect's native `HttpApiClient`, reshaped.

## API

Import `@gjermundgaraba/effect-actions/ActionHttpClient`.

| API                    | Purpose                                                                                  |
| ---------------------- | ---------------------------------------------------------------------------------------- |
| `make(http, options?)` | An Effect of the client; requires the native `HttpClient`, as `HttpApiClient.make` does. |
| `Client`               | The client's type: `Client<typeof Http>`.                                                |

The client is `client.<action>(input)`, one method per action of the binding.

The options are the native `HttpApiClient.make` options except `transformResponse`, which
may change a call's success, failure or required services, which the method types cannot
follow; use `transformClient`, or the native client.

| Option            | Meaning                                                                                                                         |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `baseUrl`         | What routes are resolved against, such as `https://api.example.com`. Omitted: relative routes (the page's origin in a browser). |
| `transformClient` | Wraps the native `HttpClient`. A bearer token: `HttpClient.mapRequest(HttpClientRequest.bearerToken(token))`.                   |

A method takes the action's decoded input and answers with its decoded success. The argument
may be omitted when `{}` is a valid input, such as for an action declared without `input`
(`client.whoAmI()`) or one whose fields are all optional; omitting it sends `{}`.

A method fails with the action's declared errors, the built-in `Action.InvalidInput`,
`Action.Unauthenticated` and `Action.Forbidden`, `HttpClientError`, and `SchemaError`.

## Canonical

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

// Every endpoint declares the built-in refusals, so the 401 the authentication
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

Other headers also go through `transformClient` (`HttpClient.mapRequest(HttpClientRequest.setHeader("x-agent", agent))`).
Code that does not run Effects runs the program with `Effect.runPromise`, as above.

## Rules

- A method fails with exactly what the native client fails with. Declared errors arrive as their decoded values: the action's own and the three built-in errors every endpoint declares. Match them with `Effect.catchTag`.
- Anything the contract does not account for is Effect's own error. `HttpClientError`: the server could not be reached (`response` is `undefined`); or answered with a status no schema declares (`reason._tag` `DecodeError`), such as the empty 500 of a defect; or with a declared status whose body did not decode (`StatusCodeError`). `SchemaError`: the input did not encode, or the success body did not decode.
- The library interprets no status. Which failures mean "signed out" or "try again" is the caller's decision.
- Nothing is retried. A failed write may or may not have happened; only a declared error says what the server did.
- Every action of the binding has a method, whether or not a server serves it. An unserved action answers 404 with no body, so its method fails with `HttpClientError`: `DecodeError`, or `StatusCodeError` when the action declares a 404 error, whose body the empty response is not.
- A given argument is sent as given: `null` or `undefined` is the input itself, for a schema that accepts it.
- The client holds no connections or timers. `make` builds the native client once from the `HttpClient` in context.
- The native client stays available: `HttpApiClient.make(Http.api)` has the same routes, with methods taking `{ payload }` (see [ActionHttp.md](ActionHttp.md)).
- In tests, provide `Testing.layer(routes)` instead of a network client; `baseUrl` may be left out ([Testing.md](Testing.md)).

## Failure modes

- Fails with `HttpClientError` whose `reason._tag` is `DecodeError` for a status such as 429: the server answered with a status no schema declares. Declare that error on the action, or handle the native error. The built-in 400, 401 and 403 always decode, as long as their body is the built-in error's JSON.
- Fails with `HttpClientError` whose `reason._tag` is `InvalidUrlError` outside a browser: `baseUrl` is omitted, and there is no page to resolve relative routes against. Set `baseUrl`.
- Type error listing `HttpClient` as an unsatisfied requirement of `make`: provide one, such as `FetchHttpClient.layer`.
- Property does not exist on the client: the action is not in the binding.
- `Expected 1 arguments`: `{}` is not a valid input for the action, so it needs its input.
- Type error passing `undefined` to a method whose argument may be omitted: leave the argument out instead.
- Type error passing `{ payload: ... }`: that is the native client's shape. These methods take the input itself.
