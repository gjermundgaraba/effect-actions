import { Context, Effect, JsonPointer, Layer, Schema } from "effect";
import type { Cause } from "effect";
import type { NonEmptyReadonlyArray } from "effect/Array";
import type * as JsonSchema from "effect/JsonSchema";
import { McpProtocol, McpSchema, McpServer, Tool } from "effect/unstable/ai";
import { HttpRouter } from "effect/unstable/http";
import type * as Action from "./Action.js";
import { handlerFor, type Handlers, Implementation } from "./internal/implementation.js";

export interface Options {
  readonly name: string;
  readonly version: string;
  readonly path?: HttpRouter.PathInput;
  readonly protocols?: NonEmptyReadonlyArray<McpProtocol.ProtocolAdapter>;
  readonly allowedOrigins?: ReadonlyArray<string>;
  readonly instructions?: string;
}

/** Every published revision; 2026-07-28 is the single stateless one. */
export const protocols: NonEmptyReadonlyArray<McpProtocol.ProtocolAdapter> = [
  McpProtocol.v2026_07_28,
  McpProtocol.v2025_11_25,
  McpProtocol.v2025_06_18,
  McpProtocol.v2025_03_26,
  McpProtocol.v2024_11_05,
];

/** Encoded output is statically `Json`. Failure is a defect, as on HTTP. */
const encode = (codec: Schema.Codec<unknown, Schema.Json>, value: unknown) =>
  Schema.encodeUnknownEffect(codec)(value).pipe(Effect.orDie);

const toolResult = (structuredContent: Schema.Json, isError: boolean) =>
  new McpSchema.CallToolResult({
    isError,
    structuredContent,
    content: [{ type: "text", text: JSON.stringify(structuredContent) }],
  });

// Only the generated root reference is resolved; recursive references still
// need the complete definitions pool, including the inlined root's definition.
const resolveReference = (
  name: string,
  what: string,
  schema: JsonSchema.JsonSchema,
  definitions: JsonSchema.Definitions,
): JsonSchema.JsonSchema => {
  if (typeof schema.$ref !== "string") return schema;
  const reference = schema.$ref;
  const path = JsonPointer.parseUriFragment(reference);
  const key = path?.[1];
  if (path?.length !== 2 || path[0] !== "$defs" || key === undefined) {
    throw new Error(`${name}: unsupported MCP ${what} reference ${reference}`);
  }
  const definition = Object.hasOwn(definitions, key) ? definitions[key] : undefined;
  if (definition === undefined)
    throw new Error(`${name}: missing MCP ${what} reference ${reference}`);
  return definition;
};

/** MCP `inputSchema` requires a literal object root. */
const inputJsonSchema = (action: Action.Any) => {
  const { schema, definitions } = Schema.toJsonSchemaDocument(action.input);
  const root = resolveReference(action.name, "input", schema, definitions);
  if (root.type !== "object") {
    throw new Error(
      `${action.name}: MCP input must have an object root; use Action.NoInput for no arguments`,
    );
  }
  return Object.keys(definitions).length === 0 ? root : { ...root, $defs: definitions };
};

/** Declared errors are published as-is in `structuredContent`, so each must encode to an object. */
const assertObjectError = (action: Action.Any, error: Action.Codec) => {
  const { schema, definitions } = Schema.toJsonSchemaDocument(error);
  const visited = new Set<JsonSchema.JsonSchema>();
  // A union qualifies when every member does; a revisited node is already being checked.
  const encodesObject = (candidate: JsonSchema.JsonSchema): boolean => {
    const root = resolveReference(action.name, "error", candidate, definitions);
    if (root.type === "object" || visited.has(root)) return true;
    visited.add(root);
    const members = root.anyOf ?? root.oneOf;
    return Array.isArray(members) && members.length > 0 && members.every(encodesObject);
  };
  if (!encodesObject(schema)) throw new Error(`${action.name}: MCP error must have an object root`);
};

const registerTool = <R>(action: Action.Any, table: Handlers<R>) =>
  Effect.gen(function* () {
    if (action.mcp === false) return;
    const server = yield* McpServer.McpServer;
    const inputSchema = yield* Schema.decodeUnknownEffect(McpSchema.ToolJson)(
      inputJsonSchema(action),
    ).pipe(Effect.orDie);
    // Successes are wrapped as { value }; declared errors are not.
    for (const error of action.errors) assertObjectError(action, error);
    // The same JSON lowering HttpApiEndpoint applies, so both transports agree on the wire shape.
    const input = Schema.toCodecJson(action.input);
    const success = Schema.toCodecJson(action.success);
    const failure = Schema.toCodecJson(Schema.Union(action.errors));
    const handle = handlerFor(table, action);

    yield* server.addTool({
      tool: new McpSchema.Tool({
        name: action.mcp.name,
        description: action.description,
        inputSchema,
        outputSchema: Tool.getJsonSchemaFromSchema(Schema.Struct({ value: action.success })),
        annotations: {
          readOnlyHint: action.mcp.readOnly,
          destructiveHint: action.mcp.destructive,
        },
      }),
      annotations: Context.empty(),
      handle: (payload: unknown) =>
        Effect.gen(function* () {
          // Signal native InvalidParams; this snapshot presents it as an isError tool result.
          const decoded = yield* Schema.decodeUnknownEffect(input)(payload).pipe(
            Effect.mapError((error) => new McpSchema.InvalidParams({ message: error.message })),
          );
          return yield* handle(decoded).pipe(
            Effect.matchEffect({
              onSuccess: (value) =>
                Effect.map(encode(success, value), (json) => toolResult({ value: json }, false)),
              onFailure: (error) =>
                Effect.map(encode(failure, error), (json) => toolResult(json, true)),
            }),
          );
        }),
    });
  });

// Native route registration must still see the host's route middleware. Only
// the registration effects run in that context; the MCP runtime does not.
const registrationRouter = (
  router: HttpRouter.HttpRouter,
  context: Context.Context<never>,
): HttpRouter.HttpRouter =>
  HttpRouter.HttpRouter.of({
    ...router,
    add: (method, path, handler, options) =>
      router.add(method, path, handler, options).pipe(Effect.provideContext(context)),
    addAll: (routes) => router.addAll(routes).pipe(Effect.provideContext(context)),
    prefixed: (prefix) => registrationRouter(router.prefixed(prefix), context),
  });

/** A Streamable HTTP MCP endpoint serving the group's MCP-enabled actions. */
export const layer = <Actions extends ReadonlyArray<Action.Any>, R, EX, RX>(
  app: Implementation<Actions, R, EX, RX>,
  options: Options,
): Layer.Layer<
  never,
  EX | Cause.IllegalArgumentError,
  RX | HttpRouter.HttpRouter | HttpRouter.Request.From<"Requires", R>
> =>
  Implementation.register(app, (table) => {
    const native = Layer.effectDiscard(
      Effect.forEach(app.actions, (action) => registerTool(action, table), { discard: true }),
    ).pipe(
      Layer.provide(
        McpServer.layerHttp({
          name: options.name,
          version: options.version,
          instructions: options.instructions,
          path: options.path ?? "/mcp",
          protocols: options.protocols ?? protocols,
          allowedOrigins: options.allowedOrigins,
        }),
      ),
      // Each endpoint owns its native tool registry and sessions. The handler
      // implementation is acquired outside this fresh subgraph and stays shared.
      Layer.fresh,
    );
    // Isolate the entire native server, including RPC handler installation.
    // Its captured context is a fallback when a request omits a service.
    return Layer.fromBuildMemo((memoMap, scope) =>
      Effect.gen(function* () {
        const router = registrationRouter(
          yield* HttpRouter.HttpRouter,
          yield* Effect.context<never>(),
        );
        return yield* Layer.buildWithMemoMap(native, memoMap, scope).pipe(
          Effect.setContext(Context.make(HttpRouter.HttpRouter, router)),
        );
      }),
    );
  });
