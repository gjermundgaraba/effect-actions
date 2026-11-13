# ActionClusterEntity failures

Messages the package does not own: workerd's and Effect's, met on a page's socket to an entity's object. Search for a fragment of the message, without quotes; each entry is one line.

- `SocketCloseError` with `code: 4000`, the `reason` of a page's `RpcClientError`: the object refused the page's upgrade, as it names another `protocol.version` than the deployed one, and `ActionRpc.reconnectUntil(unsupportedProtocol)` stopped it; reload the page, as [`chat-rooms/src/Rpc.ts`](../examples/chat-rooms/src/Rpc.ts)'s version is the one the page was built against.
- `SocketCloseError` with `code: 1012`: the object was evicted while it answered one of the socket's calls, or cannot read what it kept for the socket after a deploy; a page whose `retryPolicy` is `ActionRpc.reconnectUntil(unsupportedProtocol)` connects again and polls from its cursor, one stopping at 1012 too does not.
- `Cannot evict Durable Object: it is not currently running`: a test called `evictDurableObject` on an object no request has built since it was last evicted; evict it only after a call reached it, as a posted message or an open socket's message does.
