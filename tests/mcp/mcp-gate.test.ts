import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer, Schema } from "effect";
import { McpServer } from "effect/ai";
import * as Action from "../../src/contract/Action.js";
import * as ActionMcp from "../../src/mcp/ActionMcp.js";
import { authenticate } from "../../examples/authentication.js";
import { authorize, CurrentActor } from "../../examples/authorization.js";
import { Login } from "../../examples/binding.js";
import { Double, RenameUser, Status } from "../../examples/contracts.js";
import { mcpRequest, rawToolCall, valueOf, withBearer } from "../support/requests.js";
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

    const base64EncodedPublicName = rawToolCall("status");
    base64EncodedPublicName.headers.set("mcp-name", `=?base64?${btoa("status")}?=`);
    expect((await web.handler(base64EncodedPublicName)).status).toBe(401);

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
      [{ jsonrpc: "2.0", method: "tools/call", params: rename }, { "mcp-name": "status" }],
      [{ jsonrpc: "2.0", method: "tools/call", params: rename }, { "mcp-method": "tools/list" }],
      [[{ jsonrpc: "2.0", id: 1, method: "tools/call", params: rename }], { "mcp-name": "status" }],
    ] as const;

    for (const [body, headers] of bodiesNativeHeaderValidationSkips) {
      for (const withProtocolVersion of [true, false]) {
        const base = rawToolCall("status");
        const sent = new Headers(base.headers);

        for (const [key, value] of Object.entries(headers)) sent.set(key, value);

        if (!withProtocolVersion) sent.delete("mcp-protocol-version");

        const response = await web.handler(
          new Request(base.url, { method: "POST", headers: sent, body: JSON.stringify(body) }),
        );

        expect(response.status).toBe(400);
      }
    }

    for (const method of ["tools/list", "server/discover"]) {
      for (const validatedRequest of [
        rawToolCall("renameUser", rename.arguments),
        mcpRequest({ method: "resources/read", params: { uri: "docs://readme" } }),
      ]) {
        validatedRequest.headers.set("mcp-method", method);

        const response = await web.handler(validatedRequest);

        expect([method, response.status]).toEqual([method, 400]);
        expect(await response.json()).toMatchObject({ error: { code: -32020 } });
      }
    }

    expect(calls).toEqual([]);
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
