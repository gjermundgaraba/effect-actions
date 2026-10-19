# ActionMcp

MCP tools from implementations, on Effect's native `McpServer`: one tool per served action, named
after it. `layerHttp` mounts a Streamable HTTP endpoint, for clients that connect to a URL;
`runStdio` is the whole program of a subprocess a local agent starts. For a model your own code
calls in process, use [ActionToolkit.md](ActionToolkit.md).

A message the library throws says its fix; for a compiler diagnostic or Effect's own error,
search [ActionMcp-failures.md](ActionMcp-failures.md). For one symbol,
`grep -rn <symbol> node_modules/@gjermundgaraba/effect-actions/dist/`: each declaration's JSDoc
carries its rules and gotchas, and this page only what an example cannot show.

## Serve tools over HTTP

Merge `layerHttp` into the routes, beside any other surface, and serve them with
`HttpRouter.serve`:

```ts example=quickstart/src/routes.ts
import { Layer } from "effect";
import * as ActionHttp from "@gjermundgaraba/effect-actions/ActionHttp";
import * as ActionMcp from "@gjermundgaraba/effect-actions/ActionMcp";
import { Http } from "./Api.js";
import { greeting } from "./greeting/handlers.js";

// One implementation, two surfaces: a JSON route and an MCP tool at `/mcp`.
export const routes = Layer.mergeAll(
  ActionHttp.layer(Http, greeting),
  ActionMcp.layerHttp(greeting, { name: "greetings", version: "1.0.0" }),
);
```

[quickstart/src/server.ts](../examples/quickstart/src/server.ts) serves them. Surfaces in one
set of routes share each builder, as `Action.implement` says:
[notes-service/src/routes.ts](../examples/notes-service/src/routes.ts).

- Claude Code 2.1 and Codex CLI 0.162 connect:
  `claude mcp add --transport http <name> <url>/mcp --header "Authorization: Bearer <token>"`,
  `codex mcp add <name> --url <url>/mcp --bearer-token-env-var <VAR>`;
  [mcp-tools](../examples/mcp-tools/README.md#connect-a-client) has stdio and Claude Desktop.
- Where an endpoint without `authentication` listens, and its body limit:
  [mcp-tools/src/server.ts](../examples/mcp-tools/src/server.ts). A 2025 client's session, on
  `layerHttp`, lasts until it ends it or the process stops, so limit request bodies.
- **On a serverless host**, such as Cloudflare Workers, pass `requestScoped: true`:
  [notes-service/src/worker.ts](../examples/notes-service/src/worker.ts).
- The endpoint takes no layer middleware. A limit that must hold for tools goes in the handlers:
  [kitchen-sink/src/issues/write-limit.ts](../examples/kitchen-sink/src/issues/write-limit.ts).

## Serve tools over stdio

Provide `Stdio` and the startup services, then run it:

```ts example=notes-service/src/stdio.ts
import { NodeRuntime, NodeStdio } from "@effect/platform-node";
import { Effect } from "effect";
import * as ActionCli from "@gjermundgaraba/effect-actions/ActionCli";
import * as ActionMcp from "@gjermundgaraba/effect-actions/ActionMcp";
import { identity } from "./identity/handlers.js";
import { CurrentUser } from "./identity/Identity.js";
import { users } from "./identity/users.js";
import { notes } from "./notes/handlers.js";
import { NoteStore } from "./notes/store.js";
import { status } from "./status/handlers.js";

// Entrypoint: an MCP server a local agent starts as a subprocess, such as
// `claude mcp add notes -- "$PWD/node_modules/.bin/tsx" "$PWD/examples/notes-service/src/stdio.ts"`
// from the repository root. The host starts the process in a directory it chooses, so `tsx`
// and the file are named by full path.
// The same implementations as the HTTP server, and the same `authorize`. No token arrives
// over stdio, so this host names the caller itself. It is a process of its own with services
// of its own. DEMO ONLY: this in-memory store holds its notes, not the running server's. To
// share them, both provide a store they both reach, such as a database.
ActionMcp.runStdio([status, notes, identity], { name: "notes-service", version: "1.0.0" }).pipe(
  // DEMO ONLY: a real host reads who started it, from its own login or configuration.
  Effect.provideService(CurrentUser, users.ada),
  Effect.provide([NodeStdio.layer, NoteStore.layerMemory]),
  // stdout carries the protocol alone, so logs and failures go to stderr.
  ActionCli.logToStderr,
  NodeRuntime.runMain,
);
```

[mcp-tools/src/stdio.ts](../examples/mcp-tools/src/stdio.ts) serves public tools. What
`ActionCli.logToStderr` moves, and what it cannot, is on `ActionCli.logToStderr`. Test the tools
without a process: [Testing.md](Testing.md#test-mcp-tools).

To try a server by hand, send one request as `request` builds it, its 2026-07-28 metadata in
`_meta`: [mcp-tools](../examples/mcp-tools/README.md#connect-a-client) has the `curl`, with
HTTP's five headers, and [notes-service](../examples/notes-service/README.md#run-it) the stdio command.

## Describe tools to a model

A tool is its contract ([Action.md](Action.md#define-a-contract)): a model knows only the action's
name, its `description`, and its input schema with each field's `description`. `readOnly` is the
tool's read-only hint, and the contract's `mcp` option holds its `title`, its other hints and its
`_meta`. The server's `instructions` say what the tools are for together. See
[mcp-tools/src/printers/Printers.ts](../examples/mcp-tools/src/printers/Printers.ts) and
[mcp-tools/src/instructions.ts](../examples/mcp-tools/src/instructions.ts).

- Constrain in the schema what a model may send: `PrinterId` in
  [mcp-tools/src/printers/Printers.ts](../examples/mcp-tools/src/printers/Printers.ts). Which
  checks reach the listed schema is on `Action.Options.input`.
- A model acts on a declared error's `message`, so write it for the model:
  [mcp-tools/src/platform/print-farm.ts](../examples/mcp-tools/src/platform/print-farm.ts).
- `actions` lists the tools, and only listed actions must suit MCP:
  [kitchen-sink/src/Actions.ts](../examples/kitchen-sink/src/Actions.ts). Leave out an action a
  model should not call, or one that takes a secret ([Action.md](Action.md#define-a-contract)).

## Return images and other media

Give the success an `Action.Image` field and return its bytes and MIME type from the handler:
`get_camera_snapshot` in
[mcp-tools/src/printers/Printers.ts](../examples/mcp-tools/src/printers/Printers.ts); `client`
decodes it back. An action taking an image as input is no tool, so `actions` leaves it out:
[kitchen-sink/src/Actions.ts](../examples/kitchen-sink/src/Actions.ts).

## Protect tools

Name the protected actions' authentication descriptor as `authentication` and provide its
provider to the routes: [notes-service/src/routes.ts](../examples/notes-service/src/routes.ts).
Write the [descriptor](Authentication.md#declare-how-callers-sign-in) and its
[provider](Authentication.md#verify-credentials) once for every surface, and
[publish discovery](Authentication.md#publish-oauth-discovery) so an MCP client finds where to
sign in. What a signed-in caller may do is each implementation's
[`authorize`](Action.md#authorize-calls), which runs on every call of a protected tool.

- **One endpoint or two.** What a mixed endpoint, serving public and protected tools, shows and
  runs signed out is on `LayerHttpOptions.authentication`.
- Test as a signed-in caller ([Testing.md](Testing.md#test-as-a-signed-in-caller)):
  [notes-service/test/routes.test.ts](../examples/notes-service/test/routes.test.ts).

## Allow browser clients

A browser MCP client sends its page's `Origin`. List the origins it may come from as
`allowedOrigins`, and add CORS where one is configured:
[mcp-tools/src/routes.ts](../examples/mcp-tools/src/routes.ts), and
[kitchen-sink/src/request-policy.ts](../examples/kitchen-sink/src/request-policy.ts) with
authentication.

- Authentication runs before the Origin check, so a request from an unlisted origin that must
  authenticate, or sends a token, gets 401 without a valid one, not 403.
- `allowedOrigins` checks no `Host`, and a request sending no `Origin` passes. A `Host`
  allowlist, or an Origin check that must run first, is a request policy:
  [Authentication-advanced.md](Authentication-advanced.md#run-a-request-policy-before-authentication).

## Add native prompts and resources

Merge Effect's own `McpServer.resource`, `McpServer.prompt` and `McpServer.toolkit` layers into
one and pass it as `features`:
[kitchen-sink/src/issues/guide.ts](../examples/kitchen-sink/src/issues/guide.ts), given in
[kitchen-sink/src/routes.ts](../examples/kitchen-sink/src/routes.ts) and
[kitchen-sink/src/stdio.ts](../examples/kitchen-sink/src/stdio.ts). Where their services
come from is on `features`, and when they need a credential on `authentication`.

## Send notifications from a handler

A handler yields `McpServer.McpServer` and sends through it:
`server.notifications["notifications/progress"]({ progressToken, progress })`.
`McpSchema.McpRequestContext` holds what the client sent: its `clientInfo`, and the request's
`_meta` as `requestMetadata`. The endpoint and `runStdio` provide both; an implementation also
served on another surface reads them with `Effect.serviceOption`.

- On 2026-07-28, a progress notification is sent only with the token its request carried,
  `requestMetadata?.progressToken`. With another, or when the client sent none, it is dropped
  silently.
