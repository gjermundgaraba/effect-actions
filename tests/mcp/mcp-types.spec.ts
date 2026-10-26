import { Cause, Context, Effect, Layer, Schema, type Stdio, Stream, type Types } from "effect";
import { type McpSchema, McpServer } from "effect/ai";
import { HttpClient, type HttpClientError, HttpClientRequest, type HttpRouter } from "effect/http";
import { expectTypeOf } from "@effect/vitest";
import * as Action from "../../src/contract/Action.js";
import * as Event from "../../src/contract/Event.js";
import * as ActionMcp from "../../src/mcp/ActionMcp.js";
import * as Authentication from "../../src/authentication/Authentication.js";
import { authorizing, Credentials, SignInRequired } from "../support/credentials.js";

const options = { name: "t", version: "0" };

const read = { description: "", readOnly: true, caller: Action.Anyone } as const;

const done = () => Effect.void;

type RequiredAndDefined<T> = { readonly [K in keyof T]-?: Exclude<T[K], undefined> };

expectTypeOf<RequiredAndDefined<Omit<Action.Mcp, "_meta">>>().toEqualTypeOf<
  RequiredAndDefined<Omit<typeof McpSchema.ToolAnnotations.Encoded, "readOnlyHint">>
>();

expectTypeOf<RequiredAndDefined<Pick<Action.Mcp, "_meta">>>().toExtend<
  RequiredAndDefined<Pick<typeof McpSchema.Tool.Encoded, "_meta">>
>();

const status = Action.implement(Action.make("status", read), done);

type PublicAction = Action.Action<
  string,
  Action.Any["input"],
  Action.Any["success"],
  Action.Any["error"],
  boolean,
  typeof Action.Anyone
>;

declare const erased: ReadonlyArray<Action.AnyImplementation>;

declare const erasedPublicActions: ReadonlyArray<Action.AnyImplementation<PublicAction>>;

// @ts-expect-error -- An endpoint of any actions states how their callers authenticate.
ActionMcp.layerHttp(erased, options);

ActionMcp.layerHttp(erasedPublicActions, options);

ActionMcp.runStdio(erased, options);

export const genericHelperBesideAnother = <App extends Action.AnyImplementation>(app: App) =>
  ActionMcp.runStdio([app, status], options);

class Docs extends Context.Service<Docs, string>()("mcp-types/Docs") {}

class Missing extends Schema.TaggedError<Missing>()("Missing", {}) {}

const readme = McpServer.resource({
  uri: "docs://readme",
  name: "README",
  content: Effect.service(Docs),
});

const features = Layer.merge(readme, Layer.effectDiscard(Effect.fail(new Missing())));

expectTypeOf(ActionMcp.layerHttp(status, { ...options, features })).toEqualTypeOf<
  Layer.Layer<never, Cause.IllegalArgumentError | Missing, HttpRouter.HttpRouter | Docs>
>();

expectTypeOf(
  ActionMcp.layerHttp(status, { ...options, features, requestScoped: true }),
).toEqualTypeOf<
  Layer.Layer<never, Cause.IllegalArgumentError | Missing, HttpRouter.HttpRouter | Docs>
>();

expectTypeOf(ActionMcp.runStdio(status, { ...options, features })).toEqualTypeOf<
  Effect.Effect<void, Cause.IllegalArgumentError | Missing, Stdio.Stdio | Docs>
>();

const registeringThroughRegistry = Layer.effectDiscard(
  McpServer.registerResource({ uri: "docs://notes", name: "Notes", content: Effect.service(Docs) }),
);

expectTypeOf(
  ActionMcp.layerHttp(status, { ...options, features: registeringThroughRegistry }),
).toEqualTypeOf<Layer.Layer<never, Cause.IllegalArgumentError, HttpRouter.HttpRouter | Docs>>();

expectTypeOf(
  ActionMcp.runStdio(status, { ...options, features: registeringThroughRegistry }),
).toEqualTypeOf<Effect.Effect<void, Cause.IllegalArgumentError, Stdio.Stdio | Docs>>();

const listed = Action.implement([Action.make("first", read), Action.make("second", read)], {
  first: done,
  second: done,
});

export const clientWithOneMethodPerTool = Effect.map(ActionMcp.client(listed.actions), (mcp) => {
  expectTypeOf<keyof typeof mcp>().toEqualTypeOf<"first" | "second">();
});

const yieldingRegistry = Action.implement(Action.make("progress", read), () =>
  Effect.flatMap(McpServer.McpServer, (server) =>
    server.notifications["notifications/progress"]({ progressToken: "p", progress: 1 }),
  ),
);

expectTypeOf(ActionMcp.layerHttp(yieldingRegistry, options)).toEqualTypeOf<
  Layer.Layer<never, Cause.IllegalArgumentError, HttpRouter.HttpRouter>
>();

expectTypeOf(ActionMcp.runStdio(yieldingRegistry, options)).toEqualTypeOf<
  Effect.Effect<void, Cause.IllegalArgumentError, Stdio.Stdio>
>();

class Caller extends Context.Service<Caller, string>()("mcp-types/Caller") {}

class Store extends Context.Service<Store, string>()("mcp-types/Store") {}

class Region extends Context.Service<Region, string>()("mcp-types/Region") {}

const Login = Authentication.make("mcp-types.Login", Caller);

const Open = Action.make("open", read);

const Private = Action.make("private", { ...read, caller: Caller });

const mixed = Action.implement(
  [Open, Private],
  { open: done, private: () => Effect.asVoid(Caller) },
  { authorize: () => Effect.asVoid(Region) },
);

const stored = Action.implement(Action.make("stored", read), Effect.as(Store, done));

expectTypeOf(ActionMcp.layerHttp([mixed, stored], { ...options, actions: [Open] })).toEqualTypeOf<
  Layer.Layer<never, Cause.IllegalArgumentError, HttpRouter.HttpRouter>
>();

expectTypeOf(ActionMcp.runStdio([mixed, stored], { ...options, actions: [Private] })).toEqualTypeOf<
  Effect.Effect<void, Cause.IllegalArgumentError, Stdio.Stdio | Caller | Region>
>();

const verify = Authentication.layer(Login, () => Effect.succeed("c"));

const remote = ActionMcp.layerHttp([mixed, stored], {
  ...options,
  actions: [Private],
  authentication: Login,
});

expectTypeOf<Layer.Services<typeof remote>>().toEqualTypeOf<
  HttpRouter.HttpRouter | HttpRouter.Request<"Requires", Region> | Layer.Success<typeof verify>
>();

// @ts-expect-error -- An action none of the implementations holds.
ActionMcp.layerHttp(mixed, { ...options, actions: [Action.make("closed", read)] });

const erasedMixed: Action.AnyImplementation = mixed;

expectTypeOf<
  Layer.Services<
    ReturnType<
      typeof ActionMcp.layerHttp<
        typeof erasedMixed,
        { readonly actions: readonly [typeof Open] },
        never,
        never,
        undefined
      >
    >
  >
>().toBeUnknown();

expectTypeOf<Types.ReasonTags<ActionMcp.McpCallError>>().toEqualTypeOf<
  | "StatusError"
  | "ProtocolError"
  | "NoReply"
  | "UndeclaredError"
  | "NoStructuredContent"
  | "FrameTooLarge"
>();

type CallFailure =
  | Action.BuiltIn
  | Schema.SchemaError
  | HttpClientError.HttpClientError
  | ActionMcp.McpCallError;

export const transformErrorsAndServices = Effect.gen(function* () {
  const built = ActionMcp.client([Open, Private], {
    authentication: Login,
    transformClient: authorizing,
  });

  expectTypeOf<Effect.Services<typeof built>>().toEqualTypeOf<HttpClient.HttpClient>();

  const mcp = yield* built;
  const call = mcp.private();

  expectTypeOf<Effect.Error<typeof call>>().toEqualTypeOf<CallFailure | SignInRequired>();
  expectTypeOf<Effect.Services<typeof call>>().toEqualTypeOf<Credentials>();

  const bearer = { transformClient: HttpClient.mapRequest(HttpClientRequest.bearerToken("t0k")) };
  const plain = (yield* ActionMcp.client([Open], bearer)).open();

  expectTypeOf<Effect.Error<typeof plain>>().toEqualTypeOf<CallFailure>();
  expectTypeOf<Effect.Services<typeof plain>>().toEqualTypeOf<never>();

  // @ts-expect-error -- A call requires what the transform requires.
  const unprovided: Effect.Effect<void, unknown> = call;
  void unprovided;
});

const Watched = Event.make("account.watched", {
  description: "",
  payload: { by: Schema.String },
  caller: Caller,
});

const watched = Event.implement(
  Watched,
  Effect.as(Store, {
    check: () => Effect.as(Region, { cursor: "0", events: [] }),
  }),
  { authorize: Event.allowAll },
);

const PrincipalLogin = Authentication.make("mcp-types.PrincipalLogin", Caller, {
  principal: (caller) => caller,
});

const verifyPrincipal = Authentication.layer(PrincipalLogin, () => Effect.succeed("c"));

const served = ActionMcp.layerHttp([mixed, watched], {
  ...options,
  authentication: PrincipalLogin,
});

expectTypeOf<Layer.Services<typeof served>>().toEqualTypeOf<
  | HttpRouter.HttpRouter
  | Store
  | HttpRouter.Request<"Requires", Region>
  | Layer.Success<typeof verifyPrincipal>
  | Event.Events
>();

expectTypeOf(ActionMcp.runStdio(watched, options)).toEqualTypeOf<
  Effect.Effect<
    void,
    Cause.IllegalArgumentError,
    Stdio.Stdio | Store | Caller | Region | Event.Events
  >
>();

// @ts-expect-error -- A protected event is served only with authentication.
ActionMcp.layerHttp(watched, options);

export const watchOverMcp = Effect.gen(function* () {
  const mcp = yield* ActionMcp.client([Open, Watched], { authentication: Login });
  const watching = mcp.watch(Watched);

  expectTypeOf<Stream.Success<typeof watching>>().toEqualTypeOf<Event.Received<typeof Watched>>();
  expectTypeOf<Stream.Error<typeof watching>>().toEqualTypeOf<
    | Event.SubscriptionError
    | Action.BuiltIn
    | Schema.SchemaError
    | HttpClientError.HttpClientError
    | ActionMcp.McpCallError
  >();
  expectTypeOf<Stream.Services<typeof watching>>().toBeNever();

  // @ts-expect-error -- A client listing no event type has no `watch`.
  void (yield* ActionMcp.client([Open])).watch;
});

const Tail = Action.make("tail", { ...read, success: Action.Stream(Schema.String) });

export const streamedFromCollected = Effect.gen(function* () {
  const tailed = (yield* ActionMcp.client([Tail])).tail();

  expectTypeOf<Stream.Success<typeof tailed>>().toEqualTypeOf<string>();
  expectTypeOf<Stream.Error<typeof tailed>>().toEqualTypeOf<CallFailure>();
});
