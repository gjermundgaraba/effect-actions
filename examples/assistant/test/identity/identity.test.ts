import { describe, expect, it } from "@effect/vitest";
import * as Action from "@gjermundgaraba/effect-actions/Action";
import { Effect, Ref } from "effect";

import { identity } from "../../src/identity/handlers.js";
import { CurrentCaller } from "../../src/identity/Identity.js";
import type { Member, Operator } from "../../src/identity/Identity.js";
import { demoMembers } from "../../src/identity/members.js";
import { Permissions } from "../../src/identity/permissions.js";
import type { Permission } from "../../src/identity/permissions.js";

const as = (caller: Member | Operator) =>
  Effect.provideService(CurrentCaller, caller);

const operator: Operator = { kind: "operator", id: "root" };

describe("identity, in process", () => {
  it.effect("answers each call with its own caller, from one client", () =>
    Effect.gen(function* () {
      const client = yield* Action.client(identity);

      expect(yield* client.whoAmI().pipe(as(demoMembers.ada))).toStrictEqual({
        id: "ada",
        kind: "member",
      });
      expect(yield* client.whoAmI().pipe(as(operator))).toStrictEqual({
        id: "root",
        kind: "operator",
      });
    }).pipe(Effect.provide(Permissions.layerMemory))
  );

  it.effect("gets the permission store once and asks it on every call", () =>
    Effect.gen(function* () {
      const granted = yield* Ref.make<readonly Permission[]>([]);

      const client = yield* Action.client(identity).pipe(
        Effect.provideService(
          Permissions,
          Permissions.of({ granted: () => Ref.get(granted) })
        )
      );

      const refusal = yield* Effect.flip(
        client.whoAmI().pipe(as(demoMembers.ada))
      );

      expect(refusal).toBeInstanceOf(Action.Forbidden);
      expect(refusal.message).toBe("Requires tasks:read.");

      yield* Ref.set(granted, ["tasks:read"]);

      expect(yield* client.whoAmI().pipe(as(demoMembers.ada))).toStrictEqual({
        id: "ada",
        kind: "member",
      });
    })
  );
});
