import { describe, expect, it } from "@effect/vitest";
import * as Action from "@gjermundgaraba/effect-actions/Action";
import { Array, Effect, Layer, References } from "effect";
import { RateLimiter } from "effect/persistence";

import { demoMembers } from "../../src/identity/members.js";
import { issues } from "../../src/issues/handlers.js";
import { IssueNotFound, Issues, RateLimited } from "../../src/issues/Issues.js";
import { IssueStore } from "../../src/issues/store.js";
import { status } from "../../src/workspaces/handlers.js";
import { as } from "../support/as.js";

const services = Layer.mergeAll(
  IssueStore.layerMemory,
  RateLimiter.layer.pipe(Layer.provide(RateLimiter.layerStoreMemory))
);

describe("issues, in process", () => {
  it.effect("keeps each workspace's issues its own", () =>
    Effect.gen(function* () {
      const client = yield* Action.client(issues);

      const issue = yield* client
        .createIssue({ title: "Crash", body: "On save." })
        .pipe(as("ada"));

      expect(issue).toMatchObject({ id: "ACME-1", status: "open" });
      expect(yield* client.listIssues().pipe(as("linus"))).toStrictEqual({
        issues: [{ id: "ACME-1", title: "Crash", status: "open" }],
      });
      expect(yield* client.listIssues().pipe(as("grace"))).toStrictEqual({
        issues: [],
      });
      expect(
        yield* Effect.flip(client.getIssue({ id: issue.id }).pipe(as("grace")))
      ).toStrictEqual(new IssueNotFound({ id: "ACME-1" }));
    }).pipe(Effect.provide(services))
  );

  it.effect(
    "lists twenty by default, newest first, or the status and limit asked for",
    () =>
      Effect.gen(function* () {
        const client = yield* Action.client(issues);
        const store = yield* IssueStore;

        yield* Effect.forEach(Array.range(1, 21), (n) =>
          store.create(demoMembers.ada.workspace, {
            title: `Issue ${n}`,
            body: "",
          })
        );
        yield* client.closeIssue({ id: "ACME-2" }).pipe(as("ada"));

        const all = yield* client.listIssues().pipe(as("ada"));

        const closed = yield* client
          .listIssues({ status: "closed", limit: 20 })
          .pipe(as("ada"));

        const newest = yield* client.listIssues({ limit: 1 }).pipe(as("ada"));

        expect(all.issues.map(({ id }) => id)).toStrictEqual(
          Array.range(2, 21)
            .map((n) => `ACME-${n}`)
            .toReversed()
        );
        expect(closed.issues.map(({ id }) => id)).toStrictEqual(["ACME-2"]);
        expect(newest.issues.map(({ id }) => id)).toStrictEqual(["ACME-21"]);
      }).pipe(Effect.provide(services))
  );

  it.effect("refuses a write from a member holding the read scope alone", () =>
    Effect.gen(function* () {
      const client = yield* Action.client(issues);
      const create = client.createIssue({ title: "Crash", body: "" });

      const refused = yield* Effect.flip(create.pipe(as("linus")));

      expect(refused).toStrictEqual(
        new Action.Forbidden({ scopes: ["issues:write"] })
      );
      expect(refused.message).toBe("Requires issues:write.");
    }).pipe(Effect.provide(services))
  );

  it.effect("keeps both of two comments made at once", () =>
    Effect.gen(function* () {
      const store = yield* IssueStore;
      const { workspace } = demoMembers.ada;

      const kept = yield* Effect.forEach(Array.range(3, 60), (steps) =>
        Effect.gen(function* () {
          const { id } = yield* store.create(workspace, {
            title: "Crash",
            body: "",
          });

          yield* Effect.forEach(
            ["One", "Two"],
            (text) => store.comment(workspace, id, { author: "ada", text }),
            { concurrency: "unbounded" }
          ).pipe(Effect.provideService(References.MaxOpsBeforeYield, steps));

          return (yield* store.get(workspace, id)).comments.length;
        })
      );

      expect(kept).toStrictEqual(Array.range(3, 60).map(() => 2));
    }).pipe(Effect.provide(services))
  );

  it.effect(
    "counts every write of a member against one limit, and no one else's",
    () =>
      Effect.gen(function* () {
        const client = yield* Action.client(issues);

        yield* client.createIssue({ title: "Crash", body: "" }).pipe(as("ada"));
        yield* Effect.forEach(Array.range(1, 9), (n) =>
          client
            .commentOnIssue({ id: "ACME-1", text: `Comment ${n}` })
            .pipe(as("ada"))
        );

        expect(
          yield* Effect.flip(
            client.closeIssue({ id: "ACME-1" }).pipe(as("ada"))
          )
        ).toBeInstanceOf(RateLimited);
        expect(
          yield* client.getIssue({ id: "ACME-1" }).pipe(as("ada"))
        ).toMatchObject({
          status: "open",
        });
        expect(
          yield* client
            .createIssue({ title: "Mine", body: "" })
            .pipe(as("grace"))
        ).toMatchObject({ id: "GLOBEX-1" });
      }).pipe(Effect.provide(services))
  );

  it.effect(
    "builds only the implementations whose actions a client lists",
    () =>
      Effect.gen(function* () {
        const client = yield* Action.client([status, issues], {
          actions: Issues,
        });

        expect(yield* client.listIssues().pipe(as("ada"))).toStrictEqual({
          issues: [],
        });
      }).pipe(Effect.provide(services))
  );
});
