import { Effect, Option, Schema } from "effect";
import { HttpClient, type HttpClientError } from "effect/http";
import { McpSchema } from "effect/ai";
import type { Any as Authentication, VerifierError } from "../authentication/provider.js";
import type * as Action from "../contract/Action.js";
import { type Call, checked } from "../contract/call.js";
import { type BuiltIn, Refusal } from "../contract/errors.js";
import { progressSink, type Reporting } from "../contract/progress.js";
import { Anyone } from "../contract/caller.js";
import { projectedErrors } from "../contract/declared.js";
import { assertOnce } from "../contract/names.js";
import { elementOf, type ToolAction } from "../contract/stream.js";
import { defaultPath, type Lift, liftOf, unliftedFrom } from "./protocol.js";
import {
  bodyOf,
  callError,
  failWith,
  type McpCallError,
  NoReply,
  NoStructuredContent,
  ProtocolError,
  replyOf,
  StatusError,
  UndeclaredError,
} from "./reply.js";
import { request } from "./request.js";

/**
 * Where `client` sends, through what client, and what the endpoint's authentication declares: the
 * client `transformClient` returns may fail with `E` and require `R`.
 */
export interface ClientOptions<
  D extends Authentication | undefined = Authentication | undefined,
  E = HttpClientError.HttpClientError,
  R = never,
> {
  /**
   * The endpoint, resolved by the `HttpClient`: relative under `Testing.layer`. Defaults to `/mcp`,
   * the default `layerHttp` path, so a call to an endpoint on another `path` fails with an
   * `McpCallError` that `answered 404`.
   */
  readonly url?: string;
  /**
   * Wraps the native `HttpClient`, as `ActionHttp.client` takes it: a bearer token is
   * `HttpClient.mapRequest(HttpClientRequest.bearerToken(token))`.
   */
  readonly transformClient?: (client: HttpClient.HttpClient) => HttpClient.HttpClient.With<E, R>;
  /**
   * The endpoint's descriptor, as `layerHttp` takes it: an error its verifier declares, the
   * endpoint's HTTP answer for a protected tool, is then that error's decoded value, as over
   * `ActionHttp.client`; without it, the call fails with an `McpCallError` whose `reason` is a
   * `StatusError`.
   */
  readonly authentication?: D;
}

type CallError<A extends Action.Any, D> =
  | A["error"][number]["Type"]
  | VerifierError<A, D>["Type"]
  | BuiltIn
  | Schema.SchemaError
  | HttpClientError.HttpClientError
  | McpCallError;

/**
 * Every action of `Actions` as `client.<action>(input)`, calling its tool. Each call also fails
 * with `E` and requires `R`, what its `transformClient` adds.
 */
export type Client<
  Actions extends ReadonlyArray<Action.Any>,
  D = undefined,
  E = never,
  R = never,
> = {
  readonly [A in ToolAction<Actions[number]> as A["name"]]: Call<
    A,
    Effect.Effect<A["success"]["Type"], CallError<A, D> | E, R>
  >;
};

type Block = McpSchema.CallToolResult["content"][number];

const textOf = (block: Block | undefined): string | undefined =>
  block?.type === "text" ? block.text : undefined;

const ToolCallReply = Schema.Union([
  Schema.Struct({ result: McpSchema.CallToolResult }),
  Schema.Struct({ error: Schema.Struct({ code: Schema.Finite, message: Schema.String }) }),
]);

const toolCallReplyOf = replyOf(Schema.decodeUnknownOption(Schema.fromJsonString(ToolCallReply)));

// Why: `execute` alone, since the native client is invariant in what it fails with and requires:
// no one client type holds both a plain client and a transformed one, but each one's `execute` fits.
const callTool = (
  client: Pick<HttpClient.HttpClient.With<unknown, unknown>, "execute">,
  url: string,
  action: Action.Any,
  lift: Lift,
  refusedWith: Action.Errors,
  input: Action.Any["input"]["Type"],
  sink: Reporting | undefined,
): Effect.Effect<unknown, unknown, unknown> => {
  const { name } = action;

  return Effect.gen(function* () {
    const encoded = yield* Schema.encodeEffect(Schema.toCodecJson(action.input))(input);

    const response = yield* client.execute(
      request(
        "tools/call",
        {
          name,
          arguments: encoded,
          // Why: Any token will do, since a stateless request's notifications are its own.
          ...(sink === undefined ? {} : { _meta: { progressToken: "progress" } }),
        },
        { url },
      ),
    );

    const body = yield* bodyOf(name, response, sink);
    const { text } = body;

    if (response.status !== 200) {
      return yield* failWith(
        refusedWith,
        text,
        callError(name, new StatusError({ status: response.status, body: text })),
      );
    }

    const reply = toolCallReplyOf(body);

    if (Option.isNone(reply)) {
      return yield* Effect.fail(callError(name, new NoReply({ body: text })));
    }

    if ("error" in reply.value) {
      return yield* Effect.fail(callError(name, new ProtocolError(reply.value.error)));
    }

    const { result } = reply.value;

    if (result.isError === true) {
      const error = textOf(result.content.find((block) => block.type === "text")) ?? "";

      return yield* failWith(
        projectedErrors(action),
        error,
        callError(name, new UndeclaredError({ text: error })),
      );
    }

    if (result.structuredContent === undefined && lift.rest !== undefined) {
      return yield* Effect.fail(callError(name, new NoStructuredContent({ body: text })));
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
 * or a refusal, is its decoded value, and so is a refusal the endpoint's authentication answers
 * with: a test telling a 401 or 403 from a tool result asserts the status of a request `request`
 * builds. The argument may be omitted when `{}` is a valid input. Requires the native
 * `HttpClient`, such as the one `Testing.layer` provides.
 *
 * **Gotchas**
 *
 * - It drops undeclared input fields as it encodes, and fails with `InvalidInput`, sending nothing, for an input that does not encode.
 * - A call given `onProgress` sends a `progressToken` and reads each `notifications/progress` as its frame arrives; a call without one sends none, so the endpoint sends no progress.
 */
export function client<
  const Actions extends ReadonlyArray<Action.Any>,
  D extends Authentication | undefined = undefined,
>(
  actions: Actions,
  options?: ClientOptions<D>,
): Effect.Effect<Client<Actions, D>, never, HttpClient.HttpClient>;
export function client<
  const Actions extends ReadonlyArray<Action.Any>,
  E,
  R,
  D extends Authentication | undefined = undefined,
>(
  actions: Actions,
  options: ClientOptions<D, E, R>,
): Effect.Effect<Client<Actions, D, E, R>, never, HttpClient.HttpClient>;
export function client(
  listed: ReadonlyArray<Action.Any>,
  {
    url = defaultPath,
    transformClient,
    authentication,
  }: ClientOptions | ClientOptions<Authentication | undefined, unknown, unknown> = {},
): Effect.Effect<unknown, never, HttpClient.HttpClient> {
  assertOnce("action", listed);

  // Why: a tool answers one result, so an action answering a stream has no method, as `Client`
  // types it.
  const actions = listed.filter((action) => elementOf(action.success) === undefined);

  const refusedWith = (contract: Pick<Action.Any, "caller">): Action.Errors => [
    ...Refusal.members,
    ...(contract.caller === Anyone ? [] : (authentication?.error ?? [])),
  ];

  return Effect.map(HttpClient.HttpClient, (native) => {
    const http = transformClient === undefined ? native : transformClient(native);

    return Object.fromEntries(
      actions.map((action) => {
        const lift = liftOf(action.success);

        return [
          action.name,
          checked(action, (input, onProgress) =>
            callTool(
              http,
              url,
              action,
              lift,
              refusedWith(action),
              input,
              progressSink(action.progress, onProgress),
            ),
          ),
        ];
      }),
    );
  });
}
