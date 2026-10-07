import * as Action from "@gjermundgaraba/effect-actions/Action";
import * as ActionCli from "@gjermundgaraba/effect-actions/ActionCli";
import * as ActionHttp from "@gjermundgaraba/effect-actions/ActionHttp";
import * as ActionToolkit from "@gjermundgaraba/effect-actions/ActionToolkit";
import { type HttpApiClient, OpenApi } from "effect/http-api";
import * as Authentication from "@gjermundgaraba/effect-actions/Authentication";
import * as Testing from "@gjermundgaraba/effect-actions/Testing";
import { Context, Effect, Layer, Redacted, Schema, Stream } from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";
import { Greet, Http } from "./quickstart.js";
import { routes } from "./quickstart-server.js";

// Subpaths are the only entry points: one module each, so nothing loads the MCP
// server by accident.
const packageRoot: string = "@gjermundgaraba/effect-actions";

const rootImport = await import(packageRoot).then(
  () => "resolved",
  () => "absent",
);

if (rootImport !== "absent") throw new Error("The package root must not be an entry point");

const checkTypes = (client: HttpApiClient.ForApi<typeof Http.api>) => {
  // @ts-expect-error Published declarations must reject incorrect input.
  client.greet({ payload: { name: 123 } });

  // @ts-expect-error Published declarations must retain the result type.
  const wrong: Effect.Effect<number, unknown, unknown> = client.greet({
    payload: { name: "Ada" },
  });

  return wrong;
};

void checkTypes;

const served = await Effect.gen(function* () {
  // `Testing.layer` resolves the relative URL, so the client needs no `baseUrl`.
  const client = yield* ActionHttp.client(Http);

  const checkClientTypes = () => {
    // @ts-expect-error Published declarations must type the client's input.
    void client.greet({ name: 123 });

    // @ts-expect-error Published declarations must retain the client's result type.
    const wrong: Effect.Effect<number, unknown> = client.greet({ name: "Ada" });

    return wrong;
  };

  void checkClientTypes;

  const greeting = yield* client.greet({ name: "Ada" });
  const mcp = yield* Testing.mcpClient([Greet]);
  const called = yield* mcp.greet({ name: "Ada" });
  const listed = yield* HttpClient.execute(Testing.mcpRequest("tools/list"));

  const raw = yield* HttpClient.execute(
    Testing.mcpRequest("tools/call", { name: "greet", arguments: { name: "Ada" } }),
  );

  return { greeting, called, listed: listed.status, raw: yield* raw.text };
}).pipe(Effect.provide(Testing.layer(routes)), Effect.runPromise);

if (served.greeting !== "Hello, Ada!") throw new Error(`Unexpected greeting: ${served.greeting}`);

if (served.called !== "Hello, Ada!") throw new Error("MCP tool call failed");

if (served.listed !== 200) throw new Error("MCP request failed");

// A tool sends its encoded success itself as structured content.
if (!served.raw.includes('"structuredContent":"Hello, Ada!"'))
  throw new Error(`Unexpected MCP result: ${served.raw}`);

// A consumer's binding is a native HttpApi: Effect's own generator documents it.
if (!Object.hasOwn(OpenApi.fromApi(Http.api).paths, "/api/greet"))
  throw new Error("The OpenAPI document lacks the greet route");

const greet = Action.implement(Greet, ({ name }) => Effect.succeed(`Hello, ${name}!`));

const binding = ActionToolkit.make(greet);

const checkToolkitTypes = () => {
  // @ts-expect-error Published Toolkit names must remain literal.
  void binding.toolkit.tools.missing;
};

void checkToolkitTypes;

const toolResults = await Effect.gen(function* () {
  const tools = yield* binding.toolkit;

  return yield* tools.handle("greet", { name: "Ada" }).pipe(Effect.flatMap(Stream.runCollect));
}).pipe(Effect.provide(binding.layer), Effect.runPromise);

if (toolResults[0]?.result !== "Hello, Ada!") throw new Error("Native Toolkit projection failed");

class Identity extends Context.Service<Identity, string>()("consumer/Identity") {}

const Read = Action.make("read", {
  description: "Read",
  readOnly: true,
  caller: Identity,
  success: Schema.String,
});

const Write = Action.make("write", {
  description: "Write",
  readOnly: false,
  caller: Identity,
  success: Schema.String,
});

const checkCliTypes = (failure: ActionCli.UserError<Action.Forbidden>) => {
  // @ts-expect-error Remote commands accept only the binding's own actions.
  ActionCli.remoteCommand(Http, Read);

  // A command fails with Effect CLI's `UserError`, whose cause is the action's failure.
  const refused: Action.Forbidden = failure.cause;

  void refused;
};

void checkCliTypes;

if (!Read.readOnly || Write.readOnly) throw new Error("Published readOnly metadata failed");

const Login = Authentication.make("consumer.Login", Identity);

// A token is its own identity here; a real host verifies it.
const authenticate = Authentication.layer(Login, (token: Redacted.Redacted<string>) =>
  Effect.succeed(Redacted.value(token)),
);

const guarded = Action.implement(
  [Read, Write],
  {
    read: () => Effect.map(Identity, (identity) => identity),
    write: () => Effect.succeed("write"),
  },
  {
    authorize: (action) =>
      action.readOnly ? Effect.void : Effect.fail(new Action.Forbidden({ message: "Read only." })),
  },
);

const GuardedHttp = ActionHttp.make([Read, Write], { authentication: Login });

class Denied extends Schema.TaggedError<Denied>()("Denied", {}) {}

const checkImplementTypes = () => {
  Action.implement(Read, () => Effect.succeed("read"), {
    // @ts-expect-error A published authorizer only refuses.
    authorize: () => Effect.fail(new Denied()),
  });

  // @ts-expect-error A published protected implementation states who may call it.
  Action.implement(Read, () => Effect.succeed("read"));
  Action.implement(
    Greet,
    // @ts-expect-error A published `Effect.fn` handler is typed from its action.
    Effect.fn(function* ({ nam }) {
      return `${String(nam)}${yield* Effect.succeed("!")}`;
    }),
  );
  Action.implement(
    Greet,
    Effect.succeed(
      // @ts-expect-error So is one a published builder returns.
      Effect.fn(function* ({ nam }) {
        return `${String(nam)}${yield* Effect.succeed("!")}`;
      }),
    ),
  );
  Action.implement(
    [Read, Write],
    { read: () => Effect.succeed("read"), write: () => Effect.succeed("write") },
    {
      // A built authorizer's action infers from the implementation's protected actions.
      authorize: Effect.succeed((action) =>
        // @ts-expect-error A misspelled contract field.
        action.acess === "write" ? Effect.fail(new Action.Forbidden()) : Effect.void,
      ),
    },
  );
};

void checkImplementTypes;

// Authentication provided around the layer: it owes no identity.
const guardedRoutes = ActionHttp.layer(GuardedHttp, guarded).pipe(Layer.provide(authenticate));

const refusals = await Effect.gen(function* () {
  const anonymous = yield* ActionHttp.client(GuardedHttp);

  const client = yield* ActionHttp.client(GuardedHttp, {
    transformClient: HttpClient.mapRequest(HttpClientRequest.bearerToken("ada")),
  });

  const checkErrorTypes = () =>
    client.read().pipe(
      Effect.catchTag("Unauthenticated", () => Effect.succeed("")),
      Effect.catchTag("Forbidden", () => Effect.succeed("")),
      Effect.catchTag("InvalidInput", () => Effect.succeed("")),
      // @ts-expect-error Published clients must type their failures precisely.
      Effect.catchTag("Denied", () => Effect.succeed("")),
    );

  void checkErrorTypes;

  return {
    unauthenticated: yield* Effect.flip(anonymous.read()),
    forbidden: yield* Effect.flip(client.write()),
  };
}).pipe(Effect.provide(Testing.layer(guardedRoutes)), Effect.runPromise);

if (!(refusals.unauthenticated instanceof Action.Unauthenticated))
  throw new Error("Published authentication allowed an anonymous read");

if (!(refusals.forbidden instanceof Action.Forbidden))
  throw new Error("Published hook allowed a write");

// In process, the client's methods: each call owes its caller.
const checkLocalTypes = Effect.gen(function* () {
  const actions = yield* Action.client(guarded);

  // @ts-expect-error A published in-process call owes its caller.
  const owed: Effect.Effect<string, Action.BuiltIn> = actions.read();

  return owed;
});

void checkLocalTypes;
