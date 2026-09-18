import { Context, Effect, Layer, Schema } from "effect";
import type { Cause } from "effect";
import type { NonEmptyReadonlyArray } from "effect/Array";
import { McpProtocol, McpServer, Tool, Toolkit } from "effect/unstable/ai";
import type { HttpRouter } from "effect/unstable/http";
import type * as Action from "./Action.js";
import { type Actions, assertDistinct, served } from "./internal/actions.js";
import {
  type AnyImplementation,
  type BuildContext,
  type BuildError,
  type RequestContext,
  type ErasedValue,
  Implementation,
} from "./internal/implementation.js";

/** One MCP endpoint; `name`, `version`, `instructions` are the server's `serverInfo`. */
export interface Options {
  readonly name: string;
  readonly version: string;
  /** Route of the Streamable HTTP endpoint; no default. */
  readonly path: HttpRouter.PathInput;
  /** Protocol revisions to serve; defaults to every revision this snapshot supports. */
  readonly protocols?: NonEmptyReadonlyArray<McpProtocol.ProtocolAdapter>;
  /** Browser origins accepted by the native server; passed through to `McpServer.layerHttp`. */
  readonly allowedOrigins?: ReadonlyArray<string>;
  readonly instructions?: string;
}

/** Protocol revisions served over Streamable HTTP by default; 2026-07-28 is stateless. */
const protocols: NonEmptyReadonlyArray<McpProtocol.ProtocolAdapter> = [
  McpProtocol.v2026_07_28,
  McpProtocol.v2025_11_25,
  McpProtocol.v2025_06_18,
  McpProtocol.v2025_03_26,
  McpProtocol.v2024_11_05,
];

type McpTool = Exclude<Action.Any["mcp"], false>;

// The same JSON lowering HttpApiEndpoint applies, so both transports agree on the wire
// shape. Declared errors are returned, not raised: the native server then reports them
// as `isError` text carrying their encoding, unencodable ones as its generic failure.
const tool = (action: Action.Any, mcp: McpTool) =>
  Tool.make(mcp.name, {
    description: action.description,
    parameters: Schema.toCodecJson(action.input),
    // `structuredContent` must be an object, so successes are wrapped as { value }.
    success: Schema.toCodecJson(Schema.Struct({ value: action.success })),
    failure: Schema.toCodecJson(Schema.Union(action.errors)),
    failureMode: "return",
  })
    .annotate(Tool.Readonly, mcp.readOnly)
    .annotate(Tool.Destructive, mcp.destructive);

const erasedLayer = <R, EX, RX>(
  apps: ReadonlyArray<Implementation<Actions, R, EX, RX>>,
  options: Options,
) => {
  // Implementations without a tool are not acquired.
  const serving = apps.flatMap((app) =>
    served([app.group], (action) => action.mcp !== false).map(({ actions }) => ({ app, actions })),
  );

  const tools = serving.flatMap(({ app, actions }) =>
    actions.flatMap((action) => {
      if (action.mcp === false) return [];
      const made = tool(action, action.mcp);
      const root = Tool.getJsonSchemaFromSchema(made.parametersSchema);

      // The native check rejects the same schemas, but without naming the action.
      // A `$ref` root (recursive or identified schemas) is left to it.
      if (root.$ref === undefined && root.type !== "object") {
        throw new Error(
          `${action.name}: MCP input must have an object root; omit input for no arguments`,
        );
      }

      return [{ app, action, tool: made }];
    }),
  );

  // Tools are the only namespace this adapter owns.
  assertDistinct(
    "MCP tool",
    tools.map(({ tool }) => tool.name),
  );

  const toolkit = Toolkit.make(...tools.map(({ tool }) => tool));

  return Implementation.register(serving, (bound) => {
    const handlers = Object.fromEntries(
      tools.map(({ app, action, tool }) => {
        const implementation = bound.find((candidate) => candidate.group === app.group);

        if (implementation === undefined)
          throw new Error(`Missing implementation: ${app.group.name}`);
        const handle = implementation.handle(action);

        return [
          tool.name,
          (input: ErasedValue) => Effect.map(handle(input), (value) => ({ value })),
        ];
      }),
    );

    return Layer.effectDiscard(
      Effect.gen(function* () {
        const server = yield* McpServer.McpServer;

        // registerToolkit hands its build context to every handler, over the
        // request context. Registered with only the server present, a startup
        // copy of a request service cannot shadow the request's own. A service
        // the request omits entirely is still found in the route layer's context;
        // the types require the request to provide it.
        yield* McpServer.registerToolkit(toolkit).pipe(
          Effect.provide(toolkit.toLayer(handlers)),
          Effect.setContext(Context.make(McpServer.McpServer, server)),
        );
      }),
    ).pipe(
      Layer.provide(
        McpServer.layerHttp({
          name: options.name,
          version: options.version,
          instructions: options.instructions,
          path: options.path,
          protocols: options.protocols ?? protocols,
          allowedOrigins: options.allowedOrigins,
        }),
      ),
      // Each endpoint owns its native tool registry and sessions.
      Layer.fresh,
    );
  });
};

/**
 * One Streamable HTTP MCP endpoint serving every MCP-enabled action of `apps`.
 * An endpoint is one route, so middleware provided to this layer covers all of its tools.
 * Duplicate tool names and non-object input roots across `apps` fail here.
 */
export function layer<const Apps extends ReadonlyArray<AnyImplementation>>(
  options: Options,
  ...apps: Apps
): Layer.Layer<
  never,
  BuildError<Apps[number]> | Cause.IllegalArgumentError,
  | BuildContext<Apps[number]>
  | HttpRouter.HttpRouter
  | HttpRouter.Request.From<"Requires", RequestContext<Apps[number]>>
>;
export function layer(options: Options, ...apps: ReadonlyArray<AnyImplementation>) {
  return erasedLayer(apps, options);
}
