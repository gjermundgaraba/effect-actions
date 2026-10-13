import { Effect, identity, Option, Predicate, Schema } from "effect";
import {
  type Headers,
  HttpClient,
  type HttpClientError,
  HttpClientRequest,
  type HttpClientResponse,
} from "effect/http";
import { McpSchema } from "effect/ai";
import { Sse } from "effect/encoding";
import type { Any as Authentication, VerifierError } from "../authentication/provider.js";
import type * as Action from "../contract/Action.js";
import { type Call, checked } from "../contract/call.js";
import { type BuiltIn, Refusal } from "../contract/errors.js";
import { Anyone, assertOnce, projectedErrors } from "../contract/rules.js";
import { defaultPath, httpProtocol, type Lift, liftOf, unliftedFrom } from "./protocol.js";

/**
 * An MCP request's parameters, as `request` takes them: JSON, with any `_meta`, leaving
 * out an `undefined` one, as a caller may. A helper passing on whole params types them as this,
 * and a tool's `arguments` as `Schema.Json`, never `unknown`.
 */
export interface Params {
  readonly _meta?: { readonly [key: string]: Schema.Json };
  readonly [key: string]: Schema.Json | undefined;
}

/**
 * One stateless MCP request of `method` with `params`, as `layerHttp` serves it: the headers
 * routing it, which repeat what its body says, and its JSON-RPC body. The client metadata goes in
 * `_meta`, under any given, such as a `progressToken`; the protocol version is always the
 * request's own.
 */
export const statelessRequest = (method: string, params: Params) => {
  const { protocolVersion } = httpProtocol;
  const name = method === "resources/read" ? params.uri : params.name;

  return {
    headers: {
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": protocolVersion,
      "mcp-method": method,
      ...(Predicate.isString(name) ? { "mcp-name": name } : {}),
    },
    body: {
      jsonrpc: "2.0",
      id: 1,
      method,
      params: {
        ...params,
        _meta: {
          "io.modelcontextprotocol/clientCapabilities": {},
          "io.modelcontextprotocol/clientInfo": { name: "effect-actions", version: "0" },
          ...params._meta,
          "io.modelcontextprotocol/protocolVersion": protocolVersion,
        },
      },
    },
  };
};

/** Where `client` sends, through what client, and what the endpoint's authentication declares. */
export interface ClientOptions<D extends Authentication | undefined = Authentication | undefined> {
  /**
   * The endpoint, resolved by the `HttpClient`: relative under `Testing.layer`. Defaults to `/mcp`,
   * the default `layerHttp` path.
   */
  readonly url?: string;
  /**
   * Wraps the native `HttpClient`, as `ActionHttp.client` takes it: a bearer token is
   * `HttpClient.mapRequest(HttpClientRequest.bearerToken(token))`.
   */
  readonly transformClient?: (client: HttpClient.HttpClient) => HttpClient.HttpClient;
  /**
   * The endpoint's descriptor, as `layerHttp` takes it: an error its verifier declares, the
   * endpoint's HTTP answer for a protected tool, is then that error's decoded value, as over
   * `ActionHttp.client`.
   */
  readonly authentication?: D;
}

/** Where a `request` goes, and with what headers. */
export interface RequestOptions {
  /**
   * The endpoint, resolved by the `HttpClient` that sends the request: relative under `Testing.layer`.
   * Defaults to `/mcp`, as `client`'s does; converting to a web `Request` needs an absolute
   * one.
   */
  readonly url?: string;
  readonly headers?: Headers.Input;
}

/**
 * An answer a client method cannot read as the action's success or a declared error, such as
 * the native server's message for invalid arguments or an unknown tool, or a result without
 * its structured content. Its message holds the answer. Structured content that does not
 * decode as the success is a `SchemaError` instead, and a request that fails an
 * `HttpClientError`.
 */
export class McpCallError extends Schema.TaggedError<McpCallError>()("McpCallError", {
  message: Schema.String,
}) {}

type CallError<A extends Action.Any, D> =
  | A["error"][number]["Type"]
  | VerifierError<A, D>["Type"]
  | BuiltIn
  | Schema.SchemaError
  | HttpClientError.HttpClientError
  | McpCallError;

/** Every action of `Actions` as `client.<action>(input)`, calling its tool. */
export type Client<Actions extends ReadonlyArray<Action.Any>, D = undefined> = {
  readonly [A in Actions[number] as A["name"]]: Call<
    A,
    Effect.Effect<A["success"]["Type"], CallError<A, D>>
  >;
};

type Block = McpSchema.CallToolResult["content"][number];

const textOf = (block: Block | undefined): string | undefined =>
  block?.type === "text" ? block.text : undefined;

const ToolCallReply = Schema.Union([
  Schema.Struct({ result: McpSchema.CallToolResult }),
  Schema.Struct({ error: Schema.Struct({ code: Schema.Finite, message: Schema.String }) }),
]);

const decodeReply = Schema.decodeUnknownOption(Schema.fromJsonString(ToolCallReply));

const replyOf = (response: HttpClientResponse.HttpClientResponse, text: string) => {
  if (!(response.headers["content-type"] ?? "").startsWith("text/event-stream")) {
    return decodeReply(text);
  }

  const data: Array<string> = [];

  Sse.makeParser((event) => {
    if (Predicate.isTagged(event, "Event")) data.push(event.data);
  }).feed(text);

  return Option.fromNullishOr(
    data.flatMap((message) => Option.toArray(decodeReply(message))).at(-1),
  );
};

const failWith = (errors: Action.Errors, text: string, otherwise: McpCallError) =>
  Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.toCodecJson(Schema.Union(errors))))(
    text,
  ).pipe(
    Effect.mapError(() => otherwise),
    Effect.flatMap(Effect.fail),
  );

const callTool = (
  client: HttpClient.HttpClient,
  url: string,
  action: Action.Any,
  lift: Lift,
  refusedWith: Action.Errors,
  input: Action.Any["input"]["Type"],
): Effect.Effect<unknown, unknown> => {
  const { name } = action;

  const other = (answer: string) =>
    new McpCallError({ message: `MCP tools/call "${name}" ${answer}` });

  return Effect.gen(function* () {
    const encoded = yield* Schema.encodeEffect(Schema.toCodecJson(action.input))(input);

    const response = yield* client.execute(
      request("tools/call", { name, arguments: encoded }, { url }),
    );

    const text = yield* response.text;

    if (response.status !== 200) {
      return yield* failWith(refusedWith, text, other(`answered ${response.status}: ${text}`));
    }

    const reply = replyOf(response, text);

    if (Option.isNone(reply)) return yield* Effect.fail(other(`had no reply: ${text}`));

    if ("error" in reply.value) {
      const { code, message } = reply.value.error;

      return yield* Effect.fail(other(`failed with ${code}: ${message}`));
    }

    const { result } = reply.value;

    if (result.isError === true) {
      const error = textOf(result.content.find((block) => block.type === "text")) ?? "";

      return yield* failWith(projectedErrors(action), error, other(`returned an error: ${error}`));
    }

    if (result.structuredContent === undefined && lift.rest !== undefined) {
      return yield* Effect.fail(other(`returned no structured content: ${text}`));
    }

    return yield* Schema.decodeUnknownEffect(Schema.toCodecJson(action.success))(
      unliftedFrom(lift, result),
    );
  });
};

/**
 * A client of an MCP endpoint served by `layerHttp`, one method per action calling
 * its tool with one stateless request, as `ActionHttp.client` calls routes: the input is
 * encoded with the action's schema, and the success decoded from its structured content, each
 * media field from the blocks whose `_meta` names it, and a success that is media, or whose
 * every field is, from its blocks alone. A declared error the tool returns, the action's own
 * or a refusal, is its decoded value, and so is a refusal the endpoint's authentication
 * answers with, or an error its verifier declares, given the `authentication`: a test telling a 401 or 403 from a tool result asserts the status of a request
 * `request` builds. The argument may be omitted when `{}` is a valid input. Requires the
 * native `HttpClient`, such as the one `Testing.layer` provides.
 */
export function client<
  const Actions extends ReadonlyArray<Action.Any>,
  D extends Authentication | undefined = undefined,
>(
  actions: Actions,
  options?: ClientOptions<D>,
): Effect.Effect<Client<Actions, D>, never, HttpClient.HttpClient>;
export function client(
  actions: ReadonlyArray<Action.Any>,
  { url = defaultPath, transformClient = identity, authentication }: ClientOptions = {},
): Effect.Effect<
  {
    readonly [name: string]: (...input: ReadonlyArray<unknown>) => Effect.Effect<unknown, unknown>;
  },
  never,
  HttpClient.HttpClient
> {
  assertOnce("action", actions);

  return Effect.map(HttpClient.HttpClient, (native) => {
    const http = transformClient(native);

    return Object.fromEntries(
      actions.map((action) => {
        const lift = liftOf(action.success);

        const refusedWith = [
          ...Refusal.members,
          ...(action.caller === Anyone ? [] : (authentication?.error ?? [])),
        ];

        return [
          action.name,
          checked(action, (input) => callTool(http, url, action, lift, refusedWith, input)),
        ];
      }),
    );
  });
}

/**
 * One stateless MCP request of `method` with `params`, as `layerHttp` serves it,
 * as the native request value: the JSON-RPC envelope, the 2026-07-28 headers (`Accept`,
 * `MCP-Protocol-Version`, `MCP-Method`), `mcp-name` from
 * `params.uri` for `resources/read` and `params.name` otherwise, and the client metadata in
 * `_meta` are filled in, under any `_meta` given, such as a `progressToken`; the protocol
 * version is always the request's own. The test sends it: `HttpClient.execute` answers the
 * response as the endpoint sent it, whatever its status, and `HttpClientRequest.toWebResult`
 * gives the web `Request` a web handler or `fetch` takes, once `url` is absolute. It is for a test
 * asserting on what `client` decodes away, such as `tools/list`, a refusal's challenge, or
 * a call its types would not send.
 */
export const request = (
  method: string,
  params: Params = {},
  { headers = {}, url = defaultPath }: RequestOptions = {},
): HttpClientRequest.HttpClientRequest => {
  const { headers: routingHeaders, body } = statelessRequest(method, params);

  return HttpClientRequest.post(url).pipe(
    HttpClientRequest.setHeaders(headers),
    HttpClientRequest.setHeaders(routingHeaders),
    HttpClientRequest.bodyJsonUnsafe(body),
  );
};
