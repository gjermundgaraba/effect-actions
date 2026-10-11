# Context

Vocabulary for `@gjermundgaraba/effect-actions`. The docs, the examples, the code and the tests
use these words with these meanings. Module names and Effect's own terms (`HttpApi`, `Tool`,
`Toolkit`, `McpServer`, `Rpc`, `RpcGroup`, `RpcServer`, `Command`) mean what their modules say.

## Terms

### Contracts and calls

- **Action**: one contract. A name, a description, an input schema, a success schema, declared error schemas, `readOnly`, `caller`, and its `mcp` options. Holds no behavior. Made by `Action.make`.
- **Read-only**: `readOnly`, a boolean required on every action: whether the action leaves its resource unchanged. An authorizer reads it, and a tool's read-only hint comes from it. It enforces nothing itself.
- **Caller**: who may call an action, `caller`, required on every contract. `Action.Anyone` makes a **public action**, which anyone may call, signed in or not. An identity service, such as `caller: CurrentUser`, makes a **protected action**, which only a caller with that identity may call.
- **Identity**: the service a protected action names as its caller, a `Context.Service`. A **trusted identity** is one only a host supplies, on a local surface, such as an operator's on an admin CLI: typed apart from what a verifier returns, so no token names it.
- **Handler**: a function from an action's decoded input to an Effect of its decoded success, failing only with the action's declared errors and the built-in ones. The services it yields per call, and an authorizer's, are **request-time requirements**: authentication and middleware supply them on a remote surface, the host on a local one.
- **Implementation**: what `Action.implement` returns: actions bound to their handlers and, where any is protected, their authorizer. Nominal. Every surface that runs handlers takes one, or a list.
- **Builder**: the Effect given to `Action.implement` in place of a handler or a record of handlers, which returns them. It runs once per layer graph, however many surfaces serve its implementation. The services it yields are **build-time requirements**, or **startup services**, resolved when its layer is built ([Action.md](Action.md#implement-actions)). An authorizer may be built the same way, and so may a verifier.
- **Layer graph**: the layers Effect builds together, sharing one memo map, so each is built once however many layers use it. `HttpRouter.serve`, `Testing.layer`, `HttpRouter.provideRequest` and `Layer.fresh` each build in a graph of their own ([Action.md](Action-in-process.md#share-one-build-across-servers)).
- **Host**: the application that serves the surfaces: it builds their layers, provides their services and middleware, and runs the server, subprocess or CLI.
- **Surface**: where callers reach actions: HTTP routes, rpcs, an MCP endpoint, a Toolkit, a CLI command, a client in process. A **remote surface** authenticates its callers (`ActionHttp.layer`, `ActionMcp.layerHttp`, `ActionRpc.layer`). A **local surface** has no one to authenticate (`ActionToolkit`, a local `ActionCli` command, `ActionMcp.runStdio`, `Action.client`): the host provides the identity, per call.
- **Binding**: the value `ActionHttp.make` or `ActionRpc.make` returns, typed `ActionHttp.Binding` or `ActionRpc.Binding`: the actions its surface serves, with Effect's native `HttpApi` or `RpcGroup` of them. Plain data shared by the server and every client, browser-safe. HTTP and RPC have one; no other surface does.
- **Client**: one method per action, `client.<action>(input)`, answering its decoded success or failing with its declared errors and the built-in ones, as decoded values. `ActionHttp.client` calls a binding's routes, `ActionRpc.client` its rpcs, `Testing.mcpClient` an endpoint's tools, and `Action.client` implementations in process.
- **Authorizer**: `authorize`, an Effectful function of the called action, which an implementation of protected actions states: `Action.implement(actions, handlers, { authorize })`. Every surface runs it for a protected action, after authentication and input decoding and before the handler. It succeeds or fails with a refusal ([Action.md](Action.md#authorize-calls)).
- **Authentication descriptor**: what `Authentication.make` returns: a named, browser-safe declaration of how a remote caller proves an identity, by one native scheme, Bearer unless it names another. A binding or an MCP endpoint serving protected actions names it, `authentication: Login`. Its name identifies the one provider that satisfies it.
- **Authentication provider**: what `Authentication.layer` returns for a descriptor: its **verifier**, the server-only function from a credential to the identity, failing with a refusal or an error the descriptor declares, and the discovery of an OAuth protected resource. Every HTTP, MCP or RPC layer serving protected actions requires it.
- **Layer middleware**: native `HttpApiMiddleware` given to `ActionHttp.layer(binding, implementations, { middleware })`, or native `RpcMiddleware` given to `ActionRpc.layer`: run around every route or rpc the layer serves, inside authentication and outside decoding. Server-only, never in the binding. HTTP and RPC only.
- **Mixed endpoint**: an MCP endpoint serving public and protected tools on one URL. Anyone may discover the server, list its tools and call a public tool; every other request authenticates first ([ActionMcp.md](ActionMcp.md#protect-tools)).
- **Declared error**: an error schema listed in an action's `error`. Its handler may fail with it, a limit such as a rate limit included. How each surface sends it: [guarantees.md](guarantees.md#wire-behavior).
- **Built-in errors**: `Action.InvalidInput` (400), `Action.Unauthenticated` (401) and `Action.Forbidden` (403), together `Action.BuiltIn`: tagged errors the library produces and every surface declares, which any handler may also fail with ([Action.md](Action.md#fail-with-declared-and-built-in-errors)).
- **Refusal**: `Action.Refusal`, `Unauthenticated | Forbidden`: what authentication or an authorizer refuses a caller with instead of letting a handler run, and all an authorizer may fail with. A **step-up refusal** is one an OAuth client acts on: an `Unauthenticated`, or a `Forbidden` naming `scopes` ([Authentication.md](Authentication.md#publish-oauth-discovery)).
- **Media field**: a field of an action's success whose schema is a media kind, `Action.Image`. An MCP tool **lifts** it out of its result into a content block of its own; every other surface sends it as JSON, the bytes in base64 ([ActionMcp.md](ActionMcp.md#return-images-and-other-media)).

### Layout of an application

The parts of the layout every example uses: [examples/README.md](https://github.com/gjermundgaraba/effect-actions/blob/main/examples/README.md#how-they-are-laid-out).

- **Domain**: one subject of the application, such as notes or identity, and the folder holding everything about it: its contract file, its services, its handlers. A folder is never a mechanism, such as `contracts/` or `handlers/`.
- **Contract file**: the PascalCase file of a domain, such as `notes/Notes.ts`: its schemas, errors and actions, and the identity and authentication descriptor it declares. It imports no server code, so a browser or a CLI can import it. The lowercase files beside it run on the server.
- **Routes**: `routes.ts`, the host's surfaces as one Layer, which an entrypoint serves and the tests call in memory. A route, singular, is one HTTP route: an action's, or one of the host's own.
- **Entrypoint**: a file that runs the application one way, such as `server.ts`, `stdio.ts` or `cli.ts`. It is a **composition root**: the one place that chooses the services, the platform and, on a local surface, the caller. Nothing below it knows what it got, so a test chooses its own.
- **Demo shortcut**: what an example does in place of what a deployment needs, such as a token that is a user's name, or a store in memory. Each is marked `DEMO ONLY` in a comment: replace it before deploying.
