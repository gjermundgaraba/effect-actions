// A package that emits declarations exports what it builds, each nameable from the
// published modules: a descriptor, the binding naming it, its provider, an implementation,
// the layers serving it on every surface, and a client's methods.
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
  readOnly: true,
  caller: Principal,
  success: Schema.String,
});

export const Http = ActionHttp.make([Whoami], { authentication: Login });

export const provider = Authentication.layer(Login, (token: Redacted.Redacted<string>) =>
  Effect.succeed(Redacted.value(token)),
);

// A descriptor declaring what its verifier fails with besides a refusal, the binding naming it,
// its provider, and a client method decoding it.
export class Unavailable extends Schema.TaggedError<Unavailable>()(
  "Unavailable",
  {},
  { httpApiStatus: 503 },
) {}

export const Checked = Authentication.make("declarations.Checked", Principal, {
  error: Unavailable,
});

export const CheckedHttp = ActionHttp.make([Whoami], { authentication: Checked });

export const checkedProvider = Authentication.layer(Checked, (token: Redacted.Redacted<string>) =>
  Redacted.value(token) === "down"
    ? Effect.fail(new Unavailable())
    : Effect.succeed(Redacted.value(token)),
);

export const checkedWhoami = ActionHttp.fetchClient(CheckedHttp).whoami;

export const app = Action.implement(Whoami, () => Effect.service(Principal), {
  authorize: Action.allowAll,
});

// An implementation built from a service a generic names, stated in the package's own interface
// with its parameters written out: the actions, each one's per-request services by name, then
// what its builder fails with and reads.
export interface Tenant<Name extends string> {
  readonly name: Name;
}

const tenantOf = <Name extends string>(name: Name) =>
  Context.Service<Tenant<Name>, string>(`declarations/Tenant/${name}`);

export interface Session<Name extends string> {
  readonly session: Action.Implementation<
    typeof Whoami,
    { readonly whoami: Principal },
    never,
    Tenant<Name>
  >;
}

export const sessionOf = <const Name extends string>(name: Name): Session<Name> => ({
  session: Action.implement(
    Whoami,
    Effect.map(
      Effect.service(tenantOf(name)),
      (tenant) => () =>
        Effect.map(Effect.service(Principal), (principal) => `${principal}@${tenant}`),
    ),
    { authorize: Action.allowAll },
  ),
});

export const layer = Layer.mergeAll(
  ActionHttp.layer(Http, app),
  ActionMcp.layerHttp(app, { name: "declarations", version: "1.0.0", authentication: Login }),
).pipe(Layer.provide(provider));

export class Store extends Context.Service<Store, (id: string) => string>()("declarations/Store") {}

export class Clock extends Context.Service<Clock, () => number>()("declarations/Clock") {}

export class Limited extends Schema.TaggedError<Limited>()("Limited", {}) {}

export const Lookup = Action.make("lookup", {
  description: "Look a record up",
  readOnly: true,
  caller: Principal,
  input: { id: Schema.String },
  success: Schema.String,
  error: [Limited],
});

export const LookupHttp = ActionHttp.make([Lookup], { authentication: Login });

// A builder yielding two startup services: what each surface owes at startup.
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
export const remoteCommand = ActionCli.remoteCommand(LookupHttp, Lookup);

export const remoteCli = ActionCli.remote(LookupHttp, { name: "lookup" });

export const localCli = ActionCli.make(lookup, { name: "lookup" });

// What its builders read and fail with at startup, named from `Action`.
export const lookupLayer: Layer.Layer<
  never,
  Action.BuildError<typeof lookup>,
  Action.BuildServices<typeof lookup>
> = Action.layer(lookup);

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
