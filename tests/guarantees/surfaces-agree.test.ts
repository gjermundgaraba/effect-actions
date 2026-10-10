import { describe, expect, it } from "@effect/vitest";
import { Arbitrary, Context, Effect, Layer, Redacted, Schema, Stream } from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";
import { RpcClient, RpcSerialization, RpcServer } from "effect/rpc";
import * as Action from "../../src/contract/Action.js";
import * as ActionCli from "../../src/cli/ActionCli.js";
import * as ActionHttp from "../../src/http/ActionHttp.js";
import * as ActionMcp from "../../src/mcp/ActionMcp.js";
import * as ActionRpc from "../../src/rpc/ActionRpc.js";
import * as ActionToolkit from "../../src/toolkit/ActionToolkit.js";
import * as Authentication from "../../src/authentication/Authentication.js";
import * as Testing from "../../src/testing/Testing.js";
import { exec, logged } from "../support/cli-services.js";

const jsonTextOf = <T, E>(schema: Schema.Codec<T, E>) =>
  Schema.fromJsonString(Schema.toCodecJson(schema));

const sentAsJsonText = <T, E>(schema: Schema.Codec<T, E>) => {
  const text = jsonTextOf(schema);
  const encode = Schema.encodeSync(text);
  const decode = Schema.decodeSync(text);

  return (value: T) => decode(encode(value));
};

const modelArgumentsOf = <T, E>(schema: Schema.Codec<T, E>) => {
  const encode = Schema.encodeEffect(jsonTextOf(schema));
  const parse = Schema.decodeEffect(Schema.fromJsonString(Schema.Json));

  return (value: T) => Effect.flatMap(encode(value), parse);
};

const Payload = Schema.Struct({
  text: Schema.String,
  amount: Schema.Finite,
  count: Schema.Int,
  enabled: Schema.Boolean,
  note: Schema.optional(Schema.String),
  level: Schema.Literals(["low", "high"]),
  owner: Schema.Struct({ name: Schema.String, weight: Schema.optionalKey(Schema.Finite) }),
  tags: Schema.Array(Schema.String),
});

class Rejected extends Schema.TaggedError<Rejected>()("Rejected", {
  reason: Schema.String,
  code: Schema.Int,
  retryable: Schema.Boolean,
  detail: Schema.optionalKey(Schema.String),
}) {}

class OverLimit extends Schema.TaggedError<OverLimit>()("OverLimit", {
  limit: Schema.Finite,
  tags: Schema.Array(Schema.String),
}) {}

const Failure = Schema.Union([
  Rejected,
  OverLimit,
  Action.InvalidInput,
  Action.Unauthenticated,
  Action.Forbidden,
]);

const FailureInput = Schema.Struct({ failure: Failure });

const failuresAsTheirJson = Arbitrary.schema(Failure).pipe(
  Arbitrary.map(Schema.encodeSync(Schema.toCodecJson(Failure))),
);

const decodeFailureJson = Schema.decodeEffect(Schema.toCodecJson(Failure));

class Caller extends Context.Service<Caller, string>()("surfaces-agree/Caller") {}

const SignedIn = Authentication.make("surfaces-agree.SignedIn", Caller);

const signIn = Authentication.layer(SignedIn, (token) => Effect.succeed(Redacted.value(token)));

const token = "caller";

const asCaller = Effect.provideService(Caller, token);

const withBearer = { transformClient: HttpClient.mapRequest(HttpClientRequest.bearerToken(token)) };

const Echo = Action.make("echo", {
  description: "Return the input as the success.",
  readOnly: true,
  caller: Action.Anyone,
  input: Payload,
  success: Payload,
});

const Fail = Action.make("fail", {
  description: "Fail with the error the input carries.",
  readOnly: true,
  caller: Caller,
  input: FailureInput,
  success: Schema.Void,
  error: [Rejected, OverLimit],
});

const app = Action.implement(
  [Echo, Fail],
  { echo: Effect.succeed, fail: ({ failure }) => Effect.fail(failure) },
  { authorize: Action.allowAll },
);

const Http = ActionHttp.make([Echo, Fail], { authentication: SignedIn });

const Rpc = ActionRpc.make([Echo, Fail], { authentication: SignedIn });

const routes = Layer.mergeAll(
  ActionHttp.layer(Http, app),
  ActionMcp.layerHttp(app, { name: "surfaces", version: "0", authentication: SignedIn }),
  ActionRpc.layer(Rpc, app).pipe(
    Layer.provide(RpcServer.layerProtocolHttp({ path: "/rpc" })),
    Layer.provide(RpcSerialization.layerJson),
  ),
).pipe(Layer.provide(signIn));

const tools = ActionToolkit.make(app);

const everySurface = Layer.mergeAll(
  RpcClient.layerProtocolHttp({ url: "/rpc" }).pipe(
    Layer.provide(RpcSerialization.layerJson),
    Layer.provideMerge(Testing.layer(routes)),
  ),
  tools.layer,
);

const echoArguments = modelArgumentsOf(Payload);

const failArguments = modelArgumentsOf(FailureInput);

const everySurfaceSucceeds = (input: typeof Payload.Type) =>
  Effect.gen(function* () {
    const http = yield* ActionHttp.client(Http);
    const rpc = yield* ActionRpc.client(Rpc);
    const mcp = yield* Testing.mcpClient([Echo, Fail]);
    const inProcess = yield* Action.client(app);
    const toolkit = yield* tools.toolkit;

    const [toolResult] = yield* Effect.flatMap(
      toolkit.handle("echo", yield* echoArguments(input)),
      Stream.runCollect,
    );

    return {
      http: yield* http.echo(input),
      rpc: yield* rpc.echo(input),
      mcp: yield* mcp.echo(input),
      toolkit: toolResult?.isFailure === false ? toolResult.result : toolResult,
      inProcess: yield* inProcess.echo(input),
    };
  }).pipe(Effect.provide(everySurface));

const everySurfaceFails = (failure: typeof Failure.Type) =>
  Effect.gen(function* () {
    const http = yield* ActionHttp.client(Http, withBearer);
    const rpc = yield* ActionRpc.client(Rpc);
    const mcp = yield* Testing.mcpClient([Echo, Fail], withBearer);
    const inProcess = yield* Action.client(app);
    const toolkit = yield* tools.toolkit;

    const [toolResult] = yield* Effect.flatMap(
      toolkit.handle("fail", yield* failArguments({ failure })),
      Stream.runCollect,
    ).pipe(asCaller);

    return {
      http: yield* Effect.flip(http.fail({ failure })),
      rpc: yield* Effect.flip(
        rpc.fail({ failure }).pipe(RpcClient.withHeaders({ authorization: `Bearer ${token}` })),
      ),
      mcp: yield* Effect.flip(mcp.fail({ failure })),
      toolkit: toolResult?.isFailure === true ? toolResult.result : toolResult,
      inProcess: yield* Effect.flip(inProcess.fail({ failure }).pipe(asCaller)),
    };
  }).pipe(Effect.provide(everySurface));

const Flat = Schema.Struct({
  text: Schema.String,
  amount: Schema.Finite,
  count: Schema.Int,
  enabled: Schema.Boolean,
});

const FlatEcho = Action.make("flatEcho", {
  description: "Return the flat input as the success.",
  readOnly: true,
  caller: Action.Anyone,
  input: Flat,
  success: Flat,
});

const flatCommand = ActionCli.command(Action.implement(FlatEcho, Effect.succeed), FlatEcho);

const attachedFlagsOf = ({ text, amount, count, enabled }: typeof Flat.Type) => [
  `--text=${text}`,
  `--amount=${amount}`,
  `--count=${count}`,
  ...(enabled ? ["--enabled"] : []),
];

const FlagLikePrefix = Schema.Literals([
  "",
  "-",
  "--",
  "-t",
  "--text",
  "--help",
  "=",
  " ",
  "\t",
  "\n",
]);

const flatInputsWithFlagLikeText = Arbitrary.all([
  Arbitrary.schema(Flat),
  Arbitrary.schema(FlagLikePrefix),
]).pipe(Arbitrary.map(([input, prefix]) => ({ ...input, text: `${prefix}${input.text}` })));

const printedFlat = Schema.decodeUnknownEffect(Schema.fromJsonString(Flat));

describe("every surface answers one call alike", () => {
  it.effect.prop(
    "succeeds on every surface with the generated input it echoes, as JSON text carries it",
    [Arbitrary.schema(Payload)],
    ([input]) =>
      Effect.map(everySurfaceSucceeds(input), (answers) => {
        const sent = sentAsJsonText(Payload)(input);

        for (const [surface, answer] of Object.entries(answers)) {
          expect(answer, surface).toEqual(sent);
        }
      }),
    { arbitrary: { runs: 200 } },
  );

  it.effect.prop(
    "fails on every surface with the generated declared error, as JSON text carries it",
    [failuresAsTheirJson],
    ([json]) =>
      Effect.gen(function* () {
        const failure = yield* decodeFailureJson(json);
        const answers = yield* everySurfaceFails(failure);
        const sent = sentAsJsonText(Failure)(failure);

        for (const [surface, answer] of Object.entries(answers)) {
          expect(answer, surface).toEqual(sent);
        }
      }),
    { arbitrary: { runs: 200 } },
  );

  it.effect.prop(
    "prints the generated input its command's attached flags carry, flag-like text included",
    [flatInputsWithFlagLikeText],
    ([input]) =>
      Effect.gen(function* () {
        const [, lines] = yield* logged(exec(flatCommand, attachedFlagsOf(input)));

        expect(yield* printedFlat(lines.join("\n"))).toEqual(sentAsJsonText(Flat)(input));
      }),
    { arbitrary: { runs: 500 } },
  );
});
