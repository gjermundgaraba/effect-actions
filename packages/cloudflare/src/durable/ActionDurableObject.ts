import { Layer } from "effect";
import { FetchHttpClient, type HttpClient } from "effect/http";

/**
 * An `HttpClient` whose requests go to `fetcher`, a Durable Object stub or a service binding,
 * in place of the network: what `ActionHttp.client`, `ActionRpc.client` over
 * `RpcClient.layerProtocolHttp` and `ActionMcp.client` call it with. A request's URL needs a
 * host, which the fetcher ignores, such as `https://object/api`. Nothing authenticates the
 * request on its way: forward the caller's credential, as for any remote surface.
 */
export const layerHttpClient = (
  fetcher: Pick<Fetcher, "fetch">,
): Layer.Layer<HttpClient.HttpClient> =>
  FetchHttpClient.layer.pipe(
    Layer.provide(
      Layer.succeed(FetchHttpClient.Fetch)((input, init) => fetcher.fetch(input, init)),
    ),
  );
