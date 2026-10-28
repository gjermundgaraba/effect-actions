import { describe, expect, it } from "@effect/vitest";
import * as Action from "@gjermundgaraba/effect-actions/Action";
import * as ActionHttp from "@gjermundgaraba/effect-actions/ActionHttp";
import * as Testing from "@gjermundgaraba/effect-actions/Testing";
import { Effect, Layer } from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";

import { Operator } from "../../src/admin/Admin.js";
import { Grants } from "../../src/admin/grants.js";
import { admin } from "../../src/admin/handlers.js";
import { AdminHttp } from "../../src/Api.js";
import { memory } from "../../src/memory.js";
import { adminRoutes } from "../../src/routes.js";
import { WorkspaceRegistry } from "../../src/workspaces/registry.js";

const served = Testing.layer(adminRoutes).pipe(Layer.provide(memory));

const key = (operatorKey: string) => ({
  transformClient: HttpClient.mapRequest(
    HttpClientRequest.setHeader("x-operator-key", operatorKey)
  ),
});

describe("the operators", () => {
  it.effect("are authorized by the grants stored for their key", () =>
    Effect.gen(function* () {
      const support = yield* ActionHttp.client(AdminHttp, key("support-key"));
      const ops = yield* ActionHttp.client(AdminHttp, key("ops-key"));

      expect((yield* support.listWorkspaces()).workspaces).toHaveLength(2);

      const refused = yield* Effect.flip(
        support.suspendWorkspace({ workspace: "acme" })
      );

      expect(refused).toBeInstanceOf(Action.Forbidden);
      expect(refused).not.toHaveProperty("scopes");
      expect(refused.message).toBe("Requires the workspaces:suspend grant.");
      expect(yield* ops.suspendWorkspace({ workspace: "acme" })).toMatchObject({
        suspended: true,
      });
    }).pipe(Effect.provide(served))
  );

  it.effect("are not the members: a member's token is no credential here", () =>
    Effect.gen(function* () {
      const member = yield* ActionHttp.client(AdminHttp, {
        transformClient: HttpClient.mapRequest(
          HttpClientRequest.bearerToken("ada")
        ),
      });

      expect(yield* Effect.flip(member.listWorkspaces())).toBeInstanceOf(
        Action.Unauthenticated
      );
    }).pipe(Effect.provide(served))
  );

  it.effect(
    "include the console's trusted operator, admitted by the same rule in process",
    () =>
      Effect.gen(function* () {
        const client = yield* Action.client(admin);
        const suspend = client.suspendWorkspace({ workspace: "globex" });

        expect(
          yield* suspend.pipe(
            Effect.provideService(Operator, { id: "console", trusted: true })
          )
        ).toMatchObject({ suspended: true });
        expect(
          yield* Effect.flip(
            suspend.pipe(
              Effect.provideService(Operator, { id: "intern", trusted: false })
            )
          )
        ).toBeInstanceOf(Action.Forbidden);
      }).pipe(Effect.provide([WorkspaceRegistry.layerMemory, Grants.layerDemo]))
  );
});
