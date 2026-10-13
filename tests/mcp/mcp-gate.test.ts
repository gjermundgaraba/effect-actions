import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer, Option, Schema } from "effect";
import { Base64 } from "effect/encoding";
import { McpServer } from "effect/ai";
import { HttpRouter } from "effect/http";
import * as Action from "../../src/contract/Action.js";
import * as ActionMcp from "../../src/mcp/ActionMcp.js";
import { authenticate } from "../support/app/authentication.js";
import { authorize, CurrentActor } from "../support/app/authorization.js";
import { Login } from "../support/app/binding.js";
import { Double, RenameUser, Status } from "../support/app/contracts.js";
import {
  endSession,
  initializeParams,
  mcpRequest,
  rawToolCall,
  sessionRequest,
  valueOf,
  withBearer,
} from "../support/requests.js";
import { serve } from "../support/serve.js";

const makeExampleAppRecordingCalls = () => {
  const calls: Array<string> = [];

  const app = Action.implement(
    [Status, RenameUser, Double],
    {
      status: () => Effect.succeed({ service: "gate", users: 1 }),
      renameUser: ({ id, name }) =>
        Effect.map(CurrentActor, (actor) => {
          calls.push(`${actor.id} renamed ${id}`);

          return { id, name };
        }),
      double: ({ value }) => Effect.sync(() => (calls.push("double"), value * 2)),
    },
    { authorize },
  );

  return { app, calls };
};

const mixedEndpoint = (features?: Layer.Layer<never>) => {
  const { app, calls } = makeExampleAppRecordingCalls();

  const web = serve(
    ActionMcp.layerHttp(app, {
      name: "gate",
      version: "0",
      authentication: Login,
      ...(features === undefined ? {} : { features }),
    }).pipe(Layer.provide(authenticate)),
  );

  return { web, calls };
};

describe("a mixed MCP endpoint", () => {
  it("admits a signed-out caller's public call, and answers a protected tool's call with the 401 a client signs in on", async () => {
    const { web, calls } = mixedEndpoint();

    expect(await valueOf(await web.handler(rawToolCall("status")))).toEqual({
      service: "gate",
      users: 1,
    });

    const identityFreeRefused = await web.handler(rawToolCall("double", { value: "21" }));
    expect(identityFreeRefused.status).toBe(401);
    expect(identityFreeRefused.headers.get("www-authenticate")).toContain("resource_metadata");
    expect(
      Schema.decodeUnknownSync(Action.Unauthenticated)(await identityFreeRefused.json()),
    ).toBeInstanceOf(Action.Unauthenticated);
    expect(calls).toEqual([]);

    expect(
      await valueOf(
        await web.handler(withBearer(rawToolCall("double", { value: "21" }), "reader")),
      ),
    ).toBe(42);

    const publicCallWithUnverifiedCredential = withBearer(rawToolCall("status"), "forged");
    expect((await web.handler(publicCallWithUnverifiedCredential)).status).toBe(401);

    const publicCallWithEmptyCredential = rawToolCall("status");
    publicCallWithEmptyCredential.headers.set("authorization", "Bearer");
    expect((await web.handler(publicCallWithEmptyCredential)).status).toBe(200);

    const stepUpForScope = await web.handler(
      withBearer(rawToolCall("renameUser", { id: "1", name: "X" }), "reader"),
    );

    expect(stepUpForScope.status).toBe(403);
    expect(stepUpForScope.headers.get("www-authenticate")).toContain('scope="users:write"');
    expect(calls).toEqual(["double"]);
  });

  it("reads a base64-encoded Mcp-Name as the runtime routes it: a public call is admitted signed out, a protected one refused, also under a public name", async () => {
    const { web, calls } = mixedEndpoint();

    const named = (request: Request, name: string) => {
      request.headers.set("mcp-name", `=?base64?${Base64.encode(name)}?=`);

      return request;
    };

    expect(await valueOf(await web.handler(named(rawToolCall("status"), "status")))).toEqual({
      service: "gate",
      users: 1,
    });

    const protectedCall = named(rawToolCall("double", { value: "21" }), "double");
    expect((await web.handler(protectedCall)).status).toBe(401);

    const publicNameOverProtectedCall = named(rawToolCall("double", { value: "21" }), "status");
    expect((await web.handler(publicNameOverProtectedCall)).status).toBe(400);
    expect(calls).toEqual([]);
  });

  it("never gives a public tool an identity, though its request presents a valid credential", async () => {
    const Whoever = Action.make("whoever", {
      description: "Whether the call has a caller",
      readOnly: true,
      caller: Action.Anyone,
      success: Schema.Boolean,
    });

    const whoever = Action.implement(Whoever, () =>
      Effect.map(Effect.serviceOption(CurrentActor), Option.isSome),
    );

    const { app } = makeExampleAppRecordingCalls();

    const web = serve(
      ActionMcp.layerHttp([app, whoever], {
        name: "gate",
        version: "0",
        authentication: Login,
      }).pipe(Layer.provide(authenticate)),
    );

    expect(await valueOf(await web.handler(withBearer(rawToolCall("whoever"), "reader")))).toBe(
      false,
    );
    expect(await valueOf(await web.handler(rawToolCall("whoever")))).toBe(false);
  });

  it("answers a public tool's step-up refusal as its result, signed in or not, as HTTP does", async () => {
    const Peek = Action.make("peek", {
      description: "Peek",
      readOnly: true,
      caller: Action.Anyone,
    });

    const peeking = Action.implement(Peek, () =>
      Effect.fail(new Action.Forbidden({ message: "Needs read.", scopes: ["users:read"] })),
    );

    const web = serve(
      ActionMcp.layerHttp([peeking, makeExampleAppRecordingCalls().app], {
        name: "gate",
        version: "0",
        authentication: Login,
      }).pipe(Layer.provide(authenticate)),
    );

    for (const request of [rawToolCall("peek"), withBearer(rawToolCall("peek"), "reader")]) {
      const response = await web.handler(request);

      expect([response.status, response.headers.get("www-authenticate")]).toEqual([200, null]);
      expect(await response.json()).toMatchObject({ result: { isError: true } });
    }
  });

  it("lets anyone discover the server and its tools, protected ones included", async () => {
    const { web } = mixedEndpoint();

    for (const method of ["server/discover", "tools/list"]) {
      expect([method, (await web.handler(mcpRequest({ method }))).status]).toEqual([method, 200]);
    }

    const listed = await (await web.handler(mcpRequest({ method: "tools/list" }))).json();
    expect(listed).toMatchObject({
      result: { tools: [{ name: "status" }, { name: "renameUser" }, { name: "double" }] },
    });
  });

  it("refuses a protected tool, prompt or resource before decoding its arguments", async () => {
    const { web, calls } = mixedEndpoint();

    const protectedMalformedArguments = await web.handler(rawToolCall("renameUser", { id: "1" }));

    expect(protectedMalformedArguments.status).toBe(401);
    expect(protectedMalformedArguments.headers.get("www-authenticate")).toContain(
      "resource_metadata",
    );

    const publicMalformedArguments = await web.handler(rawToolCall("status", { unexpected: "x" }));

    const answered = await publicMalformedArguments.text();

    expect(publicMalformedArguments.status).toBe(200);
    expect(JSON.parse(answered)).toMatchObject({ result: { isError: true } });
    expect(answered).toContain("Invalid parameters for tool 'status'");

    const publicHeaderOverProtectedBody = rawToolCall("double", { value: "21" });
    publicHeaderOverProtectedBody.headers.set("mcp-name", "status");
    expect((await web.handler(publicHeaderOverProtectedBody)).status).toBe(400);

    const protectedHeaderOverPublicBody = rawToolCall("status");
    protectedHeaderOverPublicBody.headers.set("mcp-name", "double");
    expect((await web.handler(protectedHeaderOverPublicBody)).status).toBe(401);

    const withoutRoutingName = rawToolCall("status");
    withoutRoutingName.headers.delete("mcp-name");
    expect((await web.handler(withoutRoutingName)).status).toBe(401);

    for (const [method, params] of [
      ["resources/read", { uri: "docs://readme" }],
      ["prompts/get", { name: "intro" }],
    ] as const) {
      expect([method, (await web.handler(mcpRequest({ method, params }))).status]).toEqual([
        method,
        401,
      ]);
    }

    expect(calls).toEqual([]);
  });

  it("authenticates a native feature's listing, completion and subscription", async () => {
    const completed: Array<string> = [];

    const promptCompletingFromAppData = McpServer.prompt({
      name: "customer",
      parameters: { email: Schema.String },
      completion: {
        email: (input: string) =>
          Effect.sync(() => {
            completed.push(input);

            return [`${input}alice@acme.example`];
          }),
      },
      content: ({ email }) => Effect.succeed(`Customer ${email}`),
    });

    const { web } = mixedEndpoint(promptCompletingFromAppData);

    const complete = {
      ref: { type: "ref/prompt", name: "customer" },
      argument: { name: "email", value: "a" },
    };

    for (const [method, params] of [
      ["completion/complete", complete],
      ["prompts/list", {}],
      ["resources/list", {}],
      ["resources/templates/list", {}],
      ["subscriptions/listen", { notifications: { resourceSubscriptions: ["invoice://1"] } }],
    ] as const) {
      const response = await web.handler(mcpRequest({ method, params }));
      expect([method, response.status]).toEqual([method, 401]);
    }

    expect(completed).toEqual([]);

    for (const method of ["server/discover", "tools/list"]) {
      expect([method, (await web.handler(mcpRequest({ method }))).status]).toEqual([method, 200]);
    }

    const signedIn = await web.handler(
      withBearer(mcpRequest({ method: "completion/complete", params: complete }), "alice"),
    );

    expect(signedIn.status).toBe(200);
    expect(completed).toEqual(["a"]);
  });

  it("leaves no body the native runtime skips validating to slip past it", async () => {
    const { web, calls } = mixedEndpoint();
    const rename = { name: "renameUser", arguments: { id: "1", name: "Eve" } };

    const bodiesNativeHeaderValidationSkips = [
      [{ jsonrpc: "2.0", method: "tools/call", params: rename }, { "mcp-name": "status" }, 400],
      [
        { jsonrpc: "2.0", method: "tools/call", params: rename },
        { "mcp-method": "tools/list" },
        401,
      ],
      [
        [{ jsonrpc: "2.0", id: 1, method: "tools/call", params: rename }],
        { "mcp-name": "status" },
        400,
      ],
    ] as const;

    for (const [body, headers, statelessStatus] of bodiesNativeHeaderValidationSkips) {
      for (const withProtocolVersion of [true, false]) {
        const base = rawToolCall("status");
        const sent = new Headers(base.headers);

        for (const [key, value] of Object.entries(headers)) sent.set(key, value);

        if (!withProtocolVersion) sent.delete("mcp-protocol-version");

        const response = await web.handler(
          new Request(base.url, { method: "POST", headers: sent, body: JSON.stringify(body) }),
        );

        expect(response.status).toBe(withProtocolVersion ? statelessStatus : 401);
      }
    }

    for (const method of ["tools/list", "server/discover"]) {
      for (const validatedRequest of [
        rawToolCall("renameUser", rename.arguments),
        mcpRequest({ method: "resources/read", params: { uri: "docs://readme" } }),
      ]) {
        validatedRequest.headers.set("mcp-method", method);

        const response = await web.handler(validatedRequest);

        expect([method, response.status]).toEqual([method, 401]);
      }
    }

    expect(calls).toEqual([]);
  });
});

describe("another HTTP method on a mixed MCP endpoint", () => {
  it("is authenticated first: a 401 signed out, a browser's preflight included, and the 405 signed in", async () => {
    const { web } = mixedEndpoint();

    const sent = (method: string, headers: Record<string, string> = {}) =>
      web.handler(new Request("http://localhost/mcp", { method, headers }));

    const preflight = await sent("OPTIONS", {
      origin: "http://localhost:3000",
      "access-control-request-method": "POST",
    });

    expect([(await sent("GET")).status, (await sent("PUT")).status, preflight.status]).toEqual([
      401, 401, 401,
    ]);
    expect(preflight.headers.get("www-authenticate")).toContain("Bearer");

    const signedIn = await sent("GET", { authorization: "Bearer alice" });

    expect([signedIn.status, signedIn.headers.get("allow"), await signedIn.text()]).toEqual([
      405,
      "POST, DELETE",
      "",
    ]);
  });
});

describe("a browser's preflight to a mixed MCP endpoint behind HttpRouter.cors", () => {
  it("is answered by the CORS layer, signed out, before the endpoint authenticates it", async () => {
    const { app } = makeExampleAppRecordingCalls();

    const web = serve(
      ActionMcp.layerHttp(app, { name: "gate", version: "0", authentication: Login }).pipe(
        Layer.provide(authenticate),
        Layer.provide(HttpRouter.cors({ allowedOrigins: ["http://localhost:3000"] })),
      ),
    );

    const preflight = await web.handler(
      new Request("http://localhost/mcp", {
        method: "OPTIONS",
        headers: { origin: "http://localhost:3000", "access-control-request-method": "POST" },
      }),
    );

    expect([preflight.status, preflight.headers.get("access-control-allow-origin")]).toEqual([
      204,
      "http://localhost:3000",
    ]);
  });
});

describe("a session on a mixed MCP endpoint", () => {
  const publicCallHeaders = {
    "mcp-protocol-version": "2026-07-28",
    "mcp-method": "tools/call",
    "mcp-name": "status",
  };

  const open = async (web: ReturnType<typeof mixedEndpoint>["web"], token: string) => {
    const initialized = await web.handler(
      withBearer(sessionRequest({ method: "initialize", params: initializeParams }), token),
    );

    expect(initialized.status).toBe(200);

    const session = initialized.headers.get("mcp-session-id") ?? "";

    const ready = await web.handler(
      withBearer(sessionRequest({ method: "notifications/initialized", session }), token),
    );

    expect(ready.status).toBe(202);

    return session;
  };

  it("is opened by a signed-in caller alone, whatever a request's headers name", async () => {
    const { web } = mixedEndpoint();

    const signedOut = await web.handler(
      sessionRequest({ method: "initialize", params: initializeParams }),
    );

    expect(signedOut.status).toBe(401);
    expect(signedOut.headers.get("www-authenticate")).toContain("resource_metadata");
    expect(signedOut.headers.get("mcp-session-id")).toBeNull();

    for (const headers of [
      { "mcp-protocol-version": "2026-07-28", "mcp-method": "tools/list" },
      { "mcp-protocol-version": "2026-07-28", "mcp-method": "server/discover" },
      { "mcp-protocol-version": "2026-07-28", "mcp-method": "initialize" },
      publicCallHeaders,
      { "mcp-method": "tools/list" },
    ]) {
      const named = await web.handler(
        sessionRequest({ method: "initialize", params: initializeParams, headers }),
      );

      expect([headers, named.status]).toEqual([headers, 401]);
      expect(named.headers.get("mcp-session-id")).toBeNull();
    }
  });

  it("authenticates its every request, a public tool's call included", async () => {
    const { web, calls } = mixedEndpoint();
    const session = await open(web, "reader");
    const double = { name: "double", arguments: { value: "21" } };

    const signedIn = await web.handler(
      withBearer(sessionRequest({ method: "tools/call", params: double, session }), "reader"),
    );

    expect(await signedIn.json()).toMatchObject({
      result: { content: [{ type: "text", text: "42" }], isError: false },
    });

    for (const method of ["tools/list", "tools/call", "notifications/initialized"]) {
      const params = method === "tools/call" ? { name: "status", arguments: {} } : {};
      const signedOut = await web.handler(sessionRequest({ method, params, session }));

      expect([method, signedOut.status]).toEqual([method, 401]);
    }

    const namingAPublicCall = await web.handler(
      sessionRequest({ method: "tools/call", params: double, session, headers: publicCallHeaders }),
    );

    expect(namingAPublicCall.status).toBe(400);

    const namingItInTheSessionsRevision = await web.handler(
      sessionRequest({
        method: "tools/call",
        params: double,
        session,
        headers: { ...publicCallHeaders, "mcp-protocol-version": "2025-11-25" },
      }),
    );

    expect(namingItInTheSessionsRevision.status).toBe(401);
    expect(calls).toEqual(["double"]);
  });

  it("holds no identity: each request runs as the caller it authenticates", async () => {
    const { web, calls } = mixedEndpoint();
    const session = await open(web, "alice");
    const rename = { name: "renameUser", arguments: { id: "1", name: "Eve" } };

    const asItsOpener = await web.handler(
      withBearer(sessionRequest({ method: "tools/call", params: rename, session }), "alice"),
    );

    const asAnother = await web.handler(
      withBearer(sessionRequest({ method: "tools/call", params: rename, session }), "bob"),
    );

    const asAReader = await web.handler(
      withBearer(sessionRequest({ method: "tools/call", params: rename, session }), "reader"),
    );

    expect(asItsOpener.status).toBe(200);
    expect(asAnother.status).toBe(200);
    expect(asAReader.status).toBe(403);
    expect(asAReader.headers.get("www-authenticate")).toContain('scope="users:write"');
    expect(calls).toEqual(["alice renamed 1", "bob renamed 1"]);
  });

  it("is ended by a signed-in caller alone", async () => {
    const { web } = mixedEndpoint();
    const session = await open(web, "reader");

    expect((await web.handler(endSession(session))).status).toBe(401);

    const namingAPublicCall = endSession(session);

    for (const [key, value] of Object.entries(publicCallHeaders)) {
      namingAPublicCall.headers.set(key, value);
    }

    expect((await web.handler(namingAPublicCall)).status).toBe(401);

    const stillOpen = await web.handler(
      withBearer(sessionRequest({ method: "tools/list", session }), "reader"),
    );

    expect(stillOpen.status).toBe(200);
    expect((await web.handler(withBearer(endSession(session), "reader"))).status).toBe(204);

    const ended = await web.handler(
      withBearer(sessionRequest({ method: "tools/list", session }), "reader"),
    );

    expect(ended.status).toBe(404);
  });
});

describe("an MCP endpoint of protected tools alone", () => {
  it("authenticates every request before decoding it, discovery included", async () => {
    const { app, calls } = makeExampleAppRecordingCalls();

    const web = serve(
      ActionMcp.layerHttp(app, {
        name: "private",
        version: "0",
        actions: [Double],
        authentication: Login,
      }).pipe(Layer.provide(authenticate)),
    );

    const malformed = new Request("http://localhost/mcp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{",
    });

    expect((await web.handler(malformed)).status).toBe(401);
    expect((await web.handler(mcpRequest({ method: "tools/list" }))).status).toBe(401);
    expect(
      (await web.handler(withBearer(mcpRequest({ method: "tools/list" }), "alice"))).status,
    ).toBe(200);
    expect(calls).toEqual([]);
  });
});
