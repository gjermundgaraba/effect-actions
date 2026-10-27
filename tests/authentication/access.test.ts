import { describe, expect, it } from "@effect/vitest";
import {
  Context,
  Effect,
  Latch,
  Layer,
  Redacted,
  Schema,
  Stream,
} from "effect";
import { McpServer } from "effect/ai";
import { Command } from "effect/cli";

import * as Authentication from "../../src/authentication/Authentication.js";
import * as ActionCli from "../../src/cli/ActionCli.js";
import * as Action from "../../src/contract/Action.js";
import * as ActionHttp from "../../src/http/ActionHttp.js";
import * as ActionMcp from "../../src/mcp/ActionMcp.js";
import * as Testing from "../../src/testing/Testing.js";
import * as ActionToolkit from "../../src/toolkit/ActionToolkit.js";
import { causeOf, exec, printed } from "../support/cli-services.js";
import {
  as,
  mcpRequest,
  post,
  rawToolCall,
  send,
  withBearer,
} from "../support/requests.js";
import { serve } from "../support/serve.js";

class Scopes extends Context.Service<Scopes, readonly string[]>()(
  "access-test/Scopes"
) {}

class Caller extends Context.Service<Caller, string>()("access-test/Caller") {}

const TokenScopesLogin = Authentication.make("access-test.ScopesLogin", Scopes);

const grantTokenListedScopes = Authentication.layer(
  TokenScopesLogin,
  (token: Redacted.Redacted) =>
    Effect.succeed(
      Redacted.value(token) === "none" ? [] : Redacted.value(token).split(",")
    )
);

const AnyTokenLogin = Authentication.make("access-test.AnyCaller", Caller);

const anyone = Authentication.layer(AnyTokenLogin, () =>
  Effect.succeed("anyone")
);

const Read = Action.make("read", {
  description: "Read the resource",
  readOnly: true,
  caller: Scopes,
  success: Schema.String,
});

const Write = Action.make("write", {
  description: "Change the resource",
  readOnly: false,
  caller: Scopes,
  input: { value: Schema.String },
  success: Schema.String,
});

const Http = ActionHttp.make([Read, Write], {
  authentication: TokenScopesLogin,
});

const authorize =
  (seen: string[]) =>
  (action: Action.Any): Effect.Effect<void, Action.Refusal, Scopes> =>
    Effect.gen(function* () {
      seen.push(action.name);
      const granted = yield* Scopes;

      if (granted.length === 0) {
        return yield* new Action.Unauthenticated({ message: "Sign in." });
      }

      if (action.readOnly) {
        return;
      }

      if (!granted.includes("write")) {
        return yield* new Action.Forbidden({ message: "Requires write." });
      }
    });

const freshRecordingImplementation = () => {
  const authorized: string[] = [];
  const handlers: string[] = [];

  const record = (name: string) =>
    Effect.sync(() => {
      handlers.push(name);

      return `${name} ok`;
    });

  return {
    authorized,
    handlers,
    app: Action.implement(
      [Read, Write],
      {
        read: () => record("read"),
        write: () => record("write"),
      },
      { authorize: authorize(authorized) }
    ),
  };
};

const readOnly = Layer.succeed(Scopes, ["read"]);

type App = ReturnType<typeof freshRecordingImplementation>["app"];

const serveHttp = (app: App) =>
  serve(
    ActionHttp.layer(Http, app).pipe(Layer.provide(grantTokenListedScopes))
  );

const withReadScope = (request: Request) => withBearer(request, "read");

const run = <Name extends string, Input, Services, E>(
  command: Command.Command<Name, Input, Services, E, Scopes>,
  argv: readonly string[]
) => printed(exec(command, argv)).pipe(Effect.provide(readOnly));

describe("action classification", () => {
  it("refuses a readOnly that is not a boolean, so plain JavaScript cannot skip a rule", () => {
    for (const unclassified of [undefined, "read"]) {
      expect(() =>
        Action.make("unclassified", {
          description: "Classified by nobody",
          // @ts-expect-error -- The check exists for callers the compiler never sees.
          readOnly: unclassified,
          caller: Action.Anyone,
          success: Schema.String,
        })
      ).toThrow(`Invalid readOnly: ${unclassified} (set true or false)`);
    }
  });

  it("refuses a contract stating no one who may call it", () => {
    for (const caller of [undefined, "public"]) {
      expect(() =>
        // @ts-expect-error -- The check exists for callers the compiler never sees.
        Action.make("unstated", { description: "", readOnly: true, caller })
      ).toThrow(
        "Missing caller: declare Action.Anyone or an identity service key"
      );
    }
  });

  it("refuses a Context.Reference as an identity, whose default would stand in for every caller", () => {
    const Default = Context.Reference<string>("access/Default", {
      defaultValue: () => "anyone",
    });

    expect(() =>
      Action.make("byDefault", {
        description: "",
        readOnly: true,
        // @ts-expect-error -- The check exists for callers the compiler never sees.
        caller: Default,
      })
    ).toThrow(
      "Invalid caller: an identity is a Context.Service, not a Context.Reference"
    );
  });
});

describe("the authorizer", () => {
  it("runs once before each handler over HTTP and answers as a built-in refusal", async () => {
    const { app, authorized, handlers } = freshRecordingImplementation();
    const web = serveHttp(app);

    const allowed = await web.handler(withReadScope(post("/api/read")));
    expect(allowed.status).toBe(200);
    await expect(allowed.json()).resolves.toBe("read ok");

    const refused = await web.handler(
      withReadScope(post("/api/write", { value: "x" }))
    );

    expect(refused.status).toBe(403);
    await expect(refused.json()).resolves.toStrictEqual(
      Schema.encodeSync(Action.Forbidden)(
        new Action.Forbidden({ message: "Requires write." })
      )
    );

    expect(authorized).toStrictEqual(["read", "write"]);
    expect(handlers).toStrictEqual(["read"]);
  });

  it("decodes HTTP input before running either the authorizer or handler, after authenticating", async () => {
    const { app, authorized, handlers } = freshRecordingImplementation();
    const web = serveHttp(app);

    const writeResponse = await web.handler(post("/api/write", { value: 42 }));

    expect(writeResponse.status).toBe(401);

    const invalid = await web.handler(
      withReadScope(post("/api/write", { value: 42 }))
    );

    expect(invalid.status).toBe(400);
    expect(authorized).toStrictEqual([]);
    expect(handlers).toStrictEqual([]);

    const refused = await web.handler(
      withReadScope(post("/api/write", { value: "x" }))
    );

    expect(refused.status).toBe(403);
    expect(authorized).toStrictEqual(["write"]);
    expect(handlers).toStrictEqual([]);
  });

  it("runs over MCP, where a refusal naming no scope is the tool's declared failure", async () => {
    const { app, authorized, handlers } = freshRecordingImplementation();

    const mcp = serve(
      ActionMcp.layerHttp(app, {
        name: "test",
        version: "0",
        authentication: TokenScopesLogin,
      }).pipe(Layer.provide(grantTokenListedScopes))
    );

    const readResponse = await mcp.handler(withReadScope(rawToolCall("read")));

    await expect(readResponse.json()).resolves.toMatchObject({
      result: { isError: false, structuredContent: "read ok" },
    });

    const writeResponse = await mcp.handler(
      withReadScope(rawToolCall("write", { value: "x" }))
    );

    await expect(writeResponse.json()).resolves.toMatchObject({
      result: {
        isError: true,
        content: [
          {
            type: "text",
            text: '{"_tag":"Forbidden","message":"Requires write."}',
          },
        ],
      },
    });

    expect(authorized).toStrictEqual(["read", "write"]);
    expect(handlers).toStrictEqual(["read"]);
  });

  it("answers a refusal a client steps up on with its HTTP status under authentication, an authorizer's or a handler's", async () => {
    const needsWrite = new Action.Forbidden({
      message: "Needs write.",
      scopes: ["write"],
    });

    const Gated = Action.make("gated", {
      description: "Refused by its authorizer",
      readOnly: false,
      caller: Caller,
    });

    const Handled = Action.make("handled", {
      description: "Refused by its handler",
      readOnly: false,
      caller: Caller,
    });

    const Plain = Action.make("plain", {
      description: "Refused by its authorizer, naming no scope",
      readOnly: false,
      caller: Caller,
    });

    const app = Action.implement(
      [Gated, Handled, Plain],
      {
        gated: () => Effect.void,
        handled: () => Effect.fail(needsWrite),
        plain: () => Effect.void,
      },
      {
        authorize: (action) =>
          action === Handled
            ? Effect.void
            : Effect.fail(
                action === Gated ? needsWrite : new Action.Forbidden()
              ),
      }
    );

    const web = serve(
      Layer.mergeAll(
        ActionHttp.layer(
          ActionHttp.make([Gated, Handled, Plain], {
            authentication: AnyTokenLogin,
          }),
          app
        ),
        ActionMcp.layerHttp(app, {
          name: "test",
          version: "0",
          authentication: AnyTokenLogin,
        })
      ).pipe(Layer.provide(anyone))
    );

    const calls = [
      post("/api/gated"),
      post("/api/handled"),
      rawToolCall("gated"),
      rawToolCall("handled"),
    ];

    for (const call of calls) {
      const refused = await web.handler(withBearer(call, "x"));

      expect(refused.status).toBe(403);
      expect(refused.headers.get("www-authenticate")).toBe(
        'Bearer error="insufficient_scope", scope="write", error_description="Needs write."'
      );
      await expect(refused.json()).resolves.toStrictEqual(
        Schema.encodeSync(Action.Forbidden)(needsWrite)
      );
    }

    const unscopedRefusal = await web.handler(
      withBearer(post("/api/plain"), "x")
    );

    expect(unscopedRefusal.status).toBe(403);
    expect(unscopedRefusal.headers.get("www-authenticate")).toBeNull();

    const { app: guarded } = freshRecordingImplementation();

    const unauthenticated = await serve(
      ActionMcp.layerHttp(guarded, {
        name: "test",
        version: "0",
        authentication: TokenScopesLogin,
      }).pipe(Layer.provide(grantTokenListedScopes))
    ).handler(withBearer(rawToolCall("read"), "none"));

    expect(unauthenticated.status).toBe(401);
    await expect(unauthenticated.json()).resolves.toStrictEqual(
      Schema.encodeSync(Action.Unauthenticated)(
        new Action.Unauthenticated({ message: "Sign in." })
      )
    );

    const PublicRefusedByHandler = Action.make("open", {
      description: "Refused by its handler, with no authentication",
      readOnly: false,
      caller: Action.Anyone,
    });

    const signIn = new Action.Unauthenticated({ message: "Sign in." });

    const open = await serve(
      ActionHttp.layer(
        ActionHttp.make([PublicRefusedByHandler]),
        Action.implement(PublicRefusedByHandler, () => Effect.fail(needsWrite))
      )
    ).handler(post("/api/open"));

    expect(open.status).toBe(403);
    expect(open.headers.get("www-authenticate")).toBeNull();

    const result = await serve(
      ActionMcp.layerHttp(
        Action.implement(PublicRefusedByHandler, () => Effect.fail(signIn)),
        { name: "test", version: "0" }
      )
    ).handler(rawToolCall("open"));

    expect(result.status).toBe(200);
    await expect(result.json()).resolves.toMatchObject({
      result: {
        isError: true,
        content: [
          {
            type: "text",
            text: JSON.stringify(
              Schema.encodeSync(Action.Unauthenticated)(signIn)
            ),
          },
        ],
      },
    });
  });

  it("keeps each request's step-up refusal its own under concurrent calls", async () => {
    const Allowed = Action.make("allowed", {
      description: "Allowed",
      readOnly: true,
      caller: Caller,
    });

    const Refused = Action.make("refused", {
      description: "Refused",
      readOnly: false,
      caller: Caller,
    });

    const app = Action.implement(
      [Allowed, Refused],
      { allowed: () => Effect.sleep("1 millis"), refused: () => Effect.void },
      {
        authorize: (action) =>
          action === Refused
            ? Effect.fail(new Action.Forbidden({ scopes: ["write"] }))
            : Effect.void,
      }
    );

    const web = serve(
      Layer.mergeAll(
        ActionHttp.layer(
          ActionHttp.make([Allowed, Refused], {
            authentication: AnyTokenLogin,
          }),
          app
        ),
        ActionMcp.layerHttp(app, {
          name: "test",
          version: "0",
          authentication: AnyTokenLogin,
        })
      ).pipe(Layer.provide(anyone))
    );

    const calls = Array.from({ length: 25 }).flatMap(
      (): ReadonlyArray<readonly [Request, number]> => [
        [post("/api/allowed"), 200],
        [post("/api/refused"), 403],
        [rawToolCall("allowed"), 200],
        [rawToolCall("refused"), 403],
      ]
    );

    const statuses = await Promise.all(
      calls.map(async ([call]) => {
        const response = await web.handler(withBearer(call, "x"));

        return response.status;
      })
    );

    expect(statuses).toStrictEqual(calls.map(([, status]) => status));
  });

  it("answers a handler's step-up refusal as a tool result once its call has streamed", async () => {
    const Reporting = Action.make("reporting", {
      description: "Reports progress, then refuses",
      readOnly: false,
      caller: Caller,
    });

    const responseStarted = Latch.makeUnsafe();

    const app = Action.implement(
      Reporting,
      () =>
        Effect.gen(function* () {
          const server = yield* McpServer.McpServer;

          yield* server.notifications["notifications/progress"]({
            progressToken: "call",
            progress: 1,
          });

          yield* responseStarted.await;

          return yield* new Action.Forbidden({ scopes: ["write"] });
        }),
      { authorize: Action.allowAll }
    );

    const mcp = serve(
      ActionMcp.layerHttp(app, {
        name: "test",
        version: "0",
        authentication: AnyTokenLogin,
      }).pipe(Layer.provide(anyone))
    );

    const reply = await mcp.handler(
      mcpRequest({
        method: "tools/call",
        params: {
          name: "reporting",
          arguments: {},
          _meta: { progressToken: "call" },
        },
        headers: { authorization: "Bearer x" },
      })
    );

    expect(reply.status).toBe(200);
    expect(reply.headers.get("www-authenticate")).toBeNull();
    responseStarted.openUnsafe();

    const text = await reply.text();
    expect(text).toContain('"method":"notifications/progress"');
    expect(text).toContain('"isError":true');
    expect(text).toContain(String.raw`\"_tag\":\"Forbidden\"`);
  });

  it.effect("runs over the native Toolkit", () =>
    Effect.gen(function* () {
      const { app, authorized, handlers } = freshRecordingImplementation();

      const binding = ActionToolkit.make(app);

      const call = (name: "read" | "write") =>
        Effect.gen(function* () {
          const tools = yield* binding.toolkit;

          return yield* Stream.runCollect(
            yield* tools.handle(name, name === "write" ? { value: "x" } : {})
          );
        }).pipe(Effect.provide(Layer.provideMerge(binding.layer, readOnly)));

      expect(yield* call("read")).toMatchObject([
        { isFailure: false, result: "read ok" },
      ]);

      const refused = yield* call("write");
      const refusal = new Action.Forbidden({ message: "Requires write." });

      expect(refused).toMatchObject([
        {
          isFailure: true,
          result: refusal,
          encodedResult: yield* Schema.encodeEffect(Action.Forbidden)(refusal),
        },
      ]);
      expect(refused[0]?.result).toBeInstanceOf(Action.Forbidden);

      expect(authorized).toStrictEqual(["read", "write"]);
      expect(handlers).toStrictEqual(["read"]);
    })
  );

  it.effect(
    "runs over the CLI, so a local caller supplies its services too",
    () =>
      Effect.gen(function* () {
        const { app, authorized, handlers } = freshRecordingImplementation();

        const { exit: read, stdout: output } = yield* run(
          ActionCli.command(app, Read),
          []
        );

        expect(read._tag).toBe("Success");
        expect(output).toStrictEqual(['"read ok"']);

        const { exit: refused } = yield* run(ActionCli.command(app, Write), [
          "--value",
          "x",
        ]);

        expect(causeOf(refused)).toBeInstanceOf(Action.Forbidden);

        expect(authorized).toStrictEqual(["read", "write"]);
        expect(handlers).toStrictEqual(["read"]);
      })
  );

  it("is bound per implementation, so implementations without it skip it", async () => {
    const authorized: string[] = [];
    const handlers: string[] = [];

    const record = (name: string) =>
      Effect.sync(() => {
        handlers.push(name);

        return `${name} ok`;
      });

    const read = Action.implement(Read, () => record("read"), {
      authorize: Action.allowAll,
    });

    const write = Action.implement(Write, () => record("write"), {
      authorize: authorize(authorized),
    });

    const web = serve(
      ActionHttp.layer(Http, [read, write]).pipe(
        Layer.provide(grantTokenListedScopes)
      )
    );

    const readResponse = await web.handler(withReadScope(post("/api/read")));

    expect(readResponse.status).toBe(200);

    const writeResponse = await web.handler(
      withReadScope(post("/api/write", { value: "x" }))
    );

    expect(writeResponse.status).toBe(403);
    expect(authorized).toStrictEqual(["write"]);
    expect(handlers).toStrictEqual(["read"]);
  });

  it("never runs for a public action, even beside protected ones in one implementation", async () => {
    const authorized: string[] = [];

    const Status = Action.make("status", {
      description: "Answer anyone",
      readOnly: true,
      caller: Action.Anyone,
      success: Schema.String,
    });

    const app = Action.implement(
      [Status, Read],
      {
        status: () => Effect.succeed("up"),
        read: () => Effect.succeed("read ok"),
      },
      { authorize: authorize(authorized) }
    );

    const web = serve(
      ActionHttp.layer(
        ActionHttp.make([Status, Read], { authentication: TokenScopesLogin }),
        app
      ).pipe(Layer.provide(grantTokenListedScopes))
    );

    const statusResponse = await web.handler(post("/api/status"));

    await expect(statusResponse.json()).resolves.toBe("up");
    expect(authorized).toStrictEqual([]);

    const readResponse = await web.handler(withReadScope(post("/api/read")));

    await expect(readResponse.json()).resolves.toBe("read ok");
    expect(authorized).toStrictEqual(["read"]);
  });

  it.effect.each([
    [new Action.Unauthenticated(), 401, 'Bearer error="invalid_token"'],
    [new Action.Forbidden({ message: "Requires write." }), 403, undefined],
  ] as const)(
    "answers its %s over HTTP with its status, and to the client",
    ([refusal, status, challenge]) =>
      Effect.gen(function* () {
        const response = yield* send(
          withReadScope(post("/api/write", { value: "x" }))
        );

        expect(response.status).toBe(status);
        expect(yield* response.json).toStrictEqual(
          yield* Schema.encodeEffect(Action.Refusal)(refusal)
        );
        expect(response.headers["www-authenticate"]).toBe(challenge);

        const client = yield* ActionHttp.client(Http, as("read"));

        expect(yield* Effect.flip(client.write({ value: "x" }))).toStrictEqual(
          refusal
        );
      }).pipe(
        Effect.provide(
          Testing.layer(
            ActionHttp.layer(
              Http,
              Action.implement(Write, ({ value }) => Effect.succeed(value), {
                authorize: () => Effect.fail(refusal),
              })
            ).pipe(Layer.provide(grantTokenListedScopes))
          )
        )
      )
  );
});

describe("a trusted local caller", () => {
  interface RemoteActor {
    readonly id: string;
    readonly role: "reader" | "writer";
  }

  interface TrustedActor {
    readonly id: string;
    readonly role: "trusted-admin";
  }

  class Actor extends Context.Service<Actor, RemoteActor | TrustedActor>()(
    "access-test/Actor"
  ) {}

  const Rename = Action.make("renameUser", {
    description: "Rename a user",
    readOnly: false,
    caller: Actor,
    input: { name: Schema.String },
    success: { name: Schema.String, caller: Schema.String },
  });

  const authorizeActor = (action: Action.Any) =>
    Effect.gen(function* () {
      const actor = yield* Actor;

      if (actor.role === "trusted-admin") {
        return;
      }

      if (!action.readOnly && actor.role !== "writer") {
        return yield* new Action.Forbidden({ scopes: ["users:write"] });
      }
    });

  const adminCliRecordingRenames = () => {
    const calls: string[] = [];

    const app = Action.implement(
      Rename,
      ({ name }) =>
        Effect.map(Actor, ({ id }) => {
          calls.push(id);

          return { name, caller: id };
        }),
      { authorize: authorizeActor }
    );

    const admin: TrustedActor = { id: "maintenance", role: "trusted-admin" };

    const command = ActionCli.make(app, {
      name: "admin",
      actions: [Rename],
    }).pipe(Command.provideSync(Actor, admin));

    return { calls, command };
  };

  it.effect(
    "passes the same authorizer and handlers, with no policy override",
    () =>
      Effect.gen(function* () {
        const { calls, command } = adminCliRecordingRenames();

        const { exit, stdout } = yield* printed(
          exec(command, ["rename-user", "--name", "Admin"])
        );

        expect(exit._tag).toBe("Success");
        expect(stdout.join("\n")).toContain('"caller": "maintenance"');
        expect(calls).toStrictEqual(["maintenance"]);
      })
  );
});
