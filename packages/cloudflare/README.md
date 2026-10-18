# effect-actions-cloudflare

`@gjermundgaraba/effect-actions-cloudflare` serves
[effect-actions](https://github.com/gjermundgaraba/effect-actions) from Cloudflare Durable
Objects, and calls them from a Worker. It is released with `@gjermundgaraba/effect-actions`, at
the same version, and requires it.

```sh
pnpm add @gjermundgaraba/effect-actions @gjermundgaraba/effect-actions-cloudflare effect@~4.0.4
```

Call an object's routes from a Worker with the core's own clients, through the stub:

```ts
import * as ActionDurableObject from "@gjermundgaraba/effect-actions-cloudflare/ActionDurableObject";

ActionHttp.client(Http, { baseUrl: "https://object" }).pipe(
  Effect.provide(ActionDurableObject.layerHttpClient(env.ROOM.getByName("lobby"))),
);
```

MIT licensed.
