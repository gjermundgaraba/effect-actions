import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer, Schema } from "effect";
import { McpServer } from "effect/ai";
import * as Action from "../src/Action.js";
import * as ActionMcp from "../src/ActionMcp.js";
import { authenticate } from "../examples/authentication.js";
import { authorize, CurrentActor } from "../examples/authorization.js";
import { Login } from "../examples/binding.js";
import { Double, RenameUser, Status } from "../examples/contracts.js";
import { mcpRequest, rawToolCall, valueOf, withBearer } from "./requests.js";
import { serve } from "./serve.js";

/**
 * The example's public `status` and protected `renameUser` and `double`, `double` reading no
 * identity, each recording the calls that reached it.
 */
const makeApp = () => {
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

/** One endpoint at `/mcp` of the public `status` beside protected tools: a mixed endpoint. */
const mixed = (features?: Layer.Layer<never>) => {
  const { app, calls } = makeApp();

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
    const { web, calls } = mixed();

    expect(await valueOf(await web.handler(rawToolCall("status")))).toEqual({
      service: "gate",
      users: 1,
    });

    // A protected tool authenticates whether or not its handler reads the identity.
    const refused = await web.handler(rawToolCall("double", { value: "21" }));
    expect(refused.status).toBe(401);
    expect(refused.headers.get("www-authenticate")).toContain("resource_metadata");
    expect(Schema.decodeUnknownSync(Action.Unauthenticated)(await refused.json())).toBeInstanceOf(
      Action.Unauthenticated,
    );
    expect(calls).toEqual([]);

    expect(
      await valueOf(
        await web.handler(withBearer(rawToolCall("double", { value: "21" }), "reader")),
      ),
    ).toBe(42);

    // A public call presenting a credential is authenticated: one that does not verify is
    // refused. An empty one, which the scheme decodes as none, passes signed out.
    expect((await web.handler(withBearer(rawToolCall("status"), "forged"))).status).toBe(401);

    const empty = rawToolCall("status");
    empty.headers.set("authorization", "Bearer");
    expect((await web.handler(empty)).status).toBe(200);

    // The authorizer's refusal naming a scope is the 403 a client steps up on.
    const forbidden = await web.handler(
      withBearer(rawToolCall("renameUser", { id: "1", name: "X" }), "reader"),
    );

    expect(forbidden.status).toBe(403);
    expect(forbidden.headers.get("www-authenticate")).toContain('scope="users:write"');
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
      ActionMcp.layerHttp([peeking, makeApp().app], {
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
    const { web } = mixed();

    for (const method of ["server/discover", "tools/list"]) {
      expect([method, (await web.handler(mcpRequest({ method }))).status]).toEqual([method, 200]);
    }

    const listed = await (await web.handler(mcpRequest({ method: "tools/list" }))).json();
    expect(listed).toMatchObject({
      result: { tools: [{ name: "status" }, { name: "renameUser" }, { name: "double" }] },
    });
  });

  it("refuses a protected tool, prompt or resource before decoding its arguments", async () => {
    const { web, calls } = mixed();

    // A protected tool's malformed arguments: the 401 the client signs in on, not the native
    // invalid-arguments result, so a signed-out caller learns nothing of its input.
    const malformed = await web.handler(rawToolCall("renameUser", { id: "1" }));

    expect(malformed.status).toBe(401);
    expect(malformed.headers.get("www-authenticate")).toContain("resource_metadata");

    // A public tool's malformed arguments still get the native answer.
    const open = await web.handler(rawToolCall("status", { unexpected: "x" }));

    expect(open.status).toBe(200);
    expect(await open.json()).toMatchObject({ result: { isError: true } });

    // A header naming a public tool over a body naming a protected one: the native runtime
    // refuses the mismatch, and the call never reaches the protected tool.
    const mismatched = rawToolCall("double", { value: "21" });
    mismatched.headers.set("mcp-name", "status");
    expect((await web.handler(mismatched)).status).toBe(400);

    // The other way round, the header decides: a protected name authenticates first.
    const claimed = rawToolCall("status");
    claimed.headers.set("mcp-name", "double");
    expect((await web.handler(claimed)).status).toBe(401);

    // No routing header: it fails closed.
    const unnamed = rawToolCall("status");
    unnamed.headers.delete("mcp-name");
    expect((await web.handler(unnamed)).status).toBe(401);

    // A routing header names a public tool only as it is: an ASCII name Base64-encoded
    // authenticates, as any other value does.
    const encoded = rawToolCall("status");
    encoded.headers.set("mcp-name", `=?base64?${btoa("status")}?=`);
    expect((await web.handler(encoded)).status).toBe(401);

    // Native features are reached by name, so they authenticate on a mixed endpoint too.
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

    // A protected prompt whose completion reads application data.
    const customer = McpServer.prompt({
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

    const { web } = mixed(customer);

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

    // Discovery stays open, and a signed-in caller completes.
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
    const { web, calls } = mixed();
    const rename = { name: "renameUser", arguments: { id: "1", name: "Eve" } };

    // Headers claiming a public tool or discovery, on bodies native header validation does
    // not cover: a notification, a batch, and either without a protocol version.
    for (const [body, headers] of [
      [{ jsonrpc: "2.0", method: "tools/call", params: rename }, { "mcp-name": "status" }],
      [{ jsonrpc: "2.0", method: "tools/call", params: rename }, { "mcp-method": "tools/list" }],
      [[{ jsonrpc: "2.0", id: 1, method: "tools/call", params: rename }], { "mcp-name": "status" }],
    ] as const) {
      for (const version of [true, false]) {
        const base = rawToolCall("status");
        const sent = new Headers(base.headers);

        for (const [key, value] of Object.entries(headers)) sent.set(key, value);

        if (!version) sent.delete("mcp-protocol-version");

        const response = await web.handler(
          new Request(base.url, { method: "POST", headers: sent, body: JSON.stringify(body) }),
        );

        expect(response.status).toBe(400);
      }
    }

    expect(calls).toEqual([]);
  });
});

describe("an MCP endpoint of protected tools alone", () => {
  it("authenticates every request before decoding it, discovery included", async () => {
    const { app, calls } = makeApp();

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
