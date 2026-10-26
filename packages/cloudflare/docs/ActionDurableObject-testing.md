# ActionDurableObject: testing and deploying

An object's tests run inside the Workers runtime, on the Worker its Wrangler configuration
describes. Read [ActionDurableObject.md](ActionDurableObject.md) first. A message the library
throws says its fix; for workerd's, a compiler diagnostic or Effect's own error, search
[ActionDurableObject-failures.md](ActionDurableObject-failures.md).

## Test on the Workers runtime

Run the tests inside the runtime with `@cloudflare/vitest-plugin`, on the Worker the Wrangler
configuration describes:

```ts example=chat-rooms/vite.config.ts
import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vite-plus";

// Its tests run inside the Workers runtime, on the Worker wrangler.jsonc describes.
export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
    }),
  ],
  test: {
    include: ["test/**/*.test.ts"],
    // Why: under @cloudflare/vitest-plugin 1.4.4, the warm-module response for a later file in a
    // pool slot can exceed what the runner's control socket accepts, 41 MB in 709 entries
    // measured on chat-rooms, which closes it with 1009 and loses the file as "Worker exited
    // unexpectedly"; two small files alone did not trigger it.
    fsModuleCache: false,
  },
});
```

From `cloudflare:test`, `evictDurableObject(stub)` evicts an instance as hibernation does,
its sockets staying open, the runtime runs an alarm set in the past at once, which chat-rooms'
`test/worker.test.ts` waits for, and `runInDurableObject(stub, fn)` reads or changes the object's
storage directly. Call the Worker
as a deployment would with `layerHttpClient(exports.default)`, and open a socket by upgrading
through its `fetch`, handing `response.webSocket` to `Socket.fromWebSocket` under
`RpcClient.layerProtocolSocket`
([chat-rooms/test/support/socket.ts](../examples/chat-rooms/test/support/socket.ts),
[chat-rooms/test/worker.test.ts](../examples/chat-rooms/test/worker.test.ts)). The core's
`Testing.layer` serves the same routes in memory, but cannot upgrade a socket. Under
**celld**, Deno's self-hosted Durable Object runtime, `CELLD_IDLE_EVICT_S` is the equivalent of
`evictDurableObject`: the idle seconds after which it evicts an object.

## Deploy

workerd, Cloudflare's runtime, serves an object's sockets under any `compatibility_date`.
celld 0.6.2 differs from it twice, each difference a gotcha of the declaration it touches: a
socket's upgrade headers after an eviction, on `ActionDurableObject.layerWebSocket`, and an
alarm set on a class without an `alarm` method, on `ActionDurableObject.handlers`. What an
eviction loses is on `ActionDurableObject.handlers`.
