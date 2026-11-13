import { Context } from "effect";
import type { Scope } from "effect";
import { HttpEffect, HttpRouter } from "effect/http";
import type { HttpServerRequest } from "effect/http";

import { initialize } from "./application.js";
import type { Application } from "./application.js";

export {
  ClusterDurableQueue,
  ClusterEntity,
  ClusterSingleton,
  ClusterWorkflow,
} from "@effect/platform-cloudflare/CloudflareDurableObjects";

export { RoomsEntrypoint } from "./rooms-entrypoint.js";

export default {
  async fetch(request: Request, env: Cloudflare.Env) {
    const context = await initialize(env);

    return await HttpEffect.toWebHandlerWith<
      Application,
      HttpServerRequest.HttpServerRequest | Scope.Scope
    >(context)(Context.get(context, HttpRouter.HttpRouter).asHttpEffect())(
      request
    );
  },
} satisfies ExportedHandler<Cloudflare.Env>;
