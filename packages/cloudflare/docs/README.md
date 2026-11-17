# effect-actions-cloudflare

`@gjermundgaraba/effect-actions-cloudflare` runs effect-actions on Cloudflare through Effect Cluster: each **entity**, an `ActionEntity` the core declares, is one Durable Object of `@effect/platform-cloudflare`'s `ClusterEntity` class, holding its own SQLite database, and a Worker in front serves every entity's actions and events over JSON and MCP through `ActionEntity.reaching`. The package adds two modules: `ActionCluster`, the cluster layer, whose entity clients send a caller's credential as the caller set it, and `ActionClusterEntity`, the `ClusterEntity` class that also serves a page's WebSocket to an entity's object, held open while the object hibernates.

These pages cover what this package adds. Everything else, contracts, implementations, authentication, entities and each surface, is in the core package's docs, at `node_modules/@gjermundgaraba/effect-actions/docs/`: read its `docs/README.md` first, then its `docs/Action.md`, its `docs/ActionEntity.md`, and the page of each surface you serve.

## How to read these pages

**Arriving with an error?** A message the library throws says its fix; for any other, step 4.

1. **Open one page per tool call, with your file-reading tool.** Pages are kept small to reduce truncation; if an output says it was truncated, read that page again alone.
2. **Start from [chat-rooms](../examples/chat-rooms/)**, the one example: its README has a layout tree and a "Where to look" table naming the file for each thing, and its code and README carry the traps it shows.
3. **Read [ActionCluster.md](ActionCluster.md) completely**, then [ActionClusterEntity.md](ActionClusterEntity.md) if a page follows an entity, and the example files their sections link.
4. **For workerd's, a compiler diagnostic or Effect's own error, search [ActionCluster-failures.md](ActionCluster-failures.md) and [ActionClusterEntity-failures.md](ActionClusterEntity-failures.md)** for a fragment of the message without quotes, then the core's `*-failures.md` pages.

Where things are, in a project that installs the package: these pages in `node_modules/@gjermundgaraba/effect-actions-cloudflare/docs/`, the example in `examples/` beside them, and the declarations with their JSDoc, the reference for rules and gotchas, under `dist/`. Install it beside the core, at the same version: the two are released together. Install `@effect/platform-cloudflare` at the `effect` version you run. Its declarations name the Workers runtime's types, from `wrangler types` or `@cloudflare/workers-types`.

## Pages

| Read | When you need to |
| --- | --- |
| [ActionCluster.md](ActionCluster.md) | deploy entities on Durable Objects, boot the application once per isolate, serve them from the Worker, read an object's own state, deliver their events by webhook, test them on workerd |
| [ActionClusterEntity.md](ActionClusterEntity.md) | follow an entity's events from a page over a WebSocket the object keeps while it hibernates, refuse a page built against other rpcs, count the stub calls a post costs |
| [ActionCluster-failures.md](ActionCluster-failures.md) | find what workerd's, the compiler's or Effect's message means, and the fix |
| [ActionClusterEntity-failures.md](ActionClusterEntity-failures.md) | find what a page's socket error or workerd's test message means, and the fix |
