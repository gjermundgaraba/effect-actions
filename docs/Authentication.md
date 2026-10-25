# Authentication

How a remote caller proves the identity a protected action declares. `Authentication.make`
declares it, as a browser-safe descriptor; `Authentication.layer` is that descriptor's provider,
running the verifier you write. Verifying a token, login and consent stay in the application.

A message the library throws says its fix; for a compiler diagnostic or Effect's own error,
search [Authentication-failures.md](Authentication-failures.md). For one symbol,
`grep -rn <symbol> node_modules/@gjermundgaraba/effect-actions/dist/`: each declaration's JSDoc
carries its rules and gotchas, and this page only what an example cannot show.

## Declare how callers sign in

A protected action declares its identity service, `caller: CurrentUser`
([Action.md](Action.md#say-who-may-call-an-action)). Declare the descriptor beside that
service, in the contract file every client of the binding imports:

```ts example=notes-service/src/identity/Identity.ts
import { Context, Schema } from "effect";
import * as Action from "@gjermundgaraba/effect-actions/Action";
import * as Authentication from "@gjermundgaraba/effect-actions/Authentication";

export const scopes = { read: "notes:read", write: "notes:write" } as const;

export const Scope = Schema.Literals([scopes.read, scopes.write]);

export interface User {
  readonly id: string;
  readonly scopes: ReadonlyArray<typeof Scope.Type>;
}

/**
 * Who is calling. A protected action declares it, `caller: CurrentUser`; authentication
 * provides it per request, and a local host, such as the stdio server, provides it itself.
 */
export class CurrentUser extends Context.Service<CurrentUser, User>()(
  "notes-service/CurrentUser",
) {}

// How a remote caller proves it is CurrentUser: a bearer token, the default scheme. Clients
// import this descriptor with the binding; its verifier, in verifier.ts, stays on the server.
export const Login = Authentication.make("notes-service.Login", CurrentUser);

export const WhoAmI = Action.make("whoAmI", {
  description: "Show who the credential identifies and which scopes it holds.",
  success: { id: Schema.String, scopes: Schema.Array(Scope) },
  readOnly: true,
  caller: CurrentUser,
});
```

Name it in every binding and MCP endpoint that serves a protected action: an HTTP binding
([notes-service/src/Api.ts](../examples/notes-service/src/Api.ts)), an MCP endpoint
([notes-service/src/routes.ts](../examples/notes-service/src/routes.ts)) and an RPC binding
([live-rpc/src/Rpc.ts](../examples/live-rpc/src/Rpc.ts)); a local surface takes none
([Action.md](Action.md#say-who-may-call-an-action)). The name's rules are on
`Authentication.make`, the scheme's on `Authentication.Options.security`; a second credential
for one identity is in
[kitchen-sink/src/identity/Identity.ts](../examples/kitchen-sink/src/identity/Identity.ts).
A descriptor of protected [events](Event.md) may also say which subscriber an identity is, its
`principal`, for what a surface holds between one subscriber's requests:
[build-events/src/identity/Identity.ts](../examples/build-events/src/identity/Identity.ts). When
it is required is on `Authentication.Options.principal`; its `schema`, which keeps an identity
past a restart, on `Authentication.Options.schema`.

- **Protecting an action that tests already call breaks them**, at compile time
  ([Testing-failures.md](Testing-failures.md),
  [Authentication-failures.md](Authentication-failures.md#types-and-startup)), and a call over
  HTTP without a credential gets `Unauthenticated` at run time.

## Verify credentials

Write the verifier in a server-only module, give it to `Authentication.layer` and provide that
layer as [notes-service/src/routes.ts](../examples/notes-service/src/routes.ts) does. What the
verifier takes, fails with and must check itself is on `Authentication.Verify`; where its layer
goes, on `Authentication.layer`.

```ts example=notes-service/src/identity/verifier.ts
import { Config, Effect, Redacted } from "effect";
import * as Action from "@gjermundgaraba/effect-actions/Action";
import * as Authentication from "@gjermundgaraba/effect-actions/Authentication";
import { Login, scopes } from "./Identity.js";
import { users } from "./users.js";

const isToken = (token: string): token is keyof typeof users => Object.hasOwn(users, token);

// DEMO ONLY: a token is a user's name. A real verifier checks a signed token with your
// authorization server's library, its audience included. An unknown token is the built-in
// `Unauthenticated`: a 401 every client decodes.
const verify = (token: Redacted.Redacted<string>) => {
  const name = Redacted.value(token);

  return isToken(name)
    ? Effect.succeed(users[name])
    : Effect.fail(new Action.Unauthenticated({ message: "Unknown demo token." }));
};

// Server only: `Login`'s provider. As an OAuth protected resource it also publishes discovery,
// so an MCP client that gets a 401 finds where to sign in, asking for read first. The resource
// is the server's public URL, known only at startup, so it is read from config.
export const authenticate = Authentication.layer(Login, verify, {
  protectedResource: Effect.map(
    Config.String("PUBLIC_URL").pipe(Config.withDefault("http://localhost:3000")),
    (url) =>
      ({
        resource: `${url}/mcp`,
        // DEMO ONLY: no server is there. Yours is your authorization server's issuer.
        authorizationServers: ["https://auth.example.com"],
        scopesSupported: [scopes.read, scopes.write],
        scopesRequired: [scopes.read],
      }) satisfies Authentication.ProtectedResource,
  ),
});
```

For a verifier built from startup services, see `authenticateBearer` in
[kitchen-sink/src/identity/authenticate.ts](../examples/kitchen-sink/src/identity/authenticate.ts);
for a failure that is not the caller's, `Authentication.Options.error` and `IssuerUnavailable` in
[kitchen-sink/src/identity/Identity.ts](../examples/kitchen-sink/src/identity/Identity.ts); to
test as a signed-in caller, [Testing.md](Testing.md#test-as-a-signed-in-caller). What each
surface answers a missing or refused credential with is on `Action.Unauthenticated` and
`Action.Forbidden`, as
[kitchen-sink/test/identity/identity.test.ts](../examples/kitchen-sink/test/identity/identity.test.ts)
asserts, status and challenge included.

## Publish OAuth discovery

For an MCP endpoint whose users sign in through OAuth, give the Bearer descriptor's `layer` a
`protectedResource`, as the verifier above does. Its rules are on
`Authentication.LayerOptions.protectedResource` and on each field of
`Authentication.ProtectedResource`;
[kitchen-sink/test/identity/identity.test.ts](../examples/kitchen-sink/test/identity/identity.test.ts)
asserts the discovery it serves. To restrict who reads it, see
[Run a request policy before authentication](Authentication-advanced.md#run-a-request-policy-before-authentication).

### Step up for a scope

To have an OAuth client sign in again, or re-authorize with more scopes, fail the authorizer, a
handler or the verifier with `Action.Unauthenticated`, or with `Action.Forbidden` naming
`scopes`
([notes-service/src/identity/authorize.ts](../examples/notes-service/src/identity/authorize.ts));
`inService` in
[kitchen-sink/src/identity/authenticate.ts](../examples/kitchen-sink/src/identity/authenticate.ts)
refuses with none. What each answers on each surface, and when to name scopes, are on those two
classes.
