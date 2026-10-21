import { Effect } from "effect";
import { HttpRouter, HttpServerRequest } from "effect/http";
import * as ActionDurableObject from "@gjermundgaraba/effect-actions-cloudflare/ActionDurableObject";
import { protocolVersion, unsupportedProtocol } from "../Rpc.js";

// Router middleware on the room's socket route, refusing the upgrade of a page that names another
// version of the rpcs, `?protocol=<n>`, as browser.ts sends it. It answers with `refuseUpgrade`,
// not a 403, which a browser reports as a bare 1006 its page connects again after: the page's
// Effect client fails its calls and streams with this code and reason, as `SocketCloseError`, and
// stops connecting again at it, browser.ts's `reconnect`, asking its user to reload. A request
// that is no upgrade passes on, and the route answers it 426.
export const refuseOtherVersions = HttpRouter.middleware((httpEffect) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const { protocol } = yield* HttpServerRequest.ParsedSearchParams;

    if (request.headers["upgrade"]?.toLowerCase() !== "websocket" || protocol === protocolVersion) {
      return yield* httpEffect;
    }

    return yield* ActionDurableObject.refuseUpgrade(
      unsupportedProtocol,
      `This room speaks protocol ${protocolVersion}: reload`,
    );
  }),
).layer;
