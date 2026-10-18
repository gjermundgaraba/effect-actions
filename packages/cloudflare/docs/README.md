# effect-actions-cloudflare

`@gjermundgaraba/effect-actions-cloudflare` serves effect-actions from Cloudflare Durable
Objects: the routes `ActionHttp.layer` and `ActionRpc.layer` serve elsewhere, in an object,
with Effect RPC over WebSockets the runtime holds while the object hibernates. A Worker calls an object's actions through its stub, with the core's own clients.

These pages cover what this package adds. Everything else, contracts, implementations,
authentication and each surface, is in the core package's docs, at
`node_modules/@gjermundgaraba/effect-actions/docs/`: read its `README.md` first, then its
`Action.md`, and the page of each surface you serve.

## How to read these pages

1. **Open one page per tool call, with your file-reading tool.** Pages are kept small to reduce
   truncation; if an output says it was truncated, read that page again alone.
2. **Start from [chat-rooms](../examples/chat-rooms/)**, the one example: its README has a
   layout tree and a "Where to look" table naming the file for each thing.
3. **Read [ActionDurableObject.md](ActionDurableObject.md) completely**, its limits included.
4. **When something fails, search
   [ActionDurableObject-failures.md](ActionDurableObject-failures.md)** for a fragment of the
   message, then the core's `*-failures.md` pages.

In a project that installs the package, these pages are in
`node_modules/@gjermundgaraba/effect-actions-cloudflare/docs/`, the example in `examples/`
beside them and the declarations with their JSDoc in `dist/`. Install it beside the core, at
the same version: `@gjermundgaraba/effect-actions-cloudflare` and
`@gjermundgaraba/effect-actions` are released together. Its declarations name the Workers
runtime's types, from `wrangler types` or `@cloudflare/workers-types`.

## Pages

| Read                                                               | When you need to                                                                                                 |
| ------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| [ActionDurableObject.md](ActionDurableObject.md)                   | serve actions from an object, over hibernating WebSockets or JSON; run its alarm; call it from a Worker; test it |
| [ActionDurableObject-failures.md](ActionDurableObject-failures.md) | find what an error or a refused upgrade means, and the fix                                                       |

## Words

These pages use the core's vocabulary, its `CONTEXT.md`, which defines Cloudflare's own terms
too, under Cloudflare: Durable Object, object, instance, eviction, hibernation and stub.
