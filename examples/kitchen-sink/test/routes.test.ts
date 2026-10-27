import { describe, expect, it } from "@effect/vitest";
import * as Action from "@gjermundgaraba/effect-actions/Action";
import * as ActionHttp from "@gjermundgaraba/effect-actions/ActionHttp";
import * as ActionMcp from "@gjermundgaraba/effect-actions/ActionMcp";
import * as Testing from "@gjermundgaraba/effect-actions/Testing";
import { Effect, flow, Layer } from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";

import { Tools } from "../src/Actions.js";
import { AdminHttp, Http } from "../src/Api.js";
import { adminRoutes, builders, publicRoutes } from "../src/routes.js";
import { services } from "./support/services.js";

// The host's surfaces, as routes.ts builds them, answering in memory: no port is opened. Each
// port is a `Testing.layer` of its own, and what they share is provided above both, as
// server.ts does.
const shared = builders.pipe(Layer.provideMerge(services()));

const onPublicPort = Effect.provide(Testing.layer(publicRoutes));

const onAdminPort = Effect.provide(Testing.layer(adminRoutes));

const ada = {
  transformClient: HttpClient.mapRequest(
    flow(
      HttpClientRequest.bearerToken("ada"),
      HttpClientRequest.setHeader("x-workspace", "acme")
    )
  ),
};

const ops = {
  transformClient: HttpClient.mapRequest(
    HttpClientRequest.setHeader("x-operator-key", "ops-key")
  ),
};

const post = (path: string) =>
  HttpClient.execute(
    HttpClientRequest.post(path).pipe(HttpClientRequest.bodyJsonUnsafe({}))
  );

const from = (url: string, origin: string) =>
  HttpClient.execute(
    ActionMcp.request("tools/list", {}, { url, headers: { origin } })
  );

describe("the public port", () => {
  it.effect(
    "answers the public action without a token and refuses the rest",
    () =>
      Effect.gen(function* () {
        const anyone = yield* ActionHttp.client(Http);

        expect(yield* anyone.getStatus()).toMatchObject({
          service: "tracker",
          workspaces: 2,
        });
        expect(yield* Effect.flip(anyone.whoAmI())).toBeInstanceOf(
          Action.Unauthenticated
        );
      }).pipe(onPublicPort, Effect.provide(shared))
  );

  it.effect(
    "lists the tools to a signed-out MCP client, the unlisted action left out",
    () =>
      Effect.gen(function* () {
        const listing = yield* HttpClient.execute(
          ActionMcp.request("tools/list")
        );

        const text = yield* listing.text;

        expect(listing.status).toBe(200);
        expect(text).toContain('"name":"createIssue"');
        expect(text).not.toContain('"name":"attachImage"');
      }).pipe(onPublicPort, Effect.provide(shared))
  );

  it.effect(
    "serves one store to both surfaces: an issue filed over HTTP is read as a tool",
    () =>
      Effect.gen(function* () {
        const http = yield* ActionHttp.client(Http, ada);
        const mcp = yield* ActionMcp.client(Tools, ada);

        const issue = yield* http.createIssue({
          title: "Crash",
          body: "On save.",
        });

        expect(yield* mcp.getIssue({ id: issue.id })).toStrictEqual(issue);
      }).pipe(onPublicPort, Effect.provide(shared))
  );

  it.effect(
    "refuses, at the MCP endpoint, a page of this host that is not on its list",
    () =>
      Effect.gen(function* () {
        // The request policy lets both through: one is the request's own origin, one is listed.
        const listed = yield* from("/mcp", "http://localhost:6274");

        const sameHost = yield* from(
          "http://127.0.0.1/mcp",
          "http://127.0.0.1"
        );

        expect([listed.status, sameHost.status]).toStrictEqual([200, 403]);
      }).pipe(onPublicPort, Effect.provide(shared))
  );
});

describe("the two ports", () => {
  it.effect("serve each audience its own routes, and none of the other's", () =>
    Effect.gen(function* () {
      const admin = yield* post("/admin/listWorkspaces").pipe(onPublicPort);
      const member = yield* post("/api/v1/whoAmI").pipe(onAdminPort);

      expect([admin.status, member.status]).toStrictEqual([404, 404]);
    }).pipe(Effect.provide(shared))
  );

  it.effect("run a builder once for an implementation both serve", () =>
    Effect.gen(function* () {
      const onPublic = yield* Effect.flatMap(
        ActionHttp.client(Http),
        (client) => client.getStatus()
      ).pipe(onPublicPort);

      const onAdmin = yield* Effect.flatMap(
        ActionHttp.client(AdminHttp),
        (client) => client.getStatus()
      ).pipe(onAdminPort);

      // `status`'s builder names the start it ran in. With `builders` above both ports it ran
      // once. Provide `memory` alone instead, and each port runs it: two instances.
      expect(onAdmin.instance).toBe(onPublic.instance);
    }).pipe(Effect.provide(shared))
  );

  it.effect(
    "share their services: a workspace suspended on one is refused on the other",
    () =>
      Effect.gen(function* () {
        const whoAmI = Effect.flatMap(ActionHttp.client(Http, ada), (client) =>
          client.whoAmI()
        );

        expect(yield* whoAmI.pipe(onPublicPort)).toMatchObject({ id: "ada" });

        const suspended = yield* Effect.flatMap(
          ActionHttp.client(AdminHttp, ops),
          (client) => client.suspendWorkspace({ workspace: "acme" })
        ).pipe(onAdminPort);

        expect(suspended).toStrictEqual({
          slug: "acme",
          name: "Acme",
          suspended: true,
        });

        const refused = yield* Effect.flip(whoAmI).pipe(onPublicPort);

        expect(refused).toBeInstanceOf(Action.Forbidden);
        expect(refused.message).toBe("This workspace is suspended.");
      }).pipe(Effect.provide(shared))
  );
});
