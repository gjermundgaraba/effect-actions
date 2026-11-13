# ActionCluster failures

Messages the package does not own: workerd's, the compiler's and Effect's, from `@effect/platform-cloudflare`'s runtime. Search for a fragment of the message, without quotes; each entry is one line.

- `the Durable Object initializer is already set`: `CloudflareDurableObjects.setInitializer` was called twice in one isolate, as by two modules each registering one; register one, from the Worker's module, building the whole application, as [`chat-rooms/src/application.ts`](../examples/chat-rooms/src/application.ts) does.
- `ClusterEntity export is unavailable`, for keep-alive or for scheduled reply delivery, the only two paths that look the class up by name: the Worker's module does not export `ClusterEntity` under that name, or `wrangler.jsonc` binds another class name; export `ActionClusterEntity.make`'s class as `ClusterEntity` and the three others from `@effect/platform-cloudflare/CloudflareDurableObjects`, as [`chat-rooms/src/worker.ts`](../examples/chat-rooms/src/worker.ts) does.
- `ClusterEntity requires a canonical entity Durable Object name`: an object of the entity namespace was reached by a name `CloudflareCluster.encodeName` did not write, such as from `getByName("general")`; reach an entity through `Entity.client` or `ActionEntity.client`, and its object in a test through `encodeName(type, id)`.
- `Future DeliverAt requests must be persisted`: a payload naming `DeliverAt` was sent to an rpc not annotated `ClusterSchema.Persisted`; annotate it, as [`chat-rooms/src/chat/Tells.ts`](../examples/chat-rooms/src/chat/Tells.ts) does.
- `Future DeliverAt asks must define a PrimaryKey`: a scheduled call waited for its answer, its payload naming no `PrimaryKey`; send it as a tell, `{ discard: true }`, or give its payload a `PrimaryKey`.
- `Stream asks with a future DeliverAt are not supported`: a stream rpc was sent a `DeliverAt` payload; schedule a unary tell instead.
- `Cannot deduplicate an ask onto a tell with the same PrimaryKey`: an ask and a tell share a `PrimaryKey`; give each its own key, such as one naming the scheduled time.
- `MailboxFull`: the object holds 4096 unprocessed requests and unacknowledged stream replies; a send through `Entity.client` fails with it, and a call through `ActionEntity.reaching` dies with it, so give the tells sent per window or per minute one `PrimaryKey`, as the example's expiry and retries do.
- `Encoded entity message exceeds 2 MB`, the cause of a `PersistenceError`: one envelope, its payload and headers, encodes to over 2 MB; keep large values out of a call's input.
- `Unknown entity RPC tag`: the object's entity serves no rpc of that tag, as when a deploy renamed an rpc while a persisted tell of the old name waited in `cluster_messages`; keep a scheduled rpc's tag across deploys.
