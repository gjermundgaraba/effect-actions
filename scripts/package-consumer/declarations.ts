// A package that emits declarations exports what it builds, each nameable from the
// published modules: a descriptor, the binding naming it, its provider, a check, an
// implementation, the layers serving it on every surface, and a client's methods.
import * as Action from "@gjermundgaraba/effect-actions/Action";
import * as ActionCli from "@gjermundgaraba/effect-actions/ActionCli";
import * as ActionHttp from "@gjermundgaraba/effect-actions/ActionHttp";
import * as ActionMcp from "@gjermundgaraba/effect-actions/ActionMcp";
import * as ActionToolkit from "@gjermundgaraba/effect-actions/ActionToolkit";
import * as Testing from "@gjermundgaraba/effect-actions/Testing";
import * as Authentication from "@gjermundgaraba/effect-actions/Authentication";
import { Context, Effect, Layer, Redacted, Schema } from "effect";
import { HttpRouter, HttpServerResponse } from "effect/http";

export class Principal extends Context.Service<Principal, string>()("declarations/Principal") {}

export const Login = Authentication.make("declarations.Login", Principal);

export const Whoami = Action.make("whoami", {
  description: "The signed-in principal",
  access: "read",
  auth: Principal,
  success: Schema.String,
});

export const Http = ActionHttp.make([Whoami], { authentication: Login });

export const provider = Authentication.layer(Login, (token: Redacted.Redacted<string>) =>
  Effect.succeed(Redacted.value(token)),
);

export const app = Action.implement(Whoami, () => Effect.service(Principal), {
  authorize: Action.allowAll,
});

export const layer = Layer.mergeAll(
  ActionHttp.layer(Http, app),
  ActionMcp.layerHttp(app, { name: "declarations", version: "1.0.0", authentication: Login }),
).pipe(Layer.provide(provider));

export class Store extends Context.Service<Store, (id: string) => string>()("declarations/Store") {}

export class Clock extends Context.Service<Clock, () => number>()("declarations/Clock") {}

export class Limited extends Schema.TaggedError<Limited>()("Limited", {}) {}

// A check reading a request service.
export class Limit extends Action.Check<Limit>()("declarations/Limit", {
  error: Limited,
  requires: Principal,
}) {}

export const Lookup = Action.make("lookup", {
  description: "Look a record up",
  access: "read",
  auth: Principal,
  input: { id: Schema.String },
  success: Schema.String,
  checks: [Limit],
});

export const LookupHttp = ActionHttp.make([Lookup], { authentication: Login });

export const limit = Layer.succeed(Limit, () => Effect.void);

// A builder yielding two startup services, beside a check's: what each surface owes at startup.
export const lookup = Action.implement(
  Lookup,
  Effect.gen(function* () {
    const store = yield* Store;
    const clock = yield* Clock;

    return ({ id }) => Effect.succeed(`${store(id)}@${clock()}`);
  }),
  { authorize: Action.allowAll },
);

export const lookupHttp = ActionHttp.layer(LookupHttp, lookup);

export const lookupMcp = ActionMcp.layerHttp(lookup, {
  name: "lookup",
  version: "1.0.0",
  authentication: Login,
});

export const lookupStdio = ActionMcp.runStdio(lookup, { name: "lookup", version: "1.0.0" });

export const lookupTools = ActionToolkit.make(lookup);

export const lookupCommand = ActionCli.command(lookup, Lookup);

export const lookupClient = Action.client(lookup);

// A remote client's method, and a call's result.
export const remoteLookup = ActionHttp.fetchClient(LookupHttp).lookup;

export const lookUp = (id: string) => ActionHttp.fetchClient(LookupHttp).lookup({ id });

// A remote command, aggregates and a test client over the same contracts.
export const remoteCommand = ActionCli.command(LookupHttp, Lookup);

export const remoteCli = ActionCli.make(LookupHttp, { name: "lookup" });

export const localCli = ActionCli.make(lookup, { name: "lookup" });

export const lookupLayer = Action.layer(lookup);

export const testing = Testing.layer(lookupHttp);

export const mcpLookup = Testing.mcpClient([Lookup]);

// A route of the host's own under the descriptor's provider, and the middleware itself.
export const protectedRoute = Authentication.protect(Login);

export const exportRoute = HttpRouter.add(
  "GET",
  "/export",
  Effect.map(Effect.service(Principal), (principal) => HttpServerResponse.text(principal)),
).pipe(Layer.provide(protectedRoute.layer));

// A generic helper states its return type as the surface's own, which TypeScript can name.
export const localClient = <
  const Apps extends Action.AnyImplementation | ReadonlyArray<Action.AnyImplementation>,
>(
  apps: Apps,
): ReturnType<typeof Action.client<Apps>> => Action.client(apps);
