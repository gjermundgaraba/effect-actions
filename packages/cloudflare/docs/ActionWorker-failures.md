# ActionWorker failures

Messages the package does not own: workerd's and Effect's, met on a page's socket to an entity's object. Search for a fragment of the message, without quotes; each entry is one line.

- `Unknown request tag`, a page's call or watch failing with it over its socket: the socket's `actions` does not list that action or event type, or the deploy removed it; list it, or change `protocol.version` with the list so a page built against the old one reloads.
- `SocketCloseError` with `code: 4000`, the `reason` of a page's `RpcClientError`: the object refused the page's upgrade, as it names another `protocol.version` than the deployed one, and the page's `ActionRpc.socketClient` stopped at it; reload the page, as [`chat-rooms/src/Rpc.ts`](../examples/chat-rooms/src/Rpc.ts)'s version is the one the page was built against.
- `SocketCloseError` with `code: 1012`: the object was evicted while it answered one of the socket's calls, or cannot read what it kept for the socket after a deploy; a page's `ActionRpc.socketClient` connects again and polls from its cursor.
- `Cannot evict Durable Object: it is not currently running`: a test called `evictDurableObject` on an object no request has built since it was last evicted; evict it only after a call reached it, as a posted message or an open socket's message does.
