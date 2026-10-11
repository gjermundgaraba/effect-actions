import { describe, expect, it } from "@effect/vitest";
import { Array, Effect, Layer } from "effect";
import { RateLimiter } from "effect/persistence";
import * as Action from "@gjermundgaraba/effect-actions/Action";
import { CurrentMember } from "../../src/identity/Identity.js";
import { members } from "../../src/identity/members.js";
import { issues } from "../../src/issues/handlers.js";
import { IssueNotFound, Issues, RateLimited } from "../../src/issues/Issues.js";
import { IssueStore } from "../../src/issues/store.js";
import { status } from "../../src/workspaces/handlers.js";

// What the implementation does, with no transport: `Action.client` runs the same decoding,
// `authorize` and handler a server runs. Each call names its caller, as a request would.
const as = (member: keyof typeof members) => Effect.provideService(CurrentMember, members[member]);

// The two startup services the issues' builder yields, and nothing else of the application.
const services = Layer.mergeAll(
  IssueStore.layerMemory,
  RateLimiter.layer.pipe(Layer.provide(RateLimiter.layerStoreMemory)),
);

describe("issues, in process", () => {
  it.effect("keeps each workspace's issues its own", () =>
    Effect.gen(function* () {
      const client = yield* Action.client(issues);
      const issue = yield* client.createIssue({ title: "Crash", body: "On save." }).pipe(as("ada"));

      expect(issue).toMatchObject({ id: "ACME-1", status: "open" });
      expect(yield* client.listIssues().pipe(as("linus"))).toEqual({
        issues: [{ id: "ACME-1", title: "Crash", status: "open" }],
      });
      expect(yield* client.listIssues().pipe(as("grace"))).toEqual({ issues: [] });
      expect(yield* Effect.flip(client.getIssue({ id: issue.id }).pipe(as("grace")))).toEqual(
        new IssueNotFound({ id: "ACME-1" }),
      );
    }).pipe(Effect.provide(services)),
  );

  it.effect("lists twenty by default, newest first, or the status and limit asked for", () =>
    Effect.gen(function* () {
      const client = yield* Action.client(issues);

      yield* Effect.forEach(Array.range(1, 4), (n) =>
        client.createIssue({ title: `Issue ${n}`, body: "" }).pipe(as("ada")),
      );
      yield* client.closeIssue({ id: "ACME-2" }).pipe(as("ada"));

      // No argument is the input `{}`: `status` is absent and `limit` its default.
      const all = yield* client.listIssues().pipe(as("ada"));
      const closed = yield* client.listIssues({ status: "closed", limit: 20 }).pipe(as("ada"));
      const newest = yield* client.listIssues({ limit: 1 }).pipe(as("ada"));

      expect(all.issues.map(({ id }) => id)).toEqual(["ACME-4", "ACME-3", "ACME-2", "ACME-1"]);
      expect(closed.issues.map(({ id }) => id)).toEqual(["ACME-2"]);
      expect(newest.issues.map(({ id }) => id)).toEqual(["ACME-4"]);
    }).pipe(Effect.provide(services)),
  );

  it.effect("refuses a write from a member holding the read scope alone", () =>
    Effect.gen(function* () {
      const client = yield* Action.client(issues);
      const create = client.createIssue({ title: "Crash", body: "" });

      const refused = yield* Effect.flip(create.pipe(as("linus")));

      // `toEqual` compares an error's own fields, here `scopes`; never its `message`.
      expect(refused).toEqual(new Action.Forbidden({ scopes: ["issues:write"] }));
      expect(refused.message).toBe("Requires issues:write.");
    }).pipe(Effect.provide(services)),
  );

  it.effect("counts every write of a member against one limit, and no one else's", () =>
    Effect.gen(function* () {
      const client = yield* Action.client(issues);

      yield* client.createIssue({ title: "Crash", body: "" }).pipe(as("ada"));
      yield* Effect.forEach(Array.range(1, 9), (n) =>
        client.commentOnIssue({ id: "ACME-1", text: `Comment ${n}` }).pipe(as("ada")),
      );

      // Ten writes are spent, by two actions: the eleventh, of a third, is refused.
      expect(
        yield* Effect.flip(client.closeIssue({ id: "ACME-1" }).pipe(as("ada"))),
      ).toBeInstanceOf(RateLimited);
      expect(yield* client.getIssue({ id: "ACME-1" }).pipe(as("ada"))).toMatchObject({
        status: "open",
      });
      expect(
        yield* client.createIssue({ title: "Mine", body: "" }).pipe(as("grace")),
      ).toMatchObject({ id: "GLOBEX-1" });
    }).pipe(Effect.provide(services)),
  );

  it.effect("builds only the implementations whose actions a client lists", () =>
    Effect.gen(function* () {
      // Two implementations are passed, and `actions` selects the issues': `status` is left
      // out, unbuilt, so `services` need not hold the registry its builder yields.
      const client = yield* Action.client([status, issues], { actions: Issues });

      expect(yield* client.listIssues().pipe(as("ada"))).toEqual({ issues: [] });
    }).pipe(Effect.provide(services)),
  );
});
