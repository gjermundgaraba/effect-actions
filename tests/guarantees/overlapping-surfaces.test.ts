import { expect, it } from "@effect/vitest";
import { Effect, Layer, Stream } from "effect";
import * as Action from "../../src/contract/Action.js";
import * as ActionHttp from "../../src/http/ActionHttp.js";
import * as ActionMcp from "../../src/mcp/ActionMcp.js";
import * as ActionToolkit from "../../src/toolkit/ActionToolkit.js";
import { authenticate } from "../../examples/authentication.js";
import { actors, authorize, CurrentActor } from "../../examples/authorization.js";
import { Http, Login } from "../../examples/binding.js";
import {
  Double,
  GetUser,
  ListChanges,
  RenameUser,
  Status,
  UserNotFound,
  WhoAmI,
} from "../../examples/contracts.js";
import { post, rawToolCall, valueOf, withBearer } from "../support/requests.js";
import { serve } from "../support/serve.js";

const makeApp = () => {
  let builds = 0;

  const app = Action.implement(
    [Status, GetUser, RenameUser, WhoAmI, ListChanges, Double],
    Effect.sync(() => {
      builds++;
      const names = new Map([["1", "Ada"]]);
      const changes: Array<{ actorId: string; userId: string; name: string }> = [];

      return {
        status: () => Effect.sync(() => ({ service: "overlap", users: names.size })),
        getUser: ({ id }) => {
          const name = names.get(id);

          return name === undefined
            ? Effect.fail(new UserNotFound({ id }))
            : Effect.succeed({ id, name });
        },
        renameUser: ({ id, name }) =>
          Effect.map(CurrentActor, (actor) => {
            names.set(id, name);
            changes.push({ actorId: actor.id, userId: id, name });

            return { id, name };
          }),
        whoAmI: () => Effect.map(CurrentActor, ({ id, tenantId }) => ({ id, tenantId })),
        listChanges: () => Effect.sync(() => ({ changes: [...changes] })),
        double: ({ value }) => Effect.succeed(value * 2),
      };
    }),
    { authorize },
  );

  const routes = Layer.mergeAll(
    ActionHttp.layer(Http, app),
    ActionMcp.layerHttp(app, {
      name: "overlap",
      version: "0",
      actions: [Status, RenameUser, ListChanges, Double],
      authentication: Login,
    }),
  ).pipe(Layer.provide(authenticate));

  const tools = ActionToolkit.make(app, { actions: [GetUser, RenameUser, Double] });

  return { routes, tools, builds: () => builds };
};

it("keeps one store for overlapping HTTP and MCP selections, serving neither what it leaves out and protecting an action that reads no identity", async () => {
  const fixture = makeApp();
  const web = serve(fixture.routes);

  const renamed = await web.handler(
    withBearer(post("/api/renameUser", { id: "1", name: "Bea" }), "alice"),
  );

  expect(renamed.status).toBe(200);
  expect(await valueOf(await web.handler(withBearer(rawToolCall("listChanges"), "alice")))).toEqual(
    { changes: [{ actorId: "alice", userId: "1", name: "Bea" }] },
  );

  expect((await web.handler(withBearer(post("/api/listChanges"), "alice"))).status).toBe(404);
  expect(
    await (await web.handler(withBearer(rawToolCall("getUser", { id: "1" }), "alice"))).json(),
  ).toMatchObject({ error: { code: -32602 } });
  expect((await web.handler(post("/api/double", { value: "21" }))).status).toBe(401);
  expect(
    await (await web.handler(withBearer(post("/api/double", { value: "21" }), "reader"))).json(),
  ).toBe(42);
  expect(fixture.builds()).toBe(1);
});

it("runs one builder for HTTP, MCP and a Toolkit job in one layer graph", async () => {
  const fixture = makeApp();

  const job = Layer.effectDiscard(
    Effect.gen(function* () {
      const tools = yield* fixture.tools.toolkit;
      yield* Stream.runDrain(yield* tools.handle("renameUser", { id: "1", name: "Toolkit" }));
    }).pipe(Effect.provideService(CurrentActor, actors.alice)),
  ).pipe(Layer.provide(fixture.tools.layer));

  const web = serve(Layer.merge(fixture.routes, job));

  expect(
    await (await web.handler(withBearer(post("/api/getUser", { id: "1" }), "reader"))).json(),
  ).toEqual({ id: "1", name: "Toolkit" });
  expect(
    await valueOf(await web.handler(withBearer(rawToolCall("listChanges"), "reader"))),
  ).toEqual({ changes: [{ actorId: "alice", userId: "1", name: "Toolkit" }] });
  expect(fixture.builds()).toBe(1);
});
