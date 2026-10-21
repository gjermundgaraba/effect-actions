import { Effect } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import { protocolVersion, unsupportedProtocol } from "../Rpc.js";

// Router middleware on the room's socket route, refusing the upgrade of a page that names
// another version of the rpcs, `?protocol=<n>`, as browser.ts sends it. A browser cannot read
// the status of an upgrade it was refused: its WebSocket reports a bare 1006, as for a network
// drop, which a page answers by connecting again. So the refusal answers 101 and closes the
// socket at once with a code and reason of the application's own, which the page's Effect
// client fails its calls and streams with, as `SocketCloseError`, and the page asks its user
// to reload. The socket is a pair of its own, accepted without the hibernation API: the
// library's route never runs, so the object keeps nothing of it. A request that is no upgrade
// passes on, and the route answers it 426.
export const refuseOtherVersions = HttpRouter.middleware((httpEffect) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const { protocol } = yield* HttpServerRequest.ParsedSearchParams;

    if (request.headers["upgrade"]?.toLowerCase() !== "websocket" || protocol === protocolVersion) {
      return yield* httpEffect;
    }

    const { 0: page, 1: room } = new WebSocketPair();

    room.accept();
    room.close(unsupportedProtocol, `This room speaks protocol ${protocolVersion}: reload`);

    return HttpServerResponse.raw(new Response(null, { status: 101, webSocket: page }));
  }),
).layer;
