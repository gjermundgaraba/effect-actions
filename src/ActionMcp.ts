import { Context, Effect, JsonPointer, Layer, Schema } from "effect";
import type { Cause } from "effect";
import type { NonEmptyReadonlyArray } from "effect/Array";
import type * as JsonSchema from "effect/JsonSchema";
import { McpProtocol, McpSchema, McpServer, Tool } from "effect/unstable/ai";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import type * as Action from "./Action.js";
import { handlerFor, type Handlers, Implementation } from "./internal/implementation.js";

export interface Options<Errors extends ReadonlyArray<Action.Codec> = []> {
  readonly schemaError?: Action.SchemaErrorPolicy<Errors>;
  readonly name: string;
  readonly version: string;
  readonly path: HttpRouter.PathInput;
  readonly protocols?: NonEmptyReadonlyArray<McpProtocol.ProtocolAdapter>;
  readonly allowedOrigins?: ReadonlyArray<string>;
  readonly instructions?: string;
}

/** Protocol revisions served over Streamable HTTP; 2026-07-28 is stateless. */
export const protocols: NonEmptyReadonlyArray<McpProtocol.ProtocolAdapter> = [
  McpProtocol.v2026_07_28,
  McpProtocol.v2025_11_25,
  McpProtocol.v2025_06_18,
  McpProtocol.v2025_03_26,
  McpProtocol.v2024_11_05,
];

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
const assertObjectError = (owner: string, error: Action.Codec) => {
  const { schema, definitions } = Schema.toJsonSchemaDocument(error);
  const visited = new Set<JsonSchema.JsonSchema>();
  // A union qualifies when every member does; a revisited node is already being checked.
  const encodesObject = (candidate: JsonSchema.JsonSchema): boolean => {
    const root = resolveReference(owner, "error", candidate, definitions);
    if (root.type === "object" || visited.has(root)) return true;
    visited.add(root);
    const members = root.anyOf ?? root.oneOf;
    return Array.isArray(members) && members.length > 0 && members.every(encodesObject);
  };
  if (!encodesObject(schema)) throw new Error(`${owner}: MCP error must have an object root`);
};

const registerTool = <R>(
  action: Action.Any,
  table: Handlers<R>,
  policy: Action.SchemaErrorPolicy<ReadonlyArray<Action.Codec>> | undefined,
) =>
  Effect.gen(function* () {
    if (action.mcp === false) return;
    const server = yield* McpServer.McpServer;
    const inputSchema = yield* Schema.decodeUnknownEffect(McpSchema.ToolJson)(
      inputJsonSchema(action),
    ).pipe(Effect.orDie);
    // Successes are wrapped as { value }; declared errors are not.
    const errors = [...action.errors, ...(policy?.errors ?? [])];
    for (const error of action.errors) assertObjectError(action.name, error);
    // The same JSON lowering HttpApiEndpoint applies, so both transports agree on the wire shape.
    const input = Schema.toCodecJson(action.input);
    const success = Schema.toCodecJson(action.success);
    const failure = Schema.toCodecJson(Schema.Union(errors));
    const handle = handlerFor(table, action);
    const failureResult = (error: unknown) =>
      Schema.encodeUnknownEffect(failure)(error).pipe(
        Effect.orDie,
        Effect.map((json) => toolResult(json, true)),
      );
    const schemaFailure = (phase: Action.SchemaFailure["phase"], cause: Schema.SchemaError) => {
      if (policy !== undefined) return failureResult(policy.map({ phase, cause }));
      if (phase === "input")
        return Effect.fail(new McpSchema.InvalidParams({ message: cause.message }));
      return Effect.die(cause);
    };
    const successResult = (value: unknown) =>
      Schema.encodeUnknownEffect(success)(value).pipe(
        Effect.matchEffect({
          onFailure: (cause) => schemaFailure("output", cause),
          onSuccess: (json) => Effect.succeed(toolResult({ value: json }, false)),
        }),
      );

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
        Schema.decodeUnknownEffect(input)(payload).pipe(
          Effect.matchEffect({
            onFailure: (cause) => schemaFailure("input", cause),
            onSuccess: (decoded) =>
              handle(decoded).pipe(
                Effect.matchEffect({
                  onSuccess: successResult,
                  onFailure: failureResult,
                }),
              ),
          }),
        ),
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
export const layer = <
  Actions extends ReadonlyArray<Action.Any>,
  R,
  EX,
  RX,
  Errors extends ReadonlyArray<Action.Codec> = [],
>(
  app: Implementation<Actions, R, EX, RX>,
  options: Options<Errors>,
): Layer.Layer<
  never,
  EX | Cause.IllegalArgumentError,
  RX | HttpRouter.HttpRouter | HttpRouter.Request.From<"Requires", R>
> =>
  Implementation.register(app, (table) => {
    const native = Layer.effectDiscard(
      Effect.gen(function* () {
        if (app.actions.some((action) => action.mcp !== false)) {
          for (const error of options.schemaError?.errors ?? [])
            assertObjectError("Schema-error policy", error);
        }
        yield* Effect.forEach(
          app.actions,
          (action) => registerTool(action, table, options.schemaError),
          {
            discard: true,
          },
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
      // Each endpoint owns its native tool registry and sessions; the handler
      // build is acquired outside this subgraph and stays shared.
      Layer.fresh,
    );
    // Build the native server with only the router so build-time application
    // services cannot become request fallbacks.
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

export interface ProtectedResourceOptions {
  /** Exact OAuth resource identifier. HTTPS, or HTTP on loopback for development. */
  readonly resource: string;
  readonly authorizationServers: NonEmptyReadonlyArray<string>;
  readonly scopesSupported?: ReadonlyArray<string>;
  readonly resourceName?: string;
}

export interface BearerChallengeOptions {
  readonly error?: "invalid_token" | "insufficient_scope";
  readonly errorDescription?: string;
  /** Space-separated scopes needed for this request, not all supported scopes. */
  readonly scope?: string;
}

const oauthUrl = (value: string): URL => {
  const url = new URL(value);
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (
    (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) ||
    url.username !== "" ||
    url.password !== "" ||
    value.includes("#")
  ) {
    throw new Error("OAuth URLs must use HTTPS (or loopback HTTP) without credentials or fragment");
  }
  return url;
};

const scopeToken = /^[\x21\x23-\x5B\x5D-\x7E]+$/;

/**
 * Publish RFC 9728 discovery independently from the authenticated MCP route.
 * This supplies metadata and challenges; the host still verifies access tokens.
 */
export const protectedResource = (options: ProtectedResourceOptions) => {
  const resource = oauthUrl(options.resource);
  if (options.authorizationServers.length === 0)
    throw new Error("An authorization server is required");
  for (const issuer of options.authorizationServers) {
    oauthUrl(issuer);
    if (issuer.includes("?"))
      throw new Error("Authorization server issuers must not contain a query");
  }
  for (const scope of options.scopesSupported ?? []) {
    if (!scopeToken.test(scope)) throw new Error("Invalid OAuth scope token");
  }
  const path =
    `/.well-known/oauth-protected-resource${resource.pathname === "/" ? "" : resource.pathname}` as const;
  const discoveryUrl = new URL(resource);
  discoveryUrl.pathname = path;
  const metadataUrl = discoveryUrl.href;
  const target = metadataUrl.slice(discoveryUrl.origin.length);
  const metadata = {
    resource: options.resource,
    authorization_servers: options.authorizationServers,
    bearer_methods_supported: ["header"],
    ...(options.scopesSupported?.length ? { scopes_supported: options.scopesSupported } : {}),
    ...(options.resourceName === undefined ? {} : { resource_name: options.resourceName }),
  };
  const response = HttpServerResponse.jsonUnsafe(metadata);
  return {
    // Resource paths and queries are literal URLs, not router patterns. Leave nonmatches
    // to the host, including other discovery documents on the same router.
    layer: HttpRouter.middleware(
      (next) =>
        Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest;
          const url = new URL(request.url, resource.origin);
          if (
            (request.method === "GET" || request.method === "HEAD") &&
            url.href.slice(url.origin.length) === target
          )
            return response;
          return yield* next;
        }),
      { global: true },
    ),
    metadataUrl,
    challenge: (challenge: BearerChallengeOptions = {}): string => {
      const parameters = [`resource_metadata="${metadataUrl.replace(/["\\]/g, "\\$&")}"`];
      if (challenge.error !== undefined) parameters.push(`error="${challenge.error}"`);
      if (challenge.errorDescription !== undefined) {
        if (!/^[\x20-\x21\x23-\x5B\x5D-\x7E]*$/.test(challenge.errorDescription)) {
          throw new Error("Invalid OAuth error description");
        }
        parameters.push(`error_description="${challenge.errorDescription}"`);
      }
      if (challenge.scope !== undefined) {
        if (!challenge.scope.split(" ").every((scope) => scopeToken.test(scope))) {
          throw new Error("Invalid OAuth challenge scope");
        }
        parameters.push(`scope="${challenge.scope}"`);
      }
      return `Bearer ${parameters.join(", ")}`;
    },
  };
};
