import * as Action from "@gjermundgaraba/effect-actions/Action";
import * as ActionCli from "@gjermundgaraba/effect-actions/ActionCli";
import * as ActionHttp from "@gjermundgaraba/effect-actions/ActionHttp";
import * as ActionMcp from "@gjermundgaraba/effect-actions/ActionMcp";
import * as ActionRpc from "@gjermundgaraba/effect-actions/ActionRpc";
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

export const LookupRpc = ActionRpc.make([Lookup], { authentication: Login });

export const lookupRpc = ActionRpc.layer(LookupRpc, lookup);

export const rpcClient = ActionRpc.client(LookupRpc);

export const lookupTools = ActionToolkit.make(lookup);

export const lookupCommand = ActionCli.command(lookup, Lookup);

export const lookupClient = Action.client(lookup);

export const remoteLookup = ActionHttp.fetchClient(LookupHttp).lookup;

export const lookUp = (id: string) => ActionHttp.fetchClient(LookupHttp).lookup({ id });

export const remoteCommand = ActionCli.remoteCommand(LookupHttp, Lookup);

export const remoteCli = ActionCli.remote(LookupHttp, { name: "lookup" });

export const localCli = ActionCli.make(lookup, { name: "lookup" });

export const lookupLayer: Layer.Layer<
  never,
  Action.BuildError<typeof lookup>,
  Action.BuildServices<typeof lookup>
> = Action.layer(lookup);

export const testing = Testing.layer(lookupHttp);

export const mcpLookup = Testing.mcpClient([Lookup]);

export const protectedRoute = Authentication.protect(Login);

export const exportRoute = HttpRouter.add(
  "GET",
  "/export",
  Effect.map(Effect.service(Principal), (principal) => HttpServerResponse.text(principal)),
).pipe(Layer.provide(protectedRoute.layer));

export const localClient = <
  const Apps extends Action.AnyImplementation | ReadonlyArray<Action.AnyImplementation>,
>(
  apps: Apps,
): ReturnType<typeof Action.client<Apps>> => Action.client(apps);

export const guard = <const Name extends string, E extends Action.Errors>(
  authentication: Authentication.Descriptor<
    Principal,
    string,
    Authentication.Any["security"],
    Name,
    E
  >,
): Authentication.Protection<Principal, Name> => Authentication.protect(authentication);

export const checkedGuard = guard(Checked);

export const isRefusal = Schema.is(Action.Refusal);

export const isBuiltIn = Schema.is(Action.BuiltIn);

export const pathsOf = (error: Schema.SchemaError): ReadonlyArray<Action.Issue["path"]> =>
  Action.InvalidInput.fromSchemaError(error).issues.map(({ path }) => path);
