# ActionHttpClient

A Promise client for an HTTP binding, for code that does not run Effects, such as a browser
page. It is Effect's native `HttpApiClient` over `fetch`, built once; each call is one request.

## API

Import `@gjermundgaraba/effect-actions/ActionHttpClient`.

| API                       | Purpose                                                                       |
| ------------------------- | ----------------------------------------------------------------------------- |
| `promise(http, options?)` | `client.<group>.<action>(input)` for every HTTP-served action of the binding. |
| `Options`                 | Where and how requests are sent.                                              |
| `Client`, `Method`        | The client's type, derived from the binding, and one action's method.         |

| Option    | Meaning                                                                                                                         |
| --------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `baseUrl` | What routes are resolved against, such as `https://api.example.com`. Omitted: relative routes (the page's origin in a browser). |
| `token`   | Sent as `Authorization: Bearer <token>` with every call.                                                                        |
| `fetch`   | The transport. Defaults to the global `fetch`, looked up on each call.                                                          |

A method takes the action's decoded input and resolves with its decoded success. An action
whose input may be empty (no `input`, or only optional fields) may be called without an argument.

## Canonical

```ts
import { HttpClientError } from "effect/unstable/http";
import * as ActionHttpClient from "@gjermundgaraba/effect-actions/ActionHttpClient";
import { Http, UserNotFound } from "./contracts.js";

// Promises in, Promises out: for code that does not run Effects, such as a browser page.
const client = ActionHttpClient.promise(Http, {
  baseUrl: "http://127.0.0.1:3000",
  token: "alice",
});

export const userName = async (id: string): Promise<string> => {
  try {
    return (await client.users.getUser({ id })).name;
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

Other headers, or reacting to a response every call may meet (a proxy's 401), go through
`fetch`: `fetch: (input, init) => { const request = new Request(input, init); request.headers.set("x-agent", agent); return fetch(request); }`.

## Rules

- A call rejects with exactly what the native client's Effect fails with. Declared errors arrive as their decoded values: the action's own (its group's `errors` included), its group's schema-error policy's, and the binding's surface `errors`. Classify them with `instanceof`, their `_tag`, or `Schema.is`.
- Anything the contract does not account for rejects with Effect's own error. `HttpClientError`: the server could not be reached (`response` is `undefined`), or answered with a status no schema declares, or with a body that could not be read. `SchemaError`: the input did not encode, or the success body did not decode.
- The library adds no error type of its own and interprets no status. Which failures mean "signed out" or "try again" is the caller's decision.
- Nothing is retried. A rejected write may or may not have happened; only a declared error says what the server did.
- Only HTTP-served actions have methods. An action with `http: false` is absent, and so is a group without HTTP actions.
- The client holds no connections or timers. Making one is synchronous and sends nothing.
- A method is not an Effect. Code that runs Effects uses `HttpApiClient.make(Http.api)` directly (see [ActionHttp.md](ActionHttp.md)); its methods take `{ payload }`.

## Failure modes

- Rejects with `HttpClientError` whose `reason._tag` is `StatusCodeError` for a 401 or 403: the surface answered with an error the binding does not declare. Add it to `ActionHttp.make`'s `errors`, and have the middleware encode it.
- Rejects with `HttpClientError` whose `reason._tag` is `InvalidUrlError` outside a browser: `baseUrl` is omitted, and there is no page to resolve relative routes against. Set `baseUrl`.
- A stubbed global `fetch` is not used: `fetch` was passed as an option, which takes precedence.
- Property does not exist on the client: the action is `http: false`, or its group is not bound in this `Http`.
