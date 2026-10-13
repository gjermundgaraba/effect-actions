# Context

Vocabulary for `@gjermundgaraba/effect-actions`. The docs, the examples, the code and the tests
use these words with these meanings. Module names and Effect's own terms (`HttpApi`, `Tool`,
`Toolkit`, `McpServer`, `Rpc`, `RpcGroup`, `RpcServer`, `Command`) mean what their modules say.

Read this page alone, in one tool call; if its output says it was truncated, read it again alone.
Tasks are routed from [SKILL.md](SKILL.md), and each module's failures from its `-failures.md`
page.

## Terms

### Contracts and calls

- **Action**: one contract: a name, a description, input, success and declared error schemas, `readOnly`, `caller`, and its `mcp` options. Holds no behavior. Made by `Action.make`.
- **Read-only**: `readOnly`, required on every action: whether it leaves its resource unchanged. It enforces nothing itself.
- **Caller**: who may call an action, `caller`. `Action.Anyone` makes a **public action**; an identity service, such as `caller: CurrentUser`, makes a **protected action**.
- **Identity**: the service a protected action names as its caller. A **trusted identity** is one only a host supplies, on a local surface, which no token names.
- **Handler**: a function from an action's decoded input to an Effect of its decoded success. The services it yields per call, and an authorizer's, are **request-time requirements**.
- **Implementation**: what `Action.implement` returns: actions bound to their handlers and, where any is protected, their authorizer. Every surface that runs handlers takes one, or a list.
- **Builder**: an Effect given to `Action.implement` in place of handlers, which returns them, once per layer graph. The services it yields are **build-time requirements**, or **startup services** ([Action.md](Action.md#implement-actions)).
- **Layer graph**: the layers Effect builds together, each built once ([Action-in-process.md](Action-in-process.md#share-one-build-across-servers)).
- **Host**: the application that serves the surfaces: it builds their layers, provides their services and runs the server, subprocess or CLI.
- **Surface**: where callers reach actions. A **remote surface** authenticates its callers (`ActionHttp.layer`, `ActionMcp.layerHttp`, `ActionRpc.layer`). A **local surface** has no one to authenticate (`ActionToolkit`, a local `ActionCli` command, `ActionMcp.runStdio`, `Action.client`): the host provides the identity.
- **Binding**: what `ActionHttp.make` or `ActionRpc.make` returns: the actions its surface serves, as browser-safe data the server and every client share.
- **Client**: one method per action, `client.<action>(input)`: `ActionHttp.client`, `ActionRpc.client`, `ActionMcp.client` and, in process, `Action.client`.
- **Authorizer**: `authorize`, a function of the called action that an implementation of protected actions states. It succeeds or fails with a refusal ([Action.md](Action.md#authorize-calls)).
- **Authentication descriptor**: what `Authentication.make` returns: a named, browser-safe declaration of how a remote caller proves an identity. A binding or an MCP endpoint serving protected actions names it.
- **Authentication provider**: what `Authentication.layer` returns for a descriptor, holding its **verifier**: the server-only function from a credential to the identity.
- **Layer middleware**: native `HttpApiMiddleware` or `RpcMiddleware` given to `ActionHttp.layer` or `ActionRpc.layer` as `middleware`, run around every route or rpc the layer serves.
- **Mixed endpoint**: an MCP endpoint serving public and protected tools on one URL ([ActionMcp.md](ActionMcp.md#protect-tools)).
- **Declared error**: an error schema listed in an action's `error`, which its handler may fail with ([guarantees.md](guarantees.md#wire-behavior)).
- **Built-in errors**: `Action.InvalidInput`, `Action.Unauthenticated` and `Action.Forbidden`, together `Action.BuiltIn`: errors the library produces and every surface declares ([Action.md](Action.md#fail-with-declared-and-built-in-errors)).
- **Refusal**: `Action.Refusal`, `Unauthenticated | Forbidden`: what authentication or an authorizer refuses a caller with. A **step-up refusal** is one an OAuth client acts on: an `Unauthenticated`, or a `Forbidden` naming `scopes` ([Authentication.md](Authentication.md#publish-oauth-discovery)).
- **Media field**: a field of an action's success whose schema is a media kind, `Action.Image`, which an MCP tool **lifts** into a content block of its own ([ActionMcp.md](ActionMcp.md#return-images-and-other-media)).

### Layout of an application

The parts of the layout every example uses: [examples/README.md](node_modules/@gjermundgaraba/effect-actions/examples/README.md#how-they-are-laid-out).

- **Domain**: one subject of the application, such as notes or identity, and the folder holding everything about it. A folder is never a mechanism, such as `contracts/` or `handlers/`.
- **Contract file**: the PascalCase file of a domain, such as `notes/Notes.ts`: its schemas, errors and actions, and the identity and descriptor it declares. It imports no server code.
- **Routes**: `routes.ts`, the host's surfaces as one Layer. A route, singular, is one HTTP route.
- **Entrypoint**: a file that runs the application one way, such as `server.ts`, `stdio.ts` or `cli.ts`: the **composition root**, the one place that chooses the services, the platform and, on a local surface, the caller.
- **Demo shortcut**: what an example does in place of what a deployment needs, marked `DEMO ONLY` in a comment.
