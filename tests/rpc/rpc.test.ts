import { NodeHttpServer, NodeSocket, NodeSocketServer } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import {
  Cause,
  Context,
  Effect,
  ErrorReporter,
  Exit,
  Layer,
  Logger,
  Redacted,
  Schema,
  SchemaTransformation,
} from "effect";
import { HttpClient, HttpClientRequest, HttpRouter, HttpServer } from "effect/http";
import { RpcClient, RpcMiddleware, RpcSerialization, RpcServer } from "effect/rpc";
import { SocketServer } from "effect/socket";
import { authenticate, verify } from "../../examples/authentication.js";
import { CurrentActor } from "../../examples/authorization.js";
import { Login } from "../../examples/binding.js";
import {
  Double,
  GetUser,
  RenameUser,
  Status,
  UserNotFound,
  WhoAmI,
} from "../../examples/contracts.js";
import { double, status, userActions } from "../../examples/handlers.js";
import { Users } from "../../examples/users.js";
import * as Action from "../../src/contract/Action.js";
import * as ActionRpc from "../../src/rpc/ActionRpc.js";
import * as Authentication from "../../src/authentication/Authentication.js";
import * as Testing from "../../src/testing/Testing.js";
import { recorder } from "../support/reporter.js";

const Rpc = ActionRpc.make([Status, GetUser, RenameUser, Double, WhoAmI], {
  authentication: Login,
});

const servedAtRpcOverHttp = <A, E, R>(
  server: Layer.Layer<A, E, R>,
  serialization: Layer.Layer<RpcSerialization.RpcSerialization> = RpcSerialization.layerNdjson,
) =>
  server.pipe(
    Layer.provide(RpcServer.layerProtocolHttp({ path: "/rpc" })),
    Layer.provide(serialization),
  );

const routes = servedAtRpcOverHttp(ActionRpc.layer(Rpc, [status, userActions, double])).pipe(
  Layer.provide(authenticate),
);

const inMemoryProtocolTo = <E, R>(
  server: Layer.Layer<never, E, R>,
  serialization: Layer.Layer<RpcSerialization.RpcSerialization> = RpcSerialization.layerNdjson,
) =>
  RpcClient.layerProtocolHttp({ url: "/rpc" }).pipe(
    Layer.provide(serialization),
    Layer.provide(Testing.layer(server)),
  );

const signedInAs = (token: string) => RpcClient.withHeaders({ authorization: `Bearer ${token}` });

const withClient = <A, E, R>(
  program: (client: ActionRpc.Client<typeof Rpc>) => Effect.Effect<A, E, R>,
) =>
  Effect.flatMap(ActionRpc.client(Rpc), program).pipe(
    Effect.scoped,
    Effect.provide(inMemoryProtocolTo(routes)),
    Effect.provide(Users.layerMemory),
  );

const RawRequest = Schema.TaggedStruct("Request", {
  id: Schema.String,
  tag: Schema.String,
  payload: Schema.Json,
  headers: Schema.Array(Schema.Tuple([Schema.String, Schema.String])),
});

const RawAnswer = Schema.fromJsonString(
  Schema.Struct({
    exit: Schema.toCodecJson(Schema.Exit(Schema.Json, Action.BuiltIn, Schema.Defect())),
  }),
);

const internalServerErrorDefect = new Error("Internal server error");

const valueOrSquashedCause = <A, E>(exit: Exit.Exit<A, E>) =>
  Exit.isSuccess(exit) ? exit.value : Cause.squash(exit.cause);

interface RawMessage {
  readonly tag: string;
  readonly payload: Schema.Json;
  readonly headers?: ReadonlyArray<readonly [string, string]>;
}

const sendRawNdjson = (messages: ReadonlyArray<RawMessage>, token?: string) =>
  Effect.gen(function* () {
    const body = messages
      .map(({ tag, payload, headers = [] }, id) =>
        JSON.stringify(RawRequest.make({ id: String(id), tag, payload, headers })),
      )
      .join("\n");

    const request = HttpClientRequest.post("/rpc").pipe(
      HttpClientRequest.bodyText(`${body}\n`, "application/ndjson"),
    );

    const response = yield* HttpClient.execute(
      token === undefined ? request : HttpClientRequest.bearerToken(request, token),
    );

    const text = yield* response.text;

    return {
      text,
      exits: text
        .split("\n")
        .filter((line) => line !== "")
        .map((line) => Schema.decodeUnknownSync(RawAnswer)(line).exit),
    };
  });

describe("ActionRpc over the HTTP protocol", () => {
  it.effect("answers a public action without a credential, its input left out", () =>
    Effect.gen(function* () {
      const answer = yield* withClient((client) => client.status());

      expect(answer).toEqual({ service: "effect-actions", users: 2 });
    }),
  );

  it.effect("refuses a protected action without a credential with a typed Unauthenticated", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(withClient((client) => client.whoAmI()));

      expect(error).toBeInstanceOf(Action.Unauthenticated);
      expect(error).toMatchObject({ message: "A bearer token is required." });
    }),
  );

  it.effect("refuses an unknown token with the verifier's own refusal", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        withClient((client) => client.whoAmI().pipe(signedInAs("mallory"))),
      );

      expect(error).toBeInstanceOf(Action.Unauthenticated);
      expect(error).toMatchObject({ message: "Unknown demo token." });
    }),
  );

  it.effect("provides the authenticated identity to the handler", () =>
    Effect.gen(function* () {
      const answer = yield* withClient((client) => client.whoAmI().pipe(signedInAs("alice")));

      expect(answer).toEqual({ id: "alice", tenantId: "acme" });
    }),
  );

  it.effect("runs the input's codec: the string a number encodes to decodes back", () =>
    Effect.gen(function* () {
      const answer = yield* withClient((client) =>
        client.double({ value: 21 }).pipe(signedInAs("alice")),
      );

      expect(answer).toBe(42);
    }),
  );

  it.effect("fails with the authorizer's Forbidden, its scopes kept, before the handler", () =>
    Effect.gen(function* () {
      const [error, user] = yield* withClient((client) =>
        Effect.all([
          Effect.flip(client.renameUser({ id: "1", name: "Bea" }).pipe(signedInAs("reader"))),
          client.getUser({ id: "1" }).pipe(signedInAs("reader")),
        ]),
      );

      expect(error).toBeInstanceOf(Action.Forbidden);
      expect(error).toMatchObject({ scopes: ["users:write"] });
      expect(user).toEqual({ id: "1", name: "Ada" });
    }),
  );

  it.effect("decodes a declared error as itself", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        withClient((client) => client.getUser({ id: "9" }).pipe(signedInAs("alice"))),
      );

      expect(error).toBeInstanceOf(UserNotFound);
      expect(error).toMatchObject({ id: "9" });
    }),
  );

  it.effect("fails with InvalidInput for input that does not encode, sending nothing", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        withClient((client) => client.renameUser({ id: "1", name: "" }).pipe(signedInAs("alice"))),
      );

      expect(error).toBeInstanceOf(Action.InvalidInput);
      expect(error).toMatchObject({ issues: [{ path: ["name"] }] });
    }),
  );
});

describe("ActionRpc refusals, in order", () => {
  it.effect(
    "answers input that does not decode, or holds an undeclared field, with InvalidInput and its issues, after authentication",
    () =>
      Effect.gen(function* () {
        const { exits } = yield* sendRawNdjson(
          [
            { tag: "renameUser", payload: { id: "1", name: "" } },
            { tag: "getUser", payload: { id: "1", extra: true } },
          ],
          "alice",
        );

        const [short, extra] = exits.map(valueOrSquashedCause);

        expect(short).toBeInstanceOf(Action.InvalidInput);
        expect(short).toMatchObject({ issues: [{ path: ["name"] }] });
        expect(extra).toBeInstanceOf(Action.InvalidInput);
        expect(extra).toMatchObject({ issues: [{ path: ["extra"] }] });
      }).pipe(Effect.provide(Testing.layer(routes)), Effect.provide(Users.layerMemory)),
  );

  it.effect("decodes no input of a protected rpc whose message is not authenticated", () => {
    let decoded = 0;

    const CountedDecoding = Schema.String.pipe(
      Schema.decodeTo(
        Schema.String,
        SchemaTransformation.transform({
          decode: (name: string) => {
            decoded += 1;

            return name;
          },
          encode: (name: string) => name,
        }),
      ),
    );

    const Greet = Action.make("greet", {
      description: "Echo a name.",
      input: { name: CountedDecoding },
      success: Schema.String,
      readOnly: true,
      caller: CurrentActor,
    });

    const greet = Action.implement(Greet, ({ name }) => Effect.succeed(name), {
      authorize: Action.allowAll,
    });

    const server = servedAtRpcOverHttp(
      ActionRpc.layer(ActionRpc.make([Greet], { authentication: Login }), greet),
    ).pipe(Layer.provide(authenticate));

    return Effect.gen(function* () {
      const anonymous = yield* sendRawNdjson([{ tag: "greet", payload: { name: "Ada" } }]);
      const before = decoded;
      const signed = yield* sendRawNdjson([{ tag: "greet", payload: { name: "Ada" } }], "alice");

      expect(anonymous.exits.map(valueOrSquashedCause)).toEqual([
        new Action.Unauthenticated({ message: "A bearer token is required." }),
      ]);
      expect(before).toBe(0);
      expect(signed.exits.map(valueOrSquashedCause)).toEqual(["Ada"]);
      expect(decoded).toBe(1);
    }).pipe(Effect.provide(Testing.layer(server)));
  });
});

describe("ActionRpc serializations", () => {
  const serving = (serialization: Layer.Layer<RpcSerialization.RpcSerialization>) =>
    servedAtRpcOverHttp(ActionRpc.layer(Rpc, [status, userActions, double]), serialization).pipe(
      Layer.provide(authenticate),
    );

  it.effect.each([
    ["json", RpcSerialization.layerJson],
    ["ndjson", RpcSerialization.layerNdjson],
    ["jsonRpc", RpcSerialization.layerJsonRpc()],
    ["ndJsonRpc", RpcSerialization.layerNdJsonRpc()],
    [
      "jsonRpc of its own content type",
      RpcSerialization.layerJsonRpc({ contentType: "application/custom" }),
    ],
  ] as const)("serves %s", ([, serialization]) =>
    Effect.gen(function* () {
      const client = yield* ActionRpc.client(Rpc);

      const doubled = yield* client.double({ value: 21 }).pipe(signedInAs("alice"));
      const missing = yield* Effect.flip(client.getUser({ id: "9" }).pipe(signedInAs("alice")));

      expect(doubled).toBe(42);
      expect(missing).toBeInstanceOf(UserNotFound);
    }).pipe(
      Effect.scoped,
      Effect.provide(inMemoryProtocolTo(serving(serialization), serialization)),
      Effect.provide(Users.layerMemory),
    ),
  );

  it.effect("refuses to build under schema-binary", () =>
    Effect.gen(function* () {
      const built = yield* Effect.exit(
        Effect.void.pipe(
          Effect.provide(Testing.layer(serving(RpcSerialization.layerSchemaBinary()))),
        ),
      );

      expect(Exit.isFailure(built) && Cause.squash(built.cause)).toEqual(
        new Error(
          "ActionRpc serves a protocol speaking JSON: RpcSerialization.layerJson, layerNdjson, layerJsonRpc or layerNdJsonRpc, not another codec, such as schema-binary's",
        ),
      );
    }).pipe(Effect.provide(Users.layerMemory)),
  );
});

const Crashy = Action.make("crashy", {
  description: "Dies.",
  readOnly: true,
  caller: Action.Anyone,
});

const crashy = Action.implement(Crashy, () => Effect.die(new Error("db password hunter2")));

const Leaky = Action.make("leaky", {
  description: "Fails with an error it does not declare.",
  readOnly: true,
  caller: Action.Anyone,
});

const leaky = Action.implement(Leaky, () =>
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- The failure under test: the contract broken, as plain JavaScript could.
  Effect.fail(new UserNotFound({ id: "secret-id" }) as never),
);

const Count = Action.make("count", {
  description: "Answers a number its success does not encode.",
  readOnly: true,
  caller: Action.Anyone,
  success: Schema.Finite,
});

const count = Action.implement(Count, () => Effect.succeed(Infinity));

class ThrowsWhenEncoded extends Schema.TaggedError<ThrowsWhenEncoded>()("Fragile", {
  note: Schema.String.pipe(
    Schema.decodeTo(
      Schema.String,
      SchemaTransformation.transform({
        decode: (note: string) => note,
        encode: (): string => {
          throw new Error("encoder secret");
        },
      }),
    ),
  ),
}) {}

const Brittle = Action.make("brittle", {
  description: "Fails with a declared error that does not encode.",
  readOnly: true,
  caller: Action.Anyone,
  error: ThrowsWhenEncoded,
});

const brittle = Action.implement(Brittle, () =>
  Effect.fail(new ThrowsWhenEncoded({ note: "kept" })),
);

const Twice = Action.make("twice", {
  description: "Fails with two declared errors at once, the second of which does not encode.",
  readOnly: true,
  caller: Action.Anyone,
  error: [UserNotFound, ThrowsWhenEncoded],
});

const twice = Action.implement(Twice, () =>
  Effect.failCause(
    Cause.combine(
      Cause.fail(new UserNotFound({ id: "9" })),
      Cause.fail(new ThrowsWhenEncoded({ note: "second" })),
    ),
  ),
);

const Faulty = ActionRpc.make([Crashy, Leaky, Count, Brittle, Twice, Status]);

const faulty = servedAtRpcOverHttp(
  ActionRpc.layer(Faulty, [crashy, leaky, count, brittle, twice, status]),
);

describe("ActionRpc internal errors", () => {
  it.effect("answers the first of several failures alone, as it is encoded", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.flatMap(ActionRpc.client(Faulty), (client) =>
        Effect.exit(client.twice()),
      ).pipe(
        Effect.scoped,
        Effect.provide(inMemoryProtocolTo(faulty)),
        Effect.provide(Users.layerMemory),
      );

      expect(Exit.isFailure(exit) && exit.cause.reasons).toEqual([
        expect.objectContaining({ error: new UserNotFound({ id: "9" }) }),
      ]);
    }),
  );

  it.effect(
    "answers a defect, an undeclared failure, and a success or a declared failure that does not encode generically, each its own request's, logging its cause",
    () => {
      const logged: Array<string> = [];

      return Effect.gen(function* () {
        const { text, exits } = yield* sendRawNdjson([
          { tag: "crashy", payload: {} },
          { tag: "leaky", payload: {} },
          { tag: "count", payload: {} },
          { tag: "brittle", payload: {} },
          { tag: "status", payload: {} },
        ]);

        expect(exits.map(valueOrSquashedCause)).toEqual([
          internalServerErrorDefect,
          internalServerErrorDefect,
          internalServerErrorDefect,
          internalServerErrorDefect,
          { service: "effect-actions", users: 2 },
        ]);
        expect(exits.map((exit) => Exit.isFailure(exit) && Cause.hasDies(exit.cause))).toEqual([
          true,
          true,
          true,
          true,
          false,
        ]);

        expect(text).not.toContain("hunter2");
        expect(text).not.toContain("secret-id");
        expect(text).not.toContain("encoder secret");
        expect(logged).toEqual([
          expect.stringContaining("db password hunter2"),
          expect.stringContaining("UserNotFound"),
          expect.stringContaining("Expected a finite number"),
          expect.stringContaining("encoder secret"),
        ]);
      }).pipe(
        Effect.provide(Testing.layer(faulty)),
        Effect.provide(Users.layerMemory),
        Effect.provide(
          Logger.layer([Logger.make(({ cause }) => void logged.push(Cause.pretty(cause)))]),
        ),
      );
    },
  );

  it.effect(
    "answers what the verifier or a layer middleware fails with undeclared, or throws, generically, each its own request's",
    () => {
      const logged: Array<string> = [];

      class Boom extends RpcMiddleware.Service<Boom>()("rpc-test/Boom") {}

      const Guarded = ActionRpc.make([WhoAmI, Status], { authentication: Login });

      const server = servedAtRpcOverHttp(
        ActionRpc.layer(Guarded, [userActions, status], { middleware: [Boom] }),
      ).pipe(
        Layer.provide([
          Layer.succeed(Boom, (effect, { headers }) => {
            if (headers["x-throw"] !== undefined) throw new Error("thrown secret");

            return headers["x-boom"] === undefined
              ? effect
              : Effect.die(new Error("middleware secret"));
          }),
          Authentication.layer(Login, (token: Redacted.Redacted<string>) =>
            Redacted.value(token) === "broken"
              ? // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- The failure under test: the descriptor broken, as plain JavaScript could.
                Effect.fail(new UserNotFound({ id: "verifier secret" }) as never)
              : verify(token),
          ),
        ]),
      );

      return Effect.gen(function* () {
        const { text, exits } = yield* sendRawNdjson(
          [
            { tag: "whoAmI", payload: {} },
            { tag: "status", payload: {}, headers: [["x-boom", "1"]] },
            { tag: "status", payload: {}, headers: [["x-throw", "1"]] },
            { tag: "status", payload: {} },
          ],
          "broken",
        );

        expect(exits.map(valueOrSquashedCause)).toEqual([
          internalServerErrorDefect,
          internalServerErrorDefect,
          internalServerErrorDefect,
          { service: "effect-actions", users: 2 },
        ]);
        expect(text).not.toContain("secret");
        expect(logged).toEqual([
          expect.stringContaining("UserNotFound"),
          expect.stringContaining("middleware secret"),
          expect.stringContaining("thrown secret"),
        ]);
      }).pipe(
        Effect.provide(Testing.layer(server)),
        Effect.provide(Users.layerMemory),
        Effect.provide(
          Logger.layer([Logger.make(({ cause }) => void logged.push(Cause.pretty(cause)))]),
        ),
      );
    },
  );

  const Reported = ActionRpc.make([Crashy, GetUser], { authentication: Login });

  const callReported = <E, R>(
    server: Layer.Layer<never, E, R>,
    outer: Layer.Layer<never> = Layer.empty,
  ) =>
    Effect.gen(function* () {
      const client = yield* ActionRpc.client(Reported);

      yield* Effect.exit(client.crashy());
      yield* Effect.exit(client.getUser({ id: "9" }).pipe(signedInAs("alice")));
      yield* Effect.exit(client.getUser({ id: "1" }));
    }).pipe(
      Effect.scoped,
      Effect.provide(
        RpcClient.layerProtocolHttp({ url: "/rpc" }).pipe(
          Layer.provide(RpcSerialization.layerNdjson),
          Layer.provide(Testing.layer(server).pipe(Layer.provide(outer))),
        ),
      ),
      Effect.provide(Users.layerMemory),
    );

  it.effect(
    "reports a defect once with its cause, and neither a declared failure, a refusal nor the generic answer",
    () =>
      Effect.gen(function* () {
        const reported: Array<string> = [];

        yield* callReported(
          servedAtRpcOverHttp(ActionRpc.layer(Reported, [crashy, userActions])).pipe(
            Layer.provide(authenticate),
            Layer.provide(ErrorReporter.layer([recorder(reported)])),
          ),
        );

        expect(reported).toEqual([expect.stringContaining("db password hunter2")]);
      }),
  );
});

describe("ActionRpc selection", () => {
  it.effect("serves the listed actions only, owing no provider when none is protected", () =>
    Effect.gen(function* () {
      const selected = servedAtRpcOverHttp(
        ActionRpc.layer(Rpc, [status, userActions, double], { actions: [Status] }),
      );

      const [up, unserved] = yield* Effect.gen(function* () {
        const client = yield* ActionRpc.client(Rpc);

        return yield* Effect.all([client.status(), Effect.exit(client.double({ value: 1 }))]);
      }).pipe(Effect.scoped, Effect.provide(inMemoryProtocolTo(selected)));

      expect(up.service).toBe("effect-actions");
      expect(Exit.isFailure(unserved) && Cause.pretty(unserved.cause)).toContain(
        "Unknown request tag",
      );
    }).pipe(Effect.provide(Users.layerMemory)),
  );

  it("refuses a listed action the binding does not hold, and implementations holding none of its", () => {
    expect(() =>
      // @ts-expect-error -- As plain JavaScript may: Crashy is not the binding's.
      ActionRpc.layer(Rpc, [status, crashy], { actions: [Crashy] }),
    ).toThrow("Listed in actions, but the binding does not hold it: crashy");

    expect(() => ActionRpc.layer(Rpc, crashy)).toThrow(
      "No action of these implementations is in this RPC binding: crashy",
    );
  });

  it("refuses middleware listed twice", () => {
    class Twice extends RpcMiddleware.Service<Twice>()("rpc-test/Twice") {}

    expect(() => ActionRpc.layer(Rpc, status, { middleware: [Twice, Twice] })).toThrow(
      "Duplicate middleware: rpc-test/Twice",
    );
  });

  it.effect("dies when the provider is another descriptor's of the binding's name", () =>
    Effect.gen(function* () {
      const Impostor = Authentication.make("example.Login", CurrentActor);

      const server = servedAtRpcOverHttp(ActionRpc.layer(Rpc, userActions)).pipe(
        Layer.provide(Authentication.layer(Impostor, verify)),
      );

      const built = yield* Effect.exit(Effect.void.pipe(Effect.provide(Testing.layer(server))));

      expect(Exit.isFailure(built) && Cause.squash(built.cause)).toEqual(
        new Error(
          `Authentication "example.Login": the binding's descriptor is not its provider's; build both from one descriptor`,
        ),
      );
    }).pipe(Effect.provide(Users.layerMemory)),
  );
});

class Tenant extends Context.Service<Tenant, string>()("rpc-test/Tenant") {}

class RateLimited extends Schema.TaggedError<RateLimited>()("RateLimited", {
  retryAfter: Schema.Finite,
}) {}

const TenantName = Action.make("tenantName", {
  description: "Name the request's tenant.",
  readOnly: true,
  caller: Action.Anyone,
  success: Schema.String,
});

const tenantName = Action.implement(TenantName, () => Tenant);

class ResolveTenant extends RpcMiddleware.Service<ResolveTenant, { provides: Tenant }>()(
  "rpc-test/ResolveTenant",
) {}

class LimitOnXLimitHeader extends RpcMiddleware.Service<LimitOnXLimitHeader>()("rpc-test/Limit", {
  error: RateLimited,
}) {}

const resolveTenant = Layer.succeed(ResolveTenant, (effect, { headers }) =>
  Effect.provideService(effect, Tenant, headers["x-tenant"] ?? "default"),
);

const limit = Layer.succeed(LimitOnXLimitHeader, (effect, { headers }) =>
  headers["x-limit"] === undefined ? effect : Effect.fail(new RateLimited({ retryAfter: 30 })),
);

describe("ActionRpc layer middleware", () => {
  const Limited = ActionRpc.make([TenantName], { error: RateLimited });

  it.effect(
    "provides a request service, and fails with the binding's error, which the client decodes",
    () =>
      Effect.gen(function* () {
        const server = servedAtRpcOverHttp(
          ActionRpc.layer(Limited, tenantName, {
            middleware: [ResolveTenant, LimitOnXLimitHeader],
          }),
        ).pipe(Layer.provide([resolveTenant, limit]));

        const [acme, fallback, limited] = yield* Effect.gen(function* () {
          const client = yield* ActionRpc.client(Limited);

          return yield* Effect.all([
            client.tenantName().pipe(RpcClient.withHeaders({ "x-tenant": "acme" })),
            client.tenantName(),
            Effect.flip(client.tenantName().pipe(RpcClient.withHeaders({ "x-limit": "1" }))),
          ]);
        }).pipe(Effect.scoped, Effect.provide(inMemoryProtocolTo(server)));

        expect([acme, fallback]).toEqual(["acme", "default"]);
        expect(limited).toBeInstanceOf(RateLimited);
        expect(limited).toMatchObject({ retryAfter: 30 });
      }),
  );

  it.effect(
    "takes a request service from the router's request context, as an HTTP route does",
    () =>
      Effect.gen(function* () {
        const server = servedAtRpcOverHttp(ActionRpc.layer(Limited, tenantName)).pipe(
          HttpRouter.provideRequest(Layer.succeed(Tenant, "router")),
        );

        const answer = yield* Effect.flatMap(ActionRpc.client(Limited), (client) =>
          client.tenantName(),
        ).pipe(Effect.scoped, Effect.provide(inMemoryProtocolTo(server)));

        expect(answer).toBe("router");
      }),
  );

  it.effect(
    "runs authentication, the middleware, the first listed innermost, decoding, the authorizer, then the handler",
    () =>
      Effect.gen(function* () {
        const seen: Array<string> = [];
        const note = (step: string) => Effect.sync(() => void seen.push(step));

        const Noted = Action.make("noted", {
          description: "Echo a name.",
          input: { name: Schema.String.check(Schema.isMinLength(1)) },
          success: Schema.String,
          readOnly: true,
          caller: CurrentActor,
        });

        const noted = Action.implement(Noted, ({ name }) => Effect.as(note("handler"), name), {
          authorize: () => note("authorize"),
        });

        class Inner extends RpcMiddleware.Service<Inner>()("rpc-test/Inner") {}

        class Outer extends RpcMiddleware.Service<Outer>()("rpc-test/Outer") {}

        const server = servedAtRpcOverHttp(
          ActionRpc.layer(ActionRpc.make([Noted], { authentication: Login }), noted, {
            middleware: [Inner, Outer],
          }),
        ).pipe(
          Layer.provide([
            Layer.succeed(Inner, (effect) => Effect.andThen(note("inner"), effect)),
            Layer.succeed(Outer, (effect) => Effect.andThen(note("outer"), effect)),
            Authentication.layer(Login, (token: Redacted.Redacted<string>) =>
              Effect.andThen(note("authenticate"), verify(token)),
            ),
          ]),
        );

        const { exits } = yield* sendRawNdjson(
          [
            { tag: "noted", payload: { name: "Ada" } },
            { tag: "noted", payload: { name: "" } },
          ],
          "alice",
        ).pipe(Effect.provide(Testing.layer(server)));

        const [named, invalid] = exits.map(valueOrSquashedCause);

        expect(named).toBe("Ada");
        expect(invalid).toBeInstanceOf(Action.InvalidInput);

        expect(seen).toEqual([
          "authenticate",
          "outer",
          "inner",
          "authorize",
          "handler",
          "authenticate",
          "outer",
          "inner",
        ]);
      }),
  );
});

describe("ActionRpc over a WebSocket", () => {
  const Socketed = ActionRpc.make([Status, WhoAmI, Crashy], { authentication: Login });

  const server = HttpRouter.serve(
    ActionRpc.layer(Socketed, [status, userActions, crashy]).pipe(
      Layer.provide(RpcServer.layerProtocolWebsocket({ path: "/rpc" })),
      Layer.provide(RpcSerialization.layerJson),
      Layer.provide(authenticate),
    ),
    { disableLogger: true, disableListenLog: true },
  ).pipe(Layer.provideMerge(NodeHttpServer.layerTest));

  const overSocket = <A, E, R>(
    program: (client: ActionRpc.Client<typeof Socketed>) => Effect.Effect<A, E, R>,
  ) =>
    HttpServer.addressFormattedWith((address) =>
      Effect.flatMap(ActionRpc.client(Socketed), program).pipe(
        Effect.scoped,
        Effect.provide(
          RpcClient.layerProtocolSocket().pipe(
            Layer.provide(NodeSocket.layerWebSocket(`${address.replace(/^http/, "ws")}/rpc`)),
            Layer.provide(RpcSerialization.layerJson),
          ),
        ),
      ),
    ).pipe(Effect.provide(server), Effect.provide(Users.layerMemory));

  it.effect("serves a public action", () =>
    Effect.map(
      overSocket((client) => client.status()),
      (answer) => {
        expect(answer.service).toBe("effect-actions");
      },
    ),
  );

  it.effect("authenticates each message by its own token, several callers on one connection", () =>
    Effect.map(
      overSocket((client) =>
        Effect.all([
          client.whoAmI().pipe(signedInAs("alice")),
          Effect.flip(client.whoAmI()),
          client.whoAmI().pipe(signedInAs("bob")),
        ]),
      ),
      ([alice, anonymous, bob]) => {
        expect(alice).toEqual({ id: "alice", tenantId: "acme" });
        expect(anonymous).toBeInstanceOf(Action.Unauthenticated);
        expect(bob).toEqual({ id: "bob", tenantId: "other" });
      },
    ),
  );

  it.effect("takes a request service from the upgrade request's router context", () =>
    Effect.gen(function* () {
      const Named = ActionRpc.make([TenantName]);

      const named = HttpRouter.serve(
        ActionRpc.layer(Named, tenantName).pipe(
          Layer.provide(RpcServer.layerProtocolWebsocket({ path: "/rpc" })),
          Layer.provide(RpcSerialization.layerJson),
          HttpRouter.provideRequest(Layer.succeed(Tenant, "upgrade")),
        ),
        { disableLogger: true, disableListenLog: true },
      ).pipe(Layer.provideMerge(NodeHttpServer.layerTest));

      const answers = yield* HttpServer.addressFormattedWith((address) =>
        Effect.flatMap(ActionRpc.client(Named), (client) =>
          Effect.all([client.tenantName(), client.tenantName()]),
        ).pipe(
          Effect.scoped,
          Effect.provide(
            RpcClient.layerProtocolSocket().pipe(
              Layer.provide(NodeSocket.layerWebSocket(`${address.replace(/^http/, "ws")}/rpc`)),
              Layer.provide(RpcSerialization.layerJson),
            ),
          ),
        ),
      ).pipe(Effect.provide(named));

      expect(answers).toEqual(["upgrade", "upgrade"]);
    }),
  );

  it.effect("fails a defect's call alone: a concurrent call on the connection still succeeds", () =>
    Effect.map(
      overSocket((client) =>
        Effect.all([Effect.exit(client.crashy()), client.status()], { concurrency: "unbounded" }),
      ),
      ([crashed, up]) => {
        expect(Exit.isFailure(crashed) && Cause.squash(crashed.cause)).toEqual(
          internalServerErrorDefect,
        );
        expect(up.service).toBe("effect-actions");
      },
    ),
  );
});

describe("ActionRpc over a socket server", () => {
  const server = ActionRpc.layer(Rpc, [status, userActions]).pipe(
    Layer.provide(RpcServer.layerProtocolSocketServer),
    Layer.provide(RpcSerialization.layerNdjson),
    Layer.provide(Authentication.layer(Login, verify)),
    Layer.provideMerge(NodeSocketServer.layer({ host: "127.0.0.1", port: 0 })),
  );

  it.effect("serves public and protected actions with no router, authenticating each message", () =>
    Effect.gen(function* () {
      const { address } = yield* SocketServer.SocketServer;
      const port = "port" in address ? address.port : 0;

      const [up, alice, anonymous] = yield* Effect.flatMap(ActionRpc.client(Rpc), (client) =>
        Effect.all([
          client.status(),
          client.whoAmI().pipe(signedInAs("alice")),
          Effect.flip(client.whoAmI()),
        ]),
      ).pipe(
        Effect.scoped,
        Effect.provide(
          RpcClient.layerProtocolSocket().pipe(
            Layer.provide(NodeSocket.layerNet({ host: "127.0.0.1", port })),
            Layer.provide(RpcSerialization.layerNdjson),
          ),
        ),
      );

      expect(up.service).toBe("effect-actions");
      expect(alice).toEqual({ id: "alice", tenantId: "acme" });
      expect(anonymous).toBeInstanceOf(Action.Unauthenticated);
    }).pipe(Effect.provide(server), Effect.provide(Users.layerMemory)),
  );
});
