# live-rpc

A chat served as Effect RPC over a WebSocket: one connection per page, many calls on it.
Members post, read and delete messages in the rooms they belong to; anyone may list the rooms.
Each message on the socket carries its own token and names its room.
To serve these same actions as JSON too, see
[ActionRpc.md](../../docs/ActionRpc.md#serve-the-rpcs).

## Run it

From the repository root, after `vp install` (from an installed package, see
[Run one](../README.md#run-one)):

```sh
node --import tsx examples/live-rpc/src/server.ts     # 127.0.0.1:3000, HOST and PORT to change
node --import tsx examples/live-rpc/src/client.ts     # CHAT_URL to change, ws://127.0.0.1:3000/rpc

vp test examples/live-rpc
```

`client.ts` runs the browser's client from Node: two members on one socket, then each declared
error and refusal a page handles. `browser.ts` is imported by a page, not run: `openChat` for a
page that is an Effect program, `connect(url)` for one that calls with promises.

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
├── browser.ts         client module: the connection and the chat, as one Effect program
├── page.ts            the same chat as promises, for a page that is not one
└── client.ts          entrypoint: that client, run from Node
test/
├── chat/              in process, with Action.client
├── routes.test.ts     over RPC in memory, with Testing.layer
├── browser.test.ts    the page's client against the same rpcs
└── server.test.ts     the socket itself: a listening port, connect(url), the bound on a message
```

## Where to look

| To see                                                                 | Read                                            |
| ---------------------------------------------------------------------- | ----------------------------------------------- |
| An RPC binding naming its authentication descriptor                    | `src/Rpc.ts`                                    |
| The rpcs on Effect's `RpcServer`, before a protocol is chosen          | `src/routes.ts`                                 |
| Serving them over a WebSocket, speaking JSON                           | `src/server.ts`                                 |
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
