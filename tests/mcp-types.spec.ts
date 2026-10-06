// Compile-only assertions, included by `vp check`, on the servers and clients of MCP and the
// `text` hint they read. Input is checked when a server is made (registration.test.ts), so the
// types take any implementations, a helper's own included.
import { Cause, Context, Effect, Layer, Schema, type Stdio } from "effect";
import { McpServer } from "effect/ai";
import type { HttpRouter } from "effect/http";
import { expectTypeOf } from "@effect/vitest";
import * as Action from "../src/Action.js";
import * as ActionMcp from "../src/ActionMcp.js";
import * as Authentication from "../src/Authentication.js";
import * as Testing from "../src/Testing.js";

const options = { name: "t", version: "0" };

const read = { description: "", access: "read", auth: "public" } as const;

const done = () => Effect.void;

const status = Action.implement(Action.make("status", read), done);

/** An action anyone may call, as a helper types the actions it serves. */
type Public = Action.Action<
  string,
  Action.Any["input"],
  Action.Any["success"],
  Action.Any["errors"],
  Action.Access,
  "public"
>;

declare const erased: ReadonlyArray<Action.AnyImplementation>;

declare const erasedPublic: ReadonlyArray<Action.AnyImplementation<Public>>;

// An erased list may hold protected actions, whose endpoint names their authentication; one
// typed as public actions needs none.
// @ts-expect-error An endpoint of any actions states how their callers authenticate.
ActionMcp.layerHttp(erased, options);

ActionMcp.layerHttp(erasedPublic, options);

ActionMcp.runStdio(erased, options);

// A helper generic over implementations compiles, its type parameter listed beside another
// implementation.
export const runListed = <App extends Action.AnyImplementation>(app: App) =>
  ActionMcp.runStdio([app, status], options);

// What native features need and fail with is the server's to provide and fail with.
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

expectTypeOf(ActionMcp.runStdio(status, { ...options, features })).toEqualTypeOf<
  Effect.Effect<void, Cause.IllegalArgumentError | Missing, Stdio.Stdio | Docs>
>();

// A feature registering through the registry, which the endpoint provides it, owes no host
// the registry.
const registered = Layer.effectDiscard(
  McpServer.registerResource({ uri: "docs://notes", name: "Notes", content: Effect.service(Docs) }),
);

expectTypeOf(ActionMcp.layerHttp(status, { ...options, features: registered })).toEqualTypeOf<
  Layer.Layer<never, Cause.IllegalArgumentError, HttpRouter.HttpRouter | Docs>
>();

expectTypeOf(ActionMcp.runStdio(status, { ...options, features: registered })).toEqualTypeOf<
  Effect.Effect<void, Cause.IllegalArgumentError, Stdio.Stdio | Docs>
>();

// A `text` hint names a top-level string field of the action's encoded success, an optional
// one too.
const success = {
  markdown: Schema.String,
  words: Schema.Finite,
  note: Schema.optionalKey(Schema.String),
};

Action.make("page", { ...read, success, hints: { text: "markdown" } });

Action.make("note", { ...read, success, hints: { text: "note", idempotent: true } });

// @ts-expect-error `words` is a number.
Action.make("words", { ...read, success, hints: { text: "words" } });

// @ts-expect-error The success has no such field.
Action.make("missing", { ...read, success, hints: { text: "missing" } });

Action.make("either", {
  ...read,
  // Each member has `body`, but the union's JSON Schema has no top-level property.
  success: Schema.Union([
    Schema.Struct({ body: Schema.String, kind: Schema.Literal("a") }),
    Schema.Struct({ body: Schema.String, kind: Schema.Literal("b") }),
  ]),
  // @ts-expect-error A union of structs has no field of its own.
  hints: { text: "body" },
});

// @ts-expect-error A string success has no fields.
Action.make("scalar", { ...read, success: Schema.String, hints: { text: "length" } });

Action.make("dictionary", {
  ...read,
  success: Schema.Record(Schema.String, Schema.String),
  // @ts-expect-error Nor has a record a field of its own.
  hints: { text: "body" },
});

// @ts-expect-error Nor has an action without a success.
Action.make("none", { ...read, hints: { text: "body" } });

// A struct with rest: its declared field is a top-level property, its record's keys are not.
const rest = Schema.StructWithRest(Schema.Struct({ markdown: Schema.String }), [
  Schema.Record(Schema.String, Schema.String),
]);

Action.make("rest", { ...read, success: rest, hints: { text: "markdown" } });

// @ts-expect-error A key only the rest allows is no declared field.
Action.make("restExtra", { ...read, success: rest, hints: { text: "extra" } });

// The types cannot read an erased success, nor a hint typed only as `string`: the layer build
// checks them.
declare const field: string;

declare const unread: Schema.Codec<unknown>;

Action.make("erased", { ...read, success: unread, hints: { text: field } });

// An implementation's `actions` are its exact contracts: a client of them has one method per
// tool the implementation serves, and no other.
const listed = Action.implement([Action.make("first", read), Action.make("second", read)], {
  first: done,
  second: done,
});

export const listedClient = Effect.map(Testing.mcpClient(listed.actions), (mcp) => {
  expectTypeOf<keyof typeof mcp>().toEqualTypeOf<"first" | "second">();
});

// A handler may yield its endpoint's registry, to send progress, and no host owes it.
const progress = Action.implement(Action.make("progress", read), () =>
  Effect.flatMap(McpServer.McpServer, (server) =>
    server.notifications["notifications/progress"]({ progressToken: "p", progress: 1 }),
  ),
);

expectTypeOf(ActionMcp.layerHttp(progress, options)).toEqualTypeOf<
  Layer.Layer<never, Cause.IllegalArgumentError, HttpRouter.HttpRouter>
>();

expectTypeOf(ActionMcp.runStdio(progress, options)).toEqualTypeOf<
  Effect.Effect<void, Cause.IllegalArgumentError, Stdio.Stdio>
>();

// Listed actions are the tools: an endpoint owes per request what their handlers and
// authorization need, and at startup what the builders of the implementations holding them
// need. Over stdio the host also owes a protected tool's caller; over HTTP its descriptor's
// verifier provides it.
class Caller extends Context.Service<Caller, string>()("mcp-types/Caller") {}

class Store extends Context.Service<Store, string>()("mcp-types/Store") {}

class Region extends Context.Service<Region, string>()("mcp-types/Region") {}

const Login = Authentication.make("mcp-types.Login", Caller);

const Open = Action.make("open", read);

const Private = Action.make("private", { ...read, auth: Caller });

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

// Over HTTP, the endpoint owes the descriptor's verifier, and per request only what the
// authorizer reads beside the caller.
expectTypeOf<Layer.Services<typeof remote>>().toEqualTypeOf<
  HttpRouter.HttpRouter | HttpRouter.Request<"Requires", Region> | Layer.Success<typeof verify>
>();

// @ts-expect-error An action none of the implementations holds.
ActionMcp.layerHttp(mixed, { ...options, actions: [Action.make("closed", read)] });

// A value typed `Action.AnyImplementation` owes `unknown`, its actions listed or not: its
// erased actions may be any listed one.
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
