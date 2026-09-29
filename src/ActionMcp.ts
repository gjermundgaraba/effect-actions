import { Context, Effect, Layer, Option, Predicate, Schema } from "effect";
import type { Cause } from "effect";
import type { Stdio as StdioService } from "effect/Stdio";
import { McpProtocol, McpSchema, McpServer } from "effect/ai";
import type { HttpRouter } from "effect/http";
import type * as Action from "./Action.js";
import { bindTools, type SurfaceOptions, TextField, type ToolOptions } from "./internal/tools.js";
import {
  type AnyImplementation,
  type BuildContext,
  type BuildError,
  type HiddenFromMcp,
  type RequestContext,
} from "./internal/implementation.js";

/**
 * One Streamable HTTP MCP endpoint: every native `McpServer.layerHttp` option except
 * `protocols` (server information, `path`, `allowedOrigins`, `instructions`,
 * `extensions`, ...), plus the surface's `errors` and `before`.
 */
export interface Options<Errors extends ReadonlyArray<Action.Codec> = [], R = never>
  extends Omit<Parameters<typeof McpServer.layerHttp>[0], "protocols">, SurfaceOptions<Errors, R> {}

/** An MCP subprocess on standard I/O: every native `McpServer.layerStdio` option except `protocols`. */
export interface StdioOptions<Errors extends ReadonlyArray<Action.Codec> = [], R = never>
  extends
    Omit<Parameters<typeof McpServer.layerStdio>[0], "protocols">,
    SurfaceOptions<Errors, R> {}

/**
 * The one protocol revision served. 2026-07-28 is stateless over HTTP: no
 * initialize handshake and no session, so every request stands alone.
 */
const protocols = [McpProtocol.v2026_07_28] as const;

/** The native server supplies its own request context to every tool call. */
type ToolRequestContext<App, RB> = Exclude<
  RequestContext<App, HiddenFromMcp> | RB,
  McpSchema.McpRequestContext
>;

type Registration = Parameters<McpServer.McpServer["Service"]["addTool"]>[0];

/** The parts of a listed output schema a text field is removed from. */
const decodeOutput = Schema.decodeUnknownOption(
  Schema.Struct({
    properties: Schema.Record(Schema.String, Schema.Json),
    required: Schema.optionalKey(Schema.Array(Schema.String)),
  }),
);

/** A JSON value that is an object: neither null, a scalar nor an array. */
const isJsonObject = (value: Schema.Json | undefined): value is Schema.JsonObject =>
  Predicate.isObject(value);

/** Split a JSON object into one field and the rest. */
const detach = (value: Schema.JsonObject, field: string) => {
  const { [field]: detached, ...rest } = value;

  return { detached, rest };
};

/**
 * The listed output schema without the text field. Only a top-level property can be
 * detached; anything else fails the layer build rather than publish a schema the
 * structured content would not satisfy.
 */
const outputWithout = (tool: McpSchema.Tool, field: string) => {
  const { properties: _, required: __, ...output } = tool.outputSchema ?? {};
  const listed = Option.getOrUndefined(decodeOutput(tool.outputSchema));

  if (listed === undefined || !Object.hasOwn(listed.properties, field)) {
    return Effect.die(
      `MCP tool '${tool.name}' cannot send '${field}' as text: it is not a top-level property of its success`,
    );
  }

  const required = (listed.required ?? []).filter((key) => key !== field);

  return Effect.succeed({
    ...output,
    properties: detach(listed.properties, field).rest,
    ...(required.length === 0 ? {} : { required }),
  });
};

/**
 * A successful result with a string text field sent once, raw, before the structured
 * rest and its JSON copy. Any other result, such as a failure or a success without
 * the field, is the native one.
 */
const textResult = (result: McpSchema.CallToolResult, field: string) => {
  const structured = result.structuredContent;

  if (result.isError === true || !isJsonObject(structured)) return result;

  const { detached, rest } = detach(structured, field);

  if (!Predicate.isString(detached)) return result;

  return new McpSchema.CallToolResult({
    // The constructor rebuilds the native result class from its own fields.
    // oxlint-disable-next-line typescript/no-misused-spread -- Copies a Schema.Class instance into its own constructor; the prototype is restored and the fields validated.
    ...result,
    structuredContent: rest,
    content: [
      { type: "text", text: detached },
      { type: "text", text: JSON.stringify(rest) },
    ],
  });
};

/** A native registration whose success sends `field` as text. */
const withText = (registration: Registration, field: string): Effect.Effect<Registration> =>
  Effect.map(outputWithout(registration.tool, field), (outputSchema): Registration => ({
    ...registration,
    // oxlint-disable-next-line typescript/no-misused-spread -- Copies a Schema.Class instance into its own constructor; the prototype is restored and the fields validated.
    tool: new McpSchema.Tool({ ...registration.tool, outputSchema }),
    handle: (payload) =>
      Effect.map(registration.handle(payload), (result) =>
        Predicate.isTagged(result, "InputRequired") ? result : textResult(result, field),
      ),
  }));

const registration = (apps: ReadonlyArray<AnyImplementation>, options: ToolOptions) => {
  const binding = bindTools(apps, "mcp", options);

  // The native server builds every listing and result, and always sends the whole
  // success as structured content. A text field is moved out of what it registers, so
  // decoding, failures and defects stay native.
  const registered = McpServer.registerToolkit(binding.toolkit).pipe(
    Effect.updateService(McpServer.McpServer, (server) => ({
      ...server,
      addTool: (tool: Registration) => {
        const field = Context.get(tool.annotations, TextField);

        return field === undefined
          ? server.addTool(tool)
          : Effect.flatMap(withText(tool, field), server.addTool);
      },
    })),
  );

  return Layer.effectDiscard(registered).pipe(Layer.provide(binding.layer));
};

const server = <Out, R>(
  apps: ReadonlyArray<AnyImplementation>,
  options: ToolOptions,
  transport: Layer.Layer<Out, Cause.IllegalArgumentError, R>,
) =>
  registration(apps, options).pipe(
    Layer.provide(transport),
    // The native registry is mutable; every endpoint/subprocess gets its own one.
    Layer.fresh,
  );

/**
 * Serve MCP tools over one Streamable HTTP endpoint, speaking MCP 2026-07-28 only.
 *
 * Middleware provided around this layer has the normal HTTP lifetime. Native
 * context capture applies: never provide request-identity tags at startup.
 */
export function layerHttp<
  const Apps extends ReadonlyArray<AnyImplementation>,
  const Errors extends ReadonlyArray<Action.Codec> = [],
  RB = never,
>(
  apps: readonly [...Apps],
  options: Options<Errors, RB>,
): Layer.Layer<
  never,
  BuildError<Apps[number], HiddenFromMcp> | Cause.IllegalArgumentError,
  | BuildContext<Apps[number], HiddenFromMcp>
  | HttpRouter.HttpRouter
  | HttpRouter.Request.From<"Requires", ToolRequestContext<Apps[number], RB>>
>;
export function layerHttp(
  apps: ReadonlyArray<AnyImplementation>,
  options: Options<ReadonlyArray<Action.Codec>, unknown>,
) {
  return server(apps, options, McpServer.layerHttp({ ...options, protocols }));
}

/**
 * Serve MCP tools through newline-delimited JSON-RPC on standard I/O, speaking MCP
 * 2026-07-28 only. An older host is refused deliberately, for uniformity with HTTP,
 * even though stdio has no sessions.
 *
 * The host supplies the `Stdio` service. Arguments are tool input only and
 * never establish request identity or authority.
 */
export function layerStdio<
  const Apps extends ReadonlyArray<AnyImplementation>,
  const Errors extends ReadonlyArray<Action.Codec> = [],
  RB = never,
>(
  apps: readonly [...Apps],
  options: StdioOptions<Errors, RB>,
): Layer.Layer<
  never,
  BuildError<Apps[number], HiddenFromMcp> | Cause.IllegalArgumentError,
  BuildContext<Apps[number], HiddenFromMcp> | StdioService | ToolRequestContext<Apps[number], RB>
>;
export function layerStdio(
  apps: ReadonlyArray<AnyImplementation>,
  options: StdioOptions<ReadonlyArray<Action.Codec>, unknown>,
) {
  return server(apps, options, McpServer.layerStdio({ ...options, protocols }));
}
