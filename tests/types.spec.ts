import { McpProtocol, McpSchema, Tool } from "effect/ai";
// Compile-only assertions, included by `vp check`, never executed by Vitest.
import { Context, Effect, Layer, Schema, type Stdio } from "effect";
import { type HttpClient, type HttpClientError, HttpRouter, HttpServer } from "effect/http";
import { HttpApiClient, OpenApi } from "effect/http-api";
import * as Action from "../src/Action.js";
import * as ActionHttp from "../src/ActionHttp.js";
import * as ActionMcp from "../src/ActionMcp.js";
import * as ActionToolkit from "../src/ActionToolkit.js";
import * as Authentication from "../src/Authentication.js";
import * as Testing from "../src/Testing.js";
import { makeTestHttp, makeTestMcp } from "./server.js";
import { CurrentActor } from "../examples/authorization.js";
import { Double, GetUser, RenameUser, WhoAmI } from "../examples/contracts.js";
import { authenticate } from "../examples/authentication.js";
import { userActions } from "../examples/handlers.js";
import { Users } from "../examples/users.js";
import type { Equal } from "./equal.js";

const Actions = [GetUser, RenameUser, Double, WhoAmI] as const;

const Http = ActionHttp.make(Actions);

/** What every request to a layer must carry. */
type RequestServices<L extends Layer.Any> = HttpRouter.Request.Only<"Requires", Layer.Services<L>>;

const services = Layer.provide(HttpServer.layerServices);

/** The example's user actions without their policy: each surface owes their identity. */
const App = Action.implement(
  [GetUser, RenameUser, WhoAmI],
  Effect.gen(function* () {
    const users = yield* Users;

    return {
      getUser: ({ id }) => Effect.flatMap(CurrentActor, (actor) => users.get(actor.tenantId, id)),
      renameUser: ({ id, name }) =>
        Effect.flatMap(CurrentActor, (actor) => users.rename(actor, id, name)),
      whoAmI: () => Effect.map(CurrentActor, ({ id, tenantId }) => ({ id, tenantId })),
    };
  }),
);

export const typeAssertions = () => {
  const actor = { id: "alice", tenantId: "acme", permissions: [] };

  const ok = {
    getUser: ({ id }: { id: string }) => Effect.succeed({ id, name: "Ada" }),
    renameUser: ({ id, name }: { id: string; name: string }) => Effect.succeed({ id, name }),
    double: ({ value }: { value: number }) => Effect.succeed(value * 2),
    whoAmI: () => Effect.succeed({ id: "alice", tenantId: "acme" }),
  };

  const single = Action.implement(Double, ok.double);
  // @ts-expect-error No public implementation Layer.
  void single.layer;
  // @ts-expect-error No public handler record.
  void single.handlers;
  // @ts-expect-error Implementations cannot be fabricated from a contract.
  ActionHttp.layer(Http, [{ actions: [Double] }]);
  // @ts-expect-error Spreading a nominal implementation cannot manufacture its private builder.
  // oxlint-disable-next-line typescript/no-misused-spread -- Deliberate nominal-fabrication compile-failure fixture.
  ActionHttp.layer(Http, [{ ...single, actions: [Double] }]);
  // @ts-expect-error Every listed action needs a handler.
  Action.implement(Actions, { ...ok, whoAmI: undefined });
  // @ts-expect-error Handler results must match the success schema.
  Action.implement(Actions, { ...ok, double: ({ value }) => Effect.succeed(String(value)) });
  // @ts-expect-error Handlers may only fail with the declared errors.
  Action.implement(Actions, { ...ok, double: () => Effect.fail(new Error("undeclared")) });
  Action.implement(Actions, {
    ...ok,
    // @ts-expect-error Handlers receive the decoded input, number rather than its wire string.
    double: ({ value }: { value: string }) => Effect.succeed(Number(value)),
  });
  Action.implement(Actions, {
    ...ok,
    // @ts-expect-error Input fields come from the schema.
    // oxlint-disable-next-line typescript/no-unsafe-assignment -- Compile-failure fixture: the rejected field yields an error type; nothing runs.
    getUser: ({ userId }) => Effect.succeed({ id: userId, name: "" }),
  });
  // @ts-expect-error A single action takes its handler, not a record.
  Action.implement(Double, ok);
  // @ts-expect-error A single handler's result must match the success schema.
  Action.implement(Double, () => Effect.succeed("two"));
  // @ts-expect-error A single handler may only fail with the declared errors.
  Action.implement(Double, () => Effect.fail(new Error("undeclared")));

  HttpRouter.toWebHandler(
    // @ts-expect-error Build-time handler dependencies are Layer requirements.
    ActionHttp.layer(Http, App).pipe(services),
  );

  const http = HttpRouter.toWebHandler(
    ActionHttp.layer(Http, App).pipe(Layer.provide(Users.layerMemory), services),
  );

  // @ts-expect-error Request-scoped handler dependencies must be present per request.
  void http.handler(new Request("http://localhost"), Context.empty());
  void http.handler(new Request("http://localhost"), Context.make(CurrentActor, actor));

  // MCP carries the same request requirement as HTTP; forgetting middleware is a compile error.
  const mcpLayer = ActionMcp.layerHttp(App, { name: "t", version: "0" });

  // @ts-expect-error Build-time handler dependencies are Layer requirements.
  HttpRouter.toWebHandler(mcpLayer.pipe(services));
  const mcp = HttpRouter.toWebHandler(mcpLayer.pipe(Layer.provide(Users.layerMemory), services));
  // @ts-expect-error Request-scoped handler dependencies must be present per request.
  void mcp.handler(new Request("http://localhost/mcp"), Context.empty());
  void mcp.handler(new Request("http://localhost/mcp"), Context.make(CurrentActor, actor));

  // The native server supplies its own request context, so the stdio host owes only `Stdio`.
  const contextual = Action.implement(
    Action.make("client", {
      description: "Client",
      access: "write",
      success: Schema.String,
      hints: {},
    }),
    () => Effect.map(McpSchema.McpRequestContext, (context) => context.clientInfo?.name ?? ""),
  );

  const stdio: Effect.Effect<void, unknown, Stdio.Stdio> = ActionMcp.runStdio(contextual, {
    name: "t",
    version: "0",
  });

  void stdio;

  const requestOnly = Action.implement(Actions, {
    ...ok,
    whoAmI: () => Effect.map(CurrentActor, ({ id, tenantId }) => ({ id, tenantId })),
  });

  // @ts-expect-error Test helpers must not erase missing request services.
  makeTestHttp([requestOnly]);
  // @ts-expect-error Test helpers must not erase missing request services.
  makeTestMcp([requestOnly]);

  const fallible = Action.implement(
    Actions,
    Effect.fail("build-failed" as const).pipe(Effect.as(ok)),
  );

  for (const routes of [
    ActionHttp.layer(Http, fallible),
    ActionMcp.layerHttp(fallible, { name: "test", version: "0" }),
  ]) {
    const build = Layer.build(routes.pipe(Layer.provide(HttpRouter.layer), services)).pipe(
      Effect.scoped,
    );

    // @ts-expect-error Private bindings must not erase acquisition failures.
    void (build satisfies Effect.Effect<unknown, never>);
  }
};

export const implementTypes = () => {
  class Store extends Context.Service<
    Store,
    { readonly name: (id: string) => Effect.Effect<string> }
  >()("types-spec/Store") {}

  class Principal extends Context.Service<Principal, string>()("types-spec/ImplementPrincipal") {}

  class BuildFailed extends Schema.TaggedError<BuildFailed>()("BuildFailed", {}) {}

  // Fields shorthand: a record of fields stands for the struct of them, input and success.
  const Lookup = Action.make("lookup", {
    description: "Lookup",
    access: "read",
    input: { id: Schema.String, limit: Schema.optionalKey(Schema.Finite) },
    success: { id: Schema.String, name: Schema.String },
  });

  const lookupInput: Equal<
    (typeof Lookup)["input"]["Type"],
    { readonly id: string; readonly limit?: number }
  > = true;

  const lookupSuccess: Equal<
    (typeof Lookup)["success"]["Type"],
    { readonly id: string; readonly name: string }
  > = true;

  void lookupInput;
  void lookupSuccess;

  const Rename = Action.make("rename", {
    description: "Rename",
    access: "write",
    input: Schema.Struct({ id: Schema.String, name: Schema.String }),
    success: Schema.String,
  });

  // One action, one handler: its parameter is typed from the contract.
  const plain = Action.implement(Lookup, ({ id }) =>
    Effect.succeed({ id, name: id.toUpperCase() }),
  );

  // One implementation, whose request requirements are kept per action name.
  const plainChannels: [
    Equal<
      Action.Implementation<typeof Lookup, { readonly lookup: never }, never, never>,
      typeof plain
    >,
  ] = [true];

  void plainChannels;

  // One action, one builder: startup services are separate from the handler's.
  const built = Action.implement(
    Lookup,
    Effect.gen(function* () {
      const store = yield* Store;

      return ({ id }) =>
        Effect.flatMap(Principal, () => Effect.map(store.name(id), (name) => ({ id, name })));
    }),
  );

  const builtChannels: Equal<
    Action.Implementation<typeof Lookup, { readonly lookup: Principal }, never, Store>,
    typeof built
  > = true;

  void builtChannels;

  // Several actions, one record: each handler is typed from its own contract.
  const record = Action.implement([Lookup, Rename], {
    lookup: ({ id }) => Effect.succeed({ id, name: "" }),
    rename: ({ name }) => Effect.succeed(name),
  });

  // Several actions, one builder: failures and services are shared, requests are per handler.
  const shared = Action.implement(
    [Lookup, Rename],
    Effect.gen(function* () {
      const store = yield* Store;

      if (Math.random() > 2) return yield* new BuildFailed();

      return {
        lookup: ({ id }) => Effect.map(store.name(id), (name) => ({ id, name })),
        rename: ({ name }) => Effect.as(Principal, name),
      };
    }),
  );

  const incomplete = Effect.succeed({ lookup: () => Effect.succeed({ id: "", name: "" }) });
  // @ts-expect-error A list's builder must supply every handler.
  Action.implement([Lookup, Rename], incomplete);
  // @ts-expect-error A builder's handlers may only fail with declared errors.
  Action.implement([Lookup], Effect.succeed({ lookup: () => Effect.fail("nope" as const) }));

  // Per action: the shared builder's `rename` owes `Principal`, its `lookup` nothing.
  const sharedRequests: Equal<
    (typeof shared)["~request"],
    { readonly lookup: never; readonly rename: Principal }
  > = true;

  void sharedRequests;

  // Surfaces take implementations as they are, and compute their requirements from them.
  const all = [plain, built, record, shared];
  const http = ActionHttp.make([Lookup, Rename]);

  // HTTP serves `rename`, so the request owes its `Principal`; builders owe `Store`.
  const routes = ActionHttp.layer(http, all);
  const httpRequest: Equal<RequestServices<typeof routes>, Principal> = true;
  const httpBuild: Store extends Layer.Services<typeof routes> ? true : false = true;
  const httpError: Equal<Layer.Error<typeof routes>, BuildFailed> = true;
  void httpRequest;
  void httpBuild;
  void httpError;

  // MCP serves what it is given: the shared builder's channels and `rename`'s request.
  const tools = ActionMcp.layerHttp([plain, shared], { name: "t", version: "0" });
  const mcpRequest: Equal<RequestServices<typeof tools>, Principal> = true;
  const mcpBuild: Store extends Layer.Services<typeof tools> ? true : false = true;
  const mcpError: "BuildFailed" extends Layer.Error<typeof tools>["_tag"] ? true : false = true;
  void mcpRequest;
  void mcpBuild;
  void mcpError;

  const Foreign = Action.make("foreign", {
    description: "Foreign",
    access: "read",
    success: Schema.String,
  });

  const foreign = Action.implement(Foreign, () => Effect.succeed(""));
  // @ts-expect-error Route layers exist only for implementations of the bound actions.
  ActionHttp.layer(http, foreign);
  // @ts-expect-error A list of implementations is not a list of contracts.
  ActionHttp.make(all);
};

export const clientTypes = Effect.gen(function* () {
  const client = yield* ActionHttp.client(Http);
  const doubled: number = yield* client.double({ value: 21 });
  void doubled;
  // No-input actions take no argument.
  yield* client.whoAmI();
  // @ts-expect-error Actions with input need their argument.
  client.double();
  // @ts-expect-error No-input actions reject invented fields.
  client.whoAmI({ actor: "alice" });
  // @ts-expect-error Action names are exact.
  // oxlint-disable-next-line typescript/no-unsafe-call -- Compile-failure fixture: the rejected method yields an error type; nothing runs.
  client.missing({});
  // @ts-expect-error Clients take decoded, not wire, inputs.
  client.double({ value: "21" });
  // @ts-expect-error Results retain the success type.
  const wrong: string = yield* client.double({ value: 21 });
  void wrong;

  // The native client stays available: a flat binding is one top-level group.
  const native = yield* HttpApiClient.make(Http.api);
  const nativeDoubled: number = yield* native.double({ payload: { value: 21 } });
  void nativeDoubled;
  // @ts-expect-error Native methods require the payload wrapper.
  native.double({ value: 21 });
});

export const builtInErrorTypes = Effect.gen(function* () {
  const Echo = Action.make("echo", {
    description: "Echo",
    access: "write",
    input: { value: Schema.Finite },
    success: Schema.Finite,
  });

  const bound = ActionHttp.make([Echo]);

  // A binding is plain data: its actions, its errors and the native API.
  const fields: Equal<keyof typeof bound, "actions" | "errors" | "api"> = true;
  void fields;

  // Any handler may fail with a built-in error, which every surface declares.
  Action.implement(Echo, () => Effect.fail(new Action.Forbidden({ scopes: ["admin"] })));
  Action.implement(Echo, () => Effect.fail(new Action.InvalidInput({ message: "Too many" })));
  // @ts-expect-error Only those and the declared errors.
  Action.implement(Echo, () => Effect.fail(new Error("undeclared")));

  // Every built-in error reaches every client method as a typed failure.
  const client = yield* ActionHttp.client(bound);
  yield* client.echo({ value: 1 }).pipe(
    Effect.catchTag("InvalidInput", () => Effect.succeed(0)),
    Effect.catchTag("Unauthenticated", () => Effect.succeed(0)),
    Effect.catchTag("Forbidden", () => Effect.succeed(0)),
  );

  const native = yield* HttpApiClient.make(bound.api);
  yield* native.echo({ payload: { value: 1 } }).pipe(
    Effect.catchTag("InvalidInput", () => Effect.succeed(0)),
    Effect.catchTag("Unauthenticated", () => Effect.succeed(0)),
    Effect.catchTag("Forbidden", () => Effect.succeed(0)),
  );

  yield* client
    .echo({ value: 1 })
    // @ts-expect-error Undeclared, so the client has no such failure to catch.
    .pipe(Effect.catchTag("Unrelated", () => Effect.succeed(0)));
});

export const configuredAdapterTypes = () => {
  const Bound = ActionHttp.make(Actions, { prefix: "/rpc" });
  // @ts-expect-error A configured binding must preserve acquisition requirements.
  HttpRouter.toWebHandler(ActionHttp.layer(Bound, App).pipe(services));

  const web = HttpRouter.toWebHandler(
    ActionHttp.layer(Bound, App).pipe(Layer.provide(Users.layerMemory), services),
  );

  // @ts-expect-error Configuring the binding must preserve request requirements.
  void web.handler(new Request("http://localhost"), Context.empty());
  // @ts-expect-error A prefix is an absolute path.
  ActionHttp.make(Actions, { prefix: "api" });
  ActionMcp.layerHttp(App, {
    name: "test",
    version: "0",
    // @ts-expect-error The protocol revision is fixed at 2026-07-28.
    protocols: [McpProtocol.v2026_07_28],
  });
  ActionMcp.runStdio(App, {
    name: "test",
    version: "0",
    // @ts-expect-error Stdio negotiates its own revisions: it takes no `protocols` option.
    protocols: [McpProtocol.v2026_07_28],
  });
  // Both mount paths have defaults: `/api` and `/mcp`.
  ActionHttp.make(Actions);
  // `Http.api` is a native HttpApi: Effect's own OpenAPI generator reads it without a cast.
  OpenApi.fromApi(Bound.api);
  ActionMcp.layerHttp(App, { name: "test", version: "0" });
  // @ts-expect-error MCP server information is required.
  ActionMcp.layerHttp(App, { path: "/mcp" });
};

export const layerTypes = () => {
  class Tenant extends Context.Service<Tenant, string>()("types/Tenant") {}

  class BuildA extends Context.Service<BuildA, string>()("types/BuildA") {}

  class BuildB extends Context.Service<BuildB, string>()("types/BuildB") {}

  const Invoice = Action.make("invoice", {
    description: "Invoice",
    access: "write",
    success: Schema.Number,
  });

  const billingApp = Action.implement(Invoice, () => Effect.as(Tenant, 1));

  const Both = ActionHttp.make([...Actions, Invoice]);

  // One top-level native group, so native methods are not nested either.
  void Effect.gen(function* () {
    const native = yield* HttpApiClient.make(Both.api);
    const nativeTotal: number = yield* native.invoice({ payload: {} });
    void nativeTotal;
  });

  ActionHttp.layer(Both, [App, billingApp]);

  const failsAfterBuildA = Action.implement(
    Invoice,
    Effect.fail("build-a" as const).pipe(
      Effect.tap(() => BuildA),
      Effect.as(() => Effect.succeed(1)),
    ),
  );

  const failsAfterBuildB = Action.implement(
    Actions,
    Effect.fail("build-b" as const).pipe(
      Effect.tap(() => BuildB),
      Effect.as({
        getUser: ({ id }: { id: string }) => Effect.succeed({ id, name: "" }),
        renameUser: ({ id, name }: { id: string; name: string }) => Effect.succeed({ id, name }),
        double: ({ value }: { value: number }) => Effect.succeed(value),
        whoAmI: () => Effect.succeed({ id: "", tenantId: "" }),
      }),
    ),
  );

  const combined = ActionHttp.layer(Both, [failsAfterBuildA, failsAfterBuildB]);
  // @ts-expect-error One layer preserves both disjoint build-service requirements.
  HttpRouter.toWebHandler(combined.pipe(services));

  const errorsAreExact: Equal<Layer.Error<typeof combined>, "build-a" | "build-b"> = true;
  const hasBuildA: BuildA extends Layer.Services<typeof combined> ? true : false = true;
  const hasBuildB: BuildB extends Layer.Services<typeof combined> ? true : false = true;
  void errorsAreExact;
  void hasBuildA;
  void hasBuildB;
  HttpRouter.toWebHandler(
    combined.pipe(
      Layer.provide(Layer.succeed(BuildA, "a")),
      Layer.provide(Layer.succeed(BuildB, "b")),
      services,
    ),
  );

  // Each layer carries only its own implementations' requirements.
  const billingOnly = HttpRouter.toWebHandler(ActionHttp.layer(Both, billingApp).pipe(services));
  void billingOnly.handler(new Request("http://localhost"), Context.make(Tenant, "acme"));

  const both = Context.make(Tenant, "acme").pipe(
    Context.add(CurrentActor, { id: "alice", tenantId: "acme", permissions: [] }),
  );

  // Checked per adapter: over a union of both, one's requirements would hide the other's absence.
  const mergedHttp = HttpRouter.toWebHandler(
    Layer.mergeAll(ActionHttp.layer(Both, App), ActionHttp.layer(Both, billingApp)).pipe(
      Layer.provide(Users.layerMemory),
      services,
    ),
  );

  // @ts-expect-error Merged, the request requirements are the union over every implementation.
  void mergedHttp.handler(new Request("http://localhost"), Context.make(Tenant, "acme"));
  void mergedHttp.handler(new Request("http://localhost"), both);

  const mergedMcp = HttpRouter.toWebHandler(
    ActionMcp.layerHttp([App, billingApp], { name: "test", version: "0" }).pipe(
      Layer.provide(Users.layerMemory),
      services,
    ),
  );

  // @ts-expect-error One endpoint requires the union over every implementation it serves.
  void mergedMcp.handler(new Request("http://localhost"), Context.make(Tenant, "acme"));
  void mergedMcp.handler(new Request("http://localhost"), both);

  // Implementing inline must not let the adapter's parameter type erase requirements.
  const inline = HttpRouter.toWebHandler(
    ActionHttp.layer(
      ActionHttp.make([Invoice]),
      Action.implement(Invoice, () => Effect.succeed(1)),
    ).pipe(services),
  );

  void inline.handler(new Request("http://localhost"));

  const inlineMcp = HttpRouter.toWebHandler(
    ActionMcp.layerHttp(
      Action.implement(Invoice, () => Effect.succeed(1)),
      {
        name: "test",
        version: "0",
      },
    ).pipe(services),
  );

  void inlineMcp.handler(new Request("http://localhost"));

  HttpRouter.toWebHandler(
    // @ts-expect-error Build requirements are the union over every merged layer.
    Layer.mergeAll(ActionHttp.layer(Both, App), ActionHttp.layer(Both, billingApp)).pipe(services),
  );
};

export const beforeTypes = () => {
  class Denied extends Schema.TaggedError<Denied>()("Denied", {}, { httpApiStatus: 403 }) {}

  class Clock extends Context.Service<Clock, number>()("types-spec/Clock") {}

  const Read = Action.make("read", {
    description: "Read",
    access: "read",
    success: Schema.String,
  });

  const read = () => Effect.succeed("ok");

  const binding = ActionHttp.make([Read]);

  // The hook may fail with either refusal, which every endpoint declares.
  Action.implement(Read, read, () => Effect.fail(new Action.Forbidden()));
  Action.implement(Read, read, () => Effect.fail(new Action.Unauthenticated()));

  // @ts-expect-error A hook may not fail with anything but a refusal, even a 403 of its own.
  Action.implement(Read, read, () => Effect.fail(new Denied()));
  // @ts-expect-error Bad input is answered before the hook runs, not by it.
  Action.implement(Read, read, () => Effect.fail(new Action.InvalidInput()));

  // One hook, bound once: every surface runs it, and none takes a hook of its own.
  const guarded = Action.implement(Read, read, (action) =>
    // The hook reads the contract it is about to run: here, exactly `Read`.
    action.access === "read" ? Effect.void : Effect.fail(new Action.Forbidden()),
  );

  ActionHttp.layer(binding, guarded);
  ActionMcp.layerHttp(guarded, { name: "t", version: "0" });
  ActionToolkit.make(guarded);

  // Hook services are request-time requirements, exactly like a handler's.
  const clocked = Action.implement(Read, read, () => Effect.asVoid(Clock));

  const timed = HttpRouter.toWebHandler(ActionHttp.layer(binding, clocked).pipe(services));

  // @ts-expect-error The hook's services must be supplied per request, not erased.
  void timed.handler(new Request("http://localhost"), Context.empty());
  void timed.handler(new Request("http://localhost"), Context.make(Clock, 0));

  // The hook's services join what the stdio host owes, since nothing else supplies them.
  const stdio = ActionMcp.runStdio(clocked, { name: "t", version: "0" });
  stdio satisfies Effect.Effect<void, unknown, Stdio.Stdio | Clock>;
};

export const authenticationTypes = () => {
  // Without authentication around it, a surface owes the identity per request.
  const bare = HttpRouter.toWebHandler(
    ActionHttp.layer(Http, userActions).pipe(Layer.provide(Users.layerMemory), services),
  );

  // @ts-expect-error The identity must be supplied per request, not erased.
  void bare.handler(new Request("http://localhost"), Context.empty());

  // Authentication provided around the surfaces provides it.
  const http = HttpRouter.toWebHandler(
    ActionHttp.layer(Http, userActions).pipe(
      Layer.provide(authenticate),
      Layer.provide(Users.layerMemory),
      services,
    ),
  );

  void http.handler(new Request("http://localhost"), Context.empty());

  const mcp = HttpRouter.toWebHandler(
    ActionMcp.layerHttp(userActions, { name: "t", version: "0" }).pipe(
      Layer.provide(authenticate),
      Layer.provide(Users.layerMemory),
      services,
    ),
  );

  void mcp.handler(new Request("http://localhost/mcp"), Context.empty());

  // A local surface leaves the identity to its host.
  const stdio = ActionMcp.runStdio(userActions, { name: "t", version: "0" });
  const owed: Equal<Effect.Services<typeof stdio>, Users | Stdio.Stdio | CurrentActor> = true;
  void owed;

  const tools = ActionToolkit.make(userActions).toolkit.tools;
  const toolOwed: Equal<Tool.HandlerServices<typeof tools.getUser>, CurrentActor> = true;
  void toolOwed;
};

export const voidSuccessTypes = () => {
  const Reset = Action.make("reset", { description: "Reset", access: "write" });

  const Explicit = Action.make("explicit", {
    description: "Explicit",
    access: "write",
    success: Schema.Void,
  });

  // An omitted success is `Schema.Void`, so the handler returns nothing.
  const success: Equal<(typeof Reset)["success"], typeof Schema.Void> = true;

  Action.implement(Reset, () => Effect.void);
  Action.implement(Reset, () => Effect.succeed(undefined));
  Action.implement([Reset], { reset: () => Effect.void });
  Action.implement(
    Reset,
    Effect.succeed(() => Effect.void),
  );

  // As for a function returning `void`, a void action's handler may return a value, which
  // its encoding drops.
  Action.implement(Reset, () => Effect.succeed("done"));
  Action.implement(Explicit, () => Effect.succeed(1));

  void success;
};

export const servedRequirementTypes = () => {
  class Principal extends Context.Service<Principal, string>()("types-spec/Principal") {}

  const principal = () => Effect.map(Principal, (name) => name);

  const hintsApp = Action.implement(
    Action.make("act", {
      description: "A tool",
      access: "read",
      success: Schema.String,
      hints: { idempotent: true },
    }),
    principal,
  );

  Action.make("typo", {
    description: "Typo",
    access: "read",
    success: Schema.String,
    // @ts-expect-error A misspelled option is an unknown property, not silently ignored.
    hint: { idempotent: true },
  });

  // Every hint is resolved on the contract.
  const resolved: Equal<
    (typeof hintsApp)["actions"][number]["hints"],
    { readonly destructive: boolean; readonly idempotent: boolean; readonly openWorld: boolean }
  > = true;

  void resolved;

  // A tool is named after its action, and owes its handler's services.
  const tools = ActionToolkit.make(hintsApp).toolkit.tools;

  const toolAssertions: [
    Equal<keyof typeof tools, "act">,
    Equal<Tool.HandlerServices<(typeof tools)["act"]>, Principal>,
    // Every tool declares the built-in errors.
    Equal<Tool.Failure<(typeof tools)["act"]>, Action.BuiltIn>,
  ] = [true, true, true];

  void toolAssertions;
};

export const mcpClientTypes = Effect.gen(function* () {
  // A tool call is typed by its action, as a client method is.
  const mcp = yield* Testing.mcpClient([Double, WhoAmI, GetUser]);
  const call = mcp.double({ value: 2 });

  const doubled: Equal<
    typeof call,
    Effect.Effect<
      number,
      Action.BuiltIn | Schema.SchemaError | HttpClientError.HttpClientError | Testing.McpCallError
    >
  > = true;

  void doubled;

  const needs: Equal<
    Effect.Services<ReturnType<typeof Testing.mcpClient>>,
    HttpClient.HttpClient
  > = true;

  void needs;

  // @ts-expect-error The input is the action's decoded input.
  void mcp.double({ value: "2" });
  // @ts-expect-error An action with input takes it.
  void mcp.double();
  // An action without input may leave it out.
  void mcp.whoAmI();
  // @ts-expect-error As for a client's method, a given input is sent as given.
  void mcp.whoAmI(undefined);
  // Metadata merges under the protocol keys, such as a progress token.
  void Testing.mcpRequest("tools/list", { _meta: { progressToken: "p" } });

  // Its declared errors and the refusals are typed failures.
  yield* mcp.getUser({ id: "1" }).pipe(
    Effect.catchTag("UserNotFound", () => Effect.succeed(undefined)),
    Effect.catchTag("Forbidden", () => Effect.succeed(undefined)),
    Effect.catchTag("Unauthenticated", () => Effect.succeed(undefined)),
  );
});

export const maybeAbsentOptionTypes = (enabled: boolean) => {
  // Omitted or undefined, an option takes its default at run time, so one that may be either
  // is typed as the option or its default, however it is written.
  const Conditional = Action.make("conditional", {
    description: "Returns data only sometimes",
    access: "read",
    success: enabled ? Schema.String : undefined,
  });

  const Spread = Action.make("spread", {
    description: "Returns data only sometimes",
    access: "read",
    ...(enabled ? { success: Schema.String } : {}),
  });

  const conditional: Equal<(typeof Conditional)["success"]["Type"], string | void> = true;
  const spread: Equal<(typeof Spread)["success"]["Type"], string | void> = true;

  void conditional;
  void spread;

  class Identity extends Context.Service<Identity, string>()("types-spec/Identity") {}

  const Who = Action.make("who", { description: "Who", access: "read", success: Schema.String });
  const who = () => Effect.succeed("anyone");
  const hook = () => Effect.asVoid(Identity);

  // A hook that may be undefined is accepted: its services are owed either way.
  const maybe = Action.implement(Who, who, enabled ? hook : undefined);

  type Owed<L> =
    L extends Layer.Layer<infer _A, infer _E, infer R>
      ? Extract<R, HttpRouter.Request.From<"Requires", any>>
      : never;

  const Http = ActionHttp.make([Who]);

  const owed: Equal<
    Owed<ReturnType<typeof ActionHttp.layer<typeof Http, typeof maybe>>>,
    HttpRouter.Request.From<"Requires", Identity>
  > = true;

  void owed;
};

export const widenedOptionTypes = () => {
  // Widened to the options type, every schema may have been left out: the action's types
  // are then as wide as what may run, rather than the defaults.
  const options: Parameters<typeof Action.make>[1] = {
    description: "Returns data",
    access: "read",
    success: Schema.String,
  };

  const Widened = Action.make("widened", options);

  const widened: [
    Equal<(typeof Widened)["success"]["Type"], unknown>,
    Equal<(typeof Widened)["input"]["Type"], unknown>,
    Equal<(typeof Widened)["errors"], ReadonlyArray<Schema.Codec<unknown, unknown>> | []>,
  ] = [true, true, true];

  void widened;
};

export const unionOptionTypes = (
  options:
    | { readonly description: string; readonly access: "read" }
    | {
        readonly description: string;
        readonly access: "read";
        readonly input: { readonly id: typeof Schema.String };
        readonly success: typeof Schema.String;
        readonly errors: [typeof Schema.Number];
      },
) => {
  // A union of options, each member complete, gives each member's schemas.
  const Either = Action.make("either", options);

  const union: [
    Equal<(typeof Either)["success"]["Type"], string | void>,
    Equal<
      (typeof Either)["input"]["Type"],
      { readonly id: string } | { readonly [x: string]: never }
    >,
    Equal<(typeof Either)["errors"], [] | [typeof Schema.Number]>,
  ] = [true, true, true];

  // A handler may return what either member's success accepts.
  void Action.implement(Either, () => Effect.succeed("x"));

  void union;
};

export const exportedTypes = (binding: ActionHttp.Any, app: Action.AnyImplementation) => {
  // Every option a module's functions take is its own named type.
  const options = {
    description: "Options built ahead of `make`",
    access: "read",
  } satisfies Action.Options;

  const hook: Action.Before<typeof Double> = (action) =>
    action.access === "read" ? Effect.void : Effect.fail(new Action.Forbidden());

  const clientOptions: ActionHttp.ClientOptions = { baseUrl: "http://localhost" };
  const httpOptions: ActionMcp.LayerHttpOptions = { name: "test", version: "0" };
  const serverOptions: ActionMcp.Options = { name: "test", version: "0" };
  const shared: ActionMcp.LayerHttpOptions = serverOptions;
  const call: Testing.McpClientOptions = { url: "/mcp" };
  const request: Testing.McpRequestOptions = { url: "/mcp", headers: {} };

  const auth: Authentication.Options = {
    resource: "https://api.example.com/mcp",
    authorizationServers: ["https://auth.example.com"],
  };

  // An action given `{}` has no input, as one without `input`.
  const given = Action.make("given", { ...options, input: {} });
  const noInput: Equal<(typeof given)["input"], (typeof WhoAmI)["input"]> = true;
  // An empty struct given is kept as it is, like any schema.
  const struct = Action.make("struct", { ...options, input: Schema.Struct({}) });
  const noStruct: Equal<(typeof struct)["input"], Schema.Struct<{}>> = true;

  void [
    binding,
    app,
    hook,
    clientOptions,
    httpOptions,
    call,
    request,
    auth,
    noInput,
    noStruct,
    shared,
  ];
};
