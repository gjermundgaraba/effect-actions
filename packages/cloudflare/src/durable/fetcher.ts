import { Layer } from "effect";
import { FetchHttpClient } from "effect/http";
import type { HttpClient } from "effect/http";

/**
 * An `HttpClient` whose requests go to `fetcher`, a Durable Object stub or a service binding,
 * in place of the network: what `ActionHttp.client`, `ActionRpc.client` over
 * `RpcClient.layerProtocolHttp` and `ActionMcp.client` call an object's routes with, or a
 * Worker's.
 *
 * **Gotchas**
 *
 * - A request's URL needs a host, which the fetcher ignores, such as `https://object/api`: a relative URL fails before it is sent.
 * - Nothing authenticates the request on its way: forward the caller's credential, with the client's `transformClient`, as for any remote surface.
 * - To pass a page's request on to an object, forward the `Request` itself with the stub's `fetch`: its upgrade goes with it, which this client does not send.
 *
 * Guide: `docs/ActionDurableObject.md` in this package.
 */
export const layerHttpClient = (
  fetcher: Pick<Fetcher, "fetch">
): Layer.Layer<HttpClient.HttpClient> =>
  FetchHttpClient.layer.pipe(
    Layer.provide(
      Layer.succeed(FetchHttpClient.Fetch)(
        async (input, init) => await fetcher.fetch(input, init)
      )
    )
  );
