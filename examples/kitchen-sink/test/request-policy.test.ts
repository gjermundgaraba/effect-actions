import { afterAll, describe, expect, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { HttpRouter, HttpServer } from "effect/http";
import * as ActionHttp from "@gjermundgaraba/effect-actions/ActionHttp";
import * as Testing from "@gjermundgaraba/effect-actions/Testing";
import { Http } from "../src/Api.js";
import { memory } from "../src/memory.js";
import { adminRoutes, publicRoutes } from "../src/routes.js";

// Each port as a web handler, `Request` in and `Response` out: what a platform without
// Effect's server runs, and what a test sends raw requests to. A handler builds its routes
// once; the test owns it, and disposes it when done.
const web = HttpRouter.toWebHandler(
  publicRoutes.pipe(Layer.provide(HttpServer.layerServices), Layer.provide(memory)),
);

const adminWeb = HttpRouter.toWebHandler(
  adminRoutes.pipe(Layer.provide(HttpServer.layerServices), Layer.provide(memory)),
);

afterAll(() => Promise.all([web.dispose(), adminWeb.dispose()]));

const post = (url: string, headers: Record<string, string> = {}) =>
  new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: "{}",
  });

const discovery = "/.well-known/oauth-protected-resource/mcp";

describe("the request policy", () => {
  it("refuses a foreign Host or Origin", async () => {
    const foreignHost = await web.handler(post("http://tracker.evil.example/api/v1/getStatus"));

    const foreignOrigin = await web.handler(
      post("http://localhost/api/v1/getStatus", { origin: "http://evil.example" }),
    );

    expect([foreignHost.status, await foreignHost.text()]).toEqual([403, "Host not allowed"]);
    expect([foreignOrigin.status, await foreignOrigin.text()]).toEqual([403, "Origin not allowed"]);
  });

  it("runs before authentication: a foreign Host is refused, not asked to sign in", async () => {
    const signedOut = await web.handler(post("http://localhost/api/v1/whoAmI"));
    const foreignHost = await web.handler(post("http://tracker.evil.example/api/v1/whoAmI"));

    expect([signedOut.status, foreignHost.status]).toEqual([401, 403]);
    expect(foreignHost.headers.get("www-authenticate")).toBeNull();
  });

  it("runs before the discovery the Bearer provider publishes", async () => {
    const read = (url: string, headers: Record<string, string> = {}) =>
      web.handler(new Request(url, { headers }));

    const here = await read(`http://localhost${discovery}`);
    const foreignHost = await read(`http://tracker.evil.example${discovery}`);

    const foreignOrigin = await read(`http://localhost${discovery}`, {
      origin: "http://evil.test",
    });

    expect([here.status, foreignHost.status, foreignOrigin.status]).toEqual([200, 403, 403]);
  });

  it("answers the browser MCP client's origin, and its CORS preflight", async () => {
    const allowed = await web.handler(
      post("http://localhost/api/v1/getStatus", { origin: "http://localhost:6274" }),
    );

    const preflight = await web.handler(
      new Request("http://localhost/mcp", {
        method: "OPTIONS",
        headers: {
          origin: "http://localhost:6274",
          "access-control-request-method": "POST",
          "access-control-request-headers": "authorization, mcp-protocol-version",
        },
      }),
    );

    expect(allowed.status).toBe(200);
    expect(allowed.headers.get("access-control-allow-origin")).toBe("http://localhost:6274");
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-headers")).toContain("MCP-Protocol-Version");
    expect(allowed.headers.get("access-control-expose-headers")).toContain("Mcp-Session-Id");
  });

  it("lets a browser client of an MCP revision with sessions end its session", async () => {
    const preflight = await web.handler(
      new Request("http://localhost/mcp", {
        method: "OPTIONS",
        headers: {
          origin: "http://localhost:6274",
          "access-control-request-method": "DELETE",
          "access-control-request-headers": "authorization, mcp-session-id",
        },
      }),
    );

    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-methods")).toContain("DELETE");
    expect(preflight.headers.get("access-control-allow-headers")).toContain("Mcp-Session-Id");
  });

  it("covers the admin port too, a valid key included", async () => {
    const key = { "x-operator-key": "ops-key" };
    const here = await adminWeb.handler(post("http://localhost/admin/listWorkspaces", key));

    const foreignHost = await adminWeb.handler(
      post("http://tracker.evil.example/admin/listWorkspaces", key),
    );

    expect([here.status, foreignHost.status]).toEqual([200, 403]);
  });

  // `Testing.layer(handler)` gives the typed clients the same handler the raw requests hit.
  it.effect("leaves the typed client, served from the same web handler, alone", () =>
    Effect.gen(function* () {
      const client = yield* ActionHttp.client(Http);

      expect(yield* client.getStatus()).toMatchObject({ service: "tracker", workspaces: 2 });
    }).pipe(Effect.provide(Testing.layer(web.handler))),
  );
});
