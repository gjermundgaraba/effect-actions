import { describe, expect, it } from "@effect/vitest";
import { Effect, Fiber, Layer, Stream } from "effect";
import { RateLimiter } from "effect/persistence";
import { TestClock } from "effect/testing";
import * as Action from "@gjermundgaraba/effect-actions/Action";
import * as Event from "@gjermundgaraba/effect-actions/Event";
import { CurrentMember } from "../../src/identity/Identity.js";
import { members } from "../../src/identity/members.js";
import { issueEvents } from "../../src/issues/events.js";
import { issues } from "../../src/issues/handlers.js";
import { IssueChanged } from "../../src/issues/Issues.js";
import { IssueStore } from "../../src/issues/store.js";

const as = (member: keyof typeof members) => Effect.provideService(CurrentMember, members[member]);

const inProcess = Layer.mergeAll(
  IssueStore.layerMemory,
  RateLimiter.layer.pipe(Layer.provide(RateLimiter.layerStoreMemory)),
  Event.layerMemory,
);

// The changes a member's watch receives, as data, while `act` changes issues.
const watched = <E, R>(
  member: keyof typeof members,
  input: typeof IssueChanged.input.Type,
  count: number,
  act: (client: Action.Client<[typeof issues, typeof issueEvents]>) => Effect.Effect<void, E, R>,
) =>
  Effect.gen(function* () {
    const client = yield* Action.client([issues, issueEvents]);

    const watching = yield* client.watch(IssueChanged, input).pipe(
      Stream.filter((received) => received._tag === "Occurrence"),
      Stream.map((occurrence) => occurrence.data),
      Stream.take(count),
      Stream.runCollect,
      as(member),
      Effect.forkChild,
    );

    // Lets the forked watch run up to its subscription first: started after `act`, it would wait
    // for changes already made.
    yield* TestClock.adjust("0 millis");
    yield* act(client);

    return yield* Fiber.join(watching);
  });

describe("issue.changed", () => {
  it.effect("gives a member the changes of their own workspace alone, as they happen", () =>
    Effect.gen(function* () {
      const changes = yield* watched("linus", {}, 2, (client) =>
        Effect.gen(function* () {
          const filed = yield* client.createIssue({ title: "Crash", body: "" }).pipe(as("ada"));

          yield* client.createIssue({ title: "Elsewhere", body: "" }).pipe(as("grace"));
          yield* client.commentOnIssue({ id: filed.id, text: "Seen it." }).pipe(as("ada"));
        }),
      );

      expect(changes).toEqual([
        { workspace: "acme", id: "ACME-1", title: "Crash", status: "open", change: "filed" },
        {
          workspace: "acme",
          id: "ACME-1",
          title: "Crash",
          status: "open",
          change: "commented",
          comment: { author: "ada", text: "Seen it." },
        },
      ]);
    }).pipe(Effect.provide(inProcess)),
  );

  it.effect("filters by status and leaves the comment out where asked", () =>
    Effect.gen(function* () {
      const changes = yield* watched("linus", { status: "closed", comments: false }, 2, (client) =>
        Effect.gen(function* () {
          const filed = yield* client.createIssue({ title: "Crash", body: "" }).pipe(as("ada"));

          yield* client.commentOnIssue({ id: filed.id, text: "Seen it." }).pipe(as("ada"));
          yield* client.closeIssue({ id: filed.id }).pipe(as("ada"));
          // Closing it again changes nothing, and nothing is sent.
          yield* client.closeIssue({ id: filed.id }).pipe(as("ada"));
          yield* client.commentOnIssue({ id: filed.id, text: "Fixed." }).pipe(as("ada"));
        }),
      );

      expect(changes).toEqual([
        { workspace: "acme", id: "ACME-1", title: "Crash", status: "closed", change: "closed" },
        { workspace: "acme", id: "ACME-1", title: "Crash", status: "closed", change: "commented" },
      ]);
    }).pipe(Effect.provide(inProcess)),
  );

  it.effect("refuses a member without the read scope", () =>
    Effect.gen(function* () {
      const client = yield* Action.client([issues, issueEvents]);

      expect(
        yield* Effect.flip(Stream.runDrain(client.watch(IssueChanged)).pipe(as("kay"))),
      ).toEqual(
        new Action.Forbidden({ message: "Requires issues:read.", scopes: ["issues:read"] }),
      );
    }).pipe(Effect.provide(inProcess)),
  );
});
