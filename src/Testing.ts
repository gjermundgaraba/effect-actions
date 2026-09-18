import { Effect, Layer, Predicate } from "effect";
import { FetchHttpClient } from "effect/unstable/http";
import type * as ActionHttp from "./ActionHttp.js";
import type { Actions } from "./internal/actions.js";

/** A web handler, such as `HttpRouter.toWebHandler(routes).handler`. */
export type Handler = (request: Request) => Promise<Response>;

/**
 * The typed HTTP client, calling `handler` in memory instead of the network.
 * `baseUrl` defaults to `http://localhost`.
 */
export const httpClient = <G extends Actions>(
  http: Pick<ActionHttp.Http<G>, "client">,
  handler: Handler,
  options?: ActionHttp.ClientOptions,
): Effect.Effect<ActionHttp.Client<G>> =>
  http
    .client({ baseUrl: "http://localhost", ...options })
    .pipe(
      Effect.provide(
        FetchHttpClient.layer.pipe(
          Layer.provide(
            Layer.succeed(FetchHttpClient.Fetch, (input, init) =>
              handler(new Request(input, init)),
            ),
          ),
        ),
      ),
    );

/** A stateless 2026-07-28 request. */
export interface McpRequestOptions {
  readonly url: string | URL;
  readonly method: string;
  readonly params?: McpRequestParams;
  readonly headers?: ConstructorParameters<typeof Headers>[0];
}

/**
 * What `JSON.stringify` accepts, not only valid JSON: `undefined` fields are
 * dropped, and tests send malformed arguments on purpose.
 */
export type McpRequestValue =
  | string
  | number
  | boolean
  | null
  | undefined
  | ReadonlyArray<McpRequestValue>
  | { readonly [key: string]: McpRequestValue };

/** JSON-RPC `params`; `_meta` is merged shallowly over the defaults `mcpRequest` supplies. */
export interface McpRequestParams {
  readonly _meta?: { readonly [key: string]: McpRequestValue };
  readonly [key: string]: McpRequestValue;
}

/** Build one stateless 2026-07-28 JSON-RPC request, with client metadata defaulted. */
export const mcpRequest = ({
  url,
  method,
  params = {},
  headers: init,
}: McpRequestOptions): Request => {
  const headers = new Headers(init);
  headers.set("content-type", "application/json");
  headers.set("accept", "application/json, text/event-stream");
  headers.set("mcp-protocol-version", "2026-07-28");
  headers.set("mcp-method", method);

  if (Predicate.isString(params.name)) headers.set("mcp-name", params.name);

  return new Request(url, {
    method: "POST",
    headers,
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method,
      params: {
        ...params,
        _meta: Object.assign(
          {
            "io.modelcontextprotocol/clientCapabilities": {},
            "io.modelcontextprotocol/clientInfo": { name: "test", version: "0" },
          },
          params._meta,
          { "io.modelcontextprotocol/protocolVersion": "2026-07-28" },
        ),
      },
    }),
  });
};
