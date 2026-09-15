import { Context, Effect, JsonPointer, Layer, Schema } from "effect";
import type { Cause } from "effect";
import type { NonEmptyReadonlyArray } from "effect/Array";
import type * as JsonSchema from "effect/JsonSchema";
import { McpProtocol, McpSchema, McpServer } from "effect/unstable/ai";
import { HttpRouter } from "effect/unstable/http";
import type * as Action from "./Action.js";
import {
  handlerFor,
  type Handlers,
  Implementation,
  requestEffect,
} from "./internal/implementation.js";

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

/** Encode with the declared codec; `structuredContent` must be JSON. Failure is a defect, as on HTTP. */
const toJson = (schema: Action.Codec, value: unknown) =>
  Schema.encodeUnknownEffect(schema)(value).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(Schema.Json)),
    Effect.orDie,
  );

const toolResult = (structuredContent: Schema.Json, isError: boolean) =>
  new McpSchema.CallToolResult({
    isError,
    structuredContent,
    content: [{ type: "text", text: JSON.stringify(structuredContent) }],
  });

const withDefinitions = (schema: JsonSchema.JsonSchema, definitions: JsonSchema.Definitions) => ({
  ...schema,
  ...(Object.keys(definitions).length === 0 ? {} : { $defs: definitions }),
});

// MCP structuredContent must be an object. Only resolve the generated root
// reference; recursive references still need the complete definitions pool,
// including the inlined root's definition.
const objectJsonSchema = (name: string, what: string, schema: Action.Codec, hint = "") => {
  const document = Schema.toJsonSchemaDocument(schema);
  let root = document.schema;
  if (typeof root.$ref === "string") {
    const reference = root.$ref;
    const path = JsonPointer.parseUriFragment(reference);
    const key = path?.[1];
    if (path?.length !== 2 || path[0] !== "$defs" || key === undefined) {
      throw new Error(`${name}: unsupported MCP ${what} reference ${reference}`);
    }
    const definition = Object.hasOwn(document.definitions, key)
      ? document.definitions[key]
      : undefined;
    if (definition === undefined)
      throw new Error(`${name}: missing MCP ${what} reference ${reference}`);
    root = definition;
  }
  if (root.type !== "object")
    throw new Error(`${name}: MCP ${what} must have an object root${hint}`);
  return withDefinitions(root, document.definitions);
};

const registerTool = <R>(action: Action.Any, table: Handlers<R>) =>
  Effect.gen(function* () {
    if (action.mcp === false) return;
    const server = yield* McpServer.McpServer;
    const inputSchema = yield* Schema.decodeUnknownEffect(McpSchema.ToolJson)(
      objectJsonSchema(action.name, "input", action.input, "; use Action.NoInput for no arguments"),
    ).pipe(Effect.orDie);
    // Successes are wrapped as { value }; declared errors are published as-is, so
    // each must already encode to an object.
    for (const error of action.errors) objectJsonSchema(action.name, "error", error);
    const output = Schema.toJsonSchemaDocument(Schema.Struct({ value: action.success }));
    const failure = Schema.Union(action.errors);
    const handle = handlerFor(table, action);

    yield* server.addTool({
      tool: new McpSchema.Tool({
        name: action.mcp.name,
        description: action.description,
        inputSchema,
        outputSchema: withDefinitions(output.schema, output.definitions),
        annotations: {
          readOnlyHint: action.mcp.readOnly,
          destructiveHint: action.mcp.destructive,
        },
      }),
      annotations: Context.empty(),
      handle: (payload: unknown) =>
        Effect.gen(function* () {
          // Signal native InvalidParams; this snapshot presents it as an isError tool result.
          const input = yield* Schema.decodeUnknownEffect(action.input)(payload).pipe(
            Effect.mapError((error) => new McpSchema.InvalidParams({ message: error.message })),
          );
          return yield* requestEffect(handle(input)).pipe(
            Effect.matchEffect({
              onSuccess: (value) =>
                Effect.map(toJson(action.success, value), (json) =>
                  toolResult({ value: json }, false),
                ),
              onFailure: (error) =>
                Effect.map(toJson(failure, error), (json) => toolResult(json, true)),
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
          Effect.updateContext<never, HttpRouter.HttpRouter>(() =>
            Context.make(HttpRouter.HttpRouter, router),
          ),
        );
      }),
    );
  });
