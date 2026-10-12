import { describe, expect, it } from "@effect/vitest";
import { Array, Effect, flow, Layer } from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";
import { RpcClient, RpcSerialization, RpcServer } from "effect/rpc";
import * as Action from "@gjermundgaraba/effect-actions/Action";
import * as ActionHttp from "@gjermundgaraba/effect-actions/ActionHttp";
import * as ActionRpc from "@gjermundgaraba/effect-actions/ActionRpc";
import * as Testing from "@gjermundgaraba/effect-actions/Testing";
import { Http } from "../../src/Api.js";
import { QuotaExceeded } from "../../src/identity/Identity.js";
import { memory } from "../../src/memory.js";
import { publicRoutes, rpc } from "../../src/routes.js";
import { Rpc } from "../../src/Rpc.js";
import { WorkspaceRegistry } from "../../src/workspaces/registry.js";

// The web app's rpcs in memory. The server serves them over a WebSocket; here the same layer
// is given Effect's HTTP protocol, which a client reaches through `Testing.layer`.
const server = rpc.pipe(
  Layer.provide(RpcServer.layerProtocolHttp({ path: "/rpc" })),
  Layer.provide(RpcSerialization.layerJson),
);

const socket = RpcClient.layerProtocolHttp({ url: "/rpc" }).pipe(
  Layer.provide(RpcSerialization.layerJson),
  Layer.provide(Testing.layer(server)),
);

// `provideMerge`: the test reads the registry the rpcs' verifier reads.
const served = socket.pipe(Layer.provideMerge(memory));

// The socket beside the public port's routes, as on the server, over one set of services.
const servedWithHttp = Layer.merge(socket, Testing.layer(publicRoutes)).pipe(Layer.provide(memory));

// Each call carries its caller's session cookie, as a browser attaches it, so one client
// serves several callers. Authentication is per message.
const as = (session: string) => RpcClient.withHeaders({ cookie: `tracker_session=${session}` });

describe("a session cookie, over RPC", () => {
  it.effect("authenticates each message", () =>
    Effect.gen(function* () {
      const client = yield* ActionRpc.client(Rpc);
      const issue = yield* client.createIssue({ title: "Crash", body: "" }).pipe(as("ada-at-acme"));

      expect(issue.id).toBe("ACME-1");
      expect(yield* client.whoAmI().pipe(as("grace-at-globex"))).toMatchObject({
        workspace: "globex",
      });
      expect(yield* client.listIssues().pipe(as("grace-at-globex"))).toEqual({ issues: [] });
    }).pipe(Effect.scoped, Effect.provide(served)),
  );

  it.effect("fails a call without a session, or with an unknown one, as a typed refusal", () =>
    Effect.gen(function* () {
      const client = yield* ActionRpc.client(Rpc);

      expect(yield* Effect.flip(client.whoAmI())).toBeInstanceOf(Action.Unauthenticated);

      const unknown = yield* Effect.flip(client.whoAmI().pipe(as("stolen")));

      expect(unknown).toBeInstanceOf(Action.Unauthenticated);
      expect(unknown.message).toBe("Unknown demo session.");
    }).pipe(Effect.scoped, Effect.provide(served)),
  );

  it.effect("is refused once its workspace is suspended, as a token is", () =>
    Effect.gen(function* () {
      const client = yield* ActionRpc.client(Rpc);
      const registry = yield* WorkspaceRegistry;

      yield* registry.setSuspended("acme", true);

      const refused = yield* Effect.flip(client.whoAmI().pipe(as("ada-at-acme")));

      expect(refused).toBeInstanceOf(Action.Forbidden);
      expect(refused.message).toBe("This workspace is suspended.");
      expect(yield* client.whoAmI().pipe(as("grace-at-globex"))).toMatchObject({ id: "grace" });
    }).pipe(Effect.scoped, Effect.provide(served)),
  );

  it.effect("spends the one request quota its member also spends over HTTP", () =>
    Effect.gen(function* () {
      const rpcs = yield* ActionRpc.client(Rpc);

      const http = yield* ActionHttp.client(Http, {
        transformClient: HttpClient.mapRequest(
          flow(
            HttpClientRequest.bearerToken("ada"),
            HttpClientRequest.setHeader("x-workspace", "acme"),
          ),
        ),
      });

      // Sixty requests as ada in acme, half on each surface: each middleware counts, and the
      // next request is refused on either.
      yield* Effect.forEach(Array.range(1, 30), () => http.whoAmI());
      yield* Effect.forEach(Array.range(1, 30), () => rpcs.whoAmI().pipe(as("ada-at-acme")));

      expect(yield* Effect.flip(rpcs.whoAmI().pipe(as("ada-at-acme")))).toBeInstanceOf(
        QuotaExceeded,
      );
      expect(yield* Effect.flip(http.whoAmI())).toBeInstanceOf(QuotaExceeded);
    }).pipe(Effect.scoped, Effect.provide(servedWithHttp)),
  );
});
