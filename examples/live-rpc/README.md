# live-rpc

A chat served as Effect RPC over a WebSocket: one connection per page, many calls on it.
Members post, read and delete messages in the rooms they belong to; anyone may list the rooms.
Each message on the socket carries its own token and names its room, so a socket has no
identity of its own. A message naming no room is about the default one, `lobby`.

Start here if a client keeps a connection open and calls often, or if the application already
speaks Effect RPC. For a JSON API or MCP tools, start from [notes-service](../notes-service/).
Actions are unary, so nothing streams: the page reads again, passing the last id it holds.

## Run it

From the repository root, after `vp install` (from an installed package, see
[Run one](../README.md#run-one)):

```sh
node --import tsx examples/live-rpc/src/server.ts     # 127.0.0.1:3000, PORT to change
node --import tsx examples/live-rpc/src/client.ts     # CHAT_URL to change, ws://127.0.0.1:3000/rpc

vp test examples/live-rpc
```

`client.ts` runs the browser's client from Node: two members on one socket, then each failure
a page handles. `browser.ts` is imported by a page, not run: `openChat` for a page that is an
Effect program, `connect(url)` for one that calls with promises. The tokens are fixed names (`ada`,
`grace`) and the store is memory: replace both before deploying anything.

## When you copy this

Three choices here show a feature. Decide each for your application before keeping it:

- **`listRooms` is public** to show a public rpc beside protected ones. It tells a signed-out
  caller every room's name.
- **A message naming no room is about `lobby`**, to show a default in request context. Yours may
  refuse instead.
- **The room is a header, not an input**, because `authorize` sees the action and not its input:
  the membership rule reads the room from request context. With the room in the input, the
  check belongs in the store, never in a helper each handler must remember to call: the store's
  method takes the member and refuses, as `MessageStore.remove` in `src/chat/store.ts` takes the
  author and refuses with `NotAuthor`.

## Layout

```text
src/
├── chat/
│   ├── Chat.ts        contract: schemas, errors, actions, the room header and its default
│   ├── store.ts       MessageStore, the service the handlers call, and its Layer
│   ├── room.ts        CurrentRoom, and the RPC middleware providing it per message
│   ├── authorize.ts   the one authorization rule: a member of the room
│   └── handlers.ts    Action.implement: contract to store
├── identity/
│   ├── Identity.ts    contract: CurrentMember and the Login descriptor
│   ├── members.ts     the demo members
│   └── verifier.ts    Authentication.layer: tokens to members, server only
├── Rpc.ts             the RPC binding of every action
├── routes.ts          the rpcs, authenticated and with their middleware, not yet on a protocol
├── server.ts          entrypoint: the rpcs over a WebSocket at /rpc, its messages bounded
├── browser.ts         client module: the connection and the chat, as Effects and as promises
└── client.ts          entrypoint: that client, run from Node
test/
├── chat/              in process, with Action.client
├── routes.test.ts     over RPC in memory, with Testing.layer
├── browser.test.ts    the page's client against the same rpcs
└── server.test.ts     the socket itself: a listening port, connect(url), the bound on a message
```

- **The PascalCase files are what a page imports.** `Chat.ts`, `Identity.ts` and `Rpc.ts` import
  no server code. `browser.ts` imports them, the library's `ActionRpc`, and `effect`,
  `effect/rpc` and `effect/socket`, nothing else, so it bundles for a browser.
- **A request-time service is never a startup service.** `CurrentMember` comes from
  authentication and `CurrentRoom` from middleware, both per message. Neither has a Layer, and
  no entrypoint provides one: a value provided at startup would serve every caller as one
  member in one room.
- **The entrypoint chooses the protocol.** `routes.ts` exports the rpcs without one. `server.ts`
  gives them a WebSocket, its only route. `browser.ts` leaves the WebSocket constructor to its
  host: a page provides the browser's, `client.ts` provides Node's.
- **The socket belongs to the Layer providing it.** `connection(url)` opens it when it is built
  and closes it when it is released: provide it once around the page's program, or keep it in
  a `ManagedRuntime`, as `connect(url)` does. The scope `openChat` needs holds only the client.
- **One test file opens a port.** `Testing.layer` answers HTTP requests and cannot upgrade a
  WebSocket, so `routes.test.ts` and `browser.test.ts` give the same rpcs Effect's HTTP protocol,
  in memory. `server.test.ts` covers what that leaves out: it serves them over a WebSocket on a
  port the system picks, calls with `connect(url)`, and sends a message over the server's bound.

## Where to look

| To see                                                                 | Read                                            |
| ---------------------------------------------------------------------- | ----------------------------------------------- |
| An RPC binding naming its authentication descriptor                    | `src/Rpc.ts`                                    |
| The rpcs on Effect's `RpcServer`, before a protocol is chosen          | `src/routes.ts`                                 |
| Serving them over a WebSocket, speaking JSON                           | `src/server.ts`                                 |
| The same rpcs over Effect's HTTP protocol, for a test                  | `test/routes.test.ts`                           |
| A verifier that runs for every message, not once per connection        | `src/identity/verifier.ts`                      |
| Native `RpcMiddleware` providing a per-request service, with a default | `src/chat/room.ts`                              |
| Handlers reading that service, and the rule that reads it              | `src/chat/handlers.ts`, `src/chat/authorize.ts` |
| A public rpc beside protected ones                                     | `src/chat/Chat.ts`                              |
| A socket client sending its token and room on each message             | `src/browser.ts`                                |
| Who owns the socket, and how a promise page keeps it open              | `src/browser.ts`                                |
| A declared error and the built-in refusals handled by tag              | `src/browser.ts`                                |
| Running that client from Node, two callers on one socket               | `src/client.ts`                                 |
| Testing handlers and authorization with no transport                   | `test/chat/chat.test.ts`                        |
| Testing rpcs, authentication and middleware in memory                  | `test/routes.test.ts`                           |
| The binding's native `RpcGroup` called by Effect's own client          | `test/routes.test.ts`                           |
| Testing the client's handling of each error and refusal                | `test/browser.test.ts`                          |
| Testing over a real WebSocket, and a message over `maxPayload`         | `test/server.test.ts`                           |
