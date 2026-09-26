import { Effect, Layer, Option, Schema } from "effect";
import {
  HttpClient,
  HttpClientRequest,
  HttpEffect,
  HttpRouter,
  HttpServer,
} from "effect/unstable/http";
import { clientOf, type Served } from "./internal/memory.js";
import { mcpMessage, type McpRequestValue } from "./internal/mcp-request.js";

/**
 * The native `HttpClient`, answered in memory by `routes` instead of the network: provide
 * it to `ActionHttpClient.make` and to `mcpCall`. The routes are built with this layer and
 * released with its scope, without request logs, with the platform services
 * `HttpServer.layerServices` provides. They must satisfy their per-request requirements
 * themselves, with their middleware. A relative URL resolves against `http://localhost`.
 */
export function layer<A, E, R extends Served>(
  routes: Layer.Layer<A, E, R>,
): Layer.Layer<HttpClient.HttpClient, E>;
export function layer(
  routes: Layer.Layer<unknown, unknown, Served>,
): Layer.Layer<HttpClient.HttpClient, unknown> {
  return Layer.unwrap(
    Effect.map(
      HttpRouter.toHttpEffect(routes.pipe(Layer.provide(HttpServer.layerServices))),
      (app) => clientOf(HttpEffect.toWebHandler(app)),
    ),
  );
}

/** One `tools/call` for `mcpCall`: the endpoint, the tool and its arguments. */
interface McpCallOptions {
  /** The tool name: its action's name. */
  readonly name: string;
  /** Defaults to `{}`. It may be malformed on purpose. */
  readonly arguments?: { readonly [key: string]: McpRequestValue };
  /**
   * The endpoint, resolved by the `HttpClient`: relative under `layer`. Defaults to `/mcp`,
   * the default `ActionMcp.layerHttp` path.
   */
  readonly url?: string;
  readonly headers?: ConstructorParameters<typeof Headers>[0];
}

/**
 * A tool call's outcome with the library's wire envelope removed: the success from
 * `structuredContent.value`, or the error text of an `isError` result, parsed as JSON
 * when it is JSON (a declared error, whatever its shape) and kept as the text otherwise
 * (the native server's own message, such as for invalid arguments).
 */
export type McpCallResult =
  | { readonly isError: false; readonly value: Schema.Json }
  | { readonly isError: true; readonly error: Schema.Json };

/** The JSON-RPC response to a `tools/call`: a tool result or a protocol error. */
const ToolReply = Schema.Union([
  Schema.Struct({
    result: Schema.Struct({
      isError: Schema.optionalKey(Schema.Boolean),
      structuredContent: Schema.optionalKey(Schema.Struct({ value: Schema.Json })),
      content: Schema.Array(
        Schema.Struct({ type: Schema.String, text: Schema.optionalKey(Schema.String) }),
      ),
    }),
  }),
  Schema.Struct({ error: Schema.Struct({ code: Schema.Finite, message: Schema.String }) }),
]);

const decodeReply = Schema.decodeUnknownOption(Schema.fromJsonString(ToolReply));

const parseJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Json));

/**
 * Call one tool with a stateless 2026-07-28 request on the `HttpClient`, such as the one
 * `layer` provides, and return its outcome. A response that is not an HTTP 200 carrying a
 * tool result, such as an authentication refusal or a JSON-RPC error, fails with its
 * status and body.
 */
export const mcpCall = ({
  name,
  headers: init,
  arguments: args = {},
  url = "/mcp",
}: McpCallOptions): Effect.Effect<McpCallResult, Error, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const { headers, body } = mcpMessage({
      method: "tools/call",
      params: { name, arguments: args },
      ...(init === undefined ? {} : { headers: init }),
    });

    const response = yield* HttpClient.execute(
      HttpClientRequest.post(url).pipe(
        HttpClientRequest.setHeaders(Object.fromEntries(headers)),
        HttpClientRequest.bodyText(body, "application/json"),
      ),
    );

    const text = yield* response.text;

    if (response.status !== 200) {
      return yield* Effect.fail(
        new Error(`MCP tools/call "${name}" answered ${response.status}: ${text}`),
      );
    }

    // A JSON body is one message; an event stream carries one per `data:` line, and
    // notifications may precede the reply.
    const reply = text
      .split("\n")
      .map((line) => line.replace(/^data:/, "").trim())
      .flatMap((line) => Option.toArray(decodeReply(line)))
      .at(-1);

    if (reply === undefined) {
      return yield* Effect.fail(new Error(`MCP tools/call "${name}" had no reply: ${text}`));
    }

    if ("error" in reply) {
      return yield* Effect.fail(
        new Error(
          `MCP tools/call "${name}" failed with ${reply.error.code}: ${reply.error.message}`,
        ),
      );
    }

    const { result } = reply;

    if (result.isError === true) {
      const error = result.content.find((content) => content.type === "text")?.text ?? "";

      return { isError: true, error: Option.getOrElse(parseJson(error), () => error) };
    }

    if (result.structuredContent === undefined) {
      return yield* Effect.fail(
        new Error(`MCP tools/call "${name}" returned no structured content: ${text}`),
      );
    }

    return { isError: false, value: result.structuredContent.value };
  });
