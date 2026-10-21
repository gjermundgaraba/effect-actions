# effect-actions-cloudflare

`@gjermundgaraba/effect-actions-cloudflare` serves Effect RPC from Cloudflare Durable Objects,
over WebSockets the runtime holds while the object hibernates: any plain `RpcGroup`, on
Effect's own `RpcServer`, with no action at all, its streams pushed to pages with the core's
`Feed`, which an object keeps across hibernation. Actions are the option: the routes
`ActionHttp.layer` and `ActionRpc.layer` serve elsewhere, in an object. A Worker, or another
object, calls an object's rpcs over its stub with Cloudflare's own RPC, or its routes with the
core's own clients.

These pages cover what this package adds. Everything else, contracts, implementations,
authentication and each surface, is in the core package's docs, at
`node_modules/@gjermundgaraba/effect-actions/docs/`: read its `docs/README.md` first, then its
`docs/Action.md`, and the page of each surface you serve.

## How to read these pages

**Arriving with an error?** A message the library throws says its fix; for any other, step 4.

1. **Open one page per tool call, with your file-reading tool.** Pages are kept small to reduce
   truncation; if an output says it was truncated, read that page again alone.
2. **Start from [chat-rooms](../examples/chat-rooms/)**, the one example: its README has a
   layout tree and a "Where to look" table naming the file for each thing, and its comments
   carry the traps it shows.
3. **Read [ActionDurableObject.md](ActionDurableObject.md) completely**, then the page of each
   task you have ([Pages](#pages)), and the example files their sections link.
4. **For workerd's, a compiler diagnostic or Effect's own error, search
   [ActionDurableObject-failures.md](ActionDurableObject-failures.md)** for a fragment of the
   message without quotes, then the core's `*-failures.md` pages.

Where things are, in a project that installs the package: these pages in
`node_modules/@gjermundgaraba/effect-actions-cloudflare/docs/`, the example in `examples/`
beside them, and the declarations with their JSDoc, the reference for rules and gotchas, under
`dist/`. Install it beside the core, at the same version: the two are released together. Its
declarations name the Workers runtime's types, from `wrangler types` or
`@cloudflare/workers-types`.

## Pages

| Read                                                                 | When you need to                                                                                           |
| -------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| [ActionDurableObject.md](ActionDurableObject.md)                     | serve actions from an object, over hibernating WebSockets and JSON; run its alarm; test it; deploy it      |
| [ActionDurableObject-stub.md](ActionDurableObject-stub.md)           | serve an object's own API over its stub, call it from a Worker, name the object in errors, call its routes |
| [ActionDurableObject-feed.md](ActionDurableObject-feed.md)           | push to the pages connected to an object, after it hibernated too, with the core's `Feed`                  |
| [ActionDurableObject-own-class.md](ActionDurableObject-own-class.md) | serve them from a class that cannot extend `make`'s, delegating to `handlers` or composing the primitives  |
| [ActionDurableObject-failures.md](ActionDurableObject-failures.md)   | find what workerd's, the compiler's or Effect's message means, and the fix                                 |
