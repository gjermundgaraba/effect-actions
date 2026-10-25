# kitchen-sink

The reference application: one multi-tenant issue tracker that uses every module of the library
and nearly every option. Members of a workspace file, discuss and close issues, and attach
screenshots, over HTTP, MCP, Effect RPC, a CLI and an assistant, in process and behind a route.
Operators suspend workspaces on a second port, or from a console on the host.

The [index](#index) maps each export and option to the file that shows it.

## Run it

From the repository root, after `vp install` (from an installed package, see
[Run one](../README.md#run-one)):

```sh
node --import tsx examples/kitchen-sink/src/server.ts    # members on 127.0.0.1:3000, operators on :3001
node --import tsx examples/kitchen-sink/src/seed.ts      # files ACME-1 with a screenshot and a comment

export TRACKER_TOKEN=ada TRACKER_WORKSPACE=acme          # a demo member, see below
node --import tsx examples/kitchen-sink/src/cli.ts --help
node --import tsx examples/kitchen-sink/src/cli.ts list-issues -n 5
node --import tsx examples/kitchen-sink/src/cli.ts get-issue ACME-1
echo "It crashes on an empty draft" | node --import tsx examples/kitchen-sink/src/cli.ts create-issue --title Crash
node --import tsx examples/kitchen-sink/src/cli.ts ask-assistant --prompt "Close what is done."   # answers with a call to approve
node --import tsx examples/kitchen-sink/src/cli.ts export-issues      # each issue as it arrives, with progress on stderr

# The admin port takes an operator key, not a member's token.
curl -s 127.0.0.1:3001/admin/suspendWorkspace -H 'Content-Type: application/json' \
  -H 'X-Operator-Key: ops-key' -d '{"workspace":"acme"}'

node --import tsx examples/kitchen-sink/src/ops.ts list-workspaces   # the operators' console, no server
node --import tsx examples/kitchen-sink/src/agent.ts                 # the assistant, with a scripted model

vp test examples/kitchen-sink
```

`HOST`, `PORT`, `ADMIN_PORT`, `PUBLIC_URL` and `MCP_ORIGIN` configure the server; `TRACKER_URL`
points the CLI and the seed at it. `stdio.ts` is an MCP server for a local agent to start as a
subprocess. `sdk.ts` and `browser.ts` are imported by client code, not run. The OpenAPI
document is at `/api/v1/openapi.json`, Swagger UI at `/docs`, the MCP endpoint at `/mcp`, the
socket at `/rpc`.

| Credential                                | Who                        | May                                    |
| ----------------------------------------- | -------------------------- | -------------------------------------- |
| `Authorization: Bearer ada`               | ada, in acme or globex     | read and write in acme, read in globex |
| `Authorization: Bearer linus`             | linus, in acme             | read                                   |
| `Authorization: Bearer grace`             | grace, in globex           | read and write                         |
| `Cookie: tracker_session=ada-at-acme`     | ada in acme, on `/rpc`     | read and write                         |
| `Cookie: tracker_session=grace-at-globex` | grace in globex, on `/rpc` | read and write                         |
| `X-Operator-Key: ops-key`                 | operator `ops`             | list, suspend and resume workspaces    |
| `X-Operator-Key: support-key`             | operator `support`         | list workspaces                        |

A bearer request names its workspace in `X-Workspace: acme`. `kay` (token `kay`, session
`kay-at-acme`) is a member of acme granted no scope yet. The session cookie also opens
`GET /attachments/<id>`, the image for a page of the web app; a token holder calls `getAttachment`.

## Layout

```text
src/
├── identity/              who is calling
│   ├── Identity.ts        contract: CurrentMember, scopes, the Login and Session descriptors, whoAmI
│   ├── members.ts         DEMO ONLY: the people of the demo
│   ├── directory.ts       Directory: who a token or a session names
│   ├── authenticate.ts    Authentication.layer for both descriptors, OAuth discovery
│   ├── authorize.ts       the members' rule: readOnly to a scope
│   ├── quota.ts           the request quota, as HTTP and as RPC middleware
│   └── handlers.ts
├── workspaces/            the tenants
│   ├── Workspaces.ts      contract: Workspace, the public getStatus
│   ├── registry.ts        WorkspaceRegistry: the workspaces and their suspension
│   ├── tenant.ts          Tenant, and the router middleware that resolves it per request
│   └── handlers.ts
├── issues/
│   ├── Issues.ts          contract: schemas, errors, five actions, exportIssues, issue.changed
│   ├── store.ts           IssueStore, scoped by workspace, and its changes
│   ├── write-limit.ts     the write and export limits, wrapped around handlers
│   ├── handlers.ts        Action.implement over the store
│   ├── export.ts          exportIssues: a stream, with progress
│   ├── events.ts          issue.changed: a log source fed by the store's changes
│   ├── guide.ts           a native MCP resource and prompt
│   └── assistant.ts       the actions as a model's Toolkit, with approval
├── assistant/             the model loop, served: a turn per request
│   ├── Assistant.ts       contract: a turn, askAssistant and answerAssistant
│   ├── conversations.ts   Conversations: each member's Chat, one turn at a time, ended where a turn fails
│   ├── demo-model.ts      DEMO ONLY: a scripted model
│   └── handlers.ts        the loop, approvals across requests, what a turn reports
├── attachments/
│   ├── Attachments.ts     contract: an image in an input and in a success
│   ├── store.ts
│   ├── handlers.ts
│   └── download.ts        GET /attachments/:id, the host's own route, for the web app
├── admin/                 the operators, a second audience
│   ├── Admin.ts           contract: Operator, the OperatorKey descriptor, three actions
│   ├── grants.ts          Grants: what each operator may do
│   ├── authorize.ts       the operators' rule, built from Grants
│   ├── keys.ts            DEMO ONLY: the operator keys
│   ├── authenticate.ts    Authentication.layer for OperatorKey
│   └── handlers.ts
├── Actions.ts             which actions each surface gets
├── Api.ts                 the two HTTP bindings
├── Rpc.ts                 the RPC binding
├── config.ts              what a deployment sets
├── request-policy.ts      the Host and Origin policy, and CORS
├── routes.ts              every surface of both ports, and the builders they share
├── memory.ts              DEMO ONLY: the services in memory
├── server.ts              entrypoint: both ports, the rpcs over a WebSocket
├── stdio.ts               entrypoint: MCP for a local agent
├── cli.ts                 entrypoint: the members' commands, calling the server
├── ops.ts                 entrypoint: the operators' console, in process
├── agent.ts               entrypoint: the assistant
├── seed.ts                entrypoint: an Effect program calling the API
├── sdk.ts                 entrypoint: a promise client
└── browser.ts             entrypoint: the web app's RPC client
test/
├── routes.test.ts         the host's surfaces: one port over HTTP and MCP, then both ports
├── request-policy.test.ts raw requests to each port as a web handler
├── issues/                in process, with Action.client; the assistant's tools; the export over
│                          HTTP and RPC; issue.changed in process
├── assistant/             the assistant over HTTP, with a scripted model
├── support/               the scripted model the assistant's tests give the routes
├── identity/              what authentication adds: tokens over HTTP, sessions over RPC
├── attachments/           images over HTTP and MCP; the download route
└── admin/                 the operators' grants; the trusted operator
```

## Where to look

| To see                                                                  | Read                                                                                                     |
| ----------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| How one request is authenticated, placed in a tenant, authorized        | `src/identity/authenticate.ts`, `src/workspaces/tenant.ts`, `src/identity/authorize.ts`, `src/routes.ts` |
| Two audiences on two ports over one set of services                     | `src/server.ts`, `src/routes.ts`, `test/routes.test.ts`                                                  |
| Which actions each surface serves, and why one is no tool               | `src/Actions.ts`                                                                                         |
| A limit before decoding and a limit in the handlers                     | `src/identity/quota.ts`, `src/issues/write-limit.ts`                                                     |
| An image for a model and a client (an action), and for a page (a route) | `src/attachments/`                                                                                       |
| A caller the host names itself                                          | `src/stdio.ts`, `src/ops.ts`, `src/agent.ts`                                                             |
| A model loop behind a route, approvals answered in a later request      | `src/assistant/handlers.ts`, `src/routes.ts`                                                             |
| What to test in process and what over the wire                          | `test/issues/issues.test.ts`, `test/routes.test.ts`                                                      |

## Index

Each export and option the example uses, and where. A symbol in parentheses is the name to
search for in the file.

### Action

| Export or option                                               | File                                                                                 |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `make`: `input`, `success`, `error`, `readOnly`                | `src/issues/Issues.ts`                                                               |
| `make`: `caller: Action.Anyone`, a public action               | `src/workspaces/Workspaces.ts` (`GetStatus`)                                         |
| `make`: `caller`, an identity service                          | `src/identity/Identity.ts` (`CurrentMember`, `WhoAmI`)                               |
| `make`: `mcp` (`title`, hints)                                 | `src/issues/Issues.ts` (`CreateIssue`, `CloseIssue`)                                 |
| `make`: no `input`                                             | `src/identity/Identity.ts` (`WhoAmI`)                                                |
| `make`: an optional and a defaulted input field                | `src/issues/Issues.ts` (`ListIssues`)                                                |
| `make`: errors with `httpApiStatus`                            | `src/issues/Issues.ts` (`IssueNotFound`, `RateLimited`)                              |
| `make`: a shared error list                                    | `src/issues/Issues.ts` (`IssueWriteErrors`), `src/attachments/Attachments.ts`        |
| `make`: an option bundle, spread                               | `src/issues/Issues.ts` (`change`), `src/admin/Admin.ts` (`onWorkspace`)              |
| `make`: `progress`, and `Stream`, a success answering a stream | `src/issues/Issues.ts` (`ExportIssues`)                                              |
| A handler returning a `Stream`, reporting progress             | `src/issues/export.ts`                                                               |
| `Image`, in a success and in an input                          | `src/attachments/Attachments.ts`                                                     |
| `byName`                                                       | `src/issues/guide.ts` (`tools`)                                                      |
| `implement`: one action, a plain handler                       | `src/identity/handlers.ts`                                                           |
| `implement`: one action, a builder                             | `src/workspaces/handlers.ts`                                                         |
| `implement`: several actions sharing a builder                 | `src/issues/handlers.ts`                                                             |
| Startup services and per-request services                      | `src/issues/handlers.ts`                                                             |
| A rate limit in handlers, shared by several                    | `src/issues/write-limit.ts`, `src/issues/handlers.ts`, `src/attachments/handlers.ts` |
| `implement`: `authorize`, a rule from `readOnly`               | `src/identity/authorize.ts`                                                          |
| `implement`: `authorize`, an Effect building it                | `src/admin/authorize.ts`                                                             |
| `allowAll`                                                     | `src/identity/handlers.ts`                                                           |
| `Forbidden` with `scopes`, and without                         | `src/identity/authorize.ts`, `src/admin/authorize.ts`                                |
| `Unauthenticated`                                              | `src/identity/directory.ts`, `src/admin/authenticate.ts`                             |
| `InvalidInput` with `issues`, from a handler                   | `src/attachments/handlers.ts`                                                        |
| `layer`, one builder run for an implementation two ports serve | `src/routes.ts` (`builders`), `src/server.ts`, `test/routes.test.ts`                 |
| `client`                                                       | `src/agent.ts`, `test/issues/issues.test.ts`                                         |
| `client`: `actions`                                            | `test/issues/issues.test.ts`                                                         |
| `Any`, an authorizer's parameter                               | `src/identity/authorize.ts`                                                          |

### Authentication

| Export or option                                               | File                                                            |
| -------------------------------------------------------------- | --------------------------------------------------------------- |
| `make`, Bearer, with a declared `error` (503)                  | `src/identity/Identity.ts` (`Login`, `IssuerUnavailable`)       |
| `make`: `security`, a cookie, for the same identity            | `src/identity/Identity.ts` (`Session`)                          |
| `make`: `security`, an API key in a header                     | `src/admin/Admin.ts` (`OperatorKey`)                            |
| `layer`, a verifier built from startup services                | `src/identity/authenticate.ts`                                  |
| `layer`, a plain verifier                                      | `src/admin/authenticate.ts`                                     |
| `layer`: `protectedResource`, an Effect over `Config`          | `src/identity/authenticate.ts` (`protectedResource`)            |
| `ProtectedResource`                                            | `src/identity/authenticate.ts`                                  |
| A request service the verifier reads, and its order            | `src/workspaces/tenant.ts`, `src/routes.ts` (`publicRoutes`)    |
| `protect`, a route of the host's own, by the cookie descriptor | `src/attachments/download.ts`                                   |
| A trusted identity no verifier returns                         | `src/admin/Admin.ts`, `src/admin/authenticate.ts`, `src/ops.ts` |
| A verifier's declared error over MCP                           | `test/identity/identity.test.ts`                                |
| A test replacing a verifier's service                          | `test/identity/identity.test.ts` (`issuerDown`)                 |

### Event

| Export or option                                                                           | File                                    |
| ------------------------------------------------------------------------------------------ | --------------------------------------- |
| `make`: `description`, `input` that filters and shapes, `payload`, `caller`                | `src/issues/Issues.ts` (`IssueChanged`) |
| `implement`: a log source fed by `emit`, `match` reading the caller, `transform`, `maxAge` | `src/issues/events.ts`                  |
| `implement`: `authorize`, one rule for actions and events                                  | `src/identity/authorize.ts`             |
| `watch` in process, `Forbidden` for a subscriber                                           | `test/issues/events.test.ts`            |

### ActionHttp

| Export or option                                               | File                                                                        |
| -------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `make`: `prefix`, `authentication`, `error`                    | `src/Api.ts` (`Http`)                                                       |
| A second binding for a second identity                         | `src/Api.ts` (`AdminHttp`)                                                  |
| One action in two bindings                                     | `src/Api.ts` (`GetStatus`), `src/routes.ts` (`adminRoutes`)                 |
| `layer`: `actions`                                             | `src/routes.ts` (`api`)                                                     |
| `layer`: `middleware`                                          | `src/routes.ts` (`api`), `src/identity/quota.ts` (`HttpQuota`)              |
| Global router middleware, before authentication and discovery  | `src/request-policy.ts` (`requestPolicy`), `src/routes.ts` (`publicRoutes`) |
| `Http.api`, `Http.prefix`: the OpenAPI document and Swagger UI | `src/routes.ts` (`documentation`)                                           |
| A request body limit                                           | `src/server.ts`                                                             |
| Two `HttpRouter.serve`, what they share provided outside both  | `src/server.ts`                                                             |
| `client`: `baseUrl`, `transformClient`                         | `src/seed.ts`                                                               |
| `fetchClient`                                                  | `src/sdk.ts`                                                                |
| Declared errors handled by tag                                 | `src/seed.ts`, `src/sdk.ts`                                                 |
| A stream action's route and method, with `onProgress`          | `test/issues/export.test.ts`                                                |

### ActionMcp

| Export or option                                 | File                                                          |
| ------------------------------------------------ | ------------------------------------------------------------- |
| `layerHttp`, public and protected tools together | `src/routes.ts` (`mcp`)                                       |
| `layerHttp`: `authentication`, `instructions`    | `src/routes.ts` (`mcp`)                                       |
| `layerHttp`: `actions`, one action left off      | `src/routes.ts` (`mcp`), `src/Actions.ts` (`Tools`)           |
| `layerHttp`: `allowedOrigins`                    | `src/routes.ts` (`mcp`), `test/routes.test.ts`                |
| `layerHttp`: `features`, a resource and a prompt | `src/issues/guide.ts`                                         |
| CORS for a browser MCP client                    | `src/request-policy.ts` (`cors`)                              |
| `runStdio`, the host naming the caller           | `src/stdio.ts`                                                |
| An image block from a media field                | `src/attachments/Attachments.ts` (`GetAttachment`)            |
| `client`: `transformClient`                      | `test/routes.test.ts`                                         |
| `client`, decoding an image                      | `test/attachments/attachments.test.ts`                        |
| `client`: `authentication`, a verifier's error   | `test/identity/identity.test.ts`                              |
| `request`: `headers`, `url`                      | `test/attachments/attachments.test.ts`, `test/routes.test.ts` |

### ActionRpc

| Export or option                  | File                                                          |
| --------------------------------- | ------------------------------------------------------------- |
| `make`: `authentication`, `error` | `src/Rpc.ts`                                                  |
| `layer`: `middleware`             | `src/routes.ts` (`rpc`), `src/identity/quota.ts` (`RpcQuota`) |
| A WebSocket protocol              | `src/server.ts` (`socket`)                                    |
| `client`, over a WebSocket        | `src/browser.ts`                                              |
| A credential per message          | `test/identity/session.test.ts` (`as`)                        |
| A stream action's method          | `test/issues/export.test.ts`                                  |

### ActionToolkit

| Export or option                                          | File                                 |
| --------------------------------------------------------- | ------------------------------------ |
| `make`: `actions`, `needsApproval` (a boolean rule)       | `src/issues/assistant.ts`            |
| `toolkit` given to `LanguageModel`                        | `src/issues/assistant.ts` (`triage`) |
| `layer`, and the caller per turn                          | `src/agent.ts`                       |
| `toolkit` and the model yielded in a builder              | `src/assistant/handlers.ts`          |
| `layer` provided to the routes                            | `src/routes.ts` (`assistantTools`)   |
| An approval answered in a later request (`openApprovals`) | `src/assistant/handlers.ts`          |
| `tools.handle`, a call made by hand                       | `test/issues/assistant.test.ts`      |

### ActionCli

| Export or option                                                              | File                                       |
| ----------------------------------------------------------------------------- | ------------------------------------------ |
| `remote`: `name`, `commands`, `client`                                        | `src/cli.ts`                               |
| `commands`: `stdin`, `positional`, `aliases`, `render`, `name`, `description` | `src/cli.ts`                               |
| A client from `Config`, its credentials optional                              | `src/cli.ts`                               |
| `make`, with a trusted identity the host supplies                             | `src/ops.ts`                               |
| `logToStderr`                                                                 | `src/cli.ts`, `src/ops.ts`, `src/stdio.ts` |
| `render` of each element of a stream action                                   | `src/cli.ts` (`exportIssues`)              |

### Testing

| Export or option                                 | File                                                        |
| ------------------------------------------------ | ----------------------------------------------------------- |
| `layer(routes)`                                  | `test/identity/identity.test.ts`                            |
| `layer(routes)`, twice, over shared builders     | `test/routes.test.ts` (`shared`)                            |
| `layer(handler)`, over `HttpRouter.toWebHandler` | `test/request-policy.test.ts`                               |
| RPC in memory, over Effect's HTTP protocol       | `test/identity/session.test.ts`                             |
| A service the test and the routes both read      | `test/identity/session.test.ts` (`served`)                  |
| A test replacing one service                     | `test/identity/identity.test.ts` (`servedWith`)             |
| `Action.client`, a caller per call               | `test/issues/issues.test.ts`                                |
| A scripted `LanguageModel`                       | `test/issues/assistant.test.ts`, `test/support/scripted.ts` |
| A test replacing the model the routes are given  | `test/assistant/assistant.test.ts` (`served`)               |
| An error's message asserted beside its fields    | `test/issues/issues.test.ts`                                |

## Not shown

Left out because this application has no honest place for them:

- `Authentication.refusalResponse` and `bearerTokenOf`. They serve a caller the router never
  routes, such as a Node `upgrade` handler. Every caller here is routed: the socket is Effect's
  own WebSocket route, authenticated per message.
- A descriptor with `HttpApiSecurity.basic`, and an API key in the query.
- `Action.implement` with a plain record of handlers: every implementation of several actions
  here has a builder. `implementation.actions`. `mcp._meta`.
- `ActionCli.command` and `remoteCommand`, one action as one command; `make`'s and `remote`'s
  `actions`. Both CLIs here are aggregates of every action, and the remote one reads its client
  from `Config`. `subcommands` and `toUserError`, a command written by hand:
  [notes-service](../notes-service/) has two.
- `ActionRpc.layer`'s `actions`, `Rpc.group`, and `ActionRpc.client`'s options.
- A binding's other fields, `Http.actions`, `Http.error` and `Http.authentication`.
- `ActionMcp`'s `path`, `description`, `websiteUrl`, `icons`, `extensions`, `allowSubscriptions`
  and `requestScoped` ([notes-service](../notes-service/) has it), and `McpCallError`;
  `fetchClient`'s `fetch`.
- `needsApproval` as an Effect reading the caller: the rule here is a boolean of the action.
- `Action.InvalidInput.fromSchemaError`, the `Action.Refusal` and `Action.BuiltIn` schemas, and the
  helper types: `Action.Issue`, `Errors`, `Handlers`, `Client`, `AnyImplementation`,
  `BuildServices`, `ActionHttp.Client`, `Authentication.Any`.
- A handler sending MCP notifications through `McpServer.McpServer`, and one reading
  `McpSchema.McpRequestContext`.
- An event's `check` source and `subscription`, and a watch's `resume`:
  [build-events](../build-events/) has them.
  No example sets a `subscription`'s `lease` or an occurrence's `timestamp`: the defaults (5
  minutes, and when the occurrence arrived) serve both.
- A tenant taken from a subdomain. The workspace is a header, so the OAuth resource the server
  publishes is one fixed URL.
