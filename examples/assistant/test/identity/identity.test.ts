import { describe, expect, it } from "@effect/vitest";
import { Effect, Ref } from "effect";
import * as Action from "@gjermundgaraba/effect-actions/Action";
import { identity } from "../../src/identity/handlers.js";
import { CurrentCaller, type Member, type Operator } from "../../src/identity/Identity.js";
import { members } from "../../src/identity/members.js";
import { type Permission, Permissions } from "../../src/identity/permissions.js";

const as = (caller: Member | Operator) => Effect.provideService(CurrentCaller, caller);

const operator: Operator = { kind: "operator", id: "root" };

describe("identity, in process", () => {
  it.effect("answers each call with its own caller, from one client", () =>
    Effect.gen(function* () {
      const client = yield* Action.client(identity);

      expect(yield* client.whoAmI().pipe(as(members.ada))).toEqual({ id: "ada", kind: "member" });
      expect(yield* client.whoAmI().pipe(as(operator))).toEqual({ id: "root", kind: "operator" });
    }).pipe(Effect.provide(Permissions.layerMemory)),
  );

  it.effect("gets the permission store once and asks it on every call", () =>
    Effect.gen(function* () {
      const granted = yield* Ref.make<ReadonlyArray<Permission>>([]);

      // The store is a startup service, so it is provided where the client is acquired: the
      // authorizer is built there. No call is given it again.
      const client = yield* Action.client(identity).pipe(
        Effect.provideService(Permissions, Permissions.of({ granted: () => Ref.get(granted) })),
      );

      const refusal = yield* Effect.flip(client.whoAmI().pipe(as(members.ada)));

      expect(refusal).toBeInstanceOf(Action.Forbidden);
      expect(refusal.message).toBe("Requires tasks:read.");

      yield* Ref.set(granted, ["tasks:read"]);

      expect(yield* client.whoAmI().pipe(as(members.ada))).toEqual({ id: "ada", kind: "member" });
    }),
  );
});
